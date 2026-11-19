// packages/id-kit/test/capture-script.test.ts: the script that captures the live vectors sends GET requests to the public routes only. It runs here against the stub gateway.
import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertPublicRoute, capture, targets, type CaptureOptions } from '../scripts/capture-live-vectors.ts';
import { world } from './support.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function options(over: Partial<CaptureOptions> & Pick<CaptureOptions, 'fetch' | 'agent' | 'now'>): CaptureOptions {
  const outDir = mkdtempSync(join(tmpdir(), 'id-kit-capture-'));
  dirs.push(outDir);
  return { origin: 'https://id.vector.apexfusion.org', outDir, sleep: async () => undefined, maxWaitMs: 60_000, log: () => undefined, ...over };
}

describe('the capture script', () => {
  it('reads six public routes with GET: no body, no credentials, and it writes each file with its sha256 and the time of the capture', async () => {
    const { gateway } = world();
    const agent = gateway.createAgent({ label: 'capture agent' });
    const o = options({ fetch: gateway.fetch, agent: agent.id, now: gateway.now });
    const manifest = await capture(o);
    expect(Object.keys(manifest.files)).toStrictEqual(['jwks.json', 'metadata.json', 'bundle.json', 'tsl-0.jwt', 'bsl-0.jwt', 'credential.jwt']);
    expect(manifest).toMatchObject({ origin: gateway.baseUrl, agent: agent.id, capturedAtMs: gateway.now(), capturedAt: new Date(gateway.now()).toISOString() });
    expect(gateway.requests).toHaveLength(6);
    for (const request of gateway.requests) {
      expect(request.method).toBe('GET');
      expect(request.body).toBe('');
      expect(Object.keys(request.headers).sort()).toStrictEqual(['accept']);
      expect(() => assertPublicRoute(request.path)).not.toThrow();
    }
    for (const [file, entry] of Object.entries(manifest.files)) {
      const body = readFileSync(join(o.outDir, file), 'utf8');
      expect(createHash('sha256').update(body).digest('hex'), file).toBe(entry.sha256);
      expect(Buffer.byteLength(body)).toBe(entry.bytes);
    }
    expect(JSON.parse(readFileSync(join(o.outDir, 'capture.json'), 'utf8'))).toStrictEqual(manifest);
  });

  it('asks again after a 503, after the wait that the gateway names, and goes on; and it gives up after the time limit', async () => {
    const { gateway } = world();
    const agent = gateway.createAgent({ label: 'capture 503' });
    let failures = 2;
    const waits: number[] = [];
    const flaky: typeof fetch = async (input, init) => {
      if (String(input).endsWith('/status/tsl/0') && failures-- > 0) return new Response('{"error":"temporarily_unavailable"}', { status: 503, headers: { 'retry-after': '7' } });
      return gateway.fetch(input, init);
    };
    const manifest = await capture(options({ fetch: flaky, agent: agent.id, now: gateway.now, sleep: async (ms) => (waits.push(ms), gateway.advance(ms)) }));
    expect(waits).toStrictEqual([7000, 7000]);
    expect(manifest.files['tsl-0.jwt']?.status).toBe(200);

    const never: typeof fetch = async () => new Response('{}', { status: 503, headers: { 'retry-after': '5' } });
    await expect(capture(options({ fetch: never, agent: agent.id, now: gateway.now, maxWaitMs: 20_000, sleep: async (ms) => gateway.advance(ms) }))).rejects.toThrow(/answered 503/);
  });

  it('stops at any other status than 200 and 503', async () => {
    const { gateway } = world();
    const agent = gateway.createAgent({ label: 'capture 404' });
    gateway.fault('/.well-known/jwks.json', { status: 404, body: 'not found' });
    await expect(capture(options({ fetch: gateway.fetch, agent: agent.id, now: gateway.now }))).rejects.toThrow(/answered 404/);
  });

  it('refuses a route that is not one of the public routes before a request goes out: a token request, an SVID request, a list that is not list 0', () => {
    for (const path of ['/token', '/spiffe/x509-svid', '/spiffe/jwt-svid', '/spiffe/nonce', '/introspect', '/status/tsl/1', '/agents/abc/credential', '/status/bsl/0/x']) {
      expect(() => assertPublicRoute(path), path).toThrow(/not one of the public routes/);
    }
    for (const target of targets('a'.repeat(64))) expect(() => assertPublicRoute(target.path), target.path).not.toThrow();
  });
});
