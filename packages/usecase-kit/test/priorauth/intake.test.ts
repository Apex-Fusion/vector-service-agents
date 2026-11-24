// packages/usecase-kit/test/priorauth/intake.test.ts: the intake record that the Insurer Intake Agent returns and the Prior Authorization Agent reads, and the part parsers that it shares in form with the
// order confirmation of use case 1 (inventory reorder). The golden file is the example. The part parsers are copies of the private parsers of the inventory folder, so a table of rules holds each copy to its
// original: the parser of the confirmation answers the same table, and the two answers must agree. Each refusal has an accepted twin.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseOrderConfirmation } from '@vsa/usecase-kit/inventory';
import { RECEIPT_CHECKS } from '@vsa/usecase-kit/protocol';
import type { JsonValue, ProtocolResult } from '@vsa/usecase-kit/protocol';
import {
  parseApproval, parseChecks, parseDecision, parseDecisions, parseEnd, parseInference, parseOrganisation, parseSender, parseSubJob, parseVerification,
} from '../../src/priorauth/parts.ts';
import { MARKER, NOT_TEXT, change, expectRefused, golden, messageOf, must, objectAt, valueAt } from './support.ts';
import type { Json, Step } from './support.ts';

const HEX = 'ab'.repeat(32);
const DID = `did:vector:${HEX}`;
/** The paths of the parts of a record that the part parsers read. */
const DECISION = ['decisions', 0] as const;
const INFERENCE = [...DECISION, 'inference'] as const;
const SUB_JOB = [...INFERENCE, 'sub_job'] as const;
const VERIFICATION = [...SUB_JOB, 'verification'] as const;

/** The 15 names of the checks of an intake record, written out here and not taken from the code that the tests hold to this list. */
const CHECK_NAMES = [
  'sender_active', 'sender_accountable', 'sender_key', 'delegation', 'delegation_usable', 'vault_paid', 'approval_found', 'approval_type', 'approval_subject', 'approval_issuer', 'approval_valid',
  'approval_digest', 'for_this_insurer', 'advert', 'not_duplicate',
] as const;

/** The golden order confirmation of use case 1. Its parser is the original of the copies, and the answer of the original is the oracle of this file. */
const CONFIRMATION = JSON.parse(readFileSync(new URL('../inventory/golden/confirmation.json', import.meta.url), 'utf8')) as Json;

/** The value at `path` of a fresh golden intake record. The golden file holds JSON, so the value is a JsonValue. */
const part = (path: readonly Step[]): JsonValue => valueAt(golden('intake-record'), path) as JsonValue;

/** The name of a place in a detail, as the parsers write it: `confirmation.decisions[0].inference`. */
const place = (root: string, path: readonly Step[]): string => path.reduce<string>((text, step) => (typeof step === 'number' ? `${text}[${step}]` : `${text}.${step}`), root);

type Parser = (value: JsonValue, field: string) => ProtocolResult<unknown>;

/** The parsers of the parts that take an argument, with the argument that the intake record gives. */
const checksOf: Parser = (value, field) => parseChecks(value, field, CHECK_NAMES);
const decisionOf: Parser = (value, field) => parseDecision(value, field, 'completeness');
const decisionsOf: Parser = (value, field) => parseDecisions(value, field, 'completeness');

/** What one part parser must do with the values of one member. A value that is `undefined` removes the member. */
interface Rule {
  readonly what: string;
  /** The part parser that reads the value at `root`. */
  readonly parse: Parser;
  /** The place of that value in a record. */
  readonly root: readonly Step[];
  /** The member of that value that the test changes. It is empty when the test changes the value itself. */
  readonly member: readonly Step[];
  readonly bad: readonly unknown[];
  readonly good: readonly unknown[];
}

const ORGANISATION_BAD: readonly unknown[] = ['a'.repeat(1025), 'a'.repeat(2000), 1, true, ['echo.example'], {}];
const ORGANISATION_GOOD: readonly unknown[] = [
  null, 'echo.example', 'a', 'Demonstration organisation', 'caf\u00e9.example', '\u4e2d\u6587.example', '', ' ', '\u00a0', 'echo\u200d.example', 'a'.repeat(254), 'a'.repeat(1024), ' echo.example ',
  'echo\nexample', 'echo\texample', 'echo\u0001.example', 'echo\u2028example', MARKER,
];
const END_GOOD: readonly unknown[] = [
  null, '2026-11-24T10:00:00.000Z', '2026-11-24T10:00:00.123Z', '2028-12-31T23:59:59.999Z', '+010000-01-01T00:00:00.000Z', '-000001-01-01T00:00:00.000Z', '+275760-09-13T00:00:00.000Z',
];
const END_BAD: readonly unknown[] = [
  '2026-11-24T10:00:00Z', '2026-11-24T10:00:00.1Z', '2026-11-24T10:00:00.000+00:00', '2026-11-24T10:00:00.000', '2026-11-24', '2026-11-24t10:00:00.000z', '2026-02-30T00:00:00.000Z',
  '2026-13-01T00:00:00.000Z', '2026-11-24T24:00:00.000Z', '2026-11-24T10:60:00.000Z', '2026-11-24T10:00:00.000Z ', '2026-11-24T10:00:00.000Z\n', 1_795_000_000_000, '1795000000000', '',
  '+10000-01-01T00:00:00.000Z', '010000-01-01T00:00:00.000Z', '+0100000-01-01T00:00:00.000Z', '-000000-01-01T00:00:00.000Z', '+275760-09-13T00:00:00.001Z', '+010000-01-01T00:00:00Z',
  '+010000-02-30T00:00:00.000Z', true, [], {}, MARKER,
];

/** The forms of the members of a sub-job: the values that its parser refuses, and the values that it takes. A Kelvin sign is refused in an identifier. */
const SUB_JOB_FORMS: ReadonlyArray<readonly [string, readonly unknown[], readonly unknown[]]> = [
  ['capability_id', ['', 'a'.repeat(65), 'llm text', 'llm/text', '-llm', '\u212ALM', 'llm-\u212A', MARKER, ...NOT_TEXT], ['llm.text.generate.v1', 'a', 'A'.repeat(64)]],
  ['advert_ref', [HEX, `${HEX}#`, `${HEX}#01`, `${HEX.slice(2)}#0`, `${HEX}#0\n`, '', MARKER, ...NOT_TEXT], [`${HEX}#0`, `${HEX}#12`]],
  ['escrow_ref', [HEX, `${HEX}#-1`, `${HEX.toUpperCase()}#0`, '', MARKER, ...NOT_TEXT], [`${HEX}#0`]],
  ['supplier_pkh', [HEX.slice(10), HEX, HEX.slice(8).toUpperCase(), `${HEX.slice(8)}\n`, '', MARKER, ...NOT_TEXT], [HEX.slice(8)]],
  ['receipt_signature', ['', 'a b', 'a\nb', 'a'.repeat(1025), MARKER, ...NOT_TEXT], ['8e'.repeat(64), 'abc', 'base64+/=', 'a'.repeat(1024)]],
];

/** The rules of the part parsers. The values are the values that the tests of the confirmation give to the same parts. */
const RULES: readonly Rule[] = [
  { what: 'sender.did', parse: parseSender, root: ['sender'], member: ['did'], bad: [`did:vector:${HEX.slice(2)}`, `did:vector:${HEX}ab`, `did:vector:${HEX.toUpperCase()}`, HEX, `did:other:${HEX}`, '', null, 1, MARKER, undefined], good: [DID] },
  { what: 'sender.organisation_verified', parse: parseSender, root: ['sender'], member: ['organisation_verified'], bad: ['true', 'false', 1, 0, null, [true], {}, MARKER, undefined], good: [true, false] },
  { what: 'sender.organisation', parse: parseSender, root: ['sender'], member: ['organisation'], bad: [...ORGANISATION_BAD, undefined], good: ORGANISATION_GOOD },
  { what: 'the organisation itself', parse: parseOrganisation, root: ['sender', 'organisation'], member: [], bad: ORGANISATION_BAD, good: ORGANISATION_GOOD },
  { what: 'a sender that is not an object', parse: parseSender, root: ['sender'], member: [], bad: [[], 'sender', null, 1, true], good: [] },
  { what: 'approval.attestation', parse: parseApproval, root: ['approval'], member: ['attestation'], bad: [HEX.slice(2), `${HEX}ab`, HEX.toUpperCase(), DID, '', null, 1, MARKER, undefined], good: [HEX] },
  { what: 'approval.issuer_did', parse: parseApproval, root: ['approval'], member: ['issuer_did'], bad: [`did:vector:${HEX.slice(2)}`, `did:vector:${HEX.toUpperCase()}`, HEX, '', 1, true, MARKER, undefined], good: [DID, null] },
  { what: 'approval.valid_until', parse: parseApproval, root: ['approval'], member: ['valid_until'], bad: [...END_BAD, undefined], good: END_GOOD },
  { what: 'the end of an approval itself', parse: parseEnd, root: ['approval', 'valid_until'], member: [], bad: END_BAD, good: END_GOOD },
  { what: 'an approval that is not an object', parse: parseApproval, root: ['approval'], member: [], bad: [[], 'approval', null, 1, true], good: [] },
  { what: 'a check that is not true: sender_active', parse: checksOf, root: ['checks'], member: ['sender_active'], bad: [false, 'true', 1, 0, null, [], {}, MARKER, undefined], good: [true] },
  { what: 'a check that is not true: approval_digest', parse: checksOf, root: ['checks'], member: ['approval_digest'], bad: [false, 'true', 1, 0, null, [], {}, MARKER, undefined], good: [true] },
  { what: 'checks that are not an object with the listed names', parse: checksOf, root: ['checks'], member: [], bad: [[], [...CHECK_NAMES], 'checks', null, 15, {}], good: [] },
  ...RECEIPT_CHECKS.map((name): Rule => ({ what: `verification.${name}`, parse: parseVerification, root: VERIFICATION, member: [name], bad: ['true', 1, 0, null, [], {}, MARKER, undefined], good: [true, false] })),
  { what: 'a verification that is not an object', parse: parseVerification, root: VERIFICATION, member: [], bad: [[], 'checks', null, 1, true], good: [] },
  ...SUB_JOB_FORMS.map(([name, bad, good]): Rule => ({ what: `sub-job ${name}`, parse: parseSubJob, root: SUB_JOB, member: [name], bad: [...bad, undefined], good })),
  { what: 'sub-job receipt', parse: parseSubJob, root: SUB_JOB, member: ['receipt'], bad: [[], '{}', null, 1, true, undefined], good: [{}, { anything: [1, { a: null }], 'another key': 'x' }] },
  { what: 'sub-job verification', parse: parseSubJob, root: SUB_JOB, member: ['verification'], bad: [undefined, [], 'checks', null, 1, true], good: [] },
  { what: 'a sub-job that is not an object', parse: parseSubJob, root: SUB_JOB, member: [], bad: [[], 'sub_job', null, 1, true], good: [] },
  { what: 'inference.path', parse: parseInference, root: INFERENCE, member: ['path'], bad: ['api', 'Marketplace', 'marketplace ', '', MARKER, ...NOT_TEXT, undefined], good: ['marketplace'] },
  { what: 'inference.accepted', parse: parseInference, root: INFERENCE, member: ['accepted'], bad: ['no', 'Confirmed', 'confirmed ', 'pending\n', '', true, null, 1, MARKER, undefined], good: ['confirmed', 'pending'] },
  { what: 'inference.sub_job', parse: parseInference, root: INFERENCE, member: ['sub_job'], bad: [undefined, [], 'sub_job', null, 1], good: [] },
  { what: 'an inference that is not an object', parse: parseInference, root: INFERENCE, member: [], bad: [[], 'inference', null, 1, true], good: [] },
  { what: 'decision.reasoning', parse: decisionOf, root: DECISION, member: ['reasoning'], bad: ['', ' ', '\n\t ', ...NOT_TEXT, undefined], good: ['All five requirements are met.', ' padded ', 'caf\u00e9'] },
  {
    what: 'decision.choice', parse: decisionOf, root: DECISION, member: ['choice'], bad: [undefined],
    good: [null, true, 0, 1.5, 'text', [], [1, 'a', null], {}, { complete: false, missing: ['R3'], note: '' }, { nested: { deep: [{ a: 1 }] } }],
  },
  { what: 'decision.name', parse: decisionOf, root: DECISION, member: ['name'], bad: [undefined], good: [] },
  { what: 'decision.inference', parse: decisionOf, root: DECISION, member: ['inference'], bad: [undefined, [], 'inference', null, 1], good: [] },
  { what: 'a decision that is not an object', parse: decisionOf, root: DECISION, member: [], bad: [[], 'decision', null, 1, true], good: [] },
  { what: 'decisions that are not a list', parse: decisionsOf, root: ['decisions'], member: [], bad: [{}, 'decisions', null, 1], good: [] },
  { what: 'decisions of the wrong count', parse: decisionsOf, root: ['decisions'], member: [], bad: [[], [part(DECISION), part(DECISION)]], good: [] },
  { what: 'a decision in the list that is not an object', parse: decisionsOf, root: ['decisions'], member: [0], bad: ['decision', null, 1, [], [{}], true], good: [] },
];

/** The refusal of one rule: the detail names the place of the member, or for a member that is missing the object and the member. */
function expectRefusedAt(result: ProtocolResult<unknown, string>, prefix: string, rule: Rule, value: unknown): void {
  if (value !== undefined) return expectRefused(result, place(prefix, [...rule.root, ...rule.member]));
  const last = rule.member[rule.member.length - 1];
  return expectRefused(result, `${place(prefix, [...rule.root, ...rule.member.slice(0, -1)])} has no member ${JSON.stringify(last)}`);
}

/** The answer of the original for the same change, with the decision name of the confirmation written as the name of the intake record. */
function originalAnswer(path: readonly Step[], value: unknown): ProtocolResult<unknown> {
  const result = parseOrderConfirmation(change(CONFIRMATION, path, value));
  return result.ok ? result : { ...result, detail: result.detail.replaceAll('availability', 'completeness') };
}

/** The label of a value in the message of a failed check. */
const shownValue = (value: unknown): string => String(JSON.stringify(value)).slice(0, 60);

describe('the part parsers', () => {
  /** The answer of a part parser to the golden intake record with `value` at the member of the rule, with the field names that the confirmation uses. */
  const direct = (rule: Rule, value: unknown): ProtocolResult<unknown> => rule.parse(valueAt(change(golden('intake-record'), [...rule.root, ...rule.member], value), rule.root) as JsonValue, place('confirmation', rule.root));

  it.each(RULES.map((rule) => [rule.what, rule] as const))('%s: each bad value is refused with the detail of the original, and each good value is taken as the original takes it', (_what, rule) => {
    const path = [...rule.root, ...rule.member];
    for (const value of rule.bad) {
      const result = direct(rule, value);
      expect(result.ok, `${rule.what} ${shownValue(value)}`).toBe(false);
      expectRefusedAt(result, 'confirmation', rule, value);
      expect(!result.ok && result.detail, 'the detail never repeats a Kelvin sign').not.toContain('\u212A');
      expect(originalAnswer(path, value).ok, `the original refuses ${rule.what} ${shownValue(value)}`).toBe(false);
      expect(result).toStrictEqual(originalAnswer(path, value));
    }
    for (const value of rule.good) {
      const result = direct(rule, value);
      expect(result.ok, `${rule.what} ${shownValue(value)}`).toBe(true);
      expect(originalAnswer(path, value).ok, `the original takes ${rule.what} ${shownValue(value)}`).toBe(true);
      expect(result.ok && result.value, 'the copy holds what the input held').toStrictEqual(valueAt(change(golden('intake-record'), path, value), rule.root));
    }
  });

  it('refuses a check that is not listed, whatever its value and whatever its name, and the original refuses it too', () => {
    for (const name of ['not_a_check', 'quote_price', 'approval_digest_mismatch', 'duplicate_request', 'Advert', 'advert ', 'constructor', 'toString']) {
      for (const value of [true, false, null, 1]) {
        const result = checksOf(valueAt(change(golden('intake-record'), ['checks', name], value), ['checks']) as JsonValue, 'confirmation.checks');
        expectRefused(result, `confirmation.checks has the member ${JSON.stringify(name)}, which is not allowed`);
        expect(result).toStrictEqual(originalAnswer(['checks', name], value));
      }
    }
  });

  it.each([
    ['the sender', ['sender'], parseSender], ['the approval', ['approval'], parseApproval], ['the checks', ['checks'], checksOf], ['the verification', VERIFICATION, parseVerification],
    ['a sub-job', SUB_JOB, parseSubJob], ['an inference', INFERENCE, parseInference], ['a decision', DECISION, decisionOf],
  ] as ReadonlyArray<readonly [string, readonly Step[], Parser]>)('refuses a member that %s does not list, and the twin without it passes', (_what, root, parse) => {
    const result = parse(valueAt(change(golden('intake-record'), [...root, 'extra'], 1), root) as JsonValue, place('confirmation', root));
    expectRefused(result, `${place('confirmation', root)} has the member "extra", which is not allowed`);
    expect(parse(part(root), place('confirmation', root)).ok).toBe(true);
  });

  it('gives each part as a new plain object that shares no object with its input, and changes nothing of the input', () => {
    const input = golden('intake-record');
    const before = JSON.stringify(input);
    const decisions = input.decisions as JsonValue;
    const inference = objectAt(input, INFERENCE) as JsonValue;
    for (const [name, value, copy] of [
      ['the sender', input.sender, must(parseSender(input.sender as JsonValue, 'sender'))],
      ['the approval', input.approval, must(parseApproval(input.approval as JsonValue, 'approval'))],
      ['the checks', input.checks, must(parseChecks(input.checks as JsonValue, 'checks', CHECK_NAMES))],
      ['the decisions', decisions, must(parseDecisions(decisions, 'decisions', 'completeness'))],
      ['a decision', objectAt(input, DECISION), must(parseDecision(objectAt(input, DECISION) as JsonValue, 'decision', 'completeness'))],
      ['an inference', inference, must(parseInference(inference, 'inference'))],
      ['a sub-job', objectAt(input, SUB_JOB), must(parseSubJob(objectAt(input, SUB_JOB) as JsonValue, 'sub_job'))],
      ['a verification', objectAt(input, VERIFICATION), must(parseVerification(objectAt(input, VERIFICATION) as JsonValue, 'verification'))],
    ] as const) {
      expect(copy, name).not.toBe(value);
      expect(copy, name).toStrictEqual(value);
    }
    expect(JSON.stringify(input)).toBe(before);
  });

  it('keeps the members of each part in the order of the protocol, whatever the order of the input', () => {
    const reversed = (value: unknown): JsonValue => Object.fromEntries(Object.entries(value as Json).reverse()) as JsonValue;
    expect(Object.keys(must(parseSender(reversed(part(['sender'])), 'sender')))).toStrictEqual(['did', 'organisation', 'organisation_verified']);
    expect(Object.keys(must(parseApproval(reversed(part(['approval'])), 'approval')))).toStrictEqual(['attestation', 'issuer_did', 'valid_until']);
    expect(Object.keys(must(parseVerification(reversed(part(VERIFICATION)), 'verification')))).toStrictEqual([...RECEIPT_CHECKS]);
    expect(Object.keys(must(parseSubJob(reversed(part(SUB_JOB)), 'sub_job')))).toStrictEqual(['capability_id', 'advert_ref', 'escrow_ref', 'supplier_pkh', 'receipt', 'receipt_signature', 'verification']);
    expect(Object.keys(must(parseInference(reversed(part(INFERENCE)), 'inference')))).toStrictEqual(['path', 'sub_job', 'accepted']);
    expect(Object.keys(must(parseDecision(reversed(part(DECISION)), 'decision', 'completeness')))).toStrictEqual(['name', 'choice', 'reasoning', 'inference']);
  });
});

describe('the organisation and the end of an approval', () => {
  it('takes null as no organisation, and writes any other text in the NFC form', () => {
    expect(must(parseOrganisation(null, 'organisation'))).toBeNull();
    expect(must(parseOrganisation('cafe\u0301.example', 'organisation'))).toBe('caf\u00e9.example');
    expect(must(parseOrganisation('caf\u00e9.example', 'organisation'))).toBe('caf\u00e9.example');
  });

  it('counts the limit of the organisation in characters of the text as written: 1024 pass and 1025 do not, and the refusal never repeats the text', () => {
    expect(must(parseOrganisation('a'.repeat(1024), 'organisation'))).toBe('a'.repeat(1024));
    const result = parseOrganisation('a'.repeat(1025), 'organisation');
    expectRefused(result, 'organisation');
    expect(!result.ok && result.detail).not.toContain('aaaa');
  });

  it('takes the text that toISOString writes for a time of any year that a date holds, with the year of four digits or the extended form', () => {
    for (const year of [-271820, -1, 0, 99, 100, 999, 1000, 9999, 10000, 275760]) {
      const time = new Date(0);
      time.setUTCFullYear(year, 5, 17);
      time.setUTCMilliseconds(123);
      const text = time.toISOString();
      expect(must(parseEnd(text, 'end')), text).toBe(text);
    }
    expect(must(parseEnd(null, 'end'))).toBeNull();
  });
});

describe('parseChecks', () => {
  it('takes the names from its caller: one value passes for one list of names and is refused for another', () => {
    const value = { a: true, b: true };
    expect(parseChecks(value, 'checks', ['a', 'b'])).toStrictEqual({ ok: true, value: { a: true, b: true } });
    expectRefused(parseChecks(value, 'checks', ['a', 'c']), 'checks has no member "c"');
    expectRefused(parseChecks(value, 'checks', ['a']), 'checks has the member "b", which is not allowed');
    expect(parseChecks({ c: true }, 'checks', ['c']).ok).toBe(true);
  });

  it('keeps the order of the list of names in the copy, whatever the order of the input', () => {
    const reversed = Object.fromEntries([...CHECK_NAMES].reverse().map((name) => [name, true]));
    expect(Object.keys(must(parseChecks(reversed, 'checks', CHECK_NAMES)))).toStrictEqual([...CHECK_NAMES]);
  });

  it('throws a TypeError for a list of names that is empty or that names a check two times, because with no name every object would pass', () => {
    expect(() => parseChecks({}, 'checks', [])).toThrow(TypeError);
    expect(() => parseChecks({ a: true }, 'checks', ['a', 'a'])).toThrow(TypeError);
    expect(messageOf(() => parseChecks({}, 'checks', []))).toContain('names of the checks');
    expect(parseChecks({ a: true }, 'checks', ['a']).ok).toBe(true);
  });
});

describe('the name of the decision', () => {
  it('is the name that the caller gives, and no other name is taken', () => {
    expect(parseDecision(part(DECISION), 'decision', 'completeness').ok).toBe(true);
    expectRefused(parseDecision(part(DECISION), 'decision', 'availability'), 'decision.name must be "availability"');
    const others = ['accept_delivery', 'justification', 'complete', 'completenes', 'Completeness', 'completeness ', ' completeness', 'completeness\n', 'a', '', MARKER, ...NOT_TEXT];
    for (const name of others) expectRefused(decisionOf(valueAt(change(golden('intake-record'), [...DECISION, 'name'], name), DECISION) as JsonValue, 'decision'), 'decision.name');
  });

  it('is the one name of the one decision of a list: none, two of one name, and two of other names are refused', () => {
    const decision = objectAt(golden('intake-record'), DECISION);
    const named = (name: string): JsonValue => ({ ...decision, name }) as JsonValue;
    expect(decisionsOf([named('completeness')], 'decisions').ok).toBe(true);
    for (const names of [[], ['completeness', 'completeness'], ['completeness', 'accept_delivery'], ['accept_delivery', 'completeness'], ['availability', 'accept_delivery']]) {
      expectRefused(decisionsOf(names.map(named), 'decisions'), 'decisions must hold exactly one decision, named "completeness"');
    }
    expectRefused(decisionsOf([named('availability')], 'decisions'), 'decisions[0].name');
  });

  it('keeps each text of a decision as it came, because it holds the words of a model and its signed receipt', () => {
    const decision = objectAt(golden('intake-record'), DECISION);
    const input = change({ ...decision, reasoning: 'cafe\u0301 is open', choice: { note: 'cafe\u0301' } }, ['inference', 'sub_job', 'receipt', 'model'], 'cafe\u0301');
    const copy = must(parseDecision(input as JsonValue, 'decision', 'completeness'));
    expect(copy.reasoning).toBe('cafe\u0301 is open');
    expect(copy.choice).toStrictEqual({ note: 'cafe\u0301' });
    expect(copy.inference.sub_job.receipt).toMatchObject({ model: 'cafe\u0301' });
  });
});
