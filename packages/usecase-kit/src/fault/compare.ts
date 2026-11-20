// packages/usecase-kit/src/fault/compare.ts
// The one rule that compares the fault setting that a run expects with the setting that it finds. A script checks the environment of a service with it, and the evidence check reads a result with it.
import { describeValue } from './setting.ts';

/** The three ways in which a found setting can differ from the expected one. */
export type FaultCompareRefusal = 'fault_set' | 'fault_missing' | 'fault_differs';

/**
 * Compares two settings as text. The empty text means no fault. A setting that is the same text is a pass. A fault where none is expected is `fault_set`. No fault where one is expected is
 * `fault_missing`. Another fault than the expected one is `fault_differs`. The comparison is exact: a space around a value makes it another value.
 */
export function compareSettings(expected: string, found: string): FaultCompareRefusal | null {
  if (found === expected) return null;
  if (expected === '') return 'fault_set';
  return found === '' ? 'fault_missing' : 'fault_differs';
}

/** The sentence for a refusal of `compareSettings`. `who` names the service or the result. The values are shown short and plain, and never in full when they look like a key. */
export function compareDetail(code: FaultCompareRefusal, who: string, expected: string, found: string): string {
  if (code === 'fault_set') return `${who} has the fault value ${describeValue(found)}, and this run expects no fault`;
  if (code === 'fault_missing') return `${who} has no fault value, and this run expects ${describeValue(expected)}`;
  return `${who} has the fault value ${describeValue(found)}, and this run expects ${describeValue(expected)}`;
}
