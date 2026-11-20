// packages/usecase-kit/src/fault/stamp.ts
// The field `fault_mode` of a result. The service adds it to every result with ONE helper, so that job code cannot leave it out or write another value. The evidence writer reads it back with
// `readFaultMode`: a result that has no such field is never taken as a clean result.
import { accepted, isAgentKind, isFaultSetting, parseDocument, readMembers, refused } from '../protocol/index.ts';
import type { AgentKind, FaultSetting, ProtocolResult } from '../protocol/index.ts';
import { compareDetail, compareSettings } from './compare.ts';
import type { FaultCompareRefusal } from './compare.ts';
import { describeValue, isFaultSwitch } from './setting.ts';
import type { FaultSwitch } from './setting.ts';

/** A result with the member `fault_mode` of the switch. Each member of the result stays, except a `fault_mode` that the job wrote. */
export type WithFaultMode<R extends object, K extends AgentKind> = R extends unknown ? Omit<R, 'fault_mode'> & { readonly fault_mode: FaultSetting<K> } : never;

/**
 * The result with `fault_mode` set to the value of the switch, as a new object. The result of a job is JSON data, and it is copied with the JSON walk of the protocol: the walk reads each member
 * one time, and it refuses a function, an accessor, a member that is not enumerable and every other value that JSON cannot hold. So the copy has no `toJSON` or `then` that is a function or a
 * getter: nothing can change what `JSON.stringify` writes, and an `async` function cannot take the result for a promise. The copy gets `fault_mode` as its LAST own member. A value that the job wrote is dropped: the switch
 * decides, and job code cannot hide a fault that is on or show one that is off. A result that the walk refuses, and a switch that `readFaultSwitch` did not make, throw: an error never gives a
 * result without the field.
 */
export function withFaultMode<K extends AgentKind, R extends object>(fault: FaultSwitch<K>, result: R): WithFaultMode<R, K> {
  if (!isFaultSwitch(fault)) throw new TypeError('the fault switch is not a switch that readFaultSwitch made');
  const data = parseDocument(result, 'result');
  if (!data.ok) throw new TypeError(`a result must be JSON data, so that it can carry fault_mode: ${data.detail}`);
  const { fault_mode: _written, ...members } = data.value;
  return { ...members, fault_mode: fault.mode } as WithFaultMode<R, K>;
}

/**
 * A job that gives each of its results the field `fault_mode`. A service wraps its job one time, where it registers the job, and no return path of the job can skip the field. A job that throws gives
 * no result, so a failure has no result that lacks the field. A job that ends with a failed result gives that result with the field.
 */
export function withFaultModeJob<K extends AgentKind, A extends readonly unknown[], R extends object>(
  fault: FaultSwitch<K>,
  job: (...args: A) => R | Promise<R>,
): (...args: A) => Promise<WithFaultMode<R, K>> {
  if (!isFaultSwitch(fault)) throw new TypeError('the fault switch is not a switch that readFaultSwitch made');
  return async (...args: A) => withFaultMode(fault, await job(...args));
}

export type FaultStampRefusal = 'bad_input' | 'fault_mode_missing' | 'bad_fault_mode';

/**
 * The fault setting that a result names, for the evidence writer. The result is the JSON object that a service returned. A result with no `fault_mode` is refused as `fault_mode_missing`: it is never
 * read as "no fault". A value that the kind does not list is `bad_fault_mode`. The member is read one time, as data.
 */
export function readFaultMode<K extends AgentKind>(kind: K, result: unknown): ProtocolResult<FaultSetting<K>, FaultStampRefusal> {
  if (!isAgentKind(kind)) return refused('bad_input', 'fault_mode was read for a kind of agent that does not exist');
  const members = readMembers(result, 'result');
  if (!members.ok) return refused('bad_input', members.detail);
  if (!Object.hasOwn(members.value, 'fault_mode')) return refused('fault_mode_missing', 'result has no member "fault_mode": a service names the fault value in every result');
  const value = members.value.fault_mode;
  if (!isFaultSetting(kind, value)) return refused('bad_fault_mode', `result.fault_mode must be empty or a fault value of ${kind}, got ${describeValue(value)}`);
  return accepted(value);
}

/**
 * Reads the fault setting of a result and compares it with the setting that the run expects: the empty text for a clean run, and the fault value for the service of a fault run. The comparison is
 * exact. A fault in a clean run is `fault_set`.
 */
export function checkFaultMode<K extends AgentKind>(kind: K, expected: FaultSetting<K>, result: unknown): ProtocolResult<FaultSetting<K>, FaultStampRefusal | FaultCompareRefusal> {
  if (!isAgentKind(kind) || !isFaultSetting(kind, expected)) return refused('bad_input', 'the expected fault setting is not a setting of the kind of agent');
  const found = readFaultMode(kind, result);
  if (!found.ok) return found;
  const code = compareSettings(expected, found.value);
  return code === null ? found : refused(code, compareDetail(code, 'result', expected, found.value));
}
