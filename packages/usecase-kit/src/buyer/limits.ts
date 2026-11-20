// packages/usecase-kit/src/buyer/limits.ts
// The three limits of a hire. The buyer funds the price and both bonds at the Pay, so the price limit alone does not bound what a hire pays. Each limit is a bigint, or `null` when the
// caller chooses no limit. The caller reads the limits from the settings of the agent and gives all three. This folder never fills in a limit that is missing, and it never passes `null`
// by itself. A limit of another type is a settings error, and it is never read as "no limit".
import { accepted, refused } from '@vsa/usecase-kit/protocol';
import type { ProtocolResult } from '@vsa/usecase-kit/protocol';

/** The limits of one hire, in lovelace. The names and the types are those of the hire kit. */
export interface HireLimits {
  /** The most that the price of the advert may be. */
  readonly maxPriceLovelace: bigint | null;
  /** The most that the supplier bond of the advert may be. An Accept pays this bond to the counterparty. */
  readonly maxSupplierBondLovelace: bigint | null;
  /** The most that the buyer bond of the advert may be. It returns to the vault at an Accept. */
  readonly maxBuyerBondLovelace: bigint | null;
}

/** The names of the three limits, in the order of the hire kit. */
export const LIMIT_NAMES = ['maxPriceLovelace', 'maxSupplierBondLovelace', 'maxBuyerBondLovelace'] as const satisfies readonly (keyof HireLimits)[];

/** What a value is, in words and with no part of the value: a limit of a wrong type is named by its type only. */
function kindOf(value: unknown): string {
  if (value === undefined) return 'missing';
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'a list';
  const kinds: Readonly<Record<string, string>> = { number: 'a number', string: 'a text', boolean: 'a boolean', object: 'an object', function: 'a function', symbol: 'a symbol', bigint: 'a bigint' };
  return kinds[typeof value] ?? `a ${typeof value}`;
}

/**
 * The three limits as a new object, or a refusal that names the first limit that is wrong. A limit is a bigint of at least 0, or `null`. A number, a text, `undefined` and a missing member
 * are refused: a missing limit would count as no limit at all. Each member is read one time, and the result holds the values that were checked.
 */
export function checkLimits(limits: unknown): ProtocolResult<HireLimits, 'bad_limit'> {
  if (limits === null || typeof limits !== 'object' || Array.isArray(limits)) return refused('bad_limit', 'the limits must be an object with the three limits of a hire');
  const found: Record<string, bigint | null> = {};
  for (const name of LIMIT_NAMES) {
    const value: unknown = Reflect.get(limits, name);
    if (value === null) {
      found[name] = null;
    } else if (typeof value === 'bigint') {
      if (value < 0n) return refused('bad_limit', `${name} must be a bigint of at least 0, or null`);
      found[name] = value;
    } else {
      return refused('bad_limit', `${name} must be a bigint or null, and it is ${kindOf(value)}`);
    }
  }
  return accepted({ maxPriceLovelace: found.maxPriceLovelace ?? null, maxSupplierBondLovelace: found.maxSupplierBondLovelace ?? null, maxBuyerBondLovelace: found.maxBuyerBondLovelace ?? null });
}
