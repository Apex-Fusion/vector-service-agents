import { PreconditionError } from '../../../checks/lib/session.ts';
import { inventory } from './inventory.ts';
import type { EvidenceModule } from './types.ts';

export const EVIDENCE_MODULES: Readonly<Record<string, EvidenceModule>> = {
  'inventory-reorder': inventory,
};

export function evidenceModuleOf(useCaseName: string, modules: Readonly<Record<string, EvidenceModule>> = EVIDENCE_MODULES): EvidenceModule {
  const module = Object.hasOwn(modules, useCaseName) ? modules[useCaseName] : undefined;
  if (module === undefined) throw new PreconditionError('use_case: no evidence module is registered for this use case');
  return module;
}

export type { ApprovalRead, Assembly, Challenge, CommittedApproval, CommittedExecute, EvidenceModule, EvidenceReadSession, HistoricalHoldCandidate, Hold, HoldSource, PublicResultProjection, Shown, TerminalSpend, VaultPayment } from './types.ts';
