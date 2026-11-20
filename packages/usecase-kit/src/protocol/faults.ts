// packages/usecase-kit/src/protocol/faults.ts
// The fault switch. A fault value makes one agent do one wrong thing on purpose, so that a failure run can show how the other agents and the checks answer. The switch is the setting
// `FAULT_MODE`: it is empty in a clean run. Each agent kind lists its values here. A kind with no value must run with the switch empty.
//
// The manifest of an agent names its values. The value that is active is in each result as `fault_mode`, and in the evidence file. It is never in the manifest, so the manifest bytes do not
// change when the switch changes.
import type { AgentKind } from './kinds.ts';

export const FAULT_MODES = {
  'reorder-agent': [],
  'prior-authorization-agent': ['alter_after_approval'],
  'sourcing-agent': ['invert_scores'],
  'order-desk': ['confirm_wrong_lot'],
  'insurer-intake-agent': [],
  'bid-desk': ['quote_off_price_list'],
} as const satisfies Record<AgentKind, readonly string[]>;

/** A fault value of one kind, or of any kind when no kind is given. A kind with no value has the type `never`. */
export type FaultMode<K extends AgentKind = AgentKind> = (typeof FAULT_MODES)[K][number];

/** The value of the setting `FAULT_MODE` and of `fault_mode` in a result: the empty text in a clean run, and else a fault value of the kind. */
export type FaultSetting<K extends AgentKind = AgentKind> = '' | FaultMode<K>;

/** True when the value is a setting of the kind: the empty text, or one of the fault values that the kind lists. Any other value is not a setting, and a service must not start with it. */
export function isFaultSetting<K extends AgentKind>(kind: K, value: unknown): value is FaultSetting<K> {
  if (value === '') return true;
  return typeof value === 'string' && Object.hasOwn(FAULT_MODES, kind) && (FAULT_MODES[kind] as readonly string[]).includes(value);
}
