// packages/usecase-kit/src/inventory/order.ts
// The purchase order of use case 1 (inventory reorder). The Reorder Agent proposes it, the Order Desk reads it in a handoff, and the purchase order store of the mock service takes it. It is the
// document of a proposal, so its digest is `proposalDigest(salt, document)` of the protocol, and the hirer approves that digest.
//
// The parser takes what the purchase order store takes, and no more:
//   po_number, sku        an identifier of 1 to 64 letters, digits, dots, hyphens and underscores, starting with a letter or a digit
//   tenant                1 to 48 lower-case letters, digits and hyphens, starting with a letter or a digit (the protocol takes 64 characters for the tenant of a request: the store takes 48)
//   lot                   one of the three lot names
//   quantity              a whole number from 1 to 1,000,000
//   needed_by             a date as YYYY-MM-DD that exists
//   supplier_did          a DID
//   advert_ref            a reference to an output: a transaction hash, a hash sign and an output index of at most 6 digits (the store takes 6 digits, and the form of the protocol takes 10)
//   stock_reading_sha256  a digest
// A member is read one time as data. The result is a new plain object with its members in the order above and each text in the NFC form, which is the form that the digest binds. An accessor, the key
// `__proto__` and a member that is not listed are refused. The detail of a refusal names the field and never repeats the value.
import { DOCUMENT_SCHEMAS, accepted, checkMembers, parseCanonicalDocument, parseDid, parseDigest, parseOutputRef, refused } from '../protocol/index.ts';
import type { Did, Digest, OutputRef, ProtocolResult, TenantId } from '../protocol/index.ts';
import { isLotName, parseDay, parseId, parseQuantity } from './lots.ts';
import type { LotName } from './lots.ts';

/** The schema of the purchase order: the schema that the protocol names for use case 1. */
export const PO_SCHEMA = DOCUMENT_SCHEMAS['inventory-reorder'];

export interface PurchaseOrder {
  readonly schema: typeof PO_SCHEMA;
  readonly po_number: string;
  readonly tenant: TenantId;
  readonly sku: string;
  readonly lot: LotName;
  readonly quantity: number;
  readonly needed_by: string;
  readonly supplier_did: Did;
  readonly advert_ref: OutputRef;
  readonly stock_reading_sha256: Digest;
}

const MEMBERS = ['schema', 'po_number', 'tenant', 'sku', 'lot', 'quantity', 'needed_by', 'supplier_did', 'advert_ref', 'stock_reading_sha256'] as const;

const TENANT = /^[a-z0-9][a-z0-9-]{0,47}$/;
/** The most digits that the store takes in the index of an output. */
const MAX_INDEX_DIGITS = 6;
/** The most characters of a purchase order number. */
const MAX_NUMBER_CHARS = 64;

function parseTenant(value: unknown, field: string): ProtocolResult<TenantId> {
  return typeof value === 'string' && TENANT.test(value)
    ? accepted(value)
    : refused('bad_shape', `${field} must be 1 to 48 characters: lower-case letters, digits and hyphens, and it starts with a letter or a digit`);
}

function parseAdvertRef(value: unknown, field: string): ProtocolResult<OutputRef> {
  const ref = parseOutputRef(value, field);
  if (!ref.ok) return ref;
  if (ref.value.length - ref.value.indexOf('#') - 1 > MAX_INDEX_DIGITS) return refused('bad_shape', `${field} must have an output index of at most ${MAX_INDEX_DIGITS} digits`);
  return ref;
}

/**
 * A purchase order with exactly the members above, as a new plain object, or a refusal with the code `bad_shape`. `field` is the name that the detail of a refusal gives to the order: a caller that
 * reads the document of a handoff passes `handoff.document`.
 */
export function parsePurchaseOrder(value: unknown, field = 'purchase order'): ProtocolResult<PurchaseOrder> {
  const copy = parseCanonicalDocument(value, field);
  if (!copy.ok) return copy;
  const members = checkMembers(copy.value, field, MEMBERS);
  if (members !== null) return members;
  const order = copy.value;
  if (order.schema !== PO_SCHEMA) return refused('bad_shape', `${field}.schema must be "${PO_SCHEMA}"`);
  const poNumber = parseId(order.po_number, `${field}.po_number`);
  if (!poNumber.ok) return poNumber;
  const tenant = parseTenant(order.tenant, `${field}.tenant`);
  if (!tenant.ok) return tenant;
  const sku = parseId(order.sku, `${field}.sku`);
  if (!sku.ok) return sku;
  const lot = order.lot;
  if (!isLotName(lot)) return refused('bad_shape', `${field}.lot must be one of the lot names`);
  const quantity = parseQuantity(order.quantity, `${field}.quantity`);
  if (!quantity.ok) return quantity;
  const neededBy = parseDay(order.needed_by, `${field}.needed_by`);
  if (!neededBy.ok) return neededBy;
  const supplier = parseDid(order.supplier_did, `${field}.supplier_did`);
  if (!supplier.ok) return supplier;
  const advert = parseAdvertRef(order.advert_ref, `${field}.advert_ref`);
  if (!advert.ok) return advert;
  const stock = parseDigest(order.stock_reading_sha256, `${field}.stock_reading_sha256`);
  if (!stock.ok) return stock;
  return accepted({
    schema: PO_SCHEMA,
    po_number: poNumber.value,
    tenant: tenant.value,
    sku: sku.value,
    lot,
    quantity: quantity.value,
    needed_by: neededBy.value,
    supplier_did: supplier.value,
    advert_ref: advert.value,
    stock_reading_sha256: stock.value,
  });
}

/**
 * The number of a purchase order: the tenant, a hyphen and the counter, with no padding. The tenant has the form of the store (1 to 48 lower-case letters, digits and hyphens), and the counter is a
 * whole number of 0 or more. The result has at most 64 characters, so that the parser takes it. A tenant or a counter of another form is a TypeError, and the message never repeats it.
 */
export function poNumberOf(tenant: string, counter: number): string {
  if (typeof tenant !== 'string' || !TENANT.test(tenant)) throw new TypeError('a tenant is 1 to 48 lower-case letters, digits and hyphens, and it starts with a letter or a digit');
  if (typeof counter !== 'number' || !Number.isSafeInteger(counter) || counter < 0) throw new TypeError('a counter is a whole number of 0 or more');
  const number = `${tenant}-${counter}`;
  if (number.length > MAX_NUMBER_CHARS) throw new TypeError(`a purchase order number has at most ${MAX_NUMBER_CHARS} characters`);
  return number;
}
