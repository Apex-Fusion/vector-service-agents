// agents/prior-authorization-agent/test/propose/support.ts: what the tests of the propose folder share. `runPropose` runs over fake ports: the ledger reads, the table of the delegation keys, the reader of the
// insurer, the evidence, the decision and the counter are scripted here, and each of them notes its calls. The clock is moved by the test. No test uses the network, and no test waits for real time.
// The golden files are synthetic: the record set and the guideline of the order `ORD-1001`, and the request that the golden run proposes for them.
import { readFileSync } from 'node:fs';
import { expect } from 'vitest';
import type { Clock } from '@vsa/usecase-kit/access';
import type { DelegationReading } from '@vsa/usecase-kit/buyer';
import { parseGuideline, parsePriorAuthRequest, parseRecordSet } from '@vsa/usecase-kit/priorauth';
import type { Guideline, RecordSet } from '@vsa/usecase-kit/priorauth';
import { accepted, refused } from '@vsa/usecase-kit/protocol';
import type { Decision, DelegationId, ProposalResult, ProposedResult, ProtocolResult, SubJob } from '@vsa/usecase-kit/protocol';
import { runPropose } from '../../src/propose/index.ts';
import type { DelegationKey, EvidenceRequest, EvidenceResult, EvidenceRun, JustificationChoice, JustifyAnswer, ProposeDeps, ProposeRequest } from '../../src/propose/index.ts';

/** The text of a golden file, and its value. */
const goldenText = (name: string): string => readFileSync(new URL(`./golden/${name}.json`, import.meta.url), 'utf8');
export const golden = (name: string): Record<string, unknown> => JSON.parse(goldenText(name)) as Record<string, unknown>; // a golden file is an object

export type Json = Record<string, unknown>;

/**
 * A deep copy of `value` with the value at `path` set to `to`. The path must exist up to its last step: a copy of a path that does not exist is an error of the test. A test uses it to make a variant of a
 * golden file, and the sample does not change.
 */
export function changed(value: unknown, path: readonly (string | number)[], to: unknown): Json {
  const copy = JSON.parse(JSON.stringify(value)) as Json; // a golden value is JSON data
  let holder: unknown = copy;
  for (const step of path.slice(0, -1)) {
    if (typeof holder !== 'object' || holder === null) throw new Error(`the sample has no value at ${path.join('.')}`);
    holder = Reflect.get(holder, step);
  }
  const last = path[path.length - 1];
  if (typeof holder !== 'object' || holder === null || last === undefined) throw new Error(`the sample has no member at ${path.join('.')}`);
  Reflect.set(holder, last, to);
  return copy;
}

/** The value at `path` of `value`. A path that does not exist is an error of the test. */
function valueAt(value: unknown, path: readonly (string | number)[]): unknown {
  let at: unknown = value;
  for (const step of path) {
    if (typeof at !== 'object' || at === null) throw new Error(`the sample has no value at ${path.join('.')}`);
    at = Reflect.get(at, step);
  }
  return at;
}

/** The object at `path` of `value`, for a test that plays a port that changes the object in place. A path that does not give an object is an error of the test. */
export function objectAt(value: unknown, path: readonly (string | number)[]): Json {
  const found = valueAt(value, path);
  if (typeof found !== 'object' || found === null || Array.isArray(found)) throw new Error(`the sample has no object at ${path.join('.')}`);
  return found as Json; // the guard above says that it is an object
}

/** The list at `path` of `value`, for a test that plays a port that changes the list in place. A path that does not give a list is an error of the test. */
export function listAt(value: unknown, path: readonly (string | number)[]): unknown[] {
  const found = valueAt(value, path);
  if (!Array.isArray(found)) throw new Error(`the sample has no list at ${path.join('.')}`);
  return found;
}

/** A value that a parser of the kit must take: the golden files pass their parsers, and a file that does not is an error of the test. */
function must<T>(result: ProtocolResult<T, string>): T {
  if (!result.ok) throw new Error(`a golden file must pass its parser: ${result.detail}`);
  return result.value;
}

export const NOW = 1_790_000_000_000;
export const AGENT_ID = 'a1'.repeat(32);
export const AGENT_DID = `did:vector:${AGENT_ID}`;
export const PRINCIPAL_DID = `did:vector:${'1f'.repeat(32)}`;
export const DELEGATION: DelegationId = 'd3'.repeat(32);
export const KEY_HASH = 'e5'.repeat(28);
export const TENANT = 'run1';
export const ORDER_ID = 'ORD-1001';
/** The insurer and its advert, as the golden request names them. */
export const INSURER_DID = `did:vector:${'b8'.repeat(32)}`;
export const ADVERT_REF = `${'c3'.repeat(32)}#1`;

/** The golden record set and guideline of the order `ORD-1001`, and the golden request that the run proposes for them. */
export const RECORD_SET: RecordSet = must(parseRecordSet(golden('record-set')));
export const GUIDELINE: Guideline = must(parseGuideline(golden('guideline')));
export const GOLDEN_REQUEST = must(parsePriorAuthRequest(golden('request')));
/** The hash of the golden record set that the golden request carries. */
export const SET_SHA256 = GOLDEN_REQUEST.record_set_sha256;

/** The choice of the decision `justification` of the golden run: the justification and the references that the golden request holds. */
export const CHOICE: JustificationChoice = {
  justification: GOLDEN_REQUEST.justification,
  guideline_refs: [...GOLDEN_REQUEST.guideline_refs],
  record_refs: [...GOLDEN_REQUEST.record_refs],
};

const VERIFICATION = {
  escrow_ref_matches: true, response_hash_matches: true, supplier_key_matches: true, signature_valid: true, on_chain_hash_matches: true, prompt_hash_matches: true, model_matches: true, fields_match: true,
} as const;
export const SUB_JOB: SubJob = {
  capability_id: 'llm.text.generate.v1',
  advert_ref: `${'4a'.repeat(32)}#0`,
  escrow_ref: `${'5b'.repeat(32)}#0`,
  supplier_pkh: 'ab'.repeat(28),
  receipt: { escrow_ref: `${'5b'.repeat(32)}#0`, model: 'deepseek/deepseek-v4-flash' },
  receipt_signature: 'cd'.repeat(64),
  verification: VERIFICATION,
};
/** The decision `justification` as the model hire gives it. */
export const DECISION: Decision = {
  name: 'justification',
  choice: { justification: CHOICE.justification, guideline_refs: [...CHOICE.guideline_refs], record_refs: [...CHOICE.record_refs] },
  reasoning: 'the records meet the four criteria',
  inference: { path: 'marketplace', sub_job: SUB_JOB, accepted: 'confirmed' },
};

/** The answer of the decision for a choice: the decision records that same choice, as the decision of the model does. */
export function answerFor(choice: JustificationChoice): JustifyAnswer {
  return { ok: true, decision: { ...DECISION, choice: { justification: choice.justification, guideline_refs: [...choice.guideline_refs], record_refs: [...choice.record_refs] } }, choice };
}

/** The request of the golden run: the delegation of the hirer to this agent, the tenant, the order and the insurer. */
export const REQUEST: ProposeRequest = {
  op: 'propose',
  authority: { principal_did: PRINCIPAL_DID, delegation: DELEGATION },
  tenant: TENANT,
  order_id: ORDER_ID,
  insurer_did: INSURER_DID,
};

/** The delegation key that this agent holds for the delegation of the hirer. */
export const KEY: DelegationKey = { signer: { keyHash: KEY_HASH, sign: () => '' }, walletAddress: 'addr_test1golden', queue: { run: (job) => job() } };

// --- the clock -------------------------------------------------------------------------------------------------------------------------------------

/** Lets every promise that can go on, go on. It uses the real event loop, which no test moves. */
async function settle(): Promise<void> {
  for (let round = 0; round < 8; round += 1) await new Promise<void>((resolve) => setImmediate(resolve));
}

/** A clock that only the test moves. A sleep ends when the test moves the time to it, or when its signal aborts. `jump` moves the time at once, as a port that took a long time does. */
export class FakeClock implements Clock {
  #now: number;
  #seq = 0;
  readonly #timers: { due: number; seq: number; resolve: () => void }[] = [];

  constructor(start: number) {
    this.#now = start;
  }

  now(): number {
    return this.#now;
  }

  jump(at: number): void {
    this.#now = at;
  }

  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve) => {
      if (signal?.aborted === true) {
        resolve();
        return;
      }
      const timer = { due: this.#now + ms, seq: (this.#seq += 1), resolve };
      this.#timers.push(timer);
      signal?.addEventListener('abort', () => {
        const at = this.#timers.indexOf(timer);
        if (at >= 0) this.#timers.splice(at, 1);
        resolve();
      }, { once: true });
    });
  }

  /** Moves the time from sleep to sleep until `work` ends. It fails when no sleep waits and the work is not done: that is a wait with no end. */
  async run<T>(work: Promise<T>): Promise<T> {
    let done = false;
    work.then(() => (done = true), () => (done = true));
    for (let step = 0; ; step += 1) {
      await settle();
      if (done) return work;
      if (step >= 100_000) throw new Error('the fake clock ran 100,000 steps and the work did not end');
      const next = [...this.#timers].sort((a, b) => a.due - b.due || a.seq - b.seq)[0];
      if (next === undefined) throw new Error('nothing waits on the clock, and the work did not end: a wait with no end');
      this.#timers.splice(this.#timers.indexOf(next), 1);
      this.#now = Math.max(this.#now, next.due);
      next.resolve();
    }
  }
}

// --- the world -------------------------------------------------------------------------------------------------------------------------------------

/** The name of each port, in the order that the golden run calls them. */
export const PORTS = ['delegation', 'key', 'insurer', 'evidence', 'justify', 'counter'] as const;
export type PortName = (typeof PORTS)[number];

/** The behaviour of each port. A test changes a member before the run. */
export interface Script {
  delegation: () => Promise<DelegationReading | null>;
  delegateKeyOf: (id: DelegationId) => Promise<string | null>;
  findKey: (keyHash: string) => DelegationKey | null;
  readInsurer: (insurer: string) => Promise<ProtocolResult<{ advert_ref: string }, string>>;
  evidence: (request: EvidenceRequest, run: EvidenceRun) => Promise<EvidenceResult>;
  justify: (set: RecordSet, guideline: Guideline) => Promise<JustifyAnswer>;
  next: (tenant: string) => Promise<number>;
}

export interface RunOptions {
  readonly deps?: Partial<ProposeDeps>;
  readonly request?: Partial<ProposeRequest>;
  readonly arrivedAt?: number;
  readonly signal?: AbortSignal;
}

export interface World {
  readonly clock: FakeClock;
  /** The port calls, in order: one name for each call of a port. The table of the keys is part of `key`. */
  readonly calls: PortName[];
  readonly insurerCalls: string[];
  readonly evidenceCalls: { readonly request: EvidenceRequest; readonly run: EvidenceRun }[];
  /** What the decision was given: the objects, and the text of each one at the moment of the call. */
  readonly justifyCalls: { readonly set: RecordSet; readonly guideline: Guideline; readonly setText: string; readonly guidelineText: string }[];
  readonly counterCalls: string[];
  /** The last number that the memory counter gave to each tenant. */
  readonly numbers: Map<string, number>;
  /** The lines that the job wrote to its log. */
  readonly logs: string[];
  readonly script: Script;
  readonly deps: ProposeDeps;
  run(over?: RunOptions): Promise<ProposalResult>;
}

/** A world for `runPropose`: a delegation of the hirer to this agent, a key, an insurer, the golden evidence, a decision that holds the golden choice, and a counter in memory. */
export function world(): World {
  const clock = new FakeClock(NOW);
  const calls: PortName[] = [];
  const insurerCalls: string[] = [];
  const evidenceCalls: World['evidenceCalls'] = [];
  const justifyCalls: World['justifyCalls'] = [];
  const counterCalls: string[] = [];
  const numbers = new Map<string, number>();
  const logs: string[] = [];
  const script: Script = {
    delegation: async () => ({ delegate: AGENT_ID, chain_whole: true }),
    delegateKeyOf: async () => KEY_HASH,
    findKey: (keyHash) => (keyHash === KEY_HASH ? KEY : null),
    readInsurer: async () => accepted({ advert_ref: ADVERT_REF }),
    evidence: async () => ({ ok: true, record_set: RECORD_SET, guideline: GUIDELINE }),
    justify: async () => ({ ok: true, decision: DECISION, choice: CHOICE }),
    next: async (tenant) => {
      const next = (numbers.get(tenant) ?? 0) + 1;
      numbers.set(tenant, next);
      return next;
    },
  };
  const deps: ProposeDeps = {
    agent: { did: AGENT_DID },
    reads: {
      delegation: () => {
        calls.push('delegation');
        return script.delegation();
      },
      liveVaults: async () => ({ refs: [], complete: true }),
    },
    delegateKeyOf: (id) => {
      calls.push('key');
      return script.delegateKeyOf(id);
    },
    delegationKeys: { find: (keyHash) => script.findKey(keyHash) },
    readInsurer: (insurer) => {
      calls.push('insurer');
      insurerCalls.push(insurer);
      return script.readInsurer(insurer);
    },
    evidence: (request, run) => {
      calls.push('evidence');
      evidenceCalls.push({ request, run });
      return script.evidence(request, run);
    },
    justify: (set, guideline) => {
      calls.push('justify');
      justifyCalls.push({ set, guideline, setText: JSON.stringify(set), guidelineText: JSON.stringify(guideline) });
      return script.justify(set, guideline);
    },
    counter: {
      next: (tenant) => {
        calls.push('counter');
        counterCalls.push(tenant);
        return script.next(tenant);
      },
    },
    clock,
    log: (line) => void logs.push(line),
  };
  return {
    clock, calls, insurerCalls, evidenceCalls, justifyCalls, counterCalls, numbers, logs, script, deps,
    run: (over = {}) => clock.run(runPropose({ ...deps, ...over.deps }, { ...REQUEST, ...over.request }, over.arrivedAt ?? NOW, over.signal)),
  };
}

/** A refusal of a port that gives a code and words. The words must never reach a result. */
export const refusal = (code: string): ProtocolResult<never, string> => refused(code, 'words that the port wrote');

// --- what a test reads -----------------------------------------------------------------------------------------------------------------------------

/** The proposal of a result that must be a proposal. */
export function proposed(result: ProposalResult): ProposedResult {
  if (result.outcome !== 'proposed') throw new Error(`the job failed with the reason ${result.reason}, and the test expected a proposal`);
  return result;
}

/** A result that is a failed proposal with this reason, and holds no document, no salt and no digest. */
export function expectFailed(result: ProposalResult, reason: string): void {
  expect(result).toMatchObject({ outcome: 'failed', exit_state: 'Failed', reason, document: null, salt: null, proposal_digest: null, fault_mode: '', use_case: 'prior-authorization' });
}

/** The ports that the job called, in order. */
export const calledPorts = (w: World): PortName[] => [...w.calls];

/** Nothing was read for the evidence, decided or counted: no port after the insurer was called. */
export function expectNothingPaid(w: World): void {
  expect(w.evidenceCalls).toStrictEqual([]);
  expect(w.justifyCalls).toStrictEqual([]);
  expect(w.counterCalls).toStrictEqual([]);
  expect(w.numbers.size).toBe(0);
}

/** The job stopped before the decision: the evidence may have been called, and the decision and the counter were not. */
export function expectNotDecided(w: World): void {
  expect(w.justifyCalls).toStrictEqual([]);
  expect(w.counterCalls).toStrictEqual([]);
  expect(w.numbers.size).toBe(0);
}
