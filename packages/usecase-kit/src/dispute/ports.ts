// packages/usecase-kit/src/dispute/ports.ts
// What the dispute code needs from the outside: the chain, the queue of the service key and the clock.
//
// The chain port reads the claims and the challenges of Module-1, the documents that they name, and the job of an escrow output: the time of the block that holds its transaction, which is the start of the job. It lands four kinds of transaction: a document, a claim, a challenge and a withdrawal. A port
// method that lands a transaction never throws for a problem of the build, the signature or the submit. It returns a typed result that says what happened, and what could still land. A read throws
// when the chain cannot be read, and it never answers with a list that leaves a claim out. The real port is `createModule1Port` (chain.ts). A test can give a scripted port, or the real port over the
// fixture world of the buyer code.
import type { ChallengeState, ClaimState } from '@vsa/buyer-core';
import type { Accepted, Did, OutputRef, Refused } from '../protocol/index.ts';

/** The most bytes of a claim type: the limit of `buildSubmitClaim` of the buyer code, which refuses a type of 0 bytes and a type of more than 64 bytes. */
export const MAX_CLAIM_TYPE_BYTES = 64;

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
  /** The hash of the claim document that the claim holds, in lower-case hex. It is a blake2b-256 hash of 64 characters when the claim is a claim of this kit. */
  readonly claim_hash: string;
  /** The claim type that the claim holds, read as text. */
  readonly claim_type: string;
  /** The address of the claim document that the claim holds: a `vector-tx:` URI for a claim of this kit. */
  readonly claim_uri: string;
}

/** A live challenge output of Module-1, as the chain port reads it. */
export interface ChallengeView {
  /** The output that holds the challenge. */
  readonly ref: OutputRef;
  /** The challenge token: 64 lower-case hex characters. */
  readonly token: string;
  /** The claim output that the challenge spent. */
  readonly claim: OutputRef;
  readonly claim_token: string;
  /** The challenger. */
  readonly auditor: Did;
  /** The key hash of the auditor credential (56 lower-case hex characters), or null when the credential is a script. */
  readonly auditor_key_hash: string | null;
  readonly stake_lovelace: bigint;
  /** The hash of the evidence document that the challenge holds, in lower-case hex. */
  readonly evidence_hash: string;
  /** The address of the evidence document that the challenge holds, read as text. */
  readonly evidence_uri: string;
  /** POSIX milliseconds. */
  readonly challenged_at: number;
  readonly resolution_deadline_ms: number;
  readonly state: ChallengeState['type'];
}

/** A document that the port read from the chain: its bytes, and the type and the media type that its metadata names. */
export interface ReadDocument {
  readonly bytes: Uint8Array;
  readonly type: string | null;
  readonly media_type: string | null;
}

/**
 * Why a read of a document found none although the source answered. `transaction_unknown`: the source does not have the transaction at the address, and it can be behind. `no_document`: the source has
 * the transaction, and the transaction carries no document that the reader can use: it has no metadata of the label of the documents, or no metadata that holds JSON, or a value that is not a document, or
 * a form that the reader refuses (CBOR that does not decode). The sender of an address can cause both, so the dispute code never takes them for a failure of the source.
 */
export type DocumentAbsent = Refused<'transaction_unknown' | 'no_document'>;

/** The result of a read of a document: the document, or the reason that the source, which answered, has none. A read that gets no answer throws. */
export type DocumentResult = Accepted<ReadDocument> | DocumentAbsent;

/** What the port reads about the job that an escrow output stands for. */
export interface EscrowJob {
  /**
   * The start of the job, in POSIX milliseconds: the time of the block that holds the transaction that made the escrow output. The chain gives it, and the poster of the escrow cannot choose it. It is not the member
   * `posted_at` of the datum: the poster writes that member, and no validator checks it.
   */
  readonly block_time_ms: number;
}

/**
 * Why a read of an escrow found none although the source answered: the output is not an escrow output of the deployment. It is not at the escrow script, or it holds no escrow datum, or it holds less than its
 * datum owes. The sender of an output can cause each of these, because anyone can lock an output at any address.
 */
export type NotAnEscrow = Refused<'not_escrow'>;

/** The result of a read of the escrow of a job: the job that the output stands for, or the reason that the output is no escrow output. A read that gets no answer throws. */
export type EscrowJobResult = Accepted<EscrowJob> | NotAnEscrow;

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
  /** The claim type: 1 to MAX_CLAIM_TYPE_BYTES bytes of text. */
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
  /**
   * The parameters of the Module-1 deployment that a challenge must agree with. `resolution_deadline_ms` is the time that the oracle and the jury have to resolve a challenge: a challenge
   * names this value, and the relay opens a case for it only when the value leaves the time that it needs (SPEC rule of the relay).
   */
  readonly protocol: { readonly resolution_deadline_ms: number };
  /** Every live claim output whose payment credential is the claim script, at any address, whatever its state. It throws when the chain cannot be read. */
  readClaims(): Promise<readonly ClaimView[]>;
  /** The live claim output at `ref`, or null when the output is spent, or is not a claim output. It throws when the chain cannot be read. */
  readClaim(ref: OutputRef): Promise<ClaimView | null>;
  /** Every live challenge output whose payment credential is the challenge script, at any address, and whose datum can be read: an output with a datum that cannot be read is left out, because any auditor makes challenge outputs. It throws when the chain cannot be read. */
  readChallenges(): Promise<readonly ChallengeView[]>;
  /**
   * The document at a `vector-tx:` URI, or the reason that the source has none (`DocumentResult`). It throws for another address, and when the source cannot be read or answers in a wrong shape: a read
   * that throws never says that the document is not there.
   */
  readDocument(uri: string): Promise<DocumentResult>;
  /**
   * True when the source that gives the documents has the output at `ref`: it has indexed the transaction that made it. The kit confirms the claim document before it stakes the claim, so a source that
   * has the claim has the document. False when the source answers that it does not have the output. It throws when the source cannot be read.
   */
  isIndexed(ref: OutputRef): Promise<boolean>;
  /**
   * The job that the escrow output at `ref` stands for: the time of the block that holds the transaction that made the output (`EscrowJob`). The output can be in any state of the escrow, spent or not. It gives `not_escrow`
   * when the source answered and the output is not an escrow output of the deployment. It throws when the source cannot be read, answers in a wrong shape, gives no time of the block, or does not have the output (it can
   * be behind): a read that throws never says that the output is no escrow output.
   */
  readEscrowJob(ref: OutputRef): Promise<EscrowJobResult>;
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
