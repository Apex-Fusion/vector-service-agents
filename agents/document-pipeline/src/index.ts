// agents/document-pipeline/src/index.ts - the entry of the service: reads the environment and starts. A start that cannot happen says why on stderr and exits 1.
import { startService } from './start.ts';

try {
  await startService();
} catch (err) {
  console.error(`[document-pipeline] cannot start: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
}
