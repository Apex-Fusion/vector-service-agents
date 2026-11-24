import { makeEndStateWorld } from './support/end-state-world.ts';
import type { EndStateWorld } from './support/end-state-world.ts';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { createRequire, stripTypeScriptTypes } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { EvidenceFile } from '../../checks/lib/evidence.ts';
import { iso, units } from '../../checks/lib/format.ts';
import { StateFile } from '../../checks/lib/state.ts';
import type { AgentSpec, TaskDefinition, UseCase } from '../lib/contract.ts';
import { EVIDENCE_MODULES, evidenceModuleOf } from '../lib/evidence/index.ts';
import { loadTask, loadUseCase, PACK_URL } from '../lib/load.ts';
import { parseArguments, usageLines } from '../lib/runner.ts';
import { trialOf } from '../lib/trials/index.ts';
import { TASK_NAMES } from '../tasks/names.ts';
import type { TaskName } from '../tasks/names.ts';
import { USE_CASE_NAMES } from '../usecases/names.ts';
import { CASES, COLLATERAL, matrixWorld, MODULE_COMMIT, NEW_RUN, RUN, snapshotRoots, TENANT, TENANT_READS } from './support/matrix-world.ts';
import type { MatrixWorld, Observation } from './support/matrix-world.ts';
import { hashOf } from './support/task-world.ts';

const LOCATOR = `https://raw.githubusercontent.com/Apex-Fusion/vector-service-agents/${MODULE_COMMIT}/docs/attestations/`;
const ALLOW_KEY = hashOf('matrix allowlist key').slice(0, 56);
const LABEL = '--run';
const first = (use: UseCase): AgentSpec => use.agents[0]!;
const owner = (use: UseCase, agent: AgentSpec): string => use.organisations.find(({ id }) => id === agent.organisation)!.accountableKey;
const holdAgent = (use: UseCase) => use.agents.find(({ cosign }) => !cosign)!;
const revokeAgent = (use: UseCase) => use.agents.find(({ end }) => end.record === 'revoked') ?? first(use);
const endAgent = (use: UseCase) => use.agents.find(({ end }) => end.subagents === 'ended');
const subjectsOf = (use: UseCase) => [...use.agents.flatMap((agent) => [agent, ...use.subagents.filter(({ parent }) => parent === agent.id)]), ...use.records];
const delegators = (use: UseCase) => [...use.agents, ...use.subagents].flatMap(({ id, keys }) => keys.filter(({ purposes }) => purposes.includes('delegation')).map(({ key }) => ({ id, key })));
const probeFlags = (target: readonly string[]) => [LABEL, RUN, ...target, '--resource', 'https://mock.example.test/matrix/item', '--action', 'item.read', '--expect', 'granted'];
const didOf = (id: string): string => `did:vector:${hashOf(`record ${id}`)}`;
const unique = (list: readonly string[]): string[] => [...new Set(list)];
const withCase = (use: UseCase, ...argv: string[]): string[] => [...argv, '--use-case', use.name];
const runtimeUrl = (origin: string) => `${origin.replace(/\/+$/, '')}/status`;
const allRuntimes = (use: UseCase) => use.agents.flatMap(({ adverts }) => adverts);
const envFiles = (use: UseCase) => use.agents.flatMap((agent) => unique([agent.serviceEnvFile, ...agent.adverts.map((advert) => advert.runtimeEnvFile)]).map((file) => `${agent.folder}/${file}`));
const resultLabels = (use: UseCase) => use.runs.map(({ id }) => `matrix-${id}`);

function seedResults(w: MatrixWorld): void {
  const index = CASES.findIndex(({ name }) => name === w.use.name);
  if (index === -1) throw new Error('no evidence fixture for the selected use case');
  const prefix = index === 0 ? 'evidence' : `evidence-uc${index + 1}`;
  const folder = join(w.stateDir, 'evidence');
  mkdirSync(folder, { mode: 0o700 });
  for (const { id } of w.use.runs) copyFileSync(new URL(`./golden/${prefix}-${id}.json`, import.meta.url), join(folder, `matrix-${id}.json`));
}

interface Row {
  readonly status: readonly string[];
  args(w: MatrixWorld): readonly string[];
  steps(use: UseCase): readonly string[];
  keys(use: UseCase): readonly string[];
}
const no = () => [];
const simple = (steps: readonly string[] = []): Row => ({ status: [], args: no, steps: () => steps, keys: no });
const LABELLED = [LABEL, RUN];
const LIFECYCLE_STEPS = ['change-controller', 'recovery-start', 'recovery-wait', 'recovery-complete', 'retire', 'set-successor', 'reclaim'];
// This is an independent table of the public contract, not a prediction from each task's implementation.
const ROWS: Record<TaskName, Row> = {
  keys: simple(),
  fund: { ...simple(['collateral', 'float']), keys: (use) => unique(['run', ...use.funding.map(({ wallet }) => wallet), ...use.keys.map(({ name }) => name)]) },
  register: {
    ...simple(),
    steps: (use) => [...subjectsOf(use).map(({ id }) => id), ...subjectsOf(use).flatMap((subject) => ('organisation' in subject && subject.organisation !== null ? [`organisation:${subject.id}`] : []))],
    keys: (use) => unique(['controller', 'fee', ...subjectsOf(use).flatMap((subject) => [...subject.keys.map(({ key }) => key), ...('parties' in subject ? subject.parties.flatMap(({ signer }) => signer.kind === 'key' ? [signer.key] : []) : [])])]),
  },
  stake: { ...simple(), steps: (use) => use.agents.flatMap(({ id }) => [`${id}:open`, `${id}:create`]), keys: (use) => ['controller', ...use.agents.map(({ serviceKey }) => serviceKey)] },
  advert: { ...simple(), steps: (use) => use.agents.flatMap(({ id, adverts }) => adverts.map(({ model }) => `${id}:${model}`)), keys: (use) => allRuntimes(use).map(({ supplierKey }) => supplierKey) },
  attest: {
    ...simple(), args: () => ['--commit', MODULE_COMMIT, '--locator-base', LOCATOR],
    steps: (use) => {
      const issue = use.attestations.flatMap(({ agent, types }) => types.map((type) => `${agent}:${type}`));
      return [...issue, ...issue.map((step) => `visible:${step}`)];
    },
    keys: () => ['provider', 'controller', 'fee'],
  },
  compliance: {
    ...simple(), args: () => ['--locator-base', LOCATOR],
    steps: (use) => use.compliance?.subjects.map((id) => `attest:${id}`) ?? [], keys: (use) => use.compliance === null ? [] : [use.compliance.issuerKey, 'fee'],
  },
  claim: {
    status: LABELLED, args: () => [LABEL, NEW_RUN, '--kind', 'clean'],
    steps: (use) => use.agents.map(({ id }) => id), keys: (use) => use.agents.map(({ serviceKey }) => serviceKey),
  },
  allowlist: { ...simple(['add']), args: () => ['--key', ALLOW_KEY] },
  env: {
    ...simple(), steps: (use) => use.agents.map(({ id }) => id),
    keys: (use) => unique(use.agents.flatMap((agent) => [...agent.keys, ...use.subagents.filter(({ parent }) => parent === agent.id).flatMap(({ keys }) => keys), ...agent.publicKeyLines].filter(({ lines }) => lines.length !== 0).map(({ key }) => key))),
  },
  tenant: { ...simple(['create']), status: LABELLED, args: () => [LABEL, NEW_RUN, '--kind', 'clean'] },
  fault: { ...simple(['run']), status: LABELLED, args: () => [...LABELLED, '--check', 'clean'] },
  probe: {
    ...simple(['run']), status: LABELLED, args: ({ use }) => probeFlags(['--subagent', use.subagents[0]!.id]),
    keys: (use) => ['authentication', 'delegation'].map((purpose) => use.subagents[0]!.keys.find(({ purposes }) => purposes.some((one) => one === purpose))!.key),
  },
  hold: {
    ...simple(['suspend', 'lift']), status: LABELLED,
    args: ({ use }) => [...LABELLED, '--agent', holdAgent(use).id, '--by', owner(use, holdAgent(use))],
    keys: (use) => ['fee', owner(use, holdAgent(use))],
  },
  'end-subagents': {
    ...simple(['end-subagents']), args: ({ use }) => endAgent(use) === undefined ? [] : ['--agent', endAgent(use)!.id], keys: () => ['controller', 'fee'],
  },
  'revoke-record': {
    ...simple(['revoke']), args: ({ use }) => ['--agent', revokeAgent(use).id, '--by', owner(use, revokeAgent(use)), '--reason', '9'],
    keys: (use) => [owner(use, revokeAgent(use)), 'fee'],
  },
  lifecycle: {
    ...simple(LIFECYCLE_STEPS), status: [LABEL, 'l1'], args: () => [LABEL, 'l1'],
    keys: (use) => unique(['controller', 'fee', ...(use.lifecycle?.controllers ?? []), ...(use.lifecycle?.guardians ?? [])]),
  },
  delegations: { ...simple(['run']), keys: (use) => unique(delegators(use).map(({ key }) => key)) },
  evidence: { ...simple(['run']), status: LABELLED, args: () => [...LABELLED, '--number', '1'] },
  results: { ...simple(['run']), args: ({ use, headerFile }) => ['--header-file', headerFile, '--runs', resultLabels(use).join(',')] },
  'end-state': simple(),
};

type Outcome = 'dry' | 'done' | 'finished';
interface Reached { readonly outcome: Outcome; readonly show?: readonly string[]; readonly gates?: readonly string[] }
interface Stop { readonly exit: 2 | 3; readonly text: string; readonly gates?: readonly string[]; readonly usage?: boolean; readonly step?: string }
const missingNodeRecord = (id: string): string => `The record of ${didOf(id)} is not on the node.`;
const noEnds = 'Specify --agent. The use case does not identify one agent whose subagents must end.';
const noLifecycle = 'This use case has no lifecycle run.';
const noRun = 'the run record cannot be read (ENOENT)';
const hostedRegister = 'hosted vector_build_identity_register';
const manifestUrl = (use: UseCase) => `https://raw.githubusercontent.com/Apex-Fusion/vector-agent-modules/${MODULE_COMMIT}/${use.moduleManifestPath}`;
const manifestGate = (use: UseCase) => `fetch GET ${manifestUrl(use)}`;
const manifestStop = (use: UseCase) => `the Module-1 manifest cannot be used: The Module-1 manifest ${manifestUrl(use)} cannot be fetched: world gate: ${manifestGate(use)}`;
const missingRoot = (id: string): Stop => ({ exit: 2, text: `the record ${didOf(id)} of ${id} is not on the node: wait until its registration is confirmed there` });

// A stop needs an exact boundary, error and progress step. No catch-all exit is accepted.
const STOPS: Partial<Record<TaskName, (use: UseCase) => Stop | undefined>> = {
  register: (use) => ({ exit: 3, text: `world gate: ${hostedRegister}`, gates: [hostedRegister], step: first(use).id }),
  stake: (use) => ({ ...missingRoot(first(use).id), step: `${first(use).id}:open` }),
  advert: (use) => ({ ...missingRoot(first(use).id), step: `${first(use).id}:${first(use).adverts[0]!.model}` }),
  attest: (use) => ({ exit: 2, text: `the task needs every runtime of the use case to say free, and ${allRuntimes(use).map(({ runtimeContainer }) => `cannot tell whether the runtime ${runtimeContainer} works: the request failed`).join('; ')}`,
    gates: allRuntimes(use).map(({ origin }) => `fetch GET ${runtimeUrl(origin)}`), step: `${use.attestations[0]!.agent}:${use.attestations[0]!.types[0]!}` }),
  compliance: (use) => use.compliance === null ? undefined : { exit: 2, text: `the node does not show the root record of ${use.compliance.subjects[0]}`, step: `attest:${use.compliance.subjects[0]}` },
  claim: (use) => ({ exit: 2, text: manifestStop(use), gates: [manifestGate(use)], step: first(use).id }),
  probe: (use) => ({ exit: 2, text: `no current record of ${use.subagents[0]!.id} is on the chain, so no request was sent`, step: 'run' }),
  hold: (use) => ({ exit: 2, text: `the record of the agent ${holdAgent(use).id} is not in the identity registry: wait until its registration is confirmed`, step: 'suspend' }),
  'end-subagents': (use) => endAgent(use) === undefined ? { exit: 2, text: noEnds, usage: true } : { exit: 2, text: missingNodeRecord(endAgent(use)!.id), step: 'end-subagents' },
  'revoke-record': (use) => revokeAgent(use).end.record !== 'revoked' ? { exit: 2, text: 'The use case does not mark the selected record for revocation.', usage: true }
    : { exit: 2, text: missingNodeRecord(revokeAgent(use).id), step: 'revoke' },
  lifecycle: (use) => use.lifecycle === null ? { exit: 2, text: noLifecycle } : { exit: 2, text: missingNodeRecord(use.lifecycle.agent), step: LIFECYCLE_STEPS[0] },
  evidence: () => ({ exit: 2, text: noRun, step: 'run' }),
};
const STATUS_STOPS: Partial<Record<TaskName, (use: UseCase) => Stop | undefined>> = {
  'end-subagents': (use) => endAgent(use) === undefined ? { exit: 2, text: noEnds, usage: true } : undefined,
  lifecycle: (use) => use.lifecycle === null ? { exit: 2, text: noLifecycle } : undefined,
  evidence: () => ({ exit: 2, text: noRun }),
};

const REACHED: Partial<Record<TaskName, (w: MatrixWorld, seen: Observation) => Reached>> = {
  keys: ({ use }, { machine }) => {
    expect(machine.result).toEqual({ would_make: [], would_keep: use.keys.map(({ name }) => name) });
    return { outcome: 'dry' };
  },
  fund: (w, seen) => {
    assertFunding(w, seen);
    return { outcome: 'dry', show: [`the step collateral sends ${units(BigInt(w.use.funding.length - 1) * COLLATERAL)} to ${w.use.funding.length - 1} wallets in one transaction`] };
  },
  compliance: () => ({ outcome: 'finished', show: ['this use case has no compliance attestations'] }),
  allowlist: ({ use }) => ({ outcome: 'dry', show: [`dry run: the line COSIGN_ALLOWLIST of the agent ${use.agents.find(({ cosign }) => cosign)!.id} would be COSIGN_ALLOWLIST=${ALLOW_KEY}`] }),
  env: ({ use }, { machine }) => {
    expect(machine.result).toMatchObject({ files: envFiles(use), made: envFiles(use) });
    return { outcome: 'dry' };
  },
  tenant: ({ use, clock }, { out, machine }) => {
    const day = iso(clock.now()).slice(0, 10).replaceAll('-', '');
    const name = `${use.runs.find(({ id }) => id === 'clean')!.tenantPrefix}-${day}`;
    expect(machine.result).toEqual({ tenant: name });
    expect(out).toContain(`  body ${JSON.stringify({ tenant: name, organisations: use.tenantOrganisations, operation: 'create', owner: { use_case: use.name, run: NEW_RUN } })}`);
    for (const { vendor_id, organisation } of use.tenantSeed?.vendors ?? []) expect(out).toContain(`  vendor ${vendor_id}: ${use.organisations.find(({ id }) => id === organisation)!.domain}`);
    return { outcome: 'dry' };
  },
  fault: ({ use, clock }, { machine }) => {
    expect(machine.result).toEqual({ check: 'clean', agent: null, ok: true, services: use.agents.map(({ serviceContainer }) => ({ service: serviceContainer, started_at: iso(clock.now()), value: '' })) });
    return { outcome: 'done' };
  },
  delegations: ({ use }, { machine }) => {
    expect(machine.result).toMatchObject({ live: 0, shown: 0, keys: delegators(use).map(({ id, key }) => ({ key, agent: id, state: 'free', delegations: [] })) });
    return { outcome: 'done', show: ['delegation keys:'] };
  },
  results: ({ use }, { out, machine }) => {
    const rows = out.flatMap((line) => /^\| ([a-z0-9-]+) \|/.exec(line)?.[1] ?? []).filter((id) => id !== 'id');
    expect(rows).toEqual(use.runs.flatMap((run) => use.evidenceSteps.filter((step) => step.run === run.id || step.run === 'both').map(({ id }) => id)));
    const firstLine = out.indexOf('Operator test results');
    const lastLine = out.findIndex((line) => line.startsWith('dry run: the page above is not written'));
    expect(firstLine).toBeGreaterThanOrEqual(0);
    expect(lastLine).toBeGreaterThan(firstLine);
    const page = `${out.slice(firstLine, lastLine).join('\n')}\n`;
    expect(machine.result).toEqual({ labels: resultLabels(use), file: `results/${use.name}.md`, written: false, bytes: Buffer.byteLength(page), sha256: createHash('sha256').update(page).digest('hex') });
    return { outcome: 'done', show: [`# ${use.title}: results`, '## Not covered', use.notCovered.lead] };
  },
};

function assertFunding({ use, world, keys }: MatrixWorld, { out }: Observation): void {
  const heading = out.findIndex((line) => line.startsWith('wallet') && line.includes('collateral to send'));
  expect(heading).toBeGreaterThanOrEqual(0);
  const rows = out.slice(heading + 1, heading + 1 + use.funding.length).map((line) => line.trim().split(/\s+/));
  expect(rows.map((cells) => cells[0])).toEqual(use.funding.map(({ wallet }) => wallet));
  for (const [index, line] of use.funding.entries()) {
    const held = world.chain.held.filter(({ address }) => address === keys.registry.addressOf(line.wallet)).reduce((sum, { assets }) => sum + assets.lovelace!, 0n);
    const collateral = line.wallet === 'fee' ? 0n : COLLATERAL;
    expect(line.collateralLovelace).toBe(COLLATERAL);
    expect(rows[index]!.slice(1)).toEqual([held, collateral, line.floatLovelace + COLLATERAL - held - collateral, line.floatLovelace + COLLATERAL].map((value) => units(value).replace(' units', '')));
  }
  expect(rows.filter((row) => row[2] === '5.000000')).toHaveLength(use.funding.length - 1);
  expect(rows.find((row) => row[0] === 'fee')?.[3]).not.toBe('0.000000');
}

function assertBoundary(w: MatrixWorld, task: TaskName, command: 'run' | 'status', labels: readonly string[], seen: Observation, extraWrites: readonly string[] = []): void {
  const run = labels.includes(LABEL) ? labels[labels.indexOf(LABEL) + 1] : undefined;
  const base = `state/${task}${run === undefined ? '' : `.${run}`}`;
  const state = `${base}.state.json`;
  const evidence = `${base}.evidence.json`;
  const allowed = [state, evidence, ...(command === 'status' ? [] : ['state/facts.json', ...extraWrites])];
  expect(seen.changed.filter((file) => !allowed.includes(file)), 'unexpected filesystem delta').toEqual([]);
  // Other status paths open the normal journals. Only their empty headers can be created.
  if (command === 'status') {
    if (task === 'hold' || task === 'probe') expect(seen.changed).toEqual([]);
    if (seen.changed.includes(state)) {
      const { steps, in_flight, notes } = w.state(task, run);
      expect({ steps, in_flight, notes }).toEqual({ steps: {}, in_flight: null, notes: {} });
    }
    if (seen.changed.includes(evidence)) expect(w.evidence(task, run)).toEqual([]);
  }
  expect(existsSync(w.lockPath)).toBe(false);
  expect(seen.forbidden, 'forbidden calls').toEqual([]);
  expect(seen.leaked, 'a fixture credential escaped').toBe(false);
  expect(seen.machine).toMatchObject({ task, command, mode: 'dry', exit: seen.exit });
  const keys = w.use.keys.map(({ name }) => name);
  for (const loaded of seen.loaded) for (const key of loaded) expect(keys).toContain(key);
  const outputs = [...seen.out, ...seen.errors, ...seen.changed.flatMap((file) => /\.(?:json|txt)$/.test(file) ? [readFileSync(join(w.dir, file), 'utf8')] : [])];
  const names = wordsFound(outputs.join('\n'), w.use.name);
  expect(names, 'names from a different use case').toEqual([]);
}

function assertStop(seen: Observation, def: TaskDefinition, stop: Stop): void {
  expect(seen.errors).toEqual(stop.usage ? [stop.text, ...usageLines(def)] : [stop.text]);
  expect(seen.exit).toBe(stop.exit);
  expect(seen.machine).toMatchObject({ outcome: 'stopped', step: stop.step ?? null });
  expect(seen.gates.map(({ port, target }) => `${port} ${target}`)).toEqual(stop.gates ?? []);
}

function assertReached(seen: Observation, reached: Reached): void {
  expect(seen.errors).toEqual([]);
  expect(seen.exit).toBe(0);
  expect(seen.machine.outcome).toBe(reached.outcome);
  expect(seen.gates.map(({ port, target }) => `${port} ${target}`)).toEqual(reached.gates ?? []);
  for (const line of reached.show ?? []) expect(seen.out).toContain(line);
}

function assertStatus(w: MatrixWorld, def: TaskDefinition, task: TaskName, seen: Observation): void {
  const stop = STATUS_STOPS[task]?.(w.use);
  if (stop !== undefined) { assertStop(seen, def, stop); return; }
  const { use, clock } = w;
  const lines: string[] = [];
  let gates: string[] = [];
  switch (task) {
    case 'keys': lines.push(`all ${use.keys.length} key files exist`, 'the public key file equals the key files'); break;
    case 'fund': assertFunding(w, seen); break;
    case 'env': lines.push(...envFiles(use).map((name) => `env file ${name}: does not exist`)); break;
    case 'claim':
      gates = [manifestGate(use)];
      for (const agent of use.agents) expect(seen.out.some((line) => line.includes(w.facts().claims[RUN]![agent.id]!.claimRef)), agent.id).toBe(true);
      lines.push(`the open claims on the chain are not read: ${manifestStop(use)}`);
      break;
    case 'tenant':
      expect(seen.tenantReads).toEqual(TENANT_READS);
      lines.push(`tenant ${TENANT} of the run ${RUN}: made at ${iso(clock.now())} from the ${use.tenantSeed === null ? 'default' : 'custom'} seed`,
        use.name === CASES[0]!.name ? '  orders in the PO store: 1, orders at the supplier portal: 0' : '  state sections: po_store, supplier', '  lines in the log: 1, dropped: 0');
      break;
    case 'attest': lines.push(`deploy: the commit ${MODULE_COMMIT}, ${Object.keys(w.facts().deploy!.images).length} running containers`); break;
    case 'compliance': lines.push(...(use.compliance?.subjects.map((id) => `${id}: no compliance issue in the facts`) ?? ['this use case has no compliance attestations'])); break;
    case 'fault':
      for (const agent of use.agents) expect(seen.out.some((line) => line.startsWith(`fault: ${agent.id}:`) && line.includes(`in the running service ${agent.serviceContainer} it is empty`))).toBe(true);
      break;
    case 'allowlist': lines.push(`the allowlist of the agent ${use.agents.find(({ cosign }) => cosign)!.id}: 0 key(s)`); break;
    case 'hold':
      expect(seen.loaded).toEqual([]);
      lines.push(`no hold of this pack is recorded in the facts for the run ${RUN}; the ledger was not checked for other holds`);
      break;
    case 'probe':
      expect(seen.loaded).toEqual([]);
      lines.push('requests that the evidence holds: 0');
      break;
    case 'delegations': lines.push('delegation keys:'); break;
    case 'lifecycle': lines.push(...LIFECYCLE_STEPS.map((step) => `${step}: no verified fact`)); break;
    case 'results':
      lines.push(`evidence files: ${resultLabels(use).map((label) => `${label} (public)`).join(', ')}`, `page: results/${use.name}.md does not exist yet`);
      break;
    default: break;
  }
  assertReached(seen, { outcome: 'done', show: lines, gates });
  expect(seen.out.some((line) => line.includes(`use case ${w.use.name}`))).toBe(true);
  expect(seen.machine.step).toBeNull();
}

describe.each(CASES.map((use) => [use.name, use] as const))('%s operator matrix', (_name, use) => {
  const worlds = new Map<string, Promise<MatrixWorld>>();
  const worldOf = (kind: 'base' | 'register' | 'attest' | 'live-env' | 'results') => {
    const held = worlds.get(kind);
    if (held !== undefined) return held;
    const next = matrixWorld(use, { omit: kind === 'register' || kind === 'attest' ? kind : undefined, liveEnv: kind === 'live-env' }).then((w) => {
      if (kind === 'results') seedResults(w);
      return w;
    });
    worlds.set(kind, next);
    return next;
  };
  let complete: Promise<EndStateWorld> | undefined;

  it.each(TASK_NAMES.flatMap((task) => (['run', 'status'] as const).map((command) => [task, command] as const)))('%s %s uses its own data', async (task, command) => {
    const def = await loadTask(task);
    const row = ROWS[task];
    if (task === 'end-state') {
      complete ??= makeEndStateWorld(use);
      await checkEndState(def, use, command, await complete);
      return;
    }
    const w = await worldOf(task === 'allowlist' || task === 'fault' ? 'live-env' : task === 'results' ? 'results'
      : command === 'run' && (task === 'register' || task === 'attest') ? task : 'base');
    if (command === 'status') {
      const nodeReads = w.node.networkReads;
      const seen = await w.observe(def, withCase(use, 'status', ...row.status));
      assertStatus(w, def, task, seen);
      assertBoundary(w, task, 'status', row.status, seen);
      if (task !== 'tenant') expect(seen.tenantReads).toEqual([]);
      if (task === 'hold' || task === 'probe') expect(w.node.networkReads).toBe(nodeReads);
      return;
    }
    const flags = row.args(w);
    const argv = withCase(use, 'run', ...flags);
    const parsed = parseArguments(def, argv);
    expect(def.steps(use, parsed.flags)).toEqual(row.steps(use));
    const needs = def.needs.keys(use, parsed.flags);
    expect([...needs].sort()).toEqual([...row.keys(use)].sort());
    const keys = new Set(use.keys.map(({ name }) => name));
    for (const key of needs) expect(keys.has(key), key).toBe(true);
    const seen = await w.observe(def, argv);
    const stop = STOPS[task]?.(use);
    if (stop !== undefined) assertStop(seen, def, stop);
    else {
      const reached = REACHED[task];
      if (reached === undefined) throw new Error(`no exact outcome for ${task}`);
      assertReached(seen, reached(w, seen));
    }
    if (stop?.step !== undefined || stop === undefined) {
      expect(seen.loaded.map((names) => [...names].sort())).toEqual([[...needs].sort()]);
    }
    assertBoundary(w, task, 'run', flags, seen);
    expect(seen.tenantReads).toEqual([]);
  });

  it('selects the exact hold authority and never signs a probe without the named root', async () => {
    const hold = await loadTask('hold');
    const w = await matrixWorld(use);
    for (const agent of use.agents) {
      const by = owner(use, agent);
      const flags = [...LABELLED, '--agent', agent.id, '--by', by];
      const argv = withCase(use, 'run', ...flags);
      expect(hold.needs.keys(use, parseArguments(hold, argv).flags)).toEqual(['fee', by]);
      const seen = await w.observe(hold, argv);
      assertStop(seen, hold, { exit: 2, text: `the record of the agent ${agent.id} is not in the identity registry: wait until its registration is confirmed`, step: 'suspend' });
      assertBoundary(w, 'hold', 'run', flags, seen);
    }
    const agent = first(use);
    const delegate = agent.keys.find(({ purposes }) => purposes.includes('delegation'))!.key;
    const probe = await loadTask('probe');
    const withoutRoot = await matrixWorld(use, { omit: 'register' });
    const flags = probeFlags(['--agent', agent.id, '--key', delegate, '--delegation', hashOf(`delegation for ${agent.id}`)]);
    const argv = withCase(use, 'run', ...flags);
    expect(probe.needs.keys(use, parseArguments(probe, argv).flags)).toEqual([agent.serviceKey, delegate]);
    const seen = await withoutRoot.observe(probe, argv);
    assertStop(seen, probe, { exit: 2, text: `the facts hold no record of the agent ${agent.id}: register it first, so that the probe knows its DID`, step: 'run' });
    assertBoundary(withoutRoot, 'probe', 'run', flags, seen);
  });

  it('previews each fault in its own service file and refuses an allowlist without a co-sign route', async () => {
    const w = await matrixWorld(use, { liveEnv: true });
    const fault = await loadTask('fault');
    for (const agent of use.agents) for (const value of agent.faultValues) {
      const flags = ['--agent', agent.id, '--set', value];
      const seen = await w.observe(fault, withCase(use, 'run', ...flags));
      assertReached(seen, { outcome: 'dry', show: [`would set FAULT_MODE in ${agent.folder}/${agent.serviceEnvFile} to ${value} (it holds empty now; container ${agent.serviceContainer})`] });
      expect(seen.machine.result).toEqual({ set: [{ agent: agent.id, value }] });
      assertBoundary(w, 'fault', 'run', flags, seen);
    }
    const allowlist = await loadTask('allowlist');
    const agent = use.agents.find(({ cosign }) => !cosign)!;
    const flags = ['--agent', agent.id, '--key', ALLOW_KEY];
    const seen = await w.observe(allowlist, withCase(use, 'run', ...flags));
    assertStop(seen, allowlist, { exit: 2, usage: true, text: `the agent ${agent.id} has no co-sign route, so it has no allowlist` });
    assertBoundary(w, 'allowlist', 'run', flags, seen);
  });

  it('reads a saved probe observation without loading keys or contacting the ledger', async () => {
    const w = await worldOf('base');
    const at = iso(w.clock.now());
    const label = 'recorded-matrix';
    const journal = EvidenceFile.open(join(w.stateDir, `probe.${label}.evidence.json`),
      { check: 'probe', network: 'vector-mainnet', record: `${use.name}:${label}` }, { clock: () => at });
    journal.add({ step: 'run', status: 'info', shows: {
      probe: { subagent: use.subagents[0]!.id, expect: 'granted' },
      observation: { kind: 'granted', tokenType: 'DPoP', expiresAt: at, status: 200 },
      verdict: { expected: 'granted', observed: 'granted', ok: true },
    } });
    const reads = w.node.networkReads;
    const flags = [LABEL, label];
    const seen = await w.observe(await loadTask('probe'), withCase(use, 'status', ...flags));
    assertReached(seen, { outcome: 'done', show: ['requests that the evidence holds: 1', `request 1 at ${at}: expected granted, observed granted (status 200): as expected`] });
    expect(seen.loaded).toEqual([]);
    expect(w.node.networkReads).toBe(reads);
    assertBoundary(w, 'probe', 'status', flags, seen);
  });

  it('keeps the sparse ledger an explicit failed end-state observation', async () => {
    const w = await matrixWorld(use);
    const seen = await w.observe(await loadTask('end-state'), withCase(use, 'status'));
    expect(seen.exit).toBe(1);
    expect(seen.machine.outcome).toBe('failed');
    expect(seen.errors).toHaveLength(1);
    expect(seen.errors[0]).toMatch(/^the end state is not reached: [0-9]+ check\(s\) fail \(/);
    expect(seen.out.some((line) => line.startsWith(`FAIL ${recordCheck(first(use))}:`))).toBe(true);
    assertBoundary(w, 'end-state', 'status', [], seen);
  });

  it('writes only public trial documents and keeps each writer rule with its case', async () => {
    const w = await matrixWorld(use);
    const def = await loadTask('claim');
    const flags = ['--trial'];
    const argv = withCase(use, 'run', ...flags);
    const parsed = parseArguments(def, argv);
    expect(def.steps(use, parsed.flags)).toEqual([]);
    expect(def.needs.keys(use, parsed.flags)).toEqual([]);
    const seen = await w.observe(def, argv);
    assertReached(seen, { outcome: 'done' });
    expect(seen.loaded).toEqual([]);
    expect(seen.machine.result.trial).toBe(true);
    const hashes = Object.entries(seen.machine.result.sha256 as Record<string, string>);
    expect(hashes.length).toBeGreaterThan(0);
    const files = hashes.map(([name]) => `state/trial/${name}`);
    expect(seen.changed).toEqual(['state/trial', 'state/trial/trial.json', ...files].sort());
    for (const [file, digest] of hashes) {
      expect(file).toMatch(/^[a-z0-9][a-z0-9.-]+\.(?:json|txt)$/);
      expect(createHash('sha256').update(readFileSync(join(w.stateDir, 'trial', file))).digest('hex')).toBe(digest);
    }
    assertBoundary(w, 'claim', 'run', flags, seen, ['state/trial', 'state/trial/trial.json', ...files]);
    const module = evidenceModuleOf(use.name);
    expect([...module.runKinds].sort()).toEqual(use.runs.map(({ id }) => id).sort());
    expect(Object.keys(module.rules).sort()).toEqual(use.evidenceSteps.map(({ id }) => id).sort());
    for (const { id } of use.runs) expect(use.evidenceSteps.some(({ run }) => run === id || (id !== 'lifecycle' && run === 'both'))).toBe(true);
  });
});

// The reusable complete fixtures live beside end-state.test.ts. The sparse matrix really is incomplete.
const recordCheck = (agent: AgentSpec): string => `${agent.end.record === 'active' ? 'record_active' : 'record'}:${agent.id}`;
async function checkEndState(def: TaskDefinition, use: UseCase, command: 'run' | 'status', fixture: EndStateWorld): Promise<void> {
  const parsed = parseArguments(def, withCase(use, command));
  expect(def.steps(use, parsed.flags)).toEqual([]);
  expect(def.needs.keys(use, parsed.flags)).toEqual([]);
  const journal = { check: 'end-state', network: 'vector-mainnet', record: use.name };
  StateFile.open(join(fixture.stateDir, 'end-state.state.json'), journal);
  EvidenceFile.open(join(fixture.stateDir, 'end-state.evidence.json'), journal);
  const roots = { fixture: fixture.fixtureDir, keys: fixture.keysDir };
  const before = snapshotRoots(roots);
  const seen = await fixture.observe(command);
  expect(seen.exit).toBe(0);
  expect(seen.errors).toBe('');
  expect(seen.signatures).toBe(0);
  expect(seen.submissions).toBe(0);
  expect(snapshotRoots(roots)).toEqual(before);
  expect(seen.machine).toMatchObject({ task: 'end-state', command, mode: 'dry', exit: 0, outcome: command === 'status' ? 'done' : 'finished' });
  expect(seen.lines).toContain('end state: DONE: every check is ok');
  expect(seen.lines.filter((line) => /^OK +/.test(line)).map((line) => /^OK +([^ ]+): /.exec(line)![1])).toEqual([
    ...use.agents.map(recordCheck), ...use.records.map(({ id }) => `record:${id}`),
    ...[...use.agents.filter(({ end }) => end.record === 'active'), ...use.records].flatMap(({ id, organisation }) => organisation === null ? [] : [`organisation:${id}`]),
    'adverts', ...use.agents.map(({ id }) => `claims:${id}`), 'delegations', 'holds', 'wallets', 'attestations', 'runtimes',
    ...use.agents.filter(({ id }) => use.subagents.some(({ parent }) => parent === id)).map(({ id }) => `subagents:${id}`),
    ...(use.compliance === null ? [] : ['compliance']), ...(use.lifecycle === null ? [] : ['lifecycle']),
  ]);
  expect(seen.reads.tools).toContain('vector_marketplace_list_suppliers');
  expect(seen.reads.tools).toContain('vector_resolve_did');
  expect(wordsFound(seen.lines.join('\n'), use.name)).toEqual([]);
}

const EXCLUDED_CASE_MODULES: readonly string[] = [
  'lib/evidence/index.ts', // Selects the evidence writer by the enrolled case name.
  'lib/trials/index.ts', // Selects the trial builder by the enrolled case name.
  'lib/evidence/inventory.ts', // Proves inventory evidence.
  'lib/evidence/prior-authorization.ts', // Proves prior authorization evidence.
  'lib/evidence/bid-evaluation.ts', // Proves bid evaluation evidence.
  'lib/evidence/lifecycle.ts', // Proves the lifecycle run of bid evaluation.
  'lib/trials/inventory.ts', // Builds the inventory trial.
  'lib/trials/priorauth.ts', // Builds the prior authorization trial.
  'lib/trials/bids.ts', // Builds the bid evaluation trial.
];
const DEFAULTS: Readonly<Record<string, readonly [symbol: string, value: string]>> = {
  'lib/settings.ts': ['DEFAULT_USE_CASE', CASES[0]!.name], // Keeps the released default selector.
  'tasks/hold.ts': ['DEFAULT_AGENT', CASES[0]!.agents[1]!.id], // Keeps the released hold command target.
  'tasks/probe.ts': ['DEFAULT_AGENT', CASES[0]!.agents[0]!.id], // Keeps the released probe command target.
};
function wordsOf(use: UseCase): ReadonlySet<string> {
  const words = new Set<string>([use.name, use.moduleManifestPath, ...use.keys.map(({ name }) => name),
    ...use.organisations.flatMap(({ id, domain }) => [id, domain]), ...Object.values(use.tenantOrganisations), ...envFiles(use)]);
  const add = (...values: string[]): void => { for (const value of values) words.add(value); };
  const addUrl = (value: string): void => {
    const url = new URL(value);
    add(value, url.origin, url.host, url.hostname);
    if (url.pathname !== '/') add(url.pathname);
  };
  for (const subject of [...use.agents, ...use.subagents, ...use.records]) {
    add(subject.id, subject.name);
    for (const { key, lines } of subject.keys) add(key, ...lines.map(({ file }) => file));
  }
  for (const agent of use.agents) {
    const example = agent.exampleEnvFile ?? `${agent.serviceEnvFile}.example`;
    add(agent.kind, agent.capability, agent.claim.claimType, agent.folder, agent.serviceContainer, agent.serviceEnvFile, example, `${agent.folder}/${example}`);
    for (const { key, lines } of agent.publicKeyLines) add(key, ...lines.map(({ file }) => file));
    for (const url of [agent.endpoint, ...agent.statusUrls]) addUrl(url);
    for (const advert of agent.adverts) {
      add(advert.model, advert.runtimeContainer, advert.runtimeEnvFile);
      addUrl(advert.origin);
      if (advert.runtimeEnvFile !== agent.serviceEnvFile) {
        const example = `${agent.serviceEnvFile}-runtime.example`;
        add(example, `${agent.folder}/${example}`);
      }
    }
  }
  return new Set([...words].filter(Boolean).map((word) => word.toLowerCase()));
}

const CASE_OWNER = new Map<string, string | null>();
for (const use of CASES) for (const word of wordsOf(use)) CASE_OWNER.set(word, CASE_OWNER.has(word) ? null : use.name);

const escaped = (word: string): string => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Match the longest known word at each position. A shared domain stays shared even if its first label names one organisation.
const CASE_WORD = new RegExp(`(?<![a-z0-9])(?:${[...CASE_OWNER.keys()].sort((a, b) => b.length - a.length).map(escaped).join('|')})(?![a-z0-9])`, 'gi');
function wordsFound(text: string, permittedCase?: string): readonly string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(CASE_WORD)) {
    const word = match[0].toLowerCase();
    const owner = CASE_OWNER.get(word);
    if (owner != null && owner !== permittedCase) found.add(word);
  }
  return [...found];
}

// Use the parser already installed by Vitest/Vite. Node removes only TypeScript syntax and preserves line offsets.
interface Ast {
  readonly type: string; readonly start: number; readonly end: number;
  readonly [name: string]: unknown;
}
const isAst = (value: unknown): value is Ast => value !== null && typeof value === 'object' && 'type' in value && typeof value.type === 'string' && 'start' in value && 'end' in value;
const requireHere = createRequire(import.meta.url);
const fromVitest = createRequire(requireHere.resolve('vitest/package.json'));
const fromVite = createRequire(fromVitest.resolve('vite/package.json'));
// `rollup/parseAst` exports the ESTree parser. Narrow its generic node values as the scanner reads them.
const rollup: { parseAst(text: string): Ast } = fromVite('rollup/parseAst');

function parseSource(source: string): Ast {
  const stripped = stripTypeScriptTypes(source, { mode: 'strip' });
  // Keep static type-only module paths in the scan. Blank only the erased import or export modifier.
  const trivia = String.raw`(?:\s|//[^\r\n]*|/\*[\s\S]*?\*/)+`;
  const declaration = new RegExp(`(\\bimport${trivia})type\\b|(?:\\b(export${trivia})type\\b(?=${trivia}[{*]))`, 'g');
  const withTypePaths = source.replace(declaration, (text: string, importing: string | undefined, exporting: string | undefined, start: number) =>
    stripped.slice(start, start + 6).trim() === '' ? `${importing ?? exporting}    ` : text);
  return rollup.parseAst(withTypePaths === source ? stripped : stripTypeScriptTypes(withTypePaths, { mode: 'strip' }));
}

const astNodes = (value: unknown): Ast[] => Array.isArray(value) ? value.filter(isAst) : [];
const symbolOf = (node: unknown): string | undefined => isAst(node) && node.type === 'Identifier' && typeof node.name === 'string' ? node.name : undefined;

const CLAIM_FILE = 'lib/claim-constants.ts';
const PLATFORM_FILE = 'lib/platform.ts';
const KIT_EXPORTS: Readonly<Record<string, readonly string[]>> = {
  '../../../packages/usecase-kit/src/inventory/index.ts': ['ORDER_DESK_CLAIM', 'REORDER_CLAIM'],
  '../../../packages/usecase-kit/src/bids/index.ts': ['BID_DESK_CLAIM', 'SOURCING_CLAIM'],
  '../../../packages/usecase-kit/src/priorauth/index.ts': ['INTAKE_CLAIM', 'PRIORAUTH_CLAIM'],
};
const CLAIM_BINDINGS = Object.values(KIT_EXPORTS).flat();

function scan(path: string, source: string): { forbidden: readonly string[]; defaults: readonly string[] } {
  const forbidden = new Set<string>();
  const defaults: string[] = [];
  const claimFile = path === CLAIM_FILE;
  const declared = DEFAULTS[path];
  function add(node: Ast, word: string): void {
    forbidden.add(`${path}:${source.slice(0, node.start).split('\n').length}: ${word}`);
  }
  function namedBindings(node: Ast): boolean {
    if (!isAst(node.source) || typeof node.source.value !== 'string') return false;
    const children = astNodes(node.specifiers);
    const importClaim = claimFile && node.type === 'ImportDeclaration' && node.source.value === './platform.ts'
      && children.some(({ imported, local }) => [symbolOf(imported), symbolOf(local)].some((name) => name !== undefined && CLAIM_BINDINGS.includes(name)));
    const exportKit = path === PLATFORM_FILE && node.type === 'ExportNamedDeclaration' ? KIT_EXPORTS[node.source.value] : undefined;
    if (!importClaim && exportKit === undefined) return false;
    walk(node.source, node, 'source');
    for (const specifier of children) {
      const symbol = symbolOf(importClaim ? specifier.imported : specifier.exported);
      const local = symbolOf(specifier.local);
      // Only exact unaliased claim bindings may supply the kind table or cross the kit re-export.
      if (symbol !== undefined && symbol === local && (importClaim ? CLAIM_BINDINGS : exportKit!).includes(symbol)) continue;
      if (importClaim) add(specifier, `unexpected claim import ${symbol ?? local ?? 'specifier'}`);
      else walk(specifier, node, 'specifiers');
    }
    return true;
  }
  function walk(node: Ast, parent: Ast | null, field: string): void {
    if (namedBindings(node)) return;
    const init = field === 'init' && parent?.type === 'VariableDeclarator' && isAst(parent.id) ? parent.id.name : undefined;
    // This initializer maps all kit agent kinds to their claim constants. Scan the rest of the file.
    if (claimFile && init === 'CLAIM_OF_KIND') return;
    if (declared !== undefined && init === declared[0] && node.type === 'Literal' && node.value === declared[1]) {
      defaults.push(`${path}:${declared[0]}=${declared[1]}`);
      return;
    }
    const { value } = node;
    const text = typeof value === 'string' ? value
      : node.type === 'TemplateElement' && value !== null && typeof value === 'object' && 'cooked' in value && typeof value.cooked === 'string' ? value.cooked
      : node.type === 'Literal' || node.type === 'TemplateElement' ? source.slice(node.start, node.end)
      : node.type === 'Identifier' ? String(node.name).replace(/([a-z0-9])([A-Z])/g, '$1-$2').replaceAll('_', '-') : '';
    const symbol = symbolOf(node);
    if (symbol !== undefined && CLAIM_BINDINGS.includes(symbol)) add(node, symbol);
    else for (const word of wordsFound(text)) add(node, word);
    for (const [key, child] of Object.entries(node)) {
      if (isAst(child)) walk(child, node, key);
      else if (Array.isArray(child)) for (const member of child) if (isAst(member)) walk(member, node, key);
    }
  }
  walk(parseSource(source), null, '');
  return { forbidden: [...forbidden], defaults };
}

function sourcePaths(root: string, folder: string): string[] {
  return readdirSync(join(root, folder), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap((member) => {
    const path = `${folder}/${member.name}`;
    if (member.isDirectory()) return sourcePaths(root, path);
    return member.isFile() && member.name.endsWith('.ts') && !EXCLUDED_CASE_MODULES.includes(path) ? [path] : [];
  });
}

it('keeps case names, ids, kinds and paths out of generic task and library source', () => {
  const root = fileURLToPath(PACK_URL);
  // `usecases/*.ts` contains the case data, its shared fields, and the enrolled names.
  const findings = [...sourcePaths(root, 'tasks'), ...sourcePaths(root, 'lib')].map((path) => scan(path, readFileSync(join(root, path), 'utf8')));
  expect(findings.flatMap(({ forbidden }) => forbidden)).toEqual([]);
  expect(findings.flatMap(({ defaults }) => defaults).sort()).toEqual(Object.entries(DEFAULTS).map(([path, [name, value]]) => `${path}:${name}=${value}`).sort());
});

it('allows only the actual default initializer, not another key or a template expression', () => {
  const id = CASES[0]!.agents[1]!.id;
  const other = CASES[1]!.subagents[0]!.id;
  const control = `// ${other}\nconst DEFAULT_AGENT = '${id}';`;
  expect(scan('tasks/hold.ts', control)).toEqual({ forbidden: [], defaults: [`tasks/hold.ts:DEFAULT_AGENT=${id}`] });
  expect(scan('tasks/hold.ts', `${control}\nconst hardcoded = \`a \${'${other}'}\`;`).forbidden).toEqual([`tasks/hold.ts:3: ${other}`]);
  expect(scan('tasks/other.ts', `const DEFAULT_AGENT = '${id}';`).forbidden).toEqual([`tasks/other.ts:1: ${id}`]);
  const kit = "export { BID_DESK_CLAIM } from '../../../packages/usecase-kit/src/bids/index.ts';";
  expect(scan('lib/platform.ts', kit).forbidden).toEqual([]);
  expect(scan('tasks/other.ts', kit).forbidden).toEqual(['tasks/other.ts:1: BID_DESK_CLAIM']);
  expect(scan(PLATFORM_FILE, kit.replace('BID_DESK_CLAIM }', 'BID_DESK_CLAIM as another }')).forbidden).toEqual([`${PLATFORM_FILE}:1: BID_DESK_CLAIM`]);
  expect(scan(PLATFORM_FILE, `${kit}\nconst claim = BID_DESK_CLAIM;`).forbidden).toEqual([`${PLATFORM_FILE}:2: BID_DESK_CLAIM`]);
});

it('allows only the six claim imports and the claim table initializer', () => {
  const imports = `import { ${CLAIM_BINDINGS.join(', ')} } from './platform.ts';`;
  const table = `export const CLAIM_OF_KIND = Object.freeze({ '${CASES[1]!.agents[1]!.kind}': INTAKE_CLAIM });`;
  expect(scan(CLAIM_FILE, `${imports}\n${table}`).forbidden).toEqual([]);
  expect(scan(CLAIM_FILE, imports.replace(' }', ', unrelated }')).forbidden).toEqual([`${CLAIM_FILE}:1: unexpected claim import unrelated`]);
  expect(scan(CLAIM_FILE, "import { INTAKE_CLAIM } from './another.ts';").forbidden).toEqual([`${CLAIM_FILE}:1: INTAKE_CLAIM`]);
  expect(scan(CLAIM_FILE, `${imports}\n${table}\nconst misuse = INTAKE_CLAIM;`).forbidden).toEqual([`${CLAIM_FILE}:3: INTAKE_CLAIM`]);
});

it('detects each type of case-only word and permits a word shared between cases', () => {
  const use = CASES[2]!;
  const agent = use.agents[1]!;
  const advert = agent.adverts[0]!;
  const organisation = use.organisations[2]!;
  const file = 'tasks/example.ts';
  for (const word of unique([use.name, use.compliance!.issuerKey, organisation.id, organisation.domain, agent.id, agent.name, agent.kind,
    use.subagents[0]!.id, use.records[0]!.id, agent.endpoint, new URL(advert.origin).host, agent.statusUrls[0]!, agent.folder, agent.serviceEnvFile,
    `${agent.folder}/${agent.serviceEnvFile}`, agent.exampleEnvFile!, agent.serviceContainer, advert.runtimeContainer,
    advert.model, agent.capability, agent.claim.claimType])) {
    expect(scan(file, `const fixed = ${JSON.stringify(word)};`).forbidden).toEqual([`${file}:1: ${word.toLowerCase()}`]);
  }
  const shared = CASES[0]!.tenantOrganisations.insurer;
  expect(scan(file, `const shared = '${shared}';`).forbidden).toEqual([]);
  const typePath = `import /* type path */ type { Shape } from './${agent.id}.ts';`;
  expect(scan(file, typePath).forbidden).toEqual([`${file}:1: ${agent.id}`]);
});

it('enrolls exactly the case data names in the evidence and trial registries', () => {
  const names = CASES.map(({ name }) => name).sort();
  expect(Object.keys(EVIDENCE_MODULES).sort()).toEqual(names);
  // The trial table is not exported. Read its literal keys so an extra entry fails the check too.
  const program = parseSource(readFileSync(new URL('lib/trials/index.ts', PACK_URL), 'utf8'));
  const table = astNodes(program.body).flatMap(({ declarations }) => astNodes(declarations))
    .find(({ id }) => isAst(id) && id.name === 'TRIALS')?.init;
  if (!isAst(table) || table.type !== 'ObjectExpression') throw new Error('the trial registry must declare its case keys');
  const registered = astNodes(table.properties).map((property) => {
    if (property.type !== 'Property' || property.computed || !isAst(property.key) || typeof property.key.value !== 'string') {
      throw new Error('the trial registry must use a literal case name');
    }
    return property.key.value;
  });
  expect(registered.sort()).toEqual(names);
  for (const name of names) expect(trialOf(name)).toEqual(expect.any(Function));
  expect(() => trialOf('no-registered-case')).toThrow('this use case has no claim trial');
});

it('loads the real data for every supported use case through the public selector', async () => {
  expect([...USE_CASE_NAMES]).toEqual(CASES.map(({ name }) => name));
  for (const data of CASES) expect(await loadUseCase(data.name)).toEqual(data);
});
