// packages/service-kit/src/tools.ts
// Programs a service runs on what a caller sent (a PDF, a media file): started with an argument list (execFile), never through a shell, with a time limit and an
// output limit, on files in a directory that only this process can read, which is removed whatever happened. What a tool prints is the operator's: a caller is
// told a sentence of the service's own.
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

/**
 * How a tool is run. It resolves with what the tool printed when it exited 0 and rejects with the error of node's execFile otherwise: a numeric `code` is an exit
 * status, `killed` true is the time limit, a string `code` is a failure to start (ENOENT, EACCES), and ERR_CHILD_PROCESS_STDIO_MAXBUFFER is output over the limit.
 */
export type RunTool = (file: string, args: readonly string[], options: { timeoutMs: number; maxBuffer: number }) => Promise<{ stdout: string; stderr: string }>;

const execFileAsync = promisify(execFile);
export const runTool: RunTool = async (file, args, { timeoutMs, maxBuffer }) => {
  const { stdout, stderr } = await execFileAsync(file, [...args], { timeout: timeoutMs, maxBuffer, encoding: 'utf8', windowsHide: true });
  return { stdout, stderr };
};

/** The four ways a run of a tool fails: it could not be started, it ran out of time, its output was over the limit, or it exited with a status. */
export type ToolFailure = { kind: 'start'; code: string } | { kind: 'timeout' } | { kind: 'output' } | { kind: 'exit'; stderr: string };
export function toolFailure(error: unknown): ToolFailure {
  const e = (typeof error === 'object' && error !== null ? error : {}) as { code?: unknown; killed?: unknown; stderr?: unknown };
  if (e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return { kind: 'output' };
  if (typeof e.code === 'string') return { kind: 'start', code: e.code };
  if (e.killed === true) return { kind: 'timeout' };
  return { kind: 'exit', stderr: typeof e.stderr === 'string' ? e.stderr : '' };
}

/**
 * Runs `work` in a new directory that only this process can read (mkdtemp makes it 0700), and removes it afterwards, whatever happened. The removal is retried a
 * few times (a tool that was just stopped can still hold a file open on Windows) and then given up quietly: a directory that cannot be removed must not turn a
 * finished job into a failure, or hide the error that is already on its way.
 */
export async function withPrivateDir<T>(prefix: string, work: (dir: string) => Promise<T>, root: string = tmpdir()): Promise<T> {
  const dir = await mkdtemp(join(root, prefix));
  try {
    return await work(dir);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => undefined);
  }
}
