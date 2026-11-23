// agents/reorder-agent/test/model/intake.test.ts
// The fields of a `propose` request of the Reorder Agent: the SKU and the supplier, and no other member. Each refusal has an accepted twin, and no detail repeats the value that failed.
import { describe, expect, test } from 'vitest';
import { parseRequest } from '@vsa/usecase-kit/protocol';
import { parseProposeFields } from '../../src/model/index.ts';
import { MARKER, expectNames, golden, must, refusal } from './support.ts';

const fields = (): Record<string, unknown> => golden('propose-fields.json');
const DID = 'did:vector:d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5';

describe('parseProposeFields: the golden fields', () => {
  test('accepts them and returns a new object with the two members', () => {
    const input = fields();
    const value = must(parseProposeFields(input));
    expect(value).toStrictEqual({ sku: 'GLV-NIT-M', supplier_did: DID });
    expect(value).not.toBe(input);
  });

  test('is the fields parser of a propose request: parseRequest keeps the base members and the two fields', () => {
    const request = must(parseRequest(golden('propose-request.json'), parseProposeFields));
    expect(request).toStrictEqual({
      op: 'propose',
      authority: { principal_did: 'did:vector:1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f', delegation: '9b'.repeat(32) },
      tenant: 'run1',
      sku: 'GLV-NIT-M',
      supplier_did: DID,
    });
  });

  test('a propose request with a third field is refused through parseRequest', () => {
    const { code, detail } = refusal(parseRequest({ ...golden('propose-request.json'), vault: `${'ab'.repeat(32)}#0` }, parseProposeFields));
    expect(code).toBe('bad_shape');
    expectNames(detail, 'vault');
  });
});

describe('parseProposeFields: the members', () => {
  test.each(['sku', 'supplier_did'])('refuses a request with no %s', (name) => {
    const input = fields();
    delete input[name];
    const { code, detail } = refusal(parseProposeFields(input));
    expect(code).toBe('bad_shape');
    expectNames(detail, name);
  });

  test.each(['vault', 'lot', 'quantity', 'tenant', 'op', 'authority', 'proposal'])('refuses the extra member %s', (name) => {
    const { code, detail } = refusal(parseProposeFields({ ...fields(), [name]: 'x' }));
    expect(code).toBe('bad_shape');
    expectNames(detail, name);
  });

  test('refuses the key __proto__ that JSON.parse makes, as a member that is not allowed', () => {
    const input = JSON.parse(`{"sku":"GLV-NIT-M","supplier_did":"${DID}","__proto__":{"sku":"A"}}`) as Record<string, unknown>;
    const { detail } = refusal(parseProposeFields(input));
    expectNames(detail, '__proto__');
  });

  test.each([
    ['null', null],
    ['a list', []],
    ['a text', 'sku'],
    ['a number', 5],
  ])('refuses %s in place of the fields', (_name, input) => {
    expect(refusal(parseProposeFields(input as never)).code).toBe('bad_shape');
  });
});

describe('parseProposeFields: the SKU', () => {
  test.each([
    ['a SKU of 64 characters', 'A'.repeat(64)],
    ['a SKU of 1 character', '7'],
    ['a SKU with a dot, a hyphen and an underscore', 'A.b-c_9'],
    ['a SKU that starts with a digit', '9-LIVE'],
  ])('accepts %s', (_name, sku) => {
    expect(must(parseProposeFields({ ...fields(), sku })).sku).toBe(sku);
  });

  test.each([
    ['a SKU of 65 characters', 'A'.repeat(65)],
    ['an empty SKU', ''],
    ['a SKU with a slash', 'GLV/NIT'],
    ['a SKU with a space', 'GLV NIT'],
    ['a SKU that starts with a hyphen', '-GLV'],
    ['a SKU that starts with a dot', '.GLV'],
    ['a SKU that starts with an underscore', '_GLV'],
    ['a SKU with a line break at the end', 'GLV\n'],
    ['a SKU with a letter that is not ASCII', 'GLV-\u00c9'],
    ['a SKU with the marker', MARKER],
    ['a SKU that is a number', 12],
    ['a SKU that is null', null],
  ])('refuses %s', (_name, sku) => {
    const { code, detail } = refusal(parseProposeFields({ ...fields(), sku }));
    expect(code).toBe('bad_shape');
    expectNames(detail, 'request.sku');
  });
});

describe('parseProposeFields: the supplier', () => {
  test('accepts a DID of 64 lower-case hex characters', () => {
    expect(must(parseProposeFields({ ...fields(), supplier_did: `did:vector:${'0a'.repeat(32)}` })).supplier_did).toBe(`did:vector:${'0a'.repeat(32)}`);
  });

  test.each([
    ['a DID with upper-case hex', `did:vector:${'D5'.repeat(32)}`],
    ['a DID of 63 hex characters', `did:vector:${'d5'.repeat(31)}d`],
    ['a DID of 65 hex characters', `did:vector:${'d5'.repeat(32)}d`],
    ['a DID of another method', `did:web:${'d5'.repeat(32)}`],
    ['the hex with no prefix', 'd5'.repeat(32)],
    ['a DID with a line break at the end', `${DID}\n`],
    ['a DID with the marker', MARKER],
    ['a DID that is a number', 5],
    ['no value', undefined],
  ])('refuses %s', (_name, supplier) => {
    const { code, detail } = refusal(parseProposeFields({ ...fields(), supplier_did: supplier }));
    expect(code).toBe('bad_shape');
    expectNames(detail, 'request.supplier_did');
  });
});

describe('parseProposeFields: values that change between two reads', () => {
  test('refuses a getter and never runs it', () => {
    let reads = 0;
    const input = fields();
    Object.defineProperty(input, 'sku', { enumerable: true, get: () => { reads += 1; return 'GLV-NIT-M'; } });
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
    input.sku = 'CHANGED';
    expect(value.sku).toBe('GLV-NIT-M');
  });
});
