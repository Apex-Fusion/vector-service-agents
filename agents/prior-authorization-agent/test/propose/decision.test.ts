// agents/prior-authorization-agent/test/propose/decision.test.ts: the decision step of `propose`. The model is asked once, with the record set and the guideline that the job checked, after the evidence and
// the checks of the two documents. A failure of the decision is a failed proposal with its code and holds no decision. The request is built from the choice only when it equals the choice that the decision
// records, and only from the copy that the job checked: the port changes its objects, and the request does not change. The hash of the record set is the hash of the set that the model got (statement S2 of the
// claim). Each failure has an accepted twin.
import { describe, expect, it } from 'vitest';
import { recordSetSha256 } from '@vsa/usecase-kit/priorauth';
import type { JsonValue } from '@vsa/usecase-kit/protocol';
import { PROPOSE_FAILURES } from '../../src/propose/index.ts';
import type { JustifyAnswer } from '../../src/propose/index.ts';
import {
  CHOICE, DECISION, GUIDELINE, ORDER_ID, PORTS, RECORD_SET, SET_SHA256, SUB_JOB, answerFor, calledPorts, changed, expectFailed, golden, listAt, objectAt, proposed, world,
} from './support.ts';

/** An answer of the decision that holds a decision. */
type OkAnswer = Extract<JustifyAnswer, { readonly ok: true }>;

/** The choice of the golden run, as a plain object that a test can change. */
const plain = (): { justification: string; guideline_refs: string[]; record_refs: string[] } => ({
  justification: CHOICE.justification,
  guideline_refs: [...CHOICE.guideline_refs],
  record_refs: [...CHOICE.record_refs],
});

describe('the model decision', () => {
  it('is asked once, after the evidence and the checks of the two documents, with the record set and the guideline that the job checked', async () => {
    const w = world();
    proposed(await w.run());
    expect(calledPorts(w)).toStrictEqual([...PORTS]);
    expect(w.justifyCalls).toHaveLength(1);
    expect(w.justifyCalls[0]!.set).toStrictEqual(RECORD_SET);
    expect(w.justifyCalls[0]!.guideline).toStrictEqual(GUIDELINE);
  });

  it.each(['inference_failed', 'model_output_invalid', 'hire_failed', 'llm_out_of_time', 'llm_timeout', 'store_write_failed', 'choice_changed', 'bad_limit', 'bad_decision', 'bad_input', 'bad_deps'])(
    'is a failed proposal with the code %s of the decision, with no decision in the result, and one question only',
    async (code) => {
      const w = world();
      w.script.justify = async () => ({ ok: false, code });
      const result = await w.run();
      expectFailed(result, code);
      expect(result.decisions).toStrictEqual([]);
      expect(result.sub_jobs).toStrictEqual([]);
      expect(w.justifyCalls).toHaveLength(1);
      expect(calledPorts(w)).toStrictEqual(PORTS.slice(0, 5));
      expect(w.counterCalls).toStrictEqual([]);
      expect(w.numbers.size).toBe(0);
    },
  );

  it('is a failed proposal with bad_input, with no decision and no number, for a record set that makes the prompt too large: the largest set that the kit takes, in a character of three bytes', async () => {
    const w = world();
    const text = '\u20ac'.repeat(2000);
    const records = Array.from({ length: 50 }, (_, index) => ({ record_id: `REC-${index + 1}`, type: 'note', recorded_at: '2026-10-01', summary: text }));
    w.script.evidence = async () => ({ ok: true, record_set: changed(golden('record-set'), ['records'], records) as never, guideline: GUIDELINE });
    // The decision of the service fails before it hires the model when the prompt has more than 200,000 bytes, and its reason is `bad_input`.
    w.script.justify = async (set) => (Buffer.byteLength(JSON.stringify(set)) > 200_000 ? { ok: false, code: 'bad_input' } : { ok: true, decision: DECISION, choice: CHOICE });
    const result = await w.run();
    expectFailed(result, 'bad_input');
    expect(result.decisions).toStrictEqual([]);
    expect(result.sub_jobs).toStrictEqual([]);
    expect(w.justifyCalls).toHaveLength(1);
    expect(w.counterCalls).toStrictEqual([]);
    expect(w.numbers.size).toBe(0);
  });

  it('does not take the words of the decision as a reason: a text that is not a code is internal', async () => {
    for (const code of ['The model said no, sorry', 'MODEL_OUTPUT_INVALID', '', 'x'.repeat(65), 42 as never]) {
      const w = world();
      w.script.justify = async () => ({ ok: false, code: code as string });
      const result = await w.run();
      expectFailed(result, 'internal');
      expect(result.decisions).toStrictEqual([]);
      expect(w.counterCalls).toStrictEqual([]);
    }
  });

  it('is internal when the decision throws, when it gives no answer at all, and when it gives a decision with no sub-job, and the result holds no decision', async () => {
    const throwing = world();
    throwing.script.justify = async () => {
      throw new Error('the model hire broke');
    };
    const empty = world();
    empty.script.justify = async () => ({ ok: true, decision: {} as never, choice: CHOICE });
    const noInference = world();
    noInference.script.justify = async () => ({ ok: true, decision: { ...DECISION, inference: null } as never, choice: CHOICE });
    const cases = [throwing, empty, noInference];
    for (const value of [undefined, null, 'a text']) {
      const w = world();
      w.script.justify = async () => value as never;
      cases.push(w);
    }
    for (const w of cases) {
      const result = await w.run();
      expectFailed(result, 'internal');
      expect(result.decisions).toStrictEqual([]);
      expect(result.sub_jobs).toStrictEqual([]);
      expect(w.justifyCalls).toHaveLength(1);
      expect(w.counterCalls).toStrictEqual([]);
    }
    expect(PROPOSE_FAILURES).toContain('internal');
  });

  it.each([['a text', 'true'], ['a number', 1], ['nothing', undefined]])('does not read success from %s: an answer whose ok is not the boolean true is internal, with no decision and no number', async (_name, ok) => {
    const w = world();
    w.script.justify = async () => ({ ok, decision: DECISION, choice: CHOICE }) as never;
    const result = await w.run();
    expectFailed(result, 'internal');
    expect(result.decisions).toStrictEqual([]);
    expect(w.counterCalls).toStrictEqual([]);
  });

  it('keeps the decision and the sub-job that bought it, and nothing else of the answer: the twin of every failure above', async () => {
    const result = proposed(await world().run());
    expect(result.decisions).toStrictEqual([DECISION]);
    expect(result.sub_jobs).toStrictEqual([SUB_JOB]);
  });
});

describe('the choice and the decision that records it', () => {
  const RECORDED = plain();
  /** The answer of a decision that records `recorded`, for the choice `choice`. */
  const answer = (recorded: JsonValue, choice: unknown): OkAnswer => ({ ok: true, decision: { ...DECISION, choice: recorded }, choice: choice as never });
  const DIFFERENT: [string, OkAnswer][] = [
    ['another justification', answer(RECORDED, { ...RECORDED, justification: 'Another text.' })],
    ['another list of criteria', answer(RECORDED, { ...RECORDED, guideline_refs: ['C1'] })],
    ['the criteria in another order', answer(RECORDED, { ...RECORDED, guideline_refs: ['C4', 'C3', 'C2', 'C1'] })],
    ['another list of records', answer(RECORDED, { ...RECORDED, record_refs: ['REC-0001'] })],
    ['a justification that is a number for a justification that is a text', answer(RECORDED, { ...RECORDED, justification: 5 })],
    ['a member that the decision does not record', answer(RECORDED, { ...RECORDED, note: 'more' })],
    ['a member that only the decision records', answer({ ...RECORDED, note: 'more' }, RECORDED)],
    ['a decision that records a text', answer('a text', RECORDED)],
    ['a decision that records nothing', answer(null, RECORDED)],
  ];
  it.each(DIFFERENT)('is a failed proposal with decision_mismatch for %s, with the decision kept, no number taken, and no document', async (_name, given) => {
    const w = world();
    w.script.justify = async () => given;
    const result = await w.run();
    expectFailed(result, 'decision_mismatch');
    expect(PROPOSE_FAILURES).toContain('decision_mismatch');
    expect(result.decisions).toStrictEqual([given.decision]);
    expect(result.sub_jobs).toStrictEqual([SUB_JOB]);
    expect(w.justifyCalls).toHaveLength(1);
    expect(w.counterCalls).toStrictEqual([]);
    expect(w.numbers.size).toBe(0);
  });

  it('builds the request from a choice that equals the recorded choice, also with its members in another order: the twin', async () => {
    const w = world();
    const recorded = { record_refs: [...CHOICE.record_refs], justification: CHOICE.justification, guideline_refs: [...CHOICE.guideline_refs] };
    w.script.justify = async () => answer(recorded, RECORDED);
    const result = proposed(await w.run());
    expect(result.document).toMatchObject({ justification: CHOICE.justification, guideline_refs: CHOICE.guideline_refs, record_refs: CHOICE.record_refs });
    expect(result.decisions[0]!.choice).toStrictEqual(recorded);
  });

  it('compares the canonical forms: a text in the NFD form and the same text in the NFC form are one choice, and the request holds the NFC form', async () => {
    const nfc = 'The recorded gait is \u00e9ven. Criterion C1 is met by the progress note REC-0002.';
    const nfd = nfc.normalize('NFD');
    expect(nfd).not.toBe(nfc);
    const w = world();
    w.script.justify = async () => answer({ ...RECORDED, justification: nfc }, { ...RECORDED, justification: nfd });
    const result = proposed(await w.run());
    expect(result.document.justification).toBe(nfc);
    expect(result.decisions[0]!.choice).toMatchObject({ justification: nfc });
  });

  const UNUSABLE: [string, unknown][] = [
    ['no choice', null],
    ['a choice that is a text', 'a text'],
    ['a choice that is a list', [1, 2]],
    ['a choice that is not JSON data', undefined],
    ['a justification that JSON cannot hold', { ...RECORDED, justification: Number.NaN }],
  ];
  it.each(UNUSABLE)('is a failed proposal with bad_document for %s, and the decision is kept in the result, and no number is taken', async (_name, choice) => {
    const w = world();
    // The decision records the same choice, so the failure is the one of the choice, and not a difference between the choice and the decision.
    const decision = { ...DECISION, choice: choice as never };
    w.script.justify = async () => ({ ok: true, decision, choice: choice as never });
    const result = await w.run();
    expectFailed(result, 'bad_document');
    expect(result.decisions).toStrictEqual([decision]);
    expect(result.sub_jobs).toStrictEqual([SUB_JOB]);
    expect(w.counterCalls).toStrictEqual([]);
    expect(w.numbers.size).toBe(0);
    expect(PROPOSE_FAILURES).toContain('bad_document');
  });
});

describe('the checked copy', () => {
  it('builds the request, and keeps the decision, from the copy that it checked, and not from the objects of the port, which the port changes while the job waits for the number', async () => {
    const w = world();
    const choice = plain();
    const recorded = plain();
    w.script.justify = async () => ({ ok: true, decision: { ...DECISION, choice: recorded }, choice });
    w.script.next = async () => {
      choice.justification = 'A text that the port wrote after the check.';
      choice.guideline_refs.push('C9');
      choice.record_refs.length = 0;
      recorded.justification = 'Another text that the port wrote after the check.';
      recorded.guideline_refs.length = 0;
      return 1;
    };
    const result = proposed(await w.run());
    expect(result.document).toMatchObject({ justification: CHOICE.justification, guideline_refs: CHOICE.guideline_refs, record_refs: CHOICE.record_refs });
    expect(result.decisions[0]!.choice).toStrictEqual(DECISION.choice);
  });

  it('reads the decision and the choice of the answer once each, and uses the first values', async () => {
    const w = world();
    const reads = { decision: 0, choice: 0 };
    const evil = { ...plain(), justification: 'A text that the port wrote on the second read.' };
    w.script.justify = async () =>
      ({
        ok: true,
        get decision() {
          reads.decision += 1;
          return reads.decision === 1 ? DECISION : { ...DECISION, choice: evil };
        },
        get choice() {
          reads.choice += 1;
          return reads.choice === 1 ? CHOICE : evil;
        },
      }) as never;
    const result = proposed(await w.run());
    expect(reads).toStrictEqual({ decision: 1, choice: 1 });
    expect(result.document.justification).toBe(CHOICE.justification);
    expect(result.decisions).toStrictEqual([DECISION]);
  });

  it('takes the patient, the clinician, the service and the diagnoses from the order that it checked, and the hash of the set that the decision got, though the decision changes the objects that it got', async () => {
    const w = world();
    w.script.justify = async (set, guideline) => {
      const order = objectAt(set, ['order']);
      order.patient_ref = 'SYN-PT-9999';
      order.ordering_clinician_ref = 'SYN-CL-9999';
      order.service_code = 'SYN-OTHER';
      listAt(order, ['diagnosis_codes']).push('X99');
      listAt(set, ['records']).pop();
      objectAt(guideline, []).code = 'OTHER';
      return { ok: true, decision: DECISION, choice: CHOICE };
    };
    const result = proposed(await w.run());
    expect(result.document).toMatchObject({
      patient_ref: 'SYN-PT-0001', ordering_clinician_ref: 'SYN-CL-0007', service_code: 'SYN-MRI-LS', diagnosis_codes: ['M54.16', 'M51.16'], record_set_sha256: SET_SHA256,
    });
  });

  it('does not use the objects of the evidence after the evidence: a change of them during the decision changes nothing', async () => {
    const w = world();
    const set = golden('record-set');
    const guideline = golden('guideline');
    w.script.evidence = async () => ({ ok: true, record_set: set as never, guideline: guideline as never });
    w.script.justify = async () => {
      objectAt(set, ['order']).patient_ref = 'SYN-PT-9999';
      objectAt(set, ['records', 0]).summary = 'A record that the port changed.';
      guideline.code = 'OTHER';
      return { ok: true, decision: DECISION, choice: CHOICE };
    };
    const result = proposed(await w.run());
    expect(result.document).toMatchObject({ patient_ref: 'SYN-PT-0001', record_set_sha256: SET_SHA256 });
    expect(w.justifyCalls[0]!.setText).toBe(JSON.stringify(RECORD_SET));
  });
});

describe('the hash of the record set (statement S2 of the claim)', () => {
  it('is the hash of the set that the decision got: the test recomputes it from what the decision saw', async () => {
    const w = world();
    const result = proposed(await w.run());
    const seen: unknown = JSON.parse(w.justifyCalls[0]!.setText);
    expect(result.document.record_set_sha256).toBe(recordSetSha256(seen as never));
    expect(result.document.record_set_sha256).toBe(SET_SHA256);
    expect(result.document.record_set_sha256).toBe(recordSetSha256(RECORD_SET));
    expect(result.document.record_set_sha256).toBe(golden('digest').record_set_sha256);
  });

  it('follows the set: another set that the evidence gives has another hash, and it is again the hash of what the decision saw', async () => {
    const variants = [
      changed(golden('record-set'), ['records', 0, 'summary'], 'Plain X-ray of the lumbar spine. No fracture.'),
      changed(golden('record-set'), ['order', 'diagnosis_codes'], ['M54.16']),
      changed(golden('record-set'), ['records'], [...listAt(golden('record-set'), ['records'])].reverse()),
    ];
    const seenHashes = new Set<string>([SET_SHA256]);
    for (const set of variants) {
      const w = world();
      w.script.evidence = async () => ({ ok: true, record_set: set as never, guideline: GUIDELINE });
      const result = proposed(await w.run());
      const seen: unknown = JSON.parse(w.justifyCalls[0]!.setText);
      const hash = result.document.record_set_sha256;
      if (typeof hash !== 'string') throw new Error('the request must hold a hash of the record set');
      expect(hash).toBe(recordSetSha256(seen as never));
      expect(hash).not.toBe(SET_SHA256);
      seenHashes.add(hash);
    }
    expect(seenHashes.size).toBe(variants.length + 1);
  });

  it('is the hash of the NFC form: a set whose text is in the NFD form has the hash of the same set in the NFC form', async () => {
    const nfc = 'Plain X-ray of the lumbar spine, the pr\u00e9sent finding. No fracture.';
    const composed = world();
    composed.script.evidence = async () => ({ ok: true, record_set: changed(golden('record-set'), ['records', 0, 'summary'], nfc) as never, guideline: GUIDELINE });
    const decomposed = world();
    decomposed.script.evidence = async () => ({ ok: true, record_set: changed(golden('record-set'), ['records', 0, 'summary'], nfc.normalize('NFD')) as never, guideline: GUIDELINE });
    expect(proposed(await decomposed.run()).document.record_set_sha256).toBe(proposed(await composed.run()).document.record_set_sha256);
  });

  it('is computed before the decision: the order of the request is the order of the set', async () => {
    const w = world();
    w.script.justify = async () => ({ ok: false, code: 'inference_failed' });
    expectFailed(await w.run(), 'inference_failed');
    expect(w.justifyCalls[0]!.set.order.order_id).toBe(ORDER_ID);
  });
});

describe('the answer of the decision for another choice', () => {
  it('builds the request from the choice that the decision gives: another justification and other references are in the request', async () => {
    const w = world();
    const choice = { justification: 'Criterion C1 is met by the note REC-0002.', guideline_refs: ['C1'], record_refs: ['REC-0002'] };
    w.script.justify = async () => answerFor(choice);
    const result = proposed(await w.run());
    expect(result.document).toMatchObject(choice);
    expect(result.decisions[0]!.choice).toStrictEqual(choice);
  });
});
