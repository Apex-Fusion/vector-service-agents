// agents/prior-authorization-agent/test/evidence/order.test.ts: the two reads of the evidence, one after the other. The review questions: is a sub-delegation ever left alive, can the agent read a record or a
// guideline with its own token, can the id of the second Delegate equal the id of the first, and is a refused or failed call ever read as a success? The record reader runs first. The drafter runs second, with
// the service code of the order that the first read gave. Each sub-delegation ends before the next one starts: the second Delegate is built only when the first sub-delegation is ended or was never made, so no
// more than one sub-delegation of a job is alive. A failed first read ends the evidence and the second sub-delegation is never made. A first read whose sub-delegation does not end stops the evidence too, and its
// entry stays for the janitor. A failed second read gives its code and none of the first evidence, and both sub-delegations are ended. Each failure has its twin.
import type { GatewayResult, IssuedToken } from '@vsa/id-kit/client';
import { MemoryLeftStore } from '@vsa/usecase-kit/janitor';
import { accepted } from '@vsa/usecase-kit/protocol';
import { describe, expect, it } from 'vitest';
import { EVIDENCE_FAILURES } from '../../src/evidence/subread.ts';
import {
  DEADLINE_MS, DRAFTER_DID, GUIDELINES_RESOURCE, KINDS, KNEE_GUIDELINE, KNEE_RECORD_SET, NOW, ORDER_ID, PARENT_ID, READS, RECORDS_RESOURCE, RECORD_READER_DID, GUIDELINE, RECORD_SET, actionOf, expectFailed,
  AGENT_KEY, expectNoSecrets, expectRecordedAndEnded, expectUntouched, failureLine, gatewayRefused, issued, janitorOnce, janitorPass, json, opsOf, runEvidence, showing, startEvidence, systemAnswer, world,
} from './support.ts';
import type { RunOptions, World } from './support.ts';

const RECORDS = READS[0]!;
const GUIDELINES = READS[1]!;
const BOTH = { ok: true, record_set: RECORD_SET, guideline: GUIDELINE };

/** The evidence of the order ORD-1002, whose service has another code. */
const KNEE = { ok: true, record_set: KNEE_RECORD_SET, guideline: KNEE_GUIDELINE };

/** Sets the script so that the gateway answers `answer` for the token of this action and the golden token for the other. */
function answerFor(w: World, action: string, answer: () => Promise<GatewayResult<IssuedToken>>): void {
  w.script.requestToken = async (request) => (actionOf(request) === action ? answer() : issued(request, w.clock.now()));
}

/** The times at which the builder is asked for a Delegate, and the state of the ledger at each of them: the transactions that were sent, and whether the first sub-delegation is gone. */
function watchBuilds(w: World): { kinds: string[]; firstGone: boolean | null; at: number }[] {
  const seen: { kinds: string[]; firstGone: boolean | null; at: number }[] = [];
  const build = w.chain.buildDelegate.bind(w.chain);
  w.chain.buildDelegate = async (params) => {
    const first = w.chain.builtDelegates[0];
    seen.push({ kinds: w.chain.submitted.map((sent) => sent.kind), firstGone: first === undefined ? null : (await w.chain.readDelegation(first.id)) === null, at: w.clock.now() });
    return build(params);
  };
  return seen;
}

describe('both reads', () => {
  it('give the record set and the guideline of the golden order, from one call each, in the order of the reads', async () => {
    const w = world();
    expect(await runEvidence(w)).toStrictEqual(BOTH);
    expect(w.fetched.map((call) => call.url)).toStrictEqual([RECORDS.url, GUIDELINES.url]);
    expect(w.tokenRequests.map(actionOf)).toStrictEqual(['record.read', 'guideline.read']);
    expect(w.logs).toStrictEqual([]);
    await expectRecordedAndEnded(w, 2);
  });

  it('build the second Delegate only after the first sub-delegation ended, so that no more than one sub-delegation of the job is alive and the id of the first is out of use', async () => {
    const w = world();
    const seen = watchBuilds(w);
    await runEvidence(w);
    expect(seen.map(({ kinds, firstGone }) => ({ kinds, firstGone }))).toStrictEqual([
      { kinds: [], firstGone: null },
      { kinds: KINDS(1), firstGone: true },
    ]);
    expect(opsOf(w)).toStrictEqual(['add', 'put', 'remove', 'delete', 'add', 'put', 'remove', 'delete']);
    const [first, second] = w.chain.builtDelegates;
    expect(second!.id).not.toBe(first!.id);
    expect(w.chain.submitted.map((sent) => sent.kind)).toStrictEqual(KINDS(2));
    const [delegate, undelegate, delegateAgain] = w.chain.submitted;
    expect(delegateAgain!.at - undelegate!.at).toBeGreaterThanOrEqual(8_000);
    expect(undelegate!.at).toBeGreaterThan(delegate!.at);
  });

  it('give each sub-delegation a validity of its own that starts with its read: the wait of 360,000 ms, the job of 240,000 ms and 300,000 ms more', async () => {
    const w = world();
    const seen = watchBuilds(w);
    await runEvidence(w);
    const [first, second] = w.chain.builtDelegates;
    expect(first!.delegation.notAfter - seen[0]!.at).toBe(900_000);
    expect(second!.delegation.notAfter - seen[1]!.at).toBe(900_000);
    expect(seen[1]!.at).toBeGreaterThan(seen[0]!.at);
  });

  it('hold the id of each read in the set of the sub-delegations in use only while the read runs: at the token request of the second read the first id is out and the second id is in', async () => {
    const w = world();
    await runEvidence(w);
    const [first, second] = w.chain.builtDelegates;
    expect(w.janitorSeen).toStrictEqual([
      { skipped: [first!.id], taken: [] },
      { skipped: [second!.id], taken: [] },
    ]);
    expect(w.live.size).toBe(0);
  });

  it('ask the gateway twice, and never as the agent: each token is for the subagent of its read, under the sub-delegation of its read, and no request names the delegation of the hirer', async () => {
    const w = world();
    await runEvidence(w);
    expect(w.tokenRequests).toHaveLength(2);
    const [first, second] = w.chain.builtDelegates;
    expect(w.tokenRequests.map((asked) => asked.subject.did)).toStrictEqual([RECORD_READER_DID, DRAFTER_DID]);
    expect(w.tokenRequests.map((asked) => asked.delegation)).toStrictEqual([
      { identifier: first!.id, actions: ['record.read'], locations: [RECORDS_RESOURCE] },
      { identifier: second!.id, actions: ['guideline.read'], locations: [GUIDELINES_RESOURCE] },
    ]);
    for (const asked of w.tokenRequests) expect(asked.delegation!.identifier).not.toBe(PARENT_ID);
    expect(w.fetched).toHaveLength(2);
  });

  it('read the guideline of the service code of the order that the first read gave: a second order has another route', async () => {
    const w = world();
    expect(await runEvidence(w, { request: { order_id: 'ORD-1002' } })).toStrictEqual(KNEE);
    expect(w.fetched.map((call) => call.url)).toStrictEqual([`${RECORDS_RESOURCE}/orders/ORD-1002`, `${GUIDELINES_RESOURCE}/SYN-MRI-KN`]);
    expect(w.tokenRequests[1]!.delegation).toMatchObject({ actions: ['guideline.read'], locations: [GUIDELINES_RESOURCE] });
    const golden = world();
    expect(await runEvidence(golden)).toStrictEqual(BOTH);
    expect(golden.fetched.map((call) => call.url)).toStrictEqual([`${RECORDS_RESOURCE}/orders/${ORDER_ID}`, `${GUIDELINES_RESOURCE}/SYN-MRI-LS`]);
  });

  it('take the service code from the record set that the parser checked, and not from the body of the system', async () => {
    const w = world();
    const parse = w.script.parseRecordSet;
    w.script.parseRecordSet = (body) => {
      const checked = parse(body);
      return checked.ok ? accepted({ ...checked.value, order: { ...checked.value.order, service_code: 'SYN-MRI-KN' } }) : checked;
    };
    const result = await runEvidence(w);
    expect(w.fetched.map((call) => call.url)).toStrictEqual([RECORDS.url, `${GUIDELINES_RESOURCE}/SYN-MRI-KN`]);
    expect(result).toMatchObject({ ok: true, guideline: KNEE_GUIDELINE });
  });

  it('leave the list of left sub-delegations and the set in use empty after two good runs, with four ids that no run shared', async () => {
    const w = world();
    expect(await runEvidence(w)).toStrictEqual(BOTH);
    expect(await runEvidence(w)).toStrictEqual(BOTH);
    expect(w.sink.entries.size).toBe(0);
    expect(w.live.size).toBe(0);
    expect(w.chain.submitted.map((sent) => sent.kind)).toStrictEqual(KINDS(4));
    expect(new Set(w.chain.builtDelegates.map((built) => built.id)).size).toBe(4);
    expect(opsOf(w)).toStrictEqual(Array.from({ length: 4 }, () => ['add', 'put', 'remove', 'delete']).flat());
    expect(w.logs).toStrictEqual([]);
  });
});

describe('a first read that fails', () => {
  interface Case {
    readonly name: string;
    readonly setup: (w: World) => void;
    readonly over?: RunOptions;
    readonly code: string;
    /** True when the Delegate of the first read was sent. */
    readonly sent: boolean;
  }
  const CASES: Case[] = [
    { name: 'the records system does not know the order', setup: () => undefined, over: { request: { order_id: 'ORD-9999' } }, code: 'order_not_found', sent: true },
    { name: 'the gateway refuses the token', setup: (w) => void (w.script.requestToken = async () => gatewayRefused(403, 'access_denied', 'words that the gateway wrote')), code: 'token_gateway_refused', sent: true },
    { name: 'the records system refuses the call', setup: (w) => void (w.script.fetch = async () => json({ error: 'not_covered', message: 'words that the system wrote' }, 403)), code: 'not_covered', sent: true },
    { name: 'the records system fails', setup: (w) => void (w.script.fetch = async () => json(RECORDS.body, 500)), code: 'mock_system_failed', sent: true },
    { name: 'the body is not a record set', setup: (w) => void (w.script.fetch = async () => json(RECORDS.wrong)), code: 'record_set_invalid', sent: true },
    { name: 'the job of the record reader runs out of time', setup: (w) => void (w.script.requestToken = () => new Promise(() => undefined)), code: 'record_read_timeout', sent: true },
    { name: 'the 30 confirmations do not come', setup: (w) => void (w.chain.faults.neverConfirm = true), code: 'sub_delegation_confirmation_timeout', sent: true },
    { name: 'the parent delegation is not live', setup: (w) => void (w.chain.parent = null), code: 'sub_delegation_parent_not_live', sent: false },
  ];
  it.each(CASES)('gives its code and never makes the second sub-delegation when $name', async ({ setup, over, code, sent }) => {
    const w = world();
    setup(w);
    const result = await runEvidence(w, over);
    expectFailed(result, code);
    expect(EVIDENCE_FAILURES).toContain(code);
    expect(w.chain.builtDelegates).toHaveLength(sent ? 1 : 0);
    expect(w.tokenRequests.map(actionOf)).not.toContain('guideline.read');
    expect(w.fetched.filter((call) => call.url.includes('/guidelines/'))).toStrictEqual([]);
    if (sent) await expectRecordedAndEnded(w, 1);
    else {
      expect(w.chain.submitted).toStrictEqual([]);
      expect(w.steps).toStrictEqual([]);
    }
    expect(w.logs).toStrictEqual([failureLine(RECORDS, code)]);
    expectNoSecrets(w, result);
  });

  it('is the same job that gives both documents when nothing fails: the twin', async () => {
    const w = world();
    expect(await runEvidence(w, { request: { order_id: ORDER_ID } })).toStrictEqual(BOTH);
    expect(w.chain.builtDelegates).toHaveLength(2);
  });

  it.each([
    ['an order id with a slash', { request: { order_id: 'a/b' } }],
    ['an empty order id', { request: { order_id: '' } }],
    ['a tenant that no route takes', { request: { tenant: '-run' } }],
  ] as const)('gives internal and sends nothing when the request has %s', async (_name, over) => {
    const w = world();
    expectFailed(await runEvidence(w, over), 'internal');
    expectUntouched(w);
    expect(w.logs).toStrictEqual([failureLine(RECORDS, 'internal')]);
  });

  it('gives record_set_invalid and makes no second sub-delegation when the parser accepts a value that has no order with a service code', async () => {
    for (const value of [null, {}, { order: null }, { order: {} }, { order: { service_code: 7 } }]) {
      const w = world();
      w.script.parseRecordSet = () => accepted(value as never);
      expectFailed(await runEvidence(w), 'record_set_invalid');
      expect(w.chain.builtDelegates).toHaveLength(1);
      expect(w.tokenRequests).toHaveLength(1);
      await expectRecordedAndEnded(w, 1);
      expect(w.logs).toStrictEqual([failureLine(RECORDS, 'record_set_invalid')]);
    }
  });

  it('gives internal and makes no second sub-delegation when the service code makes no route', async () => {
    const w = world();
    const parse = w.script.parseRecordSet;
    w.script.parseRecordSet = (body) => {
      const checked = parse(body);
      return checked.ok ? accepted({ ...checked.value, order: { ...checked.value.order, service_code: 'a/b' } }) : checked;
    };
    expectFailed(await runEvidence(w), 'internal');
    expect(w.chain.builtDelegates).toHaveLength(1);
    expect(w.tokenRequests).toHaveLength(1);
    await expectRecordedAndEnded(w, 1);
    expect(w.logs).toStrictEqual([failureLine(GUIDELINES, 'internal')]);
  });
});

describe('a second read that fails', () => {
  interface Case {
    readonly name: string;
    readonly setup: (w: World) => void;
    readonly code: string;
  }
  const guidelinesOnly = (w: World, answer: (url: string) => Promise<Response>): void => {
    w.script.fetch = async (url) => (url.includes('/guidelines/') ? answer(url) : systemAnswer(url));
  };
  const CASES: Case[] = [
    { name: 'the guideline store has no guideline for the code', setup: (w) => guidelinesOnly(w, async () => json({ error: 'guideline_not_found', message: 'words that the system wrote' }, 404)), code: 'guideline_not_found' },
    { name: 'the gateway refuses the token of the drafter', setup: (w) => answerFor(w, 'guideline.read', async () => gatewayRefused(403, 'access_denied', 'words that the gateway wrote')), code: 'token_gateway_refused' },
    { name: 'the guideline store refuses the call', setup: (w) => guidelinesOnly(w, async () => json({ error: 'not_covered', message: 'words that the system wrote' }, 403)), code: 'not_covered' },
    { name: 'the guideline store fails', setup: (w) => guidelinesOnly(w, async () => json(GUIDELINES.body, 500)), code: 'mock_system_failed' },
    { name: 'the body is not a guideline', setup: (w) => guidelinesOnly(w, async () => json(GUIDELINES.wrong)), code: 'guideline_invalid' },
    { name: 'the job of the drafter runs out of time', setup: (w) => answerFor(w, 'guideline.read', () => new Promise(() => undefined)), code: 'guideline_read_timeout' },
    {
      name: 'the 30 confirmations of the second sub-delegation do not come',
      setup: (w) => {
        const build = w.chain.buildDelegate.bind(w.chain);
        w.chain.buildDelegate = async (params) => {
          if (w.chain.builtDelegates.length === 1) w.chain.faults.neverConfirm = true;
          return build(params);
        };
      },
      code: 'sub_delegation_confirmation_timeout',
    },
  ];
  it.each(CASES)('gives its code and none of the first evidence, and ends both sub-delegations, when $name', async ({ setup, code }) => {
    const w = world();
    setup(w);
    const result = await runEvidence(w);
    expectFailed(result, code);
    expect(result).not.toHaveProperty('record_set');
    expect(EVIDENCE_FAILURES).toContain(code);
    expect(w.fetched[0]!.url).toBe(RECORDS.url);
    await expectRecordedAndEnded(w, 2);
    expect(w.logs).toStrictEqual([failureLine(GUIDELINES, code)]);
    expectNoSecrets(w, result);
  });

  it('leaves the entry of the second sub-delegation for the janitor when its end does not land, and still gives the evidence', async () => {
    const w = world();
    const build = w.chain.buildDelegate.bind(w.chain);
    w.chain.buildDelegate = async (params) => {
      if (w.chain.builtDelegates.length === 1) w.chain.faults.undelegateNeverLands = true;
      return build(params);
    };
    expect(await runEvidence(w)).toStrictEqual(BOTH);
    const [first, second] = w.chain.builtDelegates;
    expect(opsOf(w)).toStrictEqual(['add', 'put', 'remove', 'delete', 'add', 'put', 'put', 'delete']);
    expect(w.sink.entries.size).toBe(1);
    expect(w.sink.entries.get(second!.id)).toMatchObject({ left: { id: second!.id, endTxHash: w.chain.builtUndelegates[1]!.txHash } });
    expect(w.sink.entries.has(first!.id)).toBe(false);
    expect(janitorPass(w.sink.entries, w.live)).toStrictEqual({ skipped: [], taken: [second!.id] });
  });
});

describe('the time of the two reads', () => {
  /** The time at which the second read starts when nothing fails: the end of the first read. */
  async function secondStart(): Promise<number> {
    const baseline = world();
    const seen = watchBuilds(baseline);
    await runEvidence(baseline);
    return seen[1]!.at;
  }

  it('gives deadline and sends nothing for the second read when it has 539,999 ms left, and runs it with exactly 540,000 ms left: the twin', async () => {
    const start = await secondStart();
    const short = world();
    expectFailed(await runEvidence(short, { deadline: start + 539_999 }), 'deadline');
    expect(short.chain.builtDelegates).toHaveLength(1);
    expect(short.chain.submitted.map((sent) => sent.kind)).toStrictEqual(KINDS(1));
    expect(short.tokenRequests).toHaveLength(1);
    expect(short.fetched).toHaveLength(1);
    await expectRecordedAndEnded(short, 1);
    expect(short.logs).toStrictEqual([failureLine(GUIDELINES, 'deadline')]);
    const exact = world();
    const deadline = start + 540_000;
    expect(await runEvidence(exact, { deadline })).toStrictEqual(BOTH);
    await expectRecordedAndEnded(exact, 2);
    expect(exact.clock.now()).toBeLessThanOrEqual(deadline);
    expect(exact.chain.builtDelegates[1]!.delegation.notAfter - start).toBe(180_000 + 240_000 + 300_000);
  });

  it('starts the second read with the time that the first read left: a first read that takes longer leaves less', async () => {
    const start = await secondStart();
    const w = world();
    // The first read takes 100,000 ms more, and the deadline of the baseline is the deadline of the second read of the twin above.
    w.script.requestToken = async (request) => {
      if (actionOf(request) === 'record.read') await w.clock.sleep(100_000);
      return issued(request, w.clock.now());
    };
    expectFailed(await runEvidence(w, { deadline: start + 540_000 }), 'deadline');
    expect(w.chain.builtDelegates).toHaveLength(1);
  });

  it('leaves at least 600,000 ms of the deadline of 1,620,000 ms for the caller when each read takes 5 minutes', async () => {
    const baseline = world();
    await runEvidence(baseline);
    const natural = (baseline.clock.now() - NOW) / 2;
    const w = world();
    w.script.requestToken = async (request) => {
      await w.clock.sleep(300_000 - natural);
      return issued(request, w.clock.now());
    };
    expect(await runEvidence(w)).toStrictEqual(BOTH);
    expect(w.clock.now() - NOW).toBe(600_000);
    expect(NOW + DEADLINE_MS - w.clock.now()).toBeGreaterThanOrEqual(600_000);
    await expectRecordedAndEnded(w, 2);
  });
});

describe('the id of the second Delegate', () => {
  /** The builder reads the same outputs of the wallet before the second Delegate as before the first one, so it makes the same id twice. */
  function sameIdTwice(w: World): void {
    const original = w.chain.wallet;
    const build = w.chain.buildDelegate.bind(w.chain);
    w.chain.buildDelegate = async (params) => {
      if (w.chain.builtDelegates.length === 1) w.chain.wallet = original;
      return build(params);
    };
  }

  it('is refused by the hook when it equals the id of the first, nothing is sent for it, and the entry of the first stays recorded', async () => {
    const w = world();
    // The first read ends, and the removal of its entry fails: the list still holds the id of the first Delegate when the builder makes the second Delegate.
    w.sink.failRemove = true;
    sameIdTwice(w);
    expectFailed(await runEvidence(w), 'sub_delegation_journal_failed');
    const [first, second] = w.chain.builtDelegates;
    expect(w.chain.builtDelegates).toHaveLength(2);
    expect(second!.id).toBe(first!.id);
    expect(second!.txHash).not.toBe(first!.txHash);
    expect(w.chain.submitted.map((sent) => sent.kind)).toStrictEqual(KINDS(1));
    expect(w.sink.entries.get(first!.id)).toMatchObject({ left: { id: first!.id, delegateTxHash: first!.txHash, endTxHash: null } });
    expect(opsOf(w)).toStrictEqual(['add', 'put', 'remove', 'delete']);
    expect(w.live.size).toBe(0);
    expect(w.tokenRequests).toHaveLength(1);
    expect(w.fetched).toHaveLength(1);
    expect(janitorPass(w.sink.entries, w.live)).toStrictEqual({ skipped: [], taken: [first!.id] });
    expect(w.logs).toHaveLength(2);
    expect(w.logs[0]).toMatch(/holds an entry with this id/);
    expect(w.logs[0]).toContain(first!.id);
    expect(w.logs[0]!.startsWith('evidence: drafter: ')).toBe(true);
    expect(w.logs[1]).toBe(failureLine(GUIDELINES, 'sub_delegation_journal_failed'));
  });

  it('is not refused when the list holds no entry with it, because the first read ended and removed its entry: the twin', async () => {
    const w = world();
    sameIdTwice(w);
    expect(await runEvidence(w)).toStrictEqual(BOTH);
    const [first, second] = w.chain.builtDelegates;
    expect(second!.id).toBe(first!.id);
    expect(w.chain.submitted.map((sent) => sent.kind)).toStrictEqual(KINDS(2));
    expect(w.sink.entries.size).toBe(0);
  });
});

describe('a first read whose sub-delegation does not end', () => {
  interface Case {
    readonly name: string;
    readonly setup: (w: World) => void;
  }
  const CASES: Case[] = [
    { name: 'the Undelegate never lands', setup: (w) => void (w.chain.faults.undelegateNeverLands = true) },
    { name: 'the node refuses the Undelegate', setup: (w) => void (w.chain.faults.submitUndelegateThrows = true) },
    {
      name: 'the node refuses the Undelegate and the update of the entry fails too',
      setup: (w) => {
        w.chain.faults.submitUndelegateThrows = true;
        w.sink.failPutAt.add(2);
      },
    },
  ];
  it.each(CASES)('stops the evidence before the second read when $name: no second sub-delegation, and the entry stays for the janitor', async ({ setup }) => {
    const w = world();
    setup(w);
    const result = await runEvidence(w);
    expectFailed(result, 'sub_delegation_not_ended');
    expect(EVIDENCE_FAILURES).toContain('sub_delegation_not_ended');
    const [first] = w.chain.builtDelegates;
    expect(w.chain.builtDelegates).toHaveLength(1);
    expect(w.chain.submitted.map((sent) => sent.kind)).toStrictEqual(KINDS(1));
    expect(w.tokenRequests.map(actionOf)).toStrictEqual(['record.read']);
    expect(w.fetched.map((call) => call.url)).toStrictEqual([RECORDS.url]);
    expect(opsOf(w)).toStrictEqual(['add', 'put', 'put', 'delete']);
    expect(w.sink.entries.get(first!.id)).toMatchObject({ signer_key_hash: AGENT_KEY, left: { id: first!.id, delegateTxHash: first!.txHash } });
    expect(w.live.size).toBe(0);
    expect(janitorPass(w.sink.entries, w.live)).toStrictEqual({ skipped: [], taken: [first!.id] });
    expect(w.logs).toStrictEqual([failureLine(RECORDS, 'sub_delegation_not_ended')]);
    expectNoSecrets(w, result);
  });

  it('leaves a sub-delegation that is alive on the ledger, and one pass of the janitor then ends it with the entry that the read left', async () => {
    const w = world();
    w.chain.faults.submitUndelegateThrows = true;
    expectFailed(await runEvidence(w), 'sub_delegation_not_ended');
    const [first] = w.chain.builtDelegates;
    expect(await w.chain.readDelegation(first!.id)).not.toBeNull();
    w.chain.faults.submitUndelegateThrows = false;
    expect((await janitorOnce(w)).entries).toMatchObject([{ id: first!.id, state: 'ended' }]);
    expect(await w.chain.readDelegation(first!.id)).toBeNull();
    expect(w.sink.entries.size).toBe(0);
  });

  it('goes on to the second read when the end of the first read is not_made, because nothing of that read is alive: the twin', async () => {
    const w = world();
    // After the job of the first read, the ledger shows ANOTHER transaction under its id. Nothing of that read can land, and the end step builds no Undelegate.
    let other = false;
    showing(w.chain, () => (other ? 'ee'.repeat(32) : w.chain.builtDelegates.at(-1)!.txHash));
    const build = w.chain.buildDelegate.bind(w.chain);
    w.chain.buildDelegate = async (params) => {
      other = false;
      return build(params);
    };
    w.script.fetch = async (url) => {
      other = url === RECORDS.url;
      return systemAnswer(url);
    };
    expect(await runEvidence(w)).toStrictEqual(BOTH);
    expect(w.chain.submitted.map((sent) => sent.kind)).toStrictEqual(['delegate', 'delegate', 'undelegate']);
    expect(opsOf(w)).toStrictEqual(['add', 'put', 'remove', 'delete', 'add', 'put', 'remove', 'delete']);
    expect(w.sink.entries.size).toBe(0);
    expect(w.live.size).toBe(0);
    expect(w.logs).toStrictEqual([]);
  });
});

describe('a caller that hangs up between the reads', () => {
  it('gets the code aborted, and the second read sends nothing, asks for no token and calls nothing, while the first sub-delegation is ended', async () => {
    const w = world();
    const controller = new AbortController();
    w.script.fetch = async (url) => {
      controller.abort();
      return systemAnswer(url);
    };
    const result = await runEvidence(w, { signal: controller.signal });
    expectFailed(result, 'aborted');
    expect(w.chain.builtDelegates).toHaveLength(1);
    expect(w.tokenRequests).toHaveLength(1);
    expect(w.fetched).toHaveLength(1);
    await expectRecordedAndEnded(w, 1);
    expect(w.logs).toStrictEqual([failureLine(GUIDELINES, 'aborted')]);
  });

  it('gives the evidence when the signal does not abort: the twin', async () => {
    const w = world();
    expect(await runEvidence(w, { signal: new AbortController().signal })).toStrictEqual(BOTH);
  });
});

describe('two runs of one wallet', () => {
  it('never overlap their sends: with the queue of the wallet both runs give the evidence, with four ids that differ and sends that come one after the other', async () => {
    const w = world();
    const [one, two] = await w.clock.run(Promise.all([startEvidence(w), startEvidence(w)]));
    expect(one).toStrictEqual(BOTH);
    expect(two).toStrictEqual(BOTH);
    expect(new Set(w.chain.builtDelegates.map((built) => built.id)).size).toBe(4);
    expect(w.chain.submitted.map((sent) => sent.kind).sort()).toStrictEqual([...KINDS(4)].sort());
    const times = w.chain.submitted.map((sent) => sent.at).sort((a, b) => a - b);
    for (let index = 1; index < times.length; index += 1) expect(times[index]! - times[index - 1]!, `send ${index}`).toBeGreaterThanOrEqual(8_000);
    expect(w.sink.entries.size).toBe(0);
    expect(w.live.size).toBe(0);
  });
});

describe('the list of left sub-delegations of the kit', () => {
  it('takes the entries that the reads write, holds none after two good reads, and holds the entry of a read whose end does not land', async () => {
    const clean = world();
    const empty = new MemoryLeftStore();
    expect(await runEvidence(clean, { deps: { leftSink: empty } })).toStrictEqual(BOTH);
    expect(await empty.list()).toStrictEqual([]);
    const left = world();
    const build = left.chain.buildDelegate.bind(left.chain);
    left.chain.buildDelegate = async (params) => {
      if (left.chain.builtDelegates.length === 1) left.chain.faults.undelegateNeverLands = true;
      return build(params);
    };
    const store = new MemoryLeftStore();
    expect(await runEvidence(left, { deps: { leftSink: store } })).toStrictEqual(BOTH);
    const [, second] = left.chain.builtDelegates;
    const entries = await store.list();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ signer_key_hash: AGENT_KEY, left: { id: second!.id, endTxHash: left.chain.builtUndelegates[1]!.txHash } });
  });
});
