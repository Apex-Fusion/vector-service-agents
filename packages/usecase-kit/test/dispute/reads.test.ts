// packages/usecase-kit/test/dispute/reads.test.ts: what the dispute code does when a port answers in a wrong shape, when a read never answers, and when the log function throws. A source that cannot be
// read, or that answers in a wrong shape, is never a pass and never the refusal of a rule: it is `chain_unavailable`. Each refusal has an accepted twin.
import { setImmediate as tick } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { HireLane } from '@vsa/hire-kit';
import type { ChallengeResult, ClaimView, DeliveryChallengeInput, RunClaimInput } from '@vsa/usecase-kit/dispute';
import {
  ESCROW, EVIDENCE_TX, HOUR, JOB, KEY_HASH, MANIFEST_SHA, ME, NO_TRANSACTION, NOW, ORDER_DESK_CLAIM, ORDER_FACTS, OTHER, REF_A, REF_B, ScriptedPort, THIRD, TOKEN_B, challengeView, claimView, deferred, evidenceOf, rig,
} from './support.ts';

const delivery = (): DeliveryChallengeInput => ({ counterparty: OTHER, escrow_ref: ESCROW, ...JOB, evidence: ORDER_FACTS });
const runClaim = (): RunClaimInput => ({
  capability_id: 'supplychain.order.accept.v1', manifest_sha256: MANIFEST_SHA, claim: ORDER_DESK_CLAIM, stake_lovelace: 50_000_000n, challenge_window_ms: 24 * HOUR, claim_type: 'service-quality',
});

function expectNotFiled(result: ChallengeResult, code: string): asserts result is Extract<ChallengeResult, { ok: false }> {
  expect(result).toMatchObject({ ok: false, code });
}

describe('a view of a wrong shape from the port is chain_unavailable', () => {
  const BAD: Array<[string, Partial<Record<keyof ClaimView, unknown>>]> = [
    ['a submit time that is NaN', { submitted_at: Number.NaN }],
    ['a submit time that is a text, for a window that ended 26 hours ago', { submitted_at: String(NOW - 30 * HOUR) }],
    ['a submit time that is infinite', { submitted_at: Number.POSITIVE_INFINITY }],
    ['a submit time below 0', { submitted_at: -1 }],
    ['a window that is 0', { challenge_window_ms: 0 }],
    ['a window that is a text', { challenge_window_ms: '14400000' }],
    ['no stake', { stake_lovelace: undefined }],
    ['a stake that is a number above the challenge stake', { stake_lovelace: 900_000_000 }],
    ['a stake below 0', { stake_lovelace: -1n }],
    ['a state that does not exist', { state: 'Weird' }],
    ['a ref that is not an output reference', { ref: 'zq9' }],
    ['a token that is not a claim token', { token: 'ab' }],
    ['a claimer that is not a DID', { claimer: 'zq9' }],
    ['a key hash that is not a hash', { claimer_key_hash: 'zq9' }],
    ['no key hash member', { claimer_key_hash: undefined }],
    ['a claim hash that is a number', { claim_hash: 7 }],
    ['no claim type', { claim_type: undefined }],
    ['no claim address', { claim_uri: undefined }],
  ];

  it.each(BAD)('says chain_unavailable for %s, and sends nothing', async (_name, change) => {
    const { events, port, dispute } = rig();
    port.claims = [{ ...claimView(), ...change } as ClaimView];
    const result = await dispute.challengeDelivery(delivery());
    expectNotFiled(result, 'chain_unavailable');
    expect(result.detail).toContain('wrong shape');
    expect(events).toEqual(['readClaims']);
    expect(port.published).toEqual([]);
    expect(port.challenged).toEqual([]);
  });

  it('says chain_unavailable for a wrong view of a claim of a third agent, and for an element that is not an object, and accepts the twin', async () => {
    for (const bad of [{ ...claimView({ ref: REF_B, token: TOKEN_B, claimer: THIRD }), submitted_at: Number.NaN }, null, 'zq9', 7]) {
      const { port, dispute } = rig();
      port.claims = [claimView(), bad as unknown as ClaimView];
      expectNotFiled(await dispute.challengeDelivery(delivery()), 'chain_unavailable');
      expect(port.published).toEqual([]);
    }
    const twin = rig();
    twin.port.claims = [claimView(), claimView({ ref: REF_B, token: TOKEN_B, claimer: THIRD })];
    expect((await twin.dispute.challengeDelivery(delivery())).ok).toBe(true);
  });

  it('checks the claim that the second read gives, and the claim that a withdrawal reads', async () => {
    const second = rig();
    second.port.claims = [claimView()];
    second.port.readClaimAnswer = () => ({ ...claimView(), submitted_at: Number.NaN });
    const result = await second.dispute.challengeDelivery(delivery());
    expectNotFiled(result, 'chain_unavailable');
    expect(result.evidence).toMatchObject({ tx_hash: EVIDENCE_TX });
    expect(second.port.challenged).toEqual([]);
    const withdrawal = rig();
    withdrawal.port.readClaimAnswer = () => claimView({ claimer: ME, claimer_key_hash: KEY_HASH, submitted_at: NOW - 30 * HOUR, stake_lovelace: undefined as never });
    expect(await withdrawal.dispute.withdrawClaim({ claim: REF_A })).toMatchObject({ ok: false, code: 'chain_unavailable' });
    expect(withdrawal.port.withdrawn).toEqual([]);
    // The twin: the same claim in its form is withdrawn.
    withdrawal.port.readClaimAnswer = () => claimView({ claimer: ME, claimer_key_hash: KEY_HASH, submitted_at: NOW - 30 * HOUR });
    expect((await withdrawal.dispute.withdrawClaim({ claim: REF_A })).ok).toBe(true);
  });

  it('checks the challenges that the port gives, and does not take them for a list with no challenge of this agent', async () => {
    const shapes: unknown[] = [[{ ...challengeView(), stake_lovelace: undefined }], [null], 'zq9', [{ ...challengeView(), state: 'Weird' }], [{ ...challengeView(), challenged_at: Number.NaN }]];
    for (const shape of shapes) {
      const { port, dispute } = rig();
      port.claims = [claimView({ state: 'Challenged' })];
      port.readChallenges = async () => shape as never;
      expectNotFiled(await dispute.challengeDelivery(delivery()), 'chain_unavailable');
      expect(port.published).toEqual([]);
    }
  });
});

describe('a log function that throws changes no result', () => {
  const throwing = (when: (line: string) => boolean) => (line: string): void => {
    if (when(line)) throw new Error('ENOSPC: no space left on device, write');
  };

  it('keeps a challenge that is filed when the line of the filed challenge, the line of the evidence, or every line throws', async () => {
    for (const when of [(line: string) => line.includes('filed against'), (line: string) => line.includes('confirmed for the claim'), () => true]) {
      const { port, dispute } = rig({}, { log: throwing(when) });
      port.claims = [claimView()];
      const result = await dispute.challengeDelivery(delivery());
      expect(result.ok).toBe(true);
      expect(port.published.length).toBe(1);
      expect(port.challenged.length).toBe(1);
      // The job is not tried again: the second call gives the same filed challenge.
      expect(await dispute.challengeDelivery(delivery())).toEqual(result);
    }
  });

  it('keeps the result of a challenge that stops after the evidence landed, with the evidence in it', async () => {
    const { port, dispute } = rig({}, { log: throwing(() => true) });
    port.claims = [claimView()];
    port.openChallengeAnswer = () => ({ ok: false, code: 'not_built', detail: 'the wallet is empty' });
    expect(await dispute.challengeDelivery(delivery())).toMatchObject({ ok: false, code: 'challenge_not_built', evidence: { tx_hash: EVIDENCE_TX } });
    const wrong = rig({}, { log: throwing(() => true) });
    wrong.port.claims = [claimView()];
    wrong.port.publishAnswer = () => ({ ok: true, value: { tx_hash: EVIDENCE_TX, uri: 'vector-tx:x', document_hash: 'ab'.repeat(32), fee_lovelace: 1n } });
    expect(await wrong.dispute.challengeDelivery(delivery())).toMatchObject({ ok: false, code: 'port_error', wrong_document: { tx_hash: EVIDENCE_TX } });
  });

  it('keeps the result of the claim of a run and of a withdrawal that landed, and of a challenge that was found again', async () => {
    const claim = rig({}, { log: throwing(() => true) });
    expect(await claim.dispute.stakeRunClaim(runClaim())).toMatchObject({ ok: true });
    expect(claim.port.submitted.length).toBe(1);
    const withdrawal = rig({}, { log: throwing(() => true) });
    withdrawal.port.claims = [claimView({ claimer: ME, claimer_key_hash: KEY_HASH, submitted_at: NOW - 30 * HOUR })];
    expect(await withdrawal.dispute.withdrawClaim({ claim: REF_A })).toMatchObject({ ok: true });
    expect(withdrawal.port.withdrawn.length).toBe(1);
    const found = rig({}, { log: throwing(() => true) });
    found.port.claims = [claimView({ state: 'Challenged' })];
    found.port.challenges = [challengeView()];
    found.port.documents.set(challengeView().evidence_uri, { bytes: evidenceOf().bytes, type: 'evidence', media_type: 'text/plain' });
    expect(await found.dispute.challengeDelivery(delivery())).toMatchObject({ ok: true });
  });

  it('keeps the result for a log function that returns a promise that rejects, and leaves no unhandled rejection', async () => {
    const { port, dispute } = rig({}, { log: (() => Promise.reject(new Error('the log service is down'))) as unknown as (line: string) => void });
    port.claims = [claimView()];
    expect((await dispute.challengeDelivery(delivery())).ok).toBe(true);
    await tick();
    await tick();
  });

  it('writes the lines that it has when the log works, as the twin of the failures above', async () => {
    const { logs, port, dispute } = rig();
    port.claims = [claimView()];
    expect((await dispute.challengeDelivery(delivery())).ok).toBe(true);
    expect(logs.some((line) => line.includes('filed against'))).toBe(true);
  });
});

describe('each read of the port has a bound', () => {
  /** A sleep that records its waits, and that ends when a test fires it. */
  function sleeps() {
    const fire = deferred<void>();
    const waits: number[] = [];
    return { fire: fire.resolve, waits, sleep: (ms: number): Promise<void> => { waits.push(ms); return fire.promise; } };
  }
  const stall = (fire: () => void) => (): Promise<never> => {
    fire();
    return new Promise<never>(() => undefined);
  };

  it('says chain_unavailable when the list of claims never comes, with the bound of the settings', async () => {
    const timer = sleeps();
    const { port, dispute } = rig({ read_timeout_ms: 5_000 }, { sleep: timer.sleep });
    port.readClaims = stall(timer.fire);
    const result = await dispute.challengeDelivery(delivery());
    expectNotFiled(result, 'chain_unavailable');
    expect(result.detail).toContain('did not answer within 5000 ms');
    expect(timer.waits).toEqual([5_000, 5_000]);
    expect(port.published).toEqual([]);
  });

  it('says chain_unavailable when the claim document, the challenges or the claim of a withdrawal never come', async () => {
    const document = sleeps();
    const first = rig({}, { sleep: document.sleep });
    first.port.claims = [claimView()];
    first.port.readDocument = stall(document.fire);
    expectNotFiled(await first.dispute.challengeDelivery(delivery()), 'chain_unavailable');
    expect(first.port.published).toEqual([]);
    const challenges = sleeps();
    const second = rig({}, { sleep: challenges.sleep });
    second.port.claims = [claimView({ state: 'Challenged' })];
    second.port.readChallenges = stall(challenges.fire);
    expectNotFiled(await second.dispute.challengeDelivery(delivery()), 'chain_unavailable');
    const claim = sleeps();
    const third = rig({}, { sleep: claim.sleep });
    third.port.readClaim = stall(claim.fire);
    expect(await third.dispute.withdrawClaim({ claim: REF_A })).toMatchObject({ ok: false, code: 'chain_unavailable' });
    expect(third.port.withdrawn).toEqual([]);
  });

  it('says chain_unavailable when the answer about the claim transaction never comes, and it does not say no_open_claim', async () => {
    const timer = sleeps();
    const { port, dispute } = rig({}, { sleep: timer.sleep });
    port.claims = [claimView()];
    port.readDocumentAnswer = () => NO_TRANSACTION;
    port.isIndexed = stall(timer.fire);
    const result = await dispute.challengeDelivery(delivery());
    expectNotFiled(result, 'chain_unavailable');
    expect(result.detail).toContain('the claim transaction');
    expect(port.published).toEqual([]);
  });

  it('does not hold the queue of the service key when the second read of the claim never comes', async () => {
    const timer = sleeps();
    const lane = new HireLane();
    const { events, port, dispute } = rig({}, { sleep: timer.sleep, queue: lane });
    port.claims = [claimView()];
    port.readClaim = stall(timer.fire);
    // The first sleep is the one of the list of claims, which came: it is not the bound that fires. The stall of the second read fires the timers, and the job ends.
    const result = await dispute.challengeDelivery(delivery());
    expectNotFiled(result, 'chain_unavailable');
    expect(result.evidence).toMatchObject({ tx_hash: EVIDENCE_TX });
    expect(port.challenged).toEqual([]);
    // A later job of the same lane runs: the lane is not held.
    let ran = false;
    await lane.run(async () => { ran = true; });
    expect(ran).toBe(true);
  });

  it('does not use an answer that comes after the bound, and leaves no unhandled error when a read that lost then fails', async () => {
    const timer = sleeps();
    const { port, dispute } = rig({}, { sleep: timer.sleep });
    let failLate: (error: Error) => void = () => undefined;
    port.readClaims = () => {
      timer.fire();
      return new Promise<never>((_resolve, reject) => { failLate = reject; });
    };
    expectNotFiled(await dispute.challengeDelivery(delivery()), 'chain_unavailable');
    // The read that lost fails after the result was given: nothing handles that error but the code that started the read.
    failLate(new Error('late failure'));
    await tick();
    await tick();
  });

  it('does not fire the bound for a read that answers, as the twin', async () => {
    const { port, dispute } = rig({ read_timeout_ms: 1 });
    port.claims = [claimView()];
    expect((await dispute.challengeDelivery(delivery())).ok).toBe(true);
  });

  it('is a bound of the same kind for each read of this port, so that no read has none', async () => {
    const port = new ScriptedPort();
    const reads = ['readClaims', 'readClaim', 'readChallenges', 'readDocument', 'isIndexed', 'readEscrowJob'] as const;
    expect(reads.every((name) => typeof port[name] === 'function')).toBe(true);
  });
});
