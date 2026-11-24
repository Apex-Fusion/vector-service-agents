// scripts/checks/lib/ports.ts - what the checks need from the world outside the process, as small interfaces. A real check gets the real ones (the node of Vector, the hosted MCP server,
// the clock). A test gets fakes, so that no test touches a network.
import type { Utxo } from './platform.ts';

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

/** What a node says about its network: the magic of its genesis and the time of its slot 0 (POSIX ms; null when the node does not say). */
export interface NetworkFacts {
  magic: number;
  systemStartMs: number | null;
}

/** What the indexer says about a transaction. `confirmations` is null when it does not know the transaction. */
export interface TxStatus {
  confirmations: number | null;
}

/** What the node says of its chain: the slot of its newest block. */
export interface NodeTip {
  slot: number;
}

/** The node: the facts of its network, the outputs of the ledger, and the way in and out of a transaction. */
export interface NodeAccess {
  networkFacts(): Promise<NetworkFacts>;
  /** The outputs at these references, from the ledger. A reference that is not unspent is left out. */
  resolveInputs(refs: readonly string[]): Promise<Utxo[]>;
  submit(signedCborHex: string): Promise<string>;
  txStatus(txHash: string): Promise<TxStatus>;
  /**
   * The tip of the chain as this node sees it: the slot of its newest block. The node answers every other question from its view at that tip, so a tip before a slot means that the node may not have
   * seen a block of that slot yet. A node that cannot say gives an error, and never a guess.
   */
  networkTip(): Promise<NodeTip>;
}

/** Signs for the keys that the operator gave. */
export interface Signer {
  has(keyHash: string): boolean;
  /** Adds the witness of the key to the transaction and gives the signed transaction as hex. */
  sign(keyHash: string, cborHex: string): string;
}

/** The two streams of a script. The report goes to `out`, a refusal and a warning to `err`. */
export interface Output {
  out(line: string): void;
  err(line: string): void;
}
