// agents/prior-authorization-agent/test/serve/serve.ts
// A service on a port that the system picks, and an HTTP client for it. `serve` makes the server of the agent over the deps that a test gives (the worlds of the job folders), `start` starts the whole service in this
// process over the world of the wiring, and `closeAll` ends every server and every service that a test opened, their connections included. No test uses the network.
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { INDEXER, marketplace, vaultChainWith } from '@vsa/hire-kit/testing';
import type { Marketplace } from '@vsa/hire-kit/testing';
import { readFaultSwitch } from '@vsa/usecase-kit/fault';
import { harness, world as ledgerWorld } from '../../../../packages/usecase-kit/test/cosign/support.ts';
import { keyOf } from '../../src/serve/keys.ts';
import { createServer } from '../../src/serve/server.ts';
import type { ServerOptions } from '../../src/serve/server.ts';
import { startService } from '../../src/serve/start.ts';
import type { RunningService, StartOptions } from '../../src/serve/start.ts';
import { TOKEN, startEnv, tempDir, withModule1 } from './support.ts';

const servers: Server[] = [];
const services: RunningService[] = [];

/** Ends every server and every service that a test opened. A test file calls it in `afterEach`. */
export async function closeAll(): Promise<void> {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); })));
  await Promise.all(services.splice(0).map((service) => service.stop()));
}

export interface Running {
  readonly origin: string;
  readonly log: string[];
}

const noJob = (): never => { throw new Error('no job was expected'); };

/** A server of the agent on a free port, with the parts that a test gives, a route that has no use, and no deps of a job unless a test gives them. */
export async function serve(over: Partial<ServerOptions> = {}): Promise<Running> {
  const log: string[] = [];
  const server = createServer({
    manifestText: '{"name":"Prior Authorization Agent"}', authHeader: TOKEN, fault: readFaultSwitch('prior-authorization-agent', ''), cosign: harness().route, proposeDeps: noJob, executeDeps: noJob, clock: Date.now,
    log: (line) => { log.push(line); }, ...over,
  });
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  servers.push(server);
  return { origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, log };
}

/** Forgets the servers that a test closed by itself, so that `closeAll` does not close them a second time. */
export async function closeServers(): Promise<void> {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); })));
}

export type Json = Record<string, unknown>;
export interface Answer {
  readonly status: number;
  readonly body: Json;
}

/** One call to POST /: the wire message that the runtime posts, with the token unless a test gives another. */
export async function post(origin: string, request: unknown, token: string | null = TOKEN, content: string = JSON.stringify(request)): Promise<Answer> {
  const res = await fetch(`${origin}/`, { method: 'POST', body: JSON.stringify([{ content, role: 'user' }]), headers: token === null ? {} : { authorization: token } });
  return { status: res.status, body: (await res.json()) as Json };
}

/** Polls until `condition` holds, for seconds at most. The sockets and the child processes of these tests run in real time, and no fake clock drives them. */
export async function until(condition: () => boolean, ms = 5_000): Promise<void> {
  for (const end = Date.now() + ms; !condition(); await new Promise<void>((resolve) => { setTimeout(resolve, 5); })) {
    if (Date.now() > end) throw new Error('the condition did not hold in time');
  }
}

export interface Started {
  readonly service: RunningService;
  readonly dir: string;
  readonly log: string[];
  readonly origin: string;
  readonly m: Marketplace;
}

/** A start of the whole service in this process, with the parts of the tests: the offline node of the fixture world, a chain for each key, and no network. */
export async function start(env: NodeJS.ProcessEnv = {}, options: StartOptions = {}): Promise<Started> {
  const dir = tempDir();
  const m = marketplace();
  const log: string[] = [];
  const service = await startService(startEnv({ PRIORAUTH_STATE_DIR: dir, VECTOR_MARKETPLACE_INDEXER_URL: INDEXER, ...env }), {
    fetchImpl: withModule1(m.fetchImpl), log: (line) => { log.push(line); }, provider: ledgerWorld(), tipSlot: async () => 0, janitorIntervalMs: 3_600_000,
    createChain: async (chainOptions) => vaultChainWith(m, { wallet: async () => ({ ...(await m.chain.wallet()), buyerPkh: keyOf(chainOptions.privateKeyHex).pkh }) }),
    ...options,
  });
  services.push(service);
  return { service, dir, log, origin: `http://127.0.0.1:${service.port}`, m };
}
