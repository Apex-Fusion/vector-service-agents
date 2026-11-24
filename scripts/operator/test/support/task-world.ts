// The world of the tests of a task and of the runner. One call makes a world of wallets for the keys of a test registry (made at run time), a node over it, a clock that moves when it sleeps,
// a screen, a state folder, and the environment and the dependencies that `runTask` takes. A test runs a task through `run`, then reads the screen, the machine line, the state, the evidence, the
// facts and the approval afterwards. No test of the pack here opens a network connection: the `fetch` of the world refuses, and the hosted tools of the world refuse until a test gives others.
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll } from 'vitest';
import { iso } from '../../../checks/lib/format.ts';
import { recordLanded } from '../../../checks/lib/inflight.ts';
import type { HostedTools } from '../../../checks/lib/hosted.ts';
import type { LandIo, LandRequest } from '../../../checks/lib/land.ts';
import { lucidForAddress } from '../../../checks/lib/platform.ts';
import type { NetworkFacts, TxStatus } from '../../../checks/lib/ports.ts';
import { commitStep, landFor } from '../../../checks/lib/session.ts';
import type { ChainAccess } from '../../../checks/lib/session.ts';
import { factsOf } from '../../../checks/lib/txfacts.ts';
import { DEPLOYMENT, NOW } from '../../../checks/test/support/world.ts';
import type { GoFile } from '../../lib/approval.ts';
import type { Facts, TaskDefinition, UseCase } from '../../lib/contract.ts';
import { FactsFile } from '../../lib/facts.ts';
import { runSteps, runTask } from '../../lib/runner.ts';
import type { CliDeps, StepHandler } from '../../lib/runner.ts';
import { FakeClock, FakeNode, MemoryOutput, World } from './fakes.ts';
import { makeTestKeys, removeTestKeys } from './keys.ts';
import type { TestKeys } from './keys.ts';

export { NOW };
export const HOUR = 3_600_000;
export const USE_CASE = 'inventory-reorder';
export const PREFIX = 'operator-result: ';

const roots: string[] = [];
afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  removeTestKeys();
});

/** A hash made of a text: 64 lower-case hex characters, the same each time. */
export const hashOf = (text: string): string => createHash('sha256').update(`operator test ${text}`).digest('hex');

/** A node over the world that answers the status of a transaction from a list first, counts the reads, and counts the questions about its network. */
export class ScriptedNode extends FakeNode {
  /** The hashes that a status was read for, in order. */
  readonly reads: string[] = [];
  /** The next answers of `txStatus`: a status, or an error to throw. When the list is empty the node answers as a FakeNode does. */
  readonly script: Array<TxStatus | Error> = [];
  networkReads = 0;

  override async networkFacts(): Promise<NetworkFacts> {
    this.networkReads += 1;
    return super.networkFacts();
  }

  override async txStatus(txHash: string): Promise<TxStatus> {
    this.reads.push(txHash);
    const next = this.script.shift();
    if (next instanceof Error) throw next;
    return next ?? super.txStatus(txHash);
  }
}

/** The parts of a state file that the tests read. */
export interface StateView {
  steps: Record<string, { confirmed_at: string; tx_hash: string | null; refs: Record<string, string>; facts: Record<string, unknown>; verified_at: string | null }>;
  in_flight: { step: string; tx_hash: string; signed_cbor: string; valid_to: number; signed_at: number; refs: Record<string, string>; facts: Record<string, unknown> } | null;
  notes: Record<string, unknown>;
  record: string;
  check: string;
}

/** The machine line of a run, read back. */
export interface MachineLine { task: string | null; command: string | null; mode: string | null; outcome: string; exit: number; step: string | null; result: Record<string, unknown> }

export interface TaskWorldOptions {
  /** The names of the keys of the registry. The default is `run`, `fee` and `service`. */
  keys?: readonly string[];
  /** The names of the keys that have the scope shared. The default is `run` and `fee`. */
  shared?: readonly string[];
  /** The outputs of the wallet of each key, in lovelace. The default gives `run` and `fee` 1,000 units and one pure output of 5 units for collateral. */
  wallets?: Readonly<Record<string, readonly bigint[]>>;
  /**
   * Members that replace the members of the use case of the world. A test of a task that needs the real data gives the use case of the pack here, and gives `keys` (the names) and `shared` (the
   * names with the scope shared) of that use case too, so that the key files and the registry match its list of keys.
   */
  use?: Partial<UseCase>;
  env?: Readonly<Record<string, string | undefined>>;
  hosted?: HostedTools;
  fetchImpl?: typeof fetch;
}

export interface TaskWorld {
  readonly dir: string;
  readonly stateDir: string;
  readonly goPath: string;
  readonly keys: TestKeys;
  readonly use: UseCase;
  readonly world: World;
  readonly node: ScriptedNode;
  readonly clock: FakeClock;
  readonly screen: MemoryOutput;
  readonly chain: ChainAccess;
  readonly env: Record<string, string | undefined>;
  /** The dependencies of `runTask` and `runCli` for this world. The use case is the one of the world, the registry is read from the key files, and the waits are short. */
  deps(over?: Partial<CliDeps>): CliDeps;
  /** Runs a task through the real runner and gives the exit code. */
  run<Extra>(def: TaskDefinition<Extra>, ...argv: string[]): Promise<number>;
  state(task: string, run?: string): StateView;
  evidence(task: string, run?: string): Array<Record<string, unknown>>;
  facts(): Readonly<Facts>;
  /** Writes the approval file of the world (mode 600) and gives its path. A member of `over` replaces the member of the default, which names the task `toy`, the wallet of the key `run` and a cap of 100 units. */
  writeGo(over?: Partial<GoFile>): string;
  /** The path of the run lock file of the state folder. */
  readonly lockPath: string;
  /** The reserves of the cap file of a session (the session `s1` by default), or an empty list when the file is not there. */
  exposure(session?: string): Array<{ step: string; tx_hash: string; net_lovelace: string; at: string }>;
  /** The machine line that the run printed last, parsed. It fails when the last line of the screen is not a machine line. */
  machine(): MachineLine;
  /** Everything that a run wrote that a person can read: the lines of the screen, its errors, and each file of the state folder. A test looks for a seed in it. */
  allText(): string;
}

const REFUSING_FETCH = (async () => { throw new Error('the network was touched'); }) as typeof fetch;

/** The use case of a world: the keys of the registry and a funding line for the wallets that need collateral. */
export function fakeUseCase(keys: TestKeys, over: Partial<UseCase> = {}): UseCase {
  return {
    name: USE_CASE, title: 'A use case of the tests', keys: keys.specs, organisations: [], agents: [], subagents: [],
    funding: ['run', 'fee'].filter((name) => keys.specs.some((spec) => spec.name === name)).map((wallet) => ({ wallet, collateralLovelace: 5_000_000n, floatLovelace: 0n, items: [] })),
    attestations: [], runs: [], evidenceSteps: [], moduleManifestPath: 'Module-1/deploy/manifest.json', runtimeCommit: 'main', ...over,
  };
}

export async function taskWorld(options: TaskWorldOptions = {}): Promise<TaskWorld> {
  const names = options.keys ?? ['run', 'fee', 'service'];
  const keys = makeTestKeys(names, { useCase: USE_CASE, shared: options.shared ?? ['run', 'fee'].filter((name) => names.includes(name)) });
  const use = fakeUseCase(keys, options.use);
  const dir = mkdtempSync(join(tmpdir(), 'operator-world-'));
  roots.push(dir);
  const wallets = options.wallets ?? Object.fromEntries(['run', 'fee'].filter((name) => names.includes(name)).map((name) => [name, [1_000_000_000n, 5_000_000n]]));
  const utxos = Object.entries(wallets).flatMap(([name, amounts]) => amounts.map((lovelace, outputIndex) => ({
    txHash: hashOf(`wallet ${name}`), outputIndex, address: keys.registry.addressOf(name), assets: { lovelace },
  })));
  const world = await World.create([], utxos);
  const node = new ScriptedNode(world);
  const clock = new FakeClock(NOW);
  const screen = new MemoryOutput();
  const stateDir = join(dir, 'state');
  const goPath = join(stateDir, 'GO.json');
  const env: Record<string, string | undefined> = { OPERATOR_KEYS_DIR: keys.root, OPERATOR_STATE_DIR: stateDir, OPERATOR_USE_CASE: USE_CASE, ...options.env };
  const fetchImpl = options.fetchImpl ?? REFUSING_FETCH;
  const chain: ChainAccess = {
    provider: world.chain, deployment: DEPLOYMENT, koiosUrl: 'https://koios.test', fetchImpl,
    context: async (address) => ({ lucid: await lucidForAddress(world.chain, address), provider: world.chain, deployment: DEPLOYMENT }),
    liveVaultsOf: async () => [],
  };
  const hosted: HostedTools = options.hosted ?? { call: async (name) => { throw new Error(`the hosted tool ${name} was called, and the test gave none`); } };
  const deps = (more: Partial<CliDeps> = {}): CliDeps => ({ env, out: screen, clock, node, chain, hosted, fetchImpl, loadUseCase: async () => use, awaitMs: 20_000, pollMs: 5_000, ...more });
  const base = (task: string, run?: string): string => join(stateDir, run === undefined ? task : `${task}.${run}`);
  return {
    dir, stateDir, goPath, keys, use, world, node, clock, screen, chain, env, deps,
    run: (def, ...argv) => runTask(def, argv, deps()),
    state: (task, run) => {
      const view: StateView = JSON.parse(readFileSync(`${base(task, run)}.state.json`, 'utf8'));
      return view;
    },
    evidence: (task, run) => {
      const document: { entries: Array<Record<string, unknown>> } = JSON.parse(readFileSync(`${base(task, run)}.evidence.json`, 'utf8'));
      return document.entries;
    },
    facts: () => FactsFile.open(join(stateDir, 'facts.json'), { useCase: USE_CASE, network: 'vector-mainnet' }).read(),
    lockPath: join(stateDir, 'run.lock'),
    exposure: (session = 's1') => {
      const path = join(stateDir, `exposure.${session}.json`);
      if (!existsSync(path)) return [];
      const document: { entries: Array<{ step: string; tx_hash: string; net_lovelace: string; at: string }> } = JSON.parse(readFileSync(path, 'utf8'));
      return document.entries;
    },
    writeGo: (over = {}) => {
      const go: GoFile = {
        approvedBy: 'the test operator', at: iso(NOW), session: 's1', runWallet: keys.registry.addressOf('run'), capUnits: 100, tasks: ['toy'], irreversible: [], expiresAt: iso(NOW + 6 * HOUR), ...over,
      };
      mkdirSync(stateDir, { recursive: true, mode: 0o700 });
      chmodSync(stateDir, 0o700);
      writeFileSync(goPath, `${JSON.stringify(go, null, 2)}\n`, { mode: 0o600 });
      chmodSync(goPath, 0o600);
      return goPath;
    },
    machine: () => {
      const last = screen.lines.at(-1);
      if (last === undefined || !last.startsWith(PREFIX)) throw new Error(`the last line of the screen is not a machine line: ${String(last)}`);
      const line: MachineLine = JSON.parse(last.slice(PREFIX.length));
      return line;
    },
    allText: () => {
      const files = readdirSync(stateDir).map((name) => { try { return readFileSync(join(stateDir, name), 'utf8'); } catch { return ''; } });
      return [...screen.lines, ...screen.errors, ...files].join('\n');
    },
  };
}

// ---- a toy task: steps that record themselves, steps that land a real payment, and the definition that runs them ----

/** A step that records itself in the state file as a landed step does, and lands nothing. `ran` gets its name each time it runs. */
export function recordingStep<Extra = unknown>(name: string, ran: string[], over: Partial<StepHandler<Extra>> = {}): StepHandler<Extra> {
  return {
    name,
    async run(session) {
      ran.push(name);
      if (session.mode === 'dry') return { kind: 'dry' };
      recordLanded(session.state, { step: name, tx_hash: hashOf(`step ${name}`), refs: {}, facts: {} }, session.clock.now());
      return { kind: 'done', message: `${name} is confirmed` };
    },
    ...over,
  };
}

/**
 * A step that lands a real payment of `lovelace` from the wallet of the key `from` to the wallet of the key `to`, with the landing of the checks: the guards, the signature of the registry ring,
 * the reserve of the cap before the submit, the state file, and the wait for the confirmation. It stands in for the landing helpers of the tasks.
 */
export function landingStep<Extra = unknown>(name: string, ran: string[], from: string, to: string, lovelace: bigint): StepHandler<Extra> {
  return {
    name,
    async run(session) {
      ran.push(name);
      const { lucid } = await session.chain.context(session.registry.addressOf(from));
      const built = await lucid.newTx().pay.ToAddress(session.registry.addressOf(to), { lovelace }).complete();
      const cbor = built.toCBOR();
      const facts = factsOf(cbor);
      const request: LandRequest = {
        step: name,
        built: { unsignedCbor: cbor, txHash: built.toHash(), feeLovelace: facts.feeLovelace, validTo: session.clock.now() + 30 * 60_000 },
        plan: {
          maxFeeLovelace: session.settings.maxFeeLovelace, maxOutflow: { [session.registry.hashOf(from)]: lovelace + facts.feeLovelace },
          maxCollateralLossLovelace: session.settings.maxCollateralLossLovelace, explained: new Set(), destinations: new Set(), mint: {},
        },
        refs: {}, facts: {},
      };
      const ring = session.registry.ring;
      const io: LandIo = {
        mode: session.mode, node: session.node, signer: ring, ring, network: session.network, out: (line) => session.out.out(line), clock: session.clock, awaitMs: session.awaitMs, pollMs: session.pollMs,
        inFlight: {
          // A payment between two wallets of the registry costs its fee, and the cap counts that.
          set: (record) => {
            session.exposure.reserve({ step: record.step, txHash: record.tx_hash, netLovelace: facts.feeLovelace, at: iso(session.clock.now()) });
            session.state.setInFlight(record);
          },
          clear: () => { session.state.clearInFlight(); },
        },
      };
      const landed = await landFor(io, session.evidence)(request);
      if (landed.kind === 'dry') return { kind: 'dry' };
      commitStep(session, request, landed, { moved: String(lovelace) });
      return { kind: 'done', message: `${name} is confirmed` };
    },
  };
}

/** The definition of a toy task over these steps. It needs the keys `run` and `fee`, the chain, and the approval for `--submit`. The tests change what they test with `over`. */
export function toyTask<Extra = unknown>(handlers: readonly StepHandler<Extra>[], over: Partial<TaskDefinition<Extra>> = {}): TaskDefinition<Extra> {
  return {
    name: 'toy', title: 'a toy task of two steps and a cleanup', flags: ['extra'], valued: ['label'],
    needs: { keys: () => ['run', 'fee'], chain: true, hosted: [], approval: 'submit' },
    steps: () => handlers.map((handler) => handler.name),
    parse: () => ({}) as Extra,
    next: (session) => runSteps(session, handlers),
    cleanup: async () => ({ kind: 'done', message: 'there is nothing to take back' }),
    ...over,
  };
}
