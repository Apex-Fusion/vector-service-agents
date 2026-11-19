// packages/id-kit/test/access-token-policy.test.ts: the shape of the policy of a call, checked by the pure function and by the check of the token. A mistake of the caller throws a TypeError
// before the check reads the token.
import { describe, expect, it } from 'vitest';
import { assertPolicy, checkAccessToken } from '../src/verify/access-token.ts';
import { createReplayStore } from '../src/verify/index.ts';

const GOOD = { action: 'erp.stock.read', resource: 'https://mp-mock.example/t/1/erp' };
type Policy = { require?: unknown; acceptDirect?: unknown };

describe('assertPolicy', () => {
  it.each<[string, Policy]>([
    ['no require and no acceptDirect', {}],
    ['require undefined', { require: undefined }],
    ['require null, which is none', { require: null }],
    ['a require', { require: GOOD }],
    ['a require with acceptDirect true', { require: GOOD, acceptDirect: true }],
    ['a require with acceptDirect false', { require: GOOD, acceptDirect: false }],
    ['acceptDirect false with no require', { acceptDirect: false }],
  ])('accepts %s', (_name, policy) => {
    expect(() => assertPolicy(policy)).not.toThrow();
  });

  it.each<[string, Policy, RegExp]>([
    ['acceptDirect as the text false', { require: GOOD, acceptDirect: 'false' }, /acceptDirect is true or false/],
    ['acceptDirect as a number', { require: GOOD, acceptDirect: 1 }, /acceptDirect is true or false/],
    ['acceptDirect null', { require: GOOD, acceptDirect: null }, /acceptDirect is true or false/],
    ['acceptDirect true with no require', { acceptDirect: true }, /acceptDirect goes with require/],
    ['require as an empty object', { require: {} }, /require is an object/],
    ['require with no resource', { require: { action: GOOD.action } }, /require is an object/],
    ['require with no action', { require: { resource: GOOD.resource } }, /require is an object/],
    ['require with an action that is no text', { require: { action: 1, resource: GOOD.resource } }, /require is an object/],
    ['require with a resource that is no text', { require: { action: GOOD.action, resource: null } }, /require is an object/],
    ['require as text', { require: 'erp.stock.read' }, /require is an object/],
    ['require as a list', { require: [] }, /require is an object/],
    ['an action that is a pattern', { require: { action: 'erp.*', resource: GOOD.resource } }, /concrete values/],
    ['a resource that is a pattern', { require: { action: GOOD.action, resource: '*' } }, /concrete values/],
  ])('refuses %s with a TypeError', (_name, policy, text) => {
    expect(() => assertPolicy(policy)).toThrow(TypeError);
    expect(() => assertPolicy(policy)).toThrow(text);
  });
});

describe('checkAccessToken', () => {
  it('checks the policy first: a policy that is wrong throws before the token is read, and a policy that is right goes on to the token', () => {
    const request = { accessToken: 'not a token', dpop: undefined, method: 'POST', url: 'https://mp-mock.example/t/1/erp/stock' };
    const ctx = { keys: new Map(), issuer: 'https://mp-mock.example', audience: GOOD.resource, nowMs: 0, leewaySeconds: 30, maxLifetimeSeconds: 300, maxActDepth: 4, replay: createReplayStore(), require: null, acceptDirect: false };
    expect(checkAccessToken(request, ctx)).toMatchObject({ ok: false, rule: 'token.malformed' });
    expect(() => checkAccessToken(request, { ...ctx, acceptDirect: 'false' as never })).toThrow(TypeError);
    expect(() => checkAccessToken(request, { ...ctx, require: {} as never })).toThrow(TypeError);
  });
});
