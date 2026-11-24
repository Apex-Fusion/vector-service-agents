// agents/sourcing-agent/test/model/intake.test.ts
// The fields of a `propose` request of the Sourcing Agent: the request for quotation and the four weights, and no other member. Each refusal has an accepted twin, and no detail repeats the value that failed.
import { describe, expect, test } from 'vitest';
import { parseRequest } from '@vsa/usecase-kit/protocol';
import { parseProposeFields } from '../../src/model/index.ts';
import { MARKER, RFQ, WEIGHTS, expectNames, golden, must, refusal } from './support.ts';

const fields = (): Record<string, unknown> => golden('propose-fields.json');
const rfqOf = (input: Record<string, unknown>): Record<string, unknown> => input.rfq as Record<string, unknown>;
const itemsOf = (input: Record<string, unknown>): Record<string, unknown>[] => rfqOf(input).items as Record<string, unknown>[];

describe('parseProposeFields: the golden fields', () => {
  test('accepts them and returns a new object with the two checked members', () => {
    const input = fields();
    const value = must(parseProposeFields(input));
    expect(value).toStrictEqual({ rfq: RFQ, weights: WEIGHTS });
    expect(value).not.toBe(input);
    expect(Object.keys(value)).toStrictEqual(['rfq', 'weights']);
  });

  test('is the fields parser of a propose request: parseRequest keeps the base members and the two fields', () => {
    const request = must(parseRequest(golden('propose-request.json'), parseProposeFields));
    expect(request).toStrictEqual({
      op: 'propose',
      authority: { principal_did: `did:vector:${'1f'.repeat(32)}`, delegation: '9b'.repeat(32) },
      tenant: 'run1',
      rfq: RFQ,
      weights: WEIGHTS,
    });
  });

  test('a propose request with a fifth member is refused through parseRequest, and the same request without it passes', () => {
    expect(parseRequest(golden('propose-request.json'), parseProposeFields).ok).toBe(true);
    const { code, detail } = refusal(parseRequest({ ...golden('propose-request.json'), vault: `${'ab'.repeat(32)}#0` }, parseProposeFields));
    expect(code).toBe('bad_shape');
    expectNames(detail, 'vault');
  });

  test('a propose request of the Reorder Agent is refused: its fields are not the fields of this agent', () => {
    const { code, detail } = refusal(parseRequest({ ...golden('propose-request.json'), sku: 'GLV-NIT-M' }, parseProposeFields));
    expect(code).toBe('bad_shape');
    expectNames(detail, 'sku');
  });
});

describe('parseProposeFields: the members', () => {
  test.each(['rfq', 'weights'])('refuses a request with no %s', (name) => {
    const input = fields();
    delete input[name];
    const { code, detail } = refusal(parseProposeFields(input));
    expect(code).toBe('bad_shape');
    expectNames(detail, name);
  });

  test.each(['vault', 'sku', 'supplier_did', 'tenant', 'op', 'authority', 'proposal', 'bidders', 'invite'])('refuses the extra member %s', (name) => {
    const { code, detail } = refusal(parseProposeFields({ ...fields(), [name]: 'x' }));
    expect(code).toBe('bad_shape');
    expectNames(detail, name);
  });

  test('refuses the key __proto__ that JSON.parse makes, as a member that is not allowed', () => {
    const text = JSON.stringify(fields());
    const input = JSON.parse(`${text.slice(0, -1)},"__proto__":{"rfq":{}}}`) as Record<string, unknown>;
    const { code, detail } = refusal(parseProposeFields(input));
    expect(code).toBe('bad_shape');
    expectNames(detail, '__proto__');
  });

  test.each([
    ['null', null],
    ['a list', []],
    ['a text', 'rfq'],
    ['a number', 5],
  ])('refuses %s in place of the fields', (_name, input) => {
    expect(refusal(parseProposeFields(input as never)).code).toBe('bad_shape');
  });
});

describe('parseProposeFields: the request for quotation', () => {
  test.each([
    ['a request that is not an object', (input: Record<string, unknown>) => { input.rfq = 'run1-rfq-1'; }],
    ['a request with no rfq_id', (input: Record<string, unknown>) => { delete rfqOf(input).rfq_id; }],
    ['a request with no items', (input: Record<string, unknown>) => { delete rfqOf(input).items; }],
    ['a request with no needed_by', (input: Record<string, unknown>) => { delete rfqOf(input).needed_by; }],
    ['a request with an extra member', (input: Record<string, unknown>) => { rfqOf(input).note = 'urgent'; }],
    ['an rfq_id with a slash', (input: Record<string, unknown>) => { rfqOf(input).rfq_id = 'run1/rfq'; }],
    ['an empty rfq_id', (input: Record<string, unknown>) => { rfqOf(input).rfq_id = ''; }],
    ['an rfq_id of 65 characters', (input: Record<string, unknown>) => { rfqOf(input).rfq_id = 'r'.repeat(65); }],
    ['an empty list of items', (input: Record<string, unknown>) => { rfqOf(input).items = []; }],
    ['items that are not a list', (input: Record<string, unknown>) => { rfqOf(input).items = 'GLV-NIT-M'; }],
    ['a SKU in two items', (input: Record<string, unknown>) => { itemsOf(input)[1]!.sku = itemsOf(input)[0]!.sku; }],
    ['a SKU with a space', (input: Record<string, unknown>) => { itemsOf(input)[0]!.sku = 'GLV NIT'; }],
    ['a quantity of 0', (input: Record<string, unknown>) => { itemsOf(input)[0]!.quantity = 0; }],
    ['a quantity above 1,000,000', (input: Record<string, unknown>) => { itemsOf(input)[0]!.quantity = 1_000_001; }],
    ['a quantity with a fraction', (input: Record<string, unknown>) => { itemsOf(input)[0]!.quantity = 2.5; }],
    ['a quantity that is a text', (input: Record<string, unknown>) => { itemsOf(input)[0]!.quantity = '100'; }],
    ['a date that does not exist', (input: Record<string, unknown>) => { rfqOf(input).needed_by = '2026-02-30'; }],
    ['a date with a time', (input: Record<string, unknown>) => { rfqOf(input).needed_by = '2026-12-20T00:00:00Z'; }],
    ['the marker in place of the rfq_id', (input: Record<string, unknown>) => { rfqOf(input).rfq_id = MARKER; }],
  ])('refuses %s', (_name, change) => {
    const input = fields();
    change(input);
    const { code, detail } = refusal(parseProposeFields(input));
    expect(code).toBe('bad_shape');
    expectNames(detail, 'request.rfq');
  });

  test('refuses 21 items and accepts 20, and accepts the edges of the limits', () => {
    const many = (count: number): Record<string, unknown> => {
      const input = fields();
      rfqOf(input).items = Array.from({ length: count }, (_, index) => ({ sku: `SKU-${index + 1}`, quantity: 1 }));
      return input;
    };
    expect(must(parseProposeFields(many(20))).rfq.items).toHaveLength(20);
    expect(refusal(parseProposeFields(many(21))).code).toBe('bad_shape');
    const edges = fields();
    rfqOf(edges).rfq_id = 'r'.repeat(64);
    itemsOf(edges)[0]!.quantity = 1_000_000;
    itemsOf(edges)[1]!.quantity = 1;
    expect(must(parseProposeFields(edges)).rfq.items.map((item) => item.quantity)).toStrictEqual([1_000_000, 1, 40]);
  });
});

describe('parseProposeFields: the weights', () => {
  test.each([
    ['weights that sum to more than 1', { price: 0.5, lead_time: 0.2, reliability: 0.2, compliance: 0.2 }],
    ['weights that sum to less than 1', { price: 0.3, lead_time: 0.2, reliability: 0.2, compliance: 0.2 }],
    ['a weight below 0', { price: -0.1, lead_time: 0.4, reliability: 0.4, compliance: 0.3 }],
    ['a weight above 1', { price: 1.5, lead_time: -0.5, reliability: 0, compliance: 0 }],
    ['a weight with 5 decimal places', { price: 0.40001, lead_time: 0.19999, reliability: 0.2, compliance: 0.2 }],
    ['a weight that is a text', { price: '0.4', lead_time: 0.2, reliability: 0.2, compliance: 0.2 }],
    ['a weight that is null', { price: null, lead_time: 0.4, reliability: 0.3, compliance: 0.3 }],
    ['no compliance weight', { price: 0.4, lead_time: 0.3, reliability: 0.3 }],
    ['a fifth weight', { price: 0.4, lead_time: 0.2, reliability: 0.2, compliance: 0.2, speed: 0 }],
    ['weights that are a list', [0.4, 0.2, 0.2, 0.2]],
    ['weights that are a text', '0.4'],
  ])('refuses %s', (_name, weights) => {
    const { code, detail } = refusal(parseProposeFields({ ...fields(), weights }));
    expect(code).toBe('bad_shape');
    expectNames(detail, 'request.weights');
  });

  test.each([
    ['four equal weights', { price: 0.25, lead_time: 0.25, reliability: 0.25, compliance: 0.25 }],
    ['weights with 4 decimal places that sum to 1', { price: 0.3333, lead_time: 0.3333, reliability: 0.3333, compliance: 0.0001 }],
    ['one weight of 1', { price: 1, lead_time: 0, reliability: 0, compliance: 0 }],
    ['weights that a sum of floats would not accept', { price: 0.3, lead_time: 0.3, reliability: 0.3, compliance: 0.1 }],
  ])('accepts %s', (_name, weights) => {
    expect(must(parseProposeFields({ ...fields(), weights })).weights).toStrictEqual(weights);
  });
});

describe('parseProposeFields: values that change between two reads', () => {
  test('refuses a getter and never runs it', () => {
    let reads = 0;
    const input = fields();
    Object.defineProperty(input, 'weights', { enumerable: true, get: () => { reads += 1; return fields().weights; } });
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
    itemsOf(input)[0]!.quantity = 999;
    (input.weights as Record<string, unknown>).price = 0.9;
    expect(value.rfq.items[0]!.quantity).toBe(100);
    expect(value.weights.price).toBe(0.4);
  });
});
