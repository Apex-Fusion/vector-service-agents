// packages/buyer-core/src/guards.ts
// Two checks on untrusted values that more than one module of buyer-core makes: is a value a JSON object, and do two refs name the same output. They were written
// in fleet-clients.ts and select-supplier.ts first; fleet-verify.ts needs both too, so there is one copy of each, here. And the one way text a supplier sent is
// made fit for a log line or the body of an answer (flatText), which fleet-clients.ts and the services that hire share.
import { canonicalRef } from './vendored/mcp/marketplace-supplier.ts';

/** The control characters: U+0000 to U+001F and U+007F. */
const CONTROL = /[\u0000-\u001f\u007f]/g;

/**
 * Text a supplier sent (a reason, a message, a status word, a model name), fit for a log line or the body of an answer (ruling R64): every control
 * character becomes a space, so that a line break cannot forge a log line nor an escape steer a terminal, and the text is cut at `max` characters.
 */
export function flatText(text: string, max: number): string {
  const flat = text.replace(CONTROL, ' ');
  return flat.length > max ? flat.slice(0, max) : flat;
}

/** A JSON object: not null, not an array. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Do two refs name the same output? They are compared as refs, through the vendored canonicalRef, so the spelling does not matter: the case of the hex, white
 * space around the ref and leading zeros in the index all read as the same ref. Anything that is no ref, or no text, names nothing, not even itself.
 */
export function sameRef(a: unknown, b: unknown): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  try { return canonicalRef(a) === canonicalRef(b); } catch { return false; }
}
