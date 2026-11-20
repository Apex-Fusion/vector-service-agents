// packages/usecase-kit/test/buyer/hire-delivery.test.ts: a delivery that passed the eight checks of the hire kit and that the flow cannot record. The receipt of the counterparty has a member that is nested
// deeper than the reader of the protocol takes, so no result can hold it. The counterparty must not be able to choose the end of the job with it: the step is `not_accepted`, the decision is not asked, no
// Accept is made, and the use case files its challenge. Each case has an accepted twin.
import { afterEach, describe, expect, it } from 'vitest';
import { AGENT_ANSWER, AGENT_ID, AGENT_KEY, AGENT_MODEL } from '@vsa/hire-kit/testing';
import { NO_OPEN_CLAIM, RECEIPT_CHECKS } from '@vsa/usecase-kit/protocol';
import type { DeliveryDecision } from '@vsa/usecase-kit/buyer';
import { disputedResult } from '@vsa/usecase-kit/buyer';
import { canonicalize, sha256Utf8Hex } from '@vsa/vector-read';
import { AGENT_ADVERT_REF, cleanWorlds, expectDecided, expectKind, go, pieces, words, world } from './support.ts';

afterEach(() => { cleanWorlds(); });

interface Job { escrowRef: string; payload: string; finished?: Record<string, unknown> }

/**
 * A hire in which the counterparty signs a receipt whose `prompt_tokens` is an array nested `levels` deep. The receipt is signed and its hash is on the chain, so the eight checks of the hire kit pass.
 * `decide` is the decision of the use case, and `asked` counts how many times it was asked.
 */
async function hireWithDepth(levels: number, decide: DeliveryDecision) {
  const w = await world();
  const original = w.m.agent.handle.bind(w.m.agent);
  w.m.agent.handle = async (method: string, path: string, body: string): Promise<Response> => {
    if (method === 'GET' && path.startsWith('/v1/job/')) {
      const job = (w.m.agent.jobs as Map<string, Job>).get(decodeURIComponent(path.slice('/v1/job/'.length)));
      if (job !== undefined && job.finished === undefined) {
        let deep: unknown = 0;
        for (let level = 0; level < levels; level += 1) deep = [deep];
        const receipt = {
          escrow_ref: job.escrowRef, supplier_pkh: AGENT_KEY.pkh, prompt_hash: sha256Utf8Hex(job.payload), response_hash: sha256Utf8Hex(AGENT_ANSWER), model: AGENT_MODEL,
          prompt_tokens: deep, completion_tokens: 0, wallclock_ms: 1204, agent_did: `did:vector:${AGENT_ID}`,
        };
        const signature = AGENT_KEY.sign(receipt);
        w.m.chain.markSubmitted(job.escrowRef, sha256Utf8Hex(canonicalize({ receipt, signature })));
        job.finished = {
          choices: [{ index: 0, message: { role: 'assistant', content: AGENT_ANSWER }, finish_reason: 'stop' }], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
          receipt, receipt_signature: signature, escrow_ref: job.escrowRef, submitted_ref: `${'ef'.repeat(32)}#0`,
        };
      }
    }
    return original(method, path, body);
  };
  let asked = 0;
  const step = await go(w, { decide: (delivery) => { asked += 1; return decide(delivery); } });
  return { w, step, asked: () => asked };
}

const ALL_TRUE = Object.fromEntries(RECEIPT_CHECKS.map((check) => [check, true]));
const accept: DeliveryDecision = () => ({ accept: true });
const decline: DeliveryDecision = () => ({ accept: false, reason: 'the confirmation is wrong' });

describe('a delivery that the hire kit verified and that cannot be recorded', () => {
  it('ends as not_accepted with its own reason, whatever the decision would say: the decision is not asked, no Accept is made, and the escrow stays Submitted', async () => {
    for (const decide of [accept, decline]) {
      const { w, step, asked } = await hireWithDepth(40, decide);
      const found = expectKind(step, 'not_accepted');
      if (found.why !== 'not_recordable') throw new Error(`the step is ${words(step)}`);
      expect([found.declined, found.delivery]).toStrictEqual([null, null]);
      expect(asked()).toBe(0);
      expect(await w.m.chain.escrowState(found.handoff.escrow_ref)).toBe('Submitted');
      expect(w.booked.accepted).toStrictEqual([]);
      expect(w.key.stranded.list().map((entry) => entry.escrow_ref)).toStrictEqual([found.handoff.escrow_ref]);
    }
  });

  it('holds what can be recorded: the escrow, the advert, the supplier key hash and the eight checks, and the record says that no Accept was made', async () => {
    const { step } = await hireWithDepth(40, accept);
    const found = expectKind(step, 'not_accepted');
    if (found.why !== 'not_recordable') throw new Error(`the step is ${words(step)}`);
    expect(found.unrecorded).toStrictEqual({ escrow_ref: found.handoff.escrow_ref, advert_ref: AGENT_ADVERT_REF, supplier_pkh: AGENT_KEY.pkh, verification: ALL_TRUE });
    expect(found.handoff).toMatchObject({ advert_ref: AGENT_ADVERT_REF, paid_from_vault: true, receipt: null, receipt_signature: null, result: null, verification: ALL_TRUE, accepted: 'no' });
    expect(found.vault_ref).not.toBeNull();
  });

  it('gives a dispute and not an error: the use case makes the result of a dispute from the record of the step', async () => {
    const { step } = await hireWithDepth(40, accept);
    const found = expectKind(step, 'not_accepted');
    expect(disputedResult(pieces({ handoff: found.handoff }), { reason: NO_OPEN_CLAIM })).toMatchObject({ outcome: 'disputed', challenge: null, exit_state: 'Failed', handoff: found.handoff });
  });

  it('twin: a receipt that the reader takes, at five levels, is given to the decision: it is asked, and its answer decides', async () => {
    const declined = await hireWithDepth(5, decline);
    const no = expectDecided(declined.step);
    expect([no.why, no.declined, declined.asked()]).toStrictEqual(['declined', 'the confirmation is wrong', 1]);
    expect(no.delivery.receipt).toMatchObject({ escrow_ref: no.handoff.escrow_ref });
    const accepted = await hireWithDepth(5, accept);
    expect(words(accepted.step)).toBe('completed');
    expect(accepted.asked()).toBe(1);
    expect(accepted.w.booked.accepted).toHaveLength(1);
  });
});
