// agents/sourcing-agent/test/quotes/real-dispute.test.ts: the challenge of the quote fan-out through the REAL dispute folder of the kit, over the scripted chain port of the kit and a memory journal. The three Bid Desks
// each have an open claim, and one of them has a second claim with another first statement that ends later. The challenge names the open claim of the bidder whose quote the model did not accept, whose first statement is
// the statement of the job, and no other claim. The evidence document names the quoted price and the listed price. A challenge that the real code refuses is `disputed` with its code, and nothing is published. Each
// refusal has an accepted twin.
import { afterEach, describe, expect, it } from 'vitest';
import { BID_CAPABILITIES, BID_DESK_CLAIM } from '@vsa/usecase-kit/bids';
import { createSerialQueue } from '@vsa/usecase-kit/access';
import { Dispute, JUROR_MEDIA_TYPE, MemoryJournal, claimDocument } from '@vsa/usecase-kit/dispute';
import type { ClaimView, EscrowJobResult } from '@vsa/usecase-kit/dispute';
import type { ManifestClaim } from '@vsa/usecase-kit/protocol';
import {
  CHALLENGE_TX, EVIDENCE_TX, HOUR, KEY_HASH, MANIFEST_SHA, NOT_ESCROW, OTHER_BUYER_PKH, OTHER_KEY_HASH, REF_A, REF_B, REF_C, SETTINGS, ScriptedPort, TOKEN_A, TOKEN_B, TOKEN_C, claimView, never,
} from '../../../../packages/usecase-kit/test/dispute/support.ts';
import { ALFA, BRAVO, CHARLIE, SENDER_DID, bidderOf, priced, quoteText } from './support.ts';
import type { DeskSpec } from './support.ts';
import { T0, cleanWorlds, hired, words, world } from './world.ts';
import type { World } from './world.ts';

afterEach(() => { cleanWorlds(); });

/** The scripted port of the kit, for this agent: the challenger of the evidence is the agent of the job. */
class AgentPort extends ScriptedPort {
  override readonly agent: { readonly did: string; readonly key_hash: string };

  constructor(did: string) {
    super();
    this.agent = { did, key_hash: KEY_HASH };
  }
}

/** An open claim of a Bid Desk for the capability of the quote, with its claim document, which the port serves at the URI of the claim. `claim` is the three statements of the document. */
function staked(port: ScriptedPort, desk: DeskSpec, claim: ManifestClaim, over: Partial<ClaimView>): ClaimView {
  const document = claimDocument({ agent_did: desk.did, capability_id: BID_CAPABILITIES.quote, manifest_sha256: MANIFEST_SHA, claim });
  if (!document.ok) throw new Error(`the claim document of the test is refused: ${document.detail}`);
  const view = claimView({ claimer: desk.did, claimer_key_hash: OTHER_KEY_HASH, claim_hash: document.value.hash, ...over });
  port.documents.set(view.claim_uri, { bytes: document.value.bytes, type: 'claim', media_type: JUROR_MEDIA_TYPE });
  return view;
}

interface Rig {
  readonly w: World;
  readonly port: AgentPort;
  readonly dispute: Dispute;
  readonly alfa: ClaimView;
  readonly bravo: ClaimView;
  readonly charlie: ClaimView;
  readonly decoy: ClaimView;
}

/**
 * The real dispute over the scripted port, for a world. The port lists an open claim for each of the three Bid Desks, and a second claim of Bravo whose first statement is another one and that ends later, so a choice
 * by the claimer or by the end of the window alone would take it. The escrow that the port reads is the escrow of the hire: its datum, as the chain posted it. Bravo quotes SYR-10ML below its listed price.
 */
async function rig(): Promise<Rig> {
  const w = await world();
  const port = new AgentPort(SENDER_DID);
  const alfa = staked(port, ALFA, BID_DESK_CLAIM, { ref: REF_A, token: TOKEN_A, submitted_at: T0 - HOUR });
  const bravo = staked(port, BRAVO, BID_DESK_CLAIM, { ref: REF_B, token: TOKEN_B, submitted_at: T0 - HOUR });
  const charlie = staked(port, CHARLIE, BID_DESK_CLAIM, { ref: REF_C, token: TOKEN_C, submitted_at: T0 - HOUR });
  const decoy = staked(
    port, BRAVO, { statements: [{ id: 'S1', text: 'A quote names whatever this agent writes.' }, BID_DESK_CLAIM.statements[1], BID_DESK_CLAIM.statements[2]] },
    { ref: `${'cd'.repeat(32)}#0`, token: `636c6d5f${'0d'.repeat(28)}`, submitted_at: T0 - 10 * 60_000 },
  );
  port.claims = [alfa, decoy, charlie, bravo];
  port.readEscrowAnswer = (ref): EscrowJobResult => {
    const datum = w.chain.escrowDatum(ref);
    if (datum === undefined) return NOT_ESCROW;
    const agentId: unknown = Reflect.get(datum, 'agent_id');
    return { ok: true, value: { block_time_ms: T0, state: datum.state, capability_id: datum.capability_id, agent_id: typeof agentId === 'string' ? agentId : null, buyer_pkh: datum.buyer_pkh } };
  };
  const dispute = new Dispute({ port, queue: createSerialQueue(), clock: () => T0 + 10 * 60_000, sleep: never, settings: SETTINGS, journal: new MemoryJournal() });
  w.desks.bravo.answer = () => quoteText(BRAVO, priced('SYR-10ML', 30));
  return { w, port, dispute, alfa, bravo, charlie, decoy };
}

describe('the real dispute folder', () => {
  it('files the challenge against the open claim of the bidder whose quote was not accepted, while the claims of the two other Bid Desks are open, and against no other claim', async () => {
    const r = await rig();
    const result = await r.w.run(r.w.input(), { ...r.w.deps, dispute: r.dispute });
    expect(result.outcomes.map(words)).toStrictEqual(['accepted', 'excluded disputed none', 'accepted']);
    const bravo = hired(result.outcomes, 1);
    expect(bravo.challenge).toStrictEqual({ claim: REF_B, evidence: EVIDENCE_TX, challenge: `${CHALLENGE_TX}#0` });
    expect(bravo.record.challenge).toStrictEqual(bravo.challenge);
    expect(r.port.challenged.map((call) => call.claim)).toStrictEqual([REF_B]);
    expect(r.w.dispute.calls).toHaveLength(0);
    // The escrow that the real code read is the escrow of the hire, and its buyer is the delegation key of the agent.
    expect(r.port.events).toContain(`readEscrow ${bravo.record.escrow_ref}`);
    expect(r.w.chain.escrowDatum(bravo.record.escrow_ref)?.buyer_pkh).toBe(r.w.deps.buyerPkhs[0]);
  });

  it('publishes an evidence document that names the claim, the bidder, this agent and the escrow, and that states the quoted price and the listed price', async () => {
    const r = await rig();
    const result = await r.w.run(r.w.input(), { ...r.w.deps, dispute: r.dispute });
    const escrow = hired(result.outcomes, 1).record.escrow_ref;
    expect(r.port.published).toHaveLength(1);
    const text = Buffer.from(r.port.published[0]!.bytes).toString('utf8');
    for (const line of [
      `Claim: ${REF_B}`, `Claimer: ${BRAVO.did}`, `Challenger: ${SENDER_DID}`, `Escrow of the job: ${escrow}`,
      'The bid desk quoted the unit price 30 for the SKU "SYR-10ML" at the quantity 250.', 'The published price list of the bid desk gives the unit price 36 for the SKU "SYR-10ML" at the quantity 250.',
    ]) {
      expect(text).toContain(line);
    }
  });

  it('files no challenge when no open claim of the bidder states the first statement of its claim, and the claims of the other bidders are not taken in its place: no_open_claim, and nothing is published', async () => {
    const r = await rig();
    r.port.claims = [r.alfa, r.decoy, r.charlie];
    const result = await r.w.run(r.w.input(), { ...r.w.deps, dispute: r.dispute });
    expect(result.outcomes.map(words)).toStrictEqual(['accepted', 'excluded disputed no_open_claim', 'accepted']);
    expect(hired(result.outcomes, 1)).toMatchObject({ challenge: null, record: { challenge: null } });
    expect(r.port.published).toHaveLength(0);
    expect(r.port.challenged).toHaveLength(0);
  });

  it('refuses to challenge when the escrow names a buyer that is not a delegation key of the agent: the real code checks the buyer, and nothing is published', async () => {
    const r = await rig();
    const posted = r.port.readEscrowAnswer;
    r.port.readEscrowAnswer = (ref) => {
      const job = posted(ref);
      return job instanceof Error || !job.ok ? job : { ok: true, value: { ...job.value, buyer_pkh: OTHER_BUYER_PKH } };
    };
    const result = await r.w.run(r.w.input(), { ...r.w.deps, dispute: r.dispute });
    expect(result.outcomes.map(words)).toStrictEqual(['accepted', 'excluded disputed bad_shape', 'accepted']);
    expect(r.port.published).toHaveLength(0);
    expect(r.port.challenged).toHaveLength(0);
  });

  it('refuses to challenge when the keys that the job names are not the buyer of the escrow, and the twin of the first test files the challenge', async () => {
    const r = await rig();
    const result = await r.w.run(r.w.input(), { ...r.w.deps, dispute: r.dispute, buyerPkhs: [OTHER_BUYER_PKH] });
    expect(result.outcomes.map(words)).toStrictEqual(['accepted', 'excluded disputed bad_shape', 'accepted']);
    expect(r.port.challenged).toHaveLength(0);
    const twin = await rig();
    expect((await twin.w.run(twin.w.input(), { ...twin.w.deps, dispute: twin.dispute })).outcomes.map(words)).toStrictEqual(['accepted', 'excluded disputed none', 'accepted']);
  });

  it('files no challenge for a quote that the model accepts, whatever claims are open', async () => {
    const r = await rig();
    r.w.desks.bravo.answer = () => quoteText(BRAVO);
    const result = await r.w.run(r.w.input({ invited: [bidderOf(BRAVO)] }), { ...r.w.deps, dispute: r.dispute });
    expect(result.outcomes.map(words)).toStrictEqual(['accepted']);
    expect(r.port.challenged).toHaveLength(0);
    expect(r.port.published).toHaveLength(0);
  });
});
