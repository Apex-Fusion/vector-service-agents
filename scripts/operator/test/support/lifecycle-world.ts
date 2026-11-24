import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildChangeController, buildReclaim, buildRecoveryComplete, buildRecoveryStart, buildRetire, buildSetSuccessor,
} from '../../../../packages/buyer-core/src/vendored/mcp/identity-build.ts';
import type { RecordSpendBuild } from '../../../../packages/buyer-core/src/vendored/mcp/identity-build.ts';
import { DAYS_7_MS, RIGHT } from '../../../../packages/buyer-core/src/vendored/mcp/identity-rules.ts';
import { DAY, recordUtxo, rootRecord } from '../../../../packages/buyer-core/test/fixtures/identity-world.ts';
import { claimUtxo, CLAIM_TOKEN, MODULE1, MODULE1_MANIFEST } from '../../../../packages/buyer-core/test/fixtures/jury-world.ts';
import { encodeIdentityAdvertDatum } from '../../../../packages/vector-read/src/index.ts';
import type { IdentityAdvertDatum } from '../../../../packages/vector-read/src/index.ts';
import { encodeIdentityDatum, utf8Hex } from '../../../../packages/vector-read/src/identity-codec.ts';
import type { IdentityDatum, Party } from '../../../../packages/vector-read/src/identity-codec.ts';
import { iso } from '../../../checks/lib/format.ts';
import type { HostedTools } from '../../../checks/lib/hosted.ts';
import { StateFile } from '../../../checks/lib/state.ts';
import type { Utxo } from '../../../checks/lib/platform.ts';
import type { GoFile } from '../../lib/approval.ts';
import { valueSeal } from '../../lib/confirmed-spend.ts';
import type { AgentSpec, UseCase } from '../../lib/contract.ts';
import { formatOutRef, PURPOSE } from '../../lib/platform.ts';
import { loadRegistry } from '../../lib/registry.ts';
import { runTask } from '../../lib/runner.ts';
import task from '../../tasks/lifecycle.ts';
import inventory from '../../usecases/inventory-reorder.ts';
import { BRAVO, CORE_KEYS, MODULE_MANIFEST_PATH, organisationKeys, partiesOf } from '../../usecases/shared.ts';
import { liveBuildAnswer, PackHosted } from './pack-hosted.ts';
import type { HandlerAnswer } from './pack-hosted.ts';
import { spendWorld } from './record-spend-builds.ts';
import { hashOf } from './task-world.ts';

export const TARGET = 'bid-desk-bravo';
export const SUCCESSOR = 'bravo-successor';
export const FIRST = 'l1-controller-1';
export const SECOND = 'l1-controller-2';
export const GUARDIAN = BRAVO.guardianKey;
const SUPPLIER = 'bid-bravo-supplier';
const CLAIMER = 'bid-bravo-service';
const SUCCESSOR_AUTH = 'bravo-successor-auth';
const CAPABILITY = 'supplychain.rfq.quote.v1';
const COMMIT = hashOf('module manifest').slice(0, 40);
const MANIFEST = `https://raw.githubusercontent.com/Apex-Fusion/vector-agent-modules/${COMMIT}/${MODULE_MANIFEST_PATH}`;
const PROFILE = { endpoint: 'https://bids.example.test', detailUri: 'https://bids.example.test/agent.json', detailHash: hashOf('advert manifest') };
const LABEL = 'l1';

export const TOOLS = {
  change: 'vector_build_identity_change_controller', start: 'vector_build_identity_recovery_start', complete: 'vector_build_identity_recovery_complete',
  retire: 'vector_build_identity_retire', successor: 'vector_build_identity_set_successor', reclaim: 'vector_build_identity_reclaim', resolve: 'vector_resolve_did',
} as const;

const orderDesk = inventory.agents.find(({ id }) => id === 'order-desk')!;
const agent: AgentSpec = { ...orderDesk, id: TARGET, name: 'Bid Desk Bravo', kind: 'bid-desk', organisation: BRAVO.id,
  capability: CAPABILITY, endpoint: PROFILE.endpoint, serviceKey: CLAIMER, statusUrls: [`${PROFILE.endpoint}/status`],
  adverts: [{ ...orderDesk.adverts[0]!, model: 'bid-desk-v1', supplierKey: SUPPLIER, origin: PROFILE.endpoint }],
  parties: partiesOf(BRAVO), end: { record: 'retired', advert: 'retired', subagents: 'live', successor: SUCCESSOR } };
const use: UseCase = { ...inventory, name: 'bid-evaluation', organisations: [BRAVO], agents: [agent], subagents: [],
  records: [{ id: SUCCESSOR, name: 'Bravo successor', description: 'A successor for the test', keys: [], organisation: BRAVO.id, guardianThreshold: 0, parties: [] }],
  keys: [...CORE_KEYS, ...organisationKeys(BRAVO), ...[FIRST, SECOND, SUPPLIER, CLAIMER, SUCCESSOR_AUTH].map((name) => ({ name, scope: 'use-case' as const, about: name }))],
  runs: [{ id: 'lifecycle', subject: TARGET, tenantPrefix: 'bids-lifecycle', vaultUnits: 0, perTxUnits: 0, totalUnits: 0 }],
  lifecycle: { agent: TARGET, controllers: [FIRST, SECOND], guardians: [GUARDIAN, 'controller'], successor: SUCCESSOR, waitMs: DAYS_7_MS },
};

export const refOf = (out: Utxo): string => formatOutRef(out.txHash, out.outputIndex);

function spentRow(out: Utxo) {
  return { tx_hash: out.txHash, tx_index: out.outputIndex, address: out.address, value: String(out.assets.lovelace), inline_datum: typeof out.datum === 'string' ? { bytes: out.datum } : null,
    asset_list: Object.entries(out.assets).flatMap(([unit, amount]) => unit === 'lovelace' ? [] : [{ policy_id: unit.slice(0, 56), asset_name: unit.slice(56), quantity: String(amount) }]) };
}

function archivedSpend(tx: string, input: Utxo, paidTo: string, fee: bigint, script: string, redeemer: 1 | 2 | 3) {
  const row = (out: Utxo) => ({ ...spentRow(out), payment_addr: { bech32: out.address } });
  const wallet = { txHash: hashOf(`funding for ${tx}`), outputIndex: 0, address: paidTo, assets: { lovelace: 5_000_000n } };
  const paid = (outputIndex: number, lovelace: bigint) => row({ txHash: tx, outputIndex, address: paidTo, assets: { lovelace } });
  return { tx_hash: tx, fee: String(fee), inputs: [row(input), row(wallet)], outputs: [paid(0, input.assets.lovelace), paid(1, wallet.assets.lovelace - fee)],
    plutus_contracts: [{ script_hash: script, valid_contract: true, spends_input: { tx_hash: input.txHash, tx_index: input.outputIndex },
      input: { redeemer: { purpose: 'spend', datum: { bytes: `d87${(9 + redeemer).toString(16)}80`, value: { constructor: redeemer, fields: [] } } } } }] };
}

export async function lifecycleWorld() {
  const rig = await spendWorld({ use, agent: TARGET, parent: { subagentEpoch: 4 } });
  const { w, registry, store, context, fee, id } = rig;
  const heads = new Map<string, HandlerAnswer>();
  const schema = new PackHosted(Object.fromEntries(Object.values(TOOLS).map((name) => [name, () => heads.get(name)!])));
  const builds: Record<string, RecordSpendBuild> = {};
  const override: Partial<Record<string, (args: Readonly<Record<string, unknown>>) => HandlerAnswer | undefined | Promise<HandlerAnswer | undefined>>> = {};
  const history = new Map<string, { out: Utxo; spent: boolean }>();
  const closeouts = new Map<string, ReturnType<typeof archivedSpend>>();
  const txStatus = w.node.txStatus.bind(w.node);
  w.node.txStatus = async (tx) => closeouts.has(tx) ? { confirmations: 2 } : txStatus(tx);
  let showCredit = true;
  w.env.OPERATOR_MODULE1_COMMIT = COMMIT;
  const start = w.clock.now();
  const guardian = (key: string): Party => ({ role: 'Guardian', signer: { type: 'KeyHash', hash: registry.hashOf(key) },
    organisation: null, rights: RIGHT.recover, notBefore: start - 2 * DAY, notAfter: null, removalAfter: null });
  const bravo: IdentityDatum = { ...rig.parent, guardianThreshold: 2,
    keys: [{ keyType: 'Ed25519', key: registry.publicKeyOf(SUPPLIER), purposes: PURPOSE.authentication + PURPOSE.transaction, pop: null }],
    parties: [rig.defaultParty, rig.moduleParty, { ...guardian('provider'), role: 'Provider', rights: 0 }, guardian(GUARDIAN), guardian('controller')] };
  rig.parentOutput.datum = encodeIdentityDatum(bravo);
  const successorId = hashOf('successor record');
  const successorDid = `did:vector:${successorId}`;
  const successor = rootRecord({ controller: registry.publicKeyOf('controller'), parties: [rig.defaultParty], keys: [
    { keyType: 'Ed25519', key: registry.publicKeyOf(SUCCESSOR_AUTH), purposes: PURPOSE.authentication, pop: null },
  ], endpoint: '', capabilities: [] });
  const next = recordUtxo(successorId, successor);
  w.world.chain.held.push(next);
  store.put('records', [SUCCESSOR], { did: successorDid, id: successorId, tx: next.txHash, recordRef: refOf(next), depositLovelace: '10000000', registeredAt: iso(start - DAY) });

  function advert(outHash: string, over: Partial<IdentityAdvertDatum> = {}): Utxo {
    return { txHash: outHash, outputIndex: 0, address: w.chain.deployment.advert.address, assets: { lovelace: 2_500_000n },
      datum: encodeIdentityAdvertDatum({ supplier_pkh: registry.hashOf(SUPPLIER), capability_id: CAPABILITY, model: agent.adverts[0]!.model,
        max_output_tokens: 4_000, max_processing_ms: 480_000, price_lovelace: 1_000_000n, supplier_bond_lovelace: 1_000_000n, buyer_bond_lovelace: 1_000_000n,
        endpoint_url: PROFILE.endpoint, detail_uri: PROFILE.detailUri, detail_hash: PROFILE.detailHash, advertised_at: start - DAY, status: 'Active', agent_id: id, ...over }) };
  }
  const posted = advert(hashOf('advert post'));
  history.set(refOf(posted), { out: posted, spent: true });
  store.put('adverts', [TARGET, agent.adverts[0]!.model], { ref: refOf(posted), tx: posted.txHash, ...PROFILE, postedAt: iso(start - DAY) });
  const advertTx = hashOf('advert terminal spend');
  const advertDeposit = posted.assets.lovelace;
  const advertFee = 200_000n;
  const supplier = registry.addressOf(SUPPLIER);
  const retirement = archivedSpend(advertTx, posted, supplier, advertFee, w.chain.deployment.advert.hash, 2);
  closeouts.set(advertTx, retirement);
  const indexedAdverts = new Map<string, Utxo>();
  const values = (rows: typeof retirement.inputs) => rows.map((row) => ({
    ref: formatOutRef(row.tx_hash, row.tx_index), address: row.payment_addr.bech32, lovelace: BigInt(row.value),
  }));
  const seal = valueSeal({ fee: advertFee, inputs: values(retirement.inputs), outputs: values(retirement.outputs) });
  const setAdvertReceipt = (verified: boolean) => {
    const state = StateFile.open(join(w.stateDir, 'advert.state.json'), { check: 'advert', network: 'vector-mainnet', record: use.name });
    const model = agent.adverts[0]!.model;
    state.setNote(`part.retire:${TARGET}:${model}`, { confirmed_at: iso(start), tx_hash: advertTx, verified_at: verified ? iso(start) : null,
      refs: { retiredRef: refOf(posted) }, facts: { phase: 'retire', agent: TARGET, model, supplierPkh: registry.hashOf(SUPPLIER), supplierAddress: supplier,
        depositLovelace: String(advertDeposit), feeLovelace: String(advertFee), creditLovelace: String(advertDeposit - advertFee), valueSeal: seal, approvalSession: 'close-advert' } });
  };
  const claimDatum = { claimerDid: id, claimerCredential: { type: 'VerificationKey' as const, hash: registry.hashOf(CLAIMER) }, submittedAt: start - 2 * DAY, challengeWindow: DAY };
  const originalClaim = { ...claimUtxo(CLAIM_TOKEN, claimDatum), txHash: hashOf('claim post') };
  history.set(refOf(originalClaim), { out: originalClaim, spent: true });
  const claimTx = hashOf('claim terminal spend');
  const { hash: claimScript } = MODULE1.claim;
  const mintEvent = { tx_hash: originalClaim.txHash, quantity: '1', block_time: Math.floor((start - DAY) / 1_000) };
  const burnEvent = { tx_hash: claimTx, quantity: '-1', block_time: Math.floor(start / 1_000) };
  let claimBurn = true;
  closeouts.set(claimTx, archivedSpend(claimTx, originalClaim, registry.addressOf(CLAIMER), 200_000n, claimScript, 1));
  const closeMovedClaim = () => {
    const terminal = { ...claimUtxo(CLAIM_TOKEN, { ...claimDatum, state: 'Challenged' }), txHash: hashOf('claim after challenge') };
    history.set(refOf(terminal), { out: terminal, spent: true });
    closeouts.set(claimTx, archivedSpend(claimTx, terminal, registry.addressOf(CLAIMER), 200_000n, claimScript, 3));
  };
  store.put('claims', ['clean', TARGET], { claimRef: refOf(originalClaim), claimTx: originalClaim.txHash, documentTx: hashOf('claim document'), claimToken: CLAIM_TOKEN,
    stakeLovelace: '50000000', windowMs: DAY, stakedAt: iso(start - 2 * DAY), withdrawableFrom: iso(start - DAY), withdrawTx: claimTx });

  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url === MANIFEST) return Response.json({ ...MODULE1_MANIFEST, identity: { ...MODULE1_MANIFEST.identity, identity_hash: w.chain.deployment.identity.hash } });
    const route = new URL(url).pathname;
    if (route === '/api/v1/utxo_info') {
      const { _utxo_refs: refs } = JSON.parse(String(init?.body)) as { _utxo_refs: string[] };
      return Response.json(refs.flatMap((ref) => {
        const row = history.get(ref);
        if (row === undefined) return [];
        const { out, spent } = row;
        return [{ ...spentRow(out), is_spent: spent }];
      }));
    }
    if (route === '/api/v1/credential_utxos') {
      const request = JSON.parse(String(init?.body)) as { _payment_credentials?: string[]; _extended?: boolean };
      if (request._extended !== true || request._payment_credentials?.length !== 1) throw new Error('Unexpected credential output request.');
      const [credential] = request._payment_credentials;
      if (credential === w.chain.deployment.advert.hash) return Response.json([...indexedAdverts.values()].map(spentRow));
      if (credential === claimScript) return Response.json([]);
      throw new Error('Unexpected script credential.');
    }
    if (route === '/api/v1/asset_history') {
      const payload = JSON.parse(String(init?.body));
      if (payload._asset_policy !== claimScript || payload._asset_name !== CLAIM_TOKEN) throw new Error('Unexpected claim token history request.');
      return Response.json([{ policy_id: claimScript, asset_name: CLAIM_TOKEN, minting_txs: claimBurn ? [burnEvent, mintEvent] : [mintEvent] }]);
    }
    if (route === '/api/v1/tx_info') {
      const { _tx_hashes: hashes } = JSON.parse(String(init?.body)) as { _tx_hashes: string[] };
      const found = closeouts.get(hashes[0]!);
      if (found !== undefined) return Response.json([found]);
      if (!showCredit) return Response.json([]);
    }
    return w.chain.fetchImpl(input, init);
  };
  const build = async (name: string, args: Record<string, unknown>, nowMs = w.clock.now()): Promise<RecordSpendBuild> => {
    const ctx = await context();
    const common = { id: String(args.did).replace('did:vector:', ''), changeAddress: String(args.changeAddress), nowMs };
    switch (name) {
      case TOOLS.change: return buildChangeController(ctx, { ...common, newController: String(args.new_controller) });
      case TOOLS.start: return buildRecoveryStart(ctx, { ...common, newController: String(args.new_controller), guardians: args.guardians as string[] });
      case TOOLS.complete: return buildRecoveryComplete(ctx, common);
      case TOOLS.retire: return buildRetire(ctx, common);
      case TOOLS.successor: return buildSetSuccessor(ctx, { ...common, successor: String(args.successor).replace('did:vector:', '') });
      case TOOLS.reclaim: return buildReclaim(ctx, common);
      default: throw new Error('Unexpected lifecycle build.');
    }
  };
  const hosted: HostedTools = { async call(name, args) {
    let found = await override[name]?.(args);
    if (found === undefined && name === TOOLS.resolve) {
      const { record } = await rig.record(String(args.did).replace('did:vector:', ''));
      found = { didDocumentMetadata: { vectorStatus: { effective: record.status.type }, deactivated: record.status.type === 'Retired' } };
    }
    if (found === undefined) {
      try {
        const made = await build(name, args);
        builds[name] = made;
        found = liveBuildAnswer('Lifecycle record spend', made);
      } catch (error) {
        if (name !== TOOLS.complete || !(error instanceof Error) || !error.message.startsWith('The recovery to the controller key')) throw error;
        found = { text: `Failed to build recovery completion: ${error.message}\n\n**Troubleshooting Tips:**\n1. Check the recovery date.` };
      }
    }
    heads.set(name, found);
    return schema.call(name, args);
  } };

  function go(phase: 'first' | 'second', irreversible?: GoFile['irreversible']) {
    w.writeGo({ tasks: ['lifecycle'], session: phase, irreversible: irreversible ?? (phase === 'first' ? ['controller-change'] : ['recovery-complete', 'retire', 'successor']),
      at: iso(w.clock.now()), expiresAt: iso(w.clock.now() + 6 * 3_600_000) });
    writeFileSync(join(w.stateDir, 'running-images.json'), JSON.stringify({ generated_at: iso(w.clock.now()), images: {} }));
  }
  const runBare = (...argv: string[]) => runTask(task, argv, w.deps({ hosted, fetchImpl: fetch, chain: { ...w.chain, fetchImpl: fetch }, readRegistry: (input) => {
    const loaded = loadRegistry(input);
    const sign = loaded.ring.sign.bind(loaded.ring);
    loaded.ring.sign = (hash, cbor) => { rig.signed.push(loaded.nameOfHash(hash)!); return sign(hash, cbor); };
    return loaded;
  } }));
  const run = (...argv: string[]) => runBare(...argv, '--run', LABEL);
  const state = () => w.state('lifecycle', LABEL);
  const evidence = () => w.evidence('lifecycle', LABEL);
  const replace = async (edit: (record: IdentityDatum) => IdentityDatum, recordId = id, move = false) => {
    const current = await rig.record(recordId);
    const next = { ...current.utxo, ...(move ? { txHash: hashOf(`moved ${recordId}`) } : {}), datum: encodeIdentityDatum(edit(current.record)) };
    w.world.chain.held = w.world.chain.held.filter((out) => refOf(out) !== refOf(current.utxo)).concat(next);
  };
  const setCredit = (show: boolean) => { showCredit = show; };
  const setClaimBurn = (show: boolean) => { claimBurn = show; };
  go('first');
  setAdvertReceipt(true);
  return { ...rig, bravo, successor, successorId, successorDid, posted, originalClaim, history, advert, go, run, runBare, state, evidence, override, builds, build,
    calls: schema.calls, setCredit, replace, closeouts, advertTx, indexedAdverts, claimTx, setAdvertReceipt, setClaimBurn, closeMovedClaim };
}
