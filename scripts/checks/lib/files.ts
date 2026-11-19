// scripts/checks/lib/files.ts - how the checks write the files that they own (the state file and the evidence file): whole, with mode 600, in a folder with mode 700.
import { closeSync, fchmodSync, fsyncSync, mkdirSync, openSync, renameSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

export interface WriteIo {
  rename(from: string, to: string): void;
}

const realIo: WriteIo = { rename: renameSync };

/** The codes of a platform that cannot flush a folder: the rename stands, unflushed. */
const CANNOT_FLUSH: Record<string, true> = { EPERM: true, EINVAL: true, EISDIR: true };
const cannotFlush = (err: unknown): boolean => CANNOT_FLUSH[(err as NodeJS.ErrnoException).code ?? ''] === true;

function flushFolder(folder: string): void {
  let fd: number;
  try { fd = openSync(folder, 'r'); } catch (err) {
    if (cannotFlush(err)) return;
    throw err;
  }
  try { fsyncSync(fd); } catch (err) {
    if (!cannotFlush(err)) throw err;
  } finally { closeSync(fd); }
}

/**
 * Writes `text` to `path` as one complete file: to a temporary file next to it (mode 600, every byte written and flushed), then renamed over `path`. A failure at any point leaves
 * the old file as it was. The folder is made with mode 700 when it is not there.
 */
export function writeFileAtomically(path: string, text: string, io: Partial<WriteIo> = {}): void {
  const files = { ...realIo, ...io };
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp`;
  const bytes = Buffer.from(text, 'utf8');
  const fd = openSync(temporary, 'w', 0o600);
  try {
    fchmodSync(fd, 0o600);
    for (let written = 0; written < bytes.length;) {
      const n = writeSync(fd, bytes, written, bytes.length - written);
      if (n <= 0) throw new Error(`the write of ${temporary} made no progress`);
      written += n;
    }
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  files.rename(temporary, path);
  flushFolder(dirname(path));
}
