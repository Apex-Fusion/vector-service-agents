// agents/sourcing-agent/test/scoring/vendors.test.ts: the list that `GET /vendors` gives, and the entry of a bidder. The review question: is a body that is not a vendor list, or an entry that is not the entry of
// the bidder, ever given to the model as a vendor entry? The golden file holds the default data of the vendor master of the mock service. Each refusal has an accepted twin.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MAX_CERTIFICATIONS, MAX_NAME_CHARS, MAX_VENDORS, parseVendors, vendorFor } from '../../src/scoring/vendors.ts';
import type { VendorEntry } from '../../src/scoring/vendors.ts';

type Json = Record<string, unknown>;
interface Body extends Json {
  vendors: Json[];
}

const GOLDEN = JSON.parse(readFileSync(new URL('./golden/vendors-default.json', import.meta.url), 'utf8')) as Body;
const fresh = (): Body => structuredClone(GOLDEN);
const MEMBERS = Object.keys(GOLDEN.vendors[0]!);
const ALFA = GOLDEN.vendors[0] as unknown as VendorEntry;

/** The body with the member `member` of the second entry set to `value`. */
function withMember(member: string, value: unknown): Body {
  const body = fresh();
  body.vendors[1]![member] = value;
  return body;
}

describe('the vendor list', () => {
  it('takes the default data of the vendor master as a copy that holds the same values', () => {
    const body = fresh();
    const result = parseVendors(body);
    expect(result).toStrictEqual({ ok: true, value: GOLDEN.vendors });
    expect(result.ok && result.value[0]).not.toBe(body.vendors[0]);
    expect(result.ok && result.value[2]!.certifications).toStrictEqual([]);
  });

  it.each([null, undefined, 5, 'vendors', [], [GOLDEN.vendors[0]], true])('refuses a body that is not an object: %j', (body) => {
    expect(parseVendors(body)).toMatchObject({ ok: false, code: 'bad_shape' });
  });

  it('refuses a body with another member next to vendors, and a body with no vendors', () => {
    expect(parseVendors({ ...fresh(), total: 3 })).toMatchObject({ ok: false, code: 'bad_shape' });
    expect(parseVendors({})).toMatchObject({ ok: false, code: 'bad_shape' });
    expect(parseVendors({ vendor: GOLDEN.vendors })).toMatchObject({ ok: false, code: 'bad_shape' });
  });

  it.each([['an object', GOLDEN.vendors[0]], ['a text', 'V-1001'], ['null', null]])('refuses vendors that is %s and not a list', (_what, value) => {
    expect(parseVendors({ vendors: value })).toMatchObject({ ok: false, code: 'bad_shape' });
  });

  it('takes 1 entry and 50 entries and refuses 0 entries and 51', () => {
    const many = (count: number): Body => ({ vendors: Array.from({ length: count }, (_, at) => ({ ...GOLDEN.vendors[0]!, vendor_id: `V-${2000 + at}` })) });
    expect(MAX_VENDORS).toBe(50);
    expect(parseVendors(many(1))).toMatchObject({ ok: true });
    const fifty = parseVendors(many(50));
    expect(fifty.ok && fifty.value).toHaveLength(50);
    expect(parseVendors(many(0))).toMatchObject({ ok: false, code: 'bad_shape' });
    expect(parseVendors(many(51))).toMatchObject({ ok: false, code: 'bad_shape' });
  });

  it('refuses a vendor_id that two entries have, and takes two entries of one organisation with two ids', () => {
    const twice = fresh();
    twice.vendors[2]!.vendor_id = 'V-1001';
    expect(parseVendors(twice)).toMatchObject({ ok: false, code: 'bad_shape' });
    const sameOrganisation = fresh();
    sameOrganisation.vendors[2]!.organisation = 'alfa.example.org';
    expect(parseVendors(sameOrganisation)).toMatchObject({ ok: true });
  });

  it.each(MEMBERS)('refuses an entry that has no %s, and names the member', (member) => {
    const body = fresh();
    delete body.vendors[1]![member];
    const result = parseVendors(body);
    expect(result).toMatchObject({ ok: false, code: 'bad_shape' });
    expect(!result.ok && result.detail).toContain(member);
  });

  it('refuses an entry with a member that the vendor of the mock service does not have, also when its value is null', () => {
    const body = fresh();
    body.vendors[0]!.rating = 5;
    expect(parseVendors(body)).toMatchObject({ ok: false, code: 'bad_shape' });
    const nulled = fresh();
    nulled.vendors[0]!.contact = null;
    expect(parseVendors(nulled)).toMatchObject({ ok: false, code: 'bad_shape' });
  });

  it.each([['an entry that is a text', 'V-1001'], ['an entry that is null', null], ['an entry that is a list', []]])('refuses %s', (_what, entry) => {
    expect(parseVendors({ vendors: [GOLDEN.vendors[0], entry] })).toMatchObject({ ok: false, code: 'bad_shape' });
  });
});

/** A member of an entry: a value that is refused, and a value of the same member that is taken. */
const ROWS: readonly (readonly [string, unknown, unknown])[] = [
  ['vendor_id', 'V 1001', 'V-1009'],
  ['vendor_id', '', 'V'],
  ['vendor_id', 'x'.repeat(65), 'x'.repeat(64)],
  ['vendor_id', '-V1001', 'V1001'],
  ['vendor_id', 1001, 'V.1001_a'],
  ['organisation', 'Alfa.example.org', 'alfa.example.org'],
  ['organisation', 'alfa', 'a.b'],
  ['organisation', 'alfa..example.org', 'alfa.example.org'],
  ['organisation', 'alfa.example.org.', 'alfa-1.example.org'],
  ['organisation', '-alfa.example.org', 'alfa.example.org'],
  ['organisation', `${'a'.repeat(60)}.example.org`, `${'a'.repeat(51)}.example.org`],
  ['organisation', null, 'alfa.example.org'],
  ['name', '', 'S'],
  ['name', 'a'.repeat(MAX_NAME_CHARS + 1), 'a'.repeat(MAX_NAME_CHARS)],
  ['name', 'Supplier\u200bAlfa', 'Supplier Alfa'],
  ['name', 'Supplier\u0007Alfa', 'Supplier Alfa'],
  ['name', 'Supplier\u202eAlfa', 'Supplier Alfa'],
  ['name', 'Supplier\u2028Alfa', 'Supplier Alfa'],
  ['name', 'Supplier\nAlfa', 'Supplier Alfa'],
  ['name', 'Supplier\ufeffAlfa', 'Supplier Alfa'],
  ['name', 'Supplier\ud800Alfa', 'Supplier Alfa'],
  ['name', 7, 'Supplier Alfa'],
  ['on_time_delivery_rate', 1.5, 1],
  ['on_time_delivery_rate', -0.1, 0],
  ['on_time_delivery_rate', '0.9', 0.9],
  ['on_time_delivery_rate', Number.NaN, 0.5],
  ['on_time_delivery_rate', Number.POSITIVE_INFINITY, 0.5],
  ['defect_rate', 1.0001, 0.0001],
  ['defect_rate', -0.01, 0],
  ['defect_rate', null, 0.06],
  ['years_as_vendor', 1.5, 6],
  ['years_as_vendor', -1, 0],
  ['years_as_vendor', 201, 200],
  ['years_as_vendor', '6', 6],
  ['payment_terms_days', 366, 365],
  ['payment_terms_days', 30.5, 30],
  ['payment_terms_days', -1, 0],
  ['payment_terms_days', 1e300, 45],
  ['certifications', 'ISO 9001', ['ISO 9001']],
  ['certifications', [7], ['ISO 9001']],
  ['certifications', [''], ['I']],
  ['certifications', ['x'.repeat(65)], ['x'.repeat(64)]],
  ['certifications', Array.from({ length: MAX_CERTIFICATIONS + 1 }, (_, at) => `C${at}`), Array.from({ length: MAX_CERTIFICATIONS }, (_, at) => `C${at}`)],
  ['certifications', ['ISO\u200b9001'], ['ISO 9001']],
  ['certifications', ['ISO 9001', null], ['ISO 9001', 'ISO 14001']],
  ['last_audit', '2026-02-30', '2026-02-28'],
  ['last_audit', '2027-02-29', '2028-02-29'],
  ['last_audit', '2026-13-01', '2026-12-31'],
  ['last_audit', '2026-00-10', '2026-01-10'],
  ['last_audit', '2026-04-31', '2026-04-30'],
  ['last_audit', '2026-3-14', '2026-03-14'],
  ['last_audit', '14.03.2026', '2026-03-14'],
  ['last_audit', '2026-03-14T00:00:00Z', '2026-03-14'],
  ['last_audit', '0099-12-31', '0100-01-01'],
  ['last_audit', 20260314, '2026-03-14'],
];

describe('a member of an entry', () => {
  it.each(ROWS)('%s: refuses %j and takes %j', (member, bad, good) => {
    const refused = parseVendors(withMember(member, bad));
    expect(refused).toMatchObject({ ok: false, code: 'bad_shape' });
    expect(!refused.ok && refused.detail).toContain(member);
    const taken = parseVendors(withMember(member, good));
    expect(taken.ok).toBe(true);
    expect(taken.ok && taken.value[1]).toStrictEqual({ ...GOLDEN.vendors[1], [member]: good });
  });

  it('takes a rate of 0 and a rate of 1, and reads the number minus zero as 0', () => {
    const edge = parseVendors(JSON.parse('{"vendors":[{"vendor_id":"V-1","organisation":"a.b","name":"N","on_time_delivery_rate":1,"defect_rate":-0,"years_as_vendor":0,"payment_terms_days":-0,"certifications":[],"last_audit":"2026-01-01"}]}'));
    expect(edge.ok).toBe(true);
    const entry = edge.ok ? edge.value[0]! : null;
    expect(Object.is(entry?.defect_rate, 0)).toBe(true);
    expect(Object.is(entry?.payment_terms_days, 0)).toBe(true);
    expect(entry?.on_time_delivery_rate).toBe(1);
  });

  it('gives the texts in the NFC form', () => {
    const result = parseVendors(withMember('name', 'Cafe\u0301 Supplies'));
    expect(result.ok && result.value[1]!.name).toBe('Caf\u00e9 Supplies');
  });

  it('never repeats the value that failed in the detail', () => {
    const secret = 'zq9-the-text-that-failed';
    for (const [member, bad] of [['name', `${secret}\u200b`], ['organisation', `${secret}.Example.org`], ['last_audit', secret], ['vendor_id', `${secret} x`], ['certifications', [`${secret}\u0007`]]] as const) {
      const result = parseVendors(withMember(member, bad));
      expect(result.ok).toBe(false);
      expect(!result.ok && result.detail).not.toContain(secret);
    }
  });
});

describe('a body that a list cannot hold', () => {
  it('refuses a key __proto__, and takes the same list without it', () => {
    const body = JSON.parse(`{"vendors":${JSON.stringify(GOLDEN.vendors)},"__proto__":{"vendors":[]}}`) as unknown;
    expect(parseVendors(body)).toMatchObject({ ok: false, code: 'bad_shape' });
    expect(parseVendors(fresh())).toMatchObject({ ok: true });
  });

  it('refuses a getter and never runs it', () => {
    let reads = 0;
    const body = fresh();
    Object.defineProperty(body.vendors[0]!, 'name', {
      enumerable: true,
      get: () => {
        reads += 1;
        return 'Supplier Alfa';
      },
    });
    expect(parseVendors(body)).toMatchObject({ ok: false, code: 'bad_shape' });
    expect(reads).toBe(0);
  });

  it('refuses a value that JSON cannot hold, and a list that nests deeper than the protocol allows', () => {
    expect(parseVendors(withMember('name', undefined))).toMatchObject({ ok: false });
    expect(parseVendors(withMember('years_as_vendor', 10n))).toMatchObject({ ok: false });
    let deep: unknown = 'leaf';
    for (let level = 0; level < 40; level += 1) deep = { deep };
    expect(parseVendors({ vendors: [GOLDEN.vendors[0], deep] })).toMatchObject({ ok: false });
  });
});

describe('the entry of a bidder', () => {
  const vendors = parseVendors(fresh());
  const list = vendors.ok ? vendors.value : [];

  it('is the entry whose organisation is the verified organisation of the bidder', () => {
    expect(list).toHaveLength(3);
    expect(vendorFor(list, 'alfa.example.org')).toBe(list[0]);
    expect(vendorFor(list, 'bravo.example.org')).toBe(list[1]);
    expect(vendorFor(list, 'charlie.example.org')).toBe(list[2]);
    expect(vendorFor([...list].reverse(), 'alfa.example.org')).toBe(list[0]);
  });

  it('is null for a bidder with no organisation, and for an organisation that no entry names', () => {
    expect(vendorFor(list, null)).toBeNull();
    expect(vendorFor(list, 'delta.example.org')).toBeNull();
    expect(vendorFor([], 'alfa.example.org')).toBeNull();
    expect(vendorFor(list, undefined as unknown as null)).toBeNull();
  });

  it('is an exact match: no change of case, no part of a name, no suffix', () => {
    for (const organisation of ['ALFA.example.org', 'Alfa.example.org', 'alfa.example.org.', ' alfa.example.org', 'alfa.example', 'xalfa.example.org', 'example.org', '']) {
      expect(vendorFor(list, organisation)).toBeNull();
    }
  });

  it('is null when two entries name the organisation: the master is ambiguous, and the model is told that there is no entry', () => {
    const twin: VendorEntry = { ...ALFA, vendor_id: 'V-2001', name: 'Another Alfa' };
    expect(vendorFor([...list, twin], 'alfa.example.org')).toBeNull();
    expect(vendorFor([...list, twin], 'bravo.example.org')).toBe(list[1]);
    expect(vendorFor([twin, ...list], 'charlie.example.org')).toBe(list[2]);
  });
});
