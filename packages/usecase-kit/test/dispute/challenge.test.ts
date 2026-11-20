// packages/usecase-kit/test/dispute/challenge.test.ts: the challenge of a buyer-side agent and of a counterparty, on a scripted chain port. The question of these tests: is a challenge ever filed with no
// evidence document, or against the wrong claim? Each refusal has an accepted twin.
import { setImmediate as tick } from 'node:timers/promises';
import { describe, expect, it, vi } from 'vitest';
import { documentHash } from '@vsa/buyer-core';
import { NO_OPEN_CLAIM, RESULT_SCHEMA, exitStateOf } from '@vsa/usecase-kit/protocol';
import type { EscalatedResult, UnfiledDisputeResult } from '@vsa/usecase-kit/protocol';
import { Dispute, disputedFields } from '@vsa/usecase-kit/dispute';
import type { ApprovalChallengeInput, ChallengeResult, ClaimView, DeliveryChallengeInput, DisputeSettings } from '@vsa/usecase-kit/dispute';
import {
  CHALLENGE_TX, DIGEST_FACTS, ESCROW, ESCROW_2, EVIDENCE_TX, HOUR, ME, MISMATCH, ORDER_FACTS, OTHER, QUOTE_FACTS, RecordingQueue, REF_A, REF_B, REF_C, ScriptedPort, THIRD, TOKEN_A, TOKEN_B, TOKEN_C, NOW,
  claimView,
} from './support.ts';
import type { Events } from './support.ts';

interface Rig {
  readonly events: Events;
  readonly port: ScriptedPort;
  readonly dispute: Dispute;
  readonly logs: string[];
  readonly time: { now: number };
}

function rig(settings: Partial<DisputeSettings> = {}): Rig {
  const events: Events = [];
  const port = new ScriptedPort(events);
  const time = { now: NOW };
  const logs: string[] = [];
  const dispute = new Dispute({
    port, queue: new RecordingQueue(events), clock: () => time.now, log: (line) => logs.push(line),
    settings: { challenge_stake_lovelace: 50_000_000n, resolution_deadline_ms: 72 * HOUR, min_window_left_ms: 10 * 60_000, ...settings },
  });
  return { events, port, dispute, logs, time };
}

const delivery = (extra: Partial<DeliveryChallengeInput> = {}): DeliveryChallengeInput => ({ counterparty: OTHER, escrow_ref: ESCROW, evidence: ORDER_FACTS, ...extra });
const approval = (extra: Partial<ApprovalChallengeInput> = {}): ApprovalChallengeInput => ({ sender: OTHER, escrow_ref: ESCROW, evidence: DIGEST_FACTS, ...extra });

/** The chain after a challenge: the claim that the challenge spent is Challenged, so it is no longer open. */
function challengeChangesTheClaim(port: ScriptedPort): void {
  const answer = port.openChallengeAnswer;
  port.openChallengeAnswer = (call) => {
    port.claims = port.claims.map((claim) => (claim.ref === call.claim ? { ...claim, state: 'Challenged' } : claim));
    return answer(call);
  };
}

const textOf = (bytes: Uint8Array): string => Buffer.from(bytes).toString('utf8');

function expectNotFiled(result: ChallengeResult, code: string): asserts result is Extract<ChallengeResult, { ok: false }> {
  expect(result).toMatchObject({ ok: false, code });
}

describe('a challenge is never built before the evidence document is confirmed', () => {
  it('publishes the evidence, waits for its confirmation, and then challenges, each transaction in the queue', async () => {
    const { events, port, dispute } = rig();
    port.claims = [claimView()];
    const result = await dispute.challengeDelivery(delivery());
    expect(result.ok).toBe(true);
    expect(events).toEqual(['readClaims', 'queue:start', 'publish evidence', 'queue:end', 'queue:start', `readClaim ${REF_A}`, `openChallenge ${REF_A}`, 'queue:end']);
    // The challenge holds the hash and the URI of the evidence document that the port confirmed, and the document is the one that names the claim.
    const [published] = port.published;
    const [challenged] = port.challenged;
    expect(published!.type).toBe('evidence');
    expect(challenged!.evidence_hash).toBe(documentHash(published!.bytes));
    expect(challenged!.evidence_uri).toBe(`vector-tx:${EVIDENCE_TX.slice(0, 43)}`);
    expect(textOf(published!.bytes)).toContain(`Claim: ${REF_A}`);
    expect(challenged).toMatchObject({ claim: REF_A, claim_token: TOKEN_A, stake_lovelace: 50_000_000n, resolution_deadline_ms: 72 * HOUR });
  });

  it('does not build the challenge while the evidence is not confirmed, and builds it when the confirmation comes', async () => {
    const { port, dispute } = rig();
    port.claims = [claimView()];
    const release = port.holdPublish();
    const pending = dispute.challengeDelivery(delivery());
    await tick();
    await tick();
    expect(port.published.length).toBe(1);
    expect(port.challenged.length).toBe(0);
    release();
    const result = await pending;
    expect(result.ok).toBe(true);
    expect(port.challenged.length).toBe(1);
  });

  it('files no challenge when the evidence is sent and not seen confirmed, and says that it can still land', async () => {
    const { events, port, dispute } = rig();
    port.claims = [claimView()];
    port.publishAnswer = () => ({ ok: false, code: 'not_confirmed', detail: 'not seen confirmed', tx_hash: EVIDENCE_TX, valid_to: NOW + HOUR, may_land: true });
    const result = await dispute.challengeDelivery(delivery());
    expectNotFiled(result, 'evidence_not_confirmed');
    expect(result.evidence).toBeNull();
    expect(result.sent).toEqual({ tx_hash: EVIDENCE_TX, valid_to: NOW + HOUR, may_land: true });
    expect(port.challenged).toEqual([]);
    expect(events.some((event) => event.startsWith('openChallenge'))).toBe(false);
  });

  it('files no challenge when the evidence is not built, and the job may be tried again', async () => {
    const { port, dispute } = rig();
    port.claims = [claimView()];
    const normal = port.publishAnswer;
    port.publishAnswer = () => ({ ok: false, code: 'not_built', detail: 'the wallet has no collateral' });
    const first = await dispute.challengeDelivery(delivery());
    expectNotFiled(first, 'evidence_not_built');
    expect(first).toMatchObject({ evidence: null, sent: null });
    expect(port.challenged).toEqual([]);
    // The twin: the port recovers, and the same job is filed.
    port.publishAnswer = normal;
    const again = await dispute.challengeDelivery(delivery());
    expect(again.ok).toBe(true);
    expect(port.challenged.length).toBe(1);
  });

  it('files no challenge when the port throws while it publishes the evidence, and the job is not tried again', async () => {
    const { port, dispute } = rig();
    port.claims = [claimView()];
    port.publishAnswer = () => { throw new Error('the port failed'); };
    const result = await dispute.challengeDelivery(delivery());
    expectNotFiled(result, 'port_error');
    expect(port.challenged).toEqual([]);
    expect(await dispute.challengeDelivery(delivery())).toMatchObject({ ok: false, code: 'job_already_disputed' });
  });

  it('files no challenge when the port published a document with another hash than the evidence', async () => {
    const { port, dispute } = rig();
    port.claims = [claimView()];
    port.publishAnswer = () => ({ ok: true, value: { tx_hash: EVIDENCE_TX, uri: 'vector-tx:evidence', document_hash: 'ab'.repeat(32), fee_lovelace: 1n } });
    expectNotFiled(await dispute.challengeDelivery(delivery()), 'port_error');
    expect(port.challenged).toEqual([]);
  });

  it('makes the evidence before it publishes anything: facts with no contradiction publish nothing', async () => {
    const { events, port, dispute } = rig();
    port.claims = [claimView()];
    const same = { ...ORDER_FACTS, confirmation: { ...ORDER_FACTS.purchase_order, schema: 'x' } };
    const result = await dispute.challengeDelivery(delivery({ evidence: same as unknown as DeliveryChallengeInput['evidence'] }));
    expectNotFiled(result, 'no_contradiction');
    expect(events).toEqual(['readClaims']);
    expect(result).toMatchObject({ evidence: null, sent: null });
    // The twin: facts that differ are published.
    expect((await dispute.challengeDelivery(delivery())).ok).toBe(true);
    expect(port.published.length).toBe(1);
  });

  it('publishes the evidence of use case 3 and of use case 2 the same way', async () => {
    const quote = rig();
    quote.port.claims = [claimView({ claimer: OTHER })];
    expect((await quote.dispute.challengeDelivery(delivery({ evidence: QUOTE_FACTS }))).ok).toBe(true);
    expect(textOf(quote.port.published[0]!.bytes)).toContain('The bid desk quoted the unit price 110');
    const digest = rig();
    digest.port.claims = [claimView()];
    expect((await digest.dispute.challengeApproval(approval())).ok).toBe(true);
    expect(textOf(digest.port.published[0]!.bytes)).toContain(`holds the digest ${MISMATCH.expected_digest}`);
  });
});

describe('the claim that is challenged is the open claim of the other party of this job', () => {
  const own = claimView({ ref: REF_B, token: TOKEN_B, claimer: ME, claimer_key_hash: '0b'.repeat(28) });
  const third = claimView({ ref: REF_C, token: TOKEN_C, claimer: THIRD });
  const target = claimView({ ref: REF_A, token: TOKEN_A, claimer: OTHER });

  it('challenges the claim of the other party and no other claim, whatever the order of the list', async () => {
    for (const claims of [[own, third, target], [target, own, third], [third, target, own]]) {
      const { port, dispute } = rig();
      port.claims = claims;
      const result = await dispute.challengeDelivery(delivery());
      expect(result.ok).toBe(true);
      expect(port.challenged.map((call) => call.claim)).toEqual([REF_A]);
      expect(port.challenged[0]!.claim_token).toBe(TOKEN_A);
      // The evidence names the same claim, the claimer, and this agent as the challenger.
      const text = textOf(port.published[0]!.bytes);
      expect(text).toContain(`Claim: ${REF_A}`);
      expect(text).toContain(`Claimer: ${OTHER}`);
      expect(text).toContain(`Challenger: ${ME}`);
      expect(text).not.toContain(REF_B);
      expect(text).not.toContain(REF_C);
    }
  });

  it('files nothing when the only claims are its own claim and the claim of a third agent', async () => {
    const { events, port, dispute } = rig();
    port.claims = [own, third];
    const result = await dispute.challengeDelivery(delivery());
    expectNotFiled(result, NO_OPEN_CLAIM);
    expect(events).toEqual(['readClaims']);
  });

  it('never challenges a claim that is withdrawn or resolved, or one that is already challenged', async () => {
    for (const state of ['Challenged', 'Validated', 'Invalidated'] as const) {
      const { events, port, dispute } = rig();
      port.claims = [claimView({ state })];
      expectNotFiled(await dispute.challengeDelivery(delivery()), NO_OPEN_CLAIM);
      expect(events).toEqual(['readClaims']);
    }
    // A claim that was withdrawn is gone from the chain: the list has no claim of the other party.
    const gone = rig();
    gone.port.claims = [third];
    expectNotFiled(await gone.dispute.challengeDelivery(delivery()), NO_OPEN_CLAIM);
    // The twin: the same party has an open claim next to the resolved one, and that claim is challenged.
    const twin = rig();
    twin.port.claims = [claimView({ ref: REF_B, token: TOKEN_B, state: 'Validated' }), target];
    expect((await twin.dispute.challengeDelivery(delivery())).ok).toBe(true);
    expect(twin.port.challenged[0]!.claim).toBe(REF_A);
  });

  it('never challenges an open claim whose challenge window has ended', async () => {
    const ended = rig();
    ended.port.claims = [claimView({ submitted_at: NOW - 5 * HOUR })];
    const result = await ended.dispute.challengeDelivery(delivery());
    expectNotFiled(result, NO_OPEN_CLAIM);
    expect(result.detail).toContain('challenge window');
    expect(ended.events).toEqual(['readClaims']);
    // The twin: a window that ends one millisecond after the clock is open, and a window that ends at the clock is over.
    const edge = rig();
    edge.port.claims = [claimView({ submitted_at: NOW - 4 * HOUR + 1 })];
    expect(await edge.dispute.findOpenClaim(OTHER)).toMatchObject({ ok: true });
    edge.port.claims = [claimView({ submitted_at: NOW - 4 * HOUR })];
    expect(await edge.dispute.findOpenClaim(OTHER)).toMatchObject({ ok: false, code: NO_OPEN_CLAIM });
    const wide = rig({ min_window_left_ms: 2_000 });
    wide.port.claims = [claimView({ submitted_at: NOW - 4 * HOUR + 60_000 })];
    expect((await wide.dispute.challengeDelivery(delivery())).ok).toBe(true);
  });

  it('does not choose between two open claims of the other party', async () => {
    const { events, port, dispute } = rig();
    port.claims = [target, claimView({ ref: REF_B, token: TOKEN_B, submitted_at: NOW - 2 * HOUR })];
    const result = await dispute.challengeDelivery(delivery());
    expectNotFiled(result, 'claim_ambiguous');
    expect(events).toEqual(['readClaims']);
    // The twin: one of the two claims is already challenged, so one claim is open.
    port.claims = [target, claimView({ ref: REF_B, token: TOKEN_B, state: 'Challenged' })];
    expect((await dispute.challengeDelivery(delivery())).ok).toBe(true);
    expect(port.challenged[0]!.claim).toBe(REF_A);
  });

  it('refuses a challenge against its own claim before it reads the chain', async () => {
    const { events, port, dispute } = rig();
    port.claims = [own];
    expectNotFiled(await dispute.challengeDelivery(delivery({ counterparty: ME })), 'same_agent');
    expect(events).toEqual([]);
    expectNotFiled(await dispute.challengeApproval(approval({ sender: ME, escrow_ref: ESCROW_2 })), 'same_agent');
    expect(events).toEqual([]);
  });

  it('says that the chain cannot be read, and never takes that for no open claim', async () => {
    const { events, port, dispute } = rig();
    port.claims = [target];
    port.readClaimsFails = new Error('Koios answered 503 at https://koios.example/secret-key');
    const result = await dispute.challengeDelivery(delivery());
    expectNotFiled(result, 'chain_unavailable');
    expect(result.code).not.toBe(NO_OPEN_CLAIM);
    expect(result.detail).not.toContain('secret-key');
    expect(events).toEqual(['readClaims']);
    // The twin: the chain answers again, and the same job is filed. A read that failed does not use up the job.
    port.readClaimsFails = null;
    expect((await dispute.challengeDelivery(delivery())).ok).toBe(true);
  });

  describe('the claim is read again before the challenge, and it must be the claim that the evidence names', () => {
    const changes: Array<[string, (claim: ClaimView) => ClaimView | null]> = [
      ['was challenged by another agent', (claim) => ({ ...claim, state: 'Challenged' })],
      ['was withdrawn or resolved, so no output holds it', () => null],
      ['is another claim at the same output', (claim) => ({ ...claim, token: TOKEN_B })],
      ['is of another claimer at the same output', (claim) => ({ ...claim, claimer: THIRD })],
    ];

    it.each(changes)('files no challenge when the claim %s, and says that the evidence landed', async (_name, change) => {
      const { events, port, dispute } = rig();
      port.claims = [target];
      port.readClaimAnswer = () => change(target);
      const result = await dispute.challengeDelivery(delivery());
      expectNotFiled(result, 'claim_changed');
      expect(result.evidence).toMatchObject({ tx_hash: EVIDENCE_TX });
      expect(port.challenged).toEqual([]);
      expect(events.filter((event) => event.startsWith('publish')).length).toBe(1);
    });

    it('files no challenge when the challenge window ended while the evidence was confirming', async () => {
      const { port, dispute, time } = rig();
      port.claims = [claimView({ submitted_at: NOW - 4 * HOUR + 15 * 60_000 })];
      const answer = port.publishAnswer;
      port.publishAnswer = (call) => {
        time.now += 20 * 60_000;
        return answer(call);
      };
      const result = await dispute.challengeDelivery(delivery());
      expectNotFiled(result, 'claim_changed');
      expect(result.detail).toContain('challenge window');
      expect(result.evidence).not.toBeNull();
      expect(port.challenged).toEqual([]);
    });

    it('files no challenge when the read of the claim fails, and says that the evidence landed', async () => {
      const { port, dispute } = rig();
      port.claims = [target];
      port.readClaimAnswer = () => new Error('node unreachable');
      const result = await dispute.challengeDelivery(delivery());
      expectNotFiled(result, 'chain_unavailable');
      expect(result.evidence).toMatchObject({ tx_hash: EVIDENCE_TX });
      expect(port.challenged).toEqual([]);
    });

    it('files the challenge when the claim is the same at the second read', async () => {
      const { port, dispute } = rig();
      port.claims = [target];
      port.readClaimAnswer = () => ({ ...target });
      expect((await dispute.challengeDelivery(delivery())).ok).toBe(true);
    });

    it('reports a challenge that the port landed on another claim, and does not call it filed', async () => {
      const { logs, port, dispute } = rig();
      port.claims = [target];
      port.openChallengeAnswer = (call) => ({
        ok: true,
        value: {
          tx_hash: CHALLENGE_TX, challenge: `${CHALLENGE_TX}#0`, challenge_token: `63686c5f${'0e'.repeat(28)}`, claim: REF_B, claim_token: call.claim_token, stake_lovelace: call.stake_lovelace, deadline: NOW,
          fee_lovelace: 1n,
        },
      });
      const result = await dispute.challengeDelivery(delivery());
      expectNotFiled(result, 'challenge_wrong_claim');
      expect(result.evidence).not.toBeNull();
      expect(logs.some((line) => line.includes(REF_B))).toBe(true);
      const outcome = disputedFields(result);
      expect(outcome).toMatchObject({ outcome: 'disputed', challenge: null, exit_state: 'Failed' });
    });
  });

  it('refuses a challenge stake below the stake of the claim before it publishes, and accepts a stake of the same size or more', async () => {
    const low = rig({ challenge_stake_lovelace: 49_999_999n });
    low.port.claims = [target];
    expectNotFiled(await low.dispute.challengeDelivery(delivery()), 'challenge_stake_too_low');
    expect(low.events).toEqual(['readClaims']);
    for (const stake of [50_000_000n, 80_000_000n]) {
      const fine = rig({ challenge_stake_lovelace: stake });
      fine.port.claims = [target];
      expect((await fine.dispute.challengeDelivery(delivery())).ok).toBe(true);
      expect(fine.port.challenged[0]!.stake_lovelace).toBe(stake);
    }
  });

  it('refuses a claim whose window ends too soon for the evidence, before it publishes', async () => {
    const closing = rig({ min_window_left_ms: 4 * HOUR });
    closing.port.claims = [target];
    expectNotFiled(await closing.dispute.challengeDelivery(delivery()), 'claim_window_closing');
    expect(closing.events).toEqual(['readClaims']);
    const roomy = rig({ min_window_left_ms: 3 * HOUR });
    roomy.port.claims = [target];
    expect((await roomy.dispute.challengeDelivery(delivery())).ok).toBe(true);
  });
});

describe('a job gets one challenge', () => {
  it('refuses a second challenge for one job, and publishes and challenges once', async () => {
    const { port, dispute } = rig();
    port.claims = [claimView()];
    expect((await dispute.challengeDelivery(delivery())).ok).toBe(true);
    // The claim is still open on this port: only the guard of the job stops the second challenge.
    const second = await dispute.challengeDelivery(delivery());
    expectNotFiled(second, 'job_already_disputed');
    expect(port.published.length).toBe(1);
    expect(port.challenged.length).toBe(1);
  });

  it('refuses a second challenge for one job against another claim of the same agent', async () => {
    const { port, dispute } = rig();
    port.claims = [claimView()];
    challengeChangesTheClaim(port);
    expect((await dispute.challengeDelivery(delivery())).ok).toBe(true);
    // The old claim of the other party is not open any more. A new claim of the same agent appears, and the same job must not challenge it.
    port.claims = [...port.claims, claimView({ ref: REF_B, token: TOKEN_B, submitted_at: NOW - 10 * 60_000 })];
    expectNotFiled(await dispute.challengeDelivery(delivery()), 'job_already_disputed');
    expect(port.challenged.length).toBe(1);
  });

  it('files the second job against the claim of its own party, and a second job against a claim that is challenged finds no open claim', async () => {
    const { port, dispute } = rig();
    port.claims = [claimView(), claimView({ ref: REF_C, token: TOKEN_C, claimer: THIRD })];
    challengeChangesTheClaim(port);
    expect((await dispute.challengeDelivery(delivery())).ok).toBe(true);
    expect((await dispute.challengeDelivery(delivery({ counterparty: THIRD, escrow_ref: ESCROW_2 }))).ok).toBe(true);
    expect(port.challenged.map((call) => call.claim)).toEqual([REF_A, REF_C]);
    // A third job against the first party: its claim is challenged, so there is no open claim.
    expectNotFiled(await dispute.challengeDelivery(delivery({ escrow_ref: `${'e7'.repeat(32)}#0` })), NO_OPEN_CLAIM);
    expect(port.challenged.length).toBe(2);
  });

  it('refuses a second challenge while the first is in progress', async () => {
    const { port, dispute } = rig();
    port.claims = [claimView()];
    const release = port.holdPublish();
    const first = dispute.challengeDelivery(delivery());
    await tick();
    expectNotFiled(await dispute.challengeDelivery(delivery()), 'job_already_disputed');
    release();
    expect((await first).ok).toBe(true);
    expect(port.published.length).toBe(1);
  });

  it('refuses a second try after a transaction was sent and not seen confirmed, because it can still land', async () => {
    const { port, dispute } = rig();
    port.claims = [claimView()];
    port.publishAnswer = () => ({ ok: false, code: 'not_confirmed', detail: 'late', tx_hash: EVIDENCE_TX, valid_to: NOW + HOUR, may_land: true });
    expectNotFiled(await dispute.challengeDelivery(delivery()), 'evidence_not_confirmed');
    expectNotFiled(await dispute.challengeDelivery(delivery()), 'job_already_disputed');
    expect(port.published.length).toBe(1);
  });

  it('refuses a second try after the evidence landed and the challenge failed', async () => {
    const { port, dispute } = rig();
    port.claims = [claimView()];
    port.openChallengeAnswer = () => ({ ok: false, code: 'not_built', detail: 'the wallet is empty' });
    const first = await dispute.challengeDelivery(delivery());
    expectNotFiled(first, 'challenge_not_built');
    expect(first.evidence).toMatchObject({ tx_hash: EVIDENCE_TX });
    expectNotFiled(await dispute.challengeDelivery(delivery()), 'job_already_disputed');
    expect(port.published.length).toBe(1);
  });

  it('says that a challenge was sent and not seen confirmed, with the facts that decide whether it can land', async () => {
    const { port, dispute } = rig();
    port.claims = [claimView()];
    port.openChallengeAnswer = () => ({ ok: false, code: 'not_confirmed', detail: 'late', tx_hash: CHALLENGE_TX, valid_to: NOW + 30 * 60_000, may_land: false });
    const result = await dispute.challengeDelivery(delivery());
    expectNotFiled(result, 'challenge_not_confirmed');
    expect(result.evidence).toMatchObject({ tx_hash: EVIDENCE_TX });
    expect(result.sent).toEqual({ tx_hash: CHALLENGE_TX, valid_to: NOW + 30 * 60_000, may_land: false });
  });

  it('frees the job after no open claim, and takes the job again for the next try', async () => {
    const { port, dispute } = rig();
    expectNotFiled(await dispute.challengeDelivery(delivery()), NO_OPEN_CLAIM);
    port.claims = [claimView()];
    expect((await dispute.challengeDelivery(delivery())).ok).toBe(true);
  });
});

describe('the challenge of a counterparty that refused for the digest of the approval', () => {
  it('challenges the open claim of the sender, and puts the reference of the challenge into the result and the log', async () => {
    const { logs, port, dispute } = rig();
    port.claims = [claimView({ claimer: OTHER })];
    const result = await dispute.challengeApproval(approval());
    if (!result.ok) throw new Error(result.detail);
    expect(result.value.record).toEqual({ claim: REF_A, evidence: EVIDENCE_TX, challenge: `${CHALLENGE_TX}#0` });
    expect(result.value.against_did).toBe(OTHER);
    expect(logs.some((line) => line.includes(`${CHALLENGE_TX}#0`) && line.includes(EVIDENCE_TX))).toBe(true);
    expect(textOf(port.published[0]!.bytes)).toContain('The challenger refused the request before it did any work.');
  });

  it('files nothing when the sender has no open claim, and the result says no_open_claim and no reference', async () => {
    const { events, port, dispute } = rig();
    port.claims = [claimView({ claimer: THIRD })];
    const result = await dispute.challengeApproval(approval());
    expectNotFiled(result, NO_OPEN_CLAIM);
    expect(events).toEqual(['readClaims']);
    expect(JSON.stringify(result)).not.toContain(CHALLENGE_TX);
  });

  it('holds no text of the request: a request in the evidence refuses the challenge before anything is published', async () => {
    const { events, port, dispute } = rig();
    port.claims = [claimView()];
    const withText = { ...DIGEST_FACTS, request: { sku: 'SKU-1' } };
    const result = await dispute.challengeApproval(approval({ evidence: withText as unknown as ApprovalChallengeInput['evidence'] }));
    expectNotFiled(result, 'bad_shape');
    expect(events).toEqual(['readClaims']);
    expect(port.published).toEqual([]);
  });

  it('does not take the evidence of a delivery, and a buyer-side agent does not take the evidence of an approval', async () => {
    const { events, dispute } = rig();
    expectNotFiled(await dispute.challengeApproval(approval({ evidence: ORDER_FACTS as unknown as ApprovalChallengeInput['evidence'] })), 'bad_shape');
    expectNotFiled(await dispute.challengeDelivery(delivery({ evidence: DIGEST_FACTS as unknown as DeliveryChallengeInput['evidence'] })), 'bad_shape');
    expect(events).toEqual([]);
  });
});

describe('the input of a challenge', () => {
  const BAD: Array<[string, Record<string, unknown>]> = [
    ['a counterparty that is not a DID', { counterparty: 'zq9' }],
    ['a job that is not an output reference', { escrow_ref: 'zq9' }],
    ['evidence that is not an object', { evidence: 'zq9' }],
    ['evidence of an unknown kind', { evidence: { kind: 'zq9' } }],
    ['a member that a challenge does not have', { extra_member: 'zq9' }],
  ];

  it.each(BAD)('refuses %s before it reads the chain, and the detail does not repeat the value', async (_name, extra) => {
    const { events, dispute } = rig();
    const result = await dispute.challengeDelivery({ ...delivery(), ...extra } as unknown as DeliveryChallengeInput);
    expectNotFiled(result, 'bad_shape');
    expect(result.detail).not.toContain('zq9');
    expect(events).toEqual([]);
  });

  it('never throws for an input that cannot be read', async () => {
    const { dispute } = rig();
    expectNotFiled(await dispute.challengeDelivery(null as unknown as DeliveryChallengeInput), 'bad_shape');
    const withGetter = { ...delivery() };
    Object.defineProperty(withGetter, 'escrow_ref', { enumerable: true, get: () => ESCROW });
    expectNotFiled(await dispute.challengeDelivery(withGetter), 'bad_shape');
  });
});

describe('the settings of the dispute', () => {
  const make = (settings: Record<string, unknown>) => () => new Dispute({
    port: new ScriptedPort(), queue: new RecordingQueue([]), clock: () => NOW,
    settings: { challenge_stake_lovelace: 50_000_000n, resolution_deadline_ms: 72 * HOUR, min_window_left_ms: 600_000, ...settings } as unknown as DisputeSettings,
  });

  it('refuses a stake that is not a bigint, and a time that is not a whole number, and never reads them as no limit', () => {
    expect(make({ challenge_stake_lovelace: 50_000_000 })).toThrow(TypeError);
    expect(make({ challenge_stake_lovelace: '50000000' })).toThrow(TypeError);
    expect(make({ challenge_stake_lovelace: undefined })).toThrow(TypeError);
    expect(make({ challenge_stake_lovelace: null })).toThrow(TypeError);
    expect(make({ resolution_deadline_ms: '259200000' })).toThrow(TypeError);
    expect(make({ resolution_deadline_ms: 1.5 })).toThrow(TypeError);
    expect(make({ resolution_deadline_ms: undefined })).toThrow(TypeError);
    expect(make({ min_window_left_ms: Number.POSITIVE_INFINITY })).toThrow(TypeError);
    expect(make({ min_window_left_ms: null })).toThrow(TypeError);
  });

  it('refuses a stake of 0, a deadline of 0 and a window that is too short to confirm anything', () => {
    expect(make({ challenge_stake_lovelace: 0n })).toThrow(RangeError);
    expect(make({ challenge_stake_lovelace: -1n })).toThrow(RangeError);
    expect(make({ resolution_deadline_ms: 0 })).toThrow(RangeError);
    expect(make({ min_window_left_ms: 1_999 })).toThrow(RangeError);
  });

  it('accepts the settings of the twin', () => {
    expect(make({})).not.toThrow();
    expect(make({ min_window_left_ms: 2_000, resolution_deadline_ms: 1 })).not.toThrow();
  });

  it('refuses a clock that does not give POSIX milliseconds, and files nothing', async () => {
    for (const bad of [Number.NaN, 0, -5, 1.5]) {
      const port = new ScriptedPort();
      port.claims = [claimView()];
      const dispute = new Dispute({
        port, queue: new RecordingQueue([]), clock: () => bad, settings: { challenge_stake_lovelace: 50_000_000n, resolution_deadline_ms: 72 * HOUR, min_window_left_ms: 600_000 },
      });
      await expect(dispute.challengeDelivery(delivery())).resolves.toMatchObject({ ok: false, code: 'port_error' });
      expect(port.published).toEqual([]);
    }
  });
});

describe('the lookup of the open claim of an agent', () => {
  it('finds the one open claim that can still be challenged', async () => {
    const { port, dispute } = rig();
    port.claims = [claimView(), claimView({ ref: REF_B, token: TOKEN_B, claimer: THIRD })];
    const found = await dispute.findOpenClaim(OTHER);
    expect(found).toMatchObject({ ok: true, value: { ref: REF_A, token: TOKEN_A } });
    expect(await dispute.findOpenClaim(THIRD)).toMatchObject({ ok: true, value: { ref: REF_B } });
  });

  it('says no_open_claim for an agent with no claim, and claim_ambiguous for two', async () => {
    const { port, dispute } = rig();
    expect(await dispute.findOpenClaim(OTHER)).toMatchObject({ ok: false, code: NO_OPEN_CLAIM });
    port.claims = [claimView(), claimView({ ref: REF_B, token: TOKEN_B })];
    expect(await dispute.findOpenClaim(OTHER)).toMatchObject({ ok: false, code: 'claim_ambiguous' });
  });

  it('refuses an agent that is not a DID, and says chain_unavailable when the claims cannot be read', async () => {
    const { port, dispute } = rig();
    expect(await dispute.findOpenClaim('zq9' as never)).toMatchObject({ ok: false, code: 'bad_shape' });
    port.readClaimsFails = new Error('down');
    expect(await dispute.findOpenClaim(OTHER)).toMatchObject({ ok: false, code: 'chain_unavailable' });
    vi.spyOn(port, 'readClaims').mockResolvedValue('not a list' as never);
    expect(await dispute.findOpenClaim(OTHER)).toMatchObject({ ok: false, code: 'chain_unavailable' });
  });

  it('lists every claim of an agent whose state is Open, whatever its window, the newest first', async () => {
    const { port, dispute } = rig();
    const older = claimView({ ref: REF_B, token: TOKEN_B, submitted_at: NOW - 30 * HOUR });
    const newer = claimView({ submitted_at: NOW - HOUR });
    port.claims = [older, claimView({ ref: REF_C, token: TOKEN_C, state: 'Challenged' }), newer, claimView({ ref: REF_C, token: TOKEN_C, claimer: THIRD })];
    const listed = await dispute.listOpenClaims(OTHER);
    expect(listed).toMatchObject({ ok: true });
    if (listed.ok) expect(listed.value.map((claim) => claim.ref)).toEqual([REF_A, REF_B]);
    expect(await dispute.listOpenClaims('zq9' as never)).toMatchObject({ ok: false, code: 'bad_shape' });
    port.readClaimsFails = new Error('down');
    expect(await dispute.listOpenClaims(OTHER)).toMatchObject({ ok: false, code: 'chain_unavailable' });
  });
});

describe('the members of a disputed result', () => {
  const FIELDS = {
    schema: RESULT_SCHEMA, use_case: 'inventory-reorder', proposal_digest: '88'.repeat(32), handoff: null, writes: [], decisions: [], fault_mode: '',
  } as const;

  it('gives Escalated and the record for a challenge that is filed, and the exit state that the one rule gives', async () => {
    const { port, dispute } = rig();
    port.claims = [claimView()];
    const filed = await dispute.challengeDelivery(delivery());
    const fields = disputedFields(filed);
    expect(fields).toEqual({ outcome: 'disputed', reason: null, challenge: { claim: REF_A, evidence: EVIDENCE_TX, challenge: `${CHALLENGE_TX}#0` }, exit_state: 'Escalated' });
    expect(exitStateOf({ outcome: 'disputed', reason: null, challenge_filed: true, delegation_ended: false })).toBe(fields.exit_state);
    // The members fit the result type of the protocol: this line does not compile for another pair of outcome and exit state.
    const result: EscalatedResult = { ...FIELDS, ...(fields as Extract<typeof fields, { exit_state: 'Escalated' }>) };
    expect(result.challenge.challenge).toBe(`${CHALLENGE_TX}#0`);
  });

  it('gives Failed with no_open_claim as the reason when there is no open claim, and with the code of the step in any other failure', async () => {
    const none = rig();
    const fields = disputedFields(await none.dispute.challengeDelivery(delivery()));
    expect(fields).toEqual({ outcome: 'disputed', reason: NO_OPEN_CLAIM, challenge: null, exit_state: 'Failed' });
    expect(exitStateOf({ outcome: 'disputed', reason: fields.reason, challenge_filed: false, delegation_ended: false })).toBe(fields.exit_state);
    const result: UnfiledDisputeResult = { ...FIELDS, ...(fields as Extract<typeof fields, { exit_state: 'Failed' }>) };
    expect(result.reason).toBe('no_open_claim');
    const late = rig();
    late.port.claims = [claimView()];
    late.port.publishAnswer = () => ({ ok: false, code: 'not_built', detail: 'x' });
    expect(disputedFields(await late.dispute.challengeDelivery(delivery()))).toMatchObject({ reason: 'evidence_not_built', challenge: null, exit_state: 'Failed' });
  });
});

describe('every transaction runs in the queue of the service key', () => {
  it('has no call that lands a transaction outside a job of the queue', async () => {
    const { events, port, dispute } = rig();
    port.claims = [claimView()];
    await dispute.challengeDelivery(delivery());
    let depth = 0;
    for (const event of events) {
      if (event === 'queue:start') depth += 1;
      else if (event === 'queue:end') depth -= 1;
      else if (event.startsWith('publish') || event.startsWith('openChallenge')) expect(depth).toBe(1);
    }
    expect(depth).toBe(0);
  });

  it('says port_error when the queue fails, and the evidence is not taken for published', async () => {
    const port = new ScriptedPort();
    port.claims = [claimView()];
    const dispute = new Dispute({
      port, queue: { run: async () => { throw new Error('the queue is closed'); } }, clock: () => NOW,
      settings: { challenge_stake_lovelace: 50_000_000n, resolution_deadline_ms: 72 * HOUR, min_window_left_ms: 600_000 },
    });
    expectNotFiled(await dispute.challengeDelivery(delivery()), 'port_error');
    expect(port.published).toEqual([]);
    expect(port.challenged).toEqual([]);
  });
});
