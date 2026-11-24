// agents/bid-desk/src/job/quote.ts
// The job of the Bid Desk (use case 3, supplier bid evaluation): what it does after the Claim of an escrow. `runQuote` takes the record of the checks that the hook made, asks the model to price the request from
// the price list, checks the answer in code, makes the arithmetic, applies the fault when the switch says so, reads the book again, gets the credential of the desk from the gateway, builds the quote, records the
// request in the book and gives the quote. The signed receipt of the job is the signed quote.
//
// The steps, in order. A failure ends the job with a `QuoteRefusal`, and nothing is written after it.
//   1. The record of the checks, by the escrow reference of the context. No record, a record whose hash is not the hash of this body, a record that lacks one of the 7 checks, and a record with a fact that cannot
//      be read (the organisation of the sender and its verification) are `precheck_missing`: the hook did not check this body. A request that is no request for quotation is a fault of the service (`internal`).
//   2. The signal is read. The decision `quote`. A failed decision ends the job with its own code.
//   3. The choice is checked against the request: at least one line, each line an item of the request (its SKU and its quantity), each SKU once. A choice that the parser of the decision refuses is checked too,
//      because a port can give a choice that it did not parse. Anything else is `model_output_invalid`. The job never clamps, adds or removes a line.
//   4. The fault, then the arithmetic. With the fault on, the first line that the price list prices gets a price below the list. Then `quoteTotals` makes the line totals, the total and the longest lead time.
//      With the fault on and no line to change, the job ends `internal`: a run never says that a fault was on when it changed nothing. A null from `quoteTotals` is `model_output_invalid`.
//   5. The book is read again. A request that it holds is `duplicate_rfq`, after the Claim: the escrow stays Claimed, and the buyer reclaims it after the deadline.
//   6. The credential. A failure of the gateway, a call that throws, and a credential that is not a compact JWS are `credential_failed`.
//   7. The quote, checked by the parser of the kit BEFORE anything is recorded. A draft that fails is `internal`.
//   8. The clock: with less than 30,000 ms until `deliver_by` the job ends `deadline` and records nothing, because a quote that nobody will read must not use up the key of the request. The signal. The book
//      records the request with the hash of the quote: a book that cannot write is `store_write_failed`. The job gives the quote.
//
// The model decides the unit prices, and no code of this file changes one, except the fault. The job calls no mock system, takes no approval and files no challenge. The fault value is in the quote and in no line
// of the log. A line of the log holds codes and the names of members, and never a request, a price list, a key, a credential or a token.
import type { GatewayResult } from '@vsa/id-kit/client';
import type { JobContext } from '@vsa/service-kit';
import { QUOTE_CHECKS, QUOTE_SCHEMA, parseQuote, parseRfqDocument, quoteTotals, rfqSha256 } from '@vsa/usecase-kit/bids';
import type { Quote } from '@vsa/usecase-kit/bids';
import type { ChecksRecord } from '@vsa/usecase-kit/checks';
import { accepted, canonicalSha256, isPlainObject, refused } from '@vsa/usecase-kit/protocol';
import type { Did, ProtocolResult, RfqMessage } from '@vsa/usecase-kit/protocol';
import { QUOTE_DECISION, quoteInput } from './decision.ts';
import { pricedLines, readFault } from './fault.ts';
import type { QuoteDeps } from './ports.ts';
import { DECISION_TEXT, QUOTE_TEXT, QuoteRefusal, decisionCodeOf, describeDecision } from './refusal.ts';
import type { QuoteRefusalCode } from './refusal.ts';

/** How long before `deliver_by` the runtime stops waiting for the job, in milliseconds. The job records no quote with less time left, and the service ends the paid decision this margin and the call for the credential before `deliver_by`. */
export const RUNTIME_MARGIN_MS = 30_000;
/** The longest organisation of the sender that a quote holds, in characters, in the text and in its NFC form. */
const MAX_ORGANISATION_CHARS = 1024;
/** The credential that a quote holds: a compact JWS of at most 8192 characters, three parts of base64url text with a dot between them. A test holds this rule to the parser of the quote. */
const MAX_CREDENTIAL_CHARS = 8192;
const COMPACT_JWS = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

// --- the record of the checks ----------------------------------------------------------------------------------------------------------------------

/** The parts of the quote that come from the record of the hook. */
interface FromRecord {
  readonly sender: Quote['sender'];
  readonly checks: Quote['checks'];
}

/** True for an organisation that a quote holds: a text of at most 1024 characters, and the same in its NFC form. */
const isOrganisation = (value: unknown): value is string => typeof value === 'string' && value.length <= MAX_ORGANISATION_CHARS && value.normalize('NFC').length <= MAX_ORGANISATION_CHARS;

/**
 * The sender and the checks of the quote, from the record. Every name of QUOTE_CHECKS must be in the record with the value `true`, and the facts must have the types that the checks of the hook give them.
 * Anything else is a record that cannot be used, and the reason names the check or the fact and never its value. The sender is the sender of the request: the checks verified it.
 */
function readRecord(record: ChecksRecord, sender: Did): ProtocolResult<FromRecord> {
  if (!isPlainObject(record) || !isPlainObject(record.checks) || !isPlainObject(record.facts)) return refused('bad_shape', 'the record holds no checks or no facts');
  const { checks, facts } = record;
  for (const name of QUOTE_CHECKS) {
    const passed: unknown = Object.hasOwn(checks, name) ? checks[name] : undefined;
    if (passed !== true) return refused('bad_shape', `the record does not hold the check ${name}`);
  }
  const own = (name: string): unknown => (Object.hasOwn(facts, name) ? facts[name] : undefined);
  const organisation = own('organisation');
  if (organisation !== null && !isOrganisation(organisation)) return refused('bad_shape', 'the fact organisation is not null or a text of at most 1024 characters');
  const verified = own('organisation_verified');
  if (typeof verified !== 'boolean') return refused('bad_shape', 'the fact organisation_verified is not true or false');
  // Each name is in the record with the value true (the loop above), so the entries make the object of the type.
  const confirmed = Object.fromEntries(QUOTE_CHECKS.map((name) => [name, true as const])) as Quote['checks'];
  return accepted({ sender: { did: sender, organisation, organisation_verified: verified }, checks: confirmed });
}

// --- small parts -----------------------------------------------------------------------------------------------------------------------------------

/** The date of a time as `YYYY-MM-DD` in UTC, or null for a time that no date has: a value that is not a number, infinity, and a time beyond the dates that a year of four digits holds. */
function dayOf(time: unknown): string | null {
  if (typeof time !== 'number' || !Number.isFinite(time)) return null;
  const date = new Date(time);
  if (Number.isNaN(date.getTime())) return null;
  const text = date.toISOString();
  return /^\d{4}-/.test(text) ? text.slice(0, 10) : null;
}

/** True for a credential that a quote holds. The length is checked first, so that a long text is never matched. */
const isCredential = (value: unknown): value is string => typeof value === 'string' && value.length <= MAX_CREDENTIAL_CHARS && COMPACT_JWS.test(value);

/** The name of an error for a log line. The message of an error is never logged: it can name a path or a host. */
const kindOf = (error: unknown): string => (error instanceof Error ? error.name : typeof error);

// --- the job ---------------------------------------------------------------------------------------------------------------------------------------

/**
 * Does the job of an escrow that the Bid Desk claimed, and gives the quote, or throws a `QuoteRefusal`. `request` is the message that the server parsed, `context` is what the runtime said of the escrow, and
 * `arrivedAt` is the time of the clock of the service when the job arrived. `signal` aborts when the caller hangs up: the job looks at it before the model is hired and before the book records the request. It
 * never passes the signal into a port. After the record the quote exists and is booked, so the job goes on and writes one line to the log. See the head of this file for the steps and the codes.
 */
export async function runQuote(deps: QuoteDeps, request: RfqMessage, context: JobContext, arrivedAt: number, signal?: AbortSignal): Promise<Quote> {
  const say = (text: string): void => {
    try {
      deps.log(`bid desk: ${text} (escrow ${context.escrowRef}, ${deps.clock() - arrivedAt} ms)`);
    } catch {
      // A log that fails changes nothing.
    }
  };
  /** The refusal for a failure, after one line in the log with the reason. The caller throws it. */
  const refuse = (code: QuoteRefusalCode, message: string, why: string): QuoteRefusal => {
    say(`${code}: ${why}`);
    return new QuoteRefusal(code, message);
  };
  const stopIfAbandoned = (before: string): void => {
    if (signal?.aborted === true) throw refuse('deadline', QUOTE_TEXT.deadline, `the caller hung up, so the job stops before ${before}`);
  };

  // The setting of the fault is read one time. The lines and the quote below come from this reading, so a line and the result never come from two reads.
  const fault = readFault(deps.fault);

  // 1. The record of the checks, for this escrow and for this body.
  const taken = deps.takeChecks(context.escrowRef);
  if (!isPlainObject(taken)) throw refuse('precheck_missing', QUOTE_TEXT.precheck_missing, 'there is no record of passed checks for this escrow');
  const requestHash = canonicalSha256(request);
  if (!requestHash.ok || taken.request_sha256 !== requestHash.value) {
    throw refuse('precheck_missing', QUOTE_TEXT.precheck_missing, 'the record of passed checks is for another request');
  }
  const fromRecord = readRecord(taken.record, request.sender_did);
  if (!fromRecord.ok) throw refuse('precheck_missing', QUOTE_TEXT.precheck_missing, `the record of passed checks cannot be used: ${fromRecord.detail}`);
  const parsedRfq = parseRfqDocument(request.rfq, 'request.rfq');
  if (!parsedRfq.ok) throw refuse('internal', QUOTE_TEXT.internal, `the request is not a request for quotation: ${parsedRfq.detail}`);
  const rfq = parsedRfq.value;
  const rfqHash = rfqSha256(rfq);
  if (!rfqHash.ok) throw refuse('internal', QUOTE_TEXT.internal, `the request for quotation has no hash: ${rfqHash.detail}`);

  // 2. The decision. Only a decision that the kit made goes on.
  stopIfAbandoned('the decision');
  const today = dayOf(deps.clock());
  if (today === null) throw refuse('internal', QUOTE_TEXT.internal, 'the clock does not give a date, so the model is not hired');
  const decided = await deps.decide(quoteInput(rfq, deps.priceList.list, today));
  if (decided?.ok !== true) {
    const code = decisionCodeOf(decided);
    throw refuse(code, DECISION_TEXT[code], describeDecision(decided));
  }
  const decision = decided.value;
  const choice = decision.choice;

  // 3. The choice against the request. The parser of the decision ran in the kit, and it runs again here: a port can give a choice that it did not parse, and a choice that no quote can hold must end here.
  const invalid = (why: string): QuoteRefusal => refuse('model_output_invalid', DECISION_TEXT.model_output_invalid, why);
  if (!QUOTE_DECISION.parse(choice).ok) throw invalid('the choice of the decision has not the shape and the limits that the decision asks for');
  if (choice.lines.length < 1) throw invalid('the choice has no line');
  const wanted = new Map<string, number>(rfq.items.map((item) => [item.sku, item.quantity]));
  const seen = new Set<string>();
  for (const [index, line] of choice.lines.entries()) {
    if (wanted.get(line.sku) !== line.quantity) throw invalid(`line ${index + 1} of the choice is not an item of the request`);
    if (seen.has(line.sku)) throw invalid(`line ${index + 1} of the choice has a SKU that an earlier line has`);
    seen.add(line.sku);
  }

  // 4. The fault, then the arithmetic. These are copies of the lines of the choice: the decision on record stays what the model said.
  const lines = pricedLines(fault.on, choice.lines, deps.priceList.list);
  if (lines === null) throw refuse('internal', QUOTE_TEXT.internal, 'no line can take the price that this run needs: no line is priced by the list, or its listed price is 1');
  const totals = quoteTotals(lines);
  if (totals === null) throw invalid('the arithmetic of the kit makes no quote of the lines');

  // 5. The book again. The hook can pass two escrows of one request before the first job writes the book, so a request that the book holds now is a duplicate. Only `false` is a pass.
  let held: unknown;
  try {
    held = await deps.book.has(request.sender_did, rfq.rfq_id);
  } catch (error) {
    throw refuse('internal', QUOTE_TEXT.internal, `the rfq book could not be read (${kindOf(error)})`);
  }
  if (held === true) throw refuse('duplicate_rfq', QUOTE_TEXT.duplicate_rfq, 'the rfq book holds a quote for this request of this sender');
  if (held !== false) throw refuse('internal', QUOTE_TEXT.internal, 'the rfq book answered with a value that is not true or false');

  // 6. The credential of the desk. It comes before the record in the book, so a failure leaves the request free for another try.
  let issued: GatewayResult<string>;
  try {
    issued = await deps.credential(deps.agent.did);
  } catch (error) {
    throw refuse('credential_failed', QUOTE_TEXT.credential_failed, `the call for the credential threw (${kindOf(error)})`);
  }
  if (issued?.ok !== true) {
    throw refuse('credential_failed', QUOTE_TEXT.credential_failed, `the gateway gave no credential: ${String(issued?.rule)} (status ${String(issued?.status)})`);
  }
  const credential: unknown = issued.value;
  if (!isCredential(credential)) throw refuse('credential_failed', QUOTE_TEXT.credential_failed, 'the credential of the gateway is not a compact JWS of the form that a quote holds');

  // 7. The quote, checked by the parser of the kit before anything is recorded. The result is the checked copy.
  const checked = parseQuote({
    schema: QUOTE_SCHEMA,
    outcome: 'done',
    rfq_id: rfq.rfq_id,
    rfq_sha256: rfqHash.value,
    desk_did: deps.agent.did,
    organisation: deps.agent.organisation,
    lines: totals.lines,
    total: totals.total,
    lead_time_days: totals.lead_time_days,
    valid_until: choice.valid_until,
    notes: choice.notes,
    price_list_sha256: deps.priceList.sha256,
    credential,
    sender: fromRecord.value.sender,
    checks: fromRecord.value.checks,
    decisions: [decision],
    fault_mode: fault.mode,
  });
  if (!checked.ok) throw refuse('internal', QUOTE_TEXT.internal, `no valid quote can be made: ${checked.detail}`);
  const quote = checked.value;
  const quoteHash = canonicalSha256(quote);
  if (!quoteHash.ok) throw refuse('internal', QUOTE_TEXT.internal, `the quote has no hash: ${quoteHash.detail}`);

  // 8. The clock, the signal and the book. The runtime stops waiting for the job 30 seconds before `deliver_by`, and a quote that it never reads must not use up the key of the request. The test is written so
  // that a time that is not a number refuses: a time that is not known is never enough time.
  const left = context.deliverByMs - deps.clock();
  if (!(left >= RUNTIME_MARGIN_MS)) {
    throw refuse('deadline', QUOTE_TEXT.no_time, `less than ${RUNTIME_MARGIN_MS} ms are left until the runtime stops waiting (${left} ms), so nothing is recorded`);
  }
  stopIfAbandoned('the record in the book');
  try {
    await deps.book.record(request.sender_did, rfq.rfq_id, quoteHash.value);
  } catch (error) {
    throw refuse('store_write_failed', QUOTE_TEXT.rfq_book, `the rfq book could not record the quote (${kindOf(error)})`);
  }
  // The signal is read after the commitment too. The quote exists and is booked, so the job goes on and gives it, which a caller that hung up does not read.
  if (signal?.aborted === true) say('the caller hung up while the quote was booked: the quote is booked');
  say(`gave a quote with ${quote.lines.length} lines`);
  return quote;
}
