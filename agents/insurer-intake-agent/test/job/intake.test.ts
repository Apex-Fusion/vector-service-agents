// agents/insurer-intake-agent/test/job/intake.test.ts: the job of the Insurer Intake Agent from the record of the hook to the intake record. The job takes the record of the checks, gets a JWT-SVID, reads the
// requirement set, reports the attestations of the sender, asks the model one time, files one entry in the insurer portal, writes the intake book, and gives the intake record. A failure ends the job
// with a refusal, and nothing is written after it. No request is filed before the model decided, no request is filed for a body that the hook did not check, and the report, the sender and the checks
// never reach the prompt. The golden files are the intake record of a complete request and of an incomplete one. The same run is the accepted twin of every refusal in this file.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildPrompt } from '@vsa/usecase-kit/decision';
import { readFaultSwitch, withFaultModeJob } from '@vsa/usecase-kit/fault';
import { INTAKE_CHECKS, parseIntakeRecord, parsePriorAuthRequest, parseRequirementSet } from '@vsa/usecase-kit/priorauth';
import { accepted } from '@vsa/usecase-kit/protocol';
import type { Handoff, ProtocolResult } from '@vsa/usecase-kit/protocol';
import { completenessDecision, completenessInput } from '../../src/job/completeness.ts';
import * as exported from '../../src/job/index.ts';
import type { IntakeRefusalCode } from '../../src/job/index.ts';
import type { AttestationReport, IntakeDeps } from '../../src/job/ports.ts';
import { expectNoSecrets, json, makeRig, refusalOf } from './rig.ts';
import type { Rig, RigOptions } from './rig.ts';
import {
  ADVERT_REF, ATTESTATION_ID, BUYER_PKH, DELEGATION_ID, ESCROW_REF, INSURER_DID, INTAKE_ID, ISSUER_DID, PRIOR_REQUEST, PRIOR_REQUEST_SHA256, REQUIREMENTS, SENDER_DID, VALID_UNTIL, decisionOf,
  failureOf, handoffOf, hashOf, priorRequest, recordFor,
} from './samples.ts';

function must<T, C extends string>(result: ProtocolResult<T, C>): T {
  if (!result.ok) throw new Error(`the sample must pass, and it was refused with ${result.code}: ${result.detail}`);
  return result.value;
}

const golden = (name: string): unknown => JSON.parse(readFileSync(new URL(`./golden/${name}`, import.meta.url), 'utf8'));

const REQUEST = must(parsePriorAuthRequest(PRIOR_REQUEST));
const SET = must(parseRequirementSet(REQUIREMENTS['SYN-MRI-LS']));
const IDS = SET.requirements.map((requirement) => requirement.id);
/** The text of the request that no line of the log may repeat. */
const REQUEST_TEXTS = [REQUEST.justification, REQUEST.patient_ref, REQUEST.ordering_clinician_ref, REQUEST.request_number, REQUEST.order_id, ...REQUEST.record_refs];

/** The model finds the request incomplete: requirement R3 is not met. */
const INCOMPLETE = { ...decisionOf({ complete: false, missing: ['R3'] }), reasoning: 'The justification does not cite the criteria of the guideline, so requirement R3 is not met.' };
/** The report finds one attestation of each kind of state that is not a pass. */
const MIXED: AttestationReport = { provenance: 'valid', software: 'absent', principal_binding: 'unreadable' };

const posts = (rig: Rig) => rig.portal.calls.filter((call) => call.method === 'POST');

/** The ports that the job reached before the decision, in order. */
const BEFORE_DECISION = ['take', 'svid', 'requirements', 'report'];

/** Nothing was filed and nothing was booked. */
function expectNothingFiled(rig: Rig): void {
  expect(posts(rig)).toHaveLength(0);
  expect(rig.portal.filed.size).toBe(0);
  expect(rig.booked).toHaveLength(0);
  expect(rig.events).not.toContain('filing');
  expect(rig.events).not.toContain('book');
}

/** The end of a JWT-SVID in milliseconds, as its own claims say. */
function expiresAtOf(jwt: string): number {
  const claims = JSON.parse(Buffer.from(jwt.split('.')[1] ?? '', 'base64url').toString('utf8')) as { exp: number };
  return claims.exp * 1000;
}

describe('the golden run', () => {
  it('gives the intake record of the golden file for a complete request, and the parser of the kit takes it as it is', async () => {
    const rig = makeRig();
    const record = await rig.run();
    expect(record).toStrictEqual(golden('intake-record-complete.json'));
    expect(parseIntakeRecord(record)).toStrictEqual({ ok: true, value: record });
    expect(record.fault_mode).toBe('');
  });

  it('gives the intake record of the golden file for an incomplete request with the missing id R3, files it, and answers it', async () => {
    const rig = makeRig();
    rig.decision = accepted(INCOMPLETE);
    rig.attestations = MIXED;
    const record = await rig.run();
    expect(record).toStrictEqual(golden('intake-record-incomplete.json'));
    expect(parseIntakeRecord(record)).toStrictEqual({ ok: true, value: record });
    expect(record).toMatchObject({ status: 'incomplete', missing: ['R3'], fault_mode: '' });
    expect(JSON.parse(posts(rig)[0]?.body ?? 'null')).toMatchObject({ status: 'incomplete', missing: ['R3'] });
    expect(rig.portal.filed.size).toBe(1);
    expect(rig.booked).toStrictEqual([['run1', 'run1-1', INTAKE_ID]]);
  });

  it('names the request as the document says it, and the hash of the document as it was received', async () => {
    const rig = makeRig();
    const record = await rig.run();
    expect(record).toMatchObject({ schema: 'vector.usecase.intake-record.v1', outcome: 'done', request_number: 'run1-1', intake_id: INTAKE_ID });
    expect(record.request_sha256).toBe(PRIOR_REQUEST_SHA256);
    expect(record.request_sha256).toBe(hashOf(rig.request.document));
    expect(record.request_sha256).not.toBe(hashOf(rig.request));
  });

  it('takes the sender, the approval and the 15 checks from the record of the hook', async () => {
    const record = await makeRig().run();
    expect(record.sender).toStrictEqual({ did: SENDER_DID, organisation: 'buyer.example', organisation_verified: true });
    expect(record.approval).toStrictEqual({ attestation: ATTESTATION_ID, issuer_did: ISSUER_DID, valid_until: VALID_UNTIL });
    expect(Object.keys(record.checks)).toStrictEqual([...INTAKE_CHECKS]);
    expect(Object.values(record.checks)).toStrictEqual(INTAKE_CHECKS.map(() => true));
    expect(JSON.stringify(record)).not.toContain('approval_issuer_key_hash');
    expect(JSON.stringify(record)).not.toContain('3c'.repeat(28));
  });

  it('holds exactly one decision, the decision completeness, as the model gave it, and the status that it names', async () => {
    const rig = makeRig();
    const record = await rig.run();
    expect(record.decisions).toHaveLength(1);
    expect(record.decisions[0]).toStrictEqual(rig.decision.ok ? rig.decision.value : null);
    expect(record.decisions[0]?.name).toBe('completeness');
    expect(record.status).toBe('complete');
    expect(record.missing).toStrictEqual([]);
  });

  it('holds the three words of the report, and no other member of it', async () => {
    const rig = makeRig();
    rig.attestations = MIXED;
    expect((await rig.run()).attestations).toStrictEqual(MIXED);
  });

  it('reaches the ports in this order: the record, the JWT-SVID, the requirements, the report, the decision, the filing, and the intake book', async () => {
    const rig = makeRig();
    await rig.run();
    expect(rig.events).toStrictEqual([...BEFORE_DECISION, 'decide', 'filing', 'book']);
    expect(rig.takes).toStrictEqual([ESCROW_REF]);
  });

  it('asks the report with the sender and the delegation of the request, at the time of the job', async () => {
    const rig = makeRig();
    await rig.run();
    expect(rig.reportInputs).toStrictEqual([{ sender: SENDER_DID, delegation: DELEGATION_ID, atMs: rig.deps.clock() }]);
  });

  it('asks the model one time, with the request and the requirements, and the ids of the requirements', async () => {
    const rig = makeRig();
    await rig.run();
    expect(rig.decideCalls).toHaveLength(1);
    expect(rig.decideCalls[0]?.input).toStrictEqual(completenessInput(REQUEST, SET));
    expect(rig.decideCalls[0]?.requirementIds).toStrictEqual(IDS);
  });

  it('files exactly one entry with the three members that the portal takes, and the intake book holds it', async () => {
    const rig = makeRig();
    await rig.run();
    expect(rig.portal.filed.size).toBe(1);
    expect(posts(rig)).toHaveLength(1);
    const body = JSON.parse(posts(rig)[0]?.body ?? 'null') as Record<string, unknown>;
    expect(Object.keys(body)).toStrictEqual(['request', 'status', 'missing']);
    expect(body).toStrictEqual({ request: PRIOR_REQUEST, status: 'complete', missing: [] });
    expect(rig.booked).toStrictEqual([['run1', 'run1-1', INTAKE_ID]]);
  });

  it('calls the insurer portal with one JWT-SVID of the service key: the read of the requirements and the filing', async () => {
    const rig = makeRig();
    await rig.run();
    const [read, write] = rig.portal.calls;
    expect(rig.portal.calls).toHaveLength(2);
    expect(read).toMatchObject({ method: 'GET', url: 'https://mock.example/t/run1/insurer/requirements/SYN-MRI-LS', body: null });
    expect(write).toMatchObject({ method: 'POST', url: 'https://mock.example/t/run1/insurer/requests' });
    expect(rig.issued).toHaveLength(1);
    expect(read?.headers.authorization).toBe(`Bearer ${rig.issued[0]}`);
    expect(write?.headers.authorization).toBe(`Bearer ${rig.issued[0]}`);
    expect(rig.gateway.requests.filter((call) => call.path === '/spiffe/jwt-svid')).toHaveLength(1);
  });

  it('waits for each call as long as its bound, and for the report as long as its budget: the time of the job, wait by wait', async () => {
    const rig = makeRig();
    await rig.run();
    expect(rig.sleeps).toStrictEqual([20_000, 45_000, 20_000]);
  });

  it('writes one line to the log, with the intake id, the escrow and the time, and no key, token or part of the request', async () => {
    const rig = makeRig();
    const record = await rig.run();
    expect(rig.logs).toHaveLength(1);
    expect(rig.logs[0]).toBe(`insurer intake: filed the entry ${INTAKE_ID} with the status complete and 0 missing (escrow ${ESCROW_REF}, 0 ms)`);
    expectNoSecrets(rig, [...rig.logs, JSON.stringify(record)]);
    for (const value of REQUEST_TEXTS) expect(rig.logs.join('\n')).not.toContain(value);
  });

  it('gives the same record when the service stamps it: the fault value of the stamp and the fault value of the job are one value, the empty text', async () => {
    const rig = makeRig();
    const stamped = withFaultModeJob(readFaultSwitch('insurer-intake-agent', ''), (request: Handoff) => rig.run({ request }));
    expect(await stamped(rig.request)).toStrictEqual(golden('intake-record-complete.json'));
  });

  it('is not changed by a log that throws', async () => {
    const rig = makeRig();
    rig.logThrows = true;
    expect(await rig.run()).toStrictEqual(golden('intake-record-complete.json'));
    expect(rig.booked).toHaveLength(1);
  });

  it('is the same run for a request that the server parses again from the same text: the twin of a request of another body', async () => {
    const rig = makeRig();
    const again = JSON.parse(JSON.stringify(rig.request)) as Handoff;
    expect(await rig.run({ request: again })).toStrictEqual(golden('intake-record-complete.json'));
  });

  it('gives a new object at each job, so a change of one record cannot change another', async () => {
    const first = await makeRig().run();
    const second = await makeRig().run();
    expect(second).toStrictEqual(first);
    expect(second).not.toBe(first);
    expect(second.decisions).not.toBe(first.decisions);
    expect(second.sender).not.toBe(first.sender);
  });

  it('asks for the requirements of the service code of the request, and gives the ids of that set to the model', async () => {
    const rig = makeRig({ document: { service_code: 'SYN-MRI-KN' } });
    await rig.run();
    expect(rig.portal.calls[0]?.url).toBe('https://mock.example/t/run1/insurer/requirements/SYN-MRI-KN');
    expect(rig.decideCalls[0]?.requirementIds).toStrictEqual(['R1', 'R2', 'R3']);
  });
});

describe('the input of the model', () => {
  it('holds six members of the request and the requirement set: the report, the sender, the checks and the references never reach the prompt', async () => {
    const rig = makeRig();
    rig.attestations = { provenance: 'invalid', software: 'absent', principal_binding: 'unreadable' };
    await rig.run();
    const { input, requirementIds } = rig.decideCalls[0]!;
    const prompt = must(buildPrompt(completenessDecision(requirementIds), input));
    const kept = ['SYN-CL-0007', 'M54.16', 'REC-0002', 'SYN-MRI-LS', 'R3'];
    for (const value of kept) expect(prompt, value).toContain(value);
    const left = [
      SENDER_DID, ISSUER_DID, INSURER_DID, DELEGATION_ID, ATTESTATION_ID, ADVERT_REF, ESCROW_REF, BUYER_PKH, 'buyer.example', VALID_UNTIL, 'SYN-PT-0001', 'ORD-1001', 'run1-1',
      'attestations', 'provenance', 'software', 'principal_binding', 'invalid', 'absent', 'unreadable', 'sender_active', 'approval_digest', 'organisation', 'checks',
    ];
    for (const value of left) expect(prompt, value).not.toContain(value);
  });

  it('is the same input for a request with other values in the members that stay out', async () => {
    const other = makeRig({ document: { request_number: 'other-9', order_id: 'ORD-OTHER', patient_ref: 'SYN-PT-OTHER' } });
    await other.run();
    const plain = makeRig();
    await plain.run();
    expect(other.decideCalls[0]?.input).toStrictEqual(plain.decideCalls[0]?.input);
  });

  it('gives the port a list of ids that it cannot change, and checks the choice against the set that the job made before the port ran', async () => {
    const rig = makeRig();
    let given: readonly string[] = [];
    const decide: IntakeDeps['decide'] = async (_input, ids) => {
      given = ids;
      // A port that tries to add an id: the list is frozen, so the push throws, and the id is never in the set of the job.
      try {
        (ids as string[]).push('R9');
      } catch {
        // The list is frozen.
      }
      return accepted({ ...decisionOf(), choice: { complete: false, missing: ['R9'] } });
    };
    expect(await refusalOf(() => rig.run({ deps: { decide } }))).toMatchObject({ code: 'model_output_invalid', status: 502 });
    expect(Object.isFrozen(given)).toBe(true);
    expect(given).toStrictEqual(['R1', 'R2', 'R3', 'R4', 'R5']);
    expectNothingFiled(rig);
  });
});

describe('a failed decision', () => {
  const PAID = { sub_job: null, receipt: 'not_recordable', accepted: 'pending', escrow_ref: null, advert_ref: null, supplier_pkh: null, verification: null } as const;
  const FAILED = 'The model hire for the decision completeness failed.';
  const INVALID = 'The answer of the model for the decision completeness cannot be used.';
  const STORE = 'The record of the model hire could not be written.';
  const INTERNAL = 'The decision completeness stopped on a fault of the service.';
  const SHAPES: ReadonlyArray<readonly [string, unknown, IntakeRefusalCode, number, string]> = [
    ['a hire that found no model supplier', failureOf('inference_failed', { reason: 'llm_supplier_unavailable', stage: null }), 'inference_failed', 502, FAILED],
    ['a hire that did not answer in time', failureOf('inference_failed', { reason: 'llm_timeout' }), 'inference_failed', 502, FAILED],
    ['a hire that ran out of time', failureOf('inference_failed', { reason: 'llm_out_of_time', stage: null }), 'inference_failed', 502, FAILED],
    ['a hire whose port threw after the Accept', failureOf('inference_failed', { reason: 'hire_threw', stage: 'accept', delivery: PAID }), 'inference_failed', 502, FAILED],
    ['an answer that is no choice', failureOf('model_output_invalid', { reason: 'model_output_invalid', delivery: PAID }), 'model_output_invalid', 502, INVALID],
    ['a store that cannot be written', failureOf('store_write_failed', { reason: 'store_write_failed' }), 'store_write_failed', 500, STORE],
    ['a limit that is wrong', failureOf('internal', { reason: 'bad_limit', stage: null }), 'internal', 500, INTERNAL],
    ['a definition that is wrong', failureOf('internal', { reason: 'bad_decision', stage: null }), 'internal', 500, INTERNAL],
    ['an input that is too large', failureOf('internal', { reason: 'bad_input', stage: null }), 'internal', 500, INTERNAL],
    ['a choice that the parser changed', failureOf('internal', { reason: 'choice_changed', delivery: PAID }), 'internal', 500, INTERNAL],
    ['a code that no decision has', { ...failureOf('internal'), code: 'busy' }, 'internal', 500, INTERNAL],
    ['no result at all', undefined, 'internal', 500, INTERNAL],
  ];

  it.each(SHAPES)('ends the job with its own code, and files nothing: %s', async (_what, result, code, status, message) => {
    const rig = makeRig();
    rig.decision = result as never;
    const refusal = await refusalOf(() => rig.run());
    expect(refusal).toMatchObject({ code, status, kind: 'job', message });
    expect(rig.events).toStrictEqual([...BEFORE_DECISION, 'decide']);
    expectNothingFiled(rig);
    expect(rig.decideCalls).toHaveLength(1);
    expect(rig.logs).toHaveLength(1);
    expect(rig.logs[0]).toContain(`insurer intake: ${code}:`);
    expect(rig.logs[0]).toContain(`(escrow ${ESCROW_REF}, 0 ms)`);
  });

  it('says in the log that the supplier of the model may be paid when the hire was paid, and says nothing of it when it was not', async () => {
    const paid = makeRig();
    paid.decision = failureOf('model_output_invalid', { reason: 'model_output_invalid', delivery: PAID });
    await refusalOf(() => paid.run());
    expect(paid.logs[0]).toContain('the model supplier may be paid');
    const unpaid = makeRig();
    unpaid.decision = failureOf('inference_failed', { reason: 'llm_supplier_unavailable', stage: null });
    await refusalOf(() => unpaid.run());
    expect(unpaid.logs[0]).not.toContain('may be paid');
  });

  it('never repeats the detail, the prompt or the answer of the failure in the log or in the refusal', async () => {
    const rig = makeRig();
    rig.decision = failureOf('model_output_invalid', { reason: 'model_output_invalid', detail: 'MARKER-OF-THE-DETAIL SYN-CL-0007', delivery: PAID });
    const refusal = await refusalOf(() => rig.run());
    const text = [...rig.logs, refusal.message].join('\n');
    expect(text).not.toContain('MARKER-OF');
    expect(text).not.toContain('SYN-CL-0007');
  });

  it('files the request when the model decided: the twin of each failure', async () => {
    const rig = makeRig();
    await rig.run();
    expect(rig.events).toStrictEqual([...BEFORE_DECISION, 'decide', 'filing', 'book']);
  });

  it.each([
    ['complete with a missing id', { complete: true, missing: ['R3'] }],
    ['incomplete with no missing id', { complete: false, missing: [] }],
    ['an id that no requirement has', { complete: false, missing: ['R9'] }],
    ['an id two times', { complete: false, missing: ['R3', 'R3'] }],
    ['a complete that is a text', { complete: 'no', missing: ['R3'] }],
    ['a missing that is a text', { complete: false, missing: 'R3' }],
    ['no missing member', { complete: true }],
    ['a text in place of the choice', 'incomplete'],
    ['null in place of the choice', null],
  ])('takes a decision whose choice is %s as no decision: model_output_invalid, and nothing is filed', async (_what, choice) => {
    const rig = makeRig();
    rig.decision = accepted({ ...decisionOf(), choice: choice as never });
    expect(await refusalOf(() => rig.run())).toMatchObject({ code: 'model_output_invalid', status: 502, message: INVALID });
    expectNothingFiled(rig);
    expect(rig.logs).toHaveLength(1);
  });

  it.each([
    ['a decision of another name', { ...decisionOf(), name: 'availability' }],
    ['a reasoning that is blank', { ...decisionOf(), reasoning: '  ' }],
  ])('ends the job with internal, and files nothing, for %s: no valid record can be made', async (_what, decision) => {
    const rig = makeRig();
    rig.decision = accepted(decision);
    expect(await refusalOf(() => rig.run())).toMatchObject({ code: 'internal', status: 500, message: 'The job stopped on a fault of the service.' });
    expectNothingFiled(rig);
  });

  it('ends the job with internal when the decision has no value', async () => {
    const rig = makeRig();
    rig.decision = { ok: true, value: undefined } as never;
    expect(await refusalOf(() => rig.run())).toMatchObject({ code: 'internal', status: 500 });
    expectNothingFiled(rig);
  });

  it('takes a model that finds every requirement met as complete with no missing id, and one that finds several unmet as incomplete with those ids', async () => {
    const some = makeRig();
    some.decision = accepted({ ...decisionOf({ complete: false, missing: ['R5', 'R1'] }), reasoning: 'Two requirements are not met.' });
    const record = await some.run();
    expect([record.status, record.missing]).toStrictEqual(['incomplete', ['R5', 'R1']]);
    expect(JSON.parse(posts(some)[0]?.body ?? 'null')).toMatchObject({ status: 'incomplete', missing: ['R5', 'R1'] });
  });
});

describe('a request that the hook did not check', () => {
  it('has no record of passed checks: precheck_missing (status 500), and no later port is called', async () => {
    const rig = makeRig();
    rig.kept.clear();
    expect(await refusalOf(() => rig.run())).toMatchObject({ code: 'precheck_missing', status: 500, kind: 'job', message: 'The job has no record of passed checks for this request.' });
    expect(rig.events).toStrictEqual(['take']);
    expect(rig.gateway.requests).toHaveLength(0);
    expect(rig.portal.calls).toHaveLength(0);
    expect(rig.reportInputs).toHaveLength(0);
    expect(rig.decideCalls).toHaveLength(0);
    expectNothingFiled(rig);
  });

  it('has the record of another body: precheck_missing too, and the filing port is not called', async () => {
    const rig = makeRig();
    rig.kept.set(ESCROW_REF, recordFor(handoffOf(priorRequest({ justification: 'Another text of a request that the hook checked.' }))));
    expect(await refusalOf(() => rig.run())).toMatchObject({ code: 'precheck_missing', status: 500 });
    expect(rig.events).toStrictEqual(['take']);
    expect(rig.portal.calls).toHaveLength(0);
    expectNothingFiled(rig);
  });

  it('takes the record one time: the second job for the same escrow is refused, and the portal holds one entry', async () => {
    const rig = makeRig({ oneShot: true });
    await rig.run();
    expect(await refusalOf(() => rig.run())).toMatchObject({ code: 'precheck_missing', status: 500 });
    expect(rig.portal.filed.size).toBe(1);
    expect(posts(rig)).toHaveLength(1);
    expect(rig.booked).toHaveLength(1);
  });
});

describe('a failure before the decision', () => {
  it('of the identity gateway is svid_failed (status 502), and no later port is called', async () => {
    const rig = makeRig();
    rig.gateway.fault('/spiffe/jwt-svid', { status: 503, body: '{"error":"temporarily_unavailable"}' });
    expect(await refusalOf(() => rig.run())).toMatchObject({ code: 'svid_failed', status: 502 });
    expect(rig.events).toStrictEqual(['take', 'svid']);
    expect(rig.portal.calls).toHaveLength(0);
    expect(rig.decideCalls).toHaveLength(0);
    expectNothingFiled(rig);
  });

  it('of the read of the requirements is mock_system_failed (status 502), and the report, the model and the filing are not reached', async () => {
    const rig = makeRig();
    rig.portal.requirements = json(500, { error: 'internal', message: 'the portal failed' });
    expect(await refusalOf(() => rig.run())).toMatchObject({ code: 'mock_system_failed', status: 502 });
    expect(rig.events).toStrictEqual(['take', 'svid', 'requirements']);
    expect(rig.reportInputs).toHaveLength(0);
    expect(rig.decideCalls).toHaveLength(0);
    expectNothingFiled(rig);
  });

  it('of the filing is mock_system_failed after the decision, and the intake book is not written', async () => {
    const rig = makeRig();
    rig.portal.filing = json(500, { error: 'internal', message: 'the portal failed' });
    expect(await refusalOf(() => rig.run())).toMatchObject({ code: 'mock_system_failed', status: 502 });
    expect(rig.events).toStrictEqual([...BEFORE_DECISION, 'decide', 'filing']);
    expect(rig.booked).toHaveLength(0);
  });

  it('of a number that the portal holds is duplicate_request (status 403), and the intake book is not written', async () => {
    const rig = makeRig();
    rig.portal.prefile('run1-1');
    expect(await refusalOf(() => rig.run())).toMatchObject({ code: 'duplicate_request', status: 403, message: 'The insurer portal already holds an entry for this request number.' });
    expect(rig.booked).toHaveLength(0);
    expect(rig.portal.filed.size).toBe(1);
  });

  it('of the intake book is store_write_failed (status 500) after the entry was filed, and no record goes out', async () => {
    const rig = makeRig();
    rig.bookError = new Error('the disk is full');
    expect(await refusalOf(() => rig.run())).toMatchObject({ code: 'store_write_failed', status: 500, message: 'The intake book could not record the entry.' });
    expect(rig.portal.filed.size).toBe(1);
    expect(rig.logs).toHaveLength(1);
    expect(rig.logs[0]).toContain('the portal holds the entry');
  });
});

describe('the report', () => {
  it('that throws does not end the job: the three words are unreadable, and the request is filed', async () => {
    const rig = makeRig();
    const report = async (): Promise<AttestationReport> => {
      rig.events.push('report');
      throw new Error('the ledger is closed');
    };
    const record = await rig.run({ deps: { report } });
    expect(record.attestations).toStrictEqual({ provenance: 'unreadable', software: 'unreadable', principal_binding: 'unreadable' });
    expect(rig.events).toStrictEqual([...BEFORE_DECISION, 'decide', 'filing', 'book']);
    expect(rig.portal.filed.size).toBe(1);
    expect(rig.logs).toHaveLength(2);
  });

  it('that never answers is dropped when its time ends, and the job goes on', async () => {
    const rig = makeRig();
    const { clock } = rig.deps.calls;
    // Only the wait of the report ends at once. The other waits are those of the calls to the portal, and they end with their calls.
    const calls = { ...rig.deps.calls, clock: { now: () => clock.now(), sleep: (ms: number, signal?: AbortSignal) => (ms === 45_000 ? Promise.resolve() : clock.sleep(ms, signal)) } };
    const report = (): Promise<AttestationReport> => new Promise<never>(() => undefined);
    const record = await rig.run({ deps: { calls, report } });
    expect(record.attestations).toStrictEqual({ provenance: 'unreadable', software: 'unreadable', principal_binding: 'unreadable' });
    expect(rig.portal.filed.size).toBe(1);
  });

  it('is skipped when too little time is left for it, and the job files the request all the same', async () => {
    const rig = makeRig({ deliverInMs: 100_000 });
    const record = await rig.run();
    expect(rig.reportInputs).toHaveLength(0);
    expect(record.attestations).toStrictEqual({ provenance: 'unreadable', software: 'unreadable', principal_binding: 'unreadable' });
    expect(rig.portal.filed.size).toBe(1);
  });

  it('is asked at the end of the time that leaves enough for the decision and the filing: the twin of the report that is skipped', async () => {
    const rig = makeRig({ deliverInMs: 190_000 });
    await rig.run();
    expect(rig.reportInputs).toHaveLength(1);
  });

  it('does not change the decision or the status: the same model answer gives the same status for every report', async () => {
    for (const words of [{ provenance: 'invalid', software: 'invalid', principal_binding: 'invalid' }, { provenance: 'absent', software: 'absent', principal_binding: 'absent' }, MIXED] as AttestationReport[]) {
      const rig = makeRig();
      rig.attestations = words;
      const record = await rig.run();
      expect([record.status, record.missing]).toStrictEqual(['complete', []]);
      expect(record.attestations).toStrictEqual(words);
    }
  });
});

describe('the time of the job', () => {
  it('files with the time that is left: with 50,000 ms to deliver_by the filing call can end 30,000 ms before it, the twin', async () => {
    const rig = makeRig({ deliverInMs: 50_000 });
    await rig.run();
    expect(rig.portal.filed.size).toBe(1);
  });

  it('refuses the filing when the call could end after deliver_by less 30 seconds: deadline (status 422), after the decision, and nothing is filed', async () => {
    const rig = makeRig({ deliverInMs: 49_999 });
    expect(await refusalOf(() => rig.run())).toMatchObject({ code: 'deadline', status: 422, kind: 'job', message: 'The job has too little time left to file the request.' });
    expect(rig.events).toStrictEqual([...BEFORE_DECISION.slice(0, 3), 'decide']);
    expectNothingFiled(rig);
  });

  it('refuses a caller that hung up before the decision: deadline, and the model is not hired', async () => {
    const rig = makeRig();
    const controller = new AbortController();
    controller.abort();
    expect(await refusalOf(() => rig.run({ signal: controller.signal }))).toMatchObject({ code: 'deadline', status: 422, message: 'The caller hung up, and the job stopped before it went on.' });
    expect(rig.events).toStrictEqual(BEFORE_DECISION);
    expect(rig.decideCalls).toHaveLength(0);
    expectNothingFiled(rig);
  });

  it('refuses a caller that hung up during the decision: deadline, and nothing is filed', async () => {
    const rig = makeRig();
    const controller = new AbortController();
    const decide: IntakeDeps['decide'] = async (input, ids) => {
      controller.abort();
      return rig.deps.decide(input, ids);
    };
    expect(await refusalOf(() => rig.run({ signal: controller.signal, deps: { decide } }))).toMatchObject({ code: 'deadline', status: 422 });
    expect(rig.events).toStrictEqual([...BEFORE_DECISION, 'decide']);
    expectNothingFiled(rig);
  });

  it('takes a caller that has not hung up, and a job with no signal: the twin', async () => {
    const withSignal = makeRig();
    expect(await withSignal.run({ signal: new AbortController().signal })).toStrictEqual(golden('intake-record-complete.json'));
    expect(await makeRig().run()).toStrictEqual(golden('intake-record-complete.json'));
  });

  it('files the request for a caller that hangs up during the call, books it, and says so in the log: the signal never goes into the call', async () => {
    const rig = makeRig();
    const controller = new AbortController();
    const fetch: typeof globalThis.fetch = async (url, init) => {
      if (init?.method === 'POST') controller.abort();
      if (init?.signal?.aborted === true) throw new Error('the call was aborted');
      return rig.portal.fetch(url, init);
    };
    const record = await rig.run({ signal: controller.signal, deps: { calls: { ...rig.deps.calls, fetch } } });
    expect(record).toStrictEqual(golden('intake-record-complete.json'));
    expect(rig.booked).toHaveLength(1);
    expect(rig.logs.some((line) => line.includes('hung up while the request was filed'))).toBe(true);
  });
});

describe('the JWT-SVID', () => {
  /** A job in which the clock moves between the decision and the filing, so that `leftMs` of the first JWT-SVID are left when the filing starts. */
  async function runWithLeft(leftMs: number): Promise<{ readonly rig: Rig; readonly record: unknown }> {
    const rig = makeRig({ deliverInMs: 900_000 });
    const decide: IntakeDeps['decide'] = async (input, ids) => {
      rig.gateway.advance(expiresAtOf(rig.issued[0] ?? '') - rig.gateway.now() - leftMs);
      return rig.deps.decide(input, ids);
    };
    const record = await rig.run({ deps: { decide } });
    return { rig, record };
  }

  it('serves the whole job when it is still valid for a call after the decision: one request to the gateway', async () => {
    const { rig } = await runWithLeft(250_000);
    expect(rig.events.filter((event) => event === 'svid')).toHaveLength(1);
    expect(rig.issued).toHaveLength(1);
    expect(posts(rig)[0]?.headers.authorization).toBe(`Bearer ${rig.issued[0]}`);
  });

  it('is replaced by a new one when the clock passes 300 seconds between the requirements and the filing: the filing carries the new token', async () => {
    const rig = makeRig({ deliverInMs: 900_000 });
    const decide: IntakeDeps['decide'] = async (input, ids) => {
      rig.gateway.advance(300_000);
      return rig.deps.decide(input, ids);
    };
    const record = await rig.run({ deps: { decide } });
    expect(record).toStrictEqual(golden('intake-record-complete.json'));
    expect(rig.events).toStrictEqual([...BEFORE_DECISION, 'decide', 'svid', 'filing', 'book']);
    expect(rig.issued).toHaveLength(2);
    expect(rig.issued[1]).not.toBe(rig.issued[0]);
    expect(posts(rig)[0]?.headers.authorization).toBe(`Bearer ${rig.issued[1]}`);
    expect(rig.portal.calls[0]?.headers.authorization).toBe(`Bearer ${rig.issued[0]}`);
    expect(rig.portal.filed.size).toBe(1);
  });

  it('is kept when it ends exactly one call after the filing starts, and replaced with one millisecond less: the bound is the bound of a call', async () => {
    const kept = await runWithLeft(20_000);
    expect(kept.rig.issued).toHaveLength(1);
    expect(kept.rig.portal.filed.size).toBe(1);
    const replaced = await runWithLeft(19_999);
    expect(replaced.rig.issued).toHaveLength(2);
    expect(replaced.rig.portal.filed.size).toBe(1);
    expect(posts(replaced.rig)[0]?.headers.authorization).toBe(`Bearer ${replaced.rig.issued[1]}`);
  });

  it('is replaced by a new one that the gateway refuses: svid_failed (status 502), and nothing is filed', async () => {
    const rig = makeRig({ deliverInMs: 900_000 });
    const decide: IntakeDeps['decide'] = async (input, ids) => {
      rig.gateway.advance(300_000);
      rig.gateway.fault('/spiffe/jwt-svid', { status: 503, body: '{"error":"temporarily_unavailable"}' });
      return rig.deps.decide(input, ids);
    };
    expect(await refusalOf(() => rig.run({ deps: { decide } }))).toMatchObject({ code: 'svid_failed', status: 502 });
    expect(rig.events).toStrictEqual([...BEFORE_DECISION, 'decide', 'svid']);
    expectNothingFiled(rig);
  });

  it('takes the 60 seconds that the new JWT-SVID needs from the filing: deadline (status 422), and nothing is filed', async () => {
    // The time is enough for the filing when the new JWT-SVID is asked for. The gateway answers after 60 seconds, and then it is not.
    const rig = makeRig({ deliverInMs: 380_000 });
    const decide: IntakeDeps['decide'] = async (input, ids) => {
      rig.gateway.advance(300_000);
      return rig.deps.decide(input, ids);
    };
    const { client } = rig.deps.svid;
    let asked = 0;
    const jwtSvid: typeof client.jwtSvid = async (request) => {
      asked += 1;
      const answer = await client.jwtSvid(request);
      // The first request is the one of the job. The second is the new JWT-SVID, and it takes 60 seconds.
      if (asked === 2) rig.gateway.advance(60_000);
      return answer;
    };
    const refusal = await refusalOf(() => rig.run({ deps: { decide, svid: { client: { ...client, jwtSvid } } } }));
    expect(refusal).toMatchObject({ code: 'deadline', status: 422, message: 'The job has too little time left to file the request.' });
    expect(rig.events).toStrictEqual([...BEFORE_DECISION, 'decide', 'svid']);
    expect(rig.issued).toHaveLength(2);
    expectNothingFiled(rig);
  });

  it.each([
    ['the gateway is down', true],
    ['the gateway is up', false],
  ])('is not asked for when the caller hung up: deadline (status 422), and no second request goes to the gateway when %s', async (_what, gatewayDown) => {
    const rig = makeRig({ deliverInMs: 900_000 });
    const controller = new AbortController();
    const decide: IntakeDeps['decide'] = async (input, ids) => {
      rig.gateway.advance(300_000);
      controller.abort();
      if (gatewayDown) rig.gateway.fault('/spiffe/jwt-svid', { status: 503, body: '{"error":"temporarily_unavailable"}' });
      return rig.deps.decide(input, ids);
    };
    expect(await refusalOf(() => rig.run({ signal: controller.signal, deps: { decide } }))).toMatchObject({ code: 'deadline', status: 422, message: 'The caller hung up, and the job stopped before it went on.' });
    expect(rig.events).toStrictEqual([...BEFORE_DECISION, 'decide']);
    expect(rig.gateway.requests.filter((call) => call.path === '/spiffe/jwt-svid')).toHaveLength(1);
    expectNothingFiled(rig);
  });

  it.each([
    ['the gateway is down', true],
    ['the gateway is up', false],
  ])('is not asked for when too little time is left for the filing: deadline (status 422), and no second request goes to the gateway when %s', async (_what, gatewayDown) => {
    const rig = makeRig({ deliverInMs: 340_000 });
    const decide: IntakeDeps['decide'] = async (input, ids) => {
      rig.gateway.advance(300_000);
      if (gatewayDown) rig.gateway.fault('/spiffe/jwt-svid', { status: 503, body: '{"error":"temporarily_unavailable"}' });
      return rig.deps.decide(input, ids);
    };
    expect(await refusalOf(() => rig.run({ deps: { decide } }))).toMatchObject({ code: 'deadline', status: 422, message: 'The job has too little time left to file the request.' });
    expect(rig.events).toStrictEqual([...BEFORE_DECISION, 'decide']);
    expect(rig.gateway.requests.filter((call) => call.path === '/spiffe/jwt-svid')).toHaveLength(1);
    expectNothingFiled(rig);
  });

  it('never reaches a log line, a refusal or the record: not the token, not the subject token, and not the key of the service', async () => {
    const rig = makeRig({ deliverInMs: 900_000 });
    const decide: IntakeDeps['decide'] = async (input, ids) => {
      rig.gateway.advance(300_000);
      return rig.deps.decide(input, ids);
    };
    const record = await rig.run({ deps: { decide } });
    expectNoSecrets(rig, [...rig.logs, JSON.stringify(record)]);
  });
});

describe('the log', () => {
  /** A job that ends one way or another: the logs that it wrote. */
  async function logsOf(run: (rig: Rig) => Promise<unknown>, options: RigOptions = {}): Promise<{ readonly rig: Rig; readonly lines: readonly string[] }> {
    const rig = makeRig(options);
    try {
      await run(rig);
    } catch {
      // A refusal is an end of the job too: only its log lines matter here.
    }
    return { rig, lines: rig.logs };
  }

  const throwing = async (): Promise<AttestationReport> => {
    throw new Error('MARKER-OF-THE-LEDGER');
  };
  interface End {
    readonly what: string;
    readonly run: (rig: Rig) => Promise<unknown>;
    readonly options?: RigOptions;
  }
  const ENDS: readonly End[] = [
    { what: 'a job that files the request', run: (rig) => rig.run() },
    { what: 'a job with no record of the hook', run: (rig) => { rig.kept.clear(); return rig.run(); } },
    { what: 'a gateway that gives no JWT-SVID', run: (rig) => { rig.gateway.fault('/spiffe/jwt-svid', { status: 503 }); return rig.run(); } },
    { what: 'a portal that fails the read of the requirements', run: (rig) => { rig.portal.requirements = json(500, { error: 'internal', message: 'MARKER-OF-THE-PORTAL' }); return rig.run(); } },
    { what: 'a report that throws', run: (rig) => rig.run({ deps: { report: throwing } }) },
    { what: 'a model hire that fails', run: (rig) => { rig.decision = failureOf('inference_failed', { reason: 'llm_timeout' }); return rig.run(); } },
    { what: 'a model that gives an unknown requirement id', run: (rig) => { rig.decision = accepted({ ...decisionOf(), choice: { complete: false, missing: ['R9'] } }); return rig.run(); } },
    { what: 'a portal that holds the number', run: (rig) => { rig.portal.prefile('run1-1'); return rig.run(); } },
    { what: 'a portal that fails the filing', run: (rig) => { rig.portal.filing = { throws: new Error('MARKER-OF-THE-NETWORK') }; return rig.run(); } },
    { what: 'an intake book that fails', run: (rig) => { rig.bookError = new Error('MARKER-OF-THE-DISK'); return rig.run(); } },
    { what: 'an escrow that is too near its deliver_by', run: (rig) => rig.run(), options: { deliverInMs: 20_000 } },
  ];

  it.each(ENDS)('has lines that name the escrow and the time, and hold no key, token, body of the portal or part of the request: $what', async ({ run, options }) => {
    const { rig, lines } = await logsOf(run, options);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line.startsWith('insurer intake: ')).toBe(true);
      expect(line).toMatch(/ \(escrow [0-9a-f]{64}#0, \d+ ms\)$/);
      expect(line).not.toContain('MARKER-OF');
      for (const value of REQUEST_TEXTS) expect(line).not.toContain(value);
    }
    expectNoSecrets(rig, lines);
  });
});

describe('the exports of the folder', () => {
  it('are the job, its steps and the refusal, and the types of its ports', () => {
    expect(Object.keys(exported).sort()).toStrictEqual(
      ['COMPLETENESS_NAME', 'INTAKE_REFUSAL_STATUS', 'IntakeRefusal', 'RUNTIME_MARGIN_MS', 'attestStep', 'completenessDecision', 'completenessInput', 'fetchSvid', 'fileRequest', 'readRequirements', 'runIntake', 'takeJob'].sort(),
    );
  });

  it('give the job that the rig runs', async () => {
    expect(exported.COMPLETENESS_NAME).toBe('completeness');
    expect(exported.RUNTIME_MARGIN_MS).toBe(30_000);
    expect(exported.INTAKE_REFUSAL_STATUS.duplicate_request).toBe(403);
    const rig = makeRig();
    expect(await exported.runIntake(rig.deps, rig.request, rig.context, rig.gateway.now())).toStrictEqual(golden('intake-record-complete.json'));
  });
});
