// agents/audio-snippets/src/asr.ts
// The bridge to the speech model (ruling R-D2): one Python process per job, `<python> -I <worker>`, the request as JSON on its stdin and the transcript as
// JSON on its stdout, with a hard time limit and an output limit. -I is Python's isolated mode: no PYTHON* variable, no user site-packages, no folder of the
// script on the path. Its environment is the service's without the token and without any name that holds a key, a token, a secret or a password (childEnv
// of packages/service-kit). The model runs on the operator's host from files built into the image, so nothing is fetched while a job runs. What the worker
// writes on stderr goes to the log, flat and bounded; the log carries job outcomes and never a transcript, and the worker writes none there.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { childEnv, errorText, flatText } from '@vsa/service-kit';

/** The worker of this repository. The image runs its copy at /app/asr/worker.py (ASR_WORKER). */
export const WORKER_PATH = fileURLToPath(new URL('../asr/worker.py', import.meta.url));
/** The most the worker may write on stdout: the transcript of 10 min is about 150 KB. */
export const STDOUT_LIMIT = 16 * 1024 * 1024;
/** How long the check of the start may take: it imports faster-whisper, which loads ctranslate2. */
export const CHECK_TIMEOUT_MS = 60_000;
const STDERR_KEPT = 64 * 1024;
const LOG_LINES = 20;

export interface AsrWord { w: string; start: number; end: number }
export interface AsrSegment { start: number; end: number; text: string; words: AsrWord[] }
export interface AsrTranscript { language: string; language_probability: number; duration: number; segments: AsrSegment[] }
export interface AsrSettings {
  /** The Python that runs the worker: python3 by default (the image puts its venv first on PATH). */
  python: string;
  /** The flags it is started with: ['-I'] by default; a test that plays the worker with node passes []. */
  pythonArgs?: readonly string[];
  worker: string;
  modelDir: string;
  threads: number;
  computeType: 'int8';
}

/** Why a recognition failed: it ran out of time, the worker failed or could not be started, or what it wrote is no transcript of the contract. */
export class AsrError extends Error {
  readonly reason: 'timeout' | 'failed' | 'bad_output';
  constructor(reason: 'timeout' | 'failed' | 'bad_output', message: string) {
    super(message);
    this.name = 'AsrError';
    this.reason = reason;
  }
}

export interface Asr {
  /** The transcript of the WAV, in `language` (null: the model detects it from the first 30 s), within `timeoutMs`. */
  transcribe(wav: string, language: string | null, timeoutMs: number): Promise<AsrTranscript>;
  /** Made once at start: resolves with the versions when faster-whisper imports and the model files are there, and rejects with the reason otherwise. */
  check(): Promise<{ faster_whisper: string; ctranslate2: string }>;
}

interface Run { code: number | null; stdout: string; stderr: string; timedOut: boolean; tooLong: boolean }

function runWorker(settings: AsrSettings, args: readonly string[], input: string, timeoutMs: number, spawnImpl: typeof spawn): Promise<Run> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const child = spawnImpl(settings.python, [...(settings.pythonArgs ?? ['-I']), settings.worker, ...args], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: childEnv(process.env) });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outBytes = 0;
    let errBytes = 0;
    let timedOut = false;
    let tooLong = false;
    const kill = (): void => { try { child.kill('SIGKILL'); } catch { /* gone already */ } };
    process.once('exit', kill); // a service that exits takes its worker with it
    const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
    timer.unref();
    const settle = (): boolean => {
      if (settled) return false;
      settled = true;
      clearTimeout(timer);
      process.off('exit', kill);
      return true;
    };
    child.stdout?.on('data', (chunk: Buffer) => {
      outBytes += chunk.length;
      if (outBytes > STDOUT_LIMIT) { tooLong = true; kill(); } else out.push(chunk);
    });
    child.stderr?.on('data', (chunk: Buffer) => { if (errBytes < STDERR_KEPT) { err.push(chunk); errBytes += chunk.length; } });
    child.on('error', (error) => { if (settle()) reject(error); }); // it could not be started
    child.on('close', (code) => { if (settle()) resolve({ code, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8'), timedOut, tooLong }); });
    child.stdin?.on('error', () => undefined); // a worker that exits before it reads its input
    child.stdin?.end(input);
  });
}

/** What a failed worker said: its own error and message, flat, or else the last line it wrote on stderr. */
function failureOf(run: Run): string {
  try {
    const said = JSON.parse(run.stdout) as { ok?: unknown; error?: unknown; message?: unknown };
    if (said.ok === false && typeof said.error === 'string') return `${flatText(said.error, 40)}: ${flatText(String(said.message ?? ''), 300)}`;
  } catch { /* not an answer of the worker */ }
  const last = run.stderr.trim().split(/\r?\n/).at(-1) ?? '';
  return last === '' ? 'no message' : flatText(last, 300);
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The transcript in what the worker wrote, held to the contract: every field of its type, every word a text with two times. Anything else is bad_output. */
export function parseTranscript(text: string): AsrTranscript {
  let answer: unknown;
  try { answer = JSON.parse(text); } catch { throw new AsrError('bad_output', 'the speech model wrote something that is not JSON'); }
  const bad = (what: string) => new AsrError('bad_output', `the speech model wrote a transcript with ${what}`);
  if (!isRecord(answer) || answer.ok !== true) throw bad('no ok');
  if (typeof answer.language !== 'string' || !/^[a-z]{2,3}$/.test(answer.language)) throw bad('no language code');
  if (!finite(answer.language_probability) || !finite(answer.duration) || !Array.isArray(answer.segments)) throw bad('a field of the wrong type');
  const segments = answer.segments.map((segment: unknown, i: number) => {
    if (!isRecord(segment) || !finite(segment.start) || !finite(segment.end) || typeof segment.text !== 'string' || !Array.isArray(segment.words)) throw bad(`segment ${i} of the wrong shape`);
    const words = segment.words.map((word: unknown, j: number) => {
      if (!isRecord(word) || typeof word.w !== 'string' || word.w === '' || !finite(word.start) || !finite(word.end)) throw bad(`word ${j} of segment ${i} of the wrong shape`);
      return { w: word.w, start: word.start, end: word.end };
    });
    return { start: segment.start, end: segment.end, text: segment.text, words };
  });
  return { language: answer.language, language_probability: answer.language_probability, duration: answer.duration, segments };
}

export function workerAsr(settings: AsrSettings, opts: { spawnImpl?: typeof spawn; log?: (line: string) => void } = {}): Asr {
  const spawnImpl = opts.spawnImpl ?? spawn;
  const logLines = (stderr: string): void => {
    if (opts.log === undefined) return;
    for (const line of stderr.split(/\r?\n/).filter((l) => l.trim() !== '').slice(0, LOG_LINES)) opts.log(`asr: ${flatText(line, 300)}`);
  };
  return {
    async transcribe(wav, language, timeoutMs) {
      const request = JSON.stringify({ wav, language, model_dir: settings.modelDir, threads: settings.threads, compute_type: settings.computeType });
      let run: Run;
      try {
        run = await runWorker(settings, [], request, timeoutMs, spawnImpl);
      } catch (error) {
        throw new AsrError('failed', `the speech model could not be started: ${errorText(error)}`);
      }
      logLines(run.stderr);
      if (run.timedOut) throw new AsrError('timeout', `the speech model did not finish within ${timeoutMs} ms`);
      if (run.tooLong) throw new AsrError('bad_output', `the speech model wrote more than ${STDOUT_LIMIT} bytes`);
      if (run.code !== 0) throw new AsrError('failed', `the speech model failed (exit ${run.code}): ${failureOf(run)}`);
      return parseTranscript(run.stdout);
    },
    async check() {
      let run: Run;
      try {
        run = await runWorker(settings, ['--check', settings.modelDir], '', CHECK_TIMEOUT_MS, spawnImpl);
      } catch (error) {
        throw new Error(`${settings.python} cannot be run (${errorText(error)}): Python 3 with faster-whisper must be installed, as the image has it`, { cause: error });
      }
      if (run.timedOut) throw new Error(`the speech model check did not answer within ${CHECK_TIMEOUT_MS / 1000} s`);
      let said: { ok?: unknown; faster_whisper?: unknown; ctranslate2?: unknown } = {};
      try { said = JSON.parse(run.stdout) as typeof said; } catch { /* refused below */ }
      if (run.code !== 0 || said.ok !== true) {
        throw new Error(`the speech model is not ready (${failureOf(run)}): the image builds faster-whisper and the model in; outside it, install asr/requirements.txt and fetch the model with asr/fetch_model.py`);
      }
      return { faster_whisper: String(said.faster_whisper), ctranslate2: String(said.ctranslate2) };
    },
  };
}
