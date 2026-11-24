// agents/prior-authorization-agent/test/execute/real-dispute.test.ts: the challenge of the job `execute` through the REAL dispute folder of the kit, over the scripted chain port of the kit. The chain of the world posts the
// escrow with the delegation key of the agent, so the datum of the escrow of the hire passes the buyer-key check of the real code. The challenge names the open claim of the Insurer Intake Agent whose second statement
// is the statement of the job, and no other claim. A challenge that the real code refuses is `disputed` with its code, and nothing is published. Each refusal has an accepted twin.
import { afterEach, describe, expect, it } from 'vitest';
import { createSerialQueue } from '@vsa/usecase-kit/access';
import { Dispute, JUROR_MEDIA_TYPE, claimDocument } from '@vsa/usecase-kit/dispute';
import type { ClaimView, EscrowJobResult } from '@vsa/usecase-kit/dispute';
import { INTAKE_CLAIM, PRIORAUTH_CAPABILITIES } from '@vsa/usecase-kit/priorauth';
import type { ManifestClaim } from '@vsa/usecase-kit/protocol';
import {
  CHALLENGE_TX, EVIDENCE_TX, HOUR, KEY_HASH, MANIFEST_SHA, NOT_ESCROW, OTHER_BUYER_PKH, OTHER_KEY_HASH, REF_A, REF_B, REF_C, SETTINGS, ScriptedPort, TOKEN_A, TOKEN_B, TOKEN_C, claimView, never,
} from '../../../../packages/usecase-kit/test/dispute/support.ts';
import { INSURER_DID, acceptDecision, requestHash } from './fixtures.ts';
import type { World } from './world.ts';
import { T0, cleanWorlds, hireOf, words, world } from './world.ts';

afterEach(() => { cleanWorlds(); });

const OTHER_HASH = '00'.repeat(32);

/** The scripted port of the kit, for this agent: the challenger of the evidence is the agent of the world. */
class AgentPort extends ScriptedPort {
  override readonly agent: { readonly did: string; readonly key_hash: string };

  constructor(did: string) {
    super();
    this.agent = { did, key_hash: KEY_HASH };
  }
}

/** An open claim of the Insurer Intake Agent for its capability, with its claim document, which the port serves at the URI of the claim. `claim` is the three statements of the document. */
function staked(port: ScriptedPort, claim: ManifestClaim, over: Partial<ClaimView>): ClaimView {
  const document = claimDocument({ agent_did: INSURER_DID, capability_id: PRIORAUTH_CAPABILITIES.intake, manifest_sha256: MANIFEST_SHA, claim });
  if (!document.ok) throw new Error(`the claim document of the test is refused: ${document.detail}`);
  const view = claimView({ claimer: INSURER_DID, claimer_key_hash: OTHER_KEY_HASH, claim_hash: document.value.hash, ...over });
  port.documents.set(view.claim_uri, { bytes: document.value.bytes, type: 'claim', media_type: JUROR_MEDIA_TYPE });
  return view;
}

interface Rig {
  readonly w: World;
  readonly port: AgentPort;
  readonly dispute: Dispute;
  readonly right: ClaimView;
  readonly late: ClaimView;
  readonly misplaced: ClaimView;
}

/**
 * The real dispute over the scripted port, for a world. The port lists three open claims of the Insurer Intake Agent for its capability. The right claim states the second statement of the claim of the Insurer
 * Intake Agent. The late claim has another second statement and ends later, so a choice by the end of the window alone would take it. The misplaced claim holds the text of the job in its FIRST statement and another
 * text in its second, so a choice that looks at the text of the first statement would take it. The escrow that the port reads is the escrow of the hire: its datum, as the chain posted it.
 */
async function rig(): Promise<Rig> {
  const w = await world();
  const port = new AgentPort(w.agent.did);
  const [first, second, third] = INTAKE_CLAIM.statements;
  const right = staked(port, INTAKE_CLAIM, { ref: REF_A, token: TOKEN_A, submitted_at: T0 - HOUR });
  const late = staked(port, { statements: [first, { id: 'S2', text: 'An intake record names whatever this agent writes.' }, third] }, { ref: REF_B, token: TOKEN_B, submitted_at: T0 - 10 * 60_000 });
  const misplaced = staked(port, { statements: [{ id: 'S1', text: second.text }, { id: 'S2', text: 'An intake record is a record.' }, third] }, { ref: REF_C, token: TOKEN_C, submitted_at: T0 - 20 * 60_000 });
  port.claims = [late, misplaced, right];
  port.readEscrowAnswer = (ref): EscrowJobResult => {
    const datum = w.m.chain.escrowDatum(ref);
    if (datum === undefined) return NOT_ESCROW;
    const agentId: unknown = Reflect.get(datum, 'agent_id');
    return { ok: true, value: { block_time_ms: T0, state: datum.state, capability_id: datum.capability_id, agent_id: typeof agentId === 'string' ? agentId : null, buyer_pkh: datum.buyer_pkh } };
  };
  const dispute = new Dispute({ port, queue: createSerialQueue(), clock: () => T0 + 10 * 60_000, sleep: never, settings: SETTINGS });
  w.answer({ request_sha256: OTHER_HASH });
  return { w, port, dispute, right, late, misplaced };
}

describe('the real dispute folder', () => {
  it('files the challenge against the open claim of the Insurer Intake Agent that states the second statement of its claim, and not against a claim that ends later or that holds the text in another place', async () => {
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
    // The evidence that the real code published names the claim, the Insurer Intake Agent, this agent and the escrow, and it states the request number and the two hashes.
    expect(r.port.published).toHaveLength(1);
    const text = Buffer.from(r.port.published[0]!.bytes).toString('utf8');
    for (const line of [
      'Evidence about statement S2 of a claim on the Vector marketplace.', `Statement S2 of the claim reads: "${INTAKE_CLAIM.statements[1].text}"`, `Claim: ${REF_A}`, `Claimer: ${INSURER_DID}`,
      `Challenger: ${r.w.agent.did}`, `Escrow of the job: ${escrow}`, 'The request has the request number "run1-1".', `The SHA-256 of the request that the challenger sent is ${requestHash(r.w.document())}.`,
      `The intake record names the SHA-256 ${OTHER_HASH} for the request that it received.`,
    ]) {
      expect(text).toContain(line);
    }
    expect(r.w.store.calls).toHaveLength(0);
    expect(r.w.booked.accepted).toBe(0);
  });

  it('files no challenge when no open claim of the Insurer Intake Agent states the second statement of its claim: no_open_claim, and nothing is published', async () => {
    const r = await rig();
    r.port.claims = [r.late, r.misplaced];
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

  it('files nothing for a no of the model when the hashes are equal: the evidence builder of the kit refuses it with no_contradiction, nothing is published, and nothing is challenged', async () => {
    const r = await rig();
    r.w.answer({});
    r.w.accept.answer = () => ({ ok: true, decision: acceptDecision(false, ['request_sha256']), choice: { accept: false, mismatch: ['request_sha256'] } });
    const result = await r.w.run(r.w.request(), T0, { ...r.w.deps, dispute: r.dispute });
    expect(words(result)).toBe('disputed no_contradiction Failed');
    expect(result.decisions).toStrictEqual([acceptDecision(false, ['request_sha256'])]);
    expect(r.port.published).toHaveLength(0);
    expect(r.port.challenged).toHaveLength(0);
    expect(r.w.booked.accepted).toBe(0);
    expect(r.w.store.calls).toHaveLength(0);
  });

  it('files nothing for a record whose hash is right and written in upper case: the record is refused by the job before the model and before the dispute folder, so no document is built and nothing is challenged', async () => {
    const r = await rig();
    r.w.answer({ request_sha256: requestHash(r.w.document()).toUpperCase() });
    const result = await r.w.run(r.w.request(), T0, { ...r.w.deps, dispute: r.dispute });
    expect(words(result)).toBe('failed intake_record_invalid Failed');
    expect(r.w.accept.calls).toHaveLength(0);
    expect(r.port.published).toHaveLength(0);
    expect(r.port.challenged).toHaveLength(0);
    // The twin: the same hash in lower case is the right hash, the model accepts, and the submission is written.
    const twin = await rig();
    twin.w.answer({ request_sha256: requestHash(twin.w.document()) });
    expect(words(await twin.w.run(twin.w.request(), T0, { ...twin.w.deps, dispute: twin.dispute }))).toBe('completed none Completed');
    expect(twin.port.challenged).toHaveLength(0);
  });
});
