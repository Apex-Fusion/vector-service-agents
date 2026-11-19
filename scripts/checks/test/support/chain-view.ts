// A node for the tests of the checks: the outputs that a test gives it, the real evaluation of scripts (the evaluator that Lucid ships), and a world that moves on when a
// transaction is applied to it. It is the FixtureProvider of buyer-core with these three additions. It never opens a connection.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { FixtureProvider, fixtureProtocolParameters } from '../../../../packages/buyer-core/test/fixtures/fixture-provider.ts';
import { OgmiosRpcError } from '../../../../packages/buyer-core/src/vendored/mcp-shared/provider.ts';
import { decodeTransaction } from '../../lib/platform.ts';
import type { Utxo } from '../../lib/platform.ts';

interface Redeemer { ex_units: { mem: number; steps: number }; redeemer_index: number; redeemer_tag: (typeof TAGS)[number] }

/** Lucid and its evaluator, from the place of buyer-core: the version that buyer-core pins. The tests of the checks name no package of their own. */
const BUYER_CORE = fileURLToPath(new URL('../../../../packages/buyer-core/package.json', import.meta.url));
interface LucidModule {
  CML: {
    Transaction: { from_cbor_hex(hex: string): { body(): unknown } };
    LegacyRedeemer: { from_cbor_bytes(bytes: Uint8Array): { tag(): number; index(): bigint; ex_units(): { mem(): bigint; steps(): bigint } } };
    hash_transaction(body: unknown): { to_hex(): string };
  };
  createCostModels(costModels: unknown): { to_cbor_bytes(): Uint8Array };
  utxoToTransactionInput(utxo: Utxo): { to_cbor_bytes(): Uint8Array };
  utxoToTransactionOutput(utxo: Utxo): { to_cbor_bytes(): Uint8Array };
}
const lucid = createRequire(BUYER_CORE)('@lucid-evolution/lucid') as LucidModule;
type Uplc = { eval_phase_two_raw: (...args: [Uint8Array, Uint8Array[], Uint8Array[], Uint8Array, bigint, bigint, bigint, bigint, number]) => Uint8Array[] };
const UPLC = createRequire(createRequire(BUYER_CORE).resolve('@lucid-evolution/lucid'))('@lucid-evolution/uplc') as Uplc;
const TAGS = ['spend', 'mint', 'publish', 'withdraw', 'vote', 'propose'] as const;

/** The start of Vector mainnet: the chain of the fixtures has a slot each second from here. */
export const SYSTEM_START_MS = 1_756_485_600_000;

/** The hash of a transaction: the hash of its body. */
export function hashOfTransaction(cborHex: string): string {
  return lucid.CML.hash_transaction(lucid.CML.Transaction.from_cbor_hex(cborHex).body()).to_hex();
}

/** The 3010 of Ogmios with the 3012 of the validator that failed, as the vendored provider raises it. */
function ogmiosRefusal(text: string): OgmiosRpcError {
  const place = /\b(Spend|Mint|Publish|Withdraw|Vote|Propose)\[(\d+)\]/.exec(text);
  const validator = { purpose: place === null ? 'spend' : place[1]!.toLowerCase(), index: place === null ? 0 : Number(place[2]) };
  const data = [{ validator, error: { code: 3012, message: 'Some of the scripts failed to evaluate to a positive outcome.', data: { validationError: text, traces: [] } } }];
  return new OgmiosRpcError('evaluateTransaction failed: 3010 Some scripts of the transactions terminated with error(s).', 'evaluateTransaction', 3010, 'Some scripts of the transactions terminated with error(s).', JSON.stringify(data), false);
}

export class ChainView extends FixtureProvider {
  /** The outputs that the node holds. */
  held: Utxo[];
  /** Every transaction that was applied, as signed hex, in order. */
  readonly applied: string[] = [];
  /** The transactions that the node was asked to evaluate. */
  readonly evaluations: string[] = [];
  /** The slot of the tip. */
  tipSlot: number;
  /** When set, every evaluation fails with this text, as a node does for a validator that failed. */
  refuseEvaluationWith: string | null = null;

  constructor(utxos: Utxo[], nowMs: number) {
    super([]);
    this.held = [...utxos];
    this.tipSlot = Math.floor((nowMs - SYSTEM_START_MS) / 1000);
  }

  async getUtxos(addressOrCredential: Parameters<FixtureProvider['getUtxos']>[0]): Promise<Utxo[]> {
    if (typeof addressOrCredential !== 'string') throw new Error('ChainView: credential queries are not supported offline');
    return this.held.filter((u) => u.address === addressOrCredential);
  }

  async getUtxosByOutRef(outRefs: Parameters<FixtureProvider['getUtxosByOutRef']>[0]): Promise<Utxo[]> {
    return this.held.filter((u) => outRefs.some((r) => r.txHash === u.txHash && Number(r.outputIndex) === u.outputIndex));
  }

  async getNetworkTip(): Promise<{ slot: number; hash: string }> {
    return { slot: this.tipSlot, hash: '' };
  }

  async evaluateTx(txCborHex: string, additional: Utxo[] = []): Promise<Redeemer[]> {
    this.evaluations.push(txCborHex);
    if (this.refuseEvaluationWith !== null) throw ogmiosRefusal(this.refuseEvaluationWith);
    const params = fixtureProtocolParameters();
    let results: Uint8Array[];
    try {
      results = UPLC.eval_phase_two_raw(
        Buffer.from(txCborHex, 'hex'), additional.map((u) => lucid.utxoToTransactionInput(u).to_cbor_bytes()), additional.map((u) => lucid.utxoToTransactionOutput(u).to_cbor_bytes()),
        lucid.createCostModels(params.costModels).to_cbor_bytes(), BigInt(params.maxTxExSteps), BigInt(params.maxTxExMem), BigInt(SYSTEM_START_MS), 0n, 1000,
      );
    } catch (err) {
      throw ogmiosRefusal(err instanceof Error ? err.message : String(err));
    }
    return results.map((bytes) => {
      const r = lucid.CML.LegacyRedeemer.from_cbor_bytes(bytes);
      return { ex_units: { mem: Number(r.ex_units().mem()), steps: Number(r.ex_units().steps()) }, redeemer_index: Number(r.index()), redeemer_tag: TAGS[r.tag()]! };
    });
  }

  /** Applies a transaction to the world: its inputs are spent, and its outputs are held at its hash. */
  apply(signedCborHex: string): string {
    const body = decodeTransaction(signedCborHex).body();
    const txHash = hashOfTransaction(signedCborHex);
    const spent = new Set<string>();
    for (let i = 0; i < body.inputs().len(); i++) spent.add(`${body.inputs().get(i).transaction_id().to_hex()}#${body.inputs().get(i).index()}`);
    const missing = [...spent].filter((ref) => !this.held.some((u) => `${u.txHash}#${u.outputIndex}` === ref));
    if (missing.length > 0) throw new Error(`ChainView: the transaction spends outputs that the node does not hold: ${missing.join(', ')}`);
    this.held = this.held.filter((u) => !spent.has(`${u.txHash}#${u.outputIndex}`));
    const outputs = body.outputs();
    for (let i = 0; i < outputs.len(); i++) {
      const output = outputs.get(i);
      const assets: Record<string, bigint> = { lovelace: output.amount().coin() };
      const multi = output.amount().multi_asset();
      const policies = multi.keys();
      for (let p = 0; p < policies.len(); p++) {
        const policy = policies.get(p);
        const names = multi.get_assets(policy)!.keys();
        for (let n = 0; n < names.len(); n++) assets[`${policy.to_hex()}${names.get(n).to_hex()}`] = multi.get(policy, names.get(n))!;
      }
      const datum = output.datum()?.as_datum()?.to_cbor_hex();
      this.held.push({ txHash, outputIndex: i, address: output.address().to_bech32(), assets, ...(datum === undefined ? {} : { datum }) });
    }
    this.applied.push(signedCborHex);
    return txHash;
  }

  find(ref: string): Utxo | undefined {
    return this.held.find((u) => `${u.txHash}#${u.outputIndex}` === ref);
  }
}
