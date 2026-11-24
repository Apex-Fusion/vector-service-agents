// agents/prior-authorization-agent/src/model/intake.ts
// The fields of a `propose` request of the Prior Authorization Agent (use case 2, prior authorization): the order to draft a request for, and the insurer to send it to. A request has these two members
// besides `op`, `authority` and `tenant`, and no other member. It has no `vault` member: the authority of the request is its principal and its delegation.
//
// The protocol hands the fields over as a copy of plain JSON data. The parser copies them again with `readMembers`, so that an accessor, a Proxy that throws and an object of another kind are refused
// before any member is read. Then it reads each member one time. It never throws. A detail names the field and the form, and it never repeats a value.
import { accepted, checkMembers, parseDid, readMembers, refused } from '@vsa/usecase-kit/protocol';
import type { Did, ProposeFieldsParser } from '@vsa/usecase-kit/protocol';

/** What a `propose` request asks for: the order whose records the agent reads, and the insurer whose intake agent takes the request. */
export interface ProposeFields {
  readonly order_id: string;
  readonly insurer_did: Did;
}

/** The form of an identifier of the records system and of the insurer portal: an order id and a request number have it. */
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** The rule of an identifier in words, for the detail of a refusal. */
export const ID_RULE = '1 to 64 characters: letters, digits, dot, hyphen and underscore, and it starts with a letter or a digit';

/** True for a text in the form of an identifier. The text is checked as it is written, so a letter that is not ASCII is refused. */
export const isId = (value: unknown): value is string => typeof value === 'string' && ID.test(value);

/** Reads the two fields of a `propose` request. It is the fields parser that `parseRequest` of the protocol takes. */
export const parseProposeFields: ProposeFieldsParser<ProposeFields> = (fields) => {
  const read = readMembers(fields, 'request');
  if (!read.ok) return read;
  const members = checkMembers(read.value, 'request', ['order_id', 'insurer_did']);
  if (members !== null) return members;
  const { order_id: orderId, insurer_did: insurerDid } = read.value;
  if (!isId(orderId)) return refused('bad_shape', `request.order_id must be ${ID_RULE}`);
  const insurer = parseDid(insurerDid, 'request.insurer_did');
  if (!insurer.ok) return insurer;
  return accepted({ order_id: orderId, insurer_did: insurer.value });
};
