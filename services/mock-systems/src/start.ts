// services/mock-systems/src/start.ts
// How the service starts and stops. `startService` reads the settings (every one is checked, and a wrong value stops the start with the name of the variable), makes the verifier and the
// gateway client, wires the ledger and the approval check, and listens. It refuses to start when no approval check is wired (src/wiring.ts). Nothing is made before every setting is
// checked, and the service listens last, so a start that is refused never opens a port.
// A stop takes no new connection, closes the connections that are idle, and gives a call that runs 5 seconds. The state of the tenants is in memory: a stop loses it.
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { errorText, listen } from '@vsa/service-kit';
import type { LedgerEnv } from '@vsa/buyer-core';
import type { ApprovalCheck } from './approval.ts';
import { createApp } from './app.ts';
import { loadConfig } from './config.ts';
import { createIdentityDeps } from './identity.ts';
import type { LedgerPort } from './identity.ts';
import { createLedgerEnv, ledgerPort } from './ledger.ts';
import { wireApprovalCheck } from './wiring.ts';

/** How long a stop waits for the calls that run, in milliseconds. */
export const STOP_WAIT_MS = 5_000;

/** What a test may replace. The production entry (src/index.ts) passes none of it. */
export interface StartOptions {
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  readonly writeLog?: (line: string) => void;
  readonly ledger?: LedgerPort;
  readonly wire?: (ledger: LedgerEnv) => ApprovalCheck | null;
}

export interface Started {
  readonly server: Server;
  readonly port: number;
  /** Stops the service. Safe to call twice. */
  shutdown(): Promise<void>;
}

export const NO_APPROVAL_CHECK =
  'the approval check of the use-case kit is not wired in this build (src/wiring.ts): the service does not start without a real check, and it never runs with a fake one or one that always passes';

export async function startService(env: NodeJS.ProcessEnv, options: StartOptions = {}): Promise<Started> {
  const config = loadConfig(env);
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  const writeLog = options.writeLog ?? ((line: string) => { process.stdout.write(`${line}\n`); });
  const ledgerEnv = createLedgerEnv(config, fetchImpl);
  const approvalCheck = (options.wire ?? wireApprovalCheck)(ledgerEnv);
  if (approvalCheck === null) throw new Error(NO_APPROVAL_CHECK);

  const identity = createIdentityDeps({ gatewayUrl: config.gatewayUrl, fetch: fetchImpl, now, ledger: options.ledger ?? ledgerPort(ledgerEnv) });
  const app = createApp({ config, identity, approvalCheck, now, writeLog });

  const server = createServer((req, res) => { void app.handle(req, res); });
  // The proxy keeps connections open for two minutes. The service must not close one first, or the proxy sends a call on a closed connection.
  server.keepAliveTimeout = 125_000;
  server.headersTimeout = 130_000;
  server.requestTimeout = 60_000;
  await listen(server, config.port, config.host);
  const port = (server.address() as AddressInfo).port;
  writeLog(JSON.stringify({ event: 'listening', host: config.host, port, public_base: config.publicBase, mtls_base: config.mtlsBase, gateway: config.gatewayUrl, ledger: { ogmios: config.ogmiosUrl, koios: config.koiosUrl } }));

  let stopped: Promise<void> | undefined;
  const shutdown = (): Promise<void> => (stopped ??= new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeIdleConnections();
    setTimeout(() => server.closeAllConnections(), STOP_WAIT_MS).unref();
  }));
  return { server, port, shutdown };
}

/** Stops the service on SIGTERM and SIGINT (`docker stop` sends the first): exit 0 when the stop is done, 1 when it fails. The first signal takes both handlers off. */
export function stopOnSignals(started: Started, log: (line: string) => void = (line) => { process.stdout.write(`${line}\n`); }): void {
  const handlers = new Map<string, () => void>();
  for (const signal of ['SIGTERM', 'SIGINT']) {
    const handler = (): void => {
      for (const [name, other] of handlers) process.off(name, other);
      log(JSON.stringify({ event: 'stopping', signal }));
      started.shutdown().then(() => process.exit(0), (error: unknown) => { log(JSON.stringify({ event: 'stop_failed', message: errorText(error, 300) })); process.exit(1); });
    };
    handlers.set(signal, handler);
    process.on(signal, handler);
  }
}
