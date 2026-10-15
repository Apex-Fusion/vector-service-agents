// packages/buyer-core/src/chain.ts
// The chain-writing side of a buyer, behind one interface, so that an orchestrator runs against FakeChain (fake-chain.ts) in its tests and
// against RealChain in production. RealChain builds every transaction keyless, the way the hosted mcp-server builds them (lucidForAddress
// over the provider and the vendored builders, the fleet Post from fleet-build.ts), signs the unsigned CBOR locally with the vendored signer
// and the buyer key, submits it through the provider, and returns once Koios reports it confirmed. Its reads go through the vendored
// lineage resolver and advert reader. The key never leaves this module: it is held in a private field, used only by signTransaction, and
// no message carries it.
import { CML } from '@lucid-evolution/lucid';
import type { Provider, UTxO } from '@lucid-evolution/lucid';
import { formatOutRef, parseOutRef } from '@vsa/vector-read';
import type { AdvertDatum } from '@vsa/vector-read';
import { buildAccept, buildReclaim } from './vendored/mcp/marketplace-build.ts';
import { lucidForAddress } from './vendored/mcp/build.ts';
import type { SlotClockProvider } from './vendored/mcp/gov-build.ts';
import { koiosFailure, resolveEscrowLineage } from './vendored/mcp/marketplace-lineage.ts';
import type { EscrowLineage } from './vendored/mcp/marketplace-lineage.ts';
import { koiosUtxoInfo, readAdvert as readAdvertOutput } from './vendored/mcp/marketplace-indexer.ts';
import type { KoiosUtxo } from './vendored/mcp/marketplace-indexer.ts';
import { COLLATERAL_MIN_LOVELACE } from './vendored/mcp/marketplace-constants.ts';
import { OgmiosProvider } from './vendored/mcp-shared/provider.ts';
import { VECTOR_KOIOS_URL, VECTOR_OGMIOS_URL, VECTOR_SUBMIT_URL } from './vendored/mcp-shared/config.ts';
import { signTransaction } from './vendored/signer/sign.ts';
import { rawHexToBech32 } from './signing.ts';
import { buildFleetPostEscrow } from './fleet-build.ts';
import { feeOfSignedTx } from './fees.ts';

/** A confirmed Post. Times are POSIX milliseconds, amounts lovelace. */
export interface PostResult { escrowRef: string; txHash: string; lockLovelace: bigint; feeLovelace: bigint; deliverBy: number; postedAt: number; supplierPkh: string; }

/**
 * Where an escrow is. Open, Claimed and Submitted are the states of its live output. `spent`: no live output carries it on any more (it was
 * accepted, reclaimed or released; on RealChain also, for as long as Koios lags, a continuation Koios has not listed yet, which the vendored
 * resolver cannot tell apart, so read again before treating it as final). `unknown`: there is no escrow at that ref at all.
 */
export type ChainEscrowState = 'Open' | 'Claimed' | 'Submitted' | 'spent' | 'unknown';

export interface Chain {
  /** The buyer's address and key hash, the pure output of at least 5 units kept as collateral for Accept and Reclaim (null if none), and the lovelace outside it. */
  wallet(): Promise<{ address: string; buyerPkh: string; collateralLovelace: bigint | null; floatLovelace: bigint }>;
  /** Builds, signs, submits and awaits the confirmation of a Post that commits to `promptHash`. */
  postEscrow(args: { advertRef: string; promptHash: string }): Promise<PostResult>;
  /** Accepts a Submitted escrow (pays the supplier the price and its bond, returns the buyer bond); returns once confirmed. */
  accept(escrowRef: string): Promise<{ txHash: string; feeLovelace: bigint }>;
  /** Reclaims an Open or Claimed escrow from its deliver_by on (everything locked comes back); returns once confirmed. */
  reclaim(escrowRef: string): Promise<{ txHash: string; feeLovelace: bigint }>;
  /** Where the escrow is (ChainEscrowState). Throws, and never answers `unknown`, when it cannot tell (an indexer or node unreachable or behind). */
  escrowState(escrowRef: string): Promise<ChainEscrowState>;
  /** The result_receipt_hash of the escrow's live Submitted output, or null when its live output is not Submitted (or it has none). Throws when it cannot tell. */
  onChainReceiptHash(escrowRef: string): Promise<string | null>;
  readAdvert(advertRef: string): Promise<AdvertDatum>;
}

/**
 * A transaction was submitted and Koios did not report it confirmed within the await budget. It may still land. For a Post that means an
 * escrow under `escrowRef` the buyer can Reclaim from `deliverBy` on if nobody delivers, so a caller records it before giving up on the job.
 * For an Accept or a Reclaim, `escrowRef` is the escrow it spends and `deliverBy` is null.
 */
export class TxNotConfirmedError extends Error {
  readonly txHash: string;
  readonly escrowRef: string;
  readonly deliverBy: number | null;
  constructor(what: string, txHash: string, escrowRef: string, deliverBy: number | null, awaitTimeoutMs: number) {
    super(`${what} ${txHash} of escrow ${escrowRef} was submitted, but Koios did not report it confirmed within ${awaitTimeoutMs} ms; it may still land. Read the escrow before acting on it again.`);
    this.name = 'TxNotConfirmedError';
    this.txHash = txHash;
    this.escrowRef = escrowRef;
    this.deliverBy = deliverBy;
  }
}

/** What the vendored builders need of a node: Lucid's provider surface and the chain start time the slot clock is set from. OgmiosProvider is one. */
export type ChainProvider = Provider & SlotClockProvider;

export interface RealChainOptions {
  /** The buyer key: 64 lowercase hex characters, a raw Ed25519 key, the form the agent template's gen-keypair prints. */
  privateKeyHex: string;
  /** The Koios base, without /api/v1 (default VECTOR_KOIOS_URL). Never vector-read's KOIOS_URL, which carries /api/v1. */
  koiosUrl?: string;
  ogmiosUrl?: string;
  submitUrl?: string;
  /** Stands in for fetch in the Koios reads of the builders and the lineage. The provider's own calls (Ogmios, the submit API, tx_status) use the global fetch. */
  fetchImpl?: typeof fetch;
  /** How long to wait for Koios to report a submitted transaction confirmed, in all (default 180000). */
  awaitTimeoutMs?: number;
}

/** OgmiosProvider.awaitTx polls Koios tx_status this many times, one interval apart (vendored/mcp-shared/provider.ts); the interval is set from awaitTimeoutMs. */
const AWAIT_TX_POLLS = 60;
/** 60 polls 3 s apart: the vendored awaitTx with its own default interval. */
const DEFAULT_AWAIT_TIMEOUT_MS = 180_000;
const LIVE_STATES = new Set<ChainEscrowState>(['Open', 'Claimed', 'Submitted']);
const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** The output reserveCollateralInputs holds back from a Post: the smallest pure-lovelace output of at least 5 units. */
function collateralOf(utxos: UTxO[]): bigint | null {
  const pure = utxos.filter((u) => Object.keys(u.assets).every((unit) => unit === 'lovelace') && (u.assets.lovelace ?? 0n) >= COLLATERAL_MIN_LOVELACE);
  return pure.length === 0 ? null : pure.reduce((smallest, u) => (u.assets.lovelace < smallest ? u.assets.lovelace : smallest), pure[0].assets.lovelace);
}

/**
 * The production Chain over a node (createRealChain gives it the vendored OgmiosProvider). The address is the mainnet enterprise address
 * of the key (header 0x61 and the key hash), the address gen-keypair prints for it. Transactions run one at a time, each built only after
 * the one before it is confirmed or has failed: they spend the same wallet, and a build that ran beside another could pick the same inputs.
 */
export class RealChain implements Chain {
  readonly address: string;
  readonly buyerPkh: string;
  readonly #signingKey: string;
  readonly #provider: ChainProvider;
  readonly #koiosUrl: string;
  readonly #fetchImpl: typeof fetch;
  readonly #awaitTimeoutMs: number;
  readonly #pollIntervalMs: number;
  #queue: Promise<void> = Promise.resolve();

  constructor(provider: ChainProvider, opts: Omit<RealChainOptions, 'ogmiosUrl' | 'submitUrl'>) {
    this.#signingKey = rawHexToBech32(opts.privateKeyHex);
    const keyHash = CML.PrivateKey.from_bech32(this.#signingKey).to_public().hash();
    this.buyerPkh = keyHash.to_hex();
    this.address = CML.EnterpriseAddress.new(1, CML.Credential.new_pub_key(keyHash)).to_address().to_bech32();
    const awaitTimeoutMs = opts.awaitTimeoutMs ?? DEFAULT_AWAIT_TIMEOUT_MS;
    if (!Number.isSafeInteger(awaitTimeoutMs) || awaitTimeoutMs <= 0) throw new Error('awaitTimeoutMs must be a positive whole number of milliseconds');
    this.#awaitTimeoutMs = awaitTimeoutMs;
    this.#pollIntervalMs = Math.ceil(awaitTimeoutMs / AWAIT_TX_POLLS);
    this.#provider = provider;
    this.#koiosUrl = opts.koiosUrl ?? VECTOR_KOIOS_URL;
    this.#fetchImpl = opts.fetchImpl ?? fetch;
  }

  async wallet(): Promise<{ address: string; buyerPkh: string; collateralLovelace: bigint | null; floatLovelace: bigint }> {
    const utxos = await this.#provider.getUtxos(this.address);
    const total = utxos.reduce((sum, u) => sum + (u.assets.lovelace ?? 0n), 0n);
    const collateralLovelace = collateralOf(utxos);
    return { address: this.address, buyerPkh: this.buyerPkh, collateralLovelace, floatLovelace: total - (collateralLovelace ?? 0n) };
  }

  postEscrow(args: { advertRef: string; promptHash: string }): Promise<PostResult> {
    return this.#serial(async () => {
      const lucid = await lucidForAddress(this.#provider, this.address);
      const built = await buildFleetPostEscrow(lucid, this.#provider, { changeAddress: this.address, advertRef: args.advertRef, promptHash: args.promptHash, koiosUrl: this.#koiosUrl }, this.#fetchImpl);
      const { txHash, feeLovelace } = await this.#signSubmitAwait('The Post', built.unsignedCborHex, parseOutRef(built.escrowRef).txHash, built.escrowRef, built.deliverBy);
      return { escrowRef: built.escrowRef, txHash, lockLovelace: built.lockLovelace, feeLovelace, deliverBy: built.deliverBy, postedAt: built.postedAt, supplierPkh: built.datum.supplier_pkh };
    });
  }

  accept(escrowRef: string): Promise<{ txHash: string; feeLovelace: bigint }> {
    return this.#serial(async () => {
      const lucid = await lucidForAddress(this.#provider, this.address);
      const built = await buildAccept(lucid, this.#provider, this.#koiosUrl, { changeAddress: this.address, escrowRef }, this.#fetchImpl);
      return this.#signSubmitAwait('The Accept', built.txCbor, built.txHash, built.escrowRef, null);
    });
  }

  reclaim(escrowRef: string): Promise<{ txHash: string; feeLovelace: bigint }> {
    return this.#serial(async () => {
      const lucid = await lucidForAddress(this.#provider, this.address);
      const built = await buildReclaim(lucid, this.#provider, this.#koiosUrl, { changeAddress: this.address, escrowRef }, this.#fetchImpl);
      return this.#signSubmitAwait('The Reclaim', built.txCbor, built.txHash, built.escrowRef, null);
    });
  }

  async escrowState(escrowRef: string): Promise<ChainEscrowState> {
    const lineage = await this.#lineage(escrowRef);
    if (lineage === 'unknown') return 'unknown';
    if (!lineage.current) return 'spent';
    // The resolver only ever follows an escrow into a live state; an output in any other state is no escrow of ours.
    const state = lineage.current.datum.state as ChainEscrowState;
    return LIVE_STATES.has(state) ? state : 'unknown';
  }

  async onChainReceiptHash(escrowRef: string): Promise<string | null> {
    const lineage = await this.#lineage(escrowRef);
    const live = lineage === 'unknown' ? null : lineage.current;
    return live?.datum.state === 'Submitted' ? live.datum.result_receipt_hash : null;
  }

  async readAdvert(advertRef: string): Promise<AdvertDatum> {
    let read: Awaited<ReturnType<typeof readAdvertOutput>>;
    try { read = await readAdvertOutput(advertRef, this.#fetchImpl, this.#koiosUrl); } catch (err) { throw new Error(`Could not read advert ${advertRef.trim()}: ${koiosFailure(err)}`); }
    if ('error' in read) throw new Error(read.error);
    return read.advert;
  }

  /**
   * The escrow's lineage (resolveEscrowLineage), or `unknown` when Koios has no output at the ref. Everything else the resolver cannot settle
   * (an indexer or node that is down or behind, a continuation it cannot prove) throws, so that no caller takes "cannot tell" for "gone".
   */
  async #lineage(escrowRef: string): Promise<EscrowLineage | 'unknown'> {
    const ref = parseOutRef(escrowRef);
    const canonical = formatOutRef(ref.txHash, ref.outputIndex);
    let rows: KoiosUtxo[];
    try { rows = await koiosUtxoInfo(this.#koiosUrl, [canonical], this.#fetchImpl); } catch (err) { throw new Error(`Could not read escrow ${canonical}: ${koiosFailure(err)}`); }
    if (!rows.some((u) => String(u?.tx_hash).toLowerCase() === ref.txHash && u?.tx_index === ref.outputIndex)) return 'unknown';
    return resolveEscrowLineage(this.#provider, this.#koiosUrl, canonical, this.#fetchImpl);
  }

  /** Signs with the buyer key, submits, and waits for Koios to report the transaction confirmed. */
  async #signSubmitAwait(what: string, unsignedCborHex: string, builtTxHash: string, escrowRef: string, deliverBy: number | null): Promise<{ txHash: string; feeLovelace: bigint }> {
    const { signedCborHex, txHashHex } = signTransaction(unsignedCborHex, this.#signingKey);
    // Signing never changes the body; a different hash would mean the escrow ref the caller is given names another transaction.
    if (txHashHex !== builtTxHash) throw new Error(`${what} of escrow ${escrowRef} signed as ${txHashHex}, not as the ${builtTxHash} it was built as; nothing was submitted.`);
    const feeLovelace = feeOfSignedTx(signedCborHex);
    try { await this.#provider.submitTx(signedCborHex); } catch (err) { throw new Error(`${what} ${txHashHex} of escrow ${escrowRef} was not submitted: ${errorText(err)}`); }
    // The hash awaited is the one of the bytes sent, whatever the submit API echoed.
    if (!(await this.#provider.awaitTx(txHashHex, this.#pollIntervalMs))) throw new TxNotConfirmedError(what, txHashHex, escrowRef, deliverBy, this.#awaitTimeoutMs);
    return { txHash: txHashHex, feeLovelace };
  }

  /** Runs `work` after every transaction queued before it has settled, whatever its outcome. */
  #serial<T>(work: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(work);
    this.#queue = run.then(() => undefined, () => undefined);
    return run;
  }
}

/**
 * The production Chain: RealChain over the vendored OgmiosProvider, with the vendored mainnet endpoints (each overridable by its
 * environment variable, see vendored/mcp-shared/config.ts) unless others are given. No network call is made here; a key that is not 64
 * lowercase hex characters, or an await budget that is not a positive whole number, is refused without being echoed.
 */
export async function createRealChain(opts: RealChainOptions): Promise<Chain> {
  const koiosUrl = opts.koiosUrl ?? VECTOR_KOIOS_URL;
  const provider = new OgmiosProvider({ ogmiosUrl: opts.ogmiosUrl ?? VECTOR_OGMIOS_URL, submitUrl: opts.submitUrl ?? VECTOR_SUBMIT_URL, koiosUrl });
  return new RealChain(provider, { privateKeyHex: opts.privateKeyHex, koiosUrl, fetchImpl: opts.fetchImpl, awaitTimeoutMs: opts.awaitTimeoutMs });
}
