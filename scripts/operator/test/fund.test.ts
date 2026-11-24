// The task fund, through the real runner and over a world of wallets: the table of a dry run, the transaction of each step (the outputs, the signer, the end of the validity), the steps that
// need no transaction, the member step and each refusal of it, the cap, the guards of the plan, the verification after a landing, the status and the cleanup. Each refusal has an accepted twin.
// The payment is built with Lucid over the world, so the real builder and the real guards run. No test uses a real key, a real clock or a network.
//
// The first test comes first on purpose: Lucid turns a validTo into a slot with its own clock until the slot clock of Vector is set, and that clock is global to the process. The test builds a
// payment before any call of ensureSlotConfig, and the tests after it run the task, which sets the clock. A task that did not set it would be refused by every test that expects a landing.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Utxo } from '../../checks/lib/platform.ts';
import { iso } from '../../checks/lib/format.ts';
import type { GuardResult, StepPlan } from '../../checks/lib/guards.ts';
import { factsOf } from '../../checks/lib/txfacts.ts';
import { SYSTEM_START_MS } from '../../checks/test/support/chain-view.ts';
import type { FundingLine, TaskDefinition, TaskSession, UseCase } from '../lib/contract.ts';
import { landBuilt } from '../lib/land-hosted.ts';
import { loadTask } from '../lib/load.ts';
import { lucidForAddress } from '../lib/platform.ts';
import { loadRegistry } from '../lib/registry.ts';
import { parseArguments, runTask } from '../lib/runner.ts';
import type { CliDeps } from '../lib/runner.ts';
import fundTask, { buildTransfers, planOfTransfers } from '../tasks/fund.ts';
import type { Transfer } from '../tasks/fund.ts';
import realUseCase from '../usecases/inventory-reorder.ts';
import { ThrowingSigner } from './support/fakes.ts';
import { NOW, hashOf, taskWorld } from './support/task-world.ts';
import type { TaskWorld } from './support/task-world.ts';

const UNIT = 1_000_000n;
const MINUTE = 60_000;
const NAMES = ['run', 'fee', 'alpha', 'beta', 'gamma'];
const line = (wallet: string, float: bigint): FundingLine => ({ wallet, collateralLovelace: 5n * UNIT, floatLovelace: float, items: [] });
/** Three wallets to fund, and `gamma`, a key of the registry that no line funds. */
const FUNDING = [line('fee', 60n * UNIT), line('alpha', 10n * UNIT), line('beta', 20n * UNIT)];
const TARGET: Record<string, bigint> = { fee: 65n * UNIT, alpha: 15n * UNIT, beta: 25n * UNIT };
/** The end of the validity that the task builds for a chain whose tip is at the clock: whole seconds, 20 minutes after. */
const VALID_TO = NOW + 20 * MINUTE;

interface WorldOver { wallets?: Record<string, readonly bigint[]>; funding?: readonly FundingLine[]; use?: Partial<UseCase> }

const fundWorld = (over: WorldOver = {}): Promise<TaskWorld> => taskWorld({
  keys: NAMES, shared: ['run', 'fee'], use: { funding: over.funding ?? FUNDING, ...over.use },
  wallets: { run: [1_000n * UNIT], fee: [], alpha: [], beta: [], gamma: [], ...over.wallets },
});

const approve = (w: TaskWorld, over: Parameters<TaskWorld['writeGo']>[0] = {}): void => { w.writeGo({ tasks: ['fund'], ...over }); };
const reset = (w: TaskWorld): void => { w.screen.lines.length = 0; w.screen.errors.length = 0; };
const address = (w: TaskWorld, name: string): string => w.keys.registry.addressOf(name);
const nameAt = (w: TaskWorld, at: string): string => w.keys.registry.names().find((name) => address(w, name) === at) ?? at;

/** What the signing ring was asked, and the dependencies of a run over a ring that counts (or refuses) each signature. */
function counting(w: TaskWorld, refuse = false): { signed: string[]; deps: CliDeps } {
  const signed: string[] = [];
  const thrower = new ThrowingSigner();
  const deps = w.deps({
    readRegistry: (options) => {
      const registry = loadRegistry(options);
      const sign = registry.ring.sign.bind(registry.ring);
      registry.ring.sign = (keyHash, cbor) => { signed.push(keyHash); return refuse ? thrower.sign() : sign(keyHash, cbor); };
      return registry;
    },
  });
  return { signed, deps };
}

/** The `valid_to` that the state file held at each submit, which is the end of the validity that the landing was given. */
function watchSubmits(w: TaskWorld, task = 'fund'): number[] {
  const seen: number[] = [];
  const submit = w.node.submit.bind(w.node);
  w.node.submit = async (cbor) => { seen.push(w.state(task).in_flight!.valid_to); return submit(cbor); };
  return seen;
}

/** Counts the builds of a world: each build reads the parameters of the protocol once. A test that says "before any build" holds the count at 0. */
function countBuilds(w: TaskWorld): { count: () => number } {
  let builds = 0;
  const parameters = w.world.chain.getProtocolParameters.bind(w.world.chain);
  w.world.chain.getProtocolParameters = async () => { builds += 1; return parameters(); };
  return { count: () => builds };
}

/** The payments of the submitted transaction, by wallet name and without the change. The last output is the change to the run wallet. */
function paid(w: TaskWorld, index = 0): Array<[string, bigint]> {
  const outputs = factsOf(w.node.submitted[index]!).outputs.map((output): [string, bigint] => [nameAt(w, output.address), output.lovelace]);
  expect(outputs.at(-1)![0]).toBe('run');
  return outputs.slice(0, -1);
}

const rowOf = (w: TaskWorld, name: string): string[] => (w.screen.lines.find((text) => text.startsWith(`${name} `)) ?? '').trim().split(/\s+/);
const run = (w: TaskWorld, ...argv: string[]): Promise<number> => w.run(fundTask, ...argv);
const untouched = (w: TaskWorld): void => {
  expect(w.node.submitted).toEqual([]);
  expect(w.world.chain.applied).toEqual([]);
  expect(w.state('fund').in_flight).toBeNull();
  expect(w.state('fund').steps).toEqual({});
};

/** A task that runs `body` with the session of a run of fund: it has the keys, the chain and the approval that fund has. */
function probe(body: (session: TaskSession) => Promise<void>): TaskDefinition {
  return {
    name: 'fund', title: 'a probe of the landing', flags: [], valued: ['member'], needs: fundTask.needs, steps: () => ['probe'], parse: () => ({}),
    next: async (session) => { await body(session); return { kind: 'done', message: 'the probe is done' }; },
    cleanup: async () => ({ kind: 'done', message: 'nothing' }),
  };
}

describe('a payment that Lucid built with its own slot clock', () => {
  it('is refused by the landing before any guard runs and before any signature, with both slots named, and the task that sets the slot clock first lands the same payment', async () => {
    const w = await fundWorld();
    const { signed, deps } = counting(w);
    const wrong = probe(async (session) => {
      const lucid = await lucidForAddress(session.chain.provider, address(w, 'run'));
      const built = await lucid.newTx().pay.ToAddress(address(w, 'fee'), { lovelace: 5n * UNIT }).validTo(VALID_TO).complete();
      const facts = factsOf(built.toCBOR());
      await landBuilt(session, {
        step: 'collateral', built: { unsignedCbor: built.toCBOR(), txHash: built.toHash(), feeLovelace: facts.feeLovelace, validTo: VALID_TO }, expectSigners: ['run'],
        plan: (bytes) => planOfTransfers(session, [{ address: address(w, 'fee'), lovelace: 5n * UNIT }], bytes),
      });
    });
    expect(await runTask(wrong, [], deps)).toBe(2);
    const vectorSlot = Math.floor((VALID_TO - SYSTEM_START_MS) / 1000);
    expect(w.screen.errorText).toMatch(/the body ends at the slot \d+, and the built validTo \S+ is the slot \d+/);
    expect(w.screen.errorText).toContain(`is the slot ${vectorSlot}`);
    expect(w.screen.errorText).not.toContain(`the body ends at the slot ${vectorSlot},`);
    expect(signed).toEqual([]);
    expect(w.node.submitted).toEqual([]);
    reset(w);
    expect(await run(w)).toBe(0);
    expect(w.screen.text).toContain('step collateral: dry mode, nothing is signed or submitted');
    expect(w.screen.errorText).toBe('');
  });
});

describe('the definition', () => {
  it('needs every key of the use case, the chain, no hosted tool and the approval, and has the steps collateral and float, or the step of one member', async () => {
    const w = await fundWorld();
    const loaded = await loadTask('fund');
    expect(loaded.name).toBe('fund');
    const plain = parseArguments(loaded, []).flags;
    const member = parseArguments(loaded, ['--member', 'stand-in']).flags;
    expect(loaded.needs.keys(w.use, plain)).toEqual(['run', 'fee', 'alpha', 'beta', 'gamma']);
    expect(loaded.needs.keys(w.use, member)).toEqual(['run', 'fee', 'alpha', 'beta', 'gamma']);
    expect(loaded.needs).toMatchObject({ chain: true, hosted: [], approval: 'submit' });
    expect(loaded.flags).toEqual([]);
    expect(loaded.valued).toEqual(['member']);
    expect(loaded.steps(w.use, plain)).toEqual(['collateral', 'float']);
    expect(loaded.steps(w.use, member)).toEqual(['member:stand-in']);
  });
  it('stops with exit 2 for a funding line that is not sound, for a wallet that is listed twice and for a run label, and takes the data and the flags that are', async () => {
    const bad: Array<[string, readonly FundingLine[], string[]]> = [
      ['a collateral that is not a bigint', [{ ...line('fee', UNIT), collateralLovelace: 5_000_000 as unknown as bigint }], []],
      ['a float below 0', [line('fee', -1n)], []],
      ['a wallet listed twice', [line('fee', UNIT), line('fee', UNIT)], []],
      ['a run label', FUNDING, ['--run', 'r1']],
    ];
    for (const [what, funding, argv] of bad) {
      const w = await fundWorld({ funding });
      expect(await run(w, ...argv), what).toBe(2);
      expect(w.node.submitted, what).toEqual([]);
      expect(w.world.chain.applied, what).toEqual([]);
    }
    const w = await fundWorld();
    expect(await run(w)).toBe(0);
  });
});

describe('a dry run of the step collateral', () => {
  it('prints the table with the balance now, what each step sends, the totals and the balance of the run wallet after, signs and submits nothing, and needs no approval file', async () => {
    const w = await fundWorld({ wallets: { alpha: [3n * UNIT] } });
    const { signed, deps } = counting(w, true);
    expect(await runTask(fundTask, [], deps)).toBe(0);
    expect(signed).toEqual([]);
    untouched(w);
    expect(w.exposure()).toEqual([]);
    expect(rowOf(w, 'fee')).toEqual(['fee', '0.000000', '5.000000', '60.000000', '65.000000']);
    expect(rowOf(w, 'alpha')).toEqual(['alpha', '3.000000', '5.000000', '7.000000', '15.000000']);
    expect(rowOf(w, 'beta')).toEqual(['beta', '0.000000', '5.000000', '20.000000', '25.000000']);
    expect(rowOf(w, 'total')).toEqual(['total', '3.000000', '15.000000', '87.000000', '105.000000']);
    expect(w.screen.lines).toContain('the step collateral sends 15.000000 units to 3 wallets in one transaction');
    expect(w.screen.lines).toContain('the run wallet holds 1000.000000 units; after this step it holds 985.000000 units before the fee');
    expect(w.screen.text).toMatch(/the fee is \d+\.\d{6} units: the run wallet holds 984\.\d{6} units after this step/);
    expect(w.screen.lines).toContain('step collateral: dry mode, nothing is signed or submitted');
    expect(w.machine()).toMatchObject({ task: 'fund', mode: 'dry', outcome: 'dry', exit: 0, step: 'collateral' });
  });
  it('stops with exit 2 before any build when the run wallet holds less than the outputs, the fee limit and one unit for the change, after it printed the table, and goes on when it holds that', async () => {
    // 15 units go out, the fee limit is 2 units, and the change needs 1 unit. A wallet with 16.1 units passes the least that a builder needs for the fee, and a builder stops on the change: the task refuses first.
    for (const [held, shown] of [[15n * UNIT + UNIT - 1n, '15.999999'], [16_100_000n, '16.100000'], [18n * UNIT - 1n, '17.999999']] as const) {
      const w = await fundWorld({ wallets: { run: [held] } });
      const builds = countBuilds(w);
      expect(await run(w), shown).toBe(2);
      expect(builds.count(), shown).toBe(0);
      expect(rowOf(w, 'total')).toEqual(['total', '0.000000', '15.000000', '90.000000', '105.000000']);
      expect(w.screen.errorText).toContain(`the run wallet holds ${shown} units, and the step collateral needs 15.000000 units for its outputs and 3.000000 units for the fee and the change`);
      untouched(w);
    }
    const twin = await fundWorld({ wallets: { run: [18n * UNIT] } });
    expect(await run(twin)).toBe(0);
  });
});

describe('the step collateral', () => {
  it('sends one pure output of exactly 5 units to each wallet that has none, in one transaction that only the run key signs, with no other output but the change, and records the step as verified', async () => {
    const w = await fundWorld();
    approve(w);
    const { signed, deps } = counting(w);
    expect(await runTask(fundTask, ['--submit'], deps)).toBe(0);
    expect(w.node.submitted).toHaveLength(1);
    expect(paid(w)).toEqual([['fee', 5n * UNIT], ['alpha', 5n * UNIT], ['beta', 5n * UNIT]]);
    expect(factsOf(w.node.submitted[0]!).witnesses).toEqual([w.keys.registry.hashOf('run')]);
    expect(signed).toEqual([w.keys.registry.hashOf('run')]);
    const record = w.state('fund').steps.collateral!;
    expect(record.tx_hash).toBe(factsOf(w.node.submitted[0]!).txHash);
    expect(record.verified_at).not.toBeNull();
    expect(w.machine()).toMatchObject({ outcome: 'done', exit: 0, step: 'collateral' });
    expect(w.machine().result).toEqual({ sent: [{ step: 'collateral', transaction: record.tx_hash, wallets: 3, lovelace: '15000000' }] });
    expect(w.evidence('fund').map((entry) => entry.status)).toEqual(['confirmed']);
    for (const name of ['fee', 'alpha', 'beta']) {
      const outputs = await w.chain.provider.getUtxos(address(w, name));
      expect(outputs.map((output) => output.assets.lovelace)).toEqual([5n * UNIT]);
    }
  });
  it('skips a wallet that holds a pure output of exactly 5 units, and sends one to a wallet whose outputs are another amount, or are not pure', async () => {
    const w = await fundWorld({ wallets: { fee: [5n * UNIT], alpha: [6n * UNIT, 4n * UNIT], beta: [] } });
    const token: Utxo = { txHash: hashOf('a token output'), outputIndex: 0, address: address(w, 'beta'), assets: { lovelace: 5n * UNIT, [`${'aa'.repeat(28)}01`]: 1n } };
    w.world.chain.held.push(token);
    approve(w);
    expect(await run(w, '--submit')).toBe(0);
    expect(paid(w)).toEqual([['alpha', 5n * UNIT], ['beta', 5n * UNIT]]);
  });
  it('records the step with no transaction, and says so, when every wallet holds its output, and the next step is the float', async () => {
    const w = await fundWorld({ wallets: { fee: [5n * UNIT], alpha: [5n * UNIT], beta: [5n * UNIT] } });
    expect(await run(w)).toBe(0);
    expect(w.screen.lines).toContain('no wallet needs a collateral output: the step collateral would be recorded with no transaction');
    untouched(w);
    approve(w);
    reset(w);
    expect(await run(w, '--submit')).toBe(0);
    expect(w.screen.lines).toContain('no wallet needs a collateral output: the step collateral is recorded with no transaction');
    expect(w.node.submitted).toEqual([]);
    const record = w.state('fund').steps.collateral!;
    expect(record.tx_hash).toBeNull();
    expect(record.verified_at).not.toBeNull();
    expect(w.machine()).toMatchObject({ outcome: 'done', step: 'collateral', result: { sent: [{ step: 'collateral', transaction: null, wallets: 0, lovelace: '0' }] } });
    reset(w);
    expect(await run(w)).toBe(0);
    expect(w.machine()).toMatchObject({ outcome: 'dry', step: 'float' });
  });
});

describe('the step float', () => {
  it('sends the amount that each wallet lacks to its target, in one transaction after the step collateral, and then the next run says that every step is confirmed', async () => {
    const w = await fundWorld();
    approve(w);
    expect(await run(w, '--submit')).toBe(0);
    reset(w);
    expect(await run(w)).toBe(0);
    expect(rowOf(w, 'fee')).toEqual(['fee', '5.000000', '0.000000', '60.000000', '65.000000']);
    expect(w.screen.lines).toContain('the step float sends 90.000000 units to 3 wallets in one transaction');
    expect(w.machine()).toMatchObject({ outcome: 'dry', step: 'float' });
    expect(w.node.submitted).toHaveLength(1);
    reset(w);
    expect(await run(w, '--submit')).toBe(0);
    expect(w.node.submitted).toHaveLength(2);
    expect(paid(w, 1)).toEqual([['fee', 60n * UNIT], ['alpha', 10n * UNIT], ['beta', 20n * UNIT]]);
    expect(factsOf(w.node.submitted[1]!).witnesses).toEqual([w.keys.registry.hashOf('run')]);
    for (const [name, target] of Object.entries(TARGET)) {
      const outputs = await w.chain.provider.getUtxos(address(w, name));
      expect(outputs.reduce((sum, output) => sum + (output.assets.lovelace ?? 0n), 0n)).toBe(target);
    }
    reset(w);
    expect(await run(w, '--submit')).toBe(0);
    expect(w.machine()).toMatchObject({ outcome: 'finished', exit: 0 });
    expect(w.node.submitted).toHaveLength(2);
  });
  it('does both steps in one run with --all, one transaction for each', async () => {
    const w = await fundWorld();
    approve(w);
    expect(await run(w, '--submit', '--all')).toBe(0);
    expect(w.node.submitted).toHaveLength(2);
    expect(paid(w, 0).map(([, lovelace]) => lovelace)).toEqual([5n * UNIT, 5n * UNIT, 5n * UNIT]);
    expect(paid(w, 1).map(([, lovelace]) => lovelace)).toEqual([60n * UNIT, 10n * UNIT, 20n * UNIT]);
    expect(Object.keys(w.state('fund').steps)).toEqual(['collateral', 'float']);
  });
  it('skips a wallet that is full, and a wallet that lacks less than one unit, and sends exactly one unit to a wallet that lacks one unit', async () => {
    const w = await fundWorld({ wallets: { fee: [5n * UNIT, 60n * UNIT], alpha: [5n * UNIT, 9_500_000n], beta: [5n * UNIT, 19n * UNIT] } });
    approve(w);
    expect(await run(w, '--submit')).toBe(0);
    expect(w.machine()).toMatchObject({ step: 'collateral' });
    expect(w.node.submitted).toEqual([]);
    reset(w);
    expect(await run(w)).toBe(0);
    expect(rowOf(w, 'fee')).toEqual(['fee', '65.000000', '0.000000', '0.000000', '65.000000']);
    expect(rowOf(w, 'alpha')).toEqual(['alpha', '14.500000', '0.000000', '0.000000', '14.500000']);
    expect(rowOf(w, 'beta')).toEqual(['beta', '24.000000', '0.000000', '1.000000', '25.000000']);
    reset(w);
    expect(await run(w, '--submit')).toBe(0);
    expect(paid(w)).toEqual([['beta', UNIT]]);
  });
  it('records the step with no transaction, and says so, when every wallet is full', async () => {
    const w = await fundWorld({ wallets: { fee: [5n * UNIT, 60n * UNIT], alpha: [5n * UNIT, 10n * UNIT], beta: [5n * UNIT, 20n * UNIT] } });
    approve(w);
    expect(await run(w, '--submit', '--all')).toBe(0);
    expect(w.screen.lines).toContain('every wallet holds its float: the step float is recorded with no transaction');
    expect(w.node.submitted).toEqual([]);
    expect(Object.keys(w.state('fund').steps)).toEqual(['collateral', 'float']);
    expect(w.state('fund').steps.float!.tx_hash).toBeNull();
    reset(w);
    expect(await run(w, '--submit')).toBe(0);
    expect(w.machine()).toMatchObject({ outcome: 'finished' });
  });
  it('stops with exit 2 before any build when the run wallet is too small for the step, and the approval was given', async () => {
    const w = await fundWorld({ wallets: { run: [50n * UNIT], fee: [5n * UNIT], alpha: [5n * UNIT], beta: [5n * UNIT] } });
    approve(w);
    expect(await run(w, '--submit')).toBe(0);
    reset(w);
    expect(await run(w, '--submit')).toBe(2);
    expect(w.screen.errorText).toContain('the run wallet holds 50.000000 units, and the step float needs 90.000000 units for its outputs and 3.000000 units for the fee and the change');
    expect(w.node.submitted).toHaveLength(0);
  });
});

describe('every transaction of the task', () => {
  it('has a validTo that is a whole number of milliseconds after the clock, 20 minutes after the tip of the chain, and a ttl that is the slot of Vector of that validTo, and lands through the landing', async () => {
    const w = await fundWorld();
    approve(w);
    const validTo = watchSubmits(w);
    expect(await run(w, '--submit', '--all')).toBe(0);
    expect(validTo).toEqual([VALID_TO, VALID_TO]);
    for (const [index, end] of validTo.entries()) {
      expect(Number.isSafeInteger(end) && end > NOW && end % 1000 === 0).toBe(true);
      expect(factsOf(w.node.submitted[index]!).validityEndSlot).toBe(BigInt((end - SYSTEM_START_MS) / 1000));
    }
    expect(w.screen.text).toContain(`valid until: ${iso(VALID_TO)}`);
  });
  it('takes the end of the validity from the tip of the node, and from the clock of the host when the provider gives no tip', async () => {
    const behind = await fundWorld();
    behind.world.chain.tipSlot -= 30;
    approve(behind);
    const behindEnds = watchSubmits(behind);
    expect(await run(behind, '--submit')).toBe(0);
    expect(behindEnds).toEqual([VALID_TO - 30_000]);
    const w = await fundWorld();
    approve(w);
    w.clock.t += 400;
    const provider = new Proxy(w.world.chain, { get: (target, name) => (name === 'getNetworkTip' ? undefined : Reflect.get(target, name)) });
    const ends = watchSubmits(w);
    expect(await runTask(fundTask, ['--submit'], w.deps({ chain: { ...w.chain, provider } }))).toBe(0);
    expect(ends).toEqual([NOW + 400 + 20 * MINUTE]);
    expect(factsOf(w.node.submitted[0]!).validityEndSlot).toBe(BigInt(Math.floor((NOW + 400 + 20 * MINUTE - SYSTEM_START_MS) / 1000)));
  });
  it('stops with exit 2 before any build when the provider cannot tell the start of the chain, and when the node gives no usable tip, and builds when it does', async () => {
    const blind = await fundWorld();
    approve(blind);
    const noStart = new Proxy(blind.world.chain, { get: (target, name) => (name === 'getSystemStartMs' ? undefined : Reflect.get(target, name)) });
    expect(await runTask(fundTask, ['--submit'], blind.deps({ chain: { ...blind.chain, provider: noStart } }))).toBe(2);
    expect(blind.screen.errorText).toContain('the provider of the chain cannot tell the start of the chain');
    untouched(blind);
    const lost = await fundWorld();
    approve(lost);
    lost.world.chain.tipSlot = -1;
    expect(await run(lost, '--submit')).toBe(2);
    expect(lost.screen.errorText).toContain('the node gave no usable tip');
    untouched(lost);
    lost.world.chain.tipSlot = Math.floor((NOW - SYSTEM_START_MS) / 1000);
    reset(lost);
    expect(await run(lost, '--submit')).toBe(0);
  });
});

describe('the guards of the plan', () => {
  const wallets = (w: TaskWorld): Transfer[] => ['fee', 'alpha'].map((name) => ({ address: address(w, name), lovelace: 5n * UNIT }));
  it('refuse an output to an address that is no wallet of the registry and is not named by the step, before any signature, and let the same payment without it land', async () => {
    const w = await fundWorld();
    approve(w);
    const stranger = w.world.addressOf(77);
    const failures: GuardResult[][] = [];
    const landing = (extra: boolean) => probe(async (session) => {
      const legit = wallets(w);
      const built = await buildTransfers(session, extra ? [...legit, { address: stranger, lovelace: 2n * UNIT }] : legit);
      const result = await landBuilt(session, { step: 'collateral', built, expectSigners: ['run'], plan: (facts) => planOfTransfers(session, legit, facts) });
      failures.push(result.results);
    });
    const { signed, deps } = counting(w, true);
    expect(await runTask(landing(true), ['--submit'], deps)).toBe(2);
    expect(w.screen.errorText).toContain(`an output goes to ${stranger}, which is no wallet of the keys and no address of the step`);
    expect(w.screen.errorText).toContain('refused by destinations');
    expect(signed).toEqual([]);
    untouched(w);
    expect(w.exposure()).toEqual([]);
    const twin = counting(w);
    reset(w);
    expect(await runTask(landing(false), ['--submit'], twin.deps)).toBe(0);
    expect(twin.signed).toEqual([w.keys.registry.hashOf('run')]);
    expect(failures.at(-1)!.every((result) => result.ok)).toBe(true);
    expect(paid(w)).toEqual([['fee', 5n * UNIT], ['alpha', 5n * UNIT]]);
  });
  it('allow only what the transfers say: the destinations are the addresses of the transfers, the outflow of the run wallet is their sum and the fee of the bytes, and nothing is minted or withdrawn', async () => {
    const w = await fundWorld();
    const seen: Array<{ plan: StepPlan; fee: bigint }> = [];
    const stranger = w.world.addressOf(78);
    await runTask(probe(async (session) => {
      const transfers = [{ address: stranger, lovelace: 60n * UNIT }];
      const built = await buildTransfers(session, transfers);
      const facts = factsOf(built.unsignedCbor);
      expect(built.feeLovelace).toBe(facts.feeLovelace);
      seen.push({ plan: planOfTransfers(session, transfers, facts), fee: facts.feeLovelace });
    }), [], w.deps());
    const { plan, fee } = seen[0]!;
    expect([...plan.destinations]).toEqual([stranger]);
    expect(plan.maxOutflow).toEqual({ [w.keys.registry.hashOf('run')]: 60n * UNIT + fee });
    expect(fee).toBeGreaterThan(0n);
    expect(fee).toBeLessThanOrEqual(plan.maxFeeLovelace);
    expect(plan.mint).toEqual({});
    expect(plan.withdrawals).toBeUndefined();
    expect([...plan.explained]).toEqual([]);
  });
  it('refuse an output to a wallet of the registry that the step does not name, which the destinations allow, by the outflow of the run wallet, before any signature', async () => {
    const w = await fundWorld();
    approve(w);
    const { signed, deps } = counting(w, true);
    const body = probe(async (session) => {
      const legit = wallets(w);
      const built = await buildTransfers(session, [...legit, { address: address(w, 'gamma'), lovelace: 2n * UNIT }]);
      await landBuilt(session, { step: 'collateral', built, expectSigners: ['run'], plan: (facts) => planOfTransfers(session, legit, facts) });
    });
    expect(await runTask(body, ['--submit'], deps)).toBe(2);
    expect(w.screen.errorText).toContain('refused by outflow:');
    expect(w.screen.errorText).toMatch(/the run wallet \S+: \d+\.\d{6} units leave it, over the limit of \d+\.\d{6} units/);
    expect(signed).toEqual([]);
    untouched(w);
    expect(w.exposure()).toEqual([]);
  });
});

describe('the step of a member', () => {
  const member = (w: TaskWorld, over: { label?: string; address?: string; units?: number; capUnits?: number } = {}): string => {
    approve(w, { capUnits: over.capUnits ?? 100, external: [{ label: over.label ?? 'stand-in', address: over.address ?? w.world.addressOf(90), units: over.units ?? 60 }] });
    return over.address ?? w.world.addressOf(90);
  };

  it('sends one output of the amount of the approval to the address of the approval, in one transaction that only the run key signs, and records the step of the label', async () => {
    const w = await fundWorld();
    const to = member(w);
    const { signed, deps } = counting(w);
    expect(await runTask(fundTask, ['--submit', '--member', 'stand-in'], deps)).toBe(0);
    expect(w.node.submitted).toHaveLength(1);
    const outputs = factsOf(w.node.submitted[0]!).outputs;
    expect(outputs.map((output) => [output.address, output.lovelace]).slice(0, -1)).toEqual([[to, 60n * UNIT]]);
    expect(nameAt(w, outputs.at(-1)!.address)).toBe('run');
    expect(signed).toEqual([w.keys.registry.hashOf('run')]);
    const record = w.state('fund').notes['part.member:stand-in'] as { tx_hash: string };
    expect(record.tx_hash).toBe(factsOf(w.node.submitted[0]!).txHash);
    expect(w.machine()).toMatchObject({ outcome: 'done', step: 'member:stand-in' });
    expect(w.screen.text).toContain(`the member stand-in: 60.000000 units to ${to}`);
  });
  it('reads the approval in a dry run too, because it holds the address and the amount, shows the transfer and signs nothing, and stops with exit 2 when the file gives none', async () => {
    const w = await fundWorld();
    expect(await run(w, '--member', 'stand-in')).toBe(2);
    expect(w.screen.errorText).toContain('the approval file does not exist');
    untouched(w);
    const to = member(w);
    reset(w);
    const { signed, deps } = counting(w, true);
    expect(await runTask(fundTask, ['--member', 'stand-in'], deps)).toBe(0);
    expect(signed).toEqual([]);
    expect(w.screen.text).toContain(`the member stand-in: 60.000000 units to ${to}`);
    expect(w.machine()).toMatchObject({ outcome: 'dry', step: 'member:stand-in' });
    untouched(w);
  });
  it('is refused with exit 2 for a label that the approval does not hold, and the label that it holds is sent', async () => {
    const w = await fundWorld();
    member(w, { label: 'member' });
    expect(await run(w, '--submit', '--member', 'stand-in')).toBe(2);
    expect(w.screen.errorText).toContain('the approval file has no external entry with the label stand-in');
    untouched(w);
    approve(w);
    reset(w);
    expect(await run(w, '--submit', '--member', 'member')).toBe(2);
    expect(w.screen.errorText).toContain('the approval file has no external entry with the label member');
    member(w, { label: 'member' });
    reset(w);
    expect(await run(w, '--submit', '--member', 'member')).toBe(0);
    expect(w.node.submitted).toHaveLength(1);
  });
  it('is refused with exit 2 for a label that the state file records, which is never sent twice, and a new label is sent', async () => {
    const w = await fundWorld();
    member(w);
    expect(await run(w, '--submit', '--member', 'stand-in')).toBe(0);
    const hash = factsOf(w.node.submitted[0]!).txHash;
    reset(w);
    expect(await run(w, '--submit', '--member', 'stand-in')).toBe(2);
    expect(w.screen.errorText).toContain(`the member stand-in was sent already (the transaction ${hash}): a member is never sent twice`);
    expect(w.node.submitted).toHaveLength(1);
    reset(w);
    expect(await run(w, '--member', 'stand-in')).toBe(2);
    approve(w, { external: [{ label: 'driver', address: w.world.addressOf(91), units: 15 }] });
    reset(w);
    expect(await run(w, '--submit', '--member', 'driver')).toBe(0);
    expect(w.node.submitted).toHaveLength(2);
  });
  it('is refused with exit 2 for an address that is a wallet of the registry, funded or not, and an address that is not a mainnet address, and a stranger is sent', async () => {
    const w = await fundWorld();
    const flipped = (text: string): string => `${text.slice(0, -1)}${text.endsWith('q') ? 'p' : 'q'}`;
    const refused: Array<[string, string, string]> = [
      ['the run wallet', address(w, 'run'), 'is a wallet of the registry (the key run)'],
      ['a funded wallet', address(w, 'alpha'), 'is a wallet of the registry (the key alpha)'],
      ['a key that no line funds', address(w, 'gamma'), 'is a wallet of the registry (the key gamma)'],
      ['an address with a wrong checksum', flipped(w.world.addressOf(90)), 'is not a mainnet address'],
    ];
    for (const [what, to, said] of refused) {
      member(w, { address: to });
      reset(w);
      expect(await run(w, '--submit', '--member', 'stand-in'), what).toBe(2);
      expect(w.screen.errorText, what).toContain(said);
      untouched(w);
    }
    member(w, { address: w.world.addressOf(90) });
    reset(w);
    expect(await run(w, '--submit', '--member', 'stand-in')).toBe(0);
  });
  it('is refused with exit 2 for an amount that is not a whole number of lovelace, and sends the amount that is one lovelace more than a unit', async () => {
    const w = await fundWorld();
    member(w, { units: 60.000_000_1 });
    expect(await run(w, '--submit', '--member', 'stand-in')).toBe(2);
    expect(w.screen.errorText).toContain('external has an amount');
    untouched(w);
    const to = member(w, { units: 60.000_001 });
    reset(w);
    expect(await run(w, '--submit', '--member', 'stand-in')).toBe(0);
    expect(factsOf(w.node.submitted[0]!).outputs.find((output) => output.address === to)!.lovelace).toBe(60n * UNIT + 1n);
  });
  it('is refused with exit 2 for a label that is not a label, and when the run wallet holds less than the amount, the fee limit and one unit for the change', async () => {
    const w = await fundWorld({ wallets: { run: [61n * UNIT - 1n] } });
    member(w);
    expect(await run(w, '--submit', '--member', 'Stand_In')).toBe(2);
    expect(w.screen.errorText).toContain('the label of --member is 1 to 32 lower-case letters, digits and hyphens');
    reset(w);
    expect(await run(w, '--submit', '--member', 'stand-in')).toBe(2);
    expect(w.screen.errorText).toContain('the run wallet holds 60.999999 units, and the step member:stand-in needs 60.000000 units for its outputs and 3.000000 units for the fee and the change');
    untouched(w);
    // 61.1 units pass the least that a builder needs for the fee. The builder stops on the change, and so the task refuses first, with exit 2 and no build.
    const short = await fundWorld({ wallets: { run: [61_100_000n] } });
    const builds = countBuilds(short);
    member(short);
    expect(await run(short, '--submit', '--member', 'stand-in')).toBe(2);
    expect(short.screen.errorText).toContain('the run wallet holds 61.100000 units, and the step member:stand-in needs 60.000000 units for its outputs and 3.000000 units for the fee and the change');
    expect(builds.count()).toBe(0);
    untouched(short);
    const twin = await fundWorld({ wallets: { run: [63n * UNIT] } });
    member(twin);
    expect(await run(twin, '--submit', '--member', 'stand-in')).toBe(0);
  });
});

describe('the cap of the approval', () => {
  it('counts the member step in full and the steps collateral and float by their fee only, because their wallets are in the registry', async () => {
    const small = await fundWorld();
    small.writeGo({ tasks: ['fund'], capUnits: 59, external: [{ label: 'stand-in', address: small.world.addressOf(90), units: 60 }] });
    expect(await run(small, '--submit', '--member', 'stand-in')).toBe(2);
    expect(small.screen.errorText).toContain('over the cap of 59.000000 units');
    untouched(small);
    const exact = await fundWorld();
    exact.writeGo({ tasks: ['fund'], capUnits: 61, external: [{ label: 'stand-in', address: exact.world.addressOf(90), units: 60 }] });
    expect(await run(exact, '--submit', '--member', 'stand-in')).toBe(0);
    const reserved = BigInt(exact.exposure()[0]!.net_lovelace);
    expect(reserved).toBeGreaterThan(60n * UNIT);
    expect(reserved).toBeLessThan(61n * UNIT);

    const inside = await fundWorld();
    inside.writeGo({ tasks: ['fund'], capUnits: 1 });
    expect(await run(inside, '--submit', '--all')).toBe(0);
    expect(inside.node.submitted).toHaveLength(2);
    const fees = inside.exposure().map((entry) => BigInt(entry.net_lovelace));
    expect(fees).toHaveLength(2);
    for (const fee of fees) expect(fee).toBeLessThan(UNIT);
    const none = await fundWorld();
    none.writeGo({ tasks: ['fund'], capUnits: 0 });
    expect(await run(none, '--submit')).toBe(2);
    expect(none.screen.errorText).toContain('over the cap of 0.000000 units');
    untouched(none);
  });
});

describe('the verification after a landing', () => {
  it('fails with exit 1 and the names of the wallets that lack their output, keeps the step confirmed and not verified, and verifies it before the next step at the next run', async () => {
    const w = await fundWorld();
    approve(w);
    const hidden: Utxo[] = [];
    let armed = true;
    const submit = w.node.submit.bind(w.node);
    w.node.submit = async (cbor) => {
      const hash = await submit(cbor);
      if (!armed) return hash;
      armed = false;
      const lost = w.world.chain.held.filter((output) => output.address === address(w, 'alpha') || output.address === address(w, 'beta'));
      hidden.push(...lost);
      w.world.chain.held = w.world.chain.held.filter((output) => !lost.includes(output));
      return hash;
    };
    expect(await run(w, '--submit')).toBe(1);
    expect(w.screen.errorText).toContain('the node shows no pure output of exactly 5.000000 units at the wallets alpha, beta');
    expect(w.screen.errorText).not.toContain('the wallets alpha, beta, fee');
    const record = w.state('fund').steps.collateral!;
    expect(record.tx_hash).not.toBeNull();
    expect(record.verified_at).toBeNull();
    expect(w.machine()).toMatchObject({ outcome: 'failed', exit: 1 });
    w.world.chain.held.push(...hidden);
    reset(w);
    expect(await run(w, '--submit')).toBe(0);
    expect(w.screen.lines).toContain('the step collateral is verified');
    expect(w.state('fund').steps.collateral!.verified_at).not.toBeNull();
    expect(w.machine()).toMatchObject({ outcome: 'done', step: 'float' });
  });
  it('fails with exit 1 and the names of the wallets whose balance is under the target after the step float', async () => {
    const w = await fundWorld({ wallets: { fee: [5n * UNIT], alpha: [5n * UNIT], beta: [5n * UNIT] } });
    approve(w);
    const submit = w.node.submit.bind(w.node);
    w.node.submit = async (cbor) => {
      const hash = await submit(cbor);
      w.world.chain.held = w.world.chain.held.filter((output) => !(output.address === address(w, 'fee') && output.assets.lovelace !== 5n * UNIT));
      return hash;
    };
    expect(await run(w, '--submit', '--all')).toBe(1);
    expect(w.screen.errorText).toContain('the node shows less than 65.000000 units at the wallet fee');
    expect(w.state('fund').steps.float!.verified_at).toBeNull();
  });
});

describe('the status and the cleanup', () => {
  it('shows the table of the funding, the step that is next and the wallets, and changes nothing', async () => {
    const w = await fundWorld({ wallets: { alpha: [5n * UNIT, 2n * UNIT] } });
    expect(await run(w, 'status')).toBe(0);
    expect(rowOf(w, 'alpha')).toEqual(['alpha', '7.000000', '0.000000', '8.000000', '15.000000']);
    expect(rowOf(w, 'fee')).toEqual(['fee', '0.000000', '5.000000', '60.000000', '65.000000']);
    expect(w.screen.text).toContain('next: collateral');
    untouched(w);
    expect(w.machine()).toMatchObject({ command: 'status', outcome: 'done', exit: 0 });
    approve(w);
    reset(w);
    expect(await run(w, '--submit')).toBe(0);
    reset(w);
    expect(await run(w, 'status')).toBe(0);
    expect(rowOf(w, 'alpha')).toEqual(['alpha', '7.000000', '0.000000', '8.000000', '15.000000']);
    expect(rowOf(w, 'fee')).toEqual(['fee', '5.000000', '0.000000', '60.000000', '65.000000']);
    expect(w.screen.text).toContain('next: float');
  });
  it('says that the pack never sweeps a wallet, exits 0 and moves nothing', async () => {
    const w = await fundWorld();
    approve(w);
    expect(await run(w, 'cleanup', '--submit')).toBe(0);
    expect(w.screen.lines).toContain('the pack never sweeps a wallet: floats are topped up by hand, and the operator empties a wallet. Nothing was changed');
    untouched(w);
    expect(w.exposure()).toEqual([]);
  });
  it('shows no seed and no key file text anywhere after a run', async () => {
    const w = await fundWorld();
    approve(w);
    expect(await run(w, '--submit', '--all')).toBe(0);
    const text = w.allText();
    for (const name of NAMES) expect(text).not.toContain(w.keys.seedOf(name));
    expect(readdirSync(w.stateDir).filter((file) => file.endsWith('.json')).length).toBeGreaterThan(0);
    expect(readFileSync(join(w.stateDir, 'fund.state.json'), 'utf8')).not.toContain(w.keys.seedOf('run'));
  });
});

describe('the real data of use case 1', () => {
  const realWorld = (): Promise<TaskWorld> => taskWorld({
    keys: realUseCase.keys.map((spec) => spec.name), shared: realUseCase.keys.filter((spec) => spec.scope === 'shared').map((spec) => spec.name), use: realUseCase,
    wallets: { run: [2_500n * UNIT], ...Object.fromEntries(realUseCase.funding.map((funding) => [funding.wallet, []])) },
  });
  it('shows the table of the funding of use case 1 in a dry run: 45 units of collateral and 460 units of float to the nine wallets, 505 units in all', async () => {
    const w = await realWorld();
    expect(await run(w)).toBe(0);
    expect(rowOf(w, 'total')).toEqual(['total', '0.000000', '45.000000', '460.000000', '505.000000']);
    expect(w.screen.lines).toContain('the step collateral sends 45.000000 units to 9 wallets in one transaction');
    expect(w.screen.lines).toContain('the run wallet holds 2500.000000 units; after this step it holds 2455.000000 units before the fee');
    expect(realUseCase.funding).toHaveLength(9);
    for (const funding of realUseCase.funding) expect(rowOf(w, funding.wallet)[0]).toBe(funding.wallet);
    expect(w.node.submitted).toEqual([]);
  });
  it('refuses the wallet of each key that no line funds as an external address, and pays a stranger', async () => {
    const w = await realWorld();
    const unfunded = realUseCase.keys.map((spec) => spec.name).filter((name) => name !== 'run' && !realUseCase.funding.some((funding) => funding.wallet === name));
    expect(unfunded).toEqual(['controller', 'provider', 'accountable-echo', 'guardian-echo', 'accountable-alfa', 'guardian-alfa', 'stock-reader-auth', 'stock-reader-delegation']);
    for (const name of unfunded) {
      w.writeGo({ tasks: ['fund'], external: [{ label: 'stand-in', address: w.keys.registry.addressOf(name), units: 10 }] });
      reset(w);
      expect(await run(w, '--submit', '--member', 'stand-in'), name).toBe(2);
      expect(w.screen.errorText, name).toContain(`is a wallet of the registry (the key ${name})`);
    }
    expect(w.node.submitted).toEqual([]);
    w.writeGo({ tasks: ['fund'], external: [{ label: 'stand-in', address: w.world.addressOf(90), units: 10 }] });
    reset(w);
    expect(await run(w, '--submit', '--member', 'stand-in')).toBe(0);
    expect(w.node.submitted).toHaveLength(1);
  });
});
