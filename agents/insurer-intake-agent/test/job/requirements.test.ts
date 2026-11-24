// agents/insurer-intake-agent/test/job/requirements.test.ts: step 4 of the job. The job reads the requirement set of the insurer portal for the service code of the request, with the JWT-SVID of step 3. A
// refusal of the portal, a failure, an answer that is no requirement set, and a set for another service code are `mock_system_failed` (status 502). The code of the portal goes to the log, and never to the text
// of the refusal. A code of the portal is never a code of the job. Each refusal has an accepted twin. The last block holds the stand-in portal of the rig to the mock service, because the later steps use it.
import { describe, expect, it } from 'vitest';
import { callWithJwtSvid, jwtSvidTarget } from '@vsa/usecase-kit/access';
import type { SystemResult } from '@vsa/usecase-kit/access';
import { parseRequirementSet } from '@vsa/usecase-kit/priorauth';
import type { RequirementSet } from '@vsa/usecase-kit/priorauth';
import type { Document, JsonValue } from '@vsa/usecase-kit/protocol';
import type { IntakeDeps } from '../../src/job/ports.ts';
import { readRequirements } from '../../src/job/requirements.ts';
import { fetchSvid } from '../../src/job/svid.ts';
import { expectNoSecrets, json, makeRig, refusalOf } from './rig.ts';
import type { Reply, Rig } from './rig.ts';
import { BASES, PRIOR_REQUEST, REQUIREMENTS } from './samples.ts';

const PORTAL_REFUSAL = 'The insurer portal did not take the call.';
const MARKER = 'MARKER-OF-THE-PORTAL-TEXT';

/** The steps as the job calls them: the JWT-SVID for the tenant, and then the read of the set for the service code. */
async function read(rig: Rig, over: { readonly tenant?: string; readonly svidTenant?: string; readonly serviceCode?: string; readonly deps?: IntakeDeps } = {}): Promise<RequirementSet> {
  const svid = await fetchSvid(rig.deps, over.svidTenant ?? 'run1');
  return readRequirements(over.deps ?? rig.deps, svid, over.tenant ?? 'run1', over.serviceCode ?? 'SYN-MRI-LS');
}

/** Nothing was done after the read: the read is the only call of the portal, and there is no report, no decision, no filing and no intake book entry. */
function expectNothingAfterRead(rig: Rig): void {
  expect(rig.events).toStrictEqual(['svid', 'requirements']);
  expect(rig.portal.calls).toHaveLength(1);
  expect(rig.reportInputs).toHaveLength(0);
  expect(rig.decideCalls).toHaveLength(0);
  expect(rig.booked).toHaveLength(0);
  expect(rig.portal.filed.size).toBe(0);
}

describe('the requirements', () => {
  it('are read one time, with a GET and no body, for the service code of the request, with the JWT-SVID of the job', async () => {
    const rig = makeRig();
    const set = await read(rig, { serviceCode: String(PRIOR_REQUEST.service_code) });
    expect(rig.portal.calls).toHaveLength(1);
    const [call] = rig.portal.calls;
    expect(call).toMatchObject({ method: 'GET', url: 'https://mock.example/t/run1/insurer/requirements/SYN-MRI-LS', body: null });
    expect(call!.headers.authorization).toBe(`Bearer ${rig.issued[0]}`);
    expect(call!.headers.accept).toBe('application/json');
    expect(rig.events).toStrictEqual(['svid', 'requirements']);
    expect(set).toStrictEqual(REQUIREMENTS['SYN-MRI-LS']);
  });

  it('are the set of the service code that was asked for, and the kit parser takes the set as it is', async () => {
    const rig = makeRig();
    const set = await read(rig, { serviceCode: 'SYN-MRI-KN' });
    expect(set.service_code).toBe('SYN-MRI-KN');
    expect(set.requirements.map((requirement) => requirement.id)).toStrictEqual(['R1', 'R2', 'R3']);
    expect(rig.portal.calls[0]!.url).toBe('https://mock.example/t/run1/insurer/requirements/SYN-MRI-KN');
    expect(parseRequirementSet(set)).toStrictEqual({ ok: true, value: set });
  });

  it('are read for the tenant of the request: the call goes below the insurer system of that tenant, with a JWT-SVID for that tenant', async () => {
    const rig = makeRig();
    await read(rig, { tenant: 'acme-2', svidTenant: 'acme-2' });
    expect(rig.portal.calls[0]!.url).toBe('https://mock.example/t/acme-2/insurer/requirements/SYN-MRI-LS');
  });

  it('are read with the time bound of the deps: one wait of the clock, and 60 seconds when the deps set none', async () => {
    const rig = makeRig({ timeoutMs: 20_000 });
    await read(rig);
    expect(rig.sleeps).toStrictEqual([20_000]);
    const unset = makeRig();
    const { timeoutMs: _bound, ...calls } = unset.deps.calls;
    await read(unset, { deps: { ...unset.deps, calls } });
    expect(unset.sleeps).toStrictEqual([60_000]);
  });

  it('write nothing to the log when the portal answers', async () => {
    const rig = makeRig();
    await read(rig);
    expect(rig.logs).toHaveLength(0);
  });
});

describe('a portal that refuses or fails', () => {
  const refusals: ReadonlyArray<readonly [string, Reply, string]> = [
    ['a refusal of the JWT-SVID (401)', json(401, { error: 'svid_invalid', message: MARKER }), 'svid_invalid'],
    ['a refusal of the organisation (403)', json(403, { error: 'organisation_mismatch', message: MARKER }), 'organisation_mismatch'],
    ['an answer 403 with a body that names no code', json(403, { message: MARKER }), 'refusal_without_code'],
    ['a service code with no requirements (404)', json(404, { error: 'requirements_not_found', message: MARKER }), 'requirements_not_found'],
    ['a failure of the portal (500)', json(500, { error: 'internal', message: MARKER }), 'internal'],
    ['a portal that is busy (503)', json(503, { error: 'service_busy', message: MARKER }), 'service_busy'],
    ['a portal that answers on another host (421)', json(421, { error: 'wrong_host', message: MARKER }), 'wrong_host'],
    ['a redirect (302), which the kit never follows', json(302, { error: 'moved', message: MARKER }), 'status 302'],
    ['an answer 200 that is not JSON', { status: 200, body: `<html>${MARKER}</html>` }, 'status 200'],
    ['an answer 200 with no body', { status: 200, body: '' }, 'status 200'],
    ['no answer at all', { throws: new Error(`connect ECONNREFUSED 203.0.113.9:443 ${MARKER}`) }, 'no answer'],
  ];

  it.each(refusals)('%s ends the step with mock_system_failed (status 502), and the code of the portal is in the log and not in the text', async (_what, reply, logged) => {
    const rig = makeRig();
    rig.portal.requirements = reply;
    const refusal = await refusalOf(() => read(rig));
    expect(refusal).toMatchObject({ code: 'mock_system_failed', status: 502, kind: 'job', message: PORTAL_REFUSAL });
    expectNothingAfterRead(rig);
    expect(rig.logs).toHaveLength(1);
    expect(rig.logs[0]).toContain('mock_system_failed');
    expect(rig.logs[0]).toContain(logged);
    expect(rig.logs[0]).not.toContain(MARKER);
    expect(rig.logs[0]).not.toContain('ECONNREFUSED');
    expect(refusal.message).not.toContain(logged);
    expectNoSecrets(rig, [...rig.logs, refusal.message]);
  });

  it.each([
    ['a refusal that names the code duplicate_request', json(403, { error: 'duplicate_request' })],
    ['a conflict that names the code duplicate_request', json(409, { error: 'duplicate_request' })],
    ['a refusal that names the code precheck_missing', json(403, { error: 'precheck_missing' })],
    ['a failure that names the code deadline', json(500, { error: 'deadline' })],
    ['a failure that names the code internal', json(500, { error: 'internal' })],
  ])('%s is mock_system_failed, and a code of the portal is never a code of this job', async (_what, reply) => {
    const rig = makeRig();
    rig.portal.requirements = reply;
    const refusal = await refusalOf(() => read(rig));
    expect(refusal.code).toBe('mock_system_failed');
    expect(refusal.status).toBe(502);
    expect(refusal.message).toBe(PORTAL_REFUSAL);
  });

  it.each([401, 403, 404, 409, 500, 503])('an answer with the status %s is a refusal or a failure even when its body is a requirement set', async (status) => {
    const rig = makeRig();
    rig.portal.requirements = json(status, REQUIREMENTS['SYN-MRI-LS']);
    expect(await refusalOf(() => read(rig))).toMatchObject({ code: 'mock_system_failed', status: 502, message: PORTAL_REFUSAL });
    expectNothingAfterRead(rig);
    expect(rig.logs[0]).toMatch(/refused by the portal|failed \(status/);
  });

  it('ends the step with mock_system_failed when the portal gives no answer within the time of the call', async () => {
    const rig = makeRig({ expireWaits: true });
    rig.portal.requirements = { hangs: true };
    expect(await refusalOf(() => read(rig))).toMatchObject({ code: 'mock_system_failed', status: 502, message: PORTAL_REFUSAL });
    expect(rig.sleeps).toStrictEqual([20_000]);
    expect(rig.logs[0]).toContain('no answer');
  });

  it('twin: the portal that answers with the set gives it to the job', async () => {
    const rig = makeRig();
    expect((await read(rig)).service_code).toBe('SYN-MRI-LS');
    expect(rig.logs).toHaveLength(0);
  });

  it('ends the step with mock_system_failed when the log fails too: a log that throws changes nothing', async () => {
    const rig = makeRig();
    rig.portal.requirements = json(500, { error: 'internal' });
    rig.logThrows = true;
    expect(await refusalOf(() => read(rig))).toMatchObject({ code: 'mock_system_failed', status: 502 });
  });
});

describe('an answer that is no requirement set', () => {
  const good = REQUIREMENTS['SYN-MRI-LS']!;
  const requirement = { id: 'R9', text: 'A requirement.' };
  const unusable: ReadonlyArray<readonly [string, unknown]> = [
    ['null', null],
    ['a list', [good]],
    ['a text', 'SYN-MRI-LS'],
    ['a number', 5],
    ['an object with no members', {}],
    ['a set with no title', { service_code: good.service_code, requirements: good.requirements }],
    ['a set with a member that is not listed', { ...good, extra: 'x' }],
    ['a set with a title that is a number', { ...good, title: 5 }],
    ['a set with no requirement', { ...good, requirements: [] }],
    ['a set with requirements that are a text', { ...good, requirements: MARKER }],
    ['a set with a requirement that has no text', { ...good, requirements: [{ id: 'R1' }] }],
    ['a set with a requirement that has a member that is not listed', { ...good, requirements: [{ id: 'R1', text: 'A requirement.', weight: 1 }] }],
    ['a set with a member that is not listed, and the name of the member is a text of the body', { ...good, [MARKER]: 'x' }],
    ['a requirement with a member that is not listed, and the name of the member is a text of the body', { ...good, requirements: [{ id: 'R1', text: 'A requirement.', [MARKER]: 1 }] }],
    ['a set with a member that is not listed, and the name of the member looks like a token', { ...good, 'Bearer eyJhbGciOiJFUzI1NiIsImtpZCI6ImRpZ': 1 }],
    ['a set with two requirements of one id', { ...good, requirements: [requirement, requirement] }],
    ['a set with 21 requirements', { ...good, requirements: Array.from({ length: 21 }, (_unused, index) => ({ id: `R${index + 1}`, text: 'A requirement.' })) }],
    ['a set with a requirement text of 501 characters', { ...good, requirements: [{ id: 'R1', text: 'x'.repeat(501) }] }],
    ['a set with a service code that is no identifier', { ...good, service_code: 'SYN MRI' }],
  ];

  it.each(unusable)('%s ends the step with mock_system_failed (status 502), and the log holds the fixed reason and nothing of the body', async (_what, body) => {
    const rig = makeRig();
    rig.portal.requirements = json(200, body);
    const refusal = await refusalOf(() => read(rig));
    expect(refusal).toMatchObject({ code: 'mock_system_failed', status: 502, message: PORTAL_REFUSAL });
    expectNothingAfterRead(rig);
    expect(rig.logs).toHaveLength(1);
    expect(rig.logs[0]).toBe('insurer intake: mock_system_failed: the answer of the portal is no requirement set');
    expect(rig.logs[0]).not.toContain(MARKER);
    expect(rig.logs[0]).not.toContain('x'.repeat(20));
    expect(rig.logs[0]).not.toContain('Bearer');
    expectNoSecrets(rig, rig.logs);
  });

  it('twin: a set with one requirement, and a set with 20, are requirement sets', async () => {
    const one = makeRig();
    one.portal.requirements = json(200, { ...good, requirements: [requirement] });
    expect((await read(one)).requirements).toStrictEqual([requirement]);
    const twenty = makeRig();
    const full = Array.from({ length: 20 }, (_unused, index) => ({ id: `R${index + 1}`, text: 'A requirement.' }));
    twenty.portal.requirements = json(200, { ...good, requirements: full });
    expect((await read(twenty)).requirements).toHaveLength(20);
  });
});

describe('a set for another service code', () => {
  it.each([
    ['the set of another service', REQUIREMENTS['SYN-MRI-KN']!],
    ['the set of the same service in lower case', { ...REQUIREMENTS['SYN-MRI-LS']!, service_code: 'syn-mri-ls' }],
    ['the set of a service code that the request does not name', { ...REQUIREMENTS['SYN-MRI-LS']!, service_code: 'SYN-MRI-LS-2' }],
  ])('%s is refused with mock_system_failed, and the log says that the set is for another service code', async (_what, set) => {
    const rig = makeRig();
    rig.portal.requirements = json(200, set);
    expect(await refusalOf(() => read(rig))).toMatchObject({ code: 'mock_system_failed', status: 502, message: PORTAL_REFUSAL });
    expectNothingAfterRead(rig);
    expect(rig.logs[0]).toContain('another service code');
    expect(rig.logs[0]).not.toContain('SYN-MRI-KN');
  });

  it('twin: the set of the service code that was asked for is taken, whatever the title and the requirements', async () => {
    const rig = makeRig();
    rig.portal.requirements = json(200, { ...REQUIREMENTS['SYN-MRI-LS']!, title: 'Another title' });
    expect(await read(rig)).toMatchObject({ service_code: 'SYN-MRI-LS', title: 'Another title' });
  });
});

describe('a call that is refused before it is sent', () => {
  it('ends the step with mock_system_failed when the service code is no path segment, and no call is made', async () => {
    const rig = makeRig();
    expect(await refusalOf(() => read(rig, { serviceCode: 'SYN/MRI' }))).toMatchObject({ code: 'mock_system_failed', status: 502, message: PORTAL_REFUSAL });
    expect(rig.portal.calls).toHaveLength(0);
    expect(rig.logs[0]).toContain('target');
  });

  it('ends the step with mock_system_failed when the two bases are one host, and no call is made', async () => {
    const rig = makeRig();
    const bases = { publicBase: 'https://mock.example', mtlsBase: 'https://mock.example' };
    const wrong = { ...rig.deps, calls: { ...rig.deps.calls, bases } };
    const svid = await fetchSvid(rig.deps, 'run1');
    expect(await refusalOf(() => readRequirements(wrong, svid, 'run1', 'SYN-MRI-LS'))).toMatchObject({ code: 'mock_system_failed', status: 502 });
    expect(rig.portal.calls).toHaveLength(0);
    expect(rig.logs[0]).toContain('target');
  });

  it('ends the step with mock_system_failed when the JWT-SVID is for another tenant, and the kit sends no call with it', async () => {
    const rig = makeRig();
    expect(await refusalOf(() => read(rig, { tenant: 'run2' }))).toMatchObject({ code: 'mock_system_failed', status: 502 });
    expect(rig.portal.calls).toHaveLength(0);
    expect(rig.logs[0]).toContain('not sent');
    expect(rig.logs[0]).toContain('audience');
  });

  it('ends the step with mock_system_failed when the JWT-SVID has ended, and the kit sends no call with it', async () => {
    const rig = makeRig();
    const svid = await fetchSvid(rig.deps, 'run1');
    const later = { ...rig.deps, calls: { ...rig.deps.calls, clock: { ...rig.deps.calls.clock, now: () => rig.gateway.now() + 10 * 60_000 } } };
    expect(await refusalOf(() => readRequirements(later, svid, 'run1', 'SYN-MRI-LS'))).toMatchObject({ code: 'mock_system_failed', status: 502 });
    expect(rig.portal.calls).toHaveLength(0);
    expect(rig.logs[0]).toContain('not sent');
    expect(rig.logs[0]).toContain('has ended');
  });

  it('twin: the JWT-SVID of the tenant, with the clock of the job, is sent', async () => {
    const rig = makeRig();
    const svid = await fetchSvid(rig.deps, 'run1');
    expect((await readRequirements(rig.deps, svid, 'run1', 'SYN-MRI-LS')).service_code).toBe('SYN-MRI-LS');
    expect(rig.portal.calls).toHaveLength(1);
  });
});

describe('the stand-in portal of the rig', () => {
  /** The filing that the Insurer Intake Agent sends: the request, the status and the missing requirements. */
  const filing = (over: Readonly<Record<string, JsonValue>> = {}, tenant = 'run1'): Document => ({ request: { ...PRIOR_REQUEST, tenant }, status: 'incomplete', missing: ['R4'], ...over });

  /** One call to the filing route, with a JWT-SVID for `svidTenant`. */
  async function file(rig: Rig, body: Document, svidTenant = 'run1', tenant = 'run1'): Promise<SystemResult> {
    const svid = await fetchSvid(rig.deps, svidTenant);
    const target = jwtSvidTarget(BASES, tenant, 'insurer.requests');
    if (!target.ok) throw new Error(target.detail);
    return callWithJwtSvid(rig.deps.calls, svid, target.value, body);
  }

  it('files a request with the same JWT-SVID that read the requirements, and answers 201 with the id of the entry', async () => {
    const rig = makeRig();
    const svid = await fetchSvid(rig.deps, 'run1');
    await readRequirements(rig.deps, svid, 'run1', 'SYN-MRI-LS');
    const target = jwtSvidTarget(BASES, 'run1', 'insurer.requests');
    if (!target.ok) throw new Error(target.detail);
    const answer = await callWithJwtSvid(rig.deps.calls, svid, target.value, filing());
    expect(answer).toMatchObject({ ok: true, status: 201, body: { intake_id: 'IN-run1-0001', request_number: 'run1-1', status: 'incomplete', missing: ['R4'] } });
    expect(rig.portal.filed.size).toBe(1);
    expect(rig.issued).toHaveLength(1);
    expect(rig.events).toStrictEqual(['svid', 'requirements', 'filing']);
  });

  it('refuses a second entry for a request number that it holds, without regard to case: 409 duplicate_request', async () => {
    const rig = makeRig();
    rig.portal.prefile('RUN1-1');
    expect(await file(rig, filing())).toMatchObject({ ok: false, code: 'mock_system_failed', status: 409, systemCode: 'duplicate_request', sent: true });
    expect(rig.portal.filed.size).toBe(1);
  });

  it('refuses a body with other members, and a request of another tenant: 400', async () => {
    const rig = makeRig();
    expect(await file(rig, { ...filing(), extra: true })).toMatchObject({ ok: false, status: 400, systemCode: 'bad_request' });
    expect(await file(rig, filing({}, 'run2'))).toMatchObject({ ok: false, status: 400, systemCode: 'bad_request' });
    expect(rig.portal.filed.size).toBe(0);
  });

  it('takes a call only with a JWT-SVID for the insurer system of the tenant of the URL: 401 svid_missing with none, and 401 svid_invalid for another tenant', async () => {
    const rig = makeRig();
    const url = 'https://mock.example/t/run1/insurer/requests';
    const body = JSON.stringify(filing());
    const bare = await rig.deps.calls.fetch(url, { method: 'POST', headers: { accept: 'application/json' }, body });
    expect(bare.status).toBe(401);
    expect(await bare.json()).toMatchObject({ error: 'svid_missing' });
    const foreign = await fetchSvid(rig.deps, 'run2');
    const other = await rig.deps.calls.fetch(url, { method: 'POST', headers: { accept: 'application/json', authorization: foreign.bearer() }, body });
    expect(other.status).toBe(401);
    expect(await other.json()).toMatchObject({ error: 'svid_invalid' });
    expect(rig.portal.filed.size).toBe(0);
  });

  it('files the request of the sample for the tenant of the URL with a JWT-SVID for that tenant: the twin of both refusals', async () => {
    const rig = makeRig();
    expect(await file(rig, filing())).toMatchObject({ ok: true, status: 201 });
  });
});
