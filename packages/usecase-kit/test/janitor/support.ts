// packages/usecase-kit/test/janitor/support.ts: what the tests of the janitor share. No test uses the network: the ledger is the fake of the access tests (it builds real bytes for the Delegate and the Undelegate),
// the clock is moved by the test, and the list of left sub-delegations is in memory or in a temporary folder. A left sub-delegation comes from the real `withSubDelegation`, with an end that fails, as a run leaves it.
import type { DelegateBuild, DelegateParams, UndelegateBuild, UndelegateParams } from '@vsa/buyer-core';
import { createSerialQueue, withSubDelegation } from '../../src/access/index.ts';
import type { DelegationChain, LiveDelegation, Readiness, SerialQueue } from '../../src/access/index.ts';
import { MemoryLeftStore } from '../../src/janitor/index.ts';
import type { JanitorDeps, LeftEntry } from '../../src/janitor/index.ts';
import { AGENT_KEY, FakeClock, FakeDelegations, WALLET, markSigner, subWorld, type SubWorld } from '../access/support.ts';

export { AGENT_KEY, FakeClock, FakeDelegations, WALLET, settle } from '../access/support.ts';

/** What the next read of a delegation gives: a value (a delegation, `null`, or any other value), a throw, or no answer at all. */
export type ReadStep = { readonly kind: 'value'; readonly value: unknown } | { readonly kind: 'throw'; readonly error: unknown } | { readonly kind: 'hang' };
export const answer = (value: unknown): ReadStep => ({ kind: 'value', value });
export const throws = (error: unknown): ReadStep => ({ kind: 'throw', error });
export const hangs: ReadStep = { kind: 'hang' };

/** The ledger of the fake behind a port that the test can steer, and that counts what the janitor asks of it. */
export class ProbeChain implements DelegationChain {
  /** The id of each read of a delegation. */
  readonly reads: string[] = [];
  readonly builds: UndelegateParams[] = [];
  /** The signed transaction of each send. */
  readonly submits: string[] = [];
  /** The answers of the next reads, one for each read. When none is left, the ledger of the fake answers. */
  readonly script: ReadStep[] = [];
  /** A read waits for this promise before it answers. */
  gate: Promise<void> | null = null;
  buildHook: ((params: UndelegateParams) => Promise<UndelegateBuild>) | null = null;
  submitHook: ((signed: string) => Promise<string>) | null = null;

  constructor(readonly inner: FakeDelegations) {}

  async readDelegation(id: string): Promise<LiveDelegation | null> {
    this.reads.push(id);
    if (this.gate !== null) await this.gate;
    const step = this.script.shift();
    if (step === undefined) return this.inner.readDelegation(id);
    if (step.kind === 'throw') throw step.error;
    if (step.kind === 'hang') return new Promise<LiveDelegation | null>(() => undefined);
    const given: unknown = step.value;
    return given as LiveDelegation | null; // a port in JavaScript can give any value: the janitor must read it as one
  }

  readiness(id: string): Promise<Readiness> {
    return this.inner.readiness(id);
  }

  buildDelegate(params: DelegateParams): Promise<DelegateBuild> {
    return this.inner.buildDelegate(params);
  }

  buildUndelegate(params: UndelegateParams): Promise<UndelegateBuild> {
    this.builds.push(params);
    return this.buildHook === null ? this.inner.buildUndelegate(params) : this.buildHook(params);
  }

  submit(signed: string): Promise<string> {
    this.submits.push(signed);
    return this.submitHook === null ? this.inner.submit(signed) : this.submitHook(signed);
  }

  slotAt(ms: number): Promise<number> {
    return this.inner.slotAt(ms);
  }
}

/** A queue with the member `busy` that the janitor reads. The test sets `busy`. It counts the jobs that it was given. */
export class Lane implements SerialQueue {
  busy = false;
  runs = 0;
  readonly #queue = createSerialQueue();

  run<T>(job: () => Promise<T>): Promise<T> {
    this.runs += 1;
    return this.#queue.run(job);
  }
}

export interface Tip {
  /** The slot that the node says, or any other value that the test wants to hand over. */
  slot: unknown;
  calls: number;
  error: Error | null;
  hangs: boolean;
}

export interface World {
  readonly sub: SubWorld;
  readonly clock: FakeClock;
  readonly fake: FakeDelegations;
  readonly chain: ProbeChain;
  readonly store: MemoryLeftStore;
  readonly lane: Lane;
  readonly tip: Tip;
  /** How many times the key of the agent signed. */
  readonly signed: { calls: number };
  readonly logs: string[];
  readonly deps: JanitorDeps;
}

/** A ledger, a clock, an empty list, a signer for the agent key, a queue, a tip, and the deps of a janitor over them. `limits` are the optional members of the deps. */
export function world(limits: Pick<JanitorDeps, 'entryTimeoutMs' | 'pollMs' | 'stopWaitMs' | 'ttlMarginSlots'> = {}): World {
  const sub = subWorld();
  const chain = new ProbeChain(sub.chain);
  const store = new MemoryLeftStore();
  const lane = new Lane();
  const tip: Tip = { slot: 0, calls: 0, error: null, hangs: false };
  const signed = { calls: 0 };
  const logs: string[] = [];
  const mark = markSigner(AGENT_KEY);
  const signer = {
    keyHash: AGENT_KEY,
    address: WALLET,
    sign: (cbor: string): string => {
      signed.calls += 1;
      return mark.sign(cbor);
    },
  };
  const deps: JanitorDeps = {
    store,
    chain,
    delegationScript: sub.deps.delegationScript,
    signerOf: (keyHash) => (keyHash === AGENT_KEY ? signer : null),
    queueOf: () => lane,
    tipSlot: async () => {
      tip.calls += 1;
      if (tip.error !== null) throw tip.error;
      if (tip.hangs) return new Promise<number>(() => undefined);
      const slot: unknown = tip.slot;
      return slot as number; // a test hands over a value that is not a slot, to see that the janitor refuses it
    },
    clock: sub.clock,
    log: (line) => void logs.push(line),
    inFlight: () => false,
    ...limits,
  };
  return { sub, clock: sub.clock, fake: sub.chain, chain, store, lane, tip, signed, logs, deps };
}

/**
 * A left sub-delegation as a run leaves it, from the real `withSubDelegation`: the reference is put in the list before the Delegate is sent, and again after the end that failed, as a service does.
 * `build_fails`: the Delegate lands, and the Undelegate of the end step cannot be built, so the delegation is live on the ledger. `never_lands`: the node accepts the Delegate and it never lands, so the
 * ledger shows nothing. The faults are off again when this returns. The entry is in `w.store`.
 */
export async function leave(w: World, how: 'build_fails' | 'never_lands' = 'build_fails'): Promise<LeftEntry> {
  const { sub } = w;
  if (how === 'build_fails') sub.chain.faults.buildUndelegateThrows = true;
  else sub.chain.faults.delegateNeverLands = true;
  const limits = how === 'never_lands' ? { ...sub.limits, confirmationWaitMs: 30_000, endTimeoutMs: 20_000, landingWaitMs: 10_000 } : sub.limits;
  const deps = { ...sub.deps, beforeSend: (left: LeftEntry['left']): Promise<void> => w.store.put({ left, signer_key_hash: AGENT_KEY }) };
  const run = await sub.clock.run(withSubDelegation(deps, sub.request, limits, async () => 'job'));
  sub.chain.faults.buildUndelegateThrows = false;
  sub.chain.faults.delegateNeverLands = false;
  if (run.end.state !== 'not_ended') throw new Error(`the run ended with ${run.end.state}, and a left sub-delegation was needed`);
  const entry: LeftEntry = { left: run.end.left, signer_key_hash: AGENT_KEY };
  await w.store.put(entry);
  return entry;
}

/** The kinds of the transactions that the fake node got, in order. */
export const kindsOf = (w: World): string[] => w.fake.submitted.map((s) => s.kind);
