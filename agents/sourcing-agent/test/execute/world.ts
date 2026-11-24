// agents/sourcing-agent/test/execute/world.ts
// The world of the tests of the job `execute`. The identity gateway is the stub of id-kit: the agent has two delegation keys on it, so that a test can see which key signed the proof of the token. The
// ledger is a fake that holds the delegation. The sourcing record is a fake fetch: by default it answers as the route of the mock service does for the form of the body and for the approval (a body
// without all three members is 400, a null approval is 403 `approval_not_found`, any other approval is 201), and a test sets what else it answers. The clock is the time of the stub gateway, which a
// test moves by hand. Nothing uses the network.
import type { KeyObject } from 'node:crypto';
import { createGatewayClient } from '@vsa/id-kit/client';
import type { GatewayClient, GatewayResult, IssuedToken, TokenRequest } from '@vsa/id-kit/client';
import { createStubGateway, ed25519Key } from '@vsa/id-kit/testing';
import type { StubAgent, StubDelegation, StubGateway, TestKey } from '@vsa/id-kit/testing';
import { tokenTarget } from '@vsa/usecase-kit/access';
import type { Clock, MockBases, TokenTarget } from '@vsa/usecase-kit/access';
import type { DelegationReading, LedgerReads, LiveVaults } from '@vsa/usecase-kit/buyer';
import type { DelegationId, ExecuteRequest, ExecuteResult } from '@vsa/usecase-kit/protocol';
import { runExecute } from '../../src/execute/index.ts';
import type { DelegationKeyDeps, ExecuteDeps } from '../../src/execute/index.ts';
import { APPROVAL, TENANT, executeRequest, rankingDocument } from './fixtures.ts';

export const BASES: MockBases = { publicBase: 'https://mock.example', mtlsBase: 'https://mock-mtls.example' };
export const DELEGATION: DelegationId = 'dd'.repeat(32);

export const jsonResponse = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
export const pageResponse = (status: number, body: string): Response => new Response(body, { status, headers: { 'content-type': 'text/html' } });

/** The reads of the ledger: the delegation of the request, set by the test, and the Live vaults, which this job never reads. A test may make the read of the delegation fail. */
export class FakeReads implements LedgerReads {
  readonly delegations = new Map<string, DelegationReading | null>();
  readonly calls = { delegation: 0, liveVaults: 0 };
  failDelegation: Error | null = null;

  async delegation(id: DelegationId): Promise<DelegationReading | null> {
    this.calls.delegation += 1;
    if (this.failDelegation !== null) throw this.failDelegation;
    return this.delegations.get(id) ?? null;
  }

  async liveVaults(_id: DelegationId, _atMs: number): Promise<LiveVaults> {
    this.calls.liveVaults += 1;
    return { refs: [], complete: true };
  }
}

/** A call that the sourcing record got. The header names are in lower case. */
export interface RecordCall {
  readonly method: string;
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: string;
}

/** The ranking record that the fake writes for a body of the right form. The identifier is the one that the mock service gives to its first ranking of a tenant. */
const RECORDED = {
  ranking_id: 'RK-run1-0001', rfq_id: 'run1-rfq-1', top: { rank: 1, desk_did: `did:vector:${'a1'.repeat(32)}`, organisation: 'alfa.example.org' }, recorded_at: '2026-11-24T10:00:00.000Z',
};

const membersOf = (value: unknown): string => (typeof value === 'object' && value !== null && !Array.isArray(value) ? Object.keys(value).sort().join(',') : '');

/** The answer of the route of the mock service for the form of the body and for the approval, and for nothing else: the checks of the approval itself are the job of the record, and the tests script them. */
export function recordRoute(call: RecordCall): Response {
  let body: unknown;
  try {
    body = JSON.parse(call.body);
  } catch {
    return jsonResponse(400, { error: 'bad_request', message: 'the body is not JSON' });
  }
  if (membersOf(body) !== 'approval,ranking,salt') return jsonResponse(400, { error: 'bad_request', message: 'the body must have ranking, salt and approval, and no other member' });
  const approval = (body as Record<string, unknown>).approval;
  if (approval === null) return jsonResponse(403, { error: 'approval_not_found', message: 'the ranking came with no approval' });
  if (membersOf(approval) !== 'attestation,issuer_did') return jsonResponse(400, { error: 'bad_request', message: 'the approval must be null, or hold an attestation and an issuer_did' });
  return jsonResponse(201, RECORDED);
}

/** The sourcing record as a fake fetch. It records each call, and it records the body of each call that it answered with 201 as a ranking that it wrote. */
export class SourcingRecord {
  readonly calls: RecordCall[] = [];
  /** The bodies of the rankings that the record wrote: each call that it answered with 201. */
  readonly written: string[] = [];
  /** Called when a call arrives, before the answer. */
  onCall: (() => void) | null = null;
  answer: (call: RecordCall) => Response | Promise<Response> = recordRoute;

  readonly fetch: typeof fetch = async (input, init) => {
    const call: RecordCall = {
      method: init?.method ?? 'GET', url: String(input), headers: Object.fromEntries(new Headers(init?.headers).entries()), body: typeof init?.body === 'string' ? init.body : '',
    };
    this.calls.push(call);
    this.onCall?.();
    const response = await this.answer(call);
    if (response.status === 201) this.written.push(call.body);
    return response;
  };
}

interface Sleeper {
  readonly until: number;
  readonly wake: () => void;
}

/**
 * The clock of the tests: the time of the stub gateway, so that a token ends by the clock that issued it. A sleep ends when its time comes (`advance`), or when its signal aborts, as the timer of a real
 * clock ends when the work is over. `sleeps` holds the length of each sleep that was asked for: each bounded wait of the job asks for one.
 */
export class TestClock implements Clock {
  readonly sleeps: number[] = [];
  readonly #sleepers = new Set<Sleeper>();

  constructor(private readonly gateway: StubGateway) {}

  now(): number {
    return this.gateway.now();
  }

  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    this.sleeps.push(ms);
    // The package compiles for es2022, whose library has no Promise.withResolvers, so the executor form is the one that types here.
    return new Promise<void>((resolve) => {
      if (signal?.aborted === true) {
        resolve();
        return;
      }
      const sleeper: Sleeper = {
        until: this.now() + ms,
        wake: () => {
          this.#sleepers.delete(sleeper);
          signal?.removeEventListener('abort', sleeper.wake);
          resolve();
        },
      };
      this.#sleepers.add(sleeper);
      signal?.addEventListener('abort', sleeper.wake, { once: true });
    });
  }

  /** Moves the time on, and ends each sleep whose time has come. */
  advance(ms: number): void {
    this.gateway.advance(ms);
    for (const sleeper of [...this.#sleepers]) if (sleeper.until <= this.now()) sleeper.wake();
  }
}

/** One delegation key of the agent. */
export interface KeyWorld {
  readonly testKey: TestKey;
  readonly entry: DelegationKeyDeps;
}

export interface WorldOptions {
  /** The delegation key that the delegation names as its delegate key: the first key of the agent by default. */
  readonly delegate?: 'a' | 'b';
  /** The tenant of the delegation, of the ranking and of the request: the tenant of the tests by default. */
  readonly tenant?: string;
}

/** What a test can do to the token request of the job. */
export interface Hooks {
  /** Called when the job asks the gateway for a token, before the gateway answers. */
  onAsk: (() => void) | null;
  /** Called after the gateway answered, before the job gets the answer. */
  afterAnswer: (() => void) | null;
  /** The gateway never answers. */
  hang: boolean;
}

export interface World {
  readonly gateway: StubGateway;
  readonly agent: StubAgent;
  readonly delegation: StubDelegation;
  readonly target: TokenTarget;
  readonly a: KeyWorld;
  readonly b: KeyWorld;
  readonly reads: FakeReads;
  readonly record: SourcingRecord;
  readonly clock: TestClock;
  /** The token requests that the gateway answered, with its answer. */
  readonly tokens: Array<{ request: TokenRequest; answer: GatewayResult<IssuedToken> }>;
  /** How many token requests the job made, answered or not. */
  readonly asked: { count: number };
  readonly hooks: Hooks;
  readonly log: string[];
  /** The delegate key that the ledger shows: the key hash that `delegateKeyOf` gives, or `null` for a delegation that is not shown. A test may also make the read fail. */
  readonly delegateKey: { hash: string | null; failure: Error | null };
  readonly deps: ExecuteDeps;
  /** The time at which the job of the tests arrives. */
  readonly arrived: number;
  /** The ranking of the tests, with the members that `over` names replaced. */
  document(over?: Record<string, unknown>): Record<string, unknown>;
  /** The `execute` request for a document, with the approval of the tests unless another is given (`null` is a request with no approval), and the tenant of the tests unless another is given. */
  request(document?: Record<string, unknown>, approval?: unknown, tenant?: string): ExecuteRequest;
  run(request?: ExecuteRequest, arrivedAt?: number, deps?: ExecuteDeps, signal?: AbortSignal): Promise<ExecuteResult>;
}

export function world(options: WorldOptions = {}): World {
  const gateway = createStubGateway();
  const hirer = ed25519Key('hirer');
  const agent = gateway.createAgent({ label: 'sourcing agent' });
  const second = ed25519Key('sourcing agent: second delegation key');
  agent.keys.push({ key: second, purposes: 16 });
  const tenant = options.tenant ?? TENANT;
  const target = tokenTarget(BASES, tenant, 'sourcing.rankings');
  if (!target.ok) throw new Error('the target of the test is refused');
  const named = options.delegate === 'b' ? second : agent.delegation;
  const delegation = gateway.delegate({
    delegator: { principalKey: hirer }, delegate: agent, delegateKey: named, actions: ['sourcing.award.write'], resources: [target.value.resource], remaining: 1, id: DELEGATION,
  });
  const a: KeyWorld = { testKey: agent.delegation, entry: { dpopKey: agent.delegation.privateKey } };
  const b: KeyWorld = { testKey: second, entry: { dpopKey: second.privateKey } };

  const reads = new FakeReads();
  reads.delegations.set(DELEGATION, { delegate: agent.id, chain_whole: true });
  const real = createGatewayClient({ baseUrl: gateway.baseUrl, fetch: gateway.fetch, now: gateway.now });
  const tokens: World['tokens'] = [];
  const asked = { count: 0 };
  const hooks: Hooks = { onAsk: null, afterAnswer: null, hang: false };
  const client: Pick<GatewayClient, 'requestToken'> = {
    requestToken: async (request) => {
      asked.count += 1;
      hooks.onAsk?.();
      if (hooks.hang) return new Promise<never>(() => undefined);
      const answer = await real.requestToken(request);
      tokens.push({ request, answer });
      hooks.afterAnswer?.();
      return answer;
    },
  };
  const record = new SourcingRecord();
  const clock = new TestClock(gateway);
  const log: string[] = [];
  const delegateKey: World['delegateKey'] = { hash: named.keyHash, failure: null };
  const deps: ExecuteDeps = {
    reads,
    delegateKeyOf: async () => {
      if (delegateKey.failure !== null) throw delegateKey.failure;
      return delegateKey.hash;
    },
    delegationKeys: { find: (hash) => (hash === a.testKey.keyHash ? a.entry : hash === b.testKey.keyHash ? b.entry : null), first: a.entry },
    agent: { did: agent.did, authenticationKey: agent.authentication.privateKey },
    tokens: { client },
    calls: { fetch: record.fetch, clock, bases: BASES },
    clock: () => gateway.now(),
    log: (line) => { log.push(line); },
  };
  const arrived = gateway.now();
  const made: World = {
    gateway, agent, delegation, target: target.value, a, b, reads, record, clock, tokens, asked, hooks, log, delegateKey, deps, arrived,
    document: (over = {}) => rankingDocument({ tenant, ...over }),
    request: (given = rankingDocument({ tenant }), approval: unknown = APPROVAL, requested: string = tenant) => executeRequest(given, DELEGATION, approval, requested),
    run: (request = made.request(), arrivedAt = arrived, given = made.deps, signal) => runExecute(given, request, arrivedAt, signal),
  };
  return made;
}

/** One word for a result: its outcome, its reason and its exit state. */
export const words = (result: ExecuteResult): string => `${result.outcome} ${result.reason ?? 'none'} ${result.exit_state}`;

/** What a job left behind, as numbers that a test compares: the reads of the delegation, the reads of a vault, the token requests, and the calls to the sourcing record. */
export interface Footprint {
  readonly reads: number;
  readonly vaults: number;
  readonly tokens: number;
  readonly calls: number;
}

export function footprint(w: World): Footprint {
  return { reads: w.reads.calls.delegation, vaults: w.reads.calls.liveVaults, tokens: w.asked.count, calls: w.record.calls.length };
}

/** A job that stopped before it read anything. */
export const UNTOUCHED: Footprint = { reads: 0, vaults: 0, tokens: 0, calls: 0 };
/** A job that read the delegation and sent nothing. */
export const READ_ONLY: Footprint = { reads: 1, vaults: 0, tokens: 0, calls: 0 };
/** A job that asked for the one token and made the one call. */
export const ONE_CALL: Footprint = { reads: 1, vaults: 0, tokens: 1, calls: 1 };

/** The 32 bytes of the key, in hex: what no result and no log line may hold. */
export function rawKeyHexOf(key: KeyObject): string {
  const der = key.export({ format: 'der', type: 'pkcs8' });
  return der.subarray(der.length - 32).toString('hex');
}
