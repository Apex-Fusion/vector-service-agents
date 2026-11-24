// scripts/operator/tasks/env.ts - make or reconcile the env files of the agents from their examples.
// Each agent has a service env file and can share it with its runtime. The data names the files, the key lines and the optional mock and Module-1 lines. A foreign key supplies only its hash.
// The task also fills the runtime token, the DIDs, the advert references, the operator contact and the identity address. It keeps all other lines.
// A file that does not exist is made from its example. A file that exists is never overwritten: a managed line that is empty is set, a line that holds the value that the task would set is kept, and a line
// that holds another value stops the run. The one exception is the reference of an advert, which `--replace-advert` may replace. The whole plan is made in memory and checked before any file is written.
// This is the one task that reads a seed, and each seed goes into the one line of the one file that the data names. No text of this file holds a value: a message names a file, a line and a rule, and the
// output shows the length of each value that it sets.
import { randomBytes } from 'node:crypto';
import { lstatSync } from 'node:fs';
import type { Stats } from 'node:fs';
import { join } from 'node:path';
import { parseKeyText } from '../../checks/lib/keys.ts';
import type { LoadedKey } from '../../checks/lib/keys.ts';
import type { Output } from '../../checks/lib/ports.ts';
import { PreconditionError } from '../../checks/lib/session.ts';
import type { AgentSpec, Facts, KeyLine, KeyUse, OperatorSettings, TaskDefinition, UseCase } from '../lib/contract.ts';
import { EnvFile, EnvFileError } from '../lib/envfile.ts';
import { MOCK_MTLS_BASE, MOCK_PUBLIC_BASE } from '../lib/mock-hosts.ts';
import { codeOf } from '../lib/registry.ts';
import type { Registry } from '../lib/registry.ts';

const PLACEHOLDER = /<[^>]*>/;
const HEX_64 = /^[0-9a-f]{64}$/;
const HEX_56 = /^[0-9a-f]{56}$/;
const DID = /^did:vector:([0-9a-f]{64})$/;
const ADVERT_REF = /^[0-9a-f]{64}#[0-9]+$/;
const ADDRESS = /^addr1[0-9a-z]+$/;
const FILE_MODE = 0o600;
const COMMIT_MARK = '<commit>';
const MANIFEST_LINE = 'VECTOR_MODULE1_MANIFEST';
const ADVERT_LINE = 'ADVERT_REF';
const FILE_NAME = /^(?!\.{1,2}$)[A-Za-z0-9_.-]+$/;

/** Where the value of a managed line comes from. */
type Source =
  | { readonly from: 'key'; readonly key: string; readonly of: KeyLine['of'] }
  | { readonly from: 'token' | 'contact' | 'mock-public' | 'mock-mtls' | 'identity-address' | 'manifest' | 'agent-id' }
  | { readonly from: 'did'; readonly id: string }
  | { readonly from: 'advert'; readonly model: string };

/** A line that the task manages: its name in the file, and where its value comes from. */
interface Line { readonly name: string; readonly source: Source }

/** What a run did or would do, for the machine line. */
interface Outcome { readonly files: readonly string[]; readonly made: readonly string[]; readonly linesSet: number }

interface Extra {
  readonly replaceAdvert: boolean;
  outcome: Outcome | null;
}

/** What the plan reads from the session. */
interface Context {
  readonly use: UseCase;
  readonly registry: Registry;
  readonly facts: Readonly<Facts>;
  readonly settings: OperatorSettings;
  readonly identityAddress: string;
  readonly replaceAdvert: boolean;
}

/** One env file of an agent, as the run leaves it. `env` is the content after the run, in memory. */
interface FilePlan {
  readonly agent: AgentSpec;
  readonly file: string;
  readonly label: string;
  readonly path: string;
  readonly existed: boolean;
  readonly env: EnvFile;
  /** The lines that this run sets, in the order of the plan. */
  readonly set: readonly string[];
  /** The value that each managed line holds after the run (a name and its value). It is kept for the check of the file after the write, and it is never printed. */
  readonly wanted: ReadonlyMap<string, string>;
}

// ---- the layout of the files of an agent ----

/** The names of the env files of an agent: the service file first, then each runtime file that is not the service file. */
function agentFiles(agent: AgentSpec): { readonly all: readonly string[]; readonly runtimes: readonly string[] } {
  const runtimes = [...new Set(agent.adverts.map((advert) => advert.runtimeEnvFile))];
  return { all: [agent.serviceEnvFile, ...runtimes.filter((file) => file !== agent.serviceEnvFile)], runtimes };
}

/** Env lines from the agent's keys, its subagents' keys and the public hashes of other keys. */
const keyUses = (use: UseCase, agent: AgentSpec): readonly Pick<KeyUse, 'key' | 'lines'>[] => [
  ...agent.keys, ...use.subagents.filter((sub) => sub.parent === agent.id).flatMap((sub) => sub.keys), ...agent.publicKeyLines,
];

/** The lines that the task manages in one file of an agent. */
function layoutOf(use: UseCase, agent: AgentSpec, file: string): Line[] {
  const lines: Line[] = [];
  for (const entry of keyUses(use, agent)) {
    for (const line of entry.lines) if (line.file === file) lines.push({ name: line.name, source: { from: 'key', key: entry.key, of: line.of } });
  }
  if (file === agent.serviceEnvFile) {
    lines.push(
      { name: 'SERVICE_AUTH_HEADER', source: { from: 'token' } }, { name: 'OPERATOR_CONTACT', source: { from: 'contact' } }, { name: 'AGENT_DID', source: { from: 'did', id: agent.id } },
    );
    for (const sub of use.subagents) if (sub.parent === agent.id) lines.push({ name: `${sub.id.toUpperCase().replace(/-/g, '_')}_DID`, source: { from: 'did', id: sub.id } });
    if (agent.envManaged.mock) lines.push({ name: 'MOCK_PUBLIC_BASE', source: { from: 'mock-public' } }, { name: 'MOCK_MTLS_BASE', source: { from: 'mock-mtls' } });
    lines.push({ name: 'IDENTITY_ADDRESS', source: { from: 'identity-address' } });
    if (agent.envManaged.module1) lines.push({ name: MANIFEST_LINE, source: { from: 'manifest' } });
  }
  const advert = agent.adverts.find((one) => one.runtimeEnvFile === file);
  if (advert !== undefined) lines.push({ name: 'AGENT_ID', source: { from: 'agent-id' } }, { name: ADVERT_LINE, source: { from: 'advert', model: advert.model } });
  return lines;
}

/** Reject a key line that the agent must not write or that names a file outside its layout. */
function placementProblems(use: UseCase, agent: AgentSpec): string[] {
  const problems: string[] = [];
  const { all, runtimes } = agentFiles(agent);
  const suppliers = new Set(agent.adverts.map((advert) => advert.supplierKey));
  for (const file of [agent.folder, ...all, ...(agent.exampleEnvFile === null ? [] : [agent.exampleEnvFile])]) {
    if (!FILE_NAME.test(file)) problems.push(`the data of ${agent.id} must use a single name for each folder, env file and example`);
  }
  for (const file of runtimes) {
    if (agent.adverts.filter((advert) => advert.runtimeEnvFile === file).length !== 1) problems.push(`${agent.folder}/${file}: the data names more than one advert for this runtime file`);
  }
  for (const entry of keyUses(use, agent)) {
    const foreign = agent.publicKeyLines.includes(entry);
    for (const line of entry.lines) {
      const where = `${agent.folder}/${line.file}: the data puts the line ${line.name} of the key ${entry.key} here`;
      if (!all.includes(line.file)) problems.push(`${where}, and the agent has no such file`);
      if (foreign) {
        if (line.of !== 'pkh') problems.push(`${where}: a foreign key supplies only a key hash`);
        continue;
      }
      if (line.of !== 'secret') continue;
      if (suppliers.has(entry.key)) {
        if (!runtimes.includes(line.file)) problems.push(`${where}: the supplier key goes into the file of a runtime, and never into a file that only a service reads`);
      } else if (line.file !== agent.serviceEnvFile) {
        problems.push(`${where}: a key of the service goes into the service file, and never into a file that only a runtime reads`);
      }
    }
  }
  return problems;
}

// ---- the checks of the files (the checks of the runbooks, in code) ----

/**
 * Checks the env files of one agent as they stand (or as they will stand). It returns one problem for each rule that a file breaks, and a problem names a file, a line and a rule and never a value.
 * The rules: no line holds a placeholder; each key line has the form of its kind (a secret and a public key 64 lower-case hex characters, a key hash 56); the key hash, the public key and the address
 * of each key are those of the secret in the file; no two keys are one key; a secret stands only in the line that the data names for it, and in no other line of any file of the agent; the DID of the
 * agent is `did:vector:` and the id of each runtime; the reference of an advert is empty or a transaction hash, `#` and an index.
 */
export function checkEnvFiles(use: UseCase, agent: AgentSpec, files: ReadonlyMap<string, EnvFile>, registry: Registry): string[] {
  const problems: string[] = [];
  const label = (file: string): string => `${agent.folder}/${file}`;
  const held = (file: string, name: string): string | undefined => files.get(file)?.get(name);
  for (const [file, env] of files) {
    for (const name of env.names()) if (PLACEHOLDER.test(env.get(name) ?? '')) problems.push(`${label(file)}: the line ${name} holds a placeholder (<...>)`);
  }
  const secrets = new Map<string, string>();
  const hashes = new Map<string, string>();
  const keys = keyUses(use, agent);
  for (const entry of keys) {
    const foreign = agent.publicKeyLines.includes(entry);
    const values = new Map<KeyLine, string>();
    for (const line of entry.lines) {
      const value = held(line.file, line.name);
      const where = `${label(line.file)}: the line ${line.name} of the key ${entry.key}`;
      if (foreign && line.of !== 'pkh') { problems.push(`${where}: a foreign key supplies only a key hash`); continue; }
      if (value === undefined || value === '') { problems.push(`${where} is empty`); continue; }
      const shape = line.of === 'pkh' ? HEX_56 : line.of === 'address' ? ADDRESS : HEX_64;
      if (!shape.test(value)) { problems.push(`${where} does not have its form (${line.of === 'pkh' ? '56' : line.of === 'address' ? 'a wallet address' : '64'}${line.of === 'address' ? '' : ' lower-case hex characters'})`); continue; }
      if (foreign && (!registry.has(entry.key) || value !== registry.hashOf(entry.key))) problems.push(`${label(line.file)}: the line ${line.name} is not the key hash of ${entry.key}`);
      values.set(line, value);
    }
    const secretLine = entry.lines.find((line) => line.of === 'secret');
    const secret = secretLine === undefined ? undefined : values.get(secretLine);
    if (secret !== undefined) {
      const other = secrets.get(secret);
      if (other !== undefined && other !== entry.key) problems.push(`the keys ${other} and ${entry.key} hold one key: no two keys may be one key`);
      secrets.set(secret, entry.key);
      let derived: LoadedKey | null = null;
      try { derived = parseKeyText(secret, entry.key); } catch { problems.push(`${label(secretLine!.file)}: the secret line of the key ${entry.key} is not a usable key`); }
      for (const [line, value] of values) {
        if (derived === null || line.of === 'secret') continue;
        const right = line.of === 'pkh' ? derived.keyHash : line.of === 'pub' ? derived.publicKeyHex : derived.address;
        if (value !== right) problems.push(`${label(line.file)}: the line ${line.name} is not the ${line.of === 'pkh' ? 'key hash' : line.of === 'pub' ? 'public key' : 'address'} of the key ${entry.key} that the secret in the file gives`);
      }
    }
    for (const [line, value] of values) {
      if (line.of !== 'pkh') continue;
      const other = hashes.get(value);
      if (other !== undefined && other !== entry.key) problems.push(`the keys ${other} and ${entry.key} have one key hash: no two keys may be one key`);
      hashes.set(value, entry.key);
    }
  }
  for (const name of registry.names()) {
    const seed = registry.secretHexForEnv(name);
    const own = new Set(keys.filter((entry) => entry.key === name && !agent.publicKeyLines.includes(entry)).flatMap((entry) => entry.lines.filter((line) => line.of === 'secret').map((line) => `${line.file}\n${line.name}`)));
    for (const [file, env] of files) {
      for (const line of env.names()) {
        if ((env.get(line) ?? '').toLowerCase().includes(seed) && !own.has(`${file}\n${line}`)) {
          problems.push(`${label(file)}: the secret of the key ${name} stands in the line ${line}, and the data names no such line for it: a secret stands in one line only`);
        }
      }
    }
  }
  const serviceDid = held(agent.serviceEnvFile, 'AGENT_DID');
  for (const { name, source } of layoutOf(use, agent, agent.serviceEnvFile)) {
    if (source.from === 'did' && !DID.test(held(agent.serviceEnvFile, name) ?? '')) problems.push(`${label(agent.serviceEnvFile)}: the line ${name} is not did:vector: and 64 lower-case hex characters`);
  }
  for (const file of agentFiles(agent).runtimes) {
    const id = held(file, 'AGENT_ID');
    if (id !== undefined && id !== '' && !HEX_64.test(id)) problems.push(`${label(file)}: the line AGENT_ID is not 64 lower-case hex characters`);
    if (id !== undefined && id !== '' && serviceDid !== undefined && DID.exec(serviceDid)?.[1] !== id) problems.push(`${label(file)}: the line AGENT_ID is not the id in AGENT_DID of ${label(agent.serviceEnvFile)}`);
    const advert = held(file, ADVERT_LINE);
    if (advert !== undefined && advert !== '' && !ADVERT_REF.test(advert)) problems.push(`${label(file)}: the line ${ADVERT_LINE} is not a transaction hash, #, and an output index`);
  }
  return problems;
}

// ---- the plan ----

/** The reason of an error for a message: the message of an env file error (it holds no value and no path), and else the short code of a system error. */
const reasonOf = (err: unknown): string => (err instanceof EnvFileError ? err.message : codeOf(err));

/**
 * The value of a managed line, or null when it cannot be made (the reason is in `problems`). The key lines come from the registry, the DIDs and the references from the facts, the contact and the
 * commit from the settings, and the manifest from the line of the example. A token is made new here: the caller keeps the token that the file already holds.
 */
function valueOf(ctx: Context, agent: AgentSpec, line: Line, example: EnvFile, problems: string[], where: string): string | null {
  const source = line.source;
  switch (source.from) {
    case 'key':
      if (!ctx.registry.has(source.key)) { problems.push(`${where}: the registry holds no key named ${source.key}`); return null; }
      return source.of === 'secret' ? ctx.registry.secretHexForEnv(source.key) : source.of === 'pkh' ? ctx.registry.hashOf(source.key) : source.of === 'pub' ? ctx.registry.publicKeyOf(source.key) : ctx.registry.addressOf(source.key);
    case 'token':
      // A random token for the line between the runtimes and the service: `Bearer ` and 64 lower-case hex characters. The caller keeps the token that a file holds already.
      return `Bearer ${randomBytes(32).toString('hex')}`;
    case 'contact':
      if (ctx.settings.contact === null) { problems.push('OPERATOR_CONTACT is not set: the contact of the operator is a setting, and the task has no default for it'); return null; }
      return ctx.settings.contact;
    case 'mock-public':
      return MOCK_PUBLIC_BASE;
    case 'mock-mtls':
      return MOCK_MTLS_BASE;
    case 'identity-address':
      return ctx.identityAddress;
    case 'manifest': {
      if (ctx.settings.module1Commit === null) { problems.push('OPERATOR_MODULE1_COMMIT is not set: the manifest of Module-1 is pinned to a commit, and the task has no default for it'); return null; }
      const template = example.get(line.name);
      if (template === undefined || !template.includes(COMMIT_MARK)) { problems.push(`${where}: the example has no ${COMMIT_MARK} in the line ${line.name} to replace`); return null; }
      return template.split(COMMIT_MARK).join(ctx.settings.module1Commit);
    }
    case 'did': {
      const record = Object.hasOwn(ctx.facts.records, source.id) ? ctx.facts.records[source.id] : undefined;
      if (record === undefined) { problems.push(`the facts hold no record for ${source.id} (records.${source.id}): run the task register first`); return null; }
      return record.did;
    }
    case 'agent-id': {
      const record = Object.hasOwn(ctx.facts.records, agent.id) ? ctx.facts.records[agent.id] : undefined;
      if (record === undefined) { problems.push(`the facts hold no record for ${agent.id} (records.${agent.id}): run the task register first`); return null; }
      return record.id;
    }
    case 'advert': {
      const adverts = Object.hasOwn(ctx.facts.adverts, agent.id) ? ctx.facts.adverts[agent.id] : undefined;
      return adverts !== undefined && Object.hasOwn(adverts, source.model) ? adverts[source.model]!.ref : '';
    }
  }
}

/** Looks at a path without following a link: undefined when nothing is there. A failure of the file system is a refusal with its short code. */
function lookAt(path: string, problem: (text: string) => void): Stats | undefined | 'failed' {
  try { return lstatSync(path, { throwIfNoEntry: false }); } catch (err) {
    problem(`the file could not be looked at (${codeOf(err)})`);
    return 'failed';
  }
}

/**
 * Plans one file: it reads the example, and the file when it exists, and it sets what the plan sets. It returns null when the file cannot be planned (the reasons are in `problems`). Nothing is written.
 */
function planFile(ctx: Context, agent: AgentSpec, file: string, folder: string, problems: string[]): FilePlan | null {
  const label = `${agent.folder}/${file}`;
  const problem = (text: string): void => { problems.push(`${label}: ${text}`); };
  const exampleName = file === agent.serviceEnvFile ? agent.exampleEnvFile ?? `${file}.example` : `${agent.serviceEnvFile}-runtime.example`;
  const examplePath = join(folder, exampleName);
  const exampleProblem = (text: string): void => { problems.push(`${agent.folder}/${exampleName}: ${text}`); };
  const exampleStat = lookAt(examplePath, exampleProblem);
  if (exampleStat === 'failed') return null;
  if (exampleStat === undefined) { exampleProblem('the example does not exist: the runbook puts it in the folder of the agent'); return null; }
  if (!exampleStat.isFile()) { exampleProblem('the example is not a regular file'); return null; }
  let example: EnvFile;
  try { example = EnvFile.open(examplePath); } catch (err) {
    exampleProblem(`the example cannot be used (${reasonOf(err)})`);
    return null;
  }
  const path = join(folder, file);
  const found = lookAt(path, problem);
  if (found === 'failed') return null;
  const existed = found !== undefined;
  let env: EnvFile;
  try {
    if (found === undefined) {
      env = example;
    } else {
      if (!found.isFile()) { problem('the path is not a regular file'); return null; }
      const mode = found.mode & 0o777;
      if (mode !== FILE_MODE) { problem(`the file has mode ${mode.toString(8)}: set mode 600 on it before the task changes it`); return null; }
      env = EnvFile.open(path);
    }
  } catch (err) {
    problem(`the file cannot be used (${reasonOf(err)})`);
    return null;
  }
  const set: string[] = [];
  const wanted = new Map<string, string>();
  let failed = false;
  for (const line of layoutOf(ctx.use, agent, file)) {
    const value = valueOf(ctx, agent, line, example, problems, label);
    const advert = line.source.from === 'advert';
    const now = env.get(line.name);
    const missingFromExample = existed ? !example.has(line.name) : now === undefined;
    if (missingFromExample || now === undefined) {
      problem(`${missingFromExample ? 'the example' : 'the file'} has no line ${line.name}`);
      failed = true;
      continue;
    }
    if (value === null || (advert && value === '')) { failed = failed || value === null; continue; }
    let write = false;
    if (!existed) {
      if (now !== '' && !PLACEHOLDER.test(now)) { problem(`the example holds a value in the line ${line.name}, which the task sets: the example and the task differ`); failed = true; continue; }
      write = true;
    } else if (line.source.from === 'token') {
      if (now !== '') { wanted.set(line.name, now); continue; }
      write = true;
    } else if (now === '') {
      write = true;
    } else if (now === value) {
      wanted.set(line.name, now);
      continue;
    } else if (advert && ctx.replaceAdvert) {
      write = true;
    } else {
      problem(PLACEHOLDER.test(now)
        ? `the line ${line.name} holds a placeholder (<...>): write its value or empty the line, and run the task again. The task never overwrites a value`
        : `the line ${line.name} holds another value, and the task never overwrites a value${advert ? ' (--replace-advert replaces the reference of an advert)' : ''}`);
      failed = true;
      continue;
    }
    if (write) {
      try { env.set(line.name, value); } catch (err) {
        problem(`the line ${line.name} cannot be written (${reasonOf(err)})`);
        failed = true;
        continue;
      }
      set.push(line.name);
      wanted.set(line.name, value);
    }
  }
  return failed ? null : { agent, file, label, path, existed, env, set, wanted };
}

/** Plans every file of every agent. The problems of all agents are collected, so that one run reports each precondition that fails. */
function planAll(ctx: Context): { plans: FilePlan[]; problems: string[] } {
  const plans: FilePlan[] = [];
  const problems: string[] = [];
  for (const agent of ctx.use.agents) {
    const before = problems.length;
    problems.push(...placementProblems(ctx.use, agent));
    if (problems.length > before) continue;
    const folder = join(ctx.settings.agentsDir, agent.folder);
    const found = lookAt(folder, (text) => problems.push(`${agent.folder}: the folder of the agent ${text.replace(/^the file/, 'the folder')}`));
    if (found === 'failed') continue;
    if (found === undefined || !found.isDirectory()) { problems.push(`${agent.folder}: the folder of the agent is missing or is not a real folder (a link or a file is no folder): the runbook makes the folder before the env files`); continue; }
    const mine: FilePlan[] = [];
    for (const file of agentFiles(agent).all) {
      const plan = planFile(ctx, agent, file, folder, problems);
      if (plan !== null) mine.push(plan);
    }
    if (problems.length === before && mine.length === agentFiles(agent).all.length) {
      problems.push(...checkEnvFiles(ctx.use, agent, new Map(mine.map((plan) => [plan.file, plan.env])), ctx.registry));
    }
    plans.push(...mine);
  }
  return { plans, problems };
}

/** The lines that a plan prints: the file, what happens to it, and the name and the length of each value that it sets. The value is never printed. */
function describePlan(plan: FilePlan, dry: boolean): string[] {
  const lengths = new Map(plan.env.describe().map((variable) => [variable.name, variable.length]));
  const what = plan.existed ? (plan.set.length === 0 ? 'no change' : 'reconciled') : dry ? 'would be made from the example' : 'made from the example';
  return [`${plan.label}: ${what}`, ...plan.set.map((name) => `  ${dry ? 'would set' : 'set'} ${name} (${lengths.get(name) ?? 0} characters)`)];
}

/** Reads each file again after the write: the mode is 600, each line holds what the plan says, and the rules of the checks hold. */
function verifyWritten(ctx: Context, plans: readonly FilePlan[]): string[] {
  const problems: string[] = [];
  const reopened = new Map<AgentSpec, Map<string, EnvFile>>();
  for (const plan of plans) {
    const problem = (text: string): void => { problems.push(`${plan.label}: ${text}`); };
    const found = lookAt(plan.path, problem);
    if (found === 'failed') continue;
    if (found === undefined || !found.isFile()) { problem('the file is not there after the write'); continue; }
    if ((found.mode & 0o777) !== FILE_MODE) { problem(`the file has mode ${(found.mode & 0o777).toString(8)} after the write, and it must have mode 600`); continue; }
    let env: EnvFile;
    try { env = EnvFile.open(plan.path); } catch (err) { problem(`the file cannot be read again (${reasonOf(err)})`); continue; }
    for (const [name, value] of plan.wanted) if (env.get(name) !== value) problem(`the line ${name} does not hold what the task wrote`);
    const files = reopened.get(plan.agent) ?? new Map<string, EnvFile>();
    files.set(plan.file, env);
    reopened.set(plan.agent, files);
  }
  for (const [agent, files] of reopened) problems.push(...checkEnvFiles(ctx.use, agent, files, ctx.registry));
  return problems;
}

/** Prints the problems and stops with exit 2. `wrote` is true when a file of this run is written already: it stays written, and the message says so. */
function stop(out: Output, problems: readonly string[], dry: boolean, wrote: boolean): never {
  for (const problem of problems) out.err(problem);
  const state = dry ? ' (this dry run wrote nothing)' : wrote ? ': the files that were written stay written. Run the task env again when the cause is fixed' : ': no env file was written';
  throw new PreconditionError(`${problems.length} problem${problems.length === 1 ? '' : 's'} stop the task env${state}`);
}

const task: TaskDefinition<Extra> = {
  name: 'env',
  title: 'Make the env files of the agents, or reconcile the files that exist',
  flags: ['replace-advert'],
  valued: [],
  needs: {
    keys: (use) => [...new Set(use.agents.flatMap((agent) => keyUses(use, agent)).filter((entry) => entry.lines.length > 0).map((entry) => entry.key))],
    chain: true,
    hosted: [],
    approval: 'submit',
  },
  steps: (use) => use.agents.map((agent) => agent.id),
  parse: (_env, _settings, _use, flags) => ({ replaceAdvert: flags.has('replace-advert'), outcome: null }),
  async next(session) {
    const ctx: Context = {
      use: session.use, registry: session.registry, facts: session.facts.read(), settings: session.settings, identityAddress: session.chain.deployment.identity.address, replaceAdvert: session.extra.replaceAdvert,
    };
    const dry = session.mode === 'dry';
    const { plans, problems } = planAll(ctx);
    if (problems.length > 0) {
      if (dry) for (const plan of plans) for (const line of describePlan(plan, true)) session.out.out(line);
      stop(session.out, problems, dry, false);
    }
    // The machine line tells what the run did, so it holds the files only when the run is whole: a dry run that has no problem, and a run that wrote and checked its files.
    const outcome: Outcome = {
      files: plans.map((plan) => plan.label), made: plans.filter((plan) => !plan.existed).map((plan) => plan.label), linesSet: plans.reduce((total, plan) => total + plan.set.length, 0),
    };
    if (dry) {
      for (const plan of plans) for (const line of describePlan(plan, true)) session.out.out(line);
      session.extra.outcome = outcome;
      return { kind: 'dry' };
    }
    let wrote = false;
    for (const plan of plans) {
      if (plan.set.length === 0) continue;
      try { plan.env.write(plan.path); } catch (err) { stop(session.out, [`${plan.label}: ${err instanceof EnvFileError ? err.message : `the file could not be written (${codeOf(err)}), and the old file is as it was`}`], false, wrote); }
      wrote = true;
    }
    const unchecked = verifyWritten(ctx, plans);
    if (unchecked.length > 0) stop(session.out, unchecked, false, wrote);
    for (const plan of plans) for (const line of describePlan(plan, false)) session.out.out(line);
    session.extra.outcome = outcome;
    return { kind: 'done', message: `env files: ${outcome.made.length} made, ${outcome.linesSet} line${outcome.linesSet === 1 ? '' : 's'} set. A container reads its env files when it is created: create it again by the restart rule.` };
  },
  async cleanup() {
    return { kind: 'done', message: 'there is nothing to take back: the env files stay as they are' };
  },
  async status(session) {
    const lines: string[] = [];
    for (const agent of session.use.agents) {
      const placement = placementProblems(session.use, agent);
      if (placement.length > 0) { lines.push(...placement); continue; }
      for (const file of agentFiles(agent).all) {
        const label = `${agent.folder}/${file}`;
        const path = join(session.settings.agentsDir, agent.folder, file);
        let text = 'does not exist';
        const found = lookAt(path, (reason) => { text = reason; });
        if (found !== undefined && found !== 'failed') {
          try {
            const env = EnvFile.open(path);
            const names = layoutOf(session.use, agent, file).map((line) => line.name);
            const empty = names.filter((name) => { const value = env.get(name); return value === undefined || value === '' || PLACEHOLDER.test(value); });
            text = `mode ${(found.mode & 0o777).toString(8)}, ${names.length - empty.length} of ${names.length} managed lines set${empty.length === 0 ? '' : `; empty: ${empty.join(', ')}`}`;
          } catch (err) { text = `cannot be read (${reasonOf(err)})`; }
        }
        lines.push(`env file ${label}: ${text}`);
      }
    }
    return lines;
  },
  result: (session) => (session.extra.outcome === null ? {} : { files: session.extra.outcome.files, made: session.extra.outcome.made, linesSet: session.extra.outcome.linesSet }),
};

export default task;
