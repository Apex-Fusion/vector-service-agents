// The task attest over a world with the real builders of buyer-core: `--record` (the document files), the four attestation steps with and without the envelope, the wait until the gateway lists
// them, and the cleanup. The world is the identity registry of the fixtures with the records of the two agents; `fetch` is a fake that answers the public registry, the manifests, the documents,
// the status of the runtimes and the gateway. No test uses the network, a real clock or a real key. A refusal test makes the keys throw when they are asked to sign, so that a signature
// before a refusal fails the test. Each refusal has an accepted twin.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { iso } from '../../checks/lib/format.ts';
import { VECTOR_MAINNET } from '../../checks/lib/settings.ts';
import type { LoadedKey } from '../../checks/lib/keys.ts';
import { factsOf } from '../../checks/lib/txfacts.ts';
import { DEPLOYMENT, RECORD_ID, keyOf } from '../../checks/test/support/world.ts';
import { recordUtxo, rootRecord } from '../../../packages/buyer-core/test/fixtures/identity-world.ts';
// The entry of vector-read has no decoder of the attestation datum; the checks import their decoders from this file in the same way.
import { decodeAttestationDatum } from '../../../packages/vector-read/src/identity-codec.ts';
import type { AttestationDatum } from '../../../packages/vector-read/src/identity-codec.ts';
import { attestationDocumentName, attestationDocumentOf } from '../lib/build-record.ts';
import { FactsFile } from '../lib/facts.ts';
import { ATT_TYPES, envelopeSigStructure, envelopeVerifies, lucidForAddress } from '../lib/platform.ts';
import type * as Platform from '../lib/platform.ts';
import { loadTask } from '../lib/load.ts';
import { loadRegistry } from '../lib/registry.ts';
import type { Registry } from '../lib/registry.ts';
import type { AgentSpec, UseCase } from '../lib/contract.ts';
import { runTask } from '../lib/runner.ts';
import attest from '../tasks/attest.ts';
import data from '../usecases/inventory-reorder.ts';
import UC2 from '../usecases/prior-authorization.ts';
import UC3 from '../usecases/bid-evaluation.ts';
import { World } from './support/fakes.ts';
import { PackHosted } from './support/pack-hosted.ts';
import { NOW, ScriptedNode, hashOf, taskWorld } from './support/task-world.ts';
import type { TaskWorld } from './support/task-world.ts';

/** Every build of an attestation that the task asked for: its hash, the end of its window and the envelope signature that it carries. A build is not a landing: the tests tell which of them landed. */
interface SeenBuild { readonly txHash: string; readonly issuedAt: number; readonly envelopeSig: string | null }
const seen = vi.hoisted(() => ({ builds: [] as SeenBuild[] }));
vi.mock('../lib/platform.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof Platform>();
  return {
    ...actual,
    buildAttest: async (...args: Parameters<typeof actual.buildAttest>) => {
      const built = await actual.buildAttest(...args);
      seen.builds.push({ txHash: built.txHash, issuedAt: built.issuedAt, envelopeSig: built.attestation.envelopeSig });
      return built;
    },
  };
});

// ---- the data of the world ----

const COMMIT = '0123456789abcdef0123456789abcdef01234567';
const BASE = `https://raw.githubusercontent.com/Apex-Fusion/vector-service-agents/${'e1'.repeat(20)}/docs/attestations/`;
const GATEWAY = 'https://id.vector.apexfusion.org';
const KEYS = ['run', 'fee', 'provider', 'controller'];
const DAY = 86_400_000;
const AGENTS = ['reorder-agent', 'order-desk'] as const;
type AgentId = (typeof AGENTS)[number];
const TYPES = ['provenance', 'software'] as const;
const STEPS = AGENTS.flatMap((agent) => TYPES.map((type) => `${agent}:${type}`));
const IDS: Record<AgentId, string> = { 'reorder-agent': RECORD_ID, 'order-desk': 'd2'.repeat(32) };
const MANIFESTS: Record<AgentId, string> = { 'reorder-agent': '{"manifest":"the reorder agent"}', 'order-desk': '{"manifest":"the order desk"}' };
const digest = (byte: string): string => `sha256:${byte.repeat(32)}`;
const SERVICE: Record<AgentId, string> = { 'reorder-agent': digest('a1'), 'order-desk': digest('b2') };
const RUNTIME = digest('c3');
const REPOSITORY = 'ghcr.io/apex-fusion/vector-service-agents';
const sha256 = (bytes: string | Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const agentOf = (id: AgentId) => data.agents.find((agent) => agent.id === id)!;
const nameOf = (agent: AgentId): string => attestationDocumentName(agent, COMMIT);
const documentOf = (agent: AgentId, over: { manifest?: string; image?: string } = {}) => attestationDocumentOf({ manifestSha256: sha256(over.manifest ?? MANIFESTS[agent]), imageDigest: over.image ?? SERVICE[agent] });
const locatorOf = (agent: AgentId): string => `${BASE}${nameOf(agent)}`;

function advertFacts(facts: FactsFile, agent: AgentSpec, detailHash: string, replace = false): void {
  for (const { model, origin } of agent.adverts) {
    const tx = hashOf(`advert ${agent.id}:${model}`);
    facts.put('adverts', [agent.id, model], { ref: `${tx}#0`, tx, detailUri: `${origin}/agent.json`, detailHash, endpoint: origin, postedAt: iso(NOW) }, { replace });
  }
}

/** The running images as the wrapper writes them: both services and the four runtimes. */
function runningImages(): Map<string, string> {
  return new Map([
    ['reorder-service', `${REPOSITORY}/reorder-agent@${SERVICE['reorder-agent']}`], ['orders-service', `${REPOSITORY}/order-desk@${SERVICE['order-desk']}`],
    ['reorder-runtime', `${REPOSITORY}/agent-runtime@${RUNTIME}`], ['orders-small-runtime', `${REPOSITORY}/agent-runtime@${RUNTIME}`],
    ['orders-medium-runtime', `${REPOSITORY}/agent-runtime@${RUNTIME}`], ['orders-large-runtime', `${REPOSITORY}/agent-runtime@${RUNTIME}`],
  ]);
}

// ---- the fake web ----

type Route = (init: RequestInit) => Response | Promise<Response>;

/** A `fetch` that answers by exact URL. A URL with no route answers 404 and is kept in `missed`. */
class Web {
  readonly routes = new Map<string, Route>();
  readonly calls: Array<{ url: string; init: RequestInit }> = [];
  readonly missed: string[] = [];
  readonly fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    this.calls.push({ url, init: init ?? {} });
    const route = this.routes.get(url);
    if (route === undefined) {
      this.missed.push(url);
      return new Response('no route', { status: 404 });
    }
    return route(init ?? {});
  }) as typeof fetch;

  /** Answers a URL with a body (a new answer for each call), or with the Response that a function makes. */
  set(url: string, answer: string | (() => Response)): void {
    this.routes.set(url, typeof answer === 'function' ? answer : () => new Response(answer));
  }

  to(prefix: string): string[] {
    return this.calls.map((call) => call.url).filter((url) => url.startsWith(prefix));
  }
}

const registryUrls = (image: string, commit = COMMIT): { token: string; manifest: string } => ({
  token: `https://ghcr.io/token?service=ghcr.io&scope=repository:apex-fusion/vector-service-agents/${image}:pull`,
  manifest: `https://ghcr.io/v2/apex-fusion/vector-service-agents/${image}/manifests/${commit}`,
});
const REGISTRY_TOKEN = 'a-pull-token-of-the-test-registry';

/** The public registry: a token for each image, and the manifest of the commit tag with its digest. */
function publish(web: Web, images: Readonly<Record<string, string>>, commit = COMMIT): void {
  for (const [image, imageDigest] of Object.entries(images)) {
    const urls = registryUrls(image, commit);
    web.set(urls.token, () => Response.json({ token: REGISTRY_TOKEN }));
    web.set(urls.manifest, () => new Response('{"manifests":[]}', { headers: { 'docker-content-digest': imageDigest } }));
  }
}
const PUBLIC_IMAGES = { 'reorder-agent': SERVICE['reorder-agent'], 'order-desk': SERVICE['order-desk'], 'agent-runtime': RUNTIME };

const gatewayUrl = (agent: AgentId): string => `${GATEWAY}/1.0/identifiers/did:vector:${IDS[agent]}`;
const resolution = (attestations?: readonly unknown[]): Response => Response.json({
  didDocument: { id: 'a did' }, didDocumentMetadata: { vectorStatus: { effective: 'active' }, ...(attestations === undefined ? {} : { vectorProvenance: { attestations } }) },
});

// ---- the keys: a spy that counts what is signed, and throws when it must not be ----

/** What the keys were asked to sign. When `throwing` is true, a request to sign throws. */
interface Signing { throwing: boolean; messages: number; signers: string[]; bytes: string[] }

const asked = (): never => { throw new Error('a signature was asked for'); };

/** The registry with every signature counted. A proxy hands the real methods their real `this`, so the private seeds stay private. */
function spied(registry: Registry, signing: Signing): Registry {
  const bound = (target: object, property: string | symbol): unknown => {
    const value: unknown = Reflect.get(target, property, target);
    return typeof value === 'function' ? value.bind(target) : value;
  };
  const key = (target: LoadedKey): LoadedKey => new Proxy(target, {
    get: (_target, property) => {
      if (property !== 'signMessage') return bound(target, property);
      return (bytes: Uint8Array): string => {
        signing.messages += 1;
        signing.bytes.push(Buffer.from(bytes).toString('hex'));
        if (signing.throwing) asked();
        return target.signMessage(bytes);
      };
    },
  });
  const ring = new Proxy(registry.ring, {
    get: (target, property) => {
      if (property !== 'sign') return bound(target, property);
      return (keyHash: string, cbor: string): string => {
        signing.signers.push(keyHash);
        if (signing.throwing) asked();
        return target.sign(keyHash, cbor);
      };
    },
  });
  return new Proxy(registry, {
    get: (target, property) => {
      if (property === 'ring') return ring;
      if (property === 'key') return (name: string): LoadedKey => key(target.key(name));
      return bound(target, property);
    },
  });
}

// ---- the rig ----

/** The record that the state file keeps for a step whose name has a colon. */
interface Part { confirmed_at: string; tx_hash: string | null; refs: Record<string, string>; facts: Record<string, unknown>; verified_at: string | null }

interface Rig {
  readonly w: TaskWorld;
  readonly world: World;
  readonly node: ScriptedNode;
  readonly web: Web;
  readonly hosted: PackHosted;
  readonly signing: Signing;
  /** The key names that each load of the registry asked for. */
  readonly loaded: string[][];
  readonly running: Map<string, string>;
  /** Called with the number of each context that a build asks for. A test uses it to move the clock between two builds. */
  onContext: ((count: number) => void) | null;
  contexts: number;
  writeRunning(): void;
  go(over?: { tasks?: string[]; irreversible?: ('attestation' | 'record' | 'stake')[]; at?: string; expiresAt?: string }): void;
  run(...argv: string[]): Promise<number>;
  /** The datum of the attestation that holds the token `id` on the ledger. */
  datum(id: string): AttestationDatum;
  /** The record that the state file keeps for a step (a note, because the names of these steps have a colon). */
  part(step: string): Part;
}

async function rig(options: { noFacts?: boolean; feeOutputs?: bigint[]; controllerOutside?: boolean } = {}): Promise<Rig> {
  const web = new Web();
  seen.builds.length = 0;
  const w = await taskWorld({
    keys: KEYS, shared: KEYS, wallets: {}, fetchImpl: web.fetchImpl,
    use: { agents: data.agents, attestations: data.attestations, organisations: data.organisations },
  });
  const registry = w.keys.registry;
  const controller = options.controllerOutside === true ? keyOf(77, 'agent').publicKeyHex : registry.publicKeyOf('controller');
  const fee = (options.feeOutputs ?? [1_000_000_000n, 5_000_000n]).map((lovelace, outputIndex) => ({ txHash: hashOf('wallet fee'), outputIndex, address: registry.addressOf('fee'), assets: { lovelace } }));
  const world = await World.identity({ wallets: [], extra: [...fee, recordUtxo(IDS['order-desk'], rootRecord({ controller }))], record: { controller } });
  const node = new ScriptedNode(world);
  const hosted = new PackHosted({
    vector_get_attestation: (args) => {
      const unit = `${DEPLOYMENT.attestation.hash}${String(args.attestation)}`;
      const found = world.chain.held.find((output) => output.assets[unit] === 1n);
      if (found?.datum === undefined || found.datum === null) return { found: false, attestation: args.attestation };
      const d = decodeAttestationDatum(found.datum);
      return {
        found: true, attestation: args.attestation, subject: d.subject, issuer_key: d.issuer, issuer_key_hash: hashOfKey(registry, d.issuer), issuer_id: null,
        att_type_code: d.attType, format: d.format, digest: d.digest, locator: Buffer.from(d.locator ?? '', 'hex').toString('utf8'), locator_hex: d.locator, envelope_sig: d.envelopeSig,
        issued_at: d.issuedAt, valid_until: d.validUntil, solicited: d.solicited, status: 'active', state: 'active',
      };
    },
  });
  const signing: Signing = { throwing: false, messages: 0, signers: [], bytes: [] };
  const state: Rig = {
    w, world, node, web, hosted, signing, loaded: [], running: runningImages(), onContext: null, contexts: 0,
    writeRunning: () => writeFileSync(join(w.stateDir, 'running-images.json'), JSON.stringify({ generated_at: iso(w.clock.now()), images: Object.fromEntries(state.running) })),
    go: (over = {}) => { w.writeGo({ tasks: ['attest'], irreversible: ['attestation'], ...over }); },
    run: (...argv) => runTask(attest, argv, w.deps({
      node, hosted, fetchImpl: web.fetchImpl,
      chain: {
        ...w.chain, provider: world.chain,
        context: async (address) => {
          state.contexts += 1;
          state.onContext?.(state.contexts);
          return { lucid: await lucidForAddress(world.chain, address), provider: world.chain, deployment: DEPLOYMENT };
        },
      },
      readRegistry: (read) => { state.loaded.push([...(read.need ?? [])]); return spied(loadRegistry(read), signing); },
    })),
    datum: (id) => {
      const output = world.chain.held.find((candidate) => candidate.assets[`${DEPLOYMENT.attestation.hash}${id}`] === 1n);
      if (output?.datum === undefined || output.datum === null) throw new Error(`the ledger holds no attestation ${id}`);
      return decodeAttestationDatum(output.datum);
    },
    part: (step) => w.state('attest').notes[`part.${step}`] as Part,
  };
  state.go();
  state.writeRunning();
  publish(web, PUBLIC_IMAGES);
  for (const agent of AGENTS) {
    const origin = agentOf(agent).endpoint;
    web.set(`${origin}/agent.json`, MANIFESTS[agent]);
    web.set(locatorOf(agent), documentOf(agent).text);
    web.set(gatewayUrl(agent), () => resolution());
  }
  for (const agent of data.agents) for (const statusUrl of agent.statusUrls) web.set(statusUrl, () => Response.json({ status: 'free' }));
  if (options.noFacts !== true) {
    const facts = FactsFile.open(join(w.stateDir, 'facts.json'), { useCase: 'inventory-reorder', network: 'vector-mainnet' });
    for (const agent of AGENTS) {
      facts.put('records', [agent], { did: `did:vector:${IDS[agent]}`, id: IDS[agent], tx: hashOf(`record ${agent}`), recordRef: `${hashOf(`record ${agent}`)}#0`, depositLovelace: '10000000', registeredAt: iso(NOW) });
      facts.put('manifests', [agent], { uri: `${agentOf(agent).endpoint}/agent.json`, sha256: sha256(MANIFESTS[agent]), bytes: MANIFESTS[agent].length, readAt: iso(NOW) });
      advertFacts(facts, agentOf(agent), sha256(MANIFESTS[agent]));
    }
  }
  return state;
}

/** The key hash of a public key of the registry. */
function hashOfKey(registry: Registry, publicKey: string): string {
  const name = registry.names().find((candidate) => registry.publicKeyOf(candidate) === publicKey);
  if (name === undefined) throw new Error('no key of the registry has this public key');
  return registry.hashOf(name);
}

const RECORD_ARGV = ['run', '--record', '--commit', COMMIT];
const STEP_ARGV = ['run', '--commit', COMMIT, '--locator-base', BASE];
const SUBMIT = [...STEP_ARGV, '--submit'];
const documentsOf = (r: Rig): string[] => (existsSync(join(r.w.stateDir, 'attestation-documents')) ? readdirSync(join(r.w.stateDir, 'attestation-documents')).sort() : []);
const nothingLanded = (r: Rig): void => {
  expect(r.node.submitted).toEqual([]);
  expect(r.signing.signers).toEqual([]);
  expect(r.signing.messages).toBe(0);
};

/** The attestations that the ledger holds at the attestation script: the outputs that carry a token of the attestation policy. */
const attestationsOnLedger = (r: Rig): number => r.world.chain.held.filter((output) => output.address === DEPLOYMENT.attestation.address && Object.keys(output.assets).some((unit) => unit.startsWith(DEPLOYMENT.attestation.hash))).length;

/** The service container and the runtime container of each agent that a row of `REFUSED` takes out. */
const CONTAINER: Record<AgentId, { service: string; runtime: string }> = { 'reorder-agent': { service: 'reorder-service', runtime: 'reorder-runtime' }, 'order-desk': { service: 'orders-service', runtime: 'orders-large-runtime' } };
const manifestUrl = (agent: AgentId): string => `${agentOf(agent).endpoint}/agent.json`;

/** A change of the world after which no attestation may be made for an agent, and the words that the refusal holds. The same rows refuse `--record` and a step. */
const REFUSED: readonly (readonly [string, (r: Rig, agent: AgentId) => void, string])[] = [
  ['a service image that is not the public image of the commit', (r, agent) => publish(r.web, { [agent]: digest('99') }), 'is not the image that CI built'],
  ['a runtime image that is not the public image of the commit', (r) => publish(r.web, { 'agent-runtime': digest('99') }), 'is not the image that CI built'],
  ['a registry that gives no token', (r, agent) => r.web.set(registryUrls(agent).token, () => new Response('no', { status: 500 })), 'the public registry answered 500'],
  ['a registry that does not know the tag', (r, agent) => r.web.set(registryUrls(agent).manifest, () => new Response('no', { status: 404 })), 'the public registry answered 404'],
  ['a manifest answer with no digest', (r, agent) => r.web.set(registryUrls(agent).manifest, () => new Response('{}')), 'docker-content-digest'],
  ['a registry that cannot be reached', (r) => r.web.set(registryUrls('agent-runtime').token, () => { throw new TypeError('fetch failed'); }), 'could not be reached'],
  ['a manifest that changed since the adverts', (r, agent) => r.web.set(manifestUrl(agent), '{"manifest":"another manifest"}'), 'the service changed after its adverts'],
  ['a manifest that cannot be read', (r, agent) => r.web.set(manifestUrl(agent), () => new Response('down', { status: 500 })), 'could not be read'],
  ['a service container that is not in running-images.json', (r, agent) => { r.running.delete(CONTAINER[agent].service); r.writeRunning(); }, 'is not in running-images.json'],
  ['a runtime container that is not in running-images.json', (r, agent) => { r.running.delete(CONTAINER[agent].runtime); r.writeRunning(); }, 'is not in running-images.json'],
  [
    'a service container that runs the image of a runtime',
    (r, agent) => { r.running.set(CONTAINER[agent].service, `${REPOSITORY}/agent-runtime@${SERVICE[agent]}`); r.writeRunning(); },
    'does not run an image of',
  ],
  ['an image id with no repository', (r, agent) => { r.running.set(CONTAINER[agent].service, SERVICE[agent]); r.writeRunning(); }, 'is not a repository with a sha256 digest'],
  [
    'a running-images.json that is 11 minutes old',
    (r) => writeFileSync(join(r.w.stateDir, 'running-images.json'), JSON.stringify({ generated_at: iso(r.w.clock.now() - 11 * 60_000), images: Object.fromEntries(r.running) })),
    'more than 10 minutes old',
  ],
  ['a running-images.json that is damaged', (r) => writeFileSync(join(r.w.stateDir, 'running-images.json'), '{"generated_at": '), 'is not JSON'],
  ['no running-images.json', (r) => rmSync(join(r.w.stateDir, 'running-images.json')), 'does not exist'],
];

// ---- the definition ----

describe('the task attest', () => {
  it('has the name, the flags, the keys, the hosted tool and the approval that the pack runs it with', () => {
    expect(attest.name).toBe('attest');
    expect(attest.flags).toEqual(['record']);
    expect(attest.valued).toEqual(['commit', 'locator-base']);
    expect(attest.needs).toMatchObject({ chain: true, hosted: ['vector_get_attestation'], approval: 'submit' });
    const flags = (record: boolean) => ({ has: (name: string) => record && name === 'record', value: () => undefined });
    expect(attest.needs.keys(data, flags(false))).toEqual(['provider', 'controller', 'fee']);
    expect(attest.needs.keys(data, flags(true))).toEqual([]);
  });
  it('has the four attestation steps and then the four waits, as the data names them', () => {
    expect(attest.steps(data, { has: () => false, value: () => undefined })).toEqual([...STEPS, ...STEPS.map((step) => `visible:${step}`)]);
  });
  it.each([
    [UC2, ['prior-authorization-agent', 'insurer-intake-agent']],
    [UC3, ['sourcing-agent', 'bid-desk-alfa', 'bid-desk-bravo', 'bid-desk-charlie']],
  ] as const)('names the steps for new agents in $name', (use, agents) => {
    const steps = agents.flatMap((agent) => TYPES.map((type) => `${agent}:${type}`));
    expect(attest.steps(use, { has: () => false, value: () => undefined })).toEqual([...steps, ...steps.map((step) => `visible:${step}`)]);
  });
  it('is the task that the command line loads for the name attest', async () => {
    const loaded = await loadTask('attest');
    expect(loaded.name).toBe('attest');
    expect(loaded.steps(data, { has: () => false, value: () => undefined })).toHaveLength(8);
  });
  it('shows its steps, each attestation of the facts with the date of its deposit, and the deploy record, in the status', async () => {
    const r = await rig();
    await r.run(...RECORD_ARGV);
    await land(r, 1);
    r.w.screen.lines.length = 0;
    expect(await r.run('status')).toBe(0);
    const fact = r.w.facts().attestations['reorder-agent']!.provenance!;
    expect(r.w.screen.text).toContain(`the provenance attestation of reorder-agent: ${fact.id}, valid until ${fact.validUntil}`);
    expect(r.w.screen.text).toContain(`the deposit can be withdrawn from ${iso(Date.parse(fact.validUntil) + 90 * DAY)}`);
    expect(r.w.screen.text).toContain(`deploy: the commit ${COMMIT}, 6 running containers`);
    expect(r.w.screen.text).toContain('reorder-agent:software');
    expect(r.node.submitted).toHaveLength(1);
  });
});

// ---- --record ----

describe('attest run --record', () => {
  it('writes the document of each agent with mode 600 and its exact canonical bytes, prints the SHA-256 and the name, and records the deploy', async () => {
    const r = await rig();
    expect(await r.run(...RECORD_ARGV)).toBe(0);
    expect(documentsOf(r)).toEqual([nameOf('order-desk'), nameOf('reorder-agent')].sort());
    for (const agent of AGENTS) {
      const path = join(r.w.stateDir, 'attestation-documents', nameOf(agent));
      expect(readFileSync(path, 'utf8')).toBe(documentOf(agent).text);
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(r.w.screen.text).toContain(`${nameOf(agent)} of ${agent}: SHA-256 ${documentOf(agent).sha256}`);
    }
    const images = Object.fromEntries(r.running);
    expect(r.w.facts().deploy).toEqual({ commit: COMMIT, images });
    expect(r.w.machine()).toMatchObject({ task: 'attest', outcome: 'done', exit: 0, result: { commit: COMMIT, documents: { 'reorder-agent': { name: nameOf('reorder-agent'), sha256: documentOf('reorder-agent').sha256 } } } });
  });
  it('makes no transaction, signs nothing, loads no key and needs no approval', async () => {
    const r = await rig();
    r.signing.throwing = true;
    expect(await r.run(...RECORD_ARGV)).toBe(0);
    nothingLanded(r);
    expect(r.loaded).toEqual([[]]);
    expect(r.hosted.calls).toEqual([]);
    expect(r.w.state('attest').in_flight).toBeNull();
  });
  it('reads the public registry anonymously for the pull token, and then with it for the manifest of the tag of the commit', async () => {
    const r = await rig();
    await r.run(...RECORD_ARGV);
    const registry = r.web.calls.filter((call) => call.url.startsWith('https://ghcr.io/'));
    expect(registry.map((call) => call.url)).toEqual(['reorder-agent', 'agent-runtime', 'order-desk', 'agent-runtime'].flatMap((image) => [registryUrls(image).token, registryUrls(image).manifest]));
    for (const call of registry) {
      const headers = call.init.headers as Record<string, string>;
      expect(headers.authorization).toBe(new URL(call.url).pathname.startsWith('/v2/') ? `Bearer ${REGISTRY_TOKEN}` : undefined);
    }
    expect(r.web.missed).toEqual([]);
  });
  it('holds the digest of the running SERVICE image in the document, and never the digest of the runtime image', async () => {
    const r = await rig();
    await r.run(...RECORD_ARGV);
    const text = readFileSync(join(r.w.stateDir, 'attestation-documents', nameOf('reorder-agent')), 'utf8');
    expect(JSON.parse(text)).toEqual({ image_digest: SERVICE['reorder-agent'], manifest_sha256: sha256(MANIFESTS['reorder-agent']) });
    expect(text).not.toContain(RUNTIME);
  });
  it('never puts the token of the registry on the screen, in the state, in the facts or in a file', async () => {
    const r = await rig();
    await r.run(...RECORD_ARGV);
    expect(r.w.allText()).not.toContain(REGISTRY_TOKEN);
    const r2 = await rig();
    r2.web.set(registryUrls('order-desk').manifest, () => new Response('no', { status: 500 }));
    await r2.run(...RECORD_ARGV);
    expect(r2.w.allText()).not.toContain(REGISTRY_TOKEN);
  });
  it('is a run again with nothing new: the files stay and the facts stay', async () => {
    const r = await rig();
    await r.run(...RECORD_ARGV);
    const before = documentsOf(r).map((name) => statSync(join(r.w.stateDir, 'attestation-documents', name)).mtimeMs);
    r.w.screen.lines.length = 0;
    expect(await r.run(...RECORD_ARGV)).toBe(0);
    expect(r.w.screen.text).toContain('there already');
    expect(documentsOf(r).map((name) => statSync(join(r.w.stateDir, 'attestation-documents', name)).mtimeMs)).toEqual(before);
  });

  const BAD_FLAGS: readonly (readonly [string, string[]])[] = [
    ['--submit', [...RECORD_ARGV, '--submit']], ['no --commit', ['run', '--record']], ['a commit of 39 characters', ['run', '--record', '--commit', COMMIT.slice(1)]],
    ['an upper-case commit', ['run', '--record', '--commit', COMMIT.toUpperCase()]], ['an empty commit', ['run', '--record', '--commit=']],
    ['--locator-base', [...RECORD_ARGV, '--locator-base', BASE]],
  ];
  for (const [label, argv] of BAD_FLAGS) {
    it(`is refused with ${label}, with exit 2 and no file`, async () => {
      const r = await rig();
      r.signing.throwing = true;
      expect(await r.run(...argv)).toBe(2);
      expect(documentsOf(r)).toEqual([]);
      expect(r.w.facts().deploy).toBeNull();
    });
  }

  for (const [label, change, words] of REFUSED) {
    for (const agent of AGENTS) {
      it(`is refused for ${label} of ${agent}, with exit 2 and no file and no fact`, async () => {
        const r = await rig();
        r.signing.throwing = true;
        change(r, agent);
        expect(await r.run(...RECORD_ARGV)).toBe(2);
        expect(r.w.screen.errorText).toContain(words);
        expect(documentsOf(r)).toEqual([]);
        expect(r.w.facts().deploy).toBeNull();
      });
    }
  }
  it('is refused when the facts hold no record, and when they hold no manifest', async () => {
    const none = await rig({ noFacts: true });
    expect(await none.run(...RECORD_ARGV)).toBe(2);
    expect(none.w.screen.errorText).toContain('the facts hold no record of reorder-agent');
    const some = await rig({ noFacts: true });
    FactsFile.open(join(some.w.stateDir, 'facts.json'), { useCase: 'inventory-reorder', network: 'vector-mainnet' }).put('records', ['reorder-agent'], {
      did: `did:vector:${IDS['reorder-agent']}`, id: IDS['reorder-agent'], tx: hashOf('t'), recordRef: `${hashOf('t')}#0`, depositLovelace: '10000000', registeredAt: iso(NOW),
    });
    expect(await some.run(...RECORD_ARGV)).toBe(2);
    expect(some.w.screen.errorText).toContain('the facts hold no manifest of reorder-agent');
    expect(documentsOf(none)).toEqual([]);
    expect(documentsOf(some)).toEqual([]);
  });
  it('keeps a file that holds other bytes and refuses to replace it: a document never changes', async () => {
    const r = await rig();
    await r.run(...RECORD_ARGV);
    const path = join(r.w.stateDir, 'attestation-documents', nameOf('order-desk'));
    writeFileSync(path, `${documentOf('order-desk').text}\n`, { mode: 0o600 });
    expect(await r.run(...RECORD_ARGV)).toBe(2);
    expect(readFileSync(path, 'utf8')).toBe(`${documentOf('order-desk').text}\n`);
  });
  it('replaces the deploy record of another build while no attestation names it, and writes the documents of the new build', async () => {
    const r = await rig();
    expect(await r.run(...RECORD_ARGV)).toBe(0);
    const other = 'f'.repeat(40);
    publish(r.web, PUBLIC_IMAGES, other);
    expect(await r.run('run', '--record', '--commit', other)).toBe(0);
    expect(r.w.facts().deploy).toEqual({ commit: other, images: Object.fromEntries(r.running) });
    expect(documentsOf(r)).toEqual([attestationDocumentName('order-desk', COMMIT), attestationDocumentName('order-desk', other), attestationDocumentName('reorder-agent', COMMIT), attestationDocumentName('reorder-agent', other)].sort());
  });
  it('keeps the deploy record of a build that an attestation names, and writes no file of another build', async () => {
    const r = await rig();
    await r.run(...RECORD_ARGV);
    await land(r, 1);
    const other = 'f'.repeat(40);
    publish(r.web, PUBLIC_IMAGES, other);
    expect(await r.run('run', '--record', '--commit', other)).toBe(2);
    expect(r.w.screen.errorText).toContain('an attestation names that build');
    expect(r.w.facts().deploy?.commit).toBe(COMMIT);
    expect(documentsOf(r)).toEqual([attestationDocumentName('order-desk', COMMIT), attestationDocumentName('reorder-agent', COMMIT)].sort());
  });
});

async function recordRig(use: UseCase) {
  const web = new Web();
  const w = await taskWorld({ use, keys: [], shared: [], wallets: {}, fetchImpl: web.fetchImpl, env: { OPERATOR_USE_CASE: data.name } });
  const facts = FactsFile.open(join(w.stateDir, 'facts.json'), { useCase: use.name, network: 'vector-mainnet' });
  const publicImages: Record<string, string> = { 'agent-runtime': RUNTIME };
  const images: Record<string, string> = {};
  const manifests: Record<string, string> = {};
  for (const [index, agent] of use.agents.entries()) {
    const id = hashOf(`record ${agent.id}`);
    facts.put('records', [agent.id], { did: `did:vector:${id}`, id, tx: id, recordRef: `${id}#0`, depositLovelace: '10000000', registeredAt: iso(NOW) });
    const manifest = JSON.stringify({ agent: agent.id });
    manifests[agent.id] = sha256(manifest);
    const uri = `${agent.endpoint}/agent.json`;
    facts.put('manifests', [agent.id], { uri, sha256: manifests[agent.id], bytes: Buffer.byteLength(manifest), readAt: iso(NOW) });
    advertFacts(facts, agent, manifests[agent.id]!);
    web.set(uri, manifest);
    const service = agent.kind === 'bid-desk' ? digest('bd') : digest(`${index + 1}a`);
    publicImages[agent.kind] = service;
    images[agent.serviceContainer] = `${REPOSITORY}/${agent.kind}@${service}`;
    for (const advert of agent.adverts) images[advert.runtimeContainer] = `${REPOSITORY}/agent-runtime@${RUNTIME}`;
  }
  publish(web, publicImages);
  writeFileSync(join(w.stateDir, 'running-images.json'), JSON.stringify({ generated_at: iso(w.clock.now()), images }));
  return { w, web, facts, publicImages, images, manifests };
}

describe('attest records the build of each agent', () => {
  it.each([UC2, UC3])('writes one document per agent for $name', async (use) => {
    const { w, web, images, publicImages, manifests } = await recordRig(use);
    expect(await w.run(attest, ...RECORD_ARGV)).toBe(0);
    const folder = join(w.stateDir, 'attestation-documents');
    expect(readdirSync(folder).sort()).toEqual(use.agents.map(({ id }) => attestationDocumentName(id, COMMIT)).sort());
    for (const { id, kind } of use.agents) {
      const doc = attestationDocumentOf({ manifestSha256: manifests[id]!, imageDigest: publicImages[kind]! });
      expect(readFileSync(join(folder, attestationDocumentName(id, COMMIT)), 'utf8')).toBe(doc.text);
    }
    expect(w.facts().deploy).toEqual({ commit: COMMIT, images });
    expect(w.node.submitted).toEqual([]);
    expect(web.missed).toEqual([]);
  });

  it('refuses another Bid Desk manifest hash before it writes any document', async () => {
    const { w, facts, manifests } = await recordRig(UC3);
    const bravo = facts.read().manifests['bid-desk-bravo']!;
    facts.put('manifests', ['bid-desk-bravo'], { ...bravo, sha256: manifests['bid-desk-alfa']! }, { replace: true });
    expect(await w.run(attest, ...RECORD_ARGV)).toBe(2);
    expect(w.screen.errorText).toContain('the manifest fact of bid-desk-bravo does not agree with its recorded advert');
    expect(existsSync(join(w.stateDir, 'attestation-documents'))).toBe(false);
    expect(facts.read().deploy).toBeNull();
    expect(w.node.submitted).toEqual([]);
  });
});

// ---- an attestation step ----

const hashesOf = (r: Rig, names: string[]): string[] => names.map((name) => r.w.keys.registry.hashOf(name)).sort();
const SIGNERS = ['provider', 'controller', 'fee'];

/** Lands the first `count` steps, one run each. */
async function land(r: Rig, count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) expect(await r.run(...SUBMIT)).toBe(0);
}

const members = JSON.parse(documentOf('reorder-agent').text) as Record<string, string>;
const BAD_DOCUMENTS: readonly (readonly [string, string | (() => Response), string])[] = [
  ['the document of another manifest', documentOf('reorder-agent', { manifest: 'another manifest' }).text, 'is not the canonical JSON of the manifest'],
  ['the document of another image', documentOf('reorder-agent', { image: digest('99') }).text, 'is not the canonical JSON of the manifest'],
  ['the document of the runtime image', documentOf('reorder-agent', { image: RUNTIME }).text, 'is not the canonical JSON of the manifest'],
  ['the document of the other agent', documentOf('order-desk').text, 'is not the canonical JSON of the manifest'],
  ['a document with a third member', JSON.stringify({ ...members, runtime_digest: RUNTIME }), 'is not the canonical JSON of the manifest'],
  ['a document with a trailing newline', `${documentOf('reorder-agent').text}\n`, 'is not the canonical JSON of the manifest'],
  ['a pretty-printed document', JSON.stringify(members, null, 2), 'is not the canonical JSON of the manifest'],
  ['a document with the members in the other order', JSON.stringify({ manifest_sha256: members.manifest_sha256, image_digest: members.image_digest }), 'is not the canonical JSON of the manifest'],
  ['a document with a byte order mark', `\ufeff${documentOf('reorder-agent').text}`, 'is not the canonical JSON of the manifest'],
  ['a document that is cut', documentOf('reorder-agent').text.slice(0, -1), 'is not the canonical JSON of the manifest'],
  ['an empty document', '', 'is not the canonical JSON of the manifest'],
  ['a document that is far too long', `${documentOf('reorder-agent').text}${' '.repeat(2_000)}`, 'is longer than 1024 bytes'],
  ['an answer with status 404', () => new Response('no', { status: 404 }), 'could not be read'],
  ['an answer with status 500', () => new Response('no', { status: 500 }), 'could not be read'],
  ['a redirect', () => new Response(null, { status: 302, headers: { location: 'https://elsewhere.example/document.json' } }), 'could not be read'],
];

describe('an attestation step', () => {
  it('lands the provenance attestation of the Reorder Agent: the digest is the SHA-256 of the bytes at the locator, and the locator is the hex of the URL', async () => {
    const r = await rig();
    expect(await r.run(...SUBMIT)).toBe(0);
    const part = r.part('reorder-agent:provenance');
    const id = part.refs.attestation_id!;
    const d = r.datum(id);
    const document = documentOf('reorder-agent');
    expect(d).toMatchObject({ attType: ATT_TYPES.provenance, subject: RECORD_ID, issuer: r.w.keys.registry.publicKeyOf('provider'), issuerId: null, format: 50, solicited: true, envelopeSig: null, validFrom: null });
    expect(d.digest).toBe(sha256(document.text));
    expect(d.locator).toBe(Buffer.from(locatorOf('reorder-agent'), 'utf8').toString('hex'));
    expect(Buffer.from(d.locator!, 'hex').toString('utf8')).toBe(locatorOf('reorder-agent'));
    expect(d.issuedAt).toBe(Math.floor(NOW / 1000) * 1000 + 30 * 60_000);
    expect(d.validUntil).toBe(Math.floor((NOW + 365 * DAY) / 1000) * 1000);
    const output = r.world.chain.held.find((candidate) => candidate.assets[`${DEPLOYMENT.attestation.hash}${id}`] === 1n)!;
    expect(output.address).toBe(DEPLOYMENT.attestation.address);
    expect(output.assets.lovelace).toBe(5_000_000n);
    expect(r.node.submitted).toHaveLength(1);
    expect(part.tx_hash).toBe(r.world.hashOf(r.node.submitted[0]!));
    expect(factsOf(r.node.submitted[0]!).witnesses.sort()).toEqual(hashesOf(r, SIGNERS));
    expect([...r.signing.signers].sort()).toEqual(hashesOf(r, SIGNERS));
    expect(r.signing.messages).toBe(0);
    expect(r.w.facts().attestations['reorder-agent']).toEqual({
      provenance: { id, tx: part.tx_hash, digest: d.digest, locator: locatorOf('reorder-agent'), validUntil: iso(d.validUntil!), issuedAt: iso(d.issuedAt), envelope: false },
    });
    expect(part.verified_at).not.toBeNull();
    expect(r.w.evidence('attest').filter((entry) => entry.step === 'reorder-agent:provenance').map((entry) => entry.status)).toEqual(['confirmed', 'verified']);
    expect(r.hosted.calls).toEqual([{ name: 'vector_get_attestation', args: { attestation: id } }]);
    expect(r.w.screen.text).toContain(`issues a provenance attestation about did:vector:${RECORD_ID}`);
    expect(r.w.machine()).toMatchObject({ task: 'attest', outcome: 'done', exit: 0, step: 'reorder-agent:provenance', result: { commit: null, attestations: { 'reorder-agent': { provenance: { id, envelope: false } } } } });
    expect(r.web.missed).toEqual([]);
    for (const name of KEYS) expect(r.w.allText()).not.toContain(r.w.keys.seedOf(name));
    expect(r.w.allText()).not.toContain(REGISTRY_TOKEN);
  });
  it('does one step in a run, in the order of the data', async () => {
    const r = await rig();
    await land(r, 2);
    expect(r.node.submitted).toHaveLength(2);
    expect(Object.keys(r.w.state('attest').notes).filter((key) => key.startsWith('part.'))).toEqual(['part.reorder-agent:provenance', 'part.reorder-agent:software']);
  });
  it('keeps the fact of an attestation that landed when the facts file could not be written: the next run writes it before it goes on', async () => {
    const r = await rig();
    const lock = join(r.w.stateDir, 'facts.json.lock');
    writeFileSync(lock, '');
    expect(await r.run(...SUBMIT)).toBe(1);
    expect(r.w.screen.errorText).toContain('the facts file may lack its facts');
    expect(r.node.submitted).toHaveLength(1);
    expect(r.w.facts().attestations).toEqual({});
    expect(r.part('reorder-agent:provenance').tx_hash).toBe(r.world.hashOf(r.node.submitted[0]!));
    rmSync(lock);
    expect(await r.run(...SUBMIT)).toBe(0);
    expect(r.w.facts().attestations['reorder-agent']?.provenance?.tx).toBe(r.world.hashOf(r.node.submitted[0]!));
    expect(r.part('reorder-agent:provenance').verified_at).not.toBeNull();
    expect(r.node.submitted).toHaveLength(2);
  });
  it('lands the four attestations with --all, each with the digest of the document of its agent, the envelope on one of them only, and then waits for the gateway', async () => {
    const r = await rig();
    expect(await r.run(...SUBMIT, '--all')).toBe(4);
    expect(r.node.submitted).toHaveLength(4);
    const datums = STEPS.map((step) => r.datum(r.part(step).refs.attestation_id!));
    expect(new Set(STEPS.map((step) => r.part(step).refs.attestation_id)).size).toBe(4);
    expect(datums.map((d) => d.attType)).toEqual([1, 2, 1, 2]);
    expect(datums.map((d) => d.subject)).toEqual([IDS['reorder-agent'], IDS['reorder-agent'], IDS['order-desk'], IDS['order-desk']]);
    expect(datums.map((d) => d.digest)).toEqual([documentOf('reorder-agent').sha256, documentOf('reorder-agent').sha256, documentOf('order-desk').sha256, documentOf('order-desk').sha256]);
    expect(datums.map((d) => d.envelopeSig !== null)).toEqual([false, true, false, false]);
    expect(r.signing.messages).toBe(1);
    expect(r.node.submitted.map((signed) => factsOf(signed).witnesses.sort())).toEqual(STEPS.map(() => hashesOf(r, SIGNERS)));
    expect(r.w.machine()).toMatchObject({ outcome: 'wait', exit: 4, step: 'visible:reorder-agent:provenance' });
  });

  for (const [label, body, words] of BAD_DOCUMENTS) {
    it(`is refused for ${label}: exit 2, nothing is signed, nothing is recorded`, async () => {
      const r = await rig();
      r.signing.throwing = true;
      r.web.set(locatorOf('reorder-agent'), body);
      expect(await r.run(...SUBMIT)).toBe(2);
      expect(r.w.screen.errorText).toContain(words);
      nothingLanded(r);
      expect(r.w.facts().attestations).toEqual({});
      expect(Object.keys(r.w.state('attest').notes)).toEqual([]);
    });
  }
  it('names the document that is the canonical JSON of the manifest that the service serves NOW: a document for the old manifest is refused when the facts follow the new one', async () => {
    const r = await rig();
    r.signing.throwing = true;
    const url = `${agentOf('reorder-agent').endpoint}/agent.json`;
    r.web.set(url, '{"manifest":"the reorder agent, changed"}');
    const facts = FactsFile.open(join(r.w.stateDir, 'facts.json'), { useCase: 'inventory-reorder', network: 'vector-mainnet' });
    const changed = sha256('{"manifest":"the reorder agent, changed"}');
    facts.put('manifests', ['reorder-agent'], { uri: url, sha256: changed, bytes: 41, readAt: iso(NOW) }, { replace: true });
    expect(await r.run(...SUBMIT)).toBe(2);
    expect(r.w.screen.errorText).toContain('the manifest fact of reorder-agent does not agree with its recorded advert');
    nothingLanded(r);
    expect(r.contexts).toBe(0);
    advertFacts(facts, agentOf('reorder-agent'), changed, true);
    expect(await r.run(...SUBMIT)).toBe(2);
    expect(r.w.screen.errorText).toContain('is not the canonical JSON of the manifest');
    nothingLanded(r);
    r.signing.throwing = false;
    r.web.set(locatorOf('reorder-agent'), documentOf('reorder-agent', { manifest: '{"manifest":"the reorder agent, changed"}' }).text);
    expect(await r.run(...SUBMIT)).toBe(0);
  });
  for (const [label, change, words] of REFUSED) {
    it(`is refused for ${label}: exit 2, nothing is signed, nothing is recorded`, async () => {
      const r = await rig();
      r.signing.throwing = true;
      change(r, 'reorder-agent');
      expect(await r.run(...SUBMIT)).toBe(2);
      expect(r.w.screen.errorText).toContain(words);
      nothingLanded(r);
      expect(r.w.facts().attestations).toEqual({});
    });
  }

  const RUNTIMES: readonly (readonly [string, (r: Rig) => void, string])[] = [
    ['a runtime of the Reorder Agent that works', (r) => r.web.set(`${agentOf('reorder-agent').endpoint}/status`, () => Response.json({ status: 'working' })), 'a job runs'],
    ['a runtime of the Order Desk that works', (r) => r.web.set(agentOf('order-desk').statusUrls[1]!, () => Response.json({ status: 'working' })), 'a job runs'],
    ['a runtime that answers with status 500', (r) => r.web.set(agentOf('order-desk').statusUrls[2]!, () => new Response('down', { status: 500 })), 'cannot tell'],
    ['a runtime that answers with a body that is no JSON', (r) => r.web.set(agentOf('reorder-agent').statusUrls[0]!, 'free'), 'cannot tell'],
  ];
  for (const [label, change, words] of RUNTIMES) {
    it(`needs every runtime of the use case to say free: ${label} stops the step`, async () => {
      const r = await rig();
      r.signing.throwing = true;
      change(r);
      expect(await r.run(...SUBMIT)).toBe(2);
      expect(r.w.screen.errorText).toContain(words);
      nothingLanded(r);
    });
  }
  it('does not ask a runtime that does not run: only the container list decides', async () => {
    const r = await rig();
    r.running.delete('orders-medium-runtime');
    r.running.delete('orders-service');
    r.writeRunning();
    r.web.set(agentOf('order-desk').statusUrls[1]!, () => new Response('down', { status: 500 }));
    expect(await r.run(...SUBMIT)).toBe(0);
    expect(r.web.to(agentOf('order-desk').statusUrls[1]!)).toEqual([]);
  });

  it('needs the tag attestation in the approval: without it nothing is signed, and with it the step lands', async () => {
    const r = await rig();
    r.signing.throwing = true;
    r.go({ irreversible: [] });
    expect(await r.run(...SUBMIT)).toBe(2);
    expect(r.w.screen.errorText).toContain('attestation');
    nothingLanded(r);
    r.go();
    r.signing.throwing = false;
    expect(await r.run(...SUBMIT)).toBe(0);
  });
  it('asks no signature of the provider key when the approval does not list the tag attestation: the envelope step stops with exit 2 before it signs', async () => {
    const r = await rig();
    await land(r, 1);
    r.go({ irreversible: [] });
    r.signing.throwing = true;
    r.signing.signers.length = 0;
    r.signing.messages = 0;
    expect(await r.run(...SUBMIT)).toBe(2);
    expect(r.w.screen.errorText).toContain('irreversible tag attestation');
    expect(r.signing.messages).toBe(0);
    expect(r.signing.signers).toEqual([]);
    expect(r.node.submitted).toHaveLength(1);
    r.go();
    r.signing.throwing = false;
    expect(await r.run(...SUBMIT)).toBe(0);
    expect(r.signing.messages).toBe(1);
    expect(r.node.submitted).toHaveLength(2);
  });
  /** After a second run of a step that the facts hold: the words of the refusal, one transaction, one attestation on the ledger, and the first attestation in the facts. */
  const refusedAgain = (r: Rig, id: string): void => {
    expect(r.w.screen.errorText).toContain('already: an attestation of a step is made once');
    expect(r.node.submitted).toHaveLength(1);
    expect(attestationsOnLedger(r)).toBe(1);
    expect(r.w.facts().attestations['reorder-agent']?.provenance?.id).toBe(id);
  };
  it('makes an attestation of a step once: a run with another run label stops with exit 2 and makes no second transaction', async () => {
    const r = await rig();
    expect(await r.run(...SUBMIT)).toBe(0);
    const id = r.part('reorder-agent:provenance').refs.attestation_id!;
    r.signing.throwing = true;
    expect(await r.run(...SUBMIT, '--run', 'again')).toBe(2);
    refusedAgain(r, id);
  });
  it('makes an attestation of a step once: a run after the state file was moved away stops with exit 2 and makes no second transaction', async () => {
    const r = await rig();
    expect(await r.run(...SUBMIT)).toBe(0);
    const id = r.part('reorder-agent:provenance').refs.attestation_id!;
    rmSync(join(r.w.stateDir, 'attest.state.json'));
    r.signing.throwing = true;
    expect(await r.run(...SUBMIT)).toBe(2);
    refusedAgain(r, id);
  });
  it('needs the task in the approval', async () => {
    const r = await rig();
    r.signing.throwing = true;
    r.go({ tasks: ['toy'] });
    expect(await r.run(...SUBMIT)).toBe(2);
    nothingLanded(r);
  });
  it('in a dry run builds and checks the step, prints what it would sign, needs no approval, and signs and lands nothing', async () => {
    const r = await rig();
    rmSync(r.w.goPath);
    r.signing.throwing = true;
    expect(await r.run(...STEP_ARGV)).toBe(0);
    expect(r.w.machine()).toMatchObject({ outcome: 'dry', exit: 0, mode: 'dry' });
    nothingLanded(r);
    expect(r.loaded).toEqual([SIGNERS]);
    expect(r.w.screen.text).toContain('dry run: nothing was signed or submitted');
    expect(r.w.screen.text).toContain(`the document ${nameOf('reorder-agent')} at ${locatorOf('reorder-agent')} has the SHA-256 ${documentOf('reorder-agent').sha256}`);
    expect(r.w.screen.text).toContain('it is valid until');
    expect(r.hosted.calls).toEqual([]);
    expect(Object.keys(r.w.state('attest').notes)).toEqual([]);
    expect(r.w.facts().attestations).toEqual({});
  });
  it('in a dry run of the envelope step builds the first build only, and asks no key to sign', async () => {
    const r = await rig();
    await land(r, 1);
    r.signing.throwing = true;
    r.signing.signers.length = 0;
    r.signing.messages = 0;
    expect(await r.run(...STEP_ARGV)).toBe(0);
    expect(r.w.machine()).toMatchObject({ outcome: 'dry', step: 'reorder-agent:software' });
    expect(r.signing.messages).toBe(0);
    expect(r.signing.signers).toEqual([]);
    expect(r.w.screen.text).toContain('carries an envelope');
    expect(r.node.submitted).toHaveLength(1);
  });

  it('is refused when the fee wallet has no pure output of 5 units or more, and when it holds less than the deposit and the limit of the fee', async () => {
    const poor = await rig({ feeOutputs: [3_000_000n, 2_000_000n] });
    poor.signing.throwing = true;
    expect(await poor.run(...SUBMIT)).toBe(2);
    expect(poor.w.screen.errorText).toContain('has no pure output of 5 units or more');
    nothingLanded(poor);
    const small = await rig({ feeOutputs: [5_000_000n] });
    small.signing.throwing = true;
    expect(await small.run(...SUBMIT)).toBe(2);
    expect(small.w.screen.errorText).toContain('this step needs');
    nothingLanded(small);
  });
  it('is refused when the controller of the record is not the controller key: the signers differ from the planned signers, and nothing is signed', async () => {
    const r = await rig({ controllerOutside: true });
    r.signing.throwing = true;
    expect(await r.run(...SUBMIT)).toBe(2);
    expect(r.w.screen.errorText).toContain('the step expects');
    expect(r.w.screen.errorText).toContain('missing controller');
    nothingLanded(r);
  });
  it('is refused with no facts', async () => {
    const r = await rig({ noFacts: true });
    expect(await r.run(...SUBMIT)).toBe(2);
    expect(r.w.screen.errorText).toContain('the facts hold no record of reorder-agent');
    nothingLanded(r);
  });

  const BAD_BASES: readonly (readonly [string, string])[] = [
    ['a branch name in place of a commit', 'https://raw.githubusercontent.com/Apex-Fusion/vector-service-agents/main/docs/attestations/'],
    ['a short commit', `https://raw.githubusercontent.com/Apex-Fusion/vector-service-agents/${'e1'.repeat(10)}/docs/attestations/`],
    ['another host', `https://example.org/Apex-Fusion/vector-service-agents/${'e1'.repeat(20)}/docs/attestations/`],
    ['another repository', `https://raw.githubusercontent.com/Apex-Fusion/another-repository/${'e1'.repeat(20)}/docs/attestations/`],
    ['http', BASE.replace(/^https/, 'http')],
    ['no final slash', BASE.slice(0, -1)],
    ['another folder', BASE.replace(/attestations\/$/, 'evidence/')],
    ['a query', `${BASE}?x=1`],
    ['text after the folder', `${BASE}reorder-agent-0123456.json`],
  ];
  for (const [label, base] of BAD_BASES) {
    it(`is refused with --locator-base that is ${label}, before any read`, async () => {
      const r = await rig();
      expect(await r.run('run', '--commit', COMMIT, '--locator-base', base)).toBe(2);
      expect(r.web.calls).toEqual([]);
    });
  }
  for (const [label, argv] of [['--commit', ['run', '--locator-base', BASE]], ['--locator-base', ['run', '--commit', COMMIT]]] as const) {
    it(`needs ${label}, before any read`, async () => {
      const r = await rig();
      expect(await r.run(...argv)).toBe(2);
      expect(r.web.calls).toEqual([]);
    });
  }

  it('verifies each attestation with the hosted tool: a tool that shows another digest stops the run, and the next run verifies the step first and goes on', async () => {
    const r = await rig();
    const honest = r.hosted.handlers.vector_get_attestation!;
    r.hosted.handlers.vector_get_attestation = (args) => ({ ...honest(args), digest: 'aa'.repeat(32) });
    expect(await r.run(...SUBMIT)).toBe(1);
    expect(r.w.screen.errorText).toContain('the hosted tools do not show the step reorder-agent:provenance as it was made');
    expect(r.w.screen.errorText).toContain('its digest is not the SHA-256 of the document');
    expect(r.part('reorder-agent:provenance').verified_at ?? null).toBeNull();
    expect(r.w.facts().attestations['reorder-agent']?.provenance).toBeDefined();
    r.hosted.handlers.vector_get_attestation = honest;
    expect(await r.run(...SUBMIT)).toBe(0);
    expect(r.part('reorder-agent:provenance').verified_at).not.toBeNull();
    expect(r.node.submitted).toHaveLength(2);
  });
});

// ---- the envelope ----

describe('the envelope of the software attestation of the Reorder Agent', () => {
  const issuer = (r: Rig): string => r.w.keys.registry.publicKeyOf('provider');
  const fieldsOf = (r: Rig, d: AttestationDatum) => ({ issuer: issuer(r), issuerId: null, subject: RECORD_ID, issuedAt: d.issuedAt, format: 50, digest: d.digest });

  it('lands the second build: it carries the signature of the provider key over the Sig_structure, and the provider key signed those bytes and no others', async () => {
    const r = await rig();
    await land(r, 2);
    const d = r.datum(r.part('reorder-agent:software').refs.attestation_id!);
    expect(d.attType).toBe(ATT_TYPES.software);
    expect(d.envelopeSig).toMatch(/^[0-9a-f]{128}$/);
    expect(envelopeVerifies(fieldsOf(r, d), d.envelopeSig!)).toBe(true);
    expect(envelopeVerifies({ ...fieldsOf(r, d), issuer: r.w.keys.registry.publicKeyOf('controller') }, d.envelopeSig!)).toBe(false);
    expect(envelopeVerifies({ ...fieldsOf(r, d), issuedAt: d.issuedAt + 1_000 }, d.envelopeSig!)).toBe(false);
    expect(r.signing.messages).toBe(1);
    expect(r.signing.bytes).toEqual([envelopeSigStructure(fieldsOf(r, d))]);
    expect(factsOf(r.node.submitted[1]!).witnesses.sort()).toEqual(hashesOf(r, SIGNERS));
  });
  it('never lands the first build: of the two builds only the second is submitted, and both have the same issued_at', async () => {
    const r = await rig();
    await land(r, 1);
    seen.builds.length = 0;
    await land(r, 1);
    expect(seen.builds).toHaveLength(2);
    const [first, second] = seen.builds as [SeenBuild, SeenBuild];
    expect(first.envelopeSig).toBeNull();
    expect(second.envelopeSig).toMatch(/^[0-9a-f]{128}$/);
    expect(second.issuedAt).toBe(first.issuedAt);
    expect(first.txHash).not.toBe(second.txHash);
    const applied = r.world.chain.applied.map((signed) => r.world.hashOf(signed));
    expect(applied).toHaveLength(2);
    expect(applied[1]).toBe(second.txHash);
    expect(applied).not.toContain(first.txHash);
  });
  it('keeps the proof that the envelope is there: the state and the evidence say envelope true and hold the signature as a hash, and no file holds its bytes', async () => {
    const r = await rig();
    await land(r, 2);
    const part = r.part('reorder-agent:software');
    const d = r.datum(part.refs.attestation_id!);
    expect(part.facts).toMatchObject({ envelope: true, envelope_sig_sha256: sha256(Buffer.from(d.envelopeSig!, 'hex')) });
    expect(r.part('reorder-agent:provenance').facts.envelope).toBe(false);
    expect(r.part('reorder-agent:provenance').facts).not.toHaveProperty('envelope_sig_sha256');
    expect(r.w.facts().attestations['reorder-agent']?.software?.envelope).toBe(true);
    const confirmed = r.w.evidence('attest').find((entry) => entry.step === 'reorder-agent:software' && entry.status === 'confirmed');
    expect(confirmed).toMatchObject({ shows: { facts: { envelope: true } } });
    const verified = r.w.evidence('attest').find((entry) => entry.step === 'reorder-agent:software' && entry.status === 'verified');
    expect(JSON.stringify(verified)).toContain(`sha256:${sha256(Buffer.from(d.envelopeSig!, 'hex'))}`);
    expect(r.w.allText()).not.toContain(d.envelopeSig);
  });
  it('builds again from the first build, once, when the window of the first build ended before the second build: the attestation gets the new issued_at', async () => {
    const r = await rig();
    await land(r, 1);
    seen.builds.length = 0;
    r.contexts = 0;
    let jumped = 0;
    r.onContext = (count) => {
      if (count === 2) { r.w.clock.t += 40 * 60_000; jumped = r.w.clock.t; }
    };
    expect(await r.run(...SUBMIT)).toBe(0);
    expect(r.w.screen.text).toContain('starting again from the first build, once');
    expect(r.node.submitted).toHaveLength(2);
    expect(r.signing.messages).toBe(2);
    expect(seen.builds.map((built) => built.envelopeSig !== null)).toEqual([false, false, true]);
    const [stale, first, second] = seen.builds as [SeenBuild, SeenBuild, SeenBuild];
    expect(first.issuedAt).toBeGreaterThan(stale.issuedAt);
    expect(second.issuedAt).toBe(first.issuedAt);
    const d = r.datum(r.part('reorder-agent:software').refs.attestation_id!);
    expect(d.issuedAt).toBe(Math.floor(jumped / 1000) * 1000 + 30 * 60_000);
    expect(d.issuedAt).toBe(second.issuedAt);
    const applied = r.world.chain.applied.map((signed) => r.world.hashOf(signed));
    expect(applied[1]).toBe(second.txHash);
    expect(applied).not.toContain(stale.txHash);
    expect(applied).not.toContain(first.txHash);
    expect(envelopeVerifies(fieldsOf(r, d), d.envelopeSig!)).toBe(true);
    expect(r.signing.bytes.at(-1)).toBe(envelopeSigStructure(fieldsOf(r, d)));
  });
  it('stops when the window ended twice: nothing of that step is landed', async () => {
    const r = await rig();
    await land(r, 1);
    seen.builds.length = 0;
    r.contexts = 0;
    r.onContext = (count) => { if (count === 2 || count === 4) r.w.clock.t += 40 * 60_000; };
    expect(await r.run(...SUBMIT)).toBe(2);
    expect(r.w.screen.errorText).toContain('ended before the second build twice');
    expect(seen.builds.map((built) => built.envelopeSig)).toEqual([null, null]);
    expect(r.node.submitted).toHaveLength(1);
    expect(r.part('reorder-agent:provenance')).toBeDefined();
    expect(r.w.state('attest').notes['part.reorder-agent:software']).toBeUndefined();
  });
  it('is not for the other attestations: no other step asks the provider key to sign a message', async () => {
    const r = await rig();
    await land(r, 1);
    expect(r.signing.messages).toBe(0);
    expect(r.datum(r.part('reorder-agent:provenance').refs.attestation_id!).envelopeSig).toBeNull();
  });
});

// ---- the wait until the gateway lists the attestations ----

/** The gateway lists attestations of an agent: the identifier, the type and the digest of each, as the step made them. A member of `over` replaces what is listed. */
function listed(r: Rig, agent: AgentId, types: readonly (typeof TYPES)[number][], over: { digest?: string; type?: string } = {}): void {
  const entries = types.map((type) => {
    const part = r.part(`${agent}:${type}`);
    return { id: part.refs.attestation_id, type: over.type ?? type, issuer: 'did:key:z6Mktest', issuedAt: part.facts.issued_at, solicited: true, digest: over.digest ?? part.facts.digest, locator: part.facts.locator };
  });
  r.web.set(gatewayUrl(agent), () => resolution(entries));
}

describe('the steps visible', () => {
  it('wait until the gateway lists each attestation, and record each step that shows, one after the other', async () => {
    const r = await rig();
    expect(await r.run(...SUBMIT, '--all')).toBe(4);
    const confirmedAt = Date.parse(r.part('reorder-agent:provenance').confirmed_at);
    expect(r.w.screen.text).toContain('does not show in vectorProvenance of the DID document yet');
    expect(r.w.screen.text).toContain('about 2.5 min');
    expect(r.w.screen.text).toContain(`(until ${iso(confirmedAt + 150_000)})`);
    listed(r, 'reorder-agent', ['provenance']);
    r.w.screen.lines.length = 0;
    expect(await r.run(...STEP_ARGV)).toBe(0);
    expect(r.w.machine()).toMatchObject({ outcome: 'dry', step: 'visible:reorder-agent:provenance' });
    expect(r.w.state('attest').notes['part.visible:reorder-agent:provenance']).toBeUndefined();
    expect(await r.run(...SUBMIT, '--all')).toBe(4);
    expect(r.w.machine()).toMatchObject({ outcome: 'wait', step: 'visible:reorder-agent:software' });
    expect(r.part('visible:reorder-agent:provenance')).toMatchObject({ tx_hash: null, refs: { attestation_id: r.part('reorder-agent:provenance').refs.attestation_id } });
    expect(r.part('visible:reorder-agent:provenance').verified_at).not.toBeNull();
    listed(r, 'reorder-agent', TYPES);
    listed(r, 'order-desk', TYPES);
    expect(await r.run(...SUBMIT, '--all')).toBe(0);
    expect(r.w.machine()).toMatchObject({ outcome: 'finished', exit: 0 });
    for (const step of STEPS) expect(r.part(`visible:${step}`)).toBeDefined();
    expect(r.node.submitted).toHaveLength(4);
  });
  it('wait while the gateway cannot be read or has no record, fail 15 minutes after the confirmation, and record nothing', async () => {
    const r = await rig();
    expect(await r.run(...SUBMIT, '--all')).toBe(4);
    const confirmedAt = Date.parse(r.part('reorder-agent:provenance').confirmed_at);
    const url = gatewayUrl('reorder-agent');
    const ANSWERS: readonly (readonly [() => Response, string])[] = [
      [() => new Response('down', { status: 500 }), 'gateway.unavailable'], [() => { throw new TypeError('fetch failed'); }, 'gateway.unreachable'],
      [() => Response.json({ didDocumentMetadata: {} }, { status: 404 }), 'not_found'], [() => resolution([]), 'lists no attestation with this identifier'],
    ];
    for (const [answer, words] of ANSWERS) {
      r.web.set(url, answer);
      r.w.screen.lines.length = 0;
      expect(await r.run(...SUBMIT)).toBe(4);
      expect(r.w.screen.text).toContain(words);
    }
    r.w.clock.t = confirmedAt + 15 * 60_000 - 1_000;
    expect(await r.run(...SUBMIT)).toBe(4);
    r.w.clock.t = confirmedAt + 15 * 60_000;
    expect(await r.run(...SUBMIT)).toBe(1);
    expect(r.w.screen.errorText).toContain(r.part('reorder-agent:provenance').refs.attestation_id);
    expect(r.w.screen.errorText).toContain('does not show in vectorProvenance');
    expect(r.w.state('attest').notes['part.visible:reorder-agent:provenance']).toBeUndefined();
  });
  it('fail at once for a list that holds the identifier with another digest or another type, and do not take the same digest under another identifier', async () => {
    const r = await rig();
    expect(await r.run(...SUBMIT, '--all')).toBe(4);
    listed(r, 'reorder-agent', ['provenance'], { digest: sha256('another document') });
    expect(await r.run(...SUBMIT)).toBe(1);
    expect(r.w.screen.errorText).toContain('another type or another digest');
    listed(r, 'reorder-agent', ['provenance'], { type: 'software' });
    expect(await r.run(...SUBMIT)).toBe(1);
    listed(r, 'reorder-agent', ['provenance']);
    expect(await r.run(...SUBMIT, '--all')).toBe(4);
    expect(r.w.machine().step).toBe('visible:reorder-agent:software');
    expect(r.w.state('attest').notes['part.visible:reorder-agent:software']).toBeUndefined();
  });
});

// ---- the cleanup ----

/** Moves the clock and the tip of the chain to a time. */
function travel(r: Rig, ms: number): void {
  r.w.clock.t = ms;
  r.world.chain.tipSlot = Math.floor((ms - VECTOR_MAINNET.systemStartMs!) / 1000);
  // The approval of a session lasts six hours, so a run at the new time needs an approval that is valid then.
  r.go({ at: iso(ms), expiresAt: iso(ms + 6 * 3_600_000) });
}
const dueOf = (r: Rig, step: string): number => Date.parse(String(r.part(step).facts.valid_until)) + 90 * DAY;
const feeTotal = (r: Rig): bigint => r.world.chain.held.filter((output) => output.address === r.w.keys.registry.addressOf('fee')).reduce((sum, output) => sum + (output.assets.lovelace ?? 0n), 0n);

describe('the cleanup', () => {
  it('has nothing to take back when no attestation was made', async () => {
    const r = await rig();
    expect(await r.run('cleanup')).toBe(0);
    expect(r.w.screen.text).toContain('the facts hold no attestation');
    expect(r.node.submitted).toEqual([]);
  });
  it('says the date of each deposit that is not due, and withdraws each deposit one minute after its date and no sooner', async () => {
    const r = await rig();
    await land(r, 1);
    r.w.clock.t += 10_000;
    await land(r, 1);
    const [first, second] = [dueOf(r, 'reorder-agent:provenance'), dueOf(r, 'reorder-agent:software')] as const;
    expect(second).toBeGreaterThan(first);
    r.signing.throwing = true;
    r.signing.signers.length = 0;
    r.signing.messages = 0;
    travel(r, first - 1);
    r.w.screen.lines.length = 0;
    expect(await r.run('cleanup', '--submit')).toBe(0);
    expect(r.w.screen.text).toContain(`the deposit of the provenance attestation of reorder-agent is due on ${iso(first)}`);
    expect(r.w.screen.text).toContain(`the deposit of the software attestation of reorder-agent is due on ${iso(second)}`);
    travel(r, first + 59_000);
    expect(await r.run('cleanup', '--submit')).toBe(0);
    expect(r.signing.signers).toEqual([]);
    expect(r.node.submitted).toHaveLength(2);
    r.signing.throwing = false;
    const before = feeTotal(r);
    travel(r, first + 60_000);
    r.w.screen.lines.length = 0;
    expect(await r.run('cleanup', '--submit')).toBe(0);
    expect(r.node.submitted).toHaveLength(3);
    expect(r.w.screen.text).toContain('is back in the fee wallet');
    expect(r.w.screen.text).toContain(`the deposit of the software attestation of reorder-agent is due on ${iso(second)}`);
    expect(factsOf(r.node.submitted[2]!).witnesses.sort()).toEqual(hashesOf(r, ['provider', 'fee']));
    expect(feeTotal(r)).toBeGreaterThan(before + 4_000_000n);
    const id = r.part('reorder-agent:provenance').refs.attestation_id!;
    expect(r.world.chain.held.some((output) => output.assets[`${DEPLOYMENT.attestation.hash}${id}`] !== undefined)).toBe(false);
    expect(r.part('withdraw:reorder-agent:provenance').tx_hash).toBe(r.world.hashOf(r.node.submitted[2]!));
    travel(r, second + 60_000);
    r.w.screen.lines.length = 0;
    expect(await r.run('cleanup', '--submit')).toBe(0);
    expect(r.node.submitted).toHaveLength(4);
    expect(r.w.screen.text).toContain('the deposit of the provenance attestation of reorder-agent is back already');
    expect(r.world.chain.held.some((output) => Object.keys(output.assets).some((unit) => unit.startsWith(DEPLOYMENT.attestation.hash)))).toBe(false);
    expect(await r.run('cleanup', '--submit')).toBe(0);
    expect(r.node.submitted).toHaveLength(4);
  });
  it('in a dry run builds and checks the withdraw of a deposit that is due, and lands nothing', async () => {
    const r = await rig();
    await land(r, 1);
    travel(r, dueOf(r, 'reorder-agent:provenance') + 60_000);
    r.signing.throwing = true;
    r.signing.signers.length = 0;
    expect(await r.run('cleanup')).toBe(0);
    expect(r.w.machine()).toMatchObject({ command: 'cleanup', outcome: 'dry' });
    expect(r.w.screen.text).toContain('the withdraw is built and checked');
    expect(r.signing.signers).toEqual([]);
    expect(r.signing.messages).toBe(0);
    expect(r.node.submitted).toHaveLength(1);
  });
  it('is refused when the state file holds no output of the attestation, and when the fee wallet has no collateral', async () => {
    const r = await rig();
    await land(r, 1);
    travel(r, dueOf(r, 'reorder-agent:provenance') + 60_000);
    const feeAddress = r.w.keys.registry.addressOf('fee');
    const held = r.world.chain.held;
    r.world.chain.held = held.filter((output) => output.address !== feeAddress).concat([{ txHash: hashOf('a poor wallet'), outputIndex: 0, address: feeAddress, assets: { lovelace: 3_000_000n } }]);
    r.signing.throwing = true;
    r.signing.signers.length = 0;
    expect(await r.run('cleanup', '--submit')).toBe(2);
    expect(r.w.screen.errorText).toContain('has no pure output of 5 units or more');
    r.world.chain.held = held;
    const path = join(r.w.stateDir, 'attest.state.json');
    const state = JSON.parse(readFileSync(path, 'utf8')) as { notes: Record<string, { refs: Record<string, string> }> };
    delete state.notes['part.reorder-agent:provenance']!.refs.attestation_output;
    writeFileSync(path, JSON.stringify(state), { mode: 0o600 });
    expect(await r.run('cleanup', '--submit')).toBe(2);
    expect(r.w.screen.errorText).toContain('holds no output of the provenance attestation of reorder-agent');
    expect(r.signing.signers).toEqual([]);
    expect(r.node.submitted).toHaveLength(1);
  });
});

// ---- the sources ----

describe('the sources of the pack', () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const sources = (folder: string): string[] => readdirSync(join(root, folder), { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? sources(`${folder}/${entry.name}`) : [`${folder}/${entry.name}`]));
  it('call signMessage in tasks/attest.ts only, and once', () => {
    const files = [...sources('lib'), ...sources('tasks'), ...sources('usecases'), 'cli.ts'];
    expect(files).toContain('tasks/attest.ts');
    expect(files.filter((file) => readFileSync(join(root, file), 'utf8').includes('signMessage'))).toEqual(['tasks/attest.ts']);
    expect(readFileSync(join(root, 'tasks/attest.ts'), 'utf8').match(/\.signMessage\(/g)).toHaveLength(1);
  });
});
