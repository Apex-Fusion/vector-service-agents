import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { isAdvertRetireRedeemer, proveAdvertRetirement, readConfirmedSpend } from '../lib/confirmed-spend.ts';
import type { RecordSpendDatum, RecordSpendValueFlow } from '../lib/confirmed-spend.ts';
import { blake2b256Hex } from '../lib/platform.ts';

const captured = JSON.parse(readFileSync(new URL('../../../packages/buyer-core/test/fixtures/ledger-read-mainnet.json', import.meta.url), 'utf8')).payment.tx;
const bytes = 'd87b80';
const hash = blake2b256Hex(Buffer.from(bytes, 'hex'));
const otherHash = '1'.repeat(64);
const value = { constructor: 2, fields: [] };

function project(row = captured) {
  return readConfirmedSpend({
    chain: {
      koiosUrl: 'https://indexer.test/api/v1',
      fetchImpl: async (_url, request) => {
        expect(JSON.parse(String(request?.body))).toEqual({ _tx_hashes: [row.tx_hash], _inputs: true, _scripts: true, _assets: true });
        return Response.json([row]);
      },
    },
    node: { txStatus: async (txHash) => ({ confirmations: txHash === row.tx_hash ? 1 : null }) },
  }, row.tx_hash, { withDetails: true });
}

describe('the confirmed spend proof', () => {
  it('distinguishes explicit empty assets from missing fields in the captured Koios shape', async () => {
    const row = structuredClone(captured);
    delete row.inputs[0].asset_list;
    row.inputs[1].asset_list = null;
    const projected = await project(row);
    expect(projected.inputs.map(({ asset_list }) => asset_list)).toEqual([undefined, null]);
    expect(projected.outputs.map(({ asset_list }) => asset_list)).toEqual([[], [], []]);
    expect(projected.inputs[1]?.inline_datum?.bytes).toBeNull();
    row.inputs[0].payment_addr.cred = row.inputs[1].payment_addr.cred;
    await expect(project(row)).rejects.toThrow('payment credential does not match its address');
  });

  it('refuses conflicting archived datum hashes and bytes', async () => {
    const row = structuredClone(captured);
    row.inputs[1].inline_datum.hash = otherHash;
    await expect(project(row)).rejects.toThrow('contradictory hashes for one datum');
    delete row.inputs[1].inline_datum.hash;
    row.inputs[1].inline_datum.bytes = 'd87980';
    await expect(project(row)).rejects.toThrow('datum bytes do not match their hash');
  });

  it('requires canonical Retire in a hash-only witness and rejects contradictory witnesses', () => {
    const valid: RecordSpendDatum[] = [{ hash }, { value, hash }, { bytes, value, hash }];
    const refused: RecordSpendDatum[] = [
      {}, { hash: otherHash }, { value, hash: otherHash }, { bytes, hash: otherHash },
      { bytes, hash, value: { constructor: 1, fields: [] } }, { bytes: 'd87a80', value, hash },
    ];
    for (const witness of valid) expect(isAdvertRetireRedeemer(witness)).toBe(true);
    for (const witness of refused) expect(isAdvertRetireRedeemer(witness)).toBe(false);
  });

  it('proves credit from the exact pure advert input only when assets are explicit', () => {
    const want = {
      advertRef: `${'2'.repeat(64)}#0`, advertScriptHash: captured.plutus_contracts[0].script_hash,
      advertAddress: captured.inputs[1].payment_addr.bech32, supplierAddress: captured.inputs[0].payment_addr.bech32, depositLovelace: 8_000_000n,
    };
    const input = { ref: want.advertRef, address: want.advertAddress, lovelace: want.depositLovelace };
    const flow: RecordSpendValueFlow = {
      fee: 200_000n,
      inputs: [{ ...input, asset_list: [] }],
      outputs: [{ ref: `${'3'.repeat(64)}#0`, address: want.supplierAddress, lovelace: 7_800_000n }],
      spends: [{ inputRef: want.advertRef, scriptHash: want.advertScriptHash, redeemer: { hash } }],
    };
    expect(proveAdvertRetirement(flow, want)).toBe(7_800_000n);
    for (const missing of [input, { ...input, asset_list: null }]) {
      expect(() => proveAdvertRetirement({ ...flow, inputs: [missing] }, want)).toThrow('exact advert input and deposit');
    }
  });
});
