// The probe makes one token request under a named delegation or for a subagent itself.
// It reads the delegation or the subagent's effective status from the chain before it sends the request.
// Both dry mode and submit mode send the request. Only submit mode writes the evidence entry. Neither mode signs or builds a transaction.
// The evidence and the machine line never hold the subject token, the access token or the DPoP proof.
import { EvidenceError } from '../../checks/lib/evidence.ts';
import { iso } from '../../checks/lib/format.ts';
import { HostedError } from '../../checks/lib/hosted.ts';
import { PreconditionError } from '../../checks/lib/session.ts';
import type { AgentSpec, SubagentSpec, TaskDefinition, TaskFlags, TaskSession, UseCase } from '../lib/contract.ts';
import { askForSubagentToken, askForToken } from '../lib/gateway-token.ts';
import type { TokenAnswer } from '../lib/gateway-token.ts';
import { effectiveStatus, findRecord, PURPOSE, readDelegation, validActionPattern, validResourcePattern } from '../lib/platform.ts';
import { FlagError, runSteps } from '../lib/runner.ts';
import type { StepHandler } from '../lib/runner.ts';
// The buyer-core entry exports the record lookup but not its ancestor reader.
import { ancestorsOf } from '../../../packages/buyer-core/src/vendored/mcp/identity-chain.ts';

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

interface RequestArgs {
  readonly resource: string;
  readonly action: string;
  readonly expect: Expectation;
}

interface SubagentTarget {
  readonly kind: 'subagent';
  readonly subagent: SubagentSpec;
  readonly subjectKey: string;
  readonly dpopKey: string;
}

interface DelegatedTarget {
  readonly kind: 'delegation';
  readonly agent: AgentSpec;
  readonly key: string | null;
  readonly delegation: string | null;
}

type Named = RequestArgs & { readonly kind: 'delegation'; readonly agent: AgentSpec; readonly key: string; readonly delegation: string };
type SubagentRequest = RequestArgs & SubagentTarget;
type Effective = Lowercase<ReturnType<typeof effectiveStatus>>;

type SeenSubject =
  | { readonly agent: string; readonly key: string; readonly delegation: string; readonly delegationState: string }
  | { readonly subagent: string; readonly did: string; readonly subjectKey: string; readonly dpopKey: string; readonly resource: string; readonly action: string; readonly effectiveStatus: Effective };

/** What the last request showed: the machine line carries it. */
type Seen = SeenSubject & {
  readonly expect: Expectation;
  readonly observed: string;
  readonly ok: boolean;
  readonly status: number | null;
  readonly error: string | null;
  readonly text?: string | null;
};

/** The members that the command line gave are checked in `parse`. A member that it left out is null, and the step refuses it: `status` takes none of them. */
interface ProbeExtra {
  readonly target: DelegatedTarget | SubagentTarget;
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

function subagentTargetOf(use: UseCase, id: string): SubagentTarget {
  const subagent = use.subagents.find((candidate) => candidate.id === id);
  if (subagent === undefined) throw new FlagError(`--subagent is one of ${use.subagents.map((candidate) => candidate.id).join(', ') || 'the subagents of the use case; it has none'}`);
  const [subjectKey, extraSubjectKey] = subagent.keys.filter((key) => key.purposes.includes('authentication'));
  const [dpopKey, extraDpopKey] = subagent.keys.filter((key) => key.purposes.includes('delegation'));
  if (subjectKey === undefined || extraSubjectKey !== undefined || dpopKey === undefined || extraDpopKey !== undefined || subjectKey.key === dpopKey.key) {
    throw new FlagError(`the subagent ${subagent.id} needs exactly one authentication key and one different delegation key`);
  }
  return { kind: 'subagent', subagent, subjectKey: subjectKey.key, dpopKey: dpopKey.key };
}

function targetOf(use: UseCase, flags: TaskFlags): DelegatedTarget | SubagentTarget {
  const subagent = flags.value('subagent');
  if (subagent !== undefined) {
    if (['agent', 'key', 'delegation'].some((name) => flags.has(name))) throw new FlagError('--subagent excludes --agent, --key and --delegation');
    return subagentTargetOf(use, subagent);
  }
  return { kind: 'delegation', agent: agentOf(use, flags.value('agent') ?? DEFAULT_AGENT), key: flags.value('key') ?? null, delegation: flags.value('delegation') ?? null };
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

function namedOf(extra: ProbeExtra): Named | SubagentRequest {
  const { target, resource, action, expect } = extra;
  if (resource !== null && action !== null && expect !== null) {
    if (target.kind === 'subagent') return { ...target, resource, action, expect };
    if (target.key !== null && target.delegation !== null) return { ...target, key: target.key, delegation: target.delegation, resource, action, expect };
  }
  const given = target.kind === 'subagent' ? { resource, action, expect } : { key: target.key, delegation: target.delegation, resource, action, expect };
  const missing = Object.entries(given).filter(([, value]) => value === null).map(([name]) => `--${name}`);
  throw new FlagError(`probe needs ${missing.join(', ')}`);
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

/** Reads the current subject and its ancestors, never a snapshot from the facts file. */
async function subagentStatus(session: TaskSession<ProbeExtra>, ask: SubagentRequest): Promise<{ did: string; effectiveStatus: Effective }> {
  const { subagent, subjectKey, dpopKey } = ask;
  const records = session.facts.read().records;
  const subject = records[subagent.id];
  const parent = records[subagent.parent];
  if (subject === undefined || parent === undefined) throw new PreconditionError(`the facts need the records of ${subagent.id} and its parent ${subagent.parent}, so no request was sent`);
  if (subject.did !== `did:vector:${subject.id}` || parent.did !== `did:vector:${parent.id}`) throw new PreconditionError('the record identifiers in the facts and their DIDs do not agree, so no request was sent');
  const auth = session.registry.publicKeyOf(subjectKey);
  const proof = session.registry.publicKeyOf(dpopKey);
  if (auth === proof) throw new PreconditionError(`the authentication and delegation keys of ${subagent.id} must be different, so no request was sent`);

  const { provider, deployment } = session.chain;
  try {
    const found = await findRecord(provider, deployment, subject.id);
    if (found === null) throw new PreconditionError(`no current record of ${subagent.id} is on the chain, so no request was sent`);
    const { record } = found;
    if (record.lineage.type !== 'Subagent' || record.lineage.parent !== parent.id) {
      throw new PreconditionError(`the chain record of ${subagent.id} does not name the expected parent ${subagent.parent}, so no request was sent`);
    }
    const lists = (key: string, purpose: number): boolean => record.keys.some((listed) => listed.keyType === 'Ed25519' && listed.key === key && (listed.purposes & purpose) !== 0);
    if (!lists(auth, PURPOSE.authentication) || !lists(proof, PURPOSE.delegation)) {
      throw new PreconditionError(`the chain record of ${subagent.id} does not list the named authentication and delegation keys with their purposes, so no request was sent`);
    }
    const ancestors = await ancestorsOf(provider, deployment, record);
    const now = session.clock.now();
    const status = effectiveStatus(record, new Map(ancestors.map((ancestor) => [ancestor.id, ancestor.record])), now, now);
    return { did: subject.did, effectiveStatus: status.toLowerCase() as Effective };
  } catch (err) {
    if (err instanceof PreconditionError) throw err;
    throw new PreconditionError(`the record of ${subagent.id} and its ancestors could not be read from the chain, so no request was sent`);
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
  const no = (reason: string): Verdict => ({ ok: false, observed: answer.kind === ask.expect ? `${answer.kind} (not the expected answer)` : observed, reason });
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

function judgeSubagent(expect: Expectation, status: Effective, answer: TokenAnswer): Verdict {
  const no = (reason: string): Verdict => ({ ok: false, observed: answer.kind === expect ? `${answer.kind} (not the expected answer)` : answer.kind, reason });
  if (expect === 'granted') {
    if (answer.kind !== 'granted') return no(`the probe expected the gateway to grant a token, and the gateway ${describeAnswer(answer)}`);
    return status === 'active'
      ? { ok: true, observed: 'granted', reason: 'the gateway granted a token for the active subagent without a delegation' }
      : no(`the gateway granted a token, but the subagent is ${status} on the chain`);
  }
  if (answer.kind !== 'refused') return no(`the probe expected the gateway to refuse the request, and the gateway ${describeAnswer(answer)}`);
  if (status === 'active') return no('the subagent is active on the chain, so the refusal does not show an ended authority');
  if (answer.status !== 400 && answer.status !== 401) return no('the gateway did not refuse the subject with HTTP 400 or 401');
  if ((answer.error !== 'invalid_request' && answer.error !== 'agent_not_active' && answer.error !== 'invalid_token')
    || !answer.text.startsWith(`subject_token: the agent's effective status is ${status}`)) {
    return no(`the gateway did not refuse the request because the subagent is ${status}`);
  }
  return { ok: true, observed: 'refused', reason: `the gateway refused the request because the subagent is ${status}` };
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

const requestSummary = (expected: Expectation, observed: string, ok: boolean, status: number | null): string =>
  `expected ${expected}, observed ${observed}${status === null ? '' : ` (status ${status})`}: ${ok ? 'as expected' : 'NOT as expected'}`;

function finish(session: TaskSession<ProbeExtra>, expect: Expectation, answer: TokenAnswer, verdict: Verdict, subject: SeenSubject, shows: Record<string, unknown>) {
  const observation = observationOf(answer);
  const subagent = 'subagent' in subject;
  if (subagent && answer.kind === 'granted') observation.status = 200;
  const status = typeof observation.status === 'number' ? observation.status : null;
  const error = typeof observation.error === 'string' ? observation.error : null;
  const text = typeof observation.text === 'string' ? observation.text : null;
  session.extra.seen = { ...subject, expect, observed: verdict.observed, ok: verdict.ok, status, error, ...(subagent ? { text } : {}) };
  session.out.out(answerLine(answer));
  session.out.out(`verdict: expected ${expect}, observed ${verdict.observed}: ${verdict.ok ? 'as expected' : 'NOT as expected'}. ${verdict.reason}`);
  if (session.mode === 'submit') {
    const summary = requestSummary(expect, verdict.observed, verdict.ok, status);
    session.evidence.add({
      step: REQUEST.name, status: 'info',
      shows: { summary, ...shows, observation, verdict: { expected: expect, observed: verdict.observed, ok: verdict.ok, reason: verdict.reason } },
    });
    session.out.out('the evidence file got the entry');
  } else {
    session.out.out('the evidence file was not written: this is a dry run, and --submit writes the entry');
  }
  if (answer.kind === 'unreachable') throw new HostedError('unreachable', `the gateway cannot be reached: ${shorten(answer.text)}`);
  if (answer.kind === 'unavailable') throw new HostedError('unreachable', `the gateway cannot answer now (status ${answer.status}): ${shorten(answer.text)}`);
  if (!verdict.ok) throw new Error(`probe failed: ${verdict.reason}`);
  return { kind: 'done' as const, message: `probe ok: ${verdict.reason}` };
}

async function probeSubagent(session: TaskSession<ProbeExtra>, ask: SubagentRequest) {
  requireNetwork(session);
  const record = await subagentStatus(session, ask);
  const { subagent, subjectKey, dpopKey, resource, action, expect } = ask;
  session.out.out(`probe: the subagent ${subagent.id} (${record.did}) asks for a token without a delegation`);
  session.out.out(`the token resource: ${resource}; the action ${action} labels the observation and is not an action grant`);
  session.out.out(`the effective status of the subagent on the chain: ${record.effectiveStatus}`);
  const answer = await askForSubagentToken(session, { did: record.did, subjectKey, dpopKey, resource, action });
  const verdict = judgeSubagent(expect, record.effectiveStatus, answer);
  const names = { subagent: subagent.id, subjectKey, dpopKey, resource, action };
  return finish(session, expect, answer, verdict, { ...names, ...record }, { probe: { ...names, expect }, record });
}

const REQUEST: StepHandler<ProbeExtra> = {
  name: 'run',
  async run(session) {
    const ask = namedOf(session.extra);
    if (ask.kind === 'subagent') return probeSubagent(session, ask);
    const agent = ask.agent;
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
    return finish(session, ask.expect, answer, verdict,
      { agent: agent.id, key: ask.key, delegation: ask.delegation, delegationState: state.state },
      { probe: { agent: agent.id, key: ask.key, delegation: ask.delegation, resource: ask.resource, action: ask.action, expect: ask.expect }, delegation: state },
    );
  },
};

const entryObject = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

const savedTime = (value: unknown): value is string => {
  if (typeof value !== 'string') return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && iso(time) === value;
};

function savedObservation(value: unknown): { kind: TokenAnswer['kind']; status: number | null } {
  const observation = entryObject(value);
  const kind = observation?.kind;
  const status = observation?.status;
  if (kind === 'granted') {
    // The delegated writer had no status field. The subagent writer can also record 200.
    if ((status === undefined || status === 200) && observation?.tokenType === 'DPoP' && savedTime(observation.expiresAt)) {
      return { kind, status: status ?? null };
    }
  } else if (kind === 'unreachable') {
    if (status === undefined) return { kind, status: null };
  } else if (kind === 'refused' || kind === 'unavailable' || kind === 'unreadable') {
    if (typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599) return { kind, status };
  }
  throw new EvidenceError('the saved probe entry has no valid observation');
}

/** The probe never lands a transaction, so its journal has no runner transaction events. */
function summaryOf(entry: Record<string, unknown>): string {
  if (entry.step !== REQUEST.name || entry.status !== 'info' || !savedTime(entry.at)) {
    throw new EvidenceError('the saved probe journal has an unrecognized entry or invalid time');
  }
  const shows = entryObject(entry.shows);
  const { kind, status } = savedObservation(shows?.observation);
  const verdict = entryObject(shows?.verdict);
  const expected = verdict?.expected;
  const ok = verdict?.ok;
  if ((expected !== 'granted' && expected !== 'refused') || typeof ok !== 'boolean' || (ok && kind !== expected)) {
    throw new EvidenceError('the saved probe entry has no valid verdict');
  }
  const sameKindFailure = !ok && kind === expected;
  const observed = sameKindFailure ? `${kind} (not the expected answer)` : kind;
  // Earlier journals used the bare observation kind for this same failure.
  if (verdict?.observed !== observed && !(sameKindFailure && verdict?.observed === kind)) {
    throw new EvidenceError('the saved probe verdict does not match its observation');
  }
  return `${entry.at}: ${requestSummary(expected, observed, ok, status)}`;
}

const task: TaskDefinition<ProbeExtra> = {
  name: 'probe',
  title: 'one token request to the gateway under a delegation or for a subagent',
  flags: [],
  valued: ['agent', 'key', 'delegation', 'subagent', 'resource', 'action', 'expect'],
  needs: {
    keys: (use, flags) => {
      const target = targetOf(use, flags);
      if (target.kind === 'subagent') return [target.subjectKey, target.dpopKey];
      return target.key === null ? [target.agent.serviceKey] : [target.agent.serviceKey, target.key];
    },
    // The delegation is read from the chain: `chain` gives the node, the network guard and the reads. The probe signs and builds no transaction.
    chain: true, hosted: [], approval: 'never',
  },
  steps: () => [REQUEST.name],
  parse(_env, _settings, use, flags) {
    if (flags.value('run') === undefined) throw new FlagError('probe needs --run <label>');
    const target = targetOf(use, flags);
    if (target.kind === 'delegation') {
      const { agent, key, delegation } = target;
      if (!agent.keys.some((member) => member.key === agent.serviceKey && member.purposes.includes('authentication'))) {
        throw new PreconditionError(`the data of the use case does not list the service key of the agent ${agent.id} with the authentication purpose`);
      }
      const keys = delegationKeysOf(agent);
      if (key !== null && !keys.includes(key)) throw new FlagError(`--key is a delegation key of the agent ${agent.id}: ${keys.join(', ') || 'it has none'}`);
      if (delegation !== null && !DELEGATION_ID.test(delegation)) throw new FlagError('--delegation is the identifier of a delegation: 64 lower-case hex characters');
    }
    const resource = flags.value('resource') ?? null;
    const problem = resource === null ? null : resourceProblem(resource);
    if (problem !== null) throw new FlagError(`--resource is an absolute URI without a fragment, or a script resource: ${problem}`);
    const action = flags.value('action') ?? null;
    if (action !== null && !validActionPattern(action)) throw new FlagError('--action is an action of the delegation rules, such as po.write');
    const expect = flags.value('expect') ?? null;
    if (expect !== null && expect !== 'granted' && expect !== 'refused') throw new FlagError('--expect is granted or refused');
    return { target, resource, action, expect, seen: null };
  },
  next: (session) => runSteps(session, [REQUEST]),
  cleanup: async () => ({ kind: 'done', message: 'the probe makes no transaction and holds nothing: there is nothing to take back' }),
  async inspectStatus(input) {
    const lines = input.readEvidence().map(summaryOf);
    return [`requests that the evidence holds: ${lines.length}`, ...lines.map((line, index) => `request ${index + 1} at ${line}`)];
  },
  result: (session) => session.extra.seen ?? {},
};

export default task;
