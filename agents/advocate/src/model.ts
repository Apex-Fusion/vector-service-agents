// agents/advocate/src/model.ts
// The one model call of a job (ruling R-E5): a chat completion of OpenRouter, POST https://openrouter.ai/api/v1/chat/completions, with the key of
// OPENROUTER_API_KEY as a bearer token, the two messages of src/prompt.ts, temperature 0, the token limit of the length asked for, and one JSON object asked
// for as the answer; then that answer read into a brief (parseBriefAnswer), which the post-check (src/check.ts) holds to the pages. The model is
// OPENROUTER_MODEL, deepseek/deepseek-v4-flash by default, and every brief names it as "<model> via OpenRouter".
//
// The key goes into the Authorization header of that call and nowhere else: no message, no log line and no error carries it, and a body that echoes it is
// logged with the key cut out, in any case. No redirect is followed (redirect 'error', ruling R-E23), for a followed redirect could carry the header on to
// another host: an answer that redirects is a failed call like any other. The body of the answer is read through its stream and no further than
// ANSWER_MAX_BYTES, 4 MiB (ruling R-E23): once the cap is passed the stream is cancelled and the call has failed. What can fail, and how:
//   model_failed (502)          an answer that is not 200, a body over the cap, a body that is not JSON or has no choices[0].message.content string, no answer
//                               within the full MODEL_MAX_MS, or a network failure (a refused redirect among them). One log line says which, with the HTTP
//                               status and the first 200 characters of the body when there is one; the error carries a short detail for the line of the job.
//   deadline (422)              no answer within a time the deadline of the job had cut under MODEL_MAX_MS (ruling R-E19): the job ran out of its time. The
//                               log line is the one of a call with no answer.
//   model_output_invalid (502)  content that holds no JSON object of the shape the prompt asks for, or none with an argument that says something. The detail
//                               carries the first 200 characters of the content, for the log: the buyer gets fixed text.
//   aborted (499)               the caller hung up while the call ran (the signal of the job): the call is cut, and no line of a failure is written.
// usage.prompt_tokens and usage.completion_tokens are given back for the line of the job and go nowhere else.
import { errorText, given, shown } from '@vsa/service-kit';
import { MODEL_MAX_MS } from './budget.ts';
import { AdvocateError } from './errors.ts';
import type { ChatMessage } from './prompt.ts';

export const OPENROUTER_ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';
export const DEFAULT_MODEL = 'deepseek/deepseek-v4-flash';
/** The model as a brief names it: "<model> via OpenRouter". */
export const modelLabel = (model: string): string => `${model} via OpenRouter`;
/** The two headers OpenRouter reads to name the application that calls it. */
const REFERER = 'https://github.com/Apex-Fusion/vector-service-agents';
const TITLE = 'Advocate (vector-service-agents)';
/** How much of a body or of a content a log line or a detail shows. */
const SHOWN_CHARS = 200;
/** The most of an answer that is read: 4 MiB (R-E23). A chat completion is a few KB of JSON; a body that goes past this is no answer, and is not read to its end. */
export const ANSWER_MAX_BYTES = 4_194_304;
/** An id of OpenRouter: <provider>/<name>, printable ASCII without spaces, the provider without a slash. */
const MODEL_ID = /^[!-.0-~]+\/[!-~]+$/;

export interface ModelOptions { fetchImpl: typeof fetch; apiKey: string; model: string; maxTokens: number; timeoutMs: number; signal?: AbortSignal; log: (line: string) => void }
export interface Usage { prompt_tokens: number; completion_tokens: number }
export interface ModelCitation { n: number; quote: string }
export interface ModelArgument { claim: string; support: string; sources: ModelCitation[] }
export interface ModelBrief { thesis: string; arguments: ModelArgument[] }

/**
 * The model of OPENROUTER_MODEL: DEFAULT_MODEL when absent or blank, the id as written (without the space around it) when it is <provider>/<name> in
 * printable ASCII without spaces, and anything else refused with the variable named. The manifest (its fifth gap) and the start read it.
 */
export function openRouterModel(v: string | undefined): string {
  const value = given(v);
  if (value === '') return DEFAULT_MODEL;
  if (!MODEL_ID.test(value)) {
    throw new Error(`environment variable OPENROUTER_MODEL must be the id of a model of OpenRouter, <provider>/<name> in printable ASCII without spaces, such as ${DEFAULT_MODEL}, got ${shown(value)}`);
  }
  return value;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isCount = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;

/** `text` with every occurrence of `key` replaced, in any case: what a log line or a detail may show of a text that came from the far end. */
function withoutKey(text: string, key: string): string {
  if (key === '') return text;
  return text.replace(new RegExp(key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '[the key]');
}

/** The content of the first choice, when it is a string. */
function contentOf(answer: unknown): string | undefined {
  if (!isObject(answer) || !Array.isArray(answer.choices)) return undefined;
  const first: unknown = answer.choices[0];
  if (!isObject(first) || !isObject(first.message)) return undefined;
  return typeof first.message.content === 'string' ? first.message.content : undefined;
}

/** The two counts of the usage, when both are whole numbers; null otherwise. */
function usageOf(answer: unknown): Usage | null {
  if (!isObject(answer) || !isObject(answer.usage)) return null;
  const { prompt_tokens: prompt, completion_tokens: completion } = answer.usage;
  return isCount(prompt) && isCount(completion) ? { prompt_tokens: prompt, completion_tokens: completion } : null;
}

/** A rejection of fetch at the end of its time: the TimeoutError of AbortSignal.timeout, whichever signal carried it. */
const isTimeout = (error: unknown): boolean => typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'TimeoutError';

/**
 * The body of an answer as text, read through its stream and no further than `max` bytes (ruling R-E23): the stream is pulled chunk by chunk, and once the
 * running total passes `max` it is cancelled, so that the connection is dropped, and `over` says so. `text` is what was read, decoded as Response.text()
 * decodes it (UTF-8, a byte order mark dropped); with `over` it is the start of a body that is not read to its end, for the log and for nothing else. A failure
 * of the stream (the time of the call, the caller hanging up, the network) rejects here as it would in any read of a body.
 */
async function readCapped(res: Response, max: number): Promise<{ text: string; over: boolean }> {
  if (res.body === null) return { text: '', over: false };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let over = false;
  while (!over) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
    over = total > max;
  }
  if (over) await reader.cancel().catch(() => undefined);
  return { text: new TextDecoder().decode(Buffer.concat(chunks, total)), over };
}

/**
 * The one call: the content of the answer and its usage; or AdvocateError model_failed (502), deadline (422) when a time the deadline had cut short ran out,
 * or aborted (499) when the caller hung up.
 */
export async function callModel(messages: readonly ChatMessage[], opts: ModelOptions): Promise<{ content: string; usage: Usage | null }> {
  const timeout = AbortSignal.timeout(opts.timeoutMs);
  const signal = opts.signal === undefined ? timeout : AbortSignal.any([opts.signal, timeout]);
  /** The body of an answer as a log line shows it: flat, without the key, its first 200 characters. */
  const bodyOf = (text: string): string => (text === '' ? '(no body)' : errorText(withoutKey(text, opts.apiKey), SHOWN_CHARS));
  /** A failure of the call: its line in the log, and the error with the short detail that the line of the job carries. */
  const failed = (detail: string, line: string): AdvocateError => {
    opts.log(`model: ${line}`);
    return new AdvocateError('model_failed', detail);
  };
  const send = async (): Promise<{ status: number; text: string; over: boolean }> => {
    try {
      // redirect 'error' (R-E23): a followed redirect could send the key, in a header of this request, on to another host. A redirect is a failed call like any other.
      const res = await opts.fetchImpl(OPENROUTER_ENDPOINT, {
        method: 'POST',
        headers: { Authorization: `Bearer ${opts.apiKey}`, 'Content-Type': 'application/json', 'HTTP-Referer': REFERER, 'X-Title': TITLE },
        body: JSON.stringify({ model: opts.model, messages, temperature: 0, max_tokens: opts.maxTokens, response_format: { type: 'json_object' } }),
        redirect: 'error',
        signal,
      });
      // The body is read here, inside the same try as the request, so that the time of the call and a caller who hangs up cut a body that stalls as they cut an
      // answer that never starts; and under a cap (R-E23), never with an unbounded res.text().
      const { text, over } = await readCapped(res, ANSWER_MAX_BYTES);
      return { status: res.status, text, over };
    } catch (error) {
      if (opts.signal?.aborted === true) throw new AdvocateError('aborted', 'the caller hung up, and the call to the model was stopped');
      if (timeout.aborted || isTimeout(error)) {
        const late = `OpenRouter did not answer within ${opts.timeoutMs} ms`;
        // R-E19: a time under MODEL_MAX_MS is what the deadline of the job left the call, so the job ran out of its time; the full time is the model's failure.
        if (opts.timeoutMs < MODEL_MAX_MS) {
          opts.log(`model: ${late}`);
          throw new AdvocateError('deadline', `the model did not answer within the ${opts.timeoutMs} ms the deadline of the job left it`);
        }
        throw failed(late, late);
      }
      const why = `the call to OpenRouter failed: ${errorText(withoutKey(error instanceof Error ? error.message : String(error), opts.apiKey), SHOWN_CHARS)}`;
      throw failed(why, why);
    }
  };
  const { status, text, over } = await send();
  if (over) {
    // R-E23: a body past the cap is no answer, whatever its status; the detail says the cap, and the line says the status and the start of what was read.
    const big = `the answer of OpenRouter is over the cap of ${ANSWER_MAX_BYTES} bytes`;
    throw failed(big, `${big} (HTTP ${status}): ${bodyOf(text)}`);
  }
  if (status !== 200) throw failed(`OpenRouter answered HTTP ${status}`, `OpenRouter answered HTTP ${status}: ${bodyOf(text)}`);
  let answer: unknown;
  try {
    answer = JSON.parse(text);
  } catch {
    throw failed('the answer of OpenRouter is not JSON', `the answer of OpenRouter is not JSON (HTTP 200): ${bodyOf(text)}`);
  }
  const content = contentOf(answer);
  if (content === undefined) {
    throw failed('the answer of OpenRouter has no choices[0].message.content', `the answer of OpenRouter has no choices[0].message.content (HTTP 200): ${bodyOf(text)}`);
  }
  return { content, usage: usageOf(answer) };
}

/** The text inside one code fence that holds the whole answer (```json ... ```), or the answer as it is. */
function unfenced(content: string): string {
  const fenced = /^```[^\n]*\n([\s\S]*?)\n?```$/.exec(content.trim());
  return fenced === null ? content : fenced[1];
}

/**
 * The brief in the content of the answer: a fence around the whole answer taken off, then the text from its first { to its last } parsed as JSON, and held
 * to the shape the prompt asks for: a thesis that is not blank, and a list of arguments, each with a claim and a support that are strings and a list of
 * citations, each { n: a whole number, quote: a string }. An argument whose claim or support is blank, and a citation whose quote is blank, say nothing and
 * are left out (ruling R-E20); at least one argument must be left. Keys beyond the shape are left out too; the strings are kept as the model wrote them.
 * Anything else is AdvocateError model_output_invalid (502), whose detail ends with the first 200 characters of the content.
 */
export function parseBriefAnswer(content: string): ModelBrief {
  const invalid = (what: string): AdvocateError => new AdvocateError('model_output_invalid', `the answer of the model ${what}: ${errorText(content, SHOWN_CHARS)}`);
  const text = unfenced(content);
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first === -1 || last < first) throw invalid('holds no JSON object');
  let value: unknown;
  try {
    value = JSON.parse(text.slice(first, last + 1));
  } catch {
    throw invalid('is not JSON');
  }
  if (!isObject(value)) throw invalid('is not a JSON object');
  const { thesis, arguments: list } = value;
  if (typeof thesis !== 'string' || thesis.trim() === '') throw invalid('has no thesis');
  if (!Array.isArray(list) || list.length === 0) throw invalid('has no arguments');
  const blank = (s: string): boolean => s.trim() === '';
  const args: ModelArgument[] = [];
  list.forEach((argument: unknown, i) => {
    if (!isObject(argument) || typeof argument.claim !== 'string' || typeof argument.support !== 'string' || !Array.isArray(argument.sources)) {
      throw invalid(`has an argument (${i}) without a claim, a support and a list of sources`);
    }
    const sources: ModelCitation[] = [];
    argument.sources.forEach((citation: unknown, j) => {
      if (!isObject(citation) || !Number.isInteger(citation.n) || typeof citation.quote !== 'string') {
        throw invalid(`has a citation (${j} of argument ${i}) without a whole number n and a quote`);
      }
      if (!blank(citation.quote)) sources.push({ n: citation.n as number, quote: citation.quote });
    });
    if (!blank(argument.claim) && !blank(argument.support)) args.push({ claim: argument.claim, support: argument.support, sources });
  });
  if (args.length === 0) throw invalid('has no argument with a claim and a support');
  return { thesis, arguments: args };
}
