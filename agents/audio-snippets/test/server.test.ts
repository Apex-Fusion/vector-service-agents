// agents/audio-snippets/test/server.test.ts
// The manifest the service publishes and what is the service's own on the HTTP surface of packages/service-kit: the request schema held to the intake, the
// refusals of the intake and of a job with their statuses, the disk check of /healthz, the deadline set on arrival, the log of a job, and one real job over
// HTTP. The generic behaviour of the surface (the token, the slot, the heartbeat, the routes, the body cap) is tested in packages/service-kit.
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { connect } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import { afterEach, describe, test, expect, vi } from 'vitest';
import { REGISTRY_ADDRESS } from '@vsa/vector-read';
import { workerAsr } from '../src/asr.ts';
import type { Asr } from '../src/asr.ts';
import { ASR_MAX_MS, JOB_DEADLINE_MS } from '../src/budget.ts';
import { INLINE_CLIPS_BYTES } from '../src/clips.ts';
import { CLIPS_GAP, DEADLINE_GAP, LANGUAGE_GAP, LIMITS_GAP, QUERY_GAP, QUOTE_GAP, gapsFor, modelGap } from '../src/gaps.ts';
import { WHISPER_LANGUAGES } from '../src/languages.ts';
import { MAX_DURATION_S, MAX_SOURCE_BYTES } from '../src/media.ts';
import { DEFAULT_LANGUAGE, MAX_INLINE_BYTES, MAX_QUERY_CHARS, MAX_QUOTES, MAX_QUOTE_CHARS, MAX_RANGES, MIMES, RequestError, parseRequest } from '../src/request.ts';
import { SnippetsError } from '../src/result.ts';
import type { RunDeps } from '../src/run.ts';
import { DISK_TIMEOUT_MS, DISK_TTL_MS, JobSlot, MIN_PROCESSING_WINDOW_MS, TEMPLATE_ENV, manifestFromEnv, renderTemplate } from '../src/server.ts';
import type { ServerOptions } from '../src/server.ts';
import { GOLDEN_REQUEST, GOLDEN_RESULT } from './golden.ts';
import { FULL_ENV, SUPPLIER, T0, TEST_AUTH, TEST_CONTACT, baseDeps, cleanDirs, serve, until, wire } from './server-support.ts';
import { MEDIA_TOOLS, TONE_WAV, text, toBase64 } from './support.ts';

afterEach(() => { cleanDirs(); vi.restoreAllMocks(); });

// The ledger's native unit is named once in the repository, in docs/HIRE.md. Spelled in two parts, so that a search for the name finds only the guide.
const UNIT_NAME = new RegExp('AP' + '3X', 'i');
const MANIFEST = manifestFromEnv(FULL_ENV);
const SPEC_URL = 'https://github.com/Apex-Fusion/vector-service-agents/blob/main/specs/audio-snippets.md';
const logs: string[] = [];
const log = (line: string): void => { logs.push(line); };
afterEach(() => { logs.length = 0; });
type Run = NonNullable<ServerOptions['runSnippets']>;
const options = (over: Partial<ServerOptions> = {}): Omit<ServerOptions, 'authHeader'> => ({ manifest: MANIFEST, deps: baseDeps(), log, ...over });

describe('manifest', () => {
  test('a full environment gives every field of the manifest, in the order the design gives them', () => {
    expect(Object.keys(MANIFEST)).toStrictEqual(['schema', 'name', 'capability_id', 'version', 'description', 'operator', 'identity', 'keys', 'interface', 'terms', 'behaviour', 'status', 'gaps', 'links']);
    expect(MANIFEST).toStrictEqual({
      schema: 'vector.agent-manifest.v1',
      name: 'Audio Snippets',
      capability_id: 'audio.transcript.snippets.v1',
      version: '0.1.0',
      description: 'A word-timed transcript of an audio or video file, plus the cut points for the quotes or the question you give it, and optionally the cut clips.',
      operator: { name: 'Apex Fusion Foundation', contact: TEST_CONTACT },
      identity: { did: 'did:test', controller_pkh: SUPPLIER.pkh, registry_address: REGISTRY_ADDRESS },
      keys: { supplier_pkh: SUPPLIER.pkh, pub_key_hex: SUPPLIER.pubKeyHex },
      interface: {
        request_schema: MANIFEST.interface.request_schema, // held against the intake below
        response_schema: { $ref: `${SPEC_URL}#response` },
        routes: { job: '/v1/job', status: '/status', capability: '/capability' },
        notes: MANIFEST.interface.notes, // held against the code below
      },
      terms: {
        price_lovelace: 2_000_000, supplier_bond_lovelace: 1_000_000, buyer_bond_lovelace: 1_000_000, max_processing_ms: 1_500_000,
        input_limits: { request_bytes: 900_000, source_bytes: 52_428_800, inline_media_bytes: 600_000, duration_s: 600, query_chars: 500, quotes: 20, quote_chars: 300, ranges: 20, inline_clip_bytes: 2_000_000 },
      },
      behaviour: {
        data_handling: 'The media, the language, the query, the quotes and the ranges are held in memory while a job runs; the media is also written to a private temporary directory, with its decode to 16 kHz WAV and each clip while it is cut, and the directory is removed when the job ends. '
          + 'The speech model runs in the service from files built into its image, so nothing leaves but the fetch of the media from the host of its URL. On the ledger the escrow carries only the sha256 of the wire payload, and the media stays off the ledger. '
          + 'The log carries job outcomes, never a request, a transcript or the media.',
        third_parties: ['the host of the source URL'],
      },
      status: { chip: 'proposed', since: '2026-10-13' },
      gaps: [...gapsFor('base')],
      links: { spec: SPEC_URL, source: 'https://github.com/Apex-Fusion/vector-service-agents/tree/main/agents/audio-snippets', explorer_advert: '' },
    });
  });

  test('the limits are the numbers the code enforces, read from it, and the window holds the deadline and the runtime timeout', () => {
    expect(MANIFEST.terms.input_limits).toStrictEqual({
      request_bytes: 900_000, source_bytes: MAX_SOURCE_BYTES, inline_media_bytes: MAX_INLINE_BYTES, duration_s: MAX_DURATION_S, query_chars: MAX_QUERY_CHARS,
      quotes: MAX_QUOTES, quote_chars: MAX_QUOTE_CHARS, ranges: MAX_RANGES, inline_clip_bytes: INLINE_CLIPS_BYTES,
    });
    expect(MIN_PROCESSING_WINDOW_MS).toBe(1_500_000);
    // The runtime refuses to boot unless its timeout is at least 60 s inside the window, and the deadline of a job is 60 s inside the timeout.
    expect(JOB_DEADLINE_MS + 60_000).toBe(1_380_000);
    expect(1_380_000).toBeLessThanOrEqual(MIN_PROCESSING_WINDOW_MS - 60_000);
  });

  test('without the identity the keys are empty strings, and the supplier key hash is both controller and supplier', () => {
    expect(manifestFromEnv({ OPERATOR_CONTACT: TEST_CONTACT }).keys).toStrictEqual({ supplier_pkh: '', pub_key_hex: '' });
    const m = manifestFromEnv({ ...FULL_ENV, SUPPLIER_PKH: 'ab'.repeat(28), AGENT_DID: 'did:vector:agent:x:y' });
    expect([m.identity.did, m.identity.controller_pkh, m.keys.supplier_pkh]).toStrictEqual(['did:vector:agent:x:y', 'ab'.repeat(28), 'ab'.repeat(28)]);
  });

  test('agent.json.template is the manifest with a placeholder for each of the four fields the operator supplies, byte for byte what renderTemplate prints', () => {
    const file = readFileSync(new URL('../agent.json.template', import.meta.url), 'utf8');
    expect(JSON.parse(file)).toStrictEqual(manifestFromEnv(TEMPLATE_ENV));
    expect(file).toBe(renderTemplate());
    expect(file.endsWith('}\n')).toBe(true);
    expect(file).not.toContain('\r');
    expect(file.match(/<[A-Z_]+>/g)?.sort()).toStrictEqual(['<AGENT_DID>', '<OPERATOR_CONTACT>', '<SUPPLIER_PKH>', '<SUPPLIER_PKH>', '<SUPPLIER_PUB_KEY_HEX>']);
    expect(/^[\x20-\x7e\n]*$/.test(file)).toBe(true);
  });

  test('GET /agent.json serves exactly the bytes JSON.stringify gives for the manifest', async () => {
    await serve(options(), async (api) => {
      const r = await api.get('/agent.json');
      expect([r.status, r.headers.get('content-type'), r.text]).toStrictEqual([200, 'application/json', JSON.stringify(MANIFEST)]);
    });
  });

  test('OPERATOR_CONTACT is required, and no address is built into the code', () => {
    for (const v of [undefined, '', ' ']) expect(() => manifestFromEnv(v === undefined ? {} : { OPERATOR_CONTACT: v }), JSON.stringify(v)).toThrow(/^environment variable OPERATOR_CONTACT is required/);
    expect(JSON.stringify(manifestFromEnv({ OPERATOR_CONTACT: 'a role' }))).not.toMatch(/@/);
    for (const file of ['server.ts', 'start.ts', 'gaps.ts', 'index.ts', 'model.ts']) expect(readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8'), file).not.toMatch(/[A-Za-z0-9._-]+@[A-Za-z0-9-]+\.[A-Za-z]/);
  });

  test('defaults: proposed since 2026-10-13, price 2 units, both bonds 1 unit, a 25 min window; a smaller window is refused, a larger one is used', () => {
    const m = manifestFromEnv({ OPERATOR_CONTACT: TEST_CONTACT });
    expect([m.status, m.terms.price_lovelace, m.terms.max_processing_ms]).toStrictEqual([{ chip: 'proposed', since: '2026-10-13' }, 2_000_000, 1_500_000]);
    for (const bad of ['0', '300000', '1499999']) {
      expect(() => manifestFromEnv({ OPERATOR_CONTACT: TEST_CONTACT, ADVERT_MAX_PROCESSING_MS: bad }), bad).toThrow(/^environment variable ADVERT_MAX_PROCESSING_MS must be at least 1500000 \(the window of 25 min that the deadline of a job, 1320000 ms, assumes\), got \d+$/);
    }
    expect(manifestFromEnv({ OPERATOR_CONTACT: TEST_CONTACT, ADVERT_MAX_PROCESSING_MS: '1800000', ADVERT_PRICE_LOVELACE: '3000000' }).terms).toMatchObject({ price_lovelace: 3_000_000, max_processing_ms: 1_800_000 });
    for (const bad of ['two', '-1', '1.5']) expect(() => manifestFromEnv({ OPERATOR_CONTACT: TEST_CONTACT, ADVERT_PRICE_LOVELACE: bad }), bad).toThrow(/ADVERT_PRICE_LOVELACE/);
  });

  test('AGENT_STATUS_CHIP: live, deployed or proposed in any case, carried in lower case, proposed by default; AGENT_STATUS_SINCE a date, 2026-10-13 by default', () => {
    const chip = (value?: string) => manifestFromEnv({ OPERATOR_CONTACT: TEST_CONTACT, ...(value === undefined ? {} : { AGENT_STATUS_CHIP: value }) }).status.chip;
    expect([chip(), chip(''), chip('Deployed'), chip('LIVE'), chip('proposed')]).toStrictEqual(['proposed', 'proposed', 'deployed', 'live', 'proposed']);
    for (const bad of ['built', 'proposed ', 'up']) expect(() => chip(bad), bad).toThrow(/AGENT_STATUS_CHIP/);
    expect(manifestFromEnv({ OPERATOR_CONTACT: TEST_CONTACT, AGENT_STATUS_SINCE: '2026-11-02' }).status.since).toBe('2026-11-02');
    for (const bad of ['yesterday', '2026-10-1']) expect(() => manifestFromEnv({ OPERATOR_CONTACT: TEST_CONTACT, AGENT_STATUS_SINCE: bad }), bad).toThrow(/AGENT_STATUS_SINCE/);
  });

  test('the gaps: seven sentences in order, each one line of plain text, the second naming the model of WHISPER_MODEL', () => {
    expect(gapsFor('base')).toStrictEqual([LIMITS_GAP, modelGap('base'), LANGUAGE_GAP, QUERY_GAP, QUOTE_GAP, CLIPS_GAP, DEADLINE_GAP]);
    expect(manifestFromEnv({ OPERATOR_CONTACT: TEST_CONTACT, WHISPER_MODEL: 'small' }).gaps[1]).toBe(modelGap('small'));
    expect(() => manifestFromEnv({ OPERATOR_CONTACT: TEST_CONTACT, WHISPER_MODEL: 'large' })).toThrow(/^environment variable WHISPER_MODEL must be one of base, small, got "large"$/);
    expect(LIMITS_GAP).toBe('At most 10 min and 50 MB per file, and one of query, quotes, ranges is required.');
    expect(modelGap('base')).toContain('faster-whisper base int8 on CPU');
    expect(QUOTE_GAP).toBe('A quote is matched once: a quote said twice gives one match, where it is said first.');
    expect(CLIPS_GAP).toContain(`${INLINE_CLIPS_BYTES} bytes`);
    expect(DEADLINE_GAP).toContain(`${JOB_DEADLINE_MS} ms after its request arrives`);
    expect(DEADLINE_GAP).toContain(`at most ${ASR_MAX_MS} ms of it`);
    for (const gap of gapsFor('small')) {
      expect(gap).toMatch(/^[A-Za-z0-9].*\.$/);
      expect(gap).not.toMatch(/[\r\n\u{2013}\u{2014}]/u);
      expect(gap).not.toMatch(UNIT_NAME);
    }
  });

  test('the notes say what the schema cannot: a letter or digit in each text, a range that starts before it ends, the languages of the model, the rules of a source URL', () => {
    const notes = MANIFEST.interface.notes;
    expect(notes).toHaveLength(3);
    expect(notes[0]).toBe('A quote and the query must each hold at least one letter or digit, and a range must start before it ends; a range that ends after the media is refused with range_out_of_media (422) once the media is read.');
    expect(notes[1]).toBe(`The language is auto, or a code whose first part is one of the 100 the speech model knows: ${WHISPER_LANGUAGES.join(', ')}. Any other is refused with language_unsupported (400).`);
    expect(notes[2]).toContain(`at most ${MAX_SOURCE_BYTES} bytes`);
    for (const note of notes) expect(note).not.toMatch(/[\r\n]/);
  });
});

describe('manifest: request_schema is what the intake accepts', () => {
  const schema = MANIFEST.interface.request_schema;
  const validate = new Ajv({ strict: true, allErrors: true }).compile(schema);
  const intake = (value: unknown): boolean => {
    try { parseRequest(JSON.stringify(value)); return true; } catch (e) { if (e instanceof RequestError) return false; throw e; }
  };
  const b64 = (bytes: number): string => Buffer.alloc(bytes, 7).toString('base64');
  const url = { url: 'https://example.org/talk.mp3' };
  const inline = (data = b64(10), mime = 'audio/mpeg') => ({ audio_b64: data, mime });
  const req = (over: Record<string, unknown> = {}) => ({ source: url, quotes: ['a quote'], ...over });
  const CASES: Array<[string, unknown]> = [
    // the shapes the spec shows
    ['the example of the spec', { source: { url: 'https://example.org/talk.mp3' }, language: 'en', quotes: ['a quote that was said in the talk'], ranges: [{ start_s: 12.0, end_s: 20.5 }], return_clips: false }],
    ['a url and a quote', req()],
    ['a query alone', { source: url, query: 'where is the public domain mentioned' }],
    ['a range alone', { source: url, ranges: [{ start_s: 0, end_s: 1 }] }],
    ['all three', req({ query: 'a question', ranges: [{ start_s: 1, end_s: 2.5 }] })],
    ['clips as mp3', req({ return_clips: true, clip_format: 'mp3' })],
    ['clips as wav', req({ return_clips: true, clip_format: 'wav' })],
    ['clips in the default format', req({ return_clips: true })],
    ['no clips, said so', req({ return_clips: false })],
    ...MIMES.map((mime): [string, unknown] => [`inline ${mime}`, req({ source: inline(b64(10), mime) })]),
    // nothing to find, and the clip format without clips
    ['nothing to find', { source: url }],
    ['nothing to find, with clips', { source: url, return_clips: true }],
    ['a clip format without clips', req({ clip_format: 'wav' })],
    ['a clip format with clips false', req({ return_clips: false, clip_format: 'mp3' })],
    ['an unknown clip format', req({ return_clips: true, clip_format: 'ogg' })],
    ['return_clips as text', req({ return_clips: 'true' })],
    // the object itself
    ['an unknown key', req({ extra: 1 })],
    ['no source', { quotes: ['a quote'] }],
    ['an array', []],
    ['null', null],
    ['text', 'a request'],
    // the source
    ['an empty source', req({ source: {} })],
    ['an empty url', req({ source: { url: '' } })],
    ['a url that is a number', req({ source: { url: 5 } })],
    ['a url with another key', req({ source: { url: 'https://example.org/a.mp3', mime: 'audio/mpeg' } })],
    ['inline without a mime', req({ source: { audio_b64: b64(10) } })],
    ['inline with a mime of no list', req({ source: inline(b64(10), 'audio/aac') })],
    ['inline with an extra key', req({ source: { ...inline(), extra: 1 } })],
    ['a url and inline together', req({ source: { ...url, ...inline() } })],
    ['600000 raw bytes', req({ source: inline(b64(600_000)) })],
    ['599999 raw bytes', req({ source: inline(b64(599_999)) })],
    ['600001 raw bytes', req({ source: inline(b64(600_001)) })],
    ['unpadded base64', req({ source: inline('QUJD' + 'RA') })],
    ['base64 with a line break', req({ source: inline('QUJD\nRA==') })],
    ['url-safe base64', req({ source: inline('QUJD-A==') })],
    ['an empty audio_b64', req({ source: inline('') })],
    // the texts
    ['a query of 500 characters', { source: url, query: 'q'.repeat(500) }],
    ['a query of 501 characters', { source: url, query: 'q'.repeat(501) }],
    ['an empty query', { source: url, query: '' }],
    ['a query that is a number', { source: url, query: 5 }],
    ['20 quotes', req({ quotes: Array.from({ length: 20 }, (_v, i) => `quote ${i}`) })],
    ['21 quotes', req({ quotes: Array.from({ length: 21 }, (_v, i) => `quote ${i}`) })],
    ['no quotes in the list', req({ quotes: [] })],
    ['a quote of 300 characters', req({ quotes: ['a'.repeat(300)] })],
    ['a quote of 301 characters', req({ quotes: ['a'.repeat(301)] })],
    ['a quote of 300 characters outside the BMP', req({ quotes: ['\u{1F600}'.repeat(299) + 'a'] })],
    ['an empty quote', req({ quotes: [''] })],
    ['a quote that is a number', req({ quotes: [5] })],
    ['quotes that are text', req({ quotes: 'a quote' })],
    // the ranges
    ['20 ranges', { source: url, ranges: Array.from({ length: 20 }, (_v, i) => ({ start_s: i, end_s: i + 1 })) }],
    ['21 ranges', { source: url, ranges: Array.from({ length: 21 }, (_v, i) => ({ start_s: i, end_s: i + 1 })) }],
    ['no ranges in the list', { source: url, ranges: [] }],
    ['a range that starts below 0', { source: url, ranges: [{ start_s: -1, end_s: 1 }] }],
    ['a range that ends at 0', { source: url, ranges: [{ start_s: 0, end_s: 0 }] }],
    ['a range without an end', { source: url, ranges: [{ start_s: 0 }] }],
    ['a range with another key', { source: url, ranges: [{ start_s: 0, end_s: 1, label: 'x' }] }],
    ['a range of text', { source: url, ranges: [{ start_s: '0', end_s: '1' }] }],
    ['a range that is a list', { source: url, ranges: [[0, 1]] }],
    // the language
    ...['en', 'EN', 'de', 'hr', 'en-GB', 'zh-Hant-TW', 'es-419', 'auto', 'AUTO', 'Auto', 'yue', 'haw'].map((l): [string, unknown] => [`language ${l}`, req({ language: l })]),
    ...['', 'e', 'abcdefghi', 'en_GB', '1en', 'en-', ' en', 'en\n', 'auto\n', 5, null].map((l): [string, unknown] => [`language ${JSON.stringify(l)}`, req({ language: l })]),
  ];

  test('the schema compiles in strict mode, and its defaults are the intake\'s', () => {
    expect(schema).toMatchObject({ type: 'object', required: ['source'], additionalProperties: false });
    expect(Object.keys(schema.properties)).toStrictEqual(['source', 'language', 'query', 'quotes', 'ranges', 'return_clips', 'clip_format']);
    expect(schema.properties.language.default).toBe(DEFAULT_LANGUAGE);
    expect(parseRequest(JSON.stringify(req()))).toMatchObject({ language: schema.properties.language.default, return_clips: schema.properties.return_clips.default, clip_format: schema.properties.clip_format.default });
  });

  test.each(CASES)('agrees with parseRequest on: %s', (_label, value) => {
    expect(validate(JSON.parse(JSON.stringify(value))), JSON.stringify(validate.errors)).toBe(intake(value));
  });

  test('the table has both answers in good number, so agreement is not agreement about nothing', () => {
    const accepted = CASES.filter(([, value]) => intake(value)).length;
    expect(accepted).toBeGreaterThan(25);
    expect(CASES.length - accepted).toBeGreaterThan(40);
  });

  test('what the notes say and a schema cannot: the intake refuses these, and the schema lets them through', () => {
    for (const [value, code] of [
      [req({ quotes: ['...'] }), 'bad_shape'], [{ source: url, query: '?!' }, 'bad_shape'], [{ source: url, ranges: [{ start_s: 2, end_s: 1 }] }, 'range_bad'],
      [req({ language: 'xx' }), 'language_unsupported'], [req({ language: 'tlh-Latn' }), 'language_unsupported'], [req({ language: 'auto-detect' }), 'language_unsupported'],
    ] as Array<[unknown, string]>) {
      expect(validate(value), JSON.stringify(value)).toBe(true);
      expect(() => parseRequest(JSON.stringify(value)), JSON.stringify(value)).toThrow(expect.objectContaining({ code }));
    }
  });

  test('a url must be https: the schema says so, and the intake leaves it to the fetch, which refuses anything else before a byte is read', () => {
    expect(validate(req({ source: { url: 'http://example.org/a.mp3' } }))).toBe(false);
    expect(validate(req({ source: { url: 'https://example.org/a.mp3' } }))).toBe(true);
    expect(intake(req({ source: { url: 'http://example.org/a.mp3' } }))).toBe(true);
  });
});

describe('POST /: the job and its refusals', () => {
  test.skipIf(!MEDIA_TOOLS)('the golden job over HTTP: 200 with JSON.stringify of the result, byte for byte, and the log line of its outcome with no request in it', async () => {
    await serve(options(), async (api) => {
      const r = await api.post(wire(GOLDEN_REQUEST));
      expect([r.status, r.headers.get('content-type')]).toStrictEqual([200, 'application/json']);
      expect(r.text).toBe(JSON.stringify(GOLDEN_RESULT));
    });
    expect(logs.filter((l) => l.startsWith('job done'))).toHaveLength(1);
    expect(logs.find((l) => l.startsWith('job done'))).toMatch(/^job done in \d+ ms: 3 s of media; matches 3, unmatched 1, clips 3$/);
    expect(logs.join('\n')).not.toMatch(/LibriVox|public domain|something never said/);
  });

  test('the deadline is set on the arrival of each request, JOB_DEADLINE_MS after it', async () => {
    let now = T0;
    const seen: number[] = [];
    const run = vi.fn<Run>(async (_req, deps: RunDeps) => { seen.push(deps.deadlineMs); now += 5_000; return GOLDEN_RESULT as never; });
    await serve(options({ runSnippets: run, deps: baseDeps({ clock: () => now }) }), async (api) => {
      expect((await api.post(wire({ source: { url: 'https://example.org/a.mp3' }, quotes: ['x'] }))).status).toBe(200);
      expect((await api.post(wire({ source: { url: 'https://example.org/a.mp3' }, quotes: ['x'] }))).status).toBe(200);
    });
    expect(seen).toStrictEqual([T0 + JOB_DEADLINE_MS, T0 + 5_000 + JOB_DEADLINE_MS]);
    expect(run.mock.calls[0][0]).toStrictEqual({ source: { url: 'https://example.org/a.mp3' }, language: 'en', quotes: ['x'], return_clips: false, clip_format: 'mp3' });
  });

  test('a request the intake refuses is a 400 with its code and message, and media it cannot use a 422, before any job runs', async () => {
    const run = vi.fn<Run>();
    await serve(options({ runSnippets: run }), async (api) => {
      const shape = await api.post(wire({ source: { url: 'https://example.org/a.mp3' } }));
      expect([shape.status, shape.json]).toStrictEqual([400, { error: 'nothing_to_find', message: 'the request must have at least one of query, quotes and ranges' }]);
      expect((await api.post(wire('not json'))).json.error).toBe('bad_json');
    });
    expect(run).not.toHaveBeenCalled();
    await serve(options(), async (api) => {
      const media = await api.post(wire({ source: { audio_b64: toBase64(text('this is no audio at all')), mime: 'audio/mpeg' }, quotes: ['x'] }));
      expect(media.status).toBe(422);
      expect(media.json.error).toBe('source_unsupported');
      expect(media.json.message).toMatch(/^the source is not one of the audio or video types the service reads/);
    });
  });

  test('a job cut at its deadline is a 422 that keeps its message; asr_failed and clip_failed are 500 and low_disk 503 with a fixed text, the whole message in the log', async () => {
    const failing = (error: Error) => vi.fn<Run>(async () => { throw error; });
    const body = wire({ source: { url: 'https://example.org/a.mp3' }, quotes: ['x'] });
    await serve(options({ runSnippets: failing(new SnippetsError('deadline', 'the speech recognition did not finish within the 900 s the job had for it')) }), async (api) => {
      const r = await api.post(body);
      expect([r.status, r.json]).toStrictEqual([422, { error: 'deadline', message: 'the speech recognition did not finish within the 900 s the job had for it' }]);
    });
    for (const [code, status] of [['asr_failed', 500], ['clip_failed', 500], ['low_disk', 503]] as const) {
      logs.length = 0;
      await serve(options({ runSnippets: failing(new SnippetsError(code, `the detail of ${code}: /tmp/audio-snippets-x`)) }), async (api) => {
        const r = await api.post(body);
        expect([r.status, r.json]).toStrictEqual([status, { error: code, message: `The service could not do this job (${code}). The operator's log has the detail.` }]);
      });
      expect(logs.some((l) => l.includes(`${code} (${status}): the detail of ${code}: /tmp/audio-snippets-x`)), code).toBe(true);
    }
  });

  test('POST / without the token of the runtime is a 401 and no job runs; the open routes need none', async () => {
    const run = vi.fn<Run>();
    await serve(options({ runSnippets: run }), async (api) => {
      expect((await api.request('POST', '/', wire({ source: { url: 'https://example.org/a.mp3' }, quotes: ['x'] }), { authorization: null })).status).toBe(401);
      expect((await api.request('GET', '/healthz', undefined, { authorization: null })).status).toBe(200);
      expect((await api.request('GET', '/agent.json', undefined, { authorization: 'Bearer wrong' })).status).toBe(200);
    });
    expect(run).not.toHaveBeenCalled();
    expect(TEST_AUTH).toMatch(/^Bearer [0-9a-f]{64}$/);
  });
});

// Ruling R-D24: the runtime aborts its call at its own budget and frees the escrow; the service stops the job and frees its one slot for the next hirer.
describe('POST /: a caller that hangs up', () => {
  test.skipIf(!MEDIA_TOOLS)('stops the job: the worker of the speech model is killed, the slot is free within a second, the private directory is removed, and the log says why', async () => {
    // The worker is the stand-in of test/asr.test.ts, which sleeps 10 s on a WAV named slow.wav: the job asks it for its own audio under that name.
    const standIn = fileURLToPath(new URL('./fixtures/stand-in-worker.mjs', import.meta.url));
    const children: ChildProcess[] = [];
    const spawnImpl = ((file: string, args: readonly string[], opts: object) => { const child = spawn(file, args, opts); children.push(child); return child; }) as unknown as typeof spawn;
    const worker = workerAsr({ python: process.execPath, pythonArgs: [], worker: standIn, modelDir: '/app/asr/models/base', threads: 1, computeType: 'int8' }, { spawnImpl });
    const asr: Asr = { transcribe: (wav, language, timeoutMs, signal) => worker.transcribe(join(dirname(wav), 'slow.wav'), language, timeoutMs, signal), check: worker.check };
    const slot = new JobSlot();
    const deps = baseDeps({ asr });
    await serve(options({ slot, deps }), async (api) => {
      const body = wire({ source: { audio_b64: toBase64(TONE_WAV), mime: 'audio/wav' }, quotes: ['all LibriVox recordings are in the public domain'] });
      const caller = connect(Number(new URL(api.url).port), '127.0.0.1');
      caller.on('error', () => undefined);
      caller.write(['POST / HTTP/1.1', 'Host: 127.0.0.1', 'Content-Type: application/json', `Content-Length: ${Buffer.byteLength(body)}`, `Authorization: ${TEST_AUTH}`, '', ''].join('\r\n') + body);
      await until(() => children.length === 1, 'the worker runs', 20_000);
      expect(slot.busy).toBe(true);
      caller.destroy(); // the caller hangs up, as the runtime does at its budget
      await until(() => !slot.busy, 'the slot is free', 1000);
      await until(() => children[0].exitCode !== null || children[0].signalCode !== null, 'the worker has exited', 1000);
      expect(children[0].signalCode).toBe('SIGKILL');
      expect(readdirSync(deps.scratchRoot ?? '')).toStrictEqual([]);
      // The next job takes the slot (it fails at its fetch, which this test does not make), where a busy slot would answer 409.
      const next = await api.post(wire({ source: { url: 'https://203.0.113.10/a.mp3' }, quotes: ['x'] }));
      expect([next.status, next.json.error]).toStrictEqual([422, 'source_fetch_failed']);
    });
    expect(logs.filter((line) => /^job abandoned by the caller after \d+ ms$/.test(line))).toHaveLength(1);
    expect(logs.filter((line) => /^job failed after \d+ ms: aborted \(499\)$/.test(line))).toHaveLength(1);
    expect(logs.join('\n')).not.toMatch(/LibriVox|public domain/);
  }, 60_000);
});

describe('GET /healthz: the free space of the temporary directory', () => {
  test('ok with room for a job; 503 low_disk once a check finds less than 256 MiB, said once in the log; ok again when there is room, said once', async () => {
    let free = 10 * 1024 ** 3;
    let now = T0;
    const deps = baseDeps({ freeBytes: async () => free, clock: () => now });
    await serve(options({ deps }), async (api) => {
      await until(async () => (await api.get('/healthz')).status === 200, 'the first check has answered');
      free = 268_435_455;
      now += DISK_TTL_MS;
      await api.get('/healthz'); // starts a new check in the background
      await until(async () => (await api.get('/healthz')).status === 503, 'the check sees the full disk');
      expect((await api.get('/healthz')).json).toStrictEqual({ ok: false, reason: 'low_disk' });
      free = 268_435_456;
      now += DISK_TTL_MS;
      await api.get('/healthz');
      await until(async () => (await api.get('/healthz')).status === 200, 'the check sees room again');
    });
    expect(logs.filter((l) => l.startsWith('disk check failed: '))).toHaveLength(1);
    expect(logs.find((l) => l.startsWith('disk check failed: '))).toMatch(/has 268435455 bytes free, less than the 268435456 a job needs$/);
    expect(logs.filter((l) => l === 'disk check passed again')).toHaveLength(1);
    expect([DISK_TTL_MS, DISK_TIMEOUT_MS]).toStrictEqual([60_000, 5_000]);
  });
});

// Beyond the brief (ruling R-D20): what the reviews of Tasks 3 and 5 carried to the service, pinned here. The brief's text above is kept as it is.
describe('carried from the earlier tasks', () => {
  const body = wire({ source: { url: 'https://example.org/a.mp3' }, quotes: ['x'] });
  /** The deps of baseDeps with the real probe of free space (src/disk.ts) in place of the stub. */
  const realProbe = (over: Partial<Omit<RunDeps, 'deadlineMs'>> = {}): Omit<RunDeps, 'deadlineMs'> => {
    const { freeBytes: _stub, ...deps } = baseDeps(over);
    return deps;
  };

  test('the clips gap says that a cut point after a pause may begin up to about 0.7 s early (R-D18), and the manifest states it in its place', () => {
    expect(CLIPS_GAP.endsWith(' A cut point after a pause may begin up to about 0.7 s early, so a clip may start with a little silence before its first word.')).toBe(true);
    expect(MANIFEST.gaps[5]).toBe(CLIPS_GAP);
  });

  test('the deadline is set when the request arrives, its headers read, and not when its body has come: a body that comes 7 s later does not move it', async () => {
    let now = T0;
    const seen: number[] = [];
    const run = vi.fn<Run>(async (_req, deps: RunDeps) => { seen.push(deps.deadlineMs); return GOLDEN_RESULT as never; });
    await serve(options({ runSnippets: run, deps: baseDeps({ clock: () => now }) }), async (api) => {
      const socket = connect(Number(new URL(api.url).port), '127.0.0.1');
      let received = '';
      socket.on('data', (chunk: Buffer) => { received += chunk.toString('latin1'); });
      const closed = new Promise<void>((resolve) => { socket.on('close', () => { resolve(); }); });
      // With Expect: 100-continue the server writes 100 Continue as it begins the request, its arrival taken, and only then is the body sent.
      socket.write(['POST / HTTP/1.1', 'Host: 127.0.0.1', 'Content-Type: application/json', `Content-Length: ${Buffer.byteLength(body)}`, `Authorization: ${TEST_AUTH}`, 'Expect: 100-continue', 'Connection: close', '', ''].join('\r\n'));
      await until(() => received.includes('HTTP/1.1 100 Continue'), 'the server has begun the request');
      now += 7_000;
      socket.write(body);
      await closed;
      expect(received).toContain('HTTP/1.1 200 OK');
    });
    expect(seen).toStrictEqual([T0 + JOB_DEADLINE_MS]);
  });

  test('AGENT_VERSION that is empty or blank is not set, and the version is 0.1.0; a value is published without the space around it', () => {
    for (const v of [undefined, '', ' ', '\n']) {
      expect(manifestFromEnv({ OPERATOR_CONTACT: TEST_CONTACT, ...(v === undefined ? {} : { AGENT_VERSION: v }) }).version, JSON.stringify(v)).toBe('0.1.0');
    }
    expect(manifestFromEnv({ OPERATOR_CONTACT: TEST_CONTACT, AGENT_VERSION: ' 0.2.0\n' }).version).toBe('0.2.0');
  });

  test('a second job while one runs is refused with 409 busy and never queued: the run is called once, with the deadline of its own arrival', async () => {
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let now = T0;
    const seen: number[] = [];
    const run = vi.fn<Run>(async (_req, deps: RunDeps) => { seen.push(deps.deadlineMs); await held; return GOLDEN_RESULT as never; });
    await serve(options({ runSnippets: run, deps: baseDeps({ clock: () => now }) }), async (api) => {
      const first = api.post(body);
      await until(() => run.mock.calls.length === 1, 'the first job runs');
      now += 7_000;
      const second = await api.post(body);
      expect([second.status, second.json]).toStrictEqual([409, { error: 'busy' }]);
      release();
      const done = await first;
      expect([done.status, done.text]).toStrictEqual([200, JSON.stringify(GOLDEN_RESULT)]);
    });
    expect(run).toHaveBeenCalledTimes(1);
    expect(seen).toStrictEqual([T0 + JOB_DEADLINE_MS]);
  });

  test('the probe of the service is the real one: on an existing directory it reads a free space above 0, which a check that asks for more than any disk has reports', async () => {
    await serve(options({ deps: realProbe({ minFreeBytes: Number.MAX_SAFE_INTEGER }) }), async (api) => {
      await until(async () => (await api.get('/healthz')).status === 503, 'the check has answered');
    });
    const line = logs.find((l) => l.startsWith('disk check failed: ')) ?? '';
    const free = Number(/ has (\d+) bytes free, less than the 9007199254740991 a job needs$/.exec(line)?.[1]);
    expect(free, line).toBeGreaterThan(0);
  });

  test('a scratch directory that does not exist: /healthz says 503 low_disk with the cause in the log, and a job fails as a plain 500 internal, its cause in the log, before any fetch', async () => {
    const missing = `${baseDeps().scratchRoot}/gone`;
    await serve(options({ deps: realProbe({ scratchRoot: missing }) }), async (api) => {
      await until(async () => (await api.get('/healthz')).status === 503, 'the check has failed');
      expect((await api.get('/healthz')).json).toStrictEqual({ ok: false, reason: 'low_disk' });
      // A fetch would have failed as source_fetch_failed (422): the job ends before it.
      const r = await api.post(body);
      expect([r.status, r.json]).toStrictEqual([500, { error: 'internal' }]);
    });
    expect(logs.filter((l) => l.startsWith('disk check failed: '))).toHaveLength(1);
    expect(logs.find((l) => l.startsWith('disk check failed: '))).toMatch(/^disk check failed: ENOENT/);
    expect(logs.filter((l) => /^job failed after \d+ ms: internal error: ENOENT/.test(l))).toHaveLength(1);
    expect(logs.join('\n')).not.toMatch(/low_disk \(503\)/);
  });
});
