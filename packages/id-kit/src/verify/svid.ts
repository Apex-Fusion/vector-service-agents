// packages/id-kit/src/verify/svid.ts
// SPIFFE identity documents of an agent, checked against the bundle of the trust domain (GET /spiffe/bundle, the https_web profile of the SPIFFE federation standard).
// The SPIFFE ID of an agent is `spiffe://<trust domain>/agent/<identifier>`. The trust domain is the host of the gateway.
// - X.509-SVID (SPIFFE X509-SVID standard): the certificate must chain to an authority of the bundle, be inside its validity, be no CA, have the key usage digitalSignature and neither
//   keyCertSign nor cRLSign, and have exactly one URI name: a SPIFFE ID of this trust domain. The check reads the DER of the certificate with the strict reader of the gateway, because
//   node:crypto does not give the key usage bits or the exact names.
// - JWT-SVID (SPIFFE JWT-SVID standard): an ES256 JWT that a key of the bundle (use jwt-svid) signed, with `sub` a SPIFFE ID of this trust domain, `aud` naming the resource, and a life
//   of 5 minutes at most.
// An SVID has no entry in a status list: the gateway gives X.509-SVIDs the noRevAvail extension. An SVID ends by its time. A caller that must know whether the agent is still Active
// resolves its DID (`resolve` of the client).

import { X509Certificate } from 'node:crypto';
import { MAX_TOKEN_LIFETIME_S } from '../common/constants.ts';
import { didOf } from '../common/did.ts';
import { isNumber, isRecord, isStringList } from '../common/json.ts';
import { accept, refuse, type Check } from '../common/result.ts';
import { DerError, children, decode, decodeOid, type DerNode } from '../vendored/m4/der.ts';
import { verifyGatewayJws, parseKeySet, type KeySet } from './keys.ts';

export const BUNDLE_RULES = ['bundle.malformed'] as const;
export type BundleRule = (typeof BUNDLE_RULES)[number];

export const X509_SVID_RULES = [
  'x509.malformed',
  'x509.bundle',
  'x509.untrusted',
  'x509.not_yet_valid',
  'x509.expired',
  'x509.ca',
  'x509.key_usage',
  'x509.san',
  'x509.spiffe_id',
  'x509.trust_domain',
] as const;
export type X509SvidRule = (typeof X509_SVID_RULES)[number];

export const JWT_SVID_RULES = [
  'jwt_svid.malformed',
  'jwt_svid.alg',
  'jwt_svid.typ',
  'jwt_svid.kid',
  'jwt_svid.signature',
  'jwt_svid.claims',
  'jwt_svid.subject',
  'jwt_svid.trust_domain',
  'jwt_svid.audience',
  'jwt_svid.lifetime',
  'jwt_svid.expired',
  'jwt_svid.not_yet_valid',
] as const;
export type JwtSvidRule = (typeof JWT_SVID_RULES)[number];

const JWT_SVID_JWS_RULES = { malformed: 'jwt_svid.malformed', alg: 'jwt_svid.alg', typ: 'jwt_svid.typ', kid: 'jwt_svid.kid', signature: 'jwt_svid.signature' } as const;

/** The bundle of a trust domain: its X.509 authorities and its JWT-SVID keys. */
export interface SpiffeBundle {
  /** The `spiffe_sequence` of the bundle, which orders two versions of it, or null when it has none. */
  readonly sequence: number | null;
  /** The `spiffe_refresh_hint` of the bundle: the seconds after which a caller reads it again, or null when it has none. */
  readonly refreshHintSeconds: number | null;
  /** The certificates of the X.509 authorities (the `x5c` of each key with `use` x509-svid). */
  readonly authorities: readonly X509Certificate[];
  /** The keys for JWT-SVIDs (the keys with `use` jwt-svid), by `kid`. */
  readonly jwtKeys: KeySet;
}

/** Reads a SPIFFE bundle. An authority that is no certificate, or that is not the key of its JWK, makes the bundle malformed. A key with another `use` is left out. */
export function parseBundle(value: unknown): Check<SpiffeBundle, BundleRule> {
  if (!isRecord(value) || !Array.isArray(value.keys)) return refuse('bundle.malformed', 'the bundle is not an object with a keys list');
  const authorities: X509Certificate[] = [];
  const jwtEntries: unknown[] = [];
  for (const entry of value.keys) {
    if (!isRecord(entry)) return refuse('bundle.malformed', 'a key of the bundle is not an object');
    if (entry.use === 'jwt-svid') jwtEntries.push(entry);
    if (entry.use !== 'x509-svid') continue;
    if (!isStringList(entry.x5c) || entry.x5c.length === 0) return refuse('bundle.malformed', 'a key for X.509-SVIDs has no x5c');
    let certificate: X509Certificate;
    try {
      certificate = new X509Certificate(Buffer.from(entry.x5c[0]!, 'base64'));
    } catch {
      return refuse('bundle.malformed', 'the x5c of a key for X.509-SVIDs is not a certificate');
    }
    const key = certificate.publicKey.export({ format: 'jwk' });
    if (key.x !== entry.x || key.y !== entry.y) return refuse('bundle.malformed', 'the certificate in x5c does not hold the key of its JWK');
    authorities.push(certificate);
  }
  let jwtKeys: KeySet = new Map();
  if (jwtEntries.length > 0) {
    const keys = parseKeySet({ keys: jwtEntries }, null);
    if (!keys.ok) return refuse('bundle.malformed', `the JWT-SVID keys of the bundle are not acceptable: ${keys.detail}`);
    jwtKeys = keys.value;
  }
  return accept({
    sequence: isNumber(value.spiffe_sequence) ? value.spiffe_sequence : null,
    refreshHintSeconds: isNumber(value.spiffe_refresh_hint) ? value.spiffe_refresh_hint : null,
    authorities,
    jwtKeys,
  });
}

const SPIFFE_ID = /^spiffe:\/\/([a-z0-9._-]+)\/agent\/([0-9a-f]{64})$/;

/** The trust domain and the agent identifier of a SPIFFE ID of an agent, or null for any other text. */
export function parseSpiffeId(text: unknown): { readonly trustDomain: string; readonly agentId: string } | null {
  const match = typeof text === 'string' ? SPIFFE_ID.exec(text) : null;
  return match === null ? null : { trustDomain: match[1]!, agentId: match[2]! };
}

export interface SvidContext {
  readonly bundle: SpiffeBundle;
  /** The trust domain that an SVID must be in: the host of the gateway. */
  readonly trustDomain: string;
  readonly nowMs: number;
  readonly leewaySeconds: number;
}

export interface VerifiedX509Svid {
  readonly spiffeId: string;
  readonly trustDomain: string;
  /** The identifier of the agent: the last part of the SPIFFE ID. */
  readonly agentId: string;
  readonly did: string;
  /** The serial number, in hex. */
  readonly serialNumber: string;
  readonly fingerprint256: string;
  /** POSIX ms. */
  readonly notBefore: number;
  readonly notAfter: number;
}

const OID_BASIC_CONSTRAINTS = '2.5.29.19';
const OID_KEY_USAGE = '2.5.29.15';
const OID_SUBJECT_ALT_NAME = '2.5.29.17';
const TAG_UTC_TIME = 0x17;
const TAG_GENERALIZED_TIME = 0x18;
const TAG_URI_NAME = 0x86;

/** A certificate time (RFC 5280 Section 4.1.2.5): UTCTime `YYMMDDHHMMSSZ` (the years 1950 to 2049) or GeneralizedTime `YYYYMMDDHHMMSSZ`. POSIX ms, or null. */
function derTime(node: DerNode | undefined): number | null {
  if (node === undefined || (node.tag !== TAG_UTC_TIME && node.tag !== TAG_GENERALIZED_TIME)) return null;
  const text = node.content.toString('ascii');
  const parts = (node.tag === TAG_UTC_TIME ? /^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/ : /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/).exec(text);
  if (parts === null) return null;
  const [year, month, day, hour, minute, second] = [parts[1], parts[2], parts[3], parts[4], parts[5], parts[6]].map(Number);
  const fullYear = node.tag === TAG_UTC_TIME ? (year >= 50 ? 1900 + year : 2000 + year) : year;
  const ms = Date.UTC(fullYear, month - 1, day, hour, minute, second);
  return Number.isNaN(ms) ? null : ms;
}

interface CertificateFacts {
  readonly notBefore: number;
  readonly notAfter: number;
  readonly isCa: boolean;
  /** The key usage bits of the first byte, or null when the certificate has no key usage extension. */
  readonly keyUsage: number | null;
  /** The URI names, and the count of the names of every other type. */
  readonly uriNames: readonly string[];
}

/** The facts of a certificate that the SVID rules need, read from its DER. Throws a DerError for DER that is not well formed or a certificate that is not of version 3. */
function readCertificate(raw: Buffer): CertificateFacts {
  const [tbs] = children(decode(raw));
  const fields = children(tbs!);
  const first = fields[0]!;
  // [0] EXPLICIT version, then serialNumber, signature, issuer, validity, subject, subjectPublicKeyInfo.
  if (first.tag !== 0xa0) throw new DerError('the certificate is not of version 3');
  const validity = children(fields[4]!);
  const notBefore = derTime(validity[0]);
  const notAfter = derTime(validity[1]);
  if (notBefore === null || notAfter === null) throw new DerError('the validity of the certificate is not two times');
  const container = fields.find((f) => f.tag === 0xa3);
  let isCa = false;
  let keyUsage: number | null = null;
  const uriNames: string[] = [];
  if (container !== undefined) {
    for (const extension of children(children(container)[0]!)) {
      const parts = children(extension);
      const id = decodeOid(parts[0]!);
      const value = decode(parts[parts.length - 1]!.content);
      if (id === OID_BASIC_CONSTRAINTS) {
        const flag = children(value)[0];
        isCa = flag !== undefined && flag.tag === 0x01 && flag.content[0] !== 0;
      } else if (id === OID_KEY_USAGE) {
        // BIT STRING: the first content byte counts the unused bits, and the next byte holds bits 0 to 7 (digitalSignature is 0x80, keyCertSign 0x04, cRLSign 0x02).
        keyUsage = value.tag === 0x03 && value.content.length >= 2 ? value.content[1]! : 0;
      } else if (id === OID_SUBJECT_ALT_NAME) {
        for (const name of children(value)) if (name.tag === TAG_URI_NAME) uriNames.push(name.content.toString('ascii'));
      }
    }
  }
  return { notBefore, notAfter, isCa, keyUsage, uriNames };
}

/** Reads a certificate that a caller gives as PEM text, as base64 of its DER, or as DER bytes. Throws when it is none of them. */
function toCertificate(input: string | Uint8Array): X509Certificate {
  if (typeof input !== 'string') return new X509Certificate(Buffer.from(input));
  return input.includes('-----BEGIN') ? new X509Certificate(input) : new X509Certificate(Buffer.from(input.trim(), 'base64'));
}

const DIGITAL_SIGNATURE = 0x80;
const KEY_CERT_SIGN = 0x04;
const CRL_SIGN = 0x02;

/**
 * Checks an X.509-SVID against the bundle. `certificate` is the leaf, as PEM text, as base64 DER (the form of a header that a proxy sets), or as DER bytes. The trust check is first, so
 * that a certificate from outside the trust domain is refused for that reason, whatever else it holds.
 */
export function verifyX509Svid(certificate: string | Uint8Array, ctx: SvidContext): Check<VerifiedX509Svid, X509SvidRule> {
  let leaf: X509Certificate;
  let facts: CertificateFacts;
  try {
    leaf = toCertificate(certificate);
    facts = readCertificate(Buffer.from(leaf.raw));
  } catch {
    return refuse('x509.malformed', 'the certificate cannot be read as an X.509 certificate of version 3');
  }
  const now = ctx.nowMs;
  const usable = ctx.bundle.authorities.filter((ca) => {
    const authority = readCertificateWindow(ca);
    return ca.ca && authority !== null && authority.notBefore <= now + ctx.leewaySeconds * 1000 && now < authority.notAfter;
  });
  if (usable.length === 0) return refuse('x509.bundle', 'the bundle has no X.509 authority that is a CA and is valid now');
  const issuer = usable.find((ca) => leaf.verify(ca.publicKey) && leaf.checkIssued(ca));
  if (issuer === undefined) return refuse('x509.untrusted', 'the certificate was not issued by an authority of the bundle');
  if (facts.notBefore > now + ctx.leewaySeconds * 1000) return refuse('x509.not_yet_valid', 'the certificate is not valid yet');
  if (now >= facts.notAfter) return refuse('x509.expired', 'the certificate has expired');
  if (facts.isCa) return refuse('x509.ca', 'the certificate is a CA: an SVID is a leaf');
  if (facts.keyUsage === null || (facts.keyUsage & DIGITAL_SIGNATURE) === 0 || (facts.keyUsage & (KEY_CERT_SIGN | CRL_SIGN)) !== 0) {
    return refuse('x509.key_usage', 'an SVID has the key usage digitalSignature, and neither keyCertSign nor cRLSign');
  }
  if (facts.uriNames.length !== 1) return refuse('x509.san', `an SVID has exactly one URI name, and this certificate has ${facts.uriNames.length}`);
  const spiffeId = facts.uriNames[0]!;
  const parsed = parseSpiffeId(spiffeId);
  if (parsed === null) return refuse('x509.spiffe_id', 'the URI name is not a SPIFFE ID of an agent: spiffe://<trust domain>/agent/<64 hex characters>');
  if (parsed.trustDomain !== ctx.trustDomain) return refuse('x509.trust_domain', `the SPIFFE ID is in the trust domain ${parsed.trustDomain}, and this gateway is ${ctx.trustDomain}`);
  return accept({
    spiffeId,
    trustDomain: parsed.trustDomain,
    agentId: parsed.agentId,
    did: didOf(parsed.agentId),
    serialNumber: leaf.serialNumber.toLowerCase(),
    fingerprint256: leaf.fingerprint256,
    notBefore: facts.notBefore,
    notAfter: facts.notAfter,
  });
}

/** The validity window of an authority certificate, or null when its DER cannot be read. */
function readCertificateWindow(ca: X509Certificate): { notBefore: number; notAfter: number } | null {
  try {
    const { notBefore, notAfter } = readCertificate(Buffer.from(ca.raw));
    return { notBefore, notAfter };
  } catch {
    return null;
  }
}

export interface JwtSvidContext extends SvidContext {
  /** The identifier of this resource: `aud` must name it. */
  readonly audience: string;
  readonly maxLifetimeSeconds?: number;
}

export interface VerifiedJwtSvid {
  readonly spiffeId: string;
  readonly agentId: string;
  readonly did: string;
  readonly audience: readonly string[];
  readonly jti: string;
  /** POSIX ms. */
  readonly issuedAt: number;
  readonly expiresAt: number;
}

export function verifyJwtSvid(token: unknown, ctx: JwtSvidContext): Check<VerifiedJwtSvid, JwtSvidRule> {
  const signed = verifyGatewayJws(token, ctx.bundle.jwtKeys, { typ: 'JWT' }, JWT_SVID_JWS_RULES);
  if (!signed.ok) return signed;
  const claims = signed.value.payload;
  if (typeof claims.sub !== 'string') return refuse('jwt_svid.claims', 'the JWT-SVID needs a sub');
  const parsed = parseSpiffeId(claims.sub);
  if (parsed === null) return refuse('jwt_svid.subject', 'sub is not a SPIFFE ID of an agent: spiffe://<trust domain>/agent/<64 hex characters>');
  if (parsed.trustDomain !== ctx.trustDomain) return refuse('jwt_svid.trust_domain', `the SPIFFE ID is in the trust domain ${parsed.trustDomain}, and this gateway is ${ctx.trustDomain}`);
  const audience = typeof claims.aud === 'string' ? [claims.aud] : isStringList(claims.aud) && claims.aud.length > 0 ? claims.aud : null;
  if (audience === null || !audience.includes(ctx.audience)) return refuse('jwt_svid.audience', 'the audience of the JWT-SVID does not name this resource');
  if (!isNumber(claims.iat) || !isNumber(claims.exp)) return refuse('jwt_svid.claims', 'the JWT-SVID needs iat and exp');
  const maxLifetime = ctx.maxLifetimeSeconds ?? MAX_TOKEN_LIFETIME_S;
  if (claims.exp <= claims.iat || claims.exp - claims.iat > maxLifetime) return refuse('jwt_svid.lifetime', `the life of the JWT-SVID is not from 1 to ${maxLifetime} seconds`);
  const nowS = ctx.nowMs / 1000;
  if (claims.exp <= nowS - ctx.leewaySeconds) return refuse('jwt_svid.expired', 'the JWT-SVID has expired');
  if (claims.iat > nowS + ctx.leewaySeconds) return refuse('jwt_svid.not_yet_valid', 'the JWT-SVID is issued in the future');
  if (typeof claims.jti !== 'string' || claims.jti.length === 0) return refuse('jwt_svid.claims', 'the JWT-SVID needs a jti');
  return accept({ spiffeId: claims.sub, agentId: parsed.agentId, did: didOf(parsed.agentId), audience, jti: claims.jti, issuedAt: claims.iat * 1000, expiresAt: claims.exp * 1000 });
}
