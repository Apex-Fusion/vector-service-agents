// agents/reorder-agent/src/propose/ports.ts
// What `runPropose` needs from the outside, as ports: functions and plain values. The service joins them to the real chain, gateway, ledger reads, model and files, and a test gives its own. This folder does
// not import the model, execute or serve folders of the agent. The reader of the supplier, the parser of the stock reading and the model decision come in as functions, and the kit gives the types of the rest.
import type { KeyInput } from '@vsa/id-kit/client';
import type { CallDeps, Clock, LeftSubDelegation, SerialQueue, SubDelegationDeps, TokenDeps, TxSigner } from '@vsa/usecase-kit/access';
import type { LedgerReads } from '@vsa/usecase-kit/buyer';
import type { LotName } from '@vsa/usecase-kit/inventory';
import type { Decision, DelegationId, Did, Document, OutputRef, ProposeRequest as ProtocolProposeRequest, ProtocolResult } from '@vsa/usecase-kit/protocol';
import type { PoCounter } from './counter.ts';

/** A `propose` request of the Reorder Agent: the members of the protocol, the SKU to reorder, and the supplier whose Order Desk takes the order. */
export type ProposeRequest = ProtocolProposeRequest<{ readonly sku: string; readonly supplier_did: Did }>;

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
 * The list of left sub-delegations, as far as a run uses it. `LeftStore` of the janitor folder of the kit has these three methods. `list` gives every entry, and it rejects when the list cannot be read: a run that
 * cannot read the list sends nothing. `put` stores the entry before the Delegate is sent, and it replaces the entry of an id that it holds, so a run reads the list first and never puts an entry with an id that
 * the list holds. `remove` of an id that is not there is not an error.
 */
export interface LeftSink {
  list(): Promise<readonly LeftEntry[]>;
  put(entry: LeftEntry): Promise<void>;
  remove(id: DelegationId): Promise<void>;
}

/**
 * The sub-delegations that a run of this process still uses. The janitor skips an entry whose id is in the set, because a pass during the wait for 30 confirmations would end the sub-delegation of a job that
 * still runs. A run adds the id before it writes the entry, and it deletes the id after it updated the entry.
 */
export interface InFlight {
  add(id: DelegationId): void;
  delete(id: DelegationId): void;
}

/** What the reader of the supplier gives for the SKU of the request: the advert of the Order Desk of each lot, and the size of each lot. */
export interface SupplierRead {
  readonly adverts: Record<LotName, { readonly advert_ref: OutputRef }>;
  readonly lots: Record<LotName, number>;
}

/** The lot that the model chose, as the decision `reorder` gives it. The agent keeps it as it is: it clamps nothing and computes nothing again. */
export interface ReorderChoice {
  readonly lot: LotName;
  readonly quantity: number;
  readonly needed_by: string;
}

/**
 * The decision `reorder`: the decision with its receipt and the choice that it holds, or the code of the failure. A failure holds no decision. `choice` must be the choice that `decision.choice` records, with the
 * same members and the same values: `runPropose` builds the order from `choice` only when the two are equal, and it fails with `decision_mismatch` when they differ.
 */
export type ReorderAnswer = { readonly ok: true; readonly decision: Decision; readonly choice: ReorderChoice } | { readonly ok: false; readonly code: string };

/**
 * Everything that `runPropose` reads or does outside its own code. Each failure of a port is a typed result of the job, and no port gets a retry.
 * - `agent.did` is the DID that the delegation of the hirer names as its delegate.
 * - `subagent` is `stock-reader`: its DID, the authentication key that signs its subject token, its delegation key (the delegate key of the sub-delegation, and the key of the DPoP proof of its token), and the
 *   signer of that same delegation key.
 * - `reads` is the ledger reads of the kit. Its reading of a delegation holds the delegate and whether the chain is whole, and not the delegate key.
 * - `delegateKeyOf` gives the hash of the delegate key of the delegation, `null` when the ledger shows no such delegation, and rejects when the ledger cannot be read. `delegationKeys.find` gives the key of
 *   this agent with that hash, or `null`.
 * - `subDelegation` is the chain, the clock, the delegation script and the bases of the mock service. The wallet queue and the hook before the send come from this folder.
 * - `tokens` is the client of the gateway, `calls` is the fetch and the bases of the mock service, and `clock` is the clock of the job.
 * - `leftSink` and `inFlight` are the list of left sub-delegations and the set of the ids that a run still uses.
 * - `readSupplier` reads the Order Desk of the supplier for the SKU. `parseStock` reads the body that the ERP gave. `reorder` asks the model for a lot.
 * - `counter` gives the number of the purchase order.
 */
export interface ProposeDeps {
  readonly agent: { readonly did: Did };
  readonly subagent: { readonly did: Did; readonly authenticationKey: KeyInput; readonly delegationKey: KeyInput; readonly signer: TxSigner };
  readonly reads: LedgerReads;
  readonly delegateKeyOf: (id: DelegationId) => Promise<string | null>;
  readonly delegationKeys: { find(keyHash: string): DelegationKey | null };
  readonly subDelegation: Omit<SubDelegationDeps, 'walletQueue' | 'beforeSend'>;
  readonly tokens: TokenDeps;
  readonly calls: CallDeps;
  readonly clock: Clock;
  readonly leftSink: LeftSink;
  readonly inFlight: InFlight;
  readonly readSupplier: (supplier: Did, sku: string) => Promise<ProtocolResult<SupplierRead, string>>;
  readonly parseStock: (body: unknown) => ProtocolResult<Document>;
  readonly reorder: (reading: Document, lots: Record<LotName, number>) => Promise<ReorderAnswer>;
  readonly counter: PoCounter;
}
