// agents/prior-authorization-agent/src/model/decisions.ts
// The model decisions of the Prior Authorization Agent (use case 2, prior authorization). `accept_delivery` says whether the intake record of the insurer names the request that this agent sent. Each
// decision has three parts: the fixed text of its prompt, the function that makes its input, and the parser of its choice.
//
// The fixed text is code. It holds no text of another party and no mark of the input block. The prompt rules of the decision folder already ask for one JSON object and nothing else, so the fixed text
// only says what the data holds and what shape `choice` has. The input is JSON data in one marked block, and the decision folder writes it so that no text in it can close the block.
//
// What the model reads of another party:
//   - `accept_delivery` reads two request numbers and two hashes, and nothing else. The hash of the request that was sent is the one that the agent computed from the document that it sent. The hash of the
//     record is the one that the record names. The `decisions`, the `sender`, the `checks` and the `missing` list of an intake record never reach the prompt. The agent checks the number and the sender of the
//     record in code before it asks the model.
//
// A parser checks the SHAPE of a choice and no business rule. It returns the value that it was given, or a refusal: it never clamps, fills in or changes a value. The parser of `accept_delivery` refuses
// an answer that contradicts itself: `accept` is true exactly when `mismatch` is empty. A refusal of a parser is `model_output_invalid` in the decision folder.
import { accepted, checkMembers, isPlainObject, parseDigest, refused } from '@vsa/usecase-kit/protocol';
import type { Digest, JsonValue } from '@vsa/usecase-kit/protocol';
import type { ChoiceParser, DecisionSpec } from '@vsa/usecase-kit/decision';
import { ID_RULE, isId } from './intake.ts';

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
