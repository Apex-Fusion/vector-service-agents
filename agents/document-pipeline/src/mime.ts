// agents/document-pipeline/src/mime.ts
// The type of a document, read from its first bytes. A module of its own, with no imports, so that src/source.ts (which loads a document, and
// fetches it) and src/render.ts (which checks the pages poppler wrote) both use it, and the renderer does not load the fetch of a source.

/** The three types the service reads. */
export type Mime = 'application/pdf' | 'image/png' | 'image/jpeg';

// The type of a document is what its first bytes say, at byte 0. A PDF with anything in front of its header is refused: the check is the same one for
// every type, and a file that is two things at once is the one to be suspicious of.
const SIGNATURES: ReadonlyArray<{ mime: Mime; magic: readonly number[] }> = [
  { mime: 'application/pdf', magic: [0x25, 0x50, 0x44, 0x46, 0x2d] }, // %PDF-
  { mime: 'image/png', magic: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { mime: 'image/jpeg', magic: [0xff, 0xd8, 0xff] },
];

/** The type named by the first bytes, or null when they are none of the three. */
export function sniffMime(bytes: Uint8Array): Mime | null {
  for (const { mime, magic } of SIGNATURES) if (bytes.length >= magic.length && magic.every((byte, i) => bytes[i] === byte)) return mime;
  return null;
}
