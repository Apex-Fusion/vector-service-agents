// agents/advocate/test/budget.test.ts
// The time of a job (ruling R-E8): the constants, the end of the fetch phase, the time of the model, and the worst case, which ends inside the deadline.
import { describe, expect, test } from 'vitest';
import {
  FETCH_CONCURRENCY, FETCH_PHASE_MAX_MS, FETCH_RESERVE_MS, JOB_DEADLINE_MS, MODEL_MAX_MS, MODEL_MIN_MS, PAGE_TIMEOUT_MS, RESULT_RESERVE_MS, SEARCH_MAX_MS,
  SEARCH_QUERY_TIMEOUT_MS, fetchDeadlineMs, modelBudgetMs,
} from '../src/budget.ts';

describe('the time of a job (R-E8)', () => {
  test('the deadline is 150 s after the arrival, 30 s inside the runtime timeout of 180000 ms, which is 120 s inside the window of 300000 ms', () => {
    expect([JOB_DEADLINE_MS, SEARCH_MAX_MS, SEARCH_QUERY_TIMEOUT_MS, FETCH_PHASE_MAX_MS, FETCH_RESERVE_MS, PAGE_TIMEOUT_MS, FETCH_CONCURRENCY, MODEL_MAX_MS, MODEL_MIN_MS, RESULT_RESERVE_MS])
      .toStrictEqual([150_000, 15_000, 10_000, 45_000, 20_000, 15_000, 4, 90_000, 15_000, 5_000]);
    expect(180_000 - JOB_DEADLINE_MS).toBe(30_000);
    expect(300_000 - 180_000).toBe(120_000);
  });

  test('the fetch phase ends at the earlier of 45 s after it begins and 20 s before the deadline', () => {
    const arrival = 1_760_000_000_000;
    const deadline = arrival + JOB_DEADLINE_MS;
    expect(fetchDeadlineMs(arrival, deadline)).toBe(arrival + 45_000);
    expect(fetchDeadlineMs(arrival + 15_000, deadline)).toBe(arrival + 60_000);
    expect(fetchDeadlineMs(arrival + 84_999, deadline)).toBe(arrival + 129_999);
    expect(fetchDeadlineMs(arrival + 85_000, deadline)).toBe(arrival + 130_000);
    expect(fetchDeadlineMs(arrival + 140_000, deadline)).toBe(arrival + 130_000);
  });

  test('the model gets min(90 s, the time left less 5 s), and is not started with less than 15 s', () => {
    expect(modelBudgetMs(JOB_DEADLINE_MS)).toBe(90_000);
    expect(modelBudgetMs(95_000)).toBe(90_000);
    expect(modelBudgetMs(90_000)).toBe(85_000);
    expect(modelBudgetMs(20_000)).toBe(15_000);
    expect(modelBudgetMs(19_999)).toBeNull();
    expect(modelBudgetMs(0)).toBeNull();
    expect(modelBudgetMs(-5)).toBeNull();
  });

  test('at the worst the phases end 5 s before the deadline: a search of 15 s, a fetch phase of 45 s, then the 85 s the model is given', () => {
    const fetchEnd = fetchDeadlineMs(SEARCH_MAX_MS, JOB_DEADLINE_MS);
    expect(fetchEnd).toBe(60_000);
    const model = modelBudgetMs(JOB_DEADLINE_MS - fetchEnd);
    expect(model).toBe(85_000);
    expect(JOB_DEADLINE_MS - (fetchEnd + (model ?? 0))).toBe(RESULT_RESERVE_MS);
    expect(SEARCH_QUERY_TIMEOUT_MS).toBeLessThan(SEARCH_MAX_MS);
    expect(PAGE_TIMEOUT_MS).toBeLessThan(FETCH_PHASE_MAX_MS);
  });
});
