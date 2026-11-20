// Does the service ever honour an SVID call whose authority never existed or ended? Each test makes one call that must be refused, with the call that is accepted beside it: the same agent,
// the same route, and the fault taken away. The certificate comes in the header Client-Cert on the client-certificate host only; the JWT-SVID comes in Authorization on the host of tokens.
// The SVIDs, the bundle and the DID resolution are the stub gateway's, and one clock moves the gateway, the verifier and the service.
import { X509Certificate } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createGatewayClient } from '@vsa/id-kit';
import { createStubGateway } from '@vsa/id-kit/testing';
import type { StubAgent, StubGateway } from '@vsa/id-kit/testing';
import { insurerAgent, scenario, supplierAgent } from './support/scenario.ts';
import type { Scenario } from './support/scenario.ts';
import { INSURER_ORG, MTLS_HOST, PUBLIC_BASE, PUBLIC_HOST, SUPPLIER_ORG } from './support/world.ts';

const TENANT = 'run1';
const CATALOGUE = `/t/${TENANT}/supplier/catalogue/GLV-NIT-M`;
const REQUIREMENTS = `/t/${TENANT}/insurer/requirements/SYN-MRI-LS`;
const AUDIENCE = `${PUBLIC_BASE}/t/${TENANT}/insurer`;

const refused = (reply: { status: number; json: Record<string, unknown> | null }, status: number, code: string) => {
  expect([reply.status, reply.json?.error]).toEqual([status, code]);
};
const lastRule = (s: Scenario): unknown => s.harness.logged().at(-1)?.rule;

/** A call to an X.509 route, on the client-certificate host, with the header that the proxy would set. */
async function x509(s: Scenario, header: string | string[], path = CATALOGUE) {
  return s.harness.call({ path, host: MTLS_HOST, headers: { 'client-cert': header } });
}
async function viaCert(s: Scenario, agent: StubAgent, path = CATALOGUE) {
  return x509(s, await s.world.clientCert(agent), path);
}
async function viaJwt(s: Scenario, agent: StubAgent, audience = AUDIENCE, path = REQUIREMENTS) {
  return s.harness.call({ path, headers: { authorization: `Bearer ${await s.world.jwtSvid(agent, audience)}` } });
}

/** An agent of another gateway, with another trust domain: its SVIDs do not chain to the bundle of this one. */
async function stranger(s: Scenario) {
  const other = createStubGateway({ baseUrl: 'https://id.other-domain.test', now: s.world.now });
  const agent = other.createAgent({ label: 'order-desk', organisation: { domain: SUPPLIER_ORG, verified: true } });
  const client = createGatewayClient({ baseUrl: other.baseUrl, fetch: other.fetch, now: s.world.now });
  /** The header that a proxy would set for an X.509-SVID that this stranger holds. */
  const clientCert = async (): Promise<string> => {
    const issued = await client.x509Svid({ agent: { did: agent.did, key: agent.authentication.privateKey } });
    if (!issued.ok) throw new Error(issued.detail);
    return `:${new X509Certificate(issued.value.certificate).raw.toString('base64')}:`;
  };
  return { other, agent, client, clientCert };
}

/**
 * The bundle of this gateway with the keys of another gateway added to it: a federation of two trust domains. The service reads this bundle. The SVIDs of the other domain chain to it, and
 * only their trust domain tells them from the SVIDs of this one.
 */
async function federate(s: Scenario, other: StubGateway): Promise<void> {
  const read = async (gateway: StubGateway) => (await (await gateway.fetch(`${gateway.baseUrl}/spiffe/bundle`)).json()) as { keys: unknown[] };
  const [own, foreign] = [await read(s.world.gateway), await read(other)];
  s.world.gateway.fault('/spiffe/bundle', { status: 200, body: JSON.stringify({ ...own, keys: [...own.keys, ...foreign.keys] }), headers: { 'content-type': 'application/json' } });
}

/** The record of an agent as the gateway resolves it, with the period of its Accountable Party changed. The gateway answers with that record for this DID from now on. */
async function changeParty(s: Scenario, agent: StubAgent, period: { notBefore?: string; notAfter?: string }): Promise<void> {
  const path = `/1.0/identifiers/${agent.did}`;
  const record = (await (await s.world.gateway.fetch(`${s.world.gateway.baseUrl}${path}`)).json()) as { didDocumentMetadata: { vectorParties: Array<Record<string, unknown>> } };
  Object.assign(record.didDocumentMetadata.vectorParties[0]!, period);
  s.world.gateway.fault(path, { status: 200, body: JSON.stringify(record), headers: { 'content-type': 'application/did-resolution' } });
}

const NOT_FOUND_BODY = JSON.stringify({ didDocument: null, didResolutionMetadata: { error: { type: 'https://www.w3.org/ns/did#NOT_FOUND', title: 'DID not found' } }, didDocumentMetadata: {} });

describe('an X.509-SVID that is right', () => {
  it('is honoured: the Order Desk reads the catalogue, and the call is in the log with the SPIFFE ID that was verified', async () => {
    const s = await scenario(TENANT);
    const agent = supplierAgent(s);
    const reply = await viaCert(s, agent);
    expect(reply.status, reply.text).toBe(200);
    expect(s.harness.logged().at(-1)).toMatchObject({
      tenant: TENANT, route: 'GET /supplier/catalogue/{sku}', host: 'mtls', credential: 'x509-svid', sub: `spiffe://id.vector.apexfusion.org/agent/${agent.id}`, act: [], delegation: null, decision: 'allowed', status: 200,
    });
  });
});

describe('an X.509-SVID that is not right', () => {
  it('a certificate of another trust domain is refused: it does not chain to the bundle of this gateway', async () => {
    const s = await scenario(TENANT);
    const { clientCert } = await stranger(s);
    const reply = await x509(s, await clientCert());
    refused(reply, 401, 'svid_invalid');
    expect(lastRule(s)).toBe('x509.untrusted');
    expect((await viaCert(s, supplierAgent(s))).status).toBe(200);
  });
  it('a certificate that has expired is refused, and the same certificate before its end was honoured', async () => {
    const s = await scenario(TENANT);
    const header = await s.world.clientCert(supplierAgent(s));
    expect((await x509(s, header)).status).toBe(200);
    s.world.advance(2 * 3_600_000);
    refused(await x509(s, header), 401, 'svid_invalid');
    expect(lastRule(s)).toBe('x509.expired');
  });
  it('a certificate of another trust domain is refused for its trust domain when the bundle holds the authority of that domain too, and the certificate of this domain is accepted with the same bundle', async () => {
    const s = await scenario(TENANT);
    const { other, clientCert } = await stranger(s);
    await federate(s, other);
    // The same agent exists at this gateway, so the certificate would be honoured if its trust domain were not checked.
    const own = supplierAgent(s, 'order-desk');
    refused(await x509(s, await clientCert()), 401, 'svid_invalid');
    expect(lastRule(s)).toBe('x509.trust_domain');
    expect((await viaCert(s, own)).status).toBe(200);
  });
  it('a certificate that is not valid yet is refused, and the same certificate is accepted when its start is inside the leeway of 30 seconds', async () => {
    const s = await scenario(TENANT);
    const agent = supplierAgent(s);
    // The first certificate makes the authority of the stub, which starts one minute before. The second certificate starts later. When the clock goes back, the authority is valid and the certificate is not.
    expect((await viaCert(s, agent)).status).toBe(200);
    s.world.advance(600_000);
    const header = await s.world.clientCert(agent);
    s.world.advance(-500_000);
    refused(await x509(s, header), 401, 'svid_invalid');
    expect(lastRule(s)).toBe('x509.not_yet_valid');
    s.world.advance(420_000);
    expect((await x509(s, header)).status).toBe(200);
  });
  it('a certificate whose bytes are no certificate is refused, and a header that is not in the form of the contract is refused as malformed', async () => {
    const s = await scenario(TENANT);
    const good = await s.world.clientCert(supplierAgent(s));
    refused(await x509(s, `:${Buffer.from('not a certificate').toString('base64')}:`), 401, 'svid_invalid');
    expect(lastRule(s)).toBe('x509.malformed');
    const bare = good.slice(1, -1);
    // A space at the end or the start of a header value is not part of it: the HTTP layer takes it off, so it is no sample of a bad value.
    for (const bad of [bare, `:${bare}`, `${bare}:`, '::', ':not base64!:', `x${good}`, `${good}, ${good}`, `:${bare}:extra`]) {
      refused(await x509(s, bad), 400, 'client_certificate_malformed');
      expect(lastRule(s), bad.slice(0, 12)).toBe('client_certificate.malformed');
    }
    expect((await x509(s, good)).status).toBe(200);
  });
  it('a request with no certificate is refused on the client-certificate host, with no challenge', async () => {
    const s = await scenario(TENANT);
    const none = await s.harness.call({ path: CATALOGUE, host: MTLS_HOST });
    refused(none, 401, 'svid_missing');
    expect(none.headers['www-authenticate']).toBeUndefined();
    expect(lastRule(s)).toBe('client_certificate.missing');
    expect((await viaCert(s, supplierAgent(s))).status).toBe(200);
  });
  it('a chain header is never read: it does not help a call with no certificate, and it does not change a call with one', async () => {
    const s = await scenario(TENANT);
    const agent = supplierAgent(s);
    const header = await s.world.clientCert(agent);
    refused(await s.harness.call({ path: CATALOGUE, host: MTLS_HOST, headers: { 'client-cert-chain': header } }), 401, 'svid_missing');
    expect((await s.harness.call({ path: CATALOGUE, host: MTLS_HOST, headers: { 'client-cert': header, 'client-cert-chain': ':AAAA:' } })).status).toBe(200);
  });
});

describe('the header Client-Cert beside another', () => {
  it('two headers are refused, even when both are good: a forged header beside a real one is not read as either', async () => {
    const s = await scenario(TENANT);
    const real = await s.world.clientCert(supplierAgent(s, 'real'));
    const forged = await s.world.clientCert(supplierAgent(s, 'forged'));
    for (const pair of [[real, forged], [forged, real], [real, real]]) {
      refused(await x509(s, pair), 400, 'client_certificate_multiple');
      expect(lastRule(s)).toBe('client_certificate.multiple');
    }
    expect((await x509(s, real)).status).toBe(200);
  });
  it('a forged header with a certificate of another gateway beside a real one is refused as two headers, and the forged certificate alone is refused by the bundle', async () => {
    const s = await scenario(TENANT);
    const real = await s.world.clientCert(supplierAgent(s));
    const { clientCert } = await stranger(s);
    const forged = await clientCert();
    refused(await x509(s, [real, forged]), 400, 'client_certificate_multiple');
    refused(await x509(s, forged), 401, 'svid_invalid');
    expect((await x509(s, real)).status).toBe(200);
  });
});

describe('the host of a call', () => {
  it('the header Client-Cert on the host of tokens is refused on every route, whatever the certificate: the proxy removes it there, so it is a fault', async () => {
    const s = await scenario(TENANT);
    const header = await s.world.clientCert(supplierAgent(s));
    for (const [method, path] of [['GET', CATALOGUE], ['GET', `/t/${TENANT}/state`], ['GET', `/t/${TENANT}/log`], ['GET', `/t/${TENANT}/vendors`], ['POST', '/admin/tenants']] as const) {
      const reply = await s.harness.call({ method, path, host: PUBLIC_HOST, headers: { 'client-cert': header } });
      refused(reply, 400, 'client_certificate_unexpected');
      expect(lastRule(s), path).toBe('client_certificate.host');
    }
    const forged = await s.harness.call({ path: CATALOGUE, host: PUBLIC_HOST, headers: { 'client-cert': 'forged' } });
    refused(forged, 400, 'client_certificate_unexpected');
    expect((await viaCert(s, supplierAgent(s, 'second'))).status).toBe(200);
  });
  it('an X.509 route is served on the client-certificate host only: on the host of tokens it is 421, with no header', async () => {
    const s = await scenario(TENANT);
    const reply = await s.harness.call({ path: CATALOGUE, host: PUBLIC_HOST });
    refused(reply, 421, 'wrong_host');
    expect(lastRule(s)).toBe('host.mtls_only');
    expect((await viaCert(s, supplierAgent(s))).status).toBe(200);
  });
  it('every other route is served on the host of tokens only: on the client-certificate host it is 421', async () => {
    const s = await scenario(TENANT);
    for (const [path, rule] of [[`/t/${TENANT}/state`, 'host.token_only'], [`/t/${TENANT}/log`, 'host.token_only'], [`/t/${TENANT}/vendors`, 'host.token_only'], [REQUIREMENTS, 'host.token_only']] as const) {
      const reply = await s.harness.call({ path, host: MTLS_HOST });
      refused(reply, 421, 'wrong_host');
      expect(lastRule(s), path).toBe(rule);
    }
    expect((await s.harness.call({ path: `/t/${TENANT}/state` })).status).toBe(200);
    const admin = await s.harness.call({ method: 'POST', path: '/admin/tenants', host: MTLS_HOST, headers: { authorization: 'Bearer x' }, body: {} });
    refused(admin, 421, 'wrong_host');
  });
  it('a Host header that names neither host is 421, and the port 443 of a host is the host', async () => {
    const s = await scenario(TENANT);
    refused(await s.harness.call({ path: `/t/${TENANT}/state`, host: 'evil.example.test' }), 421, 'wrong_host');
    refused(await s.harness.call({ path: `/t/${TENANT}/state`, host: `${PUBLIC_HOST}.evil.test` }), 421, 'wrong_host');
    expect((await s.harness.call({ path: `/t/${TENANT}/state`, host: `${PUBLIC_HOST}:443` })).status).toBe(200);
    expect((await s.harness.call({ path: `/t/${TENANT}/state`, host: PUBLIC_HOST.toUpperCase() })).status).toBe(200);
  });
  it('a request with no Host header is refused by the server of Node, and one with two Host headers by the service with a typed 400, and neither reaches a route', async () => {
    const s = await scenario(TENANT);
    const line = `GET /t/${TENANT}/state HTTP/1.1\r\n`;
    expect((await s.harness.raw(`${line}Connection: close\r\n\r\n`)).status).toBe(400);
    const two = await s.harness.raw(`${line}Host: ${PUBLIC_HOST}\r\nHost: ${PUBLIC_HOST}\r\nConnection: close\r\n\r\n`);
    expect(two.status).toBe(400);
    expect(two.text).toContain('"error":"bad_request"');
    expect(s.harness.logged().filter((entry) => entry.path === `/t/${TENANT}/state`)).toMatchObject([{ tenant: null, route: null, decision: 'refused', status: 400, rule: 'host.header' }]);
    expect((await s.harness.raw(`${line}Host: ${PUBLIC_HOST}\r\nConnection: close\r\n\r\n`)).status).toBe(200);
  });
  it('the check of health answers on any host and writes no line', async () => {
    const s = await scenario(TENANT);
    const before = s.harness.lines.length;
    for (const host of [PUBLIC_HOST, MTLS_HOST, 'evil.example.test']) expect((await s.harness.call({ path: '/healthz', host })).json).toEqual({ ok: true });
    expect(s.harness.lines.length).toBe(before);
  });
});

describe('the agent of an SVID', () => {
  it('an agent whose record names another organisation is refused, and the agent of the organisation of the tenant is accepted', async () => {
    const s = await scenario(TENANT);
    const other = s.world.agent('other', { organisation: { domain: 'other.example.test', verified: true } });
    refused(await viaCert(s, other), 403, 'organisation_mismatch');
    expect(lastRule(s)).toBe('agent.organisation');
    expect((await viaCert(s, supplierAgent(s))).status).toBe(200);
  });
  it('an agent whose organisation is not verified is refused', async () => {
    const s = await scenario(TENANT);
    const unverified = s.world.agent('unverified', { organisation: { domain: SUPPLIER_ORG, verified: false } });
    refused(await viaCert(s, unverified), 403, 'organisation_unverified');
    expect(lastRule(s)).toBe('agent.organisation_verified');
  });
  it('an agent whose record names no organisation is refused', async () => {
    const s = await scenario(TENANT);
    refused(await viaCert(s, s.world.agent('plain')), 403, 'organisation_mismatch');
  });
  it('the agent of the organisation of the insurer cannot act for the supplier, and the agent of the supplier cannot act for the insurer', async () => {
    const s = await scenario(TENANT);
    refused(await viaCert(s, insurerAgent(s, 'intake-1')), 403, 'organisation_mismatch');
    refused(await viaJwt(s, supplierAgent(s, 'desk-1')), 403, 'organisation_mismatch');
    expect((await viaCert(s, supplierAgent(s, 'desk-2'))).status).toBe(200);
    expect((await viaJwt(s, insurerAgent(s, 'intake-2'))).status).toBe(200);
  });
  it('the organisation is compared as a domain, in any case, and only whole: a longer or shorter name is another organisation', async () => {
    const s = await scenario(TENANT);
    expect((await viaCert(s, s.world.agent('upper', { organisation: { domain: SUPPLIER_ORG.toUpperCase(), verified: true } }))).status).toBe(200);
    for (const [label, domain] of [['longer', `x.${SUPPLIER_ORG}`], ['suffix', `${SUPPLIER_ORG}.evil.test`], ['shorter', SUPPLIER_ORG.slice(1)]] as const) {
      refused(await viaCert(s, s.world.agent(label, { organisation: { domain, verified: true } })), 403, 'organisation_mismatch');
    }
  });
  it('a Party whose period has ended names no organisation, and the same record with a period that goes on is accepted', async () => {
    const s = await scenario(TENANT);
    const agent = supplierAgent(s);
    const header = await s.world.clientCert(agent);
    await changeParty(s, agent, { notAfter: '2026-11-19T11:00:00Z' });
    refused(await x509(s, header), 403, 'organisation_mismatch');
    expect(lastRule(s)).toBe('agent.organisation');
    await changeParty(s, agent, { notAfter: '2026-11-20T12:00:00Z' });
    expect((await x509(s, header)).status).toBe(200);
  });
  it('a Party that is not in force yet names no organisation, and the same record with a period that has begun is accepted', async () => {
    const s = await scenario(TENANT);
    const agent = insurerAgent(s);
    const token = await s.world.jwtSvid(agent, AUDIENCE);
    await changeParty(s, agent, { notBefore: '2026-11-19T13:00:00Z' });
    refused(await s.harness.call({ path: REQUIREMENTS, headers: { authorization: `Bearer ${token}` } }), 403, 'organisation_mismatch');
    expect(lastRule(s)).toBe('agent.organisation');
    await changeParty(s, agent, { notBefore: '2026-11-19T11:00:00Z' });
    expect((await s.harness.call({ path: REQUIREMENTS, headers: { authorization: `Bearer ${token}` } })).status).toBe(200);
  });
  it('an agent that is suspended after its certificate was made is refused, and accepted again when the hold ends', async () => {
    const s = await scenario(TENANT);
    const agent = supplierAgent(s);
    const header = await s.world.clientCert(agent);
    expect((await x509(s, header)).status).toBe(200);
    s.world.gateway.setStatus(agent, 'suspended', 'hold');
    refused(await x509(s, header), 403, 'agent_not_active');
    expect(lastRule(s)).toBe('agent.status');
    s.world.gateway.setStatus(agent, 'active');
    expect((await x509(s, header)).status).toBe(200);
  });
  it('an agent whose record ended is refused: revoked, retired, and a DID that does not resolve', async () => {
    const s = await scenario(TENANT);
    for (const status of ['revoked', 'retired'] as const) {
      const agent = supplierAgent(s, status);
      const header = await s.world.clientCert(agent);
      expect((await x509(s, header)).status).toBe(200);
      s.world.gateway.setStatus(agent, status);
      refused(await x509(s, header), 403, 'agent_not_active');
      expect(lastRule(s)).toBe('agent.deactivated');
    }
    const gone = supplierAgent(s, 'gone');
    const header = await s.world.clientCert(gone);
    s.world.gateway.fault(`/1.0/identifiers/${gone.did}`, { status: 404, body: NOT_FOUND_BODY, headers: { 'content-type': 'application/did-resolution' } });
    refused(await x509(s, header), 403, 'agent_not_active');
    expect(lastRule(s)).toBe('agent.not_found');
  });
  it('a tenant has its own organisations: the agent of the supplier of one tenant is refused at another tenant with another supplier', async () => {
    const s = await scenario(TENANT);
    expect((await s.harness.seed('run2', { organisations: { supplier: 'other.example.test', insurer: INSURER_ORG } })).status).toBe(201);
    const agent = supplierAgent(s);
    expect((await viaCert(s, agent)).status).toBe(200);
    refused(await viaCert(s, agent, '/t/run2/supplier/catalogue/GLV-NIT-M'), 403, 'organisation_mismatch');
    const there = s.world.agent('there', { organisation: { domain: 'other.example.test', verified: true } });
    expect((await viaCert(s, there, '/t/run2/supplier/catalogue/GLV-NIT-M')).status).toBe(200);
    refused(await viaCert(s, there), 403, 'organisation_mismatch');
  });
});

describe('a gateway that cannot be read', () => {
  it('a DID that cannot be resolved refuses the call with 503, and the call is not honoured', async () => {
    const s = await scenario(TENANT);
    const agent = supplierAgent(s);
    const header = await s.world.clientCert(agent);
    s.world.gateway.fault(`/1.0/identifiers/${agent.did}`, 'network');
    refused(await x509(s, header), 503, 'gateway_unavailable');
    expect(lastRule(s)).toBe('agent.resolve');
    s.world.gateway.fault(`/1.0/identifiers/${agent.did}`, null);
    expect((await x509(s, header)).status).toBe(200);
  });
  it('a bundle that cannot be read refuses the call with 503, for both kinds of SVID', async () => {
    const s = await scenario(TENANT);
    const agent = supplierAgent(s);
    const intake = insurerAgent(s);
    const header = await s.world.clientCert(agent);
    const token = await s.world.jwtSvid(intake, AUDIENCE);
    s.world.gateway.fault('/spiffe/bundle', { status: 503 });
    refused(await x509(s, header), 503, 'gateway_unavailable');
    expect(lastRule(s)).toBe('bundle.unavailable');
    refused(await s.harness.call({ path: REQUIREMENTS, headers: { authorization: `Bearer ${token}` } }), 503, 'gateway_unavailable');
    s.world.gateway.fault('/spiffe/bundle', null);
    s.world.advance(10_000);
    expect((await x509(s, header)).status).toBe(200);
    expect((await s.harness.call({ path: REQUIREMENTS, headers: { authorization: `Bearer ${token}` } })).status).toBe(200);
  });
  it('the bundle is read again after 300 seconds and not before', async () => {
    const s = await scenario(TENANT);
    const header = await s.world.clientCert(supplierAgent(s));
    const reads = (): number => s.world.gateway.requests.filter((r) => r.path === '/spiffe/bundle').length;
    expect((await x509(s, header)).status).toBe(200);
    expect(reads()).toBe(1);
    s.world.advance(290_000);
    expect((await x509(s, header)).status).toBe(200);
    expect(reads()).toBe(1);
    s.world.advance(20_000);
    expect((await x509(s, header)).status).toBe(200);
    expect(reads()).toBe(2);
  });
});

describe('a JWT-SVID', () => {
  it('is honoured for the audience of the insurer of the tenant, and the call is in the log with the SPIFFE ID that was verified', async () => {
    const s = await scenario(TENANT);
    const agent = insurerAgent(s);
    const reply = await viaJwt(s, agent);
    expect(reply.status, reply.text).toBe(200);
    expect(s.harness.logged().at(-1)).toMatchObject({
      tenant: TENANT, route: 'GET /insurer/requirements/{service_code}', host: 'token', credential: 'jwt-svid', sub: `spiffe://id.vector.apexfusion.org/agent/${agent.id}`, act: [], delegation: null, decision: 'allowed',
    });
  });
  it('is refused for another audience: another system, another tenant, the base of the tenant and the host', async () => {
    const s = await scenario(TENANT);
    expect((await s.harness.seed('run2')).status).toBe(201);
    const agent = insurerAgent(s);
    for (const audience of [`${PUBLIC_BASE}/t/${TENANT}/po`, `${PUBLIC_BASE}/t/run2/insurer`, `${PUBLIC_BASE}/t/${TENANT}`, PUBLIC_BASE, `${AUDIENCE}/`, 'https://elsewhere.example.test/t/run1/insurer']) {
      refused(await viaJwt(s, agent, audience), 401, 'svid_invalid');
      expect(lastRule(s), audience).toBe('jwt_svid.audience');
    }
    expect((await viaJwt(s, agent)).status).toBe(200);
  });
  it('is refused when it has expired, and was honoured before its end', async () => {
    const s = await scenario(TENANT);
    const token = await s.world.jwtSvid(insurerAgent(s), AUDIENCE);
    const call = () => s.harness.call({ path: REQUIREMENTS, headers: { authorization: `Bearer ${token}` } });
    s.world.advance(200_000);
    expect((await call()).status).toBe(200);
    s.world.advance(200_000);
    refused(await call(), 401, 'svid_invalid');
    expect(lastRule(s)).toBe('jwt_svid.expired');
  });
  it('is refused for its trust domain when the bundle holds the key of that domain too, and a JWT-SVID of this domain is accepted with the same bundle', async () => {
    const s = await scenario(TENANT);
    const { other, agent, client } = await stranger(s);
    await federate(s, other);
    // The same agent exists at this gateway, so the JWT-SVID would be honoured if its trust domain were not checked.
    const own = insurerAgent(s, 'order-desk');
    const issued = await client.jwtSvid({ agent: { did: agent.did, key: agent.authentication.privateKey }, audience: AUDIENCE });
    if (!issued.ok) throw new Error(issued.detail);
    refused(await s.harness.call({ path: REQUIREMENTS, headers: { authorization: `Bearer ${issued.value.svid}` } }), 401, 'svid_invalid');
    expect(lastRule(s)).toBe('jwt_svid.trust_domain');
    expect((await viaJwt(s, own)).status).toBe(200);
  });
  it('is refused when it is issued in the future, and is accepted when its start is inside the leeway of 30 seconds', async () => {
    const s = await scenario(TENANT);
    const agent = insurerAgent(s);
    s.world.advance(600_000);
    const token = await s.world.jwtSvid(agent, AUDIENCE);
    const call = () => s.harness.call({ path: REQUIREMENTS, headers: { authorization: `Bearer ${token}` } });
    s.world.advance(-560_000);
    refused(await call(), 401, 'svid_invalid');
    expect(lastRule(s)).toBe('jwt_svid.not_yet_valid');
    s.world.advance(540_000);
    expect((await call()).status).toBe(200);
  });
  it('is refused when another gateway signed it, and when the agent is of another organisation or not Active', async () => {
    const s = await scenario(TENANT);
    const { agent, client } = await stranger(s);
    const issued = await client.jwtSvid({ agent: { did: agent.did, key: agent.authentication.privateKey }, audience: AUDIENCE });
    if (!issued.ok) throw new Error(issued.detail);
    refused(await s.harness.call({ path: REQUIREMENTS, headers: { authorization: `Bearer ${issued.value.svid}` } }), 401, 'svid_invalid');
    expect(['jwt_svid.kid', 'jwt_svid.signature']).toContain(lastRule(s));
    const other = s.world.agent('other', { organisation: { domain: 'other.example.test', verified: true } });
    refused(await viaJwt(s, other), 403, 'organisation_mismatch');
    const unverified = s.world.agent('unverified', { organisation: { domain: INSURER_ORG, verified: false } });
    refused(await viaJwt(s, unverified), 403, 'organisation_unverified');
    const held = insurerAgent(s, 'held');
    const token = await s.world.jwtSvid(held, AUDIENCE);
    s.world.gateway.setStatus(held, 'suspended', 'hold');
    refused(await s.harness.call({ path: REQUIREMENTS, headers: { authorization: `Bearer ${token}` } }), 403, 'agent_not_active');
    expect((await viaJwt(s, insurerAgent(s, 'fine'))).status).toBe(200);
  });
  it('is refused when the header is missing, another scheme, no token, or two headers', async () => {
    const s = await scenario(TENANT);
    const agent = insurerAgent(s);
    const token = await s.world.jwtSvid(agent, AUDIENCE);
    const none = await s.harness.call({ path: REQUIREMENTS });
    refused(none, 401, 'svid_missing');
    expect(none.headers['www-authenticate']).toBe('Bearer');
    expect(lastRule(s)).toBe('jwt_svid.missing');
    refused(await s.harness.call({ path: REQUIREMENTS, headers: { authorization: `DPoP ${token}` } }), 401, 'svid_invalid');
    expect(lastRule(s)).toBe('jwt_svid.scheme');
    for (const bad of ['Bearer', 'Bearer not-a-jwt', `Bearer ${token} extra`, `Basic ${token}`, token]) {
      refused(await s.harness.call({ path: REQUIREMENTS, headers: { authorization: bad } }), 401, 'svid_invalid');
      expect(lastRule(s), bad).toBe('jwt_svid.scheme');
    }
    refused(await s.harness.call({ path: REQUIREMENTS, headers: { authorization: [`Bearer ${token}`, `Bearer ${token}`] } }), 400, 'bad_request');
    expect(lastRule(s)).toBe('authorization.multiple');
    expect((await s.harness.call({ path: REQUIREMENTS, headers: { authorization: `bearer ${token}` } })).status).toBe(200);
  });
  it('is not taken for an access token, and an access token is not taken for a JWT-SVID', async () => {
    const s = await scenario(TENANT);
    const agent = insurerAgent(s);
    const svid = await s.world.jwtSvid(agent, `${PUBLIC_BASE}/t/${TENANT}/po`);
    refused(await s.harness.call({ method: 'POST', path: `/t/${TENANT}/po`, headers: { authorization: `DPoP ${svid}` }, body: {} }), 401, 'token_invalid');
    expect(lastRule(s)).toBe('token.typ');
    const holder = s.world.agent('holder');
    const delegation = s.world.delegate({ delegate: holder, actions: ['vendor.read'], resources: [`${PUBLIC_BASE}/t/${TENANT}/insurer`] });
    const accessToken = (await s.world.token(holder, delegation, `${PUBLIC_BASE}/t/${TENANT}/insurer`)).accessToken;
    refused(await s.harness.call({ path: REQUIREMENTS, headers: { authorization: `Bearer ${accessToken}` } }), 401, 'svid_invalid');
    expect(lastRule(s)).toBe('jwt_svid.typ');
  });
  it('is refused on the client-certificate host, and with a Client-Cert header on the host of tokens', async () => {
    const s = await scenario(TENANT);
    const agent = insurerAgent(s);
    const token = await s.world.jwtSvid(agent, AUDIENCE);
    refused(await s.harness.call({ path: REQUIREMENTS, host: MTLS_HOST, headers: { authorization: `Bearer ${token}` } }), 421, 'wrong_host');
    refused(await s.harness.call({ path: REQUIREMENTS, headers: { authorization: `Bearer ${token}`, 'client-cert': ':AAAA:' } }), 400, 'client_certificate_unexpected');
    expect((await s.harness.call({ path: REQUIREMENTS, headers: { authorization: `Bearer ${token}` } })).status).toBe(200);
  });
  it('does not open an X.509 route: the certificate is the only credential there', async () => {
    const s = await scenario(TENANT);
    const token = await s.world.jwtSvid(supplierAgent(s), `${PUBLIC_BASE}/t/${TENANT}/supplier`);
    refused(await s.harness.call({ path: CATALOGUE, host: MTLS_HOST, headers: { authorization: `Bearer ${token}` } }), 401, 'svid_missing');
  });
  it('a gateway that cannot resolve the DID refuses the call with 503', async () => {
    const s = await scenario(TENANT);
    const agent = insurerAgent(s);
    const token = await s.world.jwtSvid(agent, AUDIENCE);
    s.world.gateway.fault(`/1.0/identifiers/${agent.did}`, { status: 503 });
    refused(await s.harness.call({ path: REQUIREMENTS, headers: { authorization: `Bearer ${token}` } }), 503, 'gateway_unavailable');
    s.world.gateway.fault(`/1.0/identifiers/${agent.did}`, null);
    expect((await s.harness.call({ path: REQUIREMENTS, headers: { authorization: `Bearer ${token}` } })).status).toBe(200);
  });
});
