// agents/bid-desk/src/checks/precheck.ts
// The `precheck` option of the Bid Desk: the hook that the runtime asks before it claims an escrow (SERVICE_PRECHECK_URL). A refusal leaves the escrow Open, so nothing is claimed and nothing is paid.
// It is `precheckOf` of the use-case kit for the kind `bid-desk`: the shared checks (the sender, the delegation and the payment from a vault), then the check of the Bid Desk (extra.ts), in the order of its page.
//
//   every check passed   { go: true }. The record of the checks goes to PassedChecks, with the SHA-256 of the request that was checked. The job takes the record by the escrow reference of its context.
//   a refusal            { go: false, status, error: <code>, message }. The status is the status of the code in ERROR_STATUS: 403 for the code of a rule, 503 for `check_unavailable`.
//   a fault              the answer is a rejection, and the server answers 500 and never a go. A record that cannot be put is a fault too.
//
// The Bid Desk takes no approval and files no challenge, so the hook has no hook for a refusal and no dispute code.
//
// The reads. The hook makes HOOK_READS timed reads, one after the other: the identity gateway one time, for the DID of the SENDER, and the ledger three times, for the delegation, for its use and for the payment from
// a vault. The hook never reads the record of the Bid Desk itself. The buyer key is the key of the job context, which the runtime read from the escrow, and never a member of the body. The Bid Desk keeps working
// while its own record changes, because nothing in the hook reads that record.
import type { JobContext, PrecheckAnswer } from '@vsa/service-kit';
import { precheckOf } from '@vsa/usecase-kit/checks';
import type { ChecksPorts } from '@vsa/usecase-kit/checks';
import { canonicalSha256, isPlainObject } from '@vsa/usecase-kit/protocol';
import type { RfqMessage } from '@vsa/usecase-kit/protocol';
import type { RfqBook } from './book.ts';
import { rfqChecks } from './extra.ts';
import type { PassedChecks } from './passed.ts';

/**
 * The timed reads of one call of the hook that passes every check: the gateway one time, and the ledger for the delegation, for its use and for the payment from a vault. The reads of the rfq book are local to the
 * service and are not counted. The runtime waits 10 seconds for the whole hook, so a service gives each timed read a budget such that HOOK_READS reads end well inside that time.
 */
export const HOOK_READS = 4;

export interface PrecheckDeps {
  /** The clock, the identity gateway and the ledger of the checks. Each read of a port ends inside the time budget that the caller gave it: the runtime waits 10 seconds for the whole hook. */
  readonly ports: ChecksPorts;
  readonly book: RfqBook;
  /** Where the record of the checks that passed goes. The job takes it from the same store. */
  readonly passed: Pick<PassedChecks, 'put'>;
  /** The time that the record of the checks that passed counts from: a whole number of milliseconds since 1970, read when the hook puts the record. */
  readonly clock: () => number;
  /**
   * One line for each source that failed: the name of the source and the kind of the cause, and never the message of the cause or a part of a request. A function that throws changes nothing. The ports get the
   * cause itself through their `onFault`.
   */
  readonly log: (line: string) => void;
}

/**
 * The `precheck` option of the service kit for the Bid Desk. It throws a TypeError for input of the wrong form, before any request. The hook gives a go only when the 7 checks passed.
 */
export function createPrecheck(deps: PrecheckDeps): (request: RfqMessage, context: JobContext) => Promise<PrecheckAnswer> {
  if (!isPlainObject(deps)) throw new TypeError('the hook of the Bid Desk needs its ports, rfq book, store of passed checks, clock and log');
  const { ports, book, passed, clock, log } = deps;
  if (!isPlainObject(ports) || typeof ports.clock !== 'function') throw new TypeError('the ports of the hook must have a clock');
  const { gateway, ledger } = ports;
  if (typeof gateway !== 'object' || gateway === null || typeof gateway.resolve !== 'function') throw new TypeError('the ports of the hook must have a gateway with the function resolve');
  if (typeof ledger !== 'object' || ledger === null || typeof ledger.readDelegation !== 'function' || typeof ledger.delegationUse !== 'function' || typeof ledger.escrowPaid !== 'function') {
    throw new TypeError('the ports of the hook must have a ledger with the functions readDelegation, delegationUse and escrowPaid');
  }
  if (ports.onFault !== undefined && typeof ports.onFault !== 'function') throw new TypeError('ports.onFault must be a function when it is given');
  if (typeof passed !== 'object' || passed === null || typeof passed.put !== 'function') throw new TypeError('the store of passed checks must have the function put');
  if (typeof clock !== 'function' || typeof log !== 'function') throw new TypeError('clock and log must be functions');
  const say = (line: string): void => {
    try {
      log(line);
    } catch {
      // A log that fails must not change the answer of the hook.
    }
  };
  // A source that fails is written to the log with the kind of its cause, and then given to the ports with the cause itself. A hook of the ports that throws is caught by the callers.
  const report = (source: string, cause: unknown): void => {
    say(`bid desk: the ${source} failed (${cause instanceof Error ? cause.name : typeof cause})`);
    ports.onFault?.(source, cause);
  };

  return precheckOf({
    kind: 'bid-desk',
    ports: { ...ports, onFault: report },
    extra: rfqChecks({ book, onFault: report }),
    onPass: (record, request, context) => {
      const hash = canonicalSha256(request);
      if (!hash.ok) throw new TypeError(`the request cannot be hashed: ${hash.detail}`);
      passed.put(context.escrowRef, { record, request_sha256: hash.value }, clock());
    },
  });
}
