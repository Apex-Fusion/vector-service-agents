// agents/insurer-intake-agent/test/report/words.test.ts: the four words of the report, for each of the three kinds. The agent reads the provenance (type 1) and the software (type 2) attestation of the sender, issued
// by its Provider, and the principal-binding attestation (type 4), issued by the root delegator, and it reports what it found. It never refuses. The question for each test: does a kind get the right word,
// and is a source that cannot be read ever reported as anything but `unreadable`? Each refusal has an accepted twin: the rig with no change gives `valid` for every kind.
import { describe, expect, it } from 'vitest';
import { ATTESTATION_STATES } from '@vsa/usecase-kit/priorauth';
import type { ReportRow } from '../../src/report/index.ts';
import {
  AGENT_ROOT, ALL_VALID, FAILURES, GOOD_IDS, GOOD_ROWS, INPUT, KEY_ROOT, KIND_NAMES, MEMBER_ID, PROVIDER_HASH, ROOT_HASH, SENDER, STRANGER_HASH, T0, TYPES, go, idOf, replacing, rig, row,
} from './support.ts';
import type { Kind, PortName, Rig } from './support.ts';

/** The issuer that a kind expects, as the hash that its rows carry: the Provider for the first two kinds and the root delegator for the third. */
const ISSUER: Readonly<Record<Kind, string>> = { provenance: PROVIDER_HASH, software: PROVIDER_HASH, principal_binding: ROOT_HASH };
/** The report in which `kind` has `word` and the other kinds are valid. */
const only = (kind: Kind, word: string): Record<string, string> => ({ ...ALL_VALID, [kind]: word });

describe('the accepted twin', () => {
  it('reports valid for each kind, and asks the ports in the order provenance, software, principal binding', async () => {
    const r = rig();
    expect(await go(r)).toEqual(ALL_VALID);
    expect(r.calls.list).toEqual([{ subject: SENDER, attType: 1 }, { subject: SENDER, attType: 2 }, { subject: SENDER, attType: 4 }]);
    expect(r.calls.root).toEqual([INPUT.delegation]);
    expect(r.calls.check.map((call) => call.id)).toEqual(GOOD_IDS);
  });

  it('gives a plain object with the three members and only words of the intake record', async () => {
    const report = await go(rig());
    expect(Object.keys(report)).toEqual(['provenance', 'software', 'principal_binding']);
    for (const word of Object.values(report)) expect(ATTESTATION_STATES).toContain(word);
  });
});

describe.each(KIND_NAMES)('the kind %s', (kind) => {
  const issuer = ISSUER[kind];
  const type = TYPES[kind];
  /** An attestation of the right issuer for this kind: `n` names it, and `issued_at` is its issue time. */
  const own = (n: number, issued_at: number): ReportRow => row(idOf(0x1000 + n), { issuer_key_hash: issuer, issued_at });
  /** A rig in which this kind holds `rows`, the other kinds are as in the twin, and `check` calls valid the ids of the other kinds and `ids`. */
  const rigOf = (rows: readonly ReportRow[], ids: readonly string[] = []): Rig => rig({ rows: { ...GOOD_ROWS, [type]: rows }, valid: [...GOOD_IDS, ...ids] });
  /** The ids that `check` was asked about for this kind, in the order of the calls. */
  const asked = (r: Rig): string[] => r.calls.check.filter((call) => call.expect.attType === type).map((call) => call.id);

  describe('valid', () => {
    it('is valid when the only attestation of the right issuer checks', async () => {
      expect(await go(rigOf([own(1, T0)], [idOf(0x1001)]))).toEqual(ALL_VALID);
    });

    it('is valid when the newest checks and the second newest does not: the second is never asked', async () => {
      const r = rigOf([own(1, T0 - 10), own(2, T0)], [idOf(0x1002)]);
      expect(await go(r)).toEqual(ALL_VALID);
      expect(asked(r)).toEqual([idOf(0x1002)]);
    });

    it('is valid when the newest does not check and the second newest does: an older valid attestation after a newer invalid one is valid', async () => {
      const r = rigOf([own(1, T0 - 10), own(2, T0)], [idOf(0x1001)]);
      expect(await go(r)).toEqual(ALL_VALID);
      expect(asked(r)).toEqual([idOf(0x1002), idOf(0x1001)]);
    });

    it('counts an attestation that its issue time puts after the time of the check: a relying party does not require that the time is after the issue time', async () => {
      const r = rigOf([own(1, INPUT.atMs + 1_800_000)], [idOf(0x1001)]);
      expect(await go(r)).toEqual(ALL_VALID);
      expect(asked(r)).toEqual([idOf(0x1001)]);
    });
  });

  describe('invalid', () => {
    it('is invalid when the only attestation of the right issuer does not check (it is revoked, expired or not yet valid)', async () => {
      expect(await go(rigOf([own(1, T0)]))).toEqual(only(kind, 'invalid'));
    });

    it('is invalid when the newest two do not check', async () => {
      expect(await go(rigOf([own(1, T0 - 10), own(2, T0)]))).toEqual(only(kind, 'invalid'));
    });

    it('asks the newest two and never the third: a valid third attestation gives invalid', async () => {
      const r = rigOf([own(1, T0 - 20), own(2, T0 - 10), own(3, T0)], [idOf(0x1001)]);
      expect(await go(r)).toEqual(only(kind, 'invalid'));
      expect(asked(r)).toEqual([idOf(0x1003), idOf(0x1002)]);
    });

    it('orders the rows by issue time, newest first, and by id when two rows have one time', async () => {
      const r = rigOf([own(5, T0), own(7, T0 + 10), own(6, T0), own(4, T0 - 10)]);
      await go(r);
      expect(asked(r)).toEqual([idOf(0x1007), idOf(0x1005)]);
    });

    it('asks one attestation once when a list repeats its row, so that the second check is a different attestation', async () => {
      const r = rigOf([own(1, T0), own(1, T0), own(2, T0 - 10)], [idOf(0x1002)]);
      expect(await go(r)).toEqual(ALL_VALID);
      expect(asked(r)).toEqual([idOf(0x1001), idOf(0x1002)]);
    });
  });

  describe('absent', () => {
    it('is absent when no row exists, and no check is asked', async () => {
      const r = rigOf([]);
      expect(await go(r)).toEqual(only(kind, 'absent'));
      expect(asked(r)).toEqual([]);
    });

    it('is absent when every row is of another issuer, also a row that names a record: a stranger cannot make a kind valid or invalid, and no check is asked for its rows', async () => {
      const strangers = [row(idOf(0x2001), { issued_at: T0 }), row(idOf(0x2002), { issued_at: T0 - 10, issuer_id: MEMBER_ID })];
      const r = rigOf(strangers, strangers.map((stranger) => stranger.id));
      expect(await go(r)).toEqual(only(kind, 'absent'));
      expect(asked(r)).toEqual([]);
    });

    it('does not ask for the row of a stranger that is newer than the row of the right issuer', async () => {
      const r = rigOf([row(idOf(0x2001), { issued_at: T0 + 100 }), own(1, T0)], [idOf(0x2001)]);
      expect(await go(r)).toEqual(only(kind, 'invalid'));
      expect(asked(r)).toEqual([idOf(0x1001)]);
    });
  });
});

describe('a sender with no Provider party', () => {
  it('is absent for the provenance and the software attestation, with no read of a list, and the binding is read as before', async () => {
    const r = rig({ provider: null });
    expect(await go(r)).toEqual({ provenance: 'absent', software: 'absent', principal_binding: 'valid' });
    expect(r.calls.list.map((call) => call.attType)).toEqual([4]);
  });

  it('reads the record of the sender once for the two kinds', async () => {
    const r = rig();
    await go(r);
    expect(r.calls.provider).toEqual([{ sender: SENDER, atMs: INPUT.atMs }]);
  });

  it('gives the time of the check to the read of the Provider, so that the Provider in force at that time is the one that counts', async () => {
    for (const atMs of [0, 1_234_567, 1_900_000_000_000]) {
      const r = rig();
      await go(r, { ...INPUT, atMs });
      expect(r.calls.provider).toEqual([{ sender: SENDER, atMs }]);
    }
  });
});

describe('the root delegator of the delegation', () => {
  it('is read from the delegation of the input, and a root that is null gives unreadable for the binding only', async () => {
    const r = rig({ root: null });
    expect(await go(r)).toEqual({ provenance: 'valid', software: 'valid', principal_binding: 'unreadable' });
    expect(r.calls.root).toEqual([INPUT.delegation]);
    expect(r.calls.list.map((call) => call.attType)).toEqual([1, 2]);
  });

  it('is read for an agent root as well as for a key principal', async () => {
    expect(await go(rig({ root: AGENT_ROOT, rows: { ...GOOD_ROWS, 4: [row(idOf(0x104), { issuer_id: MEMBER_ID })] } }))).toEqual(ALL_VALID);
    expect(await go(rig({ root: KEY_ROOT }))).toEqual(ALL_VALID);
  });
});

describe('a source that fails', () => {
  /** The ports of the report, and the kinds that each one decides. A failed source is `unreadable` for these kinds, and the others are read as before. */
  const PORTS: ReadonlyArray<{ port: PortName; kinds: readonly Kind[] }> = [
    { port: 'providerKeyHashOf', kinds: ['provenance', 'software'] },
    { port: 'rootDelegatorOf', kinds: ['principal_binding'] },
    { port: 'list', kinds: KIND_NAMES },
    { port: 'check', kinds: KIND_NAMES },
  ];
  const expected = (kinds: readonly Kind[]): Record<string, string> => Object.fromEntries(KIND_NAMES.map((kind) => [kind, kinds.includes(kind) ? 'unreadable' : 'valid']));

  describe.each(PORTS)('the port $port', ({ port, kinds }) => {
    it.each(Object.entries(FAILURES))('is unreadable for its kinds when it %s, and never absent, invalid or valid', async (_name, failure) => {
      expect(await go(rig({ ports: replacing(port, failure) }))).toEqual(expected(kinds));
    });
  });

  it('stops only the kind that it belongs to: a list that fails for one type leaves the other types as they were', async () => {
    const failing = (type: number): Rig => rig({ ports: { list: (_subject, attType) => (attType === type ? FAILURES['rejects with an error']() : Promise.resolve(GOOD_ROWS[attType] ?? [])) } });
    expect(await go(failing(1))).toEqual({ provenance: 'unreadable', software: 'valid', principal_binding: 'valid' });
    expect(await go(failing(2))).toEqual({ provenance: 'valid', software: 'unreadable', principal_binding: 'valid' });
    expect(await go(failing(4))).toEqual({ provenance: 'valid', software: 'valid', principal_binding: 'unreadable' });
  });

  it('is unreadable for a check that fails after an invalid one: the failed read is never read as invalid', async () => {
    let calls = 0;
    const rows = [row(idOf(0x1), { issuer_key_hash: PROVIDER_HASH, issued_at: T0 }), row(idOf(0x2), { issuer_key_hash: PROVIDER_HASH, issued_at: T0 - 1 })];
    const r = rig({ rows: { ...GOOD_ROWS, 1: rows }, ports: { check: () => (++calls === 1 ? Promise.resolve(false) : FAILURES['rejects with an error']()) } });
    expect((await go(r)).provenance).toBe('unreadable');
  });

  it('is unreadable for a check that fails before a valid one: the second row is never asked, so a failed read cannot be passed over', async () => {
    const rows = [row(idOf(0x1), { issuer_key_hash: PROVIDER_HASH, issued_at: T0 }), row(idOf(0x2), { issuer_key_hash: PROVIDER_HASH, issued_at: T0 - 1 })];
    const r = rig({ rows: { ...GOOD_ROWS, 1: rows }, ports: { check: (id) => (id === idOf(0x1) ? FAILURES['rejects with an error']() : Promise.resolve(true)) } });
    expect((await go(r)).provenance).toBe('unreadable');
    expect(r.calls.check.filter((call) => call.expect.attType === 1).map((call) => call.id)).toEqual([idOf(0x1)]);
  });

  it('does not stop the report: the binding is read after two Provider kinds that failed, and the Provider kinds before a binding that failed', async () => {
    expect(await go(rig({ ports: replacing('providerKeyHashOf', FAILURES['rejects with an error']) }))).toEqual({ provenance: 'unreadable', software: 'unreadable', principal_binding: 'valid' });
    expect(await go(rig({ ports: replacing('rootDelegatorOf', FAILURES['rejects with an error']) }))).toEqual({ provenance: 'valid', software: 'valid', principal_binding: 'unreadable' });
  });
});

describe('a port that answers with a value of the wrong type', () => {
  const GOOD = GOOD_ROWS[1][0];
  const WRONG: Readonly<Record<PortName, readonly unknown[]>> = {
    providerKeyHashOf: [undefined, 42, true, {}, [], 'not a key hash', '', PROVIDER_HASH.toUpperCase(), PROVIDER_HASH.slice(1), `${PROVIDER_HASH}00`],
    rootDelegatorOf: [
      undefined, 'key', 42, [], {}, { type: 'key' }, { type: 'key', hash: 5 }, { type: 'key', hash: 'zz' }, { type: 'key', hash: ROOT_HASH.toUpperCase() }, { type: 'key', id: MEMBER_ID },
      { type: 'key', hash: ROOT_HASH, id: MEMBER_ID }, { type: 'agent' }, { type: 'agent', id: ROOT_HASH }, { type: 'agent', hash: ROOT_HASH }, { type: 'agent', id: MEMBER_ID, hash: ROOT_HASH },
      { type: 'user', hash: ROOT_HASH },
    ],
    list: [
      undefined, null, 'rows', 7, {}, { 0: GOOD }, [null], ['row'], [GOOD, null], [{ ...GOOD, issued_at: '5' }], [{ ...GOOD, issued_at: Number.NaN }], [{ ...GOOD, issued_at: 1.5 }],
      [{ ...GOOD, id: 5 }], [{ ...GOOD, id: '' }], [{ ...GOOD, issuer_key_hash: undefined }], [{ ...GOOD, issuer_key_hash: 7 }], [{ ...GOOD, issuer_id: undefined }], [{ ...GOOD, issuer_id: 7 }],
    ],
    // A check that gives a truthy word, or a falsy one that is not false, is not a boolean: it never counts as true, and it is never an `invalid`.
    check: [undefined, null, 'true', 'yes', 'false', 1, 0, '', {}, { valid: true }, [true]],
  };
  const KINDS_OF: Readonly<Record<PortName, readonly Kind[]>> = { providerKeyHashOf: ['provenance', 'software'], rootDelegatorOf: ['principal_binding'], list: KIND_NAMES, check: KIND_NAMES };

  for (const port of ['providerKeyHashOf', 'rootDelegatorOf', 'list', 'check'] as const) {
    it.each(WRONG[port].map((value, index) => [index, value] as const))(`${port}: answer %# is unreadable for its kinds, and the other kinds are read as before`, async (_index, value) => {
      const report = await go(rig({ ports: replacing(port, () => Promise.resolve(value)) }));
      expect(report).toEqual(Object.fromEntries(KIND_NAMES.map((kind) => [kind, KINDS_OF[port].includes(kind) ? 'unreadable' : 'valid'])));
    });
  }

  it('reads no row of a list that has one wrong row: the good row next to it does not make the kind valid', async () => {
    const report = await go(rig({ ports: { list: (_subject, attType) => Promise.resolve(attType === 1 ? [GOOD, 'wrong' as never] : GOOD_ROWS[attType] ?? []) } }));
    expect(report.provenance).toBe('unreadable');
  });

  it('accepts the same values in their right type: the twin of each wrong answer', async () => {
    expect(await go(rig({ ports: { providerKeyHashOf: () => Promise.resolve(PROVIDER_HASH), rootDelegatorOf: () => Promise.resolve({ type: 'key', hash: ROOT_HASH }), check: () => Promise.resolve(true) } }))).toEqual(ALL_VALID);
    const agent = rig({ ports: { rootDelegatorOf: () => Promise.resolve({ type: 'agent', id: MEMBER_ID }), list: (_subject, attType) => Promise.resolve(attType === 4 ? [row(idOf(0x104), { issuer_id: MEMBER_ID })] : GOOD_ROWS[attType] ?? []) } });
    expect(await go(agent)).toEqual(ALL_VALID);
  });
});

describe('a stranger', () => {
  it('cannot make a kind valid, invalid or unreadable by adding rows: only rows of the expected issuer count', async () => {
    const strangers = Array.from({ length: 10 }, (_, n) => row(idOf(0x3000 + n), { issuer_key_hash: STRANGER_HASH, issued_at: T0 + n }));
    const r = rig({ rows: { 1: strangers, 2: strangers, 4: strangers }, valid: strangers.map((stranger) => stranger.id) });
    expect(await go(r)).toEqual({ provenance: 'absent', software: 'absent', principal_binding: 'absent' });
    expect(r.calls.check).toEqual([]);
  });

  it('is told apart by the issuer that each kind expects: a row of the Provider is no binding, and a row of the root delegator is no provenance', async () => {
    expect((await go(rig({ rows: { ...GOOD_ROWS, 4: [row(idOf(0x104), { issuer_key_hash: PROVIDER_HASH })] } }))).principal_binding).toBe('absent');
    expect((await go(rig({ rows: { ...GOOD_ROWS, 1: [row(idOf(0x101), { issuer_key_hash: ROOT_HASH })] } }))).provenance).toBe('absent');
    expect((await go(rig({ rows: { ...GOOD_ROWS, 2: [row(idOf(0x102), { issuer_key_hash: ROOT_HASH })] } }))).software).toBe('absent');
  });
});
