// agents/prior-authorization-agent/test/propose/request.test.ts: the last step of `propose`: the number, the document and the proposal. Before the decision the job makes a trial of the request, with stand-ins for the
// number, the justification and the references, so a record that the kit refuses costs no hire and no number. The number comes from the counter, once, after the decision and its checks, and a number that a failed
// job took is never given again. The document is accepted by `parsePriorAuthRequest`, and a document that the kit refuses is `bad_document`. A failure after the decision keeps the decision in the result. Each
// failure has an accepted twin.
import { describe, expect, it } from 'vitest';
import { recordSetSha256 } from '@vsa/usecase-kit/priorauth';
import { accepted } from '@vsa/usecase-kit/protocol';
import { PROPOSE_FAILURES } from '../../src/propose/index.ts';
import type { JustifyAnswer } from '../../src/propose/index.ts';
import { CHOICE, DECISION, INSURER_DID, PORTS, SUB_JOB, TENANT, answerFor, calledPorts, changed, expectFailed, expectNotDecided, golden, listAt, proposed, world } from './support.ts';

/** The choice of the golden run as a plain object, with the members of the request that a test changes. */
const choiceWith = (over: Record<string, unknown>): JustifyAnswer => answerFor({ justification: CHOICE.justification, guideline_refs: [...CHOICE.guideline_refs], record_refs: [...CHOICE.record_refs], ...over });

/**
 * An answer of the decision that records the choice that it gives, member for member: its recorded choice and its typed choice are two copies of one JSON text, so a refusal in the test is the refusal of the
 * document, and never a difference between the two. A member that `over` sets to `undefined` is left out, as a JSON text leaves it out.
 */
function agreeing(over: Record<string, unknown>): JustifyAnswer {
  const text = JSON.stringify({ justification: CHOICE.justification, guideline_refs: CHOICE.guideline_refs, record_refs: CHOICE.record_refs, ...over });
  return { ok: true, decision: { ...DECISION, choice: JSON.parse(text) as never }, choice: JSON.parse(text) as never };
}

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
    ['a record twice', { record_refs: ['REC-0001', 'REC-0001'] }],
  ];
  it.each(BAD)('is a failed proposal with bad_document for %s, and the decision is kept in the result', async (_name, over) => {
    const w = world();
    w.script.justify = async () => agreeing(over);
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

  const HIDDEN: [string, string][] = [
    ['a tab', 'M54\t16'],
    ['a carriage return', 'M54\r16'],
    ['a line feed', 'M54\n16'],
    ['a control character of the second block', 'M54\u008516'],
    ['a zero width character', 'M51\u200b.16'],
    ['a line separator', 'M54\u202816'],
    ['a paragraph separator', 'M54\u202916'],
  ];
  it.each(HIDDEN)('is a failed proposal with bad_document, before the decision, for a diagnosis code with %s, which the record set takes and the request does not: no hire and no number', async (_name, code) => {
    const w = world();
    const set = changed(golden('record-set'), ['order', 'diagnosis_codes'], ['M54.16', code]);
    w.script.evidence = async () => ({ ok: true, record_set: set as never, guideline: golden('guideline') as never });
    const result = await w.run();
    expectFailed(result, 'bad_document');
    expect(result.decisions).toStrictEqual([]);
    expect(result.sub_jobs).toStrictEqual([]);
    expect(calledPorts(w)).toStrictEqual(PORTS.slice(0, 4));
    expectNotDecided(w);
    expect(w.logs).toStrictEqual(['propose stopped at evidence: bad_document']);
  });

  it('takes a diagnosis code with a space, a dot, a hyphen and an accented letter, which the request takes: the twin', async () => {
    const codes = ['M54 16', 'M51.16', 'Z-99', '\u00c9x'];
    const w = world();
    w.script.evidence = async () => ({ ok: true, record_set: changed(golden('record-set'), ['order', 'diagnosis_codes'], codes) as never, guideline: golden('guideline') as never });
    expect(proposed(await w.run()).document.diagnosis_codes).toStrictEqual(codes);
  });

  it('is a failed proposal with bad_document, before the decision, when the insurer of the request is no DID: no hire and no number', async () => {
    const w = world();
    const result = await w.run({ request: { insurer_did: 'did:vector:abc' } });
    expectFailed(result, 'bad_document');
    expect(result.decisions).toStrictEqual([]);
    expect(calledPorts(w)).toStrictEqual(PORTS.slice(0, 4));
    expectNotDecided(w);
  });
});

describe('the references of the choice', () => {
  const OUTSIDE: [string, Record<string, unknown>][] = [
    ['a record that the set does not hold', { record_refs: ['REC-9999'] }],
    ['a record that the set holds and one that it does not', { record_refs: ['REC-0001', 'REC-9999'] }],
    ['a record id in the lower case', { record_refs: ['rec-0001'] }],
    ['a record id with a space after it', { record_refs: ['REC-0001 '] }],
    ['a record id that is no identifier', { record_refs: ['REC 1'] }],
    ['a record id that is a number', { record_refs: [1] }],
    ['a criterion that the guideline does not hold', { guideline_refs: ['C9'] }],
    ['a criterion that the guideline holds and one that it does not', { guideline_refs: ['C1', 'C9'] }],
    ['a criterion id in the lower case', { guideline_refs: ['c1'] }],
    ['a criterion id that is no identifier', { guideline_refs: ['C 1'] }],
    ['a criterion in the list of the records', { record_refs: ['C1'] }],
    ['a record in the list of the criteria', { guideline_refs: ['REC-0001'] }],
    ['criteria that are no list', { guideline_refs: 'C1' }],
    ['records that are no list', { record_refs: 'REC-0001' }],
    ['21 criteria', { guideline_refs: Array.from({ length: 21 }, (_, index) => `C${index + 1}`) }],
    ['51 records', { record_refs: Array.from({ length: 51 }, (_, index) => `REC-${index + 1}`) }],
  ];
  it.each(OUTSIDE)('is a failed proposal with bad_document for %s, before the number: the decision is kept, and no number is taken', async (_name, over) => {
    const w = world();
    w.script.justify = async () => agreeing(over);
    const result = await w.run();
    expectFailed(result, 'bad_document');
    expect(result.decisions).toHaveLength(1);
    expect(result.decisions[0]).toMatchObject({ name: 'justification', inference: DECISION.inference });
    expect(result.sub_jobs).toStrictEqual([SUB_JOB]);
    expect(calledPorts(w)).toStrictEqual(PORTS.slice(0, 5));
    expect(w.counterCalls).toStrictEqual([]);
    expect(w.numbers.size).toBe(0);
    expect(w.logs).toStrictEqual(['propose stopped at decision: bad_document']);
  });

  const INSIDE: [string, Record<string, unknown>][] = [
    ['all the records and all the criteria of the golden run', {}],
    ['one record and one criterion', { record_refs: ['REC-0002'], guideline_refs: ['C1'] }],
    ['the records in another order', { record_refs: ['REC-0005', 'REC-0001'] }],
    ['no record and no criterion', { record_refs: [], guideline_refs: [] }],
  ];
  it.each(INSIDE)('takes %s: the twin of every refusal above', async (_name, over) => {
    const w = world();
    w.script.justify = async () => agreeing(over);
    const result = proposed(await w.run());
    expect(result.document).toMatchObject({ guideline_refs: over.guideline_refs ?? CHOICE.guideline_refs, record_refs: over.record_refs ?? CHOICE.record_refs });
    expect(w.counterCalls).toStrictEqual([TENANT]);
  });

  it('names the records and the criteria of the documents that the evidence gave, and no other: a set with other ids takes other references and refuses the golden ones', async () => {
    const set = changed(changed(golden('record-set'), ['records', 0, 'record_id'], 'REC-7001'), ['records', 1, 'record_id'], 'REC-7002');
    const guideline = changed(golden('guideline'), ['criteria', 0, 'id'], 'K1');
    const oldRefs = world();
    oldRefs.script.evidence = async () => ({ ok: true, record_set: set as never, guideline: guideline as never });
    expectFailed(await oldRefs.run(), 'bad_document');
    expect(oldRefs.counterCalls).toStrictEqual([]);
    const newRefs = world();
    newRefs.script.evidence = async () => ({ ok: true, record_set: set as never, guideline: guideline as never });
    newRefs.script.justify = async () => agreeing({ record_refs: ['REC-7001', 'REC-0003'], guideline_refs: ['K1', 'C2'] });
    expect(proposed(await newRefs.run()).document).toMatchObject({ record_refs: ['REC-7001', 'REC-0003'], guideline_refs: ['K1', 'C2'] });
  });

  it('takes the ids from the documents as the job checked them before the decision: a record and a criterion that the decision adds to the objects that it got are not in the set and the guideline', async () => {
    const w = world();
    w.script.justify = async (set, guideline) => {
      listAt(set, ['records']).push({ record_id: 'REC-9999', type: 'note', recorded_at: '2026-10-22', summary: 'A record that the decision added.' });
      listAt(guideline, ['criteria']).push({ id: 'C9', text: 'A criterion that the decision added.' });
      return agreeing({ record_refs: ['REC-9999'], guideline_refs: ['C9'] });
    };
    expectFailed(await w.run(), 'bad_document');
    expect(w.counterCalls).toStrictEqual([]);
    expect(w.numbers.size).toBe(0);
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
