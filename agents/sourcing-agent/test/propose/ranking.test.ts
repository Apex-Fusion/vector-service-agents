// agents/sourcing-agent/test/propose/ranking.test.ts: how the job makes the ranking from what it holds. The model gives the order and nothing else: each entry takes its numbers from the scorer of its own
// bidder and its quote from the quote that the agent accepted, and a bidder that is not ranked is excluded with its reason. The organisation of a bidder enters the hire, the scorer and the ranking only when the
// gateway verified it. Each refusal has an accepted twin: the golden run.
import { describe, expect, it } from 'vitest';
import type { JsonValue } from '@vsa/usecase-kit/protocol';
import type { BidderView, QuoteOutcome } from '../../src/propose/index.ts';
import {
  ALFA, BRAVO, CHARLIE, DELTA, FIFTH, SIXTH, acceptedOf, candidates, decisionOf, excludedOf, fanOf, fileOf, goldenQuotes, goldenScoring, hex32, namesOf, proposed, quoteOf, rankAnswer, rankingOf,
  readGolden, receiptHash, recordOf, scoredOf, shortlistAnswer, viewOf, world,
} from './support.ts';

const NAMES = ['alfa', 'bravo', 'charlie'];

/** The golden run with another script for some ports. */
async function goldenWith(change: (w: ReturnType<typeof world>) => void) {
  const w = world();
  change(w);
  return { w, result: proposed(await w.run()) };
}

describe('the order', () => {
  it('is the order of the model and the rank is the position: a lower score ranks first when the model says so, and every entry keeps the numbers of its own bidder', async () => {
    const { result } = await goldenWith((w) => {
      w.script.rank = async () => rankAnswer([BRAVO, ALFA, CHARLIE]);
    });
    const ranked = rankingOf(result).ranked;
    expect(ranked.map((entry) => [entry.rank, entry.desk_did, entry.score])).toStrictEqual([[1, BRAVO, 70], [2, ALFA, 90], [3, CHARLIE, 80]]);
    for (const entry of ranked) expect(entry.components).toStrictEqual({ price: entry.score, lead_time: entry.score, reliability: entry.score, compliance: entry.score });
  });

  it('is the only thing that the model changes: another order gives the same entries, each with the quote that the agent holds', async () => {
    const first = rankingOf((await goldenWith(() => undefined)).result).ranked;
    const second = rankingOf((await goldenWith((w) => {
      w.script.rank = async () => rankAnswer([CHARLIE, BRAVO, ALFA]);
    })).result).ranked;
    expect(second.map((entry) => entry.desk_did)).toStrictEqual([CHARLIE, BRAVO, ALFA]);
    const byDid = (entries: typeof first) => new Map(entries.map(({ rank: _rank, ...entry }) => [entry.desk_did, entry]));
    expect(byDid(second)).toStrictEqual(byDid(first));
  });

  it('keeps the tie-break out of the ranking, and keeps it in the decision as the model wrote it', async () => {
    const { result } = await goldenWith((w) => {
      w.script.rank = async () => rankAnswer([ALFA, CHARLIE, BRAVO], 'The two lowest prices tie, so the lead time decides.');
    });
    expect(JSON.stringify(result.document)).not.toContain('tie');
    expect(result.decisions.at(-1)).toMatchObject({ name: 'ranking', choice: { order: [ALFA, CHARLIE, BRAVO], tie_break: 'The two lowest prices tie, so the lead time decides.' } });
    expect(result.document).toStrictEqual(readGolden('ranking'));
  });

  it('takes the order from the choice and nothing else: a model that adds a quote, a score or a list of entries to its choice changes nothing in the ranking', async () => {
    const extra = {
      order: [ALFA, CHARLIE, BRAVO],
      tie_break: '',
      quote: { escrow_ref: `${hex32(9)}#0`, receipt_sha256: hex32(9), total: 1, lead_time_days: 1 },
      ranked: [{ desk_did: BRAVO, rank: 1, score: 100, quote: { escrow_ref: `${hex32(8)}#0`, total: 2 } }],
    };
    const { result } = await goldenWith((w) => {
      w.script.rank = async () => ({ ok: true, decision: decisionOf('ranking', extra as JsonValue, 2), choice: extra as never });
    });
    expect(result.document).toStrictEqual(readGolden('ranking'));
    expect(result.decisions.at(-1)!.choice).toStrictEqual(extra);
  });
});

describe('the entry of a bidder', () => {
  it('has the score and the components that the scorer of that bidder gave, and no number of another bidder', async () => {
    const { result } = await goldenWith((w) => {
      w.script.scoring = async (input) => ({
        ok: true,
        scores: input.subjects.map((subject, index) => {
          const score = [55, 95, 75][index]!;
          return { did: subject.did, decision: scoredOf(subject.did, index + 1).decision, choice: { components: { price: score, lead_time: score - 5, reliability: score - 10, compliance: score - 15 }, score } };
        }),
      });
    });
    const byDid = new Map(rankingOf(result).ranked.map((entry) => [entry.desk_did, entry]));
    expect(byDid.get(ALFA)).toMatchObject({ score: 55, components: { price: 55, lead_time: 50, reliability: 45, compliance: 40 } });
    expect(byDid.get(BRAVO)).toMatchObject({ score: 95, components: { price: 95, lead_time: 90, reliability: 85, compliance: 80 } });
    expect(byDid.get(CHARLIE)).toMatchObject({ score: 75, components: { price: 75, lead_time: 70, reliability: 65, compliance: 60 } });
  });

  it('cites the quote that the agent holds: a change of the signed receipt of one record changes the hash of that entry only', async () => {
    const quote = quoteOf(ALFA, 'alfa.example');
    const record = recordOf(ALFA, 1, quote, { receipt: { escrow_ref: `${hex32(0x51)}#0`, model: 'another-model' } });
    const { result } = await goldenWith((w) => {
      w.script.quotes = async (input) =>
        fanOf(input.invited.map((bidder, index) => (index === 0 ? acceptedOf(ALFA, 1, 'alfa', { record }) : acceptedOf(bidder.did, index + 1, NAMES[index]!))));
    });
    const ranking = rankingOf(result);
    const entry = ranking.ranked.find((candidate) => candidate.desk_did === ALFA)!;
    expect(entry.quote.receipt_sha256).toBe(receiptHash(record));
    expect(entry.quote.receipt_sha256).not.toBe(receiptHash(recordOf(ALFA, 1, quote)));
    const goldenRanking = readGolden('ranking') as { ranked: { desk_did: string; quote: unknown }[] };
    for (const others of ranking.ranked.filter((candidate) => candidate.desk_did !== ALFA)) {
      expect(others.quote).toStrictEqual(goldenRanking.ranked.find((golden) => golden.desk_did === others.desk_did)!.quote);
    }
  });

  it('takes the total and the lead time from the parsed quote, and the escrow from the record of the job', async () => {
    const { result } = await goldenWith(() => undefined);
    for (const entry of rankingOf(result).ranked) {
      const index = [ALFA, BRAVO, CHARLIE].indexOf(entry.desk_did);
      const held = acceptedOf(entry.desk_did, index + 1, NAMES[index]!);
      expect(entry.quote).toMatchObject({ escrow_ref: held.record.escrow_ref, total: held.quote.total, lead_time_days: held.quote.lead_time_days });
    }
  });
});

describe('the organisation', () => {
  const unverified = (): BidderView[] => [
    viewOf(fileOf(ALFA, 1, 'alfa'), 1),
    viewOf(fileOf(BRAVO, 2, 'bravo', { organisation_verified: false }), 2),
    viewOf(fileOf(CHARLIE, 3, 'charlie', { organisation: null }), 3),
  ];

  it('goes to the hire, to the scorer and into the ranking only when the gateway verified it: a domain that a bidder states is none of them', async () => {
    const { w, result } = await goldenWith((world) => {
      world.script.discover = async () => ({ ok: true, value: { bidders: unverified() } });
    });
    expect(w.calls.quotes[0]!.input.invited.map((bidder) => bidder.organisation)).toStrictEqual(['alfa.example', null, null]);
    expect(w.calls.scoring[0]!.input.subjects.map((subject) => subject.organisation)).toStrictEqual(['alfa.example', null, null]);
    const ranked = rankingOf(result).ranked;
    expect(ranked.map((entry) => [entry.desk_did, Object.hasOwn(entry, 'organisation')])).toStrictEqual([[ALFA, true], [CHARLIE, false], [BRAVO, false]]);
    expect(JSON.stringify(result.document)).not.toContain('bravo.example');
  });

  it('still shows the approver the file of the bidder as it was read, with the stated domain and the flag that says that nobody verified it', async () => {
    const { result } = await goldenWith((world) => {
      world.script.discover = async () => ({ ok: true, value: { bidders: unverified() } });
    });
    expect(result.bidders[1]).toMatchObject({ did: BRAVO, organisation: 'bravo.example', organisation_verified: false });
  });

  it.each([['the text true', 'true'], ['the number 1', 1], ['nothing', undefined], ['null', null]])('does not read %s as a verified organisation', async (_name, flag) => {
    const { w, result } = await goldenWith((world) => {
      world.script.discover = async () => ({ ok: true, value: { bidders: [viewOf(fileOf(ALFA, 1, 'alfa', { organisation_verified: flag as never }), 1), ...candidates().slice(1)] } });
    });
    expect(w.calls.quotes[0]!.input.invited[0]!.organisation).toBeNull();
    expect(w.calls.scoring[0]!.input.subjects[0]!.organisation).toBeNull();
    expect(Object.hasOwn(rankingOf(result).ranked.find((entry) => entry.desk_did === ALFA)!, 'organisation')).toBe(false);
  });

  it('gives every bidder its domain when the gateway verified each one: the twin', async () => {
    const { w, result } = await goldenWith(() => undefined);
    expect(w.calls.quotes[0]!.input.invited.map((bidder) => bidder.organisation)).toStrictEqual(['alfa.example', 'bravo.example', 'charlie.example']);
    expect(rankingOf(result).ranked.map((entry) => entry.organisation)).toStrictEqual(['alfa.example', 'charlie.example', 'bravo.example']);
  });
});

describe('what the ports are given', () => {
  const unverifiedBravo = (): BidderView[] => [
    viewOf(fileOf(ALFA, 1, 'alfa'), 1),
    viewOf(fileOf(BRAVO, 2, 'bravo', { organisation_verified: false }), 2),
    viewOf(fileOf(CHARLIE, 3, 'charlie'), 3),
  ];

  it('is a copy that the job does not read again: ports that change the request, the weights, the files and the numbers that they got change nothing in the proposal', async () => {
    const baseline = await goldenWith((w) => {
      w.script.discover = async () => ({ ok: true, value: { bidders: unverifiedBravo() } });
    });
    const { result } = await goldenWith((w) => {
      w.script.discover = async () => ({ ok: true, value: { bidders: unverifiedBravo() } });
      w.script.shortlist = async (rfq, files) => {
        Object.assign(rfq, { needed_by: '2030-01-01' });
        Object.assign(files[0]!, { organisation_verified: false });
        return shortlistAnswer([ALFA, BRAVO, CHARLIE]);
      };
      w.script.quotes = async (input) => {
        Object.assign(input.rfq, { rfq_id: 'another-request' });
        Object.assign(input.invited[0]!, { organisation: 'attacker.example' });
        return goldenQuotes(input);
      };
      w.script.scoring = async (input) => {
        Object.assign(input.rfq, { needed_by: '2030-01-01' });
        Object.assign(input.weights, { price: 0.9 });
        Object.assign(input.subjects[1]!.file, { organisation: 'attacker.example', organisation_verified: true });
        Object.assign(input.subjects[0]!.quote, { total: 1 });
        return goldenScoring(input);
      };
      w.script.rank = async (input) => {
        const answer = rankAnswer([ALFA, CHARLIE, BRAVO]);
        Object.assign(input.weights, { price: 0.9 });
        Object.assign(input.scored[0]!, { score: 1 });
        Object.assign(input.scored[0]!.components, { price: 1 });
        return answer;
      };
    });
    expect(result.document).toStrictEqual(baseline.result.document);
    expect(result.bidders).toStrictEqual(baseline.result.bidders);
    expect(result.quotes).toStrictEqual(baseline.result.quotes);
    expect(Object.hasOwn(rankingOf(result).ranked.find((entry) => entry.desk_did === BRAVO)!, 'organisation')).toBe(false);
  });
});

describe('the excluded list', () => {
  const fourBidders = (): BidderView[] => [...candidates(), viewOf(fileOf(DELTA, 4, 'delta'), 4)];
  const challenge = { claim: `${hex32(0xcc)}#0`, evidence: hex32(0xee), challenge: `${hex32(0xcd)}#1` };

  /** The golden run with four candidates, the model inviting the given DIDs, and the fan-out giving the given outcomes. */
  function mixed(invite: readonly string[], outcomes: readonly QuoteOutcome[]) {
    return goldenWith((w) => {
      w.script.discover = async () => ({ ok: true, value: { bidders: fourBidders() } });
      w.script.shortlist = async () => shortlistAnswer(invite);
      w.script.quotes = async () => fanOf(outcomes);
    });
  }

  it('lists a bidder that the model did not invite as not_invited with no code, and hires only the invited: the model invites two of three', async () => {
    const { w, result } = await goldenWith((world) => {
      world.script.shortlist = async () => shortlistAnswer([CHARLIE, ALFA], [{ did: BRAVO, reason: 'The price list is old.' }]);
    });
    expect(w.calls.quotes[0]!.input.invited.map((bidder) => bidder.did)).toStrictEqual([CHARLIE, ALFA]);
    expect(w.calls.scoring[0]!.input.subjects.map((subject) => subject.did)).toStrictEqual([CHARLIE, ALFA]);
    const ranking = rankingOf(result);
    expect(ranking.ranked.map((entry) => entry.desk_did)).toStrictEqual([ALFA, CHARLIE]);
    expect(ranking.excluded).toStrictEqual([{ desk_did: BRAVO, reason: 'not_invited', code: null }]);
    expect(result.sub_jobs).toHaveLength(2);
    expect(result.bidders).toHaveLength(3);
    expect(namesOf(result.decisions)).toStrictEqual(['shortlist', 'accept_quote', 'accept_quote', 'score', 'score', 'ranking']);
  });

  it('lists a refused bidder with its refusal code, a disputed bidder with no code when the challenge was filed, and a bidder that the model did not invite: in the order of the candidates', async () => {
    const refused = excludedOf(BRAVO, 'refused', 'duplicate_rfq', { record: recordOf(BRAVO, 2, null, { receipt: null, receipt_signature: null, verification: null, result: null, accepted: null }) });
    const disputed = excludedOf(CHARLIE, 'disputed', null, {
      record: recordOf(CHARLIE, 3, quoteOf(CHARLIE, 'charlie.example'), { accepted: 'no', challenge }),
      decision: decisionOf('accept_quote', { accept: false, mismatch: ['GLV-NIT-M'] }, 13),
      challenge,
    });
    const { result } = await mixed([ALFA, BRAVO, CHARLIE], [acceptedOf(ALFA, 1, 'alfa'), refused, disputed]);
    const ranking = rankingOf(result);
    expect(ranking.ranked.map((entry) => entry.desk_did)).toStrictEqual([ALFA]);
    expect(ranking.excluded).toStrictEqual([
      { desk_did: BRAVO, reason: 'refused', code: 'duplicate_rfq' },
      { desk_did: CHARLIE, reason: 'disputed', code: null },
      { desk_did: DELTA, reason: 'not_invited', code: null },
    ]);
    // What was paid for stays: the decision of the declined quote is among the decisions, and each record that exists is among the quotes.
    expect(namesOf(result.decisions)).toStrictEqual(['shortlist', 'accept_quote', 'accept_quote', 'score', 'ranking']);
    expect(result.decisions[2]!.choice).toStrictEqual({ accept: false, mismatch: ['GLV-NIT-M'] });
    expect(result.quotes.map((record) => record.desk_did)).toStrictEqual([ALFA, BRAVO, CHARLIE]);
    expect(result.quotes[2]!.challenge).toStrictEqual(challenge);
    expect(result.sub_jobs).toHaveLength(1);
  });

  it('lists a bidder that was not active with its status, and a bidder that failed with its code', async () => {
    const { result } = await mixed([ALFA, BRAVO, CHARLIE], [acceptedOf(ALFA, 1, 'alfa'), excludedOf(BRAVO, 'not_active', 'suspended'), excludedOf(CHARLIE, 'failed', 'deadline')]);
    expect(rankingOf(result).excluded).toStrictEqual([
      { desk_did: BRAVO, reason: 'not_active', code: 'suspended' },
      { desk_did: CHARLIE, reason: 'failed', code: 'deadline' },
      { desk_did: DELTA, reason: 'not_invited', code: null },
    ]);
    expect(result.quotes.map((record) => record.desk_did)).toStrictEqual([ALFA]);
  });

  it('lists a disputed bidder with the code of the challenge that the agent could not file, and keeps the decision that declined the quote', async () => {
    const declined = decisionOf('accept_quote', { accept: false, mismatch: ['SYR-10ML'] }, 14);
    const disputed = excludedOf(BRAVO, 'disputed', 'no_open_claim', { decision: declined, record: recordOf(BRAVO, 2, quoteOf(BRAVO, 'bravo.example'), { accepted: 'no' }) });
    const { result } = await mixed([ALFA, BRAVO], [acceptedOf(ALFA, 1, 'alfa'), disputed]);
    expect(rankingOf(result).excluded).toStrictEqual([
      { desk_did: BRAVO, reason: 'disputed', code: 'no_open_claim' },
      { desk_did: CHARLIE, reason: 'not_invited', code: null },
      { desk_did: DELTA, reason: 'not_invited', code: null },
    ]);
    expect(result.decisions).toContainEqual(declined);
  });

  it('lists no bidder two times: a ranked bidder is never excluded', async () => {
    const { result } = await mixed([ALFA, BRAVO, CHARLIE], [acceptedOf(ALFA, 1, 'alfa'), excludedOf(BRAVO, 'not_active', 'retired'), acceptedOf(CHARLIE, 3, 'charlie')]);
    const ranking = rankingOf(result);
    const ranked = new Set(ranking.ranked.map((entry) => entry.desk_did));
    for (const entry of ranking.excluded) expect(ranked.has(entry.desk_did)).toBe(false);
    expect(ranking.excluded).toStrictEqual([{ desk_did: BRAVO, reason: 'not_active', code: 'retired' }, { desk_did: DELTA, reason: 'not_invited', code: null }]);
  });

  it('lists a bidder of each reason in one run: the model invites five of six, and each outcome and the bidder that was not invited have their place, in the order of the candidates', async () => {
    const bidders = [...fourBidders(), viewOf(fileOf(FIFTH, 5, 'fifth'), 5), viewOf(fileOf(SIXTH, 6, 'sixth'), 6)];
    const disputed = excludedOf(FIFTH, 'disputed', null, {
      record: recordOf(FIFTH, 5, quoteOf(FIFTH, 'fifth.example'), { accepted: 'no', challenge }),
      decision: decisionOf('accept_quote', { accept: false, mismatch: ['GLV-NIT-M'] }, 15),
      challenge,
    });
    const { result } = await goldenWith((w) => {
      w.script.discover = async () => ({ ok: true, value: { bidders } });
      w.script.shortlist = async () => shortlistAnswer([ALFA, BRAVO, CHARLIE, DELTA, FIFTH]);
      w.script.quotes = async () =>
        fanOf([acceptedOf(ALFA, 1, 'alfa'), excludedOf(BRAVO, 'not_active', 'suspended'), excludedOf(CHARLIE, 'refused', 'duplicate_rfq'), excludedOf(DELTA, 'failed', 'deadline'), disputed]);
    });
    expect(rankingOf(result).ranked.map((entry) => entry.desk_did)).toStrictEqual([ALFA]);
    expect(rankingOf(result).excluded).toStrictEqual([
      { desk_did: BRAVO, reason: 'not_active', code: 'suspended' },
      { desk_did: CHARLIE, reason: 'refused', code: 'duplicate_rfq' },
      { desk_did: DELTA, reason: 'failed', code: 'deadline' },
      { desk_did: FIFTH, reason: 'disputed', code: null },
      { desk_did: SIXTH, reason: 'not_invited', code: null },
    ]);
    expect(result.bidders).toHaveLength(6);
  });
});
