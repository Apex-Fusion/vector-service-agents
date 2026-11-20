// packages/usecase-kit/src/access/gateway.ts
// How a failure of the identity gateway reaches a caller. The client of id-kit gives a rule for each failure, and this file gives each rule its own code. The error code of the protocol for
// every one of them in a buyer-side agent is `token_failed`. A caller that can wait (a delegation that is too young) reads `delegation_too_young`.
import type { GatewayRefused } from '@vsa/id-kit/client';
import { refused, type Refused } from '../protocol/index.ts';
import { errorText, safeText } from './text.ts';

export const GATEWAY_FAILURES = ['bad_request', 'gateway_refused', 'delegation_too_young', 'gateway_unavailable', 'gateway_unreachable', 'gateway_bad_response'] as const;
export type GatewayFailureCode = (typeof GATEWAY_FAILURES)[number];

/**
 * A request to the gateway that did not give what it was made for.
 * - `bad_request`: the arguments are wrong, and nothing was sent.
 * - `gateway_refused`: the gateway answered 4xx.
 * - `delegation_too_young`: the gateway issues a token only when every delegation of the chain has 30 confirmations, and one has fewer. The same request can work later.
 * - `gateway_unavailable`: the gateway answered 5xx or 429. `retryAfterSeconds` is the wait that it asks for, or null.
 * - `gateway_unreachable`: no answer came.
 * - `gateway_bad_response`: the answer is not what the gateway sends, or it does not hold what was asked for.
 */
export interface GatewayFailure extends Refused<GatewayFailureCode> {
  /** The HTTP status of the answer, or 0 when no answer came or nothing was sent. */
  readonly status: number;
  /** The OAuth error code of the gateway, or null. */
  readonly gatewayError: string | null;
  readonly retryAfterSeconds: number | null;
}

/** The text that the gateway gives for a delegation that is too young (the check of its token path, for any delegation of the chain). */
const TOO_YOUNG = /^delegation [0-9a-f]{64} has fewer than 30 confirmations$/;

export function gatewayFailure(code: GatewayFailureCode, detail: string, extra: { status?: number; gatewayError?: string | null; retryAfterSeconds?: number | null } = {}): GatewayFailure {
  return { ...refused(code, detail), status: extra.status ?? 0, gatewayError: extra.gatewayError ?? null, retryAfterSeconds: extra.retryAfterSeconds ?? null };
}

/** The failure for a rule of the client. A rule that is not known is a bad response, and never a pass. */
export function fromRule(result: GatewayRefused, secrets: readonly string[] = []): GatewayFailure {
  const detail = safeText(result.detail, secrets);
  const extra = { status: result.status, gatewayError: result.error === null ? null : safeText(result.error, secrets), retryAfterSeconds: result.retryAfterSeconds };
  switch (result.rule) {
    case 'gateway.refused':
      return result.status === 400 && result.error === 'invalid_authorization_details' && TOO_YOUNG.test(result.detail)
        ? gatewayFailure('delegation_too_young', detail, extra)
        : gatewayFailure('gateway_refused', detail, extra);
    case 'gateway.unavailable':
      return gatewayFailure('gateway_unavailable', detail, extra);
    case 'gateway.unreachable':
      return gatewayFailure('gateway_unreachable', detail, extra);
    case 'gateway.bad_response':
      return gatewayFailure('gateway_bad_response', detail, extra);
    default:
      return gatewayFailure('gateway_bad_response', 'the client of the gateway gave a rule that is not known', extra);
  }
}

/**
 * The failure for an exception of the client. The client throws a TypeError or a RangeError for an argument that the gateway would refuse, and it sends nothing. Any other exception comes from a
 * function of the caller (a key, a fetch) and shows its name only, so that a message of that code cannot carry a secret into a result.
 */
export function fromThrown(error: unknown, secrets: readonly string[] = []): GatewayFailure {
  if (error instanceof TypeError || error instanceof RangeError) return gatewayFailure('bad_request', errorText(error, secrets));
  return gatewayFailure('bad_request', `the request could not be made: ${error instanceof Error ? safeText(error.name) : 'a value that is not an error was thrown'}`);
}
