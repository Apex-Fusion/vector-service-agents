// scripts/checks/lib/svid-verifier.ts - the verifier service of check 6: a small HTTP service behind a host that asks for a client certificate.
// The proxy asks the client for a certificate, checks nothing, and passes the first certificate of the client in the header `Client-Cert` (RFC 9440): `:` and the standard base64 of the
// DER bytes and `:`. The header is absent when the client sent none. The service must check what the proxy does not: the chain against the SPIFFE bundle of the identity gateway (which
// it reads again every 300 seconds), the validity time, and the SPIFFE ID. It trusts the header only because it listens on a loopback address and the proxy is the only way to reach it.
//
//   GET  /health        200
//   GET  /svid/x509     checks the client certificate of the header
//   POST /svid/jwt      checks the JWT-SVID of `Authorization: Bearer <token>` for the audience of this service
//
// An answer is JSON: `{ ok: true, check, spiffe_id, did, ... }`, or `{ ok: false, check, rule, detail }` with the rule of the check that failed. No answer repeats a certificate or a token.
// The header `Client-Cert-Chain` is never read. A request with two `Client-Cert` headers, with a header that is not in the form above, or with none, is refused.
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { createVerifier } from './platform.ts';
import type { Verifier } from './platform.ts';

const HEADER_FORM = /^:([A-Za-z0-9+/]+={0,2}):$/;
const LOOPBACK = ['127.0.0.1', '::1', 'localhost'];

export interface SvidServiceOptions {
  /** The origin of the identity gateway: it is the issuer, and its host is the trust domain. */
  gatewayUrl: string;
  /** The audience that a JWT-SVID must name: the identifier of this service. */
  audience: string;
  verifier?: Verifier;
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** Where the lines of the log go: one JSON object each. */
  log?: (line: string) => void;
}

export interface SvidService {
  handle(req: IncomingMessage, res: ServerResponse): Promise<void>;
  listen(port: number, host?: string): Promise<Server>;
}

/** How many header fields with this name the request has, from the raw list that Node keeps (it joins them in `headers`). */
const countOf = (req: IncomingMessage, name: string): number => req.rawHeaders.filter((value, index) => index % 2 === 0 && value.toLowerCase() === name).length;

export function createSvidService(options: SvidServiceOptions): SvidService {
  const verifier = options.verifier ?? createVerifier({
    baseUrl: options.gatewayUrl, bundleCacheSeconds: 300, ...(options.fetchImpl === undefined ? {} : { fetch: options.fetchImpl }), ...(options.now === undefined ? {} : { now: options.now }),
  });
  const log = options.log ?? ((line: string) => { process.stdout.write(`${line}\n`); });
  const now = options.now ?? Date.now;

  const answer = (res: ServerResponse, status: number, route: string, body: Record<string, unknown>): void => {
    log(JSON.stringify({ at: new Date(now()).toISOString(), route, status, ok: body.ok, rule: body.rule, spiffe_id: body.spiffe_id }));
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  const refuse = (res: ServerResponse, status: number, check: string, rule: string, detail: string): void => answer(res, status, check, { ok: false, check, rule, detail });

  async function x509(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const count = countOf(req, 'client-cert');
    if (count === 0) return refuse(res, 401, 'x509', 'client_certificate.missing', 'the request has no client certificate');
    if (count > 1) return refuse(res, 400, 'x509', 'client_certificate.multiple', `the request has ${count} Client-Cert headers, and the proxy sets one`);
    const match = HEADER_FORM.exec(String(req.headers['client-cert'] ?? ''));
    if (match === null) return refuse(res, 400, 'x509', 'client_certificate.malformed', 'the Client-Cert header is not : and the base64 of the DER of a certificate and :');
    const checked = await verifier.x509Svid(match[1]!);
    if (!checked.ok) return refuse(res, 401, 'x509', checked.rule, checked.detail);
    const svid = checked.value;
    return answer(res, 200, 'x509', { ok: true, check: 'x509', spiffe_id: svid.spiffeId, did: svid.did, serial: svid.serialNumber, not_before: svid.notBefore, not_after: svid.notAfter });
  }

  async function jwt(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const header = req.headers.authorization;
    if (header === undefined) return refuse(res, 401, 'jwt', 'jwt_svid.missing', 'the request has no Authorization header');
    const match = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(header);
    if (match === null) return refuse(res, 401, 'jwt', 'jwt_svid.scheme', 'the Authorization header is not Bearer and a JWT');
    const checked = await verifier.jwtSvid(match[1]!, { audience: options.audience });
    if (!checked.ok) return refuse(res, 401, 'jwt', checked.rule, checked.detail);
    const svid = checked.value;
    return answer(res, 200, 'jwt', { ok: true, check: 'jwt', spiffe_id: svid.spiffeId, did: svid.did, audience: svid.audience, expires_at: svid.expiresAt });
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = new URL(req.url ?? '/', 'http://service.invalid').pathname;
    try {
      if (path === '/health' && req.method === 'GET') return answer(res, 200, 'health', { ok: true });
      if (path === '/svid/x509' && req.method === 'GET') return await x509(req, res);
      if (path === '/svid/jwt' && req.method === 'POST') return await jwt(req, res);
      if (path === '/svid/x509' || path === '/svid/jwt' || path === '/health') return refuse(res, 405, 'method', 'method_not_allowed', `${req.method ?? ''} is not allowed on ${path}`);
      return refuse(res, 404, 'route', 'not_found', 'no such route');
    } catch (err) {
      return refuse(res, 500, 'internal', 'internal_error', err instanceof Error ? err.message.slice(0, 200) : 'the check failed');
    }
  }

  return {
    handle,
    async listen(port, host = '127.0.0.1') {
      if (!LOOPBACK.includes(host)) throw new Error(`the verifier listens on a loopback address only (${LOOPBACK.join(', ')}): the proxy is the one way to reach it, and it removes a forged Client-Cert header`);
      const server = createServer((req, res) => { void handle(req, res); });
      await new Promise<void>((done, fail) => { server.once('error', fail); server.listen(port, host, done); });
      return server;
    },
  };
}
