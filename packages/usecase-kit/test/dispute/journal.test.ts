// packages/usecase-kit/test/dispute/journal.test.ts: one challenge for a job, also after a restart. The journal is written before the evidence is sent and after each step that landed, and a new call
// reads it first: a job with a record gets that state, and nothing is sent a second time. A challenge of this agent for this job that is on chain is found again, and it is the result.
import { describe, expect, it } from 'vitest';
import { documentUri } from '@vsa/buyer-core';
import { NO_OPEN_CLAIM } from '@vsa/usecase-kit/protocol';
import { MemoryJournal } from '@vsa/usecase-kit/dispute';
import type { ChallengeResult, ChallengeView, DeliveryChallengeInput, DisputeJournal, JobRecord } from '@vsa/usecase-kit/dispute';
import {
  CHALLENGE_TOKEN, CHALLENGE_TX, ESCROW, ESCROW_2, EVIDENCE_TX, HOUR, KEY_HASH, NOW, ORDER_FACTS, OTHER, REF_A, REF_B, THIRD, TOKEN_A, TOKEN_B, challengeView, claimView, deferred, evidenceOf, never, rig,
} from './support.ts';
import type { Events, Rig } from './support.ts';

const delivery = (escrow = ESCROW): DeliveryChallengeInput => ({ counterparty: OTHER, escrow_ref: escrow, evidence: ORDER_FACTS });
const LANDED = { tx_hash: EVIDENCE_TX, uri: documentUri(EVIDENCE_TX), document_hash: evidenceOf().hash };
const record = (extra: Partial<JobRecord> = {}): JobRecord => ({ step: 'started', against: OTHER, claim: REF_A, claim_token: TOKEN_A, evidence: null, filed: null, ended: null, ...extra });
const CHAIN_FILED = {
  record: { claim: REF_A, evidence: EVIDENCE_TX, challenge: `${CHALLENGE_TX}#0` }, claim_token: TOKEN_A, against_did: OTHER, evidence_uri: documentUri(EVIDENCE_TX), evidence_hash: evidenceOf().hash,
  challenge_tx: CHALLENGE_TX, challenge_token: CHALLENGE_TOKEN, stake_lovelace: 50_000_000n, deadline: NOW - 10 * 60_000 + 72 * HOUR, fee_lovelace: null,
};

function expectNotFiled(result: ChallengeResult, code: string): asserts result is Extract<ChallengeResult, { ok: false }> {
  expect(result).toMatchObject({ ok: false, code });
}

/** A journal that writes each call to the events, and keeps the records that were put. */
function recording(events: Events, inner: DisputeJournal = new MemoryJournal()): DisputeJournal & { readonly puts: JobRecord[] } {
  const puts: JobRecord[] = [];
  return {
    puts,
    get: async (escrow) => { events.push('journal get'); return inner.get(escrow); },
    put: async (escrow, value) => { events.push(`journal put ${value.step}`); puts.push(value); return inner.put(escrow, value); },
  };
}

/** The chain in which this agent has challenged the claim of OTHER for the job ESCROW: the claim is Challenged, and the challenge and its evidence are on chain. */
function ownChallenge(rigged: Rig, challenge: Partial<ChallengeView> = {}, bytes: Uint8Array = evidenceOf().bytes): void {
  rigged.port.claims = [claimView({ state: 'Challenged' })];
  rigged.port.challenges = [challengeView(challenge)];
  rigged.port.documents.set(documentUri(EVIDENCE_TX), { bytes, type: 'evidence', media_type: 'text/plain' });
}

describe('the journal is written before the evidence is sent and after each step that landed', () => {
  it('writes started inside the job before the publish, then evidence_landed, then done, and reads first', async () => {
    const events: Events = [];
    const journal = recording(events);
    const { port, dispute } = rig({}, { journal, events });
    port.claims = [claimView()];
    expect((await dispute.challengeDelivery(delivery())).ok).toBe(true);
    expect(journal.puts.map((value) => value.step)).toEqual(['started', 'evidence_landed', 'done']);
    expect(journal.puts[0]).toEqual(record());
    expect(journal.puts[1]).toEqual(record({ step: 'evidence_landed', evidence: LANDED }));
    expect(journal.puts[2]).toMatchObject({ step: 'done', evidence: LANDED, ended: null, filed: { record: { claim: REF_A, evidence: EVIDENCE_TX }, stake_lovelace: '50000000', fee_lovelace: '900000' } });
    const order = events.filter((event) => event.startsWith('journal') || event.startsWith('publish') || event.startsWith('openChallenge') || event.startsWith('queue') || event === 'readClaims');
    expect(order).toEqual([
      'journal get', 'readClaims', 'queue:start', 'journal put started', 'publish evidence', 'queue:end', 'journal put evidence_landed', 'queue:start', `openChallenge ${REF_A}`, 'queue:end', 'journal put done',
    ]);
  });

  it('writes the step that landed when the evidence is not confirmed, when the challenge is not built, and when it is not confirmed', async () => {
    const cases: Array<[string, (rigged: Rig) => void, string[]]> = [
      ['evidence_not_confirmed', ({ port }) => { port.publishAnswer = () => ({ ok: false, code: 'not_confirmed', detail: 'late', tx_hash: EVIDENCE_TX, valid_to: NOW + HOUR, may_land: true }); }, ['started', 'done']],
      ['challenge_not_built', ({ port }) => { port.openChallengeAnswer = () => ({ ok: false, code: 'not_built', detail: 'x' }); }, ['started', 'evidence_landed', 'done']],
      ['challenge_not_confirmed', ({ port }) => { port.openChallengeAnswer = () => ({ ok: false, code: 'not_confirmed', detail: 'x', tx_hash: CHALLENGE_TX, valid_to: NOW + HOUR, may_land: true }); }, ['started', 'evidence_landed', 'done']],
    ];
    for (const [code, change, steps] of cases) {
      const journal = recording([]);
      const rigged = rig({}, { journal });
      rigged.port.claims = [claimView()];
      change(rigged);
      expectNotFiled(await rigged.dispute.challengeDelivery(delivery()), code);
      expect(journal.puts.map((value) => value.step), code).toEqual(steps);
      expect(journal.puts.at(-1)!.ended, code).toMatchObject({ code });
    }
  });

  it('writes not_sent when the evidence is not built, and nothing when the job stops before it sends anything', async () => {
    const journal = recording([]);
    const { port, dispute } = rig({}, { journal });
    port.claims = [claimView()];
    port.publishAnswer = () => ({ ok: false, code: 'not_built', detail: 'no collateral' });
    expectNotFiled(await dispute.challengeDelivery(delivery()), 'evidence_not_built');
    expect(journal.puts.map((value) => value.step)).toEqual(['started', 'not_sent']);
    // A job that stops at the lookup writes no record at all.
    const early = recording([]);
    const none = rig({}, { journal: early });
    expectNotFiled(await none.dispute.challengeDelivery(delivery()), NO_OPEN_CLAIM);
    expect(early.puts).toEqual([]);
  });
});

describe('a job with a record gets its recorded state, and nothing is sent a second time', () => {
  it('gives the filed challenge to a new process that has the journal of the first, and reads and sends nothing', async () => {
    const journal = new MemoryJournal();
    const first = rig({}, { journal });
    first.port.claims = [claimView()];
    const filed = await first.dispute.challengeDelivery(delivery());
    expect(filed.ok).toBe(true);
    const second = rig({}, { journal });
    second.port.claims = [claimView()];
    expect(await second.dispute.challengeDelivery(delivery())).toEqual(filed);
    expect(second.events).toEqual([]);
    expect(second.port.published).toEqual([]);
    expect(second.port.challenged).toEqual([]);
  });

  const IN_DOUBT: Array<[string, JobRecord, Record<string, unknown>]> = [
    ['a job that started', record(), { evidence: null }],
    ['a job whose evidence landed', record({ step: 'evidence_landed', evidence: LANDED }), { evidence: LANDED }],
    [
      'a job whose evidence was sent and not seen confirmed',
      record({ step: 'done', ended: { code: 'evidence_not_confirmed', detail: 'late', sent: { tx_hash: EVIDENCE_TX, valid_to: NOW + HOUR, may_land: true }, challenge: null, wrong_document: null } }),
      { sent: { tx_hash: EVIDENCE_TX, valid_to: NOW + HOUR, may_land: true } },
    ],
    [
      'a job that ended with a challenge on another claim',
      record({ step: 'done', evidence: LANDED, ended: { code: 'challenge_wrong_claim', detail: 'x', sent: null, challenge: { tx_hash: CHALLENGE_TX, challenge: `${CHALLENGE_TX}#0`, challenge_token: CHALLENGE_TOKEN, claim: REF_B, claim_token: TOKEN_A }, wrong_document: null } }),
      { evidence: LANDED, challenge: { tx_hash: CHALLENGE_TX } },
    ],
  ];

  it.each(IN_DOUBT)('does not send again for %s, and says what the record says', async (_name, stored, members) => {
    const journal = new MemoryJournal();
    await journal.put(ESCROW, stored);
    const { events, port, dispute } = rig({}, { journal });
    port.claims = [claimView()];
    const result = await dispute.challengeDelivery(delivery());
    expectNotFiled(result, 'job_already_disputed');
    expect(result).toMatchObject(members);
    expect(port.published).toEqual([]);
    expect(port.challenged).toEqual([]);
    // The chain is read first, and nothing is sent: the claim of the other party is still open here.
    expect(events).toEqual(['readClaims']);
  });

  it('files the job again when the record says that nothing was sent, and files another job that has no record', async () => {
    const journal = new MemoryJournal();
    await journal.put(ESCROW, record({ step: 'not_sent' }));
    const { port, dispute } = rig({}, { journal });
    port.claims = [claimView()];
    expect((await dispute.challengeDelivery(delivery())).ok).toBe(true);
    // The record of another job does not stop this job.
    const other = new MemoryJournal();
    await other.put(ESCROW_2, record());
    const rigged = rig({}, { journal: other });
    rigged.port.claims = [claimView()];
    expect((await rigged.dispute.challengeDelivery(delivery())).ok).toBe(true);
  });
});

describe('a challenge of this agent for this job that is on chain is found again', () => {
  it('gives the filed challenge with its references when the chosen claim is Challenged by this agent for this job, with no record', async () => {
    const rigged = rig();
    ownChallenge(rigged);
    const result = await rigged.dispute.challengeDelivery(delivery());
    expect(result).toEqual({ ok: true, value: CHAIN_FILED });
    expect(rigged.events).toEqual(['readClaims', 'readChallenges', `readDocument ${documentUri(EVIDENCE_TX)}`]);
    expect(rigged.port.published).toEqual([]);
    expect(rigged.port.challenged).toEqual([]);
    // The record says it now: the next call needs no read.
    rigged.events.length = 0;
    expect(await rigged.dispute.challengeDelivery(delivery())).toEqual(result);
    expect(rigged.events).toEqual([]);
  });

  it('gives it for a record that says that the challenge may have landed, and the recorded fees are not invented', async () => {
    const journal = new MemoryJournal();
    await journal.put(ESCROW, record({ step: 'done', evidence: LANDED, ended: { code: 'challenge_not_confirmed', detail: 'late', sent: { tx_hash: CHALLENGE_TX, valid_to: NOW + HOUR, may_land: true }, challenge: null, wrong_document: null } }));
    const rigged = rig({}, { journal });
    ownChallenge(rigged);
    const result = await rigged.dispute.challengeDelivery(delivery());
    expect(result).toMatchObject({ ok: true, value: { record: { challenge: `${CHALLENGE_TX}#0` }, fee_lovelace: null } });
    expect(rigged.port.challenged).toEqual([]);
  });

  it('files no second challenge for the job although the other party has another open claim', async () => {
    const rigged = rig();
    ownChallenge(rigged);
    rigged.port.claims = [claimView({ state: 'Challenged' }), claimView({ ref: REF_B, token: TOKEN_B })];
    expect((await rigged.dispute.challengeDelivery(delivery())).ok).toBe(true);
    expect(rigged.port.challenged).toEqual([]);
    expect(rigged.port.published).toEqual([]);
  });

  const NOT_OURS: Array<[string, (rigged: Rig) => void]> = [
    ['a challenge of another agent', (rigged) => ownChallenge(rigged, { auditor: THIRD })],
    ['a challenge of the same agent with another key', (rigged) => ownChallenge(rigged, { auditor_key_hash: '0e'.repeat(28) })],
    ['a challenge of a claim that is not the claim that is Challenged', (rigged) => ownChallenge(rigged, { claim_token: TOKEN_B })],
    ['evidence that names another job', (rigged) => ownChallenge(rigged, {}, evidenceOf({ escrow_ref: ESCROW_2 }).bytes)],
    ['evidence that names another challenger', (rigged) => ownChallenge(rigged, {}, evidenceOf({ by_did: THIRD }).bytes)],
    ['evidence that names another claimer', (rigged) => ownChallenge(rigged, {}, evidenceOf({ against_did: THIRD }).bytes)],
    ['a hash that is not the hash of the evidence', (rigged) => ownChallenge(rigged, { evidence_hash: 'ab'.repeat(32) })],
    ['evidence that is not an evidence document', (rigged) => ownChallenge(rigged, {}, Buffer.from('some text\n'))],
    ['an evidence address that is not a vector-tx address', (rigged) => ownChallenge(rigged, { evidence_uri: 'https://example.org/e' })],
  ];

  it.each(NOT_OURS)('does not take %s for the challenge of this job, and files nothing', async (_name, set) => {
    const rigged = rig();
    set(rigged);
    expectNotFiled(await rigged.dispute.challengeDelivery(delivery()), NO_OPEN_CLAIM);
    expect(rigged.port.published).toEqual([]);
    expect(rigged.port.challenged).toEqual([]);
  });

  it('says chain_unavailable when the challenges or the evidence cannot be read, and never takes that for no open claim; the job is not used up', async () => {
    const challenges = rig();
    ownChallenge(challenges);
    challenges.port.readChallengesFails = new Error('down');
    expectNotFiled(await challenges.dispute.challengeDelivery(delivery()), 'chain_unavailable');
    const evidence = rig();
    ownChallenge(evidence);
    const normal = evidence.port.readDocumentAnswer;
    evidence.port.readDocumentAnswer = () => new Error('Koios answered 503');
    expectNotFiled(await evidence.dispute.challengeDelivery(delivery()), 'chain_unavailable');
    evidence.port.readDocumentAnswer = normal;
    expect((await evidence.dispute.challengeDelivery(delivery())).ok).toBe(true);
  });
});

describe('the journal can fail', () => {
  const failing = (events: Events, fail: { get?: unknown; put?: (step: string) => boolean }): DisputeJournal => ({
    get: async () => { events.push('journal get'); if ('get' in fail) { if (fail.get instanceof Error) throw fail.get; return fail.get as never; } return null; },
    put: async (_escrow, value) => { if (fail.put?.(value.step)) throw new Error('EIO: the disk is full'); },
  });

  it('says journal_unavailable when a record cannot be read, and reads and sends nothing', async () => {
    const events: Events = [];
    const { port, dispute } = rig({}, { journal: failing(events, { get: new Error('EIO: the disk cannot be read') }) });
    port.claims = [claimView()];
    const result = await dispute.challengeDelivery(delivery());
    expectNotFiled(result, 'journal_unavailable');
    expect(result.detail).toContain('EIO');
    expect(port.events).toEqual([]);
    expect(port.published).toEqual([]);
  });

  const BAD_RECORDS: Array<[string, unknown]> = [
    ['a record that is not an object', 'started'],
    ['no record member', undefined],
    ['a step that does not exist', { ...record(), step: 'finished' }],
    ['a member that the record does not have', { ...record(), extra: 1 }],
    ['a member that is missing', (({ against: _against, ...rest }) => rest)(record())],
    ['a claimer that is not a DID', { ...record(), against: 'zq9' }],
    ['a claim token that is not a claim token', { ...record(), claim_token: 'ab' }],
    ['evidence with a hash that is not a hash', { ...record({ step: 'evidence_landed' }), evidence: { ...LANDED, document_hash: 'zz' } }],
    ['a done record with neither filed nor ended', record({ step: 'done' })],
    ['a started record that says it is filed', { ...record(), filed: { ...CHAIN_FILED, stake_lovelace: '1', fee_lovelace: null } }],
    ['a done record with a stake that is not digits', { ...record({ step: 'done' }), filed: { ...CHAIN_FILED, stake_lovelace: '1.5', fee_lovelace: null } }],
    ['a done record with a code that is not text', record({ step: 'done', ended: { code: 7 as never, detail: 'x', sent: null, challenge: null, wrong_document: null } })],
    ['a done record with a sent transaction of a wrong form', record({ step: 'done', ended: { code: 'x', detail: 'x', sent: { tx_hash: 'zz', valid_to: 1, may_land: true }, challenge: null, wrong_document: null } })],
  ];

  it.each(BAD_RECORDS)('says journal_unavailable for %s, and sends nothing: a record that exists is never taken for no record', async (_name, stored) => {
    const events: Events = [];
    const { port, dispute } = rig({}, { journal: failing(events, { get: stored }) });
    port.claims = [claimView()];
    expectNotFiled(await dispute.challengeDelivery(delivery()), 'journal_unavailable');
    expect(port.published).toEqual([]);
    expect(port.challenged).toEqual([]);
  });

  it('accepts a done record of each kind that the code writes, as the twin of the records above', async () => {
    const filed = { ...CHAIN_FILED, stake_lovelace: '50000000', fee_lovelace: '900000' };
    const ended = { code: 'challenge_not_built', detail: 'x', sent: null, challenge: null, wrong_document: null };
    for (const stored of [record({ step: 'done', evidence: LANDED, filed }), record({ step: 'done', evidence: LANDED, ended }), record({ step: 'not_sent' }), record({ step: 'evidence_landed', evidence: LANDED })]) {
      const { dispute } = rig({}, { journal: failing([], { get: JSON.parse(JSON.stringify(stored)) }) });
      const result = await dispute.challengeDelivery(delivery());
      expect(['journal_unavailable']).not.toContain(result.ok ? 'ok' : result.code);
    }
  });

  it('refuses to send when the record before the evidence cannot be stored, and nothing was sent', async () => {
    const { port, dispute } = rig({}, { journal: failing([], { put: (step) => step === 'started' }) });
    port.claims = [claimView()];
    const result = await dispute.challengeDelivery(delivery());
    expectNotFiled(result, 'journal_unavailable');
    expect(result.detail).toContain('nothing was sent');
    expect(port.published).toEqual([]);
    expect(port.challenged).toEqual([]);
  });

  it('keeps the result of a step that landed when its record cannot be stored, and says so in the log', async () => {
    for (const step of ['evidence_landed', 'done']) {
      const { logs, port, dispute } = rig({}, { journal: failing([], { put: (name) => name === step }) });
      port.claims = [claimView()];
      expect((await dispute.challengeDelivery(delivery())).ok, step).toBe(true);
      expect(port.challenged.length, step).toBe(1);
      expect(logs.some((line) => line.includes('the journal did not store') && line.includes(step)), step).toBe(true);
    }
  });

  it('says journal_unavailable when the journal does not answer within the bound, and sends nothing', async () => {
    const fire = deferred<void>();
    const read = rig({ read_timeout_ms: 7_000 }, { sleep: () => fire.promise, journal: { get: () => { fire.resolve(); return never(); }, put: async () => undefined } });
    read.port.claims = [claimView()];
    const result = await read.dispute.challengeDelivery(delivery());
    expectNotFiled(result, 'journal_unavailable');
    expect(result.detail).toContain('did not answer');
    const write = rig({}, { sleep: () => fire.promise, journal: { get: async () => null, put: () => never() } });
    write.port.claims = [claimView()];
    expectNotFiled(await write.dispute.challengeDelivery(delivery()), 'journal_unavailable');
    expect(write.port.published).toEqual([]);
  });
});

describe('the journal in memory', () => {
  it('gives back the record that was put, as a copy, and null for a job with no record', async () => {
    const journal = new MemoryJournal();
    expect(await journal.get(ESCROW)).toBeNull();
    await journal.put(ESCROW, record());
    const first = (await journal.get(ESCROW))!;
    expect(first).toEqual(record());
    Object.assign(first, { step: 'done' });
    expect((await journal.get(ESCROW))!.step).toBe('started');
    expect(await journal.get(ESCROW_2)).toBeNull();
  });

  it('refuses a record that is not JSON data, so that a bigint cannot get in', async () => {
    const journal = new MemoryJournal();
    await expect(journal.put(ESCROW, { ...record(), claim: 5n as never })).rejects.toThrow();
    expect(KEY_HASH).toHaveLength(56);
  });
});
