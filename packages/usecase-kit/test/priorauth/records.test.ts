// packages/usecase-kit/test/priorauth/records.test.ts: the three documents of the mock systems that both agents of use case 2 read: the record set of an order, the guideline, and the requirement set of the
// insurer. The golden files are the bodies that the mock service gives for the order ORD-1001 and for the service code SYN-MRI-LS, copied by hand from its default data. They are synthetic: no patient exists.
// The parsers take what the service sends, and no more: each limit below is a limit of the service. Each refusal has an accepted twin.
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { canonicalSha256 } from '@vsa/usecase-kit/protocol';
import type { ProtocolResult } from '@vsa/usecase-kit/protocol';
import { parseGuideline, parsePriorAuthRequest, parseRecordSet, parseRequirementSet, recordSetSha256 } from '@vsa/usecase-kit/priorauth';
import type { RecordSet } from '@vsa/usecase-kit/priorauth';
import { DAY_BAD, DAY_GOOD, ID_BAD, ID_GOOD, MARKER, NOT_TEXT, change, expectRefused, golden, goldenText, must, objectAt, valueAt, withGetter, withPrototype, withProtoKey } from './support.ts';
import type { Json, Step } from './support.ts';

type Parser = (value: unknown) => ProtocolResult<unknown>;

interface Golden {
  /** The name that the refusals of the parser give to the document. */
  readonly name: string;
  readonly file: string;
  readonly parse: Parser;
  /** The SHA-256 of the bytes of the golden file. A change of the file shows here. */
  readonly fileSha256: string;
  /** The SHA-256 of the canonical text of the golden value, computed without this folder. */
  readonly canonical: string;
}

const GOLDENS: readonly Golden[] = [
  {
    name: 'record set', file: 'record-set', parse: parseRecordSet, fileSha256: 'fbf706cdbe8f780fae51f8d6e875f9352b82b18cb50e0e4a09884aaccb9b7461',
    canonical: '14aa6337663c538a6a4243d840d56be7ae8210c6980a5a7c0ab6749db48805f9',
  },
  {
    name: 'guideline', file: 'guideline', parse: parseGuideline, fileSha256: '3b008b3c7f4de65ee582e64602bff7dd05dec6b096f33237aa6f51ee066027a8',
    canonical: '45410f20737d2e288a9323ea1b94baec2df9d6044f44979b89574ac0c41349fb',
  },
  {
    name: 'requirement set', file: 'requirements', parse: parseRequirementSet, fileSha256: '9678d944ff102ecf840fa5eed1b73fc73ef6fde3cece49a06e5418d7dd13fb7c',
    canonical: '73a73fc1d2e2d1952a6751d4c120f69848d7eb29095ec763ed73cfa048b8e5f5',
  },
];

/** The hash of the golden record set: the member `record_set_sha256` of the golden request. */
const RECORD_SET_SHA256 = '14aa6337663c538a6a4243d840d56be7ae8210c6980a5a7c0ab6749db48805f9';
const DIGEST = /^[0-9a-f]{64}$/;

/** The result of a parser that must have passed, as the object that it is. */
const copyOf = (result: ProtocolResult<unknown>): Json => must(result) as Json;

/** A deep copy of a JSON value with the members of each object in the reverse order. A list keeps its order. */
function reversedMembers(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reversedMembers);
  if (typeof value === 'object' && value !== null) return Object.fromEntries(Object.entries(value).reverse().map(([key, member]) => [key, reversedMembers(member)]));
  return value;
}

/** The canonical text of a JSON value, written here again: the keys in order, each text in the NFC form, no white space. The hash of a record set is the SHA-256 of this text. */
function canonicalText(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalText).join(',')}]`;
  if (typeof value === 'object' && value !== null) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalText((value as Json)[key])}`).join(',')}}`;
  return JSON.stringify(typeof value === 'string' ? value.normalize('NFC') : value);
}

describe.each(GOLDENS)('the golden $name', ({ name, file, parse, fileSha256, canonical }) => {
  it('is the file that the hash names', () => {
    expect(createHash('sha256').update(goldenText(file)).digest('hex')).toBe(fileSha256);
  });

  it('passes the parser, and the copy holds the same members in the same order as the file, at each level', () => {
    expect(parse(golden(file))).toStrictEqual({ ok: true, value: golden(file) });
    expect(JSON.stringify(must(parse(golden(file))))).toBe(JSON.stringify(golden(file)));
  });

  it('gives the members of the copy in a fixed order, whatever the order of the members of the input', () => {
    expect(JSON.stringify(must(parse(reversedMembers(golden(file)))))).toBe(JSON.stringify(golden(file)));
  });

  it('has the canonical hash', () => {
    expect(canonicalSha256(must(parse(golden(file))))).toStrictEqual({ ok: true, value: canonical });
    expect(createHash('sha256').update(canonicalText(golden(file)), 'utf8').digest('hex')).toBe(canonical);
  });

  it('gives a copy that shares no object with the input, changes nothing of the input, and holds plain objects and lists', () => {
    const input = golden(file);
    const before = JSON.stringify(input);
    const copy = copyOf(parse(input));
    expect(JSON.stringify(input)).toBe(before);
    expect(copy).not.toBe(input);
    expect(Object.getPrototypeOf(copy)).toBe(Object.prototype);
    for (const [key, member] of Object.entries(copy)) {
      if (typeof member !== 'object' || member === null) continue;
      expect(member, key).not.toBe(input[key]);
      expect(Object.getPrototypeOf(member), key).toBe(Array.isArray(member) ? Array.prototype : Object.prototype);
    }
  });

  it('takes its own copy again, and gives the same value', () => {
    const first = must(parse(golden(file)));
    expect(parse(first)).toStrictEqual({ ok: true, value: first });
  });

  it('refuses a value that is not an object, and an object of another kind, and names the document', () => {
    class Other { code = 'SYN-MRI-LS'; }
    for (const value of [undefined, null, 1, 'text', true, [], [golden(file)], new Other(), new Date(0), new Map(), () => golden(file)]) expectRefused(parse(value), name);
  });
});

describe('the golden documents of the default data', () => {
  it('are for the order ORD-1001 and the service code SYN-MRI-LS, with five records, four criteria and five requirements', () => {
    const set = must(parseRecordSet(golden('record-set')));
    const guideline = must(parseGuideline(golden('guideline')));
    const requirements = must(parseRequirementSet(golden('requirements')));
    expect(set.order.order_id).toBe('ORD-1001');
    expect(set.order.service_code).toBe('SYN-MRI-LS');
    expect(set.records.map((record) => record.record_id)).toStrictEqual(['REC-0001', 'REC-0002', 'REC-0003', 'REC-0004', 'REC-0005']);
    expect(guideline.code).toBe(set.order.service_code);
    expect(guideline.criteria.map((criterion) => criterion.id)).toStrictEqual(['C1', 'C2', 'C3', 'C4']);
    expect(requirements.service_code).toBe(set.order.service_code);
    expect(requirements.requirements.map((requirement) => requirement.id)).toStrictEqual(['R1', 'R2', 'R3', 'R4', 'R5']);
  });

  it('are the documents that the golden request is built from, and its record set hash is the hash of the golden record set', () => {
    const request = must(parsePriorAuthRequest(golden('request')));
    const set = must(parseRecordSet(golden('record-set')));
    expect(request.order_id).toBe(set.order.order_id);
    expect(request.patient_ref).toBe(set.order.patient_ref);
    expect(request.ordering_clinician_ref).toBe(set.order.ordering_clinician_ref);
    expect(request.service_code).toBe(set.order.service_code);
    expect(request.diagnosis_codes).toStrictEqual(set.order.diagnosis_codes);
    expect(request.record_refs).toStrictEqual(set.records.map((record) => record.record_id));
    expect(request.guideline_refs).toStrictEqual(must(parseGuideline(golden('guideline'))).criteria.map((criterion) => criterion.id));
    expect(request.record_set_sha256).toBe(RECORD_SET_SHA256);
    expect(recordSetSha256(set)).toBe(request.record_set_sha256);
  });
});

describe('recordSetSha256', () => {
  const goldenSet = (): RecordSet => must(parseRecordSet(golden('record-set')));

  it('is the digest that the golden request holds, and it has the form of a digest', () => {
    expect(recordSetSha256(goldenSet())).toBe(RECORD_SET_SHA256);
    expect(recordSetSha256(goldenSet())).toMatch(DIGEST);
    expect(golden('request').record_set_sha256).toBe(recordSetSha256(goldenSet()));
  });

  it('is the canonical hash of the checked copy of the set, and the hash that a text written again here gives', () => {
    expect(canonicalSha256(goldenSet())).toStrictEqual({ ok: true, value: recordSetSha256(goldenSet()) });
    expect(createHash('sha256').update(canonicalText(golden('record-set')), 'utf8').digest('hex')).toBe(recordSetSha256(goldenSet()));
  });

  it('is the same for the set and for its copy, and for a set that was not parsed before', () => {
    expect(recordSetSha256(must(parseRecordSet(golden('record-set'))))).toBe(RECORD_SET_SHA256);
    expect(recordSetSha256(golden('record-set') as unknown as RecordSet)).toBe(RECORD_SET_SHA256);
  });

  it('is the same for a set whose members are written in another order, at each level', () => {
    expect(recordSetSha256(reversedMembers(golden('record-set')) as RecordSet)).toBe(RECORD_SET_SHA256);
    expect(recordSetSha256({ records: golden('record-set').records, order: golden('record-set').order } as unknown as RecordSet)).toBe(RECORD_SET_SHA256);
  });

  it('is the same for a text in the NFD form and for its NFC form', () => {
    const nfc = change(golden('record-set'), ['records', 1, 'summary'], 'Pain for 3 weeks, seen in a caf\u00e9 of the clinic.');
    const nfd = change(golden('record-set'), ['records', 1, 'summary'], 'Pain for 3 weeks, seen in a caf\u00e9 of the clinic.'.normalize('NFD'));
    expect(recordSetSha256(nfd as unknown as RecordSet)).toBe(recordSetSha256(nfc as unknown as RecordSet));
    expect(recordSetSha256(nfc as unknown as RecordSet)).not.toBe(RECORD_SET_SHA256);
    expect(recordSetSha256(must(parseRecordSet(nfd)))).toBe(recordSetSha256(must(parseRecordSet(nfc))));
  });

  it('changes when one thing of the set changes, and no two changes give the same hash', () => {
    const records = golden('record-set').records as unknown[];
    const CHANGES: ReadonlyArray<readonly [string, readonly Step[], unknown]> = [
      ['a summary', ['records', 4, 'summary'], 'Pain in the left leg continues at 8 weeks. New numbness in the left foot. Weakness of ankle dorsiflexion, 4 of 5.'],
      ['a record type', ['records', 0, 'type'], 'note'],
      ['a record date', ['records', 0, 'recorded_at'], '2026-08-11'],
      ['a record id', ['records', 0, 'record_id'], 'REC-9999'],
      ['the order id', ['order', 'order_id'], 'ORD-9999'],
      ['the patient reference', ['order', 'patient_ref'], 'SYN-PT-9999'],
      ['the clinician reference', ['order', 'ordering_clinician_ref'], 'SYN-CL-9999'],
      ['the service code', ['order', 'service_code'], 'SYN-MRI-KN'],
      ['the service description', ['order', 'service_description'], 'Magnetic resonance imaging of the lumbar spine, with contrast'],
      ['a diagnosis code', ['order', 'diagnosis_codes', 1], 'M51.17'],
      ['the order date', ['order', 'ordered_at'], '2026-10-23'],
      ['a record that is missing', ['records'], records.slice(0, 4)],
      ['the order of two records', ['records'], [records[1], records[0], ...records.slice(2)]],
    ];
    const hashes = CHANGES.map(([, path, value]) => recordSetSha256(change(golden('record-set'), path, value) as unknown as RecordSet));
    expect(new Set([RECORD_SET_SHA256, ...hashes]).size).toBe(CHANGES.length + 1);
  });

  it('changes when one character of one summary changes', () => {
    const summary = String(valueAt(golden('record-set'), ['records', 2, 'summary']));
    expect(recordSetSha256(change(golden('record-set'), ['records', 2, 'summary'], summary.replace('500 mg', '501 mg')) as unknown as RecordSet)).not.toBe(RECORD_SET_SHA256);
  });

  it('throws a TypeError for a value that is not a record set, and the message never repeats the value', () => {
    const BAD: readonly unknown[] = [undefined, null, 'set', 1, [], {}, change(golden('record-set'), ['records'], []), change(golden('record-set'), ['order', 'order_id'], MARKER)];
    for (const value of BAD) expect(() => recordSetSha256(value as RecordSet), JSON.stringify(value)).toThrow(TypeError);
    let message = '';
    try {
      recordSetSha256(change(golden('record-set'), ['order', 'order_id'], MARKER) as unknown as RecordSet);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('record set.order.order_id');
    expect(message).not.toContain('zq9');
  });
});

interface Level {
  readonly label: string;
  readonly file: string;
  readonly parse: Parser;
  readonly path: readonly Step[];
  readonly members: readonly string[];
  readonly where: string;
}

const LEVELS: readonly Level[] = [
  { label: 'the record set', file: 'record-set', parse: parseRecordSet, path: [], members: ['order', 'records'], where: 'record set' },
  {
    label: 'the order', file: 'record-set', parse: parseRecordSet, path: ['order'], where: 'record set.order',
    members: ['order_id', 'patient_ref', 'service_code', 'service_description', 'diagnosis_codes', 'ordering_clinician_ref', 'ordered_at'],
  },
  { label: 'a record', file: 'record-set', parse: parseRecordSet, path: ['records', 0], members: ['record_id', 'type', 'recorded_at', 'summary'], where: 'record set.records[0]' },
  { label: 'the guideline', file: 'guideline', parse: parseGuideline, path: [], members: ['code', 'title', 'version', 'criteria', 'documentation'], where: 'guideline' },
  { label: 'a criterion', file: 'guideline', parse: parseGuideline, path: ['criteria', 0], members: ['id', 'text'], where: 'guideline.criteria[0]' },
  { label: 'the requirement set', file: 'requirements', parse: parseRequirementSet, path: [], members: ['service_code', 'title', 'requirements'], where: 'requirement set' },
  { label: 'a requirement', file: 'requirements', parse: parseRequirementSet, path: ['requirements', 0], members: ['id', 'text'], where: 'requirement set.requirements[0]' },
];

describe.each(LEVELS)('the members of $label', ({ file, parse, path, members, where }) => {
  it('refuses a document with no member, for each member, and names the member', () => {
    for (const member of members) expectRefused(parse(change(golden(file), [...path, member], undefined)), member);
  });

  it('refuses a member that is not listed, whatever its value, and the twin without it passes', () => {
    for (const value of [1, null, 'x', {}, []]) expectRefused(parse(change(golden(file), [...path, 'extra'], value)), 'extra');
    expect(parse(change(golden(file), [...path, MARKER], 1)).ok).toBe(false);
    expect(parse(golden(file)).ok).toBe(true);
  });

  it('refuses a member that belongs to another document or names a person', () => {
    for (const name of ['schema', 'salt', 'status', 'missing', 'patient_name', 'date_of_birth', 'insurer', 'notes']) expectRefused(parse(change(golden(file), [...path, name], 'x')), name);
  });
});

interface TextMember {
  readonly label: string;
  readonly file: string;
  readonly parse: Parser;
  readonly path: readonly Step[];
  readonly max: number;
  readonly where: string;
}

/** The free texts of the three documents, with the most characters that the mock service takes for each. */
const TEXTS: readonly TextMember[] = [
  { label: 'the service description of the order', file: 'record-set', parse: parseRecordSet, path: ['order', 'service_description'], max: 200, where: 'record set.order.service_description' },
  { label: 'a diagnosis code of the order', file: 'record-set', parse: parseRecordSet, path: ['order', 'diagnosis_codes', 0], max: 16, where: 'record set.order.diagnosis_codes[0]' },
  { label: 'the type of a record', file: 'record-set', parse: parseRecordSet, path: ['records', 1, 'type'], max: 32, where: 'record set.records[1].type' },
  { label: 'the summary of a record', file: 'record-set', parse: parseRecordSet, path: ['records', 1, 'summary'], max: 2000, where: 'record set.records[1].summary' },
  { label: 'the title of the guideline', file: 'guideline', parse: parseGuideline, path: ['title'], max: 200, where: 'guideline.title' },
  { label: 'the version of the guideline', file: 'guideline', parse: parseGuideline, path: ['version'], max: 32, where: 'guideline.version' },
  { label: 'the text of a criterion', file: 'guideline', parse: parseGuideline, path: ['criteria', 2, 'text'], max: 500, where: 'guideline.criteria[2].text' },
  { label: 'a line of documentation', file: 'guideline', parse: parseGuideline, path: ['documentation', 1], max: 500, where: 'guideline.documentation[1]' },
  { label: 'the title of the requirement set', file: 'requirements', parse: parseRequirementSet, path: ['title'], max: 200, where: 'requirement set.title' },
  { label: 'the text of a requirement', file: 'requirements', parse: parseRequirementSet, path: ['requirements', 3, 'text'], max: 500, where: 'requirement set.requirements[3].text' },
];

describe.each(TEXTS)('the text of $label', ({ file, parse, path, max, where }) => {
  const withText = (text: unknown): Json => change(golden(file), path, text);

  it('takes `max` characters, and refuses the empty text and one more character', () => {
    expect(valueAt(copyOf(parse(withText('x'.repeat(max)))), path)).toBe('x'.repeat(max));
    expectRefused(parse(withText('x'.repeat(max + 1))), where);
    expectRefused(parse(withText('')), where);
  });

  it('counts the characters as the service counts them, in UTF-16 code units: a character outside the BMP counts two', () => {
    expect(parse(withText('\u{1F600}'.repeat(max / 2))).ok).toBe(true);
    expectRefused(parse(withText('\u{1F600}'.repeat(max / 2 + 1))), where);
  });

  it('refuses the control characters that the service refuses, takes the tab, the line feed and the carriage return, and never repeats the text', () => {
    for (const text of ['a\u0000b', 'a\u000bb', 'a\u000cb', 'a\u001fb', 'a\u007fb', 'zq9 marker\u0001']) expectRefused(parse(withText(text)), where);
    for (const text of ['a\tb', 'a\nb', 'a\rb']) expect(parse(withText(text)).ok, JSON.stringify(text)).toBe(true);
  });

  it('refuses a value that is not a text', () => {
    for (const value of NOT_TEXT) expectRefused(parse(withText(value)), where);
  });

  it('gives the NFC form of an NFD text, and keeps a text that is in the NFC form as it is', () => {
    const nfc = 'Caf\u00e9';
    expect(nfc.normalize('NFD')).not.toBe(nfc);
    expect(valueAt(copyOf(parse(withText(nfc.normalize('NFD')))), path)).toBe(nfc);
    expect(valueAt(copyOf(parse(withText(nfc))), path)).toBe(nfc);
  });

  it('checks the limit for the text as written and for its NFC form: a character that NFC writes as two is refused when the NFC form is too long, and the twin that fits both passes', () => {
    // U+0958 is one character, and NFC writes it as U+0915 and U+093C.
    expect(valueAt(copyOf(parse(withText('\u0958'.repeat(max / 2)))), path)).toBe('\u0915\u093c'.repeat(max / 2));
    expectRefused(parse(withText('\u0958'.repeat(max / 2 + 1))), where);
  });
});

interface IdMember {
  readonly label: string;
  readonly file: string;
  readonly parse: Parser;
  readonly path: readonly Step[];
  readonly where: string;
}

const IDS: readonly IdMember[] = [
  { label: 'the order id', file: 'record-set', parse: parseRecordSet, path: ['order', 'order_id'], where: 'record set.order.order_id' },
  { label: 'the patient reference', file: 'record-set', parse: parseRecordSet, path: ['order', 'patient_ref'], where: 'record set.order.patient_ref' },
  { label: 'the service code of the order', file: 'record-set', parse: parseRecordSet, path: ['order', 'service_code'], where: 'record set.order.service_code' },
  { label: 'the clinician reference', file: 'record-set', parse: parseRecordSet, path: ['order', 'ordering_clinician_ref'], where: 'record set.order.ordering_clinician_ref' },
  { label: 'a record id', file: 'record-set', parse: parseRecordSet, path: ['records', 2, 'record_id'], where: 'record set.records[2].record_id' },
  { label: 'the code of the guideline', file: 'guideline', parse: parseGuideline, path: ['code'], where: 'guideline.code' },
  { label: 'the id of a criterion', file: 'guideline', parse: parseGuideline, path: ['criteria', 1, 'id'], where: 'guideline.criteria[1].id' },
  { label: 'the service code of the requirement set', file: 'requirements', parse: parseRequirementSet, path: ['service_code'], where: 'requirement set.service_code' },
  { label: 'the id of a requirement', file: 'requirements', parse: parseRequirementSet, path: ['requirements', 4, 'id'], where: 'requirement set.requirements[4].id' },
];

describe.each(IDS)('the identifier of $label', ({ file, parse, path, where }) => {
  it('takes 1 to 64 letters, digits, dots, hyphens and underscores that start with a letter or a digit, and refuses each other form', () => {
    for (const value of ID_BAD) {
      const result = parse(change(golden(file), path, value));
      expect(result.ok, JSON.stringify(value)).toBe(false);
      expectRefused(result, where);
    }
    for (const value of ID_GOOD) expect(valueAt(copyOf(parse(change(golden(file), path, value))), path), String(value)).toBe(value);
  });

  it('is checked as it is written: the Kelvin sign is refused, although NFC turns it into the letter K, and the twin with the letter K passes', () => {
    for (const text of ['\u212AEL-1', 'x\u212A']) {
      const result = parse(change(golden(file), path, text));
      expectRefused(result, where);
      expect(!result.ok && result.detail).not.toContain('\u212A');
    }
    expect(parse(change(golden(file), path, 'KEL-1')).ok).toBe(true);
  });
});

interface DayMember {
  readonly parse: Parser;
  readonly path: readonly Step[];
  readonly where: string;
}

describe.each<DayMember>([
  { parse: parseRecordSet, path: ['order', 'ordered_at'], where: 'record set.order.ordered_at' },
  { parse: parseRecordSet, path: ['records', 0, 'recorded_at'], where: 'record set.records[0].recorded_at' },
])('the date $where', ({ parse, path, where }) => {
  it('takes a date that exists, with a year of 0100 or later, and refuses each other form', () => {
    for (const value of DAY_BAD) {
      const result = parse(change(golden('record-set'), path, value));
      expect(result.ok, JSON.stringify(value)).toBe(false);
      expectRefused(result, where);
    }
    for (const value of DAY_GOOD) expect(valueAt(copyOf(parse(change(golden('record-set'), path, value))), path), String(value)).toBe(value);
  });
});

interface ListMember {
  readonly label: string;
  readonly file: string;
  readonly parse: Parser;
  readonly path: readonly Step[];
  readonly min: number;
  readonly max: number;
  /** An entry that passes, with a different key for each index. */
  readonly entry: (index: number) => unknown;
  /** The member of an entry that no two entries share, or null for a list that takes an entry two times. */
  readonly unique: string | null;
  readonly where: string;
}

const LISTS: readonly ListMember[] = [
  {
    label: 'the records', file: 'record-set', parse: parseRecordSet, path: ['records'], min: 1, max: 50, unique: 'record_id', where: 'record set.records',
    entry: (index) => ({ record_id: `REC-${index}`, type: 'note', recorded_at: '2026-09-02', summary: 'A summary.' }),
  },
  { label: 'the diagnosis codes of the order', file: 'record-set', parse: parseRecordSet, path: ['order', 'diagnosis_codes'], min: 1, max: 8, unique: null, where: 'record set.order.diagnosis_codes', entry: (index) => `M${index}` },
  { label: 'the criteria', file: 'guideline', parse: parseGuideline, path: ['criteria'], min: 1, max: 20, unique: 'id', where: 'guideline.criteria', entry: (index) => ({ id: `C${index}`, text: 'A criterion.' }) },
  { label: 'the lines of documentation', file: 'guideline', parse: parseGuideline, path: ['documentation'], min: 0, max: 20, unique: null, where: 'guideline.documentation', entry: (index) => `Line ${index}.` },
  {
    label: 'the requirements', file: 'requirements', parse: parseRequirementSet, path: ['requirements'], min: 1, max: 20, unique: 'id', where: 'requirement set.requirements',
    entry: (index) => ({ id: `R${index}`, text: 'A requirement.' }),
  },
];

describe.each(LISTS)('the list of $label', ({ file, parse, path, min, max, entry, unique, where }) => {
  const withEntries = (count: number): Json => change(golden(file), path, Array.from({ length: count }, (_, index) => entry(index)));

  it('takes the least and the most entries, and refuses one more, and one fewer when the least is 1', () => {
    expect(parse(withEntries(min)).ok).toBe(true);
    expect(parse(withEntries(max)).ok).toBe(true);
    expect(parse(withEntries(min + 1)).ok).toBe(true);
    expectRefused(parse(withEntries(max + 1)), where);
    if (min > 0) expectRefused(parse(withEntries(min - 1)), where);
  });

  it.each([['an object', {}], ['a text', 'text'], ['null', null], ['a number', 1], ['true', true]])('refuses a list that is %s', (_what, value) => {
    expectRefused(parse(change(golden(file), path, value)), where);
  });

  it('refuses an entry of another kind than the entries of the list, and names its place', () => {
    const wrong = typeof entry(0) === 'string' ? [1, null, {}, []] : ['text', null, [], 1];
    for (const value of wrong) expectRefused(parse(change(golden(file), path, [value])), `${where}[0]`);
  });

  if (unique === null) {
    it('takes an entry two times, as the service takes it', () => {
      expect(parse(change(golden(file), path, [entry(1), entry(1)])).ok).toBe(true);
    });
  } else {
    it('refuses an entry whose key is the key of an earlier entry, names the second place, and never repeats the key', () => {
      const key = unique;
      const entries = Array.from({ length: 3 }, (_, index) => entry(index));
      const twice = change(golden(file), path, entries.map((value, index) => (index === 2 ? { ...(value as Json), [key]: (entries[0] as Json)[key] } : value)));
      expectRefused(parse(twice), `${where}[2].${key}`);
      expect(parse(change(golden(file), path, entries)).ok).toBe(true);
    });

    it('counts a key as it is written: two keys that differ in case are two keys', () => {
      const key = unique;
      const low = { ...(entry(1) as Json), [key]: String((entry(0) as Json)[key]).toLowerCase() };
      expect(parse(change(golden(file), path, [entry(0), low])).ok).toBe(true);
    });
  }
});

describe('the lists of the three documents together', () => {
  it('take the limits of the mock service: 50 records, 8 diagnosis codes, 20 criteria, 20 lines of documentation, and 20 requirements', () => {
    expect(LISTS.map((list) => [list.label, list.min, list.max])).toStrictEqual([
      ['the records', 1, 50], ['the diagnosis codes of the order', 1, 8], ['the criteria', 1, 20], ['the lines of documentation', 0, 20], ['the requirements', 1, 20],
    ]);
  });
});

describe('a value that is not plain JSON data', () => {
  interface Place {
    readonly file: string;
    readonly parse: Parser;
    readonly path: readonly Step[];
    readonly member: string;
    readonly where: string;
  }

  const PLACES: readonly Place[] = [
    { file: 'record-set', parse: parseRecordSet, path: [], member: 'order', where: 'record set' },
    { file: 'record-set', parse: parseRecordSet, path: ['order'], member: 'order_id', where: 'record set.order' },
    { file: 'record-set', parse: parseRecordSet, path: ['records', 1], member: 'summary', where: 'record set.records[1]' },
    { file: 'guideline', parse: parseGuideline, path: [], member: 'title', where: 'guideline' },
    { file: 'guideline', parse: parseGuideline, path: ['criteria', 0], member: 'text', where: 'guideline.criteria[0]' },
    { file: 'requirements', parse: parseRequirementSet, path: [], member: 'title', where: 'requirement set' },
    { file: 'requirements', parse: parseRequirementSet, path: ['requirements', 0], member: 'text', where: 'requirement set.requirements[0]' },
  ];

  it.each(PLACES)('refuses a member of $where that is an accessor, and never runs the getter', ({ file, parse, path, member, where }) => {
    const { input, reads } = withGetter(golden(file), path, member);
    expectRefused(parse(input), `${where}.${member}`);
    expect(reads()).toBe(0);
  });

  it.each(PLACES)('refuses the key __proto__ in $where, with a value that looks right', ({ file, parse, path }) => {
    expectRefused(parse(withProtoKey(golden(file), path)), '__proto__');
  });

  it('refuses the key __proto__ that JSON.parse makes', () => {
    for (const { file, parse } of GOLDENS) {
      const parsed = JSON.parse(`{"__proto__":{"code":"X-1"},${goldenText(file).trim().slice(1)}`) as Json;
      expect(Object.hasOwn(parsed, '__proto__')).toBe(true);
      expectRefused(parse(parsed), '__proto__');
    }
  });

  it('refuses a list entry that is an accessor, and never runs the getter', () => {
    for (const [file, parse, path, where] of [
      ['record-set', parseRecordSet, ['records'], 'record set.records[0]'], ['record-set', parseRecordSet, ['order', 'diagnosis_codes'], 'record set.order.diagnosis_codes[0]'],
      ['guideline', parseGuideline, ['documentation'], 'guideline.documentation[0]'], ['requirements', parseRequirementSet, ['requirements'], 'requirement set.requirements[0]'],
    ] as const) {
      let reads = 0;
      const input = golden(file);
      const list = valueAt(input, path) as unknown[];
      const value = list[0];
      Object.defineProperty(list, 0, { get() { reads += 1; return value; }, enumerable: true, configurable: true });
      expectRefused(parse(input), where);
      expect(reads, where).toBe(0);
    }
  });

  it('refuses a list with a hole, a list with a key that is not an index, and a list of another kind', () => {
    // A list that is not a plain list of JSON data is refused, in each of the three forms, for the list of records.
    expectRefused(parseRecordSet(change(golden('record-set'), ['records'], [objectAt(golden('record-set'), ['records', 0]), , objectAt(golden('record-set'), ['records', 1])])), 'record set.records');
    expectRefused(parseRecordSet(change(golden('record-set'), ['records'], Object.assign([objectAt(golden('record-set'), ['records', 0])], { extra: 'x' }))), 'record set.records');
    class Records extends Array<unknown> {}
    expectRefused(parseRecordSet(change(golden('record-set'), ['records'], Records.from([objectAt(golden('record-set'), ['records', 0])]))), 'record set.records');
  });

  it('refuses a key that is not a string, a key that is not enumerable, and a value that JSON cannot hold', () => {
    expectRefused(parseGuideline({ ...golden('guideline'), [Symbol('x')]: 1 }), 'guideline');
    const hidden = golden('guideline');
    Object.defineProperty(hidden, 'extra', { value: 1, enumerable: false, configurable: true });
    expectRefused(parseGuideline(hidden), 'guideline');
    expectRefused(parseGuideline({ ...golden('guideline'), title: undefined }), 'guideline.title');
    expectRefused(parseGuideline({ ...golden('guideline'), title: 10n }), 'guideline.title');
    expectRefused(parseGuideline({ ...golden('guideline'), title: () => 'A' }), 'guideline.title');
    expectRefused(parseRecordSet(change(golden('record-set'), ['records', 0, 'summary'], Number.NaN)), 'record set.records[0].summary');
  });

  it('refuses a Proxy that throws and a Proxy that was revoked, and never throws', () => {
    // A parser reads a member from its descriptor and never with a get, so a Proxy that throws in `get` has no effect, and a Proxy that throws in another trap is refused.
    const handlers: ReadonlyArray<readonly [string, ProxyHandler<Json>, boolean]> = [
      ['ownKeys', { ownKeys() { throw new Error('the Proxy refuses'); } }, false],
      ['getOwnPropertyDescriptor', { getOwnPropertyDescriptor() { throw new Error('the Proxy refuses'); } }, false],
      ['get', { get() { throw new Error('the Proxy refuses'); } }, true],
    ];
    for (const { file, parse } of GOLDENS) {
      for (const [trap, handler, passes] of handlers) {
        const proxy = new Proxy(golden(file), handler);
        expect(() => parse(proxy), `${file} ${trap}`).not.toThrow();
        expect(parse(proxy).ok, `${file} ${trap}`).toBe(passes);
      }
      const { proxy, revoke } = Proxy.revocable(golden(file), {});
      revoke();
      expect(() => parse(proxy)).not.toThrow();
      expect(parse(proxy).ok).toBe(false);
    }
  });

  it('takes an object with no prototype, and it gives a plain object', () => {
    for (const { file, parse } of GOLDENS) {
      const bare = Object.assign(Object.create(null) as Json, golden(file));
      const copy = copyOf(parse(bare));
      expect(copy).toStrictEqual(golden(file));
      expect(Object.getPrototypeOf(copy)).toBe(Object.prototype);
    }
  });
});

describe('a prototype that was changed', () => {
  it.each([
    ['record-set', parseRecordSet, ['order', 'records', 'summary', 'type']],
    ['guideline', parseGuideline, ['code', 'criteria', 'title', 'text']],
    ['requirements', parseRequirementSet, ['service_code', 'requirements', 'title', 'id']],
  ] as const)('with a setter for a member of %s on Object.prototype, the result is the result of the plain twin, and no setter runs', (file, parse, keys) => {
    const plain = parse(golden(file));
    for (const key of keys) {
      let calls = 0;
      const seen = withPrototype(Object.prototype, { [key]: { set() { calls += 1; } } }, () => parse(golden(file)));
      expect(seen, key).toStrictEqual(plain);
      expect(calls, key).toBe(0);
    }
  });

  it.each([
    ['a getter', { get: () => 'from the prototype' }],
    ['a read-only member', { value: 'from the prototype', writable: false }],
    ['a setter that throws', { set() { throw new Error('the setter ran'); } }],
  ])('with %s for summary on Object.prototype, the result is the result of the plain twin', (_what, member) => {
    const plain = parseRecordSet(golden('record-set'));
    expect(withPrototype(Object.prototype, { summary: member }, () => parseRecordSet(golden('record-set')))).toStrictEqual(plain);
  });

  it('reads no member that a prototype holds: a document with no own member is refused, although the prototype holds every member', () => {
    for (const { file, parse } of GOLDENS) {
      const inherited = Object.fromEntries(Object.entries(golden(file)).map(([name, value]) => [name, { value, writable: true, enumerable: true }]));
      expect(withPrototype(Object.prototype, inherited, () => parse({})).ok, file).toBe(false);
      const [first] = Object.keys(golden(file));
      expectRefused(withPrototype(Object.prototype, { [first!]: inherited[first!]! }, () => parse(change(golden(file), [first!], undefined))), first!);
    }
  });
});
