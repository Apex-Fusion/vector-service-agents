// agents/sourcing-agent/test/execute/token.test.ts: the token for the sourcing record. It is for the route `sourcing.rankings` only: the action `sourcing.award.write` on the resource of the tenant, held by the agent, with the
// delegation key of the delegation as the DPoP key. One token is asked for, and one call is made with it. A token that the gateway does not give is `token_failed`, and the record is not called. Each form has its twin.
import { describe, expect, it } from 'vitest';
import { ed25519Key } from '@vsa/id-kit/testing';
import { createVerifier } from '@vsa/id-kit/verify';
import type { ExecuteDeps } from '../../src/execute/index.ts';
import type { RecordCall, World } from './world.ts';
import { ONE_CALL, footprint, jsonResponse, words, world } from './world.ts';

/** A record that checks the token of each call with the verifier of the gateway of its world, for `action` on the resource of the world, and writes the ranking only for a token that passes. */
function verifying(w: World, action: string, verdicts: boolean[]): (call: RecordCall) => Promise<Response> {
  const verifier = createVerifier({ baseUrl: w.gateway.baseUrl, fetch: w.gateway.fetch, now: w.gateway.now });
  return async (call) => {
    const verified = await verifier.accessToken(
      { authorization: call.headers.authorization ?? '', dpop: call.headers.dpop ?? '', method: call.method, url: call.url },
      { audience: w.target.resource, require: { action, resource: w.target.resource } },
    );
    verdicts.push(verified.ok);
    return verified.ok ? jsonResponse(201, { ranking_id: 'RK-run1-0001' }) : jsonResponse(401, { error: 'token_invalid', message: 'words' });
  };
}

describe('the token for the sourcing record', () => {
  it('passes the verifier of the mock system for the action sourcing.award.write on its resource: the token is for that route, and the proof is for that call', async () => {
    const w = world();
    const verdicts: boolean[] = [];
    w.record.answer = verifying(w, 'sourcing.award.write', verdicts);
    expect(words(await w.run())).toBe('completed none Completed');
    expect(verdicts).toStrictEqual([true]);
  });

  it('twin: a mock system that wants another action refuses the same token, and the job says refused_by_system with token_invalid', async () => {
    const w = world();
    const verdicts: boolean[] = [];
    w.record.answer = verifying(w, 'vendor.read', verdicts);
    expect(words(await w.run())).toBe('refused_by_system token_invalid Rejected');
    expect(verdicts).toStrictEqual([false]);
  });

  it('is asked one time for the one call: no second token and no second call after a refusal', async () => {
    const w = world();
    w.record.answer = () => jsonResponse(409, { error: 'tenant_changed', message: 'seen' });
    await w.run();
    expect(w.tokens).toHaveLength(1);
    expect(footprint(w)).toStrictEqual(ONE_CALL);
  });

  it('is asked for in the name of this agent: a key that the record of the agent does not list signs no subject token, so the gateway gives no token and the job says token_failed without a call', async () => {
    const w = world();
    const deps: ExecuteDeps = { ...w.deps, agent: { ...w.deps.agent, authenticationKey: ed25519Key('a key that no record lists').privateKey } };
    const result = await w.run(w.request(), w.arrived, deps);
    expect(words(result)).toBe('failed token_failed Failed');
    expect(w.tokens[0]?.answer.ok).toBe(false);
    expect(w.record.calls).toHaveLength(0);
    // The twin: the authentication key of the agent gets the token.
    const twin = world();
    expect(words(await twin.run())).toBe('completed none Completed');
  });
});

describe('a gateway that gives no token', () => {
  it('is token_failed when the hirer ended the delegation: the record is not called, and the log names the code of the gateway and its status', async () => {
    const w = world();
    w.gateway.endDelegation(w.delegation);
    const result = await w.run();
    expect(words(result)).toBe('failed token_failed Failed');
    expect(w.tokens).toHaveLength(1);
    expect(w.tokens[0]?.answer.ok).toBe(false);
    expect(w.record.calls).toHaveLength(0);
    expect(w.log.join('\n')).toMatch(/the gateway gave no token: (bad_request|gateway_refused|delegation_too_young|gateway_unavailable|gateway_unreachable|gateway_bad_response), status \d+/);
  });

  it('is token_failed when the gateway is down: the record is not called', async () => {
    const w = world();
    w.gateway.fault('/token', { status: 503, body: '{}' });
    const result = await w.run();
    expect(words(result)).toBe('failed token_failed Failed');
    expect(w.record.calls).toHaveLength(0);
    expect(w.log.join('\n')).toContain('the gateway gave no token: gateway_unavailable, status 503');
  });

  it('is token_failed when the gateway cannot be reached: the record is not called', async () => {
    const w = world();
    w.gateway.fault('/token', 'network');
    expect(words(await w.run())).toBe('failed token_failed Failed');
    expect(w.record.calls).toHaveLength(0);
  });

  it('twin: a delegation that stands gets its token, and the ranking is written', async () => {
    const w = world();
    expect(words(await w.run())).toBe('completed none Completed');
    expect(w.tokens[0]?.answer.ok).toBe(true);
  });
});
