// agents/document-pipeline/test/support.ts
// Shared by the tests: the checked-in fixtures (made by test/fixtures/make-pdf.mjs), a JPEG stand-in, and the two small conversions the tests use.
import { readFileSync } from 'node:fs';

/** A fixture file as a plain Uint8Array (a Buffer would not compare equal to the bytes the code under test returns). */
export const fixture = (name: string): Uint8Array => new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));

/** A real two-page PDF, 576 by 720 points: "Page one of the test document." and "Page two of the test document.". */
export const TWO_PAGES_PDF = fixture('two-pages.pdf');
/** Two 8 by 8 pixel PNGs that differ, the pages a fake renderer hands out. */
export const PAGE_0_PNG = fixture('page-0.png');
export const PAGE_1_PNG = fixture('page-1.png');
/** One page, locked with a user password (USER_PASSWORD of test/fixtures/make-pdf.mjs). */
export const ENCRYPTED_PDF = fixture('encrypted.pdf');
/** One page of 14400 by 14400 points, 200 by 200 inches: 900 megapixels at 150 dpi, which the size guard of src/render.ts refuses (ruling R66). */
export const HUGE_PAGE_PDF = fixture('huge-page.pdf');
/** The same page with a crop box of 576 by 720 points: pdfinfo's size line says 576 by 720, and pdftoppm renders the media box (the residual round of R66). */
export const CROPPED_HUGE_PAGE_PDF = fixture('cropped-huge-page.pdf');
/** A JFIF header and the end-of-image marker. Not a picture anyone could decode: the service reads only the three opening bytes. */
export const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xd9]);
export const toBase64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64');
export const text = (s: string): Uint8Array => new TextEncoder().encode(s);
