// scripts/operator/lib/land-hosted.ts - the one place where a transaction that a tool or a builder made meets the guards, the keys and the node. Every task that signs a transaction that it
// fetches or builds signs through `landHosted` (a hosted build tool) or `landBuilt` (a builder of buyer-core, or the pack, in process). Both run the same steps, and nothing is signed before
// each of them has passed:
//   the validity end   the end of the validity that the builder says is the end that the bytes carry (the `ttl`), in the slots of Vector
//   the approval       in submit mode, the approval file allows the task, the run wallet and the irreversible tag
//   the signers        the keys that sign are exactly the keys that the step names: no key more, no key less, and every key is a key of the registry
//   the plan           the guards of the checks judge the bytes against the plan of the step
//   the cap            in submit mode, the net outflow of the registry stays within the cap of the approval
// The net outflow is reserved in the cap when the signed bytes are written into the state file, before the submit, so a transaction that confirms after the run has ended is counted. A
// transaction that the ledger refuses outright gives its reserve back. A dry run stops at the summary: it signs nothing and does not read the approval.
import { HostedError } from '../../checks/lib/hosted.ts';
import type { ToolAnswer } from '../../checks/lib/hosted.ts';
import { iso } from '../../checks/lib/format.ts';
import { neededSigners } from '../../checks/lib/guards.ts';
import type { GuardName, GuardResult, RingView, StepPlan } from '../../checks/lib/guards.ts';
import { GuardRefusal } from '../../checks/lib/land.ts';
import type { LandIo, LandRequest } from '../../checks/lib/land.ts';
import type { Utxo } from '../../checks/lib/platform.ts';
import type { Signer } from '../../checks/lib/ports.ts';
import { commitStep, landFor } from '../../checks/lib/session.ts';
import { StateError } from '../../checks/lib/state.ts';
import { factsOf } from '../../checks/lib/txfacts.ts';
import type { TxFacts } from '../../checks/lib/txfacts.ts';
import { netRegistryOutflow, requireGo } from './approval.ts';
import type { IrreversibleTag } from './approval.ts';
import type { BuiltLandSpec, HostedBuild, HostedLandSpec, LandHost } from './contract.ts';

/** A hosted tool refused the call: its answer says Failed, REFUSED or another failure. `detail` is the first line of its text. */
export class ToolRefused extends Error {
  readonly tool: string;
  readonly detail: string;
  constructor(tool: string, detail: string) {
    super(`the tool ${tool} refused the call: ${detail}`);
    this.name = 'ToolRefused';
    this.tool = tool;
    this.detail = detail;
  }
}

/** What a landing gives back. `build` is the answer of the hosted tool, or null for a transaction that was built in process. A dry run stopped at the summary: nothing was signed. */
export type Landed =
  | { kind: 'dry'; txHash: string; facts: TxFacts; results: GuardResult[]; build: HostedBuild | null }
  | { kind: 'landed'; txHash: string; feeLovelace: bigint; facts: TxFacts; results: GuardResult[]; confirmations: number; build: HostedBuild | null };

// ---- the hosted build ----

/** The texts of a tool that cannot answer now. A call that failed with one of them is asked again. */
const TRANSIENT = /not ready|not synced|behind|try again|temporar|timed out/i;
const RETRIES = 4;
const RETRY_PAUSE_MS = 10_000;
const CBOR_BLOCK = /\*\*Unsigned TX CBOR:\*\*\s*```[^\n]*\r?\n([\s\S]*?)\r?\n```/;
const HEX_BYTES = /^(?:[0-9a-fA-F]{2})+$/;
const HASH = /^[0-9a-fA-F]{64}$/;
const KEY_HASH = /^[0-9a-fA-F]{56}$/;
const LOVELACE = /^[0-9]+$/;

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const protocol = (tool: string, problem: string): HostedError => new HostedError('protocol', `the answer of ${tool} ${problem}`);

/** The first line of the text of a failed call, and a sentence when the tool gave none: the evidence never holds an empty message. */
const detailOf = (answer: ToolAnswer): string => (answer.message.trim() === '' ? 'the tool gave no reason' : answer.message.trim());

function signersOf(tool: string, value: unknown): HostedBuild['requiredSigners'] {
  if (!Array.isArray(value)) throw protocol(tool, 'has no required_signers list');
  return value.map((item: unknown) => {
    const entry = typeof item === 'object' && item !== null && !Array.isArray(item) ? (item as Record<string, unknown>) : null;
    const hash = entry?.key_hash;
    const roles = entry?.roles;
    if (typeof hash !== 'string' || !KEY_HASH.test(hash) || !Array.isArray(roles) || !roles.every((role): role is string => typeof role === 'string')) {
      throw protocol(tool, 'has a required_signers entry that is not a key_hash of 56 hex characters with a list of roles');
    }
    return { keyHash: hash.toLowerCase(), roles: [...roles] };
  });
}

/** Reads the answer of a build tool. Each member that is missing or has the wrong shape is an error that names the member, and the hash and the fee must be those of the bytes. */
function buildOf(tool: string, args: Readonly<Record<string, unknown>>, answer: ToolAnswer): HostedBuild {
  const cbor = CBOR_BLOCK.exec(answer.text)?.[1]?.trim();
  if (cbor === undefined) throw protocol(tool, 'has no unsigned CBOR: the fenced block after "Unsigned TX CBOR:" is missing');
  if (!HEX_BYTES.test(cbor)) throw protocol(tool, 'has an unsigned CBOR that is not hex of whole bytes');
  const json = answer.json;
  if (json === null) throw protocol(tool, 'has no JSON block');
  const { tx_hash: hash, fee, valid_to: validTo } = json;
  if (typeof hash !== 'string' || !HASH.test(hash)) throw protocol(tool, 'has no tx_hash of 64 hex characters');
  if (typeof fee !== 'string' || !LOVELACE.test(fee)) throw protocol(tool, 'has no fee as a text of digits');
  if (typeof validTo !== 'number' || !Number.isSafeInteger(validTo)) throw protocol(tool, 'has a valid_to that is not a whole number of milliseconds');
  const requiredSigners = signersOf(tool, json.required_signers);
  let bytes: TxFacts;
  try { bytes = factsOf(cbor); } catch (err) { throw protocol(tool, `has an unsigned CBOR that is no transaction (${errorText(err).slice(0, 200)})`); }
  if (bytes.txHash !== hash.toLowerCase()) throw protocol(tool, `says that the hash of the transaction is ${hash.toLowerCase()}, and the bytes have the hash ${bytes.txHash}`);
  if (bytes.feeLovelace !== BigInt(fee)) throw protocol(tool, `says that the fee is ${fee} lovelace, and the bytes have the fee ${bytes.feeLovelace}`);
  return { tool, args: { ...args }, text: answer.text, json, unsignedCbor: cbor.toLowerCase(), txHash: bytes.txHash, feeLovelace: bytes.feeLovelace, validTo, requiredSigners };
}

/**
 * Calls a hosted build tool (each call is held to the live schema of the tool) and reads its answer: the unsigned CBOR that follows `**Unsigned TX CBOR:**`, and the last JSON block with
 * `tx_hash`, `fee`, `valid_to` and `required_signers`. A failed answer is `ToolRefused`. A failed answer that says that the tool cannot answer now is asked again up to 4 times, 10 seconds
 * apart, and then it is `HostedError('unreachable')`. An answer that is malformed, or whose hash or fee is not that of its bytes, is `HostedError('protocol')`. Nothing is signed here.
 */
export async function hostedBuild(host: Pick<LandHost, 'hosted' | 'clock' | 'out'>, tool: string, args: Record<string, unknown>): Promise<HostedBuild> {
  for (let asked = 0; ; asked += 1) {
    const answer = await host.hosted.call(tool, args);
    if (!answer.failed) return buildOf(tool, args, answer);
    if (!TRANSIENT.test(answer.text)) throw new ToolRefused(tool, detailOf(answer));
    if (asked === RETRIES) throw new HostedError('unreachable', `the tool ${tool} still could not answer after ${RETRIES + 1} calls (${detailOf(answer)}): try again later`);
    host.out.out(`the tool ${tool} cannot answer now (${detailOf(answer)}); asking again in ${RETRY_PAUSE_MS / 1000} s`);
    await host.clock.sleep(RETRY_PAUSE_MS);
  }
}

// ---- the checks before the guards ----

const refuse = (step: string, guard: GuardName, message: string): GuardRefusal => new GuardRefusal(step, [{ guard, ok: false, message }]);
const refOf = (utxo: Utxo): string => `${utxo.txHash}#${utxo.outputIndex}`;

/** In submit mode the approval must allow this task, the run wallet and the irreversible tag. A dry run does not read it. */
function requireApproval(host: LandHost, irreversible: IrreversibleTag | undefined): void {
  requireGo(host.go, { task: host.task, runWallet: host.registry.addressOf('run'), nowMs: host.clock.now(), irreversible: irreversible === undefined ? [] : [irreversible] });
}

/** The end of the validity that a builder gives must be a whole number of milliseconds after the clock of the host: `settleInFlight` lets a lost transaction go only after it. */
function requireValidTo(step: string, validTo: unknown, nowMs: number): void {
  if (typeof validTo !== 'number' || !Number.isSafeInteger(validTo) || validTo <= nowMs) {
    throw new Error(`the step ${step} gives a validTo that is not a whole number of milliseconds after now (${String(validTo)}), so no guard ran and nothing was signed`);
  }
}

/**
 * The `ttl` of the bytes must be the slot of Vector that the built `validTo` falls in: the slot is `floor((validTo - start of the chain) / 1000)`, with the start that the node gives. Lucid
 * turns a `validTo` into a slot with its own clock until the slot clock of Vector is set, and then the `ttl` is years too late: the bytes could land long after `validTo`, and a lost
 * transaction would be let go while it can still land. A body without a `ttl` has no end at all.
 */
async function requireValidityEnd(host: LandHost, step: string, facts: TxFacts, validTo: number): Promise<void> {
  let start: number | null;
  try { start = (await host.node.networkFacts()).systemStartMs; } catch (err) {
    throw refuse(step, 'body', `the start of the chain could not be read from the node (${errorText(err)}), so the end of the validity cannot be checked`);
  }
  if (start === null || !Number.isFinite(start)) throw refuse(step, 'body', 'the node does not give the start of the chain, so the end of the validity cannot be checked');
  const slot = BigInt(Math.floor((validTo - start) / 1000));
  if (facts.validityEndSlot === null) throw refuse(step, 'body', `the body has no ttl, and the built validTo ${iso(validTo)} is the slot ${slot}`);
  if (facts.validityEndSlot !== slot) throw refuse(step, 'body', `the body ends at the slot ${facts.validityEndSlot}, and the built validTo ${iso(validTo)} is the slot ${slot}`);
}

/**
 * The keys that sign must be exactly the keys that the step names. The keys that sign are the required signers that a hosted answer lists and the keys that the bytes need (the required
 * signers of the body and the owner of each input). A key more or a key less refuses the step, and so does a key that the registry does not hold. The message names both sets.
 */
function requireSigners(host: LandHost, core: Core, facts: TxFacts, utxos: readonly Utxo[]): void {
  const read = new Set(utxos.map(refOf));
  const unread = [...facts.inputs.map((ref) => ({ ref, kind: 'input' })), ...facts.collateralInputs.map((ref) => ({ ref, kind: 'collateral input' }))].find(({ ref }) => !read.has(ref));
  if (unread !== undefined) throw refuse(core.step, 'inputs', `the ${unread.kind} ${unread.ref} could not be read from the node, so the keys that sign and the net outflow cannot be told`);
  const signing = new Set([...neededSigners(facts, utxos), ...core.listed]);
  const expected = new Set(core.expectSigners.map((name) => host.registry.hashOf(name)));
  const extra = [...signing].filter((hash) => !expected.has(hash));
  const missing = [...expected].filter((hash) => !signing.has(hash));
  if (extra.length === 0 && missing.length === 0) return;
  const named = (hash: string): string => host.registry.nameOfHash(hash) ?? `a key that is not in the registry (${hash})`;
  const list = (hashes: Iterable<string>): string => [...hashes].map(named).sort().join(', ') || 'none';
  const problems = [extra.length > 0 ? `extra ${list(extra)}` : '', missing.length > 0 ? `missing ${list(missing)}` : ''].filter((part) => part !== '');
  throw refuse(core.step, 'signers', `the keys that sign are ${list(signing)}, and the step expects ${list(expected)}: ${problems.join('; ')}`);
}

/**
 * The state file holds one transaction in flight. No other transaction is signed before that one is settled: the settling of the first needs its reserve in the cap, and a second record could not
 * be written down. This holds for every transaction, and so for the same bytes landed again.
 */
function requireNoFlight(host: LandHost): void {
  const flight = host.state.snapshot().in_flight;
  if (flight !== null) throw new StateError('in_flight', `the step ${flight.step} is in flight (${flight.tx_hash}): settle it before another transaction is signed`);
}

// ---- the landing ----

/** The signer, the view of the keys and the writer of `in_flight` that the landing of the checks takes. The signer can sign and nothing else; the view can sign nothing. */
function ioOf(host: LandHost, net: bigint): LandIo {
  const { ring } = host.registry;
  const signer: Signer = { has: (keyHash) => ring.has(keyHash), sign: (keyHash, cborHex) => ring.sign(keyHash, cborHex) };
  const view: RingView = { keyHashes: () => ring.keyHashes(), wallets: () => ring.wallets(), roleOf: (keyHash) => ring.roleOf(keyHash) };
  let reserved: string | null = null;
  return {
    mode: host.mode, node: host.node, signer, ring: view, network: host.network, out: (line) => host.out.out(line), clock: host.clock, awaitMs: host.awaitMs, pollMs: host.pollMs,
    inFlight: {
      // The cap counts the transaction before the state file holds it and before the submit. The reserve stays when the state file throws: the record may be on disk already, and `settleInFlight`
      // settles it at the next run, so the transaction may still land.
      set: (record) => {
        host.exposure.reserve({ step: record.step, txHash: record.tx_hash, netLovelace: net, at: iso(host.clock.now()) });
        host.state.setInFlight(record);
        reserved = record.tx_hash;
      },
      // The ledger refused the transaction outright: it cannot land, and its reserve goes back.
      clear: () => {
        host.state.clearInFlight();
        if (reserved !== null) host.exposure.release(reserved);
        reserved = null;
      },
    },
  };
}

/** What both landings share, with the callbacks of the spec turned into functions of the facts of the bytes. */
interface Core {
  readonly step: string;
  readonly built: BuiltLandSpec['built'];
  readonly expectSigners: readonly string[];
  /** The key hashes that a hosted answer lists as required signers. */
  readonly listed: readonly string[];
  readonly plan: (facts: TxFacts) => StepPlan | Promise<StepPlan>;
  readonly beforeSign: ((facts: TxFacts) => Promise<void>) | undefined;
  readonly refs: ((facts: TxFacts) => Record<string, string>) | undefined;
  readonly record: ((facts: TxFacts) => Record<string, unknown>) | undefined;
  readonly notes: readonly string[] | undefined;
  readonly irreversible: IrreversibleTag | undefined;
  readonly build: HostedBuild | null;
}

async function landCore(host: LandHost, core: Core): Promise<Landed> {
  const { step, built } = core;
  const submit = host.mode === 'submit';
  requireValidTo(step, built.validTo, host.clock.now());
  if (submit) requireApproval(host, core.irreversible);
  if (submit) requireNoFlight(host);
  const facts = factsOf(built.unsignedCbor);
  await requireValidityEnd(host, step, facts, built.validTo);
  const utxos = await host.node.resolveInputs([...facts.inputs, ...facts.collateralInputs]);
  requireSigners(host, core, facts, utxos);
  if (submit && core.beforeSign !== undefined) await core.beforeSign(facts);
  const plan = await core.plan(facts);
  let net = 0n;
  if (submit) {
    // The map holds the spent inputs and the collateral inputs, all read from the node: the net outflow of a transaction that runs scripts counts the collateral that a failure takes.
    const spent = new Map(utxos.map((utxo) => [refOf(utxo), { address: utxo.address, lovelace: utxo.assets.lovelace ?? 0n }]));
    net = netRegistryOutflow(facts, spent, host.registry.ring);
    host.exposure.refuseOver(net);
  }
  const refs = core.refs?.(facts) ?? {};
  const recorded = core.record?.(facts) ?? {};
  const request: LandRequest = { step, built, plan, refs, facts: recorded, ...(core.notes === undefined ? {} : { notes: core.notes }) };
  const landed = await landFor(ioOf(host, net), host.evidence)(request);
  if (landed.kind === 'dry') return { kind: 'dry', txHash: landed.facts.txHash, facts: landed.facts, results: landed.results, build: core.build };
  commitStep(host, request, landed, { refs, facts: recorded });
  return { kind: 'landed', txHash: landed.txHash, feeLovelace: landed.feeLovelace, facts: landed.facts, results: landed.results, confirmations: landed.confirmations, build: core.build };
}

/**
 * Lands a transaction that a builder made in process (buyer-core, or the pack with Lucid): `built` holds the unsigned CBOR, its hash, its fee and the end of its validity in POSIX milliseconds.
 * The `validTo` must be a whole number after now, and the `ttl` of the bytes must be its slot. `expectSigners` are registry names, and the keys that the bytes need must be exactly those keys.
 */
export async function landBuilt(host: LandHost, spec: BuiltLandSpec): Promise<Landed> {
  return landCore(host, {
    step: spec.step, built: spec.built, expectSigners: spec.expectSigners, listed: [], plan: spec.plan, beforeSign: spec.beforeSign, refs: spec.refs, record: spec.facts, notes: spec.notes,
    irreversible: spec.irreversible, build: null,
  });
}

/**
 * Builds with a hosted tool, then lands the answer as `landBuilt` does, with the key hashes that the answer lists as required signers counted among the keys that sign. In submit mode the
 * approval is read before the tool is called. A tool that refuses leaves a `tool_refused` entry in the evidence, with its message, before `ToolRefused` is thrown.
 */
export async function landHosted(host: LandHost, spec: HostedLandSpec): Promise<Landed> {
  if (host.mode === 'submit') requireApproval(host, spec.irreversible);
  let build: HostedBuild;
  try {
    build = await hostedBuild(host, spec.tool, spec.args);
  } catch (err) {
    if (err instanceof ToolRefused) host.evidence.add({ step: spec.step, status: 'tool_refused', expected: false, tool: err.tool, message: err.detail });
    throw err;
  }
  const { beforeSign, refs, facts: record } = spec;
  return landCore(host, {
    step: spec.step, built: { unsignedCbor: build.unsignedCbor, txHash: build.txHash, feeLovelace: build.feeLovelace, validTo: build.validTo }, expectSigners: spec.expectSigners,
    listed: build.requiredSigners.map((signer) => signer.keyHash), plan: (facts) => spec.plan(build, facts), beforeSign: beforeSign && ((facts) => beforeSign(build, facts)),
    refs: refs && ((facts) => refs(build, facts)), record: record && ((facts) => record(build, facts)), notes: spec.notes, irreversible: spec.irreversible, build,
  });
}
