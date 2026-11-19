// packages/id-kit/test/vendored.test.ts: the gateway code copied from agents-marketplace is what VENDORED-FROM.md pins.
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join, sep } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = readFileSync(join(root, 'VENDORED-FROM.md'), 'utf8');
const rows = manifest.split('\n').filter((l) => l.startsWith('| `src/vendored/'));
const cells = (row: string) => row.split('|').map((c) => c.trim().replace(/^`|`$/g, ''));
const sha256 = (path: string): string => createHash('sha256').update(readFileSync(join(root, path))).digest('hex');
/** Every file under `dir` (a folder of the package), as a package-relative path with forward slashes. */
const filesUnder = (dir: string): string[] =>
  readdirSync(join(root, dir), { recursive: true, encoding: 'utf8' })
    .map((p) => `${dir}/${p.split(sep).join('/')}`)
    .filter((p) => statSync(join(root, p)).isFile());

describe('vendored gateway code', () => {
  it('every row names a copy with a source in the identity gateway, the pin and the sha256 of the copy', () => {
    expect(rows.map((row) => cells(row)[1])).toStrictEqual(['src/vendored/m4/jose.ts', 'src/vendored/m4/der.ts', 'src/vendored/m4/delegation-patterns.ts']);
    for (const row of rows) {
      const [, dest, source, commit, sha] = cells(row);
      expect(existsSync(join(root, dest)), dest).toBe(true);
      // The cell of the excerpt row keeps one backtick inside: the cut strips the backtick at each end of the cell only.
      expect(source).toMatch(/^agents-marketplace:identity-gateway\/src\/m4\/(?:jose|der|delegation)\.ts(?:` excerpt, lines 32-63)?$/);
      expect(commit).toBe('46f4b8f');
      expect(sha256(dest), `${dest} changed since it was vendored`).toBe(sha);
    }
  });
  it('every file under src/vendored/ has a row, so a file added without one fails', () => {
    const named = new Set(rows.map((row) => cells(row)[1]));
    const onDisk = filesUnder('src/vendored');
    expect(onDisk).toHaveLength(3);
    expect(onDisk.filter((f) => !named.has(f)), 'files without a row in VENDORED-FROM.md').toStrictEqual([]);
  });
  it('the text of the manifest gives the same pin as the table', () => {
    expect(manifest).toContain('commit `46f4b8f` (`46f4b8ff3a463491f530983413d158acd06490c1`');
    for (const row of rows) expect(cells(row)[3]).toBe('46f4b8f');
  });
  it('no copy has a rewritten line: the only module a copy loads is node:crypto, as in the source', () => {
    for (const row of rows) {
      const dest = cells(row)[1];
      const specifiers = [...readFileSync(join(root, dest), 'utf8').matchAll(/^import [^\n]*? from "([^"]+)";$/gm)].map((m) => m[1]);
      for (const specifier of specifiers) expect(specifier, `${dest} imports ${specifier}`).toBe('node:crypto');
    }
    expect(readFileSync(join(root, 'src/vendored/m4/der.ts'), 'utf8')).not.toMatch(/^import /m);
    expect(readFileSync(join(root, 'src/vendored/m4/delegation-patterns.ts'), 'utf8')).not.toMatch(/^import /m);
  });
  it('the pattern excerpt is whole lines 32 to 63 of the source: the block of the pattern rule, with nothing else', () => {
    const lines = readFileSync(join(root, 'src/vendored/m4/delegation-patterns.ts'), 'utf8').split('\n');
    expect(lines).toHaveLength(33); // 32 lines, and the empty text after the last line break
    expect(lines[0]).toBe('// \u2500\u2500 Section 5.1 patterns \u2500\u2500');
    expect(lines[31]).toMatch(/^export const narrower = /);
    const exported = lines.filter((l) => l.startsWith('export ')).map((l) => /^export (?:const|function) (\w+)/.exec(l)?.[1]);
    expect(exported).toStrictEqual(['isActionPattern', 'isResourcePattern', 'covers', 'patternCovers', 'narrower']);
  });
});
