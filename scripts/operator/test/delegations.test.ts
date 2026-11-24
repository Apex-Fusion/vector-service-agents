// The task delegations: a read-only list of the live delegations, by delegate key, and a summary of each delegation key of the agents as free or in use. It runs through the real runner over the
// delegation outputs of the fixture world of buyer-core and the key registry of use case 1 (made at run time). Each refusal has an accepted twin. It signs nothing: the ring and each key fail when
// they are asked, and the submit of the node, the context that a builder needs, the hosted tools and the facts file are watched.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { iso } from '../../checks/lib/format.ts';
import { delegation, delegationUtxo } from '../../../packages/buyer-core/test/fixtures/escrow-identity.fixture.ts';
import { utf8Hex } from '../../../packages/vector-read/src/identity-codec.ts';
import type { DelegationDatum } from '../../../packages/vector-read/src/identity-codec.ts';
import { DAY } from '../../checks/test/support/world.ts';
import type { TaskFlags } from '../lib/contract.ts';
import { FactsFile } from '../lib/facts.ts';
import { loadRegistry } from '../lib/registry.ts';
import type { KeySpec, Registry } from '../lib/registry.ts';
import { runTask } from '../lib/runner.ts';
import delegations from '../tasks/delegations.ts';
import USE from '../usecases/inventory-reorder.ts';
import { NOW, USE_CASE, hashOf, taskWorld } from './support/task-world.ts';
import type { TaskWorld } from './support/task-world.ts';

const NAMES = USE.keys.map((spec) => spec.name);
const SHARED = USE.keys.filter((spec) => spec.scope === 'shared').map((spec) => spec.name);
const REORDER_ID = 'a1'.repeat(32);
const READER_ID = 'a2'.repeat(32);
const D1 = 'd1'.repeat(32);
const D2 = 'd2'.repeat(32);
const D3 = 'd3'.repeat(32);
const ACTION = 'marketplace.hire.v1';
const RESOURCE = `script:${'e5'.repeat(28)}`;

interface Watch {
  /** What was asked of a key, of the ring, of the node and of the hosted tools: each entry names the thing. */
  asked: string[];
}

interface DelegationsWorld {
  w: TaskWorld;
  watch: Watch;
  key: (name: string) => string;
  put: (id: string, over?: Partial<DelegationDatum>) => void;
  run: (...argv: string[]) => Promise<number>;
  text: () => string;
  facts: () => string;
}

/** The world of the tests: the 18 keys, the records of the two agents in the facts, no live delegation, and a watch on everything that signs or sends. */
async function world(): Promise<DelegationsWorld> {
  const w = await taskWorld({ keys: NAMES, shared: SHARED, use: USE });
  const facts = FactsFile.open(join(w.stateDir, 'facts.json'), { useCase: USE_CASE, network: 'vector-mainnet' });
  for (const [agent, id] of [['reorder-agent', REORDER_ID], ['stock-reader', READER_ID]] as const) {
    facts.put('records', [agent], { did: `did:vector:${id}`, id, tx: hashOf(`record ${agent}`), recordRef: `${hashOf(`record ${agent}`)}#0`, depositLovelace: '10000000', registeredAt: iso(NOW) });
  }
  const watch: Watch = { asked: [] };
  const refuse = (what: string) => (): never => { watch.asked.push(what); throw new Error(`${what} was asked`); };
  const readRegistry = (options: { dir: string; useCase: string; specs: readonly KeySpec[]; need: readonly string[] }): Registry => {
    const registry = loadRegistry(options);
    registry.ring.sign = refuse('the ring');
    for (const name of registry.names()) {
      registry.key(name).signTransaction = refuse(`the key ${name} for a transaction`);
      registry.key(name).signMessage = refuse(`the key ${name} for a message`);
    }
    return registry;
  };
  w.node.submit = async () => refuse('the node to submit')();
  const hosted = { call: async (name: string) => refuse(`the hosted tool ${name}`)() };
  // The chain answers the reads of the node and refuses to build: a task that makes a builder of buyer-core ask for the context of a wallet fails.
  const chain = { ...w.chain, context: async () => refuse('the chain context of a wallet, which a builder needs')(), liveVaultsOf: async () => refuse('the live vaults')() };
  const key = (name: string): string => w.keys.registry.hashOf(name);
  return {
    w, watch, key,
    put: (id, over = {}) => {
      const datum = delegation({ delegate: REORDER_ID, delegateKey: key('reorder-delegation-1'), actions: [utf8Hex(ACTION)], resources: [utf8Hex(RESOURCE)], ...over });
      w.world.chain.held.push({ ...delegationUtxo(datum, id), txHash: hashOf(`delegation ${id}`) });
    },
    run: (...argv) => runTask(delegations, argv, w.deps({ readRegistry, hosted, chain })),
    text: () => w.screen.lines.join('\n'),
    facts: () => readFileSync(join(w.stateDir, 'facts.json'), 'utf8'),
  };
}

const flags = (values: Record<string, string>): TaskFlags => ({ has: (name) => name in values, value: (name) => values[name] });

describe('the definition', () => {
  it('lists two valued flags, no boolean flag, no approval and the chain, and names the delegation keys of the agents as the keys that it loads', () => {
    expect(delegations).toMatchObject({ name: 'delegations', flags: [], valued: ['delegate-key', 'agent'], needs: { chain: true, hosted: [], approval: 'never' } });
    expect(delegations.steps(USE, flags({}))).toEqual(['run']);
    expect(delegations.needs.keys(USE, flags({}))).toEqual(['reorder-delegation-1', 'reorder-delegation-2', 'stock-reader-delegation']);
  });
  it('loads the key that a filter names, once, and no signing key besides', () => {
    expect(delegations.needs.keys(USE, flags({ 'delegate-key': 'reorder-delegation-2' }))).toEqual(['reorder-delegation-1', 'reorder-delegation-2', 'stock-reader-delegation']);
    expect(delegations.needs.keys(USE, flags({ 'delegate-key': 'reorder-service' }))).toEqual(['reorder-delegation-1', 'reorder-delegation-2', 'stock-reader-delegation', 'reorder-service']);
    expect(delegations.needs.keys(USE, flags({ 'delegate-key': 'ab'.repeat(28) }))).toEqual(['reorder-delegation-1', 'reorder-delegation-2', 'stock-reader-delegation']);
  });
});

describe('the list', () => {
  it('shows each live delegation with its fields and the registry name of its delegate key, and ends with a machine line that holds the counts and the state of each key', async () => {
    const d = await world();
    d.put(D1, { delegator: { type: 'PrincipalKey', hash: 'b7'.repeat(28), organisation: null }, notAfter: NOW + 2 * DAY, remaining: 1, value: { perTx: 6_000_000n, total: 22_000_000n, periodMs: DAY } });
    expect(await d.run()).toBe(0);
    const text = d.text();
    expect(text).toContain('live delegations on the chain: 1');
    expect(text).toContain(`delegation ${D1}`);
    expect(text).toContain(`delegator: key hash ${'b7'.repeat(28)}`);
    expect(text).toContain(`delegate: did:vector:${REORDER_ID} (the agent reorder-agent), key ${d.key('reorder-delegation-1')} (reorder-delegation-1)`);
    expect(text).toContain(`actions: ${ACTION}`);
    expect(text).toContain(`resources: ${RESOURCE}`);
    expect(text).toContain(`not after: ${iso(NOW + 2 * DAY)} (in 2 days)`);
    expect(text).toContain('remaining hops: 1');
    expect(text).toContain('value limit: 6.000000 units for each payment, 22.000000 units in 1 day');
    expect(text).toContain(`reorder-delegation-1 of reorder-agent (key ${d.key('reorder-delegation-1')}): in use by ${D1}`);
    expect(text).toContain(`reorder-delegation-2 of reorder-agent (key ${d.key('reorder-delegation-2')}): free`);
    expect(text).toContain(`stock-reader-delegation of stock-reader (key ${d.key('stock-reader-delegation')}): free`);
    expect(text).toContain('order-desk has no delegation key');
    expect(d.w.machine()).toMatchObject({ task: 'delegations', command: 'run', mode: 'dry', outcome: 'done', exit: 0, step: 'run' });
    expect(d.w.machine().result).toEqual({
      live: 1, shown: 1,
      keys: [
        { key: 'reorder-delegation-1', agent: 'reorder-agent', state: 'in use', delegations: [D1] },
        { key: 'reorder-delegation-2', agent: 'reorder-agent', state: 'free', delegations: [] },
        { key: 'stock-reader-delegation', agent: 'stock-reader', state: 'free', delegations: [] },
      ],
    });
  });
  it('writes a delegation with no value limit, a delegator that is an agent and a delegate key that the registry does not know, with the hash only', async () => {
    const d = await world();
    d.put(D1, { delegator: { type: 'Agent', id: 'c4'.repeat(32) }, parent: D2, depth: 2, value: null, delegateKey: 'f0'.repeat(28), delegate: 'c5'.repeat(32) });
    expect(await d.run()).toBe(0);
    expect(d.text()).toContain(`delegator: agent did:vector:${'c4'.repeat(32)}`);
    expect(d.text()).toContain(`delegate: did:vector:${'c5'.repeat(32)}, key ${'f0'.repeat(28)}`);
    expect(d.text()).toContain('value limit: none');
    expect(d.text()).not.toContain('(the agent');
    expect(d.text()).toContain(`reorder-delegation-1 of reorder-agent (key ${d.key('reorder-delegation-1')}): free`);
  });
  it('says that no delegation is live, and that each key is free', async () => {
    const d = await world();
    expect(await d.run()).toBe(0);
    expect(d.text()).toContain('live delegations on the chain: 0');
    expect(d.text()).toContain('no live delegation to show');
    expect(d.text()).not.toContain('in use by');
    expect(d.w.machine().result).toMatchObject({ live: 0, shown: 0 });
  });
  it('keeps a key in use after the end of its delegation, until the hirer ends it, and says so; a delegation that has not ended says when it ends', async () => {
    const d = await world();
    d.put(D1, { notAfter: NOW - 3_600_000 });
    expect(await d.run()).toBe(0);
    expect(d.text()).toContain(`not after: ${iso(NOW - 3_600_000)} (ended 1 h ago; the key stays in use until the hirer ends the delegation)`);
    expect(d.text()).toContain(`reorder-delegation-1 of reorder-agent (key ${d.key('reorder-delegation-1')}): in use by ${D1}`);
  });
  it('names every delegation that holds one key', async () => {
    const d = await world();
    d.put(D1);
    d.put(D2);
    expect(await d.run()).toBe(0);
    expect(d.text()).toContain(`reorder-delegation-1 of reorder-agent (key ${d.key('reorder-delegation-1')}): in use by ${D1}, ${D2}`);
  });
  it('shows the delegation of the second key as the second key in use, and the first key as free', async () => {
    const d = await world();
    d.put(D2, { delegateKey: d.key('reorder-delegation-2') });
    expect(await d.run()).toBe(0);
    expect(d.text()).toContain(`reorder-delegation-2 of reorder-agent (key ${d.key('reorder-delegation-2')}): in use by ${D2}`);
    expect(d.text()).toContain(`reorder-delegation-1 of reorder-agent (key ${d.key('reorder-delegation-1')}): free`);
  });
});

describe('child delegations', () => {
  const child = (d: DelegationsWorld, id: string, parent = D1, depth = 2): void => {
    d.put(id, { delegator: { type: 'Agent', id: REORDER_ID }, parent, depth, delegate: READER_ID, delegateKey: d.key('stock-reader-delegation'), notAfter: NOW + DAY });
  };

  it('groups two children that share a parent and lists both under the subagent key', async () => {
    const d = await world();
    d.put(D1, { remaining: 1, notAfter: NOW + 2 * DAY });
    child(d, D2);
    child(d, D3);
    const before = d.facts();
    expect(await d.run('--submit')).toBe(0);
    expect(d.text().split('\n').filter((line) => line === `  parent ${D1}`)).toHaveLength(1);
    expect(d.text()).toContain(`children:\n  parent ${D1}\n    child ${D2}: parent live`);
    expect(d.text()).toContain(`child ${D3}: parent live`);
    expect(d.text()).toContain(`delegate: did:vector:${READER_ID} (the subagent stock-reader), key ${d.key('stock-reader-delegation')} (stock-reader-delegation)`);
    const shared = { parent: D1, parentState: 'live', missingParent: null, delegate: `did:vector:${READER_ID}`, subagent: 'stock-reader',
      delegateKey: d.key('stock-reader-delegation'), key: 'stock-reader-delegation', actions: [ACTION], resources: [RESOURCE], notAfter: iso(NOW + DAY) };
    expect(d.w.machine().result).toMatchObject({
      live: 3, shown: 3, children: [{ id: D2, ...shared }, { id: D3, ...shared }],
      keys: expect.arrayContaining([{ key: 'stock-reader-delegation', agent: 'stock-reader', state: 'in use', delegations: [D2, D3] }]),
    });
    expect(d.watch.asked).toEqual([]);
    expect(d.facts()).toBe(before);
    expect(d.w.state('delegations')).toMatchObject({ steps: {}, in_flight: null });
    expect(d.w.evidence('delegations')).toEqual([]);
  });

  it('shows a consumed parent as missing and keeps each stranded child in the key summary even when a filter hides it', async () => {
    const d = await world();
    d.put(D1, { remaining: 1, notAfter: NOW + 2 * DAY });
    child(d, D2);
    child(d, D3);
    d.w.world.chain.held = d.w.world.chain.held.filter((utxo) => utxo.txHash !== hashOf(`delegation ${D1}`));
    expect(await d.run('--agent', 'stock-reader', '--delegate-key', d.key('stock-reader-delegation'))).toBe(0);
    expect(d.text()).toContain(`children:\n  parent ${D1}\n    child ${D2}: parent missing`);
    expect(d.text()).toContain(`child ${D3}: parent missing`);
    expect(d.text()).toContain('stranded child: it holds its key until the janitor of its agent ends it');
    expect(d.text()).not.toContain('parent live');
    const stranded = { parent: D1, missingParent: D1, parentState: 'missing' };
    expect(d.w.machine().result).toMatchObject({ live: 2, shown: 2, children: [{ id: D2, ...stranded }, { id: D3, ...stranded }] });

    d.w.screen.lines.length = 0;
    expect(await d.run('--delegate-key', 'reorder-delegation-1')).toBe(0);
    expect(d.text()).not.toContain(`child ${D2}`);
    expect(d.text()).toContain(`stock-reader-delegation of stock-reader (key ${d.key('stock-reader-delegation')}): in use by ${D2}, ${D3}`);
    expect(d.w.machine().result).toMatchObject({ live: 2, shown: 0 });
    expect(d.w.machine().result).not.toHaveProperty('children');
  });

  it('shows an expired unspent parent as ended, not live, without freeing the child key', async () => {
    const d = await world();
    d.put(D1, { notAfter: NOW });
    child(d, D2);
    expect(await d.run()).toBe(0);
    expect(d.text()).toContain(`child ${D2}: parent ended`);
    expect(d.w.machine().result).toMatchObject({
      children: [{ id: D2, parent: D1, parentState: 'ended', missingParent: null }],
      keys: expect.arrayContaining([{ key: 'stock-reader-delegation', agent: 'stock-reader', state: 'in use', delegations: [D2] }]),
    });
  });

  it('shows the missing ancestor of a child even when its direct parent is still unspent', async () => {
    const d = await world();
    d.put(D2, { delegator: { type: 'Agent', id: 'c4'.repeat(32) }, parent: D1, depth: 2 });
    child(d, D3, D2, 3);
    expect(await d.run()).toBe(0);
    expect(d.text()).toContain(`child ${D3}: parent missing (ancestor ${D1} is missing)`);
    expect(d.w.machine().result).toMatchObject({ children: [{ id: D3, parent: D2, parentState: 'missing', missingParent: D1 }] });
  });
});

describe('the filters', () => {
  async function three(): Promise<DelegationsWorld> {
    const d = await world();
    d.put(D1);
    d.put(D2, { delegateKey: d.key('reorder-delegation-2') });
    d.put(D3, { delegate: READER_ID, delegateKey: d.key('stock-reader-delegation'), delegator: { type: 'Agent', id: REORDER_ID }, parent: D1, depth: 2 });
    return d;
  }
  const shown = (text: string): string[] => [D1, D2, D3].filter((id) => text.includes(`delegation ${id}\n`) || text.includes(`child ${id}:`));

  it('keeps the delegations of one delegate key by its registry name, and by its hash, and shows the same list for both', async () => {
    const byName = await three();
    expect(await byName.run('--delegate-key', 'reorder-delegation-2')).toBe(0);
    expect(shown(byName.text())).toEqual([D2]);
    const byHash = await three();
    expect(await byHash.run(`--delegate-key=${byHash.key('reorder-delegation-2')}`)).toBe(0);
    expect(shown(byHash.text())).toEqual([D2]);
    expect(byHash.w.machine().result).toMatchObject({ live: 3, shown: 1 });
    const all = await three();
    expect(await all.run()).toBe(0);
    expect(shown(all.text())).toEqual([D1, D2, D3]);
  });
  it('keeps the delegations that name one agent as their delegate, a subagent too', async () => {
    const reorder = await three();
    expect(await reorder.run('--agent', 'reorder-agent')).toBe(0);
    expect(shown(reorder.text())).toEqual([D1, D2]);
    const reader = await three();
    expect(await reader.run('--agent', 'stock-reader')).toBe(0);
    expect(shown(reader.text())).toEqual([D3]);
  });
  it('applies both filters together, and shows no delegation when they exclude each other', async () => {
    const both = await three();
    expect(await both.run('--agent', 'reorder-agent', '--delegate-key', 'reorder-delegation-1')).toBe(0);
    expect(shown(both.text())).toEqual([D1]);
    const none = await three();
    expect(await none.run('--agent', 'stock-reader', '--delegate-key', 'reorder-delegation-1')).toBe(0);
    expect(shown(none.text())).toEqual([]);
    expect(none.text()).toContain('no live delegation to show');
  });
  it('does not narrow the summary of the keys: a filter on a free key still shows the key that is in use', async () => {
    const d = await world();
    d.put(D1);
    expect(await d.run('--delegate-key', 'reorder-delegation-2')).toBe(0);
    expect(shown(d.text())).toEqual([]);
    expect(d.text()).toContain(`reorder-delegation-1 of reorder-agent (key ${d.key('reorder-delegation-1')}): in use by ${D1}`);
    expect(d.text()).toContain(`reorder-delegation-2 of reorder-agent (key ${d.key('reorder-delegation-2')}): free`);
  });
  it('refuses a key that is no key name of the use case and no 56 hex, and a hash that is not lower case, with exit 2 and the list of the names; the names of the use case pass', async () => {
    for (const value of ['nobody', 'AB'.repeat(28), 'ab'.repeat(27), '']) {
      const d = await world();
      expect(await d.run(`--delegate-key=${value}`), value).toBe(2);
      expect(d.w.screen.errors.join('\n')).toContain('--delegate-key');
      expect(d.watch.asked).toEqual([]);
    }
    for (const value of ['reorder-delegation-1', 'run', 'ab'.repeat(28)]) expect(await (await world()).run('--delegate-key', value), value).toBe(0);
  });
  it('refuses an agent that the use case does not list, and an agent whose record the facts do not hold, with exit 2; an agent that has a record passes', async () => {
    const unknown = await world();
    expect(await unknown.run('--agent', 'nobody')).toBe(2);
    expect(unknown.w.screen.errors.join('\n')).toContain('--agent');
    const unregistered = await world();
    expect(await unregistered.run('--agent', 'order-desk')).toBe(2);
    expect(unregistered.w.screen.errors.join('\n')).toContain('no record of the agent order-desk');
    expect(await (await world()).run('--agent', 'reorder-agent')).toBe(0);
  });
});

describe('the commands', () => {
  it('lists the same delegations for status, and for run with --submit, which needs no approval file', async () => {
    const status = await world();
    status.put(D1);
    expect(await status.run('status')).toBe(0);
    expect(status.text()).toContain(`delegation ${D1}`);
    expect(status.text()).toContain('network guard: ok');
    const submit = await world();
    submit.put(D1);
    expect(await submit.run('--submit')).toBe(0);
    expect(submit.text()).toContain(`delegation ${D1}`);
    expect(submit.w.machine()).toMatchObject({ mode: 'submit', outcome: 'done', exit: 0 });
  });
  it('says for cleanup that the operator cannot end the delegation of a hirer, exits 0 and changes nothing', async () => {
    const d = await world();
    d.put(D1);
    const before = d.facts();
    expect(await d.run('cleanup')).toBe(0);
    expect(d.text()).toContain('the operator cannot end a delegation of a hirer: the hirer ends it with an Undelegate');
    expect(d.text()).toContain('The janitor of the agent ends a stranded child.');
    expect(d.facts()).toBe(before);
    expect(d.w.machine()).toMatchObject({ command: 'cleanup', outcome: 'done', exit: 0 });
  });
  it('stops with exit 2 when the node is not on the network of the run, and lists when it is', async () => {
    const wrong = await world();
    wrong.put(D1);
    wrong.w.node.facts = { ...wrong.w.node.facts, magic: 1 };
    expect(await wrong.run()).toBe(2);
    expect(wrong.w.screen.errors.join('\n')).toContain('network');
    expect(wrong.text()).not.toContain(`delegation ${D1}`);
    const right = await world();
    right.put(D1);
    expect(await right.run()).toBe(0);
    expect(right.text()).toContain(`delegation ${D1}`);
  });
});

describe('what the task does not do', () => {
  it('signs nothing, submits nothing, calls no hosted tool, and writes no fact, no step, no transaction in flight and no evidence entry', async () => {
    const d = await world();
    d.put(D1);
    d.put(D2, { delegateKey: d.key('reorder-delegation-2') });
    const before = d.facts();
    for (const argv of [[], ['--submit'], ['status'], ['cleanup'], ['--agent', 'reorder-agent'], ['--delegate-key', 'reorder-delegation-1']]) expect(await d.run(...argv), argv.join(' ')).toBe(0);
    expect(d.watch.asked).toEqual([]);
    expect(d.w.node.submitted).toEqual([]);
    expect(d.w.world.chain.applied).toEqual([]);
    expect(d.facts()).toBe(before);
    expect(d.w.state('delegations')).toMatchObject({ steps: {}, in_flight: null });
    expect(d.w.evidence('delegations')).toEqual([]);
  });
  it('shows no seed and no key text in anything that it prints or writes', async () => {
    const d = await world();
    d.put(D1);
    await d.run();
    const text = d.w.allText();
    for (const name of NAMES) expect(text).not.toContain(d.w.keys.seedOf(name));
  });
});
