// scripts/operator/lib/dns.ts - the check that a TXT value is public. The gateway checks the organisation of an agent with the TXT record `_did.<domain>` of the domain, and it looks the name up
// once at its first check of a record. So the pack signs a registration only when three public resolvers show the value. The resolvers answer over DNS-over-HTTPS in the JSON form: one GET
// for each resolver, with the name and the type TXT. A record counts when its text is the value or `did=` and the value, and the check is ok only when all three resolvers show such a record.
// An answer that cannot be read, a status that is not 200, a DNS status other than 0, an answer with no such record, and a call that fails or times out are a resolver that did not show the
// value, with the reason. The function reads nothing else and never throws for a failure of the network. It throws a TypeError for a name or a value that a caller got wrong, because an
// empty value could match an empty record.
// Ask a resolver about a name only after the value is published: a public resolver keeps the answer "no record" for a name that it was asked about too early.

/** A public resolver: its name in a report, and the URL of its DNS-over-HTTPS JSON route. */
export interface Resolver { readonly name: string; readonly url: string }

export const RESOLVERS: readonly Resolver[] = [
  { name: 'cloudflare', url: 'https://cloudflare-dns.com/dns-query' },
  { name: 'google', url: 'https://dns.google/resolve' },
  { name: 'quad9', url: 'https://dns.quad9.net:5053/dns-query' },
];

/** How long one resolver is asked, in milliseconds. */
export const RESOLVER_TIMEOUT_MS = 10_000;

/** What one resolver showed: `seen` is true when it shows the value, and `error` says why not when it does not. */
export interface ResolverAnswer { resolver: string; seen: boolean; error: string | null }

/** The result of the check: `ok` only when all three resolvers show the value. */
export interface TxtCheck { ok: boolean; resolvers: ResolverAnswer[] }

/** An answer of more characters than this is not read: a TXT answer for one name is small. */
const MAX_BODY_CHARS = 1_048_576;
const MAX_REASON_CHARS = 200;
const TXT_TYPE = 16;
const DNS_NAME = /^[A-Za-z0-9_.-]+$/;
const DECIMAL_ESCAPE = /^\d{3}/;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err)).slice(0, MAX_REASON_CHARS);
const timedOut = (err: unknown): boolean => isRecord(err) && (err.name === 'TimeoutError' || err.name === 'AbortError');

/**
 * The text of one TXT record as a resolver writes it: a list of character strings in quotes, with a space between two strings. The quotes go, the strings are joined, and the text is trimmed.
 * Inside a string, `\"` and `\\` are the characters that they stand for, and `\DDD` is the character with that decimal code. A text that does not start with a quote is the text as it is. A text
 * that starts with a quote and is no list of strings (a quote that is never closed, a word after a string) is the text as it is, and so it matches nothing.
 */
function textOf(data: string): string {
  const trimmed = data.trim();
  if (!trimmed.startsWith('"')) return trimmed;
  const parts: string[] = [];
  let at = 0;
  while (at < trimmed.length) {
    while (at < trimmed.length && /\s/.test(trimmed.charAt(at))) at += 1;
    if (at >= trimmed.length) break;
    if (trimmed.charAt(at) !== '"') return trimmed;
    at += 1;
    let part = '';
    for (; at < trimmed.length && trimmed.charAt(at) !== '"'; at += 1) {
      if (trimmed.charAt(at) !== '\\' || at + 1 >= trimmed.length) {
        part += trimmed.charAt(at);
        continue;
      }
      const code = DECIMAL_ESCAPE.exec(trimmed.slice(at + 1, at + 4))?.[0];
      if (code !== undefined) {
        part += String.fromCharCode(Number(code));
        at += 3;
      } else {
        at += 1;
        part += trimmed.charAt(at);
      }
    }
    if (at >= trimmed.length) return trimmed;
    at += 1;
    parts.push(part);
  }
  return parts.join('').trim();
}

/** Reads the body of an answer: the reason that no resolver can show the value, or the TXT records of the answer as texts. */
function recordsOf(body: string): { error: string } | { records: string[] } {
  let parsed: unknown;
  try { parsed = JSON.parse(body); } catch { return { error: 'the body of the answer is not JSON' }; }
  if (!isRecord(parsed) || typeof parsed.Status !== 'number') return { error: 'the body of the answer is not a DNS answer (it has no Status)' };
  if (parsed.Status !== 0) return { error: `the answer has the DNS status ${parsed.Status}, and 0 is the status of an answer` };
  if (parsed.Answer === undefined) return { records: [] };
  if (!Array.isArray(parsed.Answer)) return { error: 'the body of the answer is not a DNS answer (its Answer is not a list)' };
  const records = parsed.Answer.flatMap((entry: unknown) => (isRecord(entry) && entry.type === TXT_TYPE && typeof entry.data === 'string' ? [textOf(entry.data)] : []));
  return { records };
}

/** Asks one resolver. It never throws: a failure is the reason that the resolver did not show the value. */
async function ask(fetchImpl: typeof fetch, resolver: Resolver, name: string, value: string, timeoutMs: number): Promise<ResolverAnswer> {
  const not = (error: string): ResolverAnswer => ({ resolver: resolver.name, seen: false, error });
  const url = new URL(resolver.url);
  url.searchParams.set('name', name);
  url.searchParams.set('type', 'TXT');
  let status: number;
  let body: string;
  try {
    const response = await fetchImpl(url.href, { method: 'GET', headers: { accept: 'application/dns-json' }, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
    status = response.status;
    body = await response.text();
  } catch (err) {
    return not(timedOut(err) ? `the resolver timed out after ${timeoutMs / 1000} s` : `the call failed (${errorText(err)})`);
  }
  if (status !== 200) return not(`the resolver answered with the HTTP status ${status}`);
  if (body.length > MAX_BODY_CHARS) return not('the answer is too long to read');
  const read = recordsOf(body);
  if ('error' in read) return not(read.error);
  if (read.records.length === 0) return not('the answer has no TXT record');
  if (!read.records.some((text) => text === value || text === `did=${value}`)) return not(`the answer has no TXT record with this value (${read.records.length} TXT record(s) of other values)`);
  return { resolver: resolver.name, seen: true, error: null };
}

/**
 * Asks the three public resolvers for the TXT records of `name`, all at the same time, and says for each whether it shows `value`. `ok` is true only when all three do. `options.timeoutMs`
 * changes the limit of 10 seconds for each resolver (a test uses a short one).
 */
export async function checkTxt(fetchImpl: typeof fetch, name: string, value: string, options: { timeoutMs?: number } = {}): Promise<TxtCheck> {
  if (typeof name !== 'string' || !DNS_NAME.test(name)) throw new TypeError('checkTxt needs the name of a DNS record: letters, digits, underscores, hyphens and dots');
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError('checkTxt needs a value that is not empty');
  const timeoutMs = options.timeoutMs ?? RESOLVER_TIMEOUT_MS;
  const resolvers = await Promise.all(RESOLVERS.map((resolver) => ask(fetchImpl, resolver, name, value, timeoutMs)));
  return { ok: resolvers.every((one) => one.seen), resolvers };
}
