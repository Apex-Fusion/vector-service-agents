// scripts/operator/tasks/delegations.ts - the task delegations: a read-only list of the live delegations on the chain, by delegate key, so that the operator sees which delegation key is in use.
// Each agent reads exactly its own delegation keys, and a delegate key has at most one live delegation (the builder of a delegation refuses a key that a live delegation uses). The list shows each
// live delegation with its delegate key and the registry name of that key. The summary shows each delegation key of each agent of the use case as free or in use, from ALL live delegations: a
// filter narrows the list and never the summary. A delegation stays live after its end until the hirer ends it with an Undelegate, so the key stays in use: the line says so.
// The task reads the chain and the facts. It signs nothing, builds nothing and writes nothing but its output. The operator cannot end the delegation of a hirer: `cleanup` says that.
import { duration, iso, units } from '../../checks/lib/format.ts';
import { PreconditionError } from '../../checks/lib/session.ts';
import type { ValueLimit } from '../../checks/lib/platform.ts';
import type { TaskDefinition, TaskFlags, TaskSession, UseCase } from '../lib/contract.ts';
import { liveDelegations } from '../lib/platform.ts';
import { FlagError, runSteps } from '../lib/runner.ts';
import type { StepHandler } from '../lib/runner.ts';

/** The members of a live delegation that the list reads: the `DelegationUtxo` of buyer-core has them all. */
interface Live {
  readonly id: string;
  readonly delegation: {
    readonly delegator: { readonly type: 'PrincipalKey'; readonly hash: string } | { readonly type: 'Agent'; readonly id: string };
    readonly delegate: string;
    readonly delegateKey: string;
    readonly actions: readonly string[];
    readonly resources: readonly string[];
    readonly notAfter: number;
    readonly remaining: number;
    readonly value: ValueLimit | null;
  };
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
function linesOf(live: Live, session: TaskSession<ListExtra>): string[] {
  const { delegation, id } = live;
  const keyName = session.registry.nameOfHash(delegation.delegateKey);
  const agent = Object.entries(session.facts.read().records).find(([, fact]) => fact.id === delegation.delegate)?.[0];
  const now = session.clock.now();
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

/** Reads the live delegations, applies the filters, and writes the list and the summary. */
async function report(session: TaskSession<ListExtra>): Promise<{ lines: string[]; seen: Seen }> {
  requireNetwork(session);
  const { delegateKey, agent } = session.extra;
  let wantedAgent: string | null = null;
  if (agent !== null) {
    const record = session.facts.read().records[agent];
    if (record === undefined) throw new PreconditionError(`the facts hold no record of the agent ${agent}: register it first, or leave out --agent`);
    wantedAgent = record.id;
  }
  const wantedKey = delegateKey === null ? null : KEY_HASH.test(delegateKey) ? delegateKey : session.registry.hashOf(delegateKey);
  const live = await liveDelegations(session.chain.provider, session.chain.deployment);
  const shown = live.filter(({ delegation }) => (wantedKey === null || delegation.delegateKey === wantedKey) && (wantedAgent === null || delegation.delegate === wantedAgent));
  const filters = [delegateKey === null ? null : `the delegate key ${delegateKey}`, agent === null ? null : `the agent ${agent}`].filter((filter) => filter !== null);
  const lines = [`live delegations on the chain: ${live.length}`, ...(filters.length === 0 ? [] : [`filter: ${filters.join(' and ')}, ${shown.length} shown`])];
  if (shown.length === 0) lines.push('no live delegation to show');
  for (const delegation of shown) lines.push(...linesOf(delegation, session));
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
  return { lines, seen: { live: live.length, shown: shown.length, keys } };
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

/** The names of the keys that the task loads: the delegation keys of the agents, and the key that a filter names when it names one that is not among them. */
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
  cleanup: async () => ({ kind: 'done', message: 'the operator cannot end a delegation of a hirer: the hirer ends it with an Undelegate. Nothing was changed.' }),
  async status(session) {
    try { return (await report(session)).lines; } catch (err) {
      if (err instanceof PreconditionError) return [`the list of the live delegations is not shown: ${err.message}`];
      throw err;
    }
  },
  result: (session) => session.extra.seen ?? {},
};

export default task;
