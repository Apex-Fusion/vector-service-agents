// agents/sourcing-agent/test/serve/serve.ts
// A service on a port that the system picks, and an HTTP client for it. `serve` makes the server of the agent over the deps that a test gives (the worlds of the job folders), and `closeAll` ends every server that a
// test opened, their connections included. `gate` holds a port of a job where a test wants it, and `hangingCall` posts a job and gives back the means to hang up on it. No test uses the network.
import { request as httpRequest } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFaultSwitch } from '@vsa/usecase-kit/fault';
import { harness } from '../../../../packages/usecase-kit/test/cosign/support.ts';
import { createServer } from '../../src/serve/server.ts';
import type { ServerOptions } from '../../src/serve/server.ts';
import { TOKEN } from './support.ts';

const servers: Server[] = [];

const closed = (server: Server): Promise<void> => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });

/** Ends every server that a test opened. A test file calls it in `afterEach`. */
export async function closeAll(): Promise<void> {
  await Promise.all(servers.splice(0).map(closed));
}

export interface Running {
  readonly origin: string;
  /** The lines that the server wrote to its log. */
  readonly log: string[];
}

const noJob = (): never => { throw new Error('no job was expected'); };

/** A server of the agent on a free port, with the parts that a test gives, a co-sign route that has no use, and no deps of a job unless a test gives them. */
export async function serve<K = unknown>(over: Partial<ServerOptions<K>> = {}): Promise<Running> {
  const log: string[] = [];
  const server = createServer<K>({
    manifestText: '{"name":"Sourcing Agent"}', authHeader: TOKEN, fault: readFaultSwitch('sourcing-agent', ''), cosign: harness().route, proposeDeps: noJob, executeDeps: noJob, clock: Date.now,
    log: (line) => { log.push(line); }, ...over,
  });
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  servers.push(server);
  return { origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, log };
}

/** Closes the servers that a test opened and forgets them, so that a test can start a second server over the same files, as a restart does. */
export async function closeServers(): Promise<void> {
  await Promise.all(servers.splice(0).map(closed));
}

export type Json = Record<string, unknown>;
export interface Answer {
  readonly status: number;
  readonly body: Json;
}

/** One call to POST /: the wire message that the runtime posts, with the token unless a test gives another, and the headers of the context of the call when a test gives them. */
export async function post(origin: string, request: unknown, token: string | null = TOKEN, content: string = JSON.stringify(request), headers: Record<string, string> = {}): Promise<Answer> {
  const res = await fetch(`${origin}/`, { method: 'POST', body: JSON.stringify([{ content, role: 'user' }]), headers: { ...(token === null ? {} : { authorization: token }), ...headers } });
  return { status: res.status, body: (await res.json()) as Json };
}

/** A call to POST / that the test can hang up on: the connection is closed from the client side, with no answer read. */
export function hangingCall(origin: string, request: unknown): { readonly hangUp: () => void } {
  const url = new URL(origin);
  const call = httpRequest({ host: url.hostname, port: url.port, method: 'POST', path: '/', headers: { authorization: TOKEN } });
  call.on('error', () => undefined);
  call.end(JSON.stringify([{ content: JSON.stringify(request), role: 'user' }]));
  return { hangUp: () => { call.destroy(); } };
}

/** Polls until `condition` holds, for seconds at most. The sockets of these tests run in real time, and no fake clock drives them. */
export async function until(condition: () => boolean, ms = 5_000): Promise<void> {
  for (const end = Date.now() + ms; !condition(); await new Promise<void>((resolve) => { setTimeout(resolve, 5); })) {
    if (Date.now() > end) throw new Error('the condition did not hold in time');
  }
}

/** A gate that a test holds a port at: the port calls `pass`, which says that the gate was reached and waits for `open`. */
export function gate(): { readonly reached: () => boolean; readonly pass: () => Promise<void>; readonly open: () => void } {
  let reached = false;
  let open: () => void = () => undefined;
  const opened = new Promise<void>((resolve) => { open = resolve; });
  return { reached: () => reached, pass: async () => { reached = true; await opened; }, open: () => { open(); } };
}
