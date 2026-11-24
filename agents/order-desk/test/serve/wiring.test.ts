// agents/order-desk/test/serve/wiring.test.ts
// The real ports of the Order Desk, made from the configuration: the state files, the one paying key and its one queue, the two gateway clients (the short budget of the hook, and the default time of the SVID), the
// ledger reads of the hook that end inside the budget whatever the environment of the ledger says, the real model decision over the stub marketplace, the job deadline of 300 s, the Module-1 port over the manifest of
// the deployment, and the log lines that name codes and kinds and never a message. No test here uses the network.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';
import { FakeChain, rawHexToBech32 } from '@vsa/buyer-core';
import { LLM_ADVERT } from '@vsa/hire-kit/testing';
import { fetchX509Svid } from '@vsa/usecase-kit/access';
import { HIRE_MIN_MS } from '@vsa/usecase-kit/decision';
import { JOB_DEADLINE_MS } from '../../src/serve/settings.ts';
import { loadConfig } from '../../src/serve/start.ts';
import { wireService } from '../../src/serve/wiring.ts';
import { until } from './serve.ts';
import { DESK_DID, T, makeWorld, proposalOf } from './world.ts';
import type { World } from './world.ts';
import { MODULE1_URL, SERVICE, cleanDirs, envWith, message, module1ManifestText, shows, withModule1 } from './support.ts';
import type { Module1Answer } from './support.ts';

afterEach(() => { cleanDirs(); });

const OTHER_DIGEST = proposalOf({ quantity: 3 }).proposal_digest;
/** The input of the decision, as the job gives it: the purchase order and the entry of the catalogue. Only its form matters here. */
const INPUT = { purchase_order: { sku: 'GLV-NIT-M', lot: 'lot-medium', quantity: 50 }, catalogue_entry: { sku: 'GLV-NIT-M', available: 5000, discontinued: false, ship_lead_days: 3 } };

async function wired(world: World, over: Readonly<Record<string, string | undefined>> = {}) {
  const config = loadConfig({ ...world.env, ...over });
  return { config, ...(await wireService(config, world.options)) };
}

/** A wait of `ms` that a signal ends: a gateway that answers late. The tests of the two clients need real time, because the client bounds a call with a timer of its own. */
const lateGateway = (world: World, ms: number): typeof fetch => async (input, init) => {
  const signal = init?.signal;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('aborted')); }, { once: true });
  });
  return world.options.fetchImpl!(input, init);
};

describe('wireService makes the real parts from the configuration', () => {
  test('the state files of the service are on its volume: the order book, and the folder of the paying key, which is the service key', async () => {
    const world = makeWorld();
    const { key } = await wired(world);
    expect(existsSync(join(world.stateDir, 'orders.json'))).toBe(true);
    expect(existsSync(join(world.stateDir, 'keys', SERVICE.pkh))).toBe(true);
    expect(key.keyHash).toBe(SERVICE.pkh);
    expect(key.chain).toBe(world.m.chain);
  });

  test('the wiring reads no node and no gateway: a chain whose wallet cannot be read does not stop it', async () => {
    const world = makeWorld();
    const config = loadConfig(world.env);
    const chain = new FakeChain({ buyerPkh: SERVICE.pkh });
    chain.wallet = () => Promise.reject(new Error('the node does not answer'));
    const made = await wireService(config, { ...world.options, createChain: async () => chain, fetchImpl: () => Promise.reject(new Error('no network')) });
    expect(made.key.chain).toBe(chain);
  });

  test('the paying key comes from the registry of the kit, named by the hash that the service key derives, in the folder of that hash; the wiring does not call the internal constructor of PayingKey', async () => {
    const world = makeWorld();
    const { key } = await wired(world);
    expect([key.keyHash, key.dir]).toStrictEqual([SERVICE.pkh, join(world.stateDir, 'keys', SERVICE.pkh)]);
    const source = readFileSync(fileURLToPath(new URL('../../src/serve/wiring.ts', import.meta.url)), 'utf8');
    expect(/new PayingKeys\(/.test(source), 'the wiring makes a registry of paying keys').toBe(true);
    expect(/new PayingKey\b/.test(source), 'the wiring calls the internal constructor of PayingKey').toBe(false);
  });

  test('the job gets the service as its agent, the origins of the mock service, the call limit of 20 s, the fault switch and the lots file of the configuration', async () => {
    const world = makeWorld({ fault: 'confirm_wrong_lot' });
    const { config, jobDeps } = await wired(world);
    const deps = jobDeps(T);
    expect(deps.agent.did).toBe(DESK_DID);
    expect(deps.calls.bases).toStrictEqual(config.mock);
    expect(deps.calls.timeoutMs).toBe(20_000);
    expect(deps.fault).toBe(config.fault);
    expect(deps.fault.mode).toBe('confirm_wrong_lot');
    expect(deps.lots).toStrictEqual(config.lots.file);
    expect(deps.clock()).toBe(world.m.clock.now);
    // The record of the hook is the store of the job: a record that is put is taken once, by the escrow of its job.
    expect(deps.takeChecks(world.context.escrowRef)).toBeNull();
  });
});

describe('the one paying key has one queue', () => {
  test('a model hire runs in the queue of the service key', async () => {
    const world = makeWorld();
    const { key, jobDeps } = await wired(world);
    const hold = world.holdModel();
    expect(key.lane.busy).toBe(false);
    const hire = jobDeps(T).decide(INPUT);
    await hold.reached;
    expect(key.lane.busy).toBe(true);
    hold.release();
    const result = await hire;
    expect(result.ok).toBe(true);
    expect(key.lane.busy).toBe(false);
  });

  test('the challenge of the dispute code runs in the same queue, so a challenge and a hire never build from the one wallet together', async () => {
    const world = makeWorld({ attestation: { digest: OTHER_DIGEST } });
    world.armChallenge();
    const release = world.port.holdPublish();
    const { key, precheck } = await wired(world);
    const answer = await precheck(world.handoff, world.context);
    expect(answer).toMatchObject({ go: false, status: 403, error: 'approval_digest_mismatch' });
    await until(() => world.port.events.some((event) => event.startsWith('publish')), 'the challenge has begun to publish its evidence');
    expect(key.lane.busy).toBe(true);
    release();
    await until(() => world.port.challenged.length === 1, 'the challenge is filed');
    await until(() => !key.lane.busy, 'the queue is free');
  });
});

describe('the model decision', () => {
  test('is the real decision of the kit over the stub marketplace: one hire from the service key, the answer of the model as the choice, and a booking line with the fee and the hash', async () => {
    const world = makeWorld();
    const { jobDeps } = await wired(world);
    const result = await jobDeps(T).decide(INPUT);
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    expect([result.value.name, result.value.choice.confirm, result.value.choice.ship_by, result.value.inference.path]).toStrictEqual(['availability', true, '2026-11-28', 'marketplace']);
    expect(world.m.llm.sends).toHaveLength(1);
    const posted = world.logs.filter((line) => line.startsWith('model hire: posted'));
    const accepted = world.logs.filter((line) => line.startsWith('model hire: accepted'));
    expect([posted.length, accepted.length]).toStrictEqual([1, 1]);
    expect(posted[0]).toMatch(/^model hire: posted, locked \d+ lovelace, fee \d+ lovelace$/);
    expect(accepted[0]).toMatch(/^model hire: accepted in [0-9a-f]{64}, fee \d+ lovelace$/);
  });

  test('has the deadline of the job, 300 s after its arrival: with less than a minute left it hires nothing, and with the time of a job that has just arrived it hires', async () => {
    const world = makeWorld();
    const { jobDeps } = await wired(world);
    expect(JOB_DEADLINE_MS).toBe(300_000);
    expect(HIRE_MIN_MS).toBe(60_000);
    const late = await jobDeps(T - JOB_DEADLINE_MS + HIRE_MIN_MS - 1_000).decide(INPUT);
    expect(late.ok).toBe(false);
    if (!late.ok) expect([late.code, late.reason]).toStrictEqual(['inference_failed', 'llm_out_of_time']);
    expect(world.m.llm.sends).toStrictEqual([]);
    expect((await jobDeps(T).decide(INPUT)).ok).toBe(true);
  });

  test('has the limits of the settings: a model that the allowlist does not name is never hired', async () => {
    const world = makeWorld();
    const { jobDeps } = await wired(world, { LLM_MODEL_ALLOWLIST: 'another/model-that-is-not-listed' });
    const result = await jobDeps(T).decide(INPUT);
    expect(result.ok).toBe(false);
    expect(world.m.llm.sends).toStrictEqual([]);
  });

  test('has the limits of the settings: a price ceiling or a bond limit one lovelace below the terms of the model advert hires and pays nothing, and the same limit at the terms hires', async () => {
    // The stub advert asks 200,000 lovelace for the job and a bond of 1,000,000 lovelace from each side. The world sets each limit to exactly that.
    const terms = { LLM_MAX_PRICE_LOVELACE: LLM_ADVERT.price_lovelace, LLM_MAX_SUPPLIER_BOND_LOVELACE: LLM_ADVERT.supplier_bond_lovelace, LLM_MAX_BUYER_BOND_LOVELACE: LLM_ADVERT.buyer_bond_lovelace };
    expect(Object.values(terms)).toStrictEqual([200_000n, 1_000_000n, 1_000_000n]);
    for (const [name, at] of Object.entries(terms)) {
      const below = makeWorld();
      const refused = await (await wired(below, { [name]: String(at - 1n) })).jobDeps(T).decide(INPUT);
      expect(refused.ok, `${name} one below the terms`).toBe(false);
      expect(below.m.llm.sends, `${name} one below the terms`).toStrictEqual([]);
      expect(below.logs.filter((line) => line.startsWith('model hire: posted')), `${name} one below the terms`).toStrictEqual([]);
      const twin = makeWorld();
      const taken = await (await wired(twin, { [name]: String(at) })).jobDeps(T).decide(INPUT);
      expect(taken.ok, `${name} at the terms: ${JSON.stringify(taken)}`).toBe(true);
      expect(twin.m.llm.sends, `${name} at the terms`).toHaveLength(1);
    }
  });
});

describe('the time of the hook', () => {
  test('the gateway client of the hook has the budget of the hook: a gateway that answers in 700 ms is no answer with a budget of 500 ms', async () => {
    const world = makeWorld();
    const config = loadConfig({ ...world.env, CHECKS_READ_BUDGET_MS: '500' });
    const { precheck } = await wireService(config, { ...world.options, fetchImpl: lateGateway(world, 700) });
    const answer = await precheck(world.handoff, world.context);
    expect(answer).toMatchObject({ go: false, status: 503, error: 'check_unavailable' });
    expect(world.logs.some((line) => line.startsWith('the hook could not read the identity gateway'))).toBe(true);
  });

  test('the gateway client of the job has the default time of 10 s: the same late gateway gives the job its X.509-SVID', async () => {
    const world = makeWorld();
    const config = loadConfig({ ...world.env, CHECKS_READ_BUDGET_MS: '500' });
    const { jobDeps } = await wireService(config, { ...world.options, fetchImpl: lateGateway(world, 700) });
    const deps = jobDeps(T);
    const svid = await fetchX509Svid(deps.svid, { did: deps.agent.did, key: deps.agent.authenticationKey });
    expect(svid.ok, JSON.stringify(svid)).toBe(true);
  });

  test('a ledger that does not answer ends each read of the hook inside the budget of the hook, whatever budget the environment of the ledger carries', async () => {
    const world = makeWorld();
    const hangs = (): Promise<never> => new Promise<never>(() => undefined);
    const provider = new Proxy({}, { get: () => hangs }) as typeof world.ledger.env.provider;
    const ledgerEnv = { ...world.ledger.env, provider, fetchImpl: hangs as unknown as typeof fetch, budgetMs: 600_000 };
    const config = loadConfig({ ...world.env, CHECKS_READ_BUDGET_MS: '500' });
    const { precheck } = await wireService(config, { ...world.options, ledgerEnv });
    const answer = await precheck(world.handoff, world.context);
    expect(answer).toMatchObject({ go: false, status: 503, error: 'check_unavailable' });
  });

  test('the cause of a read that failed goes to the log by its kind only: a message that holds an address and a key is never written', async () => {
    const world = makeWorld();
    const cause = new TypeError('fetch failed: https://gateway.example.test/x?key=secret-token-123');
    const failing: typeof fetch = async () => { throw cause; };
    const config = loadConfig(world.env);
    const { precheck } = await wireService(config, { ...world.options, fetchImpl: failing });
    expect(await precheck(world.handoff, world.context)).toMatchObject({ go: false, status: 503 });
    const lines = world.logs.filter((line) => line.startsWith('the hook could not read'));
    expect(lines.length).toBeGreaterThan(0);
    for (const line of world.logs) expect(line).not.toContain('secret-token');
    expect(lines[0]).toMatch(/^the hook could not read the identity gateway \(\w+\)$/);
  });
});

describe('the Module-1 port and the dispute settings', () => {
  /** Wires the service with no port given, so that the real port is made over the manifest that the host of `answer` gives. */
  const real = (world: World, answer: Module1Answer = module1ManifestText(), over: Readonly<Record<string, string | undefined>> = {}) =>
    wireService(loadConfig({ ...world.env, ...over }), { ...world.options, fetchImpl: withModule1(world.options.fetchImpl!, answer), module1Port: undefined });

  test('with no port given, the service fetches the manifest of the deployment one time, from the address that the setting names, and makes the real port: no other call is made', async () => {
    const world = makeWorld();
    const urls: string[] = [];
    const recording: typeof fetch = (input, init) => {
      urls.push(new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url).href);
      return world.options.fetchImpl!(input, init);
    };
    const result = await wireService(loadConfig(world.env), { ...world.options, fetchImpl: recording, module1Port: undefined });
    expect(typeof result.precheck).toBe('function');
    expect(urls).toStrictEqual([MODULE1_URL]);
  });

  test('a manifest that names another identity registry than the deployment of the service is refused, naming both registries', async () => {
    const world = makeWorld();
    const text = await real(world, module1ManifestText('ab'.repeat(28))).then(() => 'accepted', (error: Error) => error.message);
    expect(text).toMatch(/^the Module-1 manifest names the identity registry (ab){28}, but the identity deployment of this service is [0-9a-f]{56}/);
  });

  test('a manifest that cannot be fetched stops the start, naming the address and the setting', async () => {
    const world = makeWorld();
    const text = await real(world, { status: 404 }).then(() => 'accepted', (error: Error) => error.message);
    expect(text).toBe(`The Module-1 manifest (VECTOR_MODULE1_MANIFEST) ${MODULE1_URL} cannot be fetched: the host answered HTTP 404.`);
  });

  test('a resolution deadline that is not the deadline of the deployment is refused, and the deadline of the deployment is taken', async () => {
    const world = makeWorld();
    const text = await real(world, undefined, { DISPUTE_RESOLUTION_DEADLINE_MS: '30000000' }).then(() => 'accepted', (error: Error) => error.message);
    expect(text).toMatch(/^the dispute settings are refused: .*30000000 ms.*259200000 ms/);
    await expect(real(world, undefined, { DISPUTE_RESOLUTION_DEADLINE_MS: '259200000' })).resolves.toBeDefined();
  });

  test('a message of the wiring shows no key', async () => {
    const world = makeWorld();
    const text = await real(world, { status: 404 }).then(() => 'accepted', (error: Error) => error.message);
    expect(shows(text, SERVICE.privateKeyHex)).toBe(false);
    expect(text.toLowerCase()).not.toContain(rawHexToBech32(SERVICE.privateKeyHex));
    expect(message(() => loadConfig(envWith({ ORDER_DESK_SERVICE_PRIV_KEY_HEX: undefined })))).not.toContain(SERVICE.privateKeyHex);
  });
});
