// The log. Each call to a system of a tenant gives exactly one line, on stdout and in the log of the tenant, and it is the same line. The line has the identity that the service verified (`sub`, the
// `act` chain, the delegation), the route, the tenant and the decision with the code and the rule that refused. A field of the identity holds a fact that was verified and nothing else: a token that
// fails its signature shows no identity. No line and no answer of GET /t/<tenant>/log holds a credential. Each test has an accepted call and a refused call for a route that takes a token, for the
// route that takes an X.509-SVID and for the route that takes a JWT-SVID. The credentials are real ones of the stub gateway, and they go through the real service.
import { X509Certificate } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createGatewayClient } from '@vsa/id-kit';
import { createStubGateway } from '@vsa/id-kit/testing';
import { callWithToken, delegateTo, insurerAgent, purchaseOrder, scenario, supplierAgent, tokenFor } from './support/scenario.ts';
import type { Scenario } from './support/scenario.ts';
import type { Reply } from './support/net.ts';
import { MTLS_HOST, OPERATOR_TOKEN, PUBLIC_BASE, PUBLIC_HOST, SUPPLIER_ORG, T0 } from './support/world.ts';

const TENANT = 'run1';
const CATALOGUE = `/t/${TENANT}/supplier/catalogue/GLV-NIT-M`;
const REQUIREMENTS = `/t/${TENANT}/insurer/requirements/SYN-MRI-LS`;
const AUDIENCE = `${PUBLIC_BASE}/t/${TENANT}/insurer`;
const NOW = new Date(T0).toISOString();

interface Line {
  at: string;
  tenant: string | null;
  route: string | null;
  method: string;
  path: string;
  host: string;
  credential: string;
  sub: string | null;
  act: string[];
  delegation: string | null;
  decision: string;
  status: number;
  code: string | null;
  rule: string | null;
  token_status: unknown;
}

/** The fields of a line, and no other: a field that holds the headers of a call, or its body, would be one more. */
const LINE_FIELDS = ['act', 'at', 'code', 'credential', 'decision', 'delegation', 'host', 'method', 'path', 'route', 'rule', 'status', 'sub', 'tenant', 'token_status'];

const spiffeOf = (s: Scenario, agent: { id: string }): string => `spiffe://${s.world.gateway.trustDomain}/agent/${agent.id}`;
/** The `sub` of a token that the member's delegation gave: the principal key of the member, at the gateway. */
const principalOf = (s: Scenario): string => `${s.world.gateway.baseUrl}/principals/key/${s.world.member.keyHash}`;

async function tenantLog(s: Scenario, tenant: string): Promise<Line[]> {
  const reply = await s.harness.call({ path: `/t/${tenant}/log` });
  expect(reply.status, reply.text).toBe(200);
  const body = reply.json as { lines: Line[] }; // the shape of the answer of GET /log: the test reads the lines of it
  return body.lines;
}

/** One call, and what it wrote: exactly one line on stdout, and the same line, and no other, added to the log of the tenant. */
async function observed(s: Scenario, tenant: string, call: () => Promise<Reply>): Promise<{ reply: Reply; line: Line }> {
  const inLog = (await tenantLog(s, tenant)).length;
  const onStdout = s.harness.lines.length;
  const reply = await call();
  const written = s.harness.logged().slice(onStdout) as unknown as Line[];
  expect(written, 'the lines that the call wrote to stdout').toHaveLength(1);
  expect((await tenantLog(s, tenant)).slice(inLog), 'the lines that the call added to the log of the tenant').toEqual(written);
  expect(Object.keys(written[0]!).sort()).toEqual(LINE_FIELDS);
  return { reply, line: written[0]! };
}

/** The certificate of an agent of another gateway, as the header Client-Cert of a proxy carries it. The bundle of this gateway does not hold its authority. */
async function foreignCertificate(s: Scenario): Promise<string> {
  const other = createStubGateway({ baseUrl: 'https://id.other-domain.test', now: s.world.now });
  const agent = other.createAgent({ label: 'order-desk', organisation: { domain: SUPPLIER_ORG, verified: true } });
  const client = createGatewayClient({ baseUrl: other.baseUrl, fetch: other.fetch, now: s.world.now });
  const issued = await client.x509Svid({ agent: { did: agent.did, key: agent.authentication.privateKey } });
  if (!issued.ok) throw new Error(issued.detail);
  return `:${new X509Certificate(issued.value.certificate).raw.toString('base64')}:`;
}

/** The token with other claims and the signature that it had: the signature does not verify. */
function tampered(token: string, change: (claims: Record<string, unknown>) => void): string {
  const [header, payload, signature] = token.split('.');
  const claims = JSON.parse(Buffer.from(payload!, 'base64url').toString('utf8')) as Record<string, unknown>;
  change(claims);
  return `${header}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.${signature}`;
}

const viaCert = (s: Scenario, header: string) => s.harness.call({ path: CATALOGUE, host: MTLS_HOST, headers: { 'client-cert': header } });
const viaJwt = (s: Scenario, jwt: string) => s.harness.call({ path: REQUIREMENTS, headers: { authorization: `Bearer ${jwt}` } });

describe('a call with a token', () => {
  it('accepted: one line with the identity that was verified, the route, the tenant and the decision', async () => {
    const s = await scenario(TENANT);
    const agent = delegateTo(s, 'reorder', [['po.write', 'po']]);
    const { reply, line } = await observed(s, TENANT, () => callWithToken(s, agent, 'po', 'POST', '/po', purchaseOrder(TENANT, 'run1-1')));
    expect(reply.status, reply.text).toBe(201);
    expect(line).toEqual({
      at: NOW, tenant: TENANT, route: 'POST /po', method: 'POST', path: `/t/${TENANT}/po`, host: 'token', credential: 'token', sub: principalOf(s), act: [agent.agent.did], delegation: agent.delegation.id,
      decision: 'allowed', status: 201, code: null, rule: null, token_status: { read: true, age_seconds: expect.any(Number) },
    });
  });

  it('accepted for a subagent: the act chain has the subagent first and its agent after it, and the delegation is the one of the subagent', async () => {
    const s = await scenario(TENANT);
    const agent = delegateTo(s, 'reorder', [['erp.stock.read', 'erp']]);
    const sub = delegateTo(s, 'stock-reader', [['erp.stock.read', 'erp']], { parent: agent.agent, parentDelegation: agent.delegation });
    const { reply, line } = await observed(s, TENANT, () => callWithToken(s, sub, 'erp', 'GET', '/erp/stock/GLV-NIT-M'));
    expect(reply.status, reply.text).toBe(200);
    expect(line).toMatchObject({ route: 'GET /erp/stock/{sku}', sub: principalOf(s), act: [sub.agent.did, agent.agent.did], delegation: sub.delegation.id, decision: 'allowed', status: 200 });
  });

  it('refused after its signature was verified: the line has the code, the rule and the identity of the token, and no token status', async () => {
    const s = await scenario(TENANT);
    const reader = delegateTo(s, 'reader', [['erp.stock.read', 'po']]);
    const { reply, line } = await observed(s, TENANT, () => callWithToken(s, reader, 'po', 'POST', '/po', purchaseOrder(TENANT, 'run1-1')));
    expect([reply.status, reply.json?.error]).toEqual([403, 'not_covered']);
    expect(line).toEqual({
      at: NOW, tenant: TENANT, route: 'POST /po', method: 'POST', path: `/t/${TENANT}/po`, host: 'token', credential: 'token', sub: principalOf(s), act: [reader.agent.did], delegation: reader.delegation.id,
      decision: 'refused', status: 403, code: 'not_covered', rule: 'delegation.action', token_status: null,
    });
  });

  it('refused for a delegation that ended on the ledger: the line names the delegation', async () => {
    const s = await scenario(TENANT);
    const agent = delegateTo(s, 'reorder', [['po.write', 'po']]);
    const credential = await tokenFor(s, agent, 'po');
    s.world.end(agent.delegation);
    const { reply, line } = await observed(s, TENANT, () => s.harness.tokenCall({ tenant: TENANT, credential, method: 'POST', route: '/po', body: purchaseOrder(TENANT, 'run1-1') }));
    expect([reply.status, reply.json?.error]).toEqual([403, 'delegation_ended']);
    expect(line).toMatchObject({ decision: 'refused', status: 403, code: 'delegation_ended', rule: 'delegation.refused', sub: principalOf(s), act: [agent.agent.did], delegation: agent.delegation.id });
  });

  it('refused for a signature that does not verify: the claims are the sender\'s, so the line shows no identity, and the same token before the change is accepted', async () => {
    const s = await scenario(TENANT);
    const agent = delegateTo(s, 'reorder', [['po.write', 'po']]);
    const credential = await tokenFor(s, agent, 'po');
    const url = `${PUBLIC_BASE}/t/${TENANT}/po`;
    const forgedSub = `${s.world.gateway.baseUrl}/principals/key/${'ab'.repeat(28)}`;
    const forgedAgent = `did:vector:${'cd'.repeat(32)}`;
    const forgedDelegation = 'ef'.repeat(32);
    const forged = tampered(credential.accessToken, (claims) => {
      claims.sub = forgedSub;
      claims.act = { sub: forgedAgent };
      const details = claims.authorization_details as Array<Record<string, unknown>>; // the claim of a token that the gateway made
      details[0]!.identifier = forgedDelegation;
    });
    const headers = await s.world.presented(credential, 'POST', url);
    const { reply, line } = await observed(s, TENANT, () => s.harness.call({ method: 'POST', path: `/t/${TENANT}/po`, headers: { ...headers, authorization: `DPoP ${forged}` }, body: purchaseOrder(TENANT, 'run1-1') }));
    expect([reply.status, reply.json?.error]).toEqual([401, 'token_invalid']);
    expect(line).toMatchObject({ decision: 'refused', status: 401, code: 'token_invalid', rule: 'token.signature', credential: 'token', sub: null, act: [], delegation: null });
    for (const claim of [forgedSub, forgedAgent, forgedDelegation]) expect(JSON.stringify(line)).not.toContain(claim);
    const { reply: fine, line: accepted } = await observed(s, TENANT, () => s.harness.call({ method: 'POST', path: `/t/${TENANT}/po`, headers: { ...headers, authorization: `DPoP ${credential.accessToken}` }, body: purchaseOrder(TENANT, 'run1-1') }));
    expect(fine.status, fine.text).toBe(201);
    expect(accepted).toMatchObject({ decision: 'allowed', sub: principalOf(s), act: [agent.agent.did], delegation: agent.delegation.id });
  });
});

describe('a call with an X.509-SVID', () => {
  it('accepted: one line with the SPIFFE ID that was verified, no act chain and no delegation', async () => {
    const s = await scenario(TENANT);
    const agent = supplierAgent(s);
    const { reply, line } = await observed(s, TENANT, async () => viaCert(s, await s.world.clientCert(agent)));
    expect(reply.status, reply.text).toBe(200);
    expect(line).toEqual({
      at: NOW, tenant: TENANT, route: 'GET /supplier/catalogue/{sku}', method: 'GET', path: CATALOGUE, host: 'mtls', credential: 'x509-svid', sub: spiffeOf(s, agent), act: [], delegation: null,
      decision: 'allowed', status: 200, code: null, rule: null, token_status: null,
    });
  });

  it('refused for the agent: the certificate was verified, so the line has the SPIFFE ID, the code and the rule', async () => {
    const s = await scenario(TENANT);
    const agent = insurerAgent(s, 'intake');
    const { reply, line } = await observed(s, TENANT, async () => viaCert(s, await s.world.clientCert(agent)));
    expect([reply.status, reply.json?.error]).toEqual([403, 'organisation_mismatch']);
    expect(line).toEqual({
      at: NOW, tenant: TENANT, route: 'GET /supplier/catalogue/{sku}', method: 'GET', path: CATALOGUE, host: 'mtls', credential: 'x509-svid', sub: spiffeOf(s, agent), act: [], delegation: null,
      decision: 'refused', status: 403, code: 'organisation_mismatch', rule: 'agent.organisation', token_status: null,
    });
  });

  it('refused for a certificate that does not chain to the bundle: nothing is verified, so the line has no SPIFFE ID', async () => {
    const s = await scenario(TENANT);
    const { reply, line } = await observed(s, TENANT, async () => viaCert(s, await foreignCertificate(s)));
    expect([reply.status, reply.json?.error]).toEqual([401, 'svid_invalid']);
    expect(line).toMatchObject({ credential: 'x509-svid', sub: null, act: [], delegation: null, decision: 'refused', status: 401, code: 'svid_invalid', rule: 'x509.untrusted' });
  });
});

describe('a call with a JWT-SVID', () => {
  it('accepted: one line with the SPIFFE ID that was verified, no act chain and no delegation', async () => {
    const s = await scenario(TENANT);
    const agent = insurerAgent(s);
    const { reply, line } = await observed(s, TENANT, async () => viaJwt(s, await s.world.jwtSvid(agent, AUDIENCE)));
    expect(reply.status, reply.text).toBe(200);
    expect(line).toEqual({
      at: NOW, tenant: TENANT, route: 'GET /insurer/requirements/{service_code}', method: 'GET', path: REQUIREMENTS, host: 'token', credential: 'jwt-svid', sub: spiffeOf(s, agent), act: [], delegation: null,
      decision: 'allowed', status: 200, code: null, rule: null, token_status: null,
    });
  });

  it('refused for the agent: the JWT-SVID was verified, so the line has the SPIFFE ID, the code and the rule', async () => {
    const s = await scenario(TENANT);
    const agent = supplierAgent(s, 'desk');
    const { reply, line } = await observed(s, TENANT, async () => viaJwt(s, await s.world.jwtSvid(agent, AUDIENCE)));
    expect([reply.status, reply.json?.error]).toEqual([403, 'organisation_mismatch']);
    expect(line).toEqual({
      at: NOW, tenant: TENANT, route: 'GET /insurer/requirements/{service_code}', method: 'GET', path: REQUIREMENTS, host: 'token', credential: 'jwt-svid', sub: spiffeOf(s, agent), act: [], delegation: null,
      decision: 'refused', status: 403, code: 'organisation_mismatch', rule: 'agent.organisation', token_status: null,
    });
  });

  it('refused for another audience: it is not verified for this route, so the line has no SPIFFE ID', async () => {
    const s = await scenario(TENANT);
    const agent = insurerAgent(s);
    const { reply, line } = await observed(s, TENANT, async () => viaJwt(s, await s.world.jwtSvid(agent, `${PUBLIC_BASE}/t/${TENANT}/po`)));
    expect([reply.status, reply.json?.error]).toEqual([401, 'svid_invalid']);
    expect(line).toMatchObject({ credential: 'jwt-svid', sub: null, act: [], delegation: null, decision: 'refused', status: 401, code: 'svid_invalid', rule: 'jwt_svid.audience' });
  });
});

describe('the log of a tenant', () => {
  it('holds the calls of its own tenant and no other: every line names the tenant, and each log has the calls that its tenant had', async () => {
    const s = await scenario('run1');
    expect((await s.harness.seed('run2')).status).toBe(201);
    const agent = delegateTo(s, 'reorder', [['po.write', 'po']]);
    const desk = supplierAgent(s);
    const clerk = insurerAgent(s);
    expect((await callWithToken(s, agent, 'po', 'POST', '/po', purchaseOrder('run1', 'run1-1'))).status).toBe(201);
    expect((await s.harness.call({ path: '/t/run1/supplier/catalogue/GLV-NIT-M', host: MTLS_HOST, headers: { 'client-cert': await s.world.clientCert(desk) } })).status).toBe(200);
    expect((await s.harness.call({ path: '/t/run2/insurer/requirements/SYN-MRI-LS', headers: { authorization: `Bearer ${await s.world.jwtSvid(clerk, `${PUBLIC_BASE}/t/run2/insurer`)}` } })).status).toBe(200);
    expect((await s.harness.call({ path: '/t/run2/supplier/catalogue/GLV-NIT-M', host: MTLS_HOST, headers: { 'client-cert': await s.world.clientCert(clerk) } })).status).toBe(403);
    expect((await s.harness.call({ path: '/t/ghost/vendors' })).status).toBe(404);
    const first = await tenantLog(s, 'run1');
    const second = await tenantLog(s, 'run2');
    expect(first.map((line) => [line.tenant, line.route, line.decision, line.code])).toEqual([['run1', 'POST /po', 'allowed', null], ['run1', 'GET /supplier/catalogue/{sku}', 'allowed', null]]);
    expect(second.map((line) => [line.tenant, line.route, line.decision, line.code])).toEqual([
      ['run2', 'GET /insurer/requirements/{service_code}', 'allowed', null], ['run2', 'GET /supplier/catalogue/{sku}', 'refused', 'organisation_mismatch'],
    ]);
    // The call to a tenant that does not exist is on stdout and in no log.
    expect(s.harness.logged().filter((line) => line.tenant === 'ghost')).toMatchObject([{ decision: 'refused', code: 'tenant_not_found' }]);
    expect((await s.harness.call({ path: '/t/ghost/log' })).status).toBe(404);
  });

  it('has a line for a call that was refused before any credential was read, with no identity', async () => {
    const s = await scenario(TENANT);
    const { reply, line } = await observed(s, TENANT, () => s.harness.call({ path: CATALOGUE, host: PUBLIC_HOST }));
    expect([reply.status, reply.json?.error]).toEqual([421, 'wrong_host']);
    expect(line).toEqual({
      at: NOW, tenant: TENANT, route: 'GET /supplier/catalogue/{sku}', method: 'GET', path: CATALOGUE, host: 'token', credential: 'none', sub: null, act: [], delegation: null,
      decision: 'refused', status: 421, code: 'wrong_host', rule: 'host.mtls_only', token_status: null,
    });
  });

  it('gets no line from a read of the state, of the log or of the check of health', async () => {
    const s = await scenario(TENANT);
    const agent = delegateTo(s, 'reorder', [['po.write', 'po']]);
    expect((await callWithToken(s, agent, 'po', 'POST', '/po', purchaseOrder(TENANT, 'run1-1'))).status).toBe(201);
    const before = await tenantLog(s, TENANT);
    expect(before).toHaveLength(1);
    const onStdout = s.harness.lines.length;
    for (const [path, host] of [[`/t/${TENANT}/state`, PUBLIC_HOST], [`/t/${TENANT}/log`, PUBLIC_HOST], ['/healthz', PUBLIC_HOST], ['/healthz', MTLS_HOST]] as const) {
      expect((await s.harness.call({ path, host })).status, path).toBe(200);
    }
    expect(await tenantLog(s, TENANT)).toEqual(before);
    // The reads of the state and of the log are on stdout, each with no credential. The check of health writes no line.
    expect(s.harness.logged().slice(onStdout, onStdout + 2)).toMatchObject([
      { route: 'GET /state', tenant: TENANT, credential: 'none', decision: 'allowed', status: 200 }, { route: 'GET /log', tenant: TENANT, credential: 'none', decision: 'allowed', status: 200 },
    ]);
    expect(s.harness.lines.length).toBe(onStdout + 3);
  });
});

/** The text of a credential that must not be in the log: the whole of it, and the parts of it that a line could carry without the whole. */
interface Secret {
  name: string;
  pieces: string[];
}

const MIN_PIECE = 16;
const windows = (text: string, size: number, step: number): string[] => {
  const found: string[] = [];
  for (let at = 0; at + size <= text.length; at += step) found.push(text.slice(at, at + size));
  found.push(text.slice(-size));
  return found;
};

/** A JWT: the whole token and each of its three base64url parts. */
const jwtSecret = (name: string, jwt: string): Secret => ({ name, pieces: [jwt, ...jwt.split('.')].filter((piece) => piece.length >= MIN_PIECE) });

/** The bytes of a certificate, from the header Client-Cert: the header, its base64, windows of the base64 and of its base64url form, and windows of the hex of the DER. */
const certificateSecret = (name: string, header: string): Secret => {
  const base64 = header.slice(1, -1);
  const der = Buffer.from(base64, 'base64');
  return { name, pieces: [header, base64, ...windows(base64, 40, 20), ...windows(der.toString('base64url'), 40, 20), ...windows(der.toString('hex'), 64, 32)] };
};

/** An opaque token: the whole of it, and windows of it. */
const tokenSecret = (name: string, token: string): Secret => ({ name, pieces: [token, ...windows(token, MIN_PIECE, 8)] });

/** The pieces of a secret that the output holds. */
const found = (output: string, secret: Secret): string[] => secret.pieces.filter((piece) => output.includes(piece));

describe('what the log never holds', () => {
  it('finds a credential that a line holds: the search below has teeth', async () => {
    const s = await scenario(TENANT);
    const agent = delegateTo(s, 'reorder', [['po.write', 'po']]);
    const credential = await tokenFor(s, agent, 'po');
    const header = await s.world.clientCert(supplierAgent(s));
    const secrets = [jwtSecret('access token', credential.accessToken), certificateSecret('certificate', header), tokenSecret('operator token', OPERATOR_TOKEN)];
    for (const secret of secrets) {
      expect(secret.pieces.length, secret.name).toBeGreaterThan(2);
      expect(found('nothing of it', secret), secret.name).toEqual([]);
      for (const piece of secret.pieces) expect(found(`{"x":"${piece}"}`, secret), `${secret.name}: ${piece.slice(0, 20)}`).toContain(piece);
    }
  });

  it('is a token, a proof, a JWT-SVID, the bytes of a certificate or the operator token: none is on stdout or in the answer of a log, accepted or refused', async () => {
    const s = await scenario(TENANT);
    expect((await s.harness.seed('run2')).status).toBe(201);
    const secrets: Secret[] = [];
    const sent = (reply: Reply, status: number, what: string): void => { expect(reply.status, `${what}: ${reply.text}`).toBe(status); };

    // A token and its proof: accepted, then for another URL (refused by the proof), then after its delegation ended (refused by the ledger), then with a Client-Cert header that no route takes.
    const agent = delegateTo(s, 'reorder', [['po.write', 'po'], ['erp.stock.read', 'erp']]);
    for (const [name, route, status] of [['token accepted', 'po', 201], ['token with a proof for another URL', 'erp', 401]] as const) {
      const credential = await tokenFor(s, agent, 'po');
      const headers = await s.world.presented(credential, 'POST', `${PUBLIC_BASE}/t/${TENANT}/${route}`);
      secrets.push(jwtSecret(`${name}: access token`, credential.accessToken), jwtSecret(`${name}: proof`, headers.dpop!));
      sent(await s.harness.call({ method: 'POST', path: `/t/${TENANT}/po`, headers, body: purchaseOrder(TENANT, `run1-${secrets.length}`) }), status, name);
    }
    const ended = delegateTo(s, 'ended', [['po.write', 'po']]);
    const endedCredential = await tokenFor(s, ended, 'po');
    s.world.end(ended.delegation);
    const endedHeaders = await s.world.presented(endedCredential, 'POST', `${PUBLIC_BASE}/t/${TENANT}/po`);
    secrets.push(jwtSecret('ended delegation: access token', endedCredential.accessToken), jwtSecret('ended delegation: proof', endedHeaders.dpop!));
    sent(await s.harness.call({ method: 'POST', path: `/t/${TENANT}/po`, headers: endedHeaders, body: purchaseOrder(TENANT, 'run1-ended') }), 403, 'ended delegation');

    // A JWT-SVID: accepted, for another audience, and of an agent of another organisation.
    const clerk = insurerAgent(s);
    const stranger = supplierAgent(s, 'desk-for-jwt');
    for (const [name, who, audience, status] of [['JWT-SVID accepted', clerk, AUDIENCE, 200], ['JWT-SVID for another audience', clerk, `${PUBLIC_BASE}/t/${TENANT}/po`, 401], ['JWT-SVID of another organisation', stranger, AUDIENCE, 403]] as const) {
      const jwt = await s.world.jwtSvid(who, audience);
      secrets.push(jwtSecret(name, jwt));
      sent(await viaJwt(s, jwt), status, name);
    }

    // A certificate: accepted, of an agent of another organisation, of another gateway, and sent to the host of tokens, where no certificate belongs.
    const desk = supplierAgent(s, 'desk');
    const accepted = await s.world.clientCert(desk);
    const other = await s.world.clientCert(insurerAgent(s, 'clerk-for-cert'));
    const foreign = await foreignCertificate(s);
    secrets.push(certificateSecret('certificate accepted', accepted), certificateSecret('certificate of another organisation', other), certificateSecret('certificate of another gateway', foreign));
    sent(await viaCert(s, accepted), 200, 'certificate accepted');
    sent(await viaCert(s, other), 403, 'certificate of another organisation');
    sent(await viaCert(s, foreign), 401, 'certificate of another gateway');
    sent(await s.harness.call({ path: CATALOGUE, host: PUBLIC_HOST, headers: { 'client-cert': accepted } }), 400, 'certificate on the host of tokens');

    // The operator token: right, and wrong.
    const wrong = `${OPERATOR_TOKEN.slice(0, -8)}wrong-000`;
    secrets.push(tokenSecret('operator token', OPERATOR_TOKEN), tokenSecret('wrong operator token', wrong));
    sent(await s.harness.seed('run3'), 201, 'operator token');
    sent(await s.harness.seed('run4', {}, wrong), 401, 'wrong operator token');

    const answers = await Promise.all(['run1', 'run2', 'run3'].map(async (tenant) => (await s.harness.call({ path: `/t/${tenant}/log` })).text));
    const output = [s.harness.lines.join('\n'), ...answers].join('\n');
    expect(s.harness.logged().filter((line) => line.tenant === TENANT).length, 'the calls are in the log').toBeGreaterThanOrEqual(10);
    for (const secret of secrets) expect(found(output, secret), secret.name).toEqual([]);
  });
});
