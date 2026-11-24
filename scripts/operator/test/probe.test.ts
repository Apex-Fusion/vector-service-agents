// The task probe and the token request of lib/gateway-token.ts: one request to the gateway under a named delegation, with a named key, and a record of what the gateway answers. The gateway is the
// stub gateway of id-kit (it issues tokens, and refuses a delegation that ended, with the text of the real gateway), the keys are the keys of the registry of use case 1 (made at run time), and the
// delegation is made on the stub and as an output on the chain of the fixtures, so that the probe reads it as it would on the ledger. Each refusal has an accepted twin. No token, no proof and no
// subject token that crosses the wire is found in anything that the probe prints or writes: the test collects them from the `fetch` and searches for them.
import { createPublicKey } from 'node:crypto';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { iso } from '../../checks/lib/format.ts';
import { delegation, delegationUtxo } from '../../../packages/buyer-core/test/fixtures/escrow-identity.fixture.ts';
import { resolveKey } from '../../../packages/id-kit/src/index.ts';
import { createStubGateway, ed25519Key } from '../../../packages/id-kit/src/testing/index.ts';
import type { StubAgent, StubDelegation, StubGateway, TestKey } from '../../../packages/id-kit/src/testing/index.ts';
import { utf8Hex } from '../../../packages/vector-read/src/identity-codec.ts';
import { DAY, DEPLOYMENT } from '../../checks/test/support/world.ts';
import type { TaskFlags } from '../lib/contract.ts';
import { FactsFile } from '../lib/facts.ts';
import { askForToken } from '../lib/gateway-token.ts';
import { loadRegistry } from '../lib/registry.ts';
import type { KeySpec, Registry } from '../lib/registry.ts';
import { runTask } from '../lib/runner.ts';
import { parseOperatorSettings } from '../lib/settings.ts';
import probe from '../tasks/probe.ts';
import USE from '../usecases/inventory-reorder.ts';
import { NOW, USE_CASE, hashOf, taskWorld } from './support/task-world.ts';
import type { TaskWorld } from './support/task-world.ts';

const NAMES = USE.keys.map((spec) => spec.name);
const SHARED = USE.keys.filter((spec) => spec.scope === 'shared').map((spec) => spec.name);
const ACTION = 'po.write';
const RESOURCE = 'https://mock.test/t/trial/po';
const KEY_1 = 'reorder-delegation-1';
const KEY_2 = 'reorder-delegation-2';

/** A key of the registry as a key of the stub gateway: the same key, so that the stub verifies what the probe signs. */
function testKeyOf(registry: Registry, name: string): TestKey {
  const privateKey = registry.key(name).jwsKey();
  const resolved = resolveKey(privateKey);
  return { kind: 'Ed25519', privateKey, publicKey: createPublicKey(privateKey), jwk: resolved.jwk, publicKeyHex: resolved.publicKey, keyHash: resolved.keyHash, thumbprint: resolved.thumbprint };
}

interface ProbeWorld {
  readonly w: TaskWorld;
  readonly gateway: StubGateway;
  readonly agent: StubAgent;
  /** Every token, proof and subject token that crossed the wire: the strings that nothing may print or write. */
  readonly wire: string[];
  /** What was asked of the signing parts, of the node and of the hosted tools. */
  readonly asked: string[];
  readonly fetchImpl: typeof fetch;
  /** A delegation to the agent with the delegate key of the registry that `key` names: on the stub and on the chain. */
  delegate(key?: string): StubDelegation;
  /** An Undelegate: the stub and the chain lose the delegation. */
  end(made: StubDelegation): void;
  /** The arguments of a good probe of this delegation, with the members that `over` changes (a null removes the flag). */
  args(made: StubDelegation | string, over?: Record<string, string | null>): string[];
  run(...argv: string[]): Promise<number>;
  text(): string;
  entries(): Array<Record<string, unknown>>;
  /** The text of every file that the run wrote. */
  everything(): string;
}

async function world(over: { record?: boolean } = {}): Promise<ProbeWorld> {
  const w = await taskWorld({ keys: NAMES, shared: SHARED, use: USE });
  const registry = w.keys.registry;
  const gateway = createStubGateway({ now: () => w.clock.now() });
  const auth = testKeyOf(registry, 'reorder-service');
  const first = testKeyOf(registry, KEY_1);
  const second = testKeyOf(registry, KEY_2);
  const agent = gateway.createAgent({ label: 'reorder-agent', authentication: auth, delegation: first, keys: [{ key: auth, purposes: 1 + 8 }, { key: first, purposes: 16 }, { key: second, purposes: 16 }] });
  if (over.record !== false) {
    const facts = FactsFile.open(join(w.stateDir, 'facts.json'), { useCase: USE_CASE, network: 'vector-mainnet' });
    facts.put('records', ['reorder-agent'], { did: agent.did, id: agent.id, tx: hashOf('record'), recordRef: `${hashOf('record')}#0`, depositLovelace: '10000000', registeredAt: iso(NOW) });
  }
  const wire: string[] = [];
  const asked: string[] = [];
  const refuse = (what: string) => (): never => { asked.push(what); throw new Error(`${what} was asked`); };
  const fetchImpl: typeof fetch = async (input, init) => {
    if (!String(input).startsWith(gateway.baseUrl)) throw new Error('the network was touched');
    const proof = new Headers(init?.headers).get('dpop');
    if (proof !== null) wire.push(proof);
    const subject = typeof init?.body === 'string' ? new URLSearchParams(init.body).get('subject_token') : null;
    if (subject !== null) wire.push(subject);
    const response = await gateway.fetch(input, init);
    const body: unknown = await response.clone().json().catch(() => null);
    if (typeof body === 'object' && body !== null && 'access_token' in body && typeof body.access_token === 'string') wire.push(body.access_token);
    return response;
  };
  const readRegistry = (options: { dir: string; useCase: string; specs: readonly KeySpec[]; need: readonly string[] }): Registry => {
    const loaded = loadRegistry(options);
    loaded.ring.sign = refuse('the ring');
    for (const name of loaded.names()) {
      loaded.key(name).signTransaction = refuse(`the key ${name} for a transaction`);
      loaded.key(name).signMessage = refuse(`the key ${name} for a message`);
    }
    return loaded;
  };
  w.node.submit = async () => refuse('the node to submit')();
  const hosted = { call: async (name: string) => refuse(`the hosted tool ${name}`)() };
  return {
    w, gateway, agent, wire, asked, fetchImpl,
    delegate: (key = KEY_1) => {
      const made = gateway.delegate({
        delegator: { principalKey: ed25519Key('member') }, delegate: agent, delegateKey: key === KEY_1 ? first : second, actions: [ACTION], resources: [RESOURCE],
      });
      const datum = delegation({
        delegate: agent.id, delegateKey: registry.hashOf(key), actions: [utf8Hex(ACTION)], resources: [utf8Hex(RESOURCE)], notBefore: NOW - 3_600_000, notAfter: NOW + DAY, remaining: 0, value: null,
      });
      w.world.chain.held.push({ ...delegationUtxo(datum, made.id), txHash: hashOf(`delegation ${made.id}`) });
      return made;
    },
    end: (made) => {
      gateway.endDelegation(made);
      w.world.chain.held = w.world.chain.held.filter((utxo) => utxo.assets[`${DEPLOYMENT.delegation.hash}${made.id}`] === undefined);
    },
    args: (made, changes = {}) => {
      const given = {
        run: 'r2', agent: 'reorder-agent', key: KEY_1, delegation: typeof made === 'string' ? made : made.id, resource: RESOURCE, action: ACTION, expect: 'granted', ...changes,
      };
      return Object.entries(given).flatMap(([name, value]) => (value === null ? [] : [`--${name}`, value]));
    },
    run: (...argv) => runTask(probe, argv, w.deps({ fetchImpl, readRegistry, hosted })),
    text: () => w.screen.lines.join('\n'),
    entries: () => w.evidence('probe', 'r2'),
    everything: () => w.allText(),
  };
}

const flags = (values: Record<string, string>): TaskFlags => ({ has: (name) => name in values, value: (name) => values[name] });
const errors = (p: ProbeWorld): string => p.w.screen.errors.join('\n');
/** The requests of the probe that reached the gateway. */
const tokenRequests = (p: ProbeWorld): number => p.gateway.requests.filter((request) => request.path === '/token').length;
/** The observation of an entry of the evidence: the entry must hold one. */
function observationOf(entry: Record<string, unknown> | undefined): Record<string, unknown> {
  const shows = entry?.shows;
  if (typeof shows !== 'object' || shows === null || !('observation' in shows) || typeof shows.observation !== 'object' || shows.observation === null) throw new Error('the entry holds no observation');
  return { ...shows.observation };
}

describe('the definition', () => {
  it('lists the six valued flags and no boolean flag, needs no approval, reads the chain, calls no hosted tool, and has the one step run', () => {
    expect(probe).toMatchObject({ name: 'probe', flags: [], valued: ['agent', 'key', 'delegation', 'resource', 'action', 'expect'], needs: { chain: true, hosted: [], approval: 'never' } });
    expect(probe.steps(USE, flags({}))).toEqual(['run']);
  });
  it('loads the service key of the agent and the delegation key that --key names, and no other key', () => {
    expect(probe.needs.keys(USE, flags({ key: KEY_2 }))).toEqual(['reorder-service', KEY_2]);
    expect(probe.needs.keys(USE, flags({ key: KEY_1, agent: 'reorder-agent' }))).toEqual(['reorder-service', KEY_1]);
    expect(probe.needs.keys(USE, flags({}))).toEqual(['reorder-service']);
  });
});

describe('a granted token and the refusal that follows the end of the delegation', () => {
  it('makes a control request that the gateway grants, and records only the type, the end and the grant of the token, with the arguments by name', async () => {
    const p = await world();
    const made = p.delegate();
    expect(await p.run(...p.args(made), '--submit')).toBe(0);
    expect(p.text()).toContain(`the delegation is live on the chain; it ends ${iso(NOW + DAY)}`);
    expect(p.text()).toContain('the gateway granted a token of the type DPoP');
    expect(p.text()).toContain('verdict: expected granted, observed granted');
    const [entry] = p.entries();
    expect(p.entries()).toHaveLength(1);
    expect(entry).toMatchObject({
      step: 'run', status: 'info',
      shows: {
        probe: { agent: 'reorder-agent', key: KEY_1, delegation: made.id, resource: RESOURCE, action: ACTION, expect: 'granted' },
        delegation: { state: 'live', delegate: p.agent.id, delegateKey: p.w.keys.registry.hashOf(KEY_1) },
        observation: { kind: 'granted', tokenType: 'DPoP' },
        verdict: { expected: 'granted', observed: 'granted', ok: true },
      },
    });
    const observation = observationOf(entry);
    expect(Object.keys(observation).sort()).toEqual(['authorizationDetails', 'expiresAt', 'kind', 'tokenType']);
    expect(observation.authorizationDetails).toEqual([expect.objectContaining({ identifier: made.id, actions: [ACTION], locations: [RESOURCE] })]);
    expect(observation.expiresAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(p.w.machine()).toMatchObject({ task: 'probe', command: 'run', mode: 'submit', outcome: 'done', exit: 0, step: 'run' });
    expect(p.w.machine().result).toMatchObject({ agent: 'reorder-agent', key: KEY_1, delegation: made.id, expect: 'granted', observed: 'granted', ok: true, delegationState: 'live' });
  });
  it('then records the refusal of the same request after the delegation ended: status 400, the code and the text of the gateway, and the delegation as ended on the chain', async () => {
    const p = await world();
    const made = p.delegate();
    expect(await p.run(...p.args(made), '--submit')).toBe(0);
    p.end(made);
    expect(await p.run(...p.args(made, { expect: 'refused' }), '--submit')).toBe(0);
    expect(p.text()).toContain('the delegation is not on the chain: it ended');
    expect(p.text()).toContain(`the gateway refused the request: status 400, error invalid_authorization_details, text "delegation ${made.id} was undelegated"`);
    const entries = p.entries();
    expect(entries).toHaveLength(2);
    expect(entries[1]).toMatchObject({
      shows: {
        probe: { expect: 'refused' }, delegation: { state: 'ended' },
        observation: { kind: 'refused', status: 400, error: 'invalid_authorization_details', text: `delegation ${made.id} was undelegated` },
        verdict: { expected: 'refused', observed: 'refused', ok: true },
      },
    });
    expect(p.w.machine().result).toMatchObject({ expect: 'refused', observed: 'refused', ok: true, status: 400, error: 'invalid_authorization_details', delegationState: 'ended' });
  });
  it('records no step: the control request and the later request of one run label both run, and the state holds no step', async () => {
    const p = await world();
    const made = p.delegate();
    for (let count = 0; count < 3; count += 1) expect(await p.run(...p.args(made), '--submit')).toBe(0);
    expect(p.entries()).toHaveLength(3);
    expect(p.w.state('probe', 'r2')).toMatchObject({ steps: {}, in_flight: null });
    expect(tokenRequests(p)).toBe(3);
  });
  it('makes the request in a dry run too, and writes no entry of the evidence: only --submit writes it', async () => {
    const p = await world();
    const made = p.delegate();
    expect(await p.run(...p.args(made))).toBe(0);
    expect(tokenRequests(p)).toBe(1);
    expect(p.entries()).toEqual([]);
    expect(p.text()).toContain('the evidence file was not written: this is a dry run, and --submit writes the entry');
    expect(p.w.machine()).toMatchObject({ mode: 'dry', outcome: 'done', exit: 0 });
    expect(await p.run(...p.args(made), '--submit')).toBe(0);
    expect(p.entries()).toHaveLength(1);
    expect(p.text()).toContain('the evidence file got the entry');
  });
  it('sends one request for the delegation, the key, the action and the resource that were named, and for no other: the grant of the token is narrowed to them', async () => {
    const p = await world();
    const one = p.delegate(KEY_1);
    const two = p.delegate(KEY_2);
    expect(await p.run(...p.args(two, { key: KEY_2 }))).toBe(0);
    const requests = p.gateway.requests.filter((request) => request.path === '/token');
    expect(requests).toHaveLength(1);
    const form = new URLSearchParams(requests[0]!.body);
    expect(JSON.parse(form.get('authorization_details')!)).toEqual([expect.objectContaining({ identifier: two.id, actions: [ACTION], locations: [RESOURCE] })]);
    expect(form.getAll('resource')).toEqual([RESOURCE]);
    expect(requests[0]!.body).not.toContain(one.id);
  });
});

describe('what the probe never stores or prints', () => {
  it('finds no token, no proof and no subject token that crossed the wire in the screen, the state, the evidence or the machine line, and no seed', async () => {
    const p = await world();
    const made = p.delegate();
    await p.run(...p.args(made), '--submit');
    p.end(made);
    await p.run(...p.args(made, { expect: 'refused' }), '--submit');
    await p.run('status', '--run', 'r2');
    expect(p.wire.length).toBeGreaterThanOrEqual(5);
    const text = p.everything();
    for (const secret of p.wire) expect(text).not.toContain(secret);
    for (const name of NAMES) expect(text).not.toContain(p.w.keys.seedOf(name));
    expect(text).not.toMatch(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\./);
    expect(p.asked).toEqual([]);
  });
  it('removes a token-like text from the text of a refusal, in the screen and in the evidence, and still judges the refusal by its whole text', async () => {
    const p = await world();
    const made = p.delegate();
    p.end(made);
    const jwt = ['eyJhbGciOiJFZERTQSJ9', 'eyJzdWIiOiJ4In0', 'c2lnbmF0dXJl'].join('.');
    p.gateway.fault('/token', { status: 400, body: JSON.stringify({ error: 'invalid_authorization_details', error_description: `delegation ${made.id} was undelegated (the proof ${jwt} was read)` }) });
    expect(await p.run(...p.args(made, { expect: 'refused' }), '--submit')).toBe(0);
    expect(p.everything()).not.toContain(jwt);
    expect(p.text()).toContain(`text "delegation ${made.id} was undelegated (the proof [a token was removed] was read)"`);
  });
  it('signs no transaction: no key, no ring, no node and no hosted tool is asked, and the node gets nothing', async () => {
    const p = await world();
    const made = p.delegate();
    await p.run(...p.args(made), '--submit');
    expect(p.asked).toEqual([]);
    expect(p.w.node.submitted).toEqual([]);
    expect(p.w.world.chain.applied).toEqual([]);
  });
});

describe('a request that does not turn out as expected', () => {
  it('exits 1 when the delegation is live and the probe expected a refusal, and says so in the evidence; with the right expectation it exits 0', async () => {
    const p = await world();
    const made = p.delegate();
    expect(await p.run(...p.args(made, { expect: 'refused' }), '--submit')).toBe(1);
    expect(errors(p)).toContain('probe failed: the probe expected the gateway to refuse the request, and the gateway granted a token');
    expect(p.entries()[0]).toMatchObject({ shows: { observation: { kind: 'granted' }, verdict: { expected: 'refused', observed: 'granted', ok: false } } });
    expect(p.w.machine()).toMatchObject({ outcome: 'failed', exit: 1, step: 'run' });
    expect(await p.run(...p.args(made), '--submit')).toBe(0);
  });
  it('exits 1 when the delegation ended and the probe expected a token, and the evidence holds the refusal; with the right expectation it exits 0', async () => {
    const p = await world();
    const made = p.delegate();
    p.end(made);
    expect(await p.run(...p.args(made), '--submit')).toBe(1);
    expect(p.entries()[0]).toMatchObject({ shows: { observation: { kind: 'refused', status: 400 }, verdict: { expected: 'granted', observed: 'refused', ok: false } } });
    expect(await p.run(...p.args(made, { expect: 'refused' }), '--submit')).toBe(0);
  });
  it('does not call a refusal a success when its text does not say that the delegation was undelegated: a delegation that does not exist, an action that it does not cover', async () => {
    const p = await world();
    const none = 'f0'.repeat(32);
    expect(await p.run(...p.args(none, { expect: 'refused' }), '--submit')).toBe(1);
    expect(p.entries()[0]).toMatchObject({ shows: { delegation: { state: 'ended' }, observation: { kind: 'refused', status: 400, text: `delegation ${none} does not exist` }, verdict: { ok: false } } });
    const live = await world();
    const made = live.delegate();
    expect(await live.run(...live.args(made, { expect: 'refused', action: 'po.read' }), '--submit')).toBe(1);
    expect(live.entries()[0]).toMatchObject({ shows: { observation: { kind: 'refused', error: 'invalid_authorization_details' }, verdict: { ok: false } } });
  });
  it('does not call a refusal a success when its status or its code is not the one that the ended delegation gives', async () => {
    for (const [label, status, error] of [['another status', 403, 'invalid_authorization_details'], ['another code', 400, 'invalid_request']] as const) {
      const p = await world();
      const made = p.delegate();
      p.end(made);
      p.gateway.fault('/token', { status, body: JSON.stringify({ error, error_description: `delegation ${made.id} was undelegated` }) });
      expect(await p.run(...p.args(made, { expect: 'refused' }), '--submit'), label).toBe(1);
      expect(p.entries()[0], label).toMatchObject({ shows: { observation: { kind: 'refused', status, error }, verdict: { expected: 'refused', ok: false } } });
    }
  });
  it('does not take a token for another delegation, another action or another resource than the ones named as the grant that was asked for', async () => {
    const other = 'ab'.repeat(32);
    const grants: Array<[string, Array<Record<string, unknown>> | null]> = [
      ['another delegation', [{ identifier: other, actions: [ACTION], locations: [RESOURCE] }]],
      ['another action', [{ identifier: 'ID', actions: ['po.read'], locations: [RESOURCE] }]],
      ['another resource', [{ identifier: 'ID', actions: [ACTION], locations: ['https://mock.test/other'] }]],
      ['two grants', [{ identifier: 'ID', actions: [ACTION], locations: [RESOURCE] }, { identifier: 'ID', actions: [ACTION], locations: [RESOURCE] }]],
      ['no grant', null],
    ];
    for (const [label, details] of grants) {
      const p = await world();
      const made = p.delegate();
      const body = { access_token: 'a.b.c', token_type: 'DPoP', issued_token_type: 'urn:ietf:params:oauth:token-type:access_token', expires_in: 60, ...(details === null ? {} : { authorization_details: details.map((detail) => ({ ...detail, identifier: detail.identifier === 'ID' ? made.id : detail.identifier })) }) };
      p.gateway.fault('/token', { status: 200, body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
      expect(await p.run(...p.args(made), '--submit'), label).toBe(1);
      expect(p.entries()[0], label).toMatchObject({ shows: { verdict: { expected: 'granted', ok: false } } });
    }
  });
  it('exits 1 for an answer that is neither a token nor a refusal, whatever was expected', async () => {
    for (const expectation of ['granted', 'refused']) {
      const p = await world();
      const made = p.delegate();
      p.gateway.fault('/token', { status: 200, body: '{}', headers: { 'content-type': 'application/json' } });
      expect(await p.run(...p.args(made, { expect: expectation }), '--submit'), expectation).toBe(1);
      expect(p.entries()[0], expectation).toMatchObject({ shows: { observation: { kind: 'unreadable', status: 200 }, verdict: { ok: false } } });
    }
  });
});

describe('a gateway that does not answer', () => {
  it('exits 3 when the gateway cannot be reached, and records the attempt with --submit; the request goes through when the gateway answers', async () => {
    const p = await world();
    const made = p.delegate();
    p.gateway.fault('/token', 'network');
    expect(await p.run(...p.args(made), '--submit')).toBe(3);
    expect(errors(p)).toContain('the gateway cannot be reached');
    expect(p.entries()[0]).toMatchObject({ shows: { observation: { kind: 'unreachable' }, verdict: { ok: false } } });
    expect(p.w.machine()).toMatchObject({ outcome: 'stopped', exit: 3 });
    p.gateway.fault('/token', null);
    expect(await p.run(...p.args(made), '--submit')).toBe(0);
  });
  it('exits 3 when the gateway says that it cannot answer now (503 and 429), and writes no entry in a dry run', async () => {
    for (const status of [503, 429]) {
      const p = await world();
      const made = p.delegate();
      p.gateway.fault('/token', { status, body: JSON.stringify({ error: 'temporarily_unavailable', error_description: 'try later' }), headers: { 'content-type': 'application/json' } });
      expect(await p.run(...p.args(made)), String(status)).toBe(3);
      expect(errors(p), String(status)).toContain('the gateway cannot answer now');
      expect(p.entries(), String(status)).toEqual([]);
    }
  });
});

describe('the arguments', () => {
  it('refuses a missing --run, and each missing flag, with exit 2 before any request; the full list passes', async () => {
    const p = await world();
    const made = p.delegate();
    expect(await p.run(...p.args(made, { run: null }))).toBe(2);
    expect(errors(p)).toContain('probe needs --run');
    for (const name of ['key', 'delegation', 'resource', 'action', 'expect']) {
      expect(await p.run(...p.args(made, { [name]: null })), name).toBe(2);
      expect(errors(p), name).toContain(`probe needs --${name}`);
    }
    expect(tokenRequests(p)).toBe(0);
    expect(await p.run(...p.args(made))).toBe(0);
    expect(tokenRequests(p)).toBe(1);
  });
  it('refuses a key that is no delegation key of the agent, with exit 2 and no request: the service key, a supplier key, the key of a subagent, a name that does not exist; a delegation key passes', async () => {
    const p = await world();
    const made = p.delegate();
    for (const key of ['reorder-service', 'reorder-supplier', 'stock-reader-delegation', 'accountable-alfa', 'nobody']) {
      expect(await p.run(...p.args(made, { key })), key).toBe(2);
      expect(errors(p), key).toContain('--key is a delegation key of the agent reorder-agent');
    }
    expect(tokenRequests(p)).toBe(0);
    expect(await p.run(...p.args(made, { key: KEY_1 }))).toBe(0);
  });
  it('refuses an agent that the use case does not list, and an agent that has no delegation key, with exit 2; the agent with delegation keys passes', async () => {
    const p = await world();
    const made = p.delegate();
    expect(await p.run(...p.args(made, { agent: 'nobody' }))).toBe(2);
    expect(errors(p)).toContain('--agent is one of reorder-agent, order-desk');
    expect(await p.run(...p.args(made, { agent: 'order-desk' }))).toBe(2);
    expect(errors(p)).toContain('--key is a delegation key of the agent order-desk: it has none');
    expect(tokenRequests(p)).toBe(0);
    expect(await p.run(...p.args(made, { agent: 'reorder-agent' }))).toBe(0);
  });
  it('refuses a delegation that is not 64 lower-case hex characters, an --expect that is not granted or refused, a resource that is no URI, a resource with a fragment and an action that is no action', async () => {
    const p = await world();
    const made = p.delegate();
    const bad: Array<[string, string, string]> = [
      ['delegation', 'AB'.repeat(32), '--delegation'], ['delegation', 'ab'.repeat(31), '--delegation'], ['expect', 'allowed', '--expect'], ['resource', 'not a uri', '--resource'],
      ['resource', `${RESOURCE}#part`, '--resource'], ['action', 'Not An Action', '--action'], ['action', '', '--action'],
    ];
    for (const [name, value, flag] of bad) {
      expect(await p.run(...p.args(made, { [name]: value })), `${name} ${value}`).toBe(2);
      expect(errors(p), `${name} ${value}`).toContain(flag);
    }
    expect(tokenRequests(p)).toBe(0);
    expect(await p.run(...p.args(made))).toBe(0);
  });
  it('refuses when the facts hold no record of the agent, and sends no request; with the record it passes', async () => {
    const missing = await world({ record: false });
    const made = missing.delegate();
    expect(await missing.run(...missing.args(made))).toBe(2);
    expect(errors(missing)).toContain('the facts hold no record of the agent reorder-agent');
    expect(tokenRequests(missing)).toBe(0);
    const present = await world();
    expect(await present.run(...present.args(present.delegate()))).toBe(0);
  });
  it('refuses when the node is not on the network of the run, and sends no request; on the right network it passes', async () => {
    const p = await world();
    const made = p.delegate();
    p.w.node.facts = { ...p.w.node.facts, magic: 1 };
    expect(await p.run(...p.args(made))).toBe(2);
    expect(errors(p)).toContain('network');
    expect(tokenRequests(p)).toBe(0);
    p.w.node.facts = { ...p.w.node.facts, magic: 764_824_073 };
    expect(await p.run(...p.args(made))).toBe(0);
  });
  it('refuses a live delegation that names another delegate key than --key, or another delegate than the agent, and sends no request; the delegation of the named key passes', async () => {
    const p = await world();
    const made = p.delegate(KEY_2);
    expect(await p.run(...p.args(made, { key: KEY_1 }))).toBe(2);
    expect(errors(p)).toContain('the live delegation names another delegate key than reorder-delegation-1');
    const stranger = await world();
    const owned = stranger.delegate();
    const datum = stranger.w.world.chain.held.find((utxo) => utxo.assets[`${DEPLOYMENT.delegation.hash}${owned.id}`] !== undefined)!;
    stranger.w.world.chain.held = stranger.w.world.chain.held.map((utxo) => (utxo === datum ? { ...delegationUtxo(delegation({ delegate: 'c9'.repeat(32), delegateKey: stranger.w.keys.registry.hashOf(KEY_1) }), owned.id), txHash: datum.txHash } : utxo));
    expect(await stranger.run(...stranger.args(owned))).toBe(2);
    expect(errors(stranger)).toContain('the live delegation names another delegate than the agent reorder-agent');
    expect(tokenRequests(p) + tokenRequests(stranger)).toBe(0);
    expect(await p.run(...p.args(made, { key: KEY_2 }))).toBe(0);
  });
});

describe('status and cleanup', () => {
  it('shows the requests that the evidence holds, each with what was expected and what was observed', async () => {
    const p = await world();
    const made = p.delegate();
    await p.run(...p.args(made), '--submit');
    p.end(made);
    await p.run(...p.args(made, { expect: 'refused' }), '--submit');
    p.w.screen.lines.length = 0;
    expect(await p.run('status', '--run', 'r2')).toBe(0);
    expect(p.text()).toContain('requests that the evidence holds: 2');
    expect(p.text()).toMatch(/request 1 at \S+: expected granted, observed granted: as expected/);
    expect(p.text()).toMatch(/request 2 at \S+: expected refused, observed refused \(status 400\): as expected/);
  });
  it('says for cleanup that the probe holds nothing that can be taken back, exits 0 and sends no request', async () => {
    const p = await world();
    expect(await p.run('cleanup', '--run', 'r2')).toBe(0);
    expect(p.text()).toContain('the probe makes no transaction and holds nothing: there is nothing to take back');
    expect(tokenRequests(p)).toBe(0);
  });
});

describe('the token request of lib/gateway-token.ts', () => {
  async function askWorld(): Promise<{ p: ProbeWorld; made: StubDelegation; ask: Parameters<typeof askForToken>[1]; host: Parameters<typeof askForToken>[0] }> {
    const p = await world();
    const made = p.delegate();
    const settings = parseOperatorSettings(p.w.env);
    const host = { registry: p.w.keys.registry, settings, fetchImpl: p.fetchImpl, clock: p.w.clock };
    return { p, made, host, ask: { did: p.agent.did, subjectKey: 'reorder-service', dpopKey: KEY_1, delegation: made.id, action: ACTION, resource: RESOURCE } };
  }

  it('gives a granted answer that holds the type, the end and the grant and no token: the members of the answer are these, and no text of it is the token', async () => {
    const { p, host, ask } = await askWorld();
    const answer = await askForToken(host, ask);
    expect(answer.kind).toBe('granted');
    expect(Object.keys(answer).sort()).toEqual(['authorizationDetails', 'expiresAt', 'kind', 'tokenType']);
    for (const secret of p.wire) expect(JSON.stringify(answer)).not.toContain(secret);
    expect(p.wire.length).toBeGreaterThanOrEqual(3);
  });
  it('gives the refusal of the gateway for a request that signs the proof with the wrong key: the key that signs the subject token and the key of the proof are not exchangeable', async () => {
    const { host, ask } = await askWorld();
    const swapped = await askForToken(host, { ...ask, subjectKey: KEY_1, dpopKey: 'reorder-service' });
    expect(swapped.kind).toBe('refused');
    const other = await askForToken(host, { ...ask, dpopKey: KEY_2 });
    expect(other).toMatchObject({ kind: 'refused', status: 400, error: 'invalid_authorization_details' });
    expect((await askForToken(host, ask)).kind).toBe('granted');
  });
  it('gives each failure of the gateway as its own kind: a refusal, no answer, a 503, and a body that is no token', async () => {
    const { p, host, ask } = await askWorld();
    p.gateway.fault('/token', { status: 400, body: JSON.stringify({ error: 'invalid_request', error_description: 'a reason' }), headers: { 'content-type': 'application/json' } });
    expect(await askForToken(host, ask)).toEqual({ kind: 'refused', status: 400, error: 'invalid_request', text: 'a reason' });
    p.gateway.fault('/token', 'network');
    expect((await askForToken(host, ask)).kind).toBe('unreachable');
    p.gateway.fault('/token', { status: 503, body: '{}', headers: { 'content-type': 'application/json' } });
    expect(await askForToken(host, ask)).toMatchObject({ kind: 'unavailable', status: 503 });
    p.gateway.fault('/token', { status: 200, body: '{}', headers: { 'content-type': 'application/json' } });
    expect(await askForToken(host, ask)).toMatchObject({ kind: 'unreadable', status: 200 });
  });
  it('throws a TypeError before any request for a delegation that is not 64 lower-case hex characters, and for one key named twice; a good ask is sent', async () => {
    const { p, host, ask } = await askWorld();
    await expect(askForToken(host, { ...ask, delegation: 'AB'.repeat(32) })).rejects.toThrow(TypeError);
    await expect(askForToken(host, { ...ask, subjectKey: KEY_1, dpopKey: KEY_1 })).rejects.toThrow(TypeError);
    expect(tokenRequests(p)).toBe(0);
    expect((await askForToken(host, ask)).kind).toBe('granted');
    expect(tokenRequests(p)).toBe(1);
  });
});
