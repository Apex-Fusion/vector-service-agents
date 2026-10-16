// agents/document-pipeline/test/page-size.test.ts
// The size guard of src/render.ts (ruling R66): what `pdfinfo -box -f 1 -l <pages>` prints, read into the size of each page, and the pages that would
// render over MAX_PAGE_PIXELS refused before pdftoppm allocates them. The output below is written with the formats of poppler's utils/pdfinfo.cc
// (24.04): "Page %4d size:  %g x %g pts" with an optional paper name, "Page %4d rot:   %d", and with -box "Page %4d MediaBox:  " followed by four
// "%8.2f". pdfinfo's size line is the crop box of the page (getPageCropWidth); pdftoppm renders the media box unless it is told -cropbox
// (utils/pdftoppm.cc, getPageMediaWidth), so the media box counts too. The real tool is run on the fixtures in test/render.test.ts, where poppler is
// installed (CI).
import { describe, test, expect } from 'vitest';
import { MAX_PAGE_PIXELS, pageSizesOf, renderedPixels } from '../src/render.ts';

/** `pdfinfo -box -f 1 -l 2` on a twelve-page document whose first page is letter and whose second is A4, turned. */
const CAPTURED = [
  'Title:           Quarterly report',
  'Producer:        a PDF writer',
  'CreationDate:    Thu Oct 15 09:00:00 2026 UTC',
  'Custom Metadata: no',
  'Metadata Stream: no',
  'Tagged:          no',
  'UserProperties:  no',
  'Suspects:        no',
  'Form:            none',
  'JavaScript:      no',
  'Pages:           12',
  'Encrypted:       no',
  'Page    1 size:  612 x 792 pts (letter)',
  'Page    1 rot:   0',
  'Page    2 size:  595.276 x 841.89 pts (A4)',
  'Page    2 rot:   90',
  'Page    1 MediaBox:      0.00     0.00   612.00   792.00',
  'Page    1 CropBox:       0.00     0.00   612.00   792.00',
  'Page    1 BleedBox:      0.00     0.00   612.00   792.00',
  'Page    1 TrimBox:       0.00     0.00   612.00   792.00',
  'Page    1 ArtBox:        0.00     0.00   612.00   792.00',
  'Page    2 MediaBox:      0.00     0.00   595.28   841.89',
  'Page    2 CropBox:       0.00     0.00   595.28   841.89',
  'Page    2 BleedBox:      0.00     0.00   595.28   841.89',
  'Page    2 TrimBox:       0.00     0.00   595.28   841.89',
  'Page    2 ArtBox:        0.00     0.00   595.28   841.89',
  'File size:       48213 bytes',
  'Optimized:       no',
  'PDF version:     1.7',
  '',
].join('\n');

describe('pageSizesOf: the output of pdfinfo -box -f 1 -l <pages>', () => {
  test('reads the page count of the document and, for each page it describes, the larger of its size line and its media box', () => {
    const { total, sizes } = pageSizesOf(CAPTURED);
    expect(total).toBe(12);
    expect([...sizes.keys()]).toStrictEqual([1, 2]);
    expect(sizes.get(1)).toStrictEqual({ width: 612, height: 792 });
    expect(sizes.get(2)).toStrictEqual({ width: 595.28, height: 841.89 });
  });

  test('a media box larger than the crop box decides: that is the box pdftoppm renders', () => {
    const stdout = CAPTURED.replace('Page    1 MediaBox:      0.00     0.00   612.00   792.00', 'Page    1 MediaBox:      0.00     0.00 14400.00 14400.00');
    expect(pageSizesOf(stdout).sizes.get(1)).toStrictEqual({ width: 14400, height: 14400 });
    // A box written from its far corner is the same box.
    const reversed = CAPTURED.replace('Page    1 MediaBox:      0.00     0.00   612.00   792.00', 'Page    1 MediaBox:    612.00   792.00     0.00     0.00');
    expect(pageSizesOf(reversed).sizes.get(1)).toStrictEqual({ width: 612, height: 792 });
  });

  test('a size line alone is enough, and %g writes large and small sizes with an exponent', () => {
    const stdout = 'Pages:           3\nEncrypted:       no\nPage    1 size:  1e+06 x 792 pts\nPage    1 rot:   0\nPage    2 size:  1.23457e+06 x 2.5e-05 pts\nPage    3 size:  14400 x 14400 pts\nFile size:       9 bytes\n';
    const { total, sizes } = pageSizesOf(stdout);
    expect(total).toBe(3);
    expect(sizes.get(1)).toStrictEqual({ width: 1_000_000, height: 792 });
    expect(sizes.get(2)).toStrictEqual({ width: 1_234_570, height: 0.000025 });
    expect(sizes.get(3)).toStrictEqual({ width: 14400, height: 14400 });
  });

  test('Windows line endings are fine', () => {
    expect(pageSizesOf(CAPTURED.replaceAll('\n', '\r\n')).sizes.get(2)).toStrictEqual({ width: 595.28, height: 841.89 });
  });

  test('lines planted in the document\'s own metadata, above the tool\'s last "Pages:" line, do not count', () => {
    const planted = CAPTURED.replace('Title:           Quarterly report', 'Title:           x\nPages: 1\nPage    1 size:  1 x 1 pts\nPage    1 MediaBox:      0.00     0.00     1.00     1.00\nPage    3 size:  1 x 1 pts');
    const { total, sizes } = pageSizesOf(planted);
    expect(total).toBe(12);
    expect(sizes.get(1)).toStrictEqual({ width: 612, height: 792 });
    expect(sizes.has(3)).toBe(false);
  });

  test('no "Pages:" line, or nothing after it, gives no sizes', () => {
    expect(pageSizesOf('')).toStrictEqual({ total: null, sizes: new Map() });
    expect(pageSizesOf('Title: x\nPage    1 size:  612 x 792 pts\n')).toStrictEqual({ total: null, sizes: new Map() });
    expect(pageSizesOf('Pages:           2\n').sizes.size).toBe(0);
  });

  test('a size that is no number is kept as not a number, for the caller to refuse', () => {
    const { sizes } = pageSizesOf('Pages:           1\nPage    1 size:  inf x nan pts\n');
    expect(Number.isNaN(sizes.get(1)?.width)).toBe(true);
  });
});

describe('renderedPixels and MAX_PAGE_PIXELS', () => {
  test('the pixels of a page as pdftoppm sizes it: each side ceil(points / 72 x dpi)', () => {
    expect(renderedPixels({ width: 576, height: 720 }, 150)).toStrictEqual({ width: 1200, height: 1500, pixels: 1_800_000 });
    expect(renderedPixels({ width: 595.28, height: 841.89 }, 150)).toStrictEqual({ width: 1241, height: 1754, pixels: 1241 * 1754 });
    expect(renderedPixels({ width: 14400, height: 14400 }, 150)).toStrictEqual({ width: 30000, height: 30000, pixels: 900_000_000 });
  });

  test('the bound is 50000000 pixels: an A0 page renders at 150 dpi (34.8 megapixels), and not at 300 dpi', () => {
    expect(MAX_PAGE_PIXELS).toBe(50_000_000);
    const a0 = { width: 2383.94, height: 3370.39 };
    expect(renderedPixels(a0, 150).pixels).toBeLessThanOrEqual(MAX_PAGE_PIXELS);
    expect(renderedPixels(a0, 150).pixels).toBeGreaterThan(34_000_000);
    expect(renderedPixels(a0, 300).pixels).toBeGreaterThan(MAX_PAGE_PIXELS);
  });
});
