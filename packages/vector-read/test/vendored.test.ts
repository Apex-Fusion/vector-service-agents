// packages/vector-read/test/vendored.test.ts: the identity codecs copied from agents-marketplace are the files VENDORED-FROM.md pins.
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join, sep } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = readFileSync(join(root, 'VENDORED-FROM.md'), 'utf8');
// The rows of the identity codecs table: a copy under src/vendored/, or the fixture file of the Aiken types.
const rows = manifest.split('\n').filter((l) => l.startsWith('| `src/vendored/') || l.startsWith('| `test/fixtures/identity-'));
const cells = (row: string) => row.split('|').map((c) => c.trim().replace(/^`|`$/g, ''));
/** Every file under `dir` (a folder of the package), as a package-relative path with forward slashes. */
const filesUnder = (dir: string): string[] =>
  readdirSync(join(root, dir), { recursive: true, encoding: 'utf8' })
    .map((p) => `${dir}/${p.split(sep).join('/')}`)
    .filter((p) => statSync(join(root, p)).isFile());

describe('vendored identity codecs', () => {
  it('every row names a copy with a source of agents-marketplace, the commit and the sha256 of the copy', () => {
    expect(rows).toHaveLength(9);
    for (const row of rows) {
      const [, dest, source, commit, sha] = cells(row);
      expect(existsSync(join(root, dest)), dest).toBe(true);
      expect(source).toMatch(/^agents-marketplace:(packages\/shared\/src|contracts\/identity-marketplace\/fixtures)\//);
      expect(commit).toBe('67054f6');
      const actual = createHash('sha256').update(readFileSync(join(root, dest))).digest('hex');
      expect(actual, `${dest} changed since it was vendored`).toBe(sha);
    }
  });
  it('every file under src/vendored/ has a row, so a file added without one fails', () => {
    const named = new Set(rows.map((row) => cells(row)[1]));
    const onDisk = filesUnder('src/vendored');
    expect(onDisk).toHaveLength(8);
    expect(onDisk.filter((f) => !named.has(f)), 'files without a row in VENDORED-FROM.md').toStrictEqual([]);
  });
  it('the three excerpts are named as such, with their line ranges', () => {
    const excerpts = rows.filter((row) => cells(row)[2].includes(' excerpt, line')).map((row) => cells(row)[1]);
    expect(excerpts).toStrictEqual(['src/vendored/shared/identity/constants.ts', 'src/vendored/shared/network.ts', 'src/vendored/shared/chain/ChainProvider.ts']);
  });
});
