// services/mock-systems/test/support/scenario.ts
// The pieces that most tests share: a service with a seeded tenant, the agents of the three use cases, and the delegations that the member gives them. The agents are made of the stub
// gateway, and the delegations are on the stub gateway and on the fixture ledger at once.
import { afterEach, expect } from 'vitest';
import type { StubAgent, StubDelegation } from '@vsa/id-kit/testing';
import { Harness } from './harness.ts';
import type { Reply } from './harness.ts';
import { INSURER_ORG, SUPPLIER_ORG, World, resourceOf } from './world.ts';
import type { IssuedCredential } from './world.ts';

const open: Harness[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((harness) => harness.stop()));
});

export interface Scenario {
  world: World;
  harness: Harness;
  tenant: string;
}

/** A service with a tenant. */
export async function scenario(tenant = 'run1', extra: Record<string, unknown> = {}): Promise<Scenario> {
  const world = new World();
  const harness = await Harness.start(world);
  open.push(harness);
  const seeded = await harness.seed(tenant, extra);
  expect(seeded.status, seeded.text).toBe(201);
  return { world, harness, tenant };
}

/** An agent that the member delegated to for the actions on the systems of the tenant, with the token for one system. */
export interface Delegate {
  agent: StubAgent;
  delegation: StubDelegation;
}

/**
 * A delegation from the member to a new agent. With `parent` and `parentDelegation`, the new agent is a subagent: its delegation comes from the parent agent, below the delegation of the
 * parent. `remaining` is the number of hops below the delegation: 1 for a root and 0 for a sub-delegation, unless the test says another number.
 */
export function delegateTo(
  s: Scenario, label: string, grants: Array<[action: string, system: string]>,
  options: { tenant?: string; parent?: StubAgent; parentDelegation?: StubDelegation; remaining?: number } = {},
): Delegate {
  const tenant = options.tenant ?? s.tenant;
  const agent = s.world.agent(label, options.parent === undefined ? {} : { parent: options.parent });
  const sub = options.parentDelegation !== undefined;
  const delegation = s.world.delegate({
    delegate: agent, actions: grants.map(([action]) => action), resources: grants.map(([, system]) => resourceOf(tenant, system)), remaining: options.remaining ?? (sub ? 0 : 1),
    ...(sub ? { delegator: options.parent!, parent: options.parentDelegation } : {}),
  });
  return { agent, delegation };
}

/** One call to a route of the tenant with a token of `who` for `system`. */
export async function callWithToken(s: Scenario, who: Delegate, system: string, method: string, route: string, body?: unknown, tenant = s.tenant): Promise<Reply> {
  const credential = await s.world.token(who.agent, who.delegation, resourceOf(tenant, system));
  return s.harness.tokenCall({ tenant, credential, method, route, body });
}

export async function tokenFor(s: Scenario, who: Delegate, system: string, tenant = s.tenant): Promise<IssuedCredential> {
  return s.world.token(who.agent, who.delegation, resourceOf(tenant, system));
}

/** An agent whose record names the organisation of the supplier of the tenant, verified. */
export function supplierAgent(s: Scenario, label = 'order-desk'): StubAgent {
  return s.world.agent(label, { organisation: { domain: SUPPLIER_ORG, verified: true } });
}

/** An agent whose record names the organisation of the insurer of the tenant, verified. */
export function insurerAgent(s: Scenario, label = 'intake'): StubAgent {
  return s.world.agent(label, { organisation: { domain: INSURER_ORG, verified: true } });
}

export const purchaseOrder = (tenant: string, number: string) => ({
  schema: 'vector.usecase.po.v1', po_number: number, tenant, sku: 'GLV-NIT-M', lot: 'lot-medium', quantity: 50, needed_by: '2026-12-01', supplier_did: `did:vector:${'a1'.repeat(32)}`,
  advert_ref: `${'c3'.repeat(32)}#0`, stock_reading_sha256: 'd4'.repeat(32),
});

export const supplierOrder = (number: string) => ({ po_number: number, po_sha256: 'e5'.repeat(32), sku: 'GLV-NIT-M', lot: 'lot-medium', quantity: 50, ship_by: '2026-11-28' });

export const intakeBody = (tenant: string, number: string, status: 'complete' | 'incomplete' = 'complete', missing: string[] = []) => ({
  request: {
    schema: 'vector.usecase.priorauth-request.v1', request_number: number, tenant, order_id: 'ORD-1001', patient_ref: 'SYN-PT-0001', service_code: 'SYN-MRI-LS', diagnosis_codes: ['M54.16'],
    justification: 'The criteria C1 to C4 are met.', guideline_refs: ['C1'], record_refs: ['REC-0002'], record_set_sha256: 'a9'.repeat(32), insurer_did: `did:vector:${'b8'.repeat(32)}`, advert_ref: `${'c3'.repeat(32)}#1`,
  },
  status, missing,
});

export const rankingBody = (tenant: string, topDid: string, secondDid: string, approval: { attestation: string; issuer_did: string } | null = { attestation: '07'.repeat(32), issuer_did: `did:vector:${'b2'.repeat(32)}` }) => ({
  ranking: {
    schema: 'vector.usecase.ranking.v1', rfq_id: 'rfq-1', rfq_sha256: '5a'.repeat(32), tenant, weights: { price: 0.4, lead_time: 0.2, reliability: 0.2, compliance: 0.2 },
    ranked: [
      { rank: 1, desk_did: topDid, organisation: 'alfa.example.test', score: 87.5, components: { price: 90, lead_time: 80, reliability: 85, compliance: 100 }, quote: { escrow_ref: `${'c3'.repeat(32)}#0`, receipt_sha256: '6b'.repeat(32), total: 12500, lead_time_days: 14 } },
      { rank: 2, desk_did: secondDid, organisation: 'bravo.example.test', score: 71, components: { price: 70, lead_time: 70, reliability: 70, compliance: 70 }, quote: { escrow_ref: `${'c4'.repeat(32)}#0`, receipt_sha256: '7c'.repeat(32), total: 13000, lead_time_days: 21 } },
    ],
    excluded: [],
  },
  salt: 'f6'.repeat(32), approval,
});
