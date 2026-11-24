// services/mock-systems/test/support/child.ts
// Use the child's output for readiness. Use independent watchdogs for startup, the operation under test, and cleanup.
import { spawn } from 'node:child_process';
import type { ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const SERVICE_DIR = fileURLToPath(new URL('../../', import.meta.url));
export const CHILD_START_MS = 60_000;
export const CHILD_PROBE_MS = 10_000;
const CHILD_EXIT_MS = 10_000;
export const CHILD_CLEANUP_MS = 5_000;
export const CHILD_TEST_MS = CHILD_START_MS + CHILD_PROBE_MS + CHILD_EXIT_MS + CHILD_CLEANUP_MS + 5_000;

interface Exit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

interface ChildOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  label: string;
}

export function mockChild(entry: string, settings: NodeJS.ProcessEnv): Child {
  const env = { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...settings };
  return new Child(process.execPath, ['--import', 'tsx', entry], { cwd: SERVICE_DIR, env, label: entry });
}

export class Child {
  private out = '';
  private err = '';
  private readonly process: ChildProcessByStdio<null, Readable, Readable>;
  private readonly closed: Promise<Exit>;
  private failure?: Error;
  private readonly label: string;

  constructor(command: string, args: readonly string[], { cwd, env, label }: ChildOptions) {
    this.label = label;
    this.process = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    this.process.stdout.setEncoding('utf8').on('data', (text: string) => { this.out += text; });
    this.process.stderr.setEncoding('utf8').on('data', (text: string) => { this.err += text; });
    this.process.on('error', (error) => { this.failure = error; });
    this.closed = new Promise<Exit>((resolve) => {
      this.process.once('close', (code, signal) => { resolve({ code, signal }); });
    });
  }

  get stdout(): string {
    return this.out;
  }

  get stderr(): string {
    return this.err;
  }

  diagnostics(): string {
    return `${this.label}\nstdout: ${this.out || '(empty)'}\nstderr: ${this.err || '(empty)'}`;
  }

  private async within<T>(work: Promise<T>, phase: string, ms: number): Promise<T> {
    const cancel = new AbortController();
    try {
      const expired = delay(ms, undefined, { signal: cancel.signal }).then(() => {
        throw new Error(`${phase} timed out after ${ms} ms\n${this.diagnostics()}`, { cause: this.failure });
      });
      return await Promise.race([work, expired]);
    } finally {
      cancel.abort();
    }
  }

  /** Wait for a marker from this child. Do not count this time against its exit. */
  async waitFor(pattern: RegExp, phase: string, ms = CHILD_START_MS): Promise<RegExpExecArray> {
    let check!: () => void;
    const ready = new Promise<RegExpExecArray>((resolve) => { check = () => {
      const match = pattern.exec(this.out);
      if (match !== null) resolve(match);
    }; });
    this.process.stdout.on('data', check);
    check();
    try {
      const result = await this.within(Promise.race([ready, this.closed]), phase, ms);
      if (Array.isArray(result)) return result;
      throw new Error(`the child exited (${JSON.stringify(result)}) during ${phase}\n${this.diagnostics()}`, { cause: this.failure });
    } finally {
      this.process.stdout.off('data', check);
    }
  }

  signal(name: NodeJS.Signals): void {
    this.process.kill(name);
  }

  async waitForExit(phase: string, ms = CHILD_EXIT_MS): Promise<Exit> {
    const result = await this.within(this.closed, phase, ms);
    if (this.failure !== undefined) throw new Error(`child process error during ${phase}\n${this.diagnostics()}`, { cause: this.failure });
    return result;
  }

  async cleanup(): Promise<void> {
    if (this.process.pid !== undefined && this.process.exitCode === null && this.process.signalCode === null) this.process.kill('SIGKILL');
    await this.within(this.closed, 'child cleanup', CHILD_CLEANUP_MS);
  }
}
