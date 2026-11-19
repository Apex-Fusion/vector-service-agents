// packages/id-kit/src/client/resolve.ts
// DID resolution at the gateway: GET /1.0/identifiers/<did> gives the DID resolution result of the agent (DID Resolution v1.0). The metadata holds the effective status of the
// agent, which already counts a hold, an end of the record and the status of the parents of a subagent. The client reads the result into a typed value. A relying party that
// wants to know whether the agents of a delegation chain are Active reads `effectiveStatus` of each.

import { vectorIdOf } from '../common/did.ts';
import { badBody, failureOf, jsonObject, send } from '../common/http.ts';
import { accept, type GatewayResult } from '../common/result.ts';
import type { ClientContext } from './context.ts';

export const EFFECTIVE_STATUSES = ['active', 'suspended', 'revoked', 'retired'] as const;
export type EffectiveStatus = (typeof EFFECTIVE_STATUSES)[number];

const isEffectiveStatus = (value: unknown): value is EffectiveStatus => EFFECTIVE_STATUSES.some((s) => s === value);

/** A key that the record of the agent lists. `keyHash` is the fragment of the DID URL of the key. */
export interface RecordKey {
  readonly keyHash: string;
  readonly type: string;
  readonly purposes: readonly string[];
}

export type Resolution =
  /** The DID resolves, and the agent is Active or Suspended (the result has a document). */
  | { readonly kind: 'resolved'; readonly did: string; readonly effectiveStatus: EffectiveStatus; readonly effectiveReason: string | null; readonly keys: readonly RecordKey[]; readonly document: Record<string, unknown>; readonly metadata: Record<string, unknown> }
  /** The record ended: the agent is Revoked or Retired (the gateway answers 410, with no document). */
  | { readonly kind: 'deactivated'; readonly did: string; readonly effectiveStatus: EffectiveStatus; readonly effectiveReason: string | null; readonly metadata: Record<string, unknown> }
  /** The gateway has no record for the DID (404). */
  | { readonly kind: 'not_found'; readonly did: string };

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function keysOf(metadata: Record<string, unknown>): RecordKey[] | null {
  const listed = metadata.vectorKeys;
  if (listed === undefined) return [];
  if (!Array.isArray(listed)) return null;
  const keys: RecordKey[] = [];
  for (const entry of listed) {
    const key = object(entry);
    if (key === null || typeof key.id !== 'string' || !key.id.startsWith('#') || typeof key.type !== 'string') return null;
    const purposes = key.purposes === undefined ? [] : key.purposes;
    if (!Array.isArray(purposes) || !purposes.every((p) => typeof p === 'string')) return null;
    keys.push({ keyHash: key.id.substring(1), type: key.type, purposes });
  }
  return keys;
}

export async function resolveAgent(ctx: ClientContext, did: string): Promise<GatewayResult<Resolution>> {
  if (vectorIdOf(did) === null) throw new TypeError('the DID to resolve has the form did:vector:<64 hex characters>');
  const outcome = await send(ctx, `${ctx.origin}/1.0/identifiers/${did}`, { method: 'GET', headers: { accept: 'application/did-resolution' } });
  if (!outcome.reached) return failureOf(outcome, 'a DID resolution');
  const { status, body } = outcome.reply;
  if (status !== 200 && status !== 410 && status !== 404) return failureOf(outcome, 'a DID resolution');
  const result = jsonObject(body);
  const metadata = object(result?.didDocumentMetadata);
  if (result === null || metadata === null) return badBody(status, 'the answer is not a DID resolution result');
  if (status === 404) return accept({ kind: 'not_found', did });

  const vectorStatus = object(metadata.vectorStatus);
  const effectiveStatus = vectorStatus?.effective;
  if (vectorStatus === null || !isEffectiveStatus(effectiveStatus)) return badBody(status, 'the metadata has no effective status of the agent');
  const effectiveReason = typeof vectorStatus.effectiveReason === 'string' ? vectorStatus.effectiveReason : null;
  if (status === 410) return accept({ kind: 'deactivated', did, effectiveStatus, effectiveReason, metadata });

  const document = object(result.didDocument);
  const keys = keysOf(metadata);
  if (document === null || keys === null) return badBody(status, 'the result has no document, or its key list is not well formed');
  return accept({ kind: 'resolved', did, effectiveStatus, effectiveReason, keys, document, metadata });
}
