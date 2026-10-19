// agents/advocate/test/model.test.ts
// The one model call of a job (ruling R-E5), through a fake fetch that records what it is sent: the request (the URL, the headers with the key, the body in
// its order), the content and the usage of an answer, every failure (not 200, not JSON, no content, the network, the caller gone, and no answer in time:
// deadline when the deadline had cut the time of the call, model_failed at the full 90 s, ruling R-E19) with its log line; and the reading of the content into
// a brief (Review Focus 3, ruling R-E20): code fences and prose around the JSON, what is left out as blank, and every shape that is refused. No log line and
// no error carries the key, even when the far end echoes it. The request is sent with redirect 'error', and the body of an answer is read through its stream
// under a cap of 4 MiB, an answer past it being a failed call (ruling R-E23). No log line and no detail carries the text of an answer of status 200, which may
// quote a page: they give its length and the reason only, and only an answer that is not 200, the provider's error, shows words of its body (ruling R-E26):
// the code and the message of the JSON of an error and never its metadata, or else the start of the body (ruling R-E30).
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, test, expect } from 'vitest';
import { operatorsText } from '@vsa/service-kit';
import { MODEL_MAX_MS } from '../src/budget.ts';
import { AdvocateError } from '../src/errors.ts';
import { ANSWER_MAX_BYTES, DEFAULT_MODEL, OPENROUTER_ENDPOINT, callModel, modelLabel, openRouterModel, parseBriefAnswer } from '../src/model.ts';
import type { ModelOptions } from '../src/model.ts';
import type { ChatMessage } from '../src/prompt.ts';
import { at, reply, routedFetch } from './fake-fetch.ts';

/** A key in the form of OpenRouter's, made at run time from a label, so that none is written in the repository. */
const KEY = `sk-or-v1-${createHash('sha256').update('advocate model test: the OpenRouter key').digest('hex')}`;
const MESSAGES: ChatMessage[] = [{ role: 'system', content: 'The system prompt.' }, { role: 'user', content: 'The user message.' }];
const FIXTURE = readFileSync(new URL('./fixtures/model-answer.json', import.meta.url), 'utf8');
const FIXTURE_CONTENT = (JSON.parse(FIXTURE) as { choices: Array<{ message: { content: string } }> }).choices[0].message.content;

interface Sent { url: string; init: RequestInit }
/** A fetch that records each call and answers it with `answer`; a call whose signal is already aborted is refused with its reason, as fetch does. */
function fakeFetch(answer: (init: RequestInit) => Response | Promise<Response>): { fetchImpl: typeof fetch; sent: Sent[] } {
  const sent: Sent[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    sent.push({ url: String(input), init });
    if (init.signal?.aborted === true) throw init.signal.reason;
    return answer(init);
  }) as typeof fetch;
  return { fetchImpl, sent };
}
const respond = (status: number, body: string): Response => new Response(body, { status, headers: { 'content-type': 'application/json' } });
const withContent = (content: unknown, usage?: unknown): string =>
  JSON.stringify({ id: 'gen-2', choices: [{ message: { role: 'assistant', content } }], ...(usage === undefined ? {} : { usage }) });
/** An answer that never comes: it waits for the signal of the call and rejects with its reason, as fetch does. */
const untilAborted = (init: RequestInit): Promise<Response> => new Promise((_resolve, reject) => {
  init.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
});

/** One call with the options of a short brief, and the log lines it wrote. */
function call(fetchImpl: typeof fetch, over: Partial<ModelOptions> = {}): { result: Promise<{ content: string; usage: unknown }>; lines: string[] } {
  const lines: string[] = [];
  const result = callModel(MESSAGES, { fetchImpl, apiKey: KEY, model: DEFAULT_MODEL, maxTokens: 2000, timeoutMs: 90_000, log: (line) => lines.push(line), ...over });
  return { result, lines };
}
async function failureOf(work: Promise<unknown>): Promise<AdvocateError> {
  try { await work; } catch (e) { if (e instanceof AdvocateError) return e; throw e; }
  throw new Error('it did not fail');
}
function refusalOf(fn: () => unknown): AdvocateError {
  try { fn(); } catch (e) { if (e instanceof AdvocateError) return e; throw e; }
  throw new Error('it was accepted');
}
/** Does `text` show any part of the key worth a search, in any case? */
const showsKey = (text: string): boolean => text.toLowerCase().includes(KEY.slice(-24).toLowerCase());

describe('callModel: the request', () => {
  test('one POST to the chat completions of OpenRouter, with the key as a bearer token, the four headers of R-E5 and the body of R-E5 in its order', async () => {
    const { fetchImpl, sent } = fakeFetch(() => respond(200, FIXTURE));
    await call(fetchImpl).result;
    expect(sent).toHaveLength(1);
    const [{ url, init }] = sent;
    expect([url, init.method]).toStrictEqual(['https://openrouter.ai/api/v1/chat/completions', 'POST']);
    expect(OPENROUTER_ENDPOINT).toBe(url);
    expect(Object.fromEntries(new Headers(init.headers))).toStrictEqual({
      authorization: `Bearer ${KEY}`, 'content-type': 'application/json', 'http-referer': 'https://github.com/Apex-Fusion/vector-service-agents', 'x-title': 'Advocate (vector-service-agents)',
    });
    expect(init.body).toBe('{"model":"deepseek/deepseek-v4-flash","messages":[{"role":"system","content":"The system prompt."},{"role":"user","content":"The user message."}],"temperature":0,"max_tokens":2000,"response_format":{"type":"json_object"}}');
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  test('the model and the token limit are the ones it is given', async () => {
    const { fetchImpl, sent } = fakeFetch(() => respond(200, FIXTURE));
    await call(fetchImpl, { model: 'openai/gpt-4o-mini', maxTokens: 4500 }).result;
    expect(JSON.parse(String(sent[0].init.body))).toMatchObject({ model: 'openai/gpt-4o-mini', max_tokens: 4500 });
  });

  test('no redirect is followed, for it would carry the key to another host (R-E23): the request says so, and an answer that redirects is model_failed (502)', async () => {
    const elsewhere = 'https://elsewhere.example/api/v1/chat/completions';
    const fetchImpl = routedFetch([
      { match: at(OPENROUTER_ENDPOINT), respond: () => reply(302, null, { location: elsewhere }) },
      { match: at(elsewhere), respond: () => reply(200, FIXTURE, { 'content-type': 'application/json' }) },
    ]);
    const { result, lines } = call(fetchImpl);
    const e = await failureOf(result);
    expect([e.code, e.status, e.detail]).toStrictEqual(['model_failed', 502, 'OpenRouter answered HTTP 302']);
    expect(lines).toStrictEqual(['model: OpenRouter answered HTTP 302: (no body)']);
    expect(fetchImpl.calls.map((sent) => [sent.url, sent.init?.redirect])).toStrictEqual([[OPENROUTER_ENDPOINT, 'error']]);
  });
});

describe('callModel: the answer', () => {
  test('the content of the first choice as it came and the two counts of the usage, with no log line', async () => {
    const { fetchImpl } = fakeFetch(() => respond(200, FIXTURE));
    const { result, lines } = call(fetchImpl);
    expect(await result).toStrictEqual({ content: FIXTURE_CONTENT, usage: { prompt_tokens: 4321, completion_tokens: 512 } });
    expect(lines).toStrictEqual([]);
  });

  test('a usage that is missing, or whose counts are not two whole numbers, is null, and the content comes back all the same', async () => {
    for (const usage of [undefined, null, {}, { prompt_tokens: 10 }, { prompt_tokens: 10, completion_tokens: -1 }, { prompt_tokens: 1.5, completion_tokens: 2 }, { prompt_tokens: '10', completion_tokens: 2 }]) {
      const { fetchImpl } = fakeFetch(() => respond(200, withContent('{"thesis":"T."}', usage)));
      expect(await call(fetchImpl).result, JSON.stringify(usage)).toStrictEqual({ content: '{"thesis":"T."}', usage: null });
    }
  });

  test('a content in code fences, or with prose around the JSON, comes back as it came, and parseBriefAnswer reads the object in it', async () => {
    const brief = { thesis: 'T.', arguments: [{ claim: 'C.', support: 'S.', sources: [{ n: 1, quote: 'a quote of the first source' }] }] };
    const json = JSON.stringify(brief, null, 2);
    const contents = [
      `\`\`\`json\n${json}\n\`\`\``,
      `\`\`\`\n${json}\n\`\`\``,
      `Here is the brief you asked for:\n\n${json}\n\nIt argues one side.`,
      `\`\`\`json\n${json}\n\`\`\`\nThat is the whole brief.`,
    ];
    for (const content of contents) {
      const { fetchImpl } = fakeFetch(() => respond(200, withContent(content)));
      const { content: back } = await call(fetchImpl).result;
      expect(back).toBe(content);
      expect(parseBriefAnswer(back), content).toStrictEqual(brief);
    }
  });

  test('the body is decoded as Response.text() decodes it (R-E23): UTF-8 whole across the chunks it came in, even one byte at a time, and a byte order mark dropped', async () => {
    const text = `${String.fromCodePoint(0x10d, 0x20ac, 0x1f600)} done`; // a character of two bytes, one of three and one of four
    const bytes = new TextEncoder().encode(withContent(text));
    const bom = Uint8Array.from([0xef, 0xbb, 0xbf]);
    const bytewise = (body: Uint8Array): Response => new Response(new ReadableStream<Uint8Array>({
      start(controller) { for (const byte of body) controller.enqueue(Uint8Array.of(byte)); controller.close(); },
    }), { status: 200 });
    for (const body of [bytes, Uint8Array.from([...bom, ...bytes])]) {
      const { content } = await call(fakeFetch(() => bytewise(body)).fetchImpl).result;
      expect(content).toBe(text);
    }
  });
});

describe('callModel: what fails, with its log line, and never the key', () => {
  test('an answer that is not 200 is model_failed (502); the log line has the status, then the code and the message of an error of the provider, or else the first 200 characters of the body, with the key cut out (R-E30)', async () => {
    const echo = JSON.stringify({ error: { message: `No auth credentials found for ${KEY} or ${KEY.toUpperCase()}`, code: 401 } });
    const long = `{"error":"${'x'.repeat(600)}"}`;
    const cases: Array<[number, string, string]> = [
      [401, echo, 'model: OpenRouter answered HTTP 401 with the error code 401: No auth credentials found for [the key] or [the key]'],
      [500, long, `model: OpenRouter answered HTTP 500: ${long.slice(0, 200)}...`],
      [503, '', 'model: OpenRouter answered HTTP 503: (no body)'],
    ];
    for (const [status, body, line] of cases) {
      const { fetchImpl } = fakeFetch(() => respond(status, body));
      const { result, lines } = call(fetchImpl);
      const e = await failureOf(result);
      expect([e.code, e.status, e.detail]).toStrictEqual(['model_failed', 502, `OpenRouter answered HTTP ${status}`]);
      expect(lines).toStrictEqual([line]);
      expect(showsKey(`${lines.join('\n')} ${e.detail} ${e.message}`)).toBe(false);
    }
  });

  test('a body that is not JSON, or an answer without a string at choices[0].message.content, is model_failed; the log line gives the length of the body, never its text (R-E26)', async () => {
    const noContent = 'the answer of OpenRouter has no choices[0].message.content';
    const cases: Array<[string, string]> = [
      ['not json at all', 'the answer of OpenRouter is not JSON'],
      ['{}', noContent],
      [JSON.stringify({ choices: [] }), noContent],
      [JSON.stringify({ choices: [{ text: 'a completion of another kind' }] }), noContent],
      [JSON.stringify({ choices: [{ message: { role: 'assistant', content: 5 } }] }), noContent],
      [JSON.stringify({ choices: [{ message: { role: 'assistant', content: null } }] }), noContent],
      [JSON.stringify({ error: { message: 'Provider returned error', code: 502 } }), noContent],
    ];
    for (const [body, detail] of cases) {
      const { fetchImpl } = fakeFetch(() => respond(200, body));
      const { result, lines } = call(fetchImpl);
      const e = await failureOf(result);
      expect([e.code, e.status, e.detail], body).toStrictEqual(['model_failed', 502, detail]);
      expect(lines).toStrictEqual([`model: ${detail} (HTTP 200, a body of ${[...body].length} characters)`]);
    }
  });

  test('no answer within a time the deadline of the job cut under 90 s is deadline (422) (R-E19), and the call is cut when that time is up', async () => {
    const { fetchImpl, sent } = fakeFetch(untilAborted);
    const { result, lines } = call(fetchImpl, { timeoutMs: 50 });
    const e = await failureOf(result);
    expect([e.code, e.status, e.detail]).toStrictEqual(['deadline', 422, 'the model did not answer within the 50 ms the deadline of the job left it']);
    expect(lines).toStrictEqual(['model: OpenRouter did not answer within 50 ms']);
    expect(sent[0].init.signal?.aborted).toBe(true);
  });

  test('a caller who has not hung up leaves the call its time, the shape the service runs it in: with a caller signal and 50 ms, no answer is deadline (422), and the call is cut, not the caller', async () => {
    const caller = new AbortController();
    const { fetchImpl, sent } = fakeFetch(untilAborted);
    const { result, lines } = call(fetchImpl, { timeoutMs: 50, signal: caller.signal });
    const e = await failureOf(result);
    expect([e.code, e.status, e.detail]).toStrictEqual(['deadline', 422, 'the model did not answer within the 50 ms the deadline of the job left it']);
    expect(lines).toStrictEqual(['model: OpenRouter did not answer within 50 ms']);
    expect([sent[0].init.signal?.aborted, caller.signal.aborted]).toStrictEqual([true, false]);
  });

  test('an answer that is not 200 is model_failed whatever other 2xx it is (R-E5)', async () => {
    for (const status of [201, 202, 206]) {
      const { fetchImpl } = fakeFetch(() => respond(status, FIXTURE));
      const { result, lines } = call(fetchImpl);
      const e = await failureOf(result);
      expect([e.code, e.status, e.detail], String(status)).toStrictEqual(['model_failed', 502, `OpenRouter answered HTTP ${status}`]);
      expect(lines, String(status)).toHaveLength(1);
    }
  });

  test('no answer within the full 90 s is model_failed (502): the model had all the time a call gets', async () => {
    expect(MODEL_MAX_MS).toBe(90_000);
    // The rejection fetch gives at the end of AbortSignal.timeout, at once, so that the test does not wait the 90 s.
    const { fetchImpl } = fakeFetch(() => Promise.reject(new DOMException('The operation was aborted due to timeout', 'TimeoutError')));
    const { result, lines } = call(fetchImpl, { timeoutMs: MODEL_MAX_MS });
    const e = await failureOf(result);
    expect([e.code, e.status, e.detail]).toStrictEqual(['model_failed', 502, 'OpenRouter did not answer within 90000 ms']);
    expect(lines).toStrictEqual(['model: OpenRouter did not answer within 90000 ms']);
    const cut = fakeFetch(() => Promise.reject(new DOMException('The operation was aborted due to timeout', 'TimeoutError')));
    expect((await failureOf(call(cut.fetchImpl, { timeoutMs: MODEL_MAX_MS - 1 }).result)).code).toBe('deadline');
  });

  test('a network failure is model_failed with what it said, the key cut out of it', async () => {
    const { fetchImpl } = fakeFetch(() => { throw new TypeError(`fetch failed (${KEY})`); });
    const { result, lines } = call(fetchImpl);
    const e = await failureOf(result);
    expect([e.code, e.status, e.detail]).toStrictEqual(['model_failed', 502, 'the call to OpenRouter failed: fetch failed ([the key])']);
    expect(lines).toStrictEqual(['model: the call to OpenRouter failed: fetch failed ([the key])']);
  });

  test('a caller that hangs up while the call runs stops it: aborted (499), with no line of a failure; a caller gone before the call is the same', async () => {
    const caller = new AbortController();
    const { fetchImpl, sent } = fakeFetch((init) => { const waiting = untilAborted(init); caller.abort(); return waiting; });
    const { result, lines } = call(fetchImpl, { signal: caller.signal });
    const e = await failureOf(result);
    expect([e.code, e.status]).toStrictEqual(['aborted', 499]);
    expect([lines, sent[0].init.signal?.aborted]).toStrictEqual([[], true]);
    const gone = new AbortController();
    gone.abort();
    const before = call(fakeFetch(() => respond(200, FIXTURE)).fetchImpl, { signal: gone.signal });
    expect((await failureOf(before.result)).code).toBe('aborted');
    expect(before.lines).toStrictEqual([]);
  });

  test('a body that stops coming is cut by the time of the call like an answer that never starts: deadline (422) under 90 s, aborted (499) when the caller hangs up', async () => {
    /** An answer whose head has come and whose body then waits: its stream fails with the reason of the signal when that aborts, as the stream of a fetch does. */
    const stalling = (init: RequestInit): Response => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"choices":['));
        init.signal?.addEventListener('abort', () => controller.error(init.signal?.reason), { once: true });
      },
    }), { status: 200 });
    const cut = call(fakeFetch(stalling).fetchImpl, { timeoutMs: 50 });
    const e = await failureOf(cut.result);
    expect([e.code, e.status, e.detail]).toStrictEqual(['deadline', 422, 'the model did not answer within the 50 ms the deadline of the job left it']);
    expect(cut.lines).toStrictEqual(['model: OpenRouter did not answer within 50 ms']);
    const caller = new AbortController();
    const hungUp = call(fakeFetch((init) => { const res = stalling(init); caller.abort(); return res; }).fetchImpl, { signal: caller.signal });
    const f = await failureOf(hungUp.result);
    expect([f.code, f.status, hungUp.lines]).toStrictEqual(['aborted', 499, []]);
  });
});

describe('callModel: the size of the answer (R-E23)', () => {
  /** The cap as the ruling states it, 4 MiB. Every body below is sized from this number, never from the constant under test (the first test pins that one), so that a wrong constant fails a test and cannot make a body endless. */
  const CAP = 4_194_304;
  /** A whole answer of OpenRouter of exactly `bytes` bytes, all ASCII: the text of its one choice makes up the length. */
  const answerOf = (bytes: number): string => withContent('x'.repeat(bytes - withContent('').length));
  const OVER = 'the answer of OpenRouter is over the cap of 4194304 bytes';

  test('the cap is 4 MiB: an answer of exactly that many bytes is read, one byte more is model_failed (502) and the detail says the cap', async () => {
    expect(ANSWER_MAX_BYTES).toBe(CAP);
    const atCap = await call(fakeFetch(() => respond(200, answerOf(CAP))).fetchImpl).result;
    expect(atCap.content.length).toBe(CAP - withContent('').length);
    const { result, lines } = call(fakeFetch(() => respond(200, answerOf(CAP + 1))).fetchImpl);
    const e = await failureOf(result);
    expect([e.code, e.status, e.detail]).toStrictEqual(['model_failed', 502, OVER]);
    expect(lines).toHaveLength(1);
  });

  test('an answer over the cap is model_failed whatever its status; the log line has the status, then the start of the body with the key cut out when it is not 200, and only how much was read when it is (R-E26)', async () => {
    const body = `${KEY} ${'x'.repeat(CAP)}`;
    for (const status of [200, 503]) {
      const { fetchImpl } = fakeFetch(() => respond(status, body));
      const { result, lines } = call(fetchImpl);
      const e = await failureOf(result);
      expect([e.code, e.status, e.detail], String(status)).toStrictEqual(['model_failed', 502, OVER]);
      if (status === 200) {
        // The count is of what was read, which passes the cap and holds at most the whole body, however the stream cut it into chunks.
        const read = Number(/^model: the answer of OpenRouter is over the cap of 4194304 bytes \(HTTP 200, (\d+) characters read\)$/.exec(lines.join('\n'))?.[1]);
        expect(read).toBeGreaterThan(CAP);
        expect(read).toBeLessThanOrEqual(body.length);
      } else {
        expect(lines).toStrictEqual([`model: ${OVER} (HTTP 503): [the key] ${'x'.repeat(190)}...`]);
      }
      expect(showsKey(`${lines.join('\n')} ${e.detail} ${e.message}`), String(status)).toBe(false);
    }
  });

  test('the body is read through its stream and no more is pulled once the cap is passed: a body that would not end is cut, and its stream cancelled', async () => {
    const CHUNK = 65_536;
    const WHOLE = 4 * (CAP / CHUNK);
    let pulled = 0;
    let cancelled = false;
    const long = (): Response => new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        if (pulled > WHOLE) controller.close(); else controller.enqueue(new Uint8Array(CHUNK).fill(120));
      },
      cancel() { cancelled = true; },
    }, { highWaterMark: 0 }), { status: 200 });
    const { result } = call(fakeFetch(long).fetchImpl);
    const e = await failureOf(result);
    expect([e.code, e.detail]).toStrictEqual(['model_failed', OVER]);
    expect(pulled).toBeGreaterThan(CAP / CHUNK);
    expect(pulled).toBeLessThanOrEqual(CAP / CHUNK + 2);
    expect(cancelled).toBe(true);
  });
});

describe('callModel: what the log shows of the error of the provider (R-E30)', () => {
  /** The log lines of a call answered with `status` and `body`, and the detail of its failure. */
  const failing = async (status: number, body: string, apiKey = KEY): Promise<{ lines: string[]; detail: string }> => {
    const { result, lines } = call(fakeFetch(() => respond(status, body)).fetchImpl, { apiKey });
    return { lines, detail: (await failureOf(result)).detail };
  };

  test('the JSON of an error: its code and the first 200 characters of its message, and never its metadata, which can hold a part of the request', async () => {
    // A moderation error of OpenRouter: its metadata hold the flagged input, a part of the request, and come first in this body.
    const flagged = 'Should a city ban cars from its centre? retail footfall rise by eleven percent within two years';
    const message = `Your chosen model requires moderation and your input was flagged. ${'y'.repeat(300)}`;
    const body = JSON.stringify({ error: { metadata: { reasons: ['harassment'], flagged_input: flagged, provider_name: 'A provider', model_slug: 'a/model' }, code: 403, message } });
    expect(body.slice(0, 200)).toContain(flagged);
    const { lines, detail } = await failing(403, body);
    expect(lines).toStrictEqual([`model: OpenRouter answered HTTP 403 with the error code 403: ${message.slice(0, 200)}...`]);
    expect(detail).toBe('OpenRouter answered HTTP 403');
    for (const word of ['flagged_input', 'metadata', 'city ban', 'footfall', 'harassment', 'A provider', 'a/model']) expect(lines.join('\n'), word).not.toContain(word);
  });

  test('a code that is text is shown as it is; an error without a code or a message, or with ones of another kind, says so and shows nothing else', async () => {
    expect((await failing(429, JSON.stringify({ error: { code: 'rate_limit_exceeded', message: 'Rate limit exceeded: free-models-per-day' } }))).lines)
      .toStrictEqual(['model: OpenRouter answered HTTP 429 with the error code rate_limit_exceeded: Rate limit exceeded: free-models-per-day']);
    for (const error of [{ metadata: { raw: 'Should a city ban cars' } }, { code: { raw: 'Should a city ban cars' }, message: 5 }, { code: '', message: '' }, {}]) {
      expect((await failing(400, JSON.stringify({ error }))).lines, JSON.stringify(error)).toStrictEqual(['model: OpenRouter answered HTTP 400 with the error code (none): (no message)']);
    }
  });

  test('a body that is not the JSON of an error, of an object with one: its first 200 characters', async () => {
    for (const body of ['Bad gateway: the upstream did not answer', '{"message":"no route for this model"}', '{"error":"busy"}', '[{"error":{"message":"a list"}}]', '{"error":null}', '{"error":']) {
      expect((await failing(502, body)).lines, body).toStrictEqual([`model: OpenRouter answered HTTP 502: ${body}`]);
    }
    const long = `<html>${'z'.repeat(400)}</html>`;
    expect((await failing(504, long)).lines).toStrictEqual([`model: OpenRouter answered HTTP 504: ${long.slice(0, 200)}...`]);
  });

  test('the key is cut out of the code, the message and the body, in any case', async () => {
    const shown = (await failing(401, JSON.stringify({ error: { code: `bad ${KEY}`, message: `no credentials for ${KEY.toUpperCase()}` } }))).lines;
    expect(shown).toStrictEqual(['model: OpenRouter answered HTTP 401 with the error code bad [the key]: no credentials for [the key]']);
    expect((await failing(401, `no credentials for ${KEY}`)).lines).toStrictEqual(['model: OpenRouter answered HTTP 401: no credentials for [the key]']);
  });

  test('the key is cut out as text, whatever characters it holds: a key with the characters of a pattern is found whole, in the message and in the body', async () => {
    const odd = 'sk-or-v1-a+b.c(d)[e]{2}$^|?*z';
    expect((await failing(401, JSON.stringify({ error: { message: `no credentials for ${odd}` } }), odd)).lines)
      .toStrictEqual(['model: OpenRouter answered HTTP 401 with the error code (none): no credentials for [the key]']);
    const plain = await failing(401, `no credentials for ${odd}`, odd);
    expect(plain.lines).toStrictEqual(['model: OpenRouter answered HTTP 401: no credentials for [the key]']);
    expect(plain.lines.join('\n')).not.toContain('a+b.c');
  });
});

describe('no text of an answer reaches the log (R-E26)', () => {
  test('an answer of status 200 that quotes a page and echoes the key, in each way it can fail, leaves the reason and its length in the log, and none of its text', async () => {
    const said = `retail footfall rise by eleven percent within two years, says the page, and the key is ${KEY}`;
    const bodies = [said, JSON.stringify({ error: { message: said } }), `${said} ${'x'.repeat(4_194_304)}`];
    const lines: string[] = [];
    const details: string[] = [];
    for (const body of bodies) {
      const failed = call(fakeFetch(() => respond(200, body)).fetchImpl);
      details.push((await failureOf(failed.result)).detail);
      lines.push(...failed.lines);
    }
    details.push(refusalOf(() => parseBriefAnswer(said)).detail);
    expect(lines).toStrictEqual([
      `model: the answer of OpenRouter is not JSON (HTTP 200, a body of ${[...bodies[0]].length} characters)`,
      `model: the answer of OpenRouter has no choices[0].message.content (HTTP 200, a body of ${[...bodies[1]].length} characters)`,
      expect.stringMatching(/^model: the answer of OpenRouter is over the cap of 4194304 bytes \(HTTP 200, \d+ characters read\)$/),
    ]);
    expect(details.at(-1)).toBe(`the answer of the model holds no JSON object (a content of ${[...said].length} characters)`);
    for (const text of [...lines, ...details]) {
      expect(text).not.toContain('footfall');
      expect(showsKey(text)).toBe(false);
    }
  });
});

describe('the model and its label', () => {
  test('deepseek/deepseek-v4-flash by default, named with the path of the call in every brief: "<model> via the Vector marketplace" or "<model> via OpenRouter"', () => {
    expect(DEFAULT_MODEL).toBe('deepseek/deepseek-v4-flash');
    expect(modelLabel(DEFAULT_MODEL, 'openrouter')).toBe('deepseek/deepseek-v4-flash via OpenRouter');
    expect(modelLabel('openai/gpt-4o-mini', 'openrouter')).toBe('openai/gpt-4o-mini via OpenRouter');
    expect(modelLabel(DEFAULT_MODEL, 'marketplace')).toBe('deepseek/deepseek-v4-flash via the Vector marketplace');
  });

  test('OPENROUTER_MODEL: absent or blank is the default, an id of OpenRouter is taken as written, and anything else is refused, naming the variable', () => {
    for (const v of [undefined, '', '  ']) expect(openRouterModel(v)).toBe(DEFAULT_MODEL);
    for (const id of ['deepseek/deepseek-v4-flash', 'openai/gpt-4o-mini', 'meta-llama/llama-3.3-70b-instruct:free']) expect(openRouterModel(` ${id}\n`)).toBe(id);
    for (const bad of ['deepseek', '/deepseek', 'deepseek/', 'deep seek/v4', 'deepseek/v4 flash', 'deepseek/v4\u{e9}']) {
      expect(() => openRouterModel(bad), bad).toThrow(`environment variable OPENROUTER_MODEL must be the id of a model of OpenRouter, <provider>/<name> in printable ASCII without spaces, such as deepseek/deepseek-v4-flash, got ${JSON.stringify(bad)}`);
    }
    // A long value is shown by its length only: a key in the wrong line must not be printed by this check.
    expect(() => openRouterModel(`${'a'.repeat(30)} b`)).toThrow(/, got 32 characters$/);
  });
});

describe('parseBriefAnswer', () => {
  test('the content of the fixture: the thesis and the three arguments with their citations, as the model wrote them', () => {
    const brief = parseBriefAnswer(FIXTURE_CONTENT);
    expect(brief.thesis).toBe('A city should ban cars from its centre, because the centres that did so gained shoppers and cleaner air.');
    expect(brief.arguments.map((argument) => argument.claim)).toStrictEqual([
      'Shops gain visitors when the cars leave the centre.', 'People switch to bicycles at once.', 'Children breathe cleaner air on the way to school.',
    ]);
    expect(brief.arguments.map((argument) => argument.sources)).toStrictEqual([
      [{ n: 1, quote: 'retail footfall rise by eleven percent within two years' }],
      [{ n: 2, quote: 'the street became a river of bicycles overnight' }, { n: 9, quote: 'the number of vans in the centre at noon halved' }],
      [{ n: 1, quote: 'footfall r' }, { n: 2, quote: 'fell by a third in the first year' }],
    ]);
  });

  test('keys beyond the shape are left out at every level, and the strings are kept as the model wrote them', () => {
    const content = JSON.stringify({
      thesis: '  A thesis.  ', confidence: 0.9,
      arguments: [{ claim: 'A claim.', support: 'A support.', strength: 'high', sources: [{ n: 2, quote: ' A quote. ', page: 'two' }] }],
    });
    expect(parseBriefAnswer(content)).toStrictEqual({ thesis: '  A thesis.  ', arguments: [{ claim: 'A claim.', support: 'A support.', sources: [{ n: 2, quote: ' A quote. ' }] }] });
  });

  test('an argument that cites nothing passes the shape, and the post-check drops it', () => {
    expect(parseBriefAnswer('{"thesis":"T.","arguments":[{"claim":"C.","support":"S.","sources":[]}]}')).toStrictEqual({ thesis: 'T.', arguments: [{ claim: 'C.', support: 'S.', sources: [] }] });
  });

  test('an argument whose claim or support is blank, and a citation whose quote is blank, are left out (R-E20); the rest is kept in its order', () => {
    const content = JSON.stringify({
      thesis: 'T.',
      arguments: [
        { claim: '  ', support: 'S.', sources: [{ n: 1, quote: 'a quote of the first source' }] },
        { claim: 'C1.', support: '\n\t', sources: [{ n: 1, quote: 'a quote of the first source' }] },
        { claim: 'C2.', support: 'S2.', sources: [{ n: 1, quote: ' ' }, { n: 2, quote: 'a quote of the second source' }, { n: 3, quote: '' }] },
        { claim: 'C3.', support: 'S3.', sources: [{ n: 1, quote: '\n' }] },
      ],
    });
    expect(parseBriefAnswer(content)).toStrictEqual({
      thesis: 'T.', arguments: [{ claim: 'C2.', support: 'S2.', sources: [{ n: 2, quote: 'a quote of the second source' }] }, { claim: 'C3.', support: 'S3.', sources: [] }],
    });
  });

  const ok = { claim: 'C.', support: 'S.', sources: [{ n: 1, quote: 'q' }] };
  const of = (value: unknown): string => JSON.stringify(value);
  const REFUSED: Array<[string, string, string]> = [
    ['an answer with no object at all', 'I cannot write that brief.', 'holds no JSON object'],
    ['an empty answer', '', 'holds no JSON object'],
    ['a closing brace before the opening one', '} and {', 'holds no JSON object'],
    ['braces around text that is not JSON', '{ thesis: T }', 'is not JSON'],
    ['two objects side by side', `${of({ thesis: 'T.', arguments: [ok] })}\n${of({ thesis: 'U.', arguments: [ok] })}`, 'is not JSON'],
    ['a list of arguments and no thesis', of([ok]), 'has no thesis'],
    ['no thesis', of({ arguments: [ok] }), 'has no thesis'],
    ['a blank thesis', of({ thesis: '  ', arguments: [ok] }), 'has no thesis'],
    ['a thesis that is not text', of({ thesis: 5, arguments: [ok] }), 'has no thesis'],
    ['no arguments', of({ thesis: 'T.' }), 'has no arguments'],
    ['an empty list of arguments', of({ thesis: 'T.', arguments: [] }), 'has no arguments'],
    ['arguments that are not a list', of({ thesis: 'T.', arguments: ok }), 'has no arguments'],
    ['arguments that are all blank (R-E20)', of({ thesis: 'T.', arguments: [{ ...ok, claim: ' ' }, { ...ok, support: '' }] }), 'has no argument with a claim and a support'],
    ['an argument without a claim', of({ thesis: 'T.', arguments: [ok, { support: 'S.', sources: [] }] }), 'has an argument (1) without a claim, a support and a list of sources'],
    ['an argument without a support', of({ thesis: 'T.', arguments: [{ claim: 'C.', sources: [] }] }), 'has an argument (0) without a claim, a support and a list of sources'],
    ['an argument without sources', of({ thesis: 'T.', arguments: [{ claim: 'C.', support: 'S.' }] }), 'has an argument (0) without a claim, a support and a list of sources'],
    ['sources that are not a list', of({ thesis: 'T.', arguments: [{ ...ok, sources: { n: 1, quote: 'q' } }] }), 'has an argument (0) without a claim, a support and a list of sources'],
    ['a claim that is not text', of({ thesis: 'T.', arguments: [{ ...ok, claim: 1 }] }), 'has an argument (0) without a claim, a support and a list of sources'],
    ['an argument that is text', of({ thesis: 'T.', arguments: ['C.'] }), 'has an argument (0) without a claim, a support and a list of sources'],
    ['a citation without n', of({ thesis: 'T.', arguments: [{ ...ok, sources: [{ quote: 'q' }] }] }), 'has a citation (0 of argument 0) without a whole number n and a quote'],
    ['a citation whose n is not whole', of({ thesis: 'T.', arguments: [ok, { ...ok, sources: [{ n: 1, quote: 'q' }, { n: 1.5, quote: 'q' }] }] }), 'has a citation (1 of argument 1) without a whole number n and a quote'],
    ['a citation whose n is text', of({ thesis: 'T.', arguments: [{ ...ok, sources: [{ n: '1', quote: 'q' }] }] }), 'has a citation (0 of argument 0) without a whole number n and a quote'],
    ['a citation without a quote', of({ thesis: 'T.', arguments: [{ ...ok, sources: [{ n: 1 }] }] }), 'has a citation (0 of argument 0) without a whole number n and a quote'],
    ['a citation whose quote is not text', of({ thesis: 'T.', arguments: [{ ...ok, sources: [{ n: 1, quote: 5 }] }] }), 'has a citation (0 of argument 0) without a whole number n and a quote'],
    ['a citation that is a number', of({ thesis: 'T.', arguments: [{ ...ok, sources: [1] }] }), 'has a citation (0 of argument 0) without a whole number n and a quote'],
  ];
  test.each(REFUSED)('refuses %s: model_output_invalid (502), with the reason and the length of the content in its detail, never its text (R-E26)', (_label, content, what) => {
    const e = refusalOf(() => parseBriefAnswer(content));
    expect([e.code, e.status, e.detail]).toStrictEqual(['model_output_invalid', 502, `the answer of the model ${what} (a content of ${[...content].length} characters)`]);
  });

  test('the detail, which the log carries, counts the content in characters, a face outside the BMP as one, and shows none of it (R-E26); the buyer gets fixed text', () => {
    const content = `Sorry. \u{1F600}\n${'x'.repeat(400)}`;
    const e = refusalOf(() => parseBriefAnswer(content));
    expect(content.length).toBe(410); // in UTF-16 units the face is two
    expect(e.detail).toBe('the answer of the model holds no JSON object (a content of 409 characters)');
    expect(e.message).toBe(operatorsText('model_output_invalid'));
  });
});
