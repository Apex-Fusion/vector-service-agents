// packages/usecase-kit/test/manifest/fields.test.ts: the members that the agents add under `behaviour`, one validator for each. A validator takes any value and never throws. Each refusal has an
// accepted twin, and no detail repeats a value that failed.
import { describe, expect, it } from 'vitest';
import { MAX_STATEMENT_CHARS, MAX_URI_CHARS, buildClaim, parseClaim, parseFileRef, parseModel, parseRelyingOn } from '@vsa/usecase-kit/manifest';
import { BAD_MARKER, MARKER, copy } from '../protocol/support.ts';
import { CLAIM, LOTS, MODEL, RELYING_ON, refusal } from './support.ts';

const statements = (...texts: string[]) => ({ statements: texts.map((text, index) => ({ id: `S${index + 1}`, text })) });

describe('buildClaim', () => {
  it('makes the claim from three texts, with the ids S1, S2 and S3 in this order and nothing else', () => {
    expect(buildClaim([...CLAIM])).toStrictEqual({
      ok: true,
      value: { statements: [{ id: 'S1', text: CLAIM[0] }, { id: 'S2', text: CLAIM[1] }, { id: 'S3', text: CLAIM[2] }] },
    });
  });

  it('has no claim reference: the claim has one member, and a statement has two', () => {
    const result = buildClaim([...CLAIM]);
    if (!result.ok) throw new Error(result.detail);
    expect(Object.keys(result.value)).toStrictEqual(['statements']);
    for (const statement of result.value.statements) expect(Object.keys(statement)).toStrictEqual(['id', 'text']);
    expect(JSON.stringify(result.value)).not.toMatch(/ref/i);
  });

  it.each([
    ['two texts', [CLAIM[0], CLAIM[1]]],
    ['four texts', [...CLAIM, 'A fourth statement.']],
    ['no text', []],
    ['an object', { statements: [...CLAIM] }],
    ['a text', CLAIM[0]],
    ['a null', null],
    ['an undefined', undefined],
    ['a hole', [CLAIM[0], , CLAIM[2]]],
    ['a number', [CLAIM[0], 2, CLAIM[2]]],
    ['a null text', [CLAIM[0], null, CLAIM[2]]],
    ['an empty text', [CLAIM[0], '', CLAIM[2]]],
    ['a text with a space at its start', [CLAIM[0], ` ${CLAIM[1]}`, CLAIM[2]]],
    ['a text with a line break at its end', [CLAIM[0], `${CLAIM[1]}\n`, CLAIM[2]]],
    ['a text with a line break inside', [CLAIM[0], 'First line.\nSecond line.', CLAIM[2]]],
    ['a text with a control character', [CLAIM[0], 'A\u0000B', CLAIM[2]]],
    ['a text that is too long', [CLAIM[0], 'x'.repeat(MAX_STATEMENT_CHARS + 1), CLAIM[2]]],
    ['the same text twice', [CLAIM[0], CLAIM[0], CLAIM[2]]],
  ])('refuses %s', (_name, input) => {
    expect(buildClaim(input)).toMatchObject({ ok: false, code: 'bad_shape' });
  });

  it('takes a statement of the longest length, and a text with an inner space: the twins', () => {
    expect(buildClaim(['x'.repeat(MAX_STATEMENT_CHARS), 'Two words.', CLAIM[2]])).toMatchObject({ ok: true });
  });

  it('does not throw for an array that cannot be read', () => {
    const thrower = new Proxy([CLAIM[0], CLAIM[1], CLAIM[2]], { get: () => { throw new Error(MARKER); } });
    const result = buildClaim(thrower);
    expect(result).toMatchObject({ ok: false, code: 'bad_shape' });
    expect(JSON.stringify(result)).not.toContain(MARKER);
    const accessor = [CLAIM[0], CLAIM[1], CLAIM[2]];
    Object.defineProperty(accessor, 1, { get: () => CLAIM[1], enumerable: true });
    expect(buildClaim(accessor)).toMatchObject({ ok: false, code: 'bad_shape' });
  });

  it('never repeats the text that failed', () => {
    expect(JSON.stringify(refusal(buildClaim([CLAIM[0], `${BAD_MARKER}\n`, CLAIM[2]])))).not.toContain(BAD_MARKER);
  });
});

describe('parseClaim', () => {
  it('takes the claim of three statements and returns a new object', () => {
    const input = statements(...CLAIM);
    const result = parseClaim(input);
    expect(result).toStrictEqual({ ok: true, value: input });
    expect(result.ok && result.value).not.toBe(input);
  });

  it('refuses a claim reference, in the claim and in a statement', () => {
    expect(refusal(parseClaim({ ...statements(...CLAIM), reference: 'ab#0' })).detail).toBe('behaviour.claim has the member "reference", which is not allowed');
    expect(refusal(parseClaim({ ...statements(...CLAIM), claim_ref: 'ab#0' })).code).toBe('bad_shape');
    const withRef = copy(statements(...CLAIM));
    Object.assign(withRef.statements[0], { reference: 'ab#0' });
    expect(parseClaim(withRef)).toMatchObject({ ok: false, code: 'bad_shape' });
  });

  it('refuses statements that are not S1, S2 and S3 in this order', () => {
    const swapped = statements(...CLAIM);
    swapped.statements.reverse();
    expect(parseClaim(swapped)).toMatchObject({ ok: false, code: 'bad_shape' });
    const renamed = copy(statements(...CLAIM));
    renamed.statements[2].id = 'S4';
    expect(parseClaim(renamed)).toMatchObject({ ok: false, code: 'bad_shape' });
    expect(parseClaim(statements(...CLAIM))).toMatchObject({ ok: true });
  });

  it('refuses the wrong number of statements, a statement that is not an object, and a missing text', () => {
    expect(parseClaim(statements(CLAIM[0], CLAIM[1]))).toMatchObject({ ok: false });
    expect(parseClaim({ statements: [...CLAIM] })).toMatchObject({ ok: false });
    expect(parseClaim({ statements: [{ id: 'S1' }, { id: 'S2', text: 'b' }, { id: 'S3', text: 'c' }] })).toMatchObject({ ok: false });
    expect(parseClaim({})).toMatchObject({ ok: false });
    expect(parseClaim(null)).toMatchObject({ ok: false });
  });
});

describe('parseModel', () => {
  it('takes the models and the ceiling, and returns new arrays', () => {
    const input = { allowlist: ['deepseek/deepseek-v4-flash', 'qwen2.5:0.5b', 'openai/gpt-4o-mini:free'], max_price_lovelace: 1 };
    const result = parseModel(input);
    expect(result).toStrictEqual({ ok: true, value: input });
    expect(result.ok && result.value.allowlist).not.toBe(input.allowlist);
  });

  it.each([
    ['no model', { ...MODEL, allowlist: [] }],
    ['a model name with a space', { ...MODEL, allowlist: ['a model'] }],
    ['a model name with a quote', { ...MODEL, allowlist: ['a"b'] }],
    ['a model name with an angle bracket', { ...MODEL, allowlist: ['<MODEL>'] }],
    ['an empty model name', { ...MODEL, allowlist: [''] }],
    ['a model name that is not a text', { ...MODEL, allowlist: [3] }],
    ['a model twice', { ...MODEL, allowlist: ['m', 'm'] }],
    ['a list that is a text', { ...MODEL, allowlist: 'm' }],
    ['a text as the ceiling', { ...MODEL, max_price_lovelace: '200000' }],
    ['no ceiling: a null', { ...MODEL, max_price_lovelace: null }],
    ['no ceiling: an undefined', { ...MODEL, max_price_lovelace: undefined }],
    ['a ceiling of zero', { ...MODEL, max_price_lovelace: 0 }],
    ['a negative ceiling', { ...MODEL, max_price_lovelace: -1 }],
    ['a fraction as the ceiling', { ...MODEL, max_price_lovelace: 1.5 }],
    ['a ceiling that is not a number', { ...MODEL, max_price_lovelace: Number.NaN }],
    ['an infinite ceiling', { ...MODEL, max_price_lovelace: Number.POSITIVE_INFINITY }],
    ['a ceiling that is not a safe integer', { ...MODEL, max_price_lovelace: 2 ** 53 }],
    ['a ceiling that is a bigint', { ...MODEL, max_price_lovelace: 5n }],
    ['a member that the type has not', { ...MODEL, note: 'x' }],
    ['no allowlist', { max_price_lovelace: 1 }],
    ['no ceiling member', { allowlist: ['m'] }],
  ])('refuses %s', (_name, input) => {
    expect(parseModel(input)).toMatchObject({ ok: false, code: 'bad_shape' });
  });

  it('takes the sample, a ceiling of 1, and the largest safe ceiling: the twins', () => {
    expect(parseModel(MODEL)).toMatchObject({ ok: true });
    expect(parseModel({ ...MODEL, max_price_lovelace: Number.MAX_SAFE_INTEGER })).toMatchObject({ ok: true });
  });

  it('never repeats the value that failed', () => {
    expect(JSON.stringify(refusal(parseModel({ ...MODEL, allowlist: [BAD_MARKER] })))).not.toContain(BAD_MARKER);
  });
});

describe('parseRelyingOn', () => {
  it('takes the routes of the mock systems and of the gateway, in the order given', () => {
    expect(parseRelyingOn(RELYING_ON)).toStrictEqual({ ok: true, value: { mock_systems: [...RELYING_ON.mock_systems], gateway_routes: [...RELYING_ON.gateway_routes] } });
  });

  it('takes empty lists', () => {
    expect(parseRelyingOn({ mock_systems: [], gateway_routes: [] })).toStrictEqual({ ok: true, value: { mock_systems: [], gateway_routes: [] } });
  });

  it.each([
    ['a route with no method', ['/po']],
    ['a method in lower case', ['post /po']],
    ['a method that does not exist', ['FETCH /po']],
    ['a route with no slash', ['POST po']],
    ['a route with a space in the path', ['POST /a b']],
    ['a route with a line break', ['POST /a\nb']],
    ['a route that is too long', [`POST /${'a'.repeat(200)}`]],
    ['a route twice', ['POST /po', 'POST /po']],
    ['a route that is not a text', [7]],
  ])('refuses %s', (_name, routes) => {
    expect(parseRelyingOn({ mock_systems: routes, gateway_routes: [] })).toMatchObject({ ok: false, code: 'bad_shape' });
    expect(parseRelyingOn({ mock_systems: [], gateway_routes: routes })).toMatchObject({ ok: false, code: 'bad_shape' });
  });

  it('refuses a list that is missing, a member that is not allowed, and a value that is not an object', () => {
    expect(parseRelyingOn({ mock_systems: [] })).toMatchObject({ ok: false });
    expect(parseRelyingOn({ mock_systems: [], gateway_routes: [], extra: [] })).toMatchObject({ ok: false });
    expect(parseRelyingOn([])).toMatchObject({ ok: false });
    expect(parseRelyingOn({ mock_systems: 'GET /a', gateway_routes: [] })).toMatchObject({ ok: false });
  });

  it('takes a route of the longest length: the twin', () => {
    expect(parseRelyingOn({ mock_systems: [`GET /${'a'.repeat(195)}`], gateway_routes: [] })).toMatchObject({ ok: true });
  });
});

describe('parseFileRef', () => {
  it('takes an https address and a hash, and returns a new object', () => {
    const result = parseFileRef(LOTS, 'behaviour.lots');
    expect(result).toStrictEqual({ ok: true, value: { uri: LOTS.uri, sha256: LOTS.sha256 } });
    expect(result.ok && result.value).not.toBe(LOTS);
  });

  it.each([
    ['an http address', 'http://example.invalid/lots.json'],
    ['a file address', 'file:///etc/passwd'],
    ['an address with a user and a password', 'https://user:secret@example.invalid/lots.json'],
    ['an address with a user', 'https://user@example.invalid/lots.json'],
    ['an address with no host', 'https:///lots.json'],
    ['a text that is not an address', 'lots.json'],
    ['an address with a space', 'https://example.invalid/my lots.json'],
    ['an address with a letter that is not ASCII', 'https://example.invalid/lots-é.json'],
    ['an address with a line break', 'https://example.invalid/lots.json\n'],
    ['an empty address', ''],
    ['an address that is too long', `https://example.invalid/${'a'.repeat(MAX_URI_CHARS)}`],
    ['a placeholder, outside a template', '<LOTS_URI>'],
  ])('refuses %s', (_name, uri) => {
    expect(parseFileRef({ ...LOTS, uri }, 'behaviour.lots')).toMatchObject({ ok: false, code: 'bad_shape' });
  });

  it.each([
    ['a hash in upper case', 'AB'.repeat(32)],
    ['a hash that is too short', 'ab'.repeat(31)],
    ['a hash with a letter that is not hex', `${'ab'.repeat(31)}zz`],
    ['an empty hash', ''],
    ['a hash that is not a text', 5],
    ['a placeholder, outside a template', '<LOTS_SHA256>'],
  ])('refuses %s', (_name, sha256) => {
    expect(parseFileRef({ ...LOTS, sha256 }, 'behaviour.lots')).toMatchObject({ ok: false, code: 'bad_shape' });
  });

  it('refuses a member that is missing, and a member that is not allowed', () => {
    expect(parseFileRef({ uri: LOTS.uri }, 'behaviour.lots')).toMatchObject({ ok: false });
    expect(parseFileRef({ sha256: LOTS.sha256 }, 'behaviour.lots')).toMatchObject({ ok: false });
    expect(parseFileRef({ ...LOTS, size: 1 }, 'behaviour.lots')).toMatchObject({ ok: false });
    expect(parseFileRef(null, 'behaviour.lots')).toMatchObject({ ok: false });
  });

  it('takes a placeholder in a template, for the address and for the hash, and refuses another bad value in a template too', () => {
    const template = { template: true };
    expect(parseFileRef({ uri: '<LOTS_URI>', sha256: '<LOTS_SHA256>' }, 'behaviour.lots', template)).toStrictEqual({ ok: true, value: { uri: '<LOTS_URI>', sha256: '<LOTS_SHA256>' } });
    expect(parseFileRef({ uri: '<LOTS_URI>', sha256: LOTS.sha256 }, 'behaviour.lots', template)).toMatchObject({ ok: true });
    expect(parseFileRef({ uri: LOTS.uri, sha256: '<LOTS_SHA256>' }, 'behaviour.lots', template)).toMatchObject({ ok: true });
    expect(parseFileRef({ uri: 'lots', sha256: '<LOTS_SHA256>' }, 'behaviour.lots', template)).toMatchObject({ ok: false });
    expect(parseFileRef({ uri: '<lots>', sha256: LOTS.sha256 }, 'behaviour.lots', template)).toMatchObject({ ok: false });
    expect(parseFileRef({ uri: LOTS.uri, sha256: 'not a hash' }, 'behaviour.lots', template)).toMatchObject({ ok: false });
    expect(parseFileRef({ uri: 'http://example.invalid/x', sha256: LOTS.sha256 }, 'behaviour.lots', template)).toMatchObject({ ok: false });
  });

  it('never repeats the address that failed: it can hold a secret', () => {
    const result = parseFileRef({ ...LOTS, uri: 'https://user:hunter2@example.invalid/x' }, 'behaviour.lots');
    expect(result).toMatchObject({ ok: false });
    expect(JSON.stringify(result)).not.toContain('hunter2');
  });
});
