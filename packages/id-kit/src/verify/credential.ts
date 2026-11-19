// packages/id-kit/src/verify/credential.ts
// The check of the identity credential of an agent (GET /agents/<identifier>/credential): a W3C Verifiable Credential 2.0 secured with JOSE (`application/vc+jwt`, VC-JOSE-COSE
// Section 3.1.1) that the gateway signed with ES256. The credential holds the facts of the ledger about the agent, and two status entries, one for each purpose of the Bitstring Status
// List of the gateway: revocation (position p) and suspension (position 131,072 + p) in the same list.
// `checkCredential` checks the credential alone: the signature, the issuer, the contexts and types, the time, the subject and the layout of the two entries. It does not read the list.
// A caller reads the list that the credential names and checks the two bits (see index.ts). A credential that anybody changed fails the check of its signature.

import { LIST_SIZE } from '../common/constants.ts';
import { vectorIdOf } from '../common/did.ts';
import { isRecord, isStringList } from '../common/json.ts';
import { accept, refuse, type Check } from '../common/result.ts';
import { parseZuluTime } from '../common/time.ts';
import { verifyGatewayJws, type KeySet } from './keys.ts';

export const CREDENTIAL_RULES = [
  'credential.malformed',
  'credential.alg',
  'credential.typ',
  'credential.kid',
  'credential.signature',
  'credential.context',
  'credential.type',
  'credential.issuer',
  'credential.not_yet_valid',
  'credential.expired',
  'credential.subject',
  'credential.status_entries',
] as const;
export type CredentialRule = (typeof CREDENTIAL_RULES)[number];

const CREDENTIAL_JWS_RULES = { malformed: 'credential.malformed', alg: 'credential.alg', typ: 'credential.typ', kid: 'credential.kid', signature: 'credential.signature' } as const;
const BITSTRING_LIST_PATH = /^\/status\/bsl\/(0|[1-9][0-9]{0,8})$/;
const DECIMAL_INDEX = /^(?:0|[1-9][0-9]{0,9})$/;

export interface CredentialContext {
  readonly keys: KeySet;
  /** The origin of the gateway. */
  readonly issuer: string;
  readonly nowMs: number;
  readonly leewaySeconds: number;
  /** The DID that the subject of the credential must be, or null for any agent. */
  readonly subject: string | null;
}

export interface VerifiedCredential {
  /** The DID of the agent: the subject of the credential. */
  readonly did: string;
  readonly agentId: string;
  /** The DID of the issuer: the gateway. */
  readonly issuer: string;
  /** POSIX ms. */
  readonly validFrom: number;
  readonly validUntil: number;
  /** When the ledger first minted the record, as the gateway wrote it, and where the record came from. */
  readonly created: string | null;
  readonly origin: string | null;
  /** The DID of the parent, for a subagent. */
  readonly parent: string | null;
  /** The Bitstring Status List that holds the two bits of the agent, and the position p: revocation is bit p and suspension is bit 131,072 + p. */
  readonly status: { readonly list: string; readonly position: number };
}

/** The two status entries of a credential of the gateway: revocation at p, suspension at 131,072 + p, in one list of the gateway. */
function readStatusEntries(entries: unknown, issuer: string): Check<{ list: string; position: number }, 'credential.status_entries'> {
  const bad = (detail: string) => refuse('credential.status_entries', detail);
  if (!Array.isArray(entries) || entries.length !== 2) return bad('credentialStatus is not a list of two entries');
  const read = (purpose: string): { list: string; index: number } | null => {
    const found = entries.filter((e) => isRecord(e) && e.statusPurpose === purpose);
    const entry = found[0];
    if (found.length !== 1 || !isRecord(entry) || entry.type !== 'BitstringStatusListEntry') return null;
    if (typeof entry.statusListIndex !== 'string' || !DECIMAL_INDEX.test(entry.statusListIndex) || typeof entry.statusListCredential !== 'string') return null;
    return { list: entry.statusListCredential, index: Number(entry.statusListIndex) };
  };
  const revocation = read('revocation');
  const suspension = read('suspension');
  if (revocation === null || suspension === null) return bad('credentialStatus has not exactly one BitstringStatusListEntry for revocation and one for suspension');
  if (revocation.list !== suspension.list) return bad('the two entries name two lists');
  let url: URL;
  try {
    url = new URL(revocation.list);
  } catch {
    return bad('the status list credential of an entry is not a URL');
  }
  if (url.origin !== issuer || !BITSTRING_LIST_PATH.test(url.pathname) || url.search !== '' || url.hash !== '' || url.username !== '' || url.password !== '' || `${url.origin}${url.pathname}` !== revocation.list) {
    return bad('the status list is not a Bitstring Status List of the gateway');
  }
  if (revocation.index >= LIST_SIZE || suspension.index !== LIST_SIZE + revocation.index) return bad('the revocation entry is not at a position p below 131,072, or the suspension entry is not at 131,072 + p');
  return accept({ list: revocation.list, position: revocation.index });
}

export function checkCredential(jwt: unknown, ctx: CredentialContext): Check<VerifiedCredential, CredentialRule> {
  const signed = verifyGatewayJws(jwt, ctx.keys, { typ: 'vc+jwt', cty: 'vc' }, CREDENTIAL_JWS_RULES);
  if (!signed.ok) return signed;
  const claims = signed.value.payload;
  const context = claims['@context'];
  if (!Array.isArray(context) || context[0] !== 'https://www.w3.org/ns/credentials/v2') return refuse('credential.context', 'the first context of the credential is not Verifiable Credentials 2.0');
  if (!isStringList(claims.type) || !claims.type.includes('VerifiableCredential') || !claims.type.includes('VectorAgentIdentityCredential')) return refuse('credential.type', 'the credential is not a VectorAgentIdentityCredential');
  // The issuer is the DID of the key that signed the credential: kid is the DID URL of that key (VC-JOSE-COSE Section 4.1.1).
  const keyDid = signed.value.key.kid.split('#')[0]!;
  if (vectorIdOf(keyDid) === null || claims.issuer !== keyDid) return refuse('credential.issuer', 'the issuer of the credential is not the DID of the key that signed it');
  const validFrom = parseZuluTime(claims.validFrom);
  const validUntil = parseZuluTime(claims.validUntil);
  if (validFrom === null || validUntil === null) return refuse('credential.malformed', 'validFrom and validUntil are times in the form YYYY-MM-DDThh:mm:ssZ');
  if (validFrom > ctx.nowMs + ctx.leewaySeconds * 1000) return refuse('credential.not_yet_valid', 'the credential is not valid yet');
  if (validUntil <= ctx.nowMs - ctx.leewaySeconds * 1000) return refuse('credential.expired', 'the credential is over: its time of validity has passed');
  const subject = claims.credentialSubject;
  const agentId = isRecord(subject) ? vectorIdOf(subject.id) : null;
  if (!isRecord(subject) || agentId === null) return refuse('credential.subject', 'the subject of the credential is not an agent DID of the form did:vector:<64 hex characters>');
  if (ctx.subject !== null && subject.id !== ctx.subject) return refuse('credential.subject', 'the credential is about another agent than the one that was asked for');
  const parent = subject.parent;
  if (parent !== undefined && vectorIdOf(parent) === null) return refuse('credential.subject', 'the parent of the subject is not an agent DID');
  const status = readStatusEntries(claims.credentialStatus, ctx.issuer);
  if (!status.ok) return status;
  return accept({
    did: `did:vector:${agentId}`,
    agentId,
    issuer: keyDid,
    validFrom,
    validUntil,
    created: typeof subject.created === 'string' ? subject.created : null,
    origin: typeof subject.origin === 'string' ? subject.origin : null,
    parent: typeof parent === 'string' ? parent : null,
    status: status.value,
  });
}
