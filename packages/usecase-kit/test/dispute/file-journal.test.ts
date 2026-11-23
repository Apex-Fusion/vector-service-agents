// packages/usecase-kit/test/dispute/file-journal.test.ts: the journal on disk. Three questions. Does a restart lose a record that says the evidence may be on chain? Is a record whole, or not there at all,
// also when a write stops half way? Can two writes mix? The dispute code also runs the same jobs over this journal and over the journal in memory, and the two must give the same results.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import * as disk from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { setImmediate as tick } from 'node:timers/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { documentUri } from '@vsa/buyer-core';
import { HireLane } from '@vsa/hire-kit';
import { NO_OPEN_CLAIM } from '@vsa/usecase-kit/protocol';
import { FileJournal, MemoryJournal } from '@vsa/usecase-kit/dispute';
import type { ChallengeResult, DeliveryChallengeInput, DisputeJournal, JobRecord, JournalFs } from '@vsa/usecase-kit/dispute';
import {
  DELIVERY_JOB, ESCROW, ESCROW_2, EVIDENCE_TX, HOUR, NOW, ORDER_FACTS, OTHER, OTHER_ID, REF_A, REF_B, REF_C, THIRD, THIRD_ID, TOKEN_A, TOKEN_B, TOKEN_C, claimView, deferred, escrowJob, evidenceOf, rig,
} from './support.ts';
import type { ScriptedPort } from './support.ts';

const FILE = `${'e5'.repeat(32)}_1`;
const FILE_2 = `${'e6'.repeat(32)}_1`;
/** The name of a temporary file: a dot, the name of the file, a random part, and `.tmp`. A reader never takes it for a record. */
const TEMPORARY = /^\.[0-9a-f]{64}_1\.[0-9a-f]{16}\.tmp$/;
const LEASE = 600_000;
const LANDED = { tx_hash: EVIDENCE_TX, uri: documentUri(EVIDENCE_TX), document_hash: evidenceOf().hash };

const delivery = (extra: Partial<DeliveryChallengeInput> = {}): DeliveryChallengeInput => ({ counterparty: OTHER, escrow_ref: ESCROW, ...DELIVERY_JOB, evidence: ORDER_FACTS, ...extra });
const record = (extra: Partial<JobRecord> = {}): JobRecord => ({
  step: 'started', escrow: ESCROW, against: OTHER, claim: REF_A, claim_token: TOKEN_A, started_at: NOW, evidence: null, filed: null, ended: null, ...extra,
});
const fault = (code: string): Error => Object.assign(new Error(`${code}: the disk fails`), { code });

function expectNotFiled(result: ChallengeResult, code: string): asserts result is Extract<ChallengeResult, { ok: false }> {
  expect(result).toMatchObject({ ok: false, code });
}

// --- Folders and file system calls --------------------------------------------------------------------------------------------------------------------------------

const made: string[] = [];
afterEach(() => {
  for (const path of made.splice(0)) rmSync(path, { recursive: true, force: true });
});

/** A new folder below the system temp folder. The test ends with its removal. */
function tempFolder(): string {
  const path = mkdtempSync(join(tmpdir(), 'file-journal-'));
  made.push(path);
  return path;
}

/** The calls of the file system of the process, in the form of the port of the journal. */
const real: JournalFs = {
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
function spied(folder: string, calls: Call[], over: Partial<JournalFs> = {}): JournalFs {
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

/** The record in the file of the job ESCROW, read the plain way. */
const onDisk = (folder: string, file = FILE): JobRecord => JSON.parse(readFileSync(join(folder, file), 'utf8')) as JobRecord;

// --- The contract of a journal ------------------------------------------------------------------------------------------------------------------------------------

/** One way to open a journal. Each call gives a journal object over the same records. For the file journal it is a new object on the same folder, as a process that starts again. */
type Open = () => DisputeJournal;
type Make = () => Open;

const JOURNALS: Array<[string, Make]> = [
  ['MemoryJournal', () => { const kept = new MemoryJournal(); return () => kept; }],
  ['FileJournal', () => { const folder = tempFolder(); return () => new FileJournal(folder); }],
];

describe.each(JOURNALS)('%s keeps the contract of the journal', (_name, make) => {
  it('gives back the record that was put, as a copy, and null for a job with no record', async () => {
    const open = make();
    expect(await open().get(ESCROW)).toBeNull();
    await open().put(ESCROW, record());
    const first = (await open().get(ESCROW))!;
    expect(first).toEqual(record());
    Object.assign(first, { step: 'done' });
    expect((await open().get(ESCROW))!.step).toBe('started');
    expect(await open().get(ESCROW_2)).toBeNull();
  });

  it('refuses a record that is not JSON data, so that a bigint cannot get in, and stores nothing', async () => {
    const open = make();
    await expect(open().put(ESCROW, { ...record(), claim: 5n as never })).rejects.toThrow();
    expect(await open().get(ESCROW)).toBeNull();
  });

  it('replaces the record of a job, and keeps the records of the other jobs', async () => {
    const open = make();
    await open().put(ESCROW, record());
    await open().put(ESCROW_2, record({ escrow: ESCROW_2, step: 'evidence_landed', evidence: LANDED }));
    await open().put(ESCROW, record({ step: 'not_sent' }));
    expect((await open().get(ESCROW))!.step).toBe('not_sent');
    expect((await open().get(ESCROW_2))!.step).toBe('evidence_landed');
  });
});

// --- The records on disk ------------------------------------------------------------------------------------------------------------------------------------------

describe('the file journal keeps its records on disk', () => {
  it('writes one JSON file for each job, named by its escrow with the hash sign as an underscore, and nothing else', async () => {
    const parent = tempFolder();
    const folder = join(parent, 'journal');
    const journal = new FileJournal(folder);
    await journal.put(ESCROW, record());
    await journal.put(ESCROW_2, record({ escrow: ESCROW_2 }));
    expect(readdirSync(folder).sort()).toEqual([FILE, FILE_2]);
    expect(onDisk(folder)).toEqual(record());
    expect(onDisk(folder, FILE_2)).toEqual(record({ escrow: ESCROW_2 }));
    expect(readdirSync(parent)).toEqual(['journal']);
  });

  it('gives each record to a NEW instance on the same folder, so a restart loses nothing, and null for a job that has no file', async () => {
    const folder = tempFolder();
    const records = [
      record(), record({ step: 'evidence_landed', evidence: LANDED }), record({ step: 'not_sent' }),
      record({ step: 'done', evidence: LANDED, ended: { code: 'challenge_not_built', detail: 'the wallet is empty', sent: null, challenge: null, wrong_document: null } }),
    ];
    for (const stored of records) {
      await new FileJournal(folder).put(ESCROW, stored);
      const restarted = new FileJournal(folder);
      expect(await restarted.get(ESCROW), stored.step).toEqual(stored);
      expect(await restarted.get(ESCROW_2), stored.step).toBeNull();
    }
  });

  it('returns what it read, and leaves the form of the record to the dispute code', async () => {
    const folder = tempFolder();
    writeFileSync(join(folder, FILE), '{"step":"finished"}');
    expect(await new FileJournal(folder).get(ESCROW)).toEqual({ step: 'finished' });
  });

  it('ignores a temporary file that a crash left, and never takes it for a record', async () => {
    const folder = tempFolder();
    const stray = join(folder, `.${FILE}.0123456789abcdef.tmp`);
    writeFileSync(stray, JSON.stringify(record({ step: 'done' })));
    const journal = new FileJournal(folder);
    expect(await journal.get(ESCROW)).toBeNull();
    await journal.put(ESCROW, record());
    expect(await journal.get(ESCROW)).toEqual(record());
    expect(readFileSync(stray, 'utf8')).toBe(JSON.stringify(record({ step: 'done' })));
  });

  describe('a file that holds no record is an error, and it is never read as no record', () => {
    const DAMAGED: Array<[string, string]> = [
      ['an empty file', ''],
      ['text that is not JSON', 'started'],
      ['a record that is cut', JSON.stringify(record()).slice(0, 40)],
      ['JSON null', 'null'],
      ['a JSON array', '[]'],
      ['a JSON number', '7'],
      ['a JSON text', '"started"'],
    ];

    it.each(DAMAGED)('throws for %s, and leaves the file as it is', async (_name, text) => {
      const folder = tempFolder();
      writeFileSync(join(folder, FILE), text);
      const journal = new FileJournal(folder);
      await expect(journal.get(ESCROW)).rejects.toThrow();
      expect(readFileSync(join(folder, FILE), 'utf8')).toBe(text);
      // The twin: the file of another job, and a whole file.
      expect(await journal.get(ESCROW_2)).toBeNull();
      writeFileSync(join(folder, FILE), `${JSON.stringify(record())}\n`);
      expect(await journal.get(ESCROW)).toEqual(record());
    });

    it('throws for a folder at the place of the file, and for a read that fails with another error than a missing file', async () => {
      const folder = tempFolder();
      mkdirSync(join(folder, FILE));
      await expect(new FileJournal(folder).get(ESCROW)).rejects.toThrow();
      const broken = tempFolder();
      for (const code of ['EACCES', 'EIO', 'EISDIR', 'ENOTDIR']) {
        const journal = new FileJournal(broken, { fs: { readFile: async () => { throw fault(code); } } });
        await expect(journal.get(ESCROW), code).rejects.toThrow(code);
      }
      // The twin: a file that is not there is no record.
      const absent = new FileJournal(broken, { fs: { readFile: async () => { throw fault('ENOENT'); } } });
      expect(await absent.get(ESCROW)).toBeNull();
    });

    it('replaces a damaged file when a record is put, because the caller says what the record is', async () => {
      const folder = tempFolder();
      writeFileSync(join(folder, FILE), 'cut');
      const journal = new FileJournal(folder);
      await journal.put(ESCROW, record());
      expect(await journal.get(ESCROW)).toEqual(record());
    });
  });
});

// --- A write is whole or it is not there --------------------------------------------------------------------------------------------------------------------------

describe('a write is whole, or it is not there', () => {
  it('writes a temporary file in the same folder, syncs it, renames it over the file of the job, syncs the folder, and then returns', async () => {
    const folder = tempFolder();
    const calls: Call[] = [];
    const journal = new FileJournal(folder, { fs: spied(folder, calls) });
    await journal.put(ESCROW, record());
    const [write, sync, move, syncFolder, ...rest] = calls;
    expect(write!.call).toBe('writeFile');
    expect(write!.path).toMatch(TEMPORARY);
    expect(sync).toEqual({ call: 'fsync', path: write!.path });
    expect(move).toEqual({ call: 'rename', path: write!.path, to: FILE });
    expect(syncFolder).toEqual({ call: 'fsync', path: '.' });
    expect(rest).toEqual([]);
    expect(readdirSync(folder)).toEqual([FILE]);
    // A read is one read of the file of the job.
    calls.length = 0;
    expect(await journal.get(ESCROW)).toEqual(record());
    expect(calls).toEqual([{ call: 'readFile', path: FILE }]);
  });

  it('returns only after the folder is synced, and the record is on disk by then', async () => {
    const folder = tempFolder();
    const gate = deferred<void>();
    const calls: Call[] = [];
    const journal = new FileJournal(folder, { fs: spied(folder, calls, { fsync: async (path) => { if (path === folder) await gate.promise; return real.fsync(path); } }) });
    let settled = false;
    const pending = journal.put(ESCROW, record()).then(() => { settled = true; });
    await vi.waitFor(() => expect(calls.at(-1)).toEqual({ call: 'fsync', path: '.' }), { timeout: 4_000 });
    await tick();
    expect(settled).toBe(false);
    expect(onDisk(folder)).toEqual(record());
    gate.resolve();
    await pending;
    expect(settled).toBe(true);
  });

  it('does not rename before the write of the temporary file has ended', async () => {
    const folder = tempFolder();
    const gate = deferred<void>();
    const calls: Call[] = [];
    const journal = new FileJournal(folder, { fs: spied(folder, calls, { writeFile: async (path, text) => { await gate.promise; return real.writeFile(path, text); } }) });
    const pending = journal.put(ESCROW, record());
    await vi.waitFor(() => expect(calls).toHaveLength(1), { timeout: 4_000 });
    await tick();
    expect(calls.map((entry) => entry.call)).toEqual(['writeFile']);
    expect(existsSync(join(folder, FILE))).toBe(false);
    gate.resolve();
    await pending;
    expect(calls.map((entry) => entry.call)).toEqual(['writeFile', 'fsync', 'rename', 'fsync']);
  });

  describe('a failure before the rename leaves the old record whole, and removes the temporary file', () => {
    const NEWER = record({ step: 'evidence_landed', evidence: LANDED });
    const STEPS: Array<[string, Partial<JournalFs>]> = [
      ['the write of the temporary file, after a part of it was written', { writeFile: async (path) => { await disk.writeFile(path, '{"step":'); throw fault('ENOSPC'); } }],
      ['the sync of the temporary file', { fsync: async () => { throw fault('EIO'); } }],
      ['the rename', { rename: async () => { throw fault('EIO'); } }],
    ];

    it.each(STEPS)('after a failure of %s', async (_name, over) => {
      const folder = tempFolder();
      await new FileJournal(folder).put(ESCROW, record());
      const failing = new FileJournal(folder, { fs: over });
      await expect(failing.put(ESCROW, NEWER)).rejects.toThrow();
      expect(readdirSync(folder)).toEqual([FILE]);
      expect(await new FileJournal(folder).get(ESCROW)).toEqual(record());
      // The twin: the same write over the file system that works.
      await new FileJournal(folder).put(ESCROW, NEWER);
      expect(await new FileJournal(folder).get(ESCROW)).toEqual(NEWER);
      expect(readdirSync(folder)).toEqual([FILE]);
    });

    it.each(STEPS)('after a failure of %s, for a job that had no record: there is still no record', async (_name, over) => {
      const folder = tempFolder();
      await expect(new FileJournal(folder, { fs: over }).put(ESCROW, record())).rejects.toThrow();
      expect(readdirSync(folder)).toEqual([]);
      expect(await new FileJournal(folder).get(ESCROW)).toBeNull();
    });

    it('gives the error of the file system, also when the removal of the temporary file fails too', async () => {
      const folder = tempFolder();
      const journal = new FileJournal(folder, { fs: { rename: async () => { throw fault('EIO'); }, unlink: async () => { throw fault('EPERM'); } } });
      await expect(journal.put(ESCROW, record())).rejects.toThrow('EIO');
    });
  });

  it('rejects when the folder cannot be synced, because the record is not known to be stored for good', async () => {
    const folder = tempFolder();
    const journal = new FileJournal(folder, { fs: { fsync: async (path) => { if (path === folder) throw fault('EIO'); return real.fsync(path); } } });
    await expect(journal.put(ESCROW, record())).rejects.toThrow('EIO');
    // The rename was done before: a reader sees the record whole, and never half of it.
    expect(await new FileJournal(folder).get(ESCROW)).toEqual(record());
  });

  it('writes the text of the record as it is at the call, so a change of the object after the call changes nothing', async () => {
    const folder = tempFolder();
    const gate = deferred<void>();
    const journal = new FileJournal(folder, { fs: { writeFile: async (path, text) => { await gate.promise; return real.writeFile(path, text); } } });
    const stored = { ...record() };
    const pending = journal.put(ESCROW, stored);
    Object.assign(stored, { step: 'done' });
    gate.resolve();
    await pending;
    expect((await new FileJournal(folder).get(ESCROW))!.step).toBe('started');
  });
});

// --- Two writes ---------------------------------------------------------------------------------------------------------------------------------------------------

describe('two writes never mix', () => {
  it('lands the writes of two jobs that run at one time, each whole, with temporary files that differ', async () => {
    const folder = tempFolder();
    const calls: Call[] = [];
    const journal = new FileJournal(folder, { fs: spied(folder, calls) });
    const first = record();
    const second = record({ escrow: ESCROW_2, step: 'evidence_landed', evidence: LANDED });
    await Promise.all([journal.put(ESCROW, first), journal.put(ESCROW_2, second)]);
    expect(readdirSync(folder).sort()).toEqual([FILE, FILE_2]);
    const reader = new FileJournal(folder);
    expect(await reader.get(ESCROW)).toEqual(first);
    expect(await reader.get(ESCROW_2)).toEqual(second);
    const temporary = calls.filter((entry) => entry.call === 'writeFile').map((entry) => entry.path);
    expect(temporary).toHaveLength(2);
    expect(new Set(temporary).size).toBe(2);
  });

  it('lands the writes of twenty jobs at one time, and the writes of two instances on one folder, each record whole', async () => {
    const folder = tempFolder();
    const refs = Array.from({ length: 20 }, (_, index) => `${'e5'.repeat(32)}#${index}`);
    const one = new FileJournal(folder);
    const other = new FileJournal(folder);
    await Promise.all(refs.map((ref, index) => (index % 2 === 0 ? one : other).put(ref, record({ escrow: ref }))));
    expect(readdirSync(folder)).toHaveLength(20);
    const reader = new FileJournal(folder);
    for (const ref of refs) expect(await reader.get(ref), ref).toEqual(record({ escrow: ref }));
  });

  it('lands the writes for one job in the order of the calls, also when the first write is slow', async () => {
    const folder = tempFolder();
    const gate = deferred<void>();
    let calls = 0;
    const journal = new FileJournal(folder, {
      fs: { writeFile: async (path, text) => { calls += 1; if (calls === 1) await gate.promise; return real.writeFile(path, text); } },
    });
    const older = journal.put(ESCROW, record());
    const newer = journal.put(ESCROW, record({ step: 'evidence_landed', evidence: LANDED }));
    await tick();
    await tick();
    gate.resolve();
    await Promise.all([older, newer]);
    expect((await new FileJournal(folder).get(ESCROW))!.step).toBe('evidence_landed');
    expect(readdirSync(folder)).toEqual([FILE]);
  });

  it('goes on with the writes of a job after a write of that job failed', async () => {
    const folder = tempFolder();
    let calls = 0;
    const journal = new FileJournal(folder, { fs: { rename: async (from, to) => { calls += 1; if (calls === 1) throw fault('EIO'); return real.rename(from, to); } } });
    const lost = journal.put(ESCROW, record());
    const kept = journal.put(ESCROW, record({ step: 'not_sent' }));
    await expect(lost).rejects.toThrow('EIO');
    await kept;
    expect((await journal.get(ESCROW))!.step).toBe('not_sent');
  });
});

// --- The name of a job --------------------------------------------------------------------------------------------------------------------------------------------

describe('a reference that is not an output reference', () => {
  const HEX = 'e5'.repeat(32);
  const BAD: Array<[string, unknown]> = [
    ['an empty text', ''],
    ['a text', 'job'],
    ['a path out of the folder', `../${HEX}#0`],
    ['a path out of the folder after the reference', `${HEX}#0/../../x`],
    ['an absolute path', `/etc/${HEX}#0`],
    ['no index', HEX],
    ['an empty index', `${HEX}#`],
    ['an index with a leading zero', `${HEX}#01`],
    ['an index of eleven digits', `${HEX}#12345678901`],
    ['an underscore for the hash sign', `${HEX}_1`],
    ['hex in upper case', `${'E5'.repeat(32)}#1`],
    ['a hash that is too short', `${'e5'.repeat(31)}#1`],
    ['a line feed at the end', `${HEX}#1\n`],
    ['a number', 1],
    ['null', null],
    ['nothing', undefined],
    ['an object that gives a reference as text', { toString: () => `${HEX}#1` }],
  ];

  it.each(BAD)('is refused by get and by put before any file is touched: %s', async (_name, ref) => {
    const folder = tempFolder();
    const calls: Call[] = [];
    const journal = new FileJournal(folder, { fs: spied(folder, calls) });
    await expect(journal.get(ref as never)).rejects.toThrow();
    await expect(journal.put(ref as never, record())).rejects.toThrow();
    expect(calls).toEqual([]);
    expect(readdirSync(folder)).toEqual([]);
  });

  it('takes the first index and the last index of ten digits, as the twin of the refusals', async () => {
    const folder = tempFolder();
    const journal = new FileJournal(folder);
    for (const ref of [`${HEX}#0`, `${HEX}#9`, `${HEX}#10`, `${HEX}#9999999999`]) {
      await journal.put(ref, record({ escrow: ref }));
      expect(await journal.get(ref), ref).toEqual(record({ escrow: ref }));
      expect(existsSync(join(folder, ref.split('#').join('_'))), ref).toBe(true);
    }
  });

  it('refuses a record that is not an object, before any file is touched', async () => {
    const folder = tempFolder();
    const calls: Call[] = [];
    const journal = new FileJournal(folder, { fs: spied(folder, calls) });
    for (const stored of [null, undefined, 'started', 7, [record()]]) {
      await expect(journal.put(ESCROW, stored as never), String(stored)).rejects.toThrow();
    }
    expect(calls).toEqual([]);
  });
});

// --- The construction ---------------------------------------------------------------------------------------------------------------------------------------------

describe('the construction of the journal', () => {
  it('makes a folder that is missing, and the folders above it, with mode 700, and keeps a folder that exists as it is', () => {
    const parent = tempFolder();
    const folder = join(parent, 'state', 'journal');
    expect(existsSync(folder)).toBe(false);
    expect(() => new FileJournal(folder)).not.toThrow();
    expect(statSync(folder).isDirectory()).toBe(true);
    expect(statSync(folder).mode & 0o777).toBe(0o700);
    expect(statSync(join(parent, 'state')).mode & 0o777).toBe(0o700);
    const existing = join(parent, 'existing');
    mkdirSync(existing);
    chmodSync(existing, 0o750);
    expect(() => new FileJournal(existing)).not.toThrow();
    expect(statSync(existing).mode & 0o777).toBe(0o750);
  });

  it('keeps the records that a folder holds, and reads them', async () => {
    const folder = tempFolder();
    await new FileJournal(folder).put(ESCROW, record());
    expect(await new FileJournal(folder).get(ESCROW)).toEqual(record());
    expect(readdirSync(folder)).toEqual([FILE]);
  });

  const FOLDER_PATHS: Array<[string, (folder: string) => string]> = [
    ['a ".." segment in the middle', (folder) => `${folder}/sub/../journal`],
    ['a ".." segment at the end', (folder) => `${folder}/journal/..`],
    ['a relative path with a ".." segment', (folder) => `${relative(process.cwd(), folder)}/sub/../journal`],
    ['a ".." segment after a backslash', (folder) => `${folder}\\..\\journal`],
    ['an empty path', () => ''],
    ['a NUL character', (folder) => `${folder}/journal\0x`],
  ];

  it.each(FOLDER_PATHS)('refuses a path with %s, and makes no folder', (_name, make) => {
    const folder = tempFolder();
    expect(() => new FileJournal(make(folder))).toThrow();
    expect(readdirSync(folder)).toEqual([]);
  });

  it('refuses a folder that is not text', () => {
    for (const value of [7, null, undefined, {}, ['a']]) expect(() => new FileJournal(value as never), String(value)).toThrow(TypeError);
  });

  it('refuses a path that is a file, and a path below a file, and leaves the file as it is', () => {
    const folder = tempFolder();
    const file = join(folder, 'file');
    writeFileSync(file, 'x');
    expect(() => new FileJournal(file)).toThrow();
    expect(() => new FileJournal(join(file, 'journal'))).toThrow();
    expect(readFileSync(file, 'utf8')).toBe('x');
  });

  it.skipIf(process.getuid?.() === 0)('refuses a folder that cannot be written, and takes it again when it can be', () => {
    const folder = tempFolder();
    const locked = join(folder, 'locked');
    mkdirSync(locked);
    chmodSync(locked, 0o500);
    try {
      expect(() => new FileJournal(locked)).toThrow();
    } finally {
      chmodSync(locked, 0o700);
    }
    expect(() => new FileJournal(locked)).not.toThrow();
  });
});

// --- The dispute code over the file journal -----------------------------------------------------------------------------------------------------------------------

/** What a row of the table sees: the results of its calls, the evidence documents that the port got, and the claims that it challenged. */
interface Run {
  readonly results: readonly ChallengeResult[];
  readonly published: number;
  readonly challenged: readonly string[];
}

const runOf = (port: ScriptedPort, ...results: ChallengeResult[]): Run => ({ results, published: port.published.length, challenged: port.challenged.map((call) => call.claim) });

/** The chain after a challenge: the claim that the challenge spent is Challenged, so it is no longer open. */
function challengeChangesTheClaim(port: ScriptedPort): void {
  const answer = port.openChallengeAnswer;
  port.openChallengeAnswer = (call) => {
    port.claims = port.claims.map((claim) => (claim.ref === call.claim ? { ...claim, state: 'Challenged' } : claim));
    return answer(call);
  };
}

/** A dispute of a process that starts now, over the journal that `open` gives and the chain that `port` shows. A call of `open` for each dispute is a restart on the same records. */
const fresh = (open: Open, port?: ScriptedPort) => rig({}, { journal: open(), ...(port === undefined ? {} : { port }) });

/**
 * The jobs of the table. Each row runs its calls through the dispute code, each call in a new process over the same records, and then says what must hold. The rows are the jobs of `challenge.test.ts` that
 * the journal decides, and the jobs of `journal.test.ts` that a restart reaches.
 */
const TABLE: Array<[string, (open: Open) => Promise<Run>, (run: Run) => void]> = [
  [
    'gives the filed challenge again for a second call for one job, and publishes and challenges once',
    async (open) => {
      const first = fresh(open);
      first.port.claims = [claimView()];
      const filed = await first.dispute.challengeDelivery(delivery());
      return runOf(first.port, filed, await fresh(open, first.port).dispute.challengeDelivery(delivery()));
    },
    (run) => {
      expect(run.results[0]!.ok).toBe(true);
      expect(run.results[1]).toEqual(run.results[0]);
      expect(run).toMatchObject({ published: 1, challenged: [REF_A] });
    },
  ],
  [
    'files no second challenge for one job against another claim of the same agent',
    async (open) => {
      const first = fresh(open);
      first.port.claims = [claimView()];
      challengeChangesTheClaim(first.port);
      const filed = await first.dispute.challengeDelivery(delivery());
      first.port.claims = [...first.port.claims, claimView({ ref: REF_B, token: TOKEN_B, submitted_at: NOW - 10 * 60_000 })];
      return runOf(first.port, filed, await fresh(open, first.port).dispute.challengeDelivery(delivery()));
    },
    (run) => {
      expect(run.results[0]!.ok).toBe(true);
      expect(run.results[1]).toEqual(run.results[0]);
      expect(run.challenged).toEqual([REF_A]);
    },
  ],
  [
    'files the second job against the claim of its own party, and a third job against a claim that is challenged finds no open claim',
    async (open) => {
      const first = fresh(open);
      first.port.claims = [claimView(), claimView({ ref: REF_C, token: TOKEN_C, claimer: THIRD })];
      first.port.readEscrowAnswer = (ref) => escrowJob({ agent_id: ref === ESCROW ? OTHER_ID : THIRD_ID });
      challengeChangesTheClaim(first.port);
      const one = await first.dispute.challengeDelivery(delivery());
      const next = fresh(open, first.port);
      const two = await next.dispute.challengeDelivery(delivery({ counterparty: THIRD, escrow_ref: ESCROW_2 }));
      const three = await fresh(open, first.port).dispute.challengeDelivery(delivery({ escrow_ref: `${'e7'.repeat(32)}#0` }));
      return runOf(first.port, one, two, three);
    },
    (run) => {
      expect(run.results.map((result) => result.ok)).toEqual([true, true, false]);
      expect(run.results[2]).toMatchObject({ code: NO_OPEN_CLAIM });
      expect(run.challenged).toEqual([REF_A, REF_C]);
    },
  ],
  [
    'refuses a call for a job that another process started and has not ended',
    async (open) => {
      const first = fresh(open);
      first.port.claims = [claimView()];
      const release = first.port.holdPublish();
      const pending = first.dispute.challengeDelivery(delivery());
      await vi.waitFor(async () => expect((await open().get(ESCROW))?.step).toBe('started'), { timeout: 4_000 });
      const refused = await fresh(open, first.port).dispute.challengeDelivery(delivery());
      release();
      return runOf(first.port, await pending, refused);
    },
    (run) => {
      expect(run.results[0]!.ok).toBe(true);
      expect(run.results[1]).toMatchObject({ ok: false, code: 'job_already_disputed' });
      expect(run).toMatchObject({ published: 1, challenged: [REF_A] });
    },
  ],
  [
    'refuses a second try after a transaction was sent and not seen confirmed, and gives the recorded state',
    async (open) => {
      const first = fresh(open);
      first.port.claims = [claimView()];
      first.port.publishAnswer = () => ({ ok: false, code: 'not_confirmed', detail: 'late', tx_hash: EVIDENCE_TX, valid_to: NOW + HOUR, may_land: true });
      const sent = await first.dispute.challengeDelivery(delivery());
      return runOf(first.port, sent, await fresh(open, first.port).dispute.challengeDelivery(delivery()));
    },
    (run) => {
      expect(run.results[0]).toMatchObject({ ok: false, code: 'evidence_not_confirmed' });
      expect(run.results[1]).toMatchObject({ ok: false, code: 'job_already_disputed', sent: { tx_hash: EVIDENCE_TX, may_land: true } });
      expect(run.published).toBe(1);
    },
  ],
  [
    'refuses a second try after the evidence landed and the challenge failed, and gives the recorded state',
    async (open) => {
      const first = fresh(open);
      first.port.claims = [claimView()];
      first.port.openChallengeAnswer = () => ({ ok: false, code: 'not_built', detail: 'the wallet is empty' });
      const failed = await first.dispute.challengeDelivery(delivery());
      return runOf(first.port, failed, await fresh(open, first.port).dispute.challengeDelivery(delivery()));
    },
    (run) => {
      expect(run.results[0]).toMatchObject({ ok: false, code: 'challenge_not_built', evidence: { tx_hash: EVIDENCE_TX } });
      expect(run.results[1]).toMatchObject({ ok: false, code: 'job_already_disputed', evidence: { tx_hash: EVIDENCE_TX } });
      expect(run.results[1]).toMatchObject({ detail: expect.stringContaining('challenge_not_built') });
      expect(run.published).toBe(1);
    },
  ],
  [
    'takes the job again after no open claim, because that call wrote no record',
    async (open) => {
      const first = fresh(open);
      const none = await first.dispute.challengeDelivery(delivery());
      first.port.claims = [claimView()];
      return runOf(first.port, none, await fresh(open, first.port).dispute.challengeDelivery(delivery()));
    },
    (run) => {
      expect(run.results[0]).toMatchObject({ ok: false, code: NO_OPEN_CLAIM });
      expect(run.results[1]!.ok).toBe(true);
      expect(run.challenged).toEqual([REF_A]);
    },
  ],
  [
    'stops a job whose record started less than the lease ago, and goes on with it when the lease has passed, in a process that starts after a stop',
    async (open) => {
      await open().put(ESCROW, record());
      const early = fresh(open);
      early.port.claims = [claimView()];
      early.time.now = NOW + LEASE - 1;
      const stopped = await early.dispute.challengeDelivery(delivery());
      const late = fresh(open, early.port);
      late.time.now = NOW + LEASE;
      return runOf(early.port, stopped, await late.dispute.challengeDelivery(delivery()));
    },
    (run) => {
      expect(run.results[0]).toMatchObject({ ok: false, code: 'job_already_disputed' });
      expect(run.results[1]!.ok).toBe(true);
      expect(run).toMatchObject({ published: 1, challenged: [REF_A] });
    },
  ],
  [
    'stops a job whose evidence landed, whatever the age of its record',
    async (open) => {
      await open().put(ESCROW, record({ step: 'evidence_landed', evidence: LANDED, started_at: NOW - 30 * 24 * HOUR }));
      const first = fresh(open);
      first.port.claims = [claimView()];
      return runOf(first.port, await first.dispute.challengeDelivery(delivery()));
    },
    (run) => {
      expect(run.results[0]).toMatchObject({ ok: false, code: 'job_already_disputed', evidence: { tx_hash: EVIDENCE_TX } });
      expect(run).toMatchObject({ published: 0, challenged: [] });
    },
  ],
];

describe('the dispute code gives the same results over the file journal as over the journal in memory, across a restart', () => {
  it.each(TABLE)('%s', async (_name, run, check) => {
    const kept = new MemoryJournal();
    const inMemory = await run(() => kept);
    const folder = tempFolder();
    const onFiles = await run(() => new FileJournal(folder));
    check(onFiles);
    expect(onFiles).toEqual(inMemory);
  });
});

describe('the dispute code over a folder', () => {
  it('has the record of a step on disk before the step that follows it', async () => {
    const folder = tempFolder();
    const { port, dispute } = rig({}, { journal: new FileJournal(folder) });
    port.claims = [claimView()];
    const seen: string[] = [];
    const publish = port.publishAnswer;
    port.publishAnswer = (call) => {
      seen.push(`publish after ${onDisk(folder).step}`);
      return publish(call);
    };
    const challenge = port.openChallengeAnswer;
    port.openChallengeAnswer = (call) => {
      seen.push(`challenge after ${onDisk(folder).step}`);
      return challenge(call);
    };
    expect((await dispute.challengeDelivery(delivery())).ok).toBe(true);
    expect(seen).toEqual(['publish after started', 'challenge after evidence_landed']);
    expect(onDisk(folder)).toMatchObject({ step: 'done', escrow: ESCROW, filed: { challenge_tx: expect.any(String) } });
    expect(readdirSync(folder)).toEqual([FILE]);
  });

  it('says journal_unavailable for a damaged file, sends nothing, and goes on when the file is gone', async () => {
    const folder = tempFolder();
    writeFileSync(join(folder, FILE), '{"step":"sta');
    const damaged = rig({}, { journal: new FileJournal(folder) });
    damaged.port.claims = [claimView()];
    const result = await damaged.dispute.challengeDelivery(delivery());
    expectNotFiled(result, 'journal_unavailable');
    expect(result.detail).toContain('cannot be read');
    expect(damaged.port.published).toEqual([]);
    expect(damaged.port.challenged).toEqual([]);
    rmSync(join(folder, FILE));
    expect((await rig({}, { journal: new FileJournal(folder), port: damaged.port }).dispute.challengeDelivery(delivery())).ok).toBe(true);
  });

  const WRONG_FORMS: Array<[string, unknown]> = [
    ['a step that does not exist', { ...record(), step: 'finished' }],
    ['a member that the record does not have', { ...record(), extra: 1 }],
    ['an escrow that is not an output reference', { ...record(), escrow: 'zq9' }],
    ['the record of another job', record({ escrow: ESCROW_2 })],
  ];

  it.each(WRONG_FORMS)('says journal_unavailable for a file that holds %s, and sends nothing', async (_name, stored) => {
    const folder = tempFolder();
    writeFileSync(join(folder, FILE), JSON.stringify(stored));
    const { port, dispute } = rig({}, { journal: new FileJournal(folder) });
    port.claims = [claimView()];
    expectNotFiled(await dispute.challengeDelivery(delivery()), 'journal_unavailable');
    expect(port.published).toEqual([]);
    expect(port.challenged).toEqual([]);
  });

  it('sends nothing when the record started cannot be stored, leaves no file, and goes on with a journal that works', async () => {
    const folder = tempFolder();
    const down = rig({}, { journal: new FileJournal(folder, { fs: { rename: async () => { throw fault('EIO'); } } }) });
    down.port.claims = [claimView()];
    const result = await down.dispute.challengeDelivery(delivery());
    expectNotFiled(result, 'journal_unavailable');
    expect(result.detail).toContain('nothing was sent');
    expect(down.port.published).toEqual([]);
    expect(readdirSync(folder)).toEqual([]);
    expect((await rig({}, { journal: new FileJournal(folder), port: down.port }).dispute.challengeDelivery(delivery())).ok).toBe(true);
  });

  it('stops the second of two processes that share the folder and the queue, in the job, and sends the evidence and the challenge once', async () => {
    const folder = tempFolder();
    const lane = new HireLane();
    const first = rig({}, { journal: new FileJournal(folder), queue: lane });
    const second = rig({}, { journal: new FileJournal(folder), queue: lane, port: first.port });
    first.port.claims = [claimView()];
    const [a, b] = await Promise.all([first.dispute.challengeDelivery(delivery()), second.dispute.challengeDelivery(delivery())]);
    expect([a.ok, b.ok].sort()).toEqual([false, true]);
    expectNotFiled(a.ok ? b : a, 'job_already_disputed');
    expect(first.port.published.length).toBe(1);
    expect(first.port.challenged.length).toBe(1);
  });
});
