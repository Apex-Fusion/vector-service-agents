// agents/order-desk/test/job/rig.ts
// The rig of the tests of the job. It joins the stub gateway of id-kit (the X.509-SVID of the Order Desk), a fake supplier portal behind the transport port (it keeps one order for each purchase order
// number, as the portal does, and it records each call with the certificate and the key that the call presented), a scripted decision, a scripted order book, and the record of the checks that passed.
// No test of the job uses the network. A test builds a rig, changes one thing, and expects one result. The same rig with no change is the accepted twin.
import { expect } from 'vitest';
import { createGatewayClient } from '@vsa/id-kit/client';
import { createStubGateway } from '@vsa/id-kit/testing';
import type { StubAgent, StubGateway } from '@vsa/id-kit/testing';
import type { JobContext } from '@vsa/service-kit';
import type { Clock, MtlsReply, MtlsRequest, MtlsTransport } from '@vsa/usecase-kit/access';
import type { DecideResult } from '@vsa/usecase-kit/decision';
import { readFaultSwitch } from '@vsa/usecase-kit/fault';
import type { FaultSwitch } from '@vsa/usecase-kit/fault';
import type { LotsFile, OrderConfirmation } from '@vsa/usecase-kit/inventory';
import { accepted } from '@vsa/usecase-kit/protocol';
import type { FaultSetting, Handoff, JsonValue } from '@vsa/usecase-kit/protocol';
import { OrderRefusal, runOrder } from '../../src/job/index.ts';
import type { AvailabilityChoice, OrderDeps, TakenChecks } from '../../src/job/index.ts';
import { ADVERT_REF, BASES, BUYER_PKH, CATALOGUE, ESCROW_REF, LOTS, decisionOf, handoffOf, purchaseOrder, recordFor } from './samples.ts';

/** One call that reached the portal, with the client certificate and the key that it presented. */
export interface PortalCall {
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string | null;
  readonly cert: string;
  readonly key: string;
}

/** What the portal answers: a status with a body, or a failure of the network. */
export type Reply = { readonly status: number; readonly body: string } | { readonly throws: Error };
export const json = (status: number, value: unknown): Reply => ({ status, body: JSON.stringify(value) });

const ORDER_MEMBERS = ['po_number', 'po_sha256', 'sku', 'lot', 'quantity', 'ship_by'].sort().join();
const CATALOGUE_PATH = /^\/t\/([a-z0-9-]+)\/supplier\/catalogue\/([A-Za-z0-9._-]+)$/;
const ORDERS_PATH = /^\/t\/([a-z0-9-]+)\/supplier\/orders$/;

/**
 * The supplier portal behind the transport port. It answers the two routes of the Order Desk as the mock service does: the catalogue entry of a SKU, and an order that it takes once for each purchase order
 * number without regard to case. `catalogue` and `order` replace the answer of one route, and then the portal places no order. A call that is not one of the two routes throws.
 */
export class Portal {
  readonly calls: PortalCall[] = [];
  /** The orders that the portal holds, by purchase order number in lower case. */
  readonly orders = new Map<string, Record<string, unknown>>();
  catalogue: Reply | null = null;
  order: Reply | null = null;
  readonly #events: string[];

  constructor(events: string[]) {
    this.#events = events;
  }

  /** Puts an order for the number in the portal, as an earlier job did. */
  preplace(poNumber: string): void {
    this.orders.set(poNumber.toLowerCase(), { order_id: 'SO-run1-0000', po_number: poNumber });
  }

  readonly transport: MtlsTransport = async (request: MtlsRequest): Promise<MtlsReply> => {
    this.calls.push({ method: request.method, url: request.url, headers: request.headers, body: request.body, cert: request.cert, key: request.key });
    const path = new URL(request.url).pathname;
    const read = request.method === 'GET' ? CATALOGUE_PATH.exec(path) : null;
    if (read !== null) {
      this.#events.push('catalogue');
      return this.#reply(this.catalogue, () => {
        const sku = read[2]!;
        const entry = Object.hasOwn(CATALOGUE, sku) ? CATALOGUE[sku] : undefined;
        return entry === undefined ? json(404, { error: 'sku_not_found', message: 'the catalogue has no such item' }) : json(200, entry);
      });
    }
    const write = request.method === 'POST' ? ORDERS_PATH.exec(path) : null;
    if (write !== null) {
      this.#events.push('order');
      return this.#reply(this.order, () => this.#place(write[1]!, request.body));
    }
    throw new Error(`the portal has no route ${request.method} ${path}`);
  };

  #reply(scripted: Reply | null, real: () => Reply): MtlsReply {
    const reply = scripted ?? real();
    if ('throws' in reply) throw reply.throws;
    return reply;
  }

  /** The real answer to an order: 201 with the id of a new order, 400 for a body with other members, and 409 for a number that the portal holds. */
  #place(tenant: string, body: string | null): Reply {
    const order = JSON.parse(body ?? 'null') as Record<string, unknown> | null;
    if (order === null || typeof order !== 'object' || Object.keys(order).sort().join() !== ORDER_MEMBERS) return json(400, { error: 'bad_request', message: 'the order has other members' });
    const key = String(order.po_number).toLowerCase();
    if (this.orders.has(key)) return json(409, { error: 'duplicate_po', message: 'the portal already has an order for this purchase order number' });
    const orderId = `SO-${tenant}-${String(this.orders.size + 1).padStart(4, '0')}`;
    this.orders.set(key, { ...order, order_id: orderId });
    return json(201, { order_id: orderId, po_number: order.po_number, status: 'placed', recorded_at: '2026-11-23T12:00:00.000Z' });
  }
}

/** A clock for the calls that never ends a wait by itself: a test of the job has no time limit to prove. A wait ends when its signal aborts. */
function clockOf(gateway: StubGateway): Clock {
  return {
    now: () => gateway.now(),
    sleep: (_ms, signal) =>
      new Promise<void>((resolve) => {
        if (signal?.aborted === true) {
          resolve();
          return;
        }
        signal?.addEventListener('abort', () => resolve(), { once: true });
      }),
  };
}

/** The `fetch` of the calls to the portal. A call with a client certificate goes through the transport, so a call of the job to `fetch` is a defect. */
const noFetch: typeof fetch = async () => {
  throw new Error('the job called fetch: a call with an X.509-SVID goes through the transport');
};

export interface RigOptions {
  /** The setting of the fault switch. The default is the empty text. */
  readonly mode?: FaultSetting<'order-desk'>;
  /** Members of the purchase order that replace those of the sample. */
  readonly order?: Readonly<Record<string, JsonValue>>;
  /** The lots file of the job. */
  readonly lots?: LotsFile;
  /** `take` removes the entry, as the store of the hook does. */
  readonly oneShot?: boolean;
}

export interface Rig {
  readonly gateway: StubGateway;
  readonly agent: StubAgent;
  readonly portal: Portal;
  /** The order in which the job reached each port: `take`, `svid`, `catalogue`, `decide`, `order` and `book`. */
  readonly events: string[];
  readonly logs: string[];
  /** The escrow reference of each call of `takeChecks`. */
  readonly takes: string[];
  /** The input of each call of `decide`. */
  readonly decideInputs: JsonValue[];
  /** The orders that the order book recorded: tenant, purchase order number and order id. */
  readonly booked: Array<readonly [string, string, string]>;
  readonly fault: FaultSwitch<'order-desk'>;
  readonly request: Handoff;
  readonly context: JobContext;
  readonly deps: OrderDeps;
  /** What `takeChecks` gives. A test changes it. */
  entry: TakenChecks | null;
  /** What `decide` answers. A test changes it. */
  decision: DecideResult<AvailabilityChoice>;
  /** An error that the order book throws, or null. */
  bookError: Error | null;
  /** True when the log throws. */
  logThrows: boolean;
  run(over?: { readonly request?: Handoff; readonly signal?: AbortSignal }): Promise<OrderConfirmation>;
}

/** A rig in which the job passes every step: the record is there, the gateway issues the SVID, the portal takes the order, and the model confirms. */
export function makeRig(options: RigOptions = {}): Rig {
  const events: string[] = [];
  const logs: string[] = [];
  const takes: string[] = [];
  const decideInputs: JsonValue[] = [];
  const booked: Array<readonly [string, string, string]> = [];
  const gateway = createStubGateway();
  const agent = gateway.createAgent({ label: 'order-desk' });
  const viaGateway: typeof fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (new URL(url).pathname === '/spiffe/x509-svid') events.push('svid');
    return gateway.fetch(input, init);
  };
  const client = createGatewayClient({ baseUrl: gateway.baseUrl, fetch: viaGateway, now: gateway.now });
  const portal = new Portal(events);
  const fault = readFaultSwitch('order-desk', options.mode ?? '');
  const document = purchaseOrder(options.order ?? {});
  const request = handoffOf(document);
  const context: JobContext = {
    escrowRef: ESCROW_REF, advertRef: ADVERT_REF, advertModel: String(document.lot), buyerPkh: BUYER_PKH, paymentLovelace: 5_000_000n, deliverByMs: gateway.now() + 300_000,
  };
  const rig: Rig = {
    gateway, agent, portal, events, logs, takes, decideInputs, booked, fault, request, context,
    entry: recordFor(request),
    decision: accepted(decisionOf()),
    bookError: null,
    logThrows: false,
    deps: {
      agent: { did: agent.did, authenticationKey: agent.authentication.privateKey },
      svid: { client },
      calls: { fetch: noFetch, clock: clockOf(gateway), bases: BASES, transport: portal.transport },
      takeChecks: (escrowRef) => {
        events.push('take');
        takes.push(escrowRef);
        const given = rig.entry;
        if (options.oneShot === true) rig.entry = null;
        return given;
      },
      lots: options.lots ?? LOTS,
      book: {
        record: async (tenant, poNumber, orderId) => {
          events.push('book');
          if (rig.bookError !== null) throw rig.bookError;
          booked.push([tenant, poNumber, orderId]);
        },
      },
      decide: async (input) => {
        events.push('decide');
        decideInputs.push(input);
        return rig.decision;
      },
      fault,
      clock: () => gateway.now(),
      log: (line) => {
        if (rig.logThrows) throw new Error('the log is closed');
        logs.push(line);
      },
    },
    run: (over = {}) => runOrder(rig.deps, over.request ?? request, context, gateway.now(), over.signal),
  };
  return rig;
}

/** The refusal that a job ends with. A job that gives a result, and a job that throws anything else, fail the test. */
export async function refusalOf(work: Promise<unknown>): Promise<OrderRefusal> {
  let result: unknown;
  try {
    result = await work;
  } catch (error) {
    if (error instanceof OrderRefusal) return error;
    throw error;
  }
  throw new Error(`the job gave a result and did not refuse: ${JSON.stringify(result).slice(0, 80)}`);
}

/** The lines of the body of a PEM key: the part that a log must never repeat. */
const keyLines = (pem: string): string[] => pem.split('\n').filter((line) => line.length >= 16 && !line.startsWith('-----'));

/** No text holds a private key or a certificate: not the service key, and not the key of the SVID that the calls presented. */
export function expectNoSecrets(rig: Rig, texts: readonly string[]): void {
  const keys = [rig.agent.authentication.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(), ...rig.portal.calls.map((call) => call.key)];
  for (const text of texts) {
    expect(text).not.toContain('PRIVATE KEY');
    expect(text).not.toContain('BEGIN CERTIFICATE');
    for (const key of keys) for (const line of keyLines(key)) expect(text).not.toContain(line);
  }
}

/** The order that the Order Desk sent last, as an object: the body of the last POST of the portal calls. */
export function sentOrder(portal: Portal): Record<string, unknown> {
  const post = [...portal.calls].reverse().find((call) => call.method === 'POST');
  if (post === undefined) throw new Error('no order was sent');
  return JSON.parse(post.body ?? 'null') as Record<string, unknown>;
}
