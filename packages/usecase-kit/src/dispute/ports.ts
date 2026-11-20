// packages/usecase-kit/src/dispute/ports.ts
// What the dispute code needs from the outside: the chain, the queue of the service key and the clock.
//
// The chain port reads the claims of Module-1 and lands four kinds of transaction: a document, a claim, a challenge and a withdrawal. A port method that lands a transaction never throws for a
// problem of the build, the signature or the submit. It returns a typed result that says what happened, and what could still land. The real port is `createModule1Port` (chain.ts). A test can
// give a scripted port, or the real port over the fixture world of the buyer code.
import type { ClaimState } from '@vsa/buyer-core';
import type { Accepted, Did, OutputRef, Refused } from '../protocol/index.ts';

/** A live claim output of Module-1, as the chain port reads it. */
export interface ClaimView {
  /** The output that holds the claim. The claim moves to a new output when a challenge starts. */
  readonly ref: OutputRef;
  /** The claim token: 64 lower-case hex characters. It names the claim for as long as the claim lives. */
  readonly token: string;
  readonly claimer: Did;
  /** The key hash of the claimer credential (56 lower-case hex characters), or null when the credential is a script. Only this key can withdraw the claim. */
  readonly claimer_key_hash: string | null;
  readonly state: ClaimState;
  readonly stake_lovelace: bigint;
  /** POSIX milliseconds. */
  readonly submitted_at: number;
  readonly challenge_window_ms: number;
}

/** The last moment of the challenge window of a claim, in POSIX milliseconds. A challenge must start before it, and a withdrawal after it. */
export const challengeDeadlineOf = (claim: Pick<ClaimView, 'submitted_at' | 'challenge_window_ms'>): number => claim.submitted_at + claim.challenge_window_ms;

/** The earliest moment of a withdrawal: the first whole second after the challenge window, in POSIX milliseconds. Module-1 needs the start of the transaction strictly after the window. */
export const withdrawableFrom = (claim: Pick<ClaimView, 'submitted_at' | 'challenge_window_ms'>): number => Math.ceil((challengeDeadlineOf(claim) + 1) / 1000) * 1000;

/** A transaction that was not signed and not sent: the build or a check of the build refused it. Nothing landed, and nothing can land. */
export type TxNotBuilt = Refused<'not_built'>;

/**
 * A transaction that was signed and not seen confirmed. `may_land` is false only when the transaction certainly never reached the node. Otherwise it can still land, and only before
 * `valid_to` (POSIX milliseconds).
 */
export interface TxNotConfirmed extends Refused<'not_confirmed'> {
  readonly tx_hash: string;
  readonly valid_to: number;
  readonly may_land: boolean;
}

/** The result of a transaction: confirmed with its value, not built, or not confirmed. */
export type TxResult<T> = Accepted<T> | TxNotBuilt | TxNotConfirmed;

/** A document that is on chain, as label metadata of a transaction. */
export interface PublishedDocument {
  readonly tx_hash: string;
  /** The `vector-tx:` URI of the document. */
  readonly uri: string;
  /** The blake2b-256 hash of the bytes of the document. */
  readonly document_hash: string;
  readonly fee_lovelace: bigint;
}

export interface SubmittedClaim {
  readonly tx_hash: string;
  readonly claim: OutputRef;
  readonly claim_token: string;
  readonly stake_lovelace: bigint;
  readonly submitted_at: number;
  readonly challenge_window_ms: number;
  readonly fee_lovelace: bigint;
}

export interface OpenedChallenge {
  readonly tx_hash: string;
  readonly challenge: OutputRef;
  readonly challenge_token: string;
  /** The claim output that the transaction spent. */
  readonly claim: OutputRef;
  readonly claim_token: string;
  readonly stake_lovelace: bigint;
  /** POSIX milliseconds: the end of the time that the oracle and the jury have to resolve the challenge. */
  readonly deadline: number;
  readonly fee_lovelace: bigint;
}

export interface WithdrawnClaim {
  readonly tx_hash: string;
  /** The claim output that the transaction spent. */
  readonly claim: OutputRef;
  readonly claim_token: string;
  /** The output that pays the stake back to the wallet. */
  readonly payout: OutputRef;
  readonly stake_lovelace: bigint;
  readonly fee_lovelace: bigint;
}

export interface PublishCall {
  readonly bytes: Uint8Array;
  readonly type: 'claim' | 'evidence';
  readonly media_type: string;
}

export interface SubmitClaimCall {
  /** The blake2b-256 hash of the claim document, from the port that published it. */
  readonly claim_hash: string;
  /** The URI of the claim document. */
  readonly claim_uri: string;
  readonly claim_type: string;
  readonly stake_lovelace: bigint;
  readonly challenge_window_ms: number;
}

export interface OpenChallengeCall {
  /** The claim output to challenge. The port builds against this output and no other. */
  readonly claim: OutputRef;
  readonly claim_token: string;
  readonly evidence_hash: string;
  readonly evidence_uri: string;
  readonly stake_lovelace: bigint;
  readonly resolution_deadline_ms: number;
}

export interface WithdrawClaimCall {
  readonly claim: OutputRef;
  readonly claim_token: string;
}

/** The chain, as the dispute code uses it. Every transaction method takes the wallet of the service key and spends it: call it inside the queue of that key. */
export interface Module1Port {
  /** The agent that the key acts for: its DID, and the hash of the key. */
  readonly agent: { readonly did: Did; readonly key_hash: string };
  /** Every live claim output at the claim script, whatever its state. It throws when the chain cannot be read. */
  readClaims(): Promise<readonly ClaimView[]>;
  /** The live claim output at `ref`, or null when the output is spent, or is not a claim output. It throws when the chain cannot be read. */
  readClaim(ref: OutputRef): Promise<ClaimView | null>;
  publishDocument(call: PublishCall): Promise<TxResult<PublishedDocument>>;
  submitClaim(call: SubmitClaimCall): Promise<TxResult<SubmittedClaim>>;
  openChallenge(call: OpenChallengeCall): Promise<TxResult<OpenedChallenge>>;
  withdrawClaim(call: WithdrawClaimCall): Promise<TxResult<WithdrawnClaim>>;
}

/**
 * The queue of the service key. The key has one wallet, and a Module-1 build spends every output of it but one, so a transaction must not run beside a hire or another Module-1 step.
 * `HireLane` of the hire kit is such a queue. A job runs when every job before it has ended.
 */
export interface ServiceQueue {
  run<T>(job: () => Promise<T>): Promise<T>;
}
