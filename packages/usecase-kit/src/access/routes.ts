// packages/usecase-kit/src/access/routes.ts
// The routes of the mock systems that an agent calls, with what each route needs, and the target of one call. A token is asked for one route: its action and its resource come from the
// target, and a call checks them again before it sends anything. The resource of a system is the exact public URL `<public base>/t/<tenant>/<system>`.
import { accepted, parseTenantId, refused, type ProtocolResult } from '../protocol/index.ts';

export const SYSTEMS = ['erp', 'po', 'records', 'guidelines', 'vendors', 'sourcing', 'supplier', 'insurer'] as const;
export type SystemName = (typeof SYSTEMS)[number];

export type HttpMethod = 'GET' | 'POST';
export type CredentialKind = 'token' | 'x509-svid' | 'jwt-svid';
/** Who may call a route with a token. A subagent has an act chain of two links, and a route that takes the agent only refuses it. */
export type TokenCallers = 'agent' | 'agent-or-subagent';

interface TokenRouteSpec {
  readonly method: HttpMethod;
  readonly system: SystemName;
  /** The path after `/t/<tenant>`. A name in braces is a path parameter. */
  readonly template: string;
  readonly credential: 'token';
  readonly action: string;
  readonly callers: TokenCallers;
}
interface SvidRouteSpec {
  readonly method: HttpMethod;
  readonly system: SystemName;
  readonly template: string;
  readonly credential: 'x509-svid' | 'jwt-svid';
}

/** The routes with a credential, by name. A name has the system and the part of the route. */
export const ROUTES = {
  'erp.stock': { method: 'GET', system: 'erp', template: '/erp/stock/{sku}', credential: 'token', action: 'erp.stock.read', callers: 'agent-or-subagent' },
  'po.write': { method: 'POST', system: 'po', template: '/po', credential: 'token', action: 'po.write', callers: 'agent' },
  'records.order': { method: 'GET', system: 'records', template: '/records/orders/{order_id}', credential: 'token', action: 'record.read', callers: 'agent-or-subagent' },
  'guidelines.read': { method: 'GET', system: 'guidelines', template: '/guidelines/{code}', credential: 'token', action: 'guideline.read', callers: 'agent-or-subagent' },
  'records.submission': { method: 'POST', system: 'records', template: '/records/orders/{order_id}/submission', credential: 'token', action: 'priorauth.submit', callers: 'agent' },
  'vendors.list': { method: 'GET', system: 'vendors', template: '/vendors', credential: 'token', action: 'vendor.read', callers: 'agent-or-subagent' },
  'sourcing.rankings': { method: 'POST', system: 'sourcing', template: '/sourcing/rankings', credential: 'token', action: 'sourcing.award.write', callers: 'agent' },
  'supplier.catalogue': { method: 'GET', system: 'supplier', template: '/supplier/catalogue/{sku}', credential: 'x509-svid' },
  'supplier.orders': { method: 'POST', system: 'supplier', template: '/supplier/orders', credential: 'x509-svid' },
  'insurer.requirements': { method: 'GET', system: 'insurer', template: '/insurer/requirements/{service_code}', credential: 'jwt-svid' },
  'insurer.requests': { method: 'POST', system: 'insurer', template: '/insurer/requests', credential: 'jwt-svid' },
} as const satisfies Record<string, TokenRouteSpec | SvidRouteSpec>;

export type RouteId = keyof typeof ROUTES;
type RouteIdOf<K extends CredentialKind> = { [R in RouteId]: (typeof ROUTES)[R]['credential'] extends K ? R : never }[RouteId];
export type TokenRouteId = RouteIdOf<'token'>;
export type X509RouteId = RouteIdOf<'x509-svid'>;
export type JwtSvidRouteId = RouteIdOf<'jwt-svid'>;

/** The two origins of the mock service: the host of tokens and JWT-SVIDs, and the host that asks for a client certificate. They are two hosts. */
export interface MockBases {
  /** The setting `MOCK_PUBLIC_BASE` of the service: an https origin, for example `https://mock.example.org`. */
  readonly publicBase: string;
  /** The setting `MOCK_MTLS_BASE` of the service: the https origin of the client-certificate host. */
  readonly mtlsBase: string;
}

interface TargetBase {
  readonly route: RouteId;
  readonly method: HttpMethod;
  readonly system: SystemName;
  /** The exact public URL of the call, with its path parameters. It has no query. */
  readonly url: string;
  /** `<public base>/t/<tenant>/<system>`: the resource of a token, and the audience of a JWT-SVID. */
  readonly resource: string;
}
export interface TokenTarget extends TargetBase {
  readonly credential: 'token';
  readonly action: string;
  readonly callers: TokenCallers;
}
export interface X509Target extends TargetBase {
  readonly credential: 'x509-svid';
}
export interface JwtSvidTarget extends TargetBase {
  readonly credential: 'jwt-svid';
  /** The audience of the JWT-SVID for this route: the resource of the system. */
  readonly audience: string;
}
export type RouteTarget = TokenTarget | X509Target | JwtSvidTarget;

/** The origin of a base: https only, because a resource of a delegation is an https URL. No user, path, query or fragment. */
export function originOf(base: unknown, field: string): ProtocolResult<string> {
  if (typeof base !== 'string') return refused('bad_shape', `${field} must be text`);
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    return refused('bad_shape', `${field} must be a URL`);
  }
  if (url.protocol !== 'https:') return refused('bad_shape', `${field} must be an https URL`);
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '' || url.pathname !== '/') return refused('bad_shape', `${field} must be an origin: no user, no path, no query and no fragment`);
  return accepted(url.origin);
}

const PARAMETER = /\{([a-z_]+)\}/g;
const MAX_PARAMETER_CHARS = 128;

/** The path of a template with its parameters. A value is one path segment: it is not empty, it is not `.` or `..`, it has no slash and no backslash, and it is percent-encoded. */
function pathOf(template: string, params: Readonly<Record<string, unknown>>): ProtocolResult<string> {
  const names = [...template.matchAll(PARAMETER)].map((match) => match[1]!);
  for (const name of Object.keys(params)) if (!names.includes(name)) return refused('bad_shape', `the route has no path parameter ${name}`);
  let failure: string | null = null;
  const path = template.replace(PARAMETER, (_whole, name: string) => {
    const value = Object.hasOwn(params, name) ? params[name] : undefined;
    if (typeof value !== 'string' || value.length < 1 || value.length > MAX_PARAMETER_CHARS || value === '.' || value === '..' || value.includes('/') || value.includes('\\')) {
      failure ??= `the path parameter ${name} must be 1 to ${MAX_PARAMETER_CHARS} characters, with no slash and no backslash, and not "." or ".."`;
      return '';
    }
    return encodeURIComponent(value);
  });
  return failure === null ? accepted(path) : refused('bad_shape', failure);
}

function build(bases: MockBases, tenant: unknown, route: unknown, params: Readonly<Record<string, unknown>>): ProtocolResult<RouteTarget> {
  const publicOrigin = originOf(bases.publicBase, 'publicBase');
  if (!publicOrigin.ok) return publicOrigin;
  const mtlsOrigin = originOf(bases.mtlsBase, 'mtlsBase');
  if (!mtlsOrigin.ok) return mtlsOrigin;
  if (new URL(publicOrigin.value).host === new URL(mtlsOrigin.value).host) return refused('bad_shape', 'publicBase and mtlsBase must be two hosts');
  const tenantId = parseTenantId(tenant);
  if (!tenantId.ok) return tenantId;
  if (typeof route !== 'string' || !Object.hasOwn(ROUTES, route)) return refused('bad_shape', 'route is not a route of the mock systems');
  const id = route as RouteId;
  const spec: TokenRouteSpec | SvidRouteSpec = ROUTES[id];
  const path = pathOf(spec.template, params);
  if (!path.ok) return path;
  const origin = spec.credential === 'x509-svid' ? mtlsOrigin.value : publicOrigin.value;
  const resource = `${publicOrigin.value}/t/${tenantId.value}/${spec.system}`;
  const base: TargetBase = { route: id, method: spec.method, system: spec.system, url: `${origin}/t/${tenantId.value}${path.value}`, resource };
  if (spec.credential === 'token') return accepted({ ...base, credential: 'token', action: spec.action, callers: spec.callers });
  if (spec.credential === 'jwt-svid') return accepted({ ...base, credential: 'jwt-svid', audience: resource });
  return accepted({ ...base, credential: 'x509-svid' });
}

type Params = Readonly<Record<string, string>>;

/** The target of a call with an access token. */
export function tokenTarget(bases: MockBases, tenant: string, route: TokenRouteId, params: Params = {}): ProtocolResult<TokenTarget> {
  const target = build(bases, tenant, route, params);
  return target.ok && target.value.credential === 'token' ? accepted(target.value) : target.ok ? refused('bad_shape', 'route does not take an access token') : target;
}

/** The target of a call with an X.509-SVID, on the client-certificate host. */
export function x509Target(bases: MockBases, tenant: string, route: X509RouteId, params: Params = {}): ProtocolResult<X509Target> {
  const target = build(bases, tenant, route, params);
  return target.ok && target.value.credential === 'x509-svid' ? accepted(target.value) : target.ok ? refused('bad_shape', 'route does not take an X.509-SVID') : target;
}

/** The target of a call with a JWT-SVID. Its audience is the resource of the insurer system. */
export function jwtSvidTarget(bases: MockBases, tenant: string, route: JwtSvidRouteId, params: Params = {}): ProtocolResult<JwtSvidTarget> {
  const target = build(bases, tenant, route, params);
  return target.ok && target.value.credential === 'jwt-svid' ? accepted(target.value) : target.ok ? refused('bad_shape', 'route does not take a JWT-SVID') : target;
}
