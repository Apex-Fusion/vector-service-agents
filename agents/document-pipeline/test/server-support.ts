// agents/document-pipeline/test/server-support.ts
// Shared by the service tests (test/server.test.ts, test/start.test.ts): the environment of a full deployment, the buyer key and the identity the service
// must derive from it, the deps a server is given, and a real HTTP server on a port the system picks.
//
// The keys are made at run time from a label, as test/stub-suppliers.ts makes its own, so no key is written in the repository. The identity the service
// must derive from the buyer key is worked out here by other routes than the code under test uses: node:crypto and blake2b-224 for the key hash, and
// FakeChain (Lucid's address of a key hash) for the address; buyer-core derives both with CML.
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

/** What an operator sets for a full deployment, and nothing else: every other setting has a default. */
export const FULL_ENV = {
  OPERATOR_CONTACT: TEST_CONTACT, AGENT_DID: 'did:test', SUPPLIER_PKH: SUPPLIER.pkh, SUPPLIER_PUB_KEY_HEX: SUPPLIER.pubKeyHex, PIPELINE_BUYER_PRIV_KEY_HEX: BUYER.privateKeyHex,
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
  /** The base URL of the server, without a trailing slash. */
  url: string;
  post: (body: string, path?: string) => Promise<Reply>;
  get: (path: string) => Promise<Reply>;
  request: (method: string, path: string, body?: string) => Promise<Reply>;
}

/** A message in the wire form the runtime posts: a one-element array whose content is the request JSON as a string. */
export const wire = (request: unknown): string => JSON.stringify([{ content: typeof request === 'string' ? request : JSON.stringify(request), role: 'user' }]);

/** Runs `fn` against a server made from `options` on a port the system picks, and shuts it down, its connections included, whatever `fn` does. */
export async function serve<T>(options: ServerOptions, fn: (api: Api) => Promise<T>): Promise<T> {
  const server = createServer(options);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const request = async (method: string, path: string, body?: string): Promise<Reply> => {
    const res = await fetch(`${base}${path}`, { method, body });
    const text = await res.text();
    let json: any;
    try { json = JSON.parse(text); } catch { json = undefined; }
    return { status: res.status, text, json, headers: res.headers };
  };
  const api: Api = { url: base, post: (body, path = '/') => request('POST', path, body), get: (path) => request('GET', path), request };
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
