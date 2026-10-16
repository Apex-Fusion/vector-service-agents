// agents/audio-snippets/test/fixtures/make-fixtures.mjs
// Makes the two fixtures of the tests, with the ffmpeg on PATH. Run from the repository root:
//   node agents/audio-snippets/test/fixtures/make-fixtures.mjs <the downloaded LibriVox mp3>
// tone-3s.wav: 3 s of a 440 Hz sine, 16 kHz, mono, 16-bit PCM, made by ffmpeg's own sine source, so it needs no download. A WAV has no codec to differ between
// hosts, and its PCM is the audio the speech model hears, so the clip tests can compare samples byte for byte.
// speech-20s.mp3: the first 25 s of a public-domain LibriVox recording ("The Schwartz-Metterklume Method", Short Story Collection Vol. 036, 2009, archive.org
// item short_story_036_0904_librivox, file shortstory036_schwartzmetterklume_aw_64kb.mp3, sha1 335a31f7cab5e1de94140454f25016d6e3644abe), re-encoded to
// mono 16 kHz MP3 at 32 kbps with no tags (-map_metadata -1 drops the ID3 tags of the source, which name the reader). Nothing else of the source is kept.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = (name) => fileURLToPath(new URL(`./${name}`, import.meta.url));
const ffmpeg = (args) => execFileSync('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', ...args], { stdio: ['ignore', 'inherit', 'inherit'] });
const report = (name) => { const bytes = readFileSync(here(name)); console.log(`${name}: ${bytes.length} bytes, sha256 ${createHash('sha256').update(bytes).digest('hex')}`); };

ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=16000:duration=3', '-ac', '1', '-c:a', 'pcm_s16le', '-bitexact', '-map_metadata', '-1', '-f', 'wav', '-y', here('tone-3s.wav')]);
report('tone-3s.wav');
const source = process.argv[2];
if (source === undefined) {
  console.log('speech-20s.mp3: not made (give the downloaded LibriVox mp3 as the argument)');
} else {
  const sha1 = createHash('sha1').update(readFileSync(source)).digest('hex');
  const KNOWN = ['335a31f7cab5e1de94140454f25016d6e3644abe', '6079d4d265b9f7fba0175451d00dfbe985c871ad'];
  if (!KNOWN.includes(sha1)) { console.error(`the source has sha1 ${sha1}, which is neither of the two LibriVox files of the plan`); process.exit(2); }
  ffmpeg(['-i', source, '-t', '25', '-map', '0:a:0', '-map_metadata', '-1', '-ac', '1', '-ar', '16000', '-c:a', 'libmp3lame', '-b:a', '32k', '-bitexact', '-id3v2_version', '0', '-write_xing', '0', '-f', 'mp3', '-y', here('speech-20s.mp3')]);
  report('speech-20s.mp3');
}
