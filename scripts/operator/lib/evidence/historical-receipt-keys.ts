import { READ_BUDGET_MS, blake2b256Hex, withinBudget } from '../../../../packages/buyer-core/src/index.ts';
import { isRecordOutput } from '../../../../packages/buyer-core/src/vendored/mcp/identity-chain.ts';
import { MAX_RANGE_MS, PURPOSE, effectiveStatus, keyHasPurpose, keyHashOf } from '../../../../packages/buyer-core/src/vendored/mcp/identity-rules.ts';
import type { LedgerEnv } from '../../../../packages/buyer-core/src/vendored/mcp/ledger-read.ts';
import { REDEEMER } from '../../../../packages/buyer-core/src/vendored/mcp/marketplace-constants.ts';
import { koiosPostList, koiosUtxoInfo } from '../../../../packages/buyer-core/src/vendored/mcp/marketplace-indexer.ts';
import type { KoiosUtxo } from '../../../../packages/buyer-core/src/vendored/mcp/marketplace-indexer.ts';
import { decodeIdentityEscrowDatum, encodeIdentityEscrowDatum } from '../../../../packages/vector-read/src/datum.ts';
import { decodeIdentityDatum, encodeIdentityDatum } from '../../../../packages/vector-read/src/identity-codec.ts';
import type { IdentityDatum } from '../../../../packages/vector-read/src/identity-codec.ts';
import type { Utxo } from '../../../checks/lib/platform.ts';

interface SubmittedReceipt {
  /** The exact Submitted output already proved by the caller, never the Post or Accept. */
  readonly ref: string;
  readonly receiptHash: string;
  readonly agentId: string;
  readonly supplierPkh: string;
}

export interface HistoricalReceiptKey {
  readonly publicKeyHex: string;
  readonly recordRef: string;
  readonly submittedAtMs: number;
  /** A later revocation can invalidate authority without changing who signed the historical receipt. */
  readonly revocation: { readonly recordRef: string; readonly invalidFromMs: number | null; readonly invalidatesSubmission: boolean } | null;
}

type Row = Record<string, unknown>;
interface Position { readonly block: string; readonly height: number; readonly slot: number; readonly seconds: number; readonly index: number }
interface Tx { readonly hash: string; readonly at: Position; readonly row: Row }
interface RecordOutput { readonly tx: Tx; readonly ref: string; readonly output: Row }

const HASH = /^[0-9a-f]{64}$/;
const POLICY = /^[0-9a-f]{56}$/;
const REF = /^[0-9a-f]{64}#(?:0|[1-9][0-9]{0,5})$/;
const MAX_HISTORY = 64;
const MAX_REFS = 64;
const TX_BYTES = 2 * 1024 * 1024;
const ROW_BYTES = 512 * 1024;
const SLOT_MS = 1_000; // Vector slots are one whole second, as the identity builder requires.

class Unproven extends Error {}
function need(test: unknown, why: string): asserts test {
  if (!test) throw new Unproven(`the historical supplier key is unproven: ${why}`);
}

function object(value: unknown, why: string): Row {
  need(value !== null && typeof value === 'object' && !Array.isArray(value), why);
  return value as Row;
}
function list(value: unknown, why: string): Row[] {
  need(Array.isArray(value), why);
  return value.map((row: unknown) => object(row, why));
}
function whole(value: unknown, why: string): number {
  const n = typeof value === 'string' && /^\d{1,16}$/.test(value) ? Number(value) : value;
  need(typeof n === 'number' && Number.isSafeInteger(n) && n >= 0, why);
  return n;
}
function hashOf(value: unknown, why: string): string {
  need(typeof value === 'string' && HASH.test(value), why);
  return value;
}
function refOf(hash: unknown, index: unknown): string {
  const ref = `${hashOf(hash, 'an output has no transaction hash')}#${whole(index, 'an output has no index')}`;
  need(REF.test(ref), 'an output reference is invalid');
  return ref;
}
const rowRef = (row: { tx_hash?: unknown; tx_index?: unknown }): string => refOf(row.tx_hash, row.tx_index);
const outRef = (utxo: Utxo): string => refOf(utxo.txHash, utxo.outputIndex);

function exact<T>(items: readonly T[], key: (item: T) => string, wanted: readonly string[], why: string): Map<string, T> {
  const byKey = new Map(items.map((item) => [key(item), item]));
  need(byKey.size === items.length && byKey.size === wanted.length && wanted.every((one) => byKey.has(one)), why);
  return byKey;
}

function position(row: Row): Position {
  const why = 'Koios does not give a complete transaction position';
  return { block: hashOf(row.block_hash, why), height: whole(row.block_height, why), slot: whole(row.absolute_slot, why), seconds: whole(row.tx_timestamp, why), index: whole(row.tx_block_index, why) };
}
const order = (a: Position, b: Position): number => a.height - b.height || a.index - b.index;
const samePosition = (a: Position, b: Position): boolean => order(a, b) === 0 && a.block === b.block && a.slot === b.slot && a.seconds === b.seconds;

async function readTxs(env: LedgerEnv, hashes: string[]): Promise<Map<string, Tx>> {
  const raw = await koiosPostList(env.koiosUrl, 'tx_info', { _tx_hashes: hashes, _inputs: true, _assets: true, _scripts: true }, env.fetchImpl, '', TX_BYTES);
  const rows = list(raw, 'a transaction row is invalid').map((row) => ({ hash: hashOf(row.tx_hash, 'a transaction row has no hash'), at: position(row), row }));
  return exact(rows, (tx) => tx.hash, hashes, 'Koios did not return the exact transactions');
}

function scriptRun(tx: Tx, script: string, purpose: 'spend' | 'mint', input?: string): Row {
  const why = 'a proven transaction has no successful script validation';
  need(tx.row.valid_contract === undefined || tx.row.valid_contract === true, why);
  const runs = list(tx.row.plutus_contracts, why);
  const matches: Row[] = [];
  for (const run of runs) {
    need(run.valid_contract === true, why);
    const redeemer = object(object(run.input, why).redeemer, why);
    if (run.script_hash !== script || redeemer.purpose !== purpose) continue;
    if (input !== undefined && run.spends_input !== null && run.spends_input !== undefined) {
      need(rowRef(object(run.spends_input, why)) === input, why);
    }
    matches.push(redeemer);
  }
  need(matches.length === 1, why);
  return matches[0]!;
}

function tokens(assets: unknown, policy: string, minted = false): Map<string, bigint> {
  const only = new Map<string, bigint>();
  for (const asset of list(assets, 'the set of transaction assets is incomplete')) {
    need(typeof asset.policy_id === 'string' && POLICY.test(asset.policy_id), 'an asset policy is invalid');
    if (asset.policy_id !== policy) continue;
    const name = asset.asset_name ?? '';
    const quantity = typeof asset.quantity === 'number' && Number.isSafeInteger(asset.quantity) ? String(asset.quantity) : asset.quantity;
    need(typeof name === 'string' && /^(?:[\da-f]{2}){0,32}$/.test(name) && typeof quantity === 'string' && /^-?\d{1,30}$/.test(quantity), 'an identity token is invalid');
    need(!only.has(name) && (minted || BigInt(quantity) > 0n), 'an identity token quantity is unproven');
    only.set(name, BigInt(quantity));
  }
  return only;
}

function addressOf(row: Row, expected: { address: string; hash: string }): boolean {
  const address = object(row.payment_addr, 'a transaction address is missing');
  return address.bech32 === expected.address && address.cred === expected.hash;
}
const sole = (found: ReadonlyMap<string, bigint>, id: string): boolean => found.size === 1 && found.get(id) === 1n;

/** Follow the unique identity token up to its node-checked head, and take the output before the Submit. */
function recordAtSubmit(env: LedgerEnv, history: readonly Tx[], submit: Tx, id: string): { used: RecordOutput; head: RecordOutput; next: RecordOutput | null } {
  const registry = env.deployment.identity;
  let head: RecordOutput | null = null;
  let used: RecordOutput | null = null;
  let next: RecordOutput | null = null;
  for (const tx of history) {
    const what = 'the identity token history has an incomplete or ambiguous spend';
    const inputs = list(tx.row.inputs, what).filter((row) => tokens(row.asset_list, registry.hash).has(id));
    const outputs = list(tx.row.outputs, what).filter((row) => tokens(row.asset_list, registry.hash).has(id));
    const change = tokens(tx.row.assets_minted === null ? [] : tx.row.assets_minted, registry.hash, true).get(id) ?? 0n;
    // A read-only reference does not advance the token history.
    if (inputs.length === 0 && outputs.length === 0 && change === 0n && tx.hash === submit.hash) continue;
    const [output] = outputs;
    need(output !== undefined && outputs.length === 1 && addressOf(output, registry) && sole(tokens(output.asset_list, registry.hash), id), what);
    if (head === null) {
      need(inputs.length === 0 && change === 1n, what);
      scriptRun(tx, registry.hash, 'mint');
    } else {
      const [input] = inputs;
      need(input !== undefined && inputs.length === 1 && rowRef(input) === head.ref && addressOf(input, registry)
        && sole(tokens(input.asset_list, registry.hash), id) && change === 0n, what);
      scriptRun(tx, registry.hash, 'spend', head.ref);
    }
    head = { tx, ref: refOf(tx.hash, output.tx_index), output };
    const at = order(tx.at, submit.at);
    need(at !== 0, 'the Submit also moves the identity token');
    if (at < 0) used = head;
    else next ??= head;
  }
  need(used !== null && head !== null, 'no authentic record precedes the Submit');
  return { used, head, next };
}

function datumAt(row: KoiosUtxo, out: Row, tx: Tx, address: string): string {
  const bytes = row.inline_datum?.bytes;
  need(row.address === address && row.block_height === tx.at.height && row.block_time === tx.at.seconds && typeof row.is_spent === 'boolean', 'the exact output disagrees with its transaction');
  need(typeof bytes === 'string' && /^(?:[\da-f]{2})+$/.test(bytes), 'the exact output has no inline datum');
  const hash = blake2b256Hex(Buffer.from(bytes, 'hex'));
  need(hash === row.datum_hash && hash === out.datum_hash, 'the exact inline datum disagrees with its transaction');
  if (out.inline_datum !== null && out.inline_datum !== undefined) {
    const inline = object(out.inline_datum, 'the transaction has an invalid inline datum');
    need(inline.bytes === null || inline.bytes === undefined || inline.bytes === bytes, 'the exact inline datum disagrees with its transaction');
  }
  return bytes;
}

/** Cross-check the canonical block positions with a block the node and Koios both know. */
async function confirmBlocks(env: LedgerEnv, all: readonly Tx[]): Promise<void> {
  const provider = env.provider as typeof env.provider & { getNetworkTip?: () => Promise<{ hash: string; slot: number }> };
  need(typeof provider.getNetworkTip === 'function', 'the node cannot identify a chain point');
  const tip = await provider.getNetworkTip();
  const hash = hashOf(tip.hash, 'the node cannot identify a chain point');
  const slot = whole(tip.slot, 'the node cannot identify a chain point');
  const wanted = [...new Set([hash, ...all.map((tx) => tx.at.block)])];
  const read = async (wanted: string[]): Promise<Map<string, Row>> => {
    const rows = list(await koiosPostList(env.koiosUrl, 'block_info', { _block_hashes: wanted }, env.fetchImpl, '', ROW_BYTES), 'Koios cannot confirm the chain point');
    return exact(rows, (row) => hashOf(row.hash, 'a chain block has no hash'), wanted, 'Koios and the node do not share a chain point');
  };
  const blocks = await read(wanted);
  const anchor = blocks.get(hash)!;
  const height = whole(anchor.block_height, 'Koios and the node disagree on the chain point');
  need(anchor.abs_slot === slot, 'Koios and the node disagree on the chain point');
  for (const { at } of all) {
    const block = blocks.get(at.block)!;
    const beforeTip = at.height === height ? at.block === hash : at.height < height && at.slot < slot;
    need(beforeTip && block.abs_slot === at.slot && block.block_height === at.height && block.block_time === at.seconds,
      'Koios changed the ledger position of a transaction');
  }
  const after = await provider.getNetworkTip();
  need(after.slot >= slot && (after.slot !== slot || after.hash === hash), 'the node rolled back while reading the proof');
  if (after.hash !== hash) {
    const next = hashOf(after.hash, 'the node cannot identify a chain point');
    const stable = await read([hash, next]);
    need(stable.get(hash)!.abs_slot === slot && stable.get(next)!.abs_slot === after.slot,
      'the node and Koios changed chain points while reading the proof');
  }
}

function windowOf(tx: Tx, committedAt: number | null): { lo: number; hi: number } {
  const why = 'the Submit validity window disagrees with its ledger time';
  const loSlot = whole(tx.row.invalid_before, why);
  const hiSlot = whole(tx.row.invalid_after, why);
  const toMs = (slot: number): number => (tx.at.seconds + slot - tx.at.slot) * SLOT_MS;
  const lo = toMs(loSlot), hi = toMs(hiSlot);
  need(loSlot <= tx.at.slot && tx.at.slot < hiSlot && hi - lo <= MAX_RANGE_MS && Number.isSafeInteger(lo) && lo >= 0 && hi === committedAt, why);
  return { lo, hi };
}

async function prove(env: LedgerEnv, submitted: SubmittedReceipt): Promise<HistoricalReceiptKey> {
  const { ref, agentId, receiptHash, supplierPkh } = submitted;
  const submittedTx = ref.slice(0, 64);
  const { identity, escrow } = env.deployment;
  const listed = list(await koiosPostList(env.koiosUrl, 'asset_txs', { _asset_policy: identity.hash, _asset_name: agentId, _history: true }, env.fetchImpl, `?limit=${MAX_HISTORY + 1}`, ROW_BYTES), 'the identity token history cannot be read');
  need(listed.length > 0 && listed.length <= MAX_HISTORY, 'the identity token history is empty or exceeds its limit');
  const hashes = listed.map((row) => hashOf(row.tx_hash, 'the identity token history gives an invalid transaction'));
  need(new Set(hashes).size === hashes.length, 'the identity token history repeats a transaction');
  const all = await readTxs(env, hashes.includes(submittedTx) ? hashes : [...hashes, submittedTx]);
  const submit = all.get(submittedTx)!;
  const ordered = [...all.values()].sort((a, b) => order(a.at, b.at));
  for (let i = 1; i < ordered.length; i++) {
    const a = ordered[i - 1]!.at, b = ordered[i]!.at;
    const sameBlock = a.height === b.height;
    need(order(a, b) < 0 && (sameBlock ? a.block === b.block && a.slot === b.slot && a.seconds === b.seconds
      : a.block !== b.block && a.slot < b.slot && b.seconds - a.seconds === b.slot - a.slot), 'the transaction order or block times are contradictory');
  }
  for (const [i, hash] of hashes.entries()) {
    const at = all.get(hash)!.at;
    need(listed[i]!.block_height === at.height && listed[i]!.block_time === at.seconds, 'the identity token history disagrees with the transaction order');
  }
  const { used, head, next } = recordAtSubmit(env, ordered.filter((tx) => tx !== submit || hashes.includes(submittedTx)), submit, agentId);
  const references = list(submit.row.reference_inputs, 'the Submit reference inputs are missing');
  need(references.length <= MAX_REFS, 'the Submit reference inputs exceed their limit');
  const refs = references.map(rowRef);
  need(new Set(refs).size === refs.length && refs.includes(used.ref) && !refs.includes(ref),
    'the Submit did not reference the authentic record in effect at its ledger position');

  const outs = list(submit.row.outputs, 'the Submit outputs are missing').filter((one) => refOf(submit.hash, one.tx_index) === ref);
  need(outs.length === 1 && addressOf(outs[0]!, escrow), 'the committed Submitted output does not belong to the Submit');
  const result = object(object(scriptRun(submit, escrow.hash, 'spend').datum, 'the Submit redeemer is missing').value, 'the Submit redeemer is missing');
  need(Object.hasOwn(result, 'constructor') && Reflect.get(result, 'constructor') === REDEEMER.Submit && Array.isArray(result.fields) && result.fields.length === 1
    && object(result.fields[0], 'the Submit redeemer is missing').bytes === receiptHash, 'the Submit redeemer does not commit the receipt');

  // Koios may omit value details on reference inputs. The exact historical outputs supply them.
  const wanted = [...new Set([ref, head.ref, ...refs])];
  const utxos = exact(await koiosUtxoInfo(env.koiosUrl, wanted, env.fetchImpl, ROW_BYTES), rowRef, wanted, 'Koios did not return the exact outputs');
  const withToken = refs.filter((one) => tokens(utxos.get(one)!.asset_list, identity.hash).has(agentId));
  for (const [i, row] of references.entries()) {
    if (row.asset_list == null) continue;
    need(tokens(row.asset_list, identity.hash).has(agentId) === withToken.includes(refs[i]!),
      'the Submit reference conflicts with the identity token or datum on the ledger');
  }
  const historical = references[refs.indexOf(used.ref)]!;
  need(withToken.length === 1 && withToken[0] === used.ref
    && (historical.payment_addr == null || addressOf(historical, identity))
    && (historical.asset_list == null || sole(tokens(historical.asset_list, identity.hash), agentId))
    && (historical.datum_hash == null || historical.datum_hash === used.output.datum_hash),
  'the Submit reference conflicts with the identity token or datum on the ledger');

  const submittedRow = utxos.get(ref)!;
  const commit = decodeIdentityEscrowDatum(datumAt(submittedRow, outs[0]!, submit, escrow.address));
  need(commit.state === 'Submitted' && commit.agent_id === agentId && commit.supplier_pkh === supplierPkh && commit.result_receipt_hash === receiptHash,
    'the Submitted datum does not bind the receipt and supplier');
  const { lo, hi } = windowOf(submit, commit.submitted_at);

  const record = (pick: RecordOutput): IdentityDatum => {
    const row = utxos.get(pick.ref)!;
    need(sole(tokens(row.asset_list, identity.hash), agentId) && row.is_spent === (pick.ref !== head.ref), 'the ledger no longer shows the identity token history');
    return decodeIdentityDatum(datumAt(row, pick.output, pick.tx, identity.address));
  };
  const then = record(used);
  const now = used.ref === head.ref ? then : record(head);
  need(then.lineage.type === 'Root' && now.lineage.type === 'Root' && effectiveStatus(then, new Map(), lo, hi) === 'Active',
    'the referenced record was not an active independent supplier during the Submit');
  const keys = then.keys.filter((key) => keyHasPurpose(key, PURPOSE.transaction) && keyHashOf(key.key) === supplierPkh);
  need(keys.length === 1, 'the referenced record does not list one matching transaction key');

  // Recheck the boundary positions across reads. A re-included transaction can have the same hash at a different ledger position.
  const boundary = [...new Set([submit.hash, used.tx.hash, head.tx.hash, ...(next === null ? [] : [next.tx.hash])])];
  const checked = await readTxs(env, boundary);
  need(boundary.every((hash) => samePosition(all.get(hash)!.at, checked.get(hash)!.at)), 'the transaction positions changed while reading the proof');
  await confirmBlocks(env, ordered);
  const nodeRefs = [...new Set([ref, used.ref, head.ref])];
  const live = await env.provider.getUtxosByOutRef(nodeRefs.map((text) => ({ txHash: text.slice(0, 64), outputIndex: Number(text.slice(65)) })));
  const onNodeRefs = [head.ref, ...(submittedRow.is_spent ? [] : [ref])];
  const onNode = exact(live, outRef, onNodeRefs, 'the node and Koios disagree about the live outputs');
  const current = onNode.get(head.ref)!;
  need(isRecordOutput(current, env.deployment, agentId) && !!current.datum
    && encodeIdentityDatum(decodeIdentityDatum(current.datum)) === encodeIdentityDatum(now), 'the node and Koios disagree about the current identity record');
  const liveSubmit = onNode.get(ref);
  if (liveSubmit !== undefined) {
    need(liveSubmit.address === escrow.address && !!liveSubmit.datum
      && encodeIdentityEscrowDatum(decodeIdentityEscrowDatum(liveSubmit.datum)) === encodeIdentityEscrowDatum(commit), 'the node and Koios disagree about the live Submitted datum');
  }
  const revoked = now.status.type === 'Revoked' ? now.status : null;
  return {
    publicKeyHex: keys[0]!.key, recordRef: used.ref, submittedAtMs: hi,
    revocation: revoked === null ? null : { recordRef: head.ref, invalidFromMs: revoked.invalidFrom, invalidatesSubmission: revoked.invalidFrom !== null && revoked.invalidFrom <= hi },
  };
}

/** Resolve a historical signing key only. A result does not attest current or retrospective authority. */
export async function historicalReceiptKey(env: LedgerEnv, submitted: SubmittedReceipt): Promise<HistoricalReceiptKey> {
  need(REF.test(submitted.ref) && HASH.test(submitted.receiptHash) && HASH.test(submitted.agentId) && POLICY.test(submitted.supplierPkh), 'the Submit reference or commitment is invalid');
  const fetchImpl: typeof fetch = (url, init) => env.fetchImpl(url, { ...init, redirect: 'error' });
  try {
    return await withinBudget({ ...env, fetchImpl, budgetMs: Math.min(READ_BUDGET_MS, env.budgetMs ?? READ_BUDGET_MS) }, (inside) => prove(inside, submitted));
  } catch (err) {
    if (err instanceof Unproven) throw err;
    // Source errors can contain URLs, credentials or data. Return no cause or source body.
    throw new Unproven('the historical supplier key is unproven: a ledger read failed or gave unsupported data');
  }
}
