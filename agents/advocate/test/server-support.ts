// agents/advocate/test/server-support.ts
// Shared by the service tests (test/server.test.ts, test/start.test.ts): the environment of a full deployment, the supplier identity it publishes, the deps a
// server is given, and a real HTTP server on a port the system picks. The token, the two API keys and the public key are made at run time from a label, so
// none is written in the repository; the public key is any 32 bytes, and the key hash is its blake2b-224, as the ledger computes it.
import { createHash } from 'node:crypto';
import { blake2b224Hex } from '@vsa/vector-read';
import { DEFAULT_MODEL } from '../src/model.ts';
import type { RunDeps } from '../src/run.ts';
import { createServer } from '../src/server.ts';
import type { ServerOptions } from '../src/server.ts';
import { publicLookup } from './fake-fetch.ts';
import { TEST_BRAVE_KEY, TEST_OPENROUTER_KEY, noWait } from './golden.ts';

/** An address on the reserved .test domain, never a real one. */
export const TEST_CONTACT = 'ops@example.test';
const pubKeyHex = createHash('sha256').update('advocate service test: the supplier').digest('hex');
export const SUPPLIER = { pubKeyHex, pkh: blake2b224Hex(pubKeyHex) };
/** The value the runtime sends as the authorization header of every call to the service: "Bearer " and 64 hex characters, as the runbook makes it. */
export const TEST_AUTH = `Bearer ${createHash('sha256').update('advocate service test: the token of the runtime').digest('hex')}`;
export const AUTH = { authorization: TEST_AUTH };
/** What an operator sets for a full deployment, and nothing else: every other setting has a default. */
export const FULL_ENV = {
  OPERATOR_CONTACT: TEST_CONTACT, AGENT_DID: 'did:test', SUPPLIER_PKH: SUPPLIER.pkh, SUPPLIER_PUB_KEY_HEX: SUPPLIER.pubKeyHex, SERVICE_AUTH_HEADER: TEST_AUTH,
  BRAVE_SEARCH_API_KEY: TEST_BRAVE_KEY, OPENROUTER_API_KEY: TEST_OPENROUTER_KEY,
};
export const T0 = 1_760_000_000_000;
export const noFetch = (async () => { throw new Error('this test makes no outbound call'); }) as typeof fetch;

/**
 * The deps of a service in a test: no outbound call, a clock, the two keys of the tests, the default model, a log that keeps nothing, and the two seams the
 * service never sets: the public host lookup of test/fake-fetch.ts, so that no page is looked up in DNS, and a wait that returns at once, so that the two
 * queries of a search are not 1100 ms of real time apart.
 */
export function baseDeps(over: Partial<Omit<RunDeps, 'deadlineMs' | 'signal'>> = {}): Omit<RunDeps, 'deadlineMs' | 'signal'> {
  return {
    fetchImpl: noFetch, clock: Date.now, braveApiKey: TEST_BRAVE_KEY, openRouterApiKey: TEST_OPENROUTER_KEY, model: DEFAULT_MODEL, log: () => undefined,
    lookup: publicLookup, wait: noWait, ...over,
  };
}

/** A message in the wire form the runtime posts: a one-element array whose content is the request JSON as a string. */
export const wire = (request: unknown): string => JSON.stringify([{ content: typeof request === 'string' ? request : JSON.stringify(request), role: 'user' }]);

export interface Reply { status: number; text: string; json: any; headers: Headers }
export interface Api {
  url: string;
  /** A POST that carries the token of the runtime, as the runtime's call does. */
  post: (body: string) => Promise<Reply>;
  get: (path: string) => Promise<Reply>;
  /** Any request. It carries the token unless `headers` says otherwise: a value replaces the token, null sends no authorization header at all. */
  request: (method: string, path: string, body?: string, headers?: Record<string, string | null>) => Promise<Reply>;
}

/** Runs `fn` against a server made from `options` on a port the system picks, and closes it, its connections included, whatever `fn` does. */
export async function serve<T>(options: Omit<ServerOptions, 'authHeader'> & { authHeader?: string }, fn: (api: Api) => Promise<T>): Promise<T> {
  const server = createServer({ ...options, authHeader: options.authHeader ?? TEST_AUTH });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const request = async (method: string, path: string, body?: string, headers: Record<string, string | null> = {}): Promise<Reply> => {
    const sent: Record<string, string> = { ...AUTH };
    for (const [name, value] of Object.entries(headers)) { if (value === null) delete sent[name]; else sent[name] = value; }
    const res = await fetch(`${base}${path}`, { method, body, headers: sent });
    const text = await res.text();
    let json: any;
    try { json = JSON.parse(text); } catch { json = undefined; }
    return { status: res.status, text, json, headers: res.headers };
  };
  try {
    return await fn({ url: base, post: (body) => request('POST', '/', body), get: (path) => request('GET', path), request });
  } finally {
    server.close();
    server.closeAllConnections();
  }
}

/** Waits until `condition` holds, polling every 5 ms for at most `ms`; fails with `what` otherwise. */
export async function until(condition: () => boolean | Promise<boolean>, what: string, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await condition())) {
    if (Date.now() > end) throw new Error(`gave up waiting until ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
