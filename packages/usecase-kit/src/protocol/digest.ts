// packages/usecase-kit/src/protocol/digest.ts
// The canonical form of a document and the digest of a proposal.
//
// The canonical form is the one that `canonicalize` of the buyer code writes: keys sorted by UTF-16 code units, every string value in the NFC form, no white space, and numbers as
// JSON.stringify writes them. A key is in the NFC form already, because parseJsonValue refuses any other key. This file holds its own copy of the rule, so that the protocol loads no chain
// library. A test holds the copy to the buyer code. The two give the same text on every document that parseJsonValue takes, and the cases where they differ are the cases that it refuses.
//
// The digest of a proposal is SHA-256(salt bytes ++ UTF-8 of the canonical document). The salt is the 32 bytes that its 64 hex characters stand for. The salt comes first.
import { createHash } from 'node:crypto';
import { parseSalt, type Digest } from './identifiers.ts';
import { parseDocument, parseJsonValue, type JsonValue } from './json.ts';
import { accepted, type ProtocolResult } from './result.ts';

const isList = (value: JsonValue): value is readonly JsonValue[] => Array.isArray(value);

/** The canonical text of a value that parseJsonValue has taken: at most MAX_DOCUMENT_DEPTH levels, so the recursion is short. */
function write(value: JsonValue): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return JSON.stringify(value);
  if (typeof value === 'string') return JSON.stringify(value.normalize('NFC'));
  if (isList(value)) return `[${value.map((member) => write(member)).join(',')}]`;
  // Array.prototype.sort with no function orders strings by UTF-16 code unit, which is the order of the canonical form.
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${write(value[key])}`).join(',')}}`;
}

/** The canonical text of a JSON value, or a refusal when the value is not one that the canonical form can write without loss (see parseJsonValue). */
export function canonicalJson(value: unknown, field = 'value'): ProtocolResult<string> {
  const checked = parseJsonValue(value, field);
  return checked.ok ? accepted(write(checked.value)) : checked;
}

/** The SHA-256 of the canonical text of a JSON value, with no salt: the form of a `*_sha256` member that names a canonical object. 64 lower-case hex characters. */
export function canonicalSha256(value: unknown, field = 'value'): ProtocolResult<Digest> {
  const text = canonicalJson(value, field);
  return text.ok ? accepted(createHash('sha256').update(text.value, 'utf8').digest('hex')) : text;
}

/** The digest of a proposal: SHA-256(salt bytes ++ UTF-8 of the canonical document). A refusal names `salt` or `document`. */
export function proposalDigest(salt: unknown, document: unknown): ProtocolResult<Digest> {
  const checkedSalt = parseSalt(salt, 'salt');
  if (!checkedSalt.ok) return checkedSalt;
  const checkedDocument = parseDocument(document, 'document');
  if (!checkedDocument.ok) return checkedDocument;
  return accepted(createHash('sha256').update(Buffer.from(checkedSalt.value, 'hex')).update(write(checkedDocument.value), 'utf8').digest('hex'));
}
