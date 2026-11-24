// agents/prior-authorization-agent/test/propose/evidence.test.ts: the evidence step of `propose`. The evidence gets the order, the delegation, the key and a deadline that leaves the decision its time. A failure of the
// evidence is a failed proposal with its code, and nothing is decided or counted after it. The job checks the two documents that the evidence gives with the parsers of the kit, and it checks that the record set is the
// set of the order that was asked for and that the guideline is the guideline of its service. Each failure has an accepted twin.
import { describe, expect, it } from 'vitest';
import { GATEWAY_FAILURES, SUB_DELEGATION_FAILURES } from '@vsa/usecase-kit/access';
import { DECISION_RESERVE_MS, PROPOSE_DEADLINE_MS, PROPOSE_FAILURES } from '../../src/propose/index.ts';
import {
  DELEGATION, GUIDELINE, KEY, NOW, ORDER_ID, PORTS, RECORD_SET, SET_SHA256, TENANT, calledPorts, changed, expectFailed, expectNotDecided, golden, objectAt, proposed, world,
} from './support.ts';

/** The codes that the evidence gives: the failures of its sub-delegations and tokens, its own codes, and the codes of the mock systems. */
const EVIDENCE_CODES = [
  ...SUB_DELEGATION_FAILURES.map((code) => `sub_delegation_${code}`),
  ...GATEWAY_FAILURES.map((code) => `token_${code}`),
  'record_read_timeout', 'guideline_read_timeout', 'record_set_invalid', 'guideline_invalid', 'order_not_found', 'guideline_not_found', 'mock_system_failed', 'refused_by_system', 'token_invalid', 'not_covered',
  'deadline', 'aborted', 'internal',
];

describe('what the evidence gets', () => {
  it('is asked once, for the tenant, the order and the delegation of the request, with the key of the table', async () => {
    const w = world();
    proposed(await w.run());
    expect(w.evidenceCalls).toHaveLength(1);
    expect(w.evidenceCalls[0]!.request).toStrictEqual({ tenant: TENANT, order_id: ORDER_ID, delegation: DELEGATION, key: KEY });
    expect(w.evidenceCalls[0]!.request.key).toBe(KEY);
  });

  it('gets a deadline that leaves the decision its time: the deadline of the job less the reserve of the decision', async () => {
    expect(PROPOSE_DEADLINE_MS).toBe(1_620_000);
    expect(DECISION_RESERVE_MS).toBe(300_000);
    const w = world();
    proposed(await w.run());
    expect(w.evidenceCalls[0]!.run.deadline).toBe(NOW + PROPOSE_DEADLINE_MS - DECISION_RESERVE_MS);
    expect(w.evidenceCalls[0]!.run.deadline).toBe(NOW + 1_320_000);
  });

  it.each([NOW, NOW - 100_000, NOW - 500_000, NOW - 1_000_000])('gets the deadline of the arrival %s: the arrival plus the deadline of the job less the reserve', async (arrivedAt) => {
    const w = world();
    proposed(await w.run({ arrivedAt }));
    expect(w.evidenceCalls[0]!.run.deadline).toBe(arrivedAt + PROPOSE_DEADLINE_MS - DECISION_RESERVE_MS);
  });

  it('gets the signal of the caller, and no signal when the caller gives none', async () => {
    const without = world();
    proposed(await without.run());
    expect(without.evidenceCalls[0]!.run.signal).toBeUndefined();
    const controller = new AbortController();
    const given = world();
    proposed(await given.run({ signal: controller.signal }));
    expect(given.evidenceCalls[0]!.run.signal).toBe(controller.signal);
  });

  it('leaves the evidence the time to refuse: an evidence that finds its deadline past gives the code deadline, and the job passes it on without a decision', async () => {
    const w = world();
    w.script.evidence = async (_request, run) => (run.deadline <= NOW ? { ok: false, code: 'deadline' } : { ok: true, record_set: RECORD_SET, guideline: GUIDELINE });
    expectFailed(await w.run({ arrivedAt: NOW - PROPOSE_DEADLINE_MS + DECISION_RESERVE_MS - 1 }), 'deadline');
    expect(w.evidenceCalls).toHaveLength(1);
    expectNotDecided(w);
    const twin = world();
    twin.script.evidence = w.script.evidence;
    proposed(await twin.run({ arrivedAt: NOW - PROPOSE_DEADLINE_MS + DECISION_RESERVE_MS + 1 }));
  });
});

describe('a failure of the evidence', () => {
  it.each(EVIDENCE_CODES)('is a failed proposal with the code %s of the evidence, with no decision, and nothing is decided or counted', async (code) => {
    const w = world();
    w.script.evidence = async () => ({ ok: false, code });
    const result = await w.run();
    expectFailed(result, code);
    expect(result.decisions).toStrictEqual([]);
    expect(result.sub_jobs).toStrictEqual([]);
    expect(calledPorts(w)).toStrictEqual(['delegation', 'key', 'insurer', 'evidence']);
    expectNotDecided(w);
  });

  it('does not take the words of the evidence as a reason: a text that is not a code is internal', async () => {
    for (const code of ['The order was not found', 'ORDER_NOT_FOUND', 'order-not-found', '', 'x'.repeat(65), 42 as never, null as never]) {
      const w = world();
      w.script.evidence = async () => ({ ok: false, code: code as string });
      expectFailed(await w.run(), 'internal');
      expectNotDecided(w);
    }
  });

  it('keeps the words of a failure out of the result and out of the log', async () => {
    const w = world();
    w.script.evidence = async () => ({ ok: false, code: 'order_not_found', detail: 'the order ORD-1001 of the patient SYN-PT-0001 was not found' }) as never;
    const result = await w.run();
    expectFailed(result, 'order_not_found');
    expect(JSON.stringify(result)).not.toContain('SYN-PT-0001');
    expect(w.logs).toStrictEqual(['propose stopped at evidence: order_not_found']);
  });

  it('is internal when the evidence throws, and when it gives no answer at all', async () => {
    const throwing = world();
    throwing.script.evidence = async () => {
      throw new Error('the evidence broke');
    };
    expectFailed(await throwing.run(), 'internal');
    expectNotDecided(throwing);
    for (const value of [undefined, null, 'a text']) {
      const w = world();
      w.script.evidence = async () => value as never;
      expectFailed(await w.run(), 'internal');
      expectNotDecided(w);
    }
  });

  it.each([['a text', 'true'], ['a number', 1], ['nothing', undefined]])('does not read success from %s: an answer whose ok is not the boolean true is internal, and nothing is decided or counted', async (_name, ok) => {
    const w = world();
    w.script.evidence = async () => ({ ok, record_set: RECORD_SET, guideline: GUIDELINE }) as never;
    expectFailed(await w.run(), 'internal');
    expectNotDecided(w);
  });

  it('lists the codes that the job writes itself: the codes that only the evidence writes are not in the list, and the three codes of the job are', () => {
    const shared = ['deadline', 'aborted', 'internal'];
    for (const code of EVIDENCE_CODES.filter((entry) => !shared.includes(entry))) expect(PROPOSE_FAILURES).not.toContain(code);
    for (const code of shared) expect(PROPOSE_FAILURES).toContain(code);
  });
});

describe('the two documents that the evidence gives', () => {
  const WRONG: [string, () => unknown][] = [
    ['no record set', () => ({ ok: true, guideline: GUIDELINE })],
    ['no guideline', () => ({ ok: true, record_set: RECORD_SET })],
    ['a record set that is null', () => ({ ok: true, record_set: null, guideline: GUIDELINE })],
    ['a record set that is a text', () => ({ ok: true, record_set: 'a text', guideline: GUIDELINE })],
    ['a guideline that is a list', () => ({ ok: true, record_set: RECORD_SET, guideline: [GUIDELINE] })],
    ['a record with a date that does not exist', () => ({ ok: true, record_set: changed(golden('record-set'), ['records', 0, 'recorded_at'], '2026-02-30'), guideline: GUIDELINE })],
    ['two records with one id', () => ({ ok: true, record_set: changed(golden('record-set'), ['records', 1, 'record_id'], 'REC-0001'), guideline: GUIDELINE })],
    ['a record set with a member that the form does not list', () => ({ ok: true, record_set: { ...golden('record-set'), note: 'more' }, guideline: GUIDELINE })],
    ['a guideline with two criteria of one id', () => ({ ok: true, record_set: RECORD_SET, guideline: changed(golden('guideline'), ['criteria', 1, 'id'], 'C1') })],
    [
      'a record set with a getter instead of a value',
      () => {
        const set = golden('record-set');
        Object.defineProperty(objectAt(set, ['order']), 'patient_ref', { get: () => 'SYN-PT-0001', enumerable: true, configurable: true });
        return { ok: true, record_set: set, guideline: GUIDELINE };
      },
    ],
  ];
  it.each(WRONG)('is refused with internal when the evidence gives %s as a success, and nothing is decided or counted', async (_name, answer) => {
    const w = world();
    w.script.evidence = async () => answer() as never;
    expectFailed(await w.run(), 'internal');
    expect(calledPorts(w)).toStrictEqual(['delegation', 'key', 'insurer', 'evidence']);
    expectNotDecided(w);
  });

  it('is taken when the evidence gives the golden documents: the twin of every refusal above', async () => {
    const w = world();
    proposed(await w.run());
  });

  it('is a copy that the job made: the decision gets equal documents and not the objects of the evidence', async () => {
    const w = world();
    const set = golden('record-set');
    const guideline = golden('guideline');
    w.script.evidence = async () => ({ ok: true, record_set: set as never, guideline: guideline as never });
    proposed(await w.run());
    expect(w.justifyCalls).toHaveLength(1);
    expect(w.justifyCalls[0]!.set).toStrictEqual(RECORD_SET);
    expect(w.justifyCalls[0]!.guideline).toStrictEqual(GUIDELINE);
    expect(w.justifyCalls[0]!.set).not.toBe(set);
    expect(w.justifyCalls[0]!.guideline).not.toBe(guideline);
  });
});

describe('the record set of the order', () => {
  it.each(['ORD-2002', 'ord-1001', 'ORD-10010'])('fails with record_set_mismatch when the set is the set of the order %s, and nothing is decided or counted', async (orderId) => {
    const w = world();
    const set = changed(golden('record-set'), ['order', 'order_id'], orderId);
    w.script.evidence = async () => ({ ok: true, record_set: set as never, guideline: GUIDELINE });
    const result = await w.run();
    expectFailed(result, 'record_set_mismatch');
    expect(result.decisions).toStrictEqual([]);
    expectNotDecided(w);
    expect(PROPOSE_FAILURES).toContain('record_set_mismatch');
  });

  it('fails with record_set_mismatch when the request names another order than the set holds', async () => {
    const w = world();
    expectFailed(await w.run({ request: { order_id: 'ORD-1002' } }), 'record_set_mismatch');
    expectNotDecided(w);
  });

  it('is internal, and not a mismatch, when the order id of the set is no identifier: the set is a document that the parser refuses', async () => {
    const w = world();
    const set = changed(golden('record-set'), ['order', 'order_id'], 'ORD-1001 ');
    w.script.evidence = async () => ({ ok: true, record_set: set as never, guideline: GUIDELINE });
    expectFailed(await w.run(), 'internal');
    expectNotDecided(w);
  });

  it('takes the set of the order of the request: the twin', async () => {
    const other = world();
    const set = changed(golden('record-set'), ['order', 'order_id'], 'ORD-1002');
    other.script.evidence = async () => ({ ok: true, record_set: set as never, guideline: GUIDELINE });
    expect(proposed(await other.run({ request: { order_id: 'ORD-1002' } })).document).toMatchObject({ order_id: 'ORD-1002' });
    expect(proposed(await world().run()).document.record_set_sha256).toBe(SET_SHA256);
  });
});

describe('the guideline of the service', () => {
  it.each(['SYN-CT-HEAD', 'syn-mri-ls', 'SYN-MRI-LS2'])('fails with guideline_mismatch when the guideline is the guideline of the service %s, and nothing is decided or counted', async (code) => {
    const w = world();
    w.script.evidence = async () => ({ ok: true, record_set: RECORD_SET, guideline: changed(golden('guideline'), ['code'], code) as never });
    const result = await w.run();
    expectFailed(result, 'guideline_mismatch');
    expect(result.decisions).toStrictEqual([]);
    expect(calledPorts(w)).toStrictEqual(['delegation', 'key', 'insurer', 'evidence']);
    expectNotDecided(w);
    expect(PROPOSE_FAILURES).toContain('guideline_mismatch');
  });

  it('fails with guideline_mismatch when the order has another service than the guideline', async () => {
    const w = world();
    w.script.evidence = async () => ({ ok: true, record_set: changed(golden('record-set'), ['order', 'service_code'], 'SYN-CT-HEAD') as never, guideline: GUIDELINE });
    expectFailed(await w.run(), 'guideline_mismatch');
    expectNotDecided(w);
  });

  it('takes the guideline of the service of the order, whatever its title and version are: the twin', async () => {
    const w = world();
    w.script.evidence = async () => ({
      ok: true,
      record_set: RECORD_SET,
      guideline: changed(changed(golden('guideline'), ['title'], 'Another title'), ['version'], '2027.1') as never,
    });
    proposed(await w.run());
    const other = world();
    other.script.evidence = async () => ({
      ok: true,
      record_set: changed(golden('record-set'), ['order', 'service_code'], 'SYN-CT-HEAD') as never,
      guideline: changed(golden('guideline'), ['code'], 'SYN-CT-HEAD') as never,
    });
    expect(proposed(await other.run()).document).toMatchObject({ service_code: 'SYN-CT-HEAD' });
  });

  it('checks the record set before the guideline: a wrong set and a wrong guideline is record_set_mismatch', async () => {
    const w = world();
    w.script.evidence = async () => ({
      ok: true,
      record_set: changed(golden('record-set'), ['order', 'order_id'], 'ORD-2002') as never,
      guideline: changed(golden('guideline'), ['code'], 'SYN-CT-HEAD') as never,
    });
    expectFailed(await w.run(), 'record_set_mismatch');
  });

  it('calls no port after the evidence for a guideline that does not match', async () => {
    const w = world();
    w.script.evidence = async () => ({ ok: true, record_set: RECORD_SET, guideline: changed(golden('guideline'), ['code'], 'SYN-CT-HEAD') as never });
    await w.run();
    expect(calledPorts(w)).toStrictEqual(PORTS.slice(0, 4));
  });
});

describe('reads each answer one time', () => {
  it('reads the record set and the guideline of the answer of the evidence once each, and uses the first values', async () => {
    const w = world();
    const reads = { record_set: 0, guideline: 0 };
    const evilSet = changed(golden('record-set'), ['records', 0, 'summary'], 'A record that the evidence changed.');
    const evilGuideline = changed(golden('guideline'), ['code'], 'OTHER');
    w.script.evidence = async () =>
      ({
        ok: true,
        get record_set() {
          reads.record_set += 1;
          return reads.record_set === 1 ? RECORD_SET : evilSet;
        },
        get guideline() {
          reads.guideline += 1;
          return reads.guideline === 1 ? GUIDELINE : evilGuideline;
        },
      }) as never;
    const result = proposed(await w.run());
    expect(reads).toStrictEqual({ record_set: 1, guideline: 1 });
    expect(w.justifyCalls[0]!.set).toStrictEqual(RECORD_SET);
    expect(w.justifyCalls[0]!.guideline).toStrictEqual(GUIDELINE);
    expect(result.document.record_set_sha256).toBe(SET_SHA256);
  });

  it('reads the value of the answer of the reader of the insurer, and its reference, once each, and uses the first values', async () => {
    const w = world();
    let valueReads = 0;
    let refReads = 0;
    const first = `${'6e'.repeat(32)}#3`;
    w.script.readInsurer = async () =>
      ({
        ok: true,
        get value() {
          valueReads += 1;
          return {
            get advert_ref() {
              refReads += 1;
              return refReads === 1 ? first : `${'7f'.repeat(32)}#4`;
            },
          };
        },
      }) as never;
    const result = proposed(await w.run());
    expect({ valueReads, refReads }).toStrictEqual({ valueReads: 1, refReads: 1 });
    expect(result.document.advert_ref).toBe(first);
  });
});
