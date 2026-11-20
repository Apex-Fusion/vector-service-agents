// packages/usecase-kit/test/buyer/hire.test.ts: the hire of a counterparty from the vault, against the in-memory marketplace of the hire kit: a FakeChain with a vault under a delegation, and a template
// supplier behind one fetch. Each way that a hire can end has a test, and each refusal has an accepted twin. The question of these tests is whether a payment that was refused or that failed is
// ever reported as success. Only a verified delivery that the decision accepted is `completed`.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TxNotConfirmedError } from '@vsa/buyer-core';
import { DECISION_WINDOW_MS } from '@vsa/hire-kit';
import { AGENT_ANSWER, INDEXER } from '@vsa/hire-kit/testing';
import { ERROR_STATUS, parseHandoff } from '@vsa/usecase-kit/protocol';
import { completedResult, requestText, settledResult } from '@vsa/usecase-kit/buyer';
import type { DeliveryDecision, HireStep } from '@vsa/usecase-kit/buyer';
import {
  AGENT_ADVERT_REF, COUNTERPARTY_DID, T0, cleanWorlds, expectKind, go, handoffFor, inFrontOfPolls, inFrontOfSends, jsonResponse, page, pieces, purchaseOrder, untouched, words, world,
} from './support.ts';

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); cleanWorlds(); });

/** The escrow that the one Pay of a world opened: the first output of the one transaction that spent the first vault. */
const escrowOf = (step: HireStep): string => {
  if (!('handoff' in step) || step.handoff === null) throw new Error(`the step ${words(step)} has no record`);
  return step.handoff.escrow_ref;
};

describe('a hire that completes', () => {
  it('pays from the vault, sends the handoff, checks the receipt, asks the decision, accepts, and says completed with the record of the hire', async () => {
    const w = await world();
    const step = expectKind(await go(w), 'completed');
    expect(step.handoff).toMatchObject({
      counterparty_did: COUNTERPARTY_DID, advert_ref: AGENT_ADVERT_REF, paid_from_vault: true, accepted: 'confirmed', result: JSON.parse(AGENT_ANSWER),
      verification: { escrow_ref_matches: true, response_hash_matches: true, supplier_key_matches: true, signature_valid: true, on_chain_hash_matches: true, prompt_hash_matches: true, model_matches: true, fields_match: true },
    });
    expect(step.handoff.receipt).toMatchObject({ escrow_ref: step.handoff.escrow_ref });
    expect(typeof step.handoff.receipt_signature).toBe('string');
    // The Pay spent the vault that was read, and it left the vault that continues. The escrow is the first output of the same transaction and it was accepted.
    expect(w.m.chain.vault(w.vault)).toMatchObject({ kind: 'Live', consumed: true });
    expect(step.vault_ref).not.toBe(w.vault);
    expect(w.m.chain.vault(step.vault_ref ?? '')).toMatchObject({ kind: 'Live', consumed: false, delegation: 'dd'.repeat(32) });
    expect(step.handoff.escrow_ref).toBe(`${(step.vault_ref ?? '').split('#')[0]}#0`);
    expect(await w.m.chain.escrowState(step.handoff.escrow_ref)).toBe('spent');
    expect(w.booked.posted).toHaveLength(1);
    expect(w.booked.accepted).toHaveLength(1);
    expect(step.delivery).toMatchObject({ escrow_ref: step.handoff.escrow_ref, text: AGENT_ANSWER, result: JSON.parse(AGENT_ANSWER) });
    // The result of the protocol for the step: Completed.
    expect(completedResult(pieces({ handoff: step.handoff }))).toMatchObject({ outcome: 'completed', reason: null, challenge: null, exit_state: 'Completed' });
  });

  it('sends the one handoff that the hirer approved, as the wire payload of its canonical text, and asks the chain for the advert, never the indexer', async () => {
    const w = await world();
    const message = handoffFor();
    expect(words(await go(w, { message }))).toBe('completed');
    expect(w.m.agent.sends).toHaveLength(1);
    const [send] = w.m.agent.sends;
    const wire = JSON.parse(send!.payload) as Array<{ content: string; role: string }>;
    expect(wire).toHaveLength(1);
    expect(wire[0]!.role).toBe('user');
    expect(wire[0]!.content).toBe(requestText(message));
    expect(parseHandoff(JSON.parse(wire[0]!.content))).toStrictEqual({ ok: true, value: message });
    expect(w.m.calls.filter((call) => call.url.startsWith(INDEXER))).toStrictEqual([]);
    // The advert of the escrow is the advert that the document names.
    const escrow = w.m.chain.escrowDatum(send!.escrowRef);
    expect(`${escrow?.advert_ref.txHash}#${escrow?.advert_ref.index}`).toBe(AGENT_ADVERT_REF);
  });

  it('passes a null approval on and hires all the same: the agent does not check the approval, and the counterparty refuses it', async () => {
    const w = await world();
    const message = handoffFor(purchaseOrder(), null);
    expect(words(await go(w, { message }))).toBe('completed');
    const wire = JSON.parse(w.m.agent.sends[0]!.payload) as Array<{ content: string }>;
    expect(JSON.parse(wire[0]!.content)).toMatchObject({ approval: null });
    // The counterparty that refuses a null approval is the one that answers, and the flow reports its code.
    const refusing = await world();
    refusing.m.agent.refuse = { status: 403, code: 'approval_not_found' };
    expect(words(await go(refusing, { message }))).toBe('refused_by_counterparty before_claim approval_not_found');
  });

  it('hires for the second use case as well, from a handoff of the prior-authorization use case', async () => {
    const w = await world();
    const document = { schema: 'vector.usecase.priorauth-request.v1', request_number: 'run1-0001', insurer_did: COUNTERPARTY_DID, advert_ref: AGENT_ADVERT_REF };
    const base = handoffFor(document);
    expect(words(await go(w, { message: { ...base, use_case: 'prior-authorization' } }))).toBe('completed');
  });

  it('gives the decision a copy: a decision that changes what it was given changes nothing in the record', async () => {
    const w = await world();
    const decide: DeliveryDecision = (delivery) => {
      if (delivery.result !== null) (delivery.result as Record<string, unknown>).quantity = 9_999;
      (delivery.receipt as Record<string, unknown>).model = 'another-model';
      (delivery.verification as unknown as Record<string, boolean>).model_matches = false;
      return { accept: true };
    };
    const step = expectKind(await go(w, { decide }), 'completed');
    expect(step.handoff.result).toStrictEqual(JSON.parse(AGENT_ANSWER));
    expect(step.handoff.receipt).not.toMatchObject({ model: 'another-model' });
    expect(step.handoff.verification?.model_matches).toBe(true);
    expect(step.delivery.result).toStrictEqual(JSON.parse(AGENT_ANSWER));
  });

  it('gives the decision the verified delivery: the escrow, the advert, the text, the answer as an object, the receipt and the eight checks', async () => {
    const w = await world();
    const seen: unknown[] = [];
    expect(words(await go(w, { decide: (delivery) => { seen.push(delivery); return { accept: true }; } }))).toBe('completed');
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ advert_ref: AGENT_ADVERT_REF, text: AGENT_ANSWER, result: JSON.parse(AGENT_ANSWER), verification: { fields_match: true, signature_valid: true } });
  });

  it('gives a null answer object when the text of the counterparty is not a JSON object: the decision can refuse it', async () => {
    const w = await world();
    w.m.agent.answer = 'The lot is confirmed.';
    const seen: unknown[] = [];
    const step = await go(w, { decide: (delivery) => { seen.push(delivery.result); return { accept: false, reason: 'the answer is not a confirmation' }; } });
    expect(seen).toStrictEqual([null]);
    expect(words(step)).toBe('not_accepted declined');
  });
});

describe('a hire that the counterparty refuses before its Claim', () => {
  const STATUSES: Array<[number, string, string]> = [
    [400, 'bad_shape', 'bad_shape'], [401, 'unauthorized', 'unauthorized'], [403, 'delegation_invalid', 'delegation_invalid'], [404, 'not_for_this_supplier', 'not_for_this_supplier'],
    [409, 'busy', 'busy'], [422, 'deadline', 'deadline'], [429, 'rate_limited', 'counterparty_refused'], [403, 'underpaid', 'counterparty_refused'],
    [503, 'precheck_failed', 'counterparty_refused'],
  ];
  for (const [status, code, reason] of STATUSES) {
    it(`reports a refusal with status ${status} and the code ${code} as refused_by_counterparty with the reason ${reason}; the escrow stays Open, and nothing is accepted`, async () => {
      const w = await world();
      w.m.agent.refuse = { status, code, message: 'words of the counterparty that never reach the result' };
      const step = expectKind(await go(w), 'refused_by_counterparty');
      expect([step.source, step.reason, step.runtime_status]).toStrictEqual(['before_claim', reason, status]);
      expect(await w.m.chain.escrowState(step.handoff.escrow_ref)).toBe('Open');
      expect(w.key.stranded.list().map((entry) => entry.escrow_ref)).toStrictEqual([step.handoff.escrow_ref]);
      expect(w.booked.accepted).toStrictEqual([]);
      expect(step.handoff).toMatchObject({ paid_from_vault: true, receipt: null, receipt_signature: null, verification: null, result: null, accepted: null });
      expect(JSON.stringify(step)).not.toContain('words of the counterparty');
      const result = settledResult(step, pieces());
      expect(result).toMatchObject({ outcome: 'refused_by_counterparty', reason, challenge: null, exit_state: 'Rejected' });
    });
  }

  it('gives the exit states Expired and Cancelled for the codes approval_expired and delegation_ended, and Rejected for the others', async () => {
    const states: Array<[string, string]> = [['approval_expired', 'Expired'], ['delegation_ended', 'Cancelled'], ['approval_revoked', 'Rejected'], ['sender_not_active', 'Rejected']];
    for (const [code, state] of states) {
      const w = await world();
      w.m.agent.refuse = { status: ERROR_STATUS[code as keyof typeof ERROR_STATUS], code };
      const step = expectKind(await go(w), 'refused_by_counterparty');
      expect([step.reason, settledResult(step, pieces()).exit_state]).toStrictEqual([code, state]);
    }
  });

  it('does not report an answer with no code as a refusal: a page, or an object of a gateway, is a job that may have been claimed, and it is a failure', async () => {
    for (const answer of [() => page(403, '<html><body><h1>403 Forbidden</h1></body></html>'), () => jsonResponse(403, { message: 'refused with no code' }), () => jsonResponse(400, { error: 'refused' })]) {
      const w = await world();
      w.deps.hire.fetchImpl = inFrontOfSends(w.m, answer);
      const step = expectKind(await go(w), 'failed');
      expect(step.reason).toBe('send_lost');
      expect(step.handoff).toMatchObject({ accepted: null, receipt: null });
      expect(settledResult(step, pieces())).toMatchObject({ outcome: 'failed', reason: 'send_lost', exit_state: 'Failed' });
    }
  });

  it('does not report a status of 500 or more as a refusal: the counterparty may have claimed the escrow', async () => {
    for (const code of ['check_unavailable', 'internal']) {
      const w = await world();
      w.m.agent.refuse = { status: code === 'internal' ? 500 : 503, code };
      expect(words(await go(w))).toBe('failed send_lost');
    }
  });

  it('twin: a counterparty that does not refuse is paid and completes', async () => {
    const w = await world();
    expect(words(await go(w))).toBe('completed');
  });
});

describe('a hire that fails after the Claim', () => {
  it('is failed with the reason of the hire kit and never a refusal: the escrow is Claimed, the record names it, and the exit state is Failed', async () => {
    const w = await world();
    w.m.agent.steps = ['running', { fail: 'upstream_failure', submitted: false }];
    const step = expectKind(await go(w), 'failed');
    expect(step.reason).toBe('failed');
    expect(step.handoff).toMatchObject({ paid_from_vault: true, accepted: null, receipt: null, result: null });
    expect(await w.m.chain.escrowState(escrowOf(step))).toBe('Claimed');
    expect(step.vault_ref).not.toBeNull();
    expect(settledResult(step, pieces())).toMatchObject({ outcome: 'failed', reason: 'failed', challenge: null, exit_state: 'Failed' });
    expect(w.booked.accepted).toStrictEqual([]);
  });

  it('is a failure when the send was lost after the Claim: send_lost, and the exit state is Failed', async () => {
    const w = await world();
    w.m.agent.lose = ['after-claim'];
    const step = expectKind(await go(w), 'failed');
    expect(step.reason).toBe('send_lost');
    expect(settledResult(step, pieces())).toMatchObject({ outcome: 'failed', reason: 'send_lost', exit_state: 'Failed' });
  });

  /** The runtime copies the answer of the service into the failure of the job. */
  const failureWith = (message: string) => (reached: Response): Response | undefined => (reached.status === 502 ? jsonResponse(502, { status: 'failed', reason: 'service_http_403', message }) : undefined);

  it('is a refusal of the counterparty only when it answered with a code of its own decision after its Claim: cannot_supply, and the escrow is Claimed', async () => {
    const w = await world();
    w.m.agent.steps = ['running', { fail: 'service_http_403', submitted: false }];
    w.deps.hire.fetchImpl = inFrontOfPolls(w.m, failureWith('service returned HTTP 403: {"error":"cannot_supply","message":"the lot is gone; this text never reaches the result"}'));
    const step = expectKind(await go(w), 'refused_by_counterparty');
    expect([step.source, step.reason, step.runtime_status]).toStrictEqual(['after_claim', 'cannot_supply', null]);
    expect(await w.m.chain.escrowState(step.handoff.escrow_ref)).toBe('Claimed');
    expect(JSON.stringify(step)).not.toContain('the lot is gone');
    expect(settledResult(step, pieces())).toMatchObject({ outcome: 'refused_by_counterparty', reason: 'cannot_supply', exit_state: 'Rejected' });
  });

  it('is a failure when the answer of the service carries another code, or no code: the same failed job, and it is not a refusal', async () => {
    for (const message of ['service returned HTTP 403: {"error":"duplicate_po","message":"seen"}', 'service returned HTTP 500: the service fell over', 'cannot_supply']) {
      const w = await world();
      w.m.agent.steps = ['running', { fail: 'service_http_403', submitted: false }];
      w.deps.hire.fetchImpl = inFrontOfPolls(w.m, failureWith(message));
      const step = expectKind(await go(w), 'failed');
      expect(step.reason).toBe('failed');
    }
  });
});

describe('a Pay that the vault refuses', () => {
  it('says vault_refused with the evaluation error and the body of the transaction for a Pay above the limit of the vault; nothing is posted, sent or recorded, and the vault is as it was', async () => {
    const w = await world({ limit: { perTx: 1_000_000n, total: 12_000_000n, periodMs: 86_400_000 } });
    const step = expectKind(await go(w), 'vault_refused');
    expect(step.refusal).toBe('ledger');
    expect(step.reason).toMatch(/^3010 /);
    expect(step.evidence.transaction_body).toMatch(/^[0-9a-f]+$/);
    expect(step).toMatchObject({ handoff: null, delegation: 'live', delegation_ended: false });
    expect(untouched(w)).toStrictEqual({ posted: 0, sends: 0, stranded: 0, spent: 0 });
    expect(w.m.chain.vault(w.vault)).toMatchObject({ kind: 'Live', consumed: false });
    expect(w.m.chain.vaults()).toHaveLength(1);
    expect(settledResult(step, pieces())).toMatchObject({ outcome: 'vault_refused', reason: step.reason, challenge: null, exit_state: 'Failed', handoff: null });
    // The twin: a limit above the lock lets the same Pay through.
    const twin = await world({ limit: { perTx: 3_000_000n, total: 12_000_000n, periodMs: 86_400_000 } });
    expect(words(await go(twin))).toBe('completed');
  });

  it('says vault_refused for a Pay past the total of the period, from the vault that the first Pay left; the first Pay completed', async () => {
    const measure = await world();
    const done = expectKind(await go(measure), 'completed');
    const lock = BigInt(done.terms.locked_lovelace);
    const w = await world({ limit: { perTx: 5_000_000n, total: lock + lock / 2n, periodMs: 86_400_000 } });
    const first = expectKind(await go(w), 'completed');
    const second = expectKind(await go(w, { message: handoffFor(purchaseOrder({ po_number: 'run1-0002' })) }), 'vault_refused');
    expect(second.reason).toMatch(/^3010 /);
    expect(w.booked.posted).toHaveLength(1);
    expect(w.m.agent.sends).toHaveLength(1);
    expect(w.m.chain.vault(first.vault_ref ?? '')).toMatchObject({ kind: 'Live', consumed: false });
    // The twin: a total that holds two Pays lets the second one through.
    const roomy = await world({ limit: { perTx: 5_000_000n, total: lock * 2n, periodMs: 86_400_000 } });
    expect(words(await go(roomy))).toBe('completed');
    expect(words(await go(roomy, { message: handoffFor(purchaseOrder({ po_number: 'run1-0002' })) }))).toBe('completed');
  });

  it('reads the delegation again after the refusal: a delegation that the hirer ended gives delegation_ended and the exit state Cancelled', async () => {
    const w = await world();
    w.endDelegation();
    const step = expectKind(await go(w), 'vault_refused');
    expect([step.refusal, step.reason, step.delegation, step.delegation_ended]).toStrictEqual(['impossible', 'no_delegation', 'ended', true]);
    expect(w.reads.calls.delegation).toBe(2);
    expect(untouched(w)).toStrictEqual({ posted: 0, sends: 0, stranded: 0, spent: 0 });
    expect(settledResult(step, pieces())).toMatchObject({ outcome: 'vault_refused', reason: 'no_delegation', exit_state: 'Cancelled' });
  });

  it('keeps the exit state Failed for a refusal while the delegation stands: a vault that is too small to pay', async () => {
    const w = await world({ vault: false });
    w.vault = w.openVault(1_300_000n);
    const step = expectKind(await go(w), 'vault_refused');
    expect([step.refusal, step.reason, step.delegation, step.delegation_ended]).toStrictEqual(['impossible', 'below_minimum', 'live', false]);
    expect(settledResult(step, pieces())).toMatchObject({ outcome: 'vault_refused', exit_state: 'Failed' });
  });

  it('keeps the exit state Failed when the delegation cannot be read again: it does not guess that the hirer ended it', async () => {
    const w = await world();
    w.endDelegation();
    const reads = vi.spyOn(w.reads, 'delegation');
    reads.mockResolvedValueOnce(null).mockRejectedValueOnce(new Error('the ledger is down'));
    const step = expectKind(await go(w), 'vault_refused');
    expect([step.delegation, step.delegation_ended]).toStrictEqual(['unreadable', false]);
    expect(settledResult(step, pieces())).toMatchObject({ outcome: 'vault_refused', exit_state: 'Failed' });
  });

  it('goes on when the delegation is not found, and lets the ledger refuse the Pay: vault_refused, and Cancelled when the delegation is gone', async () => {
    const w = await world();
    const pay = vi.spyOn(w.m.chain, 'payFromVault');
    w.endDelegation();
    const step = await go(w);
    expect(words(step)).toBe('vault_refused impossible');
    // The Pay was tried: the missing delegation did not stop the job.
    expect(pay).toHaveBeenCalledTimes(1);
  });
});

describe('a decision that does not accept', () => {
  it('ends as not_accepted with declined when the decision said no: the delivery and the receipt are in the step, the escrow stays Submitted, and nothing is accepted', async () => {
    const w = await world();
    const step = expectKind(await go(w, { decide: () => ({ accept: false, reason: 'the lot of the confirmation is not the lot of the order' }) }), 'not_accepted');
    expect([step.why, step.declined]).toStrictEqual(['declined', 'the lot of the confirmation is not the lot of the order']);
    expect(step.delivery).toMatchObject({ text: AGENT_ANSWER, result: JSON.parse(AGENT_ANSWER) });
    expect(step.handoff).toMatchObject({ accepted: 'no', result: JSON.parse(AGENT_ANSWER), receipt_signature: step.delivery.receipt_signature });
    expect(await w.m.chain.escrowState(step.handoff.escrow_ref)).toBe('Submitted');
    expect(w.booked.accepted).toStrictEqual([]);
    expect(w.key.stranded.list().map((entry) => entry.escrow_ref)).toStrictEqual([step.handoff.escrow_ref]);
    // Never a pass: no helper of the flow makes `completed` of this step.
    expect(() => settledResult(step as never, pieces())).toThrow(TypeError);
  });

  it('ends as not_accepted with decision_timeout when the decision does not answer in time: no Accept, the escrow stays Submitted, and the lane of the key is free for the next hire', async () => {
    vi.useFakeTimers();
    const w = await world();
    let asked = 0;
    const never = (): Promise<never> => new Promise<never>(() => undefined);
    const step = expectKind(await go(w, { decide: () => { asked += 1; vi.advanceTimersByTime(DECISION_WINDOW_MS); return never(); } }), 'not_accepted');
    expect([asked, step.why, step.declined]).toStrictEqual([1, 'decision_timeout', null]);
    expect(step.delivery.text).toBe(AGENT_ANSWER);
    expect(step.handoff.accepted).toBe('no');
    expect(await w.m.chain.escrowState(step.handoff.escrow_ref)).toBe('Submitted');
    expect(w.booked.accepted).toStrictEqual([]);
    expect(w.key.lane.busy).toBe(false);
    // The twin: the next hire from the vault that continues is made and completes.
    expect(words(await go(w, { message: handoffFor(purchaseOrder({ po_number: 'run1-0002' })) }))).toBe('completed');
  });

  it('hears a decision that answers one millisecond before the limit: the Accept is made', async () => {
    vi.useFakeTimers();
    const w = await world();
    const step = await go(w, { decide: async () => { vi.advanceTimersByTime(DECISION_WINDOW_MS - 1); return { accept: true }; } });
    expect(words(step)).toBe('completed');
    expect(w.booked.accepted).toHaveLength(1);
  });

  it('ends the hire with an error that is a decision_error when the decision answers something that is not a decision, and makes no Accept: only `true` accepts', async () => {
    const answers: unknown[] = [undefined, null, 'accept', {}, { accept: 'false' }, { accept: 'true' }, { accept: 1 }, { accept: 0, reason: 'no' }, { accept: false }, { accept: false, reason: 7 }, [true], true];
    for (const answer of answers) {
      const w = await world();
      const step = expectKind(await go(w, { decide: () => answer as never }), 'interrupted');
      expect(step.cause_kind, JSON.stringify(answer)).toBe('decision_error');
      // The delivery was given to the decision, the Pay is confirmed, and the escrow stays Submitted: no Accept was made.
      expect(step.delivery).not.toBeNull();
      expect(await w.m.chain.escrowState(step.escrow_ref)).toBe('Submitted');
      expect(w.booked.accepted).toStrictEqual([]);
    }
    // The twins: an answer that is a decision is heard.
    const accepted = await world();
    expect(words(await go(accepted, { decide: () => ({ accept: true, reason: 'extra members are ignored' } as never) }))).toBe('completed');
    const declined = await world();
    expect(words(await go(declined, { decide: () => ({ accept: false, reason: 'no' }) }))).toBe('not_accepted declined');
  });

  it('ends the hire with a decision_error when the decision throws, and says the delivery that it was given', async () => {
    const w = await world();
    const step = expectKind(await go(w, { decide: () => { throw new Error('the model supplier is down'); } }), 'interrupted');
    expect(step.cause_kind).toBe('decision_error');
    expect(step.delivery).toMatchObject({ text: AGENT_ANSWER });
    expect(await w.m.chain.escrowState(step.escrow_ref)).toBe('Submitted');
    expect(settledResult(step, pieces())).toMatchObject({ outcome: 'failed', reason: 'decision_error', exit_state: 'Failed' });
  });
});

describe('a hire that an error ends after the Pay', () => {
  const VALID_TO = T0 + 400_000;
  const unseen = (landed: { escrowRef: string; deliverBy: number }, mayLand: boolean): TxNotConfirmedError => new TxNotConfirmedError(
    'The Pay was submitted, but Koios did not report it confirmed.', { txHash: landed.escrowRef.split('#')[0]!, escrowRef: landed.escrowRef, deliverBy: landed.deliverBy, validTo: VALID_TO, mayLand },
  );

  it('keeps the vault that continues, the escrow and the cause when the deadline of the run comes: interrupted, and no second hire', async () => {
    const w = await world({ deadlineMs: 20_000 });
    w.m.agent.steps = ['running', 'running', 'running', 'running', 'running', 'running', 'running', 'running', 'done'];
    const step = expectKind(await go(w), 'interrupted');
    expect(step.cause_kind).toBe('deadline');
    expect(w.m.chain.vault(w.vault)).toMatchObject({ consumed: true });
    expect(w.m.chain.vault(step.vault_ref)).toMatchObject({ kind: 'Live', consumed: false, delegation: 'dd'.repeat(32) });
    expect(step.escrow_ref).toBe(`${step.vault_ref.split('#')[0]}#0`);
    expect(step.handoff).toMatchObject({ escrow_ref: step.escrow_ref, advert_ref: AGENT_ADVERT_REF, accepted: null, receipt: null });
    expect(step.delivery).toBeNull();
    expect(w.m.agent.sends).toHaveLength(1);
    expect(w.booked.posted).toHaveLength(1);
    expect(settledResult(step, pieces())).toMatchObject({ outcome: 'failed', reason: 'deadline', exit_state: 'Failed' });
    // The twin: a deadline that the job meets completes.
    const roomy = await world({ deadlineMs: 5_000_000 });
    roomy.m.agent.steps = ['running', 'running', 'running', 'running', 'running', 'running', 'running', 'running', 'done'];
    expect(words(await go(roomy))).toBe('completed');
  });

  it('keeps the vault that continues when the stranded store cannot be written: interrupted with the cause store_write', async () => {
    const w = await world();
    vi.spyOn(w.key.stranded, 'add').mockImplementationOnce(() => { throw new Error('the disk is full'); });
    const step = expectKind(await go(w), 'interrupted');
    expect(step.cause_kind).toBe('store_write');
    expect(w.m.chain.vault(step.vault_ref)).toMatchObject({ kind: 'Live', consumed: false });
    expect(settledResult(step, pieces())).toMatchObject({ outcome: 'failed', reason: 'store_write_failed', exit_state: 'Failed' });
  });

  it('keeps the vault that continues when the ledger of the service throws after the Pay: interrupted with the cause other', async () => {
    const w = await world();
    w.deps.hire.ledger.posted = () => { throw new Error('the ledger is closed'); };
    const step = expectKind(await go(w), 'interrupted');
    expect(step.cause_kind).toBe('other');
    expect(settledResult(step, pieces())).toMatchObject({ outcome: 'failed', reason: 'hire_interrupted', exit_state: 'Failed' });
  });

  it('names the vault that continues if the Pay lands, says that it may land and until when, and makes no second Pay and no send', async () => {
    const w = await world();
    const real = w.m.chain.payFromVault.bind(w.m.chain);
    const pay = vi.spyOn(w.m.chain, 'payFromVault').mockImplementationOnce(async (args) => { throw unseen(await real(args), true); });
    const step = expectKind(await go(w), 'pay_unconfirmed');
    expect([step.escrow_ref, step.vault_ref_if_landed, step.may_land, step.valid_to]).toStrictEqual([`${step.tx_hash}#0`, `${step.tx_hash}#1`, true, VALID_TO]);
    expect(step.handoff).toMatchObject({ escrow_ref: step.escrow_ref, accepted: null, receipt: null, paid_from_vault: true });
    expect(pay).toHaveBeenCalledTimes(1);
    expect(w.m.agent.sends).toStrictEqual([]);
    expect(w.key.stranded.list()).toMatchObject([{ escrow_ref: step.escrow_ref, valid_to: VALID_TO }]);
    expect(settledResult(step, pieces())).toMatchObject({ outcome: 'failed', reason: 'pay_unconfirmed', exit_state: 'Failed' });
  });

  it('says that the Pay may not land when it certainly did not reach the node, and the vault that the caller held is live', async () => {
    const w = await world();
    const hash = 'ab'.repeat(32);
    vi.spyOn(w.m.chain, 'payFromVault').mockRejectedValueOnce(unseen({ escrowRef: `${hash}#0`, deliverBy: T0 + 480_000 }, false));
    const step = expectKind(await go(w), 'pay_unconfirmed');
    expect([step.may_land, step.vault_ref_if_landed, step.escrow_ref]).toStrictEqual([false, `${hash}#1`, `${hash}#0`]);
    expect(w.m.chain.vault(w.vault)).toMatchObject({ kind: 'Live', consumed: false });
  });

  it('says failed with post_failed for a Pay that failed before its signature: no vault was spent and no escrow was posted', async () => {
    const w = await world();
    vi.spyOn(w.m.chain, 'payFromVault').mockRejectedValueOnce(new Error('the wallet has no collateral'));
    const step = expectKind(await go(w), 'failed');
    expect([step.reason, step.handoff, step.vault_ref]).toStrictEqual(['post_failed', null, null]);
    expect(untouched(w)).toStrictEqual({ posted: 0, sends: 0, stranded: 0, spent: 0 });
    // The twin: the next hire from the same vault completes.
    expect(words(await go(w))).toBe('completed');
  });
});

describe('a receipt that does not verify', () => {
  it('is a failure and never a completed hire: a receipt that a forger signed is not accepted, the decision is not asked, and the escrow stays Submitted', async () => {
    const w = await world();
    w.m.agent.forge = true;
    let asked = 0;
    const step = expectKind(await go(w, { decide: () => { asked += 1; return { accept: true }; } }), 'failed');
    expect([step.reason, asked]).toStrictEqual(['receipt_failed', 0]);
    expect(step.handoff).toMatchObject({ accepted: null, receipt: null, verification: { signature_valid: false } });
    expect(await w.m.chain.escrowState(escrowOf(step))).toBe('Submitted');
    expect(w.booked.accepted).toStrictEqual([]);
    expect(settledResult(step, pieces())).toMatchObject({ outcome: 'failed', reason: 'receipt_failed', exit_state: 'Failed' });
    // The twin: a supplier that signs with its own key is accepted.
    const honest = await world();
    expect(words(await go(honest))).toBe('completed');
  });
});
