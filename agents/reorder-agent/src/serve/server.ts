// agents/reorder-agent/src/serve/server.ts
// The service behind the template runtime, on the HTTP surface of packages/service-kit (`createJobServer`): GET /healthz, GET /agent.json, POST / (the job, with the token of the runtime), POST /precheck (the
// reservation of the job slot, with no check of its own), and one open route, POST /cosign/delegate. The runtime holds the supplier key, claims the escrow of a hirer, and posts the job to this service as the body of
// POST /. The request is parsed by `parseRequest` of the kit with the two fields of `propose`, and the job is `runPropose` or `runExecute` by its operation. Every result gets the member `fault_mode` from the
// one switch of the process, and the Reorder Agent has no fault value, so the member is always the empty text.
//
// A job whose caller hangs up is stopped (`abortOnClose`). `propose` reads the signal before each step and still ends its sub-delegation. `execute` reads it one time, before the hire, and never gives it to the
// hire: a runtime that hung up must not get an order written with no answer, and a hire that has paid is carried to its end. The deadline of a job is 1,620,000 ms after its arrival.
//
// The line of a job names counts and codes and nothing else: no request, no stock reading, no order, no confirmation and no key.
import type { Server } from 'node:http';
import { createJobServer } from '@vsa/service-kit';
import type { JobSlot, OpenRoute, Refusal } from '@vsa/service-kit';
import type { CosignRoute } from '@vsa/usecase-kit/cosign';
import { withFaultModeJob } from '@vsa/usecase-kit/fault';
import type { FaultSwitch, WithFaultMode } from '@vsa/usecase-kit/fault';
import { ERROR_STATUS, checkRequestSize, parseJsonText, parseRequest } from '@vsa/usecase-kit/protocol';
import type { ExecuteResult, ProposalResult, UseCaseRequest } from '@vsa/usecase-kit/protocol';
import { ExecuteRefusal, runExecute } from '../execute/index.ts';
import type { ExecuteDeps } from '../execute/index.ts';
import { parseProposeFields } from '../model/index.ts';
import type { ProposeFields } from '../model/index.ts';
import { ProposeRefusal, runPropose } from '../propose/index.ts';
import type { ProposeDeps } from '../propose/index.ts';

/** The log of the process: one line each on stdout, with the name of the service. */
export const defaultLog = (line: string): void => { console.log(`[reorder-agent] ${line}`); };

/** A request that the intake refuses: the text is too large, or it is not a request of the agent. The status is the status of the code in `ERROR_STATUS`. The message names the member and never repeats a value. */
export class RequestError extends Error {
  readonly code: 'bad_shape' | 'request_too_large';
  readonly status: number;

  constructor(code: 'bad_shape' | 'request_too_large', message: string) {
    super(message);
    this.name = 'RequestError';
    this.code = code;
    this.status = ERROR_STATUS[code];
  }
}

/** The request of a job: `propose` with its two fields, or `execute`. */
export type JobRequest = UseCaseRequest<ProposeFields>;
/** The result of a job as the service answers it: the result of the job, with the member `fault_mode` of the one switch. */
export type JobAnswer = WithFaultMode<ProposalResult | ExecuteResult, 'reorder-agent'>;

/** The request JSON of a job as a request of the agent. It throws `RequestError` for a text that is too large, that is not JSON, or that breaks a rule of the intake. */
export function parseJob(requestJson: string): JobRequest {
  const size = checkRequestSize(requestJson);
  if (!size.ok) throw new RequestError(size.code === 'request_too_large' ? 'request_too_large' : 'bad_shape', size.detail);
  const json = parseJsonText(requestJson, 'request');
  if (!json.ok) throw new RequestError('bad_shape', json.detail);
  const request = parseRequest(json.value, parseProposeFields);
  if (!request.ok) throw new RequestError('bad_shape', request.detail);
  return request.value;
}

/** A request refused by the intake, or by one of the two jobs before it did anything, as the shared server answers it; null for any other error, which is a 500. */
export function refusalOf(error: unknown): Refusal | null {
  if (error instanceof RequestError || error instanceof ProposeRefusal) return { code: error.code, status: error.status, message: error.message, kind: 'request' };
  // A refusal of 500 or more is a fault of the service: the buyer gets fixed text, and the whole message is in the log.
  if (error instanceof ExecuteRefusal) return { code: error.code, status: error.status, message: error.message, kind: error.status >= 500 ? 'job' : 'request' };
  return null;
}

export interface ServerOptions {
  /** The bytes that GET /agent.json answers: the rendered manifest, made once. */
  readonly manifestText: string;
  /** The token the runtime sends as the authorization header of every call (SERVICE_AUTH_HEADER), which POST / and POST /precheck require. A server is never made without one. */
  readonly authHeader: string;
  /** The fault switch of the process, made once at the start. Every result is stamped with it. */
  readonly fault: FaultSwitch<'reorder-agent'>;
  /** The co-sign route, made by the start. The server mounts its handler as the open route POST /cosign/delegate. */
  readonly cosign: CosignRoute;
  /** The deps of a job that arrived at `arrivedAt`: each job gets its own, so the decision of a job holds the deadline of that job. */
  readonly proposeDeps: (arrivedAt: number) => ProposeDeps;
  readonly executeDeps: (arrivedAt: number) => ExecuteDeps;
  readonly clock: () => number;
  /** Where a line of the log goes; the default prints it with the name of the service. */
  readonly log?: (line: string) => void;
  /** How often a job that is running is sent an interim line: HEARTBEAT_MS by default, and no more than that. */
  readonly heartbeatMs?: number;
  /** The slot jobs run in; a service that wants to stop drains it. A new one by default. */
  readonly slot?: JobSlot;
}

/** A code that may stand in a log line: lower-case letters, digits and `_`, 64 characters at most. */
const CODE = /^[a-z0-9_]{1,64}$/;

/** The line of a job that answered: its operation, its time, and the codes of its result, never a word of the request or of what the job read. */
function jobLine(op: string, ms: number, result: ProposalResult | ExecuteResult): string {
  const reason = result.reason !== null && CODE.test(result.reason) ? result.reason : result.reason === null ? 'none' : 'not a code';
  return `${op} done in ${ms} ms: outcome ${result.outcome}, reason ${reason}, exit ${result.exit_state ?? 'none'}, decisions ${result.decisions.length}`;
}

export function createServer(options: ServerOptions): Server {
  const log = options.log ?? defaultLog;
  const dispatch = async (request: JobRequest, arrivedAt: number, signal?: AbortSignal): Promise<ProposalResult | ExecuteResult> => {
    const result = request.op === 'propose'
      ? await runPropose(options.proposeDeps(arrivedAt), request, arrivedAt, signal)
      : await runExecute(options.executeDeps(arrivedAt), request, arrivedAt, signal);
    log(jobLine(request.op, options.clock() - arrivedAt, result));
    return result;
  };
  const openRoutes: readonly OpenRoute[] = [{ path: options.cosign.path, methods: ['POST'], handle: options.cosign.handle }];
  return createJobServer<JobRequest, JobAnswer>({
    manifestText: options.manifestText, authHeader: options.authHeader, parse: parseJob, abortOnClose: true,
    run: withFaultModeJob(options.fault, dispatch),
    // The line of a job is written by dispatch, with the codes of its result; the default line would be a second one.
    done: () => undefined,
    refusalOf, clock: options.clock, log, openRoutes,
    ...(options.heartbeatMs === undefined ? {} : { heartbeatMs: options.heartbeatMs }), ...(options.slot === undefined ? {} : { slot: options.slot }),
  });
}
