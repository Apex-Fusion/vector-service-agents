// agents/prior-authorization-agent/src/evidence/bookkeeping.ts
// The records of a sub-delegation, for each read of the evidence. A read makes one sub-delegation, and these functions keep the list of left sub-delegations and the set of the sub-delegations in use in step
// with it:
//
//   - The hook before the send (`beforeSendOf`) first reads the list of left sub-delegations. An entry with the id of this sub-delegation means that an earlier Delegate of the same key is on its way, because
//     the builder takes the id from the largest output of the wallet, and the read then sends nothing and records nothing. The list read has a bound of its own inside the bound of the hook, so that a late
//     answer never finds a read that ended. One damaged file of the list does not block the read, but a damaged file with the name of this sub-delegation does. Each stop writes one line with its cause to the
//     log, and the line names the subagent. Else the hook adds the id to the set of the sub-delegations in use and stores the entry in the list, both BEFORE the Delegate is sent.
//   - After the run, `updateList` removes the entry when the end is `ended` or `not_made`, and it stores the entry again with the Undelegate that was tried when the end is `not_ended`. Then `leave` takes the id
//     out of the set, on every path. So the janitor never ends the sub-delegation of a read that still waits, and a read that did not end its sub-delegation leaves an entry for the janitor. A failure to
//     update the list after the run changes no result: the entry that the hook stored stays, and the janitor ends it or drops it.
//
// A read of the evidence is one run of `withSubDelegation`, so these records are the same for the record reader and for the drafter. They are written for one read at a time: the first read ends, and its
// records are up to date, before the second read starts.
import { DEFAULT_STEP_TIMEOUT_MS, within } from '@vsa/usecase-kit/access';
import type { LeftSubDelegation, SubDelegationEnd } from '@vsa/usecase-kit/access';
import { DamagedLeftEntriesError } from '@vsa/usecase-kit/janitor';
import type { DelegationId } from '@vsa/usecase-kit/protocol';
import type { EvidenceDeps, LeftEntry, SubagentName } from './ports.ts';

/** The bound of one update of the list of left sub-delegations after the run. */
export const BOOKKEEPING_TIMEOUT_MS = DEFAULT_STEP_TIMEOUT_MS;
/** The longest wait for the read of the list inside the hook before the send. The hook has the bound `DEFAULT_STEP_TIMEOUT_MS` in the access folder, so this wait is a third of it: a read that answers later never finds a read of the evidence that is still waiting. */
export const LIST_TIMEOUT_MS = DEFAULT_STEP_TIMEOUT_MS / 3;

/** What the records of one read need: the deps, and the name of the subagent that each line of the log names. */
export interface Book {
  readonly deps: EvidenceDeps;
  readonly name: SubagentName;
}

/** Writes one line to the log of the deps. The line starts with the name of the folder and the name of the subagent. A log that throws changes no result: the line is lost, and the read goes on. */
export function note(book: Book, line: string): void {
  try {
    book.deps.log(`evidence: ${book.name}: ${line}`);
  } catch {
    // The line is lost.
  }
}

/**
 * The check inside the hook before the send: the list of left sub-delegations must hold no entry with the id of this sub-delegation. It throws when an entry has this id, and when it cannot tell: the read
 * fails, gives no list, or does not answer within `LIST_TIMEOUT_MS`. Each throw has one line in the log with its cause. The read has a bound of its own inside the bound of the hook of the access folder, so that
 * no answer comes after the read gave up: a late answer would add the id to the set of the sub-delegations in use and store the entry of a Delegate that was never sent, and nothing would take them away. One
 * damaged file of the list does not block the read: the entries that could be read are checked. A damaged file with the name of this sub-delegation does, because it may hold the entry of an earlier Delegate
 * with this id.
 */
export async function checkFree(book: Book, id: DelegationId): Promise<void> {
  const { clock, leftSink } = book.deps;
  let held: readonly LeftEntry[] | null;
  try {
    const listed = await within(clock, LIST_TIMEOUT_MS, () => leftSink.list());
    held = listed.timedOut ? null : listed.value;
  } catch (error) {
    if (!(error instanceof DamagedLeftEntriesError)) {
      note(book, 'no Delegate was sent: the list of left sub-delegations cannot be read');
      throw error;
    }
    if (error.damaged.some((damaged) => damaged.file === `${id}.json`)) {
      note(book, `no Delegate was sent for the sub-delegation ${id}: a damaged file of the list has the name of this sub-delegation`);
      throw error;
    }
    held = error.entries;
  }
  if (held === null) {
    note(book, `no Delegate was sent: the list of left sub-delegations did not answer within ${LIST_TIMEOUT_MS} ms`);
    throw new Error('the list of left sub-delegations did not answer in time');
  }
  const entries: unknown = held;
  if (!Array.isArray(entries)) {
    note(book, 'no Delegate was sent: the list of left sub-delegations cannot be read');
    throw new Error('the list of left sub-delegations is not a list');
  }
  if (entries.some((entry: LeftEntry) => entry.left.id === id)) {
    note(book, `no Delegate was sent for the sub-delegation ${id}: the list of left sub-delegations holds an entry with this id, so an earlier Delegate of this key may be on its way, and the janitor ends or drops that entry`);
    throw new Error('the list of left sub-delegations holds an entry with the id of this sub-delegation');
  }
}

/**
 * The hook that `withSubDelegation` calls with the reference of the sub-delegation just before it sends the Delegate. It throws, and nothing is sent, when the list holds an entry with this id or cannot be
 * read (`checkFree`). Else it takes the id (`sent.id`), adds it to the set of the sub-delegations in use, and stores the entry, in this order. A throw before `sent.id` is set means that this read records nothing
 * and removes nothing: the entry of the earlier Delegate stays. `keyHash` is the hash of the delegation key of this agent, which signs the Undelegate.
 */
export function beforeSendOf(book: Book, keyHash: string, sent: { id: DelegationId | null }): (reference: LeftSubDelegation) => Promise<void> {
  return async (reference) => {
    await checkFree(book, reference.id);
    sent.id = reference.id;
    book.deps.inFlight.add(reference.id);
    await book.deps.leftSink.put({ left: reference, signer_key_hash: keyHash });
  };
}

/**
 * Updates the list of left sub-delegations after the run. An end that is `ended` or `not_made` removes the entry of the id that the hook stored. An end that is `not_ended` stores the entry with the
 * Undelegate that was tried. A failure changes no result: the entry that the hook stored stays, and the janitor reads the ledger and ends the sub-delegation or drops the entry. `id` is the id that the hook took,
 * or null when the hook stopped before it took one.
 */
export async function updateList(book: Book, id: DelegationId | null, keyHash: string, end: SubDelegationEnd): Promise<void> {
  const { clock, leftSink } = book.deps;
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
    // The entry of the hook stays. See the head of this file.
  }
}

/** Takes the id out of the set of the sub-delegations in use. A read calls it on every path, also when it throws. `id` is null when the hook took none. */
export function leave(book: Book, id: DelegationId | null): void {
  if (id !== null) book.deps.inFlight.delete(id);
}
