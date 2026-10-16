// packages/service-kit/test/support.ts
// Shared by the tests of the server and of the stop: a token made from a label (no token is written in the repository), the wire message, a server on a
// port the system picks, and a wait for a condition.
import { createHash } from 'node:crypto';
import type { Server } from 'node:http';

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
export async function until(condition: () => boolean, what: string, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > end) throw new Error(`gave up waiting until ${what}`);
    await pause(5);
  }
}
