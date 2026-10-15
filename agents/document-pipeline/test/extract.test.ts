// agents/document-pipeline/test/extract.test.ts
// The extraction schema and the reading of the model's answer against it. The schema comes from the person who hired the Pipeline and runs against
// what a model wrote, after every sub-escrow is paid, so it is held to what can be checked safely and at once (rulings R27, R36, R42): draft-07,
// compiled in strict mode; no reference of any kind ($ref and the keywords that name or hold what a reference points at), because a chain or a cycle
// of references makes the check of a short answer take time and memory exponential in the schema; no asynchronous schema (its validator answers with
// a promise that an invalid answer rejects); none of pattern, patternProperties or format (a regular expression from the request would run against
// the answer, and format is not checked here); and bounds on the schema itself: 32 levels of nesting, 16384 bytes of canonical JSON, 16 entries in an
// anyOf, oneOf or allOf. The check of an answer never throws and never answers anything but a synchronous true for a valid one. The answer is read
// as JSON as it is, and only when that fails is the first fenced block looked for, without a regular expression.
import { describe, it, expect } from 'vitest';
import Ajv from 'ajv';
import { canonicalize } from '@vsa/vector-read';
import { answerResult, checkOf, compileExtractionSchema, extractionAjv } from '../src/extract.ts';
import { PipelineError } from '../src/result.ts';

const TITLE = { type: 'object', required: ['title'], properties: { title: { type: 'string' } } };

/** The schema_invalid refusal of compiling `schema`, its message checked against `message`. */
function refused(schema: Record<string, unknown> | undefined, message: RegExp): void {
  let error: unknown;
  try { compileExtractionSchema(schema); } catch (err) { error = err; }
  expect(error).toBeInstanceOf(PipelineError);
  expect(error).toMatchObject({ code: 'schema_invalid', status: 400 });
  expect((error as Error).message).toMatch(message);
}

/** `inner` wrapped in `levels` objects of the form {not: ...}: a schema `levels + 1` levels deep. */
function nested(levels: number, inner: Record<string, unknown> = { type: 'string' }): Record<string, unknown> {
  let schema = inner;
  for (let i = 0; i < levels; i++) schema = { not: schema };
  return schema;
}

describe('compileExtractionSchema', () => {
  it('compiles a draft-07 schema into a check of an answer', () => {
    const check = compileExtractionSchema(TITLE);
    expect(check({ title: 'A letter' })).toBe(true);
    expect(check({ name: 'A letter' })).toBe(false);
  });

  it('compiles a plain object schema with nested properties, and checks an answer at every level', () => {
    const check = compileExtractionSchema({
      type: 'object', required: ['title', 'sender'],
      properties: {
        title: { type: 'string' },
        sender: { type: 'object', required: ['name', 'address'], properties: { name: { type: 'string' }, address: { type: 'object', properties: { city: { type: 'string' } } } } },
        pages: { type: 'array', items: { type: 'object', properties: { index: { type: 'integer', minimum: 0 } } } },
      },
    });
    expect(check({ title: 'A letter', sender: { name: 'The city archive', address: { city: 'Split' } }, pages: [{ index: 0 }] })).toBe(true);
    expect(check({ title: 'A letter', sender: { name: 'The city archive', address: { city: 7 } } })).toBe(false);
    expect(check({ title: 'A letter', sender: { name: 'The city archive' } })).toBe(false);
    expect(check({ title: 'A letter', sender: { name: 'The city archive', address: {} }, pages: [{ index: -1 }] })).toBe(false);
  });

  it('refuses a missing schema, one that is not valid draft-07 and a misspelt keyword (strict mode): schema_invalid, 400', () => {
    refused(undefined, /needs a schema/);
    refused({ type: 'objekt' }, /schema is invalid/);
    refused({ type: 'object', requird: ['title'] }, /unknown keyword: "requird"/);
  });

  it('refuses a root $async, true or false: an asynchronous validator answers with a promise, which an invalid answer rejects', () => {
    refused({ $async: true, type: 'object' }, /\$async/);
    refused({ $async: false, type: 'object' }, /\$async/);
  });

  it('refuses pattern, patternProperties and format as keywords in every place a schema holds a subschema, naming the place', () => {
    refused({ type: 'string', pattern: 'a+' }, /pattern at # /);
    refused({ type: 'object', patternProperties: { '^a': { type: 'string' } } }, /patternProperties at # /);
    refused({ type: 'string', format: 'date' }, /format at # /);
    refused({ type: 'object', properties: { a: { type: 'object', properties: { b: { type: 'array', items: { type: 'string', pattern: 'x' } } } } } }, /pattern at #\/properties\/a\/properties\/b\/items /);
    refused({ type: 'array', items: [{ type: 'string' }, { type: 'string', format: 'email' }] }, /format at #\/items\/1 /);
    refused({ anyOf: [{ type: 'number' }, { type: 'string', format: 'uri' }] }, /format at #\/anyOf\/1 /);
    refused({ type: 'object', additionalProperties: { type: 'string', format: 'uuid' } }, /format at #\/additionalProperties /);
    refused({ type: 'object', dependencies: { a: { properties: { b: { type: 'string', pattern: 'y' } } } } }, /pattern at #\/dependencies\/a\/properties\/b /);
    refused({ not: { type: 'string', format: 'date' } }, /format at #\/not /);
    refused({ if: { type: 'string' }, then: { pattern: 'z' }, else: { type: 'number' } }, /pattern at #\/then /);
    // An annotation Ajv never compiles is walked all the same: what the walk refuses, it refuses wherever a subschema can stand.
    refused({ type: 'string', contentMediaType: 'application/json', contentSchema: { type: 'object', patternProperties: { x: {} } } }, /patternProperties at #\/contentSchema /);
  });

  it('takes a property named format, pattern or patternProperties: a name under properties is not a keyword, and neither is data', () => {
    const schema = {
      type: 'object', required: ['format', 'pattern'],
      properties: {
        format: { type: 'string' }, pattern: { type: 'string' }, patternProperties: { type: 'object', properties: { format: { type: 'number' } } },
      },
      default: { format: 'A4', pattern: 'x' }, examples: [{ format: 'A5' }], enum: [{ format: 'A4', pattern: 'x' }, { format: 'A5', pattern: 'y' }],
    };
    const check = compileExtractionSchema(schema);
    expect(check({ format: 'A4', pattern: 'x' })).toBe(true);
    expect(check({ format: 'Letter', pattern: 'x' })).toBe(false);
  });

  it('caps the place it names at 200 characters', () => {
    const long = 'p'.repeat(150);
    let error: unknown;
    try { compileExtractionSchema({ type: 'object', properties: { [long]: { type: 'object', properties: { [long]: { type: 'string', pattern: 'x' } } } } }); } catch (err) { error = err; }
    const place = /pattern at (\S+) /.exec((error as Error).message)?.[1] ?? '';
    expect(place).toBe(`${`#/properties/${long}/properties/${long}`.slice(0, 200)}...`);
  });
});

// Ruling R42: Ajv has no limit on the work a reference can cause. A chain of definitions each referring twice to the next under anyOf, about 1.8 KB
// at 23 levels, or a recursive tree checked against a short nested answer, makes the check run out of heap after the chat Accept: a process abort that
// no try catches and that ends every run in flight. So v1 refuses every reference and everything a reference could name or hold, and bounds the schema.
describe('compileExtractionSchema: references refused and the schema bounded (ruling R42)', () => {
  /** The chain of the review: `levels` definitions, each an anyOf of two references to the next one. */
  const chain = (levels: number): Record<string, unknown> => {
    const definitions: Record<string, unknown> = { [`d${levels}`]: { type: 'string' } };
    for (let i = 0; i < levels; i++) definitions[`d${i}`] = { anyOf: [{ $ref: `#/definitions/d${i + 1}` }, { $ref: `#/definitions/d${i + 1}` }] };
    return { $ref: '#/definitions/d0', definitions };
  };

  it('refuses the reference chain of the review (23 levels, about 1.8 KB) at once', () => {
    const schema = chain(23);
    expect(Buffer.byteLength(canonicalize(schema))).toBeGreaterThan(1_500);
    const started = performance.now();
    refused(schema, /\$ref at # \(/);
    expect(performance.now() - started).toBeLessThan(200);
  });

  it('refuses a recursive tree, whether it refers to a definition or to the root', () => {
    refused({ $ref: '#/definitions/tree', definitions: { tree: { type: 'object', properties: { children: { type: 'array', items: { $ref: '#/definitions/tree' } } } } } }, /\$ref at # \(/);
    refused({ type: 'object', properties: { children: { type: 'array', items: { $ref: '#' } } } }, /\$ref at #\/properties\/children\/items \(/);
  });

  it('refuses every keyword that is or serves a reference: $ref, $dynamicRef, $recursiveRef, $id, $defs and definitions, at the root and at depth', () => {
    refused({ $id: 'https://203.0.113.9/schema.json', type: 'string' }, /\$id at # \(/);
    refused({ type: 'object', $defs: { a: { type: 'string' } } }, /\$defs at # \(/);
    refused({ type: 'object', definitions: { unused: { type: 'string' } } }, /definitions at # \(/);
    refused({ type: 'array', items: { $dynamicRef: '#node' } }, /\$dynamicRef at #\/items \(/);
    refused({ anyOf: [{ type: 'string' }, { $recursiveRef: '#' }] }, /\$recursiveRef at #\/anyOf\/1 \(/);
    refused({ type: 'object', properties: { a: { type: 'object', properties: { b: { $ref: 'https://203.0.113.9/other.json' } } } } }, /\$ref at #\/properties\/a\/properties\/b \(/);
  });

  it('takes the same words as property names and in data, where they refer to nothing', () => {
    const check = compileExtractionSchema({
      type: 'object', properties: { $ref: { type: 'string' }, $id: { type: 'integer' }, definitions: { type: 'array' } },
      default: { $ref: '#/default', definitions: {} }, examples: [{ $ref: 'x' }],
    });
    expect(check({ $ref: 'A1', $id: 7, definitions: [] })).toBe(true);
    expect(check({ $ref: 1 })).toBe(false);
  });

  it('takes a schema of 32 levels and refuses one of 33, data included', () => {
    // Thirty-one nots around a string type: an odd number, so a string is invalid and a number valid.
    const check = compileExtractionSchema(nested(31));
    expect([check(1), check('x')]).toStrictEqual([true, false]);
    refused(nested(32), /deeper than 32 levels/);
    // Data counts: a default 31 levels deep under the root is 32 levels, one 32 levels deep is 33.
    expect(() => compileExtractionSchema({ type: 'object', default: nested(30) })).not.toThrow();
    refused({ type: 'object', default: nested(31) }, /deeper than 32 levels/);
    // A schema nested past the call stack is refused by the same bound, without a crash.
    refused(nested(100_000), /deeper than 32 levels/);
  });

  it('takes a schema of 16384 bytes of canonical JSON and refuses one of 16385', () => {
    const sized = (bytes: number): Record<string, unknown> => ({ type: 'object', description: 'x'.repeat(bytes - 34) });
    expect(Buffer.byteLength(canonicalize(sized(16_384)))).toBe(16_384);
    expect(compileExtractionSchema(sized(16_384))({})).toBe(true);
    expect(Buffer.byteLength(canonicalize(sized(16_385)))).toBe(16_385);
    refused(sized(16_385), /16385 bytes of canonical JSON, more than 16384/);
  });

  it('takes 16 entries in an anyOf, a oneOf or an allOf and refuses 17, at any depth', () => {
    const entries = (n: number) => Array.from({ length: n }, (_, i) => ({ const: i }));
    for (const keyword of ['anyOf', 'oneOf', 'allOf']) {
      expect(() => compileExtractionSchema({ [keyword]: entries(16) }), keyword).not.toThrow();
      refused({ [keyword]: entries(17) }, new RegExp(`${keyword} at # has 17 entries, more than 16`));
      refused({ type: 'object', properties: { a: { [keyword]: entries(17) } } }, new RegExp(`${keyword} at #/properties/a has 17 entries`));
    }
  });
});

describe('extractionAjv: the second guard, Ajv itself', () => {
  it('knows no pattern, no patternProperties and no format, so it refuses them in every schema it compiles, whatever the walk saw', () => {
    expect(() => extractionAjv().compile({ type: 'string', pattern: '^(a+)+$' })).toThrow(/unknown keyword: "pattern"/);
    expect(() => extractionAjv().compile({ type: 'object', patternProperties: { '^a': {} } })).toThrow(/unknown keyword: "patternProperties"/);
    expect(() => extractionAjv().compile({ type: 'string', format: 'date' })).toThrow(/unknown format "date"/);
    expect(() => extractionAjv().compile({ type: 'object', requird: [] })).toThrow(/unknown keyword: "requird"/);
  });
});

describe('checkOf: what a compiled validator may answer', () => {
  it('refuses a validator Ajv compiled as asynchronous: schema_invalid, 400', () => {
    const validate = new Ajv({ logger: false }).compile({ $async: true, type: 'object' });
    expect(validate.$async).toBe(true);
    let error: unknown;
    try { checkOf(validate); } catch (err) { error = err; }
    expect(error).toMatchObject({ name: 'PipelineError', code: 'schema_invalid', status: 400 });
  });

  it('counts only a synchronous true as valid: a promise, a truthy value or a throw is invalid, and a promise is never left to reject unhandled', async () => {
    let unhandled = 0;
    const onUnhandled = (): void => { unhandled += 1; };
    process.on('unhandledRejection', onUnhandled);
    try {
      expect(checkOf(Object.assign(() => true, {}))('x')).toBe(true);
      expect(checkOf(Object.assign(() => 1, {}))('x')).toBe(false);
      expect(checkOf(Object.assign(() => { throw new RangeError('Maximum call stack size exceeded'); }, {}))('x')).toBe(false);
      expect(checkOf(Object.assign(() => Promise.reject(new Error('invalid')), {}))('x')).toBe(false);
      expect(checkOf(Object.assign(() => Promise.resolve(true), {}))('x')).toBe(false);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(unhandled).toBe(0);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('a validator that throws on data nested past the stack says invalid, not a crash (a recursive schema compiled outside the walk)', () => {
    const recursive = extractionAjv().compile({ $ref: '#/definitions/node', definitions: { node: { type: 'array', items: { $ref: '#/definitions/node' } } } });
    const check = checkOf(recursive);
    let deep: unknown[] = [];
    for (let i = 0; i < 100_000; i++) deep = [deep];
    expect(check([[[]]])).toBe(true);
    expect(check(deep)).toBe(false);
  });
});

describe('answerResult', () => {
  const check = compileExtractionSchema(TITLE);

  it('a summary is the answer text', () => {
    expect(answerResult('summary', 'A text.', null)).toStrictEqual({ summary: 'A text.' });
  });

  it('reads the answer as JSON as it is first, and only then the first fenced block', () => {
    expect(answerResult('extract', ' {"title":"A letter"}\n', check)).toStrictEqual({ extraction: { title: 'A letter' }, schema_valid: true });
    expect(answerResult('extract', 'Here:\n```json\n{"title":"A letter"}\n```\nDone.', check)).toStrictEqual({ extraction: { title: 'A letter' }, schema_valid: true });
    expect(answerResult('extract', '```{"title":"A letter"}```', check)).toStrictEqual({ extraction: { title: 'A letter' }, schema_valid: true });
    expect(answerResult('extract', '{"title":"```json {} ```"}', check)).toStrictEqual({ extraction: { title: '```json {} ```' }, schema_valid: true });
    expect(answerResult('extract', '```json\n{"name":"A letter"}\n```', check)).toStrictEqual({ extraction: null, schema_valid: false, raw_text: '```json\n{"name":"A letter"}\n```' });
    expect(answerResult('extract', 'not json', check)).toStrictEqual({ extraction: null, schema_valid: false, raw_text: 'not json' });
  });

  it('reads an answer of an opening fence and 50000 blank characters in linear time (no regular expression to backtrack)', () => {
    const answer = `Here it is:\n\`\`\`json\n${' \t'.repeat(25_000)}`;
    const started = performance.now();
    expect(answerResult('extract', answer, check)).toStrictEqual({ extraction: null, schema_valid: false, raw_text: answer });
    expect(performance.now() - started).toBeLessThan(200);
  });
});
