// packages/usecase-kit/test/access/credentials.test.ts: a credential is what its own claims say, and a failure of the gateway shows no part of a credential. A JWT-SVID has the audience and the end
// time that its payload names, and an X.509-SVID ends when its certificate ends. The gateway here is the stub of id-kit with a `fetch` that changes what it answers. Each refusal has an accepted twin.
import { X509Certificate, createPublicKey, sign as nodeSign, type KeyObject } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createGatewayClient } from '@vsa/id-kit/client';
import type { SignerKey } from '@vsa/id-kit/client';
import { fetchJwtSvid, fetchX509Svid, jwtSvidTarget, requestRouteToken } from '../../src/access/index.ts';
import { BASES, claimsOf, erpTarget, expectTarget, gatewayWorld } from './support.ts';

const b64u = (value: unknown): string => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url');
/** The JWT with new claims and the old header and signature: the kit reads the claims, and the stub gateway is not asked again. */
function reissue(jwt: string, change: (claims: Record<string, unknown>) => unknown): string {
  const [header, , signature] = jwt.split('.');
  return `${header}.${b64u(change(claimsOf(jwt)))}.${signature}`;
}

/** The stub gateway with a client whose `fetch` can change the request and the answer of one path. */
function world(change: { path?: string; request?: (body: Record<string, unknown>) => Record<string, unknown>; answer?: (body: Record<string, unknown>) => Record<string, unknown> } = {}) {
  const w = gatewayWorld();
  const wrapped: typeof fetch = async (input, init) => {
    const here = change.path !== undefined && String(input).endsWith(change.path);
    const sent = here && change.request !== undefined ? { ...init, body: JSON.stringify(change.request(JSON.parse(String(init?.body)) as Record<string, unknown>)) } : init;
    const response = await w.gateway.fetch(input, sent);
    if (!here || change.answer === undefined || response.status !== 200) return response;
    return new Response(JSON.stringify(change.answer((await response.json()) as Record<string, unknown>)), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const client = createGatewayClient({ baseUrl: w.gateway.baseUrl, fetch: wrapped, now: w.gateway.now });
  const desk = w.gateway.createAgent({ label: 'order-desk' });
  return { ...w, client, desk, me: { did: desk.did, key: desk.authentication.privateKey } };
}

describe('a JWT-SVID is what its own claims say', () => {
  const target = expectTarget(jwtSvidTarget(BASES, 'run1', 'insurer.requests'));
  const asked = target.audience;
  const fetchWith = (svid: (jwt: string) => string) => {
    const w = world({ path: '/spiffe/jwt-svid', answer: (body) => ({ ...body, svid: svid(String(body.svid)) }) });
    return fetchJwtSvid({ client: w.client }, w.me, target);
  };

  it('takes its audience and its end from its payload, and gives the credential: the twin of the refusals below', async () => {
    const w = world();
    const result = await fetchJwtSvid({ client: w.client }, w.me, target);
    if (!result.ok) throw new Error(result.detail);
    const claims = claimsOf(result.value.bearer().slice('Bearer '.length));
    expect(claims.aud).toBe(asked);
    expect(result.value.audience).toStrictEqual([asked]);
    expect(result.value.expiresAt).toBe(Number(claims.exp) * 1000);
  });

  it('is accepted when its audience is a list of the one audience that was asked for', async () => {
    const result = await fetchWith((jwt) => reissue(jwt, (claims) => ({ ...claims, aud: [asked] })));
    expect(result).toMatchObject({ ok: true, value: { audience: [asked] } });
  });

  it('ends when its own exp says, and not when the answer says: an answer that names a later end gives the end of the token', async () => {
    const w = world({ path: '/spiffe/jwt-svid', answer: (body) => ({ ...body, expires_at: Number(body.expires_at) + 86_400 }) });
    const later = await fetchJwtSvid({ client: w.client }, w.me, target);
    if (!later.ok) throw new Error(later.detail);
    expect(later.value.expiresAt).toBe(Number(claimsOf(later.value.bearer().slice('Bearer '.length)).exp) * 1000);
    let exp = 0;
    const early = await fetchWith((jwt) =>
      reissue(jwt, (claims) => {
        exp = Number(claims.exp) - 100;
        return { ...claims, exp };
      }),
    );
    expect(early.ok && early.value.expiresAt).toBe(exp * 1000);
  });

  it.each([
    ['another audience', (claims: Record<string, unknown>) => ({ ...claims, aud: 'https://mock.example/t/run2/insurer' })],
    ['a list of another audience', (claims: Record<string, unknown>) => ({ ...claims, aud: ['https://mock.example/t/run2/insurer'] })],
    ['two audiences, one of them asked for', (claims: Record<string, unknown>) => ({ ...claims, aud: [asked, 'https://mock.example/t/run2/insurer'] })],
    ['the same audience two times', (claims: Record<string, unknown>) => ({ ...claims, aud: [asked, asked] })],
    ['no audience', (claims: Record<string, unknown>) => ({ ...claims, aud: undefined })],
    ['an empty list of audiences', (claims: Record<string, unknown>) => ({ ...claims, aud: [] })],
    ['an audience that is not text', (claims: Record<string, unknown>) => ({ ...claims, aud: 7 })],
  ])('is gateway_bad_response for %s', async (_name, change) => {
    const result = await fetchWith((jwt) => reissue(jwt, change));
    expect(result).toMatchObject({ ok: false, code: 'gateway_bad_response', detail: expect.stringContaining('audience') });
  });

  it.each([
    ['no exp', (claims: Record<string, unknown>) => ({ ...claims, exp: undefined })],
    ['an exp that is text', (claims: Record<string, unknown>) => ({ ...claims, exp: '1900000000' })],
    ['an exp of 0', (claims: Record<string, unknown>) => ({ ...claims, exp: 0 })],
    ['a negative exp', (claims: Record<string, unknown>) => ({ ...claims, exp: -5 })],
    ['an exp that is null', (claims: Record<string, unknown>) => ({ ...claims, exp: null })],
  ])('is gateway_bad_response for %s', async (_name, change) => {
    const result = await fetchWith((jwt) => reissue(jwt, change));
    expect(result).toMatchObject({ ok: false, code: 'gateway_bad_response', detail: expect.stringContaining('end time') });
  });

  it.each([
    ['a text with two parts', () => 'aaaa.bbbb'],
    ['a text with four parts', () => 'aaaa.bbbb.cccc.dddd'],
    ['a text with a part that is not base64url', () => `${b64u({ alg: 'ES256' })}.${b64u({ aud: asked, exp: 4_000_000_000 })}!.sig`],
    ['a text with an empty part', () => `${b64u({ alg: 'ES256' })}..sig`],
    ['a payload that is not JSON', () => `${b64u({ alg: 'ES256' })}.${b64u('not json')}.sig`],
    ['a payload that is a list', () => `${b64u({ alg: 'ES256' })}.${b64u([asked])}.sig`],
    ['a payload that is null', () => `${b64u({ alg: 'ES256' })}.${b64u('null')}.sig`],
  ])('is gateway_bad_response for %s', async (_name, svid) => {
    expect(await fetchWith(svid)).toMatchObject({ ok: false, code: 'gateway_bad_response' });
  });

  it('is refused for the audience of another tenant that the gateway issued although the request named this tenant, and accepted for this tenant: the probe of the review', async () => {
    const other = world({ path: '/spiffe/jwt-svid', request: (body) => ({ ...body, audience: 'https://mock.example/t/run2/insurer' }) });
    expect(await fetchJwtSvid({ client: other.client }, other.me, target)).toMatchObject({ ok: false, code: 'gateway_bad_response' });
    const same = world();
    expect((await fetchJwtSvid({ client: same.client }, same.me, target)).ok).toBe(true);
  });
});

describe('an X.509-SVID ends when its certificate ends', () => {
  const endOf = (pem: string): number => Date.parse(new X509Certificate(pem).validTo);

  it('takes its end from the notAfter of the certificate, and not from the answer: the twin is an answer that agrees', async () => {
    const agree = world();
    const first = await fetchX509Svid({ client: agree.client }, agree.me);
    if (!first.ok) throw new Error(first.detail);
    expect(first.value.expiresAt).toBe(endOf(first.value.certificate));
    for (const shift of [86_400, -1_800]) {
      const w = world({ path: '/spiffe/x509-svid', answer: (body) => ({ ...body, expires_at: Number(body.expires_at) + shift }) });
      const result = await fetchX509Svid({ client: w.client }, w.me);
      if (!result.ok) throw new Error(result.detail);
      expect(result.value.expiresAt, `${shift}`).toBe(endOf(result.value.certificate));
      expect(result.value.expiresAt).toBeGreaterThan(w.gateway.now());
      expect(result.value.expiresAt).toBeLessThanOrEqual(w.gateway.now() + 3_600_000);
    }
  });
});

describe('a failure of the gateway shows no part of a credential', () => {
  /** The pieces of a credential that a gateway could repeat: the signature, the payload and the whole text. */
  const partsOf = (jwt: string): string[] => [jwt, ...jwt.split('.')];

  it('holds no part of the subject token and no part of the DPoP proof in the detail of a refusal, and keeps the words around them', async () => {
    const seen: { subject: string; dpop: string } = { subject: '', dpop: '' };
    const w = gatewayWorld();
    const client = createGatewayClient({
      baseUrl: w.gateway.baseUrl,
      now: w.gateway.now,
      fetch: async (input, init) => {
        if (!String(input).endsWith('/token')) return w.gateway.fetch(input, init);
        seen.subject = new URLSearchParams(String(init?.body)).get('subject_token')!;
        seen.dpop = (init?.headers as Record<string, string>).dpop!;
        const description = `bad proof ${seen.dpop.split('.')[2]} for ${seen.subject.split('.')[2]}: payload ${seen.dpop.split('.')[1]} and whole ${seen.subject}`;
        return new Response(JSON.stringify({ error: 'invalid_grant', error_description: description }), { status: 400, headers: { 'content-type': 'application/json' } });
      },
    });
    const root = w.gateway.delegate({ delegator: { principalKey: w.hirer }, delegate: w.agent, actions: ['erp.*'], resources: ['*'], remaining: 1 });
    const result = await requestRouteToken({ client }, { target: erpTarget(), holder: 'agent', subject: { did: w.agent.did, key: w.agent.authentication.privateKey }, dpopKey: w.agent.delegation.privateKey, delegation: root.id });
    expect(result).toMatchObject({ ok: false, code: 'gateway_refused', status: 400, gatewayError: 'invalid_grant' });
    const text = JSON.stringify(result);
    for (const piece of [...partsOf(seen.subject), ...partsOf(seen.dpop)].filter((p) => p.length >= 12)) expect(text, piece.slice(0, 20)).not.toContain(piece);
    expect(text).toContain('[removed]');
    expect(text).toContain('bad proof');
  });

  it('keeps a detail that holds no credential as the gateway wrote it: the twin', async () => {
    const w = gatewayWorld();
    const client = createGatewayClient({
      baseUrl: w.gateway.baseUrl,
      now: w.gateway.now,
      fetch: async (input, init) =>
        String(input).endsWith('/token')
          ? new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'the delegate is not Active' }), { status: 400, headers: { 'content-type': 'application/json' } })
          : w.gateway.fetch(input, init),
    });
    const root = w.gateway.delegate({ delegator: { principalKey: w.hirer }, delegate: w.agent, actions: ['erp.*'], resources: ['*'], remaining: 1 });
    expect(
      await requestRouteToken({ client }, { target: erpTarget(), holder: 'agent', subject: { did: w.agent.did, key: w.agent.authentication.privateKey }, dpopKey: w.agent.delegation.privateKey, delegation: root.id }),
    ).toMatchObject({ ok: false, code: 'gateway_refused', detail: 'the delegate is not Active' });
  });

  it('holds no part of a proof in the detail of an answer of 5xx, and none in the detail of a gateway that cannot be reached', async () => {
    for (const [mode, code] of [['answer', 'gateway_unavailable'], ['network', 'gateway_unreachable']] as const) {
      const w = gatewayWorld();
      let dpop = '';
      const client = createGatewayClient({
        baseUrl: w.gateway.baseUrl,
        now: w.gateway.now,
        fetch: async (input, init) => {
          if (!String(input).endsWith('/token')) return w.gateway.fetch(input, init);
          dpop = (init?.headers as Record<string, string>).dpop!;
          if (mode === 'network') throw new Error(`connection reset while sending ${dpop}`);
          return new Response(JSON.stringify({ error: 'server_error', error_description: `failed on ${dpop.split('.')[2]}` }), { status: 503, headers: { 'content-type': 'application/json' } });
        },
      });
      const root = w.gateway.delegate({ delegator: { principalKey: w.hirer }, delegate: w.agent, actions: ['erp.*'], resources: ['*'], remaining: 1 });
      const result = await requestRouteToken({ client }, { target: erpTarget(), holder: 'agent', subject: { did: w.agent.did, key: w.agent.authentication.privateKey }, dpopKey: w.agent.delegation.privateKey, delegation: root.id });
      expect(result, mode).toMatchObject({ ok: false, code });
      for (const piece of partsOf(dpop).filter((p) => p.length >= 12)) expect(JSON.stringify(result), `${mode} ${piece.slice(0, 12)}`).not.toContain(piece);
    }
  });

  it('holds no part of the subject token of a JWT-SVID request, and no part of the proof of an X.509-SVID request', async () => {
    const w = gatewayWorld();
    const desk = w.gateway.createAgent({ label: 'order-desk' });
    const sent: string[] = [];
    const client = createGatewayClient({
      baseUrl: w.gateway.baseUrl,
      now: w.gateway.now,
      fetch: async (input, init) => {
        const path = String(input);
        if (!path.endsWith('/spiffe/jwt-svid') && !path.endsWith('/spiffe/x509-svid')) return w.gateway.fetch(input, init);
        const body = JSON.parse(String(init?.body)) as Record<string, string>;
        const token = (body.subject_token ?? body.proof)!;
        sent.push(token);
        return new Response(JSON.stringify({ error: 'invalid_request', error_description: `cannot read ${token.split('.')[2]} nor ${token}` }), { status: 400, headers: { 'content-type': 'application/json' } });
      },
    });
    const me = { did: desk.did, key: desk.authentication.privateKey };
    const jwt = await fetchJwtSvid({ client }, me, expectTarget(jwtSvidTarget(BASES, 'run1', 'insurer.requests')));
    const x509 = await fetchX509Svid({ client }, me);
    expect(jwt).toMatchObject({ ok: false, code: 'gateway_refused' });
    expect(x509).toMatchObject({ ok: false, code: 'gateway_refused' });
    expect(sent).toHaveLength(2);
    for (const [token, result] of [[sent[0]!, jwt], [sent[1]!, x509]] as const) {
      for (const piece of partsOf(token).filter((p) => p.length >= 12)) expect(JSON.stringify(result)).not.toContain(piece);
    }
  });

  it('holds no part of the subject token in the message of an error that a key throws, and keeps its words', async () => {
    const w = gatewayWorld();
    const signatures: string[] = [];
    const authentication = w.agent.authentication.privateKey;
    const subjectKey: SignerKey = {
      algorithm: 'EdDSA',
      publicKey: createPublicKey(authentication),
      sign: (data) => {
        const signature = new Uint8Array(nodeSign(null, data, authentication));
        signatures.push(Buffer.from(signature).toString('base64url'));
        return signature;
      },
    };
    const delegation = w.agent.delegation.privateKey;
    const brokenKey: SignerKey = {
      algorithm: 'EdDSA',
      publicKey: createPublicKey(delegation),
      sign: () => {
        throw new RangeError(`the device refused after ${signatures[0]}`);
      },
    };
    const root = w.gateway.delegate({ delegator: { principalKey: w.hirer }, delegate: w.agent, actions: ['erp.*'], resources: ['*'], remaining: 1 });
    const result = await requestRouteToken({ client: w.client }, { target: erpTarget(), holder: 'agent', subject: { did: w.agent.did, key: subjectKey }, dpopKey: brokenKey, delegation: root.id });
    expect(signatures).toHaveLength(1);
    expect(result).toMatchObject({ ok: false, code: 'bad_request', detail: expect.stringContaining('the device refused after') });
    expect(JSON.stringify(result)).not.toContain(signatures[0]);
  });

  it('gives a token to a caller whose keys are signer functions and not key objects: the twin, with the same proofs', async () => {
    const w = gatewayWorld();
    const signerOf = (privateKey: KeyObject): SignerKey => ({ algorithm: 'EdDSA', publicKey: createPublicKey(privateKey), sign: (data) => new Uint8Array(nodeSign(null, data, privateKey)) });
    const root = w.gateway.delegate({ delegator: { principalKey: w.hirer }, delegate: w.agent, actions: ['erp.*'], resources: ['*'], remaining: 1 });
    const result = await requestRouteToken(
      { client: w.client },
      { target: erpTarget(), holder: 'agent', subject: { did: w.agent.did, key: signerOf(w.agent.authentication.privateKey) }, dpopKey: signerOf(w.agent.delegation.privateKey), delegation: root.id },
    );
    expect(result.ok).toBe(true);
  });
});
