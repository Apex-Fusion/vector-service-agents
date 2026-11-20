// packages/usecase-kit/src/buyer/message.ts
// The message that a buyer-side agent sends to a counterparty, and the two size checks that come before the Pay.
//
// The handoff has the approved document, its salt and the approval reference, exactly as the hirer gave them. The approval can be null: the agent does not check it. It passes the reference on,
// and the counterparty or the mock system refuses a reference that is not right. The request for quotation of use case 3 (supplier bid evaluation) has no approval.
//
// The two limits. A service takes at most `MAX_REQUEST_BYTES` of wire payload: the wire payload is the request text written as a string inside a one-message JSON array, and it is the exact text that the
// hire kit sends. The runtime in front of the service takes at most `RUNTIME_BODY_LIMIT_BYTES` of body. The hire kit sends the message to the runtime as `{ escrow_ref, payload }`, where `payload` is the wire
// payload, so the body is longer than the wire payload: each quote mark and each backslash is escaped two times. The kit builds the wire payload and the body after the Pay, so a message that is too large
// would lock the payment until the reclaim. This file builds the same wire payload and the same body before the Pay, so that the flow can refuse in time.
import { canonicalize, wirePayloadFor } from '@vsa/vector-read';
import { HANDOFF_SCHEMA, RFQ_SCHEMA, RUNTIME_BODY_LIMIT_BYTES, accepted, checkRequestSize, parseHandoff, parseProposal, parseRfq, refused } from '@vsa/usecase-kit/protocol';
import type { Did, ExecuteRequest, Handoff, HandoffUseCase, ProtocolResult, RfqMessage } from '@vsa/usecase-kit/protocol';

/** What a buyer-side agent sends to a counterparty: a handoff (use case 1 and use case 2), or a request for quotation (use case 3). */
export type CounterpartyMessage = Handoff | RfqMessage;

/** The facts that a handoff needs besides the request. */
export interface HandoffSource {
  /** The use case with a handoff. Use case 3 (supplier bid evaluation) has none. */
  readonly use_case: HandoffUseCase;
  /** The DID of this agent. It is the sender of the handoff. */
  readonly agent_did: Did;
  /** The `execute` request as `parseRequest` gave it. */
  readonly request: ExecuteRequest;
}

/**
 * The handoff for an `execute` request. The document, the salt and the approval are those of the request: the proposal is checked again, so a digest that is not the digest of its document
 * and its salt is refused (`bad_shape`) and nothing is sent. The result is a new object that the protocol parser checked.
 */
export function handoffOf(source: HandoffSource): ProtocolResult<Handoff> {
  const { use_case: useCase, agent_did: agent, request } = source;
  const proposal = parseProposal(request.proposal, 'proposal');
  if (!proposal.ok) return proposal;
  return parseHandoff({
    schema: HANDOFF_SCHEMA, use_case: useCase, sender_did: agent, delegation: request.authority.delegation, document: proposal.value.document, salt: proposal.value.salt, approval: request.approval,
  });
}

/** The message as a checked copy: a handoff or a request for quotation, by its `schema`. Any other message is refused. */
export function messageOf(message: unknown): ProtocolResult<CounterpartyMessage> {
  const schema: unknown = typeof message === 'object' && message !== null ? Reflect.get(message, 'schema') : undefined;
  if (schema === HANDOFF_SCHEMA) return parseHandoff(message);
  if (schema === RFQ_SCHEMA) return parseRfq(message);
  return refused('bad_shape', `message.schema must be "${HANDOFF_SCHEMA}" or "${RFQ_SCHEMA}"`);
}

/** The request text of a message: canonical JSON, the text that the counterparty reads as the content of its wire message. The escrow commits to the hash of its wire payload. */
export function requestText(message: CounterpartyMessage): string {
  return canonicalize(message);
}

/** An escrow reference as the vault Pay makes it: 64 hex characters, a hash sign and output 0. Any escrow reference of a vault Pay has this length, so the body has its exact size. */
export const BODY_ESCROW_REF = `${'0'.repeat(64)}#0`;

/** The body of the call to the runtime of the counterparty, as the hire kit builds it for the request text and an escrow at output 0. */
export function runtimeBody(text: string): string {
  return JSON.stringify({ escrow_ref: BODY_ESCROW_REF, payload: wirePayloadFor(text) });
}

/** The size of the body in bytes of UTF-8, or `request_too_large` when it is above the limit of the runtime. A body at the limit passes. */
export function checkRuntimeBody(text: string): ProtocolResult<number, 'request_too_large'> {
  const bytes = Buffer.byteLength(runtimeBody(text), 'utf8');
  return bytes <= RUNTIME_BODY_LIMIT_BYTES
    ? accepted(bytes)
    : refused('request_too_large', `the call to the counterparty has ${bytes} bytes, and the runtime takes at most ${RUNTIME_BODY_LIMIT_BYTES} bytes`);
}

/**
 * The size of the wire payload of the text in bytes of UTF-8, or the refusal of `checkRequestSize` when it is above `MAX_REQUEST_BYTES`. The payload is the one that is sent, as the canonical form writes it,
 * and not the request that the agent got: the canonical form can make a text longer (it writes each text in the NFC form), so a request under the limit can give a payload above it.
 */
export function checkWirePayload(text: string): ProtocolResult<number, 'request_too_large' | 'bad_shape'> {
  return checkRequestSize(wirePayloadFor(text));
}
