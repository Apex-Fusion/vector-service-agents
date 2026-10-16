// agents/audio-snippets/test/asr-real.test.ts
// The real worker and the real model on the speech fixture. They run where ASR_PYTHON imports faster-whisper and the model files are at WHISPER_MODEL_DIR
// (agents/audio-snippets/.models/base by default), with ffmpeg on PATH; CI, the host and the implementers' machine set REQUIRE_ASR=1, and there a missing piece fails instead of skipping.
// The expected times are in test/fixtures/speech-20s.expected.json, measured on the audio itself by test/fixtures/measure-speech.mjs (ffmpeg's silencedetect),
// and held here as ruling R-D18 has it (the design, section 7.4, amended for the onset). The model starts the first word after a pause early, by its
// cross-attention timing, while the ends of words land on the pauses: so the first word of the sentence may start up to 1.0 s before the end of the pause
// before it and at most 0.3 s after it, and its last word ends within 0.3 s of the start of the pause after it.
import { describe, test, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WORKER_PATH, workerAsr } from '../src/asr.ts';
import type { AsrTranscript } from '../src/asr.ts';
import { WHISPER_LANGUAGES } from '../src/languages.ts';
import { decode, mediaTools } from '../src/media.ts';
import { tokensOf } from '../src/normalize.ts';
import { ASR_PYTHON, ASR_READY, MEDIA_TOOLS, MODEL_DIR, REQUIRE_ASR, SPEECH_MP3, fixturePath } from './support.ts';

const EXPECTED = JSON.parse(readFileSync(new URL('./fixtures/speech-20s.expected.json', import.meta.url), 'utf8')) as { sha256: string; sentence: string; onset_s: number; offset_s: number };
const READY = ASR_READY && MEDIA_TOOLS;
const asr = workerAsr({ python: ASR_PYTHON, worker: WORKER_PATH, modelDir: MODEL_DIR, threads: 4, computeType: 'int8' });
const dir = mkdtempSync(join(tmpdir(), 'snippets-asr-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
let wav: string | undefined;
async function speechWav(): Promise<string> {
  wav ??= (await decode({ path: fixturePath('speech-20s.mp3'), family: 'mp3' }, dir, mediaTools())).path;
  return wav;
}
/** The words of the sentence in a transcript: "all", any word (the model may spell LibriVox otherwise), then the six words that end it. */
function sentenceIn(t: AsrTranscript): { first: { start: number }; last: { end: number } } | null {
  const words = t.segments.flatMap((s) => s.words).map((w) => ({ ...w, token: tokensOf(w.w).join(' ') }));
  const tail = ['recordings', 'are', 'in', 'the', 'public', 'domain'];
  for (let i = 2; i + tail.length <= words.length; i++) {
    if (words[i - 2].token === 'all' && tail.every((t2, k) => words[i + k].token === t2)) return { first: words[i - 2], last: words[i + tail.length - 1] };
  }
  return null;
}

describe('the real speech model', { timeout: 300_000 }, () => {
  test.skipIf(!REQUIRE_ASR)('REQUIRE_ASR is set: ffmpeg, Python with faster-whisper and the model files are there', () => { expect({ ASR_READY, MEDIA_TOOLS }).toStrictEqual({ ASR_READY: true, MEDIA_TOOLS: true }); });

  test.skipIf(!ASR_READY)('the check of the worker answers the pinned versions', async () => {
    expect(await asr.check()).toStrictEqual({ faster_whisper: '1.2.1', ctranslate2: '4.8.2' });
  });

  test.skipIf(!ASR_READY)('the 100 languages of src/languages.ts are those of the installed library, in its order', () => {
    const run = spawnSync(ASR_PYTHON, ['-I', '-c', "import faster_whisper.tokenizer as t; print(' '.join(t._LANGUAGE_CODES))"], { encoding: 'utf8' });
    expect(run.stdout.trim().split(' ')).toStrictEqual([...WHISPER_LANGUAGES]);
  });

  test.skipIf(!READY)('the speech fixture is the one the expected times were measured on', () => {
    expect(createHash('sha256').update(SPEECH_MP3).digest('hex')).toBe(EXPECTED.sha256);
  });

  test.skipIf(!READY)('the sentence of the preamble is in the transcript, its first word from 1.0 s before to 0.3 s after the pause before it ends, its last word within 0.3 s of the pause after it (R-D18)', async () => {
    const t = await asr.transcribe(await speechWav(), 'en', 240_000);
    expect(t.language).toBe('en');
    const found = sentenceIn(t);
    expect(found, JSON.stringify(t.segments.map((s) => s.text))).not.toBeNull();
    const onset = found!.first.start - EXPECTED.onset_s;
    expect(onset).toBeGreaterThanOrEqual(-1.0);
    expect(onset).toBeLessThanOrEqual(0.3);
    expect(Math.abs(found!.last.end - EXPECTED.offset_s)).toBeLessThanOrEqual(0.3);
  });

  test.skipIf(!READY)('auto detects English and says so; the same audio twice gives the same transcript, word for word and time for time', async () => {
    const first = await asr.transcribe(await speechWav(), null, 240_000);
    expect(first.language).toBe('en');
    expect(first.language_probability).toBeGreaterThan(0.5);
    expect(await asr.transcribe(await speechWav(), null, 240_000)).toStrictEqual(first);
  });

  // Review Focus 4: a wrong language is the hirer's to choose; the model is asked for it and the answer says so.
  test.skipIf(!READY)('a wrong language still gives a transcript of the contract, made in the language that was asked for', async () => {
    const t = await asr.transcribe(await speechWav(), 'de', 240_000);
    expect(t.language).toBe('de');
    expect(Array.isArray(t.segments)).toBe(true);
  });
});
