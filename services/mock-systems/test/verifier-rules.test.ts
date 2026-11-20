// Three rules of the verifier of @vsa/id-kit, tested through the service. Each test sends calls over HTTP that must be refused, reads the answer, the log and the state, and has the call that is
// accepted beside them: the same agent and the same route, with the fault taken away. The credentials, the bundle and the records are the stub gateway's, and one clock moves the gateway, the
// verifier and the service.
//   - The header Client-Cert holds exactly one certificate, and the service verifies the whole value.
//   - No part of the header Authorization comes back in an answer or in a log.
//   - An agent of the act chain passes only with a live record whose effective status is Active.
import { X509Certificate } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { StubAgent } from '@vsa/id-kit/testing';
import { carrierCertificate, pemOf } from './support/carrier.ts';
import type { Reply } from './support/net.ts';
import { delegateTo, insurerAgent, purchaseOrder, scenario, supplierAgent, supplierOrder, tokenFor } from './support/scenario.ts';
import type { Scenario } from './support/scenario.ts';
import { MTLS_HOST, OPERATOR_TOKEN, PUBLIC_BASE } from './support/world.ts';

const TENANT = 'run1';
const CATALOGUE = `/t/${TENANT}/supplier/catalogue/GLV-NIT-M`;
const ORDERS = `/t/${TENANT}/supplier/orders`;
const REQUIREMENTS = `/t/${TENANT}/insurer/requirements/SYN-MRI-LS`;
const AUDIENCE = `${PUBLIC_BASE}/t/${TENANT}/insurer`;

const refused = (reply: { status: number; json: Record<string, unknown> | null }, status: number, code: string) => {
  expect([reply.status, reply.json?.error]).toEqual([status, code]);
};
const lastRule = (s: Scenario): unknown => s.harness.logged().at(-1)?.rule;

// ── the header Client-Cert ──

/** The header Client-Cert that a proxy sets for these bytes, and the bytes in a header that the test world made. */
const headerOf = (der: Buffer): string => `:${der.toString('base64')}:`;
const derOf = (header: string): Buffer => Buffer.from(header.replace(/^:|:$/g, ''), 'base64');

/** The two X.509 routes, the read and the write of the supplier portal, on the client-certificate host with the header that the test gives. */
const read = (s: Scenario, header: string) => s.harness.call({ path: CATALOGUE, host: MTLS_HOST, headers: { 'client-cert': header } });
const write = (s: Scenario, header: string, number: string) => s.harness.call({ method: 'POST', path: ORDERS, host: MTLS_HOST, headers: { 'client-cert': header }, body: supplierOrder(number) });

async function orders(s: Scenario): Promise<Array<{ po_number: string; by: unknown }>> {
  const state = (await s.harness.call({ path: `/t/${TENANT}/state` })).json as { supplier: { orders: Array<{ po_number: string; by: unknown }> } }; // the shape of the answer of GET /state
  return state.supplier.orders;
}

/** The call is refused as a certificate that cannot be read: 401 `svid_invalid`, and the log line has the rule `x509.malformed` and no identity. The body is the refusal, with nothing of the catalogue. */
function expectUnreadable(s: Scenario, reply: Reply, what: string): void {
  expect([reply.status, reply.json?.error], `${what}: ${reply.text}`).toEqual([401, 'svid_invalid']);
  expect(Object.keys(reply.json!), what).toEqual(['error', 'message']);
  expect(s.harness.logged().at(-1), what).toMatchObject({ credential: 'x509-svid', decision: 'refused', status: 401, code: 'svid_invalid', rule: 'x509.malformed', sub: null });
}

/** The read and the write with this value are refused, and the supplier portal wrote no order. */
async function expectRefused(s: Scenario, header: string, what: string): Promise<void> {
  expectUnreadable(s, await read(s, header), `${what}, a read`);
  expectUnreadable(s, await write(s, header, 'run1-1'), `${what}, a write`);
  expect(await orders(s), `${what}: the orders of the portal`).toEqual([]);
}

/** The read and the write with the certificate alone are honoured, and the order that the write made has the agent of the certificate. */
async function expectHonoured(s: Scenario, agent: StubAgent, der: Buffer): Promise<void> {
  const catalogue = await read(s, headerOf(der));
  expect(catalogue.status, catalogue.text).toBe(200);
  expect(catalogue.json).toMatchObject({ sku: 'GLV-NIT-M' });
  const placed = await write(s, headerOf(der), 'run1-1');
  expect(placed.status, placed.text).toBe(201);
  expect(await orders(s)).toMatchObject([{ po_number: 'run1-1', by: { kind: 'x509-svid', spiffe_id: `spiffe://${s.world.gateway.trustDomain}/agent/${agent.id}`, did: agent.did } }]);
}

describe('the header Client-Cert holds exactly one certificate', () => {
  it('a certificate and one more byte is refused on a read and on a write, and the certificate alone is honoured', async () => {
    const s = await scenario(TENANT);
    const agent = supplierAgent(s);
    const der = derOf(await s.world.clientCert(agent));
    await expectRefused(s, headerOf(Buffer.concat([der, Buffer.from([0])])), 'a certificate and one more byte');
    await expectHonoured(s, agent, der);
  });

  it('a certificate two times is refused on a read and on a write, and the certificate alone is honoured', async () => {
    const s = await scenario(TENANT);
    const agent = supplierAgent(s);
    const der = derOf(await s.world.clientCert(agent));
    await expectRefused(s, headerOf(Buffer.concat([der, der])), 'a certificate two times');
    await expectHonoured(s, agent, der);
  });

  it('a caller is not verified as the agent of a certificate that sits inside the certificate that it presented: a certificate of another key that carries the SVID of an agent is refused', async () => {
    const s = await scenario(TENANT);
    const agent = supplierAgent(s);
    const der = derOf(await s.world.clientCert(agent));
    const carrier = carrierCertificate(pemOf(der), s.world.now());
    // The reader of Node returns the certificate inside the carrier, and not the carrier that came.
    expect(new X509Certificate(carrier).raw.equals(der)).toBe(true);
    expect(carrier.equals(der)).toBe(false);
    // The carrier has a key of its own that no authority of the bundle issued. With no certificate inside, the service reads it, and the bundle does not know it: it is refused as untrusted.
    const empty = await read(s, headerOf(carrierCertificate('this text holds no certificate', s.world.now())));
    refused(empty, 401, 'svid_invalid');
    expect(s.harness.logged().at(-1)).toMatchObject({ rule: 'x509.untrusted', sub: null });
    await expectRefused(s, headerOf(carrier), 'a certificate of another key that carries an SVID');
    await expectHonoured(s, agent, der);
  });
});

// ── the header Authorization ──

/** A credential, and the pieces of it that must not come back: the whole of it, and each of its dot-separated parts that is longer than 8 characters. */
const piecesOf = (credential: string): string[] => [...new Set([credential, ...credential.split('.').filter((part) => part.length > 8)])];

/** The pieces of these credentials that the text holds. */
const held = (text: string, credentials: string[]): string[] => credentials.flatMap(piecesOf).filter((piece) => text.includes(piece));

describe('a credential in the place of the scheme of the header Authorization', () => {
  /** What a caller puts where the scheme belongs: the header value, the credentials that it holds, and the call that honours the same credential in its own place. */
  interface Misplaced {
    authorization: string;
    credentials: string[];
    twin: () => Promise<Reply>;
  }
  const kinds: Array<[name: string, twinStatus: number, make: (s: Scenario) => Promise<Misplaced>]> = [
    ['the operator token', 201, async (s) => ({ authorization: `${OPERATOR_TOKEN} x`, credentials: [OPERATOR_TOKEN], twin: () => s.harness.seed('run2') })],
    ['an access token and its proof', 201, async (s) => {
      const token = await tokenFor(s, delegateTo(s, 'reorder', [['po.write', 'po']]), 'po');
      const proof = (await s.world.presented(token, 'POST', `${PUBLIC_BASE}/t/${TENANT}/po`)).dpop!;
      return {
        authorization: `${token.accessToken} ${proof}`, credentials: [token.accessToken, proof],
        twin: () => s.harness.tokenCall({ tenant: TENANT, credential: token, method: 'POST', route: '/po', body: purchaseOrder(TENANT, 'run1-1') }),
      };
    }],
    ['a JWT-SVID', 200, async (s) => {
      const svid = await s.world.jwtSvid(insurerAgent(s), AUDIENCE);
      return { authorization: `${svid} x`, credentials: [svid], twin: () => s.harness.call({ path: REQUIREMENTS, headers: { authorization: `Bearer ${svid}` } }) };
    }],
  ];

  it.each(kinds)('%s is refused with a 401 on a route that takes a token, no part of it comes back in the answer, on stdout or in the log of the tenant, and it is honoured in its own place', async (name, twinStatus, make) => {
    const s = await scenario(TENANT);
    const { authorization, credentials, twin } = await make(s);
    // The search has teeth: a text that repeats the credential, or a long part of it, is found.
    for (const piece of credentials.flatMap(piecesOf)) expect(held(`{"message":"the scheme is ${piece}"}`, credentials), name).toContain(piece);
    const reply = await s.harness.call({ method: 'POST', path: `/t/${TENANT}/po`, headers: { authorization }, body: purchaseOrder(TENANT, 'run1-1') });
    refused(reply, 401, 'token_invalid');
    expect(lastRule(s)).toBe('token.scheme');
    expect(held(reply.text, credentials), 'the answer').toEqual([]);
    const honoured = await twin();
    expect(honoured.status, honoured.text).toBe(twinStatus);
    for (const line of s.harness.lines) expect(held(line, credentials), `a line on stdout: ${line}`).toEqual([]);
    expect(held((await s.harness.call({ path: `/t/${TENANT}/log` })).text, credentials), 'the answer of the log of the tenant').toEqual([]);
  });
});

// ── the record of an agent that ended ──

describe('an agent of the act chain whose record ended is not Active', () => {
  /**
   * What the gateway answers for the DID of `agent`, from now on: the body of its live record, which says that the effective status is Active, with the HTTP status that the test picks. The status
   * 410 is the answer for a record that ended.
   */
  async function answering(s: Scenario, agent: StubAgent): Promise<(status: 200 | 410) => void> {
    const path = `/1.0/identifiers/${agent.did}`;
    const body = await (await s.world.gateway.fetch(`${s.world.gateway.baseUrl}${path}`)).text();
    const record = JSON.parse(body) as { didDocumentMetadata: { vectorStatus: { effective: string } } }; // the record of a live agent, as the gateway writes it
    expect(record.didDocumentMetadata.vectorStatus.effective).toBe('active');
    return (status) => s.world.gateway.fault(path, { status, body, headers: { 'content-type': 'application/did-resolution' } });
  }

  it('a route that takes one agent: the agent at depth 1 is refused when the gateway answers 410 for its record, though the body says Active, and it is honoured when the same answer has the status 200', async () => {
    const s = await scenario(TENANT);
    const agent = delegateTo(s, 'reorder', [['po.write', 'po']]);
    const credential = await tokenFor(s, agent, 'po');
    const answer = await answering(s, agent.agent);
    const post = (number: string) => s.harness.tokenCall({ tenant: TENANT, credential, method: 'POST', route: '/po', body: purchaseOrder(TENANT, number) });
    answer(410);
    const ended = await post('run1-1');
    refused(ended, 403, 'actor_not_active');
    expect(lastRule(s)).toBe('actors.refused');
    expect(ended.json?.message).toContain(agent.agent.did);
    expect(s.harness.logged().at(-1)).toMatchObject({ act: [agent.agent.did], decision: 'refused', status: 403 });
    expect((await s.harness.call({ path: `/t/${TENANT}/state` })).json).toMatchObject({ po_store: { orders: [] } });
    answer(200);
    const live = await post('run1-1');
    expect(live.status, live.text).toBe(201);
  });

  it.each<[depth: number, ended: 'sub' | 'parent']>([[1, 'sub'], [2, 'parent']])(
    'a route that takes a chain of two: the agent at depth %i is refused when the gateway answers 410 for its record, though the body says Active, and it is honoured when the same answer has the status 200',
    async (_depth, which) => {
      const s = await scenario(TENANT);
      const parent = delegateTo(s, 'reorder', [['erp.stock.read', 'erp']]);
      const sub = delegateTo(s, 'stock-reader', [['erp.stock.read', 'erp']], { parent: parent.agent, parentDelegation: parent.delegation });
      const credential = await tokenFor(s, sub, 'erp');
      const ended = which === 'sub' ? sub : parent;
      const answer = await answering(s, ended.agent);
      const stock = () => s.harness.tokenCall({ tenant: TENANT, credential, method: 'GET', route: '/erp/stock/GLV-NIT-M' });
      answer(410);
      const reply = await stock();
      refused(reply, 403, 'actor_not_active');
      expect(lastRule(s)).toBe('actors.refused');
      expect(Object.keys(reply.json!)).toEqual(['error', 'message']);
      expect(reply.json?.message).toContain(ended.agent.did);
      expect(s.harness.logged().at(-1)).toMatchObject({ act: [sub.agent.did, parent.agent.did], decision: 'refused', status: 403 });
      answer(200);
      const live = await stock();
      expect(live.status, live.text).toBe(200);
      expect(live.json).toMatchObject({ sku: 'GLV-NIT-M' });
    },
  );
});
