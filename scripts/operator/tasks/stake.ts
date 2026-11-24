// scripts/operator/tasks/stake.ts - the task `stake`: the Module-3 self-stake of each agent of the use case. The owner of a stake is the service key of the agent and no other key.
// A stake is two transactions, made with two hosted tools and signed in process:
//   open    locks an opening output at the reputation address. No script runs. The service key signs.
//   create  spends that output with a redeemer, mints the stake token and locks the stake. The controller and the service key sign. The minimum of a stake never returns to its owner, so this step
//           carries the tag `stake`, and the approval must list it.
// Before a step builds, the record of the agent is read from the node: it must be in the facts file, Active, controlled by the controller key, and list the service key with the transaction
// purpose and the capability of the agent, byte for byte. The hosted builder checks the same rules, and the pack checks first, so that a refusal says what the pack needs. The step also checks
// that the service wallet holds a pure output of 5 units or more, and that no running runtime of the agent works (`running-images.json` decides which runtimes run).
// The plan of each step is judged against the bytes: the opening and the stake output must be at the reputation address with the datum of this agent, this owner and this capability, and
// the stake output must hold the stake token of the pack and exactly the stake of the data. The constants of the reputation validator below are held to a stake that the chain holds by a test.
import { join } from 'node:path';
import { collateralAdvice, isCollateralOutput } from '../../checks/lib/collateral.ts';
import { iso, units } from '../../checks/lib/format.ts';
import { GuardRefusal } from '../../checks/lib/land.ts';
import { PreconditionError } from '../../checks/lib/session.ts';
import type { StepOutcome } from '../../checks/lib/session.ts';
import type { OutputFacts, TxFacts } from '../../checks/lib/txfacts.ts';
import { verifyWithTools } from '../../checks/lib/verify.ts';
import type { ToolCheck } from '../../checks/lib/verify.ts';
// The pack's platform file gives no name of the stake codec, so this file takes it from the entry of vector-read.
import { decodeStakeDatum } from '../../../packages/vector-read/src/index.ts';
import type { StakeDatum } from '../../../packages/vector-read/src/index.ts';
import type { AgentSpec, HostedBuild, HostedLandSpec, TaskDefinition, TaskSession } from '../lib/contract.ts';
import { readRunning, requireRuntimesFree, runtimesOf } from '../lib/free.ts';
import { landHosted } from '../lib/land-hosted.ts';
import { planOf } from '../lib/plan.ts';
import { PURPOSE, blake2b256Hex, effectiveStatus, findRecord, keyHashOf, parseOutRef } from '../lib/platform.ts';
import { runSteps } from '../lib/runner.ts';
import type { StepHandler } from '../lib/runner.ts';

const TOOL_OPEN = 'vector_build_reputation_stake_open';
const TOOL_CREATE = 'vector_build_reputation_stake';
const TOOL_READ = 'vector_get_reputation_stake';

// ---- the reputation validator of the Module-3 deployment (public values, held to a recorded stake by test/stake.test.ts) ----
/** The exact stake address: the script credential of the reputation validator and no stake credential. Every opening output and every stake output is at this address. */
export const REPUTATION_ADDRESS = 'addr1w8adj3dtyrmp5k8mma4r8285jxyeklw5zelmvssqhsrqgfqc9uavs';
/** The reputation validator: the policy of the stake token and the script credential of the stake address. */
export const REPUTATION_POLICY = 'fad945ab20f61a58fbdf6a33a8f491899b7dd4167fb64200bc060424';
/** The UTF-8 bytes of `rstk_`, in hex: the start of the name of every stake token. */
const TOKEN_NAME_PREFIX = '7273746b5f';
/** The units that the opening output locks at least: the opening returns as change when the stake is created. */
export const OPENING_LOVELACE = 2_000_000n;
const IDENTIFIER = /^[0-9a-f]{64}$/;
const RETRY_WAIT_MS = 60_000;
const MAX_SHOWN = 120;

/**
 * The stake token of an agent, as one unit: the policy and the name. The name is `rstk_` and the first 27 bytes of the blake2b-256 hash of the 32 bytes of the AGENT identifier (the identifier of
 * its record), never of the stake or the opening: an agent has one token name, whatever its stake.
 */
export function stakeTokenUnit(agentId: string): string {
  if (!IDENTIFIER.test(agentId)) throw new Error('an agent identifier is 32 bytes: 64 lower-case hex characters');
  return `${REPUTATION_POLICY}${TOKEN_NAME_PREFIX}${blake2b256Hex(Buffer.from(agentId, 'hex')).slice(0, 54)}`;
}

type Part = 'open' | 'create';
interface Extra { result: Record<string, unknown> | null }
type Session = TaskSession<Extra>;
/** The record of the agent that passed the checks: its DID and its identifier. */
interface Ready { did: string; id: string }
/** The opening output that `create` spends: its reference and the units that it holds. */
interface Opening { ref: string; lovelace: bigint }

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const shown = (value: unknown): string => (typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint' ? JSON.stringify(String(value).slice(0, MAX_SHOWN)) : 'not a text or a number');
const hexOf = (text: string): string => Buffer.from(text, 'utf8').toString('hex');
const stepName = (agent: AgentSpec, part: Part): string => `${agent.id}:${part}`;

/** The amount of the tools: a number of units. The data holds lovelace, and a value that units cannot hold exactly is a mistake of the data. */
function unitsOf(lovelace: bigint): number {
  const value = Number(lovelace) / 1_000_000;
  if (!Number.isSafeInteger(Number(lovelace)) || lovelace <= 0n || BigInt(Math.round(value * 1_000_000)) !== lovelace) {
    throw new Error(`the stake of the data is ${lovelace} lovelace, and the tools take a positive amount of units that holds exactly`);
  }
  return value;
}

const LABELS = { [REPUTATION_ADDRESS]: 'the Module-3 stake address' };
const refuse = (step: string, message: string): GuardRefusal => new GuardRefusal(step, [{ guard: 'destinations', ok: false, message }]);

// ---- the preconditions of a step ----

/**
 * The record of the agent: in the facts file, on the node, a root record, Active, controlled by the controller key, and it lists the service key with the transaction purpose and the capability
 * of the agent. A refusal stops the step before anything is built.
 */
async function requireRecord(session: Session, agent: AgentSpec): Promise<Ready> {
  const held = session.facts.read().records[agent.id];
  if (held === undefined) throw new PreconditionError(`the facts file holds no record of ${agent.id}: register it first, and keep the facts file of the session`);
  const found = await findRecord(session.chain.provider, session.chain.deployment, held.id);
  if (found === null) throw new PreconditionError(`the record ${held.did} of ${agent.id} is not on the node: wait until its registration is confirmed there`);
  if (found.record.lineage.type !== 'Root') throw new PreconditionError(`the record ${held.did} of ${agent.id} is a subagent: the agents of this task are root records`);
  const now = session.clock.now();
  const status = effectiveStatus(found.record, new Map(), now, now);
  if (status !== 'Active') throw new PreconditionError(`the record ${held.did} of ${agent.id} is ${status}: it must be Active`);
  if (keyHashOf(found.record.controller).toLowerCase() !== session.registry.hashOf('controller')) {
    throw new PreconditionError(`the controller of the record ${held.did} is not the controller key of the registry: a stake needs the signature of the controller of the record`);
  }
  const serviceHash = session.registry.hashOf(agent.serviceKey);
  const listed = found.record.keys.some((key) => key.keyType === 'Ed25519' && keyHashOf(key.key).toLowerCase() === serviceHash && (key.purposes & PURPOSE.transaction) !== 0);
  if (!listed) throw new PreconditionError(`the record ${held.did} does not list the service key ${agent.serviceKey} with the transaction purpose: the service key owns the stake`);
  if (!found.record.capabilities.some((capability) => capability.toLowerCase() === hexOf(agent.capability))) {
    throw new PreconditionError(`the record ${held.did} does not list the capability ${agent.capability}, byte for byte: the stake backs that capability`);
  }
  return { did: held.did, id: held.id };
}

/** The service wallet holds a pure output of 5 units or more: the step `create` runs a script and needs it as collateral, and `open` leaves it alone. */
async function requireCollateralOutput(session: Session, agent: AgentSpec): Promise<void> {
  const address = session.registry.addressOf(agent.serviceKey);
  if (!(await session.chain.provider.getUtxos(address)).some(isCollateralOutput)) {
    throw new PreconditionError(`The service wallet ${address} of ${agent.id} has no pure output of 5 units or more. A stake runs a script in its second step, and the script needs one as collateral. ${collateralAdvice(address)}.`);
  }
}

/**
 * The reputation address holds no stake token of the agent. The hosted builder makes one stake for each agent and refuses a second, and the facts file may lack the first (a lost file, or a stake
 * that another run made), so the node decides. A second stake would lock the minimum twice, and the minimum never returns.
 */
async function requireNoStakeOnNode(session: Session, agent: AgentSpec, ready: Ready): Promise<void> {
  const unit = stakeTokenUnit(ready.id);
  const held = (await session.chain.provider.getUtxos(REPUTATION_ADDRESS)).find((utxo) => (utxo.assets[unit] ?? 0n) > 0n);
  if (held !== undefined) throw new PreconditionError(`the reputation address holds the stake of ${agent.id} already (${held.txHash}#${held.outputIndex}): a second stake would lock the minimum twice`);
}

/** The checks that both steps share, in this order: no transaction in flight, the record, no stake of the agent on the node, the wallet, and the runtimes of the agent. */
async function requireCommon(session: Session, agent: AgentSpec): Promise<Ready> {
  if (session.state.snapshot().in_flight !== null) throw new PreconditionError('a transaction is in flight: settle it before a stake step is built');
  const ready = await requireRecord(session, agent);
  await requireNoStakeOnNode(session, agent, ready);
  await requireCollateralOutput(session, agent);
  const running = readRunning(join(session.settings.stateDir, 'running-images.json'), session.clock.now());
  await requireRuntimesFree({ fetchImpl: session.fetchImpl, runtimes: runtimesOf(agent), running, out: session.out });
  return ready;
}

/**
 * The opening output of the facts file, read from the node. An output that the node does not show yet is a wait, and the step builds nothing. An output that is no opening of this agent
 * and this owner is a stop.
 */
async function openingOf(session: Session, agent: AgentSpec, ready: Ready, ref: string): Promise<Opening | StepOutcome> {
  let parsed: { txHash: string; outputIndex: number };
  try { parsed = parseOutRef(ref); } catch { throw new PreconditionError(`the opening reference of ${agent.id} in the facts file is not a reference of the form <hash>#<index>`); }
  const [utxo] = await session.chain.provider.getUtxosByOutRef([parsed]);
  if (utxo === undefined) {
    return {
      kind: 'wait', untilMs: session.clock.now() + RETRY_WAIT_MS,
      message: `the opening output ${ref} of ${agent.id} is not on the node yet: its transaction is not confirmed there. Run the step again in a minute`,
    };
  }
  if (utxo.address !== REPUTATION_ADDRESS || Object.keys(utxo.assets).some((unit) => unit !== 'lovelace') || utxo.datum === undefined || utxo.datum === null) {
    throw new PreconditionError(`the output ${ref} is no opening output: an opening output is at the reputation address, holds units only and has an inline datum`);
  }
  const problems = datumProblems(() => decodeStakeDatum(utxo.datum!), { id: ready.id, owner: session.registry.hashOf(agent.serviceKey), capability: agent.capability });
  if (problems.length > 0) throw new PreconditionError(`the output ${ref} is no opening output of ${agent.id}: ${problems.join('; ')}`);
  return { ref, lovelace: utxo.assets.lovelace ?? 0n };
}

// ---- what the bytes must say ----

interface Expect { id: string; owner: string; capability: string }

/** What a stake datum says that it must not: another agent, another owner, other capabilities. The decoder of the datum refuses a text that is no stake datum, and that is a problem too. */
function datumProblems(decode: () => StakeDatum, want: Expect): string[] {
  let datum: StakeDatum;
  try { datum = decode(); } catch { return ['the datum is no stake datum']; }
  const problems: string[] = [];
  if (datum.agent_did !== want.id) problems.push('the datum names another agent');
  if (datum.owner_pkh !== want.owner) problems.push('the datum names another owner than the service key');
  if (datum.staked_capabilities.length !== 1 || datum.staked_capabilities[0] !== hexOf(want.capability)) problems.push('the datum lists other capabilities than the capability of the agent');
  return problems;
}

/** The one output at the reputation address, or a refusal that names the rule. A transaction of this task has exactly one output there. */
function outputAt(step: string, facts: TxFacts, what: string): OutputFacts {
  const found = facts.outputs.filter((output) => output.address === REPUTATION_ADDRESS);
  if (found.length !== 1) throw refuse(step, `the transaction has ${found.length} output(s) at the reputation address, and ${what} has exactly one`);
  return found[0]!;
}

const datumOf = (step: string, output: OutputFacts): StakeDatum => {
  if (output.inlineDatum === null) throw refuse(step, 'the output at the reputation address has no inline datum');
  try { return decodeStakeDatum(output.inlineDatum); } catch { throw refuse(step, 'the datum of the output at the reputation address is no stake datum'); }
};

/** The opening output of the bytes: units only, at least the opening amount, and the datum of this agent, this owner and this capability. */
function openingOutput(step: string, want: Expect, facts: TxFacts): OutputFacts {
  const output = outputAt(step, facts, 'an opening');
  if (Object.keys(output.assets).length > 0) throw refuse(step, 'the opening output holds a token: it holds units only');
  if (output.lovelace < OPENING_LOVELACE) throw refuse(step, `the opening output holds ${units(output.lovelace)}, and it holds at least ${units(OPENING_LOVELACE)}`);
  const problems = datumProblems(() => datumOf(step, output), want);
  if (problems.length > 0) throw refuse(step, `the opening output is not the opening of this agent: ${problems.join('; ')}`);
  return output;
}

/** The stake output of the bytes: exactly the stake in units and one stake token of this agent, and a datum that holds this agent, this owner, this capability, the stake, no points, no lock and the opening. */
function stakeOutput(step: string, want: Expect & { stake: bigint; opening: string }, facts: TxFacts): OutputFacts {
  const output = outputAt(step, facts, 'a stake');
  const unit = stakeTokenUnit(want.id);
  const assets = Object.entries(output.assets);
  if (assets.length !== 1 || assets[0]![0] !== unit || assets[0]![1] !== 1n) throw refuse(step, 'the stake output does not hold exactly one stake token of this agent and nothing else');
  if (output.lovelace !== want.stake) throw refuse(step, `the stake output holds ${units(output.lovelace)}, and the stake of the data is ${units(want.stake)}`);
  const datum = datumOf(step, output);
  const problems = datumProblems(() => datum, want);
  if (datum.stake_amount !== want.stake) problems.push('the datum counts another stake than the stake of the data');
  if (datum.history_points !== 0n || datum.challenge_locks.length > 0) problems.push('the datum has history points or challenge locks, and a new stake has none');
  if (`${datum.stake_id.txHash}#${datum.stake_id.outputIndex}` !== want.opening) problems.push('the datum names another opening output than the one that the facts file holds');
  if (problems.length > 0) throw refuse(step, `the stake output is not the stake of this agent: ${problems.join('; ')}`);
  return output;
}

// ---- the landing of a step ----

function argsOf(session: Session, agent: AgentSpec, ready: Ready, opening: Opening | null): Record<string, unknown> {
  return {
    changeAddress: session.registry.addressOf(agent.serviceKey), did: ready.did, capabilities: [agent.capability], owner_key_hash: session.registry.hashOf(agent.serviceKey), amount: unitsOf(agent.stakeLovelace),
    ...(opening === null ? {} : { opening_ref: opening.ref }),
  };
}

function openSpec(session: Session, agent: AgentSpec, ready: Ready): HostedLandSpec {
  const step = stepName(agent, 'open');
  const want: Expect = { id: ready.id, owner: session.registry.hashOf(agent.serviceKey), capability: agent.capability };
  return {
    step, tool: TOOL_OPEN, args: argsOf(session, agent, ready, null), expectSigners: [agent.serviceKey],
    plan: (_build: HostedBuild, facts: TxFacts) => {
      openingOutput(step, want, facts);
      return planOf(session, { outflow: { [agent.serviceKey]: OPENING_LOVELACE + session.settings.maxFeeLovelace }, destinations: [REPUTATION_ADDRESS], mint: {}, labels: LABELS });
    },
    refs: (_build: HostedBuild, facts: TxFacts) => ({ openingRef: `${facts.txHash}#${openingOutput(step, want, facts).index}` }),
  };
}

function createSpec(session: Session, agent: AgentSpec, ready: Ready, opening: Opening): HostedLandSpec {
  const step = stepName(agent, 'create');
  const want = { id: ready.id, owner: session.registry.hashOf(agent.serviceKey), capability: agent.capability, stake: agent.stakeLovelace, opening: opening.ref };
  const unit = stakeTokenUnit(ready.id);
  return {
    step, tool: TOOL_CREATE, args: argsOf(session, agent, ready, opening), expectSigners: ['controller', agent.serviceKey], irreversible: 'stake',
    plan: (_build: HostedBuild, facts: TxFacts) => {
      stakeOutput(step, want, facts);
      return planOf(session, {
        // The opening returns as change when the stake is created, so the wallet gives the stake less the opening, and the fee.
        outflow: { [agent.serviceKey]: (agent.stakeLovelace > opening.lovelace ? agent.stakeLovelace - opening.lovelace : 0n) + session.settings.maxFeeLovelace }, destinations: [REPUTATION_ADDRESS], explained: [opening.ref],
        mint: { [unit]: 1n }, labels: LABELS,
      });
    },
    refs: (_build: HostedBuild, facts: TxFacts) => ({ stakeRef: `${facts.txHash}#${stakeOutput(step, want, facts).index}`, tokenUnit: unit }),
  };
}

/** The facts of an opening that landed: one fact for the agent, with no stake yet (`amountLovelace` is the stake of the data). The same opening again changes nothing, and another opening is a conflict. */
function writeOpeningFact(session: Session, agent: AgentSpec, refs: Readonly<Record<string, string>>): void {
  const openingRef = refs.openingRef;
  if (openingRef === undefined) throw new Error(`the state file holds the step ${stepName(agent, 'open')} without the reference of its opening output: its fact cannot be written`);
  const held = session.facts.read().stakes[agent.id];
  if (held !== undefined) {
    if (held.openingRef !== openingRef) throw new Error(`the facts file holds another opening of ${agent.id} than the opening of the step ${stepName(agent, 'open')}`);
    return;
  }
  session.facts.put('stakes', [agent.id], { openingRef, stakeRef: null, tokenUnit: null, amountLovelace: String(agent.stakeLovelace) });
}

function showDry(session: Session, agent: AgentSpec, part: Part, ready: Ready, build: HostedBuild): void {
  const lines = [
    `stake of ${agent.id} (${agent.name}): step ${part}`, `DID: ${ready.did}`,
    `owner of the stake: the service key ${agent.serviceKey} ${session.registry.hashOf(agent.serviceKey)}`,
    part === 'open'
      ? `the opening output locks at least ${units(OPENING_LOVELACE)} at the reputation address, and no script runs`
      : `the stake of ${units(agent.stakeLovelace)} is locked at the reputation address with the stake token. The minimum of a stake never returns to its owner`,
    `valid until: ${iso(build.validTo)}`, `fee: ${units(build.feeLovelace)}`,
  ];
  for (const line of lines) session.out.out(line);
}

// ---- the verification of create ----

/** What the tool `vector_get_reputation_stake` shows for the agent, held to the stake that the bytes of `create` made. */
function readProblems(answer: Record<string, unknown>, want: { did: string; unit: string; ref: string; amount: bigint; capability: string; owner: string; opening: string }): string[] {
  const agents = Array.isArray(answer.agents) ? answer.agents : [];
  const mine = agents.filter((one): one is Record<string, unknown> => isObject(one) && one.did === want.did);
  if (mine.length !== 1) return [`the tool lists ${mine.length} entries for ${want.did}, and the read has exactly one`];
  const agent = mine[0]!;
  const problems: string[] = [];
  if (agent.token_unit !== want.unit) problems.push(`the stake token of the agent is ${shown(agent.token_unit)}, and the pack derives ${shown(want.unit)}`);
  const stakes = Array.isArray(agent.stakes) ? agent.stakes : [];
  if (stakes.length !== 1) problems.push(`the tool lists ${stakes.length} stake output(s) of the agent, and the agent has exactly one`);
  const stake = stakes[0];
  if (!isObject(stake)) return problems;
  if (String(stake.ref).toLowerCase() !== want.ref) problems.push(`the stake output is ${shown(stake.ref)}, and the transaction made ${want.ref}`);
  if (String(stake.stake_amount) !== String(want.amount)) problems.push(`the stake counts ${shown(stake.stake_amount)} lovelace, and the stake of the data is ${want.amount}`);
  if (!Array.isArray(stake.capabilities) || !stake.capabilities.includes(want.capability)) problems.push(`the stake does not list the capability ${want.capability}`);
  if (stake.owner_key_hash !== want.owner) problems.push('the owner of the stake is not the service key');
  if (stake.stake_id !== want.opening) problems.push('the stake was not made from the opening output of the facts file');
  return problems;
}

// ---- the steps ----

function openStep(agent: AgentSpec): StepHandler<Extra> {
  const name = stepName(agent, 'open');
  return {
    name,
    async run(session) {
      session.extra.result = null;
      const ready = await requireCommon(session, agent);
      const held = session.facts.read().stakes[agent.id];
      if (held !== undefined) throw new PreconditionError(`the facts file holds the opening ${held.openingRef} of ${agent.id} already: the next step is create, and a second opening would lock units again`);
      const landed = await landHosted(session, openSpec(session, agent, ready));
      if (landed.build === null) throw new Error(`the landing of the step ${name} gave no answer of the tool`);
      if (landed.kind === 'dry') {
        showDry(session, agent, 'open', ready, landed.build);
        session.extra.result = { agent: agent.id, step: 'open', did: ready.did, amount_lovelace: String(agent.stakeLovelace), valid_until: iso(landed.build.validTo) };
        return { kind: 'dry' };
      }
      const refs = { openingRef: `${landed.txHash}#${openingOutput(name, { id: ready.id, owner: session.registry.hashOf(agent.serviceKey), capability: agent.capability }, landed.facts).index}` };
      writeOpeningFact(session, agent, refs);
      session.extra.result = { agent: agent.id, step: 'open', did: ready.did, opening_ref: refs.openingRef, tx: landed.txHash, amount_lovelace: String(agent.stakeLovelace) };
      return { kind: 'done', message: `the opening of the stake of ${agent.id} is confirmed: ${refs.openingRef}` };
    },
    async verify(session, record) {
      writeOpeningFact(session, agent, record.refs);
    },
  };
}

function createStep(agent: AgentSpec): StepHandler<Extra> {
  const name = stepName(agent, 'create');
  return {
    name,
    async run(session) {
      session.extra.result = null;
      const ready = await requireCommon(session, agent);
      const held = session.facts.read().stakes[agent.id];
      if (held === undefined) throw new PreconditionError(`the facts file holds no opening of ${agent.id}: run the step ${stepName(agent, 'open')} first, and keep the facts file of the session`);
      if (held.stakeRef !== null) throw new PreconditionError(`the facts file holds the stake ${held.stakeRef} of ${agent.id} already`);
      const opening = await openingOf(session, agent, ready, held.openingRef);
      if ('kind' in opening) return opening;
      const landed = await landHosted(session, createSpec(session, agent, ready, opening));
      if (landed.build === null) throw new Error(`the landing of the step ${name} gave no answer of the tool`);
      if (landed.kind === 'dry') {
        showDry(session, agent, 'create', ready, landed.build);
        session.extra.result = { agent: agent.id, step: 'create', did: ready.did, opening_ref: opening.ref, token_unit: stakeTokenUnit(ready.id), amount_lovelace: String(agent.stakeLovelace), valid_until: iso(landed.build.validTo) };
        return { kind: 'dry' };
      }
      const unit = stakeTokenUnit(ready.id);
      session.extra.result = { agent: agent.id, step: 'create', did: ready.did, opening_ref: opening.ref, token_unit: unit, tx: landed.txHash, amount_lovelace: String(agent.stakeLovelace) };
      return { kind: 'done', message: `the stake of ${agent.id} is confirmed in the transaction ${landed.txHash}` };
    },
    async verify(session, record) {
      const known = session.facts.read();
      const ready = known.records[agent.id];
      const held = known.stakes[agent.id];
      const { stakeRef, tokenUnit } = record.refs;
      if (ready === undefined || held === undefined || stakeRef === undefined || tokenUnit === undefined) {
        throw new Error(`the state or the facts file lacks what the verification of the step ${name} needs: the record, the opening, the reference of the stake or its token`);
      }
      const want = { did: ready.did, unit: tokenUnit, ref: stakeRef, amount: agent.stakeLovelace, capability: agent.capability, owner: session.registry.hashOf(agent.serviceKey), opening: held.openingRef };
      const check: ToolCheck = { tool: TOOL_READ, args: { dids: [ready.did] }, problems: (answer) => readProblems(answer, want) };
      await verifyWithTools(session, name, [check], { agent: agent.id, did: ready.did, stake_ref: stakeRef, token_unit: tokenUnit, stake_lovelace: String(agent.stakeLovelace) });
      // The read showed the stake that the bytes made, with the token that the pack derives: its reference and its token go into the facts file, one field each, once.
      session.facts.put('stakes', [agent.id, 'stakeRef'], stakeRef);
      session.facts.put('stakes', [agent.id, 'tokenUnit'], tokenUnit);
    },
  };
}

const handlersOf = (agents: readonly AgentSpec[]): StepHandler<Extra>[] => agents.flatMap((agent) => [openStep(agent), createStep(agent)]);

const stake: TaskDefinition<Extra> = {
  name: 'stake',
  title: 'Make the Module-3 stake of each agent, owned by its service key',
  flags: [],
  valued: [],
  needs: {
    keys: (use) => ['controller', ...new Set(use.agents.map((agent) => agent.serviceKey))],
    chain: true,
    hosted: [TOOL_OPEN, TOOL_CREATE, TOOL_READ],
    approval: 'submit',
  },
  steps: (use) => use.agents.flatMap((agent) => [stepName(agent, 'open'), stepName(agent, 'create')]),
  parse: () => ({ result: null }),
  next: (session) => runSteps(session, handlersOf(session.use.agents)),
  cleanup: async () => ({ kind: 'done', message: 'there is nothing to take back: the minimum of a stake never returns to its owner' }),
  result: (session) => session.extra.result ?? {},
};

export default stake;
