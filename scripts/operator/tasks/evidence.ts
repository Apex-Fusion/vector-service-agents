// scripts/operator/tasks/evidence.ts - the task evidence: it writes the evidence file of a run, and it waits for the jury case of the failure run.
//
//   run --run <label> --number <n>      writes a public file named for the buyer-side agent or the subject of a lifecycle run
//   run --run <label> --private         writes <state>/evidence/private/<label>.json
//   status --run <label>                shows the claims, challenge, case and hold when the run has them
//
// The task reads the run record and checks references against its sources before it writes. An open jury case remains a wait.
// It signs and submits nothing. The final text is scanned for the marks of a secret.
// The runner ends `status` with exit 0 for any task, so a status with no verdict prints its lines and then ends with exit 1, as the status of end-state does: it never looks done.
import { createHash } from 'node:crypto';
import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readFileSync, readSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { writeFileAtomically } from '../../checks/lib/files.ts';
import { duration, iso } from '../../checks/lib/format.ts';
import { HostedError } from '../../checks/lib/hosted.ts';
import { PreconditionError } from '../../checks/lib/session.ts';
import { EnvReader } from '../../checks/lib/settings.ts';
import { BUYER_SIDE_KINDS, MAX_REQUEST_BYTES, parseRequest } from '../../../packages/usecase-kit/src/protocol/index.ts';
import { decodeIdentityEscrowDatum, promptHashForPayload } from '../../../packages/vector-read/src/index.ts';
import type { IdentityEscrowDatum } from '../../../packages/vector-read/src/index.ts';
import { bytesOf, constrFields, decodeIdentityDatum, decodeVaultDatum, outRefOf, sameDelegator } from '../../../packages/vector-read/src/identity-codec.ts';
import { ACCEPT_WINDOW_MS, dataOfKoiosJson, documentUri, readDocument } from '../../../packages/buyer-core/src/index.ts';
import { findConfigRecord } from '../../../packages/buyer-core/src/vendored/mcp/identity-deployment.ts';
import { addressDetails, decodePlutusData } from '../../../packages/vector-read/src/guarded-decode.ts';
import { decodeJuryDatum } from '../../../packages/buyer-core/src/vendored/mcp/jury-codec.ts';
import { REDEEMER } from '../../../packages/buyer-core/src/vendored/mcp/marketplace-constants.ts';
import type { KoiosUtxo } from '../../../packages/buyer-core/src/vendored/mcp/marketplace-indexer.ts';
import type { ClaimFact, Facts, RecordFact, StepOutcome, TaskDefinition } from '../lib/contract.ts';
import { EVIDENCE_MODULES, evidenceModuleOf } from '../lib/evidence/index.ts';
import { isObject, lastHire, txOf } from '../lib/evidence/types.ts';
import type {
  ApprovalRead, Assembly, CaseRead, CaseView, Challenge, CommittedApproval, CommittedExecute, EvidenceModule, EvidenceOptions, EvidenceSession, FaultEntry, HireView, Hold, HoldCandidate,
  IndexedCase, Loaded, MockRead, Obj, Reads, Ref, ReportedHire, Shown, TerminalSpend, VaultPayment,
} from '../lib/evidence/types.ts';
import { MOCK_PUBLIC_BASE } from '../lib/mock-hosts.ts';
import { checkAttestation, escrowPaidFromVault, findRecord, keyHashOf, koiosUtxoInfo, readDelegation, readVaults, resolveEscrowLineage, verifyReceipt } from '../lib/platform.ts';
import type { LedgerEnv } from '../lib/platform.ts';
import { FlagError } from '../lib/runner.ts';
import { hireRoleOf, parseReport, parseRunRecord, readJsonFile, scriptTxInfoOf, UnknownTransactionError, txInfoOf, txTimeOf } from '../lib/run-record.ts';
import type { HireEntry, Report, RunRecord, ScriptSpend, ScriptTxInfo, ScriptTxIo, TxInfo } from '../lib/run-record.ts';
import { holdsSecret } from '../lib/secrets.ts';

/** A transaction on the explorer of the network: this text and the hash. */
export const EXPLORER_TX = 'https://explorer.vector.mainnet.apexfusion.org/transaction/hash/';
const EXIT_STATES: readonly string[] = ['Completed', 'Rejected', 'Expired', 'Cancelled', 'Escalated', 'Failed'];
const REF_KIND = /^[a-z][a-z0-9_-]{0,31}$/;
const REF_VALUE = /^[A-Za-z0-9._:#/-]{1,200}$/;
/** The reason code of the hold that Module-1 puts on an agent after a verdict of AuditorWins. */
export const JURY_HOLD_REASON = 64;
/** The relay opens a case about 30 minutes after the challenge, the jurors commit for 2 hours and reveal for 2 hours, and then the relay finalises and resolves: about 4 h 44 min to the hold. */
export const CASE_DURATION_MS = (4 * 60 + 44) * 60_000;
/** The public marketplace indexer: it follows the cases of the jury. The setting VECTOR_MARKETPLACE_INDEXER_URL names another one. */
export const MARKETPLACE_INDEXER = 'https://mp-indexer.vector.apexfusion.org';
const INDEXER_TIMEOUT_MS = 30_000;
const MOST_INDEXER_CHARS = 16 * 1024 * 1024;
const VERDICTS: readonly string[] = ['ClaimerWins', 'AuditorWins', 'Inconclusive'];
/** A vault lineage is one output after the other: the open, then one output for each payment. A run has a few payments, so the walk back along it stops after this many transactions. */
const DEPTH_OF_VAULT_CHAIN = 8;
const NUMBER = /^[1-9][0-9]?$/;
const REF = /^[0-9a-f]{64}#(?:0|[1-9][0-9]{0,5})$/;
const HASH = /^[0-9a-f]{64}$/;
const SCRIPT_HASH = /^[0-9a-f]{56}$/;
const MOST_MOCK_CHARS = 8 * 1024 * 1024;
const MOCK_TIMEOUT_MS = 30_000;
/**
 * The marks of a secret in the final text: each is refused. The words are refused in any case. A JWT is refused as base64url writes it: its header and its payload both start with eyJ, the text of an open brace and a
 * quote. `Authorization` is the name of the header that carries a token.
 */
const MARKS: ReadonlyArray<readonly [string, RegExp]> = [
  ['ed25519_sk', /ed25519e?_sk/i], ['_sk1', /_x?sk1/i], ['Bearer', /bearer\s/i],
  // A hyphenated identifier can contain this word; a header name or assignment cannot.
  ['Authorization', /(?:^|[^a-z0-9-])(?:(?:proxy|x)-)?authorization(?![a-z0-9-])|authorization\s*[:=]/i],
  ['PRIV_KEY', /PRIV_KEY/i], ['access_token', /access_token=/i], ['JWT', /eyJ[\w-]+\.eyJ[\w-]+\./],
];

type Extra = EvidenceOptions & { readonly module: EvidenceModule };
type Session = EvidenceSession & { readonly extra: Extra };
export type { Ref } from '../lib/evidence/types.ts';

// ---- the problems of a run: each names a member, and the run lists all of them ----

class Problems {
  readonly lines: string[] = [];
  add(member: string, rule: string): void { this.lines.push(`${member}: ${rule}`); }
  get any(): boolean { return this.lines.length > 0; }
  stop(): void {
    if (this.any) throw new PreconditionError(`the evidence file is not written: ${this.lines.length} problem(s) in the run\n  - ${this.lines.join('\n  - ')}`);
  }
}

/** An error as one short line that holds no mark of a secret. */
function shown(err: unknown): string {
  const text = (err instanceof Error ? err.message : String(err)).replace(/\s+/g, ' ').trim().slice(0, 240);
  return holdsSecret(text) ? 'a message that holds a mark of a secret is not shown' : text;
}

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

// ---- 1. the record and the reports ----

const stopOf = (err: unknown): PreconditionError => new PreconditionError(shown(err));

/** The decisions of a result, each with its name, its choice, its reasoning and the sub-job of its model hire. A decision of another shape is a problem. */
function decisionsOf(result: Obj, member: string, problems: Problems): Obj[] {
  if (!Array.isArray(result.decisions)) {
    problems.add(member, 'the result has no list decisions');
    return [];
  }
  const list: Obj[] = [];
  result.decisions.forEach((item: unknown, i) => {
    const inference = isObject(item) ? item.inference : undefined;
    const subJob = isObject(inference) ? inference.sub_job : undefined;
    if (!isObject(item) || typeof item.name !== 'string' || typeof item.reasoning !== 'string' || item.choice === undefined || !isObject(subJob) || typeof subJob.escrow_ref !== 'string' || !REF.test(subJob.escrow_ref)) {
      problems.add(member, `decisions[${i}] has not the form of a decision: a name, a choice, a reasoning and the sub-job of its model hire with an escrow reference`);
    } else list.push(item);
  });
  return list;
}

function hireView(session: Session, record: RunRecord, entry: HireEntry, index: number, problems: Problems): HireView | null {
  const where = `hires[${index}]`;
  const role = hireRoleOf(entry.step, session.extra.module.hireRoles)!;
  if (txOf(entry.escrow_ref) !== entry.post_tx) problems.add(`${where}.post_tx`, 'is not the transaction of escrow_ref');
  if (entry.report_file === null) return { index, entry, role, report: null, result: null, sha256: null, decisions: [] };
  let report: Report;
  try { report = parseReport(readJsonFile(join(session.settings.stateDir, 'runs', record.label, entry.report_file), `the report file of the hire ${entry.step}`), 'the report file'); } catch (err) {
    problems.add(`${where}.report_file`, shown(err));
    return null;
  }
  let parsed: unknown;
  try { parsed = JSON.parse(report.result); } catch { parsed = undefined; }
  if (!isObject(parsed)) {
    problems.add(`${where}.report_file`, 'result is not a JSON object');
    return null;
  }
  const digest = sha256(report.result);
  if (digest !== report.receipt.response_hash) problems.add(`${where}.report_file`, 'the SHA-256 of result is not the response_hash of the receipt');
  if (report.receipt.escrow_ref !== entry.escrow_ref) problems.add(`${where}.escrow_ref`, 'is not the escrow_ref of the receipt');
  const schema = session.extra.module.reportSchemas[role];
  if (schema === undefined) problems.add(`${where}.report_file`, 'the evidence module has no result schema for the hire role');
  if (parsed.schema !== schema) problems.add(`${where}.report_file`, `result is not the result of ${role}: its schema is not ${schema}`);
  const agent = session.use.agents.find((one) => one.id === entry.agent)!;
  const kind = agent.kind;
  const mode = parsed.fault_mode;
  if (typeof mode !== 'string') problems.add(`${where}.report_file`, 'result has no fault_mode: every result names its fault value, and an empty text is no fault');
  else if (mode !== '' && !agent.faultValues.includes(mode)) problems.add(`${where}.report_file`, `result has a fault_mode that the kind ${kind} does not take`);
  else if (record.kind === 'clean' && mode !== '') problems.add(`${where}.report_file`, 'result has a fault_mode that is set: a clean run has none');
  return { index, entry, role, report, result: parsed, sha256: digest, decisions: decisionsOf(parsed, `${where}.report_file`, problems) };
}

function loadRun(session: Session, problems: Problems): Loaded {
  const { label } = session.extra;
  let record: RunRecord;
  try { record = parseRunRecord(readJsonFile(join(session.settings.stateDir, 'runs', `${label}.json`), 'the run record'), session.use, session.extra.module); } catch (err) { throw stopOf(err); }
  if (record.label !== label) throw new PreconditionError('label: the label of the record is not the label in the name of its file');
  if (!session.use.runs.some((run) => run.id === record.kind)) throw new PreconditionError(`kind: ${record.kind} is not a run of the data of the use case`);
  if (!session.extra.module.runKinds.includes(record.kind)) throw new PreconditionError(`kind: the evidence module does not cover ${record.kind}`);
  const hires = record.hires.map((entry, index) => hireView(session, record, entry, index, problems)).filter((view): view is HireView => view !== null);
  if (record.kind === 'lifecycle') return { record, hires, carried: null };
  problems.stop();
  const chosen = hook('hires.carried', () => session.extra.module.carriedOf(hires));
  if (chosen === null) return { record, hires, carried: null };
  const carried = hires.find((hire): hire is ReportedHire => hire.entry === chosen && hire.report !== null);
  if (carried === undefined) throw new PreconditionError('hires.carried: the module did not select a hire with a checked report');
  return { record, hires, carried };
}

/** A hook error is a failed evidence read, not a missing value. */
function hook<T>(member: string, run: () => T): T {
  try { return run(); } catch (err) { throw new PreconditionError(`${member}.read_failed: ${shown(err)}`); }
}

const envOf = (session: EvidenceSession): LedgerEnv => ({ provider: session.chain.provider, deployment: session.chain.deployment, koiosUrl: session.chain.koiosUrl, fetchImpl: session.chain.fetchImpl });

// ---- 2. every transaction is confirmed ----

function transactionsOf(a: Assembly, module: EvidenceModule, problems: Problems): Map<string, string> {
  const txs = new Map<string, string>();
  const add = (member: string, hash: string | null): void => { if (hash !== null && !txs.has(hash)) txs.set(hash, member); };
  const { loaded, facts, challenge } = a;
  const { record } = loaded;
  if (record.kind === 'lifecycle') {
    for (const name of record.lifecycle) {
      const step = Object.hasOwn(facts.lifecycle, name) ? facts.lifecycle[name] : undefined;
      if (step === undefined || typeof step.tx !== 'string' || !HASH.test(step.tx)) problems.add(`lifecycle.${name}`, 'the facts hold no transaction for this step');
      else if (txs.has(step.tx)) problems.add(`lifecycle.${name}`, 'the same transaction cannot prove two lifecycle steps');
      else add(`lifecycle.${name}.tx`, step.tx);
    }
    return txs;
  }
  record.delegations.forEach((d, i) => { add(`delegations[${i}].tx`, d.tx); add(`delegations[${i}].ended_tx`, d.ended_tx); });
  record.vaults.forEach((v, i) => { add(`vaults[${i}].open_tx`, v.open_tx); add(`vaults[${i}].close_tx`, v.close_tx); });
  record.approvals.forEach((entry, i) => {
    const member = record.legacy ? 'approval' : `approvals[${i}]`;
    add(`${member}.tx`, entry.tx);
    add(`${member}.revoked_tx`, entry.revoked_tx);
  });
  record.sub_delegations.forEach((s, i) => { add(`sub_delegations[${i}].delegate_tx`, s.delegate_tx); add(`sub_delegations[${i}].undelegate_tx`, s.undelegate_tx); });
  record.hires.forEach((h, i) => { add(`hires[${i}].post_tx`, h.post_tx); add(`hires[${i}].accept_tx`, h.accept_tx); add(`hires[${i}].reclaim_tx`, h.reclaim_tx); });
  for (const view of loaded.hires) view.decisions.forEach((d, j) => add(`hires[${view.index}].decisions[${j}].escrow_ref`, txOf(((d.inference as Obj).sub_job as Obj).escrow_ref as string)));
  const claims = facts.claims[record.label] ?? {};
  const needed = new Set(hook('claims', () => module.claimAgents?.(a) ?? []));
  if (challenge !== null) needed.add(challenge.agent);
  for (const agent of Object.keys(claims)) needed.add(agent);
  for (const agent of needed) {
    const claim = claims[agent];
    if (claim === undefined || !a.use.agents.some((one) => one.id === agent)) {
      problems.add(`claims.${agent}`, `the facts hold no claim of a known agent ${agent} for the run ${record.label}`);
      continue;
    }
    add(`claims.${agent}.documentTx`, claim.documentTx); add(`claims.${agent}.claimTx`, claim.claimTx); add(`claims.${agent}.withdrawTx`, claim.withdrawTx);
  }
  if (challenge !== null) { add('challenge.evidence', challenge.evidence); add('challenge.challenge', txOf(challenge.challenge)); }
  const hold = facts.holds[record.label];
  if (hold !== undefined) { add('holds.suspendTx', hold.suspendTx); add('holds.liftTx', hold.liftTx); }
  return txs;
}

async function confirmAll(session: EvidenceSession, txs: ReadonlyMap<string, string>, problems: Problems): Promise<void> {
  for (const [hash, member] of txs) {
    try {
      const { confirmations } = await session.node.txStatus(hash);
      if (confirmations === null || confirmations < 1) problems.add(member, 'the transaction has no confirmation on the node');
    } catch (err) { problems.add(member, `the status of the transaction cannot be read (${shown(err)})`); }
  }
}

// ---- 3. the hires: the escrow, the advert and the spend of the escrow ----

const scriptInfo = (session: EvidenceSession, tx: string): Promise<ScriptTxInfo> =>
  scriptTxInfoOf(session.fetchImpl, session.settings.urls.koios, tx);

function spendOf(info: ScriptTxInfo, script: string, input: string, action: number, fields: number): ScriptSpend | undefined {
  const sameScript = info.spends.filter((run) => run.script === script);
  const exact = sameScript.filter((run) => run.input === input
    || (run.input === null && sameScript.length === 1 && info.inputs.filter((row) => row.credential === script).length === 1));
  const run = exact.length === 1 ? exact[0] : undefined;
  return run?.valid === true && run.action === action && run.fields.length === fields
    && info.inputs.some((row) => row.ref === input && row.credential === script) ? run : undefined;
}

function checkedSpend(info: ScriptTxInfo, script: string, input: string, action: number, fields: number): boolean {
  return spendOf(info, script, input, action, fields) !== undefined;
}

async function confirmed(session: EvidenceSession, hash: string): Promise<void> {
  if (((await session.node.txStatus(hash)).confirmations ?? 0) < 1) throw new PreconditionError('the transaction has no confirmation on the node');
}

const HISTORICAL_OUTPUT_MAX = 512 * 1024;
const fromOutput = (row: KoiosUtxo): string => `${row.tx_hash}#${row.tx_index}`;
async function outputOf(session: EvidenceSession, ref: string): Promise<KoiosUtxo> {
  const found = await koiosUtxoInfo(session.settings.urls.koios, [ref], session.fetchImpl, HISTORICAL_OUTPUT_MAX);
  if (found.length !== 1 || fromOutput(found[0]!) !== ref) throw new PreconditionError('the exact output cannot be read');
  return found[0]!;
}

const unitsOf = (amount: unknown): bigint => {
  if (typeof amount === 'string' && /^\d{1,30}$/.test(amount)) return BigInt(amount);
  if (typeof amount === 'number' && Number.isSafeInteger(amount) && amount >= 0) return BigInt(amount);
  throw new PreconditionError('the amount of an output cannot be read');
};

async function vaultRefund(session: EvidenceSession, payment: Extract<VaultPayment, { paid: true }>, spent: KoiosUtxo,
    escrow: IdentityEscrowDatum, info: ScriptTxInfo): Promise<string[]> {
  const { vault } = session.chain.deployment;
  const funded = await outputOf(session, payment.vault_ref);
  const before = decodeVaultDatum(funded.inline_datum?.bytes ?? '');
  const refund = escrow.refund;
  const returned = decodeVaultDatum(refund?.datum ?? '');
  if (funded.address !== vault.address || funded.is_spent !== true || before.type !== 'Live' || before.delegation !== payment.delegation
    || refund === null || refund.address.paymentCredential.type !== 'Script' || refund.address.paymentCredential.hash !== vault.hash
    || refund.address.stakeCredential !== null || returned.type !== 'Returned'
    || !sameDelegator(returned.owner, before.owner)) throw new PreconditionError('the committed refund is not for the vault owner that paid');
  return netVaultReturn(session, spent, info, (row) => {
    if (row.address !== vault.address || typeof row.inline_datum?.bytes !== 'string') return false;
    try {
      const datum = decodeVaultDatum(row.inline_datum.bytes);
      return datum.type === 'Returned' && sameDelegator(datum.owner, before.owner);
    } catch { return false; }
  });
}

type Value = Map<string, bigint>;
const LOVELACE = 'lovelace';

function addValue(value: Value, row: KoiosUtxo, sign: 1n | -1n): void {
  value.set(LOVELACE, (value.get(LOVELACE) ?? 0n) + sign * unitsOf(row.value));
  for (const { policy, name, quantity } of assetsOf(row)) {
    const unit = policy + name;
    value.set(unit, (value.get(unit) ?? 0n) + sign * quantity);
  }
}

function paymentTypeAt(io: ScriptTxIo, row: KoiosUtxo): 'Key' | 'Script' {
  if (io.address === null || io.address !== row.address) throw new PreconditionError('the address of a regular input or output is unproven');
  let payment;
  try { payment = addressDetails(io.address).paymentCredential; } catch { throw new PreconditionError('a regular input or output has an invalid payment address'); }
  if (payment == null || payment.hash !== io.credential || (row.payment_cred !== undefined && row.payment_cred !== payment.hash)) {
    throw new PreconditionError('the credential of a regular input or output is unproven');
  }
  return payment.type;
}

/**
 * Account for net value, not the provenance of fungible units. A wallet must cover its own exact-address change.
 * Non-escrow inputs pay the actual fee and any lovelace top-up. Native assets from them must return as change.
 * All other value must go to the exact refund destination. A payment that cannot be separated is unproven.
 */
async function netVaultReturn(session: EvidenceSession, spent: KoiosUtxo, info: ScriptTxInfo, matches: (row: KoiosUtxo) => boolean): Promise<string[]> {
  const short = 'the matching vault outputs do not show the full escrow value';
  const unproven = 'the full escrow return is unproven';
  const escrowRef = fromOutput(spent);
  if (info.fee === null || info.minted.length !== 0) throw new PreconditionError(`${unproven}: the fee or mint is not accounted for`);
  const regular = info.inputs.find((io) => io.ref === escrowRef);
  if (regular === undefined) throw new PreconditionError(`${unproven}: the escrow is not a regular input`);
  paymentTypeAt(regular, spent);
  const inputs = info.inputs.filter((io) => io.ref !== escrowRef);
  const refs = [...inputs, ...info.outputs].map((io) => io.ref);
  const wanted = new Set(refs);
  if (wanted.size !== refs.length || wanted.has(escrowRef) || info.inputs.length !== inputs.length + 1) {
    throw new PreconditionError(`${unproven}: the reclaim lists a duplicate regular input or output`);
  }
  const rows = await koiosUtxoInfo(session.settings.urls.koios, refs, session.fetchImpl, HISTORICAL_OUTPUT_MAX);
  const byRef = new Map(rows.map((row) => [fromOutput(row), row]));
  if (byRef.size !== rows.length || byRef.size !== wanted.size || refs.some((ref) => !byRef.has(ref))) {
    throw new PreconditionError(`${unproven}: the exact regular inputs and outputs cannot be read`);
  }
  const sources = new Map<string, Value>();
  for (const input of inputs) {
    const row = byRef.get(input.ref)!;
    // The escrow is the only regular script input, including when another vault has the same owner.
    if (row.is_spent !== true) throw new PreconditionError(`${unproven}: a regular funding input is not confirmed spent`);
    if (paymentTypeAt(input, row) !== 'Key') throw new PreconditionError(`${unproven}: another regular input is a script output`);
    const address = input.address!;
    let value = sources.get(address);
    if (value === undefined) {
      value = new Map();
      sources.set(address, value);
    }
    addValue(value, row, 1n);
  }
  const refunded: string[] = [];
  const gross: Value = new Map();
  let unmatched = false;
  for (const output of info.outputs) {
    const row = byRef.get(output.ref)!;
    paymentTypeAt(output, row);
    if (matches(row)) {
      refunded.push(output.ref);
      addValue(gross, row, 1n);
    } else {
      const source = sources.get(output.address!);
      if (source === undefined) unmatched = true;
      else addValue(source, row, -1n);
    }
  }
  const held: Value = new Map();
  addValue(held, spent, 1n);
  if (refunded.length === 0 || [...held].some(([unit, quantity]) => (gross.get(unit) ?? 0n) < quantity)) throw new PreconditionError(short);
  if (unmatched) throw new PreconditionError(`${unproven}: an output is neither a matching refund nor change to a funding address`);

  let contributed = 0n;
  for (const source of sources.values()) {
    const coin = source.get(LOVELACE) ?? 0n;
    if (coin < 0n || [...source].some(([unit, quantity]) => unit !== LOVELACE && quantity !== 0n)) {
      throw new PreconditionError(`${unproven}: a funding address does not match its change`);
    }
    contributed += coin;
  }
  if (contributed < info.fee) throw new PreconditionError(`${unproven}: the other inputs do not fund the actual fee`);
  // E = R - (I - C - F). The top-up I - C - F is not part of the net escrow return.
  gross.set(LOVELACE, (gross.get(LOVELACE) ?? 0n) - (contributed - info.fee));
  if ([...held].some(([unit, quantity]) => (gross.get(unit) ?? 0n) !== quantity)
    || [...gross].some(([unit, quantity]) => (held.get(unit) ?? 0n) !== quantity)) {
    throw new PreconditionError(`${unproven}: the net vault return does not equal the escrow input`);
  }
  return refunded;
}

interface OutputAsset { readonly policy: string; readonly name: string; readonly quantity: bigint }
function assetsOf(row: KoiosUtxo): OutputAsset[] {
  if (!Array.isArray(row.asset_list)) throw new PreconditionError('the assets of an output cannot be read');
  const seen = new Set<string>();
  return row.asset_list.map((one) => {
    if (!isObject(one) || typeof one.policy_id !== 'string' || !SCRIPT_HASH.test(one.policy_id)
      || typeof one.asset_name !== 'string' || !/^(?:[0-9a-f]{2}){0,32}$/.test(one.asset_name)) throw new PreconditionError('an output asset is not well formed');
    const unit = one.policy_id + one.asset_name;
    if (seen.has(unit)) throw new PreconditionError('an output lists an asset twice');
    seen.add(unit);
    return { policy: one.policy_id, name: one.asset_name, quantity: unitsOf(one.quantity) };
  });
}

/** Trace the Claim and Submit spends back to the recorded Post. */
async function verifyEscrowAncestry(session: EvidenceSession, post: string, ref: string, datum: IdentityEscrowDatum): Promise<void> {
  const stages = datum.state === 'Submitted' ? [REDEEMER.Submit, REDEEMER.Claim] : datum.state === 'Claimed' ? [REDEEMER.Claim] : [];
  const credential = session.chain.deployment.escrow.hash;
  let preceding = ref;
  for (const stage of stages) {
    if (preceding === post) throw new PreconditionError('the terminal spend has the wrong escrow lineage');
    const child = await scriptInfo(session, txOf(preceding));
    const outputs = child.outputs.filter((out) => out.credential === credential);
    const parents = child.inputs.filter((input) => input.credential === credential);
    const parent = parents.length === 1 ? parents[0]!.ref : undefined;
    const spend = parent === undefined ? undefined : spendOf(child, credential, parent, stage, stage === REDEEMER.Submit ? 1 : 0);
    if (outputs.length !== 1 || outputs[0]!.ref !== preceding || spend === undefined || parent === undefined) {
      throw new PreconditionError('no input of the transaction descends from escrow_ref by the verified spend chain');
    }
    const committed = spend.fields[0];
    if (stage === REDEEMER.Submit && (!isObject(committed) || committed.bytes !== receiptHashOf(datum))) {
      throw new PreconditionError('the Submit redeemer does not match the receipt commitment of the Submitted datum');
    }
    preceding = parent;
  }
  if (preceding !== post) throw new PreconditionError('no input of the transaction descends from escrow_ref by the verified spend chain');
}

function receiptHashOf(datum: IdentityEscrowDatum): string {
  const hash = datum.result_receipt_hash;
  if (datum.state !== 'Submitted' || hash === null || !HASH.test(hash)) throw new PreconditionError('the actual Submitted escrow has no receipt commitment');
  return hash;
}

interface CheckedTerminal {
  readonly proof: TerminalSpend;
  readonly receiptHash: string | null;
}

/** Verify the ledger's successful terminal redeemer and the exact sequence of escrow inputs. */
async function terminalSpend(session: EvidenceSession, hire: HireEntry, tx: string, action: TerminalSpend['action'],
    payment?: Extract<VaultPayment, { paid: true }>): Promise<CheckedTerminal> {
  const { escrow } = session.chain.deployment;
  const info = await scriptInfo(session, tx);
  const inputs = info.inputs.filter((row) => row.credential === escrow.hash);
  const spent = inputs.length === 1 ? inputs[0]!.ref : undefined;
  if (spent === undefined || !checkedSpend(info, escrow.hash, spent, REDEEMER[action], 0)) {
    throw new PreconditionError(`the named transaction does not spend the escrow with a successful ${action}`);
  }
  const row = await outputOf(session, spent);
  const datum = decodeIdentityEscrowDatum(row.inline_datum?.bytes ?? '');
  if (row.address !== escrow.address || row.is_spent !== true) throw new PreconditionError('the exact escrow input is not spent');
  const expected = action === 'Reclaim' ? datum.state === 'Open' || datum.state === 'Claimed' : datum.state === 'Submitted';
  if (!expected || (payment !== undefined && (datum.state !== 'Open' || spent !== hire.escrow_ref))) {
    throw new PreconditionError('the terminal spend has the wrong escrow state');
  }
  await verifyEscrowAncestry(session, hire.escrow_ref, spent, datum);
  if (action === 'Release' && (datum.submitted_at === null || info.timeMs < datum.submitted_at + ACCEPT_WINDOW_MS)) {
    throw new PreconditionError('the release is before the end of the accept window');
  }
  const refund_outputs = payment === undefined ? [] : await vaultRefund(session, payment, row, datum, info);
  await confirmed(session, tx);
  return { proof: { action, tx, spent_output: spent, at: info.timeMs, refund_outputs }, receiptHash: action === 'Reclaim' ? null : receiptHashOf(datum) };
}

interface EscrowHistory {
  readonly submitted: string | null;
  readonly terminal: { readonly type: string; readonly tx: string } | null;
}
type DiscoverEscrow = (ref: string) => Promise<EscrowHistory | null>;

/** The indexer gives candidate references only. Share the read between receipt and release checks. */
function escrowDiscovery(session: Session): DiscoverEscrow {
  const known = new Map<string, Promise<EscrowHistory | null>>();
  return (ref) => {
    let found = known.get(ref);
    if (found === undefined) {
      found = discoverEscrowHistory(session, ref);
      known.set(ref, found);
    }
    return found;
  };
}

async function discoverEscrowHistory(session: Session, ref: string): Promise<EscrowHistory | null> {
  const response = await session.fetchImpl(`${session.extra.indexer}/escrows/${encodeURIComponent(ref)}/lineage`, {
    method: 'GET', headers: { accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(INDEXER_TIMEOUT_MS),
  });
  if (response.status === 404) return null;
  if (response.status !== 200) throw new PreconditionError(`escrow lineage lookup returned HTTP ${response.status}`);
  const text = await response.text();
  if (text.length > HISTORICAL_OUTPUT_MAX) throw new PreconditionError('escrow lineage lookup exceeds its size limit');
  let body: unknown;
  try { body = JSON.parse(text); } catch { throw new PreconditionError('escrow lineage lookup gives no JSON'); }
  if (!isObject(body) || body.original_ref !== ref || !Array.isArray(body.rows)) throw new PreconditionError('escrow lineage lookup did not identify this escrow');
  const submissions = body.rows.filter((row: unknown): row is Obj => isObject(row) && row.state === 'Submitted');
  const candidate = submissions[0]?.utxo_ref;
  if (submissions.length > 1 || (submissions.length === 1 && (typeof candidate !== 'string' || !REF.test(candidate)))) {
    throw new PreconditionError('escrow lineage lookup did not identify one Submitted output');
  }
  const submitted = typeof candidate === 'string' ? candidate : null;
  const terminal = body.terminal;
  if (terminal === null) return { submitted, terminal: null };
  if (!isObject(terminal) || typeof terminal.tx_hash !== 'string' || !HASH.test(terminal.tx_hash) || typeof terminal.type !== 'string') {
    throw new PreconditionError('escrow lineage lookup did not identify a terminal transaction');
  }
  return { submitted, terminal: { type: terminal.type, tx: terminal.tx_hash } };
}

async function readRelease(session: Session, hire: HireEntry, discover: DiscoverEscrow): Promise<TerminalSpend | null> {
  if (hire.accept_tx !== null || hire.reclaim_tx !== null) return null;
  const terminal = (await discover(hire.escrow_ref))?.terminal;
  return terminal?.type === 'ReleaseEscrow' ? (await terminalSpend(session, hire, terminal.tx, 'Release')).proof : null;
}

interface LiveSubmission { readonly ref: string; readonly receiptHash: string | null }

async function readSubmittedReceipt(session: EvidenceSession, post: string, submitted: string, live: LiveSubmission | null): Promise<string> {
  const out = await outputOf(session, submitted);
  if (out.address !== session.chain.deployment.escrow.address || typeof out.is_spent !== 'boolean') {
    throw new PreconditionError('the actual Submitted escrow output is not known');
  }
  const datum = decodeIdentityEscrowDatum(out.inline_datum?.bytes ?? '');
  const hash = receiptHashOf(datum);
  if (live !== null && (live.ref !== submitted || live.receiptHash !== hash || out.is_spent)) {
    throw new PreconditionError('the live Submitted receipt commitment differs on the node and in Koios');
  }
  await verifyEscrowAncestry(session, post, submitted, datum);
  await confirmed(session, txOf(submitted));
  return hash;
}

/** The file holds the exact text passed as payload, not a reconstruction from a result or a receipt. */
function committedExecute(session: EvidenceSession, record: RunRecord, hire: HireEntry, promptHash: string): CommittedExecute | undefined {
  const state = realpathSync(session.settings.stateDir);
  const dir = join(state, 'runs', record.label);
  const path = join(dir, `${hire.step}.request.json`);
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new PreconditionError('the exact request file cannot be opened');
  }
  try {
    if (realpathSync(dir) !== dir || (lstatSync(dir).mode & 0o777) !== 0o700) throw new PreconditionError('the request folder must be private and not a link');
    const file = fstatSync(fd);
    if (!file.isFile() || file.nlink !== 1 || (file.mode & 0o777) !== 0o600 || file.size < 1 || file.size > MAX_REQUEST_BYTES
        || (process.getuid !== undefined && file.uid !== process.getuid())) throw new PreconditionError('the request must be a bounded private file with mode 600');
    const bytes = Buffer.allocUnsafe(file.size + 1);
    let length = 0;
    for (let n; length < bytes.length && (n = readSync(fd, bytes, length, bytes.length - length, null)) > 0;) length += n;
    if (length !== file.size) throw new PreconditionError('the request file changed during the read');
    let payload: string;
    let json: unknown;
    try {
      payload = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, length));
      json = JSON.parse(payload) as unknown;
    } catch { throw new PreconditionError('the request is not UTF-8 JSON text'); }
    // The wire helper applies NFC to strings. Do not accept an input with bytes that it would normalize.
    if (payload.normalize('NFC') !== payload || promptHashForPayload(payload) !== promptHash) throw new PreconditionError('the request text does not match the escrow prompt hash');
    const request = parseRequest(json);
    if (!request.ok || request.value.op !== 'execute' || request.value.tenant !== record.tenant) {
      throw new PreconditionError('the committed text is not an execute request for this tenant');
    }
    const { approval, proposal } = request.value;
    return { escrow_ref: hire.escrow_ref, digest: proposal.proposal_digest,
      approval: approval === null ? null : { attestation: approval.attestation, issuer_did: approval.issuer_did } };
  } finally { closeSync(fd); }
}

/** The public keys of the record of an agent on the node: its controller and each Ed25519 key that it lists. The record lists the supplier keys of the agent. */
async function recordKeysOf(session: EvidenceSession, fact: RecordFact): Promise<readonly string[]> {
  const found = await findRecord(session.chain.provider, session.chain.deployment, fact.id);
  if (found === null) throw new Error(`the record ${fact.did} is not in the identity registry`);
  return [found.record.controller, ...found.record.keys.filter((one) => one.keyType === 'Ed25519').map((one) => one.key)];
}

/**
 * The receipt of a hire is the account that the supplier gives of the job, so the task reads it against the chain. Its supplier_pkh is the one of the escrow datum, and its signature verifies with a key of the record
 * of the agent that hashes to that supplier_pkh (`verifyReceipt` of buyer-core: Ed25519 over the canonical receipt, by the rules of the ledger).
 */
async function checkReceipt(session: EvidenceSession, view: ReportedHire, posted: Obj, receiptHash: string, fact: RecordFact | undefined,
    keys: Map<string, Promise<readonly string[]>>, problems: Problems): Promise<void> {
  const member = `hires[${view.index}].report_file`;
  const supplier = posted.supplier_pkh;
  if (typeof supplier !== 'string' || view.report.receipt.supplier_pkh !== supplier) {
    problems.add(member, 'receipt.supplier_pkh is not the supplier_pkh of the escrow datum on the chain');
    return;
  }
  if (fact === undefined) return;
  const known = keys.get(fact.id) ?? recordKeysOf(session, fact);
  keys.set(fact.id, known);
  let listed: readonly string[];
  try { listed = await known; } catch (err) {
    problems.add(member, `the record of the agent cannot be read to find the key of the supplier (${shown(err)})`);
    return;
  }
  const key = listed.find((one) => keyHashOf(one) === supplier);
  if (key === undefined) {
    problems.add(member, 'no key of the record of the agent hashes to the supplier_pkh of the escrow, so the signature of the receipt cannot be verified');
    return;
  }
  const { checks } = verifyReceipt({
    receipt: view.report.receipt, signature: view.report.receipt_signature, escrowRef: view.entry.escrow_ref, result: view.report.result, supplierPubKeyHex: key, escrowSupplierPkh: supplier,
    escrowPromptHash: String(posted.prompt_hash), escrowAgentId: typeof posted.agent_id === 'string' ? posted.agent_id : null, resultReceiptHashOnChain: receiptHash,
  });
  for (const name of ['supplier_key_matches', 'signature_valid', 'prompt_hash_matches', 'on_chain_hash_matches'] as const) {
    if (checks[name].state !== 'pass') problems.add(member, `the check ${name} of the receipt fails: ${shown(checks[name].note)}`);
  }
}

async function checkHires(session: EvidenceSession, loaded: Loaded, facts: Readonly<Facts>, discover: DiscoverEscrow, problems: Problems): Promise<{
  terminals: ReadonlyMap<string, TerminalSpend>; committedApprovals: ReadonlyMap<string, CommittedApproval | null>;
  committedExecutes: ReadonlyMap<string, CommittedExecute>;
}> {
  const terminals = new Map<string, TerminalSpend>();
  const committedApprovals = new Map<string, CommittedApproval | null>();
  const committedExecutes = new Map<string, CommittedExecute>();
  const keys = new Map<string, Promise<readonly string[]>>();
  for (const view of loaded.hires) {
    const { entry, index } = view;
    const where = `hires[${index}]`;
    const agent = entry.agent;
    const adverts = facts.adverts[agent] ?? {};
    let payment: Extract<VaultPayment, { paid: true }> | undefined;
    if (view.report === null) {
      if (!Object.values(adverts).some((item) => item.ref === entry.advert_ref)) problems.add(`${where}.advert_ref`, `is not an advert of ${agent} in the facts`);
      const paid = await readPaidFromVault(session, loaded, entry);
      if (!paid.paid) problems.add(`${where}.post_tx`, `the chain does not show the hire as paid from the vault: ${paid.why}`);
      else payment = paid;
    } else {
      const model = String(view.report.receipt.model);
      if (adverts[model]?.ref !== entry.advert_ref) problems.add(`${where}.advert_ref`, `is not the advert in the facts for the agent ${agent} and the model ${model} of the receipt`);
    }
    let posted: Obj | null = null;
    let hasLive = false;
    let liveSubmitted: LiveSubmission | null = null;
    try {
      const lineage = await resolveEscrowLineage(session.chain.provider, session.chain.koiosUrl, entry.escrow_ref, session.chain.fetchImpl, session.chain.deployment);
      // The escrow datum has a layout of its own (identity or legacy): its members are read by name, and the identity layout is the one that holds an agent id.
      posted = lineage.posted as unknown as Obj;
      hasLive = lineage.current !== null || !lineage.spent;
      if (lineage.current?.datum.state === 'Submitted') {
        liveSubmitted = { ref: `${lineage.current.utxo.txHash}#${lineage.current.utxo.outputIndex}`, receiptHash: lineage.current.datum.result_receipt_hash };
      }
    } catch (err) { problems.add(`${where}.escrow_ref`, `the escrow cannot be read from the chain (${shown(err)})`); }
    if (posted === null) continue;
    const advertRef = isObject(posted.advert_ref) ? `${String(posted.advert_ref.txHash)}#${String(posted.advert_ref.index)}` : null;
    if (advertRef !== entry.advert_ref) problems.add(`${where}.advert_ref`, 'is not the advert that the escrow on the chain was posted for');
    const record = facts.records[agent];
    if (record === undefined || posted.agent_id !== record.id) problems.add(`${where}.escrow_ref`, `the escrow on the chain is not for the agent ${agent}`);
    let receiptHash: string | null = null;
    for (const member of ['accept_tx', 'reclaim_tx'] as const) {
      const end = entry[member];
      if (end === null) continue;
      if (hasLive) { problems.add(`${where}.${member}`, 'the escrow is not finished on the chain: it is not spent, or it has a live continuation'); continue; }
      if (view.report === null && payment === undefined) continue;
      try {
        const checked = await terminalSpend(session, entry, end, member === 'accept_tx' ? 'Accept' : 'Reclaim', payment);
        terminals.set(entry.escrow_ref, checked.proof);
        receiptHash = checked.receiptHash;
      } catch (err) { problems.add(`${where}.${member}`, `the spend of the escrow cannot be proved (${shown(err)})`); }
    }
    if (view.report === null) continue;
    if (receiptHash === null && entry.accept_tx === null && entry.reclaim_tx === null) {
      try {
        const submitted = liveSubmitted?.ref ?? (hasLive ? null : (await discover(entry.escrow_ref))?.submitted ?? null);
        if (submitted !== null) receiptHash = await readSubmittedReceipt(session, entry.escrow_ref, submitted, liveSubmitted);
      } catch (err) { problems.add(`${where}.report_file`, `the actual Submitted receipt cannot be read (${shown(err)})`); }
    }
    if (receiptHash === null) { problems.add(`${where}.report_file`, 'the actual Submitted escrow receipt commitment is unproven'); continue; }
    const beforeReceipt = problems.lines.length;
    await checkReceipt(session, view, posted, receiptHash, record, keys, problems);
    if (problems.lines.length === beforeReceipt && view.role === 'execute' && typeof posted.prompt_hash === 'string') {
      try {
        const request = committedExecute(session, loaded.record, entry, posted.prompt_hash);
        if (request !== undefined) {
          committedExecutes.set(entry.step, request);
          committedApprovals.set(entry.step, request.approval === null ? null : { ...request.approval, digest: request.digest });
        }
      } catch (err) { problems.add(`${where}.request`, `the exact execute request is unproven: ${shown(err)}`); }
    }
  }
  return { terminals, committedApprovals, committedExecutes };
}

// ---- 4. the delegations, the vaults and the approval ----

const EMPTY_READS: Reads = { delegations: [], vaults: [], subDelegations: [] };

/** Runs a read that must say true: a read that says false, and a read that fails, are each a problem of the member. */
async function mustHold(problems: Problems, member: string, rule: string, read: () => Promise<boolean>): Promise<void> {
  try { if (!(await read())) problems.add(member, rule); } catch (err) { problems.add(member, `${rule} (the transaction cannot be read: ${shown(err)})`); }
}

/** True when Koios shows that the transaction minted (`1n`) or burned (`-1n`) the token of the delegation `id`: the token has the id as its name, under the policy of the delegation script. */
async function movesDelegation(session: EvidenceSession, tx: string, id: string, quantity: bigint): Promise<boolean> {
  const policy = session.chain.deployment.delegation.hash;
  const info = await txInfoOf(session.fetchImpl, session.settings.urls.koios, tx);
  return info.minted.some((one) => one.policy === policy && one.name === id && one.quantity === quantity);
}

/**
 * True when a vault input of `startTx`, or of a transaction before it in the chain of vault outputs, satisfies `wanted`. A payment spends one vault output and makes the next one, and a close spends the last
 * output (a close can spend the outputs of several vaults), so the vault inputs of a transaction are followed back, at most DEPTH_OF_VAULT_CHAIN transactions deep.
 */
async function vaultInputsReach(session: EvidenceSession, startTx: string, wanted: (input: string) => boolean): Promise<boolean> {
  const credential = session.chain.deployment.vault.hash;
  const seen = new Set<string>();
  let level = [startTx];
  for (let depth = 0; depth < DEPTH_OF_VAULT_CHAIN && level.length > 0; depth += 1) {
    const before: string[] = [];
    for (const tx of level) {
      if (seen.has(tx)) continue;
      seen.add(tx);
      for (const input of (await txInfoOf(session.fetchImpl, session.settings.urls.koios, tx)).inputs) {
        if (input.credential !== credential) continue;
        if (wanted(input.ref)) return true;
        before.push(txOf(input.ref));
      }
    }
    level = before;
  }
  return false;
}

/** The transaction that opened the vault lineage that holds `vaultRef`: the first transaction of the chain of vault outputs behind it, which is the one that spends no vault output. A payment spends one. */
async function openingOf(session: EvidenceSession, vaultRef: string): Promise<string | null> {
  const credential = session.chain.deployment.vault.hash;
  let tx = txOf(vaultRef);
  for (let depth = 0; depth < DEPTH_OF_VAULT_CHAIN; depth += 1) {
    const spent = (await txInfoOf(session.fetchImpl, session.settings.urls.koios, tx)).inputs.filter((input) => input.credential === credential);
    if (spent.length === 0) return tx;
    if (spent.length > 1) return null;
    tx = txOf(spent[0]!.ref);
  }
  return null;
}

async function checkLedger(session: EvidenceSession, record: RunRecord, problems: Problems): Promise<Reads> {
  const env = envOf(session);
  const delegations: Array<Reads['delegations'][number]> = [];
  const vaults: Array<Reads['vaults'][number]> = [];
  const subDelegations: Array<Reads['subDelegations'][number]> = [];
  for (const [i, entry] of record.delegations.entries()) {
    await mustHold(problems, `delegations[${i}].tx`, 'does not mint the delegation token of the id', () => movesDelegation(session, entry.tx, entry.id, 1n));
    const endedTx = entry.ended_tx;
    if (endedTx !== null) await mustHold(problems, `delegations[${i}].ended_tx`, 'does not burn the delegation token of the id', () => movesDelegation(session, endedTx, entry.id, -1n));
    let live = false;
    try { live = (await readDelegation(env, entry.id)).chain.length > 0; } catch (err) { problems.add(`delegations[${i}].id`, `the delegation cannot be read (${shown(err)})`); continue; }
    if (entry.ended_tx === null && !live) problems.add(`delegations[${i}].id`, 'the ledger holds no live delegation with this id, and ended_tx is not set');
    if (entry.ended_tx !== null && live) problems.add(`delegations[${i}].ended_tx`, 'is set, and the ledger still holds the delegation as live');
    delegations.push({ ...entry, state: live ? 'live' : 'ended' });
  }
  for (const [i, entry] of record.sub_delegations.entries()) {
    await mustHold(problems, `sub_delegations[${i}].delegate_tx`, 'does not mint the delegation token of the id', () => movesDelegation(session, entry.delegate_tx, entry.id, 1n));
    await mustHold(problems, `sub_delegations[${i}].undelegate_tx`, 'does not burn the delegation token of the id', () => movesDelegation(session, entry.undelegate_tx, entry.id, -1n));
    try {
      if ((await readDelegation(env, entry.id)).chain.length > 0) problems.add(`sub_delegations[${i}].id`, 'the ledger still holds the sub-delegation as live: it must be ended');
    } catch (err) { problems.add(`sub_delegations[${i}].id`, `the sub-delegation cannot be read (${shown(err)})`); }
    subDelegations.push(entry);
  }
  for (const [i, entry] of record.vaults.entries()) {
    await mustHold(problems, `vaults[${i}].open_tx`, 'is not the transaction that opened the vault lineage of ref: the chain of vault outputs behind ref does not start with it', async () => (await openingOf(session, entry.ref)) === entry.open_tx);
    const closeTx = entry.close_tx;
    if (closeTx !== null) {
      await mustHold(problems, `vaults[${i}].close_tx`, 'does not spend the vault lineage of ref: no vault input of the transaction is ref, and none descends from it', () => vaultInputsReach(session, closeTx, (input) => input === entry.ref));
      await mustHold(problems, `vaults[${i}].close_tx`, 'makes an output at the vault script: a close leaves no vault output, so the vault is still Live', async () => !(await txInfoOf(session.fetchImpl, session.settings.urls.koios, closeTx)).outputs.some((output) => output.credential === session.chain.deployment.vault.hash));
      vaults.push({ ...entry, state: 'closed' });
      continue;
    }
    try {
      const page = await readVaults(env, { vaultRef: entry.ref }, session.clock.now());
      const found = page.items[0];
      if (page.items.length !== 1 || found === undefined || found.output.vault.type !== 'Live' || !found.onNode) problems.add(`vaults[${i}].ref`, 'the node holds no Live vault output at this reference, and close_tx is not set');
    } catch (err) { problems.add(`vaults[${i}].ref`, `the vault cannot be read (${shown(err)})`); }
    vaults.push({ ...entry, state: 'live' });
  }
  return { delegations, vaults, subDelegations };
}

async function verifiedRevoke(session: EvidenceSession, tx: string, issuedTx: string, id: string): Promise<number> {
  if (((await session.node.txStatus(tx)).confirmations ?? 0) < 1) throw new PreconditionError('the revocation is not confirmed');
  const contract = session.chain.deployment.attestation;
  const info = await txInfoOf(session.fetchImpl, session.settings.urls.koios, tx);
  const inputs = info.inputs.filter((one) => one.credential === contract.hash && txOf(one.ref) === issuedTx);
  if (inputs.length === 0) throw new PreconditionError('the revocation does not spend the transaction that issued the attestation');
  const rows = await koiosUtxoInfo(session.settings.urls.koios, inputs.map((one) => one.ref), session.fetchImpl, 512 * 1024);
  const spent = rows.filter((row) => row.address === contract.address && row.is_spent === true && inputs.some((one) => one.ref === `${row.tx_hash}#${row.tx_index}`)
    && row.asset_list?.some((asset) => isObject(asset) && asset.policy_id === contract.hash && asset.asset_name === id && (asset.quantity === '1' || asset.quantity === 1)));
  if (spent.length !== 1) throw new PreconditionError('the revocation does not spend the output of this attestation');
  return info.timeMs;
}

async function checkApprovals(session: Session, a: Assembly, problems: Problems): Promise<Array<ApprovalRead | null>> {
  const { record, hires } = a.loaded;
  const checked: Array<ApprovalRead | null> = [];
  for (const [i, entry] of record.approvals.entries()) {
    checked.push(null);
    const member = record.legacy ? 'approval' : `approvals[${i}]`;
    let expectations;
    let hire;
    let counterpartyStep;
    try {
      const module = session.extra.module;
      const step = module.hireOfApproval(a, i);
      hire = hires.find((one) => one.entry.step === step);
      counterpartyStep = module.approvalCounterparty?.(a, i);
    } catch (err) { problems.add(`${member}.hire`, `read_failed: ${shown(err)}`); continue; }
    try { expectations = session.extra.module.approvalExpectations?.(a, i); }
    catch (err) { problems.add(`${member}.digest`, `read_failed: ${shown(err)}`); continue; }
    const atMs = hire === undefined ? undefined : a.times.get(hire.entry.post_tx);
    const subject = hire === undefined ? undefined : a.facts.records[hire.entry.agent]?.did;
    if (hire === undefined || subject === undefined || atMs === undefined) {
      problems.add(`${member}.attestation`, 'the hire or the subject record or the block time of the hire is missing');
      continue;
    }
    const before = problems.lines.length;
    try {
      let link: ApprovalRead['link'] = entry.role === 'approval' ? 'unproven' : 'not_applicable';
      const request = a.committedApprovals.get(hire.entry.step);
      let requestIssuer: string | undefined;
      let digest = expectations?.digest;
      if (entry.role === 'approval') {
        if (request !== undefined) {
          if (request === null || request.attestation !== entry.attestation) problems.add(`${member}.hire`, 'the committed request names no approval or a different approval');
          else {
            link = 'request';
            requestIssuer = request.issuer_did;
            if (digest !== undefined && digest !== request.digest) problems.add(`${member}.digest`, 'the expected digest differs from the committed request');
            digest = request.digest;
          }
        }
        if (counterpartyStep !== undefined && counterpartyStep !== null) {
          const counterparty = hires.find((one) => one.entry.step === counterpartyStep);
          const handoff = hire.result?.handoff;
          const named = counterparty?.result?.approval;
          if (isObject(named) && isObject(handoff) && counterparty?.report !== null && handoff.escrow_ref === counterparty?.entry.escrow_ref) {
            if (named.attestation !== entry.attestation || (requestIssuer !== undefined && named.issuer_did !== requestIssuer)) {
              problems.add(`${member}.hire`, 'the linked signed confirmation names a different approval or issuer');
            } else if (typeof named.issuer_did === 'string' && /^did:vector:[0-9a-f]{64}$/.test(named.issuer_did)) {
              requestIssuer = named.issuer_did;
              if (link === 'unproven') link = 'counterparty_receipt';
            }
          }
        }
        if (link === 'unproven' && !session.extra.module.allowApprovalStateOnly) {
          problems.add(`${member}.hire`, 'approval use is unproven: there is no authenticated request that names this approval for this hire');
        }
      }
      const check = await checkAttestation(envOf(session), { id: entry.attestation, atMs, expect: {
        attType: entry.role === 'approval' ? 5 : 4, subject, ...(digest === undefined ? {} : { digest }),
        ...(expectations?.issuer === undefined ? {} : { issuer: expectations.issuer }),
      } });
      const view = check.attestation;
      if (view === null) { problems.add(`${member}.attestation`, 'no output of the attestation address holds the token of the approval'); continue; }
      const datum = view.attestation;
      if (requestIssuer !== undefined && requestIssuer !== `did:vector:${datum.issuerId ?? ''}`) {
        problems.add(`${member}.issuer`, 'the on-chain issuer differs from the issuer named for the hire');
      }
      const end = datum.validUntil;
      if (end === null) { problems.add(`${member}.validity`, 'the approval has no end of validity'); continue; }
      // The datum names the upper end of the issuance window. Read the actual issuance block in both input formats.
      const issuedBlock = await txTimeOf(session.fetchImpl, session.settings.urls.koios, entry.tx);
      if (issuedBlock > atMs) {
        problems.add(`${member}.tx`, 'the attestation is issued after the hire');
      }
      if (issuedBlock === atMs) problems.add(`${member}.tx`, 'the order of issuance and hire in the same block is unproven');
      const validity = end - (datum.validFrom ?? datum.issuedAt);
      const cap = expectations?.maxValidityMs;
      const slack = expectations?.clockSlackMs ?? 0;
      if (cap !== undefined && validity > cap + slack) problems.add(`${member}.validity`, `lasts ${validity} ms, and the approval of a run lasts at most ${cap} ms, and ${slack} ms more are allowed for the clocks of the tool and of the member`);
      if (entry.valid_until !== null && end !== entry.valid_until) problems.add(`${member}.valid_until`, 'is not the end of validity on the chain');
      const prior = datum.links.filter((link) => link.rel === 0);
      if (!record.legacy && (entry.supersedes === null ? prior.length !== 0 : prior.length !== 1 || prior[0]?.target !== entry.supersedes)) {
        problems.add(`${member}.supersedes`, 'does not match the supersedes link on the chain');
      }
      let revoked = false;
      if (datum.status.type === 'AttRevoked') {
        const tx = txOf(view.ref);
        if (entry.revoked_tx !== null && tx !== entry.revoked_tx) throw new PreconditionError('the revoked output is not from the named revocation');
        const blockTime = await verifiedRevoke(session, tx, entry.tx, entry.attestation);
        revoked = Math.max(datum.status.at, blockTime) <= atMs;
      } else if (txOf(view.ref) !== entry.tx) problems.add(`${member}.tx`, 'is not the transaction of the output that holds the approval on the chain');
      const actual = revoked ? 'revoked' : atMs > end ? 'expired' : 'active';
      const expected = entry.revoked_tx !== null ? 'revoked' : entry.valid_until !== null && atMs > entry.valid_until ? 'expired' : 'active';
      if (actual !== expected) problems.add(`${member}.attestation`, `the approval is ${actual} at its hire, not ${expected}`);
      for (const line of check.expectations) if (line.result === 'fail') problems.add(`${member}.${line.id}`, `${line.label}: ${line.detail}`);
      for (const line of check.conditions) {
        if (line.result !== 'fail' || (line.id === 'active' && datum.status.type === 'AttRevoked') || (line.id === 'time_window' && atMs > end
          && (datum.validFrom === null || atMs >= datum.validFrom) && atMs >= datum.issuedAt - 3_600_000)) continue;
        problems.add(`${member}.attestation`, `${line.label}: ${line.detail}`);
      }
      if (problems.lines.length === before) {
        checked[i] = { entry, hire: hire.entry.step, state: actual, type: datum.attType, subject, digest: datum.digest, issued_at: datum.issuedAt,
          valid_until: end, validity_ms: validity, checked_at: atMs, issued_block_at: issuedBlock, link };
      }
    } catch (err) { problems.add(`${member}.attestation`, `read_failed: ${shown(err)}`); }
  }
  return checked;
}

// ---- 5. the mock service ----

async function mockGet(session: EvidenceSession, tenant: string, what: 'log' | 'state'): Promise<unknown> {
  let response: Response;
  try {
    response = await session.fetchImpl(`${MOCK_PUBLIC_BASE}/t/${tenant}/${what}`, { method: 'GET', headers: { accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(MOCK_TIMEOUT_MS) });
  } catch (err) { throw new Error(`the call to the mock service failed (${shown(err)})`); }
  if (response.status !== 200) throw new Error(`the mock service answered HTTP ${response.status}`);
  const text = (await response.text()).slice(0, MOST_MOCK_CHARS);
  try { return JSON.parse(text) as unknown; } catch { throw new Error('the mock service answered with a body that is no JSON'); }
}

/** True when a line of the log names an agent of the run: an actor of its act chain is the DID of one, or its sub is the SPIFFE ID of one (spiffe://<trust domain>/agent/<identifier>). */
function namesAgentOfRun(line: Obj, ids: ReadonlySet<string>): boolean {
  const act = Array.isArray(line.act) ? line.act : [];
  if (act.some((one: unknown) => typeof one === 'string' && one.startsWith('did:vector:') && ids.has(one.slice('did:vector:'.length)))) return true;
  const spiffe = typeof line.sub === 'string' ? /^spiffe:\/\/[^/]+\/agent\/([0-9a-f]{64})$/.exec(line.sub) : null;
  return spiffe !== null && ids.has(spiffe[1]!);
}

async function readMock(session: Session, loaded: Loaded, facts: Readonly<Facts>, problems: Problems): Promise<MockRead | null> {
  const { tenant, label } = loaded.record;
  if (tenant === null) return null;
  if (facts.tenants[label]?.name !== tenant) problems.add('tenant', `is not the tenant that the facts hold for the run ${label}`);
  try {
    const log = await mockGet(session, tenant, 'log');
    const state = await mockGet(session, tenant, 'state');
    if (!isObject(log) || log.tenant !== tenant || !Array.isArray(log.lines) || typeof log.dropped !== 'number') { problems.add('mock.log', 'is not the log of the tenant that the mock service documents'); return null; }
    if (log.dropped > 0) problems.add('mock.log', `the mock service dropped ${log.dropped} line(s) of the log: the log is not whole`);
    const lines = log.lines;
    if (!lines.every(isObject)) { problems.add('mock.log', 'holds a line that is no object'); return null; }
    // A line is copied when it names an agent of the run. The log also holds the calls of callers that proved nothing and of callers with a valid token of their own, and the path of such a call is a text that the caller chose: the file counts such lines and never copies them.
    const ids = new Set<string>();
    for (const roster of [session.use.agents, session.use.subagents]) {
      for (const { id } of roster) {
        const record = facts.records[id];
        if (record !== undefined) ids.add(record.id);
      }
    }
    const routes = new Set(session.extra.module.mockRoutes);
    const attributed = lines.filter((line: Obj) => typeof line.route === 'string' && routes.has(line.route) && namesAgentOfRun(line, ids));
    if (!isObject(state) || state.tenant !== tenant) { problems.add('mock.state', 'is not the state of this tenant'); return null; }
    const counts = hook('mock.state', () => session.extra.module.counts(state));
    if (counts === null || Object.values(counts).some((value) => !Number.isSafeInteger(value) || value < 0)) {
      problems.add('mock.state', 'the state of the tenant does not have the expected counts');
      return null;
    }
    return { lines: structuredClone(attributed), unattributed: lines.length - attributed.length, counts, state };
  } catch (err) {
    problems.add('mock', shown(err));
    return null;
  }
}

// ---- 6. the fault guard ----

function faultEntries(session: EvidenceSession, label: string, problems: Problems): FaultEntry[] {
  const name = `fault.${label}.evidence.json`;
  let document: unknown;
  try { document = readJsonFile(join(session.settings.stateDir, name), `the file ${name}`); } catch (err) {
    problems.add('fault_check', `${shown(err)}: run the task fault with --check and --submit before and after the run`);
    return [];
  }
  if (!isObject(document) || document.check !== 'fault' || !Array.isArray(document.entries)) {
    problems.add('fault_check', `the file ${name} is not the evidence file of the task fault`);
    return [];
  }
  const found: FaultEntry[] = [];
  document.entries.forEach((entry: unknown, i) => {
    if (!isObject(entry) || entry.step !== 'fault_check') return;
    const shows = entry.shows;
    const atMs = typeof entry.at === 'string' ? Date.parse(entry.at) : Number.NaN;
    const services = isObject(shows) && Array.isArray(shows.services) ? shows.services : null;
    if (!isObject(shows) || Number.isNaN(atMs) || typeof shows.check !== 'string' || typeof shows.ok !== 'boolean' || services === null
      || !services.every((one: unknown) => isObject(one) && typeof one.service === 'string' && typeof one.started_at === 'string' && typeof one.value === 'string')) {
      problems.add('fault_check', `entry ${i} of the file ${name} has not the form of an entry of the task fault`);
      return;
    }
    found.push({ atMs, check: shows.check, agent: typeof shows.agent === 'string' ? shows.agent : null, ok: shows.ok, services: services as FaultEntry['services'] });
  });
  return found;
}

/** The services of the nearest entry before the first hire and of the nearest entry after the last hire must have one start time each: no service restarted in between. */
function sameStart(before: FaultEntry, after: FaultEntry, problems: Problems): void {
  const names = new Set([...before.services, ...after.services].map((one) => one.service));
  for (const name of names) {
    const first = before.services.find((one) => one.service === name);
    const last = after.services.find((one) => one.service === name);
    if (first === undefined || last === undefined) problems.add(`fault_check.services.${name}`, 'is in one of the two clean entries and not in the other');
    else if (first.started_at !== last.started_at) problems.add(`fault_check.services.${name}`, `started at ${first.started_at} in the clean entry before the first hire and at ${last.started_at} in the clean entry after the last hire: the service restarted during the run`);
  }
}

function checkFaults(session: EvidenceSession, loaded: Loaded, times: ReadonlyMap<string, number>, problems: Problems): readonly FaultEntry[] {
  const entries = faultEntries(session, loaded.record.label, problems);
  const services = new Map(session.use.agents.map((agent) => [agent.serviceContainer, agent]));
  for (const entry of entries) {
    const seen = new Set<string>();
    for (const line of entry.services) {
      const agent = services.get(line.service);
      if (agent === undefined || seen.has(line.service) || !Number.isFinite(Date.parse(line.started_at)) || Date.parse(line.started_at) > entry.atMs
        || (line.value !== '' && !agent.faultValues.includes(line.value))) {
        problems.add('fault_check.services', 'an entry has an unknown service, duplicate service, invalid start time or invalid fault value');
      }
      seen.add(line.service);
    }
    for (const name of services.keys()) if (!seen.has(name)) problems.add(`fault_check.services.${name}`, 'a fault entry does not cover this service');
  }
  const posts = loaded.record.hires.map((hire) => times.get(hire.post_tx)!);
  const all = loaded.record.hires.flatMap((hire) => [hire.post_tx, hire.accept_tx, hire.reclaim_tx]).filter((hash): hash is string => hash !== null).map((hash) => times.get(hash)!);
  if (posts.some((time) => time === undefined) || all.some((time) => time === undefined)) return entries;
  const firstPost = Math.min(...posts);
  const lastTx = Math.max(...all);
  const clean = entries.filter((entry) => entry.ok && entry.check === 'clean' && entry.services.every((one) => one.value === ''));
  const before = clean.filter((entry) => entry.atMs <= firstPost).sort((a, b) => b.atMs - a.atMs)[0];
  const after = clean.filter((entry) => entry.atMs >= lastTx).sort((a, b) => a.atMs - b.atMs)[0];
  if (before === undefined) problems.add('fault_check', `no passing clean entry at or before the block time of the first post transaction of the run (${iso(firstPost)})`);
  if (after === undefined) problems.add('fault_check', `no passing clean entry at or after the block time of the last transaction of the last hire (${iso(lastTx)})`);
  if (loaded.record.kind === 'clean' && before !== undefined && after !== undefined) sameStart(before, after, problems);
  return entries;
}

// ---- 7. the case of the jury and the hold ----

/** A row of the list of the indexer: the case, and whether the indexer calls it the canonical case of its dispute. */
interface IndexedRow { readonly canonical: boolean; readonly view: IndexedCase }

/** The last fenced json block of the text of a tool, as it is: the cases of the jury are a list, and the `json` of a tool answer holds an object only. */
function lastJsonBlock(text: string): unknown {
  const block = [...text.matchAll(/```json\n([\s\S]*?)\n```/g)].at(-1);
  if (block === undefined) return undefined;
  try { return JSON.parse(block[1]!) as unknown; } catch { return undefined; }
}

const text = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);
const count = (value: unknown): number | null => (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null);

function caseViewOf(row: Obj): CaseView | null {
  const tally = row.tally;
  if (!isObject(tally)) return null;
  const claimer = count(tally.claimer); const auditor = count(tally.auditor); const inconclusive = count(tally.inconclusive); const revealed = count(row.revealed);
  const [jury, token, output, claimOut, challengeOut, phase, state, outcome] = [row.jury, row.case_token, row.utxo, row.claim_out, row.challenge_out, row.phase, row.state, row.outcome].map(text);
  if (claimer === null || auditor === null || inconclusive === null || revealed === null || [jury, token, output, claimOut, challengeOut, phase, state, outcome].includes(null)) return null;
  if (!VERDICTS.includes(outcome!) || !SCRIPT_HASH.test(jury!) || !HASH.test(token!) || ![output, claimOut, challengeOut].every((ref) => REF.test(ref!))) return null;
  return {
    jury: jury!, case_token: token!, case_output: output!, claim_out: claimOut!, challenge_out: challengeOut!, canonical: typeof row.canonical === 'boolean' ? row.canonical : null,
    phase: phase!, state: state!, tally: { claimer, auditor, inconclusive }, revealed, outcome: outcome!,
  };
}

const hashOrNull = (value: unknown): string | null => (typeof value === 'string' && HASH.test(value) ? value : null);
const verdictOrNull = (value: unknown): string | null => (typeof value === 'string' && VERDICTS.includes(value) ? value : null);

/** The row of a case in the list of the marketplace indexer, or null when a member that this task reads has not its form. The tally of the indexer is named by the votes. */
function indexedCaseOf(row: Obj): IndexedRow | null {
  const { tally, opened, finalized, closed } = row;
  if (!isObject(tally) || !isObject(opened) || typeof row.canonical !== 'boolean') return null;
  const claimer = count(tally.ClaimerWins); const auditor = count(tally.AuditorWins); const inconclusive = count(tally.Inconclusive); const revealed = count(row.revealed);
  const jury = text(row.script_hash); const window = text(row.window); const token = hashOrNull(row.case); const openedTx = hashOrNull(opened.tx);
  const state = row.state === 'open' || row.state === 'settling' || row.state === 'closed' ? row.state : null;
  const result = row.result === null ? null : verdictOrNull(row.result);
  const final = finalized === null ? null : isObject(finalized) && hashOrNull(finalized.tx) !== null && verdictOrNull(finalized.result) !== null ? finalized : undefined;
  const burned = closed === null ? null : isObject(closed) && hashOrNull(closed.tx) !== null ? closed : undefined;
  if (claimer === null || auditor === null || inconclusive === null || revealed === null || jury === null || !SCRIPT_HASH.test(jury) || window === null || token === null || openedTx === null || state === null
    || (row.result !== null && result === null) || final === undefined || burned === undefined) return null;
  return {
    canonical: row.canonical,
    view: {
      jury, case_token: token, state, window, tally: { claimer, auditor, inconclusive }, revealed, result, opened_tx: openedTx,
      finalized_tx: final === null ? null : hashOrNull(final.tx), finalized_result: final === null ? null : verdictOrNull(final.result), closed_tx: burned === null ? null : hashOrNull(burned.tx),
    },
  };
}

/** The cases of one challenge that the marketplace indexer follows (GET /jury/cases?challenge=<token>). The read sends no header but the accept header, and the list holds no secret. */
async function indexerCases(session: EvidenceSession, token: string): Promise<readonly unknown[]> {
  let body: string;
  try {
    const response = await session.fetchImpl(`${session.extra.indexer}/jury/cases?challenge=${token}`, { method: 'GET', headers: { accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(INDEXER_TIMEOUT_MS) });
    if (response.status !== 200) throw new HostedError('unreachable', `the marketplace indexer answered HTTP ${response.status}`);
    body = await response.text();
  } catch (err) {
    if (err instanceof HostedError) throw err;
    throw new HostedError('unreachable', `the call to the marketplace indexer failed (${shown(err)})`);
  }
  if (body.length > MOST_INDEXER_CHARS) throw new HostedError('protocol', `the marketplace indexer answered with more than ${MOST_INDEXER_CHARS} characters`);
  let parsed: unknown;
  try { parsed = JSON.parse(body) as unknown; } catch { throw new HostedError('protocol', 'the marketplace indexer answered with a body that is no JSON'); }
  if (!isObject(parsed) || !Array.isArray(parsed.cases)) throw new HostedError('protocol', 'the answer of the marketplace indexer holds no list cases');
  return parsed.cases as unknown[];
}

/**
 * The canonical case of the challenge in the list of the indexer, or null. The list is the one of the challenge token, and a case in it must name the claim token that the facts hold and the challenge output that the
 * result holds. A case that is not canonical is not the case of the dispute, because the relay resolves the dispute with its canonical case only.
 */
async function readIndexed(session: EvidenceSession, claim: ClaimFact, challenge: Challenge, token: string): Promise<IndexedCase | null> {
  const rows = (await indexerCases(session, token)).filter((row): row is Obj => isObject(row) && row.challenge === token && row.claim === claim.claimToken && row.challenge_out === challenge.challenge);
  const parsed = rows.map(indexedCaseOf);
  if (parsed.includes(null)) throw new HostedError('protocol', 'a case in the answer of the marketplace indexer has not the form that the indexer documents');
  const canonical = (parsed as IndexedRow[]).filter((one) => one.canonical);
  if (canonical.length > 1) throw new HostedError('protocol', 'the marketplace indexer lists more than one canonical case of the challenge');
  const view = canonical[0]?.view ?? null;
  if (view !== null && view.result !== null && view.finalized_result !== null && view.result !== view.finalized_result) {
    throw new PreconditionError('the marketplace indexer shows a result of the tally that is not the result of the Finalize transaction');
  }
  return view;
}

/** The transactions that the indexer names for the case, each with the member that names it: they are confirmed on the node like every other transaction of the file. */
function caseTransactions(indexed: IndexedCase): Map<string, string> {
  const txs = new Map<string, string>();
  for (const [member, hash] of [['case.opened_tx', indexed.opened_tx], ['case.finalized_tx', indexed.finalized_tx], ['case.closed_tx', indexed.closed_tx]] as const) {
    if (hash !== null && !txs.has(hash)) txs.set(hash, member);
  }
  return txs;
}

/**
 * Read the scripted jury hold on the challenged agent. A hold that began before the challenge is not evidence of this verdict.
 */
export async function readHold(session: EvidenceSession, facts: Readonly<Facts>, agent: string, challengeAt: () => Promise<number>): Promise<Hold | null> {
  const fact = facts.records[agent];
  if (fact === undefined) throw new PreconditionError(`the facts hold no record of the agent ${agent}`);
  const found = await findRecord(session.chain.provider, session.chain.deployment, fact.id);
  if (found === null) throw new PreconditionError(`the record ${fact.did} is not in the identity registry`);
  const status = found.record.status;
  const scripted = status.type === 'Suspended' ? status.holds.filter((one) => one.reason === JURY_HOLD_REASON && one.by.type === 'Script') : [];
  if (scripted.length === 0) return null;
  const since = await challengeAt();
  const hold = scripted.filter((one) => one.since >= since).sort((a, b) => b.until - a.until)[0];
  if (hold === undefined) return null;
  const answer = await session.hosted.call('vector_resolve_did', { did: fact.did });
  const vector = isObject(answer.json?.didDocumentMetadata) ? answer.json.didDocumentMetadata.vectorStatus : undefined;
  const effective = isObject(vector) ? text(vector.effective) : null;
  if (answer.failed || effective === null) throw new PreconditionError('the status of the held record cannot be read from the resolver');
  return { reason: hold.reason, since: hold.since, until: hold.until, record_output: `${found.utxo.txHash}#${found.utxo.outputIndex}`, gateway_status: effective };
}

const CHALLENGE_TOKEN = /^63686c5f[0-9a-f]{56}$/;

/** The token of a challenge: the one asset with the quantity 1 and a name that starts with chl_ (63686c5f in hex) that the transaction of the challenge minted. */
function challengeAsset(minted: TxInfo['minted']): TxInfo['minted'][number] {
  const found = minted.filter((one) => one.quantity === 1n && CHALLENGE_TOKEN.test(one.name));
  if (found.length !== 1) throw new PreconditionError(`challenge.challenge: the transaction of the challenge minted ${found.length} tokens of the challenge, and it must mint exactly one (the quantity 1, a name that starts with 63686c5f)`);
  return found[0]!;
}

/** Authenticate the case used by a historical hold. The indexer locates the opening and the Finalize. */
async function historicalCase(session: EvidenceSession, indexed: IndexedCase | null, claim: ClaimFact,
    challenge: Challenge, token: string, subject: string): Promise<number> {
  if (indexed?.finalized_tx == null) throw new PreconditionError('the historical case has no identifiable Finalize transaction');
  const { jury, case_token: caseToken } = indexed;
  const finalize = await scriptInfo(session, indexed.finalized_tx);
  const input = finalize.inputs.filter((one) => one.credential === jury);
  if (input.length !== 1 || !checkedSpend(finalize, jury, input[0]!.ref, 1, 1)) throw new PreconditionError('the case did not end with a successful jury spend');
  const redeemer = finalize.spends.find((run) => run.script === jury && (run.input === input[0]!.ref || run.input === null))!;
  const vote = constrFields(dataOfKoiosJson(redeemer.fields[0]), 'Finalize', 2, 1)[0];
  constrFields(vote, 'AuditorWins', 1, 0);
  const open = await scriptInfo(session, indexed.opened_tx);
  if (!open.minted.some((asset) => asset.policy === jury && asset.name === caseToken && asset.quantity === 1n)) {
    throw new PreconditionError('the opening did not mint the case token');
  }
  const outputs = open.outputs.filter((one) => one.credential === jury).map((one) => one.ref);
  const rows = await koiosUtxoInfo(session.settings.urls.koios, outputs, session.fetchImpl, HISTORICAL_OUTPUT_MAX);
  const opening = rows.filter((row) => outputs.includes(fromOutput(row)) && hasToken(row, jury, caseToken));
  if (opening.length !== 1) throw new PreconditionError('the exact case opening output is unproven');
  for (const row of [opening[0]!, await outputOf(session, input[0]!.ref)]) {
    const datum = decodeJuryDatum(row.inline_datum?.bytes ?? '');
    if (row.payment_cred !== jury || !hasToken(row, jury, caseToken) || datum.type !== 'Case' || datum.case.challenge !== token
      || datum.case.claim !== claim.claimToken || `${datum.case.challengeOut.txHash}#${datum.case.challengeOut.outputIndex}` !== challenge.challenge
      || datum.case.claimer !== subject) throw new PreconditionError('the ledger case, jury or challenge identity differs');
  }
  await confirmed(session, indexed.opened_tx);
  await confirmed(session, indexed.finalized_tx);
  return finalize.timeMs;
}

function hasToken(row: KoiosUtxo, policy: string, name: string): boolean {
  const assets = assetsOf(row).filter((asset) => asset.policy === policy);
  return assets.length === 1 && assets[0]!.name === name && assets[0]!.quantity === 1n;
}

/** Confirm the application of the verdict of this dispute to the exact identity record output. */
async function verifyHistoricalHold(session: EvidenceSession, a: Assembly, candidate: Hold & { readonly verdict_output: string },
    challenge: Challenge, claim: ClaimFact, asset: TxInfo['minted'][number], indexed: IndexedCase | null): Promise<Hold> {
  const subject = a.facts.records[challenge.agent]?.id;
  if (subject === undefined || indexed?.finalized_tx == null || !REF.test(candidate.verdict_output)) {
    throw new PreconditionError('the historical hold has no exact verdict output or Finalize');
  }
  const finalizeAt = await historicalCase(session, indexed, claim, challenge, asset.name, subject);
  const verdict = await outputOf(session, candidate.verdict_output);
  const [owner, action, , linked] = constrFields(decodePlutusData(verdict.inline_datum?.bytes ?? ''), 'verdict', 0, 6);
  constrFields(action, 'Suspend', 0, 0);
  const linkedRef = outRefOf(linked, 'verdict.challenge');
  const policy = verdict.payment_cred;
  const token = assetsOf(verdict).find((one) => one.policy === policy)?.name;
  const configured = await findConfigRecord(session.chain.provider, session.chain.deployment);
  if (configured === null || policy !== configured.m1) throw new PreconditionError('the verdict does not use the configured Module-1 policy');
  if (bytesOf(owner, 'verdict.subject', 32) !== subject || `${linkedRef.txHash}#${linkedRef.outputIndex}` !== challenge.challenge
    || verdict.is_spent !== true || typeof policy !== 'string' || typeof token !== 'string' || !HASH.test(token) || !hasToken(verdict, policy, token)) {
    throw new PreconditionError('the verdict output does not authorize a hold of this challenge and record');
  }
  const resolveTx = txOf(candidate.verdict_output);
  const resolved = await scriptInfo(session, resolveTx);
  const challengeOutput = await outputOf(session, challenge.challenge);
  if (challengeOutput.payment_cred !== asset.policy || challengeOutput.is_spent !== true || !hasToken(challengeOutput, asset.policy, asset.name)
    || !checkedSpend(resolved, asset.policy, challenge.challenge, 2, 2)
    || !resolved.outputs.some((one) => one.ref === candidate.verdict_output && one.credential === policy)
    || !resolved.minted.some((one) => one.policy === policy && one.name === token && one.quantity === 1n)
    || resolved.timeMs < finalizeAt) throw new PreconditionError('the verdict is not from the resolution of the matched challenge');
  const oracle = resolved.spends.find((one) => one.script === asset.policy && (one.input === challenge.challenge || one.input === null))!;
  constrFields(dataOfKoiosJson(oracle.fields[0]), 'AuditorWins', 1, 0);
  const reasoning = bytesOf(dataOfKoiosJson(oracle.fields[1]), 'OracleResolve.reasoning_hash', 32);
  const doc = await readDocument(documentUri(resolveTx), { koiosUrl: session.settings.urls.koios, fetchImpl: session.fetchImpl });
  if (doc.type !== 'resolution' || doc.hash !== reasoning || doc.bytes.length > 15_000) {
    throw new PreconditionError('the committed resolution document is unproven');
  }
  let body: unknown;
  try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(doc.bytes)); }
  catch { throw new PreconditionError('the committed resolution document is not UTF-8 JSON'); }
  if (!isObject(body) || body.type !== 'vector-jury-resolution/1' || body.basis !== 'jury' || body.verdict !== 'AuditorWins'
    || body.challenge_out !== challenge.challenge || body.challenge !== asset.name || body.claim !== claim.claimToken || !isObject(body.jury)
    || body.jury.deployment !== indexed.jury || body.jury.case !== indexed.case_token
    || body.jury.opened_in !== indexed.opened_tx || body.jury.finalized_in !== indexed.finalized_tx) {
    throw new PreconditionError('the committed resolution document names a different jury, case or challenge');
  }

  const { identity } = session.chain.deployment;
  const record = await outputOf(session, candidate.record_output);
  const datum = decodeIdentityDatum(record.inline_datum?.bytes ?? '');
  const applyTx = txOf(candidate.record_output);
  const applied = await scriptInfo(session, applyTx);
  const records = applied.inputs.filter((one) => one.credential === identity.hash);
  if (record.address !== identity.address || !hasToken(record, identity.hash, subject)
    || !applied.outputs.some((one) => one.ref === candidate.record_output && one.credential === identity.hash)
    || records.length !== 1 || !checkedSpend(applied, identity.hash, records[0]!.ref, 2, 1)
    || !applied.inputs.some((one) => one.ref === candidate.verdict_output && one.credential === policy)
    || !applied.minted.some((one) => one.policy === policy && one.name === token && one.quantity === -1n)
    || applied.timeMs < resolved.timeMs || candidate.since > applied.timeMs || datum.status.type !== 'Suspended'
    || !datum.status.holds.some((hold) => hold.by.type === 'Script' && hold.by.hash === policy && hold.reason === JURY_HOLD_REASON
      && hold.since === candidate.since && hold.until === candidate.until)) {
    throw new PreconditionError('the confirmed verdict application does not show this exact record hold');
  }
  await confirmed(session, resolveTx);
  await confirmed(session, applyTx);
  return { reason: JURY_HOLD_REASON, since: candidate.since, until: candidate.until, record_output: candidate.record_output, gateway_status: null };
}

async function readCase(session: Session, a: Assembly, challenge: Challenge): Promise<CaseRead> {
  const agent = session.use.agents.find((one) => one.id === challenge.agent)!;
  const claim = a.facts.claims[a.loaded.record.label]?.[agent.id];
  if (claim === undefined || challenge.claim !== claim.claimRef) throw new PreconditionError(`challenge.claim: is not the claim that the facts hold for the agent ${agent.id} in the run ${a.loaded.record.label}`);
  const answer = await session.hosted.call('vector_get_jury_cases', { claim: claim.claimToken });
  if (answer.failed) throw new HostedError('unreachable', `the hosted tool vector_get_jury_cases failed: ${shown(answer.message)}`);
  const rows = lastJsonBlock(answer.text);
  if (!Array.isArray(rows)) throw new HostedError('protocol', 'the answer of vector_get_jury_cases holds no list of cases');
  // The tool filters by the claim token. The claim_out of a case is the Challenged claim output that the opening read, and the challenge spent the Open one: the two never match. The challenge output names the case.
  const matching = rows.filter((row: unknown): row is Obj => isObject(row) && row.challenge_out === challenge.challenge && row.claim === claim.claimToken);
  const views = matching.map(caseViewOf);
  if (views.includes(null)) throw new HostedError('protocol', 'a case in the answer of vector_get_jury_cases has not the form that the tool documents');
  // A case that is not the canonical case of its dispute is no case of this run: the relay resolves the dispute with its canonical case only.
  const eligible = (views as CaseView[]).filter((view) => view.canonical !== false);
  const canonical = eligible.filter((view) => view.canonical === true);
  const listed = eligible.length === 1 ? eligible[0]! : canonical.length === 1 ? canonical[0]! : null;
  if (eligible.length > 1 && listed === null) throw new HostedError('protocol', 'the answer of vector_get_jury_cases lists more than one case of the challenge, and none is the canonical case');
  let known: Promise<TxInfo> | undefined;
  const challengeInfo = (): Promise<TxInfo> => (known ??= txInfoOf(session.fetchImpl, session.settings.urls.koios, txOf(challenge.challenge)));
  const blockTime = async (): Promise<number> => {
    try { return (await challengeInfo()).timeMs; } catch (err) {
      throw new PreconditionError(`challenge.challenge: the block time of the challenge cannot be read (${shown(err)})`);
    }
  };
  let asset: TxInfo['minted'][number] | null = null;
  try { asset = challengeAsset((await challengeInfo()).minted); } catch (err) { if (!(err instanceof UnknownTransactionError)) throw err; }
  if (asset !== null && matching.some((row) => row.challenge !== asset!.name)) throw new PreconditionError('the hosted case names a different challenge token');
  const indexed = asset === null ? null : await readIndexed(session, claim, challenge, asset.name);
  if (listed !== null && indexed !== null && (listed.case_token !== indexed.case_token || listed.jury !== indexed.jury)) {
    throw new PreconditionError('the hosted tool and the indexer name different case or jury identities for the challenge');
  }
  const fromTool = asset !== null && listed !== null && listed.state === 'Settling' ? listed.outcome : null;
  const fromIndexer = indexed?.finalized_result ?? null;
  if (fromTool !== null && fromIndexer !== null && fromTool !== fromIndexer) throw new PreconditionError(`the hosted tool shows the result ${fromTool} and the marketplace indexer shows the result ${fromIndexer} for the case of the challenge`);
  const verdict = fromIndexer ?? fromTool;
  const observed = new Set<Hold>();
  let candidate: HoldCandidate | null;
  let hold: Hold | null = null;
  try {
    candidate = await session.extra.module.holdOf(a, { challenge, listed, indexed, blockTime, readRecordHold: async () => {
      const current = await readHold(session, a.facts, agent.id, blockTime);
      if (current !== null) observed.add(Object.freeze(current));
      return current;
    } });
    if (candidate !== null) {
      if (!REF.test(candidate.record_output) || candidate.reason !== JURY_HOLD_REASON || !Number.isSafeInteger(candidate.since) || !Number.isSafeInteger(candidate.until)
        || candidate.since < await blockTime() || candidate.until <= candidate.since) throw new PreconditionError('no matching jury hold for this challenge');
      if (observed.has(candidate)) {
        await confirmed(session, txOf(candidate.record_output));
        hold = candidate;
      } else if (verdict === 'AuditorWins' && asset !== null && 'verdict_output' in candidate) {
        hold = await verifyHistoricalHold(session, a, candidate, challenge, claim, asset, indexed);
      } else throw new PreconditionError('the historical hold has no verified link to the case verdict');
    }
  } catch (err) { throw new PreconditionError(`hold.read_failed: ${shown(err)}`); }
  let waiting: string | null = null;
  if (verdict === null || (verdict === 'AuditorWins' && hold === null)) {
    let expected = 'about 4 h 44 min after the challenge';
    try {
      const at = (await blockTime()) + CASE_DURATION_MS;
      const nowMs = session.clock.now();
      expected = at > nowMs ? `expected at ${iso(at)}, in ${duration(at - nowMs)}` : `expected at ${iso(at)}, and that time has passed`;
    } catch { /* The known absence of the challenge transaction leaves only the expected duration. */ }
    const lead = verdict !== null ? `the jury decided AuditorWins, and the hold is not yet on the record of ${agent.name}`
      : hold === null ? 'the case of the challenge has no verdict' : `the case of the challenge has no verdict, and the hold on the record of the ${agent.name} is no proof of one`;
    waiting = `${lead}. The relay opens a case about 30 minutes after the challenge, the jurors commit for 2 hours and reveal for 2 hours, and then the relay finalises and resolves it: the hold comes ${expected}`;
  }
  return { listed, indexed, hold, verdict: waiting === null ? verdict : null, waiting };
}

// ---- the steps ----

export interface StepEntry { readonly id: string; readonly status: 'shown' | 'not_run'; readonly refs: readonly Ref[]; readonly note: string }

/** The steps of the data for the kind of the run. A step is shown only when its rule gives a reference. */
function stepsOf(a: Assembly, module: EvidenceModule, problems: Problems): StepEntry[] {
  const { kind } = a.loaded.record;
  return a.use.evidenceSteps.filter((step) => step.run === kind || (step.run === 'both' && kind !== 'lifecycle')).map((step): StepEntry => {
    const member = `steps.${step.id}`;
    const required = kind === 'lifecycle' ? module.lifecycleFacts?.[step.id] : undefined;
    if (kind === 'lifecycle' && (required === undefined || required.length === 0 || required.some((name) => !Object.hasOwn(a.facts.lifecycle, name)))) {
      problems.add(member, 'the run does not name every required lifecycle fact of the step');
      return { id: step.id, status: 'not_run', refs: [], note: 'a required lifecycle fact is not confirmed for this run' };
    }
    const rule = Object.hasOwn(module.rules, step.id) ? module.rules[step.id] : undefined;
    let given: Shown;
    if (rule === undefined) {
      given = `the task has no rule for the step ${step.id}`;
      problems.add(member, given);
    } else {
      given = hook(member, () => rule(a));
    }
    if (typeof given !== 'string' && given.length > 0) {
      const refs = given;
      if (refs.length <= 32 && refs.every((entry) => REF_KIND.test(entry.kind) && REF_VALUE.test(entry.value))) {
        if (required === undefined) return { id: step.id, status: 'shown', refs, note: '' };
        const txs = new Set(required.map((name) => a.facts.lifecycle[name]!.tx));
        if (refs.every((entry) => (entry.kind === 'transaction' && txs.has(entry.value))
          || (entry.kind === 'record' && REF.test(entry.value) && txs.has(txOf(entry.value))))
          && [...txs].every((tx) => refs.some((entry) => entry.kind === 'transaction' && entry.value === tx))) {
          return { id: step.id, status: 'shown', refs, note: '' };
        }
        problems.add(member, 'the references do not show the named, confirmed lifecycle transactions of the step');
      }
      problems.add(member, 'the rule gives references that are not in their required form');
      given = 'invalid references';
    }
    const why = typeof given === 'string' ? given : 'the rule gives no reference';
    if (rule !== undefined && kind !== 'failure') problems.add(member, `the ${kind} run does not show this step, and a ${kind} run shows every step: ${why}`);
    return { id: step.id, status: 'not_run', refs: [], note: why };
  });
}

/** The ids of the steps that the rules cover. A test holds them to the data of the use case. */
export function ruleStepIds(useCaseName: string): readonly string[] {
  return Object.keys(evidenceModuleOf(useCaseName).rules);
}

// ---- the document ----

function subjectOf(a: Assembly) {
  const subject = a.loaded.record.kind === 'lifecycle'
    ? a.use.agents.find((agent) => agent.id === a.use.lifecycle?.agent)
    : a.use.agents.find((agent) => (BUYER_SIDE_KINDS as readonly string[]).includes(agent.kind));
  if (subject === undefined || !/^[a-z0-9][a-z0-9-]{0,31}$/.test(subject.id)) throw new PreconditionError('the data does not name a valid subject for this evidence');
  return subject;
}

const RESERVED_DOCUMENT = new Set([
  'kind', 'date', 'capability_id', 'builder', 'advert_ref', 'escrow_ref', 'post_tx', 'accept_tx', 'explorer', 'verdict', 'checks', 'receipt',
  'receipt_signature', 'result_sha256', 'result', 'result_projection', 'hires', 'delegation', 'vault', 'mock', 'decisions', 'challenge', 'case', 'exit_state', 'steps', 'refusals', 'audience',
]);

const SAFE_PROJECTION_KEY = /^[a-z][a-z0-9_]{0,31}$/;
const SAFE_PROJECTION_TEXT = /^[A-Za-z0-9._:#/-]{1,128}$/;
const SAFE_DECISION = /^[a-z][a-z0-9_]{0,31}$/;

function publicResults(a: Assembly, project: NonNullable<EvidenceModule['projectPublicResult']>): {
  result: Readonly<Obj> | undefined; decisions: readonly Obj[];
} {
  let result: Readonly<Obj> | undefined;
  const decisions: Obj[] = [];
  for (const hire of a.loaded.hires) {
    if (hire.report === null) continue;
    const { fields, decisionNames } = hook('result_projection', () => project(hire));
    if (!isObject(fields) || !Array.isArray(decisionNames) || !decisionNames.every((name: unknown) => typeof name === 'string' && SAFE_DECISION.test(name))) {
      throw new PreconditionError('result_projection: the module did not give approved field and decision names');
    }
    const entries = Object.entries(fields);
    if (entries.length > 16 || !entries.every(([key, value]) => SAFE_PROJECTION_KEY.test(key) &&
        (value === null || typeof value === 'boolean' || (typeof value === 'string' && SAFE_PROJECTION_TEXT.test(value)) || Number.isSafeInteger(value)))) {
      throw new PreconditionError('result_projection: a field is not a public code, reference or count');
    }
    if (hire === a.loaded.carried) result = Object.fromEntries(entries);
    const shown = hire.decisions.filter((one) => typeof one.name === 'string' && decisionNames.includes(one.name)).map((one) => {
      const inference = one.inference;
      const job = isObject(inference) ? inference.sub_job : null;
      if (!isObject(job) || typeof job.escrow_ref !== 'string' || !REF.test(job.escrow_ref)) throw new PreconditionError('result_projection: the decision has no checked escrow');
      return { name: one.name, escrow_ref: job.escrow_ref };
    });
    if (shown.length > 0) decisions.push({ step: hire.entry.step, decisions: shown });
  }
  return { result, decisions };
}

/** A projected public file does not copy caller paths, identities, or free text from the log. */
function publicLog(a: Assembly): readonly Obj[] {
  return (a.mock?.lines ?? []).map(({ at, route, credential, decision, status }) => ({
    at: typeof at === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(at) ? at : null,
    route, credential: credential === 'token' || credential === 'jwt-svid' || credential === 'x509-svid' ? credential : null,
    decision: decision === 'allowed' || decision === 'refused' ? decision : null,
    status: typeof status === 'number' && Number.isSafeInteger(status) && status >= 100 && status <= 599 ? status : null,
  }));
}

function publicRefusals(record: RunRecord): readonly Obj[] {
  return record.refusals.map((one) => one.kind === 'tool'
    ? { step: one.step, kind: one.kind, message_sha256: sha256(one.message) }
    : { step: one.step, kind: one.kind, evaluation_error_sha256: sha256(one.evaluation_error),
        transaction_body_sha256: sha256(one.transaction_body) });
}

function documentOf(session: Session, a: Assembly, steps: readonly StepEntry[], exitState: string | null): Obj {
  const { record, carried, hires } = a.loaded;
  const { run, approval, claims, fault_mode, sub_delegations, ...added } = hook('document', () => session.extra.module.moduleDocument(a));
  if (typeof run !== 'string' || run === '' || Object.keys(added).some((key) => RESERVED_DOCUMENT.has(key))) {
    throw new PreconditionError('document: the module did not name the run or tried to replace a core member');
  }
  const header = { run, kind: record.kind, date: record.date, capability_id: subjectOf(a).capability, builder: session.settings.urls.hosted };
  const projector = session.extra.priv ? undefined : session.extra.module.projectPublicResult;
  const refusals = projector === undefined ? record.refusals : publicRefusals(record);
  if (record.kind === 'lifecycle') {
    if (approval !== undefined || claims !== undefined || fault_mode !== undefined || sub_delegations !== undefined) {
      throw new PreconditionError('document: a lifecycle run cannot carry a claim, approval, fault or delegation');
    }
    return { ...header, steps, refusals, ...added };
  }
  const c = a.challenge;
  const caseRead = a.caseRead;
  const e = carried?.entry;
  const projected = projector === undefined ? null : publicResults(a, projector);
  return {
    ...header,
    ...(e === undefined || carried === null ? {} : {
      advert_ref: e.advert_ref, escrow_ref: e.escrow_ref, post_tx: e.post_tx, accept_tx: e.accept_tx,
      explorer: { post: `${EXPLORER_TX}${e.post_tx}`, accept: e.accept_tx === null ? null : `${EXPLORER_TX}${e.accept_tx}` },
      verdict: carried.report.verdict,
      ...(projected === null ? { checks: carried.report.checks, receipt: carried.report.receipt, receipt_signature: carried.report.receipt_signature,
        result_sha256: carried.sha256, result: carried.report.result } : { result_sha256: carried.sha256, result_projection: projected.result }),
    }),
    hires: hires.map((hire) => ({
      step: hire.entry.step, agent: hire.entry.agent, advert_ref: hire.entry.advert_ref, escrow_ref: hire.entry.escrow_ref, post_tx: hire.entry.post_tx, accept_tx: hire.entry.accept_tx,
      reclaim_tx: hire.entry.reclaim_tx, verdict: hire.report?.verdict ?? null, result_sha256: hire.sha256,
    })),
    delegation: a.reads.delegations, vault: a.reads.vaults, ...(approval === undefined ? {} : { approval }), sub_delegations: sub_delegations ?? a.reads.subDelegations,
    mock: { tenant: record.tenant, log: projected === null ? a.mock?.lines ?? [] : publicLog(a), unattributed_lines: a.mock?.unattributed ?? 0, state: a.mock?.counts ?? null },
    decisions: projected?.decisions ?? hires.filter((hire) => hire.decisions.length > 0).map((hire) => ({ step: hire.entry.step, decisions: hire.decisions })),
    ...(claims === undefined ? {} : { claims }),
    challenge: c === null ? null : { claim: c.claim, evidence: c.evidence, challenge: c.challenge },
    case: caseRead === null || caseRead.verdict === null ? null : { verdict: caseRead.verdict, live: caseRead.listed, indexed: caseRead.indexed, hold: caseRead.hold },
    ...(fault_mode === undefined ? {} : { fault_mode }),
    exit_state: exitState,
    steps, refusals, ...added,
  };
}

/** The mark of a secret that the final text holds, or null. The text is the file as it will be written. */
export function secretMarkIn(finalText: string): string | null {
  return MARKS.find(([, pattern]) => pattern.test(finalText))?.[0] ?? null;
}

// ---- the run ----

async function readPaidFromVault(session: EvidenceSession, loaded: Loaded, hire: HireEntry): Promise<VaultPayment> {
  const env = envOf(session);
  let why = 'the record lists no delegation';
  for (const entry of loaded.record.delegations) {
    try {
      const read = await escrowPaidFromVault(env, hire.escrow_ref, entry.id);
      if (read.paid) return { paid: true, why: '', vault_ref: read.vaultRef, delegation: read.delegation };
      why = shown(read.detail);
    } catch (err) { throw new PreconditionError(`vault_payment.read_failed: ${shown(err)}`); }
  }
  return { paid: false, why };
}

function baseAssembly(session: Session, loaded: Loaded, purpose: Assembly['purpose'], discover = escrowDiscovery(session)): Assembly {
  return {
    purpose, use: session.use, loaded, facts: session.facts.read(), reads: EMPTY_READS, mock: null, terminals: new Map(), times: new Map(), faults: [], extra: {},
    challenge: null, caseRead: null, approvalStates: [], committedApprovals: new Map(), committedExecutes: new Map(), lifecycleTransactions: new Set(),
    paidFromVault(hire) {
      if (!loaded.hires.some((one) => one.entry === hire)) throw new PreconditionError('the hire is not in the run');
      return readPaidFromVault(session, loaded, hire);
    },
    readRelease(hire) {
      if (!loaded.hires.some((one) => one.entry === hire)) throw new PreconditionError('the hire is not in the run');
      return readRelease(session, hire, discover);
    },
  };
}

async function prepare(session: Session, a: Assembly): Promise<Assembly> {
  try {
    const { chain, clock, extra: { label, priv, indexer, result }, fetchImpl, hosted, node, settings, use } = session;
    const extra = await session.extra.module.prepare({ chain, clock, extra: { label, priv, indexer, result }, fetchImpl, hosted, node, settings, use }, a);
    if (!isObject(extra)) throw new PreconditionError('the module did not return an object');
    return { ...a, extra };
  } catch (err) { throw new PreconditionError(`prepare.read_failed: ${shown(err)}`); }
}

function runChallenge(a: Assembly, module: EvidenceModule): Challenge | null {
  const challenge = hook('challenge', () => module.challengeOf(a));
  const record = a.loaded.record;
  if (challenge === null) {
    if (record.challenged !== null) throw new PreconditionError('challenge: the module found no challenge for the named agent');
    return null;
  }
  if (record.kind !== 'failure' || !a.use.agents.some((agent) => agent.id === challenge.agent) ||
      (!record.legacy && record.challenged !== challenge.agent) || !REF.test(challenge.claim) || !HASH.test(challenge.evidence) || !REF.test(challenge.challenge)) {
    throw new PreconditionError('challenge: the module challenge does not match the named challenged agent, claim and evidence form');
  }
  return challenge;
}

/** Read the sources before judging steps. A lifecycle run takes only the lifecycle branch. */
async function assemble(session: Session): Promise<{ kind: 'wait'; message: string; untilMs: null } | { kind: 'ready'; document: Obj; subject: string }> {
  const problems = new Problems();
  const loaded = loadRun(session, problems);
  const { record } = loaded;
  const module = session.extra.module;
  const discover = escrowDiscovery(session);
  let a = baseAssembly(session, loaded, 'run', discover);
  if (record.kind === 'lifecycle') {
    const txs = transactionsOf(a, module, problems);
    await confirmAll(session, txs, problems);
    problems.stop();
    const lifecycle = Object.fromEntries(record.lifecycle.map((name) => [name, a.facts.lifecycle[name]!]));
    a = await prepare(session, { ...a, facts: { ...a.facts, lifecycle }, lifecycleTransactions: new Set(txs.keys()) });
    const steps = stepsOf(a, module, problems);
    problems.stop();
    return { kind: 'ready', document: documentOf(session, a, steps, null), subject: subjectOf(a).id };
  }
  const times = new Map<string, number>();
  for (const [i, hire] of record.hires.entries()) {
    for (const hash of [hire.post_tx, hire.accept_tx, hire.reclaim_tx]) {
      if (hash === null || times.has(hash)) continue;
      try { times.set(hash, await txTimeOf(session.fetchImpl, session.settings.urls.koios, hash)); } catch (err) { problems.add(`hires[${i}]`, `the block time of a transaction cannot be read (${shown(err)})`); }
    }
  }
  const checkedHires = await checkHires(session, loaded, a.facts, discover, problems);
  problems.stop();
  const reads = await checkLedger(session, record, problems);
  const mock = await readMock(session, loaded, a.facts, problems);
  const faults = checkFaults(session, loaded, times, problems);
  a = await prepare(session, { ...a, ...checkedHires, times, reads, mock, faults });
  const challenge = runChallenge(a, module);
  a = { ...a, challenge };
  await confirmAll(session, transactionsOf(a, module, problems), problems);
  a = { ...a, approvalStates: await checkApprovals(session, a, problems) };
  for (const problem of hook('fault_check', () => module.faultProblems?.(a) ?? [])) problems.add(problem.member, problem.detail);
  let caseRead: CaseRead | null = null;
  if (challenge !== null) {
    try { caseRead = await readCase(session, a, challenge); } catch (err) {
      if (err instanceof HostedError) throw err;
      problems.add('case', `read_failed: ${shown(err)}`);
    }
  }
  if (caseRead !== null && caseRead.verdict !== null && caseRead.indexed !== null) await confirmAll(session, caseTransactions(caseRead.indexed), problems);
  a = { ...a, caseRead };
  const exit = lastHire(loaded.hires, 'execute')?.result?.exit_state;
  if (typeof exit !== 'string' || !EXIT_STATES.includes(exit)) problems.add('exit_state', `the result of the last hire of execute has no exit_state of ${EXIT_STATES.join(', ')}`);
  const steps = stepsOf(a, module, problems);
  problems.stop();
  if (caseRead !== null && caseRead.waiting !== null) return { kind: 'wait', message: caseRead.waiting, untilMs: null };
  return { kind: 'ready', document: documentOf(session, a, steps, typeof exit === 'string' ? exit : null), subject: subjectOf(a).id };
}

/** The number of a public run, from `--number`, or null for a private file. A flag problem is exit 2 before any read. */
function numberOf(session: EvidenceSession): string | null {
  const number = session.flags.value('number');
  if (session.extra.priv) {
    if (number !== undefined) throw new FlagError('--number goes with the public file: a private file is named by the label of the run');
    return null;
  }
  if (number === undefined || !NUMBER.test(number)) throw new FlagError('--number <n> is required for the public file: the number of the run, 1 to 99 (or give --private)');
  return number;
}

async function produce(session: Session): Promise<StepOutcome> {
  session.extra.result = null;
  const number = numberOf(session);
  const first = await assemble(session);
  if (first.kind === 'wait') return first;
  const document = session.extra.priv ? { ...first.document, audience: 'private' } : first.document;
  const content = `${JSON.stringify(document, null, 2)}\n`;
  const mark = secretMarkIn(content);
  if (mark !== null || holdsSecret(document)) throw new PreconditionError(`the evidence file is not written: its text holds the mark of a secret (${mark ?? 'a member with the name of a secret'})`);
  // A real run is named by its date and number, and a private run by its label. The state folder holds both folders, with mode 700.
  const relative = number === null ? join('evidence', 'private', `${session.extra.label}.json`) : join('evidence', `${String(document.date)}-${first.subject}-run-${number}.json`);
  const path = join(session.settings.stateDir, relative);
  const digest = sha256(content);
  const bytes = Buffer.byteLength(content, 'utf8');
  const result = { file: relative, bytes, sha256: digest, audience: number === null ? 'private' : 'public' };
  if (existsSync(path)) {
    if (readFileSync(path, 'utf8') !== content) throw new PreconditionError(`the file ${relative} exists with other content: remove it first, because the task never replaces an evidence file`);
    session.extra.result = result;
    return { kind: 'done', message: `the file ${relative} exists with this content already (${bytes} bytes, SHA-256 ${digest})` };
  }
  writeFileAtomically(path, content);
  session.extra.result = result;
  return { kind: 'done', message: `the evidence file is written to ${relative} in the state folder (${bytes} bytes, SHA-256 ${digest})` };
}

// ---- status ----

async function showStatus(session: Session): Promise<void> {
  const out = (line: string): void => session.out.out(line);
  const problems = new Problems();
  const loaded = loadRun(session, problems);
  problems.stop();
  const facts = session.facts.read();
  const { record } = loaded;
  out(`evidence of the run ${record.label}, kind ${record.kind}`);
  if (record.kind === 'lifecycle') {
    for (const name of record.lifecycle) out(`lifecycle ${name}: ${facts.lifecycle[name]?.tx ?? 'the facts hold no transaction'}`);
    return;
  }
  for (const agent of session.use.agents) {
    const claim = facts.claims[record.label]?.[agent.id];
    out(claim === undefined ? `claim of ${agent.id}: the facts hold none` : `claim of ${agent.id}: ${claim.claimRef}, staked at ${claim.stakedAt}, the window ends ${claim.withdrawableFrom}`);
  }
  if (record.kind === 'clean') {
    out('a clean run has no challenge and no case');
    return;
  }
  const a = await prepare(session, baseAssembly(session, loaded, 'status'));
  const challenge = runChallenge(a, session.extra.module);
  if (challenge === null) { out('the run names no challenge or jury case'); return; }
  out(`challenge: claim ${challenge.claim}, evidence ${challenge.evidence}, challenge ${challenge.challenge}`);
  const found = await readCase(session, { ...a, challenge }, challenge);
  const c = found.listed;
  out(c === null ? 'case: the hosted tool lists no live case of the challenge' : `case ${c.case_token}: phase ${c.phase}, state ${c.state}, tally ClaimerWins ${c.tally.claimer}, AuditorWins ${c.tally.auditor}, Inconclusive ${c.tally.inconclusive}, outcome ${c.outcome}`);
  const x = found.indexed;
  out(x === null ? 'indexer: the marketplace indexer lists no canonical case of the challenge' : `indexer: case ${x.case_token} is ${x.state} (window ${x.window}), tally ClaimerWins ${x.tally.claimer}, AuditorWins ${x.tally.auditor}, Inconclusive ${x.tally.inconclusive}, result ${x.finalized_result ?? 'not final yet'}`);
  const h = found.hold;
  const agent = session.use.agents.find((one) => one.id === challenge.agent)!.name;
  out(h === null ? `hold of the ${agent}: none with the reason ${JURY_HOLD_REASON}` : `hold of the ${agent}: reason ${h.reason} from ${iso(h.since)} until ${iso(h.until)}, on the record output ${h.record_output}`);
  if (found.verdict === null) {
    out(`verdict: none yet. ${found.waiting}`);
    throw new Error('the case has no verdict yet: run the task again later');
  }
  out(`verdict: ${found.verdict}`);
  if (found.verdict !== 'AuditorWins') out(`the ${agent} got no hold: the run needs a new claim and a new challenge, so ask for a new go`);
}

export function createEvidenceTask(modules: Readonly<Record<string, EvidenceModule>> = EVIDENCE_MODULES): TaskDefinition<Extra> {
  const hosted = [...new Set(['vector_get_jury_cases', 'vector_resolve_did', ...Object.values(modules).flatMap((module) => module.hosted)])];
  return {
    name: 'evidence',
    title: 'Write the evidence file of a run, and wait for its jury case',
    flags: ['private'],
    valued: ['number'],
    needs: { keys: () => [], chain: true, hosted, approval: 'never' },
    steps: () => ['run'],
    parse(env, _settings, use, flags) {
      const label = flags.value('run');
      if (label === undefined) throw new FlagError('--run <label> is required: the evidence is the evidence of a run');
      const reader = new EnvReader(env);
      const indexer = reader.url('VECTOR_MARKETPLACE_INDEXER_URL', MARKETPLACE_INDEXER);
      reader.done();
      return { label, priv: flags.has('private'), indexer, result: null, module: evidenceModuleOf(use.name, modules) };
    },
    next: produce,
    async cleanup() {
      return { kind: 'done', message: 'there is nothing to take back: the task writes one evidence file and changes no state' };
    },
    async status(session) {
      await showStatus(session);
      return [];
    },
    result: (session) => session.extra.result ?? {},
  };
}

export default createEvidenceTask();
