// packages/id-kit/src/verify/status-list.ts
// The two status list formats of the gateway, read and checked. The lists answer one question for each agent: is its entry revoked, or suspended? An agent has a position p in a list.
// - Bitstring Status List (W3C, `application/vc+jwt`): one list holds both purposes. Its bitstring has 2 x 131,072 bits. Bit p is the revocation bit, and bit 131,072 + p is the
//   suspension bit. Bit 0 is the most significant bit of byte 0. The list is GZIP, then base64url with the prefix `u` (multibase).
// - Token Status List (IETF, `application/statuslist+jwt`): `bits` bits for each entry (the gateway writes 2), packed from the least significant bit of each byte. 0 is valid, 1 is
//   invalid (revoked) and 2 is suspended. The list is ZLIB, then base64url.
// Both are signed by the gateway (ES256) and last one hour. A decode checks the signature, the issuer, that the list is the one that was asked for, the time, and the encoding.
// A list whose time is over gives the rule `list.expired`: a caller reads it as an old list, which is not a refusal of a call (see `reader.ts`).

import { gunzipSync, inflateSync } from 'node:zlib';
import { LIST_SIZE } from '../common/constants.ts';
import { isNumber, isRecord, isStringList } from '../common/json.ts';
import { accept, refuse, type Check } from '../common/result.ts';
import { parseZuluTime } from '../common/time.ts';
import { JoseError, fromB64url } from '../vendored/m4/jose.ts';
import { verifyGatewayJws, type KeySet } from './keys.ts';

export const STATUS_LIST_RULES = ['list.malformed', 'list.alg', 'list.typ', 'list.kid', 'list.signature', 'list.issuer', 'list.subject', 'list.time', 'list.expired', 'list.encoding', 'list.index', 'list.value'] as const;
export type StatusListRule = (typeof STATUS_LIST_RULES)[number];

const LIST_JWS_RULES = { malformed: 'list.malformed', alg: 'list.alg', typ: 'list.typ', kid: 'list.kid', signature: 'list.signature' } as const;

/** The most bytes that a list may inflate to. The lists of the gateway are 32 KiB; the limit stops a small input that inflates to a huge one. */
const MAX_INFLATED_BYTES = 1_048_576;
/** A Bitstring Status List holds at least 131,072 bits (W3C Bitstring Status List, Section 2.2). */
const MIN_BITSTRING_BYTES = 16_384;

export interface ListContext {
  readonly keys: KeySet;
  /** The origin of the gateway: the issuer of a Token Status List. */
  readonly issuer: string;
  /** The URL that the list was fetched from: the `sub` of a Token Status List and the `id` of a Bitstring Status List must be this URL. */
  readonly url: string;
  readonly nowMs: number;
  readonly leewaySeconds: number;
}

export interface TokenStatusList {
  readonly url: string;
  /** POSIX ms. */
  readonly issuedAt: number;
  readonly expiresAt: number;
  /** How long the list may be cached before a fresh copy is fetched, in seconds, or null when the list gives none. */
  readonly ttlSeconds: number | null;
  readonly bitsPerEntry: number;
  /** The number of entries. */
  readonly size: number;
  /** The value of entry `index`. Throws a RangeError for an index that the list does not have. */
  value(index: number): number;
}

export interface BitstringStatusList {
  readonly url: string;
  /** POSIX ms. */
  readonly validFrom: number;
  readonly validUntil: number;
  readonly purposes: readonly string[];
  readonly ttlMs: number | null;
  /** The number of bits. */
  readonly size: number;
  /** Bit `index`, where bit 0 is the most significant bit of byte 0. Throws a RangeError for an index that the list does not have. */
  bit(index: number): boolean;
}

function inflated(compressed: Buffer, kind: 'gzip' | 'zlib'): Buffer | null {
  try {
    return kind === 'gzip' ? gunzipSync(compressed, { maxOutputLength: MAX_INFLATED_BYTES }) : inflateSync(compressed, { maxOutputLength: MAX_INFLATED_BYTES });
  } catch {
    return null;
  }
}

/** The bytes of base64url text, or null when the text is not canonical base64url (no padding, the alphabet of RFC 4648 Section 5). */
function base64url(text: string): Buffer | null {
  try {
    return fromB64url(text, 'the list');
  } catch (e) {
    if (e instanceof JoseError) return null;
    throw e;
  }
}

/** The time rules that both formats share: a list from the future is refused, and a list that is over is an old list. Times in POSIX ms. */
function checkTimes(from: number, until: number, ctx: ListContext): Check<null, 'list.time' | 'list.expired'> {
  if (from > ctx.nowMs + ctx.leewaySeconds * 1000) return refuse('list.time', 'the list starts in the future');
  if (until <= ctx.nowMs - ctx.leewaySeconds * 1000) return refuse('list.expired', 'the list is over: its time of validity has passed');
  return accept(null);
}

export function decodeTokenStatusList(jwt: unknown, ctx: ListContext): Check<TokenStatusList, StatusListRule> {
  const signed = verifyGatewayJws(jwt, ctx.keys, { typ: 'statuslist+jwt' }, LIST_JWS_RULES);
  if (!signed.ok) return signed;
  const claims = signed.value.payload;
  if (claims.iss !== ctx.issuer) return refuse('list.issuer', 'the issuer of the list is not the gateway');
  if (claims.sub !== ctx.url) return refuse('list.subject', 'the list is not the one that was asked for: its sub is another URL');
  if (!isNumber(claims.iat) || !isNumber(claims.exp)) return refuse('list.malformed', 'the list needs iat and exp');
  const times = checkTimes(claims.iat * 1000, claims.exp * 1000, ctx);
  if (!times.ok) return times;
  const body = claims.status_list;
  if (!isRecord(body) || typeof body.lst !== 'string') return refuse('list.malformed', 'the list has no status_list with an lst');
  const bits = body.bits;
  if (bits !== 1 && bits !== 2 && bits !== 4 && bits !== 8) return refuse('list.encoding', 'bits is 1, 2, 4 or 8');
  const compressed = base64url(body.lst);
  const bytes = compressed === null ? null : inflated(compressed, 'zlib');
  if (bytes === null || bytes.length === 0) return refuse('list.encoding', 'lst is not base64url of ZLIB data, or it inflates to more than 1 MiB');
  const size = (bytes.length * 8) / bits;
  return accept({
    url: ctx.url,
    issuedAt: claims.iat * 1000,
    expiresAt: claims.exp * 1000,
    ttlSeconds: isNumber(claims.ttl) && claims.ttl > 0 ? claims.ttl : null,
    bitsPerEntry: bits,
    size,
    value(index) {
      if (!Number.isInteger(index) || index < 0 || index >= size) throw new RangeError('the list has no such entry');
      const offset = index * bits;
      return (bytes[offset >> 3]! >> (offset & 7)) & ((1 << bits) - 1);
    },
  });
}

export function decodeBitstringStatusList(jwt: unknown, ctx: ListContext): Check<BitstringStatusList, StatusListRule> {
  const signed = verifyGatewayJws(jwt, ctx.keys, { typ: 'vc+jwt', cty: 'vc' }, LIST_JWS_RULES);
  if (!signed.ok) return signed;
  const claims = signed.value.payload;
  const context = claims['@context'];
  if (!Array.isArray(context) || context[0] !== 'https://www.w3.org/ns/credentials/v2') return refuse('list.malformed', 'the first context of the credential is not Verifiable Credentials 2.0');
  if (!isStringList(claims.type) || !claims.type.includes('VerifiableCredential') || !claims.type.includes('BitstringStatusListCredential')) return refuse('list.malformed', 'the credential is not a BitstringStatusListCredential');
  if (claims.id !== ctx.url) return refuse('list.subject', 'the list is not the one that was asked for: its id is another URL');
  // The issuer is the DID of the key that signed the list: kid is the DID URL of that key.
  const keyDid = signed.value.key.kid.split('#')[0];
  if (claims.issuer !== keyDid) return refuse('list.issuer', 'the issuer of the list is not the DID of the key that signed it');
  const validFrom = parseZuluTime(claims.validFrom);
  const validUntil = parseZuluTime(claims.validUntil);
  if (validFrom === null || validUntil === null) return refuse('list.malformed', 'validFrom and validUntil are times in the form YYYY-MM-DDThh:mm:ssZ');
  const times = checkTimes(validFrom, validUntil, ctx);
  if (!times.ok) return times;
  const subject = claims.credentialSubject;
  if (!isRecord(subject) || subject.type !== 'BitstringStatusList') return refuse('list.malformed', 'the subject of the credential is not a BitstringStatusList');
  const purposes = typeof subject.statusPurpose === 'string' ? [subject.statusPurpose] : subject.statusPurpose;
  if (!isStringList(purposes) || purposes.length === 0) return refuse('list.malformed', 'statusPurpose is a purpose or a list of purposes');
  const encoded = subject.encodedList;
  if (typeof encoded !== 'string' || !encoded.startsWith('u')) return refuse('list.encoding', 'encodedList is base64url with the multibase prefix u');
  const compressed = base64url(encoded.substring(1));
  const bytes = compressed === null ? null : inflated(compressed, 'gzip');
  if (bytes === null || bytes.length < MIN_BITSTRING_BYTES) return refuse('list.encoding', 'encodedList is not GZIP data of at least 131,072 bits, or it inflates to more than 1 MiB');
  const size = bytes.length * 8;
  return accept({
    url: ctx.url,
    validFrom,
    validUntil,
    purposes,
    ttlMs: isNumber(subject.ttl) && subject.ttl > 0 ? subject.ttl : null,
    size,
    bit(index) {
      if (!Number.isInteger(index) || index < 0 || index >= size) throw new RangeError('the list has no such bit');
      return (bytes[index >> 3]! & (0x80 >> (index & 7))) !== 0;
    },
  });
}

/** What an entry of a status list says about an agent. */
export type EntryStatus = 'valid' | 'revoked' | 'suspended';

/** The status of position `index` in a Token Status List. A value that the gateway never writes is the rule `list.value`; a position that the list does not have is `list.index`. */
export function tokenEntryStatus(list: TokenStatusList, index: number): Check<EntryStatus, 'list.index' | 'list.value'> {
  if (!Number.isInteger(index) || index < 0 || index >= list.size) return refuse('list.index', `the list has no entry ${index}`);
  const value = list.value(index);
  if (value === 0) return accept('valid');
  if (value === 1) return accept('revoked');
  if (value === 2) return accept('suspended');
  return refuse('list.value', `entry ${index} holds the value ${value}, which the gateway never writes`);
}

/**
 * The status of an agent at position `p` in a Bitstring Status List with both purposes in one list: bit p is revocation and bit 131,072 + p is suspension. The list must name both
 * purposes. A position outside the first block of 131,072, or a list too short for the suspension bit, is the rule `list.index`. Revocation wins when both bits are set.
 */
export function bitstringEntryStatus(list: BitstringStatusList, position: number): Check<EntryStatus, 'list.index' | 'list.malformed'> {
  if (!list.purposes.includes('revocation') || !list.purposes.includes('suspension')) return refuse('list.malformed', 'the list does not name both purposes: revocation and suspension');
  if (!Number.isInteger(position) || position < 0 || position >= LIST_SIZE || LIST_SIZE + position >= list.size) return refuse('list.index', `the list has no position ${position}`);
  if (list.bit(position)) return accept('revoked');
  return accept(list.bit(LIST_SIZE + position) ? 'suspended' : 'valid');
}
