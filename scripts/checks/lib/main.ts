// scripts/checks/lib/main.ts - the start of a script of a check: the real environment, the real screen and the real clock. The exit code of the script is the exit code of the run.
import { runCheck, consoleOutput, realClock } from './runner.ts';
import type { CheckDefinition } from './runner.ts';

export async function main<Extra>(def: CheckDefinition<Extra>, argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  process.exitCode = await runCheck(def, argv, { env: process.env, out: consoleOutput, clock: realClock });
}
