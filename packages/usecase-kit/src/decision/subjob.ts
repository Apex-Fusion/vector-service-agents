// packages/usecase-kit/src/decision/subjob.ts
// The sub-job of a decision: the hire of the model, as the protocol writes it. hire-kit runs the eight checks of the receipt and accepts the escrow only when all eight pass. This file does not trust
// that: it builds the `SubJob` from the record of the hire, and it refuses a record in which one of the eight checks is missing or is not true. A refusal here is never a pass.
//
// Every member of the sub-job is checked for its form: the references (`<64 hex>#<index>`), the key hash (56 lower-case hex characters), the capability, the signature and the receipt. The receipt is
// returned as a new copy of plain JSON data. The supplier writes the receipt, so a refusal of the receipt says where, by depth, and repeats no key and no value (see where.ts).
import type { HireRecord } from '@vsa/hire-kit';
import { RECEIPT_CHECKS, accepted, isPlainObject, parseDocument, parseOutputRef, refused, type ProtocolResult, type ReceiptCheck, type SubJob } from '../protocol/index.ts';
import { whereNotJson } from './where.ts';

const KEY_HASH = /^[0-9a-f]{56}$/;

/**
 * The sub-job of a hire record. `llm_receipt_failed` says that a check of the receipt is not true: the hire must not give a decision. `llm_bad_result` says that the record has a member that is
 * missing or has the wrong form. Both are codes of a hire that failed. The refusal never repeats a key or a value of the record.
 */
export function subJobOf(record: HireRecord): ProtocolResult<SubJob, 'llm_receipt_failed' | 'llm_bad_result'> {
  const bad = (what: string): ProtocolResult<never, 'llm_bad_result'> => refused('llm_bad_result', `the record of the hire has ${what}`);
  const checks: unknown = record.verification;
  if (typeof checks !== 'object' || checks === null) return bad('no verification');
  const verification: Partial<Record<ReceiptCheck, boolean>> = {};
  for (const check of RECEIPT_CHECKS) {
    const state = (checks as Record<string, unknown>)[check];
    if (typeof state !== 'boolean') return bad(`no result for the check ${check}`);
    verification[check] = state;
  }
  const failed = RECEIPT_CHECKS.filter((check) => verification[check] !== true);
  if (failed.length > 0) return refused('llm_receipt_failed', `the receipt did not pass the checks ${failed.join(', ')}`);

  const advertRef = parseOutputRef(record.advert_ref, 'advert_ref');
  if (!advertRef.ok) return bad(advertRef.detail);
  const escrowRef = parseOutputRef(record.escrow_ref, 'escrow_ref');
  if (!escrowRef.ok) return bad(escrowRef.detail);
  if (typeof record.supplier_pkh !== 'string' || !KEY_HASH.test(record.supplier_pkh)) return bad('a supplier key hash that is not 56 lower-case hex characters');
  if (typeof record.capability_id !== 'string' || record.capability_id === '') return bad('no capability');
  if (typeof record.receipt_signature !== 'string' || record.receipt_signature === '') return bad('no signature');
  const receipt = parseDocument(record.receipt, 'receipt');
  if (!receipt.ok) return bad(isPlainObject(record.receipt) ? `a receipt that ${whereNotJson(record.receipt)}` : 'a receipt that is not a JSON object');
  return accepted({
    capability_id: record.capability_id,
    advert_ref: advertRef.value,
    escrow_ref: escrowRef.value,
    supplier_pkh: record.supplier_pkh,
    receipt: receipt.value,
    receipt_signature: record.receipt_signature,
    verification: verification as Record<ReceiptCheck, boolean>,
  });
}
