// packages/usecase-kit/test/protocol/identifiers.test.ts: the forms of the identifiers. Each parse function has samples that it takes and samples that it refuses, and a refusal names the
// field and never repeats the value.
import { describe, expect, it } from 'vitest';
import { newSalt, parseAttestationId, parseDelegationId, parseDid, parseDigest, parseOutputRef, parseSalt, parseTenantId } from '@vsa/usecase-kit/protocol';
import { BAD_MARKER, DID_A, ID_A, REF, TXID } from './support.ts';

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
