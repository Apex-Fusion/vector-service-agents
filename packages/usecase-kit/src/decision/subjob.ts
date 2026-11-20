// packages/usecase-kit/src/decision/subjob.ts
// The sub-job of a decision: the hire of the model, as the protocol writes it. hire-kit runs the eight checks of the receipt and accepts the escrow only when all eight pass. This file does not trust
// that: it builds the `SubJob` from the record of the hire, and it refuses a record in which one of the eight checks is missing or is not true. A refusal here is never a pass.
//
// Every member of the sub-job is checked for its form: the references (`<64 hex>#<index>`), the key hash (56 lower-case hex characters), the capability, the signature and the receipt. The receipt is
// returned as a new copy of plain JSON data. The supplier writes the receipt, so a refusal of the receipt says where, by depth, and repeats no key and no value (see where.ts).
//
// A refusal of the record comes after the Accept: the hire was paid. `unrecordedOf` keeps what can still be recorded of it, so that the failure of the decision says that the escrow was paid.
import type { HireRecord } from '@vsa/hire-kit';
import {
  RECEIPT_CHECKS, accepted, isKeyHash, isPlainObject, parseDocument, parseOutputRef, refused, type OutputRef, type ProtocolResult, type ReceiptCheck, type ReceiptVerification, type SubJob,
} from '../protocol/index.ts';
import type { UnrecordedDelivery } from './result.ts';
import { whereNotJson } from './where.ts';

/** The eight checks as booleans, in the order of the protocol, or a refusal that says what is missing. A check that is not true is still a boolean here: the caller decides what it means. */
function checksOf(checks: unknown): ProtocolResult<ReceiptVerification, 'bad_checks'> {
  if (typeof checks !== 'object' || checks === null) return refused('bad_checks', 'no verification');
  const verification: Partial<Record<ReceiptCheck, boolean>> = {};
  for (const check of RECEIPT_CHECKS) {
    const state: unknown = Reflect.get(checks, check);
    if (typeof state !== 'boolean') return refused('bad_checks', `no result for the check ${check}`);
    verification[check] = state;
  }
  return accepted(verification as ReceiptVerification);
}

/**
 * The sub-job of a hire record. `llm_receipt_failed` says that a check of the receipt is not true: the hire must not give a decision. `llm_bad_result` says that the record has a member that is
 * missing or has the wrong form. Both are codes of a hire that failed. The refusal never repeats a key or a value of the record.
 */
export function subJobOf(record: HireRecord): ProtocolResult<SubJob, 'llm_receipt_failed' | 'llm_bad_result'> {
  const bad = (what: string): ProtocolResult<never, 'llm_bad_result'> => refused('llm_bad_result', `the record of the hire has ${what}`);
  const checks = checksOf(record.verification);
  if (!checks.ok) return bad(checks.detail);
  const failed = RECEIPT_CHECKS.filter((check) => checks.value[check] !== true);
  if (failed.length > 0) return refused('llm_receipt_failed', `the receipt did not pass the checks ${failed.join(', ')}`);

  const advertRef = parseOutputRef(record.advert_ref, 'advert_ref');
  if (!advertRef.ok) return bad(advertRef.detail);
  const escrowRef = parseOutputRef(record.escrow_ref, 'escrow_ref');
  if (!escrowRef.ok) return bad(escrowRef.detail);
  if (!isKeyHash(record.supplier_pkh)) return bad('a supplier key hash that is not 56 lower-case hex characters');
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
    verification: checks.value,
  });
}

/**
 * What can be recorded of a hire that was paid, when `subJobOf` refuses its record. Each member is read by itself with the form check of the sub-job, and a member that is not right is null. The
 * receipt is never copied. `escrow` is the reference that the ledger was told at the Post: it stands for the escrow when the record has none that can be read. It never throws, also when the record
 * is not an object or a member cannot be read.
 */
export function unrecordedOf(record: unknown, how: 'confirmed' | 'pending', escrow: OutputRef | null): UnrecordedDelivery {
  const members = isPlainObject(record) ? record : {};
  const read = (name: string): unknown => {
    try {
      return members[name];
    } catch {
      return undefined;
    }
  };
  const escrowRef = parseOutputRef(read('escrow_ref'), 'escrow_ref');
  const advertRef = parseOutputRef(read('advert_ref'), 'advert_ref');
  const pkh = read('supplier_pkh');
  const checks = checksOf(read('verification'));
  return {
    sub_job: null,
    receipt: 'not_recordable',
    accepted: how,
    escrow_ref: escrowRef.ok ? escrowRef.value : escrow,
    advert_ref: advertRef.ok ? advertRef.value : null,
    supplier_pkh: isKeyHash(pkh) ? pkh : null,
    verification: checks.ok ? checks.value : null,
  };
}
