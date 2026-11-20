// services/mock-systems/test/support/net.ts
// The network helpers that the tests share: one call to a server on 127.0.0.1 with the header fields that a proxy would send, a free port, and a check that a port has a listener.
// No test leaves 127.0.0.1.
import { createServer, request } from 'node:http';
import type { IncomingHttpHeaders } from 'node:http';
import { connect } from 'node:net';
import type { AddressInfo } from 'node:net';
import { listen } from '@vsa/service-kit';
import { PUBLIC_HOST } from './world.ts';

export interface Reply {
  status: number;
  headers: IncomingHttpHeaders;
  text: string;
  /** The body as JSON, or null when it is no JSON. */
  json: Record<string, unknown> | null;
}

export interface CallOptions {
  method?: string;
  path: string;
  /** The Host header: the host of tokens by default. `null` sends none. */
  host?: string | null;
  headers?: Record<string, string | string[]>;
  /** A JSON body, or a text that is sent as it is. */
  body?: unknown;
  contentType?: string | null;
}

/** One call to the server on 127.0.0.1 at `port`. The Host header is the one of the call: the proxy sets it, and the service tells its two hosts apart by it. */
export function send(port: number, options: CallOptions): Promise<Reply> {
  const headers: Record<string, string | string[]> = { ...options.headers };
  const sent = options.body === undefined ? undefined : typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
  if (sent !== undefined && options.contentType !== null) headers['content-type'] = options.contentType ?? 'application/json';
  const host = options.host === undefined ? PUBLIC_HOST : options.host;
  if (host !== null) headers.host = host;
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method: options.method ?? 'GET', path: options.path, headers, setHost: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json: Record<string, unknown> | null = null;
        try {
          const parsed: unknown = JSON.parse(text);
          json = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
        } catch {
          json = null;
        }
        resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    if (sent !== undefined) req.write(sent);
    req.end();
  });
}

/** A port on 127.0.0.1 that nothing listens on now: the system gives one, and it is let go again. Another process can take it before the caller does, which is unlikely in a test. */
export async function freePort(): Promise<number> {
  const server = createServer();
  await listen(server, 0, '127.0.0.1');
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => { server.close(() => resolve()); });
  return port;
}

/** True when something accepts a connection on 127.0.0.1 at `port`. */
export function listening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port });
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => { socket.destroy(); resolve(false); });
  });
}
