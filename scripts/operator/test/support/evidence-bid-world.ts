import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ACCEPT_WINDOW_MS, blake2b256Hex, documentHash, documentUri, module1FromManifest } from '../../../../packages/buyer-core/src/index.ts';
import { CONFIG_TOKEN_NAME } from '../../../../packages/buyer-core/src/vendored/mcp/identity-deployment.ts';
import { PURPOSE, tombstone } from '../../../../packages/buyer-core/src/vendored/mcp/identity-rules.ts';
import { REDEEMER } from '../../../../packages/buyer-core/src/vendored/mcp/marketplace-constants.ts';
import { documentMetadata } from '../../../../packages/buyer-core/src/vendored/mcp/jury-document.ts';
import { encodeChallengeDatum, encodeClaimDatum, encodeJuryDatum } from '../../../../packages/buyer-core/src/vendored/mcp/jury-codec.ts';
import type { Contract, Row, TxIo, TxRow } from '../../../../packages/buyer-core/test/fixtures/ledger-read-world.ts';
import {
  DAY, attestation, attestationUtxo, delegation, delegationUtxo, koiosRow, ledgerWorld, liveRecord, MAINNET, recordUtxo, vaultUtxo,
} from '../../../../packages/buyer-core/test/fixtures/ledger-read-world.ts';
import { advertUtxo, escrowUtxo, identityEscrow, IDENTITY_ADVERT } from '../../../../packages/buyer-core/test/fixtures/escrow-identity.fixture.ts';
import { BID_DESK_CLAIM, QUOTE_CHECKS, QUOTE_SCHEMA, RANKING_SCHEMA, receiptSha256 } from '../../../../packages/usecase-kit/src/bids/index.ts';
import type { Components } from '../../../../packages/usecase-kit/src/bids/index.ts';
import { claimDocument, evidenceDocument } from '../../../../packages/usecase-kit/src/dispute/index.ts';
import { makeProposal, PROPOSAL_SCHEMA, RECEIPT_CHECKS, RESULT_SCHEMA } from '../../../../packages/usecase-kit/src/protocol/index.ts';
import type { ProtocolResult } from '../../../../packages/usecase-kit/src/protocol/index.ts';
import {
  ADVERT_ADDRESS, ESCROW_ADDRESS, ESCROW_SCRIPT_HASH, canonicalize, encodeAdvertDatum, encodeEscrowDatum, plutusAddressFromBech32, plutusAddressToBech32,
  promptHashForPayload, requestSpecHash,
} from '../../../../packages/vector-read/src/index.ts';
import { decodeVaultDatum, encodeVaultDatum, utf8Hex } from '../../../../packages/vector-read/src/identity-codec.ts';
import type { Delegator, IdentityDatum, Status } from '../../../../packages/vector-read/src/identity-codec.ts';
import { plutusAddressToData as addressData } from '../../../../packages/vector-read/src/vendored/shared/cbor/address.ts';
import { encodePlutusDataHex } from '../../../../packages/vector-read/src/vendored/shared/cbor/plutus-data.ts';
import type { PlutusData } from '../../../../packages/vector-read/src/vendored/shared/cbor/plutus-data.ts';
import { parseKeyText } from '../../../checks/lib/keys.ts';
import type { Utxo } from '../../../checks/lib/platform.ts';
import { CLAIM_STAKE_LOVELACE, CLAIM_WINDOW_MS, RUN_APPROVAL_VALIDITY_MS } from '../../lib/claim-constants.ts';
import type { AgentSpec } from '../../lib/contract.ts';
import { bidEvaluation } from '../../lib/evidence/bid-evaluation.ts';
import { isObject, txOf } from '../../lib/evidence/types.ts';
import type { Obj } from '../../lib/evidence/types.ts';
import { FactsFile } from '../../lib/facts.ts';
import { MOCK_PUBLIC_BASE } from '../../lib/mock-hosts.ts';
import { publicManifestFile } from '../../lib/registry.ts';
import { runTask } from '../../lib/runner.ts';
import { createEvidenceTask } from '../../tasks/evidence.ts';
import data from '../../usecases/bid-evaluation.ts';
import { PackHosted } from './pack-hosted.ts';
import { ScriptedNode, hashOf, taskWorld } from './task-world.ts';

const BASE = Date.UTC(2026, 11, 1);
const MS = 60_000;
const ms = (minute: number): number => BASE + minute * MS;
const iso = (minute: number): string => new Date(ms(minute)).toISOString();
const hash = (label: string): string => hashOf(`bid evidence ${label}`);
const block = (minute: number) => ({ hash: hash(`block ${minute}`), abs_slot: 30_000_000 + minute * 60,
  block_height: 9_000_000 + minute, block_time: ms(minute) / 1000 });
const datumHash = (hex: string): string => blake2b256Hex(Buffer.from(hex, 'hex'));
const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');
const ref = (label: string, ix = 0): string => `${hash(label)}#${ix}`;
const id = (agent: string): string => hash(`did ${agent}`);
const did = (agent: string): string => `did:vector:${id(agent)}`;
const vote = (index: number, ...fields: PlutusData[]): PlutusData => ({ kind: 'constr', index: BigInt(index), fields });
const bytes = (hex: string): PlutusData => ({ kind: 'bytes', hex });
const int = (value: number): PlutusData => ({ kind: 'int', value: BigInt(value) });
const key = (name: string) => parseKeyText(hash(`test key ${name}`), 'run');
const keyAddress = (pkh: string): string => plutusAddressToBech32({ paymentCredential: { type: 'VerificationKey', hash: pkh }, stakeCredential: null }, 1);
const scriptAddress = (pkh: string): string => plutusAddressToBech32({ paymentCredential: { type: 'Script', hash: pkh }, stakeCredential: null }, 1);
const des = data.agents.filter(({ kind }) => kind === 'bid-desk');
const buyer = data.agents.find(({ kind }) => kind === 'sourcing-agent')!;
const target = des.find(({ end }) => end.record === 'revoked')!;
const principal = key('hirer');
const issuer = key('compliance registry');
const accountable = key('accountable');
const parentKey = key('sourcing delegation');
const vaultFunds = 40_000_000n;
const owner: Delegator = { type: 'PrincipalKey', hash: principal.keyHash, organisation: null };
const domainOf = (agent: AgentSpec): string => data.organisations.find(({ id: oid }) => oid === agent.organisation)!.domain;
const controller = key('controller');
const DECLARED_ISSUER = did('hirer');
const VERIFY = Object.fromEntries(RECEIPT_CHECKS.map((name) => [name, true]));
const DELEGATION = hash('delegation');
const ROOT_VAULT = ref('vault');
const JURY = hash('jury').slice(0, 56);
const CASE = hash('case');
const CHALLENGE_TOKEN = `63686c5f${hash('challenge token').slice(0, 56)}`;
const claimToken = (agent: string): string => `636c6d5f${hash(`claim token ${agent}`).slice(0, 56)}`;
const CHALLENGE = { claim: ref(`claim ${target.id}`), evidence: hash('evidence'), challenge: ref('challenge') };
const asRef = (utxo: Utxo): string => `${utxo.txHash}#${utxo.outputIndex}`;
const wallet = keyAddress(principal.keyHash);
const MODULE_MANIFEST = JSON.parse(readFileSync(new URL('../../../../packages/buyer-core/test/fixtures/module1-mainnet-manifest.json', import.meta.url), 'utf8')) as Obj;
const MODULE1 = module1FromManifest(MODULE_MANIFEST, 'fixture');
const M1 = (MODULE_MANIFEST.hashes as Obj).identity_party as string;
const HOSTED = 'https://builder.example/mcp';
const INDEXER = 'https://marketplace.example';
const KOIOS = 'https://koios.example';
const MODEL_ENDPOINT = 'https://model.example';
const MOCK_TOKEN = hash('fixture mock operator token');
const RANKING_ROUTE = 'POST /sourcing/rankings';
const PROPOSE_STAGES = { clean: ['propose'], failure: ['propose-a', 'propose-b', 'propose-c', 'propose-d'] } as const;

interface Options {
  readonly vault?: 'other' | 'wallet' | 'close-replacement'; readonly noClose?: boolean; readonly wrongDesk?: boolean; readonly missingCatalog?: boolean;
  readonly wrongAuthority?: boolean; readonly wrongProposal?: boolean;
  readonly scorer?: 'wrong-actor' | 'wrong-parent' | 'wrong-parent-record' | 'wrong-delegate-key' | 'same-delegate-key' | 'same-did';
  readonly wrongApproval?: boolean; readonly absentExecute?: boolean;
  readonly wrongRequestDigest?: boolean; readonly wrongRanking?: boolean; readonly failureWrite?: boolean; readonly fault?: 'off' | 'different';
  readonly release?: 'absent' | 'early' | 'not-release'; readonly case?: 'waiting' | 'claimed' | 'wrong-resolution';
  readonly wrongEvidenceQuote?: boolean;
  readonly compliance?: 'wrong-hash' | 'after-hold' | 'wrong-issuer' | 'wrong-contest'; readonly holdProposal?: 'with-target' | 'outside-hold' | 'before-apply' | 'at-apply';
  readonly holdSpend?: 'after-submit' | 'before-post' | 'during-proposal' | 'at-submit';
  readonly revocation?: 'wrong-author' | 'wrong-configured-key' | 'late-invalid-from' | 'resolver-active' | 'resolver-other' | 'resolver-unbound' | 'resolver-error' | 'no-tombstone';
  readonly model?: 'missing-output' | 'wrong-output' | 'wrong-model' | 'wrong-buyer' | 'no-accept' | 'wrong-spend' | 'bad-signature' | 'reused' | 'pending' | 'late-confirmed' | 'identity';
  readonly correlation?: 'wrong-digest' | 'missing-digest' | 'after-submit' | 'before-post' | 'unauthorized' | 'dropped' | 'duplicate';
  readonly relationship?: 'extra-rank' | 'wrong-subjob';
  readonly reverse?: 'wrong-score' | 'wrong-price' | 'wrong-lead-time' | 'wrong-reliability' | 'wrong-compliance';
  readonly reorderedIds?: boolean;
}

function accepted<T>(result: ProtocolResult<T, string>): T {
  if (!result.ok) throw new Error(result.detail);
  return result.value;
}

function input(reference: string, credential = principal.keyHash, address = wallet): TxIo {
  return { tx_hash: txOf(reference), tx_index: Number(reference.slice(65)), payment_addr: { cred: credential, bech32: address },
    value: '5000000', inline_datum: null, asset_list: [] };
}
function io(utxo: Utxo): TxIo {
  const row = koiosRow(utxo);
  return { ...input(asRef(utxo), row.payment_cred, utxo.address), value: row.value, inline_datum: utxo.datum ? { bytes: utxo.datum } : null,
    datum_hash: utxo.datum ? datumHash(utxo.datum) : null, asset_list: row.asset_list };
}
function spend(script: string, source: TxIo, action: number, fields: unknown[] = []): Contract {
  return { script_hash: script, spends_input: { tx_hash: source.tx_hash, tx_index: source.tx_index }, valid_contract: true,
    input: { redeemer: { purpose: 'spend', datum: { hash: hash('redeemer'), value: { constructor: action, fields } } } } };
}
const mint = (script: string): Contract => ({
  script_hash: script, spends_input: null, valid_contract: true,
  input: { redeemer: { purpose: 'mint', datum: { hash: hash('mint redeemer'), value: { constructor: 0, fields: [] } } } },
});
function movement(policy_id: string, asset_name: string, quantity: string): Obj { return { policy_id, asset_name, quantity }; }
function rosterFact(agent: string, utxo: Utxo) {
  return { did: did(agent), id: id(agent), tx: utxo.txHash, recordRef: asRef(utxo), depositLovelace: String(utxo.assets.lovelace), registeredAt: iso(0) };
}

interface Hire { readonly step: string; readonly agent: AgentSpec; readonly result: Obj; readonly at: number; readonly submitted: number; readonly end: number | null; readonly request?: string; readonly paid: boolean }
interface Quoted { readonly result: Obj; readonly receipt: Obj; readonly signature: string }

export async function bidRun(kind: 'clean' | 'failure', options: Options = {}) {
  const failure = kind === 'failure';
  const label = failure ? 'r2' : 'r1';
  const tenant = `fixture-${label}`;
  const makers = new Map(data.agents.map((agent) => [agent.id, key(agent.id)]));
  const services = new Map(data.agents.map((agent) => [agent.id, key(agent.serviceKey)]));
  const scorerKeys = new Map(data.subagents.map((scorer, i) => [scorer.id, {
    auth: key(`${scorer.id}-auth`),
    delegate: key(`${options.scorer === 'same-delegate-key' && i === 1 ? data.subagents[0]!.id : scorer.id}-delegation`),
  }]));
  const actualAccountable = options.revocation === 'wrong-configured-key' ? key('unconfigured accountable') : accountable;
  const txs: TxRow[] = [];
  const blocks = new Map<string, ReturnType<typeof block>>();
  const blocksOf = new Map<string, ReturnType<typeof block>>();
  const epochs = new Map<string, number>();
  const outputs: Row[] = [];
  const live: Utxo[] = [];
  const settled = new Set<string>();
  const metadata = new Map<string, unknown>();
  const submittedByEscrow = new Map<string, string>();
  const acceptedModels = new Map<string, string>();
  const entries: Obj[] = [];
  const reports = new Map<string, string>();
  const histories = new Map<string, IdentityDatum>();
  const initial = new Map<string, Utxo>();
  const subDelegations: Obj[] = [];
  const log: Obj[] = [];
  const rankingRows: Obj[] = [];
  const rfqs: string[] = [];
  const manifests = new Map(data.agents.map((agent) => [agent.id, {
    uri: `${agent.endpoint}/manifest.json`,
    body: JSON.stringify({ keys: { service_pkh: services.get(agent.id)!.keyHash,
      ...(agent === buyer ? { compliance_issuer_pkh: (options.compliance === 'wrong-issuer' ? principal : issuer).keyHash } : {}) } }),
  }]));
  let vaultHead = ROOT_VAULT;
  const vaultOutputs = new Map<string, Utxo>();
  const releaseTx = hash('release quote-a3');
  const tx = (tx_hash: string, at: number, inputs: TxIo[] = [], made: TxIo[] = [], plutus_contracts: Contract[] = [], assets_minted: Obj[] = [], fields: Obj = {}): void => {
    const atBlock = block(at);
    const index = epochs.get(atBlock.hash) ?? 0;
    epochs.set(atBlock.hash, index + 1);
    blocks.set(atBlock.hash, atBlock);
    blocksOf.set(tx_hash, atBlock);
    txs.push({ tx_hash, tx_timestamp: atBlock.block_time, inputs, outputs: made, plutus_contracts, assets_minted, fee: '200000',
      block_hash: atBlock.hash, absolute_slot: atBlock.abs_slot, block_height: atBlock.block_height, tx_block_index: index, ...fields });
    settled.add(tx_hash);
  };
  const historical = (utxo: Utxo, is_spent: boolean): void => { outputs.push(koiosRow(utxo, { is_spent, datum_hash: utxo.datum ? datumHash(utxo.datum) : null })); };
  const model = key('model supplier');
  const identityModel = options.model === 'identity';
  const { agent_id: _agentId, ...legacyAdvert } = IDENTITY_ADVERT;
  const modelTerms = { ...legacyAdvert, supplier_pkh: model.keyHash, capability_id: 'llm.text.generate.v1', model: 'fixture-model', endpoint_url: MODEL_ENDPOINT };
  const modelAdvert = identityModel
    ? advertUtxo({ ...modelTerms, agent_id: id('model supplier') }, { txHash: hash('model advert'), address: MAINNET.advert.address })
    : { txHash: hash('model advert'), outputIndex: 0, address: ADVERT_ADDRESS, assets: { lovelace: 2_000_000n }, datum: encodeAdvertDatum(modelTerms) };
  historical(modelAdvert, false);
  tx(modelAdvert.txHash, 0, [input(ref('model advert input'))], [io(modelAdvert)]);
  const modelRecord = { ...recordUtxo(id('model supplier'), liveRecord({}, [model.publicKeyHex])), txHash: hash('model record') };
  if (identityModel) {
    historical(modelRecord, false);
    live.push(modelRecord);
    tx(modelRecord.txHash, 0, [input(ref('model record seed'))], [io(modelRecord)], [mint(MAINNET.identity.hash)],
      [movement(MAINNET.identity.hash, id('model supplier'), '1')]);
  }
  let decisionCounter = 0;
  let firstJob: Obj | undefined;
  const decision = (name: string, choice: unknown, at: number, agent = buyer): Obj => {
    const next = decisionCounter++;
    const report = (sub_job: Obj, acceptance = 'confirmed'): Obj => ({ name, choice, reasoning: 'Private model reasoning.',
      inference: { path: 'marketplace', accepted: acceptance, sub_job } });
    if (options.model === 'reused' && next === 1) return report(firstJob!);
    const late = options.model === 'pending' || options.model === 'late-confirmed';
    const variant = (late ? name === 'ranking' : next === 0) ? options.model : undefined;
    const actualRef = ref(`model ${next}`);
    const escrow_ref = variant === 'wrong-output' ? ref(`model ${next}`, 1) : actualRef;
    const service = variant === 'wrong-buyer' ? principal : services.get(agent.id)!;
    const modelSite = identityModel ? MAINNET.escrow : { address: ESCROW_ADDRESS, hash: ESCROW_SCRIPT_HASH };
    const promptHash = hash(`model prompt ${next}`);
    const receipt = { escrow_ref, model: variant === 'wrong-model' ? 'other-model' : modelTerms.model, supplier_pkh: model.keyHash,
      prompt_hash: promptHash, response_hash: hash(`model response ${next}`), prompt_tokens: 8, completion_tokens: 4, wallclock_ms: 1_000,
      ...(identityModel ? { agent_did: did('model supplier') } : {}) };
    const signature = model.signMessage(Buffer.from(canonicalize(receipt), 'utf8'));
    const receiptHash = accepted(receiptSha256(receipt, signature));
    const escrow = identityEscrow(ms(at), { supplier_pkh: model.keyHash, buyer_pkh: service.keyHash, agent_id: id('model supplier'),
      capability_id: modelTerms.capability_id, advert_ref: { txHash: modelAdvert.txHash, index: 0 }, request_spec_hash: requestSpecHash(modelTerms), prompt_hash: promptHash });
    const modelOutput = (tx_hash: string, datum: typeof escrow): Utxo => {
      const { agent_id: _id, refund: _refund, ...legacy } = datum;
      return identityModel ? escrowUtxo(tx_hash, datum, { address: modelSite.address })
        : { txHash: tx_hash, outputIndex: 0, address: modelSite.address, assets: { lovelace: 4_600_000n }, datum: encodeEscrowDatum(legacy) };
    };
    const opened = modelOutput(txOf(actualRef), escrow);
    const claimed = modelOutput(hash(`model claim ${next}`), { ...escrow, state: 'Claimed' });
    const submitted = modelOutput(hash(`model submit ${next}`), { ...escrow, state: 'Submitted', submitted_at: ms(at) + 1_000, result_receipt_hash: receiptHash });
    const end = hash(`model accept ${next}`);
    const fund = input(ref(`model input ${next}`), service.keyHash, keyAddress(service.keyHash));
    tx(opened.txHash, at, [fund], variant === 'missing-output' ? []
      : variant === 'wrong-output' ? [io(opened), { ...input(escrow_ref), inline_datum: io(opened).inline_datum }] : [io(opened)]);
    if (variant !== 'missing-output') {
      historical(opened, true);
      historical(claimed, true);
      historical(submitted, variant !== 'no-accept');
      tx(claimed.txHash, at, [io(opened)], [io(claimed)], [spend(modelSite.hash, io(opened), REDEEMER.Claim)]);
      tx(submitted.txHash, at, [io(claimed)], [io(submitted)], [spend(modelSite.hash, io(claimed), REDEEMER.Submit, [{ bytes: receiptHash }])], [], {
        reference_inputs: identityModel ? [io(modelRecord)] : [], invalid_before: String(block(at).abs_slot - 1), invalid_after: String(block(at).abs_slot + 1),
      });
      submittedByEscrow.set(actualRef, asRef(submitted));
      if (variant === 'no-accept') live.push(submitted);
      else {
        acceptedModels.set(actualRef, end);
        const delay = variant === 'wrong-spend' ? Math.ceil(ACCEPT_WINDOW_MS / MS) + 1 : variant === 'pending' || variant === 'late-confirmed' ? 5 : 1;
        tx(end, at + delay, [io(submitted)], [], [spend(modelSite.hash, io(submitted), variant === 'wrong-spend' ? REDEEMER.Release : REDEEMER.Accept)]);
      }
    }
    const subJob = { capability_id: modelTerms.capability_id, advert_ref: asRef(modelAdvert), escrow_ref, supplier_pkh: model.keyHash, receipt,
      receipt_signature: variant === 'bad-signature' ? '00'.repeat(64) : signature, verification: VERIFY };
    if (next === 0) firstJob = subJob;
    return report(subJob, variant === 'pending' ? 'pending' : 'confirmed');
  };
  const access = (actor: string[], delegationId: string, route: string, at: number, status: number, code: string | null = null): Obj => ({
    tenant, at: iso(at), route, act: actor, sub: `https://gateway.example/principals/key/${principal.keyHash}`, delegation: delegationId,
    credential: 'token', status, decision: status < 400 ? 'allowed' : 'refused', code, path: 'do not publish caller paths',
  });

  function installHire(hire: Hire): Quoted {
    const { step, agent, result } = hire;
    const post = hash(`post ${step}`);
    const escrow = `${post}#0`;
    const claim = hash(`claimed ${step}`);
    const submission = hash(`submitted ${step}`);
    const end = hire.end === null ? null : hash(`accept ${step}`);
    const maker = makers.get(agent.id)!;
    const resultText = JSON.stringify(result);
    const prompt = hire.request === undefined ? hash(`prompt ${step}`) : promptHashForPayload(hire.request);
    const advert = agent.adverts[0]!;
    const receipt = { escrow_ref: escrow, prompt_hash: prompt, response_hash: sha256(resultText), model: advert.model, supplier_pkh: maker.keyHash,
      prompt_tokens: 0, completion_tokens: 0, wallclock_ms: 5_000 };
    const signature = maker.signMessage(Buffer.from(canonicalize(receipt), 'utf8'));
    const receiptHash = accepted(receiptSha256(receipt, signature));
    reports.set(`${step}.report.json`, JSON.stringify({ verdict: 'VERIFIED', checks: Object.fromEntries(RECEIPT_CHECKS.map((name) => [name, 'pass'])), receipt,
      receipt_signature: signature, result: resultText }));
    if (hire.request !== undefined && options.absentExecute !== true) reports.set(`${step}.request.json`, hire.request);
    const record = { step, agent: agent.id, advert_ref: ref(`advert ${agent.id}`), escrow_ref: escrow, post_tx: post, accept_tx: end, reclaim_tx: null, report_file: `${step}.report.json` };
    entries.push(record);
    const paid = hire.paid && (options.vault !== 'wallet' || step !== 'quote-1');
    const d = identityEscrow(ms(hire.at), {
      agent_id: id(agent.id), supplier_pkh: maker.keyHash, capability_id: agent.capability, advert_ref: { txHash: txOf(record.advert_ref), index: 0 }, prompt_hash: prompt,
      payment_lovelace: advert.priceLovelace, buyer_bond_lovelace: advert.buyerBondLovelace, supplier_bond_lovelace: advert.supplierBondLovelace,
      ...(paid ? { buyer_pkh: parentKey.keyHash, refund: { address: plutusAddressFromBech32(MAINNET.vault.address), datum: encodeVaultDatum({ type: 'Returned', owner }) } } : {}),
    });
    const over = { address: MAINNET.escrow.address, assets: { lovelace: advert.priceLovelace + advert.buyerBondLovelace + advert.supplierBondLovelace } };
    const opened = escrowUtxo(post, d, over);
    const claimed = escrowUtxo(claim, { ...d, state: 'Claimed' }, over);
    const submitted = escrowUtxo(submission, { ...d, state: 'Submitted', submitted_at: ms(hire.submitted) + 1_000, result_receipt_hash: receiptHash }, over);
    historical(opened, true);
    historical(claimed, true);
    const stillLive = end === null && options.release === 'absent';
    historical(submitted, !stillLive);
    if (stillLive) live.push(submitted);
    submittedByEscrow.set(escrow, asRef(submitted));
    if (paid) {
      const foreign = options.vault === 'other' && step === 'quote-1';
      const before = vaultOutputs.get(foreign ? ref('foreign vault') : vaultHead)!;
      const held = decodeVaultDatum(before.datum!);
      if (held.type !== 'Live') throw new Error('fixture payment needs a Live vault');
      const beforeIo = io(before);
      const call: TxIo = { ...beforeIo, inline_datum: { bytes: before.datum ?? null, value: { constructor: 0,
        fields: [{ constructor: 0, fields: [{ bytes: principal.keyHash }, { constructor: 1, fields: [] }] }, { bytes: DELEGATION },
          { int: Number(held.spent) }, { int: held.periodStart }],
      } } };
      const amount = opened.assets.lovelace;
      const reset = ms(hire.at) - 1_000 >= held.periodStart + baseDelegation.value!.periodMs;
      const next = vaultUtxo({ ...held, spent: reset ? amount : held.spent + amount, periodStart: reset ? ms(hire.at) + 1_000 : held.periodStart },
        before.assets.lovelace - amount, { txHash: post, outputIndex: 1 });
      tx(post, hire.at, [call], [io(opened), io(next)], [spend(MAINNET.vault.hash, call, 0)], [], {
        reference_inputs: [io(delegationOutput), io(initial.get(buyer.id)!)],
        invalid_before: String(block(hire.at).abs_slot - 1), invalid_after: String(block(hire.at).abs_slot + 1),
      });
      historical(next, !foreign);
      vaultOutputs.set(asRef(next), next);
      if (foreign) live.push(next);
      else vaultHead = asRef(next);
    } else tx(post, hire.at, [input(ref(`wallet ${step}`))], [io(opened)]);
    tx(claim, hire.at + 1, [io(opened)], [io(claimed)], [spend(MAINNET.escrow.hash, io(opened), 0)]);
    tx(submission, hire.submitted, [io(claimed)], [io(submitted)], [spend(MAINNET.escrow.hash, io(claimed), 1, [{ bytes: receiptHash }])], [], {
      reference_inputs: [io(initial.get(agent.id)!)],
      invalid_before: String(block(hire.submitted).abs_slot - 1), invalid_after: String(block(hire.submitted).abs_slot + 1),
    });
    if (end !== null) tx(end, hire.end!, [io(submitted)], [], [spend(MAINNET.escrow.hash, io(submitted), 2)]);
    if (end === null && options.release !== 'absent') {
      tx(releaseTx, hire.submitted + (options.release === 'early' ? 1 : Math.ceil(ACCEPT_WINDOW_MS / MS) + 1), [io(submitted)], [], [spend(MAINNET.escrow.hash,
        io(submitted), options.release === 'not-release' ? 2 : 4)]);
    }
    return { result, receipt, signature };
  }

  const baseDelegation = delegation({ delegator: owner, delegate: id(options.wrongAuthority ? target.id : buyer.id), delegateKey: parentKey.keyHash, depth: 1,
    notBefore: ms(1), notAfter: ms(331), value: { perTx: 5_000_000n, total: vaultFunds, periodMs: DAY },
    actions: ['marketplace.hire.v1', 'vendor.read', 'sourcing.award.write'].map(utf8Hex) });
  const delegationOutput = delegationUtxo(DELEGATION, baseDelegation, { txHash: hash('delegate') });
  historical(delegationOutput, true);
  tx(hash('delegate'), 1, [input(ref('delegate seed'))], [io(delegationOutput)], [mint(MAINNET.delegation.hash)], [movement(MAINNET.delegation.hash, DELEGATION, '1')]);
  tx(hash('undelegate'), 330, [io(delegationOutput)], [], [mint(MAINNET.delegation.hash)], [movement(MAINNET.delegation.hash, DELEGATION, '-1')]);
  const root = vaultUtxo({ type: 'Live', owner, delegation: DELEGATION, spent: 0n, periodStart: 0 }, vaultFunds, { txHash: txOf(ROOT_VAULT), outputIndex: 0 });
  vaultOutputs.set(ROOT_VAULT, root);
  historical(root, true);
  tx(txOf(ROOT_VAULT), 2, [input(ref('vault seed'))], [io(root)]);
  if (options.vault === 'other') {
    const other = { ...root, txHash: hash('foreign vault') };
    historical(other, true);
    vaultOutputs.set(asRef(other), other);
    tx(other.txHash, 3, [input(ref('foreign vault seed'))], [io(other)]);
  } else if (options.vault === 'close-replacement') {
    const replacement = { ...root, txHash: hash('replacement vault') };
    historical(replacement, true);
    vaultOutputs.set(asRef(replacement), replacement);
    const refund = { ...input(`${replacement.txHash}#1`), value: String(vaultFunds) };
    const funding = { ...input(ref('replacement funding')), value: String(vaultFunds + 200_000n) };
    tx(replacement.txHash, 3, [io(root), funding], [io(replacement), refund], [spend(MAINNET.vault.hash, io(root), 1)]);
    vaultHead = asRef(replacement);
  }
  const holdAt = 160;
  const holdApplied = holdAt + 1;
  const holdPost = options.holdProposal === 'outside-hold' ? 150 : options.holdProposal === 'before-apply' ? holdAt
    : options.holdProposal === 'at-apply' ? holdApplied : 180;
  const proposalWindow = 35;
  const holdSubmit = holdPost + proposalWindow - 1;
  const holdSpend = options.holdSpend === undefined ? 295 : ({
    'after-submit': holdSubmit + 1, 'before-post': holdPost - 1, 'during-proposal': holdSubmit - 1, 'at-submit': holdSubmit,
  })[options.holdSpend];
  const invalidFrom = options.revocation === 'late-invalid-from' ? 250 : 20;
  const juryHold = { by: { type: 'Script' as const, hash: M1 }, reason: 64, since: ms(holdAt), until: ms(holdAt) + 7 * DAY };
  const oldHold: Status = { type: 'Suspended', holds: [juryHold] };
  const revoked: Status = { type: 'Revoked', by: { type: 'KeyHash', hash: actualAccountable.keyHash }, reason: 9, at: ms(holdSpend - 1), invalidFrom: ms(invalidFrom), successor: null };
  for (const agent of data.agents) {
    const maker = makers.get(agent.id)!;
    const record = liveRecord({ controller: controller.publicKeyHex,
      parties: [{ role: 'Accountable', signer: { type: 'KeyHash', hash: agent === target ? actualAccountable.keyHash : key(agent.organisation).keyHash },
        organisation: utf8Hex(domainOf(agent)), notBefore: ms(0) - DAY,
        notAfter: null, rights: options.revocation === 'wrong-author' && agent === target ? 1 : 3, removalAfter: null }], createdAt: ms(0) - DAY },
    agent === buyer ? [maker.publicKeyHex, parentKey.publicKeyHex] : [maker.publicKeyHex]);
    histories.set(agent.id, record);
    const utxo = { ...recordUtxo(id(agent.id), record), txHash: hash(`registered ${agent.id}`) };
    initial.set(agent.id, utxo);
    const gone = failure && agent === target && options.case !== 'waiting' && options.case !== 'claimed';
    historical(utxo, gone);
    if (!gone) live.push(utxo);
    tx(utxo.txHash, 0, [input(ref(`register ${agent.id}`))], [io(utxo)], [mint(MAINNET.identity.hash)], [movement(MAINNET.identity.hash, id(agent.id), '1')]);
    const { uri, body } = manifests.get(agent.id)!;
    const publicAdvert = advertUtxo({ ...IDENTITY_ADVERT, supplier_pkh: maker.keyHash, capability_id: agent.capability, model: agent.adverts[0]!.model,
      agent_id: id(agent.id), endpoint_url: agent.endpoint, detail_uri: uri, detail_hash: sha256(body) }, { txHash: hash(`advert ${agent.id}`), address: MAINNET.advert.address });
    historical(publicAdvert, false);
    tx(publicAdvert.txHash, 0, [input(ref(`advert seed ${agent.id}`))], [io(publicAdvert)]);
  }
  for (const [i, scorer] of data.subagents.entries()) {
    const { auth, delegate } = scorerKeys.get(scorer.id)!;
    const parent = options.scorer === 'wrong-parent-record' && i === 0 ? target : buyer;
    const record = { ...recordUtxo(id(scorer.id), liveRecord({ lineage: { type: 'Subagent', parent: id(parent.id), parentEpoch: 0, depth: 1 },
      keys: [{ keyType: 'Ed25519', key: auth.publicKeyHex, purposes: PURPOSE.authentication, pop: null },
        { keyType: 'Ed25519', key: delegate.publicKeyHex, purposes: PURPOSE.delegation, pop: null }],
    })), txHash: hash(`record ${scorer.id}`) };
    historical(record, false);
    initial.set(scorer.id, record);
    live.push(record);
    tx(record.txHash, 0, [input(ref(`record seed ${scorer.id}`))], [io(record)], [mint(MAINNET.identity.hash)],
      [movement(MAINNET.identity.hash, id(scorer.id), '1')], { reference_inputs: [io(initial.get(parent.id)!)] });
  }
  const w = await taskWorld({ keys: [], shared: [], use: data, env: {
    OPERATOR_USE_CASE: 'inventory-reorder', VECTOR_KOIOS_URL: KOIOS, VECTOR_MCP_URL: HOSTED, VECTOR_MARKETPLACE_INDEXER_URL: INDEXER,
    OPERATOR_MODULE1_COMMIT: 'a5'.repeat(20),
  } });
  const mockEnv = join(w.dir, 'mock.env');
  writeFileSync(mockEnv, `MOCK_OPERATOR_TOKEN=${MOCK_TOKEN}\n`, { mode: 0o600 });
  w.env.OPERATOR_MOCK_ENV_FILE = mockEnv;
  const accountableName = data.organisations.find(({ id }) => id === target.organisation)!.accountableKey;
  const publicKeys = new Map([[accountableName, accountable], ...data.subagents.flatMap(({ id: name }) => {
    const { auth, delegate } = scorerKeys.get(name)!;
    return [[`${name}-auth`, auth], [`${name}-delegation`, delegate]] as const;
  })]);
  const keys = Object.fromEntries(data.keys.flatMap(({ name, scope, about }) => {
    const found = publicKeys.get(name);
    return found ? [[name, { scope, about, public_key_hex: found.publicKeyHex, key_hash: found.keyHash, address: found.address }]] : [];
  }));
  writeFileSync(join(w.keys.root, publicManifestFile(data.name)), JSON.stringify({ network: 'vector-mainnet', use_case: data.name, keys }), { mode: 0o600 });
  const store = FactsFile.open(join(w.stateDir, 'facts.json'), { useCase: data.name, network: 'vector-mainnet' });
  for (const [agent, utxo] of initial) {
    const duplicate = options.scorer === 'same-did' && agent === data.subagents[1]!.id ? data.subagents[0]!.id : agent;
    store.put('records', [agent], rosterFact(duplicate, initial.get(duplicate) ?? utxo));
  }
  for (const agent of data.agents) {
    const model = agent.adverts[0]!.model;
    const { uri, body } = manifests.get(agent.id)!;
    store.put('adverts', [agent.id, model], { ref: ref(`advert ${agent.id}`), tx: hash(`advert ${agent.id}`), detailUri: uri,
      detailHash: sha256(body), endpoint: agent.endpoint, postedAt: iso(0) });
    store.put('claims', [label, agent.id], { claimRef: ref(`claim ${agent.id}`), claimTx: hash(`claim ${agent.id}`), claimToken: claimToken(agent.id),
      documentTx: hash(`claim document ${agent.id}`), stakeLovelace: String(CLAIM_STAKE_LOVELACE), windowMs: CLAIM_WINDOW_MS,
      stakedAt: iso(3), withdrawableFrom: new Date(ms(3) + CLAIM_WINDOW_MS).toISOString(), withdrawTx: null });
    settled.add(hash(`claim ${agent.id}`));
    settled.add(hash(`claim document ${agent.id}`));
  }
  store.put('tenants', [label], { name: tenant, createdAt: iso(0), seedKind: 'custom' });

  const complianceId = hash('compliance');
  const reply = hash('reply digest');
  const loc = 'https://documents.example/issued.json';
  const replyUri = 'https://documents.example/reply.json';
  const att = attestation({ subject: id(target.id), issuer: issuer.publicKeyHex, attType: 0, format: data.compliance!.format,
    issuedAt: ms(4), validUntil: ms(4) + 365 * DAY, digest: hash('compliance statement'), locator: utf8Hex(loc) });
  const revokeAt = options.compliance === 'after-hold' ? 161 : 58;
  const contestAt = options.compliance === 'after-hold' ? 162 : 62;
  const attRev = { ...att, status: { type: 'AttRevoked' as const, reason: 9, at: ms(revokeAt) } };
  if (failure) {
    const issued = attestationUtxo(complianceId, att, { txHash: hash('compliance issue') });
    const voided = attestationUtxo(complianceId, attRev, { txHash: hash('compliance revoke') });
    const contested = attestationUtxo(complianceId, { ...attRev, contested: { uri: utf8Hex(replyUri), sha256: reply } }, { txHash: hash('compliance contest') });
    historical(issued, true);
    historical(voided, true);
    historical(contested, false);
    live.push(contested);
    tx(issued.txHash, 4, [input(ref('compliance issue seed'))], [io(issued)], [], [movement(MAINNET.attestation.hash, complianceId, '1')]);
    tx(voided.txHash, revokeAt, [io(issued)], [io(voided)], [spend(MAINNET.attestation.hash, io(issued), 0, [{ int: 9 }])]);
    tx(contested.txHash, contestAt, [io(voided)], [io(contested)], [spend(MAINNET.attestation.hash, io(voided), options.compliance === 'wrong-contest' ? 2 : 1)]);
    store.put('compliance', [target.id], { id: complianceId, tx: issued.txHash, digest: att.digest, locator: loc, issuedAt: iso(4), validUntil: new Date(att.validUntil!).toISOString(),
      revokeTx: voided.txHash, contestTx: contested.txHash, replySha256: reply, replyUri });
  }

  const phases: Array<{ ranking: Obj; proposal: Obj }> = [];
  let faulty: Quoted | null = null;
  const weights = { price: 0.25, lead_time: 0.25, reliability: 0.25, compliance: 0.25 };
  for (const [index, step] of PROPOSE_STAGES[kind].entries()) {
    const start = failure ? [10, 70, holdPost, 230][index]! : 10;
    const end = start + proposalWindow;
    const rfq = `RFQ-${index + 1}`;
    const rfqHash = hash(`request ${index}`);
    rfqs.push(rfq);
    const addRank = options.relationship === 'extra-rank' && (!failure || step === 'propose-d');
    const candidates = failure && index >= 2 ? des.filter((agent) => agent !== target) : des;
    const selected = addRank && !failure ? candidates.slice(0, -1) : candidates;
    const omitted = addRank || (step === 'propose-c' && options.holdProposal === 'with-target') ? [target] : [];
    const bidders = [...selected, ...omitted].map((agent) => ({ did: did(agent.id), advert_ref: ref(`advert ${agent.id}`), status: 'active',
      in_catalog: options.missingCatalog && agent === des[0] ? null : true,
      compliance: failure && index === 1 && agent === target ? { state: 'invalid', attestation_state: 'revoked', attestation: complianceId,
        revoke_reason: '9', contested: { sha256: options.compliance === 'wrong-hash' ? hash('different reply') : reply } } : { state: 'valid' } }));
    const choices = [decision('shortlist', { invite: selected.map((desk) => did(desk.id)),
      not_invited: omitted.map(({ id: desk }) => ({ did: did(desk), reason: 'The shortlist omits this bidder.' })) }, start + 1)];
    const quoted: Obj[] = [];
    const subJobs: Obj[] = [];
    const ranked: Array<{ rank: number; desk_did: string; organisation: string; score: number; components: Components; quote: Obj }> = [];
    const excluded: Obj[] = [];
    for (const [n, desk] of selected.entries()) {
      const quoteStep = `quote${step.slice('propose'.length) || '-'}${n + 1}`;
      const post = start + 2 + n * 5;
      const bad = failure && index === 0 && desk === target;
      const unit = bad ? 130 : 120;
      const total = unit * 10;
      const quote = { schema: QUOTE_SCHEMA, outcome: 'done', rfq_id: rfq, rfq_sha256: rfqHash, desk_did: did(desk.id), organisation: domainOf(desk),
        lines: [{ sku: 'GLV-NIT-M', quantity: 10, unit_price: unit, line_total: total, lead_time_days: 2 }], total, lead_time_days: 2, valid_until: '2026-12-20',
        notes: 'Private quote notes.', price_list_sha256: hash(`price list ${desk.id}`), credential: 'sample.sample.sample',
        sender: { did: did(buyer.id), organisation: domainOf(buyer), organisation_verified: true }, checks: Object.fromEntries(QUOTE_CHECKS.map((x) => [x, true])),
        decisions: [decision('quote', { lines: [], notes: 'Private quote choice.' }, post + 1, desk)], fault_mode: bad ? 'quote_off_price_list' : '' };
      const q = installHire({ step: quoteStep, agent: desk, result: quote, at: post, submitted: post + 2, end: bad ? null : post + 3, paid: true });
      const escrow = ref(`post ${quoteStep}`);
      const advertised = ref(`advert ${desk.id}`);
      const receiptHash = accepted(receiptSha256(q.receipt, q.signature));
      choices.push(decision('accept_quote', { accept: !bad, mismatch: bad ? ['GLV-NIT-M'] : [] }, post + 2));
      quoted.push({ desk_did: options.wrongDesk && quoteStep === 'quote-1' ? did(target.id) : did(desk.id), advert_ref: advertised, escrow_ref: escrow,
        paid_from_vault: true, receipt: q.receipt, receipt_signature: q.signature, verification: VERIFY, result: q.result,
        accepted: bad ? 'no' : 'confirmed', challenge: bad ? CHALLENGE : null });
      if (bad) {
        faulty = q;
        excluded.push({ desk_did: did(desk.id), reason: 'disputed', code: null });
      } else {
        const score = step === 'propose-d' && n === 0 ? 80.2 : 90 - n * 5;
        const components = step === 'propose-d' && n === 0 ? { price: 81.2, lead_time: 79.3, reliability: 54.6, compliance: 92.1 }
          : { price: score, lead_time: score, reliability: score, compliance: score };
        ranked.push({ rank: ranked.length + 1, desk_did: did(desk.id), organisation: domainOf(desk), score, components,
          quote: { escrow_ref: escrow, receipt_sha256: receiptHash, total, lead_time_days: 2 } });
        subJobs.push({ capability_id: desk.capability, advert_ref: advertised, escrow_ref: escrow, supplier_pkh: q.receipt.supplier_pkh,
          receipt: q.receipt, receipt_signature: q.signature, verification: VERIFY });
      }
    }
    for (const [i, rankedBid] of ranked.entries()) {
      const scorer = data.subagents[i]!;
      const child = hash(`child of ${step} ${i}`);
      const delegated = hash(`delegate ${step} ${i}`);
      const ended = hash(`undelegate ${step} ${i}`);
      const childOutput = delegationUtxo(child, delegation({
        depth: 2, parent: options.scorer === 'wrong-parent' && i === 0 ? hash('foreign root') : DELEGATION, delegate: id(scorer.id), delegator: { type: 'Agent', id: id(buyer.id) },
        delegateKey: options.scorer === 'wrong-delegate-key' && i === 0 ? parentKey.keyHash : scorerKeys.get(scorer.id)!.delegate.keyHash,
        actions: [utf8Hex('vendor.read')], notBefore: ms(start + 20), notAfter: ms(start + 30), remaining: 0,
      }), { txHash: delegated });
      historical(childOutput, true);
      tx(delegated, start + 20, [input(ref(`child seed ${step} ${i}`))], [io(childOutput)], [mint(MAINNET.delegation.hash)], [movement(MAINNET.delegation.hash, child, '1')],
        { reference_inputs: [io(delegationOutput), io(initial.get(buyer.id)!), io(initial.get(scorer.id)!)] });
      tx(ended, start + 28, [io(childOutput)], [], [mint(MAINNET.delegation.hash)], [movement(MAINNET.delegation.hash, child, '-1')]);
      subDelegations.push({ id: child, delegate_tx: delegated, undelegate_tx: ended, subagent: scorer.id, hire: step });
      log.push(access(options.scorer === 'wrong-actor' && i === 0 ? [did(buyer.id)] : [did(scorer.id), did(buyer.id)], child, 'GET /vendors', start + 21, 200));
      choices.push(decision('score', { components: rankedBid.components, score: rankedBid.score }, start + 23));
      if (failure && index === 3 && i === 0) {
        // Keep the expected reversal independent of the production arithmetic.
        rankedBid.score = options.reverse === 'wrong-score' ? 19.9 : 19.8;
        rankedBid.components = { price: options.reverse === 'wrong-price' ? 18.9 : 18.8, lead_time: options.reverse === 'wrong-lead-time' ? 20.8 : 20.7,
          reliability: options.reverse === 'wrong-reliability' ? 45.5 : 45.4, compliance: options.reverse === 'wrong-compliance' ? 8 : 7.9 };
      }
    }
    if (addRank) {
      const escrow = ref(`unmatched quote in ${step}`);
      const score = 80;
      ranked.push({ rank: 0, desk_did: did(target.id), organisation: domainOf(target), score, components: { price: score, lead_time: score, reliability: score, compliance: score },
        quote: { escrow_ref: escrow, receipt_sha256: hash('unmatched receipt'), total: 1200, lead_time_days: 2 } });
      subJobs.push({ ...subJobs[0], escrow_ref: escrow });
    } else for (const desk of omitted) excluded.push({ desk_did: did(desk.id), reason: 'not_invited', code: null });
    if (options.relationship === 'wrong-subjob' && (!failure || step === 'propose-d')) subJobs[0]!.escrow_ref = subJobs[1]!.escrow_ref;
    ranked.sort((a, b) => b.score - a.score);
    ranked.forEach((row, i) => { row.rank = i + 1; });
    choices.push(decision('ranking', { order: ranked.map((r) => r.desk_did), tie_break: '' }, start + 31));
    const ranking = { schema: RANKING_SCHEMA, rfq_id: rfq, rfq_sha256: rfqHash, tenant, weights, ranked, excluded };
    const proposal = accepted(makeProposal(ranking, hash(`salt ${index}`)));
    phases.push({ ranking, proposal: { ...proposal } });
    installHire({ step, agent: buyer, at: start, submitted: end - 1, end, paid: false, result: {
      schema: PROPOSAL_SCHEMA, use_case: data.name, decisions: choices, sub_jobs: subJobs, ...proposal, outcome: 'proposed', exit_state: null, reason: null, bidders, quotes: quoted,
      ...(options.wrongProposal ? { proposal_digest: hash('unrelated proposal') } : {}),
      fault_mode: failure && index === 3 ? 'invert_scores' : '',
    } });
  }
  const final = phases.at(-1)!;
  const approvalId = hash('approval');
  const approval = { attestation: approvalId, issuer_did: DECLARED_ISSUER };
  const approvalTx = hash('approval issuance');
  const validUntil = ms(46) + RUN_APPROVAL_VALIDITY_MS;
  if (!failure) {
    const hirer = { ...recordUtxo(id('hirer'), liveRecord({ controller: principal.publicKeyHex })), txHash: hash('hirer registration') };
    historical(hirer, false);
    live.push(hirer);
    tx(hirer.txHash, 0, [], [io(hirer)]);
    live.push(attestationUtxo(approvalId, attestation({ subject: id(buyer.id), issuer: principal.publicKeyHex, issuerId: id('hirer'), attType: 5,
      digest: String(final.proposal.proposal_digest), issuedAt: ms(46), validUntil }), { txHash: approvalTx }));
    tx(approvalTx, 46);
  }
  const execute = failure ? 'execute-d' : 'execute';
  const execAt = failure ? 269 : 50;
  const first = (final.ranking.ranked as Obj[])[0]!;
  const rankId = `RK-${tenant}-0001`;
  const authority = { principal_did: DECLARED_ISSUER, delegation: DELEGATION };
  const wrongProposal = accepted(makeProposal({ ...final.ranking, rfq_id: 'RFQ-OTHER' }, hash('wrong salt')));
  const request = JSON.stringify({ op: 'execute', tenant, authority, proposal: options.wrongRequestDigest ? wrongProposal : final.proposal,
    approval: options.wrongApproval ? { ...approval, attestation: hash('wrong approval') } : failure ? null : approval });
  const writer = access([did(buyer.id)], DELEGATION, RANKING_ROUTE, execAt + 1, failure ? 403 : 201, failure ? 'approval_not_found' : null);
  log.push(writer);
  const matching = accepted(makeProposal(final.ranking, String(final.proposal.salt))).proposal_digest;
  const privateWriter = {
    ...writer,
    at: options.correlation === 'after-submit' ? new Date(ms(execAt + 2) + 500).toISOString() : options.correlation === 'before-post' ? iso(execAt - 1) : writer.at,
    rule: failure ? 'approval.missing' : null,
    ...(options.correlation === 'missing-digest' ? {} : { proposal_digest: options.correlation === 'wrong-digest' ? hash('other route digest') : matching }),
  };
  if (!failure || options.failureWrite) rankingRows.push({ ranking_id: rankId, rfq_id: final.ranking.rfq_id,
    top: { rank: 1, desk_did: options.wrongRanking ? did(target.id) : first.desk_did, organisation: first.organisation }, ranking: final.ranking, approval,
    recorded_at: iso(execAt + 1), by: { kind: 'token', sub: writer.sub, act: writer.act, delegation: DELEGATION } });
  installHire({ step: execute, agent: buyer, at: execAt, submitted: execAt + 2, end: execAt + 3, paid: false, request, result: {
    schema: RESULT_SCHEMA, use_case: data.name, proposal_digest: final.proposal.proposal_digest, handoff: null,
    writes: failure ? [] : [{ route: RANKING_ROUTE, system: 'sourcing-record', status: 201, ref: rankId }], decisions: [], fault_mode: '',
    outcome: failure ? 'refused_by_system' : 'completed', reason: failure ? 'approval_not_found' : null, challenge: null, exit_state: failure ? 'Rejected' : 'Completed',
  } });
  // The run record lists propose jobs in their RFQ order. It need not be ordered by every nested post.
  entries.sort((a, b) => Number(String(a.step).startsWith('quote')) - Number(String(b.step).startsWith('quote')));
  const close = options.noClose ? null : hash('close vault');
  if (close !== null) {
    const closing = io(vaultOutputs.get(vaultHead)!);
    const refund = { ...input(`${close}#0`), value: closing.value };
    tx(close, 329, [closing, input(ref('close fee'))], [refund], [spend(MAINNET.vault.hash, closing, 1)]);
  } else {
    const current = vaultOutputs.get(vaultHead)!;
    live.push(current);
    const row = outputs.find((held) => `${held.tx_hash}#${held.tx_index}` === vaultHead)!;
    row.is_spent = false;
  }

  let indexed: Obj | null = null;
  if (failure) {
    const held = histories.get(target.id)!;
    const before = initial.get(target.id)!;
    const document = accepted(claimDocument({ agent_did: did(target.id), capability_id: target.capability, manifest_sha256: hash('desk manifest'), claim: BID_DESK_CLAIM }));
    const claimTx = txOf(CHALLENGE.claim);
    const docTx = hash(`claim document ${target.id}`);
    const challengeTx = txOf(CHALLENGE.challenge);
    const quote = faulty!;
    const quoteEscrow = String(quote.receipt.escrow_ref);
    const evidence = accepted(evidenceDocument({ kind: 'quote_price', claim: CHALLENGE.claim, claim_token: claimToken(target.id), against_did: did(target.id), by_did: did(buyer.id),
      escrow_ref: quoteEscrow, statement_text: BID_DESK_CLAIM.statements[0].text, sku: 'GLV-NIT-M', quantity: 10, quoted_unit_price: 130, listed_unit_price: 120,
      price_list_sha256: String(quote.result.price_list_sha256), quote_sha256: options.wrongEvidenceQuote ? hash('other quote') : String(quote.receipt.response_hash) }));
    metadata.set(docTx, documentMetadata(document.bytes, 'claim'));
    metadata.set(CHALLENGE.evidence, documentMetadata(evidence.bytes, 'evidence'));
    tx(docTx, 2, [input(ref('claim document input'))]);
    tx(CHALLENGE.evidence, 25, [input(ref('quote evidence input'))]);
    const openDatum = encodeClaimDatum({ claimerDid: id(target.id), claimerCredential: { type: 'VerificationKey', hash: makers.get(target.id)!.keyHash },
      claimHash: document.hash, claimType: utf8Hex(target.capability), storageUri: utf8Hex(documentUri(docTx)), stakeAmount: CLAIM_STAKE_LOVELACE,
      submittedAt: ms(3), challengeWindow: CLAIM_WINDOW_MS, state: 'Open' });
    const openClaim: Utxo = { txHash: claimTx, outputIndex: 0, address: MODULE1.claim.address, assets: { lovelace: CLAIM_STAKE_LOVELACE,
      [`${MODULE1.claim.hash}${claimToken(target.id)}`]: 1n }, datum: openDatum };
    const challengeDatum = encodeChallengeDatum({ claimRef: { txHash: claimTx, outputIndex: 0 }, auditorDid: id(buyer.id),
      auditorCredential: { type: 'VerificationKey', hash: makers.get(buyer.id)!.keyHash }, stakeAmount: CLAIM_STAKE_LOVELACE,
      evidenceHash: evidence.hash, evidenceUri: utf8Hex(documentUri(CHALLENGE.evidence)), challengedAt: ms(26), resolutionDeadline: 3 * DAY,
      eligibleJurors: [], state: { type: 'PendingOracle' }, claimToken: claimToken(target.id) });
    const dispute: Utxo = { txHash: challengeTx, outputIndex: 0, address: MODULE1.challenge.address, assets: { lovelace: CLAIM_STAKE_LOVELACE,
      [`${MODULE1.challenge.hash}${CHALLENGE_TOKEN}`]: 1n }, datum: challengeDatum };
    historical(openClaim, true);
    historical(dispute, options.case !== 'waiting');
    tx(claimTx, 3, [input(ref('claim wallet'))], [io(openClaim)], [], [movement(MODULE1.claim.hash, claimToken(target.id), '1')]);
    tx(challengeTx, 27, [io(openClaim)], [io(dispute)], [spend(MODULE1.claim.hash, io(openClaim), 2)], [movement(MODULE1.challenge.hash, CHALLENGE_TOKEN, '1')]);
    const opened = hash('jury opening');
    const finalized = hash('jury finalize');
    const resolution = hash('oracle resolution');
    const verdictRef = `${resolution}#1`;
    const apply = hash('hold application');
    const previous = { ...recordUtxo(id(target.id), { ...held, status: oldHold }), txHash: apply };
    const verdict = options.case === 'claimed' ? 'ClaimerWins' : 'AuditorWins';
    const ready = options.case !== 'waiting';
    const refundTo = plutusAddressFromBech32(wallet);
    const juryDatum = encodeJuryDatum({ type: 'Case', case: {
      challenge: CHALLENGE_TOKEN, claim: claimToken(target.id), challengeOut: { txHash: challengeTx, outputIndex: 0 }, claimOut: { txHash: challengeTx, outputIndex: 1 },
      claimer: id(target.id), auditor: id(buyer.id), claimHash: document.hash, evidenceHash: evidence.hash, openedAt: ms(31), deadline: ms(30) + DAY,
      commitEnd: ms(50), revealEnd: ms(70), refundTo, fee: 0n, ballots: [], state: { type: 'Open' }, tally: { claimer: 0, auditor: 3, inconclusive: 0 },
    } });
    const juryOutput: Utxo = { txHash: opened, outputIndex: 0, address: scriptAddress(JURY), assets: { lovelace: 5_000_000n, [`${JURY}${CASE}`]: 1n }, datum: juryDatum };
    tx(opened, 31, [input(ref('case seed'))], [io(juryOutput)], [], [movement(JURY, CASE, '1')]);
    historical(juryOutput, ready);
    indexed = { challenge: CHALLENGE_TOKEN, claim: claimToken(target.id), challenge_out: CHALLENGE.challenge, state: ready ? 'closed' : 'open', window: 'reveal',
      script_hash: JURY, canonical: true, case: CASE, opened: { tx: opened }, finalized: ready ? { tx: finalized, result: verdict } : null, closed: null,
      tally: { ClaimerWins: 0, AuditorWins: 3, Inconclusive: 0 }, revealed: 3, result: ready ? verdict : null };
    const forAuditor = { constructor: 1, fields: [] };
    if (ready) tx(finalized, 150, [io(juryOutput)], [], [spend(JURY, io(juryOutput), 1, [{ constructor: 2, fields: [forAuditor] }])]);
    if (ready && verdict === 'AuditorWins') {
      const resolutionDoc = Buffer.from(JSON.stringify({ type: 'vector-jury-resolution/1', basis: 'jury', verdict,
        challenge_out: CHALLENGE.challenge, challenge: CHALLENGE_TOKEN, claim: claimToken(target.id),
        jury: { deployment: JURY, case: options.case === 'wrong-resolution' ? hash('other case') : CASE, opened_in: opened, finalized_in: finalized },
      }));
      metadata.set(resolution, documentMetadata(resolutionDoc, 'resolution'));
      const token = hash('verdict');
      const verdictOut: Utxo = { txHash: resolution, outputIndex: 1, address: scriptAddress(M1), assets: { lovelace: 5_000_000n, [`${M1}${token}`]: 1n },
        datum: encodePlutusDataHex(vote(0, bytes(id(target.id)), vote(0), int(7 * DAY), vote(0, bytes(challengeTx), int(0)), addressData(refundTo), int(ms(holdAt) + 7 * DAY))) };
      historical(verdictOut, true);
      tx(resolution, 157, [io(dispute)], [io(verdictOut)], [spend(MODULE1.challenge.hash, io(dispute), 2, [forAuditor, { bytes: documentHash(resolutionDoc) }])], [movement(M1, token, '1')]);
      live.push({ txHash: hash('config seal'), outputIndex: 0, address: MAINNET.configHolder.address,
        assets: { lovelace: 5_000_000n, [`${MAINNET.configSeal.hash}${CONFIG_TOKEN_NAME}`]: 1n }, datum: encodePlutusDataHex(bytes(M1)) });
      historical(previous, options.revocation !== 'no-tombstone');
      tx(apply, holdApplied, [io(before), io(verdictOut)], [io(previous)], [spend(MAINNET.identity.hash, io(before), 2, [{ constructor: 1, fields: [{ int: 0 }] }])], [movement(M1, token, '-1')]);
      if (options.revocation === 'no-tombstone') live.push(previous);
      else {
        const ended = { ...recordUtxo(id(target.id), tombstone(held, revoked)), txHash: hash('revoked record') };
        historical(ended, false);
        live.push(ended);
        tx(ended.txHash, holdSpend, [io(previous)], [io(ended)], [spend(MAINNET.identity.hash, io(previous), 4, [{ constructor: 1, fields: [{ int: 0 }] }])]);
        store.put('revocations', [target.id], { tx: ended.txHash, reason: 9, invalidFrom: iso(invalidFrom), revokedAt: iso(holdSpend - 1) });
      }
      if (verdictRef !== asRef(verdictOut)) throw new Error('fixture verdict reference mismatch');
    }
  }

  const dir = join(w.stateDir, 'runs', label);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const [file, body] of reports) writeFileSync(join(dir, file), body, { mode: 0o600 });
  writeFileSync(join(dir, '..', `${label}.json`), JSON.stringify({ format: 1, label, use_case: data.name, kind, date: '2026-12-01', tenant,
    delegations: [{ id: DELEGATION, tx: hash('delegate'), ended_tx: hash('undelegate') }],
    vaults: [{ ref: close === null ? vaultHead : ROOT_VAULT, open_tx: txOf(ROOT_VAULT), close_tx: close }],
    approvals: failure ? [] : [{ role: 'approval', attestation: approvalId, tx: approvalTx, valid_until: validUntil, revoked_tx: null, supersedes: null }],
    challenged: failure ? target.id : null, rfq_ids: options.reorderedIds ? [...rfqs].reverse() : rfqs, sub_delegations: subDelegations, hires: entries,
    refusals: [],
  }), { mode: 0o600 });
  const faultEntry = (at: number, mode: string, agent: AgentSpec | null): Obj => ({ step: 'fault_check', at: iso(at), shows: { check: mode, agent: agent?.id ?? null, ok: true,
    services: data.agents.map(({ id, serviceContainer }) => ({ service: serviceContainer, started_at: iso(0), value: id === agent?.id ? mode : '' })) } });
  const faults = [faultEntry(3, 'clean', null), ...(failure ? [faultEntry(11, 'quote_off_price_list', target),
    ...(options.fault === 'off' ? [] : [faultEntry(options.fault === 'different' ? 231 : 229, 'invert_scores', buyer)])] : []), faultEntry(340, 'clean', null)];
  writeFileSync(join(w.stateDir, `fault.${label}.evidence.json`), JSON.stringify({ check: 'fault', entries: faults }), { mode: 0o600 });
  const headBlock = block(341);
  blocks.set(headBlock.hash, headBlock);
  const ledger = ledgerWorld(live, { txs, utxoInfo: outputs.map((row) => {
    const held = blocksOf.get(row.tx_hash);
    return held ? { ...row, block_height: held.block_height, block_time: held.block_time } : row;
  }) });
  const provider = Object.assign(ledger.provider, { getNetworkTip: async () => ({ hash: headBlock.hash, slot: headBlock.abs_slot }) });
  const web = (async (uri: string, init?: RequestInit) => {
    const url = new URL(uri);
    if (url.origin === KOIOS && url.pathname.endsWith('/tx_metadata')) {
      const payload = JSON.parse(String(init?.body)) as { _tx_hashes: string[] };
      return Response.json(payload._tx_hashes.flatMap((tx_hash) => metadata.has(tx_hash) ? [{ tx_hash, metadata: { '22084': metadata.get(tx_hash) } }] : []));
    }
    if (url.origin === KOIOS && url.pathname.endsWith('/block_info')) {
      const payload = JSON.parse(String(init?.body)) as { _block_hashes: string[] };
      return Response.json(payload._block_hashes.flatMap((blockHash) => blocks.has(blockHash) ? [blocks.get(blockHash)] : []));
    }
    if (url.origin === KOIOS && url.pathname.endsWith('/asset_txs')) {
      const payload = JSON.parse(String(init?.body)) as { _asset_policy: string; _asset_name: string };
      if (payload._asset_policy !== MAINNET.identity.hash) return Response.json([]);
      const unit = `${payload._asset_policy}${payload._asset_name}`;
      const history = txs.filter((row) => row.outputs.some((out) => Array.isArray(out.asset_list)
        && out.asset_list.some((asset) => isObject(asset) && asset.policy_id + String(asset.asset_name) === unit)));
      return Response.json(history.map(({ tx_hash, tx_timestamp }) => ({ tx_hash, block_height: blocksOf.get(tx_hash)!.block_height, block_time: tx_timestamp })));
    }
    if (url.origin === KOIOS) return ledger.koios.f(uri, init);
    if (url.origin === INDEXER && url.pathname === '/jury/cases') return Response.json({ cases: indexed === null ? [] : [indexed] });
    if (url.origin === INDEXER && url.pathname.endsWith('/lineage')) {
      const escrow = decodeURIComponent(url.pathname.split('/')[2]!);
      const found = submittedByEscrow.get(escrow);
      if (found === undefined) return new Response('{}', { status: 404 });
      const end = acceptedModels.get(escrow);
      return Response.json({ original_ref: escrow, rows: [{ state: 'Submitted', utxo_ref: found }],
        terminal: end ? { type: 'AcceptEscrow', tx_hash: end } : escrow === ref('post quote-a3') && options.release !== 'absent' ? { type: 'ReleaseEscrow', tx_hash: releaseTx } : null });
    }
    if (url.origin === MOCK_PUBLIC_BASE && url.pathname === `/admin/tenants/${tenant}/log`) {
      if (new Headers(init?.headers).get('authorization') !== `Bearer ${MOCK_TOKEN}` || options.correlation === 'unauthorized') return new Response('{}', { status: 401 });
      return Response.json({ tenant, lines: options.correlation === 'duplicate' ? [privateWriter, privateWriter] : [privateWriter], dropped: options.correlation === 'dropped' ? 1 : 0 });
    }
    if (url.origin === MOCK_PUBLIC_BASE && url.pathname === `/t/${tenant}/log`) return Response.json({ tenant, lines: log, dropped: 0 });
    if (url.origin === MOCK_PUBLIC_BASE && url.pathname === `/t/${tenant}/state`) return Response.json({ tenant, sourcing: { rankings: rankingRows } });
    for (const { uri: manifestUri, body } of manifests.values()) if (uri === manifestUri) return new Response(body);
    if (uri === `${MODEL_ENDPOINT}/capability`) return Response.json({ capability_id: modelTerms.capability_id, model: modelTerms.model,
      advert_ref: asRef(modelAdvert), supplier_pkh: model.keyHash, pub_key_hex: model.publicKeyHex });
    if (url.hostname === 'raw.githubusercontent.com') return Response.json(MODULE_MANIFEST);
    throw new Error('unexpected fake read');
  }) as typeof fetch;
  const node = new ScriptedNode(w.world);
  node.txStatus = async (txHash) => ({ confirmations: settled.has(txHash) ? 3 : null });
  const hosted = new PackHosted({
    vector_get_jury_cases: () => ({ text: '# Cases\n\n```json\n[]\n```' }),
    vector_resolve_did: ({ did: wanted }) => {
      if (wanted !== did(target.id)) throw new Error('resolver asked for another DID');
      return { didDocument: options.revocation === 'resolver-active' ? { id: wanted } : null,
        didResolutionMetadata: options.revocation === 'resolver-error' ? { error: { title: 'Resolver error' } } : {},
        didDocumentMetadata: {
          ...(options.revocation === 'resolver-unbound' ? {} : { canonicalId: options.revocation === 'resolver-other' ? did(buyer.id) : wanted }),
          deactivated: options.revocation !== 'resolver-active', vectorStatus: { effective: options.revocation === 'resolver-active' ? 'Active' : 'Revoked' },
        } };
    },
  });
  const chain = { ...w.chain, ...ledger.env, provider, fetchImpl: web };
  w.clock.t = ms(341);
  const task = createEvidenceTask({ [data.name]: bidEvaluation });
  const exit = await runTask(task, ['run', '--run', label, '--number', '1'], w.deps({ chain, node, hosted, fetchImpl: web }));
  const error = w.screen.errorText;
  const result = w.machine();
  const path = result.result.file;
  const text = typeof path === 'string' ? readFileSync(join(w.stateDir, path), 'utf8') : null;
  const doc: unknown = text === null ? null : JSON.parse(text);
  if (doc !== null && !isObject(doc)) throw new Error('evidence fixture did not produce an object');
  return { exit, error, result, text, doc };
}
