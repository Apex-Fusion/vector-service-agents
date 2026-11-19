// packages/id-kit/src/client/credential.ts
// The identity credential of an agent: GET /agents/<identifier>/credential gives a W3C Verifiable Credential 2.0 that the gateway signed (`application/vc+jwt`). The gateway
// issues it only while the agent is Active. The client returns the JWT as it came. The verifier reads it (`verifyCredential`).

import { badBody, failureOf, send } from '../common/http.ts';
import { vectorIdOf } from '../common/did.ts';
import { accept, type GatewayResult } from '../common/result.ts';
import type { ClientContext } from './context.ts';

const IDENTIFIER = /^[0-9a-f]{64}$/;

/** The identifier of an agent from a DID or from the bare identifier. Throws a TypeError for any other text. */
export function identifierOf(agent: string): string {
  const vectorId = IDENTIFIER.test(agent) ? agent : vectorIdOf(agent);
  if (vectorId === null) throw new TypeError('an agent is a DID of the form did:vector:<64 hex characters>, or its 64 hex characters');
  return vectorId;
}

/** The credential of the agent, as a compact JWS. The refusals of the gateway: 404 unknown agent, 410 deactivated, 409 not Active, and 503 while the status lists build. */
export async function fetchCredential(ctx: ClientContext, agent: string): Promise<GatewayResult<string>> {
  const outcome = await send(ctx, `${ctx.origin}/agents/${identifierOf(agent)}/credential`, { method: 'GET', headers: { accept: 'application/vc+jwt' } });
  if (!outcome.reached || outcome.reply.status !== 200) return failureOf(outcome, 'a credential request');
  const { status, headers, body } = outcome.reply;
  const jwt = body.trim();
  if (!(headers.get('content-type') ?? '').toLowerCase().startsWith('application/vc+jwt') || jwt.split('.').length !== 3) return badBody(status, 'the answer is not a credential in the form of a JWS');
  return accept(jwt);
}
