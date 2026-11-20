// services/mock-systems/src/ledger.ts
// The ledger as the service reads it: the node and the indexer of Vector, and the identity registry deployment. The service only reads. It signs nothing, holds no key and submits no
// transaction. The provider of buyer-core wants the address of the submit endpoint when it is made, and no code of this service calls it.
import { OgmiosProvider, VECTOR_SUBMIT_URL, checkDelegationUse } from '@vsa/buyer-core';
import type { LedgerEnv } from '@vsa/buyer-core';
import type { ServiceConfig } from './config.ts';
import type { LedgerPort } from './identity.ts';

/** The most time that one check of a delegation may take: every read of one check runs inside this budget. A check that does not end in it is a refusal (the ledger could not be read). */
export const LEDGER_BUDGET_MS = 20_000;

export function createLedgerEnv(config: Pick<ServiceConfig, 'ogmiosUrl' | 'koiosUrl' | 'deployment'>, fetchImpl: typeof fetch): LedgerEnv {
  const provider = new OgmiosProvider({ ogmiosUrl: config.ogmiosUrl, submitUrl: VECTOR_SUBMIT_URL, koiosUrl: config.koiosUrl });
  return { provider, deployment: config.deployment, koiosUrl: config.koiosUrl, fetchImpl, budgetMs: LEDGER_BUDGET_MS };
}

/** The check of a delegation on the ledger (`checkDelegationUse` of buyer-core) for a ledger environment. It reads the chain of the delegation, and each delegate and the root delegator. */
export const ledgerPort = (env: LedgerEnv): LedgerPort => (params) => checkDelegationUse(env, params);
