// agents/audio-snippets/test/fixtures/stand-in-worker.mjs
// Plays asr/worker.py for the tests of src/asr.ts, run by node (pythonArgs []): what it does is named by the file name of the WAV it is asked for.
import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
if (args[0] === '--check') {
  if (args[1].endsWith('missing')) {
    process.stdout.write(JSON.stringify({ ok: false, error: 'model_missing', message: 'the model directory lacks model.bin' }));
    process.exit(1);
  }
  process.stdout.write(JSON.stringify({ ok: true, faster_whisper: 'stand-in', ctranslate2: 'stand-in' }));
  process.exit(0);
}
const request = JSON.parse(readFileSync(0, 'utf8'));
const name = request.wav.split(/[\\/]/).pop();
const TRANSCRIPT = { ok: true, language: request.language ?? 'en', language_probability: 0.97, duration: 3, segments: [{ start: 0, end: 1.2, text: 'This is a LibriVox recording.', words: [{ w: 'This', start: 0.1, end: 0.25 }] }] };
if (name === 'ok.wav') process.stdout.write(JSON.stringify(TRANSCRIPT));
else if (name === 'echo.wav') process.stdout.write(JSON.stringify({ ...TRANSCRIPT, segments: [{ start: 0, end: 1, text: JSON.stringify(request), words: [] }] }));
else if (name === 'slow.wav') setTimeout(() => process.stdout.write(JSON.stringify(TRANSCRIPT)), 10_000);
else if (name === 'fails.wav') { process.stdout.write(JSON.stringify({ ok: false, error: 'transcribe_failed', message: 'the decoder\nbroke' })); process.exitCode = 4; }
else if (name === 'crashes.wav') { process.stderr.write('Traceback (most recent call last):\nRuntimeError: out of memory\n'); process.exitCode = 1; }
else if (name === 'garbage.wav') process.stdout.write('not json');
else if (name === 'shape.wav') process.stdout.write(JSON.stringify({ ...TRANSCRIPT, segments: [{ start: 0, end: 'x', text: '', words: [] }] }));
else if (name === 'flood.wav') for (let i = 0; i < 40; i++) process.stdout.write('x'.repeat(1024 * 1024));
else if (name === 'chatty.wav') { for (let i = 0; i < 30; i++) process.stderr.write(`warning ${i}\u001b[31m\n`); process.stdout.write(JSON.stringify(TRANSCRIPT)); }
