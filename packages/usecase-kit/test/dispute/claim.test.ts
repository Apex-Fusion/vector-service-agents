// packages/usecase-kit/test/dispute/claim.test.ts: the claim of a run and the withdrawal of a claim, on a scripted chain port. Each refusal has an accepted twin.
import { describe, expect, it } from 'vitest';
import { claimDocument, Dispute } from '@vsa/usecase-kit/dispute';
import type { DisputeSettings, RunClaimInput, RunClaimResult, WithdrawResult } from '@vsa/usecase-kit/dispute';
import {
  CHALLENGE_TX, CLAIM_DOC_TX, EVIDENCE_TX, HOUR, KEY_HASH, MANIFEST_SHA, ME, NOW, ORDER_DESK_CLAIM, OTHER_KEY_HASH, RecordingQueue, REF_A, REF_C, ScriptedPort, TOKEN_A, TOKEN_C, claimView,
} from './support.ts';
import type { Events } from './support.ts';

interface Rig {
  readonly events: Events;
  readonly port: ScriptedPort;
  readonly dispute: Dispute;
  readonly time: { now: number };
}

function rig(): Rig {
  const events: Events = [];
  const port = new ScriptedPort(events);
  const time = { now: NOW };
  const settings: DisputeSettings = { challenge_stake_lovelace: 50_000_000n, resolution_deadline_ms: 72 * HOUR, min_window_left_ms: 600_000 };
  return { events, port, time, dispute: new Dispute({ port, queue: new RecordingQueue(events), clock: () => time.now, settings }) };
}

const runClaim = (extra: Record<string, unknown> = {}): RunClaimInput => ({
  capability_id: 'supplychain.order.accept.v1', manifest_sha256: MANIFEST_SHA, claim: ORDER_DESK_CLAIM, stake_lovelace: 50_000_000n, challenge_window_ms: 24 * HOUR, claim_type: 'service-quality', ...extra,
}) as RunClaimInput;

function expectStakeRefused(result: RunClaimResult, code: string): asserts result is Extract<RunClaimResult, { ok: false }> {
  expect(result).toMatchObject({ ok: false, code });
}

function expectWithdrawRefused(result: WithdrawResult, code: string): asserts result is Extract<WithdrawResult, { ok: false }> {
  expect(result).toMatchObject({ ok: false, code });
}

describe('the claim of a run', () => {
  it('publishes the claim document, waits for it, and then submits the claim with the hash and the URI of that document', async () => {
    const { events, port, dispute } = rig();
    const result = await dispute.stakeRunClaim(runClaim());
    if (!result.ok) throw new Error(result.detail);
    expect(events).toEqual(['queue:start', 'publish claim', 'queue:end', 'queue:start', 'submitClaim', 'queue:end']);
    const document = claimDocument({ agent_did: ME, capability_id: 'supplychain.order.accept.v1', manifest_sha256: MANIFEST_SHA, claim: ORDER_DESK_CLAIM });
    if (!document.ok) throw new Error(document.detail);
    expect(Buffer.from(port.published[0]!.bytes).equals(document.value.bytes)).toBe(true);
    expect(port.published[0]).toMatchObject({ type: 'claim', media_type: 'text/plain' });
    expect(port.submitted[0]).toEqual({
      claim_hash: document.value.hash, claim_uri: result.value.document.uri, claim_type: 'service-quality',
      stake_lovelace: 50_000_000n, challenge_window_ms: 24 * HOUR,
    });
    expect(result.value).toMatchObject({
      claim: REF_C, claim_token: TOKEN_C, stake_lovelace: 50_000_000n, challenge_window_ms: 24 * HOUR, submitted_at: NOW, challenge_deadline: NOW + 24 * HOUR, claim_tx: CHALLENGE_TX,
      fee_lovelace: 700_000n,
    });
    expect(result.value.document.document_hash).toBe(document.value.hash);
  });

  it('passes the stake, the window and the type that the caller gives, and has no values of its own', async () => {
    const { port, dispute } = rig();
    const result = await dispute.stakeRunClaim(runClaim({ stake_lovelace: 75_000_000n, challenge_window_ms: 2 * HOUR, claim_type: 'trial' }));
    expect(result.ok).toBe(true);
    expect(port.submitted[0]).toMatchObject({ stake_lovelace: 75_000_000n, challenge_window_ms: 2 * HOUR, claim_type: 'trial' });
    expect(result).toMatchObject({ ok: true, value: { challenge_deadline: NOW + 2 * HOUR } });
  });

  it('refuses a stake that is not a bigint, and a window that is not a whole number, before it reads or sends anything', async () => {
    const { events, dispute } = rig();
    for (const [member, value, error] of [
      ['stake_lovelace', 50_000_000, TypeError], ['stake_lovelace', '50000000', TypeError], ['stake_lovelace', undefined, TypeError], ['stake_lovelace', 0n, RangeError],
      ['challenge_window_ms', '86400000', TypeError], ['challenge_window_ms', 1.5, TypeError], ['challenge_window_ms', undefined, TypeError], ['challenge_window_ms', 0, RangeError],
      ['claim_type', '', TypeError], ['claim_type', 7, TypeError],
    ] as const) {
      await expect(dispute.stakeRunClaim(runClaim({ [member]: value }))).rejects.toThrow(error);
    }
    expect(events).toEqual([]);
    // The twin: the same input with the right types is staked.
    expect((await dispute.stakeRunClaim(runClaim())).ok).toBe(true);
  });

  it('does not submit the claim before the claim document is confirmed', async () => {
    const { events, port, dispute } = rig();
    port.publishAnswer = () => ({ ok: false, code: 'not_confirmed', detail: 'late', tx_hash: CLAIM_DOC_TX, valid_to: NOW + HOUR, may_land: true });
    const result = await dispute.stakeRunClaim(runClaim());
    expectStakeRefused(result, 'claim_document_not_confirmed');
    expect(result.document).toBeNull();
    expect(result.sent).toEqual({ tx_hash: CLAIM_DOC_TX, valid_to: NOW + HOUR, may_land: true });
    expect(events.includes('submitClaim')).toBe(false);
    expect(port.submitted).toEqual([]);
  });

  it('does not submit the claim when the claim document is not built, and when the port throws', async () => {
    const built = rig();
    built.port.publishAnswer = () => ({ ok: false, code: 'not_built', detail: 'no collateral' });
    expectStakeRefused(await built.dispute.stakeRunClaim(runClaim()), 'claim_document_not_built');
    expect(built.port.submitted).toEqual([]);
    const thrown = rig();
    thrown.port.publishAnswer = () => { throw new Error('boom'); };
    expectStakeRefused(await thrown.dispute.stakeRunClaim(runClaim()), 'port_error');
    expect(thrown.port.submitted).toEqual([]);
  });

  it('refuses a document that the port published with another hash, and a claim that is not in its form, before it sends anything', async () => {
    const wrong = rig();
    wrong.port.publishAnswer = () => ({ ok: true, value: { tx_hash: CLAIM_DOC_TX, uri: 'vector-tx:x', document_hash: 'ab'.repeat(32), fee_lovelace: 1n } });
    expectStakeRefused(await wrong.dispute.stakeRunClaim(runClaim()), 'port_error');
    expect(wrong.port.submitted).toEqual([]);
    const bad = rig();
    expectStakeRefused(await bad.dispute.stakeRunClaim(runClaim({ capability_id: 'two words' })), 'bad_shape');
    expectStakeRefused(await bad.dispute.stakeRunClaim(runClaim({ claim: { statements: ORDER_DESK_CLAIM.statements.slice(0, 2) } })), 'bad_shape');
    expect(bad.events).toEqual([]);
  });

  it('says that the document landed when the claim does not', async () => {
    const built = rig();
    built.port.submitClaimAnswer = () => ({ ok: false, code: 'not_built', detail: 'The stake must be at least 50 units.' });
    const refused = await built.dispute.stakeRunClaim(runClaim());
    expectStakeRefused(refused, 'claim_not_built');
    expect(refused.document).toMatchObject({ tx_hash: EVIDENCE_TX });
    expect(refused.sent).toBeNull();
    const late = rig();
    late.port.submitClaimAnswer = () => ({ ok: false, code: 'not_confirmed', detail: 'late', tx_hash: CHALLENGE_TX, valid_to: NOW + HOUR, may_land: true });
    const sent = await late.dispute.stakeRunClaim(runClaim());
    expectStakeRefused(sent, 'claim_not_confirmed');
    expect(sent.document).not.toBeNull();
    expect(sent.sent).toEqual({ tx_hash: CHALLENGE_TX, valid_to: NOW + HOUR, may_land: true });
  });
});

describe('the withdrawal of a claim', () => {
  /** A claim of this agent: its key is the claimer credential. It was submitted 5 hours ago with a window of 4 hours, so its window ended one hour ago. */
  const mine = (overrides = {}) => claimView({ ref: REF_A, token: TOKEN_A, claimer: ME, claimer_key_hash: KEY_HASH, submitted_at: NOW - 5 * HOUR, ...overrides });

  it('withdraws an open claim of its own key after the challenge window, and returns the payout', async () => {
    const { events, port, dispute } = rig();
    port.claims = [mine()];
    const result = await dispute.withdrawClaim({ claim: REF_A });
    if (!result.ok) throw new Error(result.detail);
    expect(events).toEqual([`readClaim ${REF_A}`, 'queue:start', `withdrawClaim ${REF_A}`, 'queue:end']);
    expect(port.withdrawn).toEqual([{ claim: REF_A, claim_token: TOKEN_A }]);
    expect(result.value).toEqual({
      claim: REF_A, claim_token: TOKEN_A, payout: `${CHALLENGE_TX}#0`, stake_lovelace: 50_000_000n, withdraw_tx: CHALLENGE_TX, fee_lovelace: 400_000n,
    });
  });

  it('refuses a withdrawal inside the challenge window, and sends nothing; the same claim goes out after the window', async () => {
    const { events, port, dispute, time } = rig();
    port.claims = [mine({ submitted_at: NOW - HOUR })];
    const inside = await dispute.withdrawClaim({ claim: REF_A });
    expectWithdrawRefused(inside, 'window_not_ended');
    expect(inside.detail).toContain('challenge window');
    expect(port.withdrawn).toEqual([]);
    expect(events).toEqual([`readClaim ${REF_A}`]);
    time.now = NOW + 3 * HOUR + 1000;
    expect((await dispute.withdrawClaim({ claim: REF_A })).ok).toBe(true);
  });

  it('starts a withdrawal at the first whole second after the end of the window, and not one millisecond before', async () => {
    const { port, dispute, time } = rig();
    port.claims = [mine({ submitted_at: NOW - 4 * HOUR })];
    for (const before of [-1000, -1, 0, 999]) {
      time.now = NOW + before;
      expectWithdrawRefused(await dispute.withdrawClaim({ claim: REF_A }), 'window_not_ended');
    }
    expect(port.withdrawn).toEqual([]);
    time.now = NOW + 1000;
    expect((await dispute.withdrawClaim({ claim: REF_A })).ok).toBe(true);
  });

  it('refuses a claim that is not Open, or is not a live claim output', async () => {
    for (const state of ['Challenged', 'Validated', 'Invalidated'] as const) {
      const { port, dispute } = rig();
      port.claims = [mine({ state })];
      expectWithdrawRefused(await dispute.withdrawClaim({ claim: REF_A }), 'claim_not_open');
      expect(port.withdrawn).toEqual([]);
    }
    const gone = rig();
    expectWithdrawRefused(await gone.dispute.withdrawClaim({ claim: REF_A }), 'claim_not_open');
    const twin = rig();
    twin.port.claims = [mine()];
    expect((await twin.dispute.withdrawClaim({ claim: REF_A })).ok).toBe(true);
  });

  it('refuses a claim whose claimer credential is another key, or a script', async () => {
    for (const claimer_key_hash of [OTHER_KEY_HASH, null]) {
      const { port, dispute } = rig();
      port.claims = [mine({ claimer_key_hash })];
      expectWithdrawRefused(await dispute.withdrawClaim({ claim: REF_A }), 'not_claimer');
      expect(port.withdrawn).toEqual([]);
    }
  });

  it('says what the order of the refusals is: not Open before not the claimer before a window that has not ended', async () => {
    const { port, dispute } = rig();
    port.claims = [mine({ state: 'Challenged', claimer_key_hash: OTHER_KEY_HASH, submitted_at: NOW })];
    expectWithdrawRefused(await dispute.withdrawClaim({ claim: REF_A }), 'claim_not_open');
    port.claims = [mine({ claimer_key_hash: OTHER_KEY_HASH, submitted_at: NOW })];
    expectWithdrawRefused(await dispute.withdrawClaim({ claim: REF_A }), 'not_claimer');
  });

  it('refuses a reference that is not an output reference, and says chain_unavailable when the claim cannot be read', async () => {
    const { events, port, dispute } = rig();
    port.claims = [mine()];
    expectWithdrawRefused(await dispute.withdrawClaim({ claim: 'zq9' }), 'bad_shape');
    expect(events).toEqual([]);
    port.readClaimAnswer = () => new Error('node down');
    expectWithdrawRefused(await dispute.withdrawClaim({ claim: REF_A }), 'chain_unavailable');
    expect(port.withdrawn).toEqual([]);
  });

  it('says whether the withdrawal was built, and whether it can still land', async () => {
    const built = rig();
    built.port.claims = [mine()];
    built.port.withdrawAnswer = () => ({ ok: false, code: 'not_built', detail: 'Too early.' });
    expectWithdrawRefused(await built.dispute.withdrawClaim({ claim: REF_A }), 'withdraw_not_built');
    const late = rig();
    late.port.claims = [mine()];
    late.port.withdrawAnswer = () => ({ ok: false, code: 'not_confirmed', detail: 'late', tx_hash: CHALLENGE_TX, valid_to: NOW + HOUR, may_land: false });
    const result = await late.dispute.withdrawClaim({ claim: REF_A });
    expectWithdrawRefused(result, 'withdraw_not_confirmed');
    expect(result.sent).toEqual({ tx_hash: CHALLENGE_TX, valid_to: NOW + HOUR, may_land: false });
    const thrown = rig();
    thrown.port.claims = [mine()];
    thrown.port.withdrawAnswer = () => { throw new Error('boom'); };
    expectWithdrawRefused(await thrown.dispute.withdrawClaim({ claim: REF_A }), 'port_error');
  });
});
