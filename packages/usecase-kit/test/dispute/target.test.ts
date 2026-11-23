// packages/usecase-kit/test/dispute/target.test.ts: the claim that a challenge names, on a scripted chain port. A claim is a target only when ALL hold: its claimer is the other party; its claim document
// is on chain, is the document that the claim holds by hash, and is the document that `claimDocument` writes for the claimer and for the capability of the job, with the statement S1 that the job hired; it was
// submitted before the job began; it is Open with enough window left; and its stake is not above the challenge stake. Among the targets the one with the latest challenge deadline is chosen, and with the
// same deadline the one with the lowest claim token. A claim that is not a target is left out and counted. Each refusal has an accepted twin.
import { describe, expect, it } from 'vitest';
import { documentHash, documentUri } from '@vsa/buyer-core';
import { NO_OPEN_CLAIM } from '@vsa/usecase-kit/protocol';
import { Dispute, claimDocument } from '@vsa/usecase-kit/dispute';
import type { ApprovalChallengeInput, ChallengeResult, ClaimView, DeliveryChallengeInput, EscrowJob } from '@vsa/usecase-kit/dispute';
import {
  APPROVAL_JOB, BUYER_PKH, CLAIM_CAPABILITY, DELIVERY_JOB, DIGEST_FACTS, ESCROW, ESCROW_2, ESCROW_CAPABILITY, EVIDENCE_TX, HOUR, JOB, JOB_BEGAN_AT, MANIFEST_SHA, ME_ID, NO_DOCUMENT, NO_TRANSACTION, NOW, ORDER_DESK_CLAIM,
  ORDER_FACTS, OTHER, OTHER_BUYER_PKH, OTHER_ID, PRIOR_AUTHORIZATION_CLAIM, REF_A, REF_B, REF_C, REORDER_AGENT_S1, RecordingQueue, SCOPE, SENDER_CAPABILITY, STATEMENT_S1, SETTINGS, ScriptedPort, THIRD, THIRD_ID, TOKEN_A, TOKEN_B,
  TOKEN_C, claimView, deferred, escrowJob, kitClaimDocument, never, rig, senderClaimView,
} from './support.ts';
import type { Rig } from './support.ts';

const delivery = (extra: Partial<DeliveryChallengeInput> = {}): DeliveryChallengeInput => ({ counterparty: OTHER, escrow_ref: ESCROW, ...DELIVERY_JOB, evidence: ORDER_FACTS, ...extra });
const approval = (extra: Partial<ApprovalChallengeInput> = {}): ApprovalChallengeInput => ({ sender: OTHER, escrow_ref: ESCROW, ...APPROVAL_JOB, evidence: DIGEST_FACTS, ...extra });
/** What a read answers for a job that the sender of a request hired this agent for: the datum names this agent. */
const hiringMe = (overrides: Partial<EscrowJob> = {}) => escrowJob({ agent_id: ME_ID, ...overrides });
const textOf = (bytes: Uint8Array): string => Buffer.from(bytes).toString('utf8');

/** The detail of no_open_claim for `open` open claims, and for the counts of the seven reasons in the order of the detail. */
const counted = (open: number, left: readonly [number, number, number, number, number, number, number]): string =>
  `the agent has ${open} open claim(s), and none can be challenged: ${left[0]} with a challenge window that ends too soon, ${left[1]} submitted at or after the start of the job, `
  + `${left[2]} with a stake above the challenge stake, ${left[3]} whose claim document is not on chain or is not a document, ${left[4]} without a claim document of this kit, `
  + `${left[5]} with a claim document for another capability, ${left[6]} with a claim document whose statement S1 is another text`;

/** A claim of the other party that was staked a minute after the older claim of the samples, before the job began, and that ends 15 hours later: with no rule of the job, it would be the target. */
const newer = (overrides: Partial<ClaimView> = {}): ClaimView => claimView({ ref: REF_B, token: TOKEN_B, submitted_at: NOW - HOUR + 60_000, challenge_window_ms: 20 * HOUR, ...overrides });

/** The claim document that this kit writes for OTHER for `capability`, with the statements of the order desk. */
function forCapability(capability: string) {
  const document = claimDocument({ agent_did: OTHER, capability_id: capability, manifest_sha256: MANIFEST_SHA, claim: ORDER_DESK_CLAIM });
  if (!document.ok) throw new Error(document.detail);
  return document.value;
}

/** The port answers `answer` for the document of `claim`, and what it answered before for every other address. */
function answering(rigged: Rig, claim: ClaimView, answer: unknown): void {
  const normal = rigged.port.readDocumentAnswer;
  rigged.port.readDocumentAnswer = (uri) => (uri === claim.claim_uri ? (answer as never) : normal(uri));
}

function expectNotFiled(result: ChallengeResult, code: string): asserts result is Extract<ChallengeResult, { ok: false }> {
  expect(result).toMatchObject({ ok: false, code });
}

/** Gives a claim a document: the bytes go to the port at the URI of the claim, and the claim holds their hash. */
function holding(port: ScriptedPort, claim: ClaimView, bytes: Uint8Array, type = 'claim', mediaType = 'text/plain'): ClaimView {
  port.documents.set(claim.claim_uri, { bytes, type, media_type: mediaType });
  return { ...claim, claim_hash: documentHash(bytes) };
}

/** The claim document that this kit writes for `claimer`, with other statements. */
function otherStatements(claimer: string) {
  const document = claimDocument({ agent_did: claimer, capability_id: CLAIM_CAPABILITY, manifest_sha256: MANIFEST_SHA, claim: PRIOR_AUTHORIZATION_CLAIM });
  if (!document.ok) throw new Error(document.detail);
  return document.value;
}

/** The claim document that this kit writes for OTHER for the capability of the job, with `text` as its statement S1 and the other statements of the order desk. */
function withStatement(text: string) {
  const document = claimDocument({
    agent_did: OTHER, capability_id: CLAIM_CAPABILITY, manifest_sha256: MANIFEST_SHA, claim: { statements: [{ id: 'S1', text }, ORDER_DESK_CLAIM.statements[1], ORDER_DESK_CLAIM.statements[2]] },
  });
  if (!document.ok) throw new Error(document.detail);
  return document.value;
}

describe('a challenge names only a claim of this kit', () => {
  const NOT_KIT: Array<[string, (rigged: Rig) => ClaimView]> = [
    ['a claim hash that is not the hash of the document', ({ port }) => ({ ...holding(port, claimView(), kitClaimDocument(OTHER).bytes), claim_hash: 'ab'.repeat(32) })],
    ['a document that is another text', ({ port }) => holding(port, claimView(), Buffer.from('any other text\n'))],
    ['a document with a changed sentence', ({ port }) => holding(port, claimView(), Buffer.from(kitClaimDocument(OTHER).text.replace('Claim of an agent', 'Claim by an agent')))],
    ['a document with a line more', ({ port }) => holding(port, claimView(), Buffer.from(`${kitClaimDocument(OTHER).text}One more line.\n`))],
    ['the claim document of another agent', ({ port }) => holding(port, claimView(), kitClaimDocument(THIRD).bytes)],
    ['a document that is not published as a claim', ({ port }) => holding(port, claimView(), kitClaimDocument(OTHER).bytes, 'evidence')],
    ['a document with another media type', ({ port }) => holding(port, claimView(), kitClaimDocument(OTHER).bytes, 'claim', 'application/json')],
    ['a document with no type', ({ port }) => holding(port, claimView(), kitClaimDocument(OTHER).bytes, null as never, null as never)],
    ['a document that is not UTF-8', ({ port }) => holding(port, claimView(), Uint8Array.from([0xff, 0xfe, 0x41]))],
    ['a document with a NUL character', ({ port }) => holding(port, claimView(), Buffer.from(kitClaimDocument(OTHER).text.replace('S2: This agent', 'S2: This\u0000 agent')))],
    ['a document with the escape of U+0000', ({ port }) => holding(port, claimView(), Buffer.from(kitClaimDocument(OTHER).text.replace('S2: This agent', 'S2: This \\u0000 agent')))],
  ];

  it.each(NOT_KIT)('leaves out a claim with %s, says how many claims were left out, and publishes nothing', async (_name, make) => {
    const rigged = rig();
    rigged.port.claims = [make(rigged)];
    const result = await rigged.dispute.challengeDelivery(delivery());
    expectNotFiled(result, NO_OPEN_CLAIM);
    expect(result.detail).toBe(counted(1, [0, 0, 0, 0, 1, 0, 0]));
    expect(rigged.port.published).toEqual([]);
    expect(rigged.port.challenged).toEqual([]);
    expect(rigged.events).toEqual(['readClaims', `readEscrow ${ESCROW}`, `readDocument ${rigged.port.claims[0]!.claim_uri}`]);
  });

  it('is the twin: the claim document that this kit writes for the claimer is challenged', async () => {
    const rigged = rig();
    rigged.port.claims = [claimView()];
    expect((await rigged.dispute.challengeDelivery(delivery())).ok).toBe(true);
    expect(rigged.port.challenged.map((call) => call.claim)).toEqual([REF_A]);
  });

  it('never fetches a document at an address that is not a vector-tx address, and leaves the claim out', async () => {
    for (const uri of ['https://example.org/claim.txt', 'http://127.0.0.1/claim.txt', 'ipfs://zq9', 'vector-tx:zq9', 'vector-tx:', '', documentUri('ab'.repeat(32)).slice(0, -1)]) {
      const rigged = rig();
      rigged.port.claims = [claimView({ claim_uri: uri })];
      const result = await rigged.dispute.challengeDelivery(delivery());
      expectNotFiled(result, NO_OPEN_CLAIM);
      expect(rigged.events, uri).toEqual(['readClaims', `readEscrow ${ESCROW}`]);
    }
  });

  it('leaves out a claim whose hash is hex of another length than 64 characters, without reading its document, and says chain_unavailable for a hash that is not lower-case hex', async () => {
    for (const hash of ['', 'ab', 'ab'.repeat(33)]) {
      const rigged = rig();
      rigged.port.claims = [claimView({ claim_hash: hash })];
      expectNotFiled(await rigged.dispute.challengeDelivery(delivery()), NO_OPEN_CLAIM);
      expect(rigged.events).toEqual(['readClaims', `readEscrow ${ESCROW}`]);
    }
    // A hash with a character that is not lower-case hex is a view of a wrong shape, and the lookup does not go on.
    for (const hash of ['zz'.repeat(32), 'AB'.repeat(32)]) {
      const rigged = rig();
      rigged.port.claims = [claimView({ claim_hash: hash })];
      expectNotFiled(await rigged.dispute.challengeDelivery(delivery()), 'chain_unavailable');
      expect(rigged.events).toEqual(['readClaims']);
    }
  });

  it('says chain_unavailable for a document that cannot be read, and never takes it for a claim of another kind; the job is not used up', async () => {
    const rigged = rig();
    rigged.port.claims = [claimView()];
    const normal = rigged.port.readDocumentAnswer;
    rigged.port.readDocumentAnswer = () => new Error('Koios answered 503 at https://koios.example/secret-key');
    const result = await rigged.dispute.challengeDelivery(delivery());
    expectNotFiled(result, 'chain_unavailable');
    expect(result.detail).not.toContain('secret-key');
    expect(rigged.port.published).toEqual([]);
    // The twin: the document can be read again, and the same job is filed.
    rigged.port.readDocumentAnswer = normal;
    expect((await rigged.dispute.challengeDelivery(delivery())).ok).toBe(true);
  });

  it('says chain_unavailable for a document that the port gives in a wrong shape', async () => {
    const shapes: unknown[] = [null, 'text', {}, { bytes: 'text', type: 'claim', media_type: 'text/plain' }, { bytes: new Uint8Array(), type: 7, media_type: 'text/plain' }, { bytes: new Uint8Array(), type: 'claim', media_type: undefined }];
    for (const shape of shapes) {
      const rigged = rig();
      rigged.port.claims = [claimView()];
      rigged.port.readDocumentAnswer = () => shape as never;
      expectNotFiled(await rigged.dispute.challengeDelivery(delivery()), 'chain_unavailable');
      expect(rigged.port.published).toEqual([]);
    }
  });

  it('does not read the document of a claim that is not a candidate: a claim of another agent, a claim that is not open, a claim whose window ended, a claim that was submitted after the job began, and a claim with a stake above the challenge stake', async () => {
    const rigged = rig();
    rigged.port.claims = [
      claimView({ ref: REF_B, token: TOKEN_B, claimer: THIRD }), claimView({ ref: REF_C, token: TOKEN_C, state: 'Validated' }), claimView({ submitted_at: NOW - 5 * HOUR }),
      claimView({ ref: `${'cd'.repeat(32)}#0`, token: `636c6d5f${'0d'.repeat(28)}`, submitted_at: JOB_BEGAN_AT }),
      claimView({ ref: `${'ce'.repeat(32)}#0`, token: `636c6d5f${'0e'.repeat(28)}`, stake_lovelace: SETTINGS.challenge_stake_lovelace + 1n }),
    ];
    expectNotFiled(await rigged.dispute.challengeDelivery(delivery()), NO_OPEN_CLAIM);
    expect(rigged.events).toEqual(['readClaims', `readEscrow ${ESCROW}`]);
  });

  it('names the statement of the claim document that the claim holds, and not a statement of the facts', async () => {
    const rigged = rig();
    const document = otherStatements(OTHER);
    rigged.port.claims = [holding(rigged.port, claimView(), document.bytes)];
    expect((await rigged.dispute.challengeDelivery(delivery({ statement_text: PRIOR_AUTHORIZATION_CLAIM.statements[0].text }))).ok).toBe(true);
    const text = textOf(rigged.port.published[0]!.bytes);
    expect(text.split('\n')[1]).toBe(`Statement S1 of the claim reads: "${PRIOR_AUTHORIZATION_CLAIM.statements[0].text}"`);
    expect(text).not.toContain(STATEMENT_S1);
  });

  it('shows a long statement cut with a note, and still files the challenge', async () => {
    const rigged = rig();
    const long = 'x'.repeat(1_000);
    const document = claimDocument({
      agent_did: OTHER, capability_id: 'supplychain.order.accept.v1', manifest_sha256: MANIFEST_SHA,
      claim: { statements: [{ id: 'S1', text: long }, PRIOR_AUTHORIZATION_CLAIM.statements[1], PRIOR_AUTHORIZATION_CLAIM.statements[2]] },
    });
    if (!document.ok) throw new Error(document.detail);
    rigged.port.claims = [holding(rigged.port, claimView(), document.value.bytes)];
    expect((await rigged.dispute.challengeDelivery(delivery({ statement_text: long }))).ok).toBe(true);
    const text = textOf(rigged.port.published[0]!.bytes);
    expect(text).toContain('[cut: the text of the value has 1002 characters]');
    expect(text).not.toContain('x'.repeat(400));
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(3_000);
  });
});

describe('a claim is a target only when it covers the job', () => {
  it('leaves out a claim document of this kit for another capability, and challenges the claim that is for the capability of the job', async () => {
    const rigged = rig();
    const decoy = holding(rigged.port, newer(), forCapability('supplychain.rfq.quote.v1').bytes);
    rigged.port.claims = [claimView(), decoy];
    expect((await rigged.dispute.challengeDelivery(delivery())).ok).toBe(true);
    expect(rigged.port.challenged.map((call) => call.claim)).toEqual([REF_A]);
    expect(textOf(rigged.port.published[0]!.bytes)).toContain(`Claim: ${REF_A}`);
    // The decoy ends later, so it is looked at first, and the claim for the capability of the job after it.
    expect(rigged.events.filter((event) => event.startsWith('readDocument'))).toEqual([`readDocument ${decoy.claim_uri}`, `readDocument ${claimView().claim_uri}`]);
  });

  it('says no_open_claim and counts the claim when no claim is for the capability of the job, and takes the same claim for its own capability', async () => {
    const rigged = rig();
    rigged.port.claims = [holding(rigged.port, claimView(), forCapability('supplychain.rfq.quote.v1').bytes)];
    const result = await rigged.dispute.challengeDelivery(delivery());
    expectNotFiled(result, NO_OPEN_CLAIM);
    expect(result.detail).toBe(counted(1, [0, 0, 0, 0, 0, 1, 0]));
    expect(rigged.port.published).toEqual([]);
    const twin = rig();
    twin.port.claims = [holding(twin.port, claimView(), forCapability('supplychain.rfq.quote.v1').bytes)];
    twin.port.readEscrowAnswer = () => escrowJob({ capability_id: 'supplychain.rfq.quote.v1' });
    expect((await twin.dispute.challengeDelivery({ ...delivery(), capability_id: 'supplychain.rfq.quote.v1' })).ok).toBe(true);
  });

  it('leaves out a claim that was submitted at or after the start of the job, and takes a claim that was submitted a millisecond before it', async () => {
    for (const [submitted, filed] of [[JOB_BEGAN_AT - 1, true], [JOB_BEGAN_AT, false], [JOB_BEGAN_AT + 1, false], [NOW, false]] as const) {
      const rigged = rig();
      rigged.port.claims = [claimView({ submitted_at: submitted })];
      const result = await rigged.dispute.challengeDelivery(delivery());
      expect(result.ok, String(submitted)).toBe(filed);
      if (!result.ok) expect(result.detail).toBe(counted(1, [0, 1, 0, 0, 0, 0, 0]));
      expect(rigged.events.includes(`readDocument ${claimView().claim_uri}`), String(submitted)).toBe(filed);
    }
  });

  it('does not let a claim that was staked after the job began take the place of the claim that covers the job, although it ends later', async () => {
    const rigged = rig();
    rigged.port.claims = [claimView(), newer({ submitted_at: JOB_BEGAN_AT + 60_000 })];
    expect((await rigged.dispute.challengeDelivery(delivery())).ok).toBe(true);
    expect(rigged.port.challenged.map((call) => call.claim)).toEqual([REF_A]);
    expect(rigged.events.filter((event) => event.startsWith('readDocument'))).toEqual([`readDocument ${claimView().claim_uri}`]);
    // The twin: the same claim, staked before the job began, is the target because it ends later.
    const twin = rig();
    twin.port.claims = [claimView(), newer({ submitted_at: JOB_BEGAN_AT - 60_000 })];
    expect((await twin.dispute.challengeDelivery(delivery())).ok).toBe(true);
    expect(twin.port.challenged.map((call) => call.claim)).toEqual([REF_B]);
  });

  it('leaves out a claim with a stake above the challenge stake, and challenges the older claim', async () => {
    const rigged = rig();
    rigged.port.claims = [claimView(), newer({ stake_lovelace: 500_000_000n })];
    expect((await rigged.dispute.challengeDelivery(delivery())).ok).toBe(true);
    expect(rigged.port.challenged.map((call) => call.claim)).toEqual([REF_A]);
    expect(rigged.events.filter((event) => event.startsWith('readDocument'))).toEqual([`readDocument ${claimView().claim_uri}`]);
    // The twin: a stake of the same size as the challenge stake is a target, and it ends later, so it is chosen.
    const twin = rig();
    twin.port.claims = [claimView(), newer({ stake_lovelace: SETTINGS.challenge_stake_lovelace })];
    expect((await twin.dispute.challengeDelivery(delivery())).ok).toBe(true);
    expect(twin.port.challenged.map((call) => call.claim)).toEqual([REF_B]);
  });

  it('counts the claims that were left out for each reason in the detail of no_open_claim', async () => {
    const rigged = rig();
    const missing = claimView({ ref: `${'cf'.repeat(32)}#0`, token: `636c6d5f${'0c'.repeat(28)}` });
    rigged.port.claims = [
      claimView({ submitted_at: NOW - 4 * HOUR + 60_000 }),
      claimView({ ref: REF_B, token: TOKEN_B, submitted_at: JOB_BEGAN_AT }),
      claimView({ ref: REF_C, token: TOKEN_C, stake_lovelace: SETTINGS.challenge_stake_lovelace + 1n }),
      missing,
      { ...claimView({ ref: `${'cd'.repeat(32)}#0`, token: `636c6d5f${'0d'.repeat(28)}` }), claim_hash: 'ab'.repeat(32) },
      holding(rigged.port, claimView({ ref: `${'ce'.repeat(32)}#0`, token: `636c6d5f${'0e'.repeat(28)}` }), forCapability('supplychain.rfq.quote.v1').bytes),
      holding(rigged.port, claimView({ ref: `${'c0'.repeat(32)}#0`, token: `636c6d5f${'0f'.repeat(28)}` }), withStatement('This agent answers each request that it takes.').bytes),
    ];
    answering(rigged, missing, NO_DOCUMENT);
    const result = await rigged.dispute.challengeDelivery(delivery());
    expectNotFiled(result, NO_OPEN_CLAIM);
    expect(result.detail).toBe(counted(7, [1, 1, 1, 1, 1, 1, 1]));
    expect(rigged.port.published).toEqual([]);
  });

  it('gives the same target from findOpenClaim, and refuses a scope that is not a scope', async () => {
    const { port, dispute } = rig();
    port.claims = [claimView(), newer({ stake_lovelace: 500_000_000n })];
    expect(await dispute.findOpenClaim(OTHER, SCOPE)).toMatchObject({ ok: true, value: { ref: REF_A } });
    // The claim was submitted an hour before the clock, and the block of the escrow output of the job was made three hours before it.
    port.readEscrowAnswer = () => escrowJob({ block_time_ms: NOW - 3 * HOUR });
    expect(await dispute.findOpenClaim(OTHER, SCOPE)).toMatchObject({ ok: false, code: NO_OPEN_CLAIM });
    for (const bad of [
      null, 'zq9', {}, JOB, { capability_id: ESCROW_CAPABILITY, statement_text: STATEMENT_S1, escrow_ref: ESCROW, job_began_at: JOB_BEGAN_AT }, { ...SCOPE, extra: 1 }, { ...SCOPE, escrow_ref: 'zq9' },
      { ...SCOPE, capability_id: 'zq9 x' }, { ...SCOPE, statement_text: 7 }, { ...SCOPE, statement_text: 'one\ntwo' }, { ...SCOPE, statement_text: '' },
      { ...SCOPE, claim_capability_id: 'zq9 x' }, { ...SCOPE, claim_capability_id: 7 }, { ...SCOPE, claim_capability_id: '' }, { ...SCOPE, buyer_pkhs: [] }, { ...SCOPE, buyer_pkhs: 'zq9' }, { ...SCOPE, buyer_pkhs: [BUYER_PKH, BUYER_PKH] },
    ]) {
      expect(await dispute.findOpenClaim(OTHER, bad as never), JSON.stringify(bad)).toMatchObject({ ok: false, code: 'bad_shape' });
    }
  });
});

describe('an approval challenge names the claim of the sender, which is for another capability than the escrow', () => {
  /** A job that the sender hired this agent for. The escrow names `ESCROW_CAPABILITY`, and the one open claim of the sender is for `SENDER_CAPABILITY`. */
  const hired = (): Rig => {
    const rigged = rig();
    rigged.port.claims = [senderClaimView(rigged.port)];
    rigged.port.readEscrowAnswer = () => hiringMe();
    return rigged;
  };

  it('files the challenge against the claim of the sender when the scope names the capability of that claim, and quotes its statement S1', async () => {
    const rigged = hired();
    const result = await rigged.dispute.challengeApproval(approval());
    if (!result.ok) throw new Error(result.detail);
    expect(result.value.record.claim).toBe(REF_A);
    expect(rigged.port.challenged.map((call) => call.claim)).toEqual([REF_A]);
    const evidence = textOf(rigged.port.published[0]!.bytes);
    expect(evidence).toContain(`Claim: ${REF_A}`);
    expect(evidence).toContain(REORDER_AGENT_S1);
    // The escrow is read one time, and its capability is the capability of the escrow.
    expect(rigged.events.filter((event) => event.startsWith('readEscrow'))).toEqual([`readEscrow ${ESCROW}`]);
  });

  it('finds no target when the scope names the capability of the escrow for the claim of the sender: the claim counts as one for another capability, and nothing is published', async () => {
    const rigged = hired();
    const result = await rigged.dispute.challengeApproval(approval({ claim_capability_id: ESCROW_CAPABILITY }));
    expectNotFiled(result, NO_OPEN_CLAIM);
    expect(result.detail).toBe(counted(1, [0, 0, 0, 0, 0, 1, 0]));
    expect(rigged.port.published).toEqual([]);
    expect(rigged.port.challenged).toEqual([]);
    // The twin: the scope that names the capability of the claim files the same job.
    expect((await rigged.dispute.challengeApproval(approval())).ok).toBe(true);
  });

  it('names the claim for the capability of the sender, and no claim for another capability, although the other claim ends later', async () => {
    const rigged = rig();
    // The decoy is for the capability of the escrow, was staked before the job began, and ends 15 hours after the claim of the sender: with no rule of the scope, it would be the target.
    const decoy = holding(rigged.port, newer(), kitClaimDocument(OTHER).bytes);
    rigged.port.claims = [senderClaimView(rigged.port), decoy];
    rigged.port.readEscrowAnswer = () => hiringMe();
    expect((await rigged.dispute.challengeApproval(approval())).ok).toBe(true);
    expect(rigged.port.challenged.map((call) => call.claim)).toEqual([REF_A]);
    expect(rigged.events.filter((event) => event.startsWith('readDocument'))).toEqual([`readDocument ${decoy.claim_uri}`, `readDocument ${claimView().claim_uri}`]);
  });

  it('keeps the check of the escrow on capability_id: an escrow for the capability of the claim is the escrow of another job', async () => {
    const rigged = hired();
    rigged.port.readEscrowAnswer = () => hiringMe({ capability_id: SENDER_CAPABILITY });
    const result = await rigged.dispute.challengeApproval(approval());
    expectNotFiled(result, 'bad_shape');
    expect(result.detail).toContain('capability_id');
    expect(rigged.events.some((event) => event.startsWith('readDocument'))).toBe(false);
    expect(rigged.port.published).toEqual([]);
  });

  it('gives the same target from findOpenClaim for a scope with claim_capability_id, and finds none when the scope leaves it out', async () => {
    const rigged = hired();
    const scope = { escrow_ref: ESCROW, capability_id: ESCROW_CAPABILITY, claim_capability_id: SENDER_CAPABILITY, statement_text: REORDER_AGENT_S1 };
    expect(await rigged.dispute.findOpenClaim(OTHER, scope)).toMatchObject({ ok: true, value: { ref: REF_A } });
    // A scope with no claim_capability_id takes the capability of the escrow for the claim, as a delivery does.
    const { claim_capability_id: _left, ...single } = scope;
    expect(await rigged.dispute.findOpenClaim(OTHER, single)).toMatchObject({ ok: false, code: NO_OPEN_CLAIM });
  });
});

describe('a claim is a target only when its statement S1 is the statement that the job hired', () => {
  const DECOY_S1 = 'This agent answers each request that it takes.';
  /** A claim of the same capability that was staked before the job began, and that ends later than the claim of the samples. Its statement S1 is another text: the claimer makes the document. */
  const decoyOf = (rigged: Rig): ClaimView => holding(rigged.port, newer(), withStatement(DECOY_S1).bytes);

  it('challenges the claim with the statement of the job, and leaves out a decoy of the same capability that ends later', async () => {
    const rigged = rig();
    const decoy = decoyOf(rigged);
    rigged.port.claims = [claimView(), decoy];
    expect((await rigged.dispute.challengeDelivery(delivery())).ok).toBe(true);
    expect(rigged.port.challenged.map((call) => call.claim)).toEqual([REF_A]);
    expect(textOf(rigged.port.published[0]!.bytes)).toContain(`Statement S1 of the claim reads: "${STATEMENT_S1}"`);
    // The decoy ends later, so it is read first, and the claim with the statement of the job after it.
    expect(rigged.events.filter((event) => event.startsWith('readDocument'))).toEqual([`readDocument ${decoy.claim_uri}`, `readDocument ${claimView().claim_uri}`]);
  });

  it('challenges the decoy when the job hired its statement, as the twin, and the evidence quotes that statement', async () => {
    const rigged = rig();
    rigged.port.claims = [claimView(), decoyOf(rigged)];
    expect((await rigged.dispute.challengeDelivery(delivery({ statement_text: DECOY_S1 }))).ok).toBe(true);
    expect(rigged.port.challenged.map((call) => call.claim)).toEqual([REF_B]);
    expect(textOf(rigged.port.published[0]!.bytes)).toContain(`Statement S1 of the claim reads: "${DECOY_S1}"`);
    expect(textOf(rigged.port.published[0]!.bytes)).not.toContain(STATEMENT_S1);
  });

  it('says no_open_claim and counts the claim when no claim has the statement of the job, and publishes nothing', async () => {
    const rigged = rig();
    rigged.port.claims = [decoyOf(rigged)];
    const result = await rigged.dispute.challengeDelivery(delivery());
    expectNotFiled(result, NO_OPEN_CLAIM);
    expect(result.detail).toBe(counted(1, [0, 0, 0, 0, 0, 0, 1]));
    expect(rigged.port.published).toEqual([]);
    expect(rigged.port.challenged).toEqual([]);
  });

  it('compares the whole text: another case, a character more or less, and another space leave the claim out, and the same text takes it', async () => {
    const variants: Array<[string, string]> = [
      ['another case', STATEMENT_S1.toLowerCase()],
      ['one character more', `${STATEMENT_S1}.`],
      ['one character less', STATEMENT_S1.slice(0, -1)],
      ['another space', STATEMENT_S1.replace('the SKU,', 'the  SKU,')],
      ['another letter', STATEMENT_S1.replace('names', 'name')],
    ];
    for (const [name, statement] of variants) {
      const rigged = rig();
      rigged.port.claims = [claimView()];
      const result = await rigged.dispute.challengeDelivery(delivery({ statement_text: statement }));
      expectNotFiled(result, NO_OPEN_CLAIM);
      expect(result.detail, name).toBe(counted(1, [0, 0, 0, 0, 0, 0, 1]));
      expect(rigged.port.published, name).toEqual([]);
    }
    const twin = rig();
    twin.port.claims = [claimView()];
    expect((await twin.dispute.challengeDelivery(delivery({ statement_text: STATEMENT_S1 }))).ok).toBe(true);
  });

  /** A statement with accented letters: its NFC form and its NFD form are different texts of the same statement. */
  const ACCENTED = 'A confirmation that this agent signs names the SKU, the lot and the quantity of the order that it answers, caf\u00e9 r\u00e8gle.';

  it('takes the same text in NFD and in NFC as one statement, whichever form the claim document or the job has, and quotes it in the same form in the evidence', async () => {
    // The two forms are not the same string.
    expect(ACCENTED.normalize('NFD')).not.toBe(ACCENTED.normalize('NFC'));
    const forms: Array<[string, string, string]> = [
      ['NFD in the claim document and NFC in the job', ACCENTED.normalize('NFD'), ACCENTED.normalize('NFC')],
      ['NFC in the claim document and NFD in the job', ACCENTED.normalize('NFC'), ACCENTED.normalize('NFD')],
      ['NFD in both', ACCENTED.normalize('NFD'), ACCENTED.normalize('NFD')],
      ['NFC in both', ACCENTED.normalize('NFC'), ACCENTED.normalize('NFC')],
    ];
    for (const [name, inDocument, inJob] of forms) {
      const rigged = rig();
      rigged.port.claims = [holding(rigged.port, claimView(), withStatement(inDocument).bytes)];
      expect((await rigged.dispute.challengeDelivery(delivery({ statement_text: inJob }))).ok, name).toBe(true);
      // The evidence writes the statement in the form NFC, and a character that is not printable ASCII as `\u` and four hex digits, whichever form the claim document has.
      const printed = inDocument.normalize('NFC').replace(/[^\x20-\x7e]/g, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
      expect(textOf(rigged.port.published[0]!.bytes), name).toContain(`Statement S1 of the claim reads: "${printed}"`);
      expect(await rigged.dispute.findOpenClaim(OTHER, { ...SCOPE, statement_text: inJob }), name).toMatchObject({ ok: true, value: { ref: REF_A } });
    }
  });

  it('leaves out a claim whose S1 is more than another form of the text of the job: another accent, a homoglyph, a ligature, or a letter more', async () => {
    const others: Array<[string, string]> = [
      ['another accent', ACCENTED.normalize('NFD').replace('e\u0301', 'e\u0300')],
      ['a homoglyph: a Cyrillic letter for a Latin letter', ACCENTED.replace('A confirmation', '\u0410 confirmation')],
      ['a ligature that only a compatibility form folds', ACCENTED.replace('confirmation', 'con\ufb01rmation')],
      ['a letter more', ACCENTED.normalize('NFD').replace('e\u0301', 'ee\u0301')],
    ];
    for (const [name, inDocument] of others) {
      for (const [form, inJob] of [['NFC', ACCENTED.normalize('NFC')], ['NFD', ACCENTED.normalize('NFD')]] as const) {
        const rigged = rig();
        rigged.port.claims = [holding(rigged.port, claimView(), withStatement(inDocument).bytes)];
        const result = await rigged.dispute.challengeDelivery(delivery({ statement_text: inJob }));
        expectNotFiled(result, NO_OPEN_CLAIM);
        expect(result.detail, `${name}, ${form} in the job`).toBe(counted(1, [0, 0, 0, 0, 0, 0, 1]));
        expect(rigged.port.published, name).toEqual([]);
      }
    }
  });

  it('gives the same target from findOpenClaim', async () => {
    const rigged = rig();
    rigged.port.claims = [claimView(), decoyOf(rigged)];
    expect(await rigged.dispute.findOpenClaim(OTHER, SCOPE)).toMatchObject({ ok: true, value: { ref: REF_A } });
    expect(await rigged.dispute.findOpenClaim(OTHER, { ...SCOPE, statement_text: DECOY_S1 })).toMatchObject({ ok: true, value: { ref: REF_B } });
    expect(await rigged.dispute.findOpenClaim(OTHER, { ...SCOPE, statement_text: 'Another statement.' })).toMatchObject({ ok: false, code: NO_OPEN_CLAIM });
  });
});

describe('the job began when the block of its escrow output was made, and the chain says when', () => {
  const began = (blockTime: number) => escrowJob({ block_time_ms: blockTime });

  it('takes a claim that was submitted before the start of the job, and leaves out a claim that was submitted at it or after it: the port gives the start', async () => {
    // The claim of the samples was submitted an hour before the clock.
    for (const [start, filed] of [[NOW - HOUR + 1, true], [NOW - HOUR, false], [NOW - 2 * HOUR, false], [NOW, true]] as const) {
      const rigged = rig();
      rigged.port.claims = [claimView()];
      rigged.port.readEscrowAnswer = () => began(start);
      const result = await rigged.dispute.challengeDelivery(delivery());
      expect(result.ok, String(start)).toBe(filed);
      if (!result.ok) expect(result.detail).toBe(counted(1, [0, 1, 0, 0, 0, 0, 0]));
    }
  });

  it('reads the escrow of the job one time, after the claims and before any claim document, and only when the agent has an open claim', async () => {
    const rigged = rig();
    rigged.port.claims = [claimView(), newer()];
    expect((await rigged.dispute.challengeDelivery(delivery())).ok).toBe(true);
    expect(rigged.events.filter((event) => /^(readClaims|readEscrow|readDocument)/.test(event))).toEqual(['readClaims', `readEscrow ${ESCROW}`, `readDocument ${newer().claim_uri}`]);
    const none = rig();
    none.port.claims = [claimView({ claimer: THIRD })];
    expectNotFiled(await none.dispute.challengeDelivery(delivery()), NO_OPEN_CLAIM);
    expect(none.events).toEqual(['readClaims']);
  });

  it('says bad_shape, and publishes nothing, when the output is no escrow output of the deployment, and does not repeat the text of the port', async () => {
    const rigged = rig();
    rigged.port.claims = [claimView()];
    rigged.port.readEscrowAnswer = () => ({ ok: false, code: 'not_escrow', detail: 'the output is not at the escrow script: see https://koios.example/key-0123456789abcdef' });
    const result = await rigged.dispute.challengeDelivery(delivery());
    expectNotFiled(result, 'bad_shape');
    expect(result.detail).toContain('escrow_ref names no escrow output');
    expect(result.detail).not.toContain('key-0123456789abcdef');
    expect(rigged.port.published).toEqual([]);
    expect(await rigged.dispute.findOpenClaim(OTHER, SCOPE)).toMatchObject({ ok: false, code: 'bad_shape' });
    // The twin: the output is an escrow output, and the same job is filed.
    rigged.port.readEscrowAnswer = () => began(JOB_BEGAN_AT);
    expect((await rigged.dispute.challengeDelivery(delivery())).ok).toBe(true);
  });

  it('says chain_unavailable, and publishes nothing, for a block that is dated after the clock, and takes a block that is dated at the clock', async () => {
    const rigged = rig();
    rigged.port.claims = [claimView()];
    for (const start of [NOW + 1, NOW + 24 * HOUR]) {
      rigged.port.readEscrowAnswer = () => began(start);
      const result = await rigged.dispute.challengeDelivery(delivery());
      expectNotFiled(result, 'chain_unavailable');
      expect(result.detail).toContain('dated after the clock');
      expect(rigged.port.published, String(start)).toEqual([]);
      expect(await rigged.dispute.findOpenClaim(OTHER, SCOPE), String(start)).toMatchObject({ ok: false, code: 'chain_unavailable' });
    }
    rigged.port.readEscrowAnswer = () => began(NOW);
    expect((await rigged.dispute.challengeDelivery(delivery())).ok).toBe(true);
  });

  it('says chain_unavailable, and publishes nothing, when the escrow cannot be read or the port gives a result of a wrong shape, and files the same job when it can be read', async () => {
    const wrong: Array<[string, unknown]> = [
      ['a read that throws', new Error('Koios answered 503 at https://koios.example/secret-key')],
      ['no result', null],
      ['a text', 'text'],
      ['a result with no value', { ok: true }],
      ['a value with no members', { ok: true, value: {} }],
      ['the time of the Post of the datum and no time of the block', { ok: true, value: { ...escrowJob().value, block_time_ms: undefined, posted_at: JOB_BEGAN_AT } }],
      ['a time that is a text', escrowJob({ block_time_ms: String(JOB_BEGAN_AT) as never })],
      ['a time of 0', began(0)],
      ['a time that is not a whole number', began(JOB_BEGAN_AT + 0.5)],
      ['no capability', escrowJob({ capability_id: undefined as never })],
      ['a capability that is a number', escrowJob({ capability_id: 7 as never })],
      ['no agent', escrowJob({ agent_id: undefined as never })],
      ['an agent that is a DID', escrowJob({ agent_id: OTHER })],
      ['an agent in upper case', escrowJob({ agent_id: OTHER_ID.toUpperCase() })],
      ['an agent that is too short', escrowJob({ agent_id: 'c1' })],
      ['no buyer', escrowJob({ buyer_pkh: undefined as never })],
      ['a buyer that is a number', escrowJob({ buyer_pkh: 7 as never })],
      ['no state', escrowJob({ state: undefined as never })],
      ['a state that is a number', escrowJob({ state: 1 as never })],
      ['a refusal with another code', { ok: false, code: 'weird', detail: 'x' }],
      ['a refusal with no detail', { ok: false, code: 'not_escrow' }],
    ];
    for (const [name, answer] of wrong) {
      const rigged = rig();
      rigged.port.claims = [claimView()];
      rigged.port.readEscrowAnswer = () => answer as never;
      const result = await rigged.dispute.challengeDelivery(delivery());
      expectNotFiled(result, 'chain_unavailable');
      expect(result.detail, name).not.toContain('secret-key');
      expect(rigged.port.published, name).toEqual([]);
      expect(await rigged.dispute.findOpenClaim(OTHER, SCOPE), name).toMatchObject({ ok: false, code: 'chain_unavailable' });
      rigged.port.readEscrowAnswer = () => began(JOB_BEGAN_AT);
      expect((await rigged.dispute.challengeDelivery(delivery())).ok, name).toBe(true);
    }
  });

  it('says chain_unavailable when the read of the escrow never answers, with the bound of the settings', async () => {
    const fire = deferred<void>();
    const rigged = rig({ read_timeout_ms: 5_000 }, { sleep: () => fire.promise });
    rigged.port.claims = [claimView()];
    rigged.port.readEscrowJob = () => {
      fire.resolve(undefined);
      return new Promise<never>(() => undefined);
    };
    const result = await rigged.dispute.challengeDelivery(delivery());
    expectNotFiled(result, 'chain_unavailable');
    expect(result.detail).toContain('the escrow of the job did not answer within 5000 ms');
    expect(rigged.port.published).toEqual([]);
  });
});

describe('the escrow is the escrow of this job', () => {
  const OTHER_CAPABILITY = 'supplychain.rfq.quote.v1';

  it('refuses an escrow with another capability than the job, for a delivery, an approval and a lookup, names the member, and publishes nothing', async () => {
    // A text that is not the capability of the job is another capability, whatever its case or its length.
    for (const capability of [OTHER_CAPABILITY, ESCROW_CAPABILITY.toUpperCase(), `${ESCROW_CAPABILITY}.x`, ESCROW_CAPABILITY.slice(0, -1), 'zq9 marker']) {
      const rigged = rig();
      rigged.port.claims = [claimView()];
      rigged.port.readEscrowAnswer = () => escrowJob({ capability_id: capability });
      const delivered = await rigged.dispute.challengeDelivery(delivery());
      expectNotFiled(delivered, 'bad_shape');
      expect(delivered.detail, capability).toContain('capability_id');
      expect(delivered.detail, capability).not.toContain('zq9');
      expect(await rigged.dispute.findOpenClaim(OTHER, SCOPE), capability).toMatchObject({ ok: false, code: 'bad_shape' });
      rigged.port.readEscrowAnswer = () => hiringMe({ capability_id: capability });
      expectNotFiled(await rigged.dispute.challengeApproval(approval()), 'bad_shape');
      expect(rigged.port.published, capability).toEqual([]);
      // The escrow is checked before any claim document is read.
      expect(rigged.events.some((event) => event.startsWith('readDocument')), capability).toBe(false);
    }
    // The twin: the escrow names the capability of the job.
    const twin = rig();
    twin.port.claims = [claimView()];
    expect((await twin.dispute.challengeDelivery(delivery())).ok).toBe(true);
    const approved = rig();
    approved.port.claims = [senderClaimView(approved.port)];
    approved.port.readEscrowAnswer = () => hiringMe();
    expect((await approved.dispute.challengeApproval(approval())).ok).toBe(true);
  });

  it('refuses a delivery for an escrow that names another agent than the counterparty, and says so; the twin that names the counterparty is filed', async () => {
    // This agent hired the counterparty: the datum names the counterparty. It does not name this agent, and it does not name a third agent.
    for (const agent of [THIRD_ID, ME_ID]) {
      const rigged = rig();
      rigged.port.claims = [claimView()];
      rigged.port.readEscrowAnswer = () => escrowJob({ agent_id: agent });
      const result = await rigged.dispute.challengeDelivery(delivery());
      expectNotFiled(result, 'bad_shape');
      expect(result.detail).toContain('agent_id of its datum is not the counterparty');
      expect(result.detail).not.toContain(agent);
      expect(rigged.port.published).toEqual([]);
      expect(rigged.events.some((event) => event.startsWith('readDocument'))).toBe(false);
    }
    const twin = rig();
    twin.port.claims = [claimView()];
    twin.port.readEscrowAnswer = () => escrowJob({ agent_id: OTHER_ID });
    expect((await twin.dispute.challengeDelivery(delivery())).ok).toBe(true);
  });

  it('refuses an approval for an escrow that names another agent than this agent, and says so; the twin that names this agent is filed', async () => {
    // The sender hired this agent: the datum names this agent. It does not name the sender, and it does not name a third agent.
    for (const agent of [THIRD_ID, OTHER_ID]) {
      const rigged = rig();
      rigged.port.claims = [claimView()];
      rigged.port.readEscrowAnswer = () => escrowJob({ agent_id: agent });
      const result = await rigged.dispute.challengeApproval(approval());
      expectNotFiled(result, 'bad_shape');
      expect(result.detail).toContain('agent_id of its datum is not this agent');
      expect(result.detail).not.toContain(agent);
      expect(rigged.port.published).toEqual([]);
      expect(rigged.events.some((event) => event.startsWith('readDocument'))).toBe(false);
    }
    const twin = rig();
    twin.port.claims = [senderClaimView(twin.port)];
    twin.port.readEscrowAnswer = () => hiringMe();
    expect((await twin.dispute.challengeApproval(approval())).ok).toBe(true);
  });

  it('refuses an escrow of the legacy layout, which names no agent, for a delivery, an approval and a lookup, and publishes nothing', async () => {
    const rigged = rig();
    rigged.port.claims = [claimView()];
    rigged.port.readEscrowAnswer = () => escrowJob({ agent_id: null });
    for (const result of [await rigged.dispute.challengeDelivery(delivery()), await rigged.dispute.challengeApproval(approval())]) {
      expectNotFiled(result, 'bad_shape');
      expect(result.detail).toContain('legacy layout');
      expect(result.detail).toContain('agent_id');
    }
    expect(await rigged.dispute.findOpenClaim(OTHER, SCOPE)).toMatchObject({ ok: false, code: 'bad_shape' });
    expect(rigged.port.published).toEqual([]);
    // The twin: the escrow of the identity layout that names the counterparty.
    rigged.port.readEscrowAnswer = () => escrowJob();
    expect((await rigged.dispute.challengeDelivery(delivery())).ok).toBe(true);
  });

  it('refuses an output that a later step of the escrow made, for a delivery, an approval and a lookup, says to name the output of the Post, and publishes nothing', async () => {
    // The claim of the samples was staked 10 minutes ago, after the job began 30 minutes ago, so it does not cover the job. A later step was made 5 minutes ago: a start from its block would make the claim a target.
    const later = { block_time_ms: NOW - 5 * 60_000 };
    for (const state of ['Claimed', 'Submitted', 'Accepted', 'Reclaimed', 'Released'] as const) {
      const rigged = rig();
      rigged.port.claims = [claimView({ submitted_at: NOW - 10 * 60_000 })];
      rigged.port.readEscrowAnswer = () => escrowJob({ ...later, state });
      const delivered = await rigged.dispute.challengeDelivery(delivery());
      expectNotFiled(delivered, 'bad_shape');
      expect(delivered.detail, state).toContain('the state of its datum is not Open');
      expect(delivered.detail, state).toContain('Name the output that the Post made');
      expect(delivered.detail, state).not.toContain(state);
      rigged.port.readEscrowAnswer = () => hiringMe({ ...later, state });
      expectNotFiled(await rigged.dispute.challengeApproval(approval()), 'bad_shape');
      expect(await rigged.dispute.findOpenClaim(OTHER, SCOPE), state).toMatchObject({ ok: false, code: 'bad_shape' });
      expect(rigged.port.published, state).toEqual([]);
      // The escrow is checked before any claim document is read.
      expect(rigged.events.some((event) => event.startsWith('readDocument')), state).toBe(false);
    }
    // The twin: the same block and the state Open. Only the state differs, and the claim is a target for this start.
    const twin = rig();
    twin.port.claims = [claimView({ submitted_at: NOW - 10 * 60_000 })];
    twin.port.readEscrowAnswer = () => escrowJob(later);
    expect((await twin.dispute.challengeDelivery(delivery())).ok).toBe(true);
  });

  it('names the first member that is wrong: the layout, then the capability, then the agent, then the buyer, then the state and the time', async () => {
    const rigged = rig();
    rigged.port.claims = [claimView()];
    rigged.port.readEscrowAnswer = () => escrowJob({ agent_id: null, capability_id: OTHER_CAPABILITY });
    const legacy = await rigged.dispute.challengeDelivery(delivery());
    expectNotFiled(legacy, 'bad_shape');
    expect(legacy.detail).toContain('legacy layout');
    rigged.port.readEscrowAnswer = () => escrowJob({ agent_id: THIRD_ID, capability_id: OTHER_CAPABILITY });
    const capability = await rigged.dispute.challengeDelivery(delivery());
    expectNotFiled(capability, 'bad_shape');
    expect(capability.detail).toContain('capability_id');
    expect(capability.detail).not.toContain('agent_id');
    rigged.port.readEscrowAnswer = () => escrowJob({ agent_id: THIRD_ID, state: 'Submitted' });
    const agent = await rigged.dispute.challengeDelivery(delivery());
    expectNotFiled(agent, 'bad_shape');
    expect(agent.detail).toContain('agent_id');
    expect(agent.detail).not.toContain('state');
    rigged.port.readEscrowAnswer = () => escrowJob({ buyer_pkh: OTHER_BUYER_PKH, state: 'Submitted', block_time_ms: NOW + 1 });
    const buyer = await rigged.dispute.challengeDelivery(delivery());
    expectNotFiled(buyer, 'bad_shape');
    expect(buyer.detail).toContain('buyer_pkhs');
    expect(buyer.detail).not.toContain('state');
    expect(buyer.detail).not.toContain('clock');
    rigged.port.readEscrowAnswer = () => escrowJob({ state: 'Submitted' });
    const state = await rigged.dispute.challengeDelivery(delivery());
    expectNotFiled(state, 'bad_shape');
    expect(state.detail).toContain('the state of its datum');
  });

  it('gives the lookup the agent of the lookup or this agent as the agent of the escrow, and no other agent', async () => {
    for (const [agent, found] of [[OTHER_ID, true], [ME_ID, true], [THIRD_ID, false]] as const) {
      const { port, dispute } = rig();
      port.claims = [claimView()];
      port.readEscrowAnswer = () => escrowJob({ agent_id: agent });
      const result = await dispute.findOpenClaim(OTHER, SCOPE);
      expect(result.ok, agent).toBe(found);
      if (!result.ok) expect(result).toMatchObject({ code: 'bad_shape', detail: expect.stringContaining('is not the agent of the lookup or this agent') as never });
    }
  });

  it('does not let the escrow of a newer job for another capability or another agent widen the choice of the target', async () => {
    // The claim was staked 10 minutes ago, after the job began 30 minutes ago, so it does not cover the job. A job that began a minute ago would be covered.
    const newerJob = { block_time_ms: NOW - 60_000 };
    for (const [name, other] of [['another capability', { capability_id: OTHER_CAPABILITY }], ['another agent', { agent_id: THIRD_ID }], ['another buyer', { buyer_pkh: OTHER_BUYER_PKH }]] as const) {
      const rigged = rig();
      rigged.port.claims = [claimView({ submitted_at: NOW - 10 * 60_000 })];
      rigged.port.readEscrowAnswer = (ref) => escrowJob(ref === ESCROW ? {} : { ...newerJob, ...other });
      expectNotFiled(await rigged.dispute.challengeDelivery(delivery()), NO_OPEN_CLAIM);
      expectNotFiled(await rigged.dispute.challengeDelivery(delivery({ escrow_ref: ESCROW_2 })), 'bad_shape');
      expect(rigged.port.published, name).toEqual([]);
    }
  });
});

describe('the escrow is the escrow of a buyer that the caller names', () => {
  /** A key that is none of the keys of the samples: the datum of the escrow of a third buyer names it. */
  const THIRD_BUYER_PKH = 'b9'.repeat(28);
  const KEYS = [BUYER_PKH, OTHER_BUYER_PKH];

  it('files a delivery when the buyer of the escrow is one of the keys of the list, whichever key it is and wherever it stands in the list', async () => {
    for (const keys of [KEYS, [...KEYS].reverse(), [BUYER_PKH]]) {
      for (const buyer of KEYS.filter((key) => keys.includes(key))) {
        const rigged = rig();
        rigged.port.claims = [claimView()];
        rigged.port.readEscrowAnswer = () => escrowJob({ buyer_pkh: buyer });
        expect((await rigged.dispute.challengeDelivery(delivery({ buyer_pkhs: keys }))).ok, `${buyer} in a list of ${keys.length}`).toBe(true);
        expect(rigged.port.challenged.map((call) => call.claim)).toEqual([REF_A]);
      }
    }
  });

  it('refuses a delivery for the escrow of another buyer, names the member buyer_pkhs, never repeats a key, and reads no claim document', async () => {
    for (const keys of [[BUYER_PKH], KEYS]) {
      const rigged = rig();
      rigged.port.claims = [claimView()];
      rigged.port.readEscrowAnswer = () => escrowJob({ buyer_pkh: THIRD_BUYER_PKH });
      const result = await rigged.dispute.challengeDelivery(delivery({ buyer_pkhs: keys }));
      expectNotFiled(result, 'bad_shape');
      expect(result.detail).toContain('buyer_pkhs');
      for (const key of [...KEYS, THIRD_BUYER_PKH]) expect(result.detail).not.toContain(key);
      expect(rigged.port.published).toEqual([]);
      expect(rigged.port.challenged).toEqual([]);
      expect(rigged.events.some((event) => event.startsWith('readDocument'))).toBe(false);
      // The twin: the escrow names a key of the list, and the same job is filed.
      rigged.port.readEscrowAnswer = () => escrowJob({ buyer_pkh: BUYER_PKH });
      expect((await rigged.dispute.challengeDelivery(delivery({ buyer_pkhs: keys }))).ok).toBe(true);
    }
  });

  it('refuses an approval, and a lookup that names its buyer, for the escrow of another buyer in the same way; the twins are filed and found', async () => {
    const rigged = rig();
    rigged.port.claims = [senderClaimView(rigged.port)];
    const lookup = { escrow_ref: ESCROW, ...APPROVAL_JOB };
    rigged.port.readEscrowAnswer = () => hiringMe({ buyer_pkh: OTHER_BUYER_PKH });
    const approved = await rigged.dispute.challengeApproval(approval());
    const looked = await rigged.dispute.findOpenClaim(OTHER, lookup);
    for (const result of [approved, looked]) expect(result).toMatchObject({ ok: false, code: 'bad_shape', detail: expect.stringContaining('buyer_pkhs') as never });
    expect(JSON.stringify([approved, looked])).not.toContain(OTHER_BUYER_PKH);
    expect(JSON.stringify([approved, looked])).not.toContain(BUYER_PKH);
    expect(rigged.port.published).toEqual([]);
    // The twins: the escrow names the buyer of the job.
    rigged.port.readEscrowAnswer = () => hiringMe();
    expect((await rigged.dispute.challengeApproval(approval())).ok).toBe(true);
    expect(await rigged.dispute.findOpenClaim(OTHER, lookup)).toMatchObject({ ok: true, value: { ref: REF_A } });
  });

  it('compares the key of the datum as text: a key in another case, of another length, or that is no key is another buyer', async () => {
    for (const buyer of [BUYER_PKH.toUpperCase(), BUYER_PKH.slice(2), `${BUYER_PKH}00`, `${BUYER_PKH.slice(0, 54)}zq`, '']) {
      const rigged = rig();
      rigged.port.claims = [claimView()];
      rigged.port.readEscrowAnswer = () => escrowJob({ buyer_pkh: buyer });
      const result = await rigged.dispute.challengeDelivery(delivery());
      expectNotFiled(result, 'bad_shape');
      expect(result.detail, buyer).toContain('buyer_pkhs');
      if (buyer !== '') expect(result.detail, buyer).not.toContain(buyer);
      expect(rigged.port.published, buyer).toEqual([]);
    }
  });

  it('leaves the lookup that names no buyer as it was, so that the escrow of any buyer is the escrow of the lookup, and binds the lookup that names one', async () => {
    for (const buyer of [BUYER_PKH, OTHER_BUYER_PKH, THIRD_BUYER_PKH]) {
      const { port, dispute } = rig();
      port.claims = [claimView()];
      port.readEscrowAnswer = () => escrowJob({ buyer_pkh: buyer });
      expect(await dispute.findOpenClaim(OTHER, SCOPE), buyer).toMatchObject({ ok: true, value: { ref: REF_A } });
      expect((await dispute.findOpenClaim(OTHER, { ...SCOPE, buyer_pkhs: [BUYER_PKH] })).ok, buyer).toBe(buyer === BUYER_PKH);
      expect((await dispute.findOpenClaim(OTHER, { ...SCOPE, buyer_pkhs: KEYS })).ok, buyer).toBe(buyer !== THIRD_BUYER_PKH);
    }
  });
});

describe('a claim document that the claimer can spoil is left out, and a source that cannot be read is chain_unavailable', () => {
  it('leaves out a newer claim whose document the source does not find, when the source has the claim, and challenges the older claim of this kit', async () => {
    const rigged = rig();
    const spoiled = newer();
    rigged.port.claims = [claimView(), spoiled];
    answering(rigged, spoiled, NO_TRANSACTION);
    expect((await rigged.dispute.challengeDelivery(delivery())).ok).toBe(true);
    expect(rigged.port.challenged.map((call) => call.claim)).toEqual([REF_A]);
    // The source was asked for the claim that holds the missing document, and the claim was left out.
    expect(rigged.events.filter((event) => /^(readDocument|isIndexed)/.test(event))).toEqual([`readDocument ${spoiled.claim_uri}`, `isIndexed ${REF_B}`, `readDocument ${claimView().claim_uri}`]);
  });

  it('says chain_unavailable when the source does not find the document and does not have the claim, or cannot say, and files the same job when it has the claim', async () => {
    const answers: Array<[string, () => unknown]> = [['a source that is behind', () => false], ['a source that fails', () => new Error('Koios answered 503')], ['an answer that is not true or false', () => 'yes']];
    for (const [name, answer] of answers) {
      const rigged = rig();
      const spoiled = newer();
      rigged.port.claims = [claimView(), spoiled];
      answering(rigged, spoiled, NO_TRANSACTION);
      rigged.port.isIndexedAnswer = answer as never;
      expectNotFiled(await rigged.dispute.challengeDelivery(delivery()), 'chain_unavailable');
      expect(rigged.port.published, name).toEqual([]);
      // The twin: the source has the claim now, and the job was not used up.
      rigged.port.isIndexedAnswer = () => true;
      expect((await rigged.dispute.challengeDelivery(delivery())).ok, name).toBe(true);
    }
  });

  it('leaves out a claim whose transaction carries no document without asking whether the source has the claim, and challenges the older claim', async () => {
    const rigged = rig();
    const spoiled = newer();
    rigged.port.claims = [claimView(), spoiled];
    answering(rigged, spoiled, NO_DOCUMENT);
    expect((await rigged.dispute.challengeDelivery(delivery())).ok).toBe(true);
    expect(rigged.port.challenged.map((call) => call.claim)).toEqual([REF_A]);
    expect(rigged.events.some((event) => event.startsWith('isIndexed'))).toBe(false);
  });

  it('says no_open_claim and counts the claim when the only claim has no document on chain, for each kind of absence', async () => {
    for (const absent of [NO_TRANSACTION, NO_DOCUMENT]) {
      const rigged = rig();
      rigged.port.claims = [claimView()];
      answering(rigged, claimView(), absent);
      const result = await rigged.dispute.challengeDelivery(delivery());
      expectNotFiled(result, NO_OPEN_CLAIM);
      expect(result.detail).toBe(counted(1, [0, 0, 0, 1, 0, 0, 0]));
      expect(rigged.port.published).toEqual([]);
    }
  });

  it('says chain_unavailable for a result of a read of a document that is not in the form of the port, and accepts the form as the twin', async () => {
    const plain = { bytes: kitClaimDocument(OTHER).bytes, type: 'claim', media_type: 'text/plain' };
    const shapes: unknown[] = [
      { ok: true }, { ok: true, value: 'text' }, { ok: true, value: { bytes: 'text', type: 'claim', media_type: 'text/plain' } }, { ok: false, code: 'weird', detail: 'x' },
      { ok: false, code: 'no_document' }, { ok: 'yes', value: plain }, plain, null, 'text',
    ];
    for (const shape of shapes) {
      const rigged = rig();
      rigged.port.claims = [claimView()];
      rigged.port.readDocument = async () => shape as never;
      expectNotFiled(await rigged.dispute.challengeDelivery(delivery()), 'chain_unavailable');
      expect(rigged.port.published).toEqual([]);
    }
    const twin = rig();
    twin.port.claims = [claimView()];
    twin.port.readDocument = async () => ({ ok: true, value: plain });
    expect((await twin.dispute.challengeDelivery(delivery())).ok).toBe(true);
  });
});

describe('the newest open claim of the other party is the target', () => {
  /** An open claim of the other party that ends `left` milliseconds after the clock: it was submitted an hour before the clock, before the job began, with a window of `left` and that hour. */
  const endingIn = (ref: string, token: string, left: number): ClaimView => claimView({ ref, token, submitted_at: NOW - HOUR, challenge_window_ms: left + HOUR });
  const EARLIER = endingIn(REF_B, TOKEN_B, 2 * HOUR);
  const LATER = endingIn(REF_A, TOKEN_A, 3 * HOUR);
  const LATEST = endingIn(REF_C, TOKEN_C, 4 * HOUR);

  it('challenges the open claim with the latest challenge deadline, whatever the order of the list, and the evidence names that claim', async () => {
    for (const claims of [[EARLIER, LATER, LATEST], [LATEST, EARLIER, LATER], [LATER, LATEST, EARLIER]]) {
      const { events, port, dispute } = rig();
      port.claims = claims;
      const result = await dispute.challengeDelivery(delivery());
      expect(result.ok).toBe(true);
      expect(port.challenged.map((call) => call.claim)).toEqual([REF_C]);
      expect(port.challenged[0]!.claim_token).toBe(TOKEN_C);
      expect(textOf(port.published[0]!.bytes)).toContain(`Claim: ${REF_C}`);
      expect(textOf(port.published[0]!.bytes)).not.toContain(REF_A);
      // The second read compares with the claim that was chosen, and no other.
      expect(events.filter((event) => event.startsWith('readClaim '))).toEqual([`readClaim ${REF_C}`]);
      // Only the newest claim is read for its document, because it is a claim of this kit.
      expect(events.filter((event) => event.startsWith('readDocument'))).toEqual([`readDocument ${LATEST.claim_uri}`]);
    }
  });

  it('takes the deadline and not the moment of the submit: a claim that was staked earlier with a longer window is the newer target', async () => {
    const { port, dispute } = rig();
    const staked_earlier = claimView({ ref: REF_B, token: TOKEN_B, submitted_at: NOW - 5 * HOUR, challenge_window_ms: 24 * HOUR });
    const staked_later = claimView({ ref: REF_A, token: TOKEN_A, submitted_at: NOW - HOUR, challenge_window_ms: 4 * HOUR });
    port.claims = [staked_later, staked_earlier];
    expect((await dispute.challengeDelivery(delivery())).ok).toBe(true);
    expect(port.challenged.map((call) => call.claim)).toEqual([REF_B]);
  });

  it('takes the claim with the lowest claim token when two claims of this kit have the same latest challenge deadline, whatever the order of the list', async () => {
    // The lowest token is on the highest reference, so the choice is not the order of the references.
    const same = [endingIn(REF_A, TOKEN_C, 3 * HOUR), endingIn(REF_B, TOKEN_B, 3 * HOUR), endingIn(REF_C, TOKEN_A, 3 * HOUR)];
    for (const claims of [same, [...same].reverse(), [same[1]!, same[2]!, same[0]!], [EARLIER, ...same]]) {
      const { events, port, dispute } = rig();
      port.claims = claims;
      expect((await dispute.challengeDelivery(delivery())).ok).toBe(true);
      expect(port.challenged.map((call) => call.claim)).toEqual([REF_C]);
      expect(port.challenged[0]!.claim_token).toBe(TOKEN_A);
      // The documents are read in the order of the choice, and the first target ends the search.
      expect(events.filter((event) => event.startsWith('readDocument'))).toEqual([`readDocument ${same[2]!.claim_uri}`]);
    }
  });

  it('takes the next claim in the order of the choice when the claim with the lowest token is not a target, and a tie below the newest claim changes nothing', async () => {
    const lower = rig();
    lower.port.claims = [endingIn(REF_A, TOKEN_A, 2 * HOUR), endingIn(REF_B, TOKEN_B, 2 * HOUR), LATEST];
    expect((await lower.dispute.challengeDelivery(delivery())).ok).toBe(true);
    expect(lower.port.challenged.map((call) => call.claim)).toEqual([REF_C]);
    const skipped = rig();
    skipped.port.claims = [endingIn(REF_B, TOKEN_B, 3 * HOUR), { ...endingIn(REF_A, TOKEN_A, 3 * HOUR), claim_hash: 'ab'.repeat(32) }];
    expect((await skipped.dispute.challengeDelivery(delivery())).ok).toBe(true);
    expect(skipped.port.challenged.map((call) => call.claim)).toEqual([REF_B]);
  });

  it('takes the next claim when the newest claim is not a claim of this kit, and says chain_unavailable when its document cannot be read', async () => {
    const skipped = rig();
    skipped.port.claims = [{ ...LATEST, claim_hash: 'ab'.repeat(32) }, LATER, EARLIER];
    expect((await skipped.dispute.challengeDelivery(delivery())).ok).toBe(true);
    expect(skipped.port.challenged.map((call) => call.claim)).toEqual([REF_A]);
    // The newest claim cannot be read: the code does not go on to an older claim, because the newest claim could be a claim of this kit.
    const unreadable = rig();
    unreadable.port.claims = [LATEST, LATER];
    const normal = unreadable.port.readDocumentAnswer;
    unreadable.port.readDocumentAnswer = (uri) => (uri === LATEST.claim_uri ? new Error('down') : normal(uri));
    expectNotFiled(await unreadable.dispute.challengeDelivery(delivery()), 'chain_unavailable');
    expect(unreadable.port.published).toEqual([]);
  });

  it('says how many open claims were left out and why when none can be challenged', async () => {
    const { port, dispute } = rig();
    port.claims = [{ ...LATEST, claim_hash: 'ab'.repeat(32) }, { ...LATER, claim_uri: 'https://example.org/c' }, claimView({ ref: REF_B, token: TOKEN_B, submitted_at: NOW - 4 * HOUR + 60_000 })];
    const result = await dispute.challengeDelivery(delivery());
    expectNotFiled(result, NO_OPEN_CLAIM);
    expect(result.detail).toBe(counted(3, [1, 0, 0, 0, 2, 0, 0]));
  });

  it('gives the newest claim of this kit from findOpenClaim, and the claim with the lowest token for claims that end at the same moment', async () => {
    const { port, dispute } = rig();
    port.claims = [EARLIER, LATER, LATEST];
    expect(await dispute.findOpenClaim(OTHER, SCOPE)).toMatchObject({ ok: true, value: { ref: REF_C } });
    port.claims = [{ ...LATEST, claim_hash: 'ab'.repeat(32) }, LATER];
    expect(await dispute.findOpenClaim(OTHER, SCOPE)).toMatchObject({ ok: true, value: { ref: REF_A } });
    port.claims = [EARLIER, { ...EARLIER, ref: REF_C, token: TOKEN_C }];
    expect(await dispute.findOpenClaim(OTHER, SCOPE)).toMatchObject({ ok: true, value: { token: TOKEN_B } });
  });

  it('files no challenge when the claim that was chosen changed at the second read, and the evidence landed', async () => {
    const { port, dispute } = rig();
    port.claims = [EARLIER, LATEST];
    port.readClaimAnswer = (ref) => (ref === REF_C ? { ...LATEST, state: 'Challenged' } : null);
    const result = await dispute.challengeDelivery(delivery());
    expectNotFiled(result, 'claim_changed');
    expect(result.evidence).toMatchObject({ tx_hash: EVIDENCE_TX });
    expect(port.challenged).toEqual([]);
  });
});

describe('the window that is left is checked in the job of the queue, right before the publish', () => {
  /** A dispute over a queue that lets `wait` milliseconds pass before its first job runs, as a queue with other jobs in it does. The later jobs run at once. */
  function rigWithWait(wait: number, settings = {}) {
    const holder: { rigged?: Rig; waited: boolean } = { waited: false };
    const queue = {
      run: async <T>(job: () => Promise<T>): Promise<T> => {
        if (!holder.waited) {
          holder.waited = true;
          holder.rigged!.time.now += wait;
          holder.rigged!.events.push(`waited ${wait}`);
        }
        return job();
      },
    };
    holder.rigged = rig(settings, { queue });
    return holder.rigged;
  }

  it('publishes nothing when the wait for the queue used the window, and says claim_window_closing', async () => {
    // 20 minutes are left at the lookup, which is more than the 10 minutes that the evidence needs. The queue makes the job wait 30 minutes.
    const rigged = rigWithWait(30 * 60_000);
    rigged.port.claims = [claimView({ submitted_at: NOW - 4 * HOUR + 20 * 60_000 })];
    const result = await rigged.dispute.challengeDelivery(delivery());
    expectNotFiled(result, 'claim_window_closing');
    expect(result).toMatchObject({ evidence: null, sent: null });
    expect(rigged.port.published).toEqual([]);
    expect(rigged.port.challenged).toEqual([]);
    // The check comes after the wait for the queue: the job started, and the publish did not follow.
    expect(rigged.events).toEqual(['readClaims', `readEscrow ${ESCROW}`, expect.stringContaining('readDocument'), 'waited 1800000']);
    // The job is free: nothing was sent, and the claim can be challenged again while its window is open.
    rigged.time.now = NOW;
    const retry = rig();
    retry.port.claims = rigged.port.claims;
    expect((await retry.dispute.challengeDelivery(delivery())).ok).toBe(true);
  });

  it('publishes when the wait leaves exactly the least window, and not when it leaves one millisecond less', async () => {
    const exact = rigWithWait(10 * 60_000);
    exact.port.claims = [claimView({ submitted_at: NOW - 4 * HOUR + 20 * 60_000 })];
    expect((await exact.dispute.challengeDelivery(delivery())).ok).toBe(true);
    const short = rigWithWait(10 * 60_000 + 1);
    short.port.claims = [claimView({ submitted_at: NOW - 4 * HOUR + 20 * 60_000 })];
    expectNotFiled(await short.dispute.challengeDelivery(delivery()), 'claim_window_closing');
    expect(short.port.published).toEqual([]);
  });

  it('frees the job after claim_window_closing, so that the same job can be filed again', async () => {
    const holder: { wait: number } = { wait: 30 * 60_000 };
    const state: { rigged?: Rig } = {};
    const queue = { run: async <T>(job: () => Promise<T>): Promise<T> => { state.rigged!.time.now += holder.wait; return job(); } };
    state.rigged = rig({}, { queue });
    const { port, dispute, time } = state.rigged;
    port.claims = [claimView({ submitted_at: NOW - 4 * HOUR + 20 * 60_000 })];
    expectNotFiled(await dispute.challengeDelivery(delivery()), 'claim_window_closing');
    // The claim is staked again with a longer window, and the wait is short: the same job is filed.
    time.now = NOW;
    holder.wait = 0;
    port.claims = [claimView({ submitted_at: NOW - 4 * HOUR + 20 * 60_000, challenge_window_ms: 24 * HOUR })];
    expect((await dispute.challengeDelivery(delivery())).ok).toBe(true);
  });

  it('keeps the check of the claim before the challenge: a window that ended while the evidence confirmed gives claim_changed', async () => {
    const rigged = rig();
    rigged.port.claims = [claimView({ submitted_at: NOW - 4 * HOUR + 15 * 60_000 })];
    const publish = rigged.port.publishAnswer;
    rigged.port.publishAnswer = (call) => {
      rigged.time.now += 20 * 60_000;
      return publish(call);
    };
    const result = await rigged.dispute.challengeDelivery(delivery());
    expectNotFiled(result, 'claim_changed');
    expect(result.evidence).not.toBeNull();
  });

  it('says port_error with nothing sent when the clock fails inside the job, and the job is free', async () => {
    const calls: { count: number } = { count: 0 };
    const port = new ScriptedPort();
    port.claims = [claimView()];
    // The lookup reads the clock once. The check in the job is the second read, and it fails.
    const dispute = new Dispute({
      port, queue: new RecordingQueue([]), sleep: never, settings: SETTINGS, clock: () => { calls.count += 1; return calls.count === 2 ? Number.NaN : NOW; },
    });
    const result = await dispute.challengeDelivery(delivery());
    expectNotFiled(result, 'port_error');
    expect(result.detail).toContain('nothing was sent');
    expect(port.published).toEqual([]);
    expect((await dispute.challengeDelivery(delivery())).ok).toBe(true);
  });
});
