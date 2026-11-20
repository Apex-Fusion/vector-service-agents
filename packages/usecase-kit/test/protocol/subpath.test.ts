// packages/usecase-kit/test/protocol/subpath.test.ts: one pattern in package.json makes every folder of src a subpath. A new folder needs no edit of package.json. The tools of the repo
// resolve the pattern: vitest (this file), Node with type stripping, and Node with tsx. The typecheck resolves the import of the protocol folder below by the package name.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as byName from '@vsa/usecase-kit/protocol';
import * as byPath from '../../src/protocol/index.ts';

const PACKAGE = fileURLToPath(new URL('../../', import.meta.url));
const SRC = join(PACKAGE, 'src');
const manifest = JSON.parse(readFileSync(join(PACKAGE, 'package.json'), 'utf8')) as { exports: Record<string, string>; dependencies: Record<string, string> };

/** Runs Node in the package folder and returns what it prints. The flag for type stripping is in the arguments, so that a Node 22 version before 22.18 runs a .ts file too. */
function node(args: readonly string[]): string {
  return execFileSync(process.execPath, ['--no-warnings', ...args], { cwd: PACKAGE, encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

describe('the subpath pattern', () => {
  it('resolves @vsa/usecase-kit/protocol by the package name to the protocol folder', () => {
    expect(typeof byName.parseDid).toBe('function');
    expect(byName.parseDid).toBe(byPath.parseDid);
    expect(Object.keys(byName).sort()).toStrictEqual(Object.keys(byPath).sort());
  });

  it('loads the whole protocol folder with Node type stripping and with tsx, so that no type is imported as a value', () => {
    const script = "const m = await import('@vsa/usecase-kit/protocol'); console.log(Object.keys(m).sort().join(','));";
    const expected = Object.keys(byName).sort().join(',');
    expect(node(['--experimental-strip-types', '--input-type=module', '-e', script])).toBe(expected);
    expect(node(['--import', 'tsx', '--input-type=module', '-e', script])).toBe(expected);
  }, 60_000);

  it('is one pattern, with no root entry and no barrel in src', () => {
    expect(manifest.exports).toStrictEqual({ './*': './src/*/index.ts' });
    expect(existsSync(join(SRC, 'index.ts'))).toBe(false);
    const entries = readdirSync(SRC, { withFileTypes: true });
    expect(entries.filter((entry) => !entry.isDirectory()).map((entry) => entry.name)).toStrictEqual([]);
  });

  it('serves every folder of src with an index.ts, so that each folder is a subpath', () => {
    const folders = readdirSync(SRC, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    expect(folders).toContain('protocol');
    for (const folder of folders) expect(existsSync(join(SRC, folder, 'index.ts')), `src/${folder}/index.ts`).toBe(true);
  });

  it('names the workspace packages that the other folders need, so that none of them edits package.json', () => {
    for (const name of ['@vsa/buyer-core', '@vsa/hire-kit', '@vsa/id-kit', '@vsa/service-kit', '@vsa/vector-read']) expect(manifest.dependencies[name], name).toBe('workspace:*');
  });

  it('makes a new folder a subpath with no edit of package.json, for vitest, Node and tsx', async () => {
    const before = readFileSync(join(PACKAGE, 'package.json'), 'utf8');
    const name = `probe-${process.pid}-${Date.now().toString(36)}`;
    const folder = join(SRC, name);
    const script = `const m = await import('@vsa/usecase-kit/${name}'); console.log(m.PROBE_VALUE);`;
    mkdirSync(folder);
    try {
      writeFileSync(join(folder, 'index.ts'), 'export const PROBE_VALUE: number = 41 + 1;\n');
      // The folder exists only while this test runs, so a static import cannot name it. This test loads a module across the resolution boundary on purpose.
      const loaded = (await import(/* @vite-ignore */ `@vsa/usecase-kit/${name}`)) as { PROBE_VALUE: number };
      expect(loaded.PROBE_VALUE).toBe(42);
      expect(node(['--experimental-strip-types', '--input-type=module', '-e', script])).toBe('42');
      expect(node(['--import', 'tsx', '--input-type=module', '-e', script])).toBe('42');
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
    expect(readFileSync(join(PACKAGE, 'package.json'), 'utf8')).toBe(before);
    expect(existsSync(folder)).toBe(false);
  }, 120_000);

  it('refuses a name that is not a folder of src', async () => {
    const script = "await import('@vsa/usecase-kit/no-such-folder-here');";
    expect(() => node(['--import', 'tsx', '--input-type=module', '-e', script])).toThrow();
  });
});
