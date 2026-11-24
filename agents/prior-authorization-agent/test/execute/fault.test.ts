// agents/prior-authorization-agent/test/execute/fault.test.ts: the fault `alter_after_approval` as a function. `alterJustification` replaces the last sentence of the justification with a fixed synthetic
// sentence. The result is never the input, it always fits the limit of the request, the request parser always takes it, and every other member of the request stays as it is. The golden file pins the
// text that it gives for the hard cases: one sentence, no end mark, abbreviations, line breaks and the sentences that are the fixed ones.
import { describe, expect, it } from 'vitest';
import { ALTERED_SENTENCE, MAX_JUSTIFICATION_CHARS, SECOND_ALTERED_SENTENCE, alterJustification, parsePriorAuthRequest } from '@vsa/usecase-kit/priorauth';
import type { PriorAuthRequest } from '@vsa/usecase-kit/priorauth';
import { proposalDigest } from '@vsa/usecase-kit/protocol';
import { SALT, golden, requestDocument, requestHash, typedRequest } from './fixtures.ts';

/** The request of the tests with another justification. */
const withText = (justification: string): PriorAuthRequest => typedRequest(requestDocument({ justification }));

/** The number of code points of a text, as the request parser counts them. */
const pointsIn = (text: string): number => Array.from(text).length;

const digestOf = (document: unknown): string => {
  const digest = proposalDigest(SALT, document);
  if (!digest.ok) throw new Error(`the digest of the test is refused: ${digest.detail}`);
  return digest.value;
};

/** What every result of `alterJustification` must be, whatever its input is. */
function expectAltered(before: PriorAuthRequest, after: PriorAuthRequest): void {
  const parsed = parsePriorAuthRequest(after);
  expect(parsed.ok, 'the request parser takes the altered request').toBe(true);
  expect(after.justification).not.toBe(before.justification);
  expect(pointsIn(after.justification)).toBeLessThanOrEqual(MAX_JUSTIFICATION_CHARS);
  expect(after.justification.length).toBeGreaterThan(0);
  expect([ALTERED_SENTENCE, SECOND_ALTERED_SENTENCE].some((sentence) => after.justification.endsWith(sentence))).toBe(true);
  const { justification: _before, ...rest } = before;
  const { justification: _after, ...restAfter } = after;
  expect(restAfter).toStrictEqual(rest);
  expect(requestHash(after)).not.toBe(requestHash(before));
  expect(digestOf(after)).not.toBe(digestOf(before));
}

describe('the fixed sentences', () => {
  it('are two different sentences, each of one sentence, in plain ASCII', () => {
    expect(ALTERED_SENTENCE).not.toBe(SECOND_ALTERED_SENTENCE);
    for (const sentence of [ALTERED_SENTENCE, SECOND_ALTERED_SENTENCE]) {
      expect(sentence).toMatch(/^[A-Za-z]+(?: [A-Za-z]+)*\.$/);
      expect(sentence.length).toBeLessThan(100);
    }
  });
});

describe('the text of the justification after the fault', () => {
  const PAIRS = golden('alter-justification.json') as Array<{ name: string; justification: string; altered: string }>;

  it('has the pairs of the golden file', () => {
    expect(PAIRS.length).toBeGreaterThanOrEqual(10);
  });

  for (const pair of PAIRS) {
    it(`is the text of the golden file: ${pair.name}`, () => {
      const before = withText(pair.justification);
      const after = alterJustification(before);
      expect(after.justification).toBe(pair.altered);
      expectAltered(before, after);
    });
  }

  it('gives the golden altered request for the golden request, and no other member changes', () => {
    const before = typedRequest(golden('request.json') as Record<string, unknown>);
    expect(alterJustification(before)).toStrictEqual(typedRequest(golden('request-altered.json') as Record<string, unknown>));
  });

  it('changes again when it is applied again: the last sentence is then the fixed one, so the second fixed sentence comes', () => {
    const once = alterJustification(withText('Pain persists. It is worse.'));
    const twice = alterJustification(once);
    expect(once.justification.endsWith(ALTERED_SENTENCE)).toBe(true);
    expect(twice.justification).toBe(`Pain persists. ${SECOND_ALTERED_SENTENCE}`);
    expect(twice.justification).not.toBe(once.justification);
    expectAltered(once, twice);
  });

  it('does not change its input and gives a request that shares no list with it', () => {
    const before = typedRequest();
    const copy = structuredClone(before);
    const after = alterJustification(before);
    expect(before).toStrictEqual(copy);
    expect(after.diagnosis_codes).not.toBe(before.diagnosis_codes);
    expect(after.guideline_refs).not.toBe(before.guideline_refs);
    expect(after.record_refs).not.toBe(before.record_refs);
    expect(after.diagnosis_codes).toStrictEqual(before.diagnosis_codes);
  });
});

describe('the limit of the justification', () => {
  const FIXED = ALTERED_SENTENCE.length;
  /** A first sentence that, with the fixed sentence after it, has exactly `total` characters. The text of the test adds "Ok." as its last sentence. */
  const headOf = (total: number): string => `${'A'.repeat(total - FIXED - 2)}. `;

  it('keeps every sentence that fits: a result of exactly the limit is not cut', () => {
    const head = headOf(MAX_JUSTIFICATION_CHARS);
    const before = withText(`${head}Ok.`);
    const after = alterJustification(before);
    expect(after.justification).toBe(`${head}${ALTERED_SENTENCE}`);
    expect(pointsIn(after.justification)).toBe(MAX_JUSTIFICATION_CHARS);
    expectAltered(before, after);
  });

  it('drops the first sentences when the result is one character too long, and keeps the fixed sentence', () => {
    const head = headOf(MAX_JUSTIFICATION_CHARS + 1);
    const before = withText(`${head}Ok.`);
    expect(pointsIn(before.justification)).toBeLessThanOrEqual(MAX_JUSTIFICATION_CHARS);
    const after = alterJustification(before);
    // The first sentence is the whole head, so the fixed sentence stands alone.
    expect(after.justification).toBe(ALTERED_SENTENCE);
    expectAltered(before, after);
  });

  it('drops the fewest first sentences that make the result fit, for a text of 4,000 characters', () => {
    const sentence = 'Pain persists for six weeks. ';
    const last = `${'B'.repeat(MAX_JUSTIFICATION_CHARS - sentence.length * 137 - 1)}.`;
    const text = `${sentence.repeat(137)}${last}`;
    expect(text.length).toBe(MAX_JUSTIFICATION_CHARS);
    const before = withText(text);
    const after = alterJustification(before);
    // 137 sentences of 29 characters and the fixed sentence are 4,018 characters, so one sentence goes and 136 stay.
    expect(after.justification).toBe(`${sentence.repeat(136)}${ALTERED_SENTENCE}`);
    expect(after.justification.length).toBe(sentence.length * 136 + FIXED);
    expectAltered(before, after);
  });

  it('counts code points and not code units: a sentence of astral characters stays when it fits', () => {
    const sentence = `${'\u{1F600}'.repeat(1990)}. `;
    const before = withText(`${sentence}${sentence}Ok.`);
    expect(before.justification.length).toBeGreaterThan(MAX_JUSTIFICATION_CHARS);
    expect(pointsIn(before.justification)).toBeLessThanOrEqual(MAX_JUSTIFICATION_CHARS);
    const after = alterJustification(before);
    // The first sentence goes (3,984 and 45 points are too many), and the second stays (1,992 and 45 points fit). A count of code units would drop it too.
    expect(after.justification).toBe(`${sentence}${ALTERED_SENTENCE}`);
    expectAltered(before, after);
  });

  it('twin: a justification of one sentence of the limit is not cut but replaced', () => {
    const before = withText('C'.repeat(MAX_JUSTIFICATION_CHARS - 1) + '.');
    const after = alterJustification(before);
    expect(after.justification).toBe(ALTERED_SENTENCE);
    expectAltered(before, after);
  });
});

/** A small deterministic generator (mulberry32), so that a failure repeats. */
function random(start: number): () => number {
  let state = start >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

describe('the result for any text that the request parser takes', () => {
  const WORDS = ['pain', 'persists', 'weeks', 'therapy', 'Dr.', 'failed', '3.5', 'ok', 'left', 'leg', 'again', 'e.g.', 'x-ray', 'no', 'change', 'since', 'May'];
  const ENDS = ['.', '!', '?', '...', '?!', '', ';', '.)'];
  const GAPS = [' ', '\n', ' \n', '\u00a0', '  ', '\n\n'];

  function sentence(pick: () => number): string {
    const count = 1 + Math.floor(pick() * 10);
    const words = Array.from({ length: count }, () => WORDS[Math.floor(pick() * WORDS.length)]!);
    return `${words.join(' ')}${ENDS[Math.floor(pick() * ENDS.length)]!}`;
  }

  function text(pick: () => number, limit: number): string {
    let out = '';
    const wanted = 1 + Math.floor(pick() * 60);
    for (let index = 0; index < wanted; index += 1) {
      const next = `${index === 0 ? '' : GAPS[Math.floor(pick() * GAPS.length)]!}${sentence(pick)}`;
      if (out.length + next.length > limit) break;
      out += next;
    }
    return out.length === 0 ? 'Ok.' : out;
  }

  it('is a different text, a request that the parser takes, and the same other members, for 300 texts of every length up to the limit', () => {
    const pick = random(20_261_124);
    for (let index = 0; index < 300; index += 1) {
      const limit = index % 3 === 0 ? MAX_JUSTIFICATION_CHARS : 40 + Math.floor(pick() * 1500);
      const before = withText(text(pick, limit));
      const after = alterJustification(before);
      expectAltered(before, after);
      // The text before the last sentence is a part of the original text.
      const kept = after.justification.slice(0, after.justification.length - (after.justification.endsWith(ALTERED_SENTENCE) ? ALTERED_SENTENCE : SECOND_ALTERED_SENTENCE).length);
      expect(before.justification.includes(kept), `the kept text is a part of the original (case ${index})`).toBe(true);
      expect(alterJustification(after).justification).not.toBe(after.justification);
    }
  });

  it('is a different text for a text that fills the limit', () => {
    const pick = random(7);
    for (let index = 0; index < 20; index += 1) {
      let out = '';
      while (out.length < MAX_JUSTIFICATION_CHARS - 40) out += `${out === '' ? '' : ' '}${sentence(pick)}`;
      const before = withText(out.slice(0, MAX_JUSTIFICATION_CHARS));
      expectAltered(before, alterJustification(before));
    }
  });
});
