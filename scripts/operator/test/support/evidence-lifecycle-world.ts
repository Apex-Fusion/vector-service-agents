import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { vi } from 'vitest';
import { addressDetails } from '../../../../packages/vector-read/src/guarded-decode.ts';
import { encodeIdentityAdvertDatum } from '../../../../packages/vector-read/src/index.ts';
import { encodeIdentityDatum, encodeIdentitySpend, utf8Hex } from '../../../../packages/vector-read/src/identity-codec.ts';
import type { IdentityDatum, IdentitySpend, Party } from '../../../../packages/vector-read/src/identity-codec.ts';
import { didKeyOf, ledgerMinLovelace } from '../../../../packages/buyer-core/src/vendored/mcp/attestation-build.ts';
import { buildRecoveryComplete } from '../../../../packages/buyer-core/src/vendored/mcp/identity-build.ts';
import { DAYS_7_MS, PURPOSE, RIGHT, tombstone } from '../../../../packages/buyer-core/src/vendored/mcp/identity-rules.ts';
import { blockfrostUrl } from '../../../../packages/buyer-core/src/vendored/mcp/jury-document.ts';
import { WITHDRAW_CLAIM_REDEEMER } from '../../../../packages/buyer-core/src/vendored/mcp/jury-codec.ts';
import { fixtureProtocolParameters } from '../../../../packages/buyer-core/test/fixtures/fixture-provider.ts';
import { CONFIG_UTXO, M1, REF_UTXOS, rootRecord } from '../../../../packages/buyer-core/test/fixtures/identity-world.ts';
import { claimUtxo, MODULE1, MODULE1_MANIFEST } from '../../../../packages/buyer-core/test/fixtures/jury-world.ts';
import { EvidenceFile } from '../../../checks/lib/evidence.ts';
import { iso } from '../../../checks/lib/format.ts';
import type { Utxo } from '../../../checks/lib/platform.ts';
import { VECTOR_MAINNET } from '../../../checks/lib/settings.ts';
import { StateFile } from '../../../checks/lib/state.ts';
import { valueSeal } from '../../lib/confirmed-spend.ts';
import { FactsFile } from '../../lib/facts.ts';
import { blake2b256Hex, formatOutRef } from '../../lib/platform.ts';
import { publicManifestFile } from '../../lib/registry.ts';
import { runTask } from '../../lib/runner.ts';
import evidence from '../../tasks/evidence.ts';
import lifecycle from '../../tasks/lifecycle.ts';
import use from '../../usecases/bid-evaluation.ts';
import { PackHosted } from './pack-hosted.ts';
import { hashOf, taskWorld } from './task-world.ts';

export const LABEL = 'l1';
const BASE = Date.UTC(2026, 10, 1, 12);
const MINUTE = 60_000;
const DAY = 86_400_000;
const SYSTEM_START = VECTOR_MAINNET.systemStartMs!;
const KOIOS = 'https://lifecycle-koios.test';
const OGMIOS = 'https://lifecycle-node.test';
const HOSTED = 'https://lifecycle-tool.test/mcp';
const COMMIT = '83'.repeat(20);
const MANIFEST = `https://raw.githubusercontent.com/Apex-Fusion/vector-agent-modules/${COMMIT}/${use.moduleManifestPath}`;
const CHANGE = 'change-controller';
const START = 'recovery-start';
const WAIT = 'recovery-wait';
const COMPLETE = 'recovery-complete';
const RETIRE = 'retire';
const SUCCESSOR = 'set-successor';
const RECLAIM = 'reclaim';
export const actions = [CHANGE, START, COMPLETE, RETIRE, SUCCESSOR, RECLAIM] as const;
const spec = use.lifecycle!;
const agent = use.agents.find(({ id }) => id === spec.agent)!;
const succ = use.records.find(({ id }) => id === spec.successor)!;
const org = use.organisations.find(({ id }) => id === agent.organisation)!;
const advertSpec = agent.adverts[0]!;
const didOf = (id: string) => `did:vector:${id}`;
const refOf = ({ txHash, outputIndex }: { txHash: string; outputIndex: number }) => formatOutRef(txHash, outputIndex);
const hashDatum = (hex: string) => blake2b256Hex(Buffer.from(hex, 'hex'));
const slot = (at: number) => (at - SYSTEM_START) / 1_000;

const movement = (policy_id: string, asset_name: string, quantity: string) => ({ policy_id, asset_name, quantity });
const assets = (u: Utxo) => Object.entries(u.assets).flatMap(([unit, quantity]) => unit === 'lovelace' ? [] : [movement(unit.slice(0, 56), unit.slice(56), String(quantity))]);
const pointer = (out: Pick<Utxo, 'txHash' | 'outputIndex'>) => ({ tx_hash: out.txHash, tx_index: out.outputIndex });
const inline = (u: Utxo, bytes: boolean) => u.datum ? { bytes: bytes ? u.datum : null, hash: hashDatum(u.datum) } : null;
const iO = (u: Utxo) => ({ ...pointer(u), payment_addr: { bech32: u.address, cred: addressDetails(u.address).paymentCredential!.hash },
  value: String(u.assets.lovelace), inline_datum: inline(u, false), asset_list: assets(u), reference_script: null });
const archived = (u: Utxo, is_spent: boolean) => ({ ...pointer(u), address: u.address, payment_cred: addressDetails(u.address).paymentCredential!.hash,
  value: String(u.assets.lovelace), inline_datum: inline(u, true), asset_list: assets(u), is_spent, reference_script: null });
const runOf = (script_hash: string, out: Utxo, bytes: string) => ({ script_hash, valid_contract: true, spends_input: pointer(out),
  input: { redeemer: { purpose: 'spend', datum: { bytes: null as string | null, hash: hashDatum(bytes), value: null as unknown } } } });
const changeOut = (txHash: string, outputIndex: number, address: string, lovelace: bigint): Utxo => ({ txHash, outputIndex, address, assets: { lovelace } });

export type Changed = 'controller' | 'guardian-period' | 'recovery-key' | 'recovery-period' | 'early-complete' | 'complete-controller' | 'complete-pending'
  | 'retire-pointer' | 'reclaim-minimum' | 'successor-status' | 'unattributed-claim';

export async function lifecycleEvidenceWorld(change?: Changed, { producerRefusal = false } = {}) {
  const names = [...new Set(['run', 'controller', 'fee', 'provider', org.accountableKey, ...spec.controllers, ...spec.guardians, ...succ.keys.map(({ key }) => key),
    advertSpec.supplierKey, agent.serviceKey])];
  const w = await taskWorld({ use, keys: names, shared: use.keys.filter(({ scope }) => scope === 'shared').map(({ name }) => name),
    env: { OPERATOR_USE_CASE: 'inventory-reorder', VECTOR_KOIOS_URL: KOIOS, VECTOR_OGMIOS_URL: OGMIOS, OPERATOR_HOSTED_URL: HOSTED, OPERATOR_MODULE1_COMMIT: COMMIT } });
  const k = w.keys.registry;
  const chain = w.chain.deployment;
  const identity = chain.identity;
  const { hash: policy } = identity;
  w.world.chain.held.push(...REF_UTXOS, CONFIG_UTXO);
  const keyEntries = Object.fromEntries(use.keys.filter(({ name }) => names.includes(name)).map(({ name, scope }) => [name, {
    scope, public_key_hex: k.publicKeyOf(name), key_hash: k.hashOf(name), address: k.addressOf(name),
  }]));
  const manifestPath = join(w.keys.root, publicManifestFile(use.name));
  const writeKeys = () => writeFileSync(manifestPath, JSON.stringify({ use_case: use.name, network: 'vector-mainnet', keys: keyEntries }), { mode: 0o600 });
  writeKeys();

  const store = FactsFile.open(join(w.stateDir, 'facts.json'), { useCase: use.name, network: 'vector-mainnet' });
  const ident = { network: 'vector-mainnet', record: use.name };
  // The runner writes both lifecycle headers. Do not make an unlabelled fixture journal.
  if (await w.run(lifecycle, 'status', '--run', LABEL) !== 0) throw new Error(w.screen.errorText);
  const lifecycleId = { ...ident, check: 'lifecycle', record: `${use.name}:${LABEL}` };
  const statePath = join(w.stateDir, `lifecycle.${LABEL}.state.json`);
  const journalPath = join(w.stateDir, `lifecycle.${LABEL}.evidence.json`);
  let state = StateFile.open(statePath, lifecycleId);
  const adState = StateFile.open(join(w.stateDir, 'advert.state.json'), { check: 'advert', ...ident });
  const [c1, c2] = spec.controllers;
  const d1 = k.publicKeyOf(c1), d2 = k.publicKeyOf(c2);
  const owner = hashOf('evidence lifecycle record id');
  const successor = hashOf('evidence lifecycle successor id');
  const regTx = hashOf('evidence lifecycle registration');
  const nextTx = hashOf('evidence lifecycle successor registration');
  const txs = Object.fromEntries(actions.map((action) => [action, hashOf(`evidence lifecycle ${action}`)])) as Record<(typeof actions)[number], string>;
  const startAt = BASE + 3 * MINUTE;
  const due = startAt + 30 * MINUTE + DAYS_7_MS;
  const completeAt = due + (change === 'early-complete' ? -2 : 3) * MINUTE;
  const retireAt = due + 8 * MINUTE;
  const times = { [CHANGE]: BASE + MINUTE, [START]: startAt, [COMPLETE]: completeAt, [RETIRE]: retireAt, [SUCCESSOR]: retireAt + 2 * MINUTE, [RECLAIM]: retireAt + 4 * MINUTE };
  const feeWallet = k.addressOf('fee');
  const fee = 250_000n;
  const holding = 10_000_000n;
  const feeFunds = 100_000_000n;
  const coefficient = fixtureProtocolParameters().coinsPerUtxoByte;
  const { lucid } = await w.chain.context(feeWallet);
  const guardian = (name: string): Party => {
    const entry = agent.parties.find(({ role, signer }) => role === 'Guardian' && signer.kind === 'key' && signer.key === name)!;
    return { role: 'Guardian', signer: { type: 'KeyHash', hash: k.hashOf(name) }, organisation: entry.organisation === null ? null : utf8Hex(entry.organisation),
      rights: RIGHT.recover, notBefore: BASE - 2 * DAY, notAfter: change === 'guardian-period' && name === spec.guardians[0] ? startAt + 5 * MINUTE : null, removalAfter: null };
  };
  const accountable: Party = { role: 'Accountable', signer: { type: 'KeyHash', hash: k.hashOf(org.accountableKey) }, organisation: utf8Hex(org.domain),
    rights: RIGHT.revoke, notBefore: BASE - 2 * DAY, notAfter: null, removalAfter: null };
  const responsible: Party = { ...accountable, role: 'Responsible', signer: { type: 'Script', hash: M1 }, organisation: null, rights: RIGHT.suspend };
  const provider: Party = { ...accountable, role: 'Provider', signer: { type: 'KeyHash', hash: k.hashOf('provider') }, organisation: null, rights: 0 };
  const initial = rootRecord({ controller: k.publicKeyOf('controller'), name: utf8Hex('Record in a test'),
    description: utf8Hex('Private fixture details must not be written to the public file.'), createdAt: BASE - DAY,
    guardianThreshold: 2, parties: [accountable, responsible, provider, ...spec.guardians.map(guardian)], capabilities: [utf8Hex(agent.capability)],
    keys: [{ keyType: 'Ed25519', key: k.publicKeyOf(advertSpec.supplierKey), purposes: PURPOSE.transaction, pop: null }] });
  const changed: IdentityDatum = { ...initial, controller: change === 'controller' ? initial.controller : d1, subagentEpoch: 1 };
  const started: IdentityDatum = { ...changed, pendingRecovery: { newController: change === 'recovery-key' ? d1 : d2, effectiveAfter: due - (change === 'recovery-period' ? MINUTE : 0) } };
  const completed: IdentityDatum = { ...started, controller: change === 'complete-controller' ? d1 : d2,
    pendingRecovery: change === 'complete-pending' ? started.pendingRecovery : null, subagentEpoch: 2 };
  const retired = tombstone(completed, { type: 'Retired', at: retireAt - MINUTE, successor: change === 'retire-pointer' ? successor : null });
  const named = { ...retired, status: { type: 'Retired' as const, at: retireAt - MINUTE, successor } };
  const successorDatum = rootRecord({ controller: k.publicKeyOf('controller'), name: utf8Hex('Another record in a test'),
    createdAt: BASE - DAY, parties: [accountable], status: change === 'successor-status' ? { type: 'Retired', at: BASE, successor: null } : { type: 'Active' },
    keys: succ.keys.map(({ key }) => ({ keyType: 'Ed25519', key: k.publicKeyOf(key), purposes: PURPOSE.authentication, pop: null })) });
  const record = (txHash: string, id: string, data: IdentityDatum, lovelace = holding): Utxo => ({ txHash, outputIndex: 2,
    address: identity.address, assets: { lovelace, [`${policy}${id}`]: 1n }, datum: encodeIdentityDatum(data) });
  const original = record(regTx, owner, initial);
  const target = record(nextTx, successor, successorDatum);
  const minimum = ledgerMinLovelace(lucid, identity.address, `${policy}${owner}`, encodeIdentityDatum(named));
  const final = record(txs[RECLAIM], owner, named, minimum + (change === 'reclaim-minimum' ? 1n : 0n));
  const datumByStep = { [CHANGE]: changed, [START]: started, [COMPLETE]: completed, [RETIRE]: retired, [SUCCESSOR]: named, [RECLAIM]: named };
  const spends: Record<(typeof actions)[number], IdentitySpend> = {
    [CHANGE]: { type: 'ChangeController' }, [START]: { type: 'RecoverInit', guardians: [3, 4] }, [COMPLETE]: { type: 'RecoverFinalize' },
    [RETIRE]: { type: 'Retire' }, [SUCCESSOR]: { type: 'SetSuccessor' }, [RECLAIM]: { type: 'Reclaim' },
  };
  for (const [id, who, out] of [[owner, agent.id, original], [successor, spec.successor, target]] as const) {
    store.put('records', [who], { did: didOf(id), id, tx: out.txHash, recordRef: refOf(out), depositLovelace: String(holding), registeredAt: iso(BASE - DAY) });
  }
  const collateral = changeOut(hashOf('evidence lifecycle collateral'), 0, feeWallet, 5_000_000n);
  const archive = new Map([original, target, collateral].map((u) => [refOf(u), archived(u, u === original)]));
  const situated = (hash: string, at: number) => ({ tx_hash: hash, tx_timestamp: at / 1_000, tx_block_index: 0, absolute_slot: slot(at),
    invalid_before: String(slot(at - MINUTE)), invalid_after: String(slot(at + 30 * MINUTE)) });
  const rows = new Map<string, ReturnType<typeof situated> & {
    inputs: ReturnType<typeof iO>[]; outputs: ReturnType<typeof iO>[]; fee: string; assets_minted: ReturnType<typeof movement>[];
    reference_inputs: ReturnType<typeof pointer>[]; collateral_inputs: ReturnType<typeof pointer>[]; plutus_contracts: ReturnType<typeof runOf>[];
  }>();
  const signers = new Map<string, string[]>();
  const missing = new Set<string>();
  function row(tx: string, at: number, input: Utxo, outputs: Utxo[], scripture: string, redeemer: string, wallet: string,
      references: ReturnType<typeof pointer>[], minted: ReturnType<typeof movement>[] = [], changeInput = true) {
    const funding = changeOut(hashOf(`evidence lifecycle funds ${tx}`), 0, wallet, feeFunds);
    const inputs = [input, ...(changeInput ? [funding] : [])];
    const put = { ...situated(tx, at), inputs: inputs.map(iO), outputs: outputs.map(iO), fee: String(fee), assets_minted: minted,
      reference_inputs: references, collateral_inputs: [pointer(collateral)], plutus_contracts: [runOf(scripture, input, redeemer)] };
    rows.set(tx, put);
    return { put, inputs };
  }
  row(regTx, BASE - DAY, collateral, [original], identity.hash, 'd87980', feeWallet, []);
  row(nextTx, BASE - DAY + MINUTE, collateral, [target], identity.hash, 'd87980', feeWallet, []);
  const dataAuthorities = {
    [CHANGE]: ['controller', c1], [START]: [...spec.guardians, c2], [COMPLETE]: [], [RETIRE]: [c2], [SUCCESSOR]: [c2, 'controller'], [RECLAIM]: [c2],
  };
  const producer = new PackHosted({});
  const earlyHosted = { async call(name: string, args: Record<string, unknown>) {
    if (name !== 'vector_build_identity_recovery_complete' || args.did !== didOf(owner) || args.changeAddress !== feeWallet) {
      throw new Error('The early builder received the wrong tool, record or wallet.');
    }
    try {
      await buildRecoveryComplete(await w.chain.context(feeWallet), { id: owner, changeAddress: feeWallet, nowMs: w.clock.now() });
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      producer.handlers[name] = () => ({ text: `Failed to build recovery completion: ${error.message}`, isError: true });
      return producer.call(name, args);
    }
    throw new Error('The early builder did not refuse.');
  } };
  let previous = original;
  let beforeDatum = initial;
  for (const action of actions) {
    const tx = txs[action], at = times[action];
    const out = action === RECLAIM ? final : record(tx, owner, datumByStep[action]);
    archive.set(refOf(out), archived(out, action !== RECLAIM));
    const isReclaim = action === RECLAIM;
    const payment = changeOut(tx, 0, feeWallet, (isReclaim ? 0n : feeFunds) + previous.assets.lovelace - out.assets.lovelace - fee);
    const references = [pointer(chain.refs.identity!), ...(action === SUCCESSOR ? [pointer(target)]
      : action === RECLAIM ? [] : [pointer(CONFIG_UTXO)])];
    const { put, inputs } = row(tx, at, previous, [payment, out], policy, encodeIdentitySpend(spends[action]), feeWallet, references, [], !isReclaim);
    if (action === START) put.plutus_contracts[0]!.input.redeemer.datum.value = { constructor: 9, fields: [{ list: [{ int: 3 }, { int: 4 }] }] };
    signers.set(tx, dataAuthorities[action].map((name) => k.hashOf(name)));
    const observed = iso(at + 2_000);
    state.recordStep(action, { tx_hash: tx, confirmed_at: observed, refs: { recordBefore: refOf(previous), recordAfter: refOf(out) }, facts: {
      agent: agent.id, did: didOf(owner), datumHash: hashDatum(out.datum!), keptLovelace: String(out.assets.lovelace),
      before: { effective: beforeDatum.status.type, subagentEpoch: beforeDatum.subagentEpoch, lovelace: String(previous.assets.lovelace) },
      ...(isReclaim ? { reclaimSeal: valueSeal({ fee, inputs: inputs.map((u) => ({ ref: refOf(u), address: u.address, lovelace: u.assets.lovelace })),
        outputs: [out, payment].map((u) => ({ ref: refOf(u), address: u.address, lovelace: u.assets.lovelace })) }) } : {}),
    } });
    state.markVerified(action, iso(at + 3_000));
    store.put('lifecycle', [action], { tx, at: action === START ? iso(due) : action === RETIRE ? iso(retireAt - MINUTE) : observed });
    if (action === START && producerRefusal) {
      // Let the real task record the builder refusal while the pending output is live.
      w.world.chain.held.push(out);
      w.clock.t = startAt + 5_000;
      w.writeGo({ tasks: ['lifecycle'], at: iso(w.clock.now()), expiresAt: iso(w.clock.now() + HOUR) });
      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        vi.setSystemTime(w.clock.now());
        const exit = await runTask(lifecycle, ['run', '--run', LABEL, '--submit'], w.deps({ hosted: earlyHosted }));
        if (exit !== 4) throw new Error(w.screen.errorText);
      } finally {
        vi.useRealTimers();
        rmSync(w.goPath, { force: true });
        w.world.chain.held = w.world.chain.held.filter((item) => item !== out);
      }
      state = StateFile.open(statePath, lifecycleId);
    }
    previous = out;
    beforeDatum = datumByStep[action];
  }
  state.recordStep(WAIT, { confirmed_at: iso(due + MINUTE), tx_hash: null, refs: { recordBefore: `${txs[START]}#2`, recordAfter: `${txs[START]}#2`, recoveryStart: txs[START] },
    facts: { agent: agent.id, effectiveAfter: due } });
  state.markVerified(WAIT, iso(due + MINUTE + 1_000));
  store.put('lifecycle', [WAIT], { tx: txs[START], at: iso(due) });
  const message = `The build tool refused recovery completion before ${iso(due)}. No transaction was signed.`;
  if (!producerRefusal) {
    state.setNote('earlyRecoveryCompletion', { tx: txs[START], effectiveAfter: due });
    EvidenceFile.open(journalPath, lifecycleId).add({ step: WAIT, status: 'tool_refused', expected: true,
      tool: 'vector_build_identity_recovery_complete', message, at: iso(startAt + 5_000) });
  }

  const advert: Utxo = { txHash: hashOf('evidence lifecycle advert posted'), outputIndex: 1, address: chain.advert.address, assets: { lovelace: advertSpec.depositLovelace },
    datum: encodeIdentityAdvertDatum({ supplier_pkh: k.hashOf(advertSpec.supplierKey), capability_id: agent.capability, model: advertSpec.model,
      max_output_tokens: advertSpec.maxOutputTokens, max_processing_ms: advertSpec.windowMs, price_lovelace: advertSpec.priceLovelace,
      supplier_bond_lovelace: advertSpec.supplierBondLovelace, buyer_bond_lovelace: advertSpec.buyerBondLovelace,
      endpoint_url: advertSpec.origin, detail_uri: `${advertSpec.origin}/agent.json`, detail_hash: hashOf('evidence lifecycle terms'), advertised_at: BASE - 5 * MINUTE,
      status: 'Active', agent_id: owner }) };
  store.put('adverts', [agent.id, advertSpec.model], { ref: refOf(advert), tx: advert.txHash, detailUri: `${advertSpec.origin}/agent.json`,
    detailHash: hashOf('evidence lifecycle terms'), endpoint: advertSpec.origin, postedAt: iso(BASE - 5 * MINUTE) });
  archive.set(refOf(advert), archived(advert, true));
  const advertTx = hashOf('evidence lifecycle advert retirement');
  const supplier = k.addressOf(advertSpec.supplierKey);
  const advertOutput = changeOut(advertTx, 0, supplier, feeFunds + advertSpec.depositLovelace - fee);
  const paid = row(advertTx, retireAt - 2 * MINUTE, advert, [advertOutput], chain.advert.hash, 'd87b80', supplier, [pointer(chain.refs.advert!)]);
  signers.set(advertTx, [k.hashOf(advertSpec.supplierKey)]);
  adState.setNote(`part.retire:${agent.id}:${advertSpec.model}`, { tx_hash: advertTx, confirmed_at: iso(retireAt - MINUTE), verified_at: iso(retireAt - MINUTE),
    refs: { retiredRef: refOf(advert) }, facts: { phase: 'retire', agent: agent.id, model: advertSpec.model, supplierPkh: k.hashOf(advertSpec.supplierKey),
      supplierAddress: supplier, depositLovelace: String(advertSpec.depositLovelace), feeLovelace: String(fee), creditLovelace: String(advertSpec.depositLovelace - fee),
      approvalSession: 'test operator context only',
      valueSeal: valueSeal({ fee, inputs: paid.inputs.map((u) => ({ ref: refOf(u), address: u.address, lovelace: u.assets.lovelace })),
        outputs: [{ ref: refOf(advertOutput), address: supplier, lovelace: advertOutput.assets.lovelace }] }) } });

  const claimToken = hashOf('evidence lifecycle claim token');
  const claimRef = hashOf('evidence lifecycle claim');
  const burnTx = hashOf('evidence lifecycle claim burn');
  const claimTerms = { claimerDid: owner, claimerCredential: { type: 'VerificationKey' as const, hash: k.hashOf(agent.serviceKey) },
    submittedAt: BASE - DAY, challengeWindow: 30 * MINUTE, stakeAmount: 50_000_000n };
  const claim = { ...claimUtxo(claimToken, claimTerms), txHash: claimRef };
  const withdrawn = change !== 'unattributed-claim';
  const lastClaim = withdrawn ? claim : { ...claimUtxo(claimToken, { ...claimTerms, state: 'Challenged' }), txHash: hashOf('evidence challenged claim') };
  const claimAt = retireAt - 3 * MINUTE;
  store.put('claims', ['clean', agent.id], { claimRef: refOf(claim), claimTx: claim.txHash, claimToken, documentTx: hashOf('evidence lifecycle claim document'),
    stakeLovelace: String(claimTerms.stakeAmount), windowMs: claimTerms.challengeWindow, stakedAt: iso(claimTerms.submittedAt),
    withdrawableFrom: iso(claimTerms.submittedAt + claimTerms.challengeWindow), withdrawTx: withdrawn ? burnTx : 'not open' });
  archive.set(refOf(claim), archived(claim, true));
  archive.set(refOf(lastClaim), archived(lastClaim, true));
  const claimScript = MODULE1.claim.hash;
  const claimWallet = k.addressOf(agent.serviceKey);
  row(claim.txHash, claimTerms.submittedAt + 10_000, collateral, [claim], claimScript, 'd87980', claimWallet, [], [movement(claimScript, claimToken, '1')]);
  row(burnTx, claimAt, lastClaim, [changeOut(burnTx, 0, claimWallet, claim.assets.lovelace), changeOut(burnTx, 1, claimWallet, feeFunds - fee)],
    claimScript, withdrawn ? WITHDRAW_CLAIM_REDEEMER : 'd87c80', claimWallet, [pointer(MODULE1.claim.ref)], [movement(claimScript, claimToken, '-1')]);
  signers.set(burnTx, [k.hashOf(agent.serviceKey)]);
  const history = { policy_id: claimScript, asset_name: claimToken, minting_txs: [
    { tx_hash: burnTx, quantity: '-1', block_time: claimAt / 1_000 }, { tx_hash: claim.txHash, quantity: '1', block_time: (claimTerms.submittedAt + 10_000) / 1_000 },
  ] };
  const candidate = new Map<string, Utxo>();
  w.world.chain.held.push(final, target);
  w.clock.t = times[RECLAIM] + HOUR;
  w.node.txStatus = async (txHash) => ({ confirmations: rows.has(txHash) && !missing.has(txHash) ? 5 : null });

  const report = { format: 1, label: LABEL, use_case: use.name, kind: 'lifecycle', date: iso(retireAt).slice(0, 10), tenant: null,
    delegations: [], vaults: [], approvals: [], challenged: null, rfq_ids: [], lifecycle: [...actions], sub_delegations: [], hires: [],
    refusals: [{ step: 'l1-03', kind: 'tool', message }] };
  const resolve = {
    old: { didDocument: null, didResolutionMetadata: {}, didDocumentMetadata: { canonicalId: didOf(owner), deactivated: true,
      vectorStatus: { status: 'retired', effective: 'retired', successor: didOf(successor), at: iso(retireAt - MINUTE) },
      vectorLedger: { txId: final.txHash, outputIndex: final.outputIndex, confirmations: 5 } } },
    next: { didDocument: { id: didOf(successor), verificationMethod: [successorDatum.controller, ...successorDatum.keys.map(({ key }) => key)].map((pub) => ({
      id: `${didOf(successor)}#${blake2Key(pub)}`, type: 'Multikey', controller: didOf(successor), publicKeyMultibase: didKeyOf(pub).slice('did:key:'.length),
    })) }, didResolutionMetadata: {}, didDocumentMetadata: { canonicalId: didOf(successor), vectorStatus: { status: 'active', effective: 'active' },
      vectorLedger: { txId: target.txHash, outputIndex: target.outputIndex, confirmations: 5 } } },
  };
  function blake2Key(pub: string): string {
    const which = names.find((name) => k.publicKeyOf(name) === pub)!;
    return k.hashOf(which);
  }
  const reads: string[] = [];
  const signsDown = { active: false, partial: false };
  const params: { coefficient: string | null } = { coefficient: String(coefficient) };
  const fetchImpl: typeof fetch = async (uri, init) => {
    const url = new URL(String(uri));
    if (String(uri) === MANIFEST) {
      reads.push('module1');
      return Response.json({ ...MODULE1_MANIFEST, identity: { ...MODULE1_MANIFEST.identity, identity_hash: identity.hash } });
    }
    const signer = url.pathname.match(/^\/txs\/([0-9a-f]{64})\/required_signers$/)?.[1];
    if (signer && url.origin === new URL(blockfrostUrl()).origin) {
      reads.push('required_signers');
      if (signsDown.active || !signers.has(signer)) return new Response('', { status: 503 });
      return Response.json(signers.get(signer)!.map((witness_hash) => ({ witness_hash })), signsDown.partial ? { headers: { link: '<next>; rel="next"' } } : {});
    }
    const args = JSON.parse(String(init?.body)) as Record<string, unknown>;
    if (url.origin === OGMIOS) {
      reads.push('protocolParameters');
      if (args.method !== 'queryLedgerState/protocolParameters') throw new Error('Unexpected node read');
      return Response.json({ jsonrpc: '2.0', id: args.id, result: { minUtxoDepositCoefficient: params.coefficient } });
    }
    if (url.origin === KOIOS) {
      const name = url.pathname.slice('/api/v1/'.length);
      reads.push(name);
      if (name === 'tx_info') return Response.json((args._tx_hashes as string[]).flatMap((tx) => rows.has(tx) ? [rows.get(tx)!] : []));
      if (name === 'utxo_info') return Response.json((args._utxo_refs as string[]).flatMap((ref) => archive.has(ref) ? [archive.get(ref)!] : []));
      if (name === 'credential_utxos') {
        const [id] = args._payment_credentials as string[];
        return Response.json([...candidate.values()].filter(({ address }) => addressDetails(address).paymentCredential?.hash === id).map((out) => archived(out, false)));
      }
      if (name === 'asset_history' && args._asset_policy === claimScript && args._asset_name === claimToken) return Response.json([history]);
    }
    throw new Error('The fixture was asked to read an unexpected service');
  };
  const hosted = new PackHosted({ vector_resolve_did: ({ did }) => {
    if (did === didOf(owner)) return resolve.old;
    if (did === didOf(successor)) return resolve.next;
    throw new Error('The fixture resolver was asked about an unexpected record');
  } });
  async function produce() {
    mkdirSync(join(w.stateDir, 'runs'), { recursive: true, mode: 0o700 });
    writeFileSync(join(w.stateDir, 'runs', `${LABEL}.json`), JSON.stringify(report), { mode: 0o600 });
    const exit = await runTask(evidence, ['run', '--run', LABEL, '--number', '1'], w.deps({ hosted, fetchImpl, chain: { ...w.chain, koiosUrl: KOIOS, fetchImpl } }));
    const result = w.machine().result;
    const file = typeof result.file === 'string' ? result.file : null;
    const text = file === null ? null : readFileSync(join(w.stateDir, file), 'utf8');
    return { exit, file, text, doc: text === null ? null : JSON.parse(text) as Record<string, unknown>, result, error: w.screen.errorText };
  }
  return { w, produce, archive, rows, signers, keyEntries, writeKeys, manifestPath, journalPath, state, adState, txs, missing, rowsOf: (action: (typeof actions)[number]) => rows.get(txs[action])!,
    signsDown, params, report, resolve, due, advert, advertTx, history, claim, burnTx, store, agent, final, target, candidate, reads, statePath,
    producerCalls: producer.calls };
}

const HOUR = 60 * MINUTE;
