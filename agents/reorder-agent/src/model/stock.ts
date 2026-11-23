// agents/reorder-agent/src/model/stock.ts
// The stock reading that the buyer ERP gives for one SKU, and its hash. The six members and their number rules are the rules of the ERP of the mock service: a reading holds numbers, and a number
// is never a text. The purchase order holds the hash of the reading that the proposal rests on (`stock_reading_sha256`), so a hirer can compare the order with the reading that the model saw.
//
// The parser copies the members of its input with `readMembers` first, so that an accessor, a Proxy that throws and an object of another kind are refused before any member is read. It returns a new
// object with the members in a fixed order. It never throws. A detail names the member and the rule, and it never repeats a value.
import { accepted, canonicalSha256, checkMembers, readMembers, refused } from '@vsa/usecase-kit/protocol';
import type { Digest, ProtocolResult } from '@vsa/usecase-kit/protocol';
import { SKU_RULE, isSku } from './intake.ts';

/**
 * What the ERP knows of one SKU: the stock now (`on_hand`), the stock level at which the SKU is reordered (`threshold`), the use each day (`daily_usage`, a number that can have a fraction), the days
 * from an order to its arrival (`lead_time_days`) and the orders that are still open (`open_orders`). It is a type alias, so that it is JSON data.
 */
export type StockReading = {
  readonly sku: string;
  readonly on_hand: number;
  readonly threshold: number;
  readonly daily_usage: number;
  readonly lead_time_days: number;
  readonly open_orders: number;
};

const MEMBERS = ['sku', 'on_hand', 'threshold', 'daily_usage', 'lead_time_days', 'open_orders'] as const;

/** The most that the ERP takes for a stock, a threshold, a use each day and a count of open orders. */
const MAX_STOCK = 10_000_000;
/** The most days that the ERP takes for a lead time. */
const MAX_LEAD_TIME_DAYS = 365;

/** A whole number from 0 to `max`. A text, a fraction, a negative number and a number that a double cannot hold exactly are refused. */
function whole(value: unknown, field: string, max: number): ProtocolResult<number> {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= max
    ? accepted(value)
    : refused('bad_shape', `${field} must be a whole number from 0 to ${max}`);
}

/** A finite number from 0 to `max`. A text, NaN, an infinite number and a negative number are refused. */
function amount(value: unknown, field: string, max: number): ProtocolResult<number> {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= max
    ? accepted(value)
    : refused('bad_shape', `${field} must be a number from 0 to ${max}`);
}

/** The reading of the ERP as a new object, or a refusal with the code `bad_shape`. */
export function parseStockReading(value: unknown): ProtocolResult<StockReading> {
  const field = 'stock reading';
  const read = readMembers(value, field);
  if (!read.ok) return read;
  const members = checkMembers(read.value, field, MEMBERS);
  if (members !== null) return members;
  const given = read.value;
  if (!isSku(given.sku)) return refused('bad_shape', `${field}.sku must be ${SKU_RULE}`);
  const onHand = whole(given.on_hand, `${field}.on_hand`, MAX_STOCK);
  if (!onHand.ok) return onHand;
  const threshold = whole(given.threshold, `${field}.threshold`, MAX_STOCK);
  if (!threshold.ok) return threshold;
  const dailyUsage = amount(given.daily_usage, `${field}.daily_usage`, MAX_STOCK);
  if (!dailyUsage.ok) return dailyUsage;
  const leadTime = whole(given.lead_time_days, `${field}.lead_time_days`, MAX_LEAD_TIME_DAYS);
  if (!leadTime.ok) return leadTime;
  const openOrders = whole(given.open_orders, `${field}.open_orders`, MAX_STOCK);
  if (!openOrders.ok) return openOrders;
  return accepted({
    sku: given.sku,
    on_hand: onHand.value,
    threshold: threshold.value,
    daily_usage: dailyUsage.value,
    lead_time_days: leadTime.value,
    open_orders: openOrders.value,
  });
}

/** The SHA-256 of the canonical text of a reading, with no salt: the keys in the order of their code units, no white space. It is `canonicalSha256` of the protocol. A value that JSON cannot hold is a refusal. */
export function stockReadingSha256(reading: StockReading): ProtocolResult<Digest> {
  return canonicalSha256(reading, 'stock reading');
}
