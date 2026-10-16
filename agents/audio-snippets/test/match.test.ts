// agents/audio-snippets/test/match.test.ts
import { describe, test, expect } from 'vitest';
import {
  PAD_S, QUERY_MAX_MATCHES, QUERY_MIN_SCORE, QUOTE_MIN_SCORE, STOP_WORDS, bestQuoteWindow, contentWords, cutPoints, findMatches, flatWords, jaccard, round3, tokenStream,
} from '../src/match.ts';
import type { TranscriptSegment } from '../src/match.ts';

const W = (w: string, start: number, end: number) => ({ w, start, end });
/** A segment whose words are 0.3 s apart and 0.25 s long, from `start`. */
const seg = (text: string, start: number): TranscriptSegment => {
  const words = text.split(' ');
  return { start, end: round3(start + words.length * 0.3), text, words: words.map((w, i) => W(w, round3(start + i * 0.3), round3(start + i * 0.3 + 0.25))) };
};
// The transcript of test/golden.ts (Task 5): two segments over 3 s.
const GOLDEN: TranscriptSegment[] = [
  { start: 0, end: 1.2, text: 'This is a LibriVox recording.', words: [W('This', 0.1, 0.25), W('is', 0.25, 0.35), W('a', 0.35, 0.4), W('LibriVox', 0.4, 0.8), W('recording.', 0.8, 1.15)] },
  { start: 1.4, end: 2.95, text: 'All LibriVox recordings are in the public domain.', words: [W('All', 1.45, 1.55), W('LibriVox', 1.55, 1.95), W('recordings', 1.95, 2.3), W('are', 2.3, 2.4), W('in', 2.4, 2.45), W('the', 2.45, 2.5), W('public', 2.5, 2.7), W('domain.', 2.7, 2.9)] },
];

describe('the constants of R-D5', () => {
  test('padding 150 ms, a quote at 0.55, a query segment at 0.2 and at most 3, and the 74 stop words', () => {
    expect([PAD_S, QUOTE_MIN_SCORE, QUERY_MIN_SCORE, QUERY_MAX_MATCHES]).toStrictEqual([0.15, 0.55, 0.2, 3]);
    expect(STOP_WORDS.size).toBe(74);
    for (const word of ['the', 'is', 'what', 'where', 'all', 'in', 'are']) expect(STOP_WORDS.has(word), word).toBe(true);
    for (const word of ['public', 'domain', 'recording', 'here']) expect(STOP_WORDS.has(word), word).toBe(false);
  });
});

describe('findMatches', () => {
  test('the golden request: a quote, a query and a range, in that order, and a quote that is not said in unmatched with its best score', async () => {
    const found = await findMatches({ quotes: ['all LibriVox recordings are in the public domain', 'something never said here'], query: 'where is the public domain mentioned', ranges: [{ start_s: 0.3, end_s: 0.9 }] }, GOLDEN, 3);
    expect(found).toStrictEqual({
      matches: [
        { from: 'quote', start_s: 1.3, end_s: 3, text: 'All LibriVox recordings are in the public domain.', score: 1 },
        { from: 'query', start_s: 1.3, end_s: 3, text: 'All LibriVox recordings are in the public domain.', score: 0.4 },
        { from: 'range', start_s: 0.1, end_s: 1.3, text: 'is a LibriVox recording.', score: 1 },
      ],
      unmatched: [{ from: 'quote', text: 'something never said here', best_score: 0.32 }],
      match_method: 'keyword',
    });
  });

  test('a near quote matches by its ratio: one word spelled otherwise by the model', async () => {
    const t = [{ start: 0, end: 3, text: 'x', words: [W('All', 1.0, 1.1), W('Librevox', 1.1, 1.5), W('recordings', 1.5, 1.9), W('are', 1.9, 2.0), W('in', 2.0, 2.05), W('the', 2.05, 2.1), W('public', 2.1, 2.3), W('domain.', 2.3, 2.6)] }];
    expect((await findMatches({ quotes: ['All LibriVox recordings are in the public domain.'] }, t, 3)).matches).toStrictEqual([
      { from: 'quote', start_s: 0.85, end_s: 2.75, text: 'All Librevox recordings are in the public domain.', score: 0.979 },
    ]);
  });

  // Review Focus 3.
  test('a quote said twice is matched once, where it is said first, and the same on every run', async () => {
    const twice = [seg('the cat sat', 0), seg('and then', 1), seg('the cat sat', 2)];
    const expected = { matches: [{ from: 'quote', start_s: 0, end_s: 1, text: 'the cat sat', score: 1 }], unmatched: [], match_method: null };
    expect(await findMatches({ quotes: ['The cat sat.'] }, twice, 3)).toStrictEqual(expected);
    expect(await findMatches({ quotes: ['The cat sat.'] }, twice, 3)).toStrictEqual(expected);
  });

  test('a word of two tokens matches as one word: a quote cut inside it moves out to its boundaries', async () => {
    const t = [{ start: 0, end: 2, text: 'a well-known fact', words: [W('a', 0, 0.2), W('well-known', 0.2, 0.9), W('fact', 0.9, 1.4)] }];
    expect((await findMatches({ quotes: ['well known'] }, t, 2)).matches).toStrictEqual([{ from: 'quote', start_s: 0.05, end_s: 1.05, text: 'well-known', score: 1 }]);
  });

  test('the query: Jaccard of content words per segment; adjacent segments merge into one match with the higher score', async () => {
    const t = [seg('The weather was fine all week.', 0), seg('Public domain books are free to read.', 3), seg('The public domain grows every year.', 6), seg('Nothing else was said.', 9)];
    expect(await findMatches({ query: 'public domain books' }, t, 12)).toStrictEqual({
      matches: [{ from: 'query', start_s: 2.85, end_s: 7.9, text: 'Public domain books are free to read. The public domain grows every year.', score: 0.6 }],
      unmatched: [], match_method: 'keyword',
    });
  });

  test('the query keeps at most 3 segments, the highest scores, and gives them in the order they are said', async () => {
    const t = [seg('domain', 0), seg('x y', 1), seg('domain law', 2), seg('x y', 3), seg('domain law court', 4), seg('x y', 5), seg('domain law court judge', 6), seg('x y', 7), seg('domain law court judge clerk', 8)];
    expect((await findMatches({ query: 'the domain' }, t, 10)).matches).toStrictEqual([
      { from: 'query', start_s: 0, end_s: 0.4, text: 'domain', score: 1 },
      { from: 'query', start_s: 1.85, end_s: 2.7, text: 'domain law', score: 0.5 },
      { from: 'query', start_s: 3.85, end_s: 5, text: 'domain law court', score: 0.333 },
    ]);
  });

  test('a query no segment reaches is in unmatched with its best score', async () => {
    expect(await findMatches({ query: 'weather report' }, [seg('weather is a big word here today', 0)], 3)).toStrictEqual({
      matches: [], unmatched: [{ from: 'query', text: 'weather report', best_score: 0.167 }], match_method: 'keyword',
    });
  });

  test('ranges: taken as given, the words wholly inside, score 1; one in silence has no text; the cut points are padded and clamped to the media', async () => {
    expect((await findMatches({ ranges: [{ start_s: 2.5, end_s: 2.9 }, { start_s: 0, end_s: 0.05 }, { start_s: 2.95, end_s: 3 }] }, [seg('one two three', 0)], 3)).matches).toStrictEqual([
      { from: 'range', start_s: 2.35, end_s: 3, text: '', score: 1 },
      { from: 'range', start_s: 0, end_s: 0.4, text: 'one', score: 1 },
      { from: 'range', start_s: 2.8, end_s: 3, text: '', score: 1 },
    ]);
  });

  test('an empty transcript: every quote and the query in unmatched with a best score of 0', async () => {
    expect(await findMatches({ quotes: ['anything at all'], query: 'public domain' }, [], 3)).toStrictEqual({
      matches: [], unmatched: [{ from: 'quote', text: 'anything at all', best_score: 0 }, { from: 'query', text: 'public domain', best_score: 0 }], match_method: 'keyword',
    });
  });

  // Review Focus 4: a transcript made in the wrong language matches nothing it should not, and drops nothing it was asked for.
  test('a transcript in another language than the quotes: nothing under its threshold is a match, and every quote and the query is in matches or in unmatched', async () => {
    const german = [seg('Das ist eine Aufnahme von irgendwas', 0), seg('Alle Aufnahmen sind gemeinfrei', 3)];
    const quotes = ['All LibriVox recordings are in the public domain.', 'This is a LibriVox recording.'];
    expect(await findMatches({ quotes, query: 'public domain' }, german, 6)).toStrictEqual({
      matches: [],
      unmatched: [
        { from: 'quote', text: quotes[0], best_score: 0.271 }, { from: 'quote', text: quotes[1], best_score: 0.286 }, { from: 'query', text: 'public domain', best_score: 0 },
      ],
      match_method: 'keyword',
    });
    for (const transcript of [german, GOLDEN, [], [seg('the cat sat on the mat and then the cat sat again', 0)]]) {
      const all = ['the cat sat', 'public domain', 'This is a LibriVox recording.', 'zzz qqq'];
      const found = await findMatches({ quotes: all, query: 'the cat' }, transcript, 10);
      const quoteMatches = found.matches.filter((m) => m.from === 'quote').length;
      const quoteMisses = found.unmatched.filter((u) => u.from === 'quote').map((u) => u.text);
      expect(quoteMatches + quoteMisses.length).toBe(all.length);
      for (const m of found.matches) {
        expect(m.score).toBeGreaterThanOrEqual(m.from === 'quote' ? QUOTE_MIN_SCORE : m.from === 'query' ? QUERY_MIN_SCORE : 1);
        expect(m.start_s).toBeLessThan(m.end_s);
        expect(m.start_s).toBeGreaterThanOrEqual(0);
        expect(m.end_s).toBeLessThanOrEqual(10);
      }
      expect(found.matches.some((m) => m.from === 'query') || found.unmatched.some((u) => u.from === 'query')).toBe(true);
    }
  });

  test('without a query the method is null', async () => {
    expect((await findMatches({ ranges: [{ start_s: 0, end_s: 1 }] }, GOLDEN, 3)).match_method).toBeNull();
  });
});

describe('the parts', () => {
  test('bestQuoteWindow: ties go to the earlier window, then to the shorter one', () => {
    const tokens = tokenStream(flatWords([seg('a b a b', 0)]));
    expect(bestQuoteWindow('a b', tokens)).toStrictEqual({ score: 1, from: 0, to: 1 });
    expect(bestQuoteWindow('a', tokenStream(flatWords([seg('a b', 0)])))).toStrictEqual({ score: 1, from: 0, to: 0 });
    expect(bestQuoteWindow('a', [])).toBeNull();
  });
  test('the windows of a quote of n tokens are floor(0.7 n) to ceil(1.3 n) tokens long', () => {
    // Ten words of the transcript are the quote with three words more: a window of 13 tokens (ceil(1.3 x 10)) holds it all, so the ratio is the one of the extra words.
    const quote = 'one two three four five six seven eight nine ten';
    const t = tokenStream(flatWords([seg('one two three four five six seven eight nine ten', 0)]));
    expect(bestQuoteWindow(quote, t)).toStrictEqual({ score: 1, from: 0, to: 9 });
    expect(bestQuoteWindow('one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen', t)?.to).toBe(9);
  });
  test('contentWords and jaccard', () => {
    expect([...contentWords('What is the public domain?')]).toStrictEqual(['public', 'domain']);
    expect(jaccard(new Set(['a', 'b']), new Set(['b', 'c']))).toBeCloseTo(1 / 3, 12);
    expect(jaccard(new Set(), new Set(['a']))).toBe(0);
  });
  test('cutPoints: an end inside a word moves out to its boundary, then 150 ms each side, clamped to the media', () => {
    const words = flatWords([seg('one two three', 0)]);
    expect(cutPoints(0.1, 0.4, words, 3)).toStrictEqual({ from: 0, to: 0.55, start_s: 0, end_s: 0.7 });
    expect(cutPoints(0.25, 0.26, words, 3)).toStrictEqual({ from: 0.25, to: 0.26, start_s: 0.1, end_s: 0.41 });
    expect(cutPoints(0, 0.85, words, 0.9)).toStrictEqual({ from: 0, to: 0.85, start_s: 0, end_s: 0.9 });
  });
  test('a 300-character quote over 2000 words is found within the budget of a job (it takes a few seconds)', async () => {
    const names = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf'];
    const words = Array.from({ length: 2000 }, (_v, i) => W(`${names[i % 7]}${i % 13}`, round3(i * 0.3), round3(i * 0.3 + 0.25)));
    const quote = 'the quick brown fox jumps over the lazy dog and keeps on running through the field until the sun goes down behind the hills where the river bends and the old mill stands quietly waiting for the morning light to come back again over the meadow full of flowers that bloom in the spring and fade in the late autumn rain'.slice(0, 300);
    const began = Date.now();
    const found = await findMatches({ quotes: [quote] }, [{ start: 0, end: 600, text: 'x', words }], 600);
    expect(found.unmatched).toHaveLength(1);
    expect(Date.now() - began).toBeLessThan(30_000);
  }, 60_000);
});
