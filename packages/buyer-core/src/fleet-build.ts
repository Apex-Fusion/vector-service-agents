// packages/buyer-core/src/fleet-build.ts
// The Post of a fleet job. The vendored planPostEscrow and buildPostEscrow (vendored/mcp/marketplace-build.ts) commit to a template payload
// (prompt_hash = promptHashForPayload(payload)), and buildPostEscrow refuses fleet capabilities on purpose: the hosted server cannot send a
// fleet job. A fleet supplier compares the prompt_hash of the escrow with its own hash of the request it receives, so the Document
// Pipeline computes that hash itself (commitments.ts) and posts with it. These two functions are the vendored ones with the payload
// replaced by that precomputed hash and without the fleet refusal; every other check and every number is the vendored logic, mirrored
// here because the vendored file is not edited: the refusals of the plan, deliver_by = posted_at + the window + DELIVER_BY_BUFFER_MS,
// validity from posted_at - 60 s until min(posted_at + the buffer, deliver_by - the window), the lock floor (escrowLockFloor, or
// identityEscrowLockFloor for the identity layout), the value cap F-29 in both layouts, the advert read in both layouts, the author check of a
// legacy advert, the listing rule of an identity-marketplace advert (the indexer lists it with its agent, assertIndexerLists, and the record of the
// agent passes the rule on chain, checkListingRule; both called, not copied), the coin selection that holds the collateral output back
// (reserveCollateralInputs) and the check that the escrow is output 0 (assertEscrowIsOutputZero). Nothing here signs or submits.
//
// Two layouts during the drain (Part 2 sections 6.1, 6.2, 6.5 and 9.6). A legacy advert (13 fields, at the legacy advert address) gets a legacy
// escrow (14 fields) at the legacy escrow address. An identity-marketplace advert (14 fields, at the advert address of the identity deployment)
// gets an identity-marketplace escrow (16 fields) at the escrow address of that deployment: its agent_id is the advert's, and its refund is the
// buyer's own address with no datum, so that anybody can Reclaim it to the buyer after deliver_by. Without a deployment, an identity-marketplace
// advert is refused by the advert read, with the words that name the settings.
import type { LucidEvolution, Provider, TxSignBuilder } from '@lucid-evolution/lucid';
import {
  advertTextFieldsRoundTrip, encodeEscrowDatum, encodeIdentityEscrowDatum, escrowLockFloor, formatOutRef, identityEscrowLockFloor, parseOutRef, requestSpecHash,
} from '@vsa/vector-read';
import type { AdvertDatum, EscrowDatum, IdentityAdvertDatum, IdentityEscrowDatum } from '@vsa/vector-read';
import { plutusAddressFromBech32 } from '@vsa/vector-read/identity-codec';
import { assertEscrowIsOutputZero, assertIndexerLists, checkListingRule, paymentKeyHashOf, reserveCollateralInputs } from './vendored/mcp/marketplace-build.ts';
import type { IdentityPostTerms } from './vendored/mcp/marketplace-build.ts';
import { toBuildResult } from './vendored/mcp/build.ts';
import { ensureSlotConfig } from './vendored/mcp/gov-build.ts';
import type { SlotClockProvider } from './vendored/mcp/gov-build.ts';
import { koiosTxInputCreds, readAdvert } from './vendored/mcp/marketplace-indexer.ts';
import type { AdvertRead } from './vendored/mcp/marketplace-indexer.ts';
import type { EscrowLayout } from './vendored/mcp/marketplace-lineage.ts';
import type { IdentityDeployment } from './vendored/mcp/identity-deployment.ts';
import { DELIVER_BY_BUFFER_MS, ESCROW_ADDRESS, MARKETPLACE_MIN_FEE, MAX_ESCROW_LOVELACE, MAX_PROCESSING_MS_CEILING } from './vendored/mcp/marketplace-constants.ts';
import { VECTOR_KOIOS_URL } from './vendored/mcp-shared/config.ts';
import { indexerFetch } from './indexer-fetch.ts';

export type { IdentityPostTerms } from './vendored/mcp/marketplace-build.ts';

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));
/** A prompt hash as the datum carries it and as the fleet supplier recomputes it: a sha256, lowercase hex. */
const PROMPT_HASH = /^[0-9a-f]{64}$/;
/** The Post is valid from this long before posted_at, so that a node a little behind still takes it (the vendored builder's validFrom). */
const VALID_BEFORE_MS = 60_000;

/** Is the advert the identity marketplace's (14 fields, Part 2 section 6.2): does it name its agent? */
export const isIdentityAdvert = (advert: AdvertDatum): advert is IdentityAdvertDatum => 'agent_id' in advert;

/**
 * What a Post on `advert` adds to the escrow in the identity layout (Part 2 sections 6.1 and 6.5): the agent the advert names, and the refund to
 * `buyerAddress`, the buyer's own address, with no datum. Undefined for a legacy advert, whose escrow has neither. Every chain of buyer-core
 * holds the enterprise address of its key, so a plan made with that address locks what the Post locks.
 */
export function fleetPostTerms(advert: AdvertDatum, buyerAddress: string): IdentityPostTerms | undefined {
  return isIdentityAdvert(advert) ? { agentId: advert.agent_id, refund: { address: plutusAddressFromBech32(buyerAddress), datum: null } } : undefined;
}

/** What a fleet Post writes and when it is valid. Times are POSIX milliseconds; the lock is in lovelace. */
export interface FleetPostPlan {
  /** The Open escrow datum: an IdentityEscrowDatum, with agent_id and refund, in the identity layout. */
  datum: EscrowDatum;
  /** The datum as the Post writes it into output 0: encodeEscrowDatum (legacy) or encodeIdentityEscrowDatum (identity). */
  datumHex: string;
  layout: EscrowLayout;
  /** Price and both bonds, raised to the min-UTxO floor of the escrow's largest (Submitted) datum. */
  lockLovelace: bigint;
  /** posted_at + the advert's window + DELIVER_BY_BUFFER_MS: from then on the buyer may Reclaim an escrow nobody submitted on. */
  deliverBy: number;
  /** The start of the Post's validity: posted_at - 60 s. */
  validFrom: number;
  /**
   * The Post is invalid after this: the latest moment it can land and still leave the supplier its full window before deliver_by. With the
   * deliver_by of this plan it is posted_at + DELIVER_BY_BUFFER_MS, so the validity range is 240 s, within the one hour every escrow builder
   * keeps to (Part 2 section 6.5).
   */
  validTo: number;
  postedAt: number;
}

/**
 * The unsigned fleet Post and what it locks; `escrowRef` is `<txHash>#0`, checked to be the escrow (assertEscrowIsOutputZero).
 * `collateralKept` is the vendored builder's flag: true when the wallet's smallest pure output of at least 5 units was held back, so it is
 * still there as collateral for the Accept and the Reclaim; false on the fallback to the whole wallet, when that output may be spent.
 * `layout` is the escrow's, `agentId` the agent it names (null for a legacy escrow), and `escrowAddress` where output 0 is.
 */
export interface FleetPostBuild {
  unsignedCborHex: string; escrowRef: string; lockLovelace: bigint; deliverBy: number; postedAt: number; datum: EscrowDatum; collateralKept: boolean;
  layout: EscrowLayout; agentId: string | null; escrowAddress: string;
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
 * Generic: an advert of any capability is planned, fleet or template. With `identity` (fleetPostTerms) the datum is the identity-marketplace
 * escrow, which names the advert's agent and the refund, and its lock is sized for the widest encoding of its Submitted datum. Throws a
 * readable Error for an advert it must not post against, as planPostEscrow does: retired, the buyer's own, a window that cannot work or is
 * longer than 24 h, an endpoint without a host, numbers the datum cannot hold (a negative amount in the identity layout), price and both bonds
 * above the value cap F-29 (10000000000 lovelace, in both layouts); and for a prompt hash that is not 64 lowercase hex characters.
 */
export function planFleetPostEscrow(advert: AdvertDatum, advertRef: string, buyerPkh: string, promptHash: string, nowMs: number, identity?: IdentityPostTerms): FleetPostPlan {
  if (advert.status !== 'Active') throw new Error(`Advert ${advertRef} is retired; pick another supplier.`);
  if (advert.supplier_pkh === buyerPkh) throw new Error('The buyer cannot be the supplier of the same advert.');
  if (typeof promptHash !== 'string' || !PROMPT_HASH.test(promptHash)) throw new Error('The prompt hash must be 64 lowercase hex characters (the sha256 of the request the supplier will receive).');
  if (!Number.isSafeInteger(nowMs)) throw new Error('nowMs must be a whole number of POSIX milliseconds');
  const ref = parseOutRef(advertRef);
  const window = advert.max_processing_ms;
  if (!Number.isInteger(window) || window < 0) throw new Error(`Advert ${advertRef} has an unusable processing window (${window} ms).`);
  if (window > MAX_PROCESSING_MS_CEILING) throw new Error(`Advert ${advertRef} advertises a processing window of ${window} ms, longer than the ${MAX_PROCESSING_MS_CEILING} ms (24 h) a Post will hold a lock for.`);
  assertEndpointHost(advert.endpoint_url, advertRef);
  const deliverBy = nowMs + window + DELIVER_BY_BUFFER_MS;
  if (!Number.isSafeInteger(deliverBy)) throw new Error(`deliver_by must leave the supplier its full window of ${window} ms`);
  // Valid until the earlier of the buffer after posted_at and the last moment that leaves the supplier its full window before deliver_by.
  // With deliver_by = posted_at + the window + the buffer the two are the same moment.
  const validTo = Math.min(nowMs + DELIVER_BY_BUFFER_MS, deliverBy - window);
  const legacy: EscrowDatum = {
    buyer_pkh: buyerPkh, supplier_pkh: advert.supplier_pkh,
    advert_ref: { txHash: ref.txHash, index: ref.outputIndex }, capability_id: advert.capability_id,
    request_spec_hash: requestSpecHash(advert), prompt_hash: promptHash,
    payment_lovelace: advert.price_lovelace, buyer_bond_lovelace: advert.buyer_bond_lovelace, supplier_bond_lovelace: advert.supplier_bond_lovelace,
    deliver_by: deliverBy, posted_at: nowMs, submitted_at: null, result_receipt_hash: null, state: 'Open',
  };
  const economic = advert.price_lovelace + advert.buyer_bond_lovelace + advert.supplier_bond_lovelace;
  // The advert's numbers are the supplier's to choose. The datum writer refuses what it cannot frame (negative, past uint64); say so in terms of the advert.
  const unfit = (why: string) => new Error(`Advert ${advertRef} cannot be posted: its terms do not fit an escrow datum (${why}).`);
  let datum: EscrowDatum = legacy;
  let datumHex: string;
  let lockLovelace: bigint;
  if (identity === undefined) {
    try { lockLovelace = escrowLockFloor(legacy, economic); datumHex = encodeEscrowDatum(legacy); } catch (err) { throw unfit(errorText(err)); }
  } else {
    // The identity escrow's Claim needs each amount at least 0 (Part 2 section 6.1, the value cap); the cap below bounds the rest.
    if (advert.price_lovelace < 0n || advert.buyer_bond_lovelace < 0n || advert.supplier_bond_lovelace < 0n) throw unfit('a negative amount');
    const identityDatum: IdentityEscrowDatum = { ...legacy, agent_id: identity.agentId, refund: identity.refund };
    try { lockLovelace = identityEscrowLockFloor(identityDatum, economic); datumHex = encodeIdentityEscrowDatum(identityDatum); } catch (err) { throw unfit(errorText(err)); }
    datum = identityDatum;
  }
  // The value cap F-29 (Part 2 sections 6.1 and 6.5): an identity-marketplace escrow above it cannot be claimed, and the indexer lists no such advert.
  if (economic > MAX_ESCROW_LOVELACE) {
    throw new Error(`Advert ${advertRef} asks for price + both bonds of ${economic} lovelace, above the ${MAX_ESCROW_LOVELACE} lovelace value cap of an escrow (F-29): such an escrow cannot be claimed, so it is not built.`);
  }
  return { datum, datumHex, layout: identity === undefined ? 'legacy' : 'identity', lockLovelace, deliverBy, validFrom: nowMs - VALID_BEFORE_MS, validTo, postedAt: nowMs };
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
 * the vendored buildPostEscrow but for the fleet refusal and the payload: reads the advert from Koios in either layout (readAdvert, the
 * identity layout with `deployment`) and refuses one that is spent, not reported unspent or not valid UTF-8; plans the Post
 * (planFleetPostEscrow); for a legacy advert, refuses one not created by its supplier key; for an identity-marketplace advert, refuses one the
 * indexer does not list with its agent (assertIndexerLists) or whose agent fails the listing rule on chain over the Post's validity
 * (checkListingRule: a live, independent, Active record that lists the supplier key with the transaction purpose and the capability), and
 * posts at the deployment's escrow address with the refund to `changeAddress`; builds it without the wallet's smallest pure 5-unit output when
 * it can, so that output stays as collateral for the Accept and the Reclaim, and from the whole wallet otherwise; checks that the escrow is
 * output 0. `koiosUrl` is the Koios base without /api/v1 (default VECTOR_KOIOS_URL) and `indexerUrl` the marketplace indexer (default the
 * configured one), additions to the vendored arguments so that one chain reads from one Koios and one indexer; `fetchImpl` stands in for fetch
 * in the Koios and indexer calls. Nothing is signed or submitted.
 */
export async function buildFleetPostEscrow(
  lucid: LucidEvolution, provider: Provider,
  args: { changeAddress: string; advertRef: string; promptHash: string; nowMs?: number; koiosUrl?: string; indexerUrl?: string; deployment?: IdentityDeployment | null },
  fetchImpl: typeof fetch = fetch,
): Promise<FleetPostBuild> {
  const koiosUrl = args.koiosUrl ?? VECTOR_KOIOS_URL;
  const deployment = args.deployment ?? null;
  const buyerPkh = paymentKeyHashOf(args.changeAddress);
  let read: AdvertRead;
  try { read = await readAdvert(args.advertRef, fetchImpl, koiosUrl, deployment?.advert.address ?? null); } catch (err) { throw new Error(`Could not read advert ${args.advertRef.trim()}: ${errorText(err)}`); }
  if ('error' in read) throw new Error(read.error);
  const { utxo } = read;
  const advertRef = formatOutRef(utxo.tx_hash.toLowerCase(), utxo.tx_index);
  if (read.spent) throw new Error(`Advert ${advertRef} has been spent (its supplier retired or replaced it); pick another advert.`);
  if (utxo.is_spent !== false) throw new Error(`Koios did not report whether advert ${advertRef} is unspent; refusing to hire it.`);
  const advertDatumHex = utxo.inline_datum?.bytes;
  if (!advertDatumHex || !advertTextFieldsRoundTrip(advertDatumHex)) throw new Error(`Advert ${advertRef} has text fields that are not valid UTF-8, so the escrow could not carry its capability id faithfully; refusing to hire it.`);
  const nowMs = args.nowMs ?? Date.now();
  let plan: FleetPostPlan;
  let escrowAddress: string;
  if (read.layout === 'legacy') {
    plan = planFleetPostEscrow(read.advert, advertRef, buyerPkh, args.promptHash, nowMs);
    await assertAdvertAuthor(koiosUrl, advertRef, utxo.tx_hash, read.advert.supplier_pkh, fetchImpl);
    escrowAddress = ESCROW_ADDRESS;
  } else {
    if (deployment === null) throw new Error('An identity-marketplace advert needs the identity deployment.'); // readAdvert reads one only with it
    plan = planFleetPostEscrow(read.advert, advertRef, buyerPkh, args.promptHash, nowMs, { agentId: read.agentId, refund: { address: plutusAddressFromBech32(args.changeAddress), datum: null } });
    await assertIndexerLists(advertRef, read.agentId, indexerFetch(args.indexerUrl, fetchImpl));
    await checkListingRule(provider, deployment, read.advert, advertRef, { lo: plan.validFrom, hi: plan.validTo });
    escrowAddress = deployment.escrow.address;
  }

  await ensureSlotConfig(provider as unknown as SlotClockProvider);
  // A fresh builder per attempt: one that failed in complete() is not reused.
  const assemble = () => lucid.newTx()
    .pay.ToAddressWithData(escrowAddress, { kind: 'inline', value: plan.datumHex }, { lovelace: plan.lockLovelace })
    .addSignerKey(buyerPkh)
    .validFrom(plan.validFrom)
    .validTo(plan.validTo)
    .setMinFee(MARKETPLACE_MIN_FEE);
  // The Post runs no script. Accept and Reclaim spend one and need a pure output of at least 5 units as collateral, so the smallest such
  // output is held back when the rest can cover the Post; when it cannot, or the reserved selection does not complete, the Post draws on the whole wallet.
  const inputs = reserveCollateralInputs(await lucid.wallet().getUtxos(), plan.lockLovelace);
  let completed: TxSignBuilder | undefined;
  let reservedFailure: unknown;
  if (inputs) {
    try { completed = await assemble().complete({ presetWalletInputs: inputs }); } catch (err) { reservedFailure = err; /* retried below with the whole wallet */ }
  }
  const collateralKept = completed !== undefined;
  if (!completed) {
    try { completed = await assemble().complete({}); } catch (err) {
      // The whole-wallet attempt is the one whose words the caller gets; why the reserved selection was given up on stays attached.
      throw inputs ? new Error(errorText(err), { cause: reservedFailure }) : err;
    }
  }
  const built = toBuildResult(completed);
  assertEscrowIsOutputZero(built.txCbor, { datumHex: plan.datumHex, lockLovelace: plan.lockLovelace, address: escrowAddress });
  return {
    unsignedCborHex: built.txCbor, escrowRef: formatOutRef(built.txHash, 0), lockLovelace: plan.lockLovelace, deliverBy: plan.deliverBy, postedAt: plan.postedAt,
    datum: plan.datum, collateralKept, layout: plan.layout, agentId: read.layout === 'identity' ? read.agentId : null, escrowAddress,
  };
}
