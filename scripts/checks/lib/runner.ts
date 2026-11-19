// scripts/checks/lib/runner.ts - the command line of a check, the same for all six.
//
//   <script> [status | run | cleanup] [--submit] [the flags of the check]
//
//   run (the default)  Builds and checks the next step of the check. With no flag it signs nothing: it prints what it would sign. With --submit it signs, submits and waits for
//                      the confirmation, and then records the step in the state file and writes the evidence.
//   status             Shows the state file, the wallets and the network, with no build. It takes no flag.
//   cleanup            Takes back what can come back, from any state: it ends a delegation, closes a vault, reclaims an escrow, withdraws a deposit that is due. It has the same two modes.
//
// A run does one step. The operator runs a step with no flag, reads the output, and runs it again with --submit.
// Exit: 0 the step is shown or done, 1 a step failed (the state is unchanged, but for a transaction in flight), 2 a setting, a flag, a key file or the state is wrong or a guard
// refused before any signature, 3 the hosted tools cannot be used, 4 a wait is open: the output says how long is left.
import { join } from 'node:path';
import { EvidenceError, EvidenceFile } from './evidence.ts';
import { duration, iso, units } from './format.ts';
import { GuardRefusal, LandRefused, NetworkGate } from './land.ts';
import type { LandIo } from './land.ts';
import { HostedError, connectHosted } from './hosted.ts';
import type { HostedTools } from './hosted.ts';
import { settleInFlight } from './inflight.ts';
import { KeyFileError, KeyRing, readKeyFile } from './keys.ts';
import type { KeyRole, LoadedKey } from './keys.ts';
import { VectorNode } from './node.ts';
import { OgmiosProvider, TxNotConfirmedError, lucidForAddress } from './platform.ts';
import type { Clock, NodeAccess, Output } from './ports.ts';
import { PreconditionError, landFor } from './session.ts';
import type { ChainAccess, Mode, Session, StepOutcome } from './session.ts';
import { SettingsError, deploymentFor, parseCommonSettings } from './settings.ts';
import type { CommonSettings, Env } from './settings.ts';
import { StateError, StateFile } from './state.ts';
import type { StepRecord } from './state.ts';

export type Command = 'status' | 'run' | 'cleanup';

export interface CheckDefinition<Extra = unknown> {
  /** The name of the check: the base of its file names. */
  name: string;
  title: string;
  needs: {
    keys: readonly KeyRole[];
    /** The check reads the ledger and builds transactions. */
    chain: boolean;
    /** The hosted tools that it calls: the server must list each. */
    hosted: readonly string[];
  };
  /** The flags besides --submit. */
  flags?: readonly string[];
  /** The steps, in order. */
  steps: readonly string[];
  parse(env: Env, common: CommonSettings): Extra;
  next(session: Session<Extra>, flags: ReadonlySet<string>): Promise<StepOutcome>;
  cleanup(session: Session<Extra>, flags: ReadonlySet<string>): Promise<StepOutcome>;
  /** Lines of the status besides the generic ones. */
  status?(session: Session<Extra>): Promise<string[]>;
}

export interface RunDeps {
  env: Env;
  out: Output;
  clock: Clock;
  fetchImpl?: typeof fetch;
  node?: NodeAccess;
  chain?: ChainAccess;
  hosted?: HostedTools;
  readKey?: (path: string, role: KeyRole) => LoadedKey;
  awaitMs?: number;
  pollMs?: number;
}

export const realClock: Clock = { now: () => Date.now(), sleep: (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }) };
export const consoleOutput: Output = { out: (line) => { process.stdout.write(`${line}\n`); }, err: (line) => { process.stderr.write(`${line}\n`); } };

export class FlagError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FlagError';
  }
}

export interface Arguments { command: Command; mode: Mode; flags: ReadonlySet<string> }

/** Reads the command line. A word that is not known is refused: nothing is guessed. */
export function parseArguments(def: Pick<CheckDefinition, 'flags'>, argv: readonly string[]): Arguments {
  let command: Command | null = null;
  let submit = false;
  const flags = new Set<string>();
  for (const word of argv) {
    if (word === '--submit') submit = true;
    else if (word === 'status' || word === 'run' || word === 'cleanup') {
      if (command !== null) throw new FlagError(`two commands: ${command} and ${word}`);
      command = word;
    } else if ((def.flags ?? []).includes(word)) flags.add(word);
    else throw new FlagError(`unknown argument ${word}`);
  }
  if (command === 'status' && (submit || flags.size > 0)) throw new FlagError('status shows the state and the wallets and takes no flag');
  return { command: command ?? 'run', mode: submit ? 'submit' : 'dry', flags };
}

const usage = (def: Pick<CheckDefinition, 'name' | 'flags'>): string =>
  `usage: <script of the check ${def.name}> [status | run | cleanup] [--submit]${(def.flags ?? []).map((flag) => ` [${flag}]`).join('')}\n`
  + 'With no --submit a script builds and checks its next step and signs nothing. See scripts/checks/README.md.';

// ─── The real world ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

function unusedChain(why: string): ChainAccess {
  const refuse = (): never => { throw new Error(`this check does not read the ledger (${why})`); };
  return { get provider(): never { return refuse(); }, get deployment(): never { return refuse(); }, koiosUrl: '', fetchImpl: fetch, context: () => Promise.reject(new Error(`this check builds no transaction (${why})`)) };
}

function realChain(settings: CommonSettings, env: Env, fetchImpl: typeof fetch, provider: OgmiosProvider): ChainAccess {
  const deployment = deploymentFor(settings.network, env);
  return { provider, deployment, koiosUrl: settings.urls.koios, fetchImpl, context: async (address) => ({ lucid: await lucidForAddress(provider, address), provider, deployment }) };
}

/** The hosted tools, connected when the first call is made: a dry run that calls none never needs the server. */
function lazyHosted(url: string, required: readonly string[]): { tools: HostedTools; close(): Promise<void> } {
  let connected: ReturnType<typeof connectHosted> | null = null;
  return {
    tools: { async call(name, args) { connected ??= connectHosted(url, { required }); return (await connected).call(name, args); } },
    close: async () => { if (connected !== null) await (await connected.catch(() => null))?.close(); },
  };
}

// ─── The steps ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface StepHandler<Extra = unknown> {
  name: string;
  run(session: Session<Extra>, flags: ReadonlySet<string>): Promise<StepOutcome>;
  /** Reads the hosted tools after the step, and throws when what they show is not what the step did. It runs again at the next start when it did not end. */
  verify?(session: Session<Extra>, record: StepRecord): Promise<void>;
}

/**
 * Does the next step: the first step that is not confirmed. A step that is confirmed and not verified is verified first. The step that runs is verified at once when it lands.
 * A step is never run again when it is confirmed, and no step runs before the steps in front of it are confirmed.
 */
export async function runSteps<Extra>(session: Session<Extra>, handlers: readonly StepHandler<Extra>[], flags: ReadonlySet<string> = new Set()): Promise<StepOutcome> {
  for (const handler of handlers) {
    const record = session.state.step(handler.name);
    if (record !== undefined) {
      if (record.verified_at === null && handler.verify !== undefined) await verifyStep(session, handler, record);
      continue;
    }
    const outcome = await handler.run(session, flags);
    const landed = session.state.step(handler.name);
    if (outcome.kind === 'done' && landed !== undefined && handler.verify !== undefined && landed.verified_at === null) {
      session.out.out(outcome.message);
      await verifyStep(session, handler, landed);
      return { kind: 'done', message: `step ${handler.name} is confirmed and verified` };
    }
    return outcome;
  }
  return { kind: 'finished', message: `every step of the check ${session.check} is confirmed` };
}

export async function verifyStep<Extra>(session: Session<Extra>, handler: StepHandler<Extra>, record: StepRecord): Promise<void> {
  session.out.out(`verifying the step ${handler.name} with the hosted tools`);
  await handler.verify!(session, record);
  session.state.markVerified(handler.name, iso(session.clock.now()));
  session.out.out(`the step ${handler.name} is verified`);
}

// ─── Status ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

async function statusLines<Extra>(def: CheckDefinition<Extra>, session: Session<Extra>): Promise<string[]> {
  const snapshot = session.state.snapshot();
  const lines = [`check ${def.name}: ${def.title}`, `network ${session.settings.network.name}, record ${session.settings.recordDid}`, `state file ${session.state.path}`, 'steps:'];
  for (const step of def.steps) {
    const record = snapshot.steps[step];
    lines.push(`  ${step.padEnd(16)} ${record === undefined ? 'not run' : `confirmed ${record.confirmed_at}${record.tx_hash === null ? '' : `, transaction ${record.tx_hash}`}, ${record.verified_at === null ? 'not verified' : 'verified'}`}`);
  }
  const parts = Object.keys(snapshot.notes).filter((key) => key.startsWith('part.'));
  for (const key of parts) {
    const part = snapshot.notes[key];
    const hash = part !== null && typeof part === 'object' && 'tx_hash' in part && typeof part.tx_hash === 'string' ? part.tx_hash : '?';
    lines.push(`  ${key.slice(5).padEnd(16)} confirmed (a part of a step), transaction ${hash}`);
  }
  lines.push(snapshot.in_flight === null ? 'in flight: nothing' : `in flight: the step ${snapshot.in_flight.step}, transaction ${snapshot.in_flight.tx_hash}, signed at ${iso(snapshot.in_flight.signed_at)}, may land until ${iso(snapshot.in_flight.valid_to)}`);
  const next = def.steps.find((step) => snapshot.steps[step] === undefined);
  lines.push(next === undefined ? 'next: every step is confirmed; run cleanup to take back what can come back' : `next: ${next}`);
  if (def.needs.chain) {
    const gate = await session.network.guard();
    lines.push(`network guard: ${gate.ok ? 'ok' : 'FAIL'}, ${gate.message}`);
    for (const key of [...session.ring.keyHashes()].map((hash) => session.ring.get(session.ring.roleOf(hash)!))) {
      const utxos = await session.chain.provider.getUtxos(key.address);
      const total = utxos.reduce((sum, utxo) => sum + (utxo.assets.lovelace ?? 0n), 0n);
      const collateral = utxos.filter((utxo) => Object.keys(utxo.assets).every((unit) => unit === 'lovelace') && (utxo.assets.lovelace ?? 0n) >= 5_000_000n).length;
      lines.push(`wallet of the ${key.role} key ${key.keyHash}: ${units(total)} in ${utxos.length} output(s), ${collateral} pure output(s) of 5 units or more for collateral`);
    }
  }
  lines.push(...(await def.status?.(session) ?? []));
  return lines;
}

// ─── The run ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

const AWAIT_MS = 180_000;
const POLL_MS = 4_000;

/** The exit code that an error stands for, and the lines to print. */
export function reportError(err: unknown, def: Pick<CheckDefinition, 'name' | 'flags'>, out: Output): number {
  if (err instanceof FlagError) { out.err(`${err.message}\n${usage(def)}`); return 2; }
  if (err instanceof SettingsError) { for (const problem of err.problems) out.err(problem); return 2; }
  if (err instanceof KeyFileError || err instanceof StateError || err instanceof EvidenceError || err instanceof GuardRefusal || err instanceof PreconditionError) { out.err(err.message); return 2; }
  if (err instanceof HostedError) { out.err(err.message); return err.kind === 'bad_arguments' ? 2 : 3; }
  if (err instanceof LandRefused) {
    out.err(`${err.message}\nThe evidence file holds the evaluation error and the body of the transaction. The state is unchanged.`);
    return 1;
  }
  out.err(err instanceof Error ? err.message : String(err));
  if (err instanceof TxNotConfirmedError) out.err('The signed transaction is kept in the state file: the next run settles it before it builds anything.');
  return 1;
}

function finish(outcome: StepOutcome, out: Output): number {
  if (outcome.kind === 'dry') { out.out('dry run: nothing was signed or submitted. Run again with --submit to sign, submit and wait for the confirmation.'); return 0; }
  if (outcome.kind === 'wait') { out.out(`WAIT: ${outcome.message}${outcome.untilMs === null ? '' : ` (until ${iso(outcome.untilMs)})`}`); return 4; }
  out.out(outcome.message);
  return 0;
}

export async function runCheck<Extra>(def: CheckDefinition<Extra>, argv: readonly string[], deps: RunDeps): Promise<number> {
  const { out, clock } = deps;
  let closeHosted: (() => Promise<void>) | null = null;
  try {
    const args = parseArguments(def, argv);
    const common = parseCommonSettings(deps.env, { keys: def.needs.keys });
    const extra = def.parse(deps.env, common);
    const readKey = deps.readKey ?? ((path: string, role: KeyRole) => readKeyFile(path, role));
    const loaded = def.needs.keys.map((role) => readKey(common.keyFiles[role]!, role));
    const ring = new KeyRing(loaded);
    const authPath = common.keyFiles.authentication;
    const authKey = authPath === undefined ? (ring.find('agent') ?? null) : readKey(authPath, 'agent');
    const fetchImpl = deps.fetchImpl ?? fetch;
    const provider = deps.node !== undefined && deps.chain !== undefined ? null : new OgmiosProvider({ ogmiosUrl: common.urls.ogmios, submitUrl: common.urls.submit, koiosUrl: common.urls.koios });
    const node = deps.node ?? new VectorNode({ provider: provider!, koiosUrl: common.urls.koios, fetchImpl });
    const chain = deps.chain ?? (def.needs.chain ? realChain(common, deps.env, fetchImpl, provider!) : unusedChain(def.name));
    const lazy = deps.hosted === undefined ? lazyHosted(common.urls.hosted, def.needs.hosted) : { tools: deps.hosted, close: async () => undefined };
    closeHosted = lazy.close;
    const state = StateFile.open(join(common.stateDir, `${def.name}.state.json`), { check: def.name, network: common.network.name, record: common.recordDid });
    const evidence = EvidenceFile.open(join(common.stateDir, `${def.name}.evidence.json`), { check: def.name, network: common.network.name, record: common.recordDid });
    const network = new NetworkGate(node, common.network);
    const awaitMs = deps.awaitMs ?? AWAIT_MS;
    const pollMs = deps.pollMs ?? POLL_MS;
    const io: LandIo = {
      mode: args.mode, node, signer: ring, ring, network, out: (line) => out.out(line), clock, awaitMs, pollMs,
      inFlight: { set: (record) => { state.setInFlight(record); }, clear: () => { state.clearInFlight(); } },
    };
    const session: Session<Extra> = {
      check: def.name, mode: args.mode, settings: common, extra, out, clock, state, evidence, ring, authKey, node, network, chain, hosted: lazy.tools, fetchImpl, awaitMs, pollMs,
      land: landFor(io, evidence),
    };
    if (args.command === 'status') {
      for (const line of await statusLines(def, session)) out.out(line);
      return 0;
    }
    const settled = await settleInFlight({ state, node, clock, out: (line) => out.out(line), mode: args.mode, awaitMs, pollMs });
    if (settled.kind === 'wait') return finish({ kind: 'wait', message: settled.message, untilMs: settled.untilMs }, out);
    const outcome = args.command === 'cleanup' ? await def.cleanup(session, args.flags) : await def.next(session, args.flags);
    return finish(outcome, out);
  } catch (err) {
    return reportError(err, def, out);
  } finally {
    if (closeHosted !== null) await closeHosted().catch(() => undefined);
  }
}

/** A step that must wait says how long: the time that is left, and the time at which to run it again. */
export function waitFor(untilMs: number, nowMs: number, why: string): StepOutcome {
  return { kind: 'wait', message: `${why}: ${duration(untilMs - nowMs)} are left`, untilMs };
}
