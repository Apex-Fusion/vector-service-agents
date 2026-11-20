// packages/usecase-kit/test/dispute/target.test.ts: the claim that a challenge names, on a scripted chain port. A challenge names only a claim of this kit: a claim whose claim document is on chain, is
// the document that the claim holds by hash, and is the document that `claimDocument` writes for the claimer. Among the open claims of the other party that are claims of this kit and have enough window
// left at the moment of the publish, the one with the latest challenge deadline is the target. Each refusal has an accepted twin.
import { describe, expect, it } from 'vitest';
import { documentHash, documentUri } from '@vsa/buyer-core';
import { NO_OPEN_CLAIM } from '@vsa/usecase-kit/protocol';
import { Dispute, claimDocument } from '@vsa/usecase-kit/dispute';
import type { ChallengeResult, ClaimView, DeliveryChallengeInput } from '@vsa/usecase-kit/dispute';
import {
  ESCROW, EVIDENCE_TX, HOUR, MANIFEST_SHA, NOW, ORDER_FACTS, OTHER, PRIOR_AUTHORIZATION_CLAIM, REF_A, REF_B, REF_C, RecordingQueue, STATEMENT_S1, SETTINGS, ScriptedPort, THIRD, TOKEN_A, TOKEN_B, TOKEN_C,
  claimView, kitClaimDocument, never, rig,
} from './support.ts';
import type { Rig } from './support.ts';

const delivery = (): DeliveryChallengeInput => ({ counterparty: OTHER, escrow_ref: ESCROW, evidence: ORDER_FACTS });
const textOf = (bytes: Uint8Array): string => Buffer.from(bytes).toString('utf8');

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
  const document = claimDocument({ agent_did: claimer, capability_id: 'health.priorauth.draft.v1', manifest_sha256: MANIFEST_SHA, claim: PRIOR_AUTHORIZATION_CLAIM });
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
  ];

  it.each(NOT_KIT)('leaves out a claim with %s, says how many claims were left out, and publishes nothing', async (_name, make) => {
    const rigged = rig();
    rigged.port.claims = [make(rigged)];
    const result = await rigged.dispute.challengeDelivery(delivery());
    expectNotFiled(result, NO_OPEN_CLAIM);
    expect(result.detail).toContain('the agent has 1 open claim(s), and none can be challenged: 1 without a claim document of this kit, 0 with a challenge window that ends too soon');
    expect(rigged.port.published).toEqual([]);
    expect(rigged.port.challenged).toEqual([]);
    expect(rigged.events).toEqual(['readClaims', `readDocument ${rigged.port.claims[0]!.claim_uri}`]);
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
      expect(rigged.events, uri).toEqual(['readClaims']);
    }
  });

  it('leaves out a claim whose hash is hex of another length than 64 characters, without reading its document, and says chain_unavailable for a hash that is not lower-case hex', async () => {
    for (const hash of ['', 'ab', 'ab'.repeat(33)]) {
      const rigged = rig();
      rigged.port.claims = [claimView({ claim_hash: hash })];
      expectNotFiled(await rigged.dispute.challengeDelivery(delivery()), NO_OPEN_CLAIM);
      expect(rigged.events).toEqual(['readClaims']);
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

  it('does not read the document of a claim that is not a candidate: a claim of another agent, a claim that is not open, and a claim whose window ended', async () => {
    const rigged = rig();
    rigged.port.claims = [
      claimView({ ref: REF_B, token: TOKEN_B, claimer: THIRD }), claimView({ ref: REF_C, token: TOKEN_C, state: 'Validated' }), claimView({ submitted_at: NOW - 5 * HOUR }),
    ];
    expectNotFiled(await rigged.dispute.challengeDelivery(delivery()), NO_OPEN_CLAIM);
    expect(rigged.events).toEqual(['readClaims']);
  });

  it('names the statement of the claim document that the claim holds, and not a statement of the facts', async () => {
    const rigged = rig();
    const document = otherStatements(OTHER);
    rigged.port.claims = [holding(rigged.port, claimView(), document.bytes)];
    expect((await rigged.dispute.challengeDelivery(delivery())).ok).toBe(true);
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
    expect((await rigged.dispute.challengeDelivery(delivery())).ok).toBe(true);
    const text = textOf(rigged.port.published[0]!.bytes);
    expect(text).toContain('[cut: the text of the value has 1002 characters]');
    expect(text).not.toContain('x'.repeat(400));
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(3_000);
  });
});

describe('the newest open claim of the other party is the target', () => {
  /** An open claim of the other party that ends `left` milliseconds after the clock, with a window of four hours. */
  const endingIn = (ref: string, token: string, left: number): ClaimView => claimView({ ref, token, submitted_at: NOW + left - 4 * HOUR });
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

  it('says claim_ambiguous when two claims of this kit have the same latest challenge deadline, whatever the order, and files nothing', async () => {
    const same = [endingIn(REF_A, TOKEN_A, 3 * HOUR), endingIn(REF_B, TOKEN_B, 3 * HOUR)];
    for (const claims of [same, [...same].reverse(), [EARLIER, ...same], [...same, EARLIER]]) {
      const { events, port, dispute } = rig();
      port.claims = claims;
      const result = await dispute.challengeDelivery(delivery());
      expectNotFiled(result, 'claim_ambiguous');
      expect(result.detail).toContain('2 open claims of this kit');
      expect(port.published).toEqual([]);
      expect(events.filter((event) => event.startsWith('readDocument'))).toEqual([...same].sort((a, b) => (a.ref < b.ref ? -1 : 1)).map((claim) => `readDocument ${claim.claim_uri}`));
    }
  });

  it('does not say claim_ambiguous for a tie below the newest claim, and does not when one of the two claims is not a claim of this kit', async () => {
    const lower = rig();
    lower.port.claims = [endingIn(REF_A, TOKEN_A, 2 * HOUR), endingIn(REF_B, TOKEN_B, 2 * HOUR), LATEST];
    expect((await lower.dispute.challengeDelivery(delivery())).ok).toBe(true);
    expect(lower.port.challenged.map((call) => call.claim)).toEqual([REF_C]);
    const twin = rig();
    const notKit = { ...endingIn(REF_B, TOKEN_B, 3 * HOUR), claim_hash: 'ab'.repeat(32) };
    twin.port.claims = [endingIn(REF_A, TOKEN_A, 3 * HOUR), notKit];
    expect((await twin.dispute.challengeDelivery(delivery())).ok).toBe(true);
    expect(twin.port.challenged.map((call) => call.claim)).toEqual([REF_A]);
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
    expect(result.detail).toBe('the agent has 3 open claim(s), and none can be challenged: 2 without a claim document of this kit, 1 with a challenge window that ends too soon');
  });

  it('gives the newest claim of this kit from findOpenClaim, and not claim_ambiguous for claims that end at different moments', async () => {
    const { port, dispute } = rig();
    port.claims = [EARLIER, LATER, LATEST];
    expect(await dispute.findOpenClaim(OTHER)).toMatchObject({ ok: true, value: { ref: REF_C } });
    port.claims = [{ ...LATEST, claim_hash: 'ab'.repeat(32) }, LATER];
    expect(await dispute.findOpenClaim(OTHER)).toMatchObject({ ok: true, value: { ref: REF_A } });
    port.claims = [EARLIER, { ...EARLIER, ref: REF_C, token: TOKEN_C }];
    expect(await dispute.findOpenClaim(OTHER)).toMatchObject({ ok: false, code: 'claim_ambiguous' });
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
    expect(rigged.events).toEqual(['readClaims', expect.stringContaining('readDocument'), 'waited 1800000']);
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
