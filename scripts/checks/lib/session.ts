// scripts/checks/lib/session.ts - what a step of a check works with: the settings, the keys, the state file, the evidence file, the node, the builders, the hosted tools, and the way to land
// a transaction. The runner (runner.ts) makes one session for each run. A test makes one from fakes.
import type { EvidenceFile } from './evidence.ts';
import type { StepPlan } from './guards.ts';
import type { HostedTools } from './hosted.ts';
import { recordLanded } from './inflight.ts';
import type { CheckKeyRole, KeyRing, LoadedKey } from './keys.ts';
import { LandRefused, landTransaction } from './land.ts';
import type { LandIo, LandRequest, LandResult, NetworkGate } from './land.ts';
import type { IdentityContext, IdentityDeployment } from './platform.ts';
import type { Clock, NodeAccess, Output } from './ports.ts';
import type { CommonSettings } from './settings.ts';
import type { StateFile, StepRecord } from './state.ts';

export type Mode = 'dry' | 'submit';

/** A Live vault output of a delegation as the chain shows it: its reference and the units that it holds. */
export interface LiveVaultRef {
  ref: string;
  lovelace: bigint;
}

/** The node as the builders read it: Lucid bound to a wallet, the provider and the identity deployment. */
export interface ChainAccess {
  provider: IdentityContext['provider'];
  deployment: IdentityDeployment;
  koiosUrl: string;
  fetchImpl: typeof fetch;
  context(address: string): Promise<IdentityContext>;
  /** The Live vault outputs of a delegation, read from the chain and not from the state file: a reference that a payment spent is not there any more. */
  liveVaultsOf(delegation: string, atMs: number): Promise<LiveVaultRef[]>;
}

export interface Session<Extra = unknown> {
  readonly check: string;
  readonly mode: Mode;
  readonly settings: CommonSettings;
  /** The settings of the check itself. */
  readonly extra: Extra;
  readonly out: Output;
  readonly clock: Clock;
  readonly state: StateFile;
  readonly evidence: EvidenceFile;
  readonly ring: KeyRing;
  /** The key that signs the proofs of the identity gateway: the authentication key when the operator gave one, else the agent key. Null when the check has no agent key. */
  readonly authKey: LoadedKey | null;
  readonly node: NodeAccess;
  readonly network: NetworkGate;
  readonly chain: ChainAccess;
  readonly hosted: HostedTools;
  /** The `fetch` of the run: the one of the runtime, or a fake. */
  readonly fetchImpl: typeof fetch;
  /** How long a transaction is waited for, and how often its status is read, in milliseconds. */
  readonly awaitMs: number;
  readonly pollMs: number;
  /** Lands one transaction (landTransaction), and writes the evidence of a refusal of the ledger. */
  land(request: LandRequest): Promise<LandResult>;
}

/** What a step says when it ends. */
export type StepOutcome =
  /** A dry run showed the step. */
  | { kind: 'dry' }
  /** The step is confirmed (or the command did its work). */
  | { kind: 'done'; message: string }
  /** Nothing is left to do for the steps of this check. */
  | { kind: 'finished'; message: string }
  /** The step must wait: the message says how long. */
  | { kind: 'wait'; message: string; untilMs: number | null };

/** A step cannot start because something that it needs is not so, for example a record that is not Active. Nothing was signed. */
export class PreconditionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PreconditionError';
  }
}

/** The plan of a step: the limits of the settings, and what the step names. `outflow` names, by role, what may leave the wallet of that key. */
export function stepPlan(session: Pick<Session, 'settings' | 'ring'>, over: Partial<Omit<StepPlan, 'maxOutflow' | 'maxFeeLovelace' | 'maxCollateralLossLovelace'>> & { outflow?: Partial<Record<CheckKeyRole, bigint>> } = {}): StepPlan {
  const { outflow, ...rest } = over;
  const maxOutflow: Record<string, bigint> = {};
  for (const [role, amount] of Object.entries(outflow ?? {}) as Array<[CheckKeyRole, bigint]>) maxOutflow[session.ring.get(role).keyHash] = amount;
  return {
    maxFeeLovelace: session.settings.maxFeeLovelace, maxCollateralLossLovelace: session.settings.maxCollateralLossLovelace, maxOutflow,
    explained: new Set(), destinations: new Set(), mint: {}, ...rest,
  };
}

/** The `land` of a session: the landing, and, for a refusal of the ledger, an entry of the evidence with its error and its body. */
export function landFor(io: LandIo, evidence: EvidenceFile): Session['land'] {
  return async (request) => {
    try {
      return await landTransaction(request, io);
    } catch (err) {
      if (err instanceof LandRefused) {
        evidence.add({ step: request.step, status: 'refused', expected: false, tx_hash: err.txHash, evaluation_error: err.evaluationError, transaction_body: err.transactionBody });
      }
      throw err;
    }
  };
}

/**
 * Records a step that landed: the state file keeps it (a part of a step as a note) and lets go of the transaction in flight, and the evidence file gets the entry that says what the
 * step shows.
 */
export function commitStep(session: Pick<Session, 'state' | 'evidence' | 'clock'>, request: LandRequest, landed: Extract<LandResult, { kind: 'landed' }>, shows: Record<string, unknown>): StepRecord | undefined {
  recordLanded(session.state, { step: request.step, tx_hash: landed.txHash, refs: request.refs ?? {}, facts: request.facts ?? {} }, session.clock.now());
  session.evidence.add({ step: request.step, status: 'confirmed', tx_hash: landed.txHash, fee_lovelace: landed.feeLovelace, shows });
  return session.state.step(request.step);
}
