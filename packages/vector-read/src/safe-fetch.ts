// packages/builder/src/vector/safe-fetch.ts
// The only code path on the public server that fetches URLs taken from chain data
// (advert endpoint_url, detail_uri). Rules: https only, no credentials, hosts that
// resolve to loopback/private/link-local/CGNAT/unspecified ranges are refused,
// bodies are capped, redirects never change scheme, and the whole call has a budget.
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export interface SafeFetchOpts {
  maxResponseBytes?: number; timeoutMs?: number;
  lookup?: (host: string) => Promise<Array<{ address: string; family: number }>>;
  fetchImpl?: typeof fetch;
}
export const SAFE_FETCH_DEFAULTS = { maxResponseBytes: 2 * 1024 * 1024, timeoutMs: 90_000 } as const;

export function assertSafeUrl(url: string): URL {
  let u: URL;
  try { u = new URL(url); } catch { throw new Error(`safeFetch: malformed URL`); }
  if (u.protocol !== 'https:') throw new Error('safeFetch: only https URLs are allowed');
  if (u.username || u.password) throw new Error('safeFetch: credentials in URLs are not allowed');
  return u;
}

export function isPrivateAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  if (v === 6) {
    const low = ip.toLowerCase();
    if (low === '::1' || low === '::') return true;
    if (low.startsWith('::ffff:')) return isPrivateAddress(low.slice(7));
    const first = parseInt(low.split(':')[0] || '0', 16);
    return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80;
  }
  return true;
}

export async function safeFetch(url: string, init: RequestInit = {}, opts: SafeFetchOpts = {}): Promise<{ status: number; headers: Headers; text: string }> {
  const u = assertSafeUrl(url);
  const lookup = opts.lookup ?? (async (h: string) => dnsLookup(h, { all: true }));
  const addrs = isIP(u.hostname) ? [{ address: u.hostname, family: isIP(u.hostname) }] : await lookup(u.hostname);
  if (addrs.length === 0) throw new Error(`safeFetch: ${u.hostname} does not resolve`);
  for (const a of addrs) if (isPrivateAddress(a.address)) throw new Error(`safeFetch: ${u.hostname} resolves to a private or reserved address; refused`);
  const f = opts.fetchImpl ?? fetch;
  const res = await f(u.toString(), { ...init, redirect: 'manual', signal: AbortSignal.timeout(opts.timeoutMs ?? SAFE_FETCH_DEFAULTS.timeoutMs) });
  if (res.status >= 300 && res.status < 400) {
    const loc = res.headers.get('location') ?? '';
    throw new Error(`safeFetch: redirect to ${loc || '(no location)'} refused (redirects are not followed)`);
  }
  const max = opts.maxResponseBytes ?? SAFE_FETCH_DEFAULTS.maxResponseBytes;
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.byteLength > max) throw new Error(`safeFetch: response of ${buf.byteLength} bytes exceeds the ${max} byte cap`);
  return { status: res.status, headers: res.headers, text: buf.toString('utf8') };
}
