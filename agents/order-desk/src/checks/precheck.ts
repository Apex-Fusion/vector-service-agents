// agents/order-desk/src/checks/precheck.ts
// The `precheck` option of the Order Desk: the hook that the runtime asks before it claims an escrow (SERVICE_PRECHECK_URL). A refusal leaves the escrow Open, so nothing is claimed and nothing is paid.
// It is `precheckOf` of the use-case kit: the shared checks (the sender, the delegation, the payment from a vault and the approval), then the four checks of the Order Desk (extra.ts), in the order of its page.
//
//   every check passed   { go: true }. The record of the checks goes to PassedChecks, with the SHA-256 of the request that was checked. The job takes the record by the escrow reference of its context.
//   a refusal            { go: false, status, error: <code>, message }. The status is the status of the code in ERROR_STATUS: 403 for the code of a rule, 503 for `check_unavailable`.
//   a fault              the answer is a rejection, and the server answers 500 and never a go. A record that cannot be put is a fault too.
//
// The challenge. A refusal for `approval_digest_mismatch` means that the sender sent a purchase order that its hirer did not approve, and that breaks the first statement of the claim of the Reorder Agent. The Order
// Desk then challenges the open claim of the sender, with the two digests as evidence. The runtime waits 10 seconds for the hook, and a challenge takes two transactions, so the hook answers first. `onRefused`
// only gives a task to `schedule` and returns. It never waits for the task, and the answer never holds a reference of the challenge: the reference goes to the log and to the journal of the dispute. The task
// catches every error. It logs the code and the references of the result, and never the detail of a refusal or the message of an error: a detail can name a host or hold a part of a request.
import { precheckOf } from '@vsa/usecase-kit/checks';
import type { ChecksPorts } from '@vsa/usecase-kit/checks';
import type { ApprovalChallengeInput, ChallengeResult, Dispute } from '@vsa/usecase-kit/dispute';
import { INVENTORY_CAPABILITIES, REORDER_CLAIM } from '@vsa/usecase-kit/inventory';
import type { LotsFile } from '@vsa/usecase-kit/inventory';
import { canonicalSha256, isPlainObject } from '@vsa/usecase-kit/protocol';
import type { ApprovalDigestMismatch, Did, Handoff } from '@vsa/usecase-kit/protocol';
import type { JobContext, PrecheckAnswer } from '@vsa/service-kit';
import type { OrderBook } from './book.ts';
import { orderChecks } from './extra.ts';
import type { PassedChecks } from './passed.ts';

export interface PrecheckDeps {
  /** The clock, the identity gateway and the ledger of the checks. Each read of a port ends inside the time budget that the caller gave it: the runtime waits 10 seconds for the whole hook. */
  readonly ports: ChecksPorts;
  /** The lots file that the Order Desk serves. */
  readonly lots: LotsFile;
  readonly book: OrderBook;
  /** The DID of this agent: the supplier that a purchase order must name. */
  readonly self: Did;
  /** Where the record of the checks that passed goes. The job takes it from the same store. */
  readonly passed: Pick<PassedChecks, 'put'>;
  /** The Module-1 path of this agent. The hook uses `challengeApproval` only. */
  readonly dispute: Pick<Dispute, 'challengeApproval'>;
  /**
   * Starts a task in the background and returns at once: the hook never waits for it. The task catches its own errors, so it never rejects. The service gives `(task) => { setImmediate(() => { void task(); }); }`.
   * The task then starts after the server wrote the answer. `queueMicrotask` is wrong for this: its task starts before the server writes the answer, and a part of the challenge that does not wait holds the answer
   * back. A test gives a function that keeps the task and runs it by hand.
   */
  readonly schedule: (task: () => Promise<void>) => void;
  /** One line for each step of a challenge, with references of the chain and codes. A line has no key and no part of a request. A function that throws changes nothing. */
  readonly log: (line: string) => void;
}

/** The kind of a thrown value, for the log: the name of an error, and the type of anything else. The message of an error is never logged. */
const kindOf = (error: unknown): string => (error instanceof Error ? error.name : typeof error);

/** The log line for the result of a challenge: the code and the references of the chain that the result names, and nothing of its detail. */
function describeResult(escrow: string, result: ChallengeResult): string {
  if (result.ok) {
    const { record } = result.value;
    return `order desk: challenge filed for the escrow ${escrow}: claim ${record.claim}, evidence ${record.evidence}, challenge ${record.challenge}`;
  }
  const landed = [
    result.evidence === null ? null : `evidence ${result.evidence.tx_hash}`,
    result.sent === null ? null : `sent ${result.sent.tx_hash}`,
    result.challenge === null ? null : `challenge ${result.challenge.challenge}`,
    result.wrong_document === null ? null : `wrong document ${result.wrong_document.tx_hash}`,
  ].filter((part): part is string => part !== null);
  return `order desk: challenge not filed for the escrow ${escrow}: ${result.code}${landed.length === 0 ? '' : ` (${landed.join(', ')})`}`;
}

/**
 * The `precheck` option of the service kit for the Order Desk. It throws a TypeError for input of the wrong form, before any request.
 * `ports.onFault` gets the cause of each read that failed, the order book included. The hook gives a go only when the 16 checks passed.
 */
export function createPrecheck(deps: PrecheckDeps): (request: Handoff, context: JobContext) => Promise<PrecheckAnswer> {
  if (!isPlainObject(deps)) throw new TypeError('the hook of the Order Desk needs its ports, lots, book, DID, store of passed checks, dispute, schedule and log');
  const { ports, passed, dispute, schedule, log } = deps;
  if (!isPlainObject(ports) || typeof ports.clock !== 'function') throw new TypeError('the ports of the hook must have a clock');
  if (typeof passed !== 'object' || passed === null || typeof passed.put !== 'function') throw new TypeError('the store of passed checks must have the function put');
  if (typeof dispute !== 'object' || dispute === null || typeof dispute.challengeApproval !== 'function') throw new TypeError('the dispute must have the function challengeApproval');
  if (typeof schedule !== 'function' || typeof log !== 'function') throw new TypeError('schedule and log must be functions');
  const say = (line: string): void => {
    try {
      log(line);
    } catch {
      // A log that fails must not change the answer of the hook or stop the task.
    }
  };
  const extra = orderChecks({ lots: deps.lots, book: deps.book, self: deps.self, onFault: (source, cause) => { ports.onFault?.(source, cause); } });

  return precheckOf({
    kind: 'order-desk',
    ports,
    extra,
    onPass: (record, request, context) => {
      const hash = canonicalSha256(request);
      if (!hash.ok) throw new TypeError(`the request cannot be hashed: ${hash.detail}`);
      passed.put(context.escrowRef, { record, request_sha256: hash.value }, ports.clock());
    },
    onRefused: (refusal, request, context) => {
      if (refusal.code !== 'approval_digest_mismatch') return;
      const { digests } = refusal;
      const { approval } = request;
      if (digests === null || approval === null) {
        say(`order desk: no challenge for the escrow ${context.escrowRef}: the refusal has no digests or the request has no approval`);
        return;
      }
      // The full result of the approval check, as the evidence builder of the dispute reads it: never the bare pair of digests.
      const mismatch: ApprovalDigestMismatch = {
        ok: false, code: refusal.code, detail: refusal.detail, expected_digest: digests.expected_digest, observed_digest: digests.observed_digest,
      };
      const input: ApprovalChallengeInput = {
        sender: request.sender_did,
        escrow_ref: context.escrowRef,
        capability_id: INVENTORY_CAPABILITIES.order,
        claim_capability_id: INVENTORY_CAPABILITIES.reorder,
        statement_text: REORDER_CLAIM.statements[0].text,
        buyer_pkhs: [context.buyerPkh],
        evidence: { kind: 'approval_digest', use_case: 'inventory-reorder', approval, mismatch },
      };
      // The task starts after the answer, and nothing waits for it. It catches every error and logs the kind of it.
      schedule(async () => {
        try {
          say(describeResult(context.escrowRef, await dispute.challengeApproval(input)));
        } catch (error) {
          say(`order desk: the challenge for the escrow ${context.escrowRef} stopped with an error (${kindOf(error)})`);
        }
      });
    },
  });
}
