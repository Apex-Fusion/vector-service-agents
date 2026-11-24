// agents/prior-authorization-agent/test/serve/world.ts
// The world of the tests of the wiring and of the start. It joins the fixtures of the repository: the stub marketplace of the hire kit (a FakeChain, an indexer and a model supplier behind one fetch), the offline
// node of the fixture world of the co-sign route, and the key hashes of that world. `settingsOf` makes the settings of the wiring from an environment with the readers of src/serve/settings.ts and the key
// material of src/serve/keys.ts, so that a test of the wiring needs no start. `setup` wires the service over the world, and it records which key each call of a chain came from. No test uses the network.
import { buyerVaultDeployment } from '@vsa/buyer-core';
import type { VaultChain } from '@vsa/buyer-core';
import { ALLOWLIST, INDEXER, LLM_ADVERT, marketplace, vaultChainWith } from '@vsa/hire-kit/testing';
import type { Marketplace } from '@vsa/hire-kit/testing';
import type { Clock } from '@vsa/usecase-kit/access';
import type { ModelLimits } from '@vsa/usecase-kit/decision';
import type { Module1Provider } from '@vsa/usecase-kit/dispute';
import type { FakeClock } from '../../../../packages/usecase-kit/test/access/support.ts';
import { DELEG_A, liveDelegation, world as ledgerWorld } from '../../../../packages/usecase-kit/test/cosign/support.ts';
import { KEY_ROLES, keyOf } from '../../src/serve/keys.ts';
import type { KeyMaterial, KeyRole } from '../../src/serve/keys.ts';
import {
  agentDidOf, disputeOf, drafterDidOf, endpointsFromEnv, faultOf, handoffLimitsOf, limitsOf, mockBasesOf, module1SourceOf, recordReaderDidOf, stateDirOf, supplierKeyOf,
} from '../../src/serve/settings.ts';
import { wire } from '../../src/serve/wiring.ts';
import type { Wired, WiringOptions, WiringSettings } from '../../src/serve/wiring.ts';
import { KEY_VARIABLES, startEnv, tempDir, withModule1 } from './support.ts';

/** The limits that fit the model advert of the stub marketplace exactly, as the decisions of the kit tests do. */
export const LIMITS: ModelLimits = {
  allowlist: ALLOWLIST, maxPriceLovelace: LLM_ADVERT.price_lovelace, maxSupplierBondLovelace: LLM_ADVERT.supplier_bond_lovelace, maxBuyerBondLovelace: LLM_ADVERT.buyer_bond_lovelace,
};

/** A clock that the sleep of a hire moves, over the clock of the stub marketplace. */
export const clockOf = (m: Marketplace): Clock => ({ now: () => m.clock.now, sleep: async (ms) => { m.clock.now += ms; } });

/** The settings of the wiring that an environment gives: each reader of the settings, and the key material of the seven keys. */
export function settingsOf(env: NodeJS.ProcessEnv): WiringSettings {
  const keys = Object.fromEntries(KEY_ROLES.map((role) => [role, keyOf(String(env[KEY_VARIABLES[role]]))])) as Record<KeyRole, KeyMaterial>;
  return {
    stateDir: stateDirOf(env), agentDid: agentDidOf(env), recordReaderDid: recordReaderDidOf(env), drafterDid: drafterDidOf(env), supplier: supplierKeyOf(env), keys, endpoints: endpointsFromEnv(env),
    mock: mockBasesOf(env), identityDeployment: buyerVaultDeployment(env), modelLimits: limitsOf(env), handoffLimits: handoffLimitsOf(env), dispute: disputeOf(env), module1Manifest: module1SourceOf(env),
    fault: faultOf(env),
  };
}

export interface SetupOptions {
  /** Settings of the environment that replace those of `startEnv`. */
  readonly env?: NodeJS.ProcessEnv;
  /** Members of the settings of the wiring that replace those that the environment gives. */
  readonly settings?: Partial<WiringSettings>;
  readonly options?: Partial<WiringOptions>;
  readonly provider?: Module1Provider;
  /** The fetch of the wiring, made from the fetch of the stub marketplace. The default answers the address of the Module-1 manifest in front of it. */
  readonly fetch?: (next: typeof fetch) => typeof fetch;
}

export interface Setup {
  readonly m: Marketplace;
  readonly dir: string;
  readonly settings: WiringSettings;
  readonly wired: Wired;
  readonly log: string[];
  /** The key hash of each chain that the wiring asked for, in order. */
  readonly made: string[];
  /** Every call that a chain of the service made, with the hash of the key of that chain. */
  readonly used: Array<{ readonly pkh: string; readonly method: string }>;
}

/**
 * The wiring over the world: the chain of each key is the FakeChain of the stub marketplace with the wallet of that key, and the node is the offline node of the fixture world, which shows one delegation that
 * names the first delegation key. The model limits are those that fit the model advert of the stub marketplace.
 */
export async function setup(over: SetupOptions = {}): Promise<Setup> {
  const m = marketplace();
  const dir = tempDir();
  const settings: WiringSettings = { ...settingsOf(startEnv({ PRIORAUTH_STATE_DIR: dir, VECTOR_MARKETPLACE_INDEXER_URL: INDEXER, ...over.env })), modelLimits: LIMITS, ...over.settings };
  const log: string[] = [];
  const made: string[] = [];
  const used: Array<{ readonly pkh: string; readonly method: string }> = [];
  const wired = await wire(settings, {
    fetchImpl: (over.fetch ?? withModule1)(m.fetchImpl), clock: clockOf(m), log: (line) => { log.push(line); }, provider: over.provider ?? ledgerWorld([liveDelegation(DELEG_A.keyHash)]), tipSlot: async () => 0,
    createChain: async (options) => {
      const pkh = keyOf(options.privateKeyHex).pkh;
      made.push(pkh);
      const chain = vaultChainWith(m, { wallet: async () => ({ ...(await m.chain.wallet()), buyerPkh: pkh }) });
      // The chain that the service gets records each call with the key hash of its key, so a test reads which key paid.
      return Object.fromEntries(Object.entries(chain).map(([method, member]) => [method, typeof member === 'function' ? (...args: unknown[]) => { used.push({ pkh, method }); return (member as (...call: unknown[]) => unknown)(...args); } : member])) as VaultChain;
    },
    ...over.options,
  });
  return { m, dir, settings, wired, log, made, used };
}

/**
 * Moves the fake clock of a run while `work` goes on over real I/O (the files of the state directory, a socket): a step of real time lets the I/O end, and then the time moves by half a second. The clock
 * of the access tests moves only when a test moves it, and its own `run` gives the I/O no real time.
 */
export async function drive<T>(clock: FakeClock, work: Promise<T>): Promise<T> {
  let done = false;
  work.then(() => { done = true; }, () => { done = true; });
  for (let step = 0; !done; step += 1) {
    if (step > 200_000) throw new Error('the run did not end');
    await new Promise<void>((resolve) => { setTimeout(resolve, 2); });
    if (!done && clock.waiting > 0) await clock.advance(500);
  }
  return work;
}
