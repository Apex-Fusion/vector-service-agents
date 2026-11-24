// agents/insurer-intake-agent/test/job/rig.ts
// The rig of the tests of the job. It joins the stub gateway of id-kit (the JWT-SVID of the Insurer Intake Agent), a fake `fetch` for the insurer portal (it answers the two routes of the mock service: the
// requirement set of a service code, and the filing of a request, with one entry for each request number), a fake clock, the stub ports (the record of the checks that the hook kept, the report of the
// attestations, the decision, the intake book) and the golden handoff. No test of the job uses the network. A test builds a rig, changes one thing, and expects one result. The same rig with no change is
// the accepted twin.
import { expect } from 'vitest';
import { createGatewayClient } from '@vsa/id-kit/client';
import { createStubGateway } from '@vsa/id-kit/testing';
import type { StubAgent, StubGateway } from '@vsa/id-kit/testing';
import type { JobContext } from '@vsa/service-kit';
import type { Clock } from '@vsa/usecase-kit/access';
import type { DecideResult } from '@vsa/usecase-kit/decision';
import { PRIORAUTH_MODELS } from '@vsa/usecase-kit/priorauth';
import { accepted, isPlainObject } from '@vsa/usecase-kit/protocol';
import type { Handoff, JsonValue } from '@vsa/usecase-kit/protocol';
import type { AttestationReport, CompletenessChoice, IntakeDeps, ReportInput, TakenChecks } from '../../src/job/ports.ts';
import { IntakeRefusal } from '../../src/job/refusal.ts';
import { ADVERT_REF, ATTESTATIONS, BASES, BUYER_PKH, ESCROW_REF, REQUIREMENTS, decisionOf, handoffOf, priorRequest, recordFor } from './samples.ts';

/** One call that reached the portal, as `fetch` gave it: the header names are in lower case. */
export interface PortalCall {
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string | null;
}

/** What the portal answers: a status with a body, a failure of the network, or no answer at all until the caller gives up. */
export type Reply = { readonly status: number; readonly body: string } | { readonly throws: Error } | { readonly hangs: true };
export const json = (status: number, value: unknown): Reply => ({ status, body: JSON.stringify(value) });

const REQUIREMENTS_PATH = /^\/t\/([a-z0-9-]+)\/insurer\/requirements\/([A-Za-z0-9._-]+)$/;
const REQUESTS_PATH = /^\/t\/([a-z0-9-]+)\/insurer\/requests$/;
const FILING_MEMBERS = ['missing', 'request', 'status'].join();

/** The audience of a JWT-SVID as its payload names it, when it names exactly one. Null for any other text. This reads the claims and does not check the signature. */
function audienceOf(jwt: string): string | null {
  const parts = jwt.split('.');
  if (parts.length !== 3) return null;
  try {
    const claims: unknown = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8'));
    if (!isPlainObject(claims)) return null;
    const { aud } = claims;
    if (typeof aud === 'string') return aud;
    return Array.isArray(aud) && aud.length === 1 && typeof aud[0] === 'string' ? aud[0] : null;
  } catch {
    return null;
  }
}

/**
 * The insurer portal behind `fetch`. It answers the two routes of the Insurer Intake Agent as the mock service does, and it takes a call only with a JWT-SVID whose audience is the insurer system of the tenant
 * of the URL (401 `svid_missing` or `svid_invalid` otherwise). `GET .../insurer/requirements/<service code>` gives the requirement set, or 404 `requirements_not_found`. `POST .../insurer/requests` files a
 * request once for each request number without regard to case (201 with the id of the entry, 409 `duplicate_request` for a number that it holds, 400 for a body with other members). `requirements` and `filing`
 * replace the answer of one route. A call that is not one of the two routes throws.
 */
export class Portal {
  readonly calls: PortalCall[] = [];
  /** The requests that the portal holds, by request number in lower case. */
  readonly filed = new Map<string, Record<string, unknown>>();
  requirements: Reply | null = null;
  filing: Reply | null = null;
  readonly #events: string[];

  constructor(events: string[]) {
    this.#events = events;
  }

  /** Puts an entry for the number in the portal, as an earlier job did. */
  prefile(requestNumber: string): void {
    this.filed.set(requestNumber.toLowerCase(), { intake_id: 'IN-run1-0000', request_number: requestNumber });
  }

  readonly fetch: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const call: PortalCall = {
      method: init?.method ?? 'GET', url, headers: Object.fromEntries(new Headers(init?.headers).entries()), body: typeof init?.body === 'string' ? init.body : null,
    };
    this.calls.push(call);
    const path = new URL(url).pathname;
    const read = call.method === 'GET' ? REQUIREMENTS_PATH.exec(path) : null;
    if (read !== null) {
      this.#events.push('requirements');
      return this.#reply(this.requirements, init?.signal, () => this.#read(read[1]!, read[2]!, call));
    }
    const file = call.method === 'POST' ? REQUESTS_PATH.exec(path) : null;
    if (file !== null) {
      this.#events.push('filing');
      return this.#reply(this.filing, init?.signal, () => this.#file(file[1]!, call));
    }
    throw new Error(`the portal has no route ${call.method} ${path}`);
  };

  async #reply(scripted: Reply | null, signal: AbortSignal | null | undefined, real: () => Reply): Promise<Response> {
    const reply = scripted ?? real();
    if ('throws' in reply) throw reply.throws;
    if ('hangs' in reply) {
      // The package compiles for es2022, whose library has no Promise.withResolvers, so the executor form is the one that types here.
      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new Error('the call was aborted')), { once: true });
      });
    }
    return new Response(reply.body, { status: reply.status, headers: { 'content-type': 'application/json' } });
  }

  /** The refusal for a call with no JWT-SVID, or with one for another audience than the insurer system of the tenant, and null when the portal takes the call. */
  #audit(tenant: string, call: PortalCall): Reply | null {
    const bearer = /^Bearer (\S+)$/.exec(call.headers.authorization ?? '')?.[1];
    if (bearer === undefined) return json(401, { error: 'svid_missing', message: 'the call has no JWT-SVID' });
    if (audienceOf(bearer) !== `${BASES.publicBase}/t/${tenant}/insurer`) return json(401, { error: 'svid_invalid', message: 'the JWT-SVID is not for the insurer system of this tenant' });
    return null;
  }

  #read(tenant: string, code: string, call: PortalCall): Reply {
    const refused = this.#audit(tenant, call);
    if (refused !== null) return refused;
    const set = Object.hasOwn(REQUIREMENTS, code) ? REQUIREMENTS[code] : undefined;
    return set === undefined ? json(404, { error: 'requirements_not_found', message: 'the insurer portal has no requirements for this service code' }) : json(200, set);
  }

  #file(tenant: string, call: PortalCall): Reply {
    const refused = this.#audit(tenant, call);
    if (refused !== null) return refused;
    const filing: unknown = JSON.parse(call.body ?? 'null');
    if (!isPlainObject(filing) || Object.keys(filing).sort().join() !== FILING_MEMBERS) return json(400, { error: 'bad_request', message: 'the filing has other members' });
    const { request } = filing;
    if (!isPlainObject(request) || request.tenant !== tenant) return json(400, { error: 'bad_request', message: 'the request is not for the tenant of the URL' });
    const key = String(request.request_number).toLowerCase();
    if (this.filed.has(key)) return json(409, { error: 'duplicate_request', message: 'the insurer portal already has an entry for this request number' });
    const intakeId = `IN-${tenant}-${String(this.filed.size + 1).padStart(4, '0')}`;
    this.filed.set(key, { ...filing, intake_id: intakeId });
    return json(201, { intake_id: intakeId, request_number: request.request_number, status: filing.status, missing: filing.missing, received_at: '2026-11-23T12:00:00.000Z' });
  }
}

/** A clock for the calls. A wait ends when its signal aborts, and a wait never ends by itself unless `expire` says so: a test of the job has no time limit to prove. Each wait is noted in `sleeps`. */
function clockOf(gateway: StubGateway, sleeps: number[], expire: () => boolean): Clock {
  return {
    now: () => gateway.now(),
    sleep: (ms, signal) => {
      sleeps.push(ms);
      return new Promise<void>((resolve) => {
        if (expire() || signal?.aborted === true) {
          resolve();
          return;
        }
        signal?.addEventListener('abort', () => resolve(), { once: true });
      });
    },
  };
}

export interface RigOptions {
  /** Members of the authorization request that replace those of the sample. */
  readonly document?: Readonly<Record<string, JsonValue>>;
  /** `takeChecks` removes the entry, as the store of the hook does. */
  readonly oneShot?: boolean;
  /** The time from now to the `deliver_by` of the escrow, in milliseconds. The default is 300,000. */
  readonly deliverInMs?: number;
  /** The longest time of one call to the portal. The default is 20,000, the value that the service sets. */
  readonly timeoutMs?: number;
  /** A wait of the clock ends at once, so that a call that has no answer times out. */
  readonly expireWaits?: boolean;
}

export interface Rig {
  readonly gateway: StubGateway;
  readonly agent: StubAgent;
  readonly portal: Portal;
  /** The order in which the job reached each port: `take`, `svid`, `requirements`, `report`, `decide`, `filing` and `book`. */
  readonly events: string[];
  readonly logs: string[];
  /** The waits that the clock was asked for, in milliseconds: one for each call with a time bound. */
  readonly sleeps: number[];
  /** The JWT-SVIDs that the gateway issued, as compact JWTs. */
  readonly issued: string[];
  /** The records that the hook kept, by escrow reference. `takeChecks` gives the record of the escrow that it is asked for. A test sets, replaces or removes a record. */
  readonly kept: Map<string, TakenChecks>;
  /** The escrow reference of each call of `takeChecks`. */
  readonly takes: string[];
  readonly reportInputs: ReportInput[];
  /** The input and the requirement ids of each call of `decide`. */
  readonly decideCalls: Array<{ readonly input: JsonValue; readonly requirementIds: readonly string[] }>;
  /** The entries that the intake book recorded: tenant, request number and intake id. */
  readonly booked: Array<readonly [string, string, string]>;
  readonly request: Handoff;
  readonly context: JobContext;
  readonly deps: IntakeDeps;
  /** What `report` answers. A test changes it. */
  attestations: AttestationReport;
  /** What `decide` answers. A test changes it. */
  decision: DecideResult<CompletenessChoice>;
  /** An error that the intake book throws, or null. */
  bookError: Error | null;
  /** True when the log throws. */
  logThrows: boolean;
  /** True when the waits of the clock end at once. */
  expireWaits: boolean;
}

/** A rig in which every port gives what the job needs: the record is kept, the gateway issues the SVID, the portal serves the requirements and files the request, and the model finds the request complete. */
export function makeRig(options: RigOptions = {}): Rig {
  const events: string[] = [];
  const logs: string[] = [];
  const sleeps: number[] = [];
  const issued: string[] = [];
  const takes: string[] = [];
  const reportInputs: ReportInput[] = [];
  const decideCalls: Array<{ input: JsonValue; requirementIds: readonly string[] }> = [];
  const booked: Array<readonly [string, string, string]> = [];
  const gateway = createStubGateway();
  const agent = gateway.createAgent({ label: 'insurer-intake-agent' });
  const viaGateway: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const svid = new URL(url).pathname === '/spiffe/jwt-svid';
    const response = await gateway.fetch(input, init);
    if (svid && response.status === 200) {
      const answer: unknown = await response.clone().json();
      if (isPlainObject(answer) && typeof answer.svid === 'string') issued.push(answer.svid);
    }
    return response;
  };
  const client = createGatewayClient({ baseUrl: gateway.baseUrl, fetch: viaGateway, now: gateway.now });
  const portal = new Portal(events);
  const request = handoffOf(priorRequest(options.document ?? {}));
  const kept = new Map<string, TakenChecks>([[ESCROW_REF, recordFor(request)]]);
  const context: JobContext = {
    escrowRef: ESCROW_REF, advertRef: ADVERT_REF, advertModel: PRIORAUTH_MODELS.intake, buyerPkh: BUYER_PKH, paymentLovelace: 2_000_000n, deliverByMs: gateway.now() + (options.deliverInMs ?? 300_000),
  };
  const rig: Rig = {
    gateway, agent, portal, events, logs, sleeps, issued, kept, takes, reportInputs, decideCalls, booked, request, context,
    attestations: ATTESTATIONS,
    decision: accepted(decisionOf()),
    bookError: null,
    logThrows: false,
    expireWaits: options.expireWaits === true,
    deps: {
      agent: { did: agent.did, authenticationKey: agent.authentication.privateKey },
      // The event is noted when the job calls the client, and not when the request reaches the gateway: a call that nobody awaits is in the order of the events at once.
      svid: { client: { ...client, jwtSvid: (request) => { events.push('svid'); return client.jwtSvid(request); } } },
      calls: { fetch: portal.fetch, clock: clockOf(gateway, sleeps, () => rig.expireWaits), bases: BASES, timeoutMs: options.timeoutMs ?? 20_000 },
      takeChecks: (escrowRef) => {
        events.push('take');
        takes.push(escrowRef);
        const given = kept.get(escrowRef) ?? null;
        if (options.oneShot === true) kept.delete(escrowRef);
        return given;
      },
      book: {
        record: async (tenant, requestNumber, intakeId) => {
          events.push('book');
          if (rig.bookError !== null) throw rig.bookError;
          booked.push([tenant, requestNumber, intakeId]);
        },
      },
      report: async (input) => {
        events.push('report');
        reportInputs.push(input);
        return rig.attestations;
      },
      decide: async (input, requirementIds) => {
        events.push('decide');
        decideCalls.push({ input, requirementIds });
        return rig.decision;
      },
      clock: () => gateway.now(),
      log: (line) => {
        if (rig.logThrows) throw new Error('the log is closed');
        logs.push(line);
      },
    },
  };
  return rig;
}

/** The refusal that a step ends with. A step that gives a result, and a step that throws anything else, fail the test. The step may be a function that throws, or one that rejects. */
export async function refusalOf(step: () => unknown): Promise<IntakeRefusal> {
  let result: unknown;
  try {
    result = await step();
  } catch (error) {
    if (error instanceof IntakeRefusal) return error;
    throw error;
  }
  throw new Error(`the step gave a result and did not refuse: ${JSON.stringify(result).slice(0, 80)}`);
}

/** The lines of the body of a PEM key: the part that a log must never repeat. */
const keyLines = (pem: string): string[] => pem.split('\n').filter((line) => line.length >= 16 && !line.startsWith('-----'));

/** The subject tokens that the client sent to the gateway for a JWT-SVID: the body of each request names one. */
function subjectTokens(gateway: StubGateway): string[] {
  const tokens: string[] = [];
  for (const call of gateway.requests) {
    if (call.path !== '/spiffe/jwt-svid') continue;
    const body: unknown = JSON.parse(call.body);
    if (isPlainObject(body) && typeof body.subject_token === 'string') tokens.push(body.subject_token);
  }
  return tokens;
}

/** No text holds the service key, a subject token that the client sent to the gateway, or a JWT-SVID that the gateway issued: not the whole token and not a part of 12 characters or more between its dots. */
export function expectNoSecrets(rig: Rig, texts: readonly string[]): void {
  const key = rig.agent.authentication.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
  const tokens = [...rig.issued, ...subjectTokens(rig.gateway)];
  for (const text of texts) {
    expect(text).not.toContain('PRIVATE KEY');
    expect(text).not.toContain('Bearer ');
    for (const line of keyLines(key)) expect(text).not.toContain(line);
    for (const token of tokens) for (const part of [token, ...token.split('.').filter((piece) => piece.length >= 12)]) expect(text).not.toContain(part);
  }
}
