// scripts/operator/tasks/probe.ts - the task probe: one token request to the identity gateway under a named delegation, with a named delegate key, and a record of what the gateway answers.
// The failure run uses it twice: a control request before the hirer ends the delegation (--expect granted), and a request after the end (--expect refused). The refusal then means something: the
// gateway honoured the delegation a moment before and refuses it now. The probe reads the delegation from the chain first and records whether it is live or ended at that moment.
// The request is made in a dry run too, because it has no effect: --submit only decides whether the evidence file gets the entry. The probe makes no transaction and signs none. It records no step
// in the state file, because one run label holds the control request and the later request, and each is one entry of the evidence.
// The entry holds the arguments by name, the state of the delegation and the observation: the status, the code and the first 300 characters of the text of a refusal, and for a token that was granted
// the type, the end and the grant. It never holds a token or a proof: the token request of `lib/gateway-token.ts` gives neither.
import { iso } from '../../checks/lib/format.ts';
import { HostedError } from '../../checks/lib/hosted.ts';
import { PreconditionError } from '../../checks/lib/session.ts';
import type { AgentSpec, TaskDefinition, TaskSession, UseCase } from '../lib/contract.ts';
import { askForToken } from '../lib/gateway-token.ts';
import type { TokenAnswer } from '../lib/gateway-token.ts';
import { readDelegation, validActionPattern, validResourcePattern } from '../lib/platform.ts';
import { FlagError, runSteps } from '../lib/runner.ts';
import type { StepHandler } from '../lib/runner.ts';

const DEFAULT_AGENT = 'reorder-agent';
const DELEGATION_ID = /^[0-9a-f]{64}$/;
/** The longest text of the gateway that the evidence keeps, and the longest resource that the gateway takes. */
const TEXT_CHARACTERS = 300;
const RESOURCE_CHARACTERS = 512;
/** A compact token: a JWS starts with the base64url of `{"`. A text of the gateway never keeps one. */
const TOKEN_TEXT = /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g;
/** What the gateway answers for a delegation that ended: this status, this code, and a text that says that the delegation was undelegated. */
const REFUSED_STATUS = 400;
const REFUSED_CODE = 'invalid_authorization_details';
const GRANT_MEMBERS = ['type', 'identifier', 'actions', 'locations', 'purpose'];

type Expectation = 'granted' | 'refused';

/** The arguments of one request, all given. */
interface Named {
  readonly key: string;
  readonly delegation: string;
  readonly resource: string;
  readonly action: string;
  readonly expect: Expectation;
}

/** What the last request showed: the machine line carries it. */
interface Seen {
  readonly agent: string;
  readonly key: string;
  readonly delegation: string;
  readonly expect: Expectation;
  readonly observed: string;
  readonly ok: boolean;
  readonly status: number | null;
  readonly error: string | null;
  readonly delegationState: string;
}

/** The members that the command line gave are checked in `parse`. A member that it left out is null, and the step refuses it: `status` takes none of them. */
interface ProbeExtra {
  readonly agent: AgentSpec;
  readonly key: string | null;
  readonly delegation: string | null;
  readonly resource: string | null;
  readonly action: string | null;
  readonly expect: Expectation | null;
  seen: Seen | null;
}

/** The delegation as the chain shows it at the moment of the request. */
interface DelegationState {
  readonly state: 'live' | 'ended' | 'parent ended';
  readonly delegate?: string;
  readonly delegateKey?: string;
  readonly notAfter?: string;
}

interface Verdict {
  readonly ok: boolean;
  readonly observed: string;
  readonly reason: string;
}

const delegationKeysOf = (agent: AgentSpec): string[] => agent.keys.filter((key) => key.purposes.includes('delegation')).map((key) => key.key);

function agentOf(use: UseCase, id: string): AgentSpec {
  const agent = use.agents.find((candidate) => candidate.id === id);
  if (agent === undefined) throw new FlagError(`--agent is one of ${use.agents.map((candidate) => candidate.id).join(', ')}`);
  return agent;
}

/** A resource that the client of the gateway takes: an absolute URI without a fragment, within the pattern rules of a delegation. */
function resourceProblem(resource: string): string | null {
  try { new URL(resource); } catch { return 'it is no absolute URI'; }
  if (resource.includes('#')) return 'it has a fragment';
  if (resource.length > RESOURCE_CHARACTERS) return `it is longer than ${RESOURCE_CHARACTERS} characters`;
  return validResourcePattern(resource) ? null : 'it is no resource of the delegation rules';
}

/** The text of the gateway as the screen and the evidence keep it: without a token-like text, and not longer than 300 characters. */
const shorten = (text: string): string => text.replace(TOKEN_TEXT, '[a token was removed]').slice(0, TEXT_CHARACTERS);

function namedOf(extra: ProbeExtra): Named {
  const { key, delegation, resource, action, expect } = extra;
  if (key === null || delegation === null || resource === null || action === null || expect === null) {
    const missing = Object.entries({ key, delegation, resource, action, expect }).filter(([, value]) => value === null).map(([name]) => `--${name}`);
    throw new FlagError(`probe needs ${missing.join(', ')}`);
  }
  return { key, delegation, resource, action, expect };
}

/** A node that is not on the network of the run would show another chain, and the probe would record the state of a delegation that is not this one. */
function requireNetwork(session: Pick<TaskSession, 'networkResult'>): void {
  const gate = session.networkResult();
  if (gate === null || !gate.ok) throw new PreconditionError(`the node is not shown to be on the network of the run (${gate === null ? 'the network guard did not run' : gate.message}), so no request was sent`);
}

/** Reads the delegation from the chain. A delegation that has an output at the delegation address is live. */
async function delegationState(session: TaskSession<ProbeExtra>, id: string): Promise<DelegationState> {
  try {
    const view = await readDelegation({ provider: session.chain.provider, deployment: session.chain.deployment, koiosUrl: session.chain.koiosUrl, fetchImpl: session.chain.fetchImpl }, id);
    const leaf = view.chain[0];
    if (leaf === undefined) return { state: 'ended' };
    const known = { delegate: leaf.delegation.delegate, delegateKey: leaf.delegation.delegateKey, notAfter: iso(leaf.delegation.notAfter) };
    return view.missingParent === null ? { state: 'live', ...known } : { state: 'parent ended', ...known };
  } catch (err) {
    throw new PreconditionError(`the delegation could not be read from the chain (${err instanceof Error ? err.message : String(err)}), so no request was sent`);
  }
}

const grantOf = (details: readonly Record<string, unknown>[] | null): Record<string, unknown>[] | null =>
  details === null ? null : details.map((detail) => Object.fromEntries(GRANT_MEMBERS.filter((member) => member in detail).map((member) => [member, detail[member]])));

const sameList = (value: unknown, expected: string): boolean => Array.isArray(value) && value.length === 1 && value[0] === expected;

/** True when the token has exactly one grant, and the grant names the delegation, the one action and the one resource of the request. */
function grantMatches(details: readonly Record<string, unknown>[] | null, ask: Named): boolean {
  const [grant] = details ?? [];
  return details !== null && details.length === 1 && grant !== undefined && grant.identifier === ask.delegation && sameList(grant.actions, ask.action) && sameList(grant.locations, ask.resource);
}

function describeAnswer(answer: TokenAnswer): string {
  switch (answer.kind) {
    case 'granted': return 'granted a token';
    case 'refused': return `refused the request (status ${answer.status}, error ${answer.error ?? 'none'})`;
    case 'unreadable': return `gave an answer that is neither a token nor a refusal (status ${answer.status})`;
    case 'unavailable': return `could not answer (status ${answer.status})`;
    default: return 'did not answer';
  }
}

/**
 * Compares what the gateway answered with what the probe expected. `refused` is expected to be the refusal of an ended delegation: status 400, the code invalid_authorization_details, and a text
 * that says that THIS delegation was undelegated. Any other refusal is a refusal for another reason, and it is no match. `granted` is expected to be a token whose grant is exactly the request.
 */
function judge(ask: Named, answer: TokenAnswer): Verdict {
  const observed = answer.kind;
  const no = (reason: string): Verdict => ({ ok: false, observed, reason });
  if (ask.expect === 'granted') {
    if (answer.kind !== 'granted') return no(`the probe expected the gateway to grant a token, and the gateway ${describeAnswer(answer)}`);
    if (!grantMatches(answer.authorizationDetails, ask)) return no('the probe expected a token for the delegation, the action and the resource that it named, and the grant of the token is another grant');
    return { ok: true, observed, reason: 'the gateway granted a token for the delegation, the action and the resource that the probe named' };
  }
  const expected = 'the probe expected the gateway to refuse the request';
  if (answer.kind !== 'refused') return no(`${expected}, and the gateway ${describeAnswer(answer)}`);
  if (answer.status !== REFUSED_STATUS) return no(`${expected} with the status ${REFUSED_STATUS}, and the gateway refused with the status ${answer.status}`);
  if (answer.error !== REFUSED_CODE) return no(`${expected} with the code ${REFUSED_CODE}, and the gateway refused with the code ${answer.error ?? 'none'}`);
  if (!answer.text.includes(`delegation ${ask.delegation} was undelegated`)) return no(`${expected} because the delegation was undelegated, and the text of the gateway does not say so`);
  return { ok: true, observed, reason: 'the gateway refused the request because the delegation was undelegated' };
}

/** What the evidence keeps of an answer: never a token, a proof or a text of more than 300 characters. */
function observationOf(answer: TokenAnswer): Record<string, unknown> {
  switch (answer.kind) {
    case 'granted': return { kind: 'granted', tokenType: answer.tokenType, expiresAt: iso(answer.expiresAt), authorizationDetails: grantOf(answer.authorizationDetails) };
    case 'refused': case 'unavailable': return { kind: answer.kind, status: answer.status, error: answer.error, text: shorten(answer.text) };
    case 'unreadable': return { kind: 'unreadable', status: answer.status, text: shorten(answer.text) };
    default: return { kind: 'unreachable', text: shorten(answer.text) };
  }
}

const delegationLine = (state: DelegationState): string => {
  if (state.state === 'live') return `the delegation is live on the chain; it ends ${state.notAfter}`;
  return state.state === 'ended' ? 'the delegation is not on the chain: it ended' : 'the delegation is on the chain, and its parent ended: it cannot be used';
};

const answerLine = (answer: TokenAnswer): string => {
  switch (answer.kind) {
    case 'granted': return `the gateway granted a token of the type ${answer.tokenType} that ends at ${iso(answer.expiresAt)}`;
    case 'refused': return `the gateway refused the request: status ${answer.status}, error ${answer.error ?? 'none'}, text "${shorten(answer.text)}"`;
    case 'unreadable': return `the answer of the gateway is neither a token nor a refusal: status ${answer.status}, text "${shorten(answer.text)}"`;
    case 'unavailable': return `the gateway cannot answer now: status ${answer.status}, text "${shorten(answer.text)}"`;
    default: return `the gateway cannot be reached: ${shorten(answer.text)}`;
  }
};

const REQUEST: StepHandler<ProbeExtra> = {
  name: 'run',
  async run(session) {
    const agent = session.extra.agent;
    const ask = namedOf(session.extra);
    const record = session.facts.read().records[agent.id];
    if (record === undefined) throw new PreconditionError(`the facts hold no record of the agent ${agent.id}: register it first, so that the probe knows its DID`);
    requireNetwork(session);
    const state = await delegationState(session, ask.delegation);
    if (state.state === 'live' && state.delegate !== record.id) throw new PreconditionError(`the live delegation names another delegate than the agent ${agent.id}, so no request was sent`);
    if (state.state === 'live' && state.delegateKey !== session.registry.hashOf(ask.key)) throw new PreconditionError(`the live delegation names another delegate key than ${ask.key}, so no request was sent`);
    session.out.out(`probe: the agent ${agent.id} (${record.did}) asks for a token under the delegation ${ask.delegation} with the delegate key ${ask.key}`);
    session.out.out(`the request: the action ${ask.action} on the resource ${ask.resource}`);
    session.out.out(delegationLine(state));
    const answer = await askForToken(session, { did: record.did, subjectKey: agent.serviceKey, dpopKey: ask.key, delegation: ask.delegation, action: ask.action, resource: ask.resource });
    const verdict = judge(ask, answer);
    const observation = observationOf(answer);
    const status = typeof observation.status === 'number' ? observation.status : null;
    const error = typeof observation.error === 'string' ? observation.error : null;
    session.extra.seen = { agent: agent.id, key: ask.key, delegation: ask.delegation, expect: ask.expect, observed: verdict.observed, ok: verdict.ok, status, error, delegationState: state.state };
    session.out.out(answerLine(answer));
    session.out.out(`verdict: expected ${ask.expect}, observed ${verdict.observed}: ${verdict.ok ? 'as expected' : 'NOT as expected'}. ${verdict.reason}`);
    if (session.mode === 'submit') {
      const summary = `expected ${ask.expect}, observed ${verdict.observed}${status === null ? '' : ` (status ${status})`}: ${verdict.ok ? 'as expected' : 'NOT as expected'}`;
      session.evidence.add({
        step: REQUEST.name, status: 'info',
        shows: {
          summary, probe: { agent: agent.id, key: ask.key, delegation: ask.delegation, resource: ask.resource, action: ask.action, expect: ask.expect }, delegation: state, observation,
          verdict: { expected: ask.expect, observed: verdict.observed, ok: verdict.ok, reason: verdict.reason },
        },
      });
      session.out.out('the evidence file got the entry');
    } else {
      session.out.out('the evidence file was not written: this is a dry run, and --submit writes the entry');
    }
    if (answer.kind === 'unreachable') throw new HostedError('unreachable', `the gateway cannot be reached: ${shorten(answer.text)}`);
    if (answer.kind === 'unavailable') throw new HostedError('unreachable', `the gateway cannot answer now (status ${answer.status}): ${shorten(answer.text)}`);
    if (!verdict.ok) throw new Error(`probe failed: ${verdict.reason}`);
    return { kind: 'done', message: `probe ok: ${verdict.reason}` };
  },
};

/** The line of an entry of the evidence for `status`: the time and the summary that the entry holds. */
function summaryOf(entry: Record<string, unknown>): string | null {
  const shows = entry.shows;
  if (typeof shows !== 'object' || shows === null || !('summary' in shows) || typeof shows.summary !== 'string') return null;
  return `${typeof entry.at === 'string' ? entry.at : 'an unknown time'}: ${shows.summary}`;
}

const task: TaskDefinition<ProbeExtra> = {
  name: 'probe',
  title: 'one token request to the gateway under a delegation, and what the gateway answers',
  flags: [],
  valued: ['agent', 'key', 'delegation', 'resource', 'action', 'expect'],
  needs: {
    keys: (use, flags) => {
      const agent = agentOf(use, flags.value('agent') ?? DEFAULT_AGENT);
      const key = flags.value('key');
      return key === undefined ? [agent.serviceKey] : [agent.serviceKey, key];
    },
    // The delegation is read from the chain: `chain` gives the node, the network guard and the reads. The probe signs and builds no transaction.
    chain: true, hosted: [], approval: 'never',
  },
  steps: () => [REQUEST.name],
  parse(_env, _settings, use, flags) {
    if (flags.value('run') === undefined) throw new FlagError('probe needs --run <label>');
    const agent = agentOf(use, flags.value('agent') ?? DEFAULT_AGENT);
    if (!agent.keys.some((key) => key.key === agent.serviceKey && key.purposes.includes('authentication'))) {
      throw new PreconditionError(`the data of the use case does not list the service key of the agent ${agent.id} with the authentication purpose`);
    }
    const key = flags.value('key') ?? null;
    if (key !== null && !delegationKeysOf(agent).includes(key)) {
      throw new FlagError(`--key is a delegation key of the agent ${agent.id}: ${delegationKeysOf(agent).join(', ') || 'it has none'}`);
    }
    const delegation = flags.value('delegation') ?? null;
    if (delegation !== null && !DELEGATION_ID.test(delegation)) throw new FlagError('--delegation is the identifier of a delegation: 64 lower-case hex characters');
    const resource = flags.value('resource') ?? null;
    const problem = resource === null ? null : resourceProblem(resource);
    if (problem !== null) throw new FlagError(`--resource is an absolute URI without a fragment, or a script resource: ${problem}`);
    const action = flags.value('action') ?? null;
    if (action !== null && !validActionPattern(action)) throw new FlagError('--action is an action of the delegation rules, such as po.write');
    const expect = flags.value('expect') ?? null;
    if (expect !== null && expect !== 'granted' && expect !== 'refused') throw new FlagError('--expect is granted or refused');
    return { agent, key, delegation, resource, action, expect, seen: null };
  },
  next: (session) => runSteps(session, [REQUEST]),
  cleanup: async () => ({ kind: 'done', message: 'the probe makes no transaction and holds nothing: there is nothing to take back' }),
  async status(session) {
    const lines = session.evidence.entries().flatMap((entry) => summaryOf(entry) ?? []);
    return [`requests that the evidence holds: ${lines.length}`, ...lines.map((line, index) => `request ${index + 1} at ${line}`)];
  },
  result: (session) => session.extra.seen ?? {},
};

export default task;
