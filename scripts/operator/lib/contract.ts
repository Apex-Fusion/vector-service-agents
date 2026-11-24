// scripts/operator/lib/contract.ts - the types that the files of the operator pack share: the data of a use case, the settings, the facts file, the landing host, and the task with its session.
// This file holds types only: no value, no function and no side effect. Each file of the pack imports its types from here, so a name has one meaning in the whole pack.
import type { ChainAccess, StepOutcome } from '../../checks/lib/session.ts';
import type { GuardResult, StepPlan } from '../../checks/lib/guards.ts';
import type { EvidenceFile } from '../../checks/lib/evidence.ts';
import type { HostedTools } from '../../checks/lib/hosted.ts';
import type { NetworkGate } from '../../checks/lib/land.ts';
import type { Clock, NodeAccess, Output } from '../../checks/lib/ports.ts';
import type { NetworkSpec } from '../../checks/lib/settings.ts';
import type { StateFile } from '../../checks/lib/state.ts';
import type { TxFacts } from '../../checks/lib/txfacts.ts';
import type { Exposure, GoFile, IrreversibleTag } from './approval.ts';
import type { DohLookup } from './dns.ts';
import type { ResultCommand } from './output.ts';
import type { KeySpec, Registry } from './registry.ts';
import type { AgentKind } from '../../../packages/usecase-kit/src/protocol/index.ts';
export type { StepOutcome };

// ---- the data of a use case (a data file gives the value; public text only) ----
export type KeyPurpose = 'authentication' | 'assertion' | 'transaction' | 'delegation';
/** One line of an env file that a key fills: the file, the variable, and what the line holds (the secret, the key hash, the public key or the wallet address). */
export interface KeyLine { readonly file: string; readonly name: string; readonly of: 'secret' | 'pkh' | 'pub' | 'address' }
export interface KeyUse { readonly key: string; readonly purposes: readonly KeyPurpose[]; readonly lines: readonly KeyLine[] }
export interface PartySpec {
  readonly role: 'Accountable' | 'Responsible' | 'Provider' | 'Guardian';
  readonly signer: { readonly kind: 'controller' } | { readonly kind: 'module1' } | { readonly kind: 'key'; readonly key: string };
  readonly organisation: string | null;
  readonly rights: readonly ('suspend' | 'revoke' | 'recover')[] | null;
}
/** `runtimeContainer` is the container that serves the advert: it is the key of that container in `running-images.json`. */
export interface AdvertSpec {
  readonly model: string; readonly priceLovelace: bigint; readonly supplierBondLovelace: bigint; readonly buyerBondLovelace: bigint; readonly windowMs: number; readonly maxOutputTokens: number;
  readonly depositLovelace: bigint; readonly supplierKey: string; readonly origin: string; readonly runtimeEnvFile: string; readonly runtimeContainer: string;
}
/** The claim that the task `claim` stakes for an agent: the stake, the challenge window, the claim type, and what the service wallet keeps for a challenge of its own (null for an agent that never challenges). */
export interface ClaimSpec { readonly stakeLovelace: bigint; readonly windowMs: number; readonly claimType: string; readonly challengeReserveLovelace: bigint | null }
/** What must be true of an agent after the last run. `successor` is the id of a record of the data, or null. */
export interface EndSpec {
  readonly record: 'active' | 'revoked' | 'retired'; readonly advert: 'listed' | 'retired'; readonly subagents: 'live' | 'ended'; readonly successor: string | null;
}
export interface AgentSpec {
  readonly id: string; readonly kind: AgentKind; readonly name: string; readonly description: string; readonly capability: string; readonly organisation: string;
  readonly endpoint: string; readonly folder: string; readonly serviceEnvFile: string; readonly serviceKey: string; readonly statusUrls: readonly string[];
  /** The container of the service: the key of that container in `running-images.json` and in `seen-services.json`. */
  readonly serviceContainer: string;
  /** The example env file in the folder of the agent. Null: the service env file with `.example` at its end. */
  readonly exampleEnvFile: string | null;
  /** True when the service env file holds the origins of the mock systems (`mock`) and the pinned manifest of Module-1 (`module1`). */
  readonly envManaged: { readonly mock: boolean; readonly module1: boolean };
  /** Lines (`of: 'pkh'` only) of a key that the record of the agent does not list. */
  readonly publicKeyLines: readonly { readonly key: string; readonly lines: readonly KeyLine[] }[];
  readonly keys: readonly KeyUse[]; readonly parties: readonly PartySpec[]; readonly guardianThreshold: number; readonly adverts: readonly AdvertSpec[];
  readonly cosign: boolean; readonly faultValues: readonly string[]; readonly stakeLovelace: bigint;
  readonly claim: ClaimSpec;
  readonly end: EndSpec;
}
export interface SubagentSpec { readonly id: string; readonly parent: string; readonly name: string; readonly description: string; readonly keys: readonly KeyUse[] }
export interface OrganisationSpec { readonly id: string; readonly domain: string; readonly accountableKey: string; readonly guardianKey: string }
export interface FundingLine { readonly wallet: string; readonly collateralLovelace: bigint; readonly floatLovelace: bigint; readonly items: readonly { readonly what: string; readonly lovelace: bigint }[] }
export interface AttestationSpec { readonly agent: string; readonly types: readonly ('provenance' | 'software')[]; readonly format: number; readonly validDays: number; readonly envelope: { readonly type: 'provenance' | 'software' } | null }
/** A record of the data that is neither an agent nor a subagent, for example the record that takes the place of a retired one. */
export interface RecordSpec {
  readonly id: string; readonly name: string; readonly description: string; readonly keys: readonly KeyUse[]; readonly parties: readonly PartySpec[]; readonly organisation: string | null; readonly guardianThreshold: number;
}
/** The compliance attestations of a use case: the key that issues them, the agents that they name, the format and the validity of each, the statement of its document, and the text of the reply to a contest. */
export interface ComplianceSpec {
  readonly issuerKey: string; readonly subjects: readonly string[]; readonly format: number; readonly validDays: number; readonly statement: string; readonly reply: { readonly text: string };
}
/** The lifecycle run of a use case: the agent, its two controller keys, its two guardian keys, the id of the record that takes its place, and how long the run waits. */
export interface LifecycleSpec {
  readonly agent: string; readonly controllers: readonly [string, string]; readonly guardians: readonly [string, string]; readonly successor: string; readonly waitMs: number;
}
/** One vendor of the seed of a tenant of the mock systems, with the members that the seed of the mock service has. `organisation` is the id of an organisation of the data. */
export interface VendorSeed {
  readonly vendor_id: string; readonly organisation: string; readonly name: string; readonly on_time_delivery_rate: number; readonly defect_rate: number; readonly years_as_vendor: number;
  readonly payment_terms_days: number; readonly certifications: readonly string[]; readonly last_audit: string;
}
/** `subject` is the item that the run is about, a SKU for example. A run of the kind `lifecycle` has no tenant and no vault. */
export interface RunSpec { readonly id: 'clean' | 'failure' | 'lifecycle'; readonly subject: string; readonly tenantPrefix: string; readonly vaultUnits: number; readonly perTxUnits: number; readonly totalUnits: number }
export interface EvidenceStepSpec {
  readonly id: string; readonly run: 'clean' | 'failure' | 'lifecycle' | 'both'; readonly what: string; readonly primitive: string; readonly actor: 'hirer' | 'agent' | 'counterparty' | 'operator' | 'relay';
}
export interface UseCase {
  readonly name: string; readonly title: string; readonly keys: readonly KeySpec[]; readonly organisations: readonly OrganisationSpec[];
  readonly agents: readonly AgentSpec[]; readonly subagents: readonly SubagentSpec[]; readonly funding: readonly FundingLine[];
  readonly attestations: readonly AttestationSpec[]; readonly runs: readonly RunSpec[]; readonly evidenceSteps: readonly EvidenceStepSpec[];
  readonly moduleManifestPath: string; readonly runtimeCommit: string;
  /** The records that are neither an agent nor a subagent. */
  readonly records: readonly RecordSpec[];
  /** The compliance attestations, or null when the use case has none. */
  readonly compliance: ComplianceSpec | null;
  /** The lifecycle run, or null when the use case has none. */
  readonly lifecycle: LifecycleSpec | null;
  /** The vendors of the seed of a tenant of the mock systems, or null for the default seed. */
  readonly tenantSeed: { readonly vendors: readonly VendorSeed[] } | null;
  /** The domains of the supplier organisation and of the insurer organisation of a tenant of the mock systems. */
  readonly tenantOrganisations: { readonly supplier: string; readonly insurer: string };
  /** The section "Not covered" of the results page: a lead, and one short sentence for each thing that the runs of the use case do not show. */
  readonly notCovered: { readonly lead: string; readonly items: readonly string[] };
}

// ---- settings, flags, facts ----
export interface OperatorSettings {
  readonly network: NetworkSpec; readonly useCase: string; readonly keysDir: string; readonly stateDir: string; readonly agentsDir: string; readonly goFile: string;
  readonly mockEnvFile: string | null; readonly contact: string | null; readonly module1Commit: string | null;
  readonly urls: { readonly ogmios: string; readonly submit: string; readonly koios: string; readonly hosted: string; readonly gateway: string };
  readonly maxFeeLovelace: bigint; readonly maxCollateralLossLovelace: bigint;
}
export interface TaskFlags { has(name: string): boolean; value(name: string): string | undefined }
export interface RecordFact { did: string; id: string; tx: string; recordRef: string; depositLovelace: string; registeredAt: string }
export interface OrganisationFact { txtName: string; txtValue: string; verifiedAt: string | null }
export interface OrganisationMove {
  readonly from: string;
  readonly to: string;
  readonly fact: Readonly<OrganisationFact>;
  readonly record: Readonly<RecordFact>;
}
export interface StakeFact { openingRef: string; stakeRef: string | null; tokenUnit: string | null; amountLovelace: string }
export interface AdvertFact { ref: string; tx: string; detailUri: string; detailHash: string; endpoint: string; postedAt: string }
export interface ManifestFact { uri: string; sha256: string; bytes: number; readAt: string }
export interface AttestationFact { id: string; tx: string; digest: string; locator: string; validUntil: string; issuedAt: string; envelope: boolean }
export interface ClaimFact {
  claimRef: string; documentTx: string; claimTx: string; claimToken: string; stakeLovelace: string; windowMs: number; stakedAt: string; withdrawableFrom: string; withdrawTx: string | null;
}
export interface TenantFact { name: string; createdAt: string; seedKind: 'default' | 'custom' }
export interface HoldFact { suspendTx: string | null; liftTx: string | null }
export interface DeployFact { commit: string; images: Readonly<Record<string, string>> }
export interface ComplianceFact {
  id: string; tx: string; digest: string; locator: string; validUntil: string; issuedAt: string;
  revokeTx: string | null; contestTx: string | null; replySha256: string | null; replyUri: string | null;
}
export interface RevocationFact { tx: string; reason: number; invalidFrom: string | null; revokedAt: string }
export interface LifecycleFact { tx: string; at: string }
export interface SubagentEndFact { tx: string; at: string; epochBefore: number; epochAfter: number }
export interface Facts {
  records: Record<string, RecordFact>; organisations: Record<string, OrganisationFact>; stakes: Record<string, StakeFact>;
  adverts: Record<string, Record<string, AdvertFact>>; manifests: Record<string, ManifestFact>; attestations: Record<string, Record<string, AttestationFact>>;
  claims: Record<string, Record<string, ClaimFact>>; tenants: Record<string, TenantFact>; holds: Record<string, HoldFact>; deploy: DeployFact | null;
  compliance: Record<string, ComplianceFact>; revocations: Record<string, RevocationFact>; lifecycle: Record<string, LifecycleFact>; subagentEnds: Record<string, SubagentEndFact>;
}
export interface FactsStore {
  read(): Readonly<Facts>;
  /** Sets one fact at `path` below `section`, or one field of a fact when `path` ends with a field name (the fact must exist; a null field counts as not set). A second value that differs from the first is an error unless `replace` is true. */
  put<S extends keyof Facts>(section: S, path: readonly string[], value: unknown, options?: { replace?: boolean }): void;
  /** Moves organisation facts to subject keys only if the expected facts and records still agree. */
  moveOrganisations(moves: readonly OrganisationMove[]): void;
}

// ---- landing (the landing files implement the functions over LandHost; the runner builds the TaskSession that satisfies it) ----
export interface LandHost {
  readonly mode: 'dry' | 'submit';
  readonly settings: OperatorSettings;
  readonly registry: Registry;
  readonly state: StateFile;
  readonly evidence: EvidenceFile;
  readonly clock: Clock;
  readonly out: Output;
  readonly node: NodeAccess;
  readonly network: NetworkGate;
  /** The result of the network guard that the runner read once before the task ran, or null before that. A SYNC flow (guardedSign) reads it, because it cannot wait for `network.guard()`. */
  readonly networkResult: () => GuardResult | null;
  readonly chain: ChainAccess;
  readonly hosted: HostedTools;
  readonly go: GoFile | null;
  readonly exposure: Exposure;
  readonly task: string;
  readonly awaitMs: number;
  readonly pollMs: number;
}
export interface HostedBuild {
  readonly tool: string; readonly args: Readonly<Record<string, unknown>>; readonly text: string; readonly json: Readonly<Record<string, unknown>>;
  readonly unsignedCbor: string; readonly txHash: string; readonly feeLovelace: bigint; readonly validTo: number;
  readonly requiredSigners: readonly { readonly keyHash: string; readonly roles: readonly string[] }[];
}
export interface HostedLandSpec {
  readonly step: string; readonly tool: string; readonly args: Readonly<Record<string, unknown>>;
  /** Registry NAMES. The set must equal the required signers of the build. */
  readonly expectSigners: readonly string[];
  readonly plan: (build: HostedBuild, facts: TxFacts) => StepPlan | Promise<StepPlan>;
  /** Called in submit mode only, after the build is parsed and its signers are checked, and before the guards and any signature. It throws to stop the run (for example when a TXT value is not published). */
  readonly beforeSign?: (build: HostedBuild, facts: TxFacts) => Promise<void>;
  readonly refs?: (build: HostedBuild, facts: TxFacts) => Record<string, string>;
  readonly facts?: (build: HostedBuild, facts: TxFacts) => Record<string, unknown>;
  readonly notes?: readonly string[];
  readonly irreversible?: IrreversibleTag;
}
/** A transaction that a builder of buyer-core made (no hosted tool): the same landing. */
export interface BuiltLandSpec {
  readonly step: string;
  readonly built: { readonly unsignedCbor: string; readonly txHash: string; readonly feeLovelace: bigint; readonly validTo: number };
  readonly expectSigners: readonly string[];
  readonly plan: (facts: TxFacts) => StepPlan | Promise<StepPlan>;
  readonly beforeSign?: (facts: TxFacts) => Promise<void>;
  readonly refs?: (facts: TxFacts) => Record<string, string>;
  readonly facts?: (facts: TxFacts) => Record<string, unknown>;
  readonly notes?: readonly string[];
  readonly irreversible?: IrreversibleTag;
}
/** For a flow that the kit drives: the kit builds, calls a SYNC sign, submits and waits. The plan and the step name may depend on the bytes (a claim flow signs a document transaction and then a claim transaction). */
export interface GuardedSignRequest {
  readonly step: string | ((facts: TxFacts) => string); readonly plan: StepPlan | ((facts: TxFacts) => StepPlan); readonly signer: string;
  readonly refs?: Record<string, string>; readonly facts?: Record<string, unknown>; readonly notes?: readonly string[]; readonly irreversible?: IrreversibleTag;
}

// ---- the task and its session ----
export interface TaskSession<Extra = unknown> extends LandHost {
  readonly use: UseCase; readonly extra: Extra; readonly flags: TaskFlags; readonly facts: FactsStore; readonly fetchImpl: typeof fetch; readonly all: boolean;
  readonly dohLookup: DohLookup;
}
/** A local document writer gets public data only. It does not get the transaction session. */
export interface OfflineTaskInput<Extra> {
  readonly extra: Extra; readonly use: UseCase; readonly facts: Readonly<Facts>; readonly stateDir: string; readonly out: Output;
}
export interface OfflineTaskResult { readonly message: string; readonly result: Readonly<Record<string, unknown>> }

export type TaskCommand = ResultCommand;
export type ResubmitSession<Extra> = Pick<TaskSession<Extra>, 'task' | 'use' | 'extra' | 'settings' | 'go' | 'clock' | 'chain' | 'fetchImpl' | 'registry' | 'facts' | 'out' | 'networkResult'> & {
  readonly node: Pick<NodeAccess, 'resolveInputs' | 'txStatus'>;
  readonly state: Pick<StateFile, 'step'>;
};
export interface ResubmitFlight {
  readonly step: string;
  readonly txHash: string;
  readonly inputRefs: readonly string[];
  readonly refs: Readonly<Record<string, string>>;
  readonly facts: Readonly<Record<string, unknown>>;
}
export interface TaskDefinition<Extra = unknown> {
  readonly name: string; readonly title: string;
  /** The boolean flags besides --submit and --all. */
  readonly flags: readonly string[];
  /** The flags that take a value. */
  readonly valued: readonly string[];
  readonly needs: { keys(use: UseCase, flags: TaskFlags): readonly string[]; readonly chain: boolean; readonly hosted: readonly string[]; readonly approval: 'submit' | 'never' };
  readonly offline?: {
    matches(extra: Extra): boolean;
    run(input: OfflineTaskInput<Extra>): OfflineTaskResult | Promise<OfflineTaskResult>;
  };
  steps(use: UseCase, flags: TaskFlags): readonly string[];
  parse(env: Readonly<Record<string, string | undefined>>, settings: OperatorSettings, use: UseCase, flags: TaskFlags, command?: TaskCommand): Extra;
  next(session: TaskSession<Extra>): Promise<StepOutcome>;
  cleanup(session: TaskSession<Extra>): Promise<StepOutcome>;
  /** Runs only before a resend. It reads the current flight, but never receives its signed bytes. */
  beforeResubmit?(session: ResubmitSession<Extra>, command: TaskCommand, flight: ResubmitFlight): Promise<void>;
  status?(session: TaskSession<Extra>): Promise<readonly string[]>;
  /** The public `result` object of the `operator-result:` line. Public values only. */
  result?(session: TaskSession<Extra>): Readonly<Record<string, unknown>>;
}
