// agents/sourcing-agent/test/scoring/world.ts: the world of `runScoring`. It runs the REAL `withSubDelegation` of the kit over the ledger, the clock and the keys of the access tests of the kit, so the Delegate and the
// Undelegate are real transaction bytes, and the clock is moved by the test. The token comes from the stub gateway of id-kit, with the two-link chain of a scorer under the agent. The vendor master, the model, the
// list of left sub-delegations and the set of the sub-delegations in use are scripted here. A test changes a member of `script` before the run.
import { createGatewayClient } from '@vsa/id-kit/client';
import type { GatewayResult, IssuedToken, TokenRequest } from '@vsa/id-kit/client';
import { createStubGateway, ed25519Key } from '@vsa/id-kit/testing';
import type { StubAgent, StubDelegation, StubGateway } from '@vsa/id-kit/testing';
import { createSerialQueue, tokenTarget } from '@vsa/usecase-kit/access';
import type { SerialQueue, TokenDeps } from '@vsa/usecase-kit/access';
import { readFaultSwitch } from '@vsa/usecase-kit/fault';
import { runJanitorOnce } from '@vsa/usecase-kit/janitor';
import type { JanitorReport } from '@vsa/usecase-kit/janitor';
import type { DelegationId } from '@vsa/usecase-kit/protocol';
import { expect } from 'vitest';
import { runScoring } from '../../src/scoring/index.ts';
import type { LeftEntry, LeftSink, ScoreAnswer, ScoreRequest, Scorer, ScoringDeps, ScoringInput, ScoringResult } from '../../src/scoring/index.ts';
import { AGENT_KEY, BASES, DAY, FakeClock, NOW, PARENT_ID, SCRIPT, VENDORS_BODY, WALLET, claimsOf, inputOf, json, markSigner, parentDatum, scoreAnswerFor, slotOf, TENANT } from './support.ts';
import { FakeDelegations } from '../../../../packages/usecase-kit/test/access/support.ts';

/** One record: an id added to the set in use, an entry put in the list or removed from it, or an id deleted from the set. */
export interface Step {
  readonly op: 'add' | 'put' | 'remove' | 'delete';
  readonly id: string;
}

/** The list of left sub-delegations in memory. It notes each call, and a test can make a call fail. */
export class SinkSpy implements LeftSink {
  readonly entries = new Map<string, LeftEntry>();
  /** The entry of each `put`, in order, also for a put that failed. */
  readonly stored: LeftEntry[] = [];
  /** The numbers of the calls of `put` that fail, counted from 1. */
  readonly failPutAt = new Set<number>();
  failRemove = false;
  /** `list` throws this error: the list cannot be read, or a file of it is damaged. */
  listFailure: (() => Error) | null = null;
  /** `list` answers only after this time of the clock, in milliseconds. */
  listDelayMs = 0;
  /** The number of calls of `list`. */
  lists = 0;

  constructor(
    private readonly steps: Step[],
    private readonly clock: FakeClock,
  ) {}

  async put(entry: LeftEntry): Promise<void> {
    this.steps.push({ op: 'put', id: entry.left.id });
    this.stored.push(entry);
    if (this.failPutAt.has(this.stored.length)) throw new Error('the disk is full');
    this.entries.set(entry.left.id, entry);
  }

  async remove(id: DelegationId): Promise<void> {
    this.steps.push({ op: 'remove', id });
    if (this.failRemove) throw new Error('the disk is full');
    this.entries.delete(id);
  }

  async list(): Promise<readonly LeftEntry[]> {
    this.lists += 1;
    if (this.listDelayMs > 0) await this.clock.sleep(this.listDelayMs);
    if (this.listFailure !== null) throw this.listFailure();
    return [...this.entries.values()];
  }
}

/** The queue of the wallet of the agent key, with a count of its turns and of the most turns that ran at one time. */
export class SpyQueue implements SerialQueue {
  readonly #inner = createSerialQueue();
  /** The number of tasks that were given to the queue. */
  runs = 0;
  active = 0;
  maxActive = 0;

  run<T>(task: () => Promise<T>): Promise<T> {
    this.runs += 1;
    return this.#inner.run(async () => {
      this.active += 1;
      this.maxActive = Math.max(this.maxActive, this.active);
      try {
        return await task();
      } finally {
        this.active -= 1;
      }
    });
  }
}

/** A call to the vendor master: what the caller sent, the DID of the scorer that holds the token (the `client_id` of the token), and the time. */
export interface Fetched {
  readonly url: string;
  readonly method: string;
  readonly authorization: string | undefined;
  readonly dpop: string | undefined;
  readonly scorer: string | null;
  readonly at: number;
}

/** What the ledger saw: a build or a send of a Delegate, a read of the readiness, with the time of the clock. */
export interface ChainEvent {
  readonly op: 'build' | 'submit' | 'readiness';
  readonly at: number;
  /** The delegate key of a build, and the kind of a send. */
  readonly detail: string;
}

/** The behaviour of each port. A test changes a member before the run. */
export interface Script {
  /** An answer that stands in for the gateway, or `null` for the stub gateway. `attempt` counts the requests, from 1. */
  requestToken: (request: TokenRequest, attempt: number) => Promise<GatewayResult<IssuedToken>> | null;
  /** The answer of the vendor master. `attempt` counts the calls, from 1. */
  fetch: (call: Fetched, attempt: number) => Promise<Response>;
  /** The decision `score`. `call` counts the calls, from 1. */
  score: (request: ScoreRequest, call: number) => Promise<ScoreAnswer>;
  /** Runs at the start of each build of a Delegate, with its number from 1. It throws to make the chain refuse the build. */
  build: (number: number) => void;
}

export interface RunOptions {
  readonly deps?: Partial<ScoringDeps>;
  readonly input?: Partial<ScoringInput>;
  readonly signal?: AbortSignal;
}

export interface World {
  readonly clock: FakeClock;
  readonly chain: FakeDelegations;
  readonly queue: SpyQueue;
  readonly sink: SinkSpy;
  /** The ids that a run still uses. */
  readonly live: Set<string>;
  readonly steps: Step[];
  readonly events: ChainEvent[];
  readonly gateway: StubGateway;
  readonly agent: StubAgent;
  readonly root: StubDelegation;
  readonly scorers: readonly [Scorer, Scorer, Scorer];
  readonly tokenRequests: TokenRequest[];
  /** The time of each token request. */
  readonly tokenTimes: number[];
  readonly fetched: Fetched[];
  readonly scoreCalls: { readonly request: ScoreRequest; readonly at: number }[];
  /** The lines that the scoring wrote to its log. */
  readonly logs: string[];
  readonly script: Script;
  readonly deps: ScoringDeps;
  readonly input: ScoringInput;
  run(over?: RunOptions): Promise<ScoringResult>;
}

const hex = (text: string): string => Buffer.from(text, 'utf8').toString('hex');

/** The world for `runScoring`: a ledger with the delegation of the hirer to the agent, a gateway with the three scorers under the agent, a clock, and a script that makes the golden run. */
export function world(): World {
  const clock = new FakeClock(NOW);
  const gateway = createStubGateway({ now: () => clock.now() });
  const stubClient = createGatewayClient({ baseUrl: gateway.baseUrl, fetch: gateway.fetch, now: gateway.now });
  const agent = gateway.createAgent({ label: 'sourcing-agent' });
  const scorerAgents = [1, 2, 3].map((number) => gateway.createAgent({ label: `scorer-${number}`, parent: agent }));
  const target = tokenTarget(BASES, TENANT, 'vendors.list');
  if (!target.ok) throw new Error('the target of the vendor list was refused');
  const root = gateway.delegate({
    id: PARENT_ID, delegator: { principalKey: ed25519Key('hirer') }, delegate: agent, actions: ['vendor.read'], resources: [target.value.resource], remaining: 1, notBefore: NOW - DAY, notAfter: NOW + 5 * DAY,
  });
  const chain = new FakeDelegations(clock, parentDatum({ delegate: agent.id, actions: [hex('vendor.read')], resources: [hex(target.value.resource)] }), SCRIPT);
  const steps: Step[] = [];
  const events: ChainEvent[] = [];
  const sink = new SinkSpy(steps, clock);
  const live = new Set<string>();
  const queue = new SpyQueue();
  const tokenRequests: TokenRequest[] = [];
  const tokenTimes: number[] = [];
  const fetched: Fetched[] = [];
  const scoreCalls: World['scoreCalls'] = [];
  const logs: string[] = [];
  const stubDelegations = new Map<string, StubDelegation>();
  let builds = 0;

  const script: Script = {
    requestToken: () => null,
    fetch: async () => json(VENDORS_BODY),
    score: async (request) => scoreAnswerFor(request.file.did),
    build: () => undefined,
  };

  // The ledger records what it sees. The reads of the janitor and of the stub gateway are not recorded in its log.
  const buildDelegate = chain.buildDelegate.bind(chain);
  chain.buildDelegate = async (params) => {
    builds += 1;
    events.push({ op: 'build', at: clock.now(), detail: params.delegateKey });
    script.build(builds);
    return buildDelegate(params);
  };
  const submit = chain.submit.bind(chain);
  chain.submit = async (cbor) => {
    try {
      return await submit(cbor);
    } finally {
      events.push({ op: 'submit', at: clock.now(), detail: chain.submitted.at(-1)?.kind ?? 'none' });
    }
  };
  const readiness = chain.readiness.bind(chain);
  chain.readiness = async (id) => {
    events.push({ op: 'readiness', at: clock.now(), detail: id });
    return readiness(id);
  };

  /** Makes the sub-delegation known to the stub gateway as the ledger shows it: live when the ledger shows it, ended when it does not any more. */
  async function syncGateway(request: TokenRequest): Promise<void> {
    const id = request.delegation?.identifier;
    if (id === undefined) return;
    const logged = chain.log.length;
    const shown = await chain.readDelegation(id);
    chain.log.length = logged;
    const known = stubDelegations.get(id);
    if (shown !== null && known === undefined) {
      const scorer = scorerAgents.find((candidate) => candidate.did === request.subject.did);
      if (scorer === undefined) return;
      stubDelegations.set(
        id,
        gateway.delegate({
          id, delegator: agent, delegate: scorer, parent: root, actions: request.delegation?.actions ?? [], resources: request.delegation?.locations ?? [], remaining: 0,
          notBefore: shown.delegation.notBefore, notAfter: shown.delegation.notAfter,
        }),
      );
    } else if (shown === null && known !== undefined) {
      gateway.endDelegation(known);
    }
  }

  const tokens: TokenDeps = {
    client: {
      requestToken: async (request) => {
        tokenRequests.push(request);
        tokenTimes.push(clock.now());
        const scripted = script.requestToken(request, tokenRequests.length);
        if (scripted !== null) return scripted;
        await syncGateway(request);
        return stubClient.requestToken(request);
      },
    },
  };

  const scorers = scorerAgents.map(
    (scorerAgent): Scorer => ({ did: scorerAgent.did, authenticationKey: scorerAgent.authentication.privateKey, delegationKey: scorerAgent.delegation.privateKey, signer: markSigner(scorerAgent.delegation.keyHash) }),
  ) as [Scorer, Scorer, Scorer];

  const deps: ScoringDeps = {
    scorers,
    agentKey: { signer: markSigner(AGENT_KEY), walletAddress: WALLET, queue },
    subDelegation: { chain, clock, delegationScript: SCRIPT, bases: BASES },
    tokens,
    calls: {
      fetch: async (input, init) => {
        const headers = new Headers(init?.headers);
        const authorization = headers.get('authorization') ?? undefined;
        let scorer: string | null = null;
        try {
          const claims = claimsOf(authorization?.split(' ')[1] ?? '');
          scorer = typeof claims.client_id === 'string' ? claims.client_id : null;
        } catch {
          scorer = null;
        }
        const call: Fetched = { url: String(input), method: init?.method ?? 'GET', authorization, dpop: headers.get('dpop') ?? undefined, scorer, at: clock.now() };
        fetched.push(call);
        return script.fetch(call, fetched.length);
      },
      clock,
      bases: BASES,
    },
    clock,
    leftSink: sink,
    inFlight: {
      add: (id) => {
        steps.push({ op: 'add', id });
        live.add(id);
      },
      delete: (id) => {
        steps.push({ op: 'delete', id });
        live.delete(id);
      },
    },
    score: async (request) => {
      scoreCalls.push({ request, at: clock.now() });
      return script.score(request, scoreCalls.length);
    },
    fault: readFaultSwitch('sourcing-agent', ''),
    deadline_ms: NOW + 1_800_000,
    log: (line) => void logs.push(line),
  };
  const input = inputOf(PARENT_ID);
  return {
    clock, chain, queue, sink, live, steps, events, gateway, agent, root, scorers, tokenRequests, tokenTimes, fetched, scoreCalls, logs, script, deps, input,
    run: (over = {}) => clock.run(runScoring({ ...deps, ...over.deps }, { ...input, ...over.input }, over.signal)),
  };
}

// --- what a test reads -----------------------------------------------------------------------------------------------------------------------

/** The operations of the records of one id, in order. */
export const opsOf = (w: World, id: string): string[] => w.steps.filter((step) => step.id === id).map((step) => step.op);

/** The ids of the Delegates that the builder made, in order. A Delegate that was built and never sent is in the list too. */
export const idsOf = (w: World): string[] => w.chain.builtDelegates.map((built) => built.id);

/** The kinds of the transactions that the ledger took, in order. */
export const sentKinds = (w: World): string[] => w.chain.submitted.map((sent) => sent.kind);

/** Nothing was read from the chain, asked of the gateway, called, recorded or decided: a scoring that stopped before its first step. */
export function expectUntouched(w: World): void {
  expect(w.chain.log).toStrictEqual([]);
  expect(w.chain.submitted).toStrictEqual([]);
  expect(w.tokenRequests).toStrictEqual([]);
  expect(w.fetched).toStrictEqual([]);
  expect(w.steps).toStrictEqual([]);
  expect(w.scoreCalls).toStrictEqual([]);
}

/** Every Delegate that was sent was ended by an Undelegate that the ledger shows, and the records of each id are: added, stored, removed, deleted. The list and the set are empty at the end. */
export async function expectRecordedAndEnded(w: World, count: number): Promise<void> {
  expect(sentKinds(w).filter((kind) => kind === 'delegate')).toHaveLength(count);
  expect(sentKinds(w).filter((kind) => kind === 'undelegate')).toHaveLength(count);
  const ids = idsOf(w);
  expect(ids).toHaveLength(count);
  expect(new Set(ids).size).toBe(count);
  for (const id of ids) {
    expect(await w.chain.readDelegation(id)).toBeNull();
    expect(opsOf(w, id)).toStrictEqual(['add', 'put', 'remove', 'delete']);
  }
  expect(w.sink.entries.size).toBe(0);
  expect(w.live.size).toBe(0);
}

/**
 * The state after a scoring, whatever its result: no id is in use, and each Delegate that the ledger shows (after the time that a Delegate needs to land) has an entry in the list, so that the janitor ends
 * it. A Delegate that was ended has none.
 */
export async function expectSettled(w: World): Promise<void> {
  expect(w.live.size).toBe(0);
  await w.clock.advance(300_000);
  for (const id of idsOf(w)) {
    const shown = await w.chain.readDelegation(id);
    if (shown !== null) expect(w.sink.entries.has(id), `the sub-delegation ${id} is alive and has no entry`).toBe(true);
  }
}

/** One pass of the REAL janitor of the kit over the list and the ledger of the world: it ends each live sub-delegation of an entry with the Undelegate, and removes the entry. */
export function janitorOnce(w: World): Promise<JanitorReport> {
  return w.clock.run(
    runJanitorOnce({
      store: w.sink,
      chain: w.chain,
      delegationScript: SCRIPT,
      signerOf: (keyHash) => (keyHash === AGENT_KEY ? { ...markSigner(AGENT_KEY), address: WALLET } : null),
      queueOf: () => ({ run: (job) => w.queue.run(job), busy: false }),
      tipSlot: async () => slotOf(w.clock.now()),
      clock: w.clock,
      log: () => undefined,
      inFlight: (id) => w.live.has(id),
    }),
  );
}
