// agents/document-pipeline/src/extract.ts
// The schema of an `extract` job and the reading of the model's answer against it. The schema comes from the person who hired the Pipeline, and the
// check it compiles to runs against what a model wrote after every sub-escrow is settled, in the process that runs every other job. So it is held to
// what can be checked safely and at once, before anything is fetched or posted (ruling R27); anything else is schema_invalid (400). In this order:
//   - the document as a whole (rulings R42 and R43): its JSON nesting is at most 32 levels (the root object is level 1, and every object or array inside one is
//     a level deeper, data included); no object anywhere in it has an own __proto__ key, which Ajv ignores and the prompt would carry; and its raw
//     JSON, JSON.stringify of the schema as parsed, every own key as written and nothing merged, is at most 16384 bytes, which is what the prompt to
//     the chat supplier carries. (Not its canonical form: that merges keys that are one key once normalised (NFC) and drops an own __proto__, so a
//     large schema could measure small there.)
//   - no $async at the root, true or false: an asynchronous validator answers with a promise, which an invalid answer rejects;
//   - a walk of the schema, in every place a keyword Ajv's draft-07 vocabulary knows holds a subschema (additionalItems, additionalProperties,
//     contains, propertyNames, if, then, else, not, contentSchema; items, one schema or a list; allOf, anyOf, oneOf; and the maps properties and
//     dependencies; the three other maps, patternProperties, definitions and $defs, are refused where they stand), refuses the keywords
//       $ref, $dynamicRef, $recursiveRef, $id, $defs and definitions (ruling R42): a chain or a cycle of references makes the check of a short answer
//         take time and memory exponential in the schema, until the process runs out of heap, which no try survives. v1 takes no reference of any
//         kind, and none of the keywords that name or hold what a reference would point at;
//       pattern, patternProperties and format (ruling R36): the first two hold regular expressions from the request, which would run against the
//         answer; format is not checked here, and is refused rather than silently ignored;
//     and an allOf, anyOf or oneOf of more than 16 entries. A property name under properties is not a keyword, and data (const, enum, default,
//     examples) is not walked: nothing refers into it, since no reference is taken;
//   - Ajv compiles it as draft-07, stopping at the first error, in strict mode, so an unknown or misspelt keyword is refused. Ajv is a second guard
//     over every schema it compiles: it forgets pattern and patternProperties, so strict mode refuses them, and it knows no format, so it refuses any
//     format it is asked to check. A validator it compiled as asynchronous all the same is refused.
// What is not bounded: the work of a check grows with the size of the answer times the size of the schema, and uniqueItems compares items pairwise.
// The answer is bounded by the chat supplier's output limit, and the schema by the bounds above.
//
// The check of an answer never throws and counts only a synchronous true as valid: a validator that throws, or answers anything else, says invalid.
// The answer is read as JSON as it is first; only when that fails is the first fenced block looked for, with indexOf and no regular expression, so
// reading any answer is linear in its length. One that is not JSON, or does not validate, is kept as raw_text with schema_valid false: the job still
// succeeds, the supplier delivered.
import Ajv from 'ajv';
import { errorText } from './format.ts';
import type { Task } from './request.ts';
import { PipelineError } from './result.ts';
import type { PipelineAnswer } from './result.ts';

/** Whether a value is valid against the schema of an extract request. Never throws. */
export type ExtractionCheck = (value: unknown) => boolean;
/** A compiled validator as Ajv hands it over: called with the answer, and marked $async when it answers with a promise. */
export type Validator = ((value: unknown) => unknown) & { $async?: unknown };

/** The most levels of JSON nesting an extraction schema may have (ruling R42). */
export const SCHEMA_MAX_DEPTH = 32;
/** The most bytes the raw JSON of an extraction schema may have (ruling R42). */
export const SCHEMA_MAX_BYTES = 16_384;
/** The most entries an allOf, anyOf or oneOf may have (ruling R42). */
export const COMBINATION_MAX_ENTRIES = 16;
/** The most characters of a place in the schema a refusal names. */
const PLACE_MAX_CHARACTERS = 200;

const REFERENCES = ['$ref', '$dynamicRef', '$recursiveRef', '$id', '$defs', 'definitions'] as const;
const EXPRESSIONS = ['pattern', 'patternProperties', 'format'] as const;
// Where Ajv's draft-07 vocabulary keeps subschemas: one schema; a map of schemas by name (dependencies maps to a schema or to a list of names); a
// list of schemas. `items` is one schema or a list. contentSchema is an annotation Ajv never compiles, walked all the same. The other maps
// (patternProperties, definitions, $defs) are refused keywords, so the walk never descends into them.
const ONE = ['additionalItems', 'additionalProperties', 'contains', 'propertyNames', 'if', 'then', 'else', 'not', 'contentSchema'];
const MAPS = ['properties', 'dependencies'];
const LISTS = ['allOf', 'anyOf', 'oneOf'];

const invalid = (why: string): PipelineError => new PipelineError('schema_invalid', `The schema cannot be used: ${why}. Nothing was locked.`, 400);
const isSchemaObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
/** The JSON pointer of `step` below `at`, escaped as RFC 6901 writes it. */
const below = (at: string, step: string | number): string => `${at}/${String(step).replaceAll('~', '~0').replaceAll('/', '~1')}`;
/** A place as a refusal names it: at most 200 characters of its pointer. */
const place = (at: string): string => (at.length > PLACE_MAX_CHARACTERS ? `${at.slice(0, PLACE_MAX_CHARACTERS)}...` : at);

/**
 * One pass over a JSON value that keeps its own stack, so a value nested past the call stack is walked without a crash: `visit` sees every object and
 * array with its level (the root is level 1, every object or array inside one a level deeper) and its place, a JSON pointer it builds only when asked,
 * and the walk stops at the first refusal `visit` gives.
 */
function walkJson(root: object, visit: (node: object, depth: number, at: () => string) => string | null): string | null {
  type Frame = { node: object; depth: number; up: Frame | null; step: string | number | null };
  const placeOf = (frame: Frame): string => {
    const steps: Array<string | number> = [];
    for (let f: Frame | null = frame; f !== null && f.step !== null; f = f.up) steps.push(f.step);
    return steps.reverse().reduce<string>((at, step) => below(at, step), '#');
  };
  const stack: Frame[] = [{ node: root, depth: 1, up: null, step: null }];
  for (let frame = stack.pop(); frame !== undefined; frame = stack.pop()) {
    const here = frame;
    const refusal = visit(here.node, here.depth, () => placeOf(here));
    if (refusal !== null) return refusal;
    const children: Array<[string | number, unknown]> = Array.isArray(here.node) ? here.node.map((child, i) => [i, child]) : Object.entries(here.node);
    for (const [step, child] of children) if (child !== null && typeof child === 'object') stack.push({ node: child, depth: here.depth + 1, up: here, step });
  }
  return null;
}

/** Why the document as a whole is refused, or null: nested deeper than 32 levels, or an own __proto__ key in any object of it. */
function documentRefusal(schema: Record<string, unknown>): string | null {
  return walkJson(schema, (node, depth, at) => {
    if (depth > SCHEMA_MAX_DEPTH) return `its JSON is nested deeper than ${SCHEMA_MAX_DEPTH} levels`;
    if (!Array.isArray(node) && Object.hasOwn(node, '__proto__')) return `it has an own __proto__ key at ${place(below(at(), '__proto__'))} (Ajv ignores it, and the prompt would carry it)`;
    return null;
  });
}

/** Is a value of an answer nested deeper than the 32 levels a schema may have (ruling R62)? The walk of documentRefusal, with its bound. */
const nestedTooDeep = (value: unknown): boolean => value !== null && typeof value === 'object' && walkJson(value, (_node, depth) => (depth > SCHEMA_MAX_DEPTH ? 'deep' : null)) !== null;

/** Why the walk refuses `schema` (see the head of this file), or null. The walk keeps its own stack. */
function walkRefusal(schema: Record<string, unknown>): string | null {
  const stack: Array<{ node: unknown; at: string }> = [{ node: schema, at: '#' }];
  for (let next = stack.pop(); next !== undefined; next = stack.pop()) {
    const { node, at } = next;
    // A boolean schema holds no keyword; anything else that is not an object the compile refuses.
    if (!isSchemaObject(node)) continue;
    for (const keyword of REFERENCES) {
      if (Object.hasOwn(node, keyword)) return `it uses the keyword ${keyword} at ${place(at)} (v1 takes no reference: a chain or a cycle of references makes the check of an answer exponential)`;
    }
    for (const keyword of EXPRESSIONS) {
      if (Object.hasOwn(node, keyword)) return `it uses the keyword ${keyword} at ${place(at)} (pattern, patternProperties and format are refused: the first two would run a regular expression from the request against the answer, and format is not checked)`;
    }
    for (const keyword of ONE) if (Object.hasOwn(node, keyword)) stack.push({ node: node[keyword], at: below(at, keyword) });
    if (Array.isArray(node.items)) node.items.forEach((item, i) => stack.push({ node: item, at: below(below(at, 'items'), i) }));
    else if (Object.hasOwn(node, 'items')) stack.push({ node: node.items, at: below(at, 'items') });
    for (const keyword of LISTS) {
      const list = node[keyword];
      if (!Array.isArray(list)) continue;
      if (list.length > COMBINATION_MAX_ENTRIES) return `the ${keyword} at ${place(at)} has ${list.length} entries, more than ${COMBINATION_MAX_ENTRIES}`;
      list.forEach((item, i) => stack.push({ node: item, at: below(below(at, keyword), i) }));
    }
    for (const keyword of MAPS) {
      const map = node[keyword];
      if (!isSchemaObject(map)) continue;
      for (const [name, sub] of Object.entries(map)) stack.push({ node: sub, at: below(below(at, keyword), name) });
    }
  }
  return null;
}

/**
 * The Ajv every extraction schema is compiled with: draft-07, stopping at the first error, strict, silent, reading only the own properties of the answer
 * (ownProperties: a key the answer inherits, from its prototype, is no key of the answer), without pattern and patternProperties (strict mode refuses
 * them as unknown keywords) and with no format defined (any format is refused as unknown). The second guard of the head of this file.
 */
export function extractionAjv(): Ajv {
  const ajv = new Ajv({ allErrors: false, logger: false, ownProperties: true });
  ajv.removeKeyword('pattern');
  ajv.removeKeyword('patternProperties');
  return ajv;
}

/**
 * The check of an answer that `validate` makes: true only for a synchronous true. A validator Ajv compiled as asynchronous is refused (schema_invalid,
 * 400). One that throws, or answers anything but true, says invalid; a promise, should one come, is never left to reject unhandled.
 */
export function checkOf(validate: Validator): ExtractionCheck {
  if (validate.$async === true) throw invalid('it compiles to an asynchronous validator, whose verdict would be a promise');
  return (value) => {
    let verdict: unknown;
    try { verdict = validate(value); } catch { return false; }
    if (verdict === true) return true;
    if (verdict !== null && typeof verdict === 'object' && typeof (verdict as Promise<unknown>).catch === 'function') (verdict as Promise<unknown>).catch(() => undefined);
    return false;
  };
}

/** Compiles the schema of an extract request, before anything is fetched or posted (see the head of this file). Throws schema_invalid (400). */
export function compileExtractionSchema(schema: Record<string, unknown> | undefined): ExtractionCheck {
  if (schema === undefined) throw invalid('task "extract" needs a schema');
  const document = documentRefusal(schema);
  if (document !== null) throw invalid(document);
  const bytes = Buffer.byteLength(JSON.stringify(schema), 'utf8');
  if (bytes > SCHEMA_MAX_BYTES) throw invalid(`it is ${bytes} bytes of JSON, more than ${SCHEMA_MAX_BYTES}`);
  if (Object.hasOwn(schema, '$async')) throw invalid('it declares $async at the root, and an asynchronous validator answers with a promise that an invalid answer rejects');
  const refusal = walkRefusal(schema);
  if (refusal !== null) throw invalid(refusal);
  let validate: Validator;
  try { validate = extractionAjv().compile(schema); } catch (err) {
    throw invalid(`it does not compile as a JSON Schema of draft-07 in strict mode (${errorText(err)})`);
  }
  return checkOf(validate);
}

const FENCE = '```';
/** A letter, a digit, a hyphen or an underscore: what a language tag after an opening fence is made of. */
const isTagCharacter = (code: number): boolean => (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 45 || code === 95;

/** The content of the first fenced block of `text`, without the language tag of its opening fence and trimmed, or null when there is none. Linear. */
function fencedBlock(text: string): string | null {
  const open = text.indexOf(FENCE);
  if (open < 0) return null;
  let start = open + FENCE.length;
  while (start < text.length && isTagCharacter(text.charCodeAt(start))) start += 1;
  const close = text.indexOf(FENCE, start);
  return close < 0 ? null : text.slice(start, close).trim();
}

function parsedJson(text: string): { value: unknown } | null {
  if (text === '') return null;
  try { return { value: JSON.parse(text) as unknown }; } catch { return null; }
}

/**
 * The `result` of a run from the chat answer. A summary is the answer text. An extraction is the answer's JSON value (the whole answer, else its first
 * fenced block) when it is nested no deeper than a schema may be (32 levels, ruling R62: the result is serialised after every sub-escrow is settled, and a
 * value nested past what JSON.stringify can walk would throw there) and validates against the schema; otherwise it is null, with schema_valid false and
 * the answer kept as raw_text exactly as received.
 */
export function answerResult(task: Task, text: string, check: ExtractionCheck | null): PipelineAnswer {
  if (task === 'summary') return { summary: text };
  if (check === null) throw new Error('An extraction is read with the check of its schema.');
  const block = (): { value: unknown } | null => { const inner = fencedBlock(text); return inner === null ? null : parsedJson(inner); };
  const json = parsedJson(text.trim()) ?? block();
  if (json !== null && !nestedTooDeep(json.value) && check(json.value)) return { extraction: json.value, schema_valid: true };
  return { extraction: null, schema_valid: false, raw_text: text };
}
