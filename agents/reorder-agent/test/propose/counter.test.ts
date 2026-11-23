// agents/reorder-agent/test/propose/counter.test.ts: the counter of purchase order numbers. A number is stored before `next` gives it out, and a number is never given twice: not to two calls at one time,
// not after a restart, and not after a write that failed in the middle. A gap is allowed. A file that is damaged is an error and never a new start at 1. Each refusal has an accepted twin.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FilePoCounter, MemoryPoCounter } from '../../src/propose/counter.ts';

const dirs: string[] = [];
const folder = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'reorder-counter-'));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const BAD_TENANTS = ['Run1', 'run_1', 'run.1', '', '-run', 'x'.repeat(49), '__proto__'];

describe('the counter in memory', () => {
  it('gives 1, 2 and 3 for one tenant, and counts each tenant on its own', async () => {
    const counter = new MemoryPoCounter();
    expect([await counter.next('run1'), await counter.next('run1'), await counter.next('run2'), await counter.next('run1')]).toStrictEqual([1, 2, 1, 3]);
  });

  it('never gives a number twice to calls at one time', async () => {
    const counter = new MemoryPoCounter();
    const numbers = await Promise.all(Array.from({ length: 50 }, () => counter.next('run1')));
    expect([...numbers].sort((a, b) => a - b)).toStrictEqual(Array.from({ length: 50 }, (_, index) => index + 1));
  });

  it('refuses a tenant that a purchase order number cannot hold, and takes the longest one that it can hold', async () => {
    const counter = new MemoryPoCounter();
    for (const tenant of BAD_TENANTS) await expect(counter.next(tenant), tenant).rejects.toThrow(TypeError);
    expect(await counter.next('x'.repeat(48))).toBe(1);
    expect(await counter.next('run1')).toBe(1);
  });
});

describe('the counter in a file', () => {
  it('starts at 1 when there is no file, and keeps one JSON object with the last number of each tenant, in a file that only its owner reads', async () => {
    const path = join(folder(), 'po-numbers.json');
    const counter = new FilePoCounter(path);
    expect(existsSync(path)).toBe(false);
    expect([await counter.next('run1'), await counter.next('run1'), await counter.next('run2')]).toStrictEqual([1, 2, 1]);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toStrictEqual({ run1: 2, run2: 1 });
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('stores the number before it gives it out: the file holds the number while the call waits for the sync of the folder', async () => {
    const dir = folder();
    const path = join(dir, 'po-numbers.json');
    const calls: string[] = [];
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const counter = new FilePoCounter(path, {
      fs: {
        rename: async (from, to) => {
          calls.push('rename');
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
  });

  it('never gives a number twice: not to calls at one time, not to a new counter on the same file, and not to another tenant', async () => {
    const path = join(folder(), 'po-numbers.json');
    const first = new FilePoCounter(path);
    const numbers = await Promise.all(Array.from({ length: 20 }, () => first.next('run1')));
    expect([...numbers].sort((a, b) => a - b)).toStrictEqual(Array.from({ length: 20 }, (_, index) => index + 1));
    const second = new FilePoCounter(path);
    expect(await second.next('run1')).toBe(21);
    expect(await second.next('run2')).toBe(1);
    expect(await second.next('run1')).toBe(22);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toStrictEqual({ run1: 22, run2: 1 });
  });

  it('gives no number for a write that failed, leaves the file whole and the folder clean, and then gives that number', async () => {
    const dir = folder();
    const path = join(dir, 'po-numbers.json');
    let broken = false;
    const counter = new FilePoCounter(path, {
      fs: {
        rename: async (from, to) => {
          if (broken) throw new Error('the disk is full');
          await rename(from, to);
        },
      },
    });
    expect(await counter.next('run1')).toBe(1);
    broken = true;
    await expect(counter.next('run1')).rejects.toThrow('the disk is full');
    expect(JSON.parse(readFileSync(path, 'utf8'))).toStrictEqual({ run1: 1 });
    expect(readdirSync(dir)).toStrictEqual(['po-numbers.json']);
    broken = false;
    expect(await counter.next('run1')).toBe(2);
  });

  it('gives a later number, and never an earlier one, after a call whose sync of the folder failed: the file may already hold that number', async () => {
    const dir = folder();
    const path = join(dir, 'po-numbers.json');
    let broken = false;
    const counter = new FilePoCounter(path, {
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
    const path = join(folder(), 'po-numbers.json');
    const counter = new FilePoCounter(path);
    const results = await Promise.allSettled([counter.next('run1'), counter.next('Run1'), counter.next('run1')]);
    expect(results.map((result) => result.status)).toStrictEqual(['fulfilled', 'rejected', 'fulfilled']);
    expect(results.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []))).toStrictEqual([1, 2]);
  });

  it('refuses a tenant that a purchase order number cannot hold, and writes no file for it', async () => {
    const path = join(folder(), 'po-numbers.json');
    const counter = new FilePoCounter(path);
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
    ['a number that is too large', '{"run1":9007199254740992}'],
    ['a tenant that a number cannot hold', '{"Run1":3}'],
    ['the key __proto__', '{"__proto__":3}'],
  ];
  it.each(DAMAGED)('is an error for a file with %s: no number, and the file is not changed', async (_name, text) => {
    const path = join(folder(), 'po-numbers.json');
    writeFileSync(path, text);
    const counter = new FilePoCounter(path);
    const error = await counter.next('run1').then(
      () => null,
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/damaged/);
    expect((error as Error).message).not.toContain(text === '' ? 'zq' : text);
    expect(readFileSync(path, 'utf8')).toBe(text);
  });

  it('gives the next number for a file with a right body, which is the twin of the damaged files', async () => {
    const path = join(folder(), 'po-numbers.json');
    writeFileSync(path, '{"run1":4,"run2":0}\n');
    const counter = new FilePoCounter(path);
    expect([await counter.next('run1'), await counter.next('run2')]).toStrictEqual([5, 1]);
  });

  it('does not start again at 1 for a file that it cannot read: a folder in its place is an error, and no file is the twin', async () => {
    const dir = folder();
    const path = join(dir, 'po-numbers.json');
    mkdirSync(path);
    await expect(new FilePoCounter(path).next('run1')).rejects.toThrow(/EISDIR/);
    expect(await new FilePoCounter(join(dir, 'other.json')).next('run1')).toBe(1);
  });

  it('does not read a temporary file that a crash left behind', async () => {
    const dir = folder();
    const path = join(dir, 'po-numbers.json');
    writeFileSync(join(dir, '.po-numbers.json.0123456789abcdef.tmp'), '{"run1":99}');
    const counter = new FilePoCounter(path);
    expect(await counter.next('run1')).toBe(1);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toStrictEqual({ run1: 1 });
  });

  it('makes the folder of the file when it is missing, and refuses a path that is empty, that has a ".." segment, or whose folder is a file', () => {
    const dir = folder();
    const deep = join(dir, 'state', 'deeper', 'po-numbers.json');
    expect(() => new FilePoCounter(deep)).not.toThrow();
    expect(statSync(join(dir, 'state', 'deeper')).isDirectory()).toBe(true);
    expect(() => new FilePoCounter('')).toThrow(RangeError);
    expect(() => new FilePoCounter(`${dir}/a/../po-numbers.json`)).toThrow(RangeError);
    expect(() => new FilePoCounter(`${dir}/po\0numbers.json`)).toThrow(RangeError);
    writeFileSync(join(dir, 'plain'), 'text');
    expect(() => new FilePoCounter(join(dir, 'plain', 'po-numbers.json'))).toThrow();
  });
});
