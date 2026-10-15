// agents/document-pipeline/test/render.test.ts
// Turning the source into pages: pagesOf (an image is one page, a PDF is rendered through a Renderer) and popplerRenderer (pdfinfo for the count,
// pdftoppm at 150 dpi for the pages). Four groups:
//   - the checked-in fixtures, which must be what test/fixtures/make-pdf.mjs makes;
//   - pagesOf, with a fake renderer;
//   - popplerRenderer over a fake process runner, which pins the command lines, the page files and the failures without poppler;
//   - popplerRenderer over the real pdfinfo and pdftoppm, which runs only where both are on PATH (CI installs poppler-utils; a machine without it
//     skips these and says so in the test report).
import { describe, test, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';
import { pagesOf, popplerRenderer, popplerRendererWith } from '../src/render.ts';
import type { RunTool } from '../src/render.ts';
import { RequestError } from '../src/request.ts';
import type { SourceBytes } from '../src/source.ts';
import { fakeRenderer } from './fake-renderer.ts';
import { ENCRYPTED_PDF, ENCRYPTED_PDF_PASSWORD, JPEG, PAGE_0_PNG, PAGE_1_PNG, TWO_PAGES_PDF, fixture, text } from './support.ts';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const sourceOf = (bytes: Uint8Array, mime: SourceBytes['mime']): SourceBytes => ({ bytes, mime, sha256: createHash('sha256').update(bytes).digest('hex'), origin: 'inline' });
const pdfSource = sourceOf(TWO_PAGES_PDF, 'application/pdf');
/** What a call rejects with: the error itself, so that a test reads its code, status and message. */
async function refusal(promise: Promise<unknown>): Promise<unknown> {
  try { await promise; } catch (e) { return e; }
  throw new Error('the call did not reject');
}
const widthOf = (png: Uint8Array) => Buffer.from(png).readUInt32BE(16);
const heightOf = (png: Uint8Array) => Buffer.from(png).readUInt32BE(20);

// --- The fixtures -------------------------------------------------------------------------------------------------------------
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (buf: Buffer) => { let c = 0xffffffff; for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function pngChunks(bytes: Uint8Array): Array<{ type: string; data: Buffer; crcOk: boolean }> {
  const buf = Buffer.from(bytes);
  const chunks = [];
  for (let at = 8; at < buf.length;) {
    const length = buf.readUInt32BE(at);
    chunks.push({ type: buf.toString('latin1', at + 4, at + 8), data: buf.subarray(at + 8, at + 8 + length), crcOk: buf.readUInt32BE(at + 8 + length) === crc32(buf.subarray(at + 4, at + 8 + length)) });
    at += 12 + length;
  }
  return chunks;
}

describe('the fixtures', () => {
  test('every file is what test/fixtures/make-pdf.mjs makes: the script and the checked-in bytes cannot drift apart', async () => {
    const { buildFixtures } = await import(new URL('./fixtures/make-pdf.mjs', import.meta.url).href) as { buildFixtures: () => Record<string, Buffer> };
    const built = buildFixtures();
    expect(Object.keys(built).sort()).toStrictEqual(['encrypted.pdf', 'page-0.png', 'page-1.png', 'two-pages.pdf']);
    for (const [name, bytes] of Object.entries(built)) expect(fixture(name), name).toStrictEqual(new Uint8Array(bytes));
  });

  test('two-pages.pdf is a small real PDF with the two texts, a table of byte offsets that is right, and 576 by 720 point pages', () => {
    const pdf = Buffer.from(TWO_PAGES_PDF).toString('latin1');
    expect(TWO_PAGES_PDF.length).toBeLessThan(10 * 1024);
    expect(pdf.startsWith('%PDF-1.4\n')).toBe(true);
    expect(pdf).toContain('(Page one of the test document.)');
    expect(pdf).toContain('(Page two of the test document.)');
    expect(pdf.match(/\/MediaBox \[0 0 576 720\]/g)).toHaveLength(2);
    // every entry of the cross-reference table points at the "N 0 obj" it names
    const entries = [...pdf.matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));
    expect(entries).toHaveLength(7);
    entries.forEach((offset, i) => expect(pdf.slice(offset, offset + `${i + 1} 0 obj`.length)).toBe(`${i + 1} 0 obj`));
    expect(Number(/startxref\n(\d+)\n/.exec(pdf)?.[1])).toBe(pdf.indexOf('xref\n0 8'));
  });

  test('encrypted.pdf asks for a password: it has an encryption dictionary and its page text is not readable in the file', () => {
    const pdf = Buffer.from(ENCRYPTED_PDF).toString('latin1');
    expect(ENCRYPTED_PDF.length).toBeLessThan(10 * 1024);
    expect(pdf).toContain('/Encrypt 6 0 R');
    expect(pdf).toContain('/Filter /Standard /V 1 /R 2');
    expect(pdf).not.toContain('Page one of the test document.');
  });

  test('page-0.png and page-1.png are valid 8 by 8 PNGs that differ: signature, header, checksums, a data stream that inflates to 8 rows', () => {
    expect(PAGE_0_PNG).not.toStrictEqual(PAGE_1_PNG);
    for (const png of [PAGE_0_PNG, PAGE_1_PNG]) {
      expect(Buffer.from(png).subarray(0, 8)).toStrictEqual(PNG_SIGNATURE);
      const chunks = pngChunks(png);
      expect(chunks.map((c) => c.type)).toStrictEqual(['IHDR', 'IDAT', 'IEND']);
      expect(chunks.every((c) => c.crcOk)).toBe(true);
      expect([widthOf(png), heightOf(png)]).toStrictEqual([8, 8]);
      expect([...chunks[0].data.subarray(8, 13)]).toStrictEqual([8, 2, 0, 0, 0]); // 8-bit RGB, no interlace
      expect(inflateSync(chunks[1].data)).toHaveLength(8 * (1 + 8 * 3));
    }
  });
});

// --- pagesOf ------------------------------------------------------------------------------------------------------------------
describe('pagesOf', () => {
  test('a two-page PDF: total 2, both pages in order, as PNG', async () => {
    const renderer = fakeRenderer({ total: 2 });
    const result = await pagesOf(pdfSource, 5, renderer);
    expect(result).toStrictEqual({ total: 2, pages: [{ index: 0, png: PAGE_0_PNG }, { index: 1, png: PAGE_1_PNG }], mime: 'image/png' });
    expect(renderer.calls).toStrictEqual({ pageCount: 1, render: [5] });
  });

  test('maxPages 1 reads one page and still reports the total of the document', async () => {
    const renderer = fakeRenderer({ total: 2 });
    expect(await pagesOf(pdfSource, 1, renderer)).toStrictEqual({ total: 2, pages: [{ index: 0, png: PAGE_0_PNG }], mime: 'image/png' });
    expect(renderer.calls.render).toStrictEqual([1]);
  });

  test('a renderer that ignores the page budget cannot give more pages than were asked for', async () => {
    const result = await pagesOf(pdfSource, 1, fakeRenderer({ total: 2, honourMaxPages: false }));
    expect(result.pages).toHaveLength(1);
    expect(result.total).toBe(2);
  });

  test('a document longer than the budget: the first maxPages pages, the whole count as the total', async () => {
    const result = await pagesOf(pdfSource, 5, fakeRenderer({ total: 7 }));
    expect(result.total).toBe(7);
    expect(result.pages.map((p) => p.index)).toStrictEqual([0, 1, 2, 3, 4]);
  });

  test('a document shorter than the budget gives all its pages', async () => {
    const result = await pagesOf(sourceOf(TWO_PAGES_PDF, 'application/pdf'), 5, fakeRenderer({ total: 1 }));
    expect(result).toMatchObject({ total: 1, mime: 'image/png', pages: [{ index: 0 }] });
  });

  test.each<[SourceBytes['mime'], Uint8Array]>([['image/png', PAGE_0_PNG], ['image/jpeg', JPEG]])('an image (%s) is one page, total 1, as it is, and the renderer is not asked', async (mime, bytes) => {
    const renderer = fakeRenderer();
    expect(await pagesOf(sourceOf(bytes, mime), 5, renderer)).toStrictEqual({ total: 1, pages: [{ index: 0, png: bytes }], mime });
    expect(renderer.calls).toStrictEqual({ pageCount: 0, render: [] });
  });

  test('a PDF the renderer cannot open is unreadable_source, and nothing is rendered', async () => {
    const renderer = fakeRenderer();
    renderer.pageCount = async () => { throw new RequestError('unreadable_source', 'the PDF is password protected'); };
    expect(await refusal(pagesOf(pdfSource, 5, renderer))).toMatchObject({ code: 'unreadable_source', status: 422 });
    expect(renderer.calls.render).toStrictEqual([]);
  });

  test('a PDF with no pages is unreadable_source, and nothing is rendered', async () => {
    for (const total of [0, -1, 1.5, Number.NaN]) {
      const renderer = fakeRenderer();
      renderer.pageCount = async () => total;
      expect(await refusal(pagesOf(pdfSource, 5, renderer)), String(total)).toMatchObject({ code: 'unreadable_source', status: 422 });
      expect(renderer.calls.render).toStrictEqual([]);
    }
  });

  test('a renderer that returns fewer pages than the document has is unreadable_source: a page that cannot be rendered must not pass as a smaller document', async () => {
    const renderer = fakeRenderer({ total: 3 });
    renderer.render = async () => [{ index: 0, png: PAGE_0_PNG }];
    expect(await refusal(pagesOf(pdfSource, 5, renderer))).toMatchObject({ code: 'unreadable_source', status: 422, message: expect.stringContaining('3') });
    // but fewer than the document has is right when the budget is smaller
    renderer.render = async () => [{ index: 0, png: PAGE_0_PNG }];
    expect((await pagesOf(pdfSource, 1, renderer)).pages).toHaveLength(1);
  });

  test('maxPages must be a whole number of at least 1, for an image too', async () => {
    for (const maxPages of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(await refusal(pagesOf(pdfSource, maxPages, fakeRenderer())), String(maxPages)).toBeInstanceOf(RangeError);
      expect(await refusal(pagesOf(sourceOf(PAGE_0_PNG, 'image/png'), maxPages, fakeRenderer())), String(maxPages)).toBeInstanceOf(RangeError);
    }
  });
});

// --- popplerRenderer over a fake process runner -------------------------------------------------------------------------------
interface ToolCall { file: string; args: readonly string[]; timeoutMs: number; maxBuffer: number; dir: string; pdf: Uint8Array | null }
type Handler = (call: ToolCall) => Promise<{ stdout?: string; stderr?: string } | void> | { stdout?: string; stderr?: string } | void;
/** A process runner that records each call (with the PDF as the tool would find it on disk) and lets the test play the tool. */
function fakeTools(handle: Handler) {
  const calls: ToolCall[] = [];
  const run: RunTool = async (file, args, options) => {
    const dir = dirname(args[args.length - 1]); // pdfinfo's last argument is <dir>/in.pdf and pdftoppm's is <dir>/page
    const pdf = existsSync(join(dir, 'in.pdf')) ? new Uint8Array(await readFile(join(dir, 'in.pdf'))) : null;
    const call: ToolCall = { file, args, timeoutMs: options.timeoutMs, maxBuffer: options.maxBuffer, dir, pdf };
    calls.push(call);
    const out = await handle(call);
    return { stdout: out?.stdout ?? '', stderr: out?.stderr ?? '' };
  };
  return { run, calls };
}
const exited = (code: number, stderr = '') => Object.assign(new Error(`Command failed: exit code ${code}`), { code, killed: false, signal: null, stderr });
const timedOut = () => Object.assign(new Error('Command failed'), { code: null, killed: true, signal: 'SIGTERM', stderr: '' });
const crashed = () => Object.assign(new Error('Command failed'), { code: null, killed: false, signal: 'SIGSEGV', stderr: '' });
const cannotStart = (code: string) => Object.assign(new Error(`spawn pdfinfo ${code}`), { code, errno: -2, syscall: 'spawn pdfinfo' });
const tooMuchOutput = () => Object.assign(new RangeError('stdout maxBuffer length exceeded'), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' });
const pageFile = (n: number) => Buffer.concat([PNG_SIGNATURE, Buffer.from([n])]); // a "rendered page" whose last byte says which page it is
const leftovers = () => readdirSync(tmpdir()).filter((name) => name.startsWith('docpipe-'));
/** Plays pdftoppm: writes the named files into the directory it was given, last name first. */
const writesPages = (names: string[]): Handler => async (call) => {
  for (const name of [...names].reverse()) await writeFile(join(call.dir, name), pageFile(Number(/\d+/.exec(name)?.[0])));
};
const numbered = (count: number, width: number) => Array.from({ length: count }, (_, i) => `page-${String(i + 1).padStart(width, '0')}.png`);

describe('popplerRenderer over a fake runner: pageCount', () => {
  test('runs pdfinfo on the PDF as a file of a private directory, reads the Pages line, and removes the directory', async () => {
    const before = leftovers().length;
    const tools = fakeTools(() => ({ stdout: 'Title:          Letter\nPages:          7\nEncrypted:      no\n' }));
    expect(await popplerRendererWith(tools.run).pageCount(TWO_PAGES_PDF)).toBe(7);
    expect(tools.calls).toHaveLength(1);
    const [call] = tools.calls;
    expect(call.file).toBe('pdfinfo');
    expect(call.args).toStrictEqual([join(call.dir, 'in.pdf')]);
    expect(call.pdf).toStrictEqual(TWO_PAGES_PDF);
    expect(call.timeoutMs).toBe(120_000);
    expect(call.maxBuffer).toBeGreaterThan(0);
    expect(call.maxBuffer).toBeLessThanOrEqual(1024 * 1024);
    expect(existsSync(call.dir)).toBe(false);
    expect(leftovers()).toHaveLength(before);
  });

  test('the tool names and the time limit are the options', async () => {
    const tools = fakeTools(() => ({ stdout: 'Pages: 1\n' }));
    await popplerRendererWith(tools.run, { pdfinfo: '/opt/poppler/bin/pdfinfo', timeoutMs: 5000 }).pageCount(TWO_PAGES_PDF);
    expect(tools.calls[0]).toMatchObject({ file: '/opt/poppler/bin/pdfinfo', timeoutMs: 5000 });
  });

  test('Windows line endings are fine', async () => {
    expect(await popplerRendererWith(fakeTools(() => ({ stdout: 'Title:   x\r\nPages:           3\r\nEncrypted:       no\r\n' })).run).pageCount(TWO_PAGES_PDF)).toBe(3);
  });

  test('a Pages line planted in the document\'s own metadata does not decide: the last line is the tool\'s', async () => {
    const stdout = 'Title:          x\nPages: 9\nSubject:        y\nPages: 4\nTagged:         no\nForm:           none\nPages:           2\nEncrypted:      no\nPage size:      576 x 720 pts\n';
    expect(await popplerRendererWith(fakeTools(() => ({ stdout })).run).pageCount(TWO_PAGES_PDF)).toBe(2);
  });

  test('the directory is removed when pdfinfo fails too', async () => {
    const tools = fakeTools(() => { throw exited(1, 'Syntax Error: Couldn\'t read xref table\n'); });
    await refusal(popplerRendererWith(tools.run).pageCount(TWO_PAGES_PDF));
    expect(existsSync(tools.calls[0].dir)).toBe(false);
  });

  test('a password-protected PDF (exit 1, "Incorrect password") is unreadable_source, and the message says it is the password', async () => {
    const tools = fakeTools(() => { throw exited(1, 'Command Line Error: Incorrect password\n'); });
    const error = await refusal(popplerRendererWith(tools.run).pageCount(ENCRYPTED_PDF));
    expect(error).toBeInstanceOf(RequestError);
    expect(error).toMatchObject({ code: 'unreadable_source', status: 422, message: expect.stringMatching(/password/i) });
  });

  test.each([
    ['a damaged PDF: exit 1', () => exited(1, 'Syntax Error: Couldn\'t find trailer dictionary\n')], ['an empty file: exit 1', () => exited(1, 'Syntax Error: Document stream is empty\n')],
    ['a PDF with an empty page tree: exit 99', () => exited(99, 'Syntax Error: Invalid page count 0\n')], ['a PDF the tool crashed on', crashed],
    ['a PDF whose metadata floods the output', tooMuchOutput],
  ])('%s is unreadable_source, and the tool\'s own words stay out of the message', async (_name, failure) => {
    const error = await refusal(popplerRendererWith(fakeTools(() => { throw failure(); }).run).pageCount(TWO_PAGES_PDF));
    expect(error).toBeInstanceOf(RequestError);
    expect(error).toMatchObject({ code: 'unreadable_source', status: 422 });
    expect((error as Error).message).not.toMatch(/Syntax Error|trailer|xref|SIGSEGV|maxBuffer/);
  });

  test('a pdfinfo that outlives the time limit is unreadable_source and says it took too long', async () => {
    const error = await refusal(popplerRendererWith(fakeTools(() => { throw timedOut(); }).run).pageCount(TWO_PAGES_PDF));
    expect(error).toMatchObject({ code: 'unreadable_source', status: 422, message: expect.stringMatching(/too long/) });
  });

  test.each([['no Pages line', 'Title: x\nEncrypted: no\n'], ['an empty answer', ''], ['0 pages', 'Pages:           0\n'], ['a Pages line without a number', 'Pages:           many\n'], ['a number past what a count can be', 'Pages: 99999999999999999999999\n']])('%s is unreadable_source', async (_name, stdout) => {
    const error = await refusal(popplerRendererWith(fakeTools(() => ({ stdout })).run).pageCount(TWO_PAGES_PDF));
    expect(error).toMatchObject({ code: 'unreadable_source', status: 422 });
  });

  test.each(['ENOENT', 'EACCES'])('a pdfinfo that cannot be started (%s) is the deployment\'s fault, not the document\'s: a plain Error that names the tool, never a RequestError', async (code) => {
    const error = await refusal(popplerRendererWith(fakeTools(() => { throw cannotStart(code); }).run, { pdfinfo: 'pdfinfo-here' }).pageCount(TWO_PAGES_PDF));
    expect(error).not.toBeInstanceOf(RequestError);
    expect((error as Error).message).toMatch(/pdfinfo-here/);
    expect((error as Error).message).toMatch(/poppler/);
    expect((error as Error).cause).toBeDefined();
  });
});

describe('popplerRenderer over a fake runner: render', () => {
  test('runs pdftoppm -r 150 -png -f 1 -l maxPages on the PDF, into page files of a private directory, and returns the pages in order', async () => {
    const tools = fakeTools(writesPages(numbered(3, 1)));
    const pages = await popplerRendererWith(tools.run).render(TWO_PAGES_PDF, 3);
    expect(pages.map((p) => p.index)).toStrictEqual([0, 1, 2]);
    expect(pages.map((p) => p.png[p.png.length - 1])).toStrictEqual([1, 2, 3]);
    expect(tools.calls).toHaveLength(1);
    const [call] = tools.calls;
    expect(call.file).toBe('pdftoppm');
    expect(call.args).toStrictEqual(['-r', '150', '-png', '-f', '1', '-l', '3', join(call.dir, 'in.pdf'), join(call.dir, 'page')]);
    expect(call.pdf).toStrictEqual(TWO_PAGES_PDF);
    expect(call.timeoutMs).toBe(120_000);
  });

  test('the tool names, the resolution and the time limit are the options', async () => {
    const tools = fakeTools(writesPages(numbered(1, 1)));
    await popplerRendererWith(tools.run, { pdftoppm: '/opt/poppler/bin/pdftoppm', dpi: 200, timeoutMs: 7000 }).render(TWO_PAGES_PDF, 1);
    expect(tools.calls[0]).toMatchObject({ file: '/opt/poppler/bin/pdftoppm', timeoutMs: 7000 });
    expect(tools.calls[0].args.slice(0, 2)).toStrictEqual(['-r', '200']);
  });

  // poppler pads the page numbers to the digits of the page count of the DOCUMENT, whatever -l says: page-1.png in a document of 9 pages or fewer,
  // page-01.png from 10 pages, page-001.png from 100. Unpadded names are the ones a plain string sort puts in the wrong order (page-10 before page-2).
  test.each([[1], [2], [3]])('page files padded to %i digit(s) come back in page order', async (width) => {
    const pages = await popplerRendererWith(fakeTools(writesPages(numbered(12, width))).run).render(TWO_PAGES_PDF, 12);
    expect(pages.map((p) => p.index)).toStrictEqual(Array.from({ length: 12 }, (_, i) => i));
    expect(pages.map((p) => p.png[p.png.length - 1])).toStrictEqual(Array.from({ length: 12 }, (_, i) => i + 1));
  });

  test('the page count does not decide how many are read: a document of 12 pages rendered with -l 5 gives page-01 to page-05', async () => {
    const pages = await popplerRendererWith(fakeTools(writesPages(numbered(5, 2))).run).render(TWO_PAGES_PDF, 5);
    expect(pages.map((p) => p.index)).toStrictEqual([0, 1, 2, 3, 4]);
  });

  test('files that are not page files are ignored: the PDF itself, notes, other extensions, other prefixes, half-written names', async () => {
    const names = [...numbered(2, 1), 'notes.txt', 'page-1.png.tmp', 'page-a.png', 'xpage-1.png', 'page-1.jpg', 'page-.png', 'page-1-2.png'];
    const pages = await popplerRendererWith(fakeTools(writesPages(names)).run).render(TWO_PAGES_PDF, 5);
    expect(pages.map((p) => p.index)).toStrictEqual([0, 1]);
  });

  test('every page is read as the bytes poppler wrote, in a plain Uint8Array', async () => {
    const [page] = await popplerRendererWith(fakeTools(writesPages(numbered(1, 1))).run).render(TWO_PAGES_PDF, 1);
    expect(page.png).toStrictEqual(new Uint8Array(pageFile(1)));
    expect(Object.getPrototypeOf(page.png)).toBe(Uint8Array.prototype);
  });

  test('the directory is removed after a render, after a failed render, and after pages that cannot be used', async () => {
    const before = leftovers().length;
    for (const handler of [writesPages(numbered(2, 1)), () => { throw exited(1); }, writesPages(['page-1.png', 'page-3.png']), writesPages([])]) {
      const tools = fakeTools(handler);
      await popplerRendererWith(tools.run).render(TWO_PAGES_PDF, 5).catch(() => undefined);
      expect(existsSync(tools.calls[0].dir)).toBe(false);
    }
    expect(leftovers()).toHaveLength(before);
  });

  test('a render that wrote no page, or skipped one, or wrote something that is not a PNG, is unreadable_source', async () => {
    const notPng: Handler = async (call) => { await writeFile(join(call.dir, 'page-1.png'), text('not a png')); };
    const empty: Handler = async (call) => { await writeFile(join(call.dir, 'page-1.png'), new Uint8Array(0)); };
    for (const [name, handler] of [['no page', writesPages([])], ['a gap', writesPages(['page-1.png', 'page-3.png'])], ['pages that do not start at 1', writesPages(['page-2.png', 'page-3.png'])], ['not a PNG', notPng], ['an empty file', empty]] as const) {
      expect(await refusal(popplerRendererWith(fakeTools(handler).run).render(TWO_PAGES_PDF, 5)), name).toMatchObject({ code: 'unreadable_source', status: 422 });
    }
  });

  test.each([
    ['a PDF pdftoppm refuses: exit 1', () => exited(1, 'Syntax Error: Couldn\'t read xref table\n'), /could not be rendered/],
    ['a password-protected PDF', () => exited(1, 'Command Line Error: Incorrect password\n'), /password/i],
    ['a wrong page range: exit 99', () => exited(99, 'Wrong page range given\n'), /could not be rendered/],
    ['a crash', crashed, /could not be rendered/],
    ['the time limit', timedOut, /too long/],
  ])('%s is unreadable_source', async (_name, failure, message) => {
    const error = await refusal(popplerRendererWith(fakeTools(() => { throw failure(); }).run).render(TWO_PAGES_PDF, 5));
    expect(error).toBeInstanceOf(RequestError);
    expect(error).toMatchObject({ code: 'unreadable_source', status: 422, message: expect.stringMatching(message) });
  });

  test('a pdftoppm that cannot be started is a plain Error naming the tool', async () => {
    const error = await refusal(popplerRendererWith(fakeTools(() => { throw cannotStart('ENOENT'); }).run, { pdftoppm: 'pdftoppm-here' }).render(TWO_PAGES_PDF, 5));
    expect(error).not.toBeInstanceOf(RequestError);
    expect((error as Error).message).toMatch(/pdftoppm-here/);
  });

  test('maxPages must be a whole number of at least 1, checked before any file is written or tool run', async () => {
    for (const maxPages of [0, -3, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const tools = fakeTools(() => undefined);
      expect(await refusal(popplerRendererWith(tools.run).render(TWO_PAGES_PDF, maxPages)), String(maxPages)).toBeInstanceOf(RangeError);
      expect(tools.calls).toHaveLength(0);
    }
  });

  test('the resolution must be a positive whole number', () => {
    for (const dpi of [0, -150, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) expect(() => popplerRendererWith(fakeTools(() => undefined).run, { dpi }), String(dpi)).toThrow(RangeError);
  });
});

describe('popplerRenderer with the real executables', () => {
  test('a tool that is not installed is a plain Error that names it, not a verdict on the document', async () => {
    const error = await refusal(popplerRenderer({ pdfinfo: 'pdfinfo-that-is-not-installed' }).pageCount(TWO_PAGES_PDF));
    expect(error).not.toBeInstanceOf(RequestError);
    expect((error as Error).message).toMatch(/pdfinfo-that-is-not-installed/);
    const error2 = await refusal(popplerRenderer({ pdftoppm: 'pdftoppm-that-is-not-installed' }).render(TWO_PAGES_PDF, 1));
    expect(error2).not.toBeInstanceOf(RequestError);
    expect((error2 as Error).message).toMatch(/pdftoppm-that-is-not-installed/);
  });
});

/** The two-page fixture with an Info dictionary added whose Title holds a line break and a line "Pages: 99". The table of offsets is rewritten to match. */
function withPlantedPagesLine(pdf: Uint8Array): Uint8Array {
  const text = Buffer.from(pdf).toString('latin1');
  const objects = text.slice(0, text.indexOf('xref\n0 8'));
  const offsets = [...objects.matchAll(/^\d+ 0 obj$/gm)].map((m) => m.index ?? 0);
  const withInfo = `${objects}8 0 obj\n<< /Title (x\\nPages: 99) >>\nendobj\n`;
  offsets.push(objects.length);
  const xref = `xref\n0 9\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n `).join('\n')}\n`;
  return new Uint8Array(Buffer.from(`${withInfo}${xref}trailer\n<< /Size 9 /Root 1 0 R /Info 8 0 R >>\nstartxref\n${withInfo.length}\n%%EOF\n`, 'latin1'));
}

// The probes ask each tool for its version: a missing tool is an ENOENT, whatever the exit code of a present one.
const onPath = (tool: string) => spawnSync(tool, ['-v'], { stdio: 'ignore' }).error === undefined;
const POPPLER = onPath('pdftoppm') && onPath('pdfinfo');

describe('popplerRenderer with the real pdfinfo and pdftoppm (needs poppler-utils on PATH)', () => {
  // CI installs poppler-utils and sets REQUIRE_POPPLER, so a step that failed to install it fails here instead of skipping everything below.
  test.skipIf(!process.env.REQUIRE_POPPLER)('REQUIRE_POPPLER is set: pdftoppm and pdfinfo are installed', () => {
    expect(POPPLER).toBe(true);
  });

  test.skipIf(!POPPLER)('pageCount reads the pages of the PDF', async () => {
    expect(await popplerRenderer().pageCount(TWO_PAGES_PDF)).toBe(2);
  });

  test.skipIf(!POPPLER)('a document title that plants a "Pages:" line in the output of pdfinfo does not change the count (pdfinfo prints a title as it is, line break included)', async () => {
    expect(await popplerRenderer().pageCount(withPlantedPagesLine(TWO_PAGES_PDF))).toBe(2);
  });

  test.skipIf(!POPPLER)('render gives two PNGs of 150 dpi, in order: 576 by 720 points are 1200 by 1500 pixels, and each file is more than 1000 bytes', async () => {
    const pages = await popplerRenderer().render(TWO_PAGES_PDF, 2);
    expect(pages.map((p) => p.index)).toStrictEqual([0, 1]);
    for (const { png } of pages) {
      expect(Buffer.from(png).subarray(0, 8)).toStrictEqual(PNG_SIGNATURE);
      expect(png.length).toBeGreaterThan(1000);
      expect([widthOf(png), heightOf(png)]).toStrictEqual([1200, 1500]);
      expect(pngChunks(png).every((c) => c.crcOk)).toBe(true);
    }
  });

  test.skipIf(!POPPLER)('the resolution is the option: 72 dpi gives 576 by 720 pixels', async () => {
    const [page] = await popplerRenderer({ dpi: 72 }).render(TWO_PAGES_PDF, 1);
    expect([widthOf(page.png), heightOf(page.png)]).toStrictEqual([576, 720]);
  });

  test.skipIf(!POPPLER)('maxPages 1 renders one page of a two-page PDF, and a budget above the page count renders what there is', async () => {
    expect(await popplerRenderer().render(TWO_PAGES_PDF, 1)).toHaveLength(1);
    expect(await popplerRenderer().render(TWO_PAGES_PDF, 5)).toHaveLength(2);
  });

  test.skipIf(!POPPLER)('pagesOf with the real renderer: total 2, the budget decides the pages', async () => {
    const renderer = popplerRenderer();
    const both = await pagesOf(pdfSource, 5, renderer);
    expect([both.total, both.pages.length, both.mime]).toStrictEqual([2, 2, 'image/png']);
    const one = await pagesOf(pdfSource, 1, renderer);
    expect([one.total, one.pages.length]).toStrictEqual([2, 1]);
  });

  test.skipIf(!POPPLER)('a PDF locked with a password is unreadable_source before anything is rendered, and the message says password', async () => {
    const error = await refusal(pagesOf(sourceOf(ENCRYPTED_PDF, 'application/pdf'), 5, popplerRenderer()));
    expect(error).toBeInstanceOf(RequestError);
    expect(error).toMatchObject({ code: 'unreadable_source', status: 422, message: expect.stringMatching(/password/i) });
  });

  test.skipIf(!POPPLER)('the locked fixture opens with its password, so it is the missing password that stops it above and not a broken file', () => {
    const file = fileURLToPath(new URL('./fixtures/encrypted.pdf', import.meta.url));
    expect(spawnSync('pdfinfo', [file], { stdio: 'ignore' }).status).not.toBe(0);
    const unlocked = spawnSync('pdfinfo', ['-upw', ENCRYPTED_PDF_PASSWORD, file], { encoding: 'utf8' });
    expect(unlocked.status).toBe(0);
    expect(unlocked.stdout).toMatch(/^Pages:\s+1\s*$/m);
    expect(unlocked.stdout).toMatch(/^Encrypted:\s+yes/m);
  });

  test.skipIf(!POPPLER)('a truncated PDF (cut inside the page tree), an empty file and a file that is no PDF are unreadable_source', async () => {
    for (const [name, bytes] of [['a truncated PDF', TWO_PAGES_PDF.subarray(0, 100)], ['an empty file', new Uint8Array(0)], ['text', text('this is not a PDF at all')]] as const) {
      const error = await refusal(pagesOf(sourceOf(bytes, 'application/pdf'), 5, popplerRenderer()));
      expect(error, name).toBeInstanceOf(RequestError);
      expect(error, name).toMatchObject({ code: 'unreadable_source', status: 422 });
    }
  });

  test.skipIf(!POPPLER)('no directory is left behind, whether the render worked or not', async () => {
    const before = leftovers();
    const renderer = popplerRenderer();
    await renderer.pageCount(TWO_PAGES_PDF);
    await renderer.render(TWO_PAGES_PDF, 2);
    await refusal(renderer.pageCount(ENCRYPTED_PDF));
    await refusal(renderer.render(TWO_PAGES_PDF.subarray(0, 100), 2));
    expect(leftovers()).toStrictEqual(before);
  });
});
