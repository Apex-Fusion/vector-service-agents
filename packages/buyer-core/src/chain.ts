// packages/buyer-core/src/chain.ts
// The chain-writing side of a buyer, behind one interface, so that an orchestrator runs against FakeChain (fake-chain.ts) in its tests and
// against RealChain in production. RealChain builds every transaction keyless, the way the hosted mcp-server builds them (lucidForAddress
// over the provider and the vendored builders, the fleet Post from fleet-build.ts), signs the unsigned CBOR locally with the vendored signer
// and the buyer key, submits it through the provider, and returns once Koios reports it confirmed. Every failure after the signature is a
// TxNotConfirmedError that carries what a caller needs to keep track of an escrow that may still land. Its reads go through the vendored
// lineage resolver and advert reader. The key never leaves this module: it is held in a private field, used only by signTransaction, and
// no message carries it.
import { CML, slotToUnixTime } from '@lucid-evolution/lucid';
import type { Provider, UTxO } from '@lucid-evolution/lucid';
import { formatOutRef, parseOutRef } from '@vsa/vector-read';
import type { AdvertDatum } from '@vsa/vector-read';
import { buildAccept, buildReclaim } from './vendored/mcp/marketplace-build.ts';
import { lucidForAddress } from './vendored/mcp/build.ts';
import { ensureSlotConfig } from './vendored/mcp/gov-build.ts';
import type { SlotClockProvider } from './vendored/mcp/gov-build.ts';
import { koiosFailure, resolveEscrowLineage } from './vendored/mcp/marketplace-lineage.ts';
import type { EscrowLineage } from './vendored/mcp/marketplace-lineage.ts';
import { koiosUtxoInfo, readAdvert as readAdvertOutput } from './vendored/mcp/marketplace-indexer.ts';
import type { KoiosUtxo } from './vendored/mcp/marketplace-indexer.ts';
import { COLLATERAL_MIN_LOVELACE, DELIVER_BY_BUFFER_MS } from './vendored/mcp/marketplace-constants.ts';
import { OgmiosProvider } from './vendored/mcp-shared/provider.ts';
import { VECTOR_KOIOS_URL, VECTOR_OGMIOS_URL, VECTOR_SUBMIT_URL } from './vendored/mcp-shared/config.ts';
import { signTransaction } from './vendored/signer/sign.ts';
import { rawHexToBech32 } from './signing.ts';
import { buildFleetPostEscrow } from './fleet-build.ts';
import { feeOfSignedTx } from './fees.ts';

/**
 * A confirmed Post. Times are POSIX milliseconds, amounts lovelace. `collateralKept` is the vendored builder's flag: true when the Post was
 * funded without the wallet's smallest pure output of at least 5 units, so it is still there as collateral for the next Accept or Reclaim;
 * false when that output may have been spent, and then the wallet has collateral only if another such output remains (wallet() says).
 */
export interface PostResult { escrowRef: string; txHash: string; lockLovelace: bigint; feeLovelace: bigint; deliverBy: number; postedAt: number; supplierPkh: string; collateralKept: boolean; }

/**
 * Where an escrow is. Open, Claimed and Submitted are the states of its live output.
 * `spent`: no live output carries it on any more: it was accepted, reclaimed or released. On RealChain also, for as long as Koios lags, a
 * continuation Koios has not listed yet, which the vendored resolver cannot tell apart: read again before treating it as final.
 * `unknown`: Koios lists no output at the ref. On RealChain that is final only once the transaction that would create the output can no
 * longer land (its Post's validTo has passed, see TxNotConfirmedError) and Koios has caught up: until then a Post that was submitted and is
 * not indexed yet reads unknown too. On FakeChain it means the ref was never posted.
 */
export type ChainEscrowState = 'Open' | 'Claimed' | 'Submitted' | 'spent' | 'unknown';

export interface Chain {
  /** The buyer's address and key hash, the pure output of at least 5 units kept as collateral for Accept and Reclaim (null if none), and the lovelace outside it. */
  wallet(): Promise<{ address: string; buyerPkh: string; collateralLovelace: bigint | null; floatLovelace: bigint }>;
  /** Builds, signs, submits and awaits the confirmation of a Post that commits to `promptHash`. A failure after the signature is a TxNotConfirmedError. */
  postEscrow(args: { advertRef: string; promptHash: string }): Promise<PostResult>;
  /**
   * Accepts a Submitted escrow (pays the supplier the price and its bond, returns the buyer bond); returns once confirmed. An AcceptWindowClosedError
   * says that no Accept of the escrow can be made any more.
   */
  accept(escrowRef: string): Promise<{ txHash: string; feeLovelace: bigint }>;
  /** Reclaims an Open or Claimed escrow from the first whole second after its deliver_by on (everything locked comes back); returns once confirmed. */
  reclaim(escrowRef: string): Promise<{ txHash: string; feeLovelace: bigint }>;
  /**
   * Where the escrow is (ChainEscrowState). Throws, and never answers `unknown`, when it cannot tell (an indexer or node unreachable or
   * behind). It also throws, and keeps throwing, for an output Koios lists that is no escrow (not at the escrow credential, no escrow datum)
   * or an escrow whose output holds less than its datum owes: neither can happen for a ref postEscrow returned.
   */
  escrowState(escrowRef: string): Promise<ChainEscrowState>;
  /** The result_receipt_hash of the escrow's live Submitted output, or null when its live output is not Submitted (or it has none). Throws when it cannot tell. */
  onChainReceiptHash(escrowRef: string): Promise<string | null>;
  /** The advert's datum, spent or not: the vendored reader's `spent` flag is dropped here, and a Post reads the advert again and refuses a spent one. */
  readAdvert(advertRef: string): Promise<AdvertDatum>;
}

/**
 * A transaction failed after it was signed: it was refused, it may not have been submitted, or it was submitted and not confirmed in time.
 * `mayLand` is false only when it certainly never reached the node: it was not sent, or the submit API refused it with an HTTP 4xx (the
 * API's or the ledger's verdict on the transaction itself). Otherwise it may land, and only before `validTo` (POSIX ms), the start of the
 * first slot its validity interval excludes. For a Post, `escrowRef` is the escrow it opens and `deliverBy` that escrow's deliver_by: a
 * caller that gives up on the job records both with `validTo`, so that the escrow is reclaimed if it lands, and drops the record only once
 * `validTo` has passed and Koios still lists nothing at the ref. For an Accept or a Reclaim, `escrowRef` is the escrow it spends and
 * `deliverBy` is null.
 */
export class TxNotConfirmedError extends Error {
  readonly txHash: string;
  readonly escrowRef: string;
  readonly deliverBy: number | null;
  readonly validTo: number;
  readonly mayLand: boolean;
  constructor(message: string, facts: { txHash: string; escrowRef: string; deliverBy: number | null; validTo: number; mayLand: boolean }, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'TxNotConfirmedError';
    this.txHash = facts.txHash;
    this.escrowRef = facts.escrowRef;
    this.deliverBy = facts.deliverBy;
    this.validTo = facts.validTo;
    this.mayLand = facts.mayLand;
  }
}

/**
 * The accept window of the escrow has closed: the vendored planner refuses an Accept once submitted_at + ACCEPT_WINDOW_MS has passed, and from then on
 * the supplier may Release. Nothing was built or signed, so nothing can land, and no later Accept of the escrow can be made: a caller stops trying.
 * The message is the planner's (see acceptRefusal below).
 */
export class AcceptWindowClosedError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'AcceptWindowClosedError';
  }
}

/** How long the build of a transaction may take, everything before its signature: the reads of the wallet and of the escrow, the planner, complete(). */
export const BUILD_TIMEOUT_MS = 60_000;

/**
 * The build of a transaction did not end within BUILD_TIMEOUT_MS (a node or an indexer that does not answer: the vendored reads carry no time limit of
 * their own). Nothing was signed and nothing was sent, so nothing can land: a plain Error, with no `mayLand`. The build is left to end alone, and
 * nothing it builds is ever signed.
 */
export class TxBuildTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TxBuildTimeoutError';
  }
}

/** What the vendored builders need of a node: Lucid's provider surface and the chain start time the slot clock is set from. OgmiosProvider is one. */
export type ChainProvider = Provider & SlotClockProvider;

/** The longest awaitTimeoutMs: a transaction holds the queue for its wait, and a wait past the 600 s of an accept window would hold an Accept behind it past its window. */
export const AWAIT_TIMEOUT_MAX_MS = 600_000;

export interface RealChainOptions {
  /** The buyer key: 64 lowercase hex characters, a raw Ed25519 key, the form the agent template's gen-keypair prints. */
  privateKeyHex: string;
  /** The Koios base, without /api/v1 (default VECTOR_KOIOS_URL). Never vector-read's KOIOS_URL, which carries /api/v1. */
  koiosUrl?: string;
  ogmiosUrl?: string;
  submitUrl?: string;
  /** Stands in for fetch in the Koios reads of the builders and the lineage. The provider's own calls (Ogmios, the submit API, tx_status) use the global fetch. */
  fetchImpl?: typeof fetch;
  /**
   * How long, in all, a signed transaction is given from the start of its submit to the confirmation Koios reports. At least DELIVER_BY_BUFFER_MS
   * (180000), the default: a Post is valid for at most that long after it is built, so a Post the wait gave up on can no longer land. At most
   * AWAIT_TIMEOUT_MAX_MS (600000).
   */
  awaitTimeoutMs?: number;
}

/** OgmiosProvider.awaitTx polls Koios tx_status this many times, one interval apart (vendored/mcp-shared/provider.ts); the interval is set from awaitTimeoutMs. */
const AWAIT_TX_POLLS = 60;
const LIVE_STATES = new Set<ChainEscrowState>(['Open', 'Claimed', 'Submitted']);
const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Did the submit API refuse the transaction outright? The vendored OgmiosProvider.submitTx says `Transaction submission rejected (<status> ...`
 * for an HTTP answer that is not OK (formatSubmitRejection). A 4xx refuses the request itself, the ledger's verdict included (the submit API
 * answers 400 with the ledger's reason): the transaction was not taken. Anything else leaves open whether the node has it: a network error
 * after the request may have gone out, a 5xx a gateway can answer after forwarding it, a 200 whose body is not a transaction hash.
 */
const refusedOutright = (err: unknown): boolean => /^Transaction submission rejected \(4\d\d\b/.test(errorText(err));

/**
 * The one place the closed accept window is read off the vendored planner. planAccept (vendored/mcp/marketplace-build.ts, line 248) throws
 * `Accept window closed at <iso>; the supplier may now Release.`, and buildEscrowSpend passes it on with ` (escrow <ref>)` after it. Any other error
 * of the build is passed on as it is.
 */
const ACCEPT_WINDOW_CLOSED = /^Accept window closed at /;
function acceptRefusal(err: unknown): unknown {
  return err instanceof Error && ACCEPT_WINDOW_CLOSED.test(err.message) ? new AcceptWindowClosedError(err.message, { cause: err }) : err;
}

/** The output reserveCollateralInputs holds back from a Post: the smallest pure-lovelace output of at least 5 units. */
function collateralOf(utxos: UTxO[]): bigint | null {
  const pure = utxos.filter((u) => Object.keys(u.assets).every((unit) => unit === 'lovelace') && (u.assets.lovelace ?? 0n) >= COLLATERAL_MIN_LOVELACE);
  return pure.length === 0 ? null : pure.reduce((smallest, u) => (u.assets.lovelace < smallest ? u.assets.lovelace : smallest), pure[0].assets.lovelace);
}

/** A transaction built and ready to sign: its unsigned body, the hash it was built as, its escrow, the Post's deliver_by, and the end of its validity. */
interface Built { what: string; unsignedCborHex: string; builtTxHash: string; escrowRef: string; deliverBy: number | null; validTo: number }

/**
 * The production Chain over a node (createRealChain gives it the vendored OgmiosProvider). The address is the mainnet enterprise address
 * of the key (header 0x61 and the key hash), the address gen-keypair prints for it. Transactions run one at a time, each built only after
 * the one before it is confirmed or has failed: they spend the same wallet, and a build that ran beside another could pick the same inputs.
 * The build of each, everything before its signature, is bounded by BUILD_TIMEOUT_MS, and its submit and the wait for its confirmation by
 * awaitTimeoutMs, so a transaction holds the queue at most their sum, and one queued behind it waits at most that long for it.
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
    const awaitTimeoutMs = opts.awaitTimeoutMs ?? DELIVER_BY_BUFFER_MS;
    if (!Number.isSafeInteger(awaitTimeoutMs) || awaitTimeoutMs < DELIVER_BY_BUFFER_MS || awaitTimeoutMs > AWAIT_TIMEOUT_MAX_MS) {
      throw new Error(`awaitTimeoutMs must be a whole number of milliseconds from ${DELIVER_BY_BUFFER_MS} (DELIVER_BY_BUFFER_MS), so that the wait outlasts the validity of a Post, to ${AWAIT_TIMEOUT_MAX_MS} (AWAIT_TIMEOUT_MAX_MS), so that it does not hold an Accept queued behind it past its window`);
    }
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
      const built = await this.#built('The Post', async () => {
        const lucid = await lucidForAddress(this.#provider, this.address);
        const post = await buildFleetPostEscrow(lucid, this.#provider, { changeAddress: this.address, advertRef: args.advertRef, promptHash: args.promptHash, koiosUrl: this.#koiosUrl }, this.#fetchImpl);
        return { unsignedCborHex: post.unsignedCborHex, builtTxHash: parseOutRef(post.escrowRef).txHash, escrowRef: post.escrowRef, deliverBy: post.deliverBy, post };
      });
      const { txHash, feeLovelace } = await this.#signSubmitAwait(built);
      const { post } = built;
      return {
        escrowRef: post.escrowRef, txHash, lockLovelace: post.lockLovelace, feeLovelace, deliverBy: post.deliverBy, postedAt: post.postedAt,
        supplierPkh: post.datum.supplier_pkh, collateralKept: post.collateralKept,
      };
    });
  }

  accept(escrowRef: string): Promise<{ txHash: string; feeLovelace: bigint }> {
    return this.#serial(async () => {
      const built = await this.#built('The Accept', async () => {
        const lucid = await lucidForAddress(this.#provider, this.address);
        let accept: Awaited<ReturnType<typeof buildAccept>>;
        try { accept = await buildAccept(lucid, this.#provider, this.#koiosUrl, { changeAddress: this.address, escrowRef }, this.#fetchImpl); } catch (err) { throw acceptRefusal(err); }
        return { unsignedCborHex: accept.txCbor, builtTxHash: accept.txHash, escrowRef: accept.escrowRef, deliverBy: null };
      });
      return this.#signSubmitAwait(built);
    });
  }

  reclaim(escrowRef: string): Promise<{ txHash: string; feeLovelace: bigint }> {
    return this.#serial(async () => {
      const built = await this.#built('The Reclaim', async () => {
        const lucid = await lucidForAddress(this.#provider, this.address);
        const reclaim = await buildReclaim(lucid, this.#provider, this.#koiosUrl, { changeAddress: this.address, escrowRef }, this.#fetchImpl);
        return { unsignedCborHex: reclaim.txCbor, builtTxHash: reclaim.txHash, escrowRef: reclaim.escrowRef, deliverBy: null };
      });
      return this.#signSubmitAwait(built);
    });
  }

  async escrowState(escrowRef: string): Promise<ChainEscrowState> {
    const lineage = await this.#lineage(escrowRef);
    if (lineage === 'unknown') return 'unknown';
    if (!lineage.current) return 'spent';
    // The resolver only ever follows an escrow into a live state; an output in any other state is no escrow of ours. No offline test reaches the
    // fallback: the vendored resolver gives no other state, and FakeChain has no lineage to read.
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

  /**
   * The build phase of a transaction, everything before its signature (`work`: the reads of the wallet and of the escrow, the planner, complete(); and
   * then the end of its validity, read from the unsigned body), against a timer of BUILD_TIMEOUT_MS. A build given up on is left to end alone:
   * nothing is signed from it, so it cannot submit anything. Before the signature nothing is sent, and every failure is a plain Error.
   */
  async #built<P extends Omit<Built, 'what' | 'validTo'>>(what: string, work: () => Promise<P>): Promise<P & Built> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new TxBuildTimeoutError(`${what} was not built within ${BUILD_TIMEOUT_MS} ms (BUILD_TIMEOUT_MS): the node or the indexer it reads did not answer in time. Nothing was signed or sent.`)), BUILD_TIMEOUT_MS);
    });
    const building = (async (): Promise<P & Built> => {
      const parts = await work();
      return { what, ...parts, validTo: await this.#validToOf(what, parts.unsignedCborHex, parts.escrowRef) };
    })();
    building.catch(() => undefined); // a build given up on may still fail; nobody waits for it any more
    try {
      return await Promise.race([building, late]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Signs with the buyer key, submits, and waits for Koios to report the transaction confirmed. Every failure here is a TxNotConfirmedError with the
   * transaction's hash, its escrow, the Post's deliver_by and the end of its validity, and whether it may still land. The submit and the wait share
   * one budget, awaitTimeoutMs from the start of the submit: the vendored submitTx and awaitTx carry no time limit of their own, so only that timer
   * bounds them. A call left behind ends on its own.
   */
  async #signSubmitAwait(built: Built): Promise<{ txHash: string; feeLovelace: bigint }> {
    const { what, unsignedCborHex, builtTxHash, escrowRef, deliverBy, validTo } = built;
    const { signedCborHex, txHashHex } = signTransaction(unsignedCborHex, this.#signingKey);
    const facts = { txHash: txHashHex, escrowRef, deliverBy, validTo };
    const subject = `${what} ${txHashHex} of escrow ${escrowRef}`;
    const until = `It may land, but only before ${new Date(validTo).toISOString()}: read the escrow before acting on it again.`;
    let feeLovelace: bigint;
    try {
      // Signing never changes the body; a different hash would mean the escrow ref the caller is given names another transaction. No offline test
      // reaches this branch or a fee that cannot be read: the builders return the hash of the body they built, the vendored signer adds a witness
      // and nothing else, and neither can be replaced from a test without replacing the vendored code. The branch guards a signer that would.
      if (txHashHex !== builtTxHash) throw new Error(`it signed as ${txHashHex}, not as the ${builtTxHash} it was built as`);
      feeLovelace = feeOfSignedTx(signedCborHex);
    } catch (err) {
      throw new TxNotConfirmedError(`${subject} was not submitted and cannot land (${errorText(err)}).`, { ...facts, mayLand: false }, { cause: err });
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const budget = new Promise<'late'>((resolve) => { timer = setTimeout(() => resolve('late'), this.#awaitTimeoutMs); });
    try {
      let submitted: 'sent' | 'late';
      try {
        const sending = this.#provider.submitTx(signedCborHex).then(() => 'sent' as const);
        sending.catch(() => undefined); // a submit left behind may still fail; the budget has answered for it
        submitted = await Promise.race([sending, budget]);
      } catch (err) {
        if (refusedOutright(err)) throw new TxNotConfirmedError(`${subject} was refused and cannot land (${errorText(err)}).`, { ...facts, mayLand: false }, { cause: err });
        throw new TxNotConfirmedError(`${subject} may not have been submitted (${errorText(err)}). ${until}`, { ...facts, mayLand: true }, { cause: err });
      }
      if (submitted === 'late') throw new TxNotConfirmedError(`${subject} may not have been submitted: the submit API did not answer within ${this.#awaitTimeoutMs} ms. ${until}`, { ...facts, mayLand: true });
      // The hash awaited is the one of the bytes sent, whatever the submit API echoed.
      let confirmed: boolean | 'late';
      try {
        const waiting = this.#provider.awaitTx(txHashHex, this.#pollIntervalMs);
        waiting.catch(() => undefined); // a poll loop left behind ends on its own
        confirmed = await Promise.race([waiting, budget]);
      } catch (err) {
        throw new TxNotConfirmedError(`${subject} was submitted, but its confirmation could not be read (${errorText(err)}). ${until}`, { ...facts, mayLand: true }, { cause: err });
      }
      if (confirmed !== true) throw new TxNotConfirmedError(`${subject} was submitted and is not yet seen confirmed: Koios did not report it confirmed within ${this.#awaitTimeoutMs} ms. ${until}`, { ...facts, mayLand: true });
    } finally {
      clearTimeout(timer);
    }
    return { txHash: txHashHex, feeLovelace };
  }

  /**
   * The first moment the transaction can no longer land: the start of the slot its validity interval ends at (Lucid turns the plan's validTo
   * into that slot, rounding down, and the ledger takes the transaction only in earlier slots). Read from the unsigned body, which signing
   * leaves as it is; the slot clock is the one the builder that just ran set (ensureSlotConfig caches it). No offline test reaches the refusal of a
   * body without an end to its validity: every builder sets one, and they are not replaced in a test.
   */
  async #validToOf(what: string, unsignedCborHex: string, escrowRef: string): Promise<number> {
    const ttl = CML.Transaction.from_cbor_hex(unsignedCborHex).body().ttl();
    if (ttl === undefined) throw new Error(`${what} of escrow ${escrowRef} has no end to its validity, so it could land at any time; it was not signed.`);
    await ensureSlotConfig(this.#provider);
    return slotToUnixTime('Mainnet', Number(ttl));
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
 * environment variable, see vendored/mcp-shared/config.ts) unless others are given. No network call is made here. A key that is not 64
 * lowercase hex characters is refused without being echoed, and so is an await budget outside DELIVER_BY_BUFFER_MS to AWAIT_TIMEOUT_MAX_MS.
 */
export async function createRealChain(opts: RealChainOptions): Promise<Chain> {
  const koiosUrl = opts.koiosUrl ?? VECTOR_KOIOS_URL;
  const provider = new OgmiosProvider({ ogmiosUrl: opts.ogmiosUrl ?? VECTOR_OGMIOS_URL, submitUrl: opts.submitUrl ?? VECTOR_SUBMIT_URL, koiosUrl });
  return new RealChain(provider, { privateKeyHex: opts.privateKeyHex, koiosUrl, fetchImpl: opts.fetchImpl, awaitTimeoutMs: opts.awaitTimeoutMs });
}
