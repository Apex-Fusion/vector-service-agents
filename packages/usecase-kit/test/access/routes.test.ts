// packages/usecase-kit/test/access/routes.test.ts: the route table, and the target of one call. Each refusal has an accepted twin.
import { describe, expect, it } from 'vitest';
import { ROUTES, jwtSvidTarget, tokenTarget, x509Target } from '../../src/access/index.ts';
import type { MockBases, RouteId, TokenRouteId } from '../../src/access/index.ts';
import { BASES } from './support.ts';

/** The routes of the mock systems, as the protocol lists them: the method, the path, what the route needs, and who may call it with a token. */
const EXPECTED: Record<RouteId, { method: string; template: string; credential: string; action?: string; callers?: string }> = {
  'erp.stock': { method: 'GET', template: '/erp/stock/{sku}', credential: 'token', action: 'erp.stock.read', callers: 'agent-or-subagent' },
  'po.write': { method: 'POST', template: '/po', credential: 'token', action: 'po.write', callers: 'agent' },
  'records.order': { method: 'GET', template: '/records/orders/{order_id}', credential: 'token', action: 'record.read', callers: 'agent-or-subagent' },
  'guidelines.read': { method: 'GET', template: '/guidelines/{code}', credential: 'token', action: 'guideline.read', callers: 'agent-or-subagent' },
  'records.submission': { method: 'POST', template: '/records/orders/{order_id}/submission', credential: 'token', action: 'priorauth.submit', callers: 'agent' },
  'vendors.list': { method: 'GET', template: '/vendors', credential: 'token', action: 'vendor.read', callers: 'agent-or-subagent' },
  'sourcing.rankings': { method: 'POST', template: '/sourcing/rankings', credential: 'token', action: 'sourcing.award.write', callers: 'agent' },
  'supplier.catalogue': { method: 'GET', template: '/supplier/catalogue/{sku}', credential: 'x509-svid' },
  'supplier.orders': { method: 'POST', template: '/supplier/orders', credential: 'x509-svid' },
  'insurer.requirements': { method: 'GET', template: '/insurer/requirements/{service_code}', credential: 'jwt-svid' },
  'insurer.requests': { method: 'POST', template: '/insurer/requests', credential: 'jwt-svid' },
};

describe('the route table', () => {
  it('holds exactly the routes of the mock systems, with what each needs', () => {
    expect(Object.keys(ROUTES).sort()).toStrictEqual(Object.keys(EXPECTED).sort());
    for (const [id, spec] of Object.entries(ROUTES)) expect(spec, id).toMatchObject(EXPECTED[id as RouteId]);
  });

  it('lets the agent alone call each write route, and lets a subagent read', () => {
    const writes = Object.entries(ROUTES).filter(([, spec]) => spec.method === 'POST' && spec.credential === 'token');
    expect(writes.length).toBe(3);
    for (const [id, spec] of writes) expect(spec, id).toMatchObject({ callers: 'agent' });
    for (const id of ['erp.stock', 'records.order', 'guidelines.read', 'vendors.list']) expect(ROUTES[id as TokenRouteId], id).toMatchObject({ callers: 'agent-or-subagent' });
  });
});

describe('the target of a token route', () => {
  it('has the exact public URL of the resource, and the URL of the call', () => {
    const target = tokenTarget(BASES, 'run1', 'erp.stock', { sku: 'GLV-NIT-M' });
    expect(target).toStrictEqual({
      ok: true,
      value: {
        route: 'erp.stock', method: 'GET', system: 'erp', credential: 'token', action: 'erp.stock.read', callers: 'agent-or-subagent',
        resource: 'https://mock.example/t/run1/erp', url: 'https://mock.example/t/run1/erp/stock/GLV-NIT-M',
      },
    });
  });

  it('has the resource of its system for every token route: the system, and not the route', () => {
    const records = tokenTarget(BASES, 'run1', 'records.order', { order_id: 'ORD-1001' });
    const submission = tokenTarget(BASES, 'run1', 'records.submission', { order_id: 'ORD-1001' });
    expect(records.ok && submission.ok && records.value.resource === submission.value.resource).toBe(true);
    expect(records.ok && submission.ok && records.value.action !== submission.value.action).toBe(true);
  });

  it('puts a path parameter in the path as one encoded segment, and refuses a slash and a backslash: a call refuses an encoded slash, so no target may hold one', () => {
    const target = tokenTarget(BASES, 'run1', 'erp.stock', { sku: 'A B' });
    expect(target.ok && target.value.url).toBe('https://mock.example/t/run1/erp/stock/A%20B');
    const marks = tokenTarget(BASES, 'run1', 'erp.stock', { sku: 'a?c#d%e' });
    expect(marks.ok && marks.value.url).toBe('https://mock.example/t/run1/erp/stock/a%3Fc%23d%25e');
    for (const sku of ['a/b', '/', 'a\\b', '..\\x']) expect(tokenTarget(BASES, 'run1', 'erp.stock', { sku }), sku).toMatchObject({ ok: false, code: 'bad_shape' });
  });

  it.each(['', '.', '..'])('refuses the path parameter %j, and accepts a name that only contains dots', (sku) => {
    expect(tokenTarget(BASES, 'run1', 'erp.stock', { sku })).toMatchObject({ ok: false, code: 'bad_shape' });
    expect(tokenTarget(BASES, 'run1', 'erp.stock', { sku: `${sku}a.` }).ok).toBe(true);
  });

  it('refuses a parameter that is too long, one that is missing, and one that the route does not have', () => {
    expect(tokenTarget(BASES, 'run1', 'erp.stock', { sku: 'x'.repeat(129) }).ok).toBe(false);
    expect(tokenTarget(BASES, 'run1', 'erp.stock', { sku: 'x'.repeat(128) }).ok).toBe(true);
    expect(tokenTarget(BASES, 'run1', 'erp.stock', {}).ok).toBe(false);
    expect(tokenTarget(BASES, 'run1', 'vendors.list', { sku: 'x' }).ok).toBe(false);
    expect(tokenTarget(BASES, 'run1', 'vendors.list').ok).toBe(true);
  });

  it('refuses a tenant that is not safe in a path, and accepts one that is', () => {
    for (const tenant of ['', '.', '..', 'a/b', '-run', 'a b', 'x'.repeat(65)]) expect(tokenTarget(BASES, tenant, 'vendors.list'), tenant).toMatchObject({ ok: false, code: 'bad_shape' });
    for (const tenant of ['run1', 'r', 'run-1_a.b', 'x'.repeat(64)]) expect(tokenTarget(BASES, tenant, 'vendors.list').ok, tenant).toBe(true);
  });

  it('refuses a route that is not in the table', () => {
    expect(tokenTarget(BASES, 'run1', 'admin.tenants' as TokenRouteId)).toMatchObject({ ok: false, code: 'bad_shape' });
    expect(tokenTarget(BASES, 'run1', '__proto__' as TokenRouteId).ok).toBe(false);
    expect(tokenTarget(BASES, 'run1', 'vendors.list').ok).toBe(true);
  });

  it('refuses the route of another credential', () => {
    expect(tokenTarget(BASES, 'run1', 'supplier.catalogue' as TokenRouteId, { sku: 'x' })).toMatchObject({ ok: false, code: 'bad_shape' });
    expect(x509Target(BASES, 'run1', 'erp.stock' as 'supplier.orders', { sku: 'x' }).ok).toBe(false);
    expect(jwtSvidTarget(BASES, 'run1', 'po.write' as 'insurer.requests').ok).toBe(false);
  });
});

describe('the bases', () => {
  it.each<[string, Partial<MockBases>]>([
    ['a path', { publicBase: 'https://mock.example/base' }],
    ['a query', { publicBase: 'https://mock.example/?a=1' }],
    ['a user', { publicBase: 'https://user@mock.example' }],
    ['http', { publicBase: 'http://mock.example' }],
    ['http on a loopback host', { publicBase: 'http://127.0.0.1:9120', mtlsBase: 'http://localhost:9120' }],
    ['text that is not a URL', { publicBase: 'mock.example' }],
    ['no client-certificate host', { mtlsBase: '' }],
    ['the host of tokens as the client-certificate host', { mtlsBase: 'https://mock.example' }],
  ])('refuses %s', (_name, over) => {
    expect(tokenTarget({ ...BASES, ...over }, 'run1', 'vendors.list')).toMatchObject({ ok: false, code: 'bad_shape' });
  });

  it('accepts https, with or without the closing slash, and with a port', () => {
    expect(tokenTarget({ publicBase: 'https://mock.example/', mtlsBase: 'https://mock-mtls.example' }, 'run1', 'vendors.list').ok).toBe(true);
    expect(tokenTarget({ publicBase: 'https://127.0.0.1:9120', mtlsBase: 'https://localhost:9120' }, 'run1', 'vendors.list').ok).toBe(true);
  });
});

describe('the target of an SVID route', () => {
  it('goes to the client-certificate host for an X.509-SVID, and keeps the resource on the host of tokens', () => {
    const target = x509Target(BASES, 'run1', 'supplier.catalogue', { sku: 'MSK-N95' });
    expect(target).toStrictEqual({
      ok: true,
      value: {
        route: 'supplier.catalogue', method: 'GET', system: 'supplier', credential: 'x509-svid', resource: 'https://mock.example/t/run1/supplier',
        url: 'https://mock-mtls.example/t/run1/supplier/catalogue/MSK-N95',
      },
    });
  });

  it('has the resource of the insurer system as the audience of a JWT-SVID, on the host of tokens', () => {
    const target = jwtSvidTarget(BASES, 'run1', 'insurer.requirements', { service_code: 'SYN-MRI-LS' });
    expect(target).toStrictEqual({
      ok: true,
      value: {
        route: 'insurer.requirements', method: 'GET', system: 'insurer', credential: 'jwt-svid', audience: 'https://mock.example/t/run1/insurer',
        resource: 'https://mock.example/t/run1/insurer', url: 'https://mock.example/t/run1/insurer/requirements/SYN-MRI-LS',
      },
    });
  });
});
