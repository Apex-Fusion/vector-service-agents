// agents/insurer-intake-agent/test/job/take.test.ts: steps 1 and 2 of the job, and the refusal of the job. The hook checks a request before the Claim and keeps a record with the hash of the request. The job
// takes that record by the escrow reference of its context, and it goes on only for the body that the hook checked. A job with no record, or with the record of another body, ends with `precheck_missing`
// and it calls no port: not the gateway, not the insurer portal, not the model and not the intake book. The result takes its sender, its approval and its 15 checks from the record. Each refusal has an
// accepted twin.
import { describe, expect, it } from 'vitest';
import type { Refusal } from '@vsa/service-kit';
import { INTAKE_CHECKS } from '@vsa/usecase-kit/priorauth';
import { COUNTERPARTY_REFUSALS, ERROR_STATUS, isErrorCode } from '@vsa/usecase-kit/protocol';
import type { Handoff, JsonValue } from '@vsa/usecase-kit/protocol';
import { INTAKE_REFUSAL_STATUS, IntakeRefusal, refuse } from '../../src/job/refusal.ts';
import type { IntakeRefusalCode } from '../../src/job/refusal.ts';
import { takeJob } from '../../src/job/take.ts';
import type { TakenJob } from '../../src/job/take.ts';
import type { BookPort, IntakeDeps } from '../../src/job/ports.ts';
import { MemoryIntakeBook, PASSED_CHECKS_TTL_MS, PassedChecks } from '../../src/store/index.ts';
import { makeRig, refusalOf } from './rig.ts';
import type { Rig } from './rig.ts';
import {
  ADVERT_REF, ATTESTATION_ID, CHECKS, DELEGATION_ID, ESCROW_REF, FACTS, INSURER_DID, ISSUER_DID, PRIOR_REQUEST, PRIOR_REQUEST_SHA256, SALT, SENDER_DID, VALID_UNTIL, handoffOf, hashOf, priorRequest,
  recordFor,
} from './samples.ts';

/** The step as the job calls it: the ports of the rig, the handoff and the context. */
const take = (rig: Rig, over: { readonly request?: Handoff; readonly escrowRef?: string } = {}): TakenJob =>
  takeJob(rig.deps, over.request ?? rig.request, over.escrowRef === undefined ? rig.context : { ...rig.context, escrowRef: over.escrowRef });

/** Nothing was done after the record was taken: no call to the gateway, the insurer portal, the report, the model and the intake book. */
function expectNothingDone(rig: Rig): void {
  expect(rig.events).toStrictEqual(['take']);
  expect(rig.gateway.requests).toHaveLength(0);
  expect(rig.portal.calls).toHaveLength(0);
  expect(rig.reportInputs).toHaveLength(0);
  expect(rig.decideCalls).toHaveLength(0);
  expect(rig.booked).toHaveLength(0);
}

/** The twin of a refusal: the rig with no change gives the job that the hook checked. */
function expectTwinPasses(): void {
  const rig = makeRig();
  expect(take(rig)).toMatchObject({ request_sha256: PRIOR_REQUEST_SHA256, delegation: DELEGATION_ID });
  expect(rig.events).toStrictEqual(['take']);
}

const without = <T extends Record<string, JsonValue>>(members: T, name: string): Record<string, JsonValue> => Object.fromEntries(Object.entries(members).filter(([key]) => key !== name));

describe('a job with no record', () => {
  it('is refused with precheck_missing (status 500), and nothing is called', async () => {
    const rig = makeRig();
    rig.kept.clear();
    const refusal = await refusalOf(() => take(rig));
    expect(refusal).toMatchObject({ code: 'precheck_missing', status: 500, kind: 'job', message: 'The job has no record of passed checks for this request.' });
    expectNothingDone(rig);
    expect(rig.logs).toHaveLength(1);
    expect(rig.logs[0]).toContain('precheck_missing');
    expectTwinPasses();
  });

  it('takes the record by the escrow reference of its context, and by nothing else', async () => {
    const rig = makeRig();
    rig.kept.clear();
    await refusalOf(() => take(rig));
    expect(rig.takes).toStrictEqual([rig.context.escrowRef]);
  });

  it('takes the record one time: a second job for the same escrow finds none, so no call goes on', async () => {
    const rig = makeRig({ oneShot: true });
    expect(take(rig).request_sha256).toBe(PRIOR_REQUEST_SHA256);
    expect(await refusalOf(() => take(rig))).toMatchObject({ code: 'precheck_missing', status: 500 });
    expect(rig.takes).toStrictEqual([ESCROW_REF, ESCROW_REF]);
    expect(rig.kept.size).toBe(0);
  });

  it('is refused when the store gives a value that is no record, and not only null', async () => {
    const rig = makeRig();
    rig.kept.set(ESCROW_REF, undefined as never);
    expect(await refusalOf(() => take(rig))).toMatchObject({ code: 'precheck_missing', status: 500 });
    expectNothingDone(rig);
  });

  it('is refused when the log fails too: a log that throws changes nothing', async () => {
    const rig = makeRig();
    rig.kept.clear();
    rig.logThrows = true;
    expect(await refusalOf(() => take(rig))).toMatchObject({ code: 'precheck_missing', status: 500 });
  });
});

describe('a record of another body is no record', () => {
  const bodies: ReadonlyArray<readonly [string, () => Handoff]> = [
    ['another document', () => handoffOf(priorRequest({ justification: 'Another text. This text is synthetic.' }))],
    ['another request number', () => handoffOf(priorRequest({ request_number: 'run1-2' }))],
    ['another service code', () => handoffOf(priorRequest({ service_code: 'SYN-MRI-KN' }))],
    ['another salt', () => handoffOf(PRIOR_REQUEST, { salt: '9b'.repeat(32) })],
    ['another issuer in the approval reference', () => handoffOf(PRIOR_REQUEST, { approval: { attestation: ATTESTATION_ID, issuer_did: `did:vector:${'f3'.repeat(32)}` } })],
    ['another attestation in the approval reference', () => handoffOf(PRIOR_REQUEST, { approval: { attestation: '9c'.repeat(32), issuer_did: ISSUER_DID } })],
    ['no approval reference', () => handoffOf(PRIOR_REQUEST, { approval: null })],
    ['another sender', () => handoffOf(PRIOR_REQUEST, { sender_did: `did:vector:${'f4'.repeat(32)}` })],
    ['another delegation', () => handoffOf(PRIOR_REQUEST, { delegation: '5f'.repeat(32) })],
  ];

  it.each(bodies)('%s: precheck_missing, and nothing is called', async (_what, make) => {
    const rig = makeRig();
    const other = make();
    expect(hashOf(other)).not.toBe(hashOf(rig.request));
    expect(await refusalOf(() => take(rig, { request: other }))).toMatchObject({ code: 'precheck_missing', status: 500 });
    expectNothingDone(rig);
    expect(rig.logs[0]).toContain('another request');
  });

  it('another escrow: the record of the hook is for the escrow of the sample, so a job for another escrow finds none, whatever its body', async () => {
    const rig = makeRig();
    const other = `${'e8'.repeat(32)}#0`;
    expect(await refusalOf(() => take(rig, { escrowRef: other }))).toMatchObject({ code: 'precheck_missing', status: 500 });
    expect(rig.takes).toStrictEqual([other]);
    expectNothingDone(rig);
    expect(rig.logs[0]).toContain('no record');
    expect(rig.kept.has(ESCROW_REF)).toBe(true);
  });

  it('the same escrow with the body of another job: refused, and the record of the hook stays for its own body', async () => {
    const rig = makeRig();
    const other = handoffOf(priorRequest({ service_code: 'SYN-MRI-KN', diagnosis_codes: ['M25.561'] }));
    expect(await refusalOf(() => take(rig, { request: other }))).toMatchObject({ code: 'precheck_missing' });
    expectNothingDone(rig);
  });

  it('twin: the same body, parsed again from its text, passes', () => {
    const rig = makeRig();
    expect(take(rig, { request: handoffOf() }).request_sha256).toBe(PRIOR_REQUEST_SHA256);
  });
});

describe('the hash of the record', () => {
  const right = hashOf(handoffOf());

  it.each([
    ['another hash', 'cd'.repeat(32)],
    ['the right hash in upper case', right.toUpperCase()],
    ['the right hash with a space before it', ` ${right}`],
    ['the empty text', ''],
    ['a number', 7 as never],
    ['null', null as never],
  ])('%s is refused with precheck_missing, and nothing is called', async (_what, hash) => {
    const rig = makeRig();
    rig.kept.set(ESCROW_REF, { ...recordFor(rig.request), request_sha256: hash });
    expect(await refusalOf(() => take(rig))).toMatchObject({ code: 'precheck_missing', status: 500 });
    expectNothingDone(rig);
  });

  it('twin: the right hash passes', () => {
    const rig = makeRig();
    rig.kept.set(ESCROW_REF, recordFor(rig.request, { request_sha256: right }));
    expect(take(rig).request_sha256).toBe(PRIOR_REQUEST_SHA256);
  });

  it('is the hash of the whole body: the hash of the document of the same request, in the record of another body, is refused', async () => {
    const rig = makeRig();
    rig.kept.set(ESCROW_REF, recordFor(rig.request, { request_sha256: hashOf(rig.request.document) }));
    expect(await refusalOf(() => take(rig))).toMatchObject({ code: 'precheck_missing' });
    expectNothingDone(rig);
  });
});

describe('the record itself', () => {
  it.each([
    ['null', null],
    ['a text', 'record'],
    ['a record with no checks', { facts: FACTS }],
    ['a record with no facts', { checks: CHECKS }],
    ['checks that are a list', { checks: [], facts: FACTS }],
    ['facts that are null', { checks: CHECKS, facts: null }],
  ])('%s is no record: precheck_missing, and nothing is called', async (_what, record) => {
    const rig = makeRig();
    rig.kept.set(ESCROW_REF, { record: record as never, request_sha256: hashOf(rig.request) });
    expect(await refusalOf(() => take(rig))).toMatchObject({ code: 'precheck_missing', status: 500 });
    expectNothingDone(rig);
  });
});

describe('the 15 checks', () => {
  it('are the 15 names of the intake record, in the order that they run', () => {
    expect(INTAKE_CHECKS).toHaveLength(15);
    expect(Object.keys(CHECKS)).toStrictEqual([...INTAKE_CHECKS]);
  });

  it.each(INTAKE_CHECKS)('a record without the check %s is refused with precheck_missing, and the log names the check', async (name) => {
    const rig = makeRig();
    rig.kept.set(ESCROW_REF, recordFor(rig.request, { checks: Object.fromEntries(Object.entries(CHECKS).filter(([key]) => key !== name)) }));
    const refusal = await refusalOf(() => take(rig));
    expect(refusal).toMatchObject({ code: 'precheck_missing', status: 500 });
    expect(refusal.message).not.toContain(name);
    expect(rig.logs[0]).toContain(`the check ${name}`);
    expectNothingDone(rig);
  });

  it.each([
    ['false', false],
    ['the text true', 'true'],
    ['the number 1', 1],
    ['null', null],
  ])('a check with the value %s is no passed check', async (_what, value) => {
    const rig = makeRig();
    rig.kept.set(ESCROW_REF, recordFor(rig.request, { checks: { ...CHECKS, not_duplicate: value as never } }));
    expect(await refusalOf(() => take(rig))).toMatchObject({ code: 'precheck_missing' });
    expectNothingDone(rig);
  });

  it('twin: a record with all 15 checks passes, and the result holds the 15 names in their order, whatever the order and the extras of the record', () => {
    const rig = makeRig();
    const reversed = Object.fromEntries(Object.entries(CHECKS).reverse());
    rig.kept.set(ESCROW_REF, recordFor(rig.request, { checks: { extra_check: true, ...reversed } }));
    const taken = take(rig);
    expect(Object.keys(taken.checks)).toStrictEqual([...INTAKE_CHECKS]);
    expect(Object.values(taken.checks).every((value) => value === true)).toBe(true);
  });
});

describe('the facts of the record', () => {
  const unusable: ReadonlyArray<readonly [string, Record<string, JsonValue>, string]> = [
    ['no organisation', without(FACTS, 'organisation'), 'organisation'],
    ['an organisation that is a number', { ...FACTS, organisation: 5 }, 'organisation'],
    ['an organisation that is an object', { ...FACTS, organisation: { name: 'x' } }, 'organisation'],
    ['no organisation_verified', without(FACTS, 'organisation_verified'), 'organisation_verified'],
    ['an organisation_verified that is the text true', { ...FACTS, organisation_verified: 'true' }, 'organisation_verified'],
    ['an organisation_verified that is 1', { ...FACTS, organisation_verified: 1 }, 'organisation_verified'],
    ['an organisation_verified that is null', { ...FACTS, organisation_verified: null }, 'organisation_verified'],
    ['no attestation', without(FACTS, 'approval_attestation'), 'approval_attestation'],
    ['an attestation of 63 characters', { ...FACTS, approval_attestation: '9b'.repeat(31) + '9' }, 'approval_attestation'],
    ['an attestation in upper case', { ...FACTS, approval_attestation: '9B'.repeat(32) }, 'approval_attestation'],
    ['an attestation that is a number', { ...FACTS, approval_attestation: 9 }, 'approval_attestation'],
    ['no issuer DID', without(FACTS, 'approval_issuer_did'), 'approval_issuer_did'],
    ['an issuer that is not a DID', { ...FACTS, approval_issuer_did: 'did:other:abc' }, 'approval_issuer_did'],
    ['an issuer that is a number', { ...FACTS, approval_issuer_did: 3 }, 'approval_issuer_did'],
    ['no end of the approval', without(FACTS, 'approval_valid_until'), 'approval_valid_until'],
    ['an end of the approval that is a text', { ...FACTS, approval_valid_until: VALID_UNTIL }, 'approval_valid_until'],
    ['an end of the approval that is not a whole number', { ...FACTS, approval_valid_until: 1.5 }, 'approval_valid_until'],
    ['an end of the approval beyond the times that a date holds', { ...FACTS, approval_valid_until: Number.MAX_SAFE_INTEGER }, 'approval_valid_until'],
    ['an end of the approval that is true', { ...FACTS, approval_valid_until: true }, 'approval_valid_until'],
  ];

  it.each(unusable)('%s: precheck_missing, the log names the fact, and nothing is called', async (_what, facts, name) => {
    const rig = makeRig();
    rig.kept.set(ESCROW_REF, recordFor(rig.request, { facts }));
    const refusal = await refusalOf(() => take(rig));
    expect(refusal).toMatchObject({ code: 'precheck_missing', status: 500 });
    expect(rig.logs[0]).toContain(`the fact ${name}`);
    expectNothingDone(rig);
  });

  it('twin: the sender with no organisation, an issuer with no record and an approval with no end pass, and each gives null', () => {
    const rig = makeRig();
    rig.kept.set(ESCROW_REF, recordFor(rig.request, { facts: { ...FACTS, organisation: null, organisation_verified: false, approval_issuer_did: null, approval_valid_until: null } }));
    const taken = take(rig);
    expect(taken.sender).toStrictEqual({ did: SENDER_DID, organisation: null, organisation_verified: false });
    expect(taken.approval).toStrictEqual({ attestation: ATTESTATION_ID, issuer_did: null, valid_until: null });
  });

  it.each([
    ['the start of 1970', 0, '1970-01-01T00:00:00.000Z'],
    ['a time before 1970', -1, '1969-12-31T23:59:59.999Z'],
    ['a time with milliseconds', Date.UTC(2026, 10, 24, 10, 0, 0, 7), '2026-11-24T10:00:00.007Z'],
    ['a year after 9999', Date.UTC(10_000, 0, 1), '+010000-01-01T00:00:00.000Z'],
  ])('writes the end of the approval for %s as the time that toISOString writes', (_what, end, text) => {
    const rig = makeRig();
    rig.kept.set(ESCROW_REF, recordFor(rig.request, { facts: { ...FACTS, approval_valid_until: end } }));
    expect(take(rig).approval.valid_until).toBe(text);
  });

  it('takes the sender of the result from the handoff, as the checks of the hook did', () => {
    const other = `did:vector:${'f4'.repeat(32)}`;
    const rig = makeRig();
    const request = handoffOf(PRIOR_REQUEST, { sender_did: other });
    rig.kept.set(ESCROW_REF, recordFor(request));
    expect(take(rig, { request }).sender.did).toBe(other);
  });
});

describe('the request of the handoff', () => {
  it('must be an authorization request: a document that is not one is a fault of the service, internal (status 500), and nothing is called', async () => {
    const rig = makeRig();
    const bad = handoffOf(priorRequest({ diagnosis_codes: [] }));
    rig.kept.set(ESCROW_REF, recordFor(bad));
    const refusal = await refusalOf(() => take(rig, { request: bad }));
    expect(refusal).toMatchObject({ code: 'internal', status: 500, kind: 'job', message: 'The job stopped on a fault of the service.' });
    expect(rig.logs[0]).toContain('authorization request');
    expect(rig.logs[0]).toContain('diagnosis_codes');
    expectNothingDone(rig);
  });

  it('twin: a request with no guideline reference and no record reference is a request, and the job takes it as it is', () => {
    const rig = makeRig();
    const small = handoffOf(priorRequest({ guideline_refs: [], record_refs: [] }));
    rig.kept.set(ESCROW_REF, recordFor(small));
    expect(take(rig, { request: small }).document).toMatchObject({ guideline_refs: [], record_refs: [] });
  });
});

describe('what the job takes', () => {
  it('is the request as the kit parses it, the hash of the document as it was received, the delegation, and the sender, the approval and the checks of the record', () => {
    const rig = makeRig();
    const taken = take(rig);
    expect(taken.document).toStrictEqual(PRIOR_REQUEST);
    expect(taken.request_sha256).toBe(PRIOR_REQUEST_SHA256);
    expect(taken.request_sha256).toBe(hashOf(rig.request.document));
    expect(taken.request_sha256).not.toBe(hashOf(rig.request));
    expect(taken.delegation).toBe(DELEGATION_ID);
    expect(taken.sender).toStrictEqual({ did: SENDER_DID, organisation: 'buyer.example', organisation_verified: true });
    expect(taken.approval).toStrictEqual({ attestation: ATTESTATION_ID, issuer_did: ISSUER_DID, valid_until: VALID_UNTIL });
    expect(Object.keys(taken)).toStrictEqual(['document', 'request_sha256', 'delegation', 'sender', 'approval', 'checks']);
  });

  it('leaves out the facts that the intake record does not hold: the key hash of the approval issuer', () => {
    expect(JSON.stringify(take(makeRig()))).not.toContain('3c'.repeat(28));
  });

  it('calls no port but the one that gives the record, and writes one log line only when it refuses', () => {
    const rig = makeRig();
    take(rig);
    expectNothingDone(rig);
    expect(rig.logs).toHaveLength(0);
  });
});

describe('the log of a refusal', () => {
  /** The values of the request and of the record that no line of the log and no text of a refusal may hold. */
  const values = [
    String(PRIOR_REQUEST.patient_ref), String(PRIOR_REQUEST.ordering_clinician_ref), String(PRIOR_REQUEST.justification), String(PRIOR_REQUEST.record_set_sha256), SENDER_DID, ISSUER_DID, INSURER_DID,
    ATTESTATION_ID, DELEGATION_ID, SALT, ADVERT_REF, PRIOR_REQUEST_SHA256, 'buyer.example',
  ];
  /** Each breaker spoils the rig for one refusal. It gives the request of the job when that is not the request of the rig. */
  const breakers: ReadonlyArray<readonly [string, (rig: Rig) => Handoff | undefined]> = [
    ['no record', (rig) => void rig.kept.clear()],
    ['a record of another body', () => handoffOf(priorRequest({ request_number: 'run1-2' }))],
    ['a record with another hash', (rig) => void rig.kept.set(ESCROW_REF, { ...recordFor(rig.request), request_sha256: 'cd'.repeat(32) })],
    ['a record without a check', (rig) => void rig.kept.set(ESCROW_REF, recordFor(rig.request, { checks: { ...CHECKS, advert: undefined as never } }))],
    ['a record with a fact that cannot be read', (rig) => void rig.kept.set(ESCROW_REF, recordFor(rig.request, { facts: { ...FACTS, organisation_verified: 'true' } }))],
    [
      'a document that is no authorization request',
      (rig) => {
        const bad = handoffOf(priorRequest({ diagnosis_codes: [] }));
        rig.kept.set(ESCROW_REF, recordFor(bad));
        return bad;
      },
    ],
  ];

  it.each(breakers)('%s: one line, and no value of the request or of the record in the line or in the text of the refusal', async (_what, spoil) => {
    const rig = makeRig();
    const request = spoil(rig);
    const refusal = await refusalOf(() => take(rig, request === undefined ? {} : { request }));
    expect(rig.logs).toHaveLength(1);
    for (const text of [...rig.logs, refusal.message]) for (const value of values) expect(text).not.toContain(value);
  });
});

describe('the stores of the package fit the ports', () => {
  /** The deps of the rig, with the record of the hook taken from a real store at the time `at`. */
  function storeDeps(rig: Rig, passed: PassedChecks, at: number): IntakeDeps {
    return { ...rig.deps, takeChecks: (escrowRef) => passed.take(escrowRef, at) };
  }

  it('gives the record that the hook put, one time: a second job for the same escrow finds none', async () => {
    const rig = makeRig();
    const passed = new PassedChecks();
    passed.put(ESCROW_REF, recordFor(rig.request), 1_000);
    const deps = storeDeps(rig, passed, 2_000);
    expect(takeJob(deps, rig.request, rig.context).request_sha256).toBe(PRIOR_REQUEST_SHA256);
    expect(await refusalOf(() => takeJob(deps, rig.request, rig.context))).toMatchObject({ code: 'precheck_missing', status: 500 });
  });

  it('gives the record of an escrow to a job for that escrow only, and the record stays for its own job', async () => {
    const rig = makeRig();
    const passed = new PassedChecks();
    passed.put(ESCROW_REF, recordFor(rig.request), 1_000);
    const deps = storeDeps(rig, passed, 2_000);
    const other = { ...rig.context, escrowRef: `${'e8'.repeat(32)}#0` };
    expect(await refusalOf(() => takeJob(deps, rig.request, other))).toMatchObject({ code: 'precheck_missing' });
    expect(takeJob(deps, rig.request, rig.context).request_sha256).toBe(PRIOR_REQUEST_SHA256);
  });

  it('gives no record that has ended: the job finds none after the time to live, and the twin one millisecond before it ends finds the record', async () => {
    const rig = makeRig();
    const ended = new PassedChecks();
    ended.put(ESCROW_REF, recordFor(rig.request), 1_000);
    expect(await refusalOf(() => takeJob(storeDeps(rig, ended, 1_000 + PASSED_CHECKS_TTL_MS), rig.request, rig.context))).toMatchObject({ code: 'precheck_missing' });
    const alive = new PassedChecks();
    alive.put(ESCROW_REF, recordFor(rig.request), 1_000);
    expect(takeJob(storeDeps(rig, alive, 1_000 + PASSED_CHECKS_TTL_MS - 1), rig.request, rig.context).request_sha256).toBe(PRIOR_REQUEST_SHA256);
  });

  it('takes the intake book of the package as its book port: it records the entry that the portal gave', async () => {
    const book = new MemoryIntakeBook();
    const port: BookPort = book;
    await port.record('run1', 'run1-1', 'IN-run1-0001');
    expect(await book.has('run1', 'RUN1-1')).toBe(true);
  });
});

describe('an IntakeRefusal', () => {
  it('is an error with a code, a status, a message and the kind job, and the service kit takes it as a refusal', () => {
    const refusal = new IntakeRefusal('duplicate_request', 'The portal holds the number.');
    expect(refusal).toBeInstanceOf(Error);
    expect(refusal.name).toBe('IntakeRefusal');
    const form: Refusal = refusal;
    expect(form).toMatchObject({ code: 'duplicate_request', status: 403, message: 'The portal holds the number.', kind: 'job' });
    expect(refusal.message).toBe('The portal holds the number.');
    expect(Object.keys(refusal).sort()).toStrictEqual(['code', 'kind', 'name', 'status']);
  });

  it('has the status of its code, and no caller can give another status', () => {
    // @ts-expect-error the status of a code is fixed: the constructor takes the code and the message only
    const refusal = new IntakeRefusal('duplicate_request', 'x', 200);
    expect(refusal.status).toBe(403);
  });

  it.each([
    ['precheck_missing', 500],
    ['svid_failed', 502],
    ['mock_system_failed', 502],
    ['inference_failed', 502],
    ['model_output_invalid', 502],
    ['duplicate_request', 403],
    ['store_write_failed', 500],
    ['internal', 500],
    ['deadline', 422],
  ] as const)('has the code %s with the status %s', (code, status) => {
    expect(new IntakeRefusal(code, 'x').status).toBe(status);
    expect(INTAKE_REFUSAL_STATUS[code]).toBe(status);
  });

  it('has each code in ERROR_STATUS of the kit with the same status, and the kit knows each one as an error code', () => {
    for (const code of Object.keys(INTAKE_REFUSAL_STATUS) as IntakeRefusalCode[]) {
      expect(isErrorCode(code), code).toBe(true);
      expect(INTAKE_REFUSAL_STATUS[code], code).toBe(ERROR_STATUS[code]);
    }
  });

  it('has a table that nothing can change', () => {
    expect(Object.isFrozen(INTAKE_REFUSAL_STATUS)).toBe(true);
    expect(Object.keys(INTAKE_REFUSAL_STATUS)).toHaveLength(9);
  });

  it('has the one refusal code of the Insurer Intake Agent that the job gives after the Claim in the list of that agent, and the others are error codes that no counterparty lists', () => {
    expect(COUNTERPARTY_REFUSALS['insurer-intake-agent']).toContain('duplicate_request');
    const others = (Object.keys(INTAKE_REFUSAL_STATUS) as IntakeRefusalCode[]).filter((code) => code !== 'duplicate_request');
    for (const code of others) {
      expect(ERROR_STATUS[code]).toBeGreaterThanOrEqual(400);
      for (const list of Object.values(COUNTERPARTY_REFUSALS)) expect(list, code).not.toContain(code);
    }
  });
});

describe('the refusal of a step', () => {
  it('writes one line to the log with the code and the reason, and gives the refusal with the fixed text and the status of the code', () => {
    const lines: string[] = [];
    const refusal = refuse((line) => lines.push(line), 'internal', 'The job stopped on a fault of the service.', 'the reason');
    expect(refusal).toBeInstanceOf(IntakeRefusal);
    expect(refusal).toMatchObject({ code: 'internal', status: 500, kind: 'job', message: 'The job stopped on a fault of the service.' });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('internal: the reason');
  });

  it('gives the refusal when the log throws: a log that fails changes nothing', () => {
    const refusal = refuse(() => {
      throw new Error('the log is closed');
    }, 'svid_failed', 'The text.', 'the reason');
    expect(refusal).toMatchObject({ code: 'svid_failed', status: 502, message: 'The text.' });
  });
});
