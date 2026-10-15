// agents/document-pipeline/src/render.ts
// From the source to the pages that are read: an image is one page as it is, a PDF is rendered to PNG at 150 dpi by poppler (pdfinfo for the page
// count, pdftoppm for the pages). Like src/source.ts it runs before any escrow is posted, and a PDF that cannot be read is refused here
// (unreadable_source, 422) while it has cost nothing: locked with a password, damaged, cut short, with no pages, or so slow to open that the
// tool is stopped.
//
// The PDF is the caller's and poppler parses it, so it never meets a shell: the tools are started with an argument list (execFile), on a file in a
// directory that only this process can read (mkdtemp), and the directory is removed whatever happened. What the tools print is not passed on:
// their messages can name paths and offsets, and the person who sent the document gets a sentence of ours.
//
// A tool that cannot be started at all (not installed, not executable) is not a verdict on the document. That is a plain Error, which the
// server reports as a failure of its own, not as a RequestError.
import { execFile } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { RequestError } from './request.ts';
import { sniffMime } from './source.ts';
import type { SourceBytes } from './source.ts';

/** One page, as the image the OCR agent is sent. For a PNG or a rendered PDF page the bytes are a PNG; for a JPEG source they are the JPEG's own (see `mime` of pagesOf). */
export interface Page { index: number; png: Uint8Array }
export interface Renderer {
  /** The pages in the whole document. Rejects with unreadable_source for a PDF that cannot be opened. */
  pageCount(pdf: Uint8Array): Promise<number>;
  /** The first `maxPages` pages (fewer when the document is shorter), index 0 first. */
  render(pdf: Uint8Array, maxPages: number): Promise<Page[]>;
}

export interface PopplerOptions { pdftoppm?: string; pdfinfo?: string; dpi?: number; timeoutMs?: number }

/**
 * How the tools are started. It resolves with what the tool printed when it exited 0 and rejects with the error of node's execFile otherwise:
 * a numeric `code` is an exit status, `killed` true is the time limit, a string `code` is a failure to start (ENOENT, EACCES), and
 * `ERR_CHILD_PROCESS_STDIO_MAXBUFFER` is output over `maxBuffer`. `stderr` is what the tool said.
 */
export type RunTool = (file: string, args: readonly string[], options: { timeoutMs: number; maxBuffer: number }) => Promise<{ stdout: string; stderr: string }>;

const DEFAULT_DPI = 150;
const DEFAULT_TIMEOUT_MS = 120_000;
// pdfinfo prints about twenty short lines; anything near this size is a document whose metadata is trying to say something.
const INFO_OUTPUT_LIMIT = 256 * 1024;
const RENDER_OUTPUT_LIMIT = 1024 * 1024;
const PDF_FILE = 'in.pdf';
const PAGE_PREFIX = 'page';
// pdftoppm writes <prefix>-<n>.png, with n padded with zeros to the digits of the page count of the whole document: page-1.png, page-01.png, page-001.png.
const PAGE_FILE = /^page-(\d+)\.png$/;

const execFileAsync = promisify(execFile);
const execFileRunner: RunTool = async (file, args, { timeoutMs, maxBuffer }) => {
  const { stdout, stderr } = await execFileAsync(file, [...args], { timeout: timeoutMs, maxBuffer, encoding: 'utf8', windowsHide: true });
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

/** What a failed tool run means. `action` is the verb of the tool's job, for the message. */
function toolFailure(binary: string, action: 'open' | 'render', error: unknown): Error {
  const e = (typeof error === 'object' && error !== null ? error : {}) as { code?: unknown; killed?: unknown; stderr?: unknown };
  // Over the output limit, or a numeric exit status, or a crash, or the time limit: the tool ran and the document is the trouble.
  if (e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return new RequestError('unreadable_source', `the PDF could not be ${action === 'open' ? 'opened' : 'rendered'} (it is damaged, or not a PDF)`);
  // Any other word for a code is the system saying the tool could not be started.
  if (typeof e.code === 'string') return new Error(`${binary} could not be run (${e.code}): poppler-utils must be installed and on PATH`, { cause: error });
  if (e.killed === true) return new RequestError('unreadable_source', `the PDF took too long to ${action}`);
  if (typeof e.stderr === 'string' && /incorrect password/i.test(e.stderr)) return new RequestError('unreadable_source', 'the PDF is password protected and cannot be read');
  return new RequestError('unreadable_source', `the PDF could not be ${action === 'open' ? 'opened' : 'rendered'} (it is damaged, or not a PDF)`);
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
