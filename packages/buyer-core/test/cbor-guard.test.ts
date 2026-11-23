// The CBOR check at the places where the vendored copies of this package read data that comes from the chain: the OgmiosProvider (the inline datum of each output that
// Ogmios or Koios lists, and the datum that is looked up by its hash), the configuration record of the identity deployment, and the signer. The rule: CBOR that is
// nested deeper than 64 levels is refused before it is decoded. The provider tests are the tests of packages/shared/test/provider-cbor-guard.test.ts of the
// mcp-server at 2d95483 (the same file at ebce68a), ported from node:test to vitest. The others are local.
//
// A library decoder is replaced by a watch where a test needs to show that no deep value reaches it (test/decoder-watch.ts). The watch counts each call and throws a
// marked Error for a value that nests past the limit, so no deep value reaches the real library.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Data } from '@lucid-evolution/lucid';
import * as CML from '@anastasia-labs/cardano-multiplatform-lib-nodejs';
import type { UTxO } from '@lucid-evolution/lucid';
import { OgmiosProvider } from '../src/vendored/mcp-shared/provider.ts';
import { findConfigRecord } from '../src/vendored/mcp/identity-deployment.ts';
import { signTransaction } from '../src/vendored/signer/sign.ts';
import { CONFIG_UTXO, DEPLOYMENT, M1, REF_UTXOS } from './fixtures/identity-world.ts';
import { FixtureProvider } from './fixtures/fixture-provider.ts';
import { watchDecoder } from './decoder-watch.ts';

const OGMIOS_URL = 'https://ogmios-internal.example.cluster.local:1337';
const SUBMIT_URL = 'https://submit-internal.example.cluster.local:1338/api/submit/tx';
const KOIOS_URL = 'https://koios-internal.example.cluster.local:1339';
const ADDRESS = 'addr1qylasu4y34ccwt8hv55tkswa9fthtck9xtppvc4y03kwhaztd0jlxdzk72zj8mgy6x4269v9gytkgffh3k8d3l8987yqu5c35z';
/** CBOR hex of an array nested `levels` levels deep, with the integer 0 inside. */
const nested = (levels: number): string => `${'81'.repeat(levels)}00`;
const DEEP = nested(5000);
const tooDeep = (what: string): string => `${what} is nested deeper than 64 levels.`;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const provider = () => new OgmiosProvider({ ogmiosUrl: OGMIOS_URL, submitUrl: SUBMIT_URL, koiosUrl: KOIOS_URL });
/** Answers each call of the global fetch with the JSON that `answer` gives for its URL. */
function answering(answer: (url: string, body: { method?: string }) => unknown): void {
  vi.stubGlobal('fetch', async (url: unknown, init?: { body?: unknown }) => new Response(JSON.stringify(answer(String(url), JSON.parse(String(init?.body ?? 'null')))), { status: 200 }));
}
const ogmios = (outputs: unknown[]) => (url: string, body: { method?: string }) => (url === OGMIOS_URL ? { jsonrpc: '2.0', method: body.method, result: outputs, id: null } : []);
const output = (id: string, index: number, more: Record<string, unknown> = {}) =>
  ({ transaction: { id }, index, address: ADDRESS, value: { ada: { lovelace: 2_000_000 } }, ...more });
const muteLog = () => vi.spyOn(console, 'error').mockImplementation(() => {});

describe('OgmiosProvider outputs: the inline datum', () => {
  it('an output with a datum that is nested past the limit keeps its value, its address and its other fields, and has no datum', async () => {
    muteLog();
    const script = { language: 'plutus:v3', cbor: '450101002499' };
    answering(ogmios([
      output('aa'.repeat(32), 0, { datum: 'd87980' }),
      output('bb'.repeat(32), 1, { datum: DEEP, script, value: { ada: { lovelace: 7_000_000 }, ['cc'.repeat(28)]: { '': 3 } } }),
      output('dd'.repeat(32), 2, { datumHash: 'ee'.repeat(32) }),
    ]));
    const [ok, deepDatum, byHash] = await provider().getUtxos(ADDRESS);
    expect(ok.datum).toBe('d87980');
    expect(deepDatum.datum, 'the datum is withheld').toBeNull();
    expect([deepDatum.txHash, deepDatum.outputIndex, deepDatum.address]).toStrictEqual(['bb'.repeat(32), 1, ADDRESS]);
    expect(deepDatum.assets).toStrictEqual({ lovelace: 7_000_000n, ['cc'.repeat(28)]: 3n });
    expect(deepDatum.scriptRef).toStrictEqual({ type: 'PlutusV3', script: '450101002499' });
    expect([byHash.datum, byHash.datumHash]).toStrictEqual([null, 'ee'.repeat(32)]);
    // The same call, with a normal list, gives what it always gave.
    answering(ogmios([output('aa'.repeat(32), 0, { datum: 'd87980' })]));
    expect((await provider().getUtxos(ADDRESS))[0].datum).toBe('d87980');
  });

  it('the log line for the operator names the number of outputs and the first one, and nothing of the datum', async () => {
    const log = muteLog();
    answering(ogmios([output('bb'.repeat(32), 1, { datum: DEEP }), output('cc'.repeat(32), 0, { datum: DEEP })]));
    await provider().getUtxos(ADDRESS);
    expect(log).toHaveBeenCalledWith(`[OgmiosProvider] 2 output(s) of an Ogmios answer carry a datum that is not read; first: ${'bb'.repeat(32)}#1`);
  });

  it('a datum at the limit is kept, and one level more is withheld, in each of the forms that Ogmios gives a datum in', async () => {
    muteLog();
    answering(ogmios([
      output('a1'.repeat(32), 0, { datum: nested(64) }), output('a2'.repeat(32), 0, { datum: nested(65) }),
      output('a3'.repeat(32), 0, { datum: { bytes: nested(64) } }), output('a4'.repeat(32), 0, { datum: { bytes: nested(65) } }),
      output('a5'.repeat(32), 0, { datum: { value: nested(64) } }), output('a6'.repeat(32), 0, { datum: { value: DEEP } }),
    ]));
    const datums = (await provider().getUtxos(ADDRESS)).map((u) => u.datum);
    expect(datums).toStrictEqual([nested(64), null, nested(64), null, nested(64), null]);
  });

  it('text that is not CBOR is withheld as well, and the output stays', async () => {
    muteLog();
    answering(ogmios([output('a1'.repeat(32), 0, { datum: 'not hex' }), output('a2'.repeat(32), 0, { datum: 'ff' })]));
    const utxos = await provider().getUtxos(ADDRESS);
    expect(utxos.map((u) => u.datum)).toStrictEqual([null, null]);
    expect(utxos).toHaveLength(2);
  });

  it('the outputs that are read by their references and by a unit are mapped the same way', async () => {
    muteLog();
    answering(ogmios([output('bb'.repeat(32), 3, { datum: DEEP })]));
    const [byRef] = await provider().getUtxosByOutRef([{ txHash: 'bb'.repeat(32), outputIndex: 3 }]);
    expect([byRef.outputIndex, byRef.assets.lovelace, byRef.datum]).toStrictEqual([3, 2_000_000n, null]);
    const unit = 'cc'.repeat(28);
    const koiosRow = (datum: string) => ({ tx_hash: 'dd'.repeat(32), tx_index: 1, address: ADDRESS, value: '3000000', asset_list: [{ policy_id: unit, asset_name: '', quantity: '1' }], datum_hash: null, inline_datum: { bytes: datum } });
    answering((url) => (url.endsWith('/asset_utxos') ? [koiosRow(DEEP)] : []));
    const byUnit = await provider().getUtxoByUnit(unit);
    expect([byUnit.txHash, byUnit.outputIndex, byUnit.assets.lovelace, byUnit.assets[unit], byUnit.datum]).toStrictEqual(['dd'.repeat(32), 1, 3_000_000n, 1n, null]);
    answering((url) => (url.endsWith('/asset_utxos') ? [koiosRow('d87980')] : []));
    expect((await provider().getUtxoByUnit(unit)).datum).toBe('d87980');
  });
});

describe('OgmiosProvider.getDatum', () => {
  const HASH = 'ab'.repeat(32);
  const koiosDatum = (bytes: string) => (url: string) => (url.endsWith('/datum_info') ? [{ datum_hash: HASH, bytes }] : []);

  it('a datum that is nested past the limit is refused, naming the hash, and a normal datum is read after it', async () => {
    muteLog();
    answering(koiosDatum(DEEP));
    await expect(provider().getDatum(HASH)).rejects.toThrow(tooDeep(`The datum of the hash ${HASH}`));
    answering(koiosDatum('d87980'));
    expect(await provider().getDatum(HASH)).toBe('d87980');
  });

  it('a datum at the limit is given', async () => {
    answering(koiosDatum(nested(64)));
    expect(await provider().getDatum(HASH)).toBe(nested(64));
  });

  it('a hash that Koios does not know is still not found', async () => {
    muteLog();
    answering(() => []);
    await expect(provider().getDatum(HASH)).rejects.toThrow(/^Datum not found for hash: /);
  });
});

describe('the configuration record of the identity deployment', () => {
  it('an output whose datum is nested past the limit is refused before Data.from, and the genuine record is read after', async () => {
    const watch = watchDecoder(Data, 'from');
    const withDeepDatum: UTxO = { ...CONFIG_UTXO, datum: DEEP };
    await expect(findConfigRecord(new FixtureProvider([withDeepDatum, ...REF_UTXOS]), DEPLOYMENT)).rejects.toThrow(/has no 28-byte Module-1 hash as its inline datum/);
    expect(watch.calls()).toBe(0);
    expect(watch.reached()).toBe(0);
    expect((await findConfigRecord(new FixtureProvider([CONFIG_UTXO, ...REF_UTXOS]), DEPLOYMENT))?.m1).toBe(M1);
    expect(watch.calls()).toBe(1);
  });
});

describe('the signer', () => {
  /** A minimal unsigned transaction built with CML alone: one input, one output to the key's own enterprise address, fee 500000, no scripts. */
  function unsignedTxFor(owner: CML.PrivateKey): string {
    const inputs = CML.TransactionInputList.new();
    inputs.add(CML.TransactionInput.new(CML.TransactionHash.from_hex('ab'.repeat(32)), 0n));
    const outputs = CML.TransactionOutputList.new();
    const ownAddress = CML.EnterpriseAddress.new(1, CML.Credential.new_pub_key(owner.to_public().hash())).to_address();
    outputs.add(CML.TransactionOutput.new(ownAddress, CML.Value.from_coin(2_000_000n)));
    return CML.Transaction.new(CML.TransactionBody.new(inputs, outputs, 500_000n), CML.TransactionWitnessSet.new(), true).to_cbor_hex();
  }
  /** The bytes of a byte string that holds `hex`, with its head (for a length up to 65,535). */
  const bytesOf = (hex: string): string => {
    const length = hex.length / 2;
    return `${length < 24 ? (0x40 + length).toString(16).padStart(2, '0') : length < 256 ? `58${length.toString(16).padStart(2, '0')}` : `59${length.toString(16).padStart(4, '0')}`}${hex}`;
  };
  /** A transaction with one output that holds `datum` inline. */
  const transactionWithDatum = (datum: string): string => {
    const input = `825820${'22'.repeat(32)}00`;
    const output = `a300581d61${'11'.repeat(28)}011a001e8480028201d818${bytesOf(datum)}`;
    return `84a30081${input}0181${output}0200a0f5f6`;
  };

  it('a transaction that nests past 64 levels is refused before CML reads it, and a normal transaction is signed after', () => {
    const watch = watchDecoder(CML.Transaction, 'from_cbor_hex');
    const key = CML.PrivateKey.generate_ed25519();
    const bech32 = key.to_bech32();
    expect(() => signTransaction(transactionWithDatum(nested(59)), bech32)).toThrow(`Transaction could not be decoded: ${tooDeep('The transaction')}`);
    expect(() => signTransaction(transactionWithDatum(DEEP), bech32)).toThrow(`Transaction could not be decoded: ${tooDeep('The transaction')}`);
    expect(watch.calls()).toBe(0);
    expect(watch.reached()).toBe(0);
    const unsigned = unsignedTxFor(key);
    const { signedCborHex } = signTransaction(unsigned, bech32);
    expect(signedCborHex).not.toBe(unsigned);
    expect(watch.calls()).toBeGreaterThan(0);
  });

  it('a transaction at the limit goes through to CML', () => {
    const watch = watchDecoder(CML.Transaction, 'from_cbor_hex');
    // 58 levels of the datum and the 6 around it are 64 levels. The transaction is not signable (it has no key of the signer in its body), but CML reads it.
    try { signTransaction(transactionWithDatum(nested(58)), CML.PrivateKey.generate_ed25519().to_bech32()); } catch { /* a refusal of its own, after the read */ }
    expect(watch.calls()).toBe(1);
    expect(watch.reached()).toBe(0);
  });
});
