// agents/sourcing-agent/test/execute/approval.test.ts: the approval in the job `execute`. The job never makes, replaces, defaults or checks an approval. It passes the reference on as the request gave it, or the
// member with the value `null`, and the sourcing record refuses what is not right. A ranking that the hirer did not approve is never written: the body holds the ranking and the salt that the digest of the
// proposal covers. Each refusal has its twin that is accepted.
import { describe, expect, it } from 'vitest';
import { exitStateOf, makeProposal, parseRequest, proposalDigest } from '@vsa/usecase-kit/protocol';
import { APPROVAL, PRINCIPAL_DID, SALT, golden } from './fixtures.ts';
import { DELEGATION, ONE_CALL, footprint, jsonResponse, words, world } from './world.ts';

describe('a request with an approval', () => {
  it('sends the reference as the request gave it: the attestation and the issuer, and no other member, and the record writes the ranking', async () => {
    const w = world();
    const request = w.request();
    const result = await w.run(request);
    expect(words(result)).toBe('completed none Completed');
    const sent = JSON.parse(w.record.calls[0]?.body ?? '') as { approval: unknown };
    expect(sent.approval).toStrictEqual(request.approval);
    expect(sent.approval).toStrictEqual(APPROVAL);
    expect(w.record.written).toHaveLength(1);
  });

  it('does not judge the approval: a reference of another issuer than the delegator goes on as it is, and the record decides', async () => {
    const other = { attestation: '44'.repeat(32), issuer_did: `did:vector:${'c3'.repeat(32)}` };
    const allowed = world();
    const request = allowed.request(allowed.document(), other);
    expect(request.authority.principal_did).toBe(PRINCIPAL_DID);
    expect(words(await allowed.run(request))).toBe('completed none Completed');
    expect(JSON.parse(allowed.record.calls[0]?.body ?? '')).toMatchObject({ approval: other });
    // The twin: the record refuses the same reference with its own code, and the job says so.
    const refused = world();
    refused.record.answer = () => jsonResponse(403, { error: 'approval_wrong_issuer', message: 'words of the record' });
    const result = await refused.run(refused.request(refused.document(), other));
    expect(words(result)).toBe('refused_by_system approval_wrong_issuer Rejected');
    expect(JSON.parse(refused.record.calls[0]?.body ?? '')).toMatchObject({ approval: other });
    expect(refused.record.written).toHaveLength(0);
  });
});

describe('a request with no approval', () => {
  it('sends the member with the value null: the record refuses it with approval_not_found, nothing is written, and the result is the golden refusal with the exit state Rejected', async () => {
    const w = world();
    const request = w.request(w.document(), null);
    const result = await w.run(request);
    expect(request.approval).toBeNull();
    expect(words(result)).toBe('refused_by_system approval_not_found Rejected');
    expect(result).toStrictEqual(golden('refused-null-approval'));
    expect(result.exit_state).toBe(exitStateOf({ outcome: 'refused_by_system', reason: 'approval_not_found', challenge_filed: false, delegation_ended: false }));
    expect(footprint(w)).toStrictEqual(ONE_CALL);
    expect(w.record.written).toHaveLength(0);
    const body = w.record.calls[0]?.body ?? '';
    expect(Object.keys(JSON.parse(body) as object)).toStrictEqual(['ranking', 'salt', 'approval']);
    expect(body.endsWith(',"approval":null}')).toBe(true);
  });

  it('does not check the approval itself: a record that takes a ranking with no approval gets it, and the job says completed', async () => {
    const w = world();
    w.record.answer = () => jsonResponse(201, { ranking_id: 'RK-run1-0001' });
    const result = await w.run(w.request(w.document(), null));
    expect(words(result)).toBe('completed none Completed');
    expect(w.record.calls[0]?.body.endsWith(',"approval":null}')).toBe(true);
  });
});

describe('the ranking that the hirer approved', () => {
  it('is the document of the proposal as the hirer holds it: not rebuilt from its parts, so the member order of the document stays', async () => {
    const w = world();
    const request = w.request();
    await w.run(request);
    const body = w.record.calls[0]?.body ?? '';
    // The golden ranking lists its members in an order that the parser of the kit does not write: a ranking built again would start with `schema`.
    expect(body.startsWith('{"ranking":{"tenant":"run1","excluded":[')).toBe(true);
    expect(body).toContain(JSON.stringify(request.proposal.document));
  });

  it('is sent with the salt of the proposal, which is not made again', async () => {
    const w = world();
    await w.run();
    const sent = JSON.parse(w.record.calls[0]?.body ?? '') as { salt: unknown };
    expect(sent.salt).toBe(SALT);
  });

  it('cannot differ from its digest: a request whose digest is the digest of another document never reaches the job, because the parser of the protocol refuses it', () => {
    const proposal = makeProposal(golden('ranking'), SALT);
    expect(proposal.ok).toBe(true);
    if (!proposal.ok) return;
    const other = proposalDigest(SALT, { ...golden('ranking'), rfq_id: 'run1-rfq-2' });
    expect(other.ok).toBe(true);
    if (!other.ok) return;
    const forged = parseRequest({ op: 'execute', authority: { principal_did: PRINCIPAL_DID, delegation: DELEGATION }, tenant: 'run1', proposal: { ...proposal.value, proposal_digest: other.value }, approval: APPROVAL });
    expect(forged.ok).toBe(false);
    // The twin: the digest of the document itself is accepted.
    const honest = parseRequest({ op: 'execute', authority: { principal_did: PRINCIPAL_DID, delegation: DELEGATION }, tenant: 'run1', proposal: proposal.value, approval: APPROVAL });
    expect(honest.ok).toBe(true);
  });
});
