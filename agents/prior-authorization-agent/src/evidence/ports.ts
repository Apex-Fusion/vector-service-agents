// agents/prior-authorization-agent/src/evidence/ports.ts
// What `readEvidence` needs from the outside, as ports: functions and plain values. The service joins them to the real chain, gateway, mock systems and files, and a test gives its own. This folder does not
// import the model, propose, execute or serve folders of the agent. The parsers of the two documents come in as functions, and the kit gives the types of the rest.
import type { KeyInput } from '@vsa/id-kit/client';
import type { CallDeps, Clock, LeftSubDelegation, SerialQueue, SubDelegationDeps, TokenDeps, TxSigner } from '@vsa/usecase-kit/access';
import type { Guideline, RecordSet } from '@vsa/usecase-kit/priorauth';
import type { DelegationId, Did, ProtocolResult } from '@vsa/usecase-kit/protocol';

/** The two subagents of the evidence. The log names a read by the name of its subagent. */
export type SubagentName = 'record-reader' | 'drafter';

/**
 * A subagent of this agent: its DID, the authentication key that signs its subject token, its delegation key (the delegate key of its sub-delegation, and the key of the DPoP proof of its token), and the
 * signer of that same delegation key.
 */
export interface Subagent {
  readonly did: Did;
  readonly authenticationKey: KeyInput;
  readonly delegationKey: KeyInput;
  readonly signer: TxSigner;
}

/** A delegation key of this agent that the service holds. A delegation names one of them as its delegate key. */
export interface DelegationKey {
  /** The signer of the key. It signs the Delegate and the Undelegate of a sub-delegation, and its hash is the delegate key of the delegation of the hirer. */
  readonly signer: TxSigner;
  /** The address of the wallet of the key. The wallet pays the fees of the sub-delegation and gets its deposit back. */
  readonly walletAddress: string;
  /** The queue of the wallet: the one object that holds every transaction of this key, also those of the hires and of the janitor. */
  readonly queue: SerialQueue;
}

/** A left sub-delegation and the key that ends it: the hash of the delegation key of this agent, which signs the Undelegate. `LeftEntry` of the janitor folder of the kit has the same two members. */
export interface LeftEntry {
  readonly left: LeftSubDelegation;
  readonly signer_key_hash: string;
}

/**
 * The list of left sub-delegations, as far as a read uses it. `LeftStore` of the janitor folder of the kit has these three methods. `list` gives every entry. It rejects when the list cannot be read, and a read
 * that cannot read the list sends nothing. It rejects with `DamagedLeftEntriesError` of the janitor folder when a file of the list is damaged: the read then goes on with the entries that the error carries,
 * unless a damaged file has the name `<id>.json` of its own sub-delegation. The read has a bound of 20 seconds in the run. `put` stores the entry before the Delegate is sent, and it replaces the entry of an
 * id that it holds, so a read lists first and never puts an entry with an id that the list holds. `remove` of an id that is not there is not an error. The service gives the one list to the reads and to the
 * janitor.
 */
export interface LeftSink {
  list(): Promise<readonly LeftEntry[]>;
  put(entry: LeftEntry): Promise<void>;
  remove(id: DelegationId): Promise<void>;
}

/**
 * The sub-delegations that a read of this process still uses. The janitor skips an entry whose id is in the set, because a pass during the wait for 30 confirmations would end the sub-delegation of a job that
 * still runs. A read adds the id before it writes the entry, and it deletes the id after it updated the entry.
 */
export interface InFlight {
  add(id: DelegationId): void;
  delete(id: DelegationId): void;
}

/**
 * Everything that `readEvidence` reads or does outside its own code. Each failure of a port is a typed result of the read, and no port gets a retry.
 * - `subagents.record_reader` reads the order and its record set. `subagents.drafter` reads the guideline of the service of that order. Each has its own keys, its own sub-delegation and its own token.
 * - `subDelegation` is the chain, the clock, the delegation script and the bases of the mock service. The wallet queue and the hook before the send come from this folder.
 * - `tokens` is the client of the gateway, `calls` is the fetch and the bases of the mock service, and `clock` is the clock of the job.
 * - `leftSink` and `inFlight` are the list of left sub-delegations and the set of the ids that a read still uses.
 * - `parseRecordSet` and `parseGuideline` read the bodies that the two systems gave. They return a checked copy, or a refusal.
 * - `log` gets one line for each read that fails, and one line for each read that a check stops before its Delegate is sent, with the cause. Each line names the subagent. A line has codes and references of
 *   the chain, and no key, token or part of a record. A function that throws changes no result.
 */
export interface EvidenceDeps {
  readonly subagents: { readonly record_reader: Subagent; readonly drafter: Subagent };
  readonly subDelegation: Omit<SubDelegationDeps, 'walletQueue' | 'beforeSend'>;
  readonly tokens: TokenDeps;
  readonly calls: CallDeps;
  readonly clock: Clock;
  readonly leftSink: LeftSink;
  readonly inFlight: InFlight;
  readonly parseRecordSet: (body: unknown) => ProtocolResult<RecordSet>;
  readonly parseGuideline: (body: unknown) => ProtocolResult<Guideline>;
  readonly log: (line: string) => void;
}

/**
 * What one job asks the evidence for: the tenant, the order, the delegation that the hirer gave to this agent, and the delegation key of this agent that the delegation names as its delegate. The key makes
 * and ends the two sub-delegations, which are one hop below the delegation of the hirer.
 */
export interface EvidenceRequest {
  readonly tenant: string;
  readonly order_id: string;
  readonly delegation: DelegationId;
  readonly key: DelegationKey;
}

/** The time and the caller of one call of the evidence. `deadline` is a time of the clock of the deps in milliseconds. `signal` aborts when the caller hangs up. */
export interface EvidenceRun {
  readonly deadline: number;
  readonly signal?: AbortSignal;
}

/** The record set of the order and the guideline of its service, or the code of the failure. A failure holds no part of the evidence. */
export type EvidenceResult = { readonly ok: true; readonly record_set: RecordSet; readonly guideline: Guideline } | { readonly ok: false; readonly code: string };
