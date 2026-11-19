// scripts/checks/lib/guarded-chain.ts - the chain of the vault checks (2 and 3): the Chain and the VaultChain of buyer-core, with the guards of the checks before every signature.
// RealChain of buyer-core builds a transaction, signs it with the key it holds and sends it. This chain builds the same transactions with the same builders, and then lands each one
// through `session.land`: the guards judge the bytes (the fee, the signers, the inputs, the destinations, the outflow of the wallet, the collateral, what is minted, and for a Pay the
// limits of the vault), the summary is shown, a dry run stops, and only then do the keys of the operator sign. A transaction that lands is written to the state file at once, with
// the escrow and the vault reference that it leaves (a Pay, an Accept and a Reclaim of the hire are parts of a step), so that an error later in the call cannot lose them.
//
// What it does not do: post an escrow from a wallet (`postEscrow`): the vault checks pay from a vault only. What it adds to the results of the interface: an Accept and a Reclaim say
// the Returned output that they leave in the vault (`returnedRef`).
import {
  AcceptWindowClosedError, VAULT_PAY_VALID_MINUTES, buildAccept, buildReclaim, buildVaultPay, decodeIdentityEscrowDatum, enterpriseAddressOf, formatOutRef, koiosUtxoInfo, lucidForAddress, parseOutRef,
  readAdvert as readAdvertOutput, resolveEscrowLineage,
} from './platform.ts';
import type { AdvertDatum, ChainEscrowState, PostResult, VaultChain, VaultPayResult } from './platform.ts';
import { iso, units } from './format.ts';
import { DryStop } from './hire-types.ts';
import type { LandRequest } from './land.ts';
import { commitStep, stepPlan } from './session.ts';
import type { Session } from './session.ts';
import { factsOf } from './txfacts.ts';

/** The names of the transactions of a chain in the state file. A name with a colon is a part of a step; a name without one is a step. */
export interface PartNames {
  pay: string;
  accept: string;
  reclaim: string;
}

/** The value limit of the delegation that the vault pays under: the most that one payment, and all payments of the period, may lock. */
export interface VaultLimits {
  perTx: bigint;
  total: bigint;
}

export type GuardedHost = Pick<Session, 'ring' | 'settings' | 'chain' | 'land' | 'mode' | 'fetchImpl' | 'state' | 'evidence' | 'clock'>;

/** What an Accept or a Reclaim gives beside the result of the interface: the Returned output that it leaves in the vault, or null when the refund does not go to a vault. */
export interface SpendResult {
  txHash: string;
  feeLovelace: bigint;
  returnedRef: string | null;
}

const LIVE_STATES = new Set<ChainEscrowState>(['Open', 'Claimed', 'Submitted']);
const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));
/** A pure output of at least this many units is the collateral of a script step. */
const COLLATERAL_MIN_LOVELACE = 5_000_000n;
const ACCEPT_WINDOW_CLOSED = /^Accept window closed at /;

/** The planner of the Accept says in these words that the accept window has closed: the call can never be made again. */
function acceptRefusal(err: unknown): unknown {
  return err instanceof Error && ACCEPT_WINDOW_CLOSED.test(err.message) ? new AcceptWindowClosedError(err.message, { cause: err }) : err;
}

export class GuardedChain implements VaultChain {
  readonly address: string;
  readonly buyerPkh: string;
  readonly #host: GuardedHost;
  readonly #parts: PartNames;
  readonly #limits: VaultLimits;
  #queue: Promise<void> = Promise.resolve();

  constructor(host: GuardedHost, options: { parts: PartNames; limits: VaultLimits }) {
    const agent = host.ring.get('agent');
    this.address = agent.address;
    this.buyerPkh = agent.keyHash;
    this.#host = host;
    this.#parts = options.parts;
    this.#limits = options.limits;
  }

  async wallet(): Promise<{ address: string; buyerPkh: string; collateralLovelace: bigint | null; floatLovelace: bigint }> {
    const utxos = await this.#host.chain.provider.getUtxos(this.address);
    const total = utxos.reduce((sum, utxo) => sum + (utxo.assets.lovelace ?? 0n), 0n);
    const pure = utxos.filter((utxo) => Object.keys(utxo.assets).every((unit) => unit === 'lovelace') && (utxo.assets.lovelace ?? 0n) >= COLLATERAL_MIN_LOVELACE).map((utxo) => utxo.assets.lovelace ?? 0n);
    const collateralLovelace = pure.length === 0 ? null : pure.reduce((smallest, amount) => (amount < smallest ? amount : smallest), pure[0]!);
    return { address: this.address, buyerPkh: this.buyerPkh, collateralLovelace, floatLovelace: total - (collateralLovelace ?? 0n) };
  }

  postEscrow(): Promise<PostResult> {
    return Promise.reject(new Error('the chain of the vault checks pays from a vault only: it posts no escrow from a wallet'));
  }

  /** Pays an escrow from the Live vault `vaultRef`, as the delegate of its delegation. The node evaluates the scripts; the guards of the check judge the bytes before the delegate key signs. */
  payFromVault(args: { vaultRef: string; advertRef: string; payload: string }): Promise<VaultPayResult> {
    return this.#serial(async () => {
      const { chain } = this.#host;
      const { deployment } = chain;
      if (deployment.refs.vault === undefined) {
        throw new Error('This chain cannot pay from a vault: its identity deployment has no reference script of the vault. Set VECTOR_IDENTITY_VAULT_REF_UTXO. Nothing was built.');
      }
      const lucid = await lucidForAddress(chain.provider, this.address);
      const pay = await buildVaultPay({ lucid, provider: chain.provider, deployment }, {
        changeAddress: this.address, vaultRef: args.vaultRef, advertRef: args.advertRef, payload: args.payload, validMinutes: VAULT_PAY_VALID_MINUTES, ledgerDecides: true,
      }, chain.fetchImpl);
      const others = pay.requiredSigners.map((signer) => signer.keyHash).filter((keyHash) => keyHash !== this.buyerPkh);
      if (others.length > 0) {
        throw new Error(`The Pay needs the signature of ${others.join(', ')}, and this chain signs with ${this.buyerPkh} only: the key of the chain must be the delegate key of the delegation of the vault. Nothing was signed.`);
      }
      const bytes = factsOf(pay.txCbor);
      const escrowDatum = bytes.outputs[0]?.inlineDatum;
      if (escrowDatum === null || escrowDatum === undefined) throw new Error('The Pay has no inline datum at output 0. Nothing was signed.');
      const supplierPkh = decodeIdentityEscrowDatum(escrowDatum).supplier_pkh;
      const collateralKept = bytes.collateralInputs.length > 0 && bytes.collateralInputs.every((ref) => !bytes.inputs.includes(ref));
      const plan = stepPlan(this.#host, {
        outflow: { agent: this.#host.settings.maxFeeLovelace }, explained: new Set([args.vaultRef]), destinations: new Set([deployment.vault.address, deployment.escrow.address]),
        vault: { address: deployment.vault.address, escrowAddress: deployment.escrow.address, perTx: this.#limits.perTx, total: this.#limits.total },
        labels: { [deployment.vault.address]: 'the vault', [deployment.escrow.address]: 'the escrow script' },
      });
      const request: LandRequest = {
        step: this.#parts.pay, built: { unsignedCbor: pay.txCbor, txHash: pay.txHash, feeLovelace: BigInt(pay.fee), validTo: pay.validTo }, plan,
        refs: { escrow_ref: pay.escrowRef, vault_ref: pay.vaultRef },
        facts: { lock_lovelace: pay.amountLovelace, deliver_by: pay.deliverBy, advert_ref: args.advertRef, vault_lovelace: pay.vaultLovelace, spent_in_period: pay.spent },
        notes: [
          `the delegate key ${this.buyerPkh} pays the advert ${args.advertRef} from the vault ${args.vaultRef}: ${units(pay.amountLovelace)} go to the escrow, and the vault continues as ${pay.vaultRef} with ${units(pay.vaultLovelace)}`,
          `the escrow can be reclaimed after ${iso(pay.deliverBy)}; its refund goes to the vault`,
        ],
        escrow: { ref: pay.escrowRef, deliverBy: pay.deliverBy },
      };
      const landed = await this.#host.land(request);
      if (landed.kind === 'dry') throw new DryStop(this.#parts.pay);
      commitStep(this.#host, request, landed, { escrow_ref: pay.escrowRef, vault_ref: pay.vaultRef, lock_lovelace: pay.amountLovelace, deliver_by: iso(pay.deliverBy) });
      return {
        escrowRef: pay.escrowRef, txHash: landed.txHash, lockLovelace: pay.amountLovelace, feeLovelace: landed.feeLovelace, deliverBy: pay.deliverBy, postedAt: pay.validFrom + 60_000, supplierPkh, collateralKept,
        agentId: pay.agentId, vaultRef: pay.vaultRef, vaultLovelace: pay.vaultLovelace, spent: pay.spent, periodStart: pay.periodStart, newPeriod: pay.newPeriod, limit: pay.limit, promptHash: pay.promptHash,
        delegateKey: pay.delegateKey,
      };
    });
  }

  /** Accepts a Submitted escrow: the supplier gets the price and its bond, and the buyer bond returns to the refund address of the escrow (the vault, for an escrow that a vault paid). */
  accept(escrowRef: string): Promise<SpendResult> {
    return this.#serial(async () => {
      const { chain } = this.#host;
      const lucid = await lucidForAddress(chain.provider, this.address);
      let accept;
      try { accept = await buildAccept(lucid, chain.provider, chain.koiosUrl, { changeAddress: this.address, escrowRef, deployment: chain.deployment }, chain.fetchImpl); } catch (err) { throw acceptRefusal(err); }
      const returned = this.#returnedOutput(accept.txCbor, accept.buyerAddress);
      const request: LandRequest = {
        step: this.#parts.accept, built: { unsignedCbor: accept.txCbor, txHash: accept.txHash, feeLovelace: BigInt(accept.fee), validTo: accept.validTo },
        plan: stepPlan(this.#host, {
          outflow: { agent: this.#host.settings.maxFeeLovelace }, explained: new Set([await this.#escrowInput(accept.txCbor)]),
          destinations: new Set([enterpriseAddressOf(accept.supplierPkh), accept.buyerAddress]),
          labels: { [enterpriseAddressOf(accept.supplierPkh)]: 'the supplier', [accept.buyerAddress]: accept.buyerAddress === chain.deployment.vault.address ? 'the vault (the refund of the escrow)' : 'the buyer wallet' },
        }),
        refs: { escrow_ref: escrowRef, ...(returned === null ? {} : { returned_ref: returned }) },
        facts: { supplier_lovelace: accept.supplierLovelace, buyer_lovelace: accept.buyerLovelace },
        notes: [`the delegate key ${this.buyerPkh} accepts the escrow ${escrowRef}: the supplier gets ${units(accept.supplierLovelace)} (the price and its bond), and ${units(accept.buyerLovelace)} return to ${returned === null ? 'the buyer wallet' : 'the vault'}`],
        escrow: { ref: escrowRef, deliverBy: null },
      };
      const landed = await this.#host.land(request);
      if (landed.kind === 'dry') throw new DryStop(this.#parts.accept);
      commitStep(this.#host, request, landed, { escrow_ref: escrowRef, supplier_lovelace: accept.supplierLovelace, returned_ref: returned });
      return { txHash: landed.txHash, feeLovelace: landed.feeLovelace, returnedRef: returned };
    });
  }

  /** Reclaims an Open or Claimed escrow after its deliver_by: everything it holds returns to the refund address of the escrow (the vault, for an escrow that a vault paid). */
  reclaim(escrowRef: string): Promise<SpendResult> {
    return this.#serial(async () => {
      const { chain } = this.#host;
      const lucid = await lucidForAddress(chain.provider, this.address);
      const reclaim = await buildReclaim(lucid, chain.provider, chain.koiosUrl, { changeAddress: this.address, escrowRef, deployment: chain.deployment }, chain.fetchImpl);
      const returned = this.#returnedOutput(reclaim.txCbor, reclaim.buyerAddress);
      const request: LandRequest = {
        step: this.#parts.reclaim, built: { unsignedCbor: reclaim.txCbor, txHash: reclaim.txHash, feeLovelace: BigInt(reclaim.fee), validTo: reclaim.validTo },
        plan: stepPlan(this.#host, {
          outflow: { agent: this.#host.settings.maxFeeLovelace }, explained: new Set([await this.#escrowInput(reclaim.txCbor)]), destinations: new Set([reclaim.buyerAddress]),
          labels: { [reclaim.buyerAddress]: reclaim.buyerAddress === chain.deployment.vault.address ? 'the vault (the refund of the escrow)' : 'the buyer wallet' },
        }),
        refs: { escrow_ref: escrowRef, ...(returned === null ? {} : { returned_ref: returned }) },
        facts: { lock_lovelace: reclaim.buyerLovelace },
        notes: [`the delegate key ${this.buyerPkh} reclaims the escrow ${escrowRef}: ${units(reclaim.buyerLovelace)} return to ${returned === null ? 'the buyer wallet' : 'the vault as a Returned output'}`],
        escrow: { ref: escrowRef, deliverBy: null },
      };
      const landed = await this.#host.land(request);
      if (landed.kind === 'dry') throw new DryStop(this.#parts.reclaim);
      commitStep(this.#host, request, landed, { escrow_ref: escrowRef, lock_lovelace: reclaim.buyerLovelace, returned_ref: returned });
      return { txHash: landed.txHash, feeLovelace: landed.feeLovelace, returnedRef: returned };
    });
  }

  async escrowState(escrowRef: string): Promise<ChainEscrowState> {
    const lineage = await this.#lineage(escrowRef);
    if (lineage === 'unknown') return 'unknown';
    if (!lineage.current) return 'spent';
    const state = lineage.current.datum.state as ChainEscrowState;
    return LIVE_STATES.has(state) ? state : 'unknown';
  }

  async onChainReceiptHash(escrowRef: string): Promise<string | null> {
    const lineage = await this.#lineage(escrowRef);
    const live = lineage === 'unknown' ? null : lineage.current;
    return live?.datum.state === 'Submitted' ? live.datum.result_receipt_hash : null;
  }

  async readAdvert(advertRef: string): Promise<AdvertDatum> {
    const { chain } = this.#host;
    let read;
    try { read = await readAdvertOutput(advertRef, chain.fetchImpl, chain.koiosUrl, chain.deployment.advert.address); } catch (err) { throw new Error(`Could not read advert ${advertRef.trim()}: ${errorText(err)}`); }
    if ('error' in read) throw new Error(read.error);
    return read.advert;
  }

  /** The escrow's lineage, or `unknown` when the indexer has no output at the ref. Anything else that cannot be settled is thrown, so that "cannot tell" is never taken for "gone". */
  async #lineage(escrowRef: string) {
    const { chain } = this.#host;
    const ref = parseOutRef(escrowRef);
    const canonical = formatOutRef(ref.txHash, ref.outputIndex);
    let rows;
    try { rows = await koiosUtxoInfo(chain.koiosUrl, [canonical], chain.fetchImpl); } catch (err) { throw new Error(`Could not read escrow ${canonical}: ${errorText(err)}`); }
    if (!rows.some((u) => String(u?.tx_hash).toLowerCase() === ref.txHash && u?.tx_index === ref.outputIndex)) return 'unknown' as const;
    return resolveEscrowLineage(chain.provider, chain.koiosUrl, canonical, chain.fetchImpl, chain.deployment);
  }

  /** The one output of the escrow script that the transaction spends. Any other count is a transaction that the step did not plan. */
  async #escrowInput(txCbor: string): Promise<string> {
    const { chain } = this.#host;
    const held = await chain.provider.getUtxosByOutRef(factsOf(txCbor).inputs.map((ref) => parseOutRef(ref)));
    const atEscrow = held.filter((utxo) => utxo.address === chain.deployment.escrow.address);
    if (atEscrow.length !== 1) throw new Error(`The transaction spends ${atEscrow.length} outputs of the escrow script, and the step plans one. Nothing was signed.`);
    return `${atEscrow[0]!.txHash}#${atEscrow[0]!.outputIndex}`;
  }

  /** The reference of the output that returns to the vault in this transaction (an inline datum at the vault address), or null when the refund goes to the wallet. */
  #returnedOutput(txCbor: string, refundAddress: string): string | null {
    if (refundAddress !== this.#host.chain.deployment.vault.address) return null;
    const facts = factsOf(txCbor);
    const output = facts.outputs.find((candidate) => candidate.address === refundAddress && candidate.inlineDatum !== null);
    return output === undefined ? null : `${facts.txHash}#${output.index}`;
  }

  /** Runs `work` after every call queued before it has settled, whatever its outcome: the calls spend the same wallet. */
  #serial<T>(work: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(work);
    this.#queue = run.then(() => undefined, () => undefined);
    return run;
  }
}

