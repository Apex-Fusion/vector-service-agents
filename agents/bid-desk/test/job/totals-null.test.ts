// agents/bid-desk/test/job/totals-null.test.ts: a null from `quoteTotals`. The choice has passed the parser of the decision and the rules of the request, so the arithmetic of the kit makes lines from it. If the kit
// ever gives null for such a choice, the job ends `model_output_invalid` BEFORE the quote is built, and never `internal` after the Claim. The kit gives null for no choice that can reach this point, so the test
// puts a stand-in in its place for one call. The stand-in calls the real function in every other call.
import { describe, expect, it, vi } from 'vitest';
import { quoteTotals } from '@vsa/usecase-kit/bids';
import type * as bids from '@vsa/usecase-kit/bids';
import { DECISION_TEXT } from '../../src/job/refusal.ts';
import { expectNothingRecorded, makeRig, refusalOf } from './rig.ts';

vi.mock('@vsa/usecase-kit/bids', async (importOriginal) => {
  const original = await importOriginal<typeof bids>();
  return { ...original, quoteTotals: vi.fn(original.quoteTotals) };
});

describe('a null from quoteTotals', () => {
  it('ends the job with model_output_invalid (502), before the quote is built, and nothing is written', async () => {
    const rig = makeRig();
    vi.mocked(quoteTotals).mockReturnValueOnce(null);
    expect(await refusalOf(rig.run())).toMatchObject({ code: 'model_output_invalid', status: 502, kind: 'job', message: DECISION_TEXT.model_output_invalid });
    expect(rig.events).toStrictEqual(['take', 'decide']);
    expect(rig.credentialAsks).toHaveLength(0);
    expectNothingRecorded(rig);
    expect(rig.logs).toHaveLength(1);
    expect(rig.logs[0]).toContain('model_output_invalid');
  });

  it('twin: with the real arithmetic the same job gives the quote', async () => {
    const rig = makeRig();
    expect(await rig.run()).toMatchObject({ outcome: 'done', total: 23_610 });
    expect(vi.mocked(quoteTotals)).toHaveBeenCalled();
  });
});
