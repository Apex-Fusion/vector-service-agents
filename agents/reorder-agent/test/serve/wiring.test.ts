// agents/reorder-agent/test/serve/wiring.test.ts
// The wiring joins the folders of the agent to the real parts. The tests run it over the stub marketplace of the hire kit (a FakeChain, an indexer and a model supplier behind one fetch), the offline node of
// the fixture world, the key hashes of the fixture world, and the golden supplier of the model folder. They show what the wiring decides and nothing of what the jobs decide: one queue for each key, one set of
// delegation ids, one counter and one list of left sub-delegations for the process, the deadline of a decision from the job that asks it, a key kept out of every log line, and a start that the node can stop.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import type { VaultChain } from '@vsa/buyer-core';
import { ALLOWLIST, INDEXER, LLM_ADVERT, T0, marketplace, vaultChainWith } from '@vsa/hire-kit/testing';
import type { Marketplace } from '@vsa/hire-kit/testing';
import type { Clock } from '@vsa/usecase-kit/access';
import type { ModelLimits } from '@vsa/usecase-kit/decision';
import { parseOrderConfirmation, parsePurchaseOrder } from '@vsa/usecase-kit/inventory';
import { DELEG_A, DEPLOYMENT, SYSTEM_START_MS, liveDelegation, world } from '../../../../packages/usecase-kit/test/cosign/support.ts';
import type { Module1Provider } from '@vsa/usecase-kit/dispute';
import { PROPOSE_DEADLINE_MS } from '../../src/propose/index.ts';
import { keyOf } from '../../src/serve/keys.ts';
import { loadConfig } from '../../src/serve/start.ts';
import type { ServiceConfig } from '../../src/serve/start.ts';
import { cosignSettingsOf } from '../../src/serve/settings.ts';
import { STATE_FILES, todayOf, wire } from '../../src/serve/wiring.ts';
import type { SupplierSources, Wired, WiringOptions } from '../../src/serve/wiring.ts';
import { said } from '../model/decide-support.ts';
import { AGENT_ID as SUPPLIER_AGENT_ID, CAPABILITY, SKU, SUPPLIER as SUPPLIER_DID, goldenWorld } from '../model/supplier-support.ts';
import { golden, must } from '../model/support.ts';
import { KEY_NUMBERS, KEY_VARIABLES, ROLES, cleanDirs, completeEnv, messageOf, rawKey, secretsOf, tempDir } from './support.ts';

afterEach(cleanDirs);

/** The limits that fit the model advert of the stub marketplace exactly, as the decisions of the kit tests do. */
const LIMITS: ModelLimits = {
  allowlist: ALLOWLIST, maxPriceLovelace: LLM_ADVERT.price_lovelace, maxSupplierBondLovelace: LLM_ADVERT.supplier_bond_lovelace, maxBuyerBondLovelace: LLM_ADVERT.buyer_bond_lovelace,
};
const READING = { sku: 'GLV-NIT-M', on_hand: 60, threshold: 100, daily_usage: 12, lead_time_days: 7, open_orders: 0 };
const LOTS = { 'lot-small': 10, 'lot-medium': 50, 'lot-large': 200 };
const CHOICE = { lot: 'lot-medium', quantity: 50, needed_by: '2026-12-01' };

/** A clock that the sleep of a hire moves, over the clock of the stub marketplace. */
const clockOf = (m: Marketplace): Clock => ({ now: () => m.clock.now, sleep: async (ms) => { m.clock.now += ms; } });

interface Setup {
  readonly m: Marketplace;
  readonly dir: string;
  readonly config: ServiceConfig;
  readonly wired: Wired;
  readonly log: string[];
  readonly chains: Map<string, VaultChain>;
}

/** The chain of each key: the FakeChain of the stub marketplace, with the wallet of the key. A chain is made once for each key, and the test reads the map. */
async function setup(over: { env?: NodeJS.ProcessEnv; options?: Partial<WiringOptions>; provider?: Module1Provider } = {}): Promise<Setup> {
  const m = marketplace();
  const dir = tempDir();
  const config = loadConfig(completeEnv({ REORDER_STATE_DIR: dir, VECTOR_MARKETPLACE_INDEXER_URL: INDEXER, ...over.env }));
  const log: string[] = [];
  const chains = new Map<string, VaultChain>();
  const wired = await wire({ ...config, modelLimits: LIMITS }, {
    fetchImpl: m.fetchImpl, clock: clockOf(m), log: (line) => { log.push(line); }, provider: over.provider ?? world([liveDelegation(DELEG_A.keyHash)]), tipSlot: async () => 0,
    createChain: async (options) => {
      const pkh = keyOf(options.privateKeyHex).pkh;
      const chain = vaultChainWith(m, { wallet: async () => ({ ...(await m.chain.wallet()), buyerPkh: pkh }) });
      chains.set(pkh, chain);
      return chain;
    },
    ...over.options,
  });
  return { m, dir, config, wired, log, chains };
}

describe('one queue for each key, one set of ids, one counter and one list for the process', () => {
  test('the lane of each delegation key is the queue of its sub-delegation, of its hires and of the janitor, and the service key is none of them', async () => {
    const { wired, config } = await setup();
    const [first, second] = wired.delegations;
    expect(first.keyHash).toBe(config.keys.delegation1.pkh);
    expect(second.keyHash).toBe(config.keys.delegation2.pkh);
    expect(wired.service.keyHash).toBe(config.keys.service.pkh);
    const propose = wired.proposeDeps(T0);
    const execute = wired.executeDeps(T0);
    const janitor = wired.janitorDeps(100);
    for (const [paying, material] of [[first, config.keys.delegation1], [second, config.keys.delegation2]] as const) {
      expect(propose.delegationKeys.find(paying.keyHash)?.queue).toBe(paying.lane);
      expect(execute.delegationKeys.find(paying.keyHash)?.key).toBe(paying);
      expect(execute.delegationKeys.find(paying.keyHash)?.key.lane).toBe(paying.lane);
      expect(janitor.queueOf(paying.keyHash)).toBe(paying.lane);
      expect(janitor.signerOf(paying.keyHash)?.keyHash).toBe(material.pkh);
      expect(propose.delegationKeys.find(paying.keyHash)?.walletAddress).toBe(material.address);
      expect(propose.delegationKeys.find(paying.keyHash)?.signer.keyHash).toBe(material.pkh);
    }
    expect(execute.delegationKeys.first.key).toBe(first);
    expect(first.lane).not.toBe(second.lane);
    expect(first.lane).not.toBe(wired.service.lane);
    // The service key signs no sub-delegation and pays no vault Pay, and the janitor ends no delegation with it.
    for (const pkh of [wired.service.keyHash, config.keys.stockReaderDelegation.pkh, 'ee'.repeat(28)]) {
      expect(propose.delegationKeys.find(pkh)).toBeNull();
      expect(execute.delegationKeys.find(pkh)).toBeNull();
      expect(janitor.signerOf(pkh)).toBeNull();
      expect(() => janitor.queueOf(pkh)).toThrow(/does not hold/);
    }
  });

  test('a run of propose and the janitor share one set of delegation ids, and the set is the one the wiring exposes', async () => {
    const { wired } = await setup();
    const id = 'dd'.repeat(32);
    const janitor = wired.janitorDeps(100);
    expect(janitor.inFlight(id)).toBe(false);
    wired.proposeDeps(T0).inFlight.add(id);
    expect(janitor.inFlight(id)).toBe(true);
    expect(wired.inFlight.has(id)).toBe(true);
    // Another job gets the same set: an id that one run added is seen by the deps of the next.
    wired.proposeDeps(T0 + 1).inFlight.delete(id);
    expect(janitor.inFlight(id)).toBe(false);
    expect(wired.inFlight.has(id)).toBe(false);
  });

  test('the counter and the list of left sub-delegations are single objects: every job and the janitor get the same ones', async () => {
    const { wired, dir } = await setup();
    expect(wired.proposeDeps(T0).counter).toBe(wired.counter);
    expect(wired.proposeDeps(T0 + 5).counter).toBe(wired.counter);
    expect(wired.proposeDeps(T0).leftSink).toBe(wired.leftStore);
    expect(wired.janitorDeps(100).store).toBe(wired.leftStore);
    expect(existsSync(join(dir, STATE_FILES.counter))).toBe(false);
    // Two numbers from the one counter are two numbers: two counters on one file would give the same number twice.
    expect([await wired.proposeDeps(T0).counter.next('run1'), await wired.proposeDeps(T0 + 1).counter.next('run1')]).toStrictEqual([1, 2]);
    expect(JSON.parse(readFileSync(join(dir, STATE_FILES.counter), 'utf8'))).toStrictEqual({ run1: 2 });
    expect(await wired.leftStore.list()).toStrictEqual([]);
  });

  test('the state directory holds the stranded store of each of the three paying keys, and the journal of the dispute code', async () => {
    const { dir, config, wired } = await setup();
    const keys = readdirSync(join(dir, 'keys')).sort();
    expect(keys).toStrictEqual([config.keys.service.pkh, config.keys.delegation1.pkh, config.keys.delegation2.pkh].sort());
    expect(existsSync(join(dir, STATE_FILES.dispute))).toBe(true);
    expect(wired.service.dir).toBe(join(dir, 'keys', config.keys.service.pkh));
  });
});

describe('the keys that the chains are made from', () => {
  test('each paying key gets the chain that its own key makes, with the identity deployment that pays from a vault', async () => {
    const seen: { pkh: string; identity: unknown; ogmios: string | undefined }[] = [];
    const { config, wired } = await setup({
      options: {
        createChain: async (options) => {
          seen.push({ pkh: keyOf(options.privateKeyHex).pkh, identity: options.identityDeployment, ogmios: options.ogmiosUrl });
          const m = marketplace();
          return vaultChainWith(m, { wallet: async () => ({ ...(await m.chain.wallet()), buyerPkh: keyOf(options.privateKeyHex).pkh }) });
        },
      },
    });
    expect(seen.map((entry) => entry.pkh)).toStrictEqual([config.keys.service.pkh, config.keys.delegation1.pkh, config.keys.delegation2.pkh]);
    expect(seen.every((entry) => entry.identity === config.identityDeployment)).toBe(true);
    expect(seen.every((entry) => entry.ogmios === config.endpoints.ogmiosUrl)).toBe(true);
    expect(wired.delegations).toHaveLength(2);
  });

  test('a chain that gives another key hash than its key stops the start, and the right chain is its twin', async () => {
    const wrong = await setup({ options: { createChain: async () => { const m = marketplace(); return vaultChainWith(m, { wallet: async () => ({ ...(await m.chain.wallet()), buyerPkh: 'ee'.repeat(28) }) }); } } }).catch((error: unknown) => error);
    expect(wrong).toBeInstanceOf(Error);
    expect((wrong as Error).message).toMatch(/^the chain of the service key does not belong to that key/);
    await expect(setup()).resolves.toBeDefined();
  });

  test('the key leaves its object through withKey only: no log line of a start and of a decision holds a key, a token or a bech32 key', async () => {
    const run = await setup();
    run.m.llm.answer = said(CHOICE);
    await run.wired.proposeDeps(T0).reorder(READING, LOTS);
    expect(run.log.length).toBeGreaterThan(0);
    for (const secret of secretsOf(completeEnv({ REORDER_STATE_DIR: run.dir }))) {
      for (const line of run.log) expect(line.toLowerCase()).not.toContain(secret.toLowerCase());
    }
    for (const role of ROLES) expect(JSON.stringify(run.config.keys[role]).toLowerCase()).not.toContain(rawKey(KEY_NUMBERS[role]));
    expect(ROLES.map((role) => KEY_VARIABLES[role])).toHaveLength(5);
  });
});

describe('the decision `reorder` of a job of propose', () => {
  test('hires a model from the service key, asks it for the lot with the stock reading, the sizes and the date of today, and gives the choice built from the choice that the decision records', async () => {
    const run = await setup();
    run.m.llm.answer = said(CHOICE, 'The stock lasts five days and the lead time is seven.');
    const answer = await run.wired.proposeDeps(T0).reorder(READING, LOTS);
    if (!answer.ok) throw new Error(`the decision failed with ${answer.code}`);
    expect(answer.choice).toStrictEqual(CHOICE);
    expect(answer.choice).toStrictEqual(answer.decision.choice);
    expect(answer.decision).toMatchObject({ name: 'reorder', choice: CHOICE, reasoning: 'The stock lasts five days and the lead time is seven.' });
    expect(answer.decision.inference.path).toBe('marketplace');
    expect(run.m.llm.sends).toHaveLength(1);
    const prompt = run.m.llm.sends[0].body;
    expect(prompt).toContain(todayOf(T0));
    expect(prompt).toContain('GLV-NIT-M');
    expect(run.log.filter((line) => line.startsWith('booked a Post'))).toHaveLength(1);
    expect(run.log.filter((line) => line.startsWith('booked an Accept'))).toHaveLength(1);
  });

  test('the book of the hire logs the lock, the fee and the transaction hash and nothing else', async () => {
    const run = await setup();
    run.m.llm.answer = said(CHOICE);
    await run.wired.proposeDeps(T0).reorder(READING, LOTS);
    const booked = run.log.filter((line) => line.startsWith('booked '));
    expect(booked[0]).toMatch(/^booked a Post: lock \d+ lovelace, fee \d+ lovelace$/);
    expect(booked[1]).toMatch(/^booked an Accept: fee \d+ lovelace, transaction [0-9a-f]{64}$/);
  });

  test('a decision that the model gives in a shape that the parser refuses fails with its code, and no choice is made', async () => {
    const run = await setup();
    run.m.llm.answer = said({ lot: 'lot-huge', quantity: 5, needed_by: '2026-12-01' });
    expect(await run.wired.proposeDeps(T0).reorder(READING, LOTS)).toStrictEqual({ ok: false, code: 'model_output_invalid' });
  });

  test('the deadline of the decision is the deadline of the job that asks it: a job that arrived too long ago hires nothing, and a job that arrived now hires', async () => {
    const run = await setup();
    run.m.llm.answer = said(CHOICE);
    const late = await run.wired.proposeDeps(T0 - PROPOSE_DEADLINE_MS - 1).reorder(READING, LOTS);
    expect(late).toStrictEqual({ ok: false, code: 'llm_out_of_time' });
    expect(run.m.llm.sends).toHaveLength(0);
    expect((await run.wired.proposeDeps(T0).reorder(READING, LOTS)).ok).toBe(true);
    expect(run.m.llm.sends).toHaveLength(1);
  });

  test('a stock reading that is not a reading is refused before any hire', async () => {
    const run = await setup();
    run.m.llm.answer = said(CHOICE);
    expect(await run.wired.proposeDeps(T0).reorder({ sku: 'GLV-NIT-M' }, LOTS)).toStrictEqual({ ok: false, code: 'stock_reading_invalid' });
    expect(run.m.llm.sends).toHaveLength(0);
  });

  test('the date of today is the UTC date of the clock', () => {
    expect(todayOf(Date.UTC(2026, 10, 23, 23, 59, 59))).toBe('2026-11-23');
    expect(todayOf(Date.UTC(2026, 10, 24, 0, 0, 0))).toBe('2026-11-24');
    expect(todayOf(T0)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('the decision `accept_delivery` of a job of execute', () => {
  const ORDER = must(parsePurchaseOrder(golden('po.json')));
  const CONFIRMATION = must(parseOrderConfirmation(golden('confirmation.json')));

  test('hires a model from the service key and gives the choice as the decision records it, for an acceptance and for a no', async () => {
    const run = await setup();
    run.m.llm.answer = said({ accept: true, mismatch: [] });
    const accepted = await run.wired.executeDeps(T0).acceptDelivery(ORDER, CONFIRMATION);
    if (!accepted.ok) throw new Error(`the decision failed with ${accepted.code}`);
    expect(accepted.choice).toStrictEqual({ accept: true, mismatch: [] });
    expect(accepted.decision).toMatchObject({ name: 'accept_delivery', choice: { accept: true, mismatch: [] } });
    run.m.llm.answer = said({ accept: false, mismatch: ['lot', 'quantity'] });
    const declined = await run.wired.executeDeps(T0).acceptDelivery(ORDER, CONFIRMATION);
    if (!declined.ok) throw new Error(`the decision failed with ${declined.code}`);
    expect(declined.choice).toStrictEqual({ accept: false, mismatch: ['lot', 'quantity'] });
    expect(declined.decision.choice).toStrictEqual({ accept: false, mismatch: ['lot', 'quantity'] });
    expect(run.m.llm.sends).toHaveLength(2);
  });

  test('a failed decision gives the reason of the failure as its code, and a job that arrived too long ago hires nothing', async () => {
    const run = await setup();
    run.m.llm.answer = 'this is not a decision';
    expect(await run.wired.executeDeps(T0).acceptDelivery(ORDER, CONFIRMATION)).toStrictEqual({ ok: false, code: 'model_output_invalid' });
    const before = run.m.llm.sends.length;
    expect(await run.wired.executeDeps(T0 - 1_620_001).acceptDelivery(ORDER, CONFIRMATION)).toStrictEqual({ ok: false, code: 'llm_out_of_time' });
    expect(run.m.llm.sends).toHaveLength(before);
  });

  test('the hire of the Order Desk gets the three limits of the handoff, the delegation keys as the buyer keys, and the service key as the authentication key of the agent', async () => {
    const { wired, config } = await setup();
    const deps = wired.executeDeps(T0);
    expect(deps.limits).toStrictEqual({ maxPriceLovelace: 10_000_000n, maxSupplierBondLovelace: 2_000_000n, maxBuyerBondLovelace: 2_000_000n });
    expect(deps.buyerPkhs).toStrictEqual([config.keys.delegation1.pkh, config.keys.delegation2.pkh]);
    expect(deps.agent).toStrictEqual({ did: config.agentDid, authenticationKey: config.keys.service.keyObject });
    expect(deps.dispute).toBe(wired.dispute);
    const subagent = wired.proposeDeps(T0).subagent;
    expect(subagent.did).toBe(config.stockReaderDid);
    expect(subagent.authenticationKey).toBe(config.keys.stockReaderAuthentication.keyObject);
    expect(subagent.delegationKey).toBe(config.keys.stockReaderDelegation.keyObject);
    expect(subagent.signer.keyHash).toBe(config.keys.stockReaderDelegation.pkh);
  });
});

describe('the reads of the ledger', () => {
  test('the key of a delegation is the delegate key of its leaf, and a delegation that the ledger does not show has none', async () => {
    const { wired } = await setup();
    const deps = wired.proposeDeps(T0);
    expect(await deps.delegateKeyOf('77'.repeat(32))).toBe(DELEG_A.keyHash);
    expect(await deps.delegateKeyOf('88'.repeat(32))).toBeNull();
    expect(await wired.executeDeps(T0).delegateKeyOf('77'.repeat(32))).toBe(DELEG_A.keyHash);
  });

  test('a ledger that cannot be read rejects: it is never "no delegation"', async () => {
    const broken = world();
    broken.getUtxos = async () => { throw new Error('the node does not answer'); };
    const { wired } = await setup({ provider: broken });
    await expect(wired.proposeDeps(T0).delegateKeyOf('77'.repeat(32))).rejects.toThrow();
    await expect(wired.proposeDeps(T0).reads.delegation('77'.repeat(32))).rejects.toThrow();
  });
});

describe('the reader of the supplier', () => {
  /** The readers under `readSupplier`, over the golden world of the model folder, with a record of what each was asked. */
  function sourcesOf(): { sources: SupplierSources; asked: { list: string[]; read: { ref: string; address: string | null; koios: string }[]; files: string[] } } {
    const golden_ = goldenWorld();
    const asked: { list: string[]; read: { ref: string; address: string | null; koios: string }[]; files: string[] } = { list: [], read: [], files: [] };
    const sources: SupplierSources = {
      fetchSuppliers: async (options) => { asked.list.push(options.capability_id); return golden_.rows; },
      readAdvert: async (ref, _fetch, koios, address) => {
        asked.read.push({ ref, address, koios });
        const reading = golden_.reads[ref];
        if (reading === undefined) throw new Error('no advert');
        return reading;
      },
      safeFetch: async (url, _init, options) => {
        asked.files.push(`${url} ${options.maxResponseBytes} ${options.timeoutMs}`);
        const file = golden_.files[url];
        if (file === undefined || file instanceof Error) throw new Error('no file');
        return { status: file.status, text: Buffer.from(file.bytes).toString('utf8') };
      },
    };
    return { sources, asked };
  }

  test('reads the golden supplier of the fixture world: the adverts of the three lots, the three sizes and the claim, and the advert address of the identity deployment goes to the chain read', async () => {
    const { sources, asked } = sourcesOf();
    const { wired, config } = await setup({ options: { sources } });
    const read = await wired.proposeDeps(T0).readSupplier(SUPPLIER_DID, SKU);
    expect(read).toStrictEqual({ ok: true, value: golden('supplier-view.json') });
    expect(asked.list).toStrictEqual([CAPABILITY]);
    expect(asked.read).toHaveLength(3);
    expect(asked.read.every((entry) => entry.address === config.identityDeployment.advert.address && entry.address === DEPLOYMENT.advert.address)).toBe(true);
    expect(asked.read.every((entry) => entry.koios === config.endpoints.koiosUrl)).toBe(true);
    // The manifest and the lots file are fetched with the limits of the reader, and the text of each becomes the bytes whose hash the reader checks.
    expect(asked.files).toStrictEqual(['https://order-desk.example/agent.json 262144 10000', 'https://order-desk.example/lots.json 262144 10000']);
    expect(SUPPLIER_AGENT_ID).toHaveLength(64);
  });

  test('an unlisted supplier is a typed failure, and a node that cannot read the adverts is its own code and never a pass', async () => {
    const { sources } = sourcesOf();
    const none: SupplierSources = { ...sources, fetchSuppliers: async () => [] };
    const { wired } = await setup({ options: { sources: none } });
    expect(await wired.proposeDeps(T0).readSupplier(SUPPLIER_DID, SKU)).toMatchObject({ ok: false, code: 'supplier_not_listed' });
    const down: SupplierSources = { ...sources, fetchSuppliers: async () => { throw new Error('the indexer is down'); } };
    const second = await setup({ options: { sources: down } });
    expect(await second.wired.proposeDeps(T0).readSupplier(SUPPLIER_DID, SKU)).toMatchObject({ ok: false, code: 'supplier_unavailable' });
  });
});

describe('the start', () => {
  test('stops when the node gives no start time of the chain, and the node that gives one is its twin', async () => {
    const none = world();
    none.getSystemStartMs = async () => { throw new Error('the node does not answer'); };
    const failed = await setup({ provider: none }).catch((error: unknown) => error);
    expect((failed as Error).message).toMatch(/^the node gave no start time of the chain/);
    for (const bad of [Number.NaN, 0, -5, 1.5]) {
      const odd = world();
      odd.getSystemStartMs = async () => bad;
      const refused = await setup({ provider: odd }).catch((error: unknown) => error);
      expect((refused as Error).message).toMatch(/^the node gave a start time of the chain that is not a time/);
    }
    const { wired } = await setup();
    expect(wired.systemStartMs).toBe(SYSTEM_START_MS);
  });

  test('stops when the Module-1 manifest cannot be read, naming the variable, and the manifest of the fixture is its twin', async () => {
    const failed = await setup({ env: { VECTOR_MODULE1_MANIFEST: '/nonexistent/module1.json' } }).catch((error: unknown) => error);
    expect((failed as Error).message).toMatch(/VECTOR_MODULE1_MANIFEST/);
    await expect(setup()).resolves.toBeDefined();
  });

  test('the co-sign route is made over the two delegation keys, and a setting that the kit refuses stops the start with its detail', async () => {
    const { wired, config } = await setup();
    const route = wired.cosignRoute(config.cosign);
    expect(route.path).toBe('/cosign/delegate');
    const refused = messageOf(() => wired.cosignRoute({ ...config.cosign, maxConcurrent: 0 }));
    expect(refused).toMatch(/^the co-sign route is refused: /);
    expect(refused).toContain('COSIGN_MAX_CONCURRENT');
    expect(cosignSettingsOf(completeEnv()).maxConcurrent).toBe(4);
  });

  test('the janitors start and stop, each with its own bound, and the line of an abandoned job names the escrows that the state directory holds', async () => {
    const { wired } = await setup();
    expect(wired.abandonedLine(300_000)).toBe('stopping: the job that is running did not finish within 300000 ms and is abandoned; the state directory holds 0 escrows for the janitors of the next start');
    wired.delegations[0].stranded.add({ escrow_ref: `${'ab'.repeat(32)}#0`, deliver_by: T0 + 1_000_000, posted_at: T0, kind: 'agent' });
    expect(wired.abandonedLine(1)).toContain('holds 1 escrow for the janitors of the next start: ' + `${'ab'.repeat(32)}#0`);
    const running = wired.startJanitors(60_000, 100);
    await running.stop();
    await running.stop();
  });
});
