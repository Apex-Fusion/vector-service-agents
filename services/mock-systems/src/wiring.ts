// services/mock-systems/src/wiring.ts
// The one place where the real approval check is wired into the service. The approval check is a dependency of the app (src/approval.ts): the real function is written in the
// use-case kit, and it takes the ledger that the service reads. While that function is not on `main`, this gives no check, and the production start refuses (src/start.ts): the
// service never runs with a fake check, and never with a check that always passes.
//
// When the real check is on `main`: import it here, give it the ledger environment, and return it. Then change the test of the shipped wiring (test/wiring.test.ts) to the test of that
// function. Nothing else in the service changes.
import type { LedgerEnv } from '@vsa/buyer-core';
import type { ApprovalCheck } from './approval.ts';

export function wireApprovalCheck(_ledger: LedgerEnv): ApprovalCheck | null {
  return null;
}
