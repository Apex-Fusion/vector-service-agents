// Checks 5 and 6 against the stub gateway of id-kit and a verifier service on 127.0.0.1. Check 5 reads the delegation of check 1 from its state file and waits for 30 confirmations; check 6
// asks the gateway for SVIDs and shows them to the verifier. A dry run changes nothing, and each refusal has its accepted twin.
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { tokenCheck, parseTokenSettings, UNGRANTED_ACTION } from '../lib/check-token.ts';
import { svidCheck, parseSvidSettings } from '../lib/check-svid.ts';
import { SettingsError } from '../lib/settings.ts';
import { createSvidService } from '../lib/svid-verifier.ts';
import { FakeHosted } from './support/hosted-fake.ts';
import type { Handler } from './support/hosted-fake.ts';
import { delegationOnStub, gatewayWorld } from './support/gateway-world.ts';
import { harness } from './support/harness.ts';
import { FakeClock } from './support/fakes.ts';
import { NOW } from './support/world.ts';

const GRANT = { action: 'mainnet-checks.token.v1', resource: 'https://checks.example/token' };
const servers: Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map((s) => new Promise((done) => { s.close(done); s.closeAllConnections(); }))); });

const useAnswer = (confirmations: number | null, usable: boolean): Handler => (args) => ({
  delegation: args.delegation, usable, problems: usable ? [] : ['the delegation is not usable yet'],
  confirmations: confirmations === null ? null : { tip_height: 100, links: [{ delegation: args.delegation, block_height: 100 - confirmations, confirmations }] },
});

async function tokenRun(confirmations: number | null, usable: boolean) {
  const clock = new FakeClock(NOW);
  const w = gatewayWorld(clock);
  const hosted = new FakeHosted({ vector_check_delegation_use: useAnswer(confirmations, usable) });
  const h = await harness({ clock, hosted, env: w.env, fetchImpl: w.fetchImpl });
  return { h, hosted, w };
}

describe('the settings of check 5', () => {
  it('have an optional resource that is an absolute URI with no fragment', () => {
    expect(parseTokenSettings({})).toEqual({ resource: null });
    expect(parseTokenSettings({ CHECKS_TOKEN_RESOURCE: 'https://checks.example/a' })).toEqual({ resource: 'https://checks.example/a' });
    expect(() => parseTokenSettings({ CHECKS_TOKEN_RESOURCE: 'https://checks.example/a#x' })).toThrow(SettingsError);
    expect(() => parseTokenSettings({ CHECKS_TOKEN_RESOURCE: 'not a url' })).toThrow(SettingsError);
  });
});

describe('check 5, the delegation token', () => {
  it('stops with a precondition when check 1 made no delegation, and when it ended the delegation', async () => {
    const { h, w } = await tokenRun(30, true);
    expect(await h.run(tokenCheck)).toBe(2);
    expect(h.screen.errorText).toContain('check 1 (the delegation) has not made its delegation');
    delegationOnStub(h, w, GRANT, true);
    h.screen.lines.length = 0;
    expect(await h.run(tokenCheck)).toBe(2);
    expect(h.screen.errorText).toContain('has ended');
  });
  it('waits with the time that is left while the delegation has fewer than 30 confirmations, and never sleeps', async () => {
    const { h, w, hosted } = await tokenRun(10, true);
    delegationOnStub(h, w, GRANT);
    const before = h.clock.now();
    expect(await h.run(tokenCheck, '--submit')).toBe(4);
    expect(h.screen.text).toContain('the delegation has 10 of 30 confirmations');
    expect(h.screen.text).toMatch(/20 blocks|1 min 20 s|80 s/);
    expect(h.clock.now()).toBe(before);
    expect(hosted.calls.map((c) => c.args.min_confirmations)).toEqual([30]);
  });
  it('in dry mode shows the request and makes none', async () => {
    const { h, w } = await tokenRun(31, true);
    delegationOnStub(h, w, GRANT);
    expect(await h.run(tokenCheck)).toBe(0);
    expect(h.screen.text).toContain('the record would ask');
    expect(h.screen.text).toContain('has 31 confirmations');
    expect(h.state('delegation-token').steps.token).toBeUndefined();
  });
  it('with --submit gets a token, the verifier accepts it for the action of the delegation and refuses it for another action, and the evidence holds the status of each call', async () => {
    const { h, w } = await tokenRun(30, true);
    const delegation = delegationOnStub(h, w, GRANT);
    expect(await h.run(tokenCheck, '--submit')).toBe(0);
    const entry = h.evidence('delegation-token').find((e) => e.step === 'token')!;
    const shows = entry.shows as { delegation: string; granted: { ok: boolean; status: Record<string, unknown> }; ungranted: { ok: boolean; rule: string }; claims: Record<string, unknown> };
    expect(shows.delegation).toBe(delegation.id);
    expect(shows.granted.ok).toBe(true);
    expect(shows.granted.status).toBeDefined();
    expect(shows.ungranted).toMatchObject({ ok: false, rule: 'delegation.action' });
    expect(JSON.stringify(entry)).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./);
    expect(h.state('delegation-token').steps.token!.refs.delegation_id).toBe(delegation.id);
    expect(UNGRANTED_ACTION).not.toBe(GRANT.action);
  });
  it('exits 1 when the hosted tool says the delegation is not usable although it has 30 confirmations', async () => {
    const { h, w } = await tokenRun(40, false);
    delegationOnStub(h, w, GRANT);
    expect(await h.run(tokenCheck, '--submit')).toBe(2);
    expect(h.screen.errorText).toContain('cannot be used');
  });
});

describe('check 6, the SVIDs', () => {
  async function svidRun() {
    const clock = new FakeClock(NOW);
    const w0 = gatewayWorld(clock);
    const service = createSvidService({ gatewayUrl: w0.gateway.baseUrl, audience: 'https://mtls.verifier.test', fetchImpl: w0.gateway.fetch, now: () => clock.now(), log: () => undefined });
    const server = await service.listen(0);
    servers.push(server);
    const port = (server.address() as { port: number }).port;
    const h = await harness({ clock, env: { ...w0.env, CHECKS_SVID_VERIFIER_URL: `http://127.0.0.1:${port}`, CHECKS_SVID_AUDIENCE: 'https://mtls.verifier.test' }, fetchImpl: w0.fetchImpl });
    return { h, w: w0, port };
  }
  it('has settings: the verifier URL is required, and the audience is the URL by default', () => {
    expect(() => parseSvidSettings({})).toThrow(SettingsError);
    expect(parseSvidSettings({ CHECKS_SVID_VERIFIER_URL: 'https://mtls.example' })).toEqual({ verifierUrl: 'https://mtls.example', audience: 'https://mtls.example' });
    expect(parseSvidSettings({ CHECKS_SVID_VERIFIER_URL: 'https://mtls.example', CHECKS_SVID_AUDIENCE: 'urn:a' }).audience).toBe('urn:a');
    expect(() => parseSvidSettings({ CHECKS_SVID_VERIFIER_URL: 'http://mtls.example' })).toThrow(SettingsError);
  });
  it('in dry mode checks the record and the verifier, and asks the gateway for nothing', async () => {
    const { h } = await svidRun();
    expect(await h.run(svidCheck)).toBe(0);
    expect(h.screen.text).toContain('the verifier answers on');
    expect(h.screen.text).toContain('the record would get an X.509-SVID');
    expect(h.state('svid').steps.x509).toBeUndefined();
  });
  it('with --submit the verifier accepts the X.509-SVID and refuses a call with no certificate, then accepts the JWT-SVID and refuses one for another audience', async () => {
    const { h, w } = await svidRun();
    expect(await h.run(svidCheck, '--submit')).toBe(0);
    expect(await h.run(svidCheck, '--submit')).toBe(0);
    const steps = h.state('svid').steps;
    expect(Object.keys(steps)).toEqual(['x509', 'jwt']);
    const entries = h.evidence('svid');
    const x509 = entries.find((e) => e.step === 'x509')!.shows as { spiffe_id: string; verifier_answer: Record<string, unknown>; no_certificate_answer: Record<string, unknown> };
    expect(x509.spiffe_id).toBe(`spiffe://id.vector.apexfusion.org/agent/${w.agent.id}`);
    expect(x509.verifier_answer.ok).toBe(true);
    expect(x509.no_certificate_answer.rule).toBe('client_certificate.missing');
    const jwt = entries.find((e) => e.step === 'jwt')!.shows as { verifier_answer: Record<string, unknown>; other_audience_answer: Record<string, unknown> };
    expect(jwt.verifier_answer.ok).toBe(true);
    expect(jwt.other_audience_answer.rule).toBe('jwt_svid.audience');
  });
  it('stops with a precondition when the verifier does not answer', async () => {
    const { h } = await svidRun();
    for (const server of servers.splice(0)) await new Promise((done) => { server.close(done); server.closeAllConnections(); });
    expect(await h.run(svidCheck)).toBe(2);
    expect(h.screen.errorText).toContain('the verifier does not answer 200');
  });
  it('stops with a precondition when the record is not one that the gateway resolves', async () => {
    const { h } = await svidRun();
    h.env.CHECKS_RECORD = `did:vector:${'ef'.repeat(32)}`;
    expect(await h.run(svidCheck)).toBe(2);
    expect(h.screen.errorText).toMatch(/could not resolve|does not resolve/);
  });
});
