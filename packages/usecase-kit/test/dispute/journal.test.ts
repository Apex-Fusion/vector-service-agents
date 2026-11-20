// packages/usecase-kit/test/dispute/journal.test.ts: one challenge for a job, also after a restart. The journal is written before the evidence is sent and after each step that landed, and a new call
// reads it first: a job with a record gets that state, and nothing is sent a second time. A challenge of this agent for this job that is on chain is found again, and it is the result.
import { describe, expect, it } from 'vitest';
import { HireLane } from '@vsa/hire-kit';
import { documentUri } from '@vsa/buyer-core';
import { NO_OPEN_CLAIM } from '@vsa/usecase-kit/protocol';
import { MemoryJournal } from '@vsa/usecase-kit/dispute';
import type { ChallengeResult, ChallengeView, ClaimView, DeliveryChallengeInput, DisputeJournal, DisputeSettings, JobRecord, OpenedChallenge, TxResult } from '@vsa/usecase-kit/dispute';
import {
  CHALLENGE_TOKEN, CHALLENGE_TX, ESCROW, ESCROW_2, EVIDENCE_TX, HOUR, JOB, KEY_HASH, NO_DOCUMENT, NO_TRANSACTION, NOW, ORDER_FACTS, OTHER, OTHER_KEY_HASH, REF_A, REF_B, THIRD, TOKEN_A, TOKEN_B, challengeView, claimView,
  deferred, evidenceOf, never, rig,
} from './support.ts';
import type { Events, Rig, ScriptedPort } from './support.ts';

const delivery = (escrow = ESCROW): DeliveryChallengeInput => ({ counterparty: OTHER, escrow_ref: escrow, ...JOB, evidence: ORDER_FACTS });
const LANDED = { tx_hash: EVIDENCE_TX, uri: documentUri(EVIDENCE_TX), document_hash: evidenceOf().hash };
const record = (extra: Partial<JobRecord> = {}): JobRecord => ({
  step: 'started', escrow: ESCROW, against: OTHER, claim: REF_A, claim_token: TOKEN_A, started_at: NOW, evidence: null, filed: null, ended: null, ...extra,
});
const CHAIN_FILED = {
  record: { claim: REF_A, evidence: EVIDENCE_TX, challenge: `${CHALLENGE_TX}#0` }, claim_token: TOKEN_A, against_did: OTHER, evidence_uri: documentUri(EVIDENCE_TX), evidence_hash: evidenceOf().hash,
  challenge_tx: CHALLENGE_TX, challenge_token: CHALLENGE_TOKEN, stake_lovelace: 50_000_000n, deadline: NOW - 10 * 60_000 + 72 * HOUR, fee_lovelace: null, extra_evidence: null,
};

/** The challenge of this agent that the first try of a lapsed job landed: its evidence document is another transaction than the evidence document of the second try. */
const FIRST_EVIDENCE_TX = '76'.repeat(32);
const FIRST_CHALLENGE_TX = '98'.repeat(32);
const FIRST_FILED = {
  ...CHAIN_FILED, record: { claim: REF_A, evidence: FIRST_EVIDENCE_TX, challenge: `${FIRST_CHALLENGE_TX}#0` }, evidence_uri: documentUri(FIRST_EVIDENCE_TX), challenge_tx: FIRST_CHALLENGE_TX,
};

/** The result for that challenge when the second try published its own evidence document (`EVIDENCE_TX`) before the job found the challenge: the result names that document. */
const AFTER_SECOND_TRY = { ...FIRST_FILED, extra_evidence: EVIDENCE_TX };

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

/** A journal that has no record at the first read of a job and gives `stored` at each later read: another call wrote its record while this job waited in the queue. Its `put` stores nothing. */
const onSecondRead = (stored: JobRecord): DisputeJournal => {
  let reads = 0;
  return { get: async () => { reads += 1; return reads === 1 ? null : stored; }, put: async () => undefined };
};

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
      'journal get', 'readClaims', 'queue:start', 'journal get', 'journal put started', 'publish evidence', 'queue:end', 'journal put evidence_landed', 'queue:start', `openChallenge ${REF_A}`, 'queue:end',
      'journal put done',
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

  it('gives the extra evidence document that the record keeps, and reads and sends nothing', async () => {
    const journal = new MemoryJournal();
    await journal.put(ESCROW, record({ step: 'done', evidence: { ...LANDED, tx_hash: FIRST_EVIDENCE_TX, uri: documentUri(FIRST_EVIDENCE_TX) }, filed: { ...FIRST_FILED, stake_lovelace: '50000000', extra_evidence: EVIDENCE_TX } }));
    const { events, port, dispute } = rig({}, { journal });
    port.claims = [claimView()];
    expect(await dispute.challengeDelivery(delivery())).toEqual({ ok: true, value: AFTER_SECOND_TRY });
    expect(events).toEqual([]);
    expect(port.published).toEqual([]);
    expect(port.challenged).toEqual([]);
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
    await other.put(ESCROW_2, record({ escrow: ESCROW_2 }));
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
    expect(result).toMatchObject({ ok: true, value: { record: { challenge: `${CHALLENGE_TX}#0` }, fee_lovelace: null, extra_evidence: null } });
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

  /** Members that Module-1 does not check, and that another auditor can fill with any value: the output is still a challenge of another auditor, and it is not read further. */
  const FOREIGN: Array<[string, Partial<Record<keyof ChallengeView, unknown>>]> = [
    ['a claim token that is not a claim token', { claim_token: 'ff'.repeat(32) }],
    ['a resolution deadline below 0', { resolution_deadline_ms: -1 }],
    ['a resolution deadline that is not a number', { resolution_deadline_ms: 'zq9' }],
    ['a stake that is not a bigint', { stake_lovelace: 5 }],
    ['a claim reference that is not a reference', { claim: 'zq9' }],
    ['a state that does not exist', { state: 'Weird' }],
    ['no evidence address', { evidence_uri: undefined }],
    ['no member at all that Module-1 leaves free', {}],
  ];

  it.each(FOREIGN)('skips the challenge of another auditor with %s, and challenges the claim of the other party', async (_name, bad) => {
    const rigged = rig();
    rigged.port.claims = [claimView(), claimView({ ref: REF_B, token: TOKEN_B, state: 'Challenged' })];
    rigged.port.challenges = [{ ...challengeView({ auditor: THIRD, auditor_key_hash: '0e'.repeat(28), claim: REF_B, claim_token: TOKEN_B }), ...bad } as ChallengeView];
    expect((await rigged.dispute.challengeDelivery(delivery())).ok).toBe(true);
    expect(rigged.port.challenged.map((call) => call.claim)).toEqual([REF_A]);
    expect(rigged.port.published.length).toBe(1);
  });

  it('says chain_unavailable for the same members in a challenge of this agent, and for a challenger that the code cannot tell, because the code writes its own challenges', async () => {
    const wrong: Array<[string, Partial<Record<keyof ChallengeView, unknown>>]> = [
      ['a claim token that is not a claim token', { claim_token: 'ff'.repeat(32) }],
      ['a resolution deadline below 0', { resolution_deadline_ms: -1 }],
      ['no evidence address', { evidence_uri: undefined }],
      ['a challenger that is not a DID', { auditor: 'zq9' }],
      ['a key hash that is not a hash', { auditor_key_hash: 'zq9' }],
      ['no key hash member', { auditor_key_hash: undefined }],
    ];
    for (const [name, bad] of wrong) {
      const rigged = rig();
      rigged.port.claims = [claimView({ state: 'Challenged' })];
      rigged.port.challenges = [{ ...challengeView(), ...bad } as ChallengeView];
      expectNotFiled(await rigged.dispute.challengeDelivery(delivery()), 'chain_unavailable');
      expect(rigged.port.published, name).toEqual([]);
    }
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

  it('says chain_unavailable when the evidence document of a challenge of this agent is not found, and files nothing; the challenge is found again when the document is there', async () => {
    for (const absent of [NO_TRANSACTION, NO_DOCUMENT]) {
      const rigged = rig();
      ownChallenge(rigged);
      const normal = rigged.port.readDocumentAnswer;
      rigged.port.readDocumentAnswer = () => absent;
      expectNotFiled(await rigged.dispute.challengeDelivery(delivery()), 'chain_unavailable');
      expect(rigged.port.published).toEqual([]);
      expect(rigged.port.challenged).toEqual([]);
      rigged.port.readDocumentAnswer = normal;
      expect((await rigged.dispute.challengeDelivery(delivery())).ok).toBe(true);
    }
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
    ['no escrow member', (({ escrow: _escrow, ...rest }) => rest)(record())],
    ['no start time member', (({ started_at: _startedAt, ...rest }) => rest)(record())],
    ['a start time that is a text', { ...record(), started_at: String(NOW) }],
    ['a start time that is null', { ...record(), started_at: null }],
    ['a start time that is not a whole number', { ...record(), started_at: NOW + 0.5 }],
    ['a start time of 0', { ...record(), started_at: 0 }],
    ['a start time below 0', { ...record(), started_at: -1 }],
    ['an escrow that is not an output reference', { ...record(), escrow: 'zq9' }],
    ['a claimer that is not a DID', { ...record(), against: 'zq9' }],
    ['a claim token that is not a claim token', { ...record(), claim_token: 'ab' }],
    ['evidence with a hash that is not a hash', { ...record({ step: 'evidence_landed' }), evidence: { ...LANDED, document_hash: 'zz' } }],
    ['a done record with neither filed nor ended', record({ step: 'done' })],
    ['a started record that says it is filed', { ...record(), filed: { ...CHAIN_FILED, stake_lovelace: '1', fee_lovelace: null } }],
    ['a done record with a stake that is not digits', { ...record({ step: 'done' }), filed: { ...CHAIN_FILED, stake_lovelace: '1.5', fee_lovelace: null } }],
    ['a done record with no extra evidence member', { ...record({ step: 'done' }), filed: (({ extra_evidence: _extra, ...rest }) => rest)({ ...CHAIN_FILED, stake_lovelace: '50000000' }) }],
    ['a done record with an extra evidence that is not a hash', { ...record({ step: 'done' }), filed: { ...CHAIN_FILED, stake_lovelace: '50000000', extra_evidence: 'zz' } }],
    ['a done record with an extra evidence that is a number', { ...record({ step: 'done' }), filed: { ...CHAIN_FILED, stake_lovelace: '50000000', extra_evidence: 7 } }],
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
    const withExtra = { ...filed, extra_evidence: FIRST_EVIDENCE_TX };
    for (const stored of [
      record({ step: 'done', evidence: LANDED, filed }), record({ step: 'done', evidence: LANDED, filed: withExtra }), record({ step: 'done', evidence: LANDED, ended }), record({ step: 'not_sent' }),
      record({ step: 'evidence_landed', evidence: LANDED }),
    ]) {
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
    const late = deferred<void>();
    const write = rig({}, { sleep: () => late.promise, journal: { get: async () => null, put: () => { late.resolve(); return never(); } } });
    write.port.claims = [claimView()];
    const stored = await write.dispute.challengeDelivery(delivery());
    expectNotFiled(stored, 'journal_unavailable');
    expect(stored.detail).toContain('nothing was sent');
    expect(write.port.published).toEqual([]);
  });
});

describe('two calls for one job never send twice', () => {
  it('stops the second of two calls that share the queue and the journal, in the job, and sends the evidence and the challenge once', async () => {
    const journal = new MemoryJournal();
    const lane = new HireLane();
    const events: Events = [];
    const first = rig({}, { journal, queue: lane, events });
    const second = rig({}, { journal, queue: lane, port: first.port });
    first.port.claims = [claimView()];
    const [a, b] = await Promise.all([first.dispute.challengeDelivery(delivery()), second.dispute.challengeDelivery(delivery())]);
    expect([a.ok, b.ok].sort()).toEqual([false, true]);
    const stopped = a.ok ? b : a;
    expectNotFiled(stopped, 'job_already_disputed');
    expect(stopped.detail).toContain('nothing was sent');
    expect(first.port.published.length).toBe(1);
    expect(first.port.challenged.length).toBe(1);
  });

  it('does not give the filed challenge of another counterparty for the same job', async () => {
    const journal = new MemoryJournal();
    await journal.put(ESCROW, record({ step: 'done', against: THIRD, evidence: LANDED, filed: { ...CHAIN_FILED, against_did: THIRD, stake_lovelace: '50000000', fee_lovelace: null } }));
    const { events, port, dispute } = rig({}, { journal });
    port.claims = [claimView()];
    const result = await dispute.challengeDelivery(delivery());
    expectNotFiled(result, 'job_already_disputed');
    expect(result.detail).toContain('another agent');
    expect(events).toEqual([]);
    expect(port.published).toEqual([]);
  });
});

describe('a record of another job is never the record of this job', () => {
  /** A journal that gives the record that is stored for `from`, whatever escrow it is asked for: the mistake that the code must not follow. */
  const misrouted = (inner: DisputeJournal, from: string): DisputeJournal => ({ get: async () => inner.get(from), put: (escrow, value) => inner.put(escrow, value) });
  const FILED = { ...CHAIN_FILED, stake_lovelace: '50000000', fee_lovelace: null };

  const OF_ANOTHER_JOB: Array<[string, JobRecord]> = [
    ['started', record()],
    ['evidence_landed', record({ step: 'evidence_landed', evidence: LANDED })],
    ['filed challenge', record({ step: 'done', evidence: LANDED, filed: FILED })],
    ['ended job', record({ step: 'done', evidence: LANDED, ended: { code: 'challenge_not_built', detail: 'x', sent: null, challenge: null, wrong_document: null } })],
    ['not_sent', record({ step: 'not_sent' })],
  ];

  it.each(OF_ANOTHER_JOB)('says journal_unavailable for the %s record of another escrow, does not read the chain, and sends nothing', async (_name, stored) => {
    const inner = new MemoryJournal();
    await inner.put(ESCROW, stored);
    const { events, port, dispute } = rig({}, { journal: misrouted(inner, ESCROW) });
    port.claims = [claimView()];
    const result = await dispute.challengeDelivery(delivery(ESCROW_2));
    expectNotFiled(result, 'journal_unavailable');
    expect(result.detail).toContain('another job');
    expect(events).toEqual([]);
    expect(port.published).toEqual([]);
    expect(port.challenged).toEqual([]);
  });

  it('gives the filed challenge of the same escrow from the same journal, as the twin', async () => {
    const inner = new MemoryJournal();
    await inner.put(ESCROW, record({ step: 'done', evidence: LANDED, filed: FILED }));
    const { events, dispute } = rig({}, { journal: misrouted(inner, ESCROW) });
    expect(await dispute.challengeDelivery(delivery(ESCROW))).toMatchObject({ ok: true, value: { record: { claim: REF_A, challenge: `${CHALLENGE_TX}#0` } } });
    expect(events).toEqual([]);
  });

  it('says journal_unavailable when the journal gives the record of another escrow in the job, right before the evidence is sent, and sends nothing', async () => {
    const other = rig({}, { journal: onSecondRead(record({ escrow: ESCROW_2 })) });
    other.port.claims = [claimView()];
    const result = await other.dispute.challengeDelivery(delivery());
    expectNotFiled(result, 'journal_unavailable');
    expect(result.detail).toContain('nothing was sent');
    expect(other.port.published).toEqual([]);
    // The twin: the record of this job at that read stops the job, as before.
    const same = rig({}, { journal: onSecondRead(record()) });
    same.port.claims = [claimView()];
    expectNotFiled(await same.dispute.challengeDelivery(delivery()), 'job_already_disputed');
    expect(same.port.published).toEqual([]);
  });

  it('writes the escrow of the job into every record that it stores, also for a challenge that it finds on chain', async () => {
    const stored = recording([]);
    const filed = rig({}, { journal: stored });
    filed.port.claims = [claimView()];
    expect((await filed.dispute.challengeDelivery(delivery())).ok).toBe(true);
    const found = recording([]);
    const chain = rig({}, { journal: found });
    ownChallenge(chain);
    expect((await chain.dispute.challengeDelivery(delivery())).ok).toBe(true);
    const puts = [...stored.puts, ...found.puts];
    expect(puts.length).toBe(4);
    expect(puts.map((value) => value.escrow)).toEqual([ESCROW, ESCROW, ESCROW, ESCROW]);
  });
});

describe('a record started gives the job back when its lease has passed', () => {
  const LEASE = 600_000;

  /** The call for the job when the journal holds a record `started` that is `age` milliseconds older than the clock of the dispute. */
  async function callAfter(age: number, settings: Partial<DisputeSettings> = {}) {
    const inner = new MemoryJournal();
    await inner.put(ESCROW, record({ started_at: NOW - age }));
    const journal = recording([], inner);
    const rigged = rig(settings, { journal });
    rigged.port.claims = [claimView()];
    return { ...rigged, journal, result: await rigged.dispute.challengeDelivery(delivery()) };
  }

  it('stops the job while the record is younger than the lease, says how long, and sends nothing', async () => {
    const { events, journal, port, result } = await callAfter(LEASE - 1);
    expectNotFiled(result, 'job_already_disputed');
    expect(result.detail).toContain(`${LEASE} ms`);
    expect(events).toEqual(['readClaims']);
    expect(port.published).toEqual([]);
    expect(port.challenged).toEqual([]);
    expect(journal.puts).toEqual([]);
  });

  it('goes on when the record is as old as the lease, files the challenge, and writes the time of the new start', async () => {
    const { journal, logs, port, result } = await callAfter(LEASE);
    expect(result.ok).toBe(true);
    expect(port.published.length).toBe(1);
    expect(port.challenged.length).toBe(1);
    expect(journal.puts.map((value) => [value.step, value.started_at])).toEqual([['started', NOW], ['evidence_landed', NOW], ['done', NOW]]);
    expect(logs.some((line) => line.includes('older than its lease'))).toBe(true);
  });

  const LEASES: Array<[string, Partial<DisputeSettings>, number]> = [
    ['10 minutes when the settings give no lease', {}, 600_000],
    ['twice the read bound when that is more than 10 minutes', { read_timeout_ms: 400_000 }, 800_000],
    ['the lease of the settings', { started_lease_ms: 120_000 }, 120_000],
    ['the least lease of the settings, twice the read bound', { read_timeout_ms: 400_000, started_lease_ms: 800_000 }, 800_000],
  ];

  it.each(LEASES)('uses %s', async (_name, settings, lease) => {
    expectNotFiled((await callAfter(lease - 1, settings)).result, 'job_already_disputed');
    expect((await callAfter(lease, settings)).result.ok).toBe(true);
  });

  it('counts the lease on the clock of the dispute: the same record stops the job, and gives it back when the clock has moved', async () => {
    const journal = new MemoryJournal();
    await journal.put(ESCROW, record());
    const { port, dispute, time } = rig({}, { journal });
    port.claims = [claimView()];
    time.now = NOW + LEASE - 1;
    expectNotFiled(await dispute.challengeDelivery(delivery()), 'job_already_disputed');
    expect(port.published).toEqual([]);
    time.now = NOW + LEASE;
    expect((await dispute.challengeDelivery(delivery())).ok).toBe(true);
    expect(port.published.length).toBe(1);
  });

  it('gives the challenge of this agent that is on chain for a record of any age, writes the time of the find, and sends nothing', async () => {
    for (const age of [LEASE - 1, LEASE]) {
      const inner = new MemoryJournal();
      await inner.put(ESCROW, record({ started_at: NOW - age }));
      const journal = recording([], inner);
      const rigged = rig({}, { journal });
      ownChallenge(rigged);
      expect(await rigged.dispute.challengeDelivery(delivery()), `age ${age}`).toEqual({ ok: true, value: CHAIN_FILED });
      expect(rigged.port.published).toEqual([]);
      expect(rigged.port.challenged).toEqual([]);
      expect(journal.puts).toMatchObject([{ step: 'done', started_at: NOW, filed: { record: { challenge: `${CHALLENGE_TX}#0` } } }]);
    }
  });

  it('never gives the job back for a record of another step, whatever its age', async () => {
    const ended = { code: 'challenge_not_built', detail: 'x', sent: null, challenge: null, wrong_document: null };
    for (const stored of [record({ step: 'evidence_landed', evidence: LANDED, started_at: 1 }), record({ step: 'done', evidence: LANDED, ended, started_at: 1 })]) {
      const journal = new MemoryJournal();
      await journal.put(ESCROW, stored);
      const { port, dispute } = rig({}, { journal });
      port.claims = [claimView()];
      expectNotFiled(await dispute.challengeDelivery(delivery()), 'job_already_disputed');
      expect(port.published).toEqual([]);
    }
    // The twin: a record `started` of the same age is given back.
    const old = new MemoryJournal();
    await old.put(ESCROW, record({ started_at: 1 }));
    const { port, dispute } = rig({}, { journal: old });
    port.claims = [claimView()];
    expect((await dispute.challengeDelivery(delivery())).ok).toBe(true);
  });

  it('uses the same rule in the job, where the journal is read again right before the evidence is sent', async () => {
    const young = rig({}, { journal: onSecondRead(record({ started_at: NOW - LEASE + 1 })) });
    young.port.claims = [claimView()];
    const stopped = await young.dispute.challengeDelivery(delivery());
    expectNotFiled(stopped, 'job_already_disputed');
    expect(stopped.detail).toContain('nothing was sent');
    expect(young.port.published).toEqual([]);
    const old = rig({}, { journal: onSecondRead(record({ started_at: NOW - LEASE })) });
    old.port.claims = [claimView()];
    expect((await old.dispute.challengeDelivery(delivery())).ok).toBe(true);
    expect(old.port.published.length).toBe(1);
  });

  it('writes the time that the clock gives in the job, and each later record of the job keeps it', async () => {
    const journal = recording([]);
    const rigged = rig({}, { journal });
    rigged.port.claims = [claimView()];
    // The clock moves while the claims are read, so the time of the job is later than the time of the first read of the journal.
    const read = rigged.port.readClaims.bind(rigged.port);
    rigged.port.readClaims = async () => {
      rigged.time.now += 5_000;
      return read();
    };
    expect((await rigged.dispute.challengeDelivery(delivery())).ok).toBe(true);
    expect(journal.puts.map((value) => value.started_at)).toEqual([NOW + 5_000, NOW + 5_000, NOW + 5_000]);
  });

  it('does not block the job for good when the write of the record started lands after its bound and nothing was sent', async () => {
    const inner = new MemoryJournal();
    const timers: Array<() => void> = [];
    const writing = deferred<void>();
    const landing = deferred<void>();
    const landed = deferred<void>();
    let late = true;
    const journal: DisputeJournal = {
      get: (escrow) => inner.get(escrow),
      put: async (escrow, value) => {
        if (late && value.step === 'started') {
          late = false;
          writing.resolve();
          await landing.promise;
          await inner.put(escrow, value);
          landed.resolve();
          return;
        }
        await inner.put(escrow, value);
      },
    };
    // Every bound of a read is a timer that the test fires by hand.
    const sleep = (): Promise<void> => {
      const timer = deferred<void>();
      timers.push(timer.resolve);
      return timer.promise;
    };
    const rigged = rig({}, { journal, sleep });
    rigged.port.claims = [claimView()];
    const first = rigged.dispute.challengeDelivery(delivery());
    await writing.promise;
    // The bound of the write ends while the write is still open.
    for (const fire of timers.splice(0)) fire();
    const stopped = await first;
    expectNotFiled(stopped, 'journal_unavailable');
    expect(stopped.detail).toContain('nothing was sent');
    expect(rigged.port.published).toEqual([]);
    // The write lands after the bound. The record says started, and nothing was sent.
    landing.resolve();
    await landed.promise;
    expect((await inner.get(ESCROW))?.step).toBe('started');
    // A call before the end of the lease still stops, and a call at the end of it files the challenge.
    expectNotFiled(await rigged.dispute.challengeDelivery(delivery()), 'job_already_disputed');
    expect(rigged.port.published).toEqual([]);
    rigged.time.now = NOW + LEASE;
    expect((await rigged.dispute.challengeDelivery(delivery())).ok).toBe(true);
    expect(rigged.port.published.length).toBe(1);
    expect(rigged.port.challenged.length).toBe(1);
  });
});

describe('a lapsed record gives the job back only for the claim that it names', () => {
  const LEASE = 600_000;
  const LEAST_WINDOW = 10 * 60_000;

  /** A claim of the other party that is a target and ends later than the claim REF_A: with no record, a challenge names it. */
  const later = (): ClaimView => claimView({ ref: REF_B, token: TOKEN_B, submitted_at: NOW - HOUR + 60_000, challenge_window_ms: 20 * HOUR });

  /** A dispute over `claims`, whose journal holds a record `started` of the claim REF_A that is as old as the lease. */
  async function lapsedOver(claims: ClaimView[]) {
    const inner = new MemoryJournal();
    await inner.put(ESCROW, record({ started_at: NOW - LEASE }));
    const journal = recording([], inner);
    const rigged = rig({}, { journal });
    rigged.port.claims = claims;
    return { ...rigged, journal };
  }

  it('files the challenge against the claim of the record, and not against the claim that ends later', async () => {
    const { journal, port, dispute } = await lapsedOver([claimView(), later()]);
    expect(await dispute.challengeDelivery(delivery())).toMatchObject({ ok: true, value: { record: { claim: REF_A }, claim_token: TOKEN_A } });
    // The evidence names the claim of the record, the challenge spends it, and the journal keeps it.
    expect(port.published.map((call) => call.bytes)).toEqual([evidenceOf().bytes]);
    expect(port.challenged.map((call) => call.claim)).toEqual([REF_A]);
    expect(journal.puts.map((value) => [value.step, value.claim])).toEqual([['started', REF_A], ['evidence_landed', REF_A], ['done', REF_A]]);
    // The twin: a job with no record names the claim that ends later.
    const free = rig();
    free.port.claims = [claimView(), later()];
    expect((await free.dispute.challengeDelivery(delivery())).ok).toBe(true);
    expect(free.port.challenged.map((call) => call.claim)).toEqual([REF_B]);
  });

  const UNUSABLE: Array<[string, ClaimView[], string, string]> = [
    ['is spent', [later()], 'claim_changed', 'spent'],
    ['is Challenged by another agent', [claimView({ state: 'Challenged' }), later()], 'claim_changed', 'Challenged'],
    ['is Validated', [claimView({ state: 'Validated' }), later()], 'claim_changed', 'Validated'],
    ['is Invalidated', [claimView({ state: 'Invalidated' }), later()], 'claim_changed', 'Invalidated'],
    ['holds another token than the record says', [claimView({ token: TOKEN_B }), later()], 'claim_changed', 'another claim'],
    ['has another claimer than the record says', [claimView({ claimer: THIRD }), later()], 'claim_changed', 'another claim'],
    ['has a window that ends now', [claimView({ submitted_at: NOW - 4 * HOUR }), later()], 'claim_changed', 'ended'],
    ['has a window that ends in 1 ms', [claimView({ submitted_at: NOW - 4 * HOUR + 1 }), later()], 'claim_window_closing', 'too soon'],
    ['has 1 ms less window than the least window', [claimView({ submitted_at: NOW - 4 * HOUR + LEAST_WINDOW - 1 }), later()], 'claim_window_closing', 'too soon'],
  ];

  it.each(UNUSABLE)('ends the job and sends nothing when the claim of the record %s, although another claim is a target', async (_name, claims, code, word) => {
    const { journal, port, dispute } = await lapsedOver(claims);
    const result = await dispute.challengeDelivery(delivery());
    expectNotFiled(result, code);
    expect(result).toMatchObject({ evidence: null, sent: null, challenge: null, wrong_document: null });
    expect(result.detail).toContain(`the claim ${REF_A}`);
    expect(result.detail).toContain(word);
    expect(port.published).toEqual([]);
    expect(port.challenged).toEqual([]);
    expect(journal.puts).toEqual([]);
  });

  it('files against the claim of the record when its window is exactly the least window', async () => {
    const { port, dispute } = await lapsedOver([claimView({ submitted_at: NOW - 4 * HOUR + LEAST_WINDOW }), later()]);
    expect((await dispute.challengeDelivery(delivery())).ok).toBe(true);
    expect(port.challenged.map((call) => call.claim)).toEqual([REF_A]);
  });

  it('checks the claim of the record like any other claim, and sends nothing when it is not a target', async () => {
    const cases: Array<[string, ClaimView, string]> = [
      ['a stake above the challenge stake', claimView({ stake_lovelace: 50_000_001n }), '1 with a stake above the challenge stake'],
      ['a claim document that is not of this kit', claimView({ claim_hash: 'ab'.repeat(32) }), '1 without a claim document of this kit'],
    ];
    for (const [name, named, counted] of cases) {
      const { journal, port, dispute } = await lapsedOver([named, later()]);
      const result = await dispute.challengeDelivery(delivery());
      expectNotFiled(result, NO_OPEN_CLAIM);
      expect(result.detail, name).toContain(counted);
      expect(port.published, name).toEqual([]);
      expect(port.challenged, name).toEqual([]);
      expect(journal.puts, name).toEqual([]);
    }
  });

  it('gives no limit for a record that says that nothing was sent: the job names the claim that is a target', async () => {
    const journal = new MemoryJournal();
    await journal.put(ESCROW, record({ step: 'not_sent', started_at: NOW - LEASE }));
    const { port, dispute } = rig({}, { journal });
    port.claims = [later()];
    expect((await dispute.challengeDelivery(delivery())).ok).toBe(true);
    expect(port.challenged.map((call) => call.claim)).toEqual([REF_B]);
  });

  it('writes the lapsed record back when the evidence of the second try is not built, so that the next try names the same claim', async () => {
    const { journal, port, dispute } = await lapsedOver([claimView(), later()]);
    const publish = port.publishAnswer;
    port.publishAnswer = () => ({ ok: false, code: 'not_built', detail: 'no collateral' });
    expectNotFiled(await dispute.challengeDelivery(delivery()), 'evidence_not_built');
    // The record is the record of the first try again, and it is not `not_sent`.
    expect(journal.puts.map((value) => value.step)).toEqual(['started', 'started']);
    expect(journal.puts[1]).toEqual(record({ started_at: NOW - LEASE }));
    // The next try goes on, and it names the claim of the record, and not the claim that ends later.
    port.publishAnswer = publish;
    expect((await dispute.challengeDelivery(delivery())).ok).toBe(true);
    expect(port.challenged.map((call) => call.claim)).toEqual([REF_A]);
  });

  it('leaves not_sent when there is no lapsed record, and the next try names the claim that ends later', async () => {
    const journal = recording([]);
    const { port, dispute } = rig({}, { journal });
    port.claims = [claimView(), later()];
    const publish = port.publishAnswer;
    port.publishAnswer = () => ({ ok: false, code: 'not_built', detail: 'no collateral' });
    expectNotFiled(await dispute.challengeDelivery(delivery()), 'evidence_not_built');
    expect(journal.puts.map((value) => value.step)).toEqual(['started', 'not_sent']);
    port.publishAnswer = publish;
    expect((await dispute.challengeDelivery(delivery())).ok).toBe(true);
    expect(port.challenged.map((call) => call.claim)).toEqual([REF_B]);
  });

  /**
   * The chain when the first try lands: `claims` are the claims of the chain, and the challenge of this agent for this job is on chain with the evidence document of the first try. `challenge` changes members of
   * the challenge, for a first try that named another claim.
   */
  function firstTryLands(port: ScriptedPort, claims: ClaimView[], challenge: Partial<ChallengeView> = {}): void {
    port.claims = claims;
    port.challenges = [challengeView({ ref: `${FIRST_CHALLENGE_TX}#0`, evidence_uri: documentUri(FIRST_EVIDENCE_TX), ...challenge })];
    port.documents.set(documentUri(FIRST_EVIDENCE_TX), { bytes: evidenceOf().bytes, type: 'evidence', media_type: 'text/plain' });
  }

  it('gives the challenge of the first try as the result when it lands while the evidence of the second try confirms, and files no second challenge', async () => {
    const { journal, port, dispute } = await lapsedOver([claimView(), later()]);
    const publish = port.publishAnswer;
    port.publishAnswer = (call) => {
      firstTryLands(port, [claimView({ state: 'Challenged' }), later()]);
      return publish(call);
    };
    const second = await dispute.challengeDelivery(delivery());
    // The challenge names the evidence document of the first try. The evidence document of the second try is on chain and is not used, so the result names it.
    expect(second).toEqual({ ok: true, value: AFTER_SECOND_TRY });
    // The second try published its own evidence document and sent no challenge: the job has one challenge, and it is not against the claim that ends later.
    expect(port.published.length).toBe(1);
    expect(port.challenged).toEqual([]);
    // The journal keeps the challenge and the extra evidence document as the end of the job, and the next call gives them and reads nothing.
    expect(journal.puts.at(-1)).toMatchObject({
      step: 'done', filed: { record: { claim: REF_A, evidence: FIRST_EVIDENCE_TX, challenge: `${FIRST_CHALLENGE_TX}#0` }, extra_evidence: EVIDENCE_TX }, ended: null,
    });
    const calls = port.events.length;
    expect(await dispute.challengeDelivery(delivery())).toEqual(second);
    expect(port.events.length).toBe(calls);
    // The twin: the first try landed before the second try started, so the job published no document, and the result names none.
    const early = await lapsedOver([claimView(), later()]);
    firstTryLands(early.port, [claimView({ state: 'Challenged' }), later()]);
    expect(await early.dispute.challengeDelivery(delivery())).toEqual({ ok: true, value: FIRST_FILED });
    expect(early.port.published).toEqual([]);
  });

  it('gives the challenge of the first try as the result when it lands while the second try builds its challenge, and says challenge_not_built when no challenge of this agent is on chain', async () => {
    const landing = await lapsedOver([claimView(), later()]);
    landing.port.openChallengeAnswer = () => {
      // The first try lands now: the claim output is spent, so the node builds no challenge for it.
      firstTryLands(landing.port, [claimView({ state: 'Challenged' }), later()]);
      return { ok: false, code: 'not_built', detail: 'the claim output is spent' };
    };
    expect(await landing.dispute.challengeDelivery(delivery())).toEqual({ ok: true, value: AFTER_SECOND_TRY });
    expect(landing.port.challenged.map((call) => call.claim)).toEqual([REF_A]);
    // The twin: the build fails for another reason, and no challenge of this agent is on chain.
    const failing = await lapsedOver([claimView(), later()]);
    failing.port.openChallengeAnswer = () => ({ ok: false, code: 'not_built', detail: 'the wallet is empty' });
    const result = await failing.dispute.challengeDelivery(delivery());
    expectNotFiled(result, 'challenge_not_built');
    expect(result).toMatchObject({ evidence: { tx_hash: EVIDENCE_TX }, sent: null });
    expect(failing.journal.puts.at(-1)).toMatchObject({ step: 'done', filed: null, ended: { code: 'challenge_not_built' } });
  });

  /** What the port says when the node refuses the challenge of the second try because the first try spent its claim output: the transaction never reached the node, so it cannot land. */
  const REFUSED: TxResult<OpenedChallenge> = { ok: false, code: 'not_confirmed', detail: 'refused: BadInputsUTxO', tx_hash: '97'.repeat(32), valid_to: NOW + 30 * 60_000, may_land: false };

  it('gives the challenge of the first try as the result when it lands between the build and the submit of the second try, and the node refuses the challenge of the second try', async () => {
    const landing = await lapsedOver([claimView(), later()]);
    landing.port.openChallengeAnswer = () => {
      // The first try lands now: the challenge of the second try spends the same claim output, so the node refuses it.
      firstTryLands(landing.port, [claimView({ state: 'Challenged' }), later()]);
      return REFUSED;
    };
    expect(await landing.dispute.challengeDelivery(delivery())).toEqual({ ok: true, value: AFTER_SECOND_TRY });
    // The second try built its challenge against the claim of the record. The job looked again for a challenge of this agent, and it has one challenge.
    expect(landing.port.challenged.map((call) => call.claim)).toEqual([REF_A]);
    expect(landing.events.filter((event) => event === 'readClaims').length).toBe(2);
    // The journal keeps the challenge as the end of the job, and the next call gives it and reads nothing.
    expect(landing.journal.puts.at(-1)).toMatchObject({ step: 'done', filed: { record: { claim: REF_A, evidence: FIRST_EVIDENCE_TX, challenge: `${FIRST_CHALLENGE_TX}#0` } }, ended: null });
    const calls = landing.events.length;
    expect(await landing.dispute.challengeDelivery(delivery())).toEqual({ ok: true, value: AFTER_SECOND_TRY });
    expect(landing.events.length).toBe(calls);
    // The twin: no challenge of this agent is on chain. The result is `challenge_not_confirmed`, with the evidence and the transaction that the node refused.
    const failing = await lapsedOver([claimView(), later()]);
    failing.port.openChallengeAnswer = () => REFUSED;
    const result = await failing.dispute.challengeDelivery(delivery());
    expectNotFiled(result, 'challenge_not_confirmed');
    expect(result).toMatchObject({ evidence: { tx_hash: EVIDENCE_TX }, sent: { tx_hash: '97'.repeat(32), may_land: false } });
    expect(failing.journal.puts.at(-1)).toMatchObject({ step: 'done', filed: null, ended: { code: 'challenge_not_confirmed' } });
    expect(failing.events.filter((event) => event === 'readClaims').length).toBe(2);
  });

  it('does not search for the challenge of the first try when the challenge of the second try may still land, and says challenge_not_confirmed', async () => {
    const { events, journal, port, dispute } = await lapsedOver([claimView(), later()]);
    port.openChallengeAnswer = () => {
      firstTryLands(port, [claimView({ state: 'Challenged' }), later()]);
      return { ...REFUSED, may_land: true };
    };
    const result = await dispute.challengeDelivery(delivery());
    expectNotFiled(result, 'challenge_not_confirmed');
    expect(result).toMatchObject({ evidence: { tx_hash: EVIDENCE_TX }, sent: { may_land: true } });
    expect(journal.puts.at(-1)).toMatchObject({ step: 'done', filed: null, ended: { code: 'challenge_not_confirmed', sent: { may_land: true } } });
    expect(events.filter((event) => event === 'readClaims').length).toBe(1);
    expect(events).not.toContain('readChallenges');
    // The next call finds the challenge of the first try, as it does for any job.
    expect(await dispute.challengeDelivery(delivery())).toEqual({ ok: true, value: AFTER_SECOND_TRY });
  });

  it('says claim_changed as before when no challenge of this agent is on chain: another agent challenged the claim, or the claim is gone', async () => {
    const other = await lapsedOver([claimView(), later()]);
    const publish = other.port.publishAnswer;
    other.port.publishAnswer = (call) => {
      // Another auditor challenges the claim of the record. Its challenge is on chain, and it is not a challenge of this agent.
      other.port.claims = [claimView({ state: 'Challenged' }), later()];
      other.port.challenges = [challengeView({ auditor: THIRD, auditor_key_hash: OTHER_KEY_HASH })];
      return publish(call);
    };
    const challenged = await other.dispute.challengeDelivery(delivery());
    expectNotFiled(challenged, 'claim_changed');
    expect(challenged).toMatchObject({ evidence: { tx_hash: EVIDENCE_TX }, sent: null, challenge: null });
    expect(other.port.challenged).toEqual([]);
    expect(other.journal.puts.at(-1)).toMatchObject({ step: 'done', filed: null, ended: { code: 'claim_changed' } });
    expect(other.events.filter((event) => event === 'readChallenges').length).toBe(1);
    // The claim is gone: there is no claim of the other party that is Challenged, so the search reads no challenge.
    const gone = await lapsedOver([claimView(), later()]);
    const answer = gone.port.publishAnswer;
    gone.port.publishAnswer = (call) => {
      gone.port.claims = [later()];
      return answer(call);
    };
    expectNotFiled(await gone.dispute.challengeDelivery(delivery()), 'claim_changed');
    expect(gone.events).not.toContain('readChallenges');
  });

  it('says chain_unavailable when the search for the challenge of the first try fails, keeps the evidence in the result, and gives the challenge to the next call', async () => {
    const { port, dispute } = await lapsedOver([claimView(), later()]);
    const publish = port.publishAnswer;
    port.publishAnswer = (call) => {
      firstTryLands(port, [claimView({ state: 'Challenged' }), later()]);
      port.readChallengesFails = new Error('Koios answered 503 at https://koios.example/secret-key');
      return publish(call);
    };
    const result = await dispute.challengeDelivery(delivery());
    expectNotFiled(result, 'chain_unavailable');
    expect(result.detail).toContain('the claim is Challenged now');
    expect(result.detail).not.toContain('secret-key');
    expect(result.evidence).toMatchObject({ tx_hash: EVIDENCE_TX });
    // The twin: the chain can be read again, and the next call finds the challenge. The record of the second try keeps its evidence document, so the result names it. Nothing is sent.
    port.readChallengesFails = null;
    expect(await dispute.challengeDelivery(delivery())).toEqual({ ok: true, value: AFTER_SECOND_TRY });
    expect(port.challenged).toEqual([]);
  });

  it('does not search again when the job had no lapsed record: claim_changed stays, and the chain is not read a second time', async () => {
    const { events, port, dispute } = rig();
    port.claims = [claimView()];
    const publish = port.publishAnswer;
    port.publishAnswer = (call) => {
      firstTryLands(port, [claimView({ state: 'Challenged' })]);
      return publish(call);
    };
    expectNotFiled(await dispute.challengeDelivery(delivery()), 'claim_changed');
    expect(events.filter((event) => event === 'readClaims').length).toBe(1);
    expect(events).not.toContain('readChallenges');
  });

  it('searches again also when the lapsed record is found only in the job, right before the evidence is sent', async () => {
    // The first read gives no record, so the job chooses the claim that ends later. Then a record of that claim lapses before the job runs.
    const rigged = rig({}, { journal: onSecondRead(record({ started_at: NOW - LEASE, claim: REF_B, claim_token: TOKEN_B })) });
    rigged.port.claims = [claimView(), later()];
    const publish = rigged.port.publishAnswer;
    rigged.port.publishAnswer = (call) => {
      firstTryLands(rigged.port, [claimView(), { ...later(), state: 'Challenged' }], { claim: REF_B, claim_token: TOKEN_B });
      return publish(call);
    };
    expect(await rigged.dispute.challengeDelivery(delivery())).toMatchObject({
      ok: true, value: { record: { claim: REF_B, evidence: FIRST_EVIDENCE_TX, challenge: `${FIRST_CHALLENGE_TX}#0` }, claim_token: TOKEN_B },
    });
    expect(rigged.port.challenged).toEqual([]);
  });

  it('stops in the job when the journal gives a lapsed record of another claim at the second read, and sends nothing', async () => {
    // The first read gives no record, so the job chooses the claim that ends later. Then a record of the claim REF_A lapses before the job runs.
    const other = rig({}, { journal: onSecondRead(record({ started_at: NOW - LEASE })) });
    other.port.claims = [claimView(), later()];
    const stopped = await other.dispute.challengeDelivery(delivery());
    expectNotFiled(stopped, 'job_already_disputed');
    expect(stopped.detail).toContain('names another claim');
    expect(stopped.detail).toContain('nothing was sent');
    expect(other.port.published).toEqual([]);
    expect(other.port.challenged).toEqual([]);
    // The twin: the lapsed record names the claim that the job chose.
    const same = rig({}, { journal: onSecondRead(record({ started_at: NOW - LEASE, claim: REF_B, claim_token: TOKEN_B })) });
    same.port.claims = [claimView(), later()];
    expect((await same.dispute.challengeDelivery(delivery())).ok).toBe(true);
    expect(same.port.challenged.map((call) => call.claim)).toEqual([REF_B]);
  });

  const OTHER_MEMBER: Array<[string, Partial<JobRecord>]> = [
    ['claim output', { claim: REF_B }],
    ['claim token', { claim_token: TOKEN_B }],
    ['claimer', { against: THIRD }],
  ];

  it.each(OTHER_MEMBER)('stops in the job when the lapsed record has another %s than the job, and sends nothing', async (_name, member) => {
    const rigged = rig({}, { journal: onSecondRead(record({ started_at: NOW - LEASE, ...member })) });
    rigged.port.claims = [claimView()];
    expectNotFiled(await rigged.dispute.challengeDelivery(delivery()), 'job_already_disputed');
    expect(rigged.port.published).toEqual([]);
    // The twin: the same record with the output, the token and the claimer of the job.
    const twin = rig({}, { journal: onSecondRead(record({ started_at: NOW - LEASE })) });
    twin.port.claims = [claimView()];
    expect((await twin.dispute.challengeDelivery(delivery())).ok).toBe(true);
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
