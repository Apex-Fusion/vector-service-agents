// agents/audio-snippets/src/disk.ts
// The free space a job needs in the temporary directory: the source (at most 50 MB), its decode (10 min of 16 kHz 16-bit mono, about 19 MB) and one clip at a
// time (each is read and removed before the next is cut), so about 90 MB at most. Less than 256 MiB free and the service takes no job: /healthz answers 503
// low_disk, and a job that arrives anyway is refused with the same code before it fetches a byte.
import { statfs } from 'node:fs/promises';
import { SnippetsError } from './result.ts';

/** The least free space in the temporary directory a job is started with: 256 MiB. */
export const MIN_FREE_BYTES = 268_435_456;

/** The bytes free for this process in the file system of `dir`. */
export async function freeBytes(dir: string): Promise<number> {
  const stats = await statfs(dir);
  return Number(stats.bavail) * Number(stats.bsize);
}

/** Resolves when `dir` has at least `minFree` bytes free, and rejects with low_disk (503) otherwise. */
export async function assertScratch(dir: string, minFree: number = MIN_FREE_BYTES, free: (dir: string) => Promise<number> = freeBytes): Promise<void> {
  const left = await free(dir);
  if (left < minFree) throw new SnippetsError('low_disk', `the temporary directory ${dir} has ${left} bytes free, less than the ${minFree} a job needs`);
}
