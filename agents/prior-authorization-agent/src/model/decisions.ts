// agents/prior-authorization-agent/src/model/decisions.ts
// The two model decisions of the Prior Authorization Agent (use case 2, prior authorization). `justification` writes the text of an authorization request from the order, the records and the guideline.
// `accept_delivery` says whether the intake record of the insurer names the request that this agent sent. Each decision has three parts: the fixed text of its prompt, the function that makes its input,
// and the parser of its choice.
//
// The fixed text is code. It holds no text of another party and no mark of the input block. The prompt rules of the decision folder already ask for one JSON object and nothing else, so the fixed text
// only says what the data holds and what shape `choice` has. The input is JSON data in one marked block, and the decision folder writes it so that no text in it can close the block.
//
// What the model reads of another party:
//   - `justification` reads the order, the whole record set and the guideline, as the records system and the guideline store gave them. The reference of the patient and the reference of the clinician
//     are opaque ids with no clinical content, and the agent copies them from the order into the request, so the model never writes them and the input leaves them out. The texts of the records and of the
//     guideline are free text of other parties: they stand in the data block and nowhere else.
//   - `accept_delivery` reads two request numbers and two hashes, and nothing else. The hash of the request that was sent is the one that the agent computed from the document that it sent. The hash of the
//     record is the one that the record names. The `decisions`, the `sender`, the `checks` and the `missing` list of an intake record never reach the prompt. The agent checks the number and the sender of the
//     record in code before it asks the model.
//
// A parser checks the SHAPE of a choice and no business rule. It returns the value that it was given, or a refusal: it never clamps, trims, fills in or changes a value. The parser of `justification` also
// holds the two closed sets of one job: a reference that names no record or no criterion that the agent read is refused, because it would put a false statement into a request that the hirer signs. It does
// not check that the justification cites the references. The parser of `accept_delivery` refuses an answer that contradicts itself: `accept` is true exactly when `mismatch` is empty. A refusal of a parser is
// `model_output_invalid` in the decision folder.
import { accepted, checkMembers, isPlainObject, parseDigest, refused } from '@vsa/usecase-kit/protocol';
import type { Digest, JsonValue, Refused } from '@vsa/usecase-kit/protocol';
import { MAX_JUSTIFICATION_CHARS } from '@vsa/usecase-kit/priorauth';
import type { Guideline, RecordSet } from '@vsa/usecase-kit/priorauth';
import type { ChoiceParser, DecisionSpec } from '@vsa/usecase-kit/decision';
import { ID_RULE, isId } from './intake.ts';

// --- justification ---------------------------------------------------------------------------------------------------------------------------------

/**
 * What the model chooses for `justification`: the text, the ids of the criteria that it cites, and the ids of the records that it cites. It is a type alias, so that it is JSON data. The agent builds the
 * request from this choice, and the document parser of the kit makes the NFC copy of the text.
 */
export type JustificationChoice = { justification: string; guideline_refs: string[]; record_refs: string[] };

const JUSTIFICATION_INSTRUCTION = [
  'You draft the justification of a prior authorization request.',
  'The data has three members.',
  '"order" is the order that the provider asks the insurer to authorize: "order_id", "service_code" (the service), "service_description", "diagnosis_codes" (a list) and "ordered_at" (a date).',
  '"records" lists the records of the chart behind the order.',
  'Each record has "record_id", "type", "recorded_at" (a date) and "summary" (the text of the record).',
  '"guideline" is the guideline of the service: "code", "title", "version", "criteria" and "documentation".',
  'Each criterion has an "id" and a "text".',
  '"documentation" is a list of lines that say what a request must document.',
  'Use only the records that the data gives.',
  'Do not state a fact that no record states.',
  'Compare each criterion with the records.',
  'Cite each criterion that the records support, and each record that supports a criterion.',
  'When a criterion is not met, or no record shows it, say so in the justification, and do not cite it.',
  `"choice" is an object with exactly three members: "justification" (a text of at most ${MAX_JUSTIFICATION_CHARS} characters), "guideline_refs" (a list of the "id" of each criterion that you cite, each at most one time) and "record_refs" (a list of the "record_id" of each record that you cite, each at most one time).`,
  'Write the justification as plain text, and use a line feed to start a new line. Use no tab and no other control, invisible or separator character.',
].join(' ');

/**
 * The characters that a justification never holds, but the line feed: the control characters, the format characters, the line and paragraph separators, and the variation selectors. It is the rule of
 * the document parser of the kit, so that a text that this parser takes is a text that the request takes.
 */
const HIDDEN = /(?!\n)[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\u{fe00}-\u{fe0f}\u{e0100}-\u{e01ef}]/u;

/** The number of code points of a text. A pair of surrogates is one code point, and a lone surrogate is one code point. */
function pointsIn(text: string): number {
  let points = 0;
  for (const _point of text) points += 1;
  return points;
}

/**
 * A refusal when the text is not a justification of the shape of the request: 1 to MAX_JUSTIFICATION_CHARS code points, as written and in the NFC form, and no control, format, separator or variation
 * selector character but the line feed. The text is not changed. The detail names the member and the rule and never repeats the text.
 */
function checkJustification(value: unknown, field: string): Refused | null {
  if (typeof value !== 'string') return refused('bad_shape', `${field} must be a text`);
  const limit = `${field} must have 1 to ${MAX_JUSTIFICATION_CHARS} characters`;
  // A code point has one or two code units, so a text of more than twice the limit in code units has more code points than the limit. The check keeps the scan below short.
  if (value.length < 1 || value.length > 2 * MAX_JUSTIFICATION_CHARS) return refused('bad_shape', limit);
  const form = value.normalize('NFC');
  if (pointsIn(value) > MAX_JUSTIFICATION_CHARS || pointsIn(form) > MAX_JUSTIFICATION_CHARS) return refused('bad_shape', limit);
  if (HIDDEN.test(form)) return refused('bad_shape', `${field} must not hold a control, format, separator or variation selector character but the line feed`);
  return null;
}

/** A refusal when the value is not a list of ids that are all in `known`, each one time. The detail names the place of the first entry that fails, and never repeats an id. */
function checkReferences(value: unknown, field: string, known: ReadonlySet<string>, what: string): Refused | null {
  if (!Array.isArray(value)) return refused('bad_shape', `${field} must be a list`);
  const seen = new Set<string>();
  for (const [index, entry] of value.entries()) {
    if (typeof entry !== 'string') return refused('bad_shape', `${field}[${index}] must be a text`);
    if (!known.has(entry)) return refused('bad_shape', `${field}[${index}] must be the id of ${what} that was read`);
    if (seen.has(entry)) return refused('bad_shape', `${field}[${index}] is in the list two times`);
    seen.add(entry);
  }
  return null;
}

/** The parser of one job: the shape of the choice, and the two closed sets of the ids that the agent read. */
function justificationParser(recordIds: ReadonlySet<string>, criterionIds: ReadonlySet<string>): ChoiceParser<JustificationChoice> {
  return (given) => {
    if (!isPlainObject(given)) return refused('bad_shape', 'choice must be a JSON object');
    const members = checkMembers(given, 'choice', ['justification', 'guideline_refs', 'record_refs']);
    if (members !== null) return members;
    const { justification, guideline_refs: guidelineRefs, record_refs: recordRefs } = given;
    const problem =
      checkJustification(justification, 'choice.justification') ??
      checkReferences(guidelineRefs, 'choice.guideline_refs', criterionIds, 'a criterion of the guideline') ??
      checkReferences(recordRefs, 'choice.record_refs', recordIds, 'a record of the set');
    // The members are checked, and the value that the model gave goes back as it is.
    return problem ?? accepted(given as JustificationChoice);
  };
}

/** A copy of a list of ids as a set. A value that is not a list of texts is a mistake of the caller: a text would give a set of its letters, and nothing would give an empty set. */
function closedSet(list: unknown, name: string): ReadonlySet<string> {
  if (!Array.isArray(list) || !list.every((entry) => typeof entry === 'string')) throw new TypeError(`justificationDecision: ${name} must be a list of texts`);
  return new Set<string>(list);
}

/**
 * The decision `justification` for one job. `ids` are the ids of the records of the set and of the criteria of the guideline that the agent read: they are the two closed sets of the parser. The decision is
 * made for each call, because the sets belong to one job. The lists are copied, so a later change of a list does not change the decision. A list that is not a list of texts is a `TypeError` that names it.
 */
export function justificationDecision(ids: { readonly record_ids: readonly string[]; readonly criterion_ids: readonly string[] }): DecisionSpec<JustificationChoice> {
  const { record_ids: recordIds, criterion_ids: criterionIds } = ids;
  const parse = justificationParser(closedSet(recordIds, 'ids.record_ids'), closedSet(criterionIds, 'ids.criterion_ids'));
  return Object.freeze({ name: 'justification', instruction: JUSTIFICATION_INSTRUCTION, parse });
}

/**
 * The input of `justification`: five members of the order, the records in the order that the records system gave them, and the guideline with its criteria and its lines of documentation. The members are
 * copied by name, so no other member reaches the prompt. The reference of the patient and the reference of the clinician stay out: they are opaque ids, and the agent copies them into the request.
 */
export function justificationInput(set: RecordSet, guideline: Guideline): JsonValue {
  const { order } = set;
  return {
    order: {
      order_id: order.order_id,
      service_code: order.service_code,
      service_description: order.service_description,
      diagnosis_codes: [...order.diagnosis_codes],
      ordered_at: order.ordered_at,
    },
    records: set.records.map((record) => ({ record_id: record.record_id, type: record.type, recorded_at: record.recorded_at, summary: record.summary })),
    guideline: {
      code: guideline.code,
      title: guideline.title,
      version: guideline.version,
      criteria: guideline.criteria.map((criterion) => ({ id: criterion.id, text: criterion.text })),
      documentation: [...guideline.documentation],
    },
  };
}

// --- accept_delivery -------------------------------------------------------------------------------------------------------------------------------

/** The only name that `mismatch` can hold: the hash is the one value that the decision compares, and the statement of the Insurer Intake Agent about its record names it. */
const MISMATCH_NAMES = ['request_sha256'] as const;
type MismatchName = (typeof MISMATCH_NAMES)[number];

/** What the model chooses for `accept_delivery`: whether to accept the delivery, and the names of the values that differ. It is a type alias, so that it is JSON data. */
export type AcceptChoice = { accept: boolean; mismatch: MismatchName[] };

const ACCEPT_INSTRUCTION = [
  'You decide whether to accept a delivery.',
  'The data has two members.',
  '"sent" is the request that this agent sent to the insurer.',
  '"record" is what the intake record of the insurer states about the request that it received.',
  'Each member has two values: "request_number" (the number of the request) and "request_sha256" (the hash of the request, as 64 hexadecimal characters).',
  'Compare the hash in "record" with the hash in "sent".',
  'Two hashes are equal only when they are exactly the same, character for character.',
  'Accept only when the hash in the record is the hash of the request that was sent.',
  '"choice" is an object with exactly two members: "accept" (true or false) and "mismatch" (a list: it holds "request_sha256" when the two hashes differ, and it is empty when they are equal).',
  'When you accept, "mismatch" is an empty list.',
  'When you do not accept, "mismatch" is a list with the one name "request_sha256".',
].join(' ');

const isMismatchName = (value: unknown): value is MismatchName => typeof value === 'string' && (MISMATCH_NAMES as readonly string[]).includes(value);

const parseAcceptChoice: ChoiceParser<AcceptChoice> = (given) => {
  if (!isPlainObject(given)) return refused('bad_shape', 'choice must be a JSON object');
  const members = checkMembers(given, 'choice', ['accept', 'mismatch']);
  if (members !== null) return members;
  const { accept, mismatch } = given;
  if (typeof accept !== 'boolean') return refused('bad_shape', 'choice.accept must be true or false');
  if (!Array.isArray(mismatch) || mismatch.length > MISMATCH_NAMES.length) return refused('bad_shape', `choice.mismatch must be a list of 0 or ${MISMATCH_NAMES.length} name: ${MISMATCH_NAMES.join(', ')}`);
  for (const [index, name] of mismatch.entries()) {
    if (!isMismatchName(name)) return refused('bad_shape', `choice.mismatch[${index}] must be one of ${MISMATCH_NAMES.join(', ')}`);
  }
  // One rule of consistency: the answer accepts exactly when it names no value that differs. An answer that says both is not read as either.
  if (accept && mismatch.length > 0) return refused('bad_shape', 'choice accepts the delivery and also names a value that differs');
  if (!accept && mismatch.length === 0) return refused('bad_shape', 'choice does not accept the delivery and names no value that differs');
  return accepted(given as AcceptChoice);
};

/** The decision `accept_delivery`. */
export const ACCEPT_DECISION: DecisionSpec<AcceptChoice> = Object.freeze({ name: 'accept_delivery', instruction: ACCEPT_INSTRUCTION, parse: parseAcceptChoice });

/** One side of the comparison: the number of a request and the hash of that request. */
interface RequestSide {
  readonly request_number: string;
  readonly request_sha256: Digest;
}

/**
 * The two values of one side, copied by name. A value that is not in its form is a mistake of the caller, and the caller makes both sides from checked data. The check is the last guard before the
 * prompt: free text of a counterparty cannot pass for a request number or a hash. The error names the member and never repeats the value.
 */
function sideOf(side: RequestSide, name: string): { request_number: string; request_sha256: Digest } {
  const { request_number: requestNumber, request_sha256: requestSha256 } = side;
  if (!isId(requestNumber)) throw new TypeError(`acceptInput: ${name}.request_number must be ${ID_RULE}`);
  const hash = parseDigest(requestSha256, `${name}.request_sha256`);
  if (!hash.ok) throw new TypeError(`acceptInput: ${hash.detail}`);
  return { request_number: requestNumber, request_sha256: hash.value };
}

/**
 * The input of `accept_delivery`: the number and the hash of the request that was sent, and the number and the hash that the intake record names. The four values are copied by name. No other member of
 * either argument reaches the prompt: not the `decisions`, the `sender`, the `checks` or the `missing` list of the record, and no text of the counterparty. The caller computes the hash of the request that was
 * sent from the document that it sent, and never takes it from the record. A value that is not a request number or a hash is a `TypeError`.
 */
export function acceptInput(sent: RequestSide, received: RequestSide): JsonValue {
  return { sent: sideOf(sent, 'sent'), record: sideOf(received, 'received') };
}
