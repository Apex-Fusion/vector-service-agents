// services/mock-systems/src/app.ts
// The HTTP side of the service: `createApp` takes its dependencies (the verifier and the gateway client, the check of the delegation on the ledger, the approval check, the clock and the
// sink of the log) and gives `handle`, a listener for `node:http`. The order of a call, and the first failure ends it:
//   1. GET /healthz answers at once and is not logged.
//   2. The Host header names one of the two hosts: the host of tokens (`token`) or the client-certificate host (`mtls`). Another name is 421. A Client-Cert header on the host of tokens is
//      400: the proxy removes it there, so it is a fault, and no route reads it.
//   3. The route is found (404, 405), and the host fits its need: the X.509 routes are served on the client-certificate host only, every other route on the host of tokens only (421).
//   4. The tenant exists (404).
//   5. The need of the route is met (token, SVID, operator token, or none), and the caller is verified.
//   6. A POST has a JSON body of at most 1 MiB. It is read only now, after the caller was verified.
//   7. The handler runs. A document that is not well formed is 400. Any other failure of the service is 500 with no detail, and the call is not honoured.
// Each call is one line of JSON for the log, and a call to a system of a tenant is also in the log of the tenant. The line has the verified identity (`sub`, the `act` chain, the
// delegation), the route, the tenant and the decision with the rule that refused. It never has a token, a proof or the bytes of a certificate.
import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { errorText, flatText } from '@vsa/service-kit';
import { APPROVAL_TIMEOUT_MS } from './approval.ts';
import type { ApprovalCheck } from './approval.ts';
import type { ServiceConfig } from './config.ts';
import { pass, refuse } from './errors.ts';
import type { Outcome } from './errors.ts';
import { authorizeJwtSvid, authorizeToken, authorizeX509Svid, newTrace } from './identity.ts';
import type { CallTrace, IdentityDeps } from './identity.ts';
import { JWT_AUDIENCE_SYSTEM, TOKEN_SYSTEMS, matchRoutes, systemUrl } from './routes.ts';
import type { Call, Ok, Route } from './routes.ts';
import { parseSeed } from './seed.ts';
import { TenantStore } from './tenants.ts';
import type { Actor, LogLine, Tenant } from './tenants.ts';
import { ID, Invalid, TENANT, domain, fields, text } from './validate.ts';

/** The most bytes of a body that the service reads. */
export const MAX_BODY_BYTES = 1_048_576;
const HEADER_FORM = /^:([A-Za-z0-9+/]+={0,2}):$/;
const BEARER = /^bearer +(\S+)$/i;
const JWT_FORM = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

export type AppConfig = Pick<ServiceConfig, 'publicBase' | 'publicHost' | 'mtlsHost' | 'operatorToken'>;

export interface AppDeps {
  readonly config: AppConfig;
  readonly identity: IdentityDeps;
  readonly approvalCheck: ApprovalCheck;
  /** How long a call waits for the approval check, in milliseconds. The default is `APPROVAL_TIMEOUT_MS`. A test sets a short time. */
  readonly approvalTimeoutMs?: number;
  readonly now: () => number;
  /** Takes one line of JSON for each call. */
  readonly writeLog: (line: string) => void;
}

export interface App {
  handle(req: IncomingMessage, res: ServerResponse): Promise<void>;
  readonly store: TenantStore;
}

type HostClass = 'token' | 'mtls' | 'other';

/** What the log line of a call needs, filled as the call goes on. */
interface Draft {
  method: string;
  path: string;
  host: HostClass;
  tenant: string | null;
  route: string | null;
  credential: LogLine['credential'];
  trace: CallTrace;
  /** The methods that the path takes, for the answer 405. */
  allow: string | null;
  /** `system`: a call to a system of a tenant, which goes to the log of the tenant. `record`: a read of the state or the log. `health`: no log line at all. */
  kind: 'system' | 'record' | 'operator' | 'health' | 'none';
}

/** How many header fields with this name the request has, from the raw list that Node keeps (it joins them in `headers`, and it drops a second `Host` or `Authorization`). */
function headerCount(req: IncomingMessage, name: string): number {
  let count = 0;
  for (let index = 0; index < req.rawHeaders.length; index += 2) if (req.rawHeaders[index]!.toLowerCase() === name) count += 1;
  return count;
}

function headerText(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return typeof value === 'string' ? value : undefined;
}

/** The path of a request target, as it was sent (no query), or null when the target is no path. */
function pathOf(target: string | undefined): string | null {
  if (target === undefined || !target.startsWith('/')) return null;
  const cut = target.indexOf('?');
  return cut < 0 ? target : target.slice(0, cut);
}

const sha256 = (value: string): Buffer => createHash('sha256').update(value, 'utf8').digest();

/** The operator token as `Authorization: Bearer <token>` carries it, compared in constant time with the token of the setting. A missing token is compared too, so that the time is the same. */
function operatorTokenMatches(header: string | undefined, expected: string): boolean {
  const given = header === undefined ? undefined : BEARER.exec(header.trim())?.[1];
  const equal = timingSafeEqual(sha256(given ?? ''), sha256(expected));
  return given !== undefined && equal;
}

/** The X.509-SVID that the proxy passed in `Client-Cert` (RFC 9440): exactly one header, in the form of the contract, and the bytes of the DER. */
function clientCertificate(req: IncomingMessage): Outcome<Buffer> {
  const count = headerCount(req, 'client-cert');
  if (count === 0) return refuse('svid_missing', 'client_certificate.missing', 'the request has no client certificate: present the X.509-SVID as the TLS client certificate');
  if (count > 1) return refuse('client_certificate_multiple', 'client_certificate.multiple', `the request has ${count} Client-Cert headers, and the proxy sets one`);
  const match = HEADER_FORM.exec(headerText(req, 'client-cert') ?? '');
  if (match === null) return refuse('client_certificate_malformed', 'client_certificate.malformed', 'the Client-Cert header is not a colon, the base64 of the DER of a certificate, and a colon');
  return pass(Buffer.from(match[1]!, 'base64'));
}

/**
 * The `Authorization` header: at most one. Node keeps the first of two and drops the second, so a second one would never be seen. A request with two is refused: it is not clear which one
 * the caller means.
 */
function authorizationOf(req: IncomingMessage): Outcome<string | undefined> {
  const count = headerCount(req, 'authorization');
  if (count > 1) return refuse('bad_request', 'authorization.multiple', `the request has ${count} Authorization headers, and it must have one`);
  return pass(headerText(req, 'authorization'));
}

/** The JWT-SVID of `Authorization: Bearer <jwt>`. */
function bearerJwt(req: IncomingMessage): Outcome<string> {
  const authorization = authorizationOf(req);
  if (!authorization.ok) return authorization;
  const header = authorization.value;
  if (header === undefined || header.trim() === '') return refuse('svid_missing', 'jwt_svid.missing', 'the request has no Authorization header with a JWT-SVID');
  const token = BEARER.exec(header.trim())?.[1];
  if (token === undefined || !JWT_FORM.test(token)) return refuse('svid_invalid', 'jwt_svid.scheme', 'the Authorization header is not Bearer and a JWT');
  return pass(token);
}

/** The JSON body of a POST. 415 for another type, 413 for a body over the limit, 400 for text that is not JSON. */
async function readJson(req: IncomingMessage): Promise<Outcome<unknown>> {
  const type = (headerText(req, 'content-type') ?? '').split(';')[0]!.trim().toLowerCase();
  if (type !== 'application/json') return refuse('unsupported_media_type', 'body.media_type', 'the body of this route is application/json');
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    const piece = Buffer.from(chunk);
    bytes += piece.length;
    if (bytes > MAX_BODY_BYTES) return refuse('body_too_large', 'body.size', `the body is larger than ${MAX_BODY_BYTES} bytes`);
    chunks.push(piece);
  }
  const raw = Buffer.concat(chunks, bytes).toString('utf8');
  if (raw.trim() === '') return refuse('bad_request', 'body.empty', 'the body is empty: send a JSON document');
  try {
    return pass(JSON.parse(raw));
  } catch {
    return refuse('bad_request', 'body.json', 'the body is not JSON');
  }
}

/** The `WWW-Authenticate` challenge that goes with a 401, by the credential that the route takes. */
function challengeOf(credential: Draft['credential']): string | null {
  if (credential === 'token') return 'DPoP algs="ES256 EdDSA"';
  return credential === 'jwt-svid' || credential === 'operator' ? 'Bearer' : null;
}

export function createApp(deps: AppDeps): App {
  const { config, identity, now } = deps;
  const approvalTimeoutMs = deps.approvalTimeoutMs ?? APPROVAL_TIMEOUT_MS;
  const store = new TenantStore({ now });

  const isoNow = (): string => new Date(now()).toISOString();

  function hostClassOf(req: IncomingMessage): HostClass | 'duplicate' {
    if (headerCount(req, 'host') !== 1) return 'duplicate';
    const given = (headerText(req, 'host') ?? '').toLowerCase();
    // The host name as a client writes it for https: with no port, or with the default port 443 as the proxy passes it.
    const same = (host: string): boolean => given === host || (!host.includes(':') && given === `${host}:443`);
    if (same(config.publicHost)) return 'token';
    return same(config.mtlsHost) ? 'mtls' : 'other';
  }

  /** `POST /admin/tenants`: makes a tenant, or makes it again from the seed. The operator token is the one need. */
  async function adminTenants(req: IncomingMessage, draft: Draft): Promise<Outcome<Ok>> {
    draft.credential = 'operator';
    draft.kind = 'operator';
    const authorization = authorizationOf(req);
    if (!authorization.ok) return authorization;
    if (!operatorTokenMatches(authorization.value, config.operatorToken)) return refuse('operator_token_invalid', 'operator.token', 'the operator token is missing or wrong');
    const body = await readJson(req);
    if (!body.ok) return body;
    const o = fields('body', body.value, ['tenant', 'organisations'], ['seed']);
    const name = text('body.tenant', o.tenant, { max: 48, pattern: TENANT, words: 'must be 1 to 48 lower case letters, digits or hyphens, and start with a letter or a digit' });
    const roles = fields('body.organisations', o.organisations, ['supplier', 'insurer']);
    const organisations = { supplier: domain('body.organisations.supplier', roles.supplier), insurer: domain('body.organisations.insurer', roles.insurer) };
    const seed = parseSeed('body.seed', o.seed);
    draft.tenant = name;
    const made = store.put(name, organisations, seed);
    if (!made.ok) return made;
    const resources = Object.fromEntries(TOKEN_SYSTEMS.map((system) => [system, systemUrl(config.publicBase, name, system)]));
    return pass({
      status: made.value.created ? 201 : 200,
      body: {
        tenant: name, created: made.value.created, organisations, base: `${config.publicBase}/t/${name}`, resources,
        audiences: { [JWT_AUDIENCE_SYSTEM]: systemUrl(config.publicBase, name, JWT_AUDIENCE_SYSTEM) }, counts: made.value.tenant.counts(),
      },
    });
  }

  interface Caller {
    actor: Actor | null;
    sender: string | null;
  }

  /** Meets the need of a route, and gives who made the call. */
  async function verifyCaller(req: IncomingMessage, draft: Draft, route: Route, tenant: Tenant, path: string): Promise<Outcome<Caller>> {
    const { need } = route;
    switch (need.kind) {
      case 'open':
        return pass({ actor: null, sender: null });
      case 'token': {
        draft.credential = 'token';
        const resource = systemUrl(config.publicBase, tenant.id, need.system);
        const authorization = authorizationOf(req);
        if (!authorization.ok) return authorization;
        const call = { method: req.method ?? '', url: `${config.publicBase}${path}`, authorization: authorization.value, dpop: headerText(req, 'dpop') };
        const auth = await authorizeToken(identity, call, { action: need.action, resource, maxActors: need.maxActors }, draft.trace);
        return auth.ok ? pass({ actor: auth.value.actor, sender: auth.value.sender }) : auth;
      }
      case 'x509': {
        draft.credential = 'x509-svid';
        const certificate = clientCertificate(req);
        if (!certificate.ok) return certificate;
        const auth = await authorizeX509Svid(identity, certificate.value, tenant.organisations.supplier, draft.trace);
        return auth.ok ? pass({ actor: auth.value.actor, sender: null }) : auth;
      }
      case 'jwt': {
        draft.credential = 'jwt-svid';
        const token = bearerJwt(req);
        if (!token.ok) return token;
        const auth = await authorizeJwtSvid(identity, token.value, systemUrl(config.publicBase, tenant.id, JWT_AUDIENCE_SYSTEM), tenant.organisations.insurer, draft.trace);
        return auth.ok ? pass({ actor: auth.value.actor, sender: null }) : auth;
      }
      case 'admin':
        return refuse('internal', 'route.need', 'a route of a tenant cannot need the operator token');
    }
  }

  async function tenantCall(req: IncomingMessage, draft: Draft, path: string, host: HostClass): Promise<Outcome<Ok>> {
    const rest = path.split('/').slice(1);
    const named = TENANT.test(rest[1] ?? '') ? rest[1]! : null;
    if (rest[0] !== 't' || named === null || rest.length < 3) return refuse('not_found', 'route.none', 'no such route');
    let segments: string[];
    try {
      segments = rest.slice(2).map((segment) => decodeURIComponent(segment));
    } catch {
      return refuse('bad_request', 'request.path', 'the path has a percent escape that is not valid');
    }
    const { routes, params } = matchRoutes(segments);
    if (routes.length === 0) return refuse('not_found', 'route.none', 'no such route');
    const route = routes.find((candidate) => candidate.method === req.method);
    if (route === undefined) {
      draft.allow = routes.map((candidate) => candidate.method).join(', ');
      return refuse('method_not_allowed', 'route.method', `this path takes ${draft.allow}`);
    }
    draft.route = route.id;
    draft.tenant = named;
    draft.kind = route.need.kind === 'open' ? 'record' : 'system';
    const wantsMtls = route.need.kind === 'x509';
    if (wantsMtls && host !== 'mtls') return refuse('wrong_host', 'host.mtls_only', 'this route takes the client certificate, and only on the client-certificate host');
    if (!wantsMtls && host !== 'token') return refuse('wrong_host', 'host.token_only', 'this route is served on the host of tokens, not on the client-certificate host');
    const tenant = store.get(named);
    if (tenant === undefined) return refuse('tenant_not_found', 'tenant.missing', `there is no tenant ${named}: make it with POST /admin/tenants`);

    const caller = await verifyCaller(req, draft, route, tenant, path);
    if (!caller.ok) return caller;
    for (const [name, value] of Object.entries(params)) if (!ID.test(value)) return refuse('bad_request', 'request.path', `the path parameter ${name} must be 1 to 64 letters, digits, dots, hyphens or underscores`);
    let body: unknown;
    if (route.method === 'POST') {
      const read = await readJson(req);
      if (!read.ok) return read;
      body = read.value;
    }
    // The caller was verified for this tenant, with its organisations. A tenant that was made again while the checks ran is another tenant: the call is not honoured for it.
    if (store.get(named) !== tenant) return refuse('tenant_changed', 'tenant.changed', `the tenant ${named} was made again while the call ran: send the call again`);
    const call: Call = { tenant, current: () => store.get(named), params, body, actor: caller.value.actor, sender: caller.value.sender, now, approvalCheck: deps.approvalCheck, approvalTimeoutMs, identity, trace: draft.trace };
    try {
      return await route.handle(call);
    } catch (error) {
      if (error instanceof Invalid) return refuse('bad_request', 'body.shape', error.message);
      throw error;
    }
  }

  async function dispatch(req: IncomingMessage, draft: Draft): Promise<Outcome<Ok>> {
    const path = pathOf(req.url);
    if (path === null) return refuse('bad_request', 'request.target', 'the request target must be a path that starts with /');
    draft.path = flatText(path, 200);
    if (req.method === 'GET' && path === '/healthz') {
      draft.kind = 'health';
      return pass({ status: 200, body: { ok: true } });
    }
    const host = hostClassOf(req);
    if (host === 'duplicate') return refuse('bad_request', 'host.header', 'the request must have exactly one Host header');
    draft.host = host;
    if (host === 'other') return refuse('wrong_host', 'host.unknown', 'the Host header names none of the two hosts of this service');
    if (host === 'token' && headerCount(req, 'client-cert') > 0) return refuse('client_certificate_unexpected', 'client_certificate.host', 'the Client-Cert header is valid on the client-certificate host only');
    if (path === '/admin/tenants') {
      if (req.method !== 'POST') {
        draft.allow = 'POST';
        return refuse('method_not_allowed', 'route.method', 'this path takes POST');
      }
      draft.route = 'POST /admin/tenants';
      if (host !== 'token') return refuse('wrong_host', 'host.token_only', 'this route is served on the host of tokens, not on the client-certificate host');
      return adminTenants(req, draft);
    }
    return tenantCall(req, draft, path, host);
  }

  function lineOf(draft: Draft, outcome: Outcome<Ok>): LogLine {
    const { trace } = draft;
    return {
      at: isoNow(), tenant: draft.tenant, route: draft.route, method: draft.method, path: draft.path, host: draft.host, credential: draft.credential, sub: trace.sub, act: trace.act,
      delegation: trace.delegation, decision: outcome.ok ? 'allowed' : 'refused', status: outcome.ok ? outcome.value.status : outcome.refusal.status, code: outcome.ok ? null : outcome.refusal.code,
      rule: outcome.ok ? null : outcome.refusal.rule, token_status: outcome.ok ? trace.tokenStatus : null,
    };
  }

  function respond(res: ServerResponse, draft: Draft, outcome: Outcome<Ok>): void {
    const status = outcome.ok ? outcome.value.status : outcome.refusal.status;
    const payload = JSON.stringify(outcome.ok ? outcome.value.body : { error: outcome.refusal.code, message: outcome.refusal.message });
    const headers: Record<string, string | number> = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(payload) };
    if (status === 401) {
      const challenge = challengeOf(draft.credential);
      if (challenge !== null) headers['www-authenticate'] = challenge;
    }
    if (status === 405 && draft.allow !== null) headers.allow = draft.allow;
    res.writeHead(status, headers);
    res.end(payload);
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const draft: Draft = { method: req.method ?? '', path: '', host: 'other', tenant: null, route: null, credential: 'none', trace: newTrace(), allow: null, kind: 'none' };
    let outcome: Outcome<Ok>;
    try {
      outcome = await dispatch(req, draft);
    } catch (error) {
      if (error instanceof Invalid) {
        // A value from the caller that is not as the reader needs it: the caller's fault, whatever route read it.
        outcome = refuse('bad_request', 'body.shape', error.message);
      } else {
        deps.writeLog(JSON.stringify({ at: isoNow(), event: 'error', route: draft.route, tenant: draft.tenant, message: errorText(error, 300) }));
        outcome = refuse('internal', 'internal', 'the service failed, and the call was not honoured');
      }
    }
    if (draft.kind !== 'health') {
      const line = lineOf(draft, outcome);
      deps.writeLog(JSON.stringify(line));
      if (draft.kind === 'system' && draft.tenant !== null) store.get(draft.tenant)?.log(line);
    }
    try {
      respond(res, draft, outcome);
    } catch (error) {
      deps.writeLog(JSON.stringify({ at: isoNow(), event: 'error', route: draft.route, tenant: draft.tenant, message: errorText(error, 300) }));
      res.destroy();
    }
  }

  return { handle, store };
}
