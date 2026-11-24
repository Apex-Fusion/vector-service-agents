// packages/usecase-kit/test/bids/ranking.test.ts: the ranking of use case 3 (supplier bid evaluation). The Sourcing Agent proposes it as the `document` of a proposal, and it writes the approved ranking to the
// sourcing record of the mock service. So the parser of the kit takes a subset of what that record takes: a table of rankings holds the verdict of the kit and the verdict of the record for each, as the
// code of the record gives it (the record is another package, so a test of this package does not import it). The ranking holds no free text of a bidder: its members are identifiers, hashes, numbers, a
// domain and codes. The builder gives the ranks by position, and it never sorts and never changes a score. Each refusal has an accepted twin.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DOCUMENT_SCHEMAS, canonicalSha256, makeProposal, proposalDigest } from '@vsa/usecase-kit/protocol';
import { BID_DESK_MODEL, EXCLUDED_REASONS, RANKING_SCHEMA, SCORE_COMPONENTS, WEIGHT_NAMES, buildRanking, parseRanking, parseRfqDocument, parseWeights, receiptSha256, rfqSha256 } from '@vsa/usecase-kit/bids';
import type { RankedEntry, Ranking } from '@vsa/usecase-kit/bids';
import { MARKER, change, expectRefused, golden as supportGolden, listAt, must, objectAt, withPrototype } from './support.ts';
import type { Json } from './support.ts';

/** The SHA-256 of the bytes of the golden file. A change of the file shows here. */
const GOLDEN_FILE_SHA256 = '86450c83cc314ce04accf12ebdb5b295b31750487f9ef1bffb55e9c8992445bf';
const SALT = '66'.repeat(32);
/** The digest of the golden ranking with the salt above: SHA-256 of the 32 salt bytes and the canonical text of the document. An approver binds this value. */
const GOLDEN_DIGEST = '229c98dd612d96024b74f61a11027975a6d2e714e523c889caab663fb8b386d8';
/** The canonical hash of the golden request of the rfq test: the `rfq_sha256` of the golden ranking. */
const RFQ_SHA256 = '42ca167e867b2e8df3a82b7dc4a5b1c2a3a96f523e1f56a3863936a5dceadf35';
/** The hash of the receipt and the signature below, as the canonical text of the pair gives it: the `receipt_sha256` of the first ranked entry of the golden ranking. */
const RECEIPT_SHA256 = '8154f0b1be7e1d7418956829699b67e66902bb6644f58125347d7f4b0bcf6c89';

const RECEIPT = {
  escrow_ref: `${'e5'.repeat(32)}#0`,
  supplier_pkh: '7d'.repeat(28),
  prompt_hash: '33'.repeat(32),
  response_hash: '44'.repeat(32),
  model: BID_DESK_MODEL,
  prompt_tokens: 412,
  completion_tokens: 58,
  wallclock_ms: 2140,
};
const SIGNATURE = '8e'.repeat(64);

const MEMBERS = ['schema', 'rfq_id', 'rfq_sha256', 'tenant', 'weights', 'ranked', 'excluded'] as const;
const ENTRY_MEMBERS = ['rank', 'desk_did', 'organisation', 'score', 'components', 'quote'] as const;
const QUOTE_MEMBERS = ['escrow_ref', 'receipt_sha256', 'total', 'lead_time_days'] as const;
const EXCLUDED_MEMBERS = ['desk_did', 'reason', 'code'] as const;
const REQUIRED_ENTRY_MEMBERS = ENTRY_MEMBERS.filter((name) => name !== 'organisation');

type Step = string | number;

const goldenText = (): string => readFileSync(new URL('./golden/ranking.json', import.meta.url), 'utf8');
const golden = (): Json => JSON.parse(goldenText()) as Json;

// Bidder number `index` of a generated ranking: a DID, an escrow reference and a receipt hash that no other bidder has, for an index from 1 to 100.
const didOf = (index: number): string => `did:vector:${index.toString(16).padStart(2, '0').repeat(32)}`;
// The DIDs of the golden ranking: the three ranked bidders, then the excluded bidder.
const DID_A = didOf(0xa1);
const DID_B = didOf(0xb2);
const DID_C = didOf(0xc3);
const DID_D = didOf(0xd4);
const entryOf = (index: number): Json => ({
  rank: index,
  desk_did: didOf(index),
  score: 100 - index,
  components: { price: 50, lead_time: 50, reliability: 50, compliance: 50 },
  quote: { escrow_ref: `${(index + 100).toString(16).padStart(2, '0').repeat(32)}#0`, receipt_sha256: (index + 150).toString(16).padStart(2, '0').repeat(32), total: 1000 + index, lead_time_days: index },
});
const excludedOf = (index: number, reason = 'not_invited', code: string | null = null): Json => ({ desk_did: didOf(index), reason, code });
/** The golden ranking with `count` generated entries and the given excluded entries: the entries have no organisation. */
const rankingOf = (count: number, excluded: Json[] = []): Json => ({ ...golden(), ranked: Array.from({ length: count }, (_, index) => entryOf(index + 1)), excluded });
/** The ranking of 3 generated entries, with the ranks that the test gives. */
const withRanks = (ranks: readonly unknown[]): Json => ({ ...golden(), ranked: ranks.map((rank, index) => ({ ...entryOf(index + 1), rank })), excluded: [] });

/** A ranking that `change` made from `base`: the parser must refuse it, and the detail must name `where`. */
const refusesAt = (base: Json, path: readonly Step[], value: unknown, where: string): void => expectRefused(parseRanking(change(base, path, value)), where);
const takes = (base: Json, path: readonly Step[], value: unknown): boolean => parseRanking(change(base, path, value)).ok;

type Unranked = Omit<RankedEntry, 'rank'>;
/** The entries of a ranking without their ranks: what the builder takes. */
const unranked = (ranking: Ranking): Unranked[] => ranking.ranked.map(({ rank: _rank, ...entry }) => entry);
const goldenEntries = (): Unranked[] => unranked(must(parseRanking(golden())));
/** The name that the detail of a refusal gives to the member at `path` of a ranking. */
const nameOf = (path: readonly Step[]): string => path.reduce<string>((name, step) => (typeof step === 'number' ? `${name}[${step}]` : `${name}.${step}`), 'ranking');
type BuildInput = Parameters<typeof buildRanking>[0];
/** The input of the builder that makes the golden ranking, with the members that a test changes. */
const buildInput = (changes: Partial<BuildInput> = {}): BuildInput => ({
  rfq: must(parseRfqDocument(supportGolden('rfq'))),
  tenant: 'run1',
  weights: must(parseWeights(supportGolden('weights'))),
  entries: goldenEntries(),
  excluded: must(parseRanking(golden())).excluded,
  ...changes,
});

describe('the golden ranking', () => {
  it('is the file that the hash names, and it holds the members of the page in their order, with 3 ranked entries and 1 excluded entry', () => {
    expect(createHash('sha256').update(goldenText()).digest('hex')).toBe(GOLDEN_FILE_SHA256);
    const ranking = golden();
    expect(Object.keys(ranking)).toStrictEqual([...MEMBERS]);
    expect(Object.keys(objectAt(ranking, ['weights']))).toStrictEqual([...WEIGHT_NAMES]);
    expect(listAt(ranking, ['ranked'])).toHaveLength(3);
    expect(listAt(ranking, ['excluded'])).toHaveLength(1);
    expect(Object.keys(objectAt(ranking, ['ranked', 0]))).toStrictEqual([...ENTRY_MEMBERS]);
    expect(Object.keys(objectAt(ranking, ['ranked', 0, 'components']))).toStrictEqual([...SCORE_COMPONENTS]);
    expect(Object.keys(objectAt(ranking, ['ranked', 0, 'quote']))).toStrictEqual([...QUOTE_MEMBERS]);
    expect(Object.keys(objectAt(ranking, ['excluded', 0]))).toStrictEqual([...EXCLUDED_MEMBERS]);
  });

  it('has an entry with no organisation, and an excluded entry with a code', () => {
    expect(Object.keys(objectAt(golden(), ['ranked', 2]))).toStrictEqual([...REQUIRED_ENTRY_MEMBERS]);
    expect('organisation' in objectAt(golden(), ['ranked', 2])).toBe(false);
    expect(objectAt(golden(), ['excluded', 0]).code).toBe('duplicate_rfq');
  });

  it('names the bidders that the tables of this file call A, B, C and D: the three ranked bidders in their order, and the excluded bidder', () => {
    expect([0, 1, 2].map((index) => objectAt(golden(), ['ranked', index]).desk_did)).toStrictEqual([DID_A, DID_B, DID_C]);
    expect(objectAt(golden(), ['excluded', 0]).desk_did).toBe(DID_D);
  });

  it('passes the parser, and the copy holds the same members in the same order at each level', () => {
    const result = parseRanking(golden());
    expect(result).toStrictEqual({ ok: true, value: golden() });
    const ranking = must(result);
    expect(Object.keys(ranking)).toStrictEqual([...MEMBERS]);
    expect(Object.keys(ranking.weights)).toStrictEqual([...WEIGHT_NAMES]);
    expect(Object.keys(ranking.ranked[0]!)).toStrictEqual([...ENTRY_MEMBERS]);
    expect(Object.keys(ranking.ranked[2]!)).toStrictEqual([...REQUIRED_ENTRY_MEMBERS]);
    expect(Object.keys(ranking.ranked[0]!.components)).toStrictEqual([...SCORE_COMPONENTS]);
    expect(Object.keys(ranking.ranked[0]!.quote)).toStrictEqual([...QUOTE_MEMBERS]);
    expect(Object.keys(ranking.excluded[0]!)).toStrictEqual([...EXCLUDED_MEMBERS]);
  });

  it('gives a copy that shares no object with the input, and changes nothing of the input', () => {
    const input = golden();
    const before = JSON.stringify(input);
    const ranking = must(parseRanking(input));
    expect(JSON.stringify(input)).toBe(before);
    expect(ranking).not.toBe(input);
    expect(ranking.weights).not.toBe(input.weights);
    expect(ranking.ranked).not.toBe(input.ranked);
    expect(ranking.ranked[0]).not.toBe(objectAt(input, ['ranked', 0]));
    expect(ranking.ranked[0]!.components).not.toBe(objectAt(input, ['ranked', 0, 'components']));
    expect(ranking.ranked[0]!.quote).not.toBe(objectAt(input, ['ranked', 0, 'quote']));
    expect(ranking.excluded).not.toBe(input.excluded);
    expect(ranking.excluded[0]).not.toBe(objectAt(input, ['excluded', 0]));
    for (const object of [ranking, ranking.weights, ranking.ranked[0], ranking.ranked[0]!.components, ranking.ranked[0]!.quote, ranking.excluded[0]]) expect(Object.getPrototypeOf(object)).toBe(Object.prototype);
  });

  it('gives the copy in the order of the page at each level, whatever the order of the input', () => {
    const shuffled = {
      excluded: [{ code: 'duplicate_rfq', reason: 'refused', desk_did: DID_D }],
      ranked: [0, 1, 2].map((index) => Object.fromEntries(Object.entries(objectAt(golden(), ['ranked', index])).reverse())),
      weights: { compliance: 0.2, reliability: 0.2, lead_time: 0.2, price: 0.4 },
      tenant: 'run1',
      rfq_sha256: RFQ_SHA256,
      rfq_id: 'run1-rfq-1',
      schema: 'vector.usecase.ranking.v1',
    };
    const ranking = must(parseRanking(shuffled));
    expect(Object.keys(ranking)).toStrictEqual([...MEMBERS]);
    expect(Object.keys(ranking.ranked[0]!)).toStrictEqual([...ENTRY_MEMBERS]);
    expect(Object.keys(ranking.ranked[1]!.quote)).toStrictEqual([...QUOTE_MEMBERS]);
    expect(Object.keys(ranking.excluded[0]!)).toStrictEqual([...EXCLUDED_MEMBERS]);
    expect(ranking).toStrictEqual(golden());
  });

  it('holds only ASCII texts, so that no text of an accepted ranking changes in the NFC form', () => {
    const texts: string[] = [];
    const walk = (value: unknown): void => {
      if (typeof value === 'string') texts.push(value);
      else if (Array.isArray(value)) value.forEach(walk);
      else if (typeof value === 'object' && value !== null) Object.values(value).forEach(walk);
    };
    walk(must(parseRanking(golden())));
    expect(texts).toHaveLength(18);
    for (const text of texts) {
      expect(text).toMatch(/^[\x20-\x7e]+$/);
      expect(text).toBe(text.normalize('NFC'));
    }
  });

  it('names the request that the rfq test hashes, and the receipt that the receipt test hashes', () => {
    const ranking = must(parseRanking(golden()));
    expect(ranking.rfq_sha256).toBe(RFQ_SHA256);
    expect(rfqSha256(must(parseRfqDocument(supportGolden('rfq'))))).toStrictEqual({ ok: true, value: ranking.rfq_sha256 });
    expect(ranking.rfq_id).toBe(supportGolden('rfq').rfq_id);
    expect(ranking.weights).toStrictEqual(supportGolden('weights'));
    expect(receiptSha256(RECEIPT, SIGNATURE)).toStrictEqual({ ok: true, value: ranking.ranked[0]!.quote.receipt_sha256 });
    expect(ranking.ranked[0]!.quote.escrow_ref).toBe(RECEIPT.escrow_ref);
  });
});

describe('the digest of a ranking', () => {
  it('is the digest of the protocol for the document and a salt, and one value of the golden ranking is pinned', () => {
    expect(proposalDigest(SALT, golden())).toStrictEqual({ ok: true, value: GOLDEN_DIGEST });
    expect(proposalDigest(SALT, must(parseRanking(golden())))).toStrictEqual({ ok: true, value: GOLDEN_DIGEST });
  });

  it('is the proposal digest that a proposal of the protocol makes for the document, and the document of the proposal is the ranking', () => {
    const proposal = must(makeProposal(must(parseRanking(golden())), SALT));
    expect(proposal.proposal_digest).toBe(GOLDEN_DIGEST);
    expect(proposal.document).toStrictEqual(golden());
    expect(proposal.salt).toBe(SALT);
  });

  it('changes when a score, an order, a quote hash or an excluded code changes, so that an approval binds every number', () => {
    const digestOf = (document: Json): unknown => must(proposalDigest(SALT, document));
    expect(digestOf(change(golden(), ['ranked', 1, 'score'], 80.3))).not.toBe(GOLDEN_DIGEST);
    expect(digestOf(change(golden(), ['ranked', 2, 'components', 'compliance'], 1))).not.toBe(GOLDEN_DIGEST);
    expect(digestOf(change(golden(), ['ranked', 0, 'quote', 'receipt_sha256'], '00'.repeat(32)))).not.toBe(GOLDEN_DIGEST);
    expect(digestOf(change(golden(), ['excluded', 0, 'code'], null))).not.toBe(GOLDEN_DIGEST);
    const swapped = { ...golden(), ranked: [listAt(golden(), ['ranked'])[1], listAt(golden(), ['ranked'])[0], listAt(golden(), ['ranked'])[2]] };
    expect(digestOf(swapped)).not.toBe(GOLDEN_DIGEST);
  });

  it('is the same for the same document in another order of the members, and for the copy that the parser makes', () => {
    const reversed = Object.fromEntries(Object.entries(golden()).reverse());
    expect(proposalDigest(SALT, reversed)).toStrictEqual({ ok: true, value: GOLDEN_DIGEST });
    expect(canonicalSha256(reversed)).toStrictEqual(canonicalSha256(golden()));
  });
});

describe('the names of the ranking', () => {
  it('has the schema of the documents of use case 3, and the five reasons of an excluded bidder in their order', () => {
    expect(RANKING_SCHEMA).toBe('vector.usecase.ranking.v1');
    expect(RANKING_SCHEMA).toBe(DOCUMENT_SCHEMAS['bid-evaluation']);
    expect(EXCLUDED_REASONS).toStrictEqual(['not_invited', 'not_active', 'refused', 'failed', 'disputed']);
  });

  it.each(EXCLUDED_REASONS)('takes the reason %s for an excluded bidder', (reason) => {
    expect(parseRanking(change(golden(), ['excluded', 0, 'reason'], reason)).ok).toBe(true);
  });
});

describe('parseRanking: the fields of the ranking', () => {
  it.each([
    ['another version', 'vector.usecase.ranking.v2'], ['the schema of the purchase order', 'vector.usecase.po.v1'], ['a capital letter', 'Vector.usecase.ranking.v1'], ['a space at the end', 'vector.usecase.ranking.v1 '],
    ['a line break at the end', 'vector.usecase.ranking.v1\n'], ['the empty text', ''], ['null', null], ['a number', 1], ['a list', ['vector.usecase.ranking.v1']], ['a text with a line break', MARKER],
  ])('refuses the schema of %s, and takes the twin', (_what, schema) => {
    refusesAt(golden(), ['schema'], schema, 'ranking.schema');
    expect(takes(golden(), ['schema'], 'vector.usecase.ranking.v1')).toBe(true);
  });

  it.each([
    ['the empty text', ''], ['65 characters', 'A'.repeat(65)], ['a space', 'A B'], ['a slash', 'A/B'], ['a line break at the end', 'A\n'], ['a hyphen at the start', '-A'], ['a dot at the start', '.A'], ['a number', 5],
    ['null', null], ['a list', ['run1']], ['a letter with a mark in the NFD form', 'e\u0301'], ['a letter with a mark in the NFC form', '\u00e9'], ['a text with a line break', MARKER],
  ])('refuses a request id of %s, and takes the twins', (_what, id) => {
    refusesAt(golden(), ['rfq_id'], id, 'ranking.rfq_id');
    for (const good of ['A', 'a.b_c-d', '9', 'A'.repeat(64)]) expect(takes(golden(), ['rfq_id'], good), good).toBe(true);
  });

  it('checks the request id as it is written: the Kelvin sign is refused, although NFC turns it into the letter K, and the twin with the letter K passes', () => {
    expect('\u212a'.normalize('NFC')).toBe('K');
    refusesAt(golden(), ['rfq_id'], 'run1-rfq-\u212a', 'ranking.rfq_id');
    expect(takes(golden(), ['rfq_id'], 'run1-rfq-K')).toBe(true);
  });

  it.each([
    ['63 characters', '4'.repeat(63)], ['65 characters', '4'.repeat(65)], ['capital letters', 'AB'.repeat(32)], ['a letter outside hex', 'g'.repeat(64)], ['the empty text', ''], ['a number', 5], ['null', null],
    ['a hash with a prefix', `sha256:${'4'.repeat(64)}`], ['a hash with a space at the end', `${'4'.repeat(64)} `], ['a text with a line break', MARKER],
  ])('refuses a request hash of %s, and takes the twin', (_what, hash) => {
    refusesAt(golden(), ['rfq_sha256'], hash, 'ranking.rfq_sha256');
    expect(takes(golden(), ['rfq_sha256'], '4'.repeat(64))).toBe(true);
  });

  it.each([
    ['the empty text', ''], ['capital letters', 'Run1'], ['an underscore', 'run_1'], ['a dot', 'run.1'], ['a hyphen at the start', '-run1'], ['49 characters', 'a'.repeat(49)], ['a space at the end', 'run1 '],
    ['a line break at the end', 'run1\n'], ['a slash', 'run/1'], ['a number', 5], ['null', null], ['a letter with a mark', 'r\u00fcn1'], ['a text with a line break', MARKER],
  ])('refuses a tenant of %s, and takes the twins', (_what, tenant) => {
    refusesAt(golden(), ['tenant'], tenant, 'ranking.tenant');
    for (const good of ['a', '9', 'run1', 'a-b-c', '9-', 'a'.repeat(48)]) expect(takes(golden(), ['tenant'], good), good).toBe(true);
  });

  it('refuses weights that parseWeights refuses, and names the member', () => {
    refusesAt(golden(), ['weights', 'price'], 0.5, 'ranking.weights');
    refusesAt(golden(), ['weights', 'price'], -0.1, 'ranking.weights.price');
    refusesAt(golden(), ['weights', 'price'], 0.40001, 'ranking.weights.price');
    refusesAt(golden(), ['weights', 'extra'], 0, 'ranking.weights');
    refusesAt(golden(), ['weights', 'compliance'], undefined, 'ranking.weights');
    refusesAt(golden(), ['weights'], null, 'ranking.weights');
    refusesAt(golden(), ['weights'], [0.4, 0.2, 0.2, 0.2], 'ranking.weights');
    expect(takes(golden(), ['weights'], { price: 0.25, lead_time: 0.25, reliability: 0.25, compliance: 0.25 })).toBe(true);
    expect(takes(golden(), ['weights'], { price: 0.3, lead_time: 0.3, reliability: 0.3, compliance: 0.1 })).toBe(true);
  });

  it('gives weights that the weights parser gives', () => {
    const ranking = must(parseRanking(change(golden(), ['weights'], { compliance: 0.1, reliability: 0.3, lead_time: 0.3, price: 0.3 })));
    expect(ranking.weights).toStrictEqual(must(parseWeights({ price: 0.3, lead_time: 0.3, reliability: 0.3, compliance: 0.1 })));
    expect(Object.keys(ranking.weights)).toStrictEqual([...WEIGHT_NAMES]);
  });
});

describe('parseRanking: the ranked list and the ranks', () => {
  it('takes 1 to 20 ranked entries, and refuses no entry and 21 entries', () => {
    expect(parseRanking(rankingOf(1)).ok).toBe(true);
    expect(parseRanking(rankingOf(20)).ok).toBe(true);
    expectRefused(parseRanking(rankingOf(0)), 'ranking.ranked');
    expectRefused(parseRanking(rankingOf(21)), 'ranking.ranked');
    expect(must(parseRanking(rankingOf(20))).ranked.map((entry) => entry.rank)).toStrictEqual(Array.from({ length: 20 }, (_, index) => index + 1));
  });

  it.each([['an object', {}], ['a text', 'x'], ['null', null], ['a number', 1], ['an object with the keys of a list', { 0: entryOf(1), length: 1 }]])('refuses ranked that is %s', (_what, value) => {
    refusesAt(golden(), ['ranked'], value, 'ranking.ranked');
  });

  it('takes the ranks 1 to n in the order of the list, and refuses a rank that is not the position, and names the entry', () => {
    expect(parseRanking(withRanks([1, 2, 3])).ok).toBe(true);
    const wrong: ReadonlyArray<readonly [string, readonly unknown[], number]> = [
      ['a gap', [1, 3, 4], 1], ['the order of the ranks reversed', [3, 2, 1], 0], ['the first two swapped', [2, 1, 3], 0], ['rank 1 two times', [1, 1, 2], 1], ['no rank 1', [2, 3, 4], 0], ['ranks that start at 0', [0, 1, 2], 0],
      ['a rank that is far above', [1, 2, 1000], 2], ['a rank above the list', [1, 2, 21], 2], ['the same rank two times at the end', [1, 2, 2], 2],
    ];
    for (const [what, ranks, index] of wrong) expectRefused(parseRanking(withRanks(ranks)), `ranking.ranked[${index}].rank`);
    expect(wrong.length).toBeGreaterThan(5);
  });

  it.each([
    ['the text 1', '1'], ['a fraction', 1.5], ['null', null], ['minus one', -1], ['true', true], ['a list', [1]], ['an object', { rank: 1 }], ['a number that a number cannot hold exactly', 2 ** 53],
    ['a text with a line break', MARKER],
  ])('refuses the rank %s in the first entry, and takes the twin', (_what, rank) => {
    refusesAt(golden(), ['ranked', 0, 'rank'], rank, 'ranking.ranked[0].rank');
    expect(takes(golden(), ['ranked', 0, 'rank'], 1)).toBe(true);
  });

  it('refuses an entry that is not an object, and takes the twin', () => {
    for (const entry of [null, 'x', 5, [1], true]) refusesAt(golden(), ['ranked', 1], entry, 'ranking.ranked[1]');
    expect(parseRanking(golden()).ok).toBe(true);
  });
});

describe('parseRanking: the bidders', () => {
  it('refuses a desk_did that is twice in ranked, and names the second entry and never the DID', () => {
    const twice = change(golden(), ['ranked', 2, 'desk_did'], objectAt(golden(), ['ranked', 0]).desk_did);
    const result = parseRanking(twice);
    expectRefused(result, 'ranking.ranked[2].desk_did');
    expect(!result.ok && result.detail).not.toContain('a1a1');
    expect(parseRanking(golden()).ok).toBe(true);
  });

  it('refuses a desk_did that is in ranked and in excluded, and names the excluded entry', () => {
    const both = change(golden(), ['excluded', 0, 'desk_did'], objectAt(golden(), ['ranked', 1]).desk_did);
    expectRefused(parseRanking(both), 'ranking.excluded[0].desk_did');
    expect(parseRanking(golden()).ok).toBe(true);
  });

  it('refuses a desk_did that is twice in excluded, and takes the twin with two bidders', () => {
    const twice = { ...golden(), excluded: [excludedOf(40), excludedOf(41, 'failed', 'llm_timeout')] };
    expect(parseRanking(twice).ok).toBe(true);
    expectRefused(parseRanking({ ...golden(), excluded: [excludedOf(40), excludedOf(40, 'failed', 'llm_timeout')] }), 'ranking.excluded[1].desk_did');
  });

  it('takes a ranking of 20 ranked entries and many excluded entries, each bidder once', () => {
    const ranking = rankingOf(20, Array.from({ length: 30 }, (_, index) => excludedOf(21 + index, EXCLUDED_REASONS[index % EXCLUDED_REASONS.length], index % 2 === 0 ? null : 'cannot_supply')));
    const parsed = must(parseRanking(ranking));
    expect(parsed.ranked).toHaveLength(20);
    expect(parsed.excluded).toHaveLength(30);
    expect(new Set([...parsed.ranked, ...parsed.excluded].map((entry) => entry.desk_did)).size).toBe(50);
  });

  it.each([
    ['62 hex characters', `did:vector:${'a1'.repeat(31)}`], ['66 hex characters', `did:vector:${'a1'.repeat(33)}`], ['capital letters', `did:vector:${'A1'.repeat(32)}`], ['another method', `did:other:${'a1'.repeat(32)}`],
    ['no prefix', 'a1'.repeat(32)], ['the empty text', ''], ['a number', 5], ['null', null], ['a space at the end', `${didOf(1)} `], ['a text with a line break', MARKER],
  ])('refuses a desk_did of %s in a ranked entry and in an excluded entry, and takes the twin', (_what, did) => {
    refusesAt(golden(), ['ranked', 0, 'desk_did'], did, 'ranking.ranked[0].desk_did');
    refusesAt(golden(), ['excluded', 0, 'desk_did'], did, 'ranking.excluded[0].desk_did');
    expect(takes(golden(), ['ranked', 0, 'desk_did'], didOf(9))).toBe(true);
    expect(takes(golden(), ['excluded', 0, 'desk_did'], didOf(9))).toBe(true);
  });
});

describe('parseRanking: the organisation', () => {
  const DOMAIN_64 = `${'a'.repeat(31)}.${'b'.repeat(32)}`;
  const ACCEPTED = ['alfa.example.org', 'a.b', 'a-1.b2-c.example.org', DOMAIN_64, `${'a'.repeat(62)}.b`, 'xn--bcher-kva.example', '1.2', 'a.b.c.d.e.f'];
  const REFUSED: ReadonlyArray<readonly [string, unknown]> = [
    ['null', null], ['upper case', 'Alfa.example.org'], ['all capital letters', 'ALFA.EXAMPLE.ORG'], ['one label', 'alfa'], ['the empty text', ''], ['a dot at the end', 'alfa.example.org.'], ['a dot at the start', '.alfa.example.org'],
    ['an empty label', 'alfa..example.org'], ['a hyphen at the start of a label', '-alfa.example.org'], ['a hyphen at the end of a label', 'alfa-.example.org'], ['a hyphen at the start of the last label', 'alfa.-org'],
    ['a space', 'alfa example.org'], ['a space at the end', 'alfa.example.org '], ['a space at the start', ' alfa.example.org'], ['a line break at the end', 'alfa.example.org\n'], ['a tab at the end', 'alfa.example.org\t'],
    ['a letter with a mark', 'alf\u00e4.example.org'], ['a slash', 'alfa.example.org/x'], ['an underscore', 'alfa_beta.example.org'], ['65 characters', `${'a'.repeat(63)}.b`], ['65 characters in two labels', `${'a'.repeat(32)}.${'b'.repeat(32)}`],
    ['a port', 'alfa.example.org:443'], ['an address with a user', 'me@alfa.example.org'], ['a number', 12345], ['true', true], ['a list', ['alfa.example.org']], ['an object', { name: 'alfa.example.org' }], ['a text with a line break', MARKER],
  ];

  it.each(ACCEPTED)('takes the organisation %s, and the copy holds it as it is', (organisation) => {
    const ranking = must(parseRanking(change(golden(), ['ranked', 0, 'organisation'], organisation)));
    expect(ranking.ranked[0]!.organisation).toBe(organisation);
  });

  it('refuses each organisation that is not a lower-case domain of at most 64 characters with at least two labels, and names the member', () => {
    for (const [what, organisation] of REFUSED) {
      const result = parseRanking(change(golden(), ['ranked', 0, 'organisation'], organisation));
      expectRefused(result, 'ranking.ranked[0].organisation');
      expect(result.ok, what).toBe(false);
    }
    expect(REFUSED.length).toBeGreaterThan(20);
    expect(takes(golden(), ['ranked', 0, 'organisation'], 'alfa.example.org')).toBe(true);
  });

  it('refuses the member with the value null, and takes the twin with no member: the entry leaves it out', () => {
    expectRefused(parseRanking(change(golden(), ['ranked', 2, 'organisation'], null)), 'ranking.ranked[2].organisation');
    expect(parseRanking(change(golden(), ['ranked', 0, 'organisation'], undefined)).ok).toBe(true);
    const without = must(parseRanking(change(golden(), ['ranked', 0, 'organisation'], undefined)));
    expect(Object.keys(without.ranked[0]!)).toStrictEqual(REQUIRED_ENTRY_MEMBERS);
    expect('organisation' in without.ranked[0]!).toBe(false);
  });

  it('gives the organisation in the place that the page gives it, after desk_did and before score', () => {
    expect(Object.keys(must(parseRanking(golden())).ranked[1]!)).toStrictEqual(['rank', 'desk_did', 'organisation', 'score', 'components', 'quote']);
  });
});

describe('parseRanking: the scores and the quote', () => {
  it.each([
    ['100.0001', 100.0001], ['101', 101], ['-0.0001', -0.0001], ['minus one', -1], ['NaN', Number.NaN], ['infinity', Number.POSITIVE_INFINITY], ['negative infinity', Number.NEGATIVE_INFINITY], ['the text 88.5', '88.5'], ['null', null],
    ['true', true], ['a list', [88.5]], ['a text with a line break', MARKER],
  ])('refuses the score %s in an entry, and each component of the same value, and takes the twins', (_what, value) => {
    refusesAt(golden(), ['ranked', 1, 'score'], value, 'ranking.ranked[1].score');
    for (const name of SCORE_COMPONENTS) refusesAt(golden(), ['ranked', 1, 'components', name], value, `ranking.ranked[1].components.${name}`);
    for (const good of [0, 100, 87.5, 0.0001]) {
      expect(takes(golden(), ['ranked', 1, 'score'], good), String(good)).toBe(true);
      for (const name of SCORE_COMPONENTS) expect(takes(golden(), ['ranked', 1, 'components', name], good), `${name} ${good}`).toBe(true);
    }
  });

  it('takes the number minus zero as a score and as a component, and gives 0', () => {
    const ranking = must(parseRanking(change(change(golden(), ['ranked', 0, 'score'], -0), ['ranked', 0, 'components', 'price'], -0)));
    expect(Object.is(ranking.ranked[0]!.score, 0)).toBe(true);
    expect(Object.is(ranking.ranked[0]!.components.price, 0)).toBe(true);
  });

  it('keeps a score as it is: it does not round, clamp or compute a score, and the score need not follow the components and the weights', () => {
    const ranking = must(parseRanking(change(change(golden(), ['ranked', 0, 'score'], 0.1 + 0.2), ['ranked', 1, 'score'], 12.3456789)));
    expect(ranking.ranked[0]!.score).toBe(0.1 + 0.2);
    expect(ranking.ranked[1]!.score).toBe(12.3456789);
    expect(ranking.ranked.map((entry) => entry.score)).toStrictEqual([0.1 + 0.2, 12.3456789, 52]);
  });

  it('refuses components with a member that is missing or not listed, and names them', () => {
    for (const name of SCORE_COMPONENTS) refusesAt(golden(), ['ranked', 0, 'components', name], undefined, 'ranking.ranked[0].components');
    refusesAt(golden(), ['ranked', 0, 'components', 'extra'], 50, 'ranking.ranked[0].components');
    refusesAt(golden(), ['ranked', 0, 'components'], null, 'ranking.ranked[0].components');
    refusesAt(golden(), ['ranked', 0, 'components'], [90, 80, 85, 100], 'ranking.ranked[0].components');
  });

  it.each([
    ['no hash sign', 'e5'.repeat(32)], ['no index', `${'e5'.repeat(32)}#`], ['no hash', '#0'], ['an index with a leading zero', `${'e5'.repeat(32)}#01`], ['capital letters', `${'E5'.repeat(32)}#0`], ['63 hex characters', `${'e5'.repeat(31)}e#0`],
    ['an index of 11 digits', `${'e5'.repeat(32)}#12345678901`], ['a minus sign', `${'e5'.repeat(32)}#-1`], ['a space at the end', `${'e5'.repeat(32)}#0 `], ['a number', 5], ['null', null], ['a text with a line break', MARKER],
  ])('refuses an escrow reference with %s, and takes the twins', (_what, ref) => {
    refusesAt(golden(), ['ranked', 0, 'quote', 'escrow_ref'], ref, 'ranking.ranked[0].quote.escrow_ref');
    for (const good of [`${'e5'.repeat(32)}#0`, `${'e5'.repeat(32)}#7`, `${'e5'.repeat(32)}#1234567890`]) expect(takes(golden(), ['ranked', 0, 'quote', 'escrow_ref'], good), good).toBe(true);
  });

  it.each([
    ['63 characters', '4'.repeat(63)], ['65 characters', '4'.repeat(65)], ['capital letters', 'AB'.repeat(32)], ['a letter outside hex', 'g'.repeat(64)], ['the empty text', ''], ['a number', 5], ['null', null],
  ])('refuses a receipt hash of %s, and takes the twin', (_what, hash) => {
    refusesAt(golden(), ['ranked', 0, 'quote', 'receipt_sha256'], hash, 'ranking.ranked[0].quote.receipt_sha256');
    expect(takes(golden(), ['ranked', 0, 'quote', 'receipt_sha256'], '4'.repeat(64))).toBe(true);
  });

  it.each(['total', 'lead_time_days'])('takes the number 0, 1 and the largest whole number in quote.%s, and refuses any other number', (name) => {
    for (const good of [0, 1, 12500, Number.MAX_SAFE_INTEGER]) expect(takes(golden(), ['ranked', 0, 'quote', name], good), `${name} ${good}`).toBe(true);
    for (const bad of [-1, 0.5, 1.5, 2 ** 53, 2 ** 53 + 2, '12500', '', null, true, [1], { value: 1 }, Number.NaN, Number.POSITIVE_INFINITY, 10n, MARKER]) {
      refusesAt(golden(), ['ranked', 0, 'quote', name], bad, `ranking.ranked[0].quote.${name}`);
    }
  });

  it('reads the number minus zero in the quote as 0', () => {
    const ranking = must(parseRanking(change(change(golden(), ['ranked', 0, 'quote', 'total'], -0), ['ranked', 0, 'quote', 'lead_time_days'], -0)));
    expect(Object.is(ranking.ranked[0]!.quote.total, 0)).toBe(true);
    expect(Object.is(ranking.ranked[0]!.quote.lead_time_days, 0)).toBe(true);
  });

  it('refuses a quote that is not an object, and a quote with a member that is missing or not listed', () => {
    for (const quote of [null, 'x', 5, [1], true]) refusesAt(golden(), ['ranked', 0, 'quote'], quote, 'ranking.ranked[0].quote');
    for (const name of QUOTE_MEMBERS) refusesAt(golden(), ['ranked', 0, 'quote', name], undefined, 'ranking.ranked[0].quote');
    refusesAt(golden(), ['ranked', 0, 'quote', 'notes'], 'Free text of the bidder.', 'ranking.ranked[0].quote');
    refusesAt(golden(), ['ranked', 0, 'quote', 'credential'], 'a.b.c', 'ranking.ranked[0].quote');
  });
});

describe('parseRanking: the excluded list', () => {
  it.each([
    ['capital letters', 'Refused'], ['a name that is not a reason', 'unknown'], ['a space at the end', 'refused '], ['the empty text', ''], ['null', null], ['a number', 5], ['a list', ['refused']], ['a hyphen in place of an underscore', 'not-invited'],
    ['a name of the prototype', 'constructor'], ['the reason of a rank', 'ranked'], ['a text with a line break', MARKER],
  ])('refuses the reason %s, and takes the twin', (_what, reason) => {
    refusesAt(golden(), ['excluded', 0, 'reason'], reason, 'ranking.excluded[0].reason');
    for (const good of EXCLUDED_REASONS) expect(takes(golden(), ['excluded', 0, 'reason'], good), good).toBe(true);
  });

  it.each([
    ['capital letters', 'Duplicate_rfq'], ['a hyphen', 'duplicate-rfq'], ['a space', 'duplicate rfq'], ['a dot', 'a.b'], ['the empty text', ''], ['65 characters', 'a'.repeat(65)], ['a line break at the end', 'a\n'],
    ['a letter with a mark', 'caf\u00e9'], ['a number', 5], ['true', true], ['a list', []], ['an object', {}], ['a text with a line break', MARKER],
  ])('refuses the code %s, and takes the twins', (_what, code) => {
    refusesAt(golden(), ['excluded', 0, 'code'], code, 'ranking.excluded[0].code');
    for (const good of [null, 'a', '0', '_', 'duplicate_rfq', 'a_b9', 'a'.repeat(64)]) expect(takes(golden(), ['excluded', 0, 'code'], good), String(good)).toBe(true);
  });

  it('keeps the code null as null, and refuses an excluded entry with no code member: a code is null or a text', () => {
    expect(must(parseRanking(change(golden(), ['excluded', 0, 'code'], null))).excluded[0]!.code).toBeNull();
    refusesAt(golden(), ['excluded', 0, 'code'], undefined, 'ranking.excluded[0]');
  });

  it('takes an empty excluded list, and refuses an excluded member that is not a list', () => {
    expect(must(parseRanking({ ...golden(), excluded: [] })).excluded).toStrictEqual([]);
    for (const value of [{}, 'x', null, 5]) refusesAt(golden(), ['excluded'], value, 'ranking.excluded');
  });

  it('refuses an excluded entry that is not an object', () => {
    for (const entry of [null, 'x', 5, [1], true]) refusesAt(golden(), ['excluded', 0], entry, 'ranking.excluded[0]');
  });
});

describe('parseRanking: the members', () => {
  const LEVELS: ReadonlyArray<readonly [string, readonly Step[]]> = [
    ['ranking', []], ['weights', ['weights']], ['a ranked entry', ['ranked', 0]], ['the components', ['ranked', 0, 'components']], ['the quote', ['ranked', 0, 'quote']], ['an excluded entry', ['excluded', 0]],
  ];
  const WHERE: Record<string, string> = {
    ranking: 'ranking', weights: 'ranking.weights', 'a ranked entry': 'ranking.ranked[0]', 'the components': 'ranking.ranked[0].components', 'the quote': 'ranking.ranked[0].quote', 'an excluded entry': 'ranking.excluded[0]',
  };

  it.each(LEVELS)('refuses a member that is not listed in %s, and takes the twin', (what, path) => {
    const result = parseRanking(change(golden(), [...path, 'extra'], 1));
    expectRefused(result, WHERE[what]!);
    expect(!result.ok && result.detail).toContain('"extra"');
    expect(parseRanking(golden()).ok).toBe(true);
  });

  it('refuses each member that is missing, in the ranking, a ranked entry, the quote and an excluded entry, and names it', () => {
    const cases: ReadonlyArray<readonly [readonly Step[], readonly string[]]> = [[[], MEMBERS], [['ranked', 0], REQUIRED_ENTRY_MEMBERS], [['ranked', 0, 'quote'], QUOTE_MEMBERS], [['excluded', 0], EXCLUDED_MEMBERS]];
    for (const [path, names] of cases) {
      for (const name of names) {
        const result = parseRanking(change(golden(), [...path, name], undefined));
        expect(result.ok, `${path.join('.')} ${name}`).toBe(false);
        expect(!result.ok && result.code).toBe('bad_shape');
        expect(!result.ok && result.detail).toContain(`"${name}"`);
      }
    }
  });

  it('refuses a name in another case or with another spelling in the place of a member of the ranking', () => {
    for (const name of ['Schema', 'RFQ_ID', 'rfq-id', 'rfqId', 'tenant ', 'Ranked', 'constructor', 'toString']) {
      expectRefused(parseRanking(change(change(golden(), ['tenant'], undefined), [name], 'run1')), 'tenant');
    }
  });

  it.each([['a list', []], ['a text', 'x'], ['null', null], ['a number', 1], ['undefined', undefined], ['true', true], ['the list of ranked entries', listAt(golden(), ['ranked'])]])('refuses a ranking that is %s', (_what, value) => {
    expectRefused(parseRanking(value), 'ranking');
  });

  it('names the field that the caller gives, and never repeats a value in a detail', () => {
    expectRefused(parseRanking(null, 'proposal.document'), 'proposal.document');
    expectRefused(parseRanking(change(golden(), ['tenant'], 'Run1'), 'proposal.document'), 'proposal.document.tenant');
    expectRefused(parseRanking(change(golden(), ['ranked', 1, 'score'], 101), 'proposal.document'), 'proposal.document.ranked[1].score');
    expectRefused(parseRanking(change(golden(), ['extra'], 1), 'proposal.document'), 'proposal.document');
    const result = parseRanking(change(golden(), ['ranked', 0, 'score'], 123456.789));
    expect(!result.ok && result.detail).not.toContain('123456');
    const text = parseRanking(change(golden(), ['ranked', 0, 'organisation'], 'Secret.Example.Org'));
    expect(!text.ok && text.detail).not.toContain('Secret');
    for (const path of [['rfq_id'], ['tenant'], ['ranked', 0, 'desk_did'], ['ranked', 0, 'organisation'], ['ranked', 0, 'quote', 'escrow_ref'], ['excluded', 0, 'reason'], ['excluded', 0, 'code']] as const) {
      refusesAt(golden(), path, MARKER, nameOf(path));
    }
  });
});

describe('a value that is not plain JSON data', () => {
  const LEVELS: ReadonlyArray<readonly [readonly Step[], string]> = [
    [[], 'tenant'], [['weights'], 'price'], [['ranked', 0], 'score'], [['ranked', 0, 'components'], 'price'], [['ranked', 0, 'quote'], 'total'], [['excluded', 0], 'code'],
  ];

  it.each(LEVELS)('refuses the member of %j that is an accessor, and never runs the getter', (path, member) => {
    let reads = 0;
    const input = golden();
    const holder = objectAt(input, path);
    const value = holder[member];
    Object.defineProperty(holder, member, { get() { reads += 1; return value; }, enumerable: true, configurable: true });
    expectRefused(parseRanking(input), member);
    expect(reads).toBe(0);
    expect(parseRanking(golden()).ok).toBe(true);
  });

  it('refuses an index of a list that is an accessor, and never runs the getter', () => {
    let reads = 0;
    const input = golden();
    const list = listAt(input, ['ranked']);
    const entry = list[0];
    Object.defineProperty(list, 0, { get() { reads += 1; return entry; }, enumerable: true, configurable: true });
    expectRefused(parseRanking(input), 'ranking.ranked[0]');
    expect(reads).toBe(0);
  });

  it.each(LEVELS)('refuses the key __proto__ in %j, with a value that looks right', (path) => {
    const input = golden();
    Object.defineProperty(objectAt(input, path), '__proto__', { value: { x: 1 }, enumerable: true, configurable: true, writable: true });
    expectRefused(parseRanking(input), '__proto__');
    expect(parseRanking(golden()).ok).toBe(true);
  });

  it('refuses the key that JSON.parse makes from the text __proto__', () => {
    expectRefused(parseRanking(JSON.parse(goldenText().replace('"tenant": "run1"', '"tenant": "run1", "__proto__": { "x": 1 }'))), '__proto__');
  });

  it('refuses a value that JSON cannot hold, and a key that is not a string or not enumerable', () => {
    expectRefused(parseRanking({ ...golden(), extra: undefined }), 'extra');
    expectRefused(parseRanking({ ...golden(), extra: () => 1 }), 'extra');
    expectRefused(parseRanking({ ...golden(), [Symbol('x')]: 1 }), 'ranking');
    const hidden = golden();
    Object.defineProperty(hidden, 'extra', { value: 1, enumerable: false, configurable: true });
    expectRefused(parseRanking(hidden), 'ranking');
    const holes = golden();
    holes.ranked = [entryOf(1), , entryOf(3)];
    expectRefused(parseRanking(holes), 'ranking.ranked[1]');
  });

  it('refuses a Proxy that throws and a Proxy that was revoked, at the top and in an entry, and never throws', () => {
    const throws = new Proxy(golden(), { ownKeys() { throw new Error('the Proxy refuses'); } });
    expect(() => parseRanking(throws)).not.toThrow();
    expectRefused(parseRanking(throws), 'ranking');
    const { proxy, revoke } = Proxy.revocable(golden(), {});
    revoke();
    expect(() => parseRanking(proxy)).not.toThrow();
    expectRefused(parseRanking(proxy), 'ranking');
    const inner = golden();
    listAt(inner, ['ranked'])[0] = new Proxy(entryOf(1), { ownKeys() { throw new Error('the Proxy refuses'); } });
    expect(() => parseRanking(inner)).not.toThrow();
    expectRefused(parseRanking(inner), 'ranking');
  });

  it('takes an object with no prototype, and refuses an object of a class', () => {
    const bare = Object.assign(Object.create(null) as Json, golden());
    expect(parseRanking(bare)).toStrictEqual({ ok: true, value: golden() });
    class Ranking {
      schema = 'vector.usecase.ranking.v1';
    }
    expectRefused(parseRanking(new Ranking()), 'ranking');
  });

  it('refuses a list that is not a plain list, and a list with a key that is not an index', () => {
    class Entries extends Array {}
    const input = golden();
    input.ranked = Entries.from([entryOf(1)]);
    expectRefused(parseRanking(input), 'ranking.ranked');
    const keyed = golden();
    Object.assign(listAt(keyed, ['ranked']), { extra: 1 });
    expectRefused(parseRanking(keyed), 'ranking.ranked');
  });

  it('refuses a member that is nested deeper than the protocol allows', () => {
    let deep: unknown = 1;
    for (let level = 0; level < 40; level += 1) deep = { deep };
    expectRefused(parseRanking({ ...golden(), extra: deep }), 'ranking');
  });
});

describe('a prototype that was changed', () => {
  const PLAIN = parseRanking(golden());

  it.each([
    ['ranked', 'ranked'], ['0', '0'], ['organisation', 'organisation'], ['rank', 'rank'], ['score', 'score'], ['code', 'code'], ['quote', 'quote'],
  ])('with a setter for %s on Object.prototype, the result is the result of the plain twin, and no setter runs', (_what, key) => {
    let calls = 0;
    const input = golden();
    const seen = withPrototype(Object.prototype, { [key]: { set() { calls += 1; } } }, () => parseRanking(input));
    expect(seen).toStrictEqual(PLAIN);
    expect(calls).toBe(0);
  });

  it('reads no member that a prototype holds: an organisation on Object.prototype does not reach an entry that has none, and the copy has its own members', () => {
    const seen = withPrototype(Object.prototype, { organisation: { value: 'evil.example.org', writable: true, enumerable: true } }, () => parseRanking(golden()));
    expect(seen).toStrictEqual(PLAIN);
    const ranking = must(seen);
    expect(Object.hasOwn(ranking.ranked[2]!, 'organisation')).toBe(false);
    const inherited = Object.fromEntries(MEMBERS.map((name) => [name, { value: 'x', writable: true, enumerable: true }]));
    expect(withPrototype(Object.prototype, inherited, () => parseRanking({})).ok).toBe(false);
  });
});

describe('the rankings that the sourcing record of the mock service takes', () => {
  // The record (`parseRanking` of the mock service) reads the body with the members `ranking`, `salt` and `approval`. A row holds the ranking, the verdict of the kit and the verdict of that code on the
  // body `{ ranking, salt: 64 hex characters, approval: null }` for the tenant of the URL `run1`, which is the tenant of the golden ranking, as the code of the record gives it:
  //   the ranking is an object; `schema` is the schema; `tenant` is a text of 1 to 48 characters that equals the tenant of the URL; `rfq_id` has the form of an identifier; `ranked` is a list of 1 to 20
  //   entries; each entry is an object, its `organisation` is absent or a lower-case domain of at most 64 characters with at least two labels (null is refused), its `rank` is a whole number from 1 to 1000
  //   and its `desk_did` is a DID; the ranks are different from each other, and one entry has rank 1. The record reads no other member and keeps the ranking exactly as it was sent.
  // The kit takes a subset: a row that the kit takes is a row that the record takes. The tenant of the URL is the one fact that the kit cannot see: the agent compares it with the tenant of the request.
  type Verdict = 'accepts' | 'refuses';
  interface Row {
    readonly what: string;
    readonly ranking: unknown;
    readonly kit: Verdict;
    readonly mock: Verdict;
  }
  const rowsOf = (kit: Verdict, mock: Verdict, rankings: ReadonlyArray<readonly [string, unknown]>): Row[] => rankings.map(([what, ranking]) => ({ what, ranking, kit, mock }));
  const at = (path: readonly Step[], value: unknown): Json => change(golden(), path, value);
  const orgAt = (organisation: unknown): Json => at(['ranked', 0, 'organisation'], organisation);
  const many = (count: number): Json => rankingOf(count);

  const BOTH_TAKE = rowsOf('accepts', 'accepts', [
    ['the golden ranking', golden()], ['one ranked entry and no excluded entry', many(1)], ['20 ranked entries', many(20)], ['20 ranked entries and an excluded entry', rankingOf(20, [excludedOf(40)])],
    ['an excluded list that is empty', at(['excluded'], [])], ['an organisation on every entry', change(change(orgAt('alfa.example.org'), ['ranked', 1, 'organisation'], 'bravo.example.org'), ['ranked', 2, 'organisation'], 'charlie.example.org')],
    ['no organisation on any entry', many(3)], ['a score of 0 and four components of 0', change(change(golden(), ['ranked', 0, 'score'], 0), ['ranked', 0, 'components'], { price: 0, lead_time: 0, reliability: 0, compliance: 0 })],
    ['a score of 100 and four components of 100', change(change(golden(), ['ranked', 0, 'score'], 100), ['ranked', 0, 'components'], { price: 100, lead_time: 100, reliability: 100, compliance: 100 })],
    ['a quote with a total of 0 and a lead time of 0', change(at(['ranked', 0, 'quote', 'total'], 0), ['ranked', 0, 'quote', 'lead_time_days'], 0)],
    ['a code of 64 characters', at(['excluded', 0, 'code'], 'a'.repeat(64))], ['a code that is null', at(['excluded', 0, 'code'], null)], ['a request id of 64 characters', at(['rfq_id'], 'A'.repeat(64))],
    ...EXCLUDED_REASONS.map((reason): readonly [string, unknown] => [`the reason ${reason}`, at(['excluded', 0, 'reason'], reason)]),
    ['an organisation of 64 characters', orgAt(`${'a'.repeat(31)}.${'b'.repeat(32)}`)], ['an organisation with a label of 62 characters', orgAt(`${'a'.repeat(62)}.b`)], ['an organisation with digits and hyphens', orgAt('a-1.b2-c.example.org')],
    ['an organisation with two letters', orgAt('a.b')], ['an organisation of digits', orgAt('1.2')], ['an organisation with an a-label', orgAt('xn--bcher-kva.example')],
  ]);

  const KIT_STRICTER = rowsOf('refuses', 'accepts', [
    ['the ranks 1 and 3', withRanks([1, 3, 4])], ['the ranks in the order 2, 1, 3', withRanks([2, 1, 3])], ['the ranks 3, 2, 1', withRanks([3, 2, 1])], ['the ranks 1000 and 1', withRanks([1000, 1])], ['the ranks 1, 2 and 1000', withRanks([1, 2, 1000])],
    ['a desk_did twice in ranked', at(['ranked', 2, 'desk_did'], DID_A)], ['a desk_did in ranked and in excluded', at(['excluded', 0, 'desk_did'], DID_A)],
    ['a desk_did twice in excluded', { ...golden(), excluded: [excludedOf(40), excludedOf(40)] }], ['a bad desk_did in excluded', at(['excluded', 0, 'desk_did'], 'did:vector:abc')],
    ['a score of 101', at(['ranked', 0, 'score'], 101)], ['a score of -1', at(['ranked', 0, 'score'], -1)], ['a score of 100.0001', at(['ranked', 0, 'score'], 100.0001)], ['a score that is a text', at(['ranked', 0, 'score'], '88.5')],
    ['a score that is null', at(['ranked', 0, 'score'], null)], ['a component of 100.5', at(['ranked', 0, 'components', 'price'], 100.5)], ['a component of -0.5', at(['ranked', 0, 'components', 'compliance'], -0.5)],
    ['a component that is a text', at(['ranked', 0, 'components', 'lead_time'], '80')], ['a fifth component', at(['ranked', 0, 'components', 'extra'], 1)], ['a missing component', at(['ranked', 0, 'components', 'reliability'], undefined)],
    ['a member of the ranking that is not listed', at(['note'], 'a field of the sender')], ['a member of an entry that is not listed', at(['ranked', 0, 'note'], 'free text')], ['a member of the quote that is not listed', at(['ranked', 0, 'quote', 'notes'], 'free text')],
    ['a missing weights member', at(['weights'], undefined)], ['weights that sum to 1.1', at(['weights', 'price'], 0.5)], ['a missing excluded list', at(['excluded'], undefined)], ['an excluded list that is not a list', at(['excluded'], {})],
    ['a missing request hash', at(['rfq_sha256'], undefined)], ['a request hash of 63 characters', at(['rfq_sha256'], '4'.repeat(63))], ['a request hash in capital letters', at(['rfq_sha256'], 'AB'.repeat(32))],
    ['a missing score', at(['ranked', 1, 'score'], undefined)], ['a missing components member', at(['ranked', 1, 'components'], undefined)], ['a missing quote', at(['ranked', 1, 'quote'], undefined)],
    ['an escrow reference with no index', at(['ranked', 0, 'quote', 'escrow_ref'], 'e5'.repeat(32))], ['an escrow reference with a leading zero in the index', at(['ranked', 0, 'quote', 'escrow_ref'], `${'e5'.repeat(32)}#01`)],
    ['a receipt hash of 63 characters', at(['ranked', 0, 'quote', 'receipt_sha256'], '4'.repeat(63))], ['a total that is a fraction', at(['ranked', 0, 'quote', 'total'], 1.5)], ['a total below 0', at(['ranked', 0, 'quote', 'total'], -1)],
    ['a total that is a text', at(['ranked', 0, 'quote', 'total'], '12500')], ['a lead time that is a fraction', at(['ranked', 0, 'quote', 'lead_time_days'], 0.5)], ['a lead time below 0', at(['ranked', 0, 'quote', 'lead_time_days'], -1)],
    ['a total that a number cannot hold exactly', at(['ranked', 0, 'quote', 'total'], 2 ** 53)], ['a reason that is not listed', at(['excluded', 0, 'reason'], 'unknown')], ['a reason with a capital letter', at(['excluded', 0, 'reason'], 'Refused')],
    ['a code with a capital letter', at(['excluded', 0, 'code'], 'Duplicate_rfq')], ['a code of 65 characters', at(['excluded', 0, 'code'], 'a'.repeat(65))], ['a code that is the empty text', at(['excluded', 0, 'code'], '')],
    ['a code that is a number', at(['excluded', 0, 'code'], 5)], ['a missing code', at(['excluded', 0, 'code'], undefined)], ['a missing reason', at(['excluded', 0, 'reason'], undefined)],
  ]);

  const BOTH_REFUSE = rowsOf('refuses', 'refuses', [
    ['a schema of another version', at(['schema'], 'vector.usecase.ranking.v2')], ['no schema', at(['schema'], undefined)], ['a schema that is null', at(['schema'], null)], ['the schema of the purchase order', at(['schema'], 'vector.usecase.po.v1')],
    ['a tenant in capital letters', at(['tenant'], 'Run1')], ['a tenant with an underscore', at(['tenant'], 'run_1')], ['a tenant of 49 characters', at(['tenant'], 'a'.repeat(49))], ['a tenant that is the empty text', at(['tenant'], '')],
    ['a tenant with a hyphen at the start', at(['tenant'], '-run1')], ['a tenant with a space at the end', at(['tenant'], 'run1 ')], ['no tenant', at(['tenant'], undefined)], ['a tenant that is a number', at(['tenant'], 1)],
    ['a request id with a space', at(['rfq_id'], 'rfq 1')], ['a request id of 65 characters', at(['rfq_id'], 'A'.repeat(65))], ['a request id with a slash', at(['rfq_id'], 'a/b')], ['a request id that is the empty text', at(['rfq_id'], '')],
    ['a request id with a line break at the end', at(['rfq_id'], 'rfq-1\n')], ['no request id', at(['rfq_id'], undefined)], ['a request id that is a number', at(['rfq_id'], 5)], ['a request id with the Kelvin sign', at(['rfq_id'], 'rfq-\u212a')],
    ['no ranked list', at(['ranked'], undefined)], ['an empty ranked list', many(0)], ['21 ranked entries', many(21)], ['a ranked list that is an object', at(['ranked'], {})], ['a ranked list that is a text', at(['ranked'], 'x')],
    ['the ranks 2, 3 and 4: no rank 1', withRanks([2, 3, 4])], ['the rank 1 two times', withRanks([1, 1, 2])], ['the ranks 0, 1 and 2', withRanks([0, 1, 2])], ['the ranks 1, 2 and 1001', withRanks([1, 2, 1001])],
    ['the rank 2 two times and no rank 1', withRanks([2, 2])], ['a rank that is a text', withRanks(['1', 2, 3])], ['a rank that is a fraction', withRanks([1.5, 2, 3])], ['a rank that is null', withRanks([null, 2, 3])],
    ['a missing rank', at(['ranked', 0, 'rank'], undefined)], ['a rank of -1', withRanks([-1, 2, 3])], ['an entry that is null', at(['ranked', 1], null)], ['an entry that is a text', at(['ranked', 1], 'x')], ['an entry that is a list', at(['ranked', 1], [1])],
    ['a desk_did of 62 hex characters', at(['ranked', 0, 'desk_did'], `did:vector:${'a1'.repeat(31)}`)], ['a desk_did in capital letters', at(['ranked', 0, 'desk_did'], `did:vector:${'A1'.repeat(32)}`)], ['a missing desk_did', at(['ranked', 0, 'desk_did'], undefined)],
    ['a desk_did of another method', at(['ranked', 0, 'desk_did'], `did:other:${'a1'.repeat(32)}`)], ['a desk_did that is a number', at(['ranked', 0, 'desk_did'], 5)],
    ...[
      ['an organisation that is null', null], ['an organisation in capital letters', 'Alfa.example.org'], ['an organisation of one label', 'alfa'], ['an organisation that is the empty text', ''], ['an organisation with a dot at the end', 'alfa.example.org.'],
      ['an organisation with a dot at the start', '.alfa.example.org'], ['an organisation with an empty label', 'alfa..example.org'], ['an organisation with a hyphen at the start of a label', '-alfa.example.org'],
      ['an organisation with a hyphen at the end of a label', 'alfa-.example.org'], ['an organisation with a space', 'alfa example.org'], ['an organisation with a space at the end', 'alfa.example.org '],
      ['an organisation with a line break at the end', 'alfa.example.org\n'], ['an organisation with a tab at the end', 'alfa.example.org\t'], ['an organisation with a letter with a mark', 'alf\u00e4.example.org'],
      ['an organisation with a slash', 'alfa.example.org/x'], ['an organisation with an underscore', 'alfa_beta.example.org'], ['an organisation of 65 characters', `${'a'.repeat(63)}.b`],
      ['an organisation of 65 characters in two labels', `${'a'.repeat(32)}.${'b'.repeat(32)}`], ['an organisation with a port', 'alfa.example.org:443'], ['an organisation that is a number', 12345], ['an organisation that is a list', ['alfa.example.org']],
    ].map(([what, organisation]): readonly [string, unknown] => [what as string, orgAt(organisation)]),
  ]);

  // The tenant of the URL decides the record, and the kit cannot know it. A ranking of another tenant than the URL is refused by the record and not by the kit: the agent compares the tenant of the
  // ranking with the tenant of the request before it writes. With the URL tenant that the ranking names, both take it.
  const TENANT_ROWS: ReadonlyArray<readonly [string, string, string]> = [
    ['a tenant of one character', 'a', 'a'], ['a tenant of 48 characters', 'a'.repeat(48), 'a'.repeat(48)], ['a tenant with hyphens and digits', 'run-2-b', 'run-2-b'], ['a tenant of digits', '2026', '2026'],
  ];

  const ROWS: readonly Row[] = [...BOTH_TAKE, ...KIT_STRICTER, ...BOTH_REFUSE];

  it('has the verdict of the kit in each row', () => {
    for (const row of ROWS) expect(parseRanking(row.ranking).ok ? 'accepts' : 'refuses', row.what).toBe(row.kit);
  });

  it('has no row that the kit takes and the record refuses: the kit takes a subset of what the record takes', () => {
    for (const row of ROWS) if (row.kit === 'accepts') expect(row.mock, row.what).toBe('accepts');
  });

  it('takes a tenant that the record takes for the URL tenant that the ranking names, and refuses nothing that the record takes for it', () => {
    for (const [what, tenant] of TENANT_ROWS) expect(parseRanking(change(golden(), ['tenant'], tenant)).ok, what).toBe(true);
    for (const [what, tenant] of [['a tenant in capital letters', 'RUN1'], ['a tenant with a dot', 'run.1'], ['a tenant of 49 characters', 'a'.repeat(49)]] as const) expect(parseRanking(change(golden(), ['tenant'], tenant)).ok, what).toBe(false);
  });

  it('has a table with teeth: rows that both take, rows that only the record takes, rows that both refuse, and a row for each refusal that the page lists', () => {
    expect(BOTH_TAKE.length).toBeGreaterThan(20);
    expect(KIT_STRICTER.length).toBeGreaterThan(40);
    expect(BOTH_REFUSE.length).toBeGreaterThan(50);
    expect(ROWS.some((row) => row.what === 'an organisation that is null' && row.kit === 'refuses' && row.mock === 'refuses')).toBe(true);
    expect(ROWS.filter((row) => row.kit === 'refuses' && row.mock === 'accepts').map((row) => row.what)).toEqual(expect.arrayContaining(['the ranks 1 and 3', 'a score of 101', 'a desk_did in ranked and in excluded', 'a reason that is not listed']));
    expect(new Set(ROWS.map((row) => row.what)).size).toBe(ROWS.length);
  });
});

describe('buildRanking', () => {
  it('builds the golden ranking from its parts, with the request hash of the request, and gives the digest that is pinned', () => {
    const built = buildRanking(buildInput());
    expect(built).toStrictEqual({ ok: true, value: golden() });
    expect(proposalDigest(SALT, must(built))).toStrictEqual({ ok: true, value: GOLDEN_DIGEST });
    expect(must(built).rfq_sha256).toBe(must(rfqSha256(must(parseRfqDocument(supportGolden('rfq'))))));
  });

  it('gives the result that parseRanking gives for the document, and a document that parseRanking takes again with no change', () => {
    const built = must(buildRanking(buildInput()));
    expect(parseRanking(built)).toStrictEqual({ ok: true, value: built });
    expect(Object.keys(built)).toStrictEqual([...MEMBERS]);
  });

  it('gives the ranks 1 to n by position, for the order that it is given', () => {
    const entries = goldenEntries();
    const built = must(buildRanking(buildInput({ entries: [entries[2]!, entries[0]!, entries[1]!] })));
    expect(built.ranked.map((entry) => entry.rank)).toStrictEqual([1, 2, 3]);
    expect(built.ranked.map((entry) => entry.desk_did)).toStrictEqual([entries[2]!.desk_did, entries[0]!.desk_did, entries[1]!.desk_did]);
  });

  it('never sorts: an order that is not sorted by score stays as it is given, in each of the six orders, with each score as it was', () => {
    const entries = goldenEntries();
    const scores = entries.map((entry) => entry.score);
    expect(scores).toStrictEqual([88.5, 80.2, 52]);
    const orders: ReadonlyArray<readonly [number, number, number]> = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
    for (const order of orders) {
      const given = order.map((index) => entries[index]!);
      const built = must(buildRanking(buildInput({ entries: given })));
      expect(built.ranked.map((entry) => entry.desk_did), order.join()).toStrictEqual(given.map((entry) => entry.desk_did));
      expect(built.ranked.map((entry) => entry.score), order.join()).toStrictEqual(order.map((index) => scores[index]));
      expect(built.ranked.map((entry) => entry.rank)).toStrictEqual([1, 2, 3]);
    }
  });

  it('keeps the order of equal scores, and gives each its own rank', () => {
    const entries = goldenEntries().map((entry) => ({ ...entry, score: 70 }));
    const built = must(buildRanking(buildInput({ entries: [entries[1]!, entries[2]!, entries[0]!] })));
    expect(built.ranked.map((entry) => [entry.rank, entry.desk_did, entry.score])).toStrictEqual([[1, entries[1]!.desk_did, 70], [2, entries[2]!.desk_did, 70], [3, entries[0]!.desk_did, 70]]);
  });

  it('never changes a score or a component, and never drops an entry: 20 entries in, 20 entries out, each member as it was', () => {
    const entries = unranked(must(parseRanking(rankingOf(20))));
    // The scores rise along the list, from 0 to 100: the first entry has the lowest score, so a sort by score would reverse the list. A score keeps all its decimals, and a score of 0 is an entry.
    const scoreOf = (index: number): number => (index === 0 ? 0 : index === 19 ? 100 : index * 5 + 0.1234567);
    const given = entries.map((entry, index) => ({ ...entry, score: scoreOf(index), components: { price: index, lead_time: 100 - index, reliability: 33.3, compliance: 0 } }));
    const built = must(buildRanking(buildInput({ entries: given, excluded: [] })));
    expect(built.ranked).toHaveLength(20);
    given.forEach((entry, index) => {
      const out = built.ranked[index]!;
      expect(out.rank).toBe(index + 1);
      expect(out.desk_did).toBe(entry.desk_did);
      expect(out.score).toBe(entry.score);
      expect(out.components).toStrictEqual(entry.components);
      expect(out.quote).toStrictEqual(entry.quote);
    });
    expect(built.ranked.map((entry) => entry.score)).toStrictEqual(given.map((entry) => entry.score));
  });

  it('gives an entry with no organisation no member organisation, whether the member is missing or has the value undefined', () => {
    const entries = goldenEntries();
    for (const entry of [entries[2]!, { ...entries[2]!, organisation: undefined }]) {
      const built = must(buildRanking(buildInput({ entries: [entries[0]!, entry] })));
      expect('organisation' in built.ranked[1]!).toBe(false);
      expect(Object.keys(built.ranked[1]!)).toStrictEqual([...REQUIRED_ENTRY_MEMBERS]);
      expect(built.ranked[0]!.organisation).toBe('alfa.example.org');
    }
  });

  it('refuses an organisation that is null, and names the entry: the entry must leave the member out', () => {
    const entries = goldenEntries();
    const result = buildRanking(buildInput({ entries: [entries[0]!, { ...entries[2]!, organisation: null as never }] }));
    expectRefused(result, 'ranking.ranked[1].organisation');
    expect(buildRanking(buildInput({ entries: [entries[0]!, entries[2]!] })).ok).toBe(true);
  });

  it('refuses an organisation that is not a domain, and takes the twin', () => {
    const entries = goldenEntries();
    expectRefused(buildRanking(buildInput({ entries: [{ ...entries[0]!, organisation: 'Alfa Ltd' }] })), 'ranking.ranked[0].organisation');
    expect(buildRanking(buildInput({ entries: [{ ...entries[0]!, organisation: 'alfa.example.org' }] })).ok).toBe(true);
  });

  it('refuses an empty list of entries, and names entries', () => {
    expectRefused(buildRanking(buildInput({ entries: [] })), 'entries');
    expect(buildRanking(buildInput({ entries: goldenEntries().slice(0, 1), excluded: [] })).ok).toBe(true);
  });

  it('refuses more than 20 entries, and takes 20', () => {
    const twenty = unranked(must(parseRanking(rankingOf(20))));
    const entries = [...twenty, { ...twenty[0]!, desk_did: didOf(21) }];
    expect(buildRanking(buildInput({ entries: twenty, excluded: [] })).ok).toBe(true);
    expectRefused(buildRanking(buildInput({ entries, excluded: [] })), 'entries');
  });

  it('refuses entries that are not a list, and an entry that is not an object, and never throws', () => {
    for (const entries of [undefined, null, 'x', 5, {}, { length: 1, 0: goldenEntries()[0] }]) {
      expect(() => buildRanking(buildInput({ entries: entries as never }))).not.toThrow();
      expectRefused(buildRanking(buildInput({ entries: entries as never })), 'entries');
    }
    for (const entry of [null, undefined, 'x', 5, true, [1]]) {
      expect(() => buildRanking(buildInput({ entries: [goldenEntries()[0]!, entry as never] }))).not.toThrow();
      expectRefused(buildRanking(buildInput({ entries: [goldenEntries()[0]!, entry as never] })), 'ranking.ranked[1]');
    }
  });

  it('refuses a rank that an entry names when it is not the position, and takes the rank that is the position', () => {
    const entries = goldenEntries();
    expectRefused(buildRanking(buildInput({ entries: [{ ...entries[0]!, rank: 2 } as never, entries[1]!] })), 'ranking.ranked[0].rank');
    expect(buildRanking(buildInput({ entries: [{ ...entries[0]!, rank: 1 } as never, entries[1]!] })).ok).toBe(true);
  });

  it('refuses a member of an entry that is not listed, so that free text of a bidder never enters the document', () => {
    const entries = goldenEntries();
    expectRefused(buildRanking(buildInput({ entries: [{ ...entries[0]!, notes: 'Free text of the bidder.' } as never] })), 'ranking.ranked[0]');
    expectRefused(buildRanking(buildInput({ entries: [{ ...entries[0]!, quote: { ...entries[0]!.quote, notes: 'Free text.' } } as never] })), 'ranking.ranked[0].quote');
  });

  it('refuses a score outside 0 to 100, and a desk_did twice, and a desk_did that is also excluded, and takes the twins', () => {
    const entries = goldenEntries();
    expectRefused(buildRanking(buildInput({ entries: [{ ...entries[0]!, score: 101 }, entries[1]!] })), 'ranking.ranked[0].score');
    expectRefused(buildRanking(buildInput({ entries: [entries[0]!, { ...entries[1]!, desk_did: entries[0]!.desk_did }] })), 'ranking.ranked[1].desk_did');
    expectRefused(buildRanking(buildInput({ excluded: [{ desk_did: entries[0]!.desk_did, reason: 'failed', code: null }] })), 'ranking.excluded[0].desk_did');
    expect(buildRanking(buildInput({ entries: [{ ...entries[0]!, score: 100 }, entries[1]!] })).ok).toBe(true);
  });

  it('refuses a request that is not a request, a tenant that is not a tenant, weights that are not weights, and an excluded list that is not a list', () => {
    expectRefused(buildRanking(buildInput({ rfq: { rfq_id: 'a b', items: [], needed_by: '2026-12-20' } as never })), 'rfq');
    expectRefused(buildRanking(buildInput({ rfq: null as never })), 'rfq');
    expectRefused(buildRanking(buildInput({ tenant: 'Run1' })), 'ranking.tenant');
    expectRefused(buildRanking(buildInput({ weights: { price: 0.5, lead_time: 0.2, reliability: 0.2, compliance: 0.2 } })), 'ranking.weights');
    expectRefused(buildRanking(buildInput({ excluded: undefined as never })), 'ranking.excluded');
    expectRefused(buildRanking(buildInput({ excluded: [{ desk_did: didOf(40), reason: 'gone' as never, code: null }] })), 'ranking.excluded[0].reason');
    expectRefused(buildRanking(buildInput({ excluded: [{ desk_did: didOf(40), reason: 'failed', code: 'Bad Code' }] })), 'ranking.excluded[0].code');
    expect(buildRanking(buildInput({ excluded: [] })).ok).toBe(true);
  });

  it('takes the request hash from the request that it is given: another request gives another hash, and the same request in another order of the members gives the same', () => {
    const rfq = must(parseRfqDocument(supportGolden('rfq')));
    const other = must(parseRfqDocument(change(supportGolden('rfq'), ['needed_by'], '2026-12-21')));
    const first = must(buildRanking(buildInput({ rfq })));
    const second = must(buildRanking(buildInput({ rfq: other })));
    expect(first.rfq_sha256).toBe(RFQ_SHA256);
    expect(second.rfq_sha256).not.toBe(RFQ_SHA256);
    expect(second.rfq_id).toBe(first.rfq_id);
    const shuffled = { needed_by: rfq.needed_by, items: rfq.items, rfq_id: rfq.rfq_id };
    expect(must(buildRanking(buildInput({ rfq: shuffled }))).rfq_sha256).toBe(RFQ_SHA256);
  });

  it('changes nothing of its input, and gives a result that shares no object with it', () => {
    const input = buildInput();
    const before = JSON.stringify(input);
    const built = must(buildRanking(input));
    expect(JSON.stringify(input)).toBe(before);
    expect(built.ranked[0]).not.toBe(input.entries[0]);
    expect(built.ranked[0]!.components).not.toBe(input.entries[0]!.components);
    expect(built.ranked[0]!.quote).not.toBe(input.entries[0]!.quote);
    expect(built.weights).not.toBe(input.weights);
    expect(built.excluded).not.toBe(input.excluded);
    expect(built.ranked.map((entry) => entry.desk_did)).toStrictEqual(input.entries.map((entry) => entry.desk_did));
  });

  it('reads no member that a prototype holds, and runs no setter of a prototype', () => {
    const plain = buildRanking(buildInput());
    for (const key of ['ranked', '0', 'rank', 'organisation', 'score']) {
      let calls = 0;
      const seen = withPrototype(Object.prototype, { [key]: { set() { calls += 1; } } }, () => buildRanking(buildInput()));
      expect(seen, key).toStrictEqual(plain);
      expect(calls, key).toBe(0);
    }
    const input = buildInput();
    const seen = withPrototype(Object.prototype, { organisation: { value: 'evil.example.org', writable: true, enumerable: true } }, () => buildRanking(input));
    expect(seen).toStrictEqual(plain);
    expect(Object.hasOwn(must(seen).ranked[2]!, 'organisation')).toBe(false);
  });
});

describe('receiptSha256', () => {
  const canonicalOfPair = (receipt: unknown, signature: unknown): unknown => canonicalSha256({ receipt, signature });

  it('is the canonical hash of the pair of the receipt and the signature, and one value is pinned', () => {
    expect(receiptSha256(RECEIPT, SIGNATURE)).toStrictEqual({ ok: true, value: RECEIPT_SHA256 });
    expect(receiptSha256(RECEIPT, SIGNATURE)).toStrictEqual(canonicalOfPair(RECEIPT, SIGNATURE));
  });

  it('is the canonical hash of the pair for other receipts too, nested values and lists included', () => {
    const receipts: unknown[] = [{}, { a: 1 }, { z: [1, 2, { y: null }], a: 'text', m: { n: { o: true } } }, { text: 'caf\u00e9', decomposed: 'cafe\u0301' }, { n: 0.5, big: 9007199254740991 }];
    for (const receipt of receipts) expect(receiptSha256(receipt, SIGNATURE), JSON.stringify(receipt)).toStrictEqual(canonicalOfPair(receipt, SIGNATURE));
  });

  it('binds the signature and each member of the receipt, and not the order of the members', () => {
    const base = must(receiptSha256(RECEIPT, SIGNATURE));
    expect(must(receiptSha256(RECEIPT, `${SIGNATURE.slice(0, -2)}8f`))).not.toBe(base);
    expect(must(receiptSha256(RECEIPT, ''))).not.toBe(base);
    for (const name of Object.keys(RECEIPT)) expect(must(receiptSha256({ ...RECEIPT, [name]: 'changed' }, SIGNATURE)), name).not.toBe(base);
    expect(must(receiptSha256({ ...RECEIPT, extra: 1 }, SIGNATURE))).not.toBe(base);
    expect(must(receiptSha256(Object.fromEntries(Object.entries(RECEIPT).reverse()), SIGNATURE))).toBe(base);
    expect(must(canonicalSha256(RECEIPT))).not.toBe(base);
  });

  it('does not take the signature for a member of the receipt, and does not swap the two', () => {
    expect(must(receiptSha256(RECEIPT, SIGNATURE))).not.toBe(must(receiptSha256({ ...RECEIPT, signature: SIGNATURE }, '')));
    expect(must(receiptSha256({ a: 1 }, 'b'))).not.toBe(must(receiptSha256({ b: 1 }, 'a')));
  });

  it('hashes the texts in the NFC form, as the digest of a proposal does', () => {
    expect(receiptSha256({ text: 'cafe\u0301' }, SIGNATURE)).toStrictEqual(receiptSha256({ text: 'caf\u00e9' }, SIGNATURE));
    expect(receiptSha256(RECEIPT, 'e\u0301')).toStrictEqual(receiptSha256(RECEIPT, '\u00e9'));
  });

  it.each([['a list', []], ['a list of members', [['a', 1]]], ['a text', 'receipt'], ['null', null], ['undefined', undefined], ['a number', 5], ['true', true], ['a bigint', 5n]])(
    'refuses a receipt that is %s, and names the receipt',
    (_what, receipt) => {
      expectRefused(receiptSha256(receipt, SIGNATURE), 'receipt');
      expect(receiptSha256(RECEIPT, SIGNATURE).ok).toBe(true);
    },
  );

  it.each([['a number', 5], ['null', null], ['undefined', undefined], ['a list', ['8e']], ['an object', { signature: SIGNATURE }], ['true', true], ['a bigint', 5n], ['the bytes of the signature', new Uint8Array([1, 2])]])(
    'refuses a signature that is %s, and names the signature',
    (_what, signature) => {
      expectRefused(receiptSha256(RECEIPT, signature), 'signature');
      expect(receiptSha256(RECEIPT, SIGNATURE).ok).toBe(true);
    },
  );

  it('refuses an object that is not plain, and a receipt that JSON cannot hold, names the member, and never repeats a value', () => {
    class Receipt {
      model = BID_DESK_MODEL;
    }
    expectRefused(receiptSha256(new Receipt(), SIGNATURE), 'receipt');
    expectRefused(receiptSha256({ ...RECEIPT, n: Number.NaN }, SIGNATURE), 'receipt.n');
    expectRefused(receiptSha256({ ...RECEIPT, f: () => 1 }, SIGNATURE), 'receipt.f');
    expectRefused(receiptSha256({ ...RECEIPT, u: undefined }, SIGNATURE), 'receipt.u');
    expectRefused(receiptSha256({ ...RECEIPT, nested: { n: Number.POSITIVE_INFINITY } }, SIGNATURE), 'receipt.nested.n');
    expectRefused(receiptSha256(JSON.parse('{"model":"bid-desk-v1","__proto__":{"x":1}}'), SIGNATURE), '__proto__');
    expectRefused(receiptSha256({ ...RECEIPT, 7: 'a whole-number key' }, SIGNATURE), 'receipt');
    const result = receiptSha256({ ...RECEIPT, secret: MARKER, n: Number.NaN }, MARKER);
    expect(!result.ok && result.detail).not.toContain('marker');
    const text = receiptSha256(RECEIPT, MARKER);
    expect(text.ok).toBe(true);
  });

  it('refuses a receipt with an accessor, and never runs the getter, and refuses a Proxy that throws without throwing', () => {
    let reads = 0;
    const receipt = { ...RECEIPT };
    Object.defineProperty(receipt, 'model', { get() { reads += 1; return BID_DESK_MODEL; }, enumerable: true, configurable: true });
    expectRefused(receiptSha256(receipt, SIGNATURE), 'receipt.model');
    expect(reads).toBe(0);
    const throws = new Proxy({ ...RECEIPT }, { ownKeys() { throw new Error('the Proxy refuses'); } });
    expect(() => receiptSha256(throws, SIGNATURE)).not.toThrow();
    expectRefused(receiptSha256(throws, SIGNATURE), 'receipt');
  });

  it('refuses a receipt that is nested more deeply than the protocol allows, and takes one that is nested at the limit of the pair', () => {
    // The receipt is one level of the pair, so the pair is one level deeper than the receipt: a receipt of 31 levels passes, and a receipt of 32 levels does not.
    const deep = (levels: number): Json => {
      let value: Json = {};
      for (let level = 1; level < levels; level += 1) value = { next: value };
      return value;
    };
    expect(receiptSha256(deep(5), SIGNATURE)).toStrictEqual(canonicalOfPair(deep(5), SIGNATURE));
    expect(receiptSha256(deep(31), SIGNATURE)).toStrictEqual(canonicalOfPair(deep(31), SIGNATURE));
    expect(receiptSha256(deep(31), SIGNATURE).ok).toBe(true);
    expectRefused(receiptSha256(deep(32), SIGNATURE), 'receipt');
    expect(canonicalOfPair(deep(32), SIGNATURE)).toMatchObject({ ok: false });
    expectRefused(receiptSha256(deep(40), SIGNATURE), 'receipt');
  });
});
