// scripts/checks/lib/hire-types.ts - the one door between the vault checks (2 and 3) and the hire kit. A `HirePort` does the work of the kit that the checks need, and each transaction that
// it makes goes through `session.land` of the check, so that the guards of the check see the transaction before it is signed. The vault checks use nothing of the kit but this file.
// A port gives back what the check records. It throws a `HireFailed` for a hire that did not end as it must, and the message says why. An error that follows a confirmed Pay carries the
// escrow and the vault output that continues. An error that follows a Pay that was sent and not seen confirmed carries the escrow and no vault output: the vault is then read again
// from the chain. A `DryStop` is not a failure: a dry run built and checked the first transaction of the call and signed nothing.

/**
 * The three limits of a hire. The buyer funds the price and both bonds, so the ceiling on the price alone does not bound what a hire pays. Each is a bigint or `null`, and `null` means
 * that the kit takes no limit. The kit compares each with the value in the advert (the price, the supplier bond, the buyer bond), and not with the output that the builder makes, which also
 * holds the ledger minimum.
 */
export interface HireLimits {
  maxPriceLovelace: bigint | null;
  maxSupplierBondLovelace: bigint | null;
  maxBuyerBondLovelace: bigint | null;
}

/** A hire of an agent that pays from a vault, sends the job, verifies the receipt, and accepts. */
export interface VaultHireRequest extends HireLimits {
  advertRef: string;
  /** The text that the agent reads. */
  payload: string;
  /** The vault output that pays. */
  vaultRef: string;
}

export interface VaultPayRequest extends HireLimits {
  advertRef: string;
  vaultRef: string;
}

export interface VaultHired {
  escrowRef: string;
  /** The vault output that continues after the payment. */
  vaultRef: string;
  payTxHash: string;
  acceptTxHash: string;
  /** The units that the escrow locked: the price, both bonds and the ledger minimum of the output. */
  lockLovelace: bigint;
  /** The text that the agent gave back. */
  text: string;
  /** The Returned output that the Accept left in the vault with the buyer bond, or null when the Accept returned nothing to a vault. */
  returnedRef: string | null;
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
  reclaim(escrow: { escrowRef: string; deliverBy: number }): Promise<VaultReclaimed>;
}

/** A dry run reached the first transaction of a call: it was built and checked, and nothing was signed. */
export class DryStop extends Error {
  readonly step: string;
  constructor(step: string) {
    super(`dry run: the transaction of ${step} was built and checked, and nothing was signed`);
    this.name = 'DryStop';
    this.step = step;
  }
}

/** How a hire ended when it did not end well. `failed_after_claim` means that the agent may hold the job: the escrow may be claimed, so the hire is never made again. */
export type HireFailureKind = 'refused_before_claim' | 'failed_after_claim' | 'not_accepted' | 'vault_refused' | 'other';

/**
 * What an error says of a Pay: its escrow, the vault output that continues (null when a Pay was sent and not seen confirmed), and the deliver_by and the lock when they are known. For a Pay that
 * was sent and not seen confirmed it also says the vault output that continues if the Pay lands, whether it may still land, and until when (POSIX ms): until then no other Pay starts from the
 * old reference, and after it the vault is read again from the chain.
 */
export interface AfterPay {
  escrowRef: string;
  vaultRef: string | null;
  deliverBy: number | null;
  lockLovelace: bigint | null;
  vaultRefIfLanded?: string | null;
  mayLand?: boolean | null;
  validTo?: number | null;
}

/** The error of a hire that did not end well. It holds what it knows of the Pay, or null when no Pay was made. */
export class HireFailed extends Error {
  readonly kind: HireFailureKind;
  readonly after: AfterPay | null;

  constructor(kind: HireFailureKind, message: string, after: AfterPay | null = null) {
    super(message);
    this.name = 'HireFailed';
    this.kind = kind;
    this.after = after;
  }
}
