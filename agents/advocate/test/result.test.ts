// agents/advocate/test/result.test.ts
// The brief (rulings R-E7 and R-F9): its keys in the order of the spec at every level, as JSON.stringify writes them, which is what the runtime hashes, with
// `inference` last and the sub-job in the key order of the Document Pipeline's sub-jobs; the fixed strings; the declared bias on every brief, with the side as
// the request gave it; and the model named with its path, "<model> via the Vector marketplace" or "<model> via OpenRouter".
import { describe, test, expect } from 'vitest';
import type { Checked } from '../src/check.ts';
import type { Inference } from '../src/inference.ts';
import { DEFAULT_MODEL } from '../src/model.ts';
import type { AdvocateRequest } from '../src/request.ts';
import { SCHEMA, SEARCH_NAME, buildResult, serializeResult } from '../src/result.ts';
import { GOLDEN_RESULT, GOLDEN_SUB_JOB } from './golden.ts';

const REQUEST: AdvocateRequest = { subject: 'Should a city ban cars from its centre?', side: 'for', audience: null, length: 'short', language: 'en' };
const SOURCE = { title: 'T', url: 'https://example.org/a', retrieved_at: '2026-10-17T09:00:00.000Z', quote: 'a quote of twenty or more' };
const CHECKED: Checked = { arguments: [{ claim: 'C.', support: 'S.', sources: [SOURCE] }], sources: [SOURCE], droppedQuotes: 0, droppedArguments: 0 };
/** The inference of a job that went to OpenRouter, and of one that bought its call on the marketplace. */
const OPENROUTER: Inference = { brief: { thesis: 'A thesis.', arguments: [] }, usage: null, path: 'openrouter', model: DEFAULT_MODEL, subJob: null, accepted: null, fallbackFrom: 'llm_supplier_unavailable' };
const MARKETPLACE: Inference = { ...OPENROUTER, path: 'marketplace', subJob: GOLDEN_SUB_JOB, accepted: 'confirmed', fallbackFrom: null };
const SUB_JOB_KEYS = ['capability_id', 'advert_ref', 'escrow_ref', 'supplier_pkh', 'receipt', 'receipt_signature', 'verification'];

describe('the brief', () => {
  test('the schema id, the search and the model it names with its path, and the two fixed statements', () => {
    expect([SCHEMA, SEARCH_NAME]).toStrictEqual(['vector.advocate.brief.v1', 'Brave Search API']);
    const result = buildResult(REQUEST, 'A thesis.', CHECKED, OPENROUTER);
    expect([result.schema, result.search, result.model]).toStrictEqual(['vector.advocate.brief.v1', 'Brave Search API', 'deepseek/deepseek-v4-flash via OpenRouter']);
    expect(result.declared_bias.statement).toBe('This brief argues one side only, by design, and omits counter-arguments.');
    expect(result.omitted_by_design).toBe('counter-arguments and rebuttals');
    expect(buildResult(REQUEST, 'A thesis.', CHECKED, { ...OPENROUTER, model: 'openai/gpt-4o-mini' }).model).toBe('openai/gpt-4o-mini via OpenRouter');
    expect(buildResult(REQUEST, 'A thesis.', CHECKED, MARKETPLACE).model).toBe('deepseek/deepseek-v4-flash via the Vector marketplace');
  });

  test('the keys in the order of the spec, at every level, with inference last, as JSON.stringify writes them', () => {
    const result = buildResult(REQUEST, 'A thesis.', CHECKED, OPENROUTER);
    expect(Object.keys(result)).toStrictEqual(['schema', 'declared_bias', 'thesis', 'arguments', 'sources', 'omitted_by_design', 'search', 'model', 'inference']);
    expect(Object.keys(result.inference)).toStrictEqual(['path', 'fallback_from', 'sub_job', 'accepted']);
    expect(JSON.stringify(result)).toBe(
      '{"schema":"vector.advocate.brief.v1","declared_bias":{"side":"for","statement":"This brief argues one side only, by design, and omits counter-arguments."},'
      + '"thesis":"A thesis.","arguments":[{"claim":"C.","support":"S.","sources":[{"title":"T","url":"https://example.org/a","retrieved_at":"2026-10-17T09:00:00.000Z","quote":"a quote of twenty or more"}]}],'
      + '"sources":[{"title":"T","url":"https://example.org/a","retrieved_at":"2026-10-17T09:00:00.000Z","quote":"a quote of twenty or more"}],'
      + '"omitted_by_design":"counter-arguments and rebuttals","search":"Brave Search API","model":"deepseek/deepseek-v4-flash via OpenRouter",'
      + '"inference":{"path":"openrouter","fallback_from":"llm_supplier_unavailable","sub_job":null,"accepted":null}}',
    );
  });

  test('the sub-job of the marketplace path in the key order of the Pipeline\'s sub-jobs, its receipt and its checks as they are, whatever object it is given', () => {
    const shuffled = Object.fromEntries([['extra', 1], ...Object.entries(GOLDEN_SUB_JOB).reverse()]) as typeof GOLDEN_SUB_JOB;
    const result = buildResult(REQUEST, 'A thesis.', CHECKED, { ...MARKETPLACE, subJob: shuffled });
    expect(Object.keys(result.inference.sub_job ?? {})).toStrictEqual(SUB_JOB_KEYS);
    expect(result.inference).toStrictEqual({ path: 'marketplace', fallback_from: null, sub_job: GOLDEN_SUB_JOB, accepted: 'confirmed' });
    expect(Object.keys(GOLDEN_RESULT.inference.sub_job ?? {})).toStrictEqual(SUB_JOB_KEYS);
    expect(JSON.stringify(result.inference.sub_job)).toBe(JSON.stringify(GOLDEN_SUB_JOB));
    // An Accept sent and not seen confirmed stands: the brief says pending, and a fallback after a settled answer carries its sub-job.
    expect(buildResult(REQUEST, 'A thesis.', CHECKED, { ...MARKETPLACE, accepted: 'pending' }).inference.accepted).toBe('pending');
    expect(buildResult(REQUEST, 'A thesis.', CHECKED, { ...MARKETPLACE, path: 'openrouter', fallbackFrom: 'model_output_invalid' }).inference)
      .toStrictEqual({ path: 'openrouter', fallback_from: 'model_output_invalid', sub_job: GOLDEN_SUB_JOB, accepted: 'confirmed' });
  });

  test('declared_bias.side is the side of the request as it was given: for, against, or a position in words', () => {
    for (const side of ['for', 'against', 'Cities should close one street first, then the rest']) {
      expect(buildResult({ ...REQUEST, side }, 'A thesis.', CHECKED, OPENROUTER).declared_bias).toStrictEqual({ side, statement: 'This brief argues one side only, by design, and omits counter-arguments.' });
    }
  });

  test('every argument and source is written with its own keys only, in their order, whatever the objects it is given hold', () => {
    const loose = { quote: SOURCE.quote, extra: 1, retrieved_at: SOURCE.retrieved_at, url: SOURCE.url, title: SOURCE.title } as unknown as typeof SOURCE;
    const result = buildResult(REQUEST, 'A thesis.', { ...CHECKED, arguments: [{ sources: [loose], support: 'S.', claim: 'C.', note: 'x' } as never], sources: [loose] }, OPENROUTER);
    expect(Object.keys(result.arguments[0])).toStrictEqual(['claim', 'support', 'sources']);
    expect(Object.keys(result.arguments[0].sources[0])).toStrictEqual(['title', 'url', 'retrieved_at', 'quote']);
    expect(Object.keys(result.sources[0])).toStrictEqual(['title', 'url', 'retrieved_at', 'quote']);
    expect(result.sources[0]).toStrictEqual(SOURCE);
  });

  test('the body of the answer is JSON.stringify of the brief, byte for byte, the golden one included', () => {
    const result = buildResult(REQUEST, 'A thesis.', CHECKED, MARKETPLACE);
    expect(serializeResult(result)).toBe(JSON.stringify(result));
    expect(serializeResult(GOLDEN_RESULT).startsWith('{"schema":"vector.advocate.brief.v1","declared_bias":{"side":"for","statement":"This brief argues one side only, by design, and omits counter-arguments."},"thesis":"A city should ban cars')).toBe(true);
    expect(serializeResult(GOLDEN_RESULT).endsWith(',"accepted":"confirmed"}}')).toBe(true);
  });
});
