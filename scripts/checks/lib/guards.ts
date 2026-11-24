// scripts/checks/lib/guards.ts - the guards that every transaction passes before any signature.
// A guard judges the facts of the bytes of the transaction (txfacts.ts) and the outputs that it spends, and never the word of the builder. Each guard gives one result; the step
// is refused when one fails. The guards that need the network or the signer (the network of the node, the byte equality of the body after each signature) are in land.ts.
//
//   body           the hash and the fee that the builder gave are the ones of the bytes
//   fee            the fee is under the limit
//   signers        every key that the transaction needs is a key that the operator gave
//   inputs         every input and collateral input is a plain output of a wallet of the keys, or one that the state file explains
//   destinations   every output goes to a wallet of the keys or to an address that the step names
//   outflow        what leaves the wallet of each key is under the limit that the step names, and no asset leaves a wallet
//   collateral     what a script that fails takes from the collateral is under the limit
//   mint           the transaction mints and burns what the step says, and nothing else
//   nothing_else   no certificate, and no withdrawal besides the ones that the step names
//   vault          a payment from a vault is within the limits of its delegation
import { keyCredentialOf } from './addresses.ts';
import { units } from './format.ts';
import { decodeVaultDatum } from './platform.ts';
import type { Utxo } from './platform.ts';
import type { TxFacts } from './txfacts.ts';

export type GuardName = 'network' | 'body' | 'fee' | 'signers' | 'inputs' | 'destinations' | 'outflow' | 'collateral' | 'mint' | 'nothing_else' | 'vault' | 'signed_body';

export interface GuardResult {
  guard: GuardName;
  ok: boolean;
  message: string;
}

/** What a step lets a transaction do. */
export interface StepPlan {
  maxFeeLovelace: bigint;
  /** What may leave the wallet of each key, by key hash, in lovelace. A wallet that the plan does not name may only gain. */
  maxOutflow: Readonly<Record<string, bigint>>;
  /** What a script that fails may take from the collateral of a wallet. */
  maxCollateralLossLovelace: bigint;
  /** The references of the outputs that the state file explains: a transaction of this step may spend them. */
  explained: ReadonlySet<string>;
  /** The addresses, besides the wallets of the keys, that an output may go to. */
  destinations: ReadonlySet<string>;
  /** Exactly what the transaction mints (positive) and burns (negative), by unit. */
  mint: Readonly<Record<string, bigint>>;
  /** Words for an address, for the summary. */
  labels?: Readonly<Record<string, string>>;
  /**
   * How many withdrawals the transaction has. A withdrawal runs a stake script: the registration of an identity with a Module-1 party has one, as the consent of that party.
   * The default is none. The transaction must have exactly this number, and no certificate.
   */
  withdrawals?: number;
  /** The limits of the delegation that a vault pays under, and the addresses of the vault script and of the escrow script. */
  vault?: { address: string; escrowAddress: string; perTx: bigint; total: bigint };
}

/** What the guards read of the keys of a run: the key hashes, the wallet of each key and the name of each key. A `KeyRing` is one, and so is any object with these three methods. */
export interface RingView {
  keyHashes(): ReadonlySet<string>;
  wallets(): ReadonlyMap<string, string>;
  roleOf(keyHash: string): string | undefined;
}

export interface GuardInput {
  facts: TxFacts;
  /** The hash and the fee that the builder gave. */
  claims: { txHash: string; feeLovelace: bigint };
  /** The outputs that the transaction spends, as the ledger holds them: its inputs and its collateral inputs. */
  inputs: readonly Utxo[];
  plan: StepPlan;
  ring: RingView;
}

const pass = (guard: GuardName, message: string): GuardResult => ({ guard, ok: true, message });
const fail = (guard: GuardName, message: string): GuardResult => ({ guard, ok: false, message });
const refOf = (utxo: Utxo): string => `${utxo.txHash}#${utxo.outputIndex}`;
const sum = (values: Iterable<bigint>): bigint => { let total = 0n; for (const value of values) total += value; return total; };

/** The facts that most guards read: the outputs that the transaction spends, found by reference, and the wallets of the keys. */
interface Spending {
  found: Map<string, Utxo>;
  spent: Array<{ ref: string; utxo: Utxo | undefined }>;
  collateral: Array<{ ref: string; utxo: Utxo | undefined }>;
  wallets: ReadonlyMap<string, string>;
}

function bodyGuard({ facts, claims }: GuardInput): GuardResult {
  if (facts.txHash !== claims.txHash) return fail('body', `the hash of the bytes is ${facts.txHash}, and the builder says ${claims.txHash}`);
  if (facts.feeLovelace !== claims.feeLovelace) return fail('body', `the fee in the bytes is ${units(facts.feeLovelace)}, and the builder says ${units(claims.feeLovelace)}`);
  return pass('body', `the hash of the body is ${facts.txHash}`);
}

function feeGuard({ facts, plan }: GuardInput): GuardResult {
  if (facts.feeLovelace > plan.maxFeeLovelace) return fail('fee', `the fee is ${units(facts.feeLovelace)}, over the limit of ${units(plan.maxFeeLovelace)}`);
  return pass('fee', `the fee is ${units(facts.feeLovelace)}, the limit is ${units(plan.maxFeeLovelace)}`);
}

/** The keys that must sign: the required signers of the body, and the key of each spent and collateral input that sits at a key address. A reference that was not read is left out. */
export function neededSigners(facts: TxFacts, inputs: readonly Utxo[]): string[] {
  const needed = new Set(facts.requiredSigners);
  for (const utxo of inputs) {
    const credential = keyCredentialOf(utxo.address);
    if (credential !== null && [...facts.inputs, ...facts.collateralInputs].includes(refOf(utxo))) needed.add(credential);
  }
  return [...needed];
}

function signersGuard(input: GuardInput, spending: Spending): GuardResult {
  const { facts, ring } = input;
  const unreadable = [...spending.spent, ...spending.collateral].filter((entry) => entry.utxo === undefined);
  if (unreadable.length > 0) return fail('signers', `the key that ${unreadable[0]!.ref} needs is not known, because the output could not be read`);
  const needed = neededSigners(facts, input.inputs);
  const missing = needed.filter((keyHash) => !ring.keyHashes().has(keyHash));
  if (missing.length > 0) return fail('signers', `the transaction needs the signature of ${missing.join(', ')}, and the operator gave no such key`);
  return pass('signers', needed.length === 0 ? 'no key signs' : `the keys that sign are ${needed.map((keyHash) => `${ring.roleOf(keyHash)} ${keyHash}`).join(', ')}`);
}

function inputsGuard({ plan, ring }: GuardInput, spending: Spending): GuardResult {
  const refused: string[] = [];
  for (const { ref, utxo } of [...spending.spent, ...spending.collateral]) {
    if (utxo === undefined) { refused.push(`${ref} could not be read from the ledger`); continue; }
    if (plan.explained.has(ref)) continue;
    const credential = keyCredentialOf(utxo.address);
    const plain = (utxo.datum ?? null) === null && (utxo.datumHash ?? null) === null && (utxo.scriptRef ?? null) === null;
    if (credential === null || !ring.keyHashes().has(credential) || !plain) refused.push(`${ref} is not explained by the state file, and it is not a plain output of a wallet of the given keys`);
  }
  if (refused.length > 0) return fail('inputs', `the transaction spends ${refused.join('; ')}`);
  return pass('inputs', `${spending.spent.length} input(s) and ${spending.collateral.length} collateral input(s), each explained or a plain output of a wallet of the keys`);
}

function destinationsGuard({ facts, plan }: GuardInput, spending: Spending): GuardResult {
  const allowed = new Set([...spending.wallets.values(), ...plan.destinations]);
  const addresses = [...facts.outputs.map((output) => output.address), ...(facts.collateralReturn === null ? [] : [facts.collateralReturn.address])];
  const refused = [...new Set(addresses.filter((address) => !allowed.has(address)))];
  if (refused.length > 0) return fail('destinations', `an output goes to ${refused.join(', ')}, which is no wallet of the keys and no address of the step`);
  return pass('destinations', `${facts.outputs.length} output(s), each to a wallet of the keys or to an address of the step`);
}

function outflowGuard({ facts, plan, ring }: GuardInput, spending: Spending): GuardResult {
  const problems: string[] = [];
  const lines: string[] = [];
  for (const [keyHash, address] of spending.wallets) {
    const held = spending.spent.flatMap(({ utxo }) => (utxo !== undefined && keyCredentialOf(utxo.address) === keyHash ? [utxo] : []));
    const back = facts.outputs.filter((output) => output.address === address);
    const leave = sum(held.map((utxo) => utxo.assets.lovelace ?? 0n)) - sum(back.map((output) => output.lovelace));
    const limit = plan.maxOutflow[keyHash] ?? 0n;
    const who = `the ${ring.roleOf(keyHash)} wallet ${keyHash}`;
    if (leave > limit) problems.push(`${who}: ${units(leave)} leave it, over the limit of ${units(limit)}`);
    else lines.push(`${who}: ${units(leave)} leave it, the limit is ${units(limit)}`);
    const owned = new Set(held.flatMap((utxo) => Object.keys(utxo.assets).filter((unit) => unit !== 'lovelace')));
    for (const unit of owned) {
      const left = sum(held.map((utxo) => utxo.assets[unit] ?? 0n)) - sum(back.map((output) => output.assets[unit] ?? 0n));
      if (left > 0n) problems.push(`${who}: ${left} of the asset ${unit} leave it`);
    }
  }
  if (problems.length > 0) return fail('outflow', problems.join('; '));
  return pass('outflow', lines.join('; ') || 'no wallet of the keys is spent');
}

function collateralGuard({ facts, plan, ring }: GuardInput, spending: Spending): GuardResult {
  if (!facts.runsScripts) return pass('collateral', 'no script runs, so no collateral is at risk');
  if (spending.collateral.length === 0) return fail('collateral', 'a script runs and the transaction has no collateral input');
  const problems: string[] = [];
  const lines: string[] = [];
  for (const [keyHash, address] of spending.wallets) {
    const taken = sum(spending.collateral.map(({ utxo }) => (utxo !== undefined && keyCredentialOf(utxo.address) === keyHash ? (utxo.assets.lovelace ?? 0n) : 0n)));
    if (taken === 0n) continue;
    const returned = facts.collateralReturn !== null && facts.collateralReturn.address === address ? facts.collateralReturn.lovelace : 0n;
    const loss = taken > returned ? taken - returned : 0n;
    const who = `the ${ring.roleOf(keyHash)} wallet ${keyHash}`;
    if (loss > plan.maxCollateralLossLovelace) problems.push(`${who}: a script that fails takes ${units(loss)} of its collateral, over the limit of ${units(plan.maxCollateralLossLovelace)}`);
    else lines.push(`${who}: a script that fails takes ${units(loss)} of its collateral, the limit is ${units(plan.maxCollateralLossLovelace)}`);
  }
  if (problems.length > 0) return fail('collateral', problems.join('; '));
  return pass('collateral', lines.join('; '));
}

function mintGuard({ facts, plan }: GuardInput): GuardResult {
  const units_ = new Set([...Object.keys(facts.mint), ...Object.keys(plan.mint)]);
  const wrong = [...units_].filter((unit) => (facts.mint[unit] ?? 0n) !== (plan.mint[unit] ?? 0n));
  if (wrong.length > 0) return fail('mint', `the transaction mints ${wrong.map((unit) => `${facts.mint[unit] ?? 0n} of ${unit}`).join(', ')}, and the step says ${wrong.map((unit) => String(plan.mint[unit] ?? 0n)).join(', ')}`);
  return pass('mint', units_.size === 0 ? 'nothing is minted or burned' : `the transaction mints and burns what the step says: ${[...units_].map((unit) => `${plan.mint[unit]} of ${unit}`).join(', ')}`);
}

function nothingElseGuard({ facts, plan }: GuardInput): GuardResult {
  const named = plan.withdrawals ?? 0;
  const step = named === 0 ? 'none' : `${named} withdrawal(s) and no certificate`;
  if (facts.withdrawals !== named || facts.certificates > 0) return fail('nothing_else', `the transaction has ${facts.withdrawals} withdrawal(s) and ${facts.certificates} certificate(s), and the step has ${step}`);
  return pass('nothing_else', named === 0 ? 'no withdrawal and no certificate' : `${named} withdrawal(s), as the step says, and no certificate`);
}

function vaultGuard({ facts, plan }: GuardInput, spending: Spending): GuardResult {
  const { vault } = plan;
  if (vault === undefined) return pass('vault', 'the step pays from no vault');
  const escrows = facts.outputs.filter((output) => output.address === vault.escrowAddress);
  if (escrows.length === 0) return pass('vault', 'the transaction pays no escrow');
  if (escrows.length > 1) return fail('vault', `the transaction pays ${escrows.length} escrows, and a payment pays one`);
  const lock = escrows[0]!.lovelace;
  if (lock > vault.perTx) return fail('vault', `the payment is ${units(lock)}, over the limit per payment of ${units(vault.perTx)}`);
  const kept = facts.outputs.filter((output) => output.address === vault.address);
  if (kept.length !== 1 || kept[0]!.inlineDatum === null) return fail('vault', 'the transaction has not exactly one vault output with an inline datum');
  let spent: bigint;
  try {
    const datum = decodeVaultDatum(kept[0]!.inlineDatum);
    if (datum.type !== 'Live') throw new Error('not Live');
    spent = datum.spent;
  } catch {
    return fail('vault', 'the vault output has no datum of a Live vault that can be read');
  }
  if (spent > vault.total) return fail('vault', `the vault says that ${units(spent)} are spent in the period, over the limit total of ${units(vault.total)}`);
  const held = sum(spending.spent.map(({ utxo }) => (utxo !== undefined && utxo.address === vault.address ? (utxo.assets.lovelace ?? 0n) : 0n)));
  const leaves = held - kept[0]!.lovelace;
  if (leaves !== lock) return fail('vault', `${units(leaves)} leaves the vault, and the escrow holds ${units(lock)}`);
  return pass('vault', `the payment is ${units(lock)} (limit per payment ${units(vault.perTx)}), and ${units(spent)} are spent in the period (limit total ${units(vault.total)})`);
}

/** Runs every guard. Each gives one result, in a fixed order. */
export function runGuards(input: GuardInput): GuardResult[] {
  const found = new Map(input.inputs.map((utxo) => [refOf(utxo), utxo]));
  const entries = (refs: readonly string[]) => refs.map((ref) => ({ ref, utxo: found.get(ref) }));
  const spending: Spending = { found, spent: entries(input.facts.inputs), collateral: entries(input.facts.collateralInputs), wallets: input.ring.wallets() };
  return [
    bodyGuard(input), feeGuard(input), signersGuard(input, spending), inputsGuard(input, spending), destinationsGuard(input, spending), outflowGuard(input, spending),
    collateralGuard(input, spending), mintGuard(input), nothingElseGuard(input), vaultGuard(input, spending),
  ];
}

/** The results that failed. */
export const failed = (results: readonly GuardResult[]): GuardResult[] => results.filter((result) => !result.ok);
