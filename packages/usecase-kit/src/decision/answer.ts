// packages/usecase-kit/src/decision/answer.ts
// The answer of the model, read into a choice and its reasoning. This is the only place where a decision gets its choice, and the choice is the model's: the rest of the folder never changes it.
//
// The model answers with one JSON object that has exactly two members, `reasoning` (a text that is not blank) and `choice` (JSON data of the shape that the decision names). The text of the answer is
// read in these steps. The first step that fails ends the reading with `model_output_invalid`, and then no decision is recorded:
//   1. The supplier gave the answer as completed. An answer that stopped at its output limit is cut, and it is not read.
//   2. The whole answer is the object. The reader takes off the white space at both ends (space, tab, line feed and carriage return) and a byte order mark at the start. What is left must be
//      EXACTLY one JSON object and nothing else. Two wrappers are permitted, because models write them and they say nothing: (a) think blocks at the very start, each from `<think>` to the first
//      `</think>`, whatever it holds; and (b) ONE code fence around the whole rest: a line of three backticks with an optional word such as `json`, the object, and a line of three backticks.
//      Any other character before the object or after it ends the reading: words, a list that holds the object, a second object, a fence with text beside it, a think block after the object.
//      The rule is strict on purpose. A decision is recorded only when the answer has one reading. "Sure. {...} Hope this helps, but reject it." has two, and a reader that took the text from the
//      first brace to the last would record a choice that the answer takes back.
//      The object text must parse as JSON, and it must say one thing: no key stands two times in one object, and every number reads back as itself (see lossless.ts). The value must be plain JSON
//      data (no `__proto__` key, no number that is not finite, no value nested deeper than the protocol allows).
//   3. The object has the members `reasoning` and `choice`, and no other member. The reasoning is a text with at least one character that is not white space. It is kept as the model wrote it.
//   4. The parser of the decision accepts the choice. The parser gets a COPY of the choice and returns the parsed value or a refusal AT ONCE. A parser that throws gives `model_output_invalid`: it
//      could not read the choice. A parser that returns a promise is a wrong parser. The value of the promise is not read, its rejection is handled here so that none stays unhandled, and the reading
//      ends with `bad_decision`. A parser cannot be proven before it runs, so a caller must hold to this (see spec.ts).
//   5. The value that the parser returned is the choice that the model gave. A parser that changed a member, left one out or added one is a defect of the use case. The reading ends with
//      `choice_changed`, which is not a fault of the model, and no decision is recorded. The comparison is against the choice as it was BEFORE the parser ran, so a parser that changes its own copy
//      in place does not hide the change.
// The value that the reading returns is a new copy of the parsed value. It shares no object with the parser, so a parser that keeps a reference cannot change the decision later.
//
// A detail never repeats the text of the answer, a key of it or a value of it: the answer can quote the input. It says what kind of fault it is, and where by position: the length of the answer, a
// member of the answer that is not allowed, or the depth at which the data is not allowed (see where.ts). The detail of the parser is not copied: a parser can name a key that the model wrote.
import { accepted, parseJsonValue, refused, type JsonValue, type ProtocolResult } from '../protocol/index.ts';
import { losses } from './lossless.ts';
import type { ChoiceParser } from './spec.ts';
import { whereNotJson } from './where.ts';

/** What the reading of an answer gives: the reasoning as the model wrote it, and the choice as the model gave it. */
export interface Answer<C extends JsonValue> {
  readonly reasoning: string;
  readonly choice: C;
}

/**
 * `model_output_invalid` is a fault of the answer. `choice_changed` and `bad_decision` are faults of the parser of the use case: it returned a value that is not the choice that it was given, or it
 * returned a promise.
 */
export type AnswerFault = 'model_output_invalid' | 'choice_changed' | 'bad_decision';

/** What a supplier gives of an answer: its text, and the status of the response as the supplier wrote it. It is the value of `hireModel`. */
export interface ModelAnswerText {
  readonly text: string;
  readonly status: unknown;
}

/** The two members of the object that the model writes, and no other. */
const ENVELOPE: readonly string[] = ['reasoning', 'choice'];

const isList = (value: JsonValue): value is readonly JsonValue[] => Array.isArray(value);

/** True when two copies hold the same JSON data. Strings are compared as they are, with no normalisation. Both values are copies of at most 32 levels, so the recursion is short. */
function sameJson(a: JsonValue, b: JsonValue): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (isList(a) || isList(b)) {
    return isList(a) && isList(b) && a.length === b.length && a.every((item, index) => sameJson(item, b[index]!));
  }
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => sameJson(a[key]!, b[key]!));
}

const BYTE_ORDER_MARK = '\uFEFF';
const THINK_OPEN = '<think>';
const THINK_CLOSE = '</think>';
const FENCE = '```';
/** The white space of JSON. */
const SPACE = ' \t\n\r';
/** The opening line of a code fence: three backticks, an optional word such as `json`, and a line break. */
const FENCE_OPEN = /^```[A-Za-z0-9_+-]{0,32}[ \t]*\r?\n/;
const FENCE_FAULT = 'has a code fence that is not whole: it needs an opening line, the object and a closing line, and nothing else';

/** The text without the white space of JSON at both ends. It is a loop and not a pattern, so that a long run of white space inside the text costs nothing. */
function trimSpace(text: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && SPACE.includes(text[start]!)) start += 1;
  while (end > start && SPACE.includes(text[end - 1]!)) end -= 1;
  return text.slice(start, end);
}

/** The text inside a code fence that stands around the whole of `rest`, or a refusal. `rest` starts with the three backticks. */
function unfence(rest: string): ProtocolResult<string, 'wrapper'> {
  const open = FENCE_OPEN.exec(rest);
  if (open === null || !rest.endsWith(FENCE)) return refused('wrapper', FENCE_FAULT);
  // The closing line: a line break, then the spaces or tabs that may stand before the mark, then the three backticks that end the text.
  let end = rest.length - FENCE.length;
  while (end > open[0].length && ' \t'.includes(rest[end - 1]!)) end -= 1;
  if (end <= open[0].length || rest[end - 1] !== '\n') return refused('wrapper', FENCE_FAULT);
  return accepted(trimSpace(rest.slice(open[0].length, end)));
}

/**
 * The text of the one JSON object that is the whole answer, or a refusal (step 2 in the head of this file). Only the two wrappers that say nothing are taken off. The text that is left is not
 * searched for an object: it IS the object, and the JSON parser decides whether it is. This is strict on purpose: a decision is recorded only when the answer has one reading.
 */
function objectText(text: string): ProtocolResult<string, 'wrapper'> {
  let rest = trimSpace(text.startsWith(BYTE_ORDER_MARK) ? text.slice(1) : text);
  while (rest.startsWith(THINK_OPEN)) {
    const end = rest.indexOf(THINK_CLOSE, THINK_OPEN.length);
    if (end === -1) return refused('wrapper', 'has a think block that is not closed');
    rest = trimSpace(rest.slice(end + THINK_CLOSE.length));
  }
  return rest.startsWith(FENCE) ? unfence(rest) : accepted(rest);
}

/**
 * The reasoning and the choice in the answer of a model, or a refusal. It never throws, also when the parser throws: that is a choice that the parser could not read, and so a
 * `model_output_invalid`. The reasoning is returned as it was written, with no trimming.
 */
export function readAnswer<C extends JsonValue>(answer: ModelAnswerText, parse: ChoiceParser<C>): ProtocolResult<Answer<C>, AnswerFault> {
  const { text } = answer;
  const invalid = (what: string): ProtocolResult<never, AnswerFault> => refused('model_output_invalid', `the answer of the model ${what} (an answer of ${text.length} characters)`);
  if (answer.status !== 'completed') return invalid('was not given as a completed answer');

  const unwrapped = objectText(text);
  if (!unwrapped.ok) return invalid(unwrapped.detail);
  const json = unwrapped.value;
  let parsedText: unknown;
  try {
    parsedText = JSON.parse(json);
  } catch {
    return invalid('is not one JSON object alone: it is not JSON, or it has text before or after the object');
  }
  if (typeof parsedText !== 'object' || parsedText === null || Array.isArray(parsedText)) return invalid('is JSON that is not an object');
  // `JSON.parse` keeps the last of two members that have one key, and it rounds a number to a double. A text that says more than the value that it gives is refused (see lossless.ts).
  const lost = losses(json);
  if (lost !== null) return invalid(lost);
  const data = parseJsonValue(parsedText, 'answer');
  if (!data.ok) return invalid(whereNotJson(parsedText));
  // The text is one JSON object that parsed, and the copy keeps that: the value is an object.
  const object = data.value as Record<string, unknown>;
  for (const name of ENVELOPE) if (!Object.hasOwn(object, name)) return invalid(`has the wrong members: it has no member ${name}`);
  if (Object.keys(object).some((name) => !ENVELOPE.includes(name))) return invalid('has the wrong members: it has a member that is not allowed');
  const { reasoning } = object;
  if (typeof reasoning !== 'string' || reasoning.trim() === '') return invalid('has no reasoning, a text that is not blank');
  // A member of the copy that parseJsonValue checked: plain JSON data.
  const given = object.choice as JsonValue;

  // The parser gets its own copy. The comparison below is with `given`, which the parser never sees.
  let verdict: unknown;
  try {
    verdict = parse(structuredClone(given));
  } catch {
    return invalid('has a choice that the parser of the decision could not read');
  }
  // A parser returns its result at once. A promise is a wrong parser, and its rejection must not stay unhandled: the hire was paid, and a rejection that nobody handles can stop the process.
  let ok: unknown;
  let value: unknown;
  try {
    // A promise, or any value that has a `then` function. Reading `then` can throw (a getter or a Proxy that throws), and then the catch below says that the verdict cannot be read.
    if ((typeof verdict === 'object' || typeof verdict === 'function') && verdict !== null && 'then' in verdict && typeof verdict.then === 'function') {
      void Promise.resolve(verdict).then(undefined, () => undefined);
      return refused('bad_decision', 'the parser of the decision returned a promise: a parser must return its result, and never a promise');
    }
    // The verdict is read one time. A parser that returns another value than `{ ok, value }` has no `ok` that is true.
    const members = (typeof verdict === 'object' && verdict !== null ? verdict : {}) as { ok?: unknown; value?: unknown };
    ({ ok, value } = members);
  } catch {
    return invalid('has a choice that the parser of the decision could not read');
  }
  if (ok !== true) return invalid('has a choice of another shape');

  const returned = parseJsonValue(value, 'choice');
  if (!returned.ok) return refused('choice_changed', 'the parser of the decision returned a value that is not JSON data');
  if (!sameJson(returned.value, given)) return refused('choice_changed', 'the parser of the decision returned a value that is not the choice that the model gave');
  // The parser's own value is a new copy, and it equals the choice that the model gave.
  return accepted({ reasoning, choice: returned.value as C });
}
