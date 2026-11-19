// scripts/checks/lib/hire-types.ts - the one door between the vault checks (2 and 3) and the hire kit. A `HirePort` does the work of the kit that the checks need, and each transaction that
// it makes must go through `session.land` of the check, so that the guards of the check see the transaction before it is signed. The vault checks use nothing of the kit but this file.
// A port gives back what the check records. It throws a `HireFailed` for a hire that did not end as it must, and the message says why. An error that follows a confirmed Pay carries the
// escrow and the vault output that continues, so that the state file can keep them.

/** The two limits of a hire on the bonds of the escrow. The buyer funds the price and both bonds. `null` means that the kit takes no limit. */
export interface BondLimits {
  maxSupplierBondLovelace: bigint | null;
  maxBuyerBondLovelace: bigint | null;
}

/** A hire of an agent that pays from a vault, sends the job, verifies the receipt, and accepts. */
export interface VaultHireRequest extends BondLimits {
  advertRef: string;
  /** The text that the agent reads. */
  payload: string;
  /** The vault output that pays. */
  vaultRef: string;
}

export interface VaultPayRequest extends BondLimits {
  advertRef: string;
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
  pay(request: VaultPayRequest): Promise<VaultPaid>;
  /** Check 3, or check 2 after a hire that stopped: reclaims an escrow that nobody claimed, after its deliver_by. The lock returns to the vault as a Returned output. */
  reclaim(escrowRef: string): Promise<VaultReclaimed>;
}

/** How a hire ended when it did not end well. `failed_after_claim` means that the agent may hold the job: the escrow may be claimed, so the hire is never made again. */
export type HireFailureKind = 'refused_before_claim' | 'failed_after_claim' | 'not_accepted' | 'vault_refused' | 'other';

/** The error of a hire that did not end well. After a confirmed Pay it holds the escrow and the vault output that continues (else both are null). */
export class HireFailed extends Error {
  readonly kind: HireFailureKind;
  readonly escrowRef: string | null;
  readonly vaultRef: string | null;
  readonly deliverBy: number | null;
  readonly lockLovelace: bigint | null;

  constructor(kind: HireFailureKind, message: string, after: { escrowRef: string; vaultRef: string; deliverBy: number | null; lockLovelace: bigint | null } | null = null) {
    super(message);
    this.name = 'HireFailed';
    this.kind = kind;
    this.escrowRef = after?.escrowRef ?? null;
    this.vaultRef = after?.vaultRef ?? null;
    this.deliverBy = after?.deliverBy ?? null;
    this.lockLovelace = after?.lockLovelace ?? null;
  }
}
