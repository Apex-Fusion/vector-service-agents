// services/mock-systems/test/support/child.ts
// A child process that runs a TypeScript entry of the service with node and tsx, the way the image runs it (`node --import tsx <entry>`), in the folder of the service. The tests that need a
// real process (the production entry, the stop on a signal) use it. The child gets the environment that the test gives and nothing else but the search path, so that no setting of the machine
// reaches it. A child that does not end in time is killed, and the test fails with what it wrote.
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** The folder of the service: the working folder of a child. */
export const SERVICE_DIR = fileURLToPath(new URL('../../', import.meta.url));

export interface Exit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

/** The environment of a child: the search path of the machine, and the settings that the test gives. */
export const childEnvironment = (settings: NodeJS.ProcessEnv): NodeJS.ProcessEnv => ({ PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...settings });

export class Child {
  private out = '';
  private err = '';
  private readonly process: ChildProcess;
  private readonly watchers = new Set<() => void>();
  /** The end of the child. It rejects when the child does not end in `timeoutMs`. */
  readonly exit: Promise<Exit>;

  constructor(entry: string, env: NodeJS.ProcessEnv, timeoutMs = 45_000) {
    this.process = spawn(process.execPath, ['--import', 'tsx', entry], { cwd: SERVICE_DIR, env, stdio: ['ignore', 'pipe', 'pipe'] });
    this.process.stdout!.setEncoding('utf8').on('data', (text: string) => {
      this.out += text;
      for (const check of [...this.watchers]) check();
    });
    this.process.stderr!.setEncoding('utf8').on('data', (text: string) => { this.err += text; });
    this.exit = new Promise<Exit>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.process.kill('SIGKILL');
        reject(new Error(`the child did not end in ${timeoutMs} ms\nstdout: ${this.out}\nstderr: ${this.err}`));
      }, timeoutMs);
      this.process.once('error', reject);
      this.process.once('close', (code, signal) => {
        clearTimeout(timer);
        resolve({ code, signal });
      });
    });
    // A test that never reads `exit` must not fail with an error that nobody caught.
    this.exit.catch(() => undefined);
  }

  get stdout(): string {
    return this.out;
  }

  get stderr(): string {
    return this.err;
  }

  /** Resolves when the standard output holds `text`. Rejects when the child ends first. */
  waitFor(text: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const check = (): void => {
        if (!this.out.includes(text)) return;
        this.watchers.delete(check);
        resolve();
      };
      this.watchers.add(check);
      check();
      this.exit.then((ended) => reject(new Error(`the child ended (${JSON.stringify(ended)}) before it wrote ${text}\nstdout: ${this.out}\nstderr: ${this.err}`)), reject);
    });
  }

  signal(name: NodeJS.Signals): void {
    this.process.kill(name);
  }
}
