// packages/usecase-kit/test/cosign/file-register.test.ts: the register of the signed bodies, on disk. Two questions. Does a restart lose a body that the agent signed, so that a second body gets the same
// delegation key? Can two calls race on the file? The register in memory and the register on disk run the same table of the contract. The route runs over the register on disk, across a restart and across a
// write that fails.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import * as disk from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { setImmediate as tick } from 'node:timers/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FileKeyRegister, KeyReservations, RESERVATION_MARGIN_MS } from '@vsa/usecase-kit/cosign';
import type { KeyClaim, KeyRegister, RegisterFs } from '@vsa/usecase-kit/cosign';
import { DELEG_A, bodyHashOf, build, deferred, harness, requestOf } from './support.ts';

const claim = (body: string, over: Partial<KeyClaim> = {}): KeyClaim => ({ keyHash: 'key-1', bodyHash: body, untilMs: 1_000, ...over });
const fault = (code: string): Error => Object.assign(new Error(`${code}: the disk fails`), { code });

// --- Folders and file system calls --------------------------------------------------------------------------------------------------------------------------------

const made: string[] = [];
afterEach(() => {
  for (const path of made.splice(0)) rmSync(path, { recursive: true, force: true });
});

/** A new folder below the system temp folder. The test ends with its removal. */
function tempFolder(): string {
  const path = mkdtempSync(join(tmpdir(), 'file-register-'));
  made.push(path);
  return path;
}

/** The path of the register file in a new folder. */
const newFile = (): string => join(tempFolder(), 'register.json');

/** The calls of the file system of the process, in the form of the port of the register. */
const real: RegisterFs = {
  readFile: (path) => disk.readFile(path, 'utf8'),
  writeFile: (path, text) => disk.writeFile(path, text, { flag: 'wx' }),
  rename: (from, to) => disk.rename(from, to),
  fsync: async (path) => {
    const handle = await disk.open(path, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  },
  unlink: (path) => disk.unlink(path),
};

interface Call {
  readonly call: string;
  readonly path: string;
  readonly to?: string;
}

/** The port over the real file system. Each call writes one `Call` to `calls` before it runs. A path is shown below `folder`, and the folder itself is ".". `over` replaces calls, and it gets the full path. */
function spied(folder: string, calls: Call[], over: Partial<RegisterFs> = {}): RegisterFs {
  const shown = (path: string): string => relative(folder, path) || '.';
  const port = { ...real, ...over };
  return {
    readFile: (path) => {
      calls.push({ call: 'readFile', path: shown(path) });
      return port.readFile(path);
    },
    writeFile: (path, text) => {
      calls.push({ call: 'writeFile', path: shown(path) });
      return port.writeFile(path, text);
    },
    rename: (from, to) => {
      calls.push({ call: 'rename', path: shown(from), to: shown(to) });
      return port.rename(from, to);
    },
    fsync: (path) => {
      calls.push({ call: 'fsync', path: shown(path) });
      return port.fsync(path);
    },
    unlink: (path) => {
      calls.push({ call: 'unlink', path: shown(path) });
      return port.unlink!(path);
    },
  };
}

/** An entry as the file holds it. */
interface OnDisk {
  readonly key_hash: string;
  readonly body_hash: string;
  readonly until_ms: number;
  readonly committed: boolean;
}

/** The entries in the register file, read the plain way. A file that is not there holds none. */
const entriesOn = (file: string): OnDisk[] => (existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as { entries: OnDisk[] }).entries : []);

const entry = (body: string, over: Partial<OnDisk> = {}): OnDisk => ({ key_hash: 'key-1', body_hash: body, until_ms: 1_000, committed: false, ...over });
const fileOf = (entries: OnDisk[]): string => `${JSON.stringify({ version: 1, entries })}\n`;

// --- The contract of the register ---------------------------------------------------------------------------------------------------------------------------------

/** A register and the number of entries that it holds. The table below is the table of the register in memory, and it runs against both. */
interface Subject {
  readonly register: KeyRegister;
  readonly size: () => number;
}

const SUBJECTS: Array<[string, () => Subject]> = [
  ['KeyReservations', () => { const register = new KeyReservations(); return { register, size: () => register.size }; }],
  ['FileKeyRegister', () => { const file = newFile(); return { register: new FileKeyRegister(file), size: () => entriesOn(file).length }; }],
];

describe.each(SUBJECTS)('%s keeps the contract of the register', (_name, make) => {
  describe('take', () => {
    it('takes a free key, takes it again for the same body, and refuses another body, also while the first body is not committed', async () => {
      const { register } = make();
      expect(await register.take(claim('body-1'), 0)).toBe('held');
      expect(await register.take(claim('body-2'), 0)).toBe('in_use');
      expect(await register.take(claim('body-1'), 0)).toBe('held');
      // The twin: another key is free.
      expect(await register.take(claim('body-2', { keyHash: 'key-2' }), 0)).toBe('held');
    });

    it('checks and writes in one step: of several bodies that come at one time for one key, one is held', async () => {
      const { register } = make();
      const results = await Promise.all([register.take(claim('body-1'), 0), register.take(claim('body-2'), 0), register.take(claim('body-3'), 0), register.take(claim('body-1'), 0)]);
      expect(results).toEqual(['held', 'in_use', 'in_use', 'held']);
    });

    it('does not change an entry that the same body takes again: it stays as committed as it was', async () => {
      const { register } = make();
      await register.commit(claim('body-1'), 0);
      expect(await register.take(claim('body-1'), 0)).toBe('held');
      await register.release(claim('body-1'));
      expect(await register.take(claim('body-2'), 0)).toBe('in_use');
    });
  });

  describe('commit', () => {
    it('makes the entry committed: another body is refused, and a release does not remove it', async () => {
      const { register, size } = make();
      await register.take(claim('body-1'), 0);
      expect(await register.commit(claim('body-1'), 0)).toBe('held');
      await register.release(claim('body-1'));
      expect(await register.take(claim('body-2'), 1)).toBe('in_use');
      expect(size()).toBe(1);
    });

    it('is the same compare-and-set: it makes the entry for a free key, it takes the same body again, and it refuses another body without a change', async () => {
      const { register } = make();
      expect(await register.commit(claim('body-1'), 0)).toBe('held');
      expect(await register.commit(claim('body-1'), 1)).toBe('held');
      expect(await register.commit(claim('body-2'), 1)).toBe('in_use');
      expect(await register.take(claim('body-1'), 1)).toBe('held');
      expect(await register.take(claim('body-2'), 1)).toBe('in_use');
    });

    it('makes the entry again when another request for the same body released it, and never takes the key from another body', async () => {
      const { register, size } = make();
      // Two requests for one body. The first one fails and releases, and the second one commits.
      await register.take(claim('body-1'), 0);
      await register.take(claim('body-1'), 0);
      await register.release(claim('body-1'));
      expect(size()).toBe(0);
      expect(await register.commit(claim('body-1'), 0)).toBe('held');
      expect(await register.take(claim('body-2'), 0)).toBe('in_use');
      // The release came, then another body took the key, and then the second request commits: it does not get the key.
      const other = make().register;
      await other.take(claim('body-1'), 0);
      await other.release(claim('body-1'));
      expect(await other.take(claim('body-2'), 0)).toBe('held');
      expect(await other.commit(claim('body-1'), 0)).toBe('in_use');
      expect(await other.commit(claim('body-2'), 0)).toBe('held');
    });
  });

  describe('the time of the hold', () => {
    it('lasts until `untilMs` and not after it, for an entry that is not committed and for one that is committed', async () => {
      for (const committed of [false, true]) {
        const { register } = make();
        await (committed ? register.commit(claim('body-1'), 0) : register.take(claim('body-1'), 0));
        expect(await register.take(claim('body-2'), 999), `committed ${committed}`).toBe('in_use');
        expect(await register.take(claim('body-2'), 1_000), `committed ${committed}`).toBe('held');
      }
    });

    it('is not shortened by a take of the same body at a later time', async () => {
      const { register } = make();
      await register.take(claim('body-1'), 0);
      await register.take(claim('body-1', { untilMs: 500 }), 400);
      expect(await register.take(claim('body-2'), 999)).toBe('in_use');
    });

    it('rejects a time that is not a number, and makes no entry, also for a key that is free', async () => {
      const { register, size } = make();
      for (const [untilMs, now] of [[Number.NaN, 0], [1_000, Number.NaN], [Infinity, 0]] as const) {
        await expect(register.take(claim('body-1', { untilMs }), now)).rejects.toThrow(RangeError);
        await expect(register.commit(claim('body-1', { untilMs }), now)).rejects.toThrow(RangeError);
      }
      expect(size()).toBe(0);
      await register.commit(claim('body-1'), 0);
      await expect(register.take(claim('body-2'), Number.NaN)).rejects.toThrow(RangeError);
      expect(await register.take(claim('body-2'), 1)).toBe('in_use');
    });
  });

  describe('release', () => {
    it('removes the entry of its own body that is not committed', async () => {
      const { register, size } = make();
      await register.take(claim('body-1'), 0);
      await register.release(claim('body-1'));
      expect(size()).toBe(0);
      expect(await register.take(claim('body-2'), 0)).toBe('held');
    });

    it('does not remove the entry of another body, and does not remove a committed entry', async () => {
      const { register, size } = make();
      await register.take(claim('body-1'), 0);
      await register.release(claim('body-2'));
      expect(await register.take(claim('body-3'), 0)).toBe('in_use');
      await register.commit(claim('body-1'), 0);
      await register.release(claim('body-1'));
      expect(await register.take(claim('body-3'), 0)).toBe('in_use');
      expect(size()).toBe(1);
    });

    it('does not let an old release drop the entry of a newer body', async () => {
      const { register } = make();
      await register.take(claim('body-1'), 0);
      expect(await register.take(claim('body-2', { untilMs: 5_000 }), 2_000)).toBe('held');
      await register.release(claim('body-1'));
      expect(await register.take(claim('body-3', { untilMs: 5_000 }), 2_001)).toBe('in_use');
    });

    it('is no error for a key that has no entry, and a second call does no harm', async () => {
      const { register, size } = make();
      await expect(register.release(claim('body-1'))).resolves.toBeUndefined();
      await register.take(claim('body-1'), 0);
      await register.release(claim('body-1'));
      await expect(register.release(claim('body-1'))).resolves.toBeUndefined();
      expect(size()).toBe(0);
    });
  });
});

// --- The entries on disk ------------------------------------------------------------------------------------------------------------------------------------------

describe('the register on disk keeps its entries over a restart', () => {
  it('holds the key for a committed entry in a NEW instance on the same path, until `untilMs`', async () => {
    const file = newFile();
    expect(await new FileKeyRegister(file).commit(claim('body-1'), 0)).toBe('held');
    const restarted = new FileKeyRegister(file);
    expect(await restarted.take(claim('body-2'), 999)).toBe('in_use');
    expect(await restarted.commit(claim('body-2'), 999)).toBe('in_use');
    await restarted.release(claim('body-1'));
    expect(await new FileKeyRegister(file).take(claim('body-2'), 999)).toBe('in_use');
    // The same body gets the same answer again. The key is free at `untilMs`, and the file keeps the new body.
    expect(await new FileKeyRegister(file).take(claim('body-1'), 999)).toBe('held');
    expect(await new FileKeyRegister(file).take(claim('body-2'), 1_000)).toBe('held');
    expect(entriesOn(file)).toEqual([entry('body-2')]);
  });

  it('holds the key for an entry that was taken and not committed, too: a key that is held too long never gives a second body', async () => {
    const file = newFile();
    await new FileKeyRegister(file).take(claim('body-1'), 0);
    const restarted = new FileKeyRegister(file);
    expect(await restarted.take(claim('body-2'), 1)).toBe('in_use');
    // A release of the same body frees the key, as in memory.
    await restarted.release(claim('body-1'));
    expect(await new FileKeyRegister(file).take(claim('body-2'), 1)).toBe('held');
  });

  it('writes JSON data only: the hash of the key, the hash of the body, the end of the hold, and the committed flag of each entry', async () => {
    const file = newFile();
    const register = new FileKeyRegister(file);
    const key = '0b'.repeat(28);
    const body = 'c4'.repeat(32);
    await register.commit({ keyHash: key, bodyHash: body, untilMs: 1_800_000_000_000 }, 5);
    await register.take({ keyHash: '0c'.repeat(28), bodyHash: 'c5'.repeat(32), untilMs: 1_800_000_000_500 }, 5);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
      version: 1,
      entries: [
        { key_hash: key, body_hash: body, until_ms: 1_800_000_000_000, committed: true },
        { key_hash: '0c'.repeat(28), body_hash: 'c5'.repeat(32), until_ms: 1_800_000_000_500, committed: false },
      ],
    });
    expect(readdirSync(join(file, '..'))).toEqual(['register.json']);
  });

  it('drops an entry whose time has come when it reads it, and writes the file without it', async () => {
    const file = newFile();
    const register = new FileKeyRegister(file);
    await register.commit(claim('body-1', { untilMs: 1_000 }), 0);
    await register.take(claim('body-2', { keyHash: 'key-2', untilMs: 9_000 }), 0);
    expect(entriesOn(file).map((one) => one.key_hash)).toEqual(['key-1', 'key-2']);
    // At 1,000 the entry of key-1 has ended: the next write leaves it out.
    expect(await register.take(claim('body-3', { keyHash: 'key-3', untilMs: 9_000 }), 1_000)).toBe('held');
    expect(entriesOn(file).map((one) => one.key_hash)).toEqual(['key-2', 'key-3']);
    // The key of the ended entry is free for another body, and a body that held it before is a stranger now.
    expect(await register.take(claim('body-4', { untilMs: 9_000 }), 1_000)).toBe('held');
    expect(await register.take(claim('body-1', { untilMs: 9_000 }), 1_000)).toBe('in_use');
    // The twin: an entry that has not ended stays in the file.
    expect(entriesOn(file).map((one) => one.key_hash)).toEqual(['key-2', 'key-3', 'key-1']);
  });

  it('treats a file that is not there as a register with no entries, and makes the file at the first write', async () => {
    const file = newFile();
    const register = new FileKeyRegister(file);
    await register.release(claim('body-1'));
    expect(existsSync(file)).toBe(false);
    expect(await register.take(claim('body-1'), 0)).toBe('held');
    expect(existsSync(file)).toBe(true);
  });

  it('writes nothing for a call that changes nothing', async () => {
    const folder = tempFolder();
    const file = join(folder, 'register.json');
    const calls: Call[] = [];
    const register = new FileKeyRegister(file, { fs: spied(folder, calls) });
    await register.take(claim('body-1'), 0);
    calls.length = 0;
    expect(await register.take(claim('body-1'), 1)).toBe('held');
    expect(await register.take(claim('body-2'), 1)).toBe('in_use');
    expect(await register.commit(claim('body-2'), 1)).toBe('in_use');
    await register.release(claim('body-2'));
    expect(calls.map((one) => one.call)).toEqual(['readFile', 'readFile', 'readFile', 'readFile']);
  });
});

// --- A damaged file -----------------------------------------------------------------------------------------------------------------------------------------------

describe('a file that cannot be used is an error, and never a free key', () => {
  const GOOD = [entry('body-1', { committed: true })];
  const DAMAGED: Array<[string, string]> = [
    ['an empty file', ''],
    ['text that is not JSON', 'register'],
    ['a file that is cut', fileOf(GOOD).slice(0, 30)],
    ['JSON null', 'null'],
    ['a JSON array', '[]'],
    ['a version that is not 1', JSON.stringify({ version: 2, entries: GOOD })],
    ['no version', JSON.stringify({ entries: GOOD })],
    ['a member that the file does not have', JSON.stringify({ version: 1, entries: GOOD, note: 'x' })],
    ['entries that are not a list', JSON.stringify({ version: 1, entries: {} })],
    ['an entry that is not an object', JSON.stringify({ version: 1, entries: ['key-1'] })],
    ['an entry with no body hash', JSON.stringify({ version: 1, entries: [{ key_hash: 'key-1', until_ms: 1_000, committed: true }] })],
    ['an entry with a member that it does not have', JSON.stringify({ version: 1, entries: [{ ...GOOD[0], note: 'x' }] })],
    ['an entry with a key hash that is not text', JSON.stringify({ version: 1, entries: [{ ...GOOD[0], key_hash: 1 }] })],
    ['an entry with an empty key hash', JSON.stringify({ version: 1, entries: [{ ...GOOD[0], key_hash: '' }] })],
    ['an entry with a body hash that is not text', JSON.stringify({ version: 1, entries: [{ ...GOOD[0], body_hash: null }] })],
    ['an entry with an end that is a text', JSON.stringify({ version: 1, entries: [{ ...GOOD[0], until_ms: '1000' }] })],
    ['an entry with an end that is null', JSON.stringify({ version: 1, entries: [{ ...GOOD[0], until_ms: null }] })],
    ['an entry with a committed flag that is a number', JSON.stringify({ version: 1, entries: [{ ...GOOD[0], committed: 1 }] })],
    ['two entries for one key', JSON.stringify({ version: 1, entries: [...GOOD, entry('body-2')] })],
  ];

  it.each(DAMAGED)('makes take, commit and release throw for %s, and leaves the file as it is', async (_name, text) => {
    const file = newFile();
    writeFileSync(file, text);
    const register = new FileKeyRegister(file);
    await expect(register.take(claim('body-1'), 0)).rejects.toThrow();
    await expect(register.take(claim('body-2'), 0)).rejects.toThrow();
    await expect(register.commit(claim('body-1'), 0)).rejects.toThrow();
    await expect(register.release(claim('body-1'))).rejects.toThrow();
    expect(readFileSync(file, 'utf8')).toBe(text);
    expect(readdirSync(join(file, '..'))).toEqual(['register.json']);
  });

  it('reads a file that is whole, as the twin of the damaged files', async () => {
    const file = newFile();
    writeFileSync(file, fileOf(GOOD));
    const register = new FileKeyRegister(file);
    expect(await register.take(claim('body-1'), 0)).toBe('held');
    expect(await register.take(claim('body-2'), 0)).toBe('in_use');
    expect(await register.commit(claim('body-1'), 0)).toBe('held');
  });

  it('throws when the file is damaged after the instance used it, because each call reads the file', async () => {
    const file = newFile();
    const register = new FileKeyRegister(file);
    expect(await register.commit(claim('body-1'), 0)).toBe('held');
    writeFileSync(file, 'cut');
    await expect(register.take(claim('body-2'), 0)).rejects.toThrow();
    await expect(register.release(claim('body-1'))).rejects.toThrow();
  });

  it('throws when the file cannot be read, and for a folder at the place of the file, and treats only a missing file as free', async () => {
    const folder = tempFolder();
    for (const code of ['EACCES', 'EIO', 'EISDIR', 'ENOTDIR']) {
      const register = new FileKeyRegister(join(folder, 'register.json'), { fs: { readFile: async () => { throw fault(code); } } });
      await expect(register.take(claim('body-1'), 0), code).rejects.toThrow(code);
      await expect(register.commit(claim('body-1'), 0), code).rejects.toThrow(code);
      await expect(register.release(claim('body-1')), code).rejects.toThrow(code);
    }
    const asFolder = join(folder, 'as-folder.json');
    mkdirSync(asFolder);
    await expect(new FileKeyRegister(asFolder).take(claim('body-1'), 0)).rejects.toThrow();
    const missing = new FileKeyRegister(join(folder, 'register.json'), { fs: { readFile: async () => { throw fault('ENOENT'); } } });
    expect(await missing.take(claim('body-1'), 0)).toBe('held');
  });

  const BAD_CLAIMS: Array<[string, Partial<Record<keyof KeyClaim, unknown>>]> = [
    ['an empty key hash', { keyHash: '' }],
    ['a key hash that is not text', { keyHash: 7 }],
    ['no key hash', { keyHash: undefined }],
    ['an empty body hash', { bodyHash: '' }],
    ['a body hash that is not text', { bodyHash: null }],
    ['no body hash', { bodyHash: undefined }],
  ];

  it.each(BAD_CLAIMS)('refuses a claim with %s, makes no file, and does not make the next call fail', async (_name, over) => {
    const file = newFile();
    const register = new FileKeyRegister(file);
    const bad = { ...claim('body-1'), ...over } as KeyClaim;
    await expect(register.take(bad, 0)).rejects.toThrow();
    await expect(register.commit(bad, 0)).rejects.toThrow();
    await expect(register.release(bad)).rejects.toThrow();
    expect(existsSync(file)).toBe(false);
    expect(await register.take(claim('body-1'), 0)).toBe('held');
  });
});

// --- A write is whole or it is not there, and it ends before the call does -----------------------------------------------------------------------------------------

describe('a write is whole, or it is not there', () => {
  it('writes a temporary file in the same folder, syncs it, renames it over the register file, and syncs the folder, for each call that changes the file', async () => {
    const folder = tempFolder();
    const file = join(folder, 'register.json');
    const calls: Call[] = [];
    const register = new FileKeyRegister(file, { fs: spied(folder, calls) });
    const TEMPORARY = /^\.register\.json\.[0-9a-f]{16}\.tmp$/;
    const sequence = (): void => {
      const [read, write, sync, move, syncFolder, ...rest] = calls;
      expect(read).toEqual({ call: 'readFile', path: 'register.json' });
      expect(write!.call).toBe('writeFile');
      expect(write!.path).toMatch(TEMPORARY);
      expect(sync).toEqual({ call: 'fsync', path: write!.path });
      expect(move).toEqual({ call: 'rename', path: write!.path, to: 'register.json' });
      expect(syncFolder).toEqual({ call: 'fsync', path: '.' });
      expect(rest).toEqual([]);
      calls.length = 0;
    };
    // A take of a free key, a commit of the same body, and a release of another body's entry: each one writes the file.
    expect(await register.take(claim('body-1'), 0)).toBe('held');
    sequence();
    expect(await register.commit(claim('body-1'), 0)).toBe('held');
    sequence();
    expect(await register.commit(claim('body-1'), 1)).toBe('held');
    sequence();
    await register.release(claim('body-2', { keyHash: 'key-2' }));
    expect(calls.map((one) => one.call)).toEqual(['readFile']);
    calls.length = 0;
    expect(await register.take(claim('body-3', { keyHash: 'key-3' }), 0)).toBe('held');
    await register.release(claim('body-3', { keyHash: 'key-3' }));
    expect(entriesOn(file).map((one) => one.key_hash)).toEqual(['key-1']);
  });

  it('does not settle a commit before the write of the temporary file has ended, and the file holds no entry until then', async () => {
    const folder = tempFolder();
    const file = join(folder, 'register.json');
    const gate = deferred<void>();
    const calls: Call[] = [];
    const register = new FileKeyRegister(file, { fs: spied(folder, calls, { writeFile: async (path, text) => { await gate.promise; return real.writeFile(path, text); } }) });
    let settled = false;
    const pending = register.commit(claim('body-1'), 0).then((result) => { settled = true; return result; });
    await vi.waitFor(() => expect(calls.map((one) => one.call)).toContain('writeFile'));
    await tick();
    await tick();
    expect(settled).toBe(false);
    expect(entriesOn(file)).toEqual([]);
    gate.resolve();
    expect(await pending).toBe('held');
    expect(entriesOn(file)).toEqual([entry('body-1', { committed: true })]);
  });

  it('does not settle a commit before the folder is synced, and the file holds the committed entry by then', async () => {
    const folder = tempFolder();
    const file = join(folder, 'register.json');
    const gate = deferred<void>();
    const calls: Call[] = [];
    const register = new FileKeyRegister(file, { fs: spied(folder, calls, { fsync: async (path) => { if (path === folder) await gate.promise; return real.fsync(path); } }) });
    let settled = false;
    const pending = register.commit(claim('body-1'), 0).then((result) => { settled = true; return result; });
    await vi.waitFor(() => expect(calls.at(-1)).toEqual({ call: 'fsync', path: '.' }));
    await tick();
    expect(settled).toBe(false);
    expect(entriesOn(file)).toEqual([entry('body-1', { committed: true })]);
    gate.resolve();
    expect(await pending).toBe('held');
  });

  describe('a failure before the rename leaves the old file whole, and removes the temporary file', () => {
    const STEPS: Array<[string, Partial<RegisterFs>]> = [
      ['the write of the temporary file, after a part of it was written', { writeFile: async (path) => { await disk.writeFile(path, '{"version":'); throw fault('ENOSPC'); } }],
      ['the sync of the temporary file', { fsync: async () => { throw fault('EIO'); } }],
      ['the rename', { rename: async () => { throw fault('EIO'); } }],
    ];

    it.each(STEPS)('after a failure of %s, a commit rejects, and the entry is not committed', async (_name, over) => {
      const folder = tempFolder();
      const file = join(folder, 'register.json');
      expect(await new FileKeyRegister(file).take(claim('body-1'), 0)).toBe('held');
      const failing = new FileKeyRegister(file, { fs: over });
      await expect(failing.commit(claim('body-1'), 0)).rejects.toThrow();
      expect(readdirSync(folder)).toEqual(['register.json']);
      expect(entriesOn(file)).toEqual([entry('body-1')]);
      // The entry is as it was: the same body frees it with a release. The twin: a commit over the file system that works lands.
      expect(await new FileKeyRegister(file).commit(claim('body-1'), 0)).toBe('held');
      expect(entriesOn(file)).toEqual([entry('body-1', { committed: true })]);
    });

    it.each(STEPS)('after a failure of %s, a commit for a key with no entry leaves no file', async (_name, over) => {
      const folder = tempFolder();
      const failing = new FileKeyRegister(join(folder, 'register.json'), { fs: over });
      await expect(failing.commit(claim('body-1'), 0)).rejects.toThrow();
      await expect(failing.take(claim('body-1'), 0)).rejects.toThrow();
      expect(readdirSync(folder)).toEqual([]);
    });

    it('gives the error of the file system, also when the removal of the temporary file fails too', async () => {
      const folder = tempFolder();
      const register = new FileKeyRegister(join(folder, 'register.json'), { fs: { rename: async () => { throw fault('EIO'); }, unlink: async () => { throw fault('EPERM'); } } });
      await expect(register.commit(claim('body-1'), 0)).rejects.toThrow('EIO');
    });
  });

  it('rejects a commit when the folder cannot be synced, because the entry is not known to be stored for good', async () => {
    const folder = tempFolder();
    const file = join(folder, 'register.json');
    const register = new FileKeyRegister(file, { fs: { fsync: async (path) => { if (path === folder) throw fault('EIO'); return real.fsync(path); } } });
    await expect(register.commit(claim('body-1'), 0)).rejects.toThrow('EIO');
    // The rename was done before: the key stays held for the body, so the key is never given to a second body.
    expect(await new FileKeyRegister(file).take(claim('body-2'), 0)).toBe('in_use');
  });

  it('goes on with the next call after a call failed', async () => {
    const folder = tempFolder();
    let calls = 0;
    const register = new FileKeyRegister(join(folder, 'register.json'), { fs: { rename: async (from, to) => { calls += 1; if (calls === 1) throw fault('EIO'); return real.rename(from, to); } } });
    const lost = register.commit(claim('body-1'), 0);
    const next = register.commit(claim('body-1'), 0);
    await expect(lost).rejects.toThrow('EIO');
    expect(await next).toBe('held');
  });
});

// --- Two calls ----------------------------------------------------------------------------------------------------------------------------------------------------

describe('two calls never race on the file', () => {
  it('holds exactly one body when 50 calls come at one time for one key', async () => {
    const file = newFile();
    const register = new FileKeyRegister(file);
    const results = await Promise.all(Array.from({ length: 50 }, (_, index) => register.take(claim(`body-${index}`), 0)));
    expect(results.filter((result) => result === 'held')).toHaveLength(1);
    expect(results[0]).toBe('held');
    expect(results.slice(1).every((result) => result === 'in_use')).toBe(true);
    expect(entriesOn(file)).toEqual([entry('body-0')]);
  });

  it('holds exactly one body when 50 takes and commits of different bodies come at one time, and gives the same answer to the same body', async () => {
    const file = newFile();
    const register = new FileKeyRegister(file);
    const calls = Array.from({ length: 50 }, (_, index) => (index % 2 === 0 ? register.take(claim(`body-${index}`), 0) : register.commit(claim(`body-${index}`), 0)));
    const results = await Promise.all(calls);
    expect(results.filter((result) => result === 'held')).toHaveLength(1);
    expect(entriesOn(file)).toEqual([entry('body-0')]);
    const same = await Promise.all(Array.from({ length: 50 }, () => register.commit(claim('body-0'), 0)));
    expect(same.every((result) => result === 'held')).toBe(true);
    expect(entriesOn(file)).toEqual([entry('body-0', { committed: true })]);
  });

  it('loses no entry when 50 calls come at one time for 50 keys', async () => {
    const file = newFile();
    const register = new FileKeyRegister(file);
    const keys = Array.from({ length: 50 }, (_, index) => `key-${index}`);
    const results = await Promise.all(keys.map((key) => register.commit(claim('body-1', { keyHash: key }), 0)));
    expect(results.every((result) => result === 'held')).toBe(true);
    expect(entriesOn(file).map((one) => one.key_hash)).toEqual(keys);
    expect(entriesOn(file).every((one) => one.committed)).toBe(true);
  });

  it('does not start a call before the call in front of it has ended', async () => {
    const folder = tempFolder();
    const file = join(folder, 'register.json');
    const gate = deferred<void>();
    const calls: Call[] = [];
    let writes = 0;
    const register = new FileKeyRegister(file, {
      fs: spied(folder, calls, { writeFile: async (path, text) => { writes += 1; if (writes === 1) await gate.promise; return real.writeFile(path, text); } }),
    });
    const first = register.take(claim('body-1'), 0);
    const second = register.take(claim('body-2', { keyHash: 'key-2' }), 0);
    await vi.waitFor(() => expect(calls.map((one) => one.call)).toContain('writeFile'));
    await tick();
    await tick();
    // The first call waits at its write. The second call has not read the file yet.
    expect(calls.filter((one) => one.call === 'readFile')).toHaveLength(1);
    gate.resolve();
    expect(await Promise.all([first, second])).toEqual(['held', 'held']);
    expect(entriesOn(file).map((one) => one.key_hash)).toEqual(['key-1', 'key-2']);
  });
});

// --- The construction ---------------------------------------------------------------------------------------------------------------------------------------------

describe('the construction of the register', () => {
  it('takes a path in a folder that exists, and makes no file and no folder', () => {
    const folder = tempFolder();
    expect(() => new FileKeyRegister(join(folder, 'register.json'))).not.toThrow();
    expect(readdirSync(folder)).toEqual([]);
  });

  const PATHS: Array<[string, (folder: string) => string]> = [
    ['a ".." segment in the middle', (folder) => `${folder}/sub/../register.json`],
    ['a ".." segment at the end', (folder) => `${folder}/register.json/..`],
    ['a relative path with a ".." segment', (folder) => `${relative(process.cwd(), folder)}/sub/../register.json`],
    ['a ".." segment after a backslash', (folder) => `${folder}\\..\\register.json`],
    ['an empty path', () => ''],
    ['a NUL character', (folder) => `${folder}/register\0.json`],
  ];

  it.each(PATHS)('refuses a path with %s, and touches nothing', (_name, make) => {
    const folder = tempFolder();
    expect(() => new FileKeyRegister(make(folder))).toThrow();
    expect(readdirSync(folder)).toEqual([]);
  });

  it('refuses a path that is not text', () => {
    for (const value of [7, null, undefined, {}, ['a']]) expect(() => new FileKeyRegister(value as never), String(value)).toThrow(TypeError);
  });

  it('refuses a folder that is missing, and does not make it', () => {
    const folder = tempFolder();
    expect(() => new FileKeyRegister(join(folder, 'state', 'register.json'))).toThrow();
    expect(existsSync(join(folder, 'state'))).toBe(false);
  });

  it('refuses a folder that is a file, and leaves the file as it is', () => {
    const folder = tempFolder();
    const file = join(folder, 'file');
    writeFileSync(file, 'x');
    expect(() => new FileKeyRegister(join(file, 'register.json'))).toThrow();
    expect(readFileSync(file, 'utf8')).toBe('x');
    expect(statSync(file).isFile()).toBe(true);
  });

  it.skipIf(process.getuid?.() === 0)('refuses a folder that cannot be written, and takes it again when it can be', () => {
    const folder = tempFolder();
    const locked = join(folder, 'locked');
    mkdirSync(locked);
    chmodSync(locked, 0o500);
    try {
      expect(() => new FileKeyRegister(join(locked, 'register.json'))).toThrow();
    } finally {
      chmodSync(locked, 0o700);
    }
    expect(() => new FileKeyRegister(join(locked, 'register.json'))).not.toThrow();
  });
});

// --- The route over the register on disk --------------------------------------------------------------------------------------------------------------------------

describe('the route over the register on disk', () => {
  const OTHER_BODY = { resources: [`script:${'be'.repeat(28)}`] };

  it('keeps the key for the body that it signed after a restart: a second body is refused, and the same body is signed again', async () => {
    const file = newFile();
    const first = await build();
    const second = await build(OTHER_BODY);
    const before = harness({ register: new FileKeyRegister(file) });
    expect((await before.route.cosign(requestOf(first.hex))).ok).toBe(true);
    expect(entriesOn(file)).toEqual([{ key_hash: DELEG_A.keyHash, body_hash: bodyHashOf(first.hex), until_ms: first.hi + RESERVATION_MARGIN_MS, committed: true }]);
    // The service starts again: a new route, and a new register on the same file.
    const after = harness({ register: new FileKeyRegister(file) });
    expect(await after.route.cosign(requestOf(second.hex))).toMatchObject({ ok: false, code: 'key_in_use' });
    expect(after.signed).toEqual([]);
    expect((await after.route.cosign(requestOf(first.hex))).ok).toBe(true);
  });

  it('sends no signature when the rename of the commit fails, and leaves the key free for another body', async () => {
    const file = newFile();
    const first = await build();
    const second = await build(OTHER_BODY);
    // The renames of one request: the take, the commit, and the release of the take after the failed commit.
    let renames = 0;
    const register = new FileKeyRegister(file, { fs: { rename: async (from, to) => { renames += 1; if (renames === 2) throw fault('EIO'); return real.rename(from, to); } } });
    const failing = harness({ register });
    const result = await failing.route.cosign(requestOf(first.hex));
    expect(result).toMatchObject({ ok: false, code: 'check_unavailable' });
    expect(JSON.stringify(result)).not.toMatch(/transaction|EIO|disk|register\.json/);
    expect(renames).toBe(3);
    expect(entriesOn(file)).toEqual([]);
    // The key is free: the other body gets it, and the file keeps that body.
    expect((await harness({ register }).route.cosign(requestOf(second.hex))).ok).toBe(true);
    expect(entriesOn(file)).toEqual([{ key_hash: DELEG_A.keyHash, body_hash: bodyHashOf(second.hex), until_ms: second.hi + RESERVATION_MARGIN_MS, committed: true }]);
  });

  it('is check_unavailable for a damaged file, and signs nothing', async () => {
    const file = newFile();
    const { hex } = await build();
    writeFileSync(file, 'cut');
    const h = harness({ register: new FileKeyRegister(file) });
    const result = await h.route.cosign(requestOf(hex));
    expect(result).toMatchObject({ ok: false, code: 'check_unavailable' });
    expect(h.signed).toEqual([]);
    // The twin: a register on a folder with no file signs.
    expect((await harness({ register: new FileKeyRegister(newFile()) }).route.cosign(requestOf(hex))).ok).toBe(true);
  });
});
