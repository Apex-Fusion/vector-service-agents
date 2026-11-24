// agents/bid-desk/src/checks/extra.ts
// The check of the Bid Desk that follows the shared checks of the use-case kit (the sender, the delegation and the payment from a vault). It runs after them, in the order of the page of the Bid Desk, and a
// refusal is the answer:
//
//   not_duplicate  the book holds no answer to this request for quotation from this sender    duplicate_rfq
//
// The Bid Desk takes no approval: in use case 3 (supplier bid evaluation) the buyer approves the ranking, and not the request for quotation. So the shared checks of this kind end after the payment from a
// vault, and this is the only check of the kind.
//
// The key of the book is the DID of the sender and the identifier of the request, each as it was written: the identifier is not folded to lower case. The sender comes from the request that the service parsed.
// Nothing in the job context chooses the key.
//
// A check answers a refusal of a rule as data: `{ ok: false, code, detail }` with a fixed sentence that names no value of the request. A source that cannot be read is another thing: the book that rejects,
// and the book that answers with something that is not true or false, are `CheckUnavailableError`, and the run turns it into `check_unavailable` (503). Only `false` is a pass. The request is a request for
// quotation, after the parser of the service. A request that is not one is a fault of the service: the check throws a TypeError, and a throw is never a go.
import { parseRfqDocument } from '@vsa/usecase-kit/bids';
import type { RfqDocument } from '@vsa/usecase-kit/bids';
import { CheckUnavailableError } from '@vsa/usecase-kit/checks';
import type { ExtraCheck } from '@vsa/usecase-kit/checks';
import { RFQ_SCHEMA, accepted, isPlainObject, parseDid, refused } from '@vsa/usecase-kit/protocol';
import type { Did, RfqMessage } from '@vsa/usecase-kit/protocol';
import type { RfqBook } from './book.ts';

export interface RfqChecksDeps {
  readonly book: RfqBook;
  /**
   * Called with the source and the cause of a read of the book that failed. The cause is for the log of the service and never for the buyer: the message of a failed read can name a path.
   * A function that throws changes nothing.
   */
  readonly onFault?: (source: string, cause: unknown) => void;
}

/**
 * The sender and the request for quotation of a message. A message of another schema, a sender that is no DID, and an `rfq` that is not a request for quotation are faults of the service: the parser of
 * the service refuses each of them before the hook. The message names the member and never repeats the value.
 */
function requestOf(request: RfqMessage): { readonly sender: Did; readonly rfq: RfqDocument } {
  if (!isPlainObject(request) || request.schema !== RFQ_SCHEMA) throw new TypeError('the request is not a request for quotation of use case 3 (supplier bid evaluation)');
  const sender = parseDid(request.sender_did, 'request.sender_did');
  if (!sender.ok) throw new TypeError(`the sender of the request is wrong: ${sender.detail}`);
  const rfq = parseRfqDocument(request.rfq, 'request.rfq');
  if (!rfq.ok) throw new TypeError(`the rfq of the request is not a request for quotation: ${rfq.detail}`);
  return { sender: sender.value, rfq: rfq.value };
}

/**
 * The checks of the Bid Desk after the shared checks, in the order of the page. It throws a TypeError for input of the wrong form: a book that cannot answer, and a hook for faults that is not a function.
 */
export function rfqChecks(deps: RfqChecksDeps): readonly ExtraCheck<RfqMessage>[] {
  if (!isPlainObject(deps)) throw new TypeError('the checks of the Bid Desk need the rfq book');
  const { book, onFault } = deps;
  if (typeof book !== 'object' || book === null || typeof book.has !== 'function') throw new TypeError('the rfq book must have the function has');
  if (onFault !== undefined && typeof onFault !== 'function') throw new TypeError('onFault must be a function');
  const report = (cause: unknown): void => {
    try {
      onFault?.('rfq book', cause);
    } catch {
      // A hook that fails must not change the answer of a check.
    }
  };

  return [
    {
      names: ['not_duplicate'],
      run: async (request) => {
        const { sender, rfq } = requestOf(request);
        let known: unknown;
        try {
          known = await book.has(sender, rfq.rfq_id);
        } catch (cause) {
          report(cause);
          throw new CheckUnavailableError('rfq book');
        }
        if (known === false) return accepted({});
        if (known === true) return refused('duplicate_rfq', 'the rfq book holds an answer to this request for quotation from this sender');
        report(new TypeError('the rfq book answered with a value that is not true or false'));
        throw new CheckUnavailableError('rfq book');
      },
    },
  ];
}
