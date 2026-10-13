import { KOIOS_URL } from './constants.ts';
export type Fetch = typeof fetch;
const H = { accept: 'application/json', 'content-type': 'application/json', 'user-agent': 'vector-service-agents' };
export async function post<T>(path: string, body: unknown, fetchImpl: Fetch = fetch, timeoutMs = 20_000): Promise<T> {
  const res = await fetchImpl(`${KOIOS_URL}/${path}`, { method: 'POST', headers: H, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`Koios ${path} answered ${res.status}`);
  return (await res.json()) as T;
}
export async function get<T>(path: string, fetchImpl: Fetch = fetch, timeoutMs = 20_000): Promise<T> {
  const res = await fetchImpl(`${KOIOS_URL}/${path}`, { headers: H, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`Koios ${path} answered ${res.status}`);
  return (await res.json()) as T;
}
export interface KoiosUtxo { tx_hash: string; tx_index: number; address?: string; value: string; block_height?: number; block_time?: number; is_spent?: boolean; inline_datum?: { bytes: string } | null; asset_list?: Array<{ policy_id: string; asset_name: string; quantity: string }> | null; reference_script?: { hash: string; bytes: string } | null }
export interface KoiosTxInfo { tx_hash: string; block_height: number; tx_timestamp: number; inputs: Array<{ tx_hash: string; tx_index: number; payment_addr: { cred: string; bech32: string }; value: string; asset_list?: Array<{ policy_id: string; asset_name: string; quantity: string }> }>; outputs: Array<{ tx_index: number; payment_addr: { cred: string; bech32: string }; value: string; inline_datum: { bytes: string } | null; asset_list?: Array<{ policy_id: string; asset_name: string; quantity: string }> }>; assets_minted?: Array<{ policy_id: string; asset_name: string; quantity: string }> }
export const koios = {
  post,
  tip: (f?: Fetch) => get<Array<{ block_no: number; abs_slot: number; block_time: number; hash: string }>>('tip', f),
  assetUtxos: (policy: string, name: string, f?: Fetch) => post<KoiosUtxo[]>('asset_utxos', { _asset_list: [[policy, name]], _extended: true }, f),
  assetHistory: (policy: string, name: string, f?: Fetch) => post<Array<{ minting_txs: Array<{ tx_hash: string; quantity: string; block_time: number }> }>>('asset_history', { _asset_policy: policy, _asset_name: name }, f),
  assetTxs: (policy: string, name: string, f?: Fetch) => post<Array<{ tx_hash: string; block_height: number; block_time: number }>>('asset_txs', { _asset_policy: policy, _asset_name: name, _history: true }, f),
  txInfo: (hashes: string[], f?: Fetch) => post<KoiosTxInfo[]>('tx_info', { _tx_hashes: hashes }, f),
  addressUtxos: (addresses: string[], f?: Fetch) => post<KoiosUtxo[]>('address_utxos', { _addresses: addresses, _extended: true }, f, 40_000),
  utxoInfo: (refs: string[], f?: Fetch) => post<KoiosUtxo[]>('utxo_info', { _utxo_refs: refs, _extended: true }, f),
};
