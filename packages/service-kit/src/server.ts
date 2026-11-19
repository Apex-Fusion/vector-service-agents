// packages/service-kit/src/server.ts
// The HTTP surface of a service behind the template runtime. The runtime holds the supplier key, claims the escrow of a hirer and posts the job as the body of
// POST / (the wire message, src/wire.ts); the service answers with the result, which the runtime hashes into the receipt it signs. Moved from
// agents/document-pipeline/src/server.ts, whose behaviour it keeps line for line; what is the service's own (the request, the job, its refusals, its health
// check, its log lines) comes in the options.
//
//   GET  /healthz     {ok: true}, or 503 {ok: false, reason} once the last health check failed (src/health.ts); always ok for a service without a check.
//   GET  /agent.json  the manifest, the bytes the service was given (JSON.stringify of it), which the advert hashes.
//                     These two are matched on their path, whatever the query, and a HEAD of either gets the headers of the GET and no body.
//   POST /            the wire message only, and only from the runtime: the authorization header must be exactly the token the service was given
//                     (SERVICE_AUTH_HEADER, which the template runtime sends with every call), or the answer is 401 {error: "unauthorized"} with no detail,
//                     before the body is read and before the job slot is taken. At most MAX_BODY bytes, one job at a time: a second one gets 409
//                     {error: "busy"}. While the job runs the server writes "102 Processing" every minute, so that the runtime's fetch does not give up on
//                     the silence (HEARTBEAT_MS). The answer is serialize(result), made once. A refusal is {error: code, message} with its status: a WireError
//                     is 400; anything refusalOf reads is its refusal, and one of 500 or more gets a fixed text for the buyer and its whole message in the
//                     log. Anything else is 500 {error: "internal"} with no detail, and the cause goes to the log, by message only, never the request.
//   POST /precheck    the question the runtime asks before it claims an escrow, with the body of the job and the six context headers (src/context.ts), which this
//                     route needs: none, some, or a bad one is 400 {error: "bad_context", message}. The token rule is the one of POST /, and the body is read and
//                     parsed as for a job. A service that is stopping answers 503 {error: "shutting_down", message}. One that is busy, or whose slot is reserved for
//                     another escrow, answers 409 {error: "busy", message}, before the option precheck(request, context) is asked. The option answers { go: true }
//                     or a refusal { go: false, status, error, message }, and a refusal is answered as {error, message} with its status (400 to 599; one of 500 or
//                     more gets the fixed text for the buyer, as a job does). A go is 200 {go: true, reserved_ms} and reserves the job slot for the escrow of the
//                     call (RESERVATION_MS, src/slot.ts). Without the option every call that passes the checks above is a go.
//   anything else     404 {error: "not_found"}, POST / and POST /precheck with a query among them.
//
// A caller that hangs up (ruling R-D24). The runtime aborts its call at its own budget, min(SERVICE_TIMEOUT_MS, deliver_by - send time - 30 s), and frees the
// escrow. By default the job runs to its end whatever its connection does, and holds the slot until then: a service whose job must settle what it started (the
// Document Pipeline's sub-escrows) needs that. A service that keeps nothing of a job sets abortOnClose: when the connection of a job ends before its answer
// has been written, the server logs "job abandoned by the caller after <ms> ms" once and aborts the signal it gave the run, and the slot is free as soon as
// the run has settled, as for any job. The response's own 'close' is what says so; the request's says nothing, for it comes as soon as its body has been read.
// A service that sets abortOnClose and still commits value in a job (an escrow its run posts as a buyer, packages/hire-kit) looks at the signal before the
// commitment and after it, and never passes the signal into it: a hire under way ends on its own terms, settled or recorded for its janitor.
//
// The reservation. A go of POST /precheck holds the one job slot for the escrow of the call, for RESERVATION_MS (120 s). The job call whose context names that escrow
// takes the reservation and holds the slot as any job does. While the reservation stands, a job call that names another escrow, or none, gets 409 {error: "busy"}, and
// so does a pre-check for another escrow; a pre-check for the same escrow is a go again, and the 120 s start again. A reservation that no job takes ends after 120 s,
// and the slot then takes any job. A job call with no reservation takes the slot as it always did, with a context or without one. The time is the time of the clock
// option, so that a test moves it by hand. A pre-check whose caller hangs up before the answer is written reserves nothing: a go that nobody heard is no promise. A
// stop does not wait for a reservation: it takes no new job, the reserved one included, and waits for the job that runs.
import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer as httpServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { ContextError, parseContext, requireContext } from './context.ts';
import type { JobContext } from './context.ts';
import type { HealthMonitor } from './health.ts';
import { JobSlot, RESERVATION_MS } from './slot.ts';
import { errorText } from './text.ts';
import { WireError, parseWire, readBody } from './wire.ts';

/**
 * How often, while a job runs, the server writes an interim "102 Processing" line. The template runtime calls the service with the global fetch and only
 * AbortSignal.timeout(budget). Behind fetch, undici gives up on a response that has not begun after 300 s (its headers timeout): without a line now and then
 * the runtime would report service_unreachable at the five minute mark while the service goes on with the job and holds its slot. Undici counts an interim
 * response as life and keeps waiting for the final one, so a line a minute is plenty, and the option may not be longer. The final answer is what it was.
 */
export const HEARTBEAT_MS = 60_000;
/** What a buyer is told when the service is stopping. */
export const STOPPING_TEXT = 'The service is stopping and takes no new job. Try again shortly.';
/** What a buyer is told when the service cannot take the job now: another job runs, or the slot is reserved for another escrow. */
export const BUSY_TEXT = 'The service is working on another job. Try again shortly.';
/**
 * What a buyer is told when the service fails on its side: the runtime copies the first 200 characters of a failure to the buyer, and the detail of a failure
 * on this side (a path, an escrow, the text of a provider) is the operator's.
 */
export const operatorsText = (code: string): string => `The service could not do this job (${code}). The operator's log has the detail.`;

/** A refusal as the server answers it: the code to branch on, the status, the words for a person, and whose it is (a request refused, or a job that failed). */
export interface Refusal { code: string; status: number; message: string; kind: 'request' | 'job' }

/**
 * What the option precheck answers: { go: true }, or a refusal that the runtime hands to the buyer as it is: the status (400 to 599, for the runtime reads any other
 * status as a go), the code to branch on, and the words for a person.
 */
export type PrecheckAnswer = { go: true } | { go: false; status: number; error: string; message: string };

export interface JobServerOptions<Req, Res> {
  /** The bytes GET /agent.json answers: JSON.stringify of the manifest, made once by the caller. */
  manifestText: string;
  /** The token the runtime sends as the authorization header of every call (SERVICE_AUTH_HEADER), which POST / and POST /precheck require. A server is never made without one. */
  authHeader: string;
  /** The request JSON (the content of the wire message) as the request of the job; throws what refusalOf reads for a request it refuses. */
  parse: (requestJson: string) => Req;
  /**
   * Runs one job, which arrived at `arrivedAt` (the clock's time). With abortOnClose it is given `signal`, which aborts when the caller hangs up. `context` is what
   * the runtime said of the escrow in the six context headers of the call (src/context.ts), and is undefined for a call that came with none.
   */
  run: (request: Req, arrivedAt: number, signal?: AbortSignal, context?: JobContext) => Promise<Res>;
  /**
   * The check of POST /precheck, which the runtime asks before it claims an escrow. It is given the request, parsed as for a job from the same body, and the context of
   * the call (src/context.ts), and answers { go: true } or a refusal { go: false, status, error, message } with a status from 400 to 599, which the runtime hands to the
   * buyer as {error, message}. It may throw what refusalOf reads, as parse and run do. Any other answer is a fault of the service: 500 internal, never a go. The runtime
   * waits 10 s for the answer and reads no answer as a refusal, so the check answers at once. Without this option every pre-check that passes the checks of the kit is a go.
   */
  precheck?: (request: Req, context: JobContext) => PrecheckAnswer | Promise<PrecheckAnswer>;
  /** The answer's body: JSON.stringify(result) by default, made once, exactly the bytes the runtime hashes. */
  serialize?: (result: Res) => string;
  /** Called with a result that is about to be answered: the service writes its own line ("job done in <ms> ms" by default). */
  done?: (result: Res, arrivedAt: number) => void;
  /** Reads a thrown value as a refusal; null for anything else, which is a 500 internal. */
  refusalOf: (error: unknown) => Refusal | null;
  /** The check of GET /healthz; without one it always says ok. Poked once when the server is made. */
  health?: HealthMonitor;
  clock: () => number;
  log: (line: string) => void;
  /** How often a job that is running is sent an interim line: HEARTBEAT_MS by default, and no more than that. */
  heartbeatMs?: number;
  /** The slot jobs run in; a service that wants to stop drains it. A new one by default. */
  slot?: JobSlot;
  /**
   * Stop a job whose caller hangs up before its answer has been written: the run is given a signal that aborts then (see the head of this file). False by
   * default, for a job that must run to its end whatever its caller does.
   */
  abortOnClose?: boolean;
}

/**
 * Starts the interim lines of one job: a timer, unref'd so that it never keeps the process alive, which writes "102 Processing" to the response unless its
 * headers are out or it is gone. Only an HTTP/1.1 client is sent one (an interim response is not for HTTP/1.0). A write that fails changes nothing for the
 * job: the client is gone. The caller clears the timer in the same place it frees the slot.
 */
function startHeartbeat(req: IncomingMessage, res: ServerResponse, everyMs: number): NodeJS.Timeout | undefined {
  if (!(req.httpVersionMajor === 1 && req.httpVersionMinor >= 1)) return undefined;
  const timer = setInterval(() => {
    if (res.headersSent || res.destroyed) return;
    try { res.writeProcessing(); } catch { /* the socket is gone; the job goes on */ }
  }, everyMs);
  timer.unref();
  return timer;
}

// The sha256 digest of a value: 32 bytes whatever its length, so that two of them can be compared in constant time without leaking the content or the length.
const digest = (value: string): Buffer => createHash('sha256').update(value, 'utf8').digest();
// A call refused for want of the token is logged once a minute at most, with the count since the last line: a caller that cannot authenticate must not fill the log.
const REFUSAL_LOG_MS = 60_000;

const GO: PrecheckAnswer = { go: true };

/** A refusal that the option precheck answered, carried to the one place that answers refusals. */
class PrecheckRefused extends Error {
  constructor(readonly refusal: Refusal) { super(refusal.message); }
}

/**
 * What the option answered: nothing for a go, a PrecheckRefused for a refusal, and an error for anything else. A service that answers a thing that is neither has a
 * fault, and the fault must never be read as a go, for the runtime claims the escrow on a go.
 */
function checkAnswer(answer: unknown): void {
  const given = typeof answer === 'object' && answer !== null ? (answer as { go?: unknown; status?: unknown; error?: unknown; message?: unknown }) : {};
  if (given.go === true) return;
  if (given.go === false && typeof given.status === 'number' && Number.isInteger(given.status) && given.status >= 400 && given.status <= 599
    && typeof given.error === 'string' && given.error !== '' && typeof given.message === 'string') {
    throw new PrecheckRefused({ code: given.error, status: given.status, message: given.message, kind: 'request' });
  }
  throw new Error('the precheck option must answer { go: true } or { go: false, status, error, message } with a status from 400 to 599');
}

export function createJobServer<Req, Res>(opts: JobServerOptions<Req, Res>): Server {
  const { clock, log } = opts;
  const slot = opts.slot ?? new JobSlot();
  const heartbeatMs = opts.heartbeatMs ?? HEARTBEAT_MS;
  if (!(heartbeatMs > 0 && heartbeatMs <= HEARTBEAT_MS)) {
    throw new RangeError(`heartbeatMs must be more than 0 and at most ${HEARTBEAT_MS}, for the runtime's fetch gives up after 300 s of silence, got ${heartbeatMs}`);
  }
  if (typeof opts.authHeader !== 'string' || opts.authHeader === '') {
    throw new RangeError('authHeader must be the value of SERVICE_AUTH_HEADER and not empty: a service made without one would answer anyone who can reach its port');
  }
  const serialize = opts.serialize ?? ((result: Res): string => JSON.stringify(result));
  const done = opts.done ?? ((_result: Res, arrivedAt: number): void => { log(`job done in ${clock() - arrivedAt} ms`); });
  const expectedAuth = digest(opts.authHeader);
  // The header of the call against the token: both digested, so the two buffers are of one length, and compared with timingSafeEqual. Nothing here is logged or answered.
  const authorised = (req: IncomingMessage): boolean => {
    const given = req.headers.authorization;
    return typeof given === 'string' && timingSafeEqual(digest(given), expectedAuth);
  };
  let refusals = 0; // calls refused since the last line of this kind
  let lastRefusalLine: number | undefined;
  const noteRefusal = (at: number): void => {
    refusals++;
    if (lastRefusalLine !== undefined && at >= lastRefusalLine && at - lastRefusalLine < REFUSAL_LOG_MS) return; // a clock that was set back logs again, it does not go silent
    log(`request refused: unauthorized (${refusals} since the last line of this kind)`);
    lastRefusalLine = at;
    refusals = 0;
  };
  opts.health?.poke(); // the first check, at start
  return httpServer(async (req, res) => {
    const arrivedAt = clock();
    const head = req.method === 'HEAD';
    // The body is serialised before anything is written, so a body that cannot be serialised can still be answered with a 500. A HEAD gets the headers a GET
    // would, its content-length included, and no body.
    const sendText = (status: number, text: string) => {
      // A 400 and a 401 may be answered before the body has been read to its end (too large, or not read at all), so the connection is closed after them.
      res.writeHead(status, {
        'content-type': 'application/json', ...(head ? { 'content-length': Buffer.byteLength(text, 'utf8') } : {}), ...(status === 400 || status === 401 ? { connection: 'close' } : {}),
      });
      if (head) res.end(); else res.end(text);
    };
    const send = (status: number, body: unknown) => sendText(status, JSON.stringify(body));
    // POST /precheck is the one other route that posts: the question the runtime asks before it claims an escrow.
    const precheck = req.method === 'POST' && req.url === '/precheck';
    try {
      // The two open routes are matched on their path, whatever the query, and answer HEAD as they answer GET.
      const path = (req.url ?? '').split('?', 1)[0];
      const read = req.method === 'GET' || head;
      if (read && path === '/healthz') {
        const health = opts.health;
        if (health === undefined) return send(200, { ok: true });
        health.poke();
        return health.healthy ? send(200, { ok: true }) : send(503, { ok: false, reason: health.reason });
      }
      if (read && path === '/agent.json') return sendText(200, opts.manifestText);
      if (req.method !== 'POST' || (req.url !== '/' && !precheck)) return send(404, { error: 'not_found' });
      // Only the runtime posts a job or a pre-check. The check comes before the body is read and before the slot is looked at, so a stranger neither makes the service
      // read a megabyte nor learns that a job is running (a 409 would say so), and what the answer says is the same for a missing header and a wrong one.
      if (!authorised(req)) {
        noteRefusal(arrivedAt);
        return send(401, { error: 'unauthorized' });
      }
      // The answer of a pre-check is about one escrow, so its context is needed. The body is the job's, read and parsed as for a job.
      if (precheck) {
        const context = requireContext(req.headers);
        const request = opts.parse(parseWire(await readBody(req)));
        const refuseSlot = (why: 'busy' | 'held' | 'draining') => {
          if (why === 'draining') {
            log('pre-check refused: the service is stopping');
            return send(503, { error: 'shutting_down', message: STOPPING_TEXT });
          }
          log(`pre-check refused after ${clock() - arrivedAt} ms: busy (409), ${why === 'busy' ? 'a job is running' : 'the slot is held for another escrow'}`);
          return send(409, { error: 'busy', message: BUSY_TEXT });
        };
        // A service that is stopping, busy, or held for another escrow need not look at the request: the option is not asked.
        const before = slot.canTake(context.escrowRef, clock());
        if (before !== 'free') return refuseSlot(before);
        checkAnswer(opts.precheck === undefined ? GO : await opts.precheck(request, context));
        // A runtime that has hung up (its own wait is over) did not hear the answer, and a go that nobody heard is no promise: nothing is reserved.
        if (res.destroyed) {
          log(`pre-check abandoned by the caller after ${clock() - arrivedAt} ms`);
          return;
        }
        // The slot is looked at again: a job can have taken it, and a stop can have begun, while the option was asked.
        const reserved = slot.reserve(context.escrowRef, clock());
        if (reserved !== 'reserved') return refuseSlot(reserved);
        log(`pre-check go for ${context.escrowRef} after ${clock() - arrivedAt} ms: the slot is reserved for ${RESERVATION_MS} ms`);
        return send(200, { go: true, reserved_ms: RESERVATION_MS });
      }
      // The context of the call, when the runtime sent one, is read before the body: a call with a bad header is refused with no upload read.
      const context = parseContext(req.headers);
      const request = opts.parse(parseWire(await readBody(req)));
      const taken = slot.take(context?.escrowRef, clock());
      if (taken === 'busy') return send(409, { error: 'busy' });
      if (taken === 'held') {
        log('job refused: the slot is held for another escrow');
        return send(409, { error: 'busy' });
      }
      if (taken === 'draining') {
        log('job refused: the service is stopping');
        return send(503, { error: 'shutting_down', message: STOPPING_TEXT });
      }
      // The heartbeat starts inside the try whose finally releases the slot: a heartbeat that cannot start must not hold the slot for ever.
      let heartbeat: NodeJS.Timeout | undefined;
      let result: Res;
      // With abortOnClose, the end of the connection before the answer is written stops the job, once (see the head of this file).
      const abort = opts.abortOnClose === true ? new AbortController() : undefined;
      const abandoned = (): void => {
        if (abort === undefined || abort.signal.aborted || res.writableEnded) return;
        log(`job abandoned by the caller after ${clock() - arrivedAt} ms`);
        abort.abort();
      };
      try {
        heartbeat = startHeartbeat(req, res, heartbeatMs);
        if (abort !== undefined) {
          res.on('close', abandoned);
          if (res.destroyed) abandoned(); // gone before the job began
        }
        result = await opts.run(request, arrivedAt, abort?.signal, context);
      } finally {
        clearInterval(heartbeat);
        if (abort !== undefined) res.off('close', abandoned);
        slot.release();
      }
      const text = serialize(result);
      done(result, arrivedAt);
      return sendText(200, text);
    } catch (e) {
      // Headers already out: nothing more can be said on this response. Log why, then cut it.
      if (res.headersSent) { log(`response failed after the headers were sent: ${errorText(e)}`); res.destroy(); return; }
      const given: Refusal | null = e instanceof WireError || e instanceof ContextError ? { code: e.code, status: e.status, message: e.message, kind: 'request' }
        : e instanceof PrecheckRefused ? e.refusal : opts.refusalOf(e);
      // The runtime reads any 2xx as a go. A refusal of a pre-check with a status that is not 400 to 599 is a fault of the service, and is never answered as it is.
      const refusal = precheck && given !== null && !(given.status >= 400 && given.status <= 599) ? null : given;
      if (refusal !== null) {
        const took = clock() - arrivedAt;
        if (refusal.status >= 500) {
          // A failure on this side: the whole message is for the operator's log, and the buyer gets the code.
          log(`job failed after ${took} ms: ${refusal.code} (${refusal.status}): ${errorText(refusal.message, 1000)}`);
          return send(refusal.status, { error: refusal.code, message: operatorsText(refusal.code) });
        }
        log(`${refusal.kind === 'job' ? 'job failed' : 'request refused'} after ${took} ms: ${refusal.code} (${refusal.status})`);
        return send(refusal.status, { error: refusal.code, message: refusal.message });
      }
      log(`job failed after ${clock() - arrivedAt} ms: internal error: ${errorText(e)}`); // the message only, never the request
      return send(500, { error: 'internal' });
    }
  });
}
