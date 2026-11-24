import { isDeepStrictEqual } from 'node:util';
import { blake2b256Hex, dataOfKoiosJson, withinBudget } from '../../../../packages/buyer-core/src/index.ts';
import { koiosPostList, koiosUtxoInfo } from '../../../../packages/buyer-core/src/vendored/mcp/marketplace-indexer.ts';
import type { KoiosUtxo } from '../../../../packages/buyer-core/src/vendored/mcp/marketplace-indexer.ts';
import { decodePlutusDataHex } from '../../../../packages/vector-read/src/index.ts';
import { addressDetails } from '../../../../packages/vector-read/src/guarded-decode.ts';
import { decodeDelegationDatum, decodeVaultDatum, delegationDatumFromData, sameDelegator, vaultDatumFromData } from '../../../../packages/vector-read/src/identity-codec.ts';
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
interface LedgerDatum<T> { readonly datum: T; readonly bytes: string; readonly hash: string | null }
interface Vault extends LedgerDatum<VaultDatum> { readonly output: Output; readonly spent: boolean }
interface Link extends LedgerDatum<DelegationDatum> { readonly output: Output }
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

async function transactionRows(source: Source, hashes: readonly string[]): Promise<unknown[]> {
  const { koiosUrl, fetchImpl } = source.env;
  return koiosPostList(koiosUrl, 'tx_info', { _tx_hashes: hashes, _inputs: true, _assets: true, _scripts: true }, fetchImpl, '', TX_BYTES);
}

function transaction(raw: Obj, hash: string, vault: string): Tx {
  need(raw.valid_contract === undefined || raw.valid_contract === true, 'the vault transaction failed script validation');
  const runs = objects(raw.plutus_contracts, IO, 'the vault transaction does not show complete script validation');
  need(runs.every((run) => run.valid_contract === true), 'the vault transaction does not show complete script validation');
  const inputs = objects(raw.inputs, IO, 'the vault transaction has no complete input list').map((row) => outputOf(row));
  const outputs = objects(raw.outputs, IO, 'the vault transaction has no complete output list').map((row) => outputOf(row, hash));
  need(inputs.length > 0 && outputs.length > 0 && new Set(inputs.map(({ ref }) => ref)).size === inputs.length
    && new Set(outputs.map(({ ref }) => ref)).size === outputs.length, 'the vault transaction has ambiguous inputs or outputs');
  const vaultInputs = inputs.filter((input) => input.script === vault);
  need(vaultInputs.length <= VAULT_INPUTS, 'a vault transaction has more than eight vault inputs');
  return { raw, outputs, vaultInputs, runs };
}

function rememberSpend(spenders: Map<string, string>, ref: string, hash: string): void {
  const known = spenders.get(ref);
  need(known === undefined || known === hash, 'the vault lineage is ambiguous: transactions name the same spent output');
  spenders.set(ref, hash);
}

interface CloseCandidate { readonly input: string; ref: string; readonly visited: Set<string> }

/**
 * Discover the exact cited output one layer at a time, with at most eight candidates per layer.
 * The rows locate a candidate only. `prove` confirms the selected transactions and rechecks the whole Pay path.
 */
async function findCloseInput(source: Source, from: VaultLineage, candidates: CloseCandidate[], rows: Map<string, Tx | null>,
    spenders: Map<string, string>, vault: string): Promise<string | null> {
  let problem: string | null = null;
  for (let after = DEPTH - from.path.length - 1; after >= 0 && candidates.length > 0; after -= 1) {
    source.check();
    const exact = candidates.filter((candidate) => candidate.ref === from.ref);
    if (exact.length > 0) {
      need(exact.length === 1, 'the vault lineage is ambiguous: more than one Close input names the exact vault branch');
      return exact[0]!.input;
    }
    if (after === 0) throw new PreconditionError(`the vault lineage exceeds its depth limit of ${DEPTH} transactions`);
    const needRows = [...new Set(candidates.map(({ ref }) => txOf(ref)).filter((hash) => !rows.has(hash)))].sort();
    if (needRows.length > 0) {
      const results = new Map<string, Obj | null>();
      for (const row of await transactionRows(source, needRows)) {
        if (isObject(row) && typeof row.tx_hash === 'string' && needRows.includes(row.tx_hash)) {
          results.set(row.tx_hash, results.has(row.tx_hash) ? null : row);
        }
      }
      for (const hash of needRows) {
        const raw = results.get(hash);
        let parsed: Tx | null = null;
        if (raw != null) {
          try { parsed = transaction(raw, hash, vault); } catch { /* An unreadable row is not proof for this candidate. */ }
        }
        rows.set(hash, parsed);
      }
    }
    const next: CloseCandidate[] = [];
    for (const candidate of candidates) {
      const hash = txOf(candidate.ref);
      const tx = rows.get(hash);
      if (tx == null || !tx.outputs.some((out) => out.ref === candidate.ref && out.script === vault)) {
        problem ??= 'a candidate vault branch has a missing or unreadable ancestor';
        continue;
      }
      if (tx.vaultInputs.length === 0) continue; // An exact different opening.
      if (tx.vaultInputs.length !== 1) {
        problem ??= 'a Live continuation does not have one exact vault parent';
        continue;
      }
      const parent = tx.vaultInputs[0]!.ref;
      if (candidate.visited.has(txOf(parent))) {
        problem ??= 'the vault lineage contains a cycle';
        continue;
      }
      rememberSpend(spenders, parent, hash);
      candidate.ref = parent;
      candidate.visited.add(txOf(parent));
      next.push(candidate);
    }
    candidates = next;
  }
  if (problem !== null) throw new PreconditionError(`the exact Live input is unproven: ${problem}`);
  return null;
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
function requireSpends(tx: Tx, script: string, action: number, name: string): Map<string, Obj> {
  const runs = new Map<string, Obj>();
  const why = `the vault input does not have an exact validated ${name} redeemer`;
  for (const run of tx.runs) {
    if (run.script_hash !== script) continue;
    const redeemer = redeemerOf(run);
    need(redeemer?.purpose === 'spend' && isObject(run.spends_input) && emptyAction(redeemer.datum, action), why);
    const ref = outRef(run.spends_input);
    need(!runs.has(ref) && tx.vaultInputs.some((input) => input.ref === ref), why);
    runs.set(ref, run);
  }
  need(runs.size === tx.vaultInputs.length, why);
  return runs;
}

function datumHashMatches(hash: unknown, { bytes, hash: known }: LedgerDatum<unknown>): boolean {
  return hash == null || hash === (known ?? blake2b256Hex(Buffer.from(bytes, 'hex')));
}

function projectedDatumMatches<T>(data: unknown, exact: LedgerDatum<T>, decode: (data: ReturnType<typeof dataOfKoiosJson>) => T): boolean {
  // Koios can supply a hash without decoded data, or a decoded value without bytes.
  return data == null || (isObject(data) && (data.bytes == null || data.bytes === exact.bytes)
    && (data.value == null || isDeepStrictEqual(decode(dataOfKoiosJson(data.value)), exact.datum)));
}

function isToken(asset: Obj, policy: string, id: string): boolean {
  return asset.policy_id === policy && asset.asset_name === id && (asset.quantity === '1' || asset.quantity === 1);
}

function oneToken(assets: unknown, policy: string, id: string): boolean {
  return Array.isArray(assets) && assets.length === 1 && isObject(assets[0]) && isToken(assets[0], policy, id);
}

function requireVaultInput(input: Output, prior: Vault): void {
  need(input.ref === prior.output.ref && prior.spent && input.address === prior.output.address && input.value === prior.output.value
    && Array.isArray(input.raw.asset_list) && input.raw.asset_list.length === 0 && input.raw.reference_script == null
    && datumHashMatches(input.raw.datum_hash, prior) && projectedDatumMatches(input.raw.inline_datum, prior, vaultDatumFromData),
  'the vault input differs from its exact spent output');
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
  const refs = objects(tx.raw.reference_inputs, REFERENCES, 'the vault Pay reference inputs are missing or exceed the limit');
  const names = refs.map((row) => outRef(row));
  const at = names.indexOf(link.output.ref);
  need(at >= 0 && new Set(names).size === names.length && limit !== null && sameDelegator(link.datum.delegator, before.owner)
    && link.datum.notBefore <= lo && hi <= link.datum.notAfter, 'the vault Pay does not reference its authentic delegation for the validity window');
  const reference = refs[at]!;
  const address = reference.payment_addr;
  need((address == null || (isObject(address) && address.bech32 === link.output.address && address.cred === link.output.script))
    && (reference.value == null || reference.value === String(link.output.value))
    && (reference.asset_list == null || oneToken(reference.asset_list, link.output.script!, before.delegation))
    && reference.reference_script == null && datumHashMatches(reference.datum_hash, link)
    && projectedDatumMatches(reference.inline_datum, link, delegationDatumFromData), 'the Pay reference disagrees with the authenticated delegation output');
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

  function readTx(source: Source, hash: string, located?: Tx): Promise<Tx> {
    source.check();
    need(HASH.test(hash), 'the vault lineage has an invalid transaction hash');
    const saved = txs.get(hash);
    if (saved !== undefined) return saved;
    need(txs.size < TRANSACTIONS, `the vault lineage exceeds its read limit of ${TRANSACTIONS} distinct transactions`);
    const loaded = (async () => {
      const indexed = located ?? transactionRows(source, [hash]).then((rows) => {
        need(rows.length === 1 && isObject(rows[0]) && rows[0].tx_hash === hash, 'the exact vault transaction is not confirmed');
        return transaction(rows[0], hash, vault.hash);
      });
      const [checked, status] = await Promise.all([indexed, node.txStatus(hash)]);
      need(Number.isSafeInteger(status.confirmations) && (status.confirmations ?? 0) >= 1, 'the exact vault transaction is not confirmed');
      return checked;
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
      const datum = decodeVaultDatum(row.inline_datum!.bytes);
      const exact = { output, spent: row.is_spent === true, datum, bytes: row.inline_datum!.bytes, hash: row.datum_hash ?? null };
      need(projectedDatumMatches(output.raw.inline_datum, exact, vaultDatumFromData)
        && projectedDatumMatches(row.inline_datum, exact, vaultDatumFromData), 'the archived inline datum differs from its transaction');
      need(datum.type === 'Returned' || datum.spent >= 0n, 'the Live vault has invalid period spending');
      return exact;
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
      const minted = objects(tx.raw.assets_minted, IO, 'the delegation mint is unproven').filter((asset) => asset.policy_id === delegation.hash);
      const runs = tx.runs.filter((run) => run.script_hash === delegation.hash && redeemerOf(run)?.purpose === 'mint');
      need(minted.length === 1 && isToken(minted[0]!, delegation.hash, id) && runs.length === 1, 'the transaction did not validate the mint of this delegation token');
      const targets = tx.outputs.filter((output) => output.script === delegation.hash && output.address === delegation.address);
      need(targets.length === 1, 'the delegation mint did not create one exact token output');
      const [output] = targets;
      for (const out of tx.outputs) {
        const tokens = objects(out.raw.asset_list, IO, 'a delegation transaction output has no complete token list');
        need(out === output ? oneToken(tokens, delegation.hash, id) : !tokens.some((asset) => asset.policy_id === delegation.hash && asset.asset_name === id),
          'the transaction does not show exactly one delegation token at its deployed address');
      }
      const row = await archive(source, output!);
      need(oneToken(row.asset_list, delegation.hash, id) && row.reference_script == null && output!.raw.reference_script == null,
        'the archived delegation does not hold only its authentic token and lovelace');
      const datum = decodeDelegationDatum(row.inline_datum!.bytes);
      const link = { output: output!, datum, bytes: row.inline_datum!.bytes, hash: row.datum_hash ?? null };
      need(projectedDatumMatches(output!.raw.inline_datum, link, delegationDatumFromData)
        && projectedDatumMatches(row.inline_datum, link, delegationDatumFromData), 'the archived delegation datum differs from its transaction');
      need(datum.value !== null && datum.value.perTx >= 0n && datum.value.total >= datum.value.perTx && datum.value.periodMs > 0,
        'the historical delegation has no valid vault value limit');
      return link;
    })();
    links.set(id, loaded);
    return loaded;
  }

  async function prove(source: Source, wanted: string, maxDepth = DEPTH, located?: ReadonlyMap<string, Tx | null>): Promise<VaultLineage> {
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
      const tx = await readTx(source, hash, located?.get(hash) ?? undefined);
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
      const runs = requireSpends(tx, vault.hash, 1, 'Close');
      const spenders = new Map(tx.vaultInputs.map(({ ref }) => [ref, hash]));
      for (let i = 1; i < from.path.length; i += 1) rememberSpend(spenders, from.path[i - 1]!, txOf(from.path[i]!));
      const located = new Map<string, Tx | null>();
      const candidates: CloseCandidate[] = [];
      for (const input of tx.vaultInputs) {
        const originHash = txOf(input.ref);
        const origin = await readTx(source, originHash);
        located.set(originHash, origin);
        for (const spent of origin.vaultInputs) rememberSpend(spenders, spent.ref, originHash);
        const output = origin.outputs.find((candidate) => candidate.ref === input.ref);
        need(output !== undefined, 'the close does not name an exact archived vault output');
        const prior = await readVault(source, output);
        requireVaultInput(input, prior);
        // The deployed Close checks the principal signature or the agent controller and its reference record.
        // The exact script receipt must agree with the owner and value of the spent output, including any datum it projects.
        const receipt = runs.get(input.ref)!.input;
        const datum = isObject(receipt) ? receipt.datum : null;
        need(datum == null || (isObject(datum) && datumHashMatches(datum.hash, prior) && projectedDatumMatches(datum, prior, vaultDatumFromData)),
          'the Close script receipt gives a different vault datum');
        if (prior.datum.type !== 'Live' || prior.datum.delegation !== from.delegation || !sameDelegator(prior.datum.owner, from.owner)) continue;
        candidates.push({ input: input.ref, ref: input.ref, visited: new Set([originHash]) });
      }
      candidates.sort((a, b) => a.input < b.input ? -1 : a.input === b.input ? 0 : 1);
      const input = await findCloseInput(source, from, candidates, located, spenders, vault.hash);
      need(input !== null, 'does not spend the vault lineage of ref: no exact Live input descends from it');
      const lineage = await prove(source, input, DEPTH - 1, located);
      need(lineage.rootRef === from.rootRef && lineage.path.includes(from.ref) && lineage.delegation === from.delegation
        && sameDelegator(lineage.owner, from.owner), 'the exact Close input does not extend the cited vault lineage');
      const refs = tx.vaultInputs.map(({ ref }) => ({ txHash: txOf(ref), outputIndex: Number(ref.slice(65)) }));
      need((await source.env.provider.getUtxosByOutRef(refs)).length === 0, 'the node still holds an input of the named vault close');
      return lineage;
    }),
  };
}
