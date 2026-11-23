// agents/order-desk/src/checks/lots.ts
// The lots file of the Order Desk: for each SKU, the size of each of the three lots. The Order Desk serves the file as bytes, and its manifest holds the SHA-256 of those bytes. So `loadLots` keeps the text
// as it was read, and the hash is the hash of that text: it is no canonical form. The text is read as strict UTF-8, so the bytes of the text are the bytes of the file.
//
// A file that is not UTF-8, is not JSON, or is not a lots file of the kit is an error, and the service stops at its start. The message says what is wrong and never repeats a part of the file.
import { readFileSync } from 'node:fs';
import { lotsFileSha256, parseLotsFile } from '@vsa/usecase-kit/inventory';
import type { LotsFile } from '@vsa/usecase-kit/inventory';
import type { Digest } from '@vsa/usecase-kit/protocol';

/** The lots file, its text and the hash of its bytes. */
export interface LoadedLots {
  /** The file as the parser of the kit read it. */
  readonly file: LotsFile;
  /** The text of the file, as it was read: the host serves this text, and it hashed this text. */
  readonly text: string;
  /** The SHA-256 of the bytes of the file, as 64 lower-case hex characters. The manifest holds it. */
  readonly sha256: Digest;
}

// A byte order mark stays in the text, so that it fails the JSON read and is never dropped: the bytes of the text stay the bytes of the file.
const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** Reads the lots file at `path`. It throws when the file cannot be read, and when it is damaged. */
export function loadLots(path: string): LoadedLots {
  const bytes = readFileSync(path);
  let text: string;
  try {
    text = UTF8.decode(bytes);
  } catch {
    throw new Error('the lots file is not UTF-8 text');
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error('the lots file is not JSON');
  }
  const parsed = parseLotsFile(value);
  if (!parsed.ok) throw new Error(`the lots file is not a lots file: ${parsed.detail}`);
  return { file: parsed.value, text, sha256: lotsFileSha256(text) };
}
