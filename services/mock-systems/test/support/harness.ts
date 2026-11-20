// services/mock-systems/test/support/harness.ts
// The service on a real HTTP server on 127.0.0.1 (a port that the system gives), with the world of the tests behind it, and a client that sends the header fields that a proxy would
// send: the Host header of the host of tokens or of the client-certificate host, and a Client-Cert header. The approval check is a fake that the test gives: it records what it was
// asked, and it answers with what the test says. It exists only here: no source of the service builds one.
import { createServer, request } from 'node:http';
import type { IncomingHttpHeaders, Server } from 'node:http';
import { connect } from 'node:net';
import type { AddressInfo } from 'node:net';
import { listen } from '@vsa/service-kit';
import { createApp } from '../../src/app.ts';
import type { App } from '../../src/app.ts';
import type { ApprovalAnswer, ApprovalCheck, ApprovalInput } from '../../src/approval.ts';
import { INSURER_ORG, MTLS_HOST, OPERATOR_TOKEN, PUBLIC_BASE, PUBLIC_HOST, SUPPLIER_ORG, World, resourceOf } from './world.ts';
import type { IssuedCredential } from './world.ts';

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

export class Harness {
  readonly lines: string[] = [];
  readonly approvals: ApprovalInput[] = [];
  /** What the fake approval check answers. A test changes it. */
  answer: ApprovalAnswer | 'throw' | 'garbage' = { ok: true };
  /** When set, the fake approval check waits for this promise before it answers. Use `holdApproval`. */
  private approvalGate: Promise<void> | null = null;
  private onApprovalAsked: (() => void) | null = null;
  readonly app: App;
  readonly server: Server;
  port = 0;

  constructor(readonly world: World) {
    const approvalCheck: ApprovalCheck = async (input) => {
      this.approvals.push(input);
      this.onApprovalAsked?.();
      if (this.approvalGate !== null) await this.approvalGate;
      if (this.answer === 'throw') throw new Error('the check broke');
      if (this.answer === 'garbage') return { ok: 'true' } as unknown as ApprovalAnswer;
      return this.answer;
    };
    this.app = createApp({
      config: { publicBase: PUBLIC_BASE, publicHost: PUBLIC_HOST, mtlsHost: MTLS_HOST, operatorToken: OPERATOR_TOKEN },
      identity: world.identity, approvalCheck, now: world.now, writeLog: (line) => { this.lines.push(line); },
    });
    this.server = createServer((req, res) => { void this.app.handle(req, res); });
  }

  static async start(world: World = new World()): Promise<Harness> {
    const harness = new Harness(world);
    await listen(harness.server, 0, '127.0.0.1');
    harness.port = (harness.server.address() as AddressInfo).port;
    return harness;
  }

  /** Holds the approval check: the next call of it waits. `asked` is settled when the check was asked, so that a test knows that a call is in the middle of its checks. */
  holdApproval(): { asked: Promise<void>; release: () => void } {
    let release = (): void => undefined;
    let asked = (): void => undefined;
    this.approvalGate = new Promise<void>((resolve) => { release = resolve; });
    const askedPromise = new Promise<void>((resolve) => { asked = resolve; });
    this.onApprovalAsked = asked;
    return { asked: askedPromise, release: () => { this.approvalGate = null; this.onApprovalAsked = null; release(); } };
  }

  /** Sends the text as it is on a new connection and gives the status line and the text of the answer. For a request that the HTTP client of Node will not make, such as two Host headers. */
  raw(text: string): Promise<{ status: number; text: string }> {
    return new Promise((resolve, reject) => {
      const socket = connect({ host: '127.0.0.1', port: this.port }, () => { socket.write(text); });
      const chunks: Buffer[] = [];
      socket.on('data', (chunk: Buffer) => chunks.push(chunk));
      socket.on('error', reject);
      socket.on('close', () => {
        const answer = Buffer.concat(chunks).toString('utf8');
        resolve({ status: Number(/^HTTP\/1\.[01] (\d{3})/.exec(answer)?.[1] ?? 0), text: answer });
      });
    });
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => { this.server.close(() => resolve()); this.server.closeAllConnections(); });
  }

  call(options: CallOptions): Promise<Reply> {
    const headers: Record<string, string | string[]> = { ...options.headers };
    const sent = options.body === undefined ? undefined : typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
    if (sent !== undefined && options.contentType !== null) headers['content-type'] = options.contentType ?? 'application/json';
    const host = options.host === undefined ? PUBLIC_HOST : options.host;
    if (host !== null) headers.host = host;
    return new Promise((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port: this.port, method: options.method ?? 'GET', path: options.path, headers, setHost: false }, (res) => {
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

  /** `POST /admin/tenants` with the operator token. */
  seed(tenant: string, extra: Record<string, unknown> = {}, token: string = OPERATOR_TOKEN): Promise<Reply> {
    return this.call({
      method: 'POST', path: '/admin/tenants', headers: { authorization: `Bearer ${token}` },
      body: { tenant, organisations: { supplier: SUPPLIER_ORG, insurer: INSURER_ORG }, ...extra },
    });
  }

  /** The lines of the log of the service (stdout), as objects. */
  logged(): Array<Record<string, unknown>> {
    return this.lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  }

  /** A call to a route that needs a token: the credential for the system of the route, and one call. */
  async tokenCall(options: { tenant: string; credential: IssuedCredential; method: string; route: string; body?: unknown; url?: string }): Promise<Reply> {
    const path = `/t/${options.tenant}${options.route}`;
    const headers = await this.world.presented(options.credential, options.method, options.url ?? `${PUBLIC_BASE}${path}`);
    return this.call({ method: options.method, path, headers, body: options.body });
  }

  resource(tenant: string, system: string): string {
    return resourceOf(tenant, system);
  }
}
