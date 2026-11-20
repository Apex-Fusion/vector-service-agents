// The synthetic seed of a tenant. The default data passes its own reader and fits the three use cases. A part that a seed names replaces the default part as a whole. A part that is not
// well formed, a name that is not a part, a wrong type and a key that two entries share are errors that name their path.
import { describe, expect, it } from 'vitest';
import { LOT_NAMES, SEED_PARTS, defaultSeed, parseSeed } from '../src/seed.ts';
import type { Seed } from '../src/seed.ts';
import { Invalid } from '../src/validate.ts';

const problem = (input: unknown): string => {
  try {
    parseSeed('seed', input);
  } catch (error) {
    expect(error).toBeInstanceOf(Invalid);
    return (error as Invalid).message;
  }
  throw new Error('the seed was accepted');
};

describe('the default seed', () => {
  it('passes the reader that a seed from outside passes, and the reader gives it back unchanged', () => {
    const seed = defaultSeed();
    expect(parseSeed('seed', JSON.parse(JSON.stringify(seed)))).toEqual(seed);
  });
  it('is a new object at each call, so that a tenant that changes its copy changes no other', () => {
    const first = defaultSeed();
    first.erp[0]!.on_hand = 1;
    first.vendors.length = 0;
    expect(defaultSeed().erp[0]!.on_hand).toBe(60);
    expect(defaultSeed().vendors).toHaveLength(3);
  });
  it('has the parts that the three use cases read, each with entries', () => {
    const seed = defaultSeed();
    for (const part of SEED_PARTS) expect(seed[part].length, part).toBeGreaterThan(0);
  });
  it('fits use case 1: one item below its threshold and one above it, in both the ERP and the catalogue, and a large lot that the supplier cannot fill for one item', () => {
    const seed = defaultSeed();
    const below = seed.erp.filter((reading) => reading.on_hand < reading.threshold);
    const above = seed.erp.filter((reading) => reading.on_hand >= reading.threshold);
    expect(below.length).toBeGreaterThan(0);
    expect(above.length).toBeGreaterThan(0);
    expect(seed.catalogue.map((c) => c.sku).sort()).toEqual(seed.erp.map((r) => r.sku).sort());
    for (const entry of seed.catalogue) {
      const [small, medium, large] = LOT_NAMES.map((lot) => entry.lot_sizes[lot]) as [number, number, number];
      expect(small < medium && medium < large, entry.sku).toBe(true);
    }
    expect(seed.catalogue.some((entry) => entry.lot_sizes['lot-large'] > entry.available)).toBe(true);
    expect(seed.catalogue.some((entry) => entry.lot_sizes['lot-large'] <= entry.available)).toBe(true);
  });
  it('fits use case 2: each clinical order has a guideline and a set of requirements for its service code, and one order meets more of its guideline than the other', () => {
    const seed = defaultSeed();
    for (const set of seed.records) {
      expect(seed.guidelines.some((g) => g.code === set.order.service_code), set.order.order_id).toBe(true);
      expect(seed.requirements.some((r) => r.service_code === set.order.service_code), set.order.order_id).toBe(true);
    }
    const [lumbar, knee] = seed.records;
    expect(lumbar!.records.length).toBeGreaterThan(knee!.records.length);
  });
  it('fits use case 3: the three vendors are three organisations, and they differ in how well they deliver', () => {
    const { vendors } = defaultSeed();
    expect(new Set(vendors.map((v) => v.organisation)).size).toBe(3);
    const rates = vendors.map((v) => v.on_time_delivery_rate);
    expect(Math.max(...rates)).toBeGreaterThan(Math.min(...rates));
  });
  it('holds no real person and no credential', () => {
    const text = JSON.stringify(defaultSeed());
    expect(text).not.toMatch(/password|secret|PRIV_KEY|ed25519_sk|recovery phrase/i);
    for (const set of defaultSeed().records) expect(set.order.patient_ref).toMatch(/^SYN-PT-/);
  });
});

describe('parseSeed', () => {
  it('gives the default data for a seed that names nothing, and for no seed', () => {
    expect(parseSeed('seed', undefined)).toEqual(defaultSeed());
    expect(parseSeed('seed', {})).toEqual(defaultSeed());
  });
  it('replaces the parts that it names as a whole and keeps the others', () => {
    const erp = [{ sku: 'ONE', on_hand: 5, threshold: 100, daily_usage: 40, lead_time_days: 10, open_orders: 0 }];
    const seed: Seed = parseSeed('seed', { erp });
    expect(seed.erp).toEqual(erp);
    expect(seed.catalogue).toEqual(defaultSeed().catalogue);
    expect(seed.vendors).toEqual(defaultSeed().vendors);
  });
  it('refuses a name that is not a part: a typo must not leave the default data in place', () => {
    expect(problem({ stock: [] })).toBe('seed.stock is not a field of this object');
    expect(problem({ erp: defaultSeed().erp, Vendors: [] })).toBe('seed.Vendors is not a field of this object');
  });
  it('refuses a seed that is no object', () => {
    for (const bad of [null, [], 'seed', 4, true]) expect(problem(bad)).toBe('seed must be a JSON object');
  });
  it('refuses a part that is no list, an empty list and a key that two entries share', () => {
    expect(problem({ erp: {} })).toBe('seed.erp must be a list');
    expect(problem({ erp: [] })).toBe('seed.erp must have 1 to 200 items');
    const reading = defaultSeed().erp[0]!;
    expect(problem({ erp: [reading, reading] })).toBe(`seed.erp has the sku ${reading.sku} two times`);
    const set = defaultSeed().records[0]!;
    expect(problem({ records: [set, set] })).toBe(`seed.records has the order_id ${set.order.order_id} two times`);
    const vendor = defaultSeed().vendors[0]!;
    expect(problem({ vendors: [vendor, { ...vendor, organisation: 'other.example.org' }] })).toBe(`seed.vendors has the vendor_id ${vendor.vendor_id} two times`);
  });
  it('names the path of a value of the wrong type, and never keeps a text for a number or a text for a flag', () => {
    const reading = defaultSeed().erp[0]!;
    expect(problem({ erp: [{ ...reading, on_hand: '60' }] })).toBe('seed.erp[0].on_hand must be a whole number from 0 to 10000000');
    expect(problem({ erp: [{ ...reading, on_hand: 6.5 }] })).toBe('seed.erp[0].on_hand must be a whole number from 0 to 10000000');
    expect(problem({ erp: [{ ...reading, daily_usage: null }] })).toBe('seed.erp[0].daily_usage must be a number from 0 to 10000000');
    const entry = defaultSeed().catalogue[0]!;
    expect(problem({ catalogue: [{ ...entry, discontinued: 'false' }] })).toBe('seed.catalogue[0].discontinued must be true or false');
    expect(problem({ catalogue: [{ ...entry, discontinued: 0 }] })).toBe('seed.catalogue[0].discontinued must be true or false');
    expect(problem({ catalogue: [{ ...entry, lot_sizes: { ...entry.lot_sizes, 'lot-medium': '50' } }] })).toBe('seed.catalogue[0].lot_sizes.lot-medium must be a whole number from 1 to 1000000');
    expect(problem({ catalogue: [{ ...entry, lot_sizes: { 'lot-small': 1, 'lot-medium': 2 } }] })).toBe('seed.catalogue[0].lot_sizes.lot-large is required');
    expect(problem({ catalogue: [{ ...entry, lot_sizes: { ...entry.lot_sizes, 'lot-huge': 9 } }] })).toBe('seed.catalogue[0].lot_sizes.lot-huge is not a field of this object');
    const vendor = defaultSeed().vendors[0]!;
    expect(problem({ vendors: [{ ...vendor, on_time_delivery_rate: 97 }] })).toBe('seed.vendors[0].on_time_delivery_rate must be a number from 0 to 1');
    expect(problem({ vendors: [{ ...vendor, organisation: 'Alfa' }] })).toMatch(/^seed\.vendors\[0\]\.organisation must be a domain name/);
    expect(problem({ vendors: [{ ...vendor, last_audit: '2026-02-30' }] })).toBe('seed.vendors[0].last_audit must be a date that exists');
  });
  it('refuses a field that is not named in an entry, and a missing field', () => {
    const reading = defaultSeed().erp[0]!;
    expect(problem({ erp: [{ ...reading, price: 3 }] })).toBe('seed.erp[0].price is not a field of this object');
    const { open_orders: _open, ...short } = reading;
    expect(problem({ erp: [short] })).toBe('seed.erp[0].open_orders is required');
  });
  it('reads the clinical orders with their records, the guidelines and the requirements', () => {
    const set = defaultSeed().records[0]!;
    expect(problem({ records: [{ ...set, records: [] }] })).toBe('seed.records[0].records must have 1 to 50 items');
    expect(problem({ records: [{ ...set, records: [set.records[0], set.records[0]] }] })).toBe(`seed.records[0].records has the record_id ${set.records[0]!.record_id} two times`);
    expect(problem({ records: [{ ...set, order: { ...set.order, diagnosis_codes: [] } }] })).toBe('seed.records[0].order.diagnosis_codes must have 1 to 8 items');
    const guideline = defaultSeed().guidelines[0]!;
    expect(problem({ guidelines: [{ ...guideline, criteria: [guideline.criteria[0], guideline.criteria[0]] }] })).toBe('seed.guidelines[0].criteria has the id C1 two times');
    const requirements = defaultSeed().requirements[0]!;
    expect(problem({ requirements: [{ ...requirements, requirements: [{ id: 'R1' }] }] })).toBe('seed.requirements[0].requirements[0].text is required');
  });
});
