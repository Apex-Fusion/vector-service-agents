// agents/sourcing-agent/test/model/shortlist.test.ts
// The model decision `shortlist` of the Sourcing Agent: the fixed text of its prompt, the input that the model gets, and the parser of its choice. The prompt is pinned as a golden text. The input holds the
// facts of the files of the bidders and no text that a bidder wrote. A parser checks the shape and nothing else: it never changes a value, and the choice that the model gave is recorded as it was given. Each
// refusal has an accepted twin.
import { afterEach, describe, expect, test } from 'vitest';
import { INPUT_CLOSE, INPUT_OPEN, decide } from '@vsa/usecase-kit/decision';
import { parseJsonValue } from '@vsa/usecase-kit/protocol';
import type { JsonValue } from '@vsa/usecase-kit/protocol';
import { MAX_INVITED, SHORTLIST_DECISION, shortlistInput } from '../../src/model/index.ts';
import type { BidderFile } from '../../src/model/index.ts';
import { cleanup, lost, promptsSent, said, setup, won } from './decide-support.ts';
import { ALFA, ATTACK, BRAVO, CHARLIE, MARKER, RFQ, did, expectContained, expectNames, files, golden, goldenPrompt, marksOf, must, promptOf, refusal } from './support.ts';

afterEach(cleanup);

const INPUT = shortlistInput(RFQ, files());
const EXPECTED = (): Record<string, unknown> => golden('shortlist-input.json');
const DELTA = did('d4');
const ECHO = did('e5');

/** The members of a bidder of the input that the tests read. */
interface BidderRead {
  readonly did: string;
  readonly status_reason: unknown;
  readonly accountable: boolean;
  readonly lineage: Record<string, unknown> & { readonly has_successor: boolean };
  readonly compliance: Record<string, unknown> & { readonly replied: boolean };
}
interface InputRead {
  readonly request: Record<string, unknown>;
  readonly bidders: readonly BidderRead[];
}
/** The input as a test reads it. It is the JSON data that `shortlistInput` made, and the golden file holds the same members. */
const read = (input: unknown): InputRead => input as InputRead;

describe('the decision: name and fixed text', () => {
  test('has the name that the agent records, and cannot be changed', () => {
    expect(SHORTLIST_DECISION.name).toBe('shortlist');
    expect(Object.isFrozen(SHORTLIST_DECISION)).toBe(true);
  });

  test('keeps the marks of the input block out of the fixed text', () => {
    expect(SHORTLIST_DECISION.instruction).not.toContain(INPUT_OPEN);
    expect(SHORTLIST_DECISION.instruction).not.toContain(INPUT_CLOSE);
    expect(SHORTLIST_DECISION.instruction.trim()).not.toBe('');
  });

  test('names each member that the input has: the request, the bidders and every member of a file', () => {
    const input = read(EXPECTED());
    const bidder = input.bidders[0]!;
    const names = ['request', 'bidders', ...Object.keys(input.request), ...Object.keys(bidder), ...Object.keys(bidder.lineage), ...Object.keys(bidder.compliance)];
    for (const name of names) expect(SHORTLIST_DECISION.instruction, `the instruction names ${name}`).toContain(`"${name}"`);
  });

  test('does not name a member of a file that the input leaves out', () => {
    for (const name of ['advert_ref', 'organisation', 'attestation', 'issued_at', 'revoke_reason', 'contested', 'successor', 'sha256']) {
      expect(SHORTLIST_DECISION.instruction, `the instruction does not name ${name}`).not.toContain(`"${name}"`);
    }
  });

  test('names the two members of the choice, and the most bidders that it invites', () => {
    for (const member of ['"invite"', '"not_invited"', '"did"', '"reason"']) expect(SHORTLIST_DECISION.instruction).toContain(member);
    expect(MAX_INVITED).toBe(3);
    expect(SHORTLIST_DECISION.instruction).toContain(`at most ${MAX_INVITED}`);
    expect(SHORTLIST_DECISION.instruction).toContain('at most 200 characters');
  });
});

describe('shortlistInput', () => {
  test('gives the items and the date of the request and the facts of the three files: the golden input', () => {
    expect(INPUT).toStrictEqual(EXPECTED());
  });

  test('gives plain JSON data that reads back as the same value', () => {
    expect(parseJsonValue(INPUT).ok).toBe(true);
    expect(JSON.parse(JSON.stringify(INPUT))).toStrictEqual(INPUT);
  });

  test('gives each bidder exactly these members, and no other', () => {
    const { bidders } = read(INPUT);
    for (const bidder of bidders) {
      expect(Object.keys(bidder).sort()).toStrictEqual([
        'accountable', 'cases_against', 'compliance', 'credential', 'did', 'in_catalog', 'lineage', 'organisation_verified', 'price_list', 'stake_lovelace', 'status', 'status_reason',
      ]);
      expect(Object.keys(bidder.lineage).sort()).toStrictEqual(['ended_at', 'has_successor', 'hold_until', 'invalid_from', 'recovery_pending']);
      expect(Object.keys(bidder.compliance).sort()).toStrictEqual(['attestation_state', 'replied', 'revoked_at', 'state', 'valid_until']);
    }
  });

  test('gives the request as its items and its date, and no identifier of the request', () => {
    const { request } = read(INPUT);
    expect(Object.keys(request).sort()).toStrictEqual(['items', 'needed_by']);
    expect(JSON.stringify(INPUT)).not.toContain(RFQ.rfq_id);
  });

  test('holds none of the members that are left out: a value in each of them does not reach the input', () => {
    const marked = files().map((file) => ({
      ...file,
      advert_ref: 'LEFT-OUT-advert_ref',
      organisation: 'LEFT-OUT-organisation',
      accountable: file.accountable === null ? null : 'LEFT-OUT-accountable',
      lineage: { ...file.lineage, successor: 'LEFT-OUT-successor' },
      compliance: { ...file.compliance, attestation: 'LEFT-OUT-attestation', issued_at: 'LEFT-OUT-issued_at', revoke_reason: 'LEFT-OUT-revoke_reason', contested: { sha256: 'LEFT-OUT-sha256' } },
    }));
    const text = JSON.stringify(shortlistInput(RFQ, marked));
    expect(text).not.toContain('LEFT-OUT');
    // The booleans that stand for three of the members: a successor and a reply exist, and the accountable party exists where the file named one.
    const { bidders } = read(JSON.parse(text));
    expect(bidders.map((bidder) => [bidder.accountable, bidder.lineage.has_successor, bidder.compliance.replied])).toStrictEqual([[true, true, true], [false, true, true], [true, true, true]]);
  });

  test.each<[string, (file: BidderFile, on: boolean) => BidderFile, (bidder: BidderRead) => boolean]>([
    ['a successor', (file, on) => ({ ...file, lineage: { ...file.lineage, successor: on ? did('5a') : null } }), (bidder) => bidder.lineage.has_successor],
    ['a reply', (file, on) => ({ ...file, compliance: { ...file.compliance, contested: on ? { sha256: 'c7'.repeat(32) } : null } }), (bidder) => bidder.compliance.replied],
    ['an accountable party', (file, on) => ({ ...file, accountable: on ? 'e1'.repeat(28) : null }), (bidder) => bidder.accountable],
  ])('shows %s as true when there is one and as false when there is none', (_name, make, shown) => {
    for (const on of [true, false]) {
      expect(shown(read(shortlistInput(RFQ, [make(files()[0]!, on)])).bidders[0]!)).toBe(on);
    }
  });

  test.each([
    'invalidated', 'parentRevoked', 'parentRetired', 'deactivationPending', 'parentSuspended', 'notAuthentic', 'unaccountable',
  ])('keeps the reason word %s of the gateway', (word) => {
    const { bidders } = read(shortlistInput(RFQ, [{ ...files()[0]!, status_reason: word }]));
    expect(bidders[0]!.status_reason).toBe(word);
  });

  test.each([
    ['an order to the model', ATTACK],
    ['a word that is not one of the gateway', 'unspecified'],
    ['a reason word in another case', 'Invalidated'],
    ['a reason word with a space', 'invalidated '],
    ['an empty text', ''],
    ['the marker', MARKER],
    ['a decimal reason code', '73'],
  ])('replaces %s in place of the reason word with null, and the prompt stays the golden prompt', (_name, word) => {
    const given = files();
    const input = shortlistInput(RFQ, [{ ...given[0]!, status_reason: word }, given[1]!, given[2]!]);
    expect(input).toStrictEqual(EXPECTED());
    expect(promptOf(SHORTLIST_DECISION, input)).toBe(goldenPrompt('shortlist-prompt.txt'));
  });

  test('gives the bidders in the order of the files, and an empty list of bidders for no file', () => {
    const given = files();
    const { bidders } = read(shortlistInput(RFQ, [given[2]!, given[0]!]));
    expect(bidders.map((bidder) => bidder.did)).toStrictEqual([CHARLIE, ALFA]);
    expect(read(shortlistInput(RFQ, [])).bidders).toStrictEqual([]);
  });

  test('is a copy: a change of the request or of a file after the call does not change the input', () => {
    const given = files();
    const rfq = { ...RFQ, items: RFQ.items.map((item) => ({ ...item })) };
    const input = shortlistInput(rfq, given);
    Object.assign(rfq.items[0]!, { quantity: 999 });
    Object.assign(given[0]!.compliance, { state: 'invalid' });
    Object.assign(given[0]!.lineage, { recovery_pending: true });
    expect(input).toStrictEqual(EXPECTED());
  });
});

describe('the prompt', () => {
  test('is the golden text', () => {
    expect(promptOf(SHORTLIST_DECISION, INPUT)).toBe(goldenPrompt('shortlist-prompt.txt'));
  });

  test('is the same for the same input, and another for another input', () => {
    expect(promptOf(SHORTLIST_DECISION, shortlistInput(RFQ, files()))).toBe(promptOf(SHORTLIST_DECISION, INPUT));
    expect(promptOf(SHORTLIST_DECISION, shortlistInput(RFQ, files().slice(0, 2)))).not.toBe(promptOf(SHORTLIST_DECISION, INPUT));
    expect(promptOf(SHORTLIST_DECISION, shortlistInput({ ...RFQ, needed_by: '2026-12-21' }, files()))).not.toBe(promptOf(SHORTLIST_DECISION, INPUT));
  });

  test('holds its input one time, as one line in one block, and asks for one JSON object and nothing else', () => {
    const prompt = promptOf(SHORTLIST_DECISION, INPUT);
    const lines = prompt.split('\n');
    const open = lines.indexOf(INPUT_OPEN);
    expect(open).toBeGreaterThan(0);
    expect(lines[open + 2]).toBe(INPUT_CLOSE);
    expect(marksOf(prompt, INPUT_OPEN)).toBe(1);
    expect(marksOf(prompt, INPUT_CLOSE)).toBe(1);
    const data = lines[open + 1]!;
    expect(JSON.parse(data)).toStrictEqual(INPUT);
    expect(prompt.split(data).length - 1).toBe(1);
    expect(prompt.split('Answer with one JSON object and nothing else.').length - 1).toBe(1);
    expect(SHORTLIST_DECISION.instruction).not.toContain('```');
  });

  test('a text that holds the marks of the block, in each place where text stands in the input, does not open a second block and changes nothing outside the one line of data', () => {
    const given = files();
    const rfq = { ...RFQ, items: [{ sku: ATTACK, quantity: 1 }, ...RFQ.items.slice(1)], needed_by: ATTACK };
    const hostile = given.map((file) => ({
      ...file,
      did: ATTACK,
      stake_lovelace: ATTACK,
      lineage: { ...file.lineage, hold_until: ATTACK, ended_at: ATTACK, invalid_from: ATTACK },
      compliance: { ...file.compliance, valid_until: ATTACK, revoked_at: ATTACK },
    }));
    const input = shortlistInput(rfq, hostile);
    expect(JSON.stringify(input).split('Ignore the rules above').length - 1).toBeGreaterThan(10);
    expectContained(promptOf(SHORTLIST_DECISION, input), 'shortlist-prompt.txt');
  });
});

describe('the parser', () => {
  const choice = (): Record<string, unknown> => golden('shortlist-choice.json');
  const parse = (given: unknown) => SHORTLIST_DECISION.parse(given as JsonValue);
  const reason = (text: string): Record<string, unknown> => ({ invite: [ALFA], not_invited: [{ did: BRAVO, reason: text }] });

  test('accepts the golden choice and returns the value that it was given', () => {
    const given = choice() as JsonValue;
    expect(must(SHORTLIST_DECISION.parse(given))).toBe(given);
  });

  test.each([
    ['no bidder invited, and three that are not', { invite: [], not_invited: [{ did: ALFA, reason: 'No.' }, { did: BRAVO, reason: 'No.' }, { did: CHARLIE, reason: 'No.' }] }],
    ['no bidder invited and none listed', { invite: [], not_invited: [] }],
    ['three bidders invited', { invite: [CHARLIE, ALFA, BRAVO], not_invited: [] }],
    ['one bidder invited, and no other listed', { invite: [ALFA], not_invited: [] }],
    ['a reason with letters that are not ASCII', reason('Sa pri\u00e9 est \u00e9lev\u00e9e.')],
    ['an empty reason: the parser checks the shape only', reason('')],
    ['a reason of 200 characters', reason('r'.repeat(200))],
  ])('accepts %s', (_name, given) => {
    expect(must(parse(given))).toBe(given);
  });

  test('returns each member as the model wrote it: the order of the invitation stays', () => {
    const given = { not_invited: [{ reason: 'Not now.', did: DELTA }], invite: [CHARLIE, ALFA, BRAVO] };
    expect(JSON.stringify(must(parse(given)))).toBe(JSON.stringify(given));
  });

  test.each(['invite', 'not_invited'])('refuses a choice with no member %s', (name) => {
    const given = choice();
    delete given[name];
    const { code, detail } = refusal(parse(given));
    expect(code).toBe('bad_shape');
    expectNames(detail, name);
  });

  test.each(['note', 'reasoning', 'order', 'organisation'])('refuses the extra member %s', (name) => {
    const { code, detail } = refusal(parse({ ...choice(), [name]: 'x' }));
    expect(code).toBe('bad_shape');
    expectNames(detail, name);
  });

  test.each([null, [], 'invite', 1, true])('refuses %j in place of the choice', (given) => {
    expect(refusal(parse(given)).code).toBe('bad_shape');
  });

  test.each([['a text', ALFA], ['null', null], ['an object', {}], ['a number', 1]])('refuses `invite` that is %s in place of a list', (_name, invite) => {
    const { code, detail } = refusal(parse({ ...choice(), invite }));
    expect(code).toBe('bad_shape');
    expectNames(detail, 'choice.invite');
  });

  test('refuses four bidders in `invite`, and accepts three', () => {
    expect(must(parse({ invite: [ALFA, BRAVO, CHARLIE], not_invited: [] }))).toBeDefined();
    const { code, detail } = refusal(parse({ invite: [ALFA, BRAVO, CHARLIE, DELTA], not_invited: [] }));
    expect(code).toBe('bad_shape');
    expectNames(detail, 'choice.invite');
  });

  test.each([[[ALFA, ALFA]], [[ALFA, BRAVO, ALFA]]])('refuses the invitation %j: a bidder stands two times', (invite) => {
    const { code, detail } = refusal(parse({ invite, not_invited: [] }));
    expect(code).toBe('bad_shape');
    expectNames(detail, 'choice.invite');
  });

  test.each([
    ['a DID with upper-case hex', `did:vector:${'D5'.repeat(32)}`],
    ['a DID of 63 hex characters', `did:vector:${'d5'.repeat(31)}d`],
    ['a DID of 65 hex characters', `did:vector:${'d5'.repeat(32)}d`],
    ['a DID of another method', `did:web:${'d5'.repeat(32)}`],
    ['the hex with no prefix', 'd5'.repeat(32)],
    ['a DID with a line break at the end', `${ALFA}\n`],
    ['the marker', MARKER],
    ['a number', 5],
    ['null', null],
    ['an object that holds a DID', { did: ALFA }],
  ])('refuses %s in `invite`', (_name, value) => {
    const { code, detail } = refusal(parse({ invite: [ALFA, value], not_invited: [] }));
    expect(code).toBe('bad_shape');
    expectNames(detail, 'choice.invite[1]');
  });

  test.each([['a text', 'x'], ['null', null], ['an object', {}], ['a number', 1]])('refuses `not_invited` that is %s in place of a list', (_name, notInvited) => {
    const { code, detail } = refusal(parse({ invite: [ALFA], not_invited: notInvited }));
    expect(code).toBe('bad_shape');
    expectNames(detail, 'choice.not_invited');
  });

  test.each([['a text', 'x'], ['null', null], ['a list', [BRAVO, 'No.']], ['a number', 1]])('refuses an entry of `not_invited` that is %s in place of an object', (_name, entry) => {
    const { code, detail } = refusal(parse({ invite: [ALFA], not_invited: [entry] }));
    expect(code).toBe('bad_shape');
    expectNames(detail, 'choice.not_invited[0]');
  });

  test.each(['did', 'reason'])('refuses an entry of `not_invited` with no member %s', (name) => {
    const entry: Record<string, unknown> = { did: BRAVO, reason: 'No.' };
    delete entry[name];
    const { code, detail } = refusal(parse({ invite: [ALFA], not_invited: [entry] }));
    expect(code).toBe('bad_shape');
    expectNames(detail, name);
  });

  test.each(['note', 'organisation', 'code'])('refuses an entry of `not_invited` with the extra member %s', (name) => {
    const { code, detail } = refusal(parse({ invite: [ALFA], not_invited: [{ did: BRAVO, reason: 'No.', [name]: 'x' }] }));
    expect(code).toBe('bad_shape');
    expectNames(detail, name);
  });

  test.each([
    ['upper-case hex', `did:vector:${'D5'.repeat(32)}`],
    ['the marker', MARKER],
    ['a number', 5],
    ['null', null],
  ])('refuses a DID with %s in an entry of `not_invited`', (_name, value) => {
    const { code, detail } = refusal(parse({ invite: [ALFA], not_invited: [{ did: value, reason: 'No.' }] }));
    expect(code).toBe('bad_shape');
    expectNames(detail, 'choice.not_invited[0].did');
  });

  test('refuses a reason of 201 characters, and accepts one of 200', () => {
    expect(must(parse(reason('r'.repeat(200))))).toBeDefined();
    const { code, detail } = refusal(parse(reason('r'.repeat(201))));
    expect(code).toBe('bad_shape');
    expectNames(detail, 'choice.not_invited[0].reason');
  });

  test.each([['a number', 5], ['null', null], ['a list', ['No.']], ['an object', { text: 'No.' }]])('refuses a reason that is %s', (_name, value) => {
    const { code, detail } = refusal(parse({ invite: [ALFA], not_invited: [{ did: BRAVO, reason: value }] }));
    expect(code).toBe('bad_shape');
    expectNames(detail, 'choice.not_invited[0].reason');
  });

  test.each([
    ['a line break', 'First.\nSecond.'],
    ['a carriage return', 'First.\rSecond.'],
    ['a tab', 'First.\tSecond.'],
    ['a null character', 'First.\u0000Second.'],
    ['an escape character', 'First.\u001b[31mSecond.'],
    ['a zero width space', 'First.\u200bSecond.'],
    ['a direction override', 'First.\u202eSecond.'],
    ['a line separator', 'First.\u2028Second.'],
    ['a byte order mark', '\ufeffFirst.'],
    ['a soft hyphen', 'First.\u00adSecond.'],
    ['a variation selector', 'First.\ufe0fSecond.'],
    ['a surrogate that stands alone', 'First.\ud800Second.'],
  ])('refuses a reason with %s', (_name, text) => {
    const { code, detail } = refusal(parse(reason(text)));
    expect(code).toBe('bad_shape');
    expectNames(detail, 'choice.not_invited[0].reason');
  });

  test.each([
    ['in both lists', { invite: [ALFA, BRAVO], not_invited: [{ did: BRAVO, reason: 'No.' }] }],
    ['in both lists, as the only bidder', { invite: [ALFA], not_invited: [{ did: ALFA, reason: 'No.' }] }],
  ])('refuses a DID that stands %s', (_name, given) => {
    const { code, detail } = refusal(parse(given));
    expect(code).toBe('bad_shape');
    expectNames(detail, 'choice.not_invited[');
    expect(detail).toContain('choice.invite');
  });

  test('accepts the same lists when no DID stands in both', () => {
    expect(must(parse({ invite: [ALFA, BRAVO], not_invited: [{ did: CHARLIE, reason: 'No.' }] }))).toBeDefined();
  });

  test('refuses a DID that stands two times in `not_invited`', () => {
    const { code, detail } = refusal(parse({ invite: [ALFA], not_invited: [{ did: BRAVO, reason: 'No.' }, { did: BRAVO, reason: 'Again.' }] }));
    expect(code).toBe('bad_shape');
    expectNames(detail, 'choice.not_invited[1]');
  });

  test('refuses 21 entries in `not_invited`, and accepts 20', () => {
    const entries = (count: number) => Array.from({ length: count }, (_, index) => ({ did: did(index.toString(16).padStart(2, '0')), reason: 'No.' }));
    expect(must(parse({ invite: [], not_invited: entries(20) }))).toBeDefined();
    const { code, detail } = refusal(parse({ invite: [], not_invited: entries(21) }));
    expect(code).toBe('bad_shape');
    expectNames(detail, 'choice.not_invited');
  });
});

describe('decide with the stub model supplier', () => {
  test('the choice of the model is the choice of the decision, as the model gave it, and the model got the golden prompt', async () => {
    const run = await setup();
    const given = golden('shortlist-choice.json');
    run.m.llm.answer = said(given, 'Alfa has every fact in order. Bravo has facts that could not be read, and Charlie is revoked.');
    const decision = won(await decide(run.deps, SHORTLIST_DECISION, INPUT));
    expect([decision.name, decision.choice, decision.inference.path]).toStrictEqual(['shortlist', given, 'marketplace']);
    expect(JSON.stringify(decision.choice)).toBe(JSON.stringify(given));
    expect(decision.reasoning).toBe('Alfa has every fact in order. Bravo has facts that could not be read, and Charlie is revoked.');
    expect(promptsSent(run)).toStrictEqual([goldenPrompt('shortlist-prompt.txt')]);
  });

  test('a choice that invites a bidder that is not in the files is recorded as the model gave it: the parser knows no candidate', async () => {
    const run = await setup();
    const given = { invite: [ECHO], not_invited: [] };
    run.m.llm.answer = said(given);
    expect(won(await decide(run.deps, SHORTLIST_DECISION, INPUT)).choice).toStrictEqual(given);
  });

  test.each<[string, unknown]>([
    ['four bidders invited', { invite: [ALFA, BRAVO, CHARLIE, DELTA], not_invited: [] }],
    ['a DID in both lists', { invite: [ALFA], not_invited: [{ did: ALFA, reason: 'No.' }] }],
    ['a bidder invited two times', { invite: [ALFA, ALFA], not_invited: [] }],
    ['a reason of 201 characters', { invite: [], not_invited: [{ did: ALFA, reason: 'r'.repeat(201) }] }],
    ['an extra member', { invite: [ALFA], not_invited: [], note: 'x' }],
    ['no member not_invited', { invite: [ALFA] }],
  ])('%s: the parser refuses the answer, so the decision gives `model_output_invalid` and records no decision', async (_name, given) => {
    const run = await setup();
    run.m.llm.answer = said(given);
    const failure = lost(await decide(run.deps, SHORTLIST_DECISION, INPUT));
    expect([failure.code, failure.reason]).toStrictEqual(['model_output_invalid', 'model_output_invalid']);
    // The hire was paid: the failure says so and carries the delivery.
    expect(failure.delivery).not.toBeNull();
  });
});
