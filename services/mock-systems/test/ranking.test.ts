// POST /sourcing/rankings: the token check, then the approval check against the ranking that was sent, then the record of the top-ranked supplier, which must be Active. A null approval is
// 403 approval_not_found. The approval check is a dependency, so these tests give it a fake that records what it was asked and answers as the test says. The fake is in the test support only:
// no source of the service builds one. Each refusal has the call that is accepted beside it, and no ranking is written for a refusal.
import { describe, expect, it } from 'vitest';
import { APPROVAL_CODES } from '../src/errors.ts';
import { callWithToken, delegateTo, rankingBody, scenario } from './support/scenario.ts';
import type { Scenario } from './support/scenario.ts';
import { PUBLIC_BASE } from './support/world.ts';

const TENANT = 'run1';
const ROUTE = '/sourcing/rankings';

const refused = (reply: { status: number; json: Record<string, unknown> | null }, status: number, code: string) => {
  expect([reply.status, reply.json?.error]).toEqual([status, code]);
};
const lastRule = (s: Scenario): unknown => s.harness.logged().at(-1)?.rule;
const written = async (s: Scenario): Promise<unknown[]> => ((await s.harness.call({ path: `/t/${TENANT}/state` })).json as { sourcing: { rankings: unknown[] } }).sourcing.rankings;

async function setup() {
  const s = await scenario(TENANT);
  const agent = delegateTo(s, 'sourcing', [['sourcing.award.write', 'sourcing']]);
  const alfa = s.world.agent('desk-alfa');
  const bravo = s.world.agent('desk-bravo');
  const send = (body: unknown) => callWithToken(s, agent, 'sourcing', 'POST', ROUTE, body);
  return { s, agent, alfa, bravo, send, body: () => rankingBody(TENANT, alfa.did, bravo.did) };
}

describe('a ranking that is right', () => {
  it('is written: the approval check passed and the supplier of rank 1 is Active, and the answer names the ranking and its top', async () => {
    const { s, alfa, send, body } = await setup();
    const reply = await send(body());
    expect(reply.status, reply.text).toBe(201);
    expect(reply.json).toMatchObject({ ranking_id: 'RK-run1-0001', rfq_id: 'rfq-1', top: { rank: 1, desk_did: alfa.did } });
    expect(s.harness.logged().at(-1)).toMatchObject({ route: 'POST /sourcing/rankings', decision: 'allowed', status: 201 });
    expect(await written(s)).toHaveLength(1);
  });
  it('asks the approval check for the sender, the delegation, the approval named, the ranking exactly as it was sent, the salt and the time', async () => {
    const { s, agent, send, body } = await setup();
    const sent = body();
    // A field that the service does not know stays in the ranking that the check is given: the digest depends on every byte.
    (sent.ranking as Record<string, unknown>).note = 'a field of the sender';
    await send(sent);
    expect(s.harness.approvals).toHaveLength(1);
    const asked = s.harness.approvals[0]!;
    expect(asked).toEqual({ sender: agent.agent.did, delegation: agent.delegation.id, attestation: '07'.repeat(32), issuerDid: `did:vector:${'b2'.repeat(32)}`, document: sent.ranking, salt: 'f6'.repeat(32), atMs: s.world.now() });
    expect((asked.document as Record<string, unknown>).note).toBe('a field of the sender');
  });
  it('takes a ranking for each request for quotation, and numbers them', async () => {
    const { s, alfa, bravo, send } = await setup();
    const first = await send(rankingBody(TENANT, alfa.did, bravo.did));
    const second = await send(rankingBody(TENANT, bravo.did, alfa.did));
    expect([first.json?.ranking_id, second.json?.ranking_id]).toEqual(['RK-run1-0001', 'RK-run1-0002']);
    expect(await written(s)).toHaveLength(2);
  });
});

describe('an approval that is not there or not good', () => {
  it('a null approval is 403 approval_not_found, and the approval check is not asked', async () => {
    const { s, alfa, bravo, send } = await setup();
    const reply = await send(rankingBody(TENANT, alfa.did, bravo.did, null));
    refused(reply, 403, 'approval_not_found');
    expect(lastRule(s)).toBe('approval.missing');
    expect(s.harness.approvals).toEqual([]);
    expect(await written(s)).toEqual([]);
    expect((await send(rankingBody(TENANT, alfa.did, bravo.did))).status).toBe(201);
  });
  it('a body with no approval field is a bad request, and is not read as a null approval', async () => {
    const { s, send, body } = await setup();
    const { approval: _approval, ...without } = body();
    const reply = await send(without);
    refused(reply, 400, 'bad_request');
    expect(reply.json?.message).toBe('body.approval is required');
    expect(s.harness.approvals).toEqual([]);
  });
  it.each(APPROVAL_CODES)('the check says %s: the call is 403 with that code, the words of the check are the message, and nothing is written', async (code) => {
    const { s, send, body } = await setup();
    s.harness.answer = { ok: false, code, detail: `the check found: ${code}` };
    const reply = await send(body());
    refused(reply, 403, code);
    expect(reply.json?.message).toBe(`the check found: ${code}`);
    expect(lastRule(s)).toBe(`approval.${code}`);
    expect(await written(s)).toEqual([]);
    s.harness.answer = { ok: true };
    expect((await send(body())).status).toBe(201);
  });
  it('a check that throws, a check that answers in another shape and a code that the check does not have are 503, and nothing is written', async () => {
    const { s, send, body } = await setup();
    for (const answer of ['throw', 'garbage', { ok: false, code: 'approval_great', detail: 'x' }, { ok: false, code: 'not_covered', detail: 'x' }] as const) {
      s.harness.answer = answer as typeof s.harness.answer;
      refused(await send(body()), 503, 'approval_unavailable');
    }
    expect(await written(s)).toEqual([]);
    s.harness.answer = { ok: true };
    expect((await send(body())).status).toBe(201);
  });
  it('an approval with a field of the wrong form is a bad request, and the check is not asked', async () => {
    const { s, alfa, bravo, send } = await setup();
    for (const approval of [{ attestation: 'abc', issuer_did: `did:vector:${'b2'.repeat(32)}` }, { attestation: '07'.repeat(32), issuer_did: 'did:vector:x' }, 'yes', 7, [], {}]) {
      refused(await send(rankingBody(TENANT, alfa.did, bravo.did, approval as never)), 400, 'bad_request');
    }
    expect(s.harness.approvals).toEqual([]);
  });
});

describe('the supplier of rank 1', () => {
  it('a supplier whose record is suspended, revoked or retired is 403 supplier_not_active, and nothing is written', async () => {
    const { s, alfa, bravo, send } = await setup();
    for (const status of ['suspended', 'revoked', 'retired'] as const) {
      const desk = s.world.agent(`desk-${status}`);
      s.world.gateway.setStatus(desk, status);
      refused(await send(rankingBody(TENANT, desk.did, bravo.did)), 403, 'supplier_not_active');
      expect(lastRule(s)).toBe(status === 'suspended' ? 'supplier.status' : 'supplier.deactivated');
    }
    expect(await written(s)).toEqual([]);
    expect((await send(rankingBody(TENANT, alfa.did, bravo.did))).status).toBe(201);
  });
  it('a supplier that does not resolve is 403 supplier_not_active', async () => {
    const { s, bravo, send } = await setup();
    const unknown = `did:vector:${'ee'.repeat(32)}`;
    refused(await send(rankingBody(TENANT, unknown, bravo.did)), 403, 'supplier_not_active');
    expect(lastRule(s)).toBe('supplier.not_found');
  });
  it('only the supplier of rank 1 is looked at: a second-ranked supplier that is not Active does not stop the ranking, and a first-ranked one does', async () => {
    const { s, alfa, send } = await setup();
    const dead = s.world.agent('desk-dead');
    s.world.gateway.setStatus(dead, 'revoked');
    expect((await send(rankingBody(TENANT, alfa.did, dead.did))).status).toBe(201);
    refused(await send(rankingBody(TENANT, dead.did, alfa.did)), 403, 'supplier_not_active');
  });
  it('the approval check comes first: a ranking with a wrong approval and a supplier that is not Active is refused for the approval', async () => {
    const { s, bravo, send } = await setup();
    const dead = s.world.agent('desk-dead');
    s.world.gateway.setStatus(dead, 'revoked');
    s.harness.answer = { ok: false, code: 'approval_expired', detail: 'the approval is over' };
    refused(await send(rankingBody(TENANT, dead.did, bravo.did)), 403, 'approval_expired');
  });
  it('a gateway that cannot be read is 503, and the supplier never counts as Active because of it', async () => {
    const { s, alfa, bravo, send } = await setup();
    s.world.gateway.fault(`/1.0/identifiers/${alfa.did}`, 'network');
    refused(await send(rankingBody(TENANT, alfa.did, bravo.did)), 503, 'gateway_unavailable');
    expect(await written(s)).toEqual([]);
    s.world.gateway.fault(`/1.0/identifiers/${alfa.did}`, null);
    expect((await send(rankingBody(TENANT, alfa.did, bravo.did))).status).toBe(201);
  });
});

describe('the token and the body of the call', () => {
  it('no token is 401, and the approval check is not asked: a call with no authority never reaches it', async () => {
    const { s, body } = await setup();
    const none = await s.harness.call({ method: 'POST', path: `/t/${TENANT}${ROUTE}`, body: body() });
    refused(none, 401, 'token_invalid');
    expect(s.harness.approvals).toEqual([]);
  });
  it('a token for another action is 403 not_covered, and a token for a subagent chain is 403 chain_too_deep, and the approval check is not asked', async () => {
    const s = await scenario(TENANT);
    const alfa = s.world.agent('desk-alfa');
    const bravo = s.world.agent('desk-bravo');
    const reader = delegateTo(s, 'reader', [['vendor.read', 'sourcing']]);
    refused(await callWithToken(s, reader, 'sourcing', 'POST', ROUTE, rankingBody(TENANT, alfa.did, bravo.did)), 403, 'not_covered');
    const boss = delegateTo(s, 'boss', [['sourcing.award.write', 'sourcing']]);
    const sub = delegateTo(s, 'scorer', [['sourcing.award.write', 'sourcing']], { parent: boss.agent, parentDelegation: boss.delegation });
    refused(await callWithToken(s, sub, 'sourcing', 'POST', ROUTE, rankingBody(TENANT, alfa.did, bravo.did)), 403, 'chain_too_deep');
    expect(s.harness.approvals).toEqual([]);
  });
  it('a ranking of another tenant, with no rank 1, or with two, is a bad request, and the approval check is not asked', async () => {
    const { s, alfa, bravo, send, body } = await setup();
    refused(await send(rankingBody('run2', alfa.did, bravo.did)), 400, 'bad_request');
    const noTop = body();
    (noTop.ranking.ranked as Array<{ rank: number }>)[0]!.rank = 3;
    refused(await send(noTop), 400, 'bad_request');
    const twoTops = body();
    (twoTops.ranking.ranked as Array<{ rank: number }>)[1]!.rank = 1;
    refused(await send(twoTops), 400, 'bad_request');
    expect(s.harness.approvals).toEqual([]);
  });
  it('the approval is for the delegation of the token of the call, and not for one that the body names', async () => {
    const { s, agent, send, body } = await setup();
    const sent = { ...body(), delegation: 'aa'.repeat(32) };
    refused(await send(sent), 400, 'bad_request');
    expect((await send(body())).status).toBe(201);
    expect(s.harness.approvals.at(-1)!.delegation).toBe(agent.delegation.id);
  });
});

describe('a tenant that is made again while the approval is checked', () => {
  it('the ranking is not written to the new tenant, and the call is 409 tenant_changed', async () => {
    const { s, send, body } = await setup();
    const hold = s.harness.holdApproval();
    const held = send(body());
    await hold.asked;
    expect((await s.harness.seed(TENANT)).status).toBe(200);
    hold.release();
    refused(await held, 409, 'tenant_changed');
    expect(await written(s)).toEqual([]);
    expect((await send(body())).status).toBe(201);
  });
});

describe('the resource of the call', () => {
  it('is the exact URL of the sourcing system of the tenant, and nothing else is accepted for it', async () => {
    const { s, alfa, bravo, agent } = await setup();
    const url = `${PUBLIC_BASE}/t/${TENANT}/sourcing`;
    const credential = await s.world.token(agent.agent, agent.delegation, url);
    const headers = await s.world.presented(credential, 'POST', `${url}/rankings`);
    const reply = await s.harness.call({ method: 'POST', path: `/t/${TENANT}${ROUTE}`, headers, body: rankingBody(TENANT, alfa.did, bravo.did) });
    expect(reply.status, reply.text).toBe(201);
    const other = await s.world.token(agent.agent, agent.delegation, `${url}/`);
    refused(await s.harness.call({ method: 'POST', path: `/t/${TENANT}${ROUTE}`, headers: await s.world.presented(other, 'POST', `${url}/rankings`), body: rankingBody(TENANT, alfa.did, bravo.did) }), 401, 'token_invalid');
  });
});
