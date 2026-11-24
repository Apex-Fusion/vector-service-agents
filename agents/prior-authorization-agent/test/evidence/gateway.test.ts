// agents/prior-authorization-agent/test/evidence/gateway.test.ts: the evidence over the stub gateway of the identity kit. The other tests of this folder script the answer of the gateway. Here the two reads ask
// a real client for their tokens, and the stub checks the chain of the delegations as the live gateway does: the delegation of the hirer to the agent, and below it one sub-delegation for each read. The ledger
// is the fake ledger of the tests of the access folder, and the stub shows the sub-delegation that this ledger holds. The token of each read must be a token of its subagent: its act chain has two links, the
// subagent under the agent, and its grant is the one action and the one resource of the route.
import { createGatewayClient } from '@vsa/id-kit/client';
import { createStubGateway, ed25519Key } from '@vsa/id-kit/testing';
import { describe, expect, it } from 'vitest';
import { claimsOf } from '../../../../packages/usecase-kit/test/access/support.ts';
import { EVIDENCE_FAILURES } from '../../src/evidence/subread.ts';
import { DAY, GUIDELINE, GUIDELINES_RESOURCE, NOW, PARENT_ID, RECORD_SET, RECORDS_RESOURCE, expectRecordedAndEnded, markSigner, runEvidence, world } from './support.ts';
import type { Fetched, RunOptions } from './support.ts';

const textOf = (hex: string): string => Buffer.from(hex, 'hex').toString('utf8');

/** A world whose gateway is the stub: an agent with its two subagents, the delegation of a hirer to the agent, and a sub-delegation for each id that the ledger makes. */
function stubbed(options: { readonly confirmations?: number; readonly knowsSubDelegations?: boolean } = {}) {
  const w = world();
  const gateway = createStubGateway({ now: () => w.clock.now() });
  const client = createGatewayClient({ baseUrl: gateway.baseUrl, fetch: gateway.fetch, now: gateway.now });
  const agent = gateway.createAgent({ label: 'prior-authorization-agent' });
  const reader = gateway.createAgent({ label: 'record-reader', parent: agent });
  const drafter = gateway.createAgent({ label: 'drafter', parent: agent });
  const root = gateway.delegate({
    delegator: { principalKey: ed25519Key('hirer') }, delegate: agent, actions: ['record.read', 'guideline.read'], resources: [RECORDS_RESOURCE, GUIDELINES_RESOURCE], remaining: 1, id: PARENT_ID,
    notBefore: NOW - DAY, notAfter: NOW + 5 * DAY,
  });
  const known = new Set<string>();
  w.script.requestToken = async (request) => {
    const id = request.delegation!.identifier;
    if (options.knowsSubDelegations !== false && !known.has(id)) {
      known.add(id);
      const live = await w.chain.readDelegation(id);
      if (live === null) throw new Error('the ledger shows no sub-delegation');
      const holder = request.subject.did === reader.did ? reader : drafter;
      gateway.delegate({
        delegator: agent, delegate: holder, parent: root, actions: live.delegation.actions.map(textOf), resources: live.delegation.resources.map(textOf), remaining: live.delegation.remaining, id,
        notBefore: live.delegation.notBefore, notAfter: live.delegation.notAfter, ...(options.confirmations === undefined ? {} : { confirmations: options.confirmations }),
      });
    }
    return client.requestToken(request);
  };
  const over: RunOptions = {
    deps: {
      subagents: {
        record_reader: { did: reader.did, authenticationKey: reader.authentication.privateKey, delegationKey: reader.delegation.privateKey, signer: markSigner(reader.delegation.keyHash) },
        drafter: { did: drafter.did, authenticationKey: drafter.authentication.privateKey, delegationKey: drafter.delegation.privateKey, signer: markSigner(drafter.delegation.keyHash) },
      },
    },
  };
  return { w, gateway, agent, reader, drafter, over };
}

/** The claims of the token that a call carried. */
const claimsOfCall = (call: Fetched): Record<string, unknown> => claimsOf(call.authorization!.slice('DPoP '.length));

describe('the evidence over the stub gateway', () => {
  it('asks for two tokens that the gateway issues, each for the subagent of its read under its own sub-delegation, with an act chain of two links and the one action and the one resource of its route', async () => {
    const { w, gateway, agent, reader, drafter, over } = stubbed();
    expect(await runEvidence(w, over)).toStrictEqual({ ok: true, record_set: RECORD_SET, guideline: GUIDELINE });
    expect(gateway.requests.filter((request) => request.path === '/token')).toHaveLength(2);
    const [first, second] = w.chain.builtDelegates;
    const [recordsCall, guidelinesCall] = w.fetched;
    expect(claimsOfCall(recordsCall!)).toMatchObject({
      aud: RECORDS_RESOURCE,
      act: { sub: reader.did, act: { sub: agent.did } },
      authorization_details: [{ identifier: first!.id, actions: ['record.read'], locations: [RECORDS_RESOURCE] }],
    });
    expect(claimsOfCall(guidelinesCall!)).toMatchObject({
      aud: GUIDELINES_RESOURCE,
      act: { sub: drafter.did, act: { sub: agent.did } },
      authorization_details: [{ identifier: second!.id, actions: ['guideline.read'], locations: [GUIDELINES_RESOURCE] }],
    });
    await expectRecordedAndEnded(w, 2);
  });

  it('fails with token_delegation_too_young when the gateway sees fewer than 30 confirmations, asks for two minutes, calls nothing, makes no second sub-delegation, and ends the first', async () => {
    const { w, gateway, over } = stubbed({ confirmations: 29 });
    expect(await runEvidence(w, over)).toStrictEqual({ ok: false, code: 'token_delegation_too_young' });
    expect(gateway.requests.filter((request) => request.path === '/token').length).toBeGreaterThan(20);
    expect(w.tokenTimes.at(-1)! - w.tokenTimes[0]!).toBe(120_000);
    expect(w.fetched).toStrictEqual([]);
    await expectRecordedAndEnded(w, 1);
  });

  it('fails with a code of the token when the gateway does not know the sub-delegation, calls nothing, and ends the sub-delegation', async () => {
    const { w, gateway, over } = stubbed({ knowsSubDelegations: false });
    const result = await runEvidence(w, over);
    expect(result).toStrictEqual({ ok: false, code: 'token_gateway_refused' });
    expect(EVIDENCE_FAILURES).toContain('token_gateway_refused');
    expect(gateway.requests.filter((request) => request.path === '/token')).toHaveLength(1);
    expect(w.fetched).toStrictEqual([]);
    await expectRecordedAndEnded(w, 1);
  });
});
