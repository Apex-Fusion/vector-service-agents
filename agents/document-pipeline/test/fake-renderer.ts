// agents/document-pipeline/test/fake-renderer.ts
// A renderer that needs no poppler: a document of `total` pages whose pages are the two fixture PNGs in turn (8 by 8 pixels, made by
// test/fixtures/make-pdf.mjs). It records what it was asked, so a test can see the page budget it was given.
import type { Page, Renderer } from '../src/render.ts';
import { PAGE_0_PNG, PAGE_1_PNG } from './support.ts';

export interface FakeRenderer extends Renderer {
  /** How many times pageCount was called, and the maxPages of each render call. */
  calls: { pageCount: number; render: number[] };
}

/**
 * `honourMaxPages` false makes a renderer that is sloppy about its page budget and hands back every page, the way a real one could if it were
 * asked for fewer pages than the document has and ignored the request.
 */
export function fakeRenderer(options: { total?: number; honourMaxPages?: boolean } = {}): FakeRenderer {
  const total = options.total ?? 2;
  const honourMaxPages = options.honourMaxPages ?? true;
  const all: Page[] = Array.from({ length: total }, (_, index) => ({ index, png: index % 2 === 0 ? PAGE_0_PNG : PAGE_1_PNG }));
  const calls: FakeRenderer['calls'] = { pageCount: 0, render: [] };
  return {
    calls,
    async pageCount() { calls.pageCount += 1; return total; },
    async render(_pdf, maxPages) { calls.render.push(maxPages); return honourMaxPages ? all.slice(0, maxPages) : all; },
  };
}
