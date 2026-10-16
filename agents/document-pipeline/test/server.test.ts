// agents/document-pipeline/test/server.test.ts
// The manifest the service publishes and the HTTP surface the runtime calls, through a real server on a port the system picks. Most tests inject a fake
// `runPipeline` (the seam createServer gives, as agent-history's gives its report builder), so that what is under test is the service: the wire contract,
// the body cap, the one-job-at-a-time rule, the error mapping, the health check, the bytes of the answer. Three tests run the real pipeline against the
// in-memory marketplace of test/stub-suppliers.ts, so that the whole path from the HTTP body to the HTTP body is exercised once.
import { describe, test, expect, vi, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import Ajv from 'ajv';
import { FakeChain } from '@vsa/buyer-core';
import { REGISTRY_ADDRESS } from '@vsa/vector-read';
import { JOB_DEADLINE_MS } from '../src/budget.ts';
import { answerResult, compileExtractionSchema, COMBINATION_MAX_ENTRIES, SCHEMA_MAX_BYTES, SCHEMA_MAX_DEPTH } from '../src/extract.ts';
import { GAPS } from '../src/gaps.ts';
import { PipelineError, runPipeline } from '../src/orchestrate.ts';
import type { Deps, PipelineResult } from '../src/orchestrate.ts';
import { DEFAULT_LANGUAGE, MAX_INLINE_BYTES, MAX_PAGES, RequestError, parseRequest } from '../src/request.ts';
import { HEARTBEAT_MS, JobSlot, MAX_BODY, WireError, createServer, envInt, manifestFromEnv, parseWire, renderTemplate } from '../src/server.ts';
import type { ServerOptions } from '../src/server.ts';
import { MAX_SOURCE_BYTES } from '../src/source.ts';
import { fakeRenderer } from './fake-renderer.ts';
import { AUTH, BUYER, FULL_ENV, SUPPLIER, T0, TEST_AUTH, TEST_CONTACT, baseDeps, cleanDirs, rawClient, serve, settle, until, walletChain, wire } from './server-support.ts';
import { ALLOWLIST, INDEXER, SUMMARY, marketplace } from './stub-suppliers.ts';
import { TWO_PAGES_PDF, toBase64 } from './support.ts';

afterEach(() => { cleanDirs(); vi.restoreAllMocks(); });

// The ledger's native unit is named once in the repository, in docs/HIRE.md. Spelled in two parts, so that a search for the name finds only the guide.
const UNIT_NAME = new RegExp('AP' + '3X', 'i');
const MANIFEST_ENV = { ...FULL_ENV, PIPELINE_BUYER_PKH: BUYER.pkh };
const MANIFEST = manifestFromEnv(MANIFEST_ENV);
const SPEC_URL = 'https://github.com/Apex-Fusion/vector-service-agents/blob/main/specs/document-pipeline.md';
const REQUEST = { source: { url: 'https://example.org/letter.pdf' }, task: 'summary', language: 'en', max_pages: 1 };

const sub = (n: number) => ({
  capability_id: 'ocr.page.extract.chandra-ocr-2.v1', advert_ref: `${'a1'.repeat(32)}#0`, escrow_ref: `${String(n).repeat(64)}#0`, supplier_pkh: '11'.repeat(28),
  receipt: { z: n, a: '\u{e9}' }, receipt_signature: '22'.repeat(64), verification: { signature_valid: true },
});
/** Keys out of alphabetical order, non-ASCII text, a line separator, quotes and a backslash: what a second serialisation would change or escape differently. */
const RESULT: PipelineResult = {
  schema: 'vector.document-pipeline.result.v1',
  source: { sha256: 'ab'.repeat(32), bytes: 927, mime: 'application/pdf', pages: 2 },
  pages: [{ index: 0, text: 'Pr\u{e9}cis \u{2713} \u{1F600} \u{2028} "quoted" \\ back', sub_job: sub(1) }],
  result: { summary: 'A summary.' },
  llm_sub_job: sub(2),
  accounting: { sub_jobs: 2, locked_total_lovelace: '4522060', fees_total_lovelace: '2000000' },
};

type Run = NonNullable<ServerOptions['runPipeline']>;
const fakeRun = (impl: Run = async () => RESULT) => vi.fn<Run>(impl);
const logs: string[] = [];
const log = (line: string): void => { logs.push(line); };
afterEach(() => { logs.length = 0; });
const options = (over: Partial<ServerOptions> = {}): ServerOptions => ({ manifest: MANIFEST, authHeader: TEST_AUTH, deps: baseDeps(), runPipeline: fakeRun(), log, ...over });

// ---- The manifest -------------------------------------------------------------------------------------------------------------------
describe('manifest', () => {
  test('a full environment gives every field of the manifest, in the order the design gives them', () => {
    const m = manifestFromEnv(MANIFEST_ENV);
    expect(Object.keys(m)).toStrictEqual(['schema', 'name', 'capability_id', 'version', 'description', 'operator', 'identity', 'keys', 'interface', 'terms', 'behaviour', 'status', 'gaps', 'links']);
    expect(m).toStrictEqual({
      schema: 'vector.agent-manifest.v1',
      name: 'Document Pipeline',
      capability_id: 'document.pipeline.ocr-summary.v1',
      version: '0.1.0',
      description: 'Reads a document: OCR for each page, then a summary or a structured extraction, with every sub-receipt checked and one receipt over the whole bundle.',
      operator: { name: 'Apex Fusion Foundation', contact: TEST_CONTACT },
      identity: { did: 'did:test', controller_pkh: SUPPLIER.pkh, registry_address: REGISTRY_ADDRESS },
      keys: { supplier_pkh: SUPPLIER.pkh, pub_key_hex: SUPPLIER.pubKeyHex, buyer_pkh: BUYER.pkh },
      interface: {
        request_schema: m.interface.request_schema, // held against the intake below
        response_schema: { $ref: `${SPEC_URL}#response` },
        routes: { job: '/v1/job', status: '/status', capability: '/capability' },
        notes: m.interface.notes, // held against the code below
      },
      terms: {
        price_lovelace: 5_000_000, supplier_bond_lovelace: 1_000_000, buyer_bond_lovelace: 1_000_000, max_processing_ms: 1_800_000,
        input_limits: { request_bytes: 900_000, source_bytes: 20_971_520, inline_media_bytes: 600_000, max_pages: 5 },
      },
      behaviour: {
        data_handling: 'The document, its page images, the task and the schema are held in memory while a job runs; a PDF is also written to a private temporary directory while its pages are rendered, and removed after. '
          + 'Pages go to the OCR agent as images, the page texts, the task and any schema to the LLM supplier, and escrow identifiers to Koios and the marketplace indexer; on the ledger the sub-escrows carry hashes, not the document or its text. '
          + 'The service writes only the bookkeeping of the escrows it posts (references, times, the hop, a transaction hash) to its state directory, and its log carries job outcomes, never a request or a document.',
        third_parties: ['the host of the source URL', 'the ChandraOCR agent, and Datalab behind it', 'the LLM supplier it hires, and its model provider', 'Koios (Vector mainnet indexer)', 'marketplace indexer'],
      },
      status: { chip: 'proposed', since: '2026-10-15' },
      gaps: [...GAPS],
      links: { spec: SPEC_URL, source: 'https://github.com/Apex-Fusion/vector-service-agents/tree/main/agents/document-pipeline', explorer_advert: '' },
    });
  });

  test('the identity fields are the operator\'s: the supplier key hash is both controller and supplier, the buyer key hash is its own field', () => {
    const m = manifestFromEnv({ ...MANIFEST_ENV, PIPELINE_BUYER_PKH: 'cd'.repeat(28), SUPPLIER_PKH: 'ab'.repeat(28), AGENT_DID: 'did:vector:agent:x:y' });
    expect(m.identity).toMatchObject({ did: 'did:vector:agent:x:y', controller_pkh: 'ab'.repeat(28) });
    expect(m.keys).toStrictEqual({ supplier_pkh: 'ab'.repeat(28), pub_key_hex: SUPPLIER.pubKeyHex, buyer_pkh: 'cd'.repeat(28) });
    expect(manifestFromEnv({ OPERATOR_CONTACT: TEST_CONTACT }).keys).toStrictEqual({ supplier_pkh: '', pub_key_hex: '', buyer_pkh: '' });
  });

  test('GET /agent.json serves exactly the bytes JSON.stringify gives for the manifest', async () => {
    await serve(options(), async (api) => {
      const r = await api.get('/agent.json');
      expect(r.status).toBe(200);
      expect(r.headers.get('content-type')).toBe('application/json');
      expect(r.text).toBe(JSON.stringify(MANIFEST));
    });
  });

  test('agent.json.template is the manifest with a placeholder for each of the five fields the operator supplies, byte for byte what renderTemplate prints', () => {
    const file = readFileSync(new URL('../agent.json.template', import.meta.url), 'utf8');
    const placeholders = { OPERATOR_CONTACT: '<OPERATOR_CONTACT>', AGENT_DID: '<AGENT_DID>', SUPPLIER_PKH: '<SUPPLIER_PKH>', SUPPLIER_PUB_KEY_HEX: '<SUPPLIER_PUB_KEY_HEX>', PIPELINE_BUYER_PKH: '<PIPELINE_BUYER_PKH>' };
    expect(JSON.parse(file)).toStrictEqual(manifestFromEnv(placeholders));
    expect(file).toBe(renderTemplate());
    expect(file.endsWith('}\n')).toBe(true);
    expect(file).not.toContain('\r');
    for (const placeholder of Object.values(placeholders)) expect(file, placeholder).toContain(`"${placeholder}"`);
    expect(file.match(/<[A-Z_]+>/g)?.sort()).toStrictEqual(['<AGENT_DID>', '<OPERATOR_CONTACT>', '<PIPELINE_BUYER_PKH>', '<SUPPLIER_PKH>', '<SUPPLIER_PKH>', '<SUPPLIER_PUB_KEY_HEX>']); // SUPPLIER_PKH twice: controller and supplier
  });

  test('OPERATOR_CONTACT is required: unset, empty and blank are refused and the error names the variable', () => {
    for (const v of [undefined, '', ' ', '\t\n']) expect(() => manifestFromEnv(v === undefined ? {} : { OPERATOR_CONTACT: v }), JSON.stringify(v)).toThrow(/OPERATOR_CONTACT/);
    expect(manifestFromEnv({ OPERATOR_CONTACT: `  ${TEST_CONTACT}\n` }).operator).toStrictEqual({ name: 'Apex Fusion Foundation', contact: TEST_CONTACT });
  });

  test('no address is built into the code: the manifest holds exactly the contact it was given', () => {
    expect(JSON.stringify(manifestFromEnv({ OPERATOR_CONTACT: 'a role' }))).not.toMatch(/@/);
    for (const file of ['server.ts', 'start.ts', 'gaps.ts', 'index.ts']) expect(readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8'), file).not.toMatch(/[A-Za-z0-9._-]+@[A-Za-z0-9-]+\.[A-Za-z]/);
  });

  test('defaults: proposed since 2026-10-15, price 5 units, both bonds 1 unit, a 30 min window, the limits of the intake', () => {
    const m = manifestFromEnv({ OPERATOR_CONTACT: TEST_CONTACT });
    expect(m).toMatchObject({
      version: '0.1.0', status: { chip: 'proposed', since: '2026-10-15' },
      terms: { price_lovelace: 5_000_000, supplier_bond_lovelace: 1_000_000, buyer_bond_lovelace: 1_000_000, max_processing_ms: 1_800_000 },
    });
    // The limits are the numbers the intake enforces, not copies of them.
    expect(m.terms.input_limits).toStrictEqual({ request_bytes: 900_000, source_bytes: MAX_SOURCE_BYTES, inline_media_bytes: MAX_INLINE_BYTES, max_pages: MAX_PAGES });
    expect(MAX_SOURCE_BYTES).toBe(20 * 1024 * 1024);
    // The runtime's service timeout (1680000 ms) is the window the job has plus 60 s, and the job's own deadline is inside the advert's 30 min.
    expect(JOB_DEADLINE_MS).toBe(1_620_000);
    expect(m.terms.max_processing_ms).toBeGreaterThan(JOB_DEADLINE_MS);
  });

  test('numeric settings: absent or empty means the default, a number is used, anything else is refused with the variable named', () => {
    expect(manifestFromEnv({ OPERATOR_CONTACT: TEST_CONTACT, ADVERT_PRICE_LOVELACE: '' }).terms.price_lovelace).toBe(5_000_000);
    expect(manifestFromEnv({ OPERATOR_CONTACT: TEST_CONTACT, ADVERT_PRICE_LOVELACE: '6000000', ADVERT_MAX_PROCESSING_MS: '2400000' }).terms).toMatchObject({ price_lovelace: 6_000_000, max_processing_ms: 2_400_000 });
    expect(manifestFromEnv({ OPERATOR_CONTACT: TEST_CONTACT, ADVERT_PRICE_LOVELACE: '0' }).terms.price_lovelace).toBe(0);
    for (const bad of ['one', '-1', '1.5', '1e6', ' 5', '0x10', '99999999999999999999']) {
      expect(() => manifestFromEnv({ OPERATOR_CONTACT: TEST_CONTACT, ADVERT_PRICE_LOVELACE: bad }), bad).toThrow(/ADVERT_PRICE_LOVELACE/);
    }
    expect(() => manifestFromEnv({ OPERATOR_CONTACT: TEST_CONTACT, ADVERT_MAX_PROCESSING_MS: '-1' })).toThrow(/ADVERT_MAX_PROCESSING_MS/);
    expect(() => envInt('PORT', 'ninety', 9092)).toThrow(/PORT/);
    expect(envInt('PORT', undefined, 9092)).toBe(9092);
    expect(envInt('PORT', '0', 9092)).toBe(0);
  });

  test('the processing window is at least 30 min: the deadline of a job assumes it, so a smaller ADVERT_MAX_PROCESSING_MS is refused with the variable named', () => {
    for (const bad of ['0', '300000', '1200000', '1799999']) {
      expect(() => manifestFromEnv({ OPERATOR_CONTACT: TEST_CONTACT, ADVERT_MAX_PROCESSING_MS: bad }), bad).toThrow(/environment variable ADVERT_MAX_PROCESSING_MS must be at least 1800000/);
    }
    expect(manifestFromEnv({ OPERATOR_CONTACT: TEST_CONTACT, ADVERT_MAX_PROCESSING_MS: '1800000' }).terms.max_processing_ms).toBe(1_800_000);
    expect(manifestFromEnv({ OPERATOR_CONTACT: TEST_CONTACT, ADVERT_MAX_PROCESSING_MS: '1800001' }).terms.max_processing_ms).toBe(1_800_001);
    expect(manifestFromEnv({ OPERATOR_CONTACT: TEST_CONTACT, ADVERT_MAX_PROCESSING_MS: '' }).terms.max_processing_ms).toBe(1_800_000);
    // The deadline of a job and the service timeout of the runtime, 60 s later, fit inside the smallest window that is allowed.
    expect(JOB_DEADLINE_MS + 60_000).toBeLessThanOrEqual(1_800_000);
  });

  test('a value that is long or looks like a key is never shown in the message of a numeric or status setting, only its length; a short plain one is', () => {
    const key = BUYER.privateKeyHex;
    const message = (name: string, value: string): string => {
      try { manifestFromEnv({ OPERATOR_CONTACT: TEST_CONTACT, [name]: value }); } catch (e) { return (e as Error).message; }
      throw new Error(`${name} was accepted`);
    };
    for (const name of ['ADVERT_PRICE_LOVELACE', 'ADVERT_MAX_PROCESSING_MS', 'AGENT_STATUS_CHIP', 'AGENT_STATUS_SINCE']) {
      const text = message(name, key);
      expect(text, name).toContain(name);
      expect(text, name).toContain('64 characters');
      expect(text, name).not.toContain(key.slice(0, 16));
      expect(text, name).not.toContain(key.slice(-16));
    }
    expect(message('ADVERT_PRICE_LOVELACE', 'one')).toContain('"one"');
    expect(message('AGENT_STATUS_CHIP', 'launched')).toContain('"launched"');
    expect(message('AGENT_STATUS_SINCE', 'yesterday')).toContain('"yesterday"');
    expect(() => envInt('PORT', key, 9092)).toThrow(/PORT.*64 characters/);
  });

  test('AGENT_STATUS_CHIP must be live, deployed or proposed in any case and the manifest carries it in lower case; the default is proposed, never live', () => {
    const chip = (value: string | undefined) => manifestFromEnv({ OPERATOR_CONTACT: TEST_CONTACT, ...(value === undefined ? {} : { AGENT_STATUS_CHIP: value }) }).status.chip;
    expect(chip(undefined)).toBe('proposed');
    expect(chip('')).toBe('proposed');
    expect(chip('Proposed')).toBe('proposed');
    expect(chip('DEPLOYED')).toBe('deployed');
    expect(chip('live')).toBe('live');
    for (const bad of ['launched', 'live!', 'prod', 'proposed ']) expect(() => chip(bad), bad).toThrow(/AGENT_STATUS_CHIP/);
    expect(manifestFromEnv({ OPERATOR_CONTACT: TEST_CONTACT, AGENT_STATUS_SINCE: '2027-01-02' }).status).toStrictEqual({ chip: 'proposed', since: '2027-01-02' });
    // The date is published in a manifest that is hashed into the advert: blank means the default, and anything that is not a date is refused.
    expect(manifestFromEnv({ OPERATOR_CONTACT: TEST_CONTACT, AGENT_STATUS_SINCE: ' ' }).status.since).toBe('2026-10-15');
    for (const bad of ['yesterday', '2026-10-1', '15-10-2026', '20261015', '2026-10-15T00:00:00Z']) expect(() => manifestFromEnv({ OPERATOR_CONTACT: TEST_CONTACT, AGENT_STATUS_SINCE: bad }), bad).toThrow(/AGENT_STATUS_SINCE/);
    expect(manifestFromEnv({ OPERATOR_CONTACT: TEST_CONTACT, AGENT_VERSION: '0.2.0', ADVERT_EXPLORER_URL: 'https://explorer.example.test/tx' })).toMatchObject({ version: '0.2.0', links: { explorer_advert: 'https://explorer.example.test/tx' } });
  });

  test('the gaps are the shared sentences, in order, each one line of plain text', () => {
    expect(manifestFromEnv({ OPERATOR_CONTACT: TEST_CONTACT }).gaps).toStrictEqual([...GAPS]);
    expect(GAPS).toHaveLength(7);
    for (const gap of GAPS) {
      expect(gap).toMatch(/^[A-Za-z0-9].*\.$/);
      expect(gap).not.toMatch(/[\r\n\u{2013}\u{2014}]/u);
      expect(gap).not.toMatch(UNIT_NAME);
    }
    expect(new Set(GAPS).size).toBe(GAPS.length);
  });
});

// ---- The request schema the manifest publishes --------------------------------------------------------------------------------------
describe('manifest: request_schema is what the intake accepts', () => {
  const schema = MANIFEST.interface.request_schema;
  const validate = new Ajv({ strict: true, allErrors: true }).compile(schema);
  const intake = (value: unknown): boolean => {
    try { parseRequest(JSON.stringify(value)); return true; } catch (e) { if (e instanceof RequestError) return false; throw e; }
  };
  const b64 = (bytes: number): string => Buffer.alloc(bytes, 7).toString('base64');
  const url = { url: 'https://example.org/letter.pdf' };
  const pdf = (data = b64(10)) => ({ pdf_b64: data, mime: 'application/pdf' });
  const png = (data = b64(10)) => ({ image_b64: data, mime: 'image/png' });
  const req = (over: Record<string, unknown> = {}) => ({ source: url, task: 'summary', ...over });
  const CASES: Array<[string, unknown]> = [
    // the shapes the spec shows
    ['a url and a summary', req()],
    ['the example of the spec', { source: { url: 'https://example.org/letter.pdf' }, task: 'summary', language: 'en', max_pages: 1 }],
    ['an inline pdf', req({ source: pdf() })],
    ['an inline png', req({ source: png() })],
    ['an inline jpeg', req({ source: { image_b64: b64(10), mime: 'image/jpeg' } })],
    ['an extraction with a schema', req({ task: 'extract', schema: { type: 'object', properties: { title: { type: 'string' } } } })],
    ['an extraction with an empty schema', req({ task: 'extract', schema: {} })],
    // task and schema go together
    ['an extraction without a schema', req({ task: 'extract' })],
    ['a summary with a schema', req({ schema: { type: 'object' } })],
    ['a schema that is not an object', req({ task: 'extract', schema: [] })],
    ['a null schema', req({ task: 'extract', schema: null })],
    ['an unknown task', req({ task: 'translate' })],
    ['no task', { source: url }],
    ['no source', { task: 'summary' }],
    // the object itself
    ['an unknown key', req({ extra: 1 })],
    ['an array', []],
    ['null', null],
    ['text', 'a request'],
    // the source
    ['an empty source', req({ source: {} })],
    ['a source that is a list', req({ source: [url] })],
    ['an empty url', req({ source: { url: '' } })],
    ['a url that is a number', req({ source: { url: 5 } })],
    ['a url with another key', req({ source: { url: 'https://example.org/a.pdf', mime: 'application/pdf' } })],
    ['a pdf without a mime', req({ source: { pdf_b64: b64(10) } })],
    ['a pdf with a png mime', req({ source: { pdf_b64: b64(10), mime: 'image/png' } })],
    ['a png with a pdf mime', req({ source: { image_b64: b64(10), mime: 'application/pdf' } })],
    ['a webp image', req({ source: { image_b64: b64(10), mime: 'image/webp' } })],
    ['a pdf and an image together', req({ source: { pdf_b64: b64(10), image_b64: b64(10), mime: 'application/pdf' } })],
    ['an extra key beside a pdf', req({ source: { ...pdf(), extra: 1 } })],
    // the size of inline media: 600000 raw bytes are 800000 characters
    ['600000 raw bytes', req({ source: pdf(b64(600_000)) })],
    ['599999 raw bytes', req({ source: pdf(b64(599_999)) })],
    ['599998 raw bytes', req({ source: pdf(b64(599_998)) })],
    ['600001 raw bytes', req({ source: pdf(b64(600_001)) })],
    ['600002 raw bytes', req({ source: pdf(b64(600_002)) })],
    ['600003 raw bytes', req({ source: pdf(b64(600_003)) })],
    // the form of base64: standard alphabet, padded, nothing else
    ['unpadded base64', req({ source: pdf('QUJD' + 'RA') })],
    ['padded base64', req({ source: pdf('QUJDRA==') })],
    ['base64 with a line break', req({ source: pdf('QUJD\nRA==') })],
    ['base64 with a space', req({ source: pdf('QUJD RA==') })],
    ['url-safe base64', req({ source: pdf('QUJD-A==') })],
    ['base64 with padding in the middle', req({ source: pdf('QU==QUJD') })],
    ['three characters of padding', req({ source: pdf('A===') })],
    ['an empty pdf', req({ source: pdf('') })],
    ['a pdf of one block', req({ source: pdf('AAAA') })],
    // max_pages: a whole number from 1 to 5
    ...[1, 2, 3, 4, 5].map((n): [string, unknown] => [`max_pages ${n}`, req({ max_pages: n })]),
    ...[0, 6, -1, 1.5, '3', null, true].map((n): [string, unknown] => [`max_pages ${JSON.stringify(n)}`, req({ max_pages: n })]),
    // language: a code of 2 to 8 letters and hyphen-separated subtags, at most 16 characters
    ...['en', 'EN', 'de', 'deu', 'en-GB', 'zh-Hant-TW', 'es-419', 'abcdefgh', 'abcdefgh-1234567'].map((l): [string, unknown] => [`language ${l}`, req({ language: l })]),
    ...['', 'e', 'abcdefghi', 'abcdefgh-12345678', 'en_GB', '1en', 'e1', 'en-', 'en--GB', ' en', 'en ', 'en\n', '-en', 'en-GB-', '\u{e9}\u{e9}', 5, null].map((l): [string, unknown] => [`language ${JSON.stringify(l)}`, req({ language: l })]),
  ];

  test('the schema compiles in strict mode, and its defaults are the intake\'s', () => {
    expect(schema).toMatchObject({ type: 'object', required: ['source', 'task'], additionalProperties: false });
    expect(schema.properties.max_pages).toMatchObject({ default: MAX_PAGES, minimum: 1, maximum: MAX_PAGES });
    expect(schema.properties.language).toMatchObject({ default: DEFAULT_LANGUAGE, maxLength: 16 });
    expect(Object.keys(schema.properties).sort()).toStrictEqual(['language', 'max_pages', 'schema', 'source', 'task']);
    expect(parseRequest(JSON.stringify({ source: url, task: 'summary' }))).toMatchObject({ language: DEFAULT_LANGUAGE, max_pages: MAX_PAGES });
  });

  test.each(CASES)('agrees with parseRequest on: %s', (_label, value) => {
    const wanted = intake(value);
    expect(validate(JSON.parse(JSON.stringify(value))), JSON.stringify(validate.errors)).toBe(wanted);
  });

  test('the table has both answers in good number, so agreement is not agreement about nothing', () => {
    const accepted = CASES.filter(([, value]) => intake(value)).length;
    expect(accepted).toBeGreaterThan(20);
    expect(CASES.length - accepted).toBeGreaterThan(40);
  });

  test('a url must be https: the schema says so, and the intake leaves it to the fetch, which refuses anything else before a byte is read', () => {
    expect(validate({ source: { url: 'http://example.org/a.pdf' }, task: 'summary' })).toBe(false);
    expect(validate({ source: { url: 'ftp://example.org/a.pdf' }, task: 'summary' })).toBe(false);
    expect(validate({ source: { url: 'https://example.org/a.pdf' }, task: 'summary' })).toBe(true);
  });
});

describe('manifest: notes state the rules for an extraction schema', () => {
  const notes = MANIFEST.interface.notes;
  const text = notes.join('\n');
  const refused = (schema: Record<string, unknown>): unknown => {
    try { compileExtractionSchema(schema); } catch (e) { return e; }
    return null;
  };

  test('a short list of sentences, each one line', () => {
    expect(notes.length).toBeGreaterThanOrEqual(3);
    expect(notes.length).toBeLessThanOrEqual(5);
    for (const note of notes) { expect(note).toMatch(/\.$/); expect(note).not.toMatch(/[\r\n\u{2013}\u{2014}]/u); }
    expect(text).toMatch(/draft-07/);
    expect(text).toMatch(/strict/);
  });

  test('every keyword the notes say is refused is refused (schema_invalid, 400), and the same schema without it is accepted', () => {
    const named: Array<[string, unknown]> = [
      ['$ref', '#/properties/x'], ['$dynamicRef', '#x'], ['$recursiveRef', '#'], ['$id', 'urn:x'], ['$defs', {}], ['definitions', {}],
      ['pattern', '^a$'], ['patternProperties', {}], ['format', 'date'],
    ];
    expect(compileExtractionSchema({ type: 'object', properties: { x: { type: 'string' } } })).toBeTypeOf('function');
    for (const [keyword, value] of named) {
      expect(text, keyword).toContain(keyword);
      expect(refused({ type: 'object', properties: { x: { type: 'string', [keyword]: value } } }), keyword).toMatchObject({ code: 'schema_invalid', status: 400 });
    }
    // An own __proto__ key, which JSON.parse makes and an object literal does not.
    expect(text).toContain('__proto__');
    expect(refused(JSON.parse('{"type":"object","properties":{"x":{"type":"string","__proto__":{}}}}'))).toMatchObject({ code: 'schema_invalid', status: 400 });
  });

  test('the notes say that $async at the root is refused, and it is, true or false (schema_invalid, 400)', () => {
    expect(text).toContain('declare $async at the root');
    for (const value of [true, false]) expect(refused({ $async: value, type: 'object' }), String(value)).toMatchObject({ code: 'schema_invalid', status: 400 });
  });

  test('the numbers in the notes are the limits of the code: bytes of JSON, levels, entries of anyOf, oneOf and allOf', () => {
    expect([SCHEMA_MAX_BYTES, SCHEMA_MAX_DEPTH, COMBINATION_MAX_ENTRIES]).toStrictEqual([16_384, 32, 16]);
    for (const n of [SCHEMA_MAX_BYTES, SCHEMA_MAX_DEPTH, COMBINATION_MAX_ENTRIES]) expect(text).toContain(String(n));
    for (const keyword of ['anyOf', 'oneOf', 'allOf']) {
      expect(text, keyword).toContain(keyword);
      expect(refused({ [keyword]: Array.from({ length: COMBINATION_MAX_ENTRIES + 1 }, () => ({ type: 'string' })) }), keyword).toMatchObject({ code: 'schema_invalid' });
      expect(refused({ [keyword]: Array.from({ length: COMBINATION_MAX_ENTRIES }, () => ({ type: 'string' })) }), keyword).toBeNull();
    }
    expect(refused({ type: 'object', title: 'x'.repeat(SCHEMA_MAX_BYTES) })).toMatchObject({ code: 'schema_invalid' });
  });

  test('an answer that is not JSON or does not validate is not an error: schema_valid false, extraction null, the answer as raw_text', () => {
    expect(text).toMatch(/schema_valid false/);
    expect(text).toMatch(/raw_text/);
    const check = compileExtractionSchema({ type: 'object', required: ['title'], properties: { title: { type: 'string' } } });
    expect(answerResult('extract', 'not json', check)).toStrictEqual({ extraction: null, schema_valid: false, raw_text: 'not json' });
    expect(answerResult('extract', '{"title": 5}', check)).toMatchObject({ extraction: null, schema_valid: false });
  });
});

// ---- The wire message ---------------------------------------------------------------------------------------------------------------
describe('parseWire: the message the runtime posts', () => {
  const message = (content: string, role = 'user') => JSON.stringify([{ content, role }]);

  test('gives the request JSON, the content of the one message, exactly as a string', () => {
    expect(parseWire(message('{"a":1}'))).toBe('{"a":1}');
    const odd = 'line one\nline \u{e9} \u{2028} "q" \\ end';
    expect(parseWire(message(odd))).toBe(odd);
    expect(parseWire('[{"content":"x","role":"user","name":"ignored"}]')).toBe('x'); // the contract is content and role
  });

  test.each([
    ['nothing', ''], ['text that is not JSON', '{not json'], ['an object', '{"content":"x","role":"user"}'], ['an empty list', '[]'], ['null', 'null'],
    ['a list of one number', '[1]'], ['a list of one null', '[null]'], ['a list of one list', '[["x"]]'],
    ['a message without content', '[{"role":"user"}]'], ['content that is not text', '[{"content":{"a":1},"role":"user"}]'], ['content that is a number', '[{"content":1,"role":"user"}]'],
    ['two messages', message('{}').replace(']', `,${JSON.stringify({ content: '{}', role: 'user' })}]`)],
    ['a message without a role', '[{"content":"{}"}]'], ['an assistant message', message('{}', 'assistant')], ['a role in capitals', message('{}', 'User')],
  ])('refuses %s as bad_wire (400)', (_label, body) => {
    expect(() => parseWire(body)).toThrow(WireError);
    try { parseWire(body); } catch (e) { expect(e).toMatchObject({ name: 'WireError', code: 'bad_wire', status: 400 }); expect((e as Error).message.length).toBeGreaterThan(20); }
  });

  test('the size limit is MAX_BODY bytes: the limit passes, one byte more does not, and multi-byte characters count as bytes', () => {
    expect(MAX_BODY).toBe(1_000_000);
    const frame = (n: number) => message('x'.repeat(n - Buffer.byteLength(message(''))));
    expect(Buffer.byteLength(frame(MAX_BODY))).toBe(MAX_BODY);
    expect(parseWire(frame(MAX_BODY))).toHaveLength(MAX_BODY - Buffer.byteLength(message('')));
    expect(() => parseWire(frame(MAX_BODY + 1))).toThrow(expect.objectContaining({ code: 'request_too_large', status: 400 }));
    const wide = '\u{e9}'.repeat(MAX_BODY / 2 + 10); // fewer characters than the limit, more bytes
    expect(message(wide).length).toBeLessThan(MAX_BODY);
    expect(Buffer.byteLength(message(wide))).toBeGreaterThan(MAX_BODY);
    expect(() => parseWire(message(wide))).toThrow(expect.objectContaining({ code: 'request_too_large' }));
  });
});

describe('POST /: the wire contract over HTTP', () => {
  test('a body that is not the message array is a 400 {error, message} and no job is started', async () => {
    const run = fakeRun();
    await serve(options({ runPipeline: run }), async (api) => {
      for (const body of ['', 'not json', '{"content":"{}","role":"user"}', '[]', '[{"content":"{}","role":"assistant"}]', JSON.stringify([{ content: '{}', role: 'user' }, { content: '{}', role: 'user' }])]) {
        const r = await api.post(body);
        expect(r.status, body).toBe(400);
        expect(r.json, body).toStrictEqual({ error: 'bad_wire', message: expect.any(String) });
        expect(r.headers.get('content-type')).toBe('application/json');
      }
    });
    expect(run).not.toHaveBeenCalled();
  });

  test('the size limit is 1 MB in bytes: the limit gets past the size check and is refused later, one byte more is refused for its size', async () => {
    const run = fakeRun();
    const frame = (n: number) => wire('x'.repeat(n - Buffer.byteLength(wire('')))); // a well-formed message whose content is not JSON
    await serve(options({ runPipeline: run }), async (api) => {
      const atLimit = await api.post(frame(MAX_BODY));
      expect(atLimit.status).toBe(400);
      expect(atLimit.json.error).toBe('bad_json'); // the request JSON is refused by the intake: the size check was passed
      const over = await api.post(frame(MAX_BODY + 1));
      expect(over.status).toBe(400);
      expect(over.json).toStrictEqual({ error: 'request_too_large', message: expect.stringMatching(/1000000/) });
      expect(over.headers.get('connection')).toBe('close');
      const wide = await api.post('\u{e9}'.repeat(600_000)); // 600000 characters, 1200000 bytes
      expect(wide.json.error).toBe('request_too_large');
    });
    expect(run).not.toHaveBeenCalled();
  });

  test('the request JSON goes through parseRequest, and a request it refuses is a 400 with its code and no job', async () => {
    const run = fakeRun();
    const bad: Array<[string, unknown, string]> = [
      ['text that is not JSON', 'not json', 'bad_json'],
      ['a list', [], 'bad_shape'],
      ['an unknown key', { ...REQUEST, extra: true }, 'bad_shape'],
      ['no task', { source: REQUEST.source }, 'bad_shape'],
      ['an extraction without a schema', { source: REQUEST.source, task: 'extract' }, 'schema_required'],
      ['too many pages', { ...REQUEST, max_pages: 6 }, 'max_pages_range'],
      ['a bad language', { ...REQUEST, language: 'e' }, 'language_bad'],
      ['too much inline media', { source: { pdf_b64: Buffer.alloc(600_001).toString('base64'), mime: 'application/pdf' }, task: 'summary' }, 'base64_too_large'],
    ];
    await serve(options({ runPipeline: run }), async (api) => {
      for (const [label, request, code] of bad) {
        const r = await api.post(wire(request));
        expect(r.status, label).toBe(400);
        expect(r.json, label).toStrictEqual({ error: code, message: expect.any(String) });
      }
    });
    expect(run).not.toHaveBeenCalled();
  });

  test('a valid request runs the pipeline with the parsed request (defaults filled in) and the deps, and the deadline is set on arrival, request by request', async () => {
    const t = { now: T0 };
    const deps = baseDeps({ clock: () => t.now });
    const run = fakeRun();
    await serve(options({ deps, runPipeline: run }), async (api) => {
      await api.post(wire({ source: { url: 'https://example.org/letter.pdf' }, task: 'summary' }));
      t.now += 5_000;
      await api.post(wire(REQUEST));
    });
    expect(run).toHaveBeenCalledTimes(2);
    const [[first, firstDeps], [second, secondDeps]] = run.mock.calls;
    expect(first).toStrictEqual({ source: { url: 'https://example.org/letter.pdf' }, task: 'summary', language: 'en', max_pages: 5 });
    expect(second).toStrictEqual(REQUEST);
    // Per request, 1620000 ms after it arrived: 60 s inside the runtime's service timeout of 1680000 ms.
    expect(firstDeps.deadlineMs).toBe(T0 + 1_620_000);
    expect(secondDeps.deadlineMs).toBe(T0 + 5_000 + 1_620_000);
    for (const key of ['chain', 'fetchImpl', 'renderer', 'clock', 'sleep', 'ocrAllowlistPkh', 'llmAllowlist', 'stranded'] as const) expect(firstDeps[key], key).toBe(deps[key]);
  });

  test('the answer is JSON.stringify(result), serialised once, byte for byte, as application/json with status 200', async () => {
    const expected = Buffer.from(JSON.stringify(RESULT), 'utf8');
    const stringify = vi.spyOn(JSON, 'stringify');
    await serve(options({ runPipeline: fakeRun(async () => RESULT) }), async (api) => {
      const res = await fetch(`${api.url}/`, { method: 'POST', headers: AUTH, body: wire(REQUEST) });
      const bytes = Buffer.from(await res.arrayBuffer());
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('application/json');
      expect(bytes.equals(expected)).toBe(true); // UTF-8, no byte order mark, no newline, keys in the order they were made
      expect(bytes.toString('utf8')).not.toMatch(/\n/);
    });
    expect(stringify.mock.calls.filter(([value]) => value === RESULT)).toHaveLength(1); // the result itself is serialised once, and what is sent is that text
  });

  test('the logs of a job carry its outcome and size, never the request', async () => {
    await serve(options(), async (api) => {
      await api.post(wire({ ...REQUEST, source: { url: 'https://example.org/MARKER-in-the-request.pdf' } }));
    });
    expect(logs.join('\n')).toMatch(/job done/);
    expect(logs.join('\n')).toMatch(/2 sub-jobs/);
    expect(logs.join('\n')).not.toContain('MARKER');
  });
});

describe('POST /: errors', () => {
  const failing = (error: unknown) => fakeRun(async () => { throw error; });
  const reply = async (error: unknown) => serve(options({ runPipeline: failing(error) }), (api) => api.post(wire(REQUEST)));

  test('a RequestError answers with its status, 400 for a request it refuses and 422 for a document it cannot use: {error: code, message}', async () => {
    expect(await reply(new RequestError('source_fetch_failed', 'the document could not be fetched'))).toMatchObject({ status: 422, json: { error: 'source_fetch_failed', message: 'the document could not be fetched' } });
    expect(await reply(new RequestError('unreadable_source', 'the PDF could not be opened'))).toMatchObject({ status: 422, json: { error: 'unreadable_source' } });
    expect(await reply(new RequestError('bad_shape', 'nope'))).toMatchObject({ status: 400, json: { error: 'bad_shape', message: 'nope' } });
    expect(logs.join('\n')).toMatch(/request refused after \d+ ms: bad_shape \(400\)/);
  });

  // What a buyer is told when the service fails on its side: the code, and where the detail is. The runtime copies the first 200 characters of a failure to the buyer.
  const FIXED = (code: string) => `The service could not do this job (${code}). The operator's log has the detail.`;

  test('a PipelineError answers with its status and {error: code, message}: 422 by default, 400 as it says, and 503 and 500 with a fixed text', async () => {
    expect(await reply(new PipelineError('ocr_failed', 'page 1 failed'))).toMatchObject({ status: 422, json: { error: 'ocr_failed', message: 'page 1 failed' } });
    expect(await reply(new PipelineError('deadline', 'late'))).toMatchObject({ status: 422, json: { error: 'deadline' } });
    expect(await reply(new PipelineError('schema_invalid', 'bad schema', 400))).toMatchObject({ status: 400, json: { error: 'schema_invalid', message: 'bad schema' } });
    for (const code of ['insufficient_float', 'ocr_supplier_unavailable', 'llm_supplier_unavailable'] as const) {
      expect(await reply(new PipelineError(code, 'cannot take a job now', 503))).toMatchObject({ status: 503, json: { error: code, message: FIXED(code) } });
    }
    expect(await reply(new PipelineError('store_write_failed', 'the store could not be written', 500))).toMatchObject({ status: 500, json: { error: 'store_write_failed', message: FIXED('store_write_failed') } });
    // The body is exactly {error, message}.
    expect((await reply(new PipelineError('ocr_failed', 'm'))).json).toStrictEqual({ error: 'ocr_failed', message: 'm' });
    expect(logs.join('\n')).toMatch(/job failed after \d+ ms: ocr_failed \(422\)/);
  });

  test('a failure on the service side (5xx) tells the buyer only the code and where the detail is, and puts the whole message in the log', async () => {
    const detail = (code: string) => `${code}: could not write /var/lib/pipeline/stranded.json.tmp (EACCES) for escrow ${'ab'.repeat(32)}#0; the provider said "Ogmios network error"`;
    for (const [code, status] of [['store_write_failed', 500], ['insufficient_float', 503], ['ocr_supplier_unavailable', 503], ['llm_supplier_unavailable', 503]] as const) {
      logs.length = 0;
      const r = await reply(new PipelineError(code, detail(code), status));
      expect(r.status, code).toBe(status);
      expect(r.json, code).toStrictEqual({ error: code, message: FIXED(code) });
      expect(r.text, code).not.toContain('/var/lib');
      expect(r.text, code).not.toContain('ab'.repeat(32));
      expect(r.json.message.length, code).toBeLessThan(200);
      expect(logs.join('\n'), code).toContain(`job failed after 0 ms: ${code} (${status}): ${detail(code)}`);
    }
  });

  test('a failure the buyer can act on (400, 422) keeps its message, and the log names its code and status only', async () => {
    const r = await reply(new PipelineError('ocr_failed', 'page 3 failed: the supplier said it was busy'));
    expect(r.json).toStrictEqual({ error: 'ocr_failed', message: 'page 3 failed: the supplier said it was busy' });
    expect(logs.join('\n')).toContain('job failed after 0 ms: ocr_failed (422)');
    expect(logs.join('\n')).not.toContain('the supplier said it was busy');
  });

  test('anything else is a 500 {error: "internal"} with no detail, logged by message only, and the server keeps answering', async () => {
    const secret = 'ENOENT: no such file /srv/private/doc-4711.pdf';
    const run = fakeRun(async () => { throw new Error(secret); });
    await serve(options({ runPipeline: run }), async (api) => {
      const r = await api.post(wire({ ...REQUEST, source: { url: 'https://example.org/MARKER-in-the-request.pdf' } }));
      expect(r.status).toBe(500);
      expect(r.json).toStrictEqual({ error: 'internal' });
      expect(r.text).not.toContain('ENOENT');
      expect((await api.get('/healthz')).status).toBe(200); // the process is still alive
    });
    const logged = logs.join('\n');
    expect(logged).toContain(secret); // the cause is in the log, for the operator
    expect(logged).toMatch(/internal/);
    expect(logged).not.toContain('MARKER'); // the message only, never the request
  });

  test('a throw that is not an Error, and a result that cannot be serialised, are 500 internal as well', async () => {
    expect(await reply('a string')).toMatchObject({ status: 500, json: { error: 'internal' } });
    expect(await reply(undefined)).toMatchObject({ status: 500, json: { error: 'internal' } });
    const unserialisable = { schema: 'x', accounting: { sub_jobs: 10n } } as unknown as PipelineResult; // JSON.stringify throws on a BigInt
    await serve(options({ runPipeline: fakeRun(async () => unserialisable) }), async (api) => {
      expect(await api.post(wire(REQUEST))).toMatchObject({ status: 500, json: { error: 'internal' } });
      expect((await api.get('/healthz')).status).toBe(200);
    });
  });

  test('a failure after the headers went out destroys the response and sends nothing more', async () => {
    const server = createServer(options());
    const res: any = { headersSent: false, writeHead: vi.fn(() => { res.headersSent = true; throw new Error('socket closed'); }), end: vi.fn(), destroy: vi.fn() };
    server.emit('request', { method: 'GET', url: '/agent.json' }, res);
    await settle();
    expect(res.destroy).toHaveBeenCalledTimes(1);
    expect(res.writeHead).toHaveBeenCalledTimes(1); // no second try to send a 500: that would throw out of the handler
    expect(res.end).not.toHaveBeenCalled();
    expect(logs.join('\n')).toMatch(/socket closed/);
    server.close();
  });
});

describe('POST /: one job at a time', () => {
  const gate = () => { let release!: () => void; const open = new Promise<void>((resolve) => { release = resolve; }); return { open, release }; };

  test('a second job while one runs is a 409 {error: "busy"} and starts nothing; the slot is free again when the first is done', async () => {
    const { open, release } = gate();
    const run = fakeRun(async () => { await open; return RESULT; });
    await serve(options({ runPipeline: run }), async (api) => {
      const first = api.post(wire(REQUEST));
      await until(() => run.mock.calls.length === 1, 'the first job is running');
      const second = await api.post(wire(REQUEST));
      expect(second.status).toBe(409);
      expect(second.json).toStrictEqual({ error: 'busy' });
      expect(run).toHaveBeenCalledTimes(1);
      // The service stays up for the other routes while it works.
      expect((await api.get('/healthz')).status).toBe(200);
      expect((await api.get('/agent.json')).status).toBe(200);
      release();
      expect((await first).status).toBe(200);
      expect((await api.post(wire(REQUEST))).status).toBe(200);
    });
    expect(run).toHaveBeenCalledTimes(2);
  });

  test('a request that is refused does not take the slot, and a job that fails frees it', async () => {
    const { open, release } = gate();
    let calls = 0;
    const run = fakeRun(async () => {
      calls += 1;
      if (calls === 1) { await open; throw new PipelineError('ocr_failed', 'page 1 failed'); }
      return RESULT;
    });
    await serve(options({ runPipeline: run }), async (api) => {
      const first = api.post(wire(REQUEST));
      await until(() => run.mock.calls.length === 1, 'the first job is running');
      expect((await api.post('not json')).status).toBe(400); // a refusal is answered as a refusal, not as busy
      expect((await api.post(wire(REQUEST))).status).toBe(409);
      release();
      expect((await first).status).toBe(422);
      expect((await api.post(wire(REQUEST))).status).toBe(200);
    });
  });

  test('a job that throws something odd frees the slot too', async () => {
    let calls = 0;
    const run = fakeRun(async () => { calls += 1; if (calls === 1) throw new Error('boom'); return RESULT; });
    await serve(options({ runPipeline: run }), async (api) => {
      expect((await api.post(wire(REQUEST))).status).toBe(500);
      expect((await api.post(wire(REQUEST))).status).toBe(200);
    });
  });
});

// ---- R47: the runtime's fetch gives up after 300 s of silence ------------------------------------------------------------------------
// The template runtime calls this service with the global fetch and only AbortSignal.timeout(budget). Behind fetch, undici gives up on a response that
// has not begun after 300 s (its headers timeout), and a job takes up to 27 minutes: the runtime would report service_unreachable while the service goes on
// hiring and paying, and holds its slot. So while a job runs the server writes "102 Processing" now and then; undici counts an interim response as life
// and keeps waiting for the final one. fetch hides those lines, so these tests read the socket.
describe('POST /: a long job keeps its answer alive with 102 Processing (R47)', () => {
  const latch = () => { let release!: () => void; const open = new Promise<void>((resolve) => { release = resolve; }); return { open, release }; };
  const request = wire(REQUEST);
  const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const makeRequest = (): EventEmitter => Object.assign(new EventEmitter(), { method: 'POST', url: '/', headers: { ...AUTH }, httpVersionMajor: 1, httpVersionMinor: 1 });
  const makeResponse = () => Object.assign(new EventEmitter(), { headersSent: false, destroyed: false, writeProcessing: vi.fn(), writeHead: vi.fn(), end: vi.fn(), destroy: vi.fn() });

  test('while a job runs the server writes "102 Processing" on its interval, and the answer that ends the job is the same 200 bytes as without any', async () => {
    const { open, release } = latch();
    await serve(options({ runPipeline: fakeRun(async () => { await open; return RESULT; }), heartbeatMs: 20 }), async (api) => {
      const client = rawClient(api.port, { body: request });
      try {
        await until(() => client.response().interim >= 3, 'three interim lines have come');
        expect(client.response().status).toBeNull(); // no answer yet: the interim lines are all there is
        expect(client.received().toString('latin1')).toBe('HTTP/1.1 102 Processing\r\n\r\n'.repeat(client.response().interim));
        release();
        const answer = await client.answer();
        expect(answer.interim).toBeGreaterThanOrEqual(3);
        expect(answer.status).toBe(200);
        expect(answer.headers['content-type']).toBe('application/json');
        expect(answer.body!.equals(Buffer.from(JSON.stringify(RESULT), 'utf8'))).toBe(true);
        expect(answer.trailing).toBe(0);
      } finally {
        client.close();
      }
    });
  });

  test('fetch itself, the client of the runtime, reads past the interim lines and gets the answer whole', async () => {
    const run = fakeRun(async () => { await pause(150); return RESULT; });
    await serve(options({ runPipeline: run, heartbeatMs: 15 }), async (api) => {
      const r = await api.post(request); // about ten interim lines come before the answer
      expect(r.status).toBe(200);
      expect(r.text).toBe(JSON.stringify(RESULT));
    });
  });

  test('no 102 is written once the job has ended, whether it ended with an answer or with a failure', async () => {
    for (const outcome of ['answer', 'failure'] as const) {
      const { open, release } = latch();
      const run = fakeRun(async () => { await open; if (outcome === 'failure') throw new PipelineError('ocr_failed', 'page 1 failed'); return RESULT; });
      await serve(options({ runPipeline: run, heartbeatMs: 15 }), async (api) => {
        const client = rawClient(api.port, { body: request }); // keep-alive: the socket stays open after the answer, where a late line would show
        try {
          await until(() => client.response().interim >= 2, 'two interim lines have come');
          release();
          const answer = await client.answer();
          expect(answer.status, outcome).toBe(outcome === 'answer' ? 200 : 422);
          const settled = client.received().length;
          await pause(15 * 8); // eight intervals
          expect(client.received().length, outcome).toBe(settled);
          expect(client.response().trailing, outcome).toBe(0);
        } finally {
          client.close();
        }
      });
    }
  });

  test('a job that is quicker than the interval gets no 102 at all', async () => {
    await serve(options({ runPipeline: fakeRun(async () => RESULT), heartbeatMs: 5000 }), async (api) => {
      const client = rawClient(api.port, { body: request, close: true });
      try {
        const answer = await client.answer();
        expect(answer.interim).toBe(0);
        expect(answer.status).toBe(200);
      } finally {
        client.close();
      }
    });
  });

  test('a client that speaks HTTP/1.0 gets none: an interim line is for HTTP/1.1 clients', async () => {
    const { open, release } = latch();
    await serve(options({ runPipeline: fakeRun(async () => { await open; return RESULT; }), heartbeatMs: 15 }), async (api) => {
      const client = rawClient(api.port, { body: request, version: '1.0' });
      try {
        await pause(15 * 6);
        expect(client.received().length).toBe(0); // six intervals, not a byte
        release();
        const answer = await client.answer();
        expect(answer).toMatchObject({ interim: 0, status: 200 });
        expect(answer.body!.equals(Buffer.from(JSON.stringify(RESULT), 'utf8'))).toBe(true);
      } finally {
        client.close();
      }
    });
  });

  test('a 102 is skipped for a response whose headers are out or that is gone, and the timer is cleared with the slot', async () => {
    const { open, release } = latch();
    const run = fakeRun(async () => { await open; return RESULT; });
    const server = createServer(options({ runPipeline: run, heartbeatMs: 10 }));
    const req = makeRequest();
    const res = makeResponse();
    server.emit('request', req, res);
    req.emit('data', Buffer.from(request, 'utf8'));
    req.emit('end');
    await until(() => run.mock.calls.length === 1, 'the job is running');
    await until(() => res.writeProcessing.mock.calls.length >= 2, 'the interim lines are being written');
    const stays = async (why: string) => {
      const before = res.writeProcessing.mock.calls.length;
      await pause(60);
      expect(res.writeProcessing.mock.calls.length, why).toBe(before);
    };
    res.destroyed = true;
    await stays('the response is destroyed');
    res.destroyed = false;
    res.headersSent = true;
    await stays('the headers are out');
    res.headersSent = false;
    release();
    await until(() => res.end.mock.calls.length === 1, 'the answer is sent');
    await stays('the job has ended');
    server.close();
  });

  test('a write that throws does not take the process down: the socket is gone and the job goes on', async () => {
    const { open, release } = latch();
    const run = fakeRun(async () => { await open; return RESULT; });
    const server = createServer(options({ runPipeline: run, heartbeatMs: 10 }));
    const req = makeRequest();
    const res = makeResponse();
    res.writeProcessing = vi.fn(() => { throw new Error('write after end'); });
    server.emit('request', req, res);
    req.emit('data', Buffer.from(request, 'utf8'));
    req.emit('end');
    await until(() => res.writeProcessing.mock.calls.length >= 2, 'the interim lines have been tried');
    release();
    await until(() => res.end.mock.calls.length === 1, 'the answer is sent');
    expect(res.writeHead).toHaveBeenCalledWith(200, expect.anything());
    server.close();
  });

  test('with no option the interval is 60 s: one 102 is due after 60 s of a job, none before, and none after the job', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      const { open, release } = latch();
      const run = fakeRun(async () => { await open; return RESULT; });
      const server = createServer(options({ runPipeline: run }));
      const req = makeRequest();
      const res = makeResponse();
      server.emit('request', req, res);
      req.emit('data', Buffer.from(request, 'utf8'));
      req.emit('end');
      await until(() => run.mock.calls.length === 1, 'the job is running');
      vi.advanceTimersByTime(59_999);
      expect(res.writeProcessing).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(res.writeProcessing).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(60_000);
      expect(res.writeProcessing).toHaveBeenCalledTimes(2);
      release();
      await until(() => res.end.mock.calls.length === 1, 'the answer is sent');
      vi.advanceTimersByTime(600_000);
      expect(res.writeProcessing).toHaveBeenCalledTimes(2);
      server.close();
    } finally {
      vi.useRealTimers();
    }
  });

  test('the interval is an option that may not be longer than 60 s (the runtime gives up after 300 s of silence), or zero, or not a number', () => {
    expect(HEARTBEAT_MS).toBe(60_000);
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 60_001, 300_000]) expect(() => createServer(options({ heartbeatMs: bad })), String(bad)).toThrow(RangeError);
    createServer(options({ heartbeatMs: 60_000 })).close();
    createServer(options({ heartbeatMs: 1 })).close();
  });
});

describe('JobSlot and a service that is stopping', () => {
  test('one job holds the slot at a time; it is free again when the job releases it', () => {
    const slot = new JobSlot();
    expect(slot.busy).toBe(false);
    expect(slot.take()).toBe('taken');
    expect(slot.busy).toBe(true);
    expect(slot.take()).toBe('busy');
    slot.release();
    expect(slot.busy).toBe(false);
    expect(slot.take()).toBe('taken');
  });

  test('once draining, no job is taken; the job that holds the slot still releases it', () => {
    const slot = new JobSlot();
    expect(slot.take()).toBe('taken');
    slot.drain();
    expect(slot.take()).toBe('draining'); // draining outranks busy: it is the answer that will not change
    slot.release();
    expect(slot.busy).toBe(false);
    expect(slot.take()).toBe('draining');
  });

  test('a service that is stopping takes no new job: 503 shutting_down with a fixed text, and every other route answers as before', async () => {
    const slot = new JobSlot();
    const run = fakeRun();
    await serve(options({ slot, runPipeline: run }), async (api) => {
      expect((await api.post(wire(REQUEST))).status).toBe(200);
      slot.drain();
      const refused = await api.post(wire(REQUEST));
      expect(refused.status).toBe(503);
      expect(refused.json).toStrictEqual({ error: 'shutting_down', message: 'The service is stopping and takes no new job. Try again shortly.' });
      expect(run).toHaveBeenCalledTimes(1);
      expect((await api.get('/healthz')).status).toBe(200);
      expect((await api.get('/agent.json')).status).toBe(200);
      expect((await api.post('not json')).status).toBe(400); // a request that is no request is still refused as one
    });
    expect(logs.join('\n')).toMatch(/job refused: the service is stopping/);
  });

  test('a job that is running when the service starts to stop finishes and is answered', async () => {
    const slot = new JobSlot();
    let release!: () => void;
    const open = new Promise<void>((resolve) => { release = resolve; });
    const run = fakeRun(async () => { await open; return RESULT; });
    await serve(options({ slot, runPipeline: run }), async (api) => {
      const job = api.post(wire(REQUEST));
      await until(() => run.mock.calls.length === 1, 'the job is running');
      slot.drain();
      release();
      const done = await job;
      expect(done.status).toBe(200);
      expect(done.text).toBe(JSON.stringify(RESULT));
      expect(slot.busy).toBe(false);
    });
  });
});

describe('routes', () => {
  test('anything but GET /healthz, GET /agent.json and POST / is a 404', async () => {
    const run = fakeRun();
    await serve(options({ runPipeline: run }), async (api) => {
      for (const [method, path] of [['PUT', '/'], ['DELETE', '/'], ['GET', '/'], ['GET', '/nope'], ['GET', '/healthz/'], ['GET', '/healthz?x=1'], ['GET', '/agent.json/x'], ['POST', '/healthz'], ['POST', '/agent.json'], ['POST', '/v1/job'], ['POST', '/status'], ['POST', '/x'], ['HEAD', '/healthz'], ['OPTIONS', '/']] as const) {
        const r = await api.request(method, path, method === 'POST' ? wire(REQUEST) : undefined);
        expect(r.status, `${method} ${path}`).toBe(404);
        if (method !== 'HEAD') expect(r.json, `${method} ${path}`).toStrictEqual({ error: 'not_found' });
      }
    });
    expect(run).not.toHaveBeenCalled();
  });
});

// ---- R50: the service answers only the runtime --------------------------------------------------------------------------------------
// The service shares a network with other stacks, and a job spends from the buyer wallet, so a port nobody publishes is not enough. The template runtime
// (c4c378a, agent/src/executor/httpCallout.ts) sends the value of its SERVICE_AUTH_HEADER as the authorization header of every call to a custom service.
// POST / answers 401 to a call whose header is not exactly the value the service was given, before the body is read and before a job slot is taken.
// GET /healthz and GET /agent.json need no header: the image's health check sends none, and the manifest is public.
describe('POST /: the authorization header of the runtime (R50)', () => {
  const UNAUTHORIZED = { error: 'unauthorized' };
  const gate = () => { let release!: () => void; const open = new Promise<void>((resolve) => { release = resolve; }); return { open, release }; };

  test('a call without the header is a 401 {error: "unauthorized"}, nothing else in the body, the connection is closed, and no job starts', async () => {
    const run = fakeRun();
    await serve(options({ runPipeline: run }), async (api) => {
      const r = await api.request('POST', '/', wire(REQUEST), { authorization: null });
      expect(r.status).toBe(401);
      expect(r.text).toBe('{"error":"unauthorized"}'); // no message, no hint, no list of what would have worked
      expect(r.headers.get('content-type')).toBe('application/json');
      expect(r.headers.get('connection')).toBe('close');
      expect(r.headers.get('www-authenticate')).toBeNull();
    });
    expect(run).not.toHaveBeenCalled();
  });

  test('a call with another value is the same 401: another token, the token in another case or a character longer or shorter, a scheme alone, an empty value, a very long one', async () => {
    const run = fakeRun();
    const wrong = ['Bearer wrong', TEST_AUTH.toLowerCase(), TEST_AUTH.toUpperCase(), `${TEST_AUTH}0`, TEST_AUTH.slice(0, -1), TEST_AUTH.slice(7), `Bearer  ${TEST_AUTH.slice(7)}`, 'Bearer', '', 'x', 'x'.repeat(8000)];
    await serve(options({ runPipeline: run }), async (api) => {
      for (const value of wrong) {
        const r = await api.request('POST', '/', wire(REQUEST), { authorization: value });
        expect(r.status, `${value.length} characters`).toBe(401);
        expect(r.json).toStrictEqual(UNAUTHORIZED);
      }
      expect((await api.get('/healthz')).status).toBe(200); // a value of any length is refused, and none of them upset the server
    });
    expect(run).not.toHaveBeenCalled();
  });

  test('a call with the token is answered as it always was: the same 200, the same bytes', async () => {
    const run = fakeRun();
    await serve(options({ runPipeline: run }), async (api) => {
      const r = await api.post(wire(REQUEST));
      expect(r.status).toBe(200);
      expect(r.text).toBe(JSON.stringify(RESULT));
      expect(r.headers.get('content-type')).toBe('application/json');
      expect(r.headers.get('connection')).not.toBe('close');
    });
    expect(run).toHaveBeenCalledTimes(1);
  });

  test('the token is the one the server is given: the token of another server is a 401, its own is a 200', async () => {
    await serve(options({ authHeader: 'Bearer the-token-of-this-server' }), async (api) => {
      expect((await api.post(wire(REQUEST))).status).toBe(401); // TEST_AUTH, which `serve` sends unless told otherwise, is not this server's
      expect((await api.request('POST', '/', wire(REQUEST), { authorization: 'Bearer the-token-of-this-server' })).status).toBe(200);
    });
  });

  test('GET /healthz and GET /agent.json stay open: with the token, with another, with none, the answer is the same', async () => {
    await serve(options(), async (api) => {
      for (const authorization of [null, 'Bearer wrong', TEST_AUTH]) {
        const health = await api.request('GET', '/healthz', undefined, { authorization });
        expect(health.status, String(authorization)).toBe(200);
        expect(health.json).toStrictEqual({ ok: true });
        const manifest = await api.request('GET', '/agent.json', undefined, { authorization });
        expect(manifest.status, String(authorization)).toBe(200);
        expect(manifest.text).toBe(JSON.stringify(MANIFEST));
      }
    });
  });

  test('a route that is none of the three is a 404 for everyone: no 401 says that a route is there', async () => {
    await serve(options(), async (api) => {
      for (const [method, path] of [['POST', '/x'], ['POST', '/healthz'], ['POST', '/agent.json'], ['POST', '/v1/job'], ['GET', '/'], ['PUT', '/']] as const) {
        for (const authorization of [null, 'Bearer wrong', TEST_AUTH]) {
          const r = await api.request(method, path, method === 'POST' ? wire(REQUEST) : undefined, { authorization });
          expect(r.status, `${method} ${path} ${authorization}`).toBe(404);
          expect(r.json).toStrictEqual({ error: 'not_found' });
        }
      }
    });
  });

  test('the check comes before the body is read: a call without the token is answered while its upload is still under way, and the connection is closed', async () => {
    const run = fakeRun();
    await serve(options({ runPipeline: run }), async (api) => {
      const client = rawClient(api.port, { body: wire(REQUEST), holdBack: 5, authorization: null }); // the last 5 bytes of the body are never sent
      try {
        const answer = await client.answer(1500); // had the body to be read first, this would wait for bytes that do not come
        expect(answer.status).toBe(401);
        expect(JSON.parse(answer.body!.toString('utf8'))).toStrictEqual(UNAUTHORIZED);
        expect(answer.headers.connection).toBe('close');
      } finally {
        client.close();
      }
    });
    expect(run).not.toHaveBeenCalled();
  });

  test('a call without the token does not take the slot: a job that runs is not disturbed, the answer is a 401 and not a 409 that would tell a stranger a job is running, and the slot is free when the job ends', async () => {
    const { open, release } = gate();
    const slot = new JobSlot();
    const run = fakeRun(async () => { await open; return RESULT; });
    await serve(options({ runPipeline: run, slot }), async (api) => {
      expect((await api.request('POST', '/', wire(REQUEST), { authorization: null })).status).toBe(401);
      expect(slot.busy).toBe(false); // idle: a refused call leaves the slot as it was
      const first = api.post(wire(REQUEST));
      await until(() => run.mock.calls.length === 1, 'the first job is running');
      expect(slot.busy).toBe(true);
      const refused = await api.request('POST', '/', wire(REQUEST), { authorization: 'Bearer wrong' });
      expect(refused.status).toBe(401);
      expect(refused.json).toStrictEqual(UNAUTHORIZED);
      expect(slot.busy).toBe(true); // still the first job's
      release();
      expect((await first).status).toBe(200);
      expect(slot.busy).toBe(false);
    });
    expect(run).toHaveBeenCalledTimes(1);
  });

  test('a service that is stopping answers a call without the token with 401 and a call with it with 503 shutting_down', async () => {
    const slot = new JobSlot();
    slot.drain();
    await serve(options({ slot }), async (api) => {
      expect((await api.request('POST', '/', wire(REQUEST), { authorization: null })).status).toBe(401);
      const stopping = await api.post(wire(REQUEST));
      expect(stopping.status).toBe(503);
      expect(stopping.json.error).toBe('shutting_down');
    });
  });

  test('the token is never echoed: not in the answer, not in a header of it, not in the log; nor is what the caller sent', async () => {
    const presented = 'Bearer presented-by-a-stranger-9f3c1e';
    await serve(options(), async (api) => {
      const r = await api.request('POST', '/', wire(REQUEST), { authorization: presented });
      const everything = `${r.text}\n${JSON.stringify([...r.headers.entries()])}`;
      for (const secret of [TEST_AUTH, TEST_AUTH.slice(7), presented, presented.slice(7)]) expect(everything).not.toContain(secret);
    });
    const written = logs.join('\n');
    for (const secret of [TEST_AUTH, TEST_AUTH.slice(7), presented, presented.slice(7)]) expect(written).not.toContain(secret);
    expect(logs.filter((line) => /^request refused: unauthorized \(1 since the last line of this kind\)$/.test(line))).toHaveLength(1);
  });

  test('a refusal is logged once a minute at most, with the count since the last line, so that a caller that cannot authenticate cannot fill the log', async () => {
    let now = T0;
    await serve(options({ deps: baseDeps({ clock: () => now }) }), async (api) => {
      const refuse = () => api.request('POST', '/', wire(REQUEST), { authorization: null });
      const lines = () => logs.filter((line) => line.startsWith('request refused: unauthorized'));
      for (let i = 0; i < 5; i++) await refuse();
      expect(lines()).toStrictEqual(['request refused: unauthorized (1 since the last line of this kind)']);
      now += 59_999;
      await refuse();
      expect(lines()).toHaveLength(1);
      now += 1;
      await refuse(); // 60 s after the first line: the next one, counting the five that were not logged and this one
      expect(lines()).toStrictEqual(['request refused: unauthorized (1 since the last line of this kind)', 'request refused: unauthorized (6 since the last line of this kind)']);
      now -= 1_000_000; // a clock that was set back does not silence the log for good
      await refuse();
      expect(lines()).toHaveLength(3);
    });
  });

  test('a server cannot be made without a token, so that a service is never open by mistake', () => {
    for (const bad of ['', undefined as unknown as string, null as unknown as string]) expect(() => createServer(options({ authHeader: bad })), String(bad)).toThrow(RangeError);
    createServer(options({ authHeader: 'x' })).close();
  });

  test('the comparison is of two sha256 digests, which are of equal length whatever the values are, with timingSafeEqual; it is not a comparison of the strings', () => {
    const source = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');
    expect(source).toMatch(/timingSafeEqual\(/);
    expect(source).toMatch(/createHash\('sha256'\)/);
    expect(source).not.toMatch(/authorization\s*(===|!==|==|!=)|(===|!==|==|!=)\s*[\w.]*authHeader/);
  });
});

// ---- GET /healthz -------------------------------------------------------------------------------------------------------------------
describe('GET /healthz', () => {
  const wallet = (float: bigint, collateral: bigint | null = 5_000_000n) => async () => ({ address: 'addr', buyerPkh: 'pkh', collateralLovelace: collateral, floatLovelace: float });
  const FAILED = { ok: false, reason: 'insufficient_float' };

  test('is ok while the wallet can fund a default job: a float of (max_pages + 1) x 4500000 lovelace outside a collateral output', async () => {
    const cases: Array<[bigint, bigint | null, number]> = [[27_000_000n, 5_000_000n, 200], [26_999_999n, 5_000_000n, 503], [50_000_000n, null, 503], [0n, 5_000_000n, 503], [900_000_000n, 5_000_000n, 200]];
    for (const [floatLovelace, collateralLovelace, status] of cases) {
      const chain = new FakeChain({ floatLovelace, collateralLovelace });
      await serve(options({ deps: baseDeps({ chain }) }), async (api) => {
        await settle(); // the first check runs at start, in the background
        const r = await api.get('/healthz');
        expect(r.status, `${floatLovelace} ${collateralLovelace}`).toBe(status);
        expect(r.json).toStrictEqual(status === 200 ? { ok: true } : FAILED);
        expect(r.headers.get('content-type')).toBe('application/json');
      });
    }
  });

  test('a wallet that cannot be read is not ok either, and the answer carries no detail of the failure', async () => {
    const chain = walletChain(async () => { throw new Error('Ogmios network error at https://ogmios.example.test/secret-path'); });
    await serve(options({ deps: baseDeps({ chain }) }), async (api) => {
      await settle();
      const r = await api.get('/healthz');
      expect(r).toMatchObject({ status: 503, json: FAILED });
      expect(r.text).not.toContain('ogmios');
    });
  });

  test('is ok before the first check has answered, and the check is never waited for', async () => {
    const chain = walletChain(() => new Promise(() => {})); // never answers
    await serve(options({ deps: baseDeps({ chain }), floatTimeoutMs: 60_000 }), async (api) => {
      const started = Date.now();
      expect(await api.get('/healthz')).toMatchObject({ status: 200, json: { ok: true } });
      expect(Date.now() - started).toBeLessThan(1000);
    });
  });

  test('a check is good for 60 s: a request after that gets the old answer at once and starts a new check in the background, which the next request sees', async () => {
    const t = { now: T0 };
    let float = 1_000_000n;
    let reads = 0;
    const chain = walletChain(async () => { reads += 1; return wallet(float)(); });
    await serve(options({ deps: baseDeps({ chain, clock: () => t.now }) }), async (api) => {
      await settle();
      expect(reads).toBe(1);
      expect((await api.get('/healthz')).status).toBe(503);
      float = 100_000_000n; // funded in the meantime
      t.now += 59_999;
      expect((await api.get('/healthz')).status).toBe(503);
      expect(reads).toBe(1); // still inside the minute: no new read
      t.now += 1;
      expect((await api.get('/healthz')).status).toBe(503); // the old answer, given at once
      expect(reads).toBe(2); // and the check for the next one is under way
      await settle();
      expect(await api.get('/healthz')).toMatchObject({ status: 200, json: { ok: true } });
      expect(reads).toBe(2);
      float = 1_000_000n; // spent again
      t.now += 60_000;
      await api.get('/healthz');
      await settle();
      expect((await api.get('/healthz')).status).toBe(503);
      expect(reads).toBe(3);
    });
  });

  test('an answer is not kept fresh by a clock that was set back: the next request starts a new check', async () => {
    const t = { now: T0 + 3_600_000 };
    let reads = 0;
    const chain = walletChain(async () => { reads += 1; return wallet(100_000_000n)(); });
    await serve(options({ deps: baseDeps({ chain, clock: () => t.now }) }), async (api) => {
      await settle();
      expect(reads).toBe(1);
      t.now = T0; // an hour earlier than the check was made
      await api.get('/healthz');
      expect(reads).toBe(2);
    });
  });

  test('only one check runs at a time, however many requests come', async () => {
    const t = { now: T0 };
    let reads = 0;
    let release!: () => void;
    const chain = walletChain(() => { reads += 1; return new Promise((resolve) => { release = () => resolve({ address: 'a', buyerPkh: 'b', collateralLovelace: 5_000_000n, floatLovelace: 100_000_000n }); }); });
    await serve(options({ deps: baseDeps({ chain, clock: () => t.now }), floatTimeoutMs: 60_000 }), async (api) => {
      t.now += 600_000;
      await Promise.all(Array.from({ length: 10 }, () => api.get('/healthz')));
      expect(reads).toBe(1);
      release();
      await settle();
      await api.get('/healthz');
      expect(reads).toBe(1);
    });
  });

  test('a check that never answers is cut off at the timeout and counts as failed, and the TTL starts a new one', async () => {
    const t = { now: T0 };
    let reads = 0;
    const chain = walletChain(() => { reads += 1; return new Promise(() => {}); });
    await serve(options({ deps: baseDeps({ chain, clock: () => t.now }), floatTimeoutMs: 30 }), async (api) => {
      expect((await api.get('/healthz')).status).toBe(200); // nothing is known yet
      const end = Date.now() + 3000;
      let status = 200;
      while (status === 200 && Date.now() < end) { await new Promise((resolve) => setTimeout(resolve, 10)); status = (await api.get('/healthz')).status; }
      expect(status).toBe(503);
      expect(reads).toBe(1);
      t.now += 60_000;
      await api.get('/healthz');
      expect(reads).toBe(2); // the first check is still pending forever, and does not hold the second back
    });
  });

  test('a change of state is logged once, with its reason, and a repeat is not', async () => {
    const t = { now: T0 };
    let float = 1_000_000n;
    const chain = walletChain(async () => wallet(float)());
    await serve(options({ deps: baseDeps({ chain, clock: () => t.now }) }), async (api) => {
      await settle();
      for (let i = 0; i < 3; i++) { t.now += 60_000; await api.get('/healthz'); await settle(); }
      const failed = logs.filter((l) => /wallet check failed/.test(l));
      expect(failed).toHaveLength(1);
      expect(failed[0]).toMatch(/insufficient|float|lovelace/i);
      float = 100_000_000n;
      t.now += 60_000; await api.get('/healthz'); await settle();
      t.now += 60_000; await api.get('/healthz'); await settle();
      expect(logs.filter((l) => /wallet check passed again/.test(l))).toHaveLength(1);
    });
  });
});

// ---- The real pipeline behind the service -------------------------------------------------------------------------------------------
describe('the real pipeline over HTTP', () => {
  const TWO_PAGES = { source: { pdf_b64: toBase64(TWO_PAGES_PDF), mime: 'application/pdf' }, task: 'summary', language: 'en', max_pages: 5 };
  /** The deps of a run on the marketplace of test/stub-suppliers.ts, on its clock. */
  function depsOn(m: ReturnType<typeof marketplace>): Omit<Deps, 'deadlineMs'> {
    return baseDeps({
      chain: m.chain, fetchImpl: m.fetchImpl, renderer: fakeRenderer({ total: 2 }), clock: () => m.clock.now, sleep: async (ms) => { m.clock.now += ms; },
      ocrAllowlistPkh: m.ocr.key.pkh, llmAllowlist: ALLOWLIST, indexerUrl: INDEXER,
    });
  }

  test('a two-page document: 200 with the bytes of the result the pipeline gives, three sub-jobs, every escrow settled', async () => {
    const direct = marketplace();
    const expected = await runPipeline(parseRequest(JSON.stringify(TWO_PAGES)), { ...depsOn(direct), deadlineMs: T0 + JOB_DEADLINE_MS });
    const served = marketplace();
    await serve(options({ deps: depsOn(served), runPipeline }), async (api) => {
      const r = await api.post(wire(TWO_PAGES));
      expect(r.status).toBe(200);
      expect(r.text).toBe(JSON.stringify(expected));
      expect(r.json.accounting).toStrictEqual({ sub_jobs: 3, locked_total_lovelace: '6783090', fees_total_lovelace: '3000000' });
      expect(r.json.result).toStrictEqual({ summary: SUMMARY });
      expect(r.json.source.pages).toBe(2);
      expect(r.json.pages.map((p: { text: string }) => p.text)).toStrictEqual(['Page one of the test document.', 'Page two of the test document.']);
    });
    expect(logs.join('\n')).toMatch(/job done.*3 sub-jobs/);
  });

  test('a wallet that cannot fund the job: 503 insufficient_float, and nothing was posted', async () => {
    const m = marketplace({ floatLovelace: 1_000_000n });
    await serve(options({ deps: depsOn(m), runPipeline }), async (api) => {
      const r = await api.post(wire(TWO_PAGES));
      expect(r.status).toBe(503);
      expect(r.json).toStrictEqual({ error: 'insufficient_float', message: "The service could not do this job (insufficient_float). The operator's log has the detail." });
    });
    expect(logs.join('\n')).toMatch(/job failed after \d+ ms: insufficient_float \(503\): .*Nothing was spent/); // the detail is the operator's
    expect(m.calls.filter((c) => c.method === 'POST')).toStrictEqual([]);
  });

  test('a source the fetch refuses is a 422 from the intake, and a schema the extraction refuses is a 400, both before anything is spent', async () => {
    const m = marketplace();
    await serve(options({ deps: depsOn(m), runPipeline }), async (api) => {
      const http = await api.post(wire({ source: { url: 'http://example.org/letter.pdf' }, task: 'summary' }));
      expect(http).toMatchObject({ status: 422, json: { error: 'source_fetch_failed' } });
      const ref = await api.post(wire({ source: { url: 'https://example.org/letter.pdf' }, task: 'extract', schema: { $ref: '#/definitions/x' } }));
      expect(ref).toMatchObject({ status: 400, json: { error: 'schema_invalid' } });
    });
    expect(m.calls).toStrictEqual([]);
    expect((await m.chain.wallet()).floatLovelace).toBe(50_000_000n);
  });
});
