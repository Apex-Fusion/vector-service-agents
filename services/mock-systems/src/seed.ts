// services/mock-systems/src/seed.ts
// The synthetic data of a tenant. No real person, company or product is behind any of it. `defaultSeed()` is the data that a tenant gets when its seed names nothing. A seed can replace
// each part as a whole (`parseSeed`): the stock readings, the supplier catalogue, the clinical orders with their records, the guidelines, the insurer requirements and the vendors.
// The default data fits the three use cases: a stock reading below its threshold and one above it, a catalogue whose largest lot of one item is more than the supplier holds, one clinical
// order that meets its guideline and one that does not, and three vendors that differ in how well they deliver.
import { Invalid, amount, at, date, domain, fields, flag, id, isJsonObject, list, ratio, text, unique, whole } from './validate.ts';

export const LOT_NAMES = ['lot-small', 'lot-medium', 'lot-large'] as const;
export type LotName = (typeof LOT_NAMES)[number];

/** What the buyer ERP knows of one SKU. */
export interface StockReading {
  sku: string;
  on_hand: number;
  threshold: number;
  daily_usage: number;
  lead_time_days: number;
  open_orders: number;
}

/** One line of the catalogue of the supplier portal: what the supplier holds, and the size of each lot. */
export interface CatalogueEntry {
  sku: string;
  description: string;
  unit: string;
  available: number;
  lot_sizes: Record<LotName, number>;
  ship_lead_days: number;
  discontinued: boolean;
}

/** A clinical order, as the records system shows it. */
export interface ClinicalOrder {
  order_id: string;
  patient_ref: string;
  service_code: string;
  service_description: string;
  diagnosis_codes: string[];
  ordering_clinician_ref: string;
  ordered_at: string;
}

export interface ClinicalRecord {
  record_id: string;
  type: string;
  recorded_at: string;
  summary: string;
}

/** The order and the set of records behind it: the answer of the records system for one order. */
export interface RecordSet {
  order: ClinicalOrder;
  records: ClinicalRecord[];
}

export interface Criterion {
  id: string;
  text: string;
}

export interface Guideline {
  code: string;
  title: string;
  version: string;
  criteria: Criterion[];
  documentation: string[];
}

export interface RequirementSet {
  service_code: string;
  title: string;
  requirements: Criterion[];
}

export interface Vendor {
  vendor_id: string;
  organisation: string;
  name: string;
  on_time_delivery_rate: number;
  defect_rate: number;
  years_as_vendor: number;
  payment_terms_days: number;
  certifications: string[];
  last_audit: string;
}

export interface Seed {
  erp: StockReading[];
  catalogue: CatalogueEntry[];
  records: RecordSet[];
  guidelines: Guideline[];
  requirements: RequirementSet[];
  vendors: Vendor[];
}

export const SEED_PARTS = ['erp', 'catalogue', 'records', 'guidelines', 'requirements', 'vendors'] as const satisfies readonly (keyof Seed)[];

export function defaultSeed(): Seed {
  return {
    erp: [
      { sku: 'GLV-NIT-M', on_hand: 60, threshold: 100, daily_usage: 12, lead_time_days: 7, open_orders: 0 },
      { sku: 'SYR-10ML', on_hand: 900, threshold: 400, daily_usage: 60, lead_time_days: 5, open_orders: 0 },
      { sku: 'MSK-N95', on_hand: 40, threshold: 150, daily_usage: 55, lead_time_days: 10, open_orders: 0 },
    ],
    catalogue: [
      { sku: 'GLV-NIT-M', description: 'Nitrile examination gloves, size M, box of 100', unit: 'box', available: 5000, lot_sizes: { 'lot-small': 10, 'lot-medium': 50, 'lot-large': 200 }, ship_lead_days: 3, discontinued: false },
      { sku: 'SYR-10ML', description: 'Syringe 10 ml, luer lock, box of 100', unit: 'box', available: 3000, lot_sizes: { 'lot-small': 25, 'lot-medium': 100, 'lot-large': 400 }, ship_lead_days: 2, discontinued: false },
      { sku: 'MSK-N95', description: 'Respirator mask N95, box of 20', unit: 'box', available: 150, lot_sizes: { 'lot-small': 20, 'lot-medium': 100, 'lot-large': 400 }, ship_lead_days: 6, discontinued: false },
    ],
    records: [
      {
        order: {
          order_id: 'ORD-1001', patient_ref: 'SYN-PT-0001', service_code: 'SYN-MRI-LS', service_description: 'Magnetic resonance imaging of the lumbar spine, without contrast',
          diagnosis_codes: ['M54.16', 'M51.16'], ordering_clinician_ref: 'SYN-CL-0007', ordered_at: '2026-10-22',
        },
        records: [
          { record_id: 'REC-0001', type: 'imaging', recorded_at: '2026-08-10', summary: 'Plain X-ray of the lumbar spine. Mild narrowing of the disc space at L4-L5. No fracture.' },
          { record_id: 'REC-0002', type: 'progress_note', recorded_at: '2026-09-02', summary: 'Low back pain that spreads to the left leg for 3 weeks. Straight leg raise is positive on the left at 40 degrees. No bowel or bladder symptoms.' },
          { record_id: 'REC-0003', type: 'medication', recorded_at: '2026-09-02', summary: 'Naproxen 500 mg twice a day for 4 weeks, then stopped. The patient reports partial relief only.' },
          { record_id: 'REC-0004', type: 'therapy', recorded_at: '2026-09-23', summary: 'Physical therapy: 6 sessions over 3 weeks. Pain 7 of 10 at the start and 6 of 10 at the end. Little change.' },
          { record_id: 'REC-0005', type: 'progress_note', recorded_at: '2026-10-21', summary: 'Pain in the left leg continues at 7 weeks. New numbness in the left foot. Weakness of ankle dorsiflexion, 4 of 5.' },
        ],
      },
      {
        order: {
          order_id: 'ORD-1002', patient_ref: 'SYN-PT-0002', service_code: 'SYN-MRI-KN', service_description: 'Magnetic resonance imaging of the knee, without contrast',
          diagnosis_codes: ['M25.561'], ordering_clinician_ref: 'SYN-CL-0011', ordered_at: '2026-10-25',
        },
        records: [
          { record_id: 'REC-0101', type: 'progress_note', recorded_at: '2026-10-14', summary: 'Pain in the right knee for 10 days after a fall. Mild swelling. Walks without help.' },
          { record_id: 'REC-0102', type: 'imaging', recorded_at: '2026-10-14', summary: 'Plain X-ray of the right knee. No fracture. Joint space is normal.' },
        ],
      },
    ],
    guidelines: [
      {
        code: 'SYN-MRI-LS', title: 'Imaging of the lumbar spine', version: '2026.1',
        criteria: [
          { id: 'C1', text: 'Low back pain with pain in the leg for at least 6 weeks.' },
          { id: 'C2', text: 'Conservative therapy for at least 6 weeks is tried and documented, for example physical therapy or medication.' },
          { id: 'C3', text: 'A nerve deficit or a warning sign is documented, for example weakness, numbness or loss of bladder control.' },
          { id: 'C4', text: 'Plain X-rays of the spine, if any, are listed.' },
        ],
        documentation: ['The dates of the conservative therapy.', 'The findings of the last examination.'],
      },
      {
        code: 'SYN-MRI-KN', title: 'Imaging of the knee', version: '2026.1',
        criteria: [
          { id: 'C1', text: 'Knee pain for at least 6 weeks.' },
          { id: 'C2', text: 'Conservative therapy for at least 6 weeks is tried and documented.' },
          { id: 'C3', text: 'Locking, giving way or a clear loss of motion is documented.' },
          { id: 'C4', text: 'Plain X-rays of the knee are reviewed and listed.' },
        ],
        documentation: ['The dates of the conservative therapy.', 'The findings of the last examination.'],
      },
    ],
    requirements: [
      {
        service_code: 'SYN-MRI-LS', title: 'Intake requirements for imaging of the lumbar spine',
        requirements: [
          { id: 'R1', text: 'The request names the ordering clinician.' },
          { id: 'R2', text: 'The request has at least one diagnosis code.' },
          { id: 'R3', text: 'The request has a justification that cites the criteria of the guideline.' },
          { id: 'R4', text: 'The request lists the records that support each criterion.' },
          { id: 'R5', text: 'The request states the hash of the set of records that the writer read.' },
        ],
      },
      {
        service_code: 'SYN-MRI-KN', title: 'Intake requirements for imaging of the knee',
        requirements: [
          { id: 'R1', text: 'The request names the ordering clinician.' },
          { id: 'R2', text: 'The request has at least one diagnosis code.' },
          { id: 'R3', text: 'The request has a justification that cites the criteria of the guideline.' },
          { id: 'R4', text: 'The request lists the records that support each criterion.' },
          { id: 'R5', text: 'The request states the hash of the set of records that the writer read.' },
        ],
      },
    ],
    vendors: [
      { vendor_id: 'V-1001', organisation: 'alfa.example.org', name: 'Supplier Alfa (synthetic)', on_time_delivery_rate: 0.97, defect_rate: 0.01, years_as_vendor: 6, payment_terms_days: 30, certifications: ['ISO 9001'], last_audit: '2026-03-14' },
      { vendor_id: 'V-1002', organisation: 'bravo.example.org', name: 'Supplier Bravo (synthetic)', on_time_delivery_rate: 0.92, defect_rate: 0.03, years_as_vendor: 4, payment_terms_days: 45, certifications: ['ISO 9001'], last_audit: '2026-01-22' },
      { vendor_id: 'V-1003', organisation: 'charlie.example.org', name: 'Supplier Charlie (synthetic)', on_time_delivery_rate: 0.85, defect_rate: 0.06, years_as_vendor: 2, payment_terms_days: 60, certifications: [], last_audit: '2025-11-05' },
    ],
  };
}

const clip = { max: 500 };

function stockReading(path: string, value: unknown): StockReading {
  const o = fields(path, value, ['sku', 'on_hand', 'threshold', 'daily_usage', 'lead_time_days', 'open_orders']);
  return {
    sku: id(at(path, 'sku'), o.sku),
    on_hand: whole(at(path, 'on_hand'), o.on_hand, 0, 10_000_000),
    threshold: whole(at(path, 'threshold'), o.threshold, 0, 10_000_000),
    daily_usage: amount(at(path, 'daily_usage'), o.daily_usage, 10_000_000),
    lead_time_days: whole(at(path, 'lead_time_days'), o.lead_time_days, 0, 365),
    open_orders: whole(at(path, 'open_orders'), o.open_orders, 0, 10_000_000),
  };
}

function catalogueEntry(path: string, value: unknown): CatalogueEntry {
  const o = fields(path, value, ['sku', 'description', 'unit', 'available', 'lot_sizes', 'ship_lead_days', 'discontinued']);
  const sizes = fields(at(path, 'lot_sizes'), o.lot_sizes, LOT_NAMES);
  return {
    sku: id(at(path, 'sku'), o.sku),
    description: text(at(path, 'description'), o.description, { max: 200 }),
    unit: text(at(path, 'unit'), o.unit, { max: 32 }),
    available: whole(at(path, 'available'), o.available, 0, 100_000_000),
    lot_sizes: {
      'lot-small': whole(at(at(path, 'lot_sizes'), 'lot-small'), sizes['lot-small'], 1, 1_000_000),
      'lot-medium': whole(at(at(path, 'lot_sizes'), 'lot-medium'), sizes['lot-medium'], 1, 1_000_000),
      'lot-large': whole(at(at(path, 'lot_sizes'), 'lot-large'), sizes['lot-large'], 1, 1_000_000),
    },
    ship_lead_days: whole(at(path, 'ship_lead_days'), o.ship_lead_days, 0, 365),
    discontinued: flag(at(path, 'discontinued'), o.discontinued),
  };
}

function clinicalRecord(path: string, value: unknown): ClinicalRecord {
  const o = fields(path, value, ['record_id', 'type', 'recorded_at', 'summary']);
  return {
    record_id: id(at(path, 'record_id'), o.record_id),
    type: text(at(path, 'type'), o.type, { max: 32 }),
    recorded_at: date(at(path, 'recorded_at'), o.recorded_at),
    summary: text(at(path, 'summary'), o.summary, { max: 2000 }),
  };
}

function recordSet(path: string, value: unknown): RecordSet {
  const o = fields(path, value, ['order', 'records']);
  const order = fields(at(path, 'order'), o.order, ['order_id', 'patient_ref', 'service_code', 'service_description', 'diagnosis_codes', 'ordering_clinician_ref', 'ordered_at']);
  const records = list(at(path, 'records'), o.records, 1, 50, clinicalRecord);
  unique(at(path, 'records'), records, (r) => r.record_id, 'record_id');
  return {
    order: {
      order_id: id(at(at(path, 'order'), 'order_id'), order.order_id),
      patient_ref: id(at(at(path, 'order'), 'patient_ref'), order.patient_ref),
      service_code: id(at(at(path, 'order'), 'service_code'), order.service_code),
      service_description: text(at(at(path, 'order'), 'service_description'), order.service_description, { max: 200 }),
      diagnosis_codes: list(at(at(path, 'order'), 'diagnosis_codes'), order.diagnosis_codes, 1, 8, (p, v) => text(p, v, { max: 16 })),
      ordering_clinician_ref: id(at(at(path, 'order'), 'ordering_clinician_ref'), order.ordering_clinician_ref),
      ordered_at: date(at(at(path, 'order'), 'ordered_at'), order.ordered_at),
    },
    records,
  };
}

function criterion(path: string, value: unknown): Criterion {
  const o = fields(path, value, ['id', 'text']);
  return { id: id(at(path, 'id'), o.id), text: text(at(path, 'text'), o.text, clip) };
}

function guideline(path: string, value: unknown): Guideline {
  const o = fields(path, value, ['code', 'title', 'version', 'criteria', 'documentation']);
  const criteria = list(at(path, 'criteria'), o.criteria, 1, 20, criterion);
  unique(at(path, 'criteria'), criteria, (c) => c.id, 'id');
  return {
    code: id(at(path, 'code'), o.code),
    title: text(at(path, 'title'), o.title, { max: 200 }),
    version: text(at(path, 'version'), o.version, { max: 32 }),
    criteria,
    documentation: list(at(path, 'documentation'), o.documentation, 0, 20, (p, v) => text(p, v, clip)),
  };
}

function requirementSet(path: string, value: unknown): RequirementSet {
  const o = fields(path, value, ['service_code', 'title', 'requirements']);
  const requirements = list(at(path, 'requirements'), o.requirements, 1, 20, criterion);
  unique(at(path, 'requirements'), requirements, (c) => c.id, 'id');
  return { service_code: id(at(path, 'service_code'), o.service_code), title: text(at(path, 'title'), o.title, { max: 200 }), requirements };
}

function vendor(path: string, value: unknown): Vendor {
  const o = fields(path, value, ['vendor_id', 'organisation', 'name', 'on_time_delivery_rate', 'defect_rate', 'years_as_vendor', 'payment_terms_days', 'certifications', 'last_audit']);
  return {
    vendor_id: id(at(path, 'vendor_id'), o.vendor_id),
    organisation: domain(at(path, 'organisation'), o.organisation),
    name: text(at(path, 'name'), o.name, { max: 200 }),
    on_time_delivery_rate: ratio(at(path, 'on_time_delivery_rate'), o.on_time_delivery_rate),
    defect_rate: ratio(at(path, 'defect_rate'), o.defect_rate),
    years_as_vendor: whole(at(path, 'years_as_vendor'), o.years_as_vendor, 0, 200),
    payment_terms_days: whole(at(path, 'payment_terms_days'), o.payment_terms_days, 0, 365),
    certifications: list(at(path, 'certifications'), o.certifications, 0, 10, (p, v) => text(p, v, { max: 64 })),
    last_audit: date(at(path, 'last_audit'), o.last_audit),
  };
}

/**
 * The seed of a tenant: the default data, where a part that the input names replaces the default part as a whole. A part that is in the input and is not well formed is an error that
 * names its path. A part name that is not one of the six is an error too: a typo must not leave the default data in place.
 */
export function parseSeed(path: string, input: unknown): Seed {
  const seed = defaultSeed();
  if (input === undefined) return seed;
  if (!isJsonObject(input)) throw new Invalid(path, 'must be a JSON object');
  const o = fields(path, input, [], SEED_PARTS);
  if (o.erp !== undefined) {
    seed.erp = list(at(path, 'erp'), o.erp, 1, 200, stockReading);
    unique(at(path, 'erp'), seed.erp, (s) => s.sku, 'sku');
  }
  if (o.catalogue !== undefined) {
    seed.catalogue = list(at(path, 'catalogue'), o.catalogue, 1, 200, catalogueEntry);
    unique(at(path, 'catalogue'), seed.catalogue, (s) => s.sku, 'sku');
  }
  if (o.records !== undefined) {
    seed.records = list(at(path, 'records'), o.records, 1, 50, recordSet);
    unique(at(path, 'records'), seed.records, (r) => r.order.order_id, 'order_id');
  }
  if (o.guidelines !== undefined) {
    seed.guidelines = list(at(path, 'guidelines'), o.guidelines, 1, 50, guideline);
    unique(at(path, 'guidelines'), seed.guidelines, (g) => g.code, 'code');
  }
  if (o.requirements !== undefined) {
    seed.requirements = list(at(path, 'requirements'), o.requirements, 1, 50, requirementSet);
    unique(at(path, 'requirements'), seed.requirements, (r) => r.service_code, 'service_code');
  }
  if (o.vendors !== undefined) {
    seed.vendors = list(at(path, 'vendors'), o.vendors, 1, 50, vendor);
    unique(at(path, 'vendors'), seed.vendors, (v) => v.vendor_id, 'vendor_id');
  }
  return seed;
}

