// packages/usecase-kit/src/buyer/advert.ts
// The advert of a job. The hire kit checks the agent that signs the receipt (`agent_did`) against the agent of the escrow, and that is the agent of the advert. It never checks it against the counterparty that
// the approved document names. A document that names one agent and an advert of another agent would be paid, delivered, accepted and booked, and only then would the receipt not name the counterparty: the
// Accept would be on the chain for a delivery of the wrong agent. So the flow reads the advert on the chain before it reads a vault and before it pays, and the advert must name the counterparty as its agent.
// The advert of another agent, and an advert that names no agent (a legacy advert), are `advert_not_counterparty`. A read that cannot be made is `ledger_unavailable`, and so is a reading of the wrong
// shape: neither is read as a match. In each of these cases nothing is paid. The function never throws.
import type { Chain } from '@vsa/buyer-core';
import type { Did, OutputRef } from '@vsa/usecase-kit/protocol';

const DID_PREFIX = 'did:vector:';

/** The codes of an advert check that stops the job. `ledger_unavailable` says that the advert could not be read. */
export type AdvertRefusal = 'advert_not_counterparty' | 'ledger_unavailable';

export type AdvertCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: AdvertRefusal; readonly detail: string };

/**
 * Reads the advert `advert` on the chain, and checks that its agent is the counterparty: the DID of the agent is `did:vector:` and the `agent_id` of the advert, and it is compared as text, with no change of
 * case. The detail never repeats the error of a read that failed.
 */
export async function checkAdvertAgent(chain: Pick<Chain, 'readAdvert'>, advert: OutputRef, counterparty: Did): Promise<AdvertCheck> {
  let agent: unknown;
  try {
    const read: unknown = await chain.readAdvert(advert);
    if (typeof read !== 'object' || read === null) return { ok: false, code: 'ledger_unavailable', detail: 'the reading of the advert of the document has the wrong shape' };
    agent = Reflect.get(read, 'agent_id');
  } catch {
    return { ok: false, code: 'ledger_unavailable', detail: 'the ledger could not be read for the advert of the document' };
  }
  if (typeof agent !== 'string') return { ok: false, code: 'advert_not_counterparty', detail: 'the advert of the document names no agent, so it is not the advert of the counterparty' };
  if (`${DID_PREFIX}${agent}` !== counterparty) return { ok: false, code: 'advert_not_counterparty', detail: 'the advert of the document names another agent than the counterparty of the document' };
  return { ok: true };
}
