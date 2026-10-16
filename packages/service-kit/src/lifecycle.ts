// packages/service-kit/src/lifecycle.ts
// How a service listens, stops, and stops on a signal. The stop of a restart takes no new job and no new connection and waits for the job that is running,
// which holds the job slot until its run has ended: the wait is on the slot, never on the connection of the job, which ends at once when the caller hangs up.
// Past the wait the job is abandoned and its connection closed. Moved from agents/document-pipeline/src/start.ts, whose behaviour it keeps; the work of the
// service's own that a stop ends first (the Pipeline's janitor) and the line of an abandoned job come in the options.
import type { EventEmitter } from 'node:events';
import type { Server } from 'node:http';
import type { JobSlot } from './slot.ts';
import { errorText } from './text.ts';

/** How long a stopping service waits for the job that is running: 300 s; the compose files give Docker 30 s more (stop_grace_period 330s). */
export const SHUTDOWN_WAIT_MS = 300_000;
/** How often a stopping service closes the connections that have become idle (a keep-alive connection is idle once its answer is sent). */
const SWEEP_MS = 100;
/** How a shutdown ended: the job that was running, if any, ended in time, or it was abandoned when the wait was over. */
export type ShutdownOutcome = 'finished' | 'abandoned';

export function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => { server.off('error', reject); resolve(); });
  });
}

export interface LifecycleOptions {
  server: Server;
  slot: JobSlot;
  log: (line: string) => void;
  /** Work of the service's own that a stop ends first and waits for, once. None by default. */
  stopWork?: () => Promise<void>;
  /** The line a shutdown logs when it abandons the job that is running. */
  abandonedLine?: (waitMs: number) => string;
}
export interface Lifecycle {
  /** Ends the service's own work (stopWork) and closes the server and its connections, a job's included. Safe to call twice. */
  stop: () => Promise<void>;
  /** The stop of a restart: no new job, no new connection, stopWork at once, and up to `waitMs` for the job that is running; then stop(). Safe to call twice. */
  shutdown: (waitMs?: number) => Promise<ShutdownOutcome>;
}

export function lifecycle(opts: LifecycleOptions): Lifecycle {
  const { server, slot, log } = opts;
  let worked: Promise<void> | undefined;
  const stopWork = (): Promise<void> => (worked ??= (opts.stopWork ?? (async () => undefined))());
  const abandonedLine = opts.abandonedLine ?? ((waitMs: number): string => `stopping: the job that is running did not finish within ${waitMs} ms and is abandoned`);
  let stopped: Promise<void> | undefined;
  const stop = (): Promise<void> => (stopped ??= (async () => {
    await stopWork();
    await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
  })());
  let shuttingDown: Promise<ShutdownOutcome> | undefined;
  const shutdown = (waitMs: number = SHUTDOWN_WAIT_MS): Promise<ShutdownOutcome> => (shuttingDown ??= (async () => {
    slot.drain(); // no new job, not even on a connection that is still open
    const workDone = stopWork();
    // No new connection either. The others are closed as they fall idle (a connection that has just been answered is idle, and the server's own close() looks at
    // the connections only once).
    const closed = new Promise<'closed'>((resolve) => { server.close(() => resolve('closed')); });
    if (slot.busy) log(`stopping: waiting up to ${waitMs} ms for the job that is running`);
    const sweep = setInterval(() => server.closeIdleConnections(), SWEEP_MS);
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<'late'>((resolve) => { timer = setTimeout(() => resolve('late'), waitMs); });
    let outcome: ShutdownOutcome = 'finished';
    try {
      // What is waited for is the job, which holds the slot until its run has ended. Its connection is no measure of it: that ends at once when the caller hangs up.
      if ((await Promise.race([slot.idle().then(() => 'idle' as const), late])) === 'late') {
        outcome = 'abandoned';
        log(abandonedLine(waitMs));
      } else {
        // The answer of the job, if it has one, has been handed to its connection, which the sweep closes once it is written: that is waited for too, within
        // what is left of the wait, so that the close of the server does not cut it.
        await Promise.race([closed, late]);
      }
    } finally {
      clearInterval(sweep);
      clearTimeout(timer);
    }
    await workDone;
    await stop();
    return outcome;
  })());
  return { stop, shutdown };
}

/**
 * Stops the service on SIGTERM and SIGINT (`docker stop` sends the first): no new job, up to `waitMs` for the job that is running, then exit 0, or 1 when that job
 * had to be abandoned or the stop failed. The first signal takes both handlers off, so a second signal of either kind is the default action and ends the process.
 */
export function stopOnSignals(
  service: { shutdown: (waitMs?: number) => Promise<ShutdownOutcome> },
  opts: { log: (line: string) => void; target?: EventEmitter; exit?: (code: number) => void; waitMs?: number },
): void {
  const target = opts.target ?? process;
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  const waitMs = opts.waitMs ?? SHUTDOWN_WAIT_MS;
  const handlers = new Map<string, () => void>();
  for (const signal of ['SIGTERM', 'SIGINT']) {
    const handler = (): void => {
      for (const [name, other] of handlers) target.off(name, other);
      opts.log(`${signal}: stopping; no new job, and up to ${waitMs / 1000} s for the one that is running`);
      service.shutdown(waitMs).then((outcome) => exit(outcome === 'abandoned' ? 1 : 0), (err: unknown) => { opts.log(`stopping failed: ${errorText(err)}`); exit(1); });
    };
    handlers.set(signal, handler);
    target.on(signal, handler);
  }
}
