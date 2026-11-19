// The identity gateway of the tests of checks 5 and 6: the stub gateway of id-kit on a clock of the test, with the test record as one of its agents (the keys of the tests), and a
// `fetch` that sends the calls to the gateway to the stub and every other call to the network of the machine (the verifier runs on 127.0.0.1).
import { createPublicKey } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createStubGateway } from '../../../../packages/id-kit/src/testing/index.ts';
import type { StubAgent, StubDelegation, StubGateway, TestKey } from '../../../../packages/id-kit/src/testing/index.ts';
import { resolveKey } from '../../../../packages/id-kit/src/index.ts';
import { StateFile } from '../../lib/state.ts';
import type { Harness } from './harness.ts';
import { AGENT_N, MEMBER_N, keyOf } from './world.ts';

/** The key of the tests as a TestKey of the stub: the same key that the key file of the harness holds. */
export function testKeyOf(n: number): TestKey {
  const privateKey = keyOf(n).jwsKey();
  const resolved = resolveKey(privateKey);
  return { kind: 'Ed25519', privateKey, publicKey: createPublicKey(privateKey), jwk: resolved.jwk, publicKeyHex: resolved.publicKey, keyHash: resolved.keyHash, thumbprint: resolved.thumbprint };
}

export interface GatewayWorld {
  gateway: StubGateway;
  agent: StubAgent;
  fetchImpl: typeof fetch;
  /** The environment that points a check at this gateway and at this record. */
  env: Record<string, string>;
}

export function gatewayWorld(clock: { now(): number }): GatewayWorld {
  const gateway = createStubGateway({ now: () => clock.now() });
  const key = testKeyOf(AGENT_N);
  const agent = gateway.createAgent({ label: 'record', authentication: key, delegation: key, keys: [{ key, purposes: 1 + 16 }] });
  const fetchImpl = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => (String(input).startsWith(gateway.baseUrl) ? gateway.fetch(input, init) : fetch(input, init))) as typeof fetch;
  return { gateway, agent, fetchImpl, env: { CHECKS_RECORD: agent.did, CHECKS_GATEWAY_URL: gateway.baseUrl } };
}

/** A delegation of the member to the record on the stub, and the state file of check 1 that records it as the check would. */
export function delegationOnStub(h: Harness, world: GatewayWorld, grant: { action: string; resource: string; stubActions?: string[] }, ended = false): StubDelegation {
  const delegation = world.gateway.delegate({ delegator: { principalKey: testKeyOf(MEMBER_N) }, delegate: world.agent, actions: grant.stubActions ?? [grant.action], resources: [grant.resource] });
  mkdirSync(h.stateDir, { recursive: true });
  const state = StateFile.open(join(h.stateDir, 'delegation.state.json'), { check: 'delegation', network: 'vector-mainnet', record: world.agent.did });
  state.recordStep('delegate', {
    confirmed_at: new Date(h.clock.now()).toISOString(), tx_hash: 'ab'.repeat(32), refs: { delegation_id: delegation.id, delegation_output: `${'ab'.repeat(32)}#0` },
    facts: { delegation_id: delegation.id, actions: [grant.action], resources: [grant.resource], not_after: h.clock.now() + 24 * 3_600_000, delegate_key_hash: keyOf(AGENT_N).keyHash },
  });
  if (ended) state.recordStep('undelegate', { confirmed_at: new Date(h.clock.now()).toISOString(), tx_hash: 'cd'.repeat(32), refs: {}, facts: {} });
  return delegation;
}
