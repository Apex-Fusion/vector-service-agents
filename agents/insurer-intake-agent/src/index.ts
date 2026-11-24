// agents/insurer-intake-agent/src/index.ts - the entry of the service: reads the environment and starts. A start that cannot happen says why on stderr and exits 1. The entry passes no option: every part is the real one.
import { startService, stopOnSignals } from './serve/start.ts';

try {
  stopOnSignals(await startService(process.env));
} catch (error) {
  console.error(`[insurer-intake-agent] cannot start: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
