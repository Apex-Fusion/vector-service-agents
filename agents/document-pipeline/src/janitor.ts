// agents/document-pipeline/src/janitor.ts
// The escrows a run posted and did not accept, and the janitor that gets their locks back. A run writes every sub-escrow to the stranded store the
// moment its Post is confirmed, and removes it only once its Accept is confirmed; a Post that failed after its signature and may still land is written
// too, with the end of its validity (ruling R16). So whatever ends a run (a refusal, the deadline, a crash), the escrows it leaves behind are in the
// store, which is a JSON file in the state directory (PIPELINE_STATE_DIR in the service), rewritten whole through a rename at every change.
//
// The janitor looks at each entry from 5 s after its deliver_by on, the first moment a Reclaim is sure to be open:
//   Open or Claimed   reclaimed (everything locked comes back), and removed once the Reclaim is confirmed; a Reclaim that fails is tried again on the
//                     next pass.
//   Submitted         kept: the supplier submitted a receipt the run did not accept (it failed a check, or the run ran out of time), so it cannot be
//                     reclaimed, and the supplier may release it once the accept window after its Submit has passed. The entry notes from when that
//                     is sure (lost_to_release_after, deliver_by + 600 s, as the Submit came before deliver_by), and stays until it is spent.
//   spent, unknown    removed once two passes in a row read it so: on a lagging indexer a live continuation reads spent for a while, and a Post that
//                     may still land reads unknown. An unknown read counts only once the Post's validity (valid_to) has passed.
//   cannot be read    kept as it is (a throw is keep).
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { formatOutRef, parseOutRef } from '@vsa/vector-read';
import { ACCEPT_WINDOW_MS } from '@vsa/buyer-core';
import type { Chain, ChainEscrowState } from '@vsa/buyer-core';
import { errorText } from './result.ts';

export type StrandedKind = 'ocr' | 'llm';
/** A sub-escrow the janitor looks after. Times are POSIX milliseconds. */
export interface StrandedEntry {
  escrow_ref: string;
  deliver_by: number;
  posted_at: number;
  /** The hop that posted it. */
  kind: StrandedKind;
  /** For a Post that failed after its signature: it may land until then, and an unknown read counts only after it. */
  valid_to?: number;
  /** Noted the first time the janitor finds the escrow Submitted: from then on at the latest, its supplier may release it. */
  lost_to_release_after?: number;
  /** How many passes in a row read the escrow spent or unknown. */
  gone_reads?: number;
}
export type JanitorChain = Pick<Chain, 'escrowState' | 'reclaim'>;
/** What a pass did with an entry: `waiting` (not due yet), `reclaimed`, `kept` (looked at and left), `dropped` (removed without a transaction). */
export interface JanitorAction { escrow_ref: string; action: 'waiting' | 'reclaimed' | 'kept' | 'dropped'; note: string }

export const STRANDED_FILE = 'stranded.json';
/** The janitor takes an entry this long after its deliver_by: a Reclaim opens at the first whole second after it. */
export const JANITOR_GRACE_MS = 5_000;

const canonicalRef = (ref: string): string => { const { txHash, outputIndex } = parseOutRef(ref); return formatOutRef(txHash, outputIndex); };
const isWhole = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value);
const iso = (ms: number): string => new Date(ms).toISOString();

/** The entry `value` describes, in canonical form and with no field but the known ones; throws, naming the field, when it is not one. */
function entryOf(value: unknown): StrandedEntry {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('an entry is not an object');
  const e = value as Record<string, unknown>;
  if (typeof e.escrow_ref !== 'string') throw new Error('escrow_ref is not text');
  const escrowRef = canonicalRef(e.escrow_ref);
  for (const field of ['deliver_by', 'posted_at', 'valid_to', 'lost_to_release_after', 'gone_reads'] as const) {
    const required = field === 'deliver_by' || field === 'posted_at';
    if ((required || e[field] !== undefined) && !isWhole(e[field])) throw new Error(`${field} of ${escrowRef} is not a whole number`);
  }
  if (e.kind !== 'ocr' && e.kind !== 'llm') throw new Error(`kind of ${escrowRef} is neither ocr nor llm`);
  const optional = (field: 'valid_to' | 'lost_to_release_after' | 'gone_reads') => (e[field] === undefined ? {} : { [field]: e[field] as number });
  return {
    escrow_ref: escrowRef, deliver_by: e.deliver_by as number, posted_at: e.posted_at as number, kind: e.kind,
    ...optional('valid_to'), ...optional('lost_to_release_after'), ...optional('gone_reads'),
  };
}

/**
 * The stranded escrows, in memory and in `<stateDir>/stranded.json`. Every change is written at once, whole, to a temporary file that is flushed and
 * renamed over the old one, so the file is always one complete list. A file that is there and is not such a list is refused when the store is
 * made: starting empty would forget escrows that hold funds. Refs are kept in canonical form, and found however they are written.
 */
export class StrandedStore {
  readonly file: string;
  readonly #entries = new Map<string, StrandedEntry>();

  constructor(stateDir: string) {
    mkdirSync(stateDir, { recursive: true });
    this.file = join(stateDir, STRANDED_FILE);
    let text: string;
    try { text = readFileSync(this.file, 'utf8'); } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
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
    return [...this.#entries.values()].map((entry) => ({ ...entry }));
  }

  get(escrowRef: string): StrandedEntry | undefined {
    const entry = this.#entries.get(canonicalRef(escrowRef));
    return entry === undefined ? undefined : { ...entry };
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
    const fd = openSync(temporary, 'w');
    try {
      writeSync(fd, `${JSON.stringify([...this.#entries.values()], null, 2)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, this.file);
  }
}

/** What one pass does with one entry at `now`. */
async function tend(store: StrandedStore, chain: JanitorChain, entry: StrandedEntry, now: number): Promise<JanitorAction> {
  const ref = entry.escrow_ref;
  const did = (action: JanitorAction['action'], note: string): JanitorAction => ({ escrow_ref: ref, action, note });
  const due = entry.deliver_by + JANITOR_GRACE_MS;
  if (now < due) return did('waiting', `due at ${iso(due)}`);
  let state: ChainEscrowState;
  try { state = await chain.escrowState(ref); } catch (err) { return did('kept', `its state could not be read (${errorText(err)})`); }
  if (state === 'Open' || state === 'Claimed') {
    // A live read ends a run of spent or unknown reads.
    if (entry.gone_reads !== undefined) store.update(ref, { gone_reads: undefined });
    let txHash: string;
    try { ({ txHash } = await chain.reclaim(ref)); } catch (err) { return did('kept', `${state}: the Reclaim failed (${errorText(err)})`); }
    store.remove(ref);
    return did('reclaimed', `${state}: the Reclaim ${txHash} returned everything it locked`);
  }
  if (state === 'Submitted') {
    const lostAfter = entry.lost_to_release_after ?? entry.deliver_by + ACCEPT_WINDOW_MS;
    if (entry.lost_to_release_after === undefined || entry.gone_reads !== undefined) store.update(ref, { lost_to_release_after: lostAfter, gone_reads: undefined });
    return did('kept', `Submitted: it cannot be reclaimed, and its supplier may release it from ${iso(lostAfter)} at the latest`);
  }
  // spent or unknown: gone, if a second pass says so too; an unknown read does not count while the Post may still land.
  if (state === 'unknown' && entry.valid_to !== undefined && now < entry.valid_to) return did('kept', `unknown: the Post may still land until ${iso(entry.valid_to)}`);
  const reads = (entry.gone_reads ?? 0) + 1;
  if (reads >= 2) {
    store.remove(ref);
    return did('dropped', `${state} on two passes in a row`);
  }
  store.update(ref, { gone_reads: reads });
  return did('kept', `${state} (first read): read again on the next pass before it is dropped`);
}

/** One pass over the store at `now` (POSIX ms), entry by entry, in the order they were added. Rejects only when the store cannot be written. */
export async function runJanitorOnce(store: StrandedStore, chain: JanitorChain, now: number): Promise<JanitorAction[]> {
  const actions: JanitorAction[] = [];
  for (const entry of store.list()) actions.push(await tend(store, chain, entry, now));
  return actions;
}

/**
 * Runs a pass at once and then one every `intervalMs` after the last one ended, until stopped; logs every action but `waiting`, and a pass that
 * failed, as one line each. The timer does not keep the process alive. `stop` resolves once the pass in flight, if any, has ended.
 */
export function startJanitor(store: StrandedStore, chain: JanitorChain, intervalMs: number, opts: { clock?: () => number; log?: (line: string) => void } = {}): { stop: () => Promise<void> } {
  if (typeof intervalMs !== 'number' || !Number.isFinite(intervalMs) || intervalMs <= 0) throw new RangeError('The janitor interval must be a positive number of milliseconds.');
  const clock = opts.clock ?? Date.now;
  const log = opts.log ?? ((line: string) => { console.log(line); });
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: Promise<void> = Promise.resolve();
  const pass = async (): Promise<void> => {
    try {
      for (const action of await runJanitorOnce(store, chain, clock())) if (action.action !== 'waiting') log(`janitor: ${action.action} ${action.escrow_ref}: ${action.note}`);
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
