// agents/sourcing-agent/src/execute/ports.ts
// What the job `execute` of the Sourcing Agent (use case 3, supplier bid evaluation) needs from outside. A ledger, a gateway and the sourcing record are ports: this folder reads no file, no environment
// variable and no key, and it does not import the other folders of the agent. The job makes no model call, no hire and no vault Pay, so it has no port for them. The service makes the real ports from its
// settings.
import type { KeyInput } from '@vsa/id-kit/client';
import type { CallDeps, TokenDeps } from '@vsa/usecase-kit/access';
import type { LedgerReads } from '@vsa/usecase-kit/buyer';
import type { DelegationId, Did } from '@vsa/usecase-kit/protocol';

/**
 * One delegation key of the agent. The job pays nothing, so the key has no paying key: it is the DPoP key of the token request for the sourcing record. The gateway binds the token to the delegate key
 * of the delegation, so the key that signs the proof must be that key.
 */
export interface DelegationKeyDeps {
  readonly dpopKey: KeyInput;
}

export interface ExecuteDeps {
  /** The reads of the ledger. The job reads the delegation of the request with them, and it reads no vault. */
  readonly reads: LedgerReads;
  /** The key hash of the delegate key of a delegation (56 lower-case hex characters), or `null` when the ledger shows no such delegation. It rejects when the ledger cannot be read. */
  readonly delegateKeyOf: (id: DelegationId) => Promise<string | null>;
  readonly delegationKeys: {
    /** The deps of the delegation key with this key hash, or `null` when the agent holds no such key. */
    find(keyHash: string): DelegationKeyDeps | null;
    /**
     * The first configured delegation key. The job `execute` never reads it: a delegation that the ledger does not show has no delegate key, and the token for the sourcing record needs that key. The
     * service gives the same object to the jobs of this agent.
     */
    readonly first: DelegationKeyDeps;
  };
  /** This agent: its DID, and the Ed25519 authentication key that signs the subject token of the token request. */
  readonly agent: { readonly did: Did; readonly authenticationKey: KeyInput };
  readonly tokens: TokenDeps;
  /**
   * The call to the sourcing record. Its `clock` makes the bound of each wait of the job (the reads, the token and the call), and its `timeoutMs` is the longest wait of the call. The job lowers that wait
   * to the time that is left until its deadline. Its `bases` give the target of the token and of the call.
   */
  readonly calls: CallDeps;
  /** The time in POSIX milliseconds. The job reads it to find the time that is left until its deadline. The service gives to this function and to the clock of `calls` the same time. */
  readonly clock: () => number;
  /** One line for each step. A line has codes and statuses, and no key, token or part of a request. A function that throws changes no result. */
  readonly log: (line: string) => void;
}
