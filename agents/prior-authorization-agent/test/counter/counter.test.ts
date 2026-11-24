// agents/prior-authorization-agent/test/counter/counter.test.ts: the counter of request numbers. A number is stored before `next` gives it out, and a number is never given twice: not to two calls at one time,
// not after a restart, and not after a write that failed in the middle. A gap is allowed. A file that is damaged or that cannot be read is an error and never a new start at 1. Calls of one counter run one at a
// time. A message that the counter writes never repeats the path or what the file holds. Each refusal has an accepted twin.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { requestNumberOf } from '@vsa/usecase-kit/priorauth';
import { FileRequestCounter, MemoryRequestCounter } from '../../src/counter/index.ts';
import type { CounterFs } from '../../src/counter/index.ts';

const dirs: string[] = [];
const folder = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'prior-counter-'));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const BAD_TENANTS = ['Run1', 'run_1', 'run.1', '', '-run', 'x'.repeat(49), '__proto__'];

/** The error that a promise rejects with. A promise that settles, or that rejects with a value that is no error, fails the test. */
async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Error) return error;
    throw new Error('the promise rejected with a value that is no error');
  }
  throw new Error('the promise settled, and the test expected a rejection');
}

/** The error that an action throws. An action that returns fails the test. */
function thrownBy(action: () => unknown): Error {
  try {
    action();
  } catch (error) {
    if (error instanceof Error) return error;
    throw new Error('the action threw a value that is no error');
  }
  throw new Error('the action returned, and the test expected a throw');
}

describe('the counter in memory', () => {
  it('gives 1, 2 and 3 for one tenant, and counts each tenant on its own', async () => {
    const counter = new MemoryRequestCounter();
    expect([await counter.next('run1'), await counter.next('run1'), await counter.next('run2'), await counter.next('run1')]).toStrictEqual([1, 2, 1, 3]);
  });

  it('gives the request number `<tenant>-1` for the first number of a tenant, and `<tenant>-2` for the second', async () => {
    const counter = new MemoryRequestCounter();
    expect(requestNumberOf('run1', await counter.next('run1'))).toBe('run1-1');
    expect(requestNumberOf('run1', await counter.next('run1'))).toBe('run1-2');
    expect(requestNumberOf('run2', await counter.next('run2'))).toBe('run2-1');
  });

  it('never gives a number twice to calls at one time', async () => {
    const counter = new MemoryRequestCounter();
    const numbers = await Promise.all(Array.from({ length: 50 }, () => counter.next('run1')));
    expect([...numbers].sort((a, b) => a - b)).toStrictEqual(Array.from({ length: 50 }, (_, index) => index + 1));
  });

  it('refuses a tenant that a request number cannot hold, and takes the longest one that it can hold', async () => {
    const counter = new MemoryRequestCounter();
    for (const tenant of BAD_TENANTS) await expect(counter.next(tenant), tenant).rejects.toThrow(TypeError);
    expect(await counter.next('x'.repeat(48))).toBe(1);
    expect(await counter.next('run1')).toBe(1);
  });
});

describe('the counter in a file', () => {
  it('starts at 1 when there is no file, and keeps one JSON object with the last number of each tenant, in a file that only its owner reads', async () => {
    const path = join(folder(), 'request-numbers.json');
    const counter = new FileRequestCounter(path);
    expect(existsSync(path)).toBe(false);
    expect([await counter.next('run1'), await counter.next('run1'), await counter.next('run2')]).toStrictEqual([1, 2, 1]);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toStrictEqual({ run1: 2, run2: 1 });
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('gives the request number `<tenant>-1` for the first number of a tenant in a new file', async () => {
    const counter = new FileRequestCounter(join(folder(), 'request-numbers.json'));
    expect(requestNumberOf('run1', await counter.next('run1'))).toBe('run1-1');
  });

  it('stores the number before it gives it out: the file holds the number while the call waits for the sync of the folder', async () => {
    const dir = folder();
    const path = join(dir, 'request-numbers.json');
    const calls: string[] = [];
    const renamed: { from: string; to: string }[] = [];
    // The package compiles for es2022, whose library has no Promise.withResolvers, so the executor form is the one that types here.
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const counter = new FileRequestCounter(path, {
      fs: {
        rename: async (from, to) => {
          calls.push('rename');
          renamed.push({ from, to });
          await rename(from, to);
        },
        fsync: async (target) => {
          calls.push(target === dir ? 'sync folder' : 'sync file');
          if (target === dir) await gate;
        },
      },
    });
    let answered = false;
    const taken = counter.next('run1').then((number) => {
      answered = true;
      return number;
    });
    await vi.waitFor(() => expect(calls).toContain('sync folder'));
    expect(answered).toBe(false);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toStrictEqual({ run1: 1 });
    release();
    expect(await taken).toBe(1);
    expect(calls).toStrictEqual(['sync file', 'rename', 'sync folder']);
    // The write went through a temporary file in the folder of the counter file, with a name that is not the name of the counter file.
    expect(renamed).toHaveLength(1);
    expect(renamed[0]?.to).toBe(path);
    expect(dirname(renamed[0]?.from ?? '')).toBe(dir);
    expect(basename(renamed[0]?.from ?? '')).toMatch(/^\.request-numbers\.json\.[0-9a-f]{16}\.tmp$/);
  });

  it('never gives a number twice: not to calls at one time, not to a new counter on the same file, and not to another tenant', async () => {
    const path = join(folder(), 'request-numbers.json');
    const first = new FileRequestCounter(path);
    const numbers = await Promise.all(Array.from({ length: 20 }, () => first.next('run1')));
    expect([...numbers].sort((a, b) => a - b)).toStrictEqual(Array.from({ length: 20 }, (_, index) => index + 1));
    const second = new FileRequestCounter(path);
    expect(await second.next('run1')).toBe(21);
    expect(await second.next('run2')).toBe(1);
    expect(await second.next('run1')).toBe(22);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toStrictEqual({ run1: 22, run2: 1 });
  });

  it('goes on from the stored number with a new instance: the first number after a restart is the stored number and one more', async () => {
    const path = join(folder(), 'request-numbers.json');
    const before = new FileRequestCounter(path);
    expect([await before.next('run1'), await before.next('run1'), await before.next('run1')]).toStrictEqual([1, 2, 3]);
    const after = new FileRequestCounter(path);
    expect(requestNumberOf('run1', await after.next('run1'))).toBe('run1-4');
  });

  it('runs the calls of one counter one at a time, in the order of the calls: a call reads the file only after the call before it synced the folder', async () => {
    const dir = folder();
    const path = join(dir, 'request-numbers.json');
    const events: string[] = [];
    const counter = new FileRequestCounter(path, {
      fs: {
        readFile: async (target) => {
          events.push('read');
          return readFile(target, 'utf8');
        },
        fsync: async (target) => {
          events.push(target === dir ? 'sync folder' : 'sync file');
        },
      },
    });
    const numbers = await Promise.all([counter.next('run1'), counter.next('run1'), counter.next('run1')]);
    expect(numbers).toStrictEqual([1, 2, 3]);
    expect(events).toStrictEqual(['read', 'sync file', 'sync folder', 'read', 'sync file', 'sync folder', 'read', 'sync file', 'sync folder']);
  });

  it.each([
    ['the write of the temporary file', 'writeFile'],
    ['the sync of the temporary file', 'fsync'],
    ['the rename', 'rename'],
  ] as const)('gives no number for a store that fails at %s, leaves the file whole and the folder clean, and then gives that number', async (_name, step) => {
    const dir = folder();
    const path = join(dir, 'request-numbers.json');
    let broken = false;
    const fs: Partial<CounterFs> = {
      writeFile: async (target, text) => {
        if (broken && step === 'writeFile') throw new Error('the disk is full');
        await writeFile(target, text, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      },
      fsync: async (target) => {
        if (broken && step === 'fsync' && target !== dir) throw new Error('the disk is full');
      },
      rename: async (from, to) => {
        if (broken && step === 'rename') throw new Error('the disk is full');
        await rename(from, to);
      },
    };
    const counter = new FileRequestCounter(path, { fs });
    expect(await counter.next('run1')).toBe(1);
    broken = true;
    await expect(counter.next('run1')).rejects.toThrow('the disk is full');
    expect(JSON.parse(readFileSync(path, 'utf8'))).toStrictEqual({ run1: 1 });
    expect(readdirSync(dir)).toStrictEqual(['request-numbers.json']);
    broken = false;
    expect(await counter.next('run1')).toBe(2);
    expect(readdirSync(dir)).toStrictEqual(['request-numbers.json']);
  });

  it('gives the error of the store, and not the error of the removal, when the removal of the temporary file fails too: the temporary file stays, and the next call goes on', async () => {
    const dir = folder();
    const path = join(dir, 'request-numbers.json');
    let broken = false;
    const counter = new FileRequestCounter(path, {
      fs: {
        rename: async (from, to) => {
          if (broken) throw new Error('the disk is full');
          await rename(from, to);
        },
        unlink: async () => {
          throw new Error('the removal failed');
        },
      },
    });
    expect(await counter.next('run1')).toBe(1);
    broken = true;
    const error = await rejection(counter.next('run1'));
    expect(error.message).toBe('the disk is full');
    expect(readdirSync(dir).filter((name) => name.endsWith('.tmp'))).toHaveLength(1);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toStrictEqual({ run1: 1 });
    broken = false;
    expect(await counter.next('run1')).toBe(2);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toStrictEqual({ run1: 2 });
  });

  it('gives a later number, and never an earlier one, after a call whose sync of the folder failed: the file may already hold that number', async () => {
    const dir = folder();
    const path = join(dir, 'request-numbers.json');
    let broken = false;
    const counter = new FileRequestCounter(path, {
      fs: {
        fsync: async (target) => {
          if (broken && target === dir) throw new Error('the sync failed');
        },
      },
    });
    expect(await counter.next('run1')).toBe(1);
    broken = true;
    await expect(counter.next('run1')).rejects.toThrow('the sync failed');
    expect(JSON.parse(readFileSync(path, 'utf8'))).toStrictEqual({ run1: 2 });
    broken = false;
    expect(await counter.next('run1')).toBe(3);
  });

  it('keeps going after a call that failed: the calls behind it still get their numbers', async () => {
    const path = join(folder(), 'request-numbers.json');
    const counter = new FileRequestCounter(path);
    const results = await Promise.allSettled([counter.next('run1'), counter.next('Run1'), counter.next('run1')]);
    expect(results.map((result) => result.status)).toStrictEqual(['fulfilled', 'rejected', 'fulfilled']);
    expect(results.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []))).toStrictEqual([1, 2]);
  });

  it('refuses a tenant that a request number cannot hold, and writes no file for it', async () => {
    const path = join(folder(), 'request-numbers.json');
    const counter = new FileRequestCounter(path);
    for (const tenant of BAD_TENANTS) await expect(counter.next(tenant), tenant).rejects.toThrow(TypeError);
    expect(existsSync(path)).toBe(false);
    expect(await counter.next('x'.repeat(48))).toBe(1);
  });

  const DAMAGED: [string, string][] = [
    ['text that is not JSON', 'not json'],
    ['no text at all', ''],
    ['a list', '[1,2]'],
    ['null', 'null'],
    ['a number', '7'],
    ['a negative number', '{"run1":-1}'],
    ['a fraction', '{"run1":1.5}'],
    ['a number as text', '{"run1":"3"}'],
    ['a null in place of a number', '{"run1":null}'],
    ['a boolean in place of a number', '{"run1":true}'],
    ['an object in place of a number', '{"run1":{"last":3}}'],
    ['a number that is too large', '{"run1":9007199254740992}'],
    ['a tenant that a number cannot hold', '{"Run1":3}'],
    ['a tenant that is too long', `{"${'x'.repeat(49)}":3}`],
    ['the key __proto__', '{"__proto__":3}'],
    ['text after the object', '{"run1":3} more'],
  ];
  it.each(DAMAGED)('is an error for a file with %s: no number, the file is not changed, and the message repeats neither the path nor the text of the file', async (_name, text) => {
    const dir = folder();
    const path = join(dir, 'request-numbers.json');
    writeFileSync(path, text);
    const counter = new FileRequestCounter(path);
    const error = await rejection(counter.next('run1'));
    expect(error.message).toMatch(/damaged/);
    expect(error.message).not.toContain(text === '' ? 'zq' : text);
    expect(error.message).not.toContain(dir);
    expect(error.message).not.toContain(basename(path));
    expect(readFileSync(path, 'utf8')).toBe(text);
    expect(readdirSync(dir)).toStrictEqual(['request-numbers.json']);
  });

  it('gives the next number for a file with a right body, which is the twin of the damaged files', async () => {
    const path = join(folder(), 'request-numbers.json');
    writeFileSync(path, '{"run1":4,"run2":0}\n');
    const counter = new FileRequestCounter(path);
    expect([await counter.next('run1'), await counter.next('run2')]).toStrictEqual([5, 1]);
  });

  it('does not start again at 1 for a file that it cannot read: a folder in its place is an error, and no file is the twin', async () => {
    const dir = folder();
    const path = join(dir, 'request-numbers.json');
    mkdirSync(path);
    await expect(new FileRequestCounter(path).next('run1')).rejects.toThrow(/EISDIR/);
    expect(await new FileRequestCounter(join(dir, 'other.json')).next('run1')).toBe(1);
  });

  it.each(['EACCES', 'EIO', 'EISDIR', 'EMFILE'])('is an error for a read that fails with the code %s, and writes nothing: only a file that is not there is an empty counter', async (code) => {
    const dir = folder();
    const path = join(dir, 'request-numbers.json');
    let failing = code;
    const counter = new FileRequestCounter(path, {
      fs: {
        readFile: async () => {
          throw Object.assign(new Error(`the read failed with ${failing}`), { code: failing });
        },
      },
    });
    await expect(counter.next('run1')).rejects.toThrow(`the read failed with ${code}`);
    expect(readdirSync(dir)).toStrictEqual([]);
    // The twin: the same read that fails with the code ENOENT is a file that is not there, so the counter starts at 1.
    failing = 'ENOENT';
    expect(await counter.next('run1')).toBe(1);
  });

  it('does not read a temporary file that a crash left behind', async () => {
    const dir = folder();
    const path = join(dir, 'request-numbers.json');
    writeFileSync(join(dir, '.request-numbers.json.0123456789abcdef.tmp'), '{"run1":99}');
    const counter = new FileRequestCounter(path);
    expect(await counter.next('run1')).toBe(1);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toStrictEqual({ run1: 1 });
  });

  it('gives the largest number that a double holds exactly, and then stops with a RangeError and leaves the file as it was', async () => {
    const path = join(folder(), 'request-numbers.json');
    writeFileSync(path, `{"run1":${Number.MAX_SAFE_INTEGER - 1}}\n`);
    const counter = new FileRequestCounter(path);
    expect(await counter.next('run1')).toBe(Number.MAX_SAFE_INTEGER);
    const stored = readFileSync(path, 'utf8');
    await expect(counter.next('run1')).rejects.toThrow(RangeError);
    expect(readFileSync(path, 'utf8')).toBe(stored);
    // Another tenant is not at its largest number.
    expect(await counter.next('run2')).toBe(1);
  });

  it('makes the folder of the file when it is missing, and refuses a path whose folder is a file', () => {
    const dir = folder();
    const deep = join(dir, 'state', 'deeper', 'request-numbers.json');
    expect(() => new FileRequestCounter(deep)).not.toThrow();
    expect(statSync(join(dir, 'state', 'deeper')).isDirectory()).toBe(true);
    writeFileSync(join(dir, 'plain'), 'text');
    expect(() => new FileRequestCounter(join(dir, 'plain', 'request-numbers.json'))).toThrow();
  });

  it.each([
    ['a path that is not text', 7, TypeError],
    ['no path', undefined, TypeError],
    ['an empty path', '', RangeError],
    ['a path with a NUL character', 'dir/request\0numbers.json', RangeError],
    ['a path with a ".." segment', 'dir/a/../request-numbers.json', RangeError],
    ['a path with a ".." segment after a backslash', 'dir\\a\\..\\request-numbers.json', RangeError],
  ] as const)('refuses %s, and the message never repeats the path', (_name, given, kind) => {
    const dir = folder();
    const path = typeof given === 'string' && given !== '' ? given.replace('dir', dir) : given;
    const error = thrownBy(() => new FileRequestCounter(path as string));
    expect(error).toBeInstanceOf(kind);
    expect(error.message).not.toContain(dir);
    expect(error.message).not.toContain('request');
  });

  it('takes a path with a dot inside a name: only a segment that is exactly ".." is refused', () => {
    const dir = folder();
    expect(() => new FileRequestCounter(join(dir, 'a..b', 'request-numbers.json'))).not.toThrow();
    expect(() => new FileRequestCounter(join(dir, '..a', 'request-numbers.json'))).not.toThrow();
  });
});
