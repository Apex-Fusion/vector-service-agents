// scripts/checks/lib/state.ts - the state file of a check.
// One JSON file for each check, with mode 600. A step is recorded when it is confirmed, with its transaction hash and the references that the next step needs, and a confirmed step
// is never recorded again. A transaction that was signed and is not yet seen confirmed is kept apart, as `in_flight`, with its signed bytes: a new run asks the chain about it first,
// so that no step is built twice. The file is written whole through a temporary file, and a failed write leaves the old file as it was.
import { lstatSync, readFileSync } from 'node:fs';
import { writeFileAtomically } from './files.ts';
import type { WriteIo } from './files.ts';

export const STATE_FORMAT = 1;

/** A confirmed step. `refs` are what later steps need (a reference of an output, an identifier). `verified_at` is set when the read of the hosted tools has matched the step. */
export interface StepRecord {
  confirmed_at: string;
  tx_hash: string | null;
  refs: Record<string, string>;
  facts: Record<string, unknown>;
  verified_at: string | null;
}

/** A transaction that was signed and not yet seen confirmed. `valid_to` is the end of its validity in POSIX ms: after it the transaction can no longer land. */
export interface InFlight {
  step: string;
  tx_hash: string;
  signed_cbor: string;
  valid_to: number;
  signed_at: number;
  /** What the step records once the transaction is confirmed. */
  refs: Record<string, string>;
  facts: Record<string, unknown>;
}

export interface CheckState {
  format: typeof STATE_FORMAT;
  check: string;
  network: string;
  record: string;
  created_at: string;
  steps: Record<string, StepRecord>;
  in_flight: InFlight | null;
  notes: Record<string, unknown>;
}

export type StateReason = 'mode' | 'unreadable' | 'invalid' | 'mismatch' | 'confirmed' | 'in_flight' | 'unknown_step';

export class StateError extends Error {
  readonly reason: StateReason;
  constructor(reason: StateReason, message: string) {
    super(message);
    this.name = 'StateError';
    this.reason = reason;
  }
}

const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const isText = (value: unknown): value is string => typeof value === 'string';
const isWhole = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value);

function textMap(value: unknown, where: string, path: string): Record<string, string> {
  if (!isObject(value) || !Object.values(value).every(isText)) throw new StateError('invalid', `${path}: ${where} is not a map of texts`);
  return value as Record<string, string>;
}

function stepOf(value: unknown, name: string, path: string): StepRecord {
  const where = `steps.${name}`;
  if (!isObject(value)) throw new StateError('invalid', `${path}: ${where} is not an object`);
  if (!isText(value.confirmed_at)) throw new StateError('invalid', `${path}: ${where}.confirmed_at is not a text`);
  if (value.tx_hash !== null && !isText(value.tx_hash)) throw new StateError('invalid', `${path}: ${where}.tx_hash is neither a text nor null`);
  if (value.verified_at !== null && !isText(value.verified_at)) throw new StateError('invalid', `${path}: ${where}.verified_at is neither a text nor null`);
  if (!isObject(value.facts)) throw new StateError('invalid', `${path}: ${where}.facts is not an object`);
  return { confirmed_at: value.confirmed_at, tx_hash: value.tx_hash, refs: textMap(value.refs, `${where}.refs`, path), facts: value.facts, verified_at: value.verified_at };
}

function inFlightOf(value: unknown, path: string): InFlight | null {
  if (value === null) return null;
  if (!isObject(value) || !isText(value.step) || !isText(value.tx_hash) || !isText(value.signed_cbor) || !isWhole(value.valid_to) || !isWhole(value.signed_at) || !isObject(value.facts)) {
    throw new StateError('invalid', `${path}: in_flight is not a transaction in flight (step, tx_hash, signed_cbor, valid_to, signed_at, refs, facts)`);
  }
  return { step: value.step, tx_hash: value.tx_hash, signed_cbor: value.signed_cbor, valid_to: value.valid_to, signed_at: value.signed_at, refs: textMap(value.refs, 'in_flight.refs', path), facts: value.facts };
}

/** The state that a file holds, checked field by field. */
function stateOf(value: unknown, path: string): CheckState {
  if (!isObject(value)) throw new StateError('invalid', `${path} is not a JSON object`);
  if (value.format !== STATE_FORMAT) throw new StateError('invalid', `${path}: format is not ${STATE_FORMAT}`);
  for (const field of ['check', 'network', 'record', 'created_at'] as const) {
    if (!isText(value[field])) throw new StateError('invalid', `${path}: ${field} is not a text`);
  }
  if (!isObject(value.steps)) throw new StateError('invalid', `${path}: steps is not an object`);
  if (!isObject(value.notes)) throw new StateError('invalid', `${path}: notes is not an object`);
  const steps = Object.fromEntries(Object.entries(value.steps).map(([name, step]) => [name, stepOf(step, name, path)]));
  return {
    format: STATE_FORMAT, check: value.check as string, network: value.network as string, record: value.record as string, created_at: value.created_at as string,
    steps, in_flight: inFlightOf(value.in_flight, path), notes: value.notes,
  };
}

export interface StateIdentity { check: string; network: string; record: string }

/** Reads a state file that is there: it must be a file and no link, and its mode, its JSON and its shape are checked. */
function readState(path: string): CheckState {
  const found = lstatSync(path);
  if (found.isSymbolicLink()) throw new StateError('invalid', `${path} is a link, and a state file is a file: use the file itself, or move the link away to start the check again`);
  const mode = found.mode & 0o777;
  if (process.platform !== 'win32' && (mode & 0o077) !== 0) throw new StateError('mode', `${path} has mode ${mode.toString(8)} and other users can read it: set mode 600 on it`);
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(path, 'utf8')); } catch (err) {
    throw new StateError(err instanceof SyntaxError ? 'invalid' : 'unreadable', `${path} is ${err instanceof SyntaxError ? 'not JSON' : 'not readable'}: repair it, or move it away to start the check again`);
  }
  return stateOf(parsed, path);
}

export class StateFile {
  readonly path: string;
  readonly #io: Partial<WriteIo>;
  #state: CheckState;

  private constructor(path: string, state: CheckState, io: Partial<WriteIo>) {
    this.path = path;
    this.#state = state;
    this.#io = io;
  }

  /**
   * Opens the state file of a check, or makes it. A file that belongs to another check, another network or another record is refused, so is one that other users can read, one that is not a
   * state file and a link (the look at the path does not follow a link, so a link to a file that is not there is refused too, and the write never replaces it). A refused file is left as it is.
   */
  static open(path: string, identity: StateIdentity, io: Partial<WriteIo> = {}): StateFile {
    if (lstatSync(path, { throwIfNoEntry: false }) === undefined) {
      const state: CheckState = { format: STATE_FORMAT, ...identity, created_at: new Date().toISOString(), steps: {}, in_flight: null, notes: {} };
      writeFileAtomically(path, `${JSON.stringify(state, null, 2)}\n`, io);
      return new StateFile(path, state, io);
    }
    const state = readState(path);
    for (const field of ['check', 'network', 'record'] as const) {
      if (state[field] !== identity[field]) throw new StateError('mismatch', `${path} is the state of another ${field} (${field}: ${state[field]}), and this run is for ${identity[field]}: use another folder or another record`);
    }
    return new StateFile(path, state, io);
  }

  /** Reads the state file of a check, for another check that needs a fact of it. It makes nothing: a file that is not there gives null. */
  static peek(path: string): CheckState | null {
    return lstatSync(path, { throwIfNoEntry: false }) === undefined ? null : readState(path);
  }

  snapshot(): CheckState {
    return structuredClone(this.#state);
  }

  step(name: string): StepRecord | undefined {
    const step = this.#state.steps[name];
    return step === undefined ? undefined : structuredClone(step);
  }

  confirmed(name: string): boolean {
    return this.#state.steps[name] !== undefined;
  }

  note<T = unknown>(key: string): T | undefined {
    const note = this.#state.notes[key];
    return note === undefined ? undefined : (structuredClone(note) as T);
  }

  /** Records a confirmed step. A step that is already recorded is not recorded again. */
  recordStep(name: string, record: Omit<StepRecord, 'verified_at'> & { verified_at?: string | null }): void {
    if (this.#state.steps[name] !== undefined) throw new StateError('confirmed', `the step ${name} is confirmed already, and a confirmed step is never run again`);
    this.#commit((next) => { next.steps[name] = { ...structuredClone(record), verified_at: record.verified_at ?? null }; });
  }

  markVerified(name: string, at: string): void {
    if (this.#state.steps[name] === undefined) throw new StateError('unknown_step', `the step ${name} is not recorded`);
    this.#commit((next) => { next.steps[name]!.verified_at = at; });
  }

  setInFlight(inFlight: InFlight): void {
    if (this.#state.in_flight !== null) throw new StateError('in_flight', `the step ${this.#state.in_flight.step} is in flight (${this.#state.in_flight.tx_hash}): settle it before another transaction is signed`);
    this.#commit((next) => { next.in_flight = structuredClone(inFlight); });
  }

  clearInFlight(): void {
    this.#commit((next) => { next.in_flight = null; });
  }

  setNote(key: string, value: unknown): void {
    this.#commit((next) => { next.notes[key] = structuredClone(value); });
  }

  /** Applies a change to a copy, writes the copy, and keeps what was written only when the write worked. A bigint is written as its decimal text. */
  #commit(change: (next: CheckState) => void): void {
    const next = structuredClone(this.#state);
    change(next);
    const text = `${JSON.stringify(next, (_key, value: unknown) => (typeof value === 'bigint' ? value.toString() : value), 2)}\n`;
    writeFileAtomically(this.path, text, this.#io);
    this.#state = JSON.parse(text) as CheckState;
  }
}
