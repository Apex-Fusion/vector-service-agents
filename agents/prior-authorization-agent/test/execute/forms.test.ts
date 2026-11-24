// agents/prior-authorization-agent/test/execute/forms.test.ts: the result forms of the job `execute` that come from the payment and from the Insurer Intake Agent. A hire that is paid and accepted writes the submission
// once. Every other end is a typed result, and none of them writes the submission. The exit state of each result is the state that `exitStateOf` gives. Each form has its twin.
import { afterEach, describe, expect, it } from 'vitest';
import { TxNotConfirmedError } from '@vsa/buyer-core';
import { COUNTERPARTY_REFUSALS, exitStateOf } from '@vsa/usecase-kit/protocol';
import type { KeyObject } from 'node:crypto';
import { canonicalize } from '@vsa/vector-read';
import { AGENT_ADVERT_REF, APPROVAL, INSURER_DID, SALT, acceptDecision, completenessDecision, golden, requestDocument } from './fixtures.ts';
import { DELEGATION, LIMIT, NOTHING, T0, cleanWorlds, footprint, handoffSent, hireOf, inFrontOfPolls, jsonResponse, words, world } from './world.ts';

afterEach(() => { cleanWorlds(); });

/** The evaluation error that the FakeChain gives for a Pay that the vault script refuses: the text of the answer 3010 of the node. */
const EVALUATION_ERROR = '3010 Some scripts of the transactions terminated with error(s).';

/** The 32 bytes of the key, in hex: what no result and no log line may hold. */
function rawKeyHexOf(key: KeyObject): string {
  const der = key.export({ format: 'der', type: 'pkcs8' });
  return der.subarray(der.length - 32).toString('hex');
}

describe('a hire that is paid, accepted and recorded', () => {
  it('pays the advert of the request from the vault, accepts the delivery, writes the submission once, and says completed', async () => {
    const w = await world();
    const request = w.request();
    const result = await w.run(request);
    expect(words(result)).toBe('completed none Completed');
    expect(result).toMatchObject({ schema: 'vector.usecase.result.v1', use_case: 'prior-authorization', proposal_digest: request.proposal.proposal_digest, challenge: null, fault_mode: '' });
    expect(result.exit_state).toBe(exitStateOf({ outcome: 'completed', reason: null, challenge_filed: false, delegation_ended: false }));
    expect(result.writes).toStrictEqual([{ system: 'records', route: 'POST /records/orders/{order_id}/submission', status: 201, ref: 'SUB-run1-0001' }]);
    expect(result.decisions).toStrictEqual([acceptDecision(true)]);
    expect(hireOf(result)).toMatchObject({
      counterparty_did: INSURER_DID, advert_ref: AGENT_ADVERT_REF, paid_from_vault: true, accepted: 'confirmed', result: JSON.parse(w.recordFor(w.document())),
    });
    expect(footprint(w)).toStrictEqual({ paid: 1, sends: 1, writes: 1, challenges: 0, asked: 1 });
    expect(w.booked).toStrictEqual({ posted: 1, accepted: 1 });
    expect(await w.m.chain.escrowState(hireOf(result).escrow_ref)).toBe('spent');
    // The key that the delegation names paid, from the one vault of the delegation.
    expect([w.a.pays, w.b.pays]).toStrictEqual([[w.vault], []]);
  });

  it('writes the number of the request, the id of the intake and the status of the record to the records system of its tenant, for its order, with a token for the route priorauth.submit that the delegation key asked for', async () => {
    const w = await world();
    await w.run();
    const [call] = w.store.calls;
    expect([call?.method, call?.url]).toStrictEqual(['POST', 'https://mock.example/t/run1/records/orders/ORD-1001/submission']);
    expect(JSON.parse(call?.body ?? '')).toStrictEqual(golden('submission-body.json'));
    expect(call?.headers.authorization).toMatch(/^DPoP /);
    expect(call?.headers.dpop).toBeTypeOf('string');
    expect(call?.headers['content-type']).toBe('application/json');
    expect(w.tokens).toHaveLength(1);
    const asked = w.tokens[0]!;
    expect(asked.answer.ok).toBe(true);
    expect(asked.request.subject.did).toBe(w.agent.did);
    expect(asked.request.resource).toBe(w.records.resource);
    expect(asked.request.delegation).toStrictEqual({ identifier: DELEGATION, actions: ['priorauth.submit'], locations: [w.records.resource] });
  });

  it('takes the body of the submission from the intake record that the model judged: its intake id and its status, whichever they are', async () => {
    const incomplete = await world();
    incomplete.answer({ status: 'incomplete', missing: ['R1', 'R3'], intake_id: 'INT-run1-0042', decisions: [completenessDecision(false, ['R1', 'R3'])] });
    const result = await incomplete.run();
    expect(words(result)).toBe('completed none Completed');
    expect(JSON.parse(incomplete.store.calls[0]!.body)).toStrictEqual({ request_number: 'run1-1', intake_id: 'INT-run1-0042', status: 'incomplete' });
    // The twin: a complete record gives the status complete.
    const complete = await world();
    complete.answer({ intake_id: 'INT-run1-0043' });
    await complete.run();
    expect(JSON.parse(complete.store.calls[0]!.body)).toStrictEqual({ request_number: 'run1-1', intake_id: 'INT-run1-0043', status: 'complete' });
  });

  it('sends the handoff as the request gave it: the document, the salt, the delegation, its own DID as the sender, and the approval', async () => {
    const w = await world();
    await w.run();
    expect(handoffSent(w)).toStrictEqual({
      schema: 'vector.usecase.handoff.v1', use_case: 'prior-authorization', sender_did: w.agent.did, delegation: DELEGATION, document: w.document(), salt: SALT, approval: APPROVAL,
    });
  });

  it('passes a null approval on, and goes on: the Insurer Intake Agent refuses it, and this agent does not judge it', async () => {
    const w = await world();
    const result = await w.run(w.request(w.document(), null));
    expect(words(result)).toBe('completed none Completed');
    expect(handoffSent(w)).toMatchObject({ approval: null, salt: SALT });
  });

  it('puts no key, token or proof in the result or in the log, and no text of the request or of the record in the log', async () => {
    const justification = 'Marker sentence one of the synthetic justification. Marker sentence two of the synthetic justification.';
    const w = await world();
    const document = w.document({ justification });
    w.answer(w.recordFor(document, { intake_id: 'INT-marker-id', sender: { did: w.agent.did, organisation: 'organisation.marker.example', organisation_verified: true } }));
    const result = await w.run(w.request(document));
    expect(words(result)).toBe('completed none Completed');
    const call = w.store.calls[0]!;
    const issued = w.tokens[0]!.answer;
    const secrets = [
      issued.ok ? issued.value.accessToken : 'no token was issued', call.headers.authorization!, call.headers.dpop!, call.headers.authorization!.slice('DPoP '.length),
      rawKeyHexOf(w.agent.authentication.privateKey), rawKeyHexOf(w.a.testKey.privateKey), rawKeyHexOf(w.b.testKey.privateKey),
    ];
    const written = `${JSON.stringify(result)}\n${w.log.join('\n')}`;
    for (const secret of secrets) expect(written).not.toContain(secret);
    for (const text of ['Marker sentence', 'INT-marker-id', 'organisation.marker.example', 'SYN-PT-0001']) expect(w.log.join('\n')).not.toContain(text);
    expect(w.log.length).toBeGreaterThan(0);
  });

  it('keeps the submission written and says completed when the ledger cannot book the fee of the Accept: the Accept is on the chain, and the log names its hash and its fee', async () => {
    const w = await world();
    const deps = { ...w.deps, hire: { ...w.deps.hire, ledger: { posted: w.deps.hire.ledger.posted, accepted: () => { throw new Error('the ledger is closed'); } } } };
    const result = await w.run(w.request(), T0, deps);
    expect(words(result)).toBe('completed none Completed');
    expect(footprint(w).writes).toBe(1);
    const line = w.log.find((entry) => entry.includes('did not book the fee'));
    expect(line).toMatch(/accept transaction [0-9a-f]{64}, fee [0-9]+ lovelace/);
    expect(line).not.toContain('closed');
  });
});

describe('a Pay that the vault refuses', () => {
  it('is vault_refused for a Pay of 4 units against a per_tx of 3, with the evaluation error of the node as its reason, and nothing is paid, sent, written or asked: the vault output is still live', async () => {
    const tight = await world({ limit: { ...LIMIT, perTx: 3_000_000n } });
    const result = await tight.run();
    expect(result).toMatchObject({ outcome: 'vault_refused', reason: EVALUATION_ERROR, challenge: null, exit_state: 'Failed', handoff: null, writes: [], decisions: [] });
    expect(footprint(tight)).toStrictEqual(NOTHING);
    expect(tight.booked).toStrictEqual({ posted: 0, accepted: 0 });
    expect(tight.m.chain.vault(tight.vault)).toMatchObject({ kind: 'Live', consumed: false });
    // The twin: a per_tx that is exactly the Pay lets it through.
    const exact = await world({ limit: { ...LIMIT, perTx: 4_000_000n } });
    expect(words(await exact.run())).toBe('completed none Completed');
  });

  it('puts the draft of the refused Pay in the log, and never in the result', async () => {
    const w = await world({ limit: { ...LIMIT, perTx: 3_000_000n } });
    const result = await w.run();
    const line = w.log.find((entry) => entry.includes('the draft of the Pay that the vault refused'));
    const draft = line?.split(': ').pop() ?? '';
    expect(draft).toMatch(/^[0-9a-f]{40,}$/);
    expect(JSON.stringify(result)).not.toContain(draft);
    // The line before it says why the vault refused.
    expect(w.log.some((entry) => entry.includes('the vault refused the Pay (ledger)') && entry.includes(EVALUATION_ERROR))).toBe(true);
  });

  it('is vault_refused when the total of the period is spent: the same approved request, run again after one that was paid', async () => {
    const w = await world();
    const request = w.request();
    expect(words(await w.run(request))).toBe('completed none Completed');
    const again = await w.run(request);
    expect(again).toMatchObject({ outcome: 'vault_refused', reason: EVALUATION_ERROR, challenge: null, exit_state: 'Failed', handoff: null, writes: [], decisions: [] });
    // Nothing more was paid, sent, written or asked for the second run.
    expect(footprint(w)).toStrictEqual({ paid: 1, sends: 1, writes: 1, challenges: 0, asked: 1 });
  });

  it('is Cancelled when the hirer ended the delegation, and Failed when the delegation stands', async () => {
    const ended = await world();
    ended.endDelegation();
    const result = await ended.run();
    expect(result).toMatchObject({ outcome: 'vault_refused', reason: 'no_delegation', exit_state: 'Cancelled', handoff: null, challenge: null });
    expect(result.exit_state).toBe(exitStateOf({ outcome: 'vault_refused', reason: 'no_delegation', challenge_filed: false, delegation_ended: true }));
    expect(footprint(ended)).toStrictEqual(NOTHING);
    // The twin: a vault too small to pay, under a delegation that stands.
    const small = await world({ vault: false });
    small.m.chain.openVault({ delegation: DELEGATION, lovelace: 1_300_000n, limit: LIMIT });
    const stood = await small.run();
    expect(stood).toMatchObject({ outcome: 'vault_refused', reason: 'below_minimum', exit_state: 'Failed' });
    expect(stood.exit_state).toBe(exitStateOf({ outcome: 'vault_refused', reason: 'below_minimum', challenge_filed: false, delegation_ended: false }));
    expect(footprint(small)).toStrictEqual(NOTHING);
  });
});

describe('an Insurer Intake Agent that refuses', () => {
  const STATES: Readonly<Record<string, string>> = { approval_digest_mismatch: 'Escalated', approval_expired: 'Expired', delegation_ended: 'Cancelled' };

  for (const code of COUNTERPARTY_REFUSALS['insurer-intake-agent']) {
    it(`is refused_by_counterparty with ${code} when it refuses before its Claim: the escrow stays Open, and the model is not asked`, async () => {
      const w = await world();
      w.m.agent.refuse = { status: 403, code, message: 'words of the Insurer Intake Agent that never reach the result' };
      const result = await w.run();
      expect(result).toMatchObject({ outcome: 'refused_by_counterparty', reason: code, challenge: null, writes: [], decisions: [] });
      expect(result.exit_state).toBe(STATES[code] ?? 'Rejected');
      expect(result.exit_state).toBe(exitStateOf({ outcome: 'refused_by_counterparty', reason: code, challenge_filed: false, delegation_ended: false }));
      expect(hireOf(result)).toMatchObject({ paid_from_vault: true, accepted: null, receipt: null, result: null });
      expect(await w.m.chain.escrowState(hireOf(result).escrow_ref)).toBe('Open');
      expect(footprint(w)).toStrictEqual({ paid: 1, sends: 1, writes: 0, challenges: 0, asked: 0 });
      expect(JSON.stringify(result)).not.toContain('words of the Insurer Intake Agent');
    });
  }

  /** The runtime copies the answer of the service into the failure of the job: the reason `service_http_<status>`, and the message with the start of the answer. */
  const failureWith = (message: string) => (reached: Response): Response | undefined => (reached.status === 502 ? jsonResponse(502, { status: 'failed', reason: 'service_http_403', message }) : undefined);

  it('is a failure, and not a refusal, when the job fails after its Claim with a code of a refusal: the Insurer Intake Agent has no refusal after its Claim, and the escrow is Claimed', async () => {
    for (const [code, reason] of [['duplicate_request', 'failed'], ['cannot_supply', 'cannot_supply']] as const) {
      const w = await world();
      w.m.agent.steps = ['running', { fail: 'service_http_403', submitted: false }];
      const deps = { ...w.deps, hire: { ...w.deps.hire, fetchImpl: inFrontOfPolls(w.m, failureWith(`service returned HTTP 403: {"error":"${code}","message":"seen"}`)) } };
      const result = await w.run(w.request(), T0, deps);
      expect(words(result), code).toBe(`failed ${reason} Failed`);
      expect(await w.m.chain.escrowState(hireOf(result).escrow_ref), code).toBe('Claimed');
      expect(footprint(w), code).toStrictEqual({ paid: 1, sends: 1, writes: 0, challenges: 0, asked: 0 });
    }
  });

  it('is a failure when the Insurer Intake Agent fails its job with no code of its own: failed with the reason of the hire kit, and the escrow is Claimed', async () => {
    const w = await world();
    w.m.agent.steps = ['running', { fail: 'upstream_failure', submitted: false }];
    const result = await w.run();
    expect(words(result)).toBe('failed failed Failed');
    expect(hireOf(result)).toMatchObject({ paid_from_vault: true, accepted: null, receipt: null });
    expect(footprint(w)).toStrictEqual({ paid: 1, sends: 1, writes: 0, challenges: 0, asked: 0 });
  });
});

describe('a hire that ends in an error after the Pay', () => {
  it('is failed with pay_unconfirmed when the Pay was sent and not seen confirmed: the record names the escrow, and no model is asked and nothing is written', async () => {
    const w = await world();
    w.payFailure.error = new TxNotConfirmedError('the Pay was sent and was not seen confirmed', { txHash: 'ab'.repeat(32), escrowRef: `${'cd'.repeat(32)}#0`, deliverBy: null, validTo: T0 + 600_000, mayLand: true });
    const result = await w.run();
    expect(words(result)).toBe('failed pay_unconfirmed Failed');
    expect(result).toMatchObject({ challenge: null, writes: [], decisions: [] });
    expect(hireOf(result)).toMatchObject({ escrow_ref: `${'cd'.repeat(32)}#0`, accepted: null, receipt: null });
    expect(footprint(w)).toStrictEqual({ paid: 0, sends: 0, writes: 0, challenges: 0, asked: 0 });
    expect(w.log.some((line) => line.includes('may land true until'))).toBe(true);
    // The hire kit starts no other Pay of this key while the first may land: the same request again is failed, and nothing is paid.
    w.payFailure.error = null;
    expect(words(await w.run())).toBe('failed earlier_pay_may_land Failed');
    expect(footprint(w).paid).toBe(0);
    // The twin: a Pay that is confirmed goes on.
    expect(words(await (await world()).run())).toBe('completed none Completed');
  });

  it('is failed with hire_interrupted when the ledger of the caller cannot book the lock of the Pay: the Pay is made, nothing is sent, accepted or written, and the model is not asked', async () => {
    const w = await world();
    const deps = { ...w.deps, hire: { ...w.deps.hire, ledger: { posted: () => { throw new Error('the ledger is closed'); }, accepted: w.deps.hire.ledger.accepted } } };
    const result = await w.run(w.request(), T0, deps);
    expect(words(result)).toBe('failed hire_interrupted Failed');
    expect(result).toMatchObject({ challenge: null, writes: [], decisions: [] });
    expect(hireOf(result)).toMatchObject({ paid_from_vault: true, accepted: null, receipt: null, result: null });
    expect(footprint(w)).toStrictEqual({ paid: 1, sends: 0, writes: 0, challenges: 0, asked: 0 });
    expect(w.booked.accepted).toBe(0);
    expect(w.log.join('\n')).not.toContain('closed');
  });
});

describe('the request that the job sends', () => {
  it('is the request document that the hirer approved, byte for byte, when the setting of the fault is empty', async () => {
    const w = await world();
    const request = w.request(requestDocument());
    await w.run(request);
    const sent = handoffSent(w);
    expect(sent.document).toStrictEqual(request.proposal.document);
    expect(canonicalize(sent.document)).toBe(canonicalize(request.proposal.document));
    expect(sent.document).toStrictEqual(golden('request.json'));
  });
});
