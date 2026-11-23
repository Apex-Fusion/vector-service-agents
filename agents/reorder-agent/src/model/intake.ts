// agents/reorder-agent/src/model/intake.ts
// The fields of a `propose` request of the Reorder Agent (use case 1, inventory reorder): the SKU to reorder and the supplier to order from. A request has these two members besides `op`, `authority`
// and `tenant`, and no other member.
//
// The protocol hands the fields over as a copy of plain JSON data. The parser copies them again with `readMembers`, so that an accessor, a Proxy that throws and an object of another kind are refused
// before any member is read. Then it reads each member one time. It never throws. A detail names the field and the form, and it never repeats a value.
import { accepted, checkMembers, parseDid, readMembers, refused } from '@vsa/usecase-kit/protocol';
import type { Did, ProposeFieldsParser } from '@vsa/usecase-kit/protocol';

/** What a `propose` request asks for: the SKU, and the supplier whose Order Desk takes the order. */
export interface ProposeFields {
  readonly sku: string;
  readonly supplier_did: Did;
}

/** The form of a SKU: the identifier rule of the purchase order store of the mock service. The ERP reading and the purchase order use the same rule. */
const SKU = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** The rule of a SKU in words, for the detail of a refusal. */
export const SKU_RULE = '1 to 64 characters: letters, digits, dot, hyphen and underscore, and it starts with a letter or a digit';

/** True for a text in the form of a SKU. */
export const isSku = (value: unknown): value is string => typeof value === 'string' && SKU.test(value);

/** Reads the two fields of a `propose` request. It is the fields parser that `parseRequest` of the protocol takes. */
export const parseProposeFields: ProposeFieldsParser<ProposeFields> = (fields) => {
  const read = readMembers(fields, 'request');
  if (!read.ok) return read;
  const members = checkMembers(read.value, 'request', ['sku', 'supplier_did']);
  if (members !== null) return members;
  const { sku, supplier_did: supplierDid } = read.value;
  if (!isSku(sku)) return refused('bad_shape', `request.sku must be ${SKU_RULE}`);
  const supplier = parseDid(supplierDid, 'request.supplier_did');
  if (!supplier.ok) return supplier;
  return accepted({ sku, supplier_did: supplier.value });
};
