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
import type { KeySpec, Registry } from './registry.ts';
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
export interface AgentSpec {
  readonly id: string; readonly kind: 'reorder-agent' | 'order-desk'; readonly name: string; readonly description: string; readonly capability: string; readonly organisation: string;
  readonly endpoint: string; readonly folder: string; readonly serviceEnvFile: string; readonly serviceKey: string; readonly statusUrls: readonly string[];
  readonly keys: readonly KeyUse[]; readonly parties: readonly PartySpec[]; readonly guardianThreshold: number; readonly adverts: readonly AdvertSpec[];
  readonly cosign: boolean; readonly faultValues: readonly string[]; readonly stakeLovelace: bigint;
  readonly claim: { readonly stakeLovelace: bigint; readonly windowMs: number; readonly claimType: string };
}
export interface SubagentSpec { readonly id: string; readonly parent: string; readonly name: string; readonly description: string; readonly keys: readonly KeyUse[] }
export interface OrganisationSpec { readonly id: string; readonly domain: string; readonly accountableKey: string; readonly guardianKey: string }
export interface FundingLine { readonly wallet: string; readonly collateralLovelace: bigint; readonly floatLovelace: bigint; readonly items: readonly { readonly what: string; readonly lovelace: bigint }[] }
export interface AttestationSpec { readonly agent: string; readonly types: readonly ('provenance' | 'software')[]; readonly format: number; readonly validDays: number; readonly envelope: { readonly type: 'provenance' | 'software' } | null }
export interface RunSpec { readonly id: 'clean' | 'failure'; readonly sku: string; readonly tenantPrefix: string; readonly vaultUnits: number; readonly perTxUnits: number; readonly totalUnits: number }
export interface EvidenceStepSpec {
  readonly id: string; readonly run: 'clean' | 'failure' | 'both'; readonly what: string; readonly primitive: string; readonly actor: 'hirer' | 'agent' | 'counterparty' | 'operator' | 'relay';
}
export interface UseCase {
  readonly name: string; readonly title: string; readonly keys: readonly KeySpec[]; readonly organisations: readonly OrganisationSpec[];
  readonly agents: readonly AgentSpec[]; readonly subagents: readonly SubagentSpec[]; readonly funding: readonly FundingLine[];
  readonly attestations: readonly AttestationSpec[]; readonly runs: readonly RunSpec[]; readonly evidenceSteps: readonly EvidenceStepSpec[];
  readonly moduleManifestPath: string; readonly runtimeCommit: string;
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
export interface Facts {
  records: Record<string, RecordFact>; organisations: Record<string, OrganisationFact>; stakes: Record<string, StakeFact>;
  adverts: Record<string, Record<string, AdvertFact>>; manifests: Record<string, ManifestFact>; attestations: Record<string, Record<string, AttestationFact>>;
  claims: Record<string, Record<string, ClaimFact>>; tenants: Record<string, TenantFact>; holds: Record<string, HoldFact>; deploy: DeployFact | null;
}
export interface FactsStore {
  read(): Readonly<Facts>;
  /** Sets one fact at `path` below `section`, or one field of a fact when `path` ends with a field name (the fact must exist; a null field counts as not set). A second value that differs from the first is an error unless `replace` is true. */
  put<S extends keyof Facts>(section: S, path: readonly string[], value: unknown, options?: { replace?: boolean }): void;
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
}
export interface TaskDefinition<Extra = unknown> {
  readonly name: string; readonly title: string;
  /** The boolean flags besides --submit and --all. */
  readonly flags: readonly string[];
  /** The flags that take a value. */
  readonly valued: readonly string[];
  readonly needs: { keys(use: UseCase, flags: TaskFlags): readonly string[]; readonly chain: boolean; readonly hosted: readonly string[]; readonly approval: 'submit' | 'never' };
  steps(use: UseCase, flags: TaskFlags): readonly string[];
  parse(env: Readonly<Record<string, string | undefined>>, settings: OperatorSettings, use: UseCase, flags: TaskFlags): Extra;
  next(session: TaskSession<Extra>): Promise<StepOutcome>;
  cleanup(session: TaskSession<Extra>): Promise<StepOutcome>;
  status?(session: TaskSession<Extra>): Promise<readonly string[]>;
  /** The public `result` object of the `operator-result:` line. Public values only. */
  result?(session: TaskSession<Extra>): Readonly<Record<string, unknown>>;
}
