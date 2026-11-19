// packages/id-kit/src/verify/reader.ts
// How a relying party reads what the gateway publishes: the key set, the SPIFFE bundle and the status lists. The reader fetches with the caller's `fetch`, keeps what it read for a
// while, and tells a failed read apart from a bad document.
// - A document that cannot be read (the gateway is unreachable, answers 503, or answers anything but 200) is `unavailable`. A list that is over (its time of validity has passed) is
//   `expired`. Both are soft: they say that the list was not read. A relying party does not refuse a call for them, and it writes them to its log (see index.ts).
// - A document that is read and is wrong (a bad signature, another issuer, a list for another URL, bad encoding) is a refusal. It is no soft result.
// - After a failed read, the reader does not call again before the wait that the gateway asked for (`Retry-After`), at least 5 seconds and at most 60 seconds, so that a relying party never
//   makes a gateway that is busy with its first build of the lists busier, and one answer never stops the reads for long. It uses the copy that it has while that copy is valid.
// - A list with an older issue time than the copy that the reader holds is not used in place of it: the copy may show a revocation that the older list lacks.
// - One read of a document is in flight at a time. Callers that come while it runs share its result.

import { CLOCK_LEEWAY_S } from '../common/constants.ts';
import { DEFAULT_MAX_BYTES, DEFAULT_TIMEOUT_MS, gatewayOrigin, jsonObject, send, type HttpContext } from '../common/http.ts';
import { accept, refuse, type Check } from '../common/result.ts';
import { parseKeySet, type KeySet, type KeySetRule } from './keys.ts';
import { decodeBitstringStatusList, decodeTokenStatusList, type BitstringStatusList, type ListContext, type StatusListRule, type TokenStatusList } from './status-list.ts';
import { parseBundle, type BundleRule, type SpiffeBundle } from './svid.ts';

export interface GatewayReaderOptions {
  /** The origin of the gateway. It is the issuer of every token and list, and its host is the trust domain. */
  readonly baseUrl: string;
  /** The `fetch` function. The default is the one of the runtime. A test gives the one of the stub gateway. */
  readonly fetch?: typeof fetch;
  /** The clock, in POSIX milliseconds. The default is `Date.now`. */
  readonly now?: () => number;
  /** The time limit of one read, in milliseconds. The default is 10 seconds. */
  readonly timeoutMs?: number;
  /** The clock difference that the checks accept, in seconds. The default is 30, as the gateway's. */
  readonly leewaySeconds?: number;
  /** How long the key set is used before it is read again, in seconds. The default is 300. */
  readonly keyCacheSeconds?: number;
  /** How long the bundle is used before it is read again, in seconds. The default is the refresh hint of the bundle, or 300. */
  readonly bundleCacheSeconds?: number;
  /** The longest time that a status list is used before it is read again, in seconds. The default is the `ttl` of the list (60 seconds at the gateway). A smaller value shows a change of status sooner. */
  readonly listCacheSeconds?: number;
}

export type KeysRule = 'keys.unavailable' | KeySetRule;
export type BundleReadRule = 'bundle.unavailable' | BundleRule;
/** The two soft results of a list read (a list that cannot be read, and a list that is over) and every rule of a bad document. */
export type ListReadRule = 'list.unavailable' | StatusListRule;

/** A list that the reader read, and when. `refreshError` says why the last read of a fresh copy failed, when the reader gives an older copy. */
export interface ListSnapshot<T> {
  readonly list: T;
  /** POSIX ms. */
  readonly fetchedAt: number;
  readonly refreshError: string | null;
}

export interface GatewayReader {
  /** The origin of the gateway. */
  readonly issuer: string;
  /** The trust domain of the agents: the host of the gateway. */
  readonly trustDomain: string;
  readonly leewaySeconds: number;
  /** The clock of the reader, in POSIX ms. */
  now(): number;
  /** The key set of the gateway. With `refresh`, it is read again if the copy is older than 30 seconds (a token named a key that the set did not have). */
  keys(refresh?: boolean): Promise<Check<KeySet, KeysRule>>;
  bundle(): Promise<Check<SpiffeBundle, BundleReadRule>>;
  /** The Token Status List at `uri`, a URL of the gateway of the form `<origin>/status/tsl/<n>`. */
  tokenList(uri: string): Promise<Check<ListSnapshot<TokenStatusList>, ListReadRule>>;
  /** The Bitstring Status List at `url`, a URL of the gateway of the form `<origin>/status/bsl/<n>`. */
  bitstringList(url: string): Promise<Check<ListSnapshot<BitstringStatusList>, ListReadRule>>;
}

/** True for the two results that say that a list was not read: it cannot be fetched, or it is over. They are not a refusal of a call. */
export const isSoftListRule = (rule: string): boolean => rule === 'list.unavailable' || rule === 'list.expired';

const MIN_FORCED_READ_MS = 30_000;
const MIN_RETRY_MS = 5_000;
/** The longest wait after a failed read, for any status and any `Retry-After`: one answer must not keep a list unread for days. */
const MAX_RETRY_MS = 60_000;
/** A key set or a bundle that cannot be read again is used for this long after its last read: one hour, the life of a status list. */
const MAX_STALE_MS = 3_600_000;

type Fetched = { readonly ok: true; readonly body: string } | { readonly ok: false; readonly detail: string; readonly retryAfterMs: number };

/** One document of the gateway with one copy: a key set, or the bundle. */
interface DocumentSource<T, R extends string> {
  /** The copy while it is fresh; else a new read; and, when that read fails, the copy while it is not older than an hour. `force` asks for a new read of a copy older than 30 seconds. */
  get(force?: boolean): Promise<Check<T, R>>;
}

export function createGatewayReader(options: GatewayReaderOptions): GatewayReader {
  const issuer = gatewayOrigin(options.baseUrl);
  const now = options.now ?? Date.now;
  const leewaySeconds = options.leewaySeconds ?? CLOCK_LEEWAY_S;
  const http: HttpContext = { fetch: options.fetch ?? globalThis.fetch, timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS, maxBytes: DEFAULT_MAX_BYTES };

  async function fetchText(url: string, mediaType: string): Promise<Fetched> {
    const outcome = await send(http, url, { method: 'GET', headers: { accept: mediaType } });
    if (!outcome.reached) return { ok: false, detail: outcome.detail, retryAfterMs: MIN_RETRY_MS };
    const { status, headers, body } = outcome.reply;
    if (status === 200) return { ok: true, body };
    const asked = /^\d{1,6}$/.test(headers.get('retry-after') ?? '') ? Number(headers.get('retry-after')) * 1000 : 0;
    const description = jsonObject(body)?.error_description;
    return { ok: false, detail: `the gateway answered ${status}${typeof description === 'string' ? `: ${description}` : ''}`, retryAfterMs: Math.min(Math.max(asked, MIN_RETRY_MS), MAX_RETRY_MS) };
  }

  function documentSource<T, R extends string, U extends string>(spec: {
    readonly url: string;
    readonly mediaType: string;
    readonly unavailable: U;
    /** Reads a JSON object. A refusal is a document that was read and is wrong. */
    readonly parse: (json: Record<string, unknown>) => Check<T, R>;
    /** How long a copy is used, in ms. */
    readonly freshMs: (value: T) => number;
  }): DocumentSource<T, R | U> {
    let copy: { value: T; fetchedAt: number } | null = null;
    let running: Promise<Check<T, R | U>> | null = null;
    let retryAt = 0;
    const fallback = (detail: string): Check<T, R | U> => (copy !== null && now() - copy.fetchedAt < MAX_STALE_MS ? accept(copy.value) : refuse(spec.unavailable, detail));

    async function read(): Promise<Check<T, R | U>> {
      const fetched = await fetchText(spec.url, spec.mediaType);
      if (!fetched.ok) {
        retryAt = now() + fetched.retryAfterMs;
        return fallback(fetched.detail);
      }
      const json = jsonObject(fetched.body);
      if (json === null) {
        retryAt = now() + MIN_RETRY_MS;
        return fallback('the gateway answered 200 with a body that is not a JSON object');
      }
      const parsed = spec.parse(json);
      if (!parsed.ok) return parsed;
      copy = { value: parsed.value, fetchedAt: now() };
      retryAt = 0;
      return parsed;
    }

    return {
      get(force = false) {
        const t = now();
        if (copy !== null) {
          const age = t - copy.fetchedAt;
          if (age < spec.freshMs(copy.value) && !(force && age >= MIN_FORCED_READ_MS)) return Promise.resolve(accept(copy.value));
          if (t < retryAt) return Promise.resolve(fallback('the last read failed; the reader waits before it reads again'));
        } else if (t < retryAt) {
          return Promise.resolve(refuse(spec.unavailable, 'the last read failed; the reader waits before it reads again'));
        }
        running ??= read().finally(() => {
          running = null;
        });
        return running;
      },
    };
  }

  const keySource = documentSource({
    url: `${issuer}/.well-known/jwks.json`,
    mediaType: 'application/json',
    unavailable: 'keys.unavailable' as const,
    parse: (json) => parseKeySet(json),
    freshMs: () => (options.keyCacheSeconds ?? 300) * 1000,
  });
  const bundleSource = documentSource({
    url: `${issuer}/spiffe/bundle`,
    mediaType: 'application/json',
    unavailable: 'bundle.unavailable' as const,
    parse: (json) => parseBundle(json),
    freshMs: (bundle) => (options.bundleCacheSeconds ?? bundle.refreshHintSeconds ?? 300) * 1000,
  });

  // ── the status lists: one copy for each URL ──

  interface ListFormat<T> {
    readonly mediaType: string;
    decode(text: string, ctx: ListContext): Check<T, StatusListRule>;
    /** When the list starts, in POSIX ms: its issue time. */
    startOf(list: T): number;
    /** When the list ends, in POSIX ms. */
    endOf(list: T): number;
    /** How long a copy is used, in ms. */
    freshMs(list: T): number;
  }

  function listSource<T>(format: ListFormat<T>): (url: string) => Promise<Check<ListSnapshot<T>, ListReadRule>> {
    interface Copy {
      readonly list: T;
      readonly fetchedAt: number;
      /** When a fresh read may start. */
      readonly refreshAt: number;
    }
    const copies = new Map<string, Copy>();
    const running = new Map<string, Promise<Check<ListSnapshot<T>, ListReadRule>>>();
    const retryAt = new Map<string, number>();
    const valid = (copy: Copy | undefined): copy is Copy => copy !== undefined && format.endOf(copy.list) > now() - leewaySeconds * 1000;

    /** The older copy while it is valid, with the reason that a fresh one was not read; else the soft rule. */
    function fallback(url: string, rule: 'list.unavailable' | 'list.expired', detail: string): Check<ListSnapshot<T>, ListReadRule> {
      const copy = copies.get(url);
      return valid(copy) ? accept({ list: copy.list, fetchedAt: copy.fetchedAt, refreshError: detail }) : refuse(rule, detail);
    }

    async function read(url: string): Promise<Check<ListSnapshot<T>, ListReadRule>> {
      const fetched = await fetchText(url, format.mediaType);
      if (!fetched.ok) {
        retryAt.set(url, now() + fetched.retryAfterMs);
        return fallback(url, 'list.unavailable', fetched.detail);
      }
      const text = fetched.body.trim();
      const keys = await keySource.get();
      if (!keys.ok) {
        retryAt.set(url, now() + MIN_RETRY_MS);
        return fallback(url, 'list.unavailable', `the key set of the gateway cannot be used: ${keys.detail}`);
      }
      const decode = (keySet: KeySet) => format.decode(text, { keys: keySet, issuer, url, nowMs: now(), leewaySeconds });
      let decoded = decode(keys.value);
      // A list that a key signed which the set does not hold: the gateway changed its keys. Read the key set once more, if the copy is not new, and try again.
      if (!decoded.ok && decoded.rule === 'list.kid') {
        const again = await keySource.get(true);
        if (again.ok) decoded = decode(again.value);
      }
      if (!decoded.ok) return decoded.rule === 'list.expired' ? fallback(url, 'list.expired', decoded.detail) : decoded;
      // A list with an older issue time than the copy is no news, even when it is still valid: the copy may show a revocation that this list lacks. Keep the copy.
      const held = copies.get(url);
      if (valid(held) && format.startOf(decoded.value) < format.startOf(held.list)) {
        retryAt.set(url, now() + MIN_RETRY_MS);
        return fallback(url, 'list.unavailable', 'the gateway sent a list with an older issue time than the copy that the reader holds');
      }
      retryAt.delete(url);
      const fetchedAt = now();
      copies.set(url, { list: decoded.value, fetchedAt, refreshAt: fetchedAt + Math.min(format.freshMs(decoded.value), (options.listCacheSeconds ?? Number.POSITIVE_INFINITY) * 1000) });
      return accept({ list: decoded.value, fetchedAt, refreshError: null });
    }

    return (url) => {
      const t = now();
      const copy = copies.get(url);
      if (valid(copy) && t < copy.refreshAt) return Promise.resolve(accept({ list: copy.list, fetchedAt: copy.fetchedAt, refreshError: null }));
      if (t < (retryAt.get(url) ?? 0)) return Promise.resolve(fallback(url, 'list.unavailable', 'the last read failed; the reader waits before it reads again'));
      const started = running.get(url) ?? read(url).finally(() => running.delete(url));
      running.set(url, started);
      return started;
    };
  }

  const tokenLists = listSource<TokenStatusList>({
    mediaType: 'application/statuslist+jwt',
    decode: decodeTokenStatusList,
    startOf: (list) => list.issuedAt,
    endOf: (list) => list.expiresAt,
    freshMs: (list) => (list.ttlSeconds ?? 60) * 1000,
  });
  const bitstringLists = listSource<BitstringStatusList>({
    mediaType: 'application/vc+jwt',
    decode: decodeBitstringStatusList,
    startOf: (list) => list.validFrom,
    endOf: (list) => list.validUntil,
    freshMs: (list) => list.ttlMs ?? 60_000,
  });

  return {
    issuer,
    trustDomain: new URL(issuer).hostname,
    leewaySeconds,
    now,
    keys: (refresh = false) => keySource.get(refresh),
    bundle: () => bundleSource.get(),
    tokenList: tokenLists,
    bitstringList: bitstringLists,
  };
}
