// agents/insurer-intake-agent/test/report/issuer.test.ts: who counts as the issuer of each kind. The two Provider kinds expect the Provider key of the sender. The binding expects the ROOT DELEGATOR of the
// delegation, and nobody else: a key principal by the hash of its key, an agent root by its id, never both. The decoys are the rows that a loose match would take: a row that another key of the member's record
// issued, and a row with the key of an agent but another record. The question: can any issuer other than the expected one make a kind valid? Each refusal has an accepted twin.
import { describe, expect, it } from 'vitest';
import { didOfAgentId } from '@vsa/usecase-kit/protocol';
import type { ReportRow } from '../../src/report/index.ts';
import { AGENT_ROOT, ALL_VALID, GOOD_IDS, GOOD_ROWS, INPUT, MEMBER_ID, OTHER_ID, PROVIDER_HASH, ROOT_HASH, SENDER, STRANGER_HASH, T0, go, idOf, rig, row } from './support.ts';
import type { Rig, Script } from './support.ts';

/** The rows of the three lists, with `rows` as the list of type 4 and the good rows for the other kinds. */
const binding = (rows: readonly ReportRow[]): NonNullable<Script['rows']> => ({ ...GOOD_ROWS, 4: rows });
/** The ids that check was asked about for one attestation type, in the order of the calls. */
const asked = (r: Rig, attType: number): string[] => r.calls.check.filter((call) => call.expect.attType === attType).map((call) => call.id);

describe('the expectation that check gets', () => {
  it('names the type, the sender and the issuer, for each kind, and nothing else (no digest: a salted commitment cannot be recomputed here)', async () => {
    const agent = rig({ root: AGENT_ROOT, rows: binding([row(idOf(0x104), { issuer_id: MEMBER_ID })]) });
    expect(await go(agent)).toEqual(ALL_VALID);
    expect(agent.calls.check).toEqual([
      { id: GOOD_IDS[0], atMs: INPUT.atMs, expect: { attType: 1, subject: SENDER, issuer: { key_hash: PROVIDER_HASH } } },
      { id: GOOD_IDS[1], atMs: INPUT.atMs, expect: { attType: 2, subject: SENDER, issuer: { key_hash: PROVIDER_HASH } } },
      { id: GOOD_IDS[2], atMs: INPUT.atMs, expect: { attType: 4, subject: SENDER, issuer: { did: didOfAgentId(MEMBER_ID) } } },
    ]);
    const key = rig();
    await go(key);
    expect(key.calls.check[2]).toEqual({ id: GOOD_IDS[2], atMs: INPUT.atMs, expect: { attType: 4, subject: SENDER, issuer: { key_hash: ROOT_HASH } } });
  });

  it('gives each check an object of its own: a port that writes to the expectation changes nothing for the next call', async () => {
    const rows = [row(idOf(0x1), { issuer_key_hash: PROVIDER_HASH, issued_at: T0 }), row(idOf(0x2), { issuer_key_hash: PROVIDER_HASH, issued_at: T0 - 1 })];
    const seen: string[] = [];
    const r = rig({
      rows: { ...GOOD_ROWS, 1: rows },
      ports: {
        check: (_id, _atMs, expect) => {
          seen.push(JSON.stringify(expect));
          // The members of an expectation are read-only for the compiler: this port writes to them to show that each call gets its own copy.
          const writable: { attType: number; issuer: { key_hash: string } } = expect as never;
          writable.attType = 99;
          writable.issuer.key_hash = 'changed';
          return Promise.resolve(false);
        },
      },
    });
    await go(r);
    const first = JSON.stringify({ attType: 1, subject: SENDER, issuer: { key_hash: PROVIDER_HASH } });
    expect(seen.slice(0, 2)).toEqual([first, first]);
  });

  it('gives the time of the input to every check, also the time zero', async () => {
    const r = rig();
    await go(r, { ...INPUT, atMs: 0 });
    expect(r.calls.check.map((call) => call.atMs)).toEqual([0, 0, 0]);
  });
});

describe('a binding by a key principal', () => {
  it('matches a row by the hash of its key, whatever record the row names: the accepted twin of the decoy', async () => {
    const r = rig({ rows: binding([row(idOf(0x104), { issuer_key_hash: ROOT_HASH, issuer_id: MEMBER_ID })]) });
    expect(await go(r)).toEqual(ALL_VALID);
    expect(r.calls.check[2]?.expect.issuer).toEqual({ key_hash: ROOT_HASH });
  });

  it('DECOY: a row with the id of the record of the member and ANOTHER key hash is not a binding by the key principal: it is absent, and check is never called for it', async () => {
    const decoy = row(idOf(0x666), { issuer_id: MEMBER_ID, issuer_key_hash: STRANGER_HASH });
    const r = rig({ rows: binding([decoy]), valid: [...GOOD_IDS, decoy.id] });
    expect(await go(r)).toEqual({ provenance: 'valid', software: 'valid', principal_binding: 'absent' });
    expect(asked(r, 4)).toEqual([]);
  });

  it('DECOY: the same row does not hide the key of the principal: a row by the key is still found next to it, and only that row is asked', async () => {
    const decoy = row(idOf(0x666), { issuer_id: MEMBER_ID, issuer_key_hash: STRANGER_HASH, issued_at: T0 + 100 });
    const real = row(idOf(0x104), { issuer_key_hash: ROOT_HASH, issued_at: T0 });
    const r = rig({ rows: binding([decoy, real]), valid: [...GOOD_IDS, decoy.id] });
    expect(await go(r)).toEqual(ALL_VALID);
    expect(asked(r, 4)).toEqual([real.id]);
  });

  it('is not made by a row whose record id looks like the hash of the root: the hash of a key principal is compared with the key hash of the row and with nothing else', async () => {
    const lookalike = row(idOf(0x777), { issuer_id: ROOT_HASH.padEnd(64, '0'), issuer_key_hash: STRANGER_HASH });
    const r = rig({ rows: binding([lookalike]), valid: [lookalike.id] });
    expect((await go(r)).principal_binding).toBe('absent');
    expect(asked(r, 4)).toEqual([]);
  });

  it('does not read the Provider or the sender as the root: a row of the Provider key is not the binding, and a row of the record of the sender is not either', async () => {
    const byProvider = rig({ rows: binding([row(idOf(0x104), { issuer_key_hash: PROVIDER_HASH })]) });
    expect((await go(byProvider)).principal_binding).toBe('absent');
    const bySender = rig({ rows: binding([row(idOf(0x105), { issuer_id: SENDER.slice('did:vector:'.length), issuer_key_hash: STRANGER_HASH })]) });
    expect((await go(bySender)).principal_binding).toBe('absent');
  });
});

describe('a binding by an agent root', () => {
  it('matches a row by the id of its record, whatever key signed it, and gives check the DID of that record: the accepted twin of the decoy', async () => {
    const r = rig({ root: AGENT_ROOT, rows: binding([row(idOf(0x104), { issuer_id: MEMBER_ID, issuer_key_hash: STRANGER_HASH })]) });
    expect(await go(r)).toEqual(ALL_VALID);
    expect(r.calls.check[2]?.expect.issuer).toEqual({ did: `did:vector:${MEMBER_ID}` });
  });

  it('DECOY: a row with the key hash that a key principal would have, and no record, is not a binding by an agent root: it is absent, and check is never called for it', async () => {
    const decoy = row(idOf(0x666), { issuer_key_hash: ROOT_HASH, issuer_id: null });
    const r = rig({ root: AGENT_ROOT, rows: binding([decoy]), valid: [...GOOD_IDS, decoy.id] });
    expect(await go(r)).toEqual({ provenance: 'valid', software: 'valid', principal_binding: 'absent' });
    expect(asked(r, 4)).toEqual([]);
  });

  it('DECOY: a row with the key hash of the agent and ANOTHER record id is absent', async () => {
    const decoy = row(idOf(0x666), { issuer_key_hash: ROOT_HASH, issuer_id: OTHER_ID });
    const r = rig({ root: AGENT_ROOT, rows: binding([decoy]), valid: [...GOOD_IDS, decoy.id] });
    expect((await go(r)).principal_binding).toBe('absent');
    expect(asked(r, 4)).toEqual([]);
  });

  it('is found next to a decoy that is newer: only the row of the record is asked', async () => {
    const decoy = row(idOf(0x666), { issuer_key_hash: ROOT_HASH, issuer_id: OTHER_ID, issued_at: T0 + 100 });
    const real = row(idOf(0x104), { issuer_id: MEMBER_ID, issued_at: T0 });
    const r = rig({ root: AGENT_ROOT, rows: binding([decoy, real]), valid: [...GOOD_IDS, decoy.id] });
    expect(await go(r)).toEqual(ALL_VALID);
    expect(asked(r, 4)).toEqual([real.id]);
  });
});

describe('a kind by the Provider', () => {
  it('matches a row by the key hash of the Provider only: a row that names a record is not the Provider', async () => {
    const decoy = row(idOf(0x666), { issuer_id: MEMBER_ID, issuer_key_hash: STRANGER_HASH });
    const r = rig({ rows: { ...GOOD_ROWS, 1: [decoy], 2: [decoy] }, valid: [...GOOD_IDS, decoy.id] });
    expect(await go(r)).toEqual({ provenance: 'absent', software: 'absent', principal_binding: 'valid' });
    expect(asked(r, 1)).toEqual([]);
    expect(asked(r, 2)).toEqual([]);
  });

  it('matches a row of the Provider key with or without a record: the accepted twin', async () => {
    const withRecord = row(idOf(0x101), { issuer_key_hash: PROVIDER_HASH, issuer_id: OTHER_ID });
    const r = rig({ rows: { ...GOOD_ROWS, 1: [withRecord] }, valid: [...GOOD_IDS] });
    expect(await go(r)).toEqual(ALL_VALID);
    expect(r.calls.check[0]?.expect.issuer).toEqual({ key_hash: PROVIDER_HASH });
  });
});
