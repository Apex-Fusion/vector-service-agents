// agents/bid-desk/src/serve/server.ts
// The HTTP surface of the Bid Desk, on the job server of the service kit. The runtime holds the supplier key, asks the hook before it claims an escrow, and posts the job after the Claim.
//
//   POST /precheck       the hook: the 7 checks of the Bid Desk. A go keeps the record of the checks for the job and reserves the job slot for the escrow. A refusal is the status and the code of the check, and
//                        the escrow stays open. The option is never absent: a service with no hook would claim every escrow.
//   POST /               the job: the quote. It takes the record of the hook by the escrow of its context, and only for the body that the hook checked. A job with no record, or with the record of another
//                        body, fails closed and writes nothing.
//   GET /price-list.json the price list of the instance, as the bytes that the manifest hashes. It needs no token and takes no job slot.
//   GET /agent.json, GET /healthz   the manifest that the service rendered at its start, and the health of the service.
//
// The request is the message of use case 3 (supplier bid evaluation): the schema of the request for quotation, a sender, a delegation and the request. A request that breaks a rule of the intake is `bad_shape`
// (400) on both routes. The request for quotation is read as it was written, before the protocol makes its copy in the NFC form: a text that only NFC turns into a valid identifier (the Kelvin sign that
// becomes the letter K) is refused here, as the Sourcing Agent refuses it. A job needs the context of the runtime: a call with none is `bad_context` (400). Every result of the job names the fault setting
// (`withFaultModeJob`). A caller that hangs up stops the job before the quote is booked (`abortOnClose`): a quote must never be booked that nobody will read. The line of a job names counts and codes and
// nothing else: never a request, a price list, a credential, a key or a token.
import type { Server } from 'node:http';
import { createJobServer } from '@vsa/service-kit';
import type { JobContext, JobSlot, OpenRoute, PrecheckAnswer, Refusal } from '@vsa/service-kit';
import { parseRfqDocument } from '@vsa/usecase-kit/bids';
import type { Quote } from '@vsa/usecase-kit/bids';
import { withFaultModeJob } from '@vsa/usecase-kit/fault';
import type { FaultSwitch, WithFaultMode } from '@vsa/usecase-kit/fault';
import { isPlainObject, parseJsonText, parseRfq } from '@vsa/usecase-kit/protocol';
import type { RfqMessage } from '@vsa/usecase-kit/protocol';
import { QuoteRefusal, runQuote } from '../job/index.ts';
import type { QuoteDeps } from '../job/index.ts';
import { PRICE_LIST_ROUTE } from './settings.ts';

/** The log of the process: one line each on stdout, with the name of the service. */
export const defaultLog = (line: string): void => { console.log(`[bid-desk] ${line}`); };

/** A request that the service refuses before the job: a body that is no message of use case 3, or a call with no context. The message names a member and never repeats a value. */
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

/**
 * The message of the request text: the form of the protocol with a request for quotation that is valid as it was written. The request for quotation is read before the protocol copies it, because the copy is
 * in the NFC form, and a Kelvin sign in an identifier or a SKU would then pass as the letter K. Anything else is `bad_shape`.
 */
export function parseRfqRequest(text: string): RfqMessage {
  const json = parseJsonText(text, 'request');
  if (!json.ok) throw new RequestRefusal('bad_shape', json.detail);
  if (isPlainObject(json.value) && Object.hasOwn(json.value, 'rfq')) {
    const written = parseRfqDocument(json.value.rfq, 'request.rfq');
    if (!written.ok) throw new RequestRefusal('bad_shape', written.detail);
  }
  const message = parseRfq(json.value);
  if (!message.ok) throw new RequestRefusal('bad_shape', message.detail);
  return message.value;
}

/** A refusal of the request (RequestRefusal) or of the job (QuoteRefusal), as the job server answers it; null for anything else, which is a 500 `internal`. */
function refusalOf(error: unknown): Refusal | null {
  if (error instanceof RequestRefusal || error instanceof QuoteRefusal) return { code: error.code, status: error.status, message: error.message, kind: error.kind };
  return null;
}

export interface ServerOptions {
  /** The bytes that GET /agent.json answers: the manifest that the service rendered once, with the hash that the advert holds. */
  readonly manifestText: string;
  /** The token that POST / and POST /precheck require (SERVICE_AUTH_HEADER). A server is never made without one. */
  readonly authHeader: string;
  /** The fault switch of the service, made at its start. Every result of the job names its setting. */
  readonly fault: FaultSwitch<'bid-desk'>;
  /** The hook. Required: a service with no hook would claim every escrow. */
  readonly precheck: (request: RfqMessage, context: JobContext) => Promise<PrecheckAnswer>;
  /** The ports of the job that arrived at the time given, for the escrow that its context names. The server asks for them when the job starts, so the deadline of the job is the one of its arrival and of its `deliver_by`. */
  readonly jobDeps: (arrivedAt: number, context: JobContext) => QuoteDeps;
  /** The text of the price list file as the service read it. The route serves exactly this text, and the manifest holds the hash of its bytes. */
  readonly priceListText: string;
  readonly clock: () => number;
  readonly log: (line: string) => void;
  /** How often a job that is running is sent an interim line: the default of the job server, and no more than that. */
  readonly heartbeatMs?: number;
  /** The slot jobs run in; a service that wants to stop drains it. A new one by default. */
  readonly slot?: JobSlot;
}

/** The result of a job as the server writes it: the quote with the field `fault_mode` of the switch as its last member. */
export type QuoteResult = WithFaultMode<Quote, 'bid-desk'>;

export function createServer(options: ServerOptions): Server {
  if (typeof options.precheck !== 'function') throw new TypeError('the hook of the Bid Desk is required: a service with no hook would claim every escrow');
  const priceListRoute: OpenRoute = { path: PRICE_LIST_ROUTE, methods: ['GET'], handle: () => ({ status: 200, headers: { 'content-type': 'application/json' }, body: options.priceListText }) };
  const job = (request: RfqMessage, arrivedAt: number, signal: AbortSignal | undefined, context: JobContext | undefined): Promise<Quote> => {
    if (context === undefined) throw new RequestRefusal('bad_context', 'The job needs the six headers of the context that the runtime sends: the Bid Desk takes no job without them.');
    return runQuote(options.jobDeps(arrivedAt, context), request, context, arrivedAt, signal);
  };
  return createJobServer<RfqMessage, QuoteResult>({
    manifestText: options.manifestText,
    authHeader: options.authHeader,
    parse: parseRfqRequest,
    precheck: options.precheck,
    run: withFaultModeJob(options.fault, job),
    refusalOf,
    clock: options.clock,
    log: options.log,
    abortOnClose: true,
    openRoutes: [priceListRoute],
    ...(options.heartbeatMs === undefined ? {} : { heartbeatMs: options.heartbeatMs }),
    ...(options.slot === undefined ? {} : { slot: options.slot }),
  });
}
