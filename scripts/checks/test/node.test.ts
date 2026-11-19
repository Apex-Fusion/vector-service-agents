// The node of Vector as the checks see it: the facts of its network, the outputs of the ledger, the submit, and the status of a transaction. The provider and the fetch are fakes.
import { describe, expect, it } from 'vitest';
import { VectorNode } from '../lib/node.ts';
import type { NodeProvider } from '../lib/node.ts';

const GENESIS = [{ networkmagic: '764824073', networkid: 'Mainnet', activeslotcoeff: '0.25', epochlength: '86400', systemstart: 1756485600, slotlength: '1' }];
const reply = (body: unknown, status = 200): typeof fetch => (async () => new Response(JSON.stringify(body), { status })) as typeof fetch;
const provider = (over: Partial<NodeProvider> = {}): NodeProvider => ({
  getUtxosByOutRef: async () => [], submitTx: async () => 'ab'.repeat(32), getKoiosTxStatus: async () => [], getSystemStartMs: async () => 1_756_485_600_000, ...over,
});

describe('networkFacts', () => {
  it('gives the magic of the genesis and the start of the chain when the node and the indexer agree', async () => {
    const node = new VectorNode({ provider: provider(), koiosUrl: 'https://koios.example/', fetchImpl: reply(GENESIS) });
    expect(await node.networkFacts()).toEqual({ magic: 764_824_073, systemStartMs: 1_756_485_600_000 });
  });
  it('asks the genesis of the indexer with a GET', async () => {
    const seen: string[] = [];
    const fetchImpl = (async (input: unknown, init?: RequestInit) => { seen.push(`${init?.method ?? 'GET'} ${String(input)}`); return new Response(JSON.stringify(GENESIS)); }) as typeof fetch;
    await new VectorNode({ provider: provider(), koiosUrl: 'https://koios.example/', fetchImpl }).networkFacts();
    expect(seen).toEqual(['GET https://koios.example/api/v1/genesis']);
  });
  it('refuses a node and an indexer that do not agree on the start of the chain', async () => {
    const node = new VectorNode({ provider: provider({ getSystemStartMs: async () => 1_700_000_000_000 }), koiosUrl: 'https://koios.example', fetchImpl: reply(GENESIS) });
    await expect(node.networkFacts()).rejects.toThrow(/do not agree/);
  });
  it('refuses an answer that is no genesis, and an error of the indexer', async () => {
    await expect(new VectorNode({ provider: provider(), koiosUrl: 'https://koios.example', fetchImpl: reply([]) }).networkFacts()).rejects.toThrow(/genesis/);
    await expect(new VectorNode({ provider: provider(), koiosUrl: 'https://koios.example', fetchImpl: reply([{ networkmagic: 'x', systemstart: 1 }]) }).networkFacts()).rejects.toThrow(/genesis/);
    await expect(new VectorNode({ provider: provider(), koiosUrl: 'https://koios.example', fetchImpl: reply({ error: 'x' }, 500) }).networkFacts()).rejects.toThrow(/500/);
  });
});

describe('txStatus', () => {
  const hash = 'cd'.repeat(32);
  const statusOf = async (rows: unknown) => new VectorNode({ provider: provider({ getKoiosTxStatus: async () => rows }), koiosUrl: 'https://koios.example', fetchImpl: reply([]) }).txStatus(hash);
  it('gives the confirmations that the indexer counts, and null for a transaction that it does not know', async () => {
    expect(await statusOf([{ tx_hash: hash, num_confirmations: 7 }])).toEqual({ confirmations: 7 });
    expect(await statusOf([{ tx_hash: hash, num_confirmations: 0 }])).toEqual({ confirmations: 0 });
    expect(await statusOf([])).toEqual({ confirmations: null });
    expect(await statusOf([{ tx_hash: hash, num_confirmations: null }])).toEqual({ confirmations: null });
    expect(await statusOf([{ tx_hash: 'ef'.repeat(32), num_confirmations: 9 }])).toEqual({ confirmations: null });
    expect(await statusOf('not a list')).toEqual({ confirmations: null });
  });
});

describe('resolveInputs and submit', () => {
  it('asks the ledger for the outputs by reference, and passes a submit on', async () => {
    const asked: unknown[] = [];
    const sent: string[] = [];
    const node = new VectorNode({
      provider: provider({ getUtxosByOutRef: async (refs) => { asked.push(refs); return []; }, submitTx: async (cbor) => { sent.push(cbor); return 'ab'.repeat(32); } }),
      koiosUrl: 'https://koios.example', fetchImpl: reply([]),
    });
    await node.resolveInputs([`${'ab'.repeat(32)}#2`]);
    expect(asked).toEqual([[{ txHash: 'ab'.repeat(32), outputIndex: 2 }]]);
    expect(await node.submit('84a4')).toBe('ab'.repeat(32));
    expect(sent).toEqual(['84a4']);
  });
});
