// packages/usecase-kit/src/cosign/allowlist.ts
// The allowlist of the operator: the principal keys that a delegation may come from. The text form is one key hash for each entry (56 lower-case hex characters), separated by white space or commas. A `#`
// starts a note that runs to the end of the line. The service reads the text once, at its start, from a file or from a setting, and checks it here. The operator command of the later work calls
// `addToAllowlist` and writes the new text back. This code reads and writes no file.
import { accepted, refused, type ProtocolResult } from '../protocol/index.ts';

const KEY_HASH = /^[0-9a-f]{56}$/;
/** The most keys on the list. */
export const MAX_ALLOWLIST_KEYS = 1_024;
/** The most bytes of the text of the list. */
export const MAX_ALLOWLIST_BYTES = 131_072;

/** A set of principal key hashes. It has no way to add or remove a key: a list is made by `parseAllowlist`, and a changed list is a new one. */
export class Allowlist {
  readonly #keys: ReadonlySet<string>;

  constructor(keys: ReadonlySet<string>) {
    this.#keys = new Set(keys);
  }

  /** True when the key hash is on the list. Anything that is not a key hash of the right form is not on it. */
  has(keyHash: unknown): boolean {
    return typeof keyHash === 'string' && this.#keys.has(keyHash);
  }

  get size(): number {
    return this.#keys.size;
  }

  keys(): string[] {
    return [...this.#keys];
  }
}

/** Reads the text of the list. A token that is not a key hash is a refusal. The detail names the line and never repeats the token. */
export function parseAllowlist(text: unknown): ProtocolResult<Allowlist, 'bad_setting'> {
  if (typeof text !== 'string') return refused('bad_setting', 'the allowlist must be text');
  if (Buffer.byteLength(text, 'utf8') > MAX_ALLOWLIST_BYTES) return refused('bad_setting', `the allowlist is longer than ${MAX_ALLOWLIST_BYTES} bytes`);
  const keys = new Set<string>();
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const entries = lines[i].split('#', 1)[0].split(/[\s,]+/).filter((entry) => entry !== '');
    for (const entry of entries) {
      if (!KEY_HASH.test(entry)) return refused('bad_setting', `the allowlist has an entry on line ${i + 1} that is not a key hash (56 lower-case hex characters)`);
      keys.add(entry);
    }
  }
  if (keys.size > MAX_ALLOWLIST_KEYS) return refused('bad_setting', `the allowlist has more than ${MAX_ALLOWLIST_KEYS} keys`);
  return accepted(new Allowlist(keys));
}

/**
 * The text of the list with one key added at its end, one key on a line, and whether the key was new. A key that is on the list already gives the same text and `added: false`. A text that does not pass
 * `parseAllowlist` is a refusal, so the command never writes over a file that it could not read.
 */
export function addToAllowlist(text: unknown, keyHash: unknown): ProtocolResult<{ readonly text: string; readonly added: boolean }, 'bad_setting'> {
  const parsed = parseAllowlist(text);
  if (!parsed.ok) return parsed;
  if (typeof keyHash !== 'string' || !KEY_HASH.test(keyHash)) return refused('bad_setting', 'the key must be a key hash of 56 lower-case hex characters');
  if (parsed.value.has(keyHash)) return accepted({ text: text as string, added: false });
  if (parsed.value.size >= MAX_ALLOWLIST_KEYS) return refused('bad_setting', `the allowlist has ${MAX_ALLOWLIST_KEYS} keys already`);
  const base = (text as string) === '' || (text as string).endsWith('\n') ? (text as string) : `${text as string}\n`;
  const next = `${base}${keyHash}\n`;
  return Buffer.byteLength(next, 'utf8') > MAX_ALLOWLIST_BYTES ? refused('bad_setting', `the allowlist would be longer than ${MAX_ALLOWLIST_BYTES} bytes`) : accepted({ text: next, added: true });
}
