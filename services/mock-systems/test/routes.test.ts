// The routes of the systems, each with an accepted call: what it serves, what it writes and what the state shows. The service runs on a real HTTP server. The tokens, the SVIDs and the DID
// resolution come from the stub gateway, and the delegation check runs buyer-core on a ledger of fixture data. The refusals are in the other test files, each with the call that is accepted.
import { describe, expect, it } from 'vitest';
import { ROUTES } from '../src/routes.ts';
import { INSURER_ORG, SUPPLIER_ORG, MTLS_HOST, PUBLIC_BASE } from './support/world.ts';
import { callWithToken, delegateTo, insurerAgent, intakeBody, purchaseOrder, rankingBody, scenario, supplierAgent, supplierOrder } from './support/scenario.ts';
import type { Scenario } from './support/scenario.ts';

const TENANT = 'run1';

async function mtls(s: Scenario, agent: ReturnType<typeof supplierAgent>, method: string, route: string, body?: unknown) {
  return s.harness.call({ method, path: `/t/${s.tenant}${route}`, host: MTLS_HOST, headers: { 'client-cert': await s.world.clientCert(agent) }, body });
}

async function jwt(s: Scenario, agent: ReturnType<typeof insurerAgent>, method: string, route: string, body?: unknown) {
  const token = await s.world.jwtSvid(agent, `${PUBLIC_BASE}/t/${s.tenant}/insurer`);
  return s.harness.call({ method, path: `/t/${s.tenant}${route}`, headers: { authorization: `Bearer ${token}` }, body });
}

describe('the table of routes', () => {
  it('has the eleven routes of the systems and the two reads of the record: thirteen, with the route that makes a tenant fourteen', () => {
    expect(ROUTES.map((route) => route.id)).toEqual([
      'GET /erp/stock/{sku}', 'POST /po', 'GET /supplier/catalogue/{sku}', 'POST /supplier/orders', 'GET /records/orders/{order_id}', 'GET /guidelines/{code}',
      'POST /records/orders/{order_id}/submission', 'GET /insurer/requirements/{service_code}', 'POST /insurer/requests', 'GET /vendors', 'POST /sourcing/rankings', 'GET /state', 'GET /log',
    ]);
  });
  it('gives each route the need of its row', () => {
    const need = Object.fromEntries(ROUTES.map((route) => [route.id, route.need.kind === 'token' ? `token ${route.need.action} ${route.need.system} ${route.need.maxActors}` : route.need.kind]));
    expect(need).toEqual({
      'GET /erp/stock/{sku}': 'token erp.stock.read erp 2',
      'POST /po': 'token po.write po 1',
      'GET /supplier/catalogue/{sku}': 'x509',
      'POST /supplier/orders': 'x509',
      'GET /records/orders/{order_id}': 'token record.read records 2',
      'GET /guidelines/{code}': 'token guideline.read guidelines 2',
      'POST /records/orders/{order_id}/submission': 'token priorauth.submit records 1',
      'GET /insurer/requirements/{service_code}': 'jwt',
      'POST /insurer/requests': 'jwt',
      'GET /vendors': 'token vendor.read vendors 2',
      'POST /sourcing/rankings': 'token sourcing.award.write sourcing 1',
      'GET /state': 'open',
      'GET /log': 'open',
    });
  });
});

describe('use case 1: the ERP, the PO store and the supplier portal', () => {
  it('GET /erp/stock/{sku}: a subagent reads the stock reading of the tenant', async () => {
    const s = await scenario(TENANT);
    const agent = delegateTo(s, 'reorder', [['erp.stock.read', 'erp']]);
    const subagent = delegateTo(s, 'stock-reader', [['erp.stock.read', 'erp']], { parent: agent.agent, parentDelegation: agent.delegation });
    const reply = await callWithToken(s, subagent, 'erp', 'GET', '/erp/stock/GLV-NIT-M');
    expect(reply.status, reply.text).toBe(200);
    expect(reply.json).toEqual({ sku: 'GLV-NIT-M', on_hand: 60, threshold: 100, daily_usage: 12, lead_time_days: 7, open_orders: 0 });
  });
  it('GET /erp/stock/{sku}: an item that the ERP does not hold is 404 sku_not_found, and a path parameter that is no identifier is 400', async () => {
    const s = await scenario(TENANT);
    const agent = delegateTo(s, 'reorder', [['erp.stock.read', 'erp']]);
    const missing = await callWithToken(s, agent, 'erp', 'GET', '/erp/stock/NO-SUCH-SKU');
    expect([missing.status, missing.json?.error]).toEqual([404, 'sku_not_found']);
    const bad = await callWithToken(s, agent, 'erp', 'GET', '/erp/stock/a%20b');
    expect([bad.status, bad.json?.error]).toEqual([400, 'bad_request']);
    const encoded = await callWithToken(s, agent, 'erp', 'GET', '/erp/stock/GLV%2DNIT%2DM');
    expect(encoded.status).toBe(200);
  });
  it('POST /po: the PO store takes a purchase order, and refuses a second one for the number', async () => {
    const s = await scenario(TENANT);
    const agent = delegateTo(s, 'reorder', [['po.write', 'po']]);
    const first = await callWithToken(s, agent, 'po', 'POST', '/po', purchaseOrder(TENANT, 'run1-1'));
    expect(first.status, first.text).toBe(201);
    expect(first.json).toEqual({ record_id: 'PO-run1-0001', po_number: 'run1-1', status: 'recorded', recorded_at: '2026-11-19T12:00:00.000Z' });
    const second = await callWithToken(s, agent, 'po', 'POST', '/po', purchaseOrder(TENANT, 'run1-1'));
    expect([second.status, second.json?.error]).toEqual([409, 'duplicate_po']);
    const other = await callWithToken(s, agent, 'po', 'POST', '/po', purchaseOrder(TENANT, 'run1-2'));
    expect([other.status, other.json?.record_id]).toEqual([201, 'PO-run1-0002']);
    const state = (await s.harness.call({ path: `/t/${TENANT}/state` })).json as { po_store: { orders: Array<{ po_number: string; by: { kind: string; act: string[]; delegation: string } }> } };
    expect(state.po_store.orders.map((o) => o.po_number)).toEqual(['run1-1', 'run1-2']);
    expect(state.po_store.orders[0]!.by).toEqual({ kind: 'token', sub: expect.stringContaining('/principals/key/'), act: [agent.agent.did], delegation: agent.delegation.id });
  });
  it('POST /po: a body that is not a purchase order of this tenant is 400, and a body that is no JSON, and another media type', async () => {
    const s = await scenario(TENANT);
    const agent = delegateTo(s, 'reorder', [['po.write', 'po']]);
    for (const body of [{ ...purchaseOrder(TENANT, 'x-1'), tenant: 'run2' }, { ...purchaseOrder(TENANT, 'x-1'), quantity: '50' }, { ...purchaseOrder(TENANT, 'x-1'), extra: true }, [], 'text']) {
      const reply = await callWithToken(s, agent, 'po', 'POST', '/po', body);
      expect([reply.status, reply.json?.error], JSON.stringify(body)).toEqual([400, 'bad_request']);
    }
    const credential = await s.world.token(agent.agent, agent.delegation, `${PUBLIC_BASE}/t/${TENANT}/po`);
    const url = `${PUBLIC_BASE}/t/${TENANT}/po`;
    const notJson = await s.harness.call({ method: 'POST', path: `/t/${TENANT}/po`, headers: await s.world.presented(credential, 'POST', url), body: '{broken', contentType: 'application/json' });
    expect([notJson.status, notJson.json?.error]).toEqual([400, 'bad_request']);
    const credential2 = await s.world.token(agent.agent, agent.delegation, url);
    const text = await s.harness.call({ method: 'POST', path: `/t/${TENANT}/po`, headers: await s.world.presented(credential2, 'POST', url), body: JSON.stringify(purchaseOrder(TENANT, 'x-2')), contentType: 'text/plain' });
    expect([text.status, text.json?.error]).toEqual([415, 'unsupported_media_type']);
    const credential3 = await s.world.token(agent.agent, agent.delegation, url);
    const empty = await s.harness.call({ method: 'POST', path: `/t/${TENANT}/po`, headers: await s.world.presented(credential3, 'POST', url), body: '', contentType: 'application/json' });
    expect([empty.status, empty.json?.error]).toEqual([400, 'bad_request']);
  });
  it('GET /supplier/catalogue/{sku}: the Order Desk reads the catalogue of the supplier with its X.509-SVID', async () => {
    const s = await scenario(TENANT);
    const reply = await mtls(s, supplierAgent(s), 'GET', '/supplier/catalogue/GLV-NIT-M');
    expect(reply.status, reply.text).toBe(200);
    expect(reply.json).toMatchObject({ sku: 'GLV-NIT-M', unit: 'box', lot_sizes: { 'lot-small': 10, 'lot-medium': 50, 'lot-large': 200 }, discontinued: false });
    const missing = await mtls(s, supplierAgent(s, 'second'), 'GET', '/supplier/catalogue/NO-SUCH');
    expect([missing.status, missing.json?.error]).toEqual([404, 'sku_not_found']);
  });
  it('POST /supplier/orders: one order for each purchase order number, and the order has the agent that placed it', async () => {
    const s = await scenario(TENANT);
    const agent = supplierAgent(s);
    const first = await mtls(s, agent, 'POST', '/supplier/orders', supplierOrder('run1-1'));
    expect(first.status, first.text).toBe(201);
    expect(first.json).toEqual({ order_id: 'SO-run1-0001', po_number: 'run1-1', status: 'placed', recorded_at: '2026-11-19T12:00:00.000Z' });
    const second = await mtls(s, agent, 'POST', '/supplier/orders', supplierOrder('run1-1'));
    expect([second.status, second.json?.error]).toEqual([409, 'duplicate_po']);
    const unknown = await mtls(s, agent, 'POST', '/supplier/orders', { ...supplierOrder('run1-2'), sku: 'NO-SUCH' });
    expect([unknown.status, unknown.json?.error]).toEqual([404, 'sku_not_found']);
    const state = (await s.harness.call({ path: `/t/${TENANT}/state` })).json as { supplier: { orders: Array<{ po_number: string; by: unknown }> } };
    expect(state.supplier.orders).toHaveLength(1);
    expect(state.supplier.orders[0]!.by).toEqual({ kind: 'x509-svid', spiffe_id: `spiffe://id.vector.apexfusion.org/agent/${agent.id}`, did: agent.did });
  });
});

describe('use case 2: the records system, the guidelines store and the insurer portal', () => {
  it('GET /records/orders/{order_id}: a subagent reads the order and the records behind it', async () => {
    const s = await scenario(TENANT);
    const agent = delegateTo(s, 'prior-auth', [['record.read', 'records']]);
    const reader = delegateTo(s, 'record-reader', [['record.read', 'records']], { parent: agent.agent, parentDelegation: agent.delegation });
    const reply = await callWithToken(s, reader, 'records', 'GET', '/records/orders/ORD-1001');
    expect(reply.status, reply.text).toBe(200);
    expect(Object.keys(reply.json!)).toEqual(['order', 'records']);
    expect(reply.json).toMatchObject({ order: { order_id: 'ORD-1001', patient_ref: 'SYN-PT-0001', service_code: 'SYN-MRI-LS' } });
    expect((reply.json!.records as unknown[]).length).toBe(5);
    const missing = await callWithToken(s, reader, 'records', 'GET', '/records/orders/ORD-9999');
    expect([missing.status, missing.json?.error]).toEqual([404, 'order_not_found']);
  });
  it('GET /guidelines/{code}: a subagent reads the guideline of a service code', async () => {
    const s = await scenario(TENANT);
    const agent = delegateTo(s, 'prior-auth', [['guideline.read', 'guidelines']]);
    const drafter = delegateTo(s, 'drafter', [['guideline.read', 'guidelines']], { parent: agent.agent, parentDelegation: agent.delegation });
    const reply = await callWithToken(s, drafter, 'guidelines', 'GET', '/guidelines/SYN-MRI-LS');
    expect(reply.status, reply.text).toBe(200);
    expect(reply.json).toMatchObject({ code: 'SYN-MRI-LS', criteria: [{ id: 'C1' }, { id: 'C2' }, { id: 'C3' }, { id: 'C4' }] });
    const missing = await callWithToken(s, drafter, 'guidelines', 'GET', '/guidelines/NO-SUCH');
    expect([missing.status, missing.json?.error]).toEqual([404, 'guideline_not_found']);
  });
  it('POST /records/orders/{order_id}/submission: the agent writes the intake reference, one for each request number of an order', async () => {
    const s = await scenario(TENANT);
    const agent = delegateTo(s, 'prior-auth', [['priorauth.submit', 'records']]);
    const body = { request_number: 'run1-1', intake_id: 'INT-run1-0001', status: 'complete' };
    const first = await callWithToken(s, agent, 'records', 'POST', '/records/orders/ORD-1001/submission', body);
    expect(first.status, first.text).toBe(201);
    expect(first.json).toEqual({ submission_id: 'SUB-run1-0001', order_id: 'ORD-1001', request_number: 'run1-1', intake_id: 'INT-run1-0001', recorded_at: '2026-11-19T12:00:00.000Z' });
    const again = await callWithToken(s, agent, 'records', 'POST', '/records/orders/ORD-1001/submission', body);
    expect([again.status, again.json?.error]).toEqual([409, 'duplicate_submission']);
    const unknown = await callWithToken(s, agent, 'records', 'POST', '/records/orders/ORD-9999/submission', body);
    expect([unknown.status, unknown.json?.error]).toEqual([404, 'order_not_found']);
    const state = (await s.harness.call({ path: `/t/${TENANT}/state` })).json as { records: { submissions: unknown[] } };
    expect(state.records.submissions).toHaveLength(1);
  });
  it('GET /insurer/requirements/{service_code}: the Intake Agent reads the requirements with its JWT-SVID', async () => {
    const s = await scenario(TENANT);
    const reply = await jwt(s, insurerAgent(s), 'GET', '/insurer/requirements/SYN-MRI-LS');
    expect(reply.status, reply.text).toBe(200);
    expect(reply.json).toMatchObject({ service_code: 'SYN-MRI-LS', requirements: [{ id: 'R1' }, { id: 'R2' }, { id: 'R3' }, { id: 'R4' }, { id: 'R5' }] });
    const missing = await jwt(s, insurerAgent(s, 'second'), 'GET', '/insurer/requirements/NO-SUCH');
    expect([missing.status, missing.json?.error]).toEqual([404, 'requirements_not_found']);
  });
  it('POST /insurer/requests: one entry for each request number, and an incomplete request is filed as it is', async () => {
    const s = await scenario(TENANT);
    const agent = insurerAgent(s);
    const first = await jwt(s, agent, 'POST', '/insurer/requests', intakeBody(TENANT, 'run1-1', 'incomplete', ['R3']));
    expect(first.status, first.text).toBe(201);
    expect(first.json).toEqual({ intake_id: 'INT-run1-0001', request_number: 'run1-1', status: 'incomplete', missing: ['R3'], received_at: '2026-11-19T12:00:00.000Z' });
    const second = await jwt(s, agent, 'POST', '/insurer/requests', intakeBody(TENANT, 'run1-1'));
    expect([second.status, second.json?.error]).toEqual([409, 'duplicate_request']);
    const other = await jwt(s, agent, 'POST', '/insurer/requests', intakeBody(TENANT, 'run1-2'));
    expect([other.status, other.json?.intake_id]).toEqual([201, 'INT-run1-0002']);
    const state = (await s.harness.call({ path: `/t/${TENANT}/state` })).json as { insurer: { requests: Array<{ request_number: string; status: string; missing: string[]; by: unknown }> } };
    expect(state.insurer.requests.map((r) => [r.request_number, r.status, r.missing])).toEqual([['run1-1', 'incomplete', ['R3']], ['run1-2', 'complete', []]]);
    expect(state.insurer.requests[0]!.by).toMatchObject({ kind: 'jwt-svid', did: agent.did });
  });
});

describe('use case 3: the vendor master and the sourcing record', () => {
  it('GET /vendors: a scorer reads the vendors of the tenant', async () => {
    const s = await scenario(TENANT);
    const agent = delegateTo(s, 'sourcing', [['vendor.read', 'vendors']]);
    const scorer = delegateTo(s, 'scorer-1', [['vendor.read', 'vendors']], { parent: agent.agent, parentDelegation: agent.delegation });
    const reply = await callWithToken(s, scorer, 'vendors', 'GET', '/vendors');
    expect(reply.status, reply.text).toBe(200);
    const vendors = reply.json!.vendors as Array<{ organisation: string }>;
    expect(vendors.map((v) => v.organisation)).toEqual(['alfa.example.org', 'bravo.example.org', 'charlie.example.org']);
  });
  it('POST /sourcing/rankings: a ranking with an approval that the check passes, for a supplier that is Active, is written', async () => {
    const s = await scenario(TENANT);
    const agent = delegateTo(s, 'sourcing', [['sourcing.award.write', 'sourcing']]);
    const alfa = s.world.agent('desk-alfa');
    const bravo = s.world.agent('desk-bravo');
    const body = rankingBody(TENANT, alfa.did, bravo.did);
    const reply = await callWithToken(s, agent, 'sourcing', 'POST', '/sourcing/rankings', body);
    expect(reply.status, reply.text).toBe(201);
    expect(reply.json).toEqual({ ranking_id: 'RK-run1-0001', rfq_id: 'rfq-1', top: { rank: 1, desk_did: alfa.did, organisation: 'alfa.example.test' }, recorded_at: '2026-11-19T12:00:00.000Z' });
    expect(s.harness.approvals).toHaveLength(1);
    expect(s.harness.approvals[0]).toEqual({
      sender: agent.agent.did, delegation: agent.delegation.id, attestation: '07'.repeat(32), issuerDid: `did:vector:${'b2'.repeat(32)}`, document: body.ranking, salt: 'f6'.repeat(32), atMs: s.world.now(),
    });
    const state = (await s.harness.call({ path: `/t/${TENANT}/state` })).json as { sourcing: { rankings: Array<{ approval: unknown; by: unknown }> } };
    expect(state.sourcing.rankings).toHaveLength(1);
    expect(state.sourcing.rankings[0]!.approval).toEqual(body.approval);
  });
});

describe('the state and the log', () => {
  it('GET /state and GET /log need nothing: they answer the data of the tenant, with no credential', async () => {
    const s = await scenario(TENANT);
    const state = await s.harness.call({ path: `/t/${TENANT}/state` });
    expect(state.status).toBe(200);
    expect(state.json).toMatchObject({ tenant: TENANT, organisations: { supplier: SUPPLIER_ORG, insurer: INSURER_ORG } });
    const log = await s.harness.call({ path: `/t/${TENANT}/log` });
    expect(log.status).toBe(200);
    expect(log.json).toEqual({ tenant: TENANT, dropped: 0, lines: [] });
  });
});
