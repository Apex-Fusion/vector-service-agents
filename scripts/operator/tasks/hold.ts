// scripts/operator/tasks/hold.ts - the task hold: a party hold on an agent with the Accountable key of its organisation, and its lift.
// The failure run uses it to show that an organisation can hold its own agent. The hold is made by the Accountable party of the record, which has the suspend right, and it lasts 1 day by default (30
// at most). The lift removes the hold of that author and no other: a hold of Module-1 stays, and the record stays Suspended until it ends. The task builds with the hosted tools, and it signs only with
// the Accountable key of the organisation of the agent and with the key `fee`, which pays. `--by` must name that Accountable key: the data of the use case says which key it is, and no other key passes.
// The Unsuspend tool takes `author` and no `actor`, and its default author is the controller: a call with no `author` would name a hold that does not exist, so the lift always names the author.
// The node decides what the hold did. After each landing the task reads the record from the node, for up to 90 seconds, until the hold is there or gone, and it writes the status before, during and
// after into the evidence. The resolver of the hosted tools is read for the evidence only: a resolver that does not answer is noted, and the step goes on.
// `cleanup` lifts a hold that this pack made and that the facts hold without a lift, and nothing else. It never builds a transaction for a hold that this pack did not make.
import { collateralAdvice, isCollateralOutput } from '../../checks/lib/collateral.ts';
import { duration, iso } from '../../checks/lib/format.ts';
import { HostedError } from '../../checks/lib/hosted.ts';
import { GuardRefusal } from '../../checks/lib/land.ts';
import { eventually } from '../../checks/lib/retry.ts';
import { PreconditionError } from '../../checks/lib/session.ts';
import type { TxFacts } from '../../checks/lib/txfacts.ts';
// The entry of vector-read gives no codec of the identity datums: `decodeIdentityDatum` reads the inline datum of a record output, as `findRecord` does.
import { decodeIdentityDatum } from '../../../packages/vector-read/src/identity-codec.ts';
import { VERIFY_WINDOW, VerificationError } from '../../checks/lib/verify.ts';
import type { AgentSpec, OrganisationSpec, TaskDefinition, TaskSession, UseCase } from '../lib/contract.ts';
import { landHosted } from '../lib/land-hosted.ts';
import { effectiveStatus, findRecord } from '../lib/platform.ts';
import type { RecordUtxo } from '../lib/platform.ts';
import { planOf } from '../lib/plan.ts';
import { FlagError, runSteps, verifyStep } from '../lib/runner.ts';
import type { StepHandler } from '../lib/runner.ts';

const DEFAULT_AGENT = 'order-desk';
const DEFAULT_DAYS = 1;
const MAX_DAYS = 30;
const DAYS = /^[0-9]+$/;
/** The length of a day: a hold lasts whole days from the start of the validity window. */
const DAY_MS = 86_400_000;

type Datum = RecordUtxo['record'];
type Holds = Extract<Datum['status'], { type: 'Suspended' }>['holds'];
type HoldOf = Holds[number];

interface HoldExtra {
  readonly run: string;
  readonly agent: AgentSpec;
  readonly organisation: OrganisationSpec;
  /** The registry name that --by gave: always the Accountable key of the organisation. Null when the command line gave none (the step refuses that). */
  readonly by: string | null;
  readonly days: number;
  /** The effective status of the record at the last reading: the machine line carries it. */
  effective: string | null;
}

/** The record as the node shows it: its output, its effective status now, and its holds in the order of the record. */
interface Reading {
  readonly found: RecordUtxo;
  readonly effective: string;
  readonly holds: readonly HoldOf[];
}

/** What a step works on, from the flags, the data and the facts. */
interface Target {
  readonly by: string;
  readonly byHash: string;
  readonly did: string;
  readonly id: string;
  readonly feeAddress: string;
}

function agentOf(use: UseCase, id: string): AgentSpec {
  const agent = use.agents.find((candidate) => candidate.id === id);
  if (agent === undefined) throw new FlagError(`--agent is one of ${use.agents.map((candidate) => candidate.id).join(', ')}`);
  return agent;
}

function organisationOf(use: UseCase, agent: AgentSpec): OrganisationSpec {
  const organisation = use.organisations.find((candidate) => candidate.id === agent.organisation);
  if (organisation === undefined) throw new PreconditionError(`the data of the use case lists no organisation ${agent.organisation} for the agent ${agent.id}`);
  return organisation;
}

const holdsOf = (record: Datum): readonly HoldOf[] => (record.status.type === 'Suspended' ? record.status.holds : []);
const refOf = (utxo: { txHash: string; outputIndex: number }): string => `${utxo.txHash}#${utxo.outputIndex}`;
const objectOf = (value: unknown): Record<string, unknown> | null => (typeof value === 'object' && value !== null && !Array.isArray(value) ? { ...value } : null);
const textOf = (value: unknown): string | null => (typeof value === 'string' ? value : null);

/** The author of a hold in words: the key by its registry name when the registry knows it, the controller, or Module-1. */
function authorText(session: TaskSession<HoldExtra>, signer: HoldOf['by']): string {
  if (signer.type === 'ControllerSet') return 'the controller';
  if (signer.type === 'Script') return `Module-1 (${signer.hash})`;
  return `the key ${session.registry.nameOfHash(signer.hash) ?? signer.hash}`;
}

/** The holds of the record in words, each with its author, its reason and its end. */
function holdsText(session: TaskSession<HoldExtra>, holds: readonly HoldOf[]): string {
  const now = session.clock.now();
  if (holds.length === 0) return 'no hold';
  return holds.map((candidate) => `a hold by ${authorText(session, candidate.by)} (reason ${candidate.reason}) until ${iso(candidate.until)}${candidate.until <= now ? ', ended' : ''}`).join('; ');
}

const describeReading = (session: TaskSession<HoldExtra>, reading: Reading): string => `effective status ${reading.effective}; ${holdsText(session, reading.holds)}`;

/** The hold of one author that is in the record, ended or not: a Suspend replaces it and an Unsuspend removes it. */
const holdOf = (reading: Reading, byHash: string): HoldOf | undefined => reading.holds.find((candidate) => candidate.by.type === 'KeyHash' && candidate.by.hash === byHash);

/** The holds that another author keeps in force now. */
const othersOf = (session: TaskSession<HoldExtra>, reading: Reading, byHash: string): HoldOf[] => {
  const now = session.clock.now();
  return reading.holds.filter((candidate) => candidate.until > now && !(candidate.by.type === 'KeyHash' && candidate.by.hash === byHash));
};

/** What the evidence keeps of a reading of the node: the holds in words and in times, and whether each is in force. */
function shownOf(session: TaskSession<HoldExtra>, reading: Reading): Record<string, unknown> {
  const now = session.clock.now();
  return {
    effective: reading.effective,
    holds: reading.holds.map((candidate) => ({ by: authorText(session, candidate.by), reason: candidate.reason, since: iso(candidate.since), until: iso(candidate.until), inForce: candidate.until > now })),
  };
}

/** A node that is not on the network of the run would show the record of another chain. */
function requireNetwork(session: TaskSession<HoldExtra>): void {
  const gate = session.networkResult();
  if (gate === null || !gate.ok) throw new PreconditionError(`the node is not shown to be on the network of the run (${gate === null ? 'the network guard did not run' : gate.message}), so nothing is built`);
}

/** Reads the record of the agent from the node. The record must be there and be a root record. */
async function readRecord(session: TaskSession<HoldExtra>, id: string): Promise<Reading> {
  const agent = session.extra.agent.id;
  const found = await findRecord(session.chain.provider, session.chain.deployment, id);
  if (found === null) throw new PreconditionError(`the record of the agent ${agent} is not in the identity registry: wait until its registration is confirmed`);
  if (found.record.lineage.type !== 'Root') throw new PreconditionError(`the record of the agent ${agent} is a subagent: a hold of this pack is for a root record`);
  const now = session.clock.now();
  return { found, effective: effectiveStatus(found.record, new Map(), now, now), holds: holdsOf(found.record) };
}

/** The hosted resolver, read for the evidence: what it says of the status, or why it could not say. It never decides. */
async function resolverReading(session: TaskSession<HoldExtra>, did: string): Promise<Record<string, unknown>> {
  try {
    const answer = await session.hosted.call('vector_resolve_did', { did });
    if (answer.failed) return { read: 'failed', message: answer.message };
    const vector = objectOf(objectOf(answer.json?.didDocumentMetadata)?.vectorStatus);
    const listed: unknown = vector === null ? undefined : vector.holds;
    const holds = Array.isArray(listed) ? listed.flatMap((item: unknown) => {
      const given = objectOf(item);
      return given === null ? [] : [{ by: textOf(given.by), reason: textOf(given.reason), since: textOf(given.since), until: textOf(given.until) }];
    }) : [];
    return { read: 'ok', effective: vector === null ? null : textOf(vector.effective), holds };
  } catch (err) {
    if (err instanceof HostedError) return { read: 'not possible', message: err.message };
    throw err;
  }
}

/** Writes one reading into the evidence: the node and the resolver. `ok` says whether the node showed what the step made. */
async function noteReading(session: TaskSession<HoldExtra>, step: string, name: 'before' | 'during' | 'after', reading: Reading, ok: boolean, did: string): Promise<void> {
  session.evidence.add({ step, status: 'info', shows: { reading: name, ok, node: shownOf(session, reading), resolver: await resolverReading(session, did) } });
}

/** The key, the record fact and the wallet of the run. A run without --by is refused here, and a record that the facts do not hold. */
function targetOf(session: TaskSession<HoldExtra>): Target {
  const { agent, by } = session.extra;
  if (by === null) throw new FlagError('hold needs --by <key>: the Accountable key of the organisation of the agent');
  const record = session.facts.read().records[agent.id];
  if (record === undefined) throw new PreconditionError(`the facts hold no record of the agent ${agent.id}: register it first`);
  return { by, byHash: session.registry.hashOf(by), did: record.did, id: record.id, feeAddress: session.registry.addressOf('fee') };
}

/** The fee wallet pays and its collateral guards the script of the identity registry: one pure output of 5 units or more must be there. */
async function requireCollateral(session: TaskSession<HoldExtra>, target: Target): Promise<void> {
  if ((await session.chain.provider.getUtxos(target.feeAddress)).some(isCollateralOutput)) return;
  throw new PreconditionError(`the fee wallet ${session.registry.hashOf('fee')} has no pure output of 5 units or more. This step runs a script, and the script needs one as collateral. ${collateralAdvice(target.feeAddress)}.`);
}

/** The record output of the new state: the output of the transaction at the identity address. */
const afterRef = (facts: { txHash: string; outputs: readonly { address: string; index: number }[] }, address: string): Record<string, string> => {
  const output = facts.outputs.find((candidate) => candidate.address === address);
  return output === undefined ? {} : { recordAfter: `${facts.txHash}#${output.index}` };
};

/** Writes the fact of the hold once: the facts file sets a fact once, and a step that is verified again leaves what is there. */
function recordHold(session: TaskSession<HoldExtra>, txHash: string): void {
  if (session.facts.read().holds[session.extra.run] === undefined) session.facts.put('holds', [session.extra.run], { suspendTx: txHash, liftTx: null });
}

function recordLift(session: TaskSession<HoldExtra>, txHash: string): void {
  if (session.facts.read().holds[session.extra.run]?.liftTx === null) session.facts.put('holds', [session.extra.run, 'liftTx'], txHash);
}

/** Reads the node until the check is true, within the window of the verification. A check that stays false after the window gives its last reading. */
const awaitReading = (session: TaskSession<HoldExtra>, id: string, check: (reading: Reading) => boolean): Promise<{ done: boolean; value: Reading }> =>
  eventually(session.clock, VERIFY_WINDOW, async () => { const reading = await readRecord(session, id); return { done: check(reading), value: reading }; });

/**
 * The hold that the build holds, read from its bytes before any signature. The guards read the signers, the destinations, the mint and the outflow, and none of them reads the datum, so a tool that
 * built a longer hold than the run asked for, or a hold of another author, would be signed. The record output must be the one output at the identity address that holds the identity token of the
 * agent. Its last hold must be by the Accountable key of the run, and it must last at most the days that the run asks for. A refusal has the guard `body`.
 */
function requireBuiltHold(session: TaskSession<HoldExtra>, target: Target, facts: TxFacts): void {
  const refuse = (message: string): GuardRefusal => new GuardRefusal(SUSPEND.name, [{ guard: 'body', ok: false, message }]);
  const unit = `${session.chain.deployment.identity.hash}${target.id}`;
  const outputs = facts.outputs.filter((candidate) => candidate.address === session.chain.deployment.identity.address && candidate.assets[unit] === 1n);
  const [output] = outputs;
  if (output === undefined || outputs.length !== 1) throw refuse(`the transaction has ${outputs.length} output(s) at the identity address that hold the identity token of the agent, and a hold has exactly one`);
  if (output.inlineDatum === null) throw refuse('the record output of the build has no inline datum, so the hold cannot be read');
  let datum: Datum;
  try { datum = decodeIdentityDatum(output.inlineDatum); } catch (err) { throw refuse(`the inline datum of the record output does not decode (${err instanceof Error ? err.message : String(err)})`); }
  const last = holdsOf(datum).at(-1);
  if (last === undefined) throw refuse('the record in the build holds no hold: its status is not Suspended');
  if (last.by.type !== 'KeyHash' || last.by.hash !== target.byHash) throw refuse(`the last hold of the record in the build is not a hold by the key ${target.by}`);
  const days = session.extra.days;
  if (last.until <= last.since || last.until > last.since + days * DAY_MS) {
    throw refuse(`the hold in the build lasts from ${iso(last.since)} until ${iso(last.until)}, and the run asks for a hold of ${days} ${days === 1 ? 'day' : 'days'}`);
  }
}

const SUSPEND: StepHandler<HoldExtra> = {
  name: 'suspend',
  async run(session) {
    const { run, agent, organisation, days } = session.extra;
    const target = targetOf(session);
    const earlier = session.facts.read().holds[run];
    if (earlier !== undefined) throw new PreconditionError(`the facts hold a hold of the run ${run} already (suspend ${earlier.suspendTx ?? 'not done'}): use another run label`);
    requireNetwork(session);
    const reading = await readRecord(session, target.id);
    if (reading.effective === 'Revoked' || reading.effective === 'Retired') {
      throw new PreconditionError(`the record of the agent ${agent.id} is ${reading.effective}: a hold needs a record that is Active, or that another author holds`);
    }
    const own = holdOf(reading, target.byHash);
    if (own !== undefined) {
      throw new PreconditionError(`the record already holds a hold of the key ${target.by} (until ${iso(own.until)}): lift it first, so that a new hold does not replace a hold that this pack did not make`);
    }
    const others = othersOf(session, reading, target.byHash);
    if (reading.effective === 'Suspended' && others.length === 0) {
      throw new PreconditionError(`the record is Suspended and holds no hold in force: no party that is Accountable covers the time now, so a hold of the key ${target.by} changes nothing`);
    }
    await requireCollateral(session, target);
    const identity = session.chain.deployment.identity.address;
    const plural = days === 1 ? 'day' : 'days';
    if (session.mode === 'submit') await noteReading(session, SUSPEND.name, 'before', reading, true, target.did);
    const landed = await landHosted(session, {
      step: SUSPEND.name, tool: 'vector_build_identity_suspend',
      args: { changeAddress: target.feeAddress, did: target.did, actor: { role: 'Accountable', signer: target.byHash }, days },
      expectSigners: [target.by, 'fee'],
      plan: (_build, facts) => {
        requireBuiltHold(session, target, facts);
        return planOf(session, { destinations: [identity], mint: {}, explained: [refOf(reading.found.utxo)], outflow: { fee: session.settings.maxFeeLovelace } });
      },
      facts: () => ({ agent: agent.id, did: target.did, by: target.by, author: target.byHash, days }),
      refs: (_build, facts) => ({ recordBefore: refOf(reading.found.utxo), ...afterRef(facts, identity) }),
      notes: [
        `hold: the agent ${agent.id} (${target.did}) gets a hold of ${days} ${plural} from the Accountable key ${target.by} of the organisation ${organisation.id}`,
        `the record before: ${describeReading(session, reading)}`,
        ...(others.length > 0 ? ['the record is held by another author already: a hold of this pack adds to it'] : []),
        'the reason of the hold is the default of the tool (hold). The lift removes only the hold of this author.',
      ],
    });
    if (landed.kind === 'dry') return { kind: 'dry' };
    recordHold(session, landed.txHash);
    return { kind: 'done', message: `the hold landed: transaction ${landed.txHash}` };
  },
  async verify(session, record) {
    const target = targetOf(session);
    if (record.tx_hash !== null) recordHold(session, record.tx_hash);
    const inForce = (reading: Reading): boolean => {
      const mine = holdOf(reading, target.byHash);
      return reading.effective === 'Suspended' && mine !== undefined && mine.until > session.clock.now();
    };
    const outcome = await awaitReading(session, target.id, inForce);
    session.extra.effective = outcome.value.effective;
    await noteReading(session, SUSPEND.name, 'during', outcome.value, outcome.done, target.did);
    if (!outcome.done) {
      throw new VerificationError(`the node does not show the hold by the key ${target.by} on the agent ${session.extra.agent.id} within ${duration(VERIFY_WINDOW.windowMs)}: the node shows ${describeReading(session, outcome.value)}. The step stays unverified, and the next run reads the node again`);
    }
    const mine = holdOf(outcome.value, target.byHash);
    session.out.out(`the node shows the hold by the key ${target.by} until ${mine === undefined ? '?' : iso(mine.until)}; effective status ${outcome.value.effective}`);
  },
};

const LIFT: StepHandler<HoldExtra> = {
  name: 'lift',
  async run(session) {
    const { run, agent } = session.extra;
    if (session.extra.by === null) throw new FlagError('hold needs --by <key>: the Accountable key of the organisation of the agent');
    const held = session.facts.read().holds[run];
    if (held === undefined || held.suspendTx === null) throw new PreconditionError(`the facts hold no hold of the run ${run} that this pack made: a lift takes back only a hold that this pack made`);
    if (held.liftTx !== null) throw new PreconditionError(`the facts say that the hold of the run ${run} was lifted already (transaction ${held.liftTx})`);
    const made = session.state.step(SUSPEND.name);
    if (made === undefined) throw new PreconditionError(`the state of the run ${run} holds no suspend step: this run did not make the hold, so it does not lift it`);
    if (made.facts.agent !== agent.id || made.facts.by !== session.extra.by) {
      throw new PreconditionError(`the suspend of the run ${run} was made for the agent ${String(made.facts.agent)} by the key ${String(made.facts.by)}, and the flags name the agent ${agent.id} and the key ${session.extra.by}`);
    }
    if (made.tx_hash !== held.suspendTx) throw new PreconditionError(`the suspend of the state of the run ${run} is another transaction than the suspend of the facts`);
    if (session.state.step(LIFT.name) !== undefined) throw new PreconditionError(`the state of the run ${run} holds the lift already`);
    const target = targetOf(session);
    requireNetwork(session);
    const reading = await readRecord(session, target.id);
    if (holdOf(reading, target.byHash) === undefined) {
      throw new PreconditionError(`the record holds no hold of the key ${target.by}: there is nothing to lift (the node shows ${describeReading(session, reading)})`);
    }
    await requireCollateral(session, target);
    const identity = session.chain.deployment.identity.address;
    const landed = await landHosted(session, {
      step: LIFT.name, tool: 'vector_build_identity_unsuspend',
      args: { changeAddress: target.feeAddress, did: target.did, author: target.byHash },
      expectSigners: [target.by, 'fee'],
      plan: () => planOf(session, { destinations: [identity], mint: {}, explained: [refOf(reading.found.utxo)], outflow: { fee: session.settings.maxFeeLovelace } }),
      facts: () => ({ agent: agent.id, did: target.did, by: target.by, author: target.byHash }),
      refs: (_build, facts) => ({ recordBefore: refOf(reading.found.utxo), ...afterRef(facts, identity) }),
      notes: [
        `lift: the hold by the key ${target.by} on the agent ${agent.id} (${target.did}) ends`,
        `the record before: ${describeReading(session, reading)}`,
        'the lift removes the hold of this author only: a hold of another author stays.',
      ],
    });
    if (landed.kind === 'dry') return { kind: 'dry' };
    recordLift(session, landed.txHash);
    return { kind: 'done', message: `the lift landed: transaction ${landed.txHash}` };
  },
  async verify(session, record) {
    const target = targetOf(session);
    if (record.tx_hash !== null) recordLift(session, record.tx_hash);
    const outcome = await awaitReading(session, target.id, (reading) => holdOf(reading, target.byHash) === undefined);
    session.extra.effective = outcome.value.effective;
    await noteReading(session, LIFT.name, 'after', outcome.value, outcome.done, target.did);
    if (!outcome.done) {
      throw new VerificationError(`the node still shows a hold by the key ${target.by} on the agent ${session.extra.agent.id} after ${duration(VERIFY_WINDOW.windowMs)}: the node shows ${describeReading(session, outcome.value)}. The step stays unverified, and the next run reads the node again`);
    }
    session.out.out(`the node shows no hold by the key ${target.by}; effective status ${outcome.value.effective}`);
    const others = othersOf(session, outcome.value, target.byHash);
    if (outcome.value.effective === 'Suspended' && others.length > 0) {
      session.out.out(`the record stays Suspended: a hold of another author stays (${others.map((candidate) => `${authorText(session, candidate.by)} until ${iso(candidate.until)}`).join('; ')})`);
    }
  },
};

const task: TaskDefinition<HoldExtra> = {
  name: 'hold',
  title: 'a hold on an agent by the Accountable key of its organisation, and its lift',
  flags: [],
  valued: ['agent', 'by', 'days'],
  needs: {
    // The keys that sign: the fee wallet, and the Accountable key of the organisation of the agent. `--by` must name that key, so the flag never picks another one.
    keys: (use, flags) => ['fee', organisationOf(use, agentOf(use, flags.value('agent') ?? DEFAULT_AGENT)).accountableKey],
    chain: true,
    hosted: ['vector_build_identity_suspend', 'vector_build_identity_unsuspend', 'vector_resolve_did'],
    approval: 'submit',
  },
  steps: () => [SUSPEND.name, LIFT.name],
  parse(_env, _settings, use, flags) {
    const run = flags.value('run');
    if (run === undefined) throw new FlagError('hold needs --run <label>');
    const agent = agentOf(use, flags.value('agent') ?? DEFAULT_AGENT);
    const organisation = organisationOf(use, agent);
    const by = flags.value('by') ?? null;
    if (by !== null && by !== organisation.accountableKey) {
      throw new FlagError(`--by must be the Accountable key of the organisation ${organisation.id} of the agent ${agent.id}, which is ${organisation.accountableKey}`);
    }
    const given = flags.value('days');
    if (given !== undefined && (!DAYS.test(given) || Number(given) < 1 || Number(given) > MAX_DAYS)) throw new FlagError(`--days is a whole number of days from 1 to ${MAX_DAYS}`);
    return { run, agent, organisation, by, days: given === undefined ? DEFAULT_DAYS : Number(given), effective: null };
  },
  next: (session) => runSteps(session, [SUSPEND, LIFT]),
  async cleanup(session) {
    // A suspend that was in flight is recorded as a step by the runner when it confirms, and a stop between the landing and the write of the fact leaves the step without the fact. The cleanup writes the
    // fact from the step first, so that it lifts that hold too.
    const made = session.state.step(SUSPEND.name);
    if (made !== undefined && made.tx_hash !== null) recordHold(session, made.tx_hash);
    const { run } = session.extra;
    const held = session.facts.read().holds[run];
    if (held === undefined || held.suspendTx === null || held.liftTx !== null) return { kind: 'done', message: `no hold of this pack is on for the run ${run}: there is nothing to take back` };
    const outcome = await LIFT.run(session);
    const landed = session.state.step(LIFT.name);
    if (outcome.kind !== 'done' || landed === undefined) return outcome;
    session.out.out(outcome.message);
    await verifyStep(session, LIFT, landed);
    return { kind: 'done', message: `the hold of the run ${run} is lifted and the lift is verified` };
  },
  async status(session) {
    const { run, agent } = session.extra;
    const facts = session.facts.read();
    const held = facts.holds[run];
    const lines = [held === undefined ? `no hold of this pack is on for the run ${run}` : `hold of the run ${run}: suspend ${held.suspendTx ?? 'not done'}, lift ${held.liftTx ?? 'not done'}`];
    const record = facts.records[agent.id];
    if (record === undefined) return [...lines, `the facts hold no record of the agent ${agent.id}`];
    try {
      requireNetwork(session);
      lines.push(`the record of the agent ${agent.id} (${record.did}): ${describeReading(session, await readRecord(session, record.id))}`);
    } catch (err) {
      if (!(err instanceof PreconditionError)) throw err;
      lines.push(`the record of the agent ${agent.id} is not shown: ${err.message}`);
    }
    return lines;
  },
  result(session) {
    const held = session.facts.read().holds[session.extra.run];
    const record = session.facts.read().records[session.extra.agent.id];
    return { run: session.extra.run, agent: session.extra.agent.id, did: record?.did ?? null, by: session.extra.by, suspendTx: held?.suspendTx ?? null, liftTx: held?.liftTx ?? null, effective: session.extra.effective };
  },
};

export default task;
