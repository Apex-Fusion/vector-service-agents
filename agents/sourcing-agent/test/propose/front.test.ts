// agents/sourcing-agent/test/propose/front.test.ts: the steps of `propose` before the quotes: the request, the authority, the delegation key, the bidders and the shortlist. Each refusal and each failure has
// an accepted twin. After a failure of the steps 1 to 3 nothing was paid, and after a failure of the shortlist the decision that the model made stays in the result, with the files of the bidders.
import { describe, expect, it } from 'vitest';
import { ERROR_STATUS } from '@vsa/usecase-kit/protocol';
import type { JsonValue } from '@vsa/usecase-kit/protocol';
import { ProposeRefusal } from '../../src/propose/index.ts';
import {
  ALFA, BRAVO, CHARLIE, DELEGATION, DELTA, KEY, KEY_HASH, PRINCIPAL_DID, RFQ, TENANT, WEIGHTS, arrivedWith, candidates, decisionOf, expectFailed, failure, fileOf, shortlistAnswer, thrownBy, viewOf, world,
} from './support.ts';

describe('the request', () => {
  it.each(['Run1', 'run_1', 'run.1', '-run', 'x'.repeat(49)])('refuses the tenant %s, which the ranking cannot hold, as bad_shape and before it does anything', async (tenant) => {
    const w = world();
    const refusal = await thrownBy(w.front({ request: { tenant } }));
    expect(refusal).toBeInstanceOf(ProposeRefusal);
    expect(refusal).toMatchObject({ name: 'ProposeRefusal', code: 'bad_shape', status: ERROR_STATUS.bad_shape });
    expect((refusal as ProposeRefusal).message).not.toContain(tenant);
    expect(w.trace).toStrictEqual([]);
  });

  it('takes the longest tenant that the ranking can hold: the twin', async () => {
    const tenant = 'x'.repeat(48);
    const w = world();
    expect((await w.front({ request: { tenant } })).ok).toBe(true);
    expect(w.trace).toContain('shortlist');
  });

  it('refuses weights that the kit refuses, and a request for quotation that it refuses, as bad_shape, and names the member', async () => {
    const wrongWeights = { price: 0.5, lead_time: 0.5, reliability: 0.5, compliance: 0.5 };
    const w = world();
    const weights = await thrownBy(w.front({ request: { weights: wrongWeights } }));
    expect(weights).toBeInstanceOf(ProposeRefusal);
    expect(weights).toMatchObject({ code: 'bad_shape', status: 400 });
    expect((weights as ProposeRefusal).message).toContain('request.weights');
    const noItems = await thrownBy(w.front({ request: { rfq: { ...RFQ, items: [] } } }));
    expect(noItems).toBeInstanceOf(ProposeRefusal);
    expect((noItems as ProposeRefusal).message).toContain('request.rfq');
    expect(w.trace).toStrictEqual([]);
    expect((await w.front({ request: { weights: WEIGHTS, rfq: RFQ } })).ok).toBe(true);
  });
});

describe('the authority', () => {
  it('refuses a delegation that names another agent as its delegate, with the status of its code, before it reads the key or sends anything', async () => {
    const w = world();
    const other = 'ff'.repeat(32);
    w.script.delegation = async () => ({ delegate: other, chain_whole: true });
    const refusal = await thrownBy(w.front());
    expect(refusal).toBeInstanceOf(ProposeRefusal);
    expect(refusal).toMatchObject({ name: 'ProposeRefusal', code: 'delegation_not_mine', status: ERROR_STATUS.delegation_not_mine });
    expect(ERROR_STATUS.delegation_not_mine).toBe(400);
    const message = (refusal as ProposeRefusal).message;
    expect(message).toMatch(/names another agent/);
    for (const value of [other, DELEGATION, TENANT, PRINCIPAL_DID]) expect(message).not.toContain(value);
    expect(w.trace).toStrictEqual(['delegation']);
  });

  it('goes on for a delegation that names this agent: the twin', async () => {
    const w = world();
    expect((await w.front()).ok).toBe(true);
    expect(w.trace).toStrictEqual(['delegation', 'delegateKeyOf', 'discover', 'shortlist']);
  });

  it('fails with ledger_unavailable when the delegation cannot be read, or the reading is not a reading, and goes no further', async () => {
    for (const read of [
      async () => {
        throw new Error('the ledger is down');
      },
      async () => ({}) as never,
      async () => 'a text' as never,
    ]) {
      const w = world();
      w.script.delegation = read;
      failure(await w.front(), 'ledger_unavailable');
      expect(w.trace).toStrictEqual(['delegation']);
    }
  });

  it('goes on for a delegation that the first read does not show, because the read of the key decides: the key is found, and the job goes on', async () => {
    const w = world();
    w.script.delegation = async () => null;
    expect((await w.front()).ok).toBe(true);
  });

  it('fails with delegation_not_found when the ledger shows no delegation and no key, and sends nothing: no file, no decision, no record', async () => {
    const w = world();
    w.script.delegation = async () => null;
    w.script.delegateKeyOf = async () => null;
    const result = failure(await w.front(), 'delegation_not_found');
    expect(result).toMatchObject({ decisions: [], sub_jobs: [], bidders: [], quotes: [] });
    expect(w.trace).toStrictEqual(['delegation', 'delegateKeyOf']);
  });

  it('fails with deadline when the ledger gives no answer until the deadline, and calls no other port', async () => {
    const w = world();
    w.script.delegation = () => new Promise(() => undefined);
    failure(await w.front({ arrivedAt: arrivedWith(30) }), 'deadline');
    expect(w.trace).toStrictEqual(['delegation']);
  });

  it('fails with aborted for a caller that hung up before the job started, and calls no port: the twin goes on', async () => {
    const controller = new AbortController();
    controller.abort();
    const w = world();
    failure(await w.front({ signal: controller.signal }), 'aborted');
    expect(w.trace).toStrictEqual([]);
    expect((await world().front({ signal: new AbortController().signal })).ok).toBe(true);
  });

  it('fails with deadline for a job that arrived after its deadline, and for a clock that gives no time, and calls no port', async () => {
    const late = world();
    failure(await late.front({ arrivedAt: arrivedWith(-1) }), 'deadline');
    expect(late.trace).toStrictEqual([]);
    for (const clock of [() => Number.NaN, () => { throw new Error('no clock'); }]) {
      const w = world();
      failure(await w.front({ deps: { clock } }), 'deadline');
      expect(w.trace).toStrictEqual([]);
    }
  });
});

describe('the delegation key', () => {
  it('fails with ledger_unavailable when the key of the delegation cannot be read, and reads no bidder', async () => {
    const w = world();
    w.script.delegateKeyOf = async () => {
      throw new Error('the ledger is down');
    };
    failure(await w.front(), 'ledger_unavailable');
    expect(w.trace).toStrictEqual(['delegation', 'delegateKeyOf']);
  });

  it('fails with delegation_key_unknown for a key that this agent does not hold, and for a value that is no key hash, and reads no bidder', async () => {
    for (const value of ['ee'.repeat(28), 42 as never]) {
      const w = world();
      w.script.delegateKeyOf = async () => value;
      failure(await w.front(), 'delegation_key_unknown');
      expect(w.trace).toStrictEqual(['delegation', 'delegateKeyOf']);
    }
  });

  it('fails with internal when the table of the keys throws, and goes on when it holds the key: the twin gives that entry on', async () => {
    const w = world();
    w.script.findKey = () => {
      throw new Error('the table is broken');
    };
    failure(await w.front(), 'internal');
    const twin = await world().front();
    expect(twin.ok && twin.front.key).toBe(KEY);
  });

  it('fails with deadline when the ledger gives no key until the deadline', async () => {
    const w = world();
    w.script.delegateKeyOf = () => new Promise(() => undefined);
    failure(await w.front({ arrivedAt: arrivedWith(30) }), 'deadline');
    expect(w.trace).toStrictEqual(['delegation', 'delegateKeyOf']);
  });
});

describe('the bidders', () => {
  it('reads the signal before the discovery: a caller that hangs up during the read of the key is `aborted`, and nothing is discovered', async () => {
    const controller = new AbortController();
    const w = world();
    w.script.delegateKeyOf = async () => {
      controller.abort();
      return KEY_HASH;
    };
    failure(await w.front({ signal: controller.signal }), 'aborted');
    expect(w.trace).not.toContain('discover');
  });

  it.each(['bidders_unavailable', 'no_bidders'] as const)('fails with %s, the code of the discovery, with no file, no decision and no record, and asks the model nothing', async (code) => {
    const w = world();
    w.script.discover = async () => ({ ok: false, code, detail: 'words that the reader wrote' });
    const result = failure(await w.front(), code);
    expect(result).toMatchObject({ decisions: [], sub_jobs: [], bidders: [], quotes: [] });
    expect(JSON.stringify(result)).not.toContain('words that the reader wrote');
    expect(w.trace).not.toContain('shortlist');
  });

  it('does not pass on a code that the discovery does not have, and turns the words of a port into internal', async () => {
    for (const code of ['supplier_unavailable', 'Not listed, sorry']) {
      const w = world();
      w.script.discover = async () => ({ ok: false, code: code as never, detail: 'words' });
      failure(await w.front(), 'internal');
      expect(w.trace).not.toContain('shortlist');
    }
  });

  const SEEN = candidates();
  const WRONG: [string, unknown][] = [
    ['nothing', undefined],
    ['a text', 'a text'],
    ['no list of bidders', { ok: true, value: {} }],
    ['bidders that are not a list', { ok: true, value: { bidders: 'a text' } }],
    ['a bidder that is no object', { ok: true, value: { bidders: [null] } }],
    ['a bidder with no file', { ok: true, value: { bidders: [{ price_list: null }] } }],
    ['a file with a DID that is no DID', { ok: true, value: { bidders: [{ ...SEEN[0], file: { ...SEEN[0]!.file, did: 'did:vector:abc' } }] } }],
    ['a file with an advert that is no reference', { ok: true, value: { bidders: [{ ...SEEN[0], file: { ...SEEN[0]!.file, advert_ref: 'a text' } }] } }],
    ['a price list that is a text', { ok: true, value: { bidders: [{ ...SEEN[0], price_list: 'a text' }] } }],
    ['one DID two times', { ok: true, value: { bidders: [SEEN[0], SEEN[0]] } }],
    ['21 bidders', { ok: true, value: { bidders: Array.from({ length: 21 }, (_, index) => viewOf(fileOf(`did:vector:${index.toString(16).padStart(2, '0').repeat(32)}`, index, 'x'), index)) } }],
  ];
  it.each(WRONG)('fails with internal when the discovery gives %s as its answer, and asks the model nothing', async (_name, value) => {
    const w = world();
    w.script.discover = async () => value as never;
    failure(await w.front(), 'internal');
    expect(w.trace).not.toContain('shortlist');
  });

  it('fails with internal when the discovery throws, and with deadline when it gives no answer until the deadline', async () => {
    const throwing = world();
    throwing.script.discover = async () => {
      throw new Error('the reader broke');
    };
    failure(await throwing.front(), 'internal');
    const silent = world();
    silent.script.discover = () => new Promise(() => undefined);
    failure(await silent.front({ arrivedAt: arrivedWith(30) }), 'deadline');
    expect(silent.trace).not.toContain('shortlist');
  });

  it('gives the files of the candidates to the model, in the order of the discovery: the twin of every failure above', async () => {
    const w = world();
    expect((await w.front()).ok).toBe(true);
    expect(w.trace).toStrictEqual(['delegation', 'delegateKeyOf', 'discover', 'shortlist']);
    expect(w.calls.shortlist[0]!.files.map((file) => file.did)).toStrictEqual([ALFA, BRAVO, CHARLIE]);
    expect(w.calls.shortlist[0]!.rfq).toStrictEqual(RFQ);
  });
});

describe('the shortlist', () => {
  it('asks the model once, with two arguments: the request and the files. It never gives the signal to a decision', async () => {
    const w = world();
    await w.front({ signal: new AbortController().signal });
    expect(w.calls.shortlist).toHaveLength(1);
    expect(w.calls.shortlist[0]!.argc).toBe(2);
  });

  it('reads the signal before the decision: a caller that hangs up during the discovery is `aborted`, the model is not asked, and the files stay in the result', async () => {
    const controller = new AbortController();
    const w = world();
    w.script.discover = async () => {
      controller.abort();
      return { ok: true, value: { bidders: candidates() } };
    };
    const result = failure(await w.front({ signal: controller.signal }), 'aborted');
    expect(w.trace).not.toContain('shortlist');
    expect(result.bidders.map((file) => file.did)).toStrictEqual([ALFA, BRAVO, CHARLIE]);
  });

  it('fails with deadline when the discovery ends after the deadline, and the model is not asked', async () => {
    const w = world();
    w.script.discover = async () => {
      w.clock.ms += 3_420_000;
      return { ok: true, value: { bidders: candidates() } };
    };
    const result = failure(await w.front(), 'deadline');
    expect(w.trace).not.toContain('shortlist');
    expect(result.bidders).toHaveLength(3);
  });

  it('fails with the code of a failed decision, keeps the files, and holds no decision, because a failed decision has none in the result', async () => {
    const w = world();
    w.script.shortlist = async () => ({ ok: false, code: 'llm_out_of_time' });
    const result = failure(await w.front(), 'llm_out_of_time');
    expect(result).toMatchObject({ decisions: [], sub_jobs: [], quotes: [] });
    expect(result.bidders.map((file) => file.did)).toStrictEqual([ALFA, BRAVO, CHARLIE]);
    expect(w.logs).toStrictEqual(['propose stopped at shortlist: llm_out_of_time']);
  });

  it('turns a code that has the form of words into internal, and an answer that is no answer, and a decision with no sub-job, into internal with no decision', async () => {
    const words = world();
    words.script.shortlist = async () => ({ ok: false, code: 'The model said no.' });
    failure(await words.front(), 'internal');
    for (const value of [undefined, 'a text', { ok: true, decision: {}, choice: { invite: [ALFA], not_invited: [] } }, { ok: true, decision: { ...shortlistAnswer([ALFA]).decision, inference: null }, choice: {} }]) {
      const w = world();
      w.script.shortlist = async () => value as never;
      expect(failure(await w.front(), 'internal').decisions).toStrictEqual([]);
    }
  });

  it('fails with deadline when the decision gives no answer until the deadline, and keeps the files', async () => {
    const w = world();
    w.script.shortlist = () => new Promise(() => undefined);
    const result = failure(await w.front({ arrivedAt: arrivedWith(30) }), 'deadline');
    expect(result.bidders).toHaveLength(3);
    expect(result.decisions).toStrictEqual([]);
  });

  it('fails with decision_mismatch when the typed choice is not the recorded choice, and keeps the decision as it is recorded', async () => {
    const w = world();
    const recorded = shortlistAnswer([ALFA, BRAVO]);
    w.script.shortlist = async () => ({ ok: true, decision: recorded.decision, choice: { invite: [CHARLIE], not_invited: [] } });
    const result = failure(await w.front(), 'decision_mismatch');
    expect(result.decisions).toStrictEqual([recorded.decision]);
    expect(w.trace).not.toContain('quotes');
  });

  it('fails with bad_document when a choice is no JSON, and keeps the decision', async () => {
    const w = world();
    const given = shortlistAnswer([ALFA]);
    w.script.shortlist = async () => ({ ok: true, decision: { ...given.decision, choice: undefined as never }, choice: given.choice });
    const result = failure(await w.front(), 'bad_document');
    expect(result.decisions).toHaveLength(1);
  });

  it('fails with shortlist_unknown_bidder when the model invites a DID that is no candidate, keeps the decision and the files, and hires nobody', async () => {
    const w = world();
    const answer = shortlistAnswer([ALFA, DELTA]);
    w.script.shortlist = async () => answer;
    const result = failure(await w.front(), 'shortlist_unknown_bidder');
    expect(result.decisions).toStrictEqual([answer.decision]);
    expect(result.bidders.map((file) => file.did)).toStrictEqual([ALFA, BRAVO, CHARLIE]);
    expect(result.quotes).toStrictEqual([]);
    expect(w.trace).not.toContain('quotes');
  });

  it('fails with shortlist_unknown_bidder for an entry that is no DID at all, and goes on when the DID is a candidate: the twin', async () => {
    const w = world();
    const answer = shortlistAnswer(['a text']);
    w.script.shortlist = async () => answer;
    failure(await w.front(), 'shortlist_unknown_bidder');
    const twin = world();
    twin.script.shortlist = async () => shortlistAnswer([BRAVO]);
    expect((await twin.front()).ok).toBe(true);
  });

  it('fails with nobody_invited when the model invites nobody, and keeps the decision and the files', async () => {
    const w = world();
    const answer = shortlistAnswer([], [{ did: ALFA, reason: 'The record is new.' }]);
    w.script.shortlist = async () => answer;
    const result = failure(await w.front(), 'nobody_invited');
    expect(result.decisions).toStrictEqual([answer.decision]);
    expect(result.bidders).toHaveLength(3);
    expect(w.logs).toStrictEqual(['propose stopped at shortlist: nobody_invited']);
  });

  const WRONG: [string, unknown][] = [
    ['no `invite`', { not_invited: [] }],
    ['an `invite` that is no list', { invite: ALFA, not_invited: [] }],
    ['an `invite` with an entry that is no text', { invite: [ALFA, 7], not_invited: [] }],
    ['one DID two times', { invite: [ALFA, ALFA], not_invited: [] }],
    ['four DIDs', { invite: [ALFA, BRAVO, CHARLIE, DELTA], not_invited: [] }],
  ];
  it.each(WRONG)('fails with bad_document when the recorded choice has %s, keeps the decision, and hires nobody', async (_name, choice) => {
    const w = world();
    w.script.discover = async () => ({ ok: true, value: { bidders: [...candidates(), viewOf(fileOf(DELTA, 4, 'delta'), 4)] } });
    w.script.shortlist = async () => ({ ok: true, decision: decisionOf('shortlist', choice as JsonValue, 1), choice: choice as never });
    const result = failure(await w.front(), 'bad_document');
    expect(result.decisions).toHaveLength(1);
    expect(w.trace).not.toContain('quotes');
  });

  it('goes on with the DIDs that the model invites, in the order that it gave them, and keeps the decision as it was recorded: the twin of every failure above', async () => {
    const w = world();
    const answer = shortlistAnswer([CHARLIE, ALFA], [{ did: BRAVO, reason: 'The price list is old.' }]);
    w.script.shortlist = async () => answer;
    const fronted = await w.front();
    if (!fronted.ok) throw new Error('the front steps stopped');
    expect(fronted.front.invite).toStrictEqual([CHARLIE, ALFA]);
    expect(fronted.front.key).toBe(KEY);
    expect(fronted.front.job.decisions).toStrictEqual([answer.decision]);
    expect(fronted.front.job.bidders.map((file) => file.did)).toStrictEqual([ALFA, BRAVO, CHARLIE]);
    expect(fronted.front.candidates.map((candidate) => candidate.file.did)).toStrictEqual([ALFA, BRAVO, CHARLIE]);
  });

  it('keeps its own copies of the files: a model call that changes the files that it got changes neither the result nor the candidates', async () => {
    const w = world();
    w.script.shortlist = async (_rfq, files) => {
      Object.assign(files[0]!, { organisation: 'attacker.example' });
      return shortlistAnswer([ALFA]);
    };
    const fronted = await w.front();
    if (!fronted.ok) throw new Error('the front steps stopped');
    expect(fronted.front.job.bidders[0]!.organisation).toBe('alfa.example');
    expect(fronted.front.candidates[0]!.file.organisation).toBe('alfa.example');
  });
});

