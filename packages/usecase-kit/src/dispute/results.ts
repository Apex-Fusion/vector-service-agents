// packages/usecase-kit/src/dispute/results.ts
// The typed results of the dispute steps. A success is `{ ok: true, value }`. A failure is `{ ok: false, code, detail }` and it says what landed before the step failed: a document that is
// published, or a transaction that was sent and not seen confirmed. No caller reads success from a text.
import { NO_OPEN_CLAIM } from '../protocol/index.ts';
import type { Accepted, ChallengeRecord, Did, OutputRef, Refused } from '../protocol/index.ts';
import type { DocumentCode } from './documents.ts';

/** The codes of a lookup of the open claim of an agent. `no_open_claim` is the reason of a dispute that files no challenge because the other party has no open claim. */
export type ClaimLookupCode = 'bad_shape' | typeof NO_OPEN_CLAIM | 'chain_unavailable';

/** A document that landed: its transaction is confirmed. */
export interface DocumentLanded {
  readonly tx_hash: string;
  readonly uri: string;
  /** The blake2b-256 hash of the document. */
  readonly document_hash: string;
}

/** A transaction that was sent and was not seen confirmed. `may_land` is false only when it certainly never reached the node. Otherwise it can land, and only before `valid_to`. */
export interface SentNotConfirmed {
  readonly tx_hash: string;
  /** POSIX milliseconds. */
  readonly valid_to: number;
  readonly may_land: boolean;
}

// --- The challenge ----------------------------------------------------------------------------------------------------------------------------------------------------

export type ChallengeCode =
  | ClaimLookupCode
  | DocumentCode
  | 'same_agent'
  | 'job_already_disputed'
  | 'journal_unavailable'
  | 'claim_window_closing'
  | 'evidence_not_built'
  | 'evidence_not_confirmed'
  | 'claim_changed'
  | 'challenge_not_built'
  | 'challenge_not_confirmed'
  | 'challenge_wrong_claim'
  | 'port_error';

/** A challenge that is filed: the evidence is on chain, and the challenge is confirmed against the open claim of the other party. */
export interface ChallengeFiled {
  /** The claim output that was challenged, the transaction that published the evidence, and the challenge output. */
  readonly record: ChallengeRecord;
  readonly claim_token: string;
  /** The claimer: the other party. */
  readonly against_did: Did;
  readonly evidence_uri: string;
  /** The blake2b-256 hash of the evidence document. */
  readonly evidence_hash: string;
  readonly challenge_tx: string;
  readonly challenge_token: string;
  readonly stake_lovelace: bigint;
  /** POSIX milliseconds: the end of the time that the oracle and the jury have to resolve the challenge. */
  readonly deadline: number;
  /** The fees of the evidence transaction and the challenge transaction. It is null for a challenge that this agent filed earlier and that the code found again, from the chain: its fees are not known. */
  readonly fee_lovelace: bigint | null;
  /**
   * The transaction of an evidence document that this job published and that this challenge does not name, or null. A job that goes on after a lapsed record can publish the evidence document of its second try, and then find
   * that the challenge of the first try is on chain: that challenge names the document of the first try. The document of the second try is on chain, and its fee is paid, so the result names it. `fee_lovelace` does not
   * include that fee. It is null when the job published no other document.
   */
  readonly extra_evidence: string | null;
}

/** A challenge transaction that landed against another claim than the one that the evidence names. It is on chain, and it is not the challenge that the job wanted. */
export interface ChallengeLanded {
  readonly tx_hash: string;
  readonly challenge: OutputRef;
  readonly challenge_token: string;
  /** The claim output that the transaction spent. */
  readonly claim: OutputRef;
  readonly claim_token: string;
}

/**
 * A challenge that is not filed. Each member that is not null names a transaction that landed or may land before the step failed: `evidence` is the evidence document, `sent` a transaction that was sent
 * and not seen confirmed, `challenge` a challenge transaction that landed against another claim than the one that the evidence names, and `wrong_document` a document transaction that landed with
 * another hash than the evidence document.
 */
export interface ChallengeNotFiled extends Refused<ChallengeCode> {
  readonly evidence: DocumentLanded | null;
  readonly sent: SentNotConfirmed | null;
  readonly challenge: ChallengeLanded | null;
  readonly wrong_document: DocumentLanded | null;
}

export type ChallengeResult = Accepted<ChallengeFiled> | ChallengeNotFiled;

/** The members of an `execute` result that a dispute decides: the outcome, the reason, the challenge and the exit state. */
export type DisputeOutcome =
  | { readonly outcome: 'disputed'; readonly reason: null; readonly challenge: ChallengeRecord; readonly exit_state: 'Escalated' }
  | { readonly outcome: 'disputed'; readonly reason: string; readonly challenge: null; readonly exit_state: 'Failed' };

/**
 * The members of the `disputed` result for a challenge result. A challenge that is filed gives `Escalated` with its record. Any other result gives `Failed` with the code of the step that
 * failed as the reason, and no challenge: `no_open_claim` when the other party has no open claim.
 */
export function disputedFields(result: ChallengeResult): DisputeOutcome {
  if (result.ok) return { outcome: 'disputed', reason: null, challenge: result.value.record, exit_state: 'Escalated' };
  return { outcome: 'disputed', reason: result.code, challenge: null, exit_state: 'Failed' };
}

// --- The claim of a run -----------------------------------------------------------------------------------------------------------------------------------------------

export type RunClaimCode =
  | 'bad_shape'
  | 'document_too_large'
  | 'claim_document_not_built'
  | 'claim_document_not_confirmed'
  | 'claim_not_built'
  | 'claim_not_confirmed'
  | 'port_error';

/** A claim that is staked: its document is on chain, and the claim output holds the stake. */
export interface RunClaimStaked {
  readonly claim: OutputRef;
  readonly claim_token: string;
  readonly document: DocumentLanded;
  readonly stake_lovelace: bigint;
  readonly challenge_window_ms: number;
  readonly submitted_at: number;
  /** The last moment of the challenge window. A withdrawal starts after it. */
  readonly challenge_deadline: number;
  readonly claim_tx: string;
  /** The fees of the document transaction and the claim transaction. */
  readonly fee_lovelace: bigint;
}

/** A claim that is not staked. `document` is the claim document that landed before the step failed, `sent` a transaction that was sent and not seen confirmed, and `wrong_document` a document transaction that landed with another hash than the claim document. */
export interface RunClaimNotStaked extends Refused<RunClaimCode> {
  readonly document: DocumentLanded | null;
  readonly sent: SentNotConfirmed | null;
  readonly wrong_document: DocumentLanded | null;
}

export type RunClaimResult = Accepted<RunClaimStaked> | RunClaimNotStaked;

// --- The withdrawal ---------------------------------------------------------------------------------------------------------------------------------------------------

export type WithdrawCode =
  | 'bad_shape'
  | 'chain_unavailable'
  | 'claim_not_open'
  | 'not_claimer'
  | 'window_not_ended'
  | 'withdraw_not_built'
  | 'withdraw_not_confirmed'
  | 'port_error';

export interface ClaimWithdrawn {
  /** The claim output that the transaction spent. */
  readonly claim: OutputRef;
  readonly claim_token: string;
  /** The output that paid the stake back to the wallet. */
  readonly payout: OutputRef;
  readonly stake_lovelace: bigint;
  readonly withdraw_tx: string;
  readonly fee_lovelace: bigint;
}

export interface WithdrawNotDone extends Refused<WithdrawCode> {
  readonly sent: SentNotConfirmed | null;
}

export type WithdrawResult = Accepted<ClaimWithdrawn> | WithdrawNotDone;
