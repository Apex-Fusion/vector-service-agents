// scripts/operator/lib/plan.ts - the plan of a step, written with the names of the registry. The guards of the checks judge a transaction against a `StepPlan`, and a plan holds key hashes. A task
// names the keys (`run`, `fee`, `reorder-service`), and `planOf` turns each name into the hash of that key. The limits of the fee and of the collateral come from the settings of the run, so no
// task sets them. A plan that names no mint says `mint: {}`: the guard `mint` needs the plan to equal the bytes, and an absent mint would leave it open.
import type { StepPlan } from '../../checks/lib/guards.ts';
import type { LandHost } from './contract.ts';

/** What a step names. Everything is optional: a step plans nothing that it does not say. */
export interface PlanOver {
  /** What may leave the wallet of each key, in lovelace, by registry NAME. A wallet that is not named may only gain. */
  readonly outflow?: Readonly<Record<string, bigint>>;
  /** The addresses, besides the wallets of the registry, that an output may go to. */
  readonly destinations?: Iterable<string>;
  /** Exactly what the transaction mints (positive) and burns (negative), by unit. */
  readonly mint?: Readonly<Record<string, bigint>>;
  /** How many withdrawals the transaction has (the consent of a Module-1 party is one). */
  readonly withdrawals?: number;
  /** The references of the outputs that the state file explains: the transaction may spend them. */
  readonly explained?: Iterable<string>;
  /** Words for an address, for the summary. */
  readonly labels?: Readonly<Record<string, string>>;
  readonly vault?: StepPlan['vault'];
}

/** A limit is a bigint that is not below 0: a number, a negative value or another type is an error and never a limit. */
function limit(value: unknown, what: string): bigint {
  if (typeof value !== 'bigint' || value < 0n) throw new Error(`planOf: ${what} must be a bigint that is not below 0`);
  return value;
}

/**
 * The plan of a step. The names of `over.outflow` must be keys of the registry of the host (an unknown name throws). The fee limit and the collateral limit are those of `host.settings`.
 * Each call makes a new plan that shares nothing with `over`.
 */
export function planOf(host: Pick<LandHost, 'registry' | 'settings'>, over: PlanOver = {}): StepPlan {
  const maxOutflow: Record<string, bigint> = {};
  for (const [name, amount] of Object.entries(over.outflow ?? {})) maxOutflow[host.registry.hashOf(name)] = limit(amount, `the outflow of ${name}`);
  const mint: Record<string, bigint> = {};
  for (const [unit, quantity] of Object.entries(over.mint ?? {})) {
    if (typeof quantity !== 'bigint') throw new Error('planOf: each quantity of the mint must be a bigint');
    mint[unit] = quantity;
  }
  if (over.withdrawals !== undefined && (!Number.isSafeInteger(over.withdrawals) || over.withdrawals < 0)) throw new Error('planOf: withdrawals must be a whole number that is not below 0');
  return {
    maxFeeLovelace: limit(host.settings.maxFeeLovelace, 'the fee limit of the settings'),
    maxCollateralLossLovelace: limit(host.settings.maxCollateralLossLovelace, 'the collateral limit of the settings'),
    maxOutflow,
    explained: new Set(over.explained ?? []),
    destinations: new Set(over.destinations ?? []),
    mint,
    ...(over.labels === undefined ? {} : { labels: { ...over.labels } }),
    ...(over.withdrawals === undefined ? {} : { withdrawals: over.withdrawals }),
    ...(over.vault === undefined ? {} : { vault: { ...over.vault } }),
  };
}
