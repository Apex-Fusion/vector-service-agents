// agents/sourcing-agent/test/quotes/codes.test.ts: the closed list of the codes of the quote fan-out. Every failure is run, each end of a hire as a step that the test builds and each end of the decision as the answer of the
// hook, and the codes that the runs gave (the `reason` and the `code` of each excluded bidder, and the code of `stopped`) are held equal to `QUOTE_CODES`, in both directions. The one code that the list does not hold is
// the code of a decision that failed when the decision port gave it: the kit lists those codes. A reason of a failed hire that no list holds is `inconsistent_outcome`.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AcceptDecision } from '@vsa/hire-kit';
import type * as Buyer from '@vsa/usecase-kit/buyer';
import type { HireInput, HireStep, VerifiedDelivery } from '@vsa/usecase-kit/buyer';
import { COUNTERPARTY_REFUSALS, RECEIPT_CHECKS } from '@vsa/usecase-kit/protocol';
import type { HandoffRecord, JsonObject } from '@vsa/usecase-kit/protocol';
import { sha256Utf8Hex } from '@vsa/vector-read';
import { QUOTE_CODES, runQuotes } from '../../src/quotes/index.ts';
import type { BidderToHire, QuotesDeps, QuotesInput, QuotesResult } from '../../src/quotes/index.ts';
import { CHALLENGE_CODES, FAILED_STEP_REASONS, INTERRUPTION_CODES, NOT_ACTIVE_STATUSES } from '../../src/quotes/ports.ts';
import { ALFA, BRAVO, DELEGATION, RFQ, ScriptedAccept, ScriptedDispute, SENDER_DID, acceptDecision, bidderOf, challengeNotFiled, priced, quoteDocument, quoteText } from './support.ts';

/** What the hire of a test answers: a function of the input of the hire, which holds the decision hook of the fan-out. */
const script = vi.hoisted(() => ({ answer: null as ((input: HireInput) => Promise<HireStep> | HireStep) | null }));

vi.mock('@vsa/usecase-kit/buyer', async (importOriginal) => {
  const real = await importOriginal<typeof Buyer>();
  return {
    ...real,
    hireCounterparty: async (_deps: unknown, input: HireInput): Promise<HireStep> => {
      if (script.answer === null) throw new Error('the test gave no answer for the hire');
      return script.answer(input);
    },
  };
});

afterEach(() => { script.answer = null; });

const T0 = 1_790_000_000_000;
const ESCROW = `${'ab'.repeat(32)}#0`;
const VAULT = `${'ac'.repeat(32)}#1`;
const TERMS = { price_lovelace: '200000', supplier_bond_lovelace: '1000000', buyer_bond_lovelace: '1000000', locked_lovelace: '2261030', paid_to_supplier_at_accept_lovelace: '1200000' };

/** The codes that the runs gave. */
const seen = new Set<string>();

function handoff(accepted: HandoffRecord['accepted']): HandoffRecord {
  return { counterparty_did: BRAVO.did, advert_ref: BRAVO.advertRef, escrow_ref: ESCROW, paid_from_vault: true, receipt: null, receipt_signature: null, verification: null, result: null, accepted };
}

const step = (members: object): HireStep => members as unknown as HireStep;
const paid = (accepted: HandoffRecord['accepted'] = null): { handoff: HandoffRecord; vault_ref: string; terms: typeof TERMS } => ({ handoff: handoff(accepted), vault_ref: VAULT, terms: TERMS });

/** A delivery that passed the eight checks, as the decision of a use case gets it. `text` is the answer of the bidder. */
function deliveryOf(text: string, receipt: JsonObject = { escrow_ref: ESCROW, supplier_pkh: '5a'.repeat(28), response_hash: sha256Utf8Hex(text), agent_did: BRAVO.did }): VerifiedDelivery {
  let result: JsonObject | null = null;
  try {
    const parsed: unknown = JSON.parse(text);
    result = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as JsonObject) : null;
  } catch {
    result = null;
  }
  return {
    escrow_ref: ESCROW, advert_ref: BRAVO.advertRef, text, result, receipt, receipt_signature: '9c'.repeat(64),
    verification: Object.fromEntries(RECEIPT_CHECKS.map((check) => [check, true])) as VerifiedDelivery['verification'],
  };
}

/** The step that the hire kit gives for the answer of the decision hook to a delivery. */
function stepOfAnswer(answer: AcceptDecision, delivery: VerifiedDelivery): HireStep {
  const held = { ...paid(answer.accept ? 'confirmed' : 'no') };
  held.handoff = { ...held.handoff, receipt: delivery.receipt, receipt_signature: delivery.receipt_signature, verification: delivery.verification, result: delivery.result };
  return answer.accept
    ? step({ kind: 'completed', delivery, booking_failed: null, ...held })
    : step({ kind: 'not_accepted', why: 'declined', declined: answer.reason, delivery, ...held });
}

interface Setup {
  readonly accept: ScriptedAccept;
  readonly dispute: ScriptedDispute;
  readonly invited: readonly BidderToHire[];
  readonly recheck: QuotesDeps['recheck'];
  readonly signal?: AbortSignal;
  readonly deadline: number;
}

/** A run with the hire that `answer` gives. The ports are scripted, and the deps that only a real hire reads are empty. */
async function run(answer: (input: HireInput) => Promise<HireStep> | HireStep, over: Partial<Setup> = {}): Promise<{ result: QuotesResult; accept: ScriptedAccept; dispute: ScriptedDispute }> {
  const setup: Setup = { accept: new ScriptedAccept(), dispute: new ScriptedDispute(SENDER_DID), invited: [bidderOf(BRAVO)], recheck: async () => 'active', deadline: T0 + 3_420_000, ...over };
  script.answer = answer;
  const deps: QuotesDeps = {
    key: {} as never, hire: {} as never, reads: {} as never,
    limits: { maxPriceLovelace: 1_000_000n, maxSupplierBondLovelace: 2_000_000n, maxBuyerBondLovelace: 2_000_000n },
    recheck: setup.recheck, acceptQuote: setup.accept.acceptQuote, dispute: setup.dispute, buyerPkhs: ['c9'.repeat(28)], clock: () => T0, log: () => undefined,
  };
  const input: QuotesInput = { rfq: RFQ, sender: SENDER_DID, delegation: DELEGATION, invited: setup.invited, deadline_ms: setup.deadline, keep_ms: 840_000 };
  const result = await runQuotes(deps, input, setup.signal);
  for (const outcome of result.outcomes) {
    if (outcome.kind === 'excluded') {
      seen.add(outcome.reason);
      if (outcome.code !== null) seen.add(outcome.code);
    }
  }
  return { result, accept: setup.accept, dispute: setup.dispute };
}

/** The word of the first outcome: the reason and the code. */
const wordOf = (result: QuotesResult, index = 0): string => {
  const outcome = result.outcomes[index];
  if (outcome === undefined) return 'no outcome';
  return outcome.kind === 'accepted' ? 'accepted' : `${outcome.reason} ${outcome.code ?? 'none'}`;
};

/** The hire that gives `text` as the answer of the bidder to the decision hook. */
const answering = (text: string, receipt?: JsonObject) => async (input: HireInput): Promise<HireStep> => {
  const delivery = deliveryOf(text, receipt);
  return stepOfAnswer(await input.decide(delivery), delivery);
};

describe('a bidder that is not paid', () => {
  it('gives aborted, deadline, no_price_list, each status word and status_unreadable, and no hire is made for any of them', async () => {
    const hire = vi.fn();
    const controller = new AbortController();
    controller.abort();
    expect(wordOf((await run(hire, { signal: controller.signal })).result)).toBe('failed aborted');
    expect(wordOf((await run(hire, { deadline: T0 })).result)).toBe('failed deadline');
    expect(wordOf((await run(hire, { invited: [bidderOf(BRAVO, { price_list: null })] })).result)).toBe('failed no_price_list');
    for (const word of NOT_ACTIVE_STATUSES) expect(wordOf((await run(hire, { recheck: async () => word })).result)).toBe(`not_active ${word}`);
    expect(wordOf((await run(hire, { recheck: async () => 'unreadable' })).result)).toBe('failed status_unreadable');
    expect(wordOf((await run(hire, { recheck: async () => { throw new Error('no answer'); } })).result)).toBe('failed status_unreadable');
    expect(hire).not.toHaveBeenCalled();
  });
});

describe('the answer of the bidder and the decision of the model', () => {
  it('gives each check in code, the code of the delivery that cannot be recorded, and no question to the model for any of them', async () => {
    const bad = (over: Record<string, unknown>): string => JSON.stringify(quoteDocument(BRAVO, undefined, over));
    const CASES: ReadonlyArray<readonly [string, string, JsonObject | undefined]> = [
      ['quote_invalid', 'this is not a quote', undefined],
      ['quote_not_from_bidder', JSON.stringify(quoteDocument(ALFA)), undefined],
      ['quote_not_for_rfq', bad({ rfq_id: 'run1-rfq-2' }), undefined],
      ['quote_not_from_list', bad({ price_list_sha256: 'ee'.repeat(32) }), undefined],
      ['delivery_not_recordable', quoteText(BRAVO), { escrow_ref: ESCROW, supplier_pkh: 'no key hash', response_hash: '00', agent_did: BRAVO.did }],
    ];
    for (const [code, text, receipt] of CASES) {
      const { result, accept, dispute } = await run(answering(text, receipt));
      expect(wordOf(result)).toBe(`failed ${code}`);
      expect(accept.calls).toHaveLength(0);
      expect(dispute.calls).toHaveLength(0);
      expect(result.stopped).toBeNull();
    }
  });

  it('stops the loop for a decision that fails, with the code that the reader of the answer gives or the code that the port gives, and the bidders after it are not_attempted', async () => {
    const FAILURES: ReadonlyArray<readonly [string, () => unknown, string]> = [
      ['answer_missing', () => 'yes', 'answer_missing'],
      ['answer_invalid', () => ({ decision: acceptDecision(true) }), 'answer_invalid'],
      ['choice_invalid', () => ({ ok: true, decision: acceptDecision(true), choice: { accept: 'yes', mismatch: [] } }), 'choice_invalid'],
      ['choice_not_recorded', () => ({ ok: true, decision: acceptDecision(false, ['SYR-10ML']), choice: { accept: true, mismatch: [] } }), 'choice_not_recorded'],
      ['decision_threw', () => { throw new Error('the port broke'); }, 'decision_threw'],
      ['invalid_code', () => ({ ok: false, code: 'Not A Code!' }), 'invalid_code'],
      ['a code of the port', () => ({ ok: false, code: 'llm_busy' }), 'llm_busy'],
    ];
    for (const [what, answer, code] of FAILURES) {
      const accept = new ScriptedAccept();
      accept.answer = answer;
      const { result } = await run(answering(quoteText(BRAVO)), { accept, invited: [bidderOf(BRAVO), bidderOf(ALFA)] });
      expect(result.outcomes.map((_, index) => wordOf(result, index)), what).toStrictEqual(['failed decision_failed', 'failed not_attempted']);
      expect(result.stopped, what).toStrictEqual({ code });
      // The code that the decision port gives is a code of the kit: it is the only code that the list does not hold.
      if (what !== 'a code of the port') seen.add(code);
    }
  });

  it('gives no_evidence, port_error and each code of the challenge for a no of the model, and null for a challenge that was filed', async () => {
    const declined = quoteText(BRAVO, priced('SYR-10ML', 30));
    const named = (...skus: string[]): ScriptedAccept => {
      const accept = new ScriptedAccept();
      accept.answer = () => ({ ok: true, decision: acceptDecision(false, skus), choice: { accept: false, mismatch: skus } });
      return accept;
    };
    expect(wordOf((await run(answering(declined), { accept: named('XYZ-9') })).result)).toBe('disputed no_evidence');
    expect(wordOf((await run(answering(declined))).result)).toBe('disputed none');
    const throwing = new ScriptedDispute(SENDER_DID);
    throwing.failWith = new Error('the chain port broke');
    expect(wordOf((await run(answering(declined), { dispute: throwing })).result)).toBe('disputed port_error');
    for (const code of CHALLENGE_CODES) {
      const dispute = new ScriptedDispute(SENDER_DID);
      dispute.answer = () => challengeNotFiled(code);
      expect(wordOf((await run(answering(declined), { dispute })).result)).toBe(`disputed ${code}`);
    }
    const accepted = await run(answering(quoteText(BRAVO)));
    expect(wordOf(accepted.result)).toBe('accepted');
  });
});

describe('each end of a hire', () => {
  it('gives each refusal code of a Bid Desk as refused, and the reason of the step for every other failed hire', async () => {
    for (const code of COUNTERPARTY_REFUSALS['bid-desk']) {
      expect(wordOf((await run(() => step({ kind: 'refused_by_counterparty', reason: code, source: 'before_claim', runtime_status: 403, ...paid() }))).result)).toBe(`refused ${code}`);
    }
    for (const reason of FAILED_STEP_REASONS) {
      expect(wordOf((await run(() => step({ kind: 'failed', reason, detail: 'the detail', handoff: null, vault_ref: null, terms: null }))).result)).toBe(`failed ${reason}`);
    }
  });

  it('gives inconsistent_outcome for a reason that no list holds, for a refusal that the protocol does not list for a Bid Desk, and for a hire that says completed with no acceptance of the model', async () => {
    expect(wordOf((await run(() => step({ kind: 'failed', reason: 'Not A Code', detail: 'x', handoff: null, vault_ref: null, terms: null }))).result)).toBe('failed inconsistent_outcome');
    expect(wordOf((await run(() => step({ kind: 'refused_by_counterparty', reason: 'lot_mismatch', source: 'before_claim', runtime_status: 403, ...paid() }))).result)).toBe('failed inconsistent_outcome');
    expect(wordOf((await run(() => step({ kind: 'completed', delivery: deliveryOf(quoteText(BRAVO)), booking_failed: null, ...paid('confirmed') }))).result)).toBe('failed inconsistent_outcome');
  });

  it('gives vault_refused, pay_unconfirmed, each reason of an interrupted hire, each code of a refusal of the flow, decision_timeout and delivery_not_recordable', async () => {
    const vault = step({ kind: 'vault_refused', reason: 'evaluation error', refusal: 'ledger', delegation: 'live', delegation_ended: false, evidence: { transaction_body: null }, handoff: null });
    expect(wordOf((await run(() => vault)).result)).toBe('failed vault_refused');
    const unconfirmed = step({ kind: 'pay_unconfirmed', detail: 'x', escrow_ref: ESCROW, vault_ref_if_landed: VAULT, tx_hash: 'ab'.repeat(32), may_land: true, valid_to: T0 + 1, handoff: handoff(null), cause: null });
    expect(wordOf((await run(() => unconfirmed)).result)).toBe('failed pay_unconfirmed');
    expect(INTERRUPTION_CODES.size).toBe(4);
    for (const [cause, code] of [['deadline', 'deadline'], ['store_write', 'store_write_failed'], ['decision_error', 'decision_error'], ['other', 'hire_interrupted']] as const) {
      const interrupted = step({ kind: 'interrupted', cause_kind: cause, detail: 'x', vault_ref: VAULT, escrow_ref: ESCROW, handoff: handoff(null), delivery: null, cause: new Error('x') });
      expect(wordOf((await run(() => interrupted)).result)).toBe(`failed ${code}`);
    }
    for (const code of ['delegation_not_mine', 'request_too_large', 'bad_shape', 'internal']) {
      expect(wordOf((await run(() => step({ kind: 'refused', code, detail: 'x' }))).result)).toBe(`failed ${code}`);
    }
    const timeout = step({ kind: 'not_accepted', why: 'decision_timeout', declined: null, delivery: deliveryOf(quoteText(BRAVO)), ...paid('no') });
    expect(wordOf((await run(() => timeout)).result)).toBe('failed decision_timeout');
    const unrecorded = step({ kind: 'not_accepted', why: 'not_recordable', declined: null, delivery: null, unrecorded: { escrow_ref: ESCROW, advert_ref: BRAVO.advertRef, supplier_pkh: '5a'.repeat(28) }, ...paid('no') });
    expect(wordOf((await run(() => unrecorded)).result)).toBe('failed delivery_not_recordable');
  });

  it('gives internal and stops the loop when a hire throws, and keeps what was paid for the bidders before it', async () => {
    let calls = 0;
    const { result } = await run(async (input) => {
      calls += 1;
      if (calls === 2) throw new Error('a fault of the hire');
      return answering(quoteText(ALFA))(input);
    }, { invited: [bidderOf(ALFA), bidderOf(BRAVO), bidderOf(ALFA)] });
    expect(result.outcomes.map((_, index) => wordOf(result, index))).toStrictEqual(['accepted', 'failed internal', 'failed not_attempted']);
    expect(result.stopped).toStrictEqual({ code: 'internal' });
  });
});

describe('the list', () => {
  it('holds exactly the codes that the failures gave, in both directions', () => {
    // The tests above ran first in this file, and each put the codes that it saw in `seen`.
    expect([...seen].sort()).toStrictEqual([...QUOTE_CODES].sort());
  });

  it('is frozen, holds each code once, and holds only codes in the form that a ranking takes', () => {
    expect(Object.isFrozen(QUOTE_CODES)).toBe(true);
    expect(new Set(QUOTE_CODES).size).toBe(QUOTE_CODES.length);
    for (const code of QUOTE_CODES) expect(code).toMatch(/^[a-z0-9_]{1,64}$/);
  });
});
