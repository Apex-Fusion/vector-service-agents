// agents/insurer-intake-agent/src/serve/server.ts
// The HTTP surface of the Insurer Intake Agent, on the job server of the service kit. The runtime holds the supplier key, asks the hook before it claims an escrow, and posts the job after the Claim.
//
//   POST /precheck   the hook: the 15 checks of the Insurer Intake Agent. A go keeps the record of the checks for the job and reserves the job slot for the escrow. A refusal is the status and the code of the check,
//                    and the escrow stays open. The option is never absent: a service with no hook would claim every escrow.
//   POST /           the job: the intake record of the request. It takes the record of the hook by the escrow of its context, and only for the body that the hook checked. A job with no record, or with the
//                    record of another body, fails closed and writes nothing.
//   GET /agent.json, GET /healthz   the manifest that the service rendered at its start, and the health of the service. The service has no other route and no open route.
//
// The request is the handoff of use case 2 (prior authorization): a handoff for another use case, and a document that is not an authorization request, are `bad_shape` (400). The hook has no check for another use
// case, and the kit reads a handoff of use case 1 too, so the refusal is made here, before the hook and before the job. A job needs the context of the runtime: a call with none is `bad_context` (400). Every result
// of the job names the fault setting (`withFaultModeJob`), which is the empty text: this agent has no fault value. A caller that hangs up stops the job before the decision and before the filing
// (`abortOnClose`): the job reads the signal before each of the two and never passes it into either, because a hire that was paid and an entry that the portal took cannot be taken back. The line of a job names
// counts and codes and nothing else: never a request, a requirement, an intake record, a key or a token.
import type { Server } from 'node:http';
import { createJobServer } from '@vsa/service-kit';
import type { JobContext, JobSlot, PrecheckAnswer, Refusal } from '@vsa/service-kit';
import { readFaultSwitch, withFaultModeJob } from '@vsa/usecase-kit/fault';
import type { WithFaultMode } from '@vsa/usecase-kit/fault';
import { parsePriorAuthRequest } from '@vsa/usecase-kit/priorauth';
import type { IntakeRecord } from '@vsa/usecase-kit/priorauth';
import { parseHandoff, parseJsonText } from '@vsa/usecase-kit/protocol';
import type { Handoff } from '@vsa/usecase-kit/protocol';
import { IntakeRefusal, runIntake } from '../job/index.ts';
import type { IntakeDeps } from '../job/index.ts';

/** The log of the process: one line each on stdout, with the name of the service. */
export const defaultLog = (line: string): void => { console.log(`[insurer-intake-agent] ${line}`); };

/** A request that the service refuses before the job: a body that is no handoff of use case 2, or a call with no context. The message names a member and never repeats a value. */
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
 * The handoff of the request text, for use case 2: the form of the protocol, the use case `prior-authorization`, and a document that is an authorization request. Anything else is `bad_shape`. The check of the
 * hook and the job read the document again from the handoff, so this gives the handoff and not the request.
 */
export function parseIntakeRequest(text: string): Handoff {
  const json = parseJsonText(text, 'request');
  if (!json.ok) throw new RequestRefusal('bad_shape', json.detail);
  const handoff = parseHandoff(json.value);
  if (!handoff.ok) throw new RequestRefusal('bad_shape', handoff.detail);
  if (handoff.value.use_case !== 'prior-authorization') {
    throw new RequestRefusal('bad_shape', 'handoff.use_case must be prior-authorization: the Insurer Intake Agent takes the handoff of use case 2 (prior authorization) only');
  }
  const request = parsePriorAuthRequest(handoff.value.document, 'handoff.document');
  if (!request.ok) throw new RequestRefusal('bad_shape', request.detail);
  return handoff.value;
}

/** A refusal of the request (RequestRefusal) or of the job (IntakeRefusal), as the job server answers it; null for anything else, which is a 500 `internal`. */
function refusalOf(error: unknown): Refusal | null {
  if (error instanceof RequestRefusal || error instanceof IntakeRefusal) return { code: error.code, status: error.status, message: error.message, kind: error.kind };
  return null;
}

export interface ServerOptions {
  /** The bytes that GET /agent.json answers: the manifest that the service rendered once, with the hash that the advert holds. */
  readonly manifestText: string;
  /** The token that POST / and POST /precheck require (SERVICE_AUTH_HEADER). A server is never made without one. */
  readonly authHeader: string;
  /** The hook. Required: a service with no hook would claim every escrow. */
  readonly precheck: (request: Handoff, context: JobContext) => Promise<PrecheckAnswer>;
  /** The ports of the job that arrived at the time given, with the context of its escrow. The server asks for them when the job starts, so the deadline of the job is the one of its arrival. */
  readonly jobDeps: (arrivedAt: number, context: JobContext) => IntakeDeps;
  readonly clock: () => number;
  readonly log: (line: string) => void;
  /** How often a job that is running is sent an interim line: the default of the job server, and no more than that. */
  readonly heartbeatMs?: number;
  /** The slot jobs run in; a service that wants to stop drains it. A new one by default. */
  readonly slot?: JobSlot;
}

/** The result of a job as the server writes it: the intake record with the member `fault_mode` of the switch as its last member. */
export type IntakeResult = WithFaultMode<IntakeRecord, 'insurer-intake-agent'>;

/** The switch of the service. This agent has no fault value, so the one setting is the empty text, and every result names it. */
const NO_FAULT = readFaultSwitch('insurer-intake-agent', '');

export function createServer(options: ServerOptions): Server {
  if (typeof options.precheck !== 'function') throw new TypeError('the hook of the Insurer Intake Agent is required: a service with no hook would claim every escrow');
  const job = (request: Handoff, arrivedAt: number, signal: AbortSignal | undefined, context: JobContext | undefined): Promise<IntakeRecord> => {
    if (context === undefined) throw new RequestRefusal('bad_context', 'The job needs the six headers of the context that the runtime sends: the Insurer Intake Agent takes no job without them.');
    return runIntake(options.jobDeps(arrivedAt, context), request, context, arrivedAt, signal);
  };
  return createJobServer<Handoff, IntakeResult>({
    manifestText: options.manifestText,
    authHeader: options.authHeader,
    parse: parseIntakeRequest,
    precheck: options.precheck,
    run: withFaultModeJob(NO_FAULT, job),
    // The answer is the JSON text of the record. The receipt of the runtime commits to the SHA-256 of these bytes.
    serialize: (result) => JSON.stringify(result),
    refusalOf,
    clock: options.clock,
    log: options.log,
    abortOnClose: true,
    ...(options.heartbeatMs === undefined ? {} : { heartbeatMs: options.heartbeatMs }),
    ...(options.slot === undefined ? {} : { slot: options.slot }),
  });
}
