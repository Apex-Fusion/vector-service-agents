// packages/hire-kit/test/keys.test.ts
// The paying keys of a service: the lane that gives one hire at a time, the registry that gives one chain, one stranded store and one janitor to a key and shares none of them
// with another key, and the janitor of a key, which tends only the escrows of its own store with the chain of its own key. The service key posts from its wallet; the delegate key
// pays from a vault, and the escrow that its janitor reclaims returns to that vault as a Returned output. Each refusal has its accepted twin.
import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Chain } from '@vsa/buyer-core';
import { hireAgent } from '../src/agent.ts';
import type { AgentDeps, AgentErrors, AgentRequest } from '../src/agent.ts';
import { JANITOR_GRACE_MS, STRANDED_FILE, runJanitorOnce } from '../src/janitor.ts';
import { HireLane, PayingKeys } from '../src/keys.ts';
import type { PayingKey } from '../src/keys.ts';
import { AGENT_CAPABILITY, AGENT_MODEL, INDEXER, T0, chainWith, marketplace } from '../testing/index.ts';
import type { Marketplace } from '../testing/index.ts';

const SERVICE_PKH = 'aa'.repeat(28);
const DELEGATE_PKH = 'dd'.repeat(28);
const THIRD_PKH = 'ee'.repeat(28);
const DELEGATION = 'cc'.repeat(32);
const LIMIT = { perTx: 5_000_000n, total: 12_000_000n, periodMs: 86_400_000 };
const PAYLOAD = '{"purchase_order":"PO-7"}';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hire-kit-keys-'));
  dirs.push(dir);
  return dir;
}

/** A promise that the test settles by hand. (Promise.withResolvers is not in the types of this package's target.) */
function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
/** Lets every job that waits in the microtask queue run. */
async function settle(): Promise<void> { for (let i = 0; i < 8; i += 1) await Promise.resolve(); }

class CodedError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'CodedError';
    this.code = code;
  }
}
const ERRORS: AgentErrors<CodedError> = {
  failure: (kind, what, message) => new CodedError(`${kind}_${what}`, message),
  deadline: (doing) => new CodedError('deadline', `The deadline of the job came while ${doing}.`),
  storeWrite: (message) => new CodedError('store_write_failed', message),
  unavailable: (why) => new CodedError('no_agent', `No agent to hire: ${why}.`),
};
const request = (over: Partial<AgentRequest> = {}): AgentRequest => ({ selection: { capabilityId: AGENT_CAPABILITY, model: AGENT_MODEL }, payload: PAYLOAD, label: 'the order', ...over });

/** The deps of a hire from `key` against the marketplace `m`, whose clock the hire moves on when it pauses. */
function agentDeps(key: PayingKey, m: Marketplace): AgentDeps {
  const clocked = { clock: () => m.clock.now, sleep: async (ms: number) => { m.clock.now += ms; }, deadlineMs: T0 + 1_000_000 };
  return { ...key.hireDeps(clocked), fetchImpl: m.fetchImpl, indexerUrl: INDEXER, ledger: { posted: () => undefined, accepted: () => undefined } };
}
/** Hires an agent that turns the job down, so that the escrow stays Open in the store of `key`; gives the ref of that escrow. */
async function strand(key: PayingKey, m: Marketplace, over: Partial<AgentRequest> = {}): Promise<string> {
  m.agent.refuse = { status: 403, code: 'approval_revoked' };
  const outcome = await hireAgent(agentDeps(key, m), request(over), ERRORS);
  if (outcome.outcome !== 'refused_before_claim') throw new Error(`the hire ended in ${outcome.outcome}`);
  return outcome.escrowRef;
}
const keyPair = async (keys: PayingKeys) => {
  const service = marketplace({ buyerPkh: SERVICE_PKH });
  const delegate = marketplace({ buyerPkh: DELEGATE_PKH });
  return { service, delegate, serviceKey: await keys.add(service.chain), delegateKey: await keys.add(delegate.chain) };
};

describe('HireLane', () => {
  it('runs the jobs one after the other, in the order given, and a job that fails does not stop the next', async () => {
    const lane = new HireLane();
    const order: string[] = [];
    const first = deferred<string>();
    const a = lane.run(async () => { order.push('a starts'); const value = await first.promise; order.push('a ends'); return value; });
    const b = lane.run(async () => { order.push('b starts'); throw new Error('b failed'); });
    const c = lane.run(async () => { order.push('c starts'); return 'c'; });
    await settle();
    // Only the first has started: the others wait for it.
    expect(order).toStrictEqual(['a starts']);
    expect(lane.busy).toBe(true);
    first.resolve('a');
    expect(await a).toBe('a');
    await expect(b).rejects.toThrow('b failed');
    expect(await c).toBe('c');
    expect(order).toStrictEqual(['a starts', 'a ends', 'b starts', 'c starts']);
    await settle();
    expect(lane.busy).toBe(false);
  });

  it('keeps one lane apart from another: a job on one runs while a job on the other waits for its own lane', async () => {
    const laneA = new HireLane();
    const laneB = new HireLane();
    const events: string[] = [];
    const slow = deferred();
    const a = laneA.run(async () => { events.push('a starts'); await slow.promise; events.push('a ends'); });
    const a2 = laneA.run(async () => { events.push('a2 starts'); });
    await laneB.run(async () => { events.push('b runs'); });
    // The twin of the first test: b ran while a was still open, and a2 still waits for a.
    expect(events).toStrictEqual(['a starts', 'b runs']);
    slow.resolve();
    await Promise.all([a, a2]);
    expect(events).toStrictEqual(['a starts', 'b runs', 'a ends', 'a2 starts']);
  });
});

describe('PayingKeys', () => {
  it('names a key by the hash its wallet gives, and keeps its stranded file in keys/<hash> of the state directory', async () => {
    const dir = tempDir();
    const keys = new PayingKeys(dir);
    const m = marketplace({ buyerPkh: SERVICE_PKH });
    const key = await keys.add(m.chain);
    expect([key.keyHash, key.dir, key.chain]).toStrictEqual([SERVICE_PKH, join(dir, 'keys', SERVICE_PKH), m.chain]);
    expect(existsSync(join(key.dir, STRANDED_FILE))).toBe(false);
    const ref = await strand(key, m);
    expect(JSON.parse(readFileSync(join(dir, 'keys', SERVICE_PKH, STRANDED_FILE), 'utf8'))).toMatchObject([{ escrow_ref: ref, kind: 'agent' }]);
    expect(keys.get(SERVICE_PKH)).toBe(key);
    expect(keys.get(DELEGATE_PKH)).toBeUndefined();
    expect(keys.list()).toStrictEqual([key]);
  });

  it('refuses a second key with the same hash and a directory that another key uses, with any spelling of its path; another key in another directory is added', async () => {
    const dir = tempDir();
    const keys = new PayingKeys(dir);
    await keys.add(marketplace({ buyerPkh: SERVICE_PKH }).chain);
    await expect(keys.add(marketplace({ buyerPkh: SERVICE_PKH }).chain)).rejects.toThrow(/held already/);
    const shared = join(dir, 'shared');
    await keys.add(marketplace({ buyerPkh: DELEGATE_PKH }).chain, { dir: shared });
    await expect(keys.add(marketplace({ buyerPkh: THIRD_PKH }).chain, { dir: shared })).rejects.toThrow(/never share a store/);
    await expect(keys.add(marketplace({ buyerPkh: THIRD_PKH }).chain, { dir: join(shared, '..', 'shared') })).rejects.toThrow(/never share a store/);
    expect(keys.list()).toHaveLength(2);
    // The twin: the same key hash, in a directory of its own, is added.
    const third = await keys.add(marketplace({ buyerPkh: THIRD_PKH }).chain, { dir: join(dir, 'other') });
    expect([third.keyHash, third.dir]).toStrictEqual([THIRD_PKH, join(dir, 'other')]);
    expect(keys.list().map((key) => key.keyHash)).toStrictEqual([SERVICE_PKH, DELEGATE_PKH, THIRD_PKH]);
  });

  it('refuses a chain whose wallet gives no key hash, and adds the chain whose wallet does', async () => {
    const keys = new PayingKeys(tempDir());
    const m = marketplace({ buyerPkh: SERVICE_PKH });
    const wallet = await m.chain.wallet();
    for (const buyerPkh of ['not-a-hash', 'AA'.repeat(28), 'aa'.repeat(27)]) {
      const chain: Chain = chainWith(m, { wallet: async () => ({ ...wallet, buyerPkh }) });
      await expect(keys.add(chain)).rejects.toThrow(/no key hash/);
    }
    expect(keys.list()).toStrictEqual([]);
    expect((await keys.add(m.chain)).keyHash).toBe(SERVICE_PKH);
  });

  it('gives the deps of a hire with the chain and the store of the key and no other', async () => {
    const keys = new PayingKeys(tempDir());
    const { serviceKey, delegateKey } = await keyPair(keys);
    const clocked = { clock: () => 1, sleep: async () => undefined, deadlineMs: 2 };
    const log = (): void => undefined;
    const deps = serviceKey.hireDeps(clocked, log);
    expect([deps.chain === serviceKey.chain, deps.stranded === serviceKey.stranded, deps.log === log, deps.deadlineMs]).toStrictEqual([true, true, true, 2]);
    expect(deps.chain === delegateKey.chain || deps.stranded === delegateKey.stranded).toBe(false);
    expect(serviceKey.stranded.file).not.toBe(delegateKey.stranded.file);
    expect('log' in delegateKey.hireDeps(clocked)).toBe(false);
  });
});

describe('a hire from a key and its janitor', () => {
  it('records the escrow of a hire in the store of the key that paid, and in no other store', async () => {
    const keys = new PayingKeys(tempDir());
    const { service, delegate, serviceKey, delegateKey } = await keyPair(keys);
    const refA = await strand(serviceKey, service);
    expect(serviceKey.stranded.list().map((entry) => entry.escrow_ref)).toStrictEqual([refA]);
    expect(delegateKey.stranded.list()).toStrictEqual([]);
    expect(existsSync(delegateKey.stranded.file)).toBe(false);
    const fileA = readFileSync(serviceKey.stranded.file, 'utf8');
    const vault = delegate.chain.openVault({ delegation: DELEGATION, lovelace: 40_000_000n, limit: LIMIT });
    const refB = await strand(delegateKey, delegate, { vaultRef: vault });
    expect(delegateKey.stranded.list().map((entry) => entry.escrow_ref)).toStrictEqual([refB]);
    // The hire of the delegate key did not touch the file of the service key.
    expect(readFileSync(serviceKey.stranded.file, 'utf8')).toBe(fileA);
  });

  it('reclaims, with the janitor of each key, only the escrows of that key: the delegate key returns a vault-paid escrow to the vault as a Returned output, and the service key gets its lock back', async () => {
    const keys = new PayingKeys(tempDir());
    const { service, delegate, serviceKey, delegateKey } = await keyPair(keys);
    const vault = delegate.chain.openVault({ delegation: DELEGATION, lovelace: 40_000_000n, limit: LIMIT });
    const refA = await strand(serviceKey, service);
    const refB = await strand(delegateKey, delegate, { vaultRef: vault });
    const due = (key: PayingKey): number => key.stranded.list()[0].deliver_by + JANITOR_GRACE_MS + 1;
    service.clock.now = due(serviceKey);
    delegate.clock.now = due(delegateKey);
    const floatBefore = (await service.chain.wallet()).floatLovelace;
    // The janitor of the service key reclaims its own escrow. The delegate key's escrow is not in its store, and it stays Open.
    const logs: string[] = [];
    const first = serviceKey.startJanitor(1_000, { clock: () => service.clock.now, log: (line) => { logs.push(line); } });
    await first.stop();
    expect(logs).toHaveLength(1);
    expect(logs[0].startsWith(`key ${SERVICE_PKH.slice(0, 8)}: janitor: reclaimed ${refA}: `)).toBe(true);
    expect(serviceKey.stranded.list()).toStrictEqual([]);
    expect((await service.chain.wallet()).floatLovelace).toBeGreaterThan(floatBefore);
    expect(delegateKey.stranded.list().map((entry) => entry.escrow_ref)).toStrictEqual([refB]);
    expect(await delegate.chain.escrowState(refB)).toBe('Open');
    expect(delegate.chain.vaults().filter((view) => view.kind === 'Returned')).toStrictEqual([]);
    // The janitor of the delegate key reclaims the vault-paid escrow to the vault.
    const second = delegateKey.startJanitor(1_000, { clock: () => delegate.clock.now, log: (line) => { logs.push(line); } });
    await second.stop();
    expect(logs[1].startsWith(`key ${DELEGATE_PKH.slice(0, 8)}: janitor: reclaimed ${refB}: `)).toBe(true);
    expect(delegateKey.stranded.list()).toStrictEqual([]);
    const returned = delegate.chain.vaults().filter((view) => view.kind === 'Returned');
    expect(returned).toHaveLength(1);
    expect(returned[0].delegation).toBe(DELEGATION);
  });

  it('does not start a transaction while the lane of its key works, and reclaims once the lane is free', async () => {
    const keys = new PayingKeys(tempDir());
    const m = marketplace({ buyerPkh: SERVICE_PKH });
    const key = await keys.add(m.chain);
    const ref = await strand(key, m);
    m.clock.now = key.stranded.list()[0].deliver_by + JANITOR_GRACE_MS + 1;
    const held = deferred();
    const working = key.lane.run(() => held.promise);
    const logs: string[] = [];
    const busyPass = key.startJanitor(1_000, { clock: () => m.clock.now, log: (line) => { logs.push(line); } });
    await busyPass.stop();
    expect(logs).toStrictEqual([expect.stringMatching(/^key aaaaaaaa: janitor: 1 transaction deferred: /)]);
    expect(await m.chain.escrowState(ref)).toBe('Open');
    held.resolve();
    await working;
    await settle();
    const freePass = key.startJanitor(1_000, { clock: () => m.clock.now, log: (line) => { logs.push(line); } });
    await freePass.stop();
    expect(logs[1].startsWith(`key aaaaaaaa: janitor: reclaimed ${ref}: `)).toBe(true);
    expect(key.stranded.list()).toStrictEqual([]);
  });

  it('starts one janitor for each key of the registry, and stop ends them all', async () => {
    const keys = new PayingKeys(tempDir());
    const { service, delegate, serviceKey, delegateKey } = await keyPair(keys);
    await strand(serviceKey, service);
    await strand(delegateKey, delegate);
    service.clock.now = serviceKey.stranded.list()[0].deliver_by + JANITOR_GRACE_MS + 1;
    delegate.clock.now = delegateKey.stranded.list()[0].deliver_by + JANITOR_GRACE_MS + 1;
    const logs: string[] = [];
    // One clock for both: the later of the two, which is past the deliver_by of each.
    const janitors = keys.startJanitors(1_000, { clock: () => Math.max(service.clock.now, delegate.clock.now), log: (line) => { logs.push(line); } });
    await janitors.stop();
    expect(logs.map((line) => line.slice(0, 14)).sort()).toStrictEqual(['key aaaaaaaa: ', 'key dddddddd: ']);
    expect([serviceKey.stranded.list(), delegateKey.stranded.list()]).toStrictEqual([[], []]);
  });

  it('a pass of the janitor of one key never reads the store of another: the escrow of the other key stays as it was', async () => {
    const keys = new PayingKeys(tempDir());
    const { service, delegate, serviceKey, delegateKey } = await keyPair(keys);
    await strand(serviceKey, service);
    const refB = await strand(delegateKey, delegate);
    const now = Math.max(service.clock.now, delegate.clock.now, serviceKey.stranded.list()[0].deliver_by + JANITOR_GRACE_MS + 1, delegateKey.stranded.list()[0].deliver_by + JANITOR_GRACE_MS + 1);
    service.clock.now = now;
    delegate.clock.now = now;
    const actions = await runJanitorOnce(serviceKey.stranded, serviceKey.chain, now);
    expect(actions.map((action) => action.action)).toStrictEqual(['reclaimed']);
    expect(delegateKey.stranded.list().map((entry) => entry.escrow_ref)).toStrictEqual([refB]);
    expect(await delegate.chain.escrowState(refB)).toBe('Open');
  });
});
