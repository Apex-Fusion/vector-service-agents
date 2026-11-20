// packages/usecase-kit/src/access/url.ts
// The URL of a call, read before anything is sent. A credential is for one resource, and a call may carry it only to a URL below that resource. The text of a URL is not the place that a client
// sends to: the `fetch` of Node and a proxy remove dot segments, so `…/erp/../po` reaches `…/po`. So this file compares the PARSED URL, and it refuses a text that is not equal to its parsed form.
// It is not part of the public surface: the index of the folder does not export this file.

/** An encoded dot, slash or backslash: a server or a proxy that decodes the path reads them as the structure of the path. */
const ENCODED_STRUCTURE = /%2e|%2f|%5c/i;

/** The origin of an https URL, or null when the text is not one. */
export function httpsOriginOf(text: string): string | null {
  try {
    const url = new URL(text);
    return url.protocol === 'https:' ? url.origin : null;
  } catch {
    return null;
  }
}

/**
 * The first rule that `url` breaks, or null when a call may go to it. `origin` is the origin of the host of the kind of the call, and `resource` is the URL that the credential is for, on that host:
 * the URL must be equal to its parsed form, and it has no user part, no query, no fragment, no backslash and no encoded dot or slash. Then its origin is `origin`, and its path holds the path
 * of `resource` as whole segments: `/t/run1/erp` holds `/t/run1/erp` and `/t/run1/erp/stock/A`, and it does not hold `/t/run1/erpx` or `/t/run1/erp/../po`.
 */
export function urlProblem(url: unknown, origin: string, resource: string): string | null {
  if (typeof url !== 'string') return 'the URL of the call is not text';
  if (url.includes('\\')) return 'the URL of the call has a backslash';
  let parsed: URL;
  let wanted: URL;
  try {
    parsed = new URL(url);
    wanted = new URL(resource);
  } catch {
    return 'the URL of the call, or the resource of the credential, cannot be parsed';
  }
  if (parsed.href !== url) return 'the URL of the call is not equal to its parsed form: it has a dot segment, a capital letter in the host, a default port, or a character that is removed';
  if (parsed.protocol !== 'https:') return 'the URL of the call is not an https URL';
  if (parsed.username !== '' || parsed.password !== '') return 'the URL of the call has a user part';
  if (url.includes('?') || url.includes('#')) return 'the URL of the call has a query or a fragment';
  if (ENCODED_STRUCTURE.test(parsed.pathname)) return 'the URL of the call has an encoded dot, slash or backslash in its path';
  if (parsed.origin !== origin) return 'the URL of the call is not on the host of its kind';
  if (wanted.origin !== origin) return 'the resource of the credential is not on the host of its kind';
  const have = parsed.pathname.split('/');
  const want = wanted.pathname.split('/');
  return want.length <= have.length && want.every((segment, index) => segment === have[index]) ? null : 'the URL of the call is not below the resource of the credential';
}
