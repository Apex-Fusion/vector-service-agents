// packages/usecase-kit/test/decision/subjob.test.ts: the sub-job of a decision, built from the record of the hire. hire-kit accepts an escrow only when the eight checks of the receipt pass. This
// code does not trust that: a record with one check missing or not true gives no sub-job, and so no decision. Each refusal has an accepted twin.
import { describe, expect, it } from 'vitest';
import type { HireRecord } from '@vsa/hire-kit';
import { RECEIPT_CHECKS } from '@vsa/usecase-kit/protocol';
import { subJobOf } from '../../src/decision/subjob.ts';

const MARKER = 'ZQ9-marker-7f3';
const ADVERT = `${'b2'.repeat(32)}#1`;
const ESCROW = `${'aa'.repeat(32)}#0`;
const PKH = '11'.repeat(28);
const allTrue = (): Record<string, boolean> => Object.fromEntries(RECEIPT_CHECKS.map((check) => [check, true]));

/** A record of a hire that completed, with the members of `over` written over it. `over` may hold a value that the type of a record does not allow: a test writes what a defect could give. */
const record = (over: Record<string, unknown> = {}): HireRecord => ({
  capability_id: 'llm.text.generate.v1',
  advert_ref: ADVERT,
  escrow_ref: ESCROW,
  supplier_pkh: PKH,
  receipt: { escrow_ref: ESCROW, supplier_pkh: PKH, prompt_hash: '33'.repeat(32), response_hash: '44'.repeat(32), model: 'a/b', prompt_tokens: 1, completion_tokens: 2, wallclock_ms: 3 },
  receipt_signature: '22'.repeat(64),
  verification: allTrue(),
  ...over,
}) as HireRecord;

describe('subJobOf', () => {
  it('builds the sub-job of the protocol from a record in which all eight checks are true', () => {
    const source = record();
    const result = subJobOf(source);
    expect(result).toStrictEqual({
      ok: true,
      value: { capability_id: 'llm.text.generate.v1', advert_ref: ADVERT, escrow_ref: ESCROW, supplier_pkh: PKH, receipt: source.receipt, receipt_signature: '22'.repeat(64), verification: allTrue() },
    });
    if (!result.ok) return;
    // The receipt is a copy, and the verification has the eight checks in the order of the protocol and no other member.
    expect(result.value.receipt).not.toBe(source.receipt);
    expect(Object.keys(result.value.verification)).toStrictEqual([...RECEIPT_CHECKS]);
  });

  it.each(RECEIPT_CHECKS)('gives no sub-job when the check %s is false: llm_receipt_failed, and the detail names it', (check) => {
    const result = subJobOf(record({ verification: { ...allTrue(), [check]: false } }));
    expect(result).toMatchObject({ ok: false, code: 'llm_receipt_failed' });
    if (!result.ok) expect(result.detail).toBe(`the receipt did not pass the checks ${check}`);
  });

  it('names every check that is false', () => {
    const result = subJobOf(record({ verification: { ...allTrue(), signature_valid: false, model_matches: false } }));
    expect(result).toMatchObject({ ok: false, code: 'llm_receipt_failed', detail: 'the receipt did not pass the checks signature_valid, model_matches' });
  });

  it.each(RECEIPT_CHECKS)('gives no sub-job when the check %s is missing: llm_bad_result, and a missing check is never a pass', (check) => {
    const { [check]: _removed, ...rest } = allTrue();
    expect(subJobOf(record({ verification: rest }))).toMatchObject({ ok: false, code: 'llm_bad_result', detail: `the record of the hire has no result for the check ${check}` });
  });

  it.each<[string, unknown]>([
    ['the text true', 'true'], ['the number 1', 1], ['null', null], ['undefined', undefined], ['an object', { pass: true }],
  ])('gives no sub-job when a check is %s and not the boolean true', (_name, value) => {
    expect(subJobOf(record({ verification: { ...allTrue(), fields_match: value } }))).toMatchObject({ ok: false, code: 'llm_bad_result' });
  });

  it.each<[string, unknown]>([['undefined', undefined], ['null', null], ['a text', 'verified'], ['a number', 1]])('gives no sub-job when the verification is %s', (_name, verification) => {
    expect(subJobOf(record({ verification }))).toMatchObject({ ok: false, code: 'llm_bad_result', detail: 'the record of the hire has no verification' });
  });

  it('reports a check that is false before a member that has the wrong form', () => {
    expect(subJobOf(record({ verification: { ...allTrue(), signature_valid: false }, escrow_ref: 'x' }))).toMatchObject({ ok: false, code: 'llm_receipt_failed' });
  });

  it('ignores a member of the verification that is not one of the eight: the verification of the protocol has the eight', () => {
    const result = subJobOf(record({ verification: { ...allTrue(), note: false } }));
    expect(result.ok).toBe(true);
  });

  it.each<[string, Record<string, unknown>, string]>([
    ['an advert reference in upper case', { advert_ref: ADVERT.toUpperCase() }, 'advert_ref'],
    ['an advert reference with no index', { advert_ref: 'b2'.repeat(32) }, 'advert_ref'],
    ['an escrow reference with a leading zero in the index', { escrow_ref: `${'aa'.repeat(32)}#01` }, 'escrow_ref'],
    ['an escrow reference that is too short', { escrow_ref: `${'aa'.repeat(31)}#0` }, 'escrow_ref'],
    ['an escrow reference that is not a text', { escrow_ref: 7 }, 'escrow_ref'],
    ['a supplier key hash of 55 characters', { supplier_pkh: '11'.repeat(27) + '1' }, 'supplier key hash'],
    ['a supplier key hash in upper case', { supplier_pkh: 'AB'.repeat(28) }, 'supplier key hash'],
    ['no supplier key hash', { supplier_pkh: undefined }, 'supplier key hash'],
    ['an empty capability', { capability_id: '' }, 'no capability'],
    ['a capability that is not a text', { capability_id: 3 }, 'no capability'],
    ['an empty signature', { receipt_signature: '' }, 'no signature'],
    ['a signature that is not a text', { receipt_signature: 3 }, 'no signature'],
    ['a receipt that is a list', { receipt: [1] }, 'receipt'],
    ['a receipt that is a text', { receipt: `${MARKER} receipt` }, 'receipt'],
    ['a receipt that is null', { receipt: null }, 'receipt'],
    ['a receipt with a number that is not finite', { receipt: { prompt_tokens: Number.NaN } }, 'receipt'],
    ['a receipt with an object of a class', { receipt: { when: new Date(0) } }, 'receipt'],
  ])('gives no sub-job for %s: llm_bad_result, and a detail that never repeats the value', (_name, over, member) => {
    const result = subJobOf(record(over));
    expect(result).toMatchObject({ ok: false, code: 'llm_bad_result' });
    if (result.ok) return;
    expect(result.detail).toContain(member);
    expect(result.detail).not.toContain(MARKER);
  });

  it('never repeats a value of a record that has the wrong form', () => {
    for (const field of ['advert_ref', 'escrow_ref', 'supplier_pkh', 'capability_id', 'receipt_signature']) {
      const result = subJobOf(record({ [field]: field === 'capability_id' || field === 'receipt_signature' ? 7 : `${MARKER}` }));
      expect(JSON.stringify(result), field).not.toContain(MARKER);
    }
  });
});
