// scripts/checks/lib/check-delegation.ts - check 1: a delegation, made with the Delegate and Undelegate builders that buyer-core holds as copies.
//
//   delegate    The member key delegates to the test record. The delegation key of the record, which is the agent key, co-signs: a Delegate transaction needs the signature of the
//               delegator and the signature of the delegate key. The grant is one action on one resource, with no value limit, for the period that the settings give.
//   undelegate  The member key ends the delegation, and its output returns to the wallet of the member. Check 5 (the delegation token) reads this delegation and needs it alive, so
//               this step waits for check 5 unless the operator passes --skip-token-check. The `cleanup` command ends the delegation from any state, with no such wait.
//
// What the hosted tools show after each step (the delegation is live with the grant that the step made, and then it is not live) is the second proof: the hosted server reads the
// ledger on its own.
import { join } from 'node:path';
import { iso, units } from './format.ts';
import type { StepPlan } from './guards.ts';
import { requireRecord } from './record.ts';
import { runSteps, verifyStep } from './runner.ts';
import type { CheckDefinition, StepHandler } from './runner.ts';
import { PreconditionError, commitStep, stepPlan } from './session.ts';
import type { Session, StepOutcome } from './session.ts';
import { EnvReader } from './settings.ts';
import type { Env } from './settings.ts';
import { StateFile } from './state.ts';
import { buildDelegate, buildUndelegate, validActionPattern, validResourcePattern } from './platform.ts';
import { verifyWithTools } from './verify.ts';
import type { ToolCheck } from './verify.ts';

export interface DelegationSettings {
  /** How long the delegation lasts, in hours, from the moment of the Delegate. */
  hours: number;
  action: string;
  resource: string;
}

export const DEFAULT_ACTION = 'mainnet-checks.token.v1';
export const DEFAULT_RESOURCE = 'https://checks.example/token';

export function parseDelegationSettings(env: Env): DelegationSettings {
  const reader = new EnvReader(env);
  const hours = Number(reader.whole('CHECKS_DELEGATION_HOURS', 1n, 720n, 24n));
  const action = reader.text('CHECKS_DELEGATION_ACTION', false) ?? DEFAULT_ACTION;
  const resource = reader.text('CHECKS_DELEGATION_RESOURCE', false) ?? DEFAULT_RESOURCE;
  if (!validActionPattern(action)) reader.problems.push('CHECKS_DELEGATION_ACTION must be an action pattern of the delegation rules, such as mainnet-checks.token.v1');
  if (!validResourcePattern(resource)) reader.problems.push('CHECKS_DELEGATION_RESOURCE must be a resource pattern of the delegation rules, such as https://checks.example/token');
  reader.done();
  return { hours, action, resource };
}

const asList = (value: unknown): string[] => (Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []);
const asRecord = (value: unknown): Record<string, unknown> => (value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {});

/** What `vector_get_delegation` must show for the delegation that the step made. */
function liveDelegation(id: string, facts: Record<string, unknown>): ToolCheck {
  return {
    tool: 'vector_get_delegation', args: { delegation: id },
    problems: (answer) => {
      if (answer.live !== true) return [`the hosted tool does not show the delegation ${id} as live`];
      const link = asRecord(Array.isArray(answer.chain) ? answer.chain[0] : undefined);
      const delegator = asRecord(link.delegator);
      const problems: string[] = [];
      if (link.delegation !== id) problems.push('the first link of the chain is not this delegation');
      if (delegator.type !== 'PrincipalKey' || delegator.key_hash !== facts.delegator_key_hash) problems.push('its delegator is not the member key');
      if (link.delegate !== facts.delegate_id) problems.push('its delegate is not the test record');
      if (link.delegate_key !== facts.delegate_key_hash) problems.push('its delegate key is not the agent key');
      if (JSON.stringify(asList(link.actions)) !== JSON.stringify(facts.actions)) problems.push('its actions are not the ones of the step');
      if (JSON.stringify(asList(link.resources)) !== JSON.stringify(facts.resources)) problems.push('its resources are not the ones of the step');
      if (link.not_after !== facts.not_after) problems.push('its end is not the end of the step');
      return problems;
    },
  };
}

function usable(id: string, action: string, resource: string): ToolCheck {
  return {
    tool: 'vector_check_delegation_use', args: { delegation: id, action, resource },
    problems: (answer) => (answer.usable === true ? [] : [`the hosted tool says that the delegation cannot be used for ${action} on ${resource}: ${asList(answer.problems).join('; ') || 'no reason given'}`]),
  };
}

const delegate: StepHandler<DelegationSettings> = {
  name: 'delegate',
  async run(session) {
    const record = await requireRecord(session, { delegationKey: true });
    const member = session.ring.get('member');
    const agent = session.ring.get('agent');
    const { action, resource, hours } = session.extra;
    const now = session.clock.now();
    const notAfter = now + hours * 3_600_000;
    const context = await session.chain.context(member.address);
    const built = await buildDelegate(context, {
      changeAddress: member.address, nowMs: now, delegator: { type: 'PrincipalKey', hash: member.keyHash }, delegate: record.id, delegateKey: agent.keyHash,
      actions: [action], resources: [resource], notAfter, remaining: 0,
    });
    const deployment = session.chain.deployment;
    const unit = `${deployment.delegation.hash}${built.id}`;
    const output = `${built.txHash}#${built.outputIndex}`;
    const plan: StepPlan = stepPlan(session, {
      outflow: { member: built.outputLovelace + session.settings.maxFeeLovelace },
      destinations: new Set([deployment.delegation.address]), mint: { [unit]: 1n }, labels: { [deployment.delegation.address]: 'the delegation script' },
    });
    const facts = {
      delegation_id: built.id, delegator_key_hash: member.keyHash, delegate_id: record.id, delegate_key_hash: agent.keyHash, actions: [action], resources: [resource],
      not_before: built.delegation.notBefore, not_after: notAfter, output_lovelace: built.outputLovelace, record_did: record.did,
    };
    const request = {
      step: 'delegate', built: { unsignedCbor: built.txCbor, txHash: built.txHash, feeLovelace: BigInt(built.fee), validTo: built.validTo }, plan,
      refs: { delegation_id: built.id, delegation_output: output }, facts,
      notes: [
        `the member key ${member.keyHash} delegates to the record ${record.did}`,
        `grant: the action ${action} on the resource ${resource}, with no value limit, from ${iso(built.delegation.notBefore)} to ${iso(notAfter)}`,
        `the delegate key ${agent.keyHash} co-signs; the delegation is ${built.id}`,
        `deposit: the delegation output holds ${units(built.outputLovelace)}; the step undelegate returns it to the member wallet`,
      ],
    };
    const landed = await session.land(request);
    if (landed.kind === 'dry') return { kind: 'dry' };
    commitStep(session, request, landed, { delegation: built.id, delegation_output: output, ...facts });
    return { kind: 'done', message: `the delegation ${built.id} is confirmed in ${landed.txHash}` };
  },
  async verify(session, record) {
    const facts = record.facts;
    await verifyWithTools(session, 'delegate', [liveDelegation(record.refs.delegation_id!, facts), usable(record.refs.delegation_id!, session.extra.action, session.extra.resource)], { delegation: record.refs.delegation_id, live: true });
  },
};

/** Ends the delegation of the step `delegate`. The wallet of the member gets its output back. */
async function endDelegation(session: Session<DelegationSettings>): Promise<StepOutcome> {
  const record = session.state.step('delegate')!;
  const id = record.refs.delegation_id!;
  const member = session.ring.get('member');
  const context = await session.chain.context(member.address);
  const built = await buildUndelegate(context, { changeAddress: member.address, nowMs: session.clock.now(), id, signer: member.keyHash });
  const deployment = session.chain.deployment;
  const unit = `${deployment.delegation.hash}${id}`;
  const request = {
    step: 'undelegate', built: { unsignedCbor: built.txCbor, txHash: built.txHash, feeLovelace: BigInt(built.fee), validTo: built.validTo },
    plan: stepPlan(session, { outflow: { member: session.settings.maxFeeLovelace }, explained: new Set([record.refs.delegation_output!]), mint: { [unit]: -1n } }),
    refs: { delegation_id: id }, facts: { released_lovelace: built.releasedLovelace },
    notes: [`the member key ends the delegation ${id}; its output of ${units(built.releasedLovelace)} returns to the member wallet`],
  };
  const landed = await session.land(request);
  if (landed.kind === 'dry') return { kind: 'dry' };
  commitStep(session, request, landed, { delegation: id, released_lovelace: built.releasedLovelace });
  return { kind: 'done', message: `the delegation ${id} ended in ${landed.txHash}` };
}

/** Check 5 reads this delegation. The step undelegate waits for it, unless the operator says not to. */
function tokenCheckDone(session: Session<DelegationSettings>): boolean {
  const state = StateFile.peek(join(session.settings.stateDir, 'delegation-token.state.json'));
  return state !== null && state.steps.token !== undefined;
}

const undelegate: StepHandler<DelegationSettings> = {
  name: 'undelegate',
  async run(session, flags) {
    if (!flags.has('--skip-token-check') && !tokenCheckDone(session)) {
      throw new PreconditionError('check 5 (the delegation token) has not run on this delegation: run it first, or pass --skip-token-check to end the delegation now');
    }
    return endDelegation(session);
  },
  async verify(session, record) {
    const id = record.refs.delegation_id!;
    await verifyWithTools(session, 'undelegate', [{
      tool: 'vector_get_delegation', args: { delegation: id },
      problems: (answer) => (answer.live === false ? [] : [`the hosted tool still shows the delegation ${id} as live`]),
    }], { delegation: id, live: false });
  },
};

export const delegationCheck: CheckDefinition<DelegationSettings> = {
  name: 'delegation',
  title: 'a member key delegates to the test record, and ends the delegation',
  needs: { keys: ['controller', 'agent', 'member'], chain: true, hosted: ['vector_get_delegation', 'vector_check_delegation_use'] },
  flags: ['--skip-token-check'],
  steps: ['delegate', 'undelegate'],
  parse: (env) => parseDelegationSettings(env),
  next: (session, flags) => runSteps(session, [delegate, undelegate], flags),
  async cleanup(session) {
    const delegated = session.state.step('delegate');
    if (delegated === undefined) return { kind: 'done', message: 'no delegation was made by this check: there is nothing to take back' };
    if (session.state.step('undelegate') !== undefined) return { kind: 'done', message: 'the delegation has ended already: there is nothing to take back, and no deposit stays locked' };
    const outcome = await endDelegation(session);
    if (outcome.kind !== 'done') return outcome;
    session.out.out(outcome.message);
    await verifyStep(session, undelegate, session.state.step('undelegate')!);
    return { kind: 'done', message: 'nothing stays locked: the output of the delegation is back in the member wallet' };
  },
};
