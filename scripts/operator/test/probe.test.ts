// The fake node and the in-process gateway test delegated and subagent token requests.
// The stub uses the same temporary public keys as the node. The tests check that the probe outputs no token or proof.
import { createPublicKey } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { EvidenceFile } from '../../checks/lib/evidence.ts';
import { iso } from '../../checks/lib/format.ts';
import { factsOf } from '../../checks/lib/txfacts.ts';
import { buildEndSubagents } from '../../../packages/buyer-core/src/vendored/mcp/identity-build.ts';
import { delegation, delegationUtxo } from '../../../packages/buyer-core/test/fixtures/escrow-identity.fixture.ts';
import { REF_UTXOS, recordUtxo, rootRecord } from '../../../packages/buyer-core/test/fixtures/identity-world.ts';
import { resolveKey } from '../../../packages/id-kit/src/index.ts';
import { createStubGateway, ed25519Key } from '../../../packages/id-kit/src/testing/index.ts';
import type { StubAgent, StubDelegation, StubGateway, TestKey } from '../../../packages/id-kit/src/testing/index.ts';
import { utf8Hex } from '../../../packages/vector-read/src/identity-codec.ts';
import type { IdentityDatum } from '../../../packages/vector-read/src/identity-codec.ts';
import { DAY, DEPLOYMENT } from '../../checks/test/support/world.ts';
import type { SubagentSpec, TaskFlags } from '../lib/contract.ts';
import { FactsFile } from '../lib/facts.ts';
import { askForSubagentToken, askForToken } from '../lib/gateway-token.ts';
import { ensureSlotConfig, PURPOSE } from '../lib/platform.ts';
import { loadRegistry } from '../lib/registry.ts';
import type { KeySpec, Registry } from '../lib/registry.ts';
import { runTask } from '../lib/runner.ts';
import { parseOperatorSettings } from '../lib/settings.ts';
import probe from '../tasks/probe.ts';
import USE from '../usecases/inventory-reorder.ts';
import UC2 from '../usecases/prior-authorization.ts';
import UC3 from '../usecases/bid-evaluation.ts';
import { NOW, USE_CASE, hashOf, taskWorld } from './support/task-world.ts';
import type { TaskWorld } from './support/task-world.ts';

const NAMES = USE.keys.map((spec) => spec.name);
const SHARED = USE.keys.filter((spec) => spec.scope === 'shared').map((spec) => spec.name);
const ACTION = 'po.write';
const RESOURCE = 'https://mock.test/t/trial/po';
const KEY_1 = 'reorder-delegation-1';
const KEY_2 = 'reorder-delegation-2';
const SUBJECT = 'record-reader';
const AUTH = 'record-reader-auth';
const PROOF = 'record-reader-delegation';
const SUBJECT_SPEC = UC2.subagents.find(({ id }) => id === SUBJECT)!;
const SUBJECT_REFUSAL = "subject_token: the agent's effective status is revoked, not active";

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

function watchProbe(w: TaskWorld, gateway: StubGateway) {
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
    wire, asked, fetchImpl,
    run: (...argv: string[]) => runTask(probe, argv, w.deps({ fetchImpl, readRegistry, hosted })),
    text: () => w.screen.lines.join('\n'),
    entries: () => w.evidence('probe', 'r2'),
    everything: () => w.allText(),
  };
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
  return {
    w, gateway, agent, ...watchProbe(w, gateway),
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
  };
}

async function subagentWorld(keys: SubagentSpec['keys'] = SUBJECT_SPEC.keys) {
  const baseUrl = 'https://gateway.test';
  const use = { ...UC2, subagents: UC2.subagents.map((spec) => spec.id === SUBJECT ? { ...spec, keys } : spec) };
  const w = await taskWorld({
    use, keys: use.keys.map(({ name }) => name), shared: use.keys.filter(({ scope }) => scope === 'shared').map(({ name }) => name),
    env: { OPERATOR_USE_CASE: USE_CASE, OPERATOR_GATEWAY_URL: baseUrl },
  });
  const registry = w.keys.registry;
  const gateway = createStubGateway({ baseUrl, now: () => w.clock.now() });
  const parent = gateway.createAgent({ label: 'test parent' });
  const auth = testKeyOf(registry, AUTH);
  const proof = testKeyOf(registry, PROOF);
  const subject = gateway.createAgent({ label: 'test child', parent, authentication: auth, delegation: proof });
  const parentDatum = rootRecord({ controller: registry.publicKeyOf('controller') });
  const subjectDatum = rootRecord({
    lineage: { type: 'Subagent', parent: parent.id, parentEpoch: parentDatum.subagentEpoch, depth: 1 },
    keys: [
      { keyType: 'Ed25519', key: auth.publicKeyHex, purposes: PURPOSE.authentication, pop: null },
      { keyType: 'Ed25519', key: proof.publicKeyHex, purposes: PURPOSE.delegation, pop: null },
    ],
  });
  const facts = FactsFile.open(join(w.stateDir, 'facts.json'), { useCase: use.name, network: 'vector-mainnet' });
  const chain = w.world.chain;
  chain.held.push(...REF_UTXOS);
  for (const [name, agent, datum] of [[SUBJECT_SPEC.parent, parent, parentDatum], [SUBJECT, subject, subjectDatum]] as const) {
    const output = recordUtxo(agent.id, datum);
    chain.held.push(output);
    facts.put('records', [name], { did: agent.did, id: agent.id, tx: output.txHash, recordRef: `${output.txHash}#${output.outputIndex}`, depositLovelace: '10000000', registeredAt: iso(NOW) });
  }
  const remove = (agent: StubAgent): void => {
    chain.held = chain.held.filter((utxo) => utxo.assets[`${DEPLOYMENT.identity.hash}${agent.id}`] === undefined);
  };
  return {
    w, gateway, parent, subject, auth, proof, remove, ...watchProbe(w, gateway),
    args: (changes: Record<string, string | null> = {}): string[] => {
      const given = { run: 'r2', subagent: SUBJECT, resource: RESOURCE, action: ACTION, expect: 'granted', ...changes };
      return Object.entries(given).flatMap(([name, value]) => value === null ? [] : [`--${name}`, value]);
    },
    replaceSubject: (over: Partial<IdentityDatum>): void => {
      remove(subject);
      chain.held.push(recordUtxo(subject.id, { ...subjectDatum, ...over }));
    },
    bumpParent: async (): Promise<void> => {
      await ensureSlotConfig(chain);
      const fee = registry.addressOf('fee');
      const built = await buildEndSubagents(await w.chain.context(fee), { id: parent.id, changeAddress: fee, nowMs: w.clock.now() });
      const { txHash, outputs } = factsOf(built.txCbor);
      const output = outputs[built.recordOutputIndex]!;
      if (output.inlineDatum === null) throw new Error('the test epoch update has no record datum');
      remove(parent);
      chain.held.push({ txHash, outputIndex: output.index, address: output.address, datum: output.inlineDatum, assets: { ...output.assets, lovelace: output.lovelace } });
    },
  };
}

const flags = (values: Record<string, string>): TaskFlags => ({ has: (name) => name in values, value: (name) => values[name] });
const errors = (p: { w: TaskWorld }): string => p.w.screen.errors.join('\n');
/** The requests of the probe that reached the gateway. */
const tokenRequests = (p: { gateway: StubGateway }): number => p.gateway.requests.filter((request) => request.path === '/token').length;
/** The observation of an entry of the evidence: the entry must hold one. */
function observationOf(entry: Record<string, unknown> | undefined): Record<string, unknown> {
  const shows = entry?.shows;
  if (typeof shows !== 'object' || shows === null || !('observation' in shows) || typeof shows.observation !== 'object' || shows.observation === null) throw new Error('the entry holds no observation');
  return { ...shows.observation };
}

describe('the definition', () => {
  it('lists the seven valued flags and no boolean flag, needs no approval, reads the chain, calls no hosted tool, and has the one step run', () => {
    expect(probe).toMatchObject({ name: 'probe', flags: [], valued: ['agent', 'key', 'delegation', 'subagent', 'resource', 'action', 'expect'], needs: { chain: true, hosted: [], approval: 'never' } });
    expect(probe.steps(USE, flags({}))).toEqual(['run']);
  });
  it('loads the service key of the agent and the delegation key that --key names, and no other key', () => {
    expect(probe.needs.keys(USE, flags({ key: KEY_2 }))).toEqual(['reorder-service', KEY_2]);
    expect(probe.needs.keys(USE, flags({ key: KEY_1, agent: 'reorder-agent' }))).toEqual(['reorder-service', KEY_1]);
    expect(probe.needs.keys(USE, flags({}))).toEqual(['reorder-service']);
    expect(probe.needs.keys(UC2, flags({ subagent: SUBJECT }))).toEqual([AUTH, PROOF]);
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

describe('a token for the subagent itself', () => {
  it('records a grant before the parent changes epoch and a refusal after it, without an action grant or credentials', async () => {
    const p = await subagentWorld();
    expect(await p.run(...p.args())).toBe(0);
    expect(p.entries()).toEqual([]);
    expect(await p.run(...p.args(), '--submit')).toBe(0);
    const names = { subagent: SUBJECT, subjectKey: AUTH, dpopKey: PROOF, resource: RESOURCE, action: ACTION };
    expect(p.text()).toContain(`the action ${ACTION} labels the observation and is not an action grant`);
    expect(p.w.machine().result).toMatchObject({ ...names, did: p.subject.did, effectiveStatus: 'active', status: 200, observed: 'granted', ok: true });
    expect(p.entries()[0]).toMatchObject({
      step: 'run', status: 'info',
      shows: {
        probe: { ...names, expect: 'granted' }, record: { did: p.subject.did, effectiveStatus: 'active' },
        observation: { kind: 'granted', status: 200, tokenType: 'DPoP', authorizationDetails: null }, verdict: { expected: 'granted', observed: 'granted', ok: true },
      },
    });

    await p.bumpParent();
    // The gateway stub models a revoked subject. The fake node still holds its unchanged Active datum, but the parent has a new epoch.
    p.gateway.setStatus(p.subject, 'revoked');
    expect(await p.run(...p.args({ expect: 'refused' }), '--submit')).toBe(0);
    expect(p.text()).toContain('the effective status of the subagent on the chain: revoked');
    expect(p.w.machine().result).toMatchObject({ ...names, did: p.subject.did, effectiveStatus: 'revoked', status: 400, error: 'invalid_request', text: SUBJECT_REFUSAL, observed: 'refused', ok: true });
    expect(p.entries()[1]).toMatchObject({
      shows: {
        probe: { ...names, expect: 'refused' }, record: { did: p.subject.did, effectiveStatus: 'revoked' },
        observation: { kind: 'refused', status: 400, error: 'invalid_request', text: SUBJECT_REFUSAL }, verdict: { expected: 'refused', observed: 'refused', ok: true },
      },
    });
    expect(p.entries()).toHaveLength(2);
    const requests = p.gateway.requests.filter(({ path }) => path === '/token');
    expect(requests).toHaveLength(3);
    for (const request of requests) {
      const form = new URLSearchParams(request.body);
      expect([...form.keys()].sort()).toEqual(['grant_type', 'resource', 'subject_token', 'subject_token_type']);
      expect(form.getAll('resource')).toEqual([RESOURCE]);
      const headerOf = (text: string): unknown => JSON.parse(Buffer.from(text.split('.')[0]!, 'base64url').toString('utf8'));
      expect(headerOf(form.get('subject_token')!)).toMatchObject({ kid: `${p.subject.did}#${p.auth.keyHash}` });
      expect(headerOf(request.headers.dpop!)).toMatchObject({ jwk: p.proof.jwk });
    }
    const text = p.everything();
    expect(p.wire).toHaveLength(8);
    for (const credential of p.wire) expect(text).not.toContain(credential);
    expect(p.asked).toEqual([]);
    expect(p.w.node.submitted).toEqual([]);
    expect(p.w.state('probe', 'r2')).toMatchObject({ steps: {}, in_flight: null });
  });

  it('rejects mixed modes, missing arguments and unknown subagents before any request', async () => {
    const p = await subagentWorld();
    for (const [name, value] of [['agent', SUBJECT_SPEC.parent], ['key', AUTH], ['delegation', 'b1'.repeat(32)]] as const) {
      expect(await p.run(...p.args({ [name]: value })), name).toBe(2);
      expect(errors(p)).toContain('--subagent excludes --agent, --key and --delegation');
    }
    for (const name of ['run', 'resource', 'action', 'expect']) {
      expect(await p.run(...p.args({ [name]: null })), name).toBe(2);
      expect(errors(p)).toContain(`probe needs --${name}`);
    }
    expect(await p.run(...p.args({ subagent: SUBJECT_SPEC.parent }))).toBe(2);
    expect(tokenRequests(p)).toBe(0);
    expect(await p.run(...p.args())).toBe(0);
  });

  it('rejects missing, ambiguous and identical key purposes before any request', async () => {
    const badKeys: SubagentSpec['keys'][] = [
      [{ key: PROOF, purposes: ['delegation'], lines: [] }],
      [{ key: AUTH, purposes: ['authentication'], lines: [] }],
      [{ key: AUTH, purposes: ['authentication', 'delegation'], lines: [] }],
      [...SUBJECT_SPEC.keys, { key: 'drafter-auth', purposes: ['authentication'], lines: [] }],
      [...SUBJECT_SPEC.keys, { key: 'drafter-delegation', purposes: ['delegation'], lines: [] }],
    ];
    for (const keys of badKeys) {
      const p = await subagentWorld(keys);
      expect(await p.run(...p.args())).toBe(2);
      expect(errors(p)).toContain('exactly one authentication key and one different delegation key');
      expect(tokenRequests(p)).toBe(0);
    }
  });

  it('reads the registered subject and its real parent and requires the listed key purposes', async () => {
    const p = await subagentWorld();
    p.replaceSubject({ lineage: { type: 'Root' } });
    expect(await p.run(...p.args())).toBe(2);
    expect(errors(p)).toContain('does not name the expected parent');
    p.replaceSubject({ keys: [] });
    expect(await p.run(...p.args())).toBe(2);
    expect(errors(p)).toContain('does not list the named authentication and delegation keys with their purposes');
    p.replaceSubject({});
    expect(await p.run(...p.args())).toBe(0);
    p.remove(p.parent);
    expect(await p.run(...p.args())).toBe(2);
    expect(errors(p)).toContain('and its ancestors could not be read');
    expect(tokenRequests(p)).toBe(1);
  });

  it('does not accept a grant as a refusal or as the active control after the parent changes epoch', async () => {
    const p = await subagentWorld();
    expect(await p.run(...p.args({ expect: 'refused' }), '--submit')).toBe(1);
    expect(p.w.machine().result).toMatchObject({ effectiveStatus: 'active', observed: 'granted', ok: false });
    await p.bumpParent();
    expect(await p.run(...p.args(), '--submit')).toBe(1);
    expect(p.w.machine().result).toMatchObject({ effectiveStatus: 'revoked', observed: 'granted (not the expected answer)', ok: false });
  });

  it('needs a matching subject-status refusal on the node, not a bad proof or another gateway error', async () => {
    const p = await subagentWorld();
    const inactive = "subject_token: the agent's effective status is revoked (parentRevoked), not active";
    const fault = (status: number, error?: string, text = inactive): void => {
      p.gateway.fault('/token', { status, body: JSON.stringify({ error, error_description: text }) });
    };
    fault(401, 'invalid_request');
    expect(await p.run(...p.args({ expect: 'refused' }))).toBe(1);
    await p.bumpParent();
    for (const [status, code, text] of [
      [400, 'invalid_request', 'bad proof for a revoked key'],
      [400, 'invalid_dpop_proof', inactive],
      [400, 'invalid_request', inactive.replace('revoked (parentRevoked)', 'suspended (parentSuspended)')],
      [400, undefined, inactive],
      [403, 'invalid_request', inactive],
    ] as const) {
      fault(status, code, text);
      expect(await p.run(...p.args({ expect: 'refused' })), `${status} ${code} ${text}`).toBe(1);
    }
    fault(401, 'invalid_request');
    expect(await p.run(...p.args({ expect: 'refused' }), '--submit')).toBe(0);
    expect(p.w.machine().result).toMatchObject({ effectiveStatus: 'revoked', status: 401, error: 'invalid_request', text: inactive, observed: 'refused', ok: true });
  });

  it('does not treat a token-shaped error or a grant with delegation details as a control', async () => {
    const p = await subagentWorld();
    const body = { access_token: 'header.payload.signature', token_type: 'DPoP', issued_token_type: 'urn:ietf:params:oauth:token-type:access_token', expires_in: 60 };
    p.gateway.fault('/token', { status: 400, body: JSON.stringify({ ...body, error: 'invalid_request' }) });
    expect(await p.run(...p.args(), '--submit')).toBe(1);
    expect(p.w.machine().result).toMatchObject({ observed: 'refused', status: 400, ok: false });
    const diagnostic = 'untrusted response text';
    p.gateway.fault('/token', { status: 200, body: JSON.stringify({ ...body, error: 'invalid_request', error_description: diagnostic }) });
    expect(await p.run(...p.args(), '--submit')).toBe(1);
    expect(p.w.machine().result).toMatchObject({ observed: 'unreadable', status: 200, ok: false });
    expect(p.entries()[1]).toMatchObject({ shows: { observation: { kind: 'unreadable', status: 200 }, verdict: { ok: false } } });
    expect(p.everything()).not.toContain(diagnostic);
    p.gateway.fault('/token', { status: 200, body: JSON.stringify({ ...body, authorization_details: [{ identifier: 'f0'.repeat(32) }] }) });
    expect(await p.run(...p.args(), '--submit')).toBe(1);
    expect(p.w.machine().result).toMatchObject({ observed: 'unreadable', status: 200, ok: false });
    expect(p.everything()).not.toContain(body.access_token);
  });

  it('keeps arbitrary error text out of evidence and exits 3 when the gateway does not answer', async () => {
    const p = await subagentWorld();
    expect(await p.run(...p.args())).toBe(0);
    const proof = p.wire[0]!;
    const echoedHeader = `DPoP ${proof}`;
    p.gateway.fault('/token', { status: 400, body: JSON.stringify({ error: proof, error_description: echoedHeader }) });
    expect(await p.run(...p.args({ expect: 'refused' }), '--submit')).toBe(1);
    expect(p.w.machine().result).toMatchObject({ error: null, text: 'the gateway gave no recognized subject status diagnostic', ok: false });
    p.gateway.fault('/token', 'network');
    expect(await p.run(...p.args(), '--submit')).toBe(3);
    expect(p.entries()[1]).toMatchObject({ shows: { observation: { kind: 'unreachable' }, verdict: { ok: false } } });
    expect(p.everything()).not.toContain(proof);
    expect(p.everything()).not.toContain(echoedHeader);
  });

  it('refuses to use one key for both signatures in the token wrapper', async () => {
    const p = await subagentWorld();
    const host = { registry: p.w.keys.registry, settings: parseOperatorSettings(p.w.env), fetchImpl: p.fetchImpl, clock: p.w.clock };
    await expect(askForSubagentToken(host, { did: p.subject.did, subjectKey: AUTH, dpopKey: AUTH, action: ACTION, resource: RESOURCE })).rejects.toThrow(TypeError);
    expect(tokenRequests(p)).toBe(0);
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
      expect(p.entries()[0], label).toMatchObject({ shows: { observation: { kind: 'refused', status, error }, verdict: { expected: 'refused', observed: 'refused (not the expected answer)', ok: false } } });
      expect(p.w.machine().result, label).toMatchObject({ observed: 'refused (not the expected answer)', ok: false, status });
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
      expect(p.entries()[0], label).toMatchObject({ shows: { verdict: { expected: 'granted', observed: 'granted (not the expected answer)', ok: false } } });
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
  it.each([USE, UC2, UC3])('shows only the saved probe observations on $name, without keys, a node or a gateway', async (use) => {
    const w = await taskWorld({ keys: [], use, env: { OPERATOR_USE_CASE: USE.name, OPERATOR_KEYS_DIR: undefined } });
    mkdirSync(w.stateDir, { mode: 0o700 });
    const path = join(w.stateDir, 'probe.r1.evidence.json');
    const evidence = EvidenceFile.open(path, { check: 'probe', network: 'vector-mainnet', record: `${use.name}:r1` });
    evidence.add({ step: 'run', status: 'info', at: iso(NOW), shows: {
      summary: 'private text that status must not repeat', observation: { kind: 'refused', status: 401, text: 'private gateway reply' },
      verdict: { expected: 'refused', observed: 'refused', ok: true, reason: 'private reason' },
    } });
    writeFileSync(join(w.stateDir, 'probe.r1.state.json'), 'not JSON', { mode: 0o600 });
    writeFileSync(join(w.stateDir, 'facts.json'), 'not JSON', { mode: 0o600 });
    const saved = readFileSync(path, 'utf8');
    const files = readdirSync(w.stateDir).sort();
    const noKeys = vi.fn(() => { throw new Error('status must not load a key'); });
    const noNetwork = vi.spyOn(w.node, 'networkFacts').mockRejectedValue(new Error('status must not read the node'));
    const noFetch = vi.fn(async () => { throw new Error('status must not request credentials or call the gateway'); });
    const noHosted = vi.fn(async () => { throw new Error('status must not ask a hosted tool'); });
    const code = await runTask(probe, ['status', '--run', 'r1', '--use-case', use.name],
      w.deps({ readRegistry: noKeys, fetchImpl: noFetch, hosted: { call: noHosted } }));
    expect(code).toBe(0);
    const out = w.screen.lines.join('\n');
    expect(out).toContain('requests that the evidence holds: 1');
    expect(out).toContain(`request 1 at ${iso(NOW)}: expected refused, observed refused (status 401): as expected`);
    expect(out).not.toContain('private');
    expect(w.machine()).toMatchObject({ task: 'probe', command: 'status', mode: 'dry', outcome: 'done', exit: 0, step: null, result: {} });
    expect(noKeys).not.toHaveBeenCalled();
    expect(noNetwork).not.toHaveBeenCalled();
    expect(noFetch).not.toHaveBeenCalled();
    expect(noHosted).not.toHaveBeenCalled();
    expect(w.node.submitted).toEqual([]);
    expect(readFileSync(path, 'utf8')).toBe(saved);
    expect(readdirSync(w.stateDir).sort()).toEqual(files);
  });

  it('does not create a journal and does not misread a damaged journal or an active lock as an absence', async () => {
    const w = await taskWorld({ keys: [], use: UC3, env: { OPERATOR_USE_CASE: USE.name, OPERATOR_KEYS_DIR: undefined } });
    const args = ['status', '--run', 'r1'];
    const path = join(w.stateDir, 'probe.r1.evidence.json');
    expect(await w.run(probe, ...args)).toBe(0);
    expect(w.screen.lines).toContain('requests that the evidence holds: 0');
    expect(existsSync(w.stateDir)).toBe(false);
    mkdirSync(w.stateDir, { mode: 0o700 });
    expect(await w.run(probe, ...args)).toBe(0);
    expect(readdirSync(w.stateDir)).toEqual([]);
    symlinkSync('missing-target', path);
    w.screen.lines.length = 0;
    expect(await w.run(probe, ...args)).toBe(2);
    expect(w.screen.errors.join('\n')).toContain('is not a regular evidence file');
    expect(w.screen.lines).not.toContain('requests that the evidence holds: 0');
    writeFileSync(w.lockPath, 'writer owns the lock', { mode: 0o600 });
    expect(await w.run(probe, ...args)).toBe(2);
    expect(w.screen.errors.join('\n')).toContain('another run holds it');
    expect(readFileSync(w.lockPath, 'utf8')).toBe('writer owns the lock');
  });

  it('shows a zero count for an existing empty probe journal', async () => {
    const w = await taskWorld({ keys: [], env: { OPERATOR_KEYS_DIR: undefined } });
    mkdirSync(w.stateDir, { mode: 0o700 });
    const path = join(w.stateDir, 'probe.r1.evidence.json');
    EvidenceFile.open(path, { check: 'probe', network: 'vector-mainnet', record: `${w.use.name}:r1` });
    const saved = readFileSync(path, 'utf8');
    expect(await w.run(probe, 'status', '--run', 'r1')).toBe(0);
    expect(w.screen.lines).toContain('requests that the evidence holds: 0');
    expect(readFileSync(path, 'utf8')).toBe(saved);
  });

  it('reads the historic and current same-kind failures without copying their text', async () => {
    const w = await taskWorld({ keys: [], env: { OPERATOR_KEYS_DIR: undefined } });
    mkdirSync(w.stateDir, { mode: 0o700 });
    const evidence = EvidenceFile.open(join(w.stateDir, 'probe.r1.evidence.json'), { check: 'probe', network: 'vector-mainnet', record: `${w.use.name}:r1` });
    const marker = 'opaque-private-probe-data';
    for (const current of [false, true]) {
      for (const kind of ['granted', 'refused'] as const) {
        evidence.add({ step: 'run', status: 'info', at: iso(NOW), shows: {
          summary: marker, probe: { resource: marker },
          observation: kind === 'granted'
            ? { kind, tokenType: 'DPoP', expiresAt: iso(NOW + 60_000), authorizationDetails: current ? null : [{ purpose: marker }], ...(current ? { status: 200 } : {}) }
            : { kind, status: 400, error: 'invalid_request', text: marker },
          verdict: { expected: kind, observed: current ? `${kind} (not the expected answer)` : kind, ok: false, reason: marker },
        } });
      }
    }
    expect(await w.run(probe, 'status', '--run', 'r1')).toBe(0);
    expect(w.screen.lines).toEqual(expect.arrayContaining([
      'requests that the evidence holds: 4',
      `request 1 at ${iso(NOW)}: expected granted, observed granted (not the expected answer): NOT as expected`,
      `request 2 at ${iso(NOW)}: expected refused, observed refused (not the expected answer) (status 400): NOT as expected`,
      `request 3 at ${iso(NOW)}: expected granted, observed granted (not the expected answer) (status 200): NOT as expected`,
      `request 4 at ${iso(NOW)}: expected refused, observed refused (not the expected answer) (status 400): NOT as expected`,
    ]));
    expect(w.screen.lines.join('\n')).not.toContain(marker);
  });

  it.each([
    'empty object', 'unknown step', 'unknown status', 'invalid time', 'empty info', 'runner note',
    'missing status', 'incomplete grant', 'missing verdict', 'wrong verdict', 'failure suffix on success',
  ] as const)('refuses a damaged probe journal with %s', async (fault) => {
    const w = await taskWorld({ keys: [], env: { OPERATOR_KEYS_DIR: undefined } });
    mkdirSync(w.stateDir, { mode: 0o700 });
    const marker = 'opaque-private-probe-data';
    const observation = { kind: 'refused', status: 400, error: 'invalid_authorization_details', text: marker };
    const verdict = { expected: 'refused', observed: 'refused', ok: true, reason: marker };
    const saved = { step: 'run', status: 'info', at: iso(NOW), shows: { observation, verdict } };
    const bad: Record<typeof fault, Record<string, unknown>> = {
      'empty object': {},
      'unknown step': { ...saved, step: marker },
      'unknown status': { ...saved, status: marker },
      'invalid time': { ...saved, at: marker },
      'empty info': { ...saved, shows: {} },
      'runner note': { ...saved, shows: { note: 'the operator lets the transaction go, and says that the chain was checked', transaction: hashOf(marker), session: null } },
      'missing status': { ...saved, shows: { observation: { kind: 'refused' }, verdict } },
      'incomplete grant': { ...saved, shows: { observation: { kind: 'granted', tokenType: 'DPoP' }, verdict: { expected: 'granted', observed: 'granted', ok: true } } },
      'missing verdict': { ...saved, shows: { observation } },
      'wrong verdict': { ...saved, shows: { observation, verdict: { ...verdict, observed: marker, ok: false } } },
      'failure suffix on success': { ...saved, shows: { observation, verdict: { ...verdict, observed: 'refused (not the expected answer)' } } },
    };
    const path = join(w.stateDir, 'probe.r1.evidence.json');
    // A corrupt entry must stop the whole status even after a valid stored observation.
    const entries = fault === 'wrong verdict' ? [saved, bad[fault]] : [bad[fault]];
    const bytes = JSON.stringify({ format: 1, check: 'probe', network: 'vector-mainnet', record: `${w.use.name}:r1`, started_at: iso(NOW), entries });
    writeFileSync(path, bytes, { mode: 0o600 });
    expect(await w.run(probe, 'status', '--run', 'r1')).toBe(2);
    expect(w.machine()).toMatchObject({ task: 'probe', command: 'status', outcome: 'stopped', exit: 2, step: null, result: {} });
    expect(w.screen.errors.join('\n')).toContain('the saved probe');
    expect(w.screen.lines.join('\n')).not.toContain('requests that the evidence holds:');
    expect([...w.screen.lines, ...w.screen.errors].join('\n')).not.toContain(marker);
    expect(readFileSync(path, 'utf8')).toBe(bytes);
  });

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
