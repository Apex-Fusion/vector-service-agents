// agents/reorder-agent/src/propose/propose.ts
// The job `propose` of the Reorder Agent (use case 1, inventory reorder). It reads the stock of one SKU through a sub-delegation to `stock-reader`, reads the supplier, asks the model for a lot, builds the
// purchase order, and returns the proposal. Nothing is paid here. The hirer reads the order and approves its digest, and `execute` then places it.
//
// The steps, in this order. A failure of a step is a typed result: `failedProposalResult` with a code, and no step reads success from a text.
//   1. The authority. A delegation that names another agent as its delegate is a refusal that the service answers with its status (`ProposeRefusal`, `delegation_not_mine`). A delegation that the ledger does not
//      show goes on, because the ledger decides when the order is paid. A ledger that cannot be read is `failed` `ledger_unavailable`.
//   2. The paying key: the delegate key of the delegation, found among the delegation keys of this agent. No sub-delegation is possible without it, and nothing is sent: `ledger_unavailable` for a ledger that
//      cannot be read, `delegation_not_found` for a delegation that the ledger does not show, `delegation_key_unknown` for a key that this agent does not hold.
//   3. The supplier. It is read before anything is sent to the chain, so a supplier that is not listed costs nothing. A failure is `failed` with the code of the reader.
//   4. The stock, through `withSubDelegation` of the kit: one action (`erp.stock.read`) on one resource, one hop below the delegation of the hirer, no value, made by the delegation key of this agent and the
//      delegation key of the subagent. The subagent asks the gateway for its token after the 30 confirmations and reads the stock with it. The sub-delegation is ENDED in every case: after the stock, after a
//      refusal, after a failure, after a throw and after a timeout. A reading whose SKU is not the SKU of the request is `failed` `stock_reading_mismatch`.
//   5. The model decision `reorder`, once. A failure gives `failed` with its code, and the decision is kept in the result when a later step fails. The order is built from the choice only when it EQUALS the
//      choice that the decision records: no code changes what the model chose, and a difference is `failed` `decision_mismatch`.
//   6. The purchase order. The number comes from the counter, which stores it before this step uses it. The document must be accepted by `parsePurchaseOrder`. The choice of the model is kept as it is.
//
// The records of a sub-delegation. `beforeSend` first reads the list of left sub-delegations: an entry with the id of this sub-delegation means that an earlier Delegate of the same key is on its way, because the
// builder takes the id from the largest output of the wallet, and the run then sends nothing and records nothing. The read has a bound of its own inside the bound of the hook, so that a late answer never finds a
// run that ended. One damaged file of the list does not block the run, but a damaged file with the name of this sub-delegation does. Each stop writes one line with its cause to the log. Else the hook adds the id
// to the set of the sub-delegations that a run uses, and it stores the entry in the list, both BEFORE the Delegate is sent. After the run, an end that is `ended` or `not_made` removes the entry, and an end that
// is `not_ended` stores the entry again with the Undelegate that was tried. Then the id leaves the set, on every path. So the janitor never ends the sub-delegation of a run that still waits, and a run that did
// not end its sub-delegation leaves an entry for the janitor. A failure to update the list after the run changes no result: the entry that `beforeSend` stored stays, and the janitor ends it or drops it.
//
// Time. Every wait of the job is bounded by the deadline: `PROPOSE_DEADLINE_MS` after the arrival of the job. A call of a port that would start after it is not made. The sub-delegation gets a budget that
// leaves room for its end step inside the deadline, and a job that arrives with less time than the least budget fails with `deadline` before it sends anything. The update of the list after the run has a bound
// of its own, because the end of a sub-delegation must be recorded also when the time is out.
import {
  DEFAULT_CONFIRMATION_WAIT_MS, DEFAULT_END_TIMEOUT_MS, DEFAULT_POLL_MS, DEFAULT_STEP_TIMEOUT_MS, GATEWAY_FAILURES, SUB_DELEGATION_FAILURES, askWhileTooYoung, callWithToken, requestSubagentToken, tokenTarget,
  withSubDelegation, within,
} from '@vsa/usecase-kit/access';
import type { RouteTokenResult, SubDelegationEnd, SubDelegationHandle, TokenTarget } from '@vsa/usecase-kit/access';
import { checkAuthority, failedProposalResult, proposedResult } from '@vsa/usecase-kit/buyer';
import type { ProposalPieces } from '@vsa/usecase-kit/buyer';
import { LOT_NAMES, PO_SCHEMA, isLotName, parsePurchaseOrder, poNumberOf } from '@vsa/usecase-kit/inventory';
import { DamagedLeftEntriesError } from '@vsa/usecase-kit/janitor';
import { ERROR_STATUS, canonicalJson, canonicalSha256, isPlainObject } from '@vsa/usecase-kit/protocol';
import type { Decision, DelegationId, Document, JsonValue, ProposalResult } from '@vsa/usecase-kit/protocol';
import type { DelegationKey, LeftEntry, ProposeDeps, ProposeRequest, SupplierRead } from './ports.ts';

/** The job deadline of the Reorder Agent: the time from the arrival of a job to the end of every wait of `propose`, in milliseconds. */
export const PROPOSE_DEADLINE_MS = 1_620_000;

/** The longest wait for the 30 confirmations of the sub-delegation. A trimmed wait is never shorter than the least wait below. */
const CONFIRMATION_WAIT_MS = DEFAULT_CONFIRMATION_WAIT_MS;
/** The least wait that makes sense for 30 confirmations: they take about two minutes, so a shorter wait would end before the gateway can issue a token. */
const MIN_CONFIRMATION_WAIT_MS = 180_000;
/** The longest time that the subagent keeps asking while the gateway says that the delegation is too young: the gateway reads the ledger by itself, and it may see the 30 confirmations later than this agent. */
const TOKEN_PATIENCE_MS = 120_000;
/** The longest time of the job under the sub-delegation: the patience, one token request, and one call of the ERP with room to spare. */
const JOB_TIMEOUT_MS = 240_000;
/** The longest time of the end step of the sub-delegation: the default of the access folder. */
const END_TIMEOUT_MS = DEFAULT_END_TIMEOUT_MS;
/** The time that the sub-delegation stays valid after its job: it ends by itself then, when its end step failed and the janitor did not end it. */
const VALIDITY_SLACK_MS = 300_000;
/** The bound of one update of the list of left sub-delegations after the run. */
const BOOKKEEPING_TIMEOUT_MS = DEFAULT_STEP_TIMEOUT_MS;
/** The longest wait for the read of the list inside the hook before the send. The hook has the bound `DEFAULT_STEP_TIMEOUT_MS` in the access folder, so this wait is a third of it: a read that answers later never finds a run that is still waiting. */
const LIST_TIMEOUT_MS = DEFAULT_STEP_TIMEOUT_MS / 3;

/** The codes of a failed proposal that this folder gives. The codes of the reader of the supplier, of the model decision and of a mock system pass through, and they are not in this list. */
const OWN_FAILURES = [
  'ledger_unavailable', 'delegation_not_found', 'delegation_key_unknown', 'stock_read_timeout', 'stock_reading_invalid', 'stock_reading_mismatch', 'mock_system_failed', 'decision_mismatch',
  'bad_document', 'store_write_failed', 'deadline', 'aborted', 'internal',
] as const;

/**
 * Every code that `runPropose` gives as the reason of a failed proposal, except the codes that pass through from the reader of the supplier, from the model decision and from a mock system. A failure of
 * the sub-delegation is `sub_delegation_` and the code of the access folder, and a failure of the token is `token_` and its code.
 */
export const PROPOSE_FAILURES: readonly string[] = Object.freeze([
  ...OWN_FAILURES,
  ...SUB_DELEGATION_FAILURES.map((code) => `sub_delegation_${code}`),
  ...GATEWAY_FAILURES.map((code) => `token_${code}`),
]);

const TENANT_RULE = 'request.tenant must be 1 to 48 characters: lower-case letters, digits and hyphens, and it starts with a letter or a digit';

/**
 * A request that the job refuses before it does anything: a delegation that names another agent (`delegation_not_mine`), and a request that cannot be served (`bad_shape`). The status is the status of the
 * code in `ERROR_STATUS`. The message names the member and never repeats a value of the request.
 */
export class ProposeRefusal extends Error {
  readonly code: 'delegation_not_mine' | 'bad_shape';
  readonly status: number;

  constructor(code: 'delegation_not_mine' | 'bad_shape', message: string) {
    super(message);
    this.name = 'ProposeRefusal';
    this.code = code;
    this.status = ERROR_STATUS[code];
  }
}

/** What one job knows from its start: its deps, its request, its deadline and the signal of the caller. */
interface Run {
  readonly deps: ProposeDeps;
  readonly request: ProposeRequest;
  readonly deadline: number;
  readonly signal: AbortSignal | undefined;
}

/** The answer of one call of a port: its value, a throw, or the end of the time. */
type Attempt<T> = { readonly state: 'value'; readonly value: T } | { readonly state: 'threw' } | { readonly state: 'timed_out' };

/** The stock that the subagent read, or the code of the failure. */
type StockRead = { readonly ok: true; readonly reading: Document } | { readonly ok: false; readonly code: string };

/**
 * Runs a call of a port and gives its answer. The call is bounded by the time that is left until the deadline, and it is not made when no time is left. A throw is `threw`, and the words of the error are
 * dropped: they could repeat a part of a request.
 */
async function attempt<T>(run: Run, call: () => Promise<T>): Promise<Attempt<T>> {
  const left = Math.min(run.deadline - run.deps.clock.now(), PROPOSE_DEADLINE_MS);
  if (!(left >= 1)) return { state: 'timed_out' };
  try {
    const bounded = await within(run.deps.clock, left, () => call());
    return bounded.timedOut ? { state: 'timed_out' } : { state: 'value', value: bounded.value };
  } catch {
    return { state: 'threw' };
  }
}

/** A code with the form of a code: lower-case letters, digits and `_`, 64 characters at most. Any other text, such as the words of a system, becomes `internal`. */
const CODE_FORM = /^[a-z0-9_]{1,64}$/;

/** The pieces of a proposal result: the decisions so far and the sub-jobs that bought them. The service stamps `fault_mode` on every result, so the job writes the empty text. */
function piecesOf(decisions: readonly Decision[]): ProposalPieces {
  return { use_case: 'inventory-reorder', decisions, sub_jobs: decisions.map((decision) => decision.inference.sub_job), fault_mode: '' };
}

/** True when the reader of the supplier gave what its contract says: for each lot an advert reference, and a size that is a whole number of 1 or more. */
function isSupplierRead(value: unknown): value is SupplierRead {
  if (typeof value !== 'object' || value === null) return false;
  const adverts: unknown = Reflect.get(value, 'adverts');
  const lots: unknown = Reflect.get(value, 'lots');
  if (typeof adverts !== 'object' || adverts === null || typeof lots !== 'object' || lots === null) return false;
  return LOT_NAMES.every((lot) => {
    const advert: unknown = Reflect.get(adverts, lot);
    const size: unknown = Reflect.get(lots, lot);
    const ref: unknown = typeof advert === 'object' && advert !== null ? Reflect.get(advert, 'advert_ref') : undefined;
    return typeof ref === 'string' && typeof size === 'number' && Number.isSafeInteger(size) && size >= 1;
  });
}

/** True when a decision holds the sub-job that bought it, which `sub_jobs` of the result lists. */
function isDecision(value: unknown): value is Decision {
  if (typeof value !== 'object' || value === null) return false;
  const inference: unknown = Reflect.get(value, 'inference');
  if (typeof inference !== 'object' || inference === null) return false;
  const subJob: unknown = Reflect.get(inference, 'sub_job');
  return typeof subJob === 'object' && subJob !== null;
}

/**
 * Updates the list of left sub-delegations after the run. An end that is `ended` or `not_made` removes the entry of the id that `beforeSend` stored. An end that is `not_ended` stores the entry with the
 * Undelegate that was tried. A failure changes no result: the entry that `beforeSend` stored stays, and the janitor reads the ledger and ends the sub-delegation or drops the entry.
 */
async function updateList(run: Run, id: DelegationId | null, keyHash: string, end: SubDelegationEnd): Promise<void> {
  const { clock, leftSink } = run.deps;
  let write: () => Promise<void>;
  if (end.state === 'not_ended') {
    const entry = { left: end.left, signer_key_hash: keyHash };
    write = () => leftSink.put(entry);
  } else if (id !== null) {
    write = () => leftSink.remove(id);
  } else {
    return;
  }
  try {
    await within(clock, BOOKKEEPING_TIMEOUT_MS, write);
  } catch {
    // The entry of `beforeSend` stays. See the head of this file.
  }
}

/** Writes one line to the log of the deps. A log that throws changes no result: the line is lost, and the job goes on. */
function note(run: Run, line: string): void {
  try {
    run.deps.log(line);
  } catch {
    // The line is lost.
  }
}

/**
 * The check inside the hook before the send: the list of left sub-delegations must hold no entry with the id of this sub-delegation. It throws when an entry has this id, and when it cannot tell: the read fails,
 * gives no list, or does not answer within `LIST_TIMEOUT_MS`. Each throw has one line in the log with its cause. The read has a bound of its own inside the bound of the hook of the access folder, so that no answer
 * comes after the run gave up: a late answer would add the id to the set of the runs in use and store the entry of a Delegate that was never sent, and nothing would take them away. One damaged file of the
 * list does not block the job: the entries that could be read are checked. A damaged file with the name of this sub-delegation does, because it may hold the entry of an earlier Delegate with this id.
 */
async function checkFree(run: Run, id: DelegationId): Promise<void> {
  const { clock, leftSink } = run.deps;
  let held: readonly LeftEntry[] | null;
  try {
    const listed = await within(clock, LIST_TIMEOUT_MS, () => leftSink.list());
    held = listed.timedOut ? null : listed.value;
  } catch (error) {
    if (!(error instanceof DamagedLeftEntriesError)) {
      note(run, 'propose: no Delegate was sent: the list of left sub-delegations cannot be read');
      throw error;
    }
    if (error.damaged.some((damaged) => damaged.file === `${id}.json`)) {
      note(run, `propose: no Delegate was sent for the sub-delegation ${id}: a damaged file of the list has the name of this sub-delegation`);
      throw error;
    }
    held = error.entries;
  }
  if (held === null) {
    note(run, `propose: no Delegate was sent: the list of left sub-delegations did not answer within ${LIST_TIMEOUT_MS} ms`);
    throw new Error('the list of left sub-delegations did not answer in time');
  }
  const entries: unknown = held;
  if (!Array.isArray(entries)) {
    note(run, 'propose: no Delegate was sent: the list of left sub-delegations cannot be read');
    throw new Error('the list of left sub-delegations is not a list');
  }
  if (entries.some((entry: LeftEntry) => entry.left.id === id)) {
    note(run, `propose: no Delegate was sent for the sub-delegation ${id}: the list of left sub-delegations holds an entry with this id, so an earlier Delegate of this key may be on its way, and the janitor ends or drops that entry`);
    throw new Error('the list of left sub-delegations holds an entry with the id of this sub-delegation');
  }
}

/** The caller hung up before a step of the job started. */
class HungUp extends Error {}

/**
 * The job of the subagent: a token for the stock route under the sub-delegation, the call of the ERP, and the check of the body. The gateway may need some time to see the 30 confirmations, so a token
 * request that gets `delegation_too_young` is asked again for the patience of the job. A call is made once. A job that ran past its time makes no further request: the sub-delegation is ended by then. A job
 * whose caller hung up makes no further request either, and it gives `aborted`.
 */
async function stockJob(run: Run, target: TokenTarget, handle: SubDelegationHandle): Promise<StockRead> {
  const { deps } = run;
  let token: RouteTokenResult;
  try {
    token = await askWhileTooYoung(
      deps.clock,
      () => {
        if (run.signal?.aborted === true) throw new HungUp();
        return requestSubagentToken(deps.tokens, {
          target,
          subagent: { did: deps.subagent.did, authenticationKey: deps.subagent.authenticationKey, delegationKey: deps.subagent.delegationKey },
          subDelegation: handle.id,
        });
      },
      { waitMs: TOKEN_PATIENCE_MS, pollMs: DEFAULT_POLL_MS },
    );
  } catch (error) {
    if (error instanceof HungUp) return { ok: false, code: 'aborted' };
    throw error;
  }
  if (token.ok !== true) return { ok: false, code: `token_${token.code}` };
  if (handle.signal.aborted) throw new Error('the time of the job ended');
  if (run.signal?.aborted === true) return { ok: false, code: 'aborted' };
  const answer = await callWithToken(deps.calls, token.value, target);
  if (answer.ok !== true) return { ok: false, code: answer.code === 'refused_by_system' ? answer.reason : (answer.systemCode ?? 'mock_system_failed') };
  const parsed = deps.parseStock(answer.body);
  return parsed.ok === true ? { ok: true, reading: parsed.value } : { ok: false, code: 'stock_reading_invalid' };
}

/**
 * Reads the stock of the SKU through a sub-delegation, and ends the sub-delegation. The sub-delegation is made by the delegation key of this agent (`key`) and the delegation key of the subagent, and the
 * records of the sub-delegation are kept as the head of this file says. The result is the stock, or the code of the failure: a code of the sub-delegation, the code of the token, the code of the mock
 * system for a refusal or a failure of the call, `stock_reading_invalid` for a body that is not a stock reading, `stock_read_timeout` for a job that ran out of time, and `internal` for a job that threw.
 */
async function readStock(run: Run, key: DelegationKey): Promise<StockRead> {
  const { deps, request } = run;
  const target = tokenTarget(deps.calls.bases, request.tenant, 'erp.stock', { sku: request.sku });
  if (target.ok !== true) return { ok: false, code: 'internal' };
  const left = Math.floor(run.deadline - deps.clock.now());
  if (!(left >= MIN_CONFIRMATION_WAIT_MS + JOB_TIMEOUT_MS + END_TIMEOUT_MS)) return { ok: false, code: 'deadline' };
  const confirmationWaitMs = Math.min(CONFIRMATION_WAIT_MS, left - JOB_TIMEOUT_MS - END_TIMEOUT_MS);
  const sent: { id: DelegationId | null } = { id: null };
  try {
    const result = await withSubDelegation(
      {
        ...deps.subDelegation,
        walletQueue: key.queue,
        beforeSend: async (reference) => {
          // The list must hold no entry with the id of this sub-delegation, and it must answer inside a bound of its own (see `checkFree`). The hook throws before this run takes the id: nothing is sent, this
          // run records nothing, and it removes nothing.
          await checkFree(run, reference.id);
          sent.id = reference.id;
          deps.inFlight.add(reference.id);
          await deps.leftSink.put({ left: reference, signer_key_hash: key.signer.keyHash });
        },
      },
      {
        target: target.value,
        parent: request.authority.delegation,
        agent: { signer: key.signer, walletAddress: key.walletAddress },
        subagent: { did: deps.subagent.did, signer: deps.subagent.signer },
        validForMs: confirmationWaitMs + JOB_TIMEOUT_MS + VALIDITY_SLACK_MS,
      },
      { jobTimeoutMs: JOB_TIMEOUT_MS, confirmationWaitMs, endTimeoutMs: END_TIMEOUT_MS },
      (handle) => stockJob(run, target.value, handle),
    );
    await updateList(run, sent.id, key.signer.keyHash, result.end);
    if (result.kind === 'returned') return result.value;
    if (result.kind === 'timed_out') return { ok: false, code: 'stock_read_timeout' };
    if (result.kind === 'threw') return { ok: false, code: 'internal' };
    return { ok: false, code: `sub_delegation_${result.failure.code}` };
  } finally {
    if (sent.id !== null) deps.inFlight.delete(sent.id);
  }
}

/**
 * Runs `propose` for a request that the service parsed. It returns the proposal, or a failed proposal with a code. It throws `ProposeRefusal` for a request that it refuses before it does anything. A
 * sub-delegation that it made is ended or recorded for the janitor before it returns or throws. `arrivedAt` is the time that the job arrived, by the clock of the deps, and the deadline of every wait is
 * `PROPOSE_DEADLINE_MS` after it. `signal` aborts when the caller hangs up: no read, request, call or hire starts after that, a sub-delegation that is made is ended, and a decision that was already paid for is kept.
 */
export async function runPropose(deps: ProposeDeps, request: ProposeRequest, arrivedAt: number, signal?: AbortSignal): Promise<ProposalResult> {
  try {
    poNumberOf(request.tenant, 0);
  } catch {
    throw new ProposeRefusal('bad_shape', TENANT_RULE);
  }
  const run: Run = { deps, request, deadline: arrivedAt + PROPOSE_DEADLINE_MS, signal };
  let decisions: readonly Decision[] = [];
  const failed = (code: unknown): ProposalResult => failedProposalResult(piecesOf(decisions), typeof code === 'string' && CODE_FORM.test(code) ? code : 'internal');
  /** The failed result for a job that must not start another step: the caller hung up, or the deadline came. A NaN clock or deadline counts as the deadline. */
  const stopped = (): ProposalResult | null => {
    if (signal?.aborted === true) return failed('aborted');
    return deps.clock.now() < run.deadline ? null : failed('deadline');
  };

  const first = stopped();
  if (first !== null) return first;

  // 1. The authority.
  const authority = await attempt(run, () => checkAuthority(deps.reads, deps.agent.did, request.authority.delegation));
  if (authority.state !== 'value') return failed(authority.state === 'timed_out' ? 'deadline' : 'internal');
  const checked = authority.value;
  if (checked.ok !== true) {
    if (checked.code === 'ledger_unavailable') return failed('ledger_unavailable');
    throw new ProposeRefusal(checked.code, checked.detail);
  }

  // 2. The paying key.
  const keyHash = await attempt(run, () => deps.delegateKeyOf(request.authority.delegation));
  if (keyHash.state !== 'value') return failed(keyHash.state === 'timed_out' ? 'deadline' : 'ledger_unavailable');
  if (keyHash.value === null) return failed('delegation_not_found');
  let key: DelegationKey | null;
  try {
    key = typeof keyHash.value === 'string' ? deps.delegationKeys.find(keyHash.value) : null;
  } catch {
    return failed('internal');
  }
  if (key === null || key === undefined) return failed('delegation_key_unknown');

  // 3. The supplier.
  const beforeSupplier = stopped();
  if (beforeSupplier !== null) return beforeSupplier;
  const supplierRead = await attempt(run, () => deps.readSupplier(request.supplier_did, request.sku));
  if (supplierRead.state !== 'value') return failed(supplierRead.state === 'timed_out' ? 'deadline' : 'internal');
  const read = supplierRead.value;
  if (typeof read !== 'object' || read === null) return failed('internal');
  if (read.ok !== true) return failed(read.code);
  const supplier = read.value;
  if (!isSupplierRead(supplier)) return failed('internal');

  // 4. The stock.
  const beforeStock = stopped();
  if (beforeStock !== null) return beforeStock;
  const stock = await readStock(run, key);
  if (stock.ok !== true) return failed(stock.code);
  const reading = stock.reading;
  if (!Object.hasOwn(reading, 'sku') || reading.sku !== request.sku) return failed('stock_reading_mismatch');
  const stockSha256 = canonicalSha256(reading, 'stock reading');
  if (stockSha256.ok !== true) return failed('bad_document');

  // 5. The model decision.
  const beforeModel = stopped();
  if (beforeModel !== null) return beforeModel;
  const decided = await attempt(run, () => deps.reorder(reading, supplier.lots));
  if (decided.state !== 'value') return failed(decided.state === 'timed_out' ? 'deadline' : 'internal');
  const answer = decided.value;
  if (typeof answer !== 'object' || answer === null) return failed('internal');
  if (answer.ok !== true) return failed(answer.code);
  if (!isDecision(answer.decision)) return failed('internal');
  decisions = [answer.decision];
  // The order is built from the choice only when it is the choice that the decision records: no code changes what the model chose.
  const given = canonicalJson(answer.choice, 'choice');
  const recorded = canonicalJson(answer.decision.choice, 'decision.choice');
  if (given.ok !== true || recorded.ok !== true) return failed('bad_document');
  if (given.value !== recorded.value) return failed('decision_mismatch');
  // From here on the job uses the copy that it checked, and never an object of the port: the port could change its objects while the job waits for the number.
  const chosen: JsonValue = JSON.parse(given.value);
  if (!isPlainObject(chosen) || !isLotName(chosen.lot)) return failed('bad_document');
  decisions = [{ ...answer.decision, choice: chosen }];

  // 6. The purchase order.
  const counted = await attempt(run, () => deps.counter.next(request.tenant));
  if (counted.state !== 'value') return failed(counted.state === 'timed_out' ? 'deadline' : 'store_write_failed');
  let poNumber: string;
  try {
    poNumber = poNumberOf(request.tenant, counted.value);
  } catch {
    return failed('internal');
  }
  const order = parsePurchaseOrder({
    schema: PO_SCHEMA,
    po_number: poNumber,
    tenant: request.tenant,
    sku: request.sku,
    lot: chosen.lot,
    quantity: chosen.quantity,
    needed_by: chosen.needed_by,
    supplier_did: request.supplier_did,
    advert_ref: supplier.adverts[chosen.lot].advert_ref,
    stock_reading_sha256: stockSha256.value,
  });
  if (order.ok !== true) return failed('bad_document');
  return proposedResult(order.value, piecesOf(decisions));
}
