// agents/sourcing-agent/test/compliance/read.test.ts
// The rules of `readCompliance` over scripted lists. The attestations are views that the test builds by hand, so each test changes one member of the golden attestation and expects one answer. The golden
// attestation is the accepted twin of each refusal. The real list of buyer-core, over the ledger fixtures, is in real.test.ts.
import { describe, expect, test } from 'vitest';
import type { AttestationPage } from '@vsa/buyer-core';
import type { AttestationDatum } from '@vsa/vector-read/identity-codec';
import { systemClock } from '@vsa/usecase-kit/access';
import { FACT_READ_TIMEOUT_MS, readCompliance } from '../../src/compliance/index.ts';
import type { ComplianceClock, ComplianceDeps } from '../../src/compliance/index.ts';
import {
  ABSENT, AGENT_ID, DAY, DID, ID, LAST_TIME_MS, MINUTE, NOW, OTHER_ID, REGISTRY, STRANGER, UNREADABLE,
  ManualClock, damagedDatum, damagedView, datum, deferred, depsOf, golden, goldenText, id, listing, page, paged, readItems, revoked, scripted, settle, view,
} from './support.ts';
import type { Deferred } from './support.ts';

/** The golden fact with members replaced. */
const fact = (over: Record<string, unknown>): Record<string, unknown> => ({ ...golden('fact-valid.json'), ...over });

describe('the query', () => {
  test('asks the list for the attestations of type 0 by the key hash of the registry, with no subject, 50 to a page', async () => {
    const source = listing([view(ID, datum())]);
    await readCompliance(depsOf(source.list), DID, NOW);
    expect(source.queries).toStrictEqual([{ issuer: { type: 'key_hash', hash: REGISTRY.keyHash }, attType: 0, limit: 50 }]);
  });

  test('names no subject, whatever the bidder: the reader decides on the decoded subject, because a filter on the bytes of the subject can be dodged', async () => {
    const first = listing([]);
    const second = listing([]);
    await readCompliance(depsOf(first.list), DID, NOW);
    await readCompliance(depsOf(second.list), `did:vector:${OTHER_ID}`, NOW);
    expect(first.queries).toStrictEqual(second.queries);
    expect(first.queries.every((query) => !('subject' in query))).toBe(true);
  });
});

describe('the state of the newest attestation', () => {
  test('no attestation is absent', async () => {
    expect(await readItems([])).toStrictEqual(ABSENT);
  });

  test('an active attestation is valid, and its fact is the golden file', async () => {
    const read = await readItems([view(ID, datum())]);
    expect(read).toStrictEqual(golden('fact-valid.json'));
    expect(`${JSON.stringify(read, null, 2)}\n`).toBe(goldenText('fact-valid.json'));
  });

  test('an active attestation with no end is valid, and its end is null', async () => {
    expect(await readItems([view(ID, datum({ validUntil: null }))])).toStrictEqual(fact({ valid_until: null }));
  });

  test('a revoked attestation is invalid, with the time and the reason of the revocation as texts', async () => {
    const read = await readItems([view(ID, datum(revoked(NOW - 2 * DAY, 3)))]);
    expect(read).toStrictEqual(fact({ state: 'invalid', attestation_state: 'revoked', revoked_at: '2026-11-22T12:00:00Z', revoke_reason: '3' }));
  });

  test.each<readonly [string, bigint, string]>([
    ['zero', 0n, '0'],
    ['a small number', 3n, '3'],
    ['2^53, which a number does not hold exactly', 2n ** 53n, '9007199254740992'],
    ['more than 2^53', 2n ** 60n + 7n, '1152921504606846983'],
    ['the most that the chain allows', 2n ** 63n - 1n, '9223372036854775807'],
    ['a number below zero', -5n, '-5'],
  ])('the reason of a revocation is %s: the decimal text of the reason of the view, and never the number of the datum', async (_name, reason, text) => {
    // The codec of the builders leaves NaN in the datum for a reason that a number cannot hold. The view holds the exact reason.
    const read = await readItems([view(ID, datum(revoked(NOW - DAY, Number.NaN)), reason)]);
    expect(read).toStrictEqual(fact({ state: 'invalid', attestation_state: 'revoked', revoked_at: '2026-11-23T12:00:00Z', revoke_reason: text }));
  });

  test.each<readonly [string, number, 'valid' | 'invalid', string]>([
    ['ended one millisecond ago', NOW - 1, 'invalid', 'expired'],
    ['ends now: the end is inside the range', NOW, 'valid', 'active'],
    ['ends in one millisecond', NOW + 1, 'valid', 'active'],
  ])('an attestation that %s is %s (%s)', async (_name, validUntil, state, word) => {
    const read = await readItems([view(ID, datum({ validUntil }))]);
    expect(read.state).toBe(state);
    expect(read.attestation_state).toBe(word);
    expect(read.attestation).toBe(ID);
  });

  test.each<readonly [string, number, 'valid' | 'invalid', string]>([
    ['starts in one millisecond', NOW + 1, 'invalid', 'not_yet_valid'],
    ['starts now: the start is inside the range', NOW, 'valid', 'active'],
    ['started one millisecond ago', NOW - 1, 'valid', 'active'],
  ])('an attestation that %s is %s (%s)', async (_name, validFrom, state, word) => {
    const read = await readItems([view(ID, datum({ validFrom }))]);
    expect(read.state).toBe(state);
    expect(read.attestation_state).toBe(word);
  });

  test.each<readonly [string, number, 'valid' | 'invalid', string]>([
    ['59 minutes after the time of the read: the window of the transaction can end that late', NOW + 59 * MINUTE, 'valid', 'active'],
    ['61 minutes after the time of the read: the attestation did not exist yet', NOW + 61 * MINUTE, 'invalid', 'not_yet_valid'],
  ])('an attestation issued %s', async (_name, issuedAt, state, word) => {
    const read = await readItems([view(ID, datum({ issuedAt }))]);
    expect(read.state).toBe(state);
    expect(read.attestation_state).toBe(word);
  });

  test('a revoked attestation is revoked whatever its dates say, and the twin with no revocation is expired', async () => {
    const dates = { validUntil: NOW - 2 * DAY };
    expect((await readItems([view(ID, datum({ ...dates, ...revoked(NOW - 3 * DAY, 1) }))])).attestation_state).toBe('revoked');
    expect((await readItems([view(ID, datum(dates))])).attestation_state).toBe('expired');
  });

  test('the attestation is judged at the time that the caller gives, and not at the time of the clock', async () => {
    expect((await readItems([view(ID, datum())], NOW + 80 * DAY)).state).toBe('valid');
    const late = await readItems([view(ID, datum())], NOW + 80 * DAY + 1);
    expect([late.state, late.attestation_state]).toStrictEqual(['invalid', 'expired']);
  });
});

describe('which attestation counts', () => {
  type Over = Partial<AttestationDatum>;
  /** An attestation that the reader drops: another type, another issuer, another subject. */
  const DROPPED: ReadonlyArray<readonly [string, Over]> = [
    ['an attestation of type 1', { attType: 1 }],
    ['an attestation of type 2', { attType: 2 }],
    ['an attestation of type 3', { attType: 3 }],
    ['an attestation of type 4', { attType: 4 }],
    ['an attestation of type 5', { attType: 5 }],
    ['an attestation of type 15', { attType: 15 }],
    ['an attestation of another issuer', { issuer: STRANGER.publicKey }],
    ['an attestation about another subject', { subject: OTHER_ID }],
  ];

  test.each(DROPPED)('%s is dropped, and the same attestation of type 0, by the registry, about the bidder counts', async (_name, over) => {
    expect(await readItems([view(ID, datum(over))])).toStrictEqual(ABSENT);
    expect((await readItems([view(ID, datum())])).state).toBe('valid');
  });

  test.each(DROPPED)('%s never decides: a newer one does not turn a valid fact invalid or an invalid fact valid, and it is not shown', async (_name, over) => {
    const newer = { ...over, issuedAt: NOW - DAY };
    const revokedNewer = view(id(2), datum({ ...newer, ...revoked(NOW - DAY, 1) }));
    expect(await readItems([revokedNewer, view(ID, datum())])).toStrictEqual(golden('fact-valid.json'));
    const activeNewer = view(id(2), datum(newer));
    expect(await readItems([activeNewer, view(ID, datum(revoked(NOW - 2 * DAY, 1)))])).toStrictEqual(fact({ state: 'invalid', attestation_state: 'revoked', revoked_at: '2026-11-22T12:00:00Z', revoke_reason: '1' }));
    // The twin: the newer attestation of the registry about the bidder does decide.
    const counted = await readItems([view(id(2), datum({ issuedAt: NOW - DAY, ...revoked(NOW - DAY, 1) })), view(ID, datum())]);
    expect(counted.attestation).toBe(id(2));
    expect(counted.state).toBe('invalid');
  });

  test('a value of the bidder in another member of the datum is no subject: the digest, an issuer identifier, a profile and a link target', async () => {
    const decoy = datum({ subject: OTHER_ID, digest: AGENT_ID, issuerId: AGENT_ID, profile: AGENT_ID, links: [{ rel: 1, target: AGENT_ID }] });
    expect(await readItems([view(ID, decoy)])).toStrictEqual(ABSENT);
    expect((await readItems([view(ID, datum({ digest: AGENT_ID, profile: AGENT_ID, links: [{ rel: 1, target: AGENT_ID }] }))])).state).toBe('valid');
  });

  test('the reader does not require a solicited attestation, a locator, an envelope, links or an issuer with no record: the twins are valid', async () => {
    const bare = datum({ solicited: false, locator: null, envelopeSig: null, links: [], issuerId: null });
    const decorated = datum({ solicited: true, locator: 'aa'.repeat(10), envelopeSig: 'bb'.repeat(64), links: [{ rel: 0, target: id(9) }], issuerId: 'cc'.repeat(32), format: 60, profile: 'dd'.repeat(32) });
    expect(await readItems([view(ID, bare)])).toStrictEqual(golden('fact-valid.json'));
    expect(await readItems([view(ID, decorated)])).toStrictEqual(golden('fact-valid.json'));
  });
});

describe('the newest attestation decides', () => {
  const older = (over: Partial<AttestationDatum> = {}) => view(id(1), datum({ issuedAt: NOW - 10 * DAY, ...over }));
  const newer = (over: Partial<AttestationDatum> = {}) => view(id(2), datum({ issuedAt: NOW - 5 * DAY, ...over }));

  test('the newer is revoked and the older is active: invalid, with the newer', async () => {
    const read = await readItems([newer(revoked(NOW - DAY, 1)), older()]);
    expect([read.state, read.attestation, read.attestation_state]).toStrictEqual(['invalid', id(2), 'revoked']);
  });

  test('the newer is active and the older is revoked: valid, with the newer', async () => {
    const read = await readItems([newer(), older(revoked(NOW - 6 * DAY, 1))]);
    expect([read.state, read.attestation, read.attestation_state]).toStrictEqual(['valid', id(2), 'active']);
  });

  test.each<readonly [string, Partial<AttestationDatum>, string]>([
    ['revoked', revoked(NOW - DAY, 1), 'revoked'],
    ['expired', { validUntil: NOW - 1 }, 'expired'],
    ['not yet valid', { validFrom: NOW + DAY }, 'not_yet_valid'],
  ])('a newer attestation that is %s decides over an older one that is active, and the same newer attestation, active, makes the fact valid', async (_name, over, word) => {
    const read = await readItems([newer(over), older()]);
    expect([read.state, read.attestation, read.attestation_state]).toStrictEqual(['invalid', id(2), word]);
    expect((await readItems([newer(), older()])).state).toBe('valid');
  });

  test('the reader puts the attestations in order again: the answer does not depend on the order of the page', async () => {
    const oldest = view(id(1), datum({ issuedAt: NOW - 30 * DAY }));
    const middle = (over: Partial<AttestationDatum>) => view(id(2), datum({ issuedAt: NOW - 20 * DAY, ...over }));
    const newest = view(id(3), datum({ issuedAt: NOW - 10 * DAY }));
    const orders = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]] as const;
    for (const order of orders) {
      const items = [oldest, middle(revoked(NOW - 15 * DAY, 1)), newest];
      const read = await readItems(order.map((at) => items[at]!));
      expect([read.state, read.attestation]).toStrictEqual(['valid', id(3)]);
      // The twin: the middle attestation is the newest, and it is revoked.
      const newestIsRevoked = [oldest, view(id(2), datum({ issuedAt: NOW - DAY, ...revoked(NOW - DAY, 1) })), newest];
      const twin = await readItems(order.map((at) => newestIsRevoked[at]!));
      expect([twin.state, twin.attestation]).toStrictEqual(['invalid', id(2)]);
    }
  });

  test('two attestations issued at the same time: the lower identifier decides, in either order of the page', async () => {
    const low = (over: Partial<AttestationDatum> = {}) => view(id(0x10), datum({ issuedAt: NOW - DAY, ...over }));
    const high = (over: Partial<AttestationDatum> = {}) => view(id(0x20), datum({ issuedAt: NOW - DAY, ...over }));
    for (const items of [[low(), high(revoked(NOW - DAY, 1))], [high(revoked(NOW - DAY, 1)), low()]]) {
      expect((await readItems(items)).attestation).toBe(id(0x10));
      expect((await readItems(items)).state).toBe('valid');
    }
    for (const items of [[low(revoked(NOW - DAY, 1)), high()], [high(), low(revoked(NOW - DAY, 1))]]) {
      expect((await readItems(items)).attestation).toBe(id(0x10));
      expect((await readItems(items)).state).toBe('invalid');
    }
  });
});

describe('the pages of the list', () => {
  const QUERY = { issuer: { type: 'key_hash', hash: REGISTRY.keyHash }, attType: 0, limit: 50 };
  /** An attestation of the registry about another bidder. */
  const other = (n: number, over: Partial<AttestationDatum> = {}) => view(id(n), datum({ subject: OTHER_ID, issuedAt: NOW - n * DAY, ...over }));
  const older = view(id(1), datum({ issuedAt: NOW - 10 * DAY }));
  const newer = view(id(2), datum({ issuedAt: NOW - 5 * DAY, ...revoked(NOW - DAY, 1) }));

  test('a page that names a next page is followed: the attestations of every page take part, and the newest decides', async () => {
    // The newest attestation of the bidder is on the second page, against the order of the lister. The reader decides on all of them.
    const source = paged([[other(3), older], [newer]]);
    const read = await readCompliance(depsOf(source.list), DID, NOW);
    expect([read.state, read.attestation, read.attestation_state]).toStrictEqual(['invalid', id(2), 'revoked']);
    expect(source.queries).toStrictEqual([QUERY, { ...QUERY, offset: 2 }]);
    // The twin: the same attestations on one page give the same fact.
    expect(await readItems([other(3), older, newer])).toStrictEqual(read);
  });

  test('the attestation of the bidder can be on any page: the third page holds it', async () => {
    const source = paged([[other(3), other(4)], [other(5), other(6)], [view(ID, datum(revoked(NOW - 2 * DAY, 1)))]]);
    const read = await readCompliance(depsOf(source.list), DID, NOW);
    expect([read.state, read.attestation, read.attestation_state]).toStrictEqual(['invalid', ID, 'revoked']);
    expect(source.queries.map((query) => query.offset)).toStrictEqual([undefined, 2, 4]);
  });

  test('a failure on a later page makes the fact unreadable, whatever the first page says', async () => {
    const failing = scripted((query) => (query.offset === undefined ? page([view(ID, datum())], { nextOffset: 1 }) : Promise.reject(new Error('the source answered 500'))));
    expect(await readCompliance(depsOf(failing.list), DID, NOW)).toStrictEqual(UNREADABLE);
    expect(failing.queries).toHaveLength(2);
    // The twin: a first page that names no next page is read, and the fact is valid.
    expect((await readItems([view(ID, datum())])).state).toBe('valid');
  });

  test('a later page that is not a page makes the fact unreadable', async () => {
    const broken = scripted((query) => (query.offset === undefined ? page([view(ID, datum())], { nextOffset: 1 }) : { total: 1 }));
    expect(await readCompliance(depsOf(broken.list), DID, NOW)).toStrictEqual(UNREADABLE);
    expect(broken.queries).toHaveLength(2);
  });

  test.each<readonly [string, unknown]>([
    ['a text', '1'],
    ['a number below zero', -1],
    ['a number with a fraction', 1.5],
    ['NaN', Number.NaN],
    ['an object', {}],
    ['zero, where the first page starts', 0],
  ])('a next page that is %s is not a page to follow: the fact is unreadable, and no second call is made', async (_name, nextOffset) => {
    const source = scripted(() => ({ ...page([view(ID, datum())]), nextOffset }));
    expect(await readCompliance(depsOf(source.list), DID, NOW)).toStrictEqual(UNREADABLE);
    expect(source.queries).toHaveLength(1);
  });

  test.each<readonly [string, unknown]>([
    ['null', null],
    ['no member', undefined],
  ])('a next page that is %s is the end of the list', async (_name, nextOffset) => {
    const source = scripted(() => ({ ...page([view(ID, datum())]), nextOffset }));
    expect(await readCompliance(depsOf(source.list), DID, NOW)).toStrictEqual(golden('fact-valid.json'));
    expect(source.queries).toHaveLength(1);
  });

  test('a page that does not lead forward makes the fact unreadable: a later page that names its own start', async () => {
    const stuck = scripted((query) => page([query.offset === undefined ? other(3) : view(ID, datum())], { nextOffset: 1 }));
    expect(await readCompliance(depsOf(stuck.list), DID, NOW)).toStrictEqual(UNREADABLE);
    expect(stuck.queries).toHaveLength(2);
  });

  test('at most 100 pages are read: a list of 100 pages is read, and a list that names a 101st page is unreadable', async () => {
    const pages = (count: number) => Array.from({ length: count }, (_, n) => (n === count - 1 ? [view(ID, datum())] : [other(n + 1)]));
    const hundred = paged(pages(100));
    expect(await readCompliance(depsOf(hundred.list), DID, NOW)).toStrictEqual(golden('fact-valid.json'));
    expect(hundred.queries).toHaveLength(100);
    const more = paged(pages(101));
    expect(await readCompliance(depsOf(more.list), DID, NOW)).toStrictEqual(UNREADABLE);
    expect(more.queries).toHaveLength(100);
  });

  test('the time bound covers all the pages together: a second page that does not come ends the read 20 seconds after its start', async () => {
    const clock = new ManualClock();
    const second = deferred<AttestationPage>();
    let calls = 0;
    const list: ComplianceDeps['list'] = () => {
      calls += 1;
      return calls === 1 ? Promise.resolve(page([view(ID, datum())], { nextOffset: 1 })) : second.promise;
    };
    const pending = readCompliance(depsOf(list, { clock }), DID, NOW);
    await clock.advance(15_000);
    expect(calls).toBe(2);
    expect(clock.waiting).toBe(1);
    await clock.advance(FACT_READ_TIMEOUT_MS - 15_000 - 1);
    expect(clock.waiting).toBe(1);
    await clock.advance(1);
    expect(await pending).toStrictEqual(UNREADABLE);
    expect(clock.waiting).toBe(0);

    // The twin: a second page that comes just in time is read, and the newest attestation of the two pages decides.
    const spare = new ManualClock();
    const inTime = deferred<AttestationPage>();
    let spareCalls = 0;
    const timely: ComplianceDeps['list'] = () => {
      spareCalls += 1;
      return spareCalls === 1 ? Promise.resolve(page([older], { nextOffset: 1 })) : inTime.promise;
    };
    const pendingInTime = readCompliance(depsOf(timely, { clock: spare }), DID, NOW);
    await spare.advance(FACT_READ_TIMEOUT_MS - 1);
    inTime.resolve(page([newer]));
    expect(await pendingInTime).toMatchObject({ state: 'invalid', attestation: id(2) });
    expect(spare.waiting).toBe(0);
  });
});

describe('an attestation that the list shows twice', () => {
  // A stale output and a new output of one token carry one identifier. Their place in the page would decide, so the list cannot be trusted.
  const COPIES: ReadonlyArray<readonly [string, Partial<AttestationDatum>, Partial<AttestationDatum>]> = [
    ['an active copy and a revoked copy of one attestation of the bidder', {}, revoked(NOW - DAY, 1)],
    ['a revoked copy and an active copy of one attestation of the bidder', revoked(NOW - DAY, 1), {}],
    ['two equal copies of one attestation of the bidder', {}, {}],
    ['two copies of an attestation about another bidder, which the reader drops', { subject: OTHER_ID }, { subject: OTHER_ID, ...revoked(NOW - DAY, 1) }],
  ];

  test.each(COPIES)('%s: the fact is unreadable, in either order of the page and across two pages', async (_name, first, second) => {
    const base = view(ID, datum());
    const copy = (over: Partial<AttestationDatum>) => view(id(2), datum({ issuedAt: NOW - DAY, ...over }));
    expect(await readItems([base, copy(first), copy(second)])).toStrictEqual(UNREADABLE);
    expect(await readItems([base, copy(second), copy(first)])).toStrictEqual(UNREADABLE);
    expect(await readCompliance(depsOf(paged([[base, copy(first)], [copy(second)]]).list), DID, NOW)).toStrictEqual(UNREADABLE);
    // The twin: the same attestations with two identifiers are read.
    const apart = await readItems([base, copy(first), view(id(3), datum({ issuedAt: NOW - DAY, ...second }))]);
    expect(apart.state).not.toBe('unreadable');
  });
});

describe('the reply of the bidder', () => {
  const REPLY = 'cd'.repeat(32);
  /** The address of a reply: the bytes of a text, in hex, as a datum holds them. */
  const REPLY_URI = Buffer.from('https://bidder.example/reply.txt', 'utf8').toString('hex');

  test('a reply is shown as its hash and nothing else', async () => {
    const read = await readItems([view(ID, datum({ contested: { uri: REPLY_URI, sha256: REPLY } }))]);
    expect(read).toStrictEqual(fact({ contested: { sha256: REPLY } }));
    expect(Object.keys(read.contested ?? {})).toStrictEqual(['sha256']);
    expect(JSON.stringify(read)).not.toContain(REPLY_URI);
    expect(JSON.stringify(read)).not.toContain('bidder.example');
  });

  test('the address of a reply is never read', async () => {
    let reads = 0;
    const anchor = { sha256: REPLY } as { uri: string; sha256: string };
    Object.defineProperty(anchor, 'uri', { enumerable: true, get: () => { reads += 1; return REPLY_URI; } });
    const read = await readItems([view(ID, datum({ contested: anchor }))]);
    expect(read.contested).toStrictEqual({ sha256: REPLY });
    expect(reads).toBe(0);
  });

  test('a reply does not change the state: an active attestation with a reply is valid, and a revoked one shows the revocation and the reply', async () => {
    const active = await readItems([view(ID, datum({ contested: { uri: REPLY_URI, sha256: REPLY } }))]);
    expect([active.state, active.contested]).toStrictEqual(['valid', { sha256: REPLY }]);
    const contested = datum({ ...revoked(NOW - 2 * DAY, 9), contested: { uri: REPLY_URI, sha256: REPLY } });
    expect(await readItems([view(ID, contested)])).toStrictEqual(fact({
      state: 'invalid', attestation_state: 'revoked', revoked_at: '2026-11-22T12:00:00Z', revoke_reason: '9', contested: { sha256: REPLY },
    }));
  });

  test('the reply of an attestation that does not decide is not shown', async () => {
    const hidden = view(id(2), datum({ issuedAt: NOW - 20 * DAY, contested: { uri: REPLY_URI, sha256: REPLY } }));
    expect(await readItems([view(ID, datum()), hidden])).toStrictEqual(golden('fact-valid.json'));
  });
});

describe('a list that cannot be read', () => {
  test('a list that rejects is unreadable and never absent, and the twin that answers is read', async () => {
    const failing = scripted(() => Promise.reject(new Error('the source answered 500')));
    expect(await readCompliance(depsOf(failing.list), DID, NOW)).toStrictEqual(UNREADABLE);
    expect(failing.queries).toHaveLength(1);
    expect((await readItems([view(ID, datum())])).state).toBe('valid');
  });

  test('a list that throws before it returns, with an error or with a text, is unreadable', async () => {
    const throwsError: ComplianceDeps['list'] = () => { throw new Error('no node'); };
    const throwsText: ComplianceDeps['list'] = () => { throw 'no node'; };
    expect(await readCompliance(depsOf(throwsError), DID, NOW)).toStrictEqual(UNREADABLE);
    expect(await readCompliance(depsOf(throwsText), DID, NOW)).toStrictEqual(UNREADABLE);
  });

  test('a list that does not answer in 20 seconds is unreadable, and one that answers just in time is read', async () => {
    expect(FACT_READ_TIMEOUT_MS).toBe(20_000);
    const clock = new ManualClock();
    const slow = deferred<AttestationPage>();
    const pending = readCompliance(depsOf(() => slow.promise, { clock }), DID, NOW);
    await settle();
    expect(clock.waiting).toBe(1);
    await clock.advance(FACT_READ_TIMEOUT_MS - 1);
    expect(clock.waiting).toBe(1);
    await clock.advance(1);
    expect(await pending).toStrictEqual(UNREADABLE);
    expect(clock.waiting).toBe(0);

    const spare = new ManualClock();
    const quick = deferred<AttestationPage>();
    const inTime = readCompliance(depsOf(() => quick.promise, { clock: spare }), DID, NOW);
    await spare.advance(FACT_READ_TIMEOUT_MS - 1);
    quick.resolve(page([view(ID, datum())]));
    expect(await inTime).toStrictEqual(golden('fact-valid.json'));
    expect(spare.waiting).toBe(0);
  });

  test.each<readonly [string, (late: Deferred<AttestationPage>) => void]>([
    ['an answer', (late) => late.resolve(page([view(ID, datum())]))],
    ['a failure', (late) => late.reject(new Error('late'))],
  ])('%s that comes after the bound changes nothing, and is not an unhandled rejection', async (_name, settleLate) => {
    const clock = new ManualClock();
    const late = deferred<AttestationPage>();
    const pending = readCompliance(depsOf(() => late.promise, { clock }), DID, NOW);
    await clock.advance(FACT_READ_TIMEOUT_MS);
    expect(await pending).toStrictEqual(UNREADABLE);
    settleLate(late);
    await settle();
  });

  test('the clock of the kit fits the port of the reader, and a list that answers is read with it', async () => {
    const clock: ComplianceClock = systemClock;
    expect(await readCompliance(depsOf(listing([view(ID, datum())]).list, { clock }), DID, NOW)).toStrictEqual(golden('fact-valid.json'));
  });

  test.each<readonly [string, unknown]>([
    ['null', null],
    ['undefined', undefined],
    ['a text', 'page'],
    ['a list', []],
    ['an object with no items', { total: 0 }],
    ['an object whose items are a text', { items: 'items' }],
    ['an object whose items are an object', { items: {} }],
    ['an object whose items are null', { items: null }],
  ])('a page that is %s is unreadable', async (_name, answer) => {
    expect(await readCompliance(depsOf(scripted(() => answer).list), DID, NOW)).toStrictEqual(UNREADABLE);
  });

  test('a page with an empty list of items and no other member is absent', async () => {
    expect(await readCompliance(depsOf(scripted(() => ({ items: [] })).list), DID, NOW)).toStrictEqual(ABSENT);
  });
});

describe('an item whose datum cannot be read', () => {
  /** Members of the view that the reader needs to know what an item is: its identifier and its datum. */
  const VIEW_DAMAGE: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
    ['an identifier that is not 64 hex characters', { id: 'e1e1' }],
    ['an identifier in upper case', { id: ID.toUpperCase() }],
    ['no datum', { attestation: undefined }],
    ['a datum that is null', { attestation: null }],
    ['a datum that is a text', { attestation: 'datum' }],
  ];
  /** Members of the datum that the reader needs to know whether an item counts, and where it stands in the order. */
  const CLASSIFYING: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
    ['a subject that is not hex', { subject: 'subject' }],
    ['a subject in upper case', { subject: AGENT_ID.toUpperCase() }],
    ['a subject that is a number', { subject: 7 }],
    ['an issuer that is not hex', { issuer: 'issuer' }],
    ['an issuer of 31 bytes', { issuer: 'ab'.repeat(31) }],
    ['a type that is a text', { attType: '0' }],
    ['a type with a fraction', { attType: 0.5 }],
    ['no issue time', { issuedAt: undefined }],
    ['an issue time that is a text', { issuedAt: '2026-11-14T12:00:00Z' }],
    ['an issue time that is NaN', { issuedAt: Number.NaN }],
    ['an issue time below zero', { issuedAt: -1 }],
    ['an issue time after the year 9999', { issuedAt: LAST_TIME_MS + 1 }],
  ];
  /** Members that the reader needs only for the attestation that decides: the dates, the status, the reply. The reason is the exact reason of the view. */
  const REPORTING: ReadonlyArray<readonly [string, Record<string, unknown>, bigint | null]> = [
    ['no start', { validFrom: undefined }, null],
    ['a start that is a text', { validFrom: 'soon' }, null],
    ['no end', { validUntil: undefined }, null],
    ['an end with a fraction', { validUntil: 1.5 }, null],
    ['an end after the year 9999', { validUntil: LAST_TIME_MS + 1 }, null],
    ['no status', { status: undefined }, null],
    ['a status of another kind', { status: { type: 'AttPaused' } }, null],
    ['a revoked status with no time', { status: { type: 'AttRevoked', reason: 1 } }, 1n],
    ['a revoked status with a time that is a text', { status: { type: 'AttRevoked', at: 'then', reason: 1 } }, 1n],
    ['a revoked status with a time after the year 9999', { status: { type: 'AttRevoked', at: LAST_TIME_MS + 1, reason: 1 } }, 1n],
    ['no reply member', { contested: undefined }, null],
    ['a reply that is a text', { contested: 'reply' }, null],
    ['a reply with no hash', { contested: { uri: 'aa' } }, null],
    ['a reply with a hash that is not 64 hex characters', { contested: { uri: 'aa', sha256: 'abc' } }, null],
    ['a reply with a hash in upper case', { contested: { uri: 'aa', sha256: 'CD'.repeat(32) } }, null],
    ['an active attestation with the reason of a revocation', {}, 5n],
    ['a revoked attestation with no reason', { status: { type: 'AttRevoked', at: NOW - DAY, reason: 1 } }, null],
    ['a revoked attestation whose reason is a number', { status: { type: 'AttRevoked', at: NOW - DAY, reason: 1 } }, 1 as unknown as bigint],
  ];

  test.each(VIEW_DAMAGE)('%s: the fact is unreadable, even when a good attestation is beside it', async (_name, over) => {
    expect(await readItems([damagedView(over)])).toStrictEqual(UNREADABLE);
    expect(await readItems([view(ID, datum()), damagedView({ ...over, id: over.id ?? id(2) })])).toStrictEqual(UNREADABLE);
    expect((await readItems([view(ID, datum())])).state).toBe('valid');
  });

  test.each(CLASSIFYING)('%s: the fact is unreadable, also when the item would be dropped', async (_name, over) => {
    expect(await readItems([damagedDatum(over)])).toStrictEqual(UNREADABLE);
    expect(await readItems([view(ID, datum()), damagedDatum({ issuer: STRANGER.publicKey, ...over }, null, id(2))])).toStrictEqual(UNREADABLE);
    expect((await readItems([view(ID, datum())])).state).toBe('valid');
  });

  test.each(REPORTING)('%s: when the item decides, the fact is unreadable; when it does not decide, the fact is the golden fact', async (_name, over, reason) => {
    expect(await readItems([damagedDatum(over, reason)])).toStrictEqual(UNREADABLE);
    // An item that is dropped, and an older item, are not read for the facts that only the deciding item gives.
    const dropped = damagedDatum({ issuer: STRANGER.publicKey, ...over }, reason, id(2));
    expect(await readItems([dropped, view(ID, datum())])).toStrictEqual(golden('fact-valid.json'));
    const olderDamaged = damagedDatum({ issuedAt: NOW - 20 * DAY, ...over }, reason, id(3));
    expect(await readItems([view(ID, datum()), olderDamaged])).toStrictEqual(golden('fact-valid.json'));
  });
});

describe('an input that is not in its form', () => {
  test.each<readonly [string, unknown]>([
    ['a DID with no prefix', AGENT_ID],
    ['an empty DID', ''],
    ['a DID in upper case', `did:vector:${AGENT_ID.toUpperCase()}`],
    ['a DID of 63 hex characters', `did:vector:${AGENT_ID.slice(1)}`],
    ['a DID of the old form', `did:vector:agent:${'cd'.repeat(28)}:${AGENT_ID}`],
    ['a DID that is not a text', 7],
  ])('%s is unreadable, and no list is asked', async (_name, did) => {
    const source = listing([view(ID, datum())]);
    expect(await readCompliance(depsOf(source.list), did as string, NOW)).toStrictEqual(UNREADABLE);
    expect(source.queries).toHaveLength(0);
    expect((await readCompliance(depsOf(listing([view(ID, datum())]).list), DID, NOW)).state).toBe('valid');
  });

  test.each<readonly [string, unknown]>([
    ['an empty key hash', ''],
    ['a key hash of 55 hex characters', REGISTRY.keyHash.slice(1)],
    ['a key hash of 57 hex characters', `${REGISTRY.keyHash}a`],
    ['a key hash in upper case', REGISTRY.keyHash.toUpperCase()],
    ['a public key of 64 hex characters in place of the key hash', REGISTRY.publicKey],
    ['a key hash that is not a text', 7],
  ])('%s is unreadable, and no list is asked', async (_name, issuerPkh) => {
    const source = listing([view(ID, datum())]);
    expect(await readCompliance(depsOf(source.list, { issuerPkh: issuerPkh as string }), DID, NOW)).toStrictEqual(UNREADABLE);
    expect(source.queries).toHaveLength(0);
  });

  test.each<readonly [string, unknown]>([
    ['a time that is NaN', Number.NaN],
    ['a time that is infinite', Number.POSITIVE_INFINITY],
    ['a time below zero', -1],
    ['a time with a fraction', 1.5],
    ['a time that is a text', String(NOW)],
    ['no time', undefined],
    ['a time that is null', null],
  ])('%s is unreadable, and no list is asked: an expired attestation is never valid because the time is unknown', async (_name, at) => {
    const expired = listing([view(ID, datum({ validUntil: NOW - DAY }))]);
    expect(await readCompliance(depsOf(expired.list), DID, at as number)).toStrictEqual(UNREADABLE);
    expect(expired.queries).toHaveLength(0);
  });

  test.each<readonly [string, unknown]>([
    ['no deps', null],
    ['deps with no list', { issuerPkh: REGISTRY.keyHash, clock: new ManualClock() }],
    ['a list that is not a function', { list: 'list', issuerPkh: REGISTRY.keyHash, clock: new ManualClock() }],
    ['deps with no clock', { list: listing([view(ID, datum())]).list, issuerPkh: REGISTRY.keyHash }],
    ['a clock whose sleep is not a function', { list: listing([view(ID, datum())]).list, issuerPkh: REGISTRY.keyHash, clock: { sleep: 'sleep' } }],
  ])('%s is unreadable, and the call does not throw', async (_name, deps) => {
    expect(await readCompliance(deps as ComplianceDeps, DID, NOW)).toStrictEqual(UNREADABLE);
  });
});

describe('the fact', () => {
  test.each<readonly [string, number, string]>([
    ['a whole second', NOW, '2026-11-24T12:00:00Z'],
    ['999 milliseconds after a second: the text is cut to the second', NOW + 999, '2026-11-24T12:00:00Z'],
    ['the next second', NOW + 1000, '2026-11-24T12:00:01Z'],
    ['the epoch', 0, '1970-01-01T00:00:00Z'],
    ['the last millisecond of the year 9999', LAST_TIME_MS, '9999-12-31T23:59:59Z'],
  ])('the time of %s is written in UTC with the whole second', async (_name, ms, text) => {
    const read = await readItems([view(ID, datum({ issuedAt: ms, validFrom: null, validUntil: ms }))]);
    expect(read.issued_at).toBe(text);
    expect(read.valid_until).toBe(text);
  });

  test('the time of a revocation is written to the second, cut and not rounded', async () => {
    const read = await readItems([view(ID, datum(revoked(NOW - 1, 1)))]);
    expect(read.revoked_at).toBe('2026-11-24T11:59:59Z');
  });

  test('a fact has exactly the members of the fact of the bidder file, in this order, in each of the four states', async () => {
    const members = ['state', 'attestation', 'attestation_state', 'issued_at', 'valid_until', 'revoked_at', 'revoke_reason', 'contested'];
    const reads = [
      await readItems([view(ID, datum())]),
      await readItems([view(ID, datum(revoked(NOW - DAY, 1)))]),
      await readItems([]),
      await readItems([damagedView({ attestation: null })]),
    ];
    expect(reads.map((read) => read.state)).toStrictEqual(['valid', 'invalid', 'absent', 'unreadable']);
    for (const read of reads) expect(Object.keys(read)).toStrictEqual(members);
  });

  test('each read gives a new object, so that a caller that changes one fact changes no other', async () => {
    const first = await readItems([]);
    const second = await readItems([]);
    expect(first).toStrictEqual(second);
    expect(first).not.toBe(second);
  });
});
