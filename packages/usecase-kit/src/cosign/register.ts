// packages/usecase-kit/src/cosign/register.ts
// The agent remembers each body that it signed. The delegation contract does not make a delegation key fresh, so the agent does: while the validity window of a body that it signed for a key is open, it
// refuses another body for that key. For the same body it gives the same answer again. The register is in memory: a restart of the service forgets it. The window of a Delegate is one hour at most.
//
// A request takes the key with `take` before its first read of the ledger, and so two requests for two bodies cannot both pass the check while one of them waits for the ledger. A request that ends
// without a signature gives the key back with `release`. A request that signed keeps it with `commit`, until the window ends.

interface Entry {
  readonly bodyHash: string;
  readonly until: number;
  signed: boolean;
  /** The requests for this body that run now. */
  running: number;
}

/** The key of one request. `commit` and `release` are each safe to call more than once. */
export interface Hold {
  /** The agent signed: the key stays with the body until its time ends. */
  commit(): void;
  /** The request is over. An entry that was not committed and has no other request that runs is dropped. */
  release(): void;
}

export class KeyReservations {
  readonly #entries = new Map<string, Entry>();

  /**
   * Takes `keyHash` for the body `bodyHash`, until the time `until` (POSIX ms). Returns undefined when another body holds the key at `now`. An entry whose time has come is dropped first. A time that is not
   * a number (`now` or `until`) never lets a body take a key that another body holds: the check refuses when it cannot compare.
   */
  take(keyHash: string, bodyHash: string, until: number, now: number): Hold | undefined {
    let entry = this.#entries.get(keyHash);
    if (entry !== undefined && now >= entry.until) {
      this.#entries.delete(keyHash);
      entry = undefined;
    }
    if (entry !== undefined && entry.bodyHash !== bodyHash) return undefined;
    if (!(Number.isFinite(until) && Number.isFinite(now))) return undefined;
    const held = entry ?? { bodyHash, until, signed: false, running: 0 };
    this.#entries.set(keyHash, held);
    held.running += 1;
    let over = false;
    return {
      commit: () => {
        held.signed = true;
      },
      release: () => {
        if (over) return;
        over = true;
        held.running -= 1;
        if (!held.signed && held.running === 0 && this.#entries.get(keyHash) === held) this.#entries.delete(keyHash);
      },
    };
  }

  /** The number of keys that are held now. For tests. */
  get size(): number {
    return this.#entries.size;
  }
}
