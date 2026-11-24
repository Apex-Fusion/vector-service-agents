// An offline world for the real end-state task. The ledger, hosted tools, DNS and HTTP reads take only fixture data.
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { vi } from 'vitest';
import { AUDITOR_ID, CLAIMER_ID, MODULE1_MANIFEST, agentRecord, recordUtxo } from '../../../../packages/buyer-core/test/fixtures/jury-world.ts';
import { MAINNET, attestation, attestationUtxo, recordUtxo as registryUtxo } from '../../../../packages/buyer-core/test/fixtures/ledger-read-world.ts';
import { koiosOf, ledgerWorld } from '../../../../packages/usecase-kit/test/dispute/ledger.ts';
import type { LedgerProvider } from '../../../../packages/usecase-kit/test/dispute/ledger.ts';
import { decodePlutusDataHex, encodeIdentityAdvertDatum } from '../../../../packages/vector-read/src/index.ts';
import type { PlutusData } from '../../../../packages/vector-read/src/index.ts';
import { decodeIdentityDatum, encodeAttestationSpend, encodeIdentityDatum, encodeIdentitySpend } from '../../../../packages/vector-read/src/identity-codec.ts';
import { iso } from '../../../checks/lib/format.ts';
import type { ChainAccess } from '../../../checks/lib/session.ts';
import { StateFile } from '../../../checks/lib/state.ts';
import type { UseCase } from '../../lib/contract.ts';
import { FactsFile } from '../../lib/facts.ts';
import { LoadError } from '../../lib/load.ts';
import { ATT_TYPES, PURPOSE, blake2b256Hex, calculateMinLovelaceFromUTxO } from '../../lib/platform.ts';
import { loadRegistry, publicManifestFile, writePublicManifest } from '../../lib/registry.ts';
import { runTask } from '../../lib/runner.ts';
import endState from '../../tasks/end-state.ts';
import data from '../../usecases/inventory-reorder.ts';
import { PackHosted } from './pack-hosted.ts';
import { NOW, hashOf, taskWorld } from './task-world.ts';
import type { MachineLine, TaskWorld } from './task-world.ts';

// The manifest reader requires a public address before it calls the fixture HTTP reader.
vi.mock('node:dns/promises', () => ({ lookup: async () => [{ address: '140.82.114.4', family: 4 }] }));

export const DAY = 86_400_000;
export const HOUR = 3_600_000;
const COMMIT = 'a4bc735c48d9d280374637b7e071a01f0086e7aa';
export const MANIFEST_URL = `https://raw.githubusercontent.com/Apex-Fusion/vector-agent-modules/${COMMIT}/${data.moduleManifestPath}`;
const IMAGE = `ghcr.io/apex-fusion/vector-service-agents/agent@sha256:${'ab'.repeat(32)}`;
const REORDER = data.agents[0]!;
export const ORDER = data.agents[1]!;
export const REORDER_ID = CLAIMER_ID;
export const ORDER_ID = AUDITOR_ID;
export const READER_ID = 'd1'.repeat(32);
const NODE_URL = 'https://ogmios.test';
export const COINS_PER_BYTE = 5_003;
export const RECLAIM_TX = hashOf('end-state reclaim Bravo');
const HISTORY_FEE = 220_000n;
const LIFE_STEPS = [
  ['change-controller', 15], ['recovery-start', 13], ['recovery-wait', 12], ['recovery-complete', 6],
  ['retire', 5], ['set-successor', 4], ['reclaim', 3],
] as const;

export const did = (id: string): string => `did:vector:${id}`;
export const hash = (name: string): string => hashOf(`end-state ${name}`);
export const ref = (name: string): string => `${hash(name)}#0`;

// The records are made once: `recordUtxo` gives each record a transaction hash from a counter that has room for few records.
const ACTIVE_REORDER = recordUtxo(REORDER_ID, agentRecord());
const ACTIVE_ORDER = recordUtxo(ORDER_ID, agentRecord());

export type Result = 'ok' | 'wait' | 'fail';
interface Row { advert_ref: string; capability_id: string; model: string; agent_id: string; did: string; supplier_pkh: string; status: string }
interface Gateway {
  verified: boolean; listed: string[]; parties: boolean; domain?: string; effective?: 'active' | 'revoked' | 'suspended';
  parent?: { parent: string; parentEpoch: number; depth: number };
  ownHolds?: { until: string }[];
}

interface HistoryOutput {
  tx_hash: string; tx_index: number; payment_addr: { bech32: string }; value: string;
  inline_datum: { bytes: string | null; value?: unknown } | null; datum_hash: string | null;
  asset_list: { policy_id: string; asset_name: string; quantity: string }[];
}
interface HistoryContract {
  valid_contract: boolean;
  script_hash: string;
  spends_input: { tx_hash: string; tx_index: number };
  input: { redeemer: { purpose: 'spend'; datum: { bytes: null; value: unknown; hash: string } } };
}
interface HistoryTx {
  tx_hash: string; fee: string; valid_contract?: boolean; plutus_contracts: HistoryContract[]; inputs: HistoryOutput[]; outputs: HistoryOutput[];
}
interface CapturedHistory { payment: { tx: Pick<HistoryTx, 'inputs' | 'plutus_contracts'> } }
const capturedHistory: CapturedHistory = JSON.parse(readFileSync(new URL('../../../../packages/buyer-core/test/fixtures/ledger-read-mainnet.json', import.meta.url), 'utf8'));
const capturedInline = capturedHistory.payment.tx.inputs.find(({ inline_datum }) => inline_datum?.bytes === null)!.inline_datum!;

function koiosValue(data: PlutusData): unknown {
  switch (data.kind) {
    case 'constr': return { constructor: Number(data.index), fields: data.fields.map(koiosValue) };
    case 'int': return { int: Number.isSafeInteger(Number(data.value)) ? Number(data.value) : String(data.value) };
    case 'bytes': return { bytes: data.hex };
    case 'list': return { list: data.items.map(koiosValue) };
    case 'map': return { map: data.entries.map(([k, v]) => ({ k: koiosValue(k), v: koiosValue(v) })) };
  }
}

export function datumOf(bytes: string): { bytes: null; value: unknown; hash: string } {
  return { bytes: null, value: koiosValue(decodePlutusDataHex(bytes)), hash: blake2b256Hex(Buffer.from(bytes, 'hex')) };
}

type Output = LedgerProvider['live'][number];
type ArchiveSpend = (tx: string, before: Output, after: Output | null, script: string, action: string, wallet?: string) => void;

interface EndStateObservation {
  readonly exit: number;
  readonly machine: MachineLine;
  readonly errors: string;
  /** Attempts, refused before the fixture signs or changes the ledger. */
  readonly signatures: number;
  readonly submissions: number;
  readonly reads: { readonly web: readonly string[]; readonly koios: readonly string[]; readonly tools: readonly string[] };
}

export interface EndStateWorld {
  readonly fixtureDir: string;
  readonly stateDir: string;
  readonly keysDir: string;
  observe(command: 'run' | 'status'): Promise<EndStateObservation>;
}

export interface Rig {
  readonly world: TaskWorld;
  readonly ledger: LedgerProvider;
  readonly hosted: PackHosted;
  readonly facts: FactsFile;
  readonly gateway: Map<string, Gateway>;
  /** The adverts that the indexer lists. */
  listing: Row[];
  /** What each status address answers: the word of the status, an HTTP status code, or `hang` for a request that never gets an answer (a fetch that ignores the abort signal). */
  readonly statuses: Map<string, string | number>;
  readonly webCalls: string[];
  readonly protocolRequests: unknown[];
  readonly history: Map<string, HistoryTx>;
  readonly unconfirmed: Set<string>;
  readonly archive: ArchiveSpend;
  retireAdvert(agent: string, model: string, final: Output, run?: string): string;
  idOf(name: string): string;
  /** Puts a record on the ledger in place of the record of the same agent. */
  setRecord(id: string, utxo: LedgerProvider['live'][number]): void;
  /** Gives a wallet exactly these outputs. */
  setWallet(name: string, outputs: readonly bigint[]): void;
  writeRunning(containers?: readonly string[], at?: number): void;
  run(...argv: string[]): Promise<number>;
  readonly observe: EndStateWorld['observe'];
  checks(): Map<string, { result: Result; text: string }>;
  errors(): string;
}

interface RigOptions {
  env?: Record<string, string | undefined>;
  advertRun?: string;
  skipAttestation?: string;
  skipSubagentEnd?: boolean;
  subagentEpochBefore?: number;
  skipStep?: string;
  protocolParameters?: unknown;
}

export async function makeRig(options: RigOptions = {}, use: UseCase = data): Promise<Rig> {
  const names = use.funding.map((line) => line.wallet);
  if (use.compliance !== null) names.push(use.compliance.issuerKey, 'provider');
  if (use.lifecycle !== null) names.push(use.lifecycle.controllers[1]);
  for (const agent of use.agents.filter(({ end }) => end.record === 'revoked')) {
    names.push(use.organisations.find(({ id }) => id === agent.organisation)!.accountableKey);
  }
  const world = await taskWorld({
    keys: names, shared: names.filter((name) => use.keys.some((key) => key.name === name && key.scope === 'shared')),
    env: { OPERATOR_USE_CASE: undefined, OPERATOR_MODULE1_COMMIT: COMMIT, VECTOR_OGMIOS_URL: NODE_URL, ...options.env },
    use: { ...use, keys: use.keys.filter(({ name }) => names.includes(name)) },
  });
  mkdirSync(world.stateDir, { recursive: true, mode: 0o700 });
  chmodSync(world.stateDir, 0o700);
  const factsId = { useCase: use.name, network: 'vector-mainnet' as const };
  writePublicManifest(join(world.keys.root, publicManifestFile(use.name)), world.keys.registry, factsId);
  const ledger = ledgerWorld([], []);
  const facts = FactsFile.open(join(world.stateDir, 'facts.json'), factsId);
  const history = new Map<string, HistoryTx>();
  const unconfirmed = new Set<string>();
  const txStatus = world.node.txStatus.bind(world.node);
  vi.spyOn(world.node, 'txStatus').mockImplementation((hash) => history.has(hash) ? Promise.resolve({ confirmations: unconfirmed.has(hash) ? null : 5 }) : txStatus(hash));
  const feeAddress = world.keys.registry.addressOf('fee');
  const historicalShape = ({ txHash: tx_hash, outputIndex: tx_index, address, assets, datum }: LedgerProvider['live'][number]): HistoryOutput => ({
    tx_hash, tx_index, payment_addr: { bech32: address }, value: String(assets.lovelace),
    inline_datum: datum == null ? null : { ...capturedInline, value: koiosValue(decodePlutusDataHex(datum)) },
    datum_hash: datum == null ? null : blake2b256Hex(Buffer.from(datum, 'hex')),
    asset_list: Object.entries(assets).filter(([unit]) => unit !== 'lovelace').map(([unit, quantity]) => ({
      policy_id: unit.slice(0, 56), asset_name: unit.slice(56), quantity: String(quantity),
    })),
  });
  const archive: ArchiveSpend = (tx, before, after, script, action, wallet = feeAddress) => {
    const walletIn = { txHash: hash(`funding ${tx}`), outputIndex: 0, address: wallet, assets: { lovelace: 15_000_000n } };
    const walletOut = { txHash: tx, outputIndex: after === null ? 0 : 1, address: wallet, assets: { lovelace: walletIn.assets.lovelace + before.assets.lovelace! - (after?.assets.lovelace ?? 0n) - HISTORY_FEE } };
    history.set(tx, {
      tx_hash: tx, fee: String(HISTORY_FEE), inputs: [before, walletIn].map(historicalShape), outputs: (after === null ? [walletOut] : [after, walletOut]).map(historicalShape),
      plutus_contracts: [{
        ...capturedHistory.payment.tx.plutus_contracts[0]!, script_hash: script, spends_input: { tx_hash: before.txHash, tx_index: before.outputIndex },
        input: { redeemer: { purpose: 'spend', datum: datumOf(action) } },
      }],
    });
  };
  const retireAdvert = (name: string, model: string, output: Output, run?: string): string => {
    const agent = use.agents.find(({ id }) => id === name)!;
    const supplier = agent.adverts.find((advert) => advert.model === model)!.supplierKey;
    const tx = hash(`retire ${name} ${model}${run === undefined ? '' : ` ${run}`}`);
    archive(tx, output, null, MAINNET.advert.hash, 'd87b80', world.keys.registry.addressOf(supplier));
    const file = run === undefined ? 'advert.state.json' : `advert.${run}.state.json`;
    const record = run === undefined ? use.name : `${use.name}:${run}`;
    const journal = StateFile.open(join(world.stateDir, file), { check: 'advert', network: factsId.network, record });
    journal.setNote(`part.retire:${name}:${model}`, { confirmed_at: iso(NOW - DAY), tx_hash: tx, refs: { retiredRef: `${output.txHash}#${output.outputIndex}` }, facts: {} });
    return tx;
  };
  const statuses = new Map<string, string | number>();
  const webCalls: string[] = [];
  const protocolRequests: unknown[] = [];
  const all = [...use.agents, ...use.subagents, ...use.records];
  const legacyIds: Readonly<Partial<Record<string, string>>> = { 'reorder-agent': REORDER_ID, 'order-desk': ORDER_ID, 'stock-reader': READER_ID };
  const ids = new Map(all.map(({ id }) => [id, legacyIds[id] ?? hash(`identity ${id}`)]));
  const idOf = (name: string): string => ids.get(name)!;
  const withAuthority = (id: string, output: LedgerProvider['live'][number]): LedgerProvider['live'][number] => {
    const agent = use.agents.find((one) => idOf(one.id) === id);
    if (agent === undefined || output.datum == null) return output;
    const datum = decodeIdentityDatum(output.datum);
    if (datum.status.type === 'Revoked' || datum.status.type === 'Retired') return output;
    const keys = agent.adverts.map(({ supplierKey }) => ({
      keyType: 'Ed25519' as const, key: world.keys.registry.publicKeyOf(supplierKey), purposes: PURPOSE.transaction, pop: null,
    }));
    return { ...output, datum: encodeIdentityDatum({ ...datum, keys, capabilities: [Buffer.from(agent.capability, 'utf8').toString('hex')] }) };
  };
  const gateway = new Map<string, Gateway>();
  const listing: Row[] = [];
  const web: typeof fetch = async (input, init) => {
    const url = String(input);
    webCalls.push(url);
    if (url === MANIFEST_URL) return new Response(JSON.stringify(MODULE1_MANIFEST), { status: 200 });
    if (url === NODE_URL) {
      const request = JSON.parse(String(init?.body)) as { id: unknown };
      protocolRequests.push(request);
      const result = options.protocolParameters ?? { minUtxoDepositCoefficient: COINS_PER_BYTE };
      return Response.json({ jsonrpc: '2.0', id: request.id, result });
    }
    const status = statuses.get(url);
    if (status === 'hang') return new Promise<Response>(() => undefined);
    if (typeof status === 'string') return new Response(status === 'not json' ? 'not json' : JSON.stringify({ status }), { status: 200 });
    if (typeof status === 'number') return new Response('{}', { status });
    throw new Error('the network was touched');
  };
  const koios = koiosOf(ledger);
  const koiosReads: string[] = [];
  const readHistory: typeof fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    koiosReads.push(path);
    if (!path.endsWith('/tx_info')) return koios(input, init);
    const args = JSON.parse(String(init?.body)) as { _tx_hashes: string[]; _inputs: boolean; _assets: boolean; _scripts: boolean };
    if (!args._inputs || !args._assets || !args._scripts) throw new Error('the read did not request the transaction detail');
    return Response.json(args._tx_hashes.flatMap((tx) => history.has(tx) ? [history.get(tx)] : []));
  };
  const chain: ChainAccess = {
    provider: ledger, deployment: MAINNET, koiosUrl: 'https://koios.test', fetchImpl: readHistory,
    context: async () => { throw new Error('the end-state check builds nothing'); }, liveVaultsOf: async () => [],
  };
  const hosted = new PackHosted({
    vector_resolve_did: (args) => {
      const canonicalId = String(args.did);
      const state = gateway.get(canonicalId);
      if (state === undefined) throw new Error('the gateway knows no such record');
      const effective = state.effective ?? 'active';
      const deactivated = effective === 'revoked';
      const metadata = {
        canonicalId, ...(deactivated ? { deactivated } : {}),
        vectorStatus: { status: state.ownHolds === undefined ? 'active' : 'suspended', holds: state.ownHolds, effective,
          ...(deactivated ? { effectiveReason: 'parentRevoked' } : effective === 'suspended' ? { effectiveReason: 'parentSuspended' } : {}) },
        ...(state.parent === undefined ? {} : { vectorParent: state.parent }),
        vectorParties: state.parties ? [{ role: 'accountable', signer: 'controller', organisation: state.domain, ...(state.verified ? { organisationVerified: true } : {}), rights: ['suspend', 'revoke'], notBefore: '2026-10-16T12:00:00Z' }] : [],
        vectorProvenance: { attestations: state.listed.map((id) => ({ id, type: 'provenance', issuer: 'did:key:z6Mk', issuedAt: '2026-11-01T10:00:00Z', solicited: true, digest: hash('digest') })) },
      };
      return { didDocument: deactivated ? null : { id: canonicalId }, didDocumentMetadata: metadata, didResolutionMetadata: {} };
    },
    vector_marketplace_list_suppliers: (args) => {
      const rows = rig.listing.filter((row) => row.capability_id === args.capability_id);
      return { text: `${rows.length === 0 ? 'No suppliers found.' : '# Marketplace suppliers'}\n\n\`\`\`json\n${JSON.stringify(rows)}\n\`\`\`` };
    },
  });

  const setWallet = (name: string, outputs: readonly bigint[]): void => {
    const address = world.keys.registry.addressOf(name);
    ledger.live = ledger.live.filter((utxo) => utxo.address !== address);
    outputs.forEach((lovelace, index) => ledger.live.push({ txHash: hash(`wallet ${name} ${index}`), outputIndex: 0, address, assets: { lovelace } }));
  };
  for (const line of use.funding) setWallet(line.wallet, [line.collateralLovelace, line.floatLovelace]);

  // The facts: the records, the adverts, the attestations.
  for (const { id: name } of all) {
    const id = idOf(name);
    facts.put('records', [name], { did: did(id), id, tx: hash(`record ${name}`), recordRef: ref(`record ${name}`), depositLovelace: '10000000', registeredAt: iso(NOW - 20 * DAY) });
  }
  const validUntil = NOW + 300 * DAY;
  const issuedAt = NOW - 65 * DAY;
  const digest = hash('digest');
  const locator = 'https://example.test/doc';
  const locatorHex = Buffer.from(locator, 'utf8').toString('hex');
  const expectedRunning: string[] = [];
  for (const agent of use.agents) {
    const id = idOf(agent.id);
    const ended = agent.end.subagents === 'ended';
    const epochBefore = options.subagentEpochBefore ?? 0;
    const endTx = hash(`end ${agent.id}`);
    if (ended && !options.skipSubagentEnd) facts.put('subagentEnds', [agent.id], { tx: endTx, at: iso(NOW - DAY), epochBefore, epochAfter: epochBefore + 1 });
    const successor = agent.end.successor === null ? null : idOf(agent.end.successor);
    if (agent.end.record === 'retired') {
      const controller = world.keys.registry.publicKeyOf(use.lifecycle!.controllers[1]);
      const output = registryUtxo(id, agentRecord({ controller, subagentEpoch: 2, keys: [], parties: [], status: { type: 'Retired', at: NOW - 5 * DAY, successor } }));
      const minimum = calculateMinLovelaceFromUTxO(BigInt(COINS_PER_BYTE), { ...output, assets: { ...output.assets, lovelace: 0n } });
      const reclaimed = { ...output, txHash: RECLAIM_TX, assets: { ...output.assets, lovelace: minimum } };
      ledger.live.push(reclaimed);
      archive(RECLAIM_TX, { ...output, txHash: hash('set-successor') }, reclaimed, MAINNET.identity.hash, encodeIdentitySpend({ type: 'Reclaim' }));
    } else if (agent.end.record === 'revoked') {
      const party = use.organisations.find(({ id: name }) => name === agent.organisation)!.accountableKey;
      const status = { type: 'Revoked', by: { type: 'KeyHash', hash: world.keys.registry.hashOf(party) }, reason: 9, invalidFrom: NOW - 2 * DAY, at: NOW - DAY, successor } as const;
      ledger.live.push(registryUtxo(id, agentRecord({ keys: [], parties: [], status })));
      facts.put('revocations', [agent.id], { tx: hash(`revoke ${agent.id}`), reason: status.reason, invalidFrom: iso(status.invalidFrom), revokedAt: iso(status.at) });
    } else {
      const output = agent === REORDER ? ACTIVE_REORDER : agent === ORDER ? ACTIVE_ORDER : registryUtxo(id, agentRecord({ subagentEpoch: ended ? epochBefore + 1 : 0 }));
      const current = withAuthority(id, ended ? { ...output, txHash: endTx } : output);
      ledger.live.push(current);
      if (ended) {
        const earlier = withAuthority(id, registryUtxo(id, agentRecord({ subagentEpoch: epochBefore })));
        archive(endTx, earlier, current, MAINNET.identity.hash, encodeIdentitySpend({ type: 'BumpEpoch' }));
      }
    }
    for (const advert of agent.adverts) {
      const tx = hash(use === data ? `advert ${advert.model}` : `advert ${agent.id} ${advert.model}`);
      const ref = `${tx}#0`;
      const detailUri = `${advert.origin}/agent.json`;
      const detailHash = hash('detail');
      const supplier = world.keys.registry.hashOf(advert.supplierKey);
      facts.put('adverts', [agent.id, advert.model], { ref, tx, detailUri, detailHash, endpoint: advert.origin, postedAt: iso(NOW - 10 * DAY) });
      const output = {
        txHash: tx, outputIndex: 0, address: MAINNET.advert.address, assets: { lovelace: advert.depositLovelace },
        datum: encodeIdentityAdvertDatum({
          agent_id: id, supplier_pkh: supplier, capability_id: agent.capability, model: advert.model, max_output_tokens: advert.maxOutputTokens,
          max_processing_ms: advert.windowMs, price_lovelace: advert.priceLovelace, supplier_bond_lovelace: advert.supplierBondLovelace,
          buyer_bond_lovelace: advert.buyerBondLovelace, endpoint_url: advert.origin, detail_uri: detailUri, detail_hash: detailHash,
          advertised_at: NOW - 10 * DAY, status: 'Active',
        }),
      };
      if (agent.end.advert === 'listed') {
        ledger.live.push(output);
        listing.push({ advert_ref: ref, capability_id: agent.capability, model: advert.model, agent_id: id, did: did(id), supplier_pkh: supplier, status: 'free' });
        expectedRunning.push(advert.runtimeContainer);
        statuses.set(`${advert.origin}/status`, 'free');
      } else {
        ledger.koiosSpent.push(output);
        retireAdvert(agent.id, advert.model, output, options.advertRun);
      }
    }
    const listed: string[] = [];
    const spec = use.attestations.find(({ agent: name }) => name === agent.id)!;
    for (const type of spec.types) {
      if (options.skipAttestation === 'all' || options.skipAttestation === `${agent.id}/${type}`) continue;
      const attestationId = hash(`attestation ${agent.id} ${type}`);
      const tx = hash(`attest tx ${agent.id} ${type}`);
      listed.push(attestationId);
      facts.put('attestations', [agent.id, type], { id: attestationId, tx, digest, locator, validUntil: iso(validUntil), issuedAt: iso(issuedAt), envelope: false });
      if (agent.end.record !== 'active') {
        const issuer = world.keys.registry.publicKeyOf('provider');
        ledger.live.push(attestationUtxo(attestationId, attestation({
          subject: id, issuer, attType: ATT_TYPES[type], format: spec.format, digest, locator: locatorHex, issuedAt, validUntil, solicited: true,
        }), { txHash: tx }));
      }
    }
    if (agent.end.record === 'active') {
      const domain = use.organisations.find(({ id: name }) => name === agent.organisation)!.domain;
      gateway.set(did(id), { verified: true, listed, parties: true, domain });
    }
  }
  for (const child of use.subagents) {
    const parent = use.agents.find(({ id }) => id === child.parent)!;
    gateway.set(did(idOf(child.id)), {
      verified: false, listed: [], parties: false, effective: parent.end.subagents === 'ended' ? 'revoked' : 'active',
      parent: { parent: did(idOf(parent.id)), parentEpoch: 0, depth: 1 },
    });
  }
  for (const record of use.records) {
    const id = idOf(record.id);
    ledger.live.push(registryUtxo(id, agentRecord()));
    const domain = use.organisations.find(({ id: name }) => name === record.organisation)!.domain;
    gateway.set(did(id), { verified: true, listed: [], parties: true, domain });
  }
  const compliance = use.compliance;
  if (compliance !== null) {
    const issuer = world.keys.registry.publicKeyOf(compliance.issuerKey);
    for (const subject of compliance.subjects) {
      const id = hash(`compliance ${subject}`);
      const tx = hash(`compliance tx ${subject}`);
      const revoked = use.agents.find((agent) => agent.id === subject)!.end.record === 'revoked';
      const revokeTx = revoked ? hash(`compliance revoke ${subject}`) : null;
      const contestTx = revoked ? hash(`compliance contest ${subject}`) : null;
      const replySha256 = revoked ? hash('reply') : null;
      const replyUri = revoked ? 'https://example.test/reply' : null;
      facts.put('compliance', [subject], { id, tx, digest, locator, issuedAt: iso(issuedAt), validUntil: iso(validUntil), revokeTx, contestTx, replySha256, replyUri });
      const issue = attestation({ subject: idOf(subject), issuer, attType: ATT_TYPES.identity, format: compliance.format, digest, locator: locatorHex, issuedAt, validUntil });
      const earlier = attestationUtxo(id, issue, { txHash: tx });
      if (revokeTx !== null && contestTx !== null && replyUri !== null && replySha256 !== null) {
        const revoked = { ...issue, status: { type: 'AttRevoked' as const, at: NOW - 2 * DAY, reason: 9 } };
        const during = attestationUtxo(id, revoked, { txHash: revokeTx });
        const now = attestationUtxo(id, { ...revoked, contested: { uri: Buffer.from(replyUri, 'utf8').toString('hex'), sha256: replySha256 } }, { txHash: contestTx });
        now.assets.lovelace = during.assets.lovelace! + 160_000n;
        archive(revokeTx, earlier, during, MAINNET.attestation.hash, encodeAttestationSpend({ type: 'RevokeAtt', reason: 9 }));
        archive(contestTx, during, now, MAINNET.attestation.hash, encodeAttestationSpend({ type: 'Contest' }));
        ledger.live.push(now);
      } else ledger.live.push(earlier);
    }
  }
  if (use.lifecycle !== null) for (const [step, days] of LIFE_STEPS) {
    if (options.skipStep === step) continue;
    const tx = step === 'reclaim' ? RECLAIM_TX : hash(step === 'recovery-wait' ? 'recovery-start' : step);
    facts.put('lifecycle', [step], { tx, at: iso(NOW - days * DAY) });
  }

  const writeRunning = (containers: readonly string[] = expectedRunning, at: number = NOW): void => {
    const images = Object.fromEntries(containers.map((container) => [container, IMAGE]));
    writeFileSync(join(world.stateDir, 'running-images.json'), `${JSON.stringify({ generated_at: iso(at), images })}\n`, { mode: 0o600 });
  };
  writeRunning();

  const deps = world.deps({
    chain, hosted, fetchImpl: web,
    async loadUseCase(name) {
      if (name !== use.name) throw new LoadError('mismatch', 'the case selector does not match this offline end-state world');
      return world.use;
    },
  });
  // Select the fixture case without changing which defaults the production settings allow.
  const selector = ['--use-case', use.name];
  const observe: EndStateWorld['observe'] = async (command) => {
    const start = { web: webCalls.length, koios: koiosReads.length, tools: hosted.calls.length, errors: world.screen.errors.length };
    let signatures = 0;
    let submissions = 0;
    const refuseSignature = (): never => { signatures += 1; throw new Error('the end-state world signs nothing'); };
    const refuseSubmit = async (): Promise<never> => { submissions += 1; throw new Error('the end-state world submits nothing'); };
    const nodeSubmit = vi.spyOn(world.node, 'submit').mockImplementation(refuseSubmit);
    const providerSubmit = vi.spyOn(ledger, 'submitTx').mockImplementation(refuseSubmit);
    try {
      const exit = await runTask(endState, [command, ...selector], {
        ...deps,
        readRegistry(selection) {
          const registry = loadRegistry(selection);
          for (const name of registry.names()) {
            const key = registry.key(name);
            vi.spyOn(key, 'signTransaction').mockImplementation(refuseSignature);
            vi.spyOn(key, 'signMessage').mockImplementation(refuseSignature);
            vi.spyOn(key, 'jwsKey').mockImplementation(refuseSignature);
          }
          return registry;
        },
      });
      return {
        exit, machine: world.machine(), errors: world.screen.errors.slice(start.errors).join('\n'), signatures, submissions,
        reads: { web: webCalls.slice(start.web), koios: koiosReads.slice(start.koios), tools: hosted.calls.slice(start.tools).map(({ name }) => name) },
      };
    } finally {
      providerSubmit.mockRestore();
      nodeSubmit.mockRestore();
    }
  };

  const rig: Rig = {
    world, ledger, hosted, facts, gateway, statuses, webCalls, protocolRequests, history, unconfirmed, idOf, archive, retireAdvert,
    get listing() { return listing; },
    set listing(rows) { listing.splice(0, listing.length, ...rows); },
    setRecord: (id, utxo) => { ledger.live = [...ledger.live.filter((candidate) => candidate.assets[`${MAINNET.identity.hash}${id}`] === undefined), withAuthority(id, utxo)]; },
    setWallet, writeRunning,
    run: (...argv) => runTask(endState, [...argv, ...selector], deps),
    observe,
    checks: () => {
      const found = new Map<string, { result: Result; text: string }>();
      for (const line of world.screen.lines) {
        const match = /^(OK|WAIT|FAIL)\s+(\S+): (.*)$/.exec(line);
        if (match !== null) found.set(match[2]!, { result: match[1]!.toLowerCase() as Result, text: match[3]! });
      }
      return found;
    },
    errors: () => world.screen.errorText,
  };
  return rig;
}

/** The matrix gets the same complete world as the end-state tests, without its mutable controls. */
export async function makeEndStateWorld(use: UseCase): Promise<EndStateWorld> {
  const { world, observe } = await makeRig({}, use);
  return { fixtureDir: world.dir, stateDir: world.stateDir, keysDir: world.keys.root, observe };
}
