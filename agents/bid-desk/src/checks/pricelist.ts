// agents/bid-desk/src/checks/pricelist.ts
// The price list of a Bid Desk: for each SKU, its lead time and the unit price from each minimum quantity. The Bid Desk serves the file as bytes, and its manifest holds the SHA-256 of those bytes. So
// `loadPriceList` keeps the text as it was read, and the hash is the hash of that text: it is no canonical form. The text is read as strict UTF-8, so the bytes of the text are the bytes of the file.
//
// A file that is not UTF-8, is not JSON, or is not a price list of the kit is an error, and the service stops at its start. The message names the file and says what is wrong. It never repeats a part of the file.
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { parsePriceList, priceListSha256 } from '@vsa/usecase-kit/bids';
import type { PriceList } from '@vsa/usecase-kit/bids';
import type { Digest } from '@vsa/usecase-kit/protocol';

/** The price list, its text and the hash of its bytes. */
export interface LoadedPriceList {
  /** The list as the parser of the kit read it. */
  readonly list: PriceList;
  /** The text of the file, as it was read: the host serves this text, and it hashed this text. */
  readonly text: string;
  /** The SHA-256 of the bytes of the file, as 64 lower-case hex characters. The manifest holds it. */
  readonly sha256: Digest;
}

// A byte order mark stays in the text, so that it fails the JSON read and is never dropped: the bytes of the text stay the bytes of the file.
const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** Reads the price list at `path`. It throws when the file cannot be read, and when it is damaged. */
export function loadPriceList(path: string): LoadedPriceList {
  const name = basename(path);
  const bytes = readFileSync(path);
  let text: string;
  try {
    text = UTF8.decode(bytes);
  } catch {
    throw new Error(`the price list file ${name} is not UTF-8 text`);
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`the price list file ${name} is not JSON`);
  }
  const parsed = parsePriceList(value);
  if (!parsed.ok) throw new Error(`the price list file ${name} is not a price list: ${parsed.detail}`);
  return { list: parsed.value, text, sha256: priceListSha256(text) };
}
