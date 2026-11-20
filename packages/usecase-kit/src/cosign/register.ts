// packages/usecase-kit/src/cosign/register.ts
// The register of the bodies that the agent signed. The delegation contract does not make a delegation key fresh, so the agent does: for one delegation key, at most ONE body gets a signature while the
// window of that body and the margin are open. The route asks the register through the port `KeyRegister`. A service gives its own register, and it must keep the contract below. The default is
// `KeyReservations`, which keeps the entries in the memory of one process: a restart forgets them, and a second process does not see them. A service that runs more than one process, or that must keep the
// entries over a restart, gives a register that is shared and durable.
//
// The contract. The register has one entry for each key. An entry holds the hash of a body, the end of the hold (`untilMs`) and a flag that says whether the entry is committed. An entry is live while
// `nowMs < untilMs`. A key with no live entry is free. The route gives `nowMs` from its clock, and the end of the hold is the end of the validity window of the body and the margin
// (RESERVATION_MARGIN_MS), for an entry that is committed and for one that is not.
//
//   take     ONE atomic compare-and-set on the key. The key is free: the register makes the entry for the body, not committed, and answers 'held'. A live entry holds the same body, committed or not: the
//            entry stays as it is and the answer is 'held', so the same body gets the same answer again. A live entry holds another body, committed or not: nothing changes and the answer is 'in_use'.
//            No other call can run between the check and the write: a durable register does it in one conditional write or in one transaction.
//   commit   The same compare-and-set, and the entry is committed and durable BEFORE the promise settles. The route sends an answer with a signature only after the commit has settled with 'held'.
//            The key is free: the register makes the entry as committed. A live entry holds the same body: it is marked as committed. A live entry holds another body: nothing changes and the answer is
//            'in_use', and the route does not send the signature. A promise that rejects means that the entry is not committed.
//   release  Removes the entry of the key only when it holds this body and is not committed. An entry of another body stays, and a committed entry stays until its time ends. An entry that is not
//            there is not an error, and a second call does no harm.
//
// A call that rejects, that does not settle within the time limit of the route (`ledgerTimeoutMs`), or that settles with another value than the ones above is `check_unavailable`: the route never reads
// it as 'free'. A call that the route abandons can still write later, and then it leaves an entry that no request releases. That entry ends at its `untilMs`, and the key stays held until then. This is
// safe: a key that is held too long never gives a second body, and the same body can ask again.

/** What one request asks of the register: the key, the body, and the end of the hold. */
export interface KeyClaim {
  /** The hash of the delegation key: 56 lower-case hex characters. */
  readonly keyHash: string;
  /** The hash of the body that the agent signs: 64 lower-case hex characters. */
  readonly bodyHash: string;
  /** The end of the hold in POSIX ms: the end of the validity window of the body and the margin. */
  readonly untilMs: number;
}

/** The answer of `take` and `commit`: 'held' when the key is held for the body of the claim after the call, and 'in_use' when another body holds it. */
export type ClaimResult = 'held' | 'in_use';

/** The port of the register. The contract is in the comment at the top of this file. */
export interface KeyRegister {
  take(claim: KeyClaim, nowMs: number): Promise<ClaimResult>;
  commit(claim: KeyClaim, nowMs: number): Promise<ClaimResult>;
  release(claim: Pick<KeyClaim, 'keyHash' | 'bodyHash'>): Promise<void>;
}

interface Entry {
  readonly bodyHash: string;
  readonly untilMs: number;
  committed: boolean;
}

/** The register in memory: the default of the route. It keeps the contract inside one process. Each call runs to its end in one step, so the compare-and-set is atomic. */
export class KeyReservations implements KeyRegister {
  readonly #entries = new Map<string, Entry>();

  /** The live entry of the key at `nowMs`. An entry whose time has come is dropped. */
  #live(keyHash: string, nowMs: number): Entry | undefined {
    const entry = this.#entries.get(keyHash);
    if (entry !== undefined && nowMs >= entry.untilMs) {
      this.#entries.delete(keyHash);
      return undefined;
    }
    return entry;
  }

  /** The compare-and-set of `take` and of `commit`. A time that is not a number is a fault of the caller: the call rejects, and it never makes an entry that has no end. */
  #claim(claim: KeyClaim, nowMs: number, committed: boolean): ClaimResult {
    if (!(Number.isFinite(nowMs) && Number.isFinite(claim.untilMs))) throw new RangeError('the register needs a time that is a number');
    const entry = this.#live(claim.keyHash, nowMs);
    if (entry === undefined) {
      this.#entries.set(claim.keyHash, { bodyHash: claim.bodyHash, untilMs: claim.untilMs, committed });
      return 'held';
    }
    if (entry.bodyHash !== claim.bodyHash) return 'in_use';
    if (committed) entry.committed = true;
    return 'held';
  }

  async take(claim: KeyClaim, nowMs: number): Promise<ClaimResult> {
    return this.#claim(claim, nowMs, false);
  }

  async commit(claim: KeyClaim, nowMs: number): Promise<ClaimResult> {
    return this.#claim(claim, nowMs, true);
  }

  async release(claim: Pick<KeyClaim, 'keyHash' | 'bodyHash'>): Promise<void> {
    const entry = this.#entries.get(claim.keyHash);
    if (entry !== undefined && entry.bodyHash === claim.bodyHash && !entry.committed) this.#entries.delete(claim.keyHash);
  }

  /** The number of entries that the register holds now, a live one or one that nobody has dropped yet. For tests. */
  get size(): number {
    return this.#entries.size;
  }
}
