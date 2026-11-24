// agents/insurer-intake-agent/src/checks/extra.ts
// The three checks of the Insurer Intake Agent that follow the 12 shared checks of the use-case kit (the sender, the delegation, the payment from a vault and the approval). They run in the order of the page
// of the Insurer Intake Agent, and the first refusal is the answer:
//
//   13  for_this_insurer  the request names this agent as its insurer                              not_for_this_insurer
//   14  advert            the request names the advert that the escrow was posted on               advert_mismatch
//   15  not_duplicate     the intake book holds no entry for the request number of the tenant       duplicate_request
//
// The advert comes from the job context of the runtime, which read it from the escrow on the ledger: the advert that the escrow was posted on. A member of the body never chooses it. The body names an advert
// too (a sender says what it wants to pay), and the check compares the body with the context. The context wins.
//
// A check answers a refusal of a rule as data: `{ ok: false, code, detail }` with a fixed sentence that names no value of the request. A source that cannot be read is another thing: the intake book that
// rejects, and the intake book that answers with something that is not true or false, are `CheckUnavailableError`, and the run turns it into `check_unavailable` (503). Only `false` is a pass. The handoff is for
// use case 2 (prior authorization), and its document is an authorization request, after the parser of the service. A handoff for another use case, and a document that is not an authorization request, are
// faults of the service: the check throws a TypeError, and a throw is never a go.
import { CheckUnavailableError } from '@vsa/usecase-kit/checks';
import type { ExtraCheck } from '@vsa/usecase-kit/checks';
import { parsePriorAuthRequest } from '@vsa/usecase-kit/priorauth';
import type { PriorAuthRequest } from '@vsa/usecase-kit/priorauth';
import { accepted, isPlainObject, parseDid, refused } from '@vsa/usecase-kit/protocol';
import type { Did, Handoff } from '@vsa/usecase-kit/protocol';
import type { BookReader } from './ports.ts';

export interface IntakeChecksDeps {
  readonly book: BookReader;
  /** The DID of this agent: the insurer that an authorization request must name. */
  readonly self: Did;
  /**
   * Called with the source and the cause of a read of the book that failed. The cause is for the log of the service and never for the sender: the message of a failed read can name a path.
   * A function that throws changes nothing.
   */
  readonly onFault?: (source: string, cause: unknown) => void;
}

/**
 * The authorization request of a handoff. A handoff for another use case is a fault of the service, also when it carries a request that passes every check: the page of the Insurer Intake Agent has no code for
 * it, and the parser of the service refuses it before the hook. So is a document that is not an authorization request. The message names the member and never repeats the value.
 */
function requestOf(handoff: Handoff): PriorAuthRequest {
  if (handoff.use_case !== 'prior-authorization') throw new TypeError('the handoff is not for use case 2 (prior authorization)');
  const parsed = parsePriorAuthRequest(handoff.document, 'handoff.document');
  if (!parsed.ok) throw new TypeError(`the document of the handoff is not an authorization request: ${parsed.detail}`);
  return parsed.value;
}

/**
 * The checks 13 to 15, in the order of the page. It throws a TypeError for input of the wrong form: an insurer that is no DID, a book that cannot answer, and a hook for faults that is not a function.
 */
export function intakeChecks(deps: IntakeChecksDeps): readonly ExtraCheck<Handoff>[] {
  if (!isPlainObject(deps)) throw new TypeError('the checks of the Insurer Intake Agent need the intake book and the DID of the agent');
  const parsedSelf = parseDid(deps.self, 'self');
  if (!parsedSelf.ok) throw new TypeError(`the DID of the agent is wrong: ${parsedSelf.detail}`);
  const self = parsedSelf.value;
  const { book, onFault } = deps;
  if (typeof book !== 'object' || book === null || typeof book.has !== 'function') throw new TypeError('the intake book must have the function has');
  if (onFault !== undefined && typeof onFault !== 'function') throw new TypeError('onFault must be a function');
  const report = (cause: unknown): void => {
    try {
      onFault?.('intake book', cause);
    } catch {
      // A hook that fails must not change the answer of a check.
    }
  };

  return [
    {
      names: ['for_this_insurer'],
      run: async (request) => (requestOf(request).insurer_did === self ? accepted({}) : refused('not_for_this_insurer', 'the request is for another insurer')),
    },
    {
      names: ['advert'],
      run: async (request, context) =>
        requestOf(request).advert_ref === context.advertRef ? accepted({}) : refused('advert_mismatch', 'the request is not for the advert that the escrow was posted on'),
    },
    {
      names: ['not_duplicate'],
      run: async (request) => {
        const { tenant, request_number: requestNumber } = requestOf(request);
        let known: unknown;
        try {
          known = await book.has(tenant, requestNumber);
        } catch (cause) {
          report(cause);
          throw new CheckUnavailableError('intake book');
        }
        if (known === false) return accepted({});
        if (known === true) return refused('duplicate_request', 'the intake book holds an entry for this request number');
        report(new TypeError('the intake book answered with a value that is not true or false'));
        throw new CheckUnavailableError('intake book');
      },
    },
  ];
}
