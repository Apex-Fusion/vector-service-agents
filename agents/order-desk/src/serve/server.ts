// agents/order-desk/src/serve/server.ts
// The HTTP surface of the Order Desk, on the job server of the service kit. The runtimes (one for each lot) hold the supplier keys, ask the hook before they claim an escrow, and post the job after the Claim.
//
//   POST /precheck   the hook: the 16 checks of the Order Desk. A go keeps the record of the checks for the job and reserves the job slot for the escrow. A refusal is the status and the code of the check, and the
//                    escrow stays open. The option is never absent: a service with no hook would claim every escrow.
//   POST /           the job: the confirmation of the order. It takes the record of the hook by the escrow of its context, and only for the body that the hook checked. A job with no record, or with the record of
//                    another body, fails closed and writes nothing.
//   GET /lots.json   the lots file, as the bytes that the manifest hashes. It needs no token and takes no job slot.
//   GET /agent.json, GET /healthz   the manifest that the service rendered at its start, and the health of the service.
//
// The request is the handoff of use case 1 (inventory reorder): a handoff for another use case, and a document that is not a purchase order, are `bad_shape` (400). The hook has no check for another use case, and
// the kit reads a handoff of use case 2 too, so the refusal is made here, before the hook and before the job. A job needs the context of the runtime: a call with none is `bad_context` (400). Every result of the job
// names the fault setting (`withFaultModeJob`). A caller that hangs up stops the job before the order (`abortOnClose`): an order must never be placed that nobody will read. The line of a job names counts and
// codes and nothing else: never a request, a purchase order, a catalogue entry, a key or a token.
import type { Server } from 'node:http';
import { createJobServer } from '@vsa/service-kit';
import type { JobContext, JobSlot, OpenRoute, PrecheckAnswer, Refusal } from '@vsa/service-kit';
import { withFaultModeJob } from '@vsa/usecase-kit/fault';
import type { FaultSwitch, WithFaultMode } from '@vsa/usecase-kit/fault';
import { parsePurchaseOrder } from '@vsa/usecase-kit/inventory';
import type { OrderConfirmation } from '@vsa/usecase-kit/inventory';
import { parseHandoff, parseJsonText } from '@vsa/usecase-kit/protocol';
import type { Handoff } from '@vsa/usecase-kit/protocol';
import { OrderRefusal, runOrder } from '../job/index.ts';
import type { OrderDeps } from '../job/index.ts';
import { LOTS_ROUTE } from './settings.ts';

/** The log of the process: one line each on stdout, with the name of the service. */
export const defaultLog = (line: string): void => { console.log(`[order-desk] ${line}`); };

/** A request that the service refuses before the job: a body that is no handoff of use case 1, or a call with no context. The message names a member and never repeats a value. */
export class RequestRefusal extends Error implements Refusal {
  readonly code: 'bad_shape' | 'bad_context';
  readonly status = 400;
  readonly kind = 'request' as const;

  constructor(code: 'bad_shape' | 'bad_context', message: string) {
    super(message);
    this.name = 'RequestRefusal';
    this.code = code;
  }
}

/** The handoff of the request text, for use case 1: the form of the protocol, the use case `inventory-reorder`, and a document that is a purchase order. Anything else is `bad_shape`. */
export function parseOrderRequest(text: string): Handoff {
  const json = parseJsonText(text, 'request');
  if (!json.ok) throw new RequestRefusal('bad_shape', json.detail);
  const handoff = parseHandoff(json.value);
  if (!handoff.ok) throw new RequestRefusal('bad_shape', handoff.detail);
  if (handoff.value.use_case !== 'inventory-reorder') {
    throw new RequestRefusal('bad_shape', 'handoff.use_case must be inventory-reorder: the Order Desk takes the handoff of use case 1 (inventory reorder) only');
  }
  const order = parsePurchaseOrder(handoff.value.document, 'handoff.document');
  if (!order.ok) throw new RequestRefusal('bad_shape', order.detail);
  return handoff.value;
}

/** A refusal of the request (RequestRefusal) or of the job (OrderRefusal), as the job server answers it; null for anything else, which is a 500 `internal`. */
function refusalOf(error: unknown): Refusal | null {
  if (error instanceof RequestRefusal || error instanceof OrderRefusal) return { code: error.code, status: error.status, message: error.message, kind: error.kind };
  return null;
}

export interface ServerOptions {
  /** The bytes that GET /agent.json answers: the manifest that the service rendered once, with the hash that the three adverts hold. */
  readonly manifestText: string;
  /** The token that POST / and POST /precheck require (SERVICE_AUTH_HEADER). A server is never made without one. */
  readonly authHeader: string;
  /** The fault switch of the service, made at its start. Every result of the job names its setting. */
  readonly fault: FaultSwitch<'order-desk'>;
  /** The hook. Required: a service with no hook would claim every escrow. */
  readonly precheck: (request: Handoff, context: JobContext) => Promise<PrecheckAnswer>;
  /** The ports of the job that arrived at the time given. The server asks for them when the job starts, so the deadline of the job is the one of its arrival. */
  readonly jobDeps: (arrivedAt: number) => OrderDeps;
  /** The text of the lots file as the service read it. The route serves exactly this text, and the manifest holds the hash of its bytes. */
  readonly lotsText: string;
  readonly clock: () => number;
  readonly log: (line: string) => void;
  /** How often a job that is running is sent an interim line: the default of the job server, and no more than that. */
  readonly heartbeatMs?: number;
  /** The slot jobs run in; a service that wants to stop drains it. A new one by default. */
  readonly slot?: JobSlot;
}

/** The result of a job as the server writes it: the confirmation with the field `fault_mode` of the switch as its last member. */
export type OrderResult = WithFaultMode<OrderConfirmation, 'order-desk'>;

export function createServer(options: ServerOptions): Server {
  if (typeof options.precheck !== 'function') throw new TypeError('the hook of the Order Desk is required: a service with no hook would claim every escrow');
  const lotsRoute: OpenRoute = { path: LOTS_ROUTE, methods: ['GET'], handle: () => ({ status: 200, headers: { 'content-type': 'application/json' }, body: options.lotsText }) };
  const job = (request: Handoff, arrivedAt: number, signal: AbortSignal | undefined, context: JobContext | undefined): Promise<OrderConfirmation> => {
    if (context === undefined) throw new RequestRefusal('bad_context', 'The job needs the six headers of the context that the runtime sends: the Order Desk takes no job without them.');
    return runOrder(options.jobDeps(arrivedAt), request, context, arrivedAt, signal);
  };
  return createJobServer<Handoff, OrderResult>({
    manifestText: options.manifestText,
    authHeader: options.authHeader,
    parse: parseOrderRequest,
    precheck: options.precheck,
    run: withFaultModeJob(options.fault, job),
    refusalOf,
    clock: options.clock,
    log: options.log,
    abortOnClose: true,
    openRoutes: [lotsRoute],
    ...(options.heartbeatMs === undefined ? {} : { heartbeatMs: options.heartbeatMs }),
    ...(options.slot === undefined ? {} : { slot: options.slot }),
  });
}
