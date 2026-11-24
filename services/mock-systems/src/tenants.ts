// services/mock-systems/src/tenants.ts
// The tenants. One tenant is the world of one run: the seed data, what the callers wrote, and the log of the calls. All of it is in memory. A restart of the service loses it, and
// `put` replaces a tenant only when the request permits a reset. A reset empties the tenant's writes and log.
// A write is a typed decision: it is a record, or a refusal that names the rule (a second order for one purchase order number, a second entry for one request number).
// A record holds who wrote it (`by`): the verified identity of the caller, never a token, a proof or a certificate.
import type { Digest } from '@vsa/usecase-kit/protocol';
import { pass, refuse } from './errors.ts';
import type { ErrorCode, Outcome } from './errors.ts';
import type { IntakeRequest, PurchaseOrder, RankingRequest, SubmissionRequest, SupplierOrderRequest } from './documents.ts';
import type { CatalogueEntry, Guideline, LotName, RecordSet, RequirementSet, Seed, StockReading, Vendor } from './seed.ts';
import type { Json } from './validate.ts';

/** The most tenants that the service holds, and the most log lines of one tenant. The limits keep the memory of the service bounded. */
export const MAX_TENANTS = 100;
export const MAX_LOG_LINES = 5_000;

/** Who made a call, as the service verified it. */
export type Actor =
  | { readonly kind: 'token'; readonly sub: string; readonly act: readonly string[]; readonly delegation: string }
  | { readonly kind: 'x509-svid'; readonly spiffe_id: string; readonly did: string }
  | { readonly kind: 'jwt-svid'; readonly spiffe_id: string; readonly did: string };

/** What the verifier says of the status list of a token call that was allowed: the list was read, or it was not and the call went on. */
export type TokenStatusNote =
  | { readonly read: true; readonly age_seconds: number | null }
  | { readonly read: false; readonly reason: 'unavailable' | 'stale'; readonly detail: string };

/** One call, as it goes to the log. It has the verified identity, the route, the tenant and the decision with the rule that refused. It never has a credential. */
export interface LogLine {
  readonly at: string;
  readonly tenant: string | null;
  readonly route: string | null;
  readonly method: string;
  readonly path: string;
  readonly host: 'token' | 'mtls' | 'other';
  readonly credential: 'token' | 'x509-svid' | 'jwt-svid' | 'operator' | 'none';
  readonly sub: string | null;
  readonly act: readonly string[];
  readonly delegation: string | null;
  readonly decision: 'allowed' | 'refused';
  readonly status: number;
  readonly code: ErrorCode | null;
  readonly rule: string | null;
  readonly token_status: TokenStatusNote | null;
}

type OperatorLogLine = LogLine & { proposal_digest?: Digest };
interface LogView<Line extends LogLine = LogLine> {
  tenant: string;
  dropped: number;
  lines: Line[];
}

export interface PoRecord { record_id: string; po_number: string; document: PurchaseOrder; recorded_at: string; by: Actor }
export interface SupplierOrder { order_id: string; po_number: string; po_sha256: string; sku: string; lot: LotName; quantity: number; ship_by: string; status: 'placed'; recorded_at: string; by: Actor }
export interface Submission { submission_id: string; order_id: string; request_number: string; intake_id: string; status: 'complete' | 'incomplete' | null; recorded_at: string; by: Actor }
export interface IntakeRecord { intake_id: string; request_number: string; service_code: string; status: 'complete' | 'incomplete'; missing: string[]; request: Json; recorded_at: string; by: Actor }
export interface RankingRecord {
  ranking_id: string;
  rfq_id: string;
  top: { rank: 1; desk_did: string; organisation: string | null };
  ranking: Json;
  approval: { attestation: string; issuer_did: string };
  recorded_at: string;
  by: Actor;
}

export interface Organisations {
  readonly supplier: string;
  readonly insurer: string;
}

/** The operator run that owns a guarded tenant. The owner is not part of the tenant's public state. */
interface TenantOwner {
  readonly use_case: string;
  readonly run: string;
}

export interface TenantWrite {
  readonly operation: 'create' | 'reset';
  readonly owner: TenantOwner;
}

interface StoredTenant {
  readonly tenant: Tenant;
  readonly owner?: TenantOwner;
}

const numbered = (prefix: string, tenant: string, n: number): string => `${prefix}-${tenant}-${String(n).padStart(4, '0')}`;

export class Tenant {
  readonly id: string;
  readonly organisations: Organisations;
  readonly seededAt: number;
  readonly #stock: Map<string, StockReading>;
  readonly #catalogue: Map<string, CatalogueEntry>;
  readonly #records: Map<string, RecordSet>;
  readonly #guidelines: Map<string, Guideline>;
  readonly #requirements: Map<string, RequirementSet>;
  readonly #seed: Seed;
  readonly #pos: PoRecord[] = [];
  readonly #poKeys = new Set<string>();
  readonly #orders: SupplierOrder[] = [];
  readonly #orderKeys = new Set<string>();
  readonly #submissions: Submission[] = [];
  readonly #submissionKeys = new Set<string>();
  readonly #intakes: IntakeRecord[] = [];
  readonly #intakeKeys = new Set<string>();
  readonly #rankings: RankingRecord[] = [];
  readonly #lines: LogLine[] = [];
  // Keep digests out of the public rows. Eviction releases the old row and its digest.
  #proposalDigests: WeakMap<LogLine, Digest> | undefined;
  #dropped = 0;

  constructor(id: string, organisations: Organisations, seed: Seed, seededAt: number) {
    this.id = id;
    this.organisations = { supplier: organisations.supplier, insurer: organisations.insurer };
    this.seededAt = seededAt;
    this.#seed = structuredClone(seed);
    this.#stock = new Map(this.#seed.erp.map((r) => [r.sku, r]));
    this.#catalogue = new Map(this.#seed.catalogue.map((c) => [c.sku, c]));
    this.#records = new Map(this.#seed.records.map((r) => [r.order.order_id, r]));
    this.#guidelines = new Map(this.#seed.guidelines.map((g) => [g.code, g]));
    this.#requirements = new Map(this.#seed.requirements.map((r) => [r.service_code, r]));
  }

  // ── reads of the seed data: a copy, so that no caller changes what the tenant holds ──

  stock(sku: string): StockReading | undefined { return copy(this.#stock.get(sku)); }
  catalogue(sku: string): CatalogueEntry | undefined { return copy(this.#catalogue.get(sku)); }
  recordSet(orderId: string): RecordSet | undefined { return copy(this.#records.get(orderId)); }
  guideline(code: string): Guideline | undefined { return copy(this.#guidelines.get(code)); }
  requirements(serviceCode: string): RequirementSet | undefined { return copy(this.#requirements.get(serviceCode)); }
  vendors(): Vendor[] { return structuredClone(this.#seed.vendors); }

  // ── writes ──

  /** The PO store takes one order for each purchase order number. The number counts without regard to case. */
  recordPo(document: PurchaseOrder, by: Actor, now: string): Outcome<PoRecord> {
    const key = document.po_number.toLowerCase();
    if (this.#poKeys.has(key)) return refuse('duplicate_po', 'po_store.duplicate', `the PO store already has an order for the purchase order number ${document.po_number}`);
    this.#poKeys.add(key);
    const record: PoRecord = { record_id: numbered('PO', this.id, this.#pos.length + 1), po_number: document.po_number, document, recorded_at: now, by };
    this.#pos.push(record);
    return pass(structuredClone(record));
  }

  /** The supplier portal takes one order for each purchase order number, for an item of its catalogue. */
  placeOrder(request: SupplierOrderRequest, by: Actor, now: string): Outcome<SupplierOrder> {
    if (!this.#catalogue.has(request.sku)) return refuse('sku_not_found', 'supplier.sku', `the catalogue of the supplier has no item ${request.sku}`);
    const key = request.po_number.toLowerCase();
    if (this.#orderKeys.has(key)) return refuse('duplicate_po', 'supplier.duplicate', `the supplier portal already has an order for the purchase order number ${request.po_number}`);
    this.#orderKeys.add(key);
    const order: SupplierOrder = { order_id: numbered('SO', this.id, this.#orders.length + 1), ...request, status: 'placed', recorded_at: now, by };
    this.#orders.push(order);
    return pass(structuredClone(order));
  }

  /** The records system keeps one submission for each request number of an order. */
  recordSubmission(orderId: string, request: SubmissionRequest, by: Actor, now: string): Outcome<Submission> {
    if (!this.#records.has(orderId)) return refuse('order_not_found', 'records.order', `the records system has no order ${orderId}`);
    const key = `${orderId}\n${request.request_number.toLowerCase()}`;
    if (this.#submissionKeys.has(key)) return refuse('duplicate_submission', 'records.duplicate', `the order ${orderId} already has a submission for the request number ${request.request_number}`);
    this.#submissionKeys.add(key);
    const submission: Submission = { submission_id: numbered('SUB', this.id, this.#submissions.length + 1), order_id: orderId, ...request, recorded_at: now, by };
    this.#submissions.push(submission);
    return pass(structuredClone(submission));
  }

  /** The insurer portal files one entry for each request number. */
  fileRequest(request: IntakeRequest, by: Actor, now: string): Outcome<IntakeRecord> {
    const key = request.request_number.toLowerCase();
    if (this.#intakeKeys.has(key)) return refuse('duplicate_request', 'insurer.duplicate', `the insurer portal already has an entry for the request number ${request.request_number}`);
    this.#intakeKeys.add(key);
    const intake: IntakeRecord = {
      intake_id: numbered('INT', this.id, this.#intakes.length + 1), request_number: request.request_number, service_code: request.service_code, status: request.status,
      missing: [...request.missing], request: structuredClone(request.request), recorded_at: now, by,
    };
    this.#intakes.push(intake);
    return pass(structuredClone(intake));
  }

  /** The sourcing record keeps each ranking that passed the approval checks. The caller has made them: this only records. */
  recordRanking(request: RankingRequest & { approval: { attestation: string; issuer_did: string } }, by: Actor, now: string): RankingRecord {
    const record: RankingRecord = {
      ranking_id: numbered('RK', this.id, this.#rankings.length + 1), rfq_id: request.rfq_id, top: { rank: 1, desk_did: request.top, organisation: request.topOrganisation },
      ranking: structuredClone(request.ranking), approval: { ...request.approval }, recorded_at: now, by,
    };
    this.#rankings.push(record);
    return structuredClone(record);
  }

  // ── the log ──

  /** Adds one line. A tenant keeps the last MAX_LOG_LINES lines, and it counts the lines that it dropped, so that a reader sees a loss. */
  log(line: LogLine, digest?: Digest): void {
    this.#lines.push(line);
    if (digest !== undefined) (this.#proposalDigests ??= new WeakMap()).set(line, digest);
    if (this.#lines.length > MAX_LOG_LINES) {
      this.#lines.shift();
      this.#dropped += 1;
    }
  }

  logView(): LogView {
    return { tenant: this.id, dropped: this.#dropped, lines: structuredClone(this.#lines) };
  }

  /** Adds private ranking digests to a copy of the log. The caller must have the operator token. */
  operatorLogView(): LogView<OperatorLogLine> {
    const view: LogView<OperatorLogLine> = this.logView();
    const digests = this.#proposalDigests;
    if (digests === undefined) return view;
    for (let index = 0; index < this.#lines.length; index += 1) {
      const digest = digests.get(this.#lines[index]!);
      if (digest !== undefined) view.lines[index]!.proposal_digest = digest;
    }
    return view;
  }

  /** How many entries of each part of the seed the tenant holds. */
  counts(): Record<string, number> {
    return {
      erp: this.#seed.erp.length, catalogue: this.#seed.catalogue.length, records: this.#seed.records.length, guidelines: this.#seed.guidelines.length,
      requirements: this.#seed.requirements.length, vendors: this.#seed.vendors.length,
    };
  }

  /** The data of the tenant, for the evidence file: the seed data and every write. It holds no credential. */
  state(): Json {
    return structuredClone({
      tenant: this.id,
      organisations: this.organisations,
      seeded_at: new Date(this.seededAt).toISOString(),
      erp: { stock: this.#seed.erp },
      po_store: { orders: this.#pos },
      supplier: { catalogue: this.#seed.catalogue, orders: this.#orders },
      records: { orders: this.#seed.records, submissions: this.#submissions },
      guidelines: this.#seed.guidelines,
      insurer: { requirements: this.#seed.requirements, requests: this.#intakes },
      vendors: this.#seed.vendors,
      sourcing: { rankings: this.#rankings },
    });
  }
}

function copy<T>(value: T | undefined): T | undefined {
  return value === undefined ? undefined : structuredClone(value);
}

export class TenantStore {
  readonly #tenants = new Map<string, StoredTenant>();
  readonly #now: () => number;
  readonly #max: number;

  constructor(options: { now: () => number; maxTenants?: number }) {
    this.#now = options.now;
    this.#max = options.maxTenants ?? MAX_TENANTS;
  }

  get size(): number { return this.#tenants.size; }

  get(id: string): Tenant | undefined { return this.#tenants.get(id)?.tenant; }

  /** Check the operation and owner, then update the map without an asynchronous step. */
  put(id: string, organisations: Organisations, seed: Seed, write?: TenantWrite): Outcome<{ tenant: Tenant; created: boolean }> {
    const existing = this.#tenants.get(id);
    const created = existing === undefined;
    if (created) {
      if (write?.operation === 'reset') return refuse('tenant_not_found', 'tenants.reset_missing', 'a reset requires an existing tenant');
      if (this.#tenants.size >= this.#max) return refuse('tenant_limit', 'tenants.limit', `the service holds ${this.#max} tenants, the most that it takes`);
    } else {
      if (write?.operation === 'create') return refuse('tenant_exists', 'tenants.create_occupied', 'the tenant name is already in use');
      const owner = existing.owner;
      if (write === undefined ? owner !== undefined : owner === undefined || owner.use_case !== write.owner.use_case || owner.run !== write.owner.run) {
        return refuse('tenant_owner_mismatch', 'tenants.reset_owner', 'this request does not have ownership of the tenant');
      }
    }
    const tenant = new Tenant(id, organisations, seed, this.#now());
    const owner = created && write !== undefined ? { ...write.owner } : existing?.owner;
    this.#tenants.set(id, owner === undefined ? { tenant } : { tenant, owner });
    return pass({ tenant, created });
  }
}
