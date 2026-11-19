// scripts/checks/lib/hire-adapter.ts - the one file of the mainnet checks that imports the hire kit. It makes a `HirePort` (hire-types.ts) from the kit for the vault checks (2 and 3):
//   hire     `hireAgent` of the kit, from the paying key of the delegate key: it picks the advert, pays it from the vault, sends the job, polls, checks the receipt, accepts.
//   pay      the Pay of the same advert from the vault, and no job. The escrow goes into the stranded store of the key, as the kit does for an escrow that it leaves behind.
//   reclaim  one pass of the janitor of the key. It reclaims the escrow that is due, and the lock returns to the vault as a Returned output.
// The chain of the paying key is the guarded chain (guarded-chain.ts): every transaction of the kit goes through the guards of the check before a key signs it. A chain of the kit that a
// test gives in its place takes the same road. The port wraps the chain with a recorder: the recorder keeps what the chain did (the Pay, the Accept, the Reclaim, a Pay that was sent and not
// seen confirmed, a dry stop), because the kit swallows some errors (the janitor writes a failed Reclaim as a note) and the check needs to say what happened.
//
// What the kit says maps to the port in one way. An outcome that is not `completed` and an error of the kit are a `HireFailed` that holds what is known of the Pay: the escrow, the vault
// output that continues after a confirmed Pay, and, for a Pay that was sent and not seen confirmed, no vault output. A dry run that reached its first transaction is a `DryStop`.
import { join } from 'node:path';
import { HireInterrupted, PayingKeys, advertOnChain, bondProblem, hireAgent, runJanitorOnce } from '../../../packages/hire-kit/src/index.ts';
import type { AgentDeps, AgentErrors, AgentOutcome, AgentRequest, HireDetail, HireFacts, PayingKey } from '../../../packages/hire-kit/src/index.ts';
import { TxNotConfirmedError, formatOutRef, parseOutRef } from './platform.ts';
import type { AdvertDatum, ChainEscrowState, PostResult, VaultChain, VaultPayResult } from './platform.ts';
import type { EvidenceFile } from './evidence.ts';
import { GuardedChain } from './guarded-chain.ts';
import type { GuardedHost, PartNames, SpendResult } from './guarded-chain.ts';
import { DryStop, HireFailed } from './hire-types.ts';
import type { AfterPay, HireLimits, HirePort, VaultHired, VaultHireRequest, VaultPaid, VaultPayRequest, VaultReclaimed } from './hire-types.ts';
import type { Clock, Output } from './ports.ts';

/** How long a hire may run: the window of the agent is 300 seconds, and the kit polls inside it. */
export const HIRE_DEADLINE_MS = 15 * 60_000;
/** The text that an escrow of check 3 commits to. No job is sent, so no agent reads it. */
export const REFUND_PAYLOAD = 'The refund check pays this advert from a vault and sends no job.';

export type PortKind = 'escrow' | 'refund';

/** The names of the transactions in the state file. The Pay and the Accept of a hire are parts of the step hire; the Pay and the Reclaim of check 3 are steps. */
const PARTS: Record<PortKind, PartNames> = {
  escrow: { pay: 'hire:pay', accept: 'hire:accept', reclaim: 'reclaim' },
  refund: { pay: 'pay', accept: 'hire:accept', reclaim: 'reclaim' },
};

/** What the port needs of a check, besides the chain: the clock, the `fetch`, the screen and the evidence file. A session of a check is one. */
export interface PortHost {
  clock: Clock;
  fetchImpl: typeof fetch;
  out: Output;
  evidence: Pick<EvidenceFile, 'add'>;
}

/** The error of the factory that the kit is given. It keeps what the kit says of a failure, so that the port can turn it into a `HireFailed`. */
class KitFailure extends Error {
  readonly code: string;
  readonly facts: HireFacts | undefined;
  readonly detail: HireDetail | undefined;
  constructor(code: string, message: string, facts?: HireFacts, detail?: HireDetail) {
    super(message);
    this.name = 'KitFailure';
    this.code = code;
    this.facts = facts;
    this.detail = detail;
  }
}

const KIT_ERRORS: AgentErrors<KitFailure> = {
  failure: (kind, what, message, facts, detail) => new KitFailure(`${kind}_${what}`, message, facts, detail),
  deadline: (doing, facts) => new KitFailure('deadline', `The deadline of the hire came while ${doing}.`, facts),
  storeWrite: (message, facts) => new KitFailure('store_write_failed', message, facts),
  unavailable: (why) => new KitFailure('no_agent', `No agent to hire: ${why}.`),
};

const returnedOf = (result: { txHash: string; feeLovelace: bigint }): string | null => ('returnedRef' in result && typeof result.returnedRef === 'string' ? result.returnedRef : null);
const canonical = (ref: string): string => { const parsed = parseOutRef(ref); return formatOutRef(parsed.txHash, parsed.outputIndex); };
const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** The chain of the kit, with a memory of what it did. Every call goes to the chain that it wraps. */
class RecordingChain implements VaultChain {
  paid: VaultPayResult | null = null;
  accepted: SpendResult | null = null;
  reclaimed: SpendResult | null = null;
  /** A Pay that was sent and not seen confirmed: it may still land. */
  unconfirmed: TxNotConfirmedError | null = null;
  /** The dry stop that ended a call: the kit and the janitor may wrap or swallow it, so the chain keeps it. */
  dry: DryStop | null = null;
  readonly #inner: VaultChain;

  constructor(inner: VaultChain) {
    this.#inner = inner;
  }

  wallet(): Promise<{ address: string; buyerPkh: string; collateralLovelace: bigint | null; floatLovelace: bigint }> { return this.#inner.wallet(); }
  postEscrow(args: { advertRef: string; promptHash: string }): Promise<PostResult> { return this.#inner.postEscrow(args); }
  escrowState(escrowRef: string): Promise<ChainEscrowState> { return this.#inner.escrowState(escrowRef); }
  onChainReceiptHash(escrowRef: string): Promise<string | null> { return this.#inner.onChainReceiptHash(escrowRef); }
  readAdvert(advertRef: string): Promise<AdvertDatum> { return this.#inner.readAdvert(advertRef); }

  payFromVault(args: { vaultRef: string; advertRef: string; payload: string }): Promise<VaultPayResult> {
    return this.#watched(async () => { this.paid = await this.#inner.payFromVault(args); return this.paid; }, true);
  }

  accept(escrowRef: string): Promise<SpendResult> {
    return this.#watched(async () => { const done = await this.#inner.accept(escrowRef); this.accepted = { txHash: done.txHash, feeLovelace: done.feeLovelace, returnedRef: returnedOf(done) }; return this.accepted; }, false);
  }

  reclaim(escrowRef: string): Promise<SpendResult> {
    return this.#watched(async () => { const done = await this.#inner.reclaim(escrowRef); this.reclaimed = { txHash: done.txHash, feeLovelace: done.feeLovelace, returnedRef: returnedOf(done) }; return this.reclaimed; }, false);
  }

  async #watched<T>(call: () => Promise<T>, paying: boolean): Promise<T> {
    try {
      return await call();
    } catch (err) {
      if (err instanceof DryStop) this.dry = err;
      if (paying && err instanceof TxNotConfirmedError && err.mayLand) this.unconfirmed = err;
      throw err;
    }
  }
}

class KitPort implements HirePort {
  readonly #host: PortHost;
  readonly #chain: RecordingChain;
  readonly #keys: PayingKeys;
  #paying: Promise<PayingKey> | null = null;

  constructor(host: PortHost, chain: VaultChain, stateDir: string) {
    this.#host = host;
    this.#chain = new RecordingChain(chain);
    this.#keys = new PayingKeys(join(stateDir, 'hire'));
  }

  /** The paying key of the chain: its store and its lane. Made once. */
  #key(): Promise<PayingKey> {
    this.#paying ??= this.#keys.add(this.#chain);
    return this.#paying;
  }

  async hire(request: VaultHireRequest): Promise<VaultHired> {
    const key = await this.#key();
    const { clock } = this.#host;
    const problem = await this.#advertProblem(request.advertRef, request);
    if (problem !== null) throw new HireFailed('other', problem);
    const deps: AgentDeps = {
      clock: () => clock.now(), sleep: (ms) => clock.sleep(ms), deadlineMs: clock.now() + HIRE_DEADLINE_MS, fetchImpl: this.#host.fetchImpl,
      ledger: { posted: () => undefined, accepted: () => undefined }, log: (line) => { this.#host.out.out(line); },
    };
    const limits = limitsOf(request);
    const agentRequest: AgentRequest = { selection: { advertRef: request.advertRef }, payload: request.payload, label: 'the vault escrow check', vaultRef: request.vaultRef, ...limits };
    let outcome: AgentOutcome;
    try {
      outcome = await hireAgent(key, deps, agentRequest, KIT_ERRORS);
    } catch (err) {
      throw this.#failure(err);
    }
    return this.#hired(outcome);
  }

  /**
   * Why the advert may not be paid under the limits of the request: it is not Active, or its price or one of its bonds is above the limit. Null when it may be paid. The limits are compared with
   * the values in the advert, as the kit compares them. The port asks first, for a hire and for a Pay alike: the Pay of check 3 has no call of the kit, and the words are the same.
   */
  async #advertProblem(advertRef: string, limits: HireLimits): Promise<string | null> {
    const advert = await advertOnChain(this.#chain, advertRef, (why) => new HireFailed('other', `No agent to pay: ${why}.`));
    if (advert.status !== 'Active') return `its advert ${advertRef} is ${advert.status} on chain, not Active`;
    if (limits.maxPriceLovelace !== null && advert.price_lovelace > limits.maxPriceLovelace) {
      return `its advert ${advertRef} is priced ${advert.price_lovelace} lovelace, above the limit of ${limits.maxPriceLovelace} lovelace`;
    }
    return bondProblem(advertRef, advert, limits);
  }

  async pay(request: VaultPayRequest): Promise<VaultPaid> {
    const key = await this.#key();
    try {
      return await key.lane.run(async () => {
        const problem = await this.#advertProblem(request.advertRef, request);
        if (problem !== null) throw new HireFailed('other', problem);
        const paid = await this.#chain.payFromVault({ vaultRef: request.vaultRef, advertRef: request.advertRef, payload: REFUND_PAYLOAD });
        key.stranded.add({ escrow_ref: paid.escrowRef, deliver_by: paid.deliverBy, posted_at: paid.postedAt, kind: 'agent' });
        return { escrowRef: paid.escrowRef, vaultRef: paid.vaultRef, txHash: paid.txHash, lockLovelace: paid.lockLovelace, deliverBy: paid.deliverBy };
      });
    } catch (err) {
      const unconfirmed = this.#chain.unconfirmed;
      // A Pay that may still land is written to the store with the end of its validity, as the kit does: the janitor reads it as unknown until then.
      if (unconfirmed !== null && unconfirmed.deliverBy !== null) key.stranded.add({ escrow_ref: unconfirmed.escrowRef, deliver_by: unconfirmed.deliverBy, posted_at: this.#host.clock.now(), kind: 'agent', valid_to: unconfirmed.validTo });
      throw this.#failure(err);
    }
  }

  async reclaim(escrow: { escrowRef: string; deliverBy: number }): Promise<VaultReclaimed> {
    const key = await this.#key();
    // An escrow that the store does not hold (a crash before the kit wrote it) is added from what the state file knows of it.
    if (key.stranded.get(escrow.escrowRef) === undefined) key.stranded.add({ escrow_ref: escrow.escrowRef, deliver_by: escrow.deliverBy, posted_at: escrow.deliverBy, kind: 'agent' });
    const actions = await runJanitorOnce(key.stranded, key.chain, this.#host.clock.now(), () => key.lane.busy);
    if (this.#chain.dry !== null) throw this.#chain.dry;
    const mine = actions.find((action) => canonical(action.escrow_ref) === canonical(escrow.escrowRef));
    const { reclaimed } = this.#chain;
    if (mine?.action === 'reclaimed' && reclaimed !== null && reclaimed.returnedRef !== null) return { txHash: reclaimed.txHash, returnedRef: reclaimed.returnedRef };
    throw new HireFailed('other', `the janitor did not reclaim the escrow ${escrow.escrowRef}: ${mine === undefined ? 'it is not in the store' : `${mine.action}, ${mine.note}`}`);
  }

  /** What an outcome of the kit is for the check: the result of a hire that completed, or a failure that holds what is known of the Pay. */
  #hired(outcome: AgentOutcome): VaultHired {
    switch (outcome.outcome) {
      case 'completed': {
        const { paid, accepted } = this.#chain;
        if (outcome.accepted !== 'confirmed') {
          throw new HireFailed('other', 'the Accept was sent and is not yet seen confirmed: run the step again, which settles the transaction first', this.#afterOutcome(outcome.escrowRef, outcome.vaultRef));
        }
        if (paid === null || accepted === null) throw new HireFailed('other', 'the kit says that the hire completed, and the chain of the check did not see its Pay and its Accept', this.#afterOutcome(outcome.escrowRef, outcome.vaultRef));
        return { escrowRef: outcome.escrowRef, vaultRef: outcome.vaultRef ?? paid.vaultRef, payTxHash: paid.txHash, acceptTxHash: accepted.txHash, lockLovelace: paid.lockLovelace, text: outcome.text, returnedRef: accepted.returnedRef };
      }
      case 'refused_before_claim':
        throw new HireFailed('refused_before_claim', `${outcome.message} (the runtime said ${outcome.code}, status ${outcome.status})`, this.#afterOutcome(outcome.escrowRef, outcome.vaultRef));
      case 'failed_after_claim':
        throw new HireFailed('failed_after_claim', `${outcome.message} (${outcome.reason})`, this.#afterOutcome(outcome.escrowRef, outcome.vaultRef));
      case 'not_accepted':
        throw new HireFailed('not_accepted', outcome.message, this.#afterOutcome(outcome.escrowRef, outcome.vaultRef));
      case 'vault_refused':
        if (outcome.refusal.kind !== 'impossible') {
          // The script of the vault refused the Pay, or the node did not evaluate it: nothing was signed, and the evidence keeps the words of the node and the draft that it evaluated.
          this.#host.evidence.add({ step: 'hire', status: 'refused', expected: false, tx_hash: null, evaluation_error: outcome.refusal.evaluationError, transaction_body: outcome.refusal.body });
        }
        throw new HireFailed('vault_refused', outcome.message);
    }
  }

  /** What an error is for the check: a dry stop stays one, and any other error is a failure that holds what the chain saw of the Pay. */
  #failure(err: unknown): Error {
    if (this.#chain.dry !== null) return this.#chain.dry;
    if (err instanceof HireFailed) return err;
    const interrupted = err instanceof HireInterrupted ? err : null;
    const cause = interrupted === null ? err : interrupted.cause;
    return new HireFailed('other', messageOf(cause), this.#afterError(interrupted?.vaultRef ?? null));
  }

  /** What the chain saw of a Pay: a confirmed one (with the vault that continues), or one that was sent and not seen confirmed (with none), or nothing. */
  #afterError(vaultRef: string | null): AfterPay | null {
    const { paid, unconfirmed } = this.#chain;
    if (paid !== null) return { escrowRef: paid.escrowRef, vaultRef: vaultRef ?? paid.vaultRef, deliverBy: paid.deliverBy, lockLovelace: paid.lockLovelace };
    if (unconfirmed !== null) return { escrowRef: unconfirmed.escrowRef, vaultRef: null, deliverBy: unconfirmed.deliverBy, lockLovelace: null };
    return null;
  }

  #afterOutcome(escrowRef: string, vaultRef: string | null): AfterPay {
    const { paid } = this.#chain;
    return { escrowRef, vaultRef: vaultRef ?? paid?.vaultRef ?? null, deliverBy: paid?.deliverBy ?? null, lockLovelace: paid?.lockLovelace ?? null };
  }
}

/** The three limits of a hire as the kit takes them: a bigint or null, never missing. */
function limitsOf(request: HireLimits): { maxPriceLovelace: bigint | null; maxSupplierBondLovelace: bigint | null; maxBuyerBondLovelace: bigint | null } {
  const { maxPriceLovelace, maxSupplierBondLovelace, maxBuyerBondLovelace } = request;
  return { maxPriceLovelace, maxSupplierBondLovelace, maxBuyerBondLovelace };
}

/** A port over a chain of the kit. The chain pays from a vault; the stranded store of its paying key is in `stateDir`. */
export function createHirePort(host: PortHost, chain: VaultChain, options: { stateDir: string }): HirePort {
  return new KitPort(host, chain, options.stateDir);
}

const ports = new WeakMap<object, HirePort>();

/**
 * The port of a session of a vault check: over the guarded chain, whose transactions the guards of the session judge. The value limit of the delegation comes from the state file (the step
 * delegate wrote it). One port for one session: the second call gets the first.
 */
export function vaultPort(session: GuardedHost & PortHost, kind: PortKind): HirePort {
  const known = ports.get(session);
  if (known !== undefined) return known;
  const delegated = session.state.step('delegate');
  if (delegated === undefined) throw new Error('the vault checks pay under the delegation of their step delegate, and that step is not recorded');
  const perTx = BigInt(String(delegated.facts.limit_lovelace));
  const total = BigInt(String(delegated.facts.total_lovelace ?? delegated.facts.limit_lovelace));
  const port = createHirePort(session, new GuardedChain(session, { parts: PARTS[kind], limits: { perTx, total } }), { stateDir: session.settings.stateDir });
  ports.set(session, port);
  return port;
}
