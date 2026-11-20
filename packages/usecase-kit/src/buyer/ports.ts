// packages/usecase-kit/src/buyer/ports.ts
// The reads of the ledger that the flow needs, as a port: the delegation of the job, and the Live vault outputs that name it. A test gives a port of its own. A service makes the real one
// from a `LedgerEnv` of buyer-core with `ledgerReadsFrom`. A read that cannot be made rejects. The flow never reads a rejection as "not found" and never as a pass.
import { readDelegation, readVaults } from '@vsa/buyer-core';
import type { LedgerEnv } from '@vsa/buyer-core';
import type { DelegationId } from '@vsa/usecase-kit/protocol';

/** A delegation as the flow reads it. */
export interface DelegationReading {
  /** The agent that the delegation names as its delegate: 64 lower-case hex characters, which is the id in the DID of the agent. */
  readonly delegate: string;
  /** False when an ancestor of the delegation was undelegated. The delegation exists, and no Pay can use it. */
  readonly chain_whole: boolean;
}

/** The Live vault outputs of a delegation. */
export interface LiveVaults {
  /** The references of the vault outputs that are unspent, are Live, name the delegation, and are not known to have another owner than its delegator. */
  readonly refs: readonly string[];
  /** False when the read stopped before the last output. The flow then cannot tell that one vault is the only one. */
  readonly complete: boolean;
}

export interface LedgerReads {
  /** The delegation, or `null` when no delegation has that name on the ledger: it was never made, or it was undelegated. Rejects when the ledger cannot be read. */
  delegation(id: DelegationId): Promise<DelegationReading | null>;
  /** The Live vault outputs that name the delegation, at the time `atMs`. Rejects when the ledger cannot be read. */
  liveVaults(id: DelegationId, atMs: number): Promise<LiveVaults>;
}

/** An output list of buyer-core holds 50 rows at most. A delegation has one vault, so more than a few pages of outputs are not a vault of a delegator. */
const PAGE_ROWS = 50;
const MAX_PAGES = 4;

/**
 * The port over a `LedgerEnv` of buyer-core: `readDelegation` and `readVaults`. Anyone can write an output at the vault address with any datum, so a vault output of another owner than the
 * delegator of its delegation is left out: the vault script never lets it pay. An output that the node does not hold is spent, or the indexer is ahead of the node, and it is left out too.
 * An output whose delegation could not be read stays in: the ledger decides on it when the Pay is evaluated.
 */
export function ledgerReadsFrom(env: LedgerEnv): LedgerReads {
  return {
    async delegation(id) {
      const view = await readDelegation(env, id);
      const leaf = view.chain[0];
      if (leaf === undefined) return null;
      return { delegate: leaf.delegation.delegate, chain_whole: view.missingParent === null };
    },
    async liveVaults(id, atMs) {
      const refs: string[] = [];
      let offset = 0;
      for (let pages = 0; pages < MAX_PAGES; pages += 1) {
        const page = await readVaults(env, { delegation: id }, atMs, { offset, limit: PAGE_ROWS });
        for (const reading of page.items) {
          if (reading.onNode && reading.output.vault.type === 'Live' && reading.live?.ownerIsDelegator !== false) refs.push(reading.output.ref);
        }
        if (page.nextOffset === null) return { refs, complete: true };
        offset = page.nextOffset;
      }
      return { refs, complete: false };
    },
  };
}
