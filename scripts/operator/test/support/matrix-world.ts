import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { expect, vi } from 'vitest';
import { iso } from '../../../checks/lib/format.ts';
import { checkArguments, HostedError } from '../../../checks/lib/hosted.ts';
import { KeyRing, LoadedKey } from '../../../checks/lib/keys.ts';
import type { TaskDefinition, UseCase } from '../../lib/contract.ts';
import { FactsFile } from '../../lib/facts.ts';
import { MOCK_PUBLIC_BASE } from '../../lib/mock-hosts.ts';
import { loadRegistry, publicManifestFile, writePublicManifest } from '../../lib/registry.ts';
import { parseArguments, runTask } from '../../lib/runner.ts';
import bidEvaluation from '../../usecases/bid-evaluation.ts';
import inventory from '../../usecases/inventory-reorder.ts';
import { USE_CASE_NAMES } from '../../usecases/names.ts';
import priorAuthorization from '../../usecases/prior-authorization.ts';
import { makeTestKeys, writeSeed } from './keys.ts';
import { PACK_SCHEMAS } from './pack-hosted.ts';
import { hashOf, HOUR, taskWorld } from './task-world.ts';
import type { MachineLine, TaskWorld } from './task-world.ts';

export const CASES: readonly UseCase[] = [inventory, priorAuthorization, bidEvaluation];
export const RUN = 'r1';
export const NEW_RUN = 'matrix-next';
export const COLLATERAL = 5_000_000n;
const NETWORK = 'vector-mainnet';
export const TENANT = 'offline-matrix';
export const MODULE_COMMIT = hashOf('module manifest revision').slice(0, 40);
export const TENANT_READS = ['state', 'log'].map((leaf) => `${MOCK_PUBLIC_BASE}/t/${TENANT}/${leaf}`);
const RUN_TOP_UP = 1_000_000_000n;
const FEE_FLOAT = 20_000_000n;
const MOCK_TOKEN = hashOf('mock test credential');
const PACKAGE = 'ghcr.io/apex-fusion/vector-service-agents';
const EXAMPLES = new URL('../../../../deploy/server/', import.meta.url);

export class WorldGate extends HostedError {
  constructor(readonly port: 'fetch' | 'hosted', readonly target: string) {
    super('unreachable', `world gate: ${port} ${target}`);
    this.name = 'WorldGate';
  }
}

export interface Observation {
  readonly exit: number;
  readonly machine: MachineLine;
  readonly out: readonly string[];
  readonly errors: readonly string[];
  readonly gates: readonly WorldGate[];
  readonly tenantReads: readonly string[];
  readonly loaded: readonly (readonly string[])[];
  readonly forbidden: readonly string[];
  readonly changed: readonly string[];
  readonly leaked: boolean;
}

export interface MatrixWorld extends TaskWorld {
  readonly headerFile: string;
  observe(def: TaskDefinition, args: readonly string[]): Promise<Observation>;
}

function seedFacts(w: TaskWorld, images: Record<string, string>, omit: 'register' | 'attest' | undefined): void {
  const facts = FactsFile.open(join(w.stateDir, 'facts.json'), { useCase: w.use.name, network: NETWORK });
  const at = iso(w.clock.now());
  const origins = [...w.use.agents, ...w.use.records];
  for (const subject of [...origins, ...w.use.subagents]) {
    if (omit === 'register' && subject === w.use.agents[0]) continue;
    const id = hashOf(`record ${subject.id}`);
    const tx = hashOf(`registration ${subject.id}`);
    const did = `did:vector:${id}`;
    facts.put('records', [subject.id], { id, did, tx, recordRef: `${tx}#0`, depositLovelace: '10000000', registeredAt: at });
    if ('organisation' in subject && subject.organisation !== null) {
      const org = w.use.organisations.find(({ id: name }) => name === subject.organisation);
      if (org === undefined) throw new Error(`unknown organisation of ${subject.id}`);
      facts.put('organisations', [subject.id], { txtName: `_did.${org.domain}`, txtValue: did, verifiedAt: at });
    }
  }
  for (const agent of w.use.agents) {
    const origin = agent.endpoint;
    const sha256 = hashOf(`manifest ${agent.id}`);
    facts.put('manifests', [agent.id], { uri: `${origin}/agent.json`, sha256, bytes: 1_000, readAt: at });
    for (const advert of agent.adverts) {
      const tx = hashOf(`advert ${agent.id} ${advert.model}`);
      facts.put('adverts', [agent.id, advert.model], { ref: `${tx}#0`, tx, detailUri: `${origin}/agent.json`, detailHash: sha256, endpoint: advert.origin, postedAt: at });
    }
    facts.put('stakes', [agent.id], { openingRef: `${hashOf(`opening ${agent.id}`)}#0`, stakeRef: `${hashOf(`stake ${agent.id}`)}#0`, tokenUnit: hashOf(`stake token ${agent.id}`), amountLovelace: String(agent.stakeLovelace) });
    const claimTx = hashOf(`claim ${agent.id}`);
    facts.put('claims', [RUN, agent.id], { claimRef: `${claimTx}#0`, claimTx, documentTx: hashOf(`claim document ${agent.id}`), claimToken: hashOf(`claim token ${agent.id}`),
      stakeLovelace: String(agent.claim.stakeLovelace), windowMs: agent.claim.windowMs, stakedAt: at, withdrawableFrom: iso(w.clock.now() + agent.claim.windowMs), withdrawTx: null });
  }
  for (const spec of w.use.attestations) for (const type of spec.types) {
    if (omit === 'attest') continue;
    facts.put('attestations', [spec.agent, type], { id: hashOf(`${type} ${spec.agent}`), tx: hashOf(`issue ${type} ${spec.agent}`), digest: hashOf(`document ${spec.agent}`),
      locator: 'https://documents.example.test/build.json', validUntil: iso(w.clock.now() + 24 * HOUR), issuedAt: at, envelope: spec.envelope?.type === type });
  }
  facts.put('tenants', [RUN], { name: TENANT, createdAt: at, seedKind: w.use.tenantSeed === null ? 'default' : 'custom' });
  facts.put('deploy', [], { commit: MODULE_COMMIT, images });
}

function writeManifests(w: TaskWorld): void {
  const current = loadRegistry({ dir: w.keys.root, useCase: w.use.name, specs: w.use.keys });
  writePublicManifest(join(w.keys.root, publicManifestFile(w.use.name)), current, { network: NETWORK, useCase: w.use.name });
  // A later case sees the public files of the earlier enabled cases, not their private scopes.
  for (const earlier of CASES) {
    if (earlier.name === w.use.name) break;
    if (!USE_CASE_NAMES.some((name) => name === earlier.name)) continue;
    const shared = earlier.keys.filter(({ scope }) => scope === 'shared').map(({ name }) => name);
    const keys = makeTestKeys(earlier.keys.map(({ name }) => name), { useCase: earlier.name, shared });
    for (const name of shared) if (current.has(name)) writeSeed(keys.root, 'shared', name, `${w.keys.seedOf(name)}\n`);
    const prior = loadRegistry({ dir: keys.root, useCase: earlier.name, specs: earlier.keys });
    writePublicManifest(join(w.keys.root, publicManifestFile(earlier.name)), prior, { network: NETWORK, useCase: earlier.name });
  }
}

function snapshotAt(path: string, label: string, files: Map<string, string>): void {
  const info = lstatSync(path, { bigint: true });
  if (info.isDirectory()) {
    files.set(label, `dir:${info.mode}`);
    for (const child of readdirSync(path)) snapshotAt(join(path, child), label === '' ? child : `${label}/${child}`, files);
  } else {
    const data = info.isSymbolicLink() ? readlinkSync(path) : info.isFile() ? readFileSync(path) : '';
    files.set(label, `${info.mode}:${info.mtimeNs}:${info.ctimeNs}:${createHash('sha256').update(data).digest('hex')}`);
  }
}

export function snapshotRoots(roots: Readonly<Record<string, string>>): ReadonlyMap<string, string> {
  const files = new Map<string, string>();
  for (const [label, path] of Object.entries(roots)) snapshotAt(path, label, files);
  return files;
}

export async function matrixWorld(use: UseCase, { omit, liveEnv = false }: { omit?: 'register' | 'attest'; liveEnv?: boolean } = {}): Promise<MatrixWorld> {
  const gates: WorldGate[] = [];
  const tenantReads: string[] = [];
  const loaded: string[][] = [];
  const forbidden: string[] = [];
  const forbid = (action: string) => (): never => {
    forbidden.push(action);
    throw new Error(`the dry matrix attempted ${action}`);
  };
  const gateFetch: typeof fetch = async (input, init) => {
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    const url = new URL(input instanceof Request ? input.url : input);
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    if (method === 'GET' && TENANT_READS.includes(url.href)) {
      if ([...headers.keys()].join(',') !== 'accept' || headers.get('accept') !== 'application/json'
        || init?.body != null || init?.redirect !== 'error' || init.cache !== 'no-store') forbid('a tenant read outside the public request contract')();
      tenantReads.push(url.href);
      return url.href === TENANT_READS[0]
        ? Response.json({ tenant: TENANT, po_store: { orders: [{ id: 'test order' }] }, supplier: { orders: [] } })
        : Response.json({ tenant: TENANT, lines: [{ tenant: TENANT }], dropped: 0 });
    }
    // The Koios RPC sends a read as POST. No mock or agent write route is permitted.
    if (method !== 'GET' && !(method === 'POST' && url.origin === 'https://koios.test')) forbidden.push(`an HTTP ${method}`);
    const gate = new WorldGate('fetch', `${method} ${url.href}`);
    gates.push(gate);
    throw gate;
  };
  const hostedGate = async (name: string, args: Record<string, unknown>): Promise<never> => {
    if (!Object.hasOwn(PACK_SCHEMAS, name)) forbid(`a hosted call without a captured schema: ${name}`)();
    const invalid = checkArguments(name, PACK_SCHEMAS[name], args);
    if (invalid.length !== 0) forbid(`invalid arguments for ${name}: ${invalid.join('; ')}`)();
    const gate = new WorldGate('hosted', name);
    gates.push(gate);
    throw gate;
  };
  const w = await taskWorld({ use, keys: use.keys.map(({ name }) => name), shared: use.keys.filter(({ scope }) => scope === 'shared').map(({ name }) => name),
    // Fee collateral stays intact. Its float needs a top-up in every case.
    wallets: { run: [RUN_TOP_UP, COLLATERAL], fee: [COLLATERAL, FEE_FLOAT] }, fetchImpl: gateFetch, hosted: { call: hostedGate } });
  const agentsDir = join(w.dir, 'agents');
  const mockEnvFile = join(w.dir, 'mock.env');
  const headerFile = join(w.dir, 'header.txt');
  Object.assign(w.env, {
    OPERATOR_USE_CASE: USE_CASE_NAMES[0], OPERATOR_AGENTS_DIR: agentsDir, OPERATOR_MODULE1_COMMIT: MODULE_COMMIT,
    OPERATOR_CONTACT: 'Test contact', OPERATOR_MOCK_ENV_FILE: mockEnvFile, OPERATOR_HOSTED_URL: 'https://tools.example.test/mcp',
    OPERATOR_GATEWAY_URL: 'https://identity.example.test', VECTOR_OGMIOS_URL: 'https://node.example.test',
    VECTOR_SUBMIT_URL: 'https://submit.example.test', VECTOR_KOIOS_URL: 'https://indexer.example.test', VECTOR_MARKETPLACE_INDEXER_URL: 'https://market.example.test',
  });
  mkdirSync(w.stateDir, { mode: 0o700 });
  writeFileSync(mockEnvFile, `MOCK_OPERATOR_TOKEN=${MOCK_TOKEN}\n`, { mode: 0o600 });
  writeFileSync(headerFile, 'Operator test results\n', { mode: 0o600 });

  const image = (container: string, name: string): string => `${PACKAGE}/${name}@sha256:${hashOf(`image ${container}`)}`;
  const images: Record<string, string> = {};
  for (const agent of use.agents) {
    images[agent.serviceContainer] = image(agent.serviceContainer, agent.kind);
    const folder = join(agentsDir, agent.folder);
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    const example = agent.exampleEnvFile ?? `${agent.serviceEnvFile}.example`;
    copyFileSync(new URL(example, EXAMPLES), join(folder, example));
    if (agent.adverts.some((advert) => advert.runtimeEnvFile !== agent.serviceEnvFile)) {
      const example = `${agent.serviceEnvFile}-runtime.example`;
      copyFileSync(new URL(example, EXAMPLES), join(folder, example));
    }
    for (const advert of agent.adverts) images[advert.runtimeContainer] = image(advert.runtimeContainer, 'agent-runtime');
    if (liveEnv) {
      const file = join(folder, agent.serviceEnvFile);
      copyFileSync(join(folder, example), file);
      chmodSync(file, 0o600);
    }
  }
  const at = iso(w.clock.now());
  writeFileSync(join(w.stateDir, 'running-images.json'), JSON.stringify({ generated_at: at, images }), { mode: 0o600 });
  writeFileSync(join(w.stateDir, 'seen-services.json'), JSON.stringify({ generated_at: at, services: use.agents.map((agent) => ({
    service: agent.serviceContainer, kind: agent.kind, container: agent.serviceContainer, started_at: at, env: { FAULT_MODE: '' },
  })) }), { mode: 0o600 });
  seedFacts(w, images, omit);
  writeManifests(w);

  const snapshot = () => snapshotRoots({ '': w.dir, keys: w.keys.root });

  async function observe(def: TaskDefinition, argv: readonly string[]): Promise<Observation> {
    const args = parseArguments(def, argv);
    if (args.mode !== 'dry' || args.useCase !== use.name) throw new Error('the matrix needs a dry command for its own case');
    const before = snapshot();
    const beforeLedger = structuredClone(w.world.chain.held);
    w.screen.lines.length = 0;
    w.screen.errors.length = 0;
    gates.length = 0;
    tenantReads.length = 0;
    loaded.length = 0;
    forbidden.length = 0;
    const spies = [
      vi.spyOn(KeyRing.prototype, 'sign').mockImplementation(forbid('a ring signature')),
      vi.spyOn(LoadedKey.prototype, 'signTransaction').mockImplementation(forbid('a transaction signature')),
      vi.spyOn(LoadedKey.prototype, 'signMessage').mockImplementation(forbid('a message signature')),
      vi.spyOn(LoadedKey.prototype, 'jwsKey').mockImplementation(forbid('a JWS signing key')),
      vi.spyOn(w.node, 'submit').mockImplementation(forbid('a node submission')),
      vi.spyOn(w.world.chain, 'submitTx').mockImplementation(forbid('a provider submission')),
      vi.spyOn(globalThis, 'fetch').mockImplementation(forbid('a direct network request')),
    ];
    let exit: number;
    try {
      const deps = w.deps({
        loadUseCase: undefined,
        readRegistry(options) {
          if (options.dir !== w.keys.root || options.useCase !== use.name || !isDeepStrictEqual(options.specs, use.keys)) forbid('a registry read outside the selected case')();
          const registry = loadRegistry(options);
          loaded.push(registry.names());
          return registry;
        },
      });
      expect(deps.loadUseCase, 'the matrix must use the runner case loader').toBeUndefined();
      exit = await runTask(def, argv, deps);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
    if (w.node.submitted.length !== 0 || w.world.chain.applied.length !== 0 || !isDeepStrictEqual(beforeLedger, w.world.chain.held)) forbidden.push('a ledger write');
    const after = snapshot();
    const changed = [...new Set([...before.keys(), ...after.keys()])].filter((file) => before.get(file) !== after.get(file)).sort();
    const text = [...w.screen.lines, ...w.screen.errors, ...changed.flatMap((file) => {
      if (!file.startsWith('state/') || !existsSync(join(w.dir, file)) || !lstatSync(join(w.dir, file)).isFile()) return [];
      return [readFileSync(join(w.dir, file), 'utf8')];
    })].join('\n');
    const leaked = text.includes(MOCK_TOKEN) || use.keys.some(({ name }) => text.includes(w.keys.seedOf(name)));
    return { exit, machine: w.machine(), out: [...w.screen.lines], errors: [...w.screen.errors], gates: [...gates], forbidden: [...forbidden],
      changed, leaked, tenantReads: [...tenantReads], loaded: [...loaded] };
  }
  return { ...w, headerFile, observe };
}
