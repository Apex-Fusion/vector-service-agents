// scripts/operator/lib/runner.ts - the command line of the operator pack, its runner, and the steps of a task.
//
//   operator <task> [status | run | cleanup] [--submit] [--all] [--use-case <name>] [--run <label>] [the flags of the task]
//
//   run (the default)  Does the next step of the task. With no --submit it builds and checks the step and prints what it would sign: it signs and submits nothing, and it needs no approval file.
//                      With --submit it signs, submits and waits for the confirmation, and then records the step. A task that moves funds or makes a permanent record needs the approval file of the
//                      session. Without --all a run does one step. With --all a run goes on after each step that is done, and stops at the first step that is only shown, that must wait, or that fails.
//   status             Shows the state, the transaction in flight, the next step and the wallets, with no build. It takes no flag but --run and --use-case.
//   cleanup            Takes back what can come back. The task says what.
//   cleanup --release=<hash>
//                      Lets the transaction in flight with this hash go, after the operator checked the chain. It is the way out for a transaction that a run keeps because its inputs are spent.
//                      It refuses while the transaction may still land, in a dry run too: the clock must be past the end of its validity by a minute, and the tip of the node, when the node answers, must be past it too.
//                      It refuses too when the indexer knows the transaction, because that transaction landed: it reads the status once, and a read that fails adds no check.
//                      It changes something only with --submit, and the cleanup of the task does not run then.
//
// A transaction that was signed and not seen confirmed is settled before anything is built. The network guard runs before the settle: a node of another network cannot say that a transaction is lost.
// One run lock file in the state folder keeps two runs from writing the state, the facts and the cap file at the same time.
// Exit: 0 the step is done, shown or finished; 1 a step failed, or an error came after the run signed a transaction; 2 a flag, a setting, a key, a file, an approval, a guard or a precondition stopped the
// run before a signature; 3 the hosted tools cannot be used; 4 a wait is open: the output says how long is left. The last line of stdout is the machine line.
import { closeSync, existsSync, openSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { collateralAdvice, isCollateralOutput } from '../../checks/lib/collateral.ts';
import { EvidenceError, EvidenceFile } from '../../checks/lib/evidence.ts';
import { duration, iso, units } from '../../checks/lib/format.ts';
import type { GuardResult } from '../../checks/lib/guards.ts';
import { DryStop } from '../../checks/lib/hire-types.ts';
import { HostedError } from '../../checks/lib/hosted.ts';
import { GRACE_MS, recordLanded, settleInFlight } from '../../checks/lib/inflight.ts';
import { KeyFileError } from '../../checks/lib/keys.ts';
import { GuardRefusal, LandRefused } from '../../checks/lib/land.ts';
import { TxNotConfirmedError } from '../../checks/lib/platform.ts';
import type { Utxo } from '../../checks/lib/platform.ts';
import type { Clock, NodeAccess, Output } from '../../checks/lib/ports.ts';
import { PreconditionError } from '../../checks/lib/session.ts';
import type { ChainAccess, Mode, StepOutcome } from '../../checks/lib/session.ts';
import { SettingsError } from '../../checks/lib/settings.ts';
import type { Env } from '../../checks/lib/settings.ts';
import { StateError, StateFile } from '../../checks/lib/state.ts';
import type { CheckState, InFlight, StepRecord } from '../../checks/lib/state.ts';
import { factsOf } from '../../checks/lib/txfacts.ts';
import type { TxFacts } from '../../checks/lib/txfacts.ts';
import type { HostedTools } from '../../checks/lib/hosted.ts';
import { TASK_NAMES } from '../tasks/names.ts';
import { ApprovalError, Exposure, loadGo, requireGo } from './approval.ts';
import type { GoFile } from './approval.ts';
import type { OperatorSettings, TaskDefinition, TaskFlags, TaskSession, UseCase } from './contract.ts';
import { FactsError, FactsFile } from './facts.ts';
import { ToolRefused } from './land-hosted.ts';
import { LoadError, loadTask, loadUseCase } from './load.ts';
import { operatorResult } from './output.ts';
import type { OperatorResultFields, ResultCommand, ResultOutcome } from './output.ts';
import { KeyStoreError, codeOf, loadRegistry } from './registry.ts';
import type { KeySpec, Registry } from './registry.ts';
import { AWAIT_MS, POLL_MS, connect, makeSession } from './session.ts';
import type { Connections } from './session.ts';
import { parseOperatorSettings } from './settings.ts';

// The parts of the checks that a task needs from its runner: a wait that says how long is left, the real clock and the real screen.
export { consoleOutput, realClock, waitFor } from '../../checks/lib/runner.ts';

export type Command = ResultCommand;

export class FlagError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FlagError';
  }
}

/** A run lock file exists: another run holds it, or a run stopped and left it. The run stops before it reads or writes any state. */
export class RunLockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RunLockError';
  }
}

// ---- the command line ----

const COMMANDS: readonly Command[] = ['status', 'run', 'cleanup'];
const isCommand = (word: string): word is Command => COMMANDS.some((command) => command === word);
const LABEL = /^[a-z0-9][a-z0-9-]{0,31}$/;
const USE_CASE_NAME = /^[a-z][a-z0-9-]{0,47}$/;
const FLAG_NAME = /^[a-z][a-z0-9-]{0,31}$/;
/** The flags that every task has. A task cannot list one of them. */
const GLOBAL_BOOLEANS: readonly string[] = ['submit', 'all'];
const GLOBAL_VALUES: readonly string[] = ['run', 'use-case', 'release'];
/** The flags with a value that `status` takes. */
const STATUS_VALUES: readonly string[] = ['run', 'use-case'];
const TX_HASH = /^[0-9a-f]{64}$/;
/** A word that is short and made of letters, digits and hyphens: a message can show it. Any other word can hold a secret, and a message does not show it. */
const SHOWABLE_WORD = /^-{0,2}[A-Za-z0-9][A-Za-z0-9-]{0,31}$/;

export interface Arguments {
  readonly command: Command;
  readonly mode: Mode;
  readonly all: boolean;
  readonly flags: TaskFlags;
  readonly useCase: string | null;
  readonly run: string | null;
  /** The hash of the transaction that `cleanup --release` lets go, or null. */
  readonly release: string | null;
}

const SYNOPSIS = '[status | run | cleanup] [--submit] [--all] [--use-case <name>] [--run <label>]';
const RULES = 'With no --submit a task builds and checks its next step and signs nothing. Without --all a run does one step.';

/** The usage lines. With a task they show the flags of the task, and without one they show the names of the tasks. */
export function usageLines(def?: Pick<TaskDefinition, 'name' | 'flags' | 'valued'>): string[] {
  if (def === undefined) return [`usage: operator <task> ${SYNOPSIS} [the flags of the task]`, `tasks: ${TASK_NAMES.join(', ')}`, RULES];
  const flags = def.flags.map((flag) => ` [--${flag}]`).join('');
  const valued = def.valued.map((flag) => ` [--${flag} <value>]`).join('');
  return [`usage: operator ${def.name} ${SYNOPSIS}${flags}${valued}`, RULES];
}

/** The flags that a run was given, and the names that it may ask for: the flags of the task and the four that every task has. A name that the task does not list is a mistake of the task. */
class Flags implements TaskFlags {
  readonly #known: ReadonlySet<string>;
  readonly #on: ReadonlySet<string>;
  readonly #values: ReadonlyMap<string, string>;

  constructor(known: ReadonlySet<string>, on: ReadonlySet<string>, values: ReadonlyMap<string, string>) {
    this.#known = known;
    this.#on = on;
    this.#values = values;
  }

  has(name: string): boolean {
    this.#require(name);
    return this.#on.has(name) || this.#values.has(name);
  }

  value(name: string): string | undefined {
    this.#require(name);
    return this.#values.get(name);
  }

  #require(name: string): void {
    if (!this.#known.has(name)) throw new Error('the task asked for a flag that it does not list');
  }
}

/** The boolean and the valued flags of a task, checked: a name of lower-case letters, digits and hyphens, listed once, and not one of the four that every task has. */
function flagNames(def: Pick<TaskDefinition, 'flags' | 'valued'>): { booleans: ReadonlySet<string>; valued: ReadonlySet<string> } {
  const seen = new Set<string>([...GLOBAL_BOOLEANS, ...GLOBAL_VALUES]);
  const take = (names: readonly string[]): Set<string> => {
    const taken = new Set<string>();
    for (const name of names) {
      if (typeof name !== 'string' || !FLAG_NAME.test(name) || seen.has(name)) {
        throw new LoadError('shape', 'the task lists a flag name that is not allowed: a name has lower-case letters, digits and hyphens, is listed once, and is not submit, all, run, use-case or release');
      }
      seen.add(name);
      taken.add(name);
    }
    return taken;
  };
  return { booleans: take(def.flags), valued: take(def.valued) };
}

/**
 * Reads the command line of a task (the words after the name of the task). A word that is not known is refused: nothing is guessed, and a message never shows a value. A flag is given once. A
 * valued flag takes the next word or `--name=value`. A flag of the task takes an empty value too, but only as `--name=`: an empty word is never taken for a value, because a shell can drop a quote or an
 * empty variable, and then the next word would become the value. `--run`, `--use-case` and `--release` take no empty value. `--release` names a transaction by its hash and goes with the command
 * cleanup only. `status` takes no flag but --run and --use-case.
 */
export function parseArguments(def: Pick<TaskDefinition, 'flags' | 'valued'>, argv: readonly string[]): Arguments {
  const names = flagNames(def);
  const known = new Set<string>([...GLOBAL_BOOLEANS, ...GLOBAL_VALUES, ...names.booleans, ...names.valued]);
  const booleans = new Set<string>([...GLOBAL_BOOLEANS, ...names.booleans]);
  const valued = new Set<string>([...GLOBAL_VALUES, ...names.valued]);
  let command: Command | null = null;
  const on = new Set<string>();
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const word = argv[index]!;
    if (isCommand(word)) {
      if (command !== null) throw new FlagError(`two commands: ${command} and ${word}`);
      command = word;
      continue;
    }
    const equals = word.indexOf('=');
    const name = word.startsWith('--') ? word.slice(2, equals === -1 ? undefined : equals) : '';
    const shown = equals === -1 ? word : word.slice(0, equals);
    if (!booleans.has(name) && !valued.has(name)) throw new FlagError(SHOWABLE_WORD.test(shown) ? `unknown argument ${shown}` : 'an argument that is no command and no flag');
    if (on.has(name) || values.has(name)) throw new FlagError(`the flag --${name} is given twice`);
    if (booleans.has(name)) {
      if (equals !== -1) throw new FlagError(`the flag --${name} takes no value`);
      on.add(name);
    } else {
      const attached = equals !== -1;
      const next = attached ? word.slice(equals + 1) : argv[index + 1];
      const emptyAllowed = attached && !GLOBAL_VALUES.includes(name);
      if (next === undefined || (next === '' && !emptyAllowed) || (!attached && next.startsWith('--'))) throw new FlagError(`the flag --${name} needs a value`);
      if (!attached) index += 1;
      values.set(name, next);
    }
  }
  if (command === 'status' && ([...on].length > 0 || [...values.keys()].some((name) => !STATUS_VALUES.includes(name)))) {
    throw new FlagError('status shows the state and the wallets and takes only --run and --use-case');
  }
  const run = values.get('run') ?? null;
  if (run !== null && !LABEL.test(run)) throw new FlagError('--run is a label of 1 to 32 lower-case letters, digits and hyphens, and it starts with a letter or a digit');
  const useCase = values.get('use-case') ?? null;
  if (useCase !== null && !USE_CASE_NAME.test(useCase)) throw new FlagError('--use-case is the name of a use case: lower-case letters, digits and hyphens, and it starts with a letter');
  const release = values.get('release') ?? null;
  if (release !== null && !TX_HASH.test(release)) throw new FlagError('--release is the hash of a transaction: 64 lower-case hex characters');
  if (release !== null && command !== 'cleanup') throw new FlagError('--release goes with the command cleanup only');
  return { command: command ?? 'run', mode: on.has('submit') ? 'submit' : 'dry', all: on.has('all'), flags: new Flags(known, on, values), useCase, run, release };
}

// ---- the steps of a task ----

export interface StepHandler<Extra = unknown> {
  name: string;
  run(session: TaskSession<Extra>): Promise<StepOutcome>;
  /** Reads the hosted tools after the step, and throws when what they show is not what the step did. It runs again at the next start when it did not end. */
  verify?(session: TaskSession<Extra>, record: StepRecord): Promise<void>;
}

/** What the runner knows of the run while a task runs, by session: `runSteps` tells it the step that it is at. */
const PROGRESS = new WeakMap<object, { step: string | null }>();

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The record of a confirmed step, or undefined. A step that the state file holds has its own record. A name with a colon (`reorder-agent:open`) is a part of a step for the state file: the landing
 * keeps the part as the note `part.<name>`, and that note is the record of a step of the task whose name has a colon.
 */
function recordOf(state: StateFile, name: string): StepRecord | undefined {
  const step = state.step(name);
  if (step !== undefined || !name.includes(':')) return step;
  const note = state.note<unknown>(`part.${name}`);
  if (!isObject(note)) return undefined;
  const { confirmed_at: confirmedAt, tx_hash: txHash, refs, facts, verified_at: verifiedAt } = note;
  return {
    confirmed_at: typeof confirmedAt === 'string' ? confirmedAt : '',
    tx_hash: typeof txHash === 'string' ? txHash : null,
    refs: isObject(refs) ? Object.fromEntries(Object.entries(refs).filter((pair): pair is [string, string] => typeof pair[1] === 'string')) : {},
    facts: isObject(facts) ? facts : {},
    verified_at: typeof verifiedAt === 'string' ? verifiedAt : null,
  };
}

/** Marks a confirmed step as verified: in the state file, or, for the part that is the record of a step with a colon in its name, in its note. */
function markVerifiedStep(state: StateFile, name: string, at: string): void {
  if (state.step(name) !== undefined || !name.includes(':')) {
    state.markVerified(name, at);
    return;
  }
  const note = state.note<unknown>(`part.${name}`);
  if (!isObject(note)) throw new StateError('unknown_step', `the step ${name} is not recorded`);
  state.setNote(`part.${name}`, { ...note, verified_at: at });
}

/** The names that a state holds: each confirmed step, and each part, which is the record of a step with a colon in its name. */
function namesOf(snapshot: CheckState): string[] {
  return [...Object.keys(snapshot.steps), ...Object.keys(snapshot.notes).filter((key) => key.startsWith('part.')).map((key) => key.slice(5))];
}

/**
 * Does the next step: the first step that is not confirmed. A step that is confirmed is never run again, and a confirmed step that is not verified is verified first. A step that lands is verified
 * at once. Without `--all` the run ends after one step. With `--all` it goes on after each step that is done and recorded, and ends at the first step that is only shown, that must wait, or that
 * fails (an error). The outcome `finished` says that every step is confirmed.
 */
export async function runSteps<Extra>(session: TaskSession<Extra>, handlers: readonly StepHandler<Extra>[]): Promise<StepOutcome> {
  const progress = PROGRESS.get(session);
  for (const handler of handlers) {
    const record = recordOf(session.state, handler.name);
    if (record !== undefined) {
      if (record.verified_at === null) await verifyStep(session, handler, record);
      continue;
    }
    if (progress !== undefined) progress.step = handler.name;
    let outcome = await handler.run(session);
    const landed = recordOf(session.state, handler.name);
    if (outcome.kind === 'done' && landed !== undefined && landed.verified_at === null && handler.verify !== undefined) {
      session.out.out(outcome.message);
      await verifyStep(session, handler, landed);
      outcome = { kind: 'done', message: `step ${handler.name} is confirmed and verified` };
    }
    if (outcome.kind !== 'done' || !session.all || landed === undefined) return outcome;
  }
  return { kind: 'finished', message: `every step of the task ${session.task} is confirmed` };
}

/** Verifies a confirmed step with the hosted tools, and marks it verified. A step with no `verify` has nothing to verify. */
export async function verifyStep<Extra>(session: TaskSession<Extra>, handler: StepHandler<Extra>, record: StepRecord): Promise<void> {
  if (handler.verify === undefined) return;
  session.out.out(`verifying the step ${handler.name} with the hosted tools`);
  await handler.verify(session, record);
  markVerifiedStep(session.state, handler.name, iso(session.clock.now()));
  session.out.out(`the step ${handler.name} is verified`);
}

// ---- the exit code of an error ----

/** A transaction that this run signed: the step and the hash. `unconfirmed` is true for a transaction that is still in flight, and it is not there for one that landed. */
export interface Landing { readonly step: string; readonly txHash: string; readonly unconfirmed?: true }

interface Classified {
  readonly exit: number;
  readonly outcome: 'dry' | 'failed' | 'stopped';
  readonly lines: readonly string[];
  /** The stream of the lines: a refusal goes to `err`, and the dry message of a task that stopped at its first transaction goes to `out`. */
  readonly stream: 'out' | 'err';
  /** True when the run had signed a transaction before the error came, and that is why the error is a failure: the evidence file names the transaction. */
  readonly afterSigning?: true;
}

const DRY_MESSAGE = 'dry run: nothing was signed or submitted. Run again with --submit to sign, submit and wait for the confirmation.';
const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const stopped = (...lines: string[]): Classified => ({ exit: 2, outcome: 'stopped', lines, stream: 'err' });
const failedWith = (...lines: string[]): Classified => ({ exit: 1, outcome: 'failed', lines, stream: 'err' });

/** The exit code and the lines of an error for a run that signed nothing. Exit 2 says that nothing was signed. */
function classifyAlone(err: unknown, usage: readonly string[]): Classified {
  if (err instanceof FlagError) return stopped(err.message, ...usage);
  if (err instanceof SettingsError) return stopped(...err.problems);
  if (err instanceof KeyStoreError || err instanceof KeyFileError || err instanceof StateError || err instanceof EvidenceError || err instanceof GuardRefusal || err instanceof PreconditionError
    || err instanceof ApprovalError || err instanceof LoadError || err instanceof RunLockError || err instanceof ToolRefused || err instanceof FactsError) return stopped(err.message);
  if (err instanceof HostedError) return { exit: err.kind === 'bad_arguments' ? 2 : 3, outcome: 'stopped', lines: [err.message], stream: 'err' };
  if (err instanceof LandRefused) return failedWith(err.message, 'The evidence file holds the evaluation error and the body of the transaction. The state is unchanged.');
  if (err instanceof TxNotConfirmedError) return failedWith(err.message, 'The signed transaction is kept in the state file: the next run settles it before it builds anything.');
  if (err instanceof DryStop) return { exit: 0, outcome: 'dry', lines: [DRY_MESSAGE], stream: 'out' };
  return failedWith(errorText(err));
}

/** The line that tells of a transaction that the run signed. For a facts error it says that the facts file may lack the facts of the transaction. */
function signedLine(one: Landing, facts: boolean): string {
  const because = facts ? ', and the facts file may lack its facts' : '';
  return one.unconfirmed === true
    ? `the transaction ${one.txHash} of the step ${one.step} was signed in this run and is not confirmed${because}. The next run settles it before it builds anything.`
    : `the transaction ${one.txHash} of the step ${one.step} landed in this run${because}. The evidence file names the transaction.`;
}

/**
 * The exit code and the lines of an error. `signed` holds the transactions that the run signed before the error came. Exit 2 says that nothing was signed, so an error of that kind that comes after a
 * signature is a failure (exit 1): the transaction is on the chain or may land, and the run must not look like a run that changed nothing. Exit 3 (the hosted tools cannot be used) makes no such claim,
 * so it stays 3, but its lines name the transactions too, and the evidence file gets an entry for each.
 */
function classify(err: unknown, signed: readonly Landing[], usage: readonly string[]): Classified {
  const alone = classifyAlone(err, usage);
  if (signed.length === 0 || (alone.exit !== 2 && alone.exit !== 3)) return alone;
  const facts = err instanceof FactsError;
  const lines = [...alone.lines, ...signed.map((one) => signedLine(one, facts))];
  if (alone.exit === 3) return { ...alone, lines, afterSigning: true };
  return {
    exit: 1, outcome: 'failed', stream: 'err', afterSigning: true,
    lines: [...lines, facts ? 'Repair the facts file before another task reads it.' : 'A transaction was signed in this run, so this is a failure and not a stop before a signature.'],
  };
}

/** Prints the lines of a classified error. */
function print(classified: Classified, out: Output): void {
  for (const line of classified.lines) (classified.stream === 'out' ? out.out(line) : out.err(line));
}

/**
 * Prints an error and gives its exit code: 2 for a flag, a setting, a key, a file, an approval, a guard, a precondition or a hosted tool that refused a call (nothing was signed), 3 for hosted tools
 * that cannot be used, 1 for a transaction that was refused or not confirmed and for any other error. A `DryStop` is a dry result and gives 0. An error that gives 2 gives 1 instead when
 * `context.landed` holds a transaction that the run signed (landed, or in flight with `unconfirmed`): a run that signed is not a stop before a signature.
 */
export function reportError(err: unknown, out: Output, context: { landed?: readonly Landing[]; usage?: readonly string[] } = {}): number {
  const classified = classify(err, context.landed ?? [], context.usage ?? usageLines());
  print(classified, out);
  return classified.exit;
}

// ---- status ----

/**
 * The lines of `status`: the task and the use case, the state file, each step with its state, the transaction in flight, the next step, the network guard, and for each key of the registry that
 * the task loaded: the wallet with its outputs and the advice for a wallet that needs a collateral output and has none. Then the lines of the task.
 */
export async function statusLines<Extra>(def: TaskDefinition<Extra>, session: TaskSession<Extra>): Promise<string[]> {
  const snapshot = session.state.snapshot();
  const steps = def.steps(session.use, session.flags);
  const lines = [`task ${def.name}: ${def.title}`, `use case ${session.use.name}, network ${session.settings.network.name}`, `state file ${session.state.path}`, 'steps:'];
  for (const step of steps) {
    const record = recordOf(session.state, step);
    lines.push(`  ${step.padEnd(16)} ${record === undefined ? 'not run' : `confirmed ${record.confirmed_at}${record.tx_hash === null ? '' : `, transaction ${record.tx_hash}`}, ${record.verified_at === null ? 'not verified' : 'verified'}`}`);
  }
  for (const key of Object.keys(snapshot.notes).filter((note) => note.startsWith('part.') && !steps.includes(note.slice(5)))) {
    const part = snapshot.notes[key];
    const hash = part !== null && typeof part === 'object' && 'tx_hash' in part && typeof part.tx_hash === 'string' ? part.tx_hash : '?';
    lines.push(`  ${key.slice(5).padEnd(16)} confirmed (a part of a step), transaction ${hash}`);
  }
  const flight = snapshot.in_flight;
  lines.push(flight === null ? 'in flight: nothing' : `in flight: the step ${flight.step}, transaction ${flight.tx_hash}, signed at ${iso(flight.signed_at)}, may land until ${iso(flight.valid_to)}`);
  const next = steps.find((step) => recordOf(session.state, step) === undefined);
  lines.push(`next: ${next === undefined ? 'every step is confirmed; run cleanup to take back what can come back' : next}`);
  if (def.needs.chain) {
    const gate = session.networkResult();
    lines.push(gate === null ? 'network guard: not run' : `network guard: ${gate.ok ? 'ok' : 'FAIL'}, ${gate.message}`);
    for (const name of session.registry.names()) {
      const address = session.registry.addressOf(name);
      const utxos = await session.chain.provider.getUtxos(address);
      const total = utxos.reduce((sum, utxo) => sum + (utxo.assets.lovelace ?? 0n), 0n);
      const pure = utxos.filter((utxo) => Object.keys(utxo.assets).every((unit) => unit === 'lovelace')).length;
      const collateral = utxos.filter(isCollateralOutput).length;
      const needs = session.use.funding.some((line) => line.wallet === name && line.collateralLovelace > 0n);
      lines.push(`wallet of the key ${name} ${session.registry.hashOf(name)}: ${units(total)} in ${utxos.length} output(s), ${pure} pure output(s), ${collateral} pure output(s) of 5 units or more for collateral`
        + (needs && collateral === 0 ? `. NONE: a script step of this wallet needs one, and a script step can spend it. ${collateralAdvice(address)}. Run status again before each script step` : ''));
    }
  }
  lines.push(...(await def.status?.(session) ?? []));
  return lines;
}

// ---- the run ----

/** What `runTask` needs from its caller. A part that a test gives is used as it is, and a part that is missing is the real one. */
export interface RunDeps {
  /** The environment: the process environment of the real command line, or the values of a test. */
  readonly env: Env;
  readonly out: Output;
  readonly clock: Clock;
  readonly fetchImpl?: typeof fetch;
  readonly node?: NodeAccess;
  readonly chain?: ChainAccess;
  readonly hosted?: HostedTools;
  /** Loads the keys that `need` names. The default reads the key files of the settings. */
  readonly readRegistry?: (options: { dir: string; useCase: string; specs: readonly KeySpec[]; need: readonly string[] }) => Registry;
  /** Loads the data of a use case by its name. The default is the loader of the pack. */
  readonly loadUseCase?: (name: string) => Promise<UseCase>;
  readonly awaitMs?: number;
  readonly pollMs?: number;
}

/** What a run ended with, before the machine line is made. */
interface Ended { readonly exit: number; readonly outcome: ResultOutcome; readonly result?: Readonly<Record<string, unknown>> }

interface RunLock { readonly path: string; release(): void }

/** What `runTask` keeps while it runs, so that the end of the run can say what happened. */
interface Context<Extra> {
  command: Command | null;
  mode: Mode | null;
  usage: readonly string[];
  lock: RunLock | null;
  connections: Connections | null;
  state: StateFile | null;
  evidence: EvidenceFile | null;
  session: TaskSession<Extra> | null;
  /** The step that `runSteps` was at last. */
  progress: { step: string | null };
  /** The transactions that the state file held when the task started, by name of a step or of a part, and the steps that it held. Null until the task starts. */
  before: ReadonlyMap<string, string> | null;
  stepsBefore: ReadonlySet<string>;
  /** The hash of the transaction in flight when the run started, or null. A flight with this hash is no transaction that this run signed. */
  flightAtStart: string | null;
}

const RUN_LOCK = 'run.lock';

/** Takes the run lock: a file made with the flag `wx`, so that a lock that exists is refused and never replaced. The file holds one line that says who took it. */
function takeRunLock(path: string, note: string): RunLock {
  let fd: number;
  try { fd = openSync(path, 'wx', 0o600); } catch (err) {
    throw new RunLockError(codeOf(err) === 'EEXIST'
      ? `the run lock file ${path} exists: another run holds it, or a run stopped and left it. Wait for the run, or remove the file when no run is active`
      : `the run lock file ${path} could not be made (${codeOf(err)})`);
  }
  try { writeSync(fd, `${note}\n`); } catch { /* the lock holds no note, and it still locks */ } finally { closeSync(fd); }
  return { path, release: () => { unlinkSync(path); } };
}

/** The transactions that the state file holds: each confirmed step and each part of a step, by name, with its hash. */
function transactionsOf(state: StateFile): Map<string, string> {
  const snapshot = state.snapshot();
  const found = new Map<string, string>();
  for (const [name, record] of Object.entries(snapshot.steps)) if (record.tx_hash !== null) found.set(name, record.tx_hash);
  for (const [key, note] of Object.entries(snapshot.notes)) {
    if (key.startsWith('part.') && note !== null && typeof note === 'object' && 'tx_hash' in note && typeof note.tx_hash === 'string') found.set(key.slice(5), note.tx_hash);
  }
  return found;
}

/** The transactions that the state file holds now and did not hold in `before`: what the task landed. */
function landingsSince(state: StateFile, before: ReadonlyMap<string, string>): Landing[] {
  return [...transactionsOf(state)].filter(([name]) => !before.has(name)).map(([step, txHash]) => ({ step, txHash }));
}

/** The transactions that this run signed: those that landed since the task started, and the transaction in flight now when it is not the one that was in flight when the run started. */
function signedBy<Extra>(ctx: Context<Extra>): Landing[] {
  if (ctx.state === null || ctx.before === null) return [];
  const flight = ctx.state.snapshot().in_flight;
  const unconfirmed: Landing[] = flight === null || flight.tx_hash === ctx.flightAtStart ? [] : [{ step: flight.step, txHash: flight.tx_hash, unconfirmed: true }];
  return [...landingsSince(ctx.state, ctx.before), ...unconfirmed];
}

/** The first step of the task that the state file does not hold, or null. A task that fails to list its steps gives null. */
function firstOpenStep<Extra>(def: TaskDefinition<Extra>, session: TaskSession<Extra>): string | null {
  try { return def.steps(session.use, session.flags).find((step) => recordOf(session.state, step) === undefined) ?? null; } catch { return null; }
}

/** The references of the inputs that a transaction needs on the chain: its inputs, and its collateral inputs. A transaction that landed has spent the first. A script that failed spends the second. Each is named once. */
export function inputsToCheck(facts: { readonly inputs: readonly string[]; readonly collateralInputs: readonly string[] }): string[] {
  return [...new Set([...facts.inputs, ...facts.collateralInputs])];
}

/** The slots by which the tip of the node must be past the end of the validity of a transaction before the answer of the node about its inputs counts: a small rollback must not undo that answer. */
export const TIP_MARGIN_SLOTS = 20;

/** The slot past which the tip of a node counts, for a transaction whose validity ends at slot `end`: the end and the margin. */
const countsFrom = (end: bigint): bigint => end + BigInt(TIP_MARGIN_SLOTS);

/** Whether the tip of a node is past that slot: the node has then seen every block in which the transaction could have landed. A tip that is not a whole number is not past. */
const tipIsPast = (tip: number, end: bigint): boolean => Number.isSafeInteger(tip) && BigInt(tip) > countsFrom(end);

/** What the unspent inputs say about a transaction that the indexer does not know: it did not land (`unspent`), or it may have landed (`spent`, with the reason). */
export type InputsVerdict = { readonly kind: 'unspent' } | { readonly kind: 'spent'; readonly why: string };

/** What the node says of the inputs of a signed transaction: a verdict, or nothing that can be trusted (`unreadable`, with the reason). */
type InputsCheck = InputsVerdict | { readonly kind: 'unreadable'; readonly why: string };

const unreadable = (why: string): InputsCheck => ({ kind: 'unreadable', why });

/**
 * Judges the inputs of a transaction that the indexer does not know, from the set of references that the node still holds unspent. A transaction that landed with its scripts passed (or with no script)
 * spends ALL of its inputs. A transaction that landed with a script that failed spends ALL of its collateral inputs and none of its inputs. Another transaction can spend some of the inputs of a lost
 * transaction, so one unspent input is enough to show that the first form did not happen. The transaction did not land when at least one input is unspent AND (it has no collateral input OR at least
 * one collateral input is unspent). When every input is spent, or every collateral input is spent, it may have landed.
 */
export function judgeInputs(inputs: readonly string[], collateral: readonly string[], unspent: ReadonlySet<string>): InputsVerdict {
  const free = (refs: readonly string[]): number => refs.filter((ref) => unspent.has(ref)).length;
  if (inputs.length === 0) return { kind: 'spent', why: 'it has no input that could show that it did not land' };
  if (free(inputs) === 0) return { kind: 'spent', why: `all ${inputs.length} of its inputs are spent, and a transaction that landed spends all of them` };
  if (collateral.length > 0 && free(collateral) === 0) return { kind: 'spent', why: `all ${collateral.length} of its collateral inputs are spent, and a script that failed spends all of them` };
  return { kind: 'unspent' };
}

/** What a signed transaction shows on the chain: its inputs, its collateral inputs, and the slot at which its validity ends. The facts of its bytes (`TxFacts`) have these. */
export interface InputFacts { readonly inputs: readonly string[]; readonly collateralInputs: readonly string[]; readonly validityEndSlot: bigint | null }

/**
 * Asks the node, and not the indexer, which inputs of a signed transaction are still unspent, and judges them (`judgeInputs`). A transaction that landed has spent its inputs, so when they are unspent it
 * did not land, but only when the node has seen every block in which it could have landed. A node that is behind answers from a ledger before the landing, and says that every input is unspent. So the
 * node gives its tip first, and the slot of the tip must be past the end of the validity of the transaction by `TIP_MARGIN_SLOTS`: a node whose newest block is past that slot has all the blocks before
 * it. The tip is read before the inputs, so that the view of the inputs is at least as new as the tip. This holds only when the tip and the inputs come from ONE node: the Ogmios URL of the settings
 * must name one node and never a load balancer, because two reads can go to two nodes, and the node that is behind can answer the second read. A node that does not answer, a tip that is not past the
 * end, a transaction with no input and a transaction with no end of validity tell nothing: they are `unreadable`, never `unspent`.
 */
export async function checkInputs(node: NodeAccess, facts: InputFacts): Promise<InputsCheck> {
  if (facts.inputs.length === 0) return unreadable('the transaction has no input');
  const end = facts.validityEndSlot;
  if (end === null) return unreadable('the transaction has no end of validity, so no tip of the node shows that it cannot land');
  let tip: number;
  try { tip = (await node.networkTip()).slot; } catch (err) { return unreadable(`the node did not give its tip: ${errorText(err)}`); }
  if (!tipIsPast(tip, end)) {
    return unreadable(`the tip of the node is at slot ${String(tip)}, and its answer about the inputs counts only past slot ${countsFrom(end)} (the validity of the transaction ended at slot ${end}): the node may not have seen the block of the transaction yet`);
  }
  let held: Utxo[];
  try { held = await node.resolveInputs(inputsToCheck(facts)); } catch (err) { return unreadable(`the node did not answer: ${errorText(err)}`); }
  return judgeInputs(facts.inputs, facts.collateralInputs, new Set(held.map((utxo) => `${utxo.txHash}#${utxo.outputIndex}`)));
}

/** Reads the bytes of a signed transaction, and checks its inputs. Bytes that cannot be read tell nothing. */
async function checkSigned(node: NodeAccess, signedCbor: string): Promise<InputsCheck> {
  let facts: TxFacts;
  try { facts = factsOf(signedCbor); } catch (err) { return unreadable(`the bytes of the transaction cannot be read: ${errorText(err)}`); }
  return checkInputs(node, facts);
}

/** What the clock and the node say about the end of the validity of a transaction in flight: it is over (`over`, with the words that show it), or the transaction may still land (`may`, with the reason). */
export type EndOfValidity = { readonly kind: 'over'; readonly shown: string } | { readonly kind: 'may'; readonly why: string };

/**
 * Says whether a transaction in flight cannot land any more, for `cleanup --release`. A release while the transaction can still land pays twice: the step is built again, and both transactions pay.
 * Two reads must show that its validity is over. The clock must be past the end of the validity by `GRACE_MS`, the rule of `settleInFlight`. And when the node answers and passes the network guard, its tip
 * must be past the end of the validity (`end`, the slot of the signed bytes) by `TIP_MARGIN_SLOTS`, as `checkInputs` asks: a clock that is wrong, or a node that is behind, shows an end that has not come.
 * A node that does not answer, or that is not on the network of the run, adds no check: the operator checked the chain, and the clock still holds. A transaction with no end of validity can land at
 * any time, so it is never over. The guard and the node are not asked while the clock says that the transaction may still land.
 */
export async function checkEndOfValidity(flight: Pick<InFlight, 'valid_to'>, end: bigint | null, parts: { node: NodeAccess; network: { guard(): Promise<GuardResult> }; clock: Clock }): Promise<EndOfValidity> {
  const { node, network, clock } = parts;
  const releaseAt = flight.valid_to + GRACE_MS;
  if (clock.now() <= releaseAt) {
    return { kind: 'may', why: `its validity ends at ${iso(flight.valid_to)}, and a transaction is let go only after ${iso(releaseAt)}, ${duration(GRACE_MS)} later, because a node that is behind can still hold it` };
  }
  if (end === null) return { kind: 'may', why: 'its bytes have no end of validity, so it can land at any time' };
  const clockSays = `the clock is past the end of the validity by more than ${duration(GRACE_MS)}`;
  const gate = await network.guard();
  if (!gate.ok) return { kind: 'over', shown: `${clockSays}, and the node was not used (the network guard failed: ${gate.message})` };
  let tip: number;
  try { tip = (await node.networkTip()).slot; } catch (err) { return { kind: 'over', shown: `${clockSays}, and the node was not used (it did not give its tip: ${errorText(err)})` }; }
  if (!tipIsPast(tip, end)) {
    return { kind: 'may', why: `the clock says that the validity is over, but the tip of the node is at slot ${String(tip)}, and it must be past slot ${countsFrom(end)} (the end of the validity at slot ${end}, and ${TIP_MARGIN_SLOTS} slots more). The node may be behind, or the clock may be wrong` };
  }
  return { kind: 'over', shown: `${clockSays}, and the tip of the node (slot ${tip}) is past the end of the validity (slot ${end}) by more than ${TIP_MARGIN_SLOTS} slots` };
}

/**
 * Rechecks an expired transaction without removing its record. The record stays on disk until the status or the original inputs show the result:
 *   - a number of confirmations, 0 included (the indexer counts the blocks on top of the block of the transaction, so 0 is the newest block): the transaction is on the chain. The step is recorded
 *     and its reserve of the cap stays.
 *   - a read that fails: nobody knows. The transaction stays in flight and the run stops, so that no step is built that may have landed.
 *   - a read that works and does not know the transaction: the indexer can be behind the node, so the transaction may have landed after its validity ended. The runner asks the node for the inputs of the
 *     signed bytes (`checkInputs`), but only when the tip of the node is past the end of the validity: a node that is behind answers from a ledger before the landing. `judgeInputs` says that the transaction
 *     did not land when one input is unspent and, if it has collateral inputs, one of them is unspent too. When the node cannot tell, or the inputs say that it may have landed, the transaction stays in
 *     flight with its reserve and the run stops: the operator checks the chain, and lets it go with `cleanup --release=<hash>` when it is not there. When it did not land, it cannot land any more because its
 *     validity ended. A dry run then leaves it in flight and goes on, so that the summary shows the step as it would be built again. A run with --submit gives its reserve back (when the approval is loaded)
 *     and lets it go, and the run goes on.
 * It gives the reason to stop, or null when the run goes on.
 */
async function reconcile(flight: InFlight, parts: { node: NodeAccess; state: StateFile; clock: Clock; exposure: Exposure; go: GoFile | null; mode: Mode; out: Output }): Promise<string | null> {
  const { node, state, clock, exposure, go, mode, out } = parts;
  const where = `the transaction ${flight.tx_hash} of the step ${flight.step}`;
  let confirmations: number | null;
  try { confirmations = (await node.txStatus(flight.tx_hash)).confirmations; } catch (err) {
    return `the status of ${where} could not be read (${errorText(err)}). The transaction stays in flight, and nothing is built. Run again when the indexer answers.`;
  }
  if (confirmations !== null) {
    recordLanded(state, { step: flight.step, tx_hash: flight.tx_hash, refs: flight.refs, facts: flight.facts }, clock.now());
    out.out(`${where} ${confirmations >= 1 ? 'is confirmed' : 'is in the newest block'}: the step is recorded, and its reserve of the cap stays`);
    return null;
  }
  const unknown = `${where} is not known to the indexer, and its validity ended at ${iso(flight.valid_to)}`;
  const inputs = await checkSigned(node, flight.signed_cbor);
  if (inputs.kind === 'spent') {
    return `${unknown}, but ${inputs.why}. It may have landed. It stays in flight, its reserve stays, and nothing is built. The operator must check the chain for the transaction and for its inputs. `
      + `When the chain shows that the transaction is not there, the operator lets it go with the command cleanup and the flags --release=${flight.tx_hash} and --submit.`;
  }
  if (inputs.kind === 'unreadable') {
    return `${unknown}, but its inputs cannot be checked (${inputs.why}). It stays in flight, its reserve stays, and nothing is built. Run again when the inputs can be checked.`;
  }
  const lost = `${where} is not on the chain, and its validity ended at ${iso(flight.valid_to)}: it cannot land any more`;
  if (mode === 'dry') {
    out.out(`${lost}. A dry run does not let it go: the record and the reserve stay. A run with --submit lets it go and builds the step again, as the summary below shows.`);
    return null;
  }
  if (go === null) {
    state.clearInFlight();
    out.out(`${lost}. No approval file is loaded, so its reserve stays in the cap file of its session.`);
    return null;
  }
  // The reserve goes first and the record second: a stop between them leaves the record, and the next run lets it go again.
  const released = exposure.release(flight.tx_hash);
  state.clearInFlight();
  out.out(released ? `${lost}. Its reserve of the cap is released.` : `${lost}. The cap file of the session ${go.session} holds no reserve for it.`);
  return null;
}

/** The end of a step: the exit code and the line that tells it. */
function endOf(outcome: StepOutcome, mode: Mode, out: Output): Ended {
  switch (outcome.kind) {
    case 'dry':
      out.out(mode === 'dry' ? DRY_MESSAGE : 'the task made no transaction: it ended with a dry result in submit mode');
      return { exit: 0, outcome: 'dry' };
    case 'wait':
      out.out(`WAIT: ${outcome.message}${outcome.untilMs === null ? '' : ` (until ${iso(outcome.untilMs)})`}`);
      return { exit: 4, outcome: 'wait' };
    case 'finished':
      out.out(outcome.message);
      return { exit: 0, outcome: 'finished' };
    default:
      out.out(outcome.message);
      return { exit: 0, outcome: 'done' };
  }
}

/**
 * Loads the keys of a run: the keys that the task names, and the key `run` too in a submit run that needs the approval, because the approval names the wallet of that key and `requireGo` compares the
 * two. This holds for a task that names no key as well: a task that signs nothing still runs under an approval. The key `run` may be missing for one task only, the task that makes the keys, on its
 * first run. So when the task names no key and the file of `run` does not exist, the registry is empty, `requireGo` gets no wallet, and it lets only the task `keys` pass, with an approval that says
 * `unset`. Once the key exists, that approval is refused. Any other fault of a key file, a bad mode or a bad text, stops the run, and so does a missing key that a task names.
 */
function loadKeys(read: NonNullable<RunDeps['readRegistry']>, where: { dir: string; useCase: string; specs: readonly KeySpec[] }, named: readonly string[], approvalNeeded: boolean): Registry {
  const need = [...new Set([...named, ...(approvalNeeded ? ['run'] : [])])];
  try { return read({ ...where, need }); } catch (err) {
    if (named.length === 0 && need.length > 0 && err instanceof KeyStoreError && err.reason === 'missing') return read({ ...where, need: [] });
    throw err;
  }
}

/**
 * Lets the transaction in flight go at the word of the operator: `cleanup --release=<hash>`. It is the way out for a transaction that a run keeps because its inputs are spent, when the operator has
 * checked the chain and the transaction is not there. It lets go the transaction that is in flight and no other: the hash must be its hash. It reads the status of that transaction once, and it refuses
 * when the indexer knows it: that transaction landed, and a check of the operator that missed it must not let the step be built again. A read that fails adds no check, and the output says so. It refuses
 * while the transaction may still land, in a dry run too (`checkEndOfValidity`): a release before the end of its validity lets the step be built again while the first transaction can still land, and
 * then both pay. A dry run that passes says what it would do and changes nothing. With --submit it writes an entry of the evidence first, so that an override of the check leaves its trace before it
 * changes anything, then gives the reserve back (when the approval is loaded), and lets the transaction go. The cleanup of the task does not run.
 */
async function letGo(hash: string, flight: InFlight | null, parts: { node: NodeAccess; network: { guard(): Promise<GuardResult> }; clock: Clock; state: StateFile; evidence: EvidenceFile; exposure: Exposure; go: GoFile | null; mode: Mode; out: Output; progress: { step: string | null } }): Promise<Ended> {
  const { node, network, clock, state, evidence, exposure, go, mode, out, progress } = parts;
  if (flight === null) throw new PreconditionError('no transaction is in flight, so --release has nothing to let go');
  if (flight.tx_hash !== hash) throw new PreconditionError(`the transaction in flight is ${flight.tx_hash} of the step ${flight.step}, and --release names another transaction: nothing is let go`);
  const where = `the transaction ${flight.tx_hash} of the step ${flight.step}`;
  progress.step = flight.step;
  let end: bigint | null;
  try { end = factsOf(flight.signed_cbor).validityEndSlot; } catch (err) {
    throw new PreconditionError(`the bytes of ${where} cannot be read (${errorText(err)}), so nothing shows when it cannot land any more: nothing is let go`);
  }
  // One read of the status, before the clock and the tip: a transaction that the indexer knows landed, and no time makes its release right. A read that fails adds no check.
  let seen: number | null = null;
  let unread: string | null = null;
  try { seen = (await node.txStatus(flight.tx_hash)).confirmations; } catch (err) { unread = errorText(err); }
  if (seen !== null) {
    throw new PreconditionError(`${where} ${seen >= 1 ? 'is confirmed' : 'is in the newest block'}, as the indexer says: it landed, so nothing is let go. Run the task again without --release, so that the run records the step.`);
  }
  const over = await checkEndOfValidity(flight, end, { node, network, clock });
  if (over.kind === 'may') throw new PreconditionError(`${where} may still land, so nothing is let go: ${over.why}. A release now can pay twice. Run again when its validity is over.`);
  out.out(`the validity of ${where} ended at ${iso(flight.valid_to)}: ${over.shown}.`);
  out.out(unread === null ? `the indexer does not know ${where}.` : `the status of ${where} could not be read (${unread}), so the indexer adds no check: the word of the operator and the end of the validity decide.`);
  if (mode === 'dry') {
    out.out(`${where} would be let go, and its reserve of the cap would be given back. A dry run lets nothing go. Check the chain for the transaction and for its inputs first, and run again with --submit.`);
    return { exit: 0, outcome: 'dry' };
  }
  out.out(`the operator says that the chain was checked and that ${where} is not there: it is let go.`);
  evidence.add({ step: flight.step, status: 'info', shows: { note: 'the operator lets the transaction go, and says that the chain was checked', transaction: flight.tx_hash, session: go === null ? null : go.session } });
  const released = go === null ? null : exposure.release(flight.tx_hash);
  state.clearInFlight();
  out.out(go === null ? 'No approval file is loaded, so its reserve stays in the cap file of its session.' : released ? 'Its reserve of the cap is released.' : `The cap file of the session ${go.session} holds no reserve for it.`);
  return { exit: 0, outcome: 'done' };
}

/** Opens the files and the connections of a run, settles a transaction in flight, checks the network and the approval, and runs the task. It fills `ctx` as it goes. */
async function execute<Extra>(def: TaskDefinition<Extra>, argv: readonly string[], deps: RunDeps, ctx: Context<Extra>): Promise<Ended> {
  const { out, clock } = deps;
  ctx.usage = usageLines(def);
  const args = parseArguments(def, argv);
  ctx.command = args.command;
  ctx.mode = args.mode;
  const settings: OperatorSettings = parseOperatorSettings(deps.env);
  ctx.lock = takeRunLock(join(settings.stateDir, RUN_LOCK), `${def.name} ${args.command} in ${args.mode} mode, started ${iso(clock.now())}`);
  const use = await (deps.loadUseCase ?? loadUseCase)(args.useCase ?? settings.useCase);
  const extra = def.parse(deps.env, settings, use, args.flags);
  const base = join(settings.stateDir, args.run === null ? def.name : `${def.name}.${args.run}`);
  const identity = { check: def.name, network: settings.network.name, record: args.run === null ? use.name : `${use.name}:${args.run}` };
  const factsPath = join(settings.stateDir, 'facts.json');
  const factsIdentity = { useCase: use.name, network: settings.network.name };
  if (def.offline?.matches(extra)) {
    if (args.command !== 'run' || args.mode !== 'dry') throw new FlagError('the local document writer takes only run without --submit');
    const flight = StateFile.peek(`${base}.state.json`, identity)?.in_flight;
    if (flight != null) throw new PreconditionError(`the step ${flight.step} has a transaction in flight; settle it with the normal command before writing documents`);
    const facts = FactsFile.open(factsPath, factsIdentity).read();
    const { message, result } = await def.offline.run({ extra, use, facts, stateDir: settings.stateDir, out });
    out.out(message);
    return { exit: 0, outcome: 'done', result };
  }
  const submit = args.mode === 'submit';
  const approvalNeeded = submit && def.needs.approval === 'submit';
  const named = def.needs.keys(use, args.flags);
  const registry = loadKeys(deps.readRegistry ?? ((options) => loadRegistry(options)), { dir: settings.keysDir, useCase: use.name, specs: use.keys }, named, approvalNeeded);
  const state = StateFile.open(`${base}.state.json`, identity);
  ctx.state = state;
  const evidence = EvidenceFile.open(`${base}.evidence.json`, identity);
  ctx.evidence = evidence;
  const facts = FactsFile.open(factsPath, factsIdentity);
  const awaitMs = deps.awaitMs ?? AWAIT_MS;
  const pollMs = deps.pollMs ?? POLL_MS;
  const connections = connect(def, settings, deps);
  ctx.connections = connections;
  let networkResult: GuardResult | null = null;
  const sessionWith = (go: GoFile | null, exposure: Exposure): TaskSession<Extra> => makeSession({
    task: def.name, mode: args.mode, all: args.all, settings, use, extra, flags: args.flags, registry, state, evidence, facts, go, exposure, out, clock, connections,
    networkResult: () => networkResult, awaitMs, pollMs,
  });

  if (args.command === 'status') {
    const session = sessionWith(null, new Exposure(join(settings.stateDir, 'exposure.none.json'), null));
    if (def.needs.chain) networkResult = Object.freeze({ ...(await session.network.guard()) });
    for (const line of await statusLines(def, session)) out.out(line);
    return { exit: 0, outcome: 'done' };
  }

  out.out(`task ${def.name}: ${def.title}`);
  out.out(`${args.command} in ${args.mode} mode${args.all ? ', all steps' : ''}, use case ${use.name}, network ${settings.network.name}${args.run === null ? '' : `, run ${args.run}`}`);
  // The network guard runs first, once. A transaction in flight is settled with what the node says, and a node of another network says wrong things: so a run that has a transaction in flight stops
  // when the guard failed, and the state stays as it is. A run with none goes on, and the landing refuses to sign on a failed guard.
  const flight = state.snapshot().in_flight;
  ctx.flightAtStart = flight === null ? null : flight.tx_hash;
  if (args.release === null && (def.needs.chain || flight !== null)) {
    const guard = await connections.network.guard();
    networkResult = Object.freeze({ ...guard });
    if (!guard.ok) out.err(`network guard: FAIL, ${guard.message}`);
    if (!guard.ok && flight !== null) {
      throw new PreconditionError(`the step ${flight.step} has a transaction in flight, and the network guard failed: the answers of the node cannot be trusted, so nothing is settled and nothing is built`);
    }
  }
  // The approval and the transaction in flight, before anything is built. A run that needs the approval loads it and checks it in full here, before the status of any transaction is read: a file that does
  // not load, or that no longer allows the task or the run wallet, stops the run with the state as it is, and the transaction in flight is not submitted again. A run with --submit of a task that needs no
  // approval loads the file only when a transaction is in flight and the file is there: the release of a reserve names the cap file of the session of the approval. A dry run lets no transaction go and
  // releases no reserve, so it reads no approval file.
  let go: GoFile | null = null;
  if (approvalNeeded) {
    go = requireGo(loadGo(settings.goFile, clock.now()), { task: def.name, runWallet: registry.has('run') ? registry.addressOf('run') : null, nowMs: clock.now(), irreversible: [] });
  } else if (submit && flight !== null && existsSync(settings.goFile)) {
    try { go = loadGo(settings.goFile, clock.now()); } catch (err) {
      if (!(err instanceof ApprovalError)) throw err;
      out.out(`the approval file could not be used (${err.message}): the reserve of a transaction that cannot land stays in its cap file`);
    }
  }
  const exposure = new Exposure(join(settings.stateDir, `exposure.${go === null ? 'none' : go.session}.json`), go);
  // `cleanup --release=<hash>`: the operator lets the transaction in flight go. The network guard above and the settle below are skipped: the release asks the guard and the tip of the node itself, and only
  // after the clock says that the validity is over.
  if (args.release !== null) return letGo(args.release, flight, { node: connections.node, network: connections.network, clock, state, evidence, exposure, go, mode: args.mode, out, progress: ctx.progress });
  const settled = await settleInFlight({ state, node: connections.node, clock, out: (line) => out.out(line), mode: args.mode, awaitMs, pollMs, onExpired: 'reconcile' });
  if (settled.kind === 'wait') {
    ctx.progress.step = settled.step;
    return endOf({ kind: 'wait', message: settled.message, untilMs: settled.untilMs }, args.mode, out);
  }
  if (settled.kind === 'reconcile') {
    const { flight: pending } = settled;
    const stop = await reconcile(pending, { node: connections.node, state, clock, exposure, go, mode: args.mode, out });
    if (stop !== null) {
      ctx.progress.step = pending.step;
      throw new PreconditionError(stop);
    }
  }

  const session = sessionWith(go, exposure);
  PROGRESS.set(session, ctx.progress);
  if (approvalNeeded && go !== null) out.out(`approval: session ${go.session}, cap ${units(exposure.cap() ?? 0n)}, ${units(exposure.total())} reserved`);

  ctx.session = session;
  ctx.before = transactionsOf(state);
  ctx.stepsBefore = new Set(namesOf(state.snapshot()));
  const outcome = args.command === 'cleanup' ? await def.cleanup(session) : await def.next(session);
  return endOf(outcome, args.mode, out);
}

/** The step that the machine line names: the step that `runSteps` was at, else the step that the state file shows the run did or stopped at. */
function stepOf<Extra>(def: TaskDefinition<Extra>, ctx: Context<Extra>, outcome: ResultOutcome): string | null {
  if (ctx.progress.step !== null) return ctx.progress.step;
  if (ctx.before === null || ctx.session === null || ctx.state === null || outcome === 'finished') return null;
  if (outcome === 'done') return namesOf(ctx.state.snapshot()).filter((name) => !ctx.stepsBefore.has(name)).at(-1) ?? null;
  return firstOpenStep(def, ctx.session);
}

/** The public result of the task, or an empty object when the task has none, did not start, or fails to make it. */
function resultOf<Extra>(def: TaskDefinition<Extra>, ctx: Context<Extra>, out: Output): Readonly<Record<string, unknown>> {
  if (ctx.session === null || ctx.before === null || def.result === undefined) return {};
  try { return def.result(ctx.session); } catch (err) {
    out.err(`the result of the task could not be made (${errorText(err)}): the machine line has no result`);
    return {};
  }
}

/** Prints the machine line. A result that cannot be written is left out, and the line is still printed. */
function emit(out: Output, fields: OperatorResultFields): void {
  try {
    out.out(operatorResult(fields));
    return;
  } catch (err) {
    out.err(`the result of the task is left out of the machine line (${errorText(err)})`);
  }
  out.out(operatorResult({ ...fields, result: {} }));
}

/** Closes what a run opened: the hosted tools and the run lock. A failure of either is a line, and the run keeps its exit code. */
async function release<Extra>(ctx: Context<Extra>, out: Output): Promise<void> {
  if (ctx.connections !== null) await ctx.connections.close().catch(() => undefined);
  if (ctx.lock !== null) {
    try { ctx.lock.release(); } catch (err) { out.err(`the run lock file ${ctx.lock.path} could not be removed (${codeOf(err)}): remove it before the next run`); }
  }
}

/** Writes an entry of the evidence for each transaction that the run signed, before an error that says "nothing was signed" and before a facts error, so that the evidence names it. */
function noteSigned<Extra>(ctx: Context<Extra>, signed: readonly Landing[], err: unknown, out: Output): void {
  for (const one of signed) {
    const what = one.unconfirmed === true ? 'the transaction is in flight' : 'the transaction landed';
    const shows = err instanceof FactsError
      ? { note: `${what}, and the facts file could not be written`, transaction: one.txHash, facts_error: err.reason }
      : { note: `${what}, and the run then stopped with an error`, transaction: one.txHash, error: err instanceof Error ? err.name : 'not an error' };
    try {
      ctx.evidence?.add({ step: one.step, status: 'info', shows });
    } catch (writeError) {
      out.err(`the evidence file could not be written (${errorText(writeError)})`);
    }
  }
}

/**
 * Runs a task: the arguments, the settings, the use case, the keys, the state, the evidence and the facts, the transaction in flight, the network guard, the approval, and then the next step or the
 * cleanup (or the status). It gives the exit code, and prints the machine line last.
 */
export async function runTask<Extra>(def: TaskDefinition<Extra>, argv: readonly string[], deps: RunDeps): Promise<number> {
  const ctx: Context<Extra> = {
    command: null, mode: null, usage: usageLines(def), lock: null, connections: null, state: null, evidence: null, session: null, progress: { step: null }, before: null, stepsBefore: new Set(), flightAtStart: null,
  };
  let ended: Ended;
  try {
    try {
      ended = await execute(def, argv, deps, ctx);
    } catch (err) {
      const signed = signedBy(ctx);
      const classified = classify(err, signed, ctx.usage);
      if (classified.afterSigning === true) noteSigned(ctx, signed, err, deps.out);
      print(classified, deps.out);
      ended = { exit: classified.exit, outcome: classified.outcome };
    }
  } finally {
    await release(ctx, deps.out);
  }
  emit(deps.out, { task: def.name, command: ctx.command, mode: ctx.mode, outcome: ended.outcome, exit: ended.exit, step: stepOf(def, ctx, ended.outcome), result: ended.result ?? resultOf(def, ctx, deps.out) });
  return ended.exit;
}

// ---- the command line of the pack ----

/** What `runCli` needs: what `runTask` needs, and the way to load a task by its name. */
export interface CliDeps extends RunDeps {
  readonly loadTask?: (name: string) => Promise<TaskDefinition>;
}

/** Runs the command line of the pack. The first word is the name of a task, and the rest is the command line of that task. With no word, or a name that is not a task, it prints the usage and exits 2. */
export async function runCli(argv: readonly string[], deps: CliDeps): Promise<number> {
  const [name, ...rest] = argv;
  if (name === undefined || !TASK_NAMES.some((known) => known === name)) {
    for (const line of usageLines()) deps.out.err(line);
    emit(deps.out, { task: null, command: null, mode: null, outcome: 'stopped', exit: 2, step: null, result: {} });
    return 2;
  }
  let def: TaskDefinition;
  try { def = await (deps.loadTask ?? ((task) => loadTask(task)))(name); } catch (err) {
    const classified = classify(err, [], usageLines());
    print(classified, deps.out);
    emit(deps.out, { task: name, command: null, mode: null, outcome: classified.outcome === 'dry' ? 'stopped' : classified.outcome, exit: classified.exit, step: null, result: {} });
    return classified.exit;
  }
  return runTask(def, rest, deps);
}
