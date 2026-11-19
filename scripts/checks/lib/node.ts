// scripts/checks/lib/node.ts - the node of Vector for the checks: Ogmios for the outputs and the submit, Koios for the genesis and the status of a transaction.
// The network is read from two places that must agree: the indexer says the magic and the start of the genesis (a GET), and the node says the start of its chain.
import { parseOutRef } from './platform.ts';
import type { Utxo } from './platform.ts';
import type { NetworkFacts, NodeAccess, TxStatus } from './ports.ts';

/** The calls of the vendored provider that the checks use. The OgmiosProvider has them all. */
export interface NodeProvider {
  getUtxosByOutRef(refs: Array<{ txHash: string; outputIndex: number }>): Promise<Utxo[]>;
  submitTx(signedCborHex: string): Promise<string>;
  getKoiosTxStatus(txHash: string): Promise<unknown>;
  getSystemStartMs(): Promise<number>;
}

const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

export class VectorNode implements NodeAccess {
  readonly #provider: NodeProvider;
  readonly #koiosUrl: string;
  readonly #fetch: typeof fetch;

  constructor(options: { provider: NodeProvider; koiosUrl: string; fetchImpl?: typeof fetch }) {
    this.#provider = options.provider;
    let end = options.koiosUrl.length;
    while (end > 0 && options.koiosUrl[end - 1] === '/') end -= 1;
    this.#koiosUrl = options.koiosUrl.slice(0, end);
    this.#fetch = options.fetchImpl ?? fetch;
  }

  async networkFacts(): Promise<NetworkFacts> {
    const response = await this.#fetch(`${this.#koiosUrl}/api/v1/genesis`, { method: 'GET', headers: { accept: 'application/json' }, signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw new Error(`the indexer answered ${response.status} to the request for the genesis`);
    const rows: unknown = await response.json();
    const row = Array.isArray(rows) ? rows[0] : undefined;
    const magic = isObject(row) ? Number(row.networkmagic) : Number.NaN;
    const start = isObject(row) ? Number(row.systemstart) * 1000 : Number.NaN;
    if (!Number.isSafeInteger(magic) || magic < 0 || !Number.isSafeInteger(start) || start <= 0) throw new Error('the answer of the indexer is no genesis: it has no network magic or no start of the chain');
    const nodeStart = await this.#provider.getSystemStartMs();
    if (nodeStart !== start) throw new Error('the node and the indexer do not agree on the start of the chain, so they are not on the same chain');
    return { magic, systemStartMs: start };
  }

  resolveInputs(refs: readonly string[]): Promise<Utxo[]> {
    return this.#provider.getUtxosByOutRef(refs.map((ref) => parseOutRef(ref)));
  }

  submit(signedCborHex: string): Promise<string> {
    return this.#provider.submitTx(signedCborHex);
  }

  async txStatus(txHash: string): Promise<TxStatus> {
    const rows = await this.#provider.getKoiosTxStatus(txHash);
    const row = Array.isArray(rows) ? rows.find((candidate: unknown) => isObject(candidate) && candidate.tx_hash === txHash) : undefined;
    const confirmations = isObject(row) && typeof row.num_confirmations === 'number' ? row.num_confirmations : null;
    return { confirmations };
  }
}
