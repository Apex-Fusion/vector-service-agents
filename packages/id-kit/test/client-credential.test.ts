// packages/id-kit/test/client-credential.test.ts: the credential fetch and DID resolution of the client against the stub gateway.
import { describe, it, expect } from 'vitest';
import { LIST_SIZE } from '../src/common/constants.ts';
import { identifier, LISTS_UNAVAILABLE } from '../src/testing/index.ts';
import { decodeJwt, requestTo, signedBy, world } from './support.ts';

describe('credential', () => {
  it('fetches the credential of an agent as a JWS that the gateway signed: the subject, the issuer, the validity and the two status entries', async () => {
    const { gateway, client } = world();
    const agent = gateway.createAgent({ label: 'vc' });
    const result = await client.credential(agent.did);
    if (!result.ok) throw new Error(`the request failed: ${result.rule} ${result.detail}`);
    const { header, payload } = decodeJwt(result.value);
    expect(header).toStrictEqual({ alg: 'ES256', kid: `${gateway.gatewayDid}#${gateway.keys.p256.keyHash}`, typ: 'vc+jwt', cty: 'vc' });
    expect(signedBy(result.value, 'P256', gateway.keys.p256.publicKey)).toBe(true);
    expect(payload).toMatchObject({
      '@context': ['https://www.w3.org/ns/credentials/v2'],
      type: ['VerifiableCredential', 'VectorAgentIdentityCredential'],
      issuer: gateway.gatewayDid,
      validFrom: '2026-11-19T12:00:00Z',
      validUntil: '2026-11-20T12:00:00Z',
      credentialSubject: { id: agent.did, created: '2026-11-19T12:00:00Z', origin: 'registered' },
    });
    const list = `${gateway.baseUrl}/status/bsl/0`;
    expect(payload.credentialStatus).toStrictEqual([
      { id: `${list}#${agent.index}`, type: 'BitstringStatusListEntry', statusPurpose: 'revocation', statusListIndex: String(agent.index), statusListCredential: list },
      { id: `${list}#${LIST_SIZE + agent.index}`, type: 'BitstringStatusListEntry', statusPurpose: 'suspension', statusListIndex: String(LIST_SIZE + agent.index), statusListCredential: list },
    ]);
    expect(requestTo(gateway, `/agents/${agent.id}/credential`).method).toBe('GET');
  });

  it('takes a DID or the bare identifier, and the entries of an agent in list 1 name list 1 and the position in it', async () => {
    const { gateway, client } = world();
    const agent = gateway.createAgent({ label: 'vc late', statusIndex: LIST_SIZE + 7 });
    const byId = await client.credential(agent.id);
    const byDid = await client.credential(agent.did);
    if (!byId.ok || !byDid.ok) throw new Error('the request failed');
    const status = decodeJwt(byId.value).payload.credentialStatus as Array<{ statusListIndex: string; statusListCredential: string }>;
    expect(status.map((e) => e.statusListIndex)).toStrictEqual(['7', String(LIST_SIZE + 7)]);
    expect(status.every((e) => e.statusListCredential === `${gateway.baseUrl}/status/bsl/1`)).toBe(true);
    expect(decodeJwt(byDid.value).payload.credentialSubject).toMatchObject({ id: agent.did });
  });

  it('a subagent has its parent in the credential', async () => {
    const { gateway, client } = world();
    const parent = gateway.createAgent({ label: 'vc parent' });
    const child = gateway.createAgent({ label: 'vc child', parent });
    const result = await client.credential(child.did);
    if (!result.ok) throw new Error(result.detail);
    expect(decodeJwt(result.value).payload.credentialSubject).toMatchObject({ id: child.did, parent: parent.did });
  });

  it.each<[string, string]>([
    ['text that is not an identifier', 'agent'],
    ['a DID with upper case hex', `did:vector:${'A'.repeat(64)}`],
    ['an identifier of 63 characters', 'a'.repeat(63)],
  ])('refuses %s, and sends nothing', async (_name, agent) => {
    const { gateway, client } = world();
    await expect(client.credential(agent)).rejects.toThrow(/DID of the form did:vector/);
    expect(gateway.requests).toHaveLength(0);
  });

  it('the gateway issues the credential only while the agent is Active: 404 for an unknown agent, 409 for a suspended one, 410 for a revoked or retired one', async () => {
    const { gateway, client } = world();
    expect(await client.credential(identifier('vc nobody'))).toMatchObject({ ok: false, rule: 'gateway.refused', status: 404, error: 'not_found' });
    const suspended = gateway.createAgent({ label: 'vc suspended', status: 'suspended' });
    expect(await client.credential(suspended.did)).toMatchObject({ ok: false, rule: 'gateway.refused', status: 409, error: 'agent_not_active' });
    for (const status of ['revoked', 'retired'] as const) {
      const ended = gateway.createAgent({ label: `vc ${status}`, status });
      expect(await client.credential(ended.did)).toMatchObject({ ok: false, rule: 'gateway.refused', status: 410, error: 'deactivated' });
    }
    const parent = gateway.createAgent({ label: 'vc ended parent', status: 'revoked' });
    const child = gateway.createAgent({ label: 'vc ended child', parent });
    expect(await client.credential(child.did)).toMatchObject({ ok: false, status: 410, error: 'deactivated' });
    const ok = gateway.createAgent({ label: 'vc fine' });
    expect((await client.credential(ok.did)).ok).toBe(true);
  });

  it('a failure of the gateway or of the network, and an answer in a wrong form', async () => {
    const { gateway, client } = world();
    const agent = gateway.createAgent({ label: 'vc faults' });
    const path = `/agents/${agent.id}/credential`;
    gateway.fault(path, LISTS_UNAVAILABLE);
    expect(await client.credential(agent.did)).toMatchObject({ ok: false, rule: 'gateway.unavailable', status: 503, retryAfterSeconds: 5 });
    gateway.fault(path, 'network');
    expect(await client.credential(agent.did)).toMatchObject({ ok: false, rule: 'gateway.unreachable' });
    gateway.fault(path, { status: 200, body: 'a.b.c', headers: { 'content-type': 'text/plain' } });
    expect(await client.credential(agent.did)).toMatchObject({ ok: false, rule: 'gateway.bad_response' });
    gateway.fault(path, { status: 200, body: 'not a jws', headers: { 'content-type': 'application/vc+jwt' } });
    expect(await client.credential(agent.did)).toMatchObject({ ok: false, rule: 'gateway.bad_response' });
    gateway.fault(path, { status: 200, body: 'a.b.c\n', headers: { 'content-type': 'application/vc+jwt' } });
    expect(await client.credential(agent.did)).toMatchObject({ ok: true, value: 'a.b.c' });
  });
});

describe('resolve', () => {
  it('resolves an Active agent: the effective status, its keys with their purposes, the document and the metadata', async () => {
    const { gateway, client } = world();
    const agent = gateway.createAgent({ label: 'resolve', capabilities: ['erp.read'], endpoint: 'https://agent.example' });
    const result = await client.resolve(agent.did);
    if (!result.ok || result.value.kind !== 'resolved') throw new Error('the DID did not resolve');
    expect(result.value).toMatchObject({ did: agent.did, effectiveStatus: 'active', effectiveReason: null });
    expect(result.value.keys).toStrictEqual([
      { keyHash: agent.authentication.keyHash, type: 'Ed25519', purposes: ['authentication'] },
      { keyHash: agent.delegation.keyHash, type: 'Ed25519', purposes: ['delegation'] },
    ]);
    expect(result.value.document).toMatchObject({ id: agent.did, authentication: [`#${agent.authentication.keyHash}`], capabilityDelegation: [`#${agent.delegation.keyHash}`] });
    expect(result.value.metadata).toMatchObject({ vectorStatus: { status: 'active', effective: 'active' }, vectorProfile: { name: 'resolve', capabilities: ['erp.read'], endpoint: 'https://agent.example' } });
    expect(requestTo(gateway, `/1.0/identifiers/${agent.did}`).headers.accept).toBe('application/did-resolution');
  });

  it('a Suspended agent resolves, and the effective status says so; a hold on a parent shows in a subagent with its reason', async () => {
    const { gateway, client } = world();
    const parent = gateway.createAgent({ label: 'resolve parent' });
    const child = gateway.createAgent({ label: 'resolve child', parent });
    gateway.setStatus(parent, 'suspended', 'hold');
    expect(await client.resolve(parent.did)).toMatchObject({ ok: true, value: { kind: 'resolved', effectiveStatus: 'suspended', effectiveReason: null, metadata: { vectorStatus: { status: 'suspended', reason: 'hold' } } } });
    expect(await client.resolve(child.did)).toMatchObject({ ok: true, value: { kind: 'resolved', effectiveStatus: 'suspended', effectiveReason: 'parentSuspended', metadata: { vectorStatus: { status: 'active' } } } });
  });

  it('a revoked or retired agent is deactivated (410, no document), and so is a subagent of a revoked parent, with the reason parentRevoked', async () => {
    const { gateway, client } = world();
    const revoked = gateway.createAgent({ label: 'resolve revoked', status: 'revoked' });
    const retired = gateway.createAgent({ label: 'resolve retired', status: 'retired' });
    const child = gateway.createAgent({ label: 'resolve revoked child', parent: revoked });
    expect(await client.resolve(revoked.did)).toMatchObject({ ok: true, value: { kind: 'deactivated', effectiveStatus: 'revoked', effectiveReason: null, metadata: { deactivated: true } } });
    expect(await client.resolve(retired.did)).toMatchObject({ ok: true, value: { kind: 'deactivated', effectiveStatus: 'retired' } });
    expect(await client.resolve(child.did)).toMatchObject({ ok: true, value: { kind: 'deactivated', effectiveStatus: 'revoked', effectiveReason: 'parentRevoked' } });
  });

  it('an unknown DID is not_found; the answer is data, and not a failure of the call', async () => {
    const { client } = world();
    expect(await client.resolve(`did:vector:${identifier('resolve nobody')}`)).toMatchObject({ ok: true, value: { kind: 'not_found' } });
  });

  it('refuses text that is not a DID before it sends; failures and wrong answers are typed', async () => {
    const { gateway, client } = world();
    await expect(client.resolve('did:vector:abc')).rejects.toThrow(/did:vector:<64 hex characters>/);
    expect(gateway.requests).toHaveLength(0);
    const agent = gateway.createAgent({ label: 'resolve faults' });
    const path = `/1.0/identifiers/${agent.did}`;
    gateway.fault(path, LISTS_UNAVAILABLE);
    expect(await client.resolve(agent.did)).toMatchObject({ ok: false, rule: 'gateway.unavailable' });
    gateway.fault(path, { status: 200, body: '{"didDocument":{},"didDocumentMetadata":{"vectorStatus":{"effective":"fine"}}}' });
    expect(await client.resolve(agent.did)).toMatchObject({ ok: false, rule: 'gateway.bad_response' });
    gateway.fault(path, { status: 200, body: '{"didDocument":null,"didDocumentMetadata":{"vectorStatus":{"effective":"active"}}}' });
    expect(await client.resolve(agent.did)).toMatchObject({ ok: false, rule: 'gateway.bad_response' });
    gateway.fault(path, { status: 200, body: 'not json' });
    expect(await client.resolve(agent.did)).toMatchObject({ ok: false, rule: 'gateway.bad_response' });
    gateway.fault(path, { status: 400, body: '{"didDocument":null,"didResolutionMetadata":{},"didDocumentMetadata":{}}' });
    expect(await client.resolve(agent.did)).toMatchObject({ ok: false, rule: 'gateway.refused', status: 400 });
    gateway.fault(path, null);
    expect(await client.resolve(agent.did)).toMatchObject({ ok: true, value: { kind: 'resolved' } });
  });
});
