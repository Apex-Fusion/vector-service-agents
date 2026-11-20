// packages/usecase-kit/src/fault/guard.ts
// The guards of a run script. A clean run must have no fault value in any service that the script can see. A fault run names the one fault that it expects, and it must find that fault in that service
// and no fault anywhere else. A guard checks the environments that the script gives it. It reads no file and no process, so the script keeps the access and a test can use fixtures.
//
// A guard never passes by default:
//   - a list with no service is refused, because a guard that checks nothing must not pass;
//   - an environment that is not a record of variables is refused (`bad_input`): a Buffer of an environ file, a Map, a text and a class instance hold variables in a form that a guard does not read;
//   - an environment that is a Proxy is refused (`bad_input`): its prototype, its `in` and its reads are answered by traps, so a guard cannot know what a reader of the same object sees;
//   - an environment that the script could not read is refused (`service_unreadable`): a null, a getter, a value that comes from `Object.prototype`, and a read that throws;
//   - a value that is not a text is refused, and it is never read as "no fault".
//
// A guard reads the environments at ONE time. A service that starts again with another value after that read is not seen. So a run script calls the guard before the run and again after it, and the
// evidence of a run records the value that the guard read for each service. The field `fault_mode` of each result (see `checkFaultMode`) is the second proof of what the running process did. A
// refusal body of a service has no `fault_mode` (the protocol fixes its two members), so for a counterparty that refused, the value that the guard read is the record.
import { types } from 'node:util';
import { FAULT_MODES, accepted, checkMembers, isFaultSetting, readMembers, refused } from '../protocol/index.ts';
import type { AgentKind, FaultSetting, ProtocolResult } from '../protocol/index.ts';
import { compareDetail, compareSettings } from './compare.ts';
import type { FaultCompareRefusal } from './compare.ts';
import { FAULT_MODE_VARIABLE, describeValue, isAgentKind } from './setting.ts';

/** A service of the run, as the script sees it. */
export interface SeenService<K extends AgentKind = AgentKind> {
  /** The name that the script uses for the service. A message names the service with it. */
  readonly service: string;
  readonly kind: K;
  /** The environment of the service, as the script can see it, or null when the script could not read it. */
  readonly env: Readonly<Record<string, unknown>> | null;
}

/** The setting that a guard found in one service. */
export interface SeenSetting {
  readonly service: string;
  readonly kind: AgentKind;
  readonly mode: FaultSetting;
}

/** The fault that a fault run expects: the service, and its value. The value is not empty, and it is a value of the kind of that service. */
export interface ExpectedFault {
  readonly service: string;
  readonly value: string;
}

export type RunGuardRefusal = 'bad_input' | 'service_unreadable' | 'bad_fault_mode' | FaultCompareRefusal;
export type RunGuardResult = ProtocolResult<readonly SeenSetting[], RunGuardRefusal>;

const NOT_PRINTABLE = /[^\x20-\x7e]/g;

/** A name that a script gave, as a message may show it: cut, printable, and in quotes. */
const label = (name: unknown): string => JSON.stringify(String(name).slice(0, 60).replace(NOT_PRINTABLE, '?'));

interface Entry {
  readonly service: string;
  readonly kind: AgentKind;
  readonly env: object | null;
}

/**
 * What the script gave as the environment of a service. A record of variables is an object whose prototype is `Object.prototype`, `null`, or the prototype of the real `process.env` of Node (which is
 * neither of the two). `null` is `unreadable`: the script could not read the environment. Everything else is `wrong`: an array, a Buffer, a Map, a String object, a URLSearchParams, a text and an
 * object of a class hold variables in a form that this guard does not read, so the script gave a wrong thing. So is EVERY Proxy, also one with no trap: the prototype test and the `in` test of a
 * Proxy are answered by its traps and by its target, so they say nothing about what a reader of the same object gets. The real `process.env` is not a Proxy.
 */
function envKind(env: unknown): 'record' | 'unreadable' | 'wrong' {
  if (env === null) return 'unreadable';
  if (typeof env !== 'object' || types.isProxy(env)) return 'wrong';
  const prototype: unknown = Object.getPrototypeOf(env);
  return prototype === Object.prototype || prototype === null || prototype === Object.getPrototypeOf(process.env) ? 'record' : 'wrong';
}

/** The services of a run: a list that is not empty, with a name, a kind of agent and an environment in each entry, and no name twice. */
function readServices(seen: unknown): ProtocolResult<readonly Entry[], 'bad_input'> {
  if (!Array.isArray(seen) || seen.length === 0) return refused('bad_input', 'the script gave no service to check, and a guard that checks nothing does not pass');
  const names = new Set<string>();
  const entries: Entry[] = [];
  for (let index = 0; index < seen.length; index += 1) {
    const read = readMembers(seen[index], `services[${index}]`);
    if (!read.ok) return refused('bad_input', read.detail);
    const members = checkMembers(read.value, `services[${index}]`, ['service', 'kind', 'env']);
    if (members !== null) return refused('bad_input', members.detail);
    const { service, kind, env } = read.value;
    if (typeof service !== 'string' || service === '') return refused('bad_input', `services[${index}].service must be the name of a service`);
    if (names.has(service)) return refused('bad_input', `the service ${label(service)} is in the list twice`);
    if (!isAgentKind(kind)) return refused('bad_input', `the service ${label(service)} has a kind that is not a kind of agent`);
    const kindOfEnv = envKind(env);
    if (kindOfEnv === 'wrong') return refused('bad_input', `the environment of the service ${label(service)} must be a record of variables, as process.env is, or null when it could not be read`);
    names.add(service);
    entries.push({ service, kind, env: kindOfEnv === 'record' && typeof env === 'object' ? env : null });
  }
  return accepted(entries);
}

/** The expectation of a fault run, checked against the services that were seen. */
function readExpected(expected: unknown, entries: readonly Entry[]): ProtocolResult<ExpectedFault, 'bad_input'> {
  const read = readMembers(expected, 'expected');
  if (!read.ok) return refused('bad_input', read.detail);
  const members = checkMembers(read.value, 'expected', ['service', 'value']);
  if (members !== null) return refused('bad_input', members.detail);
  const { service, value } = read.value;
  if (typeof service !== 'string' || typeof value !== 'string') return refused('bad_input', 'expected must name a service and a fault value, as texts');
  const entry = entries.find((item) => item.service === service);
  if (entry === undefined) return refused('bad_input', `the fault run expects a fault in the service ${label(service)}, and the script did not give that service`);
  const allowed = FAULT_MODES[entry.kind].map((name) => JSON.stringify(name)).join(' or ');
  if (value === '' || !isFaultSetting(entry.kind, value)) {
    const what = allowed === '' ? `${entry.kind} has no fault value` : `${entry.kind} allows ${allowed}`;
    return refused('bad_input', `the fault run expects ${describeValue(value)} in the service ${label(service)}, and ${what}`);
  }
  return accepted({ service, value });
}

/**
 * The text of FAULT_MODE in an environment that is a record of variables: not set is the empty text, and a value that is not a text is refused, `undefined` too (delete the variable to say that it
 * is not set). Only the variable of the record itself counts. A value that the record inherits from `Object.prototype`, a getter, and a read that throws (a module namespace object can throw
 * for a binding that is not set yet) are `service_unreadable`: a guard never passes on a value that it cannot read as data.
 */
function settingOf(entry: Entry): ProtocolResult<string, 'service_unreadable' | 'bad_fault_mode'> {
  const unreadable = refused('service_unreadable', `the script could not read the environment of the service ${label(entry.service)}`);
  if (entry.env === null) return unreadable;
  try {
    if (!(FAULT_MODE_VARIABLE in entry.env)) return accepted('');
    const descriptor = Reflect.getOwnPropertyDescriptor(entry.env, FAULT_MODE_VARIABLE);
    if (descriptor === undefined || !('value' in descriptor)) return unreadable;
    const value: unknown = descriptor.value;
    if (typeof value !== 'string') return refused('bad_fault_mode', `${FAULT_MODE_VARIABLE} of the service ${label(entry.service)} must be a text, got ${describeValue(value)}`);
    return accepted(value);
  } catch {
    return unreadable;
  }
}

/** The shared check. A clean run passes `faultRun` false. A fault run passes `faultRun` true and the expectation, so a missing expectation is a refusal and never a clean run. */
function check(seen: unknown, faultRun: boolean, expectedFault: unknown): RunGuardResult {
  const services = readServices(seen);
  if (!services.ok) return services;
  let expected: ExpectedFault | null = null;
  if (faultRun) {
    const named = readExpected(expectedFault, services.value);
    if (!named.ok) return named;
    expected = named.value;
  }
  const found: SeenSetting[] = [];
  for (const entry of services.value) {
    const setting = settingOf(entry);
    if (!setting.ok) return setting;
    const wanted = expected !== null && expected.service === entry.service ? expected.value : '';
    const code = compareSettings(wanted, setting.value);
    if (code !== null) return refused(code, compareDetail(code, `the service ${label(entry.service)}`, wanted, setting.value));
    found.push({ service: entry.service, kind: entry.kind, mode: setting.value as FaultSetting });
  }
  return accepted(found);
}

/**
 * The guard of a clean run. It refuses when any service that the script can see has a value in FAULT_MODE. Any value counts, also one that no kind lists, a space, and a text of another kind. A
 * run script calls it before it starts, and it stops when the guard refuses. The value of a pass lists each service with its setting, which is the empty text.
 */
export function checkCleanRun(seen: readonly SeenService[]): RunGuardResult {
  return check(seen, false, undefined);
}

/**
 * The guard of a fault run. The run names the one fault that it expects. It refuses when that service has no fault value (`fault_missing`), when it has another value (`fault_differs`), and when
 * any other service has a fault value (`fault_set`). A fault run with the wrong fault is as bad as a clean run with a fault, because the evidence would name a fault that did not run.
 */
export function checkFaultRun(seen: readonly SeenService[], expected: ExpectedFault): RunGuardResult {
  return check(seen, true, expected);
}
