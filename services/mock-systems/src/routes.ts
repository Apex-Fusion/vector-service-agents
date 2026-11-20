// services/mock-systems/src/routes.ts
// The routes of the systems, each with the need that its row names. A route has one of five needs:
//   token  a token of the identity gateway with an exact action and an exact resource, and an act chain no deeper than the route takes (1 for an agent, 2 for a subagent);
//   x509   an X.509-SVID as the client certificate, on the client-certificate host only, of an agent whose record names the supplier organisation of the tenant;
//   jwt    a JWT-SVID, on the host of tokens, of an agent whose record names the insurer organisation of the tenant;
//   open   none: the route only reads (the state and the log of the tenant);
//   admin  the operator token (the one route that makes a tenant).
// A handler runs after the need was met. It returns a typed decision: a reply with its status, or a refusal. The write rules are in `Tenant` (one order for each purchase order number,
// one entry for each request number) and in `postRanking` (the approval checks, and the supplier of the top rank).
import { decideApproval } from './approval.ts';
import type { ApprovalCheck } from './approval.ts';
import { parseIntake, parsePurchaseOrder, parseRanking, parseSubmission, parseSupplierOrder } from './documents.ts';
import { pass, refuse } from './errors.ts';
import type { Outcome } from './errors.ts';
import { authorizeSupplier } from './identity.ts';
import type { CallTrace, IdentityDeps } from './identity.ts';
import type { Actor, Tenant } from './tenants.ts';

/** The systems that a token is for. The resource of a route is `<public base>/t/<tenant>/<system>`. */
export const TOKEN_SYSTEMS = ['erp', 'po', 'records', 'guidelines', 'vendors', 'sourcing'] as const;
export type System = (typeof TOKEN_SYSTEMS)[number];
/** The system that a JWT-SVID is for: its audience is `<public base>/t/<tenant>/insurer`. */
export const JWT_AUDIENCE_SYSTEM = 'insurer';

export type Need =
  | { readonly kind: 'token'; readonly action: string; readonly system: System; readonly maxActors: 1 | 2 }
  | { readonly kind: 'x509' }
  | { readonly kind: 'jwt' }
  | { readonly kind: 'open' }
  | { readonly kind: 'admin' };

export interface Ok {
  readonly status: number;
  readonly body: unknown;
}

export interface Call {
  /** The tenant as it was when the call began. A handler that waits for a check reads `current()` before it writes. */
  readonly tenant: Tenant;
  current(): Tenant | undefined;
  readonly params: Readonly<Record<string, string>>;
  /** The parsed JSON body of a POST. It is read after the need was met. */
  readonly body: unknown;
  /** Who made the call, as it was verified. Null for a route that needs nothing. */
  readonly actor: Actor | null;
  /** The agent that asked, for a token call: the subject that an approval must name. */
  readonly sender: string | null;
  readonly now: () => number;
  readonly approvalCheck: ApprovalCheck;
  /** How long the call waits for the approval check, in milliseconds. */
  readonly approvalTimeoutMs: number;
  readonly identity: IdentityDeps;
  readonly trace: CallTrace;
}

export type Handler = (call: Call) => Promise<Outcome<Ok>> | Outcome<Ok>;

export interface Route {
  /** The name of the route in the log and in the documents. */
  readonly id: string;
  readonly method: 'GET' | 'POST';
  /** The segments after `/t/<tenant>`. A segment that starts with `:` is a parameter. */
  readonly segments: readonly string[];
  readonly need: Need;
  readonly handle: Handler;
}

/** The exact public URL of a system of a tenant: the resource of a token, and the audience of a JWT-SVID. */
export const systemUrl = (publicBase: string, tenant: string, system: string): string => `${publicBase}/t/${tenant}/${system}`;

const iso = (call: Call): string => new Date(call.now()).toISOString();

/** The actor of a write. A route with a write has a need, so the actor is there; a call without one is a fault of the service, and it is refused. */
function writer(call: Call): Actor {
  if (call.actor === null) throw new Error('a write route ran with no verified caller');
  return call.actor;
}

function found<T>(thing: T | undefined, notFound: () => Outcome<never>): Outcome<Ok> {
  return thing === undefined ? notFound() : pass({ status: 200, body: thing });
}

const stockRoute: Route = {
  id: 'GET /erp/stock/{sku}', method: 'GET', segments: ['erp', 'stock', ':sku'], need: { kind: 'token', action: 'erp.stock.read', system: 'erp', maxActors: 2 },
  handle: (call) => found(call.tenant.stock(call.params.sku!), () => refuse('sku_not_found', 'erp.sku', `the ERP has no item ${call.params.sku}`)),
};

const poRoute: Route = {
  id: 'POST /po', method: 'POST', segments: ['po'], need: { kind: 'token', action: 'po.write', system: 'po', maxActors: 1 },
  handle(call) {
    const document = parsePurchaseOrder(call.body, call.tenant.id);
    const recorded = call.tenant.recordPo(document, writer(call), iso(call));
    if (!recorded.ok) return recorded;
    const { record_id, po_number, recorded_at } = recorded.value;
    return pass({ status: 201, body: { record_id, po_number, status: 'recorded', recorded_at } });
  },
};

const catalogueRoute: Route = {
  id: 'GET /supplier/catalogue/{sku}', method: 'GET', segments: ['supplier', 'catalogue', ':sku'], need: { kind: 'x509' },
  handle: (call) => found(call.tenant.catalogue(call.params.sku!), () => refuse('sku_not_found', 'supplier.sku', `the catalogue of the supplier has no item ${call.params.sku}`)),
};

const supplierOrderRoute: Route = {
  id: 'POST /supplier/orders', method: 'POST', segments: ['supplier', 'orders'], need: { kind: 'x509' },
  handle(call) {
    const placed = call.tenant.placeOrder(parseSupplierOrder(call.body), writer(call), iso(call));
    if (!placed.ok) return placed;
    const { order_id, po_number, recorded_at } = placed.value;
    return pass({ status: 201, body: { order_id, po_number, status: 'placed', recorded_at } });
  },
};

const recordRoute: Route = {
  id: 'GET /records/orders/{order_id}', method: 'GET', segments: ['records', 'orders', ':order_id'], need: { kind: 'token', action: 'record.read', system: 'records', maxActors: 2 },
  handle: (call) => found(call.tenant.recordSet(call.params.order_id!), () => refuse('order_not_found', 'records.order', `the records system has no order ${call.params.order_id}`)),
};

const guidelineRoute: Route = {
  id: 'GET /guidelines/{code}', method: 'GET', segments: ['guidelines', ':code'], need: { kind: 'token', action: 'guideline.read', system: 'guidelines', maxActors: 2 },
  handle: (call) => found(call.tenant.guideline(call.params.code!), () => refuse('guideline_not_found', 'guidelines.code', `the guideline store has no guideline ${call.params.code}`)),
};

const submissionRoute: Route = {
  id: 'POST /records/orders/{order_id}/submission', method: 'POST', segments: ['records', 'orders', ':order_id', 'submission'],
  need: { kind: 'token', action: 'priorauth.submit', system: 'records', maxActors: 1 },
  handle(call) {
    const recorded = call.tenant.recordSubmission(call.params.order_id!, parseSubmission(call.body), writer(call), iso(call));
    if (!recorded.ok) return recorded;
    const { submission_id, order_id, request_number, intake_id, recorded_at } = recorded.value;
    return pass({ status: 201, body: { submission_id, order_id, request_number, intake_id, recorded_at } });
  },
};

const requirementsRoute: Route = {
  id: 'GET /insurer/requirements/{service_code}', method: 'GET', segments: ['insurer', 'requirements', ':service_code'], need: { kind: 'jwt' },
  handle: (call) => found(call.tenant.requirements(call.params.service_code!), () => refuse('requirements_not_found', 'insurer.service_code', `the insurer portal has no requirements for ${call.params.service_code}`)),
};

const intakeRoute: Route = {
  id: 'POST /insurer/requests', method: 'POST', segments: ['insurer', 'requests'], need: { kind: 'jwt' },
  handle(call) {
    const filed = call.tenant.fileRequest(parseIntake(call.body, call.tenant.id), writer(call), iso(call));
    if (!filed.ok) return filed;
    const { intake_id, request_number, status, missing, recorded_at } = filed.value;
    return pass({ status: 201, body: { intake_id, request_number, status, missing, received_at: recorded_at } });
  },
};

const vendorsRoute: Route = {
  id: 'GET /vendors', method: 'GET', segments: ['vendors'], need: { kind: 'token', action: 'vendor.read', system: 'vendors', maxActors: 2 },
  handle: (call) => pass({ status: 200, body: { vendors: call.tenant.vendors() } }),
};

/**
 * The write of an approved ranking. In this order, and the first failure ends the call:
 *   1. the body is a ranking with one entry of rank 1, a salt and an approval (or null);
 *   2. no approval is `approval_not_found`;
 *   3. the approval check that the app was given passes, for the ranking that was sent, and it answers in the time limit (503 `approval_unavailable` when it does not);
 *   4. the supplier of rank 1 resolves and is Active now;
 *   5. the tenant is still the one that the caller was verified for.
 * Only then is the ranking written.
 */
const rankingRoute: Route = {
  id: 'POST /sourcing/rankings', method: 'POST', segments: ['sourcing', 'rankings'], need: { kind: 'token', action: 'sourcing.award.write', system: 'sourcing', maxActors: 1 },
  async handle(call) {
    const request = parseRanking(call.body, call.tenant.id);
    const by = writer(call);
    if (request.approval === null) return refuse('approval_not_found', 'approval.missing', 'the ranking came with no approval, and the sourcing record takes only a ranking that its hirer approved');
    if (call.sender === null || by.kind !== 'token') throw new Error('the ranking route ran with no verified token');
    const approved = await decideApproval(call.approvalCheck, {
      sender: call.sender, delegation: by.delegation, attestation: request.approval.attestation, issuerDid: request.approval.issuer_did, document: request.ranking, salt: request.salt, atMs: call.now(),
    }, call.approvalTimeoutMs);
    if (!approved.ok) return approved;
    const supplier = await authorizeSupplier(call.identity, request.top, call.trace);
    if (!supplier.ok) return supplier;
    if (call.current() !== call.tenant) return refuse('tenant_changed', 'tenant.changed', `the tenant ${call.tenant.id} was made again while the call ran: send the call again`);
    const record = call.tenant.recordRanking({ ...request, approval: request.approval }, by, iso(call));
    return pass({ status: 201, body: { ranking_id: record.ranking_id, rfq_id: record.rfq_id, top: record.top, recorded_at: record.recorded_at } });
  },
};

const stateRoute: Route = { id: 'GET /state', method: 'GET', segments: ['state'], need: { kind: 'open' }, handle: (call) => pass({ status: 200, body: call.tenant.state() }) };
const logRoute: Route = { id: 'GET /log', method: 'GET', segments: ['log'], need: { kind: 'open' }, handle: (call) => pass({ status: 200, body: call.tenant.logView() }) };

/** The routes of a tenant, in the order of the table of the README. `POST /admin/tenants` is not a route of a tenant: the app handles it. */
export const ROUTES: readonly Route[] = [
  stockRoute, poRoute, catalogueRoute, supplierOrderRoute, recordRoute, guidelineRoute, submissionRoute, requirementsRoute, intakeRoute, vendorsRoute, rankingRoute, stateRoute, logRoute,
];

/** The routes whose path matches `segments` (the path after `/t/<tenant>`, as a list), with the parameters of the match. A path can match the routes of more than one method. */
export function matchRoutes(segments: readonly string[]): { routes: Route[]; params: Record<string, string> } {
  const routes: Route[] = [];
  let params: Record<string, string> = {};
  for (const route of ROUTES) {
    if (route.segments.length !== segments.length) continue;
    const found: Record<string, string> = {};
    const fits = route.segments.every((part, index) => {
      const given = segments[index]!;
      if (part.startsWith(':')) {
        found[part.slice(1)] = given;
        return given !== '';
      }
      return part === given;
    });
    if (fits) {
      routes.push(route);
      params = found;
    }
  }
  return { routes, params };
}
