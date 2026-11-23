// Shared by the tests. The manifest needs one setting from the operator, OPERATOR_CONTACT, and has no default for it. Tests use an
// address on the reserved .test domain, never a real one.
export const TEST_CONTACT = 'ops@example.test';
export const TEST_ENV = { OPERATOR_CONTACT: TEST_CONTACT } as const;
import { encodeIdentityDatum, identityRegistryOf, blake2b224Hex, utf8ToHex, stakeTokenName, KOIOS_URL, LEGACY_REGISTRY, M3_REPUTATION_ADDRESS, REPUTATION_SCRIPT_HASH } from '@vsa/vector-read';
import type { Fetch, FixtureStore, IdentityDatum, Registry, StakeDatum } from '@vsa/vector-read';
import { DEFAULT_CONFIG } from '../src/config.ts';
import type { ReportConfig } from '../src/config.ts';

// A stand-in identity registry: its policy is blake2b-224 of a fixed text, as the gateway's test vectors do, and its address is derived from it.
export const TEST_IDENTITY: Registry = identityRegistryOf(blake2b224Hex(utf8ToHex('agent-history test identity registry')), undefined)!;
export const WITH_IDENTITY: ReportConfig = { ...DEFAULT_CONFIG, registries: { legacy: LEGACY_REGISTRY, identity: TEST_IDENTITY } };
export const LEGACY = LEGACY_REGISTRY;

// An identity registry record (Part 1, section 5) with every field set to a plain value; a test overrides what it is about.
export const CONTROLLER = '11'.repeat(32);
export function identityDatum(over: Partial<IdentityDatum> = {}): IdentityDatum {
  return {
    controller: CONTROLLER, keys: [], parties: [{ role: 'Accountable', signer: { type: 'ControllerSet' }, organisation: null, notBefore: 0, notAfter: null, rights: 3, removalAfter: null }],
    guardianThreshold: 0, pendingRecovery: null, lineage: { type: 'Root' }, subagentEpoch: 0,
    name: utf8ToHex('Agent'), description: utf8ToHex('A test agent.'), framework: utf8ToHex('fw'), endpoint: utf8ToHex('https://agent.example'),
    capabilities: [utf8ToHex('x.y.v1')], createdAt: 1_800_000_000_000, status: { type: 'Active' }, ...over,
  };
}
export const identityHex = (over: Partial<IdentityDatum> = {}) => encodeIdentityDatum(identityDatum(over));

// ---- A small ledger that answers the Koios calls of the service ----
// Each transaction spends earlier outputs by reference and makes outputs; Koios's answers are computed from them the way Koios builds them:
// asset_txs lists the transactions that touched an asset, newest first; tx_info leaves the bytes of every datum out (inline_datum.bytes null)
// unless the call sets both _scripts and _bytecode, as the Koios of Vector mainnet answers (checked on 2026-11-03); the extended asset_utxos,
// utxo_info and address_utxos give the bytes. A call about something the ledger holds nothing of (an asset, a transaction, an
// output or an address it never saw) goes to the fallback when there is one, and is otherwise answered as Koios answers it, with no rows.
// A call that is not a Koios POST goes to the fallback (without one it fails the test).
export interface Asset { policy_id: string; asset_name: string; quantity: string }
export interface LedgerOut { address: string; value?: string; assets?: Asset[]; datum?: string }
export interface LedgerTx { hash: string; block: number; index?: number; time?: number; spends?: string[]; outputs: LedgerOut[]; mint?: Asset[] }
export const token = (reg: Registry, name: string, quantity = '1'): Asset => ({ policy_id: reg.policy, asset_name: name, quantity });
export const txHash = (n: number) => n.toString(16).padStart(64, '0');
export function koiosLedger(txs: LedgerTx[], fallback?: Fetch): Fetch {
  const outputs = new Map<string, { tx: LedgerTx; index: number; out: LedgerOut }>();
  for (const tx of txs) tx.outputs.forEach((out, index) => outputs.set(`${tx.hash}#${index}`, { tx, index, out }));
  const spent = new Set(txs.flatMap((tx) => tx.spends ?? []));
  const order = (a: LedgerTx, b: LedgerTx) => b.block - a.block || (b.index ?? 0) - (a.index ?? 0); // newest first
  const holds = (assets: Asset[] | undefined, policy: string, name: string) => (assets ?? []).some((a) => a.policy_id === policy && a.asset_name === name);
  const utxo = (ref: string) => {
    const o = outputs.get(ref);
    if (!o) return null;
    return { tx_hash: o.tx.hash, tx_index: o.index, address: o.out.address, value: o.out.value ?? '10000000', block_height: o.tx.block, inline_datum: o.out.datum ? { bytes: o.out.datum } : null, asset_list: o.out.assets ?? [], is_spent: spent.has(ref) };
  };
  const txInfo = (tx: LedgerTx, withBytes: boolean) => ({
    tx_hash: tx.hash, block_height: tx.block, tx_block_index: tx.index ?? 0, tx_timestamp: tx.time ?? tx.block * 10,
    // Only the outputs the ledger made are inputs it can show; a wallet input of a test is not modelled.
    inputs: (tx.spends ?? []).flatMap((ref) => { const o = outputs.get(ref); return o ? [{ tx_hash: o.tx.hash, tx_index: o.index, payment_addr: { cred: 'x', bech32: o.out.address }, value: o.out.value ?? '10000000', asset_list: o.out.assets ?? [] }] : []; }),
    outputs: tx.outputs.map((out, index) => ({
      tx_index: index, payment_addr: { cred: 'x', bech32: out.address }, value: out.value ?? '10000000', asset_list: out.assets ?? [],
      datum_hash: out.datum ? 'dd'.repeat(32) : null, inline_datum: out.datum ? { bytes: withBytes ? out.datum : null, value: null } : null,
    })),
    assets_minted: tx.mint ?? [],
  });
  const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  const touches = (tx: LedgerTx, policy: string, name: string) => tx.outputs.some((o) => holds(o.assets, policy, name)) || (tx.spends ?? []).some((r) => holds(outputs.get(r)?.out.assets, policy, name)) || holds(tx.mint, policy, name);
  // The rows of a call, or null when the ledger holds nothing the call asks about.
  const answer = (endpoint: string, body: any, offset: number): unknown[] | null => {
    switch (endpoint) {
      case 'asset_txs': {
        const listed = txs.filter((tx) => touches(tx, body._asset_policy, body._asset_name));
        return listed.length ? listed.sort(order).map((tx) => ({ tx_hash: tx.hash, block_height: tx.block, block_time: tx.time ?? tx.block * 10 })) : null;
      }
      case 'tx_info': {
        const found = (body._tx_hashes as string[]).map((h) => txs.find((tx) => tx.hash === h)).filter((tx): tx is LedgerTx => tx !== undefined);
        return found.length ? found.map((tx) => txInfo(tx, body._scripts === true && body._bytecode === true)) : null;
      }
      case 'asset_utxos': {
        const assets = body._asset_list as string[][];
        if (!assets.some(([p, n]) => txs.some((tx) => touches(tx, p, n)))) return null;
        return [...outputs.keys()].filter((ref) => !spent.has(ref) && assets.some(([p, n]) => holds(outputs.get(ref)!.out.assets, p, n))).map(utxo);
      }
      case 'utxo_info': {
        const found = (body._utxo_refs as string[]).map(utxo).filter((x) => x !== null);
        return found.length ? found : null;
      }
      case 'address_utxos': {
        const addresses = body._addresses as string[];
        if (![...outputs.values()].some((o) => addresses.includes(o.out.address))) return null;
        return [...outputs.keys()].filter((ref) => !spent.has(ref) && addresses.includes(outputs.get(ref)!.out.address)).map(utxo).slice(offset, offset + 1_000);
      }
      default: throw new Error(`ledger: no answer for ${endpoint}`);
    }
  };
  return (async (url: any, init?: RequestInit) => {
    const u = String(url);
    if (!u.startsWith(`${KOIOS_URL}/`) || init?.method !== 'POST') {
      if (fallback) return fallback(url, init);
      throw new Error(`ledger: no answer for ${u}`);
    }
    const [endpoint, query] = u.slice(KOIOS_URL.length + 1).split('?');
    const rows = answer(endpoint, JSON.parse(String(init.body)), Number(new URLSearchParams(query ?? '').get('offset') ?? 0));
    if (rows === null && fallback) return fallback(url, init);
    return ok(rows ?? []);
  }) as Fetch;
}

// ---- The Module-3 deployment on the identity registry ----
// The stake of these tests is a recorded one: the output 48d4ce7b...#0 at the stake address on Vector mainnet, as Koios gave it (`utxo_info`, extended) on 2026-11-23. It is the
// stake of a test record of the Foundation. RECORDED_STAKE_HEX is the inline datum of that output, byte for byte. RECORDED_STAKE holds the fields that it decodes to.
// packages/vector-read/test/reputation-datum.test.ts holds the same datum and pins the codec to it. When the layout of the datum changes, take the inline datum of a stake
// of the new layout from Koios, and put it in RECORDED_STAKE_HEX and the fields that it decodes to in RECORDED_STAKE, here and in that file.
export const RECORDED_STAKE: StakeDatum = {
  agent_did: '4e1272ee30e5bdf5ad75be55553563a7056ab228295c70ffda988892da4a8fe9', owner_pkh: '34267e928e17c77063ee4957b6932182b7d804ed1d3f77c3f4121682',
  stake_amount: 11_000_000n, staked_capabilities: [Buffer.from('smoke.stake-check.a.v1').toString('hex'), Buffer.from('smoke.stake-check.b.v1').toString('hex')],
  last_updated: 1_795_425_911_000, history_points: 0n, challenge_locks: [], stake_id: { txHash: 'c4ec66206f6f917519f411f9fbab1d709c918b30acf6bc7951759a513fa22c8c', outputIndex: 0 },
};
export const RECORDED_STAKE_HEX = 'd8799f58204e1272ee30e5bdf5ad75be55553563a7056ab228295c70ffda988892da4a8fe9d8799f581c34267e928e17c77063ee4957b6932182b7d804ed1d3f77c3f4121682ff1a00a7d8c09f56736d6f6b652e7374616b652d636865636b2e612e763156736d6f6b652e7374616b652d636865636b2e622e7631ff1b000001a207b940d80080d8799f5820c4ec66206f6f917519f411f9fbab1d709c918b30acf6bc7951759a513fa22c8c00ffff';
export const addressKey = (address: string) => `POST ${KOIOS_URL}/address_utxos ${JSON.stringify({ _addresses: [address], _extended: true })}`;
/** The stake token of an agent, as Koios lists it in `asset_list`. */
export const stakeToken = (agentId: string, quantity = '1'): Asset => ({ policy_id: REPUTATION_SCRIPT_HASH, asset_name: stakeTokenName(agentId), quantity });
/** A row of the extended Koios `address_utxos` answer: an output at the stake address. */
export interface StakeRow { tx_hash: string; tx_index: number; address: string; value: string; block_height: number; inline_datum: { bytes: string } | null; asset_list: Asset[] | null }
/** The row of an output at the stake address. `n` makes its transaction hash. */
export const stakeRow = (n: number, datum: string | null, assets: Asset[] | null): StakeRow => ({
  tx_hash: txHash(n), tx_index: 0, address: M3_REPUTATION_ADDRESS, value: '12000000', block_height: 9_100_000 + n, inline_datum: datum === null ? null : { bytes: datum }, asset_list: assets,
});
/** `store` with the stake address answering with `rows`. */
export const withStakeRows = (store: FixtureStore, rows: unknown[]): FixtureStore => ({ ...store, [addressKey(M3_REPUTATION_ADDRESS)]: { status: 200, body: JSON.stringify(rows) } });
/** The one token of the recorded stake output, as Koios lists it in `asset_list`: the policy of the reputation validator, and the name that the codec derives from the agent of the datum. */
export const RECORDED_STAKE_ASSET: Asset = { policy_id: 'fad945ab20f61a58fbdf6a33a8f491899b7dd4167fb64200bc060424', asset_name: '7273746b5f1b98065ee43002664ff55bc12bba527c45b233b80cd7a4517e1581', quantity: '1' };
/** The recorded stake output as a row of the extended Koios `address_utxos` answer: its reference, address, value, block, inline datum and token. */
export const RECORDED_STAKE_ROW: StakeRow = {
  tx_hash: '48d4ce7bbd9141a0e5787af08a2cb14aa6c75b64134f874fa64bc8a4155eb6ad', tx_index: 0, address: 'addr1w8adj3dtyrmp5k8mma4r8285jxyeklw5zelmvssqhsrqgfqc9uavs', value: '11000000',
  block_height: 9_609_690, inline_datum: { bytes: RECORDED_STAKE_HEX }, asset_list: [RECORDED_STAKE_ASSET],
};
/** `store` with the recorded stake output at the stake address, and with no legacy registry record of the agent that its datum names: a report for that agent has a stake and no record. */
export const withRecordedStake = (store: FixtureStore): FixtureStore => ({
  ...withStakeRows(store, [RECORDED_STAKE_ROW]),
  [`POST ${KOIOS_URL}/asset_utxos ${JSON.stringify({ _asset_list: [[LEGACY_REGISTRY.policy, RECORDED_STAKE.agent_did]], _extended: true })}`]: { status: 200, body: '[]' },
});
