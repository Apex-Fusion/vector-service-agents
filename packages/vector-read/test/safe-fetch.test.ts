// Vitest port of packages/builder/test/safe-fetch.test.ts (Plan A Task 7 Step 1; node:test -> vitest).
import { describe, test, expect } from 'vitest';
import { assertSafeUrl, isPrivateAddress, safeFetch } from '../src/safe-fetch.ts';

describe('safeFetch policy', () => {
  test('refuses non-https', () => { expect(() => assertSafeUrl('http://example.com/x')).toThrow(/https/); });
  test('refuses credentials in the URL', () => { expect(() => assertSafeUrl('https://user:pw@example.com/')).toThrow(/credentials/); });
  test('classifies private and special ranges', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fc00::1', 'fe80::1', '::ffff:10.0.0.1']) expect(isPrivateAddress(ip), ip).toBe(true);
    for (const ip of ['8.8.8.8', '172.32.0.1', '2606:4700::1111']) expect(isPrivateAddress(ip), ip).toBe(false);
  });
  test('refuses a host that resolves to a private address', async () => {
    const lookup = async () => [{ address: '169.254.169.254', family: 4 }];
    await expect(safeFetch('https://metadata.example/', {}, { lookup, fetchImpl: (async () => new Response('x')) as any })).rejects.toThrow(/private/);
  });
  test('caps the response size', async () => {
    const lookup = async () => [{ address: '8.8.8.8', family: 4 }];
    const big = 'a'.repeat(5000);
    await expect(safeFetch('https://ok.example/', {}, { lookup, maxResponseBytes: 1000, fetchImpl: (async () => new Response(big)) as any })).rejects.toThrow(/exceeds/);
  });
  test('refuses cross-scheme redirects', async () => {
    const lookup = async () => [{ address: '8.8.8.8', family: 4 }];
    const f = (async () => new Response('', { status: 302, headers: { location: 'http://evil.example/' } })) as any;
    await expect(safeFetch('https://ok.example/', {}, { lookup, fetchImpl: f })).rejects.toThrow(/redirect/);
  });
  // Local additions: the Plan A suite has no success-path test and never checks that redirect: 'manual' reaches fetch.
  test('passes the caller init through with redirect: manual and returns status, headers and text', async () => {
    const lookup = async () => [{ address: '8.8.8.8', family: 4 }];
    let seen: RequestInit | undefined;
    const f = (async (_u: any, init?: RequestInit) => { seen = init; return new Response('hello', { status: 200, headers: { 'x-k': 'v' } }); }) as any;
    const res = await safeFetch('https://ok.example/p', { method: 'POST', body: 'req' }, { lookup, fetchImpl: f });
    expect(res.status).toBe(200);
    expect(res.text).toBe('hello');
    expect(res.headers.get('x-k')).toBe('v');
    expect(seen?.redirect).toBe('manual');
    expect(seen?.method).toBe('POST');
    expect(seen?.body).toBe('req');
    expect(seen?.signal).toBeInstanceOf(AbortSignal);
  });
  test('checks an IP-literal host directly, without a lookup', async () => {
    const lookup = async () => { throw new Error('lookup must not be called'); };
    const f = (async () => new Response('x')) as any;
    await expect(safeFetch('https://169.254.169.254/latest/meta-data', {}, { lookup, fetchImpl: f })).rejects.toThrow(/private/);
  });
});
