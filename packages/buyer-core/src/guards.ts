// packages/buyer-core/src/guards.ts
// Two checks on untrusted values that more than one module of buyer-core makes: is a value a JSON object, and do two refs name the same output. They were written
// in fleet-clients.ts and select-supplier.ts first; fleet-verify.ts needs both too, so there is one copy of each, here.
import { canonicalRef } from './vendored/mcp/marketplace-supplier.ts';

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
