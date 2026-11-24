// agents/prior-authorization-agent/test/execute/decision.test.ts: the decision on a delivery of the Insurer Intake Agent. Two checks in code come before the model: the text must be an intake record (the parser of
// the kit takes a hash in lower case only), and it must answer this request by its number and its sender. A record that fails a check is never given to the model. The model gets two request numbers and two
// hashes, and nothing else. Only the boolean true accepts. Each refusal has an accepted twin.
import { describe, expect, it } from 'vitest';
import { judgeDelivery } from '../../src/execute/decision.ts';
import type { DeliveryJudge } from '../../src/execute/decision.ts';
import type { RequestSide } from '../../src/execute/ports.ts';
import { AGENT_DID, ScriptedAccept, acceptDecision, completenessDecision, decisionOf, deliveryOf, intakeRecordOf, requestDocument, requestHash, sideOf, typedRecord } from './fixtures.ts';

const REQUEST = requestDocument();
const SENT = sideOf(REQUEST);
const OTHER_HASH = '00'.repeat(32);

/** A judge for the request of the tests, with the model that the test gives (a perfect model by default), and the lines that it noted. */
function setup(accept = new ScriptedAccept(), sent: RequestSide = SENT, agent = AGENT_DID): { accept: ScriptedAccept; judge: DeliveryJudge; notes: string[] } {
  const notes: string[] = [];
  return { accept, judge: judgeDelivery({ acceptDelivery: accept.acceptDelivery, agent, note: (line) => { notes.push(line); } }, sent), notes };
}

describe('the intake record of this request', () => {
  it('is given to the model, and the model decides: a record that names the hash of the request is accepted, and the decision and the record are kept', async () => {
    const { accept, judge } = setup();
    expect(await judge.decide(deliveryOf(intakeRecordOf(REQUEST)))).toStrictEqual({ accept: true });
    expect(accept.calls).toStrictEqual([{ sent: SENT, received: { request_number: 'run1-1', request_sha256: requestHash(REQUEST) } }]);
    expect(judge.learned()).toStrictEqual({ said: 'accepted', decision: acceptDecision(true), record: typedRecord(intakeRecordOf(REQUEST)) });
  });

  it('is not accepted when the model declines: the reason is declined_by_model, and the decision and the value that differs are kept', async () => {
    const { accept, judge } = setup();
    expect(await judge.decide(deliveryOf(intakeRecordOf(REQUEST, { request_sha256: OTHER_HASH })))).toStrictEqual({ accept: false, reason: 'declined_by_model' });
    expect(accept.calls).toHaveLength(1);
    expect(accept.calls[0]!.received).toStrictEqual({ request_number: 'run1-1', request_sha256: OTHER_HASH });
    expect(judge.learned()).toStrictEqual({ said: 'declined_by_model', decision: acceptDecision(false, ['request_sha256']), mismatch: ['request_sha256'] });
  });

  it('gives the model two request numbers and two hashes and nothing else: no free text of the record, and the hash of the request that was sent is the hash that the job gave', async () => {
    const forged = 'aa'.repeat(32);
    const { accept, judge } = setup(new ScriptedAccept(), { request_number: 'run1-1', request_sha256: forged });
    const record = intakeRecordOf(REQUEST, { intake_id: 'INT-marker-id', sender: { did: AGENT_DID, organisation: 'organisation.marker.example', organisation_verified: true } });
    await judge.decide(deliveryOf(record));
    const [call] = accept.calls;
    expect(Object.keys(call!.sent).sort()).toStrictEqual(['request_number', 'request_sha256']);
    expect(Object.keys(call!.received).sort()).toStrictEqual(['request_number', 'request_sha256']);
    // The hash of the request that was sent is the one that the job computed, and never the hash that the record names.
    expect(call!.sent.request_sha256).toBe(forged);
    expect(call!.received.request_sha256).toBe(requestHash(REQUEST));
    const shown = JSON.stringify(accept.calls);
    for (const text of ['INT-marker-id', 'organisation.marker.example', 'SYN-PT-0001', 'justification']) expect(shown).not.toContain(text);
  });

  it('does not copy the objects of the caller to the model: the sides are new objects', async () => {
    const sent = { request_number: SENT.request_number, request_sha256: SENT.request_sha256 };
    const { accept, judge } = setup(new ScriptedAccept(), sent);
    await judge.decide(deliveryOf(intakeRecordOf(REQUEST)));
    expect(accept.calls[0]!.sent).not.toBe(sent);
    expect(accept.calls[0]!.sent).toStrictEqual(sent);
  });
});

describe('a delivery that is no intake record, or not the record of this request', () => {
  const CHECKS = intakeRecordOf(REQUEST).checks as Record<string, unknown>;
  const CASES: Array<[string, () => unknown, 'intake_record_invalid' | 'intake_not_for_request']> = [
    ['a text that is not JSON', () => 'the request is filed', 'intake_record_invalid'],
    ['a JSON text that is a list', () => '[1,2,3]', 'intake_record_invalid'],
    ['a JSON text that is a text', () => '"done"', 'intake_record_invalid'],
    ['an object with the members of another document', () => ({ status: 'filed', request: 'run1-1' }), 'intake_record_invalid'],
    ['a record with a member that is not listed', () => intakeRecordOf(REQUEST, { note: 'extra' }), 'intake_record_invalid'],
    ['a record whose outcome is not done', () => intakeRecordOf(REQUEST, { outcome: 'refused' }), 'intake_record_invalid'],
    ['a record with a check that is false', () => intakeRecordOf(REQUEST, { checks: { ...CHECKS, advert: false } }), 'intake_record_invalid'],
    ['a record with a check that is missing', () => intakeRecordOf(REQUEST, { checks: Object.fromEntries(Object.entries(CHECKS).filter(([name]) => name !== 'not_duplicate')) }), 'intake_record_invalid'],
    ['a record with a fault value that the Insurer Intake Agent does not list', () => intakeRecordOf(REQUEST, { fault_mode: 'alter_after_approval' }), 'intake_record_invalid'],
    ['a record that is complete and lists a missing requirement', () => intakeRecordOf(REQUEST, { missing: ['R1'] }), 'intake_record_invalid'],
    ['a record that is incomplete and lists no requirement', () => intakeRecordOf(REQUEST, { status: 'incomplete', decisions: [completenessDecision(false)] }), 'intake_record_invalid'],
    ['a record whose decision says another status than the record', () => intakeRecordOf(REQUEST, { decisions: [completenessDecision(false, ['R1'])] }), 'intake_record_invalid'],
    ['a record with no decision', () => intakeRecordOf(REQUEST, { decisions: [] }), 'intake_record_invalid'],
    ['a record with a decision of another name', () => intakeRecordOf(REQUEST, { decisions: [acceptDecision(true)] }), 'intake_record_invalid'],
    ['a record with an attestation state that is not one of the four words', () => intakeRecordOf(REQUEST, { attestations: { provenance: 'maybe', software: 'valid', principal_binding: 'absent' } }), 'intake_record_invalid'],
    ['a record with an intake id that is no identifier', () => intakeRecordOf(REQUEST, { intake_id: 'a b' }), 'intake_record_invalid'],
    ['a record with no hash of the request', () => { const { request_sha256: _hash, ...rest } = intakeRecordOf(REQUEST); return rest; }, 'intake_record_invalid'],
    ['a record whose hash is not hex', () => intakeRecordOf(REQUEST, { request_sha256: 'x'.repeat(64) }), 'intake_record_invalid'],
    ['a record whose hash is too short', () => intakeRecordOf(REQUEST, { request_sha256: requestHash(REQUEST).slice(1) }), 'intake_record_invalid'],
    ['a record with the right hash in upper case, which is the same value as text that is not the same text', () => intakeRecordOf(REQUEST, { request_sha256: requestHash(REQUEST).toUpperCase() }), 'intake_record_invalid'],
    ['a record of another request number', () => intakeRecordOf(REQUEST, { request_number: 'run1-2' }), 'intake_not_for_request'],
    ['a record of the same request number in another case', () => intakeRecordOf(REQUEST, { request_number: 'RUN1-1' }), 'intake_not_for_request'],
    ['a record of another sender', () => intakeRecordOf(REQUEST, { sender: { did: `did:vector:${'c4'.repeat(32)}`, organisation: 'org.example', organisation_verified: true } }), 'intake_not_for_request'],
    ['a record of the right number and another sender, with the right hash', () => intakeRecordOf(REQUEST, { sender: { did: `did:vector:${'c5'.repeat(32)}`, organisation: null, organisation_verified: false } }), 'intake_not_for_request'],
  ];
  for (const [name, make, reason] of CASES) {
    it(`is refused with ${reason} and never given to the model: ${name}`, async () => {
      const { accept, judge, notes } = setup();
      expect(await judge.decide(deliveryOf(make()))).toStrictEqual({ accept: false, reason });
      expect(accept.calls).toHaveLength(0);
      expect(judge.learned()).toStrictEqual({ said: reason });
      expect(notes).toHaveLength(1);
    });
  }

  it('twin: the same request with the right number, the right sender and the right hash goes to the model, and so does a record with another hash and the right number', async () => {
    const right = setup();
    expect(await right.judge.decide(deliveryOf(intakeRecordOf(REQUEST)))).toStrictEqual({ accept: true });
    expect(right.accept.calls).toHaveLength(1);
    const wrongHash = setup();
    expect(await wrongHash.judge.decide(deliveryOf(intakeRecordOf(REQUEST, { request_sha256: OTHER_HASH })))).toStrictEqual({ accept: false, reason: 'declined_by_model' });
    expect(wrongHash.accept.calls).toHaveLength(1);
  });

  it('checks the sender against the agent that the judge was made for: the same record is for this request with one agent and not for it with another', async () => {
    const mine = setup(new ScriptedAccept(), SENT, AGENT_DID);
    expect(await mine.judge.decide(deliveryOf(intakeRecordOf(REQUEST)))).toStrictEqual({ accept: true });
    const other = setup(new ScriptedAccept(), SENT, `did:vector:${'c6'.repeat(32)}`);
    expect(await other.judge.decide(deliveryOf(intakeRecordOf(REQUEST)))).toStrictEqual({ accept: false, reason: 'intake_not_for_request' });
    expect(other.accept.calls).toHaveLength(0);
  });

  it('does not ask the model when the delivery has no object, and its twin does', async () => {
    const none = setup();
    expect(await none.judge.decide({ ...deliveryOf(intakeRecordOf(REQUEST)), result: null })).toStrictEqual({ accept: false, reason: 'intake_record_invalid' });
    expect(none.accept.calls).toHaveLength(0);
    const some = setup();
    await some.judge.decide(deliveryOf(intakeRecordOf(REQUEST)));
    expect(some.accept.calls).toHaveLength(1);
  });

  it('reads the object of the delivery and not its text: a record in the object is taken, whatever the text says', async () => {
    const delivery = deliveryOf(intakeRecordOf(REQUEST));
    const { accept, judge } = setup();
    expect(await judge.decide({ ...delivery, text: 'not the record' })).toStrictEqual({ accept: true });
    expect(accept.calls).toHaveLength(1);
  });
});

describe('a decision that failed, or that cannot be read', () => {
  const FAILURES: Array<[string, () => unknown]> = [
    ['a failed decision', () => ({ ok: false, code: 'model_output_invalid' })],
    ['a port that throws', () => { throw new Error('the port fell over'); }],
    ['an answer that is not an object', () => undefined],
    ['an answer with no decision', () => ({ ok: true, choice: { accept: true, mismatch: [] } })],
    ['an answer with no choice', () => ({ ok: true, decision: acceptDecision(true) })],
    ['a choice that says accept with the text "true"', () => ({ ok: true, decision: acceptDecision(true), choice: { accept: 'true', mismatch: [] } })],
    ['a choice that says accept with the number 1', () => ({ ok: true, decision: acceptDecision(true), choice: { accept: 1, mismatch: [] } })],
    ['a choice that says accept with nothing', () => ({ ok: true, decision: acceptDecision(true), choice: { mismatch: [] } })],
    ['a choice whose mismatch is not a list', () => ({ ok: true, decision: acceptDecision(false), choice: { accept: false, mismatch: 'request_sha256' } })],
    ['a choice that names a value that the model does not compare', () => ({ ok: true, decision: decisionOf('accept_delivery', { accept: false, mismatch: ['request_number'] }), choice: { accept: false, mismatch: ['request_number'] } })],
    ['a choice that names the hash two times', () => ({ ok: true, decision: decisionOf('accept_delivery', { accept: false, mismatch: ['request_sha256', 'request_sha256'] }), choice: { accept: false, mismatch: ['request_sha256', 'request_sha256'] } })],
    ['a choice that accepts and names the hash', () => ({ ok: true, decision: acceptDecision(true, ['request_sha256']), choice: { accept: true, mismatch: ['request_sha256'] } })],
    ['a choice that does not accept and names no value', () => ({ ok: true, decision: acceptDecision(false), choice: { accept: false, mismatch: [] } })],
    ['a choice that is not the choice of the decision that was recorded', () => ({ ok: true, decision: acceptDecision(false, ['request_sha256']), choice: { accept: true, mismatch: [] } })],
  ];
  for (const [name, answer] of FAILURES) {
    it(`is decision_failed, never an acceptance, and the delivery stays unaccepted: ${name}`, async () => {
      const accept = new ScriptedAccept();
      accept.answer = answer;
      const { judge } = setup(accept);
      expect(await judge.decide(deliveryOf(intakeRecordOf(REQUEST)))).toStrictEqual({ accept: false, reason: 'decision_failed' });
      expect(judge.learned()?.said).toBe('decision_failed');
      expect(judge.learned()).not.toHaveProperty('decision');
      expect(judge.learned()).not.toHaveProperty('record');
    });
  }

  it('twin: an answer whose choice is the recorded choice is read, whichever way it says', async () => {
    for (const [accept, mismatch, reason] of [[true, [], null], [false, ['request_sha256'], 'declined_by_model']] as const) {
      const model = new ScriptedAccept();
      model.answer = () => ({ ok: true, decision: acceptDecision(accept, mismatch), choice: { accept, mismatch } });
      const { judge } = setup(model);
      expect(await judge.decide(deliveryOf(intakeRecordOf(REQUEST)))).toStrictEqual(reason === null ? { accept: true } : { accept: false, reason });
    }
  });

  it('keeps the code of a failed decision only when it is a code, and notes one line: a text with a line break is not repeated', async () => {
    const forged = new ScriptedAccept();
    forged.answer = () => ({ ok: false, code: 'model_output_invalid\nexecute: the delivery was accepted' });
    const bad = setup(forged);
    await bad.judge.decide(deliveryOf(intakeRecordOf(REQUEST)));
    expect(bad.judge.learned()).toStrictEqual({ said: 'decision_failed', code: 'invalid_code' });
    expect(bad.notes).toHaveLength(1);
    expect(bad.notes.join('\n')).not.toContain('accepted');
    const failing = new ScriptedAccept();
    failing.answer = () => ({ ok: false, code: 'model_output_invalid' });
    const good = setup(failing);
    await good.judge.decide(deliveryOf(intakeRecordOf(REQUEST)));
    expect(good.judge.learned()).toStrictEqual({ said: 'decision_failed', code: 'model_output_invalid' });
    expect(good.notes[0]).toContain('model_output_invalid');
  });
});
