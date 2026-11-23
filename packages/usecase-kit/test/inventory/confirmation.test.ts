// packages/usecase-kit/test/inventory/confirmation.test.ts: the order confirmation that the Order Desk returns and the Reorder Agent reads. The golden file is the example. The list of the checks is written
// out in the folder, and a drift test holds its first 12 names to the shared checks of the checks folder. Each refusal has an accepted twin.
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { SHARED_CHECK_NAMES } from '@vsa/usecase-kit/checks';
import { RECEIPT_CHECKS, canonicalSha256 } from '@vsa/usecase-kit/protocol';
import { CONFIRMATION_CHECKS, CONFIRMATION_SCHEMA, LOT_NAMES, parseOrderConfirmation as parse, parsePurchaseOrder } from '@vsa/usecase-kit/inventory';
import type { OrderConfirmation } from '@vsa/usecase-kit/inventory';
import { MARKER, change, expectRefused, golden, goldenText, listAt, must, objectAt, withPrototype } from './support.ts';
import type { Json } from './support.ts';

/** The SHA-256 of the bytes of the golden file. A change of the file shows here. */
const GOLDEN_FILE_SHA256 = '0dd97b4bce89c77264cbaee7a4fbc2b146691d4173ea3d68da1bf4e24318bf73';

const MEMBERS = ['schema', 'outcome', 'po_number', 'po_sha256', 'sku', 'lot', 'quantity', 'ship_by', 'order_id', 'sender', 'approval', 'checks', 'decisions', 'fault_mode'] as const;
const HEX = 'ab'.repeat(32);
const DID = `did:vector:${HEX}`;
/** The path of the first decision, and of its sub-job. */
const DECISION = ['decisions', 0] as const;
const SUB_JOB = [...DECISION, 'inference', 'sub_job'] as const;

const NOT_TEXT = [1, 0, true, null, {}, [], ['a']];
const nest = (levels: number): unknown => Array.from({ length: levels }).reduce<unknown>((inner) => ({ a: inner }), 1);

describe('the checks of a confirmation', () => {
  it('are 16, in the order that they run: the 12 shared checks of an order desk, and then the four checks of the Order Desk', () => {
    expect(CONFIRMATION_CHECKS).toHaveLength(16);
    expect(CONFIRMATION_CHECKS.slice(0, 12)).toStrictEqual([...SHARED_CHECK_NAMES['order-desk']]);
    expect(CONFIRMATION_CHECKS.slice(12)).toStrictEqual(['for_this_supplier', 'lot', 'quantity', 'not_duplicate']);
    expect(new Set(CONFIRMATION_CHECKS).size).toBe(16);
  });

  it('holds the check of the vault payment after the two checks of the delegation, and before the approval', () => {
    expect(CONFIRMATION_CHECKS.slice(3, 8)).toStrictEqual(['delegation', 'delegation_usable', 'vault_paid', 'approval_found', 'approval_type']);
  });
});

describe('the golden confirmation', () => {
  it('is the file that the hash names, and it holds the members in their order, with the 16 checks', () => {
    expect(createHash('sha256').update(goldenText('confirmation')).digest('hex')).toBe(GOLDEN_FILE_SHA256);
    const input = golden('confirmation');
    expect(Object.keys(input)).toStrictEqual([...MEMBERS]);
    expect(Object.keys(objectAt(input, ['checks']))).toStrictEqual([...CONFIRMATION_CHECKS]);
    expect(CONFIRMATION_SCHEMA).toBe('vector.usecase.order-confirmation.v1');
    expect(input.schema).toBe(CONFIRMATION_SCHEMA);
  });

  it('passes the parser, and the copy holds the same members in the same order', () => {
    const result = parse(golden('confirmation'));
    expect(result).toStrictEqual({ ok: true, value: golden('confirmation') });
    const confirmation = must(result);
    expect(Object.keys(confirmation)).toStrictEqual([...MEMBERS]);
    expect(Object.keys(confirmation.sender)).toStrictEqual(['did', 'organisation', 'organisation_verified']);
    expect(Object.keys(confirmation.approval)).toStrictEqual(['attestation', 'issuer_did', 'valid_until']);
    expect(Object.keys(confirmation.checks)).toStrictEqual([...CONFIRMATION_CHECKS]);
    expect(Object.values(confirmation.checks)).toStrictEqual(CONFIRMATION_CHECKS.map(() => true));
  });

  it('answers the golden purchase order: it names its number, its SKU, its lot and its quantity, and the canonical hash of the order', () => {
    const order = must(parsePurchaseOrder(golden('po')));
    const confirmation = must(parse(golden('confirmation')));
    expect(confirmation.po_sha256).toBe(must(canonicalSha256(order)));
    for (const name of ['po_number', 'sku', 'lot', 'quantity'] as const) expect(confirmation[name], name).toBe(order[name]);
  });

  it('gives a copy that shares no object with the input, and changes nothing of the input', () => {
    const input = golden('confirmation');
    const before = JSON.stringify(input);
    const confirmation = must(parse(input));
    expect(JSON.stringify(input)).toBe(before);
    expect(confirmation).not.toBe(input);
    expect(confirmation.sender).not.toBe(input.sender);
    expect(confirmation.approval).not.toBe(input.approval);
    expect(confirmation.checks).not.toBe(input.checks);
    expect(confirmation.decisions).not.toBe(input.decisions);
    expect(confirmation.decisions[0]).not.toBe(objectAt(input, DECISION));
    expect(confirmation.decisions[0]!.inference.sub_job.receipt).not.toBe(objectAt(input, [...SUB_JOB, 'receipt']));
  });

  it('can be written as a typed value: the copy is an OrderConfirmation', () => {
    const confirmation: OrderConfirmation = must(parse(golden('confirmation')));
    expect(confirmation.outcome).toBe('done');
    expect(LOT_NAMES).toContain(confirmation.lot);
    expect(confirmation.decisions[0]!.inference.path).toBe('marketplace');
  });
});

describe('a member that is missing or is not listed', () => {
  it.each(MEMBERS)('refuses a confirmation with no member %s', (name) => {
    expectRefused(parse(change(golden('confirmation'), [name], undefined)), name);
  });

  it.each([
    ['the confirmation', []], ['the sender', ['sender']], ['the approval', ['approval']], ['a decision', DECISION], ['the inference of a decision', [...DECISION, 'inference']], ['a sub-job', SUB_JOB],
    ['the verification of a sub-job', [...SUB_JOB, 'verification']],
  ])('refuses a member that is not listed in %s, and the twin without it passes', (_what, path) => {
    expectRefused(parse(change(golden('confirmation'), [...path, 'extra'], 1)), 'extra');
    expect(parse(golden('confirmation')).ok).toBe(true);
  });

  it.each([
    ['sender', ['did', 'organisation', 'organisation_verified']], ['approval', ['attestation', 'issuer_did', 'valid_until']],
  ])('refuses the %s without one of its members', (parent, names) => {
    for (const name of names) expectRefused(parse(change(golden('confirmation'), [parent, name], undefined)), name);
  });

  it.each(['name', 'choice', 'reasoning', 'inference'])('refuses a decision with no member %s', (name) => {
    expectRefused(parse(change(golden('confirmation'), [...DECISION, name], undefined)), name);
  });

  it.each(['path', 'sub_job', 'accepted'])('refuses an inference with no member %s', (name) => {
    expectRefused(parse(change(golden('confirmation'), [...DECISION, 'inference', name], undefined)), name);
  });

  it.each(['capability_id', 'advert_ref', 'escrow_ref', 'supplier_pkh', 'receipt', 'receipt_signature', 'verification'])('refuses a sub-job with no member %s', (name) => {
    expectRefused(parse(change(golden('confirmation'), [...SUB_JOB, name], undefined)), name);
  });

  it.each(RECEIPT_CHECKS)('refuses a verification with no check %s', (name) => {
    expectRefused(parse(change(golden('confirmation'), [...SUB_JOB, 'verification', name], undefined)), name);
  });

  it('refuses the members that belong to a purchase order or to a result of the Reorder Agent', () => {
    for (const name of ['needed_by', 'supplier_did', 'advert_ref', 'tenant', 'handoff', 'exit_state', 'reason']) expectRefused(parse({ ...golden('confirmation'), [name]: HEX }), name);
  });
});

describe('the sixteen checks', () => {
  const checksOf = (checks: unknown): Json => change(golden('confirmation'), ['checks'], checks);
  const all = (): Record<string, unknown> => Object.fromEntries(CONFIRMATION_CHECKS.map((name) => [name, true]));

  it.each(CONFIRMATION_CHECKS)('refuses a confirmation with 15 checks, without %s', (name) => {
    expectRefused(parse(change(golden('confirmation'), ['checks', name], undefined)), name);
  });

  it('refuses the 15 names of the checks that had no payment check', () => {
    const fifteen = { ...all() };
    delete fifteen.vault_paid;
    expectRefused(parse(checksOf(fifteen)), 'vault_paid');
  });

  it('refuses 17 checks: a name that is not listed, whatever its value, and a name of another kind of agent', () => {
    for (const name of ['not_a_check', 'quote_price', 'approval_digest_mismatch', 'duplicate_po', 'Lot', 'lot ', 'constructor', 'toString']) {
      for (const value of [true, false, null, 1]) expectRefused(parse(checksOf({ ...all(), [name]: value })), name);
    }
  });

  it('refuses a name that is not listed in the place of a listed name, and the same value that is listed passes', () => {
    const swapped = Object.fromEntries(CONFIRMATION_CHECKS.map((name) => [name === 'lot' ? 'lots' : name, true]));
    expectRefused(parse(checksOf(swapped)), 'lot');
    expect(parse(checksOf(all())).ok).toBe(true);
  });

  it.each(CONFIRMATION_CHECKS)('refuses the check %s with the value false', (name) => {
    expectRefused(parse(change(golden('confirmation'), ['checks', name], false)), `confirmation.checks.${name}`);
  });

  it.each([['the text true', 'true'], ['the number 1', 1], ['null', null], ['the empty list', []], ['an object', { ok: true }], ['the text of the marker', MARKER], ['0', 0], ['false', false]])(
    'refuses a check with the value %s',
    (_what, value) => {
      for (const name of CONFIRMATION_CHECKS) expectRefused(parse(change(golden('confirmation'), ['checks', name], value)), `confirmation.checks.${name}`);
    },
  );

  it.each([['a list', []], ['a list of the names', [...CONFIRMATION_CHECKS]], ['a text', 'checks'], ['null', null], ['a number', 16], ['an object with no member', {}]])('refuses checks that are %s', (_what, checks) => {
    expectRefused(parse(checksOf(checks)), 'confirmation.checks');
  });

  it('keeps the order of the list in the copy, whatever the order of the input', () => {
    const reversed = Object.fromEntries([...CONFIRMATION_CHECKS].reverse().map((name) => [name, true]));
    expect(Object.keys(must(parse(checksOf(reversed))).checks)).toStrictEqual([...CONFIRMATION_CHECKS]);
  });
});

describe('the outcome and the schema', () => {
  it.each([
    ['failed', 'failed'], ['completed', 'completed'], ['in capital letters', 'DONE'], ['with a space', 'done '], ['with a line break', 'done\n'], ['the empty text', ''], ['null', null], ['true', true],
    ['a list', ['done']], ['the marker', MARKER],
  ])('refuses the outcome %s, and takes done', (_what, outcome) => {
    expectRefused(parse(change(golden('confirmation'), ['outcome'], outcome)), 'confirmation.outcome');
    expect(must(parse(change(golden('confirmation'), ['outcome'], 'done'))).outcome).toBe('done');
  });

  it.each([
    ['another version', 'vector.usecase.order-confirmation.v2'], ['capital letters', 'VECTOR.USECASE.ORDER-CONFIRMATION.V1'], ['the schema of the order', 'vector.usecase.po.v1'], ['a number', 1], ['null', null],
    ['the marker', MARKER], ['a space at the end', 'vector.usecase.order-confirmation.v1 '],
  ])('refuses a schema that is %s', (_what, schema) => {
    expectRefused(parse(change(golden('confirmation'), ['schema'], schema)), 'confirmation.schema');
  });
});

describe('the members of the order', () => {
  const FORMS: ReadonlyArray<readonly [string, readonly unknown[], readonly unknown[]]> = [
    ['po_number', ['', 'a'.repeat(65), '-1', 'a b', 'a/b', 'a\n', MARKER, ...NOT_TEXT], ['a', 'run1-1', 'a'.repeat(64)]],
    ['po_sha256', [HEX.slice(2), `${HEX}ab`, HEX.toUpperCase(), `${HEX}\n`, '', MARKER, ...NOT_TEXT], [HEX, '0'.repeat(64)]],
    ['sku', ['', 'A'.repeat(65), 'A B', 'A#B', 'A\n', '-A', 'e\u0301', MARKER, ...NOT_TEXT], ['A', 'GLV-NIT-M', 'A'.repeat(64)]],
    ['lot', ['lot-huge', 'LOT-SMALL', 'lot-small ', 'small', '', 'constructor', MARKER, ...NOT_TEXT], [...LOT_NAMES]],
    ['quantity', [0, -1, 1_000_001, 1.5, '50', null, true, [], {}, MARKER], [1, 50, 1_000_000]],
    ['ship_by', ['2026-02-30', '2026-13-01', '2026-12-00', '2026-1-1', '20261128', '2026-11-28T00:00:00Z', ' 2026-11-28', '2026-11-28\n', 'soon', '', 20261128, MARKER, ...NOT_TEXT], ['2026-11-28', '2028-02-29']],
    ['order_id', ['', 'a'.repeat(65), 'SO 1', 'SO/1', 'SO#1', 'SO-1\n', '-SO', MARKER, ...NOT_TEXT], ['SO-run1-0001', 'a', 'A'.repeat(64)]],
  ];

  it.each(FORMS)('%s: refuses each value that is not in its form, and takes the values that are', (name, bad, good) => {
    for (const value of bad) {
      const result = parse(change(golden('confirmation'), [name], value));
      expect(result.ok, `${name} ${JSON.stringify(value)}`).toBe(false);
      expectRefused(result, `confirmation.${name}`);
    }
    for (const value of good) expect(parse(change(golden('confirmation'), [name], value)).ok, `${name} ${JSON.stringify(value)}`).toBe(true);
  });

  it('takes a quantity that is not the size of any lot: the confirmation is a record, and the Reorder Agent compares it with the order', () => {
    expect(parse(change(golden('confirmation'), ['quantity'], 7)).ok).toBe(true);
  });
});

describe('the sender', () => {
  it.each([
    ['a DID with a short id', `did:vector:${HEX.slice(2)}`], ['a DID with a long id', `did:vector:${HEX}ab`], ['a DID in capital letters', `did:vector:${HEX.toUpperCase()}`], ['no prefix', HEX],
    ['another prefix', `did:other:${HEX}`], ['the empty text', ''], ['null', null], ['a number', 1], ['the marker', MARKER],
  ])('refuses %s as the DID', (_what, did) => {
    expectRefused(parse(change(golden('confirmation'), ['sender', 'did'], did)), 'confirmation.sender.did');
    expect(parse(change(golden('confirmation'), ['sender', 'did'], DID)).ok).toBe(true);
  });

  it.each([
    ['the text true', 'true'], ['the text false', 'false'], ['the number 1', 1], ['the number 0', 0], ['null', null], ['a list', [true]], ['an object', {}], ['the marker', MARKER],
  ])('refuses %s as organisation_verified, and takes true and false', (_what, value) => {
    expectRefused(parse(change(golden('confirmation'), ['sender', 'organisation_verified'], value)), 'confirmation.sender.organisation_verified');
    expect(parse(change(golden('confirmation'), ['sender', 'organisation_verified'], true)).ok).toBe(true);
    expect(must(parse(change(golden('confirmation'), ['sender', 'organisation_verified'], false))).sender.organisation_verified).toBe(false);
  });

  it('takes the organisation as null, which the checks give when no party names one', () => {
    expect(must(parse(change(golden('confirmation'), ['sender', 'organisation'], null))).sender.organisation).toBeNull();
  });

  it('takes any text of at most 1024 characters as the organisation, because the shared sender check takes any text from the record of the sender', () => {
    const texts = [
      'echo.example', 'a', 'Operator Echo (demo)', 'caf\u00e9.example', '\u4e2d\u6587.example', '', ' ', '\u00a0', 'echo\u200d.example', 'a'.repeat(254), 'a'.repeat(1024), ' echo.example ',
      'echo\nexample', 'echo\texample', 'echo\u0001.example', 'echo\u2028example', MARKER,
    ];
    for (const text of texts) expect(must(parse(change(golden('confirmation'), ['sender', 'organisation'], text))).sender.organisation, JSON.stringify(text)).toBe(text);
  });

  it.each([['1025 characters', 'a'.repeat(1025)], ['2000 characters', 'a'.repeat(2000)], ['a number', 1], ['true', true], ['a list', ['echo.example']], ['an object', {}]])('refuses %s as the organisation', (_what, organisation) => {
    const result = parse(change(golden('confirmation'), ['sender', 'organisation'], organisation));
    expectRefused(result, 'confirmation.sender.organisation');
    expect(!result.ok && result.detail).not.toContain('aaaa');
  });

  it.each([['a list', []], ['a text', 'sender'], ['null', null], ['a number', 1]])('refuses a sender that is %s', (_what, sender) => {
    expectRefused(parse(change(golden('confirmation'), ['sender'], sender)), 'confirmation.sender');
  });
});

describe('the approval', () => {
  it.each([
    ['a short id', HEX.slice(2)], ['a long id', `${HEX}ab`], ['capital letters', HEX.toUpperCase()], ['a DID', DID], ['the empty text', ''], ['null', null], ['a number', 1], ['the marker', MARKER],
  ])('refuses %s as the attestation', (_what, attestation) => {
    expectRefused(parse(change(golden('confirmation'), ['approval', 'attestation'], attestation)), 'confirmation.approval.attestation');
    expect(parse(change(golden('confirmation'), ['approval', 'attestation'], HEX)).ok).toBe(true);
  });

  it('takes an issuer that has a record, and null for an issuer that is a key with no record', () => {
    expect(must(parse(golden('confirmation'))).approval.issuer_did).toBe(`did:vector:${'1f'.repeat(32)}`);
    expect(must(parse(change(golden('confirmation'), ['approval', 'issuer_did'], null))).approval.issuer_did).toBeNull();
  });

  it.each([
    ['a short id', `did:vector:${HEX.slice(2)}`], ['capital letters', `did:vector:${HEX.toUpperCase()}`], ['no prefix', HEX], ['the empty text', ''], ['a number', 1], ['true', true], ['the marker', MARKER],
  ])('refuses %s as the issuer', (_what, issuer) => {
    expectRefused(parse(change(golden('confirmation'), ['approval', 'issuer_did'], issuer)), 'confirmation.approval.issuer_did');
  });

  it.each([
    ['a time with milliseconds', '2026-11-24T10:00:00.000Z', true], ['a time with 123 milliseconds', '2026-11-24T10:00:00.123Z', true], ['the last day of a leap year', '2028-12-31T23:59:59.999Z', true],
    ['no end', null, true],
    ['the year 10000, in the extended form', '+010000-01-01T00:00:00.000Z', true], ['a year before 0, in the extended form', '-000001-01-01T00:00:00.000Z', true],
    ['the last time that a date holds', '+275760-09-13T00:00:00.000Z', true],
    ['a time with no milliseconds', '2026-11-24T10:00:00Z', false], ['a time with one digit of milliseconds', '2026-11-24T10:00:00.1Z', false],
    ['a time with an offset', '2026-11-24T10:00:00.000+00:00', false], ['a time in local form', '2026-11-24T10:00:00.000', false], ['a date', '2026-11-24', false],
    ['a lower case letter', '2026-11-24t10:00:00.000z', false], ['a day that does not exist', '2026-02-30T00:00:00.000Z', false], ['a month that does not exist', '2026-13-01T00:00:00.000Z', false],
    ['an hour that does not exist', '2026-11-24T24:00:00.000Z', false], ['a minute that does not exist', '2026-11-24T10:60:00.000Z', false], ['a space at the end', '2026-11-24T10:00:00.000Z ', false],
    ['a line break', '2026-11-24T10:00:00.000Z\n', false], ['milliseconds since 1970', 1_795_000_000_000, false], ['the text of milliseconds', '1795000000000', false], ['the empty text', '', false],
    ['a year of five digits with a sign', '+10000-01-01T00:00:00.000Z', false], ['a year of six digits with no sign', '010000-01-01T00:00:00.000Z', false],
    ['a year of seven digits with a sign', '+0100000-01-01T00:00:00.000Z', false], ['the year 0 with a minus sign', '-000000-01-01T00:00:00.000Z', false],
    ['a millisecond after the last time that a date holds', '+275760-09-13T00:00:00.001Z', false], ['the extended form with no milliseconds', '+010000-01-01T00:00:00Z', false],
    ['the extended form of a day that does not exist', '+010000-02-30T00:00:00.000Z', false],
    ['true', true, false], ['a list', [], false], ['an object', {}, false], ['the marker', MARKER, false],
  ])('valid_until: %s', (_what, value, passes) => {
    const result = parse(change(golden('confirmation'), ['approval', 'valid_until'], value));
    if (passes) expect(must(result).approval.valid_until).toBe(value);
    else expectRefused(result, 'confirmation.approval.valid_until');
  });

  it('takes the text that toISOString writes for a time of any year that a date holds, with the year of four digits or the extended form', () => {
    const years = [-271820, -1, 0, 99, 100, 999, 1000, 9999, 10000, 275760];
    for (const year of years) {
      const time = new Date(0);
      time.setUTCFullYear(year, 5, 17);
      time.setUTCMilliseconds(123);
      const text = time.toISOString();
      expect(must(parse(change(golden('confirmation'), ['approval', 'valid_until'], text))).approval.valid_until, text).toBe(text);
    }
    expect(new Date(Date.UTC(2026, 10, 24, 10)).toISOString()).toBe('2026-11-24T10:00:00.000Z');
  });

  it.each([['a list', []], ['a text', 'approval'], ['null', null], ['a number', 1]])('refuses an approval that is %s', (_what, approval) => {
    expectRefused(parse(change(golden('confirmation'), ['approval'], approval)), 'confirmation.approval');
  });
});

describe('the decisions', () => {
  it.each([['an object', {}], ['a text', 'decisions'], ['null', null], ['a number', 1], ['an object with an index', { 0: {} }]])('refuses decisions that are %s', (_what, decisions) => {
    expectRefused(parse(change(golden('confirmation'), ['decisions'], decisions)), 'confirmation.decisions');
  });

  it.each([['a text', 'decision'], ['null', null], ['a number', 1], ['a list', []], ['a list of decisions', [{}]], ['true', true]])('refuses a decision that is %s', (_what, decision) => {
    expectRefused(parse(change(golden('confirmation'), ['decisions', 0], decision)), 'confirmation.decisions[0]');
  });

  it('takes exactly one decision, the decision named availability, with the empty setting and with a fault value', () => {
    for (const setting of ['', 'confirm_wrong_lot']) {
      const confirmation = must(parse(change(golden('confirmation'), ['fault_mode'], setting)));
      expect(confirmation.decisions.map((decision) => decision.name)).toStrictEqual(['availability']);
    }
  });

  it('refuses no decision, with the empty setting and with a fault value, and names the list', () => {
    for (const setting of ['', 'confirm_wrong_lot']) {
      const none = change(change(golden('confirmation'), ['decisions'], []), ['fault_mode'], setting);
      expectRefused(parse(none), 'confirmation.decisions');
    }
  });

  it('refuses two decisions: two of the same name, one of this name and one of another name in each order, and two of other names', () => {
    const decision = objectAt(golden('confirmation'), DECISION);
    const named = (name: string): Json => ({ ...decision, name });
    for (const names of [['availability', 'availability'], ['availability', 'accept_delivery'], ['accept_delivery', 'availability'], ['reorder', 'accept_delivery']]) {
      expectRefused(parse(change(golden('confirmation'), ['decisions'], names.map(named))), 'confirmation.decisions');
    }
    expect(parse(change(golden('confirmation'), ['decisions'], [named('availability')])).ok).toBe(true);
  });

  it('refuses one decision of another name, and names the member', () => {
    const others = ['accept_delivery', 'reorder', 'availabilty', 'availability_2', 'Availability', 'availability ', ' availability', 'availability\n', 'a', '', MARKER, ...NOT_TEXT];
    for (const name of others) expectRefused(parse(change(golden('confirmation'), [...DECISION, 'name'], name)), 'confirmation.decisions[0].name');
    expect(parse(change(golden('confirmation'), [...DECISION, 'name'], 'availability')).ok).toBe(true);
  });

  it('refuses a reasoning that is blank or is not a text, and takes any other text', () => {
    for (const value of ['', ' ', '\n\t ', ...NOT_TEXT]) expectRefused(parse(change(golden('confirmation'), [...DECISION, 'reasoning'], value)), 'confirmation.decisions[0].reasoning');
    for (const value of ['The catalogue shows enough boxes.', ' padded ', 'caf\u00e9']) expect(parse(change(golden('confirmation'), [...DECISION, 'reasoning'], value)).ok, value).toBe(true);
  });

  it('takes any JSON as the choice, and keeps it as the model gave it', () => {
    for (const choice of [null, true, 0, 1.5, 'text', [], [1, 'a', null], {}, { confirm: false, ship_by: 'never', note: '' }, { nested: { deep: [{ a: 1 }] } }]) {
      expect(must(parse(change(golden('confirmation'), [...DECISION, 'choice'], choice))).decisions[0]!.choice, JSON.stringify(choice)).toStrictEqual(choice);
    }
  });

  it('refuses a choice that JSON cannot hold, and a choice that is nested too deep', () => {
    for (const choice of [Number.NaN, Number.POSITIVE_INFINITY, () => 1, 1n, Symbol('x')]) expectRefused(parse(change(golden('confirmation'), [...DECISION, 'choice'], choice)), 'confirmation.decisions[0]');
    expectRefused(parse(change(golden('confirmation'), [...DECISION, 'choice'], nest(40))), 'confirmation');
    expect(parse(change(golden('confirmation'), [...DECISION, 'choice'], nest(20))).ok).toBe(true);
  });

  it.each([
    ['path', ['api', 'Marketplace', 'marketplace ', '', MARKER, ...NOT_TEXT], ['marketplace']],
    ['accepted', ['no', 'Confirmed', 'confirmed ', 'pending\n', '', true, null, 1, MARKER], ['confirmed', 'pending']],
  ])('inference %s: refuses each value that is not listed, and takes the values that are', (name, bad, good) => {
    for (const value of bad) expectRefused(parse(change(golden('confirmation'), [...DECISION, 'inference', name], value)), `confirmation.decisions[0].inference.${name}`);
    for (const value of good) expect(parse(change(golden('confirmation'), [...DECISION, 'inference', name], value)).ok, String(value)).toBe(true);
  });

  it.each([
    ['capability_id', ['', 'a'.repeat(65), 'llm text', 'llm/text', '-llm', MARKER, ...NOT_TEXT], ['llm.text.generate.v1', 'a', 'A'.repeat(64)]],
    ['advert_ref', [HEX, `${HEX}#`, `${HEX}#01`, `${HEX.slice(2)}#0`, `${HEX}#0\n`, '', MARKER, ...NOT_TEXT], [`${HEX}#0`, `${HEX}#12`]],
    ['escrow_ref', [HEX, `${HEX}#-1`, `${HEX.toUpperCase()}#0`, '', MARKER, ...NOT_TEXT], [`${HEX}#0`]],
    ['supplier_pkh', [HEX.slice(10), HEX, HEX.slice(8).toUpperCase(), `${HEX.slice(8)}\n`, '', MARKER, ...NOT_TEXT], [HEX.slice(8)]],
    ['receipt_signature', ['', 'a b', 'a\nb', 'a'.repeat(1025), MARKER, ...NOT_TEXT], ['8e'.repeat(64), 'abc', 'base64+/=', 'a'.repeat(1024)]],
  ])('sub-job %s: refuses each value that is not in its form, and takes the values that are', (name, bad, good) => {
    for (const value of bad) expectRefused(parse(change(golden('confirmation'), [...SUB_JOB, name], value)), `confirmation.decisions[0].inference.sub_job.${name}`);
    for (const value of good) expect(parse(change(golden('confirmation'), [...SUB_JOB, name], value)).ok, String(value)).toBe(true);
  });

  it.each([['a list', []], ['a text', '{}'], ['null', null], ['a number', 1], ['true', true]])('refuses a receipt that is %s, and takes an object with any members', (_what, receipt) => {
    expectRefused(parse(change(golden('confirmation'), [...SUB_JOB, 'receipt'], receipt)), 'confirmation.decisions[0].inference.sub_job.receipt');
    expect(parse(change(golden('confirmation'), [...SUB_JOB, 'receipt'], {})).ok).toBe(true);
    expect(parse(change(golden('confirmation'), [...SUB_JOB, 'receipt'], { anything: [1, { a: null }], 'another key': 'x' })).ok).toBe(true);
  });

  it.each(RECEIPT_CHECKS)('refuses the receipt check %s that is not a boolean, and takes true and false', (name) => {
    for (const value of ['true', 1, 0, null, [], {}, MARKER]) expectRefused(parse(change(golden('confirmation'), [...SUB_JOB, 'verification', name], value)), `verification.${name}`);
    for (const value of [true, false]) expect(must(parse(change(golden('confirmation'), [...SUB_JOB, 'verification', name], value))).decisions[0]!.inference.sub_job.verification[name]).toBe(value);
  });

  it('keeps the members of a sub-job in the order of the protocol, and the receipt checks in their order', () => {
    const subJob = must(parse(golden('confirmation'))).decisions[0]!.inference.sub_job;
    expect(Object.keys(subJob)).toStrictEqual(['capability_id', 'advert_ref', 'escrow_ref', 'supplier_pkh', 'receipt', 'receipt_signature', 'verification']);
    expect(Object.keys(subJob.verification)).toStrictEqual([...RECEIPT_CHECKS]);
    expect(Object.keys(must(parse(golden('confirmation'))).decisions[0]!)).toStrictEqual(['name', 'choice', 'reasoning', 'inference']);
    expect(Object.keys(must(parse(golden('confirmation'))).decisions[0]!.inference)).toStrictEqual(['path', 'sub_job', 'accepted']);
  });

  it('refuses a verification that is not an object', () => {
    for (const value of [[], 'checks', null, 1, true]) expectRefused(parse(change(golden('confirmation'), [...SUB_JOB, 'verification'], value)), 'verification');
  });
});

describe('the fault setting', () => {
  it('takes the empty text and the one fault value of the Order Desk', () => {
    expect(must(parse(change(golden('confirmation'), ['fault_mode'], ''))).fault_mode).toBe('');
    expect(must(parse(change(golden('confirmation'), ['fault_mode'], 'confirm_wrong_lot'))).fault_mode).toBe('confirm_wrong_lot');
  });

  it.each([
    ['a value of another agent', 'invert_scores'], ['a value of another agent', 'alter_after_approval'], ['a value of another agent', 'quote_off_price_list'], ['capital letters', 'CONFIRM_WRONG_LOT'],
    ['a space at the start', ' confirm_wrong_lot'], ['a space at the end', 'confirm_wrong_lot '], ['a line break', 'confirm_wrong_lot\n'], ['a space', ' '], ['a name of the prototype', 'constructor'],
    ['null', null], ['a number', 0], ['false', false], ['a list', []], ['the marker', MARKER],
  ])('refuses %s as the fault setting, and takes the twins', (_what, value) => {
    expectRefused(parse(change(golden('confirmation'), ['fault_mode'], value)), 'confirmation.fault_mode');
  });
});

describe('the Unicode form of a text', () => {
  it('writes the organisation in the NFC form, and keeps the texts of the decision as they came', () => {
    const decision = [...DECISION] as const;
    let sample = change(golden('confirmation'), ['sender', 'organisation'], 'cafe\u0301.example');
    sample = change(sample, [...decision, 'reasoning'], 'cafe\u0301 is open');
    sample = change(sample, [...SUB_JOB, 'receipt', 'model'], 'cafe\u0301');
    sample = change(sample, [...decision, 'choice', 'note'], 'cafe\u0301');
    const confirmation = must(parse(sample));
    expect(confirmation.sender.organisation).toBe('caf\u00e9.example');
    expect(confirmation.decisions[0]!.reasoning).toBe('cafe\u0301 is open');
    expect(confirmation.decisions[0]!.inference.sub_job.receipt).toMatchObject({ model: 'cafe\u0301' });
    expect(confirmation.decisions[0]!.choice).toMatchObject({ note: 'cafe\u0301' });
  });

  it('checks each identifier as it is written: the Kelvin sign is refused, although NFC turns it into the letter K, and the twin with the letter K passes', () => {
    // The Kelvin sign (U+212A) is not an ASCII letter. The order store refuses it, and so does this parser.
    const places: ReadonlyArray<readonly [string, readonly (string | number)[]]> = [
      ['confirmation.po_number', ['po_number']], ['confirmation.sku', ['sku']], ['confirmation.order_id', ['order_id']],
      ['confirmation.decisions[0].inference.sub_job.capability_id', [...SUB_JOB, 'capability_id']],
    ];
    for (const [where, path] of places) {
      for (const text of ['\u212AO-1', 'SO-\u212A', 'x\u212Ay']) {
        const result = parse(change(golden('confirmation'), path, text));
        expectRefused(result, where);
        expect(!result.ok && result.detail).not.toContain('\u212A');
      }
      expect(parse(change(golden('confirmation'), path, 'KO-1')).ok, where).toBe(true);
    }
  });

  it('takes a text that is in the NFC form as it is', () => {
    expect(must(parse(change(golden('confirmation'), ['sender', 'organisation'], 'caf\u00e9.example'))).sender.organisation).toBe('caf\u00e9.example');
  });

  it('refuses a key of a decision that is not in the NFC form, because a receipt is signed with the keys that it has', () => {
    const receipt = JSON.parse('{"e\\u0301":1}') as Json;
    expectRefused(parse(change(golden('confirmation'), [...SUB_JOB, 'receipt'], receipt)), 'confirmation.decisions[0].inference.sub_job.receipt');
    expect(parse(change(golden('confirmation'), [...SUB_JOB, 'receipt'], { '\u00e9': 1 })).ok).toBe(true);
  });
});

describe('a value that is not plain JSON data', () => {
  const PLACES: ReadonlyArray<readonly [string, readonly (string | number)[], string]> = [
    ['the confirmation', [], 'schema'], ['the sender', ['sender'], 'did'], ['the approval', ['approval'], 'valid_until'], ['the checks', ['checks'], 'lot'], ['a decision', DECISION, 'name'],
    ['an inference', [...DECISION, 'inference'], 'accepted'], ['a sub-job', SUB_JOB, 'capability_id'], ['a receipt', [...SUB_JOB, 'receipt'], 'model'], ['a verification', [...SUB_JOB, 'verification'], 'fields_match'],
    ['a choice', [...DECISION, 'choice'], 'note'],
  ];

  it.each(PLACES)('refuses a member of %s that is an accessor, and never runs the getter', (_place, path, member) => {
    let reads = 0;
    const input = golden('confirmation');
    const holder = objectAt(input, path);
    const value = holder[member];
    Object.defineProperty(holder, member, { get() { reads += 1; return value; }, enumerable: true, configurable: true });
    expectRefused(parse(input), member);
    expect(reads).toBe(0);
    expect(parse(golden('confirmation')).ok).toBe(true);
  });

  it.each(PLACES)('refuses the key __proto__ in %s, with a value that looks right', (_place, path) => {
    const input = golden('confirmation');
    Object.defineProperty(objectAt(input, path), '__proto__', { value: { x: 1 }, enumerable: true, configurable: true, writable: true });
    expectRefused(parse(input), '__proto__');
  });

  it('refuses an accessor in a list of decisions', () => {
    const input = golden('confirmation');
    const decisions = listAt(input, ['decisions']);
    const first = decisions[0];
    let reads = 0;
    Object.defineProperty(decisions, 0, { get() { reads += 1; return first; }, enumerable: true, configurable: true });
    expectRefused(parse(input), 'confirmation.decisions[0]');
    expect(reads).toBe(0);
  });

  it('refuses a list of decisions with a hole, with a member that is not an index, and of another kind', () => {
    const sparse = change(golden('confirmation'), ['decisions', 1], objectAt(golden('confirmation'), DECISION));
    delete listAt(sparse, ['decisions'])[0];
    expectRefused(parse(sparse), 'confirmation.decisions[0]');
    const named = golden('confirmation');
    Object.defineProperty(listAt(named, ['decisions']), 'extra', { value: 1, enumerable: true, configurable: true });
    expectRefused(parse(named), 'confirmation.decisions');
    class Decisions extends Array<unknown> {}
    const other = golden('confirmation');
    other.decisions = Decisions.from(listAt(other, ['decisions']));
    expectRefused(parse(other), 'confirmation.decisions');
  });

  it('refuses a key that is not a string, a key that is not enumerable, and a value that JSON cannot hold', () => {
    expectRefused(parse({ ...golden('confirmation'), [Symbol('x')]: 1 }), 'confirmation');
    const hidden = golden('confirmation');
    Object.defineProperty(hidden, 'extra', { value: 1, enumerable: false, configurable: true });
    expectRefused(parse(hidden), 'confirmation');
    expectRefused(parse({ ...golden('confirmation'), quantity: undefined }), 'quantity');
    expectRefused(parse({ ...golden('confirmation'), quantity: 10n }), 'quantity');
  });

  it('refuses a Proxy that throws and a Proxy that was revoked, and never throws', () => {
    const throws = new Proxy(golden('confirmation'), { ownKeys() { throw new Error('the Proxy refuses'); } });
    expect(() => parse(throws)).not.toThrow();
    expectRefused(parse(throws), 'confirmation');
    const { proxy, revoke } = Proxy.revocable(golden('confirmation'), {});
    revoke();
    expect(() => parse(proxy)).not.toThrow();
    expectRefused(parse(proxy), 'confirmation');
  });

  it('refuses a value that is not an object, and an object of another kind', () => {
    class Confirmation { schema = CONFIRMATION_SCHEMA; }
    for (const value of [undefined, null, 1, 'confirmation', true, [], [golden('confirmation')], new Confirmation(), new Date(0), () => golden('confirmation')]) expectRefused(parse(value), 'confirmation');
  });

  it('takes an object with no prototype, and it gives a plain object', () => {
    const bare = Object.assign(Object.create(null) as Json, golden('confirmation'));
    const confirmation = must(parse(bare));
    expect(confirmation).toStrictEqual(golden('confirmation'));
    expect(Object.getPrototypeOf(confirmation)).toBe(Object.prototype);
    expect(Object.getPrototypeOf(confirmation.decisions)).toBe(Array.prototype);
  });
});

describe('a prototype that was changed', () => {
  const PLAIN = parse(golden('confirmation'));

  it.each([
    ['lot on Object.prototype', Object.prototype, 'lot'], ['sku on Object.prototype', Object.prototype, 'sku'], ['checks on Object.prototype', Object.prototype, 'checks'],
    ['name on Object.prototype', Object.prototype, 'name'], ['the index 0 on Array.prototype', Array.prototype, '0'], ['the index 0 on Object.prototype', Object.prototype, '0'],
  ] as const)('with a setter for %s, the result is the result of the plain twin, and no setter runs', (_what, target, key) => {
    let calls = 0;
    const input = golden('confirmation');
    const seen = withPrototype(target, { [key]: { set() { calls += 1; } } }, () => parse(input));
    expect(seen).toStrictEqual(PLAIN);
    expect(calls).toBe(0);
  });

  it('reads no member that a prototype holds: a confirmation with no own member is refused, although the prototype holds every member', () => {
    const inherited = Object.fromEntries(Object.entries(golden('confirmation')).map(([name, value]) => [name, { value, writable: true, enumerable: true }]));
    const input = change(golden('confirmation'), ['sender'], undefined);
    expect(withPrototype(Object.prototype, inherited, () => parse({})).ok).toBe(false);
    expectRefused(withPrototype(Object.prototype, { sender: inherited.sender! }, () => parse(input)), 'sender');
  });
});
