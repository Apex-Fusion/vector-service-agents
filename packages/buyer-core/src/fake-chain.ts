// packages/buyer-core/src/fake-chain.ts
// An in-memory Chain for the service tests: a ledger of escrows keyed by ref, in the states a real escrow passes through, with the lock and
// fee of the live ChandraOCR Post as constants. Posts are planned by planFleetPostEscrow, so they get the real deliver_by and the real
// refusals (a retired advert, the buyer as its own supplier, a prompt hash that is not a sha256). The two transitions only a supplier makes,
// Claim and Submit, are test hooks (markClaimed, markSubmitted) that a stub supplier calls. Refs are deterministic: the n-th Post (from 1)
// opens `${sha256(prefix + n)}#0`. Every transaction takes its fee out of the wallet float: a Post takes the lock and its fee; an Accept
// returns the buyer bond and the lock-floor excess and takes its fee; a Reclaim returns the whole lock and takes its fee. The collateral is
// never spent. A Reclaim opens where the vendored planReclaim opens it, at the first whole second strictly after deliver_by. A third hook,
// failNextPost, makes the next Post fail the way RealChain's fails after the signature (a TxNotConfirmedError), for the caller that must keep
// track of an escrow that may still land. Two more steer the Accept (ruling R54): failNextAccepts makes the next Accepts fail as a build that did not
// complete fails (a plain Error, nothing sent) or with an error the test gives, and closeAcceptWindow makes every later Accept fail the way the vendored
// planner refuses one after the window (AcceptWindowClosedError). Not modelled: the clock of the accept window after a Submit and the supplier's Release.
import { formatOutRef, parseOutRef, sha256Utf8Hex } from '@vsa/vector-read';
import type { AdvertDatum, EscrowDatum } from '@vsa/vector-read';
import { AcceptWindowClosedError } from './chain.ts';
import type { Chain, ChainEscrowState, PostResult, TxNotConfirmedError } from './chain.ts';
import { planFleetPostEscrow } from './fleet-build.ts';
import { enterpriseAddressOf } from './vendored/mcp/marketplace-build.ts';

type FakeState = Exclude<ChainEscrowState, 'unknown'>;
interface FakeEscrow { datum: EscrowDatum; state: FakeState; resultReceiptHash: string | null }

export interface FakeChainOptions {
  /** The adverts the chain knows, by ref. postEscrow and readAdvert refuse any other ref. */
  adverts?: Record<string, AdvertDatum>;
  /** POSIX milliseconds: posted_at and deliver_by of a Post, and the time a Reclaim is checked against. Default Date.now. */
  clock?: () => number;
  /** The n-th Post (from 1) opens `${sha256(prefix + n)}#0`. Default 'fake-chain/'. */
  prefix?: string;
  /** Default 'bb' repeated: any key hash that is not a supplier's. The address is its mainnet enterprise address. */
  buyerPkh?: string;
  /** Default 50000000 lovelace, the float the guide describes. */
  floatLovelace?: bigint;
  /** Default 5000000 lovelace, the 5-unit output sent alone; null for a wallet without collateral. */
  collateralLovelace?: bigint | null;
}

const RECEIPT_HASH = /^[0-9a-f]{64}$/;
const canonical = (ref: string): string => { const parsed = parseOutRef(ref); return formatOutRef(parsed.txHash, parsed.outputIndex); };

export class FakeChain implements Chain {
  /** The lock of every Post: what the live ChandraOCR Post locked (price 200000, both bonds 1000000, raised to the datum's floor). */
  static readonly LOCK_LOVELACE = 2_261_030n;
  /** The fee of every transaction: the marketplace minimum. */
  static readonly FEE_LOVELACE = 500_000n;

  readonly address: string;
  readonly buyerPkh: string;
  readonly #adverts = new Map<string, AdvertDatum>();
  readonly #escrows = new Map<string, FakeEscrow>();
  readonly #clock: () => number;
  readonly #prefix: string;
  readonly #collateral: bigint | null;
  #float: bigint;
  #posts = 0;
  #failNextPost: TxNotConfirmedError | null = null;
  #failingAccepts: Array<Error | null> = [];
  #acceptWindowClosed = false;

  constructor(opts: FakeChainOptions = {}) {
    for (const [ref, advert] of Object.entries(opts.adverts ?? {})) this.#adverts.set(canonical(ref), advert);
    this.#clock = opts.clock ?? Date.now;
    this.#prefix = opts.prefix ?? 'fake-chain/';
    this.buyerPkh = opts.buyerPkh ?? 'bb'.repeat(28);
    this.address = enterpriseAddressOf(this.buyerPkh);
    this.#float = opts.floatLovelace ?? 50_000_000n;
    this.#collateral = opts.collateralLovelace === undefined ? 5_000_000n : opts.collateralLovelace;
  }

  async wallet(): Promise<{ address: string; buyerPkh: string; collateralLovelace: bigint | null; floatLovelace: bigint }> {
    return { address: this.address, buyerPkh: this.buyerPkh, collateralLovelace: this.#collateral, floatLovelace: this.#float };
  }

  async postEscrow(args: { advertRef: string; promptHash: string }): Promise<PostResult> {
    const advertRef = canonical(args.advertRef);
    const advert = this.#advert(advertRef);
    const plan = planFleetPostEscrow(advert, advertRef, this.buyerPkh, args.promptHash, this.#clock());
    const owed = advert.price_lovelace + advert.buyer_bond_lovelace + advert.supplier_bond_lovelace;
    if (owed > FakeChain.LOCK_LOVELACE) throw new Error(`FakeChain locks ${FakeChain.LOCK_LOVELACE} lovelace on every Post, less than the ${owed} advert ${advertRef} asks for.`);
    const cost = FakeChain.LOCK_LOVELACE + FakeChain.FEE_LOVELACE;
    if (this.#float < cost) throw new Error(`FakeChain: the float of ${this.#float} lovelace cannot cover the lock and the fee (${cost}).`);
    const failure = this.#failNextPost;
    if (failure !== null) {
      this.#failNextPost = null;
      throw failure;
    }
    this.#float -= cost;
    const txHash = sha256Utf8Hex(`${this.#prefix}${++this.#posts}`);
    const escrowRef = formatOutRef(txHash, 0);
    this.#escrows.set(escrowRef, { datum: plan.datum, state: 'Open', resultReceiptHash: null });
    return {
      escrowRef, txHash, lockLovelace: FakeChain.LOCK_LOVELACE, feeLovelace: FakeChain.FEE_LOVELACE, deliverBy: plan.deliverBy, postedAt: plan.postedAt,
      supplierPkh: plan.datum.supplier_pkh, collateralKept: this.#collateral !== null,
    };
  }

  async accept(escrowRef: string): Promise<{ txHash: string; feeLovelace: bigint }> {
    const [ref, escrow] = this.#escrow(escrowRef);
    if (escrow.state !== 'Submitted') throw new Error(`FakeChain: escrow ${ref} is ${escrow.state}; Accept needs Submitted.`);
    if (this.#acceptWindowClosed) {
      throw new AcceptWindowClosedError(`Accept window closed at ${new Date(this.#clock()).toISOString()}; the supplier may now Release. (escrow ${ref})`);
    }
    if (this.#failingAccepts.length > 0) {
      const failure = this.#failingAccepts.shift() ?? null;
      throw failure ?? new Error(`FakeChain: the Accept of escrow ${ref} could not be built (test hook).`);
    }
    escrow.state = 'spent';
    const d = escrow.datum;
    const excess = FakeChain.LOCK_LOVELACE - (d.payment_lovelace + d.buyer_bond_lovelace + d.supplier_bond_lovelace);
    this.#float += d.buyer_bond_lovelace + excess - FakeChain.FEE_LOVELACE;
    return { txHash: sha256Utf8Hex(`${this.#prefix}accept/${ref}`), feeLovelace: FakeChain.FEE_LOVELACE };
  }

  async reclaim(escrowRef: string): Promise<{ txHash: string; feeLovelace: bigint }> {
    const [ref, escrow] = this.#escrow(escrowRef);
    if (escrow.state !== 'Open' && escrow.state !== 'Claimed') throw new Error(`FakeChain: escrow ${ref} is ${escrow.state}; Reclaim needs Open or Claimed.`);
    const now = this.#clock();
    // The vendored planReclaim's opening (marketplace-build.ts): the validator wants the validity range to start at or after deliver_by, and
    // a range starts on a whole second, so the first that can is the first whole second strictly after it.
    const opens = Math.ceil((escrow.datum.deliver_by + 1) / 1000) * 1000;
    if (now < opens) throw new Error(`FakeChain: the Reclaim of escrow ${ref} opens at ${opens}, the first whole second after deliver_by ${escrow.datum.deliver_by}; the clock says ${now}.`);
    escrow.state = 'spent';
    this.#float += FakeChain.LOCK_LOVELACE - FakeChain.FEE_LOVELACE;
    return { txHash: sha256Utf8Hex(`${this.#prefix}reclaim/${ref}`), feeLovelace: FakeChain.FEE_LOVELACE };
  }

  async escrowState(escrowRef: string): Promise<ChainEscrowState> {
    return this.#escrows.get(canonical(escrowRef))?.state ?? 'unknown';
  }

  /** What markSubmitted stored, while the Submitted output is live (as on chain: after the Accept there is no Submitted output to read). */
  async onChainReceiptHash(escrowRef: string): Promise<string | null> {
    const escrow = this.#escrows.get(canonical(escrowRef));
    return escrow?.state === 'Submitted' ? escrow.resultReceiptHash : null;
  }

  async readAdvert(advertRef: string): Promise<AdvertDatum> {
    return this.#advert(canonical(advertRef));
  }

  /**
   * Test hook, a Post that was signed and not seen confirmed: the next postEscrow that passes the refusals of a real Post throws `error` and opens
   * nothing, as a Post that has not landed (whatever its `mayLand` says). The float and the ref counter do not move. One Post only; the one after it
   * is an ordinary Post again.
   */
  failNextPost(error: TxNotConfirmedError): void {
    this.#failNextPost = error;
  }

  /**
   * Test hook, Accepts that fail: the next `times` Accepts of a Submitted escrow throw `error`, or, without one, a plain Error as a build that did not
   * complete throws (nothing was sent). They change nothing: the escrow stays Submitted and the float does not move. The Accept after them is an
   * ordinary one.
   */
  failNextAccepts(times: number, error?: Error): void {
    if (!Number.isSafeInteger(times) || times < 1) throw new RangeError('FakeChain: failNextAccepts takes a whole number of at least 1.');
    for (let i = 0; i < times; i++) this.#failingAccepts.push(error ?? null);
  }

  /** Test hook, the end of the accept window: from now on every Accept of a Submitted escrow throws AcceptWindowClosedError, as the vendored planner does. */
  closeAcceptWindow(): void {
    this.#acceptWindowClosed = true;
  }

  /** Test hook, the supplier's Claim: Open becomes Claimed. */
  markClaimed(escrowRef: string): void {
    const [ref, escrow] = this.#escrow(escrowRef);
    if (escrow.state !== 'Open') throw new Error(`FakeChain: escrow ${ref} is ${escrow.state}; a Claim needs Open.`);
    escrow.state = 'Claimed';
  }

  /** Test hook, the supplier's Submit: Claimed becomes Submitted, carrying `resultReceiptHash` (sha256 of the signed receipt, lowercase hex) as the datum would. */
  markSubmitted(escrowRef: string, resultReceiptHash: string): void {
    const [ref, escrow] = this.#escrow(escrowRef);
    if (escrow.state !== 'Claimed') throw new Error(`FakeChain: escrow ${ref} is ${escrow.state}; a Submit needs Claimed.`);
    if (!RECEIPT_HASH.test(resultReceiptHash)) throw new Error('FakeChain: the result receipt hash must be 64 lowercase hex characters.');
    escrow.state = 'Submitted';
    escrow.resultReceiptHash = resultReceiptHash;
  }

  #advert(advertRef: string): AdvertDatum {
    const advert = this.#adverts.get(advertRef);
    if (!advert) throw new Error(`FakeChain: no advert at ${advertRef}.`);
    return advert;
  }

  #escrow(escrowRef: string): [string, FakeEscrow] {
    const ref = canonical(escrowRef);
    const escrow = this.#escrows.get(ref);
    if (!escrow) throw new Error(`FakeChain: no escrow at ${ref}.`);
    return [ref, escrow];
  }
}
