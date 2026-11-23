// packages/usecase-kit/src/live/tip.ts
// The slot of the tip of the node. The janitor of left sub-delegations drops a reference only when the slot of the tip is at or past the TTL of its Delegate, and it never uses the clock for that: the TTL is in the
// signed bytes of the transaction, and a slot is the unit of the ledger. This file asks the node with the JSON-RPC call `queryNetwork/tip`, which the provider of `@vsa/buyer-core` uses for the tip of the network,
// and gives the `slot` of the answer.
//
// Each call makes one request, and nothing is kept between two calls, so a value is never stale. A call throws an Error when the node does not answer within `timeoutMs` (the request is aborted, and the clock of the
// process ends the wait also for a `fetch` that ignores the signal), when the request fails, when the status is not 200, when the answer is longer than MAX_ANSWER_BYTES or is not JSON, when the node gives an error, and
// when the answer holds no slot or a slot that is not a whole number of at least 1. The message names the kind of failure and, for a status, the status. It never repeats the URL, the text of an error of the network
// or a part of the answer: the URL of a node can hold a secret, and an answer can hold text of a third party.
import { isPlainObject } from '../protocol/index.ts';

/** The JSON-RPC method of the tip: the one that `OgmiosProvider` of `@vsa/buyer-core` calls for the tip of the network. */
const METHOD = 'queryNetwork/tip';
/** The longest time limit that a timer can hold: one day, in milliseconds. A longer number would end at once. */
const MAX_TIMEOUT_MS = 86_400_000;
/** The most bytes of an answer that a call reads. The answer for the tip has less than 200 bytes. */
const MAX_ANSWER_BYTES = 65_536;

/** Reads the body of a response up to `max` bytes. Null when the body is longer. */
async function readCapped(response: Response, max: number): Promise<string | null> {
  if (response.body === null) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

/** The slot of the answer of a node to the call of the tip, or an Error that says what is wrong and repeats nothing of the answer. */
function slotOf(text: string): number {
  let answer: unknown;
  try {
    answer = JSON.parse(text);
  } catch {
    throw new Error('the answer of the node for the tip is not JSON');
  }
  if (!isPlainObject(answer)) throw new Error('the answer of the node for the tip is not a JSON-RPC answer');
  if ('error' in answer) throw new Error('the node gave an error for the request for the tip');
  const { result } = answer;
  if (!isPlainObject(result)) throw new Error('the node gave no tip');
  const { slot } = result;
  if (typeof slot !== 'number' || !Number.isSafeInteger(slot) || slot < 1) throw new Error('the tip of the node has no slot that is a whole number of at least 1');
  return slot;
}

/** One request for the tip. `signal` aborts it. */
async function ask(send: typeof fetch, url: string, body: string, signal: AbortSignal): Promise<number> {
  let response: Response;
  try {
    response = await send(url, { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json' }, body, signal, redirect: 'manual' });
  } catch {
    throw new Error('the request for the tip of the node failed');
  }
  if (response.status !== 200) throw new Error(`the node answered the request for the tip with the status ${response.status}`);
  let text: string | null;
  try {
    text = await readCapped(response, MAX_ANSWER_BYTES);
  } catch {
    throw new Error('the answer of the node for the tip could not be read');
  }
  if (text === null) throw new Error(`the answer of the node for the tip is longer than ${MAX_ANSWER_BYTES} bytes`);
  return slotOf(text);
}

function isHttpsUrl(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * The reader of the slot of the tip of a node. `fetch` is the `fetch` of the caller (a test gives a stub), `ogmiosUrl` is the https URL of the JSON-RPC endpoint of the node, and `timeoutMs` is the longest time of
 * one call: a whole number from 1 to 86,400,000. The reader is made with no request. A time limit or a URL that is not in its form is a TypeError here, and never a reader that waits for ever or at all.
 */
export function tipSlotOf(deps: { readonly fetch: typeof fetch; readonly ogmiosUrl: string; readonly timeoutMs: number }): () => Promise<number> {
  const { fetch: send, ogmiosUrl, timeoutMs } = deps;
  if (!isHttpsUrl(ogmiosUrl)) throw new TypeError('ogmiosUrl must be an https URL');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) throw new TypeError(`timeoutMs must be a whole number from 1 to ${MAX_TIMEOUT_MS}`);
  const body = JSON.stringify({ jsonrpc: '2.0', method: METHOD, params: {}, id: null });
  return async () => {
    const stop = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        stop.abort();
        reject(new Error(`the node gave no answer for the tip within ${timeoutMs} ms`));
      }, timeoutMs);
    });
    try {
      return await Promise.race([ask(send, ogmiosUrl, body, stop.signal), late]);
    } finally {
      clearTimeout(timer);
      stop.abort();
    }
  };
}
