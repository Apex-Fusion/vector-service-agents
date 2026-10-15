// agents/document-pipeline/src/extract.ts
// The schema of an `extract` job and the reading of the model's answer against it. The schema comes from the person who hired the Pipeline and runs
// against what a model wrote, after every sub-escrow is paid, so it is held to what can be checked safely, at once and before anything is spent
// (ruling R27). It is compiled with Ajv's default draft-07, stopping at the first error, in strict mode: a misspelt keyword is refused instead of
// quietly constraining nothing, a remote $ref is never fetched and so does not resolve, and Ajv writes no warning to the console. Refused as
// schema_invalid (400):
//   - a root $async, true or false: an asynchronous validator answers with a promise, which an invalid answer rejects (and a validator Ajv compiled as
//     asynchronous all the same is refused too);
//   - the keywords pattern, patternProperties and format, wherever they stand (ruling R36). The first two hold regular expressions from the request,
//     which would run against the model's answer; format is not checked here and is refused rather than silently ignored. Two guards hold this. A
//     walk of the schema finds all three anywhere, a definition nothing refers to included, and tells a keyword from a property that has the same
//     name (a name under properties) or from data (const, enum, default, examples). And Ajv itself refuses them in every schema it compiles, which
//     covers a $ref that points into data and makes Ajv compile it as a schema: it forgets pattern and patternProperties, so strict mode refuses
//     them, and it knows no format, so it refuses any format it is asked to check.
// The check of an answer never throws and counts only a synchronous true as valid: a validator that throws (a recursive $ref on data nested past the
// stack) or answers anything else says invalid.
//
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

const REFUSED = ['pattern', 'patternProperties', 'format'] as const;
// Where draft-07 keeps subschemas: one schema; a map of schemas by name (dependencies maps to a schema or to a list of names); a list of schemas.
// `items` is one schema or a list. Every other keyword holds data or names, never a schema, and an unknown keyword is refused by strict mode.
const ONE = ['additionalItems', 'additionalProperties', 'contains', 'propertyNames', 'if', 'then', 'else', 'not'];
const MAPS = ['properties', 'patternProperties', 'definitions', '$defs', 'dependencies'];
const LISTS = ['allOf', 'anyOf', 'oneOf'];

const invalid = (why: string): PipelineError => new PipelineError('schema_invalid', `The schema cannot be used: ${why}. Nothing was spent.`, 400);
const isSchemaObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
/** The JSON pointer of `step` below `at`, escaped as RFC 6901 writes it. */
const below = (at: string, step: string | number): string => `${at}/${String(step).replaceAll('~', '~0').replaceAll('/', '~1')}`;

/**
 * The first refused keyword found in `schema` and where it stands, as a JSON pointer from the root (#), or null. Only the places that hold subschemas
 * are walked, and the walk keeps its own stack, so a schema nested deeper than the call stack is walked too.
 */
function refusedKeyword(schema: Record<string, unknown>): { keyword: string; at: string } | null {
  const stack: Array<{ node: unknown; at: string }> = [{ node: schema, at: '#' }];
  for (let next = stack.pop(); next !== undefined; next = stack.pop()) {
    const { node, at } = next;
    // A boolean schema holds no keyword; anything else that is not an object the compile refuses.
    if (!isSchemaObject(node)) continue;
    for (const keyword of REFUSED) if (Object.hasOwn(node, keyword)) return { keyword, at };
    for (const keyword of ONE) if (Object.hasOwn(node, keyword)) stack.push({ node: node[keyword], at: below(at, keyword) });
    if (Array.isArray(node.items)) node.items.forEach((item, i) => stack.push({ node: item, at: below(below(at, 'items'), i) }));
    else if (Object.hasOwn(node, 'items')) stack.push({ node: node.items, at: below(at, 'items') });
    for (const keyword of LISTS) {
      const list = node[keyword];
      if (Array.isArray(list)) list.forEach((item, i) => stack.push({ node: item, at: below(below(at, keyword), i) }));
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
  if (Object.hasOwn(schema, '$async')) throw invalid('it declares $async at the root, and an asynchronous validator answers with a promise that an invalid answer rejects');
  const refused = refusedKeyword(schema);
  if (refused !== null) {
    throw invalid(`it uses the keyword ${refused.keyword} at ${refused.at} (pattern, patternProperties and format are refused wherever they stand: the first two would run a regular expression from the request against the answer, and format is not checked)`);
  }
  let validate: Validator;
  try {
    const ajv = new Ajv({ allErrors: false, logger: false });
    ajv.removeKeyword('pattern');
    ajv.removeKeyword('patternProperties');
    validate = ajv.compile(schema);
  } catch (err) {
    throw invalid(`it does not compile as a JSON Schema of draft-07 in strict mode, with no remote reference (${errorText(err)})`);
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
 * fenced block) when it validates against the schema; otherwise it is null, with schema_valid false and the answer kept as raw_text exactly as received.
 */
export function answerResult(task: Task, text: string, check: ExtractionCheck | null): PipelineAnswer {
  if (task === 'summary') return { summary: text };
  if (check === null) throw new Error('An extraction is read with the check of its schema.');
  const block = (): { value: unknown } | null => { const inner = fencedBlock(text); return inner === null ? null : parsedJson(inner); };
  const json = parsedJson(text.trim()) ?? block();
  if (json !== null && check(json.value)) return { extraction: json.value, schema_valid: true };
  return { extraction: null, schema_valid: false, raw_text: text };
}
