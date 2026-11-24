// scripts/operator/test/claim.test.ts - the task `claim` through the real runner, the real chain port of the kit (`createModule1Port`) and the real dispute code (`Dispute`), over the fixture world
// of the kit tests: the Module-1 scripts run on every build, and a ledger takes the signed transactions. The guarded signer judges each transaction that the kit builds. Each refusal has an accepted twin.
// The fixture world has one wallet key (the key of seed 0b), so the service key of the Reorder Agent has that seed. The service key of the Order Desk has the seed 0d, and the test gives it a wallet
// and a record on the same ledger. No test uses the network or DNS: the fetch of the world serves the manifest and the status of the runtimes, and the host lookup of the manifest reader is replaced.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ensureSlotConfig } from '../../../packages/buyer-core/src/index.ts';
import { DEPLOYMENT, testKey } from '../../../packages/buyer-core/test/fixtures/identity-world.ts';
import { AUDITOR_ID, CLAIMER_ID, IDENTITY_ADDRESS, IDENTITY_HASH, MODULE1, MODULE1_MANIFEST, agentRecord, recordUtxo } from '../../../packages/buyer-core/test/fixtures/jury-world.ts';
import { scriptAddress } from '../../../packages/buyer-core/src/vendored/mcp/jury-deployment.ts';
import { createSerialQueue } from '../../../packages/usecase-kit/src/access/index.ts';
import { Dispute } from '../../../packages/usecase-kit/src/dispute/index.ts';
import type { ClaimView, JurorDocument } from '../../../packages/usecase-kit/src/dispute/index.ts';
import { LedgerProvider, WALLET_ADDRESS, forever, koiosOf, ledgerWorld, realPort } from '../../../packages/usecase-kit/test/dispute/ledger.ts';
import { MANIFEST_SHA, SETTINGS as DISPUTE_SETTINGS } from '../../../packages/usecase-kit/test/dispute/support.ts';
import { EvidenceFile } from '../../checks/lib/evidence.ts';
import { iso } from '../../checks/lib/format.ts';
import type { StepPlan } from '../../checks/lib/guards.ts';
import { GuardRefusal } from '../../checks/lib/land.ts';
import { PURPOSE, lucidForAddress } from '../../checks/lib/platform.ts';
import type { IdentityDeployment } from '../../checks/lib/platform.ts';
import type { ChainAccess } from '../../checks/lib/session.ts';
import { PreconditionError } from '../../checks/lib/session.ts';
import { VECTOR_MAINNET } from '../../checks/lib/settings.ts';
import { StateFile } from '../../checks/lib/state.ts';
import { factsOf } from '../../checks/lib/txfacts.ts';
import type { TxFacts } from '../../checks/lib/txfacts.ts';
import { ApprovalError, Exposure } from '../lib/approval.ts';
import type { GoFile } from '../lib/approval.ts';
import { CLAIM_STAKE_LOVELACE, CLAIM_WINDOW_MS, claimTypeOf } from '../lib/claim-constants.ts';
import type { ClaimFact, GuardedSignRequest, LandHost, OperatorSettings } from '../lib/contract.ts';
import { FactsFile } from '../lib/facts.ts';
import { guardedSign, recordingProvider } from '../lib/guarded-sign.ts';
import { ORDER_DESK_CLAIM, REORDER_CLAIM, withdrawableFrom } from '../lib/platform.ts';
import { loadRegistry } from '../lib/registry.ts';
import { runTask } from '../lib/runner.ts';
import claim, { claimRequest, trialDocument, withdrawRequest } from '../tasks/claim.ts';
import data from '../usecases/inventory-reorder.ts';
import { MemoryOutput } from './support/fakes.ts';
import { writeSeed } from './support/keys.ts';
import { NOW, USE_CASE, taskWorld } from './support/task-world.ts';
import type { TaskWorld } from './support/task-world.ts';

// The host lookup of the manifest reader finds a public address, so that no test asks the resolver. The fetch of the world answers the request.
vi.mock('node:dns/promises', () => ({ lookup: async () => [{ address: '140.82.114.4', family: 4 }] }));

const SLOW = 240_000;
const HOUR = 3_600_000;
const RUN = 'run-a';
const COMMIT = 'a4bc735c48d9d280374637b7e071a01f0086e7aa';
const MANIFEST_BASE = 'https://raw.githubusercontent.com/Apex-Fusion/vector-agent-modules';
const MANIFEST_URL = `${MANIFEST_BASE}/${COMMIT}/${data.moduleManifestPath}`;
const REORDER = data.agents[0]!;
const ORDER = data.agents[1]!;
const SEEDS = { 'reorder-service': '0b'.repeat(32), 'order-desk-service': '0d'.repeat(32) } as const;
const WALLET_1 = testKey(11);
const WALLET_2 = testKey(13);
const REORDER_STATUS = `${REORDER.endpoint}/status`;
const ORDER_STATUS = `${ORDER.endpoint}/status`;
const IMAGE = `ghcr.io/apex-fusion/vector-service-agents/agent@sha256:${'ab'.repeat(32)}`;
const HOST_SETTINGS: OperatorSettings = {
  network: VECTOR_MAINNET, useCase: USE_CASE, keysDir: '/test/keys', stateDir: '/test/state', agentsDir: '/test/agents', goFile: '/test/state/GO.json', mockEnvFile: null, contact: null, module1Commit: COMMIT,
  urls: { ogmios: 'https://node.test', submit: 'https://submit.test', koios: 'https://indexer.test', hosted: 'https://hosted.test/mcp', gateway: 'https://gateway.test' },
  maxFeeLovelace: 2_000_000n, maxCollateralLossLovelace: 5_000_000n,
};

const roots: string[] = [];
afterAll(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
beforeAll(async () => { await ensureSlotConfig(ledgerWorld()); });

// ---- the ledger: two wallets, two records ----

const listing = (key: { publicKey: string }) => [{ keyType: 'Ed25519' as const, key: key.publicKey, purposes: PURPOSE.authentication | PURPOSE.transaction, pop: null }];
// The records are made once: `recordUtxo` gives each record a transaction hash from a counter that has room for few records.
const RECORD_1 = recordUtxo(CLAIMER_ID, agentRecord({ keys: listing(WALLET_1) }));
const RECORD_2 = recordUtxo(AUDITOR_ID, agentRecord({ keys: listing(WALLET_2) }, WALLET_2.publicKey));
const RECORD_1_UNLISTED = recordUtxo(CLAIMER_ID, agentRecord({ keys: [] }));
const RECORD_1_RETIRED = recordUtxo(CLAIMER_ID, agentRecord({ keys: listing(WALLET_1), status: { type: 'Retired', at: NOW - 1000, successor: null } }));

let outputCounter = 0;
/** Replaces the outputs of a wallet on the ledger with outputs of the given amounts. */
function setWallet(ledger: LedgerProvider, address: string, lovelace: readonly bigint[]): void {
  ledger.live = ledger.live.filter((utxo) => utxo.address !== address);
  for (const amount of lovelace) {
    outputCounter += 1;
    ledger.live.push({ txHash: `${(0xe0 + (outputCounter % 0x1f)).toString(16)}${outputCounter.toString(16).padStart(2, '0')}`.padEnd(64, 'd'), outputIndex: 0, address, assets: { lovelace: amount } });
  }
}

const held = (ledger: LedgerProvider, address: string): bigint => ledger.atAddress(address).reduce((sum, utxo) => sum + (utxo.assets.lovelace ?? 0n), 0n);

// ---- the world of a test ----

/** The web of the world: the manifest of Module-1 and the status of each runtime. Any other request is a test that touched the network. */
class Web {
  readonly statuses = new Map<string, string>();
  readonly calls: string[] = [];
  /** The manifests that a commit other than the pinned one serves, by URL. */
  readonly manifests = new Map<string, unknown>();
  readonly fetch: typeof fetch = async (input) => {
    const url = String(input);
    this.calls.push(url);
    if (url === MANIFEST_URL) return new Response(JSON.stringify(MODULE1_MANIFEST), { status: 200 });
    const other = this.manifests.get(url);
    if (other !== undefined) return new Response(JSON.stringify(other), { status: 200 });
    const status = this.statuses.get(url);
    if (status !== undefined) return new Response(JSON.stringify({ status }), { status: 200 });
    throw new Error('the network was touched');
  };
}

interface Rig {
  readonly world: TaskWorld;
  readonly ledger: LedgerProvider;
  readonly chain: ChainAccess;
  readonly web: Web;
  /** The containers that `running-images.json` lists. */
  containers: string[];
  readonly address1: string;
  readonly address2: string;
  /** Runs the task through the real runner, after it wrote `running-images.json` with the time now. */
  run(...argv: string[]): Promise<number>;
  /** Runs the task through the real runner and writes no `running-images.json`. */
  runBare(...argv: string[]): Promise<number>;
  errors(): string;
  text(): string;
}

interface RigOptions {
  records?: LedgerProvider['live'];
  wallet1?: readonly bigint[];
  wallet2?: readonly bigint[];
  env?: Record<string, string | undefined>;
  manifests?: boolean;
  recordFacts?: boolean;
}

async function makeRig(options: RigOptions = {}): Promise<Rig> {
  const names = ['run', 'reorder-service', 'order-desk-service'];
  const world = await taskWorld({
    keys: names, shared: ['run'], use: { agents: data.agents, runs: data.runs, moduleManifestPath: data.moduleManifestPath }, env: { OPERATOR_MODULE1_COMMIT: COMMIT, ...options.env },
  });
  for (const [name, seed] of Object.entries(SEEDS)) writeSeed(world.keys.root, USE_CASE, name, `${seed}\n`);
  const registry = loadRegistry({ dir: world.keys.root, useCase: USE_CASE, specs: world.use.keys, need: names });
  const address1 = registry.addressOf('reorder-service');
  const address2 = registry.addressOf('order-desk-service');
  const ledger = ledgerWorld([], options.records ?? [RECORD_1, RECORD_2]);
  setWallet(ledger, address1, options.wallet1 ?? [5_000_000n, 190_000_000n]);
  setWallet(ledger, address2, options.wallet2 ?? [5_000_000n, 130_000_000n]);
  const deployment = { ...DEPLOYMENT, identity: { ...DEPLOYMENT.identity, hash: IDENTITY_HASH, address: IDENTITY_ADDRESS } } as IdentityDeployment;
  const web = new Web();
  const chain: ChainAccess = {
    provider: ledger, deployment, koiosUrl: 'https://koios.test', fetchImpl: koiosOf(ledger),
    context: async (address) => ({ lucid: await lucidForAddress(ledger, address), provider: ledger, deployment }), liveVaultsOf: async () => [],
  };
  const facts = FactsFile.open(join(world.stateDir, 'facts.json'), { useCase: USE_CASE, network: 'vector-mainnet' });
  for (const [agent, id] of [[REORDER, CLAIMER_ID], [ORDER, AUDITOR_ID]] as const) {
    if (options.recordFacts !== false) {
      facts.put('records', [agent.id], { did: `did:vector:${id}`, id, tx: 'aa'.repeat(32), recordRef: `${'aa'.repeat(32)}#0`, depositLovelace: '10000000', registeredAt: '2026-11-15T10:00:00.000Z' });
    }
    if (options.manifests !== false) facts.put('manifests', [agent.id], { uri: `${agent.endpoint}/agent.json`, sha256: MANIFEST_SHA, bytes: 1200, readAt: '2026-11-15T10:00:00.000Z' });
  }
  const runBare = (...argv: string[]): Promise<number> => runTask(claim, argv, world.deps({ chain, fetchImpl: web.fetch }));
  const rig: Rig = {
    world, ledger, chain, web, containers: [], address1, address2, runBare,
    run: (...argv) => {
      mkdirSync(world.stateDir, { recursive: true, mode: 0o700 });
      chmodSync(world.stateDir, 0o700);
      const images = Object.fromEntries(rig.containers.map((name) => [name, IMAGE]));
      writeFileSync(join(world.stateDir, 'running-images.json'), JSON.stringify({ generated_at: iso(world.clock.now()), images }), { mode: 0o600 });
      return runBare(...argv);
    },
    errors: () => world.screen.errors.join('\n'),
    text: () => world.screen.lines.join('\n'),
  };
  return rig;
}

/** Writes the approval of a session that starts now and lasts six hours. */
const approve = (rig: Rig, capUnits = 200, session = 's1'): string => rig.world.writeGo({ tasks: ['claim'], capUnits, session, at: iso(rig.world.clock.now()), expiresAt: iso(rig.world.clock.now() + 6 * HOUR) });
const stakeAll = (rig: Rig, kind = 'clean', run = RUN): Promise<number> => rig.run('run', '--run', run, '--kind', kind, '--submit', '--all');
const cleanup = (rig: Rig, ...more: string[]): Promise<number> => rig.run('cleanup', '--run', RUN, '--submit', ...more);
/** A rig with both claims staked, and an approval for the session `s1` that has a cap of 200 units. */
async function staged(options: RigOptions = {}): Promise<Rig> {
  const rig = await makeRig(options);
  approve(rig);
  expect(await stakeAll(rig)).toBe(0);
  return rig;
}

/** The open claims of an agent on the ledger, read through the real chain port of the kit. */
async function openClaims(rig: Rig, id: string): Promise<readonly ClaimView[]> {
  const port = realPort(rig.ledger, id, rig.world.clock.now());
  const dispute = new Dispute({ port, queue: createSerialQueue(), clock: () => rig.world.clock.now(), sleep: forever, settings: DISPUTE_SETTINGS });
  const listed = await dispute.listOpenClaims(`did:vector:${id}`);
  if (!listed.ok) throw new Error(`${listed.code}: ${listed.detail}`);
  return listed.value;
}

const claimOf = (rig: Rig, agent = REORDER, run = RUN): ClaimFact => {
  const fact = rig.world.facts().claims[run]?.[agent.id];
  if (fact === undefined) throw new Error(`the facts hold no claim of ${agent.id} for ${run}`);
  return fact;
};

/** Moves the clock, in hours. */
const later = (rig: Rig, hours: number): void => { rig.world.clock.t += hours * HOUR; };
const lockFacts = (rig: Rig): string => {
  mkdirSync(rig.world.stateDir, { recursive: true, mode: 0o700 });
  const lock = join(rig.world.stateDir, 'facts.json.lock');
  writeFileSync(lock, '');
  return lock;
};
const stateOf = (rig: Rig) => rig.world.state('claim', RUN);

// ---- a host for the guarded signer, for the tests that drive the kit by hand ----

const unused = <T extends object>(name: string): T => new Proxy({} as T, { get: () => { throw new Error(`the guarded signer touched the ${name} of the host`); } });

function makeHost(rig: Rig, capUnits = 200): LandHost {
  const dir = mkdtempSync(join(tmpdir(), 'operator-claim-host-'));
  roots.push(dir);
  const registry = loadRegistry({ dir: rig.world.keys.root, useCase: USE_CASE, specs: rig.world.use.keys, need: ['run', 'reorder-service', 'order-desk-service'] });
  const go: GoFile = { approvedBy: 'the test', at: iso(NOW), session: 'host', runWallet: registry.addressOf('run'), capUnits, tasks: ['claim'], irreversible: [], expiresAt: iso(NOW + 100 * HOUR) };
  const identity = { check: 'claim', network: 'vector-mainnet', record: USE_CASE };
  return {
    mode: 'submit', settings: HOST_SETTINGS, registry, state: StateFile.open(join(dir, 'claim.state.json'), identity), evidence: EvidenceFile.open(join(dir, 'claim.evidence.json'), identity), clock: rig.world.clock,
    out: new MemoryOutput(), node: unused('node'), network: unused('network gate'), networkResult: () => ({ guard: 'network', ok: true, message: 'the node is on vector-mainnet' }), chain: unused('chain'),
    hosted: unused('hosted tools'), go, exposure: new Exposure(join(dir, 'exposure.host.json'), go), task: 'claim', awaitMs: 30_000, pollMs: 5_000,
  };
}

/** The dispute code of the kit over the real port, with the guarded signer of `request` as its signature. `stops` holds what the signer threw. */
function kitOver(rig: Rig, host: LandHost, request: GuardedSignRequest): { readonly dispute: Dispute; readonly stops: Error[] } {
  const recorded = recordingProvider(rig.ledger);
  const signer = guardedSign(host, request, recorded);
  const stops: Error[] = [];
  const sign = (cbor: string): { signedCborHex: string; txHashHex: string } => {
    try { return signer(cbor); } catch (err) {
      if (err instanceof Error) stops.push(err);
      throw err;
    }
  };
  const port = realPort(rig.ledger, CLAIMER_ID, rig.world.clock.now(), { provider: recorded, sign, address: rig.address1 });
  return { dispute: new Dispute({ port, queue: createSerialQueue(), clock: () => rig.world.clock.now(), sleep: forever, settings: DISPUTE_SETTINGS }), stops };
}

const RUN_CLAIM = {
  capability_id: REORDER.capability, manifest_sha256: MANIFEST_SHA, claim: REORDER_CLAIM, stake_lovelace: CLAIM_STAKE_LOVELACE, challenge_window_ms: CLAIM_WINDOW_MS, claim_type: claimTypeOf(REORDER.capability),
};

describe('the fixture world', () => {
  it('gives the service key of the Reorder Agent the wallet of the kit fixtures, and each service key its wallet and its record', async () => {
    const rig = await makeRig();
    expect(rig.address1).toBe(WALLET_ADDRESS);
    expect(held(rig.ledger, rig.address1)).toBe(195_000_000n);
    expect(held(rig.ledger, rig.address2)).toBe(135_000_000n);
    expect(await openClaims(rig, CLAIMER_ID)).toEqual([]);
  });
});

describe('claim run: the dry run', () => {
  it('builds and judges the claim document, prints the summary, signs and writes nothing, and says that the claim transaction is built after the document is confirmed', async () => {
    const rig = await makeRig();
    expect(await rig.run('run', '--run', RUN, '--kind', 'clean')).toBe(0);
    expect(rig.world.machine()).toMatchObject({ task: 'claim', mode: 'dry', outcome: 'dry', exit: 0 });
    expect(rig.text()).toContain('step claim:reorder-agent:document: dry mode, nothing is signed or submitted');
    expect(rig.text()).toMatch(/The claim transaction is built after the document is confirmed/);
    expect(rig.text()).toContain('the service key of the agent reorder-agent stakes 50.000000 units for 1 day');
    expect(rig.ledger.accepted).toEqual([]);
    expect(stateOf(rig)).toMatchObject({ steps: {}, notes: {}, in_flight: null });
    expect(rig.world.facts().claims).toEqual({});
    expect(existsSync(rig.world.goPath)).toBe(false);
  }, SLOW);
});

describe('claim run: a run that stakes', () => {
  it('stakes both transactions of the first agent with one run, then those of the second agent: the facts, the parts, the steps, the signer and the claim on the chain follow the constants', async () => {
    const rig = await makeRig();
    approve(rig);
    expect(await rig.run('run', '--run', RUN, '--kind', 'clean', '--submit')).toBe(0);
    expect(rig.world.machine()).toMatchObject({ outcome: 'done', step: 'reorder-agent' });
    expect(rig.ledger.accepted).toHaveLength(2);
    const first = claimOf(rig);
    expect(rig.world.facts().claims[RUN]?.['order-desk']).toBeUndefined();
    expect(first).toMatchObject({ documentTx: rig.ledger.accepted[0], claimTx: rig.ledger.accepted[1], stakeLovelace: '50000000', windowMs: CLAIM_WINDOW_MS, withdrawTx: null });
    expect(first.claimToken).toMatch(/^636c6d5f[0-9a-f]{56}$/);
    expect(first.claimRef).toBe(`${first.claimTx}#0`);
    expect(Date.parse(first.withdrawableFrom) - Date.parse(first.stakedAt)).toBeGreaterThanOrEqual(CLAIM_WINDOW_MS);
    expect(Date.parse(first.withdrawableFrom) - Date.parse(first.stakedAt)).toBeLessThanOrEqual(CLAIM_WINDOW_MS + 2000);
    // The document is a part of the step, the step is recorded, and nothing is in flight.
    const state = stateOf(rig);
    expect(state.notes['part.claim:reorder-agent:document']).toMatchObject({ tx_hash: first.documentTx });
    expect(state.steps['reorder-agent']).toMatchObject({ tx_hash: first.claimTx, refs: { claim: first.claimRef } });
    expect(state.steps['order-desk']).toBeUndefined();
    expect(state.in_flight).toBeNull();
    // Each transaction has the one signature of the service key.
    for (const raw of rig.ledger.raw) expect(factsOf(raw).witnesses).toEqual([WALLET_1.keyHash]);
    // The claim on the chain has the stake, the window and the claim type of the constants.
    const [view] = await openClaims(rig, CLAIMER_ID);
    expect(view).toMatchObject({ ref: first.claimRef, token: first.claimToken, stake_lovelace: CLAIM_STAKE_LOVELACE, challenge_window_ms: CLAIM_WINDOW_MS, claim_type: claimTypeOf(REORDER.capability) });
    expect(first.withdrawableFrom).toBe(iso(withdrawableFrom(view!)));
    // The second run stakes the Order Desk, with its own key, and the first step is not run again.
    expect(await rig.run('run', '--run', RUN, '--kind', 'clean', '--submit')).toBe(0);
    expect(rig.world.machine()).toMatchObject({ outcome: 'done', step: 'order-desk' });
    expect(rig.ledger.accepted).toHaveLength(4);
    for (const raw of rig.ledger.raw.slice(2)) expect(factsOf(raw).witnesses).toEqual([WALLET_2.keyHash]);
    expect(await openClaims(rig, AUDITOR_ID)).toMatchObject([{ stake_lovelace: CLAIM_STAKE_LOVELACE, challenge_window_ms: CLAIM_WINDOW_MS, claim_type: claimTypeOf(ORDER.capability) }]);
    expect(claimOf(rig, ORDER).claimTx).toBe(rig.ledger.accepted[3]);
  }, SLOW);

  it('stakes both claims with --all, shows the claim token, the document transaction and the claim transaction in the evidence, and does nothing more at the next run', async () => {
    const rig = await makeRig();
    approve(rig);
    const before = held(rig.ledger, rig.address1);
    expect(await stakeAll(rig)).toBe(0);
    expect(rig.world.machine()).toMatchObject({ outcome: 'finished', exit: 0 });
    expect(rig.ledger.accepted).toHaveLength(4);
    const reorder = claimOf(rig);
    const entries = rig.world.evidence('claim', RUN);
    const shown = entries.find((entry) => entry.step === 'reorder-agent');
    expect(shown).toMatchObject({ status: 'confirmed', tx_hash: reorder.claimTx, shows: { claim_token: reorder.claimToken, document_tx: reorder.documentTx, claim_tx: reorder.claimTx, claim: reorder.claimRef } });
    expect(entries.map((entry) => entry.step)).toEqual(['reorder-agent', 'order-desk']);
    expect(rig.world.machine().result).toMatchObject({ run: RUN, claims: { 'reorder-agent': { claimRef: reorder.claimRef, claimToken: reorder.claimToken }, 'order-desk': { claimTx: claimOf(rig, ORDER).claimTx } } });
    // The cap holds the four reserves, and the wallet gave the stake and the fees: it lost at most 50 units and 4 units of fees.
    expect(rig.world.exposure('s1')).toHaveLength(4);
    const lost = before - held(rig.ledger, rig.address1);
    expect(lost >= CLAIM_STAKE_LOVELACE && lost <= CLAIM_STAKE_LOVELACE + 4_000_000n).toBe(true);
    expect(await stakeAll(rig)).toBe(0);
    expect(rig.ledger.accepted).toHaveLength(4);
    expect(rig.world.machine().outcome).toBe('finished');
  }, SLOW);
});

describe('claim run: what stops it before a signature (exit 2)', () => {
  const stopped = (rig: Rig): void => {
    expect(rig.world.machine()).toMatchObject({ outcome: 'stopped', exit: 2 });
    expect(rig.ledger.accepted).toEqual([]);
    expect(stateOf(rig).in_flight).toBeNull();
  };

  it('asks for --run and --kind, and takes only clean and failure', async () => {
    const rig = await makeRig();
    approve(rig);
    expect(await rig.run('run', '--kind', 'clean', '--submit')).toBe(2);
    expect(rig.errors()).toMatch(/give --run/);
    expect(await rig.run('run', '--run', RUN, '--submit')).toBe(2);
    expect(rig.errors()).toMatch(/give --kind/);
    expect(await rig.run('run', '--run', RUN, '--kind', 'other', '--submit')).toBe(2);
    expect(await rig.run('cleanup', '--submit')).toBe(2);
    expect(rig.ledger.accepted).toEqual([]);
    expect(await rig.run('run', '--run', RUN, '--kind', 'clean', '--submit')).toBe(0);
  }, SLOW);

  it('refuses a run with no record in the facts, and a record that is not Active, and a record that does not list the service key, and stakes with the record of the twin', async () => {
    const none = await makeRig({ recordFacts: false });
    approve(none);
    expect(await stakeAll(none)).toBe(2);
    expect(none.errors()).toMatch(/the facts hold no record of the agent reorder-agent/);
    const retired = await makeRig({ records: [RECORD_1_RETIRED, RECORD_2] });
    approve(retired);
    expect(await stakeAll(retired)).toBe(2);
    expect(retired.errors()).toMatch(/is Retired: it must be Active/);
    const unlisted = await makeRig({ records: [RECORD_1_UNLISTED, RECORD_2] });
    approve(unlisted);
    expect(await stakeAll(unlisted)).toBe(2);
    expect(unlisted.errors()).toMatch(/does not list the service key/);
    for (const rig of [none, retired, unlisted]) {
      expect(rig.ledger.accepted).toEqual([]);
      expect(rig.world.facts().claims).toEqual({});
    }
    const good = await makeRig();
    approve(good);
    expect(await good.run('run', '--run', RUN, '--kind', 'clean', '--submit')).toBe(0);
  }, SLOW);

  it('refuses a run with no manifest in the facts, and a run with no commit of the Module-1 manifest, and a manifest of another identity registry', async () => {
    const noManifest = await makeRig({ manifests: false });
    approve(noManifest);
    expect(await stakeAll(noManifest)).toBe(2);
    expect(noManifest.errors()).toMatch(/the facts hold no manifest of the agent reorder-agent/);
    const noCommit = await makeRig({ env: { OPERATOR_MODULE1_COMMIT: undefined } });
    approve(noCommit);
    expect(await stakeAll(noCommit)).toBe(2);
    expect(noCommit.errors()).toMatch(/OPERATOR_MODULE1_COMMIT is not set/);
    const other = await makeRig();
    approve(other);
    const foreign = { ...other.chain, deployment: { ...other.chain.deployment, identity: { ...other.chain.deployment.identity, hash: 'aa'.repeat(28) } } } as ChainAccess;
    expect(await runTask(claim, ['run', '--run', RUN, '--kind', 'clean', '--submit'], other.world.deps({ chain: foreign, fetchImpl: other.web.fetch }))).toBe(2);
    expect(other.errors()).toMatch(/names the identity registry/);
    for (const rig of [noManifest, noCommit, other]) expect(rig.ledger.accepted).toEqual([]);
  }, SLOW);

  it('refuses a wallet that is too small, with the missing amount, and a wallet with no collateral output, and stakes from a wallet that holds enough', async () => {
    const small = await makeRig({ wallet1: [5_000_000n, 40_000_000n] });
    approve(small);
    expect(await stakeAll(small)).toBe(2);
    expect(small.errors()).toMatch(/holds 45.000000 units, and the claim needs 57.000000 units/);
    expect(small.errors()).toMatch(/12.000000 units are missing/);
    const noCollateral = await makeRig({ wallet1: [4_000_000n, 4_000_000n] });
    approve(noCollateral);
    expect(await stakeAll(noCollateral)).toBe(2);
    expect(noCollateral.errors()).toMatch(/holds no pure output of 5 units or more/);
    stopped(small);
    const enough = await makeRig({ wallet1: [5_000_000n, 60_000_000n] });
    approve(enough);
    expect(await enough.run('run', '--run', RUN, '--kind', 'clean', '--submit')).toBe(0);
  }, SLOW);

  it('refuses a run of the kind failure when the Reorder Agent would keep less than 53 units for its challenge, and takes it when it keeps enough', async () => {
    const poor = await makeRig({ wallet1: [5_000_000n, 100_000_000n] });
    approve(poor);
    expect(await poor.run('run', '--run', RUN, '--kind', 'failure', '--submit')).toBe(2);
    expect(poor.errors()).toMatch(/would hold 51.000000 units after the claim and its fees, and the run of the kind failure needs 53.000000 units for a challenge: 2.000000 units are missing/);
    stopped(poor);
    // The same wallet takes a run of the kind clean: the reserve belongs to the kind failure.
    expect(await poor.run('run', '--run', RUN, '--kind', 'clean', '--submit')).toBe(0);
    // A wallet with 3 units more keeps the reserve, and the Order Desk needs none: its wallet holds 67 units.
    const rich = await makeRig({ wallet1: [5_000_000n, 112_000_000n], wallet2: [5_000_000n, 62_000_000n] });
    approve(rich);
    expect(await rich.run('run', '--run', 'run-b', '--kind', 'failure', '--submit', '--all')).toBe(0);
    expect(rich.ledger.accepted).toHaveLength(4);
  }, SLOW);

  it('refuses a run while a runtime that runs says working, says cannot tell for a runtime that answers nothing, and goes on when every runtime that runs is free', async () => {
    const rig = await makeRig();
    approve(rig);
    rig.containers = ['reorder-runtime'];
    rig.web.statuses.set(REORDER_STATUS, 'working');
    expect(await stakeAll(rig)).toBe(2);
    expect(rig.errors()).toMatch(/the runtime reorder-runtime says working: a job runs/);
    // A runtime of the other agent counts too: the use case decides, and a Module-1 build spends the wallet of a service that the runtime uses.
    rig.web.statuses.set(REORDER_STATUS, 'free');
    rig.containers = ['reorder-runtime', 'orders-small-runtime'];
    rig.web.statuses.set(ORDER_STATUS, 'working');
    expect(await stakeAll(rig)).toBe(2);
    expect(rig.errors()).toMatch(/the runtime orders-small-runtime says working/);
    rig.web.statuses.delete(ORDER_STATUS);
    expect(await stakeAll(rig)).toBe(2);
    expect(rig.errors()).toMatch(/cannot tell whether the runtime orders-small-runtime works/);
    stopped(rig);
    // A runtime that is not in running-images.json is not running: it is not asked, and what its host says does not matter.
    rig.containers = ['reorder-runtime'];
    rig.web.statuses.set(ORDER_STATUS, 'working');
    rig.web.calls.length = 0;
    expect(await stakeAll(rig)).toBe(0);
    expect(rig.web.calls).not.toContain(ORDER_STATUS);
    expect(rig.web.calls).toContain(REORDER_STATUS);
  }, SLOW);

  it('refuses a run with no file running-images.json, and a file that is more than 10 minutes old', async () => {
    const rig = await makeRig();
    approve(rig);
    expect(await rig.runBare('run', '--run', RUN, '--kind', 'clean', '--submit')).toBe(2);
    expect(rig.errors()).toMatch(/running-images.json does not exist/);
    writeFileSync(join(rig.world.stateDir, 'running-images.json'), JSON.stringify({ generated_at: iso(NOW - 11 * 60_000), images: {} }), { mode: 0o600 });
    expect(await rig.runBare('run', '--run', RUN, '--kind', 'clean', '--submit')).toBe(2);
    expect(rig.errors()).toMatch(/more than 10 minutes old/);
    expect(rig.ledger.accepted).toEqual([]);
    expect(await rig.run('run', '--run', RUN, '--kind', 'clean', '--submit')).toBe(0);
  }, SLOW);

  it('refuses a submit run with no approval that lists the task, and stakes with one', async () => {
    const rig = await makeRig();
    expect(await rig.run('run', '--run', RUN, '--kind', 'clean', '--submit')).toBe(2);
    rig.world.writeGo({ tasks: ['fund'], capUnits: 200 });
    expect(await rig.run('run', '--run', RUN, '--kind', 'clean', '--submit')).toBe(2);
    expect(rig.ledger.accepted).toEqual([]);
    approve(rig);
    expect(await rig.run('run', '--run', RUN, '--kind', 'clean', '--submit')).toBe(0);
  }, SLOW);
});

describe('claim run: the guards on the transactions of the kit', () => {
  it('refuses a transaction that another key than the signer of the plan must sign, and signs with the service key of the plan, within the plan of a claim: the stake and the fee limit, the claim address, one claim token', async () => {
    const rig = await makeRig();
    const host = makeHost(rig);
    const wrong: GuardedSignRequest = { ...claimRequest(host, REORDER, MODULE1, RUN), signer: 'order-desk-service' };
    const { dispute, stops } = kitOver(rig, host, wrong);
    expect(await dispute.stakeRunClaim(RUN_CLAIM)).toMatchObject({ ok: false, code: 'claim_document_not_built' });
    expect(stops[0]).toBeInstanceOf(GuardRefusal);
    expect((stops[0] as GuardRefusal).failures.map((failure) => failure.guard)).toEqual(['signers']);
    expect(rig.ledger.accepted).toEqual([]);
    const request = claimRequest(host, REORDER, MODULE1, RUN);
    const honest = kitOver(rig, makeHost(rig), request);
    expect(await honest.dispute.stakeRunClaim(RUN_CLAIM)).toMatchObject({ ok: true });
    expect(rig.ledger.accepted).toHaveLength(2);
    // The plan of each transaction, from its own bytes: the document may cost the fee limit, and the claim may cost the stake and the fee limit.
    const planOf = request.plan as (facts: TxFacts) => StepPlan;
    const hash = host.registry.hashOf('reorder-service');
    expect(planOf(factsOf(rig.ledger.raw[0]!)).maxOutflow[hash]).toBe(2_000_000n);
    expect([...planOf(factsOf(rig.ledger.raw[0]!)).destinations]).toEqual([]);
    expect(planOf(factsOf(rig.ledger.raw[0]!)).mint).toEqual({});
    const claimPlan = planOf(factsOf(rig.ledger.raw[1]!));
    expect(claimPlan.maxOutflow[hash]).toBe(CLAIM_STAKE_LOVELACE + 2_000_000n);
    expect([...claimPlan.destinations]).toEqual([MODULE1.claim.address]);
    expect(Object.values(claimPlan.mint)).toEqual([1n]);
    expect(Object.keys(claimPlan.mint)[0]!.startsWith(`${MODULE1.claim.hash}636c6d5f`)).toBe(true);
    expect(claimPlan.explained.size).toBe(0);
  }, SLOW);

  it('refuses a claim with another outflow than the stake and the fee limit: the document lands, the claim is not signed', async () => {
    const rig = await makeRig();
    const host = makeHost(rig);
    const { dispute, stops } = kitOver(rig, host, claimRequest(host, REORDER, MODULE1, RUN));
    const result = await dispute.stakeRunClaim({ ...RUN_CLAIM, stake_lovelace: 100_000_000n });
    expect(result).toMatchObject({ ok: false, code: 'claim_not_built' });
    expect(stops).toHaveLength(1);
    expect(stops[0]).toBeInstanceOf(GuardRefusal);
    expect((stops[0] as GuardRefusal).failures.map((failure) => failure.guard)).toContain('outflow');
    expect(rig.ledger.accepted).toHaveLength(1);
    expect(await openClaims(rig, CLAIMER_ID)).toEqual([]);
  }, SLOW);

  it('refuses the claim when the cap is below it, after the document landed, and says that a new run publishes a second document', async () => {
    const rig = await makeRig();
    approve(rig, 1);
    expect(await stakeAll(rig)).toBe(1);
    expect(rig.errors()).toMatch(/The claim document landed in [0-9a-f]{64}, and the state file keeps it\. A new run publishes a second claim document \(about 0\.2 units\), which is harmless/);
    expect(rig.ledger.accepted).toHaveLength(1);
    expect(stateOf(rig).in_flight).toMatchObject({ step: 'claim:reorder-agent:document', tx_hash: rig.ledger.accepted[0] });
    expect(rig.world.facts().claims).toEqual({});
    // The next run settles the document as a part and stakes the claim with a second document.
    approve(rig, 200, 's2');
    rig.world.node.script.push({ confirmations: 3 });
    expect(await rig.run('run', '--run', RUN, '--kind', 'clean', '--submit')).toBe(0);
    expect(rig.ledger.accepted).toHaveLength(3);
    expect(claimOf(rig).documentTx).toBe(rig.ledger.accepted[1]);
    expect(stateOf(rig).in_flight).toBeNull();
  }, SLOW);
});

describe('claim run: a run that stops after the claim landed', () => {
  it('reads the claim from the chain at the next run, records the facts and the step, and stakes no second claim: it takes the claim of the run, and no other open claim of the agent', async () => {
    const rig = await makeRig();
    approve(rig);
    // The run run-b is staked first. The facts hold its claim, and it is another open claim of the agent when the run run-a resumes.
    expect(await rig.run('run', '--run', 'run-b', '--kind', 'clean', '--submit')).toBe(0);
    expect(rig.ledger.accepted).toHaveLength(2);
    const lock = lockFacts(rig);
    // The facts file is locked: the claim of run-a lands, and the facts cannot be written. The claim stays in flight in the state file.
    expect(await rig.run('run', '--run', RUN, '--kind', 'clean', '--submit')).toBe(1);
    expect(rig.ledger.accepted).toHaveLength(4);
    expect(stateOf(rig).in_flight).toMatchObject({ step: 'claim:reorder-agent:claim', tx_hash: rig.ledger.accepted[3] });
    expect(stateOf(rig).steps).toEqual({});
    rmSync(lock);
    expect(rig.world.facts().claims[RUN]).toBeUndefined();
    // A third open claim of the agent, newer than the claim of run-a, that no run of the facts holds: the resume must take the claim of the run, and never the newest open claim.
    later(rig, 1);
    const host = makeHost(rig);
    const hand = kitOver(rig, host, claimRequest(host, REORDER, MODULE1, 'by-hand'));
    expect(await hand.dispute.stakeRunClaim(RUN_CLAIM)).toMatchObject({ ok: true });
    expect(rig.ledger.accepted).toHaveLength(6);
    expect(await openClaims(rig, CLAIMER_ID)).toHaveLength(3);
    // A dry run says what the next run does, names the claim of the run, and writes nothing.
    rig.world.node.script.push({ confirmations: 3 });
    expect(await rig.run('run', '--run', RUN, '--kind', 'clean')).toBe(0);
    expect(rig.text()).toMatch(/is staked already, and the next run with --submit records the step/);
    expect(rig.text()).toContain(`The claim is ${rig.ledger.accepted[3]}#0.`);
    rig.world.node.script.push({ confirmations: 3 });
    expect(await rig.run('run', '--run', RUN, '--kind', 'clean', '--submit')).toBe(0);
    expect(rig.ledger.accepted).toHaveLength(6);
    const fact = claimOf(rig);
    expect(fact).toMatchObject({ claimTx: rig.ledger.accepted[3], documentTx: rig.ledger.accepted[2], stakeLovelace: '50000000', withdrawTx: null });
    expect(fact.claimRef).toBe(`${rig.ledger.accepted[3]}#0`);
    const state = stateOf(rig);
    expect(state.steps['reorder-agent']).toMatchObject({ tx_hash: fact.claimTx, refs: { claim: fact.claimRef } });
    expect(state.notes['part.claim:reorder-agent:claim']).toMatchObject({ tx_hash: fact.claimTx });
    expect(state.in_flight).toBeNull();
    expect(claimOf(rig, REORDER, 'run-b').claimTx).toBe(rig.ledger.accepted[1]);
    // The next run goes on with the second agent.
    expect(await stakeAll(rig)).toBe(0);
    expect(rig.ledger.accepted).toHaveLength(8);
  }, SLOW);

  it('keeps the flight of a claim that landed, lets it go at the word of the operator when its validity is over, and then records the claim from the chain: the state file holds only the part of the claim document, and no second claim is staked', async () => {
    const rig = await makeRig();
    approve(rig);
    const lock = lockFacts(rig);
    expect(await rig.run('run', '--run', RUN, '--kind', 'clean', '--submit')).toBe(1);
    rmSync(lock);
    expect(rig.ledger.accepted).toHaveLength(2);
    const hash = rig.ledger.accepted[1]!;
    expect(stateOf(rig).in_flight).toMatchObject({ step: 'claim:reorder-agent:claim', tx_hash: hash });
    // The indexer does not know the claim, and its validity ended more than a minute ago. The claim landed, so every input of its transaction is spent: the runner keeps the flight and builds nothing.
    later(rig, 1);
    expect(await rig.run('run', '--run', RUN, '--kind', 'clean', '--submit')).toBe(2);
    expect(rig.errors()).toContain('but all 1 of its inputs are spent, and a transaction that landed spends all of them. It may have landed.');
    expect(rig.errors()).toContain(`--release=${hash} and --submit`);
    expect(stateOf(rig).in_flight).toMatchObject({ step: 'claim:reorder-agent:claim', tx_hash: hash });
    expect(rig.ledger.accepted).toHaveLength(2);
    expect(rig.world.facts().claims).toEqual({});
    // The operator checks the chain and lets the flight go. The validity is over, so the runner allows it.
    expect(await rig.run('cleanup', '--run', RUN, `--release=${hash}`, '--submit')).toBe(0);
    expect(rig.text()).toContain(`the operator says that the chain was checked and that the transaction ${hash} of the step claim:reorder-agent:claim is not there: it is let go.`);
    expect(stateOf(rig).in_flight).toBeNull();
    expect(rig.ledger.accepted).toHaveLength(2);
    // The state file holds the part of the claim document and no part of the claim: the next run reads the claim from the chain, records it, and stakes no second claim.
    expect(await rig.run('run', '--run', RUN, '--kind', 'clean', '--submit')).toBe(0);
    const state = stateOf(rig);
    expect(state.notes['part.claim:reorder-agent:claim']).toBeUndefined();
    expect(state.notes['part.claim:reorder-agent:document']).toMatchObject({ tx_hash: rig.ledger.accepted[0] });
    expect(state.in_flight).toBeNull();
    expect(rig.ledger.accepted).toHaveLength(2);
    const fact = claimOf(rig);
    expect(fact).toMatchObject({ documentTx: rig.ledger.accepted[0], claimTx: rig.ledger.accepted[1], stakeLovelace: '50000000', windowMs: CLAIM_WINDOW_MS, withdrawTx: null });
    expect(state.steps['reorder-agent']).toMatchObject({ tx_hash: fact.claimTx, refs: { claim: fact.claimRef } });
    expect(await openClaims(rig, CLAIMER_ID)).toHaveLength(1);
  }, SLOW);

  it('stops a new claim with exit 2, in a dry run and in a submit run, when the agent has an open claim with the constants that no run of the facts holds, and stakes when the facts hold that claim', async () => {
    const rig = await makeRig();
    approve(rig);
    // A claim of the constants that the facts do not hold: the kit stakes it by hand, as a run that stopped and lost its state would have left it.
    const host = makeHost(rig);
    const hand = kitOver(rig, host, claimRequest(host, REORDER, MODULE1, 'by-hand'));
    const made = await hand.dispute.stakeRunClaim(RUN_CLAIM);
    if (!made.ok) throw new Error(`${made.code}: ${made.detail}`);
    expect(rig.ledger.accepted).toHaveLength(2);
    for (const mode of [['--submit'], []]) {
      expect(await rig.run('run', '--run', RUN, '--kind', 'clean', ...mode)).toBe(2);
      expect(rig.world.machine()).toMatchObject({ outcome: 'stopped', exit: 2 });
      expect(rig.errors()).toMatch(/the agent reorder-agent has 1 open claim\(s\) with the stake, the window and the claim type of the constants that no run of the facts holds/);
      expect(rig.errors()).toContain(made.value.claim);
    }
    expect(rig.ledger.accepted).toHaveLength(2);
    expect(rig.world.facts().claims).toEqual({});
    // The accepted twin: a run of the facts holds the claim, so it is no orphan, and the new claim is staked.
    const value = made.value;
    FactsFile.open(join(rig.world.stateDir, 'facts.json'), { useCase: USE_CASE, network: 'vector-mainnet' }).put('claims', ['by-hand', 'reorder-agent'], {
      claimRef: value.claim, documentTx: value.document.tx_hash, claimTx: value.claim_tx, claimToken: value.claim_token, stakeLovelace: String(value.stake_lovelace), windowMs: value.challenge_window_ms,
      stakedAt: iso(value.submitted_at), withdrawableFrom: iso(withdrawableFrom({ submitted_at: value.submitted_at, challenge_window_ms: value.challenge_window_ms })), withdrawTx: null,
    });
    expect(await rig.run('run', '--run', RUN, '--kind', 'clean', '--submit')).toBe(0);
    expect(rig.ledger.accepted).toHaveLength(4);
    expect(await openClaims(rig, CLAIMER_ID)).toHaveLength(2);
  }, SLOW);

  it('records the step from the facts when the state file is gone, and stakes no second claim', async () => {
    const rig = await makeRig();
    approve(rig);
    expect(await rig.run('run', '--run', RUN, '--kind', 'clean', '--submit')).toBe(0);
    rmSync(join(rig.world.stateDir, `claim.${RUN}.state.json`));
    expect(await rig.run('run', '--run', RUN, '--kind', 'clean', '--submit')).toBe(0);
    expect(rig.ledger.accepted).toHaveLength(2);
    expect(stateOf(rig).steps['reorder-agent']).toMatchObject({ tx_hash: claimOf(rig).claimTx });
  }, SLOW);

  it('refuses to record a claim that the chain does not show open, and stakes nothing', async () => {
    const rig = await makeRig();
    approve(rig);
    const lock = lockFacts(rig);
    expect(await rig.run('run', '--run', RUN, '--kind', 'clean', '--submit')).toBe(1);
    rmSync(lock);
    // The claim output is spent: a challenge moved it.
    rig.ledger.live = rig.ledger.live.filter((utxo) => utxo.address !== MODULE1.claim.address);
    rig.world.node.script.push({ confirmations: 3 });
    expect(await rig.run('run', '--run', RUN, '--kind', 'clean', '--submit')).toBe(2);
    expect(rig.errors()).toMatch(/the chain shows no open claim that it made/);
    expect(rig.ledger.accepted).toHaveLength(2);
    expect(rig.world.facts().claims).toEqual({});
  }, SLOW);

  it('stakes a new claim for the run when the state file holds only a claim document that no open claim names, also when another open claim of the agent exists: the claim of another run is not the claim of this run', async () => {
    const rig = await makeRig();
    approve(rig);
    // The claim of run-b is open, and the facts hold it.
    expect(await rig.run('run', '--run', 'run-b', '--kind', 'clean', '--submit')).toBe(0);
    expect(rig.ledger.accepted).toHaveLength(2);
    // The claim document of run-a lands, and the cap stops the claim: no claim was made from that document.
    approve(rig, 1, 's2');
    expect(await rig.run('run', '--run', RUN, '--kind', 'clean', '--submit')).toBe(1);
    expect(rig.ledger.accepted).toHaveLength(3);
    // The next run settles the document as a part. The open claim of run-b does not name it, so a new claim is staked with a new document.
    approve(rig, 200, 's3');
    rig.world.node.script.push({ confirmations: 3 });
    expect(await rig.run('run', '--run', RUN, '--kind', 'clean', '--submit')).toBe(0);
    expect(stateOf(rig).notes['part.claim:reorder-agent:document']).toMatchObject({ tx_hash: rig.ledger.accepted[3] });
    expect(rig.ledger.accepted).toHaveLength(5);
    const a = claimOf(rig);
    const b = claimOf(rig, REORDER, 'run-b');
    expect(a).toMatchObject({ documentTx: rig.ledger.accepted[3], claimTx: rig.ledger.accepted[4] });
    expect(b.claimTx).toBe(rig.ledger.accepted[1]);
    expect(a.claimRef).not.toBe(b.claimRef);
    expect(await openClaims(rig, CLAIMER_ID)).toHaveLength(2);
  }, SLOW);
});

describe('claim cleanup', () => {
  it('runs the free check, waits with exit 4 and the time left before the window, signs nothing, and withdraws both claims after it: the stake comes back and each fact says in which transaction', async () => {
    const rig = await staged();
    const first = claimOf(rig);
    approve(rig, 10, 's2');
    // Before the window: exit 4, nothing is signed. The runtime of the Reorder Agent runs and says free, so the free check is asked and passes.
    rig.containers = ['reorder-runtime'];
    rig.web.statuses.set(REORDER_STATUS, 'free');
    rig.web.calls.length = 0;
    expect(await cleanup(rig)).toBe(4);
    expect(rig.world.machine()).toMatchObject({ outcome: 'wait', exit: 4 });
    expect(rig.text()).toMatch(/WAIT: a claim of the run run-a cannot be withdrawn yet: the earliest window ends at /);
    expect(rig.text()).toContain(`ends at ${first.withdrawableFrom}`);
    expect(rig.web.calls).toContain(REORDER_STATUS);
    expect(rig.ledger.accepted).toHaveLength(4);
    expect(rig.ledger.atAddress(MODULE1.claim.address)).toHaveLength(2);
    const before = held(rig.ledger, rig.address1);
    // After the window: both claims are withdrawn.
    later(rig, 25);
    approve(rig, 10, 's3');
    expect(await cleanup(rig)).toBe(0);
    expect(rig.world.machine()).toMatchObject({ outcome: 'done' });
    expect(rig.ledger.accepted).toHaveLength(6);
    expect(rig.ledger.atAddress(MODULE1.claim.address)).toEqual([]);
    const reorder = claimOf(rig);
    const order = claimOf(rig, ORDER);
    expect(reorder.withdrawTx).toBe(rig.ledger.accepted[4]);
    expect(order.withdrawTx).toBe(rig.ledger.accepted[5]);
    expect(held(rig.ledger, rig.address1) - before >= CLAIM_STAKE_LOVELACE - 1_500_000n).toBe(true);
    for (const raw of rig.ledger.raw.slice(4)) expect(factsOf(raw).witnesses).toHaveLength(1);
    const state = stateOf(rig);
    expect(state.notes['part.withdraw:reorder-agent']).toMatchObject({ tx_hash: reorder.withdrawTx, refs: { claim: reorder.claimRef } });
    expect(state.in_flight).toBeNull();
    expect(rig.world.evidence('claim', RUN).filter((entry) => String(entry.step).startsWith('withdraw:'))).toHaveLength(2);
    // Cleanup again: both claims are settled, and nothing is signed.
    expect(await cleanup(rig)).toBe(0);
    expect(rig.text()).toMatch(/is settled already/);
    expect(rig.ledger.accepted).toHaveLength(6);
  }, SLOW);

  it('stops at a runtime that says working before it withdraws anything, and withdraws when the runtime is free', async () => {
    const rig = await staged();
    later(rig, 25);
    approve(rig, 10, 's2');
    rig.containers = ['orders-large-runtime'];
    rig.web.statuses.set(`${data.agents[1]!.adverts[2]!.origin}/status`, 'working');
    expect(await cleanup(rig)).toBe(2);
    expect(rig.errors()).toMatch(/orders-large-runtime says working/);
    expect(rig.ledger.accepted).toHaveLength(4);
    rig.web.statuses.set(`${data.agents[1]!.adverts[2]!.origin}/status`, 'free');
    expect(await cleanup(rig)).toBe(0);
    expect(rig.ledger.accepted).toHaveLength(6);
  }, SLOW);

  it('shows a dry run of the withdrawal after the window, and signs nothing', async () => {
    const rig = await staged();
    later(rig, 25);
    expect(await rig.run('cleanup', '--run', RUN)).toBe(0);
    expect(rig.world.machine()).toMatchObject({ mode: 'dry', outcome: 'dry' });
    expect(rig.text()).toContain('step withdraw:reorder-agent: dry mode, nothing is signed or submitted');
    expect(rig.text()).toContain('dry run: the withdrawal of the claim of the agent reorder-agent is built and judged, and nothing is signed');
    expect(rig.ledger.accepted).toHaveLength(4);
    expect(claimOf(rig).withdrawTx).toBeNull();
  }, SLOW);

  it('records a claim that is no longer open as not open and fails nothing, and withdraws the other claim', async () => {
    const rig = await staged();
    const order = claimOf(rig, ORDER);
    // A challenge moved the claim of the Order Desk: its output is spent, and the indexer shows it as spent.
    const spent = rig.ledger.live.filter((utxo) => utxo.txHash === order.claimTx);
    rig.ledger.live = rig.ledger.live.filter((utxo) => utxo.txHash !== order.claimTx);
    rig.ledger.koiosSpent.push(...spent);
    later(rig, 25);
    approve(rig, 10, 's2');
    expect(await cleanup(rig)).toBe(0);
    expect(claimOf(rig, ORDER).withdrawTx).toBe('not open');
    expect(claimOf(rig).withdrawTx).toBe(rig.ledger.accepted[4]);
    expect(rig.ledger.accepted).toHaveLength(5);
    expect(rig.text()).toMatch(/the claim of the agent order-desk is not open .*recorded as not open/);
  }, SLOW);

  it('records nothing in a dry run that cannot see a claim output, and withdraws both claims at the next submit run when the output is there', async () => {
    const rig = await staged();
    const order = claimOf(rig, ORDER);
    // The node does not show the claim output of the Order Desk. A dry run says so, and writes nothing.
    const hidden = rig.ledger.live.filter((utxo) => utxo.txHash === order.claimTx);
    expect(hidden.length).toBeGreaterThan(0);
    rig.ledger.live = rig.ledger.live.filter((utxo) => utxo.txHash !== order.claimTx);
    later(rig, 25);
    expect(await rig.run('cleanup', '--run', RUN)).toBe(0);
    expect(rig.world.machine()).toMatchObject({ mode: 'dry', outcome: 'dry', exit: 0 });
    expect(rig.text()).toMatch(/the chain shows no open claim for the agent order-desk, and a dry run records nothing/);
    expect(claimOf(rig, ORDER).withdrawTx).toBeNull();
    expect(claimOf(rig).withdrawTx).toBeNull();
    expect(rig.ledger.accepted).toHaveLength(4);
    // The output is there again: a submit run withdraws both claims, and no claim stays locked.
    rig.ledger.live.push(...hidden);
    approve(rig, 10, 's2');
    expect(await cleanup(rig)).toBe(0);
    expect(claimOf(rig).withdrawTx).toBe(rig.ledger.accepted[4]);
    expect(claimOf(rig, ORDER).withdrawTx).toBe(rig.ledger.accepted[5]);
    expect(await openClaims(rig, AUDITOR_ID)).toEqual([]);
  }, SLOW);

  it('records nothing when the network guard failed, stops with exit 2, and withdraws both claims when the node is on the right network', async () => {
    const rig = await staged();
    const claimTxs = [claimOf(rig).claimTx, claimOf(rig, ORDER).claimTx];
    const hidden = rig.ledger.live.filter((utxo) => claimTxs.includes(utxo.txHash));
    rig.ledger.live = rig.ledger.live.filter((utxo) => !claimTxs.includes(utxo.txHash));
    // A node of another network: its network guard fails, and it shows no claim output.
    const right = rig.world.node.facts;
    rig.world.node.facts = { ...right, magic: right.magic + 1 };
    later(rig, 25);
    approve(rig, 10, 's2');
    expect(await cleanup(rig)).toBe(2);
    expect(rig.world.machine()).toMatchObject({ outcome: 'stopped', exit: 2 });
    expect(rig.errors()).toMatch(/network guard: FAIL/);
    expect(rig.errors()).toMatch(/the network guard did not pass, so the node cannot say that a claim is not open: nothing is recorded for reorder-agent and order-desk/);
    expect(claimOf(rig).withdrawTx).toBeNull();
    expect(claimOf(rig, ORDER).withdrawTx).toBeNull();
    expect(rig.ledger.accepted).toHaveLength(4);
    // The node is on the right network again and shows the outputs: both claims are withdrawn.
    rig.ledger.live.push(...hidden);
    rig.world.node.facts = right;
    approve(rig, 10, 's3');
    expect(await cleanup(rig)).toBe(0);
    expect(rig.ledger.accepted).toHaveLength(6);
    expect(await openClaims(rig, CLAIMER_ID)).toEqual([]);
    expect(await openClaims(rig, AUDITOR_ID)).toEqual([]);
  }, SLOW);

  it('stops with exit 2 and records nothing when the manifest of another claim script reads no claim although its output is unspent, and withdraws with the right commit', async () => {
    const rig = await staged();
    later(rig, 25);
    approve(rig, 10, 's2');
    // The commit of the manifest is wrong: it names another claim script, so the claim outputs of the run are no open claims for it. They are unspent all the same.
    const wrong = 'b'.repeat(40);
    const script = 'ab'.repeat(28);
    rig.web.manifests.set(`${MANIFEST_BASE}/${wrong}/${data.moduleManifestPath}`, { ...MODULE1_MANIFEST, hashes: { ...MODULE1_MANIFEST.hashes, claim: script }, addresses: { ...MODULE1_MANIFEST.addresses, claim: scriptAddress(script) } });
    rig.world.env.OPERATOR_MODULE1_COMMIT = wrong;
    expect(await cleanup(rig)).toBe(2);
    expect(rig.errors()).toMatch(/the indexer shows the claim output \S+ of the agent reorder-agent as unspent, while the node and the Module-1 manifest of this run read no open claim in it/);
    expect(claimOf(rig).withdrawTx).toBeNull();
    expect(claimOf(rig, ORDER).withdrawTx).toBeNull();
    expect(rig.ledger.accepted).toHaveLength(4);
    rig.world.env.OPERATOR_MODULE1_COMMIT = COMMIT;
    approve(rig, 10, 's3');
    expect(await cleanup(rig)).toBe(0);
    expect(rig.ledger.accepted).toHaveLength(6);
    expect(await openClaims(rig, CLAIMER_ID)).toEqual([]);
  }, SLOW);

  it('records nothing when the node is behind: it passes the network guard and shows no claim output, the indexer cannot say that the output is spent, and the run stops with exit 2', async () => {
    const rig = await staged();
    const order = claimOf(rig, ORDER);
    // The node is behind: it does not show the claim output of the Order Desk yet. The indexer shows the output as unspent.
    const behind = rig.ledger.live.filter((utxo) => utxo.txHash === order.claimTx);
    expect(behind.length).toBeGreaterThan(0);
    rig.ledger.live = rig.ledger.live.filter((utxo) => utxo.txHash !== order.claimTx);
    rig.ledger.koiosOnly.push(...behind);
    later(rig, 25);
    approve(rig, 10, 's2');
    // The claim of the Reorder Agent comes first and is withdrawn in this run, so the runner calls the end a failure (exit 1): a transaction landed. The run ends at the Order Desk claim.
    expect(await cleanup(rig)).toBe(1);
    expect(rig.world.machine()).toMatchObject({ outcome: 'failed', exit: 1 });
    expect(rig.errors()).toMatch(/the indexer shows the claim output \S+ of the agent order-desk as unspent/);
    expect(claimOf(rig, ORDER).withdrawTx).toBeNull();
    // The claim of the Reorder Agent came first, and it is withdrawn: the stop is for the claim that the indexer does not show as spent.
    expect(claimOf(rig).withdrawTx).toBe(rig.ledger.accepted[4]);
    expect(rig.ledger.accepted).toHaveLength(5);
    // An indexer that does not know the output yet, and an indexer that cannot be read, stop the run in the same way.
    rig.ledger.koiosBehind.add(order.claimTx);
    expect(await cleanup(rig)).toBe(2);
    expect(rig.errors()).toMatch(/the indexer does not know the claim output \S+ of the agent order-desk/);
    rig.ledger.koiosBehind.delete(order.claimTx);
    rig.ledger.koiosStatus = 503;
    expect(await cleanup(rig)).toBe(2);
    expect(rig.errors()).toMatch(/the indexer cannot be read \(Koios utxo_info answered 503\)/);
    rig.ledger.koiosStatus = null;
    expect(claimOf(rig, ORDER).withdrawTx).toBeNull();
    expect(rig.ledger.accepted).toHaveLength(5);
    // The node has caught up: it shows the output, and the claim is withdrawn.
    rig.ledger.koiosOnly.splice(0, rig.ledger.koiosOnly.length);
    rig.ledger.live.push(...behind);
    approve(rig, 10, 's3');
    expect(await cleanup(rig)).toBe(0);
    expect(claimOf(rig, ORDER).withdrawTx).toBe(rig.ledger.accepted[5]);
    expect(await openClaims(rig, AUDITOR_ID)).toEqual([]);
  }, SLOW);

  it('touches nothing for another run label, and for a run that the facts do not hold', async () => {
    const rig = await staged();
    later(rig, 25);
    approve(rig, 10, 's2');
    expect(await rig.run('cleanup', '--run', 'run-b', '--submit')).toBe(2);
    expect(rig.errors()).toMatch(/the facts hold no claim of the run run-b/);
    expect(rig.ledger.accepted).toHaveLength(4);
    expect(rig.ledger.atAddress(MODULE1.claim.address)).toHaveLength(2);
    expect(claimOf(rig).withdrawTx).toBeNull();
    expect(await cleanup(rig)).toBe(0);
  }, SLOW);

  it('waits for the withdrawableFrom of the facts even when the chain shows the window ended, and withdraws after it', async () => {
    const rig = await staged();
    const fact = claimOf(rig);
    const facts = FactsFile.open(join(rig.world.stateDir, 'facts.json'), { useCase: USE_CASE, network: 'vector-mainnet' });
    facts.put('claims', [RUN, 'reorder-agent'], { ...fact, withdrawableFrom: iso(Date.parse(fact.withdrawableFrom) + 48 * HOUR) }, { replace: true });
    later(rig, 25);
    approve(rig, 10, 's2');
    expect(await cleanup(rig)).toBe(4);
    expect(rig.text()).toMatch(/the window of the claim of the agent reorder-agent ends at /);
    // The claim of the Order Desk is due by its own facts, so it is withdrawn. The claim of the Reorder Agent is not touched: it is open on the chain.
    expect(rig.ledger.accepted).toHaveLength(5);
    expect(claimOf(rig, ORDER).withdrawTx).toBe(rig.ledger.accepted[4]);
    expect(claimOf(rig).withdrawTx).toBeNull();
    expect(await openClaims(rig, CLAIMER_ID)).toHaveLength(1);
    later(rig, 48);
    approve(rig, 10, 's3');
    expect(await cleanup(rig)).toBe(0);
    expect(rig.ledger.accepted).toHaveLength(6);
    expect(claimOf(rig).withdrawTx).toBe(rig.ledger.accepted[5]);
  }, SLOW);

  it('keeps the withdrawal that landed when the facts cannot be written, and records its transaction at the next run without a second withdrawal', async () => {
    const rig = await staged();
    later(rig, 25);
    approve(rig, 10, 's2');
    const lock = lockFacts(rig);
    expect(await cleanup(rig)).toBe(1);
    expect(rig.ledger.accepted).toHaveLength(5);
    expect(claimOf(rig).withdrawTx).toBeNull();
    rmSync(lock);
    expect(await cleanup(rig)).toBe(0);
    expect(claimOf(rig).withdrawTx).toBe(rig.ledger.accepted[4]);
    expect(claimOf(rig, ORDER).withdrawTx).toBe(rig.ledger.accepted[5]);
    expect(rig.ledger.accepted).toHaveLength(6);
  }, SLOW);

  it('refuses a withdrawal whose plan does not explain the claim output, and signs the withdrawal of the plan that explains it', async () => {
    const rig = await staged();
    later(rig, 25);
    const fact = claimOf(rig);
    const host = makeHost(rig);
    const request = withdrawRequest(host, REORDER, MODULE1, RUN, fact);
    const unexplained: GuardedSignRequest = { ...request, plan: { ...(request.plan as StepPlan), explained: new Set<string>() } };
    const refused = kitOver(rig, host, unexplained);
    expect(await refused.dispute.withdrawClaim({ claim: fact.claimRef })).toMatchObject({ ok: false, code: 'withdraw_not_built' });
    expect(refused.stops[0]).toBeInstanceOf(GuardRefusal);
    expect((refused.stops[0] as GuardRefusal).failures.map((failure) => failure.guard)).toContain('inputs');
    expect(rig.ledger.accepted).toHaveLength(4);
    const honest = kitOver(rig, makeHost(rig), request);
    expect(await honest.dispute.withdrawClaim({ claim: fact.claimRef })).toMatchObject({ ok: true });
    expect(rig.ledger.accepted).toHaveLength(5);
  }, SLOW);

  it('is refused by the cap and the approval like any transaction', async () => {
    const rig = await staged();
    later(rig, 25);
    approve(rig, 10, 's2');
    const host = makeHost(rig, 0);
    const request = withdrawRequest(host, REORDER, MODULE1, RUN, claimOf(rig));
    const refused = kitOver(rig, host, request);
    expect(await refused.dispute.withdrawClaim({ claim: claimOf(rig).claimRef })).toMatchObject({ ok: false });
    expect(refused.stops[0]).toBeInstanceOf(ApprovalError);
    expect(rig.ledger.accepted).toHaveLength(4);
  }, SLOW);

  it('stops with exit 2 when the service key is not the claimer of the claim that the facts name, and withdraws nothing', async () => {
    const rig = await staged();
    const reorder = claimOf(rig);
    const order = claimOf(rig, ORDER);
    // The facts of the Order Desk name the claim of the Reorder Agent, which another key staked.
    const facts = FactsFile.open(join(rig.world.stateDir, 'facts.json'), { useCase: USE_CASE, network: 'vector-mainnet' });
    facts.put('claims', [RUN, 'order-desk'], { ...order, claimRef: reorder.claimRef, claimToken: reorder.claimToken }, { replace: true });
    facts.put('claims', [RUN, 'reorder-agent', 'withdrawTx'], 'not open');
    later(rig, 25);
    approve(rig, 10, 's2');
    expect(await cleanup(rig)).toBe(2);
    expect(rig.errors()).toMatch(/the service key of the agent order-desk is not the claimer of the claim/);
    expect(rig.ledger.accepted).toHaveLength(4);
    expect(await openClaims(rig, CLAIMER_ID)).toHaveLength(1);
  }, SLOW);
});

describe('claim status', () => {
  it('shows the claims of the run from the facts with the time left of each window, and the open claims that the chain shows', async () => {
    const rig = await staged();
    expect(await rig.run('status', '--run', RUN)).toBe(0);
    const fact = claimOf(rig);
    expect(rig.text()).toContain(`the claims of the run ${RUN}, from the facts:`);
    expect(rig.text()).toContain(`reorder-agent: ${fact.claimRef}, 50.000000 units for 1 day`);
    expect(rig.text()).toMatch(/withdrawable from \S+ \(.* left\), not withdrawn/);
    expect(rig.text()).toContain('the open claims of the agent reorder-agent on the chain: 1');
    expect(rig.text()).toContain('the open claims of the agent order-desk on the chain: 1');
    expect(rig.ledger.accepted).toHaveLength(4);
    await rig.run('status', '--run', 'run-b');
    expect(rig.text()).toContain('reorder-agent: no claim in the facts');
  }, SLOW);
});

describe('claim run --trial', () => {
  const dirOf = (rig: Rig): string => join(rig.world.stateDir, 'trial');
  const readTrial = (rig: Rig) => JSON.parse(readFileSync(join(dirOf(rig), 'trial.json'), 'utf8')) as {
    sample: Record<string, boolean>; order_desk_did: string; reorder_agent_did: string; manifest_sha256: string;
    cases: { case: string; files: { file: string; bytes: number; sha256: string; document_hash?: string }[] }[];
  };

  it('writes four files for each of the three cases and trial.json: each file has at most 3,000 bytes, its SHA-256 in trial.json is the SHA-256 of the file, and a DID that the facts lack is a marked sample', async () => {
    const rig = await makeRig({ recordFacts: false, manifests: false });
    expect(await rig.runBare('run', '--trial')).toBe(0);
    expect(rig.world.machine()).toMatchObject({ outcome: 'done', exit: 0, result: { trial: true, cases: ['wrong-lot', 'wrong-quantity', 'wrong-sku'] } });
    const trial = readTrial(rig);
    expect(trial.sample).toEqual({ order_desk_did: true, reorder_agent_did: true, manifest_sha256: true, references: true });
    expect(trial.cases.map((entry) => entry.case)).toEqual(['wrong-lot', 'wrong-quantity', 'wrong-sku']);
    const names = readdirSync(dirOf(rig)).filter((name) => !name.endsWith('.tmp')).sort();
    expect(names).toHaveLength(13);
    for (const entry of trial.cases) {
      expect(entry.files.map((file) => file.file)).toEqual([`${entry.case}.claim.txt`, `${entry.case}.evidence.txt`, `${entry.case}.purchase-order.json`, `${entry.case}.confirmation.json`]);
      for (const file of entry.files) {
        const bytes = readFileSync(join(dirOf(rig), file.file));
        expect(bytes.length, file.file).toBe(file.bytes);
        expect(bytes.length, file.file).toBeLessThanOrEqual(3000);
        expect(createHash('sha256').update(bytes).digest('hex'), file.file).toBe(file.sha256);
        expect(file.document_hash !== undefined, file.file).toBe(file.file.endsWith('.txt'));
      }
    }
    expect(rig.world.machine().result).toMatchObject({ sample: { order_desk_did: true } });
    expect(rig.web.calls).toEqual([]);
    expect(rig.ledger.accepted).toEqual([]);
  }, SLOW);

  it('writes documents that show the three faults: the lot, the quantity and the SKU, and the claim of the Order Desk with its statements', async () => {
    const rig = await makeRig({ recordFacts: false, manifests: false });
    expect(await rig.runBare('run', '--trial')).toBe(0);
    const text = (name: string): string => readFileSync(join(dirOf(rig), name), 'utf8');
    expect(text('wrong-lot.evidence.txt')).toContain('The lot differs.');
    expect(text('wrong-quantity.evidence.txt')).toContain('The SKU is the same in both. The lot is the same in both. The quantity differs.');
    expect(text('wrong-sku.evidence.txt')).toContain('The SKU differs. The lot is the same in both. The quantity is the same in both.');
    for (const name of ['wrong-lot', 'wrong-quantity', 'wrong-sku']) {
      for (const statement of ORDER_DESK_CLAIM.statements) expect(text(`${name}.claim.txt`)).toContain(statement.text);
      expect(text(`${name}.evidence.txt`)).toContain(ORDER_DESK_CLAIM.statements[0].text);
    }
    expect(JSON.parse(text('wrong-lot.confirmation.json'))).toMatchObject({ fault_mode: 'confirm_wrong_lot', lot: 'lot-small', quantity: 10, sku: 'GLV-NIT-M' });
    expect(JSON.parse(text('wrong-lot.purchase-order.json'))).toMatchObject({ lot: 'lot-medium', quantity: 50, sku: 'GLV-NIT-M' });
    expect(JSON.parse(text('wrong-sku.confirmation.json'))).toMatchObject({ fault_mode: '', sku: 'MSK-N95' });
  }, SLOW);

  it('uses the DIDs and the manifest hash of the facts when the facts hold them, and marks no sample for them', async () => {
    const rig = await makeRig();
    expect(await rig.runBare('run', '--trial')).toBe(0);
    const trial = readTrial(rig);
    expect(trial.sample).toEqual({ order_desk_did: false, reorder_agent_did: false, manifest_sha256: false, references: true });
    expect(trial.order_desk_did).toBe(`did:vector:${AUDITOR_ID}`);
    expect(trial.reorder_agent_did).toBe(`did:vector:${CLAIMER_ID}`);
    expect(trial.manifest_sha256).toBe(MANIFEST_SHA);
    expect(readFileSync(join(dirOf(rig), 'wrong-lot.claim.txt'), 'utf8')).toContain(`did:vector:${AUDITOR_ID}`);
  }, SLOW);

  it('takes no --submit, and has no cleanup', async () => {
    const rig = await makeRig();
    approve(rig);
    expect(await rig.runBare('run', '--trial', '--submit')).toBe(2);
    expect(existsSync(dirOf(rig))).toBe(false);
    expect(await rig.runBare('cleanup', '--trial')).toBe(2);
    expect(existsSync(dirOf(rig))).toBe(false);
  }, SLOW);

  it('refuses a document over 3,000 bytes and a document that its builder refuses, and takes a document within the limit', () => {
    const document = (size: number): JurorDocument => ({ type: 'claim', media_type: 'text/plain', text: 'x', bytes: Buffer.alloc(size, 0x78), hash: 'ab'.repeat(32) });
    expect(trialDocument({ ok: true, value: document(3000) }, 'sample').bytes).toHaveLength(3000);
    expect(() => trialDocument({ ok: true, value: document(3001) }, 'sample')).toThrow(PreconditionError);
    expect(() => trialDocument({ ok: true, value: document(3001) }, 'sample')).toThrow(/has 3001 bytes, and a document for a juror has at most 3000/);
    expect(() => trialDocument({ ok: false, code: 'document_too_large', detail: 'the document is long' }, 'sample')).toThrow(/cannot be made \(document_too_large\)/);
  });
});
