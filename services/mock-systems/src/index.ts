// services/mock-systems/src/index.ts - the entry of the service: reads the environment and starts. A start that cannot happen says why on stderr and exits 1. The entry passes no option:
// the approval check comes from src/wiring.ts alone.
import { startService, stopOnSignals } from './start.ts';

try {
  stopOnSignals(await startService(process.env));
} catch (error) {
  console.error(`[mock-systems] cannot start: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
