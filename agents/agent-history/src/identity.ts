import { koios, decodeIdentityDatum, decodeLegacyDatum, decodePlutusDataHex, encodePlutusDataHex, isAuthenticRecord } from '@vsa/vector-read';
import type { Fetch, KoiosTxInfo, Registries, Registry } from '@vsa/vector-read';
import type { Subject } from './subject.ts';
import { changesBetween, legacyEndChanges, marketplaceKeys, recordView } from './views.ts';
import { DEFAULT_CONFIG } from './config.ts';
import type { Changes, RecordContent, RecordView, RegistryKind } from './views.ts';
// One timeline across both registries (Part 2, section 10): the transactions of the identifier's token in the legacy registry and in the identity
// registry, read from Koios and decoded with the vendored codecs. The versions follow did:vector Part 1, section 7.2.
export interface At { tx: string; block: number; time: number }
export type TimelineEvent = 'registration' | 'adoption' | 'update' | 'value_change' | 'deregistration' | 'token_left' | 'token_returned';
export interface TimelineEntry extends At {
  registry: RegistryKind;
  event: TimelineEvent;
  /** The version the transaction made (Part 1, section 7.2), or null when it made none. */
  version: number | null;
  /** The lovelace of the record output the transaction left, or null when it left none. */
  lovelace: string | null;
  changes: Changes;
}
export interface IdentitySection {
  /** native, adopted or legacy (Part 1, section 7.1); null when no registry minted the identifier. */
  origin: 'native' | 'adopted' | 'legacy' | null;
  /** The transaction that first minted the identifier, in either registry. */
  registered: (At & { registry: RegistryKind }) | null;
  adopted: At | null;
  /** The legacy deregistration that ended a legacy record. */
  deregistered: At | null;
  /** The record an authentic output holds now: null when there is none, the record ended, or the token is outside its registry address. */
  record: RecordView | null;
  timeline: TimelineEntry[];
}
// The identity section, and the one value the report needs that is not part of it: the keys of the newest version that named a marketplace key
// (marketplaceKeys), whether or not the record is still there. The marketplace section is read with them when the subject has no live record that
// names one. Empty when no version named one.
export interface IdentityTimeline { section: IdentitySection; last_marketplace_pkhs: string[] }
const EMPTY: IdentitySection = { origin: null, registered: null, adopted: null, deregistered: null, record: null, timeline: [] };
// The one test for "this datum has bytes": null, undefined and the empty string all mean the bytes are not there.
const bytesOf = (d: { bytes?: string | null } | null | undefined): string | null => (d?.bytes ? d.bytes : null);
const refOf = (txHash: string, index: number) => `${txHash}#${index}`;
const quantity = (list: Array<{ policy_id: string; asset_name: string; quantity: string }> | null | undefined, policy: string, name: string) =>
  (list ?? []).reduce((n, a) => (a.policy_id === policy && a.asset_name === name ? n + BigInt(a.quantity) : n), 0n);
const ledgerOrder = (a: KoiosTxInfo, b: KoiosTxInfo) => a.block_height - b.block_height || a.tx_block_index - b.tx_block_index;

export async function identitySection(s: Subject, f: Fetch, registries?: Registries): Promise<IdentitySection> {
  return (await identityTimeline(s, f, registries)).section;
}
export async function identityTimeline(s: Subject, f: Fetch, registries: Registries = DEFAULT_CONFIG.registries): Promise<IdentityTimeline> {
  const id = s.asset_name;
  if (!id) return { section: EMPTY, last_marketplace_pkhs: [] };
  const { legacy, identity } = registries;
  const [legacyList, identityList] = await Promise.all([koios.assetTxs(legacy.policy, id, f), identity ? koios.assetTxs(identity.policy, id, f) : []]);
  const legacyTxs = new Set(legacyList.map((t) => t.tx_hash)), identityTxs = new Set(identityList.map((t) => t.tx_hash));
  const wanted = [...new Set([...legacyTxs, ...identityTxs])];
  if (wanted.length === 0) return { section: EMPTY, last_marketplace_pkhs: [] };
  const infos = await koios.txInfo(wanted, f);
  const byHash = new Map(infos.map((t) => [t.tx_hash, t]));
  // Oldest first. Transactions of one block are told apart by their position in it (asset_txs lists newest first).
  const ordered = wanted.map((h) => {
    const tx = byHash.get(h);
    if (!tx) throw new Error(`tx ${h} listed by asset_txs but not returned by tx_info`);
    return tx;
  }).sort(ledgerOrder);
  const minting = (reg: Registry) => ordered.find((tx) => quantity(tx.assets_minted, reg.policy, id) > 0n) ?? null;
  const legacyMint = minting(legacy), identityMint = identity ? minting(identity) : null;
  // Part 1, section 7.1: an identity-registry record is adopted when the transaction that minted its token burned the legacy token.
  const origin = identityMint ? (quantity(identityMint.assets_minted, legacy.policy, id) < 0n ? 'adopted' : 'native') : legacyMint ? 'legacy' : null;
  if (origin === null) return { section: EMPTY, last_marketplace_pkhs: [] };
  if (origin === 'adopted' && !legacyMint) throw new Error(`the adoption ${identityMint!.tx_hash} burned a legacy token that Koios lists no mint for`);
  // The transactions of the record, each with the registry whose token it moves: the legacy ones from the legacy mint up to the adoption, then the
  // identity ones from the identity mint on. A native record has no legacy history.
  const steps: Array<{ tx: KoiosTxInfo; registry: RegistryKind }> = [];
  if (origin !== 'native' && legacyMint) {
    for (const tx of ordered) {
      if (!legacyTxs.has(tx.tx_hash) || ledgerOrder(tx, legacyMint) < 0) continue;
      if (identityMint && ledgerOrder(tx, identityMint) >= 0) break;
      steps.push({ tx, registry: 'legacy' });
    }
  }
  if (identity && identityMint) for (const tx of ordered) if (identityTxs.has(tx.tx_hash) && ledgerOrder(tx, identityMint) >= 0) steps.push({ tx, registry: 'identity' });
  const registryOf = (kind: RegistryKind) => (kind === 'legacy' ? legacy : identity!);
  const recordOutput = (tx: KoiosTxInfo, kind: RegistryKind) => tx.outputs.find((o) => isAuthenticRecord(o.payment_addr.bech32, o.asset_list, registryOf(kind), id));
  // Legacy datums are posted by hash, so tx_info shows no inline bytes for them; utxo_info (extended) resolves the bytes. Identity records hold inline datums.
  const resolved = new Map<string, string>();
  const unread = steps.flatMap(({ tx, registry }) => { const o = registry === 'legacy' ? recordOutput(tx, registry) : undefined; return o && !bytesOf(o.inline_datum) ? [refOf(tx.tx_hash, o.tx_index)] : []; });
  if (unread.length) for (const u of await koios.utxoInfo(unread, f)) { const b = bytesOf(u.inline_datum); if (b) resolved.set(refOf(u.tx_hash, u.tx_index), b); }

  const timeline: TimelineEntry[] = [];
  let last: { content: RecordContent; canonical: string } | null = null; // the datum of the last authentic record output
  let authentic = false, version = -1, ended = false, lastKeys: string[] = [];
  for (const { tx, registry } of steps) {
    if (ended) break;
    const reg = registryOf(registry);
    const at: At = { tx: tx.tx_hash, block: tx.block_height, time: tx.tx_timestamp };
    const record = recordOutput(tx, registry);
    if (record) {
      const ref = refOf(tx.tx_hash, record.tx_index);
      const bytes = bytesOf(record.inline_datum) ?? (registry === 'legacy' ? resolved.get(ref) : undefined);
      if (!bytes) throw new Error(`${registry === 'legacy' ? 'registry' : 'identity record'} datum at ${ref} could not be read`);
      const content: RecordContent = registry === 'legacy' ? { registry, datum: decodeLegacyDatum(bytes) } : { registry, datum: decodeIdentityDatum(bytes) };
      // Part 1, section 7.2: a version starts when the datum differs, as Plutus Data, from the last authentic record output; the adoption is always one.
      const canonical = encodePlutusDataHex(decodePlutusDataHex(bytes));
      const adoption = registry === 'identity' && origin === 'adopted' && tx.tx_hash === identityMint?.tx_hash;
      const changed = last === null || adoption || canonical !== last.canonical;
      const event: TimelineEvent = last === null ? (adoption ? 'adoption' : 'registration') : adoption ? 'adoption' : !authentic ? 'token_returned' : changed ? 'update' : 'value_change';
      if (changed) version++;
      timeline.push({ ...at, registry, event, version: changed ? version : null, lovelace: record.value, changes: changed ? changesBetween(last?.content ?? null, content) : {} });
      last = { content, canonical }; authentic = true;
      const keys = marketplaceKeys(content);
      if (keys.length) lastKeys = keys;
    } else if (tx.outputs.some((o) => quantity(o.asset_list, reg.policy, id) > 0n)) {
      // The token is in an output that is not an authentic record (Part 1, section 7.3, rule 6). The record continues when it comes back.
      timeline.push({ ...at, registry, event: 'token_left', version: null, lovelace: null, changes: {} });
      authentic = false;
    } else if (quantity(tx.assets_minted, reg.policy, id) < 0n) {
      if (registry === 'identity') throw new Error(`the identity token was burned in ${tx.tx_hash}, which the identity registry never does`);
      version++;
      timeline.push({ ...at, registry, event: 'deregistration', version, lovelace: null, changes: legacyEndChanges(tx.tx_timestamp * 1000) });
      authentic = false; ended = true;
    }
    // Otherwise the transaction did not move the token.
  }
  // The first mint: the legacy one of a legacy or adopted record, the identity one of a native record.
  const firstMint = (origin === 'native' ? identityMint : legacyMint)!;
  const end = timeline.find((e) => e.event === 'deregistration');
  return {
    section: {
      origin,
      registered: { tx: firstMint.tx_hash, block: firstMint.block_height, time: firstMint.tx_timestamp, registry: origin === 'native' ? 'identity' : 'legacy' },
      adopted: origin === 'adopted' && identityMint ? { tx: identityMint.tx_hash, block: identityMint.block_height, time: identityMint.tx_timestamp } : null,
      deregistered: end ? { tx: end.tx, block: end.block, time: end.time } : null,
      record: authentic && last ? recordView(last.content) : null,
      timeline,
    },
    last_marketplace_pkhs: lastKeys,
  };
}
