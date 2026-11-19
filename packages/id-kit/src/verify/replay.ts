// packages/id-kit/src/verify/replay.ts
// Single-use values at a relying party: the `jti` of each DPoP proof that it accepted. A proof is accepted once while it is acceptable (RFC 9449 Section 11.1). The store keeps a
// 128-bit digest of each key, so that an entry has the same small size whatever the length of the key. It fails closed: when it is full, it refuses a new value, and it never
// drops a value that a replay could then use.

import { createHash } from 'node:crypto';

/** The store is full of values that have not expired: a new value cannot be recorded. The call can work later. */
export class ReplayStoreFull extends Error {
  constructor() {
    super('too many single-use values in use');
  }
}

export interface ReplayStore {
  /**
   * Records `key` until `expiresAtMs`. Returns false when the key is recorded already and has not expired: a replay. Throws `ReplayStoreFull` when the store is full.
   * `nowMs` is the time of the call, in POSIX milliseconds.
   */
  use(key: string, expiresAtMs: number, nowMs: number): boolean;
  /** The number of values that the store holds. */
  readonly size: number;
}

export interface ReplayStoreOptions {
  /** The most values that the store holds. The default is 100,000. */
  readonly maxEntries?: number;
}

const PRUNE_INTERVAL_MS = 60_000;

export function createReplayStore(options: ReplayStoreOptions = {}): ReplayStore {
  const max = options.maxEntries ?? 100_000;
  const entries = new Map<string, number>();
  let lastPrune = 0;
  const prune = (nowMs: number): void => {
    lastPrune = nowMs;
    for (const [digest, expiresAt] of entries) if (expiresAt <= nowMs) entries.delete(digest);
  };
  return {
    use(key, expiresAtMs, nowMs) {
      if (nowMs - lastPrune >= PRUNE_INTERVAL_MS) prune(nowMs);
      const digest = createHash('sha256').update(key, 'utf8').digest('base64url').substring(0, 22);
      const known = entries.get(digest);
      if (known !== undefined && known > nowMs) return false;
      if (entries.size >= max) {
        prune(nowMs);
        if (entries.size >= max) throw new ReplayStoreFull();
      }
      entries.set(digest, expiresAtMs);
      return true;
    },
    get size() {
      return entries.size;
    },
  };
}
