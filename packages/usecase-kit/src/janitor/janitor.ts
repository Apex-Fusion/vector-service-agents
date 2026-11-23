// packages/usecase-kit/src/janitor/janitor.ts
// The janitor of left sub-delegations. `withSubDelegation` ends a sub-delegation in a `finally` path. When the end fails, its result is `not_ended` with a `LeftSubDelegation`, and the service puts that reference in the
// list of the janitor (store.ts). A pass of the janitor reads each entry of the list and ends the sub-delegation with the Undelegate, so that the delegation key of the subagent is free again. An expiry does not free
// a key: only the Undelegate does.
//
// The rules of one pass, for each entry of the list, in this order. The janitor ends only an entry of its own list: an id that the list does not hold is never read and never ended, whatever the ledger shows.
//   1. A sub-delegation that a run of this process still uses (`inFlight`) is left alone. The janitor does not end the delegation of a job that is running.
//   2. The ledger is read. A read that throws, gives no answer, or gives a value that is not a delegation with the id of the entry keeps the entry. A throw is never read as "not shown".
//   3. The ledger shows nothing. The Delegate carries a TTL in its signed bytes, and it can land until the slot of the chain tip is at or past `delegateTtlSlot`. So the entry stays while the tip is before that slot.
//      At or past it, the ledger is read once more, because the first read may be older than the tip: only a second answer of "not shown" removes the entry, since then the Delegate never landed and cannot land any
//      more. A tip that cannot be read keeps the entry. The clock decides nothing here: it is never compared with the end of validity that the build port reported.
//   4. The ledger shows the delegation, and another transaction made it. The id comes from the seed output, and only one transaction can spend that output, so the Delegate of this run can never land. The entry is
//      removed and the removal is logged. A hash that has not the form of a hash is not another transaction: the entry stays.
//   5. The ledger shows the delegation, and the Delegate of this run made it. The janitor takes the signer of the key of the entry, and the queue of that key. An entry with no signer stays, with a line in the log.
//      A busy queue is not used: the entry is skipped. In the queue the janitor builds the Undelegate, checks its BYTES with the rules of the end step of `withSubDelegation` (`undelegateTxProblem`), signs, sends,
//      and reads the ledger until it no longer shows the delegation or the time of the entry ends. The turn in the queue is kept meanwhile. An entry whose delegation is gone is removed. An entry whose Undelegate was
//      sent and whose delegation is still shown keeps the hash of that Undelegate.
// A pass makes one transaction at most for one entry. A pass never throws: each entry has its own try, and the report says what happened to it. Every wait on a port has a bound, and a port that gives no answer is a
// typed result. A key and a part of a request never reach a detail or a log line.
import { addressHexOf, delegationScriptProblem, takeTurn, undelegateTxProblem, within } from '../access/index.ts';
import type { Clock, DelegationChain, DelegationScript, SerialQueue, TxSigner } from '../access/index.ts';
import { accepted, refused, type Accepted, type DelegationId, type Refused } from '../protocol/index.ts';
import { DamagedLeftEntriesError, parseLeftEntry, type DamagedLeftEntry, type LeftEntry, type LeftStore } from './store.ts';

/** The longest time for one entry, in milliseconds: every call of a port and the wait for the ledger after the send share it. The default is 60 seconds. */
export const DEFAULT_ENTRY_TIMEOUT_MS = 60_000;
/** The time between two reads of the ledger after the Undelegate was sent, in milliseconds. The default is 5 seconds. */
export const DEFAULT_END_POLL_MS = 5_000;
/** The longest time that `stop` waits for the pass in flight, in milliseconds. The default is 30 seconds. */
export const DEFAULT_STOP_WAIT_MS = 30_000;
/** The longest bound that any parameter takes: one day. A timer cannot hold much more, and a longer number would end at once. */
const MAX_WAIT_MS = 86_400_000;

export const JANITOR_STATES = [
  'ended', 'dropped_not_made', 'dropped_other', 'kept_waiting', 'kept_busy', 'kept_unreadable', 'kept_no_signer', 'kept_end_pending', 'kept_end_failed', 'kept_store_failed',
] as const;
/**
 * What a pass did with one entry.
 * - `ended`: the Undelegate landed. The ledger no longer shows the delegation, and the entry is removed.
 * - `dropped_not_made`: the ledger does not show the delegation, and the tip is at or past the TTL slot of its Delegate, so the Delegate never lands. The entry is removed.
 * - `dropped_other`: the ledger shows a delegation with this id that another transaction made, so the Delegate of this run never lands. The entry is removed.
 * - `kept_waiting`: the ledger does not show the delegation, and the tip is before the TTL slot, so the Delegate can still land.
 * - `kept_busy`: the queue of the key is busy, or a run of this process still uses the sub-delegation. Nothing was sent.
 * - `kept_unreadable`: the ledger or the tip could not be read, or gave a value that is not usable. Nothing was sent.
 * - `kept_no_signer`: no usable signer is given for the key of the entry. Nothing was sent.
 * - `kept_end_pending`: the Undelegate was sent, and the ledger still shows the delegation when the time of the entry ended. The entry keeps the hash of the Undelegate.
 * - `kept_end_failed`: the Undelegate was not sent, or the node refused it. The detail says why.
 * - `kept_store_failed`: the entry should be removed, and the store could not remove it.
 */
export type JanitorState = (typeof JANITOR_STATES)[number];

export interface JanitorEntryReport {
  readonly id: DelegationId;
  readonly state: JanitorState;
  /** One sentence for a log. It names no key and no part of a request. */
  readonly detail: string;
  /** The hash of the Undelegate that the pass sent or tried to send, or null when it sent none. */
  readonly endTxHash: string | null;
}

export interface JanitorReport {
  /** One item for each entry that the pass read, in the order of the store. */
  readonly entries: readonly JanitorEntryReport[];
  /** The files of the store that are not entries in the form. Each is logged and kept. */
  readonly damaged: readonly DamagedLeftEntry[];
  /** Why the pass could not run: the store could not be listed, or the deps are not valid. Null when the pass ran. */
  readonly failure: string | null;
}

export interface JanitorDeps {
  readonly store: LeftStore;
  readonly chain: DelegationChain;
  /** The delegation script of the identity deployment: the same value as `delegationScript` of `SubDelegationDeps`. The janitor signs only a transaction that burns the token of this script. */
  readonly delegationScript: DelegationScript;
  /** The signer of a delegation key, and the address of its wallet, or null when the service has no such key. The key hash is the `signer_key_hash` of an entry. */
  readonly signerOf: (keyHash: string) => (TxSigner & { readonly address: string }) | null;
  /** The queue of a key: the same object that holds the other transactions of that key. The janitor never uses a queue that is busy. `HireLane` of the hire kit has `busy`, and the `lane` of a `PayingKey` is one. */
  readonly queueOf: (keyHash: string) => SerialQueue & { readonly busy: boolean };
  /** The slot of the tip of the chain, from the node. It rejects when the node gives no slot. */
  readonly tipSlot: () => Promise<number>;
  readonly clock: Clock;
  readonly log: (line: string) => void;
  /**
   * True while a run of this process still uses the sub-delegation `id`. The reference of a run is in the list from before its Delegate is sent until its end step has returned, so a pass that runs at that time would end the
   * delegation of a job that is running. A service that makes sub-delegations in the process of the janitor must give this function. It marks the id when `beforeSend` is called and clears it after the run has returned.
   * An answer that is not true or false counts as true, and so does a throw.
   */
  readonly inFlight?: (id: DelegationId) => boolean;
  /** The longest time for one entry. A whole number of milliseconds from 1 to one day. The default is DEFAULT_ENTRY_TIMEOUT_MS. */
  readonly entryTimeoutMs?: number;
  /** The time between two reads of the ledger after the Undelegate was sent. The default is DEFAULT_END_POLL_MS. */
  readonly pollMs?: number;
  /** The longest time that `stop` of `startJanitor` waits for the pass in flight. The default is DEFAULT_STOP_WAIT_MS. */
  readonly stopWaitMs?: number;
}

interface Limits {
  readonly entryTimeoutMs: number;
  readonly pollMs: number;
  readonly stopWaitMs: number;
}

interface Context {
  readonly deps: JanitorDeps;
  readonly limits: Limits;
  readonly clock: Clock;
}

const TX_HASH = /^[0-9a-f]{64}$/;
const isWhole = (value: unknown, min: number, max = Number.MAX_SAFE_INTEGER): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
const isFunction = (value: unknown): boolean => typeof value === 'function';

/** The most characters that a detail shows. */
const MAX_DETAIL_CHARS = 200;
const safeText = (text: string): string => text.replace(/[^\x20-\x7e]/g, '?').slice(0, MAX_DETAIL_CHARS);
/** What a thrown value says: the name and the message of an error, printable and cut. A value that is not an error says nothing about itself. */
const errorText = (error: unknown): string => (error instanceof Error ? safeText(`${error.name}: ${error.message}`) : 'a value that is not an error was thrown');

/** The limits, or the first thing that is wrong in the deps. A caller in JavaScript can give any value, so each member is checked. */
function limitsOf(deps: JanitorDeps): Accepted<Limits> | Refused<'bad_deps'> {
  const bad = (detail: string): Refused<'bad_deps'> => refused('bad_deps', detail);
  if (typeof deps !== 'object' || deps === null) return bad('the deps of the janitor must be an object');
  if (typeof deps.store !== 'object' || deps.store === null || !isFunction(deps.store.list) || !isFunction(deps.store.put) || !isFunction(deps.store.remove)) {
    return bad('store must be the list of left sub-delegations: an object with list, put and remove');
  }
  if (typeof deps.chain !== 'object' || deps.chain === null || !isFunction(deps.chain.readDelegation) || !isFunction(deps.chain.buildUndelegate) || !isFunction(deps.chain.submit)) {
    return bad('chain must be the delegation chain: an object with readDelegation, buildUndelegate and submit');
  }
  const scriptProblem = delegationScriptProblem(deps.delegationScript);
  if (scriptProblem !== null) return bad(scriptProblem);
  if (!isFunction(deps.signerOf) || !isFunction(deps.queueOf) || !isFunction(deps.tipSlot) || !isFunction(deps.log)) return bad('signerOf, queueOf, tipSlot and log must be functions');
  if (typeof deps.clock !== 'object' || deps.clock === null || !isFunction(deps.clock.now) || !isFunction(deps.clock.sleep)) return bad('clock must be the clock port: an object with now and sleep');
  if (deps.inFlight !== undefined && !isFunction(deps.inFlight)) return bad('inFlight must be a function when it is given');
  const entryTimeoutMs = deps.entryTimeoutMs === undefined ? DEFAULT_ENTRY_TIMEOUT_MS : deps.entryTimeoutMs;
  const pollMs = deps.pollMs === undefined ? DEFAULT_END_POLL_MS : deps.pollMs;
  const stopWaitMs = deps.stopWaitMs === undefined ? DEFAULT_STOP_WAIT_MS : deps.stopWaitMs;
  if (![entryTimeoutMs, pollMs, stopWaitMs].every((ms) => isWhole(ms, 1, MAX_WAIT_MS))) return bad(`entryTimeoutMs, pollMs and stopWaitMs must be whole numbers from 1 to ${MAX_WAIT_MS}`);
  return accepted({ entryTimeoutMs, pollMs, stopWaitMs });
}

/** A log that never throws: the log is the last place to say that something went wrong. */
function loggerOf(deps: JanitorDeps): (line: string) => void {
  return (line) => {
    try {
      deps.log(line);
    } catch {
      // A log that throws is not logged.
    }
  };
}

/** The answer of one call of a port: its value, the error that it threw, or `timed_out` when no answer came within `ms` of the clock. A call that never answers does not hold the pass. */
type Answer<T> = { readonly state: 'value'; readonly value: T } | { readonly state: 'threw'; readonly error: unknown } | { readonly state: 'timed_out' };

async function answerOf<T>(clock: Clock, ms: number, call: () => Promise<T>): Promise<Answer<T>> {
  try {
    const bounded = await within(clock, ms, call);
    return bounded.timedOut ? { state: 'timed_out' } : { state: 'value', value: bounded.value };
  } catch (error) {
    return { state: 'threw', error };
  }
}

const result = (id: DelegationId, state: JanitorState, detail: string, endTxHash: string | null = null): JanitorEntryReport => ({ id, state, detail, endTxHash });
/** The time left until `deadline`, at least 1 millisecond, as the bound of the next call. */
const timeLeft = (ctx: Context, deadline: number): number => Math.max(1, deadline - ctx.clock.now());

/** What the ledger shows of one delegation: it is live and the transaction `txHash` made it, it is not shown, or it cannot be read. */
type Seen = { readonly state: 'live'; readonly txHash: string } | { readonly state: 'absent' } | { readonly state: 'unreadable'; readonly detail: string };

/**
 * What the ledger shows of the delegation `id`. An answer for another id, and a delegation whose transaction hash is not 64 lower-case hex characters, are `unreadable`: the janitor cannot tell which transaction made
 * it, and a hash that only differs in form (for example in capital letters) is not another transaction. Only `null` is "not shown": a throw, no answer and any other value are never read as that.
 */
async function seeOn(ctx: Context, id: DelegationId, deadline: number): Promise<Seen> {
  const ms = timeLeft(ctx, deadline);
  const read = await answerOf(ctx.clock, ms, () => ctx.deps.chain.readDelegation(id));
  if (read.state === 'timed_out') return { state: 'unreadable', detail: `the ledger did not answer within ${ms} ms` };
  if (read.state === 'threw') return { state: 'unreadable', detail: `the ledger could not be read: ${errorText(read.error)}` };
  if (read.value === null) return { state: 'absent' };
  const given: unknown = read.value; // a port in JavaScript can give any value, so the answer is checked as an unknown value
  if (typeof given !== 'object' || given === null) return { state: 'unreadable', detail: 'the ledger gave a value that is not a delegation' };
  const answeredId: unknown = 'id' in given ? given.id : undefined;
  const txHash: unknown = 'txHash' in given ? given.txHash : undefined;
  if (answeredId !== id) return { state: 'unreadable', detail: 'the ledger answered for another delegation than the one that was asked for' };
  return typeof txHash === 'string' && TX_HASH.test(txHash)
    ? { state: 'live', txHash }
    : { state: 'unreadable', detail: 'the ledger shows the delegation, and the hash of its transaction is not 64 lower-case hex characters' };
}

/** The slot of the tip, or why it cannot be read. A value that is not a whole number from 0 is not a slot. */
async function tipOf(ctx: Context, deadline: number): Promise<Accepted<number> | Refused<'tip_unreadable'>> {
  const ms = timeLeft(ctx, deadline);
  const tip = await answerOf(ctx.clock, ms, () => ctx.deps.tipSlot());
  if (tip.state === 'timed_out') return refused('tip_unreadable', `the node did not give the slot of its tip within ${ms} ms`);
  if (tip.state === 'threw') return refused('tip_unreadable', `the slot of the tip could not be read: ${errorText(tip.error)}`);
  return isWhole(tip.value, 0) ? accepted(tip.value) : refused('tip_unreadable', 'the slot of the tip is not a whole number from 0');
}

interface Usable {
  readonly signer: TxSigner & { readonly address: string };
  /** The bytes of the address of the wallet, in hex: every output of the Undelegate goes there. */
  readonly walletHex: string;
}

/** The signer for the key of an entry, or why there is none. The signer must be for this key, it must sign, and it must have the address of a wallet. */
function signerFor(ctx: Context, keyHash: string): Accepted<Usable> | Refused<'no_signer'> {
  const no = (detail: string): Refused<'no_signer'> => refused('no_signer', detail);
  let given: unknown;
  try {
    given = ctx.deps.signerOf(keyHash);
  } catch (error) {
    return no(`the signer of the key ${keyHash} could not be had: ${errorText(error)}`);
  }
  if (given === null || given === undefined) return no(`no signer is given for the key ${keyHash}`);
  if (typeof given !== 'object') return no(`the signer that was given for the key ${keyHash} is not an object`);
  const givenHash: unknown = 'keyHash' in given ? given.keyHash : undefined;
  const sign: unknown = 'sign' in given ? given.sign : undefined;
  const address: unknown = 'address' in given ? given.address : undefined;
  if (givenHash !== keyHash) return no(`the signer that was given for the key ${keyHash} is for another key`);
  if (typeof sign !== 'function') return no(`the signer of the key ${keyHash} has no sign function`);
  const walletHex = typeof address === 'string' ? addressHexOf(address) : null;
  if (walletHex === null) return no(`the signer of the key ${keyHash} has no address of a wallet`);
  const signer = given as TxSigner & { readonly address: string }; // its three members were checked above
  return accepted({ signer, walletHex });
}

type Lane = SerialQueue & { readonly busy: boolean };

/** The queue of the key of an entry, or why it cannot be used. `busy` is read where the queue is used. */
function queueFor(ctx: Context, keyHash: string): Accepted<Lane> | Refused<'bad_queue'> {
  let given: unknown;
  try {
    given = ctx.deps.queueOf(keyHash);
  } catch (error) {
    return refused('bad_queue', `the queue of the key ${keyHash} could not be had: ${errorText(error)}`);
  }
  if (typeof given !== 'object' || given === null || !('run' in given) || typeof given.run !== 'function') return refused('bad_queue', `the queue of the key ${keyHash} has no run function`);
  const lane = given as Lane; // it has a run function, and `busy` is read as an unknown value where the queue is used
  return accepted(lane);
}

/** Why the janitor leaves the entry alone because a run of this process uses it, or null. An answer that is not true or false counts as true. */
function usedByRun(ctx: Context, id: DelegationId): string | null {
  if (ctx.deps.inFlight === undefined) return null;
  try {
    const uses: unknown = ctx.deps.inFlight(id);
    if (uses === false) return null;
    return uses === true ? 'a run of this process still uses the sub-delegation' : 'inFlight did not answer true or false, so the sub-delegation is taken as in use';
  } catch (error) {
    return `inFlight failed (${errorText(error)}), so the sub-delegation is taken as in use`;
  }
}

/** Why the store did not do what it was asked, from an answer that is not a value. */
const storeFailure = (what: string, answer: Answer<void>, ms: number): string =>
  answer.state === 'threw' ? `the store could not ${what}: ${errorText(answer.error)}` : `the store did not ${what} within ${ms} ms`;

/** Removes the entry for a reason that is not an end by the janitor. When the store cannot remove it, the entry stays and the state says so. */
async function drop(ctx: Context, id: DelegationId, state: 'dropped_not_made' | 'dropped_other', detail: string): Promise<JanitorEntryReport> {
  const removed = await answerOf(ctx.clock, ctx.limits.entryTimeoutMs, () => ctx.deps.store.remove(id));
  return removed.state === 'value' ? result(id, state, detail) : result(id, 'kept_store_failed', `${storeFailure('remove the entry', removed, ctx.limits.entryTimeoutMs)}; the entry stays (${detail})`);
}

/** The Undelegate landed: removes the entry. When the store cannot remove it, the entry stays and the state says so. */
async function ended(ctx: Context, entry: LeftEntry, endTxHash: string): Promise<JanitorEntryReport> {
  const id = entry.left.id;
  const removed = await answerOf(ctx.clock, ctx.limits.entryTimeoutMs, () => ctx.deps.store.remove(id));
  return removed.state === 'value'
    ? result(id, 'ended', 'the ledger no longer shows the sub-delegation after the Undelegate was sent', endTxHash)
    : result(id, 'kept_store_failed', `the Undelegate landed, and ${storeFailure('remove the entry', removed, ctx.limits.entryTimeoutMs)}`, endTxHash);
}

/** Keeps the entry after an Undelegate was tried, with the hash of that Undelegate in the store. A store that cannot write the hash does not change the state of the end; the detail says so. */
async function keepAfterSend(ctx: Context, entry: LeftEntry, state: 'kept_end_failed' | 'kept_end_pending', detail: string, endTxHash: string): Promise<JanitorEntryReport> {
  const { left } = entry;
  if (left.endTxHash === endTxHash) return result(left.id, state, detail, endTxHash);
  const saved = await answerOf(ctx.clock, ctx.limits.entryTimeoutMs, () => ctx.deps.store.put({ left: { ...left, endTxHash }, signer_key_hash: entry.signer_key_hash }));
  const note = saved.state === 'value' ? '' : ` ${storeFailure('write the hash of the Undelegate', saved, ctx.limits.entryTimeoutMs)}.`;
  return result(left.id, state, `${detail}${note}`, endTxHash);
}

/** Reads the ledger until it no longer shows the delegation or the time of the entry ends. Only "not shown" counts as the end: a read that fails, or shows the delegation, is read again. */
async function watchEnd(ctx: Context, entry: LeftEntry, deadline: number, endTxHash: string): Promise<JanitorEntryReport> {
  for (;;) {
    const seen = await seeOn(ctx, entry.left.id, deadline);
    if (seen.state === 'absent') return ended(ctx, entry, endTxHash);
    const why = seen.state === 'unreadable' ? `after the Undelegate was sent, ${seen.detail}` : 'the ledger still shows the sub-delegation after the Undelegate was sent';
    if (deadline - ctx.clock.now() <= ctx.limits.pollMs) return keepAfterSend(ctx, entry, 'kept_end_pending', why, endTxHash);
    await ctx.clock.sleep(ctx.limits.pollMs);
  }
}

/**
 * Builds the Undelegate of the entry, checks its bytes, signs it, sends it, and watches the ledger. The turn in the queue is held by the caller. At most one transaction is made. The bytes are checked with the
 * rules of the end step, for the id of the entry, the wallet of the signer and the signer alone: a transaction that burns another token, pays another address, or names another signer gets no signature.
 */
async function undelegate(ctx: Context, entry: LeftEntry, usable: Usable, deadline: number): Promise<JanitorEntryReport> {
  const { left } = entry;
  const { signer, walletHex } = usable;
  const failed = (detail: string): JanitorEntryReport => result(left.id, 'kept_end_failed', detail);
  const ms = timeLeft(ctx, deadline);
  const build = await answerOf(ctx.clock, ms, () => ctx.deps.chain.buildUndelegate({ changeAddress: signer.address, nowMs: ctx.clock.now(), id: left.id, signer: signer.keyHash }));
  if (build.state === 'timed_out') return failed(`the build of the Undelegate did not answer within ${ms} ms`);
  if (build.state === 'threw') return failed(`the Undelegate could not be built: ${errorText(build.error)}`);
  const built = build.value;
  if (built.id !== left.id) return failed('the Undelegate is for another delegation');
  const problem = undelegateTxProblem(built.txCbor, { txHash: built.txHash, id: left.id, script: ctx.deps.delegationScript, walletHex, signers: [signer.keyHash] });
  if (problem !== null) return failed(problem);
  let signed: unknown;
  try {
    signed = signer.sign(built.txCbor);
  } catch (error) {
    return failed(`a key could not sign: ${error instanceof Error ? safeText(error.name) : 'a value that is not an error was thrown'}`);
  }
  if (typeof signed !== 'string' || signed.length === 0) return failed('the key gave a signed transaction that is not text');
  const signedText: string = signed;
  if (deadline - ctx.clock.now() <= 0) return failed('the time of the entry ended before the Undelegate was sent');
  const sent = await answerOf(ctx.clock, timeLeft(ctx, deadline), () => ctx.deps.chain.submit(signedText));
  if (sent.state === 'threw') return keepAfterSend(ctx, entry, 'kept_end_failed', `the Undelegate was not accepted by the node: ${errorText(sent.error)}`, built.txHash);
  // A send that gave no answer may have reached the node: the ledger tells, as it does after a send that was accepted.
  return watchEnd(ctx, entry, deadline, built.txHash);
}

/** The live delegation of the run: takes the signer and the queue of the key, and ends it in the queue. */
async function end(ctx: Context, entry: LeftEntry, deadline: number): Promise<JanitorEntryReport> {
  const { left, signer_key_hash: keyHash } = entry;
  const usable = signerFor(ctx, keyHash);
  if (!usable.ok) return result(left.id, 'kept_no_signer', usable.detail);
  const lane = queueFor(ctx, keyHash);
  if (!lane.ok) return result(left.id, 'kept_end_failed', lane.detail);
  const busy: unknown = lane.value.busy;
  if (busy !== false) return result(left.id, 'kept_busy', busy === true ? 'the queue of the key is busy: a transaction of this key waits or runs' : 'the queue of the key does not say whether it is busy, so it is taken as busy');
  const turn = await takeTurn(lane.value, ctx.clock, timeLeft(ctx, deadline));
  if (turn.state === 'timed_out') return result(left.id, 'kept_busy', 'the turn in the queue of the key did not come before the time of the entry ended');
  if (turn.state === 'failed') return result(left.id, 'kept_end_failed', `the queue of the key failed: ${errorText(turn.error)}`);
  try {
    return await undelegate(ctx, entry, usable.value, deadline);
  } finally {
    turn.release();
  }
}

/** One entry: the rules of the head of this file, in order. */
async function tend(ctx: Context, entry: LeftEntry): Promise<JanitorEntryReport> {
  const { left } = entry;
  const deadline = ctx.clock.now() + ctx.limits.entryTimeoutMs;
  const using = usedByRun(ctx, left.id);
  if (using !== null) return result(left.id, 'kept_busy', using);
  let seen = await seeOn(ctx, left.id, deadline);
  if (seen.state === 'unreadable') return result(left.id, 'kept_unreadable', seen.detail);
  if (seen.state === 'absent') {
    const tip = await tipOf(ctx, deadline);
    if (!tip.ok) return result(left.id, 'kept_unreadable', tip.detail);
    if (tip.value < left.delegateTtlSlot) {
      return result(left.id, 'kept_waiting', `the Delegate is not on the ledger, and the tip (slot ${tip.value}) is before its TTL (slot ${left.delegateTtlSlot}), so it can still land`);
    }
    // The first read may be older than the tip: the Delegate can land in a block before the TTL while the tip moves past it. Only an answer that is read after the tip is at or past the TTL proves that it never landed.
    seen = await seeOn(ctx, left.id, deadline);
    if (seen.state === 'unreadable') return result(left.id, 'kept_unreadable', seen.detail);
    if (seen.state === 'absent') {
      return drop(ctx, left.id, 'dropped_not_made', `the Delegate is not on the ledger, and the tip (slot ${tip.value}) is at or past its TTL (slot ${left.delegateTtlSlot}), so it never lands`);
    }
  }
  if (seen.txHash !== left.delegateTxHash) {
    return drop(ctx, left.id, 'dropped_other', `the ledger shows a delegation with this id that the transaction ${seen.txHash} made, and not the Delegate of this run, so that Delegate never lands`);
  }
  return end(ctx, entry, deadline);
}

/** One entry that never throws: an error of the janitor itself is a result of the entry. */
async function tendSafely(ctx: Context, entry: LeftEntry): Promise<JanitorEntryReport> {
  try {
    return await tend(ctx, entry);
  } catch (error) {
    return result(entry.left.id, 'kept_end_failed', `the entry could not be handled: ${errorText(error)}`);
  }
}

/** One pass. It never throws. `stopped` is read before each entry: no entry starts after a stop. */
async function pass(deps: JanitorDeps, limits: Limits, stopped: () => boolean): Promise<JanitorReport> {
  const log = loggerOf(deps);
  const failed = (detail: string): JanitorReport => {
    log(`janitor: the pass could not run: ${detail}`);
    return { entries: [], damaged: [], failure: detail };
  };
  try {
    const ctx: Context = { deps, limits, clock: deps.clock };
    const listed = await answerOf(ctx.clock, limits.entryTimeoutMs, () => deps.store.list());
    const damaged: DamagedLeftEntry[] = [];
    let items: readonly unknown[];
    if (listed.state === 'value') {
      if (!Array.isArray(listed.value)) return failed('the store gave something that is not a list');
      items = listed.value;
    } else if (listed.state === 'threw' && listed.error instanceof DamagedLeftEntriesError) {
      items = listed.error.entries;
      damaged.push(...listed.error.damaged);
      for (const file of listed.error.damaged) log(`janitor: damaged ${file.file}: ${file.detail}; it is kept`);
    } else {
      return failed(listed.state === 'timed_out' ? `the store could not be listed within ${limits.entryTimeoutMs} ms` : `the store could not be listed: ${errorText(listed.error)}`);
    }
    const entries: JanitorEntryReport[] = [];
    const handled = new Set<string>();
    for (const [index, item] of items.entries()) {
      if (stopped()) break;
      const parsed = parseLeftEntry(item);
      if (!parsed.ok) {
        damaged.push({ file: `entry ${index}`, detail: parsed.detail });
        log(`janitor: damaged entry ${index}: ${parsed.detail}; it is kept`);
        continue;
      }
      const { id } = parsed.value.left;
      if (handled.has(id)) {
        log(`janitor: the store lists ${id} twice; the second copy is skipped`);
        continue;
      }
      handled.add(id);
      const report = await tendSafely(ctx, parsed.value);
      entries.push(report);
      if (report.state !== 'kept_waiting' && report.state !== 'kept_busy') log(`janitor: ${report.state} ${report.id}: ${report.detail}`);
    }
    return { entries, damaged, failure: null };
  } catch (error) {
    return failed(`the pass failed: ${errorText(error)}`);
  }
}

/**
 * One pass over the list of the store. It reads each entry, in the order of the store, and does what the rules in the head of this file say. It never throws: the report says what happened to each entry, and
 * `failure` says why no entry was looked at. A damaged file of the store is logged and kept, and the pass goes on with the entries that it could read.
 */
export async function runJanitorOnce(deps: JanitorDeps): Promise<JanitorReport> {
  const limits = limitsOf(deps);
  if (!limits.ok) {
    loggerOf(deps)(`janitor: the pass could not run: ${limits.detail}`);
    return { entries: [], damaged: [], failure: limits.detail };
  }
  return pass(deps, limits.value, () => false);
}

/**
 * Runs a pass at once, and then one `intervalMs` after each pass has ended, until `stop` is called. Two passes never run at one time. It throws a RangeError for an interval that is not a whole number of
 * milliseconds from 1 to one day, and a TypeError for deps that are not valid: a service that is set up wrong does not start. `stop` ends the wait between two passes at once, lets no entry start after it, and
 * waits for the pass in flight, for at most `stopWaitMs` of the clock. A pass that does not end by then is abandoned with a line in the log: its entries are still in the store for the janitor of the next start.
 */
export function startJanitor(deps: JanitorDeps, intervalMs: number): { stop(): Promise<void> } {
  if (!isWhole(intervalMs, 1, MAX_WAIT_MS)) throw new RangeError(`the interval of the janitor must be a whole number of milliseconds from 1 to ${MAX_WAIT_MS}`);
  const limits = limitsOf(deps);
  if (!limits.ok) throw new TypeError(limits.detail);
  const { clock } = deps;
  const abort = new AbortController();
  const stopped = (): boolean => abort.signal.aborted;
  const loop = (async (): Promise<void> => {
    try {
      while (!stopped()) {
        await pass(deps, limits.value, stopped);
        if (stopped()) return;
        await clock.sleep(intervalMs, abort.signal);
      }
    } catch (error) {
      loggerOf(deps)(`janitor: the loop ended: ${errorText(error)}`);
    }
  })();
  let stopping: Promise<void> | null = null;
  return {
    stop: () => {
      stopping ??= (async () => {
        abort.abort();
        const bounded = await within(clock, limits.value.stopWaitMs, () => loop);
        if (bounded.timedOut) loggerOf(deps)(`janitor: stop: the pass in flight did not end within ${limits.value.stopWaitMs} ms and is abandoned; its entries stay in the store for the next start`);
      })();
      return stopping;
    },
  };
}
