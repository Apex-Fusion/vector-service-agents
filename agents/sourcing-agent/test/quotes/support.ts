// agents/sourcing-agent/test/quotes/support.ts
// The documents that the tests of the quote fan-out share: the request for quotation, the price list, the three bidders, the quote that a bidder signs, the decision of the model, and the answers of the
// two ports that the fan-out calls (the model and the challenge). No value is a key. A document is a plain object that a test changes with `over`, so that a test names what it changes.
import { PRICE_LIST_SCHEMA, lineChecks, parsePriceList, parseQuote, parseRfqDocument, priceListSha256, quoteTotals, rfqSha256 } from '@vsa/usecase-kit/bids';
import type { PriceList, Quote, RfqDocument } from '@vsa/usecase-kit/bids';
import { evidenceDocument } from '@vsa/usecase-kit/dispute';
import type { ChallengeFiled, ChallengeNotFiled, ChallengeResult, DeliveryChallengeInput, DocumentCode, JurorDocument } from '@vsa/usecase-kit/dispute';
import { RECEIPT_CHECKS } from '@vsa/usecase-kit/protocol';
import type { ChallengeRecord, Decision, DelegationId, JsonObject, ProtocolResult, SubJob } from '@vsa/usecase-kit/protocol';
import type { AcceptQuoteAnswer, BidderToHire } from '../../src/quotes/index.ts';

export const SENDER_ID = 'a1'.repeat(32);
export const SENDER_DID = `did:vector:${SENDER_ID}`;
export const PRINCIPAL_DID = `did:vector:${'b2'.repeat(32)}`;
export const DELEGATION: DelegationId = 'dd'.repeat(32);

/** The value of a result that the test expects to be accepted. */
export function must<T>(result: ProtocolResult<T, string>): T {
  if (!result.ok) throw new Error(`the document of the test is refused: ${result.detail}`);
  return result.value;
}

// --- The request and the price list ---------------------------------------------------------------------------------------------------------------------------------

export const RFQ: RfqDocument = must(parseRfqDocument({
  rfq_id: 'run1-rfq-1', items: [{ sku: 'GLV-NIT-M', quantity: 100 }, { sku: 'SYR-10ML', quantity: 250 }, { sku: 'MSK-N95', quantity: 40 }], needed_by: '2026-12-20',
}));

const LIST_DOCUMENT = {
  schema: PRICE_LIST_SCHEMA,
  items: [
    { sku: 'GLV-NIT-M', lead_time_days: 14, breaks: [{ min_quantity: 1, unit_price: 140 }, { min_quantity: 50, unit_price: 132 }, { min_quantity: 100, unit_price: 125 }, { min_quantity: 500, unit_price: 112 }] },
    { sku: 'SYR-10ML', lead_time_days: 10, breaks: [{ min_quantity: 1, unit_price: 42 }, { min_quantity: 250, unit_price: 36 }, { min_quantity: 1000, unit_price: 31 }] },
    { sku: 'MSK-N95', lead_time_days: 21, breaks: [{ min_quantity: 1, unit_price: 65 }, { min_quantity: 25, unit_price: 60 }, { min_quantity: 100, unit_price: 54 }, { min_quantity: 1000, unit_price: 47 }] },
  ],
};
/** The text of the price list as the bidders serve it, and the hash of that text. */
export const LIST_TEXT = JSON.stringify(LIST_DOCUMENT);
export const LIST_SHA = priceListSha256(LIST_TEXT);
export const LIST: PriceList = must(parsePriceList(JSON.parse(LIST_TEXT)));

// --- The bidders --------------------------------------------------------------------------------------------------------------------------------------------------------

export interface DeskSpec {
  readonly name: 'alfa' | 'bravo' | 'charlie';
  /** The agent id: 64 hex characters, the id in the DID. */
  readonly id: string;
  readonly did: string;
  readonly organisation: string;
  /** An https IP literal of the documentation range: the clients reach a supplier only through a fetch that looks no host up. */
  readonly endpoint: string;
  readonly advertRef: string;
}

const desk = (name: DeskSpec['name'], byte: string, endpoint: string, advert: string): DeskSpec => ({
  name, id: byte.repeat(32), did: `did:vector:${byte.repeat(32)}`, organisation: `${name}.example.org`, endpoint, advertRef: `${advert.repeat(32)}#0`,
});
export const ALFA = desk('alfa', 'a2', 'https://203.0.113.51', 'c4');
export const BRAVO = desk('bravo', 'a3', 'https://203.0.113.52', 'c5');
export const CHARLIE = desk('charlie', 'a4', 'https://203.0.113.53', 'c6');
export const DESKS: readonly DeskSpec[] = [ALFA, BRAVO, CHARLIE];

/** The bidder as the job hires it: the file names its advert and its organisation, and the job read its price list. */
export function bidderOf(spec: DeskSpec, over: Partial<BidderToHire> = {}): BidderToHire {
  return { did: spec.did, advert_ref: spec.advertRef, organisation: spec.organisation, price_list: { list: LIST, sha256: LIST_SHA }, ...over };
}

// --- The quote ----------------------------------------------------------------------------------------------------------------------------------------------------------

export interface Chosen { sku: string; quantity: number; unit_price: number; lead_time_days: number }
export const GLV: Chosen = { sku: 'GLV-NIT-M', quantity: 100, unit_price: 125, lead_time_days: 14 };
export const SYR: Chosen = { sku: 'SYR-10ML', quantity: 250, unit_price: 36, lead_time_days: 10 };
export const MSK: Chosen = { sku: 'MSK-N95', quantity: 40, unit_price: 60, lead_time_days: 21 };
/** The three lines of the request at the prices of the list. */
export const LISTED: readonly Chosen[] = [GLV, SYR, MSK];

const SUB_JOB: SubJob = {
  capability_id: 'llm.text.generate.v1', advert_ref: `${'b3'.repeat(32)}#0`, escrow_ref: `${'4c'.repeat(32)}#0`, supplier_pkh: '7d'.repeat(28),
  receipt: {
    escrow_ref: `${'4c'.repeat(32)}#0`, supplier_pkh: '7d'.repeat(28), prompt_hash: '33'.repeat(32), response_hash: '44'.repeat(32), model: 'deepseek/deepseek-v4-flash', prompt_tokens: 412, completion_tokens: 58, wallclock_ms: 2140,
  },
  receipt_signature: '8e'.repeat(64),
  verification: Object.fromEntries(RECEIPT_CHECKS.map((check) => [check, true])) as SubJob['verification'],
};

/** A decision of the model, as the protocol records it. */
export function decisionOf(name: string, choice: JsonObject, reasoning = 'The unit price of each line was compared with the list.'): Decision {
  return { name, choice, reasoning, inference: { path: 'marketplace', sub_job: SUB_JOB, accepted: 'confirmed' } };
}

/** The decision `accept_quote` with the given choice. */
export const acceptDecision = (accept: boolean, mismatch: readonly string[] = []): Decision => decisionOf('accept_quote', { accept, mismatch: [...mismatch] });

const CREDENTIAL = 'eyJhbGciOiJFZERTQSIsInR5cCI6InZjK2p3dCJ9.eyJ2YyI6eyJ0eXBlIjpbIlZlcmlmaWFibGVDcmVkZW50aWFsIl19fQ.Z29sZGVuIHF1b3RlIHNpZ25hdHVyZSwgbm90IGEgcmVhbCBzaWduYXR1cmU';

/**
 * The quote that a bidder returns for the request: the lines `chosen`, the arithmetic of `quoteTotals`, the hash of the request and the hash of the price list, and the decision `quote` of its model. `over`
 * replaces members of the document.
 */
export function quoteDocument(spec: DeskSpec, chosen: readonly Chosen[] = LISTED, over: Record<string, unknown> = {}): Record<string, unknown> {
  const totals = quoteTotals(chosen);
  if (totals === null) throw new Error('the lines of the quote of the test have no arithmetic');
  return {
    schema: 'vector.usecase.quote.v1', outcome: 'done', rfq_id: RFQ.rfq_id, rfq_sha256: must(rfqSha256(RFQ)), desk_did: spec.did, organisation: spec.organisation, lines: totals.lines, total: totals.total,
    lead_time_days: totals.lead_time_days, valid_until: '2026-12-15', notes: 'All lines are at the listed price.', price_list_sha256: LIST_SHA, credential: CREDENTIAL,
    sender: { did: SENDER_DID, organisation: 'echo.example', organisation_verified: true },
    checks: { sender_active: true, sender_accountable: true, sender_key: true, delegation: true, delegation_usable: true, vault_paid: true, not_duplicate: true },
    decisions: [decisionOf('quote', { lines: chosen.map((line) => ({ ...line })), valid_until: '2026-12-15', notes: 'All lines are at the listed price.' }, 'Each line takes the listed price.')],
    fault_mode: '', ...over,
  };
}

/** The text that a bidder serves for its quote. */
export const quoteText = (spec: DeskSpec, chosen: readonly Chosen[] = LISTED, over: Record<string, unknown> = {}): string => JSON.stringify(quoteDocument(spec, chosen, over));

/** The quote as the typed value that the kit makes of it. */
export const typedQuote = (spec: DeskSpec, chosen: readonly Chosen[] = LISTED, over: Record<string, unknown> = {}): Quote => must(parseQuote(quoteDocument(spec, chosen, over)));

/** The lines of the request with one line at another unit price than the list gives. */
export const priced = (sku: string, unit: number): readonly Chosen[] => LISTED.map((line) => (line.sku === sku ? { ...line, unit_price: unit } : line));

// --- The model and the challenge ----------------------------------------------------------------------------------------------------------------------------------------

/** The answer of a model that reads the unit prices right: it accepts when each line is at the listed price, and it names the SKUs of the lines that are not. */
export function rightAnswer(input: { quote: Quote; list: PriceList }): AcceptQuoteAnswer {
  const mismatch = lineChecks(input.quote, input.list).filter((line) => line.listed_unit_price !== line.quoted_unit_price).map((line) => line.sku);
  return { ok: true, decision: acceptDecision(mismatch.length === 0, mismatch), choice: { accept: mismatch.length === 0, mismatch } };
}

/** The model as a function. By default it reads the unit prices right. */
export class ScriptedAccept {
  readonly calls: Array<{ rfq: RfqDocument; quote: Quote; list: PriceList }> = [];
  answer: (input: { rfq: RfqDocument; quote: Quote; list: PriceList }) => unknown = rightAnswer;

  readonly acceptQuote = async (input: { rfq: RfqDocument; quote: Quote; list: PriceList }): Promise<AcceptQuoteAnswer> => {
    this.calls.push(input);
    // A test gives the answer of a port, and it may give an answer that breaks the type, to see what the job does with it.
    return (await this.answer(input)) as AcceptQuoteAnswer;
  };
}

/** The record of a challenge that was filed. */
export const CHALLENGE: ChallengeRecord = { claim: `${'c1'.repeat(32)}#0`, evidence: 'e1'.repeat(32), challenge: `${'c2'.repeat(32)}#0` };

/** The answer of the dispute folder for a challenge that was filed. */
export function challengeFiled(record: ChallengeRecord = CHALLENGE): { ok: true; value: ChallengeFiled } {
  return {
    ok: true,
    value: {
      record, claim_token: `636c6d5f${'11'.repeat(28)}`, against_did: BRAVO.did, evidence_uri: 'ipfs://evidence', evidence_hash: 'd4'.repeat(32), challenge_tx: record.challenge.split('#')[0]!,
      challenge_token: `636c6d5f${'22'.repeat(28)}`, stake_lovelace: 50_000_000n, deadline: 1_790_000_000_000, fee_lovelace: 1_000_000n, extra_evidence: null,
    },
  };
}

/** The answer of the dispute folder for a challenge that was not filed. `landed` names a transaction that landed before the step failed. */
export function challengeNotFiled(code: ChallengeNotFiled['code'], landed: Partial<Pick<ChallengeNotFiled, 'evidence' | 'sent' | 'challenge' | 'wrong_document'>> = {}): ChallengeNotFiled {
  return { ok: false, code, detail: 'the detail of the dispute folder', evidence: null, sent: null, challenge: null, wrong_document: null, ...landed };
}

/** The dispute folder as a function. It builds the evidence document with the real function of the kit, so a challenge that no document can state is not filed, as the real code does not file it. */
export class ScriptedDispute {
  readonly calls: DeliveryChallengeInput[] = [];
  readonly documents: Array<ProtocolResult<JurorDocument, DocumentCode>> = [];
  /** What the dispute folder answers when the evidence document is built. */
  answer: () => ChallengeResult | Promise<ChallengeResult> = () => challengeFiled();
  /** Make the call throw. */
  failWith: Error | null = null;

  constructor(private readonly challenger: string) {}

  readonly challengeDelivery = async (input: DeliveryChallengeInput): Promise<ChallengeResult> => {
    this.calls.push(input);
    if (this.failWith !== null) throw this.failWith;
    const document = evidenceDocument({
      claim: `${'c1'.repeat(32)}#0`, claim_token: `636c6d5f${'11'.repeat(28)}`, against_did: input.counterparty, by_did: this.challenger, escrow_ref: input.escrow_ref,
      statement_text: input.statement_text, ...input.evidence,
    });
    this.documents.push(document);
    if (!document.ok) return { ok: false, code: document.code, detail: document.detail, evidence: null, sent: null, challenge: null, wrong_document: null };
    return this.answer();
  };
}
