// agents/prior-authorization-agent/test/execute/records.test.ts: the write of the submission to the records system, after a hire that was paid and accepted. The token is for the route priorauth.submit only, and the
// delegation key asks for it. A refusal of the system is `refused_by_system` with its code. Any other end of the call is `failed`, because the submission may or may not be written. In each case the Accept was made,
// so the record of the hire and the decision of the model stay in the result. The submission is written on a completed hire and on no other end. Each form has its twin.
import { afterEach, describe, expect, it } from 'vitest';
import { createVerifier } from '@vsa/id-kit/verify';
import { exitStateOf } from '@vsa/usecase-kit/protocol';
import type { ExecuteResult } from '@vsa/usecase-kit/protocol';
import { acceptDecision } from './fixtures.ts';
import type { World } from './world.ts';
import { cleanWorlds, footprint, hireOf, jsonResponse, pageResponse, words, world } from './world.ts';

afterEach(() => { cleanWorlds(); });

const OTHER_HASH = '00'.repeat(32);

/** What a job leaves when the Accept was made and the submission was not recorded: the record of the Accept, the decision, no write, and no challenge. */
async function expectAcceptedNotRecorded(w: World, result: ExecuteResult, calls: number): Promise<void> {
  expect(result).toMatchObject({ challenge: null, writes: [] });
  expect(result.decisions).toStrictEqual([acceptDecision(true)]);
  expect(hireOf(result)).toMatchObject({ paid_from_vault: true, accepted: 'confirmed' });
  expect(await w.m.chain.escrowState(hireOf(result).escrow_ref)).toBe('spent');
  expect(footprint(w)).toStrictEqual({ paid: 1, sends: 1, writes: calls, challenges: 0, asked: 1 });
}

describe('a records system that refuses the submission', () => {
  const REFUSALS: Array<[number, unknown, string, string]> = [
    [409, { error: 'duplicate_submission', message: 'words of the system' }, 'duplicate_submission', 'Rejected'],
    [404, { error: 'order_not_found', message: 'words of the system' }, 'order_not_found', 'Rejected'],
    [403, { error: 'not_covered', message: 'words of the system' }, 'not_covered', 'Rejected'],
    [401, { error: 'token_invalid', message: 'words of the system' }, 'token_invalid', 'Rejected'],
    [403, { error: 'delegation_ended', message: 'words of the system' }, 'delegation_ended', 'Cancelled'],
    [403, { error: 'approval_expired', message: 'words of the system' }, 'approval_expired', 'Expired'],
    [400, { error: 'bad_request', message: 'words of the system' }, 'bad_request', 'Rejected'],
    [404, { error: 'tenant_not_found', message: 'words of the system' }, 'tenant_not_found', 'Rejected'],
    [403, { message: 'a refusal with no code' }, 'refusal_without_code', 'Rejected'],
  ];
  for (const [status, body, reason, state] of REFUSALS) {
    it(`is refused_by_system with ${reason} (${status}) and the exit state ${state}: the Accept was made, and the submission is not recorded`, async () => {
      const w = await world();
      w.store.answer = () => jsonResponse(status, body);
      const result = await w.run();
      expect(words(result)).toBe(`refused_by_system ${reason} ${state}`);
      expect(result.exit_state).toBe(exitStateOf({ outcome: 'refused_by_system', reason, challenge_filed: false, delegation_ended: false }));
      await expectAcceptedNotRecorded(w, result, 1);
      expect(JSON.stringify(result)).not.toContain('words of the system');
    });
  }

  it('twin: a records system that records the submission gives completed with the write', async () => {
    const w = await world();
    const result = await w.run();
    expect(words(result)).toBe('completed none Completed');
    expect(result.writes).toHaveLength(1);
  });
});

describe('a call to the records system that ends in no refusal', () => {
  const FAILURES: Array<[string, () => Response | Promise<Response>]> = [
    ['an error of the system', () => jsonResponse(500, { error: 'internal', message: 'words of the system' })],
    ['a system that cannot read its ledger', () => jsonResponse(503, { error: 'ledger_unavailable', message: 'words of the system' })],
    ['a page of a proxy', () => pageResponse(502, '<html><body><h1>502 Bad Gateway</h1></body></html>')],
    ['a redirect', () => new Response(null, { status: 301, headers: { location: 'https://mock.example/elsewhere' } })],
    ['an answer of 200, which is not a recorded submission', () => jsonResponse(200, { submission_id: 'SUB-run1-0001' })],
    ['an answer of 201 that is not JSON', () => pageResponse(201, 'recorded')],
    ['an error status with no code of a rule', () => jsonResponse(409, { message: 'words of the system' })],
    ['a network that fails', () => { throw new TypeError('fetch failed'); }],
  ];
  for (const [name, answer] of FAILURES) {
    it(`is failed with mock_system_failed, because the submission may or may not be written: ${name}`, async () => {
      const w = await world();
      w.store.answer = answer;
      const result = await w.run();
      expect(words(result)).toBe('failed mock_system_failed Failed');
      await expectAcceptedNotRecorded(w, result, 1);
      expect(JSON.stringify(result)).not.toContain('words of the system');
    });
  }

  it('is failed with token_failed when the gateway gives no token, and the records system is not called: the Accept was made', async () => {
    const ended = await world();
    ended.gateway.endDelegation(ended.delegation);
    const result = await ended.run();
    expect(words(result)).toBe('failed token_failed Failed');
    await expectAcceptedNotRecorded(ended, result, 0);
    expect(ended.tokens).toHaveLength(1);
    expect(ended.tokens[0]!.answer.ok).toBe(false);
    // The same end when the gateway is down.
    const down = await world();
    down.gateway.fault('/token', { status: 503, body: '{}' });
    expect(words(await down.run())).toBe('failed token_failed Failed');
    expect(down.store.calls).toHaveLength(0);
    // The twin: a delegation that stands gives its token, and the submission is written.
    const standing = await world();
    expect(words(await standing.run())).toBe('completed none Completed');
  });

  it('keeps a reference only when it is an identifier: the submission is recorded all the same, and a reference that is not kept is null', async () => {
    const refs: Array<[unknown, string | null]> = [['SUB-run1-0007', 'SUB-run1-0007'], ['x'.repeat(500), null], ['has a space', null], [7, null], [null, null]];
    for (const [record, kept] of refs) {
      const w = await world();
      w.store.answer = () => jsonResponse(201, { submission_id: record });
      const result = await w.run();
      expect(words(result)).toBe('completed none Completed');
      expect(result.writes).toStrictEqual([{ system: 'records', route: 'POST /records/orders/{order_id}/submission', status: 201, ref: kept }]);
    }
    const bare = await world();
    bare.store.answer = () => jsonResponse(201, ['not an object']);
    expect((await bare.run()).writes).toStrictEqual([{ system: 'records', route: 'POST /records/orders/{order_id}/submission', status: 201, ref: null }]);
  });
});

describe('the token for the records system', () => {
  it('passes the verifier of the mock system for the action priorauth.submit on its resource: the token is for that route and the proof is for that call', async () => {
    const w = await world();
    const verifier = createVerifier({ baseUrl: w.gateway.baseUrl, fetch: w.gateway.fetch, now: w.gateway.now });
    const verdicts: boolean[] = [];
    const answerFor = (action: string) => async (call: { method: string; url: string; headers: Record<string, string> }): Promise<Response> => {
      const verified = await verifier.accessToken(
        { authorization: call.headers.authorization!, dpop: call.headers.dpop!, method: call.method, url: call.url },
        { audience: w.records.resource, require: { action, resource: w.records.resource } },
      );
      verdicts.push(verified.ok);
      return verified.ok ? jsonResponse(201, { submission_id: 'SUB-run1-0001' }) : jsonResponse(401, { error: 'token_invalid', message: 'words' });
    };
    w.store.answer = answerFor('priorauth.submit');
    expect(words(await w.run())).toBe('completed none Completed');
    expect(verdicts).toStrictEqual([true]);
    // The twin: a mock system that wants another action refuses the same token, and the job says so.
    const other = await world();
    other.store.answer = answerFor('record.read');
    const refused = await other.run();
    expect(words(refused)).toBe('refused_by_system token_invalid Rejected');
    expect(verdicts).toStrictEqual([true, false]);
  });

  it('is asked one time for the one call: no retry after a refusal, and no second hire', async () => {
    const w = await world();
    w.store.answer = () => jsonResponse(409, { error: 'duplicate_submission', message: 'seen' });
    await w.run();
    expect(w.tokens).toHaveLength(1);
    expect(w.store.calls).toHaveLength(1);
    expect(w.m.agent.sends).toHaveLength(1);
  });
});

describe('every end that is not a completed hire', () => {
  /** Each scenario ends in a result that is not `completed`. In none of them does the job ask for a token for the records system or call it. */
  const ENDS: Array<[string, (w: World) => void, string]> = [
    ['a refused Pay', (w) => { w.endDelegation(); }, 'vault_refused'],
    ['a refusal of the Insurer Intake Agent', (w) => { w.m.agent.refuse = { status: 403, code: 'duplicate_request' }; }, 'refused_by_counterparty'],
    ['a refusal for the digest of the approval', (w) => { w.m.agent.refuse = { status: 403, code: 'approval_digest_mismatch' }; }, 'refused_by_counterparty'],
    ['a job of the Insurer Intake Agent that fails', (w) => { w.m.agent.steps = ['running', { fail: 'upstream_failure', submitted: false }]; }, 'failed'],
    ['a model that does not accept the delivery', (w) => { w.answer({ request_sha256: OTHER_HASH }); }, 'disputed'],
    ['a model that says no for equal hashes', (w) => { w.accept.answer = () => ({ ok: true, decision: acceptDecision(false, ['request_sha256']), choice: { accept: false, mismatch: ['request_sha256'] } }); }, 'disputed'],
    ['an answer that is no intake record', (w) => { w.answer('the request is filed'); }, 'failed'],
    ['an intake record of another request number', (w) => { w.answer({ request_number: 'run1-2' }); }, 'failed'],
    ['a decision that failed', (w) => { w.accept.answer = () => ({ ok: false, code: 'model_output_invalid' }); }, 'failed'],
    ['a delivery that cannot be recorded', (w) => { w.receipt.depth = 40; }, 'failed'],
    ['a challenge that the dispute folder does not file', (w) => { w.answer({ request_sha256: OTHER_HASH }); w.dispute.failWith = new Error('the node fell over'); }, 'disputed'],
    ['a model that accepts a record that names another hash than the hash of the request that was sent', (w) => { w.answer({ request_sha256: OTHER_HASH }); w.accept.answer = () => ({ ok: true, decision: acceptDecision(true), choice: { accept: true, mismatch: [] } }); }, 'failed'],
  ];
  for (const [name, arrange, outcome] of ENDS) {
    it(`never writes the submission and never asks for its token: ${name}`, async () => {
      const w = await world();
      arrange(w);
      const result = await w.run();
      expect(result.outcome).toBe(outcome);
      expect(result.writes).toStrictEqual([]);
      expect(w.store.calls).toHaveLength(0);
      expect(w.tokens).toHaveLength(0);
    });
  }

  it('twin: a completed hire writes the submission once, with one token', async () => {
    const w = await world();
    expect(words(await w.run())).toBe('completed none Completed');
    expect(w.store.calls).toHaveLength(1);
    expect(w.tokens).toHaveLength(1);
  });
});
