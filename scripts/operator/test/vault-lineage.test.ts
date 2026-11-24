import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { blake2b256Hex } from '../../../packages/buyer-core/src/index.ts';
import { CAPTURE_MS, MAINNET, delegation, delegationUtxo, koiosRow, ledgerWorld, vaultUtxo } from '../../../packages/buyer-core/test/fixtures/ledger-read-world.ts';
import type { Contract, Row, TxIo, TxRow } from '../../../packages/buyer-core/test/fixtures/ledger-read-world.ts';
import { decodePlutusDataHex, plutusAddressToBech32 } from '../../../packages/vector-read/src/index.ts';
import { encodeDelegationDatum, encodeVaultDatum } from '../../../packages/vector-read/src/identity-codec.ts';
import type { PlutusData } from '../../../packages/vector-read/src/vendored/shared/cbor/plutus-data.ts';
import type { Utxo } from '../../checks/lib/platform.ts';
import { vaultLineageReader } from '../lib/evidence/vault-lineage.ts';

const hash = (label: string): string => createHash('sha256').update(`vault fixture: ${label}`, 'utf8').digest('hex');
const ref = (u: Utxo): string => `${u.txHash}#${u.outputIndex}`;
const named = (u: Utxo) => ({ tx_hash: u.txHash, tx_index: u.outputIndex });
const keyAddress = (key: string): string => plutusAddressToBech32({ paymentCredential: { type: 'VerificationKey', hash: key }, stakeCredential: null }, 1);
const owner = { type: 'PrincipalKey' as const, hash: 'b1'.repeat(28), organisation: null };
const otherOwner = { ...owner, hash: 'b2'.repeat(28) };
const fee = 250_000n;
const amount = 5_000_000n;
const policy = MAINNET.delegation.hash;

function jsonOf(datum: PlutusData): unknown {
  switch (datum.kind) {
    case 'constr': return { constructor: Number(datum.index), fields: datum.fields.map(jsonOf) };
    case 'int': return { int: datum.value.toString() };
    case 'bytes': return { bytes: datum.hex };
    case 'list': return { list: datum.items.map(jsonOf) };
    case 'map': return { map: datum.entries.map(([k, v]) => ({ k: jsonOf(k), v: jsonOf(v) })) };
  }
}
const decoded = (bytes: string): unknown => jsonOf(decodePlutusDataHex(bytes));
const datumHash = (bytes: string): string => blake2b256Hex(Buffer.from(bytes, 'hex'));

function io(u: Utxo): TxIo {
  const { payment_cred: cred, address: bech32, value, asset_list } = koiosRow(u);
  return { ...named(u), payment_addr: { cred: cred!, bech32: bech32! }, value, asset_list,
    datum_hash: u.datum ? datumHash(u.datum) : null,
    inline_datum: u.datum ? { bytes: null, value: decoded(u.datum) } : null };
}

interface SpendReceipt extends Contract {
  input: Contract['input'] & { datum?: { hash?: string; value: unknown } };
}

function receipt(u: Utxo, script: string, constructor: number): SpendReceipt {
  return { script_hash: script, valid_contract: true, spends_input: named(u), input: {
    ...(u.datum ? { datum: { hash: datumHash(u.datum), value: decoded(u.datum) } } : {}),
    redeemer: { purpose: 'spend', datum: { hash: hash('redeemer'), value: { constructor, fields: [] } } },
  } };
}

function world(sameAuthority = false, includeTarget = true) {
  const txs: TxRow[] = [];
  const archived: Row[] = [];
  const add = (tx_hash: string, inputs: TxIo[], outputs: TxIo[], plutus_contracts: Contract[] = [], rest: Record<string, unknown> = {}) => {
    const row = { tx_hash, inputs, outputs, plutus_contracts, assets_minted: [], ...rest };
    txs.push(row);
    return row;
  };
  const coin = (label: string, lovelace: bigint, address = keyAddress(owner.hash)): Utxo => ({ txHash: hash(label), outputIndex: 0, address, assets: { lovelace } });
  const archive = (u: Utxo, spent: boolean): Row => {
    const row = koiosRow(u, { is_spent: spent, datum_hash: datumHash(u.datum!) });
    archived.push(row);
    return row;
  };
  const link = (label: string, delegator: typeof owner) => {
    const id = hash(`${label} delegation unit`);
    const datum = delegation({ delegator });
    const output = delegationUtxo(id, datum, { txHash: hash(`${label} delegation mint`) });
    const mint = add(output.txHash, [io(coin(`${label} mint funds`, 2_400_000n + fee))], [io(output)], [
      { script_hash: policy, valid_contract: true, spends_input: null,
        input: { redeemer: { purpose: 'mint', datum: { hash: hash('mint datum'), value: { constructor: 0, fields: [] } } } } },
    ], { assets_minted: [{ policy_id: policy, asset_name: id, quantity: '1' }] });
    return { id, datum, output, mint, old: archive(output, false) };
  };
  const runLink = link('run', owner);
  const foreignLink = sameAuthority ? runLink : link('foreign', otherOwner);
  const branch = (label: string, terms: ReturnType<typeof link>) => {
    const initial = { type: 'Live' as const, owner: terms.datum.delegator, delegation: terms.id, spent: 0n, periodStart: 0 };
    const opening = vaultUtxo(initial, 30_000_000n, { txHash: hash(`${label} open`), outputIndex: 0 });
    const slot = 10_000_000;
    const continued = vaultUtxo({ ...initial, spent: amount, periodStart: CAPTURE_MS + 10_000 }, opening.assets.lovelace - amount,
      { txHash: hash(`${label} pay`), outputIndex: 1 });
    archive(opening, true);
    archive(continued, label !== 'run' || includeTarget);
    add(opening.txHash, [io(coin(`${label} open funds`, 30_000_000n + fee))], [io(opening)], [], { fee: String(fee) });
    const reference = io(terms.output);
    add(continued.txHash, [io(opening), io(coin(`${label} pay fees`, fee))], [io({ ...coin(`${label} pay`, amount, MAINNET.escrow.address), txHash: continued.txHash }), io(continued)],
      [receipt(opening, MAINNET.vault.hash, 0)], { reference_inputs: [reference], absolute_slot: slot, invalid_before: slot - 10, invalid_after: slot + 10,
        tx_timestamp: CAPTURE_MS / 1000, fee: String(fee) });
    return { opening, continued, reference };
  };
  const target = branch('run', runLink);
  const foreign = branch('foreign', foreignLink);
  const returning = vaultUtxo({ type: 'Returned', owner: otherOwner }, 5_000_000n, { txHash: hash('reclaimed'), outputIndex: 0 });
  const expired = coin('expired escrow', 5_000_000n, MAINNET.escrow.address);
  add(returning.txHash, [io(expired), io(coin('reclaim fee', fee))], [io(returning)], [receipt(expired, MAINNET.escrow.hash, 3)], { fee: String(fee) });
  archive(returning, true);
  const closing = [foreign.continued, returning, ...(includeTarget ? [target.continued] : [])];
  const payout = closing.reduce((total, one) => total + one.assets.lovelace, 0n) - fee;
  const closeInputs = closing.map(io);
  const closeRuns = closing.map((input) => receipt(input, MAINNET.vault.hash, 1));
  const close = add(hash('batch close'), closeInputs, [io(coin('batch close', payout))], closeRuns, { fee: String(fee) });
  const ledger = ledgerWorld(includeTarget ? [] : [target.continued], { txs, utxoInfo: archived });
  const txStatus = async (txHash: string) => ({ confirmations: txs.some((row) => row.tx_hash === txHash) ? 1 : null });
  const reader = vaultLineageReader(ledger.env, { txStatus }, [{ id: runLink.id, tx: runLink.output.txHash, ended_tx: null }]);
  return { reader, target, foreign, runLink, foreignLink, close, closeInputs, closeRuns,
    hashesRead: () => ledger.koios.calls.filter(({ route }) => route === 'tx_info').map(({ body }) => (body?._tx_hashes as string[])[0]) };
}

describe('vault delegation projection', () => {
  it.each([
    ['missing mint output tokens', 'complete token list', (w: ReturnType<typeof world>) => { delete w.runLink.mint.outputs[0]!.asset_list; }],
    ['mint output quantity', 'exactly one delegation token', (w: ReturnType<typeof world>) => {
      w.runLink.mint.outputs[0]!.asset_list = [{ policy_id: policy, asset_name: w.runLink.id, quantity: '2' }];
    }],
    ['archived quantity', 'archived delegation does not hold', (w: ReturnType<typeof world>) => {
      w.runLink.old.asset_list = [{ policy_id: policy, asset_name: w.runLink.id, quantity: '2' }];
    }],
    ['mint output decoded limit', 'archived delegation datum differs', (w: ReturnType<typeof world>) => {
      const bytes = encodeDelegationDatum({ ...w.runLink.datum, value: { ...w.runLink.datum.value!, total: 23_000_000n } });
      w.runLink.mint.outputs[0]!.inline_datum = { bytes: null, value: decoded(bytes) };
    }],
    ['reference token', 'Pay reference disagrees', (w: ReturnType<typeof world>) => {
      w.target.reference.asset_list = [{ policy_id: policy, asset_name: w.runLink.id, quantity: '2' }];
    }],
    ['reference credential', 'Pay reference disagrees', (w: ReturnType<typeof world>) => {
      w.target.reference.payment_addr = { bech32: w.runLink.output.address, cred: MAINNET.vault.hash };
    }],
  ] as const)('refuses contradictory or missing %s', async (_label, error, perturb) => {
    const w = world();
    perturb(w);
    await expect(w.reader.read(ref(w.target.continued))).rejects.toThrow(error);
  });
});

describe('exact vault branch in a batch Close', () => {
  it.each([false, true])('proves only the run Pay and Close with mixed Live and Returned inputs (same authority = %s)', async (sameAuthority) => {
    const w = world(sameAuthority);
    const root = await w.reader.read(ref(w.target.opening));
    const result = await w.reader.close(w.close.tx_hash, root);
    expect(result).toEqual({ ...root, ref: ref(w.target.continued), path: [ref(w.target.opening), ref(w.target.continued)] });
    if (!sameAuthority) {
      expect(w.hashesRead()).not.toContain(w.foreignLink.output.txHash);
      expect(w.hashesRead()).not.toContain(w.foreign.opening.txHash);
    }
  });

  it('does not match a different opening with the identical owner and delegation', async () => {
    const w = world(true, false);
    const root = await w.reader.read(ref(w.target.opening));
    await expect(w.reader.close(w.close.tx_hash, root)).rejects.toThrow('no exact Live input descends from it');
  });

  it.each([
    ['missing Close input binding', 'exact validated Close', (w: ReturnType<typeof world>) => { w.closeRuns[0]!.spends_input = null; }],
    ['failed phase two for the foreign owner', 'complete script validation', (w: ReturnType<typeof world>) => { w.closeRuns[0]!.valid_contract = false; }],
    ['contradictory foreign owner in the script receipt', 'Close script receipt gives a different vault datum', (w: ReturnType<typeof world>) => {
      const forged = encodeVaultDatum({ type: 'Live', owner, delegation: w.foreignLink.id, spent: amount, periodStart: CAPTURE_MS + 10_000 });
      w.closeRuns[0]!.input.datum!.value = decoded(forged);
    }],
    ['mismatched funds in a foreign input', 'vault input differs from its exact spent output', (w: ReturnType<typeof world>) => { w.closeInputs[0]!.value = '1'; }],
    ['new vault output', 'close leaves no vault output', (w: ReturnType<typeof world>) => {
      w.close.outputs.push(io({ ...w.target.opening, txHash: w.close.tx_hash, outputIndex: 1 }));
    }],
  ] as const)('refuses %s even with the correct target', async (_label, error, perturb) => {
    const w = world();
    perturb(w);
    const root = await w.reader.read(ref(w.target.opening));
    await expect(w.reader.close(w.close.tx_hash, root)).rejects.toThrow(error);
  });
});
