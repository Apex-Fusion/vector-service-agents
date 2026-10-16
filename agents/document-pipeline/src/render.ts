// agents/document-pipeline/src/render.ts
// From the source to the pages that are read: an image is one page as it is, a PDF is rendered to PNG at 150 dpi by poppler (pdfinfo for the page
// count and the size of the pages, pdftoppm for the pages). Like src/source.ts it runs before any escrow is posted, and a PDF that cannot be read is
// refused here (unreadable_source, 422) while it has cost nothing: locked with a password, damaged, cut short, with no pages, or so slow to open that
// the tool is stopped.
//
// pdftoppm allocates the whole page before it draws it, so a page of 200 by 200 inches is 900 megapixels at 150 dpi and takes the container down, for
// every hirer (ruling R66). So before pdftoppm runs, `pdfinfo -box -f 1 -l <pages>` says how large each page is that would be rendered, and a page over
// MAX_PAGE_PIXELS at the render dpi is refused (page_too_large, 422), naming the page and its size. pdfinfo's "Page N size" line is the crop box of the
// page (getPageCropWidth in poppler's utils/pdfinfo.cc) and pdftoppm renders the media box unless it is told -cropbox (getPageMediaWidth in
// utils/pdftoppm.cc), so the media box that -box prints is required too. Each box is counted in pixels on its own and the larger count decides: a size
// line printed turned, for a page with /Rotate 90, is the same page and not a larger one.
//
// The PDF is the caller's and poppler parses it, so it never meets a shell: the tools are started with an argument list (execFile), on a file in a
// directory that only this process can read (mkdtemp), and the directory is removed whatever happened. They are started without the secrets of the
// service in their environment (ruling R-D23): childEnv of packages/service-kit, from @vsa/service-kit/env, which loads nothing else, leaves out the buyer
// key and the token of the runtime. What the tools print is not passed on: their messages can name paths and offsets, and the person who sent the
// document gets a sentence of ours.
//
// A tool that cannot be started at all (not installed, not executable) is not a verdict on the document. That is a plain Error, which the
// server reports as a failure of its own, not as a RequestError.
import { execFile } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { childEnv } from '@vsa/service-kit/env';
import { sniffMime } from './mime.ts';
import { RequestError } from './request.ts';
import { PipelineError } from './result.ts';
import type { SourceBytes } from './source.ts';

/** One page, as the image the OCR agent is sent. For a PNG or a rendered PDF page the bytes are a PNG; for a JPEG source they are the JPEG's own (see `mime` of pagesOf). */
export interface Page { index: number; png: Uint8Array }
export interface Renderer {
  /** The pages in the whole document. Rejects with unreadable_source for a PDF that cannot be opened. */
  pageCount(pdf: Uint8Array): Promise<number>;
  /** The first `maxPages` pages (fewer when the document is shorter), index 0 first. */
  render(pdf: Uint8Array, maxPages: number): Promise<Page[]>;
  /**
   * Optional, and made once at start by a service that has a renderer to prove: resolves when the programs this renderer needs can be run, and rejects with the
   * reason when they cannot. A renderer of a test has none. It reads no document.
   */
  check?(): Promise<void>;
}

export interface PopplerOptions { pdftoppm?: string; pdfinfo?: string; dpi?: number; timeoutMs?: number }

/**
 * How the tools are started. It resolves with what the tool printed when it exited 0 and rejects with the error of node's execFile otherwise:
 * a numeric `code` is an exit status, `killed` true is the time limit, a string `code` is a failure to start (ENOENT, EACCES), and
 * `ERR_CHILD_PROCESS_STDIO_MAXBUFFER` is output over `maxBuffer`. `stderr` is what the tool said.
 */
export type RunTool = (file: string, args: readonly string[], options: { timeoutMs: number; maxBuffer: number }) => Promise<{ stdout: string; stderr: string }>;

const DEFAULT_DPI = 150;
/**
 * The most pixels a rendered page may have (ruling R66): 50 megapixels, 150 MB of RGB for pdftoppm to hold. An A0 page is 34.8 megapixels at 150 dpi
 * and renders; a larger plan is refused before it is drawn.
 */
export const MAX_PAGE_PIXELS = 50_000_000;
const DEFAULT_TIMEOUT_MS = 120_000;
// pdfinfo prints about twenty short lines; anything near this size is a document whose metadata is trying to say something.
const INFO_OUTPUT_LIMIT = 256 * 1024;
const RENDER_OUTPUT_LIMIT = 1024 * 1024;
// A tool asked for its version answers at once; this is long enough for a machine that is busy and short enough for a start that waits for it.
const CHECK_TIMEOUT_MS = 20_000;
const PDF_FILE = 'in.pdf';
const PAGE_PREFIX = 'page';
// pdftoppm writes <prefix>-<n>.png, with n padded with zeros to the digits of the page count of the whole document: page-1.png, page-01.png, page-001.png.
const PAGE_FILE = /^page-(\d+)\.png$/;

const execFileAsync = promisify(execFile);
/** How the service starts the tools: execFile with an argument list, without the secrets of the service in their environment. Exported for its tests. */
export const execFileRunner: RunTool = async (file, args, { timeoutMs, maxBuffer }) => {
  const { stdout, stderr } = await execFileAsync(file, [...args], { timeout: timeoutMs, maxBuffer, encoding: 'utf8', windowsHide: true, env: childEnv(process.env) });
  return { stdout, stderr };
};

function assertMaxPages(maxPages: number): void {
  if (!Number.isInteger(maxPages) || maxPages < 1) throw new RangeError('maxPages must be a whole number of at least 1');
}

/**
 * Runs `work` in a new directory that only this process can read, and removes it afterwards, whatever happened. The removal is retried a few times
 * (a tool that was just stopped can still hold a file open on Windows) and then given up quietly: a directory that cannot be removed must not
 * turn a finished render into a failure, or hide the error that is already on its way.
 */
async function inPrivateDir<T>(work: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'docpipe-'));
  try {
    return await work(dir);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => undefined);
  }
}

/** The document could not be opened or rendered by the tool, said once for every way it fails. */
const damaged = (action: 'open' | 'render'): RequestError =>
  new RequestError('unreadable_source', `the PDF could not be ${action === 'open' ? 'opened' : 'rendered'} (it is damaged, or not a PDF)`);

/** What a failed tool run means. `action` is the verb of the tool's job, for the message. */
function toolFailure(binary: string, action: 'open' | 'render', error: unknown): Error {
  const e = (typeof error === 'object' && error !== null ? error : {}) as { code?: unknown; killed?: unknown; stderr?: unknown };
  // Over the output limit, or a numeric exit status, or a crash, or the time limit: the tool ran and the document is the trouble.
  if (e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return damaged(action);
  // Any other word for a code is the system saying the tool could not be started.
  if (typeof e.code === 'string') return new Error(`${binary} could not be run (${e.code}): poppler-utils must be installed and on PATH`, { cause: error });
  if (e.killed === true) return new RequestError('unreadable_source', `the PDF took too long to ${action}`);
  if (typeof e.stderr === 'string' && /incorrect password/i.test(e.stderr)) return new RequestError('unreadable_source', 'the PDF is password protected and cannot be read');
  return damaged(action);
}

/**
 * The page count in the output of pdfinfo. The last "Pages:" line is the tool's: the lines above it include fields the document fills in
 * itself (Title, Subject, Keywords, Author), which could contain a line break and a "Pages:" of their own; the lines after it do not.
 */
function pagesInfo(stdout: string): number | null {
  let last: string | undefined;
  for (const match of stdout.matchAll(/^Pages:\s+(\d+)\s*$/gm)) last = match[1];
  return last === undefined ? null : Number(last);
}

/** The size of a page in points: its width and its height. */
export interface PageSize { width: number; height: number }
/** What pdfinfo says of one page: its size line (the crop box) and its media box (with -box), each in points, and absent when pdfinfo printed none. */
export interface PageBoxes { size?: PageSize; mediaBox?: PageSize }

const PAGES_LINE = /^Pages:\s+(\d+)\s*$/;
// "Page %4d size:  %g x %g pts", then a paper name or nothing. %g writes a large or a small size with an exponent (1e+06).
const SIZE_LINE = /^Page\s+(\d+) size:\s+(\S+) x (\S+) pts(?: \(.*\))?\s*$/;
// With -box: "Page %4d MediaBox:  " and four "%8.2f", the corners x1 y1 x2 y2.
const MEDIA_BOX_LINE = /^Page\s+(\d+) MediaBox:\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s*$/;

/**
 * The page count and the boxes of each page in what `pdfinfo -box -f 1 -l <pages>` prints. Only the lines after the last "Pages:" line are read: the lines
 * above it include fields the document fills in itself (Title, Subject, Keywords, Author), which can hold a line break and lines of their own, and the
 * lines after it are the tool's. Each page has its size line (the crop box) and its media box (what pdftoppm renders), read apart and never merged: a size
 * line can be printed turned for a turned page while the media box is not. A side that is no number stays NaN, and a box pdfinfo printed no line for is
 * absent, for the caller to refuse. Exported for its tests.
 */
export function pageSizesOf(stdout: string): { total: number | null; sizes: Map<number, PageBoxes> } {
  const lines = stdout.split(/\r?\n/);
  let at = -1;
  for (const [i, line] of lines.entries()) if (PAGES_LINE.test(line)) at = i;
  const sizes = new Map<number, PageBoxes>();
  if (at < 0) return { total: null, sizes };
  const boxesOf = (page: number): PageBoxes => { const known = sizes.get(page) ?? {}; sizes.set(page, known); return known; };
  for (const line of lines.slice(at + 1)) {
    const size = SIZE_LINE.exec(line);
    if (size !== null) { boxesOf(Number(size[1])).size = { width: Number(size[2]), height: Number(size[3]) }; continue; }
    const box = MEDIA_BOX_LINE.exec(line);
    if (box !== null) boxesOf(Number(box[1])).mediaBox = { width: Math.abs(Number(box[4]) - Number(box[2])), height: Math.abs(Number(box[5]) - Number(box[3])) };
  }
  return { total: Number(PAGES_LINE.exec(lines[at])?.[1]), sizes };
}

/** The image pdftoppm makes of a page at `dpi`: each side is ceil(points / 72 x dpi) pixels, as utils/pdftoppm.cc sizes it. */
export function renderedPixels(size: PageSize, dpi: number): { width: number; height: number; pixels: number } {
  const width = Math.ceil((size.width * dpi) / 72);
  const height = Math.ceil((size.height * dpi) / 72);
  return { width, height, pixels: width * height };
}

/**
 * The image of the page that counts: each box counted in pixels at `dpi` on its own, and the larger count, the media box's on a tie (it is what pdftoppm
 * renders). With `box`, the box it measured. Exported for its tests.
 */
export function largestImage(boxes: Required<PageBoxes>, dpi: number): { box: PageSize; width: number; height: number; pixels: number } {
  const crop = renderedPixels(boxes.size, dpi);
  const media = renderedPixels(boxes.mediaBox, dpi);
  return crop.pixels > media.pixels ? { box: boxes.size, ...crop } : { box: boxes.mediaBox, ...media };
}

/** A number of points as a person reads it: at most two decimals. */
const points = (n: number): string => String(Math.round(n * 100) / 100);
/** A box with two sides that are numbers. */
const readable = (box: PageSize | undefined): box is PageSize => box !== undefined && Number.isFinite(box.width) && Number.isFinite(box.height);

/**
 * Refuses the document unless every page that would be rendered, the first `maxPages` of it, has a size line and a media box that pdfinfo printed, and
 * renders at `dpi` to at most MAX_PAGE_PIXELS by the larger of the two (ruling R66). A box that is missing or no number is unreadable_source, so that a
 * page is never measured by its crop box alone; a page over the bound is page_too_large, naming it and the box measured.
 */
function assertPagesFit(stdout: string, maxPages: number, dpi: number): void {
  const { total, sizes } = pageSizesOf(stdout);
  if (total === null || !Number.isSafeInteger(total) || total < 1) throw new RequestError('unreadable_source', 'the PDF has no pages');
  for (let page = 1; page <= Math.min(total, maxPages); page += 1) {
    const boxes = sizes.get(page);
    if (!readable(boxes?.size) || !readable(boxes?.mediaBox)) throw new RequestError('unreadable_source', `the size of page ${page} of the PDF could not be read`);
    const image = largestImage({ size: boxes.size, mediaBox: boxes.mediaBox }, dpi);
    if (image.pixels > MAX_PAGE_PIXELS) {
      throw new PipelineError('page_too_large', `Page ${page} of the PDF is ${points(image.box.width)} by ${points(image.box.height)} points, ${image.width} by ${image.height} pixels at ${dpi} dpi, `
        + `over the ${MAX_PAGE_PIXELS} pixels a page may have. Nothing was locked.`);
    }
  }
}

async function readPages(dir: string): Promise<Page[]> {
  const files = (await readdir(dir)).flatMap((name) => { const m = PAGE_FILE.exec(name); return m ? [{ name, number: Number(m[1]) }] : []; }).sort((a, b) => a.number - b.number);
  if (files.length === 0) throw new RequestError('unreadable_source', 'the PDF produced no page images');
  const pages: Page[] = [];
  for (const [i, { name, number }] of files.entries()) {
    // The pages are 1, 2, 3 ... with none missing: a page that failed to render must not pass as a shorter document.
    if (number !== i + 1) throw new RequestError('unreadable_source', `page ${i + 1} of the PDF could not be rendered`);
    const png = new Uint8Array(await readFile(join(dir, name)));
    if (sniffMime(png) !== 'image/png') throw new RequestError('unreadable_source', `page ${number} of the PDF could not be rendered`);
    pages.push({ index: number - 1, png });
  }
  return pages;
}

/** poppler's tools run through `run`. The seam exists so that tests can play the tools; production uses popplerRenderer. */
export function popplerRendererWith(run: RunTool, opts: PopplerOptions = {}): Renderer {
  const pdftoppm = opts.pdftoppm ?? 'pdftoppm';
  const pdfinfo = opts.pdfinfo ?? 'pdfinfo';
  const dpi = opts.dpi ?? DEFAULT_DPI;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(dpi) || dpi < 1) throw new RangeError('dpi must be a whole number of at least 1');
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new RangeError('timeoutMs must be a positive number');
  return {
    // Each tool is asked for its version. Poppler's -v does not always exit 0, so an exit with a status counts as a tool that is there; a tool that cannot be
    // started at all (not installed, not executable) or that does not answer in time does not.
    check: async () => {
      for (const tool of [pdfinfo, pdftoppm]) {
        try {
          await run(tool, ['-v'], { timeoutMs: CHECK_TIMEOUT_MS, maxBuffer: INFO_OUTPUT_LIMIT });
        } catch (error) {
          const e = (typeof error === 'object' && error !== null ? error : {}) as { code?: unknown; killed?: unknown; signal?: unknown };
          if (typeof e.code === 'number') continue;
          const reason = typeof e.code === 'string' ? e.code : e.killed === true ? `it did not answer within ${CHECK_TIMEOUT_MS / 1000} s` : String(e.signal ?? 'unknown');
          throw new Error(`${tool} cannot be run (${reason}): poppler-utils (pdfinfo and pdftoppm) must be installed and on PATH, and a PDF cannot be read without them`, { cause: error });
        }
      }
    },
    pageCount: (pdf) => inPrivateDir(async (dir) => {
      const file = join(dir, PDF_FILE);
      await writeFile(file, pdf);
      let stdout: string;
      try {
        ({ stdout } = await run(pdfinfo, [file], { timeoutMs, maxBuffer: INFO_OUTPUT_LIMIT }));
      } catch (error) {
        throw toolFailure(pdfinfo, 'open', error);
      }
      const total = pagesInfo(stdout);
      if (total === null || !Number.isSafeInteger(total) || total < 1) throw new RequestError('unreadable_source', 'the PDF has no pages');
      return total;
    }),
    render: async (pdf, maxPages) => {
      assertMaxPages(maxPages);
      return inPrivateDir(async (dir) => {
        const file = join(dir, PDF_FILE);
        await writeFile(file, pdf);
        // The size of every page that would be rendered, before pdftoppm allocates one (ruling R66).
        let sizes: string;
        try {
          ({ stdout: sizes } = await run(pdfinfo, ['-box', '-f', '1', '-l', String(maxPages), file], { timeoutMs, maxBuffer: INFO_OUTPUT_LIMIT }));
        } catch (error) {
          throw toolFailure(pdfinfo, 'open', error);
        }
        assertPagesFit(sizes, maxPages, dpi);
        try {
          await run(pdftoppm, ['-r', String(dpi), '-png', '-f', '1', '-l', String(maxPages), file, join(dir, PAGE_PREFIX)], { timeoutMs, maxBuffer: RENDER_OUTPUT_LIMIT });
        } catch (error) {
          throw toolFailure(pdftoppm, 'render', error);
        }
        return readPages(dir);
      });
    },
  };
}

/** The renderer of the service: pdfinfo and pdftoppm from poppler-utils, found on PATH unless the options name them. */
export function popplerRenderer(opts: PopplerOptions = {}): Renderer {
  return popplerRendererWith(execFileRunner, opts);
}

/**
 * The pages to read from a source, and the page count of the whole document. An image is one page (total 1) and is passed on as it is, so `mime`
 * is its own type; a PDF is counted, then rendered, and its pages are PNG. A PDF the renderer cannot open, one that has no pages, and one whose
 * pages the renderer could not all produce are unreadable_source. `pages` is never longer than `maxPages`, whatever the renderer returns.
 */
export async function pagesOf(source: SourceBytes, maxPages: number, renderer: Renderer): Promise<{ total: number; pages: Page[]; mime: string }> {
  assertMaxPages(maxPages);
  if (source.mime !== 'application/pdf') return { total: 1, pages: [{ index: 0, png: source.bytes }], mime: source.mime };
  const total = await renderer.pageCount(source.bytes);
  if (!Number.isSafeInteger(total) || total < 1) throw new RequestError('unreadable_source', 'the PDF has no pages');
  const wanted = Math.min(total, maxPages);
  const pages = (await renderer.render(source.bytes, maxPages)).slice(0, wanted);
  if (pages.length !== wanted) throw new RequestError('unreadable_source', `the PDF has ${total} pages but only ${pages.length} of the first ${wanted} could be rendered`);
  return { total, pages, mime: 'image/png' };
}
