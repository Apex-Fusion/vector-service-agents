// agents/audio-snippets/test/worker-contract.test.ts
// asr/test_worker.py holds the JSON contract of the worker with a stubbed model; it needs Python 3.9 or later and nothing else. CI, the host and the implementers' machine set REQUIRE_ASR=1,
// and there a Python that does not run fails here instead of skipping.
import { describe, test, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ASR_PYTHON, PYTHON_READY, REQUIRE_ASR } from './support.ts';

const workerSource = readFileSync(new URL('../asr/worker.py', import.meta.url), 'utf8');

describe('asr/worker.py', () => {
  test.skipIf(!REQUIRE_ASR)('REQUIRE_ASR is set: Python 3.9 or later runs', () => { expect(PYTHON_READY).toBe(true); });
  test.skipIf(!PYTHON_READY)('asr/test_worker.py passes: the contract of the worker, with a stubbed model; under REQUIRE_ASR nothing in it is skipped', () => {
    const run = spawnSync(ASR_PYTHON, ['-I', fileURLToPath(new URL('../asr/test_worker.py', import.meta.url))], { encoding: 'utf8' });
    expect(run.status, run.stderr).toBe(0);
    expect(run.stderr).toMatch(/Ran 10 tests[\s\S]*OK/);
    // The one test that needs faster-whisper skips without it; REQUIRE_ASR says it is installed, so a skip there is a missing library.
    if (REQUIRE_ASR) expect(run.stderr).not.toContain('skipped=');
  });
  // Python 3.9 is proven by running this file there: the implementers' machine runs the contract test with Python 3.9, the image and CI with 3.11.
  test('the worker prints ASCII only and carries the fixed options of the model, and the file itself is ASCII', () => {
    expect(workerSource).toContain('ensure_ascii=True');
    for (const option of ['beam_size=5', 'temperature=0.0', 'condition_on_previous_text=False', 'word_timestamps=True', 'vad_filter=False', 'device="cpu"', 'cpu_threads=threads', 'local_files_only=True']) {
      expect(workerSource, option).toContain(option);
    }
    expect(workerSource).not.toMatch(/[^\x00-\x7f]/); // the file itself is ASCII
  });
});
