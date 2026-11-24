import { isDeepStrictEqual } from 'node:util';
// The package entry does not export this lookup or the rules for live holds and parties.
import { findConfigRecord } from '../../../packages/buyer-core/src/vendored/mcp/identity-deployment.ts';
import { accountable, holdsOf, REASON_DISPUTE_VERDICT, terminal } from '../../../packages/buyer-core/src/vendored/mcp/identity-rules.ts';
import { PreconditionError } from '../../checks/lib/session.ts';
import type { AgentSpec, SubagentSpec, TaskDefinition, UseCase } from '../lib/contract.ts';
import { effectiveStatus } from '../lib/platform.ts';
import type { RecordUtxo } from '../lib/platform.ts';
import { readRecord, recordFact, recordSpendStep, resolverReading } from '../lib/record-spend.ts';
import { FlagError, runSteps } from '../lib/runner.ts';

const STEP = 'end-subagents';
const TOOL = 'vector_build_identity_end_subagents';

interface Extra { agent: AgentSpec; children: readonly SubagentSpec[] }

function agentOf(use: UseCase, id: string | undefined): AgentSpec {
  if (id !== undefined) {
    const found = use.agents.find((agent) => agent.id === id);
    if (found === undefined) throw new FlagError(`--agent must name an agent in ${use.name}.`);
    return found;
  }
  const selected = use.agents.filter((agent) => agent.end.subagents === 'ended');
  if (selected.length !== 1) throw new FlagError('Specify --agent. The use case does not identify one agent whose subagents must end.');
  return selected[0]!;
}

function directChild(parent: RecordUtxo, child: RecordUtxo, epoch: number, name: string): string | null {
  const lineage = child.record.lineage;
  if (lineage.type !== 'Subagent' || lineage.parent !== parent.id || lineage.depth !== 1) return `${name} is not a direct child of the selected agent.`;
  if (lineage.parentEpoch !== epoch) return `${name} is not from the current parent epoch ${epoch}.`;
  return null;
}

function endStep(agentId: string) {
  return recordSpendStep<Extra>({
    step: STEP, agentId, tool: TOOL, expectSigners: ['controller', 'fee'], irreversible: 'end-subagents', args: () => ({}),
    async before(parent, session) {
      if (parent.record.controller !== session.registry.publicKeyOf('controller')) throw new PreconditionError('The controller key does not control the selected record.');
      if (terminal(parent.record.status)) throw new PreconditionError('The selected parent record has ended.');
      if (session.extra.children.length === 0) throw new PreconditionError(`The use case lists no subagents of ${agentId}.`);
      const now = session.clock.now();
      const ancestors = new Map([[parent.id, parent.record]]);
      const parentStatus = effectiveStatus(parent.record, new Map(), now, now);
      if (parentStatus === 'Suspended') {
        const { provider, deployment } = session.chain;
        const config = await findConfigRecord(provider, deployment);
        const activeHolds = holdsOf(parent.record.status).filter(({ until }) => until > now);
        if (config === null || !accountable(parent.record, now, now) || activeHolds.length === 0 || !activeHolds.every(({ by, reason, since }) =>
          by.type === 'Script' && by.hash === config.m1 && reason === REASON_DISPUTE_VERDICT && since <= now)) {
          throw new PreconditionError('The parent is Suspended for a reason other than a verified Module-1 verdict hold.');
        }
      }
      for (const { id } of session.extra.children) {
        const child = await readRecord(session, recordFact(session, id).id);
        const problem = directChild(parent, child, parent.record.subagentEpoch, id);
        if (problem !== null) throw new PreconditionError(problem);
        if (terminal(child.record.status) || !accountable(child.record, now, now) || holdsOf(child.record.status).some(({ until }) => until > now)) {
          throw new PreconditionError(`The subagent ${id} is not Active on its own.`);
        }
        // A child otherwise Active can inherit the confirmed parent hold. This check authorizes only the parent epoch change.
        if (effectiveStatus(child.record, ancestors, now, now) !== parentStatus) throw new PreconditionError(`The status of ${id} does not match its parent.`);
      }
    },
    checkBuild(before, after) {
      if (!isDeepStrictEqual(after.record, { ...before.record, subagentEpoch: before.record.subagentEpoch + 1 })
        || after.utxo.assets.lovelace !== before.utxo.assets.lovelace) return 'Only the subagent epoch can change.';
      return null;
    },
    async after(parent, session, before) {
      if (parent.record.subagentEpoch !== before.subagentEpoch + 1) return ['The parent epoch did not rise by one.'];
      const now = session.clock.now();
      const ancestors = new Map([[parent.id, parent.record]]);
      for (const { id } of session.extra.children) {
        let child: RecordUtxo;
        try { child = await readRecord(session, recordFact(session, id).id); } catch (err) {
          if (!(err instanceof PreconditionError)) throw err;
          return [err.message];
        }
        const problem = directChild(parent, child, before.subagentEpoch, id);
        if (problem !== null) return [problem];
        if (terminal(child.record.status) || effectiveStatus(child.record, ancestors, now, now) !== 'Revoked') {
          return [`The epoch change does not show ${id} as Revoked.`];
        }
      }
      return [];
    },
    facts(session, { txHash, at, before, record }) {
      session.facts.put('subagentEnds', [agentId], { tx: txHash, at, epochBefore: before.subagentEpoch, epochAfter: record.record.subagentEpoch });
    },
    async evidence(session, before) {
      const subagents = await Promise.all(session.extra.children.map(async ({ id }) => ({
        agent: id, before: before.effective, after: 'Revoked', resolver: await resolverReading(session, recordFact(session, id).did),
      })));
      return { subagents };
    },
  });
}

const task: TaskDefinition<Extra> = {
  name: STEP, title: 'End all subagents of an agent', flags: [], valued: ['agent'],
  needs: { keys: () => ['controller', 'fee'], chain: true, hosted: [TOOL, 'vector_resolve_did'], approval: 'submit' },
  steps: () => [STEP],
  parse(_env, _settings, use, flags) {
    const agent = agentOf(use, flags.value('agent'));
    return { agent, children: use.subagents.filter(({ parent }) => parent === agent.id) };
  },
  async next(session) {
    const agent = session.extra.agent.id;
    const recorded = session.state.step(STEP);
    if (recorded?.verified_at || (recorded === undefined && session.facts.read().subagentEnds[agent] !== undefined)) {
      throw new PreconditionError(`The end of the subagents for ${agent} is already recorded.`);
    }
    return runSteps(session, [endStep(agent)]);
  },
  async cleanup() { return { kind: 'done', message: 'The end of subagents is permanent. There is nothing to take back.' }; },
  result(session) {
    const agent = session.extra.agent.id;
    return { agent, did: session.facts.read().records[agent]?.did ?? null, end: session.facts.read().subagentEnds[agent] ?? null };
  },
};

export default task;
