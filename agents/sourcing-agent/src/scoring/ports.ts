// agents/sourcing-agent/src/scoring/ports.ts
// What `runScoring` needs from the outside, as ports: functions and plain values. The service joins them to the real chain, gateway, vendor master, model and files, and a test gives its own. This folder does
// not import the model, quotes, bidders, propose, execute or serve folders of the agent. The file of a bidder is written here as a plain shape (the bidder reader of the agent writes the same shape), and the
// decision `score` comes in as a function. The kit gives the types of the rest.
import type { KeyInput } from '@vsa/id-kit/client';
import type { CallDeps, Clock, LeftSubDelegation, SerialQueue, SubDelegationDeps, TokenDeps, TxSigner } from '@vsa/usecase-kit/access';
import type { Components, Quote, RfqDocument, Weights } from '@vsa/usecase-kit/bids';
import type { FaultSwitch } from '@vsa/usecase-kit/fault';
import type { Decision, DelegationId, Did, OutputRef, TenantId } from '@vsa/usecase-kit/protocol';
import type { VendorEntry } from './vendors.ts';

/** The state of a fact that a source can fail to give. `unreadable` is a source that gave no answer: it is never `absent` and never `valid`. */
export type FactState = 'valid' | 'invalid' | 'absent' | 'unreadable';

/** The compliance attestation about a bidder. The reply of the bidder is a hash only: its text is never read. */
export interface ComplianceFact {
  readonly state: FactState;
  readonly attestation: string | null;
  readonly attestation_state: 'active' | 'revoked' | 'expired' | 'not_yet_valid' | null;
  readonly issued_at: string | null;
  readonly valid_until: string | null;
  readonly revoked_at: string | null;
  readonly revoke_reason: string | null;
  readonly contested: { readonly sha256: string } | null;
}

/** What the record of a bidder says about the end of its life and the change of its controller. */
export interface BidderLineage {
  readonly hold_until: string | null;
  readonly ended_at: string | null;
  readonly invalid_from: string | null;
  readonly successor: Did | null;
  readonly recovery_pending: boolean;
}

/** The status of a bidder. `unreadable`: the gateway gave no answer, and the members that come from the record are then null or false. */
export type BidderStatus = 'active' | 'suspended' | 'revoked' | 'retired' | 'not_found' | 'unreadable';

/** The file of one bidder: the facts that the model reads. The members are words of a closed list, numbers, booleans, hashes, a domain, DIDs and times. */
export interface BidderFile {
  readonly did: Did;
  readonly advert_ref: OutputRef;
  readonly status: BidderStatus;
  readonly status_reason: string | null;
  readonly lineage: BidderLineage;
  readonly accountable: string | null;
  readonly organisation: string | null;
  readonly organisation_verified: boolean;
  readonly in_catalog: boolean | null;
  readonly stake_lovelace: string | null;
  readonly cases_against: number | null;
  readonly price_list: 'valid' | 'invalid' | 'unreadable';
  readonly compliance: ComplianceFact;
  readonly credential: FactState;
}

/**
 * A quote to score. `did` is the DID of the bidder, `organisation` is its VERIFIED organisation or `null` (a domain that no check backs is passed as `null`, so it never picks a vendor entry), `quote` is the
 * accepted quote, and `file` is the file of the bidder.
 */
export interface ScoreSubject {
  readonly did: Did;
  readonly organisation: string | null;
  readonly quote: Quote;
  readonly file: BidderFile;
}

/**
 * What one scoring needs from the job. `delegation` is the delegation of the hirer: each scorer gets a sub-delegation one hop below it. `subjects` has 1 to 3 entries, and subject `k` goes to scorer `k + 1`:
 * the first subject goes to the first scorer, and with two subjects the third scorer does not start.
 */
export interface ScoringInput {
  readonly tenant: TenantId;
  readonly delegation: DelegationId;
  /** The day of the job, as `YYYY-MM-DD`. The model reads it; no code compares a date with it. */
  readonly today: string;
  readonly weights: Weights;
  readonly rfq: RfqDocument;
  readonly subjects: readonly ScoreSubject[];
}

/** One scorer: a subagent of the agent with two keys of its own. `signer` signs with the delegation key, which is the delegate key of its sub-delegation and the key of the DPoP proof of its token. */
export interface Scorer {
  readonly did: Did;
  readonly authenticationKey: KeyInput;
  readonly delegationKey: KeyInput;
  readonly signer: TxSigner;
}

/** A left sub-delegation and the key that ends it: the hash of the delegation key of this agent, which signs the Undelegate. `LeftEntry` of the janitor folder of the kit has the same two members. */
export interface LeftEntry {
  readonly left: LeftSubDelegation;
  readonly signer_key_hash: string;
}

/**
 * The list of left sub-delegations, as far as a run uses it. `LeftStore` of the janitor folder of the kit has these three methods. `list` gives every entry. It rejects when the list cannot be read, and a run
 * that cannot read the list sends nothing. It rejects with `DamagedLeftEntriesError` of the janitor folder when a file of the list is damaged: the run then goes on with the entries that the error carries,
 * unless a damaged file has the name `<id>.json` of its own sub-delegation. The read has a bound of 20 seconds in the run. `put` stores the entry before the Delegate is sent, and it replaces the entry of an
 * id that it holds, so a run reads the list first and never puts an entry with an id that the list holds. `remove` of an id that is not there is not an error.
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

/** What the decision `score` gets for one quote: the day, the weights, the request, the quote, the file of the bidder, and the entry of the vendor master for the bidder or `null`. */
export interface ScoreRequest {
  readonly today: string;
  readonly weights: Weights;
  readonly rfq: RfqDocument;
  readonly quote: Quote;
  readonly file: BidderFile;
  readonly vendor: VendorEntry | null;
}

/** The choice of the decision `score`: the four component scores and the score of the quote, each from 0 to 100. */
export interface ScoreChoice {
  readonly components: Components;
  readonly score: number;
}

/**
 * The decision `score`: the decision with its receipt and the choice that it holds, or the code of the failure. A failure holds no decision. `choice` must be the choice that `decision.choice` records, with the
 * same members and the same values: `runScoring` takes a choice only when the two are equal, and it fails with `decision_mismatch` when they differ.
 */
export type ScoreAnswer = { readonly ok: true; readonly decision: Decision; readonly choice: ScoreChoice } | { readonly ok: false; readonly code: string };

/**
 * Everything that `runScoring` reads or does outside its own code. Each failure of a port is a typed result of the scoring, and no port gets a retry.
 * - `scorers` are the three scorers. The scorer `k + 1` takes the subject `k`.
 * - `agentKey` is the live delegation key of the agent: the key that the delegation of the hirer names as its delegate. Its `signer` signs each Delegate and each Undelegate, `walletAddress` is the address of its
 *   wallet, which pays the fees and gets the deposits back, and `queue` is the one queue of that wallet (the `lane` of its paying key) that its hires and its janitor use too: the Delegates of the scorers go
 *   through it one at a time.
 * - `subDelegation` is the chain, the clock, the delegation script and the bases of the mock service. The queue of the wallet and the hook before the send come from this folder.
 * - `tokens` is the client of the gateway, `calls` is the fetch and the bases of the mock service, and `clock` is the clock of the job.
 * - `leftSink` and `inFlight` are the list of left sub-delegations and the set of the ids that a run still uses.
 * - `score` asks the model for the score of one quote. Its call is a paid hire: the signal of the caller is never passed into it.
 * - `fault` is the switch that the service made at its start. Its value is read one time for a scoring.
 * - `deadline_ms` is the time by which every wait of the scoring must end, in POSIX milliseconds by the clock of the deps. A scorer starts only with `SCORER_NEED_MS` left.
 * - `log` gets one line for each scorer that stops before its Delegate is sent or fails, with the cause. A line has codes, references and counts, and no key, token, quote or vendor entry. A function that
 *   throws changes no result.
 */
export interface ScoringDeps {
  readonly scorers: readonly [Scorer, Scorer, Scorer];
  readonly agentKey: { readonly signer: TxSigner; readonly walletAddress: string; readonly queue: SerialQueue };
  readonly subDelegation: Omit<SubDelegationDeps, 'walletQueue' | 'beforeSend'>;
  readonly tokens: TokenDeps;
  readonly calls: CallDeps;
  readonly clock: Clock;
  readonly leftSink: LeftSink;
  readonly inFlight: InFlight;
  readonly score: (request: ScoreRequest) => Promise<ScoreAnswer>;
  readonly fault: FaultSwitch<'sourcing-agent'>;
  readonly deadline_ms: number;
  readonly log: (line: string) => void;
}

/** The score of one quote. `choice` is the answer of the scorer after the fault, and `decision` is the record of what the model said: the fault never changes the decision. */
export interface ScoredQuote {
  readonly did: Did;
  readonly decision: Decision;
  readonly choice: ScoreChoice;
}

/**
 * The result of a scoring: one score for each subject in the order of the subjects, or the code of the first scorer that failed (in the order of the subjects) with every decision that a scorer made, in that
 * order. A decision that was made was paid for, so a failed result keeps it.
 */
export type ScoringResult = { readonly ok: true; readonly scores: readonly ScoredQuote[] } | { readonly ok: false; readonly code: string; readonly decisions: readonly Decision[] };
