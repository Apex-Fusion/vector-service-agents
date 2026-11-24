// agents/prior-authorization-agent/test/model/intake.test.ts
// The fields of a `propose` request of the Prior Authorization Agent: the order and the insurer, and no other member. Each refusal has an accepted twin, and no detail repeats the value that failed.
import { describe, expect, test } from 'vitest';
import { parseRequest } from '@vsa/usecase-kit/protocol';
import { parseProposeFields } from '../../src/model/index.ts';
import { MARKER, expectNames, golden, must, refusal } from './support.ts';

const fields = (): Record<string, unknown> => golden('propose-fields.json');
const INSURER = `did:vector:${'b8'.repeat(32)}`;

describe('parseProposeFields: the golden fields', () => {
  test('accepts them and returns a new object with the two members', () => {
    const input = fields();
    const value = must(parseProposeFields(input));
    expect(value).toStrictEqual({ order_id: 'ORD-1001', insurer_did: INSURER });
    expect(value).not.toBe(input);
  });

  test('is the fields parser of a propose request: parseRequest keeps the base members and the two fields', () => {
    const request = must(parseRequest(golden('propose-request.json'), parseProposeFields));
    expect(request).toStrictEqual({
      op: 'propose',
      authority: { principal_did: 'did:vector:1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f', delegation: '9b'.repeat(32) },
      tenant: 'run1',
      order_id: 'ORD-1001',
      insurer_did: INSURER,
    });
  });

  test('a propose request with a vault member is refused through parseRequest: the authority is the only proof of the hirer', () => {
    const { code, detail } = refusal(parseRequest({ ...golden('propose-request.json'), vault: `${'ab'.repeat(32)}#0` }, parseProposeFields));
    expect(code).toBe('bad_shape');
    expectNames(detail, 'vault');
  });
});

describe('parseProposeFields: the members', () => {
  test.each(['order_id', 'insurer_did'])('refuses a request with no %s', (name) => {
    const input = fields();
    delete input[name];
    const { code, detail } = refusal(parseProposeFields(input));
    expect(code).toBe('bad_shape');
    expectNames(detail, name);
  });

  test.each([
    'vault', 'patient_ref', 'ordering_clinician_ref', 'service_code', 'justification', 'guideline_refs', 'record_refs', 'record_set_sha256', 'advert_ref', 'sku', 'supplier_did', 'tenant', 'op', 'authority',
    'proposal',
  ])('refuses the extra member %s', (name) => {
    const { code, detail } = refusal(parseProposeFields({ ...fields(), [name]: 'x' }));
    expect(code).toBe('bad_shape');
    expectNames(detail, name);
  });

  test('refuses the key __proto__ that JSON.parse makes, as a member that is not allowed', () => {
    const input = JSON.parse(`{"order_id":"ORD-1001","insurer_did":"${INSURER}","__proto__":{"order_id":"A"}}`) as Record<string, unknown>;
    const { detail } = refusal(parseProposeFields(input));
    expectNames(detail, '__proto__');
  });

  test.each([
    ['null', null],
    ['a list', []],
    ['a text', 'order_id'],
    ['a number', 5],
  ])('refuses %s in place of the fields', (_name, input) => {
    expect(refusal(parseProposeFields(input as never)).code).toBe('bad_shape');
  });
});

describe('parseProposeFields: the order id', () => {
  test.each([
    ['an order id of 64 characters', 'A'.repeat(64)],
    ['an order id of 1 character', '7'],
    ['an order id with a dot, a hyphen and an underscore', 'A.b-c_9'],
    ['an order id that starts with a digit', '9-LIVE'],
  ])('accepts %s', (_name, orderId) => {
    expect(must(parseProposeFields({ ...fields(), order_id: orderId })).order_id).toBe(orderId);
  });

  test.each([
    ['an order id of 65 characters', 'A'.repeat(65)],
    ['an empty order id', ''],
    ['an order id with a slash', 'ORD/1001'],
    ['an order id with a space', 'ORD 1001'],
    ['an order id with a hash sign', 'ORD#1001'],
    ['an order id with a dot dot', '../ORD-1001'],
    ['an order id that starts with a hyphen', '-ORD'],
    ['an order id that starts with a dot', '.ORD'],
    ['an order id that starts with an underscore', '_ORD'],
    ['an order id with a line break at the end', 'ORD-1001\n'],
    ['an order id with a letter that is not ASCII', 'ORD-\u00c9'],
    ['an order id with the Kelvin sign, which NFC writes as the letter K', 'ORD-\u212a'],
    ['an order id with the marker', MARKER],
    ['an order id that is a number', 1001],
    ['an order id that is null', null],
    ['an order id that is a list', ['ORD-1001']],
  ])('refuses %s', (_name, orderId) => {
    const { code, detail } = refusal(parseProposeFields({ ...fields(), order_id: orderId }));
    expect(code).toBe('bad_shape');
    expectNames(detail, 'request.order_id');
  });
});

describe('parseProposeFields: the insurer', () => {
  test('accepts a DID of 64 lower-case hex characters', () => {
    expect(must(parseProposeFields({ ...fields(), insurer_did: `did:vector:${'0a'.repeat(32)}` })).insurer_did).toBe(`did:vector:${'0a'.repeat(32)}`);
  });

  test.each([
    ['a DID with upper-case hex', `did:vector:${'B8'.repeat(32)}`],
    ['a DID of 63 hex characters', `did:vector:${'b8'.repeat(31)}b`],
    ['a DID of 65 hex characters', `did:vector:${'b8'.repeat(32)}b`],
    ['a DID of another method', `did:web:${'b8'.repeat(32)}`],
    ['the hex with no prefix', 'b8'.repeat(32)],
    ['a DID with a line break at the end', `${INSURER}\n`],
    ['a DID with the marker', MARKER],
    ['a DID that is a number', 5],
    ['a DID that is a list', [INSURER]],
    ['no value', undefined],
  ])('refuses %s', (_name, insurer) => {
    const { code, detail } = refusal(parseProposeFields({ ...fields(), insurer_did: insurer }));
    expect(code).toBe('bad_shape');
    expectNames(detail, 'request.insurer_did');
  });
});

describe('parseProposeFields: values that change between two reads', () => {
  test('refuses a getter and never runs it', () => {
    let reads = 0;
    const input = fields();
    Object.defineProperty(input, 'order_id', { enumerable: true, get: () => { reads += 1; return 'ORD-1001'; } });
    const { code, detail } = refusal(parseProposeFields(input));
    expect(code).toBe('bad_shape');
    expectNames(detail, 'accessor');
    expect(reads).toBe(0);
  });

  test('refuses a Proxy that throws when it is read, and never throws itself', () => {
    const hostile = new Proxy(fields(), { ownKeys: () => { throw new Error('the keys cannot be read'); } });
    expect(refusal(parseProposeFields(hostile)).code).toBe('bad_shape');
  });

  test('works on a copy: a change of the input after the call does not change the result', () => {
    const input = fields();
    const value = must(parseProposeFields(input));
    input.order_id = 'CHANGED';
    expect(value.order_id).toBe('ORD-1001');
  });
});
