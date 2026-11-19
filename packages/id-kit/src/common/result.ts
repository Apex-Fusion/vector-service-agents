// packages/id-kit/src/common/result.ts
// The typed results of every check and of every gateway call. A caller never reads success from a text: a result has `ok`, and a refusal names its rule.

/** A check that failed. `rule` names the rule that failed (a member of the rule list of the check). `detail` is a sentence for a log. */
export interface Refused<R extends string = string> {
  readonly ok: false;
  readonly rule: R;
  readonly detail: string;
}

/** A check that passed, with what it found. */
export interface Accepted<T> {
  readonly ok: true;
  readonly value: T;
}

export type Check<T, R extends string = string> = Accepted<T> | Refused<R>;

export const accept = <T>(value: T): Accepted<T> => ({ ok: true, value });
export const refuse = <R extends string>(rule: R, detail: string): Refused<R> => ({ ok: false, rule, detail });

/** The four ways that a call to the gateway fails. */
export const GATEWAY_RULES = ['gateway.refused', 'gateway.unavailable', 'gateway.bad_response', 'gateway.unreachable'] as const;
export type GatewayRule = (typeof GATEWAY_RULES)[number];

/**
 * A call to the gateway that failed.
 * - `gateway.refused`: the gateway answered 4xx with a reason. `error` is its OAuth error code, and `detail` is its description.
 * - `gateway.unavailable`: the gateway answered 5xx, or 429. The call can work later. `retryAfterSeconds` is the wait that the gateway asks for.
 * - `gateway.bad_response`: the answer is not what the gateway sends for this call.
 * - `gateway.unreachable`: no answer came (network failure, or the time limit).
 */
export interface GatewayRefused extends Refused<GatewayRule> {
  /** The HTTP status of the answer, or 0 when no answer came. */
  readonly status: number;
  readonly error: string | null;
  readonly retryAfterSeconds: number | null;
}

export type GatewayResult<T> = Accepted<T> | GatewayRefused;
