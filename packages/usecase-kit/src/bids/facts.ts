// packages/usecase-kit/src/bids/facts.ts
// The facts of the evidence of a quote challenge in use case 3 (supplier bid evaluation). The claim of a Bid Desk says that the unit price of every line of a quote is the price that its published price list
// gives for that SKU and quantity. The Sourcing Agent compares each line of a quote with the list (`lineChecks`). For the first line that breaks the claim, it builds these facts and passes them to the
// dispute folder, which writes the evidence document for the jurors.
//
// The facts exist only for a line that has a listed price and whose quoted unit price differs from it. A line with no listed price is no contradiction: the SKU is not in the list, so the claim says nothing
// about it. A line at the listed price is no contradiction either. A quoted price above the listed price breaks the claim as much as one below it. A value that is not a unit price (a whole number from 1 to
// 1,000,000, as in a price list and in a line of a quote) is never read as a price: a text is not the price that it spells, and a missing price is not a price of 0.
//
// The folder does not import the dispute folder. The result is a plain object with the members of `QuotePriceFacts` of that folder, and the test of this folder passes it to `evidenceDocument`. The
// dispute folder checks the form of the digests and of the other members when it writes the document.
import { accepted, isPlainObject, refused } from '../protocol/index.ts';
import type { Digest, ProtocolResult } from '../protocol/index.ts';
import { parseWhole } from './ids.ts';
import type { LineCheck } from './quote-rules.ts';

/** The highest unit price, as in a price list and in a line of a quote. A test holds this limit to the limits of the two. */
const MAX_UNIT_PRICE = 1_000_000;

/**
 * The facts of a quote challenge: the members of `QuotePriceFacts` of the dispute folder, in that order, and nothing else. `quote_sha256` is the hash that the signed receipt commits to for the quote, which
 * is the SHA-256 of the text of the delivery, and `price_list_sha256` is the hash of the price list that gave `listed_unit_price`.
 */
export interface PriceFacts {
  readonly kind: 'quote_price';
  readonly sku: string;
  readonly quantity: number;
  readonly quoted_unit_price: number;
  /** The unit price that the published price list gives for the SKU and the quantity. */
  readonly listed_unit_price: number;
  readonly price_list_sha256: Digest;
  readonly quote_sha256: Digest;
}

/** The unit price that a value is, or null. A price is a whole number from 1 to MAX_UNIT_PRICE. */
function priceOf(value: unknown): number | null {
  const price = parseWhole(value, 'unit price', 1, MAX_UNIT_PRICE);
  return price.ok ? price.value : null;
}

/**
 * The facts of the evidence for one line, or the reason that the line gives none. The line is a check from `lineChecks`. Each member of the line is read one time, and the facts hold the values of that read.
 * A line gives the facts when its listed price and its quoted price are two unit prices that differ. Any other line gives a refusal:
 *   - `no_listed_price`: the line has no listed unit price. The list gives none (the listed price is null), the listed price is not a unit price, or the input holds no line check.
 *   - `no_contradiction`: the line has a listed unit price, and the quoted unit price is the same number, or is not a unit price.
 * The function never throws for data.
 */
export function quotePriceFacts(input: { readonly line: LineCheck; readonly price_list_sha256: Digest; readonly quote_sha256: Digest }): ProtocolResult<PriceFacts, 'no_listed_price' | 'no_contradiction'> {
  const line: LineCheck | undefined = isPlainObject(input) ? input.line : undefined;
  if (!isPlainObject(line)) return refused('no_listed_price', 'the input has no line check, so it has no listed unit price');
  const { sku, quantity, quoted_unit_price, listed_unit_price } = line;
  const listed = priceOf(listed_unit_price);
  if (listed === null) return refused('no_listed_price', 'the line has no listed unit price: the price list gives none, or the value is not a unit price');
  const quoted = priceOf(quoted_unit_price);
  if (quoted === null) return refused('no_contradiction', 'the line has no quoted unit price that the list contradicts: the quoted value is not a unit price');
  if (quoted === listed) return refused('no_contradiction', 'the quoted unit price is the listed unit price');
  const { price_list_sha256, quote_sha256 } = input;
  const facts: PriceFacts = { kind: 'quote_price', sku, quantity, quoted_unit_price: quoted, listed_unit_price: listed, price_list_sha256, quote_sha256 };
  return accepted(facts);
}
