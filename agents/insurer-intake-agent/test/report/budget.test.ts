// agents/insurer-intake-agent/test/report/budget.test.ts: the time of the report, what it does when it is broken, and what it writes to the log. The report has 45 seconds for the whole run and 15 seconds for one
// read, both on the clock of its dependencies, and a kind that the time cuts off is `unreadable`. The report never throws. The log line of each kind has the word and the number of rows, and no value of an
// attestation. The clock is a fake that the test moves, so a read that never answers costs no real time. Each refusal has an accepted twin.
import { describe, expect, it } from 'vitest';
import { ATTESTATION_STATES } from '@vsa/usecase-kit/priorauth';
import { READ_BUDGET_MS, REPORT_BUDGET_MS, reportAttestations } from '../../src/report/index.ts';
import type { ReportDeps } from '../../src/report/index.ts';
import {
  ALL_VALID, DELEGATION, FAILURES, GOOD_IDS, GOOD_ROWS, INPUT, MEMBER_ID, PROVIDER_HASH, ROOT_HASH, SENDER, STRANGER_HASH, T0, go, idOf, replacing, rig, row, spent,
} from './support.ts';
import type { Rig } from './support.ts';

const ALL_UNREADABLE = { provenance: 'unreadable', software: 'unreadable', principal_binding: 'unreadable' };
const SECOND = 1_000;

describe('the budgets', () => {
  it('are 45 seconds for the whole report and 15 seconds for one read', () => {
    expect(REPORT_BUDGET_MS).toBe(45 * SECOND);
    expect(READ_BUDGET_MS).toBe(15 * SECOND);
  });

  it('cost no time when every port answers at once, and leave no timer on the clock', async () => {
    const r = rig();
    expect(await go(r)).toEqual(ALL_VALID);
    expect(spent(r)).toBe(0);
    expect(r.clock.waiting).toBe(0);
  });
});

describe('a list that never answers', () => {
  it('ends inside the budget of the report on the fake clock, and each kind that was cut off is unreadable', async () => {
    const r = rig({ ports: replacing('list', FAILURES['never answers']) });
    expect(await go(r)).toEqual(ALL_UNREADABLE);
    expect(spent(r)).toBeLessThanOrEqual(REPORT_BUDGET_MS);
    expect(spent(r)).toBe(3 * READ_BUDGET_MS);
    expect(r.calls.list.map((call) => call.attType)).toEqual([1, 2, 4]);
    expect(r.clock.waiting).toBe(0);
  });

  it('is cut off by the read budget of 15 seconds, not later: a list that answers after 14.999 seconds counts, and one that answers after 15.001 seconds does not', async () => {
    const inside = rig({ takes: { list: READ_BUDGET_MS - 1 } });
    expect(await go(inside)).toEqual(ALL_VALID);
    expect(spent(inside)).toBe(3 * (READ_BUDGET_MS - 1));
    const late = rig({ takes: { list: READ_BUDGET_MS + 1 } });
    expect(await go(late)).toEqual(ALL_UNREADABLE);
    expect(spent(late)).toBe(3 * READ_BUDGET_MS);
  });

  it('costs only its own kind: a slow list for one type leaves the other kinds valid, and the report spends 15 seconds', async () => {
    const r: Rig = rig({ ports: { list: async (_subject, attType) => { if (attType === 2) await r.clock.sleep(READ_BUDGET_MS + 1); return GOOD_ROWS[attType] ?? []; } } });
    expect(await go(r)).toEqual({ provenance: 'valid', software: 'unreadable', principal_binding: 'valid' });
    expect(spent(r)).toBe(READ_BUDGET_MS);
  });
});

describe('the budget of the whole report', () => {
  it('cuts off the kind that is running and the kinds that are not done, starts no read after the end, and ends at 45 seconds', async () => {
    // Each read takes 14 seconds, which is inside the budget of one read. The first kind has two attestations that do not check: the Provider, the list and two checks need 56 seconds.
    const rows = [row(idOf(0x1), { issuer_key_hash: PROVIDER_HASH, issued_at: T0 }), row(idOf(0x2), { issuer_key_hash: PROVIDER_HASH, issued_at: T0 - 1 })];
    const r = rig({ rows: { ...GOOD_ROWS, 1: rows }, valid: [], takes: { provider: 14 * SECOND, list: 14 * SECOND, check: 14 * SECOND, root: 14 * SECOND } });
    expect(await go(r)).toEqual(ALL_UNREADABLE);
    expect(spent(r)).toBe(REPORT_BUDGET_MS);
    expect(r.calls.provider.length).toBe(1);
    expect(r.calls.list.map((call) => call.attType)).toEqual([1]);
    expect(r.calls.check.length).toBe(2);
    expect(r.calls.root).toEqual([]);
  });

  it('keeps the word of a kind that was done before the end, and cuts off only the kinds after it', async () => {
    const r = rig({ takes: { list: 14 * SECOND, check: 14 * SECOND, root: 14 * SECOND } });
    expect(await go(r)).toEqual({ provenance: 'valid', software: 'unreadable', principal_binding: 'unreadable' });
    expect(spent(r)).toBe(REPORT_BUDGET_MS);
    expect(r.calls.root).toEqual([]);
  });

  it('gives a read that starts near the end only the time that is left: it is cut at the end of the report, and not at the end of its own 15 seconds', async () => {
    const r = rig({ takes: { provider: READ_BUDGET_MS - 1, list: READ_BUDGET_MS - 1 } });
    expect(await go(r)).toEqual({ provenance: 'valid', software: 'valid', principal_binding: 'unreadable' });
    expect(spent(r)).toBe(REPORT_BUDGET_MS);
  });

  it('is not spent by quick reads: eight reads of 5 seconds are valid, and the report spends the sum', async () => {
    const r = rig({ takes: { provider: 5 * SECOND, list: 5 * SECOND, check: 5 * SECOND, root: 5 * SECOND } });
    expect(await go(r)).toEqual(ALL_VALID);
    expect(spent(r)).toBe(8 * 5 * SECOND);
  });
});

describe('a Provider read that never answers', () => {
  it('costs 15 seconds once for the two Provider kinds, and the binding is read as before', async () => {
    const r = rig({ ports: replacing('providerKeyHashOf', FAILURES['never answers']) });
    expect(await go(r)).toEqual({ provenance: 'unreadable', software: 'unreadable', principal_binding: 'valid' });
    expect(spent(r)).toBe(READ_BUDGET_MS);
    expect(r.calls.provider).toEqual([SENDER]);
  });
});

describe('a report that is given a broken clock, broken ports or a broken input', () => {
  const wordsOf = (report: object): string[] => Object.values(report);

  it('gives only the four words, and never throws, whatever a port throws: an error, a text, null, undefined, a number', async () => {
    for (const thrown of [new Error('x'), 'x', null, undefined, 5, { message: 'x' }]) {
      const r = rig({ ports: { list: () => Promise.reject(thrown), providerKeyHashOf: () => { throw thrown; }, rootDelegatorOf: () => Promise.reject(thrown), check: () => Promise.reject(thrown) } });
      const report = await go(r);
      expect(Object.keys(report)).toEqual(['provenance', 'software', 'principal_binding']);
      expect(wordsOf(report)).toEqual(['unreadable', 'unreadable', 'unreadable']);
    }
  });

  it('is unreadable for the kinds of a port that is missing or that is no function, and every word is one of the four', async () => {
    const { deps } = rig();
    for (const broken of [{ list: undefined }, { check: 'check' }, { providerKeyHashOf: null }, { rootDelegatorOf: 5 }]) {
      const report = await reportAttestations({ ...deps, ...broken } as never, INPUT);
      for (const word of wordsOf(report)) expect(ATTESTATION_STATES as readonly string[]).toContain(word);
      expect(wordsOf(report)).toContain('unreadable');
    }
    expect(await reportAttestations({ ...deps, list: undefined } as never, INPUT)).toEqual(ALL_UNREADABLE);
    expect(await reportAttestations({ ...deps, providerKeyHashOf: undefined } as never, INPUT)).toEqual({ provenance: 'unreadable', software: 'unreadable', principal_binding: 'valid' });
    expect(await reportAttestations({ ...deps, rootDelegatorOf: undefined } as never, INPUT)).toEqual({ provenance: 'valid', software: 'valid', principal_binding: 'unreadable' });
  });

  it('is not changed by a log that throws', async () => {
    const { deps } = rig();
    expect(await reportAttestations({ ...deps, log: () => { throw new Error('the log failed'); } }, INPUT)).toEqual(ALL_VALID);
  });

  it('is unreadable for every kind when the clock throws, gives no time, or cannot sleep', async () => {
    const { deps } = rig();
    const sleep = deps.clock.sleep.bind(deps.clock);
    const clocks = [
      { now: () => { throw new Error('no time'); }, sleep },
      { now: () => Number.NaN, sleep },
      { now: () => Number.POSITIVE_INFINITY, sleep },
      { now: () => T0, sleep: () => { throw new Error('no sleep'); } },
    ];
    for (const clock of clocks) expect(await reportAttestations({ ...deps, clock } as ReportDeps, INPUT)).toEqual(ALL_UNREADABLE);
  });

  it('is unreadable for every kind when the dependencies or the input are missing', async () => {
    expect(await reportAttestations(undefined as never, INPUT)).toEqual(ALL_UNREADABLE);
    expect(await reportAttestations(null as never, INPUT)).toEqual(ALL_UNREADABLE);
    expect(await reportAttestations({} as never, INPUT)).toEqual(ALL_UNREADABLE);
    expect(await reportAttestations(rig().deps, undefined as never)).toEqual(ALL_UNREADABLE);
    expect(await reportAttestations(rig().deps, null as never)).toEqual(ALL_UNREADABLE);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1, 1.5, '5', null, undefined, 2 ** 53])(
    'is unreadable for every kind and reads nothing when the time of the check is %s: a time that is no whole number would read as a time that is always in force',
    async (atMs) => {
      const r = rig();
      expect(await go(r, { ...INPUT, atMs: atMs as never })).toEqual(ALL_UNREADABLE);
      expect(r.calls.provider).toEqual([]);
      expect(r.calls.list).toEqual([]);
      expect(r.calls.check).toEqual([]);
      expect(r.calls.root).toEqual([]);
    },
  );

  it('reads with the time zero: a whole number that is not negative is a time', async () => {
    expect(await go(rig(), { ...INPUT, atMs: 0 })).toEqual(ALL_VALID);
  });
});

describe('the log', () => {
  const PREFIX = 'attestation report: ';

  it('has one line for each kind, in order, with the word and the number of rows that the kind looked at', async () => {
    const r = rig();
    await go(r);
    expect(r.calls.lines).toEqual([`${PREFIX}provenance valid rows=1`, `${PREFIX}software valid rows=1`, `${PREFIX}principal_binding valid rows=1`]);
  });

  it('counts the rows of the list, also the rows of other issuers, and counts none for a kind that read no list', async () => {
    const strangers = [row(idOf(0x2001)), row(idOf(0x2002)), row(idOf(0x2003))];
    const r = rig({ rows: { ...GOOD_ROWS, 4: [...strangers, ...GOOD_ROWS[4]] }, provider: null });
    await go(r);
    expect(r.calls.lines).toEqual([`${PREFIX}provenance absent rows=0`, `${PREFIX}software absent rows=0`, `${PREFIX}principal_binding valid rows=4`]);
  });

  it('gives the cause of an unreadable kind as a fixed word: a failure, a read that did not answer, a wrong type, a root that is null, a spent budget, a bad input', async () => {
    const linesOf = async (r: Rig, input = INPUT): Promise<string> => { await go(r, input); return r.calls.lines.join('\n'); };
    expect(await linesOf(rig({ ports: replacing('providerKeyHashOf', FAILURES['rejects with an error']) }))).toContain(`${PREFIX}provenance unreadable rows=0 why=read_failed`);
    expect(await linesOf(rig({ ports: replacing('providerKeyHashOf', FAILURES['never answers']) }))).toContain(`${PREFIX}provenance unreadable rows=0 why=read_timeout`);
    expect(await linesOf(rig({ ports: replacing('providerKeyHashOf', () => Promise.resolve(42)) }))).toContain(`${PREFIX}provenance unreadable rows=0 why=bad_answer`);
    expect(await linesOf(rig({ root: null }))).toContain(`${PREFIX}principal_binding unreadable rows=0 why=no_root`);
    expect(await linesOf(rig({ takes: { list: 14 * SECOND, check: 14 * SECOND, root: 14 * SECOND } }))).toContain(`${PREFIX}principal_binding unreadable rows=0 why=report_budget`);
    expect(await linesOf(rig(), { ...INPUT, atMs: Number.NaN })).toContain(`${PREFIX}provenance unreadable rows=0 why=bad_input`);
  });

  it('counts the rows of a kind whose check failed', async () => {
    const r = rig({ ports: replacing('check', FAILURES['rejects with an error']) });
    await go(r);
    expect(r.calls.lines[0]).toBe(`${PREFIX}provenance unreadable rows=1 why=read_failed`);
  });

  it('holds no value of an attestation, of the request or of a failed read: no id, key hash, record id, DID, delegation or text of an error', async () => {
    const secret = 'https://koios.example/api/v1/credential_utxos?key=secret-token-123';
    const rows = [
      row(idOf(0x7001), { issuer_key_hash: PROVIDER_HASH, issuer_id: MEMBER_ID, issued_at: T0 }),
      row(idOf(0x7002), { issuer_key_hash: STRANGER_HASH, issuer_id: idOf(0x7777), issued_at: T0 - 1 }),
    ];
    const worlds = [
      rig({ rows: { 1: rows, 2: rows, 4: rows } }),
      rig({ rows: { 1: rows, 2: rows, 4: rows }, valid: [], root: { type: 'agent', id: MEMBER_ID } }),
      rig({ ports: { list: () => Promise.reject(new TypeError(`fetch failed: ${secret}`)), providerKeyHashOf: () => Promise.reject(new Error(secret)), rootDelegatorOf: () => Promise.reject(new Error(secret)) } }),
      rig({ ports: { check: () => Promise.reject(new Error(secret)) } }),
    ];
    const values = [
      idOf(0x7001), idOf(0x7002), idOf(0x7777), PROVIDER_HASH, ROOT_HASH, STRANGER_HASH, MEMBER_ID, SENDER, SENDER.slice('did:vector:'.length), DELEGATION, secret, 'secret-token-123', 'koios', ...GOOD_IDS,
    ];
    for (const r of worlds) {
      await go(r);
      const text = r.calls.lines.join('\n');
      expect(r.calls.lines.length).toBe(3);
      for (const value of values) expect(text.includes(value), `a line holds ${value.slice(0, 12)}`).toBe(false);
      for (const line of r.calls.lines) expect(line).toMatch(/^attestation report: (provenance|software|principal_binding) (valid|invalid|absent|unreadable) rows=\d+( why=[a-z_]+)?$/);
    }
  });
});
