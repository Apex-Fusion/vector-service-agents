// The approval file of a session, the cap that it sets, and the net outflow of a transaction. Each refusal has an accepted twin. No test uses a real key, a real clock or the network.
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { enterpriseAddressOf } from '../../checks/lib/platform.ts';
import type { RingView } from '../../checks/lib/guards.ts';
import type { TxFacts } from '../../checks/lib/txfacts.ts';
import { DEPLOYMENT } from '../../checks/test/support/world.ts';
import { ApprovalError, Exposure, loadGo, lovelaceOfUnits, netRegistryOutflow, requireGo } from '../lib/approval.ts';
import type { ExposureEntry, GoFile } from '../lib/approval.ts';
import { makeTestKeys, removeTestKeys } from './support/keys.ts';

const folders: string[] = [];
afterAll(() => {
  removeTestKeys();
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

const keys = makeTestKeys(['run', 'fee', 'service'], { shared: ['run', 'fee'] });
const RUN = keys.registry.addressOf('run');
const NOW = Date.parse('2026-12-01T12:00:00Z');
const GO: GoFile = {
  approvedBy: 'a test approver', at: '2026-12-01T10:00:00Z', session: 'test-session', runWallet: RUN, capUnits: 10, tasks: ['fund', 'keys'], irreversible: ['record'], expiresAt: '2026-12-02T12:00:00Z',
};
const fileOf = (over: Partial<GoFile> = {}): GoFile => ({ ...GO, ...over });
const jsonOf = (over: Record<string, unknown> = {}): string => JSON.stringify({ ...GO, ...over });
/** A transaction hash for a test: 64 lower-case hex characters that always hold letters, so that its upper-case form is another text. Each n from 0 to 89 gives its own hash. */
const hashOf = (n: number): string => (0xa0 + (n % 90)).toString(16).repeat(32);
const modeOf = (path: string): number => statSync(path).mode & 0o777;
const refusal = (run: () => unknown): ApprovalError => {
  try { run(); } catch (err) { if (err instanceof ApprovalError) return err; throw err; }
  throw new Error('the call did not refuse');
};

/** A new folder with mode 700 in the temporary directory. */
function folder(): string {
  const dir = mkdtempSync(join(tmpdir(), 'operator-approval-'));
  chmodSync(dir, 0o700);
  folders.push(dir);
  return dir;
}
/** Writes an approval file (an object, or the text itself) with a mode, and gives its path. */
function writeGo(content: string, mode = 0o600): string {
  const path = join(folder(), 'GO.json');
  writeFileSync(path, content, { mode });
  chmodSync(path, mode);
  return path;
}
const load = (content: string, nowMs = NOW): GoFile => loadGo(writeGo(content), nowMs);

describe('lovelaceOfUnits', () => {
  const GOOD: [number, bigint][] = [[0, 0n], [0.000001, 1n], [0.1, 100_000n], [1.005, 1_005_000n], [100.5, 100_500_000n], [999.999999, 999_999_999n], [1000, 1_000_000_000n]];
  for (const [units, lovelace] of GOOD) {
    it(`gives ${lovelace} lovelace for ${units} units`, () => {
      expect(lovelaceOfUnits(units)).toBe(lovelace);
    });
  }
  const BAD: [string, number][] = [['a negative number', -0.000001], ['a number with 7 decimals', 0.0000001], ['a number above 1000', 1000.000001], ['1e21', 1e21], ['NaN', Number.NaN], ['infinity', Number.POSITIVE_INFINITY]];
  for (const [label, units] of BAD) {
    it(`refuses ${label}`, () => {
      expect(refusal(() => lovelaceOfUnits(units)).message).toContain('6 decimals');
    });
  }
  it('refuses a value that is not a number', () => {
    expect(() => lovelaceOfUnits('10' as unknown as number)).toThrow(ApprovalError);
  });
});

describe('loadGo', () => {
  it('loads a good file and gives each member as the file has it', () => {
    expect(load(jsonOf())).toEqual(GO);
    expect(load(JSON.stringify(GO, null, 4))).toEqual(GO);
  });

  it('loads the optional list of external addresses: absent, empty and with entries', () => {
    const entries = [{ label: 'stand-in', address: 'addr1qtest', units: 60 }, { label: 'member', address: 'addr1qother', units: 150.5 }];
    expect(load(jsonOf({ external: entries })).external).toEqual(entries);
    expect(load(jsonOf({ external: [] })).external).toEqual([]);
    expect(load(jsonOf()).external).toBeUndefined();
  });
  it('gives a file that no code can widen: the file, its lists and the entries of external are frozen', () => {
    const loaded = load(jsonOf({ external: [{ label: 'a', address: 'addr1qa', units: 1 }] }));
    expect(Object.isFrozen(loaded)).toBe(true);
    for (const list of [loaded.tasks, loaded.irreversible, loaded.external!]) expect(Object.isFrozen(list)).toBe(true);
    expect(Object.isFrozen(loaded.external![0])).toBe(true);
    expect(() => Array.prototype.push.call(loaded.tasks, 'register')).toThrow(TypeError);
    const writable: { capUnits: number } = loaded;
    expect(() => { writable.capUnits = 1000; }).toThrow(TypeError);
    expect(loaded.tasks).toEqual(['fund', 'keys']);
    expect(loaded.capUnits).toBe(10);
  });

  it('refuses a clock that is not a finite number, and accepts a clock that is', () => {
    for (const nowMs of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) expect(refusal(() => load(jsonOf(), nowMs)).message, String(nowMs)).toContain('clock');
    expect(load(jsonOf(), NOW).session).toBe('test-session');
  });


  describe('the file', () => {
    it('refuses a file with mode 644, 640, 400 or 700, and accepts mode 600', () => {
      for (const mode of [0o644, 0o640, 0o660, 0o666, 0o400, 0o700]) {
        const err = refusal(() => loadGo(writeGo(jsonOf(), mode), NOW));
        expect(err.message, mode.toString(8)).toContain(`mode ${mode.toString(8)}`);
        expect(err.message).toContain('mode 600');
      }
      expect(loadGo(writeGo(jsonOf(), 0o600), NOW).session).toBe('test-session');
    });
    it('refuses a file that is missing and a path that is a folder', () => {
      expect(refusal(() => loadGo(join(folder(), 'GO.json'), NOW)).message).toContain('does not exist');
      expect(refusal(() => loadGo(folder(), NOW)).message).toContain('not a file');
    });
    it('refuses a file that cannot be read, and the message holds the code of the system and nothing else of its error', () => {
      const path = writeGo(jsonOf());
      const err = refusal(() => loadGo(path, NOW, { read: () => { throw Object.assign(new Error(`EACCES: permission denied, open '${path}' with a secret`), { code: 'EACCES' }); } }));
      expect(err.message).toContain('EACCES');
      expect(err.message).not.toContain(path);
      expect(err.message).not.toContain('secret');
    });
    const NOT_JSON: [string, string][] = [
      ['an empty file', ''], ['text that is not JSON', 'approved'], ['an unfinished object', '{"approvedBy": "x"'], ['a trailing comma', `${jsonOf().slice(0, -1)},}`],
      ['a comment', `// approved\n${jsonOf()}`], ['a byte order mark', `\ufeff${jsonOf()}`],
    ];
    for (const [label, text] of NOT_JSON) {
      it(`refuses ${label}`, () => {
        expect(refusal(() => load(text)).message).toContain('not JSON');
      });
    }
    for (const [label, text] of [['null', 'null'], ['a list', '[]'], ['a text', '"x"'], ['a number', '5']] as const) {
      it(`refuses JSON that is ${label} and not an object`, () => {
        expect(refusal(() => load(text)).message).toContain('not a JSON object');
      });
    }
    it('refuses a member that appears twice, also when an escape spells its name, and accepts equal names in different objects', () => {
      const twice = `${jsonOf().slice(0, -1)},"capUnits":999}`;
      expect(refusal(() => load(twice)).message).toContain('capUnits');
      const escaped = `${jsonOf().slice(0, -1)},"cap\\u0055nits":999}`;
      expect(refusal(() => load(escaped)).message).toContain('capUnits');
      const entries = [{ label: 'one', address: 'addr1qa', units: 1 }, { label: 'two', address: 'addr1qb', units: 2 }];
      expect(load(jsonOf({ external: entries })).external).toHaveLength(2);
    });
  });

  describe('the members', () => {
    const REFUSED: [string, Record<string, unknown>, string][] = [
      ['an unknown member', { extra: 1 }, 'extra'],
      ['a member in the wrong case', { Session: 'x' }, 'Session'],
      ['no approvedBy', { approvedBy: undefined }, 'approvedBy'], ['an empty approvedBy', { approvedBy: '' }, 'approvedBy'], ['an approvedBy of spaces', { approvedBy: '   ' }, 'approvedBy'],
      ['an approvedBy that is a number', { approvedBy: 5 }, 'approvedBy'],
      ['no at', { at: undefined }, 'at'], ['an at that is not a time', { at: 'yesterday' }, 'at'], ['an at with no time of day', { at: '2026-12-01' }, 'at'],
      ['an at with a space', { at: '2026-12-01 10:00:00Z' }, 'at'], ['an at with no zone', { at: '2026-12-01T10:00:00' }, 'at'], ['an at on the 30th of February', { at: '2026-02-30T10:00:00Z' }, 'at'],
      ['an at at hour 24', { at: '2026-12-01T24:00:00Z' }, 'at'], ['an at at minute 60', { at: '2026-12-01T10:60:00Z' }, 'at'], ['an at at second 60', { at: '2026-12-01T10:00:60Z' }, 'at'],
      ['an at that is a number', { at: 1_700_000_000 }, 'at'], ['an at that is null', { at: null }, 'at'],
      ['no expiresAt', { expiresAt: undefined }, 'expiresAt'], ['an expiresAt that is not a time', { expiresAt: 'soon' }, 'expiresAt'], ['an expiresAt that is a number', { expiresAt: 1_800_000_000 }, 'expiresAt'],
      ['an expiresAt in the past', { expiresAt: '2026-12-01T11:59:59Z' }, 'expired'], ['an expiresAt at this moment', { expiresAt: '2026-12-01T12:00:00Z' }, 'expired'],
      ['an expiresAt at this moment in another zone', { expiresAt: '2026-12-01T13:00:00+01:00' }, 'expired'],
      ['no session', { session: undefined }, 'session'], ['an empty session', { session: '' }, 'session'], ['a session in upper case', { session: 'Test' }, 'session'],
      ['a session that starts with a hyphen', { session: '-test' }, 'session'], ['a session that is a path', { session: '../x' }, 'session'], ['a session of 49 characters', { session: 'a'.repeat(49) }, 'session'],
      ['a session that is a number', { session: 5 }, 'session'],
      ['no runWallet', { runWallet: undefined }, 'runWallet'], ['an empty runWallet', { runWallet: '' }, 'runWallet'], ['a runWallet that is no address', { runWallet: 'wallet' }, 'runWallet'],
      ['a runWallet in upper case', { runWallet: 'ADDR1QTEST' }, 'runWallet'], ['a runWallet with a space', { runWallet: 'addr1 qtest' }, 'runWallet'], ['a runWallet that is only the prefix', { runWallet: 'addr1' }, 'runWallet'],
      ['a runWallet that is a number', { runWallet: 5 }, 'runWallet'],
      ['no capUnits', { capUnits: undefined }, 'capUnits'], ['a negative cap', { capUnits: -1 }, 'capUnits'], ['a cap above 1000', { capUnits: 1000.000001 }, 'capUnits'],
      ['a cap of 1001', { capUnits: 1001 }, 'capUnits'], ['a cap with 7 decimals', { capUnits: 0.0000001 }, 'capUnits'], ['a cap of 1e21', { capUnits: 1e21 }, 'capUnits'],
      ['a cap that is text', { capUnits: '10' }, 'capUnits'], ['a cap that is null', { capUnits: null }, 'capUnits'],
      ['no tasks', { tasks: undefined }, 'tasks'], ['an empty list of tasks', { tasks: [] }, 'tasks'], ['tasks that are one text', { tasks: 'fund' }, 'tasks'], ['a task that is a number', { tasks: [5] }, 'tasks'],
      ['a task in upper case', { tasks: ['Fund'] }, 'tasks'], ['an empty task', { tasks: [''] }, 'tasks'], ['a task of 33 characters', { tasks: ['a'.repeat(33)] }, 'tasks'],
      ['65 tasks', { tasks: Array.from({ length: 65 }, (_, i) => `task-${i}`) }, 'tasks'],
      ['no irreversible', { irreversible: undefined }, 'irreversible'], ['an irreversible that is one text', { irreversible: 'record' }, 'irreversible'],
      ['a tag that is not in the list of tags', { irreversible: ['record', 'bogus'] }, 'irreversible'], ['a tag in upper case', { irreversible: ['Record'] }, 'irreversible'],
      ['a tag that is a number', { irreversible: [5] }, 'irreversible'],
      ['external that is not a list', { external: 'x' }, 'external'], ['external that is an object', { external: {} }, 'external'], ['an external entry that is a number', { external: [5] }, 'external'],
      ['an external entry that is null', { external: [null] }, 'external'],
      ['an external entry with an unknown member', { external: [{ label: 'a', address: 'addr1qa', units: 1, extra: 1 }] }, 'external'],
      ['an external entry with no label', { external: [{ address: 'addr1qa', units: 1 }] }, 'external'],
      ['an external label in upper case', { external: [{ label: 'A', address: 'addr1qa', units: 1 }] }, 'external'],
      ['an external label of 33 characters', { external: [{ label: 'a'.repeat(33), address: 'addr1qa', units: 1 }] }, 'external'],
      ['an external label that is empty', { external: [{ label: '', address: 'addr1qa', units: 1 }] }, 'external'],
      ['an external address that is no address', { external: [{ label: 'a', address: 'wallet', units: 1 }] }, 'external'],
      ['an external address with a space', { external: [{ label: 'a', address: 'addr1 qa', units: 1 }] }, 'external'],
      ['an external amount of 0', { external: [{ label: 'a', address: 'addr1qa', units: 0 }] }, 'external'],
      ['a negative external amount', { external: [{ label: 'a', address: 'addr1qa', units: -1 }] }, 'external'],
      ['an external amount that is text', { external: [{ label: 'a', address: 'addr1qa', units: '1' }] }, 'external'],
      ['an external amount with 7 decimals', { external: [{ label: 'a', address: 'addr1qa', units: 0.0000001 }] }, 'external'],
      ['an external amount above 1000', { external: [{ label: 'a', address: 'addr1qa', units: 1000.01 }] }, 'external'],
      ['two external entries with one label', { external: [{ label: 'a', address: 'addr1qa', units: 1 }, { label: 'a', address: 'addr1qb', units: 2 }] }, 'external'],
    ];
    for (const [label, over, field] of REFUSED) {
      it(`refuses ${label}, and the message names ${field}`, () => {
        expect(refusal(() => load(jsonOf(over))).message).toContain(field);
      });
    }

    const ACCEPTED: [string, Record<string, unknown>][] = [
      ['an approvedBy of one character', { approvedBy: 'd' }],
      ['an at with a zone offset', { at: '2026-12-01T11:00:00+01:00' }], ['an at with a fraction of a second', { at: '2026-12-01T10:00:00.5Z' }],
      ['an expiresAt one millisecond after this moment', { expiresAt: '2026-12-01T12:00:00.001Z' }], ['an expiresAt one second after this moment in another zone', { expiresAt: '2026-12-01T13:00:01+01:00' }],
      ['a session of one character', { session: 'a' }], ['a session of 48 characters', { session: 'a'.repeat(48) }], ['a session that starts with a digit', { session: '0-test' }],
      ['the runWallet unset', { runWallet: 'unset' }], ['a runWallet that is a short address text', { runWallet: 'addr1abc' }],
      ['a cap of 0', { capUnits: 0 }], ['a cap of one lovelace', { capUnits: 0.000001 }], ['a cap of 100.5', { capUnits: 100.5 }], ['a cap of 1000', { capUnits: 1000 }],
      ['one task', { tasks: ['fund'] }], ['a task with hyphens and digits', { tasks: ['end-state', 'stage-2'] }], ['64 tasks', { tasks: Array.from({ length: 64 }, (_, i) => `task-${i}`) }],
      ['no irreversible tags', { irreversible: [] }], ['all three tags', { irreversible: ['record', 'stake', 'attestation'] }],
      ['an empty external list', { external: [] }],
      ['an external entry with the least amount and the most', { external: [{ label: 'a', address: 'addr1qa', units: 0.000001 }, { label: 'b', address: 'addr1qb', units: 1000 }] }],
      ['an external label of 32 characters', { external: [{ label: 'a'.repeat(32), address: 'addr1qa', units: 1 }] }],
    ];
    for (const [label, over] of ACCEPTED) {
      it(`accepts ${label}`, () => {
        const loaded = load(jsonOf(over));
        for (const [member, value] of Object.entries(over)) expect(loaded[member as keyof GoFile]).toEqual(value);
      });
    }
    it('accepts an expiresAt that is the same moment as the clock plus one millisecond, and refuses it for a clock one millisecond later', () => {
      const text = jsonOf({ expiresAt: '2026-12-01T12:00:00.001Z' });
      expect(load(text, NOW).expiresAt).toBe('2026-12-01T12:00:00.001Z');
      expect(refusal(() => load(text, NOW + 1)).message).toContain('expired');
    });
    it('names the member of an unknown member only when it looks like a name, and never shows a value of the file', () => {
      expect(refusal(() => load(jsonOf({ 'a member with spaces and a secret value': 1 }))).message).not.toContain('secret');
      const MARK = 'MARKERVALUE';
      const withValue: Record<string, unknown>[] = [
        { extra: MARK }, { session: MARK }, { runWallet: MARK }, { at: MARK }, { expiresAt: MARK }, { tasks: [MARK] }, { irreversible: [MARK] }, { approvedBy: 5, capUnits: MARK },
        { external: [{ label: MARK, address: MARK, units: MARK }] },
      ];
      for (const over of withValue) expect(refusal(() => load(jsonOf(over))).message, JSON.stringify(over)).not.toContain(MARK);
    });
  });
});

describe('requireGo', () => {
  const NEED = { task: 'fund', runWallet: RUN, nowMs: NOW };

  it('gives the file back when it holds the task, the run wallet and every tag, and the file has not expired', () => {
    const go = fileOf({ irreversible: ['record', 'stake'] });
    expect(requireGo(go, NEED)).toBe(go);
    expect(requireGo(go, { ...NEED, irreversible: [] })).toBe(go);
    expect(requireGo(go, { ...NEED, irreversible: ['record'] })).toBe(go);
    expect(requireGo(go, { ...NEED, irreversible: ['stake', 'record'] })).toBe(go);
  });
  it('refuses a missing file and names the task', () => {
    const err = refusal(() => requireGo(null, NEED));
    expect(err.message).toContain('fund');
    expect(err.message).toContain('approval');
  });
  it('refuses a file that expired, at the moment that it ends and after it, and accepts one millisecond before', () => {
    const go = fileOf({ expiresAt: '2026-12-01T12:00:00Z' });
    expect(refusal(() => requireGo(go, NEED)).message).toContain('expired');
    expect(refusal(() => requireGo(go, { ...NEED, nowMs: NOW + 1 })).message).toContain('expired');
    expect(requireGo(go, { ...NEED, nowMs: NOW - 1 })).toBe(go);
  });
  it('refuses a clock that is not a finite number, and accepts a clock that is', () => {
    for (const nowMs of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) expect(refusal(() => requireGo(fileOf(), { ...NEED, nowMs })).message, String(nowMs)).toContain('clock');
    expect(requireGo(fileOf(), NEED).session).toBe('test-session');
  });
  it('refuses a file whose end is not a time', () => {
    for (const expiresAt of ['', 'soon', '2026-12-31', '2026-12-31T12:00:00']) expect(refusal(() => requireGo(fileOf({ expiresAt }), NEED)).message, expiresAt).toContain('expiresAt');
  });
  it('refuses another run wallet, and never shows a wallet', () => {
    const other = keys.registry.addressOf('fee');
    const err = refusal(() => requireGo(fileOf({ runWallet: other }), NEED));
    expect(err.message).toContain('run wallet');
    expect(err.message).not.toContain(other);
    expect(err.message).not.toContain(RUN);
    expect(requireGo(fileOf({ runWallet: RUN }), NEED).runWallet).toBe(RUN);
  });
  it('refuses a file that says unset when the run key exists', () => {
    expect(refusal(() => requireGo(fileOf({ runWallet: 'unset', tasks: ['keys'] }), { ...NEED, task: 'keys' })).message).toContain('unset');
  });
  it('refuses a task that the file does not list, and names it', () => {
    const err = refusal(() => requireGo(fileOf({ tasks: ['keys'] }), NEED));
    expect(err.message).toContain('fund');
    expect(err.message).toContain('tasks');
    expect(requireGo(fileOf({ tasks: ['keys', 'fund'] }), NEED).tasks).toContain('fund');
  });
  it('refuses a tag that the file does not list, names it, and checks every tag', () => {
    const go = fileOf({ irreversible: ['record'] });
    expect(refusal(() => requireGo(go, { ...NEED, irreversible: ['stake'] })).message).toContain('stake');
    expect(refusal(() => requireGo(go, { ...NEED, irreversible: ['record', 'attestation'] })).message).toContain('attestation');
    expect(refusal(() => requireGo(fileOf({ irreversible: [] }), { ...NEED, irreversible: ['record'] })).message).toContain('record');
    expect(refusal(() => requireGo(go, { ...NEED, irreversible: ['something-else'] })).message).toContain('something-else');
    expect(requireGo(fileOf({ irreversible: ['record', 'stake', 'attestation'] }), { ...NEED, irreversible: ['record', 'stake', 'attestation'] }).irreversible).toHaveLength(3);
  });

  describe('before the run key exists', () => {
    const FIRST = { task: 'keys', runWallet: null, nowMs: NOW };
    const UNSET = fileOf({ runWallet: 'unset', tasks: ['keys'] });
    it('accepts only the task keys with a file that says unset and lists keys', () => {
      expect(requireGo(UNSET, FIRST)).toBe(UNSET);
      expect(requireGo(fileOf({ runWallet: 'unset', tasks: ['fund', 'keys'] }), FIRST).tasks).toContain('keys');
    });
    it('refuses another task with the same file', () => {
      expect(refusal(() => requireGo(fileOf({ runWallet: 'unset', tasks: ['fund', 'keys'] }), { ...FIRST, task: 'fund' })).message).toContain('keys');
      expect(refusal(() => requireGo(UNSET, { ...FIRST, task: 'register' })).message).toContain('register');
    });
    it('refuses a file that names a wallet, because no run wallet exists yet', () => {
      expect(refusal(() => requireGo(fileOf({ runWallet: RUN, tasks: ['keys'] }), FIRST)).message).toContain('unset');
    });
    it('refuses a file that says unset and does not list the task keys', () => {
      expect(refusal(() => requireGo(fileOf({ runWallet: 'unset', tasks: ['fund'] }), FIRST)).message).toContain('keys');
    });
    it('refuses a missing file and an expired file', () => {
      expect(refusal(() => requireGo(null, FIRST)).message).toContain('keys');
      expect(refusal(() => requireGo({ ...UNSET, expiresAt: '2026-12-01T11:00:00Z' }, FIRST)).message).toContain('expired');
    });
  });

  it('never shows a value of the file beyond the task, the tag and the field', () => {
    const MARK = 'MARKERVALUE';
    const go = fileOf({ approvedBy: MARK, session: 'marker-session', tasks: ['keys'], irreversible: [] });
    for (const need of [{ ...NEED }, { ...NEED, task: 'keys', irreversible: ['stake'] }, { ...NEED, task: 'keys', runWallet: keys.registry.addressOf('fee') }, { ...NEED, task: 'keys', nowMs: NOW + 10 ** 12 }]) {
      const text = refusal(() => requireGo(go, need)).message;
      expect(text).not.toContain(MARK);
      expect(text).not.toContain('marker-session');
    }
  });
});

describe('Exposure', () => {
  const entryOf = (n: number, netLovelace: bigint, step = 'fund:float'): ExposureEntry => ({ step, txHash: hashOf(n), netLovelace, at: '2026-12-01T12:00:00.000Z' });
  /** A path for the file of a session in a new folder, and the instance over it. */
  function exposure(go: GoFile | null = fileOf(), io = {}) {
    const path = join(folder(), go === null ? 'exposure.none.json' : `exposure.${go.session}.json`);
    return { path, exposure: new Exposure(path, go, io), again: () => new Exposure(path, go) };
  }
  const shown = (path: string) => JSON.parse(readFileSync(path, 'utf8')) as { format: number; session: string; entries: { step: string; tx_hash: string; net_lovelace: string; at: string }[] };

  it('starts at zero when the file is not there, and writes nothing until the first reserve', () => {
    const { path, exposure: e } = exposure();
    expect(e.total()).toBe(0n);
    expect(e.projected(5n)).toBe(5n);
    expect(() => e.refuseOver(10_000_000n)).not.toThrow();
    expect(e.release(hashOf(1))).toBe(false);
    expect(() => statSync(path)).toThrow();
  });

  it('keeps each entry in a file of format 1 with mode 600: the step, the hash, the lovelace as text and the time', () => {
    const { path, exposure: e } = exposure();
    e.reserve(entryOf(1, 4_000_000n, 'fund:collateral'));
    e.reserve(entryOf(2, 3_000_000n));
    expect(shown(path)).toEqual({
      format: 1, session: 'test-session',
      entries: [
        { step: 'fund:collateral', tx_hash: hashOf(1), net_lovelace: '4000000', at: '2026-12-01T12:00:00.000Z' },
        { step: 'fund:float', tx_hash: hashOf(2), net_lovelace: '3000000', at: '2026-12-01T12:00:00.000Z' },
      ],
    });
    expect(modeOf(path)).toBe(0o600);
    expect(readFileSync(path, 'utf8').endsWith('}\n')).toBe(true);
  });

  it('sums across two instances that read the same file, in both directions', () => {
    const { exposure: a, again } = exposure();
    const b = again();
    a.reserve(entryOf(1, 4_000_000n));
    expect(b.total()).toBe(4_000_000n);
    b.reserve(entryOf(2, 3_000_000n));
    expect(a.total()).toBe(7_000_000n);
    expect(b.total()).toBe(7_000_000n);
    expect(a.projected(1_000_000n)).toBe(8_000_000n);
  });

  it('allows the cap exactly and refuses one lovelace more, with or without earlier entries', () => {
    const { exposure: e } = exposure(fileOf({ capUnits: 10 }));
    expect(e.cap()).toBe(10_000_000n);
    expect(() => e.refuseOver(10_000_000n)).not.toThrow();
    expect(refusal(() => e.refuseOver(10_000_001n)).message).toContain('cap');
    e.reserve(entryOf(1, 4_000_000n));
    expect(() => e.refuseOver(6_000_000n)).not.toThrow();
    expect(e.projected(6_000_000n)).toBe(10_000_000n);
    expect(() => e.refuseOver(6_000_001n)).toThrow(ApprovalError);
    expect(e.projected(6_000_001n)).toBe(10_000_001n);
  });

  it('refuses a reserve over the cap and appends nothing; a reserve under the cap appends, and another instance sees it', () => {
    const { path, exposure: e, again } = exposure(fileOf({ capUnits: 10 }));
    expect(() => e.reserve(entryOf(1, 10_000_001n))).toThrow(ApprovalError);
    expect(() => statSync(path)).toThrow();
    e.reserve(entryOf(1, 10_000_000n));
    expect(again().total()).toBe(10_000_000n);
    const before = readFileSync(path, 'utf8');
    expect(refusal(() => e.reserve(entryOf(2, 1n))).message).toContain('cap');
    expect(readFileSync(path, 'utf8')).toBe(before);
    expect(again().total()).toBe(10_000_000n);
  });

  it('removes the entry of the hash that it is given, and only that entry; another hash gives false and changes nothing', () => {
    const { path, exposure: e } = exposure();
    e.reserve(entryOf(1, 1_000_000n));
    e.reserve(entryOf(2, 2_000_000n));
    e.reserve(entryOf(3, 3_000_000n));
    const before = readFileSync(path, 'utf8');
    expect(e.release(hashOf(9))).toBe(false);
    expect(e.release('')).toBe(false);
    expect(e.release(hashOf(2).toUpperCase())).toBe(false);
    expect(readFileSync(path, 'utf8')).toBe(before);
    expect(e.release(hashOf(2))).toBe(true);
    expect(shown(path).entries.map((entry) => entry.tx_hash)).toEqual([hashOf(1), hashOf(3)]);
    expect(e.total()).toBe(4_000_000n);
    expect(e.release(hashOf(2))).toBe(false);
    expect(e.release(hashOf(1))).toBe(true);
    expect(e.release(hashOf(3))).toBe(true);
    expect(e.total()).toBe(0n);
    expect(shown(path).entries).toEqual([]);
  });

  it('gives the room of a released entry back to the cap', () => {
    const { exposure: e } = exposure(fileOf({ capUnits: 10 }));
    e.reserve(entryOf(1, 10_000_000n));
    expect(() => e.reserve(entryOf(2, 1n))).toThrow(ApprovalError);
    expect(e.release(hashOf(1))).toBe(true);
    expect(() => e.reserve(entryOf(2, 10_000_000n))).not.toThrow();
  });

  it('holds a cap of 0 as valid: it allows a net of 0 and refuses a net of one lovelace', () => {
    const { exposure: e } = exposure(fileOf({ capUnits: 0 }));
    expect(e.cap()).toBe(0n);
    expect(() => e.refuseOver(0n)).not.toThrow();
    expect(() => e.reserve(entryOf(1, 0n))).not.toThrow();
    expect(e.total()).toBe(0n);
    expect(() => e.refuseOver(1n)).toThrow(ApprovalError);
    expect(() => e.reserve(entryOf(2, 1n))).toThrow(ApprovalError);
    expect(e.total()).toBe(0n);
  });

  it('counts a cap of 100.5 units as 100,500,000 lovelace', () => {
    const { exposure: e } = exposure(fileOf({ capUnits: 100.5 }));
    expect(e.cap()).toBe(100_500_000n);
    expect(() => e.refuseOver(100_500_000n)).not.toThrow();
    expect(() => e.refuseOver(100_500_001n)).toThrow(ApprovalError);
  });

  it('refuses a cap that is not a whole number of lovelace, or not from 0 to 1000 units, when it is made', () => {
    const path = join(folder(), 'exposure.json');
    for (const capUnits of [0.0000001, -1, 1000.000001, Number.NaN, Number.POSITIVE_INFINITY]) expect(() => new Exposure(path, fileOf({ capUnits })), String(capUnits)).toThrow(ApprovalError);
    for (const capUnits of [0, 0.000001, 1000]) expect(() => new Exposure(path, fileOf({ capUnits })), String(capUnits)).not.toThrow();
  });

  it('refuses every amount when there is no approval, reserves nothing, and still tells the total of a file that is not there', () => {
    const { path, exposure: e } = exposure(null);
    expect(e.cap()).toBeNull();
    expect(refusal(() => e.refuseOver(0n)).message).toContain('approval');
    expect(refusal(() => e.refuseOver(1n)).message).toContain('approval');
    expect(refusal(() => e.reserve(entryOf(1, 0n))).message).toContain('approval');
    expect(e.total()).toBe(0n);
    expect(e.release(hashOf(1))).toBe(false);
    expect(() => statSync(path)).toThrow();
  });

  it('refuses a negative amount and an amount that is not a bigint, in every call that takes one', () => {
    const { path, exposure: e } = exposure();
    for (const bad of [-1n, 5 as unknown as bigint, '5' as unknown as bigint, null as unknown as bigint]) {
      expect(() => e.refuseOver(bad), String(bad)).toThrow(ApprovalError);
      expect(() => e.projected(bad), String(bad)).toThrow(ApprovalError);
      expect(() => e.reserve({ ...entryOf(1, 0n), netLovelace: bad }), String(bad)).toThrow(ApprovalError);
    }
    expect(() => statSync(path)).toThrow();
  });

  it('refuses an entry with an empty step, a hash that is not 64 lower-case hex characters, or a time that is not a time, and appends nothing', () => {
    const { path, exposure: e } = exposure();
    const base = entryOf(1, 1n);
    for (const bad of [{ step: '' }, { step: 'x'.repeat(201) }, { txHash: 'abc' }, { txHash: hashOf(1).toUpperCase() }, { txHash: `${hashOf(1)}0` }, { at: 'now' }, { at: '' }]) {
      expect(() => e.reserve({ ...base, ...bad }), JSON.stringify(bad)).toThrow(ApprovalError);
    }
    expect(() => statSync(path)).toThrow();
    e.reserve(base);
    expect(e.total()).toBe(1n);
  });

  it('takes a second reserve of one transaction with the same amount as the same entry, and refuses another amount for it', () => {
    const { path, exposure: e } = exposure();
    e.reserve(entryOf(1, 2_000_000n));
    const before = readFileSync(path, 'utf8');
    e.reserve({ ...entryOf(1, 2_000_000n), step: 'another-step' });
    expect(readFileSync(path, 'utf8')).toBe(before);
    expect(e.total()).toBe(2_000_000n);
    expect(refusal(() => e.reserve(entryOf(1, 2_000_001n))).message).toContain('another amount');
    expect(readFileSync(path, 'utf8')).toBe(before);
  });

  it('takes a repeated reserve of an entry that is already counted without a second check against the cap', () => {
    const { exposure: e } = exposure(fileOf({ capUnits: 10 }));
    e.reserve(entryOf(1, 10_000_000n));
    expect(() => e.reserve(entryOf(1, 10_000_000n))).not.toThrow();
    expect(e.total()).toBe(10_000_000n);
  });

  it('does not write when it only projects or checks', () => {
    const { path, exposure: e } = exposure();
    e.projected(1n);
    e.refuseOver(1n);
    e.total();
    expect(() => statSync(path)).toThrow();
  });

  it('keeps the old file when the write fails, and the failed reserve counts for nothing', () => {
    const { path, exposure: e } = exposure(fileOf(), { rename: () => { throw new Error('the rename failed'); } });
    expect(() => e.reserve(entryOf(1, 1n))).toThrow('the rename failed');
    expect(e.total()).toBe(0n);
    const ok = new Exposure(path, fileOf());
    ok.reserve(entryOf(1, 1n));
    const before = readFileSync(path, 'utf8');
    const failing = new Exposure(path, fileOf(), { rename: () => { throw new Error('the rename failed'); } });
    expect(() => failing.reserve(entryOf(2, 1n))).toThrow('the rename failed');
    expect(() => failing.release(hashOf(1))).toThrow('the rename failed');
    expect(readFileSync(path, 'utf8')).toBe(before);
    expect(ok.total()).toBe(1n);
  });

  describe('a damaged file', () => {
    const good = (over: Record<string, unknown> = {}): string => JSON.stringify({
      format: 1, session: 'test-session', entries: [{ step: 'fund:float', tx_hash: hashOf(1), net_lovelace: '1000000', at: '2026-12-01T12:00:00.000Z' }], ...over,
    });
    const entry = (over: Record<string, unknown>): string => good({ entries: [{ step: 'fund:float', tx_hash: hashOf(1), net_lovelace: '1000000', at: '2026-12-01T12:00:00.000Z', ...over }] });
    const DAMAGED: [string, string][] = [
      ['an empty file', ''], ['text that is not JSON', 'oops'], ['a list', '[]'], ['null', 'null'], ['a format of 2', good({ format: 2 })], ['a format that is text', good({ format: '1' })],
      ['no format', JSON.stringify({ session: 'test-session', entries: [] })], ['no entries', JSON.stringify({ format: 1, session: 'test-session' })], ['entries that are an object', good({ entries: {} })],
      ['another session', good({ session: 'other-session' })], ['no session', JSON.stringify({ format: 1, entries: [] })], ['a member that the file does not have', good({ extra: 1 })],
      ['an entry that is a number', good({ entries: [5] })], ['an entry that is null', good({ entries: [null] })], ['an entry with a member that it does not have', entry({ extra: 1 })],
      ['an entry with no step', entry({ step: undefined })], ['an entry with an empty step', entry({ step: '' })], ['an entry with no hash', entry({ tx_hash: undefined })],
      ['an entry with a short hash', entry({ tx_hash: 'abc' })], ['an entry with a hash in upper case', entry({ tx_hash: hashOf(1).toUpperCase() })],
      ['an entry with no amount', entry({ net_lovelace: undefined })], ['an amount that is a number', entry({ net_lovelace: 1_000_000 })], ['a negative amount', entry({ net_lovelace: '-5' })],
      ['an amount with a decimal point', entry({ net_lovelace: '1.5' })], ['an amount with a leading zero', entry({ net_lovelace: '01' })], ['an empty amount', entry({ net_lovelace: '' })],
      ['an amount in exponent form', entry({ net_lovelace: '1e3' })], ['an amount in hex', entry({ net_lovelace: 'ff' })], ['an entry with a time that is not a time', entry({ at: 'now' })],
      ['two entries with one hash', good({ entries: [
        { step: 'a', tx_hash: hashOf(1), net_lovelace: '1', at: '2026-12-01T12:00:00.000Z' }, { step: 'b', tx_hash: hashOf(1), net_lovelace: '2', at: '2026-12-01T12:00:00.000Z' },
      ] })],
    ];
    for (const [label, text] of DAMAGED) {
      it(`is an error and never zero for ${label}, in every call, and the file stays as it is`, () => {
        const { path, exposure: e } = exposure();
        writeFileSync(path, text, { mode: 0o600 });
        for (const call of [() => e.total(), () => e.projected(1n), () => e.refuseOver(1n), () => e.reserve(entryOf(2, 1n)), () => e.release(hashOf(1))]) {
          expect(refusal(call).message).toContain('damaged');
        }
        expect(readFileSync(path, 'utf8')).toBe(text);
      });
    }
    it('reads a good file, and the twin of each refusal is this file', () => {
      const { path, exposure: e } = exposure();
      writeFileSync(path, good(), { mode: 0o600 });
      expect(e.total()).toBe(1_000_000n);
      expect(() => e.reserve(entryOf(2, 1n))).not.toThrow();
      expect(e.total()).toBe(1_000_001n);
    });
    it('refuses a file with mode 644 and a path that is a folder, in every call', () => {
      const { path, exposure: e } = exposure();
      writeFileSync(path, good(), { mode: 0o644 });
      chmodSync(path, 0o644);
      expect(refusal(() => e.total()).message).toContain('mode 644');
      expect(refusal(() => e.reserve(entryOf(2, 1n))).message).toContain('mode 600');
      chmodSync(path, 0o600);
      expect(e.total()).toBe(1_000_000n);
      const folderPath = join(folder(), 'exposure.test-session.json');
      mkdirSync(folderPath);
      expect(refusal(() => new Exposure(folderPath, fileOf()).total()).message).toContain('damaged');
    });
  });
});

describe('netRegistryOutflow', () => {
  const ring = keys.registry.ring;
  const RUN_ADDRESS = keys.registry.addressOf('run');
  const FEE_ADDRESS = keys.registry.addressOf('fee');
  const SERVICE_ADDRESS = keys.registry.addressOf('service');
  const STRANGER = enterpriseAddressOf('ee'.repeat(28));
  const SCRIPT = DEPLOYMENT.delegation.address;
  const ref = (n: number, i = 0): string => `${hashOf(n)}#${i}`;
  const facts = (over: Partial<TxFacts> = {}): TxFacts => ({
    bodyHex: 'a4', txHash: hashOf(99), feeLovelace: 400_000n, validityEndSlot: null, inputs: [], collateralInputs: [], referenceInputs: [], outputs: [], collateralReturn: null, totalCollateral: null,
    requiredSigners: [], mint: {}, withdrawals: 0, certificates: 0, runsScripts: false, witnesses: [], ...over,
  });
  const outputs = (...list: [string, bigint][]): TxFacts['outputs'] => list.map(([address, lovelace], index) => ({ index, address, lovelace, assets: {}, inlineDatum: null, datumHash: null, hasScriptRef: false }));
  const spent = (...list: [string, string, bigint][]): Map<string, { address: string; lovelace: bigint }> => new Map(list.map(([reference, address, lovelace]) => [reference, { address, lovelace }]));

  it('uses the addresses of three different keys and a script address that no key owns', () => {
    expect(new Set([RUN_ADDRESS, FEE_ADDRESS, SERVICE_ADDRESS, STRANGER, SCRIPT]).size).toBe(5);
    expect(ring.has(keys.registry.hashOf('run'))).toBe(true);
  });

  it('counts only the fee for a transfer between two wallets of the ring', () => {
    const tx = facts({ inputs: [ref(1)], outputs: outputs([FEE_ADDRESS, 10_000_000n], [RUN_ADDRESS, 9_600_000n]) });
    expect(netRegistryOutflow(tx, spent([ref(1), RUN_ADDRESS, 20_000_000n]), ring)).toBe(400_000n);
  });

  it('counts a transfer to an address outside the ring in full, with the fee', () => {
    const tx = facts({ inputs: [ref(1)], outputs: outputs([STRANGER, 10_000_000n], [RUN_ADDRESS, 9_600_000n]) });
    expect(netRegistryOutflow(tx, spent([ref(1), RUN_ADDRESS, 20_000_000n]), ring)).toBe(10_400_000n);
  });

  it('counts a payment to a script address in full', () => {
    const tx = facts({ inputs: [ref(1)], outputs: outputs([SCRIPT, 5_000_000n], [RUN_ADDRESS, 14_600_000n]) });
    expect(netRegistryOutflow(tx, spent([ref(1), RUN_ADDRESS, 20_000_000n]), ring)).toBe(5_400_000n);
  });

  it('floors a negative net at 0: a withdrawal of rewards brings in more than the inputs hold', () => {
    const tx = facts({ inputs: [ref(1)], outputs: outputs([RUN_ADDRESS, 1_800_000n]), withdrawals: 1 });
    expect(netRegistryOutflow(tx, spent([ref(1), RUN_ADDRESS, 1_000_000n]), ring)).toBe(0n);
  });

  it('gives the difference for two inputs of two wallets and one output back to a third wallet', () => {
    const tx = facts({ inputs: [ref(1), ref(2)], outputs: outputs([SERVICE_ADDRESS, 14_500_000n]) });
    expect(netRegistryOutflow(tx, spent([ref(1), RUN_ADDRESS, 10_000_000n], [ref(2), FEE_ADDRESS, 5_000_000n]), ring)).toBe(500_000n);
  });

  it('adds the outputs that return to the ring, from several outputs, and the outputs that leave', () => {
    const tx = facts({ inputs: [ref(1)], outputs: outputs([RUN_ADDRESS, 1_000_000n], [FEE_ADDRESS, 2_000_000n], [SERVICE_ADDRESS, 3_000_000n], [STRANGER, 4_000_000n]) });
    expect(netRegistryOutflow(tx, spent([ref(1), RUN_ADDRESS, 10_500_000n]), ring)).toBe(4_500_000n);
  });

  it('does not count an input at a script address as an input of the ring', () => {
    const tx = facts({ inputs: [ref(1), ref(2)], outputs: outputs([STRANGER, 12_000_000n], [RUN_ADDRESS, 2_800_000n]) });
    expect(netRegistryOutflow(tx, spent([ref(1), RUN_ADDRESS, 10_000_000n], [ref(2), SCRIPT, 5_000_000n]), ring)).toBe(7_200_000n);
    const returned = facts({ inputs: [ref(2)], outputs: outputs([RUN_ADDRESS, 4_800_000n]) });
    expect(netRegistryOutflow(returned, spent([ref(2), SCRIPT, 5_000_000n]), ring)).toBe(0n);
  });

  it('does not count an input of a key that is not in the ring', () => {
    const tx = facts({ inputs: [ref(1)], outputs: outputs([RUN_ADDRESS, 9_000_000n]) });
    expect(netRegistryOutflow(tx, spent([ref(1), STRANGER, 10_000_000n]), ring)).toBe(0n);
  });

  it('counts an input at another address of a key of the ring, and counts an output to that address as leaving', () => {
    const base = baseAddressOf(keys.registry.hashOf('run'), 'dd'.repeat(28));
    expect(base).not.toBe(RUN_ADDRESS);
    const tx = facts({ inputs: [ref(1)], outputs: outputs([base, 9_600_000n]) });
    expect(netRegistryOutflow(tx, spent([ref(1), base, 10_000_000n]), ring)).toBe(10_000_000n);
    const home = facts({ inputs: [ref(1)], outputs: outputs([RUN_ADDRESS, 9_600_000n]) });
    expect(netRegistryOutflow(home, spent([ref(1), base, 10_000_000n]), ring)).toBe(400_000n);
  });

  it('refuses an input that is missing from the outputs that the node gave, and never counts it as zero', () => {
    const tx = facts({ inputs: [ref(1), ref(2)], outputs: outputs([RUN_ADDRESS, 14_600_000n]) });
    const err = refusal(() => netRegistryOutflow(tx, spent([ref(1), RUN_ADDRESS, 15_000_000n]), ring));
    expect(err.message).toContain(ref(2));
    expect(netRegistryOutflow(tx, spent([ref(1), RUN_ADDRESS, 15_000_000n], [ref(2), RUN_ADDRESS, 0n]), ring)).toBe(400_000n);
    expect(refusal(() => netRegistryOutflow(facts({ inputs: [ref(1)] }), new Map(), ring)).message).toContain(ref(1));
  });

  it('does not count collateral inputs and reference inputs, and does not need them in the map', () => {
    const tx = facts({ inputs: [ref(1)], collateralInputs: [ref(5)], referenceInputs: [ref(6)], outputs: outputs([RUN_ADDRESS, 9_600_000n]), collateralReturn: { address: RUN_ADDRESS, lovelace: 4_000_000n } });
    expect(netRegistryOutflow(tx, spent([ref(1), RUN_ADDRESS, 10_000_000n]), ring)).toBe(400_000n);
  });

  it('gives 0 for a transaction with no input and no output', () => {
    expect(netRegistryOutflow(facts(), new Map(), ring)).toBe(0n);
  });

  it('takes a ring that is any object with the key hashes, the wallets and a name for each key', () => {
    const view: RingView = { keyHashes: () => new Set([keys.registry.hashOf('run')]), wallets: () => new Map([[keys.registry.hashOf('run'), RUN_ADDRESS]]), roleOf: () => 'run' };
    const tx = facts({ inputs: [ref(1), ref(2)], outputs: outputs([RUN_ADDRESS, 1_000_000n]) });
    expect(netRegistryOutflow(tx, spent([ref(1), RUN_ADDRESS, 3_000_000n], [ref(2), FEE_ADDRESS, 7_000_000n]), view)).toBe(2_000_000n);
  });
});

/** A base address (mainnet) with a key payment part and a key stake part: bech32 of the header byte 1 and the two key hashes. */
function baseAddressOf(paymentHash: string, stakeHash: string): string {
  const bytes = Buffer.from(`01${paymentHash}${stakeHash}`, 'hex');
  const charset = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
  const generators = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  const polymod = (values: number[]): number => {
    let check = 1;
    for (const value of values) {
      const top = check >>> 25;
      check = ((check & 0x1ffffff) << 5) ^ value;
      for (let i = 0; i < 5; i++) if (((top >>> i) & 1) === 1) check ^= generators[i]!;
    }
    return check >>> 0;
  };
  const data: number[] = [];
  let accumulator = 0;
  let bits = 0;
  for (const byte of bytes) {
    accumulator = (accumulator << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      data.push((accumulator >> bits) & 31);
    }
    accumulator &= (1 << bits) - 1;
  }
  if (bits > 0) data.push((accumulator << (5 - bits)) & 31);
  const hrp = 'addr';
  const expanded = [...[...hrp].map((c) => c.charCodeAt(0) >>> 5), 0, ...[...hrp].map((c) => c.charCodeAt(0) & 31)];
  const mod = polymod([...expanded, ...data, 0, 0, 0, 0, 0, 0]) ^ 1;
  const checksum = [0, 1, 2, 3, 4, 5].map((i) => (mod >>> (5 * (5 - i))) & 31);
  return `${hrp}1${[...data, ...checksum].map((d) => charset[d]).join('')}`;
}
