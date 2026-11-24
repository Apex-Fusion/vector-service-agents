// agents/audio-snippets/test/worker-contract.test.ts
// The contract tests use a stub model for jobs. REQUIRE_ASR=1 also requires the real library for the startup check.
import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CHILD_CLEANUP_MS, Child } from '../../../services/mock-systems/test/support/child.ts';
import { ASR_PYTHON, PYTHON_READY, REQUIRE_ASR } from './support.ts';

const workerSource = readFileSync(new URL('../asr/worker.py', import.meta.url), 'utf8');
const agentDir = fileURLToPath(new URL('../', import.meta.url));
const START_MS = 30_000;
const CONTRACT_MS = 15_000;

describe('asr/worker.py', () => {
  test.skipIf(!REQUIRE_ASR)('REQUIRE_ASR is set: Python 3.9 or later runs', () => { expect(PYTHON_READY).toBe(true); });
  test.skipIf(!PYTHON_READY)('asr/test_worker.py passes: the contract of the worker, with a stubbed model; under REQUIRE_ASR nothing in it is skipped', async () => {
    const run = new Child(ASR_PYTHON, ['-I', 'asr/test_worker.py'], { cwd: agentDir, label: 'ASR worker contract' });
    try {
      await run.waitFor(/^worker contract ready\r?\n/m, 'Python and ASR library startup', START_MS);
      expect(await run.waitForExit('worker contract execution', CONTRACT_MS), run.diagnostics()).toEqual({ code: 0, signal: null });
      expect(run.stderr).toMatch(/Ran 10 tests[\s\S]*OK/);
      // REQUIRE_ASR requires the check that imports faster-whisper.
      if (REQUIRE_ASR) expect(run.stderr).not.toContain('skipped=');
    } finally {
      await run.cleanup();
    }
  }, START_MS + CONTRACT_MS + CHILD_CLEANUP_MS + 5_000);
  // Python 3.9 is proven by running this file there: the implementers' machine runs the contract test with Python 3.9, the image and CI with 3.11.
  test('the worker prints ASCII only and carries the fixed options of the model, and the file itself is ASCII', () => {
    expect(workerSource).toContain('ensure_ascii=True');
    for (const option of ['beam_size=5', 'temperature=0.0', 'condition_on_previous_text=False', 'word_timestamps=True', 'vad_filter=False', 'device="cpu"', 'cpu_threads=threads', 'local_files_only=True']) {
      expect(workerSource, option).toContain(option);
    }
    expect(workerSource).not.toMatch(/[^\x00-\x7f]/); // the file itself is ASCII
  });
});
