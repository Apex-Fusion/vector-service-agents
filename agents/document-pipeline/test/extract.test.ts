// agents/document-pipeline/test/extract.test.ts
// The extraction schema and the reading of the model's answer against it. The schema comes from the person who hired the Pipeline and runs against
// what a model wrote, after every sub-escrow is paid, so it is held to what can be checked safely and at once: draft-07, compiled in strict mode, no
// asynchronous schema (its validator returns a promise that an invalid answer rejects), and none of pattern, patternProperties or format (a regular
// expression from the request would run against the answer; format is not checked here and is refused rather than silently ignored). The check of an
// answer never throws and never answers anything but a synchronous true for a valid one. The answer is read as JSON as it is, and only when that
// fails is the first fenced block looked for, without a regular expression.
import { describe, it, expect } from 'vitest';
import Ajv from 'ajv';
import { answerResult, checkOf, compileExtractionSchema } from '../src/extract.ts';
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

describe('compileExtractionSchema', () => {
  it('compiles a draft-07 schema into a check of an answer', () => {
    const check = compileExtractionSchema(TITLE);
    expect(check({ title: 'A letter' })).toBe(true);
    expect(check({ name: 'A letter' })).toBe(false);
  });

  it('refuses a missing schema, one that is not valid draft-07, a misspelt keyword (strict mode) and a remote reference: schema_invalid, 400', () => {
    refused(undefined, /needs a schema/);
    refused({ type: 'objekt' }, /schema is invalid/);
    refused({ type: 'object', requird: ['title'] }, /unknown keyword: "requird"/);
    refused({ $ref: 'https://203.0.113.9/schema.json' }, /can't resolve reference/);
  });

  it('refuses a root $async, true or false: an asynchronous validator answers with a promise, which an invalid answer rejects', () => {
    refused({ $async: true, type: 'object' }, /\$async/);
    refused({ $async: false, type: 'object' }, /\$async/);
  });

  it('refuses pattern, patternProperties and format as keywords wherever they stand, naming the place', () => {
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
    // A definition that nothing refers to is never compiled, so strict mode alone would not see it: the walk does.
    refused({ type: 'object', definitions: { unused: { type: 'string', pattern: 'x' } } }, /pattern at #\/definitions\/unused /);
  });

  it('refuses them where only Ajv sees a schema: a $ref into data (default, enum) is compiled as one, and Ajv knows no pattern and no format', () => {
    refused({ $ref: '#/default', default: { type: 'string', pattern: '^(a+)+$' } }, /unknown keyword: "pattern"/);
    refused({ $ref: '#/enum/0', enum: [{ type: 'object', patternProperties: { '^a': {} } }] }, /unknown keyword: "patternProperties"/);
    refused({ $ref: '#/default', default: { type: 'string', format: 'date' } }, /unknown format "date"/);
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

  it('refuses a schema nested deeper than the stack, without a crash', () => {
    let schema: Record<string, unknown> = { type: 'string' };
    for (let i = 0; i < 20_000; i++) schema = { not: schema };
    refused(schema, /cannot be used/);
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

  it('a recursive schema on data nested past the stack is invalid, not a crash', () => {
    const check = compileExtractionSchema({ $ref: '#/definitions/node', definitions: { node: { type: 'array', items: { $ref: '#/definitions/node' } } } });
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
