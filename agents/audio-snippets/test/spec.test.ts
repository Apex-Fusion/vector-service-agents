// agents/audio-snippets/test/spec.test.ts
// specs/audio-snippets.md is the public page of the agent and the manifest links to its Response section. These tests hold the page to the code: the
// numbers of the terms and the limits, the status, the identity, the request fields of the schema the manifest publishes, the example result (the golden job
// of the suite), the gap sentences word for word, the error codes with their statuses, and the third parties.
import { describe, test, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { REGISTRY_ADDRESS } from '@vsa/vector-read';
import { gapsFor } from '../src/gaps.ts';
import { parseRequest } from '../src/request.ts';
import { manifestFromEnv } from '../src/server.ts';
import { GOLDEN_RESULT } from './golden.ts';
// For the pins beyond the brief at the end of this file (R-D20).
import { createHash } from 'node:crypto';
import { ASR_MAX_MS, ASR_MIN_MS, CLIPS_RESERVE_MS, JOB_DEADLINE_MS, asrBudgetMs } from '../src/budget.ts';
import { MIN_FREE_BYTES } from '../src/disk.ts';
import { WHISPER_LANGUAGES } from '../src/languages.ts';
import { PAD_S, QUERY_MAX_MATCHES, QUERY_MIN_SCORE, QUOTE_MIN_SCORE, bestQuoteWindow, round3, tokenStream } from '../src/match.ts';
import { DURATION_SLACK_S, MAX_DURATION_S } from '../src/media.ts';
import { modelName, whisperSize } from '../src/model.ts';
import { MAX_INLINE_BYTES, MAX_QUERY_CHARS, MAX_QUOTES, MAX_QUOTE_CHARS, MAX_RANGES, MIMES } from '../src/request.ts';
import { SnippetsError } from '../src/result.ts';
import type { SnippetsErrorCode } from '../src/result.ts';
import { HEARTBEAT_MS, MAX_BODY, MIN_PROCESSING_WINDOW_MS } from '../src/server.ts';
import { loadConfig } from '../src/start.ts';
import { GOLDEN_TRANSCRIPT } from './golden.ts';
import { FULL_ENV, SUPPLIER } from './server-support.ts';
import { TONE_WAV } from './support.ts';

const page = readFileSync(new URL('../../../specs/audio-snippets.md', import.meta.url), 'utf8');
const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
const section = (heading: string): string => (page.split(`\n## ${heading}\n`)[1] ?? '').split('\n## ')[0];
const sub = (heading: string): string => (page.split(`\n### ${heading}\n`)[1] ?? '').split(/\n##+ /)[0];
const manifest = manifestFromEnv({ OPERATOR_CONTACT: 'ops@example.test' });
const row = (text: string, label: string): string => text.split('\n').find((l) => l.startsWith(`| ${label} |`)) ?? '';

describe('specs/audio-snippets.md', () => {
  test('the Terms tables carry the numbers of the manifest and of the code', () => {
    const terms = section('Terms');
    expect(row(terms, 'Price')).toBe(`| Price | ${manifest.terms.price_lovelace} | 2.000000 |`);
    expect(row(terms, 'Supplier bond')).toBe(`| Supplier bond | ${manifest.terms.supplier_bond_lovelace} | 1.000000 |`);
    expect(row(terms, 'Buyer bond')).toBe(`| Buyer bond | ${manifest.terms.buyer_bond_lovelace} | 1.000000 |`);
    expect(row(terms, 'Processing window, advert `max_processing_ms`')).toBe(`| Processing window, advert \`max_processing_ms\` | ${manifest.terms.max_processing_ms} ms |`);
    expect(terms).toContain('| Job deadline, set by the service when a request arrives | 1320000 ms (60 s inside the service timeout) |');
    expect(terms).toContain(`| Fetched file | 50 MB (${manifest.terms.input_limits.source_bytes} bytes) |`);
    expect(terms).toContain(`| Inline media | ${manifest.terms.input_limits.inline_media_bytes} bytes |`);
    expect(terms).toContain(`| Inline clips | 2 MB in total (${manifest.terms.input_limits.inline_clip_bytes} bytes) |`);
  });

  test('the capability, the model string, the opening line and the status are the manifest\'s', () => {
    expect(section('Capability id').split('\n')[1]).toBe(`\`${manifest.capability_id}\``);
    expect(section('Capability id')).toContain('The model string in the advert and in every receipt is `audio-snippets-v1`.');
    expect(page.split('\n')[2]).toBe(`Capability \`${manifest.capability_id}\`. ${manifest.description}`);
    expect(manifest.status).toStrictEqual({ chip: 'proposed', since: '2026-10-13' });
    expect(section('Status').split('\n')).toContain('PROPOSED (built, not deployed). Since 2026-10-13.');
    expect(row(section('Identity'), 'Registry address')).toBe(`| Registry address | \`${REGISTRY_ADDRESS}\` |`);
  });

  test('the request: the page shows every field of the schema the manifest publishes, and its examples are requests the intake accepts', () => {
    const request = sub('Request');
    for (const field of Object.keys(manifest.interface.request_schema.properties)) expect(request, field).toContain(`\`${field}\``);
    const example = /Example:\n\n```json\n([\s\S]*?)\n```/.exec(request)?.[1] ?? '';
    expect(parseRequest(example)).toMatchObject({ source: { url: 'https://example.org/talk.mp3' }, ranges: [{ start_s: 12, end_s: 20.5 }] });
    const inline = /The request JSON is, for example, `([^`]+)`/.exec(section('How to hire it'))?.[1] ?? '';
    expect(parseRequest(inline).quotes).toStrictEqual(['a quote that was said in the talk']);
  });

  test('the response: one Response heading, the anchor the manifest links to, and its example is the golden result asked without clips', () => {
    expect(page.match(/^### Response$/gm)).toHaveLength(1);
    expect(manifest.interface.response_schema.$ref.endsWith('/specs/audio-snippets.md#response')).toBe(true);
    const json = /```json\n([\s\S]*?)\n```/.exec(sub('Response'))?.[1] ?? '';
    expect(JSON.parse(json)).toStrictEqual({ ...GOLDEN_RESULT, clips: [], clips_truncated: false });
    expect(Object.keys(JSON.parse(json))).toStrictEqual(Object.keys(GOLDEN_RESULT));
  });

  test('every gap sentence of the manifest is on the page word for word, one to a line and in its order, and the page adds four of its own', () => {
    const lines = section('Known gaps').split('\n').filter((l) => l.startsWith('- '));
    expect(lines.slice(0, 7)).toStrictEqual(gapsFor('base').map((gap) => `- ${gap}`));
    expect(manifest.gaps).toStrictEqual([...gapsFor('base')]);
    expect(lines).toHaveLength(11);
    expect(lines[7]).toContain('The hosted MCP server reads at most 1000000 bytes of a job\'s answer');
    expect(lines.some((l) => l.includes('102 Processing'))).toBe(true);
  });

  test('the Errors table of the page is the README\'s, row for row', () => {
    const rows = (text: string) => text.split('\n').filter((l) => /^\| \d{3}, /.test(l)).map((l) => l.replace(/ \([^)]*\)/g, ''));
    const onPage = rows(sub('Errors'));
    expect(onPage).toHaveLength(7);
    expect(onPage).toStrictEqual(rows(readme));
  });

  test('the third parties of the manifest are the ones the page lists, and the links name files that exist', () => {
    const parties = section('Operator and data handling').split('\n').filter((l) => /^\| [a-z]/.test(l)).map((l) => l.split(' | ')[0].slice(2));
    expect(parties).toStrictEqual(manifest.behaviour.third_parties);
    const root = fileURLToPath(new URL('../../../', import.meta.url));
    for (const [, target] of section('Links').matchAll(/\]\(\.\.\/([^)]+)\)/g)) expect(existsSync(root + target), target).toBe(true);
    expect(manifest.links.source.endsWith('/agents/audio-snippets')).toBe(true);
  });
});

// ---- Pins beyond the brief (R-D20) ----
// Every number, code and limit the page states that the seven tests above do not hold is held here to the code that owns it: the budgets of a job, the limits of
// the request, the matching, the errors, the speech model, the data handling, the identity and the gaps of the page's own.
const thousands = (n: number): string => n.toLocaleString('en-US');
const tick = (s: string): string => `\`${s}\``;
/** The rows of a two-column table of the page, by their first cell. */
const rowsOf = (text: string): Record<string, string> => Object.fromEntries(
  text.split('\n').filter((l) => /^\| .+ \| .+ \|$/.test(l) && !/^\| (Field|Term|Limit|Status|Receipt field|Party|Route) \|/.test(l)).map((l) => [l.split('|')[1].trim(), l.split('|')[2].trim()]),
);
const stream = (words: string[]) => tokenStream(words.map((w, i) => ({ w, start: i, end: i + 1, segment: 0 })));
const windowSize = (found: { from: number; to: number } | null): number => (found === null ? 0 : found.to - found.from + 1);
const here = (file: string): string => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');

describe('specs/audio-snippets.md, pinned further', () => {
  test('the Limits table states the budgets of the code: the service timeout 60 s over the job deadline, the speech recognition as asrBudgetMs gives it, the duration, the window', () => {
    const limits = rowsOf(section('Terms'));
    expect(limits['Service timeout, `SERVICE_TIMEOUT_MS`']).toBe(`${JOB_DEADLINE_MS + 60_000} ms`);
    expect(limits['Job deadline, set by the service when a request arrives']).toBe(`${JOB_DEADLINE_MS} ms (60 s inside the service timeout)`);
    expect(limits['Speech recognition']).toBe(`the smaller of ${ASR_MAX_MS} ms and the time the job has left (${CLIPS_RESERVE_MS} ms less of it when clips are asked for), and not started when that is under ${ASR_MIN_MS} ms`);
    expect(limits['Duration']).toBe(`${MAX_DURATION_S / 60} min (${MAX_DURATION_S} s, with ${DURATION_SLACK_S} s more for the padding an encoder adds)`);
    expect(manifest.terms.input_limits.duration_s).toBe(MAX_DURATION_S);
    expect(limits['Request']).toBe('at least one of `query`, `quotes`, `ranges`');
    // The row says what asrBudgetMs does: the smaller of the cap and the time left, less 60 s of it with clips, and nothing under 30 s.
    expect([asrBudgetMs(JOB_DEADLINE_MS, false), asrBudgetMs(JOB_DEADLINE_MS, true)]).toStrictEqual([ASR_MAX_MS, ASR_MAX_MS]);
    expect([asrBudgetMs(500_000, false), asrBudgetMs(500_000, true)]).toStrictEqual([500_000, 500_000 - CLIPS_RESERVE_MS]);
    expect([asrBudgetMs(ASR_MIN_MS, false), asrBudgetMs(ASR_MIN_MS - 1, false)]).toStrictEqual([ASR_MIN_MS, null]);
    expect([asrBudgetMs(ASR_MIN_MS + CLIPS_RESERVE_MS, true), asrBudgetMs(ASR_MIN_MS + CLIPS_RESERVE_MS - 1, true)]).toStrictEqual([ASR_MIN_MS, null]);
    // The window of the advert is 25 min, the least the service accepts, and the deadline of 22 min is inside it.
    expect([manifest.terms.max_processing_ms, MIN_PROCESSING_WINDOW_MS, JOB_DEADLINE_MS / 60_000]).toStrictEqual([1_500_000, 1_500_000, 22]);
    expect(section('How to hire it')).toContain('Allow for the 25 min processing window.');
  });

  test('the limits of the request are the intake\'s: the bytes of media and of the wire payload, the lengths of the texts, the counts, the eleven types and the 100 languages', () => {
    const t = manifest.terms.input_limits;
    const text = section('Interface').replace(/\s+/g, ' ');
    const base64 = (MAX_INLINE_BYTES / 3) * 4;
    expect(text).toContain(`base64 of at most ${thousands(MAX_INLINE_BYTES)} bytes of raw media`);
    expect(text).toContain(`The wire payload is capped at ${thousands(t.request_bytes)} bytes`);
    expect(text).toContain(`so ${thousands(MAX_INLINE_BYTES)} raw bytes become ${thousands(base64)} characters and leave ${thousands(t.request_bytes - base64)} bytes for the rest of the request`);
    expect(text).toContain(`and a ${t.source_bytes / (1024 * 1024)} MB cap`);
    const rows = rowsOf(sub('Request'));
    expect(rows['`query`']).toBe(`1 to ${MAX_QUERY_CHARS} characters, with at least one letter or digit.`);
    expect(rows['`quotes`']).toBe(`1 to ${MAX_QUOTES} texts of 1 to ${MAX_QUOTE_CHARS} characters each, each with at least one letter or digit.`);
    expect(rows['`ranges`']).toBe(`1 to ${MAX_RANGES} objects \`{ "start_s": <number>, "end_s": <number> }\` with \`0 <= start_s < end_s\`.`);
    expect(MIMES).toHaveLength(11);
    expect(rows['`source` inline']).toContain(`the type one of ${MIMES.slice(0, -1).map(tick).join(', ')} and ${tick(MIMES[MIMES.length - 1])}. Standard base64, padded, with no whitespace or line breaks, of at most ${MAX_INLINE_BYTES} bytes of media.`);
    expect(WHISPER_LANGUAGES).toHaveLength(100);
    expect(rows['`language`']).toContain(`must be one of the ${WHISPER_LANGUAGES.length} languages the speech model knows, which the manifest lists in \`interface.notes\``);
    expect(manifest.interface.notes.join(' ')).toContain(WHISPER_LANGUAGES.join(', '));
    // The language rule is the intake's: the examples of the page are taken, en-GB is asked as en, and what the rule leaves out is refused.
    const asked = (language: string): string => JSON.stringify({ source: { url: 'https://example.org/talk.mp3' }, quotes: ['a quote'], language });
    for (const [code, kept] of [['en', 'en'], ['en-GB', 'en'], ['zh-Hant-TW', 'zh'], ['AUTO', 'auto'], ['en-abcdefgh-abcd', 'en']]) expect(parseRequest(asked(code)).language, code).toBe(kept);
    for (const code of ['e', 'en_GB', 'en-', 'en-abcdefgh-abcde']) expect(() => parseRequest(asked(code)), code).toThrow();
    expect(rows['`language`']).toContain('Default `en`.');
    expect(parseRequest(JSON.stringify({ source: { url: 'https://example.org/talk.mp3' }, quotes: ['a quote'] })).language).toBe('en');
    // The service holds no key and posts nothing, so what a refusal locks is never the service's; the hirer's escrow is reclaimed after deliver_by.
    expect(sub('Request')).toContain("A request that breaks a shape rule is refused before anything is fetched, so it locks nothing of the service's.");
    expect(sub('Errors')).toContain("The service holds no key and posts nothing, so no refusal locks anything of the service's.");
  });

  test('Matching states the thresholds and the windows of the code: at or above 0.55 and 0.2, 3 segments, 150 ms, windows from 0.7 n rounded down to 1.3 n rounded up, 3 decimals', () => {
    const matching = sub('Matching');
    expect([QUOTE_MIN_SCORE, QUERY_MIN_SCORE, QUERY_MAX_MATCHES, PAD_S]).toStrictEqual([0.55, 0.2, 3, 0.15]);
    expect(matching).toContain('A quote whose best ratio is at or above 0.55 is a match, and one under 0.55 goes to `unmatched`.');
    expect(matching).toContain('The segments at or above 0.2, at most 3 of them, the highest,');
    expect(matching).toContain('150 ms of padding is added on each side, within the media');
    expect(matching).toContain('a quote of n words is compared with every window of the transcript of 0.7 n rounded down to 1.3 n rounded up words (at least one)');
    expect(section('Interface')).toContain('| `unmatched[]` | each quote whose best score is under 0.55, and the query when no segment reached 0.2, each with its best score |');
    // The windows: for 3 words the smallest is 2 (floor of 2.1) and the largest 4 (ceil of 3.9); for 1 word they are 1 and 2 (ceil of 1.3).
    expect([windowSize(bestQuoteWindow('one two three', stream(['one', 'two']))), windowSize(bestQuoteWindow('one two three', stream(['one'])))]).toStrictEqual([2, 0]);
    expect(windowSize(bestQuoteWindow('ab cd ef', stream(['ab', 'cd', 'e', 'f'])))).toBe(4);
    expect(windowSize(bestQuoteWindow('ca', stream(['c', 'a'])))).toBe(2);
    expect(round3(1.23456)).toBe(1.235);
    expect(section('Interface')).toContain('Every number is rounded to 3 decimals.');
  });

  test('the Errors text states the numbers of the code: the 1000000 bytes of a message, the 256 MiB of free space, and the codes that get the fixed message of a failure on the service\'s side', () => {
    const errors = sub('Errors');
    expect(MAX_BODY).toBe(1_000_000);
    expect(errors).toContain('`request_too_large` (over 1000000 bytes)');
    expect(MIN_FREE_BYTES / 1024 ** 2).toBe(256);
    expect(errors).toContain('`low_disk` (less than 256 MiB free in the temporary directory)');
    const lead = errors.split('\n| Status | Codes |\n')[0];
    expect(lead.split('\n').filter((l) => l.startsWith('- '))).toStrictEqual([
      '- The 401 and `internal` have the code and no message.',
      '- The runtime fails the job on any non-2xx answer and copies the first 200 characters of the failure to the buyer. The buyer reclaims after `deliver_by`.',
      "- `asr_failed`, `clip_failed` and `low_disk` are failures on the service's side. Their message is fixed: `The service could not do this job (<code>). The operator's log has the detail.`",
      '- `shutting_down` says that the service is stopping.',
      '- One job runs at a time. A second request while one runs gets 409 `{"error":"busy"}`, and nothing is started.',
      '- `GET /healthz` and `GET /agent.json` are matched on their path, whatever the query string, and a `HEAD` of either gets the headers of the `GET` and no body. Any other route gets 404 `{"error":"not_found"}`, a `POST /` with a query string among them.',
    ]);
    // The failures on the service's side are the codes of a job with a status of 500 or more: the three the page names, and no other.
    const codes: SnippetsErrorCode[] = ['deadline', 'asr_failed', 'clip_failed', 'low_disk'];
    expect(codes.filter((code) => new SnippetsError(code, 'x').status >= 500)).toStrictEqual(['asr_failed', 'clip_failed', 'low_disk']);
    expect(errors).toContain('A refusal is `{ "error": "<code>", "message": "<words>" }` with the status in the table.');
  });

  test('The speech model section names what worker.py and requirements.txt hold: the versions, the CPU, int8, the settings of the run, the model fetched at a pinned revision', () => {
    const text = sub('The speech model');
    expect(here('asr/requirements.txt')).toContain('faster-whisper==1.2.1');
    expect(here('asr/requirements.txt')).toContain('ctranslate2==4.8.2');
    expect(text).toContain('faster-whisper 1.2.1 with ctranslate2 4.8.2 on the CPU, model `base` with `compute_type` int8, built into the image at a pinned revision');
    for (const setting of ['device="cpu"', 'compute_type must be int8', 'beam_size=5', 'temperature=0.0', 'word_timestamps=True', 'vad_filter=False']) expect(here('asr/worker.py'), setting).toContain(setting);
    expect(text).toContain('with word timestamps on, voice-activity filtering off, `beam_size` 5 and `temperature` 0.0, so that the same audio gives the same transcript');
    expect(here('asr/fetch_model.py')).toMatch(/"base": \("[0-9a-f]{40}"/);
    expect(here('Dockerfile')).toContain('fetch_model.py');
    expect(modelName(whisperSize(undefined))).toBe('faster-whisper-base-int8');
    expect(text).toContain('Nothing is fetched while a job runs but the media.');
  });

  test('the example of the Response is an illustration built from the test fixture through a stub of the model, the page says so, and its model field is the name the code gives the default model', () => {
    const response = sub('Response');
    expect(response).toContain('It is an illustration and not a recorded run of the speech model.');
    expect(response).toContain('The audio is a tone fixture of 3 s, and the transcript is the text that a stub of the speech model gives for it, so no model heard anything.');
    // What the page calls the fixture and the stub are those of the suite: the media is the tone, the transcript is the stub's, the model is the default image's.
    expect([createHash('sha256').update(TONE_WAV).digest('hex'), TONE_WAV.length]).toStrictEqual([GOLDEN_RESULT.source.sha256, GOLDEN_RESULT.source.bytes]);
    expect(GOLDEN_RESULT.source.duration_s).toBe(3);
    expect(GOLDEN_RESULT.transcript).toStrictEqual(GOLDEN_TRANSCRIPT.segments);
    expect(GOLDEN_RESULT.model).toBe(modelName(whisperSize(undefined)));
    expect(response).toContain(`The \`model\` field reads as the service names its default model, ${tick(modelName(whisperSize(undefined)))}.`);
    expect(response).toContain('"model": "faster-whisper-base-int8", "language": "en",');
    const block = /```json\n([\s\S]*?)\n```/.exec(response)?.[1] ?? '';
    expect(block).not.toMatch(/<[a-z0-9 ]+>/); // no placeholder is left of the illustration the page had before the build
  });

  test('Operator and data handling says what the manifest says the service holds, writes and logs, and what the ledger carries', () => {
    const handling = section('Operator and data handling');
    for (const part of ['held in memory while a job runs', 'private temporary directory', 'removed when the job ends', 'never a request, a transcript or the media', 'the escrow carries only the sha256 of the wire payload, and the media stays off the ledger', 'from files built into its image']) {
      expect(handling, part).toContain(part);
      expect(manifest.behaviour.data_handling, part).toContain(part);
    }
    expect(handling).toContain('Datalab, OpenRouter and Brave are not used, and neither is any model provider.');
  });

  test('the Controller row names the three fields of the manifest and the check at start, and the code does it (R-D21)', () => {
    const controller = row(section('Identity'), 'Controller');
    expect(Object.keys(manifest.identity)).toContain('controller_pkh');
    expect(Object.keys(manifest.keys)).toStrictEqual(['supplier_pkh', 'pub_key_hex']);
    for (const field of ['identity.controller_pkh', 'keys.supplier_pkh', 'keys.pub_key_hex']) expect(controller, field).toContain(tick(field));
    expect(controller).toContain('the service does not start unless the public key hashes to the key hash');
    const config = loadConfig(FULL_ENV);
    expect([config.manifest.identity.controller_pkh, config.manifest.keys]).toStrictEqual([SUPPLIER.pkh, { supplier_pkh: SUPPLIER.pkh, pub_key_hex: SUPPLIER.pubKeyHex }]);
    expect(() => loadConfig({ ...FULL_ENV, SUPPLIER_PUB_KEY_HEX: 'cd'.repeat(32) })).toThrow(/is not the public key of SUPPLIER_PKH/);
    expect(row(section('What the receipt commits to'), '`supplier_pkh`')).toContain('which is also the controller key');
  });

  test('the four gaps of the page\'s own are on the page word for word after the manifest\'s seven, and the numbers they and the clips gap state are the code\'s', () => {
    const gaps = section('Known gaps');
    const own = [
      "- The hosted MCP server reads at most 1000000 bytes of a job's answer, and the inline clips alone may come to 2000000 bytes: an answer over 1000000 bytes cannot be read through it. Ask for clips on the terminal path of [docs/HIRE.md](../docs/HIRE.md), section 8, or leave `return_clips` out and cut the clips from the media at the cut points.",
      "- The runtime's budget for a job is the smaller of `SERVICE_TIMEOUT_MS` and `deliver_by` less the start time less 30 s, and the wire carries no budget, so the service cannot see it. A job that the runtime claims late can be abandoned by the runtime before the service has finished it. The service stops the job when the runtime hangs up, and nothing of it is kept. The hirer then reclaims after `deliver_by`.",
      "- The service answers `POST /` only when the call carries the token the runtime sends as its `authorization` header. A `POST /` without it gets 401 `unauthorized`, with no detail, before its body is read, so that nothing else on the host's network can make the service run a job. `GET /healthz` and `GET /agent.json` need no header, and neither does a `HEAD` of either; any other route gets 404.",
      "- While a job runs the service writes an interim `102 Processing` line every 60 s, ahead of the answer, because the runtime's fetch gives up on a response that has not begun after 300 s of silence and a job can take up to 22 minutes. The answer is the same 200 with the same body.",
    ];
    for (const line of own) expect(gaps, line.slice(0, 50)).toContain(`\n${line}\n`);
    expect(gaps.indexOf(`\n- ${gapsFor('base')[6]}\n`)).toBeLessThan(gaps.indexOf(`\n${own[0]}\n`));
    expect(gaps.split('\n').filter((l) => l.startsWith('- '))).toHaveLength(gapsFor('base').length + own.length);
    // The numbers: a line every minute, an answer inside 22 minutes, inline clips that can exceed the 1000000 bytes the hosted server reads, and the sentence of ruling R-D18.
    expect([HEARTBEAT_MS, JOB_DEADLINE_MS / 60_000]).toStrictEqual([60_000, 22]);
    expect(manifest.terms.input_limits.inline_clip_bytes).toBeGreaterThan(1_000_000);
    expect(gaps).toContain('A cut point after a pause may begin up to about 0.7 s early, so a clip may start with a little silence before its first word.\n');
  });

  test('How to hire it says the read cap of the hosted server and the window, and the page, the guide and the runbook say the same 1000000 bytes', () => {
    const how = section('How to hire it');
    expect(how).toContain('The answer of a job is read through the server only up to 1000000 bytes, so leave the clips out there.');
    const guide = readFileSync(new URL('../../../docs/HIRE.md', import.meta.url), 'utf8');
    const runbook = readFileSync(new URL('../../../deploy/host/RUNBOOK-audio-snippets.md', import.meta.url), 'utf8');
    expect(page).toMatch(/reads at most 1000000 bytes of a job's answer/);
    expect(guide).toMatch(/reads at most 1000000 bytes of the answer of a job/);
    expect(runbook).toMatch(/reads at most 1000000 bytes of a job's answer/);
  });
});
