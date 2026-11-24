// agents/insurer-intake-agent/src/store/passed.ts
// The record of the checks that passed. The hook of the Insurer Intake Agent checks a request before the runtime claims the escrow. The job runs after the Claim, and it needs what the hook learned: the sender,
// the approval and the names of the checks that passed. The hook puts one entry for each escrow, with the SHA-256 of the request that it checked, and the job takes it with the escrow reference of its context.
//
// The record names the escrow only, and it holds no hash of the request. So the entry holds the hash: the job compares it with the hash of the body that it was given, and a job with no entry, or with the entry
// of another body, writes nothing to the insurer portal.
//
//   put    stores the entry for the escrow. A second put for the same escrow replaces the entry and starts its time again. The 65th entry drops the oldest, and an entry that has ended is dropped first.
//   take   gives the entry and removes it. An entry that has ended, and an escrow that has none, give null. A second take gives null.
//
// An entry lives for PASSED_CHECKS_TTL_MS from its put. The store holds at most PASSED_CHECKS_LIMIT entries. The time is a parameter: a time that is not a whole number of milliseconds is a TypeError, because
// a comparison with NaN is false and would keep an entry alive for ever.
import { isPlainObject, parseDigest, parseOutputRef } from '@vsa/usecase-kit/protocol';
import type { Digest } from '@vsa/usecase-kit/protocol';
import type { ChecksRecord } from '@vsa/usecase-kit/checks';

/** How long an entry lives: five minutes. The job starts a few seconds after the hook, and the runtime holds the reservation of the slot for 120 seconds. */
export const PASSED_CHECKS_TTL_MS = 300_000;

/** The most entries that the store holds. */
export const PASSED_CHECKS_LIMIT = 64;

/** What the hook learned about one request. */
export interface PassedEntry {
  /** The checks that passed and what they learned: the record of `runChecks`. */
  readonly record: ChecksRecord;
  /** The `canonicalSha256` of the handoff that the hook checked. */
  readonly request_sha256: Digest;
}

interface Stored {
  readonly entry: PassedEntry;
  /** The time of the put. */
  readonly at: number;
}

/** A time as a whole number of milliseconds since 1970. */
function timeOf(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new TypeError('the time must be a whole number of milliseconds since 1970');
  return value;
}

/** The record of a run: an object with the objects `checks` and `facts`. */
function hasRecordForm(record: unknown): record is ChecksRecord {
  return isPlainObject(record) && isPlainObject(record.checks) && isPlainObject(record.facts);
}

export class PassedChecks {
  /** The entries by escrow reference. A Map keeps the order of the puts, so the first key is the oldest entry. */
  readonly #entries = new Map<string, Stored>();

  /** Stores the entry for the escrow at the time `nowMs`. It throws a TypeError for an escrow that is no output reference, a hash that is no hash, a record that is no record, and a time that is no time. */
  put(escrowRef: string, entry: PassedEntry, nowMs: number): void {
    const at = timeOf(nowMs);
    const ref = parseOutputRef(escrowRef, 'escrowRef');
    if (!ref.ok) throw new TypeError(ref.detail);
    if (!isPlainObject(entry) || !hasRecordForm(entry.record)) throw new TypeError('the entry must hold the record of the checks');
    const hash = parseDigest(entry.request_sha256, 'request_sha256');
    if (!hash.ok) throw new TypeError(hash.detail);
    // The entry is a copy that nobody changes. The record is the frozen record of the run of the checks.
    const stored: PassedEntry = Object.freeze({ record: entry.record, request_sha256: hash.value });
    this.#entries.delete(ref.value);
    for (const [key, held] of this.#entries) if (at - held.at >= PASSED_CHECKS_TTL_MS) this.#entries.delete(key);
    while (this.#entries.size >= PASSED_CHECKS_LIMIT) {
      const oldest = this.#entries.keys().next();
      if (oldest.done === true) break;
      this.#entries.delete(oldest.value);
    }
    this.#entries.set(ref.value, { entry: stored, at });
  }

  /** The entry of the escrow, removed from the store, or null when there is none or it has ended. It throws a TypeError for a time that is no time, and it removes nothing then. */
  take(escrowRef: string, nowMs: number): PassedEntry | null {
    const now = timeOf(nowMs);
    const held = this.#entries.get(escrowRef);
    if (held === undefined) return null;
    this.#entries.delete(escrowRef);
    return now - held.at < PASSED_CHECKS_TTL_MS ? held.entry : null;
  }
}
