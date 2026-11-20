// packages/usecase-kit/src/buyer/hire.ts
// The hire of a counterparty from the vault of the delegation: the part of `execute` that pays. The steps, in this order, and each one ends the flow with a typed step when it fails:
//   1. The settings and the message are checked. A limit that is not a bigint or null, and a decision that is not a function, are a fault of the settings (`internal`).
//   2. The authority: the delegation of the message must not name another agent (`delegation_not_mine`). A delegation that is not found goes on.
//   3. The size: the wire payload that is sent must not pass the limit of a service, and the body of the call to the runtime must not pass its limit (`request_too_large`). It is checked here because the hire kit builds both after the Pay.
//   4. One job at a time for the paying key. In that turn the flow reads the Live vault of the delegation, exactly one, and checks that the deadline of the job leaves time for the first poll. Then it
//      hires from the vault with `hireAgent`. The advert is read on the chain: the flow never asks the indexer. The three limits go to the hire kit as the caller gave them.
//   5. The outcome becomes a step (outcome.ts). After a refused Pay the delegation is read again.
// The delegation key is the paying key: it signs the Pay and the Accept. No step retries, and no step hires a second time for the same work.
import { HireInterrupted, HireLane, HirePayUnconfirmed, POLL_INTERVAL_MS, hireAgent } from '@vsa/hire-kit';
import type { AcceptDecision, AgentDeps, AgentDelivery, AgentErrors, AgentOutcome, AgentRequest, HireFailure, PayingKey } from '@vsa/hire-kit';
import { HANDOFF_SCHEMA, parseDid, parseOutputRef } from '@vsa/usecase-kit/protocol';
import type { Did, Handoff, OutputRef, ProtocolResult, RfqMessage } from '@vsa/usecase-kit/protocol';
import { checkAuthority, delegationAfter } from './authority.ts';
import { checkLimits } from './limits.ts';
import type { HireLimits } from './limits.ts';
import { checkRuntimeBody, checkWirePayload, messageOf, requestText } from './message.ts';
import type { CounterpartyMessage } from './message.ts';
import { INCONSISTENT_OUTCOME, deliveryOf, failure, recordOf, stepOfOutcome } from './outcome.ts';
import type { StepContext } from './outcome.ts';
import type { LedgerReads } from './ports.ts';
import type { HireStep, InterruptionCause, RefusedCode, RefusedStep, VerifiedDelivery } from './steps.ts';
import { findLiveVault } from './vault.ts';

/** The decision of a use case on a delivery: accept it, or say no with a reason. The hire kit gives it until the end of its decision window. A decision that does not answer in time is an outcome. */
export type DeliveryDecision = (delivery: VerifiedDelivery) => AcceptDecision | Promise<AcceptDecision>;

interface HireInputBase {
  /** The counterparty as the approved document names it. */
  readonly counterparty_did: Did;
  /** The capability that the advert must have on the chain. The hire kit refuses an advert of another capability before it pays. */
  readonly capability_id: string;
  /** The model that the advert must have on the chain, when the use case pins it. */
  readonly model?: string;
  /** The three limits of the hire. The caller reads them from the settings of the agent and gives all three. */
  readonly limits: HireLimits;
  readonly decide: DeliveryDecision;
}

/** The hire of the counterparty of a handoff. The advert is the one that the approved document names in `document.advert_ref`, and no other advert can be given. */
export interface HandoffHireInput extends HireInputBase {
  readonly message: Handoff;
  readonly advert_ref?: undefined;
}

/** The hire of a bidder with a request for quotation. The caller names the advert that it found. */
export interface QuoteHireInput extends HireInputBase {
  readonly message: RfqMessage;
  readonly advert_ref: OutputRef;
}

export type HireInput = HandoffHireInput | QuoteHireInput;

export interface HireDeps {
  /** The paying key of the delegation key. It signs the Pay and the Accept. Its chain must pay from a vault. */
  readonly key: PayingKey;
  /** The deps of the hire kit: the fetch, the clock, the sleep, the deadline, the ledger that books the lock and the fees, and the log. The indexer is never asked. */
  readonly hire: AgentDeps;
  /** The reads of the delegation and of its vaults. */
  readonly reads: LedgerReads;
}

/** An error that the hire kit asks the flow to make: the factory of `hireAgent`. The kind says which one. The message is the kit's own and is not read. */
type FaultKind = 'unavailable' | 'deadline' | 'store_write' | 'failure';

class HireFault extends Error {
  readonly kind: FaultKind;
  readonly what: HireFailure | null;
  constructor(kind: FaultKind, message: string, what: HireFailure | null) {
    super(message);
    this.name = 'HireFault';
    this.kind = kind;
    this.what = what;
  }
}

/** The decision of a use case ended with an error, or answered with something that is not a decision. The hire ends with this error, and no Accept is made. */
class DecisionError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'DecisionError';
  }
}

const ERRORS: AgentErrors<HireFault> = {
  failure: (_kind, what, message) => new HireFault('failure', message, what),
  deadline: (doing) => new HireFault('deadline', `The deadline of the job came while ${doing}.`, null),
  storeWrite: (message) => new HireFault('store_write', message, null),
  unavailable: (why) => new HireFault('unavailable', `No agent to hire: ${why}.`, null),
};

/**
 * The answer of a decision as the hire kit gets it. Only the boolean `true` accepts. `false` needs a reason that is a text. Any other answer is an error: the hire kit would read a text such as
 * "no" as an acceptance, and a hook that returns nothing would end in a type error that hides what happened.
 */
function decisionOf(answer: unknown): AcceptDecision {
  if (typeof answer !== 'object' || answer === null) throw new DecisionError('the decision did not answer with an object');
  const accept: unknown = Reflect.get(answer, 'accept');
  if (accept === true) return { accept: true };
  const reason: unknown = Reflect.get(answer, 'reason');
  if (accept === false && typeof reason === 'string') return { accept: false, reason };
  throw new DecisionError('the decision must answer { accept: true } or { accept: false, reason }');
}

const lanes = new WeakMap<PayingKey, HireLane>();

/**
 * Runs `job` when every job that was given before it for the same paying key has ended. The flow reads the vault of the delegation and pays from it in one turn: a Pay spends the vault output
 * that was read, so a second job that read the vault before the first Pay would pay from an output that no longer exists. The hire kit has its own lane for the hire, and it cannot be taken
 * twice, so the flow keeps one more lane for the key.
 */
function serially<T>(key: PayingKey, job: () => Promise<T>): Promise<T> {
  let lane = lanes.get(key);
  if (lane === undefined) {
    lane = new HireLane();
    lanes.set(key, lane);
  }
  return lane.run(job);
}

const refusal = (code: RefusedCode, detail: string): RefusedStep => ({ kind: 'refused', code, detail });

interface Prepared {
  readonly message: CounterpartyMessage;
  readonly counterparty: Did;
  readonly advert: OutputRef;
  readonly capability: string;
  readonly model: string | undefined;
  readonly limits: HireLimits;
  readonly decide: DeliveryDecision;
}

type Preparation = { readonly ok: true; readonly value: Prepared } | { readonly ok: false; readonly step: RefusedStep };

/**
 * The input as checked values, or the refusal for the first value that is wrong. A value of the settings or of the code of the use case that is wrong is `internal`. A value that comes from the
 * request and the approved document is `bad_shape`.
 */
function prepareChecked(input: HireInput): Preparation {
  const no = (code: RefusedCode, detail: string): Preparation => ({ ok: false, step: refusal(code, detail) });
  if (typeof input !== 'object' || input === null) return no('internal', 'the input of the hire must be an object');
  const limits = checkLimits(input.limits);
  if (!limits.ok) return no('internal', limits.detail);
  if (typeof input.decide !== 'function') return no('internal', 'decide must be a function that answers accept or reject');
  if (typeof input.capability_id !== 'string' || input.capability_id === '') return no('internal', 'capability_id must be a text that is not empty');
  if (input.model !== undefined && (typeof input.model !== 'string' || input.model === '')) return no('internal', 'model must be a text that is not empty, or left out');
  const message = messageOf(input.message);
  if (!message.ok) return no('bad_shape', message.detail);
  const counterparty = parseDid(input.counterparty_did, 'counterparty_did');
  if (!counterparty.ok) return no('bad_shape', counterparty.detail);
  let advert: ProtocolResult<OutputRef>;
  if (message.value.schema === HANDOFF_SCHEMA) {
    if (input.advert_ref !== undefined) return no('internal', 'the advert of a handoff is the advert that its document names: advert_ref must be left out');
    advert = parseOutputRef(Reflect.get(message.value.document, 'advert_ref'), 'document.advert_ref');
    if (!advert.ok) return no('bad_shape', advert.detail);
  } else {
    advert = parseOutputRef(input.advert_ref, 'advert_ref');
    if (!advert.ok) return no('internal', advert.detail);
  }
  return { ok: true, value: { message: message.value, counterparty: counterparty.value, advert: advert.value, capability: input.capability_id, model: input.model, limits: limits.value, decide: input.decide } };
}

/** The input as checked values, or a refusal. A member of the input that cannot be read (a getter that throws) is `internal`, and the error is not repeated: it could hold a part of the settings. */
function prepare(input: HireInput): Preparation {
  try {
    return prepareChecked(input);
  } catch {
    return { ok: false, step: refusal('internal', 'the input of the hire cannot be read') };
  }
}

/** The reason of the result for an error that ended the hire after the Pay was confirmed. */
function causeOf(cause: unknown): InterruptionCause {
  if (cause instanceof DecisionError) return 'decision_error';
  if (cause instanceof HireFault && cause.kind === 'deadline') return 'deadline';
  if (cause instanceof HireFault && cause.kind === 'store_write') return 'store_write';
  return 'other';
}

/**
 * The step for an error of `hireAgent`. The hire kit wraps every error that follows a Pay: a confirmed Pay is a HireInterrupted, and a Pay that was sent and not seen confirmed is a
 * HirePayUnconfirmed. Any other error came before every Pay, so no vault was spent. `delivery` is what the decision was given, or `null`. The record of an interrupted hire does not say
 * whether the Accept was made: the hire kit wraps an error of its ledger, which can come after the Accept, in the same error as a decision that threw.
 */
function stepOfError(error: unknown, context: StepContext, delivery: VerifiedDelivery | null): HireStep {
  if (error instanceof HireInterrupted) {
    const escrow = parseOutputRef(error.escrowRef, 'escrow');
    if (!escrow.ok) return failure(INCONSISTENT_OUTCOME, 'the hire kit gave an escrow that is not an output reference', { cause: error });
    return {
      kind: 'interrupted', cause_kind: causeOf(error.cause), detail: 'an error ended the hire after the Pay was confirmed', vault_ref: error.vaultRef, escrow_ref: escrow.value,
      handoff: recordOf(context.counterparty_did, context.advert_ref, escrow.value, delivery, null), delivery, cause: error,
    };
  }
  if (error instanceof HirePayUnconfirmed) {
    const escrow = parseOutputRef(error.escrowRef, 'escrow');
    if (!escrow.ok) return failure(INCONSISTENT_OUTCOME, 'the hire kit gave an escrow that is not an output reference', { cause: error });
    return {
      kind: 'pay_unconfirmed', detail: 'the Pay was sent and not seen confirmed, and it may still land', escrow_ref: escrow.value, vault_ref_if_landed: error.vaultRefIfLanded, tx_hash: error.txHash,
      may_land: error.mayLand, valid_to: error.validTo, handoff: recordOf(context.counterparty_did, context.advert_ref, escrow.value, null, null), cause: error,
    };
  }
  const nothingPaid = 'the hire ended before any Pay, and no vault was spent';
  if (error instanceof HireFault) {
    if (error.kind === 'unavailable') return failure('advert_unavailable', `no agent can be hired for the advert of the document: ${nothingPaid}`, { cause: error });
    if (error.kind === 'deadline') return failure('deadline', nothingPaid, { cause: error });
    if (error.kind === 'store_write') return failure('store_write_failed', nothingPaid, { cause: error });
    return failure(error.what ?? 'hire_error', nothingPaid, { cause: error });
  }
  return failure('hire_error', nothingPaid, { cause: error });
}

/**
 * Hires the counterparty of a message from the Live vault of the delegation, and says how the hire ended. It never throws for what the hire can end with: every end is a step. The caller
 * switches on `kind`. Only `completed` is a pass.
 */
export async function hireCounterparty(deps: HireDeps, input: HireInput): Promise<HireStep> {
  const prepared = prepare(input);
  if (!prepared.ok) return prepared.step;
  const { message, counterparty, advert, capability, model, limits, decide } = prepared.value;
  const { key, hire, reads } = deps;
  if (!('payFromVault' in key.chain) || typeof key.chain.payFromVault !== 'function') return refusal('internal', 'the chain of the paying key cannot pay from a vault');

  const authority = await checkAuthority(reads, message.sender_did, message.delegation);
  if (!authority.ok) {
    if (authority.code === 'ledger_unavailable') return failure('ledger_unavailable', authority.detail);
    return refusal(authority.code, authority.detail);
  }
  const text = requestText(message);
  const wire = checkWirePayload(text);
  if (!wire.ok) return refusal(wire.code, wire.detail);
  const size = checkRuntimeBody(text);
  if (!size.ok) return refusal('request_too_large', size.detail);

  return serially(key, async () => {
    const found = await findLiveVault(reads, message.delegation, hire.clock());
    if (!found.ok) return failure(found.code, found.detail);
    // A job that waited for the lane, or for the read of the vault, may have run out of time. The first thing that the hire kit does after the Pay is to wait one poll interval, and it fails when that
    // wait ends after the deadline. A Pay with less time than that is lost: it would lock the money until the reclaim. A moment equal to the deadline is in time, as the hire kit counts it.
    if (hire.clock() + POLL_INTERVAL_MS > hire.deadlineMs) return failure('deadline', 'the deadline of the job leaves no time for the first poll, so nothing was paid');
    // What the decision was given: if the hire ends in an error after the decision started, the step still names the delivery.
    const seen: { delivery: VerifiedDelivery | null } = { delivery: null };
    const request: AgentRequest = {
      selection: { advertRef: advert, capabilityId: capability, ...(model === undefined ? {} : { model }) },
      payload: text, label: 'the handoff', vaultRef: found.vault_ref,
      maxPriceLovelace: limits.maxPriceLovelace, maxSupplierBondLovelace: limits.maxSupplierBondLovelace, maxBuyerBondLovelace: limits.maxBuyerBondLovelace,
      decide: async (delivered: AgentDelivery): Promise<AcceptDecision> => {
        const forDecision = deliveryOf(delivered);
        const forRecord = deliveryOf(delivered);
        if (forDecision === null || forRecord === null) throw new DecisionError('the delivery cannot be given to the decision, because it cannot be written as JSON data');
        seen.delivery = forRecord;
        let answer: unknown;
        try {
          answer = await decide(forDecision);
        } catch (error) {
          throw new DecisionError('the decision ended with an error', error);
        }
        return decisionOf(answer);
      },
    };
    const context = { counterparty_did: counterparty, advert_ref: advert, delegation_after: null };
    let outcome: AgentOutcome;
    try {
      outcome = await hireAgent(key, hire, request, ERRORS);
    } catch (error) {
      return stepOfError(error, context, seen.delivery);
    }
    // The delegation is read again only after a refused Pay: `delegation_ended` decides between the exit states Cancelled and Failed.
    const after = outcome?.outcome === 'vault_refused' ? await delegationAfter(reads, message.delegation) : null;
    return stepOfOutcome(outcome, { ...context, delegation_after: after });
  });
}
