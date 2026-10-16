// agents/audio-snippets/test/fixtures/make-fixtures.mjs
// Makes the two fixtures of the tests, with the ffmpeg on PATH. Run from the repository root:
//   node agents/audio-snippets/test/fixtures/make-fixtures.mjs <the downloaded LibriVox mp3>
// tone-3s.wav: 3 s of a 440 Hz sine, 16 kHz, mono, 16-bit PCM, made by ffmpeg's own sine source, so it needs no download. A WAV has no codec to differ between
// hosts, and its PCM is the audio the speech model hears, so the clip tests can compare samples byte for byte.
// speech-20s.mp3: 25 s of a public-domain LibriVox recording ("The Schwartz-Metterklume Method", Short Story Collection Vol. 036, 2009, archive.org item
// short_story_036_0904_librivox, file shortstory036_schwartzmetterklume_aw_64kb.mp3, sha1 335a31f7cab5e1de94140454f25016d6e3644abe), re-encoded to mono 16 kHz
// MP3 at 32 kbps with no tags (-map_metadata -1 drops the ID3 tags of the source, which name the reader). Nothing else of the source is kept.
// It is two stretches of the recording joined in pauses (ruling R-D19): the reader's spoken credit between them is left out, so that the transcript the tests
// make names nobody. In seconds from the first sample of the source, whose pauses ffmpeg's silencedetect (-35 dB, 0.2 s) puts at 3.07 to 4.51, 14.24 to 15.47
// and 17.12 to 18.62: the first stretch runs from 3.6 (after the title line) to 14.9 (before the credit), the second from 17.9 (after the credit) to 31.6,
// which makes 25 s; each cut sits well inside its pause. The second stretch opens with the title line again: the author credit of a public-domain work stays.
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
  // The splice points are the pauses of this one file (the second LibriVox candidate of the plan would need its own).
  const SOURCE_SHA1 = '335a31f7cab5e1de94140454f25016d6e3644abe';
  if (sha1 !== SOURCE_SHA1) { console.error(`the source has sha1 ${sha1}; the splice points are the pauses of the LibriVox file of sha1 ${SOURCE_SHA1}`); process.exit(2); }
  const SPLICE = '[0:a:0]asetpts=PTS-STARTPTS,asplit=2[first][second];[first]atrim=start=3.6:end=14.9,asetpts=PTS-STARTPTS[a];'
    + '[second]atrim=start=17.9:end=31.6,asetpts=PTS-STARTPTS[b];[a][b]concat=n=2:v=0:a=1[speech]';
  ffmpeg(['-i', source, '-filter_complex', SPLICE, '-map', '[speech]', '-map_metadata', '-1', '-ac', '1', '-ar', '16000', '-c:a', 'libmp3lame', '-b:a', '32k', '-bitexact', '-id3v2_version', '0', '-write_xing', '0', '-f', 'mp3', '-y', here('speech-20s.mp3')]);
  report('speech-20s.mp3');
}
