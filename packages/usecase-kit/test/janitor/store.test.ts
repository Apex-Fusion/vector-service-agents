// packages/usecase-kit/test/janitor/store.test.ts: the list of left sub-delegations, in memory and on disk. Each refusal has an accepted twin. The tests write in a temporary folder and remove it. The review
// question: does a restart lose an entry, does a failed write leave half an entry, and is a damaged entry ever skipped in silence?
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DamagedLeftEntriesError, FileLeftStore, MemoryLeftStore, nodeLeftFs, parseLeftEntry } from '../../src/janitor/index.ts';
import type { LeftEntry, LeftFs, LeftStore } from '../../src/janitor/index.ts';
import type { LeftSubDelegation } from '../../src/access/index.ts';

const ID_A = 'a1'.repeat(32);
const ID_B = 'b2'.repeat(32);
const ID_C = 'c3'.repeat(32);
const KEY = '11'.repeat(28);
const TX = 'd1'.repeat(32);
const UNDELEGATE_TX = 'e1'.repeat(32);

/** The members of a type with no `readonly`: a test changes what it gave to a store, or what a store gave to it, to see that the store keeps its own copy. */
type Writable<T> = { -readonly [K in keyof T]: T[K] };

/** A left sub-delegation as `withSubDelegation` gives it, and the key of the agent that signs its Undelegate. */
function entry(id = ID_A, over: Partial<LeftSubDelegation> = {}, signer = KEY): LeftEntry {
  return {
    left: {
      id, parent: 'aa'.repeat(32), action: 'erp.stock.read', resource: 'https://mock.example/t/run1/erp', delegateTxHash: TX, delegateValidTo: 1_790_000_000_000, delegateTtlSlot: 33_000_000,
      notAfter: 1_790_003_600_000, endTxHash: null, ...over,
    },
    signer_key_hash: signer,
  };
}

let dir = '';
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'left-store-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

interface Spy {
  readonly fs: LeftFs;
  /** One line for each call of the port, with what it touched: `dir`, `tmp` (a temporary file), `entry` (the file of an id) or `other`. */
  readonly calls: string[];
  /** Every path that the port was given. */
  readonly paths: string[];
}

/** The port of the disk with a note of each call, and with the calls of `over` in place of the real ones. */
function spy(over: Partial<LeftFs> = {}): Spy {
  const calls: string[] = [];
  const paths: string[] = [];
  const kind = (path: string): string => (path === dir ? 'dir' : path.endsWith('.tmp') ? 'tmp' : path.endsWith('.json') ? 'entry' : 'other');
  const base: LeftFs = { ...nodeLeftFs, ...over };
  const note = (name: string, ...touched: string[]): void => {
    calls.push(`${name} ${touched.map(kind).join(' ')}`);
    paths.push(...touched);
  };
  const fs: LeftFs = {
    mkdir: (path) => (note('mkdir', path), base.mkdir(path)),
    readdir: (path) => (note('readdir', path), base.readdir(path)),
    readFile: (path) => (note('readFile', path), base.readFile(path)),
    writeFile: (path, text) => (note('writeFile', path), base.writeFile(path, text)),
    fsync: (path) => (note('fsync', path), base.fsync(path)),
    rename: (from, to) => (note('rename', from, to), base.rename(from, to)),
    unlink: (path) => (note('unlink', path), base.unlink(path)),
  };
  return { fs, calls, paths };
}

const fail = (what: string) => async (): Promise<never> => {
  throw new Error(what);
};

const idsOf = (entries: readonly LeftEntry[]): string[] => entries.map((e) => e.left.id);

/** The error that `list` throws for a damaged file. The test fails when `list` does not throw, or throws another error. */
async function damagedError(store: LeftStore): Promise<DamagedLeftEntriesError> {
  try {
    await store.list();
  } catch (error) {
    if (error instanceof DamagedLeftEntriesError) return error;
    throw error;
  }
  throw new Error('list did not throw');
}

describe.each<[string, () => LeftStore]>([
  ['MemoryLeftStore', () => new MemoryLeftStore()],
  ['FileLeftStore', () => new FileLeftStore(dir)],
])('%s', (_name, make) => {
  it('lists nothing when nothing was put', async () => {
    expect(await make().list()).toStrictEqual([]);
  });

  it('lists what was put, with the same members', async () => {
    const store = make();
    await store.put(entry(ID_A));
    await store.put(entry(ID_B, { endTxHash: UNDELEGATE_TX }, '22'.repeat(28)));
    expect(await store.list()).toStrictEqual([entry(ID_A), entry(ID_B, { endTxHash: UNDELEGATE_TX }, '22'.repeat(28))]);
  });

  it('replaces the entry of an id that it has: a later end attempt updates endTxHash, and no second entry is made', async () => {
    const store = make();
    await store.put(entry(ID_A));
    await store.put(entry(ID_B));
    await store.put(entry(ID_A, { endTxHash: UNDELEGATE_TX }));
    const listed = await store.list();
    expect(idsOf(listed)).toStrictEqual([ID_A, ID_B]);
    expect(listed[0]).toStrictEqual(entry(ID_A, { endTxHash: UNDELEGATE_TX }));
  });

  it('removes the entry of an id and keeps the others', async () => {
    const store = make();
    await store.put(entry(ID_A));
    await store.put(entry(ID_B));
    await store.remove(ID_A);
    expect(idsOf(await store.list())).toStrictEqual([ID_B]);
  });

  it('takes the removal of an id that is not there as no error, and the removal of an id that is there as the twin', async () => {
    const store = make();
    await expect(store.remove(ID_C)).resolves.toBeUndefined();
    await store.put(entry(ID_A));
    await expect(store.remove(ID_C)).resolves.toBeUndefined();
    expect(idsOf(await store.list())).toStrictEqual([ID_A]);
    await expect(store.remove(ID_A)).resolves.toBeUndefined();
    await expect(store.remove(ID_A)).resolves.toBeUndefined();
    expect(await store.list()).toStrictEqual([]);
  });

  it('keeps its own copy: a change of the entry after the put, or of what list gave, does not change the store', async () => {
    const store = make();
    const given = entry(ID_A);
    await store.put(given);
    const changeGiven: Writable<LeftSubDelegation> = given.left;
    changeGiven.action = 'po.write';
    const first = await store.list();
    const changeListed: Writable<LeftSubDelegation> = first[0]!.left;
    changeListed.action = 'po.write';
    Array.prototype.pop.call(first);
    expect(await store.list()).toStrictEqual([entry(ID_A)]);
  });

  it.each([
    ['upper case', ID_A.toUpperCase()],
    ['63 characters', ID_A.slice(1)],
    ['65 characters', `${ID_A}0`],
    ['a part of a path', `${'../'.repeat(21)}ab`],
    ['a path inside the folder', `sub/${ID_A.slice(4)}`],
    ['the empty text', ''],
    ['not hex', 'zz'.repeat(32)],
  ])('refuses an id of %s in put and in remove, and tells the member and never the value', async (_what, id) => {
    const store = make();
    await expect(store.put(entry(id))).rejects.toThrow(TypeError);
    await expect(store.put(entry(id))).rejects.toThrow(/left\.id/);
    if (id.length > 8) await expect(store.put(entry(id))).rejects.not.toThrow(id);
    await expect(store.remove(id)).rejects.toThrow(TypeError);
    expect(await store.list()).toStrictEqual([]);
  });

  it('refuses an id that is not text', async () => {
    const store = make();
    await expect(store.remove(42 as unknown as string)).rejects.toThrow(TypeError);
    await expect(store.remove(undefined as unknown as string)).rejects.toThrow(TypeError);
  });

  const BAD: [string, unknown][] = [
    ['no signer_key_hash', { left: entry().left }],
    ['no left', { signer_key_hash: KEY }],
    ['a member that is not allowed', { ...entry(), extra: 1 }],
    ['a member of left that is not allowed', { ...entry(), left: { ...entry().left, extra: 1 } }],
    ['a member of left that is missing', { ...entry(), left: { ...entry().left, endTxHash: undefined } }],
    ['a key hash of the wrong form', entry(ID_A, {}, 'ab')],
    ['a key hash in upper case', entry(ID_A, {}, 'AA'.repeat(28))],
    ['a parent of the wrong form', entry(ID_A, { parent: 'x' })],
    ['a Delegate hash in upper case', entry(ID_A, { delegateTxHash: 'D1'.repeat(32) })],
    ['an end hash of the wrong form', entry(ID_A, { endTxHash: 'ee' })],
    ['an end hash that is not null and not text', entry(ID_A, { endTxHash: 7 as unknown as string })],
    ['a TTL slot that is not a whole number', entry(ID_A, { delegateTtlSlot: 1.5 })],
    ['a TTL slot below 0', entry(ID_A, { delegateTtlSlot: -1 })],
    ['a TTL slot that is not a number', entry(ID_A, { delegateTtlSlot: '33000000' as unknown as number })],
    ['a time that is not finite', entry(ID_A, { notAfter: Number.POSITIVE_INFINITY })],
    ['a time that is NaN', entry(ID_A, { delegateValidTo: Number.NaN })],
    ['an empty action', entry(ID_A, { action: '' })],
    ['a resource that is too long', entry(ID_A, { resource: 'r'.repeat(1_025) })],
    ['a resource that is not text', entry(ID_A, { resource: 5 as unknown as string })],
    ['a value that is not an object', 'entry'],
    ['null', null],
  ];
  it.each(BAD)('refuses an entry with %s, and nothing is stored', async (_what, bad) => {
    const store = make();
    await expect(store.put(bad as LeftEntry)).rejects.toThrow(TypeError);
    expect(await store.list()).toStrictEqual([]);
  });

  it('accepts the entries that are the twins of the ones above: a set end hash, the least numbers, and the longest texts', async () => {
    const store = make();
    await store.put(entry(ID_A, { endTxHash: UNDELEGATE_TX }));
    await store.put(entry(ID_B, { delegateValidTo: 1, delegateTtlSlot: 0, notAfter: 1, action: 'a', resource: 'r'.repeat(1_024) }));
    expect(idsOf(await store.list())).toStrictEqual([ID_A, ID_B]);
  });

  it('refuses an entry that has a getter, and an entry whose members come from a prototype', async () => {
    const store = make();
    const withGetter = {
      signer_key_hash: KEY,
      get left() {
        return entry().left;
      },
    };
    await expect(store.put(withGetter as unknown as LeftEntry)).rejects.toThrow(TypeError);
    const inherited: LeftEntry = Object.create({ signer_key_hash: KEY, left: entry().left });
    await expect(store.put(inherited)).rejects.toThrow(TypeError);
    expect(await store.list()).toStrictEqual([]);
  });
});

describe('parseLeftEntry', () => {
  it('gives a new object in the order of the file form, and it never throws', () => {
    const parsed = parseLeftEntry({ signer_key_hash: KEY, left: { endTxHash: null, notAfter: 5, delegateTtlSlot: 4, delegateValidTo: 3, delegateTxHash: TX, resource: 'r', action: 'a', parent: ID_B, id: ID_A } });
    expect(parsed.ok && Object.keys(parsed.value)).toStrictEqual(['left', 'signer_key_hash']);
    expect(parsed.ok && Object.keys(parsed.value.left)).toStrictEqual(['id', 'parent', 'action', 'resource', 'delegateTxHash', 'delegateValidTo', 'delegateTtlSlot', 'notAfter', 'endTxHash']);
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    expect(parseLeftEntry(revoked.proxy)).toMatchObject({ ok: false, code: 'bad_shape' });
    expect(parseLeftEntry(JSON.parse('{"__proto__":{"x":1},"left":1,"signer_key_hash":"a"}'))).toMatchObject({ ok: false, code: 'bad_shape' });
  });
});

describe('FileLeftStore', () => {
  it('keeps what was put over a restart: a new instance on the same folder lists it', async () => {
    await new FileLeftStore(dir).put(entry(ID_A));
    await new FileLeftStore(dir).put(entry(ID_B, { endTxHash: UNDELEGATE_TX }));
    expect(await new FileLeftStore(dir).list()).toStrictEqual([entry(ID_A), entry(ID_B, { endTxHash: UNDELEGATE_TX })]);
    await new FileLeftStore(dir).remove(ID_A);
    expect(idsOf(await new FileLeftStore(dir).list())).toStrictEqual([ID_B]);
  });

  it('writes one JSON file for each id, named by the id, in the file form', async () => {
    await new FileLeftStore(dir).put(entry(ID_B));
    await new FileLeftStore(dir).put(entry(ID_A));
    expect(readdirSync(dir).sort()).toStrictEqual([`${ID_A}.json`, `${ID_B}.json`]);
    const text = readFileSync(join(dir, `${ID_A}.json`), 'utf8');
    expect(text.endsWith('\n')).toBe(true);
    const parsed: unknown = JSON.parse(text);
    expect(parsed).toStrictEqual(entry(ID_A));
    expect(Object.keys(Object(parsed))).toStrictEqual(['left', 'signer_key_hash']);
    expect(statSync(join(dir, `${ID_A}.json`)).mode & 0o077).toBe(0);
  });

  it('lists the entries in the order of their ids, and not in the order of the calls', async () => {
    const store = new FileLeftStore(dir);
    for (const id of [ID_C, ID_A, ID_B]) await store.put(entry(id));
    expect(idsOf(await store.list())).toStrictEqual([ID_A, ID_B, ID_C]);
  });

  it('makes its folder with mode 700 when it is missing, and lists nothing when the folder is missing: the twin', async () => {
    const inner = join(dir, 'state', 'left');
    const store = new FileLeftStore(inner);
    expect(await store.list()).toStrictEqual([]);
    expect(() => statSync(inner)).toThrow();
    await store.put(entry(ID_A));
    expect(statSync(inner).mode & 0o077).toBe(0);
    expect(idsOf(await new FileLeftStore(inner).list())).toStrictEqual([ID_A]);
  });

  it('writes the temporary file in the folder, flushes it, renames it over the file of the id, and then flushes the folder', async () => {
    const { fs, calls } = spy();
    await new FileLeftStore(dir, fs).put(entry(ID_A));
    expect(calls).toStrictEqual(['mkdir dir', 'writeFile tmp', 'fsync tmp', 'rename tmp entry', 'fsync dir']);
    expect(readdirSync(dir)).toStrictEqual([`${ID_A}.json`]);
  });

  it('flushes the folder after a removal, and flushes nothing when there was nothing to remove: the twin', async () => {
    await new FileLeftStore(dir).put(entry(ID_A));
    const { fs, calls } = spy();
    const store = new FileLeftStore(dir, fs);
    await store.remove(ID_A);
    expect(calls).toStrictEqual(['unlink entry', 'fsync dir']);
    calls.length = 0;
    await store.remove(ID_A);
    expect(calls).toStrictEqual(['unlink entry']);
  });

  it('touches only paths inside its folder', async () => {
    const { fs, paths } = spy();
    const store = new FileLeftStore(dir, fs);
    await store.put(entry(ID_A));
    await store.list();
    await store.remove(ID_A);
    expect(paths.length).toBeGreaterThan(5);
    expect(paths.every((path) => path === dir || path.startsWith(`${dir}/`))).toBe(true);
  });

  it('refuses an id that is not 64 hex characters before any file is touched, and an entry that is not in the form the same way', async () => {
    const { fs, calls } = spy();
    const store = new FileLeftStore(dir, fs);
    await expect(store.put(entry('../../x'))).rejects.toThrow(TypeError);
    await expect(store.put(entry(ID_A, { endTxHash: 'ee' }))).rejects.toThrow(TypeError);
    await expect(store.remove(`${ID_A}/..`)).rejects.toThrow(TypeError);
    expect(calls).toStrictEqual([]);
    expect(readdirSync(dir)).toStrictEqual([]);
    await store.put(entry(ID_A));
    expect(calls).not.toStrictEqual([]);
  });

  it('refuses a folder with a part that is .., and a folder that is empty or not text, when it is made: the twin is a plain path', () => {
    expect(() => new FileLeftStore(`${dir}/../x`)).toThrow(TypeError);
    expect(() => new FileLeftStore(`${dir}/a/../b`)).toThrow(TypeError);
    expect(() => new FileLeftStore('')).toThrow(TypeError);
    expect(() => new FileLeftStore(undefined as unknown as string)).toThrow(TypeError);
    expect(() => new FileLeftStore(join(dir, 'left'))).not.toThrow();
    expect(() => new FileLeftStore(join(dir, 'a..b'))).not.toThrow();
  });

  describe('a write that fails', () => {
    const FAILURES: [string, Partial<LeftFs>][] = [
      ['the write of the temporary file', { writeFile: fail('the disk is full') }],
      ['the flush of the temporary file', { fsync: fail('the disk is full') }],
      ['the rename', { rename: fail('the disk is full') }],
    ];

    it.each(FAILURES)('at %s leaves the old entry whole, takes the temporary file away, and rejects the put', async (_what, over) => {
      await new FileLeftStore(dir).put(entry(ID_A));
      const { fs } = spy(over);
      await expect(new FileLeftStore(dir, fs).put(entry(ID_A, { endTxHash: UNDELEGATE_TX }))).rejects.toThrow('the disk is full');
      expect(readdirSync(dir)).toStrictEqual([`${ID_A}.json`]);
      expect(await new FileLeftStore(dir).list()).toStrictEqual([entry(ID_A)]);
    });

    it.each(FAILURES)('at %s of a new id leaves no entry for it', async (_what, over) => {
      const { fs } = spy(over);
      await expect(new FileLeftStore(dir, fs).put(entry(ID_B))).rejects.toThrow('the disk is full');
      expect(readdirSync(dir)).toStrictEqual([]);
      expect(await new FileLeftStore(dir).list()).toStrictEqual([]);
    });

    it('rejects with the error of the write, also when the clean-up of the temporary file fails too, and a temporary file that stays is not an entry', async () => {
      await new FileLeftStore(dir).put(entry(ID_A));
      const { fs } = spy({ rename: fail('a crash'), unlink: fail('no clean-up') });
      await expect(new FileLeftStore(dir, fs).put(entry(ID_A, { endTxHash: UNDELEGATE_TX }))).rejects.toThrow('a crash');
      expect(readdirSync(dir).filter((name) => name.endsWith('.tmp'))).toHaveLength(1);
      expect(await new FileLeftStore(dir).list()).toStrictEqual([entry(ID_A)]);
      await new FileLeftStore(dir).put(entry(ID_B));
      expect(idsOf(await new FileLeftStore(dir).list())).toStrictEqual([ID_A, ID_B]);
    });

    it('rejects the put when the flush of the folder fails, so that the caller does not send what the entry names; the file is whole', async () => {
      const failing = spy({ fsync: async (path) => (path === dir ? fail('the folder cannot be flushed')() : nodeLeftFs.fsync(path)) });
      await expect(new FileLeftStore(dir, failing.fs).put(entry(ID_A))).rejects.toThrow('the folder cannot be flushed');
      expect(await new FileLeftStore(dir).list()).toStrictEqual([entry(ID_A)]);
      const good = spy();
      await expect(new FileLeftStore(dir, good.fs).put(entry(ID_B))).resolves.toBeUndefined();
    });

    it('rejects the removal when the file cannot be removed, and the entry stays: the removal of an entry that is not there is no error', async () => {
      await new FileLeftStore(dir).put(entry(ID_A));
      const denied = Object.assign(new Error('EACCES: the folder is read only'), { code: 'EACCES' });
      const { fs } = spy({ unlink: async () => Promise.reject(denied) });
      await expect(new FileLeftStore(dir, fs).remove(ID_A)).rejects.toThrow('EACCES');
      expect(idsOf(await new FileLeftStore(dir).list())).toStrictEqual([ID_A]);
      await expect(new FileLeftStore(dir).remove(ID_B)).resolves.toBeUndefined();
    });
  });

  describe('calls at one time', () => {
    it('lands two puts for two ids that are made at one time, and the two writes do not mix', async () => {
      const { fs, calls } = spy();
      const store = new FileLeftStore(dir, fs);
      await Promise.all([store.put(entry(ID_A)), store.put(entry(ID_B))]);
      expect(calls).toStrictEqual(Array.from({ length: 2 }, () => ['mkdir dir', 'writeFile tmp', 'fsync tmp', 'rename tmp entry', 'fsync dir']).flat());
      expect(idsOf(await store.list())).toStrictEqual([ID_A, ID_B]);
    });

    it('lands two puts for one id that are made at one time: the later call wins and the file is whole', async () => {
      const store = new FileLeftStore(dir);
      await Promise.all([store.put(entry(ID_A)), store.put(entry(ID_A, { endTxHash: UNDELEGATE_TX }))]);
      expect(await store.list()).toStrictEqual([entry(ID_A, { endTxHash: UNDELEGATE_TX })]);
      expect(readdirSync(dir)).toStrictEqual([`${ID_A}.json`]);
    });

    it('keeps a put that fails from stopping the calls behind it', async () => {
      let attempt = 0;
      const { fs } = spy({ rename: async (from, to) => (attempt++ === 0 ? fail('the first rename fails')() : nodeLeftFs.rename(from, to)) });
      const store = new FileLeftStore(dir, fs);
      const first = store.put(entry(ID_A));
      const second = store.put(entry(ID_B));
      await expect(first).rejects.toThrow('the first rename fails');
      await expect(second).resolves.toBeUndefined();
      expect(idsOf(await store.list())).toStrictEqual([ID_B]);
    });

    it('reads one whole state: a list that is asked for during a put sees the old entry or the new one, and never a part', async () => {
      const store = new FileLeftStore(dir);
      const newer = entry(ID_A, { endTxHash: UNDELEGATE_TX });
      await store.put(entry(ID_A));
      const [, listed] = await Promise.all([store.put(newer), store.list()]);
      expect([[entry(ID_A)], [newer]]).toContainEqual(listed);
    });
  });

  describe('a damaged file', () => {
    const DAMAGED: [string, string][] = [
      ['text that is not JSON', '{ "left": SECRET-MARKER'],
      ['an empty file', ''],
      ['a list', '[]'],
      ['null', 'null'],
      ['an entry without signer_key_hash', JSON.stringify({ left: entry().left })],
      ['an entry with a member that it must not have', JSON.stringify({ ...entry(), extra: 1 })],
      ['an entry whose key hash is not a key hash', JSON.stringify(entry(ID_A, {}, 'zz'))],
      ['an entry of another id than its file name', JSON.stringify(entry(ID_C))],
      ['an entry with a number that is not a whole number', JSON.stringify(entry(ID_A, { delegateTtlSlot: 1.5 }))],
      ['an entry with the key __proto__', '{"__proto__":{"x":1},"left":{},"signer_key_hash":"a"}'],
    ];

    it.each(DAMAGED)('is never skipped in silence: %s makes list throw, with the readable entries and the name of the file', async (_what, text) => {
      writeFileSync(join(dir, `${ID_A}.json`), text);
      await new FileLeftStore(dir).put(entry(ID_B));
      const error = await damagedError(new FileLeftStore(dir));
      expect(error.entries).toStrictEqual([entry(ID_B)]);
      expect(error.damaged).toHaveLength(1);
      expect(error.damaged[0]).toMatchObject({ file: `${ID_A}.json`, detail: expect.any(String) });
      expect(error.message).toContain(`${ID_A}.json`);
      expect(`${error.message} ${error.damaged[0]!.detail}`).not.toContain('SECRET-MARKER');
      expect(readFileSync(join(dir, `${ID_A}.json`), 'utf8')).toBe(text);
    });

    it('is read as an entry when it is whole: the twin of each file above', async () => {
      writeFileSync(join(dir, `${ID_A}.json`), `${JSON.stringify(entry(ID_A), null, 2)}\n`);
      await new FileLeftStore(dir).put(entry(ID_B));
      expect(idsOf(await new FileLeftStore(dir).list())).toStrictEqual([ID_A, ID_B]);
    });

    it('names each damaged file, when more than one is damaged, and still gives every whole entry', async () => {
      writeFileSync(join(dir, `${ID_A}.json`), 'x');
      writeFileSync(join(dir, `${ID_C}.json`), 'y');
      await new FileLeftStore(dir).put(entry(ID_B));
      const error = await damagedError(new FileLeftStore(dir));
      expect(error.damaged.map((d) => d.file)).toStrictEqual([`${ID_A}.json`, `${ID_C}.json`]);
      expect(idsOf(error.entries)).toStrictEqual([ID_B]);
    });

    it('is a file that cannot be read when it is a folder, and a .json file with a name that is not an id', async () => {
      mkdirSync(join(dir, `${ID_A}.json`));
      writeFileSync(join(dir, 'notes.json'), JSON.stringify(entry(ID_B)));
      const error = await damagedError(new FileLeftStore(dir));
      expect(error.damaged.map((d) => d.file).sort()).toStrictEqual([`${ID_A}.json`, 'notes.json'].sort());
      expect(error.entries).toStrictEqual([]);
    });

    it('stays on the disk when another id is put or removed, and a put of its own id replaces it by a whole entry', async () => {
      writeFileSync(join(dir, `${ID_A}.json`), 'damaged');
      const store = new FileLeftStore(dir);
      await store.put(entry(ID_B));
      await store.remove(ID_B);
      expect(readFileSync(join(dir, `${ID_A}.json`), 'utf8')).toBe('damaged');
      await store.put(entry(ID_A));
      expect(await store.list()).toStrictEqual([entry(ID_A)]);
    });

    it('is a file that cannot be read: the error of the disk is named by its code, and the readable entries come with it', async () => {
      await new FileLeftStore(dir).put(entry(ID_A));
      await new FileLeftStore(dir).put(entry(ID_B));
      const denied = Object.assign(new Error('EACCES: permission denied, open /secret/path'), { code: 'EACCES' });
      const { fs } = spy({ readFile: async (path) => (path.endsWith(`${ID_A}.json`) ? Promise.reject(denied) : nodeLeftFs.readFile(path)) });
      const error = await damagedError(new FileLeftStore(dir, fs));
      expect(error.damaged[0]!.detail).toContain('EACCES');
      expect(error.damaged[0]!.detail).not.toContain('/secret/path');
      expect(idsOf(error.entries)).toStrictEqual([ID_B]);
    });
  });

  describe('a file that is not an entry', () => {
    it('is not read: a temporary file that a crash left, a name that does not end in .json, and a folder name: none of them is damaged', async () => {
      const store = new FileLeftStore(dir);
      await store.put(entry(ID_A));
      writeFileSync(join(dir, `${ID_B}.json.0123456789ab.tmp`), 'half an entry');
      writeFileSync(join(dir, `${ID_B}.json.bak`), 'a copy that an operator made');
      writeFileSync(join(dir, 'README'), 'notes');
      mkdirSync(join(dir, 'quarantine'));
      expect(await store.list()).toStrictEqual([entry(ID_A)]);
    });

    it('does not make a temporary file an entry after the id of it is put: the temporary file of another write is another file', async () => {
      writeFileSync(join(dir, `${ID_A}.json.0123456789ab.tmp`), 'half an entry');
      const store = new FileLeftStore(dir);
      await store.put(entry(ID_A));
      expect(await store.list()).toStrictEqual([entry(ID_A)]);
      expect(readdirSync(dir).sort()).toStrictEqual([`${ID_A}.json`, `${ID_A}.json.0123456789ab.tmp`]);
    });
  });
});
