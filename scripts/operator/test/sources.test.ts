// The source scan of the operator pack. It reads each script file of the pack (.ts, .mts, .cts, .js, .mjs and .cjs) outside the test folder, and it fails when a file holds a text that only some
// files may hold: the call that gives a seed, the suffix of a key file, a run of 64 hex characters (the size of a key) and the process environment, in each way that code can reach it. The files
// of `tasks/` have two more rules, because a task never signs or submits a transaction by itself: the landing helpers of `lib/` do that, behind the guards. The scan walks the folder to any depth,
// so it reads the files that later parts add.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

interface Rule {
  name: string;
  pattern: RegExp;
  /** The folder, written with a slash at its end, that the rule reads. A rule with no folder reads every file of the pack. */
  within?: string;
  /** The files, relative to the pack and written with a slash, that may hold the text. */
  allowed: readonly string[];
  /** Source texts that the rule refuses outside the allowed files, and source texts that look like them and that it accepts. */
  refused: readonly string[];
  accepted: readonly string[];
}

const RULES: readonly Rule[] = [
  {
    name: 'secretHexForEnv', pattern: /secretHexForEnv/, allowed: ['lib/registry.ts', 'tasks/env.ts'],
    refused: ['registry.secretHexForEnv(name);'], accepted: ['const secretHex = 1;'],
  },
  {
    name: 'the text .seed', pattern: /\.seed/, allowed: ['lib/registry.ts', 'tasks/keys.ts'],
    refused: ['const file = `${name}.seed`;'], accepted: ['const seed = 1;', 'const file = `${name}.key`;'],
  },
  {
    name: 'a run of 64 hex characters', pattern: /[0-9a-fA-F]{64}/, allowed: [],
    refused: [`const a = '${'ab'.repeat(32)}';`, `const b = '${'AB'.repeat(32)}';`, `const c = '${'ab'.repeat(64)}';`],
    accepted: [`const d = '${'ab'.repeat(31)}a';`, `const e = '${'ab'.repeat(16)}-${'ab'.repeat(16)}';`],
  },
  {
    name: 'process.env', pattern: /\bprocess\s*(?:\?\.|\.|\[\s*['"`])\s*env\b|\}\s*=\s*(?:globalThis\.)?process\b|['"](?:node:)?process['"]/, allowed: ['cli.ts', 'lib/settings.ts', 'lib/session.ts'],
    refused: [
      'const env = process.env;', "import { env } from 'node:process';", "import proc from 'node:process';", 'const { env } = process;', 'const { env } = globalThis.process;',
      "const env = process['env'];", 'const env = process?.env;', 'const env = process\n  .env;',
    ],
    accepted: ['const args = process.argv;', 'const here = process.cwd();', 'const env = deps.env;', 'const env = subprocess.env;'],
  },
  {
    // A task signs and submits through the landing helpers only. These are the ways to sign a transaction or to send one outside them: the signature of a key, the signature of the ring, the submit
    // of the node, the export of a key object, and the hosted tool that submits. A text that names a member as a string or takes it out of an object (`{ submit } = node`) counts too.
    name: 'signing or submitting in a task', within: 'tasks/', allowed: [],
    pattern: /signTransaction|vector_submit_transaction|\bring\s*(?:\?\.|\.|\[\s*['"`])\s*sign\b|\{[^{}'"`:]*\bsign\b[^{}'"`:]*\}\s*=\s*[^;]*\bring\b|\.\s*(?:submit|export)\s*\(|\[\s*['"`](?:submit|export)['"`]\s*\]\s*\(|\{[^{}'"`:]*\bsubmit\b[^{}'"`:]*\}\s*=/,
    refused: [
      "const signed = registry.key('run').signTransaction(cbor);", "import { signTransaction } from './platform.ts';", 'const signed = registry.ring.sign(hash, cbor);', 'const signed = ring?.sign(hash, cbor);',
      "const signed = ring['sign'](hash, cbor);", 'const signed = registry.ring\n  .sign(hash, cbor);', 'const { sign } = registry.ring;', 'await session.node.submit(signed);',
      'await session.node?.submit(signed);', "await session.node['submit'](signed);", 'const { submit } = session.node;', "const jwk = key.jwsKey().export({ format: 'jwk' });",
      "const jwk = key['export']({ format: 'jwk' });", "await session.hosted.call('vector_submit_transaction', { cbor });",
    ],
    accepted: [
      'const signed = await guardedSign(session, request);', 'const holds = registry.ring.has(hash);', 'const wallets = registry.ring.wallets();', 'const { has } = registry.ring;', 'const { sign } = Math;',
      'const result = ring.signal;', "const text = 'the ring signs nothing';", "if (session.mode === 'submit') return;", "const needs = { approval: 'submit' } as const;",
      "const needs: { approval: 'submit' | 'never' } = { approval: 'submit' };", 'const options: { submit: boolean } = { submit: true };', "flags.has('submit');", 'const submitted = true;',
      "hosted.call('vector_build_identity_register', args);", 'const unsigned = built.unsignedCbor;', 'const done = result.exported();',
    ],
  },
  {
    // The one task that signs a message with a key is the attestation: it signs the envelope that the transaction carries.
    name: 'signMessage in a task', within: 'tasks/', pattern: /signMessage/, allowed: ['tasks/attest.ts'],
    refused: ["const signature = registry.key('provider').signMessage(bytes);", "const { signMessage } = registry.key('provider');"],
    accepted: ['const signed = await guardedSign(session, request);', "const bytes = Buffer.from(text, 'hex');"],
  },
];

/** The script files of a folder (.ts, .mts, .cts, .js, .mjs and .cjs), relative to it and written with a slash, but not those of its test folder and not those of node_modules. */
function sourcesOf(root: string, folder = ''): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(join(root, folder), { withFileTypes: true })) {
    const path = folder === '' ? entry.name : `${folder}/${entry.name}`;
    if (entry.isDirectory()) {
      if (path !== 'test' && entry.name !== 'node_modules') found.push(...sourcesOf(root, path));
    } else if (entry.isFile() && /\.[cm]?[jt]s$/.test(entry.name)) {
      found.push(path);
    }
  }
  return found.sort();
}

/** What the rules find in a folder: one line "file: rule" for each file and each rule that it breaks. */
function problemsOf(root: string): string[] {
  return sourcesOf(root).flatMap((file) => {
    const text = readFileSync(join(root, file), 'utf8');
    return RULES.filter((rule) => (rule.within === undefined || file.startsWith(rule.within)) && rule.pattern.test(text) && !rule.allowed.includes(file)).map((rule) => `${file}: ${rule.name}`);
  });
}

const roots: string[] = [];
afterAll(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

/** A folder in the temporary directory, with the files that a test names (path to text). */
function folderWith(files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(join(tmpdir(), 'operator-sources-'));
  roots.push(root);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

const PLAIN = 'export const answer = 42;\n';
const EVERYTHING = RULES.flatMap((rule) => rule.refused).join('\n');

describe('the source scan', () => {
  it('passes a folder where each text sits in a file that may hold it', () => {
    const files: Record<string, string> = { 'lib/plain.ts': PLAIN, 'tasks/deep/er/plain.ts': PLAIN };
    for (const rule of RULES) for (const file of rule.allowed) files[file] = `${files[file] ?? ''}${rule.refused.join('\n')}\n`;
    expect(problemsOf(folderWith(files))).toEqual([]);
  });
  for (const rule of RULES) {
    it(`${rule.name}: refuses each text in a file that may not hold it, at any depth, and says which file and which rule`, () => {
      const places = rule.within === undefined ? ['', 'usecases/deep/er/'] : [rule.within, `${rule.within}deep/er/`];
      const bad = rule.refused.flatMap((text, index) => places.map((place) => [`${place}bad-${index}.ts`, text] as const));
      const root = folderWith({ 'lib/plain.ts': PLAIN, ...Object.fromEntries(bad) });
      expect(problemsOf(root)).toEqual(bad.map(([file]) => `${file}: ${rule.name}`).sort());
    });
    it(`${rule.name}: accepts a text that looks like it, and the text in each file that may hold it`, () => {
      const near = Object.fromEntries(rule.accepted.map((text, index) => [`${rule.within ?? 'lib/'}near-${index}.ts`, text]));
      const own = Object.fromEntries(rule.allowed.map((file) => [file, rule.refused.join('\n')]));
      expect(problemsOf(folderWith({ ...near, ...own }))).toEqual([]);
    });
    if (rule.within !== undefined) {
      const within = rule.within;
      it(`${rule.name}: reads only the files below ${within}, and no file of another folder`, () => {
        const text = rule.refused.join('\n');
        const elsewhere = { 'lib/a.ts': text, 'usecases/b.ts': text, 'cli.ts': text, 'tasksextra/c.ts': text, [`${within.slice(0, -1)}.ts`]: text };
        expect(problemsOf(folderWith(elsewhere))).toEqual([]);
        expect(problemsOf(folderWith({ ...elsewhere, [`${within}d.ts`]: text }))).toEqual([`${within}d.ts: ${rule.name}`]);
      });
    }
  }
  it('skips the test folder of the root, node_modules and each file that is no script file, and reads a folder named test below the root', () => {
    const skipped = {
      'test/a.ts': EVERYTHING, 'test/support/b.ts': EVERYTHING, 'node_modules/c.ts': EVERYTHING, 'README.md': EVERYTHING, 'data.json': EVERYTHING, 'lib/notes.txt': EVERYTHING, 'lib/old.ts.bak': EVERYTHING,
    };
    expect(problemsOf(folderWith(skipped))).toEqual([]);
    const everywhere = RULES.filter((rule) => rule.within === undefined);
    expect(problemsOf(folderWith({ ...skipped, 'lib/test/d.ts': EVERYTHING, 'tasks/test/e.ts': EVERYTHING }))).toEqual([
      ...everywhere.map((rule) => `lib/test/d.ts: ${rule.name}`), ...RULES.map((rule) => `tasks/test/e.ts: ${rule.name}`),
    ]);
  });
  it('reads the files of each script extension: .ts, .mts, .cts, .js, .mjs and .cjs', () => {
    const extensions = ['ts', 'mts', 'cts', 'js', 'mjs', 'cjs'];
    const files = Object.fromEntries(extensions.map((extension) => [`lib/file.${extension}`, `const key = '${'ab'.repeat(32)}';`]));
    expect(sourcesOf(folderWith(files))).toEqual(Object.keys(files).sort());
    expect(problemsOf(folderWith(files))).toEqual(Object.keys(files).sort().map((file) => `${file}: a run of 64 hex characters`));
  });
  it('passes on the real folder of the pack, and reads its files: the scan is not empty', () => {
    const root = fileURLToPath(new URL('..', import.meta.url));
    expect(sourcesOf(root)).toContain('vitest.config.ts');
    expect(sourcesOf(root).filter((file) => file.startsWith('test/'))).toEqual([]);
    expect(problemsOf(root)).toEqual([]);
  });
});
