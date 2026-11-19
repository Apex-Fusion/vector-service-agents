// packages/id-kit/src/common/dpop.ts
// The two values of DPoP (RFC 9449) that the client writes and the verifier compares: the name of a request target (`htu`) and the name of an access token (`ath`).

import { createHash } from 'node:crypto';

/**
 * The form of a URL that `htu` is compared in: the scheme, the host (with the port when it is not the default one) and the path, with no query and no fragment (RFC 9449 Section 4.3,
 * and RFC 3986 Sections 6.2.2 and 6.2.3). Null for a text that is not an http or https URL.
 */
export function htuForm(uri: string): string | null {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return null;
  }
  return url.protocol === 'https:' || url.protocol === 'http:' ? `${url.protocol}//${url.host}${url.pathname}` : null;
}

/** The hash that names an access token in a proof (`ath`): the SHA-256 hash of the token as ASCII text, in base64url. */
export const tokenHash = (accessToken: string): string => createHash('sha256').update(accessToken, 'ascii').digest('base64url');
