// List the unspent delegations and the keys they still hold. A filter limits the rows, not the key summary.
// Group children of the use case's agents by parent. An expired or missing parent does not free a child's key.
// The list reads the chain and the facts. It does not sign, build or submit a transaction.
import { duration, iso, units } from '../../checks/lib/format.ts';
import { PreconditionError } from '../../checks/lib/session.ts';
import type { ValueLimit } from '../../checks/lib/platform.ts';
import type { TaskDefinition, TaskFlags, TaskSession, UseCase } from '../lib/contract.ts';
import { liveDelegations, readDelegation } from '../lib/platform.ts';
import { FlagError, runSteps } from '../lib/runner.ts';
import type { StepHandler } from '../lib/runner.ts';

type Live = Awaited<ReturnType<typeof liveDelegations>>[number];

interface Child {
  readonly id: string;
  readonly parent: string;
  readonly parentState: 'live' | 'ended' | 'missing';
  readonly missingParent: string | null;
  readonly delegate: string;
  readonly subagent: string | null;
  readonly delegateKey: string;
  readonly key: string | null;
  readonly actions: readonly string[];
  readonly resources: readonly string[];
  readonly notAfter: string;
}

const KEY_HASH = /^[0-9a-f]{56}$/;

/** An agent or a subagent of the use case and the names of its keys with the purpose delegation (none for an agent that is hired and hires nobody). */
interface Holder { readonly id: string; readonly keys: readonly string[] }

const holdersOf = (use: UseCase): Holder[] => [...use.agents, ...use.subagents].map((agent) => ({ id: agent.id, keys: agent.keys.filter((key) => key.purposes.includes('delegation')).map((key) => key.key) }));

/** What the last list showed: the machine line carries it. */
interface Seen {
  readonly live: number;
  readonly shown: number;
  readonly keys: readonly { readonly key: string; readonly agent: string; readonly state: 'free' | 'in use'; readonly delegations: readonly string[] }[];
  readonly children?: readonly Child[];
}

interface ListExtra {
  /** A key name of the use case, or the hash of a key (56 hex characters). */
  readonly delegateKey: string | null;
  /** The id of an agent or a subagent of the use case. */
  readonly agent: string | null;
  seen: Seen | null;
}

const textOfHex = (hex: string): string => Buffer.from(hex, 'hex').toString('utf8');

const limitText = (limit: ValueLimit | null): string => (limit === null ? 'none' : `${units(limit.perTx)} for each payment, ${units(limit.total)} in ${duration(limit.periodMs)}`);

/** The list needs a node that is on the network of the run: a node of another network would list the delegations of another chain. */
function requireNetwork(session: Pick<TaskSession, 'networkResult'>): void {
  const gate = session.networkResult();
  if (gate === null || !gate.ok) throw new PreconditionError(`the node is not shown to be on the network of the run (${gate === null ? 'the network guard did not run' : gate.message}), so the list would show another chain`);
}

/** The lines of one live delegation. */
function linesOf(live: Live, session: TaskSession<ListExtra>, names: ReadonlyMap<string, string>, now: number): string[] {
  const agent = names.get(live.delegation.delegate);
  const { delegation, id } = live;
  const keyName = session.registry.nameOfHash(delegation.delegateKey);
  const when = delegation.notAfter > now ? `in ${duration(delegation.notAfter - now)}` : `ended ${duration(now - delegation.notAfter)} ago; the key stays in use until the hirer ends the delegation`;
  const delegator = delegation.delegator.type === 'PrincipalKey' ? `key hash ${delegation.delegator.hash}` : `agent did:vector:${delegation.delegator.id}`;
  return [
    `delegation ${id}`,
    `  delegator: ${delegator}`,
    `  delegate: did:vector:${delegation.delegate}${agent === undefined ? '' : ` (the agent ${agent})`}, key ${delegation.delegateKey}${keyName === undefined ? '' : ` (${keyName})`}`,
    `  actions: ${delegation.actions.map(textOfHex).join(', ')}`,
    `  resources: ${delegation.resources.map(textOfHex).join(', ')}`,
    `  not after: ${iso(delegation.notAfter)} (${when})`,
    `  remaining hops: ${delegation.remaining}`,
    `  value limit: ${limitText(delegation.value)}`,
  ];
}

async function childOf(session: TaskSession<ListExtra>, live: Live, parent: string, names: ReadonlyMap<string, string>, now: number): Promise<Child> {
  const { provider, deployment, koiosUrl, fetchImpl } = session.chain;
  const view = await readDelegation({ provider, deployment, koiosUrl, fetchImpl }, live.id).catch(() => {
    throw new PreconditionError(`the chain of child ${live.id} could not be read, so its parent state is not shown`);
  });
  const [leaf, link] = view.chain;
  if (leaf?.delegation.parent !== parent || (view.missingParent === null && link?.id !== parent)) {
    throw new PreconditionError(`the child ${live.id} changed while the list was read, so its parent state is not shown`);
  }
  const parentState = view.missingParent !== null ? 'missing'
    : view.chain.some((ancestor, index) => index > 0 && ancestor.delegation.notAfter <= now) ? 'ended'
    : 'live';
  const { delegation } = leaf;
  return {
    id: live.id, parent, parentState, missingParent: view.missingParent,
    delegate: `did:vector:${delegation.delegate}`, subagent: names.get(delegation.delegate) ?? null,
    delegateKey: delegation.delegateKey, key: session.registry.nameOfHash(delegation.delegateKey) ?? null,
    actions: delegation.actions.map(textOfHex), resources: delegation.resources.map(textOfHex), notAfter: iso(delegation.notAfter),
  };
}

function childLines(child: Child): string[] {
  const { id, parent, missingParent, parentState, delegate, subagent, delegateKey, key, actions, resources, notAfter } = child;
  const gap = missingParent === null || missingParent === parent ? '' : ` (ancestor ${missingParent} is missing)`;
  return [
    `    child ${id}: parent ${parentState}${gap}`,
    `      delegate: ${delegate}${subagent === null ? '' : ` (the subagent ${subagent})`}, key ${delegateKey}${key === null ? '' : ` (${key})`}`,
    `      actions: ${actions.join(', ')}`,
    `      resources: ${resources.join(', ')}`,
    `      not after: ${notAfter}`,
    ...(parentState === 'missing' ? ['      stranded child: it holds its key until the janitor of its agent ends it'] : []),
  ];
}

/** Reads the live delegations, applies the filters, and writes the list and the summary. */
async function report(session: TaskSession<ListExtra>): Promise<{ lines: string[]; seen: Seen }> {
  requireNetwork(session);
  const { delegateKey, agent } = session.extra;
  const records = session.facts.read().records;
  let wantedAgent: string | null = null;
  if (agent !== null) {
    const record = records[agent];
    if (record === undefined) throw new PreconditionError(`the facts hold no record of the agent ${agent}: register it first, or leave out --agent`);
    wantedAgent = record.id;
  }
  const wantedKey = delegateKey === null ? null : KEY_HASH.test(delegateKey) ? delegateKey : session.registry.hashOf(delegateKey);
  const live = await liveDelegations(session.chain.provider, session.chain.deployment);
  const shown = live.filter(({ delegation }) => (wantedKey === null || delegation.delegateKey === wantedKey) && (wantedAgent === null || delegation.delegate === wantedAgent));
  const filters = [delegateKey === null ? null : `the delegate key ${delegateKey}`, agent === null ? null : `the agent ${agent}`].filter((filter) => filter !== null);
  const lines = [`live delegations on the chain: ${live.length}`, ...(filters.length === 0 ? [] : [`filter: ${filters.join(' and ')}, ${shown.length} shown`])];
  if (shown.length === 0) lines.push('no live delegation to show');
  const names = new Map(Object.entries(records).map(([name, record]) => [record.id, name]));
  const subagentNames = new Map(session.use.subagents.flatMap(({ id }) => records[id] === undefined ? [] : [[records[id].id, id] as const]));
  const parentAgents = new Set(session.use.agents.flatMap(({ id }) => records[id]?.id ?? []));
  const families = new Map<string, Child[]>();
  const now = session.clock.now();
  for (const row of shown) {
    const { delegator, parent } = row.delegation;
    if (parent === null || delegator.type !== 'Agent' || !parentAgents.has(delegator.id)) {
      lines.push(...linesOf(row, session, names, now));
      continue;
    }
    const child = await childOf(session, row, parent, subagentNames, now);
    const family = families.get(parent);
    if (family === undefined) families.set(parent, [child]);
    else family.push(child);
  }
  lines.push('children:');
  if (families.size === 0) lines.push('  no child delegation to show');
  for (const [parent, family] of families) {
    lines.push(`  parent ${parent}`);
    for (const child of family) lines.push(...childLines(child));
  }
  lines.push('delegation keys:');
  const keys: Seen['keys'][number][] = [];
  for (const holder of holdersOf(session.use)) {
    if (holder.keys.length === 0) lines.push(`${holder.id} has no delegation key`);
    for (const name of holder.keys) {
      const hash = session.registry.hashOf(name);
      const using = live.filter(({ delegation }) => delegation.delegateKey === hash).map(({ id }) => id);
      lines.push(`${name} of ${holder.id} (key ${hash}): ${using.length === 0 ? 'free' : `in use by ${using.join(', ')}`}`);
      keys.push({ key: name, agent: holder.id, state: using.length === 0 ? 'free' : 'in use', delegations: using });
    }
  }
  return { lines, seen: { live: live.length, shown: shown.length, keys, ...(families.size === 0 ? {} : { children: [...families.values()].flat() }) } };
}

const LIST: StepHandler<ListExtra> = {
  name: 'run',
  async run(session) {
    const { lines, seen } = await report(session);
    session.extra.seen = seen;
    for (const line of lines) session.out.out(line);
    return { kind: 'done', message: 'the list is complete: nothing was signed, built or changed' };
  },
};

/** The delegation keys of the agents and the subagents, plus the key that the filter names. */
function keysOf(use: UseCase, flags: TaskFlags): string[] {
  const keys = new Set(holdersOf(use).flatMap((holder) => holder.keys));
  const named = flags.value('delegate-key');
  if (named !== undefined && !KEY_HASH.test(named)) keys.add(named);
  return [...keys];
}

const task: TaskDefinition<ListExtra> = {
  name: 'delegations',
  title: 'the live delegations by delegate key, and the delegation keys that are free',
  flags: [],
  valued: ['delegate-key', 'agent'],
  needs: { keys: keysOf, chain: true, hosted: [], approval: 'never' },
  steps: () => [LIST.name],
  parse(_env, _settings, use, flags) {
    const delegateKey = flags.value('delegate-key') ?? null;
    const agent = flags.value('agent') ?? null;
    if (delegateKey !== null && !KEY_HASH.test(delegateKey) && !use.keys.some((spec) => spec.name === delegateKey)) {
      throw new FlagError(`--delegate-key is the name of a key of the use case or the hash of a key (56 lower-case hex characters). The delegation keys are ${keysOf(use, flags).join(', ')}`);
    }
    if (agent !== null && !holdersOf(use).some((holder) => holder.id === agent)) throw new FlagError(`--agent is one of ${holdersOf(use).map((holder) => holder.id).join(', ')}`);
    return { delegateKey, agent, seen: null };
  },
  next: (session) => runSteps(session, [LIST]),
  cleanup: async () => ({ kind: 'done', message: 'the operator cannot end a delegation of a hirer: the hirer ends it with an Undelegate. The janitor of the agent ends a stranded child. Nothing was changed.' }),
  async status(session) {
    try { return (await report(session)).lines; } catch (err) {
      if (err instanceof PreconditionError) return [`the list of the live delegations is not shown: ${err.message}`];
      throw err;
    }
  },
  result: (session) => session.extra.seen ?? {},
};

export default task;
