// agents/document-pipeline/src/janitor.ts
// The escrows a run posted and did not see accepted, and the janitor that settles them. A run writes every sub-escrow to the stranded store the
// moment its Post is confirmed, and removes it only once its Accept is confirmed; a Post that failed after its signature and may still land is written
// too, with the end of its validity (ruling R16), and an Accept that was sent but not seen confirmed leaves its escrow here marked accept_pending
// (ruling R33). So whatever ends a run (a refusal, the deadline, a crash), the escrows it leaves behind are in the store, a JSON file in the state
// directory (PIPELINE_STATE_DIR in the service) that is rewritten whole at every change.
//
// The janitor looks at each entry from 5 s after its deliver_by on, the first moment a Reclaim is sure to be open, and at an entry marked
// accept_pending at once:
//   Open or Claimed   reclaimed (everything locked comes back), and removed once the Reclaim is confirmed; a Reclaim that fails is tried again on the
//                     next pass. An escrow whose Accept was sent reads Open or Claimed only while an indexer lags its Submit, and is kept, until its
//                     Accept can no longer land and deliver_by + 5 s has passed: from then on it is reclaimed like any other.
//   Submitted         kept: the supplier submitted a receipt the run did not accept (it failed a check, or the run ran out of time), so it cannot be
//                     reclaimed, and the supplier may release it once the accept window after its Submit has passed. The entry notes from when that
//                     is sure (lost_to_release_after, deliver_by + 600 s, as the Submit came before deliver_by), and stays until it is spent.
//                     Marked accept_pending: kept while that Accept may still land; once it cannot, one more Accept is made while the accept window
//                     is open (the Chain gives no submitted_at, so the window is taken to end at posted_at + 600 s, the earliest it can), and if that
//                     one is not seen landing either, or the window may be over, the escrow is recorded as lost like the case above.
//   spent, unknown    removed once two passes in a row read it so: on a lagging indexer a live continuation reads spent for a while, and a Post that
//                     may still land reads unknown. An unknown read counts only once the Post's validity (valid_to) has passed.
//   cannot be read    kept as it is (a throw is keep).
//
// A note on the one more Accept. The vendored planAccept makes every Accept valid until submitted_at + 600 s, the end of the window itself, so on
// RealChain an Accept that can no longer land leaves no window for another, and the escrow is recorded as lost once that Accept's validity has passed.
// The one more Accept is made only for an Accept whose validity ends before the window does (a Chain that builds it so, and FakeChain in the tests).
//
// While a job runs (ruling R55). Every transaction of the janitor holds the chain's queue for its build and its confirmation, and a job's Post or Accept
// queued behind it waits that long; a Reclaim has no closing deadline on chain and an Accept has one. So a pass is given `busy`, and a transaction it
// would make while busy() says a job is running is deferred: nothing is sent, and the entry is looked at again on the next pass. The reads go on
// (the state of each entry, the drop of an entry read spent or unknown twice), and the pass logs one line with the count of what it deferred.
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { ACCEPT_WINDOW_MS, TxNotConfirmedError } from '@vsa/buyer-core';
import type { Chain, ChainEscrowState } from '@vsa/buyer-core';
import { canonicalRef, errorText, iso } from './format.ts';

export type StrandedKind = 'ocr' | 'llm';
/** An Accept that was signed and sent but not seen confirmed: its transaction, the end of its validity, and who made it (the run, or the janitor's one more). */
export interface AcceptPending { tx_hash: string; valid_to: number; by: 'run' | 'janitor' }
/** A sub-escrow the janitor looks after. Times are POSIX milliseconds. */
export interface StrandedEntry {
  escrow_ref: string;
  deliver_by: number;
  posted_at: number;
  /** The hop that posted it. */
  kind: StrandedKind;
  /** For a Post that failed after its signature: it may land until then, and an unknown read counts only after it. */
  valid_to?: number;
  /** Noted when the janitor finds the escrow Submitted and cannot accept it: from then on at the latest, its supplier may release it. */
  lost_to_release_after?: number;
  /** How many passes in a row read the escrow spent or unknown. */
  gone_reads?: number;
  /** Set when an Accept of this escrow may still land (ruling R33). */
  accept_pending?: AcceptPending;
}
export type JanitorChain = Pick<Chain, 'escrowState' | 'reclaim' | 'accept'>;
/**
 * What a pass did with an entry: `waiting` (not due yet), `reclaimed`, `accepted`, `kept` (looked at and left), `dropped` (removed without a
 * transaction), `deferred` (its transaction waits for the next pass: a job is running).
 */
export interface JanitorAction { escrow_ref: string; action: 'waiting' | 'reclaimed' | 'accepted' | 'kept' | 'dropped' | 'deferred'; note: string }
/** Is a job running now? The service passes its job slot; without one, never. */
export type Busy = () => boolean;
const NEVER_BUSY: Busy = () => false;
const A_JOB_IS_RUNNING = 'a job is running';

export const STRANDED_FILE = 'stranded.json';
/** The janitor takes an entry this long after its deliver_by: a Reclaim opens at the first whole second after it. */
export const JANITOR_GRACE_MS = 5_000;

const FIELDS: ReadonlySet<string> = new Set(['escrow_ref', 'deliver_by', 'posted_at', 'kind', 'valid_to', 'lost_to_release_after', 'gone_reads', 'accept_pending']);
const PENDING_FIELDS: ReadonlySet<string> = new Set(['tx_hash', 'valid_to', 'by']);
const TX_HASH = /^[0-9a-f]{64}$/;
const isWhole = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value);
const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const unknownField = (fields: ReadonlySet<string>, value: Record<string, unknown>): string | undefined => Object.keys(value).find((key) => !fields.has(key));
const fieldName = (key: string): string => JSON.stringify(key.length > 40 ? `${key.slice(0, 40)}...` : key);

/** The accept_pending marker `value` describes, with no field but its three; throws, naming the escrow, when it is not one. */
function pendingOf(value: unknown, escrowRef: string): AcceptPending {
  const where = `accept_pending of ${escrowRef}`;
  if (!isObject(value)) throw new Error(`${where} is not an object`);
  const extra = unknownField(PENDING_FIELDS, value);
  if (extra !== undefined) throw new Error(`unknown field ${fieldName(extra)} in ${where}`);
  if (typeof value.tx_hash !== 'string' || !TX_HASH.test(value.tx_hash)) throw new Error(`${where}: tx_hash is not a transaction hash`);
  if (!isWhole(value.valid_to)) throw new Error(`${where}: valid_to is not a whole number`);
  if (value.by !== 'run' && value.by !== 'janitor') throw new Error(`${where}: by is neither run nor janitor`);
  return { tx_hash: value.tx_hash, valid_to: value.valid_to, by: value.by };
}

/**
 * The entry `value` describes, in canonical form; throws, naming the field, when it is not one. A field it does not know is an error, not dropped: a
 * marker lost on the way through the store could cost an escrow.
 */
function entryOf(value: unknown): StrandedEntry {
  if (!isObject(value)) throw new Error('an entry is not an object');
  const extra = unknownField(FIELDS, value);
  if (extra !== undefined) throw new Error(`unknown field ${fieldName(extra)}`);
  if (typeof value.escrow_ref !== 'string') throw new Error('escrow_ref is not text');
  const escrowRef = canonicalRef(value.escrow_ref);
  for (const field of ['deliver_by', 'posted_at', 'valid_to', 'lost_to_release_after', 'gone_reads'] as const) {
    const required = field === 'deliver_by' || field === 'posted_at';
    if ((required || value[field] !== undefined) && !isWhole(value[field])) throw new Error(`${field} of ${escrowRef} is not a whole number`);
  }
  if (value.kind !== 'ocr' && value.kind !== 'llm') throw new Error(`kind of ${escrowRef} is neither ocr nor llm`);
  const optional = (field: 'valid_to' | 'lost_to_release_after' | 'gone_reads') => (value[field] === undefined ? {} : { [field]: value[field] as number });
  return {
    escrow_ref: escrowRef, deliver_by: value.deliver_by as number, posted_at: value.posted_at as number, kind: value.kind,
    ...optional('valid_to'), ...optional('lost_to_release_after'), ...optional('gone_reads'),
    ...(value.accept_pending === undefined ? {} : { accept_pending: pendingOf(value.accept_pending, escrowRef) }),
  };
}

/** The codes a platform answers when it cannot flush a directory (Windows says EPERM, some file systems EINVAL): the rename stands, unflushed. */
const CANNOT_FLUSH_DIRECTORY: ReadonlySet<string> = new Set(['EPERM', 'EINVAL', 'EISDIR']);
const codeOf = (err: unknown): string => (isObject(err) && typeof err.code === 'string' ? err.code : '');

/** Flushes `dir`, so that a rename inside it survives a crash; where the platform cannot, it is let be, and any other failure is thrown. */
function flushDirectory(dir: string): void {
  let fd: number;
  try { fd = openSync(dir, 'r'); } catch (err) {
    if (CANNOT_FLUSH_DIRECTORY.has(codeOf(err))) return;
    throw err;
  }
  try {
    fsyncSync(fd);
  } catch (err) {
    if (!CANNOT_FLUSH_DIRECTORY.has(codeOf(err))) throw err;
  } finally {
    closeSync(fd);
  }
}

/**
 * The stranded escrows, in memory and in `<stateDir>/stranded.json`. Every change is written at once, whole: to a temporary file, every byte of it,
 * flushed, renamed over the old one, and the directory flushed after the rename, so the file is always one complete list. A file that is there and is
 * not such a list is refused when the store is made: starting empty would forget escrows that still hold a lock. Refs are kept in canonical form, and found
 * however they are written. Known gap (ruling R39): an escrow is written here once its Post is confirmed or has failed after its signature, so a
 * process that exits between signing a Post and either of those leaves an escrow this store never saw; the Chain has no hook before the submit yet.
 */
export class StrandedStore {
  readonly file: string;
  readonly #dir: string;
  readonly #entries = new Map<string, StrandedEntry>();

  constructor(stateDir: string) {
    mkdirSync(stateDir, { recursive: true });
    this.#dir = stateDir;
    this.file = join(stateDir, STRANDED_FILE);
    let text: string;
    try { text = readFileSync(this.file, 'utf8'); } catch (err) {
      if (codeOf(err) === 'ENOENT') return;
      throw err;
    }
    try {
      const list: unknown = JSON.parse(text);
      if (!Array.isArray(list)) throw new Error('it is not a list');
      for (const value of list) { const entry = entryOf(value); this.#entries.set(entry.escrow_ref, entry); }
    } catch (err) {
      throw new Error(`${this.file} is not a list of stranded escrows (${errorText(err)}). It was left as it is: repair or move it before the service starts, or the escrows it names are forgotten.`);
    }
  }

  /** Every entry, oldest first, as copies. */
  list(): StrandedEntry[] {
    return [...this.#entries.values()].map((entry) => structuredClone(entry));
  }

  get(escrowRef: string): StrandedEntry | undefined {
    const entry = this.#entries.get(canonicalRef(escrowRef));
    return entry === undefined ? undefined : structuredClone(entry);
  }

  /** Adds an entry, or replaces the one of the same escrow. Throws, adding nothing, for an entry that could not be read back. */
  add(entry: StrandedEntry): void {
    const checked = entryOf(entry);
    this.#entries.set(checked.escrow_ref, checked);
    this.#write();
  }

  /** Changes the fields of an entry; a field set to undefined is removed. An escrow that is not in the store is left out of it. */
  update(escrowRef: string, patch: Partial<Omit<StrandedEntry, 'escrow_ref'>>): void {
    const ref = canonicalRef(escrowRef);
    const entry = this.#entries.get(ref);
    if (entry === undefined) return;
    const next: Record<string, unknown> = { ...entry };
    for (const [field, value] of Object.entries(patch)) {
      if (value === undefined) delete next[field];
      else next[field] = value;
    }
    this.#entries.set(ref, entryOf({ ...next, escrow_ref: ref }));
    this.#write();
  }

  remove(escrowRef: string): void {
    if (this.#entries.delete(canonicalRef(escrowRef))) this.#write();
  }

  #write(): void {
    const temporary = `${this.file}.tmp`;
    const bytes = Buffer.from(`${JSON.stringify([...this.#entries.values()], null, 2)}\n`, 'utf8');
    const fd = openSync(temporary, 'w');
    try {
      // A write may take fewer bytes than it is given: write until every byte is down.
      for (let written = 0; written < bytes.length;) {
        const n = writeSync(fd, bytes, written, bytes.length - written);
        if (n <= 0) throw new Error(`the write of ${temporary} made no progress`);
        written += n;
      }
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, this.file);
    flushDirectory(this.#dir);
  }
}

/** What one pass does with one entry at `now`; a transaction it would make while `busy()` is deferred. */
async function tend(store: StrandedStore, chain: JanitorChain, entry: StrandedEntry, now: number, busy: Busy): Promise<JanitorAction> {
  const ref = entry.escrow_ref;
  const did = (action: JanitorAction['action'], note: string): JanitorAction => ({ escrow_ref: ref, action, note });
  if (entry.accept_pending === undefined) {
    const due = entry.deliver_by + JANITOR_GRACE_MS;
    if (now < due) return did('waiting', `due at ${iso(due)}`);
  }
  let state: ChainEscrowState;
  try { state = await chain.escrowState(ref); } catch (err) { return did('kept', `its state could not be read (${errorText(err)})`); }
  if (state === 'spent' || state === 'unknown') {
    // Gone, if a second pass says so too; an unknown read does not count while the Post may still land.
    if (state === 'unknown' && entry.valid_to !== undefined && now < entry.valid_to) return did('kept', `unknown: the Post may still land until ${iso(entry.valid_to)}`);
    const reads = (entry.gone_reads ?? 0) + 1;
    if (reads >= 2) {
      store.remove(ref);
      return did('dropped', `${state} on two passes in a row`);
    }
    store.update(ref, { gone_reads: reads });
    return did('kept', `${state} (first read): read again on the next pass before it is dropped`);
  }
  // A live read ends a run of spent or unknown reads.
  if (entry.gone_reads !== undefined) store.update(ref, { gone_reads: undefined });
  if (entry.accept_pending !== undefined) return tendAccept(store, chain, entry, entry.accept_pending, state, now, busy);
  if (state === 'Submitted') {
    const lostAfter = entry.lost_to_release_after ?? entry.deliver_by + ACCEPT_WINDOW_MS;
    if (entry.lost_to_release_after === undefined) store.update(ref, { lost_to_release_after: lostAfter });
    return did('kept', `Submitted: it cannot be reclaimed, and its supplier may release it from ${iso(lostAfter)} at the latest`);
  }
  return reclaimed(store, chain, ref, state, busy);
}

/**
 * The Reclaim of an Open or Claimed escrow, and the entry removed once it is confirmed; one that fails keeps the entry for the next pass, and so does
 * one deferred while a job runs (busy() is asked at the moment the Reclaim would be made).
 */
async function reclaimed(store: StrandedStore, chain: JanitorChain, ref: string, state: 'Open' | 'Claimed', busy: Busy): Promise<JanitorAction> {
  if (busy()) return { escrow_ref: ref, action: 'deferred', note: `${state}: its Reclaim waits, ${A_JOB_IS_RUNNING}` };
  let txHash: string;
  try { ({ txHash } = await chain.reclaim(ref)); } catch (err) { return { escrow_ref: ref, action: 'kept', note: `${state}: the Reclaim failed (${errorText(err)})` }; }
  store.remove(ref);
  return { escrow_ref: ref, action: 'reclaimed', note: `${state}: the Reclaim ${txHash} returned everything it locked` };
}

/** An escrow whose Accept may still land, read live (ruling R33). */
async function tendAccept(store: StrandedStore, chain: JanitorChain, entry: StrandedEntry, pending: AcceptPending, state: 'Open' | 'Claimed' | 'Submitted', now: number, busy: Busy): Promise<JanitorAction> {
  const ref = entry.escrow_ref;
  const did = (action: JanitorAction['action'], note: string): JanitorAction => ({ escrow_ref: ref, action, note });
  if (state !== 'Submitted') {
    // Lag behind the Submit, until the Accept can no longer land and deliver_by + 5 s has passed: then the rule of any entry, the Reclaim.
    if (now >= pending.valid_to && now >= entry.deliver_by + JANITOR_GRACE_MS) return reclaimed(store, chain, ref, state, busy);
    return did('kept', `${state}: an escrow whose Accept was sent reads ${state} while the indexer lags its Submit; read again on the next pass`);
  }
  if (now < pending.valid_to) return did('kept', `Submitted: its Accept ${pending.tx_hash} may still land until ${iso(pending.valid_to)}`);
  const notLanded = `Submitted: its Accept ${pending.tx_hash} did not land by ${iso(pending.valid_to)}`;
  const lost = (why: string): JanitorAction => {
    const lostAfter = entry.lost_to_release_after ?? entry.deliver_by + ACCEPT_WINDOW_MS;
    store.update(ref, { accept_pending: undefined, lost_to_release_after: lostAfter });
    return did('kept', `${notLanded}${why}; lost to its supplier's release from ${iso(lostAfter)} at the latest`);
  };
  if (pending.by !== 'run') return lost(', and one more Accept was already made');
  // The window runs 600 s from the Submit. The Chain gives no submitted_at, and the Submit came after the Post: posted_at + 600 s is the earliest it ends.
  if (now >= entry.posted_at + ACCEPT_WINDOW_MS) return lost(' and the accept window may be over');
  if (busy()) return did('deferred', `Submitted: its one more Accept waits, ${A_JOB_IS_RUNNING}`);
  let accepted: { txHash: string };
  try {
    accepted = await chain.accept(ref);
  } catch (err) {
    if (err instanceof TxNotConfirmedError && err.mayLand) {
      store.update(ref, { accept_pending: { tx_hash: err.txHash, valid_to: err.validTo, by: 'janitor' } });
      return did('kept', `${notLanded}; accepted again in ${err.txHash}, which may land until ${iso(err.validTo)}`);
    }
    return lost(`; the Accept could not be made again (${errorText(err)})`);
  }
  store.remove(ref);
  return did('accepted', `${notLanded}; accepted again in ${accepted.txHash}`);
}

/**
 * One pass over the store at `now` (POSIX ms), entry by entry, in the order they were added. A transaction it would make while `busy()` says a job is
 * running is deferred (see the head of this file). Rejects only when the store cannot be written.
 */
export async function runJanitorOnce(store: StrandedStore, chain: JanitorChain, now: number, busy: Busy = NEVER_BUSY): Promise<JanitorAction[]> {
  const actions: JanitorAction[] = [];
  for (const entry of store.list()) actions.push(await tend(store, chain, entry, now, busy));
  return actions;
}

/**
 * Runs a pass at once and then one every `intervalMs` after the last one ended, until stopped; logs every action but `waiting` and `deferred`, and a
 * pass that failed, as one line each, and the transactions a pass deferred while a job ran (`busy`) as one line with their count. The timer does not
 * keep the process alive. `stop` resolves once the pass in flight, if any, has ended.
 */
export function startJanitor(
  store: StrandedStore, chain: JanitorChain, intervalMs: number, opts: { clock?: () => number; log?: (line: string) => void; busy?: Busy } = {},
): { stop: () => Promise<void> } {
  if (typeof intervalMs !== 'number' || !Number.isFinite(intervalMs) || intervalMs <= 0) throw new RangeError('The janitor interval must be a positive number of milliseconds.');
  const clock = opts.clock ?? Date.now;
  const log = opts.log ?? ((line: string) => { console.log(line); });
  const busy = opts.busy ?? NEVER_BUSY;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: Promise<void> = Promise.resolve();
  const pass = async (): Promise<void> => {
    try {
      const actions = await runJanitorOnce(store, chain, clock(), busy);
      for (const action of actions) if (action.action !== 'waiting' && action.action !== 'deferred') log(`janitor: ${action.action} ${action.escrow_ref}: ${action.note}`);
      const deferred = actions.filter((action) => action.action === 'deferred').length;
      if (deferred > 0) log(`janitor: ${deferred} ${deferred === 1 ? 'transaction' : 'transactions'} deferred: ${A_JOB_IS_RUNNING}; ${deferred === 1 ? 'it is' : 'they are'} made on the next pass after it`);
    } catch (err) {
      log(`janitor: the pass failed (${errorText(err)})`);
    }
  };
  const run = (): void => {
    inFlight = pass().then(() => {
      if (stopped) return;
      timer = setTimeout(run, intervalMs);
      timer.unref();
    });
  };
  run();
  return {
    stop: async () => {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      await inFlight;
    },
  };
}
