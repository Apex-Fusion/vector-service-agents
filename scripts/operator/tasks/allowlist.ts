// scripts/operator/tasks/allowlist.ts - the task `allowlist`: adds the key hash of a principal to COSIGN_ALLOWLIST in the env file of the Reorder Agent.
// The co-sign route of the Reorder Agent signs only for a principal whose key hash is on this list. The service reads the list once, at its start, so a change needs a new service container (the
// restart rule of the runbook; the wrapper does it). The kit gives the rules of the list (`parseAllowlist`, `addToAllowlist`) and reads and writes no file; this task reads and writes the one line.
// The task never drops an entry: it checks, before it writes, that the new line holds each key of the old line and the new key, and that `parseAllowlist` reads it. It writes the whole file through
// the editor of the env files (mode 600, a temporary file and a rename), so a failed write leaves the old file as it was. It prints key hashes (public values) and no other line of the file.
// The list is the truth: a key that is on the list is done, and no state file says that a key was added, because a later edit of the file could remove it.
import { join } from 'node:path';
import { PreconditionError } from '../../checks/lib/session.ts';
import type { AgentSpec, TaskDefinition, TaskFlags, TaskSession, UseCase } from '../lib/contract.ts';
import { EnvFile, EnvFileError } from '../lib/envfile.ts';
import { addToAllowlist, parseAllowlist } from '../lib/platform.ts';
import { FlagError } from '../lib/runner.ts';

const VARIABLE = 'COSIGN_ALLOWLIST';
const KEY_HASH = /^[0-9a-f]{56}$/;

interface AllowlistExtra {
  readonly agent: AgentSpec;
  /** The key hash to add, or null when the run gave none (the command `status` takes none). */
  readonly key: string | null;
}

/** What `next` did, for the machine line: public values only. */
const RESULTS = new WeakMap<object, Readonly<Record<string, unknown>>>();

/** The agent of the run: the one that `--agent` names, or the one agent with a co-sign route. An agent without a co-sign route has no list. */
function agentOf(use: UseCase, flags: TaskFlags): AgentSpec {
  const named = flags.value('agent');
  if (named === undefined) {
    const found = use.agents.find((agent) => agent.cosign);
    if (found === undefined) throw new FlagError('no agent of the use case has a co-sign route, so there is no allowlist');
    return found;
  }
  const agent = use.agents.find((entry) => entry.id === named);
  if (agent === undefined) throw new FlagError(`--agent must name an agent of the use case: ${use.agents.map((entry) => entry.id).join(', ')}`);
  if (!agent.cosign) throw new FlagError(`the agent ${agent.id} has no co-sign route, so it has no allowlist`);
  return agent;
}

/** The env file of the service of an agent, opened. A file that is missing or damaged, and a file without the line, stop the run before anything is written. */
function openFile(session: Pick<TaskSession, 'settings'>, agent: AgentSpec): { readonly file: EnvFile; readonly path: string; readonly text: string } {
  const path = join(session.settings.agentsDir, agent.folder, agent.serviceEnvFile);
  let file: EnvFile;
  try { file = EnvFile.open(path); } catch (err) {
    if (err instanceof EnvFileError) throw new PreconditionError(`the env file ${agent.serviceEnvFile} of the agent ${agent.id} cannot be used: ${err.message}`);
    throw err;
  }
  const text = file.get(VARIABLE);
  if (text === undefined) throw new PreconditionError(`the env file ${agent.serviceEnvFile} of the agent ${agent.id} has no line ${VARIABLE}: make the env file first`);
  return { file, path, text };
}

/** The keys of a list text, in order, or null when `parseAllowlist` refuses the text. */
function keysOf(text: string): string[] | null {
  const parsed = parseAllowlist(text);
  return parsed.ok ? parsed.value.keys() : null;
}

/** The count and the keys of the list as the file holds it now. A list that `parseAllowlist` refuses stops the run: the task never writes over a line that it cannot read. */
function currentKeys(agent: AgentSpec, text: string): string[] {
  const keys = keysOf(text);
  if (keys === null) throw new PreconditionError(`the line ${VARIABLE} of the env file ${agent.serviceEnvFile} is not a list of key hashes that the service reads: repair it by hand, and run the task again`);
  return keys;
}

async function add(session: TaskSession<AllowlistExtra>): Promise<{ kind: 'dry' } | { kind: 'done'; message: string }> {
  const { agent, key } = session.extra;
  if (key === null) throw new FlagError('give --key <56 lower-case hex characters>: the key hash of the principal to add');
  const { file, text } = openFile(session, agent);
  const before = currentKeys(agent, text);
  if (before.includes(key)) {
    RESULTS.set(session, { agent: agent.id, key, added: false, keys: before.length });
    return { kind: 'done', message: `the key ${key} is on the allowlist of the agent ${agent.id} already: nothing is written (${before.length} key(s))` };
  }
  const added = addToAllowlist(text, key);
  if (!added.ok) throw new PreconditionError(`the key cannot be added to the line ${VARIABLE} of the env file ${agent.serviceEnvFile}: ${added.detail}`);
  const after = keysOf(added.value.text);
  const line = after === null ? '' : after.join(',');
  const written = keysOf(line);
  // The new line holds every old key, the new key, and nothing else, and `parseAllowlist` reads it back. A line that fails this is never written.
  if (after === null || written === null || !added.value.added || written.length !== before.length + 1 || !written.includes(key) || !before.every((held) => written.includes(held))) {
    throw new PreconditionError(`the new line ${VARIABLE} would not hold every old key and the new key, so nothing is written`);
  }
  if (session.mode === 'dry') {
    session.out.out(`dry run: the line ${VARIABLE} of the agent ${agent.id} would be ${VARIABLE}=${line}`);
    session.out.out(`it would hold ${written.length} key(s): the ${before.length} that it holds and ${key}. Nothing is written.`);
    return { kind: 'dry' };
  }
  file.set(VARIABLE, line);
  file.write();
  RESULTS.set(session, { agent: agent.id, key, added: true, keys: written.length });
  return {
    kind: 'done',
    message: `the key ${key} is on the allowlist of the agent ${agent.id}: the line ${VARIABLE} holds ${written.length} key(s). The service reads the list when it starts, so create its container again by the restart rule (the wrapper does that).`,
  };
}

const task: TaskDefinition<AllowlistExtra> = {
  name: 'allowlist',
  title: 'Add the key hash of a principal to the co-sign allowlist of the Reorder Agent',
  flags: [],
  valued: ['key', 'agent'],
  // The task signs and sends nothing, and it needs no key. A submit run loads the run key by itself, for the check of the approval.
  needs: { keys: () => [], chain: false, hosted: [], approval: 'submit' },
  steps: () => ['add'],
  parse(_env, _settings, use, flags) {
    const key = flags.value('key');
    if (key !== undefined && !KEY_HASH.test(key)) throw new FlagError('--key must be a key hash: 56 lower-case hex characters');
    return { agent: agentOf(use, flags), key: key ?? null };
  },
  next: add,
  async cleanup() {
    return { kind: 'done', message: 'there is nothing to take back: a key leaves the allowlist by an edit of the env file, and the service reads the list when it starts' };
  },
  // `status` takes no flag but --run and --use-case, so it cannot ask about one key: a dry run of `run --key <hash>` says whether that key is on the list.
  async status(session) {
    const { agent } = session.extra;
    const keys = currentKeys(agent, openFile(session, agent).text);
    return [`the allowlist of the agent ${agent.id}: ${keys.length} key(s)`, ...keys.map((held) => `  ${held}`)];
  },
  result: (session) => RESULTS.get(session) ?? {},
};

export default task;
