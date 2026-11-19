// packages/service-kit/test/support.ts
// Shared by the tests of the server and of the stop: a token made from a label (no token is written in the repository), the wire message, a server on a
// port the system picks, a wait for a condition, a server whose job echoes what it is told, and the context headers of a call.
import { createHash } from 'node:crypto';
import type { Server } from 'node:http';
import type { JobContext } from '../src/context.ts';
import { createJobServer } from '../src/server.ts';
import type { JobServerOptions, Refusal } from '../src/server.ts';

export const TOKEN = `Bearer ${createHash('sha256').update('service-kit test: the token of the runtime').digest('hex')}`;
export const wire = (request: unknown): string => JSON.stringify([{ content: JSON.stringify(request), role: 'user' }]);
export async function listening(server: Server): Promise<{ base: string; port: number }> {
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  const port = (server.address() as { port: number }).port;
  return { base: `http://127.0.0.1:${port}`, port };
}
export function close(server: Server): void {
  server.close();
  server.closeAllConnections();
}
export const pause = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });
/**
 * The two ways a module loads another, for the guards of the modules with no imports: an import line, and an export that re-exports from another module
 * (export { a } from, export type { T } from, export * from, export * as x from), on one line or over several.
 */
export const IMPORT_LINE = /^import\b/m;
export const EXPORT_FROM = /^export\s+(?:type\s+)?(?:\*(?:\s+as\s+\w+)?|\{[^}]*\})\s*from\s*['"]/m;
export async function until(condition: () => boolean, what: string, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > end) throw new Error(`gave up waiting until ${what}`);
    await pause(5);
  }
}

/** The escrow references of the tests: X is the one a call is about, Y is another. */
export const ESCROW_X = `${'a1'.repeat(32)}#0`;
export const ESCROW_Y = `${'b2'.repeat(32)}#3`;
const ADVERT = `${'d4'.repeat(32)}#1`;
/** The six context headers of a call about `escrowRef`, as the runtime sends them. */
export const contextHeaders = (escrowRef: string = ESCROW_X): Record<string, string> => ({
  'x-vector-escrow-ref': escrowRef, 'x-vector-advert-ref': ADVERT, 'x-vector-advert-model': 'test-model-v1',
  'x-vector-buyer-pkh': 'c3'.repeat(28), 'x-vector-payment-lovelace': '5500000', 'x-vector-deliver-by-ms': '1763600000000',
});
/** The context object that the six headers of `contextHeaders` make. */
export const contextOf = (escrowRef: string = ESCROW_X): JobContext => ({
  escrowRef, advertRef: ADVERT, advertModel: 'test-model-v1', buyerPkh: 'c3'.repeat(28), paymentLovelace: 5_500_000n, deliverByMs: 1_763_600_000_000,
});

/** The request of the echo job, and its answer. */
export interface Echo { say: string }
export type Said = { said: string };
/** A refusal that the echo job's `refusalOf` reads. */
export class Refused extends Error { constructor(readonly refusal: Refusal) { super(refusal.message); } }
/** The options of a server whose job echoes what it is told; `over` changes them, and `logs` gets each line of the log. */
export function echoOptions(over: Partial<JobServerOptions<Echo, Said>> = {}, logs: string[] = []): JobServerOptions<Echo, Said> {
  return {
    manifestText: '{"name":"Test Agent"}', authHeader: TOKEN, clock: Date.now, log: (line) => { logs.push(line); },
    parse: (json) => {
      const value = JSON.parse(json) as Echo;
      if (typeof value.say !== 'string') throw new Refused({ code: 'bad_shape', status: 400, message: 'say must be text', kind: 'request' });
      return value;
    },
    run: async (request) => ({ said: request.say }),
    refusalOf: (e) => (e instanceof Refused ? e.refusal : null),
    ...over,
  };
}
/** A server of these options on a port the system picks; it is closed when `fn` has ended. */
export async function serve<T>(opts: JobServerOptions<Echo, Said>, fn: (base: string, port: number, server: Server) => Promise<T>): Promise<T> {
  const server = createJobServer(opts);
  const { base, port } = await listening(server);
  try { return await fn(base, port, server); } finally { close(server); }
}
/** One POST with the token of the runtime (`authorization`: another value, or null for none) and the headers given. */
export const call = (base: string, path: string, body: string, headers: Record<string, string> = {}, authorization: string | null = TOKEN): Promise<Response> =>
  fetch(`${base}${path}`, { method: 'POST', body, headers: { ...(authorization === null ? {} : { authorization }), ...headers } });
