import type { Facts, TaskSession, UseCase } from '../contract.ts';
import type { checkAttestation } from '../platform.ts';
import type { ApprovalEntry, DelegationEntry, HireEntry, Report, RunKind, RunRecord, RunRecordPolicy, SubDelegationEntry, VaultEntry } from '../run-record.ts';

export type Obj = Record<string, unknown>;
export interface Ref { readonly kind: string; readonly value: string }
export const ref = (kind: string, value: string): Ref => ({ kind, value });
export const isObject = (value: unknown): value is Obj => typeof value === 'object' && value !== null && !Array.isArray(value);
export const txOf = (reference: string): string => reference.slice(0, 64);
export type Shown = readonly Ref[] | string;

export interface EvidenceOptions { readonly label: string; readonly priv: boolean; readonly indexer: string; result: Readonly<Obj> | null }
export type EvidenceSession = TaskSession<EvidenceOptions>;
export type EvidenceReadSession = Pick<EvidenceSession, 'chain' | 'clock' | 'extra' | 'fetchImpl' | 'hosted' | 'node' | 'settings' | 'use'>;

interface HireBase { readonly index: number; readonly entry: HireEntry; readonly role: string; readonly decisions: readonly Obj[] }
export interface ReportedHire extends HireBase { readonly report: Report; readonly result: Obj; readonly sha256: string }
export interface UnreportedHire extends HireBase { readonly report: null; readonly result: null; readonly sha256: null }
export type HireView = ReportedHire | UnreportedHire;

export function lastHire(hires: readonly HireView[], role: string, matches?: (hire: HireView) => boolean): HireView | undefined {
  for (let i = hires.length - 1; i >= 0; i -= 1) {
    const hire = hires[i]!;
    if (hire.role === role && (matches === undefined || matches(hire))) return hire;
  }
  return undefined;
}

export interface Loaded { readonly record: RunRecord; readonly hires: readonly HireView[]; readonly carried: ReportedHire | null }
export interface TerminalSpend {
  readonly action: 'Accept' | 'Reclaim' | 'Release';
  readonly tx: string;
  readonly spent_output: string;
  readonly at: number;
  readonly refund_output: string | null;
}
export type VaultPayment =
  | { readonly paid: true; readonly why: ''; readonly vault_ref: string; readonly delegation: string }
  | { readonly paid: false; readonly why: string };

/** The approval identity in request text that matches the hash of an escrow on the chain. */
export interface CommittedApproval {
  readonly attestation: string; readonly issuer_did: string; readonly digest: string;
}

export interface ApprovalRead {
  readonly entry: ApprovalEntry; readonly hire: string; readonly state: 'active' | 'revoked' | 'expired'; readonly type: number;
  readonly subject: string; readonly digest: string; readonly issued_at: number; readonly valid_until: number;
  readonly validity_ms: number; readonly checked_at: number;
  readonly issued_block_at: number;
  /** `unproven` is a state observation only; it does not show that the hire used the approval. */
  readonly link: 'request' | 'counterparty_receipt' | 'unproven' | 'not_applicable';
}
export interface ApprovalExpectations {
  readonly digest?: string;
  readonly issuer?: NonNullable<Parameters<typeof checkAttestation>[1]['expect']>['issuer'];
  readonly maxValidityMs?: number;
  readonly clockSlackMs?: number;
}
export interface Reads {
  readonly delegations: readonly (DelegationEntry & { readonly state: 'live' | 'ended' })[];
  readonly vaults: readonly (VaultEntry & { readonly state: 'live' | 'closed' })[];
  readonly subDelegations: readonly SubDelegationEntry[];
}
export interface MockRead {
  readonly lines: readonly Obj[]; readonly unattributed: number; readonly counts: Readonly<Record<string, number>>;
  /** Use this in checks. Do not copy the unfiltered state into the public file. */
  readonly state: Readonly<Obj>;
}
export interface FaultEntry { readonly atMs: number; readonly check: string; readonly agent: string | null; readonly ok: boolean; readonly services: ReadonlyArray<{ service: string; started_at: string; value: string }> }

export interface Challenge { readonly agent: string; readonly claim: string; readonly evidence: string; readonly challenge: string }
export interface Hold { readonly reason: number; readonly since: number; readonly until: number; readonly record_output: string; readonly gateway_status: string | null }
export interface HistoricalHoldCandidate extends Hold { readonly verdict_output: string }
/** Return the current observation unchanged, or give the exact verdict and applied record output for a historical hold. */
export type HoldCandidate = Hold | HistoricalHoldCandidate;
export interface HoldSource {
  readonly challenge: Challenge;
  readonly listed: CaseView | null;
  readonly indexed: IndexedCase | null;
  blockTime(): Promise<number>;
  /** Returns only an observation of the current record. This does not prove that the hold came from this verdict. */
  readRecordHold(): Promise<Hold | null>;
}
export interface CaseView {
  readonly jury: string; readonly case_token: string; readonly case_output: string; readonly claim_out: string; readonly challenge_out: string; readonly canonical: boolean | null;
  readonly phase: string; readonly state: string; readonly tally: { readonly claimer: number; readonly auditor: number; readonly inconclusive: number }; readonly revealed: number; readonly outcome: string;
}
export interface IndexedCase {
  readonly jury: string; readonly case_token: string; readonly state: 'open' | 'settling' | 'closed'; readonly window: string;
  readonly tally: { readonly claimer: number; readonly auditor: number; readonly inconclusive: number }; readonly revealed: number; readonly result: string | null;
  readonly opened_tx: string; readonly finalized_tx: string | null; readonly finalized_result: string | null; readonly closed_tx: string | null;
}
export interface CaseRead { readonly listed: CaseView | null; readonly indexed: IndexedCase | null; readonly hold: Hold | null; readonly verdict: string | null; readonly waiting: string | null }

export interface Assembly {
  readonly purpose: 'run' | 'status'; readonly use: UseCase; readonly loaded: Loaded; readonly facts: Readonly<Facts>;
  /** Ledger-checked Accept or Reclaim for named transactions, by original escrow reference. A no-report Reclaim has a verified refund output. */
  readonly reads: Reads; readonly mock: MockRead | null; readonly terminals: ReadonlyMap<string, TerminalSpend>;
  readonly times: ReadonlyMap<string, number>; readonly faults: readonly FaultEntry[]; readonly extra: Readonly<Obj>;
  readonly challenge: Challenge | null; readonly caseRead: CaseRead | null; readonly approvalStates: readonly (ApprovalRead | null)[];
  /** Private request metadata by execute step. An absent key is unproven. A null value means the request names no approval. */
  readonly committedApprovals: ReadonlyMap<string, CommittedApproval | null>;
  /** Only populated for a lifecycle run, and only after the node confirms every named fact. */
  readonly lifecycleTransactions: ReadonlySet<string>;
  /** Tests the payment of this hire against the delegations of the record. This read does not submit a transaction. */
  paidFromVault(hire: HireEntry): Promise<VaultPayment>;
  /** Discovers a candidate via the indexer. Only a verified escrow Release is returned. This does not identify the submitting process. */
  readRelease(hire: HireEntry): Promise<TerminalSpend | null>;
}

export interface EvidenceModule extends RunRecordPolicy {
  readonly rules: Readonly<Record<string, (a: Assembly) => Shown>>;
  readonly runKinds: readonly RunKind[];
  readonly reportSchemas: Readonly<Record<string, string>>;
  /** Names the required producer fact ids of each lifecycle rule. A wait names both recovery transactions. */
  readonly lifecycleFacts?: Readonly<Record<string, readonly string[]>>;
  carriedOf(hires: readonly HireView[]): HireEntry | null;
  challengeOf(a: Assembly): Challenge | null;
  holdOf(a: Assembly, source: HoldSource): HoldCandidate | null | Promise<HoldCandidate | null>;
  /**
   * Select a step by `a.committedApprovals`, not by position or digest alone. Each execute payload has its own mode-600
   * `<step>.request.json` under the mode-700 run folder. Save the exact UTF-8 payload text before handing it to the hire.
   * The core matches the wire prompt hash and checks the request and attestation. Never emit the payload in evidence.
   */
  hireOfApproval(a: Assembly, index: number): string | null;
  /** A signed counterparty result, linked by the signed execute result, can supply the exact approval id. */
  approvalCounterparty?(a: Assembly, index: number): string | null;
  /** Keep the historical inventory evidence format. A matching approval state by itself does not prove use. */
  readonly allowApprovalStateOnly?: boolean;
  approvalExpectations?(a: Assembly, index: number): ApprovalExpectations;
  claimAgents?(a: Assembly): readonly string[];
  faultProblems?(a: Assembly): readonly { readonly member: string; readonly detail: string }[];
  readonly hosted: readonly string[];
  prepare(session: EvidenceReadSession, a: Assembly): Promise<Readonly<Obj>>;
  readonly mockRoutes: readonly string[];
  counts(state: Readonly<Obj>): Readonly<Record<string, number>> | null;
  moduleDocument(a: Assembly): Readonly<Obj> & { readonly run: string };
}
