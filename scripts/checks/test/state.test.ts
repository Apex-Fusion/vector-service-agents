// The state file of a check: one JSON file, mode 600, a step recorded only when it is confirmed, and never a confirmed step again.
import { chmodSync, existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { StateError, StateFile } from '../lib/state.ts';
import type { InFlight, StepRecord } from '../lib/state.ts';

const root = mkdtempSync(join(tmpdir(), 'checks-state-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let dir = '';
let n = 0;
beforeEach(() => { n += 1; dir = join(root, `case-${n}`); });

const ID = { check: 'delegation', network: 'vector-mainnet', record: 'did:vector:abc' };
const STEP: StepRecord = { confirmed_at: '2026-11-19T12:00:00.000Z', tx_hash: 'ab'.repeat(32), refs: { delegation_id: 'cd'.repeat(32) }, facts: { amount: '2000000' }, verified_at: null };
const FLIGHT: InFlight = { step: 'delegate', tx_hash: 'ab'.repeat(32), signed_cbor: '84a4', valid_to: 1_800_000_000_000, signed_at: 1_799_999_000_000, refs: { delegation_output: `${'ab'.repeat(32)}#0` }, facts: {} };
const refusal = (run: () => unknown): StateError => {
  try { run(); } catch (err) { if (err instanceof StateError) return err; throw err; }
  throw new Error('the call did not refuse');
};
const stateAt = (path: string) => JSON.parse(readFileSync(path, 'utf8')) as { steps: Record<string, StepRecord>; in_flight: InFlight | null; notes: Record<string, unknown> };

describe('a new state file', () => {
  it('is made with mode 600 in a folder with mode 700, and holds the identity of the check', () => {
    const path = join(dir, 'delegation.state.json');
    const file = StateFile.open(path, ID);
    expect(existsSync(path)).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    const snapshot = file.snapshot();
    expect(snapshot).toMatchObject({ format: 1, ...ID, steps: {}, in_flight: null, notes: {} });
    expect(Number.isNaN(Date.parse(snapshot.created_at))).toBe(false);
  });
  it('is the same file when it is opened again', () => {
    const path = join(dir, 's.json');
    const first = StateFile.open(path, ID).snapshot();
    expect(StateFile.open(path, ID).snapshot()).toEqual(first);
  });
});

describe('the steps', () => {
  it('are recorded when they are confirmed, and are there after a new open', () => {
    const path = join(dir, 's.json');
    const file = StateFile.open(path, ID);
    expect(file.confirmed('delegate')).toBe(false);
    file.recordStep('delegate', STEP);
    expect(file.confirmed('delegate')).toBe(true);
    const again = StateFile.open(path, ID);
    expect(again.step('delegate')).toEqual(STEP);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });
  it('are never recorded twice: a confirmed step is not run again', () => {
    const path = join(dir, 's.json');
    const file = StateFile.open(path, ID);
    file.recordStep('delegate', STEP);
    const before = readFileSync(path, 'utf8');
    expect(refusal(() => file.recordStep('delegate', { ...STEP, tx_hash: 'ef'.repeat(32) })).reason).toBe('confirmed');
    expect(readFileSync(path, 'utf8')).toBe(before);
    expect(file.step('delegate')?.tx_hash).toBe(STEP.tx_hash);
  });
  it('have a verification that is marked once', () => {
    const file = StateFile.open(join(dir, 's.json'), ID);
    file.recordStep('delegate', STEP);
    file.markVerified('delegate', '2026-11-19T12:05:00.000Z');
    expect(file.step('delegate')?.verified_at).toBe('2026-11-19T12:05:00.000Z');
    expect(() => file.markVerified('absent', 'x')).toThrow(StateError);
  });
  it('give back copies: a change of the copy does not change the file', () => {
    const file = StateFile.open(join(dir, 's.json'), ID);
    file.recordStep('delegate', STEP);
    file.snapshot().steps.delegate!.refs.delegation_id = 'changed';
    file.step('delegate')!.refs.delegation_id = 'changed';
    expect(file.step('delegate')?.refs.delegation_id).toBe('cd'.repeat(32));
  });
});

describe('a transaction in flight', () => {
  it('is kept with its signed bytes before it is submitted, and is there after a new open', () => {
    const path = join(dir, 's.json');
    const file = StateFile.open(path, ID);
    file.setInFlight(FLIGHT);
    expect(StateFile.open(path, ID).snapshot().in_flight).toEqual(FLIGHT);
    file.clearInFlight();
    expect(StateFile.open(path, ID).snapshot().in_flight).toBeNull();
  });
  it('is one at a time', () => {
    const file = StateFile.open(join(dir, 's.json'), ID);
    file.setInFlight(FLIGHT);
    expect(refusal(() => file.setInFlight({ ...FLIGHT, step: 'other' })).reason).toBe('in_flight');
  });
});

describe('the notes', () => {
  it('keep what a check needs later, as JSON', () => {
    const path = join(dir, 's.json');
    const file = StateFile.open(path, ID);
    file.setNote('limits', { per_tx: '3000000' });
    expect(StateFile.open(path, ID).note('limits')).toEqual({ per_tx: '3000000' });
    expect(file.note('absent')).toBeUndefined();
  });
});

describe('a file that is not the state of this check', () => {
  it('is refused when it belongs to another check, another network or another record, and is left as it is', () => {
    const path = join(dir, 's.json');
    StateFile.open(path, ID);
    const before = readFileSync(path, 'utf8');
    for (const [field, other] of [['check', { ...ID, check: 'vault-escrow' }], ['network', { ...ID, network: 'other' }], ['record', { ...ID, record: 'did:vector:def' }]] as const) {
      const err = refusal(() => StateFile.open(path, other));
      expect(err.reason, field).toBe('mismatch');
      expect(err.message, field).toContain(field);
    }
    expect(readFileSync(path, 'utf8')).toBe(before);
  });
  it('is refused when other users can read it, with the way to fix it', () => {
    const path = join(dir, 's.json');
    StateFile.open(path, ID);
    chmodSync(path, 0o644);
    const err = refusal(() => StateFile.open(path, ID));
    expect(err.reason).toBe('mode');
    expect(err.message).toContain('mode 600');
  });
  it('is refused when it is not JSON, has another format, or holds a wrong shape, and is not overwritten', () => {
    const path = join(dir, 's.json');
    StateFile.open(path, ID);
    const good = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    const bad: Array<[string, string]> = [
      ['{not json', 'not JSON'],
      [JSON.stringify([]), 'not an object'],
      [JSON.stringify({ ...good, format: 2 }), 'format'],
      [JSON.stringify({ ...good, steps: [] }), 'steps'],
      [JSON.stringify({ ...good, steps: { delegate: { ...STEP, tx_hash: 7 } } }), 'tx_hash'],
      [JSON.stringify({ ...good, steps: { delegate: { ...STEP, refs: { a: 1 } } } }), 'refs'],
      [JSON.stringify({ ...good, in_flight: { step: 'x' } }), 'in_flight'],
      [JSON.stringify({ ...good, notes: 5 }), 'notes'],
    ];
    for (const [text, what] of bad) {
      writeFileSync(path, text, { mode: 0o600 });
      const err = refusal(() => StateFile.open(path, ID));
      expect(err.reason, what).toBe('invalid');
      expect(readFileSync(path, 'utf8'), what).toBe(text);
    }
  });
  it('is refused when it is a link, a link to a state file or a link to nothing, and the link and what it names are left as they are', () => {
    const real = join(dir, 'real.json');
    StateFile.open(real, ID);
    const before = readFileSync(real, 'utf8');
    const nothing = join(dir, 'nothing.json');
    expect(StateFile.peek(nothing)).toBeNull();
    expect(StateFile.peek(real)?.check).toBe(ID.check);
    for (const [name, goal] of [['to-file.json', real], ['to-nothing.json', nothing]] as const) {
      const link = join(dir, name);
      symlinkSync(goal, link);
      for (const call of [() => StateFile.open(link, ID), () => StateFile.peek(link)]) {
        const err = refusal(call);
        expect(err.reason, name).toBe('invalid');
        expect(err.message, name).toContain('is a link');
      }
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(readlinkSync(link)).toBe(goal);
    }
    expect(existsSync(nothing)).toBe(false);
    expect(readFileSync(real, 'utf8')).toBe(before);
  });
});

describe('a write that fails', () => {
  it('leaves the file as it was, whole, and no half file', () => {
    const path = join(dir, 's.json');
    StateFile.open(path, ID);
    const file = StateFile.open(path, ID, { rename: () => { throw new Error('the disk is full'); } });
    const before = readFileSync(path, 'utf8');
    expect(() => file.recordStep('delegate', STEP)).toThrow('the disk is full');
    expect(readFileSync(path, 'utf8')).toBe(before);
    expect(stateAt(path).steps).toEqual({});
  });
  it('leaves the step unrecorded in memory too, so that a retry can record it', () => {
    const path = join(dir, 's.json');
    StateFile.open(path, ID);
    let fail = true;
    const file = StateFile.open(path, ID, { rename: (from, to) => { if (fail) throw new Error('the disk is full'); renameSync(from, to); } });
    expect(() => file.recordStep('delegate', STEP)).toThrow();
    expect(file.confirmed('delegate')).toBe(false);
    fail = false;
    file.recordStep('delegate', STEP);
    expect(stateAt(path).steps.delegate).toEqual(STEP);
  });
});
