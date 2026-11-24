// agents/bid-desk/test/serve/serve.ts
// A real service on a port that the system picks, made over a world of test/serve/world.ts, and an HTTP client for it. The service is stopped, its connections included, whatever the test does.
import type { AddressInfo } from 'node:net';
import { JobSlot, listen } from '@vsa/service-kit';
import type { JobContext } from '@vsa/service-kit';
import { createServer } from '../../src/serve/server.ts';
import { wireService } from '../../src/serve/wiring.ts';
import type { Wired } from '../../src/serve/wiring.ts';
import { TOKEN } from './support.ts';
import { headersOf, wire } from './world.ts';
import type { World } from './world.ts';

const AUTH = { authorization: TOKEN };

/** What an answer of the service holds when it is a JSON object: the members that the tests read by name, and any other member as an unknown value. */
export interface Body {
  readonly error?: string;
  readonly message?: string;
  readonly go?: boolean;
  readonly reserved_ms?: number;
  readonly [member: string]: unknown;
}

export interface Reply {
  readonly status: number;
  readonly text: string;
  readonly json: Body | undefined;
  readonly headers: Headers;
}

export interface Api {
  readonly base: string;
  readonly wired: Wired;
  /** Any request. It carries the token of the runtime unless `headers` says otherwise: a value replaces it, and `null` sends no header of that name. */
  request(method: string, path: string, init?: { readonly body?: string; readonly headers?: Readonly<Record<string, string | null>>; readonly signal?: AbortSignal }): Promise<Reply>;
  /** POST /precheck as the runtime asks it: the token, the body of the job and the six headers of the context. */
  precheck(message?: unknown, context?: JobContext, headers?: Readonly<Record<string, string | null>>): Promise<Reply>;
  /** POST /, the job, as the runtime posts it. */
  job(message?: unknown, context?: JobContext, headers?: Readonly<Record<string, string | null>>, signal?: AbortSignal): Promise<Reply>;
}

/** Runs `fn` against the service of `world`, and stops the service whatever `fn` does. */
export async function serve<T>(world: World, fn: (api: Api) => Promise<T>): Promise<T> {
  const wired = await wireService(world.config, world.options);
  const server = createServer({
    manifestText: world.config.manifest.text, authHeader: world.config.authHeader, fault: world.config.fault, precheck: wired.precheck, jobDeps: wired.jobDeps,
    priceListText: world.config.priceList.text, clock: world.options.clock ?? Date.now, log: world.options.log ?? (() => undefined), slot: new JobSlot(),
  });
  await listen(server, 0, '127.0.0.1');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const request: Api['request'] = async (method, path, init = {}) => {
    const sent: Record<string, string> = { ...AUTH };
    for (const [name, value] of Object.entries(init.headers ?? {})) {
      if (value === null) delete sent[name];
      else sent[name] = value;
    }
    const res = await fetch(`${base}${path}`, { method, headers: sent, ...(init.body === undefined ? {} : { body: init.body }), ...(init.signal === undefined ? {} : { signal: init.signal }) });
    const text = await res.text();
    let json: Body | undefined;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    return { status: res.status, text, json, headers: res.headers };
  };
  const api: Api = {
    base, wired, request,
    precheck: (message: unknown = world.message, context = world.context, headers = {}) => request('POST', '/precheck', { body: wire(message), headers: { ...headersOf(context), ...headers } }),
    job: (message: unknown = world.message, context = world.context, headers = {}, signal) =>
      request('POST', '/', { body: wire(message), headers: { ...headersOf(context), ...headers }, ...(signal === undefined ? {} : { signal }) }),
  };
  try {
    return await fn(api);
  } finally {
    server.close();
    server.closeAllConnections();
  }
}

/** Waits until `condition` holds, polling every 5 ms for at most `ms`; fails with `what` otherwise. */
export async function until(condition: () => boolean | Promise<boolean>, what: string, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await condition())) {
    if (Date.now() > end) throw new Error(`gave up waiting until ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
