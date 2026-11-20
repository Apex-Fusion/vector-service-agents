// packages/usecase-kit/src/fault/setting.ts
// The setting FAULT_MODE, read one time when a service starts. The caller reads the environment and gives the value. This code reads no environment variable.
//
//   not set, or the empty text   no fault
//   a value of the kind          that fault
//   any other value              the start stops with an error that names the variable and the allowed values
//
// The value is fixed for the life of the process: the reader returns a frozen switch, and nothing in this folder reads the setting a second time.
import { FAULT_MODES, accepted, isAgentKind, isFaultSetting, refused } from '../protocol/index.ts';
import type { AgentKind, FaultSetting, ProtocolResult } from '../protocol/index.ts';

/** The name of the setting. */
export const FAULT_MODE_VARIABLE = 'FAULT_MODE';

declare const sealed: unique symbol;

/**
 * The fault setting of one process: the kind of agent and the value that was read at the start. Only `readFaultSwitch` makes one. The object is frozen, and this module marks it, so a function that
 * takes a switch accepts only a marked one. The type has a member that no other code can name, so an object that a caller writes by hand is not a switch at compile time either.
 */
export interface FaultSwitch<K extends AgentKind = AgentKind> {
  readonly [sealed]: true;
  readonly kind: K;
  /** The empty text in a clean run, and else the fault value of the kind. */
  readonly mode: FaultSetting<K>;
}

export type FaultSettingRefusal = 'bad_fault_mode' | 'bad_input';

/** The values that a kind allows, as a message says them. */
function allowedText(kind: AgentKind): string {
  const values = FAULT_MODES[kind];
  return values.length === 0 ? 'empty' : `empty or ${values.map((value) => JSON.stringify(value)).join(' or ')}`;
}

/**
 * What a message says about a value that it refuses. A text is shown when it is short and plain (at most 24 characters, with no run of 20 hex characters), and else by its length only, because a
 * secret can stand in the wrong line of a file. A value that is not a text is shown by its type. The rule is the rule of `shown` in the service kit; this folder does not import that package, so that
 * a run script can load it with Node type stripping.
 */
export function describeValue(value: unknown): string {
  if (typeof value === 'string') return value.length <= 24 && !/[0-9a-fA-F]{20}/.test(value) ? JSON.stringify(value) : `${value.length} characters`;
  return `a value of type ${value === null ? 'null' : typeof value}`;
}

/**
 * The setting for a kind, as a typed result. `undefined` and the empty text are no fault. A text that the kind lists is that fault. Every other value is refused, among them the fault value of
 * another kind, a text with a space around it, and a value that is not a text (a null, a number and a boolean are never "no fault").
 */
export function parseFaultSetting<K extends AgentKind>(kind: K, value: unknown): ProtocolResult<FaultSetting<K>, FaultSettingRefusal> {
  if (!isAgentKind(kind)) return refused('bad_input', `${FAULT_MODE_VARIABLE} was read for a kind of agent that does not exist`);
  if (value === undefined || value === '') return accepted('' as FaultSetting<K>);
  if (isFaultSetting(kind, value)) return accepted(value);
  const allowed = FAULT_MODES[kind].length === 0 ? `${allowedText(kind)} (${kind} has no fault value)` : allowedText(kind);
  return refused('bad_fault_mode', `environment variable ${FAULT_MODE_VARIABLE} must be ${allowed} for ${kind}, got ${describeValue(value)}`);
}

/** The switches that `readFaultSwitch` made. A hand-made object is not in it, also a frozen one with the right members: an object of another origin can have a getter that gives another value at the next read. */
const ISSUED = new WeakSet<object>();

/**
 * Reads the setting at the start of a service and returns the switch that the service keeps. A value that the kind does not list throws an error with the text of the refusal, so the start stops. The
 * error names the variable and the allowed values. It does not repeat a long value or a value that looks like a key.
 */
export function readFaultSwitch<K extends AgentKind>(kind: K, value: unknown): FaultSwitch<K> {
  const setting = parseFaultSetting(kind, value);
  if (!setting.ok) throw new Error(setting.detail);
  const fault = Object.freeze({ kind, mode: setting.value }) as unknown as FaultSwitch<K>;
  ISSUED.add(fault);
  return fault;
}

/** True only for a switch that `readFaultSwitch` made. A copy, an object that inherits from a switch, and an object that a caller wrote by hand are not switches. */
export function isFaultSwitch(value: unknown): value is FaultSwitch {
  return typeof value === 'object' && value !== null && ISSUED.has(value);
}
