// agents/insurer-intake-agent/test/job/svid.test.ts: step 3 of the job. The job gets a JWT-SVID for the service key. Its audience is the insurer system of the tenant, `<public base>/t/<tenant>/insurer`, and that
// one audience serves the read of the requirements and the filing. A failure of the gateway is `svid_failed` (status 502). The code and the status of the gateway go to the log, and never to the text of the
// refusal. The credential keeps its token private. Each refusal has an accepted twin.
import { describe, expect, it } from 'vitest';
import { jwtSvidTarget } from '@vsa/usecase-kit/access';
import { fetchSvid } from '../../src/job/svid.ts';
import { expectNoSecrets, makeRig, refusalOf } from './rig.ts';
import type { Rig } from './rig.ts';
import { BASES } from './samples.ts';

const GATEWAY_REFUSAL = 'The Insurer Intake Agent could not get a JWT-SVID from the identity gateway.';

/** The requests that the gateway received for a JWT-SVID. */
const svidRequests = (rig: Rig): Rig['gateway']['requests'] => rig.gateway.requests.filter((call) => call.path === '/spiffe/jwt-svid');

/** A compact JWT with the payload that the test gives. The gateway never signs it: the kit reads the claims and does not check the signature. */
function tokenWith(payload: Readonly<Record<string, unknown>>): string {
  const part = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${part({ alg: 'ES256', typ: 'JWT' })}.${part(payload)}.${part('signature')}`;
}

/** The answer of a gateway that gives the JWT-SVID `svid` with HTTP status 200. */
const answerWith = (svid: string): { readonly status: number; readonly body: string; readonly headers: Record<string, string> } => ({
  status: 200, body: JSON.stringify({ spiffe_id: 'spiffe://gateway.example/agent/x', svid, expires_at: 1_900_000_000 }), headers: { 'content-type': 'application/json' },
});

describe('the JWT-SVID', () => {
  it('is asked for the audience of the insurer system of the tenant, with one request to the gateway, and the answer names that one audience', async () => {
    const rig = makeRig();
    const svid = await fetchSvid(rig.deps, 'run1');
    expect(rig.gateway.requests).toHaveLength(1);
    const [request] = svidRequests(rig);
    expect(request).toMatchObject({ method: 'POST', path: '/spiffe/jwt-svid' });
    expect(JSON.parse(request!.body)).toMatchObject({ audience: 'https://mock.example/t/run1/insurer' });
    expect(svid.audience).toStrictEqual(['https://mock.example/t/run1/insurer']);
    expect(rig.events).toStrictEqual(['svid']);
    expect(rig.issued).toHaveLength(1);
  });

  it('is asked for the service key: the gateway issues it for the agent of that key and for no other agent', async () => {
    const rig = makeRig();
    const other = rig.gateway.createAgent({ label: 'another agent' });
    const svid = await fetchSvid(rig.deps, 'run1');
    expect(svid.spiffeId).toBe(`spiffe://${rig.gateway.trustDomain}/agent/${rig.agent.id}`);
    expect(svid.spiffeId).not.toContain(other.id);
  });

  it('follows the tenant: the audience of another tenant is the insurer system of that tenant', async () => {
    const rig = makeRig();
    const svid = await fetchSvid(rig.deps, 'acme-2');
    expect(svid.audience).toStrictEqual(['https://mock.example/t/acme-2/insurer']);
    expect(JSON.parse(svidRequests(rig)[0]!.body)).toMatchObject({ audience: 'https://mock.example/t/acme-2/insurer' });
  });

  it('is one JWT-SVID for both routes: its audience is the resource of the read of the requirements and the resource of the filing', async () => {
    const rig = makeRig();
    const svid = await fetchSvid(rig.deps, 'run1');
    const read = jwtSvidTarget(BASES, 'run1', 'insurer.requirements', { service_code: 'SYN-MRI-LS' });
    const file = jwtSvidTarget(BASES, 'run1', 'insurer.requests');
    expect(read.ok && file.ok).toBe(true);
    if (!read.ok || !file.ok) return;
    expect(read.value.audience).toBe(file.value.audience);
    expect(svid.audience).toStrictEqual([read.value.audience]);
  });

  it('keeps its token private: no text of the credential shows it, and a call of the step writes nothing to the log', async () => {
    const rig = makeRig();
    const svid = await fetchSvid(rig.deps, 'run1');
    expect(rig.logs).toHaveLength(0);
    expectNoSecrets(rig, [JSON.stringify(svid), String(svid), `${svid.spiffeId} ${svid.audience.join()} ${svid.expiresAt}`]);
    expect(svid.bearer()).toBe(`Bearer ${rig.issued[0]}`);
  });
});

describe('a gateway that gives no JWT-SVID', () => {
  it('is refused with svid_failed (status 502) when it refuses the agent, and the code and the status of the gateway are in the log and not in the text', async () => {
    const rig = makeRig();
    rig.gateway.setStatus(rig.agent, 'suspended');
    const refusal = await refusalOf(() => fetchSvid(rig.deps, 'run1'));
    expect(refusal).toMatchObject({ code: 'svid_failed', status: 502, kind: 'job', message: GATEWAY_REFUSAL });
    expect(rig.events).toStrictEqual(['svid']);
    expect(rig.portal.calls).toHaveLength(0);
    expect(rig.logs).toHaveLength(1);
    expect(rig.logs[0]).toContain('svid_failed');
    expect(rig.logs[0]).toContain('gateway_refused');
    expect(rig.logs[0]).toContain('403');
    expect(refusal.message).not.toContain('gateway_refused');
    expectNoSecrets(rig, [...rig.logs, refusal.message]);
  });

  it('twin: the same gateway with an active agent issues it', async () => {
    const rig = makeRig();
    rig.gateway.setStatus(rig.agent, 'suspended');
    await refusalOf(() => fetchSvid(rig.deps, 'run1'));
    rig.gateway.setStatus(rig.agent, 'active');
    expect((await fetchSvid(rig.deps, 'run1')).audience).toStrictEqual(['https://mock.example/t/run1/insurer']);
  });

  it.each([
    ['the network fails', 'network' as const, 'gateway_unreachable'],
    ['the gateway answers 503', { status: 503, body: '{"error":"temporarily_unavailable"}', headers: { 'content-type': 'application/json' } }, 'gateway_unavailable'],
    ['the gateway answers 500 with a text that is not JSON', { status: 500, body: 'internal error' }, 'gateway_unavailable'],
    ['the gateway answers 200 with a body that is no JWT-SVID answer', { status: 200, body: '{"spiffe_id":"x"}', headers: { 'content-type': 'application/json' } }, 'gateway_bad_response'],
  ])('ends the step with svid_failed when %s, and the twin without the fault passes', async (_what, fault, code) => {
    const rig = makeRig();
    rig.gateway.fault('/spiffe/jwt-svid', fault);
    expect(await refusalOf(() => fetchSvid(rig.deps, 'run1'))).toMatchObject({ code: 'svid_failed', status: 502, message: GATEWAY_REFUSAL });
    expect(rig.logs[0]).toContain(code);
    expect(rig.portal.calls).toHaveLength(0);
    rig.gateway.fault('/spiffe/jwt-svid', null);
    expect((await fetchSvid(rig.deps, 'run1')).audience).toHaveLength(1);
  });

  it('is asked with the DID and the key of the service: a key that is not a key of that DID is refused by the gateway', async () => {
    const rig = makeRig();
    const other = rig.gateway.createAgent({ label: 'another agent' });
    const wrong = { ...rig.deps, agent: { did: other.did, authenticationKey: rig.agent.authentication.privateKey } };
    expect(await refusalOf(() => fetchSvid(wrong, 'run1'))).toMatchObject({ code: 'svid_failed', status: 502 });
    expect(rig.issued).toHaveLength(0);
  });

  it('refuses a JWT-SVID for another audience than the one that was asked for, and the log never shows the token', async () => {
    const rig = makeRig();
    const foreign = tokenWith({ sub: 'spiffe://gateway.example/agent/x', aud: 'https://mock.example/t/run2/insurer', exp: 1_900_000_000 });
    rig.gateway.fault('/spiffe/jwt-svid', answerWith(foreign));
    expect(await refusalOf(() => fetchSvid(rig.deps, 'run1'))).toMatchObject({ code: 'svid_failed', status: 502 });
    expect(rig.logs[0]).toContain('gateway_bad_response');
    expect(rig.logs.join('\n')).not.toContain(foreign);
    expect(rig.logs.join('\n')).not.toContain('run2');
  });

  it('refuses a JWT-SVID for two audiences, and a JWT-SVID with no end time', async () => {
    const rig = makeRig();
    const audience = 'https://mock.example/t/run1/insurer';
    const two = tokenWith({ sub: 'spiffe://gateway.example/agent/x', aud: [audience, 'https://mock.example/t/run1/other'], exp: 1_900_000_000 });
    rig.gateway.fault('/spiffe/jwt-svid', answerWith(two));
    expect(await refusalOf(() => fetchSvid(rig.deps, 'run1'))).toMatchObject({ code: 'svid_failed' });
    rig.gateway.fault('/spiffe/jwt-svid', answerWith(tokenWith({ sub: 'spiffe://gateway.example/agent/x', aud: audience })));
    expect(await refusalOf(() => fetchSvid(rig.deps, 'run1'))).toMatchObject({ code: 'svid_failed' });
  });

  it('twin: a JWT-SVID for exactly the audience that was asked for, as a one-element list, is taken', async () => {
    const rig = makeRig();
    const audience = 'https://mock.example/t/run1/insurer';
    rig.gateway.fault('/spiffe/jwt-svid', answerWith(tokenWith({ sub: 'spiffe://gateway.example/agent/x', aud: [audience], exp: 1_900_000_000 })));
    expect((await fetchSvid(rig.deps, 'run1')).audience).toStrictEqual([audience]);
  });

  it('writes no key or token to the log or to the text of the refusal when it fails', async () => {
    const rig = makeRig();
    rig.gateway.setStatus(rig.agent, 'suspended');
    const refusal = await refusalOf(() => fetchSvid(rig.deps, 'run1'));
    expectNoSecrets(rig, [...rig.logs, refusal.message]);
  });

  it('is refused with svid_failed when the log fails too: a log that throws changes nothing', async () => {
    const rig = makeRig();
    rig.gateway.setStatus(rig.agent, 'suspended');
    rig.logThrows = true;
    expect(await refusalOf(() => fetchSvid(rig.deps, 'run1'))).toMatchObject({ code: 'svid_failed', status: 502 });
  });
});

describe('an audience that cannot be made', () => {
  it('ends the step with svid_failed before the gateway is called when the two bases are one host', async () => {
    const rig = makeRig();
    const wrong = { ...rig.deps, calls: { ...rig.deps.calls, bases: { publicBase: 'https://mock.example', mtlsBase: 'https://mock.example' } } };
    expect(await refusalOf(() => fetchSvid(wrong, 'run1'))).toMatchObject({ code: 'svid_failed', status: 502, message: GATEWAY_REFUSAL });
    expect(rig.gateway.requests).toHaveLength(0);
    expect(rig.logs[0]).toContain('audience');
  });

  it.each([
    ['a space', 'run 1'],
    ['a leading hyphen', '-run1'],
    ['a slash', 'run1/other'],
    ['the empty text', ''],
  ])('ends the step with svid_failed before the gateway is called when the tenant has %s', async (_what, tenant) => {
    const rig = makeRig();
    expect(await refusalOf(() => fetchSvid(rig.deps, tenant))).toMatchObject({ code: 'svid_failed', status: 502 });
    expect(rig.gateway.requests).toHaveLength(0);
    expect(rig.logs[0]).toContain('audience');
  });

  it('twin: two hosts and a tenant of the portal give the audience', async () => {
    const rig = makeRig();
    expect((await fetchSvid(rig.deps, 'run1')).audience).toStrictEqual(['https://mock.example/t/run1/insurer']);
  });
});
