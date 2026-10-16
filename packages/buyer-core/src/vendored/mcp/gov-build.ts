// Keyless build core for the self-improvement family (spec PR 8).
// Constructs UNSIGNED transactions only. The user's key never enters this
// package: signing happens on the local signer (packages/signer), submission
// via vector_submit_transaction. Constants, datum parsers, token-name
// derivation, and helpers here are transcribed from the (still custodial,
// pending Task 5) packages/builder/src/vector/self-improvement.ts, typed and
// with instanceof Constr guards added to the parsers - datum field indices
// and Data.to/Constr layouts are otherwise unchanged, since the deployed
// module validators parse these exact bytes.
import {
  fromText, toText, Data, Constr, credentialToAddress, getAddressDetails, SLOT_CONFIG_NETWORK,
} from '@lucid-evolution/lucid';
import type { LucidEvolution, UTxO } from '@lucid-evolution/lucid';

// ─── Slot/time config ───────────────────────────────────────────────────────

// Minimal provider surface needed for slot/time queries. OgmiosProvider
// satisfies this at runtime; the base Lucid `Provider` interface does not
// declare either method (they are OgmiosProvider-specific additions), so
// build functions that only take a `lucid` recover this surface via
// slotClockOf() below rather than taking a redundant provider parameter.
export interface SlotClockProvider {
  getSystemStartMs(): Promise<number>;
  getNetworkTip?(): Promise<{ slot: number; hash?: string }>;
}

// Recovers the provider a LucidEvolution instance was built with (Lucid()'s
// own config closure returns the exact same reference it was constructed
// with - see @lucid-evolution/lucid's Lucid() factory). Lets build functions
// that only take `lucid` still reach slot/tip queries: callers (including
// offline tests) supply the extended provider once, at lucidForAddress() time.
export function slotClockOf(lucid: LucidEvolution): SlotClockProvider {
  const provider = lucid.config().provider;
  if (!provider) throw new Error('Lucid instance has no provider configured - build it via lucidForAddress first.');
  return provider as unknown as SlotClockProvider;
}

// Vector slot config - resolved from chain via Ogmios queryNetwork/startTime.
// Cached after first query so SLOT_CONFIG_NETWORK is set before Lucid needs
// it. Module-global cache, same as the custodial original: callers (tests
// included) must use a consistent zeroTime across calls in one process.
let vectorZeroTime: number | null = null;

/**
 * The node answered the chain-start query with something that cannot be a clock. Its message names the kind of answer and nothing
 * the node said (no endpoint, no body), so a caller may show it as it is.
 */
export class ChainClockError extends Error {}

// A node that answers with something that is not a finite number (OgmiosProvider turns an unparseable start time into NaN)
// must not become the process's clock: the cache above never forgets, and every validity range would be computed from it.
export async function ensureSlotConfig(provider: Pick<SlotClockProvider, 'getSystemStartMs'>): Promise<number> {
  if (vectorZeroTime === null) {
    const zeroTime = await provider.getSystemStartMs();
    if (typeof zeroTime !== 'number' || !Number.isFinite(zeroTime)) {
      const got = typeof zeroTime === 'number' ? String(zeroTime) : typeof zeroTime; // NaN, Infinity, or the type of what came back
      throw new ChainClockError(`The node did not report a usable chain start time (got ${got}), so the slot clock was not set.`);
    }
    vectorZeroTime = zeroTime;
    SLOT_CONFIG_NETWORK.Mainnet = { zeroTime, zeroSlot: 0, slotLength: 1000 };
  }
  return vectorZeroTime;
}

// Address helper local to this family (mirrors registry-build.ts's
// paymentKeyHashOf exactly, kept as an independent copy rather than a
// cross-family import - each build-core file depends only on build.ts, not
// on a sibling family file; see task-3-report.md for the reasoning).
//
// Deliberate exception to that rule (Task 4): buildProposalSpend below DOES
// import getRegistryAddress from registry-build.ts - the self-improvement
// family's NFT-resolution fallback needs the registry's own script address
// to scan, and that address is derived from registry-build.ts's own
// REGISTRY_SCRIPT_CBOR constant, not something this file could reasonably
// duplicate without risking the two copies drifting apart. One-directional
// (gov-build.ts -> registry-build.ts only, never the reverse), so it does
// not introduce a cycle.
export function paymentKeyHashOf(address: string): string {
  let details;
  try {
    details = getAddressDetails(address);
  } catch (e) {
    throw new Error(`Invalid address: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (details.paymentCredential?.type !== 'Key' || !details.paymentCredential.hash) {
    throw new Error('Address must have a verification key payment credential, not a script credential.');
  }
  return details.paymentCredential.hash;
}
