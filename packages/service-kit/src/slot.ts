// packages/service-kit/src/slot.ts
// The one place a job runs. Moved from agents/document-pipeline/src/server.ts as it stood.

/**
 * The one place a job runs: one at a time, because a service has one job slot. A request takes the slot once it has been read and found to be a request, before
 * that only its upload is under way, so that a client that stalls cannot hold it. A service that is stopping drains the slot: the job that holds it goes on, and
 * no other is taken.
 */
export class JobSlot {
  #busy = false;
  #draining = false;
  #waiting: Array<() => void> = [];
  /** 'taken' when the caller now holds the slot; otherwise why not. Draining outranks busy: it is the answer that will not change. */
  take(): 'taken' | 'busy' | 'draining' {
    if (this.#draining) return 'draining';
    if (this.#busy) return 'busy';
    this.#busy = true;
    return 'taken';
  }
  release(): void {
    this.#busy = false;
    for (const resolve of this.#waiting.splice(0)) resolve();
  }
  /** From now on no job is taken. */
  drain(): void { this.#draining = true; }
  /** Does a job hold the slot? */
  get busy(): boolean { return this.#busy; }
  /**
   * Resolves once no job holds the slot: at once when none does, else when the job releases it, which is when its run has ended. A stopping service waits on
   * this, and the connection of the job is no measure of it: that ends at once when the caller hangs up.
   */
  idle(): Promise<void> {
    if (!this.#busy) return Promise.resolve();
    return new Promise((resolve) => { this.#waiting.push(resolve); });
  }
}
