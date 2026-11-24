// packages/usecase-kit/test/priorauth/intake.test.ts: the intake record that the Insurer Intake Agent returns and the Prior Authorization Agent reads, and the part parsers that it shares in form with the
// order confirmation of use case 1 (inventory reorder). The golden file is the example. The list of the checks is written out in the folder, and a drift test holds its first 12 names to the shared checks of
// the checks folder. The part parsers are copies of the private parsers of the inventory folder, so a table of rules holds each copy to its original: the parser of the confirmation answers the same table,
// and the two answers must agree. The same table then holds the record parser to the part parsers. Each refusal has an accepted twin.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SHARED_CHECK_NAMES } from '@vsa/usecase-kit/checks';
import { parseOrderConfirmation } from '@vsa/usecase-kit/inventory';
import * as folder from '@vsa/usecase-kit/priorauth';
import { ATTESTATION_STATES, INTAKE_CHECKS, INTAKE_RECORD_SCHEMA, INTAKE_STATUSES, parseIntakeRecord as parse, parsePriorAuthRequest } from '@vsa/usecase-kit/priorauth';
import type { IntakeRecord } from '@vsa/usecase-kit/priorauth';
import { FAULT_MODES, RECEIPT_CHECKS, canonicalSha256 } from '@vsa/usecase-kit/protocol';
import type { JsonValue, ProtocolResult } from '@vsa/usecase-kit/protocol';
import {
  parseApproval, parseChecks, parseDecision, parseDecisions, parseEnd, parseInference, parseOrganisation, parseSender, parseSubJob, parseVerification,
} from '../../src/priorauth/parts.ts';
import { ID_BAD, ID_GOOD, MARKER, NOT_TEXT, change, expectRefused, golden, goldenText, listAt, messageOf, must, objectAt, valueAt, withGetter, withPrototype, withProtoKey } from './support.ts';
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
  /** The good values at the level of the record, when they differ from `good`: a record takes a choice only when the choice says what the status says. */
  readonly recordGood?: readonly unknown[];
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
    recordGood: [{ complete: true, missing: [] }, { complete: true, missing: [], note: '' }, { complete: true, missing: [], nested: { deep: [{ a: 1 }] } }],
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

/** The SHA-256 of the bytes of the golden file. A change of the file shows here. */
const GOLDEN_FILE_SHA256 = '4c926eb206dd0b2c5fdda8e681a432aff6aaca460b1b874134f7f09202dad7d2';
const MEMBERS = [
  'schema', 'outcome', 'request_number', 'request_sha256', 'status', 'missing', 'intake_id', 'sender', 'approval', 'attestations', 'checks', 'decisions', 'fault_mode',
] as const;
const RECORD = 'intake record';
const ATTESTATIONS = ['provenance', 'software', 'principal_binding'] as const;

/** The golden record with another value at `path`. */
const withValue = (path: readonly Step[], value: unknown): Json => change(golden('intake-record'), path, value);

/** The golden record for a request that is not complete: the status, the missing requirements and the choice of the decision agree. */
const incomplete = (missing: readonly unknown[]): Json => change(change(withValue(['status'], 'incomplete'), ['missing'], missing), [...DECISION, 'choice'], { complete: false, missing: [...missing] });

/** `count` requirement ids: `R0`, `R1` and so on. */
const ids = (count: number): string[] => Array.from({ length: count }, (_, index) => `R${index}`);

describe('the constants of the intake record', () => {
  it('name the schema, the two statuses and the four attestation states', () => {
    expect(INTAKE_RECORD_SCHEMA).toBe('vector.usecase.intake-record.v1');
    expect(INTAKE_STATUSES).toStrictEqual(['complete', 'incomplete']);
    expect(ATTESTATION_STATES).toStrictEqual(['valid', 'invalid', 'absent', 'unreadable']);
  });

  it('list 15 checks in the order that they run: the 12 shared checks of an insurer intake agent, and then the three checks of the agent', () => {
    expect(INTAKE_CHECKS).toHaveLength(15);
    expect(INTAKE_CHECKS).toStrictEqual([...CHECK_NAMES]);
    expect(INTAKE_CHECKS.slice(0, 12)).toStrictEqual([...SHARED_CHECK_NAMES['insurer-intake-agent']]);
    expect(INTAKE_CHECKS.slice(12)).toStrictEqual(['for_this_insurer', 'advert', 'not_duplicate']);
    expect(new Set(INTAKE_CHECKS).size).toBe(15);
  });

  it('hold the check of the vault payment after the two checks of the delegation, and before the approval', () => {
    expect(INTAKE_CHECKS.slice(3, 8)).toStrictEqual(['delegation', 'delegation_usable', 'vault_paid', 'approval_found', 'approval_type']);
  });

  it('say that the Insurer Intake Agent has no fault value, so the record holds the empty text only', () => {
    expect(FAULT_MODES['insurer-intake-agent']).toStrictEqual([]);
  });
});

describe('the golden intake record', () => {
  it('is the file that the hash names, and it holds the members in their order, with the 15 checks', () => {
    expect(createHash('sha256').update(goldenText('intake-record')).digest('hex')).toBe(GOLDEN_FILE_SHA256);
    const input = golden('intake-record');
    expect(Object.keys(input)).toStrictEqual([...MEMBERS]);
    expect(Object.keys(objectAt(input, ['checks']))).toStrictEqual([...INTAKE_CHECKS]);
    expect(input.schema).toBe(INTAKE_RECORD_SCHEMA);
    expect([input.status, input.missing, input.fault_mode]).toStrictEqual(['complete', [], '']);
  });

  it('passes the parser, and the copy holds the same members in the same order', () => {
    const result = parse(golden('intake-record'));
    expect(result).toStrictEqual({ ok: true, value: golden('intake-record') });
    const record = must(result);
    expect(Object.keys(record)).toStrictEqual([...MEMBERS]);
    expect(Object.keys(record.sender)).toStrictEqual(['did', 'organisation', 'organisation_verified']);
    expect(Object.keys(record.approval)).toStrictEqual(['attestation', 'issuer_did', 'valid_until']);
    expect(Object.keys(record.attestations)).toStrictEqual([...ATTESTATIONS]);
    expect(Object.keys(record.checks)).toStrictEqual([...INTAKE_CHECKS]);
    expect(Object.values(record.checks)).toStrictEqual(INTAKE_CHECKS.map(() => true));
  });

  it('names the canonical hash of the golden request and its request number: the test computes the hash again', () => {
    const request = must(parsePriorAuthRequest(golden('request')));
    const record = must(parse(golden('intake-record')));
    expect(record.request_sha256).toBe(must(canonicalSha256(request)));
    expect(record.request_number).toBe(request.request_number);
  });

  it('gives a copy that shares no object with the input, and changes nothing of the input', () => {
    const input = golden('intake-record');
    const before = JSON.stringify(input);
    const record = must(parse(input));
    expect(JSON.stringify(input)).toBe(before);
    expect(record).not.toBe(input);
    for (const name of ['sender', 'approval', 'attestations', 'checks', 'missing', 'decisions'] as const) expect(record[name], name).not.toBe(input[name]);
    expect(record.decisions[0]).not.toBe(objectAt(input, DECISION));
    expect(record.decisions[0]!.inference.sub_job.receipt).not.toBe(objectAt(input, [...SUB_JOB, 'receipt']));
  });

  it('can be written as a typed value: the copy is an IntakeRecord', () => {
    const record: IntakeRecord = must(parse(golden('intake-record')));
    expect(record.outcome).toBe('done');
    expect(INTAKE_STATUSES).toContain(record.status);
    expect(ATTESTATION_STATES).toContain(record.attestations.principal_binding);
    expect(record.fault_mode).toBe('');
    expect(record.decisions[0]!.name).toBe('completeness');
  });
});

describe('a member that is missing or is not listed', () => {
  it.each(MEMBERS)('refuses a record with no member %s', (name) => {
    expectRefused(parse(withValue([name], undefined)), `${RECORD} has no member "${name}"`);
  });

  it.each([
    ['the record', []], ['the sender', ['sender']], ['the approval', ['approval']], ['the attestations', ['attestations']], ['the checks', ['checks']], ['a decision', DECISION],
    ['the inference of a decision', INFERENCE], ['a sub-job', SUB_JOB], ['the verification of a sub-job', VERIFICATION],
  ] as ReadonlyArray<readonly [string, readonly Step[]]>)('refuses a member that is not listed in %s, and the twin without it passes', (_what, path) => {
    expectRefused(parse(withValue([...path, 'extra'], 1)), 'has the member "extra", which is not allowed');
    expect(parse(golden('intake-record')).ok).toBe(true);
  });

  it('refuses the members that belong to a confirmation, a request or a result of the Prior Authorization Agent', () => {
    for (const name of ['po_number', 'po_sha256', 'tenant', 'order_id', 'service_code', 'justification', 'handoff', 'exit_state', 'reason', 'sub_jobs', 'receipt']) {
      expectRefused(parse({ ...golden('intake-record'), [name]: HEX }), `has the member "${name}", which is not allowed`);
    }
  });
});

describe('the status and the missing requirements', () => {
  it('takes complete with no missing requirement, and incomplete with one', () => {
    expect(must(parse(golden('intake-record'))).status).toBe('complete');
    const record = must(parse(incomplete(['R3'])));
    expect([record.status, record.missing]).toStrictEqual(['incomplete', ['R3']]);
  });

  it('refuses complete with a missing requirement, and incomplete with none, and names the status', () => {
    expectRefused(parse(withValue(['missing'], ['R3'])), `${RECORD}.status`);
    expectRefused(parse(withValue(['status'], 'incomplete')), `${RECORD}.status`);
    expectRefused(parse(incomplete([])), `${RECORD}.status`);
    expect(parse(incomplete(['R3'])).ok).toBe(true);
    expect(parse(golden('intake-record')).ok).toBe(true);
  });

  it.each([
    ['capital letters', 'Complete'], ['all capital letters', 'INCOMPLETE'], ['a space at the end', 'complete '], ['a space at the start', ' incomplete'], ['a line break', 'incomplete\n'],
    ['the outcome', 'done'], ['another word', 'partial'], ['the empty text', ''], ['the marker', MARKER], ['null', null], ['true', true], ['a number', 1], ['a list', ['complete']], ['an object', {}],
  ])('refuses a status that is %s, and names the status', (_what, status) => {
    expectRefused(parse(withValue(['status'], status)), `${RECORD}.status`);
  });

  it('takes 20 missing requirements and refuses 21, and keeps the order of the list', () => {
    expect(must(parse(incomplete(ids(20)))).missing).toStrictEqual(ids(20));
    expect(must(parse(incomplete(['R9', 'R1', 'R5']))).missing).toStrictEqual(['R9', 'R1', 'R5']);
    expectRefused(parse(incomplete(ids(21))), `${RECORD}.missing`);
  });

  it('refuses a requirement that is in the list two times, and names the second entry', () => {
    expectRefused(parse(incomplete(['R3', 'R3'])), `${RECORD}.missing[1]`);
    expectRefused(parse(incomplete(['R1', 'R2', 'R1'])), `${RECORD}.missing[2]`);
    expect(parse(incomplete(['R1', 'R2', 'R3'])).ok).toBe(true);
  });

  it('refuses a requirement that is not an identifier, and takes the identifiers', () => {
    for (const value of ID_BAD) expectRefused(parse(incomplete([value])), `${RECORD}.missing[0]`);
    for (const value of ID_GOOD) expect(parse(incomplete([value])).ok, String(value)).toBe(true);
  });

  it.each([['a text', 'R3'], ['null', null], ['a number', 1], ['an object', {}], ['an object with an index', { 0: 'R3' }]])('refuses missing requirements that are %s', (_what, missing) => {
    expectRefused(parse(withValue(['missing'], missing)), `${RECORD}.missing`);
  });
});

describe('the attestations', () => {
  it('takes each of the four states for each of the three members, and keeps it in the copy', () => {
    for (const name of ATTESTATIONS) {
      for (const state of ['valid', 'invalid', 'absent', 'unreadable']) expect(must(parse(withValue(['attestations', name], state))).attestations[name], `${name} ${state}`).toBe(state);
    }
  });

  it('refuses a state that is not listed, for each member, and names the member', () => {
    const states = ['maybe', 'Valid', 'VALID', 'valid ', ' valid', 'valid\n', 'present', 'revoked', 'unknown', 'expired', 'unreadable ', '', MARKER, ...NOT_TEXT];
    for (const name of ATTESTATIONS) {
      for (const state of states) expectRefused(parse(withValue(['attestations', name], state)), `${RECORD}.attestations.${name}`);
    }
  });

  it.each(ATTESTATIONS)('refuses attestations with no member %s', (name) => {
    expectRefused(parse(withValue(['attestations', name], undefined)), `${RECORD}.attestations has no member "${name}"`);
  });

  it('refuses a member that is not listed, and the twin without it passes', () => {
    for (const name of ['issuer', 'binding', 'principal', 'attestation', 'constructor']) {
      expectRefused(parse(withValue(['attestations', name], 'valid')), `${RECORD}.attestations has the member ${JSON.stringify(name)}, which is not allowed`);
    }
    expect(parse(golden('intake-record')).ok).toBe(true);
  });

  it.each([['a list', []], ['a list of the states', ['valid', 'valid', 'valid']], ['a text', 'valid'], ['null', null], ['a number', 3], ['an object with no member', {}]])('refuses attestations that are %s', (_what, value) => {
    expectRefused(parse(withValue(['attestations'], value)), `${RECORD}.attestations`);
  });

  it('keeps the members in the order of the record, whatever the order of the input', () => {
    const reversed = { principal_binding: 'invalid', software: 'absent', provenance: 'unreadable' };
    const record = must(parse(withValue(['attestations'], reversed)));
    expect(Object.keys(record.attestations)).toStrictEqual([...ATTESTATIONS]);
    expect(record.attestations).toStrictEqual({ provenance: 'unreadable', software: 'absent', principal_binding: 'invalid' });
  });
});

describe('the fifteen checks', () => {
  const all = (): Record<string, unknown> => Object.fromEntries(CHECK_NAMES.map((name) => [name, true]));

  it.each(CHECK_NAMES)('refuses a record with 14 checks, without %s', (name) => {
    expectRefused(parse(withValue(['checks', name], undefined)), `${RECORD}.checks has no member "${name}"`);
  });

  it('refuses the 14 names that the page of the agent lists, which have no check of the vault payment', () => {
    const fourteen = all();
    delete fourteen.vault_paid;
    expectRefused(parse(withValue(['checks'], fourteen)), 'has no member "vault_paid"');
  });

  it('refuses 16 checks: a name that is not listed, whatever its value, a name of the Order Desk, and a refusal code in the place of a check', () => {
    const names = [
      'not_a_check', 'lot', 'quantity', 'for_this_supplier', 'not_for_this_insurer', 'advert_mismatch', 'duplicate_request', 'approval_digest_mismatch', 'Advert', 'advert ', 'constructor', 'toString',
    ];
    for (const name of names) {
      for (const value of [true, false, null, 1]) expectRefused(parse(withValue(['checks'], { ...all(), [name]: value })), `${RECORD}.checks has the member ${JSON.stringify(name)}, which is not allowed`);
    }
  });

  it('refuses a name that is not listed in the place of a listed name, and the same value that is listed passes', () => {
    const swapped = Object.fromEntries(CHECK_NAMES.map((name) => [name === 'advert' ? 'advert_mismatch' : name, true]));
    expectRefused(parse(withValue(['checks'], swapped)), 'has no member "advert"');
    expect(parse(withValue(['checks'], all())).ok).toBe(true);
  });

  it.each(CHECK_NAMES)('refuses the check %s with the value false', (name) => {
    expectRefused(parse(withValue(['checks', name], false)), `${RECORD}.checks.${name}`);
  });

  it.each([['the text true', 'true'], ['the number 1', 1], ['null', null], ['the empty list', []], ['an object', { ok: true }], ['the text of the marker', MARKER], ['0', 0]])(
    'refuses a check with the value %s',
    (_what, value) => {
      for (const name of CHECK_NAMES) expectRefused(parse(withValue(['checks', name], value)), `${RECORD}.checks.${name}`);
    },
  );

  it.each([['a list', []], ['a list of the names', [...CHECK_NAMES]], ['a text', 'checks'], ['null', null], ['a number', 15], ['an object with no member', {}]])('refuses checks that are %s', (_what, checks) => {
    expectRefused(parse(withValue(['checks'], checks)), `${RECORD}.checks`);
  });

  it('keeps the order of the list in the copy, whatever the order of the input', () => {
    const reversed = Object.fromEntries([...CHECK_NAMES].reverse().map((name) => [name, true]));
    expect(Object.keys(must(parse(withValue(['checks'], reversed))).checks)).toStrictEqual([...INTAKE_CHECKS]);
  });
});

describe('the outcome, the schema and the fault setting', () => {
  it.each([
    ['failed', 'failed'], ['completed', 'completed'], ['in capital letters', 'DONE'], ['with a space', 'done '], ['with a line break', 'done\n'], ['the empty text', ''], ['null', null], ['true', true],
    ['a list', ['done']], ['the marker', MARKER],
  ])('refuses the outcome %s, and takes done', (_what, outcome) => {
    expectRefused(parse(withValue(['outcome'], outcome)), `${RECORD}.outcome`);
    expect(must(parse(withValue(['outcome'], 'done'))).outcome).toBe('done');
  });

  it.each([
    ['another version', 'vector.usecase.intake-record.v2'], ['capital letters', 'VECTOR.USECASE.INTAKE-RECORD.V1'], ['the schema of the order confirmation', 'vector.usecase.order-confirmation.v1'],
    ['the schema of the request', 'vector.usecase.priorauth-request.v1'], ['a number', 1], ['null', null], ['the marker', MARKER], ['a space at the end', 'vector.usecase.intake-record.v1 '],
  ])('refuses a schema that is %s', (_what, schema) => {
    expectRefused(parse(withValue(['schema'], schema)), `${RECORD}.schema`);
    expect(must(parse(withValue(['schema'], INTAKE_RECORD_SCHEMA))).schema).toBe(INTAKE_RECORD_SCHEMA);
  });

  it('takes the empty text as the fault setting', () => {
    expect(must(parse(withValue(['fault_mode'], ''))).fault_mode).toBe('');
  });

  it.each([
    ['a value of the Prior Authorization Agent', 'alter_after_approval'], ['a value of the Order Desk', 'confirm_wrong_lot'], ['a value of the Sourcing Agent', 'invert_scores'],
    ['a value of the Bid Desk', 'quote_off_price_list'], ['a letter', 'x'], ['a space', ' '], ['a name of the prototype', 'constructor'], ['null', null], ['a number', 0], ['false', false], ['a list', []],
    ['the marker', MARKER],
  ])('refuses %s as the fault setting', (_what, value) => {
    expectRefused(parse(withValue(['fault_mode'], value)), `${RECORD}.fault_mode`);
  });
});

describe('the request number, the request hash and the intake id', () => {
  const FORMS: ReadonlyArray<readonly [string, readonly unknown[], readonly unknown[]]> = [
    ['request_number', ID_BAD, ID_GOOD],
    ['intake_id', ID_BAD, ID_GOOD],
    ['request_sha256', [HEX.slice(2), `${HEX}ab`, HEX.toUpperCase(), `${HEX}\n`, '', MARKER, ...NOT_TEXT], [HEX, '0'.repeat(64)]],
  ];

  it.each(FORMS)('%s: refuses each value that is not in its form, and takes the values that are', (name, bad, good) => {
    for (const value of bad) expectRefused(parse(withValue([name], value)), `${RECORD}.${name}`);
    for (const value of good) expect(parse(withValue([name], value)).ok, `${name} ${String(value)}`).toBe(true);
  });
});

describe('the decisions of the record', () => {
  const named = (name: unknown): Json => ({ ...objectAt(golden('intake-record'), DECISION), name });

  it('takes exactly one decision, named completeness, for a complete record and for an incomplete one', () => {
    expect(must(parse(golden('intake-record'))).decisions.map((entry) => entry.name)).toStrictEqual(['completeness']);
    expect(must(parse(incomplete(['R3']))).decisions.map((entry) => entry.name)).toStrictEqual(['completeness']);
  });

  it('refuses a decision of another name and names the member: the decision of the Order Desk, the decisions of the Prior Authorization Agent, and any other text', () => {
    const others = ['availability', 'accept_delivery', 'justification', 'complete', 'Completeness', 'completeness ', ' completeness', 'completeness\n', 'a', '', MARKER, ...NOT_TEXT];
    for (const name of others) expectRefused(parse(withValue([...DECISION, 'name'], name)), `${RECORD}.decisions[0].name`);
    expect(parse(withValue([...DECISION, 'name'], 'completeness')).ok).toBe(true);
  });

  it('refuses two decisions, whatever their names, and no decision, and names the list', () => {
    for (const names of [['completeness', 'completeness'], ['completeness', 'accept_delivery'], ['accept_delivery', 'completeness'], ['availability', 'completeness'], ['completeness', 'availability']]) {
      expectRefused(parse(withValue(['decisions'], names.map(named))), `${RECORD}.decisions`);
    }
    expectRefused(parse(withValue(['decisions'], [])), `${RECORD}.decisions`);
    expect(parse(withValue(['decisions'], [named('completeness')])).ok).toBe(true);
  });

  it('refuses a decision with a receipt of the wrong shape, and takes the receipt of the golden decision', () => {
    const where = `${RECORD}.decisions[0].inference`;
    for (const receipt of [[], 'receipt', null, 1, true]) expectRefused(parse(withValue([...SUB_JOB, 'receipt'], receipt)), `${where}.sub_job.receipt`);
    expectRefused(parse(withValue([...SUB_JOB, 'receipt_signature'], 'a b')), `${where}.sub_job.receipt_signature`);
    expectRefused(parse(withValue([...SUB_JOB, 'verification', 'signature_valid'], 'true')), `${where}.sub_job.verification.signature_valid`);
    expectRefused(parse(withValue([...INFERENCE, 'accepted'], 'maybe')), `${where}.accepted`);
    expect(parse(golden('intake-record')).ok).toBe(true);
  });
});

describe('the choice of the decision and the record', () => {
  /** The golden record for the status `status` and the missing requirements `missing`, with the choice `choice` in its decision. */
  const recordWith = (status: string, missing: readonly unknown[], choice: unknown): Json => change(change(withValue(['status'], status), ['missing'], missing), [...DECISION, 'choice'], choice);
  const CHOICE = `${RECORD}.decisions[0].choice`;

  it('takes a choice that says what the record says: complete with no missing requirement, and incomplete with the missing requirements', () => {
    const complete = must(parse(golden('intake-record')));
    expect([complete.status, complete.missing, complete.decisions[0]!.choice]).toStrictEqual(['complete', [], { complete: true, missing: [] }]);
    const partial = must(parse(incomplete(['R3', 'R4'])));
    expect([partial.status, partial.missing, partial.decisions[0]!.choice]).toStrictEqual(['incomplete', ['R3', 'R4'], { complete: false, missing: ['R3', 'R4'] }]);
  });

  it('refuses the four records that break the rule: a complete record with a choice of incomplete, an incomplete record with a choice of complete, other missing ids, and a choice that is a text', () => {
    expectRefused(parse(recordWith('complete', [], { complete: false, missing: ['R3'] })), `${CHOICE}.complete`);
    expectRefused(parse(recordWith('incomplete', ['R3'], { complete: true, missing: [] })), `${CHOICE}.complete`);
    expectRefused(parse(recordWith('incomplete', ['R3'], { complete: false, missing: ['R4'] })), `${CHOICE}.missing`);
    expectRefused(parse(recordWith('complete', [], 'whatever')), CHOICE);
    expect(parse(recordWith('complete', [], { complete: true, missing: [] })).ok).toBe(true);
    expect(parse(recordWith('incomplete', ['R3'], { complete: false, missing: ['R3'] })).ok).toBe(true);
  });

  it.each([['a text', 'whatever'], ['null', null], ['a number', 1], ['true', true], ['a list', []], ['a list that holds the choice', [{ complete: true, missing: [] }]], ['the marker', MARKER]])(
    'refuses a choice that is %s, and names the choice',
    (_what, choice) => {
      expectRefused(parse(recordWith('complete', [], choice)), CHOICE);
      expectRefused(parse(recordWith('incomplete', ['R3'], choice)), CHOICE);
    },
  );

  it('refuses a choice with no member complete, and a member complete that is not a boolean that fits the status', () => {
    expectRefused(parse(recordWith('complete', [], { missing: [] })), `${CHOICE}.complete`);
    expectRefused(parse(recordWith('incomplete', ['R3'], { missing: ['R3'] })), `${CHOICE}.complete`);
    for (const complete of ['true', 'false', 1, 0, null, [], {}, [true], MARKER]) {
      expectRefused(parse(recordWith('complete', [], { complete, missing: [] })), `${CHOICE}.complete`);
      expectRefused(parse(recordWith('incomplete', ['R3'], { complete, missing: ['R3'] })), `${CHOICE}.complete`);
    }
    expect(parse(recordWith('complete', [], { complete: true, missing: [] })).ok).toBe(true);
    expect(parse(recordWith('incomplete', ['R3'], { complete: false, missing: ['R3'] })).ok).toBe(true);
  });

  it('refuses a choice with no member missing, and a member missing that is not a list', () => {
    expectRefused(parse(recordWith('complete', [], { complete: true })), `${CHOICE}.missing`);
    expectRefused(parse(recordWith('incomplete', ['R3'], { complete: false })), `${CHOICE}.missing`);
    for (const missing of ['R3', '', null, 1, true, {}, { first: 'R3' }, MARKER]) {
      expectRefused(parse(recordWith('incomplete', ['R3'], { complete: false, missing })), `${CHOICE}.missing`);
    }
    for (const missing of ['', null, 0, false, {}, MARKER]) expectRefused(parse(recordWith('complete', [], { complete: true, missing })), `${CHOICE}.missing`);
  });

  it('refuses a missing list of the choice that does not name the same requirements: fewer, more, other ids, an id that is not a text, an id in another case, and an id two times', () => {
    const record = (missing: unknown): Json => recordWith('incomplete', ['R1', 'R2'], { complete: false, missing });
    for (const missing of [[], ['R1'], ['R2'], ['R1', 'R2', 'R3'], ['R1', 'R3'], ['R3', 'R4'], ['r1', 'r2'], ['R1', 'R1'], ['R1', 'R2', 'R2'], [1, 2], ['R1', null], [['R1'], ['R2']], ['R1', 'R2 '], ['R1', 'R2\n']]) {
      expectRefused(parse(record(missing)), `${CHOICE}.missing`);
    }
    expectRefused(parse(recordWith('complete', [], { complete: true, missing: ['R1'] })), `${CHOICE}.missing`);
    expect(parse(record(['R1', 'R2'])).ok).toBe(true);
  });

  it('takes the same requirements in another order, because the order of the ids has no meaning, and keeps the order of the record', () => {
    const record = must(parse(recordWith('incomplete', ['R1', 'R2', 'R3'], { complete: false, missing: ['R3', 'R1', 'R2'] })));
    expect(record.missing).toStrictEqual(['R1', 'R2', 'R3']);
    expect(record.decisions[0]!.choice).toStrictEqual({ complete: false, missing: ['R3', 'R1', 'R2'] });
  });

  it('takes more members in the choice than complete and missing, and keeps them as they came, because the decision holds the answer of the model', () => {
    const record = must(parse(recordWith('incomplete', ['R3'], { complete: false, missing: ['R3'], note: 'cafe\u0301', nested: { deep: [{ a: 1 }] } })));
    expect(record.decisions[0]!.choice).toStrictEqual({ complete: false, missing: ['R3'], note: 'cafe\u0301', nested: { deep: [{ a: 1 }] } });
  });

  it('takes the status that the choice gives for 20 missing requirements', () => {
    expect(must(parse(incomplete(ids(20)))).decisions[0]!.choice).toStrictEqual({ complete: false, missing: ids(20) });
    expectRefused(parse(recordWith('incomplete', ids(20), { complete: false, missing: ids(19) })), `${CHOICE}.missing`);
  });

  it('reads no member that a prototype holds: a choice with no own member is refused, although the prototype holds both members', () => {
    const inherited = { complete: { value: true, writable: true, enumerable: true }, missing: { value: [], writable: true, enumerable: true } };
    const input = recordWith('complete', [], {});
    expectRefused(withPrototype(Object.prototype, inherited, () => parse(input)), `${CHOICE}.complete`);
    const half = recordWith('complete', [], { complete: true });
    expectRefused(withPrototype(Object.prototype, { missing: inherited.missing }, () => parse(half)), `${CHOICE}.missing`);
    expect(parse(golden('intake-record')).ok).toBe(true);
  });

  it('names the field and never repeats a value of the choice', () => {
    const result = parse(recordWith('incomplete', ['R3'], { complete: false, missing: ['zq9 marker'] }));
    expectRefused(result, `${CHOICE}.missing`);
    const text = parse(recordWith('complete', [], MARKER));
    expectRefused(text, CHOICE);
  });
});

describe('the part parsers inside the record', () => {
  it.each(RULES.map((rule) => [rule.what, rule] as const))('%s: the record parser answers as the part parser does, with the name of its own field', (_what, rule) => {
    const path = [...rule.root, ...rule.member];
    for (const value of rule.bad) {
      const result = parse(withValue(path, value));
      expect(result.ok, `${rule.what} ${shownValue(value)}`).toBe(false);
      expectRefusedAt(result, RECORD, rule, value);
      expect(result).toStrictEqual(rule.parse(valueAt(withValue(path, value), rule.root) as JsonValue, place(RECORD, rule.root)));
    }
    for (const value of rule.recordGood ?? rule.good) expect(parse(withValue(path, value)).ok, `${rule.what} ${shownValue(value)}`).toBe(true);
  });
});

describe('the Unicode form of a text', () => {
  it('writes the organisation in the NFC form, and keeps the texts of the decision as they came', () => {
    let sample = withValue(['sender', 'organisation'], 'cafe\u0301.example');
    sample = change(sample, [...DECISION, 'reasoning'], 'cafe\u0301 is open');
    sample = change(sample, [...SUB_JOB, 'receipt', 'model'], 'cafe\u0301');
    sample = change(sample, [...DECISION, 'choice', 'note'], 'cafe\u0301');
    const record = must(parse(sample));
    expect(record.sender.organisation).toBe('caf\u00e9.example');
    expect(record.decisions[0]!.reasoning).toBe('cafe\u0301 is open');
    expect(record.decisions[0]!.inference.sub_job.receipt).toMatchObject({ model: 'cafe\u0301' });
    expect(record.decisions[0]!.choice).toMatchObject({ note: 'cafe\u0301' });
  });

  it('checks each identifier as it is written: the Kelvin sign is refused, although NFC turns it into the letter K, and the twin with the letter K passes', () => {
    const places: ReadonlyArray<readonly [string, (text: string) => Json]> = [
      [`${RECORD}.request_number`, (text) => withValue(['request_number'], text)], [`${RECORD}.intake_id`, (text) => withValue(['intake_id'], text)],
      [`${RECORD}.missing[0]`, (text) => incomplete([text])], [`${RECORD}.decisions[0].inference.sub_job.capability_id`, (text) => withValue([...SUB_JOB, 'capability_id'], text)],
    ];
    for (const [where, record] of places) {
      for (const text of ['\u212AO-1', 'SO-\u212A', 'x\u212Ay']) {
        const result = parse(record(text));
        expectRefused(result, where);
        expect(!result.ok && result.detail).not.toContain('\u212A');
      }
      expect(parse(record('KO-1')).ok, where).toBe(true);
    }
  });

  it('refuses a key of a decision that is not in the NFC form, because a receipt is signed with the keys that it has', () => {
    const receipt = JSON.parse('{"e\\u0301":1}') as Json;
    expectRefused(parse(withValue([...SUB_JOB, 'receipt'], receipt)), `${RECORD}.decisions[0].inference.sub_job.receipt`);
    expect(parse(withValue([...SUB_JOB, 'receipt'], { '\u00e9': 1 })).ok).toBe(true);
  });
});

describe('a value that is not plain JSON data', () => {
  const PLACES: ReadonlyArray<readonly [string, readonly Step[], string]> = [
    ['the record', [], 'schema'], ['the sender', ['sender'], 'did'], ['the approval', ['approval'], 'valid_until'], ['the attestations', ['attestations'], 'provenance'], ['the checks', ['checks'], 'advert'],
    ['a decision', DECISION, 'name'], ['an inference', INFERENCE, 'accepted'], ['a sub-job', SUB_JOB, 'capability_id'], ['a receipt', [...SUB_JOB, 'receipt'], 'model'],
    ['a verification', VERIFICATION, 'fields_match'], ['a choice', [...DECISION, 'choice'], 'complete'],
  ];

  it.each(PLACES)('refuses a member of %s that is an accessor, and never runs the getter', (_place, path, member) => {
    const { input, reads } = withGetter(golden('intake-record'), path, member);
    expectRefused(parse(input), member);
    expect(reads()).toBe(0);
    expect(parse(golden('intake-record')).ok).toBe(true);
  });

  it.each(PLACES)('refuses the key __proto__ in %s, with a value that looks right', (_place, path) => {
    expectRefused(parse(withProtoKey(golden('intake-record'), path)), '__proto__');
  });

  it('refuses an accessor in the list of missing requirements, and never runs the getter', () => {
    const input = incomplete(['R3']);
    let reads = 0;
    Object.defineProperty(listAt(input, ['missing']), 0, { get() { reads += 1; return 'R3'; }, enumerable: true, configurable: true });
    expectRefused(parse(input), `${RECORD}.missing[0]`);
    expect(reads).toBe(0);
  });

  it('refuses a list of missing requirements with a hole, with a member that is not an index, and of another kind', () => {
    const sparse = incomplete(['R1', 'R2']);
    delete listAt(sparse, ['missing'])[0];
    expectRefused(parse(sparse), `${RECORD}.missing[0]`);
    const named = incomplete(['R1']);
    Object.defineProperty(listAt(named, ['missing']), 'extra', { value: 1, enumerable: true, configurable: true });
    expectRefused(parse(named), `${RECORD}.missing`);
    class Missing extends Array<unknown> {}
    const other = incomplete(['R1']);
    other.missing = Missing.from(listAt(other, ['missing']));
    expectRefused(parse(other), `${RECORD}.missing`);
  });

  it('refuses a key that is not a string, a key that is not enumerable, and a value that JSON cannot hold', () => {
    expectRefused(parse({ ...golden('intake-record'), [Symbol('x')]: 1 }), RECORD);
    const hidden = golden('intake-record');
    Object.defineProperty(hidden, 'extra', { value: 1, enumerable: false, configurable: true });
    expectRefused(parse(hidden), RECORD);
    expectRefused(parse({ ...golden('intake-record'), status: undefined }), 'status');
    expectRefused(parse({ ...golden('intake-record'), missing: [10n] }), 'missing');
  });

  it('refuses a Proxy that throws and a Proxy that was revoked, and never throws', () => {
    const throws = new Proxy(golden('intake-record'), { ownKeys() { throw new Error('the Proxy refuses'); } });
    expect(() => parse(throws)).not.toThrow();
    expectRefused(parse(throws), RECORD);
    const { proxy, revoke } = Proxy.revocable(golden('intake-record'), {});
    revoke();
    expect(() => parse(proxy)).not.toThrow();
    expectRefused(parse(proxy), RECORD);
  });

  it('refuses a value that is not an object, and an object of another kind', () => {
    class IntakeRecordLike { schema = INTAKE_RECORD_SCHEMA; }
    for (const value of [undefined, null, 1, 'record', true, [], [golden('intake-record')], new IntakeRecordLike(), new Date(0), () => golden('intake-record')]) expectRefused(parse(value), RECORD);
  });

  it('takes an object with no prototype, and it gives a plain object', () => {
    const bare = Object.assign(Object.create(null) as Json, golden('intake-record'));
    const record = must(parse(bare));
    expect(record).toStrictEqual(golden('intake-record'));
    expect(Object.getPrototypeOf(record)).toBe(Object.prototype);
    expect(Object.getPrototypeOf(record.decisions)).toBe(Array.prototype);
    expect(Object.getPrototypeOf(record.missing)).toBe(Array.prototype);
  });
});

describe('a prototype that was changed', () => {
  const PLAIN = parse(golden('intake-record'));
  const PLAIN_INCOMPLETE = parse(incomplete(['R3', 'R4']));

  it.each([
    ['status on Object.prototype', Object.prototype, 'status'], ['missing on Object.prototype', Object.prototype, 'missing'], ['provenance on Object.prototype', Object.prototype, 'provenance'],
    ['advert on Object.prototype', Object.prototype, 'advert'], ['name on Object.prototype', Object.prototype, 'name'], ['the index 0 on Array.prototype', Array.prototype, '0'],
    ['the index 0 on Object.prototype', Object.prototype, '0'],
  ] as const)('with a setter for %s, the result is the result of the plain twin, and no setter runs', (_what, target, key) => {
    let calls = 0;
    const complete = golden('intake-record');
    const partial = incomplete(['R3', 'R4']);
    const seen = withPrototype(target, { [key]: { set() { calls += 1; } } }, () => [parse(complete), parse(partial)]);
    expect(seen).toStrictEqual([PLAIN, PLAIN_INCOMPLETE]);
    expect(calls).toBe(0);
  });

  it('reads no member that a prototype holds: a record with no own member is refused, although the prototype holds every member', () => {
    const inherited = Object.fromEntries(Object.entries(golden('intake-record')).map(([name, value]) => [name, { value, writable: true, enumerable: true }]));
    const input = withValue(['sender'], undefined);
    expect(withPrototype(Object.prototype, inherited, () => parse({})).ok).toBe(false);
    expectRefused(withPrototype(Object.prototype, { sender: inherited.sender! }, () => parse(input)), 'sender');
  });
});

describe('the exports of the folder', () => {
  it('include the names of the intake record', () => {
    for (const name of ['ATTESTATION_STATES', 'INTAKE_CHECKS', 'INTAKE_RECORD_SCHEMA', 'INTAKE_STATUSES', 'parseIntakeRecord']) expect(Object.keys(folder), name).toContain(name);
  });

  it('include no part parser: they stay inside the folder', () => {
    const names = ['parseOrganisation', 'parseSender', 'parseEnd', 'parseApproval', 'parseChecks', 'parseVerification', 'parseSubJob', 'parseInference', 'parseDecision', 'parseDecisions'];
    for (const name of names) expect(Object.keys(folder), name).not.toContain(name);
  });
});
