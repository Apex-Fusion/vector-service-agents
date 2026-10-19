// packages/hire-kit/test/stranded-write.test.ts
// How the stranded store writes its file, with node:fs watched and steered: a write is repeated until every byte is down (writeSync may write less than
// it is given), the temporary file is flushed before it is renamed over the old one, and the directory is flushed after the rename so the rename
// itself survives a crash. A platform that cannot flush a directory (Windows answers EPERM) is let be; any other failure of that flush is not.
// In a file of its own: the mock of node:fs holds for every test of the file.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const watch = vi.hoisted(() => ({
  /** The most bytes one writeSync call writes. */
  chunk: Number.POSITIVE_INFINITY,
  /** The error the flush of the directory throws, when set. */
  dirSyncError: null as NodeJS.ErrnoException | null,
  /** The directory whose descriptor counts as the store's directory. */
  dir: '',
  events: [] as string[],
}));

vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  const dirFds = new Set<number>();
  return {
    ...fs,
    openSync: ((path: string, flags: string) => {
      const fd = fs.openSync(path, flags);
      if (path === watch.dir) dirFds.add(fd);
      watch.events.push(path === watch.dir ? 'open dir' : 'open file');
      return fd;
    }) as typeof fs.openSync,
    writeSync: ((fd: number, data: string | NodeJS.ArrayBufferView, offset?: number, length?: number) => {
      // A short write, the way the system may do it: at most `chunk` bytes of what was asked, the count returned.
      const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
      const from = typeof data === 'string' ? 0 : (offset ?? 0);
      const asked = typeof data === 'string' ? bytes.length : (length ?? bytes.length - from);
      watch.events.push('write');
      return fs.writeSync(fd, bytes, from, Math.min(asked, watch.chunk));
    }) as typeof fs.writeSync,
    fsyncSync: ((fd: number) => {
      const isDir = dirFds.has(fd);
      watch.events.push(isDir ? 'fsync dir' : 'fsync file');
      if (isDir && watch.dirSyncError !== null) throw watch.dirSyncError;
      if (isDir) return undefined;
      return fs.fsyncSync(fd);
    }) as typeof fs.fsyncSync,
    closeSync: ((fd: number) => { dirFds.delete(fd); return fs.closeSync(fd); }) as typeof fs.closeSync,
    renameSync: ((from: string, to: string) => { watch.events.push('rename'); return fs.renameSync(from, to); }) as typeof fs.renameSync,
  };
});

const { StrandedStore } = await import('../src/janitor.ts');

const ENTRY = { escrow_ref: `${'ab'.repeat(32)}#0`, deliver_by: 1_790_000_480_000, posted_at: 1_790_000_000_000, kind: 'ocr' as const };
const errno = (code: string): NodeJS.ErrnoException => Object.assign(new Error(`${code}: the flush of the directory failed`), { code });

let dir = '';
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pipeline-store-write-'));
  Object.assign(watch, { chunk: Number.POSITIVE_INFINITY, dirSyncError: null, dir, events: [] });
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('StrandedStore writes', () => {
  it('writes the whole list however few bytes each write takes', () => {
    watch.chunk = 7;
    const store = new StrandedStore(dir);
    store.add(ENTRY);
    store.add({ ...ENTRY, escrow_ref: `${'cd'.repeat(32)}#1`, kind: 'llm' });
    expect(JSON.parse(readFileSync(join(dir, 'stranded.json'), 'utf8'))).toStrictEqual(store.list());
    expect(watch.events.filter((e) => e === 'write').length).toBeGreaterThan(20);
  });

  it('flushes the temporary file, renames it over the old one, then flushes the directory', () => {
    const store = new StrandedStore(dir);
    store.add(ENTRY);
    expect(watch.events.filter((e) => e !== 'write')).toStrictEqual(['open file', 'fsync file', 'rename', 'open dir', 'fsync dir']);
  });

  it('lets a platform that cannot flush a directory be (EPERM, EINVAL, EISDIR), and refuses any other failure of the flush', () => {
    const store = new StrandedStore(dir);
    for (const code of ['EPERM', 'EINVAL', 'EISDIR']) {
      watch.dirSyncError = errno(code);
      expect(() => store.add({ ...ENTRY, deliver_by: ENTRY.deliver_by + code.length })).not.toThrow();
    }
    watch.dirSyncError = errno('EIO');
    expect(() => store.add(ENTRY)).toThrow(/EIO/);
  });
});
