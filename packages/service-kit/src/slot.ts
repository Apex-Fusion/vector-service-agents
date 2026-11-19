// packages/service-kit/src/slot.ts
// The one place a job runs, and the reservation of it that a pre-check makes. Moved from agents/document-pipeline/src/server.ts as it stood; the reservation
// is new.

/**
 * How long a pre-check keeps the slot for its escrow: 120 s. The runtime asks before it claims the escrow, and the claim has to be on the chain before it posts
 * the job, so the slot must stay free of other jobs for that time. A reservation that no job takes ends when the time is over.
 */
export const RESERVATION_MS = 120_000;

/**
 * The one place a job runs: one at a time, because a service has one job slot. A request takes the slot once it has been read and found to be a request, before
 * that only its upload is under way, so that a client that stalls cannot hold it. A service that is stopping drains the slot: the job that holds it goes on, and
 * no other is taken.
 *
 * A pre-check can reserve the slot for one escrow, by its reference, for RESERVATION_MS. While the reservation stands, the job of that escrow takes it and any
 * other job is held off. A job that takes the reservation ends it: the slot is then busy as for any job, and free again, for any escrow, when the job ends. The
 * slot has no clock. A call that has to know the time is given it, in milliseconds, and the server gives the time of its own clock, so that one clock decides.
 */
export class JobSlot {
  #busy = false;
  #draining = false;
  #waiting: Array<() => void> = [];
  #reservation: { readonly escrowRef: string; readonly at: number } | undefined;
  /**
   * 'taken' when the caller now holds the slot; otherwise why not: 'draining', 'busy' (a job runs), or 'held' (the slot is reserved for another escrow, or for
   * a call that gave none). Draining outranks busy: it is the answer that will not change. `escrowRef` is the escrow of the job, when it has a context: the
   * job of the escrow that holds a reservation takes it, and the reservation is gone.
   */
  take(escrowRef?: string, now: number = Date.now()): 'taken' | 'busy' | 'held' | 'draining' {
    const state = this.canTake(escrowRef, now);
    if (state !== 'free') return state;
    this.#reservation = undefined;
    this.#busy = true;
    return 'taken';
  }
  /**
   * Reserves the slot for `escrowRef` from `now` for RESERVATION_MS: 'reserved', or why not: 'draining', 'busy' (a job runs), or 'held' (a reservation of another
   * escrow stands). The escrow that holds a reservation reserves again, and the time starts again.
   */
  reserve(escrowRef: string, now: number = Date.now()): 'reserved' | 'busy' | 'held' | 'draining' {
    const state = this.canTake(escrowRef, now);
    if (state !== 'free') return state;
    this.#reservation = { escrowRef, at: now };
    return 'reserved';
  }
  /** What `take(escrowRef, now)` would find: 'free' when it would take the slot, and else the reason it would not. Nothing changes. */
  canTake(escrowRef: string | undefined, now: number = Date.now()): 'free' | 'busy' | 'held' | 'draining' {
    if (this.#draining) return 'draining';
    if (this.#busy) return 'busy';
    const held = this.reservedFor(now);
    return held === undefined || held === escrowRef ? 'free' : 'held';
  }
  /**
   * The escrow that holds a reservation at `now`, if one does. A reservation lives from the time it was made to RESERVATION_MS later, not to the millisecond of
   * the end. One that has ended is dropped here for good, and so is one made in the future of `now`: a clock that was set back must not hold the slot for the
   * time it was set back by, nor bring an ended reservation back to life.
   */
  reservedFor(now: number = Date.now()): string | undefined {
    const held = this.#reservation;
    if (held === undefined) return undefined;
    const age = now - held.at;
    if (age >= 0 && age < RESERVATION_MS) return held.escrowRef;
    this.#reservation = undefined;
    return undefined;
  }
  release(): void {
    this.#busy = false;
    for (const resolve of this.#waiting.splice(0)) resolve();
  }
  /** From now on no job is taken, and no reservation is made. */
  drain(): void { this.#draining = true; }
  /** Does a job hold the slot? A reservation is no job. */
  get busy(): boolean { return this.#busy; }
  /**
   * Resolves once no job holds the slot: at once when none does, else when the job releases it, which is when its run has ended. A stopping service waits on
   * this, and the connection of the job is no measure of it: that ends at once when the caller hangs up. A reservation is not waited for.
   */
  idle(): Promise<void> {
    if (!this.#busy) return Promise.resolve();
    return new Promise((resolve) => { this.#waiting.push(resolve); });
  }
}
