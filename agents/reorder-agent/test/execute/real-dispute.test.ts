// agents/reorder-agent/test/execute/real-dispute.test.ts: the challenge of the job `execute` through the REAL dispute folder of the kit, over the scripted chain port of the kit. The chain of the world posts the
// escrow with the delegation key of the agent, so the datum of the escrow of the hire passes the buyer-key check of the real code. The challenge names the open claim of the Order Desk whose first statement is the
// statement of the job, and no other claim. A challenge that the real code refuses is `disputed` with its code, and nothing is published. Each refusal has an accepted twin.
import { afterEach, describe, expect, it } from 'vitest';
import { createSerialQueue } from '@vsa/usecase-kit/access';
import { Dispute, JUROR_MEDIA_TYPE, claimDocument } from '@vsa/usecase-kit/dispute';
import type { ClaimView, EscrowJobResult } from '@vsa/usecase-kit/dispute';
import { INVENTORY_CAPABILITIES, ORDER_DESK_CLAIM } from '@vsa/usecase-kit/inventory';
import type { ManifestClaim } from '@vsa/usecase-kit/protocol';
import {
  CHALLENGE_TX, EVIDENCE_TX, HOUR, KEY_HASH, MANIFEST_SHA, NOT_ESCROW, OTHER_BUYER_PKH, OTHER_KEY_HASH, REF_A, REF_B, SETTINGS, ScriptedPort, TOKEN_A, TOKEN_B, claimView, never,
} from '../../../../packages/usecase-kit/test/dispute/support.ts';
import { SUPPLIER_DID } from './fixtures.ts';
import type { World } from './world.ts';
import { T0, cleanWorlds, hireOf, words, world } from './world.ts';

afterEach(() => { cleanWorlds(); });

/** The scripted port of the kit, for this agent: the challenger of the evidence is the agent of the world. */
class AgentPort extends ScriptedPort {
  override readonly agent: { readonly did: string; readonly key_hash: string };

  constructor(did: string) {
    super();
    this.agent = { did, key_hash: KEY_HASH };
  }
}

/** An open claim of the Order Desk for its capability, with its claim document, which the port serves at the URI of the claim. `claim` is the three statements of the document. */
function staked(port: ScriptedPort, claim: ManifestClaim, over: Partial<ClaimView>): ClaimView {
  const document = claimDocument({ agent_did: SUPPLIER_DID, capability_id: INVENTORY_CAPABILITIES.order, manifest_sha256: MANIFEST_SHA, claim });
  if (!document.ok) throw new Error(`the claim document of the test is refused: ${document.detail}`);
  const view = claimView({ claimer: SUPPLIER_DID, claimer_key_hash: OTHER_KEY_HASH, claim_hash: document.value.hash, ...over });
  port.documents.set(view.claim_uri, { bytes: document.value.bytes, type: 'claim', media_type: JUROR_MEDIA_TYPE });
  return view;
}

interface Rig {
  readonly w: World;
  readonly port: AgentPort;
  readonly dispute: Dispute;
  readonly right: ClaimView;
  readonly decoy: ClaimView;
}

/**
 * The real dispute over the scripted port, for a world. The port lists two open claims of the Order Desk for its capability. The right claim states the first statement of the claim of the Order Desk. The
 * decoy has another first statement and ends later, so a choice by the end of the window alone would take it. The escrow that the port reads is the escrow of the hire: its datum, as the chain posted it.
 */
async function rig(): Promise<Rig> {
  const w = await world();
  const port = new AgentPort(w.agent.did);
  const right = staked(port, ORDER_DESK_CLAIM, { ref: REF_A, token: TOKEN_A, submitted_at: T0 - HOUR });
  const decoy = staked(
    port, { statements: [{ id: 'S1', text: 'A confirmation names whatever this agent writes.' }, ORDER_DESK_CLAIM.statements[1], ORDER_DESK_CLAIM.statements[2]] }, { ref: REF_B, token: TOKEN_B, submitted_at: T0 - 10 * 60_000 },
  );
  port.claims = [decoy, right];
  port.readEscrowAnswer = (ref): EscrowJobResult => {
    const datum = w.m.chain.escrowDatum(ref);
    if (datum === undefined) return NOT_ESCROW;
    const agentId: unknown = Reflect.get(datum, 'agent_id');
    return { ok: true, value: { block_time_ms: T0, state: datum.state, capability_id: datum.capability_id, agent_id: typeof agentId === 'string' ? agentId : null, buyer_pkh: datum.buyer_pkh } };
  };
  const dispute = new Dispute({ port, queue: createSerialQueue(), clock: () => T0 + 10 * 60_000, sleep: never, settings: SETTINGS });
  w.answer({ lot: 'lot-large' });
  return { w, port, dispute, right, decoy };
}

describe('the real dispute folder', () => {
  it('files the challenge against the open claim of the Order Desk that states the first statement of its claim, and not against the claim that ends later', async () => {
    const r = await rig();
    const result = await r.w.run(r.w.request(), T0, { ...r.w.deps, dispute: r.dispute });
    expect(words(result)).toBe('disputed none Escalated');
    expect(result.challenge).toStrictEqual({ claim: REF_A, evidence: EVIDENCE_TX, challenge: `${CHALLENGE_TX}#0` });
    expect(r.port.challenged.map((call) => call.claim)).toStrictEqual([REF_A]);
    expect(r.w.dispute.calls).toHaveLength(0);
    // The escrow that the real code read is the escrow of the hire, and its buyer is a delegation key of the agent.
    const escrow = hireOf(result).escrow_ref;
    expect(r.port.events).toContain(`readEscrow ${escrow}`);
    expect([r.w.a.testKey.keyHash, r.w.b.testKey.keyHash]).toContain(r.w.m.chain.escrowDatum(escrow)?.buyer_pkh);
    // The evidence that the real code published names the claim, the Order Desk, this agent and the escrow, and it states the field that differs.
    expect(r.port.published).toHaveLength(1);
    const text = Buffer.from(r.port.published[0]!.bytes).toString('utf8');
    for (const line of [`Claim: ${REF_A}`, `Claimer: ${SUPPLIER_DID}`, `Challenger: ${r.w.agent.did}`, `Escrow of the job: ${escrow}`, 'The lot differs.', 'The SKU is the same in both.', 'The quantity is the same in both.']) {
      expect(text).toContain(line);
    }
    expect(r.w.store.calls).toHaveLength(0);
    expect(r.w.booked.accepted).toBe(0);
  });

  it('files no challenge when no open claim of the Order Desk states the first statement of its claim: no_open_claim, and nothing is published', async () => {
    const r = await rig();
    r.port.claims = [r.decoy];
    const result = await r.w.run(r.w.request(), T0, { ...r.w.deps, dispute: r.dispute });
    expect(words(result)).toBe('disputed no_open_claim Failed');
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
    const result = await r.w.run(r.w.request(), T0, { ...r.w.deps, dispute: r.dispute });
    expect(words(result)).toBe('disputed bad_shape Failed');
    expect(r.port.published).toHaveLength(0);
    expect(r.port.challenged).toHaveLength(0);
  });

  it('refuses to challenge when the keys that the job names are not the buyer of the escrow: the same refusal from the other side, and the twin of the first test', async () => {
    const r = await rig();
    const result = await r.w.run(r.w.request(), T0, { ...r.w.deps, dispute: r.dispute, buyerPkhs: [OTHER_BUYER_PKH] });
    expect(words(result)).toBe('disputed bad_shape Failed');
    expect(r.port.challenged).toHaveLength(0);
    const twin = await rig();
    expect(words(await twin.w.run(twin.w.request(), T0, { ...twin.w.deps, dispute: twin.dispute }))).toBe('disputed none Escalated');
  });
});
