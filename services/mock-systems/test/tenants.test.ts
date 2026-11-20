// The tenants: the data of one run, and the writes. A write is a record or a refusal that names its rule: one order for each purchase order number, one entry for each request number.
// A reset makes the tenant again, so its writes and its log are gone. A read gives a copy. The state holds no credential.
import { describe, expect, it } from 'vitest';
import { MAX_LOG_LINES, TenantStore } from '../src/tenants.ts';
import type { Actor, LogLine, Tenant } from '../src/tenants.ts';
import { defaultSeed } from '../src/seed.ts';
import type { SupplierOrderRequest } from '../src/documents.ts';

const ORGS = { supplier: 'alfa.example.test', insurer: 'delta.example.test' };
const WHEN = '2026-11-19T12:00:00.000Z';
const BY: Actor = { kind: 'token', sub: 'https://id.example.test/principals/key/abc', act: [`did:vector:${'a1'.repeat(32)}`], delegation: 'd1'.repeat(32) };
const SVID: Actor = { kind: 'x509-svid', spiffe_id: `spiffe://id.example.test/agent/${'a1'.repeat(32)}`, did: `did:vector:${'a1'.repeat(32)}` };

function made(id = 'run1'): Tenant {
  const result = new TenantStore({ now: () => Date.UTC(2026, 10, 19, 12) }).put(id, ORGS, defaultSeed());
  if (!result.ok) throw new Error('the tenant was refused');
  return result.value.tenant;
}

const purchaseOrder = (po_number: string) => ({
  schema: 'vector.usecase.po.v1' as const, po_number, tenant: 'run1', sku: 'GLV-NIT-M', lot: 'lot-medium' as const, quantity: 50, needed_by: '2026-12-01', supplier_did: `did:vector:${'a1'.repeat(32)}`,
  advert_ref: `${'c3'.repeat(32)}#0`, stock_reading_sha256: 'd4'.repeat(32),
});
const supplierOrder = (po_number: string, sku = 'GLV-NIT-M'): SupplierOrderRequest => ({ po_number, po_sha256: 'e5'.repeat(32), sku, lot: 'lot-medium', quantity: 50, ship_by: '2026-11-28' });
const line = (n: number): LogLine => ({
  at: WHEN, tenant: 'run1', route: 'GET /vendors', method: 'GET', path: `/t/run1/vendors?n=${n}`, host: 'token', credential: 'token', sub: null, act: [], delegation: null, decision: 'allowed', status: 200,
  code: null, rule: null, token_status: null,
});

describe('the store', () => {
  it('makes a tenant with its organisations, and tells a new tenant from one that was made again', () => {
    const store = new TenantStore({ now: () => 1_000 });
    const first = store.put('run1', ORGS, defaultSeed());
    expect(first.ok && first.value.created).toBe(true);
    expect(store.get('run1')?.organisations).toEqual(ORGS);
    expect(store.get('run1')?.seededAt).toBe(1_000);
    const again = store.put('run1', { supplier: 'other.example.test', insurer: 'delta.example.test' }, defaultSeed());
    expect(again.ok && again.value.created).toBe(false);
    expect(store.get('run1')?.organisations.supplier).toBe('other.example.test');
    expect(store.size).toBe(1);
    expect(store.get('run2')).toBeUndefined();
  });
  it('makes a tenant again from its seed: its writes and its log are gone, and a tenant that was read before keeps its own data', () => {
    const store = new TenantStore({ now: () => 1_000 });
    const first = store.put('run1', ORGS, defaultSeed());
    if (!first.ok) throw new Error('refused');
    first.value.tenant.recordPo(purchaseOrder('run1-1'), BY, WHEN);
    first.value.tenant.log(line(1));
    const second = store.put('run1', ORGS, defaultSeed());
    if (!second.ok) throw new Error('refused');
    expect((second.value.tenant.state().po_store as { orders: unknown[] }).orders).toEqual([]);
    expect(second.value.tenant.logView().lines).toEqual([]);
    expect(second.value.tenant.recordPo(purchaseOrder('run1-1'), BY, WHEN).ok).toBe(true);
  });
  it('holds at most the number of tenants that it was given, and takes a tenant that exists again at the limit', () => {
    const store = new TenantStore({ now: () => 1, maxTenants: 2 });
    expect(store.put('a', ORGS, defaultSeed()).ok).toBe(true);
    expect(store.put('b', ORGS, defaultSeed()).ok).toBe(true);
    const third = store.put('c', ORGS, defaultSeed());
    expect(third.ok).toBe(false);
    if (!third.ok) expect([third.refusal.code, third.refusal.status, third.refusal.rule]).toEqual(['tenant_limit', 409, 'tenants.limit']);
    expect(store.put('a', ORGS, defaultSeed()).ok).toBe(true);
    expect(store.size).toBe(2);
  });
  it('does not share data between two tenants', () => {
    const store = new TenantStore({ now: () => 1 });
    const a = store.put('a', ORGS, defaultSeed());
    const b = store.put('b', ORGS, defaultSeed());
    if (!a.ok || !b.ok) throw new Error('refused');
    a.value.tenant.recordPo({ ...purchaseOrder('x-1'), tenant: 'a' }, BY, WHEN);
    expect(a.value.tenant.recordPo({ ...purchaseOrder('x-1'), tenant: 'a' }, BY, WHEN).ok).toBe(false);
    expect(b.value.tenant.recordPo({ ...purchaseOrder('x-1'), tenant: 'b' }, BY, WHEN).ok).toBe(true);
  });
});

describe('the PO store', () => {
  it('takes one order for each purchase order number, and numbers its records', () => {
    const tenant = made();
    const first = tenant.recordPo(purchaseOrder('run1-1'), BY, WHEN);
    const second = tenant.recordPo(purchaseOrder('run1-2'), BY, WHEN);
    expect(first.ok && first.value.record_id).toBe('PO-run1-0001');
    expect(second.ok && second.value.record_id).toBe('PO-run1-0002');
  });
  it('refuses a second order for the number, whatever the case of the number, and names the rule', () => {
    const tenant = made();
    expect(tenant.recordPo(purchaseOrder('run1-1'), BY, WHEN).ok).toBe(true);
    for (const again of ['run1-1', 'RUN1-1', 'Run1-1']) {
      const refused = tenant.recordPo(purchaseOrder(again), BY, WHEN);
      expect(refused.ok, again).toBe(false);
      if (!refused.ok) expect([refused.refusal.code, refused.refusal.status, refused.refusal.rule]).toEqual(['duplicate_po', 409, 'po_store.duplicate']);
    }
    expect((tenant.state().po_store as { orders: unknown[] }).orders).toHaveLength(1);
  });
  it('records who wrote it', () => {
    const tenant = made();
    tenant.recordPo(purchaseOrder('run1-1'), BY, WHEN);
    expect((tenant.state().po_store as { orders: Array<{ by: Actor; recorded_at: string }> }).orders[0]).toMatchObject({ by: BY, recorded_at: WHEN });
  });
});

describe('the supplier portal', () => {
  it('takes one order for each purchase order number, for an item of its catalogue', () => {
    const tenant = made();
    const placed = tenant.placeOrder(supplierOrder('run1-1'), SVID, WHEN);
    expect(placed.ok && placed.value).toMatchObject({ order_id: 'SO-run1-0001', status: 'placed', po_number: 'run1-1', by: SVID });
    const again = tenant.placeOrder(supplierOrder('RUN1-1'), SVID, WHEN);
    expect(again.ok).toBe(false);
    if (!again.ok) expect([again.refusal.code, again.refusal.rule]).toEqual(['duplicate_po', 'supplier.duplicate']);
    const other = tenant.placeOrder(supplierOrder('run1-2'), SVID, WHEN);
    expect(other.ok && other.value.order_id).toBe('SO-run1-0002');
  });
  it('refuses an item that the catalogue does not hold, and the refused order uses up no number', () => {
    const tenant = made();
    const refused = tenant.placeOrder(supplierOrder('run1-1', 'NO-SUCH-SKU'), SVID, WHEN);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect([refused.refusal.code, refused.refusal.rule]).toEqual(['sku_not_found', 'supplier.sku']);
    expect(tenant.placeOrder(supplierOrder('run1-1'), SVID, WHEN).ok).toBe(true);
  });
});

describe('the records system', () => {
  const submission = (request_number: string) => ({ request_number, intake_id: 'INT-run1-0001', status: null });
  it('keeps one submission for each request number of an order', () => {
    const tenant = made();
    expect(tenant.recordSubmission('ORD-1001', submission('run1-1'), BY, WHEN).ok).toBe(true);
    const again = tenant.recordSubmission('ORD-1001', submission('RUN1-1'), BY, WHEN);
    expect(again.ok).toBe(false);
    if (!again.ok) expect([again.refusal.code, again.refusal.rule]).toEqual(['duplicate_submission', 'records.duplicate']);
    expect(tenant.recordSubmission('ORD-1002', submission('run1-1'), BY, WHEN).ok).toBe(true);
    expect(tenant.recordSubmission('ORD-1001', submission('run1-2'), BY, WHEN).ok).toBe(true);
  });
  it('refuses an order that it does not know', () => {
    const refused = made().recordSubmission('ORD-9999', submission('run1-1'), BY, WHEN);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect([refused.refusal.code, refused.refusal.rule]).toEqual(['order_not_found', 'records.order']);
  });
});

describe('the insurer portal', () => {
  const request = (request_number: string) => ({
    request: { schema: 'vector.usecase.priorauth-request.v1', request_number, tenant: 'run1', service_code: 'SYN-MRI-LS' }, request_number, service_code: 'SYN-MRI-LS', status: 'complete' as const, missing: [],
  });
  it('files one entry for each request number', () => {
    const tenant = made();
    const filed = tenant.fileRequest(request('run1-1'), SVID, WHEN);
    expect(filed.ok && filed.value).toMatchObject({ intake_id: 'INT-run1-0001', status: 'complete', by: SVID });
    const again = tenant.fileRequest(request('Run1-1'), SVID, WHEN);
    expect(again.ok).toBe(false);
    if (!again.ok) expect([again.refusal.code, again.refusal.status, again.refusal.rule]).toEqual(['duplicate_request', 409, 'insurer.duplicate']);
    const other = tenant.fileRequest(request('run1-2'), SVID, WHEN);
    expect(other.ok && other.value.intake_id).toBe('INT-run1-0002');
  });
});

describe('the sourcing record', () => {
  it('keeps each ranking that it is given, with its approval and who wrote it', () => {
    const tenant = made();
    const request = {
      ranking: { schema: 'vector.usecase.ranking.v1' }, rfq_id: 'rfq-1', top: `did:vector:${'a1'.repeat(32)}`, topOrganisation: 'alfa.example.test', salt: 'f6'.repeat(32),
      approval: { attestation: '07'.repeat(32), issuer_did: `did:vector:${'b2'.repeat(32)}` },
    };
    const first = tenant.recordRanking(request, BY, WHEN);
    const second = tenant.recordRanking(request, BY, WHEN);
    expect([first.ranking_id, second.ranking_id]).toEqual(['RK-run1-0001', 'RK-run1-0002']);
    expect(first).toMatchObject({ rfq_id: 'rfq-1', top: { rank: 1, desk_did: request.top, organisation: 'alfa.example.test' }, approval: request.approval, by: BY });
  });
  it('does not keep the salt: the state is public, and the salt is the secret of the digest', () => {
    const tenant = made();
    tenant.recordRanking({
      ranking: {}, rfq_id: 'rfq-1', top: `did:vector:${'a1'.repeat(32)}`, topOrganisation: null, salt: 'f6'.repeat(32), approval: { attestation: '07'.repeat(32), issuer_did: `did:vector:${'b2'.repeat(32)}` },
    }, BY, WHEN);
    expect(JSON.stringify(tenant.state())).not.toContain('f6'.repeat(32));
  });
});

describe('the reads and the state', () => {
  it('give a copy of what the tenant holds: a caller that changes it changes nothing', () => {
    const tenant = made();
    tenant.stock('GLV-NIT-M')!.on_hand = 999;
    tenant.vendors()[0]!.name = 'changed';
    tenant.catalogue('GLV-NIT-M')!.available = 1;
    tenant.recordSet('ORD-1001')!.records.length = 0;
    expect(tenant.stock('GLV-NIT-M')!.on_hand).toBe(60);
    expect(tenant.vendors()[0]!.name).not.toBe('changed');
    expect(tenant.catalogue('GLV-NIT-M')!.available).toBe(5000);
    expect(tenant.recordSet('ORD-1001')!.records).toHaveLength(5);
    expect(tenant.stock('NO-SUCH')).toBeUndefined();
    expect(tenant.guideline('SYN-MRI-LS')?.code).toBe('SYN-MRI-LS');
    expect(tenant.requirements('SYN-MRI-LS')?.service_code).toBe('SYN-MRI-LS');
  });
  it('state holds the seed data and every write, and counts the parts of the seed', () => {
    const tenant = made();
    tenant.recordPo(purchaseOrder('run1-1'), BY, WHEN);
    const state = tenant.state();
    expect(Object.keys(state)).toEqual(['tenant', 'organisations', 'seeded_at', 'erp', 'po_store', 'supplier', 'records', 'guidelines', 'insurer', 'vendors', 'sourcing']);
    expect(state.seeded_at).toBe('2026-11-19T12:00:00.000Z');
    expect(tenant.counts()).toEqual({ erp: 3, catalogue: 3, records: 2, guidelines: 2, requirements: 2, vendors: 3 });
  });
});

describe('the log of a tenant', () => {
  it('keeps the lines in order', () => {
    const tenant = made();
    for (let n = 0; n < 3; n += 1) tenant.log(line(n));
    expect(tenant.logView().lines.map((l) => l.path)).toEqual(['/t/run1/vendors?n=0', '/t/run1/vendors?n=1', '/t/run1/vendors?n=2']);
    expect(tenant.logView()).toMatchObject({ tenant: 'run1', dropped: 0 });
  });
  it('keeps the last lines and counts the lines that it dropped, so that a reader sees the loss', () => {
    const tenant = made();
    for (let n = 0; n < MAX_LOG_LINES + 3; n += 1) tenant.log(line(n));
    const view = tenant.logView();
    expect(view.lines).toHaveLength(MAX_LOG_LINES);
    expect(view.dropped).toBe(3);
    expect(view.lines[0]!.path).toBe('/t/run1/vendors?n=3');
  });
});
