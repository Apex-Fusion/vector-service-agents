// The command line, the runner and the steps of a task, with a toy task of two steps and a cleanup that runs through the real runner: the grammar, a dry run, the approval, one step or all steps,
// a wait, a failure, a transaction in flight (late and lost, with the reserve of the cap), the status, the run lock, the facts file, the exit code of each kind of error, and the machine line.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { EvidenceError } from '../../checks/lib/evidence.ts';
import { iso } from '../../checks/lib/format.ts';
import { DryStop } from '../../checks/lib/hire-types.ts';
import { HostedError } from '../../checks/lib/hosted.ts';
import { KeyFileError } from '../../checks/lib/keys.ts';
import { GuardRefusal, LandRefused } from '../../checks/lib/land.ts';
import { TxNotConfirmedError } from '../../checks/lib/platform.ts';
import { PreconditionError } from '../../checks/lib/session.ts';
import { SettingsError } from '../../checks/lib/settings.ts';
import { StateError } from '../../checks/lib/state.ts';
import { factsOf } from '../../checks/lib/txfacts.ts';
import { ApprovalError } from '../lib/approval.ts';
import type { GoFile } from '../lib/approval.ts';
import type { TaskDefinition, TaskSession } from '../lib/contract.ts';
import { FactsConflict, FactsError, FactsFile } from '../lib/facts.ts';
import { ToolRefused } from '../lib/land-hosted.ts';
import { LoadError } from '../lib/load.ts';
import { KeyStoreError, loadRegistry } from '../lib/registry.ts';
import type { Clock, NodeAccess } from '../../checks/lib/ports.ts';
import { FlagError, RunLockError, checkEndOfValidity, checkInputs, inputsToCheck, judgeInputs, parseArguments, reportError, runCli, runSteps, runTask, usageLines, waitFor } from '../lib/runner.ts';
import type { StepHandler } from '../lib/runner.ts';
import { TASK_NAMES } from '../tasks/names.ts';
import { MemoryOutput } from './support/fakes.ts';
import { HOUR, NOW, PREFIX, USE_CASE, hashOf, landingStep, recordingStep, taskWorld, toyTask } from './support/task-world.ts';
import type { TaskWorld } from './support/task-world.ts';

const folders: string[] = [];
afterAll(() => { for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true }); });

const DRY_LINE = 'dry run: nothing was signed or submitted. Run again with --submit to sign, submit and wait for the confirmation.';
const twoSteps = (ran: string[]): StepHandler[] => [recordingStep('one', ran), recordingStep('two', ran)];
const landing = (ran: string[]): StepHandler[] => [landingStep('one', ran, 'run', 'fee', 3_000_000n), landingStep('two', ran, 'fee', 'run', 2_000_000n)];
/** The screen of a world, emptied: a test reads only what the next run prints. */
function reset(w: TaskWorld): void {
  w.screen.lines.length = 0;
  w.screen.errors.length = 0;
}

describe('the arguments', () => {
  const def = { flags: ['extra', 'trial'], valued: ['label', 'kind'] };
  const parsed = (...argv: string[]) => parseArguments(def, argv);

  it('make a dry run of the next step by default, and take a command, --submit, --all and the global flags in any order', () => {
    expect(parsed()).toMatchObject({ command: 'run', mode: 'dry', all: false, useCase: null, run: null });
    const accepted: Array<[string[], Record<string, unknown>]> = [
      [['--submit'], { command: 'run', mode: 'submit', all: false }],
      [['status'], { command: 'status', mode: 'dry' }],
      [['cleanup', '--submit', '--all'], { command: 'cleanup', mode: 'submit', all: true }],
      [['--submit', 'cleanup'], { command: 'cleanup', mode: 'submit' }],
      [['--all'], { command: 'run', mode: 'dry', all: true }],
      [['--run', 'r1'], { run: 'r1' }],
      [['--run=r1'], { run: 'r1' }],
      [['--run', 'a'.repeat(32)], { run: 'a'.repeat(32) }],
      [['--use-case', 'inventory-reorder'], { useCase: 'inventory-reorder' }],
      [['status', '--run', 'r1', '--use-case', 'inventory-reorder'], { command: 'status', run: 'r1', useCase: 'inventory-reorder' }],
      [['run', '--submit', '--all', '--use-case', 'inventory-reorder', '--run', 'r1', '--extra', '--label', 'x', '--kind=failure'], { command: 'run', mode: 'submit', all: true, run: 'r1' }],
    ];
    for (const [argv, expected] of accepted) expect(parsed(...argv), argv.join(' ')).toMatchObject(expected);
  });
  it('read the flags of the task: a boolean flag, a valued flag with a word or with =, a value that holds = or is a command word, and the global flags', () => {
    const flags = parsed('--extra', '--label=a=b', '--kind', 'status', '--run', 'r1', '--submit', '--all').flags;
    expect(flags.has('extra')).toBe(true);
    expect(flags.has('trial')).toBe(false);
    expect(flags.value('label')).toBe('a=b');
    expect(flags.value('kind')).toBe('status');
    expect(flags.has('kind')).toBe(true);
    expect(flags.value('trial')).toBeUndefined();
    expect(flags.value('run')).toBe('r1');
    expect(flags.has('run')).toBe(true);
    expect(flags.has('use-case')).toBe(false);
    expect(flags.has('submit')).toBe(true);
    expect(flags.has('all')).toBe(true);
    expect(parsed('--kind', 'status')).toMatchObject({ command: 'run' });
    expect(parsed().flags.has('submit')).toBe(false);
  });
  it('take an empty value for a flag of the task only in the attached form: the flag is given, its value is the empty text, and the next word is not its value', () => {
    const flags = parsed('--label=', '--kind=', '--submit').flags;
    expect(flags.has('label')).toBe(true);
    expect(flags.value('label')).toBe('');
    expect(flags.value('kind')).toBe('');
    expect(flags.has('submit')).toBe(true);
    expect(parsed('--label=', 'cleanup')).toMatchObject({ command: 'cleanup' });
    expect(parsed('--label=').flags.value('label')).toBe('');
    expect(parsed().flags.has('label')).toBe(false);
    expect(parsed().flags.value('label')).toBeUndefined();
  });
  it('take the hash of a transaction with --release for the command cleanup, in both spellings, and give it to the run', () => {
    const hash = 'ab'.repeat(32);
    expect(parsed('cleanup', '--release', hash)).toMatchObject({ command: 'cleanup', release: hash, mode: 'dry' });
    expect(parsed(`--release=${hash}`, 'cleanup', '--submit')).toMatchObject({ command: 'cleanup', release: hash, mode: 'submit' });
    expect(parsed('cleanup').release).toBeNull();
    expect(parsed().release).toBeNull();
  });
  it('refuse a name that the task does not list when the task asks for it', () => {
    const flags = parsed().flags;
    expect(() => flags.has('typo')).toThrow('does not list');
    expect(() => flags.value('typo')).toThrow('does not list');
  });

  const refused: Array<[string[], string]> = [
    [['bogus'], 'unknown argument bogus'],
    [['--sumbit'], 'unknown argument --sumbit'],
    [['-s'], 'unknown argument -s'],
    [['--'], 'no command and no flag'],
    [[''], 'no command and no flag'],
    [['x'.repeat(40)], 'no command and no flag'],
    [['run', 'cleanup'], 'two commands: run and cleanup'],
    [['status', 'status'], 'two commands'],
    [['status', '--submit'], 'takes only --run and --use-case'],
    [['status', '--all'], 'takes only --run and --use-case'],
    [['status', '--extra'], 'takes only --run and --use-case'],
    [['status', '--label', 'x'], 'takes only --run and --use-case'],
    [['--label'], 'the flag --label needs a value'],
    [['--label', '--submit'], 'the flag --label needs a value'],
    [['--label=', '--label=x'], 'the flag --label is given twice'],
    [['--label=', '--label', 'x'], 'the flag --label is given twice'],
    [['status', '--label='], 'takes only --run and --use-case'],
    [['--label', ''], 'the flag --label needs a value'],
    [['--run'], 'the flag --run needs a value'],
    [['--run='], 'the flag --run needs a value'],
    [['--run', ''], 'the flag --run needs a value'],
    [['--use-case='], 'the flag --use-case needs a value'],
    [['--use-case', ''], 'the flag --use-case needs a value'],
    [['--release', 'a'.repeat(64)], '--release goes with the command cleanup only'],
    [['run', '--release', 'a'.repeat(64)], '--release goes with the command cleanup only'],
    [['status', `--release=${'a'.repeat(64)}`], 'takes only --run and --use-case'],
    [['cleanup', '--release', 'abc'], '--release is the hash of a transaction'],
    [['cleanup', `--release=${'A'.repeat(64)}`], '--release is the hash of a transaction'],
    [['cleanup', '--release='], 'the flag --release needs a value'],
    [['cleanup', '--release', ''], 'the flag --release needs a value'],
    [['cleanup', '--release', '--submit'], 'the flag --release needs a value'],
    [['cleanup', `--release=${'a'.repeat(64)}`, `--release=${'b'.repeat(64)}`], 'the flag --release is given twice'],
    [['--extra=1'], 'the flag --extra takes no value'],
    [['--submit=1'], 'the flag --submit takes no value'],
    [['--all=1'], 'the flag --all takes no value'],
    [['--run', 'Bad'], '--run is a label'],
    [['--run', 'a_b'], '--run is a label'],
    [['--run', '-x'], '--run is a label'],
    [['--run', 'a'.repeat(33)], '--run is a label'],
    [['--use-case', 'Bad Name'], '--use-case is the name of a use case'],
    [['--use-case', '9lives'], '--use-case is the name of a use case'],
    [['--submit', '--submit'], 'the flag --submit is given twice'],
    [['--extra', '--extra'], 'the flag --extra is given twice'],
    [['--label', 'a', '--label', 'b'], 'the flag --label is given twice'],
    [['--run', 'a', '--run=b'], 'the flag --run is given twice'],
  ];
  /** The message of the FlagError that a command line gives, an empty text when the command line is accepted, and a text that says so when the error is another error. */
  function refusal(...argv: string[]): string {
    try { parsed(...argv); } catch (err) { return err instanceof FlagError ? err.message : `not a FlagError: ${String(err)}`; }
    return '';
  }
  it('refuse an unknown word, two commands, a flag of the status, a flag without its value, a value for a boolean flag, a label that breaks the rule, and a flag given twice', () => {
    for (const [argv, message] of refused) expect(refusal(...argv), argv.join(' ')).toContain(message);
  });
  it('never show a value in a refusal: a key that was given as a word or as the value of an unknown flag stays out of the message', () => {
    const secret = hashOf('a word that must not be shown');
    for (const argv of [[secret], [`--secret=${secret}`], ['--secret', secret], ['--label']]) {
      const message = refusal(...argv);
      expect(message, argv.join(' ')).not.toBe('');
      expect(message).not.toContain(secret);
    }
  });
  it('refuse a task that lists a flag that every task has, a name that is no flag name, or a name twice, and accept the names of the commands as flag names', () => {
    for (const bad of [{ flags: ['submit'], valued: [] }, { flags: ['all'], valued: [] }, { flags: [], valued: ['run'] }, { flags: [], valued: ['use-case'] }, { flags: ['Bad'], valued: [] }, { flags: ['a'], valued: ['a'] }, { flags: ['a', 'a'], valued: [] }]) {
      expect(() => parseArguments(bad, []), JSON.stringify(bad)).toThrow(LoadError);
    }
    expect(parseArguments({ flags: ['status'], valued: ['cleanup'] }, ['--status', '--cleanup', 'x']).flags.has('status')).toBe(true);
  });
});

describe('a dry run', () => {
  it('shows the next step, signs and submits nothing, reads no approval file, and ends with the machine line', async () => {
    const w = await taskWorld();
    w.writeGo();
    const seen: TaskSession[] = [];
    const ran: string[] = [];
    const def = toyTask([recordingStep('one', ran, { run: async (session) => { seen.push(session); ran.push('one'); return { kind: 'dry' }; } }), recordingStep('two', ran)]);
    expect(await w.run(def)).toBe(0);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.mode).toBe('dry');
    expect(seen[0]!.go).toBeNull();
    expect(ran).toEqual(['one']);
    expect(w.node.submitted).toEqual([]);
    expect(w.state('toy').steps).toEqual({});
    expect(w.evidence('toy')).toEqual([]);
    expect(existsSync(join(w.stateDir, 'exposure.none.json'))).toBe(false);
    expect(w.screen.lines).toContain('task toy: a toy task of two steps and a cleanup');
    expect(w.screen.lines).toContain('run in dry mode, use case inventory-reorder, network vector-mainnet');
    expect(w.screen.lines).toContain(DRY_LINE);
    expect(w.machine()).toEqual({ task: 'toy', command: 'run', mode: 'dry', outcome: 'dry', exit: 0, step: 'one', result: {} });
  });
  it('needs no approval file: a missing file is no problem, for a task that needs the approval of a submit run', async () => {
    const w = await taskWorld();
    const ran: string[] = [];
    expect(await w.run(toyTask(twoSteps(ran)))).toBe(0);
    expect(ran).toEqual(['one']);
    expect(w.machine()).toMatchObject({ outcome: 'dry', exit: 0 });
  });
  it('does one step with --all too: it stops at the first step that is only shown', async () => {
    const w = await taskWorld();
    const ran: string[] = [];
    expect(await w.run(toyTask(twoSteps(ran)), '--all')).toBe(0);
    expect(ran).toEqual(['one']);
    expect(w.machine()).toMatchObject({ mode: 'dry', outcome: 'dry', step: 'one' });
  });
  it('lands a real payment in dry mode as a summary only: nothing is signed, submitted, recorded or reserved', async () => {
    const w = await taskWorld();
    const ran: string[] = [];
    expect(await w.run(toyTask(landing(ran)))).toBe(0);
    expect(w.screen.text).toContain('step one: dry mode, nothing is signed or submitted');
    expect(w.node.submitted).toEqual([]);
    expect(w.state('toy').steps).toEqual({});
    expect(w.state('toy').in_flight).toBeNull();
    expect(w.exposure()).toEqual([]);
  });
});

describe('the flags that a task reads', () => {
  it('gives the task the empty value of a flag that was written --name=, a value that was given, and no value for a flag that was not given, and refuses an empty word', async () => {
    const w = await taskWorld();
    const seen: Array<[boolean, string | undefined]> = [];
    const step: StepHandler = { name: 'one', run: async (session) => { seen.push([session.flags.has('label'), session.flags.value('label')]); return { kind: 'finished', message: 'seen' }; } };
    expect(await w.run(toyTask([step]), '--label=')).toBe(0);
    expect(await w.run(toyTask([step]), '--label', 'x')).toBe(0);
    expect(await w.run(toyTask([step]))).toBe(0);
    expect(await w.run(toyTask([step]), '--label', '')).toBe(2);
    expect(seen).toEqual([[true, ''], [true, 'x'], [false, undefined]]);
  });
});

describe('a run with --submit', () => {
  const refusals: Array<[string, (w: TaskWorld) => void, string]> = [
    ['no approval file', () => undefined, 'the approval file does not exist'],
    ['an approval file for another run wallet', (w) => { w.writeGo({ runWallet: w.keys.registry.addressOf('fee') }); }, 'another run wallet'],
    ['an approval file that does not list the task', (w) => { w.writeGo({ tasks: ['other'] }); }, 'does not list the task toy'],
    ['an expired approval file', (w) => { w.writeGo({ expiresAt: iso(NOW - 1000) }); }, 'has expired'],
    ['an approval file that other users can read', (w) => { w.writeGo(); chmodSync(w.goPath, 0o644); }, 'mode 644'],
    ['an approval file that says unset for a wallet that exists', (w) => { w.writeGo({ runWallet: 'unset' }); }, 'says unset for runWallet'],
  ];
  for (const [name, arrange, message] of refusals) {
    it(`stops with exit 2 before the task runs, for ${name}`, async () => {
      const w = await taskWorld();
      arrange(w);
      const ran: string[] = [];
      expect(await w.run(toyTask(twoSteps(ran)), '--submit')).toBe(2);
      expect(ran).toEqual([]);
      expect(w.screen.errorText).toContain(message);
      expect(w.node.submitted).toEqual([]);
      expect(w.state('toy').steps).toEqual({});
      expect(w.machine()).toEqual({ task: 'toy', command: 'run', mode: 'submit', outcome: 'stopped', exit: 2, step: null, result: {} });
    });
  }
  it('runs the task with a good approval file, gives it the approval, and prints the session and the cap', async () => {
    const w = await taskWorld();
    w.writeGo();
    const seen: TaskSession[] = [];
    const ran: string[] = [];
    const def = toyTask([recordingStep('one', ran, { run: async (session) => { seen.push(session); ran.push('one'); return { kind: 'done', message: 'one is confirmed' }; } })]);
    expect(await w.run(def, '--submit')).toBe(0);
    expect(ran).toEqual(['one']);
    expect(seen[0]!.mode).toBe('submit');
    expect(seen[0]!.go?.session).toBe('s1');
    expect(w.screen.lines).toContain('approval: session s1, cap 100.000000 units, 0.000000 units reserved');
    expect(w.machine()).toMatchObject({ mode: 'submit', outcome: 'done' });
  });
  it('runs a task that needs no approval with --submit and no file, and does not read a file that is there', async () => {
    const w = await taskWorld();
    const ran: string[] = [];
    const seen: Array<TaskSession['go']> = [];
    const never = { keys: () => ['run', 'fee'], chain: true, hosted: [], approval: 'never' } as const;
    const watching = (name: string): StepHandler => recordingStep(name, ran, { run: async (session) => { seen.push(session.go); return recordingStep(name, ran).run(session); } });
    const def = (): TaskDefinition => toyTask([watching('one'), watching('two')], { needs: never });
    expect(await w.run(def(), '--submit')).toBe(0);
    expect(ran).toEqual(['one']);
    w.writeGo();
    expect(await w.run(def(), '--submit')).toBe(0);
    expect(ran).toEqual(['one', 'two']);
    expect(seen).toEqual([null, null]);
  });
  it('lets the task that makes the keys run with an approval that says unset, with no key at all, and refuses it for a wallet', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'operator-empty-keys-'));
    folders.push(empty);
    const w = await taskWorld({ env: { OPERATOR_KEYS_DIR: empty } });
    const ran: string[] = [];
    const seen: TaskSession[] = [];
    const keysTask = toyTask([recordingStep('run', ran, { run: async (session) => { seen.push(session); ran.push('run'); return { kind: 'done', message: 'the keys are made' }; } })], {
      name: 'keys', needs: { keys: () => [], chain: false, hosted: [], approval: 'submit' }, steps: () => ['run'],
    });
    w.writeGo({ runWallet: w.keys.registry.addressOf('run'), tasks: ['keys'] });
    expect(await w.run(keysTask, '--submit')).toBe(2);
    expect(w.screen.errorText).toContain('no run key exists yet');
    expect(ran).toEqual([]);
    w.writeGo({ runWallet: 'unset', tasks: ['keys'] });
    reset(w);
    expect(await w.run(keysTask, '--submit')).toBe(0);
    expect(ran).toEqual(['run']);
    expect(seen[0]!.registry.names()).toEqual([]);
  });
});

describe('the keys of a run', () => {
  const cases: Array<[string, string[], string[], 'submit' | 'never', boolean, string[]]> = [
    ['a dry run names its keys and no more', ['fee'], [], 'submit', false, ['fee']],
    ['a submit run that needs the approval gets the run key too', ['fee'], ['--submit'], 'submit', true, ['fee', 'run']],
    ['the run key is not named twice', ['run', 'fee'], ['--submit'], 'submit', true, ['run', 'fee']],
    ['a submit run that needs no approval gets its own keys only', ['fee'], ['--submit'], 'never', false, ['fee']],
  ];
  for (const [name, keys, argv, approval, withGo, need] of cases) {
    it(`loads the keys that the task names: ${name}`, async () => {
      const w = await taskWorld();
      if (withGo) w.writeGo();
      const asked: string[][] = [];
      const readRegistry = (options: Parameters<typeof loadRegistry>[0]) => { asked.push([...(options.need ?? [])]); return loadRegistry(options); };
      const def = toyTask(twoSteps([]), { needs: { keys: () => keys, chain: true, hosted: [], approval } });
      expect(await runTask(def, argv, w.deps({ readRegistry }))).toBe(0);
      expect(asked).toEqual([need]);
    });
  }
  it('asks for the run key of a task that names no key in a submit run, and gives it an empty registry when that file is missing: a dry run asks for no key', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'operator-empty-keys-'));
    folders.push(empty);
    const w = await taskWorld({ env: { OPERATOR_KEYS_DIR: empty } });
    w.writeGo({ runWallet: 'unset', tasks: ['keys'] });
    const asked: string[][] = [];
    const readRegistry = (options: Parameters<typeof loadRegistry>[0]) => { asked.push([...(options.need ?? [])]); return loadRegistry(options); };
    const def = toyTask(twoSteps([]), { name: 'keys', needs: { keys: () => [], chain: false, hosted: [], approval: 'submit' } });
    expect(await runTask(def, ['--submit'], w.deps({ readRegistry }))).toBe(0);
    expect(asked).toEqual([['run'], []]);
    asked.length = 0;
    expect(await runTask(def, [], w.deps({ readRegistry }))).toBe(0);
    expect(asked).toEqual([[]]);
  });
  describe('a task that names no key and needs the approval of a submit run', () => {
    const quiet = (ran: string[]): TaskDefinition => toyTask(twoSteps(ran), { needs: { keys: () => [], chain: false, hosted: [], approval: 'submit' } });
    const watching = (asked: string[][]) => (options: Parameters<typeof loadRegistry>[0]) => { asked.push([...(options.need ?? [])]); return loadRegistry(options); };
    it('loads the run key when its file exists, so that the approval is checked against the wallet of the run: a task that signs nothing runs under the approval of the session', async () => {
      const w = await taskWorld();
      w.writeGo();
      const asked: string[][] = [];
      const seen: string[][] = [];
      const step: StepHandler = { name: 'one', run: async (session) => { seen.push(session.registry.names()); return { kind: 'finished', message: 'seen' }; } };
      const def = toyTask([step], { needs: { keys: () => [], chain: false, hosted: [], approval: 'submit' } });
      expect(await runTask(def, ['--submit'], w.deps({ readRegistry: watching(asked) }))).toBe(0);
      expect(asked).toEqual([['run']]);
      expect(seen).toEqual([['run']]);
    });
    it('refuses an approval for another wallet and an approval that says unset, when the run key exists', async () => {
      const w = await taskWorld();
      const ran: string[] = [];
      const cases: Array<[Partial<GoFile>, string]> = [[{ runWallet: w.keys.registry.addressOf('fee') }, 'another run wallet'], [{ runWallet: 'unset' }, 'says unset for runWallet']];
      for (const [over, message] of cases) {
        w.writeGo(over);
        reset(w);
        expect(await w.run(quiet(ran), '--submit'), message).toBe(2);
        expect(w.screen.errorText).toContain(message);
      }
      expect(ran).toEqual([]);
    });
    it('refuses the task that makes the keys, run again with an approval that says unset once the run key exists, and lets it run under an approval for the wallet', async () => {
      const w = await taskWorld();
      const ran: string[] = [];
      const keysTask = toyTask(twoSteps(ran), { name: 'keys', needs: { keys: () => [], chain: false, hosted: [], approval: 'submit' } });
      w.writeGo({ runWallet: 'unset', tasks: ['keys'] });
      expect(await w.run(keysTask, '--submit')).toBe(2);
      expect(w.screen.errorText).toContain('says unset for runWallet');
      expect(ran).toEqual([]);
      w.writeGo({ tasks: ['keys'] });
      reset(w);
      expect(await w.run(keysTask, '--submit')).toBe(0);
      expect(ran).toEqual(['one']);
    });
    it('stops with exit 2 for a run key file that is bad, and does not take that for a missing file', async () => {
      const w = await taskWorld();
      w.writeGo();
      chmodSync(join(w.keys.root, 'shared', 'run.seed'), 0o644);
      const asked: string[][] = [];
      const ran: string[] = [];
      expect(await runTask(quiet(ran), ['--submit'], w.deps({ readRegistry: watching(asked) }))).toBe(2);
      expect(w.screen.errorText).toContain('the key run has mode 644');
      expect(asked).toEqual([['run']]);
      expect(ran).toEqual([]);
    });
    it('asks for no key when the task needs no approval, and when the run is a dry run', async () => {
      const w = await taskWorld();
      const asked: string[][] = [];
      const never = toyTask(twoSteps([]), { needs: { keys: () => [], chain: false, hosted: [], approval: 'never' } });
      expect(await runTask(never, ['--submit'], w.deps({ readRegistry: watching(asked) }))).toBe(0);
      expect(await runTask(quiet([]), [], w.deps({ readRegistry: watching(asked) }))).toBe(0);
      expect(asked).toEqual([[], []]);
    });
  });
  it('stops with exit 2 when a key file is missing, names the key, and shows no seed and no path', async () => {
    const w = await taskWorld();
    rmSync(join(w.keys.root, 'shared', 'run.seed'));
    const ran: string[] = [];
    expect(await w.run(toyTask(twoSteps(ran)))).toBe(2);
    expect(ran).toEqual([]);
    expect(w.screen.errorText).toContain('the key run is missing');
    expect(w.screen.errorText).not.toContain(w.keys.root);
    expect(w.machine()).toMatchObject({ outcome: 'stopped', exit: 2 });
  });
  it('stops with exit 2 when a task names a key that the use case does not list', async () => {
    const w = await taskWorld();
    const def = toyTask(twoSteps([]), { needs: { keys: () => ['nobody'], chain: true, hosted: [], approval: 'never' } });
    expect(await w.run(def)).toBe(2);
    expect(w.screen.errorText).toContain('is not in the list of keys of this use case');
  });
  it('gives the task the session of the contract: its parts, frozen, with the extra settings of the task and the flags', async () => {
    const w = await taskWorld();
    w.writeGo();
    const seen: TaskSession<{ marker: number }>[] = [];
    const step: StepHandler<{ marker: number }> = { name: 'one', run: async (session) => { seen.push(session); return { kind: 'finished', message: 'seen' }; } };
    const def = toyTask<{ marker: number }>([step], { parse: () => ({ marker: 7 }) });
    expect(await w.run(def, '--submit', '--all', '--run', 'r1', '--label', 'x')).toBe(0);
    const session = seen[0]!;
    expect(session).toMatchObject({ task: 'toy', mode: 'submit', all: true, extra: { marker: 7 }, awaitMs: 20_000, pollMs: 5_000 });
    expect(session.flags.value('label')).toBe('x');
    expect(session.flags.value('run')).toBe('r1');
    expect(session.use).toBe(w.use);
    expect(session.registry.names()).toEqual(['run', 'fee']);
    expect(session.settings.stateDir).toBe(w.stateDir);
    expect(session.settings.network.name).toBe('vector-mainnet');
    expect(session.state.path).toBe(join(w.stateDir, 'toy.r1.state.json'));
    expect(session.evidence.path).toBe(join(w.stateDir, 'toy.r1.evidence.json'));
    expect(session.facts).toBeInstanceOf(FactsFile);
    expect(session.node).toBe(w.node);
    expect(session.chain).toBe(w.chain);
    expect(session.clock).toBe(w.clock);
    expect(session.out).toBe(w.screen);
    expect(session.exposure.cap()).toBe(100_000_000n);
    expect(Object.isFrozen(session)).toBe(true);
  });
});

describe('runSteps', () => {
  it('does the first step that is not confirmed and one step only, then the next step at the next run, and says finished when every step is confirmed', async () => {
    const w = await taskWorld();
    w.writeGo();
    const ran: string[] = [];
    const def = toyTask(twoSteps(ran));
    expect(await w.run(def, '--submit')).toBe(0);
    expect(ran).toEqual(['one']);
    expect(Object.keys(w.state('toy').steps)).toEqual(['one']);
    expect(w.screen.lines).toContain('one is confirmed');
    expect(w.machine()).toMatchObject({ outcome: 'done', exit: 0, step: 'one' });
    expect(await w.run(def, '--submit')).toBe(0);
    expect(ran).toEqual(['one', 'two']);
    expect(w.machine()).toMatchObject({ outcome: 'done', step: 'two' });
    reset(w);
    expect(await w.run(def, '--submit')).toBe(0);
    expect(ran).toEqual(['one', 'two']);
    expect(w.screen.lines).toContain('every step of the task toy is confirmed');
    expect(w.machine()).toMatchObject({ outcome: 'finished', exit: 0, step: null });
  });
  it('does every step with --all, in order, and says finished', async () => {
    const w = await taskWorld();
    w.writeGo();
    const ran: string[] = [];
    expect(await w.run(toyTask(twoSteps(ran)), '--submit', '--all')).toBe(0);
    expect(ran).toEqual(['one', 'two']);
    expect(Object.keys(w.state('toy').steps)).toEqual(['one', 'two']);
    expect(w.machine()).toMatchObject({ outcome: 'finished', exit: 0, step: 'two' });
    expect(w.screen.lines).toContain('every step of the task toy is confirmed');
  });
  it('stops at a step that waits, with exit 4 and the time that is left, and does not run the next step with --all', async () => {
    const w = await taskWorld();
    w.writeGo();
    const ran: string[] = [];
    const waiting: StepHandler = { name: 'one', run: async (session) => { ran.push('one'); return waitFor(session.clock.now() + 125_000, session.clock.now(), 'the organisation is not verified yet'); } };
    expect(await w.run(toyTask([waiting, recordingStep('two', ran)]), '--submit', '--all')).toBe(4);
    expect(ran).toEqual(['one']);
    expect(w.screen.lines).toContain(`WAIT: the organisation is not verified yet: 2 min 5 s are left (until ${iso(NOW + 125_000)})`);
    expect(w.machine()).toMatchObject({ outcome: 'wait', exit: 4, step: 'one' });
  });
  it('stops at a step that fails, with exit 1, and does not run the next step with --all', async () => {
    const w = await taskWorld();
    w.writeGo();
    const ran: string[] = [];
    const failing: StepHandler = { name: 'one', run: async () => { ran.push('one'); throw new Error('a step failed'); } };
    expect(await w.run(toyTask([failing, recordingStep('two', ran)]), '--submit', '--all')).toBe(1);
    expect(ran).toEqual(['one']);
    expect(w.screen.errorText).toContain('a step failed');
    expect(w.machine()).toMatchObject({ outcome: 'failed', exit: 1, step: 'one' });
  });
  it('never runs a confirmed step again, with --all too', async () => {
    const w = await taskWorld();
    w.writeGo();
    const ran: string[] = [];
    const def = toyTask(twoSteps(ran));
    await w.run(def, '--submit');
    expect(await w.run(def, '--submit', '--all')).toBe(0);
    expect(ran).toEqual(['one', 'two']);
    expect(w.machine()).toMatchObject({ outcome: 'finished' });
  });
  it('does not go on after a step that says done and did not record itself, because the next step needs the steps before it confirmed', async () => {
    const w = await taskWorld();
    w.writeGo();
    const ran: string[] = [];
    const forgetful: StepHandler = { name: 'one', run: async () => { ran.push('one'); return { kind: 'done', message: 'one did something' }; } };
    expect(await w.run(toyTask([forgetful, recordingStep('two', ran)]), '--submit', '--all')).toBe(0);
    expect(ran).toEqual(['one']);
    expect(w.machine()).toMatchObject({ outcome: 'done', step: 'one' });
  });
  it('verifies a step that is confirmed and not verified before the next step runs', async () => {
    const w = await taskWorld();
    w.writeGo();
    const events: string[] = [];
    await w.run(toyTask([recordingStep('one', events), recordingStep('two', events)]), '--submit');
    expect(w.state('toy').steps.one!.verified_at).toBeNull();
    events.length = 0;
    const verified = recordingStep('one', events, { verify: async () => { events.push('verify one'); } });
    expect(await w.run(toyTask([verified, recordingStep('two', events)]), '--submit')).toBe(0);
    expect(events).toEqual(['verify one', 'two']);
    expect(w.state('toy').steps.one!.verified_at).not.toBeNull();
    expect(w.screen.lines).toContain('verifying the step one with the hosted tools');
    expect(w.screen.lines).toContain('the step one is verified');
  });
  it('verifies a step at once when it lands, and marks it verified', async () => {
    const w = await taskWorld();
    w.writeGo();
    const events: string[] = [];
    const checked = recordingStep('one', events, { verify: async () => { events.push('verify one'); } });
    expect(await w.run(toyTask([checked, recordingStep('two', events)]), '--submit')).toBe(0);
    expect(events).toEqual(['one', 'verify one']);
    expect(w.state('toy').steps.one!.verified_at).not.toBeNull();
    expect(w.screen.lines).toContain('one is confirmed');
    expect(w.screen.lines).toContain('step one is confirmed and verified');
  });
  it('keeps a step confirmed when its verification fails, exits with the code of the failure, and verifies it before any other step at the next run', async () => {
    const w = await taskWorld();
    w.writeGo();
    const ran: string[] = [];
    let ok = false;
    const handlers = (): StepHandler[] => [
      recordingStep('one', ran, { verify: async () => { if (!ok) throw new HostedError('unreachable', 'the hosted server could not be used'); } }), recordingStep('two', ran),
    ];
    expect(await w.run(toyTask(handlers()), '--submit')).toBe(3);
    expect(w.state('toy').steps.one).toMatchObject({ verified_at: null });
    expect(w.machine()).toMatchObject({ outcome: 'stopped', exit: 3, step: 'one' });
    ok = true;
    reset(w);
    expect(await w.run(toyTask(handlers()), '--submit')).toBe(0);
    expect(w.state('toy').steps.one!.verified_at).not.toBeNull();
    expect(ran).toEqual(['one', 'two']);
  });

  describe('a step with a colon in its name, which the landing keeps as a part of a step', () => {
    const colonSteps = (ran: string[]): StepHandler[] => [recordingStep('agent:open', ran), recordingStep('agent:create', ran)];
    it('counts as confirmed when its part is recorded: one step at a time, never again, and finished at the end', async () => {
      const w = await taskWorld();
      w.writeGo();
      const ran: string[] = [];
      const def = toyTask(colonSteps(ran));
      expect(await w.run(def, '--submit')).toBe(0);
      expect(ran).toEqual(['agent:open']);
      expect(w.state('toy').steps).toEqual({});
      expect(Object.keys(w.state('toy').notes)).toEqual(['part.agent:open']);
      expect(w.machine()).toMatchObject({ outcome: 'done', step: 'agent:open' });
      expect(await w.run(def, '--submit')).toBe(0);
      expect(ran).toEqual(['agent:open', 'agent:create']);
      expect(w.machine()).toMatchObject({ outcome: 'done', step: 'agent:create' });
      reset(w);
      expect(await w.run(def, '--submit')).toBe(0);
      expect(ran).toEqual(['agent:open', 'agent:create']);
      expect(w.machine()).toMatchObject({ outcome: 'finished', step: null });
    });
    it('goes on to the end with --all', async () => {
      const w = await taskWorld();
      w.writeGo();
      const ran: string[] = [];
      expect(await w.run(toyTask(colonSteps(ran)), '--submit', '--all')).toBe(0);
      expect(ran).toEqual(['agent:open', 'agent:create']);
      expect(w.machine()).toMatchObject({ outcome: 'finished', step: 'agent:create' });
    });
    it('shows each step once in the status, with its transaction and the next step, and shows a part that no step names', async () => {
      const w = await taskWorld();
      w.writeGo();
      const ran: string[] = [];
      const opening = recordingStep('agent:open', ran, {
        run: async (session) => {
          await recordingStep('agent:open', ran).run(session);
          session.state.setNote('part.hire:pay', { confirmed_at: iso(NOW), tx_hash: hashOf('pay'), refs: {}, facts: {} });
          return { kind: 'done', message: 'agent:open is confirmed' };
        },
      });
      const def = toyTask([opening, recordingStep('agent:create', ran)]);
      await w.run(def, '--submit');
      reset(w);
      expect(await w.run(def, 'status')).toBe(0);
      const lines = w.screen.lines;
      expect(lines.filter((line) => line.includes('agent:open'))).toHaveLength(1);
      expect(lines.find((line) => line.trim().startsWith('agent:open'))).toMatch(/agent:open +confirmed .*transaction [0-9a-f]{64}, not verified/);
      expect(lines.find((line) => line.trim().startsWith('agent:create'))).toMatch(/agent:create +not run/);
      expect(lines.find((line) => line.trim().startsWith('hire:pay'))).toContain(`confirmed (a part of a step), transaction ${hashOf('pay')}`);
      expect(lines).toContain('next: agent:create');
    });
    it('verifies a part at once, marks it verified in its note, and verifies a part that is not verified before anything else', async () => {
      const w = await taskWorld();
      w.writeGo();
      const events: string[] = [];
      const verify = async (): Promise<void> => { events.push('verify'); };
      expect(await w.run(toyTask([recordingStep('agent:open', events, { verify }), recordingStep('agent:create', events)]), '--submit')).toBe(0);
      expect(events).toEqual(['agent:open', 'verify']);
      expect(w.state('toy').notes['part.agent:open']).toMatchObject({ tx_hash: hashOf('step agent:open'), verified_at: iso(NOW) });
      expect(w.screen.lines).toContain('the step agent:open is verified');
      expect(await w.run(toyTask(colonSteps([])), '--submit', '--all')).toBe(0);
      events.length = 0;
      const later = toyTask([recordingStep('agent:open', events), recordingStep('agent:create', events, { verify })]);
      expect(await w.run(later, '--submit')).toBe(0);
      expect(events).toEqual(['verify']);
      expect(w.state('toy').notes['part.agent:create']).toMatchObject({ verified_at: iso(NOW) });
      expect(w.machine()).toMatchObject({ outcome: 'finished' });
    });
  });
});

describe('a transaction in flight', () => {
  /**
   * A run with --submit that signs a real payment and does not see it confirmed: the transaction stays in flight, and its reserve is in the cap file of the session. By default the submit works, so the
   * world applies the transaction and its inputs are spent, as for a transaction that landed and that the indexer does not show yet. With `applied: false` the submit fails, the world does not apply the
   * transaction, and its inputs stay unspent, as for a transaction that was lost.
   */
  async function strand(w: TaskWorld, ran: string[], options: { applied?: boolean } = {}): Promise<{ hash: string; def: TaskDefinition; inputs: string[]; end: bigint }> {
    w.writeGo();
    w.node.neverConfirm = true;
    if (options.applied === false) w.node.submitError = new Error('the submit API did not answer');
    const def = toyTask(landing(ran));
    expect(await w.run(def, '--submit')).toBe(1);
    w.node.submitError = null;
    const flight = w.state('toy').in_flight;
    expect(flight?.step).toBe('one');
    expect(w.exposure()).toHaveLength(1);
    expect(w.exposure()[0]!.tx_hash).toBe(flight!.tx_hash);
    expect(w.machine()).toMatchObject({ outcome: 'failed', exit: 1, step: 'one' });
    expect(w.screen.errorText).toContain('The signed transaction is kept in the state file');
    expect(w.world.chain.applied).toHaveLength(options.applied === false ? 0 : 1);
    w.node.reads.length = 0;
    w.node.inputReads.length = 0;
    reset(w);
    const facts = factsOf(flight!.signed_cbor);
    return { hash: flight!.tx_hash, def, inputs: inputsToCheck(facts), end: facts.validityEndSlot! };
  }
  /** The time after which a transaction of `strand` cannot land any more, and the run may let it go. */
  const AFTER_VALIDITY = NOW + 30 * 60_000 + 61_000;

  it('signs, submits, waits, records the step with its hash, writes the evidence, and reserves the net outflow in the cap file before the submit', async () => {
    const w = await taskWorld();
    w.writeGo();
    const ran: string[] = [];
    expect(await w.run(toyTask(landing(ran)), '--submit', '--all')).toBe(0);
    const state = w.state('toy');
    expect(Object.keys(state.steps)).toEqual(['one', 'two']);
    expect(state.in_flight).toBeNull();
    expect(w.node.submitted).toHaveLength(2);
    expect(w.evidence('toy').map((entry) => [entry.step, entry.status])).toEqual([['one', 'confirmed'], ['two', 'confirmed']]);
    expect(w.exposure().map((entry) => entry.tx_hash)).toEqual([state.steps.one!.tx_hash, state.steps.two!.tx_hash]);
    expect(w.machine()).toMatchObject({ outcome: 'finished', exit: 0 });
  });
  it('settles a transaction that confirmed after the run ended before it builds anything: the step is recorded, its reserve stays, and the task goes on with the next step', async () => {
    const w = await taskWorld();
    const ran: string[] = [];
    const { hash, def } = await strand(w, ran);
    w.node.neverConfirm = false;
    expect(await w.run(def, '--submit')).toBe(0);
    expect(w.screen.text).toContain(`the transaction ${hash} of the step one is confirmed: the step is recorded`);
    expect(w.state('toy').steps.one!.tx_hash).toBe(hash);
    expect(w.state('toy').steps.two).toBeDefined();
    expect(w.state('toy').in_flight).toBeNull();
    expect(ran).toEqual(['one', 'two']);
    expect(w.exposure().map((entry) => entry.tx_hash)).toContain(hash);
    expect(w.exposure()).toHaveLength(2);
  });
  it('settles in a dry run too, builds nothing there that it would sign, and reads no approval file', async () => {
    const w = await taskWorld();
    const { hash } = await strand(w, []);
    w.node.neverConfirm = false;
    const submitted = w.node.submitted.length;
    const seen: Array<TaskSession['go']> = [];
    const handlers = landing([]);
    const def = toyTask(handlers, { next: async (session) => { seen.push(session.go); return runSteps(session, handlers); } });
    expect(await w.run(def)).toBe(0);
    expect(w.state('toy').steps.one!.tx_hash).toBe(hash);
    expect(w.screen.text).toContain('step two: dry mode, nothing is signed or submitted');
    expect(w.node.submitted).toHaveLength(submitted);
    expect(seen).toEqual([null]);
    expect(w.machine()).toMatchObject({ outcome: 'dry', step: 'two' });
  });
  it('waits for a transaction that may still land: exit 4, with the task not run, the transaction still in flight, its reserve kept, and no submit of its bytes in a dry run', async () => {
    const w = await taskWorld();
    const ran: string[] = [];
    const { hash, def } = await strand(w, ran);
    const submitted = w.node.submitted.length;
    expect(await w.run(def)).toBe(4);
    expect(w.node.submitted).toHaveLength(submitted);
    expect(w.screen.text).toContain(`WAIT: the transaction ${hash} of the step one`);
    expect(ran).toEqual(['one']);
    expect(w.state('toy').in_flight?.tx_hash).toBe(hash);
    expect(w.exposure()).toHaveLength(1);
    expect(w.machine()).toMatchObject({ outcome: 'wait', exit: 4, step: 'one' });
  });
  it('stops with exit 2 when the network guard failed and a transaction is in flight: no status is read, and the state and the cap file stay as they are', async () => {
    const w = await taskWorld();
    const ran: string[] = [];
    const { hash, def } = await strand(w, ran);
    w.node.facts = { magic: 9, systemStartMs: null };
    w.clock.t = AFTER_VALIDITY;
    w.node.script.push({ confirmations: null }, { confirmations: null });
    for (const argv of [[], ['--submit']]) {
      reset(w);
      expect(await w.run(def, ...argv), argv.join(' ')).toBe(2);
      expect(w.screen.errorText).toContain('network guard: FAIL');
      expect(w.screen.errorText).toContain('the step one has a transaction in flight, and the network guard failed');
      expect(w.node.reads).toEqual([]);
      expect(w.state('toy').in_flight?.tx_hash).toBe(hash);
      expect(w.exposure().map((entry) => entry.tx_hash)).toEqual([hash]);
      expect(ran).toEqual(['one']);
      expect(w.machine()).toMatchObject({ outcome: 'stopped', exit: 2, step: null });
    }
  });

  describe('the reserve of a transaction that cannot land any more', () => {
    /** The toy task with no need of an approval: its steps record themselves and land nothing, so it runs with --submit and no approval file. */
    const unapproved = (ran: string[]): TaskDefinition => toyTask(twoSteps(ran), { needs: { keys: () => ['run', 'fee'], chain: true, hosted: [], approval: 'never' } });
    it('is given back when the validity ended, and a second read that works does not know the hash: the step is built again with its own reserve', async () => {
      const w = await taskWorld();
      const ran: string[] = [];
      const { hash, def, inputs } = await strand(w, ran, { applied: false });
      w.node.neverConfirm = false;
      w.clock.t = AFTER_VALIDITY;
      w.node.script.push({ confirmations: null }, { confirmations: null });
      expect(await w.run(def, '--submit')).toBe(0);
      expect(w.node.reads.filter((read) => read === hash)).toHaveLength(2);
      expect(w.node.inputReads[0]).toEqual(inputs);
      expect(w.screen.text).toContain(`the transaction ${hash} of the step one is not on the chain, and its validity ended at ${iso(NOW + 30 * 60_000)}: it cannot land any more. Its reserve of the cap is released.`);
      expect(w.screen.text).not.toContain('the step can be built again');
      expect(ran).toEqual(['one', 'one']);
      expect(w.state('toy').steps.one!.tx_hash).not.toBe(hash);
      expect(w.exposure().map((entry) => entry.tx_hash)).toEqual([w.state('toy').steps.one!.tx_hash]);
    });
    it('is kept by a dry run, and the dry run goes on: the record and the reserve stay, nothing is submitted, the summary shows the step as it would be built again, and a run with --submit then lets it go and builds the step', async () => {
      const w = await taskWorld();
      const ran: string[] = [];
      const { hash, def } = await strand(w, ran, { applied: false });
      w.clock.t = AFTER_VALIDITY;
      w.node.neverConfirm = false;
      const submitted = w.node.submitted.length;
      w.node.script.push({ confirmations: null }, { confirmations: null });
      expect(await w.run(def)).toBe(0);
      expect(w.screen.text).toContain(`the transaction ${hash} of the step one is not on the chain, and its validity ended at ${iso(NOW + 30 * 60_000)}: it cannot land any more. A dry run does not let it go: the record and the reserve stay.`);
      expect(w.screen.text).not.toContain('is released');
      expect(w.screen.text).toContain('step one: dry mode, nothing is signed or submitted');
      expect(w.state('toy').in_flight?.tx_hash).toBe(hash);
      expect(w.exposure().map((entry) => entry.tx_hash)).toEqual([hash]);
      expect(w.node.submitted).toHaveLength(submitted);
      expect(ran).toEqual(['one', 'one']);
      expect(w.machine()).toMatchObject({ mode: 'dry', outcome: 'dry', exit: 0, step: 'one' });
      reset(w);
      w.node.script.push({ confirmations: null }, { confirmations: null });
      expect(await w.run(def, '--submit')).toBe(0);
      expect(w.screen.text).toContain('Its reserve of the cap is released.');
      expect(w.state('toy').in_flight).toBeNull();
      expect(ran).toEqual(['one', 'one', 'one']);
    });
    it('is given back when the first read failed and the second read works and does not know the hash: only the second read counts', async () => {
      const w = await taskWorld();
      const { hash, def } = await strand(w, [], { applied: false });
      w.clock.t = AFTER_VALIDITY;
      w.node.neverConfirm = false;
      w.node.script.push(new Error('the indexer is down'), { confirmations: null });
      expect(await w.run(def, '--submit')).toBe(0);
      expect(w.exposure().map((entry) => entry.tx_hash)).not.toContain(hash);
    });
    it('keeps a transaction whose inputs are spent, in a dry run and in a run with --submit: the indexer can be behind the node, so the transaction may have landed', async () => {
      for (const argv of [[], ['--submit']]) {
        const w = await taskWorld();
        const ran: string[] = [];
        const { hash, def, inputs } = await strand(w, ran);
        w.clock.t = AFTER_VALIDITY;
        w.node.neverConfirm = false;
        const submitted = w.node.submitted.length;
        const applied = w.world.chain.applied.length;
        w.node.script.push({ confirmations: null }, { confirmations: null });
        expect(await w.run(def, ...argv), argv.join(' ')).toBe(2);
        expect(w.screen.errorText).toContain(`the transaction ${hash} of the step one is not known to the indexer, and its validity ended at ${iso(NOW + 30 * 60_000)}, but all ${inputs.length} of its inputs are spent, and a transaction that landed spends all of them. It may have landed.`);
        expect(w.screen.errorText).toContain(`the operator lets it go with the command cleanup and the flags --release=${hash} and --submit.`);
        expect(w.node.inputReads[0], argv.join(' ')).toEqual(inputs);
        expect(w.screen.text).not.toContain('is released');
        expect(w.state('toy').in_flight?.tx_hash).toBe(hash);
        expect(w.state('toy').steps).toEqual({});
        expect(w.exposure().map((entry) => entry.tx_hash)).toEqual([hash]);
        expect(w.node.submitted).toHaveLength(submitted);
        expect(w.world.chain.applied).toHaveLength(applied);
        expect(ran).toEqual(['one']);
        expect(w.machine()).toMatchObject({ outcome: 'stopped', exit: 2, step: 'one' });
        reset(w);
        expect(await w.run(def, ...argv), argv.join(' ')).toBe(0);
        expect(w.state('toy').steps.one!.tx_hash).toBe(hash);
        expect(w.state('toy').in_flight).toBeNull();
      }
    });
    describe('a lost transaction whose inputs other transactions spent', () => {
      /** A world whose run wallet holds eight outputs of 2 units: the payment of 3 units of the toy task needs two or three of them, so that a lost transaction has more than one input, and the wallet can pay again after other transactions spent those inputs. */
      const manySmall = (): Promise<TaskWorld> => taskWorld({ wallets: { run: Array.from({ length: 8 }, () => 2_000_000n), fee: [1_000_000_000n, 5_000_000n] } });
      /** Takes the outputs at these references from the world, as if other transactions had spent them. */
      const spendByOthers = (w: TaskWorld, refs: readonly string[]): void => {
        w.world.chain.held = w.world.chain.held.filter((utxo) => !refs.includes(`${utxo.txHash}#${utxo.outputIndex}`));
      };
      it('lets the transaction go when another transaction spent one of its inputs and the others are unspent: a transaction that landed spends all of its inputs', async () => {
        const w = await manySmall();
        const ran: string[] = [];
        const { hash, def, inputs } = await strand(w, ran, { applied: false });
        expect(inputs.length).toBeGreaterThanOrEqual(2);
        spendByOthers(w, [inputs[0]!]);
        w.clock.t = AFTER_VALIDITY;
        w.node.neverConfirm = false;
        w.node.script.push({ confirmations: null }, { confirmations: null });
        expect(await w.run(def, '--submit')).toBe(0);
        expect(w.screen.text).toContain('Its reserve of the cap is released.');
        expect(w.exposure().map((entry) => entry.tx_hash)).not.toContain(hash);
        expect(ran).toEqual(['one', 'one']);
        expect(w.state('toy').steps.one!.tx_hash).not.toBe(hash);
      });
      it('keeps the transaction when other transactions spent all of its inputs, and lets it go at the word of the operator: cleanup --release with its hash, after a check of the chain', async () => {
        const w = await manySmall();
        const ran: string[] = [];
        const { hash, def, inputs } = await strand(w, ran, { applied: false });
        spendByOthers(w, inputs);
        w.clock.t = AFTER_VALIDITY;
        w.node.neverConfirm = false;
        w.node.script.push({ confirmations: null }, { confirmations: null });
        expect(await w.run(def, '--submit')).toBe(2);
        expect(w.screen.errorText).toContain(`but all ${inputs.length} of its inputs are spent, and a transaction that landed spends all of them. It may have landed.`);
        expect(w.screen.errorText).toContain(`--release=${hash} and --submit`);
        expect(w.state('toy').in_flight?.tx_hash).toBe(hash);
        expect(ran).toEqual(['one']);
        const reads = w.node.reads.length;
        const tips = w.node.tipReads;
        const networks = w.node.networkReads;
        const inputReads = w.node.inputReads.length;
        reset(w);
        expect(await w.run(def, 'cleanup', '--release', hash)).toBe(0);
        expect(w.screen.text).toContain(`the transaction ${hash} of the step one would be let go, and its reserve of the cap would be given back. A dry run lets nothing go.`);
        expect(w.state('toy').in_flight?.tx_hash).toBe(hash);
        expect(w.exposure().map((entry) => entry.tx_hash)).toEqual([hash]);
        expect(w.evidence('toy')).toEqual([]);
        expect(w.machine()).toMatchObject({ command: 'cleanup', mode: 'dry', outcome: 'dry', exit: 0, step: 'one' });
        reset(w);
        expect(await w.run(def, 'cleanup', `--release=${hash}`, '--submit')).toBe(0);
        expect(w.screen.text).toContain(`the operator says that the chain was checked and that the transaction ${hash} of the step one is not there: it is let go.`);
        expect(w.screen.text).toContain('Its reserve of the cap is released.');
        expect(w.screen.text).not.toContain('there is nothing to take back');
        expect(w.state('toy').in_flight).toBeNull();
        expect(w.state('toy').steps).toEqual({});
        expect(w.exposure()).toEqual([]);
        expect(w.evidence('toy')).toEqual([expect.objectContaining({ step: 'one', status: 'info', shows: { note: 'the operator lets the transaction go, and says that the chain was checked', transaction: hash, session: 's1' } })]);
        expect(w.machine()).toMatchObject({ command: 'cleanup', mode: 'submit', outcome: 'done', exit: 0, step: 'one' });
        // The release reads no status and no inputs. It asks the network guard and the tip of the node once in each of its two runs.
        expect(w.node.reads).toHaveLength(reads);
        expect(w.node.inputReads).toHaveLength(inputReads);
        expect(w.node.tipReads).toBe(tips + 2);
        expect(w.node.networkReads).toBe(networks + 2);
        reset(w);
        const rebuilt = await w.run(def, '--submit');
        expect(rebuilt, w.screen.errorText).toBe(0);
        expect(ran).toEqual(['one', 'one']);
        expect(w.state('toy').steps.one!.tx_hash).not.toBe(hash);
      });
      it('refuses --release for a hash that is not the transaction in flight, and when nothing is in flight: nothing changes', async () => {
        const w = await taskWorld();
        const { hash, def } = await strand(w, [], { applied: false });
        for (const argv of [[], ['--submit']]) {
          reset(w);
          expect(await w.run(def, 'cleanup', `--release=${'cd'.repeat(32)}`, ...argv), argv.join(' ')).toBe(2);
          expect(w.screen.errorText).toContain(`the transaction in flight is ${hash} of the step one, and --release names another transaction: nothing is let go`);
          expect(w.state('toy').in_flight?.tx_hash).toBe(hash);
          expect(w.exposure().map((entry) => entry.tx_hash)).toEqual([hash]);
          expect(w.evidence('toy')).toEqual([]);
          expect(w.machine()).toMatchObject({ command: 'cleanup', outcome: 'stopped', exit: 2 });
        }
        const idle = await taskWorld();
        idle.writeGo();
        expect(await idle.run(toyTask(twoSteps([])), 'cleanup', `--release=${hash}`, '--submit')).toBe(2);
        expect(idle.screen.errorText).toContain('no transaction is in flight, so --release has nothing to let go');
      });
      it('refuses --release under an approval that does not allow the task, and leaves the transaction in flight', async () => {
        const w = await taskWorld();
        const { hash, def } = await strand(w, [], { applied: false });
        w.writeGo({ tasks: ['other'] });
        expect(await w.run(def, 'cleanup', `--release=${hash}`, '--submit')).toBe(2);
        expect(w.screen.errorText).toContain('does not list the task toy');
        expect(w.state('toy').in_flight?.tx_hash).toBe(hash);
        expect(w.exposure().map((entry) => entry.tx_hash)).toEqual([hash]);
        expect(w.evidence('toy')).toEqual([]);
      });
      it('lets the transaction go for a task that needs no approval, and says that its reserve stays when no approval file is loaded', async () => {
        const w = await taskWorld();
        const { hash } = await strand(w, [], { applied: false });
        w.clock.t = AFTER_VALIDITY;
        rmSync(w.goPath);
        expect(await w.run(unapproved([]), 'cleanup', '--release', hash, '--submit')).toBe(0);
        expect(w.screen.text).toContain('No approval file is loaded, so its reserve stays in the cap file of its session.');
        expect(w.state('toy').in_flight).toBeNull();
        expect(w.exposure().map((entry) => entry.tx_hash)).toEqual([hash]);
        expect(w.evidence('toy')).toEqual([expect.objectContaining({ status: 'info', shows: expect.objectContaining({ transaction: hash, session: null }) })]);
      });
    });
    describe('the release of a transaction that may still land', () => {
      /** The end of the validity of a transaction of `strand`, and the time after which the checks let it go: a minute later. */
      const LAST_MS = NOW + 30 * 60_000;
      const RELEASE_AT = LAST_MS + 60_000;
      /** Runs `cleanup --release` for the hash. */
      const release = (w: TaskWorld, def: TaskDefinition, hash: string, ...argv: string[]): Promise<number> => w.run(def, 'cleanup', `--release=${hash}`, ...argv);
      /** What a release that was refused leaves: the transaction in flight, its reserve, and no entry of the evidence. */
      const untouched = (w: TaskWorld, hash: string): void => {
        expect(w.state('toy').in_flight?.tx_hash).toBe(hash);
        expect(w.exposure().map((entry) => entry.tx_hash)).toEqual([hash]);
        expect(w.evidence('toy')).toEqual([]);
      };
      it('refuses until the clock is past the end of the validity and the grace time of a minute, in a dry run and in a run with --submit, and lets the transaction go one millisecond after', async () => {
        const w = await taskWorld();
        const { hash, def } = await strand(w, [], { applied: false });
        for (const now of [NOW, LAST_MS - 1, LAST_MS, RELEASE_AT]) {
          for (const argv of [[], ['--submit']]) {
            w.clock.t = now;
            reset(w);
            expect(await release(w, def, hash, ...argv), `${now} ${argv.join(' ')}`).toBe(2);
            expect(w.screen.errorText).toContain(`the transaction ${hash} of the step one may still land, so nothing is let go: its validity ends at ${iso(LAST_MS)}, and a transaction is let go only after ${iso(RELEASE_AT)}, 1 min later`);
            expect(w.machine()).toMatchObject({ command: 'cleanup', outcome: 'stopped', exit: 2, step: 'one' });
            untouched(w, hash);
          }
        }
        w.clock.t = RELEASE_AT + 1;
        reset(w);
        expect(await release(w, def, hash, '--submit')).toBe(0);
        expect(w.state('toy').in_flight).toBeNull();
        expect(w.exposure()).toEqual([]);
      });
      it('refuses when the clock says that the validity is over and the tip of the node does not: the tip must be past the end of the validity by 20 slots', async () => {
        const w = await taskWorld();
        const { hash, def, end } = await strand(w, [], { applied: false });
        w.clock.t = AFTER_VALIDITY;
        for (const tip of [end - 1n, end, end + 20n]) {
          for (const argv of [[], ['--submit']]) {
            w.node.tipSlot = Number(tip);
            reset(w);
            expect(await release(w, def, hash, ...argv), `${tip} ${argv.join(' ')}`).toBe(2);
            expect(w.screen.errorText).toContain(`the clock says that the validity is over, but the tip of the node is at slot ${tip}, and it must be past slot ${end + 20n} (the end of the validity at slot ${end}, and 20 slots more)`);
            untouched(w, hash);
          }
        }
        w.node.tipSlot = Number(end + 21n);
        reset(w);
        expect(await release(w, def, hash, '--submit')).toBe(0);
        expect(w.screen.text).toContain(`the clock is past the end of the validity by more than 1 min, and the tip of the node (slot ${end + 21n}) is past the end of the validity (slot ${end}) by more than 20 slots`);
        expect(w.state('toy').in_flight).toBeNull();
      });
      it('lets the transaction go on the clock alone when the node gives no tip or is not on the network of the run, and says so', async () => {
        const down = await taskWorld();
        const first = await strand(down, [], { applied: false });
        down.clock.t = AFTER_VALIDITY;
        down.node.tipError = new Error('the node is down');
        reset(down);
        expect(await release(down, first.def, first.hash, '--submit')).toBe(0);
        expect(down.screen.text).toContain('and the node was not used (it did not give its tip: the node is down)');
        expect(down.state('toy').in_flight).toBeNull();
        const other = await taskWorld();
        const second = await strand(other, [], { applied: false });
        other.clock.t = AFTER_VALIDITY;
        other.node.facts = { magic: 9, systemStartMs: null };
        const tips = other.node.tipReads;
        reset(other);
        expect(await release(other, second.def, second.hash, '--submit')).toBe(0);
        expect(other.screen.text).toContain('and the node was not used (the network guard failed: the node is on the network with the magic 9');
        expect(other.node.tipReads).toBe(tips);
        expect(other.state('toy').in_flight).toBeNull();
      });
      it('refuses a transaction whose bytes cannot be read, and asks the node for nothing', async () => {
        const w = await taskWorld();
        const { hash, def } = await strand(w, [], { applied: false });
        const path = join(w.stateDir, 'toy.state.json');
        const state = JSON.parse(readFileSync(path, 'utf8'));
        state.in_flight.signed_cbor = '84';
        writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
        w.clock.t = AFTER_VALIDITY;
        const tips = w.node.tipReads;
        const networks = w.node.networkReads;
        expect(await release(w, def, hash, '--submit')).toBe(2);
        expect(w.screen.errorText).toContain(`the bytes of the transaction ${hash} of the step one cannot be read`);
        expect(w.screen.errorText).toContain('nothing is let go');
        untouched(w, hash);
        expect(w.node.tipReads).toBe(tips);
        expect(w.node.networkReads).toBe(networks);
      });
    });
    it('keeps a transaction when the node cannot say whether its inputs are spent, and lets it go at the next run that can', async () => {
      const w = await taskWorld();
      const ran: string[] = [];
      const { hash, def } = await strand(w, ran, { applied: false });
      w.clock.t = AFTER_VALIDITY;
      w.node.neverConfirm = false;
      w.node.script.push({ confirmations: null }, { confirmations: null });
      w.node.inputsError = new Error('the node is down');
      expect(await w.run(def, '--submit')).toBe(2);
      expect(w.screen.errorText).toContain(`the transaction ${hash} of the step one is not known to the indexer, and its validity ended at ${iso(NOW + 30 * 60_000)}, but its inputs cannot be checked (the node did not answer: the node is down). It stays in flight, its reserve stays, and nothing is built.`);
      expect(w.state('toy').in_flight?.tx_hash).toBe(hash);
      expect(w.exposure().map((entry) => entry.tx_hash)).toEqual([hash]);
      expect(ran).toEqual(['one']);
      expect(w.machine()).toMatchObject({ outcome: 'stopped', exit: 2, step: 'one' });
      w.node.inputsError = null;
      w.node.script.push({ confirmations: null }, { confirmations: null });
      reset(w);
      expect(await w.run(def, '--submit')).toBe(0);
      expect(w.screen.text).toContain('Its reserve of the cap is released.');
      expect(ran).toEqual(['one', 'one']);
    });
    it('keeps a transaction whose bytes cannot be read, and asks the node for nothing', async () => {
      const w = await taskWorld();
      const ran: string[] = [];
      const { hash, def } = await strand(w, ran, { applied: false });
      const path = join(w.stateDir, 'toy.state.json');
      const state = JSON.parse(readFileSync(path, 'utf8'));
      state.in_flight.signed_cbor = '84';
      writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
      w.clock.t = AFTER_VALIDITY;
      w.node.neverConfirm = false;
      w.node.script.push({ confirmations: null }, { confirmations: null });
      expect(await w.run(def, '--submit')).toBe(2);
      expect(w.screen.errorText).toContain('its inputs cannot be checked (the bytes of the transaction cannot be read');
      expect(w.node.inputReads).toEqual([]);
      expect(w.node.tipReads).toBe(0);
      expect(w.state('toy').in_flight?.tx_hash).toBe(hash);
      expect(w.exposure().map((entry) => entry.tx_hash)).toEqual([hash]);
      expect(ran).toEqual(['one']);
      expect(w.machine()).toMatchObject({ outcome: 'stopped', exit: 2 });
    });
    describe('the tip of the node', () => {
      /** A transaction that was lost (the world does not apply it), after its validity, that the indexer does not know. `end` is the slot at which its validity ended. */
      async function lost(): Promise<{ w: TaskWorld; hash: string; def: TaskDefinition; ran: string[]; end: number }> {
        const w = await taskWorld();
        const ran: string[] = [];
        const { hash, def, end } = await strand(w, ran, { applied: false });
        w.clock.t = AFTER_VALIDITY;
        w.node.neverConfirm = false;
        w.node.script.push({ confirmations: null }, { confirmations: null });
        return { w, hash, def, ran, end: Number(end) };
      }
      it('keeps a transaction when the node is behind: its tip is before the end of the validity, so its answer that every input is unspent proves nothing', async () => {
        for (const argv of [[], ['--submit']]) {
          const { w, hash, def, ran, end } = await lost();
          w.node.tipSlot = end - 5;
          const submitted = w.node.submitted.length;
          expect(await w.run(def, ...argv), argv.join(' ')).toBe(2);
          expect(w.screen.errorText).toContain(`the transaction ${hash} of the step one is not known to the indexer, and its validity ended at ${iso(NOW + 30 * 60_000)}, but its inputs cannot be checked (the tip of the node is at slot ${end - 5}, and its answer about the inputs counts only past slot ${end + 20} (the validity of the transaction ended at slot ${end}): the node may not have seen the block of the transaction yet). It stays in flight, its reserve stays, and nothing is built.`);
          expect(w.node.inputReads, argv.join(' ')).toEqual([]);
          expect(w.node.tipReads).toBe(1);
          expect(w.state('toy').in_flight?.tx_hash).toBe(hash);
          expect(w.exposure().map((entry) => entry.tx_hash)).toEqual([hash]);
          expect(w.node.submitted).toHaveLength(submitted);
          expect(ran).toEqual(['one']);
          expect(w.machine()).toMatchObject({ outcome: 'stopped', exit: 2, step: 'one' });
          w.node.tipSlot = end + 21;
          w.node.script.push({ confirmations: null }, { confirmations: null });
          reset(w);
          expect(await w.run(def, '--submit')).toBe(0);
          expect(w.screen.text).toContain('Its reserve of the cap is released.');
          expect(ran).toEqual(['one', 'one']);
        }
      });
      it('counts the answer of the node only past the end of the validity and the margin of 20 slots: at that slot the transaction is kept, one slot later it is let go', async () => {
        for (const [offset, kept] of [[-1, true], [0, true], [20, true], [21, false]] as const) {
          const { w, hash, def, end } = await lost();
          w.node.tipSlot = end + offset;
          expect(await w.run(def, '--submit'), `offset ${offset}`).toBe(kept ? 2 : 0);
          expect(w.state('toy').in_flight?.tx_hash === hash, `offset ${offset}`).toBe(kept);
        }
      });
      it('reads the tip before the inputs, so that the view of the inputs is at least as new as the tip', async () => {
        const { w, def } = await lost();
        const order: string[] = [];
        const tip = w.node.networkTip.bind(w.node);
        const resolve = w.node.resolveInputs.bind(w.node);
        w.node.networkTip = async () => { order.push('tip'); return tip(); };
        w.node.resolveInputs = async (refs) => { order.push('inputs'); return resolve(refs); };
        expect(await w.run(def, '--submit')).toBe(0);
        expect(order.slice(0, 2)).toEqual(['tip', 'inputs']);
      });
      it('keeps a transaction when the node does not give its tip, and asks it for no inputs', async () => {
        const { w, hash, def, ran } = await lost();
        w.node.tipError = new Error('the node is down');
        expect(await w.run(def, '--submit')).toBe(2);
        expect(w.screen.errorText).toContain('its inputs cannot be checked (the node did not give its tip: the node is down)');
        expect(w.node.inputReads).toEqual([]);
        expect(w.state('toy').in_flight?.tx_hash).toBe(hash);
        expect(w.exposure().map((entry) => entry.tx_hash)).toEqual([hash]);
        expect(ran).toEqual(['one']);
      });
      it('keeps a transaction that has no end of validity: no tip of the node shows that it cannot land', async () => {
        const { w, hash, def, ran } = await lost();
        const open = await w.world.simplePayment(w.keys.registry.addressOf('run'), 2_000_000n, w.keys.registry.addressOf('fee'));
        expect(factsOf(open.unsignedCbor).validityEndSlot).toBeNull();
        const path = join(w.stateDir, 'toy.state.json');
        const state = JSON.parse(readFileSync(path, 'utf8'));
        state.in_flight.signed_cbor = open.unsignedCbor;
        writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
        expect(await w.run(def, '--submit')).toBe(2);
        expect(w.screen.errorText).toContain('its inputs cannot be checked (the transaction has no end of validity, so no tip of the node shows that it cannot land)');
        expect(w.node.tipReads).toBe(0);
        expect(w.node.inputReads).toEqual([]);
        expect(w.state('toy').in_flight?.tx_hash).toBe(hash);
        expect(ran).toEqual(['one']);
      });
    });
    it('asks the node for the inputs and the collateral inputs of the transaction, each once', () => {
      expect(inputsToCheck({ inputs: ['aa#0', 'bb#1'], collateralInputs: ['cc#0', 'aa#0'] })).toEqual(['aa#0', 'bb#1', 'cc#0']);
      expect(inputsToCheck({ inputs: [], collateralInputs: [] })).toEqual([]);
    });
    it('stops when the second read fails, in a dry run and in a run with --submit: the record and the reserve stay, nothing is built or submitted, and the next run that can read the status records the step', async () => {
      for (const argv of [[], ['--submit']]) {
        const w = await taskWorld();
        const ran: string[] = [];
        const { hash, def } = await strand(w, ran);
        w.clock.t = AFTER_VALIDITY;
        w.node.neverConfirm = false;
        const submitted = w.node.submitted.length;
        const applied = w.world.chain.applied.length;
        w.node.script.push({ confirmations: null }, new Error('the indexer is down'));
        expect(await w.run(def, ...argv), argv.join(' ')).toBe(2);
        expect(w.screen.errorText).toContain(`the status of the transaction ${hash} of the step one could not be read (the indexer is down). The transaction stays in flight, and nothing is built.`);
        expect(w.state('toy').in_flight?.tx_hash).toBe(hash);
        expect(w.state('toy').steps).toEqual({});
        expect(w.exposure().map((entry) => entry.tx_hash)).toEqual([hash]);
        expect(w.node.submitted).toHaveLength(submitted);
        expect(w.world.chain.applied).toHaveLength(applied);
        expect(ran).toEqual(['one']);
        expect(w.machine()).toMatchObject({ outcome: 'stopped', exit: 2, step: 'one' });
        reset(w);
        expect(await w.run(def, ...argv), argv.join(' ')).toBe(0);
        expect(w.state('toy').steps.one!.tx_hash).toBe(hash);
        expect(w.state('toy').in_flight).toBeNull();
        expect(ran).toEqual(['one', 'two']);
      }
    });
    it('stops when both reads fail', async () => {
      const w = await taskWorld();
      const { hash, def } = await strand(w, []);
      w.clock.t = AFTER_VALIDITY;
      w.node.neverConfirm = false;
      w.node.script.push(new Error('down'), new Error('down'));
      expect(await w.run(def, '--submit')).toBe(2);
      expect(w.screen.errorText).toContain('could not be read (down)');
      expect(w.state('toy').in_flight?.tx_hash).toBe(hash);
      expect(w.exposure().map((entry) => entry.tx_hash)).toEqual([hash]);
    });
    it('stays when the second read shows the transaction confirmed: the step is recorded as landed and the entry is kept', async () => {
      const w = await taskWorld();
      const { hash, def } = await strand(w, []);
      w.clock.t = AFTER_VALIDITY;
      w.node.neverConfirm = false;
      w.node.script.push({ confirmations: null }, { confirmations: 2 });
      expect(await w.run(def)).toBe(0);
      expect(w.state('toy').steps.one!.tx_hash).toBe(hash);
      expect(w.state('toy').in_flight).toBeNull();
      expect(w.exposure().map((entry) => entry.tx_hash)).toEqual([hash]);
      expect(w.screen.text).toContain('is confirmed: the step is recorded, and its reserve of the cap stays');
      expect(w.screen.text).toContain('step two: dry mode');
    });
    it('records the step when the second read gives 0 confirmations, because the transaction is in the newest block: its reserve stays, the step is not built again, and a run with --submit goes on to the next step', async () => {
      const w = await taskWorld();
      const ran: string[] = [];
      const { hash, def } = await strand(w, ran);
      w.clock.t = AFTER_VALIDITY;
      w.node.neverConfirm = false;
      const submitted = w.node.submitted.length;
      w.node.script.push({ confirmations: null }, { confirmations: 0 });
      expect(await w.run(def, '--submit')).toBe(0);
      expect(w.screen.text).toContain(`the transaction ${hash} of the step one is in the newest block: the step is recorded, and its reserve of the cap stays`);
      expect(w.state('toy').steps.one!.tx_hash).toBe(hash);
      expect(w.state('toy').in_flight).toBeNull();
      expect(ran).toEqual(['one', 'two']);
      expect(w.node.submitted).toHaveLength(submitted + 1);
      expect(w.exposure().map((entry) => entry.tx_hash)).toContain(hash);
    });
    it('stays when the first read shows the transaction confirmed late: it is recorded and its entry is kept', async () => {
      const w = await taskWorld();
      const { hash, def } = await strand(w, []);
      w.clock.t = AFTER_VALIDITY;
      w.node.neverConfirm = false;
      w.node.script.push({ confirmations: 1 });
      expect(await w.run(def)).toBe(0);
      expect(w.state('toy').steps.one!.tx_hash).toBe(hash);
      expect(w.exposure().map((entry) => entry.tx_hash)).toEqual([hash]);
      expect(w.node.reads.filter((read) => read === hash)).toHaveLength(1);
    });
    it('stays when no approval file is loaded, and a line says so: a run with --submit of a task that needs no approval lets the transaction go and goes on', async () => {
      const w = await taskWorld();
      const ran: string[] = [];
      const { hash } = await strand(w, [], { applied: false });
      rmSync(w.goPath);
      w.clock.t = AFTER_VALIDITY;
      w.node.neverConfirm = false;
      w.node.script.push({ confirmations: null }, { confirmations: null });
      expect(await w.run(unapproved(ran), '--submit')).toBe(0);
      expect(w.exposure().map((entry) => entry.tx_hash)).toEqual([hash]);
      expect(w.screen.text).toContain(`the transaction ${hash} of the step one is not on the chain, and its validity ended at ${iso(NOW + 30 * 60_000)}: it cannot land any more. No approval file is loaded, so its reserve stays in the cap file of its session.`);
      expect(w.state('toy').in_flight).toBeNull();
      expect(ran).toEqual(['one']);
    });
    it('stays when the approval file does not load in a run that needs none, and the line says why', async () => {
      const w = await taskWorld();
      const ran: string[] = [];
      const { hash } = await strand(w, [], { applied: false });
      writeFileSync(w.goPath, 'this is not JSON', { mode: 0o600 });
      w.clock.t = AFTER_VALIDITY;
      w.node.neverConfirm = false;
      w.node.script.push({ confirmations: null }, { confirmations: null });
      expect(await w.run(unapproved(ran), '--submit')).toBe(0);
      expect(w.exposure().map((entry) => entry.tx_hash)).toEqual([hash]);
      expect(w.screen.text).toContain('the approval file could not be used (the approval file is not JSON)');
      expect(w.screen.text).toContain('No approval file is loaded');
      expect(ran).toEqual(['one']);
    });
    it('stops a submit run with exit 2 before the settle when the approval file does not load, and leaves the transaction in flight with no read of its status', async () => {
      const w = await taskWorld();
      const { hash, def } = await strand(w, []);
      w.clock.t = NOW + 7 * HOUR;
      const reads = w.node.reads.length;
      expect(await w.run(def, '--submit')).toBe(2);
      expect(w.screen.errorText).toContain('has expired');
      expect(w.state('toy').in_flight?.tx_hash).toBe(hash);
      expect(w.node.reads).toHaveLength(reads);
      expect(w.exposure().map((entry) => entry.tx_hash)).toEqual([hash]);
      expect(w.machine()).toMatchObject({ outcome: 'stopped', exit: 2 });
    });
  });

  /** A transaction in flight, and an approval file that loads and does not allow this run: the run stops before the settle, and the bytes are not submitted again. */
  async function stopsBeforeTheSettle(change: (w: TaskWorld) => Partial<GoFile>, message: string): Promise<void> {
    const w = await taskWorld();
    const { hash, def } = await strand(w, []);
    w.writeGo(change(w));
    w.node.neverConfirm = false;
    w.node.script.push({ confirmations: null });
    const submitted = w.node.submitted.length;
    expect(await w.run(def, '--submit'), message).toBe(2);
    expect(w.screen.errorText).toContain(message);
    expect(w.node.submitted).toHaveLength(submitted);
    expect(w.node.reads).toEqual([]);
    expect(w.state('toy').in_flight?.tx_hash).toBe(hash);
    expect(w.state('toy').steps).toEqual({});
    expect(w.exposure().map((entry) => entry.tx_hash)).toEqual([hash]);
    expect(w.machine()).toMatchObject({ outcome: 'stopped', exit: 2 });
  }
  it('stops a submit run with exit 2 before the settle when the approval file no longer lists the task: the bytes are not submitted again', () => stopsBeforeTheSettle(() => ({ tasks: ['other'] }), 'does not list the task toy'));
  it('stops a submit run with exit 2 before the settle when the approval file names another run wallet: the bytes are not submitted again', () => stopsBeforeTheSettle((w) => ({ runWallet: w.keys.registry.addressOf('fee') }), 'another run wallet'));
});

describe('the rule for the inputs of a lost transaction', () => {
  const INPUTS = ['aa#0', 'bb#0'];
  const COLLATERAL = ['cc#0', 'dd#0'];
  const cases: Array<[string, string[], string[], string[], 'unspent' | 'spent', string]> = [
    ['every input unspent and no collateral input', INPUTS, [], INPUTS, 'unspent', ''],
    ['one of two inputs unspent, the other spent by another transaction, and no collateral input', INPUTS, [], ['bb#0'], 'unspent', ''],
    ['every input spent, because a transaction that landed spends all of them', INPUTS, [], [], 'spent', 'all 2 of its inputs are spent'],
    ['every input spent and the collateral inputs unspent', INPUTS, COLLATERAL, COLLATERAL, 'spent', 'all 2 of its inputs are spent'],
    ['an input unspent and every collateral input spent, because a script that failed spends all of them', INPUTS, COLLATERAL, ['aa#0'], 'spent', 'all 2 of its collateral inputs are spent'],
    ['an input and one of two collateral inputs unspent', INPUTS, COLLATERAL, ['aa#0', 'dd#0'], 'unspent', ''],
    ['every input and every collateral input unspent', INPUTS, COLLATERAL, [...INPUTS, ...COLLATERAL], 'unspent', ''],
    ['no input at all', [], [], [], 'spent', 'it has no input'],
  ];
  for (const [name, inputs, collateral, unspent, kind, why] of cases) {
    it(`judges ${name}: ${kind}`, () => {
      const verdict = judgeInputs(inputs, collateral, new Set(unspent));
      expect(verdict.kind).toBe(kind);
      if (verdict.kind === 'spent') expect(verdict.why).toContain(why);
    });
  }
  /** A node that holds the references in `unspent` as outputs and has its tip at the slot `tip`, and the lists of references that it was asked for. */
  const stub = (unspent: readonly string[], tip = 2000): { node: NodeAccess; asked: string[][] } => {
    const asked: string[][] = [];
    const node: NodeAccess = {
      networkFacts: async () => { throw new Error('not asked'); },
      networkTip: async () => ({ slot: tip }),
      resolveInputs: async (refs) => {
        asked.push([...refs]);
        return refs.filter((ref) => unspent.includes(ref)).map((ref) => ({ txHash: ref.slice(0, ref.indexOf('#')), outputIndex: Number(ref.slice(ref.indexOf('#') + 1)), address: 'addr_test', assets: {} }));
      },
      submit: async () => { throw new Error('not asked'); },
      txStatus: async () => { throw new Error('not asked'); },
    };
    return { node, asked };
  };
  it('asks the node for the inputs and the collateral inputs, each reference once, and judges the answer with the collateral inputs', async () => {
    const facts = { inputs: INPUTS, collateralInputs: ['cc#0', 'aa#0'], validityEndSlot: 1000n };
    const free = stub(['aa#0', 'cc#0']);
    expect(await checkInputs(free.node, facts)).toEqual({ kind: 'unspent' });
    expect(free.asked).toEqual([['aa#0', 'bb#0', 'cc#0']]);
    const failed = stub(['bb#0']);
    expect(await checkInputs(failed.node, facts)).toEqual({ kind: 'spent', why: 'all 2 of its collateral inputs are spent, and a script that failed spends all of them' });
    const landed = stub(['cc#0']);
    expect(await checkInputs(landed.node, facts)).toMatchObject({ kind: 'spent', why: expect.stringContaining('all 2 of its inputs are spent') });
  });
  it('counts the answer of the node only past the end of the validity and the margin, and reads nothing from the node for a transaction that has no input or no end of validity', async () => {
    const facts = { inputs: INPUTS, collateralInputs: [], validityEndSlot: 1000n };
    expect(await checkInputs(stub(INPUTS, 1020).node, facts)).toMatchObject({ kind: 'unreadable' });
    expect(await checkInputs(stub(INPUTS, 1021).node, facts)).toEqual({ kind: 'unspent' });
    expect(await checkInputs(stub(INPUTS, Number.NaN).node, facts)).toMatchObject({ kind: 'unreadable' });
    const none = stub(INPUTS);
    expect(await checkInputs(none.node, { ...facts, inputs: [] })).toEqual({ kind: 'unreadable', why: 'the transaction has no input' });
    expect(await checkInputs(none.node, { ...facts, validityEndSlot: null })).toMatchObject({ kind: 'unreadable', why: expect.stringContaining('no end of validity') });
    expect(none.asked).toEqual([]);
  });
});

describe('the end of the validity of a transaction in flight', () => {
  const FLIGHT = { valid_to: 1_000_000 };
  const RELEASE_AT = FLIGHT.valid_to + 60_000;
  const clockAt = (now: number): Clock => ({ now: () => now, sleep: async () => undefined });
  /** A node that has its tip at the slot `tip`, or fails with it, and the count of the reads of its tip. */
  const nodeAt = (tip: number | Error): { node: NodeAccess; reads: () => number } => {
    let reads = 0;
    const node: NodeAccess = {
      networkFacts: async () => { throw new Error('not asked'); },
      networkTip: async () => {
        reads += 1;
        if (tip instanceof Error) throw tip;
        return { slot: tip };
      },
      resolveInputs: async () => { throw new Error('not asked'); },
      submit: async () => { throw new Error('not asked'); },
      txStatus: async () => { throw new Error('not asked'); },
    };
    return { node, reads: () => reads };
  };
  /** A network guard that gives its answer, and the count of its calls. */
  const gate = (ok: boolean) => {
    let calls = 0;
    return { calls: () => calls, guard: async () => { calls += 1; return { guard: 'network' as const, ok, message: ok ? 'the node is on the network of the run' : 'the node is on the network with the magic 9' }; } };
  };
  it('says that a transaction with no end of validity may land at any time, whatever the clock and the node say, and asks neither the guard nor the node', async () => {
    const node = nodeAt(1_000_000_000);
    const network = gate(true);
    expect(await checkEndOfValidity(FLIGHT, null, { node: node.node, network, clock: clockAt(RELEASE_AT + 1_000_000_000) })).toEqual({ kind: 'may', why: 'its bytes have no end of validity, so it can land at any time' });
    expect([node.reads(), network.calls()]).toEqual([0, 0]);
  });
  it('counts the clock only after the grace time, and asks the guard and the node only then', async () => {
    const early = { node: nodeAt(10_000), network: gate(true) };
    expect((await checkEndOfValidity(FLIGHT, 100n, { node: early.node.node, network: early.network, clock: clockAt(RELEASE_AT) })).kind).toBe('may');
    expect([early.node.reads(), early.network.calls()]).toEqual([0, 0]);
    const late = { node: nodeAt(10_000), network: gate(true) };
    expect((await checkEndOfValidity(FLIGHT, 100n, { node: late.node.node, network: late.network, clock: clockAt(RELEASE_AT + 1) })).kind).toBe('over');
    expect([late.node.reads(), late.network.calls()]).toEqual([1, 1]);
  });
  it('counts the tip only past the end of the validity and the margin, and takes a tip that is not a whole number for a tip that is not past', async () => {
    const verdict = async (tip: number): Promise<string> => (await checkEndOfValidity(FLIGHT, 100n, { node: nodeAt(tip).node, network: gate(true), clock: clockAt(RELEASE_AT + 1) })).kind;
    expect([await verdict(99), await verdict(100), await verdict(120), await verdict(121)]).toEqual(['may', 'may', 'may', 'over']);
    expect([await verdict(Number.NaN), await verdict(120.5), await verdict(Number.POSITIVE_INFINITY)]).toEqual(['may', 'may', 'may']);
  });
});

describe('the status', () => {
  it('shows the steps, the transaction in flight, the next step, the network and the wallets, builds nothing, and takes no --submit', async () => {
    const w = await taskWorld({ wallets: { run: [1_000_000_000n, 5_000_000n], fee: [3_000_000n] } });
    w.writeGo();
    const ran: string[] = [];
    const def = toyTask(twoSteps(ran), { needs: { keys: () => ['run', 'fee', 'service'], chain: true, hosted: [], approval: 'submit' }, status: async () => ['a line of the task'] });
    await w.run(def, '--submit');
    reset(w);
    const submitted = w.node.submitted.length;
    expect(await w.run(def, 'status')).toBe(0);
    const lines = w.screen.lines;
    expect(lines).toContain('task toy: a toy task of two steps and a cleanup');
    expect(lines).toContain('use case inventory-reorder, network vector-mainnet');
    expect(lines).toContain(`state file ${join(w.stateDir, 'toy.state.json')}`);
    expect(lines.find((line) => line.trim().startsWith('one '))).toMatch(/one +confirmed .*transaction [0-9a-f]{64}, not verified/);
    expect(lines.find((line) => line.trim().startsWith('two '))).toMatch(/two +not run/);
    expect(lines).toContain('in flight: nothing');
    expect(lines).toContain('next: two');
    expect(lines).toContain('network guard: ok, the node is on vector-mainnet (magic 764824073)');
    const wallet = (name: string): string => lines.find((line) => line.startsWith(`wallet of the key ${name} `)) ?? '';
    expect(wallet('run')).toContain(`${w.keys.registry.hashOf('run')}: 1005.000000 units in 2 output(s), 2 pure output(s), 2 pure output(s) of 5 units or more for collateral`);
    expect(wallet('run')).not.toContain('NONE');
    expect(wallet('fee')).toContain('3.000000 units in 1 output(s), 1 pure output(s), 0 pure output(s) of 5 units or more for collateral');
    expect(wallet('fee')).toContain(`NONE: a script step of this wallet needs one, and a script step can spend it. Make one: send 5.5 units to ${w.keys.registry.addressOf('fee')}`);
    expect(wallet('service')).toContain('0.000000 units in 0 output(s)');
    expect(wallet('service')).not.toContain('NONE');
    expect(lines.at(-2)).toBe('a line of the task');
    expect(ran).toEqual(['one']);
    expect(w.node.submitted).toHaveLength(submitted);
    expect(w.machine()).toEqual({ task: 'toy', command: 'status', mode: 'dry', outcome: 'done', exit: 0, step: null, result: {} });
  });
  it('shows a transaction in flight and settles nothing', async () => {
    const w = await taskWorld();
    w.writeGo();
    const def = toyTask(landing([]));
    w.node.neverConfirm = true;
    await w.run(def, '--submit');
    const hash = w.state('toy').in_flight!.tx_hash;
    reset(w);
    w.node.neverConfirm = false;
    const reads = w.node.reads.length;
    expect(await w.run(def, 'status')).toBe(0);
    expect(w.screen.lines.find((line) => line.startsWith('in flight: the step one'))).toContain(`transaction ${hash}, signed at ${iso(NOW)}, may land until ${iso(NOW + 30 * 60_000)}`);
    expect(w.state('toy').in_flight?.tx_hash).toBe(hash);
    expect(w.node.reads).toHaveLength(reads);
  });
  it('refuses --submit and --all, and takes --run', async () => {
    const w = await taskWorld();
    const def = toyTask(twoSteps([]));
    for (const flag of ['--submit', '--all']) {
      reset(w);
      expect(await w.run(def, 'status', flag)).toBe(2);
      expect(w.screen.errorText).toContain('takes only --run and --use-case');
      expect(w.screen.errorText).toContain('usage: operator toy');
      expect(w.machine()).toEqual({ task: 'toy', command: null, mode: null, outcome: 'stopped', exit: 2, step: null, result: {} });
    }
    expect(await w.run(def, 'status', '--run', 'r1')).toBe(0);
    expect(existsSync(join(w.stateDir, 'toy.r1.state.json'))).toBe(true);
  });
  it('shows no wallet and no network guard for a task that reads no ledger, and asks the node nothing', async () => {
    const w = await taskWorld();
    const def = toyTask(twoSteps([]), { needs: { keys: () => ['run'], chain: false, hosted: [], approval: 'never' } });
    expect(await w.run(def, 'status')).toBe(0);
    expect(w.screen.text).not.toContain('wallet of the key');
    expect(w.screen.text).not.toContain('network guard');
    expect(w.node.networkReads).toBe(0);
  });
});

describe('the state of a run', () => {
  it('has the name of the run in the file names, keeps two runs of one task apart, and names the use case and the run in the record', async () => {
    const w = await taskWorld();
    w.writeGo();
    const ran: string[] = [];
    const def = toyTask(twoSteps(ran));
    expect(await w.run(def, '--submit', '--run', 'r1')).toBe(0);
    expect(await w.run(def, '--submit', '--run', 'r2')).toBe(0);
    expect(ran).toEqual(['one', 'one']);
    expect(w.state('toy', 'r1')).toMatchObject({ check: 'toy', record: `${USE_CASE}:r1` });
    expect(w.state('toy', 'r2')).toMatchObject({ check: 'toy', record: `${USE_CASE}:r2` });
    expect(Object.keys(w.state('toy', 'r1').steps)).toEqual(['one']);
    expect(Object.keys(w.state('toy', 'r2').steps)).toEqual(['one']);
    expect(w.evidence('toy', 'r1')).toEqual([]);
    expect(existsSync(join(w.stateDir, 'toy.state.json'))).toBe(false);
    expect(readdirSync(w.stateDir).filter((name) => name.startsWith('toy.')).sort()).toEqual(['toy.r1.evidence.json', 'toy.r1.state.json', 'toy.r2.evidence.json', 'toy.r2.state.json']);
    expect(w.screen.lines).toContain('run in submit mode, use case inventory-reorder, network vector-mainnet, run r1');
    expect(await w.run(def, '--submit', '--run', 'r1')).toBe(0);
    expect(ran).toEqual(['one', 'one', 'two']);
  });
  it('names the use case alone in the record when no run is given, and refuses the state file of another record', async () => {
    const w = await taskWorld();
    await w.run(toyTask(twoSteps([])));
    expect(w.state('toy')).toMatchObject({ record: USE_CASE });
    const path = join(w.stateDir, 'toy.state.json');
    writeFileSync(path, readFileSync(path, 'utf8').replace(`"record": "${USE_CASE}"`, '"record": "another-use-case"'), { mode: 0o600 });
    reset(w);
    expect(await w.run(toyTask(twoSteps([])))).toBe(2);
    expect(w.screen.errorText).toContain('is the state of another record');
  });
  it('loads the use case that the flag names, and refuses a name that is not on the list', async () => {
    const w = await taskWorld();
    const asked: string[] = [];
    const loadUseCase = async (name: string) => { asked.push(name); return w.use; };
    expect(await runTask(toyTask(twoSteps([])), ['--use-case', 'inventory-reorder'], w.deps({ loadUseCase }))).toBe(0);
    expect(await runTask(toyTask(twoSteps([])), [], w.deps({ loadUseCase }))).toBe(0);
    expect(asked).toEqual(['inventory-reorder', 'inventory-reorder']);
    reset(w);
    expect(await runTask(toyTask(twoSteps([])), ['--use-case', 'no-such-use-case'], { ...w.deps(), loadUseCase: undefined })).toBe(2);
    expect(w.screen.errorText).toContain('the use cases are inventory-reorder');
    expect(w.machine()).toMatchObject({ outcome: 'stopped', exit: 2 });
  });
});

describe('the hosted tools', () => {
  it('stop a step with exit 3 when they do not answer, and with exit 2 when a call does not match the tool', async () => {
    for (const [kind, code] of [['unreachable', 3], ['missing_tool', 3], ['protocol', 3], ['bad_arguments', 2]] as const) {
      const w = await taskWorld({ hosted: { call: async () => { throw new HostedError(kind, 'the hosted server could not be used'); } } });
      const asking: StepHandler = { name: 'one', run: async (session) => { await session.hosted.call('vector_get_vault', {}); return { kind: 'done', message: 'asked' }; } };
      expect(await w.run(toyTask([asking])), kind).toBe(code);
      expect(w.machine()).toMatchObject({ outcome: 'stopped', exit: code, step: 'one' });
      expect(w.evidence('toy'), kind).toEqual([]);
    }
  });
});

describe('the exit code of each kind of error', () => {
  const landed = [{ step: 'one', txHash: hashOf('landed') }];
  const facts = new FactsError('damaged', 'the facts file is damaged: it is not JSON');
  const cases: Array<[string, unknown, number]> = [
    ['a flag', new FlagError('unknown argument --x'), 2],
    ['the settings', new SettingsError(['set OPERATOR_KEYS_DIR', 'set OPERATOR_STATE_DIR']), 2],
    ['the key store', new KeyStoreError('missing', 'the key run is missing'), 2],
    ['a key file', new KeyFileError('run', 'mode', 'a bad mode'), 2],
    ['the state file', new StateError('invalid', 'the state file is not JSON'), 2],
    ['the evidence file', new EvidenceError('the evidence file is not JSON'), 2],
    ['a guard', new GuardRefusal('one', [{ guard: 'fee', ok: false, message: 'the fee is too high' }]), 2],
    ['a precondition', new PreconditionError('the record is not Active'), 2],
    ['the approval', new ApprovalError('the approval has expired'), 2],
    ['a load', new LoadError('missing', 'the file of the task does not exist'), 2],
    ['the run lock', new RunLockError('the run lock file exists'), 2],
    ['the facts file with no transaction landed', facts, 2],
    ['a conflict of the facts file with no transaction landed', new FactsConflict('the fact holds another value'), 2],
    ['a call that does not match a hosted tool', new HostedError('bad_arguments', 'x has no argument y'), 2],
    ['a hosted tool that refused a call', new ToolRefused('vector_build_identity_register', 'REFUSED: the record is not Active'), 2],
    ['a hosted server that cannot be reached', new HostedError('unreachable', 'the hosted server could not be used'), 3],
    ['a hosted server that lacks a tool', new HostedError('missing_tool', 'the hosted server lacks the tool x'), 3],
    ['an answer of the hosted server that breaks the protocol', new HostedError('protocol', 'the answer is no answer'), 3],
    ['a transaction that the ledger refused', new LandRefused('refused', { txHash: hashOf('r'), escrowRef: '', deliverBy: null, validTo: 1 }, 'BadInputsUTxO', 'abcd'), 1],
    ['a transaction that was not confirmed', new TxNotConfirmedError('not confirmed', { txHash: hashOf('n'), escrowRef: '', deliverBy: null, validTo: 1, mayLand: true }), 1],
    ['any other error', new Error('a step failed'), 1],
    ['a value that is no error', 'not an error', 1],
  ];
  it('is 2 before a signature, 3 for hosted tools, and 1 for a failure, and every refusal prints its message', () => {
    for (const [name, error, code] of cases) {
      const out = new MemoryOutput();
      expect(reportError(error, out), name).toBe(code);
      expect(out.errors.length, name).toBeGreaterThan(0);
      expect(out.lines, name).toEqual([]);
    }
  });
  it('prints the usage with a flag error, every problem of the settings, and the evidence note of a transaction that the ledger refused', () => {
    const out = new MemoryOutput();
    reportError(new FlagError('unknown argument --x'), out);
    expect(out.errors[0]).toBe('unknown argument --x');
    expect(out.errors.join('\n')).toContain('usage: operator <task>');
    const settings = new MemoryOutput();
    reportError(new SettingsError(['set A', 'set B']), settings);
    expect(settings.errors).toEqual(['set A', 'set B']);
    const refused = new MemoryOutput();
    reportError(new LandRefused('refused', { txHash: hashOf('r'), escrowRef: '', deliverBy: null, validTo: 1 }, 'BadInputsUTxO', 'abcd'), refused);
    expect(refused.errors.join('\n')).toContain('The evidence file holds the evaluation error and the body of the transaction. The state is unchanged.');
    const late = new MemoryOutput();
    reportError(new TxNotConfirmedError('not confirmed', { txHash: hashOf('n'), escrowRef: '', deliverBy: null, validTo: 1, mayLand: true }), late);
    expect(late.errors.join('\n')).toContain('the next run settles it before it builds anything');
  });
  it('takes a facts error for a failure, with the transaction named, when a transaction landed in the run, and for a stop when none did', () => {
    const out = new MemoryOutput();
    expect(reportError(facts, out, { landed })).toBe(1);
    expect(out.errors.join('\n')).toContain(`the transaction ${landed[0]!.txHash} of the step one landed in this run, and the facts file may lack its facts`);
    expect(reportError(new FactsConflict('the fact holds another value'), new MemoryOutput(), { landed })).toBe(1);
    expect(reportError(facts, new MemoryOutput(), { landed: [] })).toBe(2);
  });
  it('takes a dry stop for a dry result and not for a failure: exit 0, and the dry line on the screen and nothing on the error stream', () => {
    const out = new MemoryOutput();
    expect(reportError(new DryStop('one'), out)).toBe(0);
    expect(out.lines).toEqual([DRY_LINE]);
    expect(out.errors).toEqual([]);
  });

  const through: Array<[string, () => unknown, number, string]> = [
    ['a guard', () => new GuardRefusal('one', [{ guard: 'fee', ok: false, message: 'the fee is too high' }]), 2, 'stopped'],
    ['a hosted tool that refused a call', () => new ToolRefused('vector_build_identity_register', 'REFUSED: the record is not Active'), 2, 'stopped'],
    ['hosted tools that do not answer', () => new HostedError('unreachable', 'the hosted server could not be used'), 3, 'stopped'],
    ['a call that does not match a hosted tool', () => new HostedError('bad_arguments', 'x has no argument y'), 2, 'stopped'],
    ['the approval', () => new ApprovalError('the approval has expired'), 2, 'stopped'],
    ['a precondition', () => new PreconditionError('the wallet has no collateral'), 2, 'stopped'],
    ['a transaction that the ledger refused', () => new LandRefused('refused', { txHash: hashOf('r'), escrowRef: '', deliverBy: null, validTo: 1 }, 'BadInputsUTxO', 'abcd'), 1, 'failed'],
    ['a transaction that was not confirmed', () => new TxNotConfirmedError('not confirmed', { txHash: hashOf('n'), escrowRef: '', deliverBy: null, validTo: 1, mayLand: true }), 1, 'failed'],
    ['a dry stop of a flow of the kit', () => new DryStop('one'), 0, 'dry'],
    ['any other error', () => new Error('a step failed'), 1, 'failed'],
    ['a value that is no error', () => 'not an error', 1, 'failed'],
  ];
  for (const [name, make, code, outcome] of through) {
    it(`reaches the exit code and the machine line when a step throws ${name}`, async () => {
      const w = await taskWorld();
      const throwing: StepHandler = { name: 'one', run: async () => { throw make(); } };
      expect(await w.run(toyTask([throwing]))).toBe(code);
      expect(w.machine()).toMatchObject({ task: 'toy', command: 'run', mode: 'dry', outcome, exit: code, step: 'one' });
    });
  }
});

describe('an error that comes after the run signed a transaction', () => {
  const signedHash = hashOf('signed');
  const stops: Array<[string, unknown]> = [
    ['a flag', new FlagError('unknown argument --x')],
    ['the settings', new SettingsError(['set OPERATOR_KEYS_DIR'])],
    ['the key store', new KeyStoreError('missing', 'the key run is missing')],
    ['a key file', new KeyFileError('run', 'mode', 'a bad mode')],
    ['the state file', new StateError('invalid', 'the state file is not JSON')],
    ['the evidence file', new EvidenceError('the evidence file is not JSON')],
    ['a guard', new GuardRefusal('two', [{ guard: 'fee', ok: false, message: 'the fee is too high' }])],
    ['a precondition', new PreconditionError('the record is not Active')],
    ['the approval', new ApprovalError('the cap is passed')],
    ['a load', new LoadError('missing', 'the file of the task does not exist')],
    ['the run lock', new RunLockError('the run lock file exists')],
    ['a hosted tool that refused a call', new ToolRefused('vector_get_vault', 'REFUSED: not found')],
    ['a call that does not match a hosted tool', new HostedError('bad_arguments', 'x has no argument y')],
    ['the facts file', new FactsError('damaged', 'the facts file is damaged')],
  ];
  it('takes each error that gives exit 2 alone for a failure, exit 1, when a transaction of the run landed or is in flight, and the screen names the transaction', () => {
    for (const [name, error] of stops) {
      expect(reportError(error, new MemoryOutput()), `${name} alone`).toBe(2);
      for (const one of [{ step: 'one', txHash: signedHash }, { step: 'one', txHash: signedHash, unconfirmed: true as const }]) {
        const out = new MemoryOutput();
        expect(reportError(error, out, { landed: [one] }), name).toBe(1);
        expect(out.errors.join('\n'), name).toContain(`the transaction ${signedHash} of the step one ${one.unconfirmed === true ? 'was signed in this run and is not confirmed' : 'landed in this run'}`);
        expect(out.lines, name).toEqual([]);
      }
    }
  });
  it('keeps the exit code of every other error: 3 for hosted tools that cannot be used, 1 for a refused or an unconfirmed transaction and any other error, and 0 for a dry stop', () => {
    const others: Array<[unknown, number]> = [
      [new HostedError('unreachable', 'the hosted server could not be used'), 3],
      [new HostedError('missing_tool', 'the hosted server lacks the tool x'), 3],
      [new LandRefused('refused', { txHash: hashOf('r'), escrowRef: '', deliverBy: null, validTo: 1 }, 'BadInputsUTxO', 'abcd'), 1],
      [new TxNotConfirmedError('not confirmed', { txHash: hashOf('n'), escrowRef: '', deliverBy: null, validTo: 1, mayLand: true }), 1],
      [new Error('a step failed'), 1],
      [new DryStop('one'), 0],
    ];
    for (const [error, code] of others) expect(reportError(error, new MemoryOutput(), { landed: [{ step: 'one', txHash: signedHash }] })).toBe(code);
  });
  it('keeps exit 3 for hosted tools that cannot be used when the run signed a transaction: the screen names it, and the run is not called a failure', () => {
    for (const one of [{ step: 'one', txHash: signedHash }, { step: 'one', txHash: signedHash, unconfirmed: true as const }]) {
      for (const kind of ['unreachable', 'missing_tool', 'protocol'] as const) {
        const out = new MemoryOutput();
        expect(reportError(new HostedError(kind, 'the hosted server could not be used'), out, { landed: [one] }), kind).toBe(3);
        const text = out.errors.join('\n');
        expect(text, kind).toContain(`the transaction ${signedHash} of the step one ${one.unconfirmed === true ? 'was signed in this run and is not confirmed' : 'landed in this run'}`);
        expect(text, kind).not.toContain('a failure and not a stop');
      }
    }
    const alone = new MemoryOutput();
    expect(reportError(new HostedError('unreachable', 'the hosted server could not be used'), alone)).toBe(3);
    expect(alone.errors).toEqual(['the hosted server could not be used']);
  });
  it('is a failure when step one lands with --all and step two is refused: the screen and the evidence name the transaction, and the machine line says failed', async () => {
    const w = await taskWorld();
    w.writeGo();
    const ran: string[] = [];
    const refusing: StepHandler = { name: 'two', run: async () => { ran.push('two'); throw new PreconditionError('the record is not Active'); } };
    expect(await w.run(toyTask([landingStep('one', ran, 'run', 'fee', 3_000_000n), refusing]), '--submit', '--all')).toBe(1);
    const hash = w.state('toy').steps.one!.tx_hash!;
    expect(ran).toEqual(['one', 'two']);
    expect(w.node.submitted).toHaveLength(1);
    expect(w.screen.errorText).toContain('the record is not Active');
    expect(w.screen.errorText).toContain(`the transaction ${hash} of the step one landed in this run. The evidence file names the transaction.`);
    expect(w.screen.errorText).toContain('A transaction was signed in this run, so this is a failure and not a stop before a signature.');
    expect(w.evidence('toy')).toContainEqual(expect.objectContaining({ step: 'one', status: 'info', shows: { note: 'the transaction landed, and the run then stopped with an error', transaction: hash, error: 'PreconditionError' } }));
    expect(w.machine()).toMatchObject({ outcome: 'failed', exit: 1, step: 'two' });
  });
  it('stays a stop, exit 2, when the same refusal comes before any signature: no entry in the evidence, and nothing submitted', async () => {
    const w = await taskWorld();
    w.writeGo();
    const refusing: StepHandler = { name: 'one', run: async () => { throw new PreconditionError('the record is not Active'); } };
    expect(await w.run(toyTask([refusing, landingStep('two', [], 'run', 'fee', 3_000_000n)]), '--submit', '--all')).toBe(2);
    expect(w.evidence('toy')).toEqual([]);
    expect(w.node.submitted).toEqual([]);
    expect(w.machine()).toMatchObject({ outcome: 'stopped', exit: 2, step: 'one' });
  });
  it('is a failure when a hosted tool refuses the verification of the step that landed', async () => {
    const w = await taskWorld();
    w.writeGo();
    const one: StepHandler = { ...landingStep('one', [], 'run', 'fee', 3_000_000n), verify: async () => { throw new ToolRefused('vector_get_vault', 'REFUSED: not found'); } };
    expect(await w.run(toyTask([one]), '--submit')).toBe(1);
    const hash = w.state('toy').steps.one!.tx_hash!;
    expect(w.state('toy').steps.one!.verified_at).toBeNull();
    expect(w.evidence('toy')).toContainEqual(expect.objectContaining({ step: 'one', status: 'info', shows: expect.objectContaining({ transaction: hash, error: 'ToolRefused' }) }));
    expect(w.machine()).toMatchObject({ outcome: 'failed', exit: 1, step: 'one' });
  });
  it('is a failure when the evidence file fails after the step landed', async () => {
    const w = await taskWorld();
    w.writeGo();
    const base = landingStep('one', [], 'run', 'fee', 3_000_000n);
    const one: StepHandler = { name: 'one', run: async (session) => { await base.run(session); throw new EvidenceError('the evidence file could not be written'); } };
    expect(await w.run(toyTask([one]), '--submit')).toBe(1);
    const hash = w.state('toy').steps.one!.tx_hash!;
    expect(w.screen.errorText).toContain(`the transaction ${hash} of the step one landed in this run. The evidence file names the transaction.`);
    expect(w.machine()).toMatchObject({ outcome: 'failed', exit: 1, step: 'one' });
  });
  it('keeps exit 3 when the hosted tools cannot be used after the step landed: the screen and the evidence name the transaction, and the machine line says stopped', async () => {
    const w = await taskWorld();
    w.writeGo();
    const one: StepHandler = { ...landingStep('one', [], 'run', 'fee', 3_000_000n), verify: async () => { throw new HostedError('unreachable', 'the hosted server could not be used'); } };
    expect(await w.run(toyTask([one]), '--submit')).toBe(3);
    const hash = w.state('toy').steps.one!.tx_hash!;
    expect(w.state('toy').steps.one!.verified_at).toBeNull();
    expect(w.screen.errorText).toContain(`the transaction ${hash} of the step one landed in this run. The evidence file names the transaction.`);
    expect(w.evidence('toy')).toContainEqual(expect.objectContaining({ step: 'one', status: 'info', shows: { note: 'the transaction landed, and the run then stopped with an error', transaction: hash, error: 'HostedError' } }));
    expect(w.machine()).toMatchObject({ outcome: 'stopped', exit: 3, step: 'one' });
  });
  it('is a failure when a transaction of the run is in flight, and the line says that it is not confirmed', async () => {
    const w = await taskWorld();
    w.writeGo();
    const flight = hashOf('in flight');
    const signing: StepHandler = {
      name: 'one',
      run: async (session) => {
        session.state.setInFlight({ step: 'one', tx_hash: flight, signed_cbor: '84', valid_to: NOW + 30 * 60_000, signed_at: NOW, refs: {}, facts: {} });
        throw new GuardRefusal('one', [{ guard: 'fee', ok: false, message: 'the fee is too high' }]);
      },
    };
    expect(await w.run(toyTask([signing]), '--submit')).toBe(1);
    expect(w.screen.errorText).toContain(`the transaction ${flight} of the step one was signed in this run and is not confirmed. The next run settles it before it builds anything.`);
    expect(w.evidence('toy')).toContainEqual(expect.objectContaining({ step: 'one', status: 'info', shows: { note: 'the transaction is in flight, and the run then stopped with an error', transaction: flight, error: 'GuardRefusal' } }));
    expect(w.state('toy').in_flight?.tx_hash).toBe(flight);
    expect(w.machine()).toMatchObject({ outcome: 'failed', exit: 1, step: 'one' });
  });
});

describe('the facts file in a run', () => {
  /** A step that lands (it records itself) and then writes a fact that the facts file refuses. */
  const landsThen = (what: (session: TaskSession) => void, ran: string[] = []): StepHandler => ({
    name: 'one',
    run: async (session) => {
      await recordingStep('one', ran).run(session);
      what(session);
      return { kind: 'done', message: 'one is confirmed' };
    },
  });
  const MANIFEST = { uri: 'https://example.test/manifest.json', sha256: hashOf('manifest'), bytes: 10, readAt: '2026-11-15T12:00:00.000Z' };

  it('stops with exit 2 before the task runs when the facts file is damaged at open, with the state as it is', async () => {
    const w = await taskWorld();
    w.writeGo();
    writeFileSync(join(w.stateDir, 'facts.json'), 'this is not JSON', { mode: 0o600 });
    const ran: string[] = [];
    expect(await w.run(toyTask(twoSteps(ran)), '--submit')).toBe(2);
    expect(ran).toEqual([]);
    expect(w.screen.errorText).toContain('the facts file is damaged');
    expect(w.machine()).toMatchObject({ outcome: 'stopped', exit: 2, step: null });
  });
  it('lets the task write a fact through the session, and the fact is in the file', async () => {
    const w = await taskWorld();
    w.writeGo();
    expect(await w.run(toyTask([landsThen((session) => { session.facts.put('manifests', ['reorder-agent'], MANIFEST); })]), '--submit')).toBe(0);
    expect(w.facts().manifests['reorder-agent']).toEqual(MANIFEST);
  });
  it('is a failure, exit 1, when a fact cannot be written after a transaction landed, and the evidence and the screen name the transaction', async () => {
    const w = await taskWorld();
    w.writeGo();
    const ran: string[] = [];
    const def = toyTask([landsThen((session) => { session.facts.put('records', ['reorder-agent'], { not: 'a fact' }); }, ran)]);
    expect(await w.run(def, '--submit')).toBe(1);
    const hash = w.state('toy').steps.one!.tx_hash!;
    expect(w.evidence('toy')).toEqual([expect.objectContaining({ step: 'one', status: 'info', shows: { note: 'the transaction landed, and the facts file could not be written', transaction: hash, facts_error: 'value' } })]);
    expect(w.screen.errorText).toContain(`the transaction ${hash} of the step one landed in this run, and the facts file may lack its facts`);
    expect(w.machine()).toMatchObject({ outcome: 'failed', exit: 1, step: 'one' });
  });
  it('is a failure when a second value of a fact is refused after a transaction landed', async () => {
    const w = await taskWorld();
    w.writeGo();
    const def = toyTask([landsThen((session) => {
      session.facts.put('manifests', ['reorder-agent'], MANIFEST);
      session.facts.put('manifests', ['reorder-agent'], { ...MANIFEST, bytes: 11 });
    })]);
    expect(await w.run(def, '--submit')).toBe(1);
    expect(w.evidence('toy')[0]).toMatchObject({ status: 'info', shows: { facts_error: 'conflict' } });
  });
  it('counts a part of a step as a landed transaction', async () => {
    const w = await taskWorld();
    w.writeGo();
    const part: StepHandler = {
      name: 'one',
      run: async (session) => {
        session.state.setNote('part.hire:pay', { confirmed_at: iso(NOW), tx_hash: hashOf('part'), refs: {}, facts: {} });
        session.facts.put('records', ['x'], {});
        return { kind: 'done', message: 'never' };
      },
    };
    expect(await w.run(toyTask([part]), '--submit')).toBe(1);
    expect(w.evidence('toy')).toEqual([expect.objectContaining({ step: 'hire:pay', status: 'info', shows: expect.objectContaining({ transaction: hashOf('part') }) })]);
  });
  it('is a stop, exit 2, when a fact cannot be written and nothing landed, and writes no evidence', async () => {
    const w = await taskWorld();
    w.writeGo();
    const early: StepHandler = { name: 'one', run: async (session) => { session.facts.put('records', ['reorder-agent'], { not: 'a fact' }); return { kind: 'done', message: 'never' }; } };
    expect(await w.run(toyTask([early]), '--submit')).toBe(2);
    expect(w.evidence('toy')).toEqual([]);
    expect(w.machine()).toMatchObject({ outcome: 'stopped', exit: 2, step: 'one' });
  });
});

describe('the run lock', () => {
  it('refuses a run while the lock file exists, names the file, leaves it as it is, and opens and writes no other file', async () => {
    const w = await taskWorld();
    w.writeGo();
    rmSync(w.goPath);
    writeFileSync(w.lockPath, 'held by another run\n', { mode: 0o600 });
    const ran: string[] = [];
    expect(await w.run(toyTask(twoSteps(ran)), '--submit')).toBe(2);
    expect(ran).toEqual([]);
    expect(w.screen.errorText).toContain(`the run lock file ${w.lockPath} exists: another run holds it, or a run stopped and left it`);
    expect(readFileSync(w.lockPath, 'utf8')).toBe('held by another run\n');
    expect(readdirSync(w.stateDir)).toEqual(['run.lock']);
    expect(w.machine()).toEqual({ task: 'toy', command: 'run', mode: 'submit', outcome: 'stopped', exit: 2, step: null, result: {} });
  });
  it('refuses a status and a dry run while the lock file exists', async () => {
    const w = await taskWorld();
    w.writeGo();
    writeFileSync(w.lockPath, 'held by another run\n', { mode: 0o600 });
    for (const argv of [['status'], [], ['cleanup']]) {
      reset(w);
      expect(await w.run(toyTask(twoSteps([])), ...argv), argv.join(' ')).toBe(2);
      expect(w.screen.errorText).toContain('run.lock');
    }
  });
  it('holds the lock while the task runs, says who holds it, and removes it at the end of a run of any ending', async () => {
    const w = await taskWorld();
    w.writeGo();
    const during: Array<string | null> = [];
    const probing = (end: StepHandler['run']): StepHandler => ({
      name: 'one',
      run: async (session) => { during.push(existsSync(w.lockPath) ? readFileSync(w.lockPath, 'utf8') : null); return end(session); },
    });
    const endings: Array<[string, StepHandler['run'], string[], number]> = [
      ['a step that is done', async () => ({ kind: 'done', message: 'done' }), ['--submit'], 0],
      ['a step that is shown', async () => ({ kind: 'dry' }), [], 0],
      ['a step that waits', async (session) => waitFor(session.clock.now() + 1000, session.clock.now(), 'wait'), ['--submit'], 4],
      ['a step that fails', async () => { throw new Error('a step failed'); }, ['--submit'], 1],
    ];
    for (const [name, end, argv, code] of endings) {
      expect(await w.run(toyTask([probing(end)]), ...argv), name).toBe(code);
      expect(existsSync(w.lockPath), name).toBe(false);
    }
    expect(during).toHaveLength(4);
    for (const note of during) expect(note).toMatch(/^toy run in (dry|submit) mode, started 2026-11-15T12:00:00\.000Z\n$/);
    reset(w);
    rmSync(w.goPath);
    expect(await w.run(toyTask(twoSteps([])), '--submit')).toBe(2);
    expect(existsSync(w.lockPath)).toBe(false);
    expect(await w.run(toyTask(twoSteps([])))).toBe(0);
  });
  it('is not taken by a command line that is refused before the state folder is known', async () => {
    const w = await taskWorld();
    expect(await w.run(toyTask(twoSteps([])), '--sumbit')).toBe(2);
    expect(existsSync(w.stateDir)).toBe(false);
  });
  it('removes the lock when the report of an error fails, and gives the failure of the screen', async () => {
    const w = await taskWorld();
    const broken = { out: (line: string) => { w.screen.out(line); }, err: () => { throw new Error('the screen failed'); } };
    const failing: StepHandler = { name: 'one', run: async () => { throw new Error('a step failed'); } };
    await expect(runTask(toyTask([failing]), [], w.deps({ out: broken }))).rejects.toThrow('the screen failed');
    expect(existsSync(w.lockPath)).toBe(false);
  });
});

describe('the network result of a run', () => {
  const peeking = (seen: Array<{ ok: boolean; message: string } | null>): StepHandler => ({
    name: 'one',
    run: async (session) => { seen.push(session.networkResult()); return { kind: 'done', message: 'seen' }; },
  });
  it('is the result of the one network guard, ok on the right network, with the node asked once', async () => {
    const w = await taskWorld();
    const seen: Array<{ ok: boolean; message: string } | null> = [];
    expect(await w.run(toyTask([peeking(seen)]))).toBe(0);
    expect(seen).toEqual([{ guard: 'network', ok: true, message: 'the node is on vector-mainnet (magic 764824073)' }]);
    expect(w.node.networkReads).toBe(1);
  });
  it('says that the guard failed when it failed, and a flow that signs with a SYNC function refuses on it', async () => {
    const w = await taskWorld();
    w.node.facts = { magic: 9, systemStartMs: null };
    const seen: Array<{ ok: boolean; message: string } | null> = [];
    const signing: StepHandler = {
      name: 'one',
      run: async (session) => {
        const network = session.networkResult();
        seen.push(network);
        if (network === null || !network.ok) throw new GuardRefusal('one', [network ?? { guard: 'network', ok: false, message: 'the network guard has not run' }]);
        return { kind: 'done', message: 'signed' };
      },
    };
    expect(await w.run(toyTask([signing]))).toBe(2);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.ok).toBe(false);
    expect(seen[0]?.message).toContain('the magic 9');
    expect(w.screen.errorText).toContain('network guard: FAIL');
    expect(w.machine()).toMatchObject({ outcome: 'stopped', exit: 2 });
  });
  it('is read once by a status, which prints it', async () => {
    const w = await taskWorld();
    w.node.facts = { magic: 9, systemStartMs: null };
    expect(await w.run(toyTask(twoSteps([])), 'status')).toBe(0);
    expect(w.screen.text).toContain('network guard: FAIL, the node is on the network with the magic 9');
    expect(w.node.networkReads).toBe(1);
  });
  it('is not asked for a task that reads no ledger: the node is not read, and the task sees no result', async () => {
    const w = await taskWorld();
    const seen: Array<{ ok: boolean; message: string } | null> = [];
    expect(await w.run(toyTask([peeking(seen)], { needs: { keys: () => ['run'], chain: false, hosted: [], approval: 'never' } }))).toBe(0);
    expect(seen).toEqual([null]);
    expect(w.node.networkReads).toBe(0);
  });
});

describe('the machine line', () => {
  it('is the last line of the screen after each ending, has the seven members in a fixed order, and holds the result of the task', async () => {
    const w = await taskWorld();
    w.writeGo();
    const def = toyTask(twoSteps([]), { result: () => ({ did: 'did:vector:abc', fee: 5n }) });
    for (const argv of [['--submit'], ['status'], [], ['cleanup']]) {
      reset(w);
      await w.run(def, ...argv);
      const last = w.screen.lines.at(-1)!;
      expect(last.startsWith(PREFIX)).toBe(true);
      expect(last.slice(PREFIX.length).includes('\n')).toBe(false);
      expect(Object.keys(w.machine())).toEqual(['task', 'command', 'mode', 'outcome', 'exit', 'step', 'result']);
    }
    reset(w);
    await w.run(def, '--submit', '--all');
    expect(w.machine()).toMatchObject({ outcome: 'finished', result: { did: 'did:vector:abc', fee: '5' } });
  });
  it('has an empty result when the task did not start, and when the result of the task fails: the line is still printed and the exit code is kept', async () => {
    const w = await taskWorld();
    let asked = 0;
    const def = toyTask(twoSteps([]), { result: () => { asked += 1; throw new Error('the result broke'); } });
    expect(await w.run(def, '--submit')).toBe(2);
    expect(asked).toBe(0);
    expect(w.machine()).toMatchObject({ outcome: 'stopped', result: {} });
    w.writeGo();
    reset(w);
    expect(await w.run(def, '--submit')).toBe(0);
    expect(asked).toBe(1);
    expect(w.screen.errorText).toContain('the result of the task could not be made (the result broke)');
    expect(w.machine()).toMatchObject({ outcome: 'done', exit: 0, result: {} });
  });
  it('says dry for a step that was only shown, and finished with no step when every step was confirmed', async () => {
    const w = await taskWorld();
    w.writeGo();
    const def = toyTask(twoSteps([]));
    await w.run(def);
    expect(w.machine()).toMatchObject({ mode: 'dry', outcome: 'dry', step: 'one' });
    await w.run(def, '--submit', '--all');
    reset(w);
    await w.run(def);
    expect(w.machine()).toMatchObject({ outcome: 'finished', step: null });
  });
  it('names the step that a task that does not use runSteps ended at, from the state file', async () => {
    const w = await taskWorld();
    w.writeGo();
    const own: StepHandler = recordingStep('one', []);
    const def = toyTask([own, recordingStep('two', [])], { next: async (session) => own.run(session) });
    await w.run(def);
    expect(w.machine()).toMatchObject({ outcome: 'dry', step: 'one' });
    await w.run(def, '--submit');
    expect(w.machine()).toMatchObject({ outcome: 'done', step: 'one' });
  });
  it('leaves a result that holds a mark of a secret out of the line, and keeps the exit code', async () => {
    const w = await taskWorld();
    w.writeGo();
    const def = toyTask(twoSteps([]), { result: () => ({ did: 'did:vector:abc', header: 'Bearer abcdef' }) });
    expect(await w.run(def, '--submit')).toBe(0);
    expect(w.machine()).toMatchObject({ outcome: 'done', exit: 0, step: null, result: {} });
    expect(w.allText()).not.toContain('Bearer abcdef');
  });
});

describe('the cleanup', () => {
  it('runs the cleanup of the task and not the next step, with the same approval and the same lock', async () => {
    const w = await taskWorld();
    const ran: string[] = [];
    expect(await w.run(toyTask(twoSteps(ran)), 'cleanup')).toBe(0);
    expect(ran).toEqual([]);
    expect(w.screen.lines).toContain('there is nothing to take back');
    expect(w.screen.lines).toContain('cleanup in dry mode, use case inventory-reorder, network vector-mainnet');
    expect(w.machine()).toMatchObject({ command: 'cleanup', outcome: 'done', exit: 0 });
    reset(w);
    expect(await w.run(toyTask(twoSteps(ran)), 'cleanup', '--submit')).toBe(2);
    expect(w.screen.errorText).toContain('the approval file does not exist');
  });
  it('runs the cleanup of a submit run under a good approval, and prints the approval', async () => {
    const w = await taskWorld();
    w.writeGo();
    expect(await w.run(toyTask(twoSteps([])), 'cleanup', '--submit')).toBe(0);
    expect(w.screen.lines).toContain('approval: session s1, cap 100.000000 units, 0.000000 units reserved');
    expect(w.screen.lines).toContain('there is nothing to take back');
    expect(w.machine()).toMatchObject({ command: 'cleanup', mode: 'submit', outcome: 'done', exit: 0 });
  });
});

describe('the command line of the pack', () => {
  it('prints the usage and the names of the tasks, and exits 2, when no task is named', async () => {
    const w = await taskWorld();
    expect(await runCli([], w.deps())).toBe(2);
    expect(w.screen.errors).toEqual(usageLines());
    expect(w.screen.errors[0]).toBe('usage: operator <task> [status | run | cleanup] [--submit] [--all] [--use-case <name>] [--run <label>] [the flags of the task]');
    expect(w.screen.errors[1]).toBe(`tasks: ${TASK_NAMES.join(', ')}`);
    expect(w.screen.errors[2]).toBe('With no --submit a task builds and checks its next step and signs nothing. Without --all a run does one step.');
    expect(w.machine()).toEqual({ task: null, command: null, mode: null, outcome: 'stopped', exit: 2, step: null, result: {} });
    expect(existsSync(w.stateDir)).toBe(false);
  });
  it('prints the same for a name that is not a task, whatever it looks like', async () => {
    for (const name of ['bogus', '--help', 'help', '--submit', 'toy', '', 'KEYS', 'keys ', '../keys']) {
      const w = await taskWorld();
      expect(await runCli([name, 'status'], w.deps({ loadTask: async () => { throw new Error('must not load'); } })), name).toBe(2);
      expect(w.screen.errors).toEqual(usageLines());
      expect(w.machine()).toMatchObject({ task: null, outcome: 'stopped', exit: 2 });
    }
  });
  it('loads the task by its name, gives it the rest of the command line, and runs it', async () => {
    const w = await taskWorld();
    const asked: string[] = [];
    const ran: string[] = [];
    const def = toyTask(twoSteps(ran), { name: 'fund' });
    const loadTask = async (name: string): Promise<TaskDefinition> => { asked.push(name); return def; };
    expect(await runCli(['fund', 'status', '--run', 'r1'], w.deps({ loadTask }))).toBe(0);
    expect(asked).toEqual(['fund']);
    expect(w.screen.lines).toContain('task fund: a toy task of two steps and a cleanup');
    expect(w.machine()).toMatchObject({ task: 'fund', command: 'status', outcome: 'done' });
    expect(existsSync(join(w.stateDir, 'fund.r1.state.json'))).toBe(true);
    reset(w);
    expect(await runCli(['fund'], w.deps({ loadTask }))).toBe(0);
    expect(ran).toEqual(['one']);
  });
  it('stops with exit 2 and the machine line of the task when the file of a task cannot be loaded', async () => {
    const w = await taskWorld();
    const loadTask = async (): Promise<TaskDefinition> => { throw new LoadError('missing', 'the file of the task keys does not exist'); };
    expect(await runCli(['keys', '--submit'], w.deps({ loadTask }))).toBe(2);
    expect(w.screen.errorText).toContain('the file of the task keys does not exist');
    expect(w.machine()).toEqual({ task: 'keys', command: null, mode: null, outcome: 'stopped', exit: 2, step: null, result: {} });
  });
});

describe('what a run prints', () => {
  it('holds no seed of a key of the registry in any line, any error, any file of the state folder, or the machine line, in each kind of run', async () => {
    const w = await taskWorld({ keys: ['run', 'fee', 'service'], shared: ['run', 'fee'] });
    const ran: string[] = [];
    const def = toyTask(landing(ran), { needs: { keys: () => ['run', 'fee', 'service'], chain: true, hosted: [], approval: 'submit' } });
    await w.run(def);
    await w.run(def, '--submit');
    w.writeGo();
    await w.run(def, '--submit', '--all');
    await w.run(def, 'status');
    await w.run(def, 'cleanup', '--submit');
    await w.run(def, '--sumbit');
    rmSync(join(w.keys.root, 'shared', 'fee.seed'));
    await w.run(def, '--submit');
    const text = w.allText();
    expect(text).toContain('operator-result: ');
    for (const name of ['run', 'fee', 'service']) expect(text, name).not.toContain(w.keys.seedOf(name));
  });
});
