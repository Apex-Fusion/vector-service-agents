// agents/bid-desk/test/serve/wiring.test.ts
// The real ports of the Bid Desk, made from the configuration: the state files, the one paying key and its one queue, the two gateway clients (the short budget of the hook, and the time of the credential read),
// the ledger reads of the hook that end inside the budget whatever the environment of the ledger says, the real model decision over the stub marketplace, the job deadline of 300 s, and the log lines that name
// codes and kinds and never a message. No test here uses the network.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { FakeChain } from '@vsa/buyer-core';
import { parseRfqDocument } from '@vsa/usecase-kit/bids';
import { HIRE_MIN_MS } from '@vsa/usecase-kit/decision';
import type { JsonValue } from '@vsa/usecase-kit/protocol';
import { HOOK_READS } from '../../src/checks/index.ts';
import { quoteInput } from '../../src/job/index.ts';
import { CALL_TIMEOUT_MS, HOOK_READS as HOOK_READS_OF_THE_SETTINGS, JOB_DEADLINE_MS } from '../../src/serve/settings.ts';
import { wireService } from '../../src/serve/wiring.ts';
import { until } from './serve.ts';
import { SERVICE, ORGANISATION } from './support.ts';
import { DESK_DID, RFQ_VALUE, T, cleanDirs, configOf, makeWorld } from './world.ts';
import type { World } from './world.ts';

afterEach(() => {
  vi.restoreAllMocks();
  cleanDirs();
});

/** The input of the decision, as the job gives it: the request, the entries of the list for its SKUs and the date of today. */
function inputOf(world: World): JsonValue {
  const rfq = parseRfqDocument(RFQ_VALUE);
  if (!rfq.ok) throw new Error(rfq.detail);
  return quoteInput(rfq.value, world.config.priceList.list, '2026-11-24');
}

async function wired(world: World, over: Readonly<Record<string, string | undefined>> = {}) {
  const config = configOf({ ...world.env, ...over });
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
  test('the state files of the service are on its volume: the rfq book, and the folder of the one paying key, which is the service key', async () => {
    const world = makeWorld();
    const { key } = await wired(world);
    expect(existsSync(join(world.stateDir, 'rfq-book.json'))).toBe(true);
    expect(readdirSync(join(world.stateDir, 'keys'))).toStrictEqual([SERVICE.pkh]);
    expect(key.keyHash).toBe(SERVICE.pkh);
    expect(key.chain).toBe(world.m.chain);
  });

  test('the wiring reads no node and no gateway: a chain whose wallet cannot be read does not stop it', async () => {
    const world = makeWorld();
    const chain = new FakeChain({ buyerPkh: SERVICE.pkh });
    chain.wallet = () => Promise.reject(new Error('the node does not answer'));
    const made = await wireService(world.config, { ...world.options, createChain: async () => chain, fetchImpl: () => Promise.reject(new Error('no network')) });
    expect(made.key.chain).toBe(chain);
  });

  test('the wiring gives the hook, the job and the key and nothing else: the Bid Desk has no Module-1 port, no dispute code and no sub-delegation', async () => {
    const world = makeWorld();
    const made = await wireService(world.config, world.options);
    expect(Object.keys(made).sort()).toStrictEqual(['jobDeps', 'key', 'precheck']);
    expect(typeof made.precheck).toBe('function');
  });

  test('the paying key comes from the registry of the kit, named by the hash that the service key derives, in the folder of that hash; one book object serves the hook and the jobs', async () => {
    const world = makeWorld();
    const { key } = await wired(world);
    expect([key.keyHash, key.dir]).toStrictEqual([SERVICE.pkh, join(world.stateDir, 'keys', SERVICE.pkh)]);
    const source = readFileSync(fileURLToPath(new URL('../../src/serve/wiring.ts', import.meta.url)), 'utf8');
    expect(/new PayingKeys\(/.test(source), 'the wiring makes a registry of paying keys').toBe(true);
    expect(/new PayingKey\b/.test(source), 'the wiring calls the internal constructor of PayingKey').toBe(false);
    expect(source.match(/new FileRfqBook\(/g), 'the wiring makes one book object').toHaveLength(1);
  });

  test('the job gets the desk as its agent, the price list of the instance, the fault switch and the clock of the configuration, and the record of the hook is its store', async () => {
    const world = makeWorld({ instance: 'bravo', fault: 'quote_off_price_list' });
    const { config, jobDeps } = await wired(world);
    const deps = jobDeps(T);
    expect(deps.agent).toStrictEqual({ did: DESK_DID, organisation: 'bravo.example.test' });
    expect(deps.priceList).toStrictEqual({ list: config.priceList.list, sha256: config.priceList.sha256 });
    expect(deps.fault).toBe(config.fault);
    expect(deps.fault.mode).toBe('quote_off_price_list');
    expect(deps.clock()).toBe(world.m.clock.now);
    // The record of the hook is the store of the job: a record that is put is taken once, by the escrow of its job.
    expect(deps.takeChecks(world.context.escrowRef)).toBeNull();
  });

  test('every job of the process shares the one book of the hook: a quote that one job booked is a duplicate for the hook, and for the next job', async () => {
    const world = makeWorld();
    const { precheck, jobDeps } = await wired(world);
    const first = jobDeps(T);
    const second = jobDeps(T);
    expect(second.book).toBe(first.book);
    expect(await precheck(world.message, world.context)).toStrictEqual({ go: true });
    await first.book.record(world.sender.did, 'run1-rfq-1', 'ab'.repeat(32));
    expect(await second.book.has(world.sender.did, 'run1-rfq-1')).toBe(true);
    expect(await precheck(world.message, world.context)).toMatchObject({ go: false, status: 403, error: 'duplicate_rfq' });
  });
});

describe('the one paying key has one queue', () => {
  test('a model hire runs in the queue of the service key, which is free again after the hire', async () => {
    const world = makeWorld();
    const { key, jobDeps } = await wired(world);
    const hold = world.holdModel();
    expect(key.lane.busy).toBe(false);
    const hire = jobDeps(T).decide(inputOf(world));
    await hold.reached;
    expect(key.lane.busy).toBe(true);
    hold.release();
    const result = await hire;
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(key.lane.busy).toBe(false);
  });

  test('each decision takes one turn in that queue, and a second decision waits behind the first: the lane of the key is the one lane of the service', async () => {
    const world = makeWorld();
    const { key, jobDeps } = await wired(world);
    const turns = vi.spyOn(key.lane, 'run');
    expect((await jobDeps(T).decide(inputOf(world))).ok).toBe(true);
    expect(turns).toHaveBeenCalledTimes(1);
    const hold = world.holdModel();
    const first = jobDeps(T).decide(inputOf(world));
    await hold.reached;
    const second = jobDeps(T).decide(inputOf(world));
    // The second decision asks for its turn, and it has not reached the model supplier: the first hire holds the lane until it ends.
    await until(() => turns.mock.calls.length === 3, 'the second decision has asked for its turn');
    expect(world.m.llm.sends).toHaveLength(1);
    hold.release();
    expect([(await first).ok, (await second).ok]).toStrictEqual([true, true]);
    expect(world.m.llm.sends).toHaveLength(3);
    expect(key.lane.busy).toBe(false);
  });
});

describe('the model decision', () => {
  test('is the real decision of the kit over the stub marketplace: one hire from the service key, the answer of the model as the choice, and a booking line with the fee and the hash', async () => {
    const world = makeWorld();
    const { jobDeps } = await wired(world);
    const result = await jobDeps(T).decide(inputOf(world));
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    expect([result.value.name, result.value.choice.lines.length, result.value.choice.valid_until, result.value.inference.path]).toStrictEqual(['quote', 3, '2027-06-30', 'marketplace']);
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
    const late = await jobDeps(T - JOB_DEADLINE_MS + HIRE_MIN_MS - 1_000).decide(inputOf(world));
    expect(late.ok).toBe(false);
    if (!late.ok) expect([late.code, late.reason]).toStrictEqual(['inference_failed', 'llm_out_of_time']);
    expect(world.m.llm.sends).toStrictEqual([]);
    expect((await jobDeps(T).decide(inputOf(world))).ok).toBe(true);
  });

  test('has the limits of the settings: a model that the allowlist does not name is never hired', async () => {
    const world = makeWorld();
    const { jobDeps } = await wired(world, { LLM_MODEL_ALLOWLIST: 'another/model-that-is-not-listed' });
    const result = await jobDeps(T).decide(inputOf(world));
    expect(result.ok).toBe(false);
    expect(world.m.llm.sends).toStrictEqual([]);
  });
});

describe('the time of the hook', () => {
  test('the hook makes the timed reads that the settings count: the one number of the hook and of the settings', () => {
    expect(HOOK_READS_OF_THE_SETTINGS).toBe(HOOK_READS);
    expect(HOOK_READS).toBe(4);
  });

  test('the gateway client of the hook has the budget of the hook: a gateway that answers in 700 ms is no answer with a budget of 500 ms', async () => {
    const world = makeWorld();
    const config = configOf({ ...world.env, CHECKS_READ_BUDGET_MS: '500' });
    const { precheck } = await wireService(config, { ...world.options, fetchImpl: lateGateway(world, 700) });
    const answer = await precheck(world.message, world.context);
    expect(answer).toMatchObject({ go: false, status: 503, error: 'check_unavailable' });
    expect(world.logs.some((line) => line.startsWith('bid desk: the identity gateway failed'))).toBe(true);
  });

  test('the gateway client of the job has the time of the credential read, and the same late gateway gives the job its credential', async () => {
    const world = makeWorld();
    const config = configOf({ ...world.env, CHECKS_READ_BUDGET_MS: '500' });
    const { jobDeps } = await wireService(config, { ...world.options, fetchImpl: lateGateway(world, 700) });
    const issued = await jobDeps(T).credential(DESK_DID);
    expect(issued.ok, JSON.stringify(issued)).toBe(true);
  });

  test('the timeout of the client of the job is CALL_TIMEOUT_MS, and the timeout of the client of the hook is the budget of the hook', async () => {
    const world = makeWorld();
    const config = configOf({ ...world.env, CHECKS_READ_BUDGET_MS: '700' });
    const timeouts = vi.spyOn(AbortSignal, 'timeout');
    const { jobDeps, precheck } = await wireService(config, world.options);
    timeouts.mockClear();
    expect((await jobDeps(T).credential(DESK_DID)).ok).toBe(true);
    expect(CALL_TIMEOUT_MS).toBe(20_000);
    expect(timeouts.mock.calls.map(([ms]) => ms)).toStrictEqual([CALL_TIMEOUT_MS]);
    timeouts.mockClear();
    expect(await precheck(world.message, world.context)).toStrictEqual({ go: true });
    expect(timeouts.mock.calls.map(([ms]) => ms)).toContain(700);
  });

  test('a ledger that does not answer ends each read of the hook inside the budget of the hook, whatever budget the environment of the ledger carries', async () => {
    const world = makeWorld();
    const hangs = (): Promise<never> => new Promise<never>(() => undefined);
    const provider = new Proxy({}, { get: () => hangs }) as typeof world.ledger.env.provider;
    const ledgerEnv = { ...world.ledger.env, provider, fetchImpl: hangs as unknown as typeof fetch, budgetMs: 600_000 };
    const config = configOf({ ...world.env, CHECKS_READ_BUDGET_MS: '500' });
    const { precheck } = await wireService(config, { ...world.options, ledgerEnv });
    const answer = await precheck(world.message, world.context);
    expect(answer).toMatchObject({ go: false, status: 503, error: 'check_unavailable' });
  });

  test('the cause of a read that failed goes to the log by its kind only: a message that holds an address and a key is never written', async () => {
    const world = makeWorld();
    const cause = new TypeError('fetch failed: https://gateway.example.test/x?key=secret-token-123');
    const failing: typeof fetch = async () => { throw cause; };
    const { precheck } = await wireService(world.config, { ...world.options, fetchImpl: failing });
    expect(await precheck(world.message, world.context)).toMatchObject({ go: false, status: 503 });
    const lines = world.logs.filter((line) => line.startsWith('bid desk: the identity gateway failed'));
    expect(lines).toHaveLength(1);
    for (const line of world.logs) expect(line).not.toContain('secret-token');
    expect(lines[0]).toMatch(/^bid desk: the identity gateway failed \(\w+\)$/);
  });
});

describe('the organisation of the desk', () => {
  test('the job takes the organisation of the configuration, and each instance has its own', async () => {
    for (const instance of ['alfa', 'bravo', 'charlie'] as const) {
      const world = makeWorld({ instance });
      const { jobDeps } = await wired(world);
      expect(jobDeps(T).agent.organisation).toBe(`${instance}.example.test`);
    }
    expect(ORGANISATION).toBe('alfa.example.test');
  });
});
