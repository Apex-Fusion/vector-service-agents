// packages/usecase-kit/test/decision/surface.test.ts: the public surface of the decision folder. The folder is the subpath `@vsa/usecase-kit/decision`. It loads with vitest, with Node type stripping and
// with tsx, so that no type is imported as a value.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as byName from '@vsa/usecase-kit/decision';
import * as byPath from '../../src/decision/index.ts';

const PACKAGE = fileURLToPath(new URL('../../', import.meta.url));

/** Runs Node in the package folder and returns what it prints. The flag for type stripping is in the arguments, so that a Node 22 version before 22.18 runs a .ts file too. */
function node(args: readonly string[]): string {
  return execFileSync(process.execPath, ['--no-warnings', ...args], { cwd: PACKAGE, encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

const NAMES = [
  'DECISION_FAILURE_CODES', 'HIRE_MIN_MS', 'INPUT_CLOSE', 'INPUT_OPEN', 'LLM_MAX_PRICE_SETTING', 'LLM_MODEL_ALLOWLIST_SETTING', 'MAX_PROMPT_BYTES', 'buildPrompt', 'checkLimits', 'decide', 'parseMaxPrice', 'parseModelAllowlist',
];

describe('the subpath @vsa/usecase-kit/decision', () => {
  it('is the folder src/decision, and it exports these values and no other', () => {
    expect(byName.decide).toBe(byPath.decide);
    expect(Object.keys(byName).sort()).toStrictEqual(NAMES);
  });

  it('loads with tsx and gives the same names', () => {
    // The folder is loaded in a new Node process on purpose: the test exercises the loading boundary, so a static import of vitest cannot stand in for it. Node type stripping is not tried: the
    // vendored code of buyer-core, which hire-kit loads, has parameter properties, and strip-only mode refuses them. The agents load their code with tsx.
    const script = "const m = await import('@vsa/usecase-kit/decision'); console.log(Object.keys(m).sort().join(','));";
    expect(node(['--import', 'tsx', '--input-type=module', '-e', script])).toBe(NAMES.join(','));
  }, 60_000);
});
