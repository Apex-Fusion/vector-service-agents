// Generates the binary fixtures of the document-pipeline tests, byte for byte the same on every run:
//   two-pages.pdf  a real two-page PDF ("Page one of the test document." and "Page two of the test document.")
//   encrypted.pdf  one page, locked with a user password, so poppler cannot open it without that password
//   page-0.png, page-1.png  8 by 8 pixel PNGs that the fake renderer of the tests hands out as rendered pages
// Run it once with `node test/fixtures/make-pdf.mjs` from agents/document-pipeline and check the output in. test/render.test.ts rebuilds
// every file from this module and compares, so the script and the checked-in bytes cannot drift apart. It has no dependencies on purpose:
// the PDFs are written by hand (a PDF is text with a table of byte offsets), and the PNGs use stored zlib blocks, so no compressor version
// can change a byte.
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PAGE_TEXTS = ['Page one of the test document.', 'Page two of the test document.'];
// 576 by 720 points: at 150 dpi that is exactly 1200 by 1500 pixels, so a test can check the resolution without rounding.
export const MEDIA_BOX = [0, 0, 576, 720];
export const USER_PASSWORD = 'secret';

const latin1 = (s) => Buffer.from(s, 'latin1');

// --- PDF ----------------------------------------------------------------------------------------------------------------------
// `objects[i]` is the body of object i + 1. The cross-reference table is computed from the real byte offsets; each entry is 20 bytes.
function pdfFile(objects, trailerEntries) {
  const parts = [latin1('%PDF-1.4\n')];
  let offset = parts[0].length;
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(offset);
    const object = Buffer.concat([latin1(`${i + 1} 0 obj\n`), body, latin1('\nendobj\n')]);
    parts.push(object);
    offset += object.length;
  });
  const xref = ['xref', `0 ${objects.length + 1}`, '0000000000 65535 f ', ...offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n `)].join('\n');
  parts.push(latin1(`${xref}\ntrailer\n<< /Size ${objects.length + 1} /Root 1 0 R ${trailerEntries} >>\nstartxref\n${offset}\n%%EOF\n`));
  return Buffer.concat(parts);
}
const stream = (data) => Buffer.concat([latin1(`<< /Length ${data.length} >>\nstream\n`), data, latin1('\nendstream')]);
const escapeText = (s) => s.replace(/[\\()]/g, (c) => `\\${c}`);
// The text, and a black bar under it: the bar shows on the page even on a machine that has no font to draw the text with.
const pageContent = (text) => latin1(`BT /F1 24 Tf 72 648 Td (${escapeText(text)}) Tj ET\n72 600 432 6 re f\n`);
const catalogAndPages = (pageCount) => [
  latin1('<< /Type /Catalog /Pages 2 0 R >>'),
  latin1(`<< /Type /Pages /Kids [${Array.from({ length: pageCount }, (_, i) => `${3 + i} 0 R`).join(' ')}] /Count ${pageCount} >>`),
];
const pageObject = (contentsRef, fontRef) => latin1(`<< /Type /Page /Parent 2 0 R /MediaBox [${MEDIA_BOX.join(' ')}] /Resources << /Font << /F1 ${fontRef} 0 R >> >> /Contents ${contentsRef} 0 R >>`);
const FONT = latin1('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');

export function twoPagePdf() {
  // 1 catalog, 2 page tree, 3 and 4 pages, 5 font, 6 and 7 page contents
  return pdfFile([...catalogAndPages(2), pageObject(6, 5), pageObject(7, 5), FONT, stream(pageContent(PAGE_TEXTS[0])), stream(pageContent(PAGE_TEXTS[1]))], '');
}

// --- Encryption: the standard security handler, version 1, revision 2 (RC4 with a 40-bit key), algorithms 2 to 4 of ISO 32000-1 ---
function rc4(key, data) {
  const s = Array.from({ length: 256 }, (_, i) => i);
  let j = 0;
  for (let i = 0; i < 256; i++) { j = (j + s[i] + key[i % key.length]) & 255; [s[i], s[j]] = [s[j], s[i]]; }
  const out = Buffer.alloc(data.length);
  let a = 0;
  j = 0;
  for (let n = 0; n < data.length; n++) { a = (a + 1) & 255; j = (j + s[a]) & 255; [s[a], s[j]] = [s[j], s[a]]; out[n] = data[n] ^ s[(s[a] + s[j]) & 255]; }
  return out;
}
const md5 = (...parts) => createHash('md5').update(Buffer.concat(parts)).digest();
const PAD = Buffer.from('28bf4e5e4e758a4164004e56fffa01082e2e00b6d0683e802f0ca9fe6453697a', 'hex');
const padded = (password) => Buffer.concat([latin1(password), PAD]).subarray(0, 32);

export function encryptedPdf() {
  const userPassword = USER_PASSWORD, ownerPassword = 'owner';
  const id = Buffer.alloc(16, 0xaa);
  const permissions = Buffer.alloc(4);
  permissions.writeInt32LE(-4);
  const owner = rc4(md5(padded(ownerPassword)).subarray(0, 5), padded(userPassword)); // algorithm 3
  const fileKey = md5(padded(userPassword), owner, permissions, id).subarray(0, 5); // algorithm 2
  const user = rc4(fileKey, PAD); // algorithm 4
  const objectKey = (n) => md5(fileKey, Buffer.from([n & 255, (n >> 8) & 255, (n >> 16) & 255, 0, 0])).subarray(0, 10); // algorithm 1
  const content = rc4(objectKey(5), pageContent(PAGE_TEXTS[0]));
  const encrypt = latin1(`<< /Filter /Standard /V 1 /R 2 /O <${owner.toString('hex')}> /U <${user.toString('hex')}> /P -4 >>`);
  // 1 catalog, 2 page tree, 3 page, 4 font, 5 page content (encrypted), 6 the encryption dictionary (never encrypted itself)
  return pdfFile([...catalogAndPages(1), pageObject(5, 4), FONT, stream(content), encrypt], `/Encrypt 6 0 R /ID [<${id.toString('hex')}> <${id.toString('hex')}>]`);
}

// --- PNG ----------------------------------------------------------------------------------------------------------------------
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
function crc32(buf) { let c = 0xffffffff; for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function adler32(buf) { let a = 1, b = 0; for (const byte of buf) { a = (a + byte) % 65521; b = (b + a) % 65521; } return ((b << 16) | a) >>> 0; }
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0); return b; };
function pngChunk(type, data) { const body = Buffer.concat([latin1(type), data]); return Buffer.concat([u32(data.length), body, u32(crc32(body))]); }
// A zlib stream of one stored (uncompressed) deflate block: header, block header, length and its complement, the data, the adler-32 of the data.
function zlibStored(data) {
  if (data.length > 0xffff) throw new Error('one stored block holds at most 65535 bytes');
  const block = Buffer.alloc(5);
  block[0] = 1; // the last block, stored
  block.writeUInt16LE(data.length, 1);
  block.writeUInt16LE(~data.length & 0xffff, 3);
  return Buffer.concat([Buffer.from([0x78, 0x01]), block, data, u32(adler32(data))]);
}
export function png8x8(pixel) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(8, 0);
  header.writeUInt32BE(8, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // colour type 2: RGB
  const rows = [];
  for (let y = 0; y < 8; y++) {
    const row = [0]; // filter type 0 for the row
    for (let x = 0; x < 8; x++) row.push(...pixel(x, y));
    rows.push(Buffer.from(row));
  }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), pngChunk('IHDR', header), pngChunk('IDAT', zlibStored(Buffer.concat(rows))), pngChunk('IEND', Buffer.alloc(0))]);
}

/** Every fixture, by file name. */
export function buildFixtures() {
  return {
    'two-pages.pdf': twoPagePdf(),
    'encrypted.pdf': encryptedPdf(),
    'page-0.png': png8x8((x, y) => [x * 32, y * 32, 0]), // red and green gradients
    'page-1.png': png8x8((x, y) => [0, 255 - x * 32, y * 32]), // green and blue gradients, the other way round
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = dirname(fileURLToPath(import.meta.url));
  for (const [name, bytes] of Object.entries(buildFixtures())) {
    writeFileSync(join(dir, name), bytes);
    console.log(`${name} ${bytes.length} bytes`);
  }
}
