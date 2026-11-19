// packages/id-kit/src/testing/index.ts
// The test entry of @vsa/id-kit: the stub gateway and the keys that a test makes. Import it as `@vsa/id-kit/testing`. No code of a service imports it.
//
//   const gateway = createStubGateway();
//   const agent = gateway.createAgent({ label: 'reader' });
//   const client = createGatewayClient({ baseUrl: gateway.baseUrl, fetch: gateway.fetch, now: gateway.now });
//   const token = await client.requestToken({ subject: { did: agent.did, key: agent.authentication.privateKey }, dpopKey: agent.delegation.privateKey, audience: 'https://rs.example' });

export { createStubGateway, LISTS_UNAVAILABLE } from './gateway.ts';
export type { AgentOptions, DelegationOptions, Fault, RecordedRequest, StubGateway, StubGatewayOptions } from './gateway.ts';
export { ed25519Key, identifier, p256Key, signerOf, type TestKey } from './keys.ts';
export { CONFIRMATION_DEPTH, START_TIME } from './state.ts';
export type { AgentStatus, Delegator, ListedKey, StubAgent, StubDelegation } from './state.ts';
export { LIST_VALIDITY_MS } from './lists.ts';
