// The tenants over HTTP: the route that makes and resets them with the operator token, the tenant that does not exist, and one tenant that must never read or write the data of another.
// Each refusal has its accepted twin. The operator token is compared in constant time and is never in the log, the body of an answer or an error.
import { describe, expect, it } from 'vitest';
import { LOT_NAMES, defaultSeed } from '../src/seed.ts';
import { MAX_TENANTS } from '../src/tenants.ts';
import { callWithToken, delegateTo, insurerAgent, purchaseOrder, scenario, supplierAgent } from './support/scenario.ts';
import type { Scenario } from './support/scenario.ts';
import { INSURER_ORG, MTLS_HOST, OPERATOR_TOKEN, PUBLIC_BASE, PUBLIC_HOST, SUPPLIER_ORG } from './support/world.ts';

const refused = (reply: { status: number; json: Record<string, unknown> | null }, status: number, code: string) => {
  expect([reply.status, reply.json?.error]).toEqual([status, code]);
};
const lastRule = (s: Scenario): unknown => s.harness.logged().at(-1)?.rule;
const logOf = async (s: Scenario, tenant: string): Promise<Array<{ decision: string; code: string | null }>> => {
  const body = (await s.harness.call({ path: `/t/${tenant}/log` })).json as { lines: Array<{ decision: string; code: string | null }> }; // the shape of the answer of GET /log
  return body.lines;
};
const ORGS = { supplier: SUPPLIER_ORG, insurer: INSURER_ORG };

describe('POST /admin/tenants', () => {
  it('makes a tenant with the operator token, and says where its systems are', async () => {
    const s = await scenario('run1');
    const reply = await s.harness.seed('run2');
    expect(reply.status, reply.text).toBe(201);
    expect(reply.json).toEqual({
      tenant: 'run2', created: true, organisations: ORGS, base: `${PUBLIC_BASE}/t/run2`,
      resources: Object.fromEntries(['erp', 'po', 'records', 'guidelines', 'vendors', 'sourcing'].map((system) => [system, `${PUBLIC_BASE}/t/run2/${system}`])),
      audiences: { insurer: `${PUBLIC_BASE}/t/run2/insurer` },
      counts: { erp: 3, catalogue: 3, records: 2, guidelines: 2, requirements: 2, vendors: 3 },
    });
    expect((await s.harness.call({ path: '/t/run2/state' })).status).toBe(200);
  });
  it('makes it again from the seed: the answer is 200, and the writes and the log of the tenant are gone', async () => {
    const s = await scenario('run1');
    const agent = delegateTo(s, 'reorder', [['po.write', 'po']]);
    expect((await callWithToken(s, agent, 'po', 'POST', '/po', purchaseOrder('run1', 'run1-1'))).status).toBe(201);
    expect(((await s.harness.call({ path: '/t/run1/log' })).json!.lines as unknown[]).length).toBe(1);
    const again = await s.harness.seed('run1');
    expect([again.status, again.json?.created]).toEqual([200, false]);
    expect((await s.harness.call({ path: '/t/run1/state' })).json).toMatchObject({ po_store: { orders: [] } });
    expect((await s.harness.call({ path: '/t/run1/log' })).json).toEqual({ tenant: 'run1', dropped: 0, lines: [] });
    // A token that was made before the reset names the same resource, and the order that was written before is possible again: it is a new run.
    expect((await callWithToken(s, agent, 'po', 'POST', '/po', purchaseOrder('run1', 'run1-1'))).status).toBe(201);
  });
  it('takes a seed that replaces parts of the data, and the tenant serves that data and no other', async () => {
    const s = await scenario('run1');
    const erp = [{ sku: 'ONLY-ONE', on_hand: 1, threshold: 5, daily_usage: 2, lead_time_days: 3, open_orders: 0 }];
    expect((await s.harness.seed('run2', { seed: { erp } })).status).toBe(201);
    const agent = delegateTo(s, 'reader', [['erp.stock.read', 'erp']], { tenant: 'run2' });
    expect((await callWithToken(s, agent, 'erp', 'GET', '/erp/stock/ONLY-ONE', undefined, 'run2')).json).toEqual(erp[0]);
    expect((await callWithToken(s, agent, 'erp', 'GET', '/erp/stock/GLV-NIT-M', undefined, 'run2')).status).toBe(404);
  });
  it('is refused with no operator token, a wrong one, and a token that is in the wrong place, with the challenge', async () => {
    const s = await scenario('run1');
    const none = await s.harness.call({ method: 'POST', path: '/admin/tenants', body: { tenant: 'run2', organisations: ORGS } });
    refused(none, 401, 'operator_token_invalid');
    expect(none.headers['www-authenticate']).toBe('Bearer');
    expect(lastRule(s)).toBe('operator.token');
    const bodies = { tenant: 'run2', organisations: ORGS };
    for (const headers of ([
      { authorization: 'Bearer wrong-token-wrong-token-wrong-token-0000' },
      { authorization: `Bearer ${OPERATOR_TOKEN.slice(0, -1)}` },
      { authorization: `Bearer ${OPERATOR_TOKEN}x` },
      { authorization: `Bearer ${OPERATOR_TOKEN.toUpperCase()}` },
      { authorization: `Basic ${OPERATOR_TOKEN}` },
      { authorization: OPERATOR_TOKEN },
      { authorization: 'Bearer' },
      { authorization: `Bearer  ${OPERATOR_TOKEN} extra` },
      { 'x-operator-token': OPERATOR_TOKEN },
      { cookie: `token=${OPERATOR_TOKEN}` },
    ] as Array<Record<string, string>>)) {
      refused(await s.harness.call({ method: 'POST', path: '/admin/tenants', headers, body: bodies }), 401, 'operator_token_invalid');
    }
    refused(await s.harness.call({ method: 'POST', path: `/admin/tenants?token=${OPERATOR_TOKEN}`, body: bodies }), 401, 'operator_token_invalid');
    expect((await s.harness.call({ path: '/t/run2/state' })).status).toBe(404);
    expect((await s.harness.seed('run2')).status).toBe(201);
  });
  it('takes the scheme in any case, as the HTTP authorization scheme is', async () => {
    const s = await scenario('run1');
    const reply = await s.harness.call({ method: 'POST', path: '/admin/tenants', headers: { authorization: `bearer ${OPERATOR_TOKEN}` }, body: { tenant: 'run2', organisations: ORGS } });
    expect(reply.status).toBe(201);
  });
  it('is refused with two Authorization headers, even when one is right', async () => {
    const s = await scenario('run1');
    const reply = await s.harness.call({ method: 'POST', path: '/admin/tenants', headers: { authorization: [`Bearer ${OPERATOR_TOKEN}`, 'Bearer other'] }, body: { tenant: 'run2', organisations: ORGS } });
    refused(reply, 400, 'bad_request');
    expect(lastRule(s)).toBe('authorization.multiple');
  });
  it('is served on the host of tokens only, and it takes POST only', async () => {
    const s = await scenario('run1');
    const headers = { authorization: `Bearer ${OPERATOR_TOKEN}` };
    refused(await s.harness.call({ method: 'POST', path: '/admin/tenants', host: MTLS_HOST, headers, body: { tenant: 'run2', organisations: ORGS } }), 421, 'wrong_host');
    const get = await s.harness.call({ path: '/admin/tenants', headers });
    refused(get, 405, 'method_not_allowed');
    expect(get.headers.allow).toBe('POST');
    refused(await s.harness.call({ method: 'DELETE', path: '/admin/tenants', headers }), 405, 'method_not_allowed');
    expect((await s.harness.call({ path: '/t/run2/state' })).status).toBe(404);
  });
  it('is refused for a body that is not right, with the path of the field, and makes no tenant', async () => {
    const s = await scenario('run1');
    const post = (body: unknown, contentType?: string | null) => s.harness.call({ method: 'POST', path: '/admin/tenants', headers: { authorization: `Bearer ${OPERATOR_TOKEN}` }, body, ...(contentType === undefined ? {} : { contentType }) });
    const bad: Array<[string, unknown, RegExp]> = [
      ['no tenant', { organisations: ORGS }, /body\.tenant is required/],
      ['an upper case tenant', { tenant: 'Run2', organisations: ORGS }, /body\.tenant must be 1 to 48 lower case/],
      ['a tenant with a slash', { tenant: 'a/b', organisations: ORGS }, /body\.tenant must be/],
      ['a tenant with a dot', { tenant: '..', organisations: ORGS }, /body\.tenant must be/],
      ['a tenant that is too long', { tenant: 'a'.repeat(49), organisations: ORGS }, /body\.tenant must have 1 to 48 characters/],
      ['an empty tenant', { tenant: '', organisations: ORGS }, /body\.tenant must have/],
      ['a tenant that is a number', { tenant: 5, organisations: ORGS }, /body\.tenant must be a text/],
      ['no organisations', { tenant: 'run2' }, /body\.organisations is required/],
      ['an organisation that is no domain', { tenant: 'run2', organisations: { supplier: 'Supplier', insurer: INSURER_ORG } }, /body\.organisations\.supplier must be a domain name/],
      ['one organisation only', { tenant: 'run2', organisations: { supplier: SUPPLIER_ORG } }, /body\.organisations\.insurer is required/],
      ['a third organisation', { tenant: 'run2', organisations: { ...ORGS, buyer: 'buyer.example.test' } }, /body\.organisations\.buyer is not a field/],
      ['a field that is not named', { tenant: 'run2', organisations: ORGS, reset: true }, /body\.reset is not a field/],
      ['a seed part that is not a part', { tenant: 'run2', organisations: ORGS, seed: { stock: [] } }, /body\.seed\.stock is not a field/],
      ['a seed value of the wrong type', { tenant: 'run2', organisations: ORGS, seed: { erp: [{ ...defaultSeed().erp[0], on_hand: '60' }] } }, /body\.seed\.erp\[0\]\.on_hand must be a whole number/],
      ['a list', [], /body must be a JSON object/],
    ];
    for (const [name, body, message] of bad) {
      const reply = await post(body);
      refused(reply, 400, 'bad_request');
      expect(reply.json?.message, name).toMatch(message);
    }
    refused(await post('{broken'), 400, 'bad_request');
    refused(await post(JSON.stringify({ tenant: 'run2', organisations: ORGS }), 'text/plain'), 415, 'unsupported_media_type');
    expect((await s.harness.call({ path: '/t/run2/state' })).status).toBe(404);
    expect((await post({ tenant: 'run2', organisations: ORGS })).status).toBe(201);
  });
  it('refuses a body over the limit with 413, and takes one just under it', async () => {
    const s = await scenario('run1');
    const headers = { authorization: `Bearer ${OPERATOR_TOKEN}` };
    const pad = (size: number) => JSON.stringify({ tenant: 'run2', organisations: ORGS, note: 'x'.repeat(size) });
    refused(await s.harness.call({ method: 'POST', path: '/admin/tenants', headers, body: pad(1_048_576) }), 413, 'body_too_large');
    const small = await s.harness.call({ method: 'POST', path: '/admin/tenants', headers, body: pad(10) });
    refused(small, 400, 'bad_request');
    expect(small.json?.message).toMatch(/body\.note is not a field/);
  });
  it('holds at most the number of tenants of the limit, and makes a tenant that exists again at the limit', async () => {
    const s = await scenario('t0');
    for (let n = 1; n < MAX_TENANTS; n += 1) expect((await s.harness.seed(`t${n}`)).status, `t${n}`).toBe(201);
    refused(await s.harness.seed('one-too-many'), 409, 'tenant_limit');
    expect((await s.harness.seed('t5')).status).toBe(200);
    expect((await s.harness.call({ path: '/t/one-too-many/state' })).status).toBe(404);
  });
});

describe('the operator token', () => {
  it('is never in the log, the body of an answer or the state, whether it was right or wrong', async () => {
    const s = await scenario('run1');
    const wrong = `${OPERATOR_TOKEN.slice(0, -4)}ffff`;
    const replies = [
      await s.harness.seed('run2'),
      await s.harness.seed('run3', {}, wrong),
      await s.harness.call({ method: 'POST', path: '/admin/tenants', headers: { authorization: `Bearer ${OPERATOR_TOKEN}`, 'content-type': 'text/plain' }, body: 'x', contentType: null }),
      await s.harness.call({ path: '/t/run2/state' }),
      await s.harness.call({ path: '/t/run2/log' }),
    ];
    for (const text of [...replies.map((r) => r.text), s.harness.lines.join('\n')]) {
      expect(text).not.toContain(OPERATOR_TOKEN);
      expect(text).not.toContain(wrong);
    }
    expect(s.harness.logged().filter((line) => line.credential === 'operator').map((line) => [line.decision, line.status])).toEqual([['allowed', 201], ['allowed', 201], ['refused', 401], ['refused', 415]]);
  });
});

describe('a tenant that does not exist', () => {
  it('is 404 on every route, and no credential is read for it', async () => {
    const s = await scenario('run1');
    const probes: Array<[string, string, string, string?]> = [
      ['GET', '/t/ghost/state', 'open'], ['GET', '/t/ghost/log', 'open'], ['GET', '/t/ghost/erp/stock/GLV-NIT-M', 'token'], ['POST', '/t/ghost/po', 'token'], ['GET', '/t/ghost/vendors', 'token'],
      ['GET', '/t/ghost/supplier/catalogue/GLV-NIT-M', 'x509', MTLS_HOST], ['GET', '/t/ghost/insurer/requirements/SYN-MRI-LS', 'jwt'],
    ];
    for (const [method, path, need, host] of probes) {
      const reply = await s.harness.call({ method, path, ...(host === undefined ? {} : { host }), headers: { authorization: 'DPoP garbage' }, body: method === 'POST' ? {} : undefined });
      refused(reply, 404, 'tenant_not_found');
      expect(s.harness.logged().at(-1), `${path} (${need})`).toMatchObject({ credential: 'none', sub: null });
    }
    expect((await s.harness.seed('ghost')).status).toBe(201);
    expect((await s.harness.call({ path: '/t/ghost/state' })).status).toBe(200);
  });
  it('is 404 for a name that is no tenant name: upper case, a dot, a long name and no route after it', async () => {
    const s = await scenario('run1');
    for (const path of ['/t/Run1/state', '/t/run1', '/t/run1/', '/t/', '/t', '/t/..%2Frun1/state', `/t/${'a'.repeat(49)}/state`, '/t/run1/nothing', '/t/run1/erp', '/t/run1/erp/stock', '/t/run1/erp/stock/a/b', '/elsewhere', '/']) {
      const reply = await s.harness.call({ path });
      refused(reply, 404, 'not_found');
    }
    expect((await s.harness.call({ path: '/t/run1/state' })).status).toBe(200);
  });
  it('is 405 for a method that its path does not take, with the methods that it takes', async () => {
    const s = await scenario('run1');
    for (const [method, path, allow] of [['POST', '/t/run1/state', 'GET'], ['DELETE', '/t/run1/log', 'GET'], ['GET', '/t/run1/po', 'POST'], ['PUT', '/t/run1/vendors', 'GET'], ['HEAD', '/t/run1/state', 'GET']] as const) {
      const reply = await s.harness.call({ method, path });
      expect(reply.status, `${method} ${path}`).toBe(405);
      expect(reply.headers.allow).toBe(allow);
    }
  });
});

describe('one tenant and another', () => {
  async function two() {
    const s = await scenario('run1', { seed: { erp: [{ sku: 'SHARED-SKU', on_hand: 11, threshold: 50, daily_usage: 4, lead_time_days: 5, open_orders: 0 }] } });
    expect((await s.harness.seed('run2', { organisations: { supplier: 'other.example.test', insurer: INSURER_ORG }, seed: { erp: [{ sku: 'SHARED-SKU', on_hand: 22, threshold: 50, daily_usage: 4, lead_time_days: 5, open_orders: 0 }] } })).status).toBe(201);
    return s;
  }
  it('each reads its own data under the same name: a token for one tenant reads that tenant and no other', async () => {
    const s = await two();
    const one = delegateTo(s, 'reader-1', [['erp.stock.read', 'erp']], { tenant: 'run1' });
    const second = delegateTo(s, 'reader-2', [['erp.stock.read', 'erp']], { tenant: 'run2' });
    expect((await callWithToken(s, one, 'erp', 'GET', '/erp/stock/SHARED-SKU', undefined, 'run1')).json?.on_hand).toBe(11);
    expect((await callWithToken(s, second, 'erp', 'GET', '/erp/stock/SHARED-SKU', undefined, 'run2')).json?.on_hand).toBe(22);
  });
  it('a token for one tenant is refused at the other: by its audience, and by its grant when the audience is forced', async () => {
    const s = await two();
    const one = delegateTo(s, 'reader-1', [['erp.stock.read', 'erp']], { tenant: 'run1' });
    const byAudience = await s.harness.tokenCall({ tenant: 'run2', credential: await s.world.token(one.agent, one.delegation, `${PUBLIC_BASE}/t/run1/erp`), method: 'GET', route: '/erp/stock/SHARED-SKU' });
    refused(byAudience, 401, 'token_invalid');
    expect(lastRule(s)).toBe('token.audience');
    const forced = await s.harness.tokenCall({ tenant: 'run2', credential: await s.world.token(one.agent, one.delegation, `${PUBLIC_BASE}/t/run2/erp`), method: 'GET', route: '/erp/stock/SHARED-SKU' });
    refused(forced, 403, 'not_covered');
    expect(lastRule(s)).toBe('delegation.resource');
    const both = await s.world.token(one.agent, one.delegation, `${PUBLIC_BASE}/t/run1/erp`, [`${PUBLIC_BASE}/t/run2/erp`]);
    refused(await s.harness.tokenCall({ tenant: 'run2', credential: both, method: 'GET', route: '/erp/stock/SHARED-SKU' }), 403, 'not_covered');
  });
  it('a write to one tenant is not in the state, the log or the numbers of the other', async () => {
    const s = await two();
    const one = delegateTo(s, 'writer-1', [['po.write', 'po']], { tenant: 'run1' });
    const two_ = delegateTo(s, 'writer-2', [['po.write', 'po']], { tenant: 'run2' });
    expect((await callWithToken(s, one, 'po', 'POST', '/po', purchaseOrder('run1', 'shared-1'), 'run1')).status).toBe(201);
    expect((await s.harness.call({ path: '/t/run2/state' })).json).toMatchObject({ po_store: { orders: [] } });
    expect(((await s.harness.call({ path: '/t/run2/log' })).json!.lines as unknown[])).toEqual([]);
    const second = await callWithToken(s, two_, 'po', 'POST', '/po', purchaseOrder('run2', 'shared-1'), 'run2');
    expect([second.status, second.json?.record_id]).toEqual([201, 'PO-run2-0001']);
    expect((await s.harness.call({ path: '/t/run1/state' })).json).toMatchObject({ po_store: { orders: [{ po_number: 'shared-1', document: { tenant: 'run1' } }] } });
  });
  it('a document of one tenant cannot be written into the other by its body: the body names its tenant, and it must be the tenant of the URL', async () => {
    const s = await two();
    const one = delegateTo(s, 'writer-1', [['po.write', 'po']], { tenant: 'run1' });
    const wrong = await callWithToken(s, one, 'po', 'POST', '/po', purchaseOrder('run2', 'x-1'), 'run1');
    refused(wrong, 400, 'bad_request');
    expect(wrong.json?.message).toBe('body.tenant must be the tenant of the URL');
    expect((await callWithToken(s, one, 'po', 'POST', '/po', purchaseOrder('run1', 'x-1'), 'run1')).status).toBe(201);
  });
  it('the log of one tenant holds its own calls only, and a refused call to a tenant is in the log of that tenant', async () => {
    const s = await two();
    const one = delegateTo(s, 'reader-1', [['erp.stock.read', 'erp']], { tenant: 'run1' });
    await callWithToken(s, one, 'erp', 'GET', '/erp/stock/SHARED-SKU', undefined, 'run1');
    await s.harness.call({ path: '/t/run2/supplier/catalogue/GLV-NIT-M' });
    const first = (await s.harness.call({ path: '/t/run1/log' })).json!.lines as Array<{ tenant: string; decision: string; code: string | null }>;
    const second = (await s.harness.call({ path: '/t/run2/log' })).json!.lines as Array<{ tenant: string; decision: string; code: string | null }>;
    expect(first.map((l) => [l.tenant, l.decision])).toEqual([['run1', 'allowed']]);
    expect(second.map((l) => [l.tenant, l.decision, l.code])).toEqual([['run2', 'refused', 'wrong_host']]);
  });
  it('the agent of the supplier of one tenant is refused at the tenant that has another supplier, and its tenant keeps working', async () => {
    const s = await two();
    const desk = supplierAgent(s);
    const header = await s.world.clientCert(desk);
    expect((await s.harness.call({ path: '/t/run1/supplier/catalogue/GLV-NIT-M', host: MTLS_HOST, headers: { 'client-cert': header } })).status).toBe(200);
    refused(await s.harness.call({ path: '/t/run2/supplier/catalogue/GLV-NIT-M', host: MTLS_HOST, headers: { 'client-cert': header } }), 403, 'organisation_mismatch');
    expect(insurerAgent(s)).toBeDefined();
  });
  it('a reset of one tenant leaves the other as it was', async () => {
    const s = await two();
    const two_ = delegateTo(s, 'writer-2', [['po.write', 'po']], { tenant: 'run2' });
    expect((await callWithToken(s, two_, 'po', 'POST', '/po', purchaseOrder('run2', 'keep-1'), 'run2')).status).toBe(201);
    expect((await s.harness.seed('run1')).status).toBe(200);
    expect((await s.harness.call({ path: '/t/run2/state' })).json).toMatchObject({ po_store: { orders: [{ po_number: 'keep-1' }] } });
  });
  it('the seed of one tenant changes no other: the lot sizes are its own', async () => {
    const s = await scenario('run1');
    const catalogue = defaultSeed().catalogue.map((entry) => ({ ...entry, lot_sizes: Object.fromEntries(LOT_NAMES.map((lot) => [lot, 7])) }));
    expect((await s.harness.seed('run2', { seed: { catalogue } })).status).toBe(201);
    const header = await s.world.clientCert(supplierAgent(s));
    const read = async (tenant: string) => (await s.harness.call({ path: `/t/${tenant}/supplier/catalogue/GLV-NIT-M`, host: MTLS_HOST, headers: { 'client-cert': header } })).json;
    expect((await read('run1'))?.lot_sizes).toEqual({ 'lot-small': 10, 'lot-medium': 50, 'lot-large': 200 });
    expect((await read('run2'))?.lot_sizes).toEqual({ 'lot-small': 7, 'lot-medium': 7, 'lot-large': 7 });
  });
});

describe('a tenant that is made again while a call runs', () => {
  it('the call that was verified for the old tenant is not honoured for the new one, and writes nothing', async () => {
    const s = await scenario('run1');
    const agent = delegateTo(s, 'reorder', [['po.write', 'po']]);
    const credential = await s.world.token(agent.agent, agent.delegation, `${PUBLIC_BASE}/t/run1/po`);
    const hold = s.world.holdLedger();
    const held = s.harness.tokenCall({ tenant: 'run1', credential, method: 'POST', route: '/po', body: purchaseOrder('run1', 'run1-1') });
    await hold.asked;
    expect((await s.harness.seed('run1', { organisations: { supplier: 'another.example.test', insurer: INSURER_ORG } })).status).toBe(200);
    hold.release();
    refused(await held, 409, 'tenant_changed');
    expect(lastRule(s)).toBe('tenant.changed');
    // The refused call is on stdout. It is not in the log of the new tenant, which has taken no call yet.
    expect(s.harness.logged().filter((line) => line.code === 'tenant_changed')).toHaveLength(1);
    expect((await s.harness.call({ path: '/t/run1/log' })).json).toEqual({ tenant: 'run1', dropped: 0, lines: [] });
    expect((await s.harness.call({ path: '/t/run1/state' })).json).toMatchObject({ organisations: { supplier: 'another.example.test' }, po_store: { orders: [] } });
    expect((await callWithToken(s, agent, 'po', 'POST', '/po', purchaseOrder('run1', 'run1-1'))).status).toBe(201);
    expect((await logOf(s, 'run1')).map((line) => line.decision)).toEqual(['allowed']);
  });
  it('the same call with no reset in the middle is honoured', async () => {
    const s = await scenario('run1');
    const agent = delegateTo(s, 'reorder', [['po.write', 'po']]);
    const credential = await s.world.token(agent.agent, agent.delegation, `${PUBLIC_BASE}/t/run1/po`);
    const hold = s.world.holdLedger();
    const held = s.harness.tokenCall({ tenant: 'run1', credential, method: 'POST', route: '/po', body: purchaseOrder('run1', 'run1-1') });
    await hold.asked;
    hold.release();
    expect((await held).status).toBe(201);
  });
  it('a call that is refused with no reset in the middle is in the log of its tenant', async () => {
    const s = await scenario('run1');
    const agent = delegateTo(s, 'reorder', [['po.write', 'po']]);
    const credential = await s.world.token(agent.agent, agent.delegation, `${PUBLIC_BASE}/t/run1/po`);
    s.world.end(agent.delegation);
    const hold = s.world.holdLedger();
    const held = s.harness.tokenCall({ tenant: 'run1', credential, method: 'POST', route: '/po', body: purchaseOrder('run1', 'run1-1') });
    await hold.asked;
    hold.release();
    refused(await held, 403, 'delegation_ended');
    expect(await logOf(s, 'run1')).toMatchObject([{ decision: 'refused', code: 'delegation_ended' }]);
  });
});

describe('the paths and the parameters', () => {
  it('a path parameter that is no identifier is 400 before any write, and a percent escape that is not valid is 400', async () => {
    const s = await scenario('run1');
    const agent = delegateTo(s, 'prior-auth', [['priorauth.submit', 'records']]);
    const body = { request_number: 'run1-1', intake_id: 'INT-run1-0001' };
    for (const order of ['a%20b', '..', '%2e%2e', 'a%2Fb', '-x', 'a'.repeat(65)]) {
      refused(await callWithToken(s, agent, 'records', 'POST', `/records/orders/${order}/submission`, body), 400, 'bad_request');
    }
    refused(await callWithToken(s, agent, 'records', 'POST', '/records/orders/%E0%A4%A/submission', body), 400, 'bad_request');
    expect((await callWithToken(s, agent, 'records', 'POST', '/records/orders/ORD-1001/submission', body)).status).toBe(201);
  });
  it('a query string is no part of the route: the route is found, and the proof names the URL with no query', async () => {
    const s = await scenario('run1');
    const agent = delegateTo(s, 'reader', [['erp.stock.read', 'erp']]);
    const credential = await s.world.token(agent.agent, agent.delegation, `${PUBLIC_BASE}/t/run1/erp`);
    const headers = await s.world.presented(credential, 'GET', `${PUBLIC_BASE}/t/run1/erp/stock/GLV-NIT-M`);
    expect((await s.harness.call({ path: '/t/run1/erp/stock/GLV-NIT-M?x=1&token=abc', headers })).status).toBe(200);
    expect(s.harness.lines.join('\n')).not.toContain('token=abc');
  });
  it('the state of a tenant holds no credential, and the host names are not in it', async () => {
    const s = await scenario('run1');
    const text = JSON.stringify((await s.harness.call({ path: '/t/run1/state' })).json);
    expect(text).not.toContain(OPERATOR_TOKEN);
    expect(text).not.toContain(PUBLIC_HOST);
    expect(text).not.toContain(MTLS_HOST);
  });
});
