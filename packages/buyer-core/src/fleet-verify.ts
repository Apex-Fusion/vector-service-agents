// packages/buyer-core/src/fleet-verify.ts
// The check of a fleet sub-receipt, run on every one before the Pipeline accepts its escrow. It asks what the hosted server's verifier asks (the vendored
// verifyReceipt, src/vendored/mcp/marketplace-verify.ts), with one difference. That verifier compares receipt.response_hash with the sha256 of the result
// TEXT it is given, and a fleet supplier does not hash the text: it hashes a canonical envelope ({content, output_format} for an OCR page, {output, status,
// incomplete_details} for a chat answer; src/commitments.ts). So the buyer recomputes that hash from what the supplier returned and passes it in.
// Four rows are the vendored verifier's own, and they are called and not copied, so the key hash, the Ed25519 check, the comparison with the hash on chain
// and the prompt hash cannot drift from the hosted server's. Three rows are this module's:
//   escrow_ref_matches     both refs go through canonicalRef; the vendored row wants the receipt's ref spelled as the caller's, character for character
//   response_hash_matches  against the recomputed hash, which is an input here
//   model_matches          the vendored verifier has no such row
// The vendored call is made inside a try (vendoredRows): it can throw on a receipt the supplier sends, and nothing about a receipt may throw out of this module.
import { verifyReceipt } from './vendored/mcp/marketplace-verify.ts';
import type { Receipt } from './fleet-clients.ts';
import { isRecord, sameRef } from './guards.ts';

export interface FleetVerifyInput {
  /** The escrow the job was hired under (`<txid>#<index>`). The receipt must name it. Refs are compared as refs, so the spelling of the hex does not matter. */
  escrowRef: string;
  /** The receipt exactly as the supplier gave it. Untrusted: a value that is not an object fails the checks that read it, and nothing throws. */
  receipt: Receipt;
  /** The supplier's signature, as it wrote it (the hash on chain covers that exact string): 64 bytes of hex. */
  receiptSignature: string;
  /** The response hash the BUYER recomputed from the result the supplier returned, with the fleet's commitment (ocrResponseHash, responsesResponseHash). */
  responseHashHex: string;
  /** The prompt hash the buyer committed to in the escrow datum (ocrPromptHash, responsesPromptHash). */
  promptHashHex: string;
  /** The supplier's public key as its GET /capability serves it: 32 bytes of hex. The supplier's word, held to `supplierPkhExpected` by the key check. */
  supplierPubKeyHex: string;
  /** The key hash the buyer's escrow names: the supplier_pkh of the escrow's datum. */
  supplierPkhExpected: string;
  /** The model the advert names. The receipt must name the same one, exactly. */
  model: string;
  /**
   * The result_receipt_hash of the escrow's Submitted output (`Chain.onChainReceiptHash`), or null when there is none to read. It is called once per
   * verification, whatever the other checks say. When it throws or rejects, verifyFleetReceipt rejects with that error. When it resolves anything but a string
   * or null it has broken its contract, and the on-chain row fails.
   */
  onChainReceiptHash: () => Promise<string | null>;
}

export interface FleetVerification {
  verdict: 'VERIFIED' | 'FAILED' | 'INCOMPLETE';
  checks: {
    /** (1) receipt.escrow_ref names the escrow the job was hired under. */
    escrow_ref_matches: 'pass' | 'fail';
    /** (2) receipt.response_hash is the recomputed envelope hash. */
    response_hash_matches: 'pass' | 'fail';
    /** (3) the supplier's public key hashes to receipt.supplier_pkh AND to the key hash the buyer's escrow names. */
    supplier_key_matches: 'pass' | 'fail';
    /** (4) the Ed25519 signature verifies over utf8(canonicalize(receipt)) under that key. */
    signature_valid: 'pass' | 'fail';
    /** (5) the hash on chain is sha256(canonicalize({receipt, signature})); `skipped` when there is none to compare. */
    on_chain_hash_matches: 'pass' | 'fail' | 'skipped';
    /** (6) receipt.prompt_hash is the prompt hash of the escrow: the receipt is for the request the buyer committed to. */
    prompt_hash_matches: 'pass' | 'fail';
    /** (7) receipt.model is the model of the advert. */
    model_matches: 'pass' | 'fail';
  };
}

const HEX64 = /^[0-9a-f]{64}$/i;
const passIf = (ok: boolean): 'pass' | 'fail' => (ok ? 'pass' : 'fail');

/** Is the digest the receipt names the one the buyer computed? The spelling of the hex does not matter; a value that is no digest matches nothing, not even itself. */
function sameDigest(claimed: unknown, computed: unknown): boolean {
  return typeof claimed === 'string' && HEX64.test(claimed) && typeof computed === 'string' && claimed.toLowerCase() === computed.toLowerCase();
}

type VendoredRows = Pick<FleetVerification['checks'], 'supplier_key_matches' | 'signature_valid' | 'on_chain_hash_matches' | 'prompt_hash_matches'>;

/**
 * The four rows the vendored verifier owns. Its escrow_ref row is not used (check 1 is made in verifyFleetReceipt) and no result text is passed, which skips
 * the one text check that does not apply to an envelope hash (check 2 is made there too).
 *
 * The call is made inside a try, because it can throw on a receipt the supplier sends. The vendored function is documented as one that never throws, and it
 * does not hold to that: canonicalize recurses, a receipt nested deeper than the stack allows makes it throw a RangeError, and the vendored signature row has a
 * guard for that where its on-chain row has none. A supplier can send such a receipt (the poll takes a body of a million bytes, which holds a hundred thousand
 * levels). A receipt that cannot be walked verifies nothing, so on a throw the four rows fail, and the on-chain row is skipped only when there was no hash to
 * compare, as it is when the call returns.
 */
function vendoredRows(input: FleetVerifyInput, hashOnChain: string | null): VendoredRows {
  try {
    const rows = verifyReceipt({
      receipt: input.receipt, signature: input.receiptSignature, escrowRef: input.escrowRef, supplierPubKeyHex: input.supplierPubKeyHex,
      escrowSupplierPkh: input.supplierPkhExpected, escrowPromptHash: input.promptHashHex, resultReceiptHashOnChain: hashOnChain,
    }).checks;
    return {
      supplier_key_matches: passIf(rows.supplier_key_matches.state === 'pass'),
      signature_valid: passIf(rows.signature_valid.state === 'pass'),
      on_chain_hash_matches: rows.on_chain_hash_matches.state === 'skipped' ? 'skipped' : passIf(rows.on_chain_hash_matches.state === 'pass'),
      prompt_hash_matches: passIf(rows.prompt_hash_matches.state === 'pass'),
    };
  } catch {
    return { supplier_key_matches: 'fail', signature_valid: 'fail', on_chain_hash_matches: hashOnChain === null ? 'skipped' : 'fail', prompt_hash_matches: 'fail' };
  }
}

/**
 * Runs the seven checks on the receipt of a fleet sub-job and gives the verdict: `VERIFIED` only when all seven pass, `FAILED` when any fails, and
 * `INCOMPLETE` when none fails and the hash on chain could not be compared (`onChainReceiptHash` returned null, so check 5 was skipped). Only `VERIFIED`
 * is a receipt to accept an escrow on.
 *
 * The receipt is the supplier's own account of the job, and so are its signature and its public key: whatever they are, a check that cannot be made on
 * them fails and nothing throws. That holds for a receipt that cannot be walked at all, one nested deeper than the stack allows, which a supplier can send
 * within the size the poll accepts: the vendored call throws on it, and the four rows it owns fail (see vendoredRows). The one rejection is not about the
 * receipt. `onChainReceiptHash` is awaited once, whatever the other checks say, before anything is hashed, and an error from it is not caught: the call
 * rejects with that error and makes no verdict, because a read that failed says nothing about the receipt. The caller (the orchestrator, which asks again
 * while the indexer catches up with the supplier's Submit) decides what to do with it. A read that resolves anything but a string or null has broken the
 * contract of the callback; that is a failed on-chain row and not a rejection.
 */
export async function verifyFleetReceipt(input: FleetVerifyInput): Promise<FleetVerification> {
  const hashOnChain = await input.onChainReceiptHash();
  // The read is typed string or null. One that resolves anything else has broken that: the on-chain row fails, and the vendored call is told there is no hash,
  // so that it is not handed a value it would call .toLowerCase on.
  const brokenRead = hashOnChain !== null && typeof hashOnChain !== 'string';
  const receipt = isRecord(input.receipt) ? input.receipt : null;
  const vendored = vendoredRows(input, brokenRead ? null : hashOnChain);

  const checks: FleetVerification['checks'] = {
    escrow_ref_matches: passIf(receipt !== null && sameRef(receipt.escrow_ref, input.escrowRef)),
    response_hash_matches: passIf(receipt !== null && sameDigest(receipt.response_hash, input.responseHashHex)),
    supplier_key_matches: vendored.supplier_key_matches,
    signature_valid: vendored.signature_valid,
    on_chain_hash_matches: brokenRead ? 'fail' : vendored.on_chain_hash_matches,
    prompt_hash_matches: vendored.prompt_hash_matches,
    model_matches: passIf(receipt !== null && typeof receipt.model === 'string' && receipt.model === input.model),
  };
  const states = Object.values(checks);
  return { verdict: states.includes('fail') ? 'FAILED' : states.includes('skipped') ? 'INCOMPLETE' : 'VERIFIED', checks };
}
