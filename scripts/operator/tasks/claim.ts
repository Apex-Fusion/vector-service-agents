// scripts/operator/tasks/claim.ts - the task `claim`: before a run, each agent stakes a Module-1 claim; after the challenge window, the same task withdraws the claims that nobody challenged.
//
//   run --run <label> --kind clean|failure   stakes the claim of the run for each agent, in the order of the data (one step each)
//   cleanup --run <label>                    withdraws each claim of the run that its facts hold, after its window; a claim that a challenge moved waits for its verdict
//   status --run <label>                     shows the claims of the run from the facts, the time left of each window, and the open claims that the chain shows
//   run --trial                              writes the documents for the test of the jury: no chain, no key, no transaction
//
// The kit does the work (`Dispute.stakeRunClaim` and `Dispute.withdrawClaim` over `createModule1Port`), and the guarded signer judges each transaction that the kit builds: the service key of the agent
// is the one signer, the stake, the window and the claim type are the constants of `lib/claim-constants.ts`, and a transaction that does more than the plan says is never signed. A claim is staked
// only for a record that is Active and lists that key with the transaction purpose, and only while every running runtime of the use case says free: a Module-1 build spends every output of the
// service wallet but one, and a running service uses the same wallet. A claim is staked in two transactions (the claim document, then the claim). The kit confirms the first before it builds the
// second, and the guarded signer keeps the first as a part of the step in the state file. If the task stops after the claim landed, the next run reads the claim from the chain and records the step:
// it never stakes a second claim for the same run.
// A challenge spends the claim output and makes a new output that holds the same claim token, so a spent output does not end a claim. `cleanup` records a claim as `not open` only when no live claim
// output holds its token. A claim in a new output that is Open is withdrawn from that output. A claim in a new output that is Challenged, Validated or Invalidated waits, and the step records nothing.
// The wait of a Challenged claim names the end of its challenge when exactly one live challenge output holds the claim token: the time of the challenge plus its resolution deadline. The challenge must be
// resolved before that time, and after it anyone can submit TimeoutResolve. This pack builds no TimeoutResolve: the line only names it.
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { isCollateralOutput } from '../../checks/lib/collateral.ts';
import { writeFileAtomically } from '../../checks/lib/files.ts';
import { duration, iso, units } from '../../checks/lib/format.ts';
import { PreconditionError } from '../../checks/lib/session.ts';
import type { TxFacts } from '../../checks/lib/txfacts.ts';
import { CLAIM_OF_KIND, CLAIM_STAKE_LOVELACE, CLAIM_WINDOW_MS, claimTypeOf } from '../lib/claim-constants.ts';
import type { AgentSpec, ClaimFact, GuardedSignRequest, LandHost, OfflineTaskInput, OfflineTaskResult, StepOutcome, TaskDefinition, TaskSession } from '../lib/contract.ts';
import { readRunning, requireRuntimesFree, runtimesOf } from '../lib/free.ts';
import { DryStop, guardedSign, recordKitLanding, recordingProvider } from '../lib/guarded-sign.ts';
import { planOf } from '../lib/plan.ts';
import {
  Dispute, PURPOSE, createModule1Port, effectiveStatus, findRecord, keyHashOf, koiosUtxoInfo, module1FromManifest, parseOutRef, readManifest, withdrawableFrom,
} from '../lib/platform.ts';
import { FlagError, runSteps } from '../lib/runner.ts';
import type { StepHandler } from '../lib/runner.ts';
import { trialOf } from '../lib/trials/index.ts';
import { MODULE1_FEE_BUFFER, txHashOfUri } from '../../../packages/buyer-core/src/index.ts';
import type { Module1Deployment } from '../../../packages/buyer-core/src/index.ts';
import { createSerialQueue } from '../../../packages/usecase-kit/src/access/index.ts';
import type { ChallengeView, ClaimView, Module1Port, Module1Provider, RunClaimNotStaked, WithdrawNotDone } from '../../../packages/usecase-kit/src/dispute/index.ts';

type Kind = 'clean' | 'failure';
const KINDS: readonly Kind[] = ['clean', 'failure'];

interface ClaimExtra {
  readonly trial: boolean;
  /** The label of the run. Null only for `--trial`, which belongs to no run. */
  readonly run: string | null;
  readonly kind: Kind | null;
}

/** The manifest of the Module-1 deployment, at the commit that the settings name. */
const MANIFEST_BASE = 'https://raw.githubusercontent.com/Apex-Fusion/vector-agent-modules';
/** A challenge needs this much of the window of a claim left, so a claim that the kit stakes here is one that a challenge can still target. */
const MIN_WINDOW_LEFT_MS = 600_000;
const READ_TIMEOUT_MS = 20_000;
const VALID_MINUTES = 30;
const RUNNING_IMAGES = 'running-images.json';
const NO_CLAIM_TOKEN = 'exactly one claim token of the Module-1 claim script';
const NOT_OPEN = 'not open';

const stepOfDocument = (agent: AgentSpec): string => `claim:${agent.id}:document`;
const stepOfClaim = (agent: AgentSpec): string => `claim:${agent.id}:claim`;
const stepOfWithdraw = (agent: AgentSpec): string => `withdraw:${agent.id}`;
const claimOf = (agent: AgentSpec) => CLAIM_OF_KIND[agent.kind];
const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));
/**
 * A wait that never holds the process open: the kit bounds each read, build and confirmation with it, and the timer is not cancelled when the work ends first. (`Promise.withResolvers` is not in the
 * types of the target of the pack.)
 */
const boundedSleep = (ms: number): Promise<void> => new Promise<void>((resolve) => { setTimeout(resolve, ms).unref(); });

/** What the state file keeps for a part of a step. */
interface PartNote { readonly tx_hash: string | null }

// ---- the plans of the two transactions of a claim, and of a withdrawal ----

/**
 * The guarded signer for the claim of a run. The step and the plan depend on the bytes of the transaction that the kit asks to sign. A transaction with an output at the claim script is the claim:
 * the service wallet may lose the stake and the fee limit, the claim address is the one destination, and the transaction mints exactly one claim token. Any other transaction is the claim
 * document: the service wallet may lose the fee limit, it has no destination but the wallets, and it mints nothing. The one signer is the service key of the agent.
 */
export function claimRequest(host: Pick<LandHost, 'registry' | 'settings'>, agent: AgentSpec, module1: Module1Deployment, run: string): GuardedSignRequest {
  const isClaim = (facts: TxFacts): boolean => facts.outputs.some((output) => output.address === module1.claim.address);
  return {
    step: (facts) => (isClaim(facts) ? stepOfClaim(agent) : stepOfDocument(agent)),
    plan: (facts) => {
      if (!isClaim(facts)) return planOf(host, { outflow: { [agent.serviceKey]: host.settings.maxFeeLovelace } });
      const minted = Object.entries(facts.mint).filter(([unit, quantity]) => unit.startsWith(module1.claim.hash) && quantity === 1n).map(([unit]) => unit);
      // A claim mints one claim token. With no claim token, or with more than one, no unit of the bytes equals the plan, and the guard `mint` refuses.
      return planOf(host, {
        outflow: { [agent.serviceKey]: CLAIM_STAKE_LOVELACE + host.settings.maxFeeLovelace },
        destinations: [module1.claim.address],
        mint: { [minted.length === 1 ? minted[0]! : NO_CLAIM_TOKEN]: 1n },
        labels: { [module1.claim.address]: 'the claim script of Module-1' },
      });
    },
    signer: agent.serviceKey,
    facts: { run, claim_type: claimTypeOf(agent.capability) },
    notes: [`the service key of the agent ${agent.id} stakes ${units(CLAIM_STAKE_LOVELACE)} for ${duration(CLAIM_WINDOW_MS)} as the claim of the run ${run}`],
  };
}

/**
 * The guarded signer for the withdrawal of a claim. The transaction spends the claim output at the claim script, so the plan explains that output. It burns the claim token, and the stake goes back to
 * the service wallet: the wallet may lose the fee limit and no more.
 */
export function withdrawRequest(host: Pick<LandHost, 'registry' | 'settings'>, agent: AgentSpec, module1: Module1Deployment, run: string, fact: ClaimFact): GuardedSignRequest {
  return {
    step: stepOfWithdraw(agent),
    plan: planOf(host, {
      outflow: { [agent.serviceKey]: host.settings.maxFeeLovelace },
      explained: [fact.claimRef],
      mint: { [`${module1.claim.hash}${fact.claimToken}`]: -1n },
      labels: { [module1.claim.address]: 'the claim script of Module-1' },
    }),
    signer: agent.serviceKey,
    refs: { claim: fact.claimRef },
    facts: { run },
    notes: [`the service key of the agent ${agent.id} takes back the stake of the claim of the run ${run}, which nobody challenged`],
  };
}

// ---- the kit over the chain of the session ----

/** The Module-1 deployment, read once for each session from the manifest at the pinned commit. It must name the identity registry of the chain of the session. */
const DEPLOYMENTS = new WeakMap<object, Promise<Module1Deployment>>();

async function readModule1(session: TaskSession<ClaimExtra>): Promise<Module1Deployment> {
  const commit = session.settings.module1Commit;
  if (commit === null) throw new PreconditionError('OPERATOR_MODULE1_COMMIT is not set: it is the 40 hex digits of the commit of the Module-1 manifest that the deployment uses');
  const source = `${MANIFEST_BASE}/${commit}/${session.use.moduleManifestPath}`;
  let module1: Module1Deployment;
  try {
    module1 = module1FromManifest(await readManifest(source, 'The Module-1 manifest', session.fetchImpl), source);
  } catch (err) {
    throw new PreconditionError(`the Module-1 manifest cannot be used: ${errorText(err)}`);
  }
  if (module1.identityHash !== session.chain.deployment.identity.hash) {
    throw new PreconditionError(`the Module-1 manifest names the identity registry ${module1.identityHash}, and the chain of this run uses ${session.chain.deployment.identity.hash}: the commit of the manifest is wrong`);
  }
  return module1;
}

function module1Of(session: TaskSession<ClaimExtra>): Promise<Module1Deployment> {
  let held = DEPLOYMENTS.get(session);
  if (held === undefined) {
    held = readModule1(session);
    DEPLOYMENTS.set(session, held);
  }
  return held;
}

/** The provider of the chain, as the kit needs it: a provider that gives the start time of the chain. */
function withStartTime(provider: TaskSession['chain']['provider']): Module1Provider {
  if (typeof (provider as Partial<Module1Provider>).getSystemStartMs !== 'function') throw new PreconditionError('the provider of the chain gives no start time of the chain, and a Module-1 build needs it');
  return provider as Module1Provider;
}

function refuseSigning(): never {
  throw new Error('this read signs nothing');
}

interface Kit {
  readonly dispute: Dispute;
  /** The chain port under the dispute code, for the read that the dispute code does not give: the live claim outputs in every state. */
  readonly port: Module1Port;
  /** The errors that the signer threw, in order: the kit turns each into the text of a refusal, so the task reads the cause here. */
  readonly stops: readonly Error[];
}

/**
 * The dispute code of the kit for the service key of an agent: the real chain port over the recording provider, with the guarded signer of `request` as its signature, or with a signature that
 * throws when `request` is null (a read). The port and the dispute code check their settings at the start, and a refusal is a PreconditionError.
 */
function kitOf(session: TaskSession<ClaimExtra>, agent: AgentSpec, module1: Module1Deployment, id: string, request: GuardedSignRequest | null): Kit {
  const provider = recordingProvider(withStartTime(session.chain.provider));
  const stops: Error[] = [];
  const signer = request === null ? refuseSigning : guardedSign(session, request, provider);
  const sign = (unsignedCborHex: string): { signedCborHex: string; txHashHex: string } => {
    try { return signer(unsignedCborHex); } catch (err) {
      if (err instanceof Error) stops.push(err);
      throw err;
    }
  };
  const clock = (): number => session.clock.now();
  try {
    const port = createModule1Port({
      provider, module1, address: session.registry.addressOf(agent.serviceKey), agent_id: id, sign, clock, sleep: boundedSleep, koios_url: session.chain.koiosUrl, fetch: session.chain.fetchImpl,
      identity_deployment: null, valid_minutes: VALID_MINUTES,
    });
    const dispute = new Dispute({
      port, queue: createSerialQueue(), clock, sleep: boundedSleep,
      settings: { challenge_stake_lovelace: CLAIM_STAKE_LOVELACE, min_window_left_ms: MIN_WINDOW_LEFT_MS, read_timeout_ms: READ_TIMEOUT_MS },
    });
    return { dispute, port, stops };
  } catch (err) {
    throw new PreconditionError(`the kit cannot be set up for the agent ${agent.id}: ${errorText(err)}`);
  }
}

// ---- the preconditions of a claim ----

/** The record of the agent in the facts, with its manifest hash. */
function factsOf(session: TaskSession<ClaimExtra>, agent: AgentSpec): { readonly did: string; readonly id: string; readonly manifestSha256: string } {
  const facts = session.facts.read();
  const record = facts.records[agent.id];
  if (record === undefined) throw new PreconditionError(`the facts hold no record of the agent ${agent.id}: run the task register first`);
  const manifest = facts.manifests[agent.id];
  if (manifest === undefined) throw new PreconditionError(`the facts hold no manifest of the agent ${agent.id}: the claim document holds the hash of the manifest, so run the task advert first`);
  return { did: record.did, id: record.id, manifestSha256: manifest.sha256 };
}

/** The record on the chain is Active and lists the service key with the transaction purpose. */
async function requireRecordOnChain(session: TaskSession<ClaimExtra>, agent: AgentSpec, id: string): Promise<void> {
  const found = await findRecord(session.chain.provider, session.chain.deployment, id);
  if (found === null) throw new PreconditionError(`the record of the agent ${agent.id} is not in the identity registry: wait for its registration to be confirmed`);
  if (found.record.lineage.type !== 'Root') throw new PreconditionError(`the record of the agent ${agent.id} is a subagent, and a claim is staked for a root record`);
  const now = session.clock.now();
  const status = effectiveStatus(found.record, new Map(), now, now);
  if (status !== 'Active') throw new PreconditionError(`the record of the agent ${agent.id} is ${status}: it must be Active`);
  const hash = session.registry.hashOf(agent.serviceKey);
  const listed = found.record.keys.some((key) => key.keyType === 'Ed25519' && keyHashOf(key.key) === hash && (key.purposes & PURPOSE.transaction) !== 0);
  if (!listed) throw new PreconditionError(`the record of the agent ${agent.id} does not list the service key ${hash} with the transaction purpose`);
}

/**
 * The service wallet holds a pure output of 5 units or more (the collateral of the claim), and at least the stake, the fee buffer of a Module-1 build and the fee limits of the two transactions.
 * For a run of the kind `failure`, a wallet with a challenge reserve must still hold that reserve after the claim. An open claim of an earlier run keeps its stake locked.
 */
async function requireFunds(session: TaskSession<ClaimExtra>, agent: AgentSpec, kind: Kind): Promise<void> {
  const outputs = await session.chain.provider.getUtxos(session.registry.addressOf(agent.serviceKey));
  if (!outputs.some(isCollateralOutput)) throw new PreconditionError(`the service wallet of the agent ${agent.id} holds no pure output of 5 units or more: the claim runs a script, and the script needs one as collateral`);
  const held = outputs.reduce((sum, output) => sum + (output.assets.lovelace ?? 0n), 0n);
  const fees = 2n * session.settings.maxFeeLovelace;
  const needed = CLAIM_STAKE_LOVELACE + MODULE1_FEE_BUFFER + fees;
  if (held < needed) {
    throw new PreconditionError(`the service wallet of the agent ${agent.id} holds ${units(held)}, and the claim needs ${units(needed)}: the stake, the fee buffer of a Module-1 build and the fee limits of the two transactions. ${units(needed - held)} are missing`);
  }
  const reserve = agent.claim.challengeReserveLovelace;
  if (kind === 'failure' && reserve !== null) {
    const left = held - CLAIM_STAKE_LOVELACE - fees;
    if (left < reserve) {
      throw new PreconditionError(
        `the service wallet of the agent ${agent.id} would hold ${units(left)} after the claim and its fees, and the run of the kind failure needs ${units(reserve)} for a challenge: ${units(reserve - left)} are missing. `
        + 'An open claim of an earlier run keeps its stake locked: withdraw it with cleanup after its window, or fund the wallet',
      );
    }
  }
}

/** Every runtime of the use case that runs says free. The file `running-images.json` of the state folder decides which runtimes run. */
async function requireFree(session: TaskSession<ClaimExtra>): Promise<void> {
  const running = readRunning(join(session.settings.stateDir, RUNNING_IMAGES), session.clock.now());
  await requireRuntimesFree({ fetchImpl: session.fetchImpl, runtimes: session.use.agents.flatMap((agent) => runtimesOf(agent)), running, out: session.out });
}

// ---- the claim of a run ----

/** What a kit result that did not finish becomes: the first refusal of the signer when nothing landed, and else an error that names what landed. */
function stakeFailure(agent: AgentSpec, result: RunClaimNotStaked, stops: readonly Error[]): Error {
  const landed = result.document !== null || result.sent !== null;
  const cause = stops.find((stop) => !(stop instanceof DryStop));
  if (!landed) return cause ?? new PreconditionError(`the claim of the agent ${agent.id} is not staked (${result.code}): ${result.detail}`);
  const lines = [`the claim of the agent ${agent.id} is not staked (${result.code}): ${result.detail}`];
  if (result.document !== null) {
    lines.push(`The claim document landed in ${result.document.tx_hash}, and the state file keeps it. A new run publishes a second claim document (about 0.2 units), which is harmless.`);
  }
  if (result.sent !== null) lines.push(`The transaction ${result.sent.tx_hash} was sent and is not seen confirmed. It may land until ${iso(result.sent.valid_to)}. The next run settles it before it builds anything.`);
  return new Error(lines.join(' '));
}

/** The fact of a claim, from what the chain shows of it. A claim that is not the claim of this run's constants is no claim of the task. */
function factOfView(agent: AgentSpec, did: string, view: ClaimView, documentTx: string, claimTx: string): ClaimFact {
  if (view.claimer !== did || view.claim_type !== claimTypeOf(agent.capability) || view.stake_lovelace !== CLAIM_STAKE_LOVELACE || view.challenge_window_ms !== CLAIM_WINDOW_MS) {
    throw new PreconditionError(`the claim ${view.ref} on the chain is not a claim of the agent ${agent.id} with the stake, the window and the claim type of the constants: it is not recorded`);
  }
  return {
    claimRef: view.ref, documentTx, claimTx, claimToken: view.token, stakeLovelace: String(view.stake_lovelace), windowMs: view.challenge_window_ms, stakedAt: iso(view.submitted_at),
    withdrawableFrom: iso(withdrawableFrom(view)), withdrawTx: null,
  };
}

function showsOf(fact: ClaimFact): Record<string, unknown> {
  return {
    claim: fact.claimRef, claim_token: fact.claimToken, document_tx: fact.documentTx, claim_tx: fact.claimTx, stake_lovelace: fact.stakeLovelace, window_ms: fact.windowMs, staked_at: fact.stakedAt,
    withdrawable_from: fact.withdrawableFrom,
  };
}

/** Records the step of an agent from the fact of its claim, and the evidence entry that shows the claim token, the document transaction and the claim transaction. */
function recordStake(session: TaskSession<ClaimExtra>, agent: AgentSpec, fact: ClaimFact): void {
  recordKitLanding(session, { step: agent.id, txHash: fact.claimTx, refs: { claim: fact.claimRef }, facts: { claim_token: fact.claimToken, document_tx: fact.documentTx }, shows: showsOf(fact) });
}

/** The transaction that a part of the state file names. A part that names none is a damaged state file, and the task stops. */
function txOfPart(part: PartNote | undefined, run: string, agent: AgentSpec, what: string): string | undefined {
  if (part === undefined) return undefined;
  if (part.tx_hash === null) throw new PreconditionError(`the state file of the run ${run} holds no ${what} transaction of the agent ${agent.id}`);
  return part.tx_hash;
}

/**
 * The claim of this run exists already, or may exist. Three files can say so: the facts hold it; the state file holds the part that the claim transaction made (the task stopped after the claim landed);
 * or the state file holds only the part of the claim document (the claim transaction was signed, and the runner let its flight go as lost, because the indexer did not know the transaction when its
 * validity ended). In the last two cases the claim is read from the chain: it is the open claim of the agent that the claim transaction made or, with no claim part, the open claim whose claim document
 * is the transaction of the document part. The step is recorded and nothing is staked. A claim part with no such open claim stops the task: the claim may be challenged or spent, and a new claim could be
 * a second one. A document part with no such open claim says that no claim was made from the document, so the result is null and the caller stakes a new claim with a new document.
 * A dry run says what the next run does and writes nothing.
 */
async function resumeStake(session: TaskSession<ClaimExtra>, agent: AgentSpec, run: string, held: ClaimFact | undefined): Promise<StepOutcome | null> {
  const known = factsOf(session, agent);
  const claimTx = txOfPart(session.state.note<PartNote>(`part.${stepOfClaim(agent)}`), run, agent, 'claim');
  const documentTx = txOfPart(session.state.note<PartNote>(`part.${stepOfDocument(agent)}`), run, agent, 'claim document');
  let fact = held;
  if (fact === undefined) {
    if (claimTx === undefined && documentTx === undefined) return null;
    const module1 = await module1Of(session);
    const listed = await kitOf(session, agent, module1, known.id, null).dispute.listOpenClaims(known.did);
    if (!listed.ok) throw new PreconditionError(`the open claims of the agent ${agent.id} cannot be read (${listed.code}): ${listed.detail}`);
    const view = listed.value.find((claim) => (claimTx === undefined ? txHashOfUri(claim.claim_uri) === documentTx : claim.ref.startsWith(`${claimTx}#`)));
    if (view === undefined) {
      if (claimTx === undefined) return null;
      throw new PreconditionError(`the claim transaction ${claimTx} of the agent ${agent.id} is in the state file, and the chain shows no open claim that it made. It may be challenged or spent: read the chain before another claim is staked`);
    }
    const documentOfClaim = documentTx ?? txHashOfUri(view.claim_uri);
    if (documentOfClaim === null) throw new PreconditionError(`the claim document of the claim ${view.ref} is named by no state file part and no address that can be read, so the claim is not recorded`);
    fact = factOfView(agent, known.did, view, documentOfClaim, view.ref.slice(0, view.ref.indexOf('#')));
  }
  if (session.mode === 'dry') {
    session.out.out(`dry run: the claim of the agent ${agent.id} for the run ${run} is staked already, and the next run with --submit records the step. It stakes no second claim. The claim is ${fact.claimRef}.`);
    return { kind: 'dry' };
  }
  if (held === undefined) session.facts.put('claims', [run, agent.id], fact);
  recordStake(session, agent, fact);
  return { kind: 'done', message: `the claim of the agent ${agent.id} for the run ${run} was staked in an earlier run (${fact.claimRef}): the step is recorded, and no second claim is staked` };
}

/**
 * An open claim of the agent with the stake, the window and the claim type of the constants that no run of the facts holds is an orphan. An earlier run can have stopped after its claim landed and lost
 * its state, and then a new claim would be a second one for the same agent. The task stops, and the operator reads the chain: the facts do not hold the claim, so `cleanup` does not withdraw it.
 */
async function requireNoOrphan(session: TaskSession<ClaimExtra>, agent: AgentSpec, module1: Module1Deployment, known: { readonly id: string; readonly did: string }): Promise<void> {
  const listed = await kitOf(session, agent, module1, known.id, null).dispute.listOpenClaims(known.did);
  if (!listed.ok) throw new PreconditionError(`the open claims of the agent ${agent.id} cannot be read (${listed.code}): ${listed.detail}`);
  const recorded = new Set<string>();
  for (const byAgent of Object.values(session.facts.read().claims)) {
    const fact = byAgent[agent.id];
    if (fact !== undefined) recorded.add(fact.claimRef);
  }
  const orphans = listed.value.filter((view) => (
    view.claim_type === claimTypeOf(agent.capability) && view.stake_lovelace === CLAIM_STAKE_LOVELACE && view.challenge_window_ms === CLAIM_WINDOW_MS && !recorded.has(view.ref)
  ));
  if (orphans.length > 0) {
    throw new PreconditionError(
      `the agent ${agent.id} has ${orphans.length} open claim(s) with the stake, the window and the claim type of the constants that no run of the facts holds (${orphans.map((view) => view.ref).join(', ')}). `
      + 'A run that stopped after its claim landed can have made it, and a new claim would be a second one. Read the chain: the facts do not hold the claim, so cleanup does not withdraw it. Record it in the facts or withdraw it by hand, then run again',
    );
  }
}

async function stakeStep(session: TaskSession<ClaimExtra>, agent: AgentSpec): Promise<StepOutcome> {
  const { run, kind } = session.extra;
  if (run === null) throw new FlagError('give --run <label>');
  if (kind === null) throw new FlagError('give --kind clean or failure: the kind of the run that the claim is for');
  const known = factsOf(session, agent);
  const resumed = await resumeStake(session, agent, run, session.facts.read().claims[run]?.[agent.id]);
  if (resumed !== null) return resumed;

  const module1 = await module1Of(session);
  await requireRecordOnChain(session, agent, known.id);
  await requireFunds(session, agent, kind);
  await requireFree(session);
  await requireNoOrphan(session, agent, module1, known);

  const { dispute, stops } = kitOf(session, agent, module1, known.id, claimRequest(session, agent, module1, run));
  const result = await dispute.stakeRunClaim({
    capability_id: agent.capability, manifest_sha256: known.manifestSha256, claim: claimOf(agent), stake_lovelace: CLAIM_STAKE_LOVELACE, challenge_window_ms: CLAIM_WINDOW_MS,
    claim_type: claimTypeOf(agent.capability),
  });
  if (!result.ok) {
    if (stops[0] instanceof DryStop) {
      session.out.out(`dry run: the claim document of the agent ${agent.id} is built and judged, and nothing is signed. The claim transaction is built after the document is confirmed, so a dry run cannot show it.`);
      return { kind: 'dry' };
    }
    throw stakeFailure(agent, result, stops);
  }
  const value = result.value;
  const fact: ClaimFact = {
    claimRef: value.claim, documentTx: value.document.tx_hash, claimTx: value.claim_tx, claimToken: value.claim_token, stakeLovelace: String(value.stake_lovelace), windowMs: value.challenge_window_ms,
    stakedAt: iso(value.submitted_at), withdrawableFrom: iso(withdrawableFrom({ submitted_at: value.submitted_at, challenge_window_ms: value.challenge_window_ms })), withdrawTx: null,
  };
  // The facts first: when the facts cannot be written, the claim stays in flight in the state file, and the next run settles it and records the claim from the chain.
  session.facts.put('claims', [run, agent.id], fact);
  recordStake(session, agent, fact);
  return {
    kind: 'done',
    message: `the claim of the agent ${agent.id} is staked: ${fact.claimRef}, ${units(value.stake_lovelace)} for ${duration(value.challenge_window_ms)}. It can be withdrawn from ${fact.withdrawableFrom}.`,
  };
}

// ---- the withdrawal ----

function withdrawFailure(agent: AgentSpec, result: WithdrawNotDone, stops: readonly Error[]): Error {
  const cause = stops.find((stop) => !(stop instanceof DryStop));
  if (result.sent === null) return cause ?? new PreconditionError(`the claim of the agent ${agent.id} is not withdrawn (${result.code}): ${result.detail}`);
  return new Error(
    `the claim of the agent ${agent.id} is not withdrawn (${result.code}): ${result.detail} The transaction ${result.sent.tx_hash} was sent and is not seen confirmed. It may land until ${iso(result.sent.valid_to)}. The next run settles it before it builds anything.`,
  );
}

/** What the live challenges say of the end of the challenge that moved a claim: its end in POSIX milliseconds, or null when none is named, and the reason that none is named (null when no challenge holds the claim token). */
interface ChallengeEnd { readonly endMs: number | null; readonly note: string | null }

type Withdrawal =
  | { readonly kind: 'withdrawn' | 'not_open' | 'not_seen' | 'dry' }
  | { readonly kind: 'wait'; readonly untilMs: number | null }
  /** The claim token is in the live output `ref`, and that output is not Open: a challenge moved the claim, and the jury decides it, or its verdict is not spent yet. */
  | { readonly kind: 'moved'; readonly state: 'Validated' | 'Invalidated'; readonly ref: string }
  /** The same for a claim that is Challenged: the end of its challenge comes with the result. */
  | { readonly kind: 'moved'; readonly state: 'Challenged'; readonly ref: string; readonly end: ChallengeEnd };

/**
 * A claim is recorded as not open only when the indexer shows its output as spent. The node cannot tell "spent" from "not seen yet": a node that is behind passes the network guard and shows no output, and
 * the output of another claim script, which the Module-1 manifest of a wrong commit does not read as a claim, shows no open claim either. So the task asks Koios `utxo_info` for the output, and only a row
 * that says `is_spent` lets the claim be recorded. A row that says unspent, a row that says nothing about it, no row (the indexer does not know the output yet) and an indexer that cannot be read stop the
 * task with exit 2, and nothing is recorded.
 */
async function requireOutputSpent(session: TaskSession<ClaimExtra>, agent: AgentSpec, fact: ClaimFact): Promise<void> {
  const { txHash, outputIndex } = parseOutRef(fact.claimRef);
  const named = `the claim output ${fact.claimRef} of the agent ${agent.id}`;
  let row: { readonly is_spent?: boolean } | undefined;
  try {
    row = (await koiosUtxoInfo(session.chain.koiosUrl, [fact.claimRef], session.chain.fetchImpl)).find((entry) => entry.tx_hash === txHash && entry.tx_index === outputIndex);
  } catch (err) {
    throw new PreconditionError(`the indexer cannot be read (${errorText(err)}), so nothing says that ${named} is spent, and it is not recorded as not open. Run cleanup again when the indexer answers`);
  }
  if (row === undefined) {
    throw new PreconditionError(`the indexer does not know ${named}, so nothing says that it is spent: the indexer may be behind, and the claim is not recorded as not open. Run cleanup again later`);
  }
  if (row.is_spent === false) {
    throw new PreconditionError(
      `the indexer shows ${named} as unspent, while the node and the Module-1 manifest of this run read no open claim in it: the node may be behind, or the commit of the manifest (OPERATOR_MODULE1_COMMIT) names another claim script. The claim is not recorded as not open`,
    );
  }
  if (row.is_spent !== true) throw new PreconditionError(`the indexer does not say whether ${named} is spent, and it is not recorded as not open`);
}

/**
 * The answer of a read of the chain port that gives a list, with the bound of the reads of the kit: a read that is not done within `READ_TIMEOUT_MS` throws, and the read that lost is left to end alone, so
 * its error is not an unhandled one.
 */
async function withinReadBound<T>(running: Promise<readonly T[]>): Promise<readonly T[]> {
  running.catch(() => undefined);
  const answer = await Promise.race([running, boundedSleep(READ_TIMEOUT_MS).then(() => null)]);
  if (answer === null) throw new Error(`no answer came within ${READ_TIMEOUT_MS} ms`);
  return answer;
}

/** The live claim outputs of the chain in every state, from one read of the chain port, with the bound of the reads of the kit. */
export async function readLiveClaims(port: Pick<Module1Port, 'readClaims'>): Promise<readonly ClaimView[]> {
  return withinReadBound(port.readClaims());
}

/**
 * The live claim output that holds the claim token of `fact`, in any state, or null when no live output holds it: the claim is withdrawn or resolved, and its token is burned. A challenge spends the claim
 * output and makes a new one that holds the token, so a spent output of the facts does not say that the claim is over. Only a read that answers in full says that no output holds the token. A read that fails
 * or is not done in time stops the task with exit 2. So do a list with two outputs that hold the token, and an output that holds the token and names another claimer than the agent: nothing is recorded.
 */
async function liveHolderOf(session: TaskSession<ClaimExtra>, agent: AgentSpec, module1: Module1Deployment, known: { readonly id: string; readonly did: string }, fact: ClaimFact): Promise<ClaimView | null> {
  const { port } = kitOf(session, agent, module1, known.id, null);
  const named = `the claim ${fact.claimRef} of the agent ${agent.id}`;
  let views: readonly ClaimView[];
  try {
    views = await readLiveClaims(port);
  } catch (err) {
    throw new PreconditionError(`the live claim outputs cannot be read (${errorText(err)}), so nothing says whether ${named} is over, and it is not recorded as not open. Run claim cleanup again when the chain answers`);
  }
  const holders = views.filter((view) => view.token === fact.claimToken);
  if (holders.length > 1) {
    throw new PreconditionError(`${holders.length} live outputs hold the claim token of ${named} (${holders.map((view) => view.ref).join(', ')}), so the task cannot tell which one is the claim, and nothing is recorded. Read the chain`);
  }
  const [holder] = holders;
  if (holder !== undefined && holder.claimer !== known.did) {
    throw new PreconditionError(`the output ${holder.ref} holds the claim token of ${named}, and its claimer is ${holder.claimer}, not ${known.did}: nothing is recorded. Read the chain`);
  }
  return holder ?? null;
}

/**
 * The end of the challenge that moved a claim: the time of the challenge plus its resolution deadline. The challenge must be resolved before that time, and after it anyone can submit TimeoutResolve. The end
 * is named only when exactly one live challenge output holds the claim token. The challenge that moved a claim stays live while the claim is Challenged, so it is that one output, and a second output that
 * holds the token (any auditor makes an output with any claim token) is one that the task cannot tell from it: then no end is named. A read that fails or is not done in time names no end either, and the
 * note says why. When no challenge output holds the token, the output is not seen yet or a verdict has spent it, and there is no note.
 */
async function challengeEndOf(session: TaskSession<ClaimExtra>, agent: AgentSpec, module1: Module1Deployment, known: { readonly id: string }, fact: ClaimFact): Promise<ChallengeEnd> {
  const { port } = kitOf(session, agent, module1, known.id, null);
  let challenges: readonly ChallengeView[];
  try { challenges = await withinReadBound(port.readChallenges()); } catch (err) {
    return { endMs: null, note: `The end of the challenge could not be read (${errorText(err)}).` };
  }
  const holders = challenges.filter((challenge) => challenge.claim_token === fact.claimToken);
  if (holders.length > 1) return { endMs: null, note: `${holders.length} challenge outputs hold the claim token, so the end of the challenge is not named.` };
  const [holder] = holders;
  return { endMs: holder === undefined ? null : holder.challenged_at + holder.resolution_deadline_ms, note: null };
}

/**
 * Withdraws the claim of one agent. The window is checked from the facts first: the kit checks it again from the chain. A claim that the chain shows as not open is judged only by a submit run whose network
 * guard passed, and only when the indexer shows its output as spent (`requireOutputSpent`). A dry run, and a run whose guard failed (a node of another network shows no claim), say what they saw and record
 * nothing. A spent output does not end a claim, because a challenge makes a new output that holds the same token, so `liveHolderOf` finds the live output that holds it. When none does, the token is burned: the
 * claim is recorded as `not open`, and the fact ends the claim for good, because the next cleanup skips it. A holder in the state Open is withdrawn from: the same steps run again with the output of the holder
 * (`isNewOutput`), and a second `claim_not_open` stops the task. A holder in another state is a claim that the jury decides, or whose verdict is not spent yet: the result is `moved`, and nothing is recorded.
 * The result for a Challenged holder holds the end of its challenge (`challengeEndOf`).
 */
async function withdrawOne(session: TaskSession<ClaimExtra>, agent: AgentSpec, run: string, fact: ClaimFact, module1: Module1Deployment, isNewOutput = false): Promise<Withdrawal> {
  const known = factsOf(session, agent);
  const { dispute, stops } = kitOf(session, agent, module1, known.id, withdrawRequest(session, agent, module1, run, fact));
  const result = await dispute.withdrawClaim({ claim: fact.claimRef });
  if (result.ok) {
    const value = result.value;
    recordKitLanding(session, {
      step: stepOfWithdraw(agent), txHash: value.withdraw_tx, refs: { claim: fact.claimRef, payout: value.payout }, facts: { run },
      shows: { claim: fact.claimRef, claim_token: fact.claimToken, withdraw_tx: value.withdraw_tx, payout: value.payout, stake_lovelace: String(value.stake_lovelace) },
    });
    session.facts.put('claims', [run, agent.id, 'withdrawTx'], value.withdraw_tx);
    return { kind: 'withdrawn' };
  }
  if (stops[0] instanceof DryStop) return { kind: 'dry' };
  if (result.code === 'claim_not_open') {
    if (session.mode === 'submit' && session.networkResult()?.ok === true) {
      if (isNewOutput) {
        throw new PreconditionError(`the claim output ${fact.claimRef} of the agent ${agent.id} was open when it was read, and it is not open now: the claim moved again, so nothing is recorded. Run claim cleanup again`);
      }
      await requireOutputSpent(session, agent, fact);
      const holder = await liveHolderOf(session, agent, module1, known, fact);
      if (holder === null) {
        session.facts.put('claims', [run, agent.id, 'withdrawTx'], NOT_OPEN);
        return { kind: 'not_open' };
      }
      if (holder.state === 'Open') return withdrawOne(session, agent, run, { ...fact, claimRef: holder.ref }, module1, true);
      if (holder.state === 'Challenged') return { kind: 'moved', state: holder.state, ref: holder.ref, end: await challengeEndOf(session, agent, module1, known, fact) };
      return { kind: 'moved', state: holder.state, ref: holder.ref };
    }
    return { kind: 'not_seen' };
  }
  if (result.code === 'window_not_ended') {
    const due = Date.parse(fact.withdrawableFrom);
    return { kind: 'wait', untilMs: Number.isFinite(due) && due > session.clock.now() ? due : null };
  }
  if (result.code === 'not_claimer') throw new PreconditionError(`the service key of the agent ${agent.id} is not the claimer of the claim ${fact.claimRef}: ${result.detail}`);
  throw withdrawFailure(agent, result, stops);
}

async function cleanup(session: TaskSession<ClaimExtra>): Promise<StepOutcome> {
  const { run, trial } = session.extra;
  if (trial) throw new FlagError('--trial belongs to the command run');
  if (run === null) throw new FlagError('give --run <label>');
  const claims = session.facts.read().claims[run];
  if (claims === undefined || Object.keys(claims).length === 0) throw new PreconditionError(`the facts hold no claim of the run ${run}: nothing is withdrawn`);
  // A Module-1 build spends every output of the service wallet but one, and a running service uses the same wallet.
  await requireFree(session);
  const module1 = await module1Of(session);
  const out = session.out;
  let dry = false;
  const unseen: string[] = [];
  const waits: number[] = [];
  let waiting = false;
  const lines: string[] = [];
  for (const agent of session.use.agents) {
    const fact = claims[agent.id];
    if (fact === undefined) continue;
    if (fact.withdrawTx !== null) {
      lines.push(`the claim of the agent ${agent.id} is settled already (${fact.withdrawTx})`);
      continue;
    }
    // A withdrawal that landed in an earlier run, whose fact was not written: the part of the state file names the transaction.
    const part = session.state.note<PartNote>(`part.${stepOfWithdraw(agent)}`);
    if (part !== undefined && part.tx_hash !== null) {
      if (session.mode === 'submit') session.facts.put('claims', [run, agent.id, 'withdrawTx'], part.tx_hash);
      lines.push(`the claim of the agent ${agent.id} was withdrawn in ${part.tx_hash}`);
      continue;
    }
    const due = Date.parse(fact.withdrawableFrom);
    if (!Number.isFinite(due)) throw new PreconditionError(`the facts of the claim of the agent ${agent.id} hold no time that can be read for the end of its window`);
    if (session.clock.now() < due) {
      waiting = true;
      waits.push(due);
      lines.push(`the window of the claim of the agent ${agent.id} ends at ${fact.withdrawableFrom}: ${duration(due - session.clock.now())} are left`);
      continue;
    }
    const done = await withdrawOne(session, agent, run, fact, module1);
    if (done.kind === 'dry') {
      dry = true;
      lines.push(`dry run: the withdrawal of the claim of the agent ${agent.id} is built and judged, and nothing is signed`);
    } else if (done.kind === 'wait') {
      waiting = true;
      if (done.untilMs !== null) waits.push(done.untilMs);
      lines.push(`the chain says that the window of the claim of the agent ${agent.id} has not ended`);
    } else if (done.kind === 'moved') {
      waiting = true;
      if (done.state === 'Challenged') {
        const { endMs, note } = done.end;
        if (endMs !== null && endMs > session.clock.now()) waits.push(endMs);
        const named = endMs === null ? '' : ` The challenge must be resolved before ${iso(endMs)} (the time of the challenge plus its resolution deadline). After that time anyone can submit TimeoutResolve.`;
        lines.push(`the claim of the agent ${agent.id} is challenged (its token is in ${done.ref}): nothing is recorded.${named}${note === null ? '' : ` ${note}`} Run claim cleanup again after the verdict`);
      } else {
        lines.push(`the claim of the agent ${agent.id} is ${done.state} (its token is in ${done.ref}), and that output is not spent yet: nothing is recorded. Run claim cleanup again after the output is spent`);
      }
    } else if (done.kind === 'not_open') {
      lines.push(`the claim of the agent ${agent.id} is not open (no live claim output holds its token: it is resolved or withdrawn): recorded as ${NOT_OPEN}`);
    } else if (done.kind === 'not_seen') {
      unseen.push(agent.id);
      lines.push(`the chain shows no open claim for the agent ${agent.id}, and ${session.mode === 'dry' ? 'a dry run' : 'a run whose network guard did not pass'} records nothing: the facts keep the claim as it is`);
    } else {
      lines.push(`the claim of the agent ${agent.id} is withdrawn`);
    }
  }
  for (const line of lines) out.out(line);
  if (unseen.length > 0 && session.mode === 'submit') {
    throw new PreconditionError(`the network guard did not pass, so the node cannot say that a claim is not open: nothing is recorded for ${unseen.join(' and ')}, and the claims stay as the facts hold them. Fix the settings of the node, and run cleanup again`);
  }
  if (waiting) {
    const until = waits.length === 0 ? null : Math.min(...waits);
    return { kind: 'wait', message: `a claim of the run ${run} cannot be withdrawn yet${until === null ? '' : `: the earliest wait ends at ${iso(until)}`}`, untilMs: until };
  }
  if (dry || unseen.length > 0) return { kind: 'dry' };
  return { kind: 'done', message: `every claim of the run ${run} is settled` };
}

// ---- status ----

async function status(session: TaskSession<ClaimExtra>): Promise<readonly string[]> {
  const { run } = session.extra;
  if (run === null) throw new FlagError('give --run <label>');
  const now = session.clock.now();
  const facts = session.facts.read();
  const lines = [`the claims of the run ${run}, from the facts:`];
  for (const agent of session.use.agents) {
    const fact = facts.claims[run]?.[agent.id];
    if (fact === undefined) {
      lines.push(`  ${agent.id}: no claim in the facts`);
      continue;
    }
    const due = Date.parse(fact.withdrawableFrom);
    const left = Number.isFinite(due) && due > now ? `${duration(due - now)} left` : 'the window has ended';
    lines.push(`  ${agent.id}: ${fact.claimRef}, ${units(BigInt(fact.stakeLovelace))} for ${duration(fact.windowMs)}, staked at ${fact.stakedAt}, withdrawable from ${fact.withdrawableFrom} (${left}), ${fact.withdrawTx === null ? 'not withdrawn' : `settled: ${fact.withdrawTx}`}`);
  }
  try {
    const module1 = await module1Of(session);
    for (const agent of session.use.agents) {
      const record = facts.records[agent.id];
      if (record === undefined) continue;
      const listed = await kitOf(session, agent, module1, record.id, null).dispute.listOpenClaims(record.did);
      if (!listed.ok) {
        lines.push(`the open claims of the agent ${agent.id} cannot be read (${listed.code})`);
        continue;
      }
      lines.push(`the open claims of the agent ${agent.id} on the chain: ${listed.value.length}`);
      for (const view of listed.value) {
        lines.push(`  ${view.ref}: ${units(view.stake_lovelace)}, type ${view.claim_type}, ${now < withdrawableFrom(view) ? `${duration(withdrawableFrom(view) - now)} until it can be withdrawn` : 'it can be withdrawn'}`);
      }
    }
  } catch (err) {
    lines.push(`the open claims on the chain are not read: ${errorText(err)}`);
  }
  return lines;
}

// ---- the trial documents ----

/** Build every document before writing any file. The trial receives public facts, but no chain or signing ports. */
function writeTrial({ use, facts, stateDir, out }: OfflineTaskInput<ClaimExtra>): OfflineTaskResult {
  const { cases: built, sample, subjects } = trialOf(use.name)(use, facts);
  const hashes: Record<string, string> = {};
  const cases = built.map(({ name, fields, files }) => ({
    case: name,
    ...fields,
    files: files.map((entry) => {
      const sha256 = createHash('sha256').update(entry.text, 'utf8').digest('hex');
      hashes[entry.file] = sha256;
      return { file: entry.file, bytes: Buffer.byteLength(entry.text, 'utf8'), sha256, ...(entry.juror === null ? {} : { document_hash: entry.juror.hash }) };
    }),
  }));
  const index = {
    format: 1,
    note: 'The documents are for a test of the jury. A value that the sample object marks as a sample is made up: the trial reads no chain and makes no transaction. The references and the claim token are always samples.',
    sample, ...subjects, cases,
  };
  const dir = join(stateDir, 'trial');
  for (const { files } of built) for (const entry of files) writeFileAtomically(join(dir, entry.file), entry.text);
  writeFileAtomically(join(dir, 'trial.json'), `${JSON.stringify(index, null, 2)}\n`);
  const names = built.map(({ name }) => name);
  const samples = Object.entries(sample).filter(([, made]) => made).map(([name]) => name.replaceAll('_', ' '));
  const perCase = built[0]?.files.length ?? 0;
  const counts = built.every(({ files }) => files.length === perCase)
    ? `${built.length} cases of ${perCase} files each`
    : `${built.length} cases with ${Object.keys(hashes).length} files`;
  out.out(`the trial documents are written: ${counts}, and trial.json with the size and the SHA-256 of each file`);
  out.out(`these values are samples that the trial made up: ${samples.join(', ')}`);
  return { message: `the trial documents are written for the cases ${names.join(', ')}`, result: { trial: true, cases: names, sample, sha256: hashes } };
}

// ---- the task ----

function handlersOf(session: TaskSession<ClaimExtra>): StepHandler<ClaimExtra>[] {
  return session.use.agents.map((agent): StepHandler<ClaimExtra> => ({ name: agent.id, run: (held) => stakeStep(held, agent) }));
}

const task: TaskDefinition<ClaimExtra> = {
  name: 'claim',
  title: 'Stake the claim of a run for each agent, and withdraw it after its window',
  flags: ['trial'],
  valued: ['kind'],
  needs: { keys: (use, flags) => (flags.has('trial') ? [] : use.agents.map((agent) => agent.serviceKey)), chain: true, hosted: [], approval: 'submit' },
  steps: (use, flags) => (flags.has('trial') ? [] : use.agents.map((agent) => agent.id)),
  parse(_env, _settings, _use, flags) {
    const trial = flags.has('trial');
    const asked = flags.value('kind');
    const kind = KINDS.find((entry) => entry === asked) ?? null;
    if (asked !== undefined && kind === null) throw new FlagError('--kind is clean or failure');
    if (trial && flags.has('submit')) throw new FlagError('--trial writes documents and signs nothing: it takes no --submit');
    const run = flags.value('run') ?? null;
    if (!trial && run === null) throw new FlagError('give --run <label>: the label of the run that the claims are for');
    return { trial, run, kind };
  },
  offline: { matches: ({ trial }) => trial, run: writeTrial },
  async next(session) {
    return runSteps(session, handlersOf(session));
  },
  cleanup,
  status,
  result(session) {
    const { run } = session.extra;
    if (run === null) return {};
    const claims = session.facts.read().claims[run] ?? {};
    const shown = Object.entries(claims).map(([id, fact]) => [id, {
      claimRef: fact.claimRef, documentTx: fact.documentTx, claimTx: fact.claimTx, claimToken: fact.claimToken, withdrawableFrom: fact.withdrawableFrom, withdrawTx: fact.withdrawTx,
    }] as const);
    return { run, claims: Object.fromEntries(shown) };
  },
};

export default task;
