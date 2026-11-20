// services/mock-systems/src/wiring.ts
// The one place where the real approval check is wired into the service. The check is `approvalCheckOf` of the use-case kit (`@vsa/usecase-kit/checks`). It works on the types of the protocol,
// and the service has its own types for the same input and the same answer (src/approval.ts). This file makes the ports of the check from what the service has (the ledger, the identity
// gateway and the clock), maps the input of the service to the input of the protocol, and maps the result of the protocol to the answer of the service.
//
// Nothing here decides. The answer is a pass only when the kit says `ok: true`. A refusal keeps its code and its sentence. A source that cannot be read is an exception of the kit
// (CheckUnavailableError), and it stays an exception: `decideApproval` turns each exception into 503 `approval_unavailable`. This file catches nothing.
import type { LedgerEnv } from '@vsa/buyer-core';
import type { GatewayClient } from '@vsa/id-kit';
import { approvalCheckOf, ledgerPortOf } from '@vsa/usecase-kit/checks';
import type { ApprovalInput as ProtocolInput, ApprovalResult, Document } from '@vsa/usecase-kit/protocol';
import type { ApprovalAnswer, ApprovalCheck, ApprovalInput } from './approval.ts';

/**
 * The budget of one ledger read of the approval check, in milliseconds. The check makes two reads, one after the other: the attestation, and then the delegation chain of the caller. Each read
 * opens a budget of its own (`withinBudget` of buyer-core), so the check can run for twice this time. The service waits APPROVAL_TIMEOUT_MS (30 s) for the check. A read of 12 s gives 24 s at
 * the most, which is inside the wait. So a ledger that answers too slowly ends the check by itself before the wait ends. The call is then 503 `approval_unavailable` with the rule `approval.failed`,
 * and not with the rule `approval.timeout` of the wait. The 20 s of LEDGER_BUDGET_MS (src/ledger.ts) are for the one read of the check of a token: two reads of 20 s would be 40 s, which is more
 * than the wait.
 */
export const APPROVAL_READ_BUDGET_MS = 12_000;

/** What the real check needs: the ledger that the service reads, the client of the identity gateway, and the clock. */
export interface ApprovalSources {
  /** The node, the indexer and the deployment. The check reads through a copy of it with its own budget (APPROVAL_READ_BUDGET_MS). */
  readonly ledger: LedgerEnv;
  /** The client of the identity gateway of the service. */
  readonly gateway: Pick<GatewayClient, 'resolve'>;
  /** The clock of the service, in POSIX milliseconds. */
  readonly now: () => number;
}

/** The input of the protocol for the input of the service: the same facts under the names of the protocol. */
function protocolInputOf(input: ApprovalInput): ProtocolInput {
  return {
    approval: { attestation: input.attestation, issuer_did: input.issuerDid },
    sender_did: input.sender,
    delegation: input.delegation,
    // The kit walks the document and refuses a value that JSON cannot hold (a TypeError, so 503). The service read the body as JSON.
    document: input.document as Document,
    salt: input.salt,
    now_ms: input.atMs,
  };
}

/** The answer of the service for the result of the protocol: a pass keeps nothing but the pass, and a refusal keeps its code and its sentence. */
function answerOf(result: ApprovalResult): ApprovalAnswer {
  if (result.ok === true) return { ok: true };
  return { ok: false, code: result.code, detail: result.detail };
}

export function wireApprovalCheck(sources: ApprovalSources): ApprovalCheck {
  const check = approvalCheckOf({
    clock: sources.now,
    gateway: sources.gateway,
    ledger: ledgerPortOf({ ...sources.ledger, budgetMs: APPROVAL_READ_BUDGET_MS }),
  });
  return async (input) => answerOf(await check(protocolInputOf(input)));
}
