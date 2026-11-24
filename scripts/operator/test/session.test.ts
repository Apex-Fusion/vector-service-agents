// The session of a task and the world that it is built over: the parts that a test gives are used as they are, the real parts are made with no connection, and the session gives the result of the
// network guard that the runner stored, with no wait.
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EvidenceFile } from '../../checks/lib/evidence.ts';
import type { GuardResult } from '../../checks/lib/guards.ts';
import type { HostedTools } from '../../checks/lib/hosted.ts';
import { NetworkGate } from '../../checks/lib/land.ts';
import { VectorNode } from '../../checks/lib/node.ts';
import { OgmiosProvider } from '../../checks/lib/platform.ts';
import { deploymentFor, VECTOR_MAINNET } from '../../checks/lib/settings.ts';
import { StateFile } from '../../checks/lib/state.ts';
import { Exposure } from '../lib/approval.ts';
import type { OperatorSettings, TaskDefinition, TaskFlags } from '../lib/contract.ts';
import { FactsFile } from '../lib/facts.ts';
import { AWAIT_MS, POLL_MS, connect, makeSession } from '../lib/session.ts';
import type { SessionParts } from '../lib/session.ts';
import { parseOperatorSettings } from '../lib/settings.ts';
import { USE_CASE, taskWorld } from './support/task-world.ts';
import type { TaskWorld } from './support/task-world.ts';

const needs = (chain: boolean): Pick<TaskDefinition, 'name' | 'needs'> => ({ name: 'toy', needs: { keys: () => [], chain, hosted: ['vector_get_vault'], approval: 'never' } });
const NO_FLAGS: TaskFlags = { has: () => false, value: () => undefined };

/** The settings of a world, read from its environment as a run reads them. This makes the state folder. */
const settingsOf = (w: TaskWorld): OperatorSettings => parseOperatorSettings(w.env);

describe('connect with the parts that a test gives', () => {
  it('uses the node, the chain, the hosted tools and the fetch as they are, and closes with no error', async () => {
    const w = await taskWorld();
    const hosted: HostedTools = { call: async () => { throw new Error('not called'); } };
    const connections = connect(needs(true), settingsOf(w), { env: w.env, node: w.node, chain: w.chain, hosted, fetchImpl: w.chain.fetchImpl });
    expect(connections.node).toBe(w.node);
    expect(connections.chain).toBe(w.chain);
    expect(connections.hosted).toBe(hosted);
    expect(connections.fetchImpl).toBe(w.chain.fetchImpl);
    expect(connections.network).toBeInstanceOf(NetworkGate);
    await expect(connections.close()).resolves.toBeUndefined();
  });
});

describe('connect with the real parts', () => {
  it('makes the node of Vector and the chain of the network, over the services of the settings, and opens no connection', async () => {
    const w = await taskWorld();
    const settings = settingsOf(w);
    const connections = connect(needs(true), settings, { env: w.env });
    expect(connections.node).toBeInstanceOf(VectorNode);
    expect(connections.chain.provider).toBeInstanceOf(OgmiosProvider);
    expect(connections.chain.deployment).toEqual(deploymentFor(settings.network, w.env));
    expect(connections.chain.koiosUrl).toBe(settings.urls.koios);
    expect(connections.fetchImpl).toBe(fetch);
    expect(typeof connections.hosted.call).toBe('function');
    await expect(connections.close()).resolves.toBeUndefined();
  });
  it('makes the real node when only the chain is given, and the real chain when only the node is given', async () => {
    const w = await taskWorld();
    const settings = settingsOf(w);
    expect(connect(needs(true), settings, { env: w.env, chain: w.chain }).node).toBeInstanceOf(VectorNode);
    const withNode = connect(needs(true), settings, { env: w.env, node: w.node });
    expect(withNode.node).toBe(w.node);
    expect(withNode.chain.provider).toBeInstanceOf(OgmiosProvider);
  });
  it('gives a task that reads no ledger a chain that refuses each use and says why, with the node still there', async () => {
    const w = await taskWorld();
    const connections = connect(needs(false), settingsOf(w), { env: w.env });
    expect(connections.node).toBeInstanceOf(VectorNode);
    expect(() => connections.chain.provider).toThrow('does not read the ledger (toy)');
    expect(() => connections.chain.deployment).toThrow('does not read the ledger (toy)');
    await expect(connections.chain.context(w.keys.registry.addressOf('run'))).rejects.toThrow('builds no transaction (toy)');
  });
  it('refuses the chain of a test network that names no identity deployment, as a settings problem, and still makes the node and a chain-less task for it', async () => {
    const w = await taskWorld({ env: { OPERATOR_NETWORK: 'a-test-network', OPERATOR_NETWORK_MAGIC: '42' } });
    expect(() => connect(needs(true), settingsOf(w), { env: w.env })).toThrow('only vector-mainnet has a published deployment');
    expect(connect(needs(false), settingsOf(w), { env: w.env }).node).toBeInstanceOf(VectorNode);
  });
});

describe('makeSession', () => {
  /** The parts of a session over a world: its files are in the state folder, which the settings made. */
  async function partsOf(over: Partial<SessionParts<{ count: number }>> = {}): Promise<{ w: TaskWorld; parts: SessionParts<{ count: number }> }> {
    const w = await taskWorld();
    const settings = settingsOf(w);
    const identity = { check: 'toy', network: VECTOR_MAINNET.name, record: USE_CASE };
    const parts: SessionParts<{ count: number }> = {
      task: 'toy', mode: 'dry', all: false, settings, use: w.use, extra: { count: 3 }, flags: NO_FLAGS, registry: w.keys.registry,
      state: StateFile.open(join(w.stateDir, 'toy.state.json'), identity), evidence: EvidenceFile.open(join(w.stateDir, 'toy.evidence.json'), identity),
      facts: FactsFile.open(join(w.stateDir, 'facts.json'), { useCase: USE_CASE, network: VECTOR_MAINNET.name }), go: null,
      exposure: new Exposure(join(w.stateDir, 'exposure.none.json'), null), out: w.screen, clock: w.clock,
      connections: connect(needs(true), settings, { env: w.env, node: w.node, chain: w.chain, fetchImpl: w.chain.fetchImpl }), networkResult: () => null, awaitMs: AWAIT_MS, pollMs: POLL_MS, ...over,
    };
    return { w, parts };
  }

  it('gives each member of the contract the part that it was given, and the settings of the checks for a wait: 180 seconds and a read every 4 seconds', async () => {
    const { w, parts } = await partsOf({ mode: 'submit', all: true });
    const session = makeSession(parts);
    expect(session).toMatchObject({ task: 'toy', mode: 'submit', all: true, extra: { count: 3 }, awaitMs: 180_000, pollMs: 4_000 });
    expect(session.settings).toBe(parts.settings);
    expect(session.use).toBe(w.use);
    expect(session.registry).toBe(w.keys.registry);
    expect(session.state).toBe(parts.state);
    expect(session.evidence).toBe(parts.evidence);
    expect(session.facts).toBe(parts.facts);
    expect(session.exposure).toBe(parts.exposure);
    expect(session.flags).toBe(NO_FLAGS);
    expect(session.go).toBeNull();
    expect(session.out).toBe(w.screen);
    expect(session.clock).toBe(w.clock);
    expect(session.node).toBe(w.node);
    expect(session.chain).toBe(w.chain);
    expect(session.hosted).toBe(parts.connections.hosted);
    expect(session.fetchImpl).toBe(w.chain.fetchImpl);
    expect([AWAIT_MS, POLL_MS]).toEqual([180_000, 4_000]);
  });
  it('is frozen, so that no task can replace a member of it', async () => {
    const { parts } = await partsOf();
    const session = makeSession(parts);
    expect(Object.isFrozen(session)).toBe(true);
    expect(Reflect.set(session, 'mode', 'submit')).toBe(false);
    expect(session.mode).toBe('dry');
  });
  it('gives the session the network gate of its connections, over its node and the network of its settings: ok on the right network, and a failure on another', async () => {
    const { w, parts } = await partsOf();
    const session = makeSession(parts);
    expect(session.network).toBe(parts.connections.network);
    expect(session.network).toBeInstanceOf(NetworkGate);
    expect(await session.network.guard()).toMatchObject({ guard: 'network', ok: true });
    w.node.facts = { magic: 1, systemStartMs: VECTOR_MAINNET.systemStartMs };
    const other = connect(needs(true), parts.settings, { env: w.env, node: w.node, chain: w.chain });
    expect(await other.network.guard()).toMatchObject({ guard: 'network', ok: false });
  });

  describe('networkResult', () => {
    it('is null before the runner stored a result, and gives the result that it stored after, with no read of the node', async () => {
      let stored: GuardResult | null = null;
      const { w, parts } = await partsOf({ networkResult: () => stored });
      const session = makeSession(parts);
      expect(session.networkResult()).toBeNull();
      stored = await session.network.guard();
      const reads = w.node.networkReads;
      expect(session.networkResult()).toEqual({ guard: 'network', ok: true, message: expect.stringContaining('vector-mainnet') });
      expect(w.node.networkReads).toBe(reads);
    });
    it('says that the guard failed when the guard failed: a failed result is kept as it is, and is never ok', async () => {
      let stored: GuardResult | null = null;
      const { w, parts } = await partsOf({ networkResult: () => stored });
      w.node.facts = { magic: 7, systemStartMs: VECTOR_MAINNET.systemStartMs };
      const session = makeSession(parts);
      stored = await session.network.guard();
      const seen = session.networkResult();
      expect(seen?.ok).toBe(false);
      expect(seen?.message).toContain('magic 7');
    });
  });
});
