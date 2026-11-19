// The evidence file of a check: what each confirmed step shows, and, for a step that the ledger refuses, the evaluation error and the transaction body.
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { EvidenceError, EvidenceFile } from '../lib/evidence.ts';

const root = mkdtempSync(join(tmpdir(), 'checks-evidence-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let dir = '';
let n = 0;
beforeEach(() => { n += 1; dir = join(root, `case-${n}`); });
const HEADER = { check: 'delegation', network: 'vector-mainnet', record: 'did:vector:abc' };
const clock = () => '2026-11-19T12:00:00.000Z';
const fileOf = (path: string) => JSON.parse(readFileSync(path, 'utf8')) as { format: number; entries: Array<Record<string, unknown>> } & typeof HEADER;
const refusal = (run: () => unknown): EvidenceError => {
  try { run(); } catch (err) { if (err instanceof EvidenceError) return err; throw err; }
  throw new Error('the call did not refuse');
};

describe('the evidence file', () => {
  it('is made with mode 600 and the header of the check, and gets one entry for each event, in order', () => {
    const path = join(dir, 'e.json');
    const file = EvidenceFile.open(path, HEADER, { clock });
    file.add({ step: 'delegate', status: 'confirmed', tx_hash: 'ab'.repeat(32), fee_lovelace: 400_000n, shows: { delegation: 'cd'.repeat(32) } });
    file.add({ step: 'delegate', status: 'verified', hosted: [{ tool: 'vector_get_delegation', arguments: { delegation: 'cd'.repeat(32) }, ok: true, result: { live: true } }] });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const written = fileOf(path);
    expect(written).toMatchObject({ format: 1, ...HEADER });
    expect(written.entries.map((e) => [e.step, e.status])).toEqual([['delegate', 'confirmed'], ['delegate', 'verified']]);
    expect(written.entries[0]).toMatchObject({ at: '2026-11-19T12:00:00.000Z', fee_lovelace: '400000', tx_hash: 'ab'.repeat(32) });
  });
  it('goes on from the entries that it has when it is opened again', () => {
    const path = join(dir, 'e.json');
    EvidenceFile.open(path, HEADER, { clock }).add({ step: 'a', status: 'info', shows: { x: 1 } });
    const again = EvidenceFile.open(path, HEADER, { clock });
    expect(again.entries()).toHaveLength(1);
    again.add({ step: 'b', status: 'info', shows: {} });
    expect(fileOf(path).entries.map((e) => e.step)).toEqual(['a', 'b']);
  });
  it('writes a bigint as its decimal text, at any depth', () => {
    const path = join(dir, 'e.json');
    EvidenceFile.open(path, HEADER, { clock }).add({ step: 'a', status: 'info', shows: { deep: { amount: 10n ** 20n } } });
    expect(fileOf(path).entries[0]).toMatchObject({ shows: { deep: { amount: '100000000000000000000' } } });
  });
});

describe('a step that the ledger refuses', () => {
  const refused = { step: 'pay', status: 'refused' as const, expected: false, tx_hash: null, evaluation_error: '3010 Some scripts of the transactions terminated with error(s).', transaction_body: 'a400' };
  it('holds the evaluation error and the transaction body, and says that nobody expected the refusal', () => {
    const path = join(dir, 'e.json');
    EvidenceFile.open(path, HEADER, { clock }).add(refused);
    expect(fileOf(path).entries[0]).toMatchObject({ status: 'refused', expected: false, evaluation_error: refused.evaluation_error, transaction_body: 'a400' });
  });
  it('is not written without the error or without the body, and the file stays as it was', () => {
    const path = join(dir, 'e.json');
    const file = EvidenceFile.open(path, HEADER, { clock });
    const before = readFileSync(path, 'utf8');
    expect(refusal(() => file.add({ ...refused, evaluation_error: '' })).message).toContain('evaluation error');
    expect(refusal(() => file.add({ ...refused, transaction_body: '' })).message).toContain('transaction body');
    expect(refusal(() => file.add({ ...refused, transaction_body: 'not hex' })).message).toContain('transaction body');
    expect(readFileSync(path, 'utf8')).toBe(before);
    file.add({ ...refused, expected: true });
    expect(fileOf(path).entries[0]).toMatchObject({ expected: true });
  });
});

describe('a step that a tool refuses', () => {
  it('holds the message of the tool', () => {
    const path = join(dir, 'e.json');
    const file = EvidenceFile.open(path, HEADER, { clock });
    file.add({ step: 'read', status: 'tool_refused', expected: false, tool: 'vector_get_attestation', message: 'Failed to read the attestation: the node did not answer' });
    expect(fileOf(path).entries[0]).toMatchObject({ status: 'tool_refused', tool: 'vector_get_attestation', message: 'Failed to read the attestation: the node did not answer' });
    expect(refusal(() => file.add({ step: 'read', status: 'tool_refused', expected: false, tool: 'x', message: '' })).message).toContain('message');
  });
});

describe('a file that is not the evidence of this check', () => {
  it('is refused when it belongs to another check or record, when it is not JSON, and is left as it is', () => {
    const path = join(dir, 'e.json');
    EvidenceFile.open(path, HEADER, { clock });
    expect(refusal(() => EvidenceFile.open(path, { ...HEADER, check: 'other' }, { clock })).message).toContain('check');
    expect(refusal(() => EvidenceFile.open(path, { ...HEADER, record: 'did:vector:def' }, { clock })).message).toContain('record');
    writeFileSync(path, '{broken', { mode: 0o600 });
    expect(refusal(() => EvidenceFile.open(path, HEADER, { clock })).message).toContain('JSON');
    expect(readFileSync(path, 'utf8')).toBe('{broken');
  });
});
