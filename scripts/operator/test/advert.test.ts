// The task `advert`: the four adverts of use case 1 (inventory reorder), each with the hash of the manifest that its service serves, read twice. A fake tool writes the bytes of an advert (a datum and units, and NO token) and of
// its retirement over the identity fixtures and answers in the format of the live tools, so the real guards judge real bytes. A fake `fetch` serves the manifests and the statuses of the runtimes. The task
// runs through the real runner. Each refusal has an accepted twin. No test opens a connection.
import { createHash } from 'node:crypto';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { factsOf } from '../../checks/lib/txfacts.ts';
import { ADVERT_REF, DEPLOYMENT, keyOf } from '../../checks/test/support/world.ts';
import { decodeIdentityAdvertDatum } from '../../../packages/vector-read/src/index.ts';
import advert from '../tasks/advert.ts';
import type { AdvertSpec, AgentSpec } from '../lib/contract.ts';
import { ORDER_DESK, REORDER, USE, manifestOf, stakeAdvertWorld } from './support/stake-advert-builds.ts';
import type { Fixture } from './support/stake-advert-builds.ts';
import { NOW } from './support/task-world.ts';

const POST = 'vector_build_marketplace_advert_post';
const RETIRE = 'vector_build_marketplace_advert_retire';
const LIST = 'vector_marketplace_list_suppliers';
const OUTSIDE = keyOf(77).address;
const BUILD_TOOLS = [POST, RETIRE];
const LIMIT = 262_144;
const [SMALL, MEDIUM, LARGE] = ORDER_DESK.adverts as [AdvertSpec, AdvertSpec, AdvertSpec];
const REORDER_ADVERT = REORDER.adverts[0]!;
const ADDRESS = DEPLOYMENT.advert.address;
/** The members of the manifest of the Reorder Agent that a test changes, and of a tier of the Order Desk. */
interface ReorderManifest { capability_id: unknown; identity: { did: unknown }; keys: { supplier_pkh: unknown }; terms: Record<string, unknown> }
interface Tier { price_lovelace: unknown; max_processing_ms: unknown; supplier_pkh: unknown }
interface OrderManifest { terms: { tiers: Tier[] } }

// ---- what a test reads and does ----

const errors = (f: Fixture): string => f.w.screen.errors.join('\n');
const sha = (text: string | Buffer): string => createHash('sha256').update(text).digest('hex');
const refusedBy = (text: string): string[] => /is refused by ([a-z_, ]+):/.exec(text)?.[1]?.split(', ') ?? [];
/** The manifest that the fixture serves for an agent, as an object, and as the text that the service sends. */
const manifestOfAgent = (f: Fixture, agent: AgentSpec): Record<string, unknown> => manifestOf(agent, f.didOf(agent), (name) => f.hash(name));
const bodyOf = (f: Fixture, agent: AgentSpec): string => JSON.stringify(manifestOfAgent(f, agent));
/** Serves a body at the manifest address of a runtime. A function gives a body for each read. */
function serve(f: Fixture, runtime: AdvertSpec, body: string | (() => string)): void {
  f.net.manifests.set(runtime.origin, () => new Response(typeof body === 'string' ? body : body(), { status: 200 }));
}
const advertsOnNode = (f: Fixture): string[] => f.world.chain.held.filter((utxo) => utxo.address === ADDRESS).map((utxo) => `${utxo.txHash}#${utxo.outputIndex}`);
function nothingSigned(f: Fixture): void {
  expect(f.signs).toEqual([]);
  expect(f.world.chain.applied).toEqual([]);
  expect(f.w.state('advert').in_flight).toBeNull();
}
/** The run with --submit of the next step: it must end with exit 0. */
async function land(f: Fixture, ...more: string[]): Promise<void> {
  expect(await f.run(advert, '--submit', ...more)).toBe(0);
}
/** The run that a precondition stops: exit 2, the text holds `reason`, and the tool was not called to build. */
async function stops(f: Fixture, reason: string, ...argv: string[]): Promise<void> {
  expect(await f.run(advert, '--submit', ...argv)).toBe(2);
  expect(errors(f)).toContain(reason);
  expect(f.w.machine()).toMatchObject({ outcome: 'stopped', exit: 2 });
  expect(f.hosted.calls.filter((call) => BUILD_TOOLS.includes(call.name))).toEqual([]);
}

// ---- the dry run ----

describe('advert: the dry run', () => {
  it('reads the manifest twice, 5 s apart, shows the hash and the terms, builds the advert, and signs, submits and writes nothing', async () => {
    const f = await stakeAdvertWorld({ go: null });
    expect(await f.run(advert)).toBe(0);
    expect(f.w.machine()).toMatchObject({ task: 'advert', mode: 'dry', outcome: 'dry', exit: 0, step: 'reorder-agent:reorder-agent-v1' });
    expect(f.net.manifestReads(REORDER_ADVERT.origin)).toBe(2);
    expect(f.w.clock.slept).toContain(5_000);
    const text = bodyOf(f, REORDER);
    const hash = sha(text);
    expect(f.hosted.calls).toEqual([{
      name: POST,
      args: {
        changeAddress: f.w.keys.registry.addressOf('reorder-supplier'), did: f.didOf(REORDER), supplier_key_hash: f.hash('reorder-supplier'), capability_id: REORDER.capability, model: 'reorder-agent-v1',
        max_output_tokens: 0, max_processing_ms: 1_800_000, price_lovelace: 3_000_000, supplier_bond_lovelace: 1_000_000, buyer_bond_lovelace: 1_000_000, endpoint_url: REORDER_ADVERT.origin,
        detail_uri: `${REORDER_ADVERT.origin}/agent.json`, detail_hash: hash, deposit_lovelace: 2_500_000,
      },
    }]);
    const lines = f.w.screen.lines;
    expect(lines).toContain('advert reorder-agent-v1 of reorder-agent (Reorder Agent)');
    expect(lines).toContain(`manifest: ${REORDER_ADVERT.origin}/agent.json, ${Buffer.byteLength(text)} bytes, SHA-256 ${hash}, read twice 5 s apart with equal bytes`);
    expect(lines).toContain('deposit: 2.500000 units');
    nothingSigned(f);
    expect(f.w.facts().adverts).toEqual({});
    expect(f.w.facts().manifests).toEqual({});
    expect(f.w.evidence('advert')).toEqual([]);
    expect(f.w.exposure()).toEqual([]);
  });
});

// ---- the landing ----

describe('advert: the landing', () => {
  it('lands with the supplier key as its one signer, no mint and the hash that was read, reads the reference from the bytes, and writes the facts', async () => {
    const f = await stakeAdvertWorld();
    await land(f);
    expect(f.signs).toEqual([f.hash('reorder-supplier')]);
    const bytes = factsOf(f.world.chain.applied[0]!);
    const index = bytes.outputs.findIndex((output) => output.address === ADDRESS);
    const ref = `${bytes.txHash}#${index}`;
    expect(index).toBeGreaterThanOrEqual(0);
    expect(bytes.mint).toEqual({});
    expect(bytes.runsScripts).toBe(false);
    expect(bytes.outputs[index]!.lovelace).toBe(2_500_000n);
    const datum = decodeIdentityAdvertDatum(bytes.outputs[index]!.inlineDatum!);
    const hash = sha(bodyOf(f, REORDER));
    expect(datum).toMatchObject({ supplier_pkh: f.hash('reorder-supplier'), detail_hash: hash, detail_uri: `${REORDER_ADVERT.origin}/agent.json`, agent_id: f.idOf(REORDER), status: 'Active', model: 'reorder-agent-v1' });
    const facts = f.w.facts();
    expect(facts.adverts['reorder-agent']).toEqual({ 'reorder-agent-v1': { ref, tx: bytes.txHash, detailUri: `${REORDER_ADVERT.origin}/agent.json`, detailHash: hash, endpoint: REORDER_ADVERT.origin, postedAt: expect.any(String) } });
    expect(facts.manifests['reorder-agent']).toEqual({ uri: `${REORDER_ADVERT.origin}/agent.json`, sha256: hash, bytes: Buffer.byteLength(bodyOf(f, REORDER)), readAt: expect.any(String) });
    expect(f.hosted.calls.at(-1)).toEqual({ name: LIST, args: { capability_id: REORDER.capability, only_free: false, limit: 50 } });
    expect(f.w.evidence('advert').map((entry) => `${String(entry.step)}:${String(entry.status)}`)).toEqual(['reorder-agent:reorder-agent-v1:confirmed', 'reorder-agent:reorder-agent-v1:verified']);
    expect(f.w.machine()).toMatchObject({ mode: 'submit', outcome: 'done', step: 'reorder-agent:reorder-agent-v1' });
    expect(f.w.machine().result).toMatchObject({ agent: 'reorder-agent', model: 'reorder-agent-v1', ref, tx: bytes.txHash });
    expect(f.w.state('advert').notes['part.reorder-agent:reorder-agent-v1']).toMatchObject({ verified_at: expect.any(String), refs: { ref } });
  });
  it('reads the reference of the advert from the bytes, and never from the answer of the tool', async () => {
    const f = await stakeAdvertWorld();
    const claimed = `${'12'.repeat(32)}#7`;
    f.hosted.twist.post = { claimRef: claimed };
    await land(f);
    const bytes = factsOf(f.world.chain.applied[0]!);
    const held = f.w.facts().adverts['reorder-agent']!['reorder-agent-v1']!.ref;
    expect(held).not.toBe(claimed);
    expect(held).toBe(`${bytes.txHash}#${bytes.outputs.findIndex((output) => output.address === ADDRESS)}`);
    expect(f.w.state('advert').notes['part.reorder-agent:reorder-agent-v1']).toMatchObject({ refs: { ref: held } });
  });
  it('runs the four adverts with --all: the three adverts of the Order Desk hold one hash, and the manifest fact is set once', async () => {
    const f = await stakeAdvertWorld();
    await land(f, '--all');
    expect(f.w.machine()).toMatchObject({ outcome: 'finished', exit: 0 });
    expect(f.signs).toEqual(['reorder-supplier', 'order-small-supplier', 'order-medium-supplier', 'order-large-supplier'].map((name) => f.hash(name)));
    const facts = f.w.facts();
    const lots = facts.adverts['order-desk']!;
    expect(Object.keys(lots)).toEqual(['lot-small', 'lot-medium', 'lot-large']);
    expect(new Set(Object.values(lots).map((one) => one.detailHash))).toEqual(new Set([sha(bodyOf(f, ORDER_DESK))]));
    expect(facts.manifests['order-desk']).toMatchObject({ uri: `${SMALL.origin}/agent.json`, sha256: sha(bodyOf(f, ORDER_DESK)) });
    expect(Object.values(lots).map((one) => one.endpoint)).toEqual([SMALL.origin, MEDIUM.origin, LARGE.origin]);
    for (const runtime of [SMALL, MEDIUM, LARGE]) expect(f.net.manifestReads(runtime.origin)).toBe(2);
    expect(advertsOnNode(f).filter((ref) => ref !== ADVERT_REF)).toHaveLength(4);
  });
  it('verifies the advert in the list while the indexer is behind, and fails with exit 1 when the list never shows it', async () => {
    const f = await stakeAdvertWorld();
    f.hosted.listLag = 3;
    await land(f);
    expect(f.hosted.calls.filter((call) => call.name === LIST)).toHaveLength(4);
    expect(f.w.state('advert').notes['part.reorder-agent:reorder-agent-v1']).toMatchObject({ verified_at: expect.any(String) });
    const g = await stakeAdvertWorld();
    g.hosted.listLag = 1_000;
    expect(await g.run(advert, '--submit')).toBe(1);
    expect(errors(g)).toContain('the list of supplychain.reorder.po.v1 does not show the advert');
    expect(g.w.state('advert').notes['part.reorder-agent:reorder-agent-v1']).not.toHaveProperty('verified_at');
    expect(g.w.facts().adverts['reorder-agent']).toBeDefined();
  });
  it('refuses a second advert for a model whose advert the facts file holds and the node shows', async () => {
    const f = await stakeAdvertWorld();
    await land(f);
    f.hosted.calls.length = 0;
    await stops(f, 'and it is on the node: retire it with the cleanup before a new advert is posted', '--run', 'again');
    expect(f.world.chain.applied).toHaveLength(1);
  });
});

// ---- the manifest ----

describe('advert: the manifest', () => {
  it('stops for two reads that differ, and builds nothing. The twin with two equal reads lands', async () => {
    const f = await stakeAdvertWorld();
    let reads = 0;
    serve(f, REORDER_ADVERT, () => `${bodyOf(f, REORDER)}${reads++ === 0 ? '' : ' '}`);
    await stops(f, 'gave different bytes');
    expect(errors(f)).toContain(sha(bodyOf(f, REORDER)));
    nothingSigned(f);
    serve(f, REORDER_ADVERT, bodyOf(f, REORDER));
    await land(f);
  });
  it('stops for a status that is not 200, a request that fails, and a body that is no JSON object or is too long, and builds nothing', async () => {
    const f = await stakeAdvertWorld();
    const cases: Array<[string, () => Response, string]> = [
      ['a 500', () => new Response('error', { status: 500 }), 'answers with the status 500'],
      ['a redirect', () => new Response('', { status: 302, headers: { location: 'https://elsewhere.example/agent.json' } }), 'answers with the status 302'],
      ['a failed request', () => { throw new Error('the connection broke'); }, 'the request failed'],
      ['a body that is no JSON', () => new Response('<html>not the manifest</html>', { status: 200 }), 'is not JSON'],
      ['a JSON list', () => new Response('[1,2]', { status: 200 }), 'is not a JSON object'],
      ['bytes that are no UTF-8', () => new Response(new Uint8Array([0x7b, 0xff, 0x7d]), { status: 200 }), 'is not JSON'],
      ['a body over the limit', () => new Response(JSON.stringify({ pad: 'x'.repeat(LIMIT) }), { status: 200 }), `is longer than ${LIMIT} bytes`],
    ];
    for (const [label, answer, reason] of cases) {
      f.net.manifests.set(REORDER_ADVERT.origin, answer);
      await stops(f, reason);
      expect(errors(f), label).not.toContain('<html>');
    }
    nothingSigned(f);
    // The twin: a body of exactly the limit lands. One byte more is refused.
    const manifest = manifestOfAgent(f, REORDER);
    const base = Buffer.byteLength(JSON.stringify({ ...manifest, pad: '' }));
    const padded = (extra: number): string => JSON.stringify({ ...manifest, pad: 'x'.repeat(LIMIT - base + extra) });
    expect(Buffer.byteLength(padded(0))).toBe(LIMIT);
    serve(f, REORDER_ADVERT, padded(1));
    await stops(f, `is longer than ${LIMIT} bytes`);
    serve(f, REORDER_ADVERT, padded(0));
    await land(f);
  });
  const reorderCases: Array<[string, (m: ReorderManifest) => void, string]> = [
    ['another capability', (m) => { m.capability_id = 'supplychain.other.v1'; }, 'capability_id is '],
    ['another DID', (m) => { m.identity.did = `did:vector:${'ab'.repeat(32)}`; }, 'identity.did is '],
    ['another price', (m) => { m.terms.price_lovelace = 3_000_001; }, 'terms.price_lovelace is '],
    ['another supplier bond', (m) => { m.terms.supplier_bond_lovelace = 1; }, 'terms.supplier_bond_lovelace is '],
    ['another buyer bond', (m) => { m.terms.buyer_bond_lovelace = 2_000_000; }, 'terms.buyer_bond_lovelace is '],
    ['another window', (m) => { m.terms.max_processing_ms = 1_800_001; }, 'terms.max_processing_ms is '],
    ['another supplier key', (m) => { m.keys.supplier_pkh = 'cd'.repeat(28); }, 'keys.supplier_pkh is '],
    ['a price as text', (m) => { m.terms.price_lovelace = '3000000'; }, 'terms.price_lovelace is '],
  ];
  for (const [label, change, name] of reorderCases) {
    it(`stops for a manifest of the Reorder Agent with ${label}: exit 2 with the name of the member, and nothing is built. The twin lands`, async () => {
      const f = await stakeAdvertWorld();
      const manifest = structuredClone(manifestOfAgent(f, REORDER)) as unknown as ReorderManifest; // the shape that manifestOf gives for the Reorder Agent
      change(manifest);
      serve(f, REORDER_ADVERT, JSON.stringify(manifest));
      await stops(f, name);
      expect(errors(f)).toContain('does not agree with the advert reorder-agent-v1');
      nothingSigned(f);
      serve(f, REORDER_ADVERT, bodyOf(f, REORDER));
      await land(f);
    });
  }
  const tierCases: Array<[string, (tiers: Tier[]) => Tier[], string]> = [
    ['another price in the tier', (tiers) => { tiers[0]!.price_lovelace = 2_000_001; return tiers; }, 'terms.tiers[lot-small].price_lovelace is '],
    ['another window in the tier', (tiers) => { tiers[0]!.max_processing_ms = 1; return tiers; }, 'terms.tiers[lot-small].max_processing_ms is '],
    ['another supplier key in the tier', (tiers) => { tiers[0]!.supplier_pkh = 'cd'.repeat(28); return tiers; }, 'terms.tiers[lot-small].supplier_pkh is '],
    ['the supplier key of another tier', (tiers) => { tiers[0]!.supplier_pkh = tiers[1]!.supplier_pkh; return tiers; }, 'terms.tiers[lot-small].supplier_pkh is '],
    ['no tier for the model', (tiers) => tiers.slice(1), 'terms.tiers holds 0 tier(s) for the model lot-small'],
    ['two tiers for the model', (tiers) => [...tiers, tiers[0]!], 'terms.tiers holds 2 tier(s) for the model lot-small'],
  ];
  for (const [label, change, name] of tierCases) {
    it(`stops for a manifest of the Order Desk with ${label}: exit 2 with the name of the member. The twin lands`, async () => {
      const f = await stakeAdvertWorld();
      await land(f);
      f.hosted.calls.length = 0;
      const manifest = structuredClone(manifestOfAgent(f, ORDER_DESK)) as unknown as OrderManifest; // the shape that manifestOf gives for the Order Desk
      manifest.terms.tiers = change(manifest.terms.tiers);
      serve(f, SMALL, JSON.stringify(manifest));
      await stops(f, name);
      expect(f.world.chain.applied).toHaveLength(1);
      serve(f, SMALL, bodyOf(f, ORDER_DESK));
      await land(f);
      expect(f.world.chain.applied).toHaveLength(2);
    });
  }
  it('refuses an advert of the Order Desk when the service serves another hash than the first advert on the node holds. The twin with the same hash lands', async () => {
    const f = await stakeAdvertWorld();
    await land(f);
    await land(f);
    f.hosted.calls.length = 0;
    serve(f, MEDIUM, JSON.stringify({ ...manifestOfAgent(f, ORDER_DESK), revision: 2 }));
    await stops(f, 'the adverts of one agent share one manifest hash');
    expect(errors(f)).toContain(sha(bodyOf(f, ORDER_DESK)));
    expect(errors(f)).toContain('the advert(s) lot-small of order-desk on the node');
    expect(f.world.chain.applied).toHaveLength(2);
    serve(f, MEDIUM, bodyOf(f, ORDER_DESK));
    await land(f);
    expect(f.w.facts().adverts['order-desk']!['lot-medium']!.detailHash).toBe(f.w.facts().adverts['order-desk']!['lot-small']!.detailHash);
  });
});

// ---- the record, the wallet and the runtimes ----

describe('advert: the record, the wallet and the runtimes', () => {
  const supplierKey = (purposes: number) => (agent: AgentSpec, keys: { publicKeyOf(name: string): string }) => ({
    keys: [{ keyType: 'Ed25519' as const, key: keys.publicKeyOf(agent.adverts[0]!.supplierKey), purposes, pop: null }],
  });
  it('stops for a record that the facts file does not hold, and for one that the node does not show', async () => {
    await stops(await stakeAdvertWorld({ facts: false }), 'the facts file holds no record of reorder-agent');
    const f = await stakeAdvertWorld();
    f.world.chain.held = f.world.chain.held.filter((utxo) => !Object.keys(utxo.assets).some((unit) => unit.endsWith(f.idOf(REORDER))));
    await stops(f, 'is not on the node');
  });
  it('stops for a supplier key that the record lists with another purpose, or does not list. The twin lists it with the transaction purpose and lands', async () => {
    await stops(await stakeAdvertWorld({ record: supplierKey(1) }), 'does not list the supplier key reorder-supplier with the transaction purpose');
    await stops(await stakeAdvertWorld({ record: () => ({ keys: [] }) }), 'does not list the supplier key reorder-supplier with the transaction purpose');
    await land(await stakeAdvertWorld({ record: supplierKey(1 + 8) }));
  });
  it('stops for a record that does not list the capability, or is not Active', async () => {
    await stops(await stakeAdvertWorld({ record: () => ({ capabilities: [] }) }), 'does not list the capability supplychain.reorder.po.v1, byte for byte');
    await stops(await stakeAdvertWorld({ record: () => ({ status: { type: 'Retired', at: NOW - 86_400_000, successor: null } }) }), 'is Retired: it must be Active');
  });
  it('stops for a supplier wallet with no pure output of 5 units or more', async () => {
    await stops(await stakeAdvertWorld({ wallets: { 'reorder-supplier': [3_000_000n, 2_000_000n] } }), 'has no pure output of 5 units or more');
  });
  it('does not stop for a runtime that is not in running-images.json, also when its host would answer 502, and does not ask it', async () => {
    const f = await stakeAdvertWorld();
    f.net.statuses.set(REORDER_ADVERT.origin, () => new Response('', { status: 502 }));
    await land(f);
    expect(f.net.statusReads(REORDER_ADVERT.origin)).toBe(0);
    expect(f.w.screen.lines).toContain('the runtime reorder-runtime is not running: it is not in running-images.json, so it holds no job');
  });
  it('stops for a runtime that is listed and says working, and for a listed runtime that cannot be asked. The twin where it says free lands', async () => {
    const f = await stakeAdvertWorld();
    f.setRunning(['reorder-runtime']);
    f.net.statuses.set(REORDER_ADVERT.origin, () => new Response(JSON.stringify({ status: 'working' }), { status: 200 }));
    await stops(f, 'the runtime reorder-runtime says working: a job runs');
    f.net.statuses.set(REORDER_ADVERT.origin, () => new Response('', { status: 502 }));
    await stops(f, 'cannot tell whether the runtime reorder-runtime works');
    expect(f.net.manifestReads(REORDER_ADVERT.origin)).toBe(0);
    f.net.statuses.set(REORDER_ADVERT.origin, () => new Response(JSON.stringify({ status: 'free' }), { status: 200 }));
    await land(f);
  });
  it('stops when running-images.json is missing: the file decides alone', async () => {
    const f = await stakeAdvertWorld();
    rmSync(join(f.w.stateDir, 'running-images.json'));
    await stops(f, 'running-images.json does not exist');
    expect(f.net.manifestReads(REORDER_ADVERT.origin)).toBe(0);
  });
});

// ---- the guards judge the bytes ----

describe('advert: the guards judge the bytes of the build', () => {
  async function guarded(f: Fixture, guard: string, reason: string): Promise<void> {
    expect(await f.run(advert, '--submit')).toBe(2);
    expect(refusedBy(errors(f))).toContain(guard);
    expect(errors(f)).toContain(reason);
    expect(f.hosted.built).toHaveLength(1);
    nothingSigned(f);
  }
  it('refuses a build that lists another key as a signer, and one that leaves out the supplier key: signers. The twin lands', async () => {
    const f = await stakeAdvertWorld();
    f.hosted.twist.post = { signers: [f.hash('reorder-supplier'), f.hash('reorder-service')] };
    await guarded(f, 'signers', 'extra');
    f.hosted.twist.post = { signers: [f.hash('reorder-service')] };
    expect(await f.run(advert, '--submit')).toBe(2);
    expect(refusedBy(errors(f))).toEqual(['signers']);
    nothingSigned(f);
    delete f.hosted.twist.post;
    await land(f);
  });
  it('refuses an advert that mints a token: the guard mint, because the plan of an advert has no mint. The twin lands', async () => {
    const f = await stakeAdvertWorld();
    f.hosted.twist.post = { mint: { [`${'ab'.repeat(28)}${Buffer.from('advert', 'utf8').toString('hex')}`]: 1n } };
    await guarded(f, 'mint', 'the transaction mints 1 of');
    expect(refusedBy(errors(f))).toEqual(['mint']);
    delete f.hosted.twist.post;
    await land(f);
    expect(factsOf(f.world.chain.applied[0]!).mint).toEqual({});
  });
  it('refuses an advert output at another address, and a payment to another address besides the advert: destinations', async () => {
    const f = await stakeAdvertWorld();
    f.hosted.twist.post = { address: OUTSIDE };
    await guarded(f, 'destinations', 'has 0 output(s) at the advert address');
    f.hosted.twist.post = { extra: { address: OUTSIDE, lovelace: 1_000_000n } };
    expect(await f.run(advert, '--submit')).toBe(2);
    expect(refusedBy(errors(f))).toEqual(['destinations']);
    expect(errors(f)).toContain(`an output goes to ${OUTSIDE}`);
    nothingSigned(f);
  });
  it('refuses an advert whose datum holds another hash than the one that was read, or another price than the data', async () => {
    const f = await stakeAdvertWorld();
    f.hosted.twist.post = { detailHash: 'ef'.repeat(32) };
    await guarded(f, 'destinations', `detail_hash is "${'ef'.repeat(32)}", and the data has "${sha(bodyOf(f, REORDER))}"`);
    f.hosted.twist.post = { price: 4_000_000n };
    expect(await f.run(advert, '--submit')).toBe(2);
    expect(errors(f)).toContain('price_lovelace is "4000000", and the data has "3000000"');
    nothingSigned(f);
  });
  it('stops with exit 2 and the message of the tool when the tool refuses, and writes the refusal to the evidence', async () => {
    const f = await stakeAdvertWorld();
    f.hosted.twist.post = { refuse: 'Failed to build: the record does not list the key' };
    expect(await f.run(advert, '--submit')).toBe(2);
    expect(f.w.evidence('advert')).toMatchObject([{ status: 'tool_refused', tool: POST, message: 'Failed to build: the record does not list the key' }]);
    nothingSigned(f);
  });
});

// ---- the cleanup ----

describe('advert: the cleanup', () => {
  it('runs the free check first, and retires one recorded advert for each run: the plan explains the advert output, mints nothing, and leaves an advert that the facts do not hold', async () => {
    const f = await stakeAdvertWorld();
    await land(f, '--all');
    const refs = Object.values(f.w.facts().adverts).flatMap((lots) => Object.values(lots).map((one) => one.ref));
    expect(refs).toHaveLength(4);
    f.hosted.calls.length = 0;
    f.setRunning(['reorder-runtime']);
    f.net.statuses.set(REORDER_ADVERT.origin, () => new Response(JSON.stringify({ status: 'working' }), { status: 200 }));
    expect(await f.run(advert, 'cleanup', '--submit')).toBe(2);
    expect(errors(f)).toContain('the runtime reorder-runtime says working: a job runs');
    expect(f.hosted.calls).toEqual([]);
    f.setRunning([]);
    const before = f.signs.length;
    expect(await f.run(advert, 'cleanup', '--submit')).toBe(0);
    expect(f.w.machine()).toMatchObject({ command: 'cleanup', outcome: 'done' });
    expect(f.signs.slice(before)).toEqual([f.hash('reorder-supplier')]);
    expect(f.hosted.calls).toEqual([{ name: RETIRE, args: { changeAddress: f.w.keys.registry.addressOf('reorder-supplier'), advert_ref: refs[0] } }]);
    const bytes = factsOf(f.world.chain.applied.at(-1)!);
    expect(bytes.inputs).toContain(refs[0]);
    expect(bytes.mint).toEqual({});
    expect(advertsOnNode(f)).not.toContain(refs[0]);
    for (const ref of [...refs.slice(1), ADVERT_REF]) expect(advertsOnNode(f)).toContain(ref);
    expect(f.w.facts().adverts['reorder-agent']!['reorder-agent-v1']!.ref).toBe(refs[0]);
    expect(f.w.state('advert').notes['part.retire:reorder-agent:reorder-agent-v1']).toMatchObject({ refs: { retiredRef: refs[0] } });
  });
  it('retires the rest with --all, never the advert that the facts do not hold, and then finds nothing to retire', async () => {
    const f = await stakeAdvertWorld();
    await land(f, '--all');
    const refs = Object.values(f.w.facts().adverts).flatMap((lots) => Object.values(lots).map((one) => one.ref));
    expect(await f.run(advert, 'cleanup', '--submit', '--all')).toBe(0);
    expect(f.w.machine()).toMatchObject({ outcome: 'finished' });
    expect(advertsOnNode(f)).toEqual([ADVERT_REF]);
    expect(f.hosted.calls.filter((call) => call.name === RETIRE).map((call) => call.args.advert_ref)).toEqual(refs);
    f.hosted.calls.length = 0;
    expect(await f.run(advert, 'cleanup', '--submit')).toBe(0);
    expect(f.w.screen.lines).toContain('no advert that the facts file holds is on the node: there is nothing to retire');
    expect(f.hosted.calls).toEqual([]);
  });
  it('shows the retirement in a dry run, and signs nothing; and it needs an approval that lists the task', async () => {
    const f = await stakeAdvertWorld();
    await land(f);
    const applied = f.world.chain.applied.length;
    const signed = f.signs.length;
    expect(await f.run(advert, 'cleanup')).toBe(0);
    expect(f.w.machine()).toMatchObject({ command: 'cleanup', mode: 'dry', outcome: 'dry' });
    expect(f.w.screen.lines.some((line) => line.startsWith('retire the advert reorder-agent-v1 of reorder-agent'))).toBe(true);
    f.w.writeGo({ tasks: ['stake'], irreversible: ['stake'], capUnits: 200 });
    expect(await f.run(advert, 'cleanup', '--submit')).toBe(2);
    expect(errors(f)).toContain('the approval does not list the task advert');
    expect(f.world.chain.applied).toHaveLength(applied);
    expect(f.signs).toHaveLength(signed);
  });
  it('refuses a retirement that spends another advert than the recorded one, and one that pays the deposit to another address', async () => {
    const f = await stakeAdvertWorld();
    await land(f);
    f.hosted.twist.retire = { spend: ADVERT_REF, signers: [f.hash('reorder-supplier')] };
    expect(await f.run(advert, 'cleanup', '--submit')).toBe(2);
    expect(refusedBy(errors(f))).toContain('inputs');
    f.hosted.twist.retire = { address: OUTSIDE };
    expect(await f.run(advert, 'cleanup', '--submit')).toBe(2);
    expect(refusedBy(errors(f))).toContain('destinations');
    expect(f.world.chain.applied).toHaveLength(1);
    expect(f.signs).toHaveLength(1);
    delete f.hosted.twist.retire;
    expect(await f.run(advert, 'cleanup', '--submit')).toBe(0);
  });
  it('lets a new advert replace a retired one: the facts of the advert and of the manifest are replaced, and the new hash is the hash of the new manifest', async () => {
    const f = await stakeAdvertWorld();
    await land(f, '--all');
    const old = f.w.facts();
    expect(await f.run(advert, 'cleanup', '--submit', '--all')).toBe(0);
    for (const agent of USE.agents) for (const runtime of agent.adverts) serve(f, runtime, JSON.stringify({ ...manifestOfAgent(f, agent), revision: 2 }));
    await land(f, '--run', 'second', '--all');
    const now = f.w.facts();
    for (const agent of USE.agents) {
      expect(now.manifests[agent.id]!.sha256).toBe(sha(JSON.stringify({ ...manifestOfAgent(f, agent), revision: 2 })));
      expect(now.manifests[agent.id]!.sha256).not.toBe(old.manifests[agent.id]!.sha256);
      for (const runtime of agent.adverts) {
        expect(now.adverts[agent.id]![runtime.model]!.ref).not.toBe(old.adverts[agent.id]![runtime.model]!.ref);
        expect(advertsOnNode(f)).toContain(now.adverts[agent.id]![runtime.model]!.ref);
      }
    }
  });
});

// ---- the data and the output ----

describe('advert: the data and the output', () => {
  it('lists the steps of the data in order, and shows no seed in the output, the state, the facts or the evidence', async () => {
    const f = await stakeAdvertWorld();
    expect(advert.steps(USE, { has: () => false, value: () => undefined })).toEqual(['reorder-agent:reorder-agent-v1', 'order-desk:lot-small', 'order-desk:lot-medium', 'order-desk:lot-large']);
    expect(USE.agents.flatMap((agent) => agent.adverts.map((one) => one.depositLovelace))).toEqual([2_500_000n, 2_500_000n, 2_500_000n, 2_500_000n]);
    await land(f, '--all');
    const text = f.w.allText();
    for (const name of ['reorder-supplier', 'order-small-supplier', 'order-medium-supplier', 'order-large-supplier']) expect(text).not.toContain(f.w.keys.seedOf(name));
  });
});
