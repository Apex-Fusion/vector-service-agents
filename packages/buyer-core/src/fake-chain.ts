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
// An advert can be of either layout: an IdentityAdvertDatum (it names its agent) gets an identity-marketplace escrow, planned as RealChain plans it,
// whose agent the Post returns (PostResult.agentId); a legacy advert gets a legacy escrow.
//
// The vault. The chain also pays an escrow from a vault of a principal (payFromVault, VaultChain), as the delegate of a delegation, and it models what the vault script enforces, so
// that a test can make the ledger refuse. The hooks openVault and endDelegation set the world up (a vault under a delegation with a value limit, and the end of the delegation). A Pay
// takes the lock out of the vault and only the fee out of the wallet; it is refused with VaultPayRefused when it is above `per_tx`, or when it brings the spending of the period above
// `total` (a new period starts at `periodMs` after the start of the last one); it is VaultPayImpossible for a vault that is gone or is no Live vault, a delegation that ended, an advert
// that cannot be paid, or a rest below VAULT_MIN_LOVELACE. The escrow it opens refunds to the vault: an Accept returns the buyer bond, and a Reclaim the whole lock, as a Returned vault
// output that only the owner can spend; the wallet pays the fee of each. No transaction exists here, so the draft transaction of a refused Pay is the hex of a JSON text, not CBOR.
import { credentialToAddress } from '@lucid-evolution/lucid';
import { formatOutRef, parseOutRef, sha256Utf8Hex } from '@vsa/vector-read';
import type { AdvertDatum, EscrowDatum } from '@vsa/vector-read';
import { encodeVaultDatum, plutusAddressFromBech32 } from '@vsa/vector-read/identity-codec';
import type { ValueLimit } from '@vsa/vector-read/identity-codec';
import { AcceptWindowClosedError, VAULT_PAY_VALID_MINUTES } from './chain.ts';
import type { Chain, ChainEscrowState, PostResult, TxNotConfirmedError, VaultChain, VaultPayResult } from './chain.ts';
import { fleetPostTerms, isIdentityAdvert, planFleetPostEscrow } from './fleet-build.ts';
import { EscrowPlanRefusal, enterpriseAddressOf, fleetAdvertRefusal, planVaultEscrow } from './vendored/mcp/marketplace-build.ts';
import type { EscrowPlanFault, PostEscrowPlan } from './vendored/mcp/marketplace-build.ts';
import { windowAt } from './vendored/mcp/identity-chain.ts';
import { OgmiosRpcError } from './vendored/mcp-shared/provider.ts';
import { VaultPayImpossible, VaultPayRefused, judgeEvaluation } from './vendored/mcp/vault-build.ts';
import type { VaultPayAttempt, VaultPayImpossibleReason } from './vendored/mcp/vault-build.ts';

type FakeState = Exclude<ChainEscrowState, 'unknown'>;
/** `lock`: what the escrow holds (every Post locks FakeChain.LOCK_LOVELACE, a Pay from a vault exactly payment + both bonds). `vault`: the vault that paid it, whose output a refund returns to. */
interface FakeEscrow { datum: EscrowDatum; state: FakeState; resultReceiptHash: string | null; lock: bigint; vault: { delegation: string; owner: string } | null }

/** One output at the vault address: Live (it pays) or Returned (a refund; only its owner spends it), and whether it was spent (`consumed`). `spent` is the sum the delegation limit counts. */
interface FakeVaultOutput { ref: string; kind: 'Live' | 'Returned'; delegation: string; owner: string; lovelace: bigint; spent: bigint; periodStart: number; consumed: boolean }
/** A vault output as a test reads it: a copy. */
export type FakeVaultView = Readonly<FakeVaultOutput>;

/** The refusals of the planner that stay with `ledgerDecides` and the reason that a VaultPayImpossible gives for each (the value cap is the ledger's). */
const PLAN_FAULT_REASON: Record<Exclude<EscrowPlanFault, 'value_cap'>, VaultPayImpossibleReason> = { advert_retired: 'no_advert', buyer_is_supplier: 'buyer_is_supplier', advert_terms: 'advert_terms' };
/** The address of the vault script of this world: a script credential that is no deployed script. */
const VAULT_ADDRESS = credentialToAddress('Mainnet', { type: 'Script', hash: 'ab'.repeat(28) });

export interface FakeChainOptions {
  /** The adverts the chain knows, by ref, in either layout. postEscrow and readAdvert refuse any other ref. */
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
  /** What every Post locks: FakeChain.LOCK_LOVELACE unless this says otherwise, for a test of an advert whose price and bonds ask for more. */
  lockLovelace?: bigint;
}

const RECEIPT_HASH = /^[0-9a-f]{64}$/;
const canonical = (ref: string): string => { const parsed = parseOutRef(ref); return formatOutRef(parsed.txHash, parsed.outputIndex); };

export class FakeChain implements VaultChain {
  /** The lock of every Post: what the live ChandraOCR Post locked (price 200000, both bonds 1000000, raised to the datum's floor). */
  static readonly LOCK_LOVELACE = 2_261_030n;
  /** The fee of every transaction: the marketplace minimum. */
  static readonly FEE_LOVELACE = 500_000n;
  /** What a Pay leaves in the vault at least: the ledger minimum of a vault output (1.271450 units, as the vault script of the live deployment holds). */
  static readonly VAULT_MIN_LOVELACE = 1_271_450n;

  readonly address: string;
  readonly buyerPkh: string;
  readonly #adverts = new Map<string, AdvertDatum>();
  readonly #escrows = new Map<string, FakeEscrow>();
  readonly #clock: () => number;
  readonly #prefix: string;
  readonly #collateral: bigint | null;
  readonly #lock: bigint;
  #float: bigint;
  #posts = 0;
  #failNextPost: TxNotConfirmedError | null = null;
  #failingAccepts: Array<Error | null> = [];
  #acceptWindowClosed = false;
  readonly #vaults = new Map<string, FakeVaultOutput>();
  readonly #delegations = new Map<string, { limit: ValueLimit; ended: boolean }>();
  #vaultOpens = 0;
  #vaultPays = 0;

  constructor(opts: FakeChainOptions = {}) {
    for (const [ref, advert] of Object.entries(opts.adverts ?? {})) this.#adverts.set(canonical(ref), advert);
    this.#clock = opts.clock ?? Date.now;
    this.#prefix = opts.prefix ?? 'fake-chain/';
    this.buyerPkh = opts.buyerPkh ?? 'bb'.repeat(28);
    this.address = enterpriseAddressOf(this.buyerPkh);
    this.#float = opts.floatLovelace ?? 50_000_000n;
    this.#collateral = opts.collateralLovelace === undefined ? 5_000_000n : opts.collateralLovelace;
    this.#lock = opts.lockLovelace ?? FakeChain.LOCK_LOVELACE;
  }

  async wallet(): Promise<{ address: string; buyerPkh: string; collateralLovelace: bigint | null; floatLovelace: bigint }> {
    return { address: this.address, buyerPkh: this.buyerPkh, collateralLovelace: this.#collateral, floatLovelace: this.#float };
  }

  async postEscrow(args: { advertRef: string; promptHash: string }): Promise<PostResult> {
    const advertRef = canonical(args.advertRef);
    const advert = this.#advert(advertRef);
    const plan = planFleetPostEscrow(advert, advertRef, this.buyerPkh, args.promptHash, this.#clock(), fleetPostTerms(advert, this.address));
    const owed = advert.price_lovelace + advert.buyer_bond_lovelace + advert.supplier_bond_lovelace;
    if (owed > this.#lock) throw new Error(`FakeChain locks ${this.#lock} lovelace on every Post, less than the ${owed} advert ${advertRef} asks for.`);
    const cost = this.#lock + FakeChain.FEE_LOVELACE;
    if (this.#float < cost) throw new Error(`FakeChain: the float of ${this.#float} lovelace cannot cover the lock and the fee (${cost}).`);
    const failure = this.#failNextPost;
    if (failure !== null) {
      this.#failNextPost = null;
      throw failure;
    }
    this.#float -= cost;
    const txHash = sha256Utf8Hex(`${this.#prefix}${++this.#posts}`);
    const escrowRef = formatOutRef(txHash, 0);
    this.#escrows.set(escrowRef, { datum: plan.datum, state: 'Open', resultReceiptHash: null, lock: this.#lock, vault: null });
    return {
      escrowRef, txHash, lockLovelace: this.#lock, feeLovelace: FakeChain.FEE_LOVELACE, deliverBy: plan.deliverBy, postedAt: plan.postedAt,
      supplierPkh: plan.datum.supplier_pkh, collateralKept: this.#collateral !== null, agentId: isIdentityAdvert(advert) ? advert.agent_id : null,
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
    const excess = escrow.lock - (d.payment_lovelace + d.buyer_bond_lovelace + d.supplier_bond_lovelace);
    const txHash = sha256Utf8Hex(`${this.#prefix}accept/${ref}`);
    // The buyer bond and the excess of the lock floor go back to the refund address: the wallet for a Post, a Returned vault output for a Pay from a vault.
    if (escrow.vault === null) this.#float += d.buyer_bond_lovelace + excess - FakeChain.FEE_LOVELACE;
    else { this.#float -= FakeChain.FEE_LOVELACE; this.#returned(escrow.vault, d.buyer_bond_lovelace + excess, txHash); }
    return { txHash, feeLovelace: FakeChain.FEE_LOVELACE };
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
    const txHash = sha256Utf8Hex(`${this.#prefix}reclaim/${ref}`);
    if (escrow.vault === null) this.#float += escrow.lock - FakeChain.FEE_LOVELACE;
    else { this.#float -= FakeChain.FEE_LOVELACE; this.#returned(escrow.vault, escrow.lock, txHash); }
    return { txHash, feeLovelace: FakeChain.FEE_LOVELACE };
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
   * Pays an escrow from the Live vault `vaultRef` for the identity advert `advertRef`, as the delegate of the delegation of the vault (this chain's key). See the head of this file for what it
   * models. The refusals are the typed errors of the vendored builder with `ledgerDecides`, so a caller reads them as it reads those of RealChain.
   */
  async payFromVault(args: { vaultRef: string; advertRef: string; payload: string }): Promise<VaultPayResult> {
    if (this.#collateral === null) throw new Error('Collateral required: the wallet must hold one pure units output of at least 5 units.');
    const vaultRef = canonical(args.vaultRef);
    const vault = this.#vaults.get(vaultRef);
    if (vault === undefined || vault.consumed) throw new VaultPayImpossible('no_vault', `Vault ${vaultRef} is not an unspent output on the node: it has been spent or closed, or it is not confirmed yet.`);
    if (vault.kind !== 'Live') throw new VaultPayImpossible('vault_not_live', `Vault ${vaultRef} holds an escrow refund (Returned): only its owner can close it, and it cannot pay.`);
    const delegation = this.#delegations.get(vault.delegation);
    if (delegation === undefined || delegation.ended) throw new VaultPayImpossible('no_delegation', `No live delegation ${vault.delegation}: it does not exist or has been undelegated.`);
    const advertRef = canonical(args.advertRef);
    const advert = this.#adverts.get(advertRef);
    if (advert === undefined) throw new VaultPayImpossible('no_advert', `The node has no unspent output ${advertRef}: the advert was spent (its supplier retired or replaced it), or it is not confirmed yet.`);
    if (!isIdentityAdvert(advert)) throw new VaultPayImpossible('no_advert', `Advert ${advertRef} is no identity-marketplace advert that a vault can pay.`);
    const fleet = fleetAdvertRefusal(advertRef, advert.capability_id);
    if (fleet !== null) throw new VaultPayImpossible('advert_terms', fleet);
    const window = windowAt(this.#clock(), VAULT_PAY_VALID_MINUTES);
    const refund = { address: plutusAddressFromBech32(VAULT_ADDRESS), datum: encodeVaultDatum({ type: 'Returned', owner: { type: 'PrincipalKey', hash: vault.owner, organisation: null } }) };
    let plan: PostEscrowPlan;
    try { plan = planVaultEscrow(advert, advertRef, this.buyerPkh, args.payload, window, { agentId: advert.agent_id, refund }, { capped: false }); } catch (err) {
      if (err instanceof EscrowPlanRefusal && err.fault !== 'value_cap') throw new VaultPayImpossible(PLAN_FAULT_REASON[err.fault], err.message);
      throw err;
    }
    const amount = plan.lockLovelace;
    const newPeriod = window.lo >= vault.periodStart + delegation.limit.periodMs;
    const spent = newPeriod ? amount : vault.spent + amount;
    const periodStart = newPeriod ? window.hi : vault.periodStart;
    const kept = vault.lovelace - amount;
    const attempt: VaultPayAttempt = { amountLovelace: amount, vaultLovelace: kept, spent, periodStart, newPeriod, limit: delegation.limit };
    if (kept < FakeChain.VAULT_MIN_LOVELACE) {
      throw new VaultPayImpossible('below_minimum', `Vault ${vaultRef} holds ${vault.lovelace} lovelace: after the payment of ${amount} it would keep ${kept}, below the ${FakeChain.VAULT_MIN_LOVELACE} its output needs.`);
    }
    // The vault script decides, as the node evaluates it: the payment against per_tx, then the spending of the period against total.
    if (amount > delegation.limit.perTx) throw this.#refused('above_per_tx', `the payment of ${amount} lovelace is above per_tx ${delegation.limit.perTx}`, attempt, args);
    if (spent > delegation.limit.total) throw this.#refused('above_total', `the spending of ${spent} lovelace is above total ${delegation.limit.total}`, attempt, args);
    if (this.#float < FakeChain.FEE_LOVELACE) throw new Error(`FakeChain: the float of ${this.#float} lovelace cannot cover the fee (${FakeChain.FEE_LOVELACE}).`);
    this.#float -= FakeChain.FEE_LOVELACE;
    vault.consumed = true;
    const txHash = sha256Utf8Hex(`${this.#prefix}vault-pay/${++this.#vaultPays}`);
    const escrowRef = formatOutRef(txHash, 0);
    const next = formatOutRef(txHash, 1);
    this.#escrows.set(escrowRef, { datum: plan.datum, state: 'Open', resultReceiptHash: null, lock: amount, vault: { delegation: vault.delegation, owner: vault.owner } });
    this.#vaults.set(next, { ref: next, kind: 'Live', delegation: vault.delegation, owner: vault.owner, lovelace: kept, spent, periodStart, consumed: false });
    return {
      escrowRef, txHash, lockLovelace: amount, feeLovelace: FakeChain.FEE_LOVELACE, deliverBy: plan.deliverBy, postedAt: plan.datum.posted_at, supplierPkh: plan.supplierPkh,
      collateralKept: true, agentId: advert.agent_id, vaultRef: next, vaultLovelace: kept, spent, periodStart, newPeriod, limit: delegation.limit, promptHash: plan.datum.prompt_hash,
      delegateKey: this.buyerPkh,
    };
  }

  /** The datum of the escrow at `escrowRef` as it was posted, or undefined when no escrow is there: what a test, or a stub supplier, asks of the ledger. */
  escrowDatum(escrowRef: string): EscrowDatum | undefined {
    const escrow = this.#escrows.get(canonical(escrowRef));
    return escrow === undefined ? undefined : structuredClone(escrow.datum);
  }

  /**
   * Test hook, the vault that a principal opens under a delegation: a Live vault output of `lovelace`, whose delegation has the value limit `limit`. A second vault under the same delegation
   * must name the same limit. Returns the reference of the vault output.
   */
  openVault(opts: { delegation: string; lovelace: bigint; limit: ValueLimit; owner?: string }): string {
    const known = this.#delegations.get(opts.delegation);
    if (known !== undefined && (known.limit.perTx !== opts.limit.perTx || known.limit.total !== opts.limit.total || known.limit.periodMs !== opts.limit.periodMs)) {
      throw new Error(`FakeChain: the delegation ${opts.delegation} has another value limit than the one given.`);
    }
    if (opts.lovelace < FakeChain.VAULT_MIN_LOVELACE) throw new Error(`FakeChain: a vault holds at least ${FakeChain.VAULT_MIN_LOVELACE} lovelace.`);
    if (known === undefined) this.#delegations.set(opts.delegation, { limit: { ...opts.limit }, ended: false });
    const ref = formatOutRef(sha256Utf8Hex(`${this.#prefix}vault/${++this.#vaultOpens}`), 0);
    this.#vaults.set(ref, { ref, kind: 'Live', delegation: opts.delegation, owner: opts.owner ?? 'cc'.repeat(28), lovelace: opts.lovelace, spent: 0n, periodStart: 0, consumed: false });
    return ref;
  }

  /** Test hook, the end of a delegation (Undelegate): a Pay from any vault under it is VaultPayImpossible from now on. */
  endDelegation(delegation: string): void {
    const known = this.#delegations.get(delegation);
    if (known === undefined) throw new Error(`FakeChain: no delegation ${delegation}.`);
    known.ended = true;
  }

  /** A vault output, Live or Returned, spent or not, or undefined when the ref names none. */
  vault(ref: string): FakeVaultView | undefined {
    const found = this.#vaults.get(canonical(ref));
    return found === undefined ? undefined : { ...found };
  }

  /** Every vault output of this world, in the order they were made. */
  vaults(): FakeVaultView[] {
    return [...this.#vaults.values()].map((output) => ({ ...output }));
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

  /** A Returned vault output for `vault`: where the refund of an escrow that the vault paid goes. Only the owner spends it, and no Pay does. */
  #returned(vault: { delegation: string; owner: string }, lovelace: bigint, txHash: string): void {
    const ref = formatOutRef(txHash, 1);
    this.#vaults.set(ref, { ref, kind: 'Returned', delegation: vault.delegation, owner: vault.owner, lovelace, spent: 0n, periodStart: 0, consumed: false });
  }

  /**
   * The VaultPayRefused of a Pay that the vault script refuses, as the node answers it (the 3010 of Ogmios with the 3012 of the validator), read by the vendored judgeEvaluation, so
   * that isLedgerRefusal tells it. `trace` names the limit; the draft transaction is the hex of a JSON text, as FakeChain builds no transaction.
   */
  #refused(trace: 'above_per_tx' | 'above_total', text: string, attempt: VaultPayAttempt, args: { vaultRef: string; advertRef: string }): VaultPayRefused {
    const validators = [{ validator: { purpose: 'spend', index: 0 }, error: { code: 3012, message: 'Some of the scripts failed to evaluate to a positive outcome.', data: { validationError: text, traces: [trace] } } }];
    const cause = new OgmiosRpcError('evaluateTransaction failed: 3010 Some scripts of the transactions terminated with error(s).', 'evaluateTransaction', 3010, 'Some scripts of the transactions terminated with error(s).', JSON.stringify(validators), false);
    const judged = judgeEvaluation(cause);
    const draft = Buffer.from(JSON.stringify({ draft: 'FakeChain', vault: canonical(args.vaultRef), advert: canonical(args.advertRef), lovelace: String(attempt.amountLovelace) }), 'utf8').toString('hex');
    return new VaultPayRefused(judged.text, judged.validators, draft, attempt, cause);
  }
}
