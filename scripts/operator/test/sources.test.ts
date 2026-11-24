// The source scan of the operator pack. It reads each script file of the pack (.ts, .mts, .cts, .js, .mjs and .cjs) outside the test folder, and it fails when a file holds a text that only some
// files may hold: the call that gives a seed, the suffix of a key file, a run of 64 hex characters (the size of a key) and the process environment, in each way that code can reach it. Two rules
// hold for the whole pack: no file exports a key object, and only the files of `lib/` name `jwsKey`. The files of `tasks/` and `usecases/` have two more rules, because a task never signs or
// submits a transaction by itself: the landing helpers of `lib/` do that, behind the guards. The scan walks the folder to any depth, so it reads the files that later parts add.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

interface Rule {
  name: string;
  pattern: RegExp;
  /** The folders, each written with a slash at its end, that the rule reads. A rule with no folders reads every file of the pack. */
  within?: readonly string[];
  /** The files, relative to the pack and written with a slash, that may hold the text. An entry that ends with a slash is a folder: every file below it may hold the text. */
  allowed: readonly string[];
  /** Source texts that the rule refuses outside the allowed files, and source texts that look like them and that it accepts. */
  refused: readonly string[];
  accepted: readonly string[];
}

/** The names that a destructure must not take out of an object or give a name to: the signing ring, the node, the exposure, the registry, and the calls that sign and submit. */
const BOUND = 'ring|node|exposure|registry|sign|submit';
/** A quote of a string in source text. */
const QUOTE = '[\'"`]';
/**
 * The ways that a task or a use case can sign a transaction or send one outside the landing helpers, as parts of one expression (a text that matches a part breaks the rule). The landing helpers
 * check the approval, reserve the cap and run the guards. The parts name the landing of the checks, the signature of a key, the submit of a provider, the node and the hosted tool, the submit URL,
 * the members that hold these powers, a call named sign, and each destructure that takes one of them out of an object (in a declaration, an assignment and the parameters of a function).
 */
const SIGNING_PARTS: readonly string[] = [
  String.raw`\b(?:landTransaction|landFor|signTransaction|submitTx|vector_submit_transaction|globalThis)\b`,
  String.raw`\burls\s*(?:\.|\[\s*${QUOTE})\s*submit\b`,
  String.raw`\.[ \t]*(?:ring|exposure|submit)\b|\[\s*${QUOTE}(?:ring|exposure|submit)${QUOTE}\s*\]`,
  String.raw`\bsign\s*\(|\[\s*${QUOTE}sign${QUOTE}\s*\]`,
  String.raw`\b(?:const|let|var)\s*\{[^;={}]*\b(?:${BOUND})\b[^;={}]*\}|\b(?:const|let|var)\s*\{[^;={}]*\{[^;={}]*\b(?:${BOUND})\b`,
  String.raw`\(\s*\{[^;={}]*\b(?:${BOUND})\b[^;={}]*\}\s*=(?!=)`,
  String.raw`\(\s*\{[^;=(){}]*\b(?:${BOUND})\b[^;=(){}]*\}[^;(){}]*\)\s*(?::[^=;{}()]*)?=>`,
  String.raw`\bfunction\b[^(;]*\(\s*\{[^;=(){}]*\b(?:${BOUND})\b[^;=(){}]*\}`,
  String.raw`^[ \t]*(?:async[ \t]+)?[A-Za-z_$][\w$]*\s*\(\s*\{[^;=(){}]*\b(?:${BOUND})\b[^;=(){}]*\}[^;(){}]*\)\s*(?::[^{;]*)?\{`,
  String.raw`\}\s*=\s*[\w$.?\s]*\b(?:ring|node|exposure|registry)\b[ \t]*(?:[;,)]|$)`,
  String.raw`\{[^{}]*\bsign\b[^{}]*\}\s*from\s*${QUOTE}(?:node:)?crypto${QUOTE}`,
];

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
    name: 'signing or submitting in a task or a use case', within: ['tasks/', 'usecases/'], allowed: [], pattern: new RegExp(SIGNING_PARTS.join('|'), 'm'),
    refused: [
      'await landTransaction(request, { signer: session.registry.ring });', "import { landTransaction } from '../../checks/lib/land.ts';", 'const land = landFor(io, evidence);',
      'const k = session.registry.ring;\nk.sign(hash, cbor);', "const k = session.registry['ring'];", 'const k = session.registry?.ring;', 'const k = session.registry\n  .ring;',
      'const { sign: s } = registry.ring;', 'const { ring } = session.registry;', 'session.exposure.release(hash);', "session['exposure'].reserve(entry);",
      'await session.node.submit(signed);', 'await session.node?.submit(signed);', "await session.node['submit'](signed);", 'await session.node.submit.call(session.node, signed);',
      'await (0, session.node.submit)(signed);', 'const { submit: send } = session.node;', 'const { submit } = node;', 'await session.chain.provider.submitTx(cbor);',
      'await lucid.wallet().submitTx(signed);', "await session.fetchImpl(session.settings.urls.submit, { method: 'POST' });", "await fetch(settings.urls . submit, { method: 'POST' });",
      "await fetch(settings.urls['submit']);", 'await globalThis.fetch(url);', 'const signature = sign(null, hash, key);', 'const signature = crypto.sign(null, hash, key);',
      "const signature = crypto['sign'](null, hash, key);", "import { sign } from 'node:crypto';", "import { sign as s } from 'node:crypto';", 'const { sign: s } = crypto;',
      "const signed = registry.key('run').signTransaction(cbor);", "import { signTransaction } from './platform.ts';", "await session.hosted.call('vector_submit_transaction', { cbor });",
      'const { registry } = session;', 'const { node: n } = session;', 'const { exposure } = session;', 'let { node } = session;', '({ node } = session);',
      'for (const { registry } of sessions) { use(registry); }', 'const take = ({ node }) => node;', 'const take = ({ ring }: Holder): void => undefined;',
      'function take({ registry }: TaskSession) { return registry; }', 'async function take({ node }) { return node; }',
      '  async next({ registry }: TaskSession): Promise<StepOutcome> {\n    return done;\n  }', 'const { a: { node } } = session;',
    ],
    accepted: [
      "await landHosted(session, { step: 'register', tool: 'vector_build_identity_register', args, expectSigners: ['fee'], plan });",
      "await landBuilt(session, { step: 'float', built, expectSigners: ['run'], plan });", "const signer = guardedSign(session, { step: 'claim', plan, signer: 'reorder-service' });",
      "const address = session.registry.addressOf('run');", 'const name = session.registry.nameOfHash(hash);', 'const names = session.registry.names();', 'const response = await session.fetchImpl(url);',
      'const hosted = session.settings.urls.hosted;', 'await session.fetchImpl(session.settings.urls.gateway);', "if (session.mode === 'submit') return;", "const needs = { approval: 'submit' } as const;",
      "const needs: { approval: 'submit' | 'never' } = { approval: 'submit' };", 'const options: { submit: boolean } = { submit: true };', "flags.has('submit');", 'const submitted = true;',
      "hosted.call('vector_build_identity_register', args);", 'const unsigned = built.unsignedCbor;', 'const result = ring.signal;', "const text = 'the ring signs nothing';",
      'const { step, tool } = spec;', 'const { mode, task } = session;', 'const { nodes, registries } = graph;', "const labels = { node: 'a', ring: 'b' };",
      'const total = nodes.length + registries.length;', 'const done = result.exported();', 'const design = makeDesign(1);', 'Object.assign(target, source);',
      'const { assigned } = result;', "session.state.step('register');", "const note = 'the exposure of the session is a number';",
      "const { name } = await session.hosted.call('vector_get_vault', { did });", '// Send the request.\nsubmit(request);',
    ],
  },
  {
    // The one task that signs a message with a key is the attestation: it signs the envelope that the transaction carries.
    name: 'signMessage in a task or a use case', within: ['tasks/', 'usecases/'], pattern: /signMessage/, allowed: ['tasks/attest.ts'],
    refused: ["const signature = registry.key('provider').signMessage(bytes);", "const { signMessage } = registry.key('provider');"],
    accepted: ['const signed = await guardedSign(session, request);', "const bytes = Buffer.from(text, 'hex');"],
  },
  {
    // A key object that is exported gives its secret out: the private member of its JWK is the seed. No file of the pack exports a key object.
    name: 'a call of .export(', pattern: /\.\s*export\s*\(|\[\s*['"`]export['"`]\s*\]\s*\(/, allowed: [],
    refused: [
      "const jwk = keyObject.export({ format: 'jwk' });", "const der = createPrivateKey(pem).export({ type: 'pkcs8', format: 'der' });", "const pem = keyObject['export']({ format: 'pem' });",
      "const jwk = keyObject\n  .export({ format: 'jwk' });", "const jwk = keyObject?.export({ format: 'jwk' });",
    ],
    accepted: [
      'export const answer = 42;', 'export default task;', 'const done = result.exported();', 'const exports = {};', 'reexport(thing);', "const text = 'the export of the file';",
      'const a = 1; // done.\nexport const answer = 42;',
    ],
  },
  {
    // The key object of a key leaves only through `jwsKey`. The files of `lib/` make the tokens of the gateway, so they may name it; a task and a use case may not.
    name: 'jwsKey outside lib', pattern: /jwsKey/, allowed: ['lib/'],
    refused: ["const key = registry.key('run').jwsKey();", 'const { jwsKey } = key;'],
    accepted: ["const key = registry.key('run');", 'const jws = 1;'],
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
    const reads = (rule: Rule): boolean => rule.within === undefined || rule.within.some((folder) => file.startsWith(folder));
    const allows = (rule: Rule): boolean => rule.allowed.some((entry) => (entry.endsWith('/') ? file.startsWith(entry) : file === entry));
    return RULES.filter((rule) => reads(rule) && rule.pattern.test(text) && !allows(rule)).map((rule) => `${file}: ${rule.name}`);
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

/** The files that a rule lets hold its text: the files that it names, and two files below each folder that it names. */
const allowedFiles = (rule: Rule): string[] => rule.allowed.flatMap((entry) => (entry.endsWith('/') ? [`${entry}allowed.ts`, `${entry}deep/er/allowed.ts`] : [entry]));

describe('the source scan', () => {
  it('passes a folder where each text sits in a file that may hold it', () => {
    const files: Record<string, string> = { 'lib/plain.ts': PLAIN, 'tasks/deep/er/plain.ts': PLAIN, 'usecases/plain.ts': PLAIN };
    for (const rule of RULES) for (const file of allowedFiles(rule)) files[file] = `${files[file] ?? ''}${rule.refused.join('\n')}\n`;
    expect(problemsOf(folderWith(files))).toEqual([]);
  });
  for (const rule of RULES) {
    it(`${rule.name}: refuses each text in a file that may not hold it, at any depth, and says which file and which rule`, () => {
      const places = rule.within === undefined ? ['', 'extras/deep/er/'] : rule.within.flatMap((folder) => [folder, `${folder}deep/er/`]);
      const bad = rule.refused.flatMap((text, index) => places.map((place) => [`${place}bad-${index}.ts`, text] as const));
      const root = folderWith({ 'lib/plain.ts': PLAIN, ...Object.fromEntries(bad) });
      expect(problemsOf(root)).toEqual(bad.map(([file]) => `${file}: ${rule.name}`).sort());
    });
    it(`${rule.name}: accepts a text that looks like it, and the text in each file that may hold it`, () => {
      const near = Object.fromEntries((rule.within ?? ['lib/', '']).flatMap((place) => rule.accepted.map((text, index) => [`${place}near-${index}.ts`, text] as const)));
      const own = Object.fromEntries(allowedFiles(rule).map((file) => [file, rule.refused.join('\n')]));
      expect(problemsOf(folderWith({ ...near, ...own }))).toEqual([]);
    });
    if (rule.within !== undefined) {
      const within = rule.within;
      it(`${rule.name}: reads only the files below ${within.join(' and ')}, and no file of another folder`, () => {
        const text = rule.refused.join('\n');
        const elsewhere: Record<string, string> = { 'lib/a.ts': text, 'cli.ts': text, 'tasksextra/c.ts': text, 'usecasesextra/d.ts': text };
        for (const folder of within) elsewhere[`${folder.slice(0, -1)}.ts`] = text;
        expect(problemsOf(folderWith(elsewhere))).toEqual([]);
        for (const folder of within) expect(problemsOf(folderWith({ ...elsewhere, [`${folder}e.ts`]: text }))).toEqual([`${folder}e.ts: ${rule.name}`]);
      });
    }
  }
  it('lets every file below a folder that a rule allows hold its text, and no file of another folder', () => {
    const text = "const key = registry.key('run').jwsKey();";
    expect(problemsOf(folderWith({ 'lib/a.ts': text, 'lib/deep/er/b.ts': text }))).toEqual([]);
    expect(problemsOf(folderWith({ 'cli.ts': text, 'tasks/c.ts': text, 'usecases/d.ts': text, 'libextra/e.ts': text, 'lib.ts': text }))).toEqual(
      ['cli.ts', 'lib.ts', 'libextra/e.ts', 'tasks/c.ts', 'usecases/d.ts'].map((file) => `${file}: jwsKey outside lib`),
    );
  });
  it('skips the test folder of the root, node_modules and each file that is no script file, and reads a folder named test below the root', () => {
    const skipped = {
      'test/a.ts': EVERYTHING, 'test/support/b.ts': EVERYTHING, 'node_modules/c.ts': EVERYTHING, 'README.md': EVERYTHING, 'data.json': EVERYTHING, 'lib/notes.txt': EVERYTHING, 'lib/old.ts.bak': EVERYTHING,
    };
    expect(problemsOf(folderWith(skipped))).toEqual([]);
    const inLib = RULES.filter((rule) => rule.within === undefined && !rule.allowed.includes('lib/'));
    expect(problemsOf(folderWith({ ...skipped, 'lib/test/d.ts': EVERYTHING, 'tasks/test/e.ts': EVERYTHING }))).toEqual([
      ...inLib.map((rule) => `lib/test/d.ts: ${rule.name}`), ...RULES.map((rule) => `tasks/test/e.ts: ${rule.name}`),
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
