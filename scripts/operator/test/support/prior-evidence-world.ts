import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseKeyText } from '../../../checks/lib/keys.ts';
import { EvidenceFile } from '../../../checks/lib/evidence.ts';
import type { Utxo } from '../../../checks/lib/platform.ts';
import { attestation, attestationUtxo, CAPTURE_MS, DAY, delegation, delegationUtxo, koiosRow, ledgerWorld, liveRecord, MAINNET, recordUtxo, vaultUtxo } from '../../../../packages/buyer-core/test/fixtures/ledger-read-world.ts';
import type { Contract, Row, TxIo, TxRow } from '../../../../packages/buyer-core/test/fixtures/ledger-read-world.ts';
import { escrowUtxo, identityEscrow } from '../../../../packages/buyer-core/test/fixtures/escrow-identity.fixture.ts';
import { blake2b256Hex } from '../../../../packages/buyer-core/src/index.ts';
import { encodeClaimDatum, encodeChallengeDatum, encodeJuryDatum } from '../../../../packages/buyer-core/src/vendored/mcp/jury-codec.ts';
import type { CaseDatum } from '../../../../packages/buyer-core/src/vendored/mcp/jury-codec.ts';
import { documentHash, documentMetadata, documentUri } from '../../../../packages/buyer-core/src/vendored/mcp/jury-document.ts';
import { CONFIG_TOKEN_NAME } from '../../../../packages/buyer-core/src/vendored/mcp/identity-deployment.ts';
import { ROLE_MAX_RIGHTS } from '../../../../packages/buyer-core/src/vendored/mcp/identity-rules.ts';
import { canonicalize, plutusAddressFromBech32, plutusAddressToBech32, promptHashForPayload } from '../../../../packages/vector-read/src/index.ts';
import { encodeDelegationDatum, encodeVaultDatum } from '../../../../packages/vector-read/src/identity-codec.ts';
import { encodePlutusDataHex } from '../../../../packages/vector-read/src/vendored/shared/cbor/plutus-data.ts';
import type { PlutusData } from '../../../../packages/vector-read/src/vendored/shared/cbor/plutus-data.ts';
import { plutusAddressToData } from '../../../../packages/vector-read/src/vendored/shared/cbor/address.ts';
import { requestText } from '../../../../packages/usecase-kit/src/buyer/message.ts';
import { evidenceDocument } from '../../../../packages/usecase-kit/src/dispute/index.ts';
import { canonicalSha256, HANDOFF_SCHEMA, makeProposal, parseApprovalRef, parseDid, parseHandoff, parseOutputRef, PROPOSAL_SCHEMA, RECEIPT_CHECKS, RESULT_SCHEMA } from '../../../../packages/usecase-kit/src/protocol/index.ts';
import { INTAKE_CHECKS, INTAKE_RECORD_SCHEMA, parsePriorAuthRequest, PRIORAUTH_REQUEST_SCHEMA } from '../../../../packages/usecase-kit/src/priorauth/index.ts';
import type { PriorAuthRequest } from '../../../../packages/usecase-kit/src/priorauth/index.ts';
import type { Proposal, ProtocolResult } from '../../../../packages/usecase-kit/src/protocol/index.ts';
import { alterJustification } from '../../../../agents/prior-authorization-agent/src/execute/fault.ts';
import { FactsFile } from '../../lib/facts.ts';
import { priorAuthorization } from '../../lib/evidence/prior-authorization.ts';
import type { Obj } from '../../lib/evidence/types.ts';
import { MOCK_PUBLIC_BASE } from '../../lib/mock-hosts.ts';
import { runTask } from '../../lib/runner.ts';
import { createEvidenceTask } from '../../tasks/evidence.ts';
import data from '../../usecases/prior-authorization.ts';
import { PackHosted } from './pack-hosted.ts';
import { ReceiptHistoryWorld } from './receipt-history-world.ts';
import { ScriptedNode, taskWorld } from './task-world.ts';

export const h = (name: string): string => createHash('sha256').update(`prior-evidence fixture ${name}`, 'utf8').digest('hex');
export const rf = (name: string, i = 0): string => `${h(name)}#${i}`;
const did = (id: string): string => `did:vector:${id}`;
const at = (minute: number): number => CAPTURE_MS + minute * 60_000;
const bytesOf = (hex: string): PlutusData => ({ kind: 'bytes', hex });
const integerOf = (value: number): PlutusData => ({ kind: 'int', value: BigInt(value) });
const constr = (index: number, fields: PlutusData[]): PlutusData => ({ kind: 'constr', index: BigInt(index), fields });
const iso = (minute: number): string => new Date(at(minute)).toISOString();
const publisher = (name: string) => parseKeyText(h(`synthetic signer ${name}`), 'run');
const address = (hash: string, type: 'Script' | 'VerificationKey' = 'Script'): string => plutusAddressToBech32({ paymentCredential: { type, hash }, stakeCredential: null }, 1);
const draft = data.agents.find((one) => one.kind === 'prior-authorization-agent')!;
const intake = data.agents.find((one) => one.kind === 'insurer-intake-agent')!;
const childSpecs = data.subagents.filter((one) => one.parent === draft.id);
const DRAFT = h(draft.id);
const INTAKE = h(intake.id);
const ISSUER = h('member did');
const DRAFT_KEY = publisher('draft receipt');
const INTAKE_KEY = publisher('intake receipt');
const SERVICE_KEY = publisher('intake transaction');
const ISSUER_KEY = publisher('member issuer');
const WALLET = publisher('fees');
const ROOT = h('funding delegation');
const CLAIM = 'af'.repeat(28);
const CHALLENGE = 'ae'.repeat(28);
const JURY = 'ad'.repeat(28);
const PARTY = 'ab'.repeat(28);
const CHALLENGE_TOKEN = `63686c5f${h('challenge unit').slice(0, 56)}`;
const CLAIM_TOKEN = `636c6d5f${h('draft claim unit').slice(0, 56)}`;
const CASE_TOKEN = h('case unit');
const COMMIT = h('module manifest').slice(0, 40);
const KOIOS = 'https://koios.example';
const INDEXER = 'https://indexer.example';
const HEADER = { network: 'vector-mainnet' };
const SUBMISSION_ROUTE = 'POST /records/orders/{order_id}/submission';
const REFUND_TOKEN = `${'ec'.repeat(28)}be`;
const manifest = {
  format: 'vector-module-deploy/1', module: 'module1', network: 'mainnet', mode: 'oracle', identity: { identity_hash: MAINNET.identity.hash },
  module1: { oracle_vkh: 'a1'.repeat(28), refs_token_policy: 'a2'.repeat(28) }, hashes: { claim: CLAIM, challenge: CHALLENGE },
  addresses: { claim: address(CLAIM), challenge: address(CHALLENGE) }, claim_ref: rf('claim script'), challenge_ref: rf('challenge script'),
  cross_refs_utxo: rf('cross refs'), params_utxo: rf('module params'),
  protocol_params: { oracle_active: true, min_claim_stake: 50_000_000, min_challenge_window: DAY, max_challenge_window: 30 * DAY, resolution_deadline: 30 * DAY },
};

function value<T, C extends string>(result: ProtocolResult<T, C>): T {
  if (!result.ok) throw new Error(`Invalid fixture: ${result.detail}`);
  return result.value;
}
function io(ref: string, cred: string, bech32 = address(cred)): TxIo {
  return { tx_hash: ref.slice(0, 64), tx_index: Number(ref.slice(65)), value: '5000000', payment_addr: { bech32, cred }, inline_datum: null };
}
function spend(ref: string, script: string, constructor: number, fields: unknown[] = []): Contract {
  return { script_hash: script, valid_contract: true, spends_input: { tx_hash: ref.slice(0, 64), tx_index: Number(ref.slice(65)) },
    input: { redeemer: { purpose: 'spend', datum: { hash: h('redeemer body'), value: { constructor, fields } } } } };
}
function decision(name: string, choice: Obj = {}): Obj {
  return { name, choice, reasoning: 'private clinical decision text', inference: { path: 'marketplace', accepted: 'confirmed',
    sub_job: { capability_id: 'model.chat.v1', advert_ref: rf('model advert'), escrow_ref: rf(`model ${name}`), supplier_pkh: 'a1'.repeat(28),
      receipt: {}, receipt_signature: 'cc'.repeat(64), verification: Object.fromEntries(RECEIPT_CHECKS.map((name) => [name, true])) } } };
}

export interface PriorFixture {
  readonly kind: 'clean' | 'failure';
  readonly fault?: 'missing' | 'late';
  readonly handoff?: 'wrong_ref' | 'wrong_receipt' | 'pending' | 'pending_without_confirmation';
  readonly binding?: 'missing' | 'wrong_type' | 'wrong_issuer';
  readonly rejectApproval?: 'missing_preimage' | 'wrong_proposal' | 'same_digest_wrong_id' | 'wrong_supersedes' | 'not_revoked' | 'expired_exit' | 'same_block_revoke';
  readonly draftDecision?: 'missing';
  readonly delegation?: 'wrong_child' | 'not_closed';
  readonly mock?: 'no_read' | 'read_after_end' | 'read_after_propose' | 'x509' | 'no_filing_log' | 'wrong_submission' | 'fault_filed';
  readonly intakeChecks?: 'missing';
  readonly vault?: 'wallet' | 'different_vault' | 'wrong_refund_owner';
  readonly case?: 'no_jury' | 'pending' | 'ClaimerWins' | 'wrong_auditor' | 'wrong_key' | 'controller_only' | 'wrong_claimer' | 'wrong_document'
    | 'wrong_approval' | 'wrong_digest' | 'wrong_kind' | 'wrong_wire' | 'early_hold' | 'missing_application' | 'unapplied' | 'wrong_application' | 'wrong_resolution' | 'expired_hold';
  readonly holdLength?: 'short_verdict' | 'retained_longer' | 'retained_shorter' | 'wrong_window';
  readonly end?: 'wrong_redeemer' | 'wrong_epoch' | 'resolver_active' | 'probe_before' | 'wrong_probe_subject' | 'wrong_resource' | 'wrong_action'
    | 'generic_refusal' | 'generic_grant' | 'noncanonical_time';
  readonly listing?: 'listed' | 'no_refusal';
}

export interface PriorOutcome {
  readonly exit: number; readonly errors: string; readonly output: string; readonly text: string | null;
  readonly executeRequests: ReadonlyMap<string, string>; readonly receiptText: string;
}

interface Draft extends Proposal { readonly typedDocument: PriorAuthRequest }
interface ApprovalFixture { readonly ref: { attestation: string; issuer_did: string }; readonly until: string }

/** Assemble complete private run inputs and run the actual task. All external reads are scoped fixtures. */
export async function writePriorEvidence(s: PriorFixture, privateFile = false): Promise<PriorOutcome> {
  const clean = s.kind === 'clean';
  const label = clean ? 'r1' : 'r2';
  const tenant = `prior-fixture-${label}`;
  const { keys: _keys, ...use } = data;
  // The runner loads the supplied data through its test dependency, without activating it in production.
  const world = await taskWorld({ keys: ['run', 'fee'], use, env: { OPERATOR_USE_CASE: 'inventory-reorder',
    OPERATOR_MODULE1_COMMIT: COMMIT, VECTOR_KOIOS_URL: KOIOS, VECTOR_MARKETPLACE_INDEXER_URL: INDEXER } });
  world.clock.t = at(s.case === 'expired_hold' ? 11_000 : 500);
  const root = join(world.stateDir, 'runs');
  const folder = join(root, label);
  mkdirSync(world.stateDir, { recursive: true, mode: 0o700 });
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  const allTxs: TxRow[] = [];
  const historical: Row[] = [];
  const live: Utxo[] = [];
  const receiptHistory = new ReceiptHistoryWorld(allTxs, historical, CAPTURE_MS / 1000);
  const submissions: Array<{ agent: string; output: Utxo; closesAt: number }> = [];
  const receipts = new Map<string, { receipt: Obj; receipt_signature: string; result: Obj }>();
  const executeRequests = new Map<string, string>();
  const hires: Obj[] = [];
  const approvals: Obj[] = [];
  const subdelegations: Obj[] = [];
  const metadata = new Map<string, unknown>();
  const known = new Set<string>();
  const tx = (tx_hash: string, minute: number, inputs: TxIo[] = [], more: Partial<TxRow> = {}) => {
    allTxs.push({ tx_hash, tx_timestamp: at(minute) / 1_000, inputs, outputs: [], plutus_contracts: [], assets_minted: [], ...more });
    known.add(tx_hash);
  };
  const remember = (utxo: Utxo, spent: boolean) => { historical.push(koiosRow(utxo, { is_spent: spent })); };
  const toIo = (utxo: Utxo): TxIo => {
    const raw = koiosRow(utxo);
    return { ...io(`${utxo.txHash}#${utxo.outputIndex}`, raw.payment_cred!, utxo.address), value: raw.value, asset_list: raw.asset_list };
  };
  const minted = (policy_id: string, asset_name: string, quantity: string) => ({ policy_id, asset_name, quantity });
  const asset = (name: string, script: string, token: string, datum: string, ix = 0): Utxo => ({
    txHash: h(name), outputIndex: ix, address: address(script), datum, assets: { lovelace: 5_000_000n, [`${script}${token}`]: 1n },
  });
  const configured: Utxo = { txHash: h('config'), outputIndex: 0, address: MAINNET.configHolder.address,
    assets: { lovelace: 2_000_000n, [`${MAINNET.configSeal.hash}${CONFIG_TOKEN_NAME}`]: 1n }, datum: encodePlutusDataHex({ kind: 'bytes', hex: PARTY }) };
  live.push(configured);
  const facts = FactsFile.open(join(world.stateDir, 'facts.json'), { useCase: data.name, network: HEADER.network });
  facts.put('tenants', [label], { name: tenant, createdAt: iso(-100), seedKind: 'default' });
  const actors = [draft, intake, ...childSpecs];
  for (const spec of actors) {
    const id = h(spec.id);
    const registration = h(`registration ${spec.id}`);
    facts.put('records', [spec.id], { did: did(id), id, tx: registration, recordRef: `${registration}#0`, depositLovelace: '10000000', registeredAt: iso(-200) });
    known.add(registration);
  }
  const draftAdvert = rf('draft advert');
  const intakeAdvert = rf('intake advert');
  for (const [spec, advert] of [[draft, draftAdvert], [intake, intakeAdvert]] as const) {
    facts.put('adverts', [spec.id, spec.adverts[0]!.model], { ref: advert, tx: advert.slice(0, 64), detailUri: 'https://fixture.example/spec',
      detailHash: h('advert detail'), endpoint: 'https://fixture.example', postedAt: iso(-180) });
  }

  const hold = !clean && s.case !== 'pending' && s.case !== 'no_jury' && s.case !== 'ClaimerWins' && s.case !== 'unapplied';
  const holdSince = at(s.case === 'early_hold' ? 144 : 363);
  const verdictDuration = s.holdLength === 'short_verdict' ? 6 * DAY : 7 * DAY;
  const oldHoldEnd = s.holdLength === 'short_verdict' ? holdSince + 7 * DAY
    : s.holdLength === 'retained_longer' ? holdSince + 8 * DAY : s.holdLength === 'retained_shorter' ? holdSince + 5 * DAY : null;
  const holdUntil = s.holdLength === 'wrong_window' ? at(364) + 7 * DAY
    : Math.max(holdSince + verdictDuration, oldHoldEnd ?? 0);
  const active = liveRecord({}, [DRAFT_KEY.publicKeyHex]);
  const parent = { ...active, parties: [...active.parties, { ...active.parties[0]!, role: 'Responsible' as const,
    signer: { type: 'Script' as const, hash: PARTY }, rights: ROLE_MAX_RIGHTS.Responsible }] };
  const earlier = hold ? { ...parent, status: { type: 'Suspended' as const, holds: [{ by: { type: 'Script' as const, hash: PARTY },
    reason: 64, since: holdSince, until: holdUntil }] } } : parent;
  const lastRecord = { ...earlier, subagentEpoch: clean ? 0 : (s.end === 'wrong_epoch' ? 2 : 1) };
  const epochTx = h('epoch bump');
  const head = { ...recordUtxo(DRAFT, lastRecord), txHash: clean ? h('clean drafting record') : epochTx };
  const intakeRecord = s.case === 'controller_only' ? liveRecord({ controller: SERVICE_KEY.publicKeyHex }, [INTAKE_KEY.publicKeyHex])
    : liveRecord({}, [INTAKE_KEY.publicKeyHex, SERVICE_KEY.publicKeyHex]);
  const intakeHead = { ...recordUtxo(INTAKE, intakeRecord), txHash: h('intake identity record') };
  live.push(head, intakeHead, recordUtxo(ISSUER, liveRecord({ controller: ISSUER_KEY.publicKeyHex })));
  receiptHistory.record(INTAKE, [{ output: intakeHead, seconds: at(-180) / 1000 }]);
  if (clean) receiptHistory.record(DRAFT, [{ output: head, seconds: at(-180) / 1000 }]);
  known.add(head.txHash);
  for (const spec of childSpecs) live.push(recordUtxo(h(spec.id), liveRecord({ lineage: { type: 'Subagent', parent: DRAFT, parentEpoch: 0, depth: 1 } })));

  const owner = { type: 'PrincipalKey' as const, hash: ISSUER_KEY.keyHash, organisation: null };
  const vault = { type: 'Live' as const, owner, delegation: ROOT, spent: 0n, periodStart: at(-50) };
  const returned = encodeVaultDatum({ type: 'Returned', owner });
  const refund = { address: plutusAddressFromBech32(MAINNET.vault.address), datum: returned };
  const constructor = (index: number, ...fields: unknown[]): Obj => ({ constructor: index, fields });
  const vaultJson = constructor(0, constructor(0, { bytes: owner.hash }, constructor(1)), { bytes: ROOT }, { int: 0 }, { int: at(-50) });
  let vaultRef = rf('open vault');
  tx(h('open vault'), -50);
  const runVault = vaultRef;
  if (s.vault === 'different_vault') {
    vaultRef = rf('open unrelated vault');
    tx(h('open unrelated vault'), -49);
  }
  const rootDatum = delegation({ parent: null, delegate: DRAFT, delegator: owner });
  const rootOutput = { ...delegationUtxo(ROOT, rootDatum), txHash: h('delegate root') };
  remember(rootOutput, true);
  tx(rootOutput.txHash, -60, [], { outputs: [toIo(rootOutput)], assets_minted: [minted(MAINNET.delegation.hash, ROOT, '1')] });
  let rootEnd: string | null = null;
  if (s.delegation === 'not_closed') live.push(rootOutput);
  else {
    rootEnd = h('end root');
    tx(rootEnd, 450, [], { assets_minted: [minted(MAINNET.delegation.hash, ROOT, '-1')] });
  }
  if (clean) for (const [i, spec] of childSpecs.entries()) {
    const id = h(`delegation ${spec.id}`);
    const delegate_tx = h(`delegate ${spec.id}`);
    const undelegate_tx = h(`undelegate ${spec.id}`);
    const participant = s.delegation === 'wrong_child' && i === 0 ? INTAKE : h(spec.id);
    const out: Utxo = { txHash: delegate_tx, outputIndex: 0, address: MAINNET.delegation.address, assets: { lovelace: 2_500_000n, [`${MAINNET.delegation.hash}${id}`]: 1n },
      datum: encodeDelegationDatum(delegation({ parent: ROOT, delegate: participant })) };
    remember(out, true);
    tx(delegate_tx, 12 + i * 2, [], { outputs: [toIo(out)], assets_minted: [minted(MAINNET.delegation.hash, id, '1')] });
    tx(undelegate_tx, s.mock === 'read_after_propose' && i === 1 ? 21 : 14 + i * 2, [toIo(out)], { assets_minted: [minted(MAINNET.delegation.hash, id, '-1')] });
    subdelegations.push({ id, delegate_tx, undelegate_tx, subagent: spec.id, hire: 'propose' });
  }

  const runIntakes = (step: string, minute: number, result: Obj | null, payload?: string) => makeHire(step, minute, true, result, payload);
  function makeHire(step: string, minute: number, isIntake: boolean, result: Obj | null, payload?: string) {
    const post = h(`post ${step}`);
    const original = `${post}#0`;
    const accept = result === null ? null : h(`accept ${step}`);
    const reclaim = result === null ? h(`reclaim ${step}`) : null;
    const advert = isIntake ? intakeAdvert : draftAdvert;
    const supplier = isIntake ? INTAKE_KEY : DRAFT_KEY;
    const agent = isIntake ? INTAKE : DRAFT;
    const fromVault = isIntake && s.vault !== 'wallet';
    const promptHash = payload === undefined ? h(`prompt ${step}`) : promptHashForPayload(payload);
    const holdings = { lovelace: 5_000_000n, ...(reclaim === null ? {} : { [REFUND_TOKEN]: 3n }) };
    const open = identityEscrow(at(minute), { agent_id: agent, supplier_pkh: supplier.keyHash, advert_ref: { txHash: advert.slice(0, 64), index: 0 },
      prompt_hash: promptHash, ...(fromVault ? { refund } : {}) });
    const escrow = (hash: string, datum: typeof open): Utxo => escrowUtxo(hash, datum, { address: MAINNET.escrow.address, assets: holdings });
    const posted = escrow(post, open);
    remember(posted, true);
    const origin = toIo(posted);
    if (fromVault) {
      const [hash, index] = vaultRef.split('#');
      const funding = vaultUtxo(vault, 20_000_000n, { txHash: hash!, outputIndex: Number(index) });
      remember(funding, true);
      tx(post, minute, [{ ...toIo(funding), inline_datum: { bytes: null, value: vaultJson } }], {
        outputs: [origin, io(`${post}#1`, MAINNET.vault.hash)], plutus_contracts: [spend(vaultRef, MAINNET.vault.hash, 0)],
      });
      vaultRef = `${post}#1`;
    } else tx(post, minute, [io(rf(`wallet ${step}`), WALLET.keyHash, WALLET.address)], { outputs: [origin] });
    hires.push({ step, agent: isIntake ? intake.id : draft.id, advert_ref: advert, escrow_ref: original, post_tx: post, accept_tx: accept, reclaim_tx: reclaim,
      report_file: result === null ? null : `${step}.report.json` });
    if (reclaim !== null) {
      const fund = { txHash: h(`refund fee ${step}`), outputIndex: 0, address: WALLET.address, assets: { lovelace: 4_000_000n } };
      const wrong = s.vault === 'wrong_refund_owner' && step === 'intake-e';
      const refundA = vaultUtxo({ type: 'Returned', owner }, 2_300_000n, { txHash: reclaim, outputIndex: 0 });
      const refundB = vaultUtxo({ type: 'Returned', owner: wrong ? { ...owner, hash: WALLET.keyHash } : owner }, 2_750_000n,
        { txHash: reclaim, outputIndex: 1, assets: { lovelace: 2_750_000n, [REFUND_TOKEN]: 3n } });
      const change = { txHash: reclaim, outputIndex: 2, address: WALLET.address, assets: { lovelace: 3_700_000n } };
      remember(fund, true);
      for (const out of [refundA, refundB, change]) remember(out, false);
      tx(reclaim, minute + 9, [origin, toIo(fund)], { outputs: [refundA, refundB, change].map(toIo), fee: '250000', plutus_contracts: [spend(original, MAINNET.escrow.hash, 3)] });
      return;
    }
    if (result === null || accept === null) throw new Error('Invalid fixture: report without its settlement');
    const resultText = JSON.stringify(result);
    const receipt = { prompt_hash: promptHash, response_hash: createHash('sha256').update(resultText, 'utf8').digest('hex'), model: (isIntake ? intake : draft).adverts[0]!.model,
      prompt_tokens: 0, completion_tokens: 0, escrow_ref: original, supplier_pkh: supplier.keyHash, wallclock_ms: 700, agent_did: did(agent) };
    const signature = supplier.signMessage(Buffer.from(canonicalize(receipt), 'utf8'));
    const receiptHash = createHash('sha256').update(canonicalize({ receipt, signature }), 'utf8').digest('hex');
    receipts.set(step, { receipt, receipt_signature: signature, result });
    writeFileSync(join(folder, `${step}.report.json`), JSON.stringify({ verdict: 'VERIFIED', checks: { escrow_ref_matches: 'pass', response_hash_matches: 'pass', supplier_key_matches: 'pass', signature_valid: 'pass' },
      receipt, receipt_signature: signature, result: resultText }), { mode: 0o600 });
    const claim = h(`claim hire ${step}`);
    const submit = h(`submit hire ${step}`);
    const settleAt = minute + (step === 'propose' ? 8 : 2);
    const submitted = escrow(submit, { ...open, state: 'Submitted', submitted_at: at(settleAt), result_receipt_hash: receiptHash });
    const prior = `${claim}#0`;
    tx(claim, minute + 1, [origin], { outputs: [io(prior, MAINNET.escrow.hash)], plutus_contracts: [spend(original, MAINNET.escrow.hash, 0)] });
    tx(submit, settleAt, [io(prior, MAINNET.escrow.hash)], { outputs: [toIo(submitted)], plutus_contracts: [spend(prior, MAINNET.escrow.hash, 1, [{ bytes: receiptHash }])] });
    submissions.push({ agent, output: submitted, closesAt: at(settleAt) });
    tx(accept, settleAt + 1, [toIo(submitted)], { plutus_contracts: [spend(`${submit}#0`, MAINNET.escrow.hash, 2)] });
    if (step === 'intake' && s.handoff === 'pending_without_confirmation') known.delete(accept);
    for (const name of ['justification', 'completeness', 'accept_delivery']) known.add(h(`model ${name}`));
  }

  function proposal(name: string, number: number, minute: number, record = true): Draft {
    const document = value(parsePriorAuthRequest({ schema: PRIORAUTH_REQUEST_SCHEMA, request_number: `${tenant}-${number}`, tenant,
      order_id: 'ORD-1001', patient_ref: 'SYN-PT-0042', ordering_clinician_ref: 'SYN-CL-0042', service_code: 'SYN-MRI-LS', diagnosis_codes: ['M54.16'],
      justification: 'private fixture clinical justification', guideline_refs: ['C3'], record_refs: ['REC-0001'], record_set_sha256: h('record set'), insurer_did: did(INTAKE), advert_ref: intakeAdvert }));
    const proposal = value(makeProposal(document, h(`proposal salt ${name}`)));
    if (record) makeHire(name, minute, false, { schema: PROPOSAL_SCHEMA, outcome: 'proposed', use_case: data.name, ...proposal, exit_state: null, reason: null, fault_mode: '',
      decisions: s.draftDecision === 'missing' ? [] : [decision('justification')], sub_jobs: [] });
    return { ...proposal, typedDocument: document };
  }
  function approval(name: string, digest: string, issued: number, until: number, opts: { revoked?: number; supersedes?: string; binding?: boolean; type?: number; issuer?: string } = {}): ApprovalFixture {
    const id = h(`approval ${name}`);
    const issue = h(`issue ${name}`);
    const revoke = opts.revoked === undefined || s.rejectApproval === 'not_revoked' ? null : h(`revoke ${name}`);
    const datum = attestation({ subject: DRAFT, issuer: ISSUER_KEY.publicKeyHex, issuerId: opts.issuer ?? ISSUER, attType: opts.type ?? (opts.binding ? 4 : 5),
      digest, issuedAt: at(issued), validUntil: at(until), links: opts.supersedes === undefined ? [] : [{ rel: 0, target: opts.supersedes }] });
    tx(issue, issued);
    if (revoke !== null) {
      const original = attestationUtxo(id, datum, { txHash: issue });
      remember(original, true);
      live.push(attestationUtxo(id, { ...datum, status: { type: 'AttRevoked', at: at(opts.revoked!), reason: 9 } }, { txHash: revoke }));
      tx(revoke, opts.revoked!, [toIo(original)]);
    } else live.push(attestationUtxo(id, datum, { txHash: issue }));
    approvals.push({ role: opts.binding ? 'binding' : 'approval', attestation: id, tx: issue, valid_until: at(until),
      revoked_tx: opts.revoked === undefined ? null : h(`revoke ${name}`), supersedes: opts.supersedes === undefined ? null : s.rejectApproval === 'wrong_supersedes' ? h('unrelated approval') : opts.supersedes });
    if (opts.revoked !== undefined) known.add(h(`revoke ${name}`));
    return { ref: { attestation: id, issuer_did: did(ISSUER) }, until: iso(until) };
  }
  interface ExecutePlan { readonly step: string; readonly intakeStep: string; readonly minute: number; readonly proposal: Draft;
    readonly approval: ApprovalFixture; readonly refusal?: { reason: string; exit: string }; readonly altered?: boolean }
  const completeStep = clean ? 'execute' : 'execute-d2';
  const subId = 'SUB-fixture-0001';
  let filedDocument!: PriorAuthRequest;
  const ending: { fault?: { document: PriorAuthRequest; approval: ApprovalFixture } } = {};
  const intakeId = 'INT-fixture-0001';
  function execute(plan: ExecutePlan) {
    const { step, intakeStep, proposal: given, approval: signed, refusal, altered, minute } = plan;
    const body = { op: 'execute', authority: { principal_did: did(ISSUER), delegation: ROOT }, tenant,
      proposal: { document: given.document, salt: given.salt, proposal_digest: given.proposal_digest }, approval:
        s.rejectApproval === 'same_digest_wrong_id' && step === 'execute-d1' ? { attestation: h('approval d2'), issuer_did: did(ISSUER) } : signed.ref };
    const request = JSON.stringify(body, null, 2);
    executeRequests.set(step, request);
    if (!(s.rejectApproval === 'missing_preimage' && step === completeStep)) writeFileSync(join(folder, `${step}.request.json`), request, { mode: 0o600 });
    const intakeResult: Obj | null = refusal !== undefined ? null : {
      schema: INTAKE_RECORD_SCHEMA, outcome: 'done', request_number: given.typedDocument.request_number, request_sha256: value(canonicalSha256(given.document)), status: 'complete', missing: [],
      intake_id: intakeId, sender: { did: did(DRAFT), organisation: 'provider.example', organisation_verified: true }, approval: { ...signed.ref, valid_until: signed.until },
      attestations: { provenance: 'valid', software: 'valid', principal_binding: clean ? 'valid' : 'absent' },
      checks: Object.fromEntries(INTAKE_CHECKS.filter((name) => s.intakeChecks !== 'missing' || name !== 'approval_type').map((name) => [name, true])),
      decisions: [decision('completeness', { complete: true, missing: [] })], fault_mode: '',
    };
    const sent = altered ? value(parseHandoff({ schema: HANDOFF_SCHEMA, use_case: data.name, sender_did: did(DRAFT), delegation: ROOT,
      document: s.case === 'wrong_wire' ? given.typedDocument : alterJustification(given.typedDocument), salt: given.salt, approval: signed.ref })) : null;
    runIntakes(intakeStep, minute + 1, intakeResult, sent === null ? undefined : requestText(sent));
    const delivery = receipts.get(intakeStep);
    const handoff = { counterparty_did: did(INTAKE), advert_ref: intakeAdvert, escrow_ref: s.handoff === 'wrong_ref' && step === completeStep ? rf('unrelated intake') : rf(`post ${intakeStep}`),
      paid_from_vault: true, receipt: delivery?.receipt ?? null, receipt_signature: s.handoff === 'wrong_receipt' && step === completeStep ? 'ab'.repeat(64) : delivery?.receipt_signature ?? null,
      result: delivery?.result ?? null, verification: delivery === undefined ? null : { verdict: 'verified', checks: {} },
      accepted: delivery === undefined ? null : s.handoff === 'pending' || s.handoff === 'pending_without_confirmation' ? 'pending' : 'confirmed' };
    makeHire(step, minute, false, { schema: RESULT_SCHEMA, use_case: data.name, proposal_digest: given.proposal_digest, handoff, challenge: null,
      outcome: refusal === undefined ? 'completed' : 'refused_by_counterparty', reason: refusal?.reason ?? null, exit_state: refusal?.exit ?? 'Completed', fault_mode: altered ? 'alter_after_approval' : '',
      decisions: refusal === undefined ? [decision('accept_delivery')] : [], writes: refusal === undefined ? [{ system: 'records', route: SUBMISSION_ROUTE, status: 201, ref: subId }] : [],
    }, request);
    if (refusal === undefined) filedDocument = given.typedDocument;
    if (altered) ending.fault = { document: given.typedDocument, approval: signed };
  }
  if (clean) {
    const p = proposal('propose', 1, 10);
    if (s.binding !== 'missing') approval('binding', h('binding digest'), 5, 1000, { binding: true,
      type: s.binding === 'wrong_type' ? 5 : undefined, issuer: s.binding === 'wrong_issuer' ? h('other issuer') : undefined });
    const executed = s.rejectApproval === 'wrong_proposal' ? proposal('other', 2, 11, false) : p;
    execute({ step: 'execute', intakeStep: 'intake', minute: 30, proposal: executed, approval: approval('clean', executed.proposal_digest, 21, 240) });
  } else {
    const d = proposal('propose-d', 1, 10);
    const first = approval('d1', d.proposal_digest, 20, 240, { revoked: s.rejectApproval === 'same_block_revoke' ? 30 : 24 });
    execute({ step: 'execute-d1', intakeStep: 'intake-d1', minute: 30, proposal: d, approval: first, refusal: { reason: 'approval_revoked', exit: 'Rejected' } });
    execute({ step: 'execute-d2', intakeStep: 'intake-d2', minute: 50, proposal: d, approval: approval('d2', d.proposal_digest, 41, 240, { supersedes: first.ref.attestation }) });
    const e = proposal('propose-e', 2, 60);
    execute({ step: 'execute-e', intakeStep: 'intake-e', minute: 90, proposal: e, approval: approval('e', e.proposal_digest, 71, 81),
      refusal: { reason: 'approval_expired', exit: s.rejectApproval === 'expired_exit' ? 'Rejected' : 'Expired' } });
    const a = proposal('propose-a', 3, 105);
    execute({ step: 'execute-a', intakeStep: 'intake-a', minute: 130, proposal: a, approval: approval('a', a.proposal_digest, 116, 240),
      refusal: { reason: 'approval_digest_mismatch', exit: 'Escalated' }, altered: true });
  }
  if (s.vault === 'different_vault') vaultRef = runVault;
  const close = s.delegation === 'not_closed' ? null : h('close vault');
  if (close === null) live.push({ ...vaultUtxo(vault, 7_000_000n), txHash: vaultRef.slice(0, 64), outputIndex: Number(vaultRef.slice(65)) });
  else tx(close, 445, [io(vaultRef, MAINNET.vault.hash)]);
  // Keep the actual producer order visible in the run record. The carried execute is the last one, not the last intake.
  hires.sort((left, right) => allTxs.findIndex((row) => row.tx_hash === left.post_tx) - allTxs.findIndex((row) => row.tx_hash === right.post_tx));
  const fault = EvidenceFile.open(join(world.stateDir, `fault.${label}.evidence.json`), { ...HEADER, check: 'fault', record: `${data.name}:${label}` }, { clock: () => iso(0) });
  const faultCheck = (minute: number, mode = '', start = -120) => fault.add({ at: iso(minute), step: 'fault_check', status: 'info', shows: {
    check: mode === '' ? 'clean' : mode, agent: mode === '' ? null : draft.id, ok: true,
    services: data.agents.map((spec) => ({ service: spec.serviceContainer, started_at: iso(spec.id === draft.id ? start : -120), value: spec.id === draft.id ? mode : '' })),
  } });
  faultCheck(1);
  if (!clean && s.fault !== 'missing') faultCheck(s.fault === 'late' ? 131 : 124, 'alter_after_approval', 121);
  faultCheck(clean ? 120 : 260, '', clean ? -120 : 220);

  const claimRef = rf('draft claim');
  const challengeRef = rf('open challenge');
  const evidenceTx = h('publish dispute evidence');
  const caseReport: Obj = {
    script_hash: JURY, canonical: true, claim: CLAIM_TOKEN, challenge: CHALLENGE_TOKEN, challenge_out: challengeRef, case: CASE_TOKEN,
    state: s.case === 'pending' ? 'open' : 'closed', window: s.case === 'pending' ? 'reveal' : 'ended',
    tally: s.case === 'pending' ? { AuditorWins: 0, ClaimerWins: 0, Inconclusive: 0 }
      : s.case === 'ClaimerWins' ? { AuditorWins: 0, ClaimerWins: 3, Inconclusive: 0 } : { AuditorWins: 3, ClaimerWins: 0, Inconclusive: 0 },
    revealed: s.case === 'pending' ? 0 : 3, result: s.case === 'pending' ? null : s.case === 'ClaimerWins' ? 'ClaimerWins' : 'AuditorWins', opened: { tx: h('open case') },
    finalized: s.case === 'pending' ? null : { tx: h('finalize case'), result: s.case === 'ClaimerWins' ? 'ClaimerWins' : 'AuditorWins' },
    closed: s.case === 'pending' ? null : { tx: h('close case') },
  };
  let verdictLocation: Obj | null = null;
  for (const spec of [draft, intake]) {
    const isDraft = spec.id === draft.id;
    const token = isDraft ? CLAIM_TOKEN : `636c6d5f${h('intake claim unit').slice(0, 56)}`;
    const claim = isDraft ? claimRef : rf('intake claim');
    const documentTx = h(`claim document for ${spec.id}`);
    facts.put('claims', [label, spec.id], { claimRef: claim, documentTx, claimTx: claim.slice(0, 64), claimToken: token, stakeLovelace: '50000000',
      windowMs: DAY, stakedAt: iso(-90), withdrawableFrom: iso(1350), withdrawTx: null });
    known.add(documentTx); known.add(claim.slice(0, 64));
  }
  if (!clean && ending.fault !== undefined) {
    const { document: faultDocument, approval: faultApproval } = ending.fault;
    const approval = value(parseApprovalRef(s.case === 'wrong_approval' ? { ...faultApproval.ref, attestation: h('approval d2') } : faultApproval.ref));
    const refs = { claim: value(parseOutputRef(claimRef)), claim_token: CLAIM_TOKEN, against_did: value(parseDid(did(DRAFT))), by_did: value(parseDid(did(INTAKE))),
      escrow_ref: value(parseOutputRef(rf(s.case === 'wrong_document' ? 'post intake-e' : 'post intake-a'))), statement_text: 'A request is the one the hirer approved.' };
    const salt = h('proposal salt propose-a');
    const evidence = value(evidenceDocument(s.case === 'wrong_kind' ? { ...refs, kind: 'quote_price',
      sku: 'fixture', quantity: 1, quoted_unit_price: 200, listed_unit_price: 100, price_list_sha256: h('price list'), quote_sha256: h('quote') }
      : { ...refs, kind: 'approval_digest', use_case: 'prior-authorization', approval,
        mismatch: { ok: false, code: 'approval_digest_mismatch', detail: 'The digests differ.',
          expected_digest: value(makeProposal(faultDocument, salt)).proposal_digest,
          observed_digest: s.case === 'wrong_digest' ? h('other observed digest') : value(makeProposal(alterJustification(faultDocument), salt)).proposal_digest } }));
    const bytes = Buffer.from(evidence.text, 'utf8');
    metadata.set(evidenceTx, documentMetadata(bytes, 'evidence', 'text/plain'));
    const original = asset('draft claim', CLAIM, CLAIM_TOKEN, encodeClaimDatum({ claimerDid: s.case === 'wrong_claimer' ? INTAKE : DRAFT,
      claimerCredential: { type: 'VerificationKey', hash: DRAFT_KEY.keyHash }, claimHash: h('claim digest'), claimType: 'aa', storageUri: 'aa', stakeAmount: 50_000_000n,
      submittedAt: at(-90), challengeWindow: DAY, state: 'Open' }));
    const challenge = asset('open challenge', CHALLENGE, CHALLENGE_TOKEN, encodeChallengeDatum({ claimRef: { txHash: original.txHash, outputIndex: 0 },
      auditorDid: s.case === 'wrong_auditor' ? DRAFT : INTAKE, auditorCredential: { type: 'VerificationKey', hash: s.case === 'wrong_key' ? WALLET.keyHash : SERVICE_KEY.keyHash },
      stakeAmount: 50_000_000n, evidenceHash: documentHash(bytes), evidenceUri: Buffer.from(documentUri(evidenceTx), 'utf8').toString('hex'),
      challengedAt: at(145), resolutionDeadline: at(1500), eligibleJurors: [], state: { type: 'PendingOracle' }, claimToken: CLAIM_TOKEN }));
    const refundTo = plutusAddressFromBech32(WALLET.address);
    const caseDatum: CaseDatum = {
      claim: CLAIM_TOKEN, challenge: CHALLENGE_TOKEN, challengeOut: { txHash: challenge.txHash, outputIndex: 0 }, claimOut: { txHash: challenge.txHash, outputIndex: 1 },
      claimer: DRAFT, auditor: INTAKE, claimHash: h('claim digest'), evidenceHash: documentHash(bytes), deadline: at(1500), openedAt: at(163), commitEnd: at(260),
      revealEnd: at(330), refundTo, fee: 0n, ballots: [], tally: { claimer: 0, auditor: 0, inconclusive: 0 }, state: { type: 'Open' },
    };
    const caseOutput = (name: string, datum: CaseDatum): Utxo => asset(name, JURY, CASE_TOKEN, encodeJuryDatum({ type: 'Case', case: datum }));
    const juryOutput = caseOutput('open case', caseDatum);
    for (const row of [original, challenge, juryOutput]) remember(row, true);
    tx(challenge.txHash, 145, [toIo(original)], { outputs: [toIo(challenge)], assets_minted: [minted(CHALLENGE, CHALLENGE_TOKEN, '1')], plutus_contracts: [spend(claimRef, CLAIM, 2)] });
    tx(juryOutput.txHash, 163, [], { outputs: [toIo(juryOutput)], assets_minted: [minted(JURY, CASE_TOKEN, '1')] });
    if (s.case !== 'pending' && s.case !== 'no_jury') {
      const againstClaimer = s.case !== 'ClaimerWins';
      const vote = againstClaimer ? 'AuditorWins' : 'ClaimerWins';
      const counted: CaseDatum = { ...caseDatum, ballots: [1, 2, 3].map((i) => ({ agent: h(`juror ${i}`), juror: h(`juror token ${i}`), commit: '',
        status: { type: 'Revealed', vote } })), tally: { claimer: againstClaimer ? 0 : 3, auditor: againstClaimer ? 3 : 0, inconclusive: 0 } };
      const revealed = caseOutput('last jury reveal', counted);
      const finalized = caseOutput('finalize case', { ...counted, state: { type: 'Settling', share: 0n } });
      remember(revealed, true);
      remember(finalized, true);
      tx(revealed.txHash, 320, [toIo(juryOutput)], { outputs: [toIo(revealed)] });
      const winner = constructor(againstClaimer ? 1 : 0);
      tx(finalized.txHash, 341, [toIo(revealed)], { outputs: [toIo(finalized)], plutus_contracts: [spend(rf('last jury reveal'), JURY, 1, [constructor(2, winner)])] });
      tx(h('close case'), 343, [toIo(finalized)], { assets_minted: [minted(JURY, CASE_TOKEN, '-1')] });
    }
    known.add(evidenceTx);
    const registered = { ...recordUtxo(DRAFT, parent), txHash: h('draft identity register') };
    const earlierHold = oldHoldEnd === null ? null : { ...recordUtxo(DRAFT, { ...parent, status: { type: 'Suspended', holds: [
      { by: { type: 'Script', hash: PARTY }, reason: 64, since: at(355), until: oldHoldEnd },
    ] } }), txHash: h('earlier hold of this agent') };
    const affected = earlierHold ?? registered;
    const applyTx = h('apply verdict');
    const pre = { ...recordUtxo(DRAFT, earlier), txHash: hold ? applyTx : h('parent before epoch'), outputIndex: hold ? 2 : 0 };
    const prev = `${pre.txHash}#${pre.outputIndex}`;
    tx(epochTx, 420, [toIo(pre)], { outputs: [toIo(head)], plutus_contracts: [spend(prev, MAINNET.identity.hash, s.end === 'wrong_redeemer' ? 0 : 8)] });
    // The linked proof has a distinct exact Resolve output and a separate identity apply transaction.
    // The indexer locates them; the task rechecks each datum, redeemer, token and document.
    const hasVerdict = s.case !== 'pending' && s.case !== 'no_jury' && s.case !== 'ClaimerWins';
    let application: Utxo | null = null;
    let verdictToken: string | null = null;
    if (hasVerdict) {
      const until = at(363) + DAY;
      const datum = encodePlutusDataHex(constr(0, [bytesOf(DRAFT), constr(0, []), integerOf(verdictDuration),
        constr(0, [bytesOf(challenge.txHash), integerOf(0)]), plutusAddressToData(refundTo), integerOf(until)]));
      verdictToken = blake2b256Hex(Buffer.from(datum, 'hex'));
      const verdict = asset('resolve challenge', PARTY, verdictToken, datum, 1);
      remember(verdict, hold);
      const resolved = Buffer.from(JSON.stringify({ type: 'vector-jury-resolution/1', basis: 'jury', challenge_out: challengeRef, challenge: CHALLENGE_TOKEN,
        claim: CLAIM_TOKEN, verdict: 'AuditorWins', jury: { deployment: JURY, case: s.case === 'wrong_resolution' ? h('another case') : CASE_TOKEN,
          opened_in: juryOutput.txHash, finalized_in: h('finalize case') } }), 'utf8');
      metadata.set(verdict.txHash, documentMetadata(resolved, 'resolution'));
      tx(verdict.txHash, 360, [toIo(challenge)], { outputs: [toIo(verdict)], assets_minted: [minted(PARTY, verdictToken, '1')],
        plutus_contracts: [spend(challengeRef, CHALLENGE, 2, [constructor(1), { bytes: documentHash(resolved) }])] });
      if (hold) {
        tx(applyTx, 364, [toIo(affected), toIo(verdict)], { outputs: [toIo(pre)], assets_minted: [minted(PARTY, verdictToken, '-1')],
          plutus_contracts: [spend(`${affected.txHash}#${affected.outputIndex}`, MAINNET.identity.hash, 2, [constructor(1, { int: 1 })])] });
        application = verdict;
      }
      if (s.case !== 'missing_application') verdictLocation = { ref: `${verdict.txHash}#${verdict.outputIndex}`, action: 'suspend', duration_ms: 7 * DAY,
        expires_at: new Date(until).toISOString(), applied_tx: !hold ? null : s.case === 'wrong_application' ? epochTx : applyTx,
        applied_time: hold ? iso(364) : null };
    }
    receiptHistory.record(DRAFT, [{ output: registered, seconds: at(-180) / 1000 },
      ...(earlierHold === null ? [] : [{ output: earlierHold, seconds: at(355) / 1000, redeemer: 2 }]),
      { output: pre, seconds: at(364) / 1000 }, { output: head, seconds: at(420) / 1000 }]);
    if (application !== null && verdictToken !== null) {
      // The history fixture re-encodes the identity token transition. Keep the other input and its burn.
      const row = allTxs.find(({ tx_hash }) => tx_hash === applyTx)!;
      row.inputs.push(toIo(application));
      row.assets_minted = [minted(PARTY, verdictToken, '-1')];
    }
    facts.put('subagentEnds', [draft.id], { tx: epochTx, at: iso(420.01), epochBefore: 0, epochAfter: 1 });
    const probes = EvidenceFile.open(join(world.stateDir, `probe.${label}.evidence.json`), { ...HEADER, check: 'probe', record: `${data.name}:${label}` }, { clock: () => iso(0) });
    for (const expected of ['granted', 'refused'] as const) {
      const refused = expected === 'refused';
      const child = childSpecs.find(({ id }) => id === (s.end === 'wrong_probe_subject' && refused ? 'drafter' : 'record-reader'))!;
      const measuredAt = iso(refused && s.end !== 'probe_before' ? 430 : 160);
      probes.add({ step: 'run', status: 'info', at: s.end === 'noncanonical_time' && refused ? measuredAt.replace('.000Z', 'Z') : measuredAt, shows: {
        probe: { subagent: child.id, subjectKey: child.keys.find((key) => key.purposes.includes('authentication'))!.key,
          dpopKey: child.keys.find((key) => key.purposes.includes('delegation'))!.key,
          resource: `${MOCK_PUBLIC_BASE}/t/${tenant}/${s.end === 'wrong_resource' ? 'guidelines' : 'records'}`,
          action: s.end === 'wrong_action' ? 'record.write' : 'record.read', expect: expected },
        record: { did: did(h(child.id)), effectiveStatus: refused ? 'revoked' : 'active' },
        observation: refused ? { kind: 'refused', status: 400, error: 'invalid_request',
          text: s.end === 'generic_refusal' ? 'private gateway observation' : "subject_token: the agent's effective status is revoked (parentRevoked), not active" }
          : s.end === 'generic_grant' ? { kind: 'granted', status: 200 } : { kind: 'granted', tokenType: 'DPoP', expiresAt: iso(165), authorizationDetails: null },
        verdict: { expected, observed: expected, ok: true },
      } });
    }
  }
  const runRecord = { format: 1, label, use_case: data.name, kind: s.kind, date: '2026-12-01', tenant, challenged: clean ? null : draft.id, rfq_ids: [],
    delegations: [{ id: ROOT, tx: h('delegate root'), ended_tx: rootEnd }], vaults: [{ ref: vaultRef, open_tx: h('open vault'), close_tx: close }],
    approvals, sub_delegations: subdelegations, hires, refusals: clean || s.listing === 'no_refusal' ? [] : [
      { step: 'r2-c', kind: 'tool', message: `Advert ${draftAdvert} is not listed by the marketplace indexer: fixture refusal.` },
    ],
  };
  writeFileSync(join(root, `${label}.json`), JSON.stringify(runRecord), { mode: 0o600 });

  const jwtId = `spiffe://intake.fixture.example/agent/${INTAKE}`;
  const filedAt = clean ? 33 : 53;
  const paymentActor = { kind: 'jwt-svid', spiffe_id: jwtId, did: did(INTAKE) };
  const writerActor = { kind: 'token', sub: did(ISSUER), act: [did(DRAFT)], delegation: ROOT };
  const insurer = { request_number: filedDocument.request_number, request: filedDocument, status: 'complete', missing: [], intake_id: intakeId,
    service_code: filedDocument.service_code, recorded_at: iso(filedAt), by: paymentActor };
  const submission = { request_number: filedDocument.request_number, intake_id: s.mock === 'wrong_submission' ? 'other-id' : intakeId,
    order_id: filedDocument.order_id, submission_id: subId, status: 'complete', recorded_at: iso(filedAt + 2), by: writerActor };
  const requests = s.mock === 'fault_filed' && ending.fault !== undefined ? [insurer, { ...insurer, request_number: ending.fault.document.request_number }] : [insurer];
  const systemState = { tenant, insurer: { requests }, records: { submissions: [submission] } };
  const log: Obj[] = [{ tenant, at: iso(filedAt + 0.01), route: 'POST /insurer/requests', path: '/fixture/private/patient', status: 201, decision: 'allowed',
    credential: s.mock === 'x509' ? 'x509-svid' : 'jwt-svid', sub: jwtId, act: [], delegation: null },
  { tenant, at: iso(filedAt + 2.01), route: SUBMISSION_ROUTE, status: 201, decision: 'allowed', credential: 'token', ...writerActor }];
  if (clean) for (const [i, spec] of childSpecs.entries()) log.push({ tenant,
    at: iso(s.mock === 'read_after_end' && i === 0 ? 15 : s.mock === 'read_after_propose' && i === 1 ? 19 : 13 + 2 * i),
    route: i === 0 ? 'GET /records/orders/{order_id}' : 'GET /guidelines/{code}',
    status: 200, decision: 'allowed', credential: 'token', sub: did(ISSUER), act: [did(h(spec.id)), did(DRAFT)], delegation: h(`delegation ${spec.id}`) });
  if (s.mock === 'no_filing_log') log.shift();
  if (s.mock === 'no_read') log.pop();
  for (const { agent, output, closesAt } of submissions) receiptHistory.submitted(agent, output, closesAt / 1000 - 1, closesAt, true);
  const ledger = ledgerWorld(live, { txs: allTxs, utxoInfo: historical });
  Object.assign(ledger.provider, { getNetworkTip: receiptHistory.getNetworkTip });
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const parsed = new URL(url);
    if (url.startsWith(`${MOCK_PUBLIC_BASE}/t/${tenant}/`)) return Response.json(parsed.pathname.endsWith('/log') ? { tenant, lines: log, dropped: 0 } : systemState);
    if (parsed.origin === INDEXER && parsed.pathname === '/disputes') return Response.json({ cases: [{ claim_ref: claimRef, claimer_agent_id: DRAFT,
      challenge: { tx: challengeRef.slice(0, 64), auditor_agent_id: INTAKE, genuine: true }, jury: s.case === 'no_jury' ? null : caseReport, verdict: verdictLocation }] });
    if (parsed.origin === INDEXER && parsed.pathname === '/jury/cases') return Response.json({ cases: s.case === 'no_jury' ? [] : [caseReport] });
    if (parsed.origin === 'https://raw.githubusercontent.com' && parsed.pathname.endsWith(`/${COMMIT}/${data.moduleManifestPath}`)) return Response.json(manifest);
    if (parsed.origin === KOIOS && parsed.pathname.endsWith('/tx_metadata') && typeof init?.body === 'string') {
      const query: { _tx_hashes: string[] } = JSON.parse(init.body);
      return Response.json(query._tx_hashes.flatMap((tx_hash) => metadata.has(tx_hash) ? [{ tx_hash, metadata: { '22084': metadata.get(tx_hash) } }] : []));
    }
    if (parsed.origin === KOIOS) return receiptHistory.answer(url, init) ?? ledger.koios.f(url, init);
    throw new Error('Unexpected fixture endpoint');
  }) as typeof fetch;
  const asJson = (rows: unknown) => ({ text: `# Tool answer\n\n\`\`\`json\n${JSON.stringify(rows)}\n\`\`\`` });
  const hosted = new PackHosted({
    vector_get_jury_cases: () => asJson([]),
    vector_marketplace_list_suppliers: () => asJson(s.listing === 'listed' ? [{ capability_id: draft.capability, advert_ref: draftAdvert, agent_id: DRAFT, did: did(DRAFT) }] : []),
    vector_resolve_did: ({ did: subject }) => ({ didDocumentMetadata: { vectorStatus: { effective: subject === did(DRAFT) ? 'Suspended' : s.end === 'resolver_active' ? 'Active' : 'Revoked' } } }),
  });
  const node = new ScriptedNode(world.world);
  node.clock = world.clock;
  Object.defineProperty(node, 'txStatus', { value: async (hash: string) => ({ confirmations: known.has(hash) ? 7 : null }) });
  const chain = { ...world.chain, deployment: MAINNET, provider: ledger.provider, koiosUrl: KOIOS, fetchImpl };
  const task = createEvidenceTask({ [data.name]: priorAuthorization });
  const exit = await runTask(task, ['run', '--run', label, ...(privateFile ? ['--private'] : ['--number', clean ? '1' : '2'])], world.deps({ chain, node, hosted, fetchImpl }));
  const path = join(world.stateDir, 'evidence', privateFile ? `private/${label}.json` : `2026-12-01-${draft.id}-run-${clean ? '1' : '2'}.json`);
  let text: string | null = null;
  try { text = readFileSync(path, 'utf8'); } catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err; }
  const receiptText = JSON.stringify(receipts.get(clean ? 'execute' : 'execute-a')?.result);
  return { exit, errors: world.screen.errorText, output: world.screen.text, text, executeRequests, receiptText };
}
