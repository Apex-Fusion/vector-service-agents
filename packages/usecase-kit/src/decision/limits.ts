// packages/usecase-kit/src/decision/limits.ts
// The limits of a model hire. Every limit is a required parameter of `decide`. This code never fills in a missing limit and never passes `null` by itself: a limit that is not given is a type error
// at compile time and a refusal at run time. A limit has the type that hire-kit gives it. A wrong type is a refusal and never "no limit".
//
//   allowlist                the models that the agent may hire. It comes from the setting LLM_MODEL_ALLOWLIST.
//   maxPriceLovelace         the most that the price of the advert may be. It comes from the setting LLM_MAX_PRICE_LOVELACE. It has no `null`: the price ceiling is always set.
//   maxSupplierBondLovelace  the most that the supplier bond of the advert may be. A bigint, or `null` when the caller sets no limit.
//   maxBuyerBondLovelace     the most that the buyer bond of the advert may be. A bigint, or `null` when the caller sets no limit.
//
// The price ceiling does not bound what a hire pays. The buyer funds the price and both bonds at the Post, and an Accept pays the supplier the price and the supplier bond. So each bond has a
// limit of its own. A model that is not on the allowlist, a price above the ceiling and a bond above its limit are never hired: hire-kit refuses the advert before the Post.
//
// `checkLimits` reads each member of the limits one time, as data, and returns a new frozen object. `decide` uses that copy and never the caller's object again, so a caller that changes its
// limits or its list while a decision waits for its turn does not change the limits of that decision.
import type { ModelRequest } from '@vsa/hire-kit';
import { accepted, isModelName, refused, type ProtocolResult } from '../protocol/index.ts';

/** The name of the setting that holds the models that an agent may hire: a comma-separated list. */
export const LLM_MODEL_ALLOWLIST_SETTING = 'LLM_MODEL_ALLOWLIST';
/** The name of the setting that holds the most that a model hire may be priced at, in lovelace. */
export const LLM_MAX_PRICE_SETTING = 'LLM_MAX_PRICE_LOVELACE';

/** The four limits of a model hire, with the types of the request of `hireModel`. All four are required. */
export type ModelLimits = Readonly<Pick<ModelRequest, 'allowlist' | 'maxPriceLovelace' | 'maxSupplierBondLovelace' | 'maxBuyerBondLovelace'>>;

/** The form of a model name in words, for a detail. `isModelName` of the protocol checks the form. */
const MODEL_FORM = 'letters, digits, dots, underscores, colons, slashes and hyphens';

/** What a value is, in words, for a detail. It never repeats the value. */
function kindOf(value: unknown): string {
  if (value === undefined) return 'missing';
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'a list';
  switch (typeof value) {
    case 'string': return 'a text';
    case 'number': return 'a number';
    case 'boolean': return 'a boolean';
    case 'bigint': return 'a bigint';
    case 'function': return 'a function';
    case 'symbol': return 'a symbol';
    default: return 'an object';
  }
}

/** A bound in lovelace: a bigint of at least 0, or `null` when `allowNull`. A number, a text, a missing value and `undefined` are refused. */
function bound(field: string, value: unknown, allowNull: boolean): ProtocolResult<bigint | null, 'bad_limit'> {
  if (typeof value === 'bigint') return value >= 0n ? accepted(value) : refused('bad_limit', `${field} must not be below 0`);
  if (value === null && allowNull) return accepted(null);
  return refused('bad_limit', `${field} must be a bigint${allowNull ? ' or null' : ''}, and it is ${kindOf(value)}`);
}

/** The list of models: at least one name, each of the form of a model name. Each entry is read one time. */
function names(value: unknown): ProtocolResult<readonly string[], 'bad_limit'> {
  if (!Array.isArray(value)) return refused('bad_limit', `limits.allowlist must be a list of model names, and it is ${kindOf(value)}`);
  const list: string[] = [];
  try {
    for (let index = 0; index < value.length; index += 1) {
      const name: unknown = value[index];
      if (!isModelName(name)) {
        return refused('bad_limit', `limits.allowlist entry ${index + 1} must be a model name (${MODEL_FORM}), and it is ${typeof name === 'string' ? 'a text of another form' : kindOf(name)}`);
      }
      list.push(name);
    }
  } catch {
    return refused('bad_limit', 'limits.allowlist cannot be read');
  }
  return list.length === 0 ? refused('bad_limit', 'limits.allowlist must name at least one model') : accepted(list);
}

/**
 * The limits as a new frozen object, or a refusal that names the limit that is wrong. It never throws and never repeats a value. A limit that is missing is refused, so is one with a wrong type,
 * and so is a bound below 0. `maxPriceLovelace` takes no `null`. The two bonds take `null`, and a caller writes it on purpose when it sets no limit.
 */
export function checkLimits(limits: unknown): ProtocolResult<ModelLimits, 'bad_limit'> {
  let allowlist: unknown;
  let maxPrice: unknown;
  let maxSupplierBond: unknown;
  let maxBuyerBond: unknown;
  try {
    if (typeof limits !== 'object' || limits === null || Array.isArray(limits)) return refused('bad_limit', `limits must be an object, and it is ${kindOf(limits)}`);
    ({ allowlist, maxPriceLovelace: maxPrice, maxSupplierBondLovelace: maxSupplierBond, maxBuyerBondLovelace: maxBuyerBond } = limits as Record<string, unknown>);
  } catch {
    return refused('bad_limit', 'limits cannot be read');
  }
  const models = names(allowlist);
  if (!models.ok) return models;
  const price = bound('limits.maxPriceLovelace', maxPrice, false);
  if (!price.ok) return price;
  const supplierBond = bound('limits.maxSupplierBondLovelace', maxSupplierBond, true);
  if (!supplierBond.ok) return supplierBond;
  const buyerBond = bound('limits.maxBuyerBondLovelace', maxBuyerBond, true);
  if (!buyerBond.ok) return buyerBond;
  return accepted(Object.freeze({
    allowlist: Object.freeze(models.value),
    maxPriceLovelace: price.value as bigint,
    maxSupplierBondLovelace: supplierBond.value,
    maxBuyerBondLovelace: buyerBond.value,
  }));
}

/**
 * The models of the setting LLM_MODEL_ALLOWLIST: a comma-separated list, in the order of preference. Each entry loses the white space around it, and an empty entry is dropped. At least one
 * model must be left. There is no default: an agent that does not set the list does not hire. The refusal names the position of an entry that is wrong and never repeats it.
 */
export function parseModelAllowlist(value: unknown): ProtocolResult<readonly string[], 'bad_limit'> {
  if (typeof value !== 'string') return refused('bad_limit', `${LLM_MODEL_ALLOWLIST_SETTING} must be a text, and it is ${kindOf(value)}`);
  const models = value.split(',').map((name) => name.trim()).filter((name) => name !== '');
  if (models.length === 0) return refused('bad_limit', `${LLM_MODEL_ALLOWLIST_SETTING} must name at least one model, as a comma-separated list`);
  const wrong = models.findIndex((name) => !isModelName(name));
  if (wrong !== -1) return refused('bad_limit', `${LLM_MODEL_ALLOWLIST_SETTING} entry ${wrong + 1} must be a model name (${MODEL_FORM})`);
  return accepted(models);
}

/**
 * The price ceiling of the setting LLM_MAX_PRICE_LOVELACE: a whole number of lovelace of at least 0, written in digits, with at most 9007199254740991 as its value. There is no default: an agent
 * that does not set the ceiling does not hire. The refusal never repeats the text.
 */
export function parseMaxPrice(value: unknown): ProtocolResult<bigint, 'bad_limit'> {
  const text = typeof value === 'string' ? value.trim() : null;
  if (text === null || !/^[0-9]+$/.test(text) || !Number.isSafeInteger(Number(text))) {
    return refused('bad_limit', `${LLM_MAX_PRICE_SETTING} must be a whole number of lovelace of at least 0, written in digits`);
  }
  return accepted(BigInt(text));
}
