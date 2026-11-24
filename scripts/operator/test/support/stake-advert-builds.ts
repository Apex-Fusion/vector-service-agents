// The fake builds of a stake and of an advert, the fake `fetch` of the manifests and the statuses, and the world that the tests of the tasks `stake` and `advert` run in.
// No builder of buyer-core builds a stake or an advert. So the fake tools write a plain transaction body (no script runs in it) whose inputs, outputs, mint, signers and validity equal what the
// live tools build: the opening output with the datum of 8 fields; the stake output with that datum and the stake token, spending the opening output; the advert output with its datum and NO
// token; the retirement of an advert. The real guards judge these bytes. The answers have the format of the live tools. A test changes what a tool builds with `twist`.
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { keyCredentialOf } from '../../../checks/lib/addresses.ts';
import { iso } from '../../../checks/lib/format.ts';
import { HostedError, checkArguments } from '../../../checks/lib/hosted.ts';
import type { ToolAnswer } from '../../../checks/lib/hosted.ts';
import type { ChainAccess } from '../../../checks/lib/session.ts';
import { factsOf } from '../../../checks/lib/txfacts.ts';
import { SYSTEM_START_MS } from '../../../checks/test/support/chain-view.ts';
import { DEPLOYMENT } from '../../../checks/test/support/world.ts';
import { recordUtxo, rootRecord } from '../../../../packages/buyer-core/test/fixtures/identity-world.ts';
import { decodeIdentityAdvertDatum, encodeIdentityAdvertDatum } from '../../../../packages/vector-read/src/datum.ts';
import type { IdentityAdvertDatum } from '../../../../packages/vector-read/src/datum.ts';
import { utf8Hex } from '../../../../packages/vector-read/src/identity-codec.ts';
import type { IdentityDatum } from '../../../../packages/vector-read/src/identity-codec.ts';
import { REPUTATION_ADDRESS, REPUTATION_SCRIPT_HASH, SEED_STAKE_ID, decodeStakeDatum, encodeStakeDatum, stakeTokenName } from '../../../../packages/vector-read/src/reputation-datum.ts';
import type { StakeDatum } from '../../../../packages/vector-read/src/reputation-datum.ts';
import type { GoFile } from '../../lib/approval.ts';
import { StateFile } from '../../../checks/lib/state.ts';
import type { AdvertSpec, AgentSpec, TaskDefinition, UseCase } from '../../lib/contract.ts';
import { FactsFile } from '../../lib/facts.ts';
import { decodeTransaction, formatOutRef, lucidForAddress, parseOutRef } from '../../lib/platform.ts';
import type { Utxo } from '../../lib/platform.ts';
import { loadRegistry } from '../../lib/registry.ts';
import type { Registry } from '../../lib/registry.ts';
import { runTask } from '../../lib/runner.ts';
import USE from '../../usecases/inventory-reorder.ts';
import { World } from './fakes.ts';
import type { Handler } from './pack-hosted.ts';
import { PACK_SCHEMAS, PackHosted, liveBuildAnswer } from './pack-hosted.ts';
import { NOW, ScriptedNode, USE_CASE, hashOf, taskWorld } from './task-world.ts';
import type { TaskWorld } from './task-world.ts';

export { USE };
export const KEY_NAMES = USE.keys.map((key) => key.name);
export const SHARED = USE.keys.filter((key) => key.scope === 'shared').map((key) => key.name);
export const REORDER = USE.agents.find((agent) => agent.id === 'reorder-agent')!;
export const ORDER_DESK = USE.agents.find((agent) => agent.id === 'order-desk')!;
export const OPENING = 2_000_000n;
const MINUTE = 60_000;

// ---- bytes: a transaction body written with CML ----

type Item = unknown;
interface List { add(item: Item): void }
interface Body {
  set_ttl(slot: bigint): void; set_validity_interval_start(slot: bigint): void; set_mint(mint: Item): void; set_script_data_hash(hash: Item): void;
  set_collateral_inputs(list: Item): void; set_required_signers(list: Item): void;
  set_reference_inputs(list: Item): void;
}
interface Multi { set(policy: Item, name: Item, quantity: bigint): void }
/** The part of CML that the builds use. Its functions are static members named `new` in CML. */
interface Cml {
  TransactionHash: { from_hex(hex: string): Item };
  TransactionInput: { 'new'(hash: Item, index: bigint): Item };
  TransactionInputList: { 'new'(): List };
  TransactionOutputList: { 'new'(): List };
  TransactionOutput: { 'new'(address: Item, amount: Item, datum?: Item): Item };
  Address: { from_bech32(text: string): Item };
  Value: { 'new'(coin: bigint, assets: Item): Item };
  MultiAsset: { 'new'(): Multi };
  Mint: { 'new'(): Multi };
  ScriptHash: { from_hex(hex: string): Item };
  AssetName: { from_hex(hex: string): Item };
  DatumOption: { new_datum(data: Item): Item };
  PlutusData: { from_cbor_hex(hex: string): Item };
  Ed25519KeyHash: { from_hex(hex: string): Item };
  Ed25519KeyHashList: { 'new'(): List };
  ScriptDataHash: { from_hex(hex: string): Item };
  TransactionBody: { 'new'(inputs: Item, outputs: Item, fee: bigint): Body };
  TransactionWitnessSet: { 'new'(): { set_redeemers(redeemers: Item): void } };
  MapRedeemerKeyToRedeemerVal: { 'new'(): { insert(key: Item, value: Item): void } };
  RedeemerKey: { 'new'(tag: number, index: bigint): Item };
  RedeemerVal: { 'new'(datum: Item, units: Item): Item };
  Redeemers: { new_map_redeemer_key_to_redeemer_val(map: Item): Item };
  ExUnits: { 'new'(memory: bigint, steps: bigint): Item };
  Transaction: { 'new'(body: Item, witnesses: Item, valid: boolean): { to_cbor_hex(): string; body(): Item } };
  hash_transaction(body: Item): { to_hex(): string };
}
/** CML from the place of buyer-core, as the node of the tests does: the pack is no workspace package and names no package. */
// Lucid is the module that buyer-core pins, and the pack names no package: the module is read from the place of buyer-core. Its CML has the members above.
const lucidModule = createRequire(fileURLToPath(new URL('../../../../packages/buyer-core/package.json', import.meta.url)))('@lucid-evolution/lucid') as { CML: Cml };
const CML = lucidModule.CML;

interface TxOutput { address: string; lovelace: bigint; assets?: Record<string, bigint>; datum?: string }
type Ref = Pick<Utxo, 'txHash' | 'outputIndex'>;
interface TxSpec {
  wallet: string; inputs: readonly Utxo[]; collateral: readonly Utxo[]; outputs: readonly TxOutput[]; mint?: Record<string, bigint>; signers: readonly string[]; fee: bigint; validFrom: number; validTo: number;
  spend?: { readonly input: Ref; readonly reference: Ref; readonly redeemer: string };
}
interface Unsigned { txCbor: string; txHash: string; fee: bigint }

const unitParts = (unit: string): { policy: Item; name: Item } => ({ policy: CML.ScriptHash.from_hex(unit.slice(0, 56)), name: CML.AssetName.from_hex(unit.slice(56)) });
const inputOf = (utxo: Ref): Item => CML.TransactionInput.new(CML.TransactionHash.from_hex(utxo.txHash), BigInt(utxo.outputIndex));
const listOf = (utxos: readonly Ref[]): List => {
  const list = CML.TransactionInputList.new();
  for (const utxo of utxos) list.add(inputOf(utxo));
  return list;
};

/** An unsigned transaction: the inputs, the outputs and a change output to the wallet, the fee, the validity, the mint, the signers and, when the collateral is not empty, a script data hash (a script runs). */
function unsignedTx(spec: TxSpec): Unsigned {
  const held = spec.inputs.reduce((sum, utxo) => sum + (utxo.assets.lovelace ?? 0n), 0n);
  const paid = spec.outputs.reduce((sum, output) => sum + output.lovelace, 0n);
  const change = held - paid - spec.fee;
  if (change < 0n) throw new Error('the inputs of the fake build do not cover its outputs and its fee');
  const outputs = CML.TransactionOutputList.new();
  for (const output of [...spec.outputs, ...(change > 0n ? [{ address: spec.wallet, lovelace: change }] : [])]) {
    const assets = CML.MultiAsset.new();
    for (const [unit, quantity] of Object.entries(output.assets ?? {})) assets.set(unitParts(unit).policy, unitParts(unit).name, quantity);
    const datum = output.datum === undefined ? undefined : CML.DatumOption.new_datum(CML.PlutusData.from_cbor_hex(output.datum));
    outputs.add(CML.TransactionOutput.new(CML.Address.from_bech32(output.address), CML.Value.new(output.lovelace, assets), datum));
  }
  const body = CML.TransactionBody.new(listOf(spec.inputs), outputs, spec.fee);
  body.set_validity_interval_start(BigInt((spec.validFrom - SYSTEM_START_MS) / 1000));
  body.set_ttl(BigInt((spec.validTo - SYSTEM_START_MS) / 1000));
  const signers = CML.Ed25519KeyHashList.new();
  for (const hash of spec.signers) signers.add(CML.Ed25519KeyHash.from_hex(hash));
  if (spec.signers.length > 0) body.set_required_signers(signers);
  if (spec.mint !== undefined && Object.keys(spec.mint).length > 0) {
    const mint = CML.Mint.new();
    for (const [unit, quantity] of Object.entries(spec.mint)) mint.set(unitParts(unit).policy, unitParts(unit).name, quantity);
    body.set_mint(mint);
  }
  if (spec.collateral.length > 0) {
    body.set_collateral_inputs(listOf(spec.collateral));
    body.set_script_data_hash(CML.ScriptDataHash.from_hex('ab'.repeat(32)));
  }
  const witnesses = CML.TransactionWitnessSet.new();
  if (spec.spend !== undefined) {
    const { input, reference, redeemer } = spec.spend;
    body.set_reference_inputs(listOf([reference]));
    const ordered = [...spec.inputs].sort((a, b) => a.txHash.localeCompare(b.txHash) || a.outputIndex - b.outputIndex);
    const index = ordered.indexOf(input as Utxo);
    if (index < 0) throw new Error('the test has no input for its spend redeemer');
    const map = CML.MapRedeemerKeyToRedeemerVal.new();
    map.insert(CML.RedeemerKey.new(0, BigInt(index)), CML.RedeemerVal.new(CML.PlutusData.from_cbor_hex(redeemer), CML.ExUnits.new(1n, 1n)));
    witnesses.set_redeemers(CML.Redeemers.new_map_redeemer_key_to_redeemer_val(map));
  }
  const tx = CML.Transaction.new(body, witnesses, true);
  return { txCbor: tx.to_cbor_hex(), txHash: CML.hash_transaction(tx.body()).to_hex(), fee: spec.fee };
}

// ---- the manifests and the statuses ----

const jsonResponse = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const originOf = (url: string): string => new URL(url).origin;

/** The manifest of an agent as its service writes it, in the members that the advert is held to. */
export function manifestOf(agent: AgentSpec, did: string, hashOf_: (key: string) => string): Record<string, unknown> {
  const identity = { did, registry_address: '', supplier_key: `${did}#${hashOf_(agent.adverts[0]!.supplierKey)}` };
  if (agent.kind === 'reorder-agent') {
    const advert = agent.adverts[0]!;
    return {
      schema: 'vector.agent-manifest.v2', name: agent.name, capability_id: agent.capability, identity, keys: { supplier_pkh: hashOf_(advert.supplierKey) },
      terms: { price_lovelace: Number(advert.priceLovelace), supplier_bond_lovelace: Number(advert.supplierBondLovelace), buyer_bond_lovelace: Number(advert.buyerBondLovelace), max_processing_ms: advert.windowMs },
    };
  }
  return {
    schema: 'vector.agent-manifest.v2', name: agent.name, capability_id: agent.capability, identity, keys: { service_pkh: hashOf_(agent.serviceKey) },
    terms: {
      tiers: agent.adverts.map((advert) => ({
        model: advert.model, price_lovelace: Number(advert.priceLovelace), supplier_bond_lovelace: Number(advert.supplierBondLovelace), buyer_bond_lovelace: Number(advert.buyerBondLovelace),
        max_processing_ms: advert.windowMs, supplier_pkh: hashOf_(advert.supplierKey), endpoint: advert.origin,
      })),
    },
  };
}

/** A `fetch` for the manifests (`/agent.json`) and the statuses (`/status`) of the runtimes. It keeps each URL that it was asked for, and refuses any other address. */
interface ArchivedValue {
  tx_hash: string; tx_index: number; payment_addr: { bech32: string }; value: string;
  asset_list: { policy_id: string; asset_name: string; quantity: string }[];
  inline_datum?: { bytes: string };
}

interface ArchivedRetirement {
  tx_hash: string; fee: string; inputs: ArchivedValue[]; outputs: ArchivedValue[];
  plutus_contracts: { script_hash: string; spends_input: { tx_hash: string; tx_index: number }; valid_contract: boolean;
    input: { redeemer: { purpose: 'spend'; datum: { bytes: string } } } }[];
}

function archiveValue(tx_hash: string, tx_index: number, bech32: string, amount: bigint, assets: Record<string, bigint>, datum?: string | null): ArchivedValue {
  const asset_list = Object.entries(assets).filter(([unit]) => unit !== 'lovelace').map(([unit, quantity]) => (
    { policy_id: unit.slice(0, 56), asset_name: unit.slice(56), quantity: String(quantity) }
  ));
  return { tx_hash, tx_index, payment_addr: { bech32 }, value: String(amount), asset_list, ...(datum == null ? {} : { inline_datum: { bytes: datum } }) };
}

export class Net {
  readonly urls: string[] = [];
  readonly manifests = new Map<string, () => Response>();
  readonly statuses = new Map<string, () => Response>();
  retirement: (hash: string) => ArchivedRetirement | null = () => null;

  readonly fetchImpl = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    this.urls.push(url.href);
    if (url.origin === 'https://koios.test' && url.pathname === '/api/v1/tx_info') {
      if (init?.method !== 'POST' || typeof init.body !== 'string') throw new Error('the test expects a bounded tx_info request');
      const args = JSON.parse(init.body) as { _tx_hashes: string[]; _inputs: boolean; _scripts: boolean; _assets: boolean };
      if (args._tx_hashes.length !== 1 || !args._inputs || !args._scripts || !args._assets) throw new Error('the test expects one transaction with resolved spend details');
      const row = this.retirement(args._tx_hashes[0]!);
      return jsonResponse(row === null ? [] : [row]);
    }
    const held = url.pathname === '/agent.json' ? this.manifests : url.pathname === '/status' ? this.statuses : undefined;
    const answer = held?.get(url.origin);
    if (answer === undefined) throw new Error('the test fetch was asked for an address that it does not know');
    return answer();
  }) as typeof fetch;

  /** The requests for the status of a host. */
  statusReads(origin: string): number { return this.urls.filter((url) => url === `${origin}/status`).length; }
  /** The requests for the manifest of a host. */
  manifestReads(origin: string): number { return this.urls.filter((url) => url === `${origin}/agent.json`).length; }
}

// ---- the hosted tools ----

/** What a test changes in a build. Each member is for the tool that reads it. */
export interface Twist {
  /** The address that the opening, the stake or the advert output goes to. */
  address?: string;
  /** The key hash that the datum names as owner (opening and stake). */
  owner?: string;
  /** A payment from the wallet to another address, besides the planned outputs. */
  extra?: { address: string; lovelace: bigint };
  /** The key hashes that the build lists as required signers, in the body and in the answer. */
  signers?: readonly string[];
  /** A token that the build mints and puts on the advert output. */
  mint?: Record<string, bigint>;
  /** The output that the build spends instead of the one that it was asked for (create, retire). */
  spend?: string;
  /** The retirement redeemer of the test builder. */
  retireRedeemer?: string;
  /** The stake of the stake output, in lovelace. */
  stake?: bigint;
  /** The detail hash that the advert datum holds. */
  detailHash?: string;
  /** The reference of the opening output that the stake datum names as its `stake_id`. */
  stakeId?: string;
  /** The price that the advert datum holds. */
  price?: bigint;
  /** Members of the stake datum that the build changes, and no other part of the build (opening and stake). */
  stakeDatum?: Partial<StakeDatum>;
  /** Members of the advert datum that the build changes, and no other part of the build. */
  advertDatum?: Partial<IdentityAdvertDatum>;
  /** The assets of the stake output instead of the one stake token (the mint stays as planned). */
  assets?: Record<string, bigint>;
  /** The advert reference that the answer of the tool states (the bytes hold the true one). */
  claimRef?: string;
  /** The tool refuses with this text. */
  refuse?: string;
}
type ToolKey = 'open' | 'create' | 'post' | 'retire';

const TOOLS = {
  open: 'vector_build_reputation_stake_open', create: 'vector_build_reputation_stake', read: 'vector_get_reputation_stake', post: 'vector_build_marketplace_advert_post',
  retire: 'vector_build_marketplace_advert_retire', list: 'vector_marketplace_list_suppliers',
} as const;
const FEES: Record<ToolKey, bigint> = { open: 174_748n, create: 641_239n, post: 190_000n, retire: 250_000n };
const idOfDid = (did: unknown): string => String(did).slice('did:vector:'.length);
const hexOfText = (text: string): string => utf8Hex(text);

type Answer = Record<string, unknown> | { text: string; isError?: boolean };

/**
 * The hosted tools of the tests, held to the live schemas like `PackHosted`. The build tools write a transaction over the world at the time of the clock and answer in the live format; the
 * read tools answer from the world. `twist` changes a build, `after` runs after each build, `readTwist` changes the stake that the read shows, and `listLag` is the number of calls of the list
 * that show no advert yet (an indexer that is behind).
 */
export class StakeAdvertHosted extends PackHosted {
  readonly twist: Partial<Record<ToolKey, Twist>> = {};
  readonly built: Array<{ tool: string; txCbor: string; txHash: string }> = [];
  readTwist: (row: Record<string, unknown>) => Record<string, unknown> = (row) => row;
  /** Changes the arguments that the tool of a name gets, as a builder that ignores what it was asked for. */
  readonly bend: Record<string, (args: Record<string, unknown>) => Record<string, unknown>> = {};
  listLag = 0;
  rewriteRetirement: (row: ArchivedRetirement) => ArchivedRetirement | null = (row) => row;
  readonly #retiredInputs = new Map<string, ReadonlyMap<string, Utxo>>();
  readonly #world: World;
  readonly #now: () => number;
  readonly #controller: string;

  constructor(world: World, now: () => number, controllerHash: string) {
    super({});
    this.#world = world;
    this.#now = now;
    this.#controller = controllerHash;
  }

  archivedRetirement(hash: string): ArchivedRetirement | null {
    const inputs = this.#retiredInputs.get(hash);
    if (inputs === undefined) return null;
    const cbor = this.#world.chain.applied.find((bytes) => factsOf(bytes).txHash === hash);
    if (cbor === undefined) return null;
    const facts = factsOf(cbor);
    const tx = decodeTransaction(cbor);
    const redeemer = tx.witness_set().redeemers()!.to_flat_format().get(0);
    const ordered = [...facts.inputs].sort((a, b) => a.slice(0, 64).localeCompare(b.slice(0, 64)) || Number(a.slice(65)) - Number(b.slice(65)));
    const spent = ordered[Number(redeemer.index())]!;
    const ref = parseOutRef(spent);
    return this.rewriteRetirement({
      tx_hash: hash, fee: String(facts.feeLovelace),
      inputs: facts.inputs.map((regular) => {
        const item = inputs.get(regular)!;
        return archiveValue(item.txHash, item.outputIndex, item.address, item.assets.lovelace, item.assets, item.datum);
      }),
      outputs: facts.outputs.map(({ index, address, lovelace, assets, inlineDatum }) => archiveValue(hash, index, address, lovelace, assets, inlineDatum)),
      plutus_contracts: [{
        script_hash: DEPLOYMENT.advert.hash, spends_input: { tx_hash: ref.txHash, tx_index: ref.outputIndex }, valid_contract: tx.is_valid(),
        input: { redeemer: { purpose: 'spend', datum: { bytes: redeemer.data().to_cbor_hex() } } },
      }],
    });
  }

  override async call(name: string, args: Record<string, unknown>): Promise<ToolAnswer> {
    const sent = this.bend[name]?.(args) ?? args;
    const problems = checkArguments(name, PACK_SCHEMAS[name], sent);
    if (problems.length > 0) throw new HostedError('bad_arguments', problems.join('; '));
    const answer = this.#answer(name, sent);
    this.handlers[name] = (() => answer) satisfies Handler;
    return super.call(name, sent);
  }

  #answer(name: string, args: Record<string, unknown>): Answer {
    switch (name) {
      case TOOLS.open: return this.#build('open', args, () => this.#open(args));
      case TOOLS.create: return this.#build('create', args, () => this.#create(args));
      case TOOLS.post: return this.#build('post', args, () => this.#post(args));
      case TOOLS.retire: return this.#build('retire', args, () => this.#retire(args));
      case TOOLS.read: return this.#readStake(args);
      case TOOLS.list: return this.#list(args);
      default: throw new HostedError('unreachable', `the fake has no handler for ${name}`);
    }
  }

  #build(key: ToolKey, args: Record<string, unknown>, make: () => { spec: TxSpec; title: string; extra: Record<string, unknown> | ((built: Unsigned) => Record<string, unknown>); roles: Record<string, string> }): Answer {
    const refusal = this.twist[key]?.refuse;
    if (refusal !== undefined) return { text: refusal, isError: true };
    const { spec, title, extra, roles } = make();
    const built = unsignedTx(spec);
    this.built.push({ tool: TOOLS[key], txCbor: built.txCbor, txHash: built.txHash });
    if (key === 'retire') this.#retiredInputs.set(built.txHash, new Map(spec.inputs.map((input) => [formatOutRef(input.txHash, input.outputIndex), input])));
    const listed = this.twist[key]?.signers ?? [...new Set([...spec.signers, keyCredentialOf(String(args.changeAddress))!])];
    return liveBuildAnswer(title, {
      txCbor: built.txCbor, txHash: built.txHash, fee: built.fee.toString(), validFrom: spec.validFrom, validTo: spec.validTo,
      requiredSigners: listed.map((keyHash) => ({ keyHash, roles: [roles[keyHash] ?? 'signer'] })),
    }, typeof extra === 'function' ? extra(built) : extra);
  }

  /** The window of a build: it opens a minute before the second of the clock and ends 30 minutes after it. */
  #window(): { lo: number; hi: number } {
    const second = Math.floor(this.#now() / 1000) * 1000;
    return { lo: second - MINUTE, hi: second + 30 * MINUTE };
  }

  /** The outputs of the wallet: the output that pays the fee (the largest) and the collateral (a pure output of 5 units or more, the smallest). */
  #wallet(address: string): { pay: Utxo; collateral: Utxo } {
    const own = this.#world.chain.held.filter((utxo) => utxo.address === address && Object.keys(utxo.assets).length === 1).sort((a, b) => Number((a.assets.lovelace ?? 0n) - (b.assets.lovelace ?? 0n)));
    const collateral = own.find((utxo) => (utxo.assets.lovelace ?? 0n) >= 5_000_000n);
    const pay = own.at(-1);
    if (collateral === undefined || pay === undefined) throw new HostedError('unreachable', 'the wallet of the fake build holds no collateral output');
    return { pay, collateral };
  }

  #open(args: Record<string, unknown>) {
    const t = this.twist.open ?? {};
    const wallet = String(args.changeAddress);
    const { lo, hi } = this.#window();
    const id = idOfDid(args.did);
    const datum = encodeStakeDatum({
      agent_did: id, owner_pkh: t.owner ?? String(args.owner_key_hash), stake_amount: OPENING, staked_capabilities: (args.capabilities as string[]).map(hexOfText), last_updated: lo + MINUTE,
      history_points: 0n, challenge_locks: [], stake_id: SEED_STAKE_ID, ...t.stakeDatum,
    });
    const spec: TxSpec = {
      wallet, inputs: [this.#wallet(wallet).pay], collateral: [], signers: t.signers ?? [], fee: FEES.open, validFrom: lo, validTo: hi,
      outputs: [{ address: t.address ?? REPUTATION_ADDRESS, lovelace: OPENING, datum }, ...(t.extra === undefined ? [] : [t.extra])],
    };
    return { spec, title: 'Reputation Stake Opening', extra: (built: Unsigned) => ({ did: args.did, opening_ref: t.claimRef ?? `${built.txHash}#0` }), roles: { [keyCredentialOf(wallet)!]: 'wallet (inputs, fee and collateral)' } };
  }

  #create(args: Record<string, unknown>) {
    const t = this.twist.create ?? {};
    const wallet = String(args.changeAddress);
    const { lo, hi } = this.#window();
    const id = idOfDid(args.did);
    const refused = (): never => { throw new HostedError('unreachable', 'the fake create was asked to spend an output that the world does not hold'); };
    const spent = this.#world.chain.find(t.spend ?? String(args.opening_ref)) ?? refused();
    const named = (t.stakeId ?? String(args.opening_ref)).split('#');
    const owner = t.owner ?? String(args.owner_key_hash);
    const stake = t.stake ?? BigInt(Math.round(Number(args.amount) * 1_000_000));
    const unit = `${REPUTATION_SCRIPT_HASH}${stakeTokenName(id)}`;
    const datum = encodeStakeDatum({
      agent_did: id, owner_pkh: owner, stake_amount: stake, staked_capabilities: (args.capabilities as string[]).map(hexOfText), last_updated: hi, history_points: 0n, challenge_locks: [],
      stake_id: { txHash: named[0]!, outputIndex: Number(named[1]) }, ...t.stakeDatum,
    });
    const { pay, collateral } = this.#wallet(wallet);
    const spec: TxSpec = {
      wallet, inputs: [spent, pay], collateral: [collateral], signers: t.signers ?? [this.#controller, owner], fee: FEES.create, validFrom: lo, validTo: hi, mint: { [unit]: 1n },
      outputs: [{ address: t.address ?? REPUTATION_ADDRESS, lovelace: stake, assets: t.assets ?? { [unit]: 1n }, datum }, ...(t.extra === undefined ? [] : [t.extra])],
    };
    return { spec, title: 'Reputation Stake', extra: (built: Unsigned) => ({ did: args.did, stake_ref: t.claimRef ?? `${built.txHash}#0` }), roles: { [this.#controller]: 'controller of the agent', [owner]: 'owner of the stake, and the wallet' } };
  }

  #post(args: Record<string, unknown>) {
    const t = this.twist.post ?? {};
    const wallet = String(args.changeAddress);
    const { lo, hi } = this.#window();
    const supplier = String(args.supplier_key_hash);
    const datum = encodeIdentityAdvertDatum({
      supplier_pkh: supplier, capability_id: String(args.capability_id), model: String(args.model), max_output_tokens: Number(args.max_output_tokens), max_processing_ms: Number(args.max_processing_ms),
      price_lovelace: t.price ?? BigInt(Number(args.price_lovelace)), supplier_bond_lovelace: BigInt(Number(args.supplier_bond_lovelace)), buyer_bond_lovelace: BigInt(Number(args.buyer_bond_lovelace)),
      endpoint_url: String(args.endpoint_url), detail_uri: String(args.detail_uri), detail_hash: t.detailHash ?? String(args.detail_hash), advertised_at: lo + MINUTE, status: 'Active', agent_id: idOfDid(args.did), ...t.advertDatum,
    });
    const spec: TxSpec = {
      wallet, inputs: [this.#wallet(wallet).pay], collateral: [], signers: t.signers ?? [supplier], fee: FEES.post, validFrom: lo, validTo: hi, mint: t.mint,
      outputs: [{ address: t.address ?? DEPLOYMENT.advert.address, lovelace: BigInt(Number(args.deposit_lovelace)), datum, ...(t.mint === undefined ? {} : { assets: t.mint }) }, ...(t.extra === undefined ? [] : [t.extra])],
    };
    return { spec, title: 'Advert Post', extra: (built: Unsigned) => ({ did: args.did, advert_ref: t.claimRef ?? `${built.txHash}#0` }), roles: { [supplier]: 'supplier key, and the wallet' } };
  }

  #retire(args: Record<string, unknown>) {
    const t = this.twist.retire ?? {};
    const wallet = String(args.changeAddress);
    const { lo, hi } = this.#window();
    const refused = (): never => { throw new HostedError('unreachable', 'the fake retire was asked to spend an output that the world does not hold'); };
    const advert = this.#world.chain.find(t.spend ?? String(args.advert_ref)) ?? refused();
    const supplier = decodeIdentityAdvertDatum(advert.datum ?? refused()).supplier_pkh;
    const { pay, collateral } = this.#wallet(wallet);
    const spec: TxSpec = {
      wallet, inputs: [advert, pay], collateral: [collateral], signers: t.signers ?? [supplier], fee: FEES.retire, validFrom: lo, validTo: hi,
      outputs: [{ address: t.address ?? wallet, lovelace: advert.assets.lovelace ?? 0n }, ...(t.extra === undefined ? [] : [t.extra])],
      spend: { input: advert, reference: DEPLOYMENT.refs.advert!, redeemer: t.retireRedeemer ?? 'd87b80' },
    };
    return { spec, title: 'Advert Retirement', extra: { advert_ref: null, spent_ref: String(args.advert_ref) }, roles: { [supplier]: 'supplier key, and the wallet' } };
  }

  /** The stakes of the agents that the arguments name, as the live read shows them: the outputs at the stake address that hold the stake token of each agent. */
  #readStake(args: Record<string, unknown>): Answer {
    const agents = (args.dids as string[]).map((did) => {
      const unit = `${REPUTATION_SCRIPT_HASH}${stakeTokenName(idOfDid(did))}`;
      const stakes = this.#world.chain.held.filter((utxo) => utxo.address === REPUTATION_ADDRESS && (utxo.assets[unit] ?? 0n) > 0n).map((utxo) => {
        const datum = decodeStakeDatum(utxo.datum ?? '');
        return this.readTwist({
          ref: `${utxo.txHash}#${utxo.outputIndex}`, stake_amount: String(datum.stake_amount), lovelace: String(utxo.assets.lovelace ?? 0n),
          capabilities: datum.staked_capabilities.map((hex) => Buffer.from(hex, 'hex').toString('utf8')), last_updated: datum.last_updated, challenge_locks: datum.challenge_locks.length,
          stake_id: `${datum.stake_id.txHash}#${datum.stake_id.outputIndex}`, owner_key_hash: datum.owner_pkh, history_points: String(datum.history_points),
        });
      });
      return { did, token_unit: unit, total: String(stakes.reduce((sum, row) => sum + BigInt(String(row.stake_amount)), 0n)), stakes };
    });
    return { reputation_policy: REPUTATION_SCRIPT_HASH, stake_address: REPUTATION_ADDRESS, agents };
  }

  /** The suppliers list, as the live tool writes it: a markdown table and a JSON LIST in the last block. An advert is listed as `free` only while its runtime runs, so `only_free` hides it here. */
  #list(args: Record<string, unknown>): Answer {
    if (this.listLag > 0) {
      this.listLag -= 1;
      return { text: `No suppliers found for ${String(args.capability_id)}.\n\n\`\`\`json\n[]\n\`\`\`` };
    }
    const rows = args.only_free === false ? this.#adverts(String(args.capability_id)) : [];
    return { text: `# Marketplace suppliers\n\n| advert_ref |\n|---|\n${rows.map((row) => `| \`${String(row.advert_ref)}\` |`).join('\n')}\n\n\`\`\`json\n${JSON.stringify(rows)}\n\`\`\`` };
  }

  #adverts(capability: string): Array<Record<string, unknown>> {
    return this.#world.chain.held.filter((utxo) => utxo.address === DEPLOYMENT.advert.address && utxo.datum !== undefined).flatMap((utxo) => {
      const advert = decodeIdentityAdvertDatum(utxo.datum!);
      if (advert.capability_id !== capability || advert.status !== 'Active') return [];
      return [{
        advert_ref: `${utxo.txHash}#${utxo.outputIndex}`, agent_id: advert.agent_id, did: `did:vector:${advert.agent_id}`, supplier_pkh: advert.supplier_pkh, capability_id: advert.capability_id,
        model: advert.model, price_lovelace: advert.price_lovelace.toString(), supplier_bond_lovelace: advert.supplier_bond_lovelace.toString(), buyer_bond_lovelace: advert.buyer_bond_lovelace.toString(),
        max_processing_ms: advert.max_processing_ms, status: 'unknown', last_seen_iso: null, endpoint_url: advert.endpoint_url, detail_uri: advert.detail_uri, fleet_route: false,
      }];
    });
  }
}

// ---- the world ----

export interface Fixture {
  readonly w: TaskWorld;
  readonly world: World;
  readonly hosted: StakeAdvertHosted;
  readonly net: Net;
  /** The key hash of each signature that the ring was asked for. */
  readonly signs: string[];
  /** Runs a task through the real runner, with an empty screen, and gives the exit code. */
  run<Extra>(def: TaskDefinition<Extra>, ...argv: string[]): Promise<number>;
  /** The key hash of a key of the registry. */
  hash(name: string): string;
  /** The identifier and the DID of the record of an agent. */
  idOf(agent: AgentSpec): string;
  didOf(agent: AgentSpec): string;
  /** Writes `running-images.json` as the script that starts the containers writes it: the listed containers run. */
  setRunning(containers: readonly string[], generatedAt?: number): void;
  /**
   * Puts an opening output of the agent on the node (`onNode`), its reference into the facts file (`fact`) and the confirmed step `open` into the state file of the task `stake` (`step`).
   * Each is true unless the call says false. It gives the reference.
   */
  seedOpening(agent: AgentSpec, over?: { onNode?: boolean; fact?: boolean; step?: boolean }): string;
  /** The advert outputs of an agent that the world holds. */
  advertsOf(agent: AgentSpec): Utxo[];
  /** The facts file of the world: a test sets a fact that an earlier run would have written. */
  readonly facts: FactsFile;
  /** Puts a stake output of the agent (the stake of the data, with the stake token of the agent) on the node. It gives the reference. */
  seedStake(agent: AgentSpec): string;
  /** Puts an advert output at the advert address on the node, with the terms of the data and the members of `over` in the datum. It gives the reference. */
  seedAdvert(agent: AgentSpec, advert: AdvertSpec, over?: Partial<IdentityAdvertDatum>): string;
}

const FUNDED = [1_000_000_000n, 5_000_000n];

/**
 * A world with the real data of use case 1 (inventory reorder): the keys of the registry, the identity fixtures with a record for each agent (it lists the service key and the supplier keys with the transaction
 * purpose, and the capability), the funded wallets of the service keys and the supplier keys, the facts of the two records, the fake tools, the fake `fetch` (each runtime is free and serves
 * its manifest), an empty `running-images.json` and the approval of the session.
 */
export async function stakeAdvertWorld(over: {
  go?: Partial<GoFile> | null; record?: (agent: AgentSpec, keys: Registry) => Partial<IdentityDatum>; facts?: boolean; wallets?: Readonly<Record<string, readonly bigint[]>>;
} = {}): Promise<Fixture> {
  const w = await taskWorld({ keys: KEY_NAMES, shared: SHARED, use: USE, wallets: {} });
  const keys = w.keys.registry;
  const walletNames = [...new Set(USE.agents.flatMap((agent) => [agent.serviceKey, ...agent.adverts.map((advert) => advert.supplierKey)]))];
  const outputs = walletNames.flatMap((name) => (over.wallets?.[name] ?? FUNDED).map((lovelace, outputIndex) => ({ txHash: hashOf(`wallet ${name}`), outputIndex, address: keys.addressOf(name), assets: { lovelace } })));
  const idOf = (agent: AgentSpec): string => hashOf(`record ${agent.id}`);
  const records = USE.agents.map((agent) => recordUtxo(idOf(agent), rootRecord({
    controller: keys.publicKeyOf('controller'),
    keys: [...new Set([agent.serviceKey, ...agent.adverts.map((advert) => advert.supplierKey)])].map((name) => ({ keyType: 'Ed25519' as const, key: keys.publicKeyOf(name), purposes: 1 + 8, pop: null })),
    capabilities: [utf8Hex(agent.capability)], ...over.record?.(agent, keys),
  })));
  const world = await World.identity({ wallets: [], extra: [...outputs, ...records] });
  const node = new ScriptedNode(world);
  const net = new Net();
  const hosted = new StakeAdvertHosted(world, () => w.clock.now(), keys.hashOf('controller'));
  net.retirement = (hash) => hosted.archivedRetirement(hash);
  const chain: ChainAccess = {
    provider: world.chain, deployment: DEPLOYMENT, koiosUrl: 'https://koios.test', fetchImpl: net.fetchImpl,
    context: async (address) => ({ lucid: await lucidForAddress(world.chain, address), provider: world.chain, deployment: DEPLOYMENT }), liveVaultsOf: async () => [],
  };
  const didOf = (agent: AgentSpec): string => `did:vector:${idOf(agent)}`;
  const factsFile = FactsFile.open(join(w.stateDir, 'facts.json'), { useCase: USE_CASE, network: 'vector-mainnet' });
  if (over.facts !== false) {
    for (const agent of USE.agents) factsFile.put('records', [agent.id], { did: didOf(agent), id: idOf(agent), tx: hashOf(`record tx ${agent.id}`), recordRef: `${hashOf(`record tx ${agent.id}`)}#0`, depositLovelace: '10000000', registeredAt: iso(NOW) });
  }
  for (const agent of USE.agents) {
    const manifest = JSON.stringify(manifestOf(agent, didOf(agent), (name) => keys.hashOf(name)));
    for (const advert of agent.adverts) {
      net.manifests.set(originOf(advert.origin), () => new Response(manifest, { status: 200, headers: { 'content-type': 'application/json' } }));
      net.statuses.set(originOf(advert.origin), () => jsonResponse({ status: 'free' }));
    }
  }
  if (over.go !== null) w.writeGo({ tasks: ['stake', 'advert'], irreversible: ['stake'], capUnits: 200, ...over.go });
  const signs: string[] = [];
  let seeded = 0;
  const fixture: Fixture = {
    w, world, hosted, net, signs, facts: factsFile,
    hash: (name) => keys.hashOf(name), idOf, didOf,
    run: async (def, ...argv) => {
      w.screen.lines.length = 0;
      w.screen.errors.length = 0;
      const deps = w.deps({
        node, chain, hosted, fetchImpl: net.fetchImpl,
        readRegistry: (options) => {
          const registry = loadRegistry(options);
          const real = registry.ring.sign.bind(registry.ring);
          registry.ring.sign = (keyHash, cborHex) => { signs.push(keyHash); return real(keyHash, cborHex); };
          return registry;
        },
      });
      return runTask(def, argv, deps);
    },
    setRunning: (containers, generatedAt = NOW) => {
      const images = Object.fromEntries(containers.map((name, index) => [name, `registry.example/agents/${name}@sha256:${createHash('sha256').update(`image ${index}`).digest('hex')}`]));
      writeRunning(w.stateDir, { generated_at: iso(generatedAt), images });
    },
    seedOpening: (agent, seed = {}) => {
      const txHash = hashOf(`opening ${agent.id}`);
      const datum = encodeStakeDatum({
        agent_did: idOf(agent), owner_pkh: keys.hashOf(agent.serviceKey), stake_amount: OPENING, staked_capabilities: [hexOfText(agent.capability)], last_updated: NOW, history_points: 0n, challenge_locks: [],
        stake_id: SEED_STAKE_ID,
      });
      if (seed.onNode !== false) world.chain.held.push({ txHash, outputIndex: 0, address: REPUTATION_ADDRESS, assets: { lovelace: OPENING }, datum });
      if (seed.fact !== false) factsFile.put('stakes', [agent.id], { openingRef: `${txHash}#0`, stakeRef: null, tokenUnit: null, amountLovelace: String(agent.stakeLovelace) });
      if (seed.step !== false) {
        const state = StateFile.open(join(w.stateDir, 'stake.state.json'), { check: 'stake', network: 'vector-mainnet', record: USE_CASE });
        state.setNote(`part.${agent.id}:open`, { confirmed_at: iso(NOW), tx_hash: txHash, refs: { openingRef: `${txHash}#0` }, facts: {}, verified_at: iso(NOW) });
      }
      return `${txHash}#0`;
    },
    advertsOf: (agent) => world.chain.held.filter((utxo) => utxo.address === DEPLOYMENT.advert.address && typeof utxo.datum === 'string' && decodeIdentityAdvertDatum(utxo.datum).capability_id === agent.capability),
    seedStake: (agent) => {
      const txHash = hashOf(`stake ${agent.id}`);
      const unit = `${REPUTATION_SCRIPT_HASH}${stakeTokenName(idOf(agent))}`;
      const datum = encodeStakeDatum({
        agent_did: idOf(agent), owner_pkh: keys.hashOf(agent.serviceKey), stake_amount: agent.stakeLovelace, staked_capabilities: [hexOfText(agent.capability)], last_updated: NOW, history_points: 0n,
        challenge_locks: [], stake_id: { txHash: hashOf(`opening ${agent.id}`), outputIndex: 0 },
      });
      world.chain.held.push({ txHash, outputIndex: 0, address: REPUTATION_ADDRESS, assets: { lovelace: agent.stakeLovelace, [unit]: 1n }, datum });
      return `${txHash}#0`;
    },
    seedAdvert: (agent, advert, over = {}) => {
      seeded += 1;
      const txHash = hashOf(`seeded advert ${seeded}`);
      const datum = encodeIdentityAdvertDatum({
        supplier_pkh: keys.hashOf(advert.supplierKey), capability_id: agent.capability, model: advert.model, max_output_tokens: advert.maxOutputTokens, max_processing_ms: advert.windowMs, price_lovelace: advert.priceLovelace,
        supplier_bond_lovelace: advert.supplierBondLovelace, buyer_bond_lovelace: advert.buyerBondLovelace, endpoint_url: advert.origin, detail_uri: `${advert.origin}/agent.json`, detail_hash: 'aa'.repeat(32),
        advertised_at: NOW - MINUTE, status: 'Active', agent_id: idOf(agent), ...over,
      });
      world.chain.held.push({ txHash, outputIndex: 0, address: DEPLOYMENT.advert.address, assets: { lovelace: advert.depositLovelace }, datum });
      return `${txHash}#0`;
    },
  };
  fixture.setRunning([]);
  return fixture;
}

function writeRunning(stateDir: string, body: { generated_at: string; images: Record<string, string> }): void {
  // The state folder is made by the settings of the first run: this helper makes it too, with the mode that a state folder has.
  const path = join(stateDir, 'running-images.json');
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(body)}\n`, { mode: 0o600 });
}
