// The harness of the tests of the checks: a world, a node over it, key files with mode 600 in a folder of its own, the settings of a run, and the dependencies that the runner takes.
// A test runs a check through `run`, and reads the screen, the state file, the evidence file and the world afterwards.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll } from 'vitest';
import { decodeVaultDatum, lucidForAddress } from '../../lib/platform.ts';
import type { HostedTools } from '../../lib/hosted.ts';
import { runCheck } from '../../lib/runner.ts';
import type { CheckDefinition, RunDeps } from '../../lib/runner.ts';
import type { ChainAccess } from '../../lib/session.ts';
import { FakeClock, FakeNode, MemoryOutput } from './fakes.ts';
import { AGENT_N, CONTROLLER_N, DEPLOYMENT, MEMBER_N, NOW, RECORD_DID, World, writeKeyFile } from './world.ts';

const roots: string[] = [];
afterAll(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

/** The parts of a state file that the tests read. */
export interface StateView {
  steps: Record<string, { confirmed_at: string; tx_hash: string | null; refs: Record<string, string>; facts: Record<string, unknown>; verified_at: string | null }>;
  in_flight: { step: string; tx_hash: string } | null;
  notes: Record<string, unknown>;
}

export interface Harness {
  world: World;
  node: FakeNode;
  clock: FakeClock;
  screen: MemoryOutput;
  dir: string;
  env: Record<string, string>;
  chain: ChainAccess;
  /** The folder of the state file and the evidence file of the run. */
  stateDir: string;
  run<Extra>(def: CheckDefinition<Extra>, ...argv: string[]): Promise<number>;
  deps(over?: Partial<RunDeps>): RunDeps;
  state(check: string): StateView;
  evidence(check: string): Array<Record<string, unknown>>;
}

export async function harness(over: {
  world?: World; env?: Record<string, string | undefined>; hosted?: HostedTools; fetchImpl?: typeof fetch; clock?: FakeClock;
  /** The `fetch` and the Koios address that the builders and the reads of the escrow use. Without them a read of the network ends the test. */
  chainFetch?: typeof fetch; koiosUrl?: string;
} = {}): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'checks-run-'));
  roots.push(dir);
  const world = over.world ?? await World.identity();
  const node = new FakeNode(world);
  const clock = over.clock ?? new FakeClock(NOW);
  const screen = new MemoryOutput();
  const keyFiles = {
    CHECKS_CONTROLLER_KEY_FILE: writeKeyFile(dir, CONTROLLER_N, 'controller', 'hex'),
    CHECKS_AGENT_KEY_FILE: writeKeyFile(dir, AGENT_N, 'agent', 'bech32'),
    CHECKS_MEMBER_KEY_FILE: writeKeyFile(dir, MEMBER_N, 'member', 'named'),
  };
  const stateDir = join(dir, 'state');
  const env = { CHECKS_NETWORK: 'vector-mainnet', CHECKS_RECORD: RECORD_DID, CHECKS_STATE_DIR: stateDir, ...keyFiles, ...over.env } as Record<string, string>;
  const chain: ChainAccess = {
    provider: world.chain, deployment: DEPLOYMENT, koiosUrl: over.koiosUrl ?? 'https://koios.test', fetchImpl: over.chainFetch ?? ((async () => { throw new Error('the network was touched'); }) as typeof fetch),
    context: async (address) => ({ lucid: await lucidForAddress(world.chain, address), provider: world.chain, deployment: DEPLOYMENT }),
    liveVaultsOf: async (delegation) => world.chain.held.flatMap((u) => {
      if (u.address !== DEPLOYMENT.vault.address || u.datum === undefined || u.datum === null) return [];
      try {
        const vault = decodeVaultDatum(u.datum);
        return vault.type === 'Live' && vault.delegation === delegation ? [{ ref: `${u.txHash}#${u.outputIndex}`, lovelace: u.assets.lovelace ?? 0n }] : [];
      } catch {
        return [];
      }
    }),
  };
  const hosted: HostedTools = over.hosted ?? { call: async (name) => { throw new Error(`the hosted tool ${name} was called, and the test gave none`); } };
  const deps = (more: Partial<RunDeps> = {}): RunDeps => ({ env, out: screen, clock, node, chain, hosted, awaitMs: 20_000, pollMs: 5_000, fetchImpl: over.fetchImpl ?? chain.fetchImpl, ...more });
  const jsonOf = (name: string): unknown => JSON.parse(readFileSync(join(stateDir, name), 'utf8'));
  return {
    world, node, clock, screen, dir, env, chain, stateDir, deps,
    run: (def, ...argv) => runCheck(def, argv, deps()),
    state: (check) => jsonOf(`${check}.state.json`) as StateView,
    evidence: (check) => (jsonOf(`${check}.evidence.json`) as { entries: Array<Record<string, unknown>> }).entries,
  };
}
