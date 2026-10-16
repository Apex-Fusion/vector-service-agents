// agents/document-pipeline/src/source.ts
// Loading the document the request names: an https URL, or base64 carried in the request. What comes back is the exact bytes, their sha256 (the
// result commits to it as source.sha256) and a mime read from the first bytes. Nothing here posts an escrow: every refusal is a RequestError
// (422), thrown while the job has cost nothing.
//
// A URL is fetched by fetchUrlBytes of packages/service-kit: safeFetch around the injected fetch (ruling R20), with a tap that keeps the bytes.
import { fetchUrlBytes, sha256Hex } from '@vsa/service-kit';
import { sniffMime } from './mime.ts';
import type { Mime } from './mime.ts';
import { RequestError } from './request.ts';
import type { PipelineRequest } from './request.ts';

export interface SourceBytes {
  bytes: Uint8Array;
  mime: Mime;
  sha256: string;
  origin: 'url' | 'inline';
}
export interface SourceDeps {
  /** The fetch safeFetch calls once it has vetted the host. Production passes the platform fetch; tests pass a fake. */
  fetchImpl: typeof fetch;
  /** The most bytes a source may have, fetched or inline. Default 20 MB. */
  maxBytes?: number;
  /** The budget of the whole fetch, the host lookup included. Default 60 s. */
  timeoutMs?: number;
}

/** 20 MB, as the spec says. */
export const MAX_SOURCE_BYTES = 20 * 1024 * 1024;
export const SOURCE_FETCH_TIMEOUT_MS = 60_000;

const MIMES: readonly string[] = ['application/pdf', 'image/png', 'image/jpeg'];
// The type of a document is what its first bytes say (src/mime.ts); a header or a declaration that says otherwise is refused.

/** The type a Content-Type header claims, when it claims one of the three. Any other header (octet-stream, text/html, none) claims nothing. */
function claimedByHeader(header: string | null): Mime | null {
  const type = (header ?? '').split(';')[0].trim().toLowerCase();
  return MIMES.includes(type) ? (type as Mime) : null;
}

/** The checks both origins share: the first bytes name a supported type, and it is the type that was claimed, if anything claimed one. */
function describeSource(bytes: Uint8Array, claimed: Mime | null, claim: 'served as' | 'declared as', origin: SourceBytes['origin']): SourceBytes {
  const mime = sniffMime(bytes);
  if (mime === null) throw new RequestError('source_unsupported', 'the source is not a PDF, PNG or JPEG file (the type is read from the first bytes of the file)');
  if (claimed !== null && claimed !== mime) throw new RequestError('source_mime_mismatch', `the source is ${mime} but was ${claim} ${claimed}`);
  return { bytes, mime, sha256: sha256Hex(bytes), origin };
}

async function fromUrl(url: string, fetchImpl: typeof fetch, maxBytes: number, timeoutMs: number): Promise<SourceBytes> {
  const { bytes, contentType } = await fetchUrlBytes(url, { fetchImpl, maxBytes, timeoutMs, refuse: (code, message) => new RequestError(code, message) });
  return describeSource(bytes, claimedByHeader(contentType), 'served as', 'url');
}

function fromInline(base64: string, claimed: Mime, maxBytes: number): SourceBytes {
  const decoded = Buffer.from(base64, 'base64');
  if (decoded.length > maxBytes) throw new RequestError('source_too_large', `the source is larger than ${maxBytes} bytes`);
  // A copy: a small Buffer sits in a pool shared with other buffers, and its .buffer holds more than its bytes.
  return describeSource(new Uint8Array(decoded), claimed, 'declared as', 'inline');
}

/**
 * The document of a request. A URL is fetched under the rules above and an inline source is decoded. The mime is read from the first bytes. It is a
 * RequestError (source_mime_mismatch) when the bytes are a different supported type from the one the request declared (inline) or the server
 * served (a Content-Type that names one of the three), and source_unsupported when they are none of the three.
 */
export async function loadSource(req: PipelineRequest, deps: SourceDeps): Promise<SourceBytes> {
  const maxBytes = deps.maxBytes ?? MAX_SOURCE_BYTES;
  const { source } = req;
  if ('url' in source) return fromUrl(source.url, deps.fetchImpl, maxBytes, deps.timeoutMs ?? SOURCE_FETCH_TIMEOUT_MS);
  return fromInline('pdf_b64' in source ? source.pdf_b64 : source.image_b64, source.mime, maxBytes);
}
