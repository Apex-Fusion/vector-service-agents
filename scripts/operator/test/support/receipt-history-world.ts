import { blake2b256Hex } from '../../../../packages/buyer-core/src/index.ts';
import { koiosRow, MAINNET } from '../../../../packages/buyer-core/test/fixtures/ledger-read-world.ts';
import type { Contract, Row, TxIo, TxRow } from '../../../../packages/buyer-core/test/fixtures/ledger-read-world.ts';
import type { Utxo } from '../../../checks/lib/platform.ts';
import { hashOf } from './task-world.ts';

interface Block { readonly hash: string; readonly abs_slot: number; readonly block_height: number; readonly block_time: number }
interface Version { readonly output: Utxo; readonly seconds: number; readonly redeemer?: number }
const reference = (u: Utxo): string => `${u.txHash}#${u.outputIndex}`;

function transactionIO(u: Utxo): TxIo {
  const row = koiosRow(u);
  return { tx_hash: row.tx_hash, tx_index: row.tx_index, payment_addr: { bech32: u.address, cred: row.payment_cred! }, value: row.value,
    inline_datum: null, datum_hash: typeof u.datum !== 'string' ? null : blake2b256Hex(Buffer.from(u.datum, 'hex')), asset_list: row.asset_list };
}

/** Give the receipt reader real synthetic links. The same input rows serve both the evidence task and the history proof. */
export class ReceiptHistoryWorld {
  private readonly blocks = new Map<string, Block>();
  private readonly records = new Map<string, readonly Version[]>();
  private readonly indexes = new Map<number, number>();
  readonly getNetworkTip: () => Promise<{ hash: string; slot: number }>;

  constructor(private readonly txs: TxRow[], private readonly outputs: Row[], private readonly start: number) {
    const tip = this.block(start + 21 * 86_400);
    this.getNetworkTip = async () => ({ hash: tip.hash, slot: tip.abs_slot });
  }

  private block(seconds: number): Block {
    const offset = seconds - this.start;
    const hash = hashOf(`receipt proof test block ${offset}`);
    const known = this.blocks.get(hash);
    if (known !== undefined) return known;
    const block = { hash, abs_slot: 10_000_000 + offset, block_height: 9_000_000 + offset, block_time: seconds };
    this.blocks.set(hash, block);
    return block;
  }

  private place(row: TxRow, seconds: number): void {
    const { hash, abs_slot, block_height } = this.block(seconds);
    const index = this.indexes.get(seconds) ?? 0;
    this.indexes.set(seconds, index + 1);
    Object.assign(row, { tx_timestamp: seconds, absolute_slot: abs_slot, block_hash: hash, block_height, tx_block_index: index });
  }

  private remember(output: Utxo, seconds: number, is_spent: boolean): void {
    const { block_height, block_time } = this.block(seconds);
    const { datum_hash } = transactionIO(output);
    const row = koiosRow(output, { datum_hash: typeof datum_hash === 'string' ? datum_hash : null, block_height, block_time, is_spent });
    const ix = this.outputs.findIndex((old) => `${old.tx_hash}#${old.tx_index}` === reference(output));
    if (ix < 0) this.outputs.push(row);
    else this.outputs[ix] = row;
  }

  record(agent: string, versions: readonly Version[]): void {
    this.records.set(agent, versions);
    for (const [i, version] of versions.entries()) {
      const { output, seconds, redeemer = 0 } = version;
      const prior = versions[i - 1]?.output;
      const registry = MAINNET.identity.hash;
      let row = this.txs.find((found) => found.tx_hash === output.txHash);
      if (row === undefined) {
        const run: Contract = { script_hash: registry, valid_contract: true, spends_input: prior === undefined ? null : { tx_hash: prior.txHash, tx_index: prior.outputIndex },
          input: { redeemer: { purpose: prior === undefined ? 'mint' : 'spend', datum: { hash: hashOf('record transition'), value: { constructor: redeemer, fields: [] } } } } };
        row = { tx_hash: output.txHash, inputs: [], outputs: [], plutus_contracts: [run] };
        this.txs.push(row);
      }
      row.inputs = prior === undefined ? [] : [transactionIO(prior)];
      row.outputs = [transactionIO(output)];
      row.assets_minted = prior === undefined ? [{ policy_id: registry, asset_name: agent, quantity: '1' }] : [];
      this.place(row, seconds);
      this.remember(output, seconds, i + 1 !== versions.length);
    }
  }

  submitted(agent: string, output: Utxo, seconds: number, expiryMs: number, spent: boolean, stale = false): void {
    this.remember(output, seconds, spent);
    const row = this.txs.find((found) => found.tx_hash === output.txHash);
    if (row === undefined) return; // A fixture may deliberately remove this transaction.
    const versions = this.records.get(agent) ?? [];
    const proven = stale ? versions.find((version) => version.seconds > seconds) : versions.filter((version) => version.seconds < seconds).at(-1);
    const { abs_slot } = this.block(seconds);
    this.place(row, seconds);
    row.invalid_before = String(abs_slot - 10);
    row.invalid_after = String(abs_slot + expiryMs / 1000 - seconds);
    row.reference_inputs = proven === undefined ? [] : [transactionIO(proven.output)];
    row.outputs = [transactionIO(output)];
  }

  answer(url: string, init?: RequestInit): Response | null {
    const route = new URL(url).pathname.split('/').at(-1);
    if (route !== 'asset_txs' && route !== 'block_info') return null;
    if (typeof init?.body !== 'string') throw new Error('The fixture needs a JSON request');
    const data: { _asset_name?: string; _block_hashes?: string[] } = JSON.parse(init.body);
    if (route === 'block_info') return Response.json((data._block_hashes ?? []).flatMap((hash) => this.blocks.has(hash) ? [this.blocks.get(hash)] : []));
    return Response.json((this.records.get(data._asset_name ?? '') ?? []).map(({ output, seconds }) => ({
      tx_hash: output.txHash, block_height: this.block(seconds).block_height, block_time: seconds,
    })));
  }
}
