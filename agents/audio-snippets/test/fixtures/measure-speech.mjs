// agents/audio-snippets/test/fixtures/measure-speech.mjs
// Measures the times of the pinned sentence of speech-20s.mp3 and, when they are within the bounds below, writes speech-20s.expected.json beside it; out of
// the bounds it prints its line, writes nothing and exits 1. Run once, when the fixture is made, from the
// repository root (Git Bash, the implementers' machine):
//   ASR_PYTHON=python WHISPER_MODEL_DIR=agents/audio-snippets/.models/base node --import tsx agents/audio-snippets/test/fixtures/measure-speech.mjs
// The times come from the audio itself: ffmpeg's silencedetect on the decoded 16 kHz audio, with the pause before the sentence ending at its onset and the pause
// after it starting at its offset. The speech model is asked only which pauses those are: its first and last word of the sentence each sit within 1 s of one.
// test/asr-real.test.ts then holds the model's times to these as ruling R-D18 has it: the first word from 1.0 s before to 0.3 s after onset_s (the model
// starts the first word after a pause early), the last word within 0.3 s of offset_s. The line it prints gives both differences, the bounds and the verdict.
// A failure sets the exit code and returns, so that the temporary folder is removed on every path.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WORKER_PATH, workerAsr } from '../../src/asr.ts';
import { decode, mediaTools } from '../../src/media.ts';
import { tokensOf } from '../../src/normalize.ts';

const SENTENCE = 'All LibriVox recordings are in the public domain.';
const TAIL = ['recordings', 'are', 'in', 'the', 'public', 'domain'];
const SILENCE = 'silencedetect=noise=-35dB:d=0.2';
const here = (name) => fileURLToPath(new URL(`./${name}`, import.meta.url));
const round3 = (x) => Math.round(x * 1000) / 1000;
/** Measures in `dir`; on a failure it prints why, sets the exit code 1 and returns. */
async function measure(dir) {
  const wav = (await decode({ path: here('speech-20s.mp3'), family: 'mp3' }, dir, mediaTools())).path;
  const asr = workerAsr({ python: process.env.ASR_PYTHON ?? 'python3', worker: WORKER_PATH, modelDir: process.env.WHISPER_MODEL_DIR ?? fileURLToPath(new URL('../../.models/base', import.meta.url)), threads: 4, computeType: 'int8' });
  const transcript = await asr.transcribe(wav, 'en', 240_000);
  const words = transcript.segments.flatMap((s) => s.words).map((w) => ({ ...w, token: tokensOf(w.w).join(' ') }));
  let at = -1;
  for (let i = 2; i + TAIL.length <= words.length; i++) if (words[i - 2].token === 'all' && TAIL.every((t, k) => words[i + k].token === t)) { at = i; break; }
  if (at < 0) { console.error(`the sentence is not in the transcript: ${transcript.segments.map((s) => s.text).join(' | ')}`); process.exitCode = 1; return; }
  const first = words[at - 2];
  const last = words[at + TAIL.length - 1];
  // silencedetect writes its lines at the info level, on stderr: ffmpeg is run without -loglevel error, and its stderr is read.
  const log = spawnSync('ffmpeg', ['-nostdin', '-hide_banner', '-nostats', '-i', wav, '-af', SILENCE, '-f', 'null', '-'], { encoding: 'utf8' }).stderr;
  const ends = [...log.matchAll(/silence_end: ([\d.]+)/g)].map((m) => Number(m[1]));
  const starts = [...log.matchAll(/silence_start: ([\d.]+)/g)].map((m) => Number(m[1]));
  const nearest = (list, t) => list.reduce((best, x) => (best === null || Math.abs(x - t) < Math.abs(best - t) ? x : best), null);
  const onset = nearest(ends, first.start);
  const offset = nearest(starts, last.end);
  if (onset === null || offset === null || Math.abs(onset - first.start) > 1 || Math.abs(offset - last.end) > 1) {
    console.error(`no pause within 1 s of the sentence: words ${first.start} to ${last.end}, pauses end at ${ends.join(', ')} and start at ${starts.join(', ')}`);
    process.exitCode = 1;
    return;
  }
  const expected = {
    fixture: 'speech-20s.mp3', sha256: createHash('sha256').update(readFileSync(here('speech-20s.mp3'))).digest('hex'), sentence: SENTENCE,
    onset_s: round3(onset), offset_s: round3(offset),
    measured_by: `ffmpeg ${SILENCE} on the decoded 16 kHz audio: the pause before the sentence ends at onset_s, the pause after it starts at offset_s`,
  };
  const differences = [round3(first.start - onset), round3(last.end - offset)];
  // Ruling R-D18: the first word after a pause may start up to 1.0 s early and at most 0.3 s late; the last word ends within 0.3 s of the pause after it.
  const bounds = { onset: [-1, 0.3], offset: [-0.3, 0.3] };
  const within = differences[0] >= bounds.onset[0] && differences[0] <= bounds.onset[1] && differences[1] >= bounds.offset[0] && differences[1] <= bounds.offset[1];
  console.log(JSON.stringify({ ...expected, model_first_start: first.start, model_last_end: last.end, differences_s: differences, bounds_s: bounds, within_bounds: within }));
  // Times out of the bounds are never written: the line above is the report, and the file keeps the times it had.
  if (within) writeFileSync(here('speech-20s.expected.json'), `${JSON.stringify(expected, null, 2)}\n`, 'utf8');
  else process.exitCode = 1;
}

const dir = mkdtempSync(join(tmpdir(), 'measure-speech-'));
try {
  await measure(dir);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
