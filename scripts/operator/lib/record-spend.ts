import { join } from 'node:path';
// These codecs and the minimum-output calculation are not exported by the package entries.
import { ledgerMinLovelace } from '../../../packages/buyer-core/src/vendored/mcp/attestation-build.ts';
import { findConfigRecord, readRefScript } from '../../../packages/buyer-core/src/vendored/mcp/identity-deployment.ts';
import { terminal } from '../../../packages/buyer-core/src/vendored/mcp/identity-rules.ts';
import { koiosPostList } from '../../../packages/buyer-core/src/vendored/mcp/marketplace-indexer.ts';
import { readFrame } from '../../../packages/usecase-kit/src/cosign/layout.ts';
import { decodeIdentityDatum, decodeIdentitySpend, encodeIdentityDatum } from '../../../packages/vector-read/src/identity-codec.ts';
import type { IdentitySpend } from '../../../packages/vector-read/src/identity-codec.ts';
import { isCollateralOutput } from '../../checks/lib/collateral.ts';
import type { Utxo } from '../../checks/lib/platform.ts';
import type { StepPlan } from '../../checks/lib/guards.ts';
import { GuardRefusal } from '../../checks/lib/land.ts';
import { eventually } from '../../checks/lib/retry.ts';
import { PreconditionError } from '../../checks/lib/session.ts';
import type { TxFacts } from '../../checks/lib/txfacts.ts';
import { VerificationError, VERIFY_WINDOW } from '../../checks/lib/verify.ts';
import type { IrreversibleTag } from './approval.ts';
import { readLimited } from './build-record.ts';
import type { HostedBuild, LandHost, RecordFact, TaskSession } from './contract.ts';
import { readRunning, requireRuntimesFree, runtimesOf } from './free.ts';
import { landHosted } from './land-hosted.ts';
import { blake2b256Hex, decodeTransaction, effectiveStatus, findRecord, formatOutRef } from './platform.ts';
import type { RecordUtxo } from './platform.ts';
import { planOf } from './plan.ts';
import type { StepHandler } from './runner.ts';
import { holdsSecret } from './secrets.ts';

const ACTIONS = {
  vector_build_identity_end_subagents: 'BumpEpoch',
  vector_build_identity_revoke: 'Revoke',
  vector_build_identity_reclaim: 'Reclaim',
  vector_build_identity_change_controller: 'ChangeController',
  vector_build_identity_recovery_start: 'RecoverInit',
  vector_build_identity_recovery_complete: 'RecoverFinalize',
  vector_build_identity_retire: 'Retire',
  vector_build_identity_set_successor: 'SetSuccessor',
} as const satisfies Record<string, IdentitySpend['type']>;
const STATUSES = ['Active', 'Suspended', 'Revoked', 'Retired'] as const;
const IDENTIFIER = /^[0-9a-f]{64}$/;
const OUTPUT_REF = /^[0-9a-f]{64}#(?:0|[1-9][0-9]{0,9})$/;
// The identity builder uses a script reference and one spend redeemer. Only the collateral return, total collateral and action signers are optional.
const BODY_REQUIRED = [0, 1, 2, 3, 8, 11, 13, 18];
const BODY_OPTIONAL = [14, 16, 17];
const PROTOCOL_PARAMETERS = 'queryLedgerState/protocolParameters';
const TX_INFO_LIMIT_BYTES = 512 * 1024;

type RecordReader = Pick<TaskSession, 'chain'>;

export async function readRecord(session: RecordReader, id: string): Promise<RecordUtxo> {
  const found = await findRecord(session.chain.provider, session.chain.deployment, id);
  if (found === null) throw new PreconditionError(`The record of did:vector:${id} is not on the node.`);
  return found;
}

/** Gives the first matching node result. A missing output is not a match. */
export async function awaitRecord(
  session: RecordReader & Pick<TaskSession, 'clock'>, id: string, predicate: (record: RecordUtxo) => boolean | Promise<boolean>,
  { windowMs = VERIFY_WINDOW.windowMs, pauseMs = VERIFY_WINDOW.pauseMs }: { windowMs?: number; pauseMs?: number } = {},
): Promise<RecordUtxo | null> {
  if (!Number.isSafeInteger(windowMs) || windowMs < 0 || !Number.isSafeInteger(pauseMs) || pauseMs < 1) throw new RangeError('Invalid record verification window.');
  const { clock, chain } = session;
  const deadline = clock.now() + windowMs;
  const boundedClock = { now: () => clock.now(), sleep: (ms: number) => clock.sleep(Math.min(ms, Math.max(0, deadline - clock.now()))) };
  const result = await eventually(boundedClock, { windowMs, pauseMs }, async () => {
    const found = await findRecord(chain.provider, chain.deployment, id);
    return { done: found !== null && await predicate(found) && clock.now() <= deadline, value: found };
  });
  return result.done ? result.value : null;
}

export function recordSpendPlan(
  session: Pick<LandHost, 'chain' | 'registry' | 'settings'>, { recordRef, extra }: { recordRef: string; extra?: { labels?: Readonly<Record<string, string>> } },
): StepPlan {
  return planOf(session, {
    destinations: [session.chain.deployment.identity.address], mint: {}, withdrawals: 0, explained: [recordRef],
    outflow: { fee: session.settings.maxFeeLovelace }, labels: extra?.labels,
  });
}

/** Identifies an enrolled record by its name in the data, not by its current output. */
export function recordFact(session: Pick<TaskSession, 'facts'>, name: string): RecordFact {
  const records = session.facts.read().records;
  const fact = records[name];
  if (fact === undefined) throw new PreconditionError(`The facts hold no record for ${name}. Register it first.`);
  if (!IDENTIFIER.test(fact.id) || fact.did !== `did:vector:${fact.id}` || Object.entries(records).some(([other, value]) => other !== name && value.id === fact.id)) {
    throw new PreconditionError(`The record fact for ${name} does not identify one DID.`);
  }
  return fact;
}

export interface RecordSpendBefore {
  readonly effective: (typeof STATUSES)[number];
  readonly subagentEpoch: number;
  readonly lovelace: string;
  readonly nowMs: number;
}

export interface VerifiedRecordSpend {
  readonly txHash: string;
  /** The time confirmation was first recorded. Use the datum for a time that the ledger fixes. */
  readonly at: string;
  readonly before: RecordSpendBefore;
  readonly record: RecordUtxo;
}

export interface RecordSpendSpec<Extra = unknown> {
  readonly step: string;
  readonly agentId: string;
  readonly tool: keyof typeof ACTIONS;
  readonly expectSigners: readonly string[];
  readonly irreversible?: IrreversibleTag;
  args(session: TaskSession<Extra>, record: RecordUtxo): Record<string, unknown>;
  before(record: RecordUtxo, session: TaskSession<Extra>): void | Promise<void>;
  after(record: RecordUtxo, session: TaskSession<Extra>, before: RecordSpendBefore): readonly string[] | Promise<readonly string[]>;
  /** Check the decoded unsigned output. Give a public reason to refuse it, or null. */
  checkBuild?(before: RecordUtxo, after: RecordUtxo, details: { action: IdentitySpend; validFrom: number; validTo: number }, session: TaskSession<Extra>): string | null;
  facts?(session: TaskSession<Extra>, landed: VerifiedRecordSpend): void;
  evidence?(session: TaskSession<Extra>, before: RecordSpendBefore, after: RecordUtxo): Record<string, unknown> | Promise<Record<string, unknown>>;
}

const refOf = ({ utxo }: RecordUtxo): string => formatOutRef(utxo.txHash, utxo.outputIndex);
const utxoRef = (utxo: Utxo): string => formatOutRef(utxo.txHash, utxo.outputIndex);
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

function refuseSpend(step: string, message: string): never {
  throw new GuardRefusal(step, [{ guard: 'body', ok: false, message }]);
}

function exactMembers(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && new Set(actual).size === actual.length && actual.every((item) => expected.includes(item));
}

/** Check the raw field keys as well as the decoded bytes. No unrelated ledger action is part of a record spend. */
function recordSpendBody(step: string, build: HostedBuild, facts: TxFacts, authorities: readonly string[]) {
  const bytes = Buffer.from(build.unsignedCbor, 'hex');
  const frame = readFrame(bytes);
  if (!frame) return refuseSpend(step, 'The unsigned record spend has no complete transaction frame.');
  if (!frame.isValid) return refuseSpend(step, 'The unsigned record spend is marked invalid.');
  const keys = frame.body.entries.map(({ key }) => key);
  if (!frame.auxiliaryIsNull || keys.some((key) => !BODY_REQUIRED.includes(key) && !BODY_OPTIONAL.includes(key))
    || BODY_REQUIRED.some((key) => !keys.includes(key))) {
    return refuseSpend(step, 'The transaction body is not in the supported form for a record spend.');
  }
  if (frame.witnesses.entries.some(({ key }) => key !== 0 && key !== 5) || facts.witnesses.length !== 0) {
    return refuseSpend(step, 'The unsigned record spend must have only the witnesses for its spend redeemer.');
  }
  const transaction = decodeTransaction(build.unsignedCbor);
  if (!transaction.is_valid() || transaction.to_cbor_hex() !== build.unsignedCbor
    || bytes.toString('hex', frame.body.head.start, frame.body.end) !== facts.bodyHex) {
    return refuseSpend(step, 'The decoder does not preserve the checked record-spend transaction.');
  }
  if (!exactMembers(facts.requiredSigners, authorities)) refuseSpend(step, 'The body does not require exactly the keys that authorize the record action.');
  return transaction;
}

function snapshot(record: RecordUtxo, nowMs: number): RecordSpendBefore {
  return { effective: effectiveStatus(record.record, new Map(), nowMs, nowMs), subagentEpoch: record.record.subagentEpoch, lovelace: String(record.utxo.assets.lovelace), nowMs };
}

function isSnapshot(value: unknown): value is RecordSpendBefore {
  if (typeof value !== 'object' || value === null || !('effective' in value) || !('subagentEpoch' in value) || !('lovelace' in value) || !('nowMs' in value)) return false;
  return STATUSES.some((status) => status === value.effective) && typeof value.subagentEpoch === 'number' && Number.isSafeInteger(value.subagentEpoch) && value.subagentEpoch >= 0
    && typeof value.lovelace === 'string' && /^\d+$/.test(value.lovelace) && Number.isSafeInteger(value.nowMs);
}

function datumHashOf(record: RecordUtxo['record']): string {
  return blake2b256Hex(Buffer.from(encodeIdentityDatum(record), 'hex'));
}

function checkOutput(
  step: string, before: RecordUtxo, build: HostedBuild, facts: TxFacts,
  wanted: { action: IdentitySpend['type']; address: string; unit: string; fee: string; minimum: bigint | null; authorities: readonly string[] },
) {
  const refuse = (message: string): never => refuseSpend(step, message);
  const transaction = recordSpendBody(step, build, facts, wanted.authorities);
  const ref = refOf(before);
  if (!facts.inputs.includes(ref) || facts.collateralInputs.includes(ref)) refuse('The transaction does not spend the selected record as a regular input.');
  const outputs = facts.outputs.filter(({ address }) => address === wanted.address);
  if (outputs.length !== 1) refuse('A record spend must make exactly one output at the identity address.');
  const output = outputs[0]!;
  if (output.inlineDatum === null || output.hasScriptRef || output.assets[wanted.unit] !== 1n || Object.keys(output.assets).length !== 1) {
    return refuse('The record output does not hold only the selected identity token and an inline datum.');
  }
  if (facts.outputs.some((item) => item !== output && (item.address !== wanted.fee || item.inlineDatum !== null || item.datumHash !== null || item.hasScriptRef))
    || (facts.collateralReturn !== null && facts.collateralReturn.address !== wanted.fee)) {
    refuse('Payments outside the record output must return to the fee wallet.');
  }
  const record = decodeIdentityDatum(output.inlineDatum);
  if (record.lineage.type !== 'Root') refuse('The output of the selected root record is not a root record.');
  if (wanted.minimum === null) {
    if (output.lovelace < before.utxo.assets.lovelace) refuse('The record spend must keep its deposit.');
  } else if (output.lovelace !== wanted.minimum || datumHashOf(record) !== datumHashOf(before.record)) {
    refuse('A reclaim must keep the tombstone unchanged at the ledger minimum.');
  }
  const collateralReturn = transaction.body().collateral_return();
  if (collateralReturn !== undefined && (collateralReturn.datum() !== undefined || collateralReturn.script_ref() !== undefined
    || collateralReturn.amount().multi_asset().policy_count() !== 0)) refuse('The collateral return must contain only lovelace at the fee wallet.');
  const redeemers = transaction.witness_set().redeemers()?.to_flat_format();
  if (redeemers === undefined || redeemers.len() !== 1) return refuse('A record spend must have one spend redeemer.');
  const redeemer = redeemers.get(0);
  // A spend index counts the normal inputs that precede the record by hash and output index.
  const index = facts.inputs.filter((input) => {
    const hash = input.slice(0, 64);
    return hash < before.utxo.txHash || (hash === before.utxo.txHash && Number(input.slice(65)) < before.utxo.outputIndex);
  }).length;
  if (redeemer.tag() !== 0 || redeemer.index() !== BigInt(index)) refuse('The selected record has no spend redeemer.');
  const action = decodeIdentitySpend(redeemer.data().to_cbor_hex());
  if (action.type !== wanted.action) refuse(`The record spend is not ${wanted.action}.`);
  const start = transaction.body().validity_interval_start();
  const end = facts.validityEndSlot;
  if (start === undefined || end === null || end <= start || end - start > 3_600n || build.validTo % 1_000 !== 0) {
    return refuse('The record spend has no valid time window.');
  }
  const found: RecordUtxo = { id: before.id, record, utxo: {
    txHash: facts.txHash, outputIndex: output.index, address: output.address, assets: { lovelace: output.lovelace, ...output.assets }, datum: output.inlineDatum,
  } };
  return { found, action, validFrom: build.validTo - Number(end - start) * 1_000, validTo: build.validTo };
}

async function checkReferences(
  session: RecordReader, step: string, before: RecordUtxo, after: RecordUtxo, action: IdentitySpend['type'], references: readonly string[],
): Promise<void> {
  const { provider, deployment } = session.chain;
  try {
    const required = [utxoRef(await readRefScript(provider, deployment, 'identity', deployment.identity.hash))];
    if (before.record.parties.some(({ signer }) => signer.type === 'Script') || after.record.parties.some(({ signer }) => signer.type === 'Script')) {
      const config = await findConfigRecord(provider, deployment);
      if (config === null) return refuseSpend(step, 'The Module-1 configuration record is not on the node.');
      required.push(utxoRef(config.utxo));
    }
    if (action === 'SetSuccessor') {
      const { status } = after.record;
      if ((status.type !== 'Revoked' && status.type !== 'Retired') || status.successor === null || status.successor === before.id) {
        return refuseSpend(step, 'The transaction does not name a successor record.');
      }
      const successor = await readRecord(session, status.successor);
      if (successor.record.lineage.type !== 'Root' || terminal(successor.record.status)) {
        return refuseSpend(step, 'The successor is not a live root record.');
      }
      required.push(refOf(successor));
    }
    if (!exactMembers(references, required)) refuseSpend(step, 'The transaction does not reference exactly the outputs that the record action needs.');
  } catch (err) {
    if (err instanceof GuardRefusal) throw err;
    refuseSpend(step, 'The required record-spend references could not be read on the node.');
  }
}

export interface RecordSpendValueRow {
  readonly ref: string;
  readonly address: string;
  readonly lovelace: bigint;
  readonly inline_datum?: unknown;
  readonly asset_list?: unknown;
}
export interface RecordSpendValueFlow {
  readonly fee: bigint;
  readonly inputs: readonly RecordSpendValueRow[];
  readonly outputs: readonly RecordSpendValueRow[];
}

/** The transaction fee and normal inputs and outputs. Reference inputs and collateral are not part of the payment. */
function valueSeal(flow: RecordSpendValueFlow): string {
  const ordered = (rows: readonly RecordSpendValueRow[]) => rows.map(({ ref, address, lovelace }) => `${ref} ${address} ${lovelace}`).sort();
  return blake2b256Hex(Buffer.from(JSON.stringify([String(flow.fee), ordered(flow.inputs), ordered(flow.outputs)])));
}

async function checkValue(
  session: Pick<LandHost, 'node'>, step: string, before: RecordUtxo, after: RecordUtxo, facts: TxFacts, unit: string, feeWallet: string, reclaim: boolean,
): Promise<RecordSpendValueFlow> {
  const refuse = (message: string): never => refuseSpend(step, message);
  const refs = [...new Set([...facts.inputs, ...facts.collateralInputs])];
  let held: Utxo[];
  try { held = await session.node.resolveInputs(refs); } catch { return refuse('The node could not read the record-spend inputs.'); }
  if (!exactMembers(held.map(utxoRef), refs) || new Set(facts.inputs).size !== facts.inputs.length
    || new Set(facts.collateralInputs).size !== facts.collateralInputs.length || facts.collateralInputs.length === 0) {
    return refuse('The node does not show each distinct input of the record spend.');
  }
  const inputs = new Map(held.map((utxo) => [utxoRef(utxo), utxo]));
  const recordRef = refOf(before);
  const original = inputs.get(recordRef)!;
  if (original.address !== before.utxo.address || original.assets.lovelace !== before.utxo.assets.lovelace
    || original.datum !== before.utxo.datum || original.scriptRef != null || original.assets[unit] !== 1n || Object.keys(original.assets).length !== 2) {
    return refuse('The input on the node is not the selected record, with its deposit and only its identity token.');
  }
  let collateral = 0n;
  for (const ref of facts.collateralInputs) {
    const utxo = inputs.get(ref)!;
    if (utxo.address !== feeWallet || utxo.datum != null || utxo.datumHash != null || utxo.scriptRef != null
      || Object.keys(utxo.assets).length !== 1 || !(utxo.assets.lovelace > 0n)) {
      return refuse('The selected collateral is not a pure lovelace output of the exact fee wallet.');
    }
    collateral += utxo.assets.lovelace;
  }
  const loss = collateral - (facts.collateralReturn?.lovelace ?? 0n);
  if (loss <= 0n || (facts.totalCollateral !== null && loss !== facts.totalCollateral)) {
    return refuse('The collateral inputs and return do not match the declared collateral loss.');
  }

  const assetChanges = new Map<string, bigint>();
  const spent: RecordSpendValueRow[] = [];
  let feeIn = 0n;
  for (const ref of facts.inputs) {
    const { address, assets, datum, datumHash, scriptRef } = inputs.get(ref)!;
    const lovelace = assets.lovelace;
    if (typeof lovelace !== 'bigint' || lovelace <= 0n) return refuse('A record-spend input has no usable lovelace amount.');
    spent.push({ ref, address, lovelace });
    if (ref === recordRef) continue;
    if (address !== feeWallet || datum != null || datumHash != null || scriptRef != null) {
      return refuse('Every regular input except the record must be a payment output of the exact fee wallet.');
    }
    feeIn += lovelace;
    for (const [name, quantity] of Object.entries(assets)) if (name !== 'lovelace') assetChanges.set(name, (assetChanges.get(name) ?? 0n) - quantity);
  }
  const made: RecordSpendValueRow[] = [];
  let feeOut = 0n;
  for (const { address, index, lovelace, assets } of facts.outputs) {
    made.push({ ref: formatOutRef(facts.txHash, index), address, lovelace });
    if (address !== feeWallet) continue;
    feeOut += lovelace;
    for (const [name, quantity] of Object.entries(assets)) assetChanges.set(name, (assetChanges.get(name) ?? 0n) + quantity);
  }
  for (const change of assetChanges.values()) if (change !== 0n) return refuse('The transaction does not return all fee-wallet assets to that wallet.');
  const credit = feeOut - feeIn;
  const reduction = original.assets.lovelace - after.utxo.assets.lovelace;
  if (credit !== reduction - facts.feeLovelace) return refuse('The fee-wallet value change is not the record deposit change minus the actual fee.');
  if (reclaim && credit <= 0n) return refuse('The reclaim does not credit the fee wallet after the actual fee.');
  return { fee: facts.feeLovelace, inputs: spent, outputs: made };
}

function lovelaceOf(value: unknown): bigint | null {
  if (typeof value === 'string' && /^[0-9]{1,20}$/.test(value)) return BigInt(value);
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : null;
}

/** Read the value the node gives, before the provider can supply a default. */
async function reclaimCoefficient({ settings, fetchImpl }: Pick<TaskSession, 'settings' | 'fetchImpl'>): Promise<bigint> {
  let answer: unknown = null;
  try {
    const response = await fetchImpl(settings.urls.ogmios, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(15_000),
      body: JSON.stringify({ jsonrpc: '2.0', method: PROTOCOL_PARAMETERS, params: {}, id: 1 }),
    });
    if (response.ok) {
      const bytes = await readLimited(response, 512 * 1024);
      if (bytes !== null) answer = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    } else {
      await response.body?.cancel();
    }
  } catch {
    throw new PreconditionError('The node protocol parameters could not be read for reclaim.');
  }
  if (!isObject(answer) || answer.jsonrpc !== '2.0' || answer.id !== 1 || answer.error !== undefined || !isObject(answer.result)) {
    throw new PreconditionError('The node did not return a protocol-parameters result for reclaim.');
  }
  const { minUtxoDepositCoefficient, coinsPerUtxoByte } = answer.result;
  const coefficient = lovelaceOf(minUtxoDepositCoefficient ?? coinsPerUtxoByte);
  if (coefficient === null || coefficient <= 0n || coefficient > BigInt(Number.MAX_SAFE_INTEGER)
    || (minUtxoDepositCoefficient != null && coinsPerUtxoByte != null && lovelaceOf(coinsPerUtxoByte) !== coefficient)) {
    throw new PreconditionError('The node did not give one explicit positive minimum-output coefficient for reclaim.');
  }
  return coefficient;
}

function archivedRows(value: unknown, withDetails: boolean, txHash?: string): RecordSpendValueRow[] {
  if (!Array.isArray(value) || value.length === 0) throw new VerificationError('The confirmed transaction has no complete input and output lists.');
  const seen = new Set<string>();
  return value.map((item: unknown) => {
    if (!isObject(item)) throw new VerificationError('The confirmed transaction has an unreadable output reference.');
    const { tx_hash: origin, tx_index: index, payment_addr: payment } = item;
    const amount = lovelaceOf(item.value);
    const address = isObject(payment) ? payment.bech32 : null;
    if (typeof origin !== 'string' || !IDENTIFIER.test(origin) || (txHash !== undefined && origin !== txHash)
      || typeof index !== 'number' || !Number.isSafeInteger(index) || index < 0 || index > 0xffff_ffff || typeof address !== 'string' || address.length === 0 || amount === null || amount <= 0n) {
      throw new VerificationError('The confirmed transaction has an unreadable output reference, address or amount.');
    }
    const ref = formatOutRef(origin, index);
    if (seen.has(ref)) throw new VerificationError('The confirmed transaction lists the same output reference more than once.');
    seen.add(ref);
    return { ref, address, lovelace: amount, ...(withDetails ? { inline_datum: item.inline_datum, asset_list: item.asset_list } : {}) };
  });
}

/** Vector Koios can report phase-two validity only on the individual script rows. */
function confirmedPhaseTwo(row: Record<string, unknown>): boolean {
  const { valid_contract: verdict, plutus_contracts: scripts } = row;
  if (verdict !== undefined && verdict !== true) return false;
  if (scripts === undefined) return verdict === true;
  if (!Array.isArray(scripts) || scripts.some((script: unknown) => !isObject(script) || script.valid_contract !== true)) return false;
  return verdict === true || scripts.length > 0;
}

/** Read the fee, spent outputs and created outputs of one confirmed record spend. Details are raw fields for the caller to check. */
export async function readConfirmedRecordSpend(
  session: Pick<LandHost, 'chain' | 'node'>, txHash: string, { withDetails = false }: { withDetails?: boolean } = {},
): Promise<RecordSpendValueFlow> {
  if (!IDENTIFIER.test(txHash)) throw new VerificationError('The record spend has no usable transaction hash.');
  const { koiosUrl, fetchImpl } = session.chain;
  let rows: unknown[];
  let confirmations: number | null;
  try {
    const [answer, status] = await Promise.all([
      koiosPostList(koiosUrl, 'tx_info', { _tx_hashes: [txHash], _inputs: true, _scripts: true, ...(withDetails ? { _assets: true } : {}) }, fetchImpl, '', TX_INFO_LIMIT_BYTES),
      session.node.txStatus(txHash),
    ]);
    rows = answer;
    confirmations = status.confirmations;
  } catch {
    throw new VerificationError('The confirmed record spend could not be read from the indexer.');
  }
  const row = rows[0];
  if (rows.length !== 1 || !isObject(row) || row.tx_hash !== txHash
    || confirmations === null || !Number.isSafeInteger(confirmations) || confirmations < 1) {
    throw new VerificationError('The indexer does not confirm the exact record spend.');
  }
  if (!confirmedPhaseTwo(row)) throw new VerificationError('The confirmed record spend has no affirmative phase-two validity evidence.');
  const fee = lovelaceOf(row.fee);
  if (fee === null) throw new VerificationError('The confirmed record spend has no actual fee.');
  return { fee, inputs: archivedRows(row.inputs, withDetails), outputs: archivedRows(row.outputs, withDetails, txHash) };
}

/** Reconcile the payment after confirmation. The fee outputs do not need to be unspent. */
async function reclaimCredit(
  session: Pick<LandHost, 'chain' | 'node' | 'registry'>, txHash: string, recordBefore: string, beforeLovelace: bigint, after: RecordUtxo, seal: string,
): Promise<Record<string, unknown>> {
  const flow = await readConfirmedRecordSpend(session, txHash);
  const { fee } = flow;
  if (valueSeal(flow) !== seal) throw new VerificationError('The confirmed reclaim inputs, outputs or fee differ from the checked transaction.');
  const feeWallet = session.registry.addressOf('fee');
  const original = flow.inputs.find(({ ref }) => ref === recordBefore);
  const tombstone = flow.outputs.find(({ ref }) => ref === refOf(after));
  if (!original || !tombstone || original.address !== after.utxo.address || original.lovelace !== beforeLovelace
    || tombstone.address !== after.utxo.address || tombstone.lovelace !== after.utxo.assets.lovelace) {
    throw new VerificationError('The confirmed reclaim does not name the selected tombstone input and output.');
  }
  const feeWalletIn = flow.inputs.reduce((sum, item) => sum + (item.address === feeWallet ? item.lovelace : 0n), 0n);
  const feeWalletOut = flow.outputs.reduce((sum, item) => sum + (item.address === feeWallet ? item.lovelace : 0n), 0n);
  const released = original.lovelace - tombstone.lovelace;
  const credit = feeWalletOut - feeWalletIn;
  if (credit <= 0n || credit !== released - fee) throw new VerificationError('The confirmed reclaim does not credit the surplus minus the actual fee to the fee wallet.');
  return {
    receivedBy: 'fee', releasedLovelace: String(released), feeLovelace: String(fee), feeWalletInputLovelace: String(feeWalletIn),
    feeWalletOutputLovelace: String(feeWalletOut), feeWalletCreditLovelace: String(credit), valueSource: 'confirmed tx_info',
  };
}

/** Reads the resolver for evidence. It cannot confirm or refuse a spend. */
export async function resolverReading(session: Pick<TaskSession, 'hosted'>, did: string): Promise<Record<string, unknown>> {
  const message = (text: string): string => holdsSecret(text) || /[0-9a-f]{64,}|\b(?:authorization|token|password|api[_ -]?key)\b/i.test(text)
    ? 'The resolver message is not public.' : text.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 300);
  try {
    const answer = await session.hosted.call('vector_resolve_did', { did });
    if (answer.failed) return { read: 'failed', message: message(answer.message) };
    const metadata = answer.json?.didDocumentMetadata;
    const status = metadata !== null && typeof metadata === 'object' && 'vectorStatus' in metadata ? metadata.vectorStatus : null;
    const effective = status !== null && typeof status === 'object' && 'effective' in status ? status.effective : null;
    const deactivated = metadata !== null && typeof metadata === 'object' && 'deactivated' in metadata ? metadata.deactivated : null;
    return { read: 'ok', effective: STATUSES.some((word) => typeof effective === 'string' && word.toLowerCase() === effective.toLowerCase()) ? effective : null,
      deactivated: typeof deactivated === 'boolean' ? deactivated : null };
  } catch (err) {
    return { read: 'unavailable', message: err instanceof Error ? message(err.message) : 'The resolver could not be read.' };
  }
}

/** The runner verifies a confirmed spend before another step can run. The saved output lets it resume without another build or signature. */
export function recordSpendStep<Extra>(spec: RecordSpendSpec<Extra>): StepHandler<Extra> {
  const { agentId, step, tool } = spec;
  const action = ACTIONS[tool];
  const reclaim = action === 'Reclaim';
  return {
    name: step,
    async run(session) {
      if (session.networkResult()?.ok !== true) throw new PreconditionError('The node did not pass the network guard.');
      if (session.state.snapshot().in_flight !== null) throw new PreconditionError('A transaction is in flight. Settle it before a record spend.');
      const agent = session.use.agents.find(({ id }) => id === agentId);
      if (agent === undefined) throw new PreconditionError(`The use case lists no agent ${agentId}.`);
      const fact = recordFact(session, agentId);
      const before = await readRecord(session, fact.id);
      if (before.record.lineage.type !== 'Root') throw new PreconditionError(`The record of ${agentId} is not a root record.`);
      await spec.before(before, session);
      const prior = snapshot(before, session.clock.now());
      const recordRef = refOf(before);
      const { address, hash } = session.chain.deployment.identity;
      const unit = `${hash}${fact.id}`;
      const fee = session.registry.addressOf('fee');
      const requireFree = () => requireRuntimesFree({
        fetchImpl: session.fetchImpl, runtimes: runtimesOf(agent), running: readRunning(join(session.settings.stateDir, 'running-images.json'), session.clock.now()), out: session.out,
      });
      await requireFree();
      let minimum: bigint | null = null;
      if (reclaim) {
        if (prior.effective !== 'Revoked' && prior.effective !== 'Retired') throw new PreconditionError('The record is not Revoked or Retired.');
        const coefficient = await reclaimCoefficient(session);
        const { lucid } = await session.chain.context(fee);
        if (lucid.config().protocolParameters?.coinsPerUtxoByte !== coefficient) {
          throw new PreconditionError('The wallet context does not use the node minimum-output coefficient for reclaim.');
        }
        minimum = ledgerMinLovelace(lucid, address, unit, encodeIdentityDatum(before.record));
        if (minimum >= before.utxo.assets.lovelace) throw new PreconditionError('The record has no deposit above the ledger minimum.');
      }
      if (!(await session.chain.provider.getUtxos(fee)).some(isCollateralOutput)) throw new PreconditionError('The fee wallet needs a pure collateral output of at least 5 units.');
      const notes = [`${step}: ${agentId} (${fact.did}); current status ${prior.effective}.`, `Expected signers: ${spec.expectSigners.join(', ')}.`];
      if (session.mode === 'dry') {
        for (const note of notes) session.out.out(note);
        session.out.out('No transaction was built.');
        return { kind: 'dry' };
      }
      let planned: RecordUtxo;
      let reclaimSeal: string | null = null;
      const authorities = spec.expectSigners.filter((name) => name !== 'fee').map((name) => session.registry.hashOf(name));
      const landed = await landHosted(session, {
        step, tool, args: { ...spec.args(session, before), changeAddress: fee, did: fact.did }, expectSigners: spec.expectSigners, irreversible: spec.irreversible, notes,
        beforeSign: async () => { await requireFree(); },
        plan: async (build, facts) => {
          try {
            const checked = checkOutput(step, before, build, facts, { action, address, unit, fee, minimum, authorities });
            const problem = spec.checkBuild?.(before, checked.found, checked, session);
            if (problem) refuseSpend(step, problem);
            planned = checked.found;
            await checkReferences(session, step, before, planned, action, facts.referenceInputs);
            const flow = await checkValue(session, step, before, planned, facts, unit, fee, reclaim);
            if (reclaim) reclaimSeal = valueSeal(flow);
          } catch (err) {
            if (err instanceof GuardRefusal) throw err;
            refuseSpend(step, 'The unsigned record spend could not be checked.');
          }
          return recordSpendPlan(session, { recordRef });
        },
        refs: () => ({ recordBefore: recordRef, recordAfter: refOf(planned) }),
        facts: () => ({
          agent: agentId, did: fact.did, before: prior, datumHash: datumHashOf(planned.record), keptLovelace: String(planned.utxo.assets.lovelace),
          ...(reclaimSeal === null ? {} : { reclaimSeal }),
        }),
      });
      return { kind: 'done', message: `${step} landed: ${landed.txHash}.` };
    },
    async verify(session, landed) {
      if (session.networkResult()?.ok !== true) throw new PreconditionError('The node did not pass the network guard.');
      const { did, id } = recordFact(session, agentId);
      const { agent, before, datumHash, keptLovelace, reclaimSeal } = landed.facts;
      const { recordBefore, recordAfter } = landed.refs;
      const txHash = landed.tx_hash;
      if (agent !== agentId || landed.facts.did !== did || !isSnapshot(before) || txHash === null || !IDENTIFIER.test(txHash)
        || typeof datumHash !== 'string' || !IDENTIFIER.test(datumHash) || typeof keptLovelace !== 'string' || !/^\d+$/.test(keptLovelace)
        || !recordBefore || !OUTPUT_REF.test(recordBefore) || !recordAfter || !OUTPUT_REF.test(recordAfter) || !recordAfter.startsWith(`${txHash}#`)
        || (reclaim && (typeof reclaimSeal !== 'string' || !IDENTIFIER.test(reclaimSeal)))) {
        throw new VerificationError(`The state of ${step} does not describe a spend of the record of ${agentId}.`);
      }
      let problems: readonly string[] = ['The node does not show the confirmed record output.'];
      const { address, hash } = session.chain.deployment.identity;
      const after = await awaitRecord(session, id, async (record) => {
        if (refOf(record) !== recordAfter) return false;
        if (record.utxo.address !== address || record.utxo.assets[`${hash}${id}`] !== 1n || Object.keys(record.utxo.assets).length !== 2
          || record.utxo.scriptRef != null || datumHashOf(record.record) !== datumHash || String(record.utxo.assets.lovelace) !== keptLovelace) {
          problems = ['The output on the node differs from the checked transaction.'];
          return false;
        }
        problems = await spec.after(record, session, before);
        return problems.length === 0;
      });
      if (after === null) throw new VerificationError(`${step}: ${problems.join(' ')} The step is not verified.`);
      const recorded = session.evidence.entries().some((entry) => entry.step === step && entry.status === 'verified' && isObject(entry.shows) && entry.shows.txHash === txHash);
      if (!recorded) {
        const credit = typeof reclaimSeal === 'string' && reclaim ? await reclaimCredit(session, txHash, recordBefore, BigInt(before.lovelace), after, reclaimSeal) : {};
        session.evidence.add({ step, status: 'verified', hosted: [], shows: {
          ...await spec.evidence?.(session, before, after), ...credit, agent: agentId, did, txHash, before, after: snapshot(after, session.clock.now()),
        } });
      }
      // A fact can let a dependent step spend this output. Write the verification evidence first.
      spec.facts?.(session, { txHash, at: landed.confirmed_at, before, record: after });
    },
  };
}
