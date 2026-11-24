// scripts/operator/cli.ts - the start of the operator pack: the real environment, the real screen and the real clock. The first word is the name of a task, and the exit code of the process is the
// exit code of the run. Run it with `node --import tsx scripts/operator/cli.ts <task> [status | run | cleanup] [--submit] [--all] [--use-case <name>] [--run <label>] [the flags of the task]`.
// This file and the settings are the only files of the pack that read the process environment.
import { consoleOutput, realClock, runCli } from './lib/runner.ts';

process.exitCode = await runCli(process.argv.slice(2), { env: process.env, out: consoleOutput, clock: realClock });
