// agents/order-desk/test/job/access.test.ts: steps 3 and 4 of the job. The job gets an X.509-SVID for the service key and reads the entry of the catalogue of the SKU in the supplier portal. A failure of the
// gateway is `svid_failed` (502). A refusal or a failure of the portal is `mock_system_failed` (502), and the code of the portal goes to the log and never to the text of the refusal. After either failure
// the job calls nothing else: no model, no order, no order book. Each refusal has an accepted twin.
import { describe, expect, it } from 'vitest';
import { runOrder } from '../../src/job/index.ts';
import { expectNoSecrets, json, makeRig, refusalOf } from './rig.ts';
import type { Reply, Rig } from './rig.ts';
import { CATALOGUE } from './samples.ts';

/** Nothing was done after the SVID step: no call to the portal, the model and the order book, and no order. */
function expectNothingAfterSvid(rig: Rig): void {
  expect(rig.portal.calls).toHaveLength(0);
  expect(rig.decideInputs).toHaveLength(0);
  expect(rig.booked).toHaveLength(0);
  expect(rig.portal.orders.size).toBe(0);
}

/** Nothing was done after the catalogue read: the read is the only call of the portal, and there is no decision, no order and no order book record. */
function expectNothingAfterCatalogue(rig: Rig): void {
  expect(rig.events).toStrictEqual(['take', 'svid', 'catalogue']);
  expect(rig.portal.calls).toHaveLength(1);
  expect(rig.decideInputs).toHaveLength(0);
  expect(rig.booked).toHaveLength(0);
  expect(rig.portal.orders.size).toBe(0);
}

describe('the X.509-SVID', () => {
  it('is asked for the service key, and a gateway that refuses it ends the job with svid_failed (status 502)', async () => {
    const rig = makeRig();
    rig.gateway.setStatus(rig.agent, 'suspended');
    const refusal = await refusalOf(rig.run());
    expect(refusal).toMatchObject({ code: 'svid_failed', status: 502, kind: 'job', message: 'The Order Desk could not get an X.509-SVID from the identity gateway.' });
    expect(rig.events).toStrictEqual(['take', 'svid']);
    expectNothingAfterSvid(rig);
    expect(rig.logs).toHaveLength(1);
    expect(rig.logs[0]).toContain('svid_failed');
    expect(rig.logs[0]).toContain('gateway_refused');
    expect(rig.logs[0]).toContain('403');
    expect(refusal.message).not.toContain('gateway_refused');
  });

  it('twin: the same gateway with an Active agent issues it, and the job goes on', async () => {
    const rig = makeRig();
    rig.gateway.setStatus(rig.agent, 'suspended');
    await refusalOf(rig.run());
    rig.gateway.setStatus(rig.agent, 'active');
    expect(await rig.run()).toMatchObject({ outcome: 'done' });
  });

  it.each([
    ['the network fails at the request', '/spiffe/x509-svid', 'network' as const, 'gateway_unreachable'],
    ['the gateway answers 503 at the request', '/spiffe/x509-svid', { status: 503, body: '{"error":"temporarily_unavailable"}', headers: { 'content-type': 'application/json' } }, 'gateway_unavailable'],
    ['the gateway answers 500 with a text that is not JSON', '/spiffe/x509-svid', { status: 500, body: 'internal error' }, 'gateway_unavailable'],
    ['the network fails at the nonce', '/spiffe/nonce', 'network' as const, 'gateway_unreachable'],
    ['the gateway answers 503 at the nonce', '/spiffe/nonce', { status: 503, body: '{"error":"temporarily_unavailable"}', headers: { 'content-type': 'application/json' } }, 'gateway_unavailable'],
  ])('ends the job with svid_failed when %s, and nothing goes on, and the twin without the fault passes', async (_what, path, fault, code) => {
    const rig = makeRig();
    rig.gateway.fault(path, fault);
    expect(await refusalOf(rig.run())).toMatchObject({ code: 'svid_failed', status: 502 });
    expectNothingAfterSvid(rig);
    expect(rig.logs[0]).toContain(code);
    rig.gateway.fault(path, null);
    expect(await rig.run()).toMatchObject({ outcome: 'done' });
  });

  it('is asked with the DID and the key of the service: a key that is not a key of that DID is refused by the gateway', async () => {
    const rig = makeRig();
    const other = rig.gateway.createAgent({ label: 'another agent' });
    const wrong = { ...rig.deps, agent: { did: other.did, authenticationKey: rig.agent.authentication.privateKey } };
    expect(await refusalOf(runOrder(wrong, rig.request, rig.context, rig.gateway.now()))).toMatchObject({ code: 'svid_failed', status: 502 });
    expectNothingAfterSvid(rig);
  });

  it('writes no key, certificate or token to the log or to the text of the refusal when it fails', async () => {
    const rig = makeRig();
    rig.gateway.setStatus(rig.agent, 'suspended');
    const refusal = await refusalOf(rig.run());
    expectNoSecrets(rig, [...rig.logs, refusal.message]);
  });
});

describe('the catalogue', () => {
  it('is read for the SKU of the order, with a GET and no body, and the entry goes to the model as the portal gave it', async () => {
    const rig = makeRig({ order: { sku: 'SYR-10ML', lot: 'lot-medium', quantity: 100 } });
    await rig.run();
    expect(rig.portal.calls[0]).toMatchObject({ method: 'GET', url: 'https://mock-mtls.example/t/run1/supplier/catalogue/SYR-10ML', body: null });
    expect(rig.decideInputs[0]).toMatchObject({ catalogue_entry: CATALOGUE['SYR-10ML'] });
  });

  const refusals: ReadonlyArray<readonly [string, Reply, string]> = [
    ['a refusal of the certificate (401)', json(401, { error: 'svid_invalid', message: 'the certificate is not valid' }), 'svid_invalid'],
    ['a refusal of the organisation (403)', json(403, { error: 'organisation_mismatch', message: 'the record names another organisation' }), 'organisation_mismatch'],
    ['an answer 403 with a body that names no code', json(403, { message: 'no' }), 'refusal_without_code'],
    ['an item that is not in the catalogue (404)', json(404, { error: 'sku_not_found', message: 'no such item' }), 'sku_not_found'],
    ['a failure of the portal (500)', json(500, { error: 'internal', message: 'the portal failed' }), 'internal'],
    ['a portal that is busy (503)', json(503, { error: 'service_busy' }), 'service_busy'],
    ['a portal that answers on another host (421)', json(421, { error: 'wrong_host' }), 'wrong_host'],
    ['an answer 200 that is not JSON', { status: 200, body: '<html>ok</html>' }, 'status 200'],
    ['an answer 200 with no body', { status: 200, body: '' }, 'status 200'],
    ['no answer at all', { throws: new Error('connect ECONNREFUSED 203.0.113.9:443') }, 'no answer'],
  ];

  it.each(refusals)('%s ends the job with mock_system_failed (status 502), and the code of the portal is in the log and not in the text', async (_what, reply, logged) => {
    const rig = makeRig();
    rig.portal.catalogue = reply;
    const refusal = await refusalOf(rig.run());
    expect(refusal).toMatchObject({ code: 'mock_system_failed', status: 502, kind: 'job', message: 'The supplier portal did not take the call.' });
    expectNothingAfterCatalogue(rig);
    expect(rig.logs).toHaveLength(1);
    expect(rig.logs[0]).toContain('mock_system_failed');
    expect(rig.logs[0]).toContain(logged);
    expect(rig.logs[0]).not.toContain('ECONNREFUSED');
    expect(refusal.message).not.toContain(logged);
    expectNoSecrets(rig, [...rig.logs, refusal.message]);
  });

  it.each([
    ['null', 'null'],
    ['a list', '[{"sku":"GLV-NIT-M"}]'],
    ['a text', '"GLV-NIT-M"'],
    ['a number', '5'],
    ['true', 'true'],
  ])('an answer that is %s is no entry of the catalogue: mock_system_failed, and the model is not asked', async (_what, body) => {
    const rig = makeRig();
    rig.portal.catalogue = { status: 200, body };
    expect(await refusalOf(rig.run())).toMatchObject({ code: 'mock_system_failed', status: 502 });
    expectNothingAfterCatalogue(rig);
    expect(rig.logs[0]).toContain('not a JSON object');
  });

  it('twin: the portal that answers with the entry gives the model its data, and the job goes on', async () => {
    const rig = makeRig();
    expect(await rig.run()).toMatchObject({ outcome: 'done' });
    expect(rig.decideInputs).toHaveLength(1);
  });

  it('ends with mock_system_failed when the target of the call cannot be made, before any call: the two bases are one host', async () => {
    const rig = makeRig();
    const bases = { publicBase: 'https://mock.example', mtlsBase: 'https://mock.example' };
    const wrong = { ...rig.deps, calls: { ...rig.deps.calls, bases } };
    expect(await refusalOf(runOrder(wrong, rig.request, rig.context, rig.gateway.now()))).toMatchObject({ code: 'mock_system_failed', status: 502 });
    expect(rig.portal.calls).toHaveLength(0);
    expect(rig.decideInputs).toHaveLength(0);
    expect(rig.logs[0]).toContain('target');
  });

  it('ends with mock_system_failed when the SVID has ended: the kit sends no call with it', async () => {
    const rig = makeRig();
    const later = { ...rig.deps.calls.clock, now: () => rig.gateway.now() + 2 * 3_600_000 };
    const wrong = { ...rig.deps, calls: { ...rig.deps.calls, clock: later } };
    expect(await refusalOf(runOrder(wrong, rig.request, rig.context, rig.gateway.now()))).toMatchObject({ code: 'mock_system_failed', status: 502 });
    expect(rig.portal.calls).toHaveLength(0);
    expect(rig.decideInputs).toHaveLength(0);
    expect(rig.logs[0]).toContain('not sent');
  });
});
