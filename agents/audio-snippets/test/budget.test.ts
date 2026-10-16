// agents/audio-snippets/test/budget.test.ts
import { describe, test, expect } from 'vitest';
import { ASR_MAX_MS, ASR_MIN_MS, CLIPS_RESERVE_MS, CLIP_TIMEOUT_MS, JOB_DEADLINE_MS, asrBudgetMs } from '../src/budget.ts';

describe('the time of a job (R-D8)', () => {
  test('the deadline is 22 min after the arrival, 60 s inside the runtime timeout of 1380000 ms, which is 120 s inside the window of 1500000 ms', () => {
    expect([JOB_DEADLINE_MS, ASR_MAX_MS, CLIPS_RESERVE_MS, ASR_MIN_MS, CLIP_TIMEOUT_MS]).toStrictEqual([1_320_000, 900_000, 60_000, 30_000, 60_000]);
    expect(1_380_000 - JOB_DEADLINE_MS).toBe(60_000);
    expect(1_500_000 - 1_380_000).toBe(120_000);
  });
  test('the speech recognition gets min(900000, the time left, less 60000 when clips are asked for), and is not started with less than 30000', () => {
    expect(asrBudgetMs(JOB_DEADLINE_MS, false)).toBe(900_000);
    expect(asrBudgetMs(JOB_DEADLINE_MS, true)).toBe(900_000);
    expect(asrBudgetMs(950_000, true)).toBe(890_000);
    expect(asrBudgetMs(950_000, false)).toBe(900_000);
    expect(asrBudgetMs(90_000, true)).toBe(30_000);
    expect(asrBudgetMs(89_999, true)).toBeNull();
    expect(asrBudgetMs(30_000, false)).toBe(30_000);
    expect(asrBudgetMs(29_999, false)).toBeNull();
    expect(asrBudgetMs(-5, false)).toBeNull();
  });
});
