// scripts/operator/test/end-state.test.ts - the task `end-state` through the real runner, over a fixture ledger (the records, the delegations, the Module-1 claims and the wallets of the kit tests), a fake
// hosted server (the gateway and the indexer of the marketplace), and a fake `fetch` for the manifest of Module-1 and the status of the four runtimes. A state in which all is well gives exit 0. Each
// check fails alone, with its exit and its line. The task signs nothing. No test uses the network or DNS.
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { describe, expect, it, vi } from 'vitest';
import { testKey } from '../../../packages/buyer-core/test/fixtures/identity-world.ts';
import { AUDITOR_ID, CLAIMER_ID, MODULE1, MODULE1_MANIFEST, agentRecord, claimUtxo, recordUtxo } from '../../../packages/buyer-core/test/fixtures/jury-world.ts';
import { MAINNET, delegation, delegationUtxo } from '../../../packages/buyer-core/test/fixtures/ledger-read-world.ts';
import { LedgerProvider, koiosOf, ledgerWorld } from '../../../packages/usecase-kit/test/dispute/ledger.ts';
import { HostedError } from '../../checks/lib/hosted.ts';
import { iso } from '../../checks/lib/format.ts';
import type { ChainAccess } from '../../checks/lib/session.ts';
import { FactsFile } from '../lib/facts.ts';
import { LEGACY_PUBLIC_MANIFEST, publicManifestFile, writePublicManifest } from '../lib/registry.ts';
import { runTask } from '../lib/runner.ts';
import endState from '../tasks/end-state.ts';
import data from '../usecases/inventory-reorder.ts';
import { PackHosted } from './support/pack-hosted.ts';
import { NOW, USE_CASE, hashOf, taskWorld } from './support/task-world.ts';
import type { TaskWorld } from './support/task-world.ts';

// The host lookup of the manifest reader finds a public address, so that no test asks the resolver. The fetch of the world answers the request.
vi.mock('node:dns/promises', () => ({ lookup: async () => [{ address: '140.82.114.4', family: 4 }] }));

const DAY = 86_400_000;
const HOUR = 3_600_000;
const COMMIT = 'a4bc735c48d9d280374637b7e071a01f0086e7aa';
const MANIFEST_URL = `https://raw.githubusercontent.com/Apex-Fusion/vector-agent-modules/${COMMIT}/${data.moduleManifestPath}`;
const IMAGE = `ghcr.io/apex-fusion/vector-service-agents/agent@sha256:${'ab'.repeat(32)}`;
const CLAIM_TOKEN = `636c6d5f${'0f'.repeat(28)}`;
const REORDER = data.agents[0]!;
const ORDER = data.agents[1]!;
const REORDER_ID = CLAIMER_ID;
const ORDER_ID = AUDITOR_ID;
const READER_ID = 'd1'.repeat(32);
const CONTAINERS = data.agents.flatMap((agent) => agent.adverts.map((advert) => advert.runtimeContainer));
const STATUS_URLS = data.agents.flatMap((agent) => agent.adverts.map((advert) => `${advert.origin}/status`));
const SLOW = 240_000;
const FAIR_FLOAT = 1_000_000_000n;

const did = (id: string): string => `did:vector:${id}`;
const hash = (name: string): string => hashOf(`end-state ${name}`);
const ref = (name: string): string => `${hash(name)}#0`;

// The records are made once: `recordUtxo` gives each record a transaction hash from a counter that has room for few records.
const ACTIVE_REORDER = recordUtxo(REORDER_ID, agentRecord());
const ACTIVE_ORDER = recordUtxo(ORDER_ID, agentRecord());
const holdOf = (by: { type: 'Script'; hash: string } | { type: 'KeyHash'; hash: string }, reason: number, until: number) => ({ by, reason, since: NOW - 2 * HOUR, until });
const JURY_UNTIL = NOW + 7 * DAY - 2 * HOUR;
const JURY_HELD = recordUtxo(ORDER_ID, agentRecord({ status: { type: 'Suspended', holds: [holdOf({ type: 'Script', hash: MODULE1.claim.hash }, 64, JURY_UNTIL)] } }));
const PARTY_UNTIL = NOW + DAY;
const PARTY_HELD = recordUtxo(ORDER_ID, agentRecord({ status: { type: 'Suspended', holds: [holdOf({ type: 'KeyHash', hash: testKey(3).keyHash }, 6, PARTY_UNTIL)] } }));
const MIXED_HELD = recordUtxo(ORDER_ID, agentRecord({ status: { type: 'Suspended', holds: [holdOf({ type: 'Script', hash: MODULE1.claim.hash }, 64, JURY_UNTIL), holdOf({ type: 'KeyHash', hash: testKey(3).keyHash }, 6, PARTY_UNTIL)] } }));
const EXPIRED_HOLD = recordUtxo(ORDER_ID, agentRecord({ status: { type: 'Suspended', holds: [holdOf({ type: 'KeyHash', hash: testKey(3).keyHash }, 6, NOW - HOUR)] } }));
const REVOKED = recordUtxo(ORDER_ID, agentRecord({ status: { type: 'Revoked', by: { type: 'ControllerSet' }, reason: 1, at: NOW - DAY, invalidFrom: null, successor: null } }));
const RETIRED = recordUtxo(ORDER_ID, agentRecord({ status: { type: 'Retired', at: NOW - DAY, successor: null } }));

type Result = 'ok' | 'wait' | 'fail';
const ALL_CHECKS = [
  'record_active:reorder-agent', 'record_active:order-desk', 'organisation:reorder-agent', 'organisation:order-desk', 'adverts', 'claims:reorder-agent', 'claims:order-desk', 'delegations', 'holds', 'wallets',
  'attestations', 'runtimes',
];

interface Row { advert_ref: string; capability_id: string; model: string; agent_id: string; did: string; status: string }
interface Gateway { verified: boolean; listed: string[]; parties: boolean }

interface Rig {
  readonly world: TaskWorld;
  readonly ledger: LedgerProvider;
  readonly hosted: PackHosted;
  readonly facts: FactsFile;
  readonly gateway: Map<string, Gateway>;
  /** The adverts that the indexer lists. */
  listing: Row[];
  /** What each status address answers: the word of the status, an HTTP status code, or `hang` for a request that never gets an answer (a fetch that ignores the abort signal). */
  readonly statuses: Map<string, string | number>;
  readonly webCalls: string[];
  /** Puts a record on the ledger in place of the record of the same agent. */
  setRecord(id: string, utxo: LedgerProvider['live'][number]): void;
  /** Gives a wallet exactly these outputs. */
  setWallet(name: string, outputs: readonly bigint[]): void;
  writeRunning(containers?: readonly string[], at?: number): void;
  run(...argv: string[]): Promise<number>;
  checks(): Map<string, { result: Result; text: string }>;
  errors(): string;
}

async function makeRig(options: { env?: Record<string, string | undefined>; skipAttestation?: string } = {}): Promise<Rig> {
  const names = data.funding.map((line) => line.wallet);
  const world = await taskWorld({
    keys: names, shared: ['fee'], env: { OPERATOR_MODULE1_COMMIT: COMMIT, ...options.env },
    use: { title: data.title, agents: data.agents, subagents: data.subagents, organisations: data.organisations, funding: data.funding, attestations: data.attestations, runs: data.runs, moduleManifestPath: data.moduleManifestPath },
  });
  mkdirSync(world.stateDir, { recursive: true, mode: 0o700 });
  chmodSync(world.stateDir, 0o700);
  writePublicManifest(join(world.keys.root, publicManifestFile(USE_CASE)), world.keys.registry, { network: 'vector-mainnet', useCase: USE_CASE });
  const ledger = ledgerWorld([], [ACTIVE_REORDER, ACTIVE_ORDER]);
  const facts = FactsFile.open(join(world.stateDir, 'facts.json'), { useCase: USE_CASE, network: 'vector-mainnet' });
  const statuses = new Map<string, string | number>(STATUS_URLS.map((url) => [url, 'free']));
  const webCalls: string[] = [];
  const gateway = new Map<string, Gateway>();
  const listing: Row[] = [];
  const web: typeof fetch = async (input) => {
    const url = String(input);
    webCalls.push(url);
    if (url === MANIFEST_URL) return new Response(JSON.stringify(MODULE1_MANIFEST), { status: 200 });
    const status = statuses.get(url);
    if (status === 'hang') return new Promise<Response>(() => undefined);
    if (typeof status === 'string') return new Response(status === 'not json' ? 'not json' : JSON.stringify({ status }), { status: 200 });
    if (typeof status === 'number') return new Response('{}', { status });
    throw new Error('the network was touched');
  };
  const chain: ChainAccess = {
    provider: ledger, deployment: MAINNET, koiosUrl: 'https://koios.test', fetchImpl: koiosOf(ledger),
    context: async () => { throw new Error('the end-state check builds nothing'); }, liveVaultsOf: async () => [],
  };
  const hosted = new PackHosted({
    vector_resolve_did: (args) => {
      const state = gateway.get(String(args.did));
      const agent = data.agents.find((candidate) => did(candidate.id === 'reorder-agent' ? REORDER_ID : ORDER_ID) === args.did)!;
      const domain = data.organisations.find((organisation) => organisation.id === agent.organisation)!.domain;
      const metadata = {
        vectorStatus: { status: 'active', effective: 'active' },
        vectorParties: state!.parties ? [{ role: 'accountable', signer: 'controller', organisation: domain, ...(state!.verified ? { organisationVerified: true } : {}), rights: ['suspend', 'revoke'], notBefore: '2026-10-16T12:00:00Z' }] : [],
        vectorProvenance: { attestations: state!.listed.map((id) => ({ id, type: 'provenance', issuer: 'did:key:z6Mk', issuedAt: '2026-11-01T10:00:00Z', solicited: true, digest: hash('digest') })) },
      };
      return { text: `# DID resolution\n\n**DID:** ${String(args.did)}\n**HTTP status:** 200 (resolved)\n\nThe resolution result from the identity gateway, unchanged:\n\n\`\`\`json\n${JSON.stringify({ didDocument: { id: args.did }, didDocumentMetadata: metadata }, null, 2)}\n\`\`\`` };
    },
    vector_marketplace_list_suppliers: (args) => {
      const rows = rig.listing.filter((row) => row.capability_id === args.capability_id);
      return { text: `${rows.length === 0 ? 'No suppliers found.' : '# Marketplace suppliers'}\n\n\`\`\`json\n${JSON.stringify(rows)}\n\`\`\`` };
    },
  });

  const setWallet = (name: string, outputs: readonly bigint[]): void => {
    const address = world.keys.registry.addressOf(name);
    ledger.live = ledger.live.filter((utxo) => utxo.address !== address);
    outputs.forEach((lovelace, index) => ledger.live.push({ txHash: hash(`wallet ${name} ${index}`), outputIndex: 0, address, assets: { lovelace } }));
  };
  for (const line of data.funding) setWallet(line.wallet, [line.collateralLovelace, line.floatLovelace]);

  // The facts: the records, the adverts, the attestations.
  for (const agent of [...data.agents, ...data.subagents]) {
    const id = agent.id === 'reorder-agent' ? REORDER_ID : agent.id === 'order-desk' ? ORDER_ID : READER_ID;
    facts.put('records', [agent.id], { did: did(id), id, tx: hash(`record ${agent.id}`), recordRef: ref(`record ${agent.id}`), depositLovelace: '10000000', registeredAt: iso(NOW - 20 * DAY) });
  }
  for (const agent of data.agents) {
    const id = agent.id === 'reorder-agent' ? REORDER_ID : ORDER_ID;
    const listed: string[] = [];
    for (const advert of agent.adverts) {
      facts.put('adverts', [agent.id, advert.model], { ref: ref(`advert ${advert.model}`), tx: hash(`advert ${advert.model}`), detailUri: `${advert.origin}/agent.json`, detailHash: hash('detail'), endpoint: advert.origin, postedAt: iso(NOW - 10 * DAY) });
      listing.push({ advert_ref: ref(`advert ${advert.model}`), capability_id: agent.capability, model: advert.model, agent_id: id, did: did(id), status: 'free' });
    }
    for (const type of ['provenance', 'software']) {
      if (options.skipAttestation === 'all' || options.skipAttestation === `${agent.id}/${type}`) continue;
      const attestation = hash(`attestation ${agent.id} ${type}`);
      listed.push(attestation);
      facts.put('attestations', [agent.id, type], { id: attestation, tx: hash(`attest tx ${agent.id} ${type}`), digest: hash('digest'), locator: 'https://example.test/doc', validUntil: iso(NOW + 300 * DAY), issuedAt: iso(NOW - 65 * DAY), envelope: false });
    }
    gateway.set(did(id), { verified: true, listed, parties: true });
  }

  const writeRunning = (containers: readonly string[] = CONTAINERS, at: number = NOW): void => {
    const images = Object.fromEntries(containers.map((container) => [container, IMAGE]));
    writeFileSync(join(world.stateDir, 'running-images.json'), `${JSON.stringify({ generated_at: iso(at), images })}\n`, { mode: 0o600 });
  };
  writeRunning();

  const rig: Rig = {
    world, ledger, hosted, facts, gateway, statuses, webCalls,
    get listing() { return listing; },
    set listing(rows) { listing.splice(0, listing.length, ...rows); },
    setRecord: (id, utxo) => { ledger.live = [...ledger.live.filter((candidate) => candidate.assets[`${MAINNET.identity.hash}${id}`] === undefined), utxo]; },
    setWallet, writeRunning,
    run: (...argv) => runTask(endState, argv, world.deps({ chain, hosted, fetchImpl: web })),
    checks: () => {
      const found = new Map<string, { result: Result; text: string }>();
      for (const line of world.screen.lines) {
        const match = /^(OK|WAIT|FAIL)\s+(\S+): (.*)$/.exec(line);
        if (match !== null) found.set(match[2]!, { result: match[1]!.toLowerCase() as Result, text: match[3]! });
      }
      return found;
    },
    errors: () => world.screen.errorText,
  };
  return rig;
}

/** Every check has the result that `expected` gives for its name, and `ok` when it gives none. */
function expectChecks(rig: Rig, expected: Record<string, Result> = {}): void {
  const found = rig.checks();
  expect([...found.keys()]).toEqual(ALL_CHECKS);
  for (const [name, check] of found) expect(check.result, `${name}: ${check.text}`).toBe(expected[name] ?? 'ok');
}

const openClaim = (over: { claimer?: string; ageMs?: number; windowMs?: number; token?: string; tx?: string; state?: 'Open' | 'Challenged' | 'Validated' | 'Invalidated' } = {}) => ({
  ...claimUtxo(over.token ?? CLAIM_TOKEN, { claimerDid: over.claimer ?? REORDER_ID, challengeWindow: over.windowMs ?? 4 * HOUR, state: over.state ?? 'Open' }, over.ageMs ?? HOUR), txHash: over.tx ?? 'cc'.repeat(32),
});

const claimFact = (over: Record<string, unknown> = {}) => ({
  claimRef: ref('claim'), documentTx: hash('claim document'), claimTx: hash('claim'), claimToken: CLAIM_TOKEN, stakeLovelace: '50000000', windowMs: 86_400_000, stakedAt: iso(NOW - HOUR), withdrawableFrom: iso(NOW + 3 * HOUR),
  withdrawTx: null, ...over,
});

describe('the task end-state', () => {
  it('needs no key, a chain, the two hosted tools that it reads, and no approval, and has no step and no flag', () => {
    expect(endState.name).toBe('end-state');
    expect(endState.needs.keys(data, { has: () => false, value: () => undefined })).toEqual([]);
    expect(endState.needs.chain).toBe(true);
    expect([...endState.needs.hosted].sort()).toEqual(['vector_marketplace_list_suppliers', 'vector_resolve_did']);
    expect(endState.needs.approval).toBe('never');
    expect(endState.steps(data, { has: () => false, value: () => undefined })).toEqual([]);
    expect(endState.flags).toEqual([]);
    expect(endState.valued).toEqual([]);
  });

  describe('a state in which all is well', () => {
    it('gives exit 0, one line for each of the twelve checks, all ok, and the line DONE', async () => {
      const rig = await makeRig();
      expect(await rig.run()).toBe(0);
      expectChecks(rig);
      expect(rig.world.screen.lines).toContain('end state: DONE: every check is ok');
      expect(rig.world.screen.lines).toContain('the end state is reached: every check is ok');
      const line = rig.world.machine();
      expect(line).toMatchObject({ task: 'end-state', command: 'run', outcome: 'finished', exit: 0, step: null, result: { verdict: 'done' } });
      expect((line.result.checks as unknown[]).length).toBe(12);
    }, SLOW);

    it('reads only: the ledger takes no transaction, the facts and the state hold nothing new, and no runtime or manifest read is a write', async () => {
      const rig = await makeRig();
      expect(await rig.run('--submit')).toBe(0);
      expect(rig.ledger.accepted).toEqual([]);
      expect(rig.ledger.raw).toEqual([]);
      expect(rig.world.state('end-state').steps).toEqual({});
      expect(rig.world.state('end-state').in_flight).toBeNull();
      expect(rig.webCalls.filter((url) => !STATUS_URLS.includes(url))).toEqual([MANIFEST_URL]);
    }, SLOW);

    it('says in each line what is so: the DID, the date of the deposit of each attestation, the adverts and the runtimes', async () => {
      const rig = await makeRig();
      await rig.run();
      const found = rig.checks();
      expect(found.get('record_active:reorder-agent')!.text).toBe(`the record ${did(REORDER_ID)} is Active`);
      expect(found.get('organisation:order-desk')!.text).toContain(data.organisations[1]!.domain);
      expect(found.get('adverts')!.text).toContain('reorder-agent 1, order-desk 3');
      expect(found.get('runtimes')!.text).toContain('orders-large-runtime');
      for (const agent of data.agents) for (const type of ['provenance', 'software']) {
        expect(found.get('attestations')!.text).toContain(`${agent.id}/${type} ${hash(`attestation ${agent.id} ${type}`)} is listed in vectorProvenance, valid until ${iso(NOW + 300 * DAY)}, deposit due ${iso(NOW + 390 * DAY)}`);
      }
    }, SLOW);

    it('shows the same lines with status, and ends the machine line with the outcome done and exit 0', async () => {
      const rig = await makeRig();
      expect(await rig.run('status')).toBe(0);
      expectChecks(rig);
      expect(rig.world.screen.lines).toContain('end state: DONE: every check is ok');
      expect(rig.world.machine()).toMatchObject({ command: 'status', outcome: 'done', exit: 0 });
    }, SLOW);
  });

  describe('each check fails alone', () => {
    it('a record that is Revoked, Retired or not in the registry is a fail, and the same agent Active is ok', async () => {
      for (const [utxo, text] of [[REVOKED, 'is Revoked: it must be Active'], [RETIRED, 'is Retired: it must be Active']] as const) {
        const rig = await makeRig();
        rig.setRecord(ORDER_ID, utxo);
        expect(await rig.run()).toBe(1);
        expectChecks(rig, { 'record_active:order-desk': 'fail' });
        expect(rig.checks().get('record_active:order-desk')!.text).toContain(text);
        expect(rig.errors()).toContain('the end state is not reached: 1 check(s) fail (record_active:order-desk)');
        expect(rig.world.machine()).toMatchObject({ outcome: 'failed', exit: 1, result: { verdict: 'fail' } });
      }
      const rig = await makeRig();
      rig.ledger.live = rig.ledger.live.filter((utxo) => utxo.assets[`${MAINNET.identity.hash}${ORDER_ID}`] === undefined);
      expect(await rig.run()).toBe(1);
      expectChecks(rig, { 'record_active:order-desk': 'fail', 'holds': 'fail' });
      expect(rig.checks().get('record_active:order-desk')!.text).toContain('is not in the identity registry');
    }, SLOW);

    it('a hold of 7 days from the jury is a wait with its date, exit 4, and the wait line names the time', async () => {
      const rig = await makeRig();
      rig.setRecord(ORDER_ID, JURY_HELD);
      expect(await rig.run()).toBe(4);
      expectChecks(rig, { 'record_active:order-desk': 'wait' });
      const text = rig.checks().get('record_active:order-desk')!.text;
      expect(text).toContain(`until ${iso(JURY_UNTIL)}`);
      expect(text).toContain('on hold from the jury (reason 64)');
      expect(rig.world.screen.lines).toContain(`WAIT: the end state is not reached yet: 1 check(s) wait (record_active:order-desk). The lines above say what is still to do (until ${iso(JURY_UNTIL)})`);
      expect(rig.world.machine()).toMatchObject({ outcome: 'wait', exit: 4, result: { verdict: 'wait' } });
    }, SLOW);

    it('a hold of another author, a hold that the jury shares with another author, and an Active record twin: fail, fail, ok', async () => {
      for (const utxo of [PARTY_HELD, MIXED_HELD]) {
        const rig = await makeRig();
        rig.setRecord(ORDER_ID, utxo);
        expect(await rig.run()).toBe(1);
        expectChecks(rig, { 'record_active:order-desk': 'fail', 'holds': 'fail' });
        expect(rig.checks().get('record_active:order-desk')!.text).toContain('is Suspended, and the hold is not a hold of the jury');
      }
      const twin = await makeRig();
      twin.setRecord(ORDER_ID, EXPIRED_HOLD);
      expect(await twin.run()).toBe(0);
      expectChecks(twin);
    }, SLOW);

    it('an organisation that the gateway does not show as verified is a fail, and so are a missing Accountable party and a failed hosted call', async () => {
      const unverified = await makeRig();
      unverified.gateway.get(did(ORDER_ID))!.verified = false;
      expect(await unverified.run()).toBe(1);
      expectChecks(unverified, { 'organisation:order-desk': 'fail' });
      expect(unverified.checks().get('organisation:order-desk')!.text).toContain(`does not show the organisation ${data.organisations[1]!.domain} as verified`);
      const noParty = await makeRig();
      noParty.gateway.get(did(REORDER_ID))!.parties = false;
      expect(await noParty.run()).toBe(1);
      expectChecks(noParty, { 'organisation:reorder-agent': 'fail' });
      expect(noParty.checks().get('organisation:reorder-agent')!.text).toContain('shows no Accountable party');
      const down = await makeRig();
      down.hosted.handlers.vector_resolve_did = () => ({ text: 'Failed to resolve DID: the gateway is down', isError: true });
      expect(await down.run()).toBe(1);
      expectChecks(down, { 'organisation:reorder-agent': 'fail', 'organisation:order-desk': 'fail', 'attestations': 'fail' });
      expect(down.checks().get('organisation:order-desk')!.text).toContain('the hosted tool vector_resolve_did failed: Failed to resolve DID: the gateway is down');
    }, SLOW);

    it('an advert that is not listed, an advert that the facts do not hold, and an indexer that cannot be read are a fail', async () => {
      const missing = await makeRig();
      missing.listing = missing.listing.filter((row) => row.model !== 'lot-medium');
      expect(await missing.run()).toBe(1);
      expectChecks(missing, { adverts: 'fail' });
      expect(missing.checks().get('adverts')!.text).toContain(`does not list the advert order-desk/lot-medium (${ref('advert lot-medium')})`);
      const extra = await makeRig();
      extra.listing = [...extra.listing, { advert_ref: ref('stray'), capability_id: ORDER.capability, model: 'lot-huge', agent_id: ORDER_ID, did: did(ORDER_ID), status: 'free' }];
      expect(await extra.run()).toBe(1);
      expectChecks(extra, { adverts: 'fail' });
      expect(extra.checks().get('adverts')!.text).toContain(`lists an advert of the capability ${ORDER.capability} that the facts do not hold (${ref('stray')})`);
      const broken = await makeRig();
      broken.hosted.handlers.vector_marketplace_list_suppliers = () => ({ text: 'a text with no list' });
      expect(await broken.run()).toBe(1);
      expectChecks(broken, { adverts: 'fail' });
      expect(broken.checks().get('adverts')!.text).toContain('cannot tell: the answer of vector_marketplace_list_suppliers holds no list of adverts');
    }, SLOW);

    it('the adverts of an agent on hold from the jury are a wait, and an advert that is missing from an agent that is Active is a fail', async () => {
      const rig = await makeRig();
      rig.setRecord(ORDER_ID, JURY_HELD);
      rig.listing = rig.listing.filter((row) => row.capability_id !== ORDER.capability);
      expect(await rig.run()).toBe(4);
      expectChecks(rig, { 'record_active:order-desk': 'wait', 'adverts': 'wait' });
      expect(rig.checks().get('adverts')!.text).toContain(`is not listed while the record is on hold until ${iso(JURY_UNTIL)}`);
      const active = await makeRig();
      active.listing = active.listing.filter((row) => row.capability_id !== ORDER.capability);
      expect(await active.run()).toBe(1);
      expectChecks(active, { adverts: 'fail' });
    }, SLOW);

    it('an open claim is a fail when its window has ended, and a wait with the time when it has not', async () => {
      const ended = await makeRig();
      ended.ledger.live.push(openClaim({ ageMs: 5 * HOUR }));
      ended.facts.put('claims', ['r1', 'reorder-agent'], claimFact());
      expect(await ended.run()).toBe(1);
      expectChecks(ended, { 'claims:reorder-agent': 'fail' });
      expect(ended.checks().get('claims:reorder-agent')!.text).toContain('of the run r1 is open and its window has ended');
      expect(ended.checks().get('claims:reorder-agent')!.text).toContain('cleanup --run r1 --submit');
      const open = await makeRig();
      open.ledger.live.push(openClaim({ ageMs: HOUR }));
      open.facts.put('claims', ['r1', 'reorder-agent'], claimFact());
      expect(await open.run()).toBe(4);
      expectChecks(open, { 'claims:reorder-agent': 'wait' });
      const until = Math.ceil((NOW - HOUR + 4 * HOUR + 1) / 1000) * 1000;
      expect(open.checks().get('claims:reorder-agent')!.text).toContain(`its window ends in 3 h 1 s (at ${iso(until)})`);
      expect(open.world.screen.lines.some((line) => line.startsWith('WAIT: ') && line.endsWith(`(until ${iso(until)})`))).toBe(true);
    }, SLOW);

    it('an open claim that the facts do not hold is a fail too, and the claim of the other agent is read apart', async () => {
      const rig = await makeRig();
      rig.ledger.live.push(openClaim({ claimer: ORDER_ID, ageMs: 6 * HOUR }));
      expect(await rig.run()).toBe(1);
      expectChecks(rig, { 'claims:order-desk': 'fail' });
      expect(rig.checks().get('claims:order-desk')!.text).toContain('(the facts do not hold it) is open and its window has ended');
    }, SLOW);

    it('a claim of the facts that is not open is ok only when the facts say so: not withdrawn is a wait, withdrawn and not open are ok', async () => {
      const unsaid = await makeRig();
      unsaid.facts.put('claims', ['r1', 'order-desk'], claimFact());
      expect(await unsaid.run()).toBe(4);
      expectChecks(unsaid, { 'claims:order-desk': 'wait' });
      expect(unsaid.checks().get('claims:order-desk')!.text).toContain('is not open, and the facts do not say so: run the task claim, cleanup --run r1 --submit');
      const closed = await makeRig();
      closed.facts.put('claims', ['r1', 'order-desk'], claimFact());
      closed.facts.put('claims', ['r1', 'order-desk', 'withdrawTx'], 'not open');
      expect(await closed.run()).toBe(0);
      expectChecks(closed);
      const withdrawn = await makeRig();
      withdrawn.facts.put('claims', ['r1', 'order-desk'], claimFact({ withdrawTx: hash('withdraw') }));
      expect(await withdrawn.run()).toBe(0);
      expectChecks(withdrawn);
      expect(withdrawn.checks().get('claims:order-desk')!.text).toContain('1 claim(s) of the facts are withdrawn or not open');
    }, SLOW);

    it('a claim that the facts call withdrawn is still a fail when the chain shows it open', async () => {
      const rig = await makeRig();
      rig.ledger.live.push(openClaim({ ageMs: 5 * HOUR }));
      rig.facts.put('claims', ['r1', 'reorder-agent'], claimFact({ withdrawTx: hash('withdraw') }));
      expect(await rig.run()).toBe(1);
      expectChecks(rig, { 'claims:reorder-agent': 'fail' });
    }, SLOW);

    it('a claim that is Challenged is a wait, whatever the facts say, and a claim in any other state that is not Open is a wait too (EP1)', async () => {
      const output = (state: 'Challenged' | 'Validated' | 'Invalidated' = 'Challenged') => openClaim({ claimer: ORDER_ID, ageMs: 2 * HOUR, state });
      // EP1b: the facts hold the claim and do not say that it is closed.
      const silent = await makeRig();
      silent.ledger.live.push(output());
      silent.facts.put('claims', ['r1', 'order-desk'], claimFact());
      expect(await silent.run()).toBe(4);
      expectChecks(silent, { 'claims:order-desk': 'wait' });
      expect(silent.checks().get('claims:order-desk')!.text).toContain('of the run r1 is Challenged, so it is not closed');
      // EP1: the facts say `not open`, and a live output still holds the token of the claim: the check is not done.
      const said = await makeRig();
      said.ledger.live.push(output());
      said.facts.put('claims', ['r1', 'order-desk'], claimFact());
      said.facts.put('claims', ['r1', 'order-desk', 'withdrawTx'], 'not open');
      expect(await said.run()).toBe(4);
      expectChecks(said, { 'claims:order-desk': 'wait' });
      expect(said.world.machine()).toMatchObject({ outcome: 'wait', exit: 4, result: { verdict: 'wait' } });
      expect(await said.run('status')).toBe(1);
      expect(said.world.screen.text).not.toContain('end state: DONE');
      // The facts hold a withdraw transaction, and the token is still held by a live output.
      const withdrawn = await makeRig();
      withdrawn.ledger.live.push(output());
      withdrawn.facts.put('claims', ['r1', 'order-desk'], claimFact({ withdrawTx: hash('withdraw') }));
      expect(await withdrawn.run()).toBe(4);
      expectChecks(withdrawn, { 'claims:order-desk': 'wait' });
      // A challenged claim of the agent that the facts do not hold.
      const unknown = await makeRig();
      unknown.ledger.live.push(output());
      expect(await unknown.run()).toBe(4);
      expectChecks(unknown, { 'claims:order-desk': 'wait' });
      expect(unknown.checks().get('claims:order-desk')!.text).toContain('(the facts do not hold it) is Challenged, so it is not closed');
      // The other states that are not Open.
      for (const state of ['Validated', 'Invalidated'] as const) {
        const rig = await makeRig();
        rig.ledger.live.push(output(state));
        expect(await rig.run()).toBe(4);
        expectChecks(rig, { 'claims:order-desk': 'wait' });
        expect(rig.checks().get('claims:order-desk')!.text).toContain(`is ${state}, so it is not closed`);
      }
      // The twin: the facts say `not open`, and no live output holds the token.
      const closed = await makeRig();
      closed.facts.put('claims', ['r1', 'order-desk'], claimFact());
      closed.facts.put('claims', ['r1', 'order-desk', 'withdrawTx'], 'not open');
      expect(await closed.run()).toBe(0);
      expectChecks(closed);
    }, SLOW);

    it('an attestation that the data names and the facts lack is a fail, for one type and for all four', async () => {
      const one = await makeRig({ skipAttestation: 'order-desk/software' });
      expect(await one.run()).toBe(1);
      expectChecks(one, { attestations: 'fail' });
      const text = one.checks().get('attestations')!.text;
      expect(text).toContain('the facts hold no attestation of the type software for the agent order-desk: run the task attest first');
      expect(text).toContain(`reorder-agent/provenance ${hash('attestation reorder-agent provenance')} is listed in vectorProvenance`);
      const none = await makeRig({ skipAttestation: 'all' });
      expect(await none.run()).toBe(1);
      expectChecks(none, { attestations: 'fail' });
      expect(none.checks().get('attestations')!.text.match(/the facts hold no attestation of the type/g)).toHaveLength(4);
    }, SLOW);

    it('cannot tell is a fail: no Module-1 commit, a manifest of another registry, and a chain that cannot be read', async () => {
      const bare = await makeRig({ env: { OPERATOR_MODULE1_COMMIT: undefined } });
      expect(await bare.run()).toBe(1);
      expectChecks(bare, { 'claims:reorder-agent': 'fail', 'claims:order-desk': 'fail' });
      expect(bare.checks().get('claims:reorder-agent')!.text).toContain('cannot tell: OPERATOR_MODULE1_COMMIT is not set');
      const koios = await makeRig();
      koios.ledger.koiosStatus = 503;
      expect(await koios.run()).toBe(1);
      expectChecks(koios, { 'claims:reorder-agent': 'fail', 'claims:order-desk': 'fail' });
      expect(koios.checks().get('claims:order-desk')!.text).toMatch(/^(cannot tell|the open claims cannot be read)/);
    }, SLOW);

    it('a live delegation of a hirer is a fail that names its id and the key hash of the delegator, with the advice to ask the hirer', async () => {
      const rig = await makeRig();
      const hirer = testKey(30).keyHash;
      rig.ledger.live.push(delegationUtxo(hash('delegation 1'), delegation({ delegate: REORDER_ID, delegator: { type: 'PrincipalKey', hash: hirer, organisation: null } })));
      expect(await rig.run()).toBe(1);
      expectChecks(rig, { delegations: 'fail' });
      const text = rig.checks().get('delegations')!.text;
      expect(text).toContain(`the delegation ${hash('delegation 1')} to reorder-agent is live, delegator key hash ${hirer}`);
      expect(text).toContain('The operator cannot end the delegation of a hirer: ask the hirer to end it.');
    }, SLOW);

    it('a live sub-delegation to the subagent is a fail, and a delegation to another agent is ok', async () => {
      const sub = await makeRig();
      sub.ledger.live.push(delegationUtxo(hash('delegation 2'), delegation({ delegate: READER_ID, delegator: { type: 'Agent', id: REORDER_ID }, parent: hash('parent'), depth: 2 })));
      expect(await sub.run()).toBe(1);
      expectChecks(sub, { delegations: 'fail' });
      expect(sub.checks().get('delegations')!.text).toContain(`to stock-reader is live, delegator agent ${REORDER_ID}`);
      const other = await makeRig();
      other.ledger.live.push(delegationUtxo(hash('delegation 3'), delegation({ delegate: 'e5'.repeat(32) })));
      expect(await other.run()).toBe(0);
      expectChecks(other);
    }, SLOW);

    it('a hold of this pack that is on is a fail, and a hold in the facts that ended by itself is ok', async () => {
      const on = await makeRig();
      on.setRecord(ORDER_ID, PARTY_HELD);
      on.facts.put('holds', ['r2'], { suspendTx: hash('suspend'), liftTx: null });
      expect(await on.run()).toBe(1);
      expect(on.checks().get('holds')!.result).toBe('fail');
      expect(on.checks().get('holds')!.text).toContain(`the record ${did(ORDER_ID)} of order-desk has a hold of the key hash ${testKey(3).keyHash} until ${iso(PARTY_UNTIL)}`);
      expect(on.checks().get('holds')!.text).toContain('cleanup --run r2 --submit');
      const ended = await makeRig();
      ended.setRecord(ORDER_ID, EXPIRED_HOLD);
      ended.facts.put('holds', ['r2'], { suspendTx: hash('suspend'), liftTx: null });
      expect(await ended.run()).toBe(0);
      expect(ended.checks().get('holds')!.text).toContain('the facts show no lift for the run(s) r2, and the node shows no hold');
      const lifted = await makeRig();
      lifted.facts.put('holds', ['r2'], { suspendTx: hash('suspend'), liftTx: hash('lift') });
      expect(await lifted.run()).toBe(0);
    }, SLOW);

    it('a hold that the facts call lifted is a fail when the node still shows it', async () => {
      const rig = await makeRig();
      rig.setRecord(ORDER_ID, PARTY_HELD);
      rig.facts.put('holds', ['r2'], { suspendTx: hash('suspend'), liftTx: hash('lift') });
      expect(await rig.run()).toBe(1);
      expect(rig.checks().get('holds')!.result).toBe('fail');
    }, SLOW);

    it('a wallet below half of its float or with no collateral output is a wait with the advice to top it up, and the exact limit is ok', async () => {
      const low = await makeRig();
      low.setWallet('order-small-supplier', [5_000_000n, 1_000_000n]);
      expect(await low.run()).toBe(4);
      expectChecks(low, { wallets: 'wait' });
      expect(low.checks().get('wallets')!.text).toContain('order-small-supplier holds 6.000000 units and needs 10.000000 units');
      expect(low.checks().get('wallets')!.text).toContain('top the wallet up by hand');
      const bare = await makeRig();
      bare.setWallet('reorder-service', [4_000_000n, 4_000_000n, FAIR_FLOAT]);
      bare.setWallet('order-large-supplier', [4_000_000n, 4_000_000n, 4_000_000n]);
      expect(await bare.run()).toBe(4);
      expect(bare.checks().get('wallets')!.text).toContain('order-large-supplier has no pure output of 5 units or more as collateral');
      expect(bare.checks().get('wallets')!.text).not.toContain('reorder-service');
      const exact = await makeRig();
      exact.setWallet('order-small-supplier', [10_000_000n]);
      expect(await exact.run()).toBe(0);
      const above = await makeRig();
      above.setWallet('order-small-supplier', [9_999_999n]);
      expect(await above.run()).toBe(4);
    }, SLOW);

    it('a wallet that the public key file does not list, and a public key file that is not there, are a fail', async () => {
      const rig = await makeRig();
      rmSync(join(rig.world.keys.root, publicManifestFile(USE_CASE)));
      expect(await rig.run()).toBe(1);
      expect(rig.checks().get('wallets')!.result).toBe('fail');
      expect(rig.checks().get('wallets')!.text).toContain(`cannot tell: the public key file ${publicManifestFile(USE_CASE)} cannot be read (ENOENT)`);
      const other = await makeRig();
      writeFileSync(join(other.world.keys.root, publicManifestFile(USE_CASE)), JSON.stringify({ use_case: USE_CASE, network: 'vector-mainnet', keys: { fee: { address: other.world.keys.registry.addressOf('fee') } } }));
      expect(await other.run()).toBe(1);
      expect(other.checks().get('wallets')!.text).toContain('the public key file lists no wallet for');
      const foreign = await makeRig();
      writeFileSync(join(foreign.world.keys.root, publicManifestFile(USE_CASE)), JSON.stringify({ use_case: 'another', network: 'vector-mainnet', keys: {} }));
      expect(await foreign.run()).toBe(1);
      expect(foreign.checks().get('wallets')!.text).toContain('is for another use case or another network');
    }, SLOW);

    it('reads the public key file of the earlier name when the file of the use case is not there, and not an earlier file that names another use case', async () => {
      const rig = await makeRig();
      rmSync(join(rig.world.keys.root, publicManifestFile(USE_CASE)));
      writePublicManifest(join(rig.world.keys.root, LEGACY_PUBLIC_MANIFEST), rig.world.keys.registry, { network: 'vector-mainnet', useCase: USE_CASE });
      expect(await rig.run()).toBe(0);
      expect(rig.checks().get('wallets')!.result).toBe('ok');
      const foreign = await makeRig();
      rmSync(join(foreign.world.keys.root, publicManifestFile(USE_CASE)));
      writeFileSync(join(foreign.world.keys.root, LEGACY_PUBLIC_MANIFEST), JSON.stringify({ use_case: 'another', network: 'vector-mainnet', keys: {} }));
      expect(await foreign.run()).toBe(1);
      expect(foreign.checks().get('wallets')!.text).toContain(`cannot tell: the public key file ${publicManifestFile(USE_CASE)} cannot be read (ENOENT)`);
    }, SLOW);

    it('the dates of the deposits are the end of the validity and 90 days, and an attestation that is not listed is a fail unless it expired', async () => {
      const rig = await makeRig();
      rig.gateway.get(did(REORDER_ID))!.listed = [hash('attestation reorder-agent provenance')];
      expect(await rig.run()).toBe(1);
      expectChecks(rig, { attestations: 'fail' });
      const text = rig.checks().get('attestations')!.text;
      expect(text).toContain(`the attestation reorder-agent/software ${hash('attestation reorder-agent software')} is not listed in vectorProvenance`);
      expect(text).toContain(`reorder-agent/provenance ${hash('attestation reorder-agent provenance')} is listed in vectorProvenance, valid until ${iso(NOW + 300 * DAY)}, deposit due ${iso(NOW + 390 * DAY)}`);
      const expired = await makeRig();
      expired.facts.put('attestations', ['reorder-agent', 'software'], { id: hash('old'), tx: hash('old tx'), digest: hash('digest'), locator: 'https://example.test/doc', validUntil: iso(NOW - DAY), issuedAt: iso(NOW - 366 * DAY), envelope: true }, { replace: true });
      expect(await expired.run()).toBe(0);
      expect(expired.checks().get('attestations')!.text).toContain(`reorder-agent/software ${hash('old')} is expired and not listed, valid until ${iso(NOW - DAY)}, deposit due ${iso(NOW + 89 * DAY)}`);
    }, SLOW);

    it('a runtime that says working is a wait, and a runtime that is not listed, that cannot be asked or that answers wrongly is a fail', async () => {
      const working = await makeRig();
      working.statuses.set(STATUS_URLS[1]!, 'working');
      expect(await working.run()).toBe(4);
      expectChecks(working, { runtimes: 'wait' });
      expect(working.checks().get('runtimes')!.text).toContain('the runtime orders-small-runtime says working: a job runs, so wait until it ends');
      const absent = await makeRig();
      absent.writeRunning(CONTAINERS.filter((container) => container !== 'orders-medium-runtime'));
      expect(await absent.run()).toBe(1);
      expectChecks(absent, { runtimes: 'fail' });
      expect(absent.checks().get('runtimes')!.text).toContain('the runtime orders-medium-runtime is not running: at the end state the 4 runtimes run');
      expect(absent.webCalls).not.toContain(STATUS_URLS[2]);
      for (const answer of [500, 'not json', 'sleeping'] as const) {
        const odd = await makeRig();
        odd.statuses.set(STATUS_URLS[0]!, answer);
        expect(await odd.run()).toBe(1);
        expectChecks(odd, { runtimes: 'fail' });
        expect(odd.checks().get('runtimes')!.text).toContain('cannot tell whether the runtime reorder-runtime works');
      }
    }, SLOW);

    it('a runtime that gives no answer within 10 seconds is a fail that says that it cannot tell, also when the fetch ignores the abort signal, and the other runtimes are still asked', async () => {
      const rig = await makeRig();
      rig.statuses.set(STATUS_URLS[1]!, 'hang');
      // Only the timeout is faked: the files and the hosted calls of the run take their real time, and the loop moves the clock of the timer while the run goes on. The bound makes a reader with no limit fail the test
      // and not hang it.
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      try {
        let exit: number | undefined;
        void rig.run().then((code) => { exit = code; });
        for (let turn = 0; turn < 3_000 && exit === undefined; turn += 1) {
          await vi.advanceTimersByTimeAsync(1_000);
          await nextTurn();
        }
        expect(exit).toBe(1);
      } finally {
        vi.useRealTimers();
      }
      expectChecks(rig, { runtimes: 'fail' });
      expect(rig.checks().get('runtimes')!.text).toContain('cannot tell whether the runtime orders-small-runtime works: no complete answer came within 10 s');
      expect(rig.webCalls).toEqual(expect.arrayContaining([STATUS_URLS[0], STATUS_URLS[2], STATUS_URLS[3]]));
    }, SLOW);

    it('a file of the running containers that is stale, missing or empty is a fail, and the file of this minute is ok', async () => {
      const stale = await makeRig();
      stale.writeRunning(CONTAINERS, NOW - 11 * 60_000);
      expect(await stale.run()).toBe(1);
      expect(stale.checks().get('runtimes')!.text).toContain('cannot tell: running-images.json is more than 10 minutes old');
      const missing = await makeRig();
      rmSync(join(missing.world.stateDir, 'running-images.json'));
      expect(await missing.run()).toBe(1);
      expect(missing.checks().get('runtimes')!.text).toContain('cannot tell: running-images.json does not exist');
      const empty = await makeRig();
      empty.writeRunning([]);
      expect(await empty.run()).toBe(1);
      expect(empty.checks().get('runtimes')!.text).toContain('the runtime reorder-runtime is not running');
      const fresh = await makeRig();
      fresh.writeRunning(CONTAINERS, NOW - 9 * 60_000);
      expect(await fresh.run()).toBe(0);
    }, SLOW);

    it('a hosted tool that cannot be reached is a fail with its own line and never a pass', async () => {
      const rig = await makeRig();
      rig.hosted.handlers.vector_marketplace_list_suppliers = () => { throw new HostedError('unreachable', 'the hosted server cannot be reached'); };
      expect(await rig.run()).toBe(1);
      expectChecks(rig, { adverts: 'fail' });
      expect(rig.checks().get('adverts')!.text).toBe('cannot tell: the hosted server cannot be reached');
    }, SLOW);

    it('a network guard that fails stops the reads: one fail named network, and no read of the ledger or the hosted tools', async () => {
      const rig = await makeRig();
      rig.world.node.facts = { magic: 42, systemStartMs: 1 };
      expect(await rig.run()).toBe(1);
      expect([...rig.checks().keys()]).toEqual(['network']);
      expect(rig.checks().get('network')!.result).toBe('fail');
      expect(rig.hosted.calls).toEqual([]);
    }, SLOW);
  });

  describe('the whole', () => {
    it('is exit 1 when a check waits and another fails, and the line of the whole names both', async () => {
      const rig = await makeRig();
      rig.setRecord(ORDER_ID, JURY_HELD);
      rig.gateway.get(did(REORDER_ID))!.verified = false;
      expect(await rig.run()).toBe(1);
      expectChecks(rig, { 'record_active:order-desk': 'wait', 'organisation:reorder-agent': 'fail' });
      expect(rig.world.screen.lines).toContain('end state: NOT DONE: 1 check(s) fail (organisation:reorder-agent) and 1 check(s) wait (record_active:order-desk)');
      expect(rig.world.machine()).toMatchObject({ outcome: 'failed', exit: 1, result: { verdict: 'fail' } });
    }, SLOW);

    it('has no date to wait for when a wait has none, and the latest date when every wait has one', async () => {
      const dateless = await makeRig();
      dateless.setRecord(ORDER_ID, JURY_HELD);
      dateless.setWallet('order-small-supplier', [5_000_000n]);
      expect(await dateless.run()).toBe(4);
      expect(dateless.world.screen.lines.find((line) => line.startsWith('WAIT: '))).toBe('WAIT: the end state is not reached yet: 2 check(s) wait (record_active:order-desk, wallets). The lines above say what is still to do');
      const dated = await makeRig();
      dated.setRecord(ORDER_ID, JURY_HELD);
      dated.ledger.live.push(openClaim({ ageMs: HOUR }));
      expect(await dated.run()).toBe(4);
      expect(dated.world.screen.lines.find((line) => line.startsWith('WAIT: '))).toContain(`(until ${iso(JURY_UNTIL)})`);
    }, SLOW);

    it('never ends status with exit 0 or the outcome done for a state that is not done: a claim, a delegation, a hold and a wait all end with exit 1', async () => {
      const claim = await makeRig();
      claim.ledger.live.push(openClaim({ ageMs: 5 * HOUR }));
      expect(await claim.run('status')).toBe(1);
      expect(claim.world.screen.lines).toContain('end state: NOT DONE: 1 check(s) fail (claims:reorder-agent) and 0 check(s) wait (none)');
      expect(claim.world.screen.text).not.toContain('end state: DONE');
      expect(claim.errors()).toContain('the end state is not reached: 1 check(s) fail (claims:reorder-agent)');
      expect(claim.world.machine()).toMatchObject({ command: 'status', outcome: 'failed', exit: 1 });
      const open = await makeRig();
      open.ledger.live.push(openClaim({ ageMs: HOUR }));
      expect(await open.run('status')).toBe(1);
      expect(open.errors()).toContain('the end state is not reached yet: 1 check(s) wait (claims:reorder-agent)');
      expect(open.world.screen.text).not.toContain('end state: DONE');
      expect(open.world.machine()).toMatchObject({ command: 'status', outcome: 'failed', exit: 1 });
      const delegated = await makeRig();
      delegated.ledger.live.push(delegationUtxo(hash('delegation 1'), delegation({ delegate: REORDER_ID })));
      expect(await delegated.run('status')).toBe(1);
      expect(delegated.world.screen.text).not.toContain('end state: DONE');
      const held = await makeRig();
      held.setRecord(ORDER_ID, PARTY_HELD);
      expect(await held.run('status')).toBe(1);
      expect(held.world.screen.text).not.toContain('end state: DONE');
      expect(held.world.machine()).toMatchObject({ command: 'status', outcome: 'failed', exit: 1 });
      const jury = await makeRig();
      jury.setRecord(ORDER_ID, JURY_HELD);
      expect(await jury.run('status')).toBe(1);
      expect(jury.world.screen.lines.some((line) => line.startsWith('WAIT record_active:order-desk: '))).toBe(true);
    }, SLOW);

    it('takes nothing back in cleanup', async () => {
      const rig = await makeRig();
      expect(await rig.run('cleanup')).toBe(0);
      expect(rig.world.machine()).toMatchObject({ command: 'cleanup', outcome: 'done', exit: 0 });
      expect(rig.hosted.calls).toEqual([]);
    }, SLOW);
  });
});
