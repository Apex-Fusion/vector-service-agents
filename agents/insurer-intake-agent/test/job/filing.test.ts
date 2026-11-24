// agents/insurer-intake-agent/test/job/filing.test.ts: steps 7 and 8 of the job, the filing of the request in the insurer portal and the intake book. The filing is one call with the JWT-SVID, with the request,
// its status and its missing ids, and it is never repeated. A 201 gives the intake id, and only then the intake book records the entry. The portal refuses a number that it holds with 409 `duplicate_request`,
// and every other refusal or failure is `mock_system_failed`: a code of the portal is never a code of this job. A draft of the intake record is checked before the call, the signal and the clock are read
// before it, and nothing is filed for a caller that hung up or for a call that could end after `deliver_by` less 30 seconds. Each refusal has an accepted twin.
import { describe, expect, it } from 'vitest';
import { parsePriorAuthRequest } from '@vsa/usecase-kit/priorauth';
import type { ProtocolResult } from '@vsa/usecase-kit/protocol';
import { FILING_TEXT, RUNTIME_MARGIN_MS, fileRequest } from '../../src/job/filing.ts';
import type { FilingInput } from '../../src/job/filing.ts';
import { INTAKE_REFUSAL_TEXT } from '../../src/job/refusal.ts';
import { fetchSvid } from '../../src/job/svid.ts';
import { expectNoSecrets, json, makeRig, refusalOf } from './rig.ts';
import type { Reply, Rig, RigOptions } from './rig.ts';
import { INTAKE_ID, PRIOR_REQUEST, intakeRecordOf } from './samples.ts';

function must<T>(result: ProtocolResult<T>): T {
  if (!result.ok) throw new Error(`the sample must pass, and it was refused with ${result.code}: ${result.detail}`);
  return result.value;
}

const DOCUMENT = must(parsePriorAuthRequest(PRIOR_REQUEST));
/** The id that the draft of the record holds until the portal gives the real one. It has the form that the parser takes. */
const STAND_IN = 'intake-id-not-known-yet';
/** A text of the request that no line of the log may repeat. */
const REQUEST_TEXTS = [DOCUMENT.justification, DOCUMENT.patient_ref, DOCUMENT.ordering_clinician_ref, DOCUMENT.request_number, DOCUMENT.order_id];

/** A rig, the JWT-SVID of its service key for the tenant, and the input of a filing of the sample request. `over` replaces members of the input. */
async function setup(options: RigOptions = {}, over: Partial<FilingInput> = {}): Promise<{ readonly rig: Rig; readonly input: FilingInput }> {
  const rig = makeRig(options);
  const svid = await fetchSvid(rig.deps, DOCUMENT.tenant);
  const input: FilingInput = { svid, document: DOCUMENT, status: 'complete', missing: [], draft: intakeRecordOf({ intake_id: STAND_IN }), deliverBy: rig.context.deliverByMs, ...over };
  return { rig, input };
}

const file = (rig: Rig, input: FilingInput): Promise<string> => fileRequest(rig.deps, input);

/** The calls that wrote to the portal: the POSTs. */
const posts = (rig: Rig) => rig.portal.calls.filter((call) => call.method === 'POST');

/** Nothing was filed and nothing was booked. */
function expectNothingFiled(rig: Rig): void {
  expect(posts(rig)).toHaveLength(0);
  expect(rig.portal.filed.size).toBe(0);
  expect(rig.booked).toHaveLength(0);
  expect(rig.events).not.toContain('filing');
  expect(rig.events).not.toContain('book');
}

describe('the filing', () => {
  it('is one POST to the insurer system of the tenant, with the JWT-SVID, and the body has the request, the status and the missing ids', async () => {
    const { rig, input } = await setup();
    expect(await file(rig, input)).toBe(INTAKE_ID);
    expect(rig.portal.calls).toHaveLength(1);
    const [call] = rig.portal.calls;
    expect(call).toMatchObject({ method: 'POST', url: 'https://mock.example/t/run1/insurer/requests' });
    expect(call?.headers).toStrictEqual({ accept: 'application/json', authorization: `Bearer ${rig.issued[0]}`, 'content-type': 'application/json' });
    const body: unknown = JSON.parse(call?.body ?? 'null');
    expect(body).toStrictEqual({ request: PRIOR_REQUEST, status: 'complete', missing: [] });
    expect(Object.keys(body as object)).toStrictEqual(['request', 'status', 'missing']);
  });

  it('files the request as the kit parser copied it, with every member of the request and no other', async () => {
    const { rig, input } = await setup();
    await file(rig, input);
    const { request } = JSON.parse(rig.portal.calls[0]?.body ?? 'null') as { request: Record<string, unknown> };
    expect(Object.keys(request)).toStrictEqual(Object.keys(DOCUMENT));
    expect(request).toStrictEqual({ ...DOCUMENT });
  });

  it('files an incomplete request with its status and the ids that the model named', async () => {
    const { rig, input } = await setup({}, { status: 'incomplete', missing: ['R3', 'R4'], draft: intakeRecordOf({ intake_id: STAND_IN, status: 'incomplete', missing: ['R3', 'R4'], decisions: [{ ...intakeRecordOf().decisions[0]!, choice: { complete: false, missing: ['R3', 'R4'] } }] }) });
    await file(rig, input);
    expect(JSON.parse(rig.portal.calls[0]?.body ?? 'null')).toMatchObject({ status: 'incomplete', missing: ['R3', 'R4'] });
    expect(Object.keys(JSON.parse(rig.portal.calls[0]?.body ?? 'null') as object)).toStrictEqual(['request', 'status', 'missing']);
  });

  it('waits for the answer as long as the bound of a call, and no longer', async () => {
    const { rig, input } = await setup();
    await file(rig, input);
    expect(rig.sleeps).toStrictEqual([20_000]);
  });

  it('gives the intake id of the answer, and the intake book records the tenant, the request number and that id', async () => {
    const { rig, input } = await setup();
    const id = await file(rig, input);
    expect(id).toBe(INTAKE_ID);
    expect(rig.booked).toStrictEqual([['run1', 'run1-1', INTAKE_ID]]);
    expect(rig.portal.filed.size).toBe(1);
  });

  it('writes the intake book after the portal took the entry, and never before: the book comes last', async () => {
    const { rig, input } = await setup();
    await file(rig, input);
    expect(rig.events).toStrictEqual(['svid', 'filing', 'book']);
  });

  it('writes no entry to the book when the portal does not take the request', async () => {
    const { rig, input } = await setup();
    rig.portal.filing = json(500, { error: 'internal', message: 'the portal failed' });
    await refusalOf(() => file(rig, input));
    expect(rig.events).toStrictEqual(['svid', 'filing']);
    expect(rig.booked).toHaveLength(0);
  });
});

describe('a number that the portal holds', () => {
  it('is refused with duplicate_request (status 403), and nothing is booked', async () => {
    const { rig, input } = await setup();
    rig.portal.prefile('run1-1');
    const refusal = await refusalOf(() => file(rig, input));
    expect(refusal).toMatchObject({ code: 'duplicate_request', status: 403, kind: 'job', message: FILING_TEXT.duplicate_request });
    expect(rig.booked).toHaveLength(0);
    expect(rig.events).toStrictEqual(['svid', 'filing']);
    expect(rig.portal.filed.size).toBe(1);
    expect(posts(rig)).toHaveLength(1);
    expect(rig.logs).toHaveLength(1);
    expect(rig.logs[0]).toContain('duplicate_request');
    expect(rig.logs[0]).toContain('409');
  });

  it('is the same for a number that differs in case: the portal counts a number without regard to case', async () => {
    const { rig, input } = await setup();
    rig.portal.prefile('RUN1-1');
    expect(await refusalOf(() => file(rig, input))).toMatchObject({ code: 'duplicate_request', status: 403 });
  });

  it('is filed when the portal holds no entry for the number: the twin', async () => {
    const { rig, input } = await setup();
    rig.portal.prefile('run1-2');
    expect(await file(rig, input)).toBe('IN-run1-0002');
  });

  it.each([
    ['a 409 with another code', json(409, { error: 'tenant_changed', message: 'the tenant changed' })],
    ['a 409 with no code', json(409, { message: 'a conflict' })],
    ['a 409 that is no JSON', { status: 409, body: 'conflict' }],
    ['a 400 that names the code', json(400, { error: 'duplicate_request', message: 'bad' })],
    ['a 403 that names the code', json(403, { error: 'duplicate_request', message: 'no' })],
  ] as const)('is mock_system_failed, and never duplicate_request, for %s', async (_what, reply: Reply) => {
    const { rig, input } = await setup();
    rig.portal.filing = reply;
    expect(await refusalOf(() => file(rig, input))).toMatchObject({ code: 'mock_system_failed', status: 502, message: INTAKE_REFUSAL_TEXT.mock_system_failed });
    expect(rig.booked).toHaveLength(0);
  });
});

describe('a refusal or a failure of the portal', () => {
  const FAILURES: ReadonlyArray<readonly [string, Reply, boolean]> = [
    ['a JWT-SVID that the portal does not take (401)', json(401, { error: 'svid_invalid', message: 'the JWT-SVID is not for this system' }), false],
    ['an agent that is not active (403)', json(403, { error: 'agent_not_active', message: 'the agent is not active' }), false],
    ['a body that the portal does not take (400)', json(400, { error: 'bad_request', message: 'the filing has other members' }), false],
    ['a failure of the portal (500)', json(500, { error: 'internal', message: 'the portal failed' }), true],
    ['a portal that is busy (503)', json(503, { error: 'service_busy', message: 'try again' }), true],
    ['an answer of a proxy that is no JSON (502)', { status: 502, body: '<html>bad gateway</html>' }, true],
    ['a 201 whose body is no JSON', { status: 201, body: 'created' }, true],
    ['a 200 in place of the 201', json(200, { intake_id: INTAKE_ID, request_number: 'run1-1', status: 'complete', missing: [] }), true],
    ['a failure of the network', { throws: new Error('connection reset') }, true],
  ];

  it.each(FAILURES)('is mock_system_failed (status 502), with one call and no retry: %s', async (_what, reply, mayExist) => {
    const { rig, input } = await setup();
    rig.portal.filing = reply;
    const refusal = await refusalOf(() => file(rig, input));
    expect(refusal).toMatchObject({ code: 'mock_system_failed', status: 502, kind: 'job', message: 'The insurer portal did not take the call.' });
    expect(posts(rig)).toHaveLength(1);
    expect(rig.booked).toHaveLength(0);
    expect(rig.events).toStrictEqual(['svid', 'filing']);
    expect(rig.logs).toHaveLength(1);
    expect(rig.logs[0]).toContain('mock_system_failed');
    expect(rig.logs[0]?.includes('may exist at the portal')).toBe(mayExist);
  });

  it('is mock_system_failed for a call that has no answer in the bound of a call, and the log says that the entry may exist', async () => {
    const { rig, input } = await setup();
    rig.portal.filing = { hangs: true };
    rig.expireWaits = true;
    const refusal = await refusalOf(() => file(rig, input));
    expect(refusal).toMatchObject({ code: 'mock_system_failed', status: 502 });
    expect(rig.logs[0]).toContain('no answer');
    expect(rig.logs[0]).toContain('may exist at the portal');
    expect(rig.sleeps).toStrictEqual([20_000]);
    expect(posts(rig)).toHaveLength(1);
  });

  it('never repeats the body or the message of the portal, or the message of an error, in the log or in the refusal', async () => {
    for (const reply of [json(500, { error: 'internal', message: 'MARKER-OF-THE-PORTAL-MESSAGE' }), { throws: new Error('MARKER-OF-THE-NETWORK-ERROR') }, { status: 502, body: 'MARKER-OF-THE-PORTAL-BODY' }] as Reply[]) {
      const { rig, input } = await setup();
      rig.portal.filing = reply;
      const refusal = await refusalOf(() => file(rig, input));
      const text = [...rig.logs, refusal.message].join('\n');
      expect(text).not.toContain('MARKER-OF');
      expectNoSecrets(rig, [text]);
      for (const value of REQUEST_TEXTS) expect(text).not.toContain(value);
    }
  });

  it('files the request when the portal answers 201: the twin of each failure', async () => {
    const { rig, input } = await setup();
    rig.portal.filing = null;
    expect(await file(rig, input)).toBe(INTAKE_ID);
  });
});

describe('an answer that holds no entry for this request', () => {
  const UNUSABLE: ReadonlyArray<readonly [string, unknown]> = [
    ['no intake id', { request_number: 'run1-1', status: 'complete', missing: [] }],
    ['an intake id that is a number', { intake_id: 7, request_number: 'run1-1' }],
    ['an intake id that is empty', { intake_id: '', request_number: 'run1-1' }],
    ['an intake id of 65 characters', { intake_id: 'a'.repeat(65), request_number: 'run1-1' }],
    ['an intake id with a space', { intake_id: 'IN run1', request_number: 'run1-1' }],
    ['an intake id with a slash', { intake_id: 'IN/run1', request_number: 'run1-1' }],
    ['an intake id that starts with a dot', { intake_id: '.hidden', request_number: 'run1-1' }],
    ['no request number', { intake_id: INTAKE_ID }],
    ['another request number', { intake_id: INTAKE_ID, request_number: 'run1-2' }],
    ['the request number in another case', { intake_id: INTAKE_ID, request_number: 'RUN1-1' }],
    ['a request number that is a number', { intake_id: INTAKE_ID, request_number: 1 }],
    ['a list', [INTAKE_ID]],
    ['a text', INTAKE_ID],
    ['null', null],
  ];

  it.each(UNUSABLE)('is mock_system_failed, and nothing is booked: %s', async (_what, answer) => {
    const { rig, input } = await setup();
    rig.portal.filing = json(201, answer);
    expect(await refusalOf(() => file(rig, input))).toMatchObject({ code: 'mock_system_failed', status: 502 });
    expect(rig.booked).toHaveLength(0);
    expect(rig.events).toStrictEqual(['svid', 'filing']);
    expect(rig.logs).toHaveLength(1);
    expect(rig.logs[0]).toContain('may exist at the portal');
  });

  it('takes an intake id of the form of the portal: 64 characters, dots, hyphens and underscores inside, as the twin of each unusable id', async () => {
    for (const id of ['a', 'IN-run1-0001', `A${'b'.repeat(63)}`, 'x.y_z-1']) {
      const { rig, input } = await setup();
      rig.portal.filing = json(201, { intake_id: id, request_number: 'run1-1' });
      expect(await file(rig, input)).toBe(id);
      expect(rig.booked).toStrictEqual([['run1', 'run1-1', id]]);
    }
  });

  it('takes an answer with more members than the intake id and the request number, and reads those two only', async () => {
    const { rig, input } = await setup();
    rig.portal.filing = json(201, { intake_id: INTAKE_ID, request_number: 'run1-1', status: 'incomplete', missing: ['R9'], received_at: '2026-11-23T12:00:00.000Z', extra: { deep: [1, 2] } });
    expect(await file(rig, input)).toBe(INTAKE_ID);
  });
});

describe('the intake book', () => {
  it('that cannot be written gives store_write_failed (status 500), and the log says that the entry exists in the portal', async () => {
    const { rig, input } = await setup();
    rig.bookError = new Error('MARKER-OF-THE-DISK-ERROR /var/lib/secret-path');
    const refusal = await refusalOf(() => file(rig, input));
    expect(refusal).toMatchObject({ code: 'store_write_failed', status: 500, kind: 'job', message: FILING_TEXT.intake_book });
    expect(rig.portal.filed.size).toBe(1);
    expect(rig.logs).toHaveLength(1);
    expect(rig.logs[0]).toContain('store_write_failed');
    expect(rig.logs[0]).toContain(INTAKE_ID);
    expect(rig.logs[0]).toContain('the portal holds the entry');
    expect([...rig.logs, refusal.message].join('\n')).not.toContain('MARKER-OF');
    expect([...rig.logs, refusal.message].join('\n')).not.toContain('/var/lib');
  });

  it('is written one time, for the one entry that the portal took', async () => {
    const { rig, input } = await setup();
    await file(rig, input);
    expect(rig.booked).toHaveLength(1);
    expect(posts(rig)).toHaveLength(1);
  });

  it('that rejects with a value that is no error gives store_write_failed too', async () => {
    const { rig, input } = await setup();
    const deps = { ...rig.deps, book: { record: () => Promise.reject('a text') as Promise<void> } };
    expect(await refusalOf(() => fileRequest(deps, input))).toMatchObject({ code: 'store_write_failed', status: 500 });
  });

  it('that throws before it returns a promise gives store_write_failed too', async () => {
    const { rig, input } = await setup();
    const deps = { ...rig.deps, book: { record: (): Promise<void> => { throw new Error('closed'); } } };
    expect(await refusalOf(() => fileRequest(deps, input))).toMatchObject({ code: 'store_write_failed', status: 500 });
  });
});

describe('a caller that hung up', () => {
  it('before the filing gives deadline (status 422), and nothing is filed or booked', async () => {
    const { rig, input } = await setup();
    const controller = new AbortController();
    controller.abort();
    const refusal = await refusalOf(() => file(rig, { ...input, signal: controller.signal }));
    expect(refusal).toMatchObject({ code: 'deadline', status: 422, kind: 'job', message: 'The caller hung up, and the job stopped before it went on.' });
    expectNothingFiled(rig);
    expect(rig.logs).toHaveLength(1);
  });

  it('files the request when the signal has not aborted, or when there is none: the twin', async () => {
    const withSignal = await setup();
    expect(await file(withSignal.rig, { ...withSignal.input, signal: new AbortController().signal })).toBe(INTAKE_ID);
    const without = await setup();
    expect(await file(without.rig, without.input)).toBe(INTAKE_ID);
  });

  it('during the call does not stop the call: the signal is read before the filing and never passed into it', async () => {
    const { rig, input } = await setup();
    const controller = new AbortController();
    // A real `fetch` rejects when its own signal aborts. The caller hangs up as the call is sent: a job that passed the signal into the call would see the call fail.
    const fetch: typeof globalThis.fetch = async (url, init) => {
      if (init?.method === 'POST') controller.abort();
      if (init?.signal?.aborted === true) throw new Error('the call was aborted');
      return rig.portal.fetch(url, init);
    };
    const deps = { ...rig.deps, calls: { ...rig.deps.calls, fetch } };
    expect(await fileRequest(deps, { ...input, signal: controller.signal })).toBe(INTAKE_ID);
    expect(controller.signal.aborted).toBe(true);
    expect(rig.booked).toStrictEqual([['run1', 'run1-1', INTAKE_ID]]);
    expect(rig.logs).toHaveLength(1);
    expect(rig.logs[0]).toContain('hung up while the request was filed');
    expect(rig.logs[0]).toContain(INTAKE_ID);
  });
});

describe('the time left before deliver_by', () => {
  /** The filing with the clock and `deliver_by` so that `leftMs` is the time between the end of the longest call and the time that the runtime stops waiting. */
  async function withLeft(leftMs: number, timeoutMs = 20_000): Promise<{ readonly rig: Rig; readonly input: FilingInput }> {
    const rig = makeRig({ timeoutMs });
    const svid = await fetchSvid(rig.deps, DOCUMENT.tenant);
    const input: FilingInput = { svid, document: DOCUMENT, status: 'complete', missing: [], draft: intakeRecordOf({ intake_id: STAND_IN }), deliverBy: rig.deps.clock() + timeoutMs + RUNTIME_MARGIN_MS + leftMs };
    return { rig, input };
  }

  it('is 30 seconds at the least after the longest call, and the filing is made with exactly that time left: the twin', async () => {
    const { rig, input } = await withLeft(0);
    expect(await file(rig, input)).toBe(INTAKE_ID);
  });

  it('with one millisecond less gives deadline (status 422), and nothing is filed or booked', async () => {
    const { rig, input } = await withLeft(-1);
    const refusal = await refusalOf(() => file(rig, input));
    expect(refusal).toMatchObject({ code: 'deadline', status: 422, kind: 'job', message: FILING_TEXT.no_time });
    expectNothingFiled(rig);
    expect(rig.logs).toHaveLength(1);
    expect(rig.logs[0]).toContain('deadline');
  });

  it('with a deliver_by that has passed gives deadline too', async () => {
    const { rig, input } = await withLeft(-600_000);
    expect(await refusalOf(() => file(rig, input))).toMatchObject({ code: 'deadline', status: 422 });
    expectNothingFiled(rig);
  });

  it('counts the bound of the call that the deps give, and the default of the kit (60 seconds) when they give none', async () => {
    const shorter = await withLeft(0, 5_000);
    expect(await file(shorter.rig, shorter.input)).toBe(INTAKE_ID);
    const longer = await withLeft(-1, 5_000);
    expect(await refusalOf(() => file(longer.rig, longer.input))).toMatchObject({ code: 'deadline' });
    const { rig, input } = await setup();
    const { timeoutMs: _bound, ...calls } = rig.deps.calls;
    const deps = { ...rig.deps, calls };
    const tight = { ...input, deliverBy: rig.deps.clock() + 60_000 + RUNTIME_MARGIN_MS - 1 };
    expect(await refusalOf(() => fileRequest(deps, tight))).toMatchObject({ code: 'deadline' });
    expectNothingFiled(rig);
    const enough = { ...input, deliverBy: rig.deps.clock() + 60_000 + RUNTIME_MARGIN_MS };
    expect(await fileRequest(deps, enough)).toBe(INTAKE_ID);
  });

  it.each([
    ['a clock that gives no number', (): number => Number.NaN],
    ['a clock that gives nothing', (): number => undefined as never],
  ])('refuses with %s: a time that is not known is never enough time', async (_what, clock) => {
    const { rig, input } = await setup();
    expect(await refusalOf(() => fileRequest({ ...rig.deps, clock }, input))).toMatchObject({ code: 'deadline', status: 422 });
    expectNothingFiled(rig);
  });

  it('refuses with a deliver_by that is no number', async () => {
    const { rig, input } = await setup();
    expect(await refusalOf(() => file(rig, { ...input, deliverBy: Number.NaN }))).toMatchObject({ code: 'deadline', status: 422 });
    expectNothingFiled(rig);
  });

  it('keeps the margin of the runtime at 30 seconds', () => {
    expect(RUNTIME_MARGIN_MS).toBe(30_000);
  });
});

describe('the draft of the intake record', () => {
  it('that the parser of the kit refuses gives internal (status 500), and nothing is filed or booked', async () => {
    const { rig, input } = await setup({}, { draft: intakeRecordOf({ intake_id: STAND_IN, status: 'complete', missing: ['R3'] }) });
    expect(await refusalOf(() => file(rig, input))).toMatchObject({ code: 'internal', status: 500, kind: 'job', message: INTAKE_REFUSAL_TEXT.internal });
    expectNothingFiled(rig);
    expect(rig.logs).toHaveLength(1);
  });

  it.each([
    ['a status that says incomplete with no missing id', { status: 'incomplete' as const }],
    ['an intake id that is not an id', { intake_id: 'not valid' }],
    ['a sender with an organisation that is too long', { sender: { did: intakeRecordOf().sender.did, organisation: 'o'.repeat(2000), organisation_verified: true } }],
    ['a decision that is not named completeness', { decisions: [{ ...intakeRecordOf().decisions[0]!, name: 'availability' }] }],
    ['no decision', { decisions: [] }],
    ['a fault value', { fault_mode: 'alter' as never }],
  ])('refuses a draft with %s, and files nothing', async (_what, over) => {
    const { rig, input } = await setup({}, { draft: intakeRecordOf({ intake_id: STAND_IN, ...over }) });
    expect(await refusalOf(() => file(rig, input))).toMatchObject({ code: 'internal', status: 500 });
    expectNothingFiled(rig);
  });

  it('files the request when the draft is valid: the twin of each refusal of a draft', async () => {
    const { rig, input } = await setup();
    expect(await file(rig, input)).toBe(INTAKE_ID);
  });

  it('is not changed by the filing, and the id of the portal is not written into it', async () => {
    const { rig, input } = await setup();
    await file(rig, input);
    expect(input.draft.intake_id).toBe(STAND_IN);
  });
});

describe('the JWT-SVID', () => {
  it('that has ended is refused by the kit before anything is sent: mock_system_failed, nothing is filed or booked', async () => {
    const { rig, input } = await setup();
    rig.gateway.advance(301_000);
    const refusal = await refusalOf(() => file(rig, { ...input, deliverBy: rig.deps.clock() + 600_000 }));
    expect(refusal).toMatchObject({ code: 'mock_system_failed', status: 502 });
    expectNothingFiled(rig);
    expect(rig.logs[0]).toContain('not sent');
    expect(rig.logs[0]).toContain('ended');
  });

  it('that names the insurer system of another tenant is refused before anything is sent', async () => {
    const rig = makeRig();
    const svid = await fetchSvid(rig.deps, 'other');
    const input: FilingInput = { svid, document: DOCUMENT, status: 'complete', missing: [], draft: intakeRecordOf({ intake_id: STAND_IN }), deliverBy: rig.context.deliverByMs };
    expect(await refusalOf(() => file(rig, input))).toMatchObject({ code: 'mock_system_failed', status: 502 });
    expect(rig.portal.calls).toHaveLength(0);
    expect(rig.booked).toHaveLength(0);
  });

  it('is presented as a bearer token, and no log line, refusal or record holds its token or the key of the service', async () => {
    const { rig, input } = await setup();
    const id = await file(rig, input);
    expect(rig.portal.calls[0]?.headers.authorization).toBe(`Bearer ${rig.issued[0]}`);
    const failed = await setup();
    failed.rig.portal.filing = json(500, { error: 'internal', message: 'no' });
    const refusal = await refusalOf(() => file(failed.rig, failed.input));
    expectNoSecrets(rig, [id, ...rig.logs]);
    expectNoSecrets(failed.rig, [refusal.message, ...failed.rig.logs]);
  });
});

describe('what the filing never does', () => {
  it('never reads the intake book before the filing, and never asks the model or the report', async () => {
    const { rig, input } = await setup();
    await file(rig, input);
    expect(rig.events).not.toContain('decide');
    expect(rig.events).not.toContain('report');
    expect(rig.events).not.toContain('take');
    expect(rig.decideCalls).toHaveLength(0);
  });

  it('files at most one entry for one call, for every answer of the portal', async () => {
    for (const reply of [null, json(409, { error: 'duplicate_request', message: 'x' }), json(500, { error: 'internal', message: 'x' }), { throws: new Error('x') }, json(201, {})] as Array<Reply | null>) {
      const { rig, input } = await setup();
      rig.portal.filing = reply;
      try {
        await file(rig, input);
      } catch {
        // A refusal is an answer too: only the number of calls matters here.
      }
      expect(posts(rig)).toHaveLength(1);
    }
  });
});
