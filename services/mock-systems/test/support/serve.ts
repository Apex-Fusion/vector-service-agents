// services/mock-systems/test/support/serve.ts
// The entry of a test: the service with a test approval check and the stop on signals, as src/index.ts starts it with the real check. test/start.test.ts runs it in a child process and
// sends it SIGTERM and SIGINT. It exists only for the tests: the image does not run it.
import { startService, stopOnSignals } from '../../src/start.ts';

stopOnSignals(await startService(process.env, { wire: () => async () => ({ ok: true }) }));
