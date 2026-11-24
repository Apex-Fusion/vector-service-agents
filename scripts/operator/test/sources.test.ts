// The source scan of the operator pack. It reads each script file of the pack (.ts, .mts, .cts, .js, .mjs and .cjs) outside the test folder, and it fails when a file holds a text that only some
// files may hold: the call that gives a seed, the suffix of a key file, a run of 64 hex characters (the size of a key) and the process environment, in each way that code can reach it. The scan
// walks the folder to any depth, so it reads the files that later parts add.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

interface Rule {
  name: string;
  pattern: RegExp;
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
    return RULES.filter((rule) => rule.pattern.test(text) && !rule.allowed.includes(file)).map((rule) => `${file}: ${rule.name}`);
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
      const bad = rule.refused.flatMap((text, index) => [[`bad-${index}.ts`, text], [`usecases/deep/er/bad-${index}.ts`, text]] as const);
      const root = folderWith({ 'lib/plain.ts': PLAIN, ...Object.fromEntries(bad) });
      expect(problemsOf(root)).toEqual(bad.map(([file]) => `${file}: ${rule.name}`).sort());
    });
    it(`${rule.name}: accepts a text that looks like it, and the text in each file that may hold it`, () => {
      const near = Object.fromEntries(rule.accepted.map((text, index) => [`lib/near-${index}.ts`, text]));
      const own = Object.fromEntries(rule.allowed.map((file) => [file, rule.refused.join('\n')]));
      expect(problemsOf(folderWith({ ...near, ...own }))).toEqual([]);
    });
  }
  it('skips the test folder of the root, node_modules and each file that is no script file, and reads a folder named test below the root', () => {
    const skipped = {
      'test/a.ts': EVERYTHING, 'test/support/b.ts': EVERYTHING, 'node_modules/c.ts': EVERYTHING, 'README.md': EVERYTHING, 'data.json': EVERYTHING, 'lib/notes.txt': EVERYTHING, 'lib/old.ts.bak': EVERYTHING,
    };
    expect(problemsOf(folderWith(skipped))).toEqual([]);
    expect(problemsOf(folderWith({ ...skipped, 'lib/test/d.ts': EVERYTHING }))).toEqual(RULES.map((rule) => `lib/test/d.ts: ${rule.name}`));
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
