// services/mock-systems/src/documents.ts
// The bodies of the writes. Each reader takes the parsed JSON and the tenant of the URL, and gives a new object with the fields that the write needs, or throws `Invalid` with the path
// of the field that is wrong. A document that names another tenant than the one of the URL is refused: a write for one run must never land in another.
import { LOT_NAMES } from './seed.ts';
import type { LotName } from './seed.ts';
import { Invalid, at, date, did, domain, fields, hex64, id, isJsonObject, list, oneOf, outRef, text, unique, whole } from './validate.ts';
import type { Json } from './validate.ts';

/** The purchase order of the buyer, as the PO store takes it. */
export interface PurchaseOrder {
  schema: 'vector.usecase.po.v1';
  po_number: string;
  tenant: string;
  sku: string;
  lot: LotName;
  quantity: number;
  needed_by: string;
  supplier_did: string;
  advert_ref: string;
  stock_reading_sha256: string;
}

export function parsePurchaseOrder(body: unknown, tenant: string): PurchaseOrder {
  const o = fields('body', body, ['schema', 'po_number', 'tenant', 'sku', 'lot', 'quantity', 'needed_by', 'supplier_did', 'advert_ref', 'stock_reading_sha256']);
  if (o.schema !== 'vector.usecase.po.v1') throw new Invalid('body.schema', 'must be vector.usecase.po.v1');
  const named = text('body.tenant', o.tenant, { max: 48 });
  if (named !== tenant) throw new Invalid('body.tenant', 'must be the tenant of the URL');
  return {
    schema: 'vector.usecase.po.v1',
    po_number: id('body.po_number', o.po_number),
    tenant: named,
    sku: id('body.sku', o.sku),
    lot: oneOf('body.lot', o.lot, LOT_NAMES),
    quantity: whole('body.quantity', o.quantity, 1, 1_000_000),
    needed_by: date('body.needed_by', o.needed_by),
    supplier_did: did('body.supplier_did', o.supplier_did),
    advert_ref: outRef('body.advert_ref', o.advert_ref),
    stock_reading_sha256: hex64('body.stock_reading_sha256', o.stock_reading_sha256),
  };
}

/** The order that the Order Desk places in the supplier portal. */
export interface SupplierOrderRequest {
  po_number: string;
  po_sha256: string;
  sku: string;
  lot: LotName;
  quantity: number;
  ship_by: string;
}

export function parseSupplierOrder(body: unknown): SupplierOrderRequest {
  const o = fields('body', body, ['po_number', 'po_sha256', 'sku', 'lot', 'quantity', 'ship_by']);
  return {
    po_number: id('body.po_number', o.po_number),
    po_sha256: hex64('body.po_sha256', o.po_sha256),
    sku: id('body.sku', o.sku),
    lot: oneOf('body.lot', o.lot, LOT_NAMES),
    quantity: whole('body.quantity', o.quantity, 1, 1_000_000),
    ship_by: date('body.ship_by', o.ship_by),
  };
}

/** The reference of an intake, written to the records system after the insurer took the request. */
export interface SubmissionRequest {
  request_number: string;
  intake_id: string;
  status: 'complete' | 'incomplete' | null;
}

export function parseSubmission(body: unknown): SubmissionRequest {
  const o = fields('body', body, ['request_number', 'intake_id'], ['status']);
  return {
    request_number: id('body.request_number', o.request_number),
    intake_id: id('body.intake_id', o.intake_id),
    status: o.status === undefined ? null : oneOf('body.status', o.status, ['complete', 'incomplete'] as const),
  };
}

/** The authorization request as the insurer portal files it. Only the fields that the portal reads are checked: the rest of the document is kept as it came. */
export interface IntakeRequest {
  request: Json;
  request_number: string;
  service_code: string;
  status: 'complete' | 'incomplete';
  missing: string[];
}

export function parseIntake(body: unknown, tenant: string): IntakeRequest {
  const o = fields('body', body, ['request', 'status', 'missing']);
  if (!isJsonObject(o.request)) throw new Invalid('body.request', 'must be a JSON object');
  if (o.request.schema !== 'vector.usecase.priorauth-request.v1') throw new Invalid('body.request.schema', 'must be vector.usecase.priorauth-request.v1');
  const named = text('body.request.tenant', o.request.tenant, { max: 48 });
  if (named !== tenant) throw new Invalid('body.request.tenant', 'must be the tenant of the URL');
  return {
    request: o.request,
    request_number: id('body.request.request_number', o.request.request_number),
    service_code: id('body.request.service_code', o.request.service_code),
    status: oneOf('body.status', o.status, ['complete', 'incomplete'] as const),
    missing: list('body.missing', o.missing, 0, 20, (p, v) => id(p, v)),
  };
}

/** The ranking that the Sourcing Agent writes, with the salt and the approval that go with it. */
export interface RankingRequest {
  /** The ranking exactly as it was sent. The approval check hashes it, so it is never rebuilt. */
  ranking: Json;
  rfq_id: string;
  /** The DID of the supplier with rank 1. */
  top: string;
  /** The `organisation` field of the entry with rank 1, when it has one. */
  topOrganisation: string | null;
  salt: string;
  /** `null` when no approval came. */
  approval: { attestation: string; issuer_did: string } | null;
}

export function parseRanking(body: unknown, tenant: string): RankingRequest {
  const o = fields('body', body, ['ranking', 'salt', 'approval']);
  if (!isJsonObject(o.ranking)) throw new Invalid('body.ranking', 'must be a JSON object');
  const ranking = o.ranking;
  if (ranking.schema !== 'vector.usecase.ranking.v1') throw new Invalid('body.ranking.schema', 'must be vector.usecase.ranking.v1');
  const named = text('body.ranking.tenant', ranking.tenant, { max: 48 });
  if (named !== tenant) throw new Invalid('body.ranking.tenant', 'must be the tenant of the URL');
  const rfq = id('body.ranking.rfq_id', ranking.rfq_id);
  const ranked = list('body.ranking.ranked', ranking.ranked, 1, 20, (path, entry) => {
    if (!isJsonObject(entry)) throw new Invalid(path, 'must be a JSON object');
    const organisation = entry.organisation === undefined ? null : domain(at(path, 'organisation'), entry.organisation);
    return { rank: whole(at(path, 'rank'), entry.rank, 1, 1000), desk: did(at(path, 'desk_did'), entry.desk_did), organisation };
  });
  unique('body.ranking.ranked', ranked, (entry) => String(entry.rank), 'rank');
  const tops = ranked.filter((entry) => entry.rank === 1);
  if (tops.length !== 1) throw new Invalid('body.ranking.ranked', 'must have one entry with rank 1');
  const salt = hex64('body.salt', o.salt);
  let approval: RankingRequest['approval'] = null;
  if (o.approval !== null) {
    const a = fields('body.approval', o.approval, ['attestation', 'issuer_did']);
    approval = { attestation: hex64('body.approval.attestation', a.attestation), issuer_did: did('body.approval.issuer_did', a.issuer_did) };
  }
  return { ranking, rfq_id: rfq, top: tops[0]!.desk, topOrganisation: tops[0]!.organisation, salt, approval };
}
