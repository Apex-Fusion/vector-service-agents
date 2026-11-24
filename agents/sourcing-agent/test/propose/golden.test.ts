// agents/sourcing-agent/test/propose/golden.test.ts: the golden run of `propose`. Three bidders are invited, the model accepts the three quotes, three scorers score them, and the model orders them. The ranking
// is the golden file `golden/ranking.json`, the rest of the result is `golden/proposal.json`, and the digest of the proposal covers the ranking. The ports are scripted, so the tests read what the job gave to
// each of them.
import { describe, expect, it } from 'vitest';
import { parseQuote, parseRanking } from '@vsa/usecase-kit/bids';
import { PROPOSAL_SCHEMA, parseProposal, proposalDigest } from '@vsa/usecase-kit/protocol';
import { PROPOSE_DEADLINE_MS, RANKING_RESERVE_MS, SCORING_RESERVE_MS } from '../../src/propose/index.ts';
import {
  AGENT_DID, ALFA, BRAVO, CHARLIE, DELEGATION, KEY, NOW, REQUEST, RFQ, TENANT, WEIGHTS, acceptedOf, candidates, namesOf, proposed, rankingOf, readGolden, receiptHash, recordOf, rfqHash, scoredOf, shortlistAnswer,
  world,
} from './support.ts';

describe('the golden run', () => {
  it('proposes the ranking of the golden file, and the ranking is one that the kit takes', async () => {
    const result = proposed(await world().run());
    expect(result.document).toStrictEqual(readGolden('ranking'));
    expect(parseRanking(result.document).ok).toBe(true);
    expect(result.document.rfq_sha256).toBe(rfqHash());
  });

  it('gives a digest that covers the ranking: it is the digest of the salt and the document, and the hirer can approve it', async () => {
    const result = proposed(await world().run());
    expect(result.salt).toMatch(/^[0-9a-f]{64}$/);
    expect(proposalDigest(result.salt, result.document)).toStrictEqual({ ok: true, value: result.proposal_digest });
    expect(parseProposal({ document: result.document, salt: result.salt, proposal_digest: result.proposal_digest }).ok).toBe(true);
  });

  it('is the golden result: the members of the kit, and then the files of the bidders and the records of the quote jobs', async () => {
    const result = proposed(await world().run());
    expect(result).toMatchObject({ schema: PROPOSAL_SCHEMA, use_case: 'bid-evaluation', outcome: 'proposed', exit_state: null, reason: null, fault_mode: '' });
    const { document: _document, salt: _salt, proposal_digest: _digest, ...rest } = result;
    expect(JSON.parse(JSON.stringify(rest))).toStrictEqual(readGolden('proposal'));
    expect(Object.keys(result).slice(-2)).toStrictEqual(['bidders', 'quotes']);
  });

  it('keeps the decisions in the order of the page: the shortlist, each acceptance in the order of the quotes, each score, and the ranking', async () => {
    const result = proposed(await world().run());
    expect(namesOf(result.decisions)).toStrictEqual(['shortlist', 'accept_quote', 'accept_quote', 'accept_quote', 'score', 'score', 'score', 'ranking']);
    expect(result.decisions.slice(1, 4)).toStrictEqual([ALFA, BRAVO, CHARLIE].map((did, index) => acceptedOf(did, index + 1, ['alfa', 'bravo', 'charlie'][index]!).decision));
    expect(result.decisions.slice(4, 7)).toStrictEqual([ALFA, BRAVO, CHARLIE].map((did, index) => scoredOf(did, index + 1).decision));
  });

  it('lists the three quote jobs as the sub-jobs, in the order of the quotes, and no job of a decision', async () => {
    const result = proposed(await world().run());
    expect(result.sub_jobs.map((job) => job.capability_id)).toStrictEqual(Array(3).fill('supplychain.rfq.quote.v1'));
    expect(result.sub_jobs).toStrictEqual([ALFA, BRAVO, CHARLIE].map((did, index) => acceptedOf(did, index + 1, ['alfa', 'bravo', 'charlie'][index]!).sub_job));
    const paidForDecisions = new Set(result.decisions.map((decision) => decision.inference.sub_job.escrow_ref));
    for (const job of result.sub_jobs) expect(paidForDecisions.has(job.escrow_ref)).toBe(false);
  });

  it('holds the file of every candidate and the record of every quote job, as the job read them', async () => {
    const result = proposed(await world().run());
    expect(result.bidders).toStrictEqual(candidates().map((view) => view.file));
    expect(result.quotes).toStrictEqual([ALFA, BRAVO, CHARLIE].map((did, index) => recordOf(did, index + 1, acceptedOf(did, index + 1, ['alfa', 'bravo', 'charlie'][index]!).quote)));
  });

  it('cites in each entry the quote that the agent accepted: the escrow of its record, the hash of its signed receipt, and the total and the lead time of its quote', async () => {
    const result = proposed(await world().run());
    for (const entry of rankingOf(result).ranked) {
      const index = [ALFA, BRAVO, CHARLIE].indexOf(entry.desk_did);
      const held = acceptedOf(entry.desk_did, index + 1, ['alfa', 'bravo', 'charlie'][index]!);
      expect(entry.quote).toStrictEqual({
        escrow_ref: held.record.escrow_ref,
        receipt_sha256: receiptHash(held.record),
        total: held.quote.total,
        lead_time_days: held.quote.lead_time_days,
      });
    }
  });

  it('uses quotes that the kit takes as quotes: the fixtures of the tests are real documents', () => {
    for (const [index, did] of [ALFA, BRAVO, CHARLIE].entries()) expect(parseQuote(acceptedOf(did, index + 1, ['alfa', 'bravo', 'charlie'][index]!).quote).ok).toBe(true);
  });

  it('calls the ports in order, once each: the delegation, its key, the discovery, the shortlist, the fan-out, the scoring and the ranking decision', async () => {
    const w = world();
    proposed(await w.run());
    expect(w.trace).toStrictEqual(['delegation', 'delegateKeyOf', 'discover', 'shortlist', 'quotes', 'scoring', 'rank']);
  });

  it('hires the invited bidders in the order of the model, with the deadline of the job and the time that it keeps for the scoring, and gives the signal of the caller to the fan-out', async () => {
    const w = world();
    const controller = new AbortController();
    proposed(await w.run({ signal: controller.signal }));
    expect(w.calls.quotes).toHaveLength(1);
    const call = w.calls.quotes[0]!;
    expect(call.input).toStrictEqual({
      rfq: RFQ,
      sender: AGENT_DID,
      delegation: DELEGATION,
      invited: candidates().map((view) => ({ did: view.file.did, advert_ref: view.file.advert_ref, organisation: view.file.organisation, price_list: view.price_list })),
      deadline_ms: NOW + PROPOSE_DEADLINE_MS,
      keep_ms: SCORING_RESERVE_MS,
    });
    expect(call.key).toBe(KEY);
    expect(call.argc).toBe(3);
    expect(call.signal).toBe(controller.signal);
  });

  it('gives each scorer one accepted quote, in the order of the quotes, with the date of the job and the weights of the request, and the signal of the caller', async () => {
    const w = world();
    const controller = new AbortController();
    proposed(await w.run({ signal: controller.signal }));
    expect(w.calls.scoring).toHaveLength(1);
    const call = w.calls.scoring[0]!;
    expect(call.input).toMatchObject({ tenant: TENANT, delegation: DELEGATION, today: '2026-11-24', weights: WEIGHTS, rfq: RFQ, deadline_ms: NOW + PROPOSE_DEADLINE_MS - RANKING_RESERVE_MS });
    expect(call.input.subjects.map((subject) => subject.did)).toStrictEqual([ALFA, BRAVO, CHARLIE]);
    expect(call.input.subjects.map((subject) => subject.quote)).toStrictEqual([ALFA, BRAVO, CHARLIE].map((did, index) => acceptedOf(did, index + 1, ['alfa', 'bravo', 'charlie'][index]!).quote));
    expect(call.input.subjects.map((subject) => subject.file)).toStrictEqual(candidates().map((view) => view.file));
    expect(call.key).toBe(KEY);
    expect(call.signal).toBe(controller.signal);
  });

  it('asks the ranking decision once, with the weights and the numbers of each scored bidder, and never gives it the signal', async () => {
    const w = world();
    proposed(await w.run({ signal: new AbortController().signal }));
    expect(w.calls.rank).toHaveLength(1);
    expect(w.calls.rank[0]!.argc).toBe(1);
    expect(w.calls.rank[0]!.input).toStrictEqual({
      weights: WEIGHTS,
      scored: [
        { desk_did: ALFA, score: 90, components: { price: 90, lead_time: 90, reliability: 90, compliance: 90 }, total: 58000, lead_time_days: 7 },
        { desk_did: BRAVO, score: 70, components: { price: 70, lead_time: 70, reliability: 70, compliance: 70 }, total: 55900, lead_time_days: 10 },
        { desk_did: CHARLIE, score: 80, components: { price: 80, lead_time: 80, reliability: 80, compliance: 80 }, total: 60100, lead_time_days: 6 },
      ],
    });
  });

  it('makes each proposal on its own: a second job has a new salt and a new digest for the same ranking', async () => {
    const w = world();
    const first = proposed(await w.run());
    const second = proposed(await w.run());
    expect(second.document).toStrictEqual(first.document);
    expect(second.salt).not.toBe(first.salt);
    expect(second.proposal_digest).not.toBe(first.proposal_digest);
  });

  it('ranks two bidders when the discovery gives two and the model invites both', async () => {
    const w = world();
    w.script.discover = async () => ({ ok: true, value: { bidders: candidates().slice(0, 2) } });
    w.script.shortlist = async () => shortlistAnswer([ALFA, BRAVO]);
    const result = proposed(await w.run());
    expect(rankingOf(result).ranked.map((entry) => [entry.rank, entry.desk_did])).toStrictEqual([[1, ALFA], [2, BRAVO]]);
    expect(rankingOf(result).excluded).toStrictEqual([]);
    expect(namesOf(result.decisions)).toStrictEqual(['shortlist', 'accept_quote', 'accept_quote', 'score', 'score', 'ranking']);
    expect(result.sub_jobs).toHaveLength(2);
    expect(result.bidders).toHaveLength(2);
  });

  it('takes the request that it is given: the tenant and the request for quotation are those of the ranking', async () => {
    const result = proposed(await world().run({ request: { tenant: 'tenant-two' } }));
    expect(result.document).toMatchObject({ tenant: 'tenant-two', rfq_id: REQUEST.rfq.rfq_id });
  });
});
