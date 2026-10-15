// packages/buyer-core/src/fleet-build.ts
// The Post of a fleet job. The vendored planPostEscrow and buildPostEscrow (vendored/mcp/marketplace-build.ts) commit to a template payload
// (prompt_hash = promptHashForPayload(payload)), and buildPostEscrow refuses fleet capabilities on purpose: the hosted server cannot send a
// fleet job. A fleet supplier compares the prompt_hash of the escrow with its own hash of the request it receives, so the Document
// Pipeline computes that hash itself (commitments.ts) and posts with it. These two functions are the vendored ones with the payload
// replaced by that precomputed hash and without the fleet refusal; every other check and every number is the vendored logic, mirrored
// here because the vendored file is not edited: the refusals of the plan, deliver_by = posted_at + the window + DELIVER_BY_BUFFER_MS,
// validity until min(posted_at + the buffer, deliver_by - the window), the lock floor (escrowLockFloor), the advert read and its author
// check, the coin selection that holds the collateral output back (reserveCollateralInputs) and the check that the escrow is output 0
// (assertEscrowIsOutputZero). Nothing here signs or submits.
import type { LucidEvolution, Provider, TxSignBuilder } from '@lucid-evolution/lucid';
import { advertTextFieldsRoundTrip, encodeEscrowDatum, escrowLockFloor, formatOutRef, parseOutRef, requestSpecHash } from '@vsa/vector-read';
import type { AdvertDatum, EscrowDatum } from '@vsa/vector-read';
import { assertEscrowIsOutputZero, paymentKeyHashOf, reserveCollateralInputs } from './vendored/mcp/marketplace-build.ts';
import { toBuildResult } from './vendored/mcp/build.ts';
import { ensureSlotConfig } from './vendored/mcp/gov-build.ts';
import type { SlotClockProvider } from './vendored/mcp/gov-build.ts';
import { koiosTxInputCreds, readAdvert } from './vendored/mcp/marketplace-indexer.ts';
import { DELIVER_BY_BUFFER_MS, ESCROW_ADDRESS, MARKETPLACE_MIN_FEE, MAX_PROCESSING_MS_CEILING } from './vendored/mcp/marketplace-constants.ts';
import { VECTOR_KOIOS_URL } from './vendored/mcp-shared/config.ts';

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));
/** A prompt hash as the datum carries it and as the fleet supplier recomputes it: a sha256, lowercase hex. */
const PROMPT_HASH = /^[0-9a-f]{64}$/;

/** What a fleet Post writes and when it is valid. Times are POSIX milliseconds; the lock is in lovelace. */
export interface FleetPostPlan {
  /** The Open escrow datum, as encodeEscrowDatum writes it into output 0. */
  datum: EscrowDatum;
  /** Price and both bonds, raised to the min-UTxO floor of the escrow's largest (Submitted) datum. */
  lockLovelace: bigint;
  /** posted_at + the advert's window + DELIVER_BY_BUFFER_MS: from then on the buyer may Reclaim an escrow nobody submitted on. */
  deliverBy: number;
  /** The Post is invalid after this: the latest moment it can land and still leave the supplier its full window before deliver_by. */
  validTo: number;
  postedAt: number;
}

/** The unsigned fleet Post and what it locks; `escrowRef` is `<txHash>#0`, checked to be the escrow (assertEscrowIsOutputZero). */
export interface FleetPostBuild {
  unsignedCborHex: string; escrowRef: string; lockLovelace: bigint; deliverBy: number; postedAt: number; datum: EscrowDatum;
}

/** The vendored planPostEscrow refuses an advert whose endpoint is not a usable URL with a host (endpointHostOf, private there); so does this. */
function assertEndpointHost(endpointUrl: string, advertRef: string): void {
  let host = '';
  try { host = new URL(endpointUrl).host; } catch { /* refused below */ }
  if (!host) throw new Error(`Advert ${advertRef} has an endpoint that is not a usable URL with a host, so a job could not be delivered to it.`);
}

/**
 * Pure. The escrow datum a fleet Post writes, its lock and its times: the vendored planPostEscrow with `promptHash` (the hash of the
 * request the supplier will receive, computed by the caller) in place of the hash of a template payload, and no caller-chosen deliver_by.
 * Generic: an advert of any capability is planned, fleet or template. Throws a readable Error for an advert it must not post against, as
 * planPostEscrow does: retired, the buyer's own, a window that cannot work or is longer than 24 h, an endpoint without a host, numbers the
 * datum cannot hold; and for a prompt hash that is not 64 lowercase hex characters.
 */
export function planFleetPostEscrow(advert: AdvertDatum, advertRef: string, buyerPkh: string, promptHash: string, nowMs: number): FleetPostPlan {
  if (advert.status !== 'Active') throw new Error(`Advert ${advertRef} is retired; pick another supplier.`);
  if (advert.supplier_pkh === buyerPkh) throw new Error('The buyer cannot be the supplier of the same advert.');
  if (typeof promptHash !== 'string' || !PROMPT_HASH.test(promptHash)) throw new Error('The prompt hash must be 64 lowercase hex characters (the sha256 of the request the supplier will receive).');
  if (!Number.isSafeInteger(nowMs)) throw new Error('nowMs must be a whole number of POSIX milliseconds');
  const ref = parseOutRef(advertRef);
  const window = advert.max_processing_ms;
  if (!Number.isInteger(window) || window < 0) throw new Error(`Advert ${advertRef} has an unusable processing window (${window} ms).`);
  if (window > MAX_PROCESSING_MS_CEILING) throw new Error(`Advert ${advertRef} advertises a processing window of ${window} ms, longer than the ${MAX_PROCESSING_MS_CEILING} ms (24 h) a Post will lock funds for.`);
  assertEndpointHost(advert.endpoint_url, advertRef);
  const deliverBy = nowMs + window + DELIVER_BY_BUFFER_MS;
  if (!Number.isSafeInteger(deliverBy)) throw new Error(`deliver_by must leave the supplier its full window of ${window} ms`);
  // Valid until the earlier of the buffer after posted_at and the last moment that leaves the supplier its full window before deliver_by.
  // With deliver_by = posted_at + the window + the buffer the two are the same moment.
  const validTo = Math.min(nowMs + DELIVER_BY_BUFFER_MS, deliverBy - window);
  const datum: EscrowDatum = {
    buyer_pkh: buyerPkh, supplier_pkh: advert.supplier_pkh,
    advert_ref: { txHash: ref.txHash, index: ref.outputIndex }, capability_id: advert.capability_id,
    request_spec_hash: requestSpecHash(advert), prompt_hash: promptHash,
    payment_lovelace: advert.price_lovelace, buyer_bond_lovelace: advert.buyer_bond_lovelace, supplier_bond_lovelace: advert.supplier_bond_lovelace,
    deliver_by: deliverBy, posted_at: nowMs, submitted_at: null, result_receipt_hash: null, state: 'Open',
  };
  const economic = advert.price_lovelace + advert.buyer_bond_lovelace + advert.supplier_bond_lovelace;
  let lockLovelace: bigint;
  try { lockLovelace = escrowLockFloor(datum, economic); } catch (err) { throw new Error(`Advert ${advertRef} cannot be posted: its terms do not fit an escrow datum (${errorText(err)}).`); }
  return { datum, lockLovelace, deliverBy, validTo, postedAt: nowMs };
}

/**
 * The advert validator does not check who creates an advert, so the supplier_pkh inside one proves nothing by itself: an input of the
 * creating transaction that belongs to that key proves the supplier signed it. The vendored builder's check (assertAdvertAuthor, private
 * there), asking the Koios this Post reads from.
 */
async function assertAdvertAuthor(koiosUrl: string, advertRef: string, creatingTxHash: string, supplierPkh: string, fetchImpl: typeof fetch): Promise<void> {
  let creds: string[];
  try { creds = await koiosTxInputCreds(koiosUrl, creatingTxHash, fetchImpl); } catch (err) { throw new Error(`Could not check who created advert ${advertRef}: ${errorText(err)}`); }
  if (!creds.includes(supplierPkh)) throw new Error(`Advert ${advertRef} was not created by its supplier key: no input of the transaction that created it belongs to ${supplierPkh}. Refusing to hire it.`);
}

/**
 * Builds the unsigned fleet Post: locks price and both bonds in a new escrow at output 0 for the advert, committing to `promptHash`. Mirrors
 * the vendored buildPostEscrow but for the fleet refusal and the payload: reads the advert from Koios (readAdvert) and refuses one that is
 * spent, not reported unspent, not valid UTF-8 or not created by its supplier key; plans the Post (planFleetPostEscrow); funds it without
 * the wallet's smallest pure 5-unit output when it can, so that output stays as collateral for the Accept and the Reclaim, and from the
 * whole wallet otherwise; checks that the escrow is output 0. `koiosUrl` is the Koios base without /api/v1 (default VECTOR_KOIOS_URL), an
 * addition to the vendored arguments so that one chain reads from one Koios; `fetchImpl` stands in for fetch in the two Koios calls.
 * Nothing is signed or submitted.
 */
export async function buildFleetPostEscrow(
  lucid: LucidEvolution, provider: Provider,
  args: { changeAddress: string; advertRef: string; promptHash: string; nowMs?: number; koiosUrl?: string },
  fetchImpl: typeof fetch = fetch,
): Promise<FleetPostBuild> {
  const koiosUrl = args.koiosUrl ?? VECTOR_KOIOS_URL;
  const buyerPkh = paymentKeyHashOf(args.changeAddress);
  let read: Awaited<ReturnType<typeof readAdvert>>;
  try { read = await readAdvert(args.advertRef, fetchImpl, koiosUrl); } catch (err) { throw new Error(`Could not read advert ${args.advertRef.trim()}: ${errorText(err)}`); }
  if ('error' in read) throw new Error(read.error);
  const { utxo, advert } = read;
  const advertRef = formatOutRef(utxo.tx_hash.toLowerCase(), utxo.tx_index);
  if (read.spent) throw new Error(`Advert ${advertRef} has been spent (its supplier retired or replaced it); pick another advert.`);
  if (utxo.is_spent !== false) throw new Error(`Koios did not report whether advert ${advertRef} is unspent; refusing to hire it.`);
  const advertDatumHex = utxo.inline_datum?.bytes;
  if (!advertDatumHex || !advertTextFieldsRoundTrip(advertDatumHex)) throw new Error(`Advert ${advertRef} has text fields that are not valid UTF-8, so the escrow could not carry its capability id faithfully; refusing to hire it.`);
  const nowMs = args.nowMs ?? Date.now();
  const plan = planFleetPostEscrow(advert, advertRef, buyerPkh, args.promptHash, nowMs);
  await assertAdvertAuthor(koiosUrl, advertRef, utxo.tx_hash, advert.supplier_pkh, fetchImpl);

  await ensureSlotConfig(provider as unknown as SlotClockProvider);
  const escrowDatumHex = encodeEscrowDatum(plan.datum);
  // A fresh builder per attempt: one that failed in complete() is not reused.
  const assemble = () => lucid.newTx()
    .pay.ToAddressWithData(ESCROW_ADDRESS, { kind: 'inline', value: escrowDatumHex }, { lovelace: plan.lockLovelace })
    .addSignerKey(buyerPkh)
    .validFrom(nowMs - 60_000)
    .validTo(plan.validTo)
    .setMinFee(MARKETPLACE_MIN_FEE);
  // The Post runs no script. Accept and Reclaim spend one and need a pure output of at least 5 units as collateral, so the smallest such
  // output is held back when the rest can pay; when it cannot, or the reserved selection does not complete, the whole wallet funds it.
  const inputs = reserveCollateralInputs(await lucid.wallet().getUtxos(), plan.lockLovelace);
  let completed: TxSignBuilder | undefined;
  let reservedFailure: unknown;
  if (inputs) {
    try { completed = await assemble().complete({ presetWalletInputs: inputs }); } catch (err) { reservedFailure = err; /* retried below with the whole wallet */ }
  }
  if (!completed) {
    try { completed = await assemble().complete({}); } catch (err) {
      // The whole-wallet attempt is the one whose words the caller gets; why the reserved selection was given up on stays attached.
      throw inputs ? new Error(errorText(err), { cause: reservedFailure }) : err;
    }
  }
  const built = toBuildResult(completed);
  assertEscrowIsOutputZero(built.txCbor, { datumHex: escrowDatumHex, lockLovelace: plan.lockLovelace });
  return { unsignedCborHex: built.txCbor, escrowRef: formatOutRef(built.txHash, 0), lockLovelace: plan.lockLovelace, deliverBy: plan.deliverBy, postedAt: plan.postedAt, datum: plan.datum };
}
