// packages/id-kit/src/client/context.ts
// What every call of the client shares: the gateway origin, the `fetch` function, the clock and the limits.

import { DEFAULT_MAX_BYTES, DEFAULT_TIMEOUT_MS, gatewayOrigin, type HttpContext } from '../common/http.ts';

export interface GatewayClientOptions {
  /** The origin of the gateway, for example `https://id.vector.apexfusion.org`. It is the issuer of every token and the base of every route. */
  readonly baseUrl: string;
  /** The `fetch` function. The default is the one of the runtime. A test gives the one of the stub gateway, so that no network is used. */
  readonly fetch?: typeof fetch;
  /** The clock, in POSIX milliseconds. The default is `Date.now`. */
  readonly now?: () => number;
  /** The time limit of one call, in milliseconds. The default is 10 seconds. */
  readonly timeoutMs?: number;
}

export interface ClientContext extends HttpContext {
  readonly origin: string;
  /** The URL of the token endpoint. It is the audience of every subject token and the target of the proof of a token request. */
  readonly tokenEndpoint: string;
  readonly now: () => number;
}

export function contextOf(options: GatewayClientOptions): ClientContext {
  const origin = gatewayOrigin(options.baseUrl);
  return {
    origin,
    tokenEndpoint: `${origin}/token`,
    fetch: options.fetch ?? globalThis.fetch,
    now: options.now ?? Date.now,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxBytes: DEFAULT_MAX_BYTES,
  };
}
