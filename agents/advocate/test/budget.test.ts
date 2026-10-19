// agents/advocate/test/budget.test.ts
// The time of a job (rulings R-E8 and R-F2): the constants, the end of the fetch phase, the time of the call through OpenRouter, the hop deadline and the end of
// the reads of a receipt, and the arithmetic of the head of src/budget.ts, each phase at its worst, which ends inside the deadline.
import { describe, expect, test } from 'vitest';
import {
  CHOICE_BUDGET_MS, CHOICE_MAX_CANDIDATES, CHOICE_WITHIN_MS, FALLBACK_RESERVE_MS, FETCH_CONCURRENCY, FETCH_PHASE_MAX_MS, FETCH_RESERVE_MS, HOP_MIN_MS, JOB_DEADLINE_MS,
  MODEL_MAX_MS, MODEL_MIN_MS, PAGE_TIMEOUT_MS, RESULT_RESERVE_MS, SEARCH_MAX_MS, SEARCH_QUERY_TIMEOUT_MS, WALLET_READ_MS, fetchDeadlineMs, hopDeadlineMs, modelBudgetMs,
  receiptByMs,
} from '../src/budget.ts';

describe('the time of a job (R-E8, R-F2)', () => {
  test('the deadline is 300 s after the arrival, 60 s inside the runtime timeout of 360000 ms, which is 120 s inside the window of 480000 ms', () => {
    expect([JOB_DEADLINE_MS, SEARCH_MAX_MS, SEARCH_QUERY_TIMEOUT_MS, FETCH_PHASE_MAX_MS, FETCH_RESERVE_MS, PAGE_TIMEOUT_MS, FETCH_CONCURRENCY, MODEL_MAX_MS, MODEL_MIN_MS, RESULT_RESERVE_MS])
      .toStrictEqual([300_000, 15_000, 10_000, 45_000, 20_000, 15_000, 4, 90_000, 15_000, 5_000]);
    expect([FALLBACK_RESERVE_MS, HOP_MIN_MS, CHOICE_BUDGET_MS, CHOICE_MAX_CANDIDATES, CHOICE_WITHIN_MS, WALLET_READ_MS]).toStrictEqual([95_000, 60_000, 15_000, 3, 25_000, 10_000]);
    expect(360_000 - JOB_DEADLINE_MS).toBe(60_000);
    expect(480_000 - 360_000).toBe(120_000);
  });

  test('the hire leaves the call through OpenRouter its whole time and the check and the result theirs: the hop deadline is 95 s before the deadline', () => {
    expect(FALLBACK_RESERVE_MS).toBe(MODEL_MAX_MS + RESULT_RESERVE_MS);
    const arrival = 1_760_000_000_000;
    expect(hopDeadlineMs(arrival + JOB_DEADLINE_MS)).toBe(arrival + 205_000);
    expect(modelBudgetMs(arrival + JOB_DEADLINE_MS - hopDeadlineMs(arrival + JOB_DEADLINE_MS))).toBe(MODEL_MAX_MS);
  });

  test('a receipt is read on chain until 20 s before the deadline, which leaves the call through OpenRouter its least time and the result its own', () => {
    const arrival = 1_760_000_000_000;
    expect(receiptByMs(arrival + JOB_DEADLINE_MS)).toBe(arrival + 280_000);
    expect(modelBudgetMs(arrival + JOB_DEADLINE_MS - receiptByMs(arrival + JOB_DEADLINE_MS))).toBe(MODEL_MIN_MS);
    expect(modelBudgetMs(arrival + JOB_DEADLINE_MS - receiptByMs(arrival + JOB_DEADLINE_MS) - 1)).toBeNull();
  });

  test('the fetch phase ends at the earlier of 45 s after it begins and 20 s before the deadline', () => {
    const arrival = 1_760_000_000_000;
    const deadline = arrival + JOB_DEADLINE_MS;
    expect(fetchDeadlineMs(arrival, deadline)).toBe(arrival + 45_000);
    expect(fetchDeadlineMs(arrival + 15_000, deadline)).toBe(arrival + 60_000);
    expect(fetchDeadlineMs(arrival + 234_999, deadline)).toBe(arrival + 279_999);
    expect(fetchDeadlineMs(arrival + 235_000, deadline)).toBe(arrival + 280_000);
    expect(fetchDeadlineMs(arrival + 290_000, deadline)).toBe(arrival + 280_000);
  });

  test('the call through OpenRouter gets min(90 s, the time left less 5 s), and is not started with less than 15 s', () => {
    expect(modelBudgetMs(JOB_DEADLINE_MS)).toBe(90_000);
    expect(modelBudgetMs(95_000)).toBe(90_000);
    expect(modelBudgetMs(90_000)).toBe(85_000);
    expect(modelBudgetMs(20_000)).toBe(15_000);
    expect(modelBudgetMs(19_999)).toBeNull();
    expect(modelBudgetMs(0)).toBeNull();
    expect(modelBudgetMs(-5)).toBeNull();
  });

  test('at the worst the phases end inside the deadline: the search by 15 s, the pages by 60, the choice by 85, the wallet by 95, the hop by 205, the fallback by 295', () => {
    const fetchEnd = fetchDeadlineMs(SEARCH_MAX_MS, JOB_DEADLINE_MS);
    expect(fetchEnd).toBe(60_000);
    const postBy = fetchEnd + CHOICE_WITHIN_MS + WALLET_READ_MS;
    expect(postBy).toBe(95_000);
    const hop = hopDeadlineMs(JOB_DEADLINE_MS);
    expect(hop).toBe(205_000);
    // The latest start the hop allows, and the time a Post made at the worst has before the hop deadline.
    expect(hop - HOP_MIN_MS).toBe(145_000);
    expect(postBy).toBeLessThanOrEqual(hop - HOP_MIN_MS);
    expect(hop - postBy).toBe(110_000);
    const fallback = modelBudgetMs(JOB_DEADLINE_MS - hop);
    expect(fallback).toBe(90_000);
    expect(hop + (fallback ?? 0)).toBe(295_000);
    expect(JOB_DEADLINE_MS - (hop + (fallback ?? 0))).toBe(RESULT_RESERVE_MS);
    expect(SEARCH_QUERY_TIMEOUT_MS).toBeLessThan(SEARCH_MAX_MS);
    expect(PAGE_TIMEOUT_MS).toBeLessThan(FETCH_PHASE_MAX_MS);
    expect(CHOICE_BUDGET_MS).toBeLessThan(CHOICE_WITHIN_MS);
  });
});
