// packages/usecase-kit/test/protocol/identifiers.test.ts: the forms of the identifiers. Each parse function has samples that it takes and samples that it refuses, and a refusal names the
// field and never repeats the value.
import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  agentIdOf, didOfAgentId, isKeyHash, isModelName, isScriptHash, newSalt, parseAttestationId, parseDelegationId, parseDid, parseDigest, parseKeyHash, parseOutputRef, parseSalt, parseTenantId,
} from '@vsa/usecase-kit/protocol';
import { BAD_MARKER, DID_A, DID_B, ID_A, ID_B, REF, TXID } from './support.ts';

type Parse = (value: unknown, field?: string) => { ok: boolean; code?: string; detail?: string; value?: unknown };

const NOT_TEXT = [undefined, null, 0, 1, true, {}, [], ['ab'], () => 'ab', Symbol('x'), 10n];

/** What a 64-character hex identifier takes and refuses. */
const HEX_TAKES = [ID_A, '0123456789abcdef'.repeat(4), '00'.repeat(32), 'f'.repeat(64)];
const HEX_REFUSES = [
  '',
  'ab',
  ID_A.slice(1),
  `${ID_A}0`,
  ID_A.toUpperCase(),
  `${ID_A.slice(0, 63)}G`,
  `${ID_A.slice(0, 63)}A`,
  ` ${ID_A}`,
  `${ID_A} `,
  `${ID_A}\n`,
  `0x${ID_A.slice(2)}`,
  `${ID_A}#0`,
  `did:vector:${ID_A}`,
  ...NOT_TEXT,
];

/** What a hash of 28 bytes (a key hash and a script hash) takes and refuses: 56 lower-case hex characters. */
const HASH_A = 'ab'.repeat(28);
const HASH28_TAKES = [HASH_A, `${'0123456789abcdef'.repeat(3)}01234567`, '00'.repeat(28), 'f'.repeat(56)];
const HASH28_REFUSES = [
  '',
  'ab',
  HASH_A.slice(1),
  `${HASH_A}0`,
  ID_A,
  HASH_A.toUpperCase(),
  `${HASH_A.slice(0, 55)}G`,
  `${HASH_A.slice(0, 55)}A`,
  ` ${HASH_A}`,
  `${HASH_A} `,
  `${HASH_A}\n`,
  `0x${HASH_A.slice(2)}`,
  `${HASH_A}#0`,
  `did:vector:${HASH_A}`,
  ...NOT_TEXT,
];

const CASES: ReadonlyArray<{ name: string; parse: Parse; field: string; takes: readonly unknown[]; refuses: readonly unknown[] }> = [
  { name: 'parseDelegationId', parse: parseDelegationId, field: 'delegation', takes: HEX_TAKES, refuses: HEX_REFUSES },
  { name: 'parseAttestationId', parse: parseAttestationId, field: 'attestation', takes: HEX_TAKES, refuses: HEX_REFUSES },
  { name: 'parseSalt', parse: parseSalt, field: 'salt', takes: HEX_TAKES, refuses: HEX_REFUSES },
  { name: 'parseDigest', parse: parseDigest, field: 'digest', takes: HEX_TAKES, refuses: HEX_REFUSES },
  {
    name: 'parseDid',
    parse: parseDid,
    field: 'did',
    takes: [DID_A, `did:vector:${'0123456789abcdef'.repeat(4)}`, `did:vector:${'00'.repeat(32)}`],
    refuses: [
      '',
      ID_A,
      'did:vector:',
      `did:vector:${ID_A.slice(1)}`,
      `did:vector:${ID_A}0`,
      `did:vector:${ID_A.toUpperCase()}`,
      `DID:vector:${ID_A}`,
      `did:Vector:${ID_A}`,
      `did:key:${ID_A}`,
      `did:vector: ${ID_A}`,
      ` ${DID_A}`,
      `${DID_A} `,
      `${DID_A}\n`,
      `${DID_A}#${'ab'.repeat(28)}`,
      `${DID_A}/path`,
      `did:vector:${ID_A.slice(0, 63)}g`,
      ...NOT_TEXT,
    ],
  },
  {
    name: 'parseOutputRef',
    parse: parseOutputRef,
    field: 'ref',
    takes: [REF, `${TXID}#1`, `${TXID}#17`, `${TXID}#4294967295`, `${TXID}#9999999999`, `${'0123456789abcdef'.repeat(4)}#2`],
    refuses: [
      '',
      TXID,
      `${TXID}#`,
      `#0`,
      `${TXID}#00`,
      `${TXID}#01`,
      `${TXID}#-1`,
      `${TXID}#+1`,
      `${TXID}#1.5`,
      `${TXID}#1e3`,
      `${TXID}#0x1`,
      `${TXID}#11111111111`,
      `${ID_A.toUpperCase()}#0`,
      `${TXID.slice(1)}#0`,
      `${TXID}0#0`,
      `${TXID}#0 `,
      ` ${TXID}#0`,
      `${TXID}#0\n`,
      `${TXID}#0#1`,
      `${TXID}:0`,
      ...NOT_TEXT,
    ],
  },
  {
    name: 'parseTenantId',
    parse: parseTenantId,
    field: 'tenant',
    takes: ['run1', 'uc1-r1-0', 'A', '7', 'a.b_c-d', 'x'.repeat(64), 'Run-1'],
    refuses: ['', ' ', 'a b', '-lead', '.lead', '_lead', '..', 'x'.repeat(65), 'a/b', 'a\\b', 'a#b', 'a?b', 'a%2Fb', 'caf\u00e9', 'a\n', 'a\u0000b', ...NOT_TEXT],
  },
  {
    name: 'parseKeyHash',
    parse: parseKeyHash,
    field: 'key hash',
    takes: HASH28_TAKES,
    refuses: HASH28_REFUSES,
  },
];

describe.each(CASES)('$name', ({ parse, field, takes, refuses }) => {
  it.each(takes.map((sample) => [sample]))('takes %s and returns it as it is', (sample) => {
    expect(parse(sample)).toStrictEqual({ ok: true, value: sample });
  });

  it.each(refuses.map((sample) => [typeof sample === 'string' ? JSON.stringify(sample) : String(typeof sample === 'symbol' ? 'a symbol' : sample), sample] as const))(
    'refuses %s with bad_shape',
    (_label, sample) => {
      const result = parse(sample);
      expect(result.ok).toBe(false);
      expect(result.code).toBe('bad_shape');
      expect(typeof result.detail).toBe('string');
    },
  );

  it('names the field that it was given, and a default field when none is given', () => {
    const named = parse(BAD_MARKER, 'authority.thing');
    expect(named.ok).toBe(false);
    expect(named.detail).toContain('authority.thing');
    const defaulted = parse(BAD_MARKER);
    expect(defaulted.ok).toBe(false);
    expect(defaulted.detail).toContain(field);
  });

  it('never repeats the value that failed', () => {
    const result = parse(BAD_MARKER);
    expect(result.ok).toBe(false);
    expect(result.detail).not.toContain(BAD_MARKER);
  });

  it('does not throw on any input', () => {
    for (const sample of [...NOT_TEXT, Object.create(null), new Date(0), new Map(), { toString: () => ID_A }, 'x'.repeat(100_000)]) {
      expect(() => parse(sample)).not.toThrow();
      expect(parse(sample).ok).toBe(false);
    }
  });
});

describe('newSalt', () => {
  it('makes 32 bytes as 64 lower-case hex characters that parseSalt takes', () => {
    const salt = newSalt();
    expect(salt).toMatch(/^[0-9a-f]{64}$/);
    expect(parseSalt(salt)).toStrictEqual({ ok: true, value: salt });
  });

  it('makes a different salt each time', () => {
    const salts = new Set(Array.from({ length: 50 }, () => newSalt()));
    expect(salts.size).toBe(50);
  });
});

/** What is wrong with a sample of a hash of 28 bytes, and the sample. The same hash with nothing wrong is taken. */
const HASH28_WRONG: ReadonlyArray<readonly [string, unknown]> = [
  ['an empty text', ''],
  ['upper case', HASH_A.toUpperCase()],
  ['one upper-case letter', `A${HASH_A.slice(1)}`],
  ['one character too short', HASH_A.slice(1)],
  ['one character too long', `${HASH_A}0`],
  ['the 64 characters of an id', ID_A],
  ['a character that is not hex', `${HASH_A.slice(0, 55)}g`],
  ['white space before', ` ${HASH_A}`],
  ['white space after', `${HASH_A} `],
  ['a line break after', `${HASH_A}\n`],
  ['a tab inside', `${HASH_A.slice(0, 28)}\t${HASH_A.slice(29)}`],
  ['a prefix 0x of the right length', `0x${HASH_A.slice(2)}`],
  ['a prefix 0x', `0x${HASH_A}`],
  ['a DID prefix', `did:vector:${HASH_A}`],
  ['a text after the hash', `${HASH_A}#0`],
  ['a number', 56],
  ['null', null],
  ['undefined', undefined],
  ['a list that holds the hash', [HASH_A]],
  ['an object with a toString that gives the hash', { toString: () => HASH_A }],
  ['a String object', new String(HASH_A)],
];

describe.each([['isKeyHash', isKeyHash], ['isScriptHash', isScriptHash]] as const)('%s', (_name, is) => {
  it.each(HASH28_TAKES.map((sample) => [sample]))('takes %s', (sample) => {
    expect(is(sample)).toBe(true);
  });

  it.each(HASH28_WRONG)('refuses %s, and takes the same hash with nothing wrong', (_what, sample) => {
    expect(is(sample)).toBe(false);
    expect(is(HASH_A)).toBe(true);
  });

  it('gives the answer of parseKeyHash on every sample', () => {
    for (const sample of [...HASH28_TAKES, ...HASH28_WRONG.map(([, wrong]) => wrong)]) expect(is(sample), String(sample)).toBe(parseKeyHash(sample).ok);
  });

  it('does not throw on any input', () => {
    for (const sample of [...NOT_TEXT, Object.create(null), new Date(0), new Map(), 'x'.repeat(100_000)]) expect(() => is(sample)).not.toThrow();
  });

  it('is a type guard that gives a text', () => {
    const value: unknown = HASH_A;
    if (is(value)) expectTypeOf(value).toEqualTypeOf<string>();
    expect(is(value)).toBe(true);
  });
});

const MODEL_TAKES = ['deepseek/deepseek-v4-flash', 'qwen2.5:0.5b', 'a', 'A', '7', 'org/model:tag', 'Model_1.0-beta', 'x'.repeat(300)];

/** What is wrong with a sample of a model name, the sample, and the name with nothing wrong. */
const MODEL_WRONG: ReadonlyArray<readonly [string, unknown, string]> = [
  ['an empty text', '', 'a'],
  ['white space before', ' qwen2.5:0.5b', 'qwen2.5:0.5b'],
  ['white space after', 'qwen2.5:0.5b ', 'qwen2.5:0.5b'],
  ['a space inside', 'qwen 2.5', 'qwen-2.5'],
  ['a tab inside', 'qwen\t2.5', 'qwen-2.5'],
  ['a line break after', 'qwen2.5\n', 'qwen2.5'],
  ['a comma, which separates the names of a list', 'qwen,llama', 'qwen-llama'],
  ['a letter with an accent', 'caf\u00e9', 'cafe'],
  ['a character of another script', 'qwen\u4e2d', 'qwen'],
  ['an at sign', 'org@model', 'org/model'],
  ['a hash sign', 'org#model', 'org/model'],
  ['a question mark', 'model?x', 'model-x'],
  ['a percent sign', 'model%2F', 'model-2F'],
  ['a backslash', 'org\\model', 'org/model'],
  ['a null character', 'a\u0000b', 'a-b'],
  ['a number', 7, '7'],
  ['null', null, 'null'],
  ['undefined', undefined, 'undefined'],
  ['a list that holds a name', ['qwen'], 'qwen'],
  ['an object with a toString that gives a name', { toString: () => 'qwen' }, 'qwen'],
  ['a String object', new String('qwen'), 'qwen'],
];

describe('isModelName', () => {
  it.each(MODEL_TAKES.map((sample) => [sample.slice(0, 40), sample]))('takes %s', (_label, sample) => {
    expect(isModelName(sample)).toBe(true);
  });

  it.each(MODEL_WRONG)('refuses %s, and takes the name that it stands for', (_what, sample, twin) => {
    expect(isModelName(sample)).toBe(false);
    expect(isModelName(twin)).toBe(true);
  });

  it('does not throw on any input', () => {
    for (const sample of [...NOT_TEXT, Object.create(null), new Date(0), new Map(), 'x'.repeat(100_000)]) expect(() => isModelName(sample)).not.toThrow();
  });

  it('is a type guard that gives a text', () => {
    const value: unknown = 'qwen2.5:0.5b';
    if (isModelName(value)) expectTypeOf(value).toEqualTypeOf<string>();
    expect(isModelName(value)).toBe(true);
  });
});

describe('agentIdOf and didOfAgentId', () => {
  it('cut the prefix did:vector: from a DID, and add it to an id', () => {
    expect(agentIdOf(DID_A)).toBe(ID_A);
    expect(agentIdOf(DID_B)).toBe(ID_B);
    expect(didOfAgentId(ID_A)).toBe(DID_A);
    expect(didOfAgentId(ID_B)).toBe(DID_B);
  });

  it.each(HEX_TAKES)('are the inverse of each other for the id %s, and the DID is a DID that parseDid takes', (id) => {
    const did = didOfAgentId(id);
    expect(parseDid(did)).toStrictEqual({ ok: true, value: did });
    expect(agentIdOf(did)).toBe(id);
    expect(didOfAgentId(agentIdOf(did))).toBe(did);
    expect(parseDelegationId(agentIdOf(did)).ok).toBe(true);
  });

  // Neither function checks its input: a caller checks a DID with parseDid first. A text that is not an id gives a text that parseDid refuses, and the same id with nothing wrong gives a DID.
  it.each([
    ['an empty text', ''],
    ['upper case', ID_A.toUpperCase()],
    ['one character too short', ID_A.slice(1)],
    ['one character too long', `${ID_A}0`],
    ['a character that is not hex', `${ID_A.slice(0, 63)}g`],
    ['white space before', ` ${ID_A}`],
    ['white space after', `${ID_A} `],
    ['a line break after', `${ID_A}\n`],
    ['a prefix', `did:vector:${ID_A}`],
  ])('make a text that parseDid refuses from %s, and a DID from the same id with nothing wrong', (_what, id) => {
    expect(parseDid(didOfAgentId(id)).ok).toBe(false);
    expect(parseDid(didOfAgentId(ID_A)).ok).toBe(true);
  });

  it.each([
    ['a DID of another method', `did:key:${ID_A}`],
    ['a DID in upper case', DID_A.toUpperCase()],
    ['a DID that is one character short', DID_A.slice(0, -1)],
    ['a DID that is one character long', `${DID_A}0`],
  ])('give a text that is not an id from %s, and an id from the DID with nothing wrong', (_what, did) => {
    expect(parseDid(did).ok).toBe(false);
    expect(parseDelegationId(agentIdOf(did)).ok).toBe(false);
    expect(parseDelegationId(agentIdOf(DID_A)).ok).toBe(true);
  });
});

describe('the detail of parseKeyHash', () => {
  it('names the field and the form, as the access and checks folders show it, and it takes the same hash with nothing wrong', () => {
    expect(parseKeyHash(HASH_A.toUpperCase(), 'context.buyerPkh')).toStrictEqual({ ok: false, code: 'bad_shape', detail: 'context.buyerPkh must be 56 lower-case hex characters' });
    expect(parseKeyHash(ID_A)).toStrictEqual({ ok: false, code: 'bad_shape', detail: 'key hash must be 56 lower-case hex characters' });
    expect(parseKeyHash(HASH_A, 'context.buyerPkh')).toStrictEqual({ ok: true, value: HASH_A });
  });
});
