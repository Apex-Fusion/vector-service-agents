// packages/usecase-kit/src/protocol/identifiers.ts
// The identifiers of the protocol, each with the form that it has on the wire and a parse function. A parse function takes any value and never throws. It returns the text as it is when
// the form is right, and a refusal when it is not. The refusal names the field and the form, and it never repeats the value. Every hex form is lower case: a text in upper case is a
// different text, so it is refused and not changed. A caller that needs no detail of a refusal uses the `is` function of a form (`isKeyHash`, `isScriptHash` and `isModelName`).
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
/** The hash of a key: BLAKE2b with 28 bytes of the public key, as 56 lower-case hex characters. The record of an agent, a delegation and a signer name a key by this hash. */
export type KeyHash = string;
/** The hash of a script: BLAKE2b with 28 bytes of the script, as 56 lower-case hex characters. The hash of the delegation script is the policy of the delegation tokens. */
export type ScriptHash = string;
/** The name of a model, as an advert writes it: letters, digits, dots, underscores, colons, slashes and hyphens. The colon is for a variant such as `qwen2.5:0.5b`. */
export type ModelName = string;

const HEX64 = /^[0-9a-f]{64}$/;
const DID = /^did:vector:[0-9a-f]{64}$/;
const DID_PREFIX = 'did:vector:';
// An output index has at most 10 digits and no leading zero, as in the context headers of service-kit.
const OUTPUT_REF = /^[0-9a-f]{64}#(?:0|[1-9][0-9]{0,9})$/;
// A tenant is a path segment of a mock URL and the start of a document number. It starts with a letter or a digit, so it is never "." or "..".
const TENANT_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
// A key hash and a script hash are two kinds of one form: a hash of 28 bytes.
const HASH28 = /^[0-9a-f]{56}$/;
const MODEL_NAME = /^[A-Za-z0-9._:/-]+$/;

const HEX_FORM = '64 lower-case hex characters';
const HASH28_FORM = '56 lower-case hex characters';

const matches = (value: unknown, pattern: RegExp): value is string => typeof value === 'string' && pattern.test(value);

function parseForm(value: unknown, pattern: RegExp, field: string, form: string): ProtocolResult<string> {
  return matches(value, pattern) ? accepted(value) : refused('bad_shape', `${field} must be ${form}`);
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
export const parseKeyHash = (value: unknown, field = 'key hash'): ProtocolResult<KeyHash> => parseForm(value, HASH28, field, HASH28_FORM);

export const isKeyHash = (value: unknown): value is KeyHash => matches(value, HASH28);
export const isScriptHash = (value: unknown): value is ScriptHash => matches(value, HASH28);
export const isModelName = (value: unknown): value is ModelName => matches(value, MODEL_NAME);

/** The id of an agent: the 64 hex characters of its DID. A delegation names its delegate and its parent by this id. The input has the form of a DID: a caller checks it with `parseDid` first. */
export const agentIdOf = (did: Did): string => did.substring(DID_PREFIX.length);
/** The DID of an agent, from its id of 64 lower-case hex characters. */
export const didOfAgentId = (id: string): Did => `${DID_PREFIX}${id}`;

/** A new salt: 32 random bytes from the system source, as 64 lower-case hex characters. */
export const newSalt = (): Salt => randomBytes(32).toString('hex');
