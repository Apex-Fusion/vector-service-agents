import { PreconditionError } from '../../../checks/lib/session.ts';
import { bidTrial } from './bids.ts';
import { inventoryTrial } from './inventory.ts';
import { priorAuthTrial } from './priorauth.ts';
import type { TrialBuilder } from './shared.ts';

const TRIALS: Readonly<Record<string, TrialBuilder>> = {
  'inventory-reorder': inventoryTrial,
  'prior-authorization': priorAuthTrial,
  'bid-evaluation': bidTrial,
};

/** Select a trial for the use case already selected by the operator. */
export function trialOf(name: string): TrialBuilder {
  const build = Object.hasOwn(TRIALS, name) ? TRIALS[name] : undefined;
  if (build === undefined) throw new PreconditionError('this use case has no claim trial');
  return build;
}
