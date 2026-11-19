// scripts/checks/lib/hire-types.ts - the one door between the vault checks (2 and 3) and the hire kit. A `HirePort` does the work of the kit that the checks need, and each transaction that
// it makes must go through `session.land` of the check, so that the guards of the check see the transaction before it is signed. The vault checks use nothing of the kit but this type.
// A port gives back what the check records. It throws an Error for a hire that did not end as it must, and the message says why.

/** A hire of an agent that pays from a vault, sends the job, verifies the receipt, and accepts. */
export interface VaultHireRequest {
  advertRef: string;
  /** The text that the agent reads. */
  payload: string;
  /** The vault output that pays. */
  vaultRef: string;
}

export interface VaultHired {
  escrowRef: string;
  /** The vault output that continues after the payment. */
  vaultRef: string;
  payTxHash: string;
  acceptTxHash: string;
  /** The units that the escrow locked: the price and both bonds. */
  lockLovelace: bigint;
  /** The text that the agent gave back. */
  text: string;
}

export interface VaultPaid {
  escrowRef: string;
  /** The vault output that continues after the payment. */
  vaultRef: string;
  txHash: string;
  lockLovelace: bigint;
  /** POSIX ms: the escrow can be reclaimed after this time. */
  deliverBy: number;
}

export interface VaultReclaimed {
  txHash: string;
  /** The vault output that holds the returned lock, as the ledger shows it. */
  returnedRef: string;
}

export interface HirePort {
  /** Check 2: pays the advert from the vault, sends the job, verifies the receipt, and accepts it with the delegate key. */
  hire(request: VaultHireRequest): Promise<VaultHired>;
  /** Check 3: pays the advert from the vault and sends no job. */
  pay(request: { advertRef: string; vaultRef: string }): Promise<VaultPaid>;
  /** Check 3: reclaims an escrow that nobody claimed, after its deliver_by. The lock returns to the vault as a Returned output. */
  reclaim(escrowRef: string): Promise<VaultReclaimed>;
}
