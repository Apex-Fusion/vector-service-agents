// agents/bid-desk/test/job/decide-support.ts
// The marketplace of the hire kit in memory, and the deps of a decision: a FakeChain, an indexer and a model supplier behind one fetch, and a clock that the sleep of the hire moves. A test never waits for
// real time and never uses the network. The tests that use it run the decision `quote` through `decide` of the kit, as the service does.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PayingKeys } from '@vsa/hire-kit';
import type { HireLedger } from '@vsa/hire-kit';
import { ALLOWLIST, INDEXER, LLM_ADVERT, T0, marketplace } from '@vsa/hire-kit/testing';
import type { Marketplace } from '@vsa/hire-kit/testing';
import type { DecisionDeps, ModelLimits } from '@vsa/usecase-kit/decision';

/** The limits that fit the model advert of the stub marketplace exactly: each is AT the value of the advert. */
const LIMITS: ModelLimits = {
  allowlist: ALLOWLIST,
  maxPriceLovelace: LLM_ADVERT.price_lovelace,
  maxSupplierBondLovelace: LLM_ADVERT.supplier_bond_lovelace,
  maxBuyerBondLovelace: LLM_ADVERT.buyer_bond_lovelace,
};

const dirs: string[] = [];

/** Removes the state directories of the paying keys. The test file calls it in `afterEach`. */
export function cleanup(): void {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}

export interface Run {
  readonly m: Marketplace;
  readonly deps: DecisionDeps;
}

/** A marketplace, the paying key of its chain, and the deps of a decision. */
export async function setup(): Promise<Run> {
  const m = marketplace();
  const dir = mkdtempSync(join(tmpdir(), 'bid-desk-job-'));
  dirs.push(dir);
  const key = await new PayingKeys(dir).add(m.chain);
  const ledger: HireLedger = { posted: () => undefined, accepted: () => undefined };
  const deps: DecisionDeps = { key, limits: LIMITS, clock: () => m.clock.now, sleep: async (ms) => { m.clock.now += ms; }, deadlineMs: T0 + 1_000_000, fetchImpl: m.fetchImpl, indexerUrl: INDEXER, ledger };
  return { m, deps };
}

/** The text that a model gives: one JSON object with the reasoning and the choice. */
export const said = (choice: unknown, reasoning = 'The price list gives the unit price of the break of each item.'): string => JSON.stringify({ reasoning, choice });

/** The prompts that the model supplier received, in order. A hire sends `{ input }` and nothing else. */
export function promptsSent(run: Run): string[] {
  return run.m.llm.sends.map((send) => {
    const body: unknown = JSON.parse(send.body);
    if (typeof body !== 'object' || body === null || !('input' in body) || typeof body.input !== 'string') throw new Error('the model supplier received a body that is not { input }');
    return body.input;
  });
}
