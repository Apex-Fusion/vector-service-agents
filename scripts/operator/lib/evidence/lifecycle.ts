import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { decodeClaimDatum, paymentKeyHashOf, soleTokenName, utxoOfKoiosRow } from '../../../../packages/buyer-core/src/index.ts';
// The package entries do not export the ledger minimum, recovery rules or indexer transport.
import { didKeyOf, ledgerMinLovelace } from '../../../../packages/buyer-core/src/vendored/mcp/attestation-build.ts';
import { findConfigRecord, readRefScript } from '../../../../packages/buyer-core/src/vendored/mcp/identity-deployment.ts';
import { DAYS_7_MS, MAX_RANGE_MS, PURPOSE, activeKey, eligibleGuardian, tombstone } from '../../../../packages/buyer-core/src/vendored/mcp/identity-rules.ts';
import { WITHDRAW_CLAIM_REDEEMER } from '../../../../packages/buyer-core/src/vendored/mcp/jury-codec.ts';
import { blockfrostUrl } from '../../../../packages/buyer-core/src/vendored/mcp/jury-document.ts';
import { koiosCredentialUtxos, koiosPostList, koiosUtxoInfo } from '../../../../packages/buyer-core/src/vendored/mcp/marketplace-indexer.ts';
import { addressDetails } from '../../../../packages/vector-read/src/guarded-decode.ts';
import { decodeIdentityAdvertDatum, decodePlutusDataHex, encodePlutusDataHex } from '../../../../packages/vector-read/src/index.ts';
import type { PlutusData } from '../../../../packages/vector-read/src/identity.ts';
import { decodeIdentityDatum, encodeIdentityDatum, encodeIdentitySpend, utf8Hex } from '../../../../packages/vector-read/src/identity-codec.ts';
import type { IdentityDatum, IdentitySpend } from '../../../../packages/vector-read/src/identity-codec.ts';
import { EVIDENCE_FORMAT } from '../../../checks/lib/evidence.ts';
import { iso } from '../../../checks/lib/format.ts';
import type { Utxo } from '../../../checks/lib/platform.ts';
import { StateFile } from '../../../checks/lib/state.ts';
import type { CheckState, StepRecord } from '../../../checks/lib/state.ts';
import { readLimited } from '../build-record.ts';
import { proveAdvertRetirement, readConfirmedSpend, valueSeal } from '../confirmed-spend.ts';
import type { KoiosPlutusData, RecordSpendDatum, RecordSpendValueFlow, RecordSpendValueRow } from '../confirmed-spend.ts';
import type { AgentSpec, ClaimFact, LifecycleSpec, RecordFact } from '../contract.ts';
import { blake2b256Hex, effectiveStatus, findRecord, formatOutRef, keyHashOf, module1FromManifest, readManifest } from '../platform.ts';
import type { RecordUtxo } from '../platform.ts';
import { publicManifestFile } from '../registry.ts';
import { readJsonFile } from '../run-record.ts';
import type { BidEvidencePart } from './bid-evaluation.ts';
import { isObject, ref, txOf } from './types.ts';
import type { Assembly, EvidenceReadSession, Obj, Shown } from './types.ts';

const CHANGE = 'change-controller';
const START = 'recovery-start';
const WAIT = 'recovery-wait';
const COMPLETE = 'recovery-complete';
const RETIRE = 'retire';
const SUCCESSOR = 'set-successor';
const RECLAIM = 'reclaim';
const ORDER = [CHANGE, START, WAIT, COMPLETE, RETIRE, SUCCESSOR, RECLAIM] as const;
const ACTIONS = [CHANGE, START, COMPLETE, RETIRE, SUCCESSOR, RECLAIM] as const;
type Action = (typeof ACTIONS)[number];
type Step = (typeof ORDER)[number];
const IDS = { [CHANGE]: 'l1-01', [START]: 'l1-02', [WAIT]: 'l1-03', [COMPLETE]: 'l1-04', [RETIRE]: 'l1-05', [SUCCESSOR]: 'l1-06', [RECLAIM]: 'l1-07' } as const;
const RESOLVE = 'vector_resolve_did';
const COMPLETE_TOOL = 'vector_build_identity_recovery_complete';
const MANIFEST_BASE = 'https://raw.githubusercontent.com/Apex-Fusion/vector-agent-modules';
const HASH = /^[0-9a-f]{64}$/;
const PKH = /^[0-9a-f]{56}$/;
const REF = /^[0-9a-f]{64}#(?:0|[1-9][0-9]{0,5})$/;
const BYTES = 512 * 1024;
const LIMIT = 32;

class Unproven extends Error {}
const need: (ok: unknown, why: string) => asserts ok = (ok, why) => { if (!ok) throw new Unproven(why); };
const hash = (value: unknown): value is string => typeof value === 'string' && HASH.test(value);
const outref = (value: unknown): value is string => typeof value === 'string' && REF.test(value);
const time = (value: unknown): number => typeof value === 'string' ? Date.parse(value) : NaN;
const refOf = ({ txHash, outputIndex }: Pick<Utxo, 'txHash' | 'outputIndex'>) => formatOutRef(txHash, outputIndex);
const rowRef = (row: { readonly tx_hash?: unknown; readonly tx_index?: unknown } | Obj): string =>
  typeof row.tx_index === 'number' ? `${row.tx_hash}#${row.tx_index}` : '';
const datumHash = (hex: string): string => blake2b256Hex(Buffer.from(hex, 'hex'));
const matches = (actual: readonly string[], expected: readonly string[]): boolean => actual.length === expected.length
  && new Set(actual).size === actual.length && expected.every((key) => actual.includes(key));
const confirmations = (value: unknown): boolean => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

interface PublicKey { readonly pub: string; readonly pkh: string; readonly address: string }
interface Position { readonly at: number; readonly slot: number; readonly index: number }
interface Window extends Position { readonly lo: number; readonly hi: number; readonly references: readonly string[] }
interface RecordOutput { readonly ref: string; readonly amount: bigint; readonly bytes: string; readonly record: IdentityDatum }
interface Checked {
  readonly before: RecordOutput; readonly after: RecordOutput; readonly tx: string; readonly window: Window;
  readonly fee: bigint; readonly credit: bigint; readonly action: IdentitySpend['type'];
}
interface AdvertCloseout {
  readonly advert_ref: string; readonly retirement_tx: string; readonly deposit_lovelace: string;
  readonly fee_lovelace: string; readonly supplier_credit_lovelace: string;
}
interface ClaimCloseout { readonly claim_ref: string; readonly terminal_tx: string; readonly outcome: 'withdrawn' | 'terminal_burn' }
interface Projection {
  readonly lifecycle: Obj; readonly resolutions: readonly Obj[];
}
interface Read {
  readonly steps: Partial<Record<Step, Shown>>;
  readonly projection: Projection | null;
}

/** Read only the configured public manifest. Never load the signing registry. */
function publicKeys(s: EvidenceReadSession): (name: string) => PublicKey {
  const why = 'public_manifest: the configured public keys are unavailable or invalid';
  const path = join(s.settings.keysDir, publicManifestFile(s.use.name));
  let value: unknown;
  try {
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const file = fstatSync(fd);
      need(file.isFile() && file.nlink === 1 && (file.mode & 0o022) === 0 && file.size > 0 && file.size <= 64 * 1024
        && (process.getuid === undefined || file.uid === process.getuid()), why);
      const bytes = Buffer.allocUnsafe(file.size + 1);
      let length = 0;
      for (let n; length < bytes.length && (n = readSync(fd, bytes, length, bytes.length - length, null)) > 0;) length += n;
      need(length === file.size, why);
      value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length))) as unknown;
    } finally { closeSync(fd); }
  } catch { throw new Unproven(why); }
  need(isObject(value) && value.use_case === s.use.name && value.network === s.settings.network.name && isObject(value.keys), why);
  const keys = value.keys;
  return (name) => {
    const spec = s.use.keys.find((key) => key.name === name);
    const key = Object.hasOwn(keys, name) ? keys[name] : undefined;
    need(spec && isObject(key) && key.scope === spec.scope && hash(key.public_key_hex) && typeof key.key_hash === 'string'
      && keyHashOf(key.public_key_hex) === key.key_hash && typeof key.address === 'string' && paymentKeyHashOf(key.address) === key.key_hash, why);
    return { pub: key.public_key_hex, pkh: key.key_hash, address: key.address };
  };
}

function stateOf(s: EvidenceReadSession, check: 'lifecycle' | 'advert', label?: string): CheckState {
  const why = `${check}.state: the matching verified producer state cannot be read`;
  let state: CheckState | null;
  const base = label === undefined ? check : `${check}.${label}`;
  const record = label === undefined ? s.use.name : `${s.use.name}:${label}`;
  try { state = StateFile.peek(join(s.settings.stateDir, `${base}.state.json`), { check, network: s.settings.network.name, record }); }
  catch { throw new Unproven(why); }
  need(state, why);
  return state;
}

async function boundedJson(response: Response, max: number, why: string): Promise<unknown> {
  if (!response.ok) {
    await response.body?.cancel();
    throw new Unproven(why);
  }
  const bytes = await readLimited(response, max);
  need(bytes !== null, why);
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
}

/** The ledger enforces the body's required signers. Fee input ownership is checked separately. */
async function requireSigners(s: EvidenceReadSession, tx: string, expected: readonly string[]): Promise<void> {
  const why = 'required_signers: the exact signer set cannot be proved';
  try {
    const response = await s.fetchImpl(`${blockfrostUrl()}/txs/${tx}/required_signers`, {
      headers: { accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(15_000),
    });
    need(!response.headers.has('link') && !response.headers.has('content-range'), why);
    const rows = await boundedJson(response, 16 * 1024, why);
    need(Array.isArray(rows) && rows.length === expected.length, why);
    const actual = rows.map((row: unknown) => {
      need(isObject(row) && (row.tx_hash === undefined || row.tx_hash === tx) && typeof row.witness_hash === 'string' && PKH.test(row.witness_hash), why);
      return row.witness_hash;
    });
    need(matches(actual, expected), why);
  } catch { throw new Unproven(why); }
}

function whole(value: unknown, why: string): number {
  const n = typeof value === 'string' && /^\d{1,16}$/.test(value) ? Number(value) : value;
  need(typeof n === 'number' && Number.isSafeInteger(n) && n >= 0, why);
  return n;
}

async function txRow(s: EvidenceReadSession, tx: string): Promise<Obj> {
  const why = 'transaction: the exact ledger position and validity fields cannot be read';
  try {
    const rows = await koiosPostList(s.chain.koiosUrl, 'tx_info', { _tx_hashes: [tx], _inputs: true, _assets: true, _scripts: true }, s.chain.fetchImpl, '', BYTES);
    const row = rows[0];
    need(rows.length === 1 && isObject(row) && row.tx_hash === tx, why);
    return row;
  } catch { throw new Unproven(why); }
}

function position(row: Obj, systemStart: number): Position {
  const why = 'block_time: the ledger does not give a consistent transaction position';
  const slot = whole(row.absolute_slot, why), index = whole(row.tx_block_index, why), at = whole(row.tx_timestamp, why) * 1_000;
  need(Number.isSafeInteger(at) && at === systemStart + slot * 1_000, why);
  return { slot, index, at };
}
const precedes = (a: Position, b: Position): boolean => a.slot < b.slot || (a.slot === b.slot && a.index < b.index);

function window(row: Obj, systemStart: number): Window {
  const why = 'validity: the block is not within a complete permitted transaction window';
  const at = position(row, systemStart);
  const start = whole(row.invalid_before, why), end = whole(row.invalid_after, why);
  const lo = systemStart + start * 1_000, hi = systemStart + end * 1_000;
  need(start <= at.slot && at.slot < end && hi - lo <= MAX_RANGE_MS && Number.isSafeInteger(hi), why);
  const refs = row.reference_inputs;
  need(Array.isArray(refs) && refs.length <= LIMIT && refs.every(isObject), 'reference_inputs: the complete references cannot be read');
  const references = refs.map(rowRef);
  need(references.every(outref) && new Set(references).size === references.length, 'reference_inputs: the references are invalid or ambiguous');
  return { ...at, lo, hi, references };
}

/** Use the deployed script and sealed configuration readers that the record-spend producer uses. */
function referenceCheck(s: EvidenceReadSession) {
  const { provider, deployment } = s.chain;
  let identity: string | undefined;
  let config: string | undefined;
  return async (before: IdentityDatum, after: IdentityDatum, actual: readonly string[], successor?: string): Promise<void> => {
    try {
      identity ??= refOf(await readRefScript(provider, deployment, 'identity', deployment.identity.hash));
    } catch { throw new Unproven('reference_inputs: the deployed identity script cannot be authenticated on the node'); }
    const required = [identity];
    if (before.parties.some(({ signer }) => signer.type === 'Script') || after.parties.some(({ signer }) => signer.type === 'Script')) {
      if (config === undefined) {
        const sealed = await findConfigRecord(provider, deployment).catch(() => null);
        need(sealed, 'reference_inputs: the sealed Module-1 configuration cannot be authenticated on the node');
        config = refOf(sealed.utxo);
      }
      required.push(config);
    }
    if (successor !== undefined) required.push(successor);
    need(matches(actual, required), 'reference_inputs: the spend does not reference exactly the outputs that this record action needs');
  };
}

function witnessMatches(witness: RecordSpendDatum, expected: string): boolean {
  // Both forms can be present. Compare the structured value without assuming its bytes.
  const canonical = encodePlutusDataHex(decodePlutusDataHex(expected));
  if (witness.bytes == null && witness.value == null) return witness.hash === datumHash(expected);
  return (witness.bytes == null || encodePlutusDataHex(decodePlutusDataHex(witness.bytes)) === canonical)
    && (witness.value == null || encodePlutusDataHex(plutusOf(witness.value)) === canonical)
    && (witness.hash == null || witness.hash === datumHash(witness.bytes ?? expected));
}

function plutusOf(value: KoiosPlutusData): PlutusData {
  if ('int' in value) return { kind: 'int', value: BigInt(value.int) };
  if ('bytes' in value) return { kind: 'bytes', hex: value.bytes };
  if ('list' in value) return { kind: 'list', items: value.list.map(plutusOf) };
  if ('map' in value) return { kind: 'map', entries: value.map.map(({ k, v }) => [plutusOf(k), plutusOf(v)]) };
  return { kind: 'constr', index: BigInt(value.constructor), fields: value.fields.map(plutusOf) };
}

async function spendFlow(s: EvidenceReadSession, tx: string, why: string): Promise<RecordSpendValueFlow> {
  try { return await readConfirmedSpend(s, tx, { withDetails: true }); }
  catch { throw new Unproven(why); }
}

async function archived(s: EvidenceReadSession, ref: string, spent: boolean): Promise<Utxo> {
  const why = 'record_ref: the exact archived output and its inline datum cannot be verified';
  const rows = await koiosUtxoInfo(s.chain.koiosUrl, [ref], s.chain.fetchImpl, BYTES);
  const row = rows[0];
  const output = row === undefined ? null : utxoOfKoiosRow(row);
  need(rows.length === 1 && row?.is_spent === spent && output && refOf(output) === ref && typeof output.datum === 'string'
    && output.scriptRef == null && row.reference_script == null && Array.isArray(row.asset_list) && output.assets.lovelace > 0n
    && (row.payment_cred == null || row.payment_cred === addressDetails(output.address).paymentCredential?.hash)
    && (row.datum_hash == null || row.datum_hash === datumHash(output.datum)), why);
  return output;
}

function recordOutput(s: EvidenceReadSession, id: string, output: Utxo): RecordOutput {
  const { address, hash: policy } = s.chain.deployment.identity;
  need(output.address === address && output.assets[`${policy}${id}`] === 1n && Object.keys(output.assets).length === 2
    && typeof output.datum === 'string' && output.scriptRef == null && output.assets.lovelace > 0n, 'record_ref: the output is not the exact identity token and inline datum');
  const record = decodeIdentityDatum(output.datum);
  need(record.lineage.type === 'Root', 'record_ref: the identity is not a root record');
  return { ref: refOf(output), amount: output.assets.lovelace, bytes: output.datum, record };
}

function projectedDatumMatches(row: RecordSpendValueRow, bytes: string): boolean {
  const datum = row.inline_datum;
  const claimed = row.datum_hash ?? datum?.hash;
  return (claimed == null || claimed === datumHash(bytes)) && (datum?.bytes == null || datum.bytes === bytes)
    && (datum?.value == null || encodePlutusDataHex(plutusOf(datum.value)) === encodePlutusDataHex(decodePlutusDataHex(bytes)));
}

function rowMatches(s: EvidenceReadSession, id: string, row: RecordSpendValueRow | undefined, output: RecordOutput): boolean {
  const assets = row?.asset_list;
  return row?.ref === output.ref && row.address === s.chain.deployment.identity.address && row.lovelace === output.amount
    && assets?.length === 1 && assets[0]!.policy_id === s.chain.deployment.identity.hash && assets[0]!.asset_name === id && assets[0]!.quantity === '1'
    && projectedDatumMatches(row, output.bytes);
}

function feeCredit(flow: RecordSpendValueFlow, before: RecordOutput, after: RecordOutput, fee: string): bigint {
  const incoming = flow.inputs.filter((row) => row.ref !== before.ref);
  const outgoing = flow.outputs.filter((row) => row.ref !== after.ref);
  const assets = new Map<string, bigint>();
  let credit = 0n;
  for (const [rows, factor] of [[incoming, -1n], [outgoing, 1n]] as const) {
    for (const row of rows) {
      need(row.address === fee && row.inline_datum == null && row.datum_hash == null && Array.isArray(row.asset_list), 'fee: a payment is not a checked fee wallet output');
      credit += row.lovelace * factor;
      for (const { policy_id, asset_name, quantity } of row.asset_list) {
        const unit = policy_id + asset_name;
        assets.set(unit, (assets.get(unit) ?? 0n) + BigInt(quantity) * factor);
      }
    }
  }
  need([...assets.values()].every((change) => change === 0n) && flow.fee > 0n
    && credit === before.amount - after.amount - flow.fee, 'fee: the fee wallet change does not match the deposit and actual fee');
  return credit;
}

/** Successful script spends do not consume collateral, but the ledger still verifies its wallet key. */
async function requireFeeCollateral(s: EvidenceReadSession, row: Obj, fee: string): Promise<void> {
  const why = 'fee: the wallet did not supply the exact pure collateral inputs';
  const entries = row.collateral_inputs;
  need(Array.isArray(entries) && entries.length > 0 && entries.length <= 3 && entries.every(isObject), why);
  const refs = entries.map(rowRef);
  need(refs.every(outref) && new Set(refs).size === refs.length, why);
  const found = await koiosUtxoInfo(s.chain.koiosUrl, refs, s.chain.fetchImpl, BYTES);
  need(matches(found.map(rowRef), refs) && found.every((item) => item.address === fee && /^[0-9]{1,20}$/.test(item.value)
    && BigInt(item.value) > 0n && item.inline_datum == null && item.datum_hash == null && item.reference_script == null && item.asset_list?.length === 0), why);
}

function relatedFact(fact: RecordFact | undefined): RecordFact {
  need(fact && hash(fact.id) && fact.did === `did:vector:${fact.id}` && hash(fact.tx) && outref(fact.recordRef) && txOf(fact.recordRef) === fact.tx,
    'records: the registered identity and its exact reference are missing');
  return fact;
}

function savedStep(state: CheckState, step: Step): StepRecord {
  const saved = state.steps[step];
  need(saved && Number.isFinite(time(saved.verified_at)) && Number.isFinite(time(saved.confirmed_at)) && time(saved.verified_at) >= time(saved.confirmed_at),
    'lifecycle.state: the producer did not verify this step');
  return saved;
}

function requireEarlyRefusal(s: EvidenceReadSession, a: Assembly, state: CheckState, start: Checked, due: number): void {
  const why = 'refusals: the producer has no exact early tool refusal for this pending recovery';
  const checkpoint = state.notes.earlyRecoveryCompletion;
  need(isObject(checkpoint) && checkpoint.tx === start.tx && checkpoint.effectiveAfter === due, why);
  const refusals = a.loaded.record.refusals;
  const saved = refusals[0];
  const message = `The build tool refused recovery completion before ${iso(due)}. No transaction was signed.`;
  need(refusals.length === 1 && saved?.kind === 'tool' && saved.step === IDS[WAIT] && saved.message === message, why);
  let journal: unknown;
  try { journal = readJsonFile(join(s.settings.stateDir, `lifecycle.${a.loaded.record.label}.evidence.json`), 'the lifecycle producer evidence'); }
  catch { throw new Unproven(why); }
  need(isObject(journal) && journal.format === EVIDENCE_FORMAT && journal.check === state.check && journal.network === state.network
    && journal.record === state.record && Array.isArray(journal.entries), why);
  const candidates = journal.entries.filter((entry: unknown) => isObject(entry) && entry.step === WAIT && (entry.status === 'tool_refused' || entry.status === 'refused')) as Obj[];
  const entry = candidates[0];
  need(candidates.length === 1 && entry?.status === 'tool_refused' && entry.expected === true && entry.tool === COMPLETE_TOOL
    && entry.message === message && time(entry.at) >= time(state.steps[START]?.confirmed_at) && time(entry.at) >= start.window.at && time(entry.at) < due
    && !Object.hasOwn(entry, 'transaction_body') && !Object.hasOwn(entry, 'evaluation_error'), why);
}

async function currentRecord(s: EvidenceReadSession, fact: RecordFact): Promise<RecordUtxo> {
  const found = await findRecord(s.chain.provider, s.chain.deployment, fact.id);
  need(found, 'record_ref: the node does not show the identity record');
  return found;
}

async function proveResolutions(s: EvidenceReadSession, old: RecordFact, final: RecordOutput, successor: RecordFact, current: RecordOutput): Promise<readonly Obj[]> {
  const read = async (fact: RecordFact, record: RecordOutput, status: 'active' | 'retired') => {
    const why = `resolutions: the resolver does not show the exact ${status} record and its current output`;
    const answer = await s.hosted.call(RESOLVE, { did: fact.did });
    const meta = answer.json?.didDocumentMetadata;
    const resolution = answer.json?.didResolutionMetadata;
    const doc = answer.json?.didDocument;
    need(!answer.failed && isObject(resolution) && !Object.hasOwn(resolution, 'error') && isObject(meta) && meta.canonicalId === fact.did
      && isObject(meta.vectorLedger) && typeof meta.vectorLedger.outputIndex === 'number'
      && `${meta.vectorLedger.txId}#${meta.vectorLedger.outputIndex}` === record.ref && confirmations(meta.vectorLedger.confirmations)
      && isObject(meta.vectorStatus) && meta.vectorStatus.status === status && meta.vectorStatus.effective === status, why);
    if (status === 'retired') {
      need(doc === null && meta.deactivated === true && meta.vectorStatus.successor === successor.did
        && record.record.status.type === 'Retired' && time(meta.vectorStatus.at) === record.record.status.at, why);
      return { did: fact.did, status, deactivated: true, successor: successor.did };
    }
    need(isObject(doc) && doc.id === fact.did && meta.deactivated == null && meta.vectorParent == null && Array.isArray(doc.verificationMethod), why);
    const expected = new Map<string, string>();
    const pub = [record.record.controller, ...record.record.keys.map((key) => {
      need(key.keyType === 'Ed25519', 'resolutions: the successor uses an unconfigured verification key type');
      return key.key;
    })];
    for (const key of pub) expected.set(`${fact.did}#${keyHashOf(key)}`, didKeyOf(key).slice('did:key:'.length));
    need(doc.verificationMethod.length === expected.size, 'resolutions: the successor verification keys do not match the node');
    for (const method of doc.verificationMethod as unknown[]) {
      need(isObject(method) && typeof method.id === 'string' && method.controller === fact.did && method.type === 'Multikey'
        && typeof method.publicKeyMultibase === 'string' && expected.get(method.id) === method.publicKeyMultibase,
        'resolutions: the successor verification keys do not match the node');
      expected.delete(method.id);
    }
    return { did: fact.did, status, deactivated: false, verification_methods: doc.verificationMethod.length };
  };
  return Promise.all([read(old, final, 'retired'), read(successor, current, 'active')]);
}

async function explicitMinimum(s: EvidenceReadSession, fee: string, id: string, output: RecordOutput): Promise<bigint> {
  const why = 'ledger_minimum: the node did not give one explicit minimum-output coefficient';
  const [answer, { lucid }] = await Promise.all([
    (async () => boundedJson(await s.fetchImpl(s.settings.urls.ogmios, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(15_000),
      body: JSON.stringify({ jsonrpc: '2.0', method: 'queryLedgerState/protocolParameters', params: {}, id: 1 }),
    }), BYTES, why))(),
    s.chain.context(fee),
  ]);
  need(isObject(answer) && answer.jsonrpc === '2.0' && answer.id === 1 && answer.error === undefined && isObject(answer.result), why);
  const { minUtxoDepositCoefficient: modern, coinsPerUtxoByte: old } = answer.result;
  const coefficient = whole(modern ?? old, why);
  need(coefficient > 0 && (modern == null || old == null || whole(old, why) === coefficient)
    && lucid.config().protocolParameters?.coinsPerUtxoByte === BigInt(coefficient), why);
  const { address, hash: policy } = s.chain.deployment.identity;
  return ledgerMinLovelace(lucid, address, `${policy}${id}`, output.bytes);
}

async function liveFor(s: EvidenceReadSession, script: { address: string; hash: string }, reject: (output: Utxo) => boolean, assetPolicy?: string): Promise<void> {
  const why = 'closeout: the node still has a live or moved output of the retiring agent';
  for (const out of await s.chain.provider.getUtxos(script.address)) need(!reject(out), why);
  const rows = await koiosCredentialUtxos(s.chain.koiosUrl, script.hash, s.chain.fetchImpl, { assetPolicy, maxPageBytes: BYTES });
  const names = rows.map((row) => rowRef(row));
  need(names.every(outref), 'closeout: the script address scan did not return exact output references');
  for (let i = 0; i < names.length; i += 100) {
    const expected = new Set(names.slice(i, i + 100));
    for (const out of await s.node.resolveInputs([...expected])) {
      const cred = addressDetails(out.address).paymentCredential;
      need(cred?.type === 'Script' && cred.hash === script.hash && expected.delete(refOf(out)), 'closeout: the script address scan disagrees with the node');
      need(!reject(out), why);
    }
  }
}

async function advertsClosed(s: EvidenceReadSession, a: Assembly, agent: AgentSpec, owner: RecordFact, retire: Checked,
    keys: (name: string) => PublicKey, systemStart: number): Promise<readonly AdvertCloseout[]> {
  const script = s.chain.deployment.advert;
  const state = stateOf(s, 'advert');
  const facts = a.facts.adverts[agent.id] ?? {};
  need(agent.adverts.length > 0 && matches(Object.keys(facts), agent.adverts.map(({ model }) => model)), 'adverts: the facts do not name each exact posted advert');
  await liveFor(s, script, (out) => {
    try { return typeof out.datum === 'string' && decodeIdentityAdvertDatum(out.datum).agent_id === owner.id; }
    catch { return false; } // Anyone can lock an unrelated output at the payment script.
  });
  return Promise.all(agent.adverts.map(async (spec) => {
    const why = 'adverts: the exact RetireAdvert spend and supplier credit are not verified';
    const fact = facts[spec.model]!;
    const supplier = keys(spec.supplierKey);
    const saved = state.notes[`part.retire:${agent.id}:${spec.model}`];
    need(outref(fact.ref) && txOf(fact.ref) === fact.tx && !((await s.node.resolveInputs([fact.ref])).length)
      && isObject(saved) && hash(saved.tx_hash) && isObject(saved.refs) && saved.refs.retiredRef === fact.ref
      && Number.isFinite(time(saved.verified_at)) && isObject(saved.facts), why);
    const tx = saved.tx_hash;
    const [posted, flow, row] = await Promise.all([archived(s, fact.ref, true), spendFlow(s, tx, why), txRow(s, tx)]);
    const datum = decodeIdentityAdvertDatum(posted.datum!);
    const spent = flow.inputs.find((input) => input.ref === fact.ref);
    need(posted.address === script.address && posted.assets.lovelace === spec.depositLovelace && Object.keys(posted.assets).length === 1
      && datum.status === 'Active' && datum.agent_id === owner.id && datum.model === spec.model && datum.capability_id === agent.capability
      && datum.detail_uri === fact.detailUri && datum.detail_hash === fact.detailHash && datum.endpoint_url === fact.endpoint
      && datum.price_lovelace === spec.priceLovelace && datum.supplier_bond_lovelace === spec.supplierBondLovelace
      && datum.buyer_bond_lovelace === spec.buyerBondLovelace && datum.max_processing_ms === spec.windowMs && datum.max_output_tokens === spec.maxOutputTokens
      && datum.supplier_pkh === supplier.pkh && activeKey(retire.before.record, supplier.pkh, PURPOSE.transaction)
      && spent && projectedDatumMatches(spent, posted.datum!)
      && precedes(position(row, systemStart), retire.window), why);
    let credit: bigint;
    try {
      credit = proveAdvertRetirement(flow, { advertRef: fact.ref, advertAddress: script.address, advertScriptHash: script.hash,
        supplierAddress: supplier.address, depositLovelace: spec.depositLovelace });
    } catch { throw new Unproven(why); }
    await requireSigners(s, tx, [supplier.pkh]);
    const f = saved.facts;
    need(f.phase === 'retire' && f.agent === agent.id && f.model === spec.model && f.supplierPkh === supplier.pkh && f.supplierAddress === supplier.address
      && f.depositLovelace === String(spec.depositLovelace) && f.feeLovelace === String(flow.fee) && f.creditLovelace === String(credit)
      && f.valueSeal === valueSeal(flow) && typeof f.approvalSession === 'string' && f.approvalSession !== '', why);
    return { advert_ref: fact.ref, retirement_tx: tx, deposit_lovelace: String(spec.depositLovelace), fee_lovelace: String(flow.fee), supplier_credit_lovelace: String(credit) };
  }));
}

async function claimClosed(s: EvidenceReadSession, claim: ClaimFact, owner: RecordFact, script: { address: string; hash: string }, retire: Checked,
    systemStart: number): Promise<ClaimCloseout> {
  const why = 'claims: the recorded claim has no proved terminal spend and burn before retirement';
  const { claimRef, claimTx, claimToken, withdrawTx } = claim;
  need(outref(claimRef) && txOf(claimRef) === claimTx && hash(claimToken) && (hash(withdrawTx) || withdrawTx === 'not open'), why);
  const { koiosUrl, fetchImpl } = s.chain;
  const [history, original, origPosition, originStatus] = await Promise.all([
    koiosPostList(koiosUrl, 'asset_history', { _asset_policy: script.hash, _asset_name: claimToken }, fetchImpl, '', BYTES),
    archived(s, claimRef, true), txRow(s, claimTx).then((row) => position(row, systemStart)), s.node.txStatus(claimTx),
  ]);
  const mintRow = history[0];
  need(soleTokenName(original, script.address, script.hash) === claimToken && confirmations(originStatus.confirmations)
    && history.length === 1 && isObject(mintRow) && mintRow.policy_id === script.hash && mintRow.asset_name === claimToken
    && Array.isArray(mintRow.minting_txs) && mintRow.minting_txs.length === 2 && mintRow.minting_txs.every(isObject), why);
  const originalDatum = decodeClaimDatum(original.datum!);
  need(originalDatum.state === 'Open' && originalDatum.claimerDid === owner.id && String(originalDatum.stakeAmount) === claim.stakeLovelace
    && originalDatum.challengeWindow === claim.windowMs && originalDatum.submittedAt === time(claim.stakedAt), why);
  const events = mintRow.minting_txs as Obj[];
  const mint = events.find((event) => event.quantity === '1' || event.quantity === 1);
  const burn = events.find((event) => event.quantity === '-1' || event.quantity === -1);
  need(mint?.tx_hash === claimTx && mint.block_time === origPosition.at / 1_000 && hash(burn?.tx_hash) && burn.tx_hash !== claimTx
    && (withdrawTx === 'not open' || withdrawTx === burn.tx_hash), why);
  const tx = burn.tx_hash;
  const [flow, row] = await Promise.all([spendFlow(s, tx, why), txRow(s, tx)]);
  const at = position(row, systemStart);
  const movements: unknown[] = Array.isArray(row.assets_minted) ? row.assets_minted : [];
  const moved = movements.find((asset) => isObject(asset) && asset.policy_id === script.hash && asset.asset_name === claimToken);
  need(burn.block_time === at.at / 1_000 && precedes(origPosition, at) && precedes(at, retire.window)
    && isObject(moved) && (moved.quantity === -1 || moved.quantity === '-1')
    && movements.filter((asset) => isObject(asset) && asset.policy_id === script.hash && asset.asset_name === claimToken).length === 1
    && flow.outputs.every((out) => Array.isArray(out.asset_list) && !out.asset_list.some((asset) => asset.policy_id === script.hash && asset.asset_name === claimToken)), why);
  const spends = (flow.spends ?? []).filter((part) => part.scriptHash === script.hash);
  need(spends.length <= LIMIT, why);
  const matching = spends.filter(({ inputRef }) => flow.inputs.find((input) => input.ref === inputRef)?.asset_list?.some((asset) => asset.policy_id === script.hash && asset.asset_name === claimToken));
  need(matching.length === 1, why);
  const { inputRef, redeemer } = matching[0]!;
  const input = flow.inputs.find((one) => one.ref === inputRef)!;
  const terminal = inputRef === claimRef ? original : await archived(s, inputRef, true);
  const credential = addressDetails(terminal.address).paymentCredential;
  const terminalDatum = decodeClaimDatum(terminal.datum!);
  need(credential?.type === 'Script' && credential.hash === script.hash && input.address === terminal.address && input.lovelace === terminal.assets.lovelace
    && soleTokenName(terminal, terminal.address, script.hash) === claimToken && isDeepStrictEqual({ ...terminalDatum, state: originalDatum.state }, originalDatum)
    && projectedDatumMatches(input, terminal.datum!), why);
  if (withdrawTx !== 'not open') {
    const period = window(row, systemStart);
    const signer = originalDatum.claimerCredential;
    need(inputRef === claimRef && terminalDatum.state === 'Open' && signer.type === 'VerificationKey'
      && period.lo > originalDatum.submittedAt + originalDatum.challengeWindow && witnessMatches(redeemer, WITHDRAW_CLAIM_REDEEMER)
      && flow.outputs.some((out) => paymentKeyHashOf(out.address) === signer.hash && out.lovelace === originalDatum.stakeAmount),
    'claims: the named withdrawal does not prove WithdrawClaim and the claimer payout on the open claim');
    await requireSigners(s, tx, [signer.hash]);
  }
  return { claim_ref: claimRef, terminal_tx: tx, outcome: withdrawTx === 'not open' ? 'terminal_burn' : 'withdrawn' };
}

async function claimsClosed(s: EvidenceReadSession, a: Assembly, agent: AgentSpec, owner: RecordFact, retire: Checked, systemStart: number): Promise<readonly ClaimCloseout[]> {
  const commit = s.settings.module1Commit;
  need(commit !== null, 'claims: the Module-1 deployment is not configured');
  const source = `${MANIFEST_BASE}/${commit}/${s.use.moduleManifestPath}`;
  const deployment = module1FromManifest(await readManifest(source, 'The Module-1 manifest', s.fetchImpl), source);
  need(deployment.identityHash === s.chain.deployment.identity.hash, 'claims: the Module-1 deployment uses a different identity registry');
  const claims = Object.values(a.facts.claims).flatMap((facts) => facts[agent.id] === undefined ? [] : [facts[agent.id]!]);
  const tokens = new Set(claims.map(({ claimToken }) => claimToken));
  need(tokens.size === claims.length && claims.length <= LIMIT, 'claims: the claim facts are repeated or exceed the read limit');
  const { claim: script } = deployment;
  await liveFor(s, script, (out) => {
    const name = soleTokenName(out, out.address, script.hash);
    if (name === null) return false;
    return tokens.has(name) || (typeof out.datum === 'string' && decodeClaimDatum(out.datum).claimerDid === owner.id);
  }, script.hash);
  const open = await s.node.resolveInputs(claims.map(({ claimRef }) => claimRef));
  need(open.length === 0, 'claims: the node still holds a recorded claim output');
  return Promise.all(claims.map((claim) => claimClosed(s, claim, owner, script, retire, systemStart)));
}

function expectedGuardianIndices(before: IdentityDatum, agent: AgentSpec, spec: LifecycleSpec, key: (name: string) => PublicKey, { lo, hi }: Window): number[] {
  const why = 'guardians: the configured guardians do not hold the recover right for the complete validity window';
  need(before.guardianThreshold === spec.guardians.length && new Set(spec.guardians).size === spec.guardians.length, why);
  return spec.guardians.map((name) => {
    const enrolled = agent.parties.find(({ role, signer }) => role === 'Guardian' && signer.kind === 'key' && signer.key === name);
    const pkh = key(name).pkh;
    need(enrolled, why);
    const domain = enrolled.organisation === null ? null : utf8Hex(enrolled.organisation);
    const found = before.parties.flatMap((party, index) => party.signer.type === 'KeyHash' && party.signer.hash === pkh
      && party.organisation === domain && eligibleGuardian(party, lo, hi) ? [index] : []);
    need(found.length === 1, why);
    return found[0]!;
  });
}

async function prepare(s: EvidenceReadSession, a: Assembly): Promise<Readonly<Obj>> {
  const steps: Read['steps'] = {};
  const checked = new Map<Action, Checked>();
  let stage: Step = CHANGE;
  try {
    const spec = s.use.lifecycle;
    const agent = s.use.agents.find(({ id }) => id === spec?.agent);
    const successorSpec = s.use.records.find(({ id }) => id === spec?.successor);
    need(spec && agent && successorSpec && agent.end.record === 'retired' && agent.end.advert === 'retired' && agent.end.successor === spec.successor
      && spec.waitMs === DAYS_7_MS && matches(a.loaded.record.lifecycle, ACTIONS), 'lifecycle: the run does not name the six exact transaction facts and its retirement target');
    const owner = relatedFact(a.facts.records[agent.id]);
    const state = stateOf(s, 'lifecycle', a.loaded.record.label);
    const checkReferences = referenceCheck(s);
    need(state.in_flight === null, 'lifecycle.state: the producer still has a transaction pending');
    const key = publicKeys(s);
    const original = key('controller'), fee = key('fee');
    const first = key(spec.controllers[0]), second = key(spec.controllers[1]);
    need(new Set([original.pkh, first.pkh, second.pkh, fee.pkh, ...spec.guardians.map((name) => key(name).pkh)]).size === 5,
      'public_manifest: the lifecycle authorities or fee wallet are not distinct');
    const startTime = s.settings.network.systemStartMs ?? (await s.node.networkFacts()).systemStartMs;
    need(typeof startTime === 'number' && Number.isSafeInteger(startTime) && startTime > 0 && startTime % 1_000 === 0, 'block_time: the node slot clock is unavailable');
    const registration = await archived(s, owner.recordRef, true);
    let before = recordOutput(s, owner.id, registration);
    let prior = position(await txRow(s, owner.tx), startTime);
    need(confirmations((await s.node.txStatus(owner.tx)).confirmations) && owner.depositLovelace === String(before.amount),
      'records: the exact registration output and its deposit are not confirmed');

    let successor: RecordFact | undefined;
    let successorCurrent: RecordOutput | undefined;
    let due = 0;
    let adverts: readonly AdvertCloseout[] = [];
    let claims: readonly ClaimCloseout[] = [];
    let resolutions: readonly Obj[] = [];
    for (const step of ACTIONS) {
      stage = step;
      const fact = a.facts.lifecycle[step];
      const saved = savedStep(state, step);
      need(fact && a.lifecycleTransactions.has(fact.tx) && saved.tx_hash === fact.tx && saved.refs.recordBefore === before.ref
        && outref(saved.refs.recordAfter) && txOf(saved.refs.recordAfter) === fact.tx && saved.facts.agent === agent.id && saved.facts.did === owner.did,
        'lifecycle.state: the step does not name the exact registered predecessor and confirmed output');
      const tx = fact.tx;
      const [flow, row, output] = await Promise.all([
        spendFlow(s, tx, 'script_spend: the exact successful identity spend is unavailable'), txRow(s, tx),
        archived(s, saved.refs.recordAfter, step !== RECLAIM),
      ]);
      const range = window(row, startTime);
      need(precedes(prior, range), 'block_time: the confirmed steps do not follow the full record chain in ledger order');
      const after = recordOutput(s, owner.id, output);
      const { address, hash: policy } = s.chain.deployment.identity;
      const newRow = flow.outputs.find((one) => one.ref === after.ref);
      const oldRow = flow.inputs.find((one) => one.ref === before.ref);
      const spend = flow.spends?.[0];
      need(flow.inputs.filter((one) => one.address === address).length === 1 && flow.outputs.filter((one) => one.address === address).length === 1
        && rowMatches(s, owner.id, oldRow, before) && rowMatches(s, owner.id, newRow, after)
        && flow.spends?.length === 1 && spend?.inputRef === before.ref && spend.scriptHash === policy
        && (row.assets_minted == null || (Array.isArray(row.assets_minted) && row.assets_minted.length === 0)),
      'script_spend: the transaction does not make one successful identity spend of the exact predecessor');
      need(saved.facts.datumHash === datumHash(encodeIdentityDatum(after.record)) && saved.facts.keptLovelace === String(after.amount)
        && isObject(saved.facts.before) && saved.facts.before.lovelace === String(before.amount) && saved.facts.before.subagentEpoch === before.record.subagentEpoch,
      'lifecycle.state: the checked datum and value differ from the confirmed output');
      const credit = feeCredit(flow, before, after, fee.address);
      const record = before.record;
      const active = effectiveStatus(record, new Map(), range.lo, range.hi) === 'Active';
      let expected: IdentityDatum;
      let allowed: IdentitySpend[];
      let authorities: readonly string[];
      if (step === CHANGE) {
        need(active && record.controller === original.pub && record.pendingRecovery === null, 'controller: the starting root record does not show the configured active controller');
        expected = { ...record, controller: first.pub, subagentEpoch: record.subagentEpoch + 1 };
        allowed = [{ type: 'ChangeController' }];
        authorities = [original.pkh, first.pkh];
      } else if (step === START) {
        need(active && record.controller === first.pub && record.pendingRecovery === null, 'recovery: the root does not start recovery under the first controller');
        const [g1, g2] = expectedGuardianIndices(record, agent, spec, key, range);
        need(g1 !== undefined && g2 !== undefined && g1 !== g2, 'guardians: the exact distinct guardians are unavailable');
        due = range.hi + spec.waitMs;
        expected = { ...record, pendingRecovery: { newController: second.pub, effectiveAfter: due } };
        allowed = [{ type: 'RecoverInit', guardians: [g1, g2] }, { type: 'RecoverInit', guardians: [g2, g1] }];
        authorities = [...spec.guardians.map((name) => key(name).pkh), second.pkh];
      } else if (step === COMPLETE) {
        const start = checked.get(START)!;
        stage = WAIT;
        const wait = savedStep(state, WAIT);
        need(wait.tx_hash === null && wait.refs.recoveryStart === start.tx && wait.refs.recordBefore === before.ref && wait.refs.recordAfter === before.ref
          && wait.facts.agent === agent.id && wait.facts.effectiveAfter === due && time(wait.confirmed_at) >= due
          && time(wait.confirmed_at) <= time(saved.confirmed_at) && range.lo >= due && range.at >= due,
        'recovery_wait: the verified wait and the completion window do not cover the seven-day delay');
        requireEarlyRefusal(s, a, state, start, due);
        stage = COMPLETE;
        need(active && record.controller === first.pub && record.pendingRecovery?.newController === second.pub && record.pendingRecovery.effectiveAfter === due,
          'recovery: the completion does not spend the intended pending recovery');
        expected = { ...record, controller: second.pub, pendingRecovery: null, subagentEpoch: record.subagentEpoch + 1 };
        allowed = [{ type: 'RecoverFinalize' }];
        authorities = [];
      } else if (step === RETIRE) {
        need(active && record.controller === second.pub && record.pendingRecovery === null, 'retire: the recovered record is not Active without pending recovery');
        expected = tombstone(record, { type: 'Retired', at: range.lo, successor: null });
        allowed = [{ type: 'Retire' }];
        authorities = [second.pkh];
      } else if (step === SUCCESSOR) {
        successor = relatedFact(a.facts.records[spec.successor]);
        need(record.status.type === 'Retired' && record.status.successor === null && successor.id !== owner.id, 'successor: the old record is not a tombstone without a successor');
        successorCurrent = recordOutput(s, successor.id, (await currentRecord(s, successor)).utxo);
        const next = successorCurrent.record;
        const enrolled = successorSpec.keys.map(({ key: name }) => key(name).pub);
        need(confirmations((await s.node.txStatus(txOf(successorCurrent.ref))).confirmations)
          && next.controller === original.pub && effectiveStatus(next, new Map(), range.lo, range.hi) === 'Active'
          && effectiveStatus(next, new Map(), s.clock.now(), s.clock.now()) === 'Active'
          && matches(next.keys.map(({ key }) => key), enrolled), 'successor: the exact referenced successor is not the configured Active root');
        expected = { ...record, status: { ...record.status, successor: successor.id } };
        allowed = [{ type: 'SetSuccessor' }];
        authorities = [second.pkh, original.pkh];
      } else {
        need(record.status.type === 'Retired' && record.status.successor === successor?.id, 'reclaim: the predecessor is not the verified tombstone');
        expected = record;
        allowed = [{ type: 'Reclaim' }];
        authorities = [second.pkh];
      }
      const action = allowed.find((one) => witnessMatches(spend.redeemer, encodeIdentitySpend(one)));
      need(action, 'script_spend: the successful spend uses the wrong identity action');
      const factTime = step === START ? due : step === RETIRE ? range.lo : time(saved.confirmed_at);
      need(time(fact.at) === factTime && Number.isFinite(factTime) && time(saved.confirmed_at) >= range.at,
        'lifecycle.fact: the timestamp does not match the confirmed step and datum');
      need(isDeepStrictEqual(expected, after.record) && (step === RECLAIM ? before.amount > after.amount && credit > 0n : before.amount === after.amount),
        'record_ref: the confirmed datum or deposit does not make only the requested change');
      await Promise.all([
        checkReferences(before.record, after.record, range.references, step === SUCCESSOR ? successorCurrent!.ref : undefined),
        requireSigners(s, tx, authorities),
        requireFeeCollateral(s, row, fee.address),
      ]);
      const proved = { before, after, tx, window: range, fee: flow.fee, credit, action: action.type };
      if (step === RETIRE) {
        [adverts, claims] = await Promise.all([advertsClosed(s, a, agent, owner, proved, key, startTime), claimsClosed(s, a, agent, owner, proved, startTime)]);
      }
      if (step === SUCCESSOR) {
        const current = recordOutput(s, owner.id, (await currentRecord(s, owner)).utxo);
        need(isDeepStrictEqual(current.record, after.record), 'resolutions: the old record on the node no longer names this successor');
        resolutions = await proveResolutions(s, owner, current, successor!, successorCurrent!);
      }
      if (step === RECLAIM) {
        const current = recordOutput(s, owner.id, (await currentRecord(s, owner)).utxo);
        need(current.ref === after.ref && current.amount === after.amount && current.bytes === after.bytes,
          'end_state: the node does not hold the exact last output and datum');
        need(saved.facts.reclaimSeal === valueSeal(flow) && after.amount === await explicitMinimum(s, fee.address, owner.id, after),
          'ledger_minimum: the output or net fee wallet credit does not match the exact minimum reclaim');
      }
      steps[step] = [ref('transaction', tx), ref('record', after.ref)];
      if (step === COMPLETE) steps[WAIT] = [ref('transaction', checked.get(START)!.tx), ref('transaction', tx)];
      checked.set(step, proved);
      before = after;
      prior = range;
    }
    const reclaim = checked.get(RECLAIM)!;
    const projection: Projection = { resolutions, lifecycle: {
      did: owner.did, successor: successor!.did, effective_after: due, completed_at: checked.get(COMPLETE)!.window.at,
      transitions: ACTIONS.map((step) => {
        const proof = checked.get(step)!;
        return { step: IDS[step], action: proof.action, tx: proof.tx, spent_output: proof.before.ref, record_output: proof.after.ref, block_at: proof.window.at };
      }),
      advert_closeouts: adverts, claim_closeouts: claims,
      reclaim: { retained_lovelace: String(reclaim.after.amount), released_lovelace: String(reclaim.before.amount - reclaim.after.amount),
        fee_lovelace: String(reclaim.fee), wallet_credit_lovelace: String(reclaim.credit) },
    } };
    return { lifecycleRead: { steps, projection } satisfies Read };
  } catch (error) {
    steps[stage] = error instanceof Unproven ? error.message : 'the checked ledger or producer source could not be read';
    return { lifecycleRead: { steps, projection: null } satisfies Read };
  }
}

const readOf = (a: Assembly): Read | undefined => a.extra.lifecycleRead as Read | undefined;
export const lifecycleEvidence: BidEvidencePart = {
  runKinds: ['lifecycle'],
  hosted: [RESOLVE],
  lifecycleFacts: Object.fromEntries(ORDER.map((step) => [IDS[step], step === WAIT ? [START, COMPLETE] : [step]])),
  rules: Object.fromEntries(ORDER.map((step) => [IDS[step], (a: Assembly) => readOf(a)?.steps[step] ?? 'a preceding lifecycle proof is missing'])),
  prepare,
  moduleDocument(a) {
    const projection = readOf(a)?.projection;
    need(projection, 'lifecycle: the complete chain is not verified');
    return { run: 'use-case-3-lifecycle', ...projection };
  },
};
