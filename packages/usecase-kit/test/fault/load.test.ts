// packages/usecase-kit/test/fault/load.test.ts: the fault folder and the manifest folder load as plain TypeScript. A run script loads them with Node type stripping or with tsx, so a type that is
// imported as a value, and a syntax that Node cannot strip, must not be in them. The names that each loader finds are the names that vitest finds.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as fault from '@vsa/usecase-kit/fault';
import * as manifest from '@vsa/usecase-kit/manifest';

const PACKAGE = fileURLToPath(new URL('../../', import.meta.url));

/** Runs Node in the package folder and returns what it prints. The flag for type stripping is in the arguments, so that a Node 22 version before 22.18 runs a .ts file too. */
function node(args: readonly string[]): string {
  return execFileSync(process.execPath, ['--no-warnings', ...args], { cwd: PACKAGE, encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

describe('the folders load as plain TypeScript', () => {
  it.each([
    ['fault', fault],
    ['manifest', manifest],
  ] as const)('loads @vsa/usecase-kit/%s with Node type stripping and with tsx, and finds the same names', (name, loaded) => {
    // The child process is a separate program, so it loads the folder with a dynamic import. This test exercises the loading of the two loaders on purpose.
    const script = `const m = await import('@vsa/usecase-kit/${name}'); console.log(Object.keys(m).sort().join(','));`;
    const expected = Object.keys(loaded).sort().join(',');
    expect(expected.length).toBeGreaterThan(0);
    expect(node(['--experimental-strip-types', '--input-type=module', '-e', script])).toBe(expected);
    expect(node(['--import', 'tsx', '--input-type=module', '-e', script])).toBe(expected);
  }, 60_000);
});
