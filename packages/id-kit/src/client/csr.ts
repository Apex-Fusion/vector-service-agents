// packages/id-kit/src/client/csr.ts
// The certification request of an X.509-SVID request: a PKCS #10 request (RFC 2986) for a P-256 key, signed with ecdsa-with-SHA256. The gateway reads only the key
// from it, and it sets every name of the certificate itself, so the subject is empty and the request has no attribute. The DER writers are the gateway's (src/vendored/m4/der.ts).

import { createPublicKey } from 'node:crypto';
import type { ResolvedKey } from '../common/keys.ts';
import { bitString, ecdsaSignatureDer, explicit, oid, sequence, unsignedInteger } from '../vendored/m4/der.ts';

const ECDSA_WITH_SHA256 = '1.2.840.10045.4.3.2';

/** The DER of the request for `key`, signed by it. */
export async function createCertificationRequest(key: ResolvedKey): Promise<Buffer> {
  if (key.kind !== 'P256') throw new TypeError('the key of an X.509-SVID is a P-256 key');
  const spki = createPublicKey({ key: { ...key.jwk }, format: 'jwk' }).export({ format: 'der', type: 'spki' });
  // version 0, an empty subject, the public key, and no attribute: [0] with no content.
  const info = sequence(unsignedInteger(Uint8Array.of(0)), sequence(), spki, explicit(0, Buffer.alloc(0)));
  return sequence(info, sequence(oid(ECDSA_WITH_SHA256)), bitString(ecdsaSignatureDer(await key.sign(info))));
}

/** PEM text of DER bytes (RFC 7468 Section 2): 64 characters in a line. */
export function pem(label: string, der: Uint8Array): string {
  const lines = Buffer.from(der).toString('base64').match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----\n`;
}
