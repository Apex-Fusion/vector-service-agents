// packages/usecase-kit/test/access/subdelegation.test.ts: the sub-delegation of an agent to a subagent. The ledger is an object in memory and the clock is moved by the test (support.ts). The review
// question: is a sub-delegation ever left alive? Each test of an end has its twin: the same run in which nothing goes wrong, or the same failure at a point where it is harmless.
import { describe, expect, it } from 'vitest';
import { DEFAULT_STEP_TIMEOUT_MS, MAX_SUB_DELEGATION_MS, MIN_SUB_DELEGATION_MS, ROUTES, tokenTarget, withSubDelegation, x509Target } from '../../src/access/index.ts';
import type { DelegationDatum, LeftSubDelegation, SubDelegationHandle, SubDelegationRun } from '../../src/access/index.ts';
import { AGENT_KEY, BASES, DAY, NOW, OTHER_KEY, PARENT_ID, SUBAGENT_ID, SUBAGENT_KEY, WALLET, erpTarget, expectTarget, markSigner, parentDatum, subWorld, type SubWorld } from './support.ts';


/** Runs the sub-delegation with the job, and moves the clock until it ends. A wait with no end fails the test. */
const go = <T>(w: SubWorld, job: (handle: SubDelegationHandle) => Promise<T>): Promise<SubDelegationRun<T>> => w.clock.run(withSubDelegation(w.deps, w.request, w.limits, job));
const hex = (text: string): string => Buffer.from(text, 'utf8').toString('hex');
const idle = async (): Promise<string> => 'done';

/** The ledger shows no live sub-delegation, and an Undelegate was sent after the Delegate. */
async function expectEnded(w: SubWorld): Promise<void> {
  const kinds = w.chain.submitted.map((s) => s.kind);
  expect(kinds).toStrictEqual(['delegate', 'undelegate']);
  expect(w.chain.subId).not.toBeNull();
  expect(await w.chain.readDelegation(w.chain.subId!)).toBeNull();
}

describe('the sub-delegation is ended', () => {
  it('after the job returned a value: in this order, with the Undelegate signed by the agent key', async () => {
    const w = subWorld();
    let handle: SubDelegationHandle | null = null;
    const run = await go(w, async (h) => {
      handle = h;
      return 'stock read';
    });
    expect(run).toMatchObject({ ok: true, kind: 'returned', value: 'stock read', end: { state: 'ended' } });
    await expectEnded(w);
    const order = ['read:parent', 'buildDelegate', 'submit:delegate', 'readiness', 'buildUndelegate', 'submit:undelegate'].map((step) => w.chain.log.indexOf(step));
    expect(order.every((at, i) => at >= 0 && (i === 0 || at > order[i - 1]!))).toBe(true);
    expect(w.chain.log.lastIndexOf('readiness')).toBeLessThan(w.chain.log.indexOf('buildUndelegate'));
    expect(w.chain.undelegateParams).toStrictEqual([{ changeAddress: WALLET, nowMs: expect.any(Number), id: w.chain.subId, signer: AGENT_KEY }]);
    expect(w.chain.submitted[1]!.cbor).toBe(`undelegate:${w.chain.subId}+${AGENT_KEY.slice(0, 4)}`);
    expect(run.end).toMatchObject({ state: 'ended', txHash: `ff${w.chain.subId!.slice(2)}` });
    expect(handle).toMatchObject({ id: w.chain.subId, parent: PARENT_ID, notAfter: NOW + 3_600_000 });
    expect(handle!.signal.aborted).toBe(false);
  });

  const jobs: [string, () => Promise<unknown>][] = [
    ['a refusal that the job found', async () => ({ ok: false, code: 'refused_by_system', reason: 'not_covered', status: 403 })],
    ['a failure that the job found', async () => ({ ok: false, code: 'mock_system_failed', status: 500 })],
    ['a value that is false', async () => false],
    ['nothing', async () => undefined],
  ];
  it.each(jobs)('after the job returned %s, and the job result is the value', async (_name, job) => {
    const w = subWorld();
    const run = await go(w, job);
    expect(run).toMatchObject({ ok: true, kind: 'returned', end: { state: 'ended' } });
    expect(run.ok && run.value).toStrictEqual(await job());
    await expectEnded(w);
  });

  it('after the job threw: the error of the job comes back unchanged', async () => {
    const w = subWorld();
    const boom = new RangeError('the job broke');
    const run = await go(w, async () => {
      throw boom;
    });
    expect(run.ok).toBe(false);
    expect(run).toMatchObject({ kind: 'threw', end: { state: 'ended' } });
    expect(run.kind === 'threw' && run.error).toBe(boom);
    await expectEnded(w);
  });

  it('after the job threw a value that is not an error, and after a job that threw before its first await', async () => {
    const early = subWorld();
    const run = await go(early, () => {
      throw 'plain text';
    });
    expect(run).toMatchObject({ ok: false, kind: 'threw', error: 'plain text', end: { state: 'ended' } });
    await expectEnded(early);
  });

  it('after the job timed out: the job time is the clock time, the signal aborts, and the job is not waited for', async () => {
    const w = subWorld({ limits: { jobTimeoutMs: 90_000 } });
    let handle: SubDelegationHandle | null = null;
    const started = { at: 0 };
    const run = await go(w, (h) => {
      handle = h;
      started.at = w.clock.now();
      return new Promise<never>(() => undefined);
    });
    expect(run).toMatchObject({ ok: false, kind: 'timed_out', end: { state: 'ended' } });
    expect(handle!.signal.aborted).toBe(true);
    expect(w.chain.submitted.find((s) => s.kind === 'undelegate')!.at).toBe(started.at + 90_000);
    await expectEnded(w);
  });

  it('after the wait for the confirmations timed out, with no job run: the sub-delegation is on the ledger and it is ended', async () => {
    const w = subWorld({ limits: { confirmationWaitMs: 60_000 } });
    w.chain.faults.neverConfirm = true;
    let ran = false;
    const run = await go(w, async () => (ran = true));
    expect(run).toMatchObject({ ok: false, kind: 'not_ready', failure: { code: 'confirmation_timeout' }, end: { state: 'ended' } });
    expect(run.kind === 'not_ready' && run.failure.detail).toMatch(/of 30 confirmations/);
    expect(ran).toBe(false);
    await expectEnded(w);
  });

  it('after a ledger that cannot be read during the wait, and after a chain that is not usable: the sub-delegation lands and it is ended', async () => {
    const unreadable = subWorld({ limits: { confirmationWaitMs: 30_000 } });
    unreadable.chain.faults.readinessThrows = true;
    expect(await go(unreadable, idle)).toMatchObject({ ok: false, kind: 'not_ready', failure: { code: 'ledger_unreadable' }, end: { state: 'ended' } });
    await expectEnded(unreadable);
    const unusable = subWorld();
    unusable.chain.faults.unusable = true;
    const run = await go(unusable, idle);
    expect(run).toMatchObject({ ok: false, kind: 'not_ready', failure: { code: 'sub_delegation_unusable' }, end: { state: 'ended' } });
    expect(run.kind === 'not_ready' && run.failure.detail).toContain('the delegate is not Active');
    await expectEnded(unusable);
  });

  it('after a Delegate that the node refused but that landed anyway: it was sent, so it is ended', async () => {
    const w = subWorld();
    w.chain.faults.submitDelegateThrows = true;
    w.chain.faults.delegateLandsAnyway = true;
    const run = await go(w, idle);
    expect(run).toMatchObject({ ok: false, kind: 'not_ready', failure: { code: 'submit_failed' }, end: { state: 'ended' } });
    await expectEnded(w);
  });
});

describe('the twins of the ends above', () => {
  it('the job ends one millisecond before its time, and it is not a timeout; one millisecond later it is', async () => {
    for (const [ms, kind] of [[89_999, 'returned'], [90_000, 'timed_out']] as const) {
      const w = subWorld({ limits: { jobTimeoutMs: 90_000 } });
      const run = await go(w, async () => (await w.clock.sleep(ms), 'late'));
      expect(run.kind, `${ms}`).toBe(kind);
      expect(run.end.state).toBe('ended');
    }
  });

  it('the confirmations come in time, and the job runs: the delegation has 30 confirmations at 128 seconds, and the wait is bounded at its limit', async () => {
    for (const [wait, kind] of [[100_000, 'not_ready'], [127_000, 'not_ready'], [135_000, 'returned'], [200_000, 'returned']] as const) {
      const w = subWorld({ limits: { confirmationWaitMs: wait } });
      const run = await go(w, idle);
      expect(run.kind, `${wait}`).toBe(kind);
      expect(run.end.state).toBe('ended');
    }
  });

  it('a read of the ledger that fails for a while does not end the wait: it goes on, and the job runs', async () => {
    const w = subWorld();
    const readiness = w.chain.readiness.bind(w.chain);
    let reads = 0;
    w.chain.readiness = async (...args) => {
      reads += 1;
      if (reads <= 3) throw new Error('the ledger cannot be read');
      return readiness(...args);
    };
    expect(await go(w, idle)).toMatchObject({ ok: true, kind: 'returned', end: { state: 'ended' } });
  });

  it('a chain that stays unreadable but is read once gives a timeout, and a chain that is never read gives an unreadable ledger', async () => {
    const w = subWorld({ limits: { confirmationWaitMs: 30_000 } });
    const readiness = w.chain.readiness.bind(w.chain);
    let reads = 0;
    w.chain.readiness = async (...args) => {
      reads += 1;
      if (reads > 1) throw new Error('the ledger cannot be read');
      return readiness(...args);
    };
    const run = await go(w, idle);
    expect(run).toMatchObject({ kind: 'not_ready', failure: { code: 'ledger_unreadable' } });
  });

  it('a call to the ledger that never answers still ends the wait at its bound', async () => {
    const w = subWorld({ limits: { confirmationWaitMs: 45_000 } });
    w.chain.faults.readinessHangs = true;
    const started = w.clock.now();
    const run = await go(w, idle);
    expect(run).toMatchObject({ ok: false, kind: 'not_ready', failure: { code: 'confirmation_timeout' }, end: { state: 'ended' } });
    expect(w.clock.now() - started).toBeLessThan(45_000 + 130_000);
  });
});

describe('an end step that fails', () => {
  it('is reported with the reference that is left, and the value of the job stays', async () => {
    const w = subWorld();
    w.chain.faults.buildUndelegateThrows = true;
    const run = await go(w, async () => ({ stock: 12 }));
    expect(run).toMatchObject({ ok: true, kind: 'returned', value: { stock: 12 } });
    expect(run.end).toMatchObject({ state: 'not_ended', code: 'end_failed', left: { id: w.chain.subId, parent: PARENT_ID, action: 'erp.stock.read', resource: w.target.resource, endTxHash: null } });
    const left = run.end.state === 'not_ended' ? run.end.left : null;
    expect(left).toMatchObject({ delegateTxHash: `ee${w.chain.subId!.slice(2)}`, notAfter: NOW + 3_600_000 });
    expect(left!.delegateValidTo).toBeGreaterThan(NOW);
    expect(w.chain.submitted.map((s) => s.kind)).toStrictEqual(['delegate']);
  });

  it('does not hide the error of the job: the error and the failed end are both in the result', async () => {
    const w = subWorld();
    w.chain.faults.buildUndelegateThrows = true;
    const boom = new Error('the job broke');
    const run = await go(w, async () => {
      throw boom;
    });
    expect(run).toMatchObject({ ok: false, kind: 'threw', end: { state: 'not_ended', code: 'end_failed' } });
    expect(run.kind === 'threw' && run.error).toBe(boom);
  });

  it('is reported when the node refuses the Undelegate, with the hash of the Undelegate in the reference', async () => {
    const w = subWorld();
    w.chain.faults.submitUndelegateThrows = true;
    const run = await go(w, idle);
    expect(run).toMatchObject({ ok: true, end: { state: 'not_ended', code: 'end_failed', left: { endTxHash: `ff${w.chain.subId!.slice(2)}` } } });
  });

  it('is reported as not confirmed when the Undelegate never lands, at the end time of the step and not later', async () => {
    const w = subWorld({ limits: { endTimeoutMs: 40_000 } });
    w.chain.faults.undelegateNeverLands = true;
    const run = await go(w, idle);
    const undelegateAt = w.chain.submitted.find((s) => s.kind === 'undelegate')!.at;
    expect(run).toMatchObject({ ok: true, end: { state: 'not_ended', code: 'end_unconfirmed', left: { endTxHash: expect.any(String) } } });
    expect(w.clock.now() - undelegateAt).toBeLessThanOrEqual(40_000);
  });

  it('waits for a Delegate that is not on the ledger yet, and reports it when it never comes', async () => {
    const w = subWorld({ limits: { endTimeoutMs: 30_000 } });
    w.chain.faults.submitDelegateThrows = true;
    const run = await go(w, idle);
    expect(run).toMatchObject({ ok: false, kind: 'not_ready', failure: { code: 'submit_failed' }, end: { state: 'not_ended', code: 'end_unconfirmed', left: { endTxHash: null } } });
    expect(w.chain.log.filter((step) => step === 'buildUndelegate').length).toBeGreaterThan(2);
    expect(w.chain.submitted.map((s) => s.kind)).toStrictEqual(['delegate']);
  });

  it('stops at once when the ledger shows the sub-delegation and the builder still refuses: time does not change that', async () => {
    const w = subWorld();
    w.chain.faults.buildUndelegateThrows = true;
    await go(w, idle);
    expect(w.chain.log.filter((step) => step === 'buildUndelegate').length).toBe(1);
  });
});

describe('a sub-delegation that is wider than the narrow one is never built', () => {
  it('has the narrow terms in the request to the builder, and the caller cannot change them', async () => {
    const w = subWorld({ request: { remaining: 5, value: { perTx: 9n, total: 9n, periodMs: 1 }, actions: ['*'], resources: ['*'], notAfter: NOW + 100 * DAY } as never });
    await go(w, idle);
    expect(w.chain.params).toHaveLength(1);
    const [params] = w.chain.params;
    expect(params).toStrictEqual({
      changeAddress: WALLET, nowMs: NOW, parent: PARENT_ID, delegate: SUBAGENT_ID, delegateKey: SUBAGENT_KEY, actions: ['erp.stock.read'], resources: [w.target.resource],
      notAfter: NOW + 3_600_000, remaining: 0, value: { perTx: 0n, total: 0n, periodMs: DAY },
    });
  });

  it('takes the period of the parent, and the validity of the parent when it ends sooner', async () => {
    const week = subWorld({ parent: parentDatum({ value: { perTx: 1n, total: 1n, periodMs: 7 * DAY } }) });
    await go(week, idle);
    expect(week.chain.params[0]!.value).toStrictEqual({ perTx: 0n, total: 0n, periodMs: 7 * DAY });
    const unlimited = subWorld({ parent: parentDatum({ value: null }) });
    await go(unlimited, idle);
    expect(unlimited.chain.params[0]!.value).toStrictEqual({ perTx: 0n, total: 0n, periodMs: 3_600_000 });
    const short = subWorld({ parent: parentDatum({ notAfter: NOW + 20 * 60_000 }) });
    await go(short, idle);
    expect(short.chain.params[0]!.notAfter).toBe(NOW + 20 * 60_000);
    expect(short.chain.params[0]!.notBefore).toBeUndefined();
  });

  const tampers: [string, (d: DelegationDatum) => DelegationDatum][] = [
    ['one more hop', (d) => ({ ...d, remaining: 1 })],
    ['three more hops', (d) => ({ ...d, remaining: 3 })],
    ['a value of 1 per transaction', (d) => ({ ...d, value: { perTx: 1n, total: 0n, periodMs: DAY } })],
    ['a total of 1', (d) => ({ ...d, value: { perTx: 0n, total: 1n, periodMs: DAY } })],
    ['no value limit', (d) => ({ ...d, value: null })],
    ['another period', (d) => ({ ...d, value: { perTx: 0n, total: 0n, periodMs: DAY + 1 } })],
    ['a second action', (d) => ({ ...d, actions: [...d.actions, hex('po.write')] })],
    ['a pattern for an action', (d) => ({ ...d, actions: [hex('erp.*')] })],
    ['another action', (d) => ({ ...d, actions: [hex('po.write')] })],
    ['no action', (d) => ({ ...d, actions: [] })],
    ['a second resource', (d) => ({ ...d, resources: [...d.resources, hex('https://mock.example/t/run1/po')] })],
    ['every resource', (d) => ({ ...d, resources: [hex('*')] })],
    ['no resource', (d) => ({ ...d, resources: [] })],
    ['another parent', (d) => ({ ...d, parent: 'dd'.repeat(32) })],
    ['no parent', (d) => ({ ...d, parent: null })],
    ['another delegate', (d) => ({ ...d, delegate: 'dd'.repeat(32) })],
    ['another delegate key', (d) => ({ ...d, delegateKey: OTHER_KEY })],
    ['a principal key as its delegator', (d) => ({ ...d, delegator: { type: 'PrincipalKey', hash: '44'.repeat(28), organisation: null } })],
    ['an end after the parent', (d) => ({ ...d, notAfter: NOW + 5 * DAY + 1 })],
    ['an end that is not the one asked for', (d) => ({ ...d, notAfter: d.notAfter - 1 })],
    ['a start before the parent', (d) => ({ ...d, notBefore: NOW - DAY - 1 })],
    ['an end before its start', (d) => ({ ...d, notBefore: d.notAfter })],
    ['another depth', (d) => ({ ...d, depth: 3 })],
  ];

  it.each(tampers)('is not signed, not sent and not run when the builder gives %s', async (_name, change) => {
    const w = subWorld();
    w.chain.tamper = change;
    let ran = false;
    const run = await go(w, async () => (ran = true));
    expect(run).toMatchObject({ ok: false, kind: 'not_ready', failure: { code: 'build_mismatch' }, end: { state: 'not_made' } });
    expect(w.chain.submitted).toHaveLength(0);
    expect(w.chain.log).not.toContain('buildUndelegate');
    expect(ran).toBe(false);
  });

  it('is built, signed, sent and run when the builder gives exactly what was asked for: the twin of every build above', async () => {
    const w = subWorld();
    expect(await go(w, idle)).toMatchObject({ ok: true, kind: 'returned', end: { state: 'ended' } });
    expect(w.chain.submitted[0]!.kind).toBe('delegate');
  });
});

describe('a request that is wrong is refused before anything is built', () => {
  const expectNothing = (w: SubWorld, run: SubDelegationRun<unknown>, code: string): void => {
    expect(run).toMatchObject({ ok: false, kind: 'not_ready', failure: { code }, end: { state: 'not_made' } });
    expect(w.chain.log).not.toContain('buildDelegate');
    expect(w.chain.submitted).toHaveLength(0);
  };

  it.each([
    ['a route that takes the agent only', { target: expectTarget(tokenTarget(BASES, 'run1', 'po.write')) }],
    ['a parent that is not a delegation identifier', { parent: 'abc' }],
    ['a subagent that is not a DID', { subagent: { did: 'did:vector:abc', signer: markSigner(SUBAGENT_KEY) } }],
    ['the same key for the agent and the subagent', { subagent: { did: `did:vector:${SUBAGENT_ID}`, signer: markSigner(AGENT_KEY) } }],
    ['a key hash that is not 56 hex characters', { agent: { signer: markSigner('11'.repeat(27)), walletAddress: WALLET } }],
    ['a signer without a sign function', { subagent: { did: `did:vector:${SUBAGENT_ID}`, signer: { keyHash: SUBAGENT_KEY } as never } }],
    ['no wallet address', { agent: { signer: markSigner(AGENT_KEY), walletAddress: '' } }],
    ['a validity that is too short', { validForMs: MIN_SUB_DELEGATION_MS - 1 }],
    ['a validity that is too long', { validForMs: MAX_SUB_DELEGATION_MS + 1 }],
    ['a validity that is not a whole number', { validForMs: 600_000.5 }],
    ['a validity that is a text', { validForMs: '3600000' as never }],
  ] as const)('refuses %s', async (_name, over) => {
    const w = subWorld({ request: over as never });
    expectNothing(w, await go(w, idle), 'bad_request');
  });

  it.each([
    ['a job time of 0', { jobTimeoutMs: 0 }],
    ['a job time that is not a number', { jobTimeoutMs: Number.NaN }],
    ['a poll time of 0', { pollMs: 0 }],
    ['a wait of 0', { confirmationWaitMs: 0 }],
    ['an end time that is not whole', { endTimeoutMs: 1.5 }],
    ['a job time over one day', { jobTimeoutMs: 86_400_001 }],
    ['a poll time over one day', { pollMs: 86_400_001 }],
    ['a wait over one day', { confirmationWaitMs: 86_400_001 }],
    ['a poll time that is null: a wrong type is an error, and not "no limit"', { pollMs: null as never }],
    ['a job time that is a text', { jobTimeoutMs: '600000' as never }],
  ] as const)('refuses %s', async (_name, over) => {
    const w = subWorld({ limits: over });
    expectNothing(w, await go(w, idle), 'bad_request');
  });

  it('accepts the shortest and the longest validity, and a job time of 1 millisecond', async () => {
    for (const validForMs of [MIN_SUB_DELEGATION_MS, MAX_SUB_DELEGATION_MS]) {
      const w = subWorld({ request: { validForMs }, parent: parentDatum({ notAfter: NOW + 5 * DAY }) });
      expect((await go(w, idle)).kind).toBe('returned');
    }
    const quick = subWorld({ limits: { jobTimeoutMs: 1 } });
    expect((await go(quick, async () => 'fast')).kind).toBe('returned');
    const longest = subWorld({ limits: { jobTimeoutMs: 86_400_000, confirmationWaitMs: 86_400_000, endTimeoutMs: 86_400_000, pollMs: 3_600_000 } });
    expect((await go(longest, idle)).kind).toBe('returned');
  });

  it('refuses a parent that is not live, a parent with no further hop, a parent that ends too soon, and a parent that cannot be read', async () => {
    const gone = subWorld({ parent: null });
    expectNothing(gone, await go(gone, idle), 'parent_not_live');
    const spent = subWorld({ parent: parentDatum({ remaining: 0 }) });
    expectNothing(spent, await go(spent, idle), 'parent_exhausted');
    const ending = subWorld({ parent: parentDatum({ notAfter: NOW + MIN_SUB_DELEGATION_MS - 1 }) });
    expectNothing(ending, await go(ending, idle), 'parent_expiring');
    const unreadable = subWorld();
    unreadable.chain.faults.readThrows = true;
    expectNothing(unreadable, await go(unreadable, idle), 'parent_unreadable');
    const enough = subWorld({ parent: parentDatum({ notAfter: NOW + MIN_SUB_DELEGATION_MS }) });
    expect((await go(enough, idle)).kind).toBe('returned');
  });

  it('refuses a parent that has not started, until its start leaves enough time', async () => {
    const early = subWorld({ parent: parentDatum({ notBefore: NOW + 60_000, notAfter: NOW + 60_000 + MIN_SUB_DELEGATION_MS - 1 }) });
    expectNothing(early, await go(early, idle), 'parent_expiring');
  });

  it('reports a builder that refuses with its words, and sends nothing; the twin is the run in which the builder accepts', async () => {
    const w = subWorld();
    w.chain.faults.buildDelegateThrows = true;
    const run = await go(w, idle);
    expect(run).toMatchObject({ ok: false, kind: 'not_ready', failure: { code: 'build_refused' }, end: { state: 'not_made' } });
    expect(run.kind === 'not_ready' && run.failure.detail).toContain('allows no further hop');
    expect(w.chain.submitted).toHaveLength(0);
    expect(w.chain.log).not.toContain('buildUndelegate');
    w.chain.faults.buildDelegateThrows = false;
    expect((await go(w, idle)).kind).toBe('returned');
  });
});

describe('the keys', () => {
  it('sign the Delegate with the agent key and the subagent key, and each one time', async () => {
    const w = subWorld();
    await go(w, idle);
    expect(w.chain.submitted[0]!.cbor).toBe(`delegate:${w.chain.subId}+${AGENT_KEY.slice(0, 4)}+${SUBAGENT_KEY.slice(0, 4)}`);
  });

  it('refuse a Delegate that needs a key that was not given, before it is sent; and sign it when the key is given', async () => {
    const w = subWorld();
    w.chain.faults.extraSigner = OTHER_KEY;
    const run = await go(w, idle);
    expect(run).toMatchObject({ ok: false, kind: 'not_ready', failure: { code: 'missing_signer' }, end: { state: 'not_made' } });
    expect(run.kind === 'not_ready' && run.failure.detail).toContain(OTHER_KEY);
    expect(w.chain.submitted).toHaveLength(0);
  });

  it('give a signer that throws a result with its name and without its message', async () => {
    const secret = 'SEED-0123456789-abcdef';
    const w = subWorld({ request: { subagent: { did: `did:vector:${SUBAGENT_ID}`, signer: { keyHash: SUBAGENT_KEY, sign: () => { throw new Error(`cannot sign with ${secret}`); } } } } });
    const run = await go(w, idle);
    expect(run).toMatchObject({ ok: false, kind: 'not_ready', failure: { code: 'sign_failed' }, end: { state: 'not_made' } });
    expect(JSON.stringify(run)).not.toContain(secret);
    expect(w.chain.submitted).toHaveLength(0);
  });
});

describe('the end of a run that cannot be sent', () => {
  it('leaves nothing to end when the Delegate was never sent: the end is not_made and the ledger is not asked to undelegate', async () => {
    const w = subWorld();
    w.chain.faults.buildDelegateThrows = true;
    const run = await go(w, idle);
    expect(run.end).toStrictEqual({ state: 'not_made' });
    expect(w.chain.log).not.toContain('buildUndelegate');
  });

  it('does not wait with no end when every part of the world is unreadable', async () => {
    const w = subWorld({ limits: { confirmationWaitMs: 20_000, endTimeoutMs: 20_000 } });
    w.chain.faults.readThrows = false;
    w.chain.faults.readinessHangs = true;
    w.chain.faults.undelegateNeverLands = true;
    const run = await go(w, idle);
    expect(run.kind).toBe('not_ready');
    expect(run.end.state).toBe('not_ended');
  });
});

describe('the reference that is given before the Delegate is sent', () => {
  it('is given to the hook before the node gets the Delegate, and it is the reference that a failed end returns', async () => {
    const w = subWorld();
    const seen: { reference: LeftSubDelegation; logBefore: string[] }[] = [];
    const deps = { ...w.deps, beforeSend: (reference: LeftSubDelegation): void => void seen.push({ reference, logBefore: [...w.chain.log] }) };
    w.chain.faults.buildUndelegateThrows = true;
    const run = await w.clock.run(withSubDelegation(deps, w.request, w.limits, idle));
    expect(seen).toHaveLength(1);
    expect(seen[0]!.logBefore).toContain('buildDelegate');
    expect(seen[0]!.logBefore).not.toContain('submit:delegate');
    expect(seen[0]!.reference).toMatchObject({ id: w.chain.subId, parent: PARENT_ID, action: 'erp.stock.read', resource: w.target.resource, endTxHash: null });
    expect(run.end.state === 'not_ended' && run.end.left).toStrictEqual(seen[0]!.reference);
  });

  it('is awaited before the send when the hook is asynchronous', async () => {
    const w = subWorld();
    const order: string[] = [];
    const deps = {
      ...w.deps,
      beforeSend: async (): Promise<void> => {
        await w.clock.sleep(1_000);
        order.push(`hook after ${w.chain.log.includes('submit:delegate') ? 'send' : 'build'}`);
      },
    };
    expect((await w.clock.run(withSubDelegation(deps, w.request, w.limits, idle))).kind).toBe('returned');
    expect(order).toStrictEqual(['hook after build']);
  });

  it('stops the run when the hook throws: nothing is sent and nothing is ended; the twin is the run with a hook that works', async () => {
    const w = subWorld();
    const failing = { ...w.deps, beforeSend: (): void => { throw new Error('the store is full'); } };
    const run = await w.clock.run(withSubDelegation(failing, w.request, w.limits, idle));
    expect(run).toMatchObject({ ok: false, kind: 'not_ready', failure: { code: 'journal_failed' }, end: { state: 'not_made' } });
    expect(run.kind === 'not_ready' && run.failure.detail).toContain('the store is full');
    expect(w.chain.submitted).toHaveLength(0);
    const rejecting = { ...w.deps, beforeSend: async (): Promise<void> => Promise.reject(new Error('disk')) };
    expect(await w.clock.run(withSubDelegation(rejecting, w.request, w.limits, idle))).toMatchObject({ ok: false, failure: { code: 'journal_failed' } });
    const working = { ...w.deps, beforeSend: (): void => undefined };
    expect((await w.clock.run(withSubDelegation(working, w.request, w.limits, idle))).kind).toBe('returned');
  });

  it('is not given when there is nothing to name: a wrong request, a parent that is not live, and a build that the builder refuses', async () => {
    let calls = 0;
    const count = (w: SubWorld) => ({ ...w.deps, beforeSend: (): void => void (calls += 1) });
    const wrong = subWorld({ limits: { jobTimeoutMs: 0 } });
    await wrong.clock.run(withSubDelegation(count(wrong), wrong.request, wrong.limits, idle));
    const gone = subWorld({ parent: null });
    await gone.clock.run(withSubDelegation(count(gone), gone.request, gone.limits, idle));
    const refused = subWorld();
    refused.chain.faults.buildDelegateThrows = true;
    await refused.clock.run(withSubDelegation(count(refused), refused.request, refused.limits, idle));
    expect(calls).toBe(0);
  });
});

describe('a wait that could have no end', () => {
  /** A clock that stands still: the poll sleep ends at once, and the long sleeps of the bounds never end. */
  const frozen = { now: (): number => NOW, sleep: (ms: number): Promise<void> => (ms === 5_000 ? Promise.resolve() : new Promise<void>(() => undefined)) };

  it('is cut by the number of reads when the clock does not move: the wait and the end step both end', async () => {
    const w = subWorld({ limits: { confirmationWaitMs: 60_000, endTimeoutMs: 120_000, pollMs: 5_000 } });
    const run = await withSubDelegation({ chain: w.chain, clock: frozen }, w.request, w.limits, idle);
    expect(run).toMatchObject({ ok: false, kind: 'not_ready', failure: { code: 'confirmation_timeout' }, end: { state: 'not_ended', code: 'end_unconfirmed' } });
    expect(w.chain.log.filter((step) => step === 'readiness')).toHaveLength(Math.ceil(60_000 / 5_000) + 1);
    expect(w.chain.log.filter((step) => step === 'buildUndelegate')).toHaveLength(Math.ceil(120_000 / 5_000) + 1);
  });
});

describe('an end that is not seen', () => {
  it('is not claimed: a ledger that cannot be read after the Undelegate gives end_unconfirmed, and a ledger that can be read gives ended', async () => {
    const w = subWorld({ limits: { endTimeoutMs: 40_000 } });
    const read = w.chain.readDelegation.bind(w.chain);
    w.chain.readDelegation = async (id) => {
      if (w.chain.submitted.some((s) => s.kind === 'undelegate')) throw new Error('the ledger cannot be read');
      return read(id);
    };
    expect((await go(w, idle)).end).toMatchObject({ state: 'not_ended', code: 'end_unconfirmed', left: { endTxHash: expect.any(String) } });
    expect((await go(subWorld({ limits: { endTimeoutMs: 40_000 } }), idle)).end.state).toBe('ended');
  });

  it('is refused when the Undelegate is for another delegation: nothing is sent for it', async () => {
    const w = subWorld();
    const build = w.chain.buildUndelegate.bind(w.chain);
    w.chain.buildUndelegate = async (params) => ({ ...(await build(params)), id: 'ee'.repeat(32) });
    const run = await go(w, idle);
    expect(run.end).toMatchObject({ state: 'not_ended', code: 'end_failed' });
    expect(run.end.state === 'not_ended' && run.end.detail).toContain('another delegation');
    expect(w.chain.submitted.map((s) => s.kind)).toStrictEqual(['delegate']);
  });
});

describe('a route that cannot be a sub-delegation', () => {
  it('is refused when its action is a pattern, or its resource is not an https URL, and a route that is right is accepted', async () => {
    const base = subWorld();
    for (const target of [{ ...base.target, action: 'erp.*' }, { ...base.target, resource: 'http://mock.example/t/run1/erp' }, { ...base.target, resource: 'https://mock.example/t/run1/erp ' }]) {
      const w = subWorld({ request: { target } });
      expect(await go(w, idle), target.action + target.resource).toMatchObject({ ok: false, kind: 'not_ready', failure: { code: 'bad_request' }, end: { state: 'not_made' } });
      expect(w.chain.log).not.toContain('buildDelegate');
    }
    expect((await go(subWorld(), idle)).kind).toBe('returned');
  });

  it('is refused when a signer is not an object', async () => {
    const w = subWorld({ request: { agent: { signer: null as never, walletAddress: WALLET } } });
    expect(await go(w, idle)).toMatchObject({ ok: false, failure: { code: 'bad_request' }, end: { state: 'not_made' } });
  });
});

describe('a build that has no delegation identifier', () => {
  it('is not signed and not sent; the twin is the build with an identifier', async () => {
    const w = subWorld();
    const build = w.chain.buildDelegate.bind(w.chain);
    w.chain.buildDelegate = async (params) => ({ ...(await build(params)), id: 'not-an-identifier' });
    expect(await go(w, idle)).toMatchObject({ ok: false, kind: 'not_ready', failure: { code: 'build_mismatch' }, end: { state: 'not_made' } });
    expect(w.chain.submitted).toHaveLength(0);
    expect((await go(subWorld(), idle)).kind).toBe('returned');
  });
});

describe('a sub-delegation is made only for a route that the table gives to a subagent', () => {
  const po = expectTarget(tokenTarget(BASES, 'run1', 'po.write'));
  const erp = erpTarget();
  const refusedTargets: [string, Record<string, unknown>][] = [
    ['a write route with the callers of a read route', { ...po, callers: 'agent-or-subagent' }],
    ['a write route with the callers and the action of a read route', { ...po, callers: 'agent-or-subagent', action: 'erp.stock.read' }],
    ['a read route with the action of a write route', { ...erp, action: 'po.write' }],
    ['an action pattern', { ...erp, action: 'erp.*' }],
    ['an external action', { ...erp, action: 'https://evil.test/anything' }],
    ['the hire action on a script', { ...erp, action: 'marketplace.hire.v1', resource: `script:${'ab'.repeat(28)}` }],
    ['a route that the table does not have', { ...erp, route: 'erp.everything' }],
    ['a route that is a property of every object', { ...erp, route: 'constructor' }],
    ['no route', { ...erp, route: undefined }],
    ['a route that gives an SVID', { ...expectTarget(x509Target(BASES, 'run1', 'supplier.catalogue', { sku: 'X' })) }],
    ['the system of another route', { ...erp, system: 'po' }],
    ['callers that say agent', { ...erp, callers: 'agent' }],
    ['a credential that is not a token', { ...erp, credential: 'jwt-svid' }],
    ['a resource of another system', { ...erp, resource: 'https://mock.example/t/run1/po' }],
    ['a resource with a path below the system', { ...erp, resource: 'https://mock.example/t/run1/erp/stock' }],
    ['a star resource', { ...erp, resource: '*' }],
    ['a resource on a script', { ...erp, resource: `script:${'ab'.repeat(28)}` }],
    ['an http resource', { ...erp, resource: 'http://mock.example/t/run1/erp' }],
    ['a resource that is not in its canonical form', { ...erp, resource: 'https://MOCK.example/t/run1/erp' }],
    ['a resource with a dot segment', { ...erp, resource: 'https://mock.example/t/run1/../run2/erp' }],
    ['a resource with a closing slash', { ...erp, resource: 'https://mock.example/t/run1/erp/' }],
    ['a resource with a query', { ...erp, resource: 'https://mock.example/t/run1/erp?x=1' }],
    ['a resource with an empty query', { ...erp, resource: 'https://mock.example/t/run1/erp?' }],
    ['a resource with a fragment', { ...erp, resource: 'https://mock.example/t/run1/erp#x' }],
    ['a resource with a user part', { ...erp, resource: 'https://user@mock.example/t/run1/erp' }],
    ['a resource with no tenant prefix', { ...erp, resource: 'https://mock.example/run1/erp' }],
    ['a resource with a tenant that is not a tenant', { ...erp, resource: 'https://mock.example/t/-bad/erp' }],
    ['a resource that is not text', { ...erp, resource: 5 }],
    ['a resource that is not a URL', { ...erp, resource: 'not a url' }],
  ];

  it.each(refusedTargets)('is refused for %s: bad_request, and nothing is built', async (_name, target) => {
    const w = subWorld({ request: { target: target as never } });
    expect(await go(w, idle)).toMatchObject({ ok: false, kind: 'not_ready', failure: { code: 'bad_request' }, end: { state: 'not_made' } });
    expect(w.chain.log).not.toContain('buildDelegate');
    expect(w.chain.submitted).toHaveLength(0);
  });

  it('is not made for a target that is not an object', async () => {
    for (const target of [null, undefined, 'erp.stock']) {
      const w = subWorld({ request: { target: target as never } });
      expect(await go(w, idle)).toMatchObject({ ok: false, failure: { code: 'bad_request' }, end: { state: 'not_made' } });
    }
  });

  const subagentRoutes: [string, string, Record<string, string>][] = [
    ['erp.stock', 'erp.stock.read', { sku: 'GLV-NIT-M' }],
    ['records.order', 'record.read', { order_id: 'ORD-1001' }],
    ['guidelines.read', 'guideline.read', { code: 'SYN-MRI-LS' }],
    ['vendors.list', 'vendor.read', {}],
  ];
  it.each(subagentRoutes)('is made for the route %s, with the action of the table and the resource of its system, on another host and another tenant: the twin of every target above', async (route, action, params) => {
    const target = expectTarget(tokenTarget({ publicBase: 'https://other.example:8443', mtlsBase: 'https://other-mtls.example' }, 'tenant-2', route as never, params));
    const w = subWorld({ request: { target } });
    expect(await go(w, idle)).toMatchObject({ ok: true, kind: 'returned', end: { state: 'ended' } });
    expect(w.chain.params).toHaveLength(1);
    expect(w.chain.params[0]).toMatchObject({ actions: [action], resources: [`https://other.example:8443/t/tenant-2/${target.system}`] });
  });

  it('has a twin for every route that the table gives to a subagent', () => {
    const listed = Object.entries(ROUTES).filter(([, spec]) => spec.credential === 'token' && spec.callers === 'agent-or-subagent').map(([name]) => name);
    expect(listed.sort()).toStrictEqual(subagentRoutes.map(([name]) => name).sort());
  });
});

describe('every wait on a port has a bound', () => {
  const never = (): Promise<never> => new Promise<never>(() => undefined);
  const STEP = 30_000;
  const withStep = (over: Partial<SubWorld['limits']> = {}) => subWorld({ limits: { stepTimeoutMs: STEP, endTimeoutMs: 40_000, ...over } });
  const expectStopped = (w: SubWorld, run: SubDelegationRun<unknown>, started: number): void => {
    expect(run).toMatchObject({ ok: false, kind: 'not_ready', failure: { code: 'step_timeout' }, end: { state: 'not_made' } });
    expect(w.clock.now() - started).toBe(STEP);
    expect(w.chain.submitted).toHaveLength(0);
  };

  it('ends a read of the parent that never answers at the bound, with nothing sent and nothing to end', async () => {
    const w = withStep();
    const read = w.chain.readDelegation.bind(w.chain);
    w.chain.readDelegation = (id) => (id === PARENT_ID ? never() : read(id));
    const started = w.clock.now();
    const run = await go(w, idle);
    expectStopped(w, run, started);
    expect(run.kind === 'not_ready' && run.failure.detail).toContain('the read of the parent delegation did not answer within 30000 ms');
    expect(w.chain.log).not.toContain('buildDelegate');
  });

  it('ends a build that never answers at the bound, with nothing sent and nothing to end', async () => {
    const w = withStep();
    w.chain.buildDelegate = never;
    const started = w.clock.now();
    expectStopped(w, await go(w, idle), started);
  });

  it('ends a hook that never answers at the bound, with nothing sent and nothing to end', async () => {
    const w = withStep();
    const started = w.clock.now();
    const run = await w.clock.run(withSubDelegation({ ...w.deps, beforeSend: never }, w.request, w.limits, idle));
    expectStopped(w, run, started);
  });

  it('ends a send that the node took and never answered at the bound, and then ends the sub-delegation as for a Delegate that landed: the probe of the review', async () => {
    const w = withStep();
    const submit = w.chain.submit.bind(w.chain);
    let first = true;
    w.chain.submit = async (cbor) => {
      if (!first) return submit(cbor);
      first = false;
      await submit(cbor);
      return never();
    };
    const journal: LeftSubDelegation[] = [];
    const started = w.clock.now();
    const run = await w.clock.run(withSubDelegation({ ...w.deps, beforeSend: (reference) => void journal.push(reference) }, w.request, w.limits, idle));
    expect(run).toMatchObject({ ok: false, kind: 'not_ready', failure: { code: 'step_timeout' }, end: { state: 'ended' } });
    expect(run.kind === 'not_ready' && run.failure.detail).toContain('after the Delegate was sent to it');
    expect(w.chain.submitted.map((s) => s.kind)).toStrictEqual(['delegate', 'undelegate']);
    expect(await w.chain.readDelegation(w.chain.subId!)).toBeNull();
    expect(journal).toHaveLength(1);
    expect(w.clock.now() - started).toBeGreaterThanOrEqual(STEP);
  });

  it('ends a send that never reached the node at the bound, and reports the reference that is left when the Delegate never lands', async () => {
    const w = withStep();
    w.chain.submit = never;
    const run = await go(w, idle);
    expect(run).toMatchObject({ ok: false, kind: 'not_ready', failure: { code: 'step_timeout' }, end: { state: 'not_ended', code: 'end_unconfirmed', left: { id: expect.any(String), endTxHash: null } } });
    expect(w.chain.submitted).toHaveLength(0);
  });

  it('has the default bound of DEFAULT_STEP_TIMEOUT_MS for a port that never answers', async () => {
    const w = subWorld();
    w.chain.buildDelegate = never;
    const started = w.clock.now();
    expect(await go(w, idle)).toMatchObject({ failure: { code: 'step_timeout' } });
    expect(w.clock.now() - started).toBe(DEFAULT_STEP_TIMEOUT_MS);
  });

  it.each([
    ['the read of the parent', (w: SubWorld, ms: number) => {
      const read = w.chain.readDelegation.bind(w.chain);
      w.chain.readDelegation = async (id) => (id === PARENT_ID ? (await w.clock.sleep(ms), read(id)) : read(id));
    }],
    ['the build', (w: SubWorld, ms: number) => {
      const build = w.chain.buildDelegate.bind(w.chain);
      w.chain.buildDelegate = async (params) => (await w.clock.sleep(ms), build(params));
    }],
    ['the send', (w: SubWorld, ms: number) => {
      const submit = w.chain.submit.bind(w.chain);
      w.chain.submit = async (cbor) => (await w.clock.sleep(ms), submit(cbor));
    }],
  ])('waits for %s that answers a millisecond before its bound, and gives up for one that answers at the bound: the twin', async (_name, slow) => {
    for (const [ms, code] of [[STEP - 1, null], [STEP, 'step_timeout']] as const) {
      const w = withStep();
      slow(w, ms);
      const run = await go(w, idle);
      expect(run.kind === 'not_ready' ? run.failure.code : null, `${ms}`).toBe(code);
    }
  });

  it('waits for a hook that answers a millisecond before its bound', async () => {
    const w = withStep();
    const run = await w.clock.run(withSubDelegation({ ...w.deps, beforeSend: () => w.clock.sleep(STEP - 1) }, w.request, w.limits, idle));
    expect(run).toMatchObject({ ok: true, kind: 'returned', end: { state: 'ended' } });
  });

  it.each([[0], [1.5], [Number.NaN], [86_400_001], ['5000'], [null]])('refuses the step bound %j before anything is built', async (stepTimeoutMs) => {
    const w = subWorld({ limits: { stepTimeoutMs: stepTimeoutMs as never } });
    expect(await go(w, idle)).toMatchObject({ ok: false, failure: { code: 'bad_request' }, end: { state: 'not_made' } });
    expect(w.chain.log).not.toContain('buildDelegate');
  });
});
