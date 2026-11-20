// packages/usecase-kit/src/decision/answer.ts
// The answer of the model, read into a choice and its reasoning. This is the only place where a decision gets its choice, and the choice is the model's: the rest of the folder never changes it.
//
// The model answers with one JSON object that has exactly two members, `reasoning` (a text that is not blank) and `choice` (JSON data of the shape that the decision names). The text of the answer is
// read in these steps. The first step that fails ends the reading with `model_output_invalid`, and then no decision is recorded:
//   1. The supplier gave the answer as completed. An answer that stopped at its output limit is cut, and it is not read.
//   2. A code fence around the whole answer is taken off. The object is the text from the first `{` to the last `}`. It must parse as JSON, and it must be plain JSON data (no `__proto__` key, no number
//      that is not finite, no value nested deeper than the protocol allows).
//   3. The object has the members `reasoning` and `choice`, and no other member. The reasoning is a text with at least one character that is not white space. It is kept as the model wrote it.
//   4. The parser of the decision accepts the choice. The parser gets a COPY of the choice and returns the parsed value or a refusal.
//   5. The value that the parser returned is the choice that the model gave. A parser that changed a member, left one out or added one is a defect of the use case. The reading ends with
//      `choice_changed`, which is not a fault of the model, and no decision is recorded. The comparison is against the choice as it was BEFORE the parser ran, so a parser that changes its own copy
//      in place does not hide the change.
// The value that the reading returns is a new copy of the parsed value. It shares no object with the parser, so a parser that keeps a reference cannot change the decision later.
//
// A detail never repeats the text of the answer: the answer can quote the input. It gives the length of the answer, and the name of the member that is wrong. The detail of the parser is cut
// to 200 printable characters, and a parser names a member and never repeats a value.
import { accepted, checkMembers, isPlainObject, parseJsonValue, refused, type JsonValue, type ProtocolResult } from '../protocol/index.ts';
import type { ChoiceParser } from './spec.ts';

/** What the reading of an answer gives: the reasoning as the model wrote it, and the choice as the model gave it. */
export interface Answer<C extends JsonValue> {
  readonly reasoning: string;
  readonly choice: C;
}

/** `model_output_invalid` is a fault of the answer. `choice_changed` is a fault of the parser of the use case: it returned a value that is not the choice that it was given. */
export type AnswerFault = 'model_output_invalid' | 'choice_changed';

/** What a supplier gives of an answer: its text, and the status of the response as the supplier wrote it. It is the value of `hireModel`. */
export interface ModelAnswerText {
  readonly text: string;
  readonly status: unknown;
}

const DETAIL_CHARS = 200;
const printable = (text: string): string => text.slice(0, DETAIL_CHARS).replace(/[^\x20-\x7e]/g, '?');

/** The text inside one code fence that holds the whole answer, or the answer as it is. */
function unfenced(content: string): string {
  const fenced = /^```[^\n]*\n([\s\S]*?)\n?```$/.exec(content.trim());
  return fenced === null ? content : fenced[1]!;
}

const isList = (value: JsonValue): value is readonly JsonValue[] => Array.isArray(value);

/** True when two copies hold the same JSON data. Strings are compared as they are, with no normalisation. Both values are copies of at most 32 levels, so the recursion is short. */
function sameJson(a: JsonValue, b: JsonValue): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (isList(a) || isList(b)) {
    return isList(a) && isList(b) && a.length === b.length && a.every((item, index) => sameJson(item, b[index]!));
  }
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => Object.hasOwn(b, key) && sameJson(a[key]!, b[key]!));
}

/**
 * The reasoning and the choice in the answer of a model, or a refusal. It never throws, also when the parser throws: that is a choice that the parser could not read, and so a
 * `model_output_invalid`. The reasoning is returned as it was written, with no trimming.
 */
export function readAnswer<C extends JsonValue>(answer: ModelAnswerText, parse: ChoiceParser<C>): ProtocolResult<Answer<C>, AnswerFault> {
  const { text } = answer;
  const invalid = (what: string): ProtocolResult<never, AnswerFault> => refused('model_output_invalid', `the answer of the model ${what} (an answer of ${text.length} characters)`);
  if (answer.status !== 'completed') return invalid('was not given as a completed answer');

  const body = unfenced(text);
  const first = body.indexOf('{');
  const last = body.lastIndexOf('}');
  if (first === -1 || last < first) return invalid('holds no JSON object');
  let parsedText: unknown;
  try {
    parsedText = JSON.parse(body.slice(first, last + 1));
  } catch {
    return invalid('is not JSON');
  }
  const data = parseJsonValue(parsedText, 'answer');
  if (!data.ok) return invalid(`is not plain JSON data (${data.detail})`);
  const object = data.value;
  if (!isPlainObject(object)) return invalid('is not a JSON object');
  const members = checkMembers(object, 'answer', ['reasoning', 'choice']);
  if (members !== null) return invalid(`has the wrong members (${members.detail})`);
  const { reasoning } = object;
  if (typeof reasoning !== 'string' || reasoning.trim() === '') return invalid('has no reasoning, a text that is not blank');
  const given = object.choice as JsonValue;

  // The parser gets its own copy. The comparison below is with `given`, which the parser never sees.
  const forParser = parseJsonValue(given, 'choice');
  if (!forParser.ok) return invalid(`has a choice that is not plain JSON data (${forParser.detail})`);
  let verdict: unknown;
  try {
    verdict = parse(forParser.value);
  } catch {
    return invalid('has a choice that the parser of the decision could not read');
  }
  const { ok, value, detail } = (typeof verdict === 'object' && verdict !== null ? verdict : {}) as { ok?: unknown; value?: unknown; detail?: unknown };
  if (ok !== true) return invalid(`has a choice of another shape${typeof detail === 'string' ? `: ${printable(detail)}` : ''}`);

  const returned = parseJsonValue(value, 'choice');
  if (!returned.ok || !sameJson(returned.value, given)) {
    return refused('choice_changed', 'the parser of the decision returned a value that is not the choice that the model gave');
  }
  return accepted({ reasoning, choice: returned.value as C });
}
