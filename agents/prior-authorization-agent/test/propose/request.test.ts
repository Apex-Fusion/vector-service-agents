// agents/prior-authorization-agent/test/propose/request.test.ts: the last step of `propose`: the number, the document and the proposal. The number comes from the counter, once, after every check passed, and a number
// that a failed job took is never given again. The document is accepted by `parsePriorAuthRequest`, and a document that the kit refuses is `bad_document`. A failure after the decision keeps the decision in the
// result. Each failure has an accepted twin.
import { describe, expect, it } from 'vitest';
import { recordSetSha256 } from '@vsa/usecase-kit/priorauth';
import { accepted } from '@vsa/usecase-kit/protocol';
import { PROPOSE_FAILURES } from '../../src/propose/index.ts';
import type { JustifyAnswer } from '../../src/propose/index.ts';
import { CHOICE, DECISION, INSURER_DID, PORTS, SUB_JOB, TENANT, answerFor, calledPorts, changed, expectFailed, golden, proposed, world } from './support.ts';

/** The choice of the golden run as a plain object, with the members of the request that a test changes. */
const choiceWith = (over: Record<string, unknown>): JustifyAnswer => answerFor({ justification: CHOICE.justification, guideline_refs: [...CHOICE.guideline_refs], record_refs: [...CHOICE.record_refs], ...over });

describe('the number of the request', () => {
  it('is taken once, for the tenant of the request, after the decision', async () => {
    const w = world();
    proposed(await w.run());
    expect(w.counterCalls).toStrictEqual([TENANT]);
    expect(calledPorts(w)).toStrictEqual([...PORTS]);
    expect(calledPorts(w).indexOf('counter')).toBeGreaterThan(calledPorts(w).indexOf('justify'));
  });

  it('is the number of the counter, with the tenant before it: the request number is the tenant, a hyphen and the counter', async () => {
    const w = world();
    w.script.next = async () => 41;
    expect(proposed(await w.run()).document.request_number).toBe('run1-41');
  });

  it('counts each tenant on its own, and the first number of a tenant is 1', async () => {
    const w = world();
    expect(proposed(await w.run()).document.request_number).toBe('run1-1');
    expect(proposed(await w.run({ request: { tenant: 'run2' } })).document.request_number).toBe('run2-1');
    expect(proposed(await w.run()).document.request_number).toBe('run1-2');
  });

  it('is never taken by a job that failed before the decision, and the next job gets the first number', async () => {
    const w = world();
    w.script.justify = async () => ({ ok: false, code: 'inference_failed' });
    expectFailed(await w.run(), 'inference_failed');
    expect(w.numbers.size).toBe(0);
    w.script.justify = async () => ({ ok: true, decision: DECISION, choice: CHOICE });
    expect(proposed(await w.run()).document.request_number).toBe('run1-1');
  });

  it('is never given again when the request that took it failed: the next job gets the next number', async () => {
    const w = world();
    w.script.justify = async () => choiceWith({ justification: '' });
    expectFailed(await w.run(), 'bad_document');
    expect(w.numbers.get(TENANT)).toBe(1);
    w.script.justify = async () => ({ ok: true, decision: DECISION, choice: CHOICE });
    expect(proposed(await w.run()).document.request_number).toBe('run1-2');
  });

  it('fails with store_write_failed when the counter cannot store the number, and keeps the decision in the result, and no document', async () => {
    for (const failure of [new Error('the disk is full'), 'the disk is full']) {
      const w = world();
      w.script.next = async () => {
        throw failure;
      };
      const result = await w.run();
      expectFailed(result, 'store_write_failed');
      expect(result.decisions).toStrictEqual([DECISION]);
      expect(result.sub_jobs).toStrictEqual([SUB_JOB]);
      expect(w.logs).toStrictEqual(['propose stopped at request: store_write_failed']);
      expect(JSON.stringify(w.logs)).not.toContain('disk');
    }
    expect(PROPOSE_FAILURES).toContain('store_write_failed');
  });

  it.each([Number.NaN, -1, 0, 1.5, '3', null, undefined, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 2])(
    'fails with internal when the counter gives %s, which is no number of a request, and keeps the decision',
    async (value) => {
      const w = world();
      w.script.next = async () => value as never;
      const result = await w.run();
      expectFailed(result, 'internal');
      expect(result.decisions).toStrictEqual([DECISION]);
    },
  );

  it('takes a number that makes a request number of 64 characters, and fails with internal for a number that makes one of 65, and keeps the decision', async () => {
    const tenant = 'x'.repeat(48);
    const fits = world();
    fits.script.next = async () => 999_999_999_999_999;
    const request = proposed(await fits.run({ request: { tenant } })).document.request_number as string;
    expect(request).toBe(`${tenant}-999999999999999`);
    expect(request).toHaveLength(64);
    const long = world();
    long.script.next = async () => 1_000_000_000_000_000;
    const result = await long.run({ request: { tenant } });
    expectFailed(result, 'internal');
    expect(result.decisions).toStrictEqual([DECISION]);
  });
});

describe('the request that the kit refuses', () => {
  const BAD: [string, Record<string, unknown>][] = [
    ['an empty justification', { justification: '' }],
    ['a justification of 4,001 characters', { justification: 'a'.repeat(4001) }],
    ['a justification with a zero width character', { justification: 'Criterion C1 is met.\u200b' }],
    ['a justification with a control character', { justification: 'Criterion C1 is met.\u0001' }],
    ['a justification with a variation selector', { justification: 'Criterion C1 is met.\ufe0f' }],
    ['a justification with a paragraph separator', { justification: 'One.\u2029Two.' }],
    ['a justification that is a number', { justification: 5 }],
    ['no justification', { justification: undefined }],
    ['a criterion twice', { guideline_refs: ['C1', 'C1'] }],
    ['a criterion that is no identifier', { guideline_refs: ['C 1'] }],
    ['criteria that are no list', { guideline_refs: 'C1' }],
    ['21 criteria', { guideline_refs: Array.from({ length: 21 }, (_, index) => `C${index + 1}`) }],
    ['a record twice', { record_refs: ['REC-0001', 'REC-0001'] }],
    ['a record that is no identifier', { record_refs: ['REC 1'] }],
    ['51 records', { record_refs: Array.from({ length: 51 }, (_, index) => `REC-${index + 1}`) }],
    ['a record that is a number', { record_refs: [1] }],
  ];
  it.each(BAD)('is a failed proposal with bad_document for %s, and the decision is kept in the result', async (_name, over) => {
    const w = world();
    // The decision records the same choice, so the failure is the one of the document, and not a difference between the choice and the decision.
    const given = choiceWith(over);
    if (!given.ok) throw new Error('the test makes an answer with a decision');
    const decision = { ...DECISION, choice: JSON.parse(JSON.stringify(given.choice)) as never };
    w.script.justify = async () => ({ ok: true, decision, choice: given.choice });
    const result = await w.run();
    expectFailed(result, 'bad_document');
    expect(result.decisions).toHaveLength(1);
    expect(result.decisions[0]).toMatchObject({ name: 'justification', reasoning: DECISION.reasoning, inference: DECISION.inference });
    expect(result.sub_jobs).toStrictEqual([SUB_JOB]);
    expect(PROPOSE_FAILURES).toContain('bad_document');
  });

  it('takes a justification of 4,000 characters and a justification of one character, and the lines of the golden justification: the twin', async () => {
    for (const justification of ['a'.repeat(4000), 'a', CHOICE.justification]) {
      const w = world();
      w.script.justify = async () => choiceWith({ justification });
      expect(proposed(await w.run()).document.justification).toBe(justification);
    }
  });

  it('is a failed proposal with bad_document for a diagnosis code with a format character, which the record set takes and the request does not, and the decision is kept', async () => {
    const w = world();
    const set = changed(golden('record-set'), ['order', 'diagnosis_codes'], ['M54.16', 'M51\u200b.16']);
    w.script.evidence = async () => ({ ok: true, record_set: set as never, guideline: golden('guideline') as never });
    const result = await w.run();
    expectFailed(result, 'bad_document');
    expect(result.decisions).toStrictEqual([DECISION]);
    expect(w.numbers.get(TENANT)).toBe(1);
  });

  it('is a failed proposal with bad_document when the advert of the insurer is not a reference of an output, and the decision is kept', async () => {
    const w = world();
    w.script.readInsurer = async () => accepted({ advert_ref: 'one' });
    const result = await w.run();
    expectFailed(result, 'bad_document');
    expect(result.decisions).toStrictEqual([DECISION]);
  });

  it('is a failed proposal with bad_document when the insurer of the request is no DID, and the decision is kept', async () => {
    const w = world();
    const result = await w.run({ request: { insurer_did: 'did:vector:abc' } });
    expectFailed(result, 'bad_document');
    expect(result.decisions).toStrictEqual([DECISION]);
  });
});

describe('the members of the request', () => {
  it('has the fourteen members of the kit, in its order', async () => {
    const result = proposed(await world().run());
    expect(Object.keys(result.document)).toStrictEqual([
      'schema', 'request_number', 'tenant', 'order_id', 'patient_ref', 'ordering_clinician_ref', 'service_code', 'diagnosis_codes', 'justification', 'guideline_refs', 'record_refs', 'record_set_sha256',
      'insurer_did', 'advert_ref',
    ]);
  });

  it('takes each member from its own source: the request, the checked order, the checked choice, the hash of the set, and the advert of the reader', async () => {
    const w = world();
    const order = changed(changed(changed(golden('record-set'), ['order', 'patient_ref'], 'SYN-PT-4242'), ['order', 'ordering_clinician_ref'], 'SYN-CL-4343'), ['order', 'diagnosis_codes'], ['Z00.0']);
    w.script.evidence = async () => ({ ok: true, record_set: order as never, guideline: golden('guideline') as never });
    w.script.readInsurer = async () => accepted({ advert_ref: `${'aa'.repeat(32)}#9` });
    w.script.next = async () => 41;
    const otherInsurer = `did:vector:${'cc'.repeat(32)}`;
    const result = proposed(await w.run({ request: { insurer_did: otherInsurer } }));
    const seen: unknown = JSON.parse(w.justifyCalls[0]!.setText);
    expect(otherInsurer).not.toBe(INSURER_DID);
    expect(result.document).toStrictEqual({
      schema: 'vector.usecase.priorauth-request.v1',
      request_number: 'run1-41',
      tenant: 'run1',
      order_id: 'ORD-1001',
      patient_ref: 'SYN-PT-4242',
      ordering_clinician_ref: 'SYN-CL-4343',
      service_code: 'SYN-MRI-LS',
      diagnosis_codes: ['Z00.0'],
      justification: CHOICE.justification,
      guideline_refs: CHOICE.guideline_refs,
      record_refs: CHOICE.record_refs,
      record_set_sha256: recordSetSha256(seen as never),
      insurer_did: otherInsurer,
      advert_ref: `${'aa'.repeat(32)}#9`,
    });
  });

  it('asks the insurer for the insurer of the request, and takes its DID from the request and not from the reader', async () => {
    const w = world();
    const result = proposed(await w.run());
    expect(w.insurerCalls).toStrictEqual([INSURER_DID]);
    expect(result.document.insurer_did).toBe(INSURER_DID);
  });
});
