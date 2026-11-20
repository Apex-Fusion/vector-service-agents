// packages/usecase-kit/src/checks/ports.ts
// The ports of the checks. Every read of the chain, every call to the identity gateway and every read of the clock goes through them, so that a test gives fixtures and fakes.
// The code of the checks reads no key file and no environment variable.
//
// A read that fails is never a pass. A port may throw, or the gateway may refuse the call: the check then ends with the code `check_unavailable`, and never with the code of a rule.
import { HIRE_ACTION, checkAttestation, checkDelegationUse, escrowPaidFromVault, escrowResource, readDelegation } from '@vsa/buyer-core';
import type { AttestationCheck, DelegationUseCheck, DelegationView, EscrowVaultResult, LedgerEnv } from '@vsa/buyer-core';
import type { GatewayClient } from '@vsa/id-kit/client';
import type { AttestationId, DelegationId, OutputRef } from '../protocol/index.ts';

/** The reads of the ledger that the checks need. Each one can throw: that is a read that failed. */
export interface LedgerPort {
  /** The delegation and its parents up to the root. The chain is empty when the delegation is not live. */
  readDelegation(id: DelegationId): Promise<DelegationView>;
  /** Can the delegation be used at the time `atMs` to hire a supplier, that is, to pay an escrow from a vault? It asks for no confirmations. */
  delegationUse(id: DelegationId, atMs: number): Promise<DelegationUseCheck>;
  /** The attestation, and each condition of the validity rule at the time `atMs`. The attestation is null when no authentic output holds it. */
  attestation(id: AttestationId, atMs: number): Promise<AttestationCheck>;
  /** Was the escrow paid from a vault of the delegation? */
  escrowPaid(escrowRef: OutputRef, delegation: DelegationId): Promise<EscrowVaultResult>;
}

export interface ChecksPorts {
  /** The time now, in milliseconds since 1970: a whole number. A run reads it once. */
  readonly clock: () => number;
  /** The identity gateway. The checks use the DID resolution of its client. */
  readonly gateway: Pick<GatewayClient, 'resolve'>;
  readonly ledger: LedgerPort;
  /**
   * Called with the source and the cause of a read that failed, or of a hook that failed. The check does not show the cause to the buyer: the message of a failed read can name a
   * host. The service decides what it writes to its log. A hook that throws changes nothing.
   */
  readonly onFault?: (source: string, cause: unknown) => void;
}

/**
 * The ledger port on a `LedgerEnv` (the node, the deployment and Koios). The use of a delegation is the use of a vault payment: the hire action on the escrow script of the deployment.
 * Each read ends inside the budget of the env, and the runtime waits only 10 seconds for a pre-check, so a caller gives an env with a short `budgetMs`.
 */
export function ledgerPortOf(env: LedgerEnv): LedgerPort {
  const resource = escrowResource(env.deployment.escrow.hash);
  return {
    readDelegation: (id) => readDelegation(env, id),
    delegationUse: (id, atMs) => checkDelegationUse(env, { id, action: HIRE_ACTION, resource, atMs }),
    attestation: (id, atMs) => checkAttestation(env, { id, atMs }),
    escrowPaid: (escrowRef, delegation) => escrowPaidFromVault(env, escrowRef, delegation),
  };
}

/** A source that could not be read, or that gave an answer that is not for the check. A check that reads through a port throws it; a list of checks turns it into `check_unavailable`. */
export class CheckUnavailableError extends Error {
  readonly code = 'check_unavailable' as const;
  constructor(readonly source: string) {
    super(`the ${source} could not be read`);
    this.name = 'CheckUnavailableError';
  }
}

/** Tells the service about a fault. A hook that throws changes nothing. */
export function reportFault(ports: ChecksPorts, source: string, cause: unknown): void {
  try { ports.onFault?.(source, cause); } catch { /* a hook that fails must not change the answer of a check */ }
}

/** One read through a port. A read that throws is a read that failed: the service is told, and the check ends with CheckUnavailableError. */
export async function readThrough<T>(ports: ChecksPorts, source: string, read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (cause) {
    reportFault(ports, source, cause);
    throw new CheckUnavailableError(source);
  }
}

/** An answer that is not for the check that asked (another id, another time, a part that is missing). It is a source that did not answer: never a pass, and never the code of a rule. */
export function badAnswer(ports: ChecksPorts, source: string, why: string): never {
  reportFault(ports, source, new TypeError(`the answer of the ${source} is not usable: ${why}`));
  throw new CheckUnavailableError(source);
}

/** The time of a run: one whole number of milliseconds. A clock that gives anything else is a fault of the service, and it is never read as a time. */
export function nowOf(ports: ChecksPorts): number {
  const now = ports.clock();
  if (!Number.isSafeInteger(now) || now < 0) throw new TypeError('the clock must give a whole number of milliseconds since 1970');
  return now;
}
