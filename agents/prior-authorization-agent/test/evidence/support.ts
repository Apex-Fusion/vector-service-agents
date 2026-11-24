// agents/prior-authorization-agent/test/evidence/support.ts: what the tests of the evidence folder share. The reads run the REAL `withSubDelegation` of the kit over the ledger, the clock and the keys of the
// tests of the access folder of the kit, so the Delegate and the Undelegate are real transaction bytes, and the clock is moved by the test. The gateway, the records system, the guideline store, the list of
// left sub-delegations and the set of the sub-delegations in use are scripted here. The record sets and the guidelines are the synthetic stand-in data of the files in `golden/`. No test uses the network, and
// no test waits for real time.
import { readFileSync } from 'node:fs';
import { expect } from 'vitest';
import type { GatewayRefused, GatewayResult, IssuedToken, TokenRequest } from '@vsa/id-kit/client';
import { ed25519Key } from '@vsa/id-kit/testing';
import type { TestKey } from '@vsa/id-kit/testing';
import { createSerialQueue } from '@vsa/usecase-kit/access';
import type { SerialQueue, TxSigner } from '@vsa/usecase-kit/access';
import { runJanitorOnce } from '@vsa/usecase-kit/janitor';
import type { JanitorReport } from '@vsa/usecase-kit/janitor';
import { parseGuideline, parseRecordSet } from '@vsa/usecase-kit/priorauth';
import type { Guideline, RecordSet } from '@vsa/usecase-kit/priorauth';
import type { DelegationId, ProtocolResult } from '@vsa/usecase-kit/protocol';
import {
  AGENT_KEY, BASES, DAY, FakeClock, FakeDelegations, NOW, OTHER_KEY, PARENT_ID, SCRIPT, SUBAGENT_ID, SUBAGENT_KEY, WALLET, markSigner, parentDatum, slotOf,
} from '../../../../packages/usecase-kit/test/access/support.ts';
import { readGuideline } from '../../src/evidence/guideline.ts';
import type { EvidenceDeps, EvidenceRequest, EvidenceResult, EvidenceRun, LeftEntry, LeftSink, SubagentName } from '../../src/evidence/ports.ts';
import { readEvidence } from '../../src/evidence/read.ts';
import { readRecords } from '../../src/evidence/records.ts';
import type { EndState, SubreadResult } from '../../src/evidence/subread.ts';

export { AGENT_KEY, BASES, DAY, FakeClock, NOW, OTHER_KEY, PARENT_ID, SCRIPT, SUBAGENT_KEY, WALLET, markSigner, parentDatum, slotOf };

export const RECORD_READER_DID = `did:vector:${SUBAGENT_ID}`;
export const DRAFTER_DID = `did:vector:${'dd'.repeat(32)}`;
export const DRAFTER_KEY = '23'.repeat(28);
export const TENANT = 'run1';
export const ORDER_ID = 'ORD-1001';
/** The service of the order ORD-1001, and so the code of the guideline that the second read asks for. */
export const SERVICE_CODE = 'SYN-MRI-LS';
/** The resources of the two systems of the tenant: the one resource of each sub-delegation. */
export const RECORDS_RESOURCE = `${BASES.publicBase}/t/${TENANT}/records`;
export const GUIDELINES_RESOURCE = `${BASES.publicBase}/t/${TENANT}/guidelines`;
/** The time from the arrival of a job to the end of every wait of it: the deadline that the caller of the evidence gives. */
export const DEADLINE_MS = 1_620_000;
/** The least time that a read needs: the least wait for the confirmations, the job under the sub-delegation, and the end step. */
export const LEAST_MS = 180_000 + 240_000 + 120_000;

/** The text as the ledger holds it in the datum of a delegation. */
export const hex = (text: string): string => Buffer.from(text, 'utf8').toString('hex');

// --- the stand-in data -----------------------------------------------------------------------------------------------------------------------------

const golden = (name: string): unknown => JSON.parse(readFileSync(new URL(`./golden/${name}.json`, import.meta.url), 'utf8'));
/** The bodies that the records system and the guideline store give, as JSON data: two orders and the guidelines of their services. */
export const RECORD_SET_BODY: unknown = golden('record-set');
export const GUIDELINE_BODY: unknown = golden('guideline');
export const KNEE_RECORD_SET_BODY: unknown = golden('record-set-knee');
export const KNEE_GUIDELINE_BODY: unknown = golden('guideline-knee');

/** The value of a result that must have passed. */
export function must<T>(result: ProtocolResult<T>): T {
  if (!result.ok) throw new Error(`the sample must pass, and it was refused: ${result.detail}`);
  return result.value;
}
/** What the reads give for the stand-in data: the checked copies. */
export const RECORD_SET: RecordSet = must(parseRecordSet(RECORD_SET_BODY));
export const GUIDELINE: Guideline = must(parseGuideline(GUIDELINE_BODY));
export const KNEE_RECORD_SET: RecordSet = must(parseRecordSet(KNEE_RECORD_SET_BODY));
export const KNEE_GUIDELINE: Guideline = must(parseGuideline(KNEE_GUIDELINE_BODY));

const URL_BODIES = new Map<string, unknown>([
  [`${BASES.publicBase}/t/${TENANT}/records/orders/ORD-1001`, RECORD_SET_BODY],
  [`${BASES.publicBase}/t/${TENANT}/records/orders/ORD-1002`, KNEE_RECORD_SET_BODY],
  [`${BASES.publicBase}/t/${TENANT}/guidelines/SYN-MRI-LS`, GUIDELINE_BODY],
  [`${BASES.publicBase}/t/${TENANT}/guidelines/SYN-MRI-KN`, KNEE_GUIDELINE_BODY],
]);

// --- the gateway and the systems -----------------------------------------------------------------------------------------------------------------

/** The grant that the gateway writes into a token: the delegation, the one action and the one resource that were asked for. */
export function issued(request: TokenRequest, now: number): GatewayResult<IssuedToken> {
  const grant = request.delegation;
  return {
    ok: true,
    value: {
      accessToken: 'aaaaaaaaaaaa.bbbbbbbbbbbb.cccccccccccc',
      tokenType: 'DPoP',
      issuedTokenType: 'urn:ietf:params:oauth:token-type:access_token',
      expiresIn: 300,
      expiresAt: now + 300_000,
      authorizationDetails: grant === undefined ? null : [{ identifier: grant.identifier, actions: grant.actions, locations: grant.locations }],
    },
  };
}

export const gatewayRefused = (status: number, error: string, detail: string): GatewayRefused => ({ ok: false, rule: 'gateway.refused', detail, status, error, retryAfterSeconds: null });
/** The answer of the gateway for a delegation that has fewer than 30 confirmations: the one text that the access folder reads as `delegation_too_young`. */
export const tooYoung = (): GatewayRefused => gatewayRefused(400, 'invalid_authorization_details', `delegation ${'ab'.repeat(32)} has fewer than 30 confirmations`);
export const gatewayDown = (rule: 'gateway.unavailable' | 'gateway.unreachable' | 'gateway.bad_response', status: number): GatewayRefused => ({ ok: false, rule, detail: 'no usable answer', status, error: null, retryAfterSeconds: null });

/** The answer of a system: a JSON body and a status. */
export const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** The action that a token request asks for: the first of the grant. It tells the two reads apart. */
export const actionOf = (request: TokenRequest): string | undefined => request.delegation?.actions?.[0];

/** The answer of the two systems: the stand-in body of a known URL, and the 404 of the system for an unknown order or guideline. */
export function systemAnswer(url: string): Response {
  const body = URL_BODIES.get(url);
  if (body !== undefined) return json(body);
  return json({ error: url.includes('/records/') ? 'order_not_found' : 'guideline_not_found', message: 'words that the system wrote' }, 404);
}

// --- the list of left sub-delegations, the set in use, and the janitor -------------------------------------------------------------------------

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
    if (this.listDelayMs > 0) await this.clock.sleep(this.listDelayMs);
    if (this.listFailure !== null) throw this.listFailure();
    return [...this.entries.values()];
  }
}

/** What a pass of the janitor did with the entries of the list: it skipped each id that a run still uses, and it took the others. */
export interface JanitorPass {
  readonly skipped: string[];
  readonly taken: string[];
}

/** One pass of the janitor, as far as the rule about a run in flight goes: an entry whose id is in the set of the runs in use is left alone, and every other entry is its work. */
export function janitorPass(entries: ReadonlyMap<string, unknown>, inUse: ReadonlySet<string>): JanitorPass {
  const pass: JanitorPass = { skipped: [], taken: [] };
  for (const id of entries.keys()) (inUse.has(id) ? pass.skipped : pass.taken).push(id);
  return pass;
}

// --- the world -------------------------------------------------------------------------------------------------------------------------------------

export interface Fetched {
  readonly url: string;
  readonly method: string;
  readonly authorization: string | undefined;
  readonly dpop: string | undefined;
}

/** The behaviour of each port. A test changes a member before the run. */
export interface Script {
  /** `attempt` counts the requests for the same action, from 1. */
  requestToken: (request: TokenRequest, attempt: number) => Promise<GatewayResult<IssuedToken>>;
  /** `attempt` counts the calls to the same system, from 1. */
  fetch: (url: string, attempt: number) => Promise<Response>;
  parseRecordSet: (body: unknown) => ProtocolResult<RecordSet>;
  parseGuideline: (body: unknown) => ProtocolResult<Guideline>;
}

export interface RunOptions {
  readonly deps?: Partial<EvidenceDeps>;
  readonly request?: Partial<EvidenceRequest>;
  /** The time that the caller gives, in POSIX milliseconds. The default is the deadline of a job that arrived at the start of the clock. */
  readonly deadline?: number;
  readonly signal?: AbortSignal;
}

/** A subagent of the tests: its DID, its keys, and the signer of its delegation key. */
export interface TestSubagent {
  readonly did: string;
  readonly keys: { readonly authentication: TestKey; readonly delegation: TestKey };
  readonly signer: TxSigner;
}

export interface World {
  readonly clock: FakeClock;
  readonly chain: FakeDelegations;
  readonly queue: SerialQueue;
  readonly sink: SinkSpy;
  /** The ids that a run still uses. */
  readonly live: Set<string>;
  readonly steps: Step[];
  readonly agents: Record<SubagentName, TestSubagent>;
  readonly tokenRequests: TokenRequest[];
  /** The time of each token request. */
  readonly tokenTimes: number[];
  readonly fetched: Fetched[];
  /** A pass of the janitor at the moment of each token request: the run waits for its 30 confirmations before that. */
  readonly janitorSeen: JanitorPass[];
  /** The lines that the reads wrote to their log. */
  readonly logs: string[];
  readonly script: Script;
  readonly deps: EvidenceDeps;
  readonly request: EvidenceRequest;
  /** The `EvidenceRun` of a call: the deadline of the options, or the full deadline from the start of the clock. */
  runOf(over?: RunOptions): EvidenceRun;
}

function subagentOf(label: string, did: string, keyHash: string): TestSubagent {
  return { did, keys: { authentication: ed25519Key(`${label} authentication`), delegation: ed25519Key(`${label} delegation`) }, signer: markSigner(keyHash) };
}

/** A world for the reads: a ledger with the delegation of the hirer to this agent, a clock, and a script that makes the golden run. */
export function world(options: { readonly queue?: SerialQueue } = {}): World {
  const clock = new FakeClock(NOW);
  const hirerToAgent = parentDatum({ actions: ['record.read', 'guideline.read', 'priorauth.submit'].map(hex), resources: [RECORDS_RESOURCE, GUIDELINES_RESOURCE].map(hex) });
  const chain = new FakeDelegations(clock, hirerToAgent, SCRIPT);
  const steps: Step[] = [];
  const sink = new SinkSpy(steps, clock);
  const live = new Set<string>();
  const queue = options.queue ?? createSerialQueue();
  const agents: Record<SubagentName, TestSubagent> = {
    'record-reader': subagentOf('record-reader', RECORD_READER_DID, SUBAGENT_KEY),
    drafter: subagentOf('drafter', DRAFTER_DID, DRAFTER_KEY),
  };
  const tokenRequests: TokenRequest[] = [];
  const tokenTimes: number[] = [];
  const fetched: Fetched[] = [];
  const janitorSeen: JanitorPass[] = [];
  const logs: string[] = [];
  const script: Script = {
    requestToken: async (request) => issued(request, clock.now()),
    fetch: async (url) => systemAnswer(url),
    parseRecordSet,
    parseGuideline,
  };
  const subagent = (name: SubagentName): EvidenceDeps['subagents']['drafter'] => ({
    did: agents[name].did,
    authenticationKey: agents[name].keys.authentication.privateKey,
    delegationKey: agents[name].keys.delegation.privateKey,
    signer: agents[name].signer,
  });
  const deps: EvidenceDeps = {
    subagents: { record_reader: subagent('record-reader'), drafter: subagent('drafter') },
    subDelegation: { chain, clock, delegationScript: SCRIPT, bases: BASES },
    tokens: {
      client: {
        requestToken: async (request) => {
          tokenRequests.push(request);
          tokenTimes.push(clock.now());
          janitorSeen.push(janitorPass(sink.entries, live));
          return script.requestToken(request, tokenRequests.filter((asked) => actionOf(asked) === actionOf(request)).length);
        },
      },
    },
    calls: {
      fetch: async (input, init) => {
        const headers = new Headers(init?.headers);
        const url = String(input);
        fetched.push({ url, method: init?.method ?? 'GET', authorization: headers.get('authorization') ?? undefined, dpop: headers.get('dpop') ?? undefined });
        const system = url.includes('/records/') ? '/records/' : '/guidelines/';
        return script.fetch(url, fetched.filter((call) => call.url.includes(system)).length);
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
    parseRecordSet: (body) => script.parseRecordSet(body),
    parseGuideline: (body) => script.parseGuideline(body),
    log: (line) => void logs.push(line),
  };
  const request: EvidenceRequest = { tenant: TENANT, order_id: ORDER_ID, delegation: PARENT_ID, key: { signer: markSigner(AGENT_KEY), walletAddress: WALLET, queue } };
  const runOf = (over: RunOptions = {}): EvidenceRun => ({ deadline: over.deadline ?? NOW + DEADLINE_MS, signal: over.signal });
  return { clock, chain, queue, sink, live, steps, agents, tokenRequests, tokenTimes, fetched, janitorSeen, logs, script, deps, request, runOf };
}

// --- the reads, so that a test runs for each of them ----------------------------------------------------------------------------------------------

/** What differs between the reads: the subagent, the route, the codes, the stand-in body, and how a test runs the read alone. */
export interface ReadCase {
  /** The name of the subagent, as the log names it. */
  readonly name: SubagentName;
  readonly action: string;
  readonly resource: string;
  /** The URL of the golden call. */
  readonly url: string;
  readonly timeoutCode: string;
  readonly invalidCode: string;
  /** The code that the system gives for an id that it does not know. */
  readonly notFound: string;
  /** The golden body that the system gives, as JSON data. */
  readonly body: unknown;
  /** What the read gives for the golden body. */
  readonly expected: unknown;
  /** A JSON body that the parser of this read refuses. */
  readonly wrong: unknown;
  /** The parser of the read that the script holds. */
  parser(script: Script): (body: unknown) => ProtocolResult<unknown>;
  /** Gives the script another parser for this read. The test gives a parser that returns the type of this read. */
  setParser(script: Script, parse: (body: unknown) => ProtocolResult<unknown>): void;
  /** Starts the read alone and gives its promise. The clock does not move: a test that runs two reads at one time moves it once. */
  start(w: World, over?: RunOptions): Promise<SubreadResult<unknown>>;
  /** Runs the read alone to its end on the fake clock. */
  run(w: World, over?: RunOptions): Promise<SubreadResult<unknown>>;
}

/** A read case with its `run` made from its `start`. */
const readCase = (spec: Omit<ReadCase, 'run'>): ReadCase => ({ ...spec, run: (w, over) => w.clock.run(spec.start(w, over)) });

const RECORDS_READ = readCase({
  name: 'record-reader',
  action: 'record.read',
  resource: RECORDS_RESOURCE,
  url: `${RECORDS_RESOURCE}/orders/${ORDER_ID}`,
  timeoutCode: 'record_read_timeout',
  invalidCode: 'record_set_invalid',
  notFound: 'order_not_found',
  body: RECORD_SET_BODY,
  expected: RECORD_SET,
  wrong: { order: RECORD_SET.order, records: [] },
  parser: (script) => script.parseRecordSet,
  setParser: (script, parse) => void (script.parseRecordSet = parse as Script['parseRecordSet']),
  start: (w, over = {}) => readRecords({ ...w.deps, ...over.deps }, { ...w.request, ...over.request }, w.runOf(over)),
});

const GUIDELINES_READ = readCase({
  name: 'drafter',
  action: 'guideline.read',
  resource: GUIDELINES_RESOURCE,
  url: `${GUIDELINES_RESOURCE}/${SERVICE_CODE}`,
  timeoutCode: 'guideline_read_timeout',
  invalidCode: 'guideline_invalid',
  notFound: 'guideline_not_found',
  body: GUIDELINE_BODY,
  expected: GUIDELINE,
  wrong: { ...GUIDELINE, criteria: [] },
  parser: (script) => script.parseGuideline,
  setParser: (script, parse) => void (script.parseGuideline = parse as Script['parseGuideline']),
  start: (w, over = {}) => readGuideline({ ...w.deps, ...over.deps }, { ...w.request, ...over.request }, w.runOf(over), SERVICE_CODE),
});

/** The reads of the evidence, in the order that they run. */
export const READS: readonly ReadCase[] = [RECORDS_READ, GUIDELINES_READ];

/** Starts both reads, one after the other, as the evidence does, and gives the promise. The clock does not move. */
export function startEvidence(w: World, over: RunOptions = {}): Promise<EvidenceResult> {
  return readEvidence({ ...w.deps, ...over.deps }, { ...w.request, ...over.request }, w.runOf(over));
}

/** Runs both reads to their end on the fake clock. */
export function runEvidence(w: World, over: RunOptions = {}): Promise<EvidenceResult> {
  return w.clock.run(startEvidence(w, over));
}

// --- what a test reads -----------------------------------------------------------------------------------------------------------------------------

/** The line that a failed read writes to the log: the name of its subagent and its code, and nothing else. */
export const failureLine = (read: ReadCase, code: string): string => `evidence: ${read.name}: the read failed with ${code}`;

/** What a read gives for the golden body: the checked copy and the end of its sub-delegation, which is `ended` unless the test says another. */
export const gives = (read: ReadCase, end: EndState = 'ended'): SubreadResult<unknown> => ({ ok: true, value: read.expected, end });

/** The operations of the records, in order. */
export const opsOf = (w: World): string[] => w.steps.map((step) => step.op);

/** The kinds of the transactions that were sent, in order, for this number of sub-delegations that were made and ended. */
export const KINDS = (made: number): string[] => Array.from({ length: made }, () => ['delegate', 'undelegate']).flat();

/** Nothing was read from the chain, asked of the gateway, called or recorded. */
export function expectUntouched(w: World): void {
  expect(w.chain.log).toStrictEqual([]);
  expect(w.chain.submitted).toStrictEqual([]);
  expect(w.tokenRequests).toStrictEqual([]);
  expect(w.fetched).toStrictEqual([]);
  expect(w.steps).toStrictEqual([]);
}

/** The Delegate and then the Undelegate of each of `made` sub-delegations were sent, and the ledger no longer shows any of them. */
export async function expectEnded(w: World, made = 1): Promise<void> {
  expect(w.chain.submitted.map((sent) => sent.kind)).toStrictEqual(KINDS(made));
  expect(w.chain.builtDelegates).toHaveLength(made);
  for (const built of w.chain.builtDelegates) expect(await w.chain.readDelegation(built.id), built.id).toBeNull();
}

/**
 * The records of runs that sent their Delegate and ended their sub-delegation: for each, the id is added, the entry is stored, the entry is removed, and the id is deleted, all for the one id of the
 * sub-delegation. The list and the set are empty at the end.
 */
export async function expectRecordedAndEnded(w: World, made = 1): Promise<void> {
  await expectEnded(w, made);
  expect(opsOf(w)).toStrictEqual(Array.from({ length: made }, () => ['add', 'put', 'remove', 'delete']).flat());
  expect(new Set(w.steps.map((step) => step.id))).toStrictEqual(new Set(w.chain.builtDelegates.map((built) => built.id)));
  expect(w.sink.entries.size).toBe(0);
  expect(w.live.size).toBe(0);
}

/** A result that is a failed read with this code, and holds no value. */
export function expectFailed(result: unknown, code: string): void {
  expect(result).toStrictEqual({ ok: false, code });
}

/** The values that no result, no log line and no detail may show: the keys, the token, and a part of a record. */
export function secretsOf(w: World): string[] {
  const keys = Object.values(w.agents).flatMap((agent) => [agent.keys.authentication.keyHash, agent.keys.delegation.keyHash]);
  return [AGENT_KEY, SUBAGENT_KEY, DRAFTER_KEY, ...keys, 'aaaaaaaaaaaa', 'bbbbbbbbbbbb', 'SYN-PT-0001', 'Naproxen', 'words that'];
}

/** The result and the log of the world show no key, no token and no part of a record. */
export function expectNoSecrets(w: World, result: unknown): void {
  const shown = `${JSON.stringify(result)}\n${w.logs.join('\n')}`;
  for (const secret of secretsOf(w)) expect(shown, secret).not.toContain(secret);
}

/** A ledger that shows the sub-delegation as made by the transaction that `txHash()` names. */
export function showing(chain: FakeDelegations, txHash: () => string): void {
  const read = chain.readDelegation.bind(chain);
  chain.readDelegation = async (id) => {
    const live = await read(id);
    return live === null || id === PARENT_ID ? live : { ...live, txHash: txHash() };
  };
}

/**
 * One pass of the REAL janitor of the kit over the list and the ledger of the world. A run that this process still uses is left alone, a sub-delegation that is live and that the Delegate of an entry made is
 * ended with the Undelegate, and the entry is then removed.
 */
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
