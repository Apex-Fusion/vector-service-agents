import { isDeepStrictEqual } from 'node:util';
import { blake2b256Hex, dataOfKoiosJson, soleTokenName, utxoOfKoiosRow, withinBudget } from '../../../../packages/buyer-core/src/index.ts';
import { koiosPostList, koiosUtxoInfo } from '../../../../packages/buyer-core/src/vendored/mcp/marketplace-indexer.ts';
import type { KoiosUtxo } from '../../../../packages/buyer-core/src/vendored/mcp/marketplace-indexer.ts';
import { decodePlutusDataHex } from '../../../../packages/vector-read/src/index.ts';
import { addressDetails } from '../../../../packages/vector-read/src/guarded-decode.ts';
import { decodeDelegationDatum, decodeVaultDatum, sameDelegator, vaultDatumFromData } from '../../../../packages/vector-read/src/identity-codec.ts';
import type { DelegationDatum, VaultDatum } from '../../../../packages/vector-read/src/identity-codec.ts';
import type { NodeAccess } from '../../../checks/lib/ports.ts';
import { PreconditionError } from '../../../checks/lib/session.ts';
import type { LedgerEnv } from '../platform.ts';
import type { DelegationEntry } from '../run-record.ts';
import { isObject, txOf } from './types.ts';
import type { Obj, VaultLineage } from './types.ts';

const DEPTH = 32;
const TRANSACTIONS = 48;
const VAULT_INPUTS = 8;
const REFERENCES = 64;
const IO = 256;
const TX_BYTES = 2 * 1024 * 1024;
const ROW_BYTES = 512 * 1024;
const HASH = /^[0-9a-f]{64}$/;
const REF = /^[0-9a-f]{64}#(?:0|[1-9][0-9]{0,5})$/;

interface Output { readonly ref: string; readonly address: string; readonly key: string | null; readonly script: string | null; readonly value: bigint; readonly raw: Obj }
interface Tx { readonly raw: Obj; readonly outputs: readonly Output[]; readonly vaultInputs: readonly Output[]; readonly runs: readonly Obj[] }
interface Vault { readonly output: Output; readonly spent: boolean; readonly datum: VaultDatum; readonly bytes: string; readonly hash: string | null }
interface Link { readonly ref: string; readonly datum: DelegationDatum }
interface Source { readonly env: LedgerEnv; check(): void }

function need(ok: unknown, reason: string): asserts ok {
  if (!ok) throw new PreconditionError(reason);
}

function objects(value: unknown, cap: number, reason: string): Obj[] {
  need(Array.isArray(value) && value.length <= cap && value.every(isObject), reason);
  return value;
}

function whole(value: unknown, reason: string): number {
  const n = typeof value === 'string' && /^\d{1,16}$/.test(value) ? Number(value) : value;
  need(typeof n === 'number' && Number.isSafeInteger(n) && n >= 0, reason);
  return n;
}

function outRef(row: Obj | Pick<KoiosUtxo, 'tx_hash' | 'tx_index'>, origin?: string): string {
  const ref = `${origin ?? row.tx_hash}#${row.tx_index}`;
  need(REF.test(ref) && typeof row.tx_index === 'number' && (origin === undefined || row.tx_hash === undefined || row.tx_hash === origin), 'a vault transaction has an invalid output reference');
  return ref;
}

function outputOf(row: Obj, origin?: string): Output {
  const ref = outRef(row, origin);
  const address = row.payment_addr;
  need(isObject(address) && typeof address.bech32 === 'string', 'a vault transaction has an unreadable payment address');
  const credential = addressDetails(address.bech32).paymentCredential;
  need((credential?.hash ?? null) === (address.cred ?? null), 'a vault transaction has an inconsistent payment credential');
  const amount = row.value;
  need(typeof amount === 'string' && /^\d{1,20}$/.test(amount), 'a vault transaction has an unreadable value');
  return { ref, address: address.bech32, key: credential?.type === 'Key' ? credential.hash : null,
    script: credential?.type === 'Script' ? credential.hash : null, value: BigInt(amount), raw: row };
}

function emptyAction(datum: unknown, action: number): boolean {
  if (!isObject(datum) || (datum.bytes == null && datum.value == null)) return false;
  if (datum.bytes != null) {
    if (typeof datum.bytes !== 'string') return false;
    const data = decodePlutusDataHex(datum.bytes);
    if (data.kind !== 'constr' || data.index !== BigInt(action) || data.fields.length !== 0) return false;
  }
  const value = datum.value;
  return value == null || (isObject(value) && Object.hasOwn(value, 'constructor') && Reflect.get(value, 'constructor') === action
    && Array.isArray(value.fields) && value.fields.length === 0);
}

function redeemerOf(run: Obj): Obj | null {
  return isObject(run.input) && isObject(run.input.redeemer) ? run.input.redeemer : null;
}

/** Require one successful spend per exact input. Do not infer an absent spends_input from position. */
function requireSpends(tx: Tx, script: string, action: number, name: string): void {
  const pending = new Set(tx.vaultInputs.map(({ ref }) => ref));
  for (const run of tx.runs) {
    if (run.script_hash !== script) continue;
    const redeemer = redeemerOf(run);
    need(redeemer?.purpose === 'spend' && isObject(run.spends_input) && pending.delete(outRef(run.spends_input))
      && emptyAction(redeemer.datum, action), `the vault input does not have an exact validated ${name} redeemer`);
  }
  need(pending.size === 0, `the vault input does not have an exact validated ${name} redeemer`);
}

function vaultDatumMatches(raw: Obj, bytes: string, datum: VaultDatum, sealedHash: string | null): boolean {
  const hash = raw.datum_hash;
  if (hash != null && hash !== (sealedHash ?? blake2b256Hex(Buffer.from(bytes, 'hex')))) return false;
  const inline = raw.inline_datum;
  if (inline == null) return true; // Koios can project only the hash in tx_info.
  return isObject(inline) && (inline.bytes == null || inline.bytes === bytes)
    && (inline.value == null || isDeepStrictEqual(vaultDatumFromData(dataOfKoiosJson(inline.value)), datum));
}

function requireVaultInput(input: Output, prior: Vault): void {
  need(input.ref === prior.output.ref && prior.spent && input.address === prior.output.address && input.value === prior.output.value
    && Array.isArray(input.raw.asset_list) && input.raw.asset_list.length === 0
    && vaultDatumMatches(input.raw, prior.bytes, prior.datum, prior.hash), 'the vault input differs from its exact spent output');
}

function payWindow(tx: Tx): { lo: number; hi: number } {
  const why = 'the vault Pay validity window is unproven';
  const slot = whole(tx.raw.absolute_slot, why), stamp = whole(tx.raw.tx_timestamp, why);
  const first = whole(tx.raw.invalid_before, why), last = whole(tx.raw.invalid_after, why);
  const lo = (stamp + first - slot) * 1_000, hi = (stamp + last - slot) * 1_000;
  need(first <= slot && slot < last && last - first <= 3_600 && Number.isSafeInteger(lo) && Number.isSafeInteger(hi) && lo >= 0, why);
  return { lo, hi };
}

function requireTransition(tx: Tx, parent: Vault, child: Vault, link: Link, escrow: LedgerEnv['deployment']['escrow']): void {
  const before = parent.datum, after = child.datum;
  need(before.type === 'Live' && after.type === 'Live'
    && sameDelegator(before.owner, after.owner) && before.delegation === after.delegation, 'the vault Pay does not preserve the Live owner and delegation');
  const { lo, hi } = payWindow(tx);
  const limit = link.datum.value;
  const refs = objects(tx.raw.reference_inputs, REFERENCES, 'the vault Pay reference inputs are missing or exceed the limit').map((row) => outRef(row));
  need(new Set(refs).size === refs.length && refs.includes(link.ref) && limit !== null && sameDelegator(link.datum.delegator, before.owner)
    && link.datum.notBefore <= lo && hi <= link.datum.notAfter, 'the vault Pay does not reference its authentic delegation for the validity window');
  const amount = parent.output.value - child.output.value;
  const reset = BigInt(lo) >= BigInt(before.periodStart) + BigInt(limit.periodMs);
  const spent = reset ? amount : before.spent + amount;
  need(amount > 0n && amount <= limit.perTx && spent <= limit.total && after.spent === spent && after.periodStart === (reset ? hi : before.periodStart),
    'the vault Pay does not make the exact value and spending-period transition');
  const escrowTotal = tx.outputs.reduce((total, output) => output.script === escrow.hash && output.address === escrow.address ? total + output.value : total, 0n);
  need(escrowTotal >= amount, 'the vault Pay does not fund the deployed escrow script');
  need(Array.isArray(tx.raw.assets_minted) && tx.raw.assets_minted.length === 0, 'a vault Pay cannot mint or burn an asset');
}

export interface VaultLineageReader {
  read(vaultRef: string): Promise<VaultLineage>;
  current(vaultRef: string): Promise<void>;
  close(tx: string, from: VaultLineage): Promise<VaultLineage>;
}

/** One bounded archive reader per evidence assembly. Only Pay can continue a Live vault. */
export function vaultLineageReader(env: LedgerEnv, node: Pick<NodeAccess, 'txStatus'>, declarations: readonly DelegationEntry[]): VaultLineageReader {
  const { vault, delegation } = env.deployment;
  const txs = new Map<string, Promise<Tx>>();
  const vaults = new Map<string, Promise<Vault>>();
  const links = new Map<string, Promise<Link>>();
  const proved = new Map<string, VaultLineage>();
  const fetchImpl: typeof fetch = (url, init) => env.fetchImpl(url, { ...init, redirect: 'error' });
  async function bounded<T>(work: (source: Source) => Promise<T>): Promise<T> {
    try { return await withinBudget({ ...env, fetchImpl }, (inside, { check }) => work({ env: inside, check })); }
    catch (error) {
      if (error instanceof PreconditionError) throw error;
      throw new PreconditionError('the vault lineage has a failed or unreadable ledger source');
    }
  }

  function readTx(source: Source, hash: string): Promise<Tx> {
    source.check();
    need(HASH.test(hash), 'the vault lineage has an invalid transaction hash');
    const saved = txs.get(hash);
    if (saved !== undefined) return saved;
    need(txs.size < TRANSACTIONS, `the vault lineage exceeds its read limit of ${TRANSACTIONS} distinct transactions`);
    const loaded = (async () => {
      const { koiosUrl, fetchImpl: fetch } = source.env;
      const [rows, status] = await Promise.all([
        koiosPostList(koiosUrl, 'tx_info', { _tx_hashes: [hash], _inputs: true, _assets: true, _scripts: true }, fetch, '', TX_BYTES), node.txStatus(hash),
      ]);
      need(rows.length === 1 && isObject(rows[0]) && rows[0].tx_hash === hash && Number.isSafeInteger(status.confirmations) && (status.confirmations ?? 0) >= 1,
        'the exact vault transaction is not confirmed');
      const raw = rows[0];
      need(raw.valid_contract === undefined || raw.valid_contract === true, 'the vault transaction failed script validation');
      const runs = objects(raw.plutus_contracts, IO, 'the vault transaction does not show complete script validation');
      need(runs.every((run) => run.valid_contract === true), 'the vault transaction does not show complete script validation');
      const inputs = objects(raw.inputs, IO, 'the vault transaction has no complete input list').map((row) => outputOf(row));
      const outputs = objects(raw.outputs, IO, 'the vault transaction has no complete output list').map((row) => outputOf(row, hash));
      need(inputs.length > 0 && outputs.length > 0 && new Set(inputs.map(({ ref }) => ref)).size === inputs.length
        && new Set(outputs.map(({ ref }) => ref)).size === outputs.length, 'the vault transaction has ambiguous inputs or outputs');
      const vaultInputs = inputs.filter((input) => input.script === vault.hash);
      need(vaultInputs.length <= VAULT_INPUTS, 'a vault transaction has more than eight vault inputs');
      return { raw, outputs, vaultInputs, runs };
    })();
    txs.set(hash, loaded);
    return loaded;
  }

  async function archive(source: Source, output: Output): Promise<KoiosUtxo> {
    const { koiosUrl, fetchImpl: fetch } = source.env;
    const rows = await koiosUtxoInfo(koiosUrl, [output.ref], fetch, ROW_BYTES);
    const row = rows[0];
    need(rows.length === 1 && row !== undefined && outRef(row) === output.ref && row.address === output.address
      && (row.payment_cred === undefined || row.payment_cred === (output.script ?? output.key)) && String(output.value) === row.value
      && typeof row.is_spent === 'boolean', 'the archived vault or delegation output differs from its transaction');
    const bytes = row.inline_datum?.bytes;
    need(typeof bytes === 'string' && /^[0-9a-f]+$/.test(bytes) && bytes.length % 2 === 0, 'the archived vault or delegation output has no inline datum');
    if (row.datum_hash != null || output.raw.datum_hash != null) {
      const hash = blake2b256Hex(Buffer.from(bytes, 'hex'));
      need((row.datum_hash == null || row.datum_hash === hash) && (output.raw.datum_hash == null || output.raw.datum_hash === hash), 'the archived inline datum differs from its transaction');
    }
    need(!isObject(output.raw.inline_datum) || output.raw.inline_datum.bytes == null || output.raw.inline_datum.bytes === bytes, 'the archived inline datum differs from its transaction');
    return row;
  }

  function readVault(source: Source, output: Output): Promise<Vault> {
    const saved = vaults.get(output.ref);
    need(output.address === vault.address && output.script === vault.hash, 'the exact output is not at the deployed vault address');
    if (saved !== undefined) return saved;
    const loaded = (async () => {
      const row = await archive(source, output);
      need(output.value > 0n && Array.isArray(row.asset_list) && row.asset_list.length === 0 && Array.isArray(output.raw.asset_list) && output.raw.asset_list.length === 0
        && row.reference_script == null && output.raw.reference_script == null, 'the vault output must hold lovelace only and no reference script');
      const bytes = row.inline_datum!.bytes;
      const datum = decodeVaultDatum(bytes);
      const hash = row.datum_hash ?? (typeof output.raw.datum_hash === 'string' ? output.raw.datum_hash : null);
      need(vaultDatumMatches(output.raw, bytes, datum, hash), 'the archived inline datum differs from its transaction');
      need(datum.type === 'Returned' || datum.spent >= 0n, 'the Live vault has invalid period spending');
      return { output, spent: row.is_spent === true, datum, bytes, hash };
    })();
    vaults.set(output.ref, loaded);
    return loaded;
  }

  function readLink(source: Source, id: string): Promise<Link> {
    const saved = links.get(id);
    if (saved !== undefined) return saved;
    const loaded = (async () => {
      const declared = declarations.find((entry) => entry.id === id);
      need(declared !== undefined, 'the Live vault names no delegation of the run');
      const tx = await readTx(source, declared.tx);
      const minted = objects(tx.raw.assets_minted, IO, 'the delegation mint is unproven').filter((asset) => asset.policy_id === delegation.hash && asset.asset_name === id);
      const runs = tx.runs.filter((run) => run.script_hash === delegation.hash && redeemerOf(run)?.purpose === 'mint');
      need(minted.length === 1 && (minted[0]!.quantity === '1' || minted[0]!.quantity === 1) && runs.length === 1, 'the transaction did not validate the mint of this delegation token');
      const targets = tx.outputs.filter((output) => output.address === delegation.address && output.script === delegation.hash
        && objects(output.raw.asset_list, IO, 'the delegation output has no token list').some((asset) => asset.policy_id === delegation.hash && asset.asset_name === id));
      need(targets.length === 1, 'the delegation mint did not create one exact token output');
      const row = await archive(source, targets[0]!);
      const utxo = utxoOfKoiosRow(row);
      need(utxo !== null && soleTokenName(utxo, delegation.address, delegation.hash) === id, 'the archived delegation does not hold its authentic token');
      const datum = decodeDelegationDatum(row.inline_datum!.bytes);
      need(datum.value !== null && datum.value.perTx >= 0n && datum.value.total >= datum.value.perTx && datum.value.periodMs > 0,
        'the historical delegation has no valid vault value limit');
      return { ref: targets[0]!.ref, datum };
    })();
    links.set(id, loaded);
    return loaded;
  }

  async function prove(source: Source, wanted: string, maxDepth = DEPTH): Promise<VaultLineage> {
    need(REF.test(wanted), 'the vault lineage has an invalid output reference');
    const saved = proved.get(wanted);
    if (saved !== undefined) {
      need(saved.path.length <= maxDepth, `the vault lineage exceeds its depth limit of ${DEPTH} transactions`);
      return saved;
    }
    const hops: { tx: Tx; ref: string }[] = [];
    const visited = new Set<string>();
    let ref = wanted;
    for (;;) {
      const hash = txOf(ref);
      need(!visited.has(hash), 'the vault lineage contains a cycle');
      need(hops.length < maxDepth, `the vault lineage exceeds its depth limit of ${DEPTH} transactions`);
      visited.add(hash);
      const tx = await readTx(source, hash);
      hops.push({ tx, ref });
      if (tx.vaultInputs.length === 0) break;
      need(tx.vaultInputs.length === 1, 'a Live continuation does not have one exact vault parent');
      ref = tx.vaultInputs[0]!.ref;
    }
    const path: string[] = [];
    let parent: Vault | undefined;
    let link: Link | undefined;
    for (let i = hops.length - 1; i >= 0; i -= 1) {
      const { tx, ref } = hops[i]!;
      const continuations = tx.outputs.filter((output) => output.script === vault.hash);
      need(continuations.length === 1 && continuations[0]!.ref === ref, 'the transaction does not create one exact Live vault output');
      const child = await readVault(source, continuations[0]!);
      need(child.datum.type === 'Live', 'the exact vault output has no Live datum');
      if (parent === undefined) {
        need(child.datum.spent === 0n && child.datum.periodStart === 0 && !tx.runs.some((run) => run.script_hash === vault.hash), 'the root vault is not an opening');
        link = await readLink(source, child.datum.delegation);
        need(sameDelegator(child.datum.owner, link.datum.delegator), 'the opening vault owner does not match the authentic delegation');
      } else {
        requireSpends(tx, vault.hash, 0, 'Pay');
        need(tx.runs.length === 1, 'a vault Pay must validate exactly one script spend');
        requireVaultInput(tx.vaultInputs[0]!, parent);
        requireTransition(tx, parent, child, link!, env.deployment.escrow);
      }
      path.push(ref);
      parent = child;
    }
    const rootRef = path[0]!;
    const datum = parent!.datum as Extract<VaultDatum, { type: 'Live' }>;
    const lineage = { ref: wanted, rootRef, openTx: txOf(rootRef), owner: datum.owner, delegation: datum.delegation, path };
    proved.set(wanted, lineage);
    return lineage;
  }

  return {
    read: (ref) => bounded((source) => prove(source, ref)),
    current: (ref) => bounded(async (source) => {
      await prove(source, ref);
      const historical = await vaults.get(ref)!;
      const found = await source.env.provider.getUtxosByOutRef([{ txHash: txOf(ref), outputIndex: Number(ref.slice(65)) }]);
      const live = found[0];
      need(!historical.spent && found.length === 1 && live !== undefined && `${live.txHash}#${live.outputIndex}` === ref
        && live.address === vault.address && live.assets.lovelace === historical.output.value && Object.keys(live.assets).length === 1 && live.scriptRef == null
        && typeof live.datum === 'string' && isDeepStrictEqual(decodeVaultDatum(live.datum), historical.datum), 'the node holds no matching unspent Live vault output');
    }),
    close: (hash, from) => bounded(async (source) => {
      const tx = await readTx(source, hash);
      need(!tx.outputs.some((output) => output.script === vault.hash), 'makes an output at the vault script: a close leaves no vault output');
      need(tx.vaultInputs.length > 0, 'does not spend the vault lineage of ref: the close has no vault input');
      requireSpends(tx, vault.hash, 1, 'Close');
      const roots = new Set<string>();
      let found: VaultLineage | undefined;
      for (const input of tx.vaultInputs) {
        const origin = await readTx(source, txOf(input.ref));
        const output = origin.outputs.find((candidate) => candidate.ref === input.ref);
        need(output !== undefined, 'the close does not name an exact archived vault output');
        const prior = await readVault(source, output);
        requireVaultInput(input, prior);
        if (prior.datum.type !== 'Live') continue;
        const lineage = await prove(source, input.ref, DEPTH - 1);
        need(!roots.has(lineage.rootRef), 'the close spends the same vault branch more than once');
        roots.add(lineage.rootRef);
        if (lineage.rootRef === from.rootRef && lineage.delegation === from.delegation && sameDelegator(lineage.owner, from.owner)
          && lineage.path.includes(from.ref)) found = lineage;
      }
      need(found !== undefined, 'does not spend the vault lineage of ref: no exact Live input descends from it');
      const refs = tx.vaultInputs.map(({ ref }) => ({ txHash: txOf(ref), outputIndex: Number(ref.slice(65)) }));
      need((await source.env.provider.getUtxosByOutRef(refs)).length === 0, 'the node still holds an input of the named vault close');
      return found;
    }),
  };
}
