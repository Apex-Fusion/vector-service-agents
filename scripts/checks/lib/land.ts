// scripts/checks/lib/land.ts - the landing of one transaction, the same way for every step of every check.
//   1. The network guard: the node says the magic (and the start) of the network that the settings name.
//   2. The facts of the bytes, the outputs that the transaction spends, and the guards of guards.ts.
//   3. The summary: the hash, the fee, each input and output with its amount and its owner, the keys that sign, and the result of each guard.
//   4. A guard that fails refuses the step. Nothing is signed. In dry mode, nothing else happens.
//   5. Each key that the transaction needs signs. After each signature the body is the body that was built, byte for byte, and at the end each witness is there.
//   6. The signed bytes are kept in the state file (`in_flight`), then submitted, then the status is read until the transaction is confirmed.
// A failure after the signature is a TxNotConfirmedError, the error of the buyer chain: it says whether the transaction may still land. A 4xx of the submit API is the verdict of the
// ledger: it is a LandRefused, with the evaluation error and the body of the transaction, and the transaction cannot land.
import { neededSigners, runGuards, failed } from './guards.ts';
import type { GuardResult, RingView, StepPlan } from './guards.ts';
import { keyCredentialOf } from './addresses.ts';
import { duration, iso, units } from './format.ts';
import type { Clock, NetworkFacts, NodeAccess, Signer } from './ports.ts';
import { TxNotConfirmedError } from './platform.ts';
import type { NetworkSpec } from './settings.ts';
import type { InFlight } from './state.ts';
import { factsOf } from './txfacts.ts';
import type { TxFacts } from './txfacts.ts';

/** A transaction as a builder gave it, unsigned. `validTo` is the end of its validity in POSIX ms: after it the transaction can no longer land. */
export interface BuiltTransaction {
  unsignedCbor: string;
  txHash: string;
  feeLovelace: bigint;
  validTo: number;
}

export interface LandRequest {
  /** The name of the step, for the summary and the messages. */
  step: string;
  built: BuiltTransaction;
  plan: StepPlan;
  /** What the step records when the transaction is confirmed. */
  refs?: Record<string, string>;
  facts?: Record<string, unknown>;
  /** Lines that the step adds to the summary: what it plans. */
  notes?: readonly string[];
  /** The escrow that the transaction makes or spends, so that a failure after the signature names it. `deliverBy` is null for a transaction that spends an escrow. */
  escrow?: { ref: string; deliverBy: number | null };
}

export interface LandIo {
  mode: 'dry' | 'submit';
  node: NodeAccess;
  signer: Signer;
  ring: RingView;
  network: NetworkGate;
  out(line: string): void;
  clock: Clock;
  /** How long the wait for the confirmation lasts, and how long between two reads of the status, in milliseconds. */
  awaitMs: number;
  pollMs: number;
  /** The state file keeps the signed bytes before the submit, and lets them go when the transaction cannot land. */
  inFlight: { set(record: InFlight): void; clear(): void };
}

export type LandResult =
  | { kind: 'dry'; facts: TxFacts; results: GuardResult[] }
  | { kind: 'landed'; txHash: string; feeLovelace: bigint; signedCbor: string; facts: TxFacts; results: GuardResult[]; confirmations: number };

/** A guard failed: nothing was signed. */
export class GuardRefusal extends Error {
  readonly step: string;
  readonly results: readonly GuardResult[];
  readonly failures: readonly GuardResult[];
  constructor(step: string, results: readonly GuardResult[]) {
    const failures = failed(results);
    super(`the step ${step} is refused by ${failures.map((f) => f.guard).join(', ')}: ${failures.map((f) => f.message).join('; ')}. Nothing was signed.`);
    this.name = 'GuardRefusal';
    this.step = step;
    this.results = results;
    this.failures = failures;
  }
}

/** The ledger refused a transaction after it was signed: the submit API answered with a 4xx. The transaction cannot land. */
export class LandRefused extends TxNotConfirmedError {
  readonly evaluationError: string;
  /** The body of the transaction, in hex. */
  readonly transactionBody: string;
  constructor(message: string, facts: { txHash: string; escrowRef: string; deliverBy: number | null; validTo: number }, evaluationError: string, transactionBody: string, options?: { cause?: unknown }) {
    super(message, { ...facts, mayLand: false }, options);
    this.name = 'LandRefused';
    this.evaluationError = evaluationError;
    this.transactionBody = transactionBody;
  }
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));
/** The submit API answers 4xx for a transaction that it refuses itself, the verdict of the ledger included: the transaction was not taken. */
const refusedOutright = (err: unknown): boolean => /^Transaction submission rejected \(4\d\d\b/.test(errorText(err));

// ─── The network ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The network guard: the node says that it is on the network that the settings name. A result that was read is kept, so the node is asked once. */
export class NetworkGate {
  readonly #node: Pick<NodeAccess, 'networkFacts'>;
  readonly #expected: NetworkSpec;
  #result: GuardResult | null = null;

  constructor(node: Pick<NodeAccess, 'networkFacts'>, expected: NetworkSpec) {
    this.#node = node;
    this.#expected = expected;
  }

  async guard(): Promise<GuardResult> {
    if (this.#result !== null) return this.#result;
    let facts: NetworkFacts;
    try { facts = await this.#node.networkFacts(); } catch (err) {
      return { guard: 'network', ok: false, message: `the network of the node could not be read (${errorText(err)}), so nothing is signed` };
    }
    const expected = this.#expected;
    let message: string | null = null;
    if (facts.magic !== expected.magic) message = `the node is on the network with the magic ${facts.magic}, and the run is for ${expected.name} (magic ${expected.magic})`;
    else if (expected.systemStartMs !== null && facts.systemStartMs !== expected.systemStartMs) {
      message = `the chain of the node started at ${facts.systemStartMs === null ? 'a time that it does not say' : iso(facts.systemStartMs)}, and ${expected.name} started at ${iso(expected.systemStartMs)}`;
    }
    this.#result = message === null
      ? { guard: 'network', ok: true, message: `the node is on ${expected.name} (magic ${facts.magic})` }
      : { guard: 'network', ok: false, message };
    return this.#result;
  }
}

// ─── The summary ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────

function ownerOf(address: string, plan: StepPlan, ring: RingView): string {
  const credential = keyCredentialOf(address);
  if (credential !== null && ring.keyHashes().has(credential)) return `the ${ring.roleOf(credential)} wallet`;
  return plan.labels?.[address] ?? address;
}

function summary(request: LandRequest, io: LandIo, facts: TxFacts, inputs: ReadonlyMap<string, { address: string; lovelace: bigint }>, needed: readonly string[], results: readonly GuardResult[]): string[] {
  const { plan, built } = request;
  const lines = [
    `step ${request.step}: ${io.mode === 'dry' ? 'dry mode, nothing is signed or submitted' : 'submit mode, the transaction is signed and submitted'}`,
    `transaction: ${facts.txHash}`,
    `fee: ${units(facts.feeLovelace)}`,
    `valid until: ${iso(built.validTo)}`,
  ];
  const input = (ref: string): string => {
    const found = inputs.get(ref);
    if (found === undefined) return `  ${ref}  (not read)`;
    const why = plan.explained.has(ref) ? ' (explained by the state file)' : '';
    return `  ${ref}  ${units(found.lovelace)}  ${ownerOf(found.address, plan, io.ring)}${why}`;
  };
  lines.push(`inputs (${facts.inputs.length}):`, ...facts.inputs.map(input));
  if (facts.collateralInputs.length > 0) lines.push(`collateral inputs (${facts.collateralInputs.length}):`, ...facts.collateralInputs.map(input));
  lines.push(`outputs (${facts.outputs.length}):`);
  for (const output of facts.outputs) {
    const assets = Object.entries(output.assets).map(([unit, quantity]) => `${quantity} of ${unit}`);
    lines.push(`  ${output.index + 1}. ${units(output.lovelace)} to ${ownerOf(output.address, plan, io.ring)}${assets.length > 0 ? `, with ${assets.join(', ')}` : ''}${output.inlineDatum === null ? '' : ', with an inline datum'}`);
  }
  if (Object.keys(facts.mint).length > 0) lines.push(`mints and burns: ${Object.entries(facts.mint).map(([unit, quantity]) => `${quantity} of ${unit}`).join(', ')}`);
  lines.push(`signers: ${needed.length === 0 ? 'none' : needed.map((keyHash) => `${io.ring.roleOf(keyHash) ?? 'unknown'} key ${keyHash}`).join(', ')}`);
  lines.push(...(request.notes ?? []));
  lines.push('guards:', ...results.map((r) => `  ${r.ok ? 'ok  ' : 'FAIL'}  ${r.guard.padEnd(13)} ${r.message}`));
  return lines;
}

// ─── The landing ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────

export async function landTransaction(request: LandRequest, io: LandIo): Promise<LandResult> {
  const { built, plan, step } = request;
  const results: GuardResult[] = [await io.network.guard()];
  const facts = factsOf(built.unsignedCbor);
  const utxos = await io.node.resolveInputs([...facts.inputs, ...facts.collateralInputs]);
  results.push(...runGuards({ facts, claims: { txHash: built.txHash, feeLovelace: built.feeLovelace }, inputs: utxos, plan, ring: io.ring }));
  const needed = neededSigners(facts, utxos);
  const read = new Map(utxos.map((u) => [`${u.txHash}#${u.outputIndex}`, { address: u.address, lovelace: u.assets.lovelace ?? 0n }]));
  for (const line of summary(request, io, facts, read, needed, results)) io.out(line);
  if (failed(results).length > 0) throw new GuardRefusal(step, results);
  if (io.mode === 'dry') return { kind: 'dry', facts, results };

  const signed = signAll(request, io, facts, needed, results);
  const escrow = { escrowRef: request.escrow?.ref ?? '', deliverBy: request.escrow?.deliverBy ?? null };
  io.inFlight.set({ step, tx_hash: facts.txHash, signed_cbor: signed, valid_to: built.validTo, signed_at: io.clock.now(), refs: request.refs ?? {}, facts: request.facts ?? {} });
  io.out(`signed by ${needed.map((keyHash) => io.ring.roleOf(keyHash)).join(', ')}; the body is the body that was built`);
  const where = `The transaction ${facts.txHash} of the step ${step}`;
  const until = `It may land, but only before ${iso(built.validTo)}.`;
  try {
    await io.node.submit(signed);
  } catch (err) {
    if (refusedOutright(err)) {
      io.inFlight.clear();
      throw new LandRefused(`${where} was refused by the ledger and cannot land (${errorText(err)}).`, { txHash: facts.txHash, ...escrow, validTo: built.validTo }, errorText(err), facts.bodyHex, { cause: err });
    }
    throw new TxNotConfirmedError(`${where} may not have been submitted (${errorText(err)}). ${until}`, { txHash: facts.txHash, ...escrow, validTo: built.validTo, mayLand: true }, { cause: err });
  }
  io.out(`submitted ${facts.txHash}; waiting for the confirmation (at most ${duration(io.awaitMs)})`);
  const confirmations = await confirmed(facts.txHash, io);
  if (typeof confirmations === 'string') {
    throw new TxNotConfirmedError(`${where} was submitted and is not yet seen confirmed within ${duration(io.awaitMs)}${confirmations === '' ? '' : ` (the status ${confirmations})`}. ${until} Run the step again: it waits for this transaction first.`,
      { txHash: facts.txHash, ...escrow, validTo: built.validTo, mayLand: true });
  }
  io.out(`confirmed ${facts.txHash} (${confirmations} confirmation${confirmations === 1 ? '' : 's'})`);
  return { kind: 'landed', txHash: facts.txHash, feeLovelace: facts.feeLovelace, signedCbor: signed, facts, results, confirmations };
}

/** Signs with each key that the transaction needs. After each signature the body is the built body, and at the end each witness is there. A failure is a refusal before the submit. */
function signAll(request: LandRequest, io: LandIo, facts: TxFacts, needed: readonly string[], results: readonly GuardResult[]): string {
  const refuse = (message: string): GuardRefusal => new GuardRefusal(request.step, [...results, { guard: 'signed_body', ok: false, message }]);
  let signed = request.built.unsignedCbor;
  for (const keyHash of needed) {
    if (!io.signer.has(keyHash)) throw refuse(`the signer holds no key with the hash ${keyHash}`);
    signed = io.signer.sign(keyHash, signed);
    if (factsOf(signed).bodyHex !== facts.bodyHex) throw refuse(`the body after the signature of ${keyHash} is not the body that was built`);
  }
  const final = factsOf(signed);
  if (final.bodyHex !== facts.bodyHex || final.txHash !== facts.txHash) throw refuse('the signed transaction is not the transaction that was built, byte for byte');
  const missing = needed.filter((keyHash) => !final.witnesses.includes(keyHash));
  if (missing.length > 0) throw refuse(`the signed transaction has no witness of ${missing.join(', ')}`);
  return signed;
}

/**
 * Reads the status until the transaction has a confirmation, within the budget. Gives the number of confirmations, or, when the budget is spent, a text: the last failure of the
 * read, or an empty text when the read worked and the transaction is not confirmed.
 */
async function confirmed(txHash: string, io: LandIo): Promise<number | string> {
  const deadline = io.clock.now() + io.awaitMs;
  let lastFailure = '';
  for (;;) {
    try {
      const status = await io.node.txStatus(txHash);
      lastFailure = '';
      if (status.confirmations !== null && status.confirmations >= 1) return status.confirmations;
    } catch (err) {
      lastFailure = `could not be read: ${errorText(err)}`;
    }
    if (io.clock.now() >= deadline) return lastFailure;
    await io.clock.sleep(io.pollMs);
  }
}
