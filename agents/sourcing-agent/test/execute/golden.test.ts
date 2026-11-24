// agents/sourcing-agent/test/execute/golden.test.ts: the golden run of `execute`. The agent writes the ranking that the hirer approved to the sourcing record of its tenant, with one token and one call, and the
// result is the golden result. The job makes no model call, no hire and no vault payment. The body that the record gets is the ranking exactly as the hirer holds it, the salt and the approval.
import { describe, expect, it } from 'vitest';
import { parseRanking } from '@vsa/usecase-kit/bids';
import { proposalDigest } from '@vsa/usecase-kit/protocol';
import { APPROVAL, SALT, TENANT, golden } from './fixtures.ts';
import { DELEGATION, ONE_CALL, footprint, words, world } from './world.ts';

describe('the golden run', () => {
  it('writes the ranking that the hirer approved, and the result is the golden result: completed, no hire, no decision, and the one write', async () => {
    const w = world();
    const request = w.request();
    const result = await w.run(request);
    expect(words(result)).toBe('completed none Completed');
    expect(result).toStrictEqual(golden('completed'));
    expect(result.proposal_digest).toBe(request.proposal.proposal_digest);
    expect(result.handoff).toBeNull();
    expect(result.decisions).toStrictEqual([]);
    expect(footprint(w)).toStrictEqual(ONE_CALL);
    expect(w.record.written).toHaveLength(1);
  });

  it('holds the golden files together: the digest of both results is the digest of the golden ranking with the salt, and the parser of the kit takes the ranking', () => {
    expect(proposalDigest(SALT, golden('ranking'))).toStrictEqual({ ok: true, value: golden('completed').proposal_digest });
    expect(golden('refused-null-approval').proposal_digest).toBe(golden('completed').proposal_digest);
    expect(parseRanking(golden('ranking')).ok).toBe(true);
  });

  it('has a golden ranking whose members are not in the order that the parser of the kit writes them, so that a ranking built again from its parts would be other bytes', () => {
    const parsed = parseRanking(golden('ranking'));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(JSON.stringify(parsed.value)).not.toBe(JSON.stringify(golden('ranking')));
    expect(proposalDigest(SALT, parsed.value)).toStrictEqual(proposalDigest(SALT, golden('ranking')));
  });

  it('calls the sourcing record of the tenant of the request one time, with a POST, a DPoP token and a JSON body', async () => {
    const w = world();
    await w.run();
    expect(w.record.calls).toHaveLength(1);
    const [call] = w.record.calls;
    expect([call?.method, call?.url]).toStrictEqual(['POST', `https://mock.example/t/${TENANT}/sourcing/rankings`]);
    expect(call?.headers.authorization).toMatch(/^DPoP /);
    expect(call?.headers.dpop).toBeTypeOf('string');
    expect(call?.headers['content-type']).toBe('application/json');
  });

  it('sends the body as the request holds it: ranking, salt and approval, in this order, the ranking as the text of the document and the approval as given', async () => {
    const w = world();
    const request = w.request();
    await w.run(request);
    const text = JSON.stringify(request.proposal.document);
    expect(text).toBe(JSON.stringify(w.document()));
    expect(w.record.calls[0]?.body).toBe(`{"ranking":${text},"salt":"${SALT}","approval":{"attestation":"${APPROVAL.attestation}","issuer_did":"${APPROVAL.issuer_did}"}}`);
  });

  it('sends a ranking and a salt that the digest of the proposal covers: the record gets the ranking that the hirer approved', async () => {
    const w = world();
    const request = w.request();
    await w.run(request);
    const sent = JSON.parse(w.record.calls[0]?.body ?? '') as { ranking: unknown; salt: unknown };
    expect(proposalDigest(sent.salt, sent.ranking)).toStrictEqual({ ok: true, value: request.proposal.proposal_digest });
  });

  it('asks the gateway for one token, for the action and the resource of the sourcing record under the delegation of the request, as this agent', async () => {
    const w = world();
    await w.run();
    expect(w.tokens).toHaveLength(1);
    const asked = w.tokens[0]!;
    expect(asked.answer.ok).toBe(true);
    expect(asked.request.subject.did).toBe(w.agent.did);
    expect(asked.request.resource).toBe(w.target.resource);
    expect(w.target.resource).toBe(`https://mock.example/t/${TENANT}/sourcing`);
    expect(asked.request.delegation).toStrictEqual({ identifier: DELEGATION, actions: ['sourcing.award.write'], locations: [w.target.resource] });
  });

  it('reads the delegation and no vault: it pays nothing', async () => {
    const w = world();
    await w.run();
    expect(w.reads.calls).toStrictEqual({ delegation: 1, liveVaults: 0 });
  });
});
