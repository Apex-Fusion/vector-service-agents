// agents/reorder-agent/src/index.ts - the entry of the service: reads the environment and starts. A start that cannot happen says why on stderr and exits 1.
// SIGTERM (`docker stop`) and SIGINT stop it the way a restart should: no new job, and up to SHUTDOWN_WAIT_MS for the one that is running.
import { startService, stopOnSignals } from './serve/start.ts';

try {
  stopOnSignals(await startService());
} catch (err) {
  console.error(`[reorder-agent] cannot start: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
}
