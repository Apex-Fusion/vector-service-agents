// The verifier service of check 6, with certificates that the stub gateway makes: a certificate of the trust domain is accepted; a certificate of another gateway, an expired one, no header,
// a malformed header and two headers are refused. Each refusal has its accepted twin. The service runs on 127.0.0.1 and the requests are real HTTP.
import { X509Certificate } from 'node:crypto';
import { request } from 'node:http';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { createGatewayClient } from '../lib/platform.ts';
import { createSvidService } from '../lib/svid-verifier.ts';
import { createStubGateway } from '../../../packages/id-kit/src/testing/index.ts';
import type { StubGateway } from '../../../packages/id-kit/src/testing/index.ts';
import { AGENT_N } from './support/world.ts';
import { testKeyOf } from './support/gateway-world.ts';

const AUDIENCE = 'https://mtls.verifier.test';
const T0 = Date.UTC(2026, 10, 19, 12, 0, 0);
const servers: Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map((s) => new Promise((done) => { s.close(done); s.closeAllConnections(); }))); });

async function world(baseUrl?: string) {
  let now = T0;
  const gateway: StubGateway = createStubGateway({ now: () => now, ...(baseUrl === undefined ? {} : { baseUrl }) });
  const key = testKeyOf(AGENT_N);
  const agent = gateway.createAgent({ label: 'record', authentication: key, delegation: key, keys: [{ key, purposes: 1 + 16 }] });
  const client = createGatewayClient({ baseUrl: gateway.baseUrl, fetch: gateway.fetch, now: () => now });
  const x509 = async (): Promise<string> => {
    const issued = await client.x509Svid({ agent: { did: agent.did, key: key.privateKey } });
    if (!issued.ok) throw new Error(issued.detail);
    return new X509Certificate(issued.value.certificate).raw.toString('base64');
  };
  const jwt = async (audience: string): Promise<string> => {
    const issued = await client.jwtSvid({ agent: { did: agent.did, key: key.privateKey }, audience });
    if (!issued.ok) throw new Error(issued.detail);
    return issued.value.svid;
  };
  return { gateway, agent, x509, jwt, advance: (ms: number) => { now += ms; }, clock: () => now };
}

async function serve(w: Awaited<ReturnType<typeof world>>) {
  const log: string[] = [];
  const service = createSvidService({ gatewayUrl: w.gateway.baseUrl, audience: AUDIENCE, fetchImpl: w.gateway.fetch, now: w.clock, log: (line) => log.push(line) });
  const server = await service.listen(0);
  servers.push(server);
  const port = (server.address() as { port: number }).port;
  const call = (method: string, path: string, headers: Record<string, string | string[]> = {}): Promise<{ status: number; body: Record<string, unknown>; text: string }> => new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => { const text = Buffer.concat(chunks).toString('utf8'); resolve({ status: res.statusCode ?? 0, body: JSON.parse(text) as Record<string, unknown>, text }); });
    });
    req.on('error', reject);
    req.end();
  });
  return { service, call, log };
}

const header = (b64: string): string => `:${b64}:`;

describe('the client certificate', () => {
  it('is accepted when it is a certificate of the trust domain: the answer names the SPIFFE ID and the DID of the record', async () => {
    const w = await world();
    const { call } = await serve(w);
    const answer = await call('GET', '/svid/x509', { 'client-cert': header(await w.x509()) });
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ ok: true, check: 'x509', spiffe_id: `spiffe://id.vector.apexfusion.org/agent/${w.agent.id}`, did: w.agent.did });
  });
  it('is refused when the certificate comes from another gateway: it does not chain to the bundle', async () => {
    const w = await world();
    const other = await world('https://id.other-domain.test');
    const { call } = await serve(w);
    const answer = await call('GET', '/svid/x509', { 'client-cert': header(await other.x509()) });
    expect(answer.status).toBe(401);
    expect(answer.body).toMatchObject({ ok: false, rule: 'x509.untrusted' });
  });
  it('is refused when it has expired, and accepted before its end', async () => {
    const w = await world();
    const { call } = await serve(w);
    const b64 = await w.x509();
    expect((await call('GET', '/svid/x509', { 'client-cert': header(b64) })).status).toBe(200);
    w.advance(2 * 3_600_000);
    const late = await call('GET', '/svid/x509', { 'client-cert': header(b64) });
    expect(late.status).toBe(401);
    expect(late.body.rule).toBe('x509.expired');
  });
  it('is refused when the request has no header, and the answer says that the certificate is missing', async () => {
    const { call } = await serve(await world());
    const answer = await call('GET', '/svid/x509');
    expect(answer.status).toBe(401);
    expect(answer.body.rule).toBe('client_certificate.missing');
  });
  it('is refused when the header is not in the form that the proxy sets', async () => {
    const w = await world();
    const { call } = await serve(w);
    const b64 = await w.x509();
    for (const bad of [b64, `:${b64}`, `${b64}:`, '::', ':not base64!:', `:${b64}:extra`]) {
      const answer = await call('GET', '/svid/x509', { 'client-cert': bad });
      expect(answer.status, bad.slice(0, 20)).toBe(400);
      expect(answer.body.rule).toBe('client_certificate.malformed');
    }
    expect((await call('GET', '/svid/x509', { 'client-cert': header(b64) })).status).toBe(200);
  });
  it('is refused when the bytes are base64 and no certificate', async () => {
    const { call } = await serve(await world());
    const answer = await call('GET', '/svid/x509', { 'client-cert': header(Buffer.from('not a certificate').toString('base64')) });
    expect(answer.status).toBe(401);
    expect(answer.body.rule).toBe('x509.malformed');
  });
  it('is refused when the request has two Client-Cert headers, even when both are good', async () => {
    const w = await world();
    const { call } = await serve(w);
    const good = header(await w.x509());
    const answer = await call('GET', '/svid/x509', { 'client-cert': [good, good] });
    expect(answer.status).toBe(400);
    expect(answer.body.rule).toBe('client_certificate.multiple');
  });
  it('never reads Client-Cert-Chain: a chain header does not change the answer', async () => {
    const w = await world();
    const { call } = await serve(w);
    expect((await call('GET', '/svid/x509', { 'client-cert': header(await w.x509()), 'client-cert-chain': ':AAAA:' })).status).toBe(200);
    expect((await call('GET', '/svid/x509', { 'client-cert-chain': header(await w.x509()) })).body.rule).toBe('client_certificate.missing');
  });
});

describe('the JWT-SVID', () => {
  it('is accepted for the audience of the service, and the answer never repeats the token', async () => {
    const w = await world();
    const { call } = await serve(w);
    const token = await w.jwt(AUDIENCE);
    const answer = await call('POST', '/svid/jwt', { authorization: `Bearer ${token}` });
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ ok: true, check: 'jwt', spiffe_id: `spiffe://id.vector.apexfusion.org/agent/${w.agent.id}`, did: w.agent.did });
    expect(answer.text).not.toContain(token);
  });
  it('is refused for another audience, with no header, with another scheme, and when it has expired', async () => {
    const w = await world();
    const { call } = await serve(w);
    const other = await call('POST', '/svid/jwt', { authorization: `Bearer ${await w.jwt(`${AUDIENCE}/other`)}` });
    expect([other.status, other.body.rule]).toEqual([401, 'jwt_svid.audience']);
    expect((await call('POST', '/svid/jwt')).body.rule).toBe('jwt_svid.missing');
    expect((await call('POST', '/svid/jwt', { authorization: `DPoP ${await w.jwt(AUDIENCE)}` })).body.rule).toBe('jwt_svid.scheme');
    const token = await w.jwt(AUDIENCE);
    w.advance(10 * 60_000);
    expect((await call('POST', '/svid/jwt', { authorization: `Bearer ${token}` })).body.rule).toBe('jwt_svid.expired');
  });
});

describe('the service', () => {
  it('answers /health, refuses a wrong method and an unknown route, and logs one JSON line for each answer', async () => {
    const { call, log } = await serve(await world());
    expect((await call('GET', '/health')).status).toBe(200);
    expect((await call('POST', '/svid/x509')).status).toBe(405);
    expect((await call('GET', '/other')).status).toBe(404);
    expect(log).toHaveLength(3);
    for (const line of log) expect(() => JSON.parse(line) as unknown).not.toThrow();
  });
  it('listens on a loopback address only', async () => {
    const service = createSvidService({ gatewayUrl: 'https://id.vector.apexfusion.org', audience: AUDIENCE });
    await expect(service.listen(0, '0.0.0.0')).rejects.toThrow(/loopback/);
    await expect(service.listen(0, '192.0.2.1')).rejects.toThrow(/loopback/);
  });
});
