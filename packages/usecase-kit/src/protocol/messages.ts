// packages/usecase-kit/src/protocol/messages.ts
// The messages of the protocol: the two requests of a buyer-side agent, the proposal that `propose` makes, and the two messages that a buyer-side agent sends to a counterparty.
//
//   propose  { op, authority, tenant, ...the fields of the use case }
//   execute  { op, authority, tenant, proposal: { document, salt, proposal_digest }, approval: { attestation, issuer_did } or null }
//
// The authority is the principal and the delegation. It has no vault: the agent finds the live vault of the delegation itself. The approval can be null in `execute`. The agent does not check
// the approval and passes it on, and the counterparty or the mock system refuses it when it is not right.
//
// A parser takes any value and never throws. It reads each member of an object one time, into a copy, and it works on that copy. It returns the members that it checked, as new objects: a document, a
// proposal and a request for quotation are copies, and a caller uses them and never the input. The document of a proposal, of a handoff and of a request for quotation holds each text in the NFC form,
// which is the form that the digest binds, so a service works on the bytes that its digest covers. A refusal has the code `bad_shape`. It names the field, and it never repeats a value. A request is
// refused when it has a member that the protocol does not name: `execute` takes no member of a use case, and `authority` takes no `vault`.
import { parseApprovalRef, type ApprovalRef } from './approval.ts';
import { HANDOFF_USE_CASES, type HandoffUseCase, type UseCase } from './codes.ts';
import { proposalDigest } from './digest.ts';
import {
  newSalt, parseDelegationId, parseDid, parseDigest, parseSalt, parseTenantId,
  type DelegationId, type Did, type Digest, type Salt, type TenantId,
} from './identifiers.ts';
import { parseCanonicalDocument, parseJsonValue, type Document } from './json.ts';
import { checkMembers, readMembers } from './members.ts';
import { defineMember, ownMember } from './own.ts';
import { accepted, refused, type ProtocolResult } from './result.ts';
import { shown } from './text.ts';

export const PROPOSAL_SCHEMA = 'vector.usecase.proposal.v1';
export const RESULT_SCHEMA = 'vector.usecase.result.v1';
export const HANDOFF_SCHEMA = 'vector.usecase.handoff.v1';
export const RFQ_SCHEMA = 'vector.usecase.rfq.v1';

/** The `schema` of the document that each use case proposes and executes: the purchase order, the prior-authorization request and the ranking. Names only: each use case defines the shape of its document. */
export const DOCUMENT_SCHEMAS = {
  'inventory-reorder': 'vector.usecase.po.v1',
  'prior-authorization': 'vector.usecase.priorauth-request.v1',
  'bid-evaluation': 'vector.usecase.ranking.v1',
} as const satisfies Record<UseCase, string>;
export type DocumentSchema = (typeof DOCUMENT_SCHEMAS)[UseCase];

/** Who the agent acts for, and by which delegation. The delegate of the delegation must be the agent that gets the request. */
export interface Authority {
  readonly principal_did: Did;
  readonly delegation: DelegationId;
}

/** What `propose` made: the document, the salt, and the digest of the two. The hirer approves the digest. */
export interface Proposal {
  readonly document: Document;
  readonly salt: Salt;
  readonly proposal_digest: Digest;
}

/** The members that both requests have. `tenant` names the tenant of the mock systems. */
export interface RequestBase {
  readonly authority: Authority;
  readonly tenant: TenantId;
}

/** A `propose` request: the shared members, and `F`, the fields of the use case. */
export type ProposeRequest<F extends object = Record<never, never>> = RequestBase & { readonly op: 'propose' } & F;

/** An `execute` request: it does exactly what the proposal says. The approval is a reference or null. */
export interface ExecuteRequest extends RequestBase {
  readonly op: 'execute';
  readonly proposal: Proposal;
  readonly approval: ApprovalRef | null;
}

export type UseCaseRequest<F extends object = Record<never, never>> = ProposeRequest<F> | ExecuteRequest;

/**
 * Reads the fields of a `propose` request that belong to one use case: every member of the request except `op`, `authority` and `tenant`. The members are plain JSON data: a copy that the walk of
 * parseJsonValue built. It returns the fields as a new object, or a refusal for a member that is missing, wrong or not allowed (`checkMembers` makes the last check). It must never throw.
 */
export type ProposeFieldsParser<F extends object> = (fields: Readonly<Record<string, unknown>>) => ProtocolResult<F>;

/**
 * The handoff that a buyer-side agent sends to a counterparty: the approved document, its salt and the approval reference. The counterparty checks the digest of the approval against this document and
 * this salt. Use case 3 has no handoff: a bid desk gets a request for quotation.
 */
export interface Handoff {
  readonly schema: typeof HANDOFF_SCHEMA;
  readonly use_case: HandoffUseCase;
  readonly sender_did: Did;
  readonly delegation: DelegationId;
  readonly document: Document;
  readonly salt: Salt;
  /** The approval reference that the hirer gave, or null. */
  readonly approval: ApprovalRef | null;
}

/** A request for quotation to a bid desk. It has no approval: the buyer approves the ranking, and not this request. */
export interface RfqMessage {
  readonly schema: typeof RFQ_SCHEMA;
  readonly sender_did: Did;
  readonly delegation: DelegationId;
  readonly rfq: Document;
}

export function parseAuthority(value: unknown, field = 'authority'): ProtocolResult<Authority> {
  const read = readMembers(value, field);
  if (!read.ok) return read;
  const members = checkMembers(read.value, field, ['principal_did', 'delegation']);
  if (members !== null) return members;
  const principal = parseDid(read.value.principal_did, `${field}.principal_did`);
  if (!principal.ok) return principal;
  const delegation = parseDelegationId(read.value.delegation, `${field}.delegation`);
  if (!delegation.ok) return delegation;
  return accepted({ principal_did: principal.value, delegation: delegation.value });
}

/** The proposal for a document: with the salt that is given, or with a new salt. The document of the result is the copy whose digest was made, so the digest is always the digest of that document and the salt. */
export function makeProposal(document: unknown, salt: unknown = newSalt()): ProtocolResult<Proposal> {
  const checkedSalt = parseSalt(salt, 'salt');
  if (!checkedSalt.ok) return checkedSalt;
  const checkedDocument = parseCanonicalDocument(document, 'document');
  if (!checkedDocument.ok) return checkedDocument;
  const digest = proposalDigest(checkedSalt.value, checkedDocument.value);
  if (!digest.ok) return digest;
  return accepted({ document: checkedDocument.value, salt: checkedSalt.value, proposal_digest: digest.value });
}

/** A proposal whose members are right and whose digest is the digest of its document and its salt. A digest that is another digest is `bad_shape`: the agent would send a document that the hirer did not approve. The document is a copy. */
export function parseProposal(value: unknown, field = 'proposal'): ProtocolResult<Proposal> {
  const read = readMembers(value, field);
  if (!read.ok) return read;
  const members = checkMembers(read.value, field, ['document', 'salt', 'proposal_digest']);
  if (members !== null) return members;
  const document = parseCanonicalDocument(read.value.document, `${field}.document`);
  if (!document.ok) return document;
  const salt = parseSalt(read.value.salt, `${field}.salt`);
  if (!salt.ok) return salt;
  const digest = parseDigest(read.value.proposal_digest, `${field}.proposal_digest`);
  if (!digest.ok) return digest;
  const computed = proposalDigest(salt.value, document.value);
  if (!computed.ok) return computed;
  if (computed.value !== digest.value) return refused('bad_shape', `${field}.proposal_digest is not the digest of ${field}.document and ${field}.salt`);
  return accepted({ document: document.value, salt: salt.value, proposal_digest: digest.value });
}

const BASE_MEMBERS: readonly string[] = ['op', 'authority', 'tenant'];
const EXECUTE_MEMBERS = ['op', 'authority', 'tenant', 'proposal', 'approval'] as const;
const NO_FIELDS: ProposeFieldsParser<Record<never, never>> = (fields) => checkMembers(fields, 'request', []) ?? accepted({});

/**
 * A request of a buyer-side agent: `propose` or `execute`. Any other operation, or none, is `bad_shape`.
 *
 * For `propose`, `parseFields` reads the members of the use case. With no parser, a `propose` request has no member beyond `op`, `authority` and `tenant`. The members of the use case are copies of plain
 * JSON data. The result keeps `op`, `authority` and `tenant` of the request, whatever the parser returns. For `execute`, the members are checked before their values, and `approval` must be there:
 * it is a reference or it is null. A member of the protocol is read as an own member only: a value that Object.prototype holds for `op`, `authority` or `tenant` is never read, so such a name is a
 * member that the request lacks.
 */
export function parseRequest(input: unknown): ProtocolResult<UseCaseRequest>;
export function parseRequest<F extends object>(input: unknown, parseFields: ProposeFieldsParser<F>): ProtocolResult<UseCaseRequest<F>>;
export function parseRequest(input: unknown, parseFields: ProposeFieldsParser<object> = NO_FIELDS): ProtocolResult<UseCaseRequest<object>> {
  const read = readMembers(input, 'request');
  if (!read.ok) return read;
  const members = read.value;
  const op = ownMember(members, 'op');
  if (op !== 'propose' && op !== 'execute') return refused('bad_shape', 'request.op must be "propose" or "execute"');
  if (op === 'execute') {
    const checked = checkMembers(members, 'request', EXECUTE_MEMBERS);
    if (checked !== null) return checked;
  }
  const authority = parseAuthority(ownMember(members, 'authority'), 'authority');
  if (!authority.ok) return authority;
  const tenant = parseTenantId(ownMember(members, 'tenant'), 'tenant');
  if (!tenant.ok) return tenant;
  if (op === 'execute') {
    const proposal = parseProposal(ownMember(members, 'proposal'), 'proposal');
    if (!proposal.ok) return proposal;
    const given = ownMember(members, 'approval');
    const approval = given === null ? accepted(null) : parseApprovalRef(given, 'approval');
    if (!approval.ok) return approval;
    const request: ExecuteRequest = { op: 'execute', authority: authority.value, tenant: tenant.value, proposal: proposal.value, approval: approval.value };
    return accepted(request);
  }
  // Each field of the use case is a copy of plain JSON data. defineMember makes each field an own member, so the key __proto__ stays a member and the field parser sees it.
  const fields: Record<string, unknown> = {};
  for (const [name, member] of Object.entries(members)) {
    if (BASE_MEMBERS.includes(name)) continue;
    const copied = parseJsonValue(member, `request.${shown(name)}`);
    if (!copied.ok) return copied;
    defineMember(fields, name, copied.value);
  }
  const parsed = parseFields(fields);
  if (!parsed.ok) return parsed;
  const request: ProposeRequest<object> = { ...parsed.value, op: 'propose', authority: authority.value, tenant: tenant.value };
  return accepted(request);
}

const HANDOFF_MEMBERS = ['schema', 'use_case', 'sender_did', 'delegation', 'document', 'salt', 'approval'] as const;
const RFQ_MEMBERS = ['schema', 'sender_did', 'delegation', 'rfq'] as const;

/** The handoff that a counterparty gets. The members are checked in form only: the approval is checked against the ledger by the check of the approval, and not here. The document is a copy. */
export function parseHandoff(input: unknown): ProtocolResult<Handoff> {
  const read = readMembers(input, 'handoff');
  if (!read.ok) return read;
  const members = read.value;
  const checked = checkMembers(members, 'handoff', HANDOFF_MEMBERS);
  if (checked !== null) return checked;
  if (members.schema !== HANDOFF_SCHEMA) return refused('bad_shape', `handoff.schema must be "${HANDOFF_SCHEMA}"`);
  const useCase = HANDOFF_USE_CASES.find((name) => name === members.use_case);
  if (useCase === undefined) return refused('bad_shape', `handoff.use_case must be one of ${HANDOFF_USE_CASES.join(', ')}`);
  const sender = parseDid(members.sender_did, 'handoff.sender_did');
  if (!sender.ok) return sender;
  const delegation = parseDelegationId(members.delegation, 'handoff.delegation');
  if (!delegation.ok) return delegation;
  const document = parseCanonicalDocument(members.document, 'handoff.document');
  if (!document.ok) return document;
  const salt = parseSalt(members.salt, 'handoff.salt');
  if (!salt.ok) return salt;
  const approval = members.approval === null ? accepted(null) : parseApprovalRef(members.approval, 'handoff.approval');
  if (!approval.ok) return approval;
  return accepted({
    schema: HANDOFF_SCHEMA, use_case: useCase, sender_did: sender.value, delegation: delegation.value, document: document.value, salt: salt.value, approval: approval.value,
  });
}

/** The request for quotation that a bid desk gets. The members are checked in form only. The `rfq` object is a copy. */
export function parseRfq(input: unknown): ProtocolResult<RfqMessage> {
  const read = readMembers(input, 'request');
  if (!read.ok) return read;
  const members = read.value;
  const checked = checkMembers(members, 'request', RFQ_MEMBERS);
  if (checked !== null) return checked;
  if (members.schema !== RFQ_SCHEMA) return refused('bad_shape', `request.schema must be "${RFQ_SCHEMA}"`);
  const sender = parseDid(members.sender_did, 'request.sender_did');
  if (!sender.ok) return sender;
  const delegation = parseDelegationId(members.delegation, 'request.delegation');
  if (!delegation.ok) return delegation;
  const rfq = parseCanonicalDocument(members.rfq, 'request.rfq');
  if (!rfq.ok) return rfq;
  return accepted({ schema: RFQ_SCHEMA, sender_did: sender.value, delegation: delegation.value, rfq: rfq.value });
}
