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
  const foreign = caseWords(CASES.filter((use) => use.name !== w.use.name)).filter((word) => !caseWords([w.use]).includes(word));
  const outputs = [...seen.out, ...seen.errors, ...seen.changed.flatMap((file) => /\.(?:json|txt)$/.test(file) ? [readFileSync(join(w.dir, file), 'utf8')] : [])];
  const names = wordsFound(outputs.join('\n'), foreign);
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
  const foreign = caseWords(CASES.filter((data) => data.name !== use.name)).filter((word) => !caseWords([use]).includes(word));
  expect(wordsFound(seen.lines.join('\n'), foreign)).toEqual([]);
}

const CASE_TABLES: readonly string[] = [
  'lib/claim-constants.ts', 'lib/trials/index.ts', 'lib/trials/inventory.ts', 'lib/trials/priorauth.ts', 'lib/trials/bids.ts',
  'lib/evidence/index.ts', 'lib/evidence/inventory.ts', 'lib/evidence/prior-authorization.ts', 'lib/evidence/bid-evaluation.ts',
];
const DEFAULTS: Readonly<Record<string, readonly [symbol: string, value: string]>> = {
  'lib/settings.ts': ['DEFAULT_USE_CASE', CASES[0]!.name],
  'tasks/hold.ts': ['DEFAULT_AGENT', CASES[0]!.agents[1]!.id],
  'tasks/probe.ts': ['DEFAULT_AGENT', CASES[0]!.agents[0]!.id],
};
function caseWords(cases: readonly UseCase[]): readonly string[] {
  return unique(cases.flatMap((use) => [use.name, ...[...use.subagents, ...use.records].flatMap(({ id, name }) => [id, name]), ...use.agents.flatMap((a) => [
    a.id, a.kind, a.name, a.capability, a.folder, a.serviceContainer, a.serviceEnvFile, ...(a.exampleEnvFile === null ? [] : [a.exampleEnvFile]),
    ...a.adverts.flatMap((advert) => [advert.model, advert.runtimeContainer, advert.runtimeEnvFile]),
  ])]).map((word) => word.toLowerCase()));
}
const escaped = (word: string): string => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function wordsFound(text: string, terms: readonly string[]): readonly string[] {
  return terms.filter((term) => new RegExp(`(?:^|[^a-z0-9])${escaped(term)}(?![a-z0-9])`, 'i').test(text));
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

function scan(path: string, source: string): { forbidden: readonly string[]; defaults: readonly string[] } {
  const forbidden = new Set<string>();
  const defaults: string[] = [];
  const terms = caseWords(CASES);
  const declared = DEFAULTS[path];
  function kitExport(node: Ast): boolean {
    if (path !== 'lib/platform.ts' || node.type !== 'ExportNamedDeclaration' || !isAst(node.source) || !Array.isArray(node.specifiers)) return false;
    const symbols: Readonly<Record<string, readonly string[]>> = {
      '../../../packages/usecase-kit/src/inventory/index.ts': ['ORDER_DESK_CLAIM', 'REORDER_CLAIM'],
      '../../../packages/usecase-kit/src/bids/index.ts': ['BID_DESK_CLAIM', 'SOURCING_CLAIM'],
      '../../../packages/usecase-kit/src/priorauth/index.ts': ['INTAKE_CLAIM', 'PRIORAUTH_CLAIM'],
    };
    const spec = typeof node.source.value === 'string' ? symbols[node.source.value] : undefined;
    if (spec === undefined) return false;
    // Keep checking the source and all other specifiers. Do not exempt a local name or alias.
    walk(node.source, node, 'source');
    for (const child of node.specifiers) {
      if (!isAst(child)) throw new Error('the kit re-export has no specifier');
      if (isAst(child.local) && isAst(child.exported) && child.local.name === child.exported.name && spec.includes(String(child.local.name))) continue;
      walk(child, node, 'specifiers');
    }
    return true;
  }
  function walk(node: Ast, parent: Ast | null, field: string): void {
    if (kitExport(node)) return;
    const init = field === 'init' && parent?.type === 'VariableDeclarator' && isAst(parent.id) ? parent.id.name : undefined;
    if (declared !== undefined && init === declared[0] && node.type === 'Literal' && node.value === declared[1]) {
      defaults.push(`${path}:${declared[0]}=${declared[1]}`);
      return;
    }
    const { value } = node;
    const text = typeof value === 'string' ? value
      : node.type === 'TemplateElement' && value !== null && typeof value === 'object' && 'cooked' in value && typeof value.cooked === 'string' ? value.cooked
      : node.type === 'Literal' || node.type === 'TemplateElement' ? source.slice(node.start, node.end)
      : node.type === 'Identifier' ? String(node.name).replace(/([a-z0-9])([A-Z])/g, '$1-$2').replaceAll('_', '-') : '';
    for (const word of wordsFound(text, terms)) forbidden.add(`${path}:${source.slice(0, node.start).split('\n').length}: ${word}`);
    for (const [key, child] of Object.entries(node)) {
      if (isAst(child)) walk(child, node, key);
      else if (Array.isArray(child)) for (const member of child) if (isAst(member)) walk(member, node, key);
    }
  }
  walk(rollup.parseAst(stripTypeScriptTypes(source, { mode: 'strip' })), null, '');
  return { forbidden: [...forbidden], defaults };
}

function sourcePaths(root: string, folder: string): string[] {
  return readdirSync(join(root, folder), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap((member) => {
    const path = `${folder}/${member.name}`;
    if (member.isDirectory()) return sourcePaths(root, path);
    return member.isFile() && member.name.endsWith('.ts') && !CASE_TABLES.includes(path) ? [path] : [];
  });
}

it('keeps case names, ids, kinds and paths out of generic task and library source', () => {
  const root = fileURLToPath(PACK_URL);
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
  expect(scan('tasks/other.ts', kit).forbidden).toEqual(['tasks/other.ts:1: bid-desk']);
  expect(scan('lib/platform.ts', kit.replace('BID_DESK_CLAIM }', 'BID_DESK_CLAIM as another }')).forbidden).toEqual(['lib/platform.ts:1: bid-desk']);
  expect(scan('lib/platform.ts', `${kit}\nconst claim = BID_DESK_CLAIM;`).forbidden).toEqual(['lib/platform.ts:2: bid-desk']);
});

it('has one registered evidence module for each source data file', () => {
  expect(Object.keys(EVIDENCE_MODULES).sort()).toEqual(CASES.map(({ name }) => name).sort());
});

it('loads the real data for every supported use case through the public selector', async () => {
  expect([...USE_CASE_NAMES]).toEqual(CASES.map(({ name }) => name));
  for (const data of CASES) expect(await loadUseCase(data.name)).toEqual(data);
});
