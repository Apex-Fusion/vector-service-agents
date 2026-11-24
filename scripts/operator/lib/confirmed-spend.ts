// Read the regular inputs, outputs, fee and successful script spends of a confirmed transaction.
// The detailed projection is opt-in. The default reads no asset lists and allocates no redeemer projection.
import { koiosPostList } from '../../../packages/buyer-core/src/vendored/mcp/marketplace-indexer.ts';
import { itemEnd } from '../../../packages/usecase-kit/src/cosign/layout.ts';
import { MAX_CBOR_DEPTH, assertCborDepth } from '../../../packages/vector-read/src/cbor-depth.ts';
import { addressDetails } from '../../../packages/vector-read/src/guarded-decode.ts';
import { decodePlutusDataHex } from '../../../packages/vector-read/src/identity.ts';
import { VerificationError } from '../../checks/lib/verify.ts';
import type { LandHost } from './contract.ts';
import { blake2b256Hex, formatOutRef } from './platform.ts';

const IDENTIFIER = /^[0-9a-f]{64}$/;
const TX_INFO_LIMIT_BYTES = 512 * 1024;
const POLICY_ID = /^[0-9a-f]{56}$/;
const ASSET_NAME = /^(?:[0-9a-f]{2}){0,32}$/;
const HEX_BYTES = /^(?:[0-9a-f]{2})*$/i;
const MAX_DATUM_HEX = 32_768;
// Constructor 2 with no fields, in the canonical ledger encoding.
const ADVERT_RETIRE_HASH = blake2b256Hex(Buffer.from('d87b80', 'hex'));

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

export type KoiosPlutusData =
  | { readonly int: number | string }
  | { readonly bytes: string }
  | { readonly list: readonly KoiosPlutusData[] }
  | { readonly map: readonly { readonly k: KoiosPlutusData; readonly v: KoiosPlutusData }[] }
  | { readonly constructor: number; readonly fields: readonly KoiosPlutusData[] };

export interface RecordSpendDatum {
  readonly bytes?: string | null;
  readonly value?: KoiosPlutusData | null;
  readonly hash?: string | null;
}

export interface RecordSpendAsset {
  readonly policy_id: string;
  readonly asset_name: string;
  readonly quantity: string;
}

export interface RecordSpendScript {
  readonly scriptHash: string;
  readonly inputRef: string;
  readonly redeemer: RecordSpendDatum;
}

export interface RecordSpendValueRow {
  readonly ref: string;
  readonly address: string;
  readonly lovelace: bigint;
  readonly inline_datum?: RecordSpendDatum | null;
  readonly asset_list?: readonly RecordSpendAsset[] | null;
  readonly datum_hash?: string | null;
}
export interface RecordSpendValueFlow {
  readonly fee: bigint;
  readonly inputs: readonly RecordSpendValueRow[];
  readonly outputs: readonly RecordSpendValueRow[];
  readonly spends?: readonly RecordSpendScript[];
}

/** Bind the actual fee, exact regular references, addresses and values. Collateral and reference inputs do not pay the refund. */
export function valueSeal(flow: RecordSpendValueFlow): string {
  const ordered = (rows: readonly RecordSpendValueRow[]) => rows.map(({ ref, address, lovelace }) => `${ref} ${address} ${lovelace}`).sort();
  return blake2b256Hex(Buffer.from(JSON.stringify([String(flow.fee), ordered(flow.inputs), ordered(flow.outputs)])));
}

function lovelaceOf(value: unknown): bigint | null {
  if (typeof value === 'string' && /^[0-9]{1,20}$/.test(value)) return BigInt(value);
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : null;
}

/** Validate the whole structured datum before a consumer decodes it. Extra members are not Plutus data. */
function isPlutusData(value: unknown, depth = 0): value is KoiosPlutusData {
  if (depth > MAX_CBOR_DEPTH || !isObject(value)) return false;
  const keys = Object.keys(value);
  if (keys.length === 1) {
    const key = keys[0]!;
    const member = value[key];
    if (key === 'int') return typeof member === 'number' ? Number.isSafeInteger(member) : typeof member === 'string' && /^-?[0-9]{1,80}$/.test(member);
    if (key === 'bytes') return typeof member === 'string' && member.length <= MAX_DATUM_HEX && HEX_BYTES.test(member);
    if (key === 'list') return Array.isArray(member) && member.every((item) => isPlutusData(item, depth + 1));
    if (key === 'map') return Array.isArray(member) && member.every((entry: unknown) => (
      isObject(entry) && Object.keys(entry).length === 2 && isPlutusData(entry.k, depth + 1) && isPlutusData(entry.v, depth + 1)
    ));
  }
  const tag = value['constructor'];
  return keys.length === 2 && Object.hasOwn(value, 'constructor') && typeof tag === 'number' && Number.isSafeInteger(tag) && tag >= 0
    && Array.isArray(value.fields) && value.fields.every((field) => isPlutusData(field, depth + 1));
}

function archivedDatumHash(hash: unknown): string | null | undefined {
  if (hash === null || hash === undefined) return hash;
  if (typeof hash !== 'string' || !IDENTIFIER.test(hash)) throw new VerificationError('The confirmed transaction has an unreadable datum hash.');
  return hash;
}

function archivedDatum(datum: unknown, outputHash?: string | null): RecordSpendDatum | null | undefined {
  if (datum === null || datum === undefined) return datum;
  const bad = () => new VerificationError('The confirmed transaction contains unreadable Plutus data.');
  if (!isObject(datum)) throw bad();
  const { bytes, value } = datum;
  const hash = archivedDatumHash(datum.hash);
  if (hash != null && outputHash != null && hash !== outputHash) {
    throw new VerificationError('The confirmed transaction gives contradictory hashes for one datum.');
  }
  if (value != null && !isPlutusData(value)) throw bad();
  if (bytes != null) {
    if (typeof bytes !== 'string' || bytes === '' || bytes.length > MAX_DATUM_HEX || !HEX_BYTES.test(bytes)) throw bad();
    const raw = Buffer.from(bytes, 'hex');
    try { assertCborDepth(raw); } catch { throw bad(); }
    if (itemEnd(raw, 0) !== raw.length) throw bad();
    const expected = hash ?? outputHash;
    if (expected != null && blake2b256Hex(raw) !== expected) {
      throw new VerificationError('The confirmed transaction datum bytes do not match their hash.');
    }
  } else if (value == null && hash == null) {
    throw bad();
  }
  return { ...(bytes === undefined ? {} : { bytes }), ...(value === undefined ? {} : { value }), ...(hash === undefined ? {} : { hash }) };
}

function archivedAssets(value: unknown): readonly RecordSpendAsset[] | null | undefined {
  if (value === null || value === undefined) return value;
  if (!Array.isArray(value)) throw new VerificationError('The confirmed transaction has an unreadable asset list.');
  const seen = new Set<string>();
  return value.map((entry: unknown) => {
    if (!isObject(entry)) throw new VerificationError('The confirmed transaction has an unreadable asset.');
    const policy = entry.policy_id;
    const name = entry.asset_name ?? '';
    const quantity = lovelaceOf(entry.quantity);
    if (typeof policy !== 'string' || !POLICY_ID.test(policy) || typeof name !== 'string' || !ASSET_NAME.test(name) || quantity === null || quantity <= 0n) {
      throw new VerificationError('The confirmed transaction has an unreadable asset.');
    }
    const unit = policy + name;
    if (seen.has(unit)) throw new VerificationError('The confirmed transaction lists the same asset more than once.');
    seen.add(unit);
    return { policy_id: policy, asset_name: name, quantity: String(quantity) };
  });
}

function archivedRef(row: Record<string, unknown>): string | null {
  const { tx_hash: hash, tx_index: index } = row;
  if (typeof hash !== 'string' || !IDENTIFIER.test(hash) || typeof index !== 'number' || !Number.isSafeInteger(index) || index < 0 || index > 0xffff_ffff) return null;
  return formatOutRef(hash, index);
}

function archivedRows(value: unknown, withDetails: boolean, txHash?: string): RecordSpendValueRow[] {
  if (!Array.isArray(value) || value.length === 0) throw new VerificationError('The confirmed transaction has no complete input and output lists.');
  const seen = new Set<string>();
  return value.map((item: unknown) => {
    if (!isObject(item)) throw new VerificationError('The confirmed transaction has an unreadable output reference.');
    const ref = archivedRef(item);
    const payment = item.payment_addr;
    const amount = lovelaceOf(item.value);
    const address = isObject(payment) ? payment.bech32 : null;
    if (ref === null || (txHash !== undefined && item.tx_hash !== txHash) || typeof address !== 'string' || address.length === 0 || amount === null || amount <= 0n) {
      throw new VerificationError('The confirmed transaction has an unreadable output reference, address or amount.');
    }
    const reportedCredential = isObject(payment) ? payment.cred : undefined;
    if (reportedCredential != null) {
      let actualCredential: string | undefined;
      try { actualCredential = addressDetails(address).paymentCredential?.hash; }
      catch { throw new VerificationError('The confirmed transaction has an unreadable payment address.'); }
      if (typeof reportedCredential !== 'string' || actualCredential !== reportedCredential) {
        throw new VerificationError('The confirmed transaction payment credential does not match its address.');
      }
    }
    if (seen.has(ref)) throw new VerificationError('The confirmed transaction lists the same output reference more than once.');
    seen.add(ref);
    if (!withDetails) return { ref, address, lovelace: amount };
    const datumHash = archivedDatumHash(item.datum_hash);
    const inline = archivedDatum(item.inline_datum, datumHash);
    return {
      ref, address, lovelace: amount,
      inline_datum: inline, asset_list: archivedAssets(item.asset_list),
      ...(datumHash === undefined ? {} : { datum_hash: datumHash }),
    };
  });
}

function archivedSpends(scripts: unknown, inputs: readonly RecordSpendValueRow[]): RecordSpendScript[] {
  if (!Array.isArray(scripts)) return [];
  const remaining = new Set(inputs.map(({ ref }) => ref));
  const spends: RecordSpendScript[] = [];
  for (const script of scripts as Record<string, unknown>[]) {
    const input = script.input;
    const redeemer = isObject(input) ? input.redeemer : undefined;
    const purpose = isObject(redeemer) ? redeemer.purpose : undefined;
    const spent = script.spends_input;
    if (typeof purpose === 'string' && purpose !== 'spend' && spent == null) continue;
    const inputRef = isObject(spent) ? archivedRef(spent) : null;
    const hash = script.script_hash;
    if (!isObject(redeemer) || purpose !== 'spend' || inputRef === null || !remaining.delete(inputRef) || typeof hash !== 'string' || !POLICY_ID.test(hash)) {
      throw new VerificationError('The confirmed transaction has a script without an unambiguous regular spend input.');
    }
    const datum = archivedDatum(redeemer.datum);
    if (!datum) throw new VerificationError('The confirmed spend script has no redeemer data.');
    spends.push({ scriptHash: hash, inputRef, redeemer: datum });
  }
  return spends;
}

/** Vector Koios can report phase-two validity only on the individual script rows. */
function confirmedPhaseTwo(row: Record<string, unknown>): boolean {
  const { valid_contract: verdict, plutus_contracts: scripts } = row;
  if (verdict !== undefined && verdict !== true) return false;
  if (scripts === undefined) return verdict === true;
  if (!Array.isArray(scripts) || scripts.some((script: unknown) => !isObject(script) || script.valid_contract !== true)) return false;
  return verdict === true || scripts.length > 0;
}

/** Read payment values and, when requested, the datum, assets and anchored spend action. */
export async function readConfirmedSpend(
  session: { readonly chain: Pick<LandHost['chain'], 'koiosUrl' | 'fetchImpl'>; readonly node: Pick<LandHost['node'], 'txStatus'> },
  txHash: string, { withDetails = false }: { withDetails?: boolean } = {},
): Promise<RecordSpendValueFlow> {
  if (!IDENTIFIER.test(txHash)) throw new VerificationError('The spend has no usable transaction hash.');
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
    throw new VerificationError('The confirmed spend could not be read from the indexer.');
  }
  const row = rows[0];
  if (rows.length !== 1 || !isObject(row) || row.tx_hash !== txHash
    || confirmations === null || !Number.isSafeInteger(confirmations) || confirmations < 1) {
    throw new VerificationError('The indexer does not confirm the exact spend.');
  }
  if (!confirmedPhaseTwo(row)) throw new VerificationError('The confirmed spend has no affirmative phase-two validity evidence.');
  const fee = lovelaceOf(row.fee);
  if (fee === null) throw new VerificationError('The confirmed spend has no actual fee.');
  const inputs = archivedRows(row.inputs, withDetails);
  const outputs = archivedRows(row.outputs, withDetails, txHash);
  return { fee, inputs, outputs, ...(withDetails ? { spends: archivedSpends(row.plutus_contracts, inputs) } : {}) };
}

/** The identity advert validator uses constructor 2 with no fields for RetireAdvert. */
export function isAdvertRetireRedeemer({ bytes, value, hash }: RecordSpendDatum): boolean {
  if (bytes == null) {
    if (hash == null ? value == null : hash !== ADVERT_RETIRE_HASH) return false;
  } else {
    try {
      const data = decodePlutusDataHex(bytes);
      if (data.kind !== 'constr' || data.index !== 2n || data.fields.length !== 0) return false;
      if (hash != null && blake2b256Hex(Buffer.from(bytes, 'hex')) !== hash) return false;
    } catch { return false; }
  }
  return value == null || ('fields' in value && value.constructor === 2 && value.fields.length === 0);
}

export interface AdvertRefund {
  readonly advertRef: string;
  readonly advertAddress: string;
  readonly advertScriptHash: string;
  readonly supplierAddress: string;
  readonly depositLovelace: bigint;
}

/** Prove the exact RetireAdvert action and the supplier's net credit from a detailed confirmed spend. */
export function proveAdvertRetirement(flow: RecordSpendValueFlow, want: AdvertRefund): bigint {
  const { advertRef, advertAddress, advertScriptHash, supplierAddress, depositLovelace } = want;
  const input = flow.inputs.find(({ ref }) => ref === advertRef);
  const script = flow.spends?.[0];
  if (input?.address !== advertAddress || input.lovelace !== depositLovelace || input.asset_list?.length !== 0
    || flow.spends?.length !== 1 || script?.scriptHash !== advertScriptHash || script.inputRef !== advertRef || !isAdvertRetireRedeemer(script.redeemer)) {
    throw new VerificationError('The confirmed spend does not show RetireAdvert for the exact advert input and deposit.');
  }
  let credit = 0n;
  for (const spent of flow.inputs) {
    if (spent === input) continue;
    if (spent.address !== supplierAddress || spent.inline_datum != null || spent.datum_hash != null) throw new VerificationError('The confirmed retirement used unrelated funding.');
    credit -= spent.lovelace;
  }
  for (const output of flow.outputs) {
    if (output.address !== supplierAddress || output.inline_datum != null || output.datum_hash != null) throw new VerificationError('The confirmed retirement paid a destination other than the supplier wallet.');
    credit += output.lovelace;
  }
  if (credit <= 0n || credit !== depositLovelace - flow.fee) throw new VerificationError('The confirmed supplier net credit is not the advert deposit minus the actual fee.');
  return credit;
}
