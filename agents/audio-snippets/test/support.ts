// agents/audio-snippets/test/support.ts
// Shared by the tests: the fixtures, the tools on PATH, the Python of the speech model and its model directory, and audio made by ffmpeg for a test.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TestContext } from 'vitest';

export const fixture = (name: string): Uint8Array => new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));
export const fixturePath = (name: string): string => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
/** 3 s of a 440 Hz sine, 16 kHz mono 16-bit PCM WAV: 96044 bytes. */
export const TONE_WAV = fixture('tone-3s.wav');
/** test/fixtures/speech-20s.mp3 is there. It is cut from a download that waits for approval (ruling R-D14), so it may be absent: the tests that need it skip until it is made. */
export const SPEECH_READY = existsSync(fixturePath('speech-20s.mp3'));
/** Why a test that needs the speech fixture is skipped while the file is absent. */
export const SPEECH_PENDING = 'speech fixture not yet made (download pending approval)';
/** The first 25 s of a public-domain LibriVox recording, mono 16 kHz MP3 (test/fixtures/make-fixtures.mjs). Empty while the file is absent: see SPEECH_READY. */
export const SPEECH_MP3 = SPEECH_READY ? fixture('speech-20s.mp3') : new Uint8Array(0);
/** Called first in a test that needs the speech fixture: skips that test, with its reason, while the file is absent. Nothing else of the test changes when the file comes. */
export const skipUntilSpeech = (ctx: TestContext): void => { if (!SPEECH_READY) ctx.skip(SPEECH_PENDING); };
export const toBase64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64');
export const text = (s: string): Uint8Array => new TextEncoder().encode(s);

const runs = (file: string, args: string[]): boolean => { const r = spawnSync(file, args, { stdio: 'ignore' }); return r.error === undefined && r.status === 0; };
/** ffmpeg and ffprobe are on PATH. */
export const MEDIA_TOOLS = runs('ffmpeg', ['-version']) && runs('ffprobe', ['-version']);
/** CI, the host (step 2 of its runbook) and the implementers' machine set REQUIRE_ASR=1: then a missing tool, Python, faster-whisper or model fails its test instead of skipping it. */
export const REQUIRE_ASR = process.env.REQUIRE_ASR === '1';
/** The Python of the speech model: ASR_PYTHON, python3 by default (on the implementers' Windows machine, python). */
export const ASR_PYTHON = process.env.ASR_PYTHON ?? 'python3';
/** Python 3.9 or later runs: enough for the contract test of the worker, which stubs the model. */
export const PYTHON_READY = runs(ASR_PYTHON, ['-I', '-c', 'import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)']);
/** The model directory: WHISPER_MODEL_DIR, or agents/audio-snippets/.models/base, where asr/fetch_model.py puts it on a developer's machine. */
export const MODEL_DIR = process.env.WHISPER_MODEL_DIR ?? fileURLToPath(new URL('../.models/base', import.meta.url));
/** faster-whisper imports and the model files are there: the real-model tests run. */
export const ASR_READY = runs(ASR_PYTHON, ['-I', '-c', 'import faster_whisper']) && existsSync(join(MODEL_DIR, 'model.bin'));

/** Makes `name` in `dir` with ffmpeg from `args` (the input and output options; -y and the path are added) and returns its path. */
export function makeMedia(dir: string, name: string, args: string[]): string {
  const out = join(dir, name);
  const r = spawnSync('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', ...args, '-y', out], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`ffmpeg could not make ${name}: ${r.stderr}`);
  return out;
}
