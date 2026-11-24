// agents/sourcing-agent/src/model/intake.ts
// The fields of a `propose` request of the Sourcing Agent (use case 3, supplier bid evaluation): the request for quotation and the four weights of the ranking. A request has these two members besides `op`,
// `authority` and `tenant`, and no other member.
//
// The protocol hands the fields over as a copy of plain JSON data. The parser copies them again with `readMembers`, so that an accessor, a Proxy that throws and an object of another kind are refused before
// any member is read. Then it reads each member one time and gives it to the parser of the kit. It never throws. A detail names the field and the form, and it never repeats a value.
import { parseRfqDocument, parseWeights } from '@vsa/usecase-kit/bids';
import type { RfqDocument, Weights } from '@vsa/usecase-kit/bids';
import { accepted, checkMembers, readMembers } from '@vsa/usecase-kit/protocol';
import type { ProposeFieldsParser } from '@vsa/usecase-kit/protocol';

/** What a `propose` request asks for: the request for quotation that goes to the bidders, and the weights that the scorers and the ranking read. The weights are not sent to the bidders. */
export interface ProposeFields {
  readonly rfq: RfqDocument;
  readonly weights: Weights;
}

/** Reads the two fields of a `propose` request. It is the fields parser that `parseRequest` of the protocol takes. */
export const parseProposeFields: ProposeFieldsParser<ProposeFields> = (fields) => {
  const read = readMembers(fields, 'request');
  if (!read.ok) return read;
  const members = checkMembers(read.value, 'request', ['rfq', 'weights']);
  if (members !== null) return members;
  const rfq = parseRfqDocument(read.value.rfq, 'request.rfq');
  if (!rfq.ok) return rfq;
  const weights = parseWeights(read.value.weights, 'request.weights');
  if (!weights.ok) return weights;
  return accepted({ rfq: rfq.value, weights: weights.value });
};
