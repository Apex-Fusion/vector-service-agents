// agents/reorder-agent/test/execute/store.test.ts: the write of the order to the PO store, after a hire that was paid and accepted. The token is for the route po.write only, and the delegation key asks for
// it. A refusal of the system is `refused_by_system` with its code. Any other end of the call is `failed`, because the order may or may not be written. In each case the Accept was made, so the record
// of the hire and the decision of the model stay in the result. Each form has its twin.
import { afterEach, describe, expect, it } from 'vitest';
import { createVerifier } from '@vsa/id-kit/verify';
import { exitStateOf } from '@vsa/usecase-kit/protocol';
import type { ExecuteResult } from '@vsa/usecase-kit/protocol';
import { acceptDecision } from './fixtures.ts';
import type { World } from './world.ts';
import { cleanWorlds, footprint, hireOf, jsonResponse, pageResponse, words, world } from './world.ts';

afterEach(() => { cleanWorlds(); });

/** What a job leaves when the Accept was made and the order was not recorded: the record of the Accept, the decision, no write, and no challenge. */
async function expectAcceptedNotRecorded(w: World, result: ExecuteResult, calls: number): Promise<void> {
  expect(result).toMatchObject({ challenge: null, writes: [] });
  expect(result.decisions).toStrictEqual([acceptDecision(true)]);
  expect(hireOf(result)).toMatchObject({ paid_from_vault: true, accepted: 'confirmed' });
  expect(await w.m.chain.escrowState(hireOf(result).escrow_ref)).toBe('spent');
  expect(footprint(w)).toStrictEqual({ paid: 1, sends: 1, poWrites: calls, challenges: 0, asked: 1 });
}

describe('a PO store that refuses the order', () => {
  const REFUSALS: Array<[number, unknown, string, string]> = [
    [409, { error: 'duplicate_po', message: 'words of the system' }, 'duplicate_po', 'Rejected'],
    [403, { error: 'not_covered', message: 'words of the system' }, 'not_covered', 'Rejected'],
    [401, { error: 'token_invalid', message: 'words of the system' }, 'token_invalid', 'Rejected'],
    [403, { error: 'delegation_ended', message: 'words of the system' }, 'delegation_ended', 'Cancelled'],
    [403, { error: 'approval_expired', message: 'words of the system' }, 'approval_expired', 'Expired'],
    [400, { error: 'bad_request', message: 'words of the system' }, 'bad_request', 'Rejected'],
    [404, { error: 'tenant_not_found', message: 'words of the system' }, 'tenant_not_found', 'Rejected'],
    [403, { message: 'a refusal with no code' }, 'refusal_without_code', 'Rejected'],
  ];
  for (const [status, body, reason, state] of REFUSALS) {
    it(`is refused_by_system with ${reason} (${status}) and the exit state ${state}: the Accept was made, and the order is not recorded`, async () => {
      const w = await world();
      w.store.answer = () => jsonResponse(status, body);
      const result = await w.run();
      expect(words(result)).toBe(`refused_by_system ${reason} ${state}`);
      expect(result.exit_state).toBe(exitStateOf({ outcome: 'refused_by_system', reason, challenge_filed: false, delegation_ended: false }));
      await expectAcceptedNotRecorded(w, result, 1);
      expect(JSON.stringify(result)).not.toContain('words of the system');
    });
  }

  it('twin: a PO store that records the order gives completed with the write', async () => {
    const w = await world();
    const result = await w.run();
    expect(words(result)).toBe('completed none Completed');
    expect(result.writes).toHaveLength(1);
  });
});

describe('a call to the PO store that ends in no refusal', () => {
  const FAILURES: Array<[string, () => Response | Promise<Response>]> = [
    ['an error of the system', () => jsonResponse(500, { error: 'internal', message: 'words of the system' })],
    ['a system that cannot read its ledger', () => jsonResponse(503, { error: 'ledger_unavailable', message: 'words of the system' })],
    ['a page of a proxy', () => pageResponse(502, '<html><body><h1>502 Bad Gateway</h1></body></html>')],
    ['a redirect', () => new Response(null, { status: 301, headers: { location: 'https://mock.example/elsewhere' } })],
    ['an answer of 200, which is not a recorded order', () => jsonResponse(200, { record_id: 'PO-run1-0001' })],
    ['an answer of 201 that is not JSON', () => pageResponse(201, 'recorded')],
    ['a network that fails', () => { throw new TypeError('fetch failed'); }],
  ];
  for (const [name, answer] of FAILURES) {
    it(`is failed with mock_system_failed, because the order may or may not be written: ${name}`, async () => {
      const w = await world();
      w.store.answer = answer;
      const result = await w.run();
      expect(words(result)).toBe('failed mock_system_failed Failed');
      await expectAcceptedNotRecorded(w, result, 1);
      expect(JSON.stringify(result)).not.toContain('words of the system');
    });
  }

  it('is failed with token_failed when the gateway gives no token, and the PO store is not called: the Accept was made', async () => {
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
    // The twin: a delegation that stands gives its token, and the order is written.
    const standing = await world();
    expect(words(await standing.run())).toBe('completed none Completed');
  });

  it('keeps a reference only when it is an identifier: the order is recorded all the same, and a reference that is not kept is null', async () => {
    const refs: Array<[unknown, string | null]> = [['PO-run1-0007', 'PO-run1-0007'], ['x'.repeat(500), null], ['has a space', null], [7, null], [null, null]];
    for (const [record, kept] of refs) {
      const w = await world();
      w.store.answer = () => jsonResponse(201, { record_id: record });
      const result = await w.run();
      expect(words(result)).toBe('completed none Completed');
      expect(result.writes).toStrictEqual([{ system: 'po-store', route: 'POST /po', status: 201, ref: kept }]);
    }
    const bare = await world();
    bare.store.answer = () => jsonResponse(201, ['not an object']);
    expect((await bare.run()).writes).toStrictEqual([{ system: 'po-store', route: 'POST /po', status: 201, ref: null }]);
  });
});

describe('the token for the PO store', () => {
  it('passes the verifier of the mock system for the action po.write on its resource: the token is for that route and the proof is for that call', async () => {
    const w = await world();
    const verifier = createVerifier({ baseUrl: w.gateway.baseUrl, fetch: w.gateway.fetch, now: w.gateway.now });
    const verdicts: boolean[] = [];
    const answerFor = (action: string) => async (call: { method: string; url: string; headers: Record<string, string> }): Promise<Response> => {
      const verified = await verifier.accessToken(
        { authorization: call.headers.authorization!, dpop: call.headers.dpop!, method: call.method, url: call.url },
        { audience: w.po.resource, require: { action, resource: w.po.resource } },
      );
      verdicts.push(verified.ok);
      return verified.ok ? jsonResponse(201, { record_id: 'PO-run1-0001' }) : jsonResponse(401, { error: 'token_invalid', message: 'words' });
    };
    w.store.answer = answerFor('po.write');
    expect(words(await w.run())).toBe('completed none Completed');
    expect(verdicts).toStrictEqual([true]);
    // The twin: a mock system that wants another action refuses the same token, and the job says so.
    const other = await world();
    other.store.answer = answerFor('po.read');
    const refused = await other.run();
    expect(words(refused)).toBe('refused_by_system token_invalid Rejected');
    expect(verdicts).toStrictEqual([true, false]);
  });

  it('is asked one time for the one call: no retry after a refusal, and no second hire', async () => {
    const w = await world();
    w.store.answer = () => jsonResponse(409, { error: 'duplicate_po', message: 'seen' });
    await w.run();
    expect(w.tokens).toHaveLength(1);
    expect(w.store.calls).toHaveLength(1);
    expect(w.m.agent.sends).toHaveLength(1);
  });
});
