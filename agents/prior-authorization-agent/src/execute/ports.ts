// agents/prior-authorization-agent/src/execute/ports.ts
// What the job `execute` of the Prior Authorization Agent (use case 2, prior authorization) needs from outside. A ledger, a gateway, a records system, a model, a challenge and the fault switch are ports: this
// folder reads no file, no environment variable and no key, and it does not import the other folders of the agent (`model`, `propose`, `evidence`, `insurer`, `counter` and `serve`). The service makes the real
// ports from its settings.
import type { AgentDeps, PayingKey } from '@vsa/hire-kit';
import type { KeyInput } from '@vsa/id-kit/client';
import type { CallDeps, TokenDeps } from '@vsa/usecase-kit/access';
import type { HireLimits, LedgerReads } from '@vsa/usecase-kit/buyer';
import type { Dispute } from '@vsa/usecase-kit/dispute';
import type { FaultSwitch } from '@vsa/usecase-kit/fault';
import type { Decision, DelegationId, Did, Digest } from '@vsa/usecase-kit/protocol';

/** The one value that the decision `accept_delivery` compares: the hash of the request. The second statement of the claim of the Insurer Intake Agent names it. */
export type MismatchName = 'request_sha256';

/** The choice of the decision `accept_delivery`: whether to accept, and the names of the values that differ. It accepts exactly when no value differs. */
export interface AcceptChoice {
  readonly accept: boolean;
  readonly mismatch: readonly MismatchName[];
}

/**
 * One side of the comparison of the decision `accept_delivery`: the number of a request and the hash of that request. The job makes both sides from checked data, and no other member of an intake record
 * goes to the model.
 */
export interface RequestSide {
  readonly request_number: string;
  readonly request_sha256: Digest;
}

/**
 * What the decision `accept_delivery` gives back. A decision that was made is the decision of the protocol (the choice as the model gave it, its reasoning and the model hire that bought it) and its choice as
 * a typed value. A decision that failed holds no decision: it has the code of the failure.
 */
export type AcceptAnswer =
  | { readonly ok: true; readonly decision: Decision; readonly choice: AcceptChoice }
  | { readonly ok: false; readonly code: string };

/**
 * One delegation key of the agent. The delegation key signs the Pay and the Accept of a hire, so its paying key has the chain, the queue and the stranded store of that key. The same key is the DPoP key of
 * the token request for the records system.
 */
export interface DelegationKeyDeps {
  readonly key: PayingKey;
  readonly dpopKey: KeyInput;
}

/** The delegation keys of the agent. A delegation names the one key that is its delegate key. */
export interface DelegationKeys {
  /** The deps of the delegation key with this key hash (56 lower-case hex characters), or `null` when the agent holds no such key. */
  find(keyHash: string): DelegationKeyDeps | null;
  /**
   * The first configured delegation key. A delegation that the ledger does not show has no delegate key to read, so the hire goes on with this key: it finds no Live vault of that delegation, and it ends with a
   * typed result. The ledger decides what is paid, and never this choice of a key.
   */
  readonly first: DelegationKeyDeps;
}

export interface ExecuteDeps {
  /** The reads of the ledger: the delegation of the request and its Live vaults. The check of the authority and the hire read the same ledger. */
  readonly reads: LedgerReads;
  /** The key hash of the delegate key of a delegation (56 lower-case hex characters), or `null` when the ledger shows no such delegation. It rejects when the ledger cannot be read. */
  readonly delegateKeyOf: (id: DelegationId) => Promise<string | null>;
  readonly delegationKeys: DelegationKeys;
  /**
   * The deps of the hire of the Insurer Intake Agent: the clock, the sleep, the fetch, the ledger that books the lock and the fees, and the log. The deadline of the hire is not here: `runExecute` sets it from
   * the time that the request arrived.
   */
  readonly hire: Omit<AgentDeps, 'deadlineMs'>;
  /** The three limits of the hire of the Insurer Intake Agent. The service reads them from its settings. This folder never fills in a limit that is missing. */
  readonly limits: HireLimits;
  /**
   * The decision `accept_delivery`: the model compares the hash of the request that this agent sent (`sent`) with the hash that the intake record names (`received`). Both sides hold a request number and a hash and
   * nothing else. The job asks only after it checked in code that the record is an intake record, that it names the number of the request that was sent, and that it names this agent as the sender.
   */
  readonly acceptDelivery: (sent: RequestSide, received: RequestSide) => Promise<AcceptAnswer>;
  /** The challenge of a delivery that the model did not accept. */
  readonly dispute: Pick<Dispute, 'challengeDelivery'>;
  /** The key hashes of the delegation keys of this agent. The escrow of a hire that was paid from a vault names one of them as its buyer. */
  readonly buyerPkhs: readonly string[];
  /** This agent: its DID, and the Ed25519 authentication key that signs the subject token of a token request. */
  readonly agent: { readonly did: Did; readonly authenticationKey: KeyInput };
  readonly tokens: TokenDeps;
  readonly calls: CallDeps;
  /** The fault switch of the process. The job reads `mode` one time and nothing else of it. */
  readonly fault: FaultSwitch<'prior-authorization-agent'>;
  /** One line for each step. A line has codes and references of the chain, and no key, token or part of a request. A function that throws changes no result. */
  readonly log: (line: string) => void;
}
