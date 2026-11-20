// packages/usecase-kit/src/protocol/identifiers.ts
// The identifiers of the protocol, each with the form that it has on the wire and a parse function. A parse function takes any value and never throws. It returns the text as it is when
// the form is right, and a refusal when it is not. The refusal names the field and the form, and it never repeats the value. Every hex form is lower case: a text in upper case is a
// different text, so it is refused and not changed.
import { randomBytes } from 'node:crypto';
import { accepted, refused, type ProtocolResult } from './result.ts';

/** The DID of an agent: `did:vector:` and 64 lower-case hex characters. */
export type Did = string;
/** The name of a delegation token: 64 lower-case hex characters. */
export type DelegationId = string;
/** The name of an attestation token: 64 lower-case hex characters. */
export type AttestationId = string;
/** A salt: 32 random bytes as 64 lower-case hex characters. */
export type Salt = string;
/** A SHA-256 hash, as in a `*_sha256` or `*_digest` member: 64 lower-case hex characters. */
export type Digest = string;
/** An output of a transaction: the hash of the transaction (64 lower-case hex characters), a hash sign and the index of the output. An `escrow_ref`, an `advert_ref` and a vault output have this form. */
export type OutputRef = string;
/** The name of a tenant of the mock systems: 1 to 64 characters that are safe in a path segment. */
export type TenantId = string;

const HEX64 = /^[0-9a-f]{64}$/;
const DID = /^did:vector:[0-9a-f]{64}$/;
// An output index has at most 10 digits and no leading zero, as in the context headers of service-kit.
const OUTPUT_REF = /^[0-9a-f]{64}#(?:0|[1-9][0-9]{0,9})$/;
// A tenant is a path segment of a mock URL and the start of a document number. It starts with a letter or a digit, so it is never "." or "..".
const TENANT_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

const HEX_FORM = '64 lower-case hex characters';

function parseForm(value: unknown, pattern: RegExp, field: string, form: string): ProtocolResult<string> {
  return typeof value === 'string' && pattern.test(value) ? accepted(value) : refused('bad_shape', `${field} must be ${form}`);
}

export const parseDid = (value: unknown, field = 'did'): ProtocolResult<Did> => parseForm(value, DID, field, `"did:vector:" and ${HEX_FORM}`);
export const parseDelegationId = (value: unknown, field = 'delegation'): ProtocolResult<DelegationId> => parseForm(value, HEX64, field, HEX_FORM);
export const parseAttestationId = (value: unknown, field = 'attestation'): ProtocolResult<AttestationId> => parseForm(value, HEX64, field, HEX_FORM);
export const parseSalt = (value: unknown, field = 'salt'): ProtocolResult<Salt> => parseForm(value, HEX64, field, HEX_FORM);
export const parseDigest = (value: unknown, field = 'digest'): ProtocolResult<Digest> => parseForm(value, HEX64, field, HEX_FORM);
export const parseOutputRef = (value: unknown, field = 'ref'): ProtocolResult<OutputRef> =>
  parseForm(value, OUTPUT_REF, field, `a transaction hash of ${HEX_FORM}, a hash sign and an output index with no leading zero`);
export const parseTenantId = (value: unknown, field = 'tenant'): ProtocolResult<TenantId> =>
  parseForm(value, TENANT_ID, field, '1 to 64 characters (letters, digits, hyphen, underscore and dot) that start with a letter or a digit');

/** A new salt: 32 random bytes from the system source, as 64 lower-case hex characters. */
export const newSalt = (): Salt => randomBytes(32).toString('hex');
