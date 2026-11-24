// packages/usecase-kit/test/priorauth/request.test.ts: the authorization request of use case 2 (prior authorization). It is the document of a proposal, so its digest is the digest of the protocol. The golden
// file is the request that the Prior Authorization Agent proposes for the order ORD-1001 of the default data of the mock service, and that the Insurer Intake Agent reads. The parser takes what the insurer portal
// of the mock service takes for the members that the portal reads, and the limits of the folder for the rest. Each refusal has an accepted twin.
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { DOCUMENT_SCHEMAS, canonicalSha256, makeProposal, parseHandoff, proposalDigest } from '@vsa/usecase-kit/protocol';
import { MAX_JUSTIFICATION_CHARS, PRIORAUTH_REQUEST_SCHEMA, parsePriorAuthRequest, requestNumberKey, requestNumberOf } from '@vsa/usecase-kit/priorauth';
import { BAD_TEXT, ID_BAD, ID_GOOD, MARKER, NOT_TEXT, change, expectRefused, golden, goldenText, must, withGetter, withPrototype, withProtoKey } from './support.ts';
import type { Json } from './support.ts';

/** The SHA-256 of the bytes of the golden file. A change of the file shows here. */
const GOLDEN_FILE_SHA256 = '9d05d9a527026f5e811e715c1e2d1e7e43f0a00d0b5f41f01027c82bca35e038';
/** The SHA-256 of the canonical text of the golden request. */
const GOLDEN_CANONICAL_SHA256 = '61649613323b28f100a4b553100f5eb0064a2e91474e669d317bab57726ba788';
/** The digest of the proposal of the golden request with the salt below: the digest that the hirer approves. */
const GOLDEN_DIGEST = '0641200ad559dd408f562a92d3f43074c952628163dfcff74bfe51fcdaca4f62';
const SALT = '44'.repeat(32);
/** The hash of the golden record set. The test of the records recomputes it. */
const RECORD_SET_SHA256 = '14aa6337663c538a6a4243d840d56be7ae8210c6980a5a7c0ab6749db48805f9';

const MEMBERS = [
  'schema', 'request_number', 'tenant', 'order_id', 'patient_ref', 'ordering_clinician_ref', 'service_code', 'diagnosis_codes', 'justification', 'guideline_refs', 'record_refs', 'record_set_sha256',
  'insurer_did', 'advert_ref',
] as const;
const HEX = 'ab'.repeat(32);
const REQUEST = 'authorization request';

/** The golden request with another value at `path`. */
const withValue = (path: readonly (string | number)[], value: unknown): Json => change(golden('request'), path, value);

/** `count` references: `R0`, `R1` and so on. */
const refs = (count: number): string[] => Array.from({ length: count }, (_, index) => `R${index}`);

describe('the golden request', () => {
  it('is the file that the hash names, and it holds the members of the request in their order', () => {
    expect(createHash('sha256').update(goldenText('request')).digest('hex')).toBe(GOLDEN_FILE_SHA256);
    expect(Object.keys(golden('request'))).toStrictEqual([...MEMBERS]);
  });

  it('passes the parser, and the copy holds the same members in the same order', () => {
    const result = parsePriorAuthRequest(golden('request'));
    expect(result).toStrictEqual({ ok: true, value: golden('request') });
    expect(Object.keys(must(result))).toStrictEqual([...MEMBERS]);
  });

  it('has the schema that the protocol names for use case 2', () => {
    expect(PRIORAUTH_REQUEST_SCHEMA).toBe('vector.usecase.priorauth-request.v1');
    expect(PRIORAUTH_REQUEST_SCHEMA).toBe(DOCUMENT_SCHEMAS['prior-authorization']);
    expect(golden('request').schema).toBe(PRIORAUTH_REQUEST_SCHEMA);
  });

  it('is the request for the order ORD-1001: the four criteria, the five records, and the hash of the golden record set', () => {
    const request = must(parsePriorAuthRequest(golden('request')));
    expect(request.order_id).toBe('ORD-1001');
    expect(request.guideline_refs).toStrictEqual(['C1', 'C2', 'C3', 'C4']);
    expect(request.record_refs).toStrictEqual(['REC-0001', 'REC-0002', 'REC-0003', 'REC-0004', 'REC-0005']);
    expect(request.record_set_sha256).toBe(RECORD_SET_SHA256);
  });

  it('has the digest of a proposal, and the canonical hash', () => {
    const request = must(parsePriorAuthRequest(golden('request')));
    expect(proposalDigest(SALT, request)).toStrictEqual({ ok: true, value: GOLDEN_DIGEST });
    expect(must(makeProposal(request, SALT)).proposal_digest).toBe(GOLDEN_DIGEST);
    expect(canonicalSha256(request)).toStrictEqual({ ok: true, value: GOLDEN_CANONICAL_SHA256 });
  });

  it('is the document that a handoff of use case 2 carries, and the parser reads the document of the handoff', () => {
    const handoff = { schema: 'vector.usecase.handoff.v1', use_case: 'prior-authorization', sender_did: `did:vector:${'ec'.repeat(32)}`, delegation: HEX, document: golden('request'), salt: SALT, approval: null };
    const document = must(parseHandoff(handoff)).document;
    expect(parsePriorAuthRequest(document, 'handoff.document')).toStrictEqual({ ok: true, value: golden('request') });
  });

  it('gives a copy that shares no object with the input, and changes nothing of the input', () => {
    const input = golden('request');
    const before = JSON.stringify(input);
    const request = must(parsePriorAuthRequest(input));
    expect(JSON.stringify(input)).toBe(before);
    expect(request).not.toBe(input);
    expect(Object.getPrototypeOf(request)).toBe(Object.prototype);
    for (const name of ['diagnosis_codes', 'guideline_refs', 'record_refs'] as const) {
      expect(request[name]).not.toBe(input[name]);
      expect(Array.isArray(request[name])).toBe(true);
    }
  });

  it('takes its own copy again, and gives the same value', () => {
    const first = must(parsePriorAuthRequest(golden('request')));
    expect(must(parsePriorAuthRequest(first))).toStrictEqual(first);
  });

  it('is used with the name that the caller gives in the detail of a refusal', () => {
    expectRefused(parsePriorAuthRequest(withValue(['order_id'], 5), 'handoff.document'), 'handoff.document.order_id');
    expectRefused(parsePriorAuthRequest(withValue(['order_id'], 5)), `${REQUEST}.order_id`);
  });
});

describe('a member that is missing or is not listed', () => {
  it.each(MEMBERS)('refuses a request with no member %s', (name) => {
    expectRefused(parsePriorAuthRequest(withValue([name], undefined)), name);
  });

  it('refuses a member that is not listed, in any place of the order of the members', () => {
    expectRefused(parsePriorAuthRequest({ extra: 1, ...golden('request') }), 'extra');
    expectRefused(parsePriorAuthRequest({ ...golden('request'), extra: 1 }), 'extra');
    expectRefused(parsePriorAuthRequest({ ...golden('request'), extra: null }), 'extra');
    expect(parsePriorAuthRequest({ ...golden('request'), [MARKER]: 1 }).ok).toBe(false);
    expect(parsePriorAuthRequest(golden('request')).ok).toBe(true);
  });

  it.each(['salt', 'proposal_digest', 'approval', 'status', 'missing', 'intake_id', 'order', 'records', 'guideline', 'vault', 'buyer_pkh', 'patient', 'patient_name', 'date_of_birth', 'clinician'])(
    'refuses the member %s, which belongs to another document or names a person',
    (name) => {
      expectRefused(parsePriorAuthRequest({ ...golden('request'), [name]: HEX }), name);
    },
  );
});

describe('a member of the wrong type or in the wrong form', () => {
  const FORMS: ReadonlyArray<readonly [string, readonly unknown[], readonly unknown[]]> = [
    ['schema', ['vector.usecase.priorauth-request.v2', 'VECTOR.USECASE.PRIORAUTH-REQUEST.V1', 'vector.usecase.priorauth-request.v1 ', 'vector.usecase.priorauth-request.v1\n', '', MARKER, 'vector.usecase.po.v1', 'vector.usecase.proposal.v1', ...NOT_TEXT], [PRIORAUTH_REQUEST_SCHEMA]],
    ['request_number', ID_BAD, ID_GOOD],
    ['tenant', ['', 'a'.repeat(49), 'Run1', 'run_1', 'run.1', '-run', 'run 1', 'run\n', 'run1/x', MARKER, ...NOT_TEXT], ['a', 'run1', '1run', 'run-1', 'a'.repeat(48), 'a-b-c']],
    ['order_id', ID_BAD, ID_GOOD],
    ['patient_ref', ID_BAD, ID_GOOD],
    ['ordering_clinician_ref', ID_BAD, ID_GOOD],
    ['service_code', ID_BAD, ID_GOOD],
    ['justification', ['', ...NOT_TEXT], ['x', 'Criterion C1 is met.']],
    ['record_set_sha256', [HEX.slice(2), `${HEX}ab`, HEX.toUpperCase(), `${HEX}\n`, ` ${HEX}`, 'g'.repeat(64), '', MARKER, ...NOT_TEXT], [HEX, '0'.repeat(64), 'f'.repeat(64)]],
    ['insurer_did', [
      `did:vector:${HEX.slice(2)}`, `did:vector:${HEX}ab`, `did:vector:${HEX.toUpperCase()}`, `DID:VECTOR:${HEX}`, `did:other:${HEX}`, HEX, `did:vector:${HEX}\n`, ` did:vector:${HEX}`, 'did:vector:', '', MARKER,
      ...NOT_TEXT,
    ], [`did:vector:${HEX}`]],
    ['advert_ref', [
      HEX, `${HEX}#`, `${HEX}#-1`, `${HEX}#01`, `${HEX}#1.5`, `${HEX}#12345678901`, `${HEX.slice(2)}#0`, `${HEX}ab#0`, `${HEX.toUpperCase()}#0`, `${HEX}#0\n`, `${HEX}0`, '#0', '', MARKER, ...NOT_TEXT,
    ], [`${HEX}#0`, `${HEX}#1`, `${HEX}#10`, `${HEX}#999999`, `${HEX}#1000000`, `${HEX}#1234567890`]],
  ];

  it.each(FORMS)('%s: refuses each value that is not in its form, and takes the values that are', (name, bad, good) => {
    for (const value of bad) {
      const result = parsePriorAuthRequest(withValue([name], value));
      expect(result.ok, `${name} ${JSON.stringify(value)}`).toBe(false);
      expectRefused(result, `${REQUEST}.${name}`);
    }
    for (const value of good) expect(parsePriorAuthRequest(withValue([name], value)).ok, `${name} ${JSON.stringify(value)}`).toBe(true);
  });

  it('takes the advert reference with the index that the form of the protocol takes, which has more digits than a purchase order takes: the portal does not read this member', () => {
    expect(parsePriorAuthRequest(withValue(['advert_ref'], `${HEX}#1234567`)).ok).toBe(true);
  });

  it('refuses the tenant of 49 characters, and takes the tenant of 48: the portal takes 48, and the protocol takes 64 for the tenant of a request', () => {
    expectRefused(parsePriorAuthRequest(withValue(['tenant'], 't'.repeat(49))), 'tenant');
    expect(parsePriorAuthRequest(withValue(['tenant'], 't'.repeat(48))).ok).toBe(true);
  });

  it('refuses a number that JSON cannot hold, in a list', () => {
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) expectRefused(parsePriorAuthRequest(withValue(['diagnosis_codes'], [value])), 'diagnosis_codes[0]');
  });

  it('refuses a value that is not an object, and an object of another kind', () => {
    class Request { schema = PRIORAUTH_REQUEST_SCHEMA; }
    for (const value of [undefined, null, 1, 'request', true, [], [golden('request')], new Request(), new Date(0), new Map(), () => golden('request')]) expectRefused(parsePriorAuthRequest(value), REQUEST);
  });
});

describe('the lists', () => {
  describe('diagnosis_codes', () => {
    it('takes 1 to 8 codes, and refuses no code and 9 codes', () => {
      expect(parsePriorAuthRequest(withValue(['diagnosis_codes'], ['M54.16'])).ok).toBe(true);
      expect(parsePriorAuthRequest(withValue(['diagnosis_codes'], refs(8))).ok).toBe(true);
      expectRefused(parsePriorAuthRequest(withValue(['diagnosis_codes'], [])), `${REQUEST}.diagnosis_codes`);
      expectRefused(parsePriorAuthRequest(withValue(['diagnosis_codes'], refs(9))), `${REQUEST}.diagnosis_codes`);
    });

    it('takes a code of 16 characters, and refuses a code of 17 characters and an empty code', () => {
      expect(parsePriorAuthRequest(withValue(['diagnosis_codes'], ['c'.repeat(16)])).ok).toBe(true);
      expectRefused(parsePriorAuthRequest(withValue(['diagnosis_codes'], ['M54.16', 'c'.repeat(17)])), `${REQUEST}.diagnosis_codes[1]`);
      expectRefused(parsePriorAuthRequest(withValue(['diagnosis_codes'], [''])), `${REQUEST}.diagnosis_codes[0]`);
    });

    it('takes a code two times, as the records system takes it in an order', () => {
      expect(parsePriorAuthRequest(withValue(['diagnosis_codes'], ['M54.16', 'M54.16'])).ok).toBe(true);
    });

    it('refuses a code that is not a text, and a code with a control character that the records system refuses, and never repeats the code', () => {
      for (const value of [1, null, true, {}, ['M54.16']]) expectRefused(parsePriorAuthRequest(withValue(['diagnosis_codes'], [value])), `${REQUEST}.diagnosis_codes[0]`);
      expectRefused(parsePriorAuthRequest(withValue(['diagnosis_codes'], ['M54\u0000'])), `${REQUEST}.diagnosis_codes[0]`);
      expectRefused(parsePriorAuthRequest(withValue(['diagnosis_codes'], ['zq9 marker\u0001'])), `${REQUEST}.diagnosis_codes[0]`);
    });

    it('gives the NFC form of a code', () => {
      expect(must(parsePriorAuthRequest(withValue(['diagnosis_codes'], ['e\u0301']))).diagnosis_codes).toStrictEqual(['\u00e9']);
    });

    it.each([['an object', {}], ['a text', 'M54.16'], ['null', null], ['a number', 1]])('refuses diagnosis codes that are %s', (_what, value) => {
      expectRefused(parsePriorAuthRequest(withValue(['diagnosis_codes'], value)), `${REQUEST}.diagnosis_codes`);
    });
  });

  describe.each([['guideline_refs', 20], ['record_refs', 50]] as const)('%s', (name, most) => {
    it(`takes none, one and ${most} references, and refuses ${most + 1}`, () => {
      expect(parsePriorAuthRequest(withValue([name], [])).ok).toBe(true);
      expect(parsePriorAuthRequest(withValue([name], refs(1))).ok).toBe(true);
      expect(parsePriorAuthRequest(withValue([name], refs(most))).ok).toBe(true);
      expectRefused(parsePriorAuthRequest(withValue([name], refs(most + 1))), `${REQUEST}.${name}`);
    });

    it('refuses a reference twice, names the second place, and never repeats the reference', () => {
      const twice = ['C1', 'C2', 'C1'];
      expectRefused(parsePriorAuthRequest(withValue([name], twice)), `${REQUEST}.${name}[2]`);
      expect(parsePriorAuthRequest(withValue([name], ['C1', 'C2', 'C3'])).ok).toBe(true);
      const result = parsePriorAuthRequest(withValue([name], ['zq9-marker', 'zq9-marker']));
      expectRefused(result, `${REQUEST}.${name}[1]`);
    });

    it('counts a reference as it is written: two references that differ in case are two references', () => {
      expect(parsePriorAuthRequest(withValue([name], ['C1', 'c1'])).ok).toBe(true);
    });

    it('takes a reference of 64 characters and refuses a reference of 65 characters, and a text that is not an identifier', () => {
      expect(parsePriorAuthRequest(withValue([name], ['a'.repeat(64)])).ok).toBe(true);
      expectRefused(parsePriorAuthRequest(withValue([name], ['C1', 'a'.repeat(65)])), `${REQUEST}.${name}[1]`);
      for (const value of ['', 'C 1', 'C/1', 'C#1', '-C1', 'C1\n', 'C\u00e9', MARKER, 1, null, {}, []]) expectRefused(parsePriorAuthRequest(withValue([name], [value])), `${REQUEST}.${name}[0]`);
    });

    it.each([['an object', {}], ['a text', 'C1'], ['null', null], ['a number', 1]])('refuses references that are %s', (_what, value) => {
      expectRefused(parsePriorAuthRequest(withValue([name], value)), `${REQUEST}.${name}`);
    });
  });

  it('refuses a list with a hole, a list with a key that is not an index, and a list of another kind', () => {
    expectRefused(parsePriorAuthRequest(withValue(['record_refs'], ['R1', , 'R3'])), `${REQUEST}.record_refs`);
    const keyed = Object.assign(['R1', 'R2'], { extra: 'x' });
    expectRefused(parsePriorAuthRequest(withValue(['record_refs'], keyed)), `${REQUEST}.record_refs`);
    class Refs extends Array<string> {}
    expectRefused(parsePriorAuthRequest({ ...golden('request'), record_refs: Refs.from(['R1']) }), `${REQUEST}.record_refs`);
  });

  it('refuses a list entry that is an accessor, and never runs the getter', () => {
    for (const name of ['diagnosis_codes', 'guideline_refs', 'record_refs']) {
      let reads = 0;
      const input = golden('request');
      const list = input[name] as unknown[];
      const value = list[0];
      Object.defineProperty(list, 0, { get() { reads += 1; return value; }, enumerable: true, configurable: true });
      expectRefused(parsePriorAuthRequest(input), `${REQUEST}.${name}[0]`);
      expect(reads, name).toBe(0);
    }
  });
});

describe('the justification', () => {
  const justification = (text: string) => parsePriorAuthRequest(withValue(['justification'], text));
  const WHERE = `${REQUEST}.justification`;

  it('has the limit of 4,000 characters', () => {
    expect(MAX_JUSTIFICATION_CHARS).toBe(4000);
  });

  it('takes 1 character and 4,000 characters, and refuses the empty text and 4,001 characters', () => {
    expect(justification('x').ok).toBe(true);
    expect(must(justification('a'.repeat(4000))).justification).toHaveLength(4000);
    expectRefused(justification(''), WHERE);
    expectRefused(justification('a'.repeat(4001)), WHERE);
  });

  it('counts code points: 4,000 characters outside the BMP pass, with 8,000 code units, and 4,001 are refused', () => {
    expect(must(justification('\u{1F600}'.repeat(4000))).justification).toBe('\u{1F600}'.repeat(4000));
    expectRefused(justification('\u{1F600}'.repeat(4001)), WHERE);
    expect(justification(`${'\u{1F600}'.repeat(2000)}${'a'.repeat(2000)}`).ok).toBe(true);
    expectRefused(justification(`${'\u{1F600}'.repeat(2000)}${'a'.repeat(2001)}`), WHERE);
    expectRefused(justification('a'.repeat(100_000)), WHERE);
  });

  it('checks the limit for the text as written and for its NFC form: a character that NFC writes as two is refused when the NFC form is too long, and the twin that fits both passes', () => {
    // U+0958 is one code point, and NFC writes it as U+0915 and U+093C. 2,000 of them fit as written (2,000) and in the NFC form (4,000). 2,001 fit as written and not in the NFC form (4,002).
    const copy = must(justification('\u0958'.repeat(2000)));
    expect(copy.justification).toBe('\u0915\u093c'.repeat(2000));
    expectRefused(justification('\u0958'.repeat(2001)), WHERE);
    // The Insurer Intake Agent reads the NFC copy, so the parser takes its own copy again.
    expect(must(parsePriorAuthRequest(copy))).toStrictEqual(copy);
  });

  it('takes the line feed in any place', () => {
    expect(must(justification('Criterion C1 is met.\nCriterion C2 is met.')).justification).toBe('Criterion C1 is met.\nCriterion C2 is met.');
    expect(justification('\nC1\n').ok).toBe(true);
  });

  it('refuses each control character but the line feed: U+0000 to U+001F, U+007F and U+0080 to U+009F', () => {
    const codes = [...Array.from({ length: 32 }, (_, code) => code).filter((code) => code !== 0x0a), ...Array.from({ length: 33 }, (_, index) => 0x7f + index)];
    expect(codes).toHaveLength(31 + 33);
    for (const code of codes) {
      const text = `Criterion C1 is met.${String.fromCharCode(code)}Criterion C2 is met.`;
      const result = justification(text);
      expect(result.ok, `U+${code.toString(16).padStart(4, '0')}`).toBe(false);
      expectRefused(result, WHERE);
    }
    expect(justification('Criterion C1 is met.\nCriterion C2 is met.').ok).toBe(true);
    const nul = justification('a\u0000b');
    expect(!nul.ok && nul.detail).toContain('control character');
  });

  it('refuses a carriage return, so that a line break is the line feed alone', () => {
    expectRefused(justification('Criterion C1 is met.\r\nCriterion C2 is met.'), WHERE);
    expectRefused(justification('Criterion C1 is met.\rCriterion C2 is met.'), WHERE);
    expectRefused(justification('Criterion C1 is met.\tCriterion C2 is met.'), WHERE);
  });

  it('takes letters of other scripts, symbols and emoji, and the characters that are not controls', () => {
    expect(justification('Kriterium C1 ist erf\u00fcllt: \u8179\u75db \u2022 \u{1F600} \u00a0 ok').ok).toBe(true);
  });

  it('gives the NFC copy of an NFD text, and the same digest as the NFC document', () => {
    const nfcText = 'Criterion C1 is met. The caf\u00e9 visit of 2026-09-02 records low back pain.\nCriterion C2 is met.';
    const nfdText = nfcText.normalize('NFD');
    expect(nfdText).not.toBe(nfcText);
    const nfc = withValue(['justification'], nfcText);
    const nfd = withValue(['justification'], nfdText);
    const copy = must(parsePriorAuthRequest(nfd));
    expect(copy.justification).toBe(nfcText);
    expect(copy.justification).not.toBe(nfdText);
    expect(copy).toStrictEqual(must(parsePriorAuthRequest(nfc)));
    expect(proposalDigest(SALT, nfd)).toStrictEqual(proposalDigest(SALT, nfc));
    expect(proposalDigest(SALT, copy)).toStrictEqual(proposalDigest(SALT, nfc));
    expect(canonicalSha256(copy)).toStrictEqual(canonicalSha256(nfd));
  });

  it('keeps a text that is in the NFC form as it is', () => {
    const text = 'Criterion C1 is met. \u00c5ngstr\u00f6m caf\u00e9.';
    expect(text).toBe(text.normalize('NFC'));
    expect(must(justification(text)).justification).toBe(text);
  });

  it('refuses a value that is not a text, and never repeats the text that it refuses', () => {
    for (const value of [1, 0, true, null, {}, [], ['a']]) expectRefused(justification(value as string), WHERE);
    expectRefused(justification(BAD_TEXT), WHERE);
    expectRefused(justification(`zq9 marker ${'y'.repeat(4001)}`), WHERE);
  });
});

describe('the Unicode form of a text', () => {
  it('checks each identifier as it is written: the Kelvin sign is refused, although NFC turns it into the letter K, and the twin with the letter K passes', () => {
    // The Kelvin sign (U+212A) is not an ASCII letter. NFC replaces it by the letter K, and the portal checks the text as it is written, so the Kelvin sign is refused here too.
    for (const name of ['request_number', 'order_id', 'patient_ref', 'ordering_clinician_ref', 'service_code']) {
      for (const text of ['\u212ALV-1', 'run\u212A-1', 'x\u212A']) {
        const result = parsePriorAuthRequest(withValue([name], text));
        expectRefused(result, `${REQUEST}.${name}`);
        expect(!result.ok && result.detail).not.toContain('\u212A');
      }
      expect(parsePriorAuthRequest(withValue([name], 'KLV-1')).ok, name).toBe(true);
    }
    for (const name of ['guideline_refs', 'record_refs']) expectRefused(parsePriorAuthRequest(withValue([name], ['\u212A1'])), `${REQUEST}.${name}[0]`);
  });

  it('refuses a letter with a mark in any form, because an identifier has letters, digits and three signs, and the refusal does not repeat the text', () => {
    for (const text of ['e\u0301-1', '\u00e9-1', 'a\u030a', '\u00e5']) {
      const result = parsePriorAuthRequest(withValue(['order_id'], text));
      expectRefused(result, `${REQUEST}.order_id`);
      expect(!result.ok && result.detail).not.toContain('\u0301');
    }
  });

  it('holds only ASCII texts in the members that are not free texts, so that no text of an accepted request changes in the NFC form', () => {
    const request = must(parsePriorAuthRequest(golden('request')));
    for (const [name, value] of Object.entries(request)) {
      if (name === 'justification' || name === 'diagnosis_codes') continue;
      for (const text of Array.isArray(value) ? value : [value]) {
        expect(text, name).toMatch(/^[\x20-\x7e]+$/);
        expect(text, name).toBe((text as string).normalize('NFC'));
      }
    }
  });
});

describe('a value that is not plain JSON data', () => {
  it('refuses a member that is an accessor, and never runs the getter, for each member', () => {
    for (const name of MEMBERS) {
      const { input, reads } = withGetter(golden('request'), [], name);
      expectRefused(parsePriorAuthRequest(input), name);
      expect(reads(), name).toBe(0);
    }
  });

  it('refuses a getter that gives a good value the first time and a bad value the second time, and never reads it', () => {
    let reads = 0;
    const input = golden('request');
    Object.defineProperty(input, 'tenant', { get() { reads += 1; return reads === 1 ? 'run1' : 'a'.repeat(49); }, enumerable: true, configurable: true });
    expectRefused(parsePriorAuthRequest(input), 'tenant');
    expect(reads).toBe(0);
  });

  it('refuses the key __proto__ with a value that looks right, and the key that JSON.parse makes', () => {
    expectRefused(parsePriorAuthRequest(withProtoKey(golden('request'), [])), '__proto__');
    const parsed = JSON.parse(`{"__proto__":{"order_id":"X-1"},${goldenText('request').trim().slice(1)}`) as Json;
    expect(Object.hasOwn(parsed, '__proto__')).toBe(true);
    expectRefused(parsePriorAuthRequest(parsed), '__proto__');
  });

  it('refuses a key that is not a string, a key that is not enumerable, and a value that JSON cannot hold', () => {
    expectRefused(parsePriorAuthRequest({ ...golden('request'), [Symbol('x')]: 1 }), REQUEST);
    const hidden = golden('request');
    Object.defineProperty(hidden, 'extra', { value: 1, enumerable: false, configurable: true });
    expectRefused(parsePriorAuthRequest(hidden), REQUEST);
    expectRefused(parsePriorAuthRequest({ ...golden('request'), justification: undefined }), 'justification');
    expectRefused(parsePriorAuthRequest({ ...golden('request'), justification: 10n }), 'justification');
    expectRefused(parsePriorAuthRequest({ ...golden('request'), order_id: () => 'A' }), 'order_id');
  });

  it('refuses a Proxy that throws and a Proxy that was revoked, and never throws', () => {
    // A parser reads a member from its descriptor and never with a get, so a Proxy that throws in `get` has no effect, and a Proxy that throws in another trap is refused.
    const handlers: ReadonlyArray<readonly [string, ProxyHandler<Json>, boolean]> = [
      ['ownKeys', { ownKeys() { throw new Error('the Proxy refuses'); } }, false],
      ['getOwnPropertyDescriptor', { getOwnPropertyDescriptor() { throw new Error('the Proxy refuses'); } }, false],
      ['get', { get() { throw new Error('the Proxy refuses'); } }, true],
    ];
    for (const [trap, handler, passes] of handlers) {
      const proxy = new Proxy(golden('request'), handler);
      expect(() => parsePriorAuthRequest(proxy), trap).not.toThrow();
      expect(parsePriorAuthRequest(proxy).ok, trap).toBe(passes);
    }
    const { proxy, revoke } = Proxy.revocable(golden('request'), {});
    revoke();
    expect(() => parsePriorAuthRequest(proxy)).not.toThrow();
    expectRefused(parsePriorAuthRequest(proxy), REQUEST);
  });

  it('takes an object with no prototype, and it gives a plain object', () => {
    const bare = Object.assign(Object.create(null) as Json, golden('request'));
    const request = must(parsePriorAuthRequest(bare));
    expect(request).toStrictEqual(golden('request'));
    expect(Object.getPrototypeOf(request)).toBe(Object.prototype);
  });
});

describe('a prototype that was changed', () => {
  const PLAIN = parsePriorAuthRequest(golden('request'));

  it.each(['tenant', 'justification', 'record_refs', 'schema', 'order_id'])('with a setter for %s on Object.prototype, the result is the result of the plain twin, and no setter runs', (key) => {
    let calls = 0;
    const input = golden('request');
    const seen = withPrototype(Object.prototype, { [key]: { set() { calls += 1; } } }, () => parsePriorAuthRequest(input));
    expect(seen).toStrictEqual(PLAIN);
    expect(calls).toBe(0);
  });

  it.each([
    ['a getter', { get: () => 'from the prototype' }],
    ['a read-only member', { value: 'from the prototype', writable: false }],
    ['a setter that throws', { set() { throw new Error('the setter ran'); } }],
  ])('with %s for justification on Object.prototype, the result is the result of the plain twin', (_what, member) => {
    const input = golden('request');
    expect(withPrototype(Object.prototype, { justification: member }, () => parsePriorAuthRequest(input))).toStrictEqual(PLAIN);
  });

  it('reads no member that a prototype holds: a request with no own member is refused, although the prototype holds every member', () => {
    const inherited = Object.fromEntries(Object.entries(golden('request')).map(([name, value]) => [name, { value, writable: true, enumerable: true }]));
    expect(withPrototype(Object.prototype, inherited, () => parsePriorAuthRequest({})).ok).toBe(false);
    const holdsOne = withPrototype(Object.prototype, { order_id: inherited.order_id! }, () => parsePriorAuthRequest(withValue(['order_id'], undefined)));
    expectRefused(holdsOne, 'order_id');
  });
});

describe('requestNumberOf', () => {
  it('gives the tenant, a hyphen and the counter, with no padding', () => {
    expect(requestNumberOf('demo-1', 7)).toBe('demo-1-7');
    expect(requestNumberOf('run1', 12)).toBe('run1-12');
    expect(requestNumberOf('acme-test', 1000)).toBe('acme-test-1000');
  });

  it('gives a number for the counter 0, because the services use it to check a tenant', () => {
    expect(requestNumberOf('demo-1', 0)).toBe('demo-1-0');
    expect(requestNumberOf('a', 0)).toBe('a-0');
  });

  it('gives the number of the golden request', () => {
    expect(requestNumberOf(String(golden('request').tenant), 1)).toBe(golden('request').request_number);
  });

  it('gives a number that the parser takes, for the longest tenant and the largest counter that fit', () => {
    const tenant = 't'.repeat(48);
    for (const counter of [0, 1, 9, 10, 99_999_999, 999_999_999_999_999]) {
      const number = requestNumberOf(tenant, counter);
      expect(number).toBe(`${tenant}-${counter}`);
      expect(number.length).toBeLessThanOrEqual(64);
      expect(parsePriorAuthRequest(withValue(['request_number'], number)).ok, number).toBe(true);
    }
  });

  it.each([
    ['a tenant in capital letters', 'Run1', 1], ['an empty tenant', '', 1], ['a tenant of 49 characters', 't'.repeat(49), 1], ['a tenant with an underscore', 'run_1', 1], ['a tenant with a dot', 'run.1', 1],
    ['a tenant that starts with a hyphen', '-run', 1], ['a tenant with a slash', 'run/1', 1], ['a tenant with a line break', 'run1\n', 1], ['a tenant with the Kelvin sign', 'run\u212A', 1],
    ['a counter below 0', 'run1', -1], ['a fraction', 'run1', 1.5], ['NaN', 'run1', Number.NaN], ['infinity', 'run1', Number.POSITIVE_INFINITY],
    ['a counter that is not a safe integer', 'run1', Number.MAX_SAFE_INTEGER + 1], ['a counter that is a text', 'run1', '1' as unknown as number], ['a counter that is a bigint', 'run1', 1n as unknown as number],
    ['a tenant that is not a text', 7 as unknown as string, 1], ['no tenant', undefined as unknown as string, 1], ['a number of more than 64 characters', 't'.repeat(48), Number.MAX_SAFE_INTEGER],
  ])('throws a TypeError for %s', (_what, tenant, counter) => {
    expect(() => requestNumberOf(tenant, counter)).toThrow(TypeError);
  });

  it('throws a message that never repeats the tenant or the counter that it refuses', () => {
    for (const [tenant, counter] of [[MARKER, 1], ['run1', Number(`1${'0'.repeat(30)}`)], ['T'.repeat(30), 1]] as const) {
      let message = '';
      try {
        requestNumberOf(tenant, counter);
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).not.toBe('');
      expect(message).not.toContain('zq9');
      expect(message).not.toContain('TTTT');
      expect(message).not.toContain('1000000');
    }
  });
});

describe('requestNumberKey', () => {
  it('is the number in lower case', () => {
    expect(requestNumberKey('Demo-1-7')).toBe('demo-1-7');
    expect(requestNumberKey('DEMO-1-7')).toBe('demo-1-7');
    expect(requestNumberKey('demo-1-7')).toBe('demo-1-7');
    expect(requestNumberKey('A.b_C-d9')).toBe('a.b_c-d9');
  });

  it('is one key for the numbers that differ only in case, as the insurer portal takes them: one entry', () => {
    const keys = new Set(['abc-1', 'ABC-1', 'Abc-1', 'aBC-1', 'abC-1'].map((number) => requestNumberKey(number)));
    expect([...keys]).toStrictEqual(['abc-1']);
  });

  it('is another key for a number that differs in more than the case', () => {
    const keys = new Set(['abc-1', 'abc-2', 'abc_1', 'abc.1', 'abd-1', 'abc-10', 'abc-1x'].map((number) => requestNumberKey(number)));
    expect(keys.size).toBe(7);
  });

  it('does not depend on the language of the host: the capital I gives the letter i', () => {
    expect(requestNumberKey('TITLE-I')).toBe('title-i');
    expect(requestNumberKey('INDEX-1')).toBe('index-1');
  });

  it('gives the number that requestNumberOf makes, because a tenant is in lower case already, and a number that the parser takes', () => {
    for (const [tenant, counter] of [['run1', 1], ['acme-test', 1000], ['a', 0], ['t'.repeat(48), 999_999_999_999_999]] as const) {
      const number = requestNumberOf(tenant, counter);
      expect(requestNumberKey(number)).toBe(number);
      expect(parsePriorAuthRequest(withValue(['request_number'], requestNumberKey(number.toUpperCase()))).ok, number).toBe(true);
    }
    expect(requestNumberKey(String(golden('request').request_number))).toBe(golden('request').request_number);
  });

  it('is idempotent', () => {
    for (const number of ['RUN1-1', 'run1-1', 'A.B_C-D']) expect(requestNumberKey(requestNumberKey(number))).toBe(requestNumberKey(number));
  });
});
