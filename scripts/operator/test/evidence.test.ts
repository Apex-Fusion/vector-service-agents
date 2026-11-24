// scripts/operator/test/evidence.test.ts - the task evidence through the real runner, over made-up runs: a complete clean run and a complete failure run, each written to a file that equals its golden
// file byte for byte. The reads are fakes: a node that confirms a list of transactions, Koios `tx_info` and `utxo_info` rows, the fixture ledger of buyer-core (delegations, vaults, attestations,
// records), the mock service, and the hosted tools. Each of the ten checks has a test that breaks one input and names the member, and an accepted twin. No test uses the network or the real clock.
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { encodePlutusDataHex } from '../../../packages/vector-read/src/vendored/shared/cbor/plutus-data.ts';
import type { PlutusData } from '../../../packages/vector-read/src/vendored/shared/cbor/plutus-data.ts';
import { plutusAddressToData as vendoredAddressData } from '../../../packages/vector-read/src/vendored/shared/cbor/address.ts';
import { encodeJuryDatum } from '../../../packages/buyer-core/src/vendored/mcp/jury-codec.ts';
import { CONFIG_TOKEN_NAME } from '../../../packages/buyer-core/src/vendored/mcp/identity-deployment.ts';
import { documentHash, documentMetadata } from '../../../packages/buyer-core/src/vendored/mcp/jury-document.ts';
import { makeProposal } from '../../../packages/usecase-kit/src/protocol/messages.ts';
import { attestation, attestationUtxo, CAPTURE_MS, DAY, delegation, delegationUtxo, ISSUER_KEY, koiosRow, ledgerWorld, liveRecord, MAINNET, recordUtxo, vaultUtxo } from '../../../packages/buyer-core/test/fixtures/ledger-read-world.ts';
import type { Contract, Row, TxIo, TxRow } from '../../../packages/buyer-core/test/fixtures/ledger-read-world.ts';
import type { Utxo } from '../../checks/lib/platform.ts';
import { escrowUtxo, identityEscrow } from '../../../packages/buyer-core/test/fixtures/escrow-identity.fixture.ts';
import { RESULT_SCHEMA as KIT_RESULT, PROPOSAL_SCHEMA as KIT_PROPOSAL } from '../../../packages/usecase-kit/src/protocol/messages.ts';
import { CONFIRMATION_SCHEMA as KIT_CONFIRMATION } from '../../../packages/usecase-kit/src/inventory/confirmation.ts';
import { RUN_APPROVAL_VALIDITY_MS } from '../lib/claim-constants.ts';
import { FactsFile } from '../lib/facts.ts';
import { canonicalize, promptHashForPayload } from '../../../packages/vector-read/src/index.ts';
import { encodeVaultDatum } from '../../../packages/vector-read/src/identity-codec.ts';
import { plutusAddressFromBech32, plutusAddressToBech32 } from '../../../packages/vector-read/src/index.ts';
import { parseKeyText } from '../../checks/lib/keys.ts';
import { MOCK_PUBLIC_BASE } from '../lib/mock-hosts.ts';
import { runTask } from '../lib/runner.ts';
import evidence, { CASE_DURATION_MS, EXPLORER_TX, JURY_HOLD_REASON, MARKETPLACE_INDEXER, createEvidenceTask, ruleStepIds, secretMarkIn } from '../tasks/evidence.ts';
import { evidenceModuleOf } from '../lib/evidence/index.ts';
import { CONFIRMATION_SCHEMA, PROPOSAL_SCHEMA, RESULT_SCHEMA, inventory } from '../lib/evidence/inventory.ts';
import { lastHire, ref as evidenceRef } from '../lib/evidence/types.ts';
import type { EvidenceModule } from '../lib/evidence/types.ts';
import type { UseCase } from '../lib/contract.ts';
import data from '../usecases/inventory-reorder.ts';
import { PackHosted } from './support/pack-hosted.ts';
import { ScriptedNode, hashOf, taskWorld } from './support/task-world.ts';
import type { MachineLine, TaskWorld } from './support/task-world.ts';

type Obj = Record<string, unknown>;
const KOIOS = 'https://koios.example';
const ESCROW_CREDENTIAL = MAINNET.escrow.hash;
const WALLET_CREDENTIAL = 'aa'.repeat(28);
const JURY = 'ab'.repeat(28);
const VERDICT_POLICY = 'da'.repeat(28);
const APPROVAL_ISSUER = 'cd'.repeat(32);
const addressOf = (hash: string): string => plutusAddressToBech32({ paymentCredential: { type: 'Script', hash }, stakeCredential: null }, 1);
const keyAddressOf = (hash: string): string => plutusAddressToBech32({ paymentCredential: { type: 'VerificationKey', hash }, stakeCredential: null }, 1);
const cbor = (index: number, fields: PlutusData[]): PlutusData => ({ kind: 'constr', index: BigInt(index), fields });
const bytes = (hex: string): PlutusData => ({ kind: 'bytes', hex });
const int = (value: number): PlutusData => ({ kind: 'int', value: BigInt(value) });
const S0 = CAPTURE_MS / 1000;
const GOLDEN = (name: string): string => fileURLToPath(new URL(`./golden/evidence-${name}.json`, import.meta.url));

const h = (text: string): string => hashOf(`evidence ${text}`);
const ref = (text: string, index = 0): string => `${h(text)}#${index}`;
const stamp = (seconds: number): string => new Date(seconds * 1000).toISOString();

function setAt(root: unknown, path: readonly (string | number)[], value: unknown): void {
  let node = root as Obj;
  for (const key of path.slice(0, -1)) node = node[key as string] as Obj;
  if (value === undefined) delete node[path[path.length - 1] as string];
  else node[path[path.length - 1] as string] = value;
}

// ---- the scenario: everything that the reads show, as plain data that a test changes before the run ----

interface Hire { step: string; role: 'propose' | 'execute' | 'order-desk'; minute: number; result: Obj; accepted: boolean; reportOver: Obj; receiptOver: Obj; entryOver: Obj; datumOver?: Obj;
  request?: { committed: string; saved?: string; mode?: number; link?: boolean };
  submittedReceipt?: 'different' | 'different_redeemer';
  liveSubmitted?: 'match' | 'different' | 'spent';
}

interface RefundPart { value: bigint; token?: bigint; wrongOwner?: boolean; otherToken?: boolean }

interface ReclaimFlow {
  readonly fee?: string | null;
  readonly wallet?: 'owner' | 'vault';
  readonly inputToken?: bigint;
  readonly changeValue?: bigint;
  readonly changeToken?: bigint;
  readonly changeElsewhere?: boolean;
  readonly missingInput?: boolean;
}

interface Scenario {
  kind: 'clean' | 'failure'; label: string; tenant: string; hires: Hire[]; record: Obj;
  facts: { claims: Obj; holds: Obj | null; tenant: string | null; adverts: Obj };
  digest: string; approval: Obj; approvalVisible: boolean; delegations: Array<{ id: string; live: boolean }>; vaults: Array<{ utxo: Utxo | null }>;
  log: Obj[]; dropped: number; poOrders: number; supplierOrders: number; mockStatus: number;
  faultEntries: Obj[] | null; cases: Obj[]; deskHold: 'held' | 'none'; juryFailed: boolean; unconfirmed: Set<string>; extraRows: TxRow[]; skipKoiosTx: Set<string>; eventualDeskFault: string;
  challengeKnown: boolean; spendOverride: Map<string, string>; indexed: Obj[]; indexerStatus: number; indexerBody: unknown; holdSince?: number; payFromWallet: boolean; recordsHoldKeys: boolean;
  challengeMint: Obj[];
  modern?: boolean;
  extraApprovals?: Obj[];
  holdAgent?: 'reorder-agent' | 'order-desk';
  reclaimToWallet?: boolean;
  reclaimShort?: boolean;
  reclaimWrongOwner?: boolean;
  reclaimParts?: RefundPart[];
  reclaimFlow?: ReclaimFlow;
  receiptDiscovery?: 'missing' | 'wrong_escrow';
  release?: 'missing' | 'false_label' | 'early' | 'failed';
  historicalHold?: { badChallenge?: boolean; badCase?: boolean; badRecord?: boolean; badDocument?: boolean };
}

const txOf = (step: string, what: 'post' | 'claim' | 'submit' | 'accept' | 'reclaim' | 'release'): string => h(`${what} of ${step}`);
const escrowOf = (step: string): string => `${txOf(step, 'post')}#0`;
const AGENTS = { 'reorder-agent': hashOf('reorder id'), 'order-desk': hashOf('desk id') };
const CLAIM_TOKEN = (agent: string): string => h(`claim token ${agent}`);
const REFUND_TOKEN = `${'ed'.repeat(28)}01`;

/** The supplier key of each agent: it signs the receipts of the hires of the agent. It comes from a text, so the golden files stay the same from one run to the next. */
const keyOf = (label: string) => parseKeyText(createHash('sha256').update(`evidence test supplier key ${label}`).digest('hex'), 'run');
const SUPPLIERS = { 'reorder-agent': keyOf('reorder-agent'), 'order-desk': keyOf('order-desk') };

const decision = (name: string, n: number): Obj => ({
  name, choice: { lot: 'lot-medium' }, reasoning: `The decision ${name} of the test run.`,
  inference: {
    path: 'marketplace', accepted: 'confirmed',
    sub_job: { capability_id: 'model.chat.v1', advert_ref: ref('model advert'), escrow_ref: ref(`model escrow ${n}`), supplier_pkh: 'bb'.repeat(28), receipt: {}, receipt_signature: 'ee'.repeat(64), verification: {} },
  },
});

const proposed = (digest: string, n: number): Obj => ({
  schema: PROPOSAL_SCHEMA, use_case: 'inventory-reorder', decisions: [decision('reorder', n)], sub_jobs: [], fault_mode: '', document: { schema: 'vector.usecase.po.v1' }, salt: h('salt'),
  proposal_digest: digest, outcome: 'proposed', exit_state: null, reason: null,
});

const handoffTo = (step: string): Obj => ({
  counterparty_did: `did:vector:${AGENTS['order-desk']}`, advert_ref: ref('advert order-desk'), escrow_ref: escrowOf(step), paid_from_vault: true, receipt: {}, receipt_signature: 'ee'.repeat(64),
  verification: {}, result: {}, accepted: 'confirmed',
});

const executed = (digest: string, deskStep: string, n: number): Obj => ({
  schema: RESULT_SCHEMA, use_case: 'inventory-reorder', proposal_digest: digest, handoff: handoffTo(deskStep), writes: [], decisions: [decision('accept_delivery', n)], fault_mode: '',
  outcome: 'completed', reason: null, challenge: null, exit_state: 'Completed',
});

const vaultRefused = (digest: string, exit: 'Failed' | 'Cancelled'): Obj => ({
  schema: RESULT_SCHEMA, use_case: 'inventory-reorder', proposal_digest: digest, handoff: null, writes: [], decisions: [], fault_mode: '', outcome: 'vault_refused', reason: 'the script failed',
  challenge: null, exit_state: exit,
});

const confirmation = (n: number, mode = ''): Obj => ({ schema: CONFIRMATION_SCHEMA, outcome: 'done', po_number: 'PO-1', decisions: [decision('availability', n)], fault_mode: mode });

const hire = (step: string, role: Hire['role'], minute: number, result: Obj, accepted = true): Hire => ({ step, role, minute, result, accepted, reportOver: {}, receiptOver: {}, entryOver: {} });

const CHALLENGE = { evidence: h('evidence document tx'), challenge: ref('challenge output') };
/** The token of the challenge: the one token that the challenge transaction mints, with a name that starts with chl_ in hex. */
const CHALLENGE_TOKEN = `63686c5f${h('challenge token').slice(0, 56)}`;
const HISTORICAL_SINCE = CAPTURE_MS + 362 * 60_000;
const HISTORICAL_HOLD = ref('hold application', 2);
const VERDICT_REF = ref('verdict resolution', 1);

/** The DID of an agent, and the SPIFFE ID that the certificate of an agent carries. */
const DID = (id: string): string => `did:vector:${id}`;
const SPIFFE = (id: string): string => `spiffe://delta.example/agent/${id}`;
// A token names the agents that act in its act chain (its first link is the Reorder Agent here), and an SVID names the Order Desk by its SPIFFE ID, as the mock service logs them.
const logLine = (route: string, credential: string, act: string[]): Obj => ({
  at: stamp(S0 + 600), tenant: 'tenant-1', route, method: route.split(' ')[0], path: route.split(' ')[1], host: credential === 'x509-svid' ? 'mtls' : 'token', credential,
  sub: credential === 'x509-svid' ? SPIFFE(AGENTS['order-desk']) : DID(h('hirer')), act: credential === 'x509-svid' ? act : act.map((one, i) => (i === 0 ? DID(AGENTS['reorder-agent']) : one)),
  delegation: credential === 'x509-svid' ? null : hashOf('delegation'), decision: 'allowed', status: 200, code: null, rule: null, token_status: null,
});

function scenario(kind: 'clean' | 'failure'): Scenario {
  const label = kind === 'clean' ? 'c1' : 'f1';
  const digest = h(`digest ${kind}`);
  const dc = h('digest c');
  const hires = kind === 'clean'
    ? [hire('propose', 'propose', 1, proposed(digest, 1)), hire('execute', 'execute', 30, executed(digest, 'order-desk', 2)), hire('order-desk', 'order-desk', 31, confirmation(3))]
    : [
      hire('propose-a', 'propose', 1, proposed(h('digest a'), 10)), hire('execute-a', 'execute', 5, vaultRefused(h('digest a'), 'Failed')),
      hire('propose-b', 'propose', 8, proposed(h('digest b'), 11)), hire('execute-b1', 'execute', 12, executed(h('digest b'), 'order-desk-b1', 12)), hire('order-desk-b1', 'order-desk', 13, confirmation(13)),
      hire('execute-b2', 'execute', 20, vaultRefused(h('digest b'), 'Failed')),
      hire('propose-c', 'propose', 30, proposed(dc, 14)),
      hire('execute-c', 'execute', 40, { ...executed(dc, 'order-desk-c', 15), outcome: 'disputed', challenge: { claim: `${h('claim tx order-desk')}#0`, ...CHALLENGE }, exit_state: 'Escalated' }),
      hire('order-desk-c', 'order-desk', 41, confirmation(16, 'confirm_wrong_lot'), false),
      hire('propose-f', 'propose', 200, { ...proposed(h('digest f'), 17), outcome: 'failed', exit_state: 'Failed', reason: 'supplier_not_listed', document: null, salt: null, proposal_digest: null }),
      hire('execute-h', 'execute', 210, vaultRefused(dc, 'Cancelled')),
    ];
  if (kind === 'failure') hires.find((one) => one.step === 'execute-c')!.result.decisions = [decision('accept_delivery', 15)];
  // The fixtures of buyer-core number their outputs with a counter, so each output gets a hash of its own here: a golden file must not depend on the order of the tests.
  const live = vaultUtxo({ type: 'Live', owner: { type: 'PrincipalKey', hash: 'cc'.repeat(28), organisation: null }, delegation: h('delegation c'), spent: 0n, periodStart: CAPTURE_MS }, 8_300_000n, { txHash: txOf('order-desk-c', 'post') });
  const claims = Object.fromEntries(Object.entries(AGENTS).map(([agent]) => [agent, {
    claimRef: `${h(`claim tx ${agent}`)}#0`, documentTx: h(`claim document tx ${agent}`), claimTx: h(`claim tx ${agent}`), claimToken: CLAIM_TOKEN(agent), stakeLovelace: '50000000', windowMs: 86_400_000,
    stakedAt: stamp(S0 - 3000), withdrawableFrom: stamp(S0 + 86_400 - 3000), withdrawTx: null,
  }]));
  const deskDigest = kind === 'clean' ? digest : dc;
  return {
    kind, label, tenant: 'tenant-1', hires, record: {}, facts: {
      claims, holds: kind === 'failure' ? { suspendTx: h('hold suspend tx'), liftTx: h('hold lift tx') } : null, tenant: 'tenant-1',
      adverts: { 'reorder-agent': { 'reorder-agent-v1': ref('advert reorder-agent') }, 'order-desk': { 'lot-medium': ref('advert order-desk') } },
    },
    digest: deskDigest, approval: { attestation: h('approval attestation'), tx: h('approval tx') }, approvalVisible: true,
    delegations: kind === 'clean' ? [{ id: h('delegation c1'), live: false }] : [{ id: h('delegation c'), live: true }, { id: h('delegation h'), live: false }],
    vaults: kind === 'clean' ? [{ utxo: null }] : [{ utxo: live }, { utxo: null }],
    log: [logLine('GET /erp/stock/{sku}', 'token', ['did:vector:one', 'did:vector:two']), logLine('POST /supplier/orders', 'x509-svid', []), logLine('POST /po', 'token', ['did:vector:one'])],
    dropped: 0, poOrders: 1, supplierOrders: 1, mockStatus: 200, faultEntries: null, cases: [], deskHold: 'none', juryFailed: false, unconfirmed: new Set(), extraRows: [], skipKoiosTx: new Set(),
    eventualDeskFault: '', challengeKnown: true, spendOverride: new Map(), indexed: [], indexerStatus: 200, indexerBody: undefined, payFromWallet: false, recordsHoldKeys: true,
    challengeMint: [{ policy_id: 'ac'.repeat(28), asset_name: CHALLENGE_TOKEN, quantity: '1' }],
  };
}

// ---- the world that a scenario makes, and the run ----

const cleanEntries = (at: number, started: Record<string, string> = {}): Obj => ({
  step: 'fault_check', status: 'info', at: stamp(at),
  shows: { check: 'clean', agent: null, ok: true, services: [{ service: 'reorder-service', started_at: started['reorder-service'] ?? stamp(S0 - 7200), value: '' }, { service: 'orders-service', started_at: started['orders-service'] ?? stamp(S0 - 7200), value: '' }] },
});
const faultEntry = (at: number, started: string): Obj => ({
  step: 'fault_check', status: 'info', at: stamp(at),
  shows: { check: 'confirm_wrong_lot', agent: 'order-desk', ok: true, services: [{ service: 'reorder-service', started_at: stamp(S0 - 7200), value: '' }, { service: 'orders-service', started_at: started, value: 'confirm_wrong_lot' }] },
});

/** The entries of a good run: a clean check before the first hire and one after the last, and for the failure run the entry of the fault before the carried hire. */
function goodFaultEntries(kind: 'clean' | 'failure'): Obj[] {
  if (kind === 'clean') return [cleanEntries(S0 + 30), cleanEntries(S0 + 4000)];
  return [cleanEntries(S0 + 30), faultEntry(S0 + 1000, stamp(S0 + 900)), cleanEntries(S0 + 20_000, { 'orders-service': stamp(S0 + 19_000) })];
}

function caseRow(over: Obj = {}): Obj {
  return {
    jury: JURY, case_token: h('case token'), utxo: ref('case output'), lovelace: 5_000_000, canonical: true, canonical_note: null, claim: CLAIM_TOKEN('order-desk'), challenge: CHALLENGE_TOKEN,
    claim_out: `${h('claim tx order-desk')}#0`, challenge_out: CHALLENGE.challenge, phase: 'settling', state: 'Settling', tally: { claimer: 0, auditor: 3, inconclusive: 0 }, revealed: 3, outcome: 'AuditorWins', ...over,
  };
}

interface Outcome { exit: number; out: string; err: string; machine: MachineLine; stateDir: string; world: TaskWorld; recordText: string; read(name: string): string | null; calls: Array<{ url: string; headers: Record<string, string> }> }

async function go(s: Scenario, argv: string[] = ['run', '--run', s.label, '--number', '1'], over: {
  cases?: Obj[]; clockMs?: number; world?: TaskWorld; runs?: typeof data.runs; env?: Record<string, string>; use?: Partial<UseCase>; task?: typeof evidence;
} = {}): Promise<Outcome> {
  const w = over.world ?? await taskWorld({ keys: ['run', 'fee'], use: { title: data.title, runs: over.runs ?? data.runs, evidenceSteps: data.evidenceSteps, agents: data.agents, subagents: data.subagents, ...over.use },
    env: { OPERATOR_USE_CASE: data.name, VECTOR_KOIOS_URL: KOIOS, ...over.env } });
  mkdirSync(w.stateDir, { recursive: true, mode: 0o700 });
  chmodSync(w.stateDir, 0o700);
  const dir = join(w.stateDir, 'runs');
  mkdirSync(join(dir, s.label), { recursive: true, mode: 0o700 });
  // -- the hires: the entries, the report files, the transactions and the escrows
  const confirmed = new Set<string>();
  const rows: TxRow[] = [...s.extraRows];
  const posted: Row[] = [];
  const historic: Row[] = [];
  const liveEscrows: Utxo[] = [];
  const entries: Obj[] = [];
  const metadata = new Map<string, unknown>();
  const row = (hash: string, minute: number, inputs: TxIo[], more: Partial<TxRow> = {}): void => {
    if (!s.skipKoiosTx.has(hash)) rows.push({ tx_hash: hash, tx_timestamp: S0 + minute * 60, inputs, outputs: [], plutus_contracts: [], assets_minted: [], tx_info_note: 'made up', ...more });
  };
  const input = (reference: string, credential: string): TxIo => ({ tx_hash: reference.slice(0, 64), tx_index: Number(reference.slice(65)), value: '1000000', payment_addr: { cred: credential, bech32: 'addr1test' }, inline_datum: null });
  const spend = (script: string, source: TxIo, constructor: number, fields: unknown[] = [], valid = true): Contract => ({
    script_hash: script, spends_input: { tx_hash: source.tx_hash, tx_index: source.tx_index }, valid_contract: valid,
    input: { redeemer: { purpose: 'spend', datum: { hash: h('redeemer'), value: { constructor, fields } } } },
  });
  // The vault lineages: a vault opens with its output at the open transaction, the Order Desk hires are paid from the first vault, and each payment spends the output that the payment before it made.
  const VAULT_CREDENTIAL = MAINNET.vault.hash;
  const vaultRoot = s.vaults.map((_, i) => `${h(`vault open ${i}`)}#0`);
  const vaultHead = [...vaultRoot];
  const owner = { type: 'PrincipalKey' as const, hash: 'cc'.repeat(28), organisation: null };
  const returned = encodeVaultDatum({ type: 'Returned', owner });
  const refund = { address: plutusAddressFromBech32(MAINNET.vault.address), datum: returned };
  const vaultInput = (reference: string): TxIo => ({
    ...input(reference, VAULT_CREDENTIAL),
    inline_datum: { bytes: null, value: { constructor: 0, fields: [{ constructor: 0, fields: [{ bytes: 'cc'.repeat(28) }, { constructor: 1, fields: [] }] }, { bytes: s.delegations[0]!.id }, { int: 0 }, { int: 0 }] } },
  });
  for (const one of s.hires) {
    const agent = one.role === 'order-desk' ? 'order-desk' : 'reorder-agent';
    const model = one.role === 'order-desk' ? 'lot-medium' : 'reorder-agent-v1';
    const advert = one.role === 'order-desk' ? ref('advert order-desk') : ref('advert reorder-agent');
    const post = txOf(one.step, 'post');
    const end = one.accepted ? txOf(one.step, 'accept') : null;
    const resultText = JSON.stringify(one.result);
    const promptHash = one.request === undefined ? h(`prompt ${one.step}`) : promptHashForPayload(one.request.committed);
    if (one.request !== undefined) {
      const path = join(dir, s.label, `${one.step}.request.json`);
      if (one.request.link) {
        const target = join(w.stateDir, `${one.step}.request-target`);
        writeFileSync(target, one.request.committed, { mode: 0o600 });
        symlinkSync(target, path);
      } else writeFileSync(path, one.request.saved ?? one.request.committed, { mode: one.request.mode ?? 0o600 });
    }
    entries.push({ step: one.step, agent, advert_ref: advert, escrow_ref: `${post}#0`, post_tx: post, accept_tx: end, reclaim_tx: null, report_file: `${one.step}.report.json`, ...one.entryOver });
    const signer = SUPPLIERS[agent];
    const receipt = {
      prompt_hash: promptHash, response_hash: createHash('sha256').update(resultText, 'utf8').digest('hex'), model, prompt_tokens: 0, completion_tokens: 0, escrow_ref: `${post}#0`,
      supplier_pkh: signer.keyHash, wallclock_ms: 900, ...one.receiptOver,
    };
    const signReceipt = (value: Obj): string => signer.signMessage(Buffer.from(canonicalize(value), 'utf8'));
    const signature = signReceipt(receipt);
    const report = {
      verdict: 'VERIFIED', checks: { escrow_ref_matches: 'pass', response_hash_matches: 'pass', supplier_key_matches: 'pass', signature_valid: 'pass' },
      receipt, receipt_signature: signature, result: resultText, ...one.reportOver,
    };
    if (one.entryOver.report_file !== null) writeFileSync(join(dir, s.label, `${one.step}.report.json`), JSON.stringify(report));
    const claim = txOf(one.step, 'claim'); const submit = txOf(one.step, 'submit');
    if (one.role === 'order-desk' && !s.payFromWallet) {
      const spent = vaultHead[0]!;
      const out = (index: number, credential: string): TxIo => ({ tx_hash: post, tx_index: index, value: '5200000', payment_addr: { cred: credential, bech32: 'addr1test' }, inline_datum: null });
      historic.push(koiosRow({ ...vaultUtxo({ type: 'Live', owner, delegation: s.delegations[0]!.id, spent: 0n, periodStart: 0 }, 20_000_000n),
        txHash: spent.slice(0, 64), outputIndex: Number(spent.slice(65)) }, { is_spent: true }));
      const pay: Contract = {
        script_hash: VAULT_CREDENTIAL, spends_input: { tx_hash: spent.slice(0, 64), tx_index: Number(spent.slice(65)) }, valid_contract: true,
        input: { redeemer: { purpose: 'spend', datum: { hash: h('pay redeemer'), value: { constructor: 0, fields: [] } } } },
      };
      row(post, one.minute, [input(ref('wallet', 1), WALLET_CREDENTIAL), vaultInput(spent)], { outputs: [out(0, ESCROW_CREDENTIAL), out(1, VAULT_CREDENTIAL)], plutus_contracts: [pay] });
      vaultHead[0] = `${post}#1`;
    } else {
      const escrowOutput: TxIo = { tx_hash: post, tx_index: 0, value: '5200000', payment_addr: { cred: ESCROW_CREDENTIAL, bech32: 'addr1test' }, inline_datum: null };
      row(post, one.minute, [input(ref('wallet', 1), WALLET_CREDENTIAL)], one.role === 'order-desk' ? { outputs: [escrowOutput] } : {});
    }
    const datum = identityEscrow(CAPTURE_MS, { advert_ref: { txHash: advert.slice(0, 64), index: 0 }, agent_id: AGENTS[agent], supplier_pkh: signer.keyHash, prompt_hash: promptHash,
      ...(one.role === 'order-desk' && !s.payFromWallet ? { refund } : {}), ...one.datumOver });
    const refundAssets = typeof one.entryOver.reclaim_tx === 'string' && s.reclaimParts !== undefined
      ? { assets: { lovelace: 4_600_000n, [REFUND_TOKEN]: 3n } } : {};
    const escrow = (hash: string, escrowDatum: typeof datum): Row => koiosRow(escrowUtxo(hash, escrowDatum, { address: MAINNET.escrow.address, ...refundAssets }), { is_spent: true });
    const submitAt = CAPTURE_MS + (one.minute + 2) * 60_000;
    if (one.entryOver.report_file !== null) {
      const committed = one.submittedReceipt === 'different' ? { ...receipt, wallclock_ms: 901 } : receipt;
      const hash = createHash('sha256').update(canonicalize({ receipt: committed, signature: committed === receipt ? signature : signReceipt(committed) }), 'utf8').digest('hex');
      const redeemerHash = one.submittedReceipt === 'different_redeemer' ? h('unrelated receipt commitment') : hash;
      const postInput = input(`${post}#0`, ESCROW_CREDENTIAL);
      const claimInput = input(`${claim}#0`, ESCROW_CREDENTIAL);
      row(claim, one.minute + 1, [postInput], { outputs: [claimInput], plutus_contracts: [spend(ESCROW_CREDENTIAL, postInput, 0)] });
      row(submit, one.minute + 2, [claimInput], { outputs: [input(`${submit}#0`, ESCROW_CREDENTIAL)],
        plutus_contracts: [spend(ESCROW_CREDENTIAL, claimInput, 1, [{ bytes: redeemerHash }])] });
      const submitted = { ...datum, state: 'Submitted' as const, submitted_at: submitAt, result_receipt_hash: hash };
      if (one.liveSubmitted === undefined) historic.push(escrow(submit, submitted));
      else {
        const nodeDatum = one.liveSubmitted === 'different' ? { ...submitted, result_receipt_hash: h('another live receipt') } : submitted;
        liveEscrows.push(escrowUtxo(submit, nodeDatum, { address: MAINNET.escrow.address }));
        historic.push({ ...escrow(submit, submitted), is_spent: one.liveSubmitted === 'spent' });
      }
      confirmed.add(submit);
    }
    if (end !== null) {
      const source = input(`${submit}#0`, ESCROW_CREDENTIAL);
      row(end, one.minute + 3, [input(s.spendOverride.get(end) ?? `${submit}#0`, ESCROW_CREDENTIAL)], { plutus_contracts: [spend(ESCROW_CREDENTIAL, source, 2)] });
    }
    if (one.step === 'order-desk-c' && end === null && one.entryOver.reclaim_tx === undefined && s.release !== 'missing') {
      const release = txOf(one.step, 'release');
      const source = input(`${submit}#0`, ESCROW_CREDENTIAL);
      row(release, one.minute + (s.release === 'early' ? 3 : 12), [source],
        { plutus_contracts: [spend(ESCROW_CREDENTIAL, source, s.release === 'false_label' ? 2 : 4, [], s.release !== 'failed')] });
      confirmed.add(release);
    }
    for (const hash of [post, end]) if (hash !== null) confirmed.add(hash);
    const reclaim = one.entryOver.reclaim_tx;
    if (typeof reclaim === 'string') {
      const flow = s.reclaimFlow;
      const fee = flow?.fee === undefined ? '250000' : flow.fee;
      const walletCred = flow?.wallet === 'owner' ? owner.hash : flow?.wallet === 'vault' ? VAULT_CREDENTIAL : WALLET_CREDENTIAL;
      const wallet = flow?.wallet === 'vault' ? MAINNET.vault.address : keyAddressOf(walletCred);
      const funding = h('refund funding input');
      const fundingUtxo: Utxo = {
        txHash: funding, outputIndex: 0, address: wallet,
        assets: { lovelace: 5_000_000n, ...(flow?.inputToken === undefined ? {} : { [REFUND_TOKEN]: flow.inputToken }) },
        ...(flow?.wallet === 'vault' ? { datum: returned } : {}),
      };
      const ioOf = (utxo: Utxo): TxIo => {
        const row = koiosRow(utxo);
        return { ...input(`${row.tx_hash}#${row.tx_index}`, row.payment_cred!), value: row.value,
          payment_addr: { bech32: utxo.address, cred: row.payment_cred! }, asset_list: row.asset_list };
      };
      if (flow?.missingInput !== true) historic.push(koiosRow(fundingUtxo, { is_spent: true }));
      const source = { ...input(`${post}#0`, ESCROW_CREDENTIAL), payment_addr: { cred: ESCROW_CREDENTIAL, bech32: MAINNET.escrow.address } };
      const parts: RefundPart[] = s.reclaimParts ?? [{ value: s.reclaimShort ? 4_599_999n : 4_600_000n, wrongOwner: s.reclaimWrongOwner }];
      const refunds = parts.map(({ value, token, wrongOwner, otherToken }, i) => {
        const datum = { type: 'Returned' as const, owner: wrongOwner ? { ...owner, hash: 'bb'.repeat(28) } : owner };
        const assets = { lovelace: value, ...(token === undefined ? {} : { [otherToken ? `${'ed'.repeat(28)}02` : REFUND_TOKEN]: token }) };
        return s.reclaimToWallet
          ? { txHash: reclaim, outputIndex: i, address: keyAddressOf(WALLET_CREDENTIAL), assets }
          : vaultUtxo(datum, value, { txHash: reclaim, outputIndex: i, assets });
      });
      const change: Utxo = { txHash: reclaim, outputIndex: parts.length,
        address: flow?.changeElsewhere ? keyAddressOf('bc'.repeat(28)) : wallet,
        assets: { lovelace: flow?.changeValue ?? 4_750_000n, ...(flow?.changeToken === undefined ? {} : { [REFUND_TOKEN]: flow.changeToken }) } };
      const outputs = [...refunds, change];
      row(reclaim, one.minute + 8, [source, ioOf(fundingUtxo)], { fee, outputs: outputs.map(ioOf), plutus_contracts: [spend(ESCROW_CREDENTIAL, source, 3)] });
      for (const output of outputs) historic.push(koiosRow(output));
      confirmed.add(reclaim);
    }
    for (const decided of (one.result.decisions as Obj[])) confirmed.add(((decided.inference as Obj).sub_job as Obj).escrow_ref!.toString().slice(0, 64));
    posted.push(escrow(post, datum));
  }
  // -- the delegations, the sub-delegation and the vaults: the transactions of the record, as the chain shows them
  const movement = (hash: string, name: string, quantity: string): void => row(hash, 0, [input(ref('wallet', 2), WALLET_CREDENTIAL)], { assets_minted: [{ policy_id: MAINNET.delegation.hash, asset_name: name, quantity }] });
  s.delegations.forEach((d, i) => { movement(h(`delegation tx ${i}`), d.id, '1'); if (!d.live) movement(h(`delegation end ${i}`), d.id, '-1'); });
  movement(h('sub delegate tx'), h('sub delegation'), '1');
  movement(h('sub undelegate tx'), h('sub delegation'), '-1');
  s.vaults.forEach((v, i) => {
    row(h(`vault open ${i}`), 0, [input(ref('wallet', 3), WALLET_CREDENTIAL)]);
    if (v.utxo === null) row(h(`vault close ${i}`), 0, [vaultInput(vaultHead[i]!)]);
  });
  // -- the ledger: delegations, vaults, the approval, the record of the Order Desk
  const utxos = liveEscrows;
  s.delegations.forEach((d, i) => { if (d.live) utxos.push(delegationUtxo(d.id, delegation(), { txHash: h(`delegation tx ${i}`) })); });
  const vaults: Obj[] = [];
  s.vaults.forEach((v) => { if (v.utxo !== null) { utxos.push(v.utxo); vaults.push({ ref: `${v.utxo.txHash}#${v.utxo.outputIndex}` }); } });
  if (s.approvalVisible) {
    if ([s.approval, ...s.extraApprovals ?? []].some((entry) => (entry.datum as Obj | undefined)?.issuerId === APPROVAL_ISSUER)) {
      utxos.push(recordUtxo(APPROVAL_ISSUER, liveRecord({ controller: ISSUER_KEY.publicKey })));
    }
    for (const value of [s.approval, ...s.extraApprovals ?? []]) {
      const datum = attestation({ subject: AGENTS['reorder-agent'], attType: 5, digest: s.digest, issuedAt: CAPTURE_MS, validUntil: CAPTURE_MS + RUN_APPROVAL_VALIDITY_MS, ...(value.datum as Obj | undefined) });
      const id = value.attestation as string;
      const issue = value.tx as string;
      const revoke = value.revokedTx as string | undefined;
      row(issue, Number(value.issueMinute ?? 0), []);
      confirmed.add(issue);
      utxos.push(attestationUtxo(id, datum, { txHash: revoke ?? issue }));
      if (revoke !== undefined) {
        const old = attestationUtxo(id, { ...datum, status: { type: 'AttActive' } }, { txHash: issue });
        historic.push(koiosRow(old, { is_spent: true }));
        row(revoke, Number(value.revokeMinute ?? 2), [input(`${old.txHash}#${Number(value.revokeIndex ?? old.outputIndex)}`, MAINNET.attestation.hash)]);
        confirmed.add(revoke);
      }
    }
  }
  const holdSince = s.holdSince ?? CAPTURE_MS + 3600_000;
  const held = { status: { type: 'Suspended' as const, holds: [{ by: { type: 'Script' as const, hash: 'ab'.repeat(28) }, reason: JURY_HOLD_REASON, since: holdSince, until: holdSince + 7 * DAY }] } };
  const listed = (agent: 'reorder-agent' | 'order-desk'): string[] => (s.recordsHoldKeys ? [SUPPLIERS[agent].publicKeyHex] : []);
  const heldAgent = s.holdAgent ?? 'order-desk';
  utxos.push({ ...recordUtxo(AGENTS['order-desk'], liveRecord(s.deskHold === 'held' && heldAgent === 'order-desk' ? held : {}, listed('order-desk'))), txHash: h('order desk record output') });
  utxos.push({ ...recordUtxo(AGENTS['reorder-agent'], liveRecord(s.deskHold === 'held' && heldAgent === 'reorder-agent' ? held : {}, listed('reorder-agent'))), txHash: h('reorder agent record output') });
  confirmed.add(h('order desk record output'));
  confirmed.add(h('reorder agent record output'));
  if (kind(s) === 'failure') {
    const challengeTx = CHALLENGE.challenge.slice(0, 64);
    row(challengeTx, 45, [], { assets_minted: s.challengeMint });
    confirmed.add(CHALLENGE.evidence); confirmed.add(challengeTx);
  }
  if (s.historicalHold !== undefined) {
    const { badCase, badChallenge, badRecord, badDocument } = s.historicalHold;
    const claim = h('claim tx order-desk');
    const challenge = CHALLENGE.challenge.slice(0, 64);
    const challengePolicy = 'ac'.repeat(28);
    const opened = h('case open tx');
    const finalized = h('case finalize tx');
    const resolution = VERDICT_REF.slice(0, 64);
    const applied = HISTORICAL_HOLD.slice(0, 64);
    utxos.push({ txHash: h('configuration seal'), outputIndex: 0, address: MAINNET.configHolder.address,
      assets: { lovelace: 5_000_000n, [`${MAINNET.configSeal.hash}${CONFIG_TOKEN_NAME}`]: 1n }, datum: encodePlutusDataHex(bytes(VERDICT_POLICY)) });
    const resolutionDocument = Buffer.from(JSON.stringify({
      type: 'vector-jury-resolution/1', basis: 'jury', challenge_out: CHALLENGE.challenge, challenge: CHALLENGE_TOKEN, claim: CLAIM_TOKEN('order-desk'), verdict: 'AuditorWins',
      jury: { deployment: JURY, case: badDocument ? h('wrong jury case') : h('case token'), opened_in: opened, finalized_in: finalized },
    }), 'utf8');
    metadata.set(resolution, documentMetadata(resolutionDocument, 'resolution'));
    const depositTo = plutusAddressFromBech32(MAINNET.vault.address);
    const caseDatum = encodeJuryDatum({ type: 'Case', case: {
      challenge: badCase ? h('different challenge token') : CHALLENGE_TOKEN, claim: CLAIM_TOKEN('order-desk'),
      challengeOut: { txHash: challenge, outputIndex: 0 }, claimOut: { txHash: challenge, outputIndex: 1 }, claimer: AGENTS['order-desk'], auditor: AGENTS['reorder-agent'],
      claimHash: claim, evidenceHash: h('evidence digest'), openedAt: CAPTURE_MS, deadline: CAPTURE_MS + DAY, commitEnd: CAPTURE_MS + 130_000,
      revealEnd: CAPTURE_MS + 180_000, refundTo: depositTo, fee: 0n, ballots: [], state: { type: 'Open' }, tally: { auditor: 3, claimer: 0, inconclusive: 0 },
    } });
    const juryInput = input(`${opened}#0`, JURY);
    const caseToken = h('case token');
    const verdictToken = h('verdict token');
    const verdictDatum = encodePlutusDataHex(cbor(0, [bytes(AGENTS['order-desk']), cbor(0, []), int(DAY),
      cbor(0, [bytes(badChallenge ? h('wrong challenge') : challenge), int(0)]), vendoredAddressData(depositTo), int(HISTORICAL_SINCE + DAY)]));
    const assetAt = (hash: string, ix: number, policy: string, name: string, datum?: string): Row => koiosRow({
      txHash: hash, outputIndex: ix, address: addressOf(policy), assets: { lovelace: 5_000_000n, [`${policy}${name}`]: 1n }, datum,
    }, { is_spent: true });
    historic.push(assetAt(opened, 0, JURY, caseToken, caseDatum), assetAt(challenge, 0, challengePolicy, CHALLENGE_TOKEN),
      assetAt(resolution, 1, VERDICT_POLICY, verdictToken, verdictDatum));
    const status = { type: 'Suspended' as const, holds: [{ by: { type: 'Script' as const, hash: VERDICT_POLICY },
      reason: JURY_HOLD_REASON, since: HISTORICAL_SINCE, until: HISTORICAL_SINCE + DAY + (badRecord ? 1 : 0) }] };
    historic.push(koiosRow({ ...recordUtxo(AGENTS['order-desk'], liveRecord({ status })), txHash: applied, outputIndex: 2 }, { is_spent: true }));
    const mint = (policy_id: string, asset_name: string, quantity: string) => ({ policy_id, asset_name, quantity });
    row(opened, 50, [], { outputs: [juryInput], assets_minted: [mint(JURY, caseToken, '1')] });
    const auditorWins = { constructor: 1, fields: [] };
    row(finalized, 300, [juryInput], { plutus_contracts: [spend(JURY, juryInput, 1, [{ constructor: 2, fields: [auditorWins] }])] });
    const challengeInput = input(CHALLENGE.challenge, challengePolicy);
    row(resolution, 360, [challengeInput], { outputs: [input(VERDICT_REF, VERDICT_POLICY)],
      assets_minted: [mint(VERDICT_POLICY, verdictToken, '1')], plutus_contracts: [spend(challengePolicy, challengeInput, 2, [auditorWins, { bytes: documentHash(resolutionDocument) }])] });
    const prior = input(ref('prior identity record'), MAINNET.identity.hash);
    row(applied, 363, [prior, input(VERDICT_REF, VERDICT_POLICY)], { outputs: [input(HISTORICAL_HOLD, MAINNET.identity.hash)],
      assets_minted: [mint(VERDICT_POLICY, verdictToken, '-1')], plutus_contracts: [spend(MAINNET.identity.hash, prior, 2, [{ constructor: 1, fields: [{ int: 0 }] }])] });
    confirmed.add(resolution);
    confirmed.add(applied);
  }
  // -- the record, the facts, the fault entries
  const record = {
    format: 1, label: s.label, kind: s.kind, date: '2026-12-01', tenant: s.tenant,
    delegations: s.delegations.map((d, i) => ({ id: d.id, tx: h(`delegation tx ${i}`), ended_tx: d.live ? null : h(`delegation end ${i}`) })),
    vaults: s.vaults.map((v, i) => ({ ref: v.utxo === null ? vaultRoot[i]! : `${v.utxo.txHash}#${v.utxo.outputIndex}`, open_tx: h(`vault open ${i}`), close_tx: v.utxo === null ? h(`vault close ${i}`) : null })),
    ...(s.modern === true ? {
      use_case: w.use.name, challenged: s.kind === 'failure' ? 'order-desk' : null, rfq_ids: [],
      approvals: [s.approval, ...s.extraApprovals ?? []].map((a) => ({
        role: 'approval', attestation: a.attestation, tx: a.tx, valid_until: (a.datum as Obj | undefined)?.validUntil ?? CAPTURE_MS + RUN_APPROVAL_VALIDITY_MS,
        revoked_tx: a.revokedTx ?? null, supersedes: a.supersedes ?? null,
      })),
    } : { approval: s.approval.attestation === undefined ? undefined : { attestation: s.approval.attestation, tx: s.approval.tx } }),
    sub_delegations: [{
      id: h('sub delegation'), delegate_tx: h('sub delegate tx'), undelegate_tx: h('sub undelegate tx'),
      ...(s.modern === true ? { subagent: 'stock-reader', hire: s.hires.find((one) => one.role === 'propose')?.step } : {}),
    }],
    hires: entries, refusals: s.kind === 'clean' ? [] : [
      { step: 'r2-a', kind: 'ledger', evaluation_error: 'the vault script failed: the payment is above the limit', transaction_body: 'a1b2c3d4' },
      { step: 'r2-b', kind: 'ledger', evaluation_error: 'the vault script failed: the total is spent', transaction_body: 'a1b2c3d5' },
      { step: 'r2-h', kind: 'ledger', evaluation_error: 'the vault script failed: the delegation is gone', transaction_body: 'a1b2c3d6' },
      { step: 'r2-h', kind: 'tool', message: 'The gateway refused the token request: the delegation was undelegated.' },
    ],
    ...s.record,
  };
  for (const d of record.delegations) { confirmed.add(d.tx); if (d.ended_tx !== null) confirmed.add(d.ended_tx); }
  for (const v of record.vaults) { confirmed.add(v.open_tx); if (v.close_tx !== null) confirmed.add(v.close_tx); }
  confirmed.add(s.approval.tx as string);
  for (const sub of record.sub_delegations) { confirmed.add(sub.delegate_tx); confirmed.add(sub.undelegate_tx); }
  const recordText = JSON.stringify(record, null, 2);
  writeFileSync(join(dir, `${s.label}.json`), recordText);
  const facts = FactsFile.open(join(w.stateDir, 'facts.json'), { useCase: w.use.name, network: 'vector-mainnet' });
  for (const agent of Object.keys(AGENTS)) {
    facts.put('records', [agent], { did: `did:vector:${AGENTS[agent as keyof typeof AGENTS]}`, id: AGENTS[agent as keyof typeof AGENTS], tx: h(`record tx ${agent}`), recordRef: ref(`record ${agent}`), depositLovelace: '10000000', registeredAt: stamp(S0 - 9000) });
    if (s.facts.claims[agent] !== undefined) facts.put('claims', [s.label, agent], s.facts.claims[agent]);
  }
  for (const [agent, models] of Object.entries(s.facts.adverts)) for (const [model, advertRef] of Object.entries(models as Obj)) {
    facts.put('adverts', [agent, model], { ref: advertRef, tx: String(advertRef).slice(0, 64), detailUri: 'https://agent.test/agent.json', detailHash: h('detail'), endpoint: 'https://agent.test', postedAt: stamp(S0 - 5000) });
  }
  if (s.facts.tenant !== null) facts.put('tenants', [s.label], { name: s.facts.tenant, createdAt: stamp(S0 - 4000), seedKind: 'default' });
  if (s.facts.holds !== null) facts.put('holds', [s.label], s.facts.holds);
  for (const claim of Object.values(s.facts.claims) as Obj[]) { confirmed.add(claim.documentTx as string); confirmed.add(claim.claimTx as string); }
  if (s.facts.holds !== null) { confirmed.add(s.facts.holds.suspendTx as string); confirmed.add(s.facts.holds.liftTx as string); }
  if (s.faultEntries !== null || s.kind !== undefined) {
    const entriesOfFile = s.faultEntries ?? goodFaultEntries(s.kind);
    writeFileSync(join(w.stateDir, `fault.${s.label}.evidence.json`), JSON.stringify({ format: 1, check: 'fault', network: 'vector-mainnet', record: `${w.use.name}:${s.label}`, started_at: stamp(S0), entries: entriesOfFile }), { mode: 0o600 });
  }
  for (const row of s.indexed) for (const point of [row.opened, row.finalized, row.closed] as Array<Obj | null>) if (point !== null) confirmed.add(point.tx as string);
  for (const hash of s.unconfirmed) confirmed.delete(hash);
  // -- the fakes
  const ledger = ledgerWorld(utxos, { txs: rows, utxoInfo: [...posted, ...historic] });
  const calls: Outcome['calls'] = [];
  const mock = (url: string): Response => {
    if (s.mockStatus !== 200) return new Response('{"error":"internal"}', { status: s.mockStatus });
    if (url.endsWith('/log')) return new Response(JSON.stringify({ tenant: s.tenant, dropped: s.dropped, lines: s.log }), { status: 200 });
    return new Response(JSON.stringify({ tenant: s.tenant, po_store: { orders: Array.from({ length: s.poOrders }, (_, i) => ({ record_id: `r${i}` })) }, supplier: { catalogue: [], orders: Array.from({ length: s.supplierOrders }, (_, i) => ({ order_id: `o${i}` })) } }), { status: 200 });
  };
  const indexer = (url: string): Response => {
    if (s.indexerStatus !== 200) return new Response('{"error":"internal"}', { status: s.indexerStatus });
    const wanted = new URL(url).searchParams.get('challenge');
    const body = s.indexerBody ?? { chain_time: stamp(S0 + 3 * 3600), cases: s.indexed.filter((one) => wanted === null || one.challenge === wanted) };
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status: 200 });
  };
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)) });
    if (url.startsWith(MOCK_PUBLIC_BASE)) return mock(url);
    if (url.includes('/jury/cases')) return indexer(url);
    if (new URL(url).pathname.endsWith('/lineage')) {
      const original = decodeURIComponent(new URL(url).pathname.split('/')[2] ?? '');
      const cameFrom = s.hires.find((one) => escrowOf(one.step) === original);
      if (cameFrom === undefined) return Response.json({ error: 'not indexed' }, { status: 404 });
      const submission = `${txOf(s.receiptDiscovery === 'wrong_escrow' ? 'execute-c' : cameFrom.step, 'submit')}#0`;
      const rows = s.receiptDiscovery === 'missing' ? [] : [{ state: 'Submitted', utxo_ref: submission }];
      const terminal = cameFrom.step !== 'order-desk-c' || s.release === 'missing' ? null : { type: 'ReleaseEscrow', tx_hash: txOf(cameFrom.step, 'release') };
      return Response.json({ original_ref: original, rows, terminal });
    }
    if (new URL(url).pathname.endsWith('/tx_metadata') && typeof init?.body === 'string') {
      const query: { _tx_hashes: string[] } = JSON.parse(init.body);
      return Response.json(query._tx_hashes.flatMap((tx_hash) => metadata.has(tx_hash) ? [{ tx_hash, metadata: { '22084': metadata.get(tx_hash) } }] : []));
    }
    if (new URL(url).origin === KOIOS) return ledger.koios.f(url, init);
    throw new Error('an unexpected request');
  }) as typeof fetch;
  const node = new ScriptedNode(w.world);
  node.clock = w.clock;
  node.script.length = 0;
  Object.defineProperty(node, 'txStatus', { value: async (hash: string) => ({ confirmations: confirmed.has(hash) ? 5 : null }) });
  const cases = over.cases ?? (s.kind === 'failure' && s.cases.length === 0 ? [] : s.cases);
  const hosted = new PackHosted({
    vector_get_jury_cases: () => (s.juryFailed ? { text: 'Failed to read the jury cases: the node is unreachable', isError: true } : { text: `# Module-1 Jury Cases (${cases.length})\n\n\`\`\`json\n${JSON.stringify(cases)}\n\`\`\`` }),
    vector_resolve_did: () => ({ didDocument: {}, didDocumentMetadata: { vectorStatus: { effective: 'Suspended', effectiveReason: 'hold' } } }),
  });
  w.clock.t = over.clockMs ?? CAPTURE_MS + 3 * 3600_000;
  const chain = { provider: ledger.provider, deployment: MAINNET, koiosUrl: KOIOS, fetchImpl, context: async () => { throw new Error('not used'); }, liveVaultsOf: async () => [] };
  const exit = await runTask(over.task ?? evidence, argv, w.deps({ chain, node, fetchImpl, hosted: {
    call(name, args) {
      if (name !== 'test_evidence_read') return hosted.call(name, args);
      expect(args).toEqual({});
      return Promise.resolve({ json: { confirmed: h('module read') }, text: '', failed: false, message: '' });
    },
  } }));
  const read = (name: string): string | null => { const path = join(w.stateDir, name); return existsSync(path) ? readFileSync(path, 'utf8') : null; };
  void vaults;
  return { exit, out: w.screen.text, err: w.screen.errorText, machine: w.machine(), stateDir: w.stateDir, world: w, recordText, read, calls };
}

const kind = (s: Scenario): 'clean' | 'failure' => s.kind;
const publicFile = (name = '2026-12-01-reorder-agent-run-1.json'): string => `evidence/${name}`;

/** A failure run whose jury has decided: the case is listed with its verdict, and the Order Desk holds. */
function decided(over: Obj = {}, hold: 'held' | 'none' = 'held'): Scenario {
  const s = scenario('failure');
  s.cases = [caseRow(over)];
  s.deskHold = hold;
  return s;
}

const TALLIES: Record<string, Obj> = {
  ClaimerWins: { ClaimerWins: 3, AuditorWins: 0, Inconclusive: 0 }, AuditorWins: { ClaimerWins: 0, AuditorWins: 3, Inconclusive: 0 }, Inconclusive: { ClaimerWins: 1, AuditorWins: 1, Inconclusive: 1 },
};

/** A row of the list of the marketplace indexer for the case of the challenge: a case that the relay opened with no fee, so its Finalize burned the token (the closing transaction is the Finalize). */
function indexedRow(result = 'AuditorWins', over: Obj = {}): Obj {
  const final = { slot: 200, height: 20, time: stamp(S0 + 5 * 3600) };
  return {
    deployment: 'jury', script_hash: 'ab'.repeat(28), case: h('case token'), canonical: true, challenge: CHALLENGE_TOKEN, claim: CLAIM_TOKEN('order-desk'),
    challenge_out: CHALLENGE.challenge, claim_out: `${CHALLENGE.challenge.slice(0, 64)}#1`, genuine_challenge: true, window: 'ended', state: 'closed', fee_lovelace: '0', share_lovelace: null,
    tally: TALLIES[result], revealed: 3, result, opened: { tx: h('case open tx'), slot: 100, height: 10, time: stamp(S0 + 50 * 60) },
    finalized: { tx: h('case finalize tx'), ...final, result }, closed: { tx: h('case finalize tx'), ...final }, ref: null, ...over,
  };
}

/** A failure run whose case the relay opened with no fee: the hosted tool lists no case, the indexer shows the closed case, and the node shows the hold of the Order Desk (when `hold` says so). */
function closedCase(result = 'AuditorWins', hold: 'held' | 'none' = 'held', over: Obj = {}): Scenario {
  const s = scenario('failure');
  s.indexed = [indexedRow(result, over)];
  s.deskHold = hold;
  return s;
}

describe('the golden files', () => {
  it('writes the evidence of a complete clean run, equal to its golden file, with mode 600 in a folder with mode 700', async () => {
    const s = scenario('clean');
    s.modern = true;
    const r = await go(s);
    expect(r.err).toBe('');
    expect(r.exit).toBe(0);
    const text = r.read(publicFile());
    expect(text).not.toBeNull();
    expect(text).toBe(readFileSync(GOLDEN('clean'), 'utf8'));
    expect(statSync(join(r.stateDir, publicFile())).mode & 0o777).toBe(0o600);
    expect(statSync(join(r.stateDir, 'evidence')).mode & 0o777).toBe(0o700);
    const sha = createHash('sha256').update(text!, 'utf8').digest('hex');
    expect(r.out).toContain(`evidence/2026-12-01-reorder-agent-run-1.json`);
    expect(r.out).toContain(sha);
    expect(r.machine.exit).toBe(0);
    expect(r.machine.result).toEqual({ file: publicFile(), bytes: Buffer.byteLength(text!, 'utf8'), sha256: sha, audience: 'public' });
  });

  it('writes the evidence of a complete failure run, equal to its golden file', async () => {
    const s = closedCase();
    s.modern = true;
    const r = await go(s);
    expect(r.err).toBe('');
    expect(r.exit).toBe(0);
    const text = r.read(publicFile());
    expect(text).toBe(readFileSync(GOLDEN('failure'), 'utf8'));
    const doc = JSON.parse(text!) as Obj;
    expect(doc.run).toBe('use-case-1-failure');
    expect((doc.case as Obj).verdict).toBe('AuditorWins');
    expect(((doc.case as Obj).hold as Obj).reason).toBe(JURY_HOLD_REASON);
    expect(((doc.case as Obj).indexed as Obj).finalized_tx).toBe(h('case finalize tx'));
    expect((doc.case as Obj).live).toBeNull();
    expect((doc.steps as Array<{ id: string; refs: Array<{ kind: string }> }>).find((step) => step.id === 'r2-d')!.refs.map((one) => one.kind)).toEqual(['case', 'transaction', 'hold']);
    expect(doc.exit_state).toBe('Cancelled');
    expect((doc.fault_mode as Obj).order_desk).toBe('confirm_wrong_lot');
  });

  it('gives the members in the order of the design, the explorer links, and the steps in the shape that the results page reads', async () => {
    const r = await go(scenario('clean'));
    const doc = JSON.parse(r.read(publicFile())!) as Obj;
    expect(Object.keys(doc)).toEqual([
      'run', 'kind', 'date', 'capability_id', 'builder', 'advert_ref', 'escrow_ref', 'post_tx', 'accept_tx', 'explorer', 'verdict', 'checks', 'receipt', 'receipt_signature', 'result_sha256', 'result',
      'hires', 'delegation', 'vault', 'approval', 'sub_delegations', 'mock', 'decisions', 'claims', 'challenge', 'case', 'fault_mode', 'exit_state', 'steps', 'refusals',
    ]);
    expect(doc.explorer).toEqual({ post: `${EXPLORER_TX}${doc.post_tx}`, accept: `${EXPLORER_TX}${doc.accept_tx}` });
    expect(doc.run).toBe('use-case-1-clean');
    expect(doc.capability_id).toBe(data.agents.find((agent) => agent.kind === 'reorder-agent')!.capability);
    expect(doc.builder).toBe('https://mcp.vector.mainnet.apexfusion.org/mcp');
    expect(doc.result_sha256).toBe(createHash('sha256').update(doc.result as string, 'utf8').digest('hex'));
    const steps = doc.steps as Array<{ id: string; status: string; refs: Array<{ kind: string; value: string }>; note: string }>;
    expect(steps.map((step) => step.id)).toEqual(data.evidenceSteps.filter((step) => step.run !== 'failure').map((step) => step.id));
    for (const step of steps) {
      expect(Object.keys(step)).toEqual(['id', 'status', 'refs', 'note']);
      expect(step.status).toBe('shown');
      expect(step.refs.length).toBeGreaterThan(0);
      for (const one of step.refs) {
        expect(Object.keys(one)).toEqual(['kind', 'value']);
        expect(one.value).toMatch(/^[A-Za-z0-9._:#/-]{1,200}$/);
        if (one.kind === 'transaction') expect(one.value).toMatch(/^[0-9a-f]{64}$/);
      }
    }
  });

  it('writes a private file with the same content and the member audience at the end, and no number', async () => {
    const pub = JSON.parse((await go(scenario('clean'))).read(publicFile())!) as Obj;
    const r = await go(scenario('clean'), ['run', '--run', 'c1', '--private']);
    expect(r.exit).toBe(0);
    const text = r.read('evidence/private/c1.json')!;
    const doc = JSON.parse(text) as Obj;
    expect(Object.keys(doc).at(-1)).toBe('audience');
    expect(doc).toEqual({ ...pub, audience: 'private' });
    expect(r.read(publicFile())).toBeNull();
    expect(statSync(join(r.stateDir, 'evidence/private/c1.json')).mode & 0o777).toBe(0o600);
    expect(statSync(join(r.stateDir, 'evidence/private')).mode & 0o777).toBe(0o700);
    expect(r.machine.result.audience).toBe('private');
  });

  it('keeps the rule table of the steps equal to the steps of the data', () => {
    expect(new Set(ruleStepIds(data.name))).toEqual(new Set(data.evidenceSteps.filter((step) => step.run === 'both' || inventory.runKinds.includes(step.run)).map((step) => step.id)));
    expect(evidenceModuleOf(data.name)).toBe(inventory);
    expect(() => evidenceModuleOf('unregistered')).toThrow('no evidence module');
    expect(() => evidenceModuleOf('constructor')).toThrow('no evidence module');
  });

  it('keeps the three schemas of the results equal to the schemas of the kit', () => {
    expect([PROPOSAL_SCHEMA, RESULT_SCHEMA, CONFIRMATION_SCHEMA]).toEqual([KIT_PROPOSAL, KIT_RESULT, KIT_CONFIRMATION]);
  });

  it('uses files written in the first record shape without rewriting them, and emits the same two goldens', async () => {
    for (const input of [scenario('clean'), closedCase()]) {
      const r = await go(input);
      expect(r.err).toBe('');
      expect(r.exit).toBe(0);
      expect(r.read(publicFile())).toBe(readFileSync(GOLDEN(input.kind), 'utf8'));
      expect(r.read(`runs/${input.label}.json`)).toBe(r.recordText);
      const old = JSON.parse(r.read(`runs/${input.label}.json`)!) as Obj;
      expect(old).toHaveProperty('approval');
      expect(old).not.toHaveProperty('approvals');
      expect(old).not.toHaveProperty('use_case');
    }
  });

  it('checks the actual issuance block of the old approval even within the datum clock allowance', async () => {
    const s = scenario('clean');
    s.approval.issueMinute = 31;
    await refuses(s, ['approval.tx: the attestation is issued after the hire']);
  });
});

const TEST_USE = 'fixture-evidence';
const testUse = (evidenceSteps: UseCase['evidenceSteps']): Partial<UseCase> => ({
  name: TEST_USE, agents: [...data.agents].reverse(), evidenceSteps,
});

const testModule: EvidenceModule = {
  ...inventory,
  readLegacy: false,
  allowApprovalStateOnly: false,
  approvalCounterparty: undefined,
  reportOptional: [],
  carriedOf: (hires) => lastHire(hires, 'execute')?.entry ?? null,
  challengeOf: () => null,
  holdOf: () => { throw new Error('a run without a challenge must not read a hold'); },
  faultProblems: () => [],
  hosted: ['test_evidence_read'],
  async prepare(session) {
    const reply = await session.hosted.call('test_evidence_read', {});
    if (reply.failed || typeof reply.json?.confirmed !== 'string') throw new Error('the test source cannot be read');
    return { confirmed: reply.json.confirmed };
  },
  moduleDocument: (a) => ({
    run: `fixture-${a.loaded.record.kind}`,
    state_at_hire: a.approvalStates.map((entry) => entry === null ? null : { state: entry.state, checked_at: entry.checked_at, hire: entry.hire, link: entry.link }),
  }),
};

const testStep = { id: 'checked', run: 'both', what: 'check the source', primitive: 'test', actor: 'operator' } as const;
const secondStep = { ...testStep, id: 'terminal' };

describe('modules of the evidence task', () => {
  it('reads a registered module, uses its async read before the rules, and takes the last execute without a handoff', async () => {
    const task = createEvidenceTask({ [TEST_USE]: {
      ...testModule,
      rules: {
        checked: (a) => a.extra.confirmed === h('module read') ? [evidenceRef('transaction', a.loaded.carried!.entry.post_tx)] : 'no source was read',
        terminal: (a) => [evidenceRef('escrow', a.loaded.carried!.entry.escrow_ref)],
      },
    } });
    expect(task.needs.hosted).toEqual(['vector_get_jury_cases', 'vector_resolve_did', 'test_evidence_read']);
    const s = scenario('clean');
    s.modern = true;
    s.hires[1]!.result.handoff = null;
    s.record = { approvals: [] };
    s.hires.push(hire('execute-last', 'execute', 60, { ...vaultRefused(s.digest, 'Cancelled'), exit_state: 'Cancelled' }));
    const r = await go(s, undefined, { use: testUse([testStep, secondStep]), task });
    expect(r.err).toBe('');
    expect(r.exit).toBe(0);
    const doc = JSON.parse(r.read(publicFile())!) as Obj;
    expect(doc).toMatchObject({ post_tx: txOf('execute-last', 'post'), exit_state: 'Cancelled', challenge: null, case: null });
    expect(doc.steps).toEqual([
      { id: 'checked', status: 'shown', refs: [evidenceRef('transaction', txOf('execute-last', 'post'))], note: '' },
      { id: 'terminal', status: 'shown', refs: [evidenceRef('escrow', escrowOf('execute-last'))], note: '' },
    ]);
    expect(r.calls.some(({ url }) => url.includes('/jury/cases'))).toBe(false);
  });

  it('does not turn a failed source, a missing rule, or a malformed reference into an evidence file', async () => {
    const s = scenario('failure');
    s.modern = true;
    s.record = { approvals: [], challenged: null };
    const scenarios = [
      [{ ...testModule, rules: {} }, 'no rule for the step'],
      [{ ...testModule, rules: { checked: () => [{ kind: 'transaction', value: 'a free text' }] } }, 'not in their required form'],
      [{ ...testModule, rules: { checked: () => [evidenceRef('transaction', h('ref'))] }, async prepare() { throw new Error('synthetic failed read'); } }, 'prepare.read_failed'],
    ] as const;
    for (const [module, message] of scenarios) {
      const r = await go(s, undefined, { use: testUse([testStep]), task: createEvidenceTask({ [TEST_USE]: module }) });
      expect(r.exit).toBe(2);
      expect(r.err).toContain(message);
      expect(r.read(publicFile())).toBeNull();
    }
  });

  it('reads the case and the record hold of the agent that the module names, not the counterparty', async () => {
    const s = closedCase('AuditorWins', 'held', { claim: CLAIM_TOKEN('reorder-agent') });
    s.modern = true;
    s.holdAgent = 'reorder-agent';
    s.record = { approvals: [], challenged: 'reorder-agent' };
    const module: EvidenceModule = {
      ...testModule,
      challengeOf: () => ({ agent: 'reorder-agent', claim: `${h('claim tx reorder-agent')}#0`, ...CHALLENGE }),
      holdOf: (_a, source) => source.readRecordHold(),
      rules: { checked: (a) => a.caseRead?.hold === null || a.caseRead === null ? 'no hold' : [evidenceRef('hold', a.caseRead.hold.record_output)] },
    };
    const use = testUse([testStep]);
    const task = createEvidenceTask({ [TEST_USE]: module });
    const r = await go(s, undefined, { use, task });
    expect(r.err).toBe('');
    expect(r.exit).toBe(0);
    expect(JSON.parse(r.read(publicFile())!)).toMatchObject({ case: { hold: { record_output: ref('reorder agent record output') } } });
    s.record.challenged = 'order-desk';
    const wrong = await go(s, undefined, { use, task });
    expect(wrong.exit).toBe(2);
    expect(wrong.err).toContain('does not match the named challenged agent');
    expect(wrong.read(publicFile())).toBeNull();
    s.record.challenged = 'reorder-agent';
    const badHook = createEvidenceTask({ [TEST_USE]: { ...module, holdOf() { throw new Error('hold source unavailable'); } } });
    const failed = await go(s, undefined, { use, task: badHook });
    expect(failed.exit).toBe(2);
    expect(failed.err).toContain('hold.read_failed');
    expect(failed.read(publicFile())).toBeNull();
  });

  it('uses a historical hold from the module without requiring a hold on the current record', async () => {
    const s = closedCase('AuditorWins', 'none');
    s.modern = true;
    s.record = { approvals: [] };
    s.historicalHold = {};
    let giveVerdictRef = true;
    const task = createEvidenceTask({ [TEST_USE]: {
      ...testModule,
      challengeOf: (a) => ({ agent: 'order-desk', claim: a.facts.claims[s.label]!['order-desk']!.claimRef, ...CHALLENGE }),
      holdOf: () => ({
        reason: JURY_HOLD_REASON, since: HISTORICAL_SINCE, until: HISTORICAL_SINCE + DAY,
        record_output: HISTORICAL_HOLD, gateway_status: null, ...(giveVerdictRef ? { verdict_output: VERDICT_REF } : {}),
      }),
      rules: { checked: (a) => a.caseRead?.hold?.record_output === HISTORICAL_HOLD ? [evidenceRef('hold', HISTORICAL_HOLD)] : 'no historical hold' },
    } });
    const r = await go(s, undefined, { use: testUse([testStep]), task });
    expect(r.err).toBe('');
    expect(r.exit).toBe(0);
    expect(JSON.parse(r.read(publicFile())!)).toMatchObject({ case: { hold: { record_output: HISTORICAL_HOLD } } });
    giveVerdictRef = false;
    expect((await go(s, undefined, { use: testUse([testStep]), task })).err).toContain('historical hold has no verified link');
    giveVerdictRef = true;
    for (const [bad, message] of [
      [{ badCase: true }, 'case, jury or challenge identity differs'],
      [{ badChallenge: true }, 'verdict output does not authorize a hold'],
      [{ badRecord: true }, 'does not show this exact record hold'],
      [{ badDocument: true }, 'committed resolution document names a different jury, case or challenge'],
    ] as const) {
      s.historicalHold = bad;
      const refused = await go(s, undefined, { use: testUse([testStep]), task });
      expect(refused.exit).toBe(2);
      expect(refused.err).toContain(message);
      expect(refused.read(publicFile())).toBeNull();
    }
    s.historicalHold = {};
    s.unconfirmed.add(HISTORICAL_HOLD.slice(0, 64));
    expect((await go(s, undefined, { use: testUse([testStep]), task })).err).toContain('hold.read_failed: the transaction has no confirmation');
  });

  it('does not combine matching verdict text from different case, jury or challenge identities', async () => {
    for (const [over, message] of [
      [{ case_token: h('other case') }, 'different case or jury identities'],
      [{ jury: 'f0'.repeat(28) }, 'different case or jury identities'],
      [{ challenge: h('different challenge') }, 'different challenge token'],
    ] as const) {
      const s = closedCase();
      s.cases = [caseRow(over)];
      await refuses(s, [message]);
    }
  });

  it('shows only a successful Release of the right escrow after the accept window', async () => {
    const s = closedCase();
    const step = (r: Outcome) => {
      const doc: { steps: Obj[] } = JSON.parse(r.read(publicFile())!);
      return doc.steps.find((row) => row.id === 'r2-e');
    };
    expect(step(await go(s))).toMatchObject({ status: 'shown' });
    s.release = 'missing';
    expect(step(await go(s))).toMatchObject({ status: 'not_run', note: 'the terminal release of the Order Desk escrow is unproven', refs: [] });
    for (const mode of ['false_label', 'early', 'failed'] as const) {
      s.release = mode;
      const message = { false_label: 'successful Release', early: 'before the end of the accept window', failed: 'does not show successful script validation' }[mode];
      await refuses(s, [message]);
    }
    delete s.release;
    s.unconfirmed.add(txOf('order-desk-c', 'release'));
    await refuses(s, ['transaction has no confirmation']);
  });

  it('requires the no-report hire to have a confirmed reclaim to the vault and not a receipt', async () => {
    const s = scenario('failure');
    s.modern = true;
    s.record = { approvals: [], challenged: null };
    const desk = s.hires.find((one) => one.step === 'order-desk-c')!;
    const reclaim = txOf(desk.step, 'reclaim');
    desk.entryOver = { report_file: null, reclaim_tx: reclaim };
    const task = createEvidenceTask({ [TEST_USE]: {
      ...testModule, reportOptional: ['order-desk'],
      rules: { checked: (a) => {
        const hire = a.loaded.hires.find((one) => one.entry.step === desk.step);
        const proof = hire === undefined ? undefined : a.terminals.get(hire.entry.escrow_ref);
        return hire?.report === null && proof?.action === 'Reclaim'
          ? [evidenceRef('transaction', reclaim), ...proof.refund_outputs.map((ref) => evidenceRef('vault', ref))]
          : 'no proved refund';
      } },
    } });
    const opts = { use: testUse([testStep]), task };
    const r = await go(s, undefined, opts);
    expect(r.err).toBe('');
    expect(r.exit).toBe(0);
    expect(r.read(`runs/${s.label}/${desk.step}.report.json`)).toBeNull();
    expect(JSON.parse(r.read(publicFile())!)).toMatchObject({ hires: expect.arrayContaining([expect.objectContaining({ step: desk.step, verdict: null, result_sha256: null })]) });
    s.reclaimToWallet = true;
    const refused = await go(s, undefined, opts);
    expect(refused.exit).toBe(2);
    expect(refused.err).toContain('the matching vault outputs do not show the full escrow value');
    expect(refused.read(publicFile())).toBeNull();
    s.reclaimToWallet = false;
    s.reclaimShort = true;
    expect((await go(s, undefined, opts)).err).toContain('the matching vault outputs do not show the full escrow value');
    s.reclaimShort = false;
    s.reclaimWrongOwner = true;
    expect((await go(s, undefined, opts)).err).toContain('the matching vault outputs do not show the full escrow value');
    s.reclaimWrongOwner = false;
    s.reclaimParts = [{ value: 2_400_000n }, { value: 2_200_000n, token: 3n }];
    const split = await go(s, undefined, opts);
    expect(split.err).toBe('');
    expect(split.exit).toBe(0);
    expect(JSON.parse(split.read(publicFile())!)).toMatchObject({ steps: [{ id: 'checked', status: 'shown', refs: [
      evidenceRef('transaction', reclaim), evidenceRef('vault', `${reclaim}#0`), evidenceRef('vault', `${reclaim}#1`),
    ] }] });
    s.reclaimParts = [{ value: 2_400_000n, token: 1n }, { value: 2_250_000n, token: 2n }];
    s.reclaimFlow = { wallet: 'owner', inputToken: 1n, changeToken: 1n, changeValue: 4_700_000n };
    const splitToken = await go(s, undefined, opts);
    expect(splitToken.exit).toBe(0);
    expect(JSON.parse(splitToken.read(publicFile())!)).toMatchObject({ steps: [{ id: 'checked', status: 'shown', refs: [
      evidenceRef('transaction', reclaim), evidenceRef('vault', `${reclaim}#0`), evidenceRef('vault', `${reclaim}#1`),
    ] }] });
    // The gross refund is complete, but the ledger does not show whose outflow funded it.
    for (const [funding, refund, message] of [
      [{ changeElsewhere: true }, s.reclaimParts, 'neither a matching refund nor change'],
      [{ wallet: 'owner', inputToken: 1n }, [{ value: 4_600_000n, token: 4n }], 'does not match its change'],
      [{ wallet: 'vault' }, [{ value: 4_600_000n, token: 3n }], 'another regular input is a script output'],
      [{ fee: null }, [{ value: 4_600_000n, token: 3n }], 'the fee or mint is not accounted for'],
      [{ fee: '250001' }, [{ value: 4_600_000n, token: 3n }], 'the other inputs do not fund the actual fee'],
      [{ missingInput: true }, [{ value: 4_600_000n, token: 3n }], 'the exact regular inputs and outputs cannot be read'],
      [{ changeValue: 4_749_999n }, [{ value: 4_600_000n, token: 3n }], 'the net vault return does not equal the escrow input'],
    ] satisfies Array<[ReclaimFlow, RefundPart[], string]>) {
      s.reclaimFlow = funding;
      s.reclaimParts = refund;
      const unclear = await go(s, undefined, opts);
      expect(unclear.exit).toBe(2);
      expect(unclear.err).toContain('the full escrow return is unproven:');
      expect(unclear.err).toContain(message);
      expect(unclear.read(publicFile())).toBeNull();
    }
    delete s.reclaimFlow;
    s.reclaimParts = [{ value: 2_400_000n }, { value: 2_200_000n, token: 3n }];
    for (const partial of [{ token: 2n }, { otherToken: true }, { wrongOwner: true }, { value: 2_199_999n }]) {
      s.reclaimParts[1] = { value: 2_200_000n, token: 3n, ...partial };
      const bad = await go(s, undefined, opts);
      expect(bad.exit).toBe(2);
      expect(bad.err).toContain('the matching vault outputs do not show the full escrow value');
      expect(bad.read(publicFile())).toBeNull();
    }
  });

  it('judges two approvals at the blocks of their own hires and fails closed on a false revoke or expiry', async () => {
    const s = scenario('failure');
    s.modern = true;
    s.record.challenged = null;
    const revoked = h('revoked approval tx');
    Object.assign(s.approval, { revokedTx: revoked, datum: { status: { type: 'AttRevoked', at: CAPTURE_MS + 60_000, reason: 1 } } });
    const other = { attestation: h('other approval'), tx: h('other approval tx'),
      supersedes: s.approval.attestation, datum: { validUntil: CAPTURE_MS + 20 * 60_000, links: [{ rel: 0, target: s.approval.attestation }] } };
    s.extraApprovals = [other];
    const proposal = makeProposal({ marker: 'private fixture text' }, h('approval source salt'));
    if (!proposal.ok) throw new Error('invalid fixture proposal');
    s.digest = proposal.value.proposal_digest;
    for (const [step, entry] of [['execute-a', s.approval], ['execute-c', other]] as const) {
      const one = s.hires.find((hire) => hire.step === step)!;
      one.request = { committed: ` ${JSON.stringify({ op: 'execute', authority: { principal_did: DID(APPROVAL_ISSUER), delegation: s.delegations[0]!.id },
        tenant: s.tenant, proposal: proposal.value, approval: { attestation: entry.attestation, issuer_did: DID(APPROVAL_ISSUER) } })}\n` };
      entry.datum = { ...entry.datum as Obj, issuerId: APPROVAL_ISSUER };
    }
    const module: EvidenceModule = {
      ...testModule, hireOfApproval: (_a, i) => i === 0 ? 'execute-a' : 'execute-c',
      approvalExpectations: () => ({}), rules: { checked: (a) => a.approvalStates.every((one) => one !== null) ? [evidenceRef('transaction', a.approvalStates[0]!.entry.tx)] : 'unchecked approval' },
    };
    const opts = { use: testUse([testStep]), task: createEvidenceTask({ [TEST_USE]: module }) };
    const r = await go(s, undefined, opts);
    expect(r.err).toBe('');
    expect(r.exit).toBe(0);
    expect(JSON.parse(r.read(publicFile())!)).toMatchObject({ state_at_hire: [
      { state: 'revoked', checked_at: CAPTURE_MS + 5 * 60_000, hire: 'execute-a', link: 'request' },
      { state: 'expired', checked_at: CAPTURE_MS + 40 * 60_000, hire: 'execute-c', link: 'request' },
    ] });
    expect(r.read(publicFile())).not.toContain('private fixture text');
    const first = s.hires.find((hire) => hire.step === 'execute-a')!;
    const exact = first.request!;
    first.request = { ...exact, saved: exact.committed.trim() };
    expect((await go(s, undefined, opts)).err).toContain('request text does not match the escrow prompt hash');
    first.request = { ...exact, mode: 0o644 };
    expect((await go(s, undefined, opts)).err).toContain('bounded private file');
    first.request = { ...exact, link: true };
    expect((await go(s, undefined, opts)).err).toContain('exact request file cannot be opened');
    delete first.request;
    expect((await go(s, undefined, opts)).err).toContain('approval use is unproven');
    first.request = s.hires.find((hire) => hire.step === 'execute-c')!.request;
    expect((await go(s, undefined, opts)).err).toContain('the committed request names no approval or a different approval');
    first.request = exact;
    s.unconfirmed.add(revoked);
    const unread = await go(s, undefined, opts);
    expect(unread.exit).toBe(2);
    expect(unread.err).toContain('approvals[0].revoked_tx');
    expect(unread.read(publicFile())).toBeNull();
    s.unconfirmed.clear();
    s.approval.revokeIndex = 3;
    const wrongInput = await go(s, undefined, opts);
    expect(wrongInput.exit).toBe(2);
    expect(wrongInput.err).toContain('does not spend the output of this attestation');
    expect(wrongInput.read(publicFile())).toBeNull();
    delete s.approval.revokeIndex;
    s.approval.issueMinute = 6;
    const late = await go(s, undefined, opts);
    expect(late.exit).toBe(2);
    expect(late.err).toContain('approvals[0].tx: the attestation is issued after the hire');
    expect(late.read(publicFile())).toBeNull();
    delete s.approval.issueMinute;
    s.record.approvals = [
      { role: 'approval', attestation: s.approval.attestation, tx: s.approval.tx, valid_until: CAPTURE_MS + RUN_APPROVAL_VALIDITY_MS, revoked_tx: null, supersedes: null },
      { role: 'approval', attestation: other.attestation, tx: other.tx, valid_until: CAPTURE_MS + RUN_APPROVAL_VALIDITY_MS, revoked_tx: null, supersedes: s.approval.attestation },
    ];
    const wrong = await go(s, undefined, opts);
    expect(wrong.exit).toBe(2);
    expect(wrong.err).toContain('the approval is revoked at its hire, not active');
    expect(wrong.err).toContain('the approval is expired at its hire, not active');
    expect(wrong.read(publicFile())).toBeNull();
  });

  it('passes every fault value to the module and requires one start for every service in each entry', async () => {
    const s = scenario('failure');
    s.modern = true;
    s.record = { approvals: [], challenged: null };
    const mode = 'fixture_fault';
    const second = cleanEntries(S0 + 1900);
    setAt(second, ['shows', 'check'], mode);
    setAt(second, ['shows', 'agent'], 'reorder-agent');
    setAt(second, ['shows', 'services', 0, 'value'], mode);
    s.faultEntries = [...goodFaultEntries('failure'), second];
    const agents = data.agents.map((agent) => agent.id === 'reorder-agent' ? { ...agent, faultValues: [mode] } : agent);
    const use = { ...testUse([testStep]), agents };
    const task = createEvidenceTask({ [TEST_USE]: {
      ...testModule,
      rules: { checked: (a) => [evidenceRef('transaction', a.loaded.carried!.entry.post_tx)] },
      faultProblems: (a) => ['confirm_wrong_lot', mode].every((value) => a.faults.some((entry) => entry.ok && entry.check === value))
        ? [] : [{ member: 'fault_check', detail: 'one fault is absent' }],
    } });
    const r = await go(s, undefined, { use, task });
    expect(r.err).toBe('');
    expect(r.exit).toBe(0);
    setAt(second, ['shows', 'services'], [{ service: 'reorder-service', started_at: stamp(S0), value: mode }]);
    const missing = await go(s, undefined, { use, task });
    expect(missing.exit).toBe(2);
    expect(missing.err).toContain('fault_check.services.orders-service');
    expect(missing.read(publicFile())).toBeNull();
  });

  it('confirms only the named lifecycle facts and names the file for the lifecycle subject', async () => {
    const step = { ...testStep, id: 'wait', run: 'lifecycle' } as const;
    const names = ['recovery-start', 'recovery-complete'];
    const txs = names.map((name) => h(`lifecycle ${name}`));
    const use: Partial<UseCase> = {
      ...testUse([step]), runs: [{ ...data.runs[0]!, id: 'lifecycle' }],
      lifecycle: { agent: 'order-desk', successor: 'successor', controllers: ['first', 'second'], guardians: ['first', 'second'], waitMs: DAY },
    };
    let recordRefs: string[] = [];
    const task = createEvidenceTask({ [TEST_USE]: {
      ...testModule, runKinds: ['lifecycle'],
      lifecycleFacts: { wait: names },
      carriedOf() { throw new Error('a lifecycle run does not read hires'); },
      challengeOf() { throw new Error('a lifecycle run does not read a challenge'); },
      hireOfApproval() { throw new Error('a lifecycle run does not read an approval'); },
      faultProblems() { throw new Error('a lifecycle run does not read faults'); },
      async prepare(_session, a) {
        expect(a.mock).toBeNull();
        expect(a.faults).toEqual([]);
        expect(a.reads.delegations).toEqual([]);
        expect(a.reads.vaults).toEqual([]);
        expect(a.facts.lifecycle.other).toBeUndefined();
        return { checked: names.flatMap((name) => a.facts.lifecycle[name] === undefined ? [] : [a.facts.lifecycle[name]!.tx]) };
      },
      rules: { wait: (a) => [
        ...(a.extra.checked as string[]).map((tx) => evidenceRef('transaction', tx)),
        ...recordRefs.map((ref) => evidenceRef('record', ref)),
      ] },
    } });
    const world = await taskWorld({ use, env: { OPERATOR_USE_CASE: data.name } });
    mkdirSync(join(world.stateDir, 'runs'), { recursive: true, mode: 0o700 });
    const input = (lifecycle: readonly string[]) => JSON.stringify({
      format: 1, label: 'l1', use_case: TEST_USE, kind: 'lifecycle', date: '2026-12-01', tenant: null, challenged: null, rfq_ids: [],
      lifecycle, hires: [], approvals: [], delegations: [], vaults: [], sub_delegations: [], refusals: [],
    });
    const record = join(world.stateDir, 'runs', 'l1.json');
    const facts = FactsFile.open(join(world.stateDir, 'facts.json'), { useCase: TEST_USE, network: 'vector-mainnet' });
    for (const [i, name] of names.entries()) facts.put('lifecycle', [name], { tx: txs[i], at: stamp(S0) });
    facts.put('lifecycle', ['other'], { tx: h('unrelated transaction'), at: stamp(S0) });
    const seen: string[] = [];
    Object.defineProperty(world.node, 'txStatus', { value: async (hash: string) => { seen.push(hash); return { confirmations: txs.includes(hash) ? 3 : null }; } });
    // A completion in the run folder does not make it evidence unless the run names it.
    writeFileSync(record, input(names.slice(0, 1)));
    expect(await world.run(task, 'run', '--run', 'l1', '--number', '1')).toBe(2);
    expect(world.screen.errorText).toContain('does not name every required lifecycle fact');
    expect(seen.splice(0)).toEqual(txs.slice(0, 1));
    writeFileSync(record, input(names));
    recordRefs = [ref('unrelated transaction')];
    expect(await world.run(task, 'run', '--run', 'l1', '--number', '1')).toBe(2);
    expect(world.screen.errorText).toContain('do not show the named, confirmed lifecycle transactions');
    expect(seen.splice(0)).toEqual(txs);
    recordRefs = [];
    const exit = await world.run(task, 'run', '--run', 'l1', '--number', '1');
    expect(exit, world.screen.errorText).toBe(0);
    expect(seen).toEqual(txs);
    const file = join(world.stateDir, publicFile('2026-12-01-order-desk-run-1.json'));
    const doc = JSON.parse(readFileSync(file, 'utf8')) as Obj;
    for (const field of ['hires', 'approval', 'vault', 'mock', 'fault_mode', 'case', 'challenge', 'claims', 'escrow_ref']) expect(doc).not.toHaveProperty(field);
    expect(doc.steps).toEqual([{ id: 'wait', status: 'shown', refs: txs.map((tx) => evidenceRef('transaction', tx)), note: '' }]);
  });
});

describe('the flags', () => {
  const refusals: Array<[string, string[]]> = [
    ['no number for a public file', ['run', '--run', 'c1']],
    ['a number of 0', ['run', '--run', 'c1', '--number', '0']],
    ['a number of 100', ['run', '--run', 'c1', '--number', '100']],
    ['a number that is a word', ['run', '--run', 'c1', '--number', 'one']],
    ['a number with --private', ['run', '--run', 'c1', '--private', '--number', '1']],
    ['no run label', ['run', '--number', '1']],
  ];
  for (const [what, argv] of refusals) {
    it(`refuses ${what} with exit 2, before any read and with no file`, async () => {
      const r = await go(scenario('clean'), argv);
      expect(r.exit).toBe(2);
      expect(r.calls).toHaveLength(0);
      expect(readdirSync(r.stateDir)).not.toContain('evidence');
    });
  }
  it('takes the numbers 1 and 99', async () => {
    expect((await go(scenario('clean'), ['run', '--run', 'c1', '--number', '99'])).exit).toBe(0);
  });
});

/** Runs a broken scenario and checks that it ends with exit 2, names the members, and writes no file. */
async function refuses(s: Scenario, members: string[], argv?: string[]): Promise<Outcome> {
  const r = await go(s, argv);
  expect(r.exit).toBe(2);
  for (const member of members) expect(r.err).toContain(member);
  expect(r.read(publicFile())).toBeNull();
  expect(r.read('evidence/private/' + s.label + '.json')).toBeNull();
  return r;
}

describe('check 1: the record', () => {
  it('refuses a record that does not exist', async () => {
    const r = await go(scenario('clean'), ['run', '--run', 'zz', '--number', '1']);
    expect(r.exit).toBe(2);
    expect(r.err).toContain('the run record cannot be read');
  });
  it('refuses a record whose label is not the label in the name of its file', async () => {
    await refuses(Object.assign(scenario('clean'), { record: { label: 'other' } }), ['label']);
  });
  it('refuses a record whose kind is not a run of the data, and takes it when the data has the run', async () => {
    const refused = await go(scenario('clean'), undefined, { runs: data.runs.filter((run) => run.id === 'failure') });
    expect(refused.exit).toBe(2);
    expect(refused.err).toContain('kind: clean is not a run of the data of the use case');
    expect((await go(scenario('clean'), undefined, { runs: data.runs.filter((run) => run.id === 'clean') })).exit).toBe(0);
  });
  it('refuses a record that breaks its own rules, and names the member', async () => {
    await refuses(Object.assign(scenario('clean'), { record: { tenant: 'A Bad Tenant' } }), ['tenant']);
  });
});

describe('check 2: every transaction is confirmed', () => {
  const targets: Array<[string, (s: Scenario) => string, string]> = [
    ['a delegation transaction', () => h('delegation tx 0'), 'delegations[0].tx'],
    ['the end of a delegation', () => h('delegation end 0'), 'delegations[0].ended_tx'],
    ['the close of a vault', () => h('vault close 0'), 'vaults[0].close_tx'],
    ['the approval transaction', (s) => s.approval.tx as string, 'approval.tx'],
    ['a sub-delegation end', () => h('sub undelegate tx'), 'sub_delegations[0].undelegate_tx'],
    ['the post transaction of a hire', () => txOf('propose', 'post'), 'hires[0].post_tx'],
    ['the accept transaction of a hire', () => txOf('order-desk', 'accept'), 'hires[2].accept_tx'],
    ['the claim transaction of an agent', () => h('claim tx reorder-agent'), 'claims.reorder-agent.claimTx'],
    ['the escrow of a model hire', () => h('model escrow 1'), 'decisions[0].escrow_ref'],
  ];
  for (const [what, hash, member] of targets) {
    it(`refuses ${what} with no confirmation and names ${member}`, async () => {
      const s = scenario('clean');
      s.unconfirmed.add(hash(s));
      await refuses(s, [member]);
    });
  }
  it('refuses the evidence and the challenge of the failure run when they have no confirmation', async () => {
    const s = decided();
    s.unconfirmed.add(CHALLENGE.evidence);
    s.unconfirmed.add(CHALLENGE.challenge.slice(0, 64));
    await refuses(s, ['challenge.evidence', 'challenge.challenge']);
  });
  it('refuses the hold of a party when its transactions have no confirmation', async () => {
    const s = decided();
    s.unconfirmed.add(h('hold suspend tx'));
    await refuses(s, ['holds.suspendTx']);
  });
  it('takes a node that reads each transaction with one confirmation', async () => {
    const r = await go(scenario('clean'));
    expect(r.exit).toBe(0);
  });
});

describe('check 3: the hires', () => {
  it('refuses a result whose SHA-256 is not the response hash of the receipt, and takes the twin', async () => {
    const s = scenario('clean');
    s.hires[0]!.reportOver = { result: `${JSON.stringify(s.hires[0]!.result)} ` };
    await refuses(s, ['hires[0].report_file', 'response_hash']);
    expect((await go(scenario('clean'))).exit).toBe(0);
  });
  it('refuses a receipt that names another escrow', async () => {
    const s = scenario('clean');
    s.hires[0]!.receiptOver = { escrow_ref: ref('another escrow') };
    await refuses(s, ['hires[0].escrow_ref']);
  });
  it('refuses a post transaction that is not the transaction of the escrow', async () => {
    const s = scenario('clean');
    s.hires[0]!.entryOver = { post_tx: h('another post') };
    s.unconfirmed.add(h('another post'));
    await refuses(s, ['hires[0].post_tx']);
  });
  it('refuses a result of another operation than its step, and a result that is no JSON object', async () => {
    const s = scenario('clean');
    s.hires[0]!.result = { ...s.hires[0]!.result, schema: RESULT_SCHEMA };
    await refuses(s, ['hires[0].report_file', 'result is not the result of propose']);
    const t = scenario('clean');
    t.hires[1]!.reportOver = { result: 'not json', receipt: undefined };
    await refuses(t, ['hires[1].report_file']);
  });
  it('refuses an advert that is not the advert of the facts for the agent and the model of the receipt', async () => {
    const s = scenario('clean');
    s.hires[2]!.receiptOver = { model: 'lot-large' };
    await refuses(s, ['hires[2].advert_ref', 'lot-large']);
    const t = scenario('clean');
    t.facts.adverts = { 'reorder-agent': { 'reorder-agent-v1': ref('advert reorder-agent') }, 'order-desk': { 'lot-medium': ref('another advert') } };
    await refuses(t, ['hires[2].advert_ref']);
  });
  it('refuses an accept transaction that does not spend the escrow, by the spend chain of Koios', async () => {
    const s = scenario('clean');
    s.spendOverride.set(txOf('order-desk', 'accept'), `${h('another submit')}#0`);
    s.extraRows.push({ tx_hash: h('another submit'), tx_timestamp: S0 + 3000, inputs: [], outputs: [], plutus_contracts: [] });
    await refuses(s, ['hires[2].accept_tx', 'does not spend the escrow']);
  });
  it('refuses an escrow that is not for the agent of the hire, and one that was posted for another advert', async () => {
    const s = scenario('clean');
    s.hires[0]!.entryOver = { advert_ref: ref('advert order-desk') };
    s.facts.adverts = { 'reorder-agent': { 'reorder-agent-v1': ref('advert order-desk') }, 'order-desk': { 'lot-medium': ref('advert order-desk') } };
    await refuses(s, ['hires[0].advert_ref', 'posted for']);
  });
  it('reads the escrow of each hire from the chain, and names the member when it cannot', async () => {
    const s = scenario('clean');
    s.hires[1]!.entryOver = { escrow_ref: `${txOf('execute', 'post')}#3` };
    s.hires[1]!.receiptOver = { escrow_ref: `${txOf('execute', 'post')}#3` };
    await refuses(s, ['hires[1].escrow_ref']);
  });
  it('refuses a hire whose block time Koios does not know', async () => {
    const s = scenario('clean');
    s.skipKoiosTx.add(txOf('propose', 'post'));
    await refuses(s, ['hires[0]']);
  });
});

describe('check 4: delegations, vaults and the approval', () => {
  it('refuses a delegation that the ledger still holds when its end is recorded, and one that is gone with no end recorded', async () => {
    const s = scenario('clean');
    s.delegations = [{ id: h('delegation c1'), live: true }];
    s.record = { delegations: [{ id: h('delegation c1'), tx: h('delegation tx 0'), ended_tx: h('delegation end 0') }] };
    await refuses(s, ['delegations[0].ended_tx']);
    const t = decided();
    t.record = { delegations: [{ id: h('delegation c'), tx: h('delegation tx 0'), ended_tx: null }, { id: h('delegation h'), tx: h('delegation tx 1'), ended_tx: h('delegation end 1') }] };
    t.delegations = [{ id: h('delegation c'), live: false }, { id: h('delegation h'), live: false }];
    await refuses(t, ['delegations[0].id']);
  });
  it('refuses a sub-delegation that the ledger still holds as live, and takes an ended one', async () => {
    const f = decided();
    f.record = { sub_delegations: [{ id: h('delegation c'), delegate_tx: h('sub delegate tx'), undelegate_tx: h('sub undelegate tx') }] };
    await refuses(f, ['sub_delegations[0].id']);
    expect((await go(decided())).exit).toBe(0);
  });
  it('refuses a vault that is not Live when no close is recorded', async () => {
    const s = decided();
    s.vaults = [{ utxo: null }, { utxo: null }];
    s.record = { vaults: [{ ref: ref('missing vault', 1), open_tx: h('vault open 0'), close_tx: null }, { ref: ref('vault 1', 1), open_tx: h('vault open 1'), close_tx: h('vault close 1') }] };
    await refuses(s, ['vaults[0].ref']);
  });
  it('takes a Live vault and a live delegation in the failure run', async () => {
    expect((await go(decided())).exit).toBe(0);
  });
  const broken: Array<[string, Obj, string]> = [
    ['an attestation of another type', { datum: { attType: 4 } }, 'approval.type'],
    ['an attestation about another subject', { datum: { subject: 'e1'.repeat(32) } }, 'approval.subject'],
    ['an attestation whose digest is not the proposal_digest', { datum: { digest: 'e2'.repeat(32) } }, 'approval.digest'],
    ['an approval that lasts longer than the constant and the slack for the clocks', { datum: { validUntil: CAPTURE_MS + RUN_APPROVAL_VALIDITY_MS + 60_001 } }, 'approval.validity'],
    ['an approval with no end', { datum: { validUntil: null } }, 'approval.validity'],
    ['an approval that ended before the run', { datum: { validUntil: CAPTURE_MS + 60_000 } }, 'approval.attestation'],
  ];
  for (const [what, over, member] of broken) {
    it(`refuses ${what} and names ${member}`, async () => {
      const s = scenario('clean');
      Object.assign(s.approval, over);
      await refuses(s, [member]);
    });
  }
  it('takes an approval that lasts exactly as long as the constant', async () => {
    const s = scenario('clean');
    Object.assign(s.approval, { datum: { validUntil: CAPTURE_MS + RUN_APPROVAL_VALIDITY_MS } });
    expect((await go(s)).exit).toBe(0);
  });
  it('refuses an approval that is not on the ledger', async () => {
    const s = scenario('clean');
    s.approvalVisible = false;
    await refuses(s, ['approval.attestation']);
  });
  it('refuses a run in which no hire of propose holds the digest that the carried order answers', async () => {
    const s = scenario('clean');
    s.hires[0]!.result = proposed(h('another digest'), 1);
    await refuses(s, ['approval.digest']);
  });
});

describe('check 4: each ended or closed entry is tied to its id by a read of its transaction', () => {
  const other = txOf('propose', 'post');
  it('refuses a vault that the node holds as Live when the record says that it is closed, and names the close transaction', async () => {
    const s = scenario('clean');
    const head = vaultUtxo({ type: 'Live', owner: { type: 'PrincipalKey', hash: 'cc'.repeat(28), organisation: null }, delegation: h('delegation c1'), spent: 0n, periodStart: CAPTURE_MS }, 8_300_000n, { txHash: txOf('order-desk', 'post') });
    s.vaults = [{ utxo: head }];
    s.record = { vaults: [{ ref: `${head.txHash}#${head.outputIndex}`, open_tx: h('vault open 0'), close_tx: h('vault close 0') }] };
    await refuses(s, ['vaults[0].close_tx', 'does not spend the vault lineage of ref']);
    expect((await go(decided())).exit).toBe(0);
  });
  it('refuses ids that never existed and the transactions of other steps, and names each member', async () => {
    const s = scenario('clean');
    s.record = {
      delegations: [{ id: h('no such delegation'), tx: other, ended_tx: h('claim tx reorder-agent') }],
      vaults: [{ ref: ref('no such vault', 3), open_tx: other, close_tx: h('claim tx order-desk') }],
      sub_delegations: [{ id: h('no such sub'), delegate_tx: other, undelegate_tx: h('approval tx') }],
      approval: { attestation: h('approval attestation'), tx: other },
    };
    await refuses(s, [
      'delegations[0].tx', 'delegations[0].ended_tx', 'vaults[0].open_tx', 'vaults[0].close_tx', 'sub_delegations[0].delegate_tx', 'sub_delegations[0].undelegate_tx', 'approval.tx',
    ]);
  });
  it('refuses a delegation transaction that does not mint the token of its id, and an end that does not burn it', async () => {
    const noMint = scenario('clean');
    noMint.record = { delegations: [{ id: h('delegation c1'), tx: other, ended_tx: txOf('propose', 'accept') }] };
    await refuses(noMint, ['delegations[0].tx: does not mint', 'delegations[0].ended_tx: does not burn']);
    const swapped = scenario('clean');
    swapped.record = { delegations: [{ id: h('delegation c1'), tx: h('delegation end 0'), ended_tx: h('delegation tx 0') }] };
    await refuses(swapped, ['delegations[0].tx: does not mint', 'delegations[0].ended_tx: does not burn']);
    const another = scenario('clean');
    another.record = { delegations: [{ id: h('delegation c1'), tx: h('sub delegate tx'), ended_tx: h('sub undelegate tx') }] };
    await refuses(another, ['delegations[0].tx: does not mint', 'delegations[0].ended_tx: does not burn']);
  });
  it('refuses a sub-delegation whose transactions mint and burn another token', async () => {
    const s = scenario('clean');
    s.record = { sub_delegations: [{ id: h('sub delegation'), delegate_tx: h('delegation tx 0'), undelegate_tx: h('delegation end 0') }] };
    await refuses(s, ['sub_delegations[0].delegate_tx: does not mint', 'sub_delegations[0].undelegate_tx: does not burn']);
  });
  it('refuses a vault close that spends no output of the lineage of ref, and an open that did not make the lineage', async () => {
    const s = scenario('clean');
    s.record = { vaults: [{ ref: ref('another vault', 0), open_tx: h('vault open 0'), close_tx: h('vault close 0') }] };
    await refuses(s, ['vaults[0].close_tx: does not spend the vault lineage of ref', 'vaults[0].open_tx: is not the transaction that opened']);
    const late = decided();
    late.record = { vaults: [{ ref: `${txOf('order-desk-c', 'post')}#1`, open_tx: txOf('order-desk-c', 'post'), close_tx: null }, { ref: `${h('vault open 1')}#0`, open_tx: h('vault open 1'), close_tx: h('vault close 1') }] };
    await refuses(late, ['vaults[0].open_tx: is not the transaction that opened']);
    const wrong = decided();
    wrong.record = { vaults: [{ ref: `${txOf('order-desk-c', 'post')}#1`, open_tx: h('vault open 1'), close_tx: null }, { ref: `${h('vault open 1')}#0`, open_tx: h('vault open 1'), close_tx: h('vault close 1') }] };
    await refuses(wrong, ['vaults[0].open_tx: is not the transaction that opened']);
  });
  it('refuses a payment of the Order Desk given as the close of the vault: a close leaves no vault output, and the node holds the vault Live at the next output', async () => {
    const s = scenario('clean');
    s.record = { vaults: [{ ref: `${h('vault open 0')}#0`, open_tx: h('vault open 0'), close_tx: txOf('order-desk', 'post') }] };
    await refuses(s, ['vaults[0].close_tx: makes an output at the vault script']);
  });
  it('refuses an approval transaction that is not the transaction of the output that holds the approval', async () => {
    const s = scenario('clean');
    s.record = { approval: { attestation: h('approval attestation'), tx: txOf('propose', 'accept') } };
    await refuses(s, ['approval.tx: is not the transaction of the output']);
  });
  it('says which member Koios does not know when it reads a transaction of the ledger', async () => {
    const s = scenario('clean');
    s.skipKoiosTx.add(h('delegation tx 0'));
    await refuses(s, ['delegations[0].tx: does not mint', 'Koios does not know the transaction']);
  });
});

describe('check 10: the step of the payment from the vault rests on a read of the transaction that made the escrow', () => {
  const stepOf = (doc: Obj, id: string): Obj => (doc.steps as Obj[]).find((one) => one.id === id)!;
  it('refuses a clean run whose Order Desk post spends only a wallet input, although the result says that the vault paid', async () => {
    const s = scenario('clean');
    s.payFromWallet = true;
    expect((s.hires[1]!.result.handoff as Obj).paid_from_vault).toBe(true);
    const r = await refuses(s, ['steps.r1-08', 'the chain does not show the Order Desk hire as paid from the vault', 'is at the vault script']);
    expect(r.err).not.toContain('steps.r1-07');
  });
  it('shows the step from the read of the chain, whatever the result says of its own payment', async () => {
    const s = scenario('clean');
    (s.hires[1]!.result.handoff as Obj).paid_from_vault = false;
    const r = await go(s);
    expect(r.exit).toBe(0);
    const step = stepOf(JSON.parse(r.read(publicFile())!) as Obj, 'r1-08');
    expect(step).toMatchObject({ status: 'shown' });
    expect((step.refs as Array<{ kind: string; value: string }>).map((one) => one.value)).toEqual([txOf('order-desk', 'post'), `${txOf('order-desk', 'post')}#0`]);
  });
  it('reads no payment of the failure run, which has no step that needs it', async () => {
    const s = decided();
    s.payFromWallet = true;
    s.vaults = [
      { utxo: vaultUtxo({ type: 'Live', owner: { type: 'PrincipalKey', hash: 'cc'.repeat(28), organisation: null }, delegation: h('delegation c'), spent: 0n, periodStart: CAPTURE_MS }, 8_300_000n, { txHash: h('vault open 0'), outputIndex: 0 }) },
      { utxo: null },
    ];
    expect((await go(s)).exit).toBe(0);
  });
});

describe('check 3: the receipt of a hire is read against the escrow and the key of the agent', () => {
  it('refuses a receipt that names another supplier than the escrow datum, although a key of the record signed it', async () => {
    const s = scenario('clean');
    s.hires[1]!.receiptOver = { supplier_pkh: 'ff'.repeat(28) };
    await refuses(s, ['hires[1].report_file: receipt.supplier_pkh is not the supplier_pkh of the escrow datum']);
  });
  it('refuses a signature that is not the signature of the supplier over the receipt', async () => {
    const s = scenario('clean');
    s.hires[1]!.reportOver = { receipt_signature: '00'.repeat(64) };
    await refuses(s, ['hires[1].report_file: the check signature_valid of the receipt fails']);
    const other = scenario('clean');
    other.hires[2]!.reportOver = { receipt_signature: SUPPLIERS['reorder-agent'].signMessage(Buffer.from('another text', 'utf8')) };
    await refuses(other, ['hires[2].report_file: the check signature_valid of the receipt fails']);
  });
  it('refuses a receipt when no key of the record of the agent hashes to the supplier of the escrow', async () => {
    const s = scenario('clean');
    s.recordsHoldKeys = false;
    await refuses(s, ['hashes to the supplier_pkh of the escrow, so the signature of the receipt cannot be verified']);
  });
  it('refuses a different, correctly signed receipt for the same settled hire before it checks approval use', async () => {
    const s = scenario('clean');
    s.hires[1]!.submittedReceipt = 'different';
    let approvalReads = 0;
    const task = createEvidenceTask({ [data.name]: { ...inventory, hireOfApproval(a, i) { approvalReads += 1; return inventory.hireOfApproval(a, i); } } });
    const r = await go(s, undefined, { task });
    expect(r.exit).toBe(2);
    expect(r.err).toContain('hires[1].report_file: the check on_chain_hash_matches of the receipt fails');
    expect(approvalReads).toBe(0);
    expect(r.read(publicFile())).toBeNull();
    s.hires[1]!.submittedReceipt = 'different_redeemer';
    await refuses(s, ['the Submit redeemer does not match the receipt commitment of the Submitted datum']);
  });
  it('requires a verified Submitted output even when the run does not name the terminal transaction', async () => {
    const s = closedCase();
    const last = s.hires.find((one) => one.step === 'order-desk-c')!;
    last.submittedReceipt = 'different';
    await refuses(s, ['hires[8].report_file: the check on_chain_hash_matches of the receipt fails']);
    delete last.submittedReceipt;
    s.receiptDiscovery = 'missing';
    await refuses(s, ['hires[8].report_file: the actual Submitted escrow receipt commitment is unproven']);
    s.receiptDiscovery = 'wrong_escrow';
    await refuses(s, ['no input of the transaction descends from escrow_ref by the verified spend chain']);
  });
  it('requires the same receipt commitment and unspent state for the node and Koios views of a live Submitted output', async () => {
    const s = scenario('clean');
    const execute = s.hires.find((one) => one.step === 'execute')!;
    execute.accepted = false;
    execute.liveSubmitted = 'match';
    const good = await go(s);
    expect(good.err).toBe('');
    expect(good.exit).toBe(0);
    for (const mode of ['different', 'spent'] as const) {
      execute.liveSubmitted = mode;
      await refuses(s, ['hires[1].report_file', 'live Submitted receipt commitment differs on the node and in Koios']);
    }
  });
  it('takes receipts that each agent signed with the key that its record lists', async () => {
    const r = await go(scenario('clean'));
    expect(r.exit).toBe(0);
    const doc = JSON.parse(r.read(publicFile())!) as { receipt: Obj; receipt_signature: string };
    expect(doc.receipt.supplier_pkh).toBe(SUPPLIERS['reorder-agent'].keyHash);
    expect(doc.receipt_signature).toMatch(/^[0-9a-f]{128}$/);
  });
});

describe('check 4: the approval may last a little over the constant, for the clocks of the tool and of the member', () => {
  const lastingOver = async (extra: number): Promise<Outcome> => {
    const s = scenario('clean');
    Object.assign(s.approval, { datum: { validUntil: CAPTURE_MS + RUN_APPROVAL_VALIDITY_MS + extra } });
    return go(s);
  };
  it('takes an approval that lasts 1 second over the constant, and one that lasts 60 seconds over it', async () => {
    expect((await lastingOver(1000)).exit).toBe(0);
    expect((await lastingOver(60_000)).exit).toBe(0);
  });
  it('refuses an approval that lasts 60 seconds and 1 millisecond over the constant, and names the slack', async () => {
    const r = await lastingOver(60_001);
    expect(r.exit).toBe(2);
    expect(r.err).toContain('approval.validity');
    expect(r.err).toContain('60000 ms more are allowed');
  });
  it('takes an approval whose start the member set one second after the issue, with an end of 4 hours after that start', async () => {
    const s = scenario('clean');
    Object.assign(s.approval, { datum: { validFrom: CAPTURE_MS + 1000, validUntil: CAPTURE_MS + 1000 + RUN_APPROVAL_VALIDITY_MS } });
    expect((await go(s)).exit).toBe(0);
  });
});

describe('check 5: the mock service', () => {
  it('keeps the lines of the log and counts the orders, and sends no credential', async () => {
    const r = await go(scenario('clean'));
    const doc = JSON.parse(r.read(publicFile())!) as Obj;
    expect((doc.mock as Obj).log).toEqual(scenario('clean').log);
    expect((doc.mock as Obj).state).toEqual({ purchase_orders: 1, supplier_orders: 1 });
    expect((doc.mock as Obj).unattributed_lines).toBe(0);
    const mocks = r.calls.filter((call) => call.url.startsWith(MOCK_PUBLIC_BASE));
    expect(mocks.map((call) => call.url)).toEqual([`${MOCK_PUBLIC_BASE}/t/tenant-1/log`, `${MOCK_PUBLIC_BASE}/t/tenant-1/state`]);
    for (const call of mocks) expect(Object.keys(call.headers).map((name) => name.toLowerCase())).toEqual(['accept']);
  });
  it('refuses a log line that holds a bearer token, and writes no file', async () => {
    const s = scenario('clean');
    s.log.push({ ...logLine('GET /erp/stock/{sku}', 'token', ['a']), code: 'the header was Bearer abc123' });
    const r = await refuses(s, ['Bearer']);
    expect(r.err).toContain('mark of a secret');
  });
  it('copies no line of a caller with no verified identity into the file, and counts it', async () => {
    const stranger = (path: string): Obj => ({ ...logLine('GET /erp/stock/{sku}', 'none', []), path, sub: null, delegation: null, decision: 'refused', status: 401, code: 'missing_token', rule: 'token.missing' });
    const s = scenario('clean');
    s.log.push(stranger('/t/tenant-1/erp/stock/any-text-a-stranger-chooses'));
    const r = await go(s);
    expect(r.exit).toBe(0);
    const text = r.read(publicFile())!;
    expect(text).not.toContain('any-text-a-stranger-chooses');
    const doc = JSON.parse(text) as { mock: Obj };
    expect(doc.mock.log).toEqual(scenario('clean').log);
    expect(doc.mock.unattributed_lines).toBe(1);
    const marked = scenario('clean');
    marked.log.push(stranger('/t/tenant-1/erp/stock/authorization'));
    const blocked = await go(marked);
    expect(blocked.exit).toBe(0);
    const second = JSON.parse(blocked.read(publicFile())!) as { mock: Obj };
    expect(second.mock.unattributed_lines).toBe(1);
  });
  it('copies no line of a caller whose valid credential names no agent of the run, and a mark of a secret in its path does not block the file', async () => {
    const other = h('another agent');
    const holder = (over: Obj): Obj => ({ ...logLine('GET /erp/stock/{sku}', 'token', []), path: '/t/tenant-1/erp/stock/authorization', decision: 'refused', status: 403, code: 'delegation_invalid', rule: 'delegation.denied', ...over });
    const s = scenario('clean');
    s.log.push(holder({ sub: DID(h('another hirer')), act: [DID(other)] }), holder({ sub: SPIFFE(other), act: [] }), holder({ sub: DID(AGENTS['reorder-agent']), act: [] }));
    const r = await go(s);
    expect(r.exit).toBe(0);
    const doc = JSON.parse(r.read(publicFile())!) as { mock: Obj };
    expect(doc.mock.log).toEqual(scenario('clean').log);
    expect(doc.mock.unattributed_lines).toBe(3);
    const named = scenario('clean');
    named.log.push(holder({ sub: DID(h('another hirer')), act: [DID(other), DID(AGENTS['order-desk'])] }), holder({ sub: SPIFFE(AGENTS['reorder-agent']), act: [] }));
    const kept = await go(named);
    expect(kept.exit).toBe(2);
    expect(kept.err).toContain('mark of a secret');
    expect(kept.read(publicFile())).toBeNull();
  });
  it('refuses a log that dropped lines, a tenant that is not the tenant of the facts, and a mock service that fails', async () => {
    const s = scenario('clean');
    s.dropped = 2;
    await refuses(s, ['mock.log']);
    const t = scenario('clean');
    t.facts.tenant = 'another-tenant';
    await refuses(t, ['tenant']);
    const u = scenario('clean');
    u.mockStatus = 503;
    await refuses(u, ['mock: ', 'HTTP 503']);
  });
});

describe('check 6: the fault value of each result and the clean-run guard', () => {
  it('refuses a result with no fault_mode, and names the hire', async () => {
    const s = scenario('clean');
    delete s.hires[1]!.result.fault_mode;
    await refuses(s, ['hires[1].report_file', 'fault_mode']);
  });
  it('refuses a clean run with a fault value set in a result, and a fault value that the agent does not take', async () => {
    const s = scenario('clean');
    s.hires[2]!.result = confirmation(3, 'confirm_wrong_lot');
    await refuses(s, ['hires[2].report_file', 'a clean run has none']);
    const t = scenario('clean');
    t.hires[1]!.result.fault_mode = 'confirm_wrong_lot';
    await refuses(t, ['hires[1].report_file', 'does not take']);
  });
  it('takes a clean run with a check before the first hire and a check after the last hire', async () => {
    const s = scenario('clean');
    s.faultEntries = [cleanEntries(S0 + 30), cleanEntries(S0 + 4000)];
    expect((await go(s)).exit).toBe(0);
  });
  it('refuses a clean run with only the check before the first hire', async () => {
    const s = scenario('clean');
    s.faultEntries = [cleanEntries(S0 + 30)];
    await refuses(s, ['fault_check', 'at or after the block time of the last transaction']);
  });
  it('refuses a clean run with only the check after the last hire', async () => {
    const s = scenario('clean');
    s.faultEntries = [cleanEntries(S0 + 4000)];
    await refuses(s, ['fault_check', 'at or before the block time of the first post transaction']);
  });
  it('refuses a clean run whose two entries show another start time of a service, and names the service', async () => {
    const s = scenario('clean');
    s.faultEntries = [cleanEntries(S0 + 30), cleanEntries(S0 + 4000, { 'orders-service': stamp(S0 + 1000) })];
    await refuses(s, ['fault_check.services.orders-service', 'restarted during the run']);
  });
  it('refuses a clean entry that did not pass, a missing file, and an entry that has not the form of the task fault', async () => {
    const s = scenario('clean');
    const failed = cleanEntries(S0 + 30) as { shows: Obj };
    failed.shows.ok = false;
    s.faultEntries = [failed as Obj, cleanEntries(S0 + 4000)];
    await refuses(s, ['fault_check', 'at or before']);
    const t = scenario('clean');
    t.faultEntries = [{ step: 'fault_check', status: 'info', at: stamp(S0), shows: { check: 'clean' } }];
    await refuses(t, ['fault_check', 'has not the form']);
  });
  it('refuses a run with no evidence file of the task fault', async () => {
    const s = scenario('clean');
    s.faultEntries = [];
    const r = await go(s);
    expect(r.exit).toBe(2);
    expect(r.err).toContain('fault_check');
  });
  it('needs the three entries of the failure run: a clean entry before, the fault before the carried hire, and a clean entry after', async () => {
    const good = goodFaultEntries('failure');
    for (const [what, entries, rule] of [
      ['no clean entry before', good.slice(1), 'at or before the block time of the first post'],
      ['no entry of the fault', [good[0]!, good[2]!], 'confirm_wrong_lot entry'],
      ['no clean entry after', good.slice(0, 2), 'at or after the block time of the last'],
    ] as Array<[string, Obj[], string]>) {
      const s = decided();
      s.faultEntries = entries;
      const r = await refuses(s, ['fault_check', rule]);
      expect(r.err, what).toContain(rule);
    }
    const late = decided();
    late.faultEntries = [good[0]!, faultEntry(S0 + 3000, stamp(S0)), good[2]!];
    await refuses(late, ['confirm_wrong_lot entry']);
    expect((await go(decided())).exit).toBe(0);
  });
  it('refuses a failure run whose confirmation has not the fault value of the run', async () => {
    const s = decided();
    s.hires.find((one) => one.step === 'order-desk-c')!.result = confirmation(16, '');
    await refuses(s, ['confirm_wrong_lot that the failure run needs']);
  });
});

describe('check 7: the claims, the challenge and the case', () => {
  it('waits with exit 4 and writes no file when the case has no verdict, and says the time that the case needs', async () => {
    const s = scenario('failure');
    const r = await go(s);
    expect(r.exit).toBe(4);
    expect(r.read(publicFile())).toBeNull();
    expect(r.out).toContain('WAIT: the case of the challenge has no verdict');
    expect(r.out).toContain('about 30 minutes after the challenge');
    expect(r.out).toContain(`expected at ${stamp(S0 + 45 * 60 + CASE_DURATION_MS / 1000)}`);
    expect(r.machine.outcome).toBe('wait');
  });
  it('waits when the case is open and no hold is on the record, and when the jury decided and the hold is not yet on the record', async () => {
    const open = decided({ phase: 'reveal', state: 'Open', outcome: 'Inconclusive', tally: { claimer: 0, auditor: 0, inconclusive: 0 }, revealed: 0 }, 'none');
    expect((await go(open)).exit).toBe(4);
    const early = decided({}, 'none');
    const r = await go(early);
    expect(r.exit).toBe(4);
    expect(r.out).toContain('the jury decided AuditorWins, and the hold is not yet on the record');
    expect(r.read(publicFile())).toBeNull();
  });
  it('waits with the length of the case when the block time of the challenge is not known', async () => {
    const s = scenario('failure');
    s.skipKoiosTx.add(CHALLENGE.challenge.slice(0, 64));
    s.extraRows = [];
    const r = await go(s);
    expect(r.exit).toBe(4);
    expect(r.out).toContain('the hold comes about 4 h 44 min after the challenge');
  });
  it('waits when a hold with the reason 64 is on the record and no case of this challenge is final, whatever the sources show of the case', async () => {
    const alone = scenario('failure');
    alone.deskHold = 'held';
    const first = await go(alone);
    expect(first.exit).toBe(4);
    expect(first.read(publicFile())).toBeNull();
    expect(first.out).toContain('the hold on the record of the Order Desk is no proof of one');
    const openInIndexer = closedCase('AuditorWins', 'held', { state: 'open', finalized: null, closed: null, ref: ref('case output') });
    const inIndexer = await go(openInIndexer);
    expect(inIndexer.exit).toBe(4);
    expect(inIndexer.read(publicFile())).toBeNull();
    const openInTool = scenario('failure');
    openInTool.cases = [caseRow({ phase: 'reveal', state: 'Open', outcome: 'Inconclusive', tally: { claimer: 0, auditor: 0, inconclusive: 0 }, revealed: 0 })];
    openInTool.deskHold = 'held';
    const inTool = await go(openInTool);
    expect(inTool.exit).toBe(4);
    expect(inTool.read(publicFile())).toBeNull();
    expect(inTool.out).toContain('WAIT: the case of the challenge has no verdict');
  });
  it('writes a file with the verdict ClaimerWins, and shows step d as not run with the reason', async () => {
    const s = decided({ outcome: 'ClaimerWins', tally: { claimer: 3, auditor: 0, inconclusive: 0 } }, 'none');
    const r = await go(s);
    expect(r.exit).toBe(0);
    const doc = JSON.parse(r.read(publicFile())!) as { case: Obj; steps: Array<{ id: string; status: string; refs: unknown[]; note: string }> };
    expect(doc.case.verdict).toBe('ClaimerWins');
    expect(doc.case.hold).toBeNull();
    const step = doc.steps.find((one) => one.id === 'r2-d')!;
    expect(step).toMatchObject({ status: 'not_run', refs: [] });
    expect(step.note).toContain('a new claim and a new challenge');
  });
  it('lists a live case although its claim_out is the Challenged claim output, which is not the claim output that the challenge spent', async () => {
    const s = decided({ claim_out: `${CHALLENGE.challenge.slice(0, 64)}#1`, phase: 'reveal', state: 'Open', outcome: 'Inconclusive', tally: { claimer: 0, auditor: 0, inconclusive: 0 }, revealed: 0 }, 'none');
    const r = await go(s, ['status', '--run', 'f1']);
    expect(r.exit).toBe(1);
    expect(r.out).toContain(`case ${h('case token')}: phase reveal, state Open`);
    expect(r.out).not.toContain('lists no live case');
  });
  for (const result of ['ClaimerWins', 'Inconclusive']) {
    it(`takes the result ${result} of a closed case from the indexer, where the hosted tool lists no case, and says that the run needs a new claim and a new challenge`, async () => {
      const r = await go(closedCase(result, 'none'));
      expect(r.exit).toBe(0);
      const doc = JSON.parse(r.read(publicFile())!) as { case: Obj; steps: Array<{ id: string; status: string; refs: unknown[]; note: string }> };
      expect(doc.case).toMatchObject({ verdict: result, live: null, hold: null });
      expect(doc.case.indexed).toMatchObject({ case_token: h('case token'), state: 'closed', result, finalized_tx: h('case finalize tx'), closed_tx: h('case finalize tx') });
      expect(doc.steps.find((one) => one.id === 'r2-d')).toMatchObject({ status: 'not_run', refs: [] });
      const status = await go(closedCase(result, 'none'), ['status', '--run', 'f1']);
      expect(status.exit).toBe(0);
      expect(status.out).toContain(`indexer: case ${h('case token')} is closed (window ended)`);
      expect(status.out).toContain(`verdict: ${result}`);
      expect(status.out).toContain('the run needs a new claim and a new challenge');
    });
  }
  it('takes the verdict AuditorWins of a closed case from the indexer, and waits for the hold when the node shows none', async () => {
    const r = await go(closedCase('AuditorWins', 'none'));
    expect(r.exit).toBe(4);
    expect(r.out).toContain('the jury decided AuditorWins, and the hold is not yet on the record');
    expect(r.read(publicFile())).toBeNull();
    const status = await go(closedCase('AuditorWins', 'none'), ['status', '--run', 'f1']);
    expect(status.exit).toBe(1);
    expect(status.out).toContain('result AuditorWins');
  });
  it('takes no verdict from a hold that began before the challenge, and takes it when it began at the block time of the challenge', async () => {
    const challengeMs = (S0 + 45 * 60) * 1000;
    const open = scenario('failure');
    open.cases = [caseRow({ phase: 'commit', state: 'Open', outcome: 'Inconclusive', tally: { claimer: 0, auditor: 0, inconclusive: 0 }, revealed: 0 })];
    open.deskHold = 'held';
    open.holdSince = CAPTURE_MS - 2 * DAY;
    const stale = await go(open);
    expect(stale.exit).toBe(4);
    expect(stale.read(publicFile())).toBeNull();
    const bare = scenario('failure');
    bare.deskHold = 'held';
    bare.holdSince = CAPTURE_MS - 2 * DAY;
    const alone = await go(bare);
    expect(alone.exit).toBe(4);
    expect(alone.read(publicFile())).toBeNull();
    const before = closedCase();
    before.holdSince = challengeMs - 1;
    expect((await go(before)).exit).toBe(4);
    const at = closedCase();
    at.holdSince = challengeMs;
    expect((await go(at)).exit).toBe(0);
  });
  it('stops with the member when a hold is on the record and the block time of the challenge cannot be read', async () => {
    const s = scenario('failure');
    s.deskHold = 'held';
    s.skipKoiosTx.add(CHALLENGE.challenge.slice(0, 64));
    await refuses(s, ['case', 'the block time of the challenge cannot be read']);
  });
  it('skips a live case that is not the canonical case of its dispute', async () => {
    const s = decided({ canonical: false, outcome: 'ClaimerWins', tally: { claimer: 3, auditor: 0, inconclusive: 0 } }, 'none');
    const r = await go(s);
    expect(r.exit).toBe(4);
    expect(r.read(publicFile())).toBeNull();
  });
  it('ignores a case of the indexer that is not canonical, a case of another claim and a case of another challenge output', async () => {
    // Each of these cases has the result ClaimerWins and the node shows no hold, so a case that the task took would end the wait: a run waits only when the task skips the case.
    for (const over of [{ canonical: false }, { claim: h('another claim token') }, { challenge_out: ref('another challenge') }]) {
      const r = await go(closedCase('ClaimerWins', 'none', over));
      expect(r.exit, JSON.stringify(over)).toBe(4);
      expect(r.read(publicFile())).toBeNull();
    }
    expect((await go(closedCase('ClaimerWins', 'none'))).exit).toBe(0);
  });
  it('refuses an escrow on the chain that is for another agent than the agent of the hire', async () => {
    const s = scenario('clean');
    s.hires[0]!.datumOver = { agent_id: AGENTS['order-desk'] };
    await refuses(s, ['hires[0].escrow_ref: the escrow on the chain is not for the agent reorder-agent']);
    const twin = scenario('clean');
    twin.hires[0]!.datumOver = { agent_id: AGENTS['reorder-agent'] };
    expect((await go(twin)).exit).toBe(0);
  });
  it('waits when the case of the indexer is not final yet: the window ended and no Finalize is on the chain', async () => {
    const r = await go(closedCase('AuditorWins', 'none', { state: 'open', finalized: null, closed: null, ref: ref('case output') }));
    expect(r.exit).toBe(4);
    expect(r.read(publicFile())).toBeNull();
  });
  it('ends with exit 3 when the indexer answers HTTP 503, a body with no list of cases, a body that is no JSON, or a case of a wrong form, and writes no file', async () => {
    const down = closedCase();
    down.indexerStatus = 503;
    expect((await go(down)).exit).toBe(3);
    const bodies: unknown[] = [{ chain_time: 'now' }, [], 'not json {', { cases: [indexedRow('AuditorWins', { tally: null })] }, { cases: [indexedRow('AuditorWins', { state: 'burned' })] }];
    for (const body of bodies) {
      const s = closedCase();
      s.indexerBody = body;
      const r = await go(s);
      expect(r.exit, JSON.stringify(body)).toBe(3);
      expect(r.read(publicFile())).toBeNull();
    }
  });
  it('refuses a case of the indexer whose result is not the result of its Finalize, and a tool and an indexer that show two results', async () => {
    await refuses(closedCase('AuditorWins', 'none', { result: 'ClaimerWins' }), ['case', 'not the result of the Finalize']);
    const both = decided({ outcome: 'ClaimerWins', tally: { claimer: 3, auditor: 0, inconclusive: 0 } }, 'none');
    both.indexed = [indexedRow('AuditorWins')];
    await refuses(both, ['case', 'ClaimerWins', 'AuditorWins']);
  });
  it('confirms each transaction that the indexer names for the case', async () => {
    const finalize = closedCase();
    finalize.unconfirmed.add(h('case finalize tx'));
    await refuses(finalize, ['case.finalized_tx']);
    const opening = closedCase();
    opening.unconfirmed.add(h('case open tx'));
    await refuses(opening, ['case.opened_tx']);
  });
  it('reads the list of the indexer at the URL of VECTOR_MARKETPLACE_INDEXER_URL with no credential, and refuses a URL that is not https', async () => {
    const named = await go(closedCase(), undefined, { env: { VECTOR_MARKETPLACE_INDEXER_URL: 'https://indexer.example/' } });
    expect(named.exit).toBe(0);
    const called = named.calls.filter((call) => call.url.includes('/jury/cases'));
    expect(called.map((call) => call.url)).toEqual([`https://indexer.example/jury/cases?challenge=${CHALLENGE_TOKEN}`]);
    expect(Object.keys(called[0]!.headers).map((name) => name.toLowerCase())).toEqual(['accept']);
    const plain = await go(closedCase());
    expect(plain.calls.filter((call) => call.url.includes('/jury/cases')).map((call) => call.url)).toEqual([`${MARKETPLACE_INDEXER}/jury/cases?challenge=${CHALLENGE_TOKEN}`]);
    const bad = await go(closedCase(), undefined, { env: { VECTOR_MARKETPLACE_INDEXER_URL: 'http://indexer.example' } });
    expect(bad.exit).toBe(2);
    expect(bad.err).toContain('VECTOR_MARKETPLACE_INDEXER_URL must be an https URL');
  });
  it('asks the indexer for the cases of the challenge token alone, so a long list of other cases is never read', async () => {
    const s = closedCase();
    s.indexed.push(...Array.from({ length: 300 }, (_, i) => indexedRow('ClaimerWins', { case: h(`filler case ${i}`), challenge: `63686c5f${h(`filler ${i}`).slice(0, 56)}`, claim: h(`filler claim ${i}`) })));
    const r = await go(s);
    expect(r.exit).toBe(0);
    expect(r.calls.filter((call) => call.url.includes('/jury/cases')).map((call) => call.url)).toEqual([`${MARKETPLACE_INDEXER}/jury/cases?challenge=${CHALLENGE_TOKEN}`]);
  });
  it('refuses a challenge transaction that mints no token of the challenge, two of them, a burn, or a token of another kind', async () => {
    const token = (name: string, quantity: string): Obj => ({ policy_id: 'ac'.repeat(28), asset_name: name, quantity });
    const second = `63686c5f${h('second challenge token').slice(0, 56)}`;
    for (const minted of [[], [token(CHALLENGE_TOKEN, '1'), token(second, '1')], [token(CHALLENGE_TOKEN, '-1')], [token(CHALLENGE_TOKEN, '2')], [token(`6a72725f${h('juror token').slice(0, 56)}`, '1')]]) {
      const s = closedCase();
      s.challengeMint = minted;
      await refuses(s, ['case', 'the transaction of the challenge minted']);
    }
  });
  it('refuses a challenge against another claim than the claim of the Order Desk in the facts', async () => {
    const s = decided();
    s.facts.claims = { ...s.facts.claims, 'order-desk': { ...(s.facts.claims['order-desk'] as Obj), claimRef: ref('another claim') } };
    await refuses(s, ['case', 'challenge.claim']);
  });
  it('refuses a failure run with no challenge in the results, and a run with no claim of an agent in the facts', async () => {
    const s = decided();
    s.hires.find((one) => one.step === 'execute-c')!.result.challenge = null;
    await refuses(s, ['case', 'challenge']);
    const t = scenario('clean');
    delete t.facts.claims['order-desk'];
    await refuses(t, ['claims.order-desk']);
  });
  it('ends with exit 3 when the hosted tool of the jury fails or answers no list, and never writes a file', async () => {
    const s = decided();
    s.juryFailed = true;
    const r = await go(s);
    expect(r.exit).toBe(3);
    expect(r.read(publicFile())).toBeNull();
  });
  it('prefers the canonical case when two cases of the challenge are listed, and refuses when none is', async () => {
    const two = decided();
    two.cases = [caseRow({ canonical: false, case_token: h('other case'), outcome: 'ClaimerWins', tally: { claimer: 3, auditor: 0, inconclusive: 0 } }), caseRow()];
    expect((await go(two)).exit).toBe(0);
    const unknown = decided();
    unknown.cases = [caseRow({ canonical: null, case_token: h('other case') }), caseRow({ canonical: null })];
    expect((await go(unknown)).exit).toBe(3);
  });
  it('ignores the cases of another challenge', async () => {
    const s = decided();
    s.cases = [caseRow({ challenge_out: ref('another challenge') })];
    s.deskHold = 'none';
    expect((await go(s)).exit).toBe(4);
  });
});

describe('check 8: the refusals', () => {
  it('refuses a refusal of the ledger without its body and one of a tool without its message, and names the member', async () => {
    await refuses(Object.assign(decided(), { record: { refusals: [{ step: 'r2-a', kind: 'ledger', evaluation_error: 'failed' }] } }), ['refusals[0].transaction_body']);
    await refuses(Object.assign(decided(), { record: { refusals: [{ step: 'r2-h', kind: 'tool', message: '' }] } }), ['refusals[0].message']);
  });
  it('keeps each refusal as the record holds it, with the evaluation error and the body', async () => {
    const doc = JSON.parse((await go(decided())).read(publicFile())!) as { refusals: Obj[] };
    expect(doc.refusals[0]).toEqual({ step: 'r2-a', kind: 'ledger', evaluation_error: 'the vault script failed: the payment is above the limit', transaction_body: 'a1b2c3d4' });
    expect(doc.refusals[3]).toMatchObject({ kind: 'tool', message: 'The gateway refused the token request: the delegation was undelegated.' });
  });
});

describe('check 9: the exit state', () => {
  it('refuses a result of the last hire of execute with an exit state that the vocabulary does not have', async () => {
    const s = scenario('clean');
    s.hires[1]!.result.exit_state = 'Done';
    await refuses(s, ['exit_state']);
  });
  it('gives the exit state of the last hire of execute: Completed in a clean run, and Cancelled in the failure run', async () => {
    expect((JSON.parse((await go(scenario('clean'))).read(publicFile())!) as Obj).exit_state).toBe('Completed');
    expect((JSON.parse((await go(decided())).read(publicFile())!) as Obj).exit_state).toBe('Cancelled');
  });
});

describe('check 10: the steps', () => {
  it('refuses a clean run that does not show a step, and names it', async () => {
    const s = scenario('clean');
    s.log = s.log.filter((line) => line.credential !== 'x509-svid');
    await refuses(s, ['steps.r1-09', 'X.509 SVID']);
    const t = scenario('clean');
    t.log = t.log.filter((line) => line.route !== 'POST /po');
    await refuses(t, ['steps.r1-10']);
  });
  it('shows a step of the failure run as not run with the reason when no reference backs it, and still writes the file', async () => {
    const s = decided();
    s.facts.holds = null;
    const r = await go(s);
    expect(r.exit).toBe(0);
    const doc = JSON.parse(r.read(publicFile())!) as { steps: Array<{ id: string; status: string; refs: unknown[]; note: string }> };
    expect(doc.steps.find((step) => step.id === 'r2-g')).toEqual({ id: 'r2-g', status: 'not_run', refs: [], note: 'the facts hold no hold and no lift of the run' });
    expect(doc.steps.filter((step) => step.status === 'shown')).toHaveLength(data.evidenceSteps.filter((step) => step.run === 'failure').length - 1);
  });
  it('shows no step of the failure run without the hire that its rule names', async () => {
    const s = decided();
    s.hires = s.hires.filter((one) => one.step !== 'propose-f');
    const doc = JSON.parse((await go(s)).read(publicFile())!) as { steps: Array<{ id: string; status: string; note: string }> };
    expect(doc.steps.find((step) => step.id === 'r2-f')).toMatchObject({ status: 'not_run', note: 'the record has no failed hire named propose-f' });
  });
});

describe('the secret scan', () => {
  const marks: Array<[string, string]> = [
    ['ed25519_sk', ['the key', ['ed25519', 'sk1abc'].join('_')].join(' ')], ['_sk1', 'a text with root_xsk1qqq in it'], ['Bearer', 'it sent Bearer abc'], ['Authorization', 'the Authorization header'],
    ['PRIV_KEY', ['SUPPLIER', 'PRIV', 'KEY'].join('_')], ['access_token', 'url?access_token=abc'],
  ];
  for (const [mark, text] of marks) {
    it(`refuses a log line that holds ${mark}, writes no file, and shows no value`, async () => {
      const s = scenario('clean');
      s.log.push({ ...logLine('POST /po', 'token', ['a']), code: text });
      const r = await refuses(s, ['mark of a secret', mark]);
      expect(r.err).not.toContain('abc');
    });
  }
  it('refuses a result whose text holds a bearer token already at the report of the hire, and names the hire', async () => {
    const s = scenario('clean');
    (s.hires[0]!.result.decisions as Obj[])[0]!.reasoning = 'it sent Bearer abc';
    await refuses(s, ['hires[0].report_file', 'mark of a secret']);
  });
  it('refuses a result with the word Authorization, which only the scan of the final text knows', async () => {
    const s = scenario('clean');
    (s.hires[0]!.result.decisions as Obj[])[0]!.reasoning = 'the Authorization header';
    await refuses(s, ['mark of a secret', 'Authorization']);
  });
  it('takes a hyphenated identifier but still refuses an authorization header or assignment', () => {
    expect(secretMarkIn('{"use_case":"prior-authorization"}')).toBeNull();
    for (const text of ['proxy-authorization', 'X-Authorization', 'authorization=none', 'custom-authorization: none']) {
      expect(secretMarkIn(text)).toBe('Authorization');
    }
  });
  it('refuses a JWT in a line of the log and in a result, writes no file, and shows no value', async () => {
    const jwt = ['eyJhbGciOiJFZERTQSJ9', 'eyJzdWIiOiJkaWQ6dmVjdG9yOngifQ', 'c2lnbmF0dXJl'].join('.');
    const logged = scenario('clean');
    logged.log.push({ ...logLine('POST /po', 'token', ['did:vector:one']), presented: jwt });
    const inLog = await refuses(logged, ['mark of a secret', 'JWT']);
    expect(inLog.err).not.toContain(jwt);
    const written = scenario('clean');
    (written.hires[1]!.result as Obj).writes = [{ route: 'POST /po', credential: jwt }];
    const inResult = await refuses(written, ['mark of a secret', 'JWT']);
    expect(inResult.err).not.toContain(jwt);
  });
  it('finds a JWT as base64url writes it, and takes a text that only looks like one', () => {
    expect(secretMarkIn(['eyJhbGciOiJFZERTQSJ9', 'eyJzdWIiOiJkaWQ6dmVjdG9yOngifQ', 'c2lnbmF0dXJl'].join('.'))).toBe('JWT');
    for (const text of ['eyJhbGciOiJub25lIn0', 'eyJhbGciOiJub25lIn0.payload.signature', 'the word eyJ alone, and eyJabc.eyJ without the last dot', 'a.b.c']) expect(secretMarkIn(text), text).toBeNull();
  });
  it('takes a reasoning that only looks like a mark', async () => {
    const s = scenario('clean');
    (s.hires[0]!.result.decisions as Obj[])[0]!.reasoning = 'The order is authorized, the bearerless route is used and the key ed25519 is a curve.';
    expect((await go(s)).exit).toBe(0);
  });
  it('finds each mark in any case, and nothing in a plain text', () => {
    for (const [, text] of marks) expect(secretMarkIn(text.toUpperCase())).not.toBeNull();
    expect(secretMarkIn('a plain text about a purchase order')).toBeNull();
  });
});

describe('the file on disk', () => {
  it('reports a file that exists already with the same content', async () => {
    const first = await go(scenario('clean'));
    expect(first.exit).toBe(0);
    const again = await go(scenario('clean'), ['run', '--run', 'c1', '--number', '1'], { world: first.world });
    expect(again.exit).toBe(0);
    expect(again.out).toContain('exists with this content already');
    expect(again.read(publicFile())).toBe(first.read(publicFile()));
  });
  it('never replaces an evidence file that holds other content', async () => {
    const first = await go(scenario('clean'));
    writeFileSync(join(first.stateDir, publicFile()), '{"edited":true}\n');
    const again = await go(scenario('clean'), ['run', '--run', 'c1', '--number', '1'], { world: first.world });
    expect(again.exit).toBe(2);
    expect(again.err).toContain('exists with other content');
    expect(again.read(publicFile())).toBe('{"edited":true}\n');
  });
});

describe('the status', () => {
  it('shows the claims, the challenge, the case, the hold and the verdict of a failure run, and ends with exit 0 for AuditorWins', async () => {
    const r = await go(decided(), ['status', '--run', 'f1']);
    expect(r.exit).toBe(0);
    expect(r.out).toContain('claim of order-desk');
    expect(r.out).toContain(`challenge: claim ${h('claim tx order-desk')}#0`);
    expect(r.out).toContain('tally ClaimerWins 0, AuditorWins 3, Inconclusive 0, outcome AuditorWins');
    expect(r.out).toContain('hold of the Order Desk: reason 64');
    expect(r.out).toContain('verdict: AuditorWins');
    expect(r.out).not.toContain('new claim');
  });
  it('ends with exit 1 and the time that the case needs when there is no verdict, because the runner ends a status with exit 0 alone', async () => {
    const r = await go(scenario('failure'), ['status', '--run', 'f1']);
    expect(r.exit).toBe(1);
    expect(r.out).toContain('verdict: none yet');
    expect(r.out).toContain('about 30 minutes after the challenge');
    expect(r.err).toContain('no verdict yet');
  });
  it('says that the run needs a new claim and a new challenge when the verdict is another one, and ends with exit 0', async () => {
    const r = await go(decided({ outcome: 'Inconclusive', tally: { claimer: 1, auditor: 1, inconclusive: 1 } }, 'none'), ['status', '--run', 'f1']);
    expect(r.exit).toBe(0);
    expect(r.out).toContain('verdict: Inconclusive');
    expect(r.out).toContain('the run needs a new claim and a new challenge');
  });
  it('shows the hold of the Order Desk that the node holds, with its dates and the record output', async () => {
    const r = await go(decided(), ['status', '--run', 'f1']);
    expect(r.out).toContain(`from ${stamp(S0 + 3600)} until ${stamp(S0 + 3600 + 7 * 86_400)}`);
    expect(r.out).toMatch(/on the record output [0-9a-f]{64}#0/);
  });
  it('says that a clean run has no challenge and no case, and ends with exit 0', async () => {
    const r = await go(scenario('clean'), ['status', '--run', 'c1']);
    expect(r.exit).toBe(0);
    expect(r.out).toContain('a clean run has no challenge and no case');
  });
});
