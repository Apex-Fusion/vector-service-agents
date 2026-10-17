// agents/audio-snippets/test/readme.test.ts
// The README names every environment variable the service reads and every error code it answers with, and these tests keep the page and the code from
// parting: a variable read in src/ that the table does not name fails, so does a name in the table that no code reads, and so does a code with the wrong
// status or one that no source file knows.
import { describe, test, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { TOKEN_SEARCH_MIN } from '@vsa/service-kit';
import { WORKER_PATH } from '../src/asr.ts';
import { ASR_MAX_MS, ASR_MIN_MS, CLIPS_RESERVE_MS, JOB_DEADLINE_MS } from '../src/budget.ts';
import { INLINE_CLIPS_BYTES, MP3_BITRATE } from '../src/clips.ts';
import { MIN_FREE_BYTES } from '../src/disk.ts';
import { PAD_S, QUERY_MAX_MATCHES, QUERY_MIN_SCORE, QUOTE_MIN_SCORE } from '../src/match.ts';
import { RequestError } from '../src/request.ts';
import type { RequestErrorCode } from '../src/request.ts';
import { SnippetsError } from '../src/result.ts';
import type { SnippetsErrorCode } from '../src/result.ts';
import { DISK_TTL_MS, HEARTBEAT_MS, MAX_BODY, MIN_PROCESSING_WINDOW_MS, TEMPLATE_ENV, WireError } from '../src/server.ts';
import { ASR_PYTHON_DEFAULT, PORT_DEFAULT, SETTINGS, SHUTDOWN_WAIT_MS, WHISPER_THREADS_DEFAULT, loadConfig } from '../src/start.ts';
import { FULL_ENV } from './server-support.ts';

const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
// The ledger's native unit is named once in the repository, in docs/HIRE.md. Spelled in two parts, so that a search for the name finds only the guide.
const UNIT_NAME = new RegExp('AP' + '3X', 'i');
const read = (dir: URL) => readdirSync(dir).filter((file) => file.endsWith('.ts')).map((file) => ({ file, text: readFileSync(new URL(file, dir), 'utf8') }));
const sources = read(new URL('../src/', import.meta.url));
// The codes the shared server answers with (bad_wire, request_too_large, unauthorized, busy, shutting_down, internal) are in packages/service-kit.
const kitSources = read(new URL('../../../packages/service-kit/src/', import.meta.url));
const section = (heading: string): string => (readme.split(`\n## ${heading}\n`)[1] ?? '').split('\n## ')[0];
const ticks = (text: string): string[] => [...text.matchAll(/`([^`]+)`/g)].map((m) => m[1]);

/** The names the code reads from the environment itself: `env.NAME`, `process.env.NAME`, and the names given to envInt and requiredEnv. */
function namesRead(): string[] {
  const found = new Set<string>();
  for (const { text } of sources) {
    for (const m of text.matchAll(/\b(?:process\.env|env)\.([A-Z][A-Z0-9_]*)\b/g)) found.add(m[1]);
    for (const m of text.matchAll(/\b(?:envInt|requiredEnv)\(\s*'([A-Z][A-Z0-9_]*)'/g)) found.add(m[1]);
  }
  return [...found].sort();
}

describe('agents/audio-snippets/README.md', () => {
  test('the Manifest table names exactly the variables the service reads, and they are the settings the token is looked for in', () => {
    const table = section('Manifest').split('\n').filter((line) => /^\| `[A-Z]/.test(line));
    const documented = table.flatMap((line) => ticks(line.split('|')[1])).sort();
    expect(documented).toStrictEqual(namesRead());
    expect([...SETTINGS].sort()).toStrictEqual(namesRead());
  });

  test("the defaults the table gives are the code's", () => {
    const row = (name: string): string => section('Manifest').split('\n').find((line) => line.startsWith(`| \`${name}\``)) ?? '';
    expect(row('PORT')).toContain(`\`${PORT_DEFAULT}\``);
    expect(row('WHISPER_THREADS')).toContain(`\`${WHISPER_THREADS_DEFAULT}\``);
    expect(row('ASR_PYTHON')).toContain(`\`${ASR_PYTHON_DEFAULT}\``);
    expect(row('WHISPER_MODEL')).toContain('`base`');
    expect(row('WHISPER_MODEL_DIR')).toContain('`/app/asr/models/<size>`');
    expect(row('ADVERT_PRICE_LOVELACE')).toContain('`2000000`');
    expect(row('ADVERT_MAX_PROCESSING_MS')).toContain('`1500000`');
    expect(row('AGENT_STATUS_CHIP')).toContain('`deployed`');
    expect(row('AGENT_STATUS_SINCE')).toContain('`2026-10-17`');
    expect(row('AGENT_VERSION')).toContain('`0.1.0`');
  });

  test('the Errors table gives each code its status, and every code it names is one the sources know', () => {
    const rows = section('Errors').split('\n').filter((line) => /^\| \d{3}, /.test(line));
    expect(rows).toHaveLength(7);
    const all = [...sources, ...kitSources].map(({ text }) => text).join('\n');
    const intake: RequestErrorCode[] = ['bad_json', 'bad_shape', 'base64_too_large', 'language_bad', 'language_unsupported', 'nothing_to_find', 'range_bad', 'source_fetch_failed', 'source_too_large', 'source_unsupported', 'source_mime_mismatch', 'media_unreadable', 'media_no_audio', 'media_too_long', 'range_out_of_media'];
    const job: SnippetsErrorCode[] = ['deadline', 'asr_failed', 'clip_failed', 'low_disk'];
    const documented = new Set<string>();
    for (const row of rows) {
      const status = Number(/^\| (\d{3}), /.exec(row)?.[1]);
      for (const code of ticks(row.split('|')[2])) {
        documented.add(code);
        expect(all, code).toContain(`'${code}'`);
        if ((intake as string[]).includes(code)) expect(new RequestError(code as RequestErrorCode, 'x').status, code).toBe(status);
        if ((job as string[]).includes(code)) expect(new SnippetsError(code as SnippetsErrorCode, 'x').status, code).toBe(status);
      }
    }
    for (const code of [...intake, ...job, 'bad_wire', 'request_too_large', 'unauthorized', 'shutting_down', 'internal']) expect(documented.has(code), code).toBe(true);
  });

  test('it explains the token, the 102 Processing line, the fixed text of a 5xx, the stop, the checks at start and the window', () => {
    expect(readme).toContain('`POST /` requires the `authorization` header to be exactly the value of `SERVICE_AUTH_HEADER`');
    expect(readme).toContain('401 `{"error":"unauthorized"}`, with no detail, before the body is read and before the job slot is taken');
    expect(readme).toContain('102 Processing');
    expect(readme).toMatch(/runtime's fetch gives up after 300 s of silence/);
    // Ruling R-D24: a job whose caller hangs up is stopped, so the stop of a restart waits for a job that may end that way, and a job the runtime gave up on is lost.
    expect(section('Routes')).toContain('A job whose caller hangs up, as the runtime does when its own budget for the job runs out, is stopped: the worker of the speech model is killed, the private directory is removed, nothing of the job is kept, and the slot is free for the next one.');
    expect(section('Stopping')).toContain('The wait is on the job itself: it ends when the job has its answer, or when the job has been stopped because its caller hung up.');
    expect(readme).not.toMatch(/does not cut it short|goes on with the job/);
    expect(readme).toContain("The service could not do this job (<code>). The operator's log has the detail.");
    expect(section('Stopping')).toContain('On SIGTERM (`docker stop` sends it) or SIGINT the service takes no new job and no new connection, and waits up to 300 s for the job that is running to end.');
    expect(section('Stopping')).toContain('so `stop_grace_period` in the compose file is 330 s');
    expect(readme).toContain(`${SHUTDOWN_WAIT_MS / 1000} s`);
    expect(readme).toContain('asks `ffprobe` and `ffmpeg` for their version and the worker of the speech model to check itself');
    expect(readme).toContain('It also proves that the temporary directory can be written, and asks');
    expect(readme).toMatch(/at least 1500000/);
    expect(section('Run it')).toContain('export SERVICE_AUTH_HEADER="Bearer $(openssl rand -hex 32)"');
    expect(readme).not.toMatch(/SERVICE_AUTH_HEADER=["']?Bearer [0-9a-f]/);
  });

  test('it says the status the manifest and the code give, and nothing in it is a dash, a unit name or a key', () => {
    // DEPLOYED since the flip of 2026-10-17 (RUNBOOK-audio-snippets step 17): the facts in one line, as the page of the spec gives them. Never live: a first-party run is not demand.
    const STATUS = 'Status: DEPLOYED (registered and staked 2026-10-17, advertised 2026-10-17, re-advertised 2026-10-17 at the status flip, one first-party job settled 2026-10-17). Since 2026-10-17.';
    expect(readme).toContain(`${STATUS} The service is built and its tests run the real ffmpeg`);
    expect(readme).toContain("It runs on the operator's host, and the one job it has settled is first-party, which is not demand.");
    expect(readme).not.toMatch(/no registry record|no advert|no job has run|not deployed/i);
    expect(readme).not.toMatch(/[\u{2013}\u{2014}]/u);
    expect(readme).not.toMatch(UNIT_NAME);
    expect(readme).not.toMatch(/[0-9a-f]{64}/);
    expect(readme.replace(STATUS, '').match(/\b(LIVE|DEPLOYED|PROPOSED)\b/g)).toBeNull(); // DEPLOYED is said in the status line only; elsewhere the words are in lower case, as the values the manifest carries
  });
});

// ---- Pins beyond the brief (R-D20) ----
// The numbers, files and settings the README states that the five tests above do not hold, held to the code, the compose file and the Dockerfile that own them.
const here = (file: string): URL => new URL(`../${file}`, import.meta.url);
const textOf = (file: string): string => readFileSync(here(file), 'utf8');

describe('agents/audio-snippets/README.md, pinned further', () => {
  test('the four settings the service cannot start without are the ones the README names, each is refused naming it, and a public key that is not the key of the hash stops the start (R-D21)', () => {
    const required = ['OPERATOR_CONTACT', 'SUPPLIER_PKH', 'SUPPLIER_PUB_KEY_HEX', 'SERVICE_AUTH_HEADER'];
    const run = section('Run it');
    expect(run).toContain('when `OPERATOR_CONTACT`, `SUPPLIER_PKH`, `SUPPLIER_PUB_KEY_HEX` or `SERVICE_AUTH_HEADER` is not set');
    expect(run).toContain('when `SUPPLIER_PUB_KEY_HEX` is not the public key of `SUPPLIER_PKH`');
    expect(run).toContain('SUPPLIER_PUB_KEY_HEX=<64 hex>');
    for (const name of required) {
      const env: Record<string, string> = { ...FULL_ENV };
      delete env[name];
      expect(() => loadConfig(env), name).toThrow(new RegExp(`^environment variable ${name} is required`));
      const row = section('Manifest').split('\n').find((line) => line.startsWith(`| \`${name}\``)) ?? '';
      expect(row, name).toMatch(/\bRequired\b/);
    }
    expect(() => loadConfig({ ...FULL_ENV, SUPPLIER_PUB_KEY_HEX: 'cd'.repeat(32) })).toThrow(/^environment variable SUPPLIER_PUB_KEY_HEX is not the public key of SUPPLIER_PKH/);
    expect(() => loadConfig({ ...FULL_ENV, ADVERT_MAX_PROCESSING_MS: String(MIN_PROCESSING_WINDOW_MS - 1) })).toThrow(/^environment variable ADVERT_MAX_PROCESSING_MS must be at least 1500000/);
    expect(MIN_PROCESSING_WINDOW_MS / 60_000).toBe(25);
    expect(run).toContain('is below 25 min');
  });

  test('Routes states the numbers of the code: the free space line, the 1000000 bytes of a message, the deadline, the budget of the speech recognition, the line every 60 s', () => {
    const routes = section('Routes');
    expect(MIN_FREE_BYTES).toBe(268_435_456);
    expect(routes).toContain(`less than ${MIN_FREE_BYTES} bytes (${MIN_FREE_BYTES / 1024 ** 2} MiB) free in the temporary directory`);
    expect(DISK_TTL_MS).toBe(60_000);
    expect(routes).toContain('The check is made at most once a minute, in the background: a request is answered from the last one and never waits. Before the first check has answered it is `ok`.');
    expect(routes).toContain(`It is read up to ${MAX_BODY} bytes.`);
    expect(routes).toContain(`A job has its own deadline, ${JOB_DEADLINE_MS} ms after its request arrives, 60 s inside the runtime's \`SERVICE_TIMEOUT_MS\` of ${JOB_DEADLINE_MS + 60_000}.`);
    expect(routes).toContain(`The speech recognition gets the smaller of ${ASR_MAX_MS} ms and the time the job has left, ${CLIPS_RESERVE_MS} ms less of it when clips are asked for, and is not started when that comes to under ${ASR_MIN_MS} ms.`);
    expect(HEARTBEAT_MS).toBe(60_000);
    expect(routes).toContain('writes an interim `102 Processing` line every 60 s');
  });

  test('Errors names the three codes that get the fixed message, and they are the codes of a job with a status of 500 or more', () => {
    const errors = section('Errors');
    expect(errors).toContain("A failure on the service's side (`asr_failed`, `clip_failed` and `low_disk`) gets a fixed message");
    const codes: SnippetsErrorCode[] = ['deadline', 'asr_failed', 'clip_failed', 'low_disk'];
    expect(codes.filter((code) => new SnippetsError(code, 'x').status >= 500)).toStrictEqual(['asr_failed', 'clip_failed', 'low_disk']);
    expect(errors).toContain('`shutting_down` says in words that the service is stopping.');
    expect(errors).toContain('Anything else is 500 `{"error":"internal"}` with no detail');
    expect(errors).toContain('The 401 has no message at all.');
  });

  test('Matching states the thresholds of the code and the clips the way clips.ts cuts them', () => {
    const matching = section('Matching');
    expect([QUOTE_MIN_SCORE, QUERY_MIN_SCORE, QUERY_MAX_MATCHES, PAD_S]).toStrictEqual([0.55, 0.2, 3, 0.15]);
    expect(matching).toContain('at or above 0.55 the quote is a match, and under it the quote is listed in `unmatched` with its best score');
    expect(matching).toContain('at or above 0.2, at most 3 segments, adjacent ones merged');
    expect(matching).toContain('150 ms of padding is added on each side, within the media');
    expect(matching).toContain('0.7 n rounded down to 1.3 n rounded up words (at least one)');
    expect(matching).toContain('Every number of the result is rounded to 3 decimals.');
    expect(MP3_BITRATE).toBe('64k');
    expect(matching).toContain('as MP3 at 64 kbps or as WAV');
    expect(matching).toContain(`stays at or under ${INLINE_CLIPS_BYTES} bytes`);
  });

  test('Stopping and Image say what the compose file and the Dockerfile say', () => {
    const compose = textOf('../../deploy/host/docker-compose.audio-snippets.yml');
    const dockerfile = textOf('Dockerfile');
    expect(compose).toContain('stop_grace_period: 330s');
    expect(SHUTDOWN_WAIT_MS / 1000 + 30).toBe(330);
    expect(section('Stopping')).toContain('`stop_grace_period` in the compose file is 330 s: the 300 s of the wait and 30 s more');
    expect(compose).toContain('mem_limit: 3072m');
    expect(section('Image')).toContain('the compose file gives it 3072m');
    expect(dockerfile.match(/^FROM /gm)).toHaveLength(3);
    expect(section('Image')).toContain('builds the service image in three stages');
    expect(dockerfile).toContain('ARG WHISPER_MODEL=base');
    expect(section('Image')).toContain('the build argument `WHISPER_MODEL` (`base` by default)');
    expect(dockerfile).toContain(`EXPOSE ${PORT_DEFAULT}`);
    expect(section('Image')).toContain(`listens on ${PORT_DEFAULT}`);
    expect(dockerfile).toContain('ENTRYPOINT ["/usr/bin/tini", "--"]');
    expect(dockerfile).toMatch(/^USER node$/m);
    expect(dockerfile).not.toMatch(/^VOLUME /m);
    expect(section('Image')).toContain('runs as the `node` user under `tini`');
    expect(section('Image')).toContain('It has no volume.');
    expect(dockerfile).toContain('PATH=/app/asr/venv/bin:$PATH');
    expect(section('Image')).toContain('the venv first on the path');
  });

  test('The speech model section describes the bridge the way asr.ts and worker.py have it', () => {
    const asrSource = sources.find(({ file }) => file === 'asr.ts')?.text ?? '';
    expect(asrSource).toContain("settings.pythonArgs ?? ['-I']");
    expect(asrSource).toContain('const LOG_LINES = 20;');
    const speech = section('The speech model');
    expect(speech).toContain("as `python3 -I <worker>` (Python's isolated mode)");
    expect(speech).toContain('flat and at most 20 lines');
    expect(speech).toContain('`beam_size` 5 and `temperature` 0.0 alone, so that the same audio gives the same transcript on the same host.');
    const worker = textOf('asr/worker.py');
    for (const part of ['device="cpu"', 'beam_size=5', 'temperature=0.0', 'word_timestamps=True', 'vad_filter=False']) expect(worker, part).toContain(part);
    expect(worker).toContain('Python 3.9 or later');
    expect(readme).toContain('a Python of 3.9 or later');
  });

  test('Tests and Run it name files that exist, and the defaults of test/support.ts and of fetch_model.py', () => {
    for (const path of ['asr/test_worker.py', 'asr/fetch_model.py', 'asr/requirements.txt', 'asr/worker.py', 'test/fixtures/speech-20s.mp3']) {
      expect(readme, path).toContain(path);
      expect(existsSync(here(path)), path).toBe(true);
    }
    const support = textOf('test/support.ts');
    expect(support).toContain("process.env.REQUIRE_ASR === '1'");
    expect(support).toContain("process.env.ASR_PYTHON ?? 'python3'");
    expect(support).toContain("new URL('../.models/base', import.meta.url)");
    expect(section('Tests')).toContain('`REQUIRE_ASR=1`');
    expect(section('Tests')).toContain('default `.models/base` of this folder');
    expect(textOf('asr/fetch_model.py')).toContain('python3 -I fetch_model.py SIZE DEST');
    expect(section('Run it')).toContain('python3 -I asr/fetch_model.py base .models/base');
  });

  test('the statuses of the codes the kit answers with are the kit\'s, read from packages/service-kit: the wire message, the token, the stop, a failure with no refusal, the slot, a route that is not there', () => {
    const kitServer = kitSources.find(({ file }) => file === 'server.ts')?.text ?? '';
    const sent = (code: string): number => Number(new RegExp(`send\\((\\d{3}), \\{ error: '${code}'`).exec(kitServer)?.[1]);
    const statuses: Record<string, number> = {
      bad_wire: new WireError('bad_wire', 'x').status, request_too_large: new WireError('request_too_large', 'x').status, unauthorized: sent('unauthorized'),
      shutting_down: sent('shutting_down'), internal: sent('internal'), busy: sent('busy'), not_found: sent('not_found'),
    };
    expect(statuses).toStrictEqual({ bad_wire: 400, request_too_large: 400, unauthorized: 401, shutting_down: 503, internal: 500, busy: 409, not_found: 404 });
    const rows = section('Errors').split('\n').filter((line) => /^\| \d{3}, /.test(line));
    for (const code of ['bad_wire', 'request_too_large', 'unauthorized', 'shutting_down', 'internal']) {
      expect(rows.find((line) => ticks(line.split('|')[2]).includes(code)), code).toMatch(new RegExp(`^\\| ${statuses[code]}, `));
    }
    expect(section('Routes')).toContain(`gets ${statuses.busy} \`{"error":"busy"}\``);
    expect(section('Routes')).toContain(`| any other route | ${statuses.not_found} \`{"error":"not_found"}\` |`);
    expect(section('Routes')).toContain(`gets ${statuses.unauthorized} \`{"error":"unauthorized"}\``);
  });

  test('the values the README gives are the code\'s: the pinned versions of the speech model, the host and the worker by default, and the length from which the token is looked for', () => {
    const requirements = textOf('asr/requirements.txt');
    const pinned = (name: string): string => new RegExp(`^${name}==(\\S+)$`, 'm').exec(requirements)?.[1] ?? '';
    expect([pinned('faster-whisper'), pinned('ctranslate2')]).toStrictEqual(['1.2.1', '4.8.2']);
    expect(section('Run it')).toContain(`\`asr/requirements.txt\` pins faster-whisper ${pinned('faster-whisper')} and ctranslate2 ${pinned('ctranslate2')}`);
    const config = loadConfig(FULL_ENV);
    const row = (name: string): string => section('Manifest').split('\n').find((line) => line.startsWith(`| \`${name}\``)) ?? '';
    expect(row('PORT')).toContain(`| \`${config.port}\`, \`${config.host}\` |`);
    expect(config.asr.worker).toBe(WORKER_PATH);
    expect(WORKER_PATH.replace(/\\/g, '/')).toMatch(/\/agents\/audio-snippets\/asr\/worker\.py$/);
    expect(row('ASR_WORKER')).toContain('the image sets `/app/asr/worker.py` | `asr/worker.py` of this folder |');
    expect(textOf('Dockerfile')).toContain(' ASR_WORKER=/app/asr/worker.py ');
    expect(TOKEN_SEARCH_MIN).toBe(16);
    expect(section('Run it')).toContain(`each when it is ${TOKEN_SEARCH_MIN} characters or more`);
  });

  test('Run it says where a matching key pair comes from, and those places make one', () => {
    expect(section('Run it')).toContain("`SUPPLIER_PKH` and `SUPPLIER_PUB_KEY_HEX` must be the key hash and the public key of one key pair, or the service does not start: on the host, step 4 of `deploy/host/RUNBOOK-audio-snippets.md` makes the pair with `gen-keypair`; the tests make theirs in `test/server-support.ts`, a public key from a label and its blake2b-224 as the key hash, and `test/start.test.ts` starts the service with it.");
    const runbook = textOf('../../deploy/host/RUNBOOK-audio-snippets.md');
    expect((runbook.split('\n## 4. ')[1] ?? '').split('\n## ')[0]).toContain('agent/src/cli/gen-keypair.ts');
    expect(textOf('test/server-support.ts')).toContain('export const SUPPLIER = { pubKeyHex, pkh: blake2b224Hex(pubKeyHex) };');
    expect(textOf('test/start.test.ts')).toContain("from './server-support.ts'");
  });

  test('the Manifest section names the four placeholders of the template and the script that renders it', () => {
    expect(Object.values(TEMPLATE_ENV)).toStrictEqual(['<OPERATOR_CONTACT>', '<AGENT_DID>', '<SUPPLIER_PKH>', '<SUPPLIER_PUB_KEY_HEX>']);
    for (const placeholder of Object.values(TEMPLATE_ENV)) expect(readme, placeholder).toContain(`\`${placeholder}\``);
    expect(JSON.parse(textOf('package.json')).scripts.template).toBe('node --import tsx scripts/render-template.mjs');
    expect(section('Manifest')).toContain('`pnpm --filter @vsa/audio-snippets template`');
    expect(existsSync(here('scripts/render-template.mjs'))).toBe(true);
    expect(section('Manifest')).toContain('with the four placeholders');
  });
});
