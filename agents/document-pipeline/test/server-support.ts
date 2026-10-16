// agents/document-pipeline/test/server-support.ts
// Shared by the service tests (test/server.test.ts, test/start.test.ts): the environment of a full deployment, the buyer key and the identity the service
// must derive from it, the deps a server is given, a real HTTP server on a port the system picks, a raw client for what fetch hides, and a stand-in for
// the poppler tools.
//
// The keys are made at run time from a label, as test/stub-suppliers.ts makes its own, so no key is written in the repository. The identity the service
// must derive from the buyer key is worked out here by other routes than the code under test uses: node:crypto and blake2b-224 for the key hash, and
// FakeChain (Lucid's address of a key hash) for the address; buyer-core derives both with CML.
import { createHash } from 'node:crypto';
import { copyFileSync, linkSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { connect } from 'node:net';
import type { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { FakeChain } from '@vsa/buyer-core';
import type { Chain } from '@vsa/buyer-core';
import { StrandedStore } from '../src/janitor.ts';
import type { Deps } from '../src/orchestrate.ts';
import { createServer } from '../src/server.ts';
import type { ServerOptions } from '../src/server.ts';
import { fakeRenderer } from './fake-renderer.ts';
import { T0, stubKey } from './stub-suppliers.ts';

/** An address on the reserved .test domain, never a real one. */
export const TEST_CONTACT = 'ops@example.test';

/** A key made from `label`: its 32 raw bytes are the sha256 of the label, which is also how stubKey makes the matching public key and key hash. */
export const keyOf = (label: string) => ({ privateKeyHex: createHash('sha256').update(label).digest('hex'), ...stubKey(label) });
export const BUYER = keyOf('document-pipeline service test: the buyer');
export const SUPPLIER = keyOf('document-pipeline service test: the supplier');
/** The mainnet enterprise address of the buyer key hash. */
export const BUYER_ADDRESS = new FakeChain({ buyerPkh: BUYER.pkh }).address;

/**
 * The value the runtime sends as the authorization header of every call to the service, and the service requires (SERVICE_AUTH_HEADER, ruling R50): the shape the
 * runbook gives it, "Bearer " and 64 hex characters. Made from a label like the keys, so that no token is written in the repository.
 */
export const TEST_AUTH = `Bearer ${createHash('sha256').update('document-pipeline service test: the token of the runtime').digest('hex')}`;
/** The headers of a call that has the token, for a test that sends its own request. */
export const AUTH = { authorization: TEST_AUTH };

/** What an operator sets for a full deployment, and nothing else: every other setting has a default. */
export const FULL_ENV = {
  OPERATOR_CONTACT: TEST_CONTACT, AGENT_DID: 'did:test', SUPPLIER_PKH: SUPPLIER.pkh, SUPPLIER_PUB_KEY_HEX: SUPPLIER.pubKeyHex, PIPELINE_BUYER_PRIV_KEY_HEX: BUYER.privateKeyHex,
  SERVICE_AUTH_HEADER: TEST_AUTH,
};

// --- Directories ---------------------------------------------------------------------------------------------------------------------
const dirs: string[] = [];
/** A new empty directory, removed by cleanDirs. */
export function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pipeline-service-'));
  dirs.push(dir);
  return dir;
}
export function cleanDirs(): void {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}

// --- Deps ----------------------------------------------------------------------------------------------------------------------------
/** The start of the in-memory marketplace's clock, which the deps of a service made here also start on. */
export { T0 };
export const noFetch = (async () => { throw new Error('this test makes no outbound call'); }) as typeof fetch;

/** The deps of a service that is not going to run a job of its own: a FakeChain with the default float, a renderer and a store in a temporary directory. */
export function baseDeps(over: Partial<Omit<Deps, 'deadlineMs'>> = {}): Omit<Deps, 'deadlineMs'> {
  return {
    chain: new FakeChain(), fetchImpl: noFetch, renderer: fakeRenderer(), clock: () => T0, sleep: async () => {},
    ocrAllowlistPkh: '11'.repeat(28), llmAllowlist: ['model-a'], stranded: new StrandedStore(tempDir()), ...over,
  };
}

/** A Chain that answers wallet() as `wallet` says and refuses everything else: what a health check needs. */
export function walletChain(wallet: () => ReturnType<Chain['wallet']>): Chain {
  const unused = async (): Promise<never> => { throw new Error('this test uses the wallet only'); };
  return { wallet, postEscrow: unused, accept: unused, reclaim: unused, escrowState: unused, onChainReceiptHash: unused, readAdvert: unused };
}

// --- HTTP ----------------------------------------------------------------------------------------------------------------------------
export interface Reply { status: number; text: string; json: any; headers: Headers }
export interface Api {
  /** The base URL of the server, without a trailing slash, and its port. */
  url: string;
  port: number;
  /** A POST that carries the token of the runtime, as the runtime's call does. */
  post: (body: string, path?: string) => Promise<Reply>;
  get: (path: string) => Promise<Reply>;
  /** Any request. It carries the token unless `headers` says otherwise: a value replaces the token, null sends no authorization header at all. */
  request: (method: string, path: string, body?: string, headers?: Record<string, string | null>) => Promise<Reply>;
}

/** A message in the wire form the runtime posts: a one-element array whose content is the request JSON as a string. */
export const wire = (request: unknown): string => JSON.stringify([{ content: typeof request === 'string' ? request : JSON.stringify(request), role: 'user' }]);

/**
 * Runs `fn` against a server made from `options` on a port the system picks, and shuts it down, its connections included, whatever `fn` does. The server
 * requires TEST_AUTH unless the options name another token, and the requests `fn` makes carry TEST_AUTH unless it says otherwise.
 */
export async function serve<T>(options: Omit<ServerOptions, 'authHeader'> & { authHeader?: string }, fn: (api: Api) => Promise<T>): Promise<T> {
  const server = createServer({ ...options, authHeader: options.authHeader ?? TEST_AUTH });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;
  const request = async (method: string, path: string, body?: string, headers: Record<string, string | null> = {}): Promise<Reply> => {
    const sent: Record<string, string> = { ...AUTH };
    for (const [name, value] of Object.entries(headers)) { if (value === null) delete sent[name]; else sent[name] = value; }
    const res = await fetch(`${base}${path}`, { method, body, headers: sent });
    const text = await res.text();
    let json: any;
    try { json = JSON.parse(text); } catch { json = undefined; }
    return { status: res.status, text, json, headers: res.headers };
  };
  const api: Api = { url: base, port, post: (body, path = '/') => request('POST', path, body), get: (path) => request('GET', path), request };
  try {
    return await fn(api);
  } finally {
    server.close();
    server.closeAllConnections();
  }
}

/** Waits until `condition` holds, polling every 5 ms for at most `ms`; fails with `what` otherwise. */
export async function until(condition: () => boolean, what: string, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > end) throw new Error(`gave up waiting until ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
/** Lets every promise that is already settled run its continuation, and the timers due now. */
export const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

// --- A raw client --------------------------------------------------------------------------------------------------------------------
// fetch hides the interim responses a server writes before its answer, and a test of those needs the bytes. This client reads them off a socket.
const INTERIM_LINE = 'HTTP/1.1 102 Processing\r\n\r\n';

/** What a raw client has read, parsed as far as it goes: the interim lines, then the status, the headers and the body once the answer is complete. */
export interface RawResponse {
  /** How many "102 Processing" lines came before the answer, or before this point of it. */
  interim: number;
  status: number | null;
  headers: Record<string, string>;
  /** The body, once all of it has been read; null before that. */
  body: Buffer | null;
  /** The bytes after the end of the answer: none, for a server that has said all it has to say. */
  trailing: number;
}

/** The body of a chunked message and the bytes it took, or null while it is not all there. */
function dechunk(bytes: Buffer): { body: Buffer; used: number } | null {
  const parts: Buffer[] = [];
  let at = 0;
  for (;;) {
    const eol = bytes.indexOf('\r\n', at, 'latin1');
    if (eol < 0) return null;
    const size = Number.parseInt(bytes.toString('latin1', at, eol), 16);
    if (!Number.isInteger(size) || size < 0) throw new Error('a chunk size that is not a number');
    at = eol + 2;
    if (size === 0) {
      const end = bytes.indexOf('\r\n', at, 'latin1'); // no trailer: the line break that ends the message follows the last chunk
      return end < 0 ? null : { body: Buffer.concat(parts), used: end + 2 };
    }
    if (bytes.length < at + size + 2) return null;
    parts.push(bytes.subarray(at, at + size));
    at += size + 2;
  }
}

export function parseRaw(received: Buffer, closed: boolean): RawResponse {
  let at = 0;
  let interim = 0;
  while (received.toString('latin1', at, at + INTERIM_LINE.length) === INTERIM_LINE) { interim += 1; at += INTERIM_LINE.length; }
  const headEnd = received.indexOf('\r\n\r\n', at, 'latin1');
  if (headEnd < 0) return { interim, status: null, headers: {}, body: null, trailing: 0 };
  const [statusLine, ...fields] = received.toString('latin1', at, headEnd).split('\r\n');
  const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(statusLine)?.[1]);
  const headers = Object.fromEntries(fields.map((field) => { const colon = field.indexOf(':'); return [field.slice(0, colon).toLowerCase(), field.slice(colon + 1).trim()]; }));
  const rest = received.subarray(headEnd + 4);
  const incomplete = { interim, status, headers, body: null, trailing: 0 };
  if (headers['transfer-encoding']?.toLowerCase() === 'chunked') {
    const chunked = dechunk(rest);
    return chunked === null ? incomplete : { interim, status, headers, body: chunked.body, trailing: rest.length - chunked.used };
  }
  if (headers['content-length'] !== undefined) {
    const length = Number(headers['content-length']);
    return rest.length < length ? incomplete : { interim, status, headers, body: rest.subarray(0, length), trailing: rest.length - length };
  }
  return closed ? { interim, status, headers, body: rest, trailing: 0 } : incomplete; // neither: the body runs to the end of the connection
}

export interface RawClient {
  socket: Socket;
  /** Everything read so far. */
  received: () => Buffer;
  /** The response as far as it has come. */
  response: () => RawResponse;
  /** Waits until the answer is complete (or the connection is closed), and returns it. */
  answer: (ms?: number) => Promise<RawResponse>;
  /** Sends the last bytes of the body, when the request was made with `holdBack`. */
  finish: () => void;
  close: () => void;
}

/**
 * Sends one request over a socket of its own and reads whatever comes back, byte for byte. The caller closes it. The request carries TEST_AUTH as its
 * authorization header unless `authorization` is another value, or null for no header at all.
 */
export function rawClient(port: number, request: { body?: string; method?: string; path?: string; version?: '1.0' | '1.1'; close?: boolean; holdBack?: number; authorization?: string | null }): RawClient {
  const socket = connect(port, '127.0.0.1');
  const chunks: Buffer[] = [];
  let closed = false;
  socket.on('data', (chunk: Buffer) => { chunks.push(chunk); });
  socket.on('close', () => { closed = true; });
  socket.on('error', () => undefined); // a test that closes its socket early must not fail on the reset
  const body = Buffer.from(request.body ?? '', 'utf8');
  const authorization = request.authorization === undefined ? TEST_AUTH : request.authorization;
  const head = [
    `${request.method ?? 'POST'} ${request.path ?? '/'} HTTP/${request.version ?? '1.1'}`, 'Host: 127.0.0.1', 'Content-Type: application/json', `Content-Length: ${body.length}`,
    ...(authorization === null ? [] : [`Authorization: ${authorization}`]),
    ...(request.close === true ? ['Connection: close'] : []), '', '',
  ].join('\r\n');
  // `holdBack` bytes of the body are kept back until finish(): a request whose upload is still under way.
  const whole = Buffer.concat([Buffer.from(head, 'latin1'), body]);
  const held = Math.min(request.holdBack ?? 0, body.length);
  socket.write(whole.subarray(0, whole.length - held));
  const received = () => Buffer.concat(chunks);
  const response = () => parseRaw(received(), closed);
  const answer = async (ms = 5000) => { await until(() => response().body !== null || closed, 'the answer is complete', ms); return response(); };
  return { socket, received, response, answer, finish: () => { if (held > 0) socket.write(whole.subarray(whole.length - held)); }, close: () => socket.destroy() };
}

// --- The poppler tools ---------------------------------------------------------------------------------------------------------------
/**
 * A directory with a pdfinfo and a pdftoppm in it that, asked for their version, print one and exit 0: node's own executable under those names (a link where
 * the platform has one, a copy where it does not). For a test of a start that needs the tools to be there and reads no PDF.
 */
export function fakePopplerDir(): string {
  const dir = tempDir();
  for (const tool of ['pdfinfo', 'pdftoppm']) {
    if (process.platform === 'win32') {
      const file = join(dir, `${tool}.exe`);
      try { linkSync(process.execPath, file); } catch { copyFileSync(process.execPath, file); }
    } else {
      symlinkSync(process.execPath, join(dir, tool));
    }
  }
  return dir;
}

const pathName = (env: Record<string, string | undefined>): string => Object.keys(env).find((key) => key.toLowerCase() === 'path') ?? 'PATH';
/** The directories searched for programs, whatever the case of the variable's name (it is Path on Windows). */
export const pathOf = (env: Record<string, string | undefined>): string | undefined => env[pathName(env)];
/** `env` with `path` as those directories. */
export function withPath<T extends Record<string, string | undefined>>(env: T, path: string): T {
  return { ...env, [pathName(env)]: path };
}
/** The same path with `dir` in front of it. */
export const inFront = (dir: string, path: string | undefined): string => (path === undefined || path === '' ? dir : `${dir}${delimiter}${path}`);
