// scripts/operator/tasks/fault.ts - the task fault: it sets the switch FAULT_MODE of an agent in its service env file, and it checks with the fault guards of the kit that a run is clean or has the fault
// that the run needs.
//   --set <value>    Sets FAULT_MODE in the service env file of --agent (use --set= for the empty value; with no --agent the empty value goes into the file of every agent). The value must be a setting of
//                    the kind of the agent. A service reads the switch when its container is created, so the container is created again by the restart rule (every runtime free first).
//   --check clean    Reads `seen-services.json`, which the script that runs the pack writes before every run from the running containers, and runs the guard of a clean run.
//   --check <value>  The same with the guard of a fault run: `--agent` names the service that must hold the value, and every other service must hold none. `--run <label>` is required.
// The file must be at most 10 minutes old, and it must have exactly the shape that the script writes, and it must show each service of the use case once. A file that does not is a precondition
// that fails (exit 2): no check passes without a fresh and whole reading of the services. A refusal of the guard is exit 1 with its code. With --submit the result is written into the evidence file of
// the run as an entry `fault_check`, with the start time of each service: a run is checked before its first hire and again after its last, and the two entries must show one start time for each service.
import { lstatSync, readFileSync } from 'node:fs';
import type { Stats } from 'node:fs';
import { join } from 'node:path';
import { PreconditionError } from '../../checks/lib/session.ts';
import type { AgentSpec, TaskDefinition, TaskSession, UseCase } from '../lib/contract.ts';
import { EnvFile, EnvFileError } from '../lib/envfile.ts';
import { FAULT_MODE_VARIABLE, checkCleanRun, checkFaultRun, isFaultSetting } from '../lib/platform.ts';
import { codeOf } from '../lib/registry.ts';
import { FlagError } from '../lib/runner.ts';

const FILE = 'seen-services.json';
/** The file is written before every run, so a file that is older than this is not the state of this run. */
const MAX_AGE_MS = 10 * 60_000;
/** A small step of the clock is no fault. A file from the future by more than this is a damaged file. */
const MAX_AHEAD_MS = 60_000;
const MAX_FILE_CHARS = 262_144;
const ISO_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/;
const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
/** What a fault value looks like: lower-case letters and underscores, at most 24 characters. It has no digit and it is short, so a key in hex never passes (the kit shows a value by the same rule). Any other value is shown as a phrase, so that the evidence and the output never hold a text of a file that is no fault name. */
const FAULT_NAME = /^[a-z][a-z_]{0,23}$/;

/** What the task keeps for the machine line. */
interface Extra { result: Readonly<Record<string, unknown>> | null }

/** One service of the file, as the script wrote it. */
interface Seen { readonly kind: string; readonly startedAt: string; readonly value: string }

/** What a step of this task ends with: shown only (a dry run of --set), or done. */
type Ended = { kind: 'dry' } | { kind: 'done'; message: string };

const reasonOf = (err: unknown): string => (err instanceof EnvFileError ? err.message : codeOf(err));

/** A value of FAULT_MODE for a line of output or an entry of evidence: the empty text, a fault name, or a phrase. */
const shown = (value: string): string => (value === '' || FAULT_NAME.test(value) ? value : 'a value that is no fault name');
const named = (value: string): string => (value === '' ? 'empty' : shown(value));

// ---- the file `seen-services.json` ----

/** The POSIX milliseconds of an ISO 8601 time with a zone (`Z` or an offset), with up to nine decimals, or null when the value is no such time or names a moment that does not exist. */
function timeOf(value: unknown): number | null {
  const parts = typeof value === 'string' ? ISO_TIME.exec(value) : null;
  if (parts === null) return null;
  const [year, month, day, hour, minute, second] = parts.slice(1, 7).map(Number);
  const utc = Date.UTC(year, month - 1, day, hour, minute, second, parts[7] === undefined ? 0 : Number(parts[7].slice(0, 3).padEnd(3, '0')));
  const moment = new Date(utc);
  if (moment.getUTCFullYear() !== year || moment.getUTCMonth() !== month - 1 || moment.getUTCDate() !== day || moment.getUTCHours() !== hour || moment.getUTCMinutes() !== minute || moment.getUTCSeconds() !== second) return null;
  const zone = parts[8]!;
  if (zone === 'Z') return utc;
  const [offsetHours, offsetMinutes] = [Number(zone.slice(1, 3)), Number(zone.slice(4, 6))];
  if (offsetHours > 23 || offsetMinutes > 59) return null;
  const offset = (offsetHours * 60 + offsetMinutes) * 60_000;
  return zone.startsWith('+') ? utc - offset : utc + offset;
}

/**
 * True when an object of the JSON text holds a member twice. `JSON.parse` keeps the last of two equal members and says nothing, so a second `FAULT_MODE` or a second `services` could hide a fault that
 * the first one shows. The text must be valid JSON already: the scan follows strings and brackets only.
 */
function repeatsAMember(json: string): boolean {
  const open: (Set<string> | null)[] = [];
  for (let i = 0; i < json.length; i++) {
    const char = json[i];
    if (char === '{') open.push(new Set());
    else if (char === '[') open.push(null);
    else if (char === '}' || char === ']') open.pop();
    else if (char === '"') {
      let end = i + 1;
      while (end < json.length && json[end] !== '"') end += json[end] === '\\' ? 2 : 1;
      let next = end + 1;
      while (next < json.length && ' \t\n\r'.includes(json[next]!)) next++;
      const members = open[open.length - 1];
      if (members !== undefined && members !== null && json[next] === ':') {
        const name: string = JSON.parse(json.slice(i, end + 1));
        if (members.has(name)) return true;
        members.add(name);
      }
      i = end;
    }
  }
  return false;
}

/** The members of a plain object that has exactly the members `names`, or null when `value` is no plain object or has more or fewer members. */
function exactly(value: unknown, names: readonly string[]): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return Object.keys(value).length === names.length && names.every((name) => Object.hasOwn(value, name)) ? Object.fromEntries(Object.entries(value)) : null;
}

/**
 * Reads `seen-services.json`: `{ generated_at, services: [{ service, kind, container, started_at, env: { FAULT_MODE } }] }`, with no other member at any of these places. The file must be there, hold JSON
 * with no member twice, be at most 10 minutes old at `nowMs` (and no more than a minute from the future), list at least one service, and give each service a name, a kind, a container, a start time
 * (an ISO 8601 time with a zone) and an environment that holds the one variable FAULT_MODE as a text. Any other file is a PreconditionError. A refusal never shows a value of the file.
 */
function readSeen(path: string, nowMs: number): ReadonlyMap<string, Seen> {
  if (!Number.isFinite(nowMs)) throw new PreconditionError(`the clock gave no valid time, so ${FILE} cannot be checked`);
  let text: string;
  try { text = readFileSync(path, 'utf8'); } catch (err) {
    throw new PreconditionError(codeOf(err) === 'ENOENT' ? `${FILE} does not exist: the script that runs the pack writes it before every run, from the running containers` : `${FILE} could not be read (${codeOf(err)})`);
  }
  if (text.length > MAX_FILE_CHARS) throw new PreconditionError(`${FILE} is longer than ${MAX_FILE_CHARS} characters, and a list of the running services is not`);
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new PreconditionError(`${FILE} is not JSON`); }
  if (repeatsAMember(text)) throw new PreconditionError(`${FILE} has a member twice, so it can be read two ways`);
  const top = exactly(parsed, ['generated_at', 'services']);
  if (top === null) throw new PreconditionError(`${FILE} does not have the shape that it must have: exactly the members generated_at and services`);
  const generated = timeOf(top.generated_at);
  if (generated === null) throw new PreconditionError(`${FILE}: generated_at is not an ISO 8601 time with a zone`);
  if (nowMs - generated > MAX_AGE_MS) throw new PreconditionError(`${FILE} is more than 10 minutes old: the script that runs the pack writes it before every run, so this is not the state of this run`);
  if (generated - nowMs > MAX_AHEAD_MS) throw new PreconditionError(`${FILE}: generated_at is in the future, so the clock or the file is wrong`);
  if (!Array.isArray(top.services) || top.services.length === 0) throw new PreconditionError(`${FILE}: services is not a list, or it is empty, and a guard that checks no service does not pass`);
  const seen = new Map<string, Seen>();
  top.services.forEach((item: unknown, index) => {
    const where = `${FILE}: services[${index}]`;
    const entry = exactly(item, ['service', 'kind', 'container', 'started_at', 'env']);
    if (entry === null) throw new PreconditionError(`${where} does not have exactly the members service, kind, container, started_at and env`);
    for (const member of ['service', 'kind', 'container']) {
      const value = entry[member];
      if (typeof value !== 'string' || !NAME.test(value)) throw new PreconditionError(`${where}: ${member} is not a name`);
    }
    if (timeOf(entry.started_at) === null) throw new PreconditionError(`${where}: started_at is not an ISO 8601 time with a zone`);
    const env = exactly(entry.env, [FAULT_MODE_VARIABLE]);
    if (env === null) throw new PreconditionError(`${where}: env is not an object that holds exactly the variable ${FAULT_MODE_VARIABLE}`);
    const value = env[FAULT_MODE_VARIABLE];
    if (typeof value !== 'string') throw new PreconditionError(`${where}: ${FAULT_MODE_VARIABLE} is not a text`);
    const container = String(entry.container);
    if (seen.has(container)) throw new PreconditionError(`${FILE} names a container twice`);
    seen.set(container, { kind: String(entry.kind), startedAt: String(entry.started_at), value });
  });
  return seen;
}

/** Match each agent with its container. Ignore containers outside the use case. */
function servicesOf(use: UseCase, seen: ReadonlyMap<string, Seen>): Array<{ agent: AgentSpec; seen: Seen }> {
  const found: Array<{ agent: AgentSpec; seen: Seen }> = [];
  const problems: string[] = [];
  const containers = new Set<string>();
  for (const agent of use.agents) {
    const container = agent.serviceContainer;
    if (containers.has(container)) {
      problems.push(`two agents of the data name container ${container}: each agent must have its own container`);
      continue;
    }
    containers.add(container);
    const running = seen.get(container);
    if (running === undefined) problems.push(`${FILE} shows no container ${container}: a check needs a reading of each service of the use case`);
    else if (running.kind !== agent.kind) problems.push(`${FILE}: container ${container} has a different kind (expected ${agent.kind})`);
    else found.push({ agent, seen: running });
  }
  if (problems.length > 0) throw new PreconditionError(problems.join('\n'));
  return found;
}

// ---- the flags ----

function agentOf(use: UseCase, id: string): AgentSpec {
  const agent = use.agents.find((one) => one.id === id);
  if (agent === undefined) throw new FlagError(`--agent is one of: ${use.agents.map((one) => one.id).join(', ')}`);
  return agent;
}

/** The fault values of an agent for a message: the values that its kind lists, or a phrase when it lists none. */
const valuesOf = (agent: AgentSpec): string => (agent.faultValues.length === 0 ? `the agent ${agent.id} has no fault value` : `the agent ${agent.id} takes ${agent.faultValues.join(' or ')}`);

// ---- --set ----

async function setSwitch(session: TaskSession<Extra>, value: string): Promise<Ended> {
  const id = session.flags.value('agent');
  if (id === undefined && value !== '') throw new FlagError('--set with a fault value needs --agent: the value is the fault of one agent. Only the empty value (--set=) goes into the files of every agent');
  const agents = id === undefined ? session.use.agents : [agentOf(session.use, id)];
  for (const agent of agents) {
    if (!isFaultSetting(agent.kind, value)) throw new FlagError(`--set is not a setting of the kind ${agent.kind}: ${valuesOf(agent)}, and the empty value (--set=) is no fault`);
  }
  const dry = session.mode === 'dry';
  const lines: string[] = [];
  const changes: Array<{ label: string; path: string; env: EnvFile }> = [];
  for (const agent of agents) {
    const label = `${agent.folder}/${agent.serviceEnvFile}`;
    const folder = join(session.settings.agentsDir, agent.folder);
    let found: Stats | undefined;
    try { found = lstatSync(folder, { throwIfNoEntry: false }); } catch (err) { throw new PreconditionError(`${agent.folder}: the folder of the agent could not be looked at (${codeOf(err)})`); }
    if (found === undefined || !found.isDirectory()) throw new PreconditionError(`${agent.folder}: the folder of the agent is missing or is not a real folder (a link or a file is no folder): the task writes only into a real folder`);
    const path = join(folder, agent.serviceEnvFile);
    let env: EnvFile;
    try { env = EnvFile.open(path); } catch (err) { throw new PreconditionError(`${label}: the service env file cannot be used (${reasonOf(err)})`); }
    const now = env.get(FAULT_MODE_VARIABLE);
    if (now === undefined) throw new PreconditionError(`${label}: the file has no line ${FAULT_MODE_VARIABLE}: it is not made from the current example`);
    if (now === value) {
      lines.push(`${FAULT_MODE_VARIABLE} in ${label} already holds ${named(value)}: no change (container ${agent.serviceContainer})`);
      continue;
    }
    lines.push(`${dry ? 'would set' : 'set'} ${FAULT_MODE_VARIABLE} in ${label} to ${named(value)} (it holds ${named(now)} now; container ${agent.serviceContainer})`);
    env.set(FAULT_MODE_VARIABLE, value);
    changes.push({ label, path, env });
  }
  if (!dry) {
    for (const change of changes) {
      try { change.env.write(change.path); } catch (err) { throw new PreconditionError(`${change.label}: ${err instanceof EnvFileError ? err.message : `the file could not be written (${codeOf(err)}), and the old file is as it was`}`); }
    }
  }
  for (const line of lines) session.out.out(line);
  for (const agent of agents) {
    session.out.out(`the service of ${agent.id} reads ${FAULT_MODE_VARIABLE} when its container is created: create the service again by the restart rule, after each of its ${agent.statusUrls.length} runtime${agent.statusUrls.length === 1 ? '' : 's'} says free (container ${agent.serviceContainer})`);
  }
  session.extra.result = { set: agents.map((agent) => ({ agent: agent.id, value })) };
  return dry ? { kind: 'dry' } : { kind: 'done', message: `${FAULT_MODE_VARIABLE} is ${named(value)} in ${changes.length} file${changes.length === 1 ? '' : 's'}` };
}

// ---- --check ----

/** The agent that a check names: none for `clean`, and else the agent of --agent with a value that its kind lists. A flag problem is exit 2. */
function checkedAgent(use: UseCase, check: string, id: string | undefined): AgentSpec | null {
  if (check === '') throw new FlagError('--check is clean, or the fault value that the run needs: the empty value is no check, so use --check clean');
  if (check === 'clean') {
    if (id !== undefined) throw new FlagError('--check clean checks every service: do not give --agent');
    return null;
  }
  if (id === undefined) throw new FlagError('--check with a fault value needs --agent: the value is the fault of one agent');
  const agent = agentOf(use, id);
  if (!isFaultSetting(agent.kind, check)) throw new FlagError(`--check is clean, or a setting of the kind ${agent.kind}: ${valuesOf(agent)}`);
  return agent;
}

async function checkRun(session: TaskSession<Extra>, check: string): Promise<Ended> {
  if (session.flags.value('run') === undefined) throw new FlagError('--run <label> is required with --check: a check belongs to a run');
  const agent = checkedAgent(session.use, check, session.flags.value('agent'));
  const services = servicesOf(session.use, readSeen(join(session.settings.stateDir, FILE), session.clock.now()));
  const guarded = services.map((one) => ({ service: one.agent.serviceContainer, kind: one.agent.kind, env: { [FAULT_MODE_VARIABLE]: one.seen.value } }));
  const result = agent === null ? checkCleanRun(guarded) : checkFaultRun(guarded, { service: agent.serviceContainer, value: check });
  const shows = {
    check, agent: agent === null ? null : agent.id, ok: result.ok,
    services: services.map((one) => ({ service: one.agent.serviceContainer, started_at: one.seen.startedAt, value: shown(one.seen.value) })),
  };
  for (const one of shows.services) session.out.out(`service ${one.service}: ${FAULT_MODE_VARIABLE} is ${named(one.value)}, started at ${one.started_at}`);
  if (session.mode === 'submit') session.evidence.add({ step: 'fault_check', status: 'info', shows });
  session.extra.result = result.ok ? shows : { ...shows, code: result.code };
  const written = session.mode === 'submit' ? 'the entry fault_check is written into the evidence file' : 'a dry run writes no evidence entry: give --submit to write it';
  if (!result.ok) throw new Error(`the fault guard refuses (${result.code}): ${result.detail}. ${written}`);
  return { kind: 'done', message: `the fault guard passes for the check ${check}: ${written}` };
}

const task: TaskDefinition<Extra> = {
  name: 'fault',
  title: 'Set the fault switch of an agent, and check that a run is clean or has its fault',
  flags: [],
  valued: ['agent', 'set', 'check'],
  needs: { keys: () => [], chain: false, hosted: [], approval: 'submit' },
  steps: () => ['run'],
  parse: () => ({ result: null }),
  async next(session) {
    const set = session.flags.value('set');
    const check = session.flags.value('check');
    if (set !== undefined && check !== undefined) throw new FlagError('give --set or --check, not both: a run sets the switch or checks it');
    if (set !== undefined) return setSwitch(session, set);
    if (check !== undefined) return checkRun(session, check);
    throw new FlagError('give --set <value> (--set= for the empty value) or --check clean or --check <value>');
  },
  async cleanup() {
    return { kind: 'done', message: 'there is nothing to take back: set the switch empty with --set=, and check the services with --check clean' };
  },
  async status(session) {
    const lines: string[] = [];
    let seen: ReadonlyMap<string, Seen> | null = null;
    try { seen = readSeen(join(session.settings.stateDir, FILE), session.clock.now()); } catch (err) {
      lines.push(`fault: no fresh reading of the services: ${err instanceof Error ? err.message : 'an error'}`);
    }
    for (const agent of session.use.agents) {
      const label = `${agent.folder}/${agent.serviceEnvFile}`;
      let inFile = 'the file cannot be read';
      try {
        const value = EnvFile.open(join(session.settings.agentsDir, agent.folder, agent.serviceEnvFile)).get(FAULT_MODE_VARIABLE);
        inFile = value === undefined ? `the file has no line ${FAULT_MODE_VARIABLE}` : `${FAULT_MODE_VARIABLE} in the file is ${named(value)}`;
      } catch (err) { inFile = `the file cannot be used (${reasonOf(err)})`; }
      const container = agent.serviceContainer;
      const running = seen?.get(container);
      let live: string;
      if (seen === null) live = `, no reading of container ${container}`;
      else if (running === undefined) live = `, the reading shows no container ${container}`;
      else if (running.kind !== agent.kind) live = `, container ${container} has a different kind (expected ${agent.kind})`;
      else live = `, in the running service ${container} it is ${named(running.value)} (started at ${running.startedAt})`;
      lines.push(`fault: ${agent.id}: ${label}: ${inFile}${live}`);
    }
    return lines;
  },
  result: (session) => session.extra.result ?? {},
};

export default task;
