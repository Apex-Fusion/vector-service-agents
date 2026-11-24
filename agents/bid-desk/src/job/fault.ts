// agents/bid-desk/src/job/fault.ts
// The one fault of the Bid Desk: `quote_off_price_list`. A fault makes an agent do one wrong thing on purpose in a failure run, so that the Sourcing Agent and its checks can show how they answer. With this
// fault the Bid Desk sets the unit price of ONE line below the price that its published price list gives for that SKU and quantity. The first line that the list prices takes the price `listed - ceil(listed / 5)`,
// so it is a price of at least 1 and below the listed price. The totals follow the changed line, because the arithmetic runs after the fault.
//
// The fault changes WHAT the job sends, and never a check: no check of the Bid Desk takes a fault value, and the hook does not know that the fault exists. The fault is on for the value
// `quote_off_price_list` and for no other value. The empty setting, and any text that is not exactly that value, is a clean run. The job reads the value from the switch that the service made at its start
// (`readFaultSwitch` of the kit refuses every other value there), and nothing else turns the fault on: not the body of a request, not the context of a call, not the environment.
import { priceFor } from '@vsa/usecase-kit/bids';
import type { PriceList } from '@vsa/usecase-kit/bids';
import type { FaultSwitch } from '@vsa/usecase-kit/fault';
import type { FaultMode, FaultSetting } from '@vsa/usecase-kit/protocol';
import type { QuoteChoice } from './decision.ts';

/** The one fault value of the Bid Desk. The type holds it to a value that the kit lists for this kind of agent. */
const QUOTE_OFF_PRICE_LIST: FaultMode<'bid-desk'> = 'quote_off_price_list';

/** The four members of a line that the model chooses. */
type ChosenLine = QuoteChoice['lines'][number];

/**
 * The price that the fault gives a line: the listed price less a fifth of it, rounded up. A listed price below 2 has no lower whole price, and a price that is not a whole number is no listed price: both are a
 * `RangeError`. The message never repeats the value.
 */
export function faultyPriceOf(listed: number): number {
  if (!Number.isSafeInteger(listed) || listed < 2) throw new RangeError('the listed price must be a whole number of at least 2');
  return listed - Math.ceil(listed / 5);
}

/** What the job knows of the switch: the value that it read, and whether the fault is on. */
export interface FaultReading {
  readonly mode: FaultSetting<'bid-desk'>;
  readonly on: boolean;
}

/**
 * Reads the switch ONE time. The job uses the reading for the lines and for the quote, so a line and the result never come from two reads. The fault is on only when the value is exactly
 * `quote_off_price_list`.
 */
export function readFault(fault: FaultSwitch<'bid-desk'>): FaultReading {
  const mode = fault.mode;
  return Object.freeze({ mode, on: mode === QUOTE_OFF_PRICE_LIST });
}

/**
 * The lines that the job sends to the arithmetic: copies of the lines of the choice. With the fault off they are the lines as the model chose them, and the price list is not read. With the fault on, the first
 * line that the price list prices (`priceFor` for its SKU and quantity) gets the unit price `faultyPriceOf(listed)`, where `listed` is the price of the LIST and not the price of the model. No other line changes.
 * The result is null when the fault is on and it can change nothing: no line is priced by the list, or the first priced line has the price 1, which no lower whole price follows. A run never says that a fault
 * was on when it changed nothing. The choice that was given is not changed: the decision on record stays what the model said.
 */
export function pricedLines(on: boolean, lines: readonly ChosenLine[], list: PriceList): ChosenLine[] | null {
  const copies = lines.map((line) => ({ sku: line.sku, quantity: line.quantity, unit_price: line.unit_price, lead_time_days: line.lead_time_days }));
  if (!on) return copies;
  for (const line of copies) {
    const listed = priceFor(list, line.sku, line.quantity);
    if (listed === null) continue;
    if (listed.unit_price < 2) return null;
    line.unit_price = faultyPriceOf(listed.unit_price);
    return copies;
  }
  return null;
}
