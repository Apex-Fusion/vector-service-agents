// scripts/operator/tasks/evidence.ts - the task evidence: it writes the evidence file of a run, and it waits for the jury case of the failure run.
//
//   run --run <label> --number <n>      writes <state>/evidence/<date>-reorder-agent-run-<n>.json (the public file of a real run)
//   run --run <label> --private         writes <state>/evidence/private/<label>.json (the same content, and "audience": "private")
//   status --run <label>                shows the claims, the challenge, the case of the jury and the hold of the Order Desk
//
// The input is the run record `<state>/runs/<label>.json` and the report file of each hire in `<state>/runs/<label>/`. The task reads every reference in them back from the node, Koios, the hosted
// tools and the mock service, and it writes the file only when each read agrees (exit 2 names each member that does not). A run of the failure kind needs the verdict of its jury case: with none
// the task writes nothing and ends with exit 4. The task signs nothing, sends nothing, reads no key and no token, and needs no approval. The final text is scanned for the marks of a secret.
// The runner ends `status` with exit 0 for any task, so a status with no verdict prints its lines and then ends with exit 1, as the status of end-state does: it never looks done.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeFileAtomically } from '../../checks/lib/files.ts';
import { duration, iso } from '../../checks/lib/format.ts';
import { HostedError } from '../../checks/lib/hosted.ts';
import { PreconditionError } from '../../checks/lib/session.ts';
import { RUN_APPROVAL_VALIDITY_MS } from '../lib/claim-constants.ts';
import type { AgentSpec, Facts, StepOutcome, TaskDefinition, TaskSession, UseCase } from '../lib/contract.ts';
import { MOCK_PUBLIC_BASE } from '../lib/mock-hosts.ts';
import { checkAttestation, findRecord, isFaultSetting, readDelegation, readVaults, resolveEscrowLineage } from '../lib/platform.ts';
import type { LedgerEnv } from '../lib/platform.ts';
import { FlagError } from '../lib/runner.ts';
import { hireRoleOf, parseReport, parseRunRecord, readJsonFile, txInfoOf, txTimeOf } from '../lib/run-record.ts';
import type { HireEntry, HireRole, Report, RunRecord } from '../lib/run-record.ts';
import { holdsSecret } from '../lib/secrets.ts';

/** A transaction on the explorer of the network: this text and the hash. */
export const EXPLORER_TX = 'https://explorer.vector.mainnet.apexfusion.org/transaction/hash/';
export const PROPOSAL_SCHEMA = 'vector.usecase.proposal.v1';
export const RESULT_SCHEMA = 'vector.usecase.result.v1';
export const CONFIRMATION_SCHEMA = 'vector.usecase.order-confirmation.v1';
const EXIT_STATES: readonly string[] = ['Completed', 'Rejected', 'Expired', 'Cancelled', 'Escalated', 'Failed'];
/** The type of an approval attestation. */
const APPROVAL_TYPE = 5;
/** The reason code of the hold that Module-1 puts on an agent after a verdict of AuditorWins. */
export const JURY_HOLD_REASON = 64;
/** The relay opens a case about 30 minutes after the challenge, the jurors commit for 2 hours and reveal for 2 hours, and then the relay finalises and resolves: about 4 h 44 min to the hold. */
export const CASE_DURATION_MS = (4 * 60 + 44) * 60_000;
const VERDICTS: readonly string[] = ['ClaimerWins', 'AuditorWins', 'Inconclusive'];
const DEPTH_OF_SPEND_CHAIN = 4;
const NUMBER = /^[1-9][0-9]?$/;
const REF = /^[0-9a-f]{64}#(?:0|[1-9][0-9]{0,5})$/;
const HASH = /^[0-9a-f]{64}$/;
const MOST_MOCK_CHARS = 8 * 1024 * 1024;
const MOCK_TIMEOUT_MS = 30_000;
/** The marks of a secret in the final text: each is refused in any case. `Authorization` is the name of the header that carries a token. */
const MARKS: ReadonlyArray<readonly [string, RegExp]> = [
  ['ed25519_sk', /ed25519e?_sk/i], ['_sk1', /_x?sk1/i], ['Bearer', /bearer\s/i], ['Authorization', /authorization/i], ['PRIV_KEY', /PRIV_KEY/i], ['access_token', /access_token=/i],
];

type Obj = Record<string, unknown>;
const isObject = (value: unknown): value is Obj => typeof value === 'object' && value !== null && !Array.isArray(value);

/** A reference of a step: its kind and its value. The results page reads these two members. */
export interface Ref { readonly kind: string; readonly value: string }
const ref = (kind: string, value: string): Ref => ({ kind, value });

interface Extra { readonly label: string; readonly priv: boolean; result: Readonly<Record<string, unknown>> | null }

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
const txOf = (reference: string): string => reference.slice(0, 64);

// ---- 1. the record and the reports ----

interface HireView {
  readonly index: number; readonly entry: HireEntry; readonly role: HireRole; readonly report: Report; readonly result: Obj; readonly sha256: string; readonly decisions: readonly Obj[];
}

interface Loaded { readonly record: RunRecord; readonly hires: readonly HireView[]; readonly carried: HireView | null }

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

function hireView(session: TaskSession<Extra>, record: RunRecord, entry: HireEntry, index: number, problems: Problems): HireView | null {
  const where = `hires[${index}]`;
  const role = hireRoleOf(entry.step)!;
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
  if (txOf(entry.escrow_ref) !== entry.post_tx) problems.add(`${where}.post_tx`, 'is not the transaction of escrow_ref');
  const schema = role === 'propose' ? PROPOSAL_SCHEMA : role === 'execute' ? RESULT_SCHEMA : CONFIRMATION_SCHEMA;
  if (parsed.schema !== schema) problems.add(`${where}.report_file`, `result is not the result of ${role}: its schema is not ${schema}`);
  const kind = role === 'order-desk' ? 'order-desk' : 'reorder-agent';
  const mode = parsed.fault_mode;
  if (typeof mode !== 'string') problems.add(`${where}.report_file`, 'result has no fault_mode: every result names its fault value, and an empty text is no fault');
  else if (!isFaultSetting(kind, mode)) problems.add(`${where}.report_file`, `result has a fault_mode that the kind ${kind} does not take`);
  else if (record.kind === 'clean' && mode !== '') problems.add(`${where}.report_file`, 'result has a fault_mode that is set: a clean run has none');
  return { index, entry, role, report, result: parsed, sha256: digest, decisions: decisionsOf(parsed, `${where}.report_file`, problems) };
}

/** The hire of execute that carried the order: the last hire of execute whose result holds a handoff to the Order Desk. */
function carriedOf(hires: readonly HireView[]): HireView | null {
  return [...hires].reverse().find((hire) => hire.role === 'execute' && isObject(hire.result.handoff)) ?? null;
}

function loadRun(session: TaskSession<Extra>, problems: Problems): Loaded {
  const { label } = session.extra;
  let record: RunRecord;
  try { record = parseRunRecord(readJsonFile(join(session.settings.stateDir, 'runs', `${label}.json`), 'the run record')); } catch (err) { throw stopOf(err); }
  if (record.label !== label) throw new PreconditionError('label: the label of the record is not the label in the name of its file');
  if (!session.use.runs.some((run) => run.id === record.kind)) throw new PreconditionError(`kind: ${record.kind} is not a run of the data of the use case`);
  const hires = record.hires.map((entry, index) => hireView(session, record, entry, index, problems)).filter((view): view is HireView => view !== null);
  return { record, hires, carried: carriedOf(hires) };
}

// ---- helpers over the data ----

function agentOf(use: UseCase, kind: AgentSpec['kind']): AgentSpec {
  const agent = use.agents.find((one) => one.kind === kind);
  if (agent === undefined) throw new PreconditionError(`the data of the use case has no agent of the kind ${kind}`);
  return agent;
}

/** The ledger environment of the reads of buyer-core, from the chain of the session. */
const envOf = (session: TaskSession<Extra>): LedgerEnv => ({ provider: session.chain.provider, deployment: session.chain.deployment, koiosUrl: session.chain.koiosUrl, fetchImpl: session.chain.fetchImpl });

function challengeOf(loaded: Loaded): { claim: string; evidence: string; challenge: string } | null {
  const found = loaded.carried?.result.challenge;
  if (!isObject(found)) return null;
  const { claim, evidence, challenge } = found;
  return typeof claim === 'string' && REF.test(claim) && typeof evidence === 'string' && HASH.test(evidence) && typeof challenge === 'string' && REF.test(challenge) ? { claim, evidence, challenge } : null;
}

// ---- 2. every transaction is confirmed ----

function transactionsOf(session: TaskSession<Extra>, loaded: Loaded, facts: Readonly<Facts>, problems: Problems): Map<string, string> {
  const txs = new Map<string, string>();
  const add = (member: string, hash: string | null): void => { if (hash !== null && !txs.has(hash)) txs.set(hash, member); };
  const { record } = loaded;
  record.delegations.forEach((d, i) => { add(`delegations[${i}].tx`, d.tx); add(`delegations[${i}].ended_tx`, d.ended_tx); });
  record.vaults.forEach((v, i) => { add(`vaults[${i}].open_tx`, v.open_tx); add(`vaults[${i}].close_tx`, v.close_tx); });
  add('approval.tx', record.approval.tx);
  record.sub_delegations.forEach((s, i) => { add(`sub_delegations[${i}].delegate_tx`, s.delegate_tx); add(`sub_delegations[${i}].undelegate_tx`, s.undelegate_tx); });
  record.hires.forEach((h, i) => { add(`hires[${i}].post_tx`, h.post_tx); add(`hires[${i}].accept_tx`, h.accept_tx); add(`hires[${i}].reclaim_tx`, h.reclaim_tx); });
  for (const view of loaded.hires) view.decisions.forEach((d, j) => add(`hires[${view.index}].decisions[${j}].escrow_ref`, txOf(((d.inference as Obj).sub_job as Obj).escrow_ref as string)));
  const claims = facts.claims[record.label] ?? {};
  for (const agent of session.use.agents) {
    const claim = claims[agent.id];
    if (claim === undefined) { problems.add(`claims.${agent.id}`, `the facts hold no claim of the agent ${agent.id} for the run ${record.label}`); continue; }
    add(`claims.${agent.id}.documentTx`, claim.documentTx); add(`claims.${agent.id}.claimTx`, claim.claimTx); add(`claims.${agent.id}.withdrawTx`, claim.withdrawTx);
  }
  const challenge = challengeOf(loaded);
  if (challenge !== null) { add('challenge.evidence', challenge.evidence); add('challenge.challenge', txOf(challenge.challenge)); }
  const hold = facts.holds[record.label];
  if (hold !== undefined) { add('holds.suspendTx', hold.suspendTx); add('holds.liftTx', hold.liftTx); }
  return txs;
}

async function confirmAll(session: TaskSession<Extra>, txs: ReadonlyMap<string, string>, problems: Problems): Promise<void> {
  for (const [hash, member] of txs) {
    try {
      const { confirmations } = await session.node.txStatus(hash);
      if (confirmations === null || confirmations < 1) problems.add(member, 'the transaction has no confirmation on the node');
    } catch (err) { problems.add(member, `the status of the transaction cannot be read (${shown(err)})`); }
  }
}

// ---- 3. the hires: the escrow, the advert and the spend of the escrow ----

/** True when the transaction `endTx` spends the escrow: it spends an output of the escrow script, and that output descends from `escrowRef` by the spend chain (Accept, Submit, Claim, Post). */
async function spendsEscrow(session: TaskSession<Extra>, endTx: string, escrowRef: string): Promise<boolean> {
  const credential = session.chain.deployment.escrow.hash;
  let tx = endTx;
  for (let hop = 0; hop < DEPTH_OF_SPEND_CHAIN; hop += 1) {
    const own = (await txInfoOf(session.fetchImpl, session.settings.urls.koios, tx)).inputs.filter((input) => input.credential === credential);
    if (own.length !== 1) return false;
    if (own[0]!.ref === escrowRef) return true;
    tx = txOf(own[0]!.ref);
  }
  return false;
}

/** What the lineage of an escrow says: it is finished (spent, and no live continuation). */
interface LineageView { readonly finished: boolean }

async function checkHires(session: TaskSession<Extra>, loaded: Loaded, facts: Readonly<Facts>, problems: Problems): Promise<Map<string, LineageView>> {
  const lineages = new Map<string, LineageView>();
  for (const view of loaded.hires) {
    const { entry, index } = view;
    const where = `hires[${index}]`;
    const agent = agentOf(session.use, entry.agent === 'order-desk' ? 'order-desk' : 'reorder-agent');
    const model = String(view.report.receipt.model);
    const advert = facts.adverts[agent.id]?.[model];
    if (advert === undefined || advert.ref !== entry.advert_ref) problems.add(`${where}.advert_ref`, `is not the advert in the facts for the agent ${agent.id} and the model ${model} of the receipt`);
    let posted: Obj | null = null;
    try {
      const lineage = await resolveEscrowLineage(session.chain.provider, session.chain.koiosUrl, entry.escrow_ref, session.chain.fetchImpl, session.chain.deployment);
      // The escrow datum has a layout of its own (identity or legacy): its members are read by name, and the identity layout is the one that holds an agent id.
      posted = lineage.posted as unknown as Obj;
      lineages.set(entry.escrow_ref, { finished: lineage.spent && lineage.current === null });
    } catch (err) { problems.add(`${where}.escrow_ref`, `the escrow cannot be read from the chain (${shown(err)})`); }
    if (posted !== null) {
      const advertRef = isObject(posted.advert_ref) ? `${String(posted.advert_ref.txHash)}#${String(posted.advert_ref.index)}` : null;
      if (advertRef !== entry.advert_ref) problems.add(`${where}.advert_ref`, 'is not the advert that the escrow on the chain was posted for');
      const record = facts.records[agent.id];
      if (record === undefined || posted.agent_id !== record.id) problems.add(`${where}.escrow_ref`, `the escrow on the chain is not for the agent ${agent.id}`);
    }
    for (const member of ['accept_tx', 'reclaim_tx'] as const) {
      const end = entry[member];
      if (end === null) continue;
      if (lineages.get(entry.escrow_ref)?.finished === false) problems.add(`${where}.${member}`, 'the escrow is not finished on the chain: it is not spent, or it has a live continuation');
      try {
        if (!(await spendsEscrow(session, end, entry.escrow_ref))) problems.add(`${where}.${member}`, 'does not spend the escrow: no input of the transaction descends from escrow_ref by the spend chain');
      } catch (err) { problems.add(`${where}.${member}`, `the spend of the escrow cannot be read (${shown(err)})`); }
    }
  }
  return lineages;
}

// ---- 4. the delegations, the vaults and the approval ----

interface Reads {
  delegations: Array<{ id: string; tx: string; ended_tx: string | null; state: 'live' | 'ended' }>;
  vaults: Array<{ ref: string; open_tx: string; close_tx: string | null; state: 'live' | 'closed' }>;
  subDelegations: Array<{ id: string; delegate_tx: string; undelegate_tx: string }>;
  approval: Obj | null;
}

async function checkLedger(session: TaskSession<Extra>, loaded: Loaded, facts: Readonly<Facts>, times: ReadonlyMap<string, number>, problems: Problems): Promise<Reads> {
  const env = envOf(session);
  const { record } = loaded;
  const reads: Reads = { delegations: [], vaults: [], subDelegations: [], approval: null };
  for (const [i, entry] of record.delegations.entries()) {
    let live = false;
    try { live = (await readDelegation(env, entry.id)).chain.length > 0; } catch (err) { problems.add(`delegations[${i}].id`, `the delegation cannot be read (${shown(err)})`); continue; }
    if (entry.ended_tx === null && !live) problems.add(`delegations[${i}].id`, 'the ledger holds no live delegation with this id, and ended_tx is not set');
    if (entry.ended_tx !== null && live) problems.add(`delegations[${i}].ended_tx`, 'is set, and the ledger still holds the delegation as live');
    reads.delegations.push({ ...entry, state: live ? 'live' : 'ended' });
  }
  for (const [i, entry] of record.sub_delegations.entries()) {
    try {
      if ((await readDelegation(env, entry.id)).chain.length > 0) problems.add(`sub_delegations[${i}].id`, 'the ledger still holds the sub-delegation as live: it must be ended');
    } catch (err) { problems.add(`sub_delegations[${i}].id`, `the sub-delegation cannot be read (${shown(err)})`); }
    reads.subDelegations.push({ ...entry });
  }
  for (const [i, entry] of record.vaults.entries()) {
    if (entry.close_tx !== null) { reads.vaults.push({ ...entry, state: 'closed' }); continue; }
    try {
      const page = await readVaults(env, { vaultRef: entry.ref }, session.clock.now());
      const found = page.items[0];
      if (page.items.length !== 1 || found === undefined || found.output.vault.type !== 'Live' || !found.onNode) problems.add(`vaults[${i}].ref`, 'the node holds no Live vault output at this reference, and close_tx is not set');
    } catch (err) { problems.add(`vaults[${i}].ref`, `the vault cannot be read (${shown(err)})`); }
    reads.vaults.push({ ...entry, state: 'live' });
  }
  reads.approval = await checkApproval(session, loaded, facts, times, problems);
  return reads;
}

/** The digest of the proposal that the carried order answers, and a hire of propose whose result holds it. */
function proposalDigestOf(loaded: Loaded): string | null {
  const digest = loaded.carried?.result.proposal_digest;
  if (typeof digest !== 'string') return null;
  return loaded.hires.some((hire) => hire.role === 'propose' && hire.result.proposal_digest === digest) ? digest : null;
}

async function checkApproval(session: TaskSession<Extra>, loaded: Loaded, facts: Readonly<Facts>, times: ReadonlyMap<string, number>, problems: Problems): Promise<Obj | null> {
  const digest = proposalDigestOf(loaded);
  if (digest === null) {
    problems.add('approval.digest', 'no hire of propose holds the proposal_digest of the order that the carried hire of execute answers');
    return null;
  }
  const agent = agentOf(session.use, 'reorder-agent');
  const subject = facts.records[agent.id];
  const atMs = loaded.carried === null ? undefined : times.get(loaded.carried.entry.post_tx);
  if (subject === undefined || atMs === undefined) {
    problems.add('approval.attestation', 'the facts hold no record of the Reorder Agent, or the time of the run is not known');
    return null;
  }
  try {
    const check = await checkAttestation(envOf(session), { id: loaded.record.approval.attestation, atMs, expect: { attType: APPROVAL_TYPE, subject: subject.did, digest } });
    const view = check.attestation;
    if (view === null) {
      problems.add('approval.attestation', 'no output of the attestation address holds the token of the approval');
      return null;
    }
    for (const line of check.expectations.filter((one) => one.result === 'fail')) problems.add(`approval.${line.id}`, `${line.label}: ${line.detail}`);
    for (const line of check.conditions.filter((one) => one.result === 'fail')) problems.add('approval.attestation', `${line.label}: ${line.detail}`);
    const datum = view.attestation;
    const validity = datum.validUntil === null ? null : datum.validUntil - (datum.validFrom ?? datum.issuedAt);
    if (validity === null) problems.add('approval.validity', 'the approval has no end of validity');
    else if (validity > RUN_APPROVAL_VALIDITY_MS) problems.add('approval.validity', `lasts ${validity} ms, and the approval of a run lasts at most ${RUN_APPROVAL_VALIDITY_MS} ms`);
    return {
      attestation: loaded.record.approval.attestation, tx: loaded.record.approval.tx, type: datum.attType, subject: subject.did, digest: datum.digest, issued_at: datum.issuedAt,
      valid_until: datum.validUntil, validity_ms: validity, checked_at: atMs,
    };
  } catch (err) {
    problems.add('approval.attestation', `the approval cannot be read (${shown(err)})`);
    return null;
  }
}

// ---- 5. the mock service ----

interface MockRead { readonly lines: readonly Obj[]; readonly counts: { readonly purchase_orders: number; readonly supplier_orders: number } }

async function mockGet(session: TaskSession<Extra>, tenant: string, what: 'log' | 'state'): Promise<unknown> {
  let response: Response;
  try {
    response = await session.fetchImpl(`${MOCK_PUBLIC_BASE}/t/${tenant}/${what}`, { method: 'GET', headers: { accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(MOCK_TIMEOUT_MS) });
  } catch (err) { throw new Error(`the call to the mock service failed (${shown(err)})`); }
  if (response.status !== 200) throw new Error(`the mock service answered HTTP ${response.status}`);
  const text = (await response.text()).slice(0, MOST_MOCK_CHARS);
  try { return JSON.parse(text) as unknown; } catch { throw new Error('the mock service answered with a body that is no JSON'); }
}

const countOf = (section: unknown): number | null => (isObject(section) && Array.isArray(section.orders) ? section.orders.length : null);

async function readMock(session: TaskSession<Extra>, loaded: Loaded, facts: Readonly<Facts>, problems: Problems): Promise<MockRead | null> {
  const { tenant, label } = loaded.record;
  if (facts.tenants[label]?.name !== tenant) problems.add('tenant', `is not the tenant that the facts hold for the run ${label}`);
  try {
    const log = await mockGet(session, tenant, 'log');
    const state = await mockGet(session, tenant, 'state');
    if (!isObject(log) || log.tenant !== tenant || !Array.isArray(log.lines) || typeof log.dropped !== 'number') { problems.add('mock.log', 'is not the log of the tenant that the mock service documents'); return null; }
    if (log.dropped > 0) problems.add('mock.log', `the mock service dropped ${log.dropped} line(s) of the log: the log is not whole`);
    const lines = log.lines;
    if (!lines.every(isObject)) { problems.add('mock.log', 'holds a line that is no object'); return null; }
    const purchaseOrders = isObject(state) ? countOf(state.po_store) : null;
    const supplierOrders = isObject(state) ? countOf(state.supplier) : null;
    if (purchaseOrders === null || supplierOrders === null) { problems.add('mock.state', 'is not the state of the tenant that the mock service documents'); return null; }
    return { lines: structuredClone(lines), counts: { purchase_orders: purchaseOrders, supplier_orders: supplierOrders } };
  } catch (err) {
    problems.add('mock', shown(err));
    return null;
  }
}

// ---- 6. the fault guard ----

interface FaultEntry { readonly atMs: number; readonly check: string; readonly agent: string | null; readonly ok: boolean; readonly services: ReadonlyArray<{ service: string; started_at: string; value: string }> }

function faultEntries(session: TaskSession<Extra>, label: string, problems: Problems): FaultEntry[] {
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

function checkFaults(session: TaskSession<Extra>, loaded: Loaded, times: ReadonlyMap<string, number>, problems: Problems): void {
  const entries = faultEntries(session, loaded.record.label, problems);
  const posts = loaded.record.hires.map((hire) => times.get(hire.post_tx)!);
  const all = loaded.record.hires.flatMap((hire) => [hire.post_tx, hire.accept_tx, hire.reclaim_tx]).filter((hash): hash is string => hash !== null).map((hash) => times.get(hash)!);
  if (posts.some((time) => time === undefined) || all.some((time) => time === undefined)) return;
  const firstPost = Math.min(...posts);
  const lastTx = Math.max(...all);
  const clean = entries.filter((entry) => entry.ok && entry.check === 'clean' && entry.services.every((one) => one.value === ''));
  const before = clean.filter((entry) => entry.atMs <= firstPost).sort((a, b) => b.atMs - a.atMs)[0];
  const after = clean.filter((entry) => entry.atMs >= lastTx).sort((a, b) => a.atMs - b.atMs)[0];
  if (before === undefined) problems.add('fault_check', `no passing clean entry at or before the block time of the first post transaction of the run (${iso(firstPost)})`);
  if (after === undefined) problems.add('fault_check', `no passing clean entry at or after the block time of the last transaction of the last hire (${iso(lastTx)})`);
  if (loaded.record.kind === 'clean') {
    if (before !== undefined && after !== undefined) sameStart(before, after, problems);
    return;
  }
  const desk = agentOf(session.use, 'order-desk');
  const carriedPost = loaded.carried === null ? undefined : times.get(loaded.carried.entry.post_tx);
  const fault = entries.find((entry) => entry.ok && entry.check === 'confirm_wrong_lot' && entry.agent === desk.id && carriedPost !== undefined && entry.atMs <= carriedPost);
  if (fault === undefined) problems.add('fault_check', `no passing confirm_wrong_lot entry for the agent ${desk.id} at or before the block time of the carried hire of execute`);
  const confirmation = loaded.hires.find((hire) => hire.role === 'order-desk' && hire.entry.escrow_ref === handoffRef(loaded));
  if (confirmation !== undefined && confirmation.result.fault_mode !== 'confirm_wrong_lot') problems.add(`hires[${confirmation.index}].report_file`, 'the confirmation of the Order Desk has not the fault_mode confirm_wrong_lot that the failure run needs');
}

/** The escrow reference of the hire of the Order Desk that the carried hire of execute made. */
function handoffRef(loaded: Loaded): string | null {
  const handoff = loaded.carried?.result.handoff;
  return isObject(handoff) && typeof handoff.escrow_ref === 'string' ? handoff.escrow_ref : null;
}

// ---- 7. the case of the jury and the hold ----

interface HoldView { readonly reason: number; readonly since: number; readonly until: number; readonly record_output: string; readonly gateway_status: string | null }
interface CaseView {
  readonly jury: string; readonly case_token: string; readonly case_output: string; readonly claim_out: string; readonly challenge_out: string; readonly canonical: boolean | null;
  readonly phase: string; readonly state: string; readonly tally: { readonly claimer: number; readonly auditor: number; readonly inconclusive: number }; readonly revealed: number; readonly outcome: string;
}
interface CaseRead { readonly listed: CaseView | null; readonly hold: HoldView | null; readonly verdict: string | null; readonly waiting: string | null }

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
  if (!VERDICTS.includes(outcome!)) return null;
  return {
    jury: jury!, case_token: token!, case_output: output!, claim_out: claimOut!, challenge_out: challengeOut!, canonical: typeof row.canonical === 'boolean' ? row.canonical : null,
    phase: phase!, state: state!, tally: { claimer, auditor, inconclusive }, revealed, outcome: outcome!,
  };
}

/** The hold that Module-1 put on the Order Desk after a verdict: the hold with the reason 64 whose signer is a script, read from the record on the node. */
async function readHold(session: TaskSession<Extra>, facts: Readonly<Facts>): Promise<HoldView | null> {
  const desk = agentOf(session.use, 'order-desk');
  const fact = facts.records[desk.id];
  if (fact === undefined) throw new PreconditionError(`the facts hold no record of the agent ${desk.id}`);
  const found = await findRecord(session.chain.provider, session.chain.deployment, fact.id);
  if (found === null) throw new PreconditionError(`the record ${fact.did} is not in the identity registry`);
  const status = found.record.status;
  const holds = status.type === 'Suspended' ? status.holds.filter((hold) => hold.reason === JURY_HOLD_REASON && hold.by.type === 'Script') : [];
  const hold = [...holds].sort((a, b) => b.until - a.until)[0];
  if (hold === undefined) return null;
  const answer = await session.hosted.call('vector_resolve_did', { did: fact.did });
  const vector = isObject(answer.json?.didDocumentMetadata) ? answer.json.didDocumentMetadata.vectorStatus : undefined;
  const effective = !answer.failed && isObject(vector) ? text(vector.effective) : null;
  return { reason: hold.reason, since: hold.since, until: hold.until, record_output: `${found.utxo.txHash}#${found.utxo.outputIndex}`, gateway_status: effective };
}

async function readCase(session: TaskSession<Extra>, loaded: Loaded, facts: Readonly<Facts>, nowMs: number): Promise<CaseRead> {
  const challenge = challengeOf(loaded);
  const desk = agentOf(session.use, 'order-desk');
  const claim = facts.claims[loaded.record.label]?.[desk.id];
  if (challenge === null || claim === undefined) throw new PreconditionError('challenge: no hire of execute holds a challenge, and the failure run needs the challenge of the claim of the Order Desk');
  if (challenge.claim !== claim.claimRef) throw new PreconditionError(`challenge.claim: is not the claim that the facts hold for the agent ${desk.id} in the run ${loaded.record.label}`);
  const answer = await session.hosted.call('vector_get_jury_cases', { claim: claim.claimToken });
  if (answer.failed) throw new HostedError('unreachable', `the hosted tool vector_get_jury_cases failed: ${shown(answer.message)}`);
  const rows = lastJsonBlock(answer.text);
  if (!Array.isArray(rows)) throw new HostedError('protocol', 'the answer of vector_get_jury_cases holds no list of cases');
  const mine = rows.filter((row: unknown): row is Obj => isObject(row) && row.claim_out === challenge.claim && row.challenge_out === challenge.challenge);
  const views = mine.map(caseViewOf);
  if (views.includes(null)) throw new HostedError('protocol', 'a case in the answer of vector_get_jury_cases has not the form that the tool documents');
  const canonical = (views as CaseView[]).filter((view) => view.canonical === true);
  const listed = views.length === 1 ? views[0]! : canonical.length === 1 ? canonical[0]! : null;
  if (views.length > 1 && listed === null) throw new HostedError('protocol', 'the answer of vector_get_jury_cases lists more than one case of the challenge, and none is the canonical case');
  const hold = await readHold(session, facts);
  const verdict = listed !== null && listed.state === 'Settling' ? listed.outcome : hold !== null ? 'AuditorWins' : null;
  let waiting: string | null = null;
  if (verdict === null || (verdict === 'AuditorWins' && hold === null)) {
    let expected = 'about 4 h 44 min after the challenge';
    try {
      const at = (await txTimeOf(session.fetchImpl, session.settings.urls.koios, txOf(challenge.challenge))) + CASE_DURATION_MS;
      expected = at > nowMs ? `expected at ${iso(at)}, in ${duration(at - nowMs)}` : `expected at ${iso(at)}, and that time has passed`;
    } catch { /* the block time of the challenge is not known: the text says the length */ }
    const lead = verdict === null ? 'the case of the challenge has no verdict' : 'the jury decided AuditorWins, and the hold is not yet on the record of the Order Desk';
    waiting = `${lead}. The relay opens a case about 30 minutes after the challenge, the jurors commit for 2 hours and reveal for 2 hours, and then the relay finalises and resolves it: the hold comes ${expected}`;
  }
  return { listed, hold, verdict: waiting === null ? verdict : null, waiting };
}

// ---- 10. the steps ----

type Shown = readonly Ref[] | string;

interface Assembly {
  readonly use: UseCase; readonly loaded: Loaded; readonly facts: Readonly<Facts>; readonly reads: Reads; readonly mock: MockRead | null; readonly lineages: ReadonlyMap<string, LineageView>; readonly caseRead: CaseRead | null;
}

const hireRefs = (hire: HireView): Ref[] => [
  ref('transaction', hire.entry.post_tx), ref('escrow', hire.entry.escrow_ref),
  ...(hire.entry.accept_tx === null ? [] : [ref('transaction', hire.entry.accept_tx)]), ...(hire.entry.reclaim_tx === null ? [] : [ref('transaction', hire.entry.reclaim_tx)]),
];

const decisionEscrow = (hire: HireView, name: string): string | null => {
  const found = hire.decisions.find((one) => one.name === name);
  return found === undefined ? null : ((found.inference as Obj).sub_job as Obj).escrow_ref as string;
};

/** True when the log of the mock service holds an allowed call with this route and this kind of credential (and, for a token, this length of the act chain). */
function logHas(a: Assembly, route: string, credential: string, act: number | null): boolean {
  return (a.mock?.lines ?? []).some((line) => line.route === route && line.credential === credential && line.decision === 'allowed' && (act === null || (Array.isArray(line.act) && line.act.length === act)));
}

const refusalOf = (a: Assembly, step: string, kind: 'ledger' | 'tool'): boolean => a.loaded.record.refusals.some((one) => one.step === step && one.kind === kind);

/** The Order Desk hire that the carried hire of execute made, found by the escrow reference of its handoff. */
function deskOf(a: Assembly): HireView | undefined {
  const target = handoffRef(a.loaded);
  return a.loaded.hires.find((hire) => hire.role === 'order-desk' && hire.entry.escrow_ref === target);
}

const named = (a: Assembly, step: string): HireView | undefined => a.loaded.hires.find((hire) => hire.entry.step === step);

/** For each step of the data: the references that the record or a read gives, or the reason why none is given. A rule never invents a value. */
const RULES: Readonly<Record<string, (a: Assembly) => Shown>> = {
  'r1-01': (a) => { const d = a.reads.delegations[0]; return d === undefined ? 'the record lists no delegation' : [ref('delegation', d.id), ref('transaction', d.tx)]; },
  'r1-02': (a) => { const v = a.reads.vaults[0]; return v === undefined ? 'the record lists no vault' : [ref('vault', v.ref), ref('transaction', v.open_tx)]; },
  'r1-03': (a) => { const h = named(a, 'propose'); return h === undefined ? 'the record has no hire named propose' : hireRefs(h); },
  'r1-04': (a) => {
    const s = a.reads.subDelegations[0];
    if (s === undefined) return 'the record lists no sub-delegation';
    return logHas(a, 'GET /erp/stock/{sku}', 'token', 2) ? [ref('delegation', s.id), ref('transaction', s.delegate_tx)] : 'the log of the mock service shows no allowed stock read with a token that has a chain of two links';
  },
  'r1-05': (a) => {
    const s = a.reads.subDelegations[0]; const h = named(a, 'propose'); const e = h === undefined ? null : decisionEscrow(h, 'reorder');
    return s === undefined || e === null ? 'there is no sub-delegation, or the result of propose has no decision named reorder' : [ref('escrow', e), ref('transaction', s.undelegate_tx)];
  },
  'r1-06': (a) => (a.reads.approval === null ? 'the approval is not confirmed by a read' : [ref('attestation', a.loaded.record.approval.attestation), ref('transaction', a.loaded.record.approval.tx)]),
  'r1-07': (a) => (a.loaded.carried === null ? 'no hire of execute carried an order' : hireRefs(a.loaded.carried)),
  'r1-08': (a) => {
    const d = deskOf(a); const handoff = a.loaded.carried?.result.handoff;
    return d === undefined || !isObject(handoff) || handoff.paid_from_vault !== true ? 'no hire of the Order Desk was paid from the vault by the carried hire of execute' : [ref('transaction', d.entry.post_tx), ref('escrow', d.entry.escrow_ref)];
  },
  'r1-09': (a) => {
    const d = deskOf(a); const e = d === undefined ? null : decisionEscrow(d, 'availability');
    if (d === undefined || e === null) return 'the Order Desk hire is missing, or its result has no decision named availability';
    return logHas(a, 'POST /supplier/orders', 'x509-svid', null) ? [ref('escrow', d.entry.escrow_ref), ref('escrow', e)] : 'the log of the mock service shows no allowed order with an X.509 SVID';
  },
  'r1-10': (a) => {
    const d = deskOf(a); const c = a.loaded.carried; const e = c === null ? null : decisionEscrow(c, 'accept_delivery');
    if (d === undefined || d.entry.accept_tx === null || c === null || c.result.outcome !== 'completed' || e === null) return 'the Order Desk hire has no accept, or the carried result is not completed, or it has no decision named accept_delivery';
    return logHas(a, 'POST /po', 'token', 1) ? [ref('transaction', d.entry.accept_tx), ref('escrow', e)] : 'the log of the mock service shows no allowed purchase order with a token';
  },
  'r1-11': (a) => {
    const d = a.reads.delegations[0]; const v = a.reads.vaults[0];
    return d === undefined || d.ended_tx === null || v === undefined || v.close_tx === null ? 'the vault is not closed, or the delegation is not ended' : [ref('transaction', v.close_tx), ref('transaction', d.ended_tx)];
  },
  'r2-a': (a) => refused(a, 'execute-a', 'r2-a'),
  'r2-b': (a) => {
    const settled = named(a, 'execute-b1');
    return settled === undefined || settled.result.outcome !== 'completed' ? 'the record has no completed hire named execute-b1 (the settled order of step b)' : refused(a, 'execute-b2', 'r2-b');
  },
  'r2-c': (a) => {
    const c = challengeOf(a.loaded);
    return c === null || a.loaded.carried?.result.outcome !== 'disputed' ? 'no hire of execute ended disputed with a challenge' : [ref('claim', c.claim), ref('transaction', c.evidence), ref('challenge', c.challenge)];
  },
  'r2-d': (a) => {
    const c = a.caseRead;
    if (c === null || c.verdict === null) return 'the case has no verdict';
    if (c.verdict !== 'AuditorWins') return `the jury decided ${c.verdict}, and the Order Desk got no hold: the run needs a new claim and a new challenge`;
    return c.hold === null ? 'the node shows no hold with the reason 64 on the Order Desk' : [...(c.listed === null ? [] : [ref('case', c.listed.case_token)]), ref('hold', c.hold.record_output)];
  },
  'r2-e': (a) => {
    const d = deskOf(a);
    if (d === undefined) return 'the record has no hire of the Order Desk for the carried hire of execute';
    const ended = a.lineages.get(d.entry.escrow_ref)?.finished === true && d.entry.accept_tx === null && d.entry.reclaim_tx === null;
    return ended ? [ref('escrow', d.entry.escrow_ref)] : 'the escrow of the Order Desk hire is not finished on the chain without an accept and without a reclaim';
  },
  'r2-f': (a) => { const p = named(a, 'propose-f'); return p === undefined || p.result.outcome !== 'failed' ? 'the record has no failed hire named propose-f' : hireRefs(p); },
  'r2-g': (a) => {
    const hold = a.facts.holds[a.loaded.record.label];
    return hold === undefined || hold.suspendTx === null || hold.liftTx === null ? 'the facts hold no hold and no lift of the run' : [ref('transaction', hold.suspendTx), ref('transaction', hold.liftTx)];
  },
  'r2-h': (a) => {
    const e = named(a, 'execute-h'); const ended = a.reads.delegations.find((d) => d.ended_tx !== null);
    if (e === undefined || e.result.outcome !== 'vault_refused' || e.result.exit_state !== 'Cancelled') return 'the record has no hire named execute-h that ended vault_refused and Cancelled';
    if (ended === undefined || ended.ended_tx === null) return 'no delegation of the record is ended';
    if (!refusalOf(a, 'r2-h', 'ledger') || !refusalOf(a, 'r2-h', 'tool')) return 'the record has no refusal of the ledger and no refusal of the tool for r2-h';
    return [ref('transaction', ended.ended_tx), ...hireRefs(e)];
  },
};

/** A step that a vault script refused: the hire that ended vault_refused, and the refusal of the ledger with its evaluation error and body. */
function refused(a: Assembly, step: string, id: string): Shown {
  const h = named(a, step);
  if (h === undefined || h.result.outcome !== 'vault_refused') return `the record has no hire named ${step} that ended vault_refused`;
  return refusalOf(a, id, 'ledger') ? hireRefs(h) : `the record has no refusal of the ledger for ${id}`;
}

export interface StepEntry { readonly id: string; readonly status: 'shown' | 'not_run'; readonly refs: readonly Ref[]; readonly note: string }

/** The steps of the data for the kind of the run. A step is shown only when its rule gives a reference. */
function stepsOf(a: Assembly, problems: Problems): StepEntry[] {
  const { kind } = a.loaded.record;
  return a.use.evidenceSteps.filter((step) => step.run === kind || step.run === 'both').map((step): StepEntry => {
    const rule = RULES[step.id];
    const given: Shown = rule === undefined ? `the task has no rule for the step ${step.id}` : rule(a);
    if (typeof given !== 'string' && given.length > 0) return { id: step.id, status: 'shown', refs: given, note: '' };
    const why = typeof given === 'string' ? given : 'the rule gives no reference';
    if (kind === 'clean') problems.add(`steps.${step.id}`, `the clean run does not show this step, and a clean run shows every step: ${why}`);
    return { id: step.id, status: 'not_run', refs: [], note: why };
  });
}

/** The ids of the steps that the rules cover. A test holds them to the data of the use case. */
export const RULE_STEP_IDS: readonly string[] = Object.keys(RULES);

// ---- the document ----

function documentOf(session: TaskSession<Extra>, a: Assembly, steps: readonly StepEntry[]): Obj {
  const { record, carried, hires } = a.loaded;
  const reorder = agentOf(session.use, 'reorder-agent');
  const claimsOf = (agent: AgentSpec): unknown => {
    const c = a.facts.claims[record.label]![agent.id]!;
    return {
      claim_ref: c.claimRef, document_tx: c.documentTx, claim_tx: c.claimTx, claim_token: c.claimToken, stake_lovelace: c.stakeLovelace, window_ms: c.windowMs, staked_at: c.stakedAt,
      withdrawable_from: c.withdrawableFrom, withdraw_tx: c.withdrawTx,
    };
  };
  const carriedEntry = carried!.entry;
  const desk = deskOf(a);
  const modes = (role: 'reorder-agent' | 'order-desk'): string => {
    const view = role === 'order-desk' ? desk : carried;
    return view === undefined || view === null ? '' : String(view.result.fault_mode);
  };
  const challenge = challengeOf(a.loaded);
  const caseRead = a.caseRead;
  return {
    run: `use-case-1-${record.kind}`, kind: record.kind, date: record.date, capability_id: reorder.capability, builder: session.settings.urls.hosted,
    advert_ref: carriedEntry.advert_ref, escrow_ref: carriedEntry.escrow_ref, post_tx: carriedEntry.post_tx, accept_tx: carriedEntry.accept_tx,
    explorer: { post: `${EXPLORER_TX}${carriedEntry.post_tx}`, accept: carriedEntry.accept_tx === null ? null : `${EXPLORER_TX}${carriedEntry.accept_tx}` },
    verdict: carried!.report.verdict, checks: carried!.report.checks, receipt: carried!.report.receipt, receipt_signature: carried!.report.receipt_signature, result_sha256: carried!.sha256, result: carried!.report.result,
    hires: hires.map((hire) => ({
      step: hire.entry.step, agent: hire.entry.agent, advert_ref: hire.entry.advert_ref, escrow_ref: hire.entry.escrow_ref, post_tx: hire.entry.post_tx, accept_tx: hire.entry.accept_tx,
      reclaim_tx: hire.entry.reclaim_tx, verdict: hire.report.verdict, result_sha256: hire.sha256,
    })),
    delegation: a.reads.delegations, vault: a.reads.vaults, approval: a.reads.approval, sub_delegations: a.reads.subDelegations,
    mock: { tenant: record.tenant, log: a.mock?.lines ?? [], state: a.mock?.counts ?? null },
    decisions: hires.filter((hire) => hire.decisions.length > 0).map((hire) => ({ step: hire.entry.step, decisions: hire.decisions })),
    claims: { reorder_agent: claimsOf(reorder), order_desk: claimsOf(agentOf(session.use, 'order-desk')) },
    challenge,
    case: caseRead === null || caseRead.verdict === null ? null : { ...caseRead.listed, verdict: caseRead.verdict, hold: caseRead.hold },
    fault_mode: { reorder_agent: modes('reorder-agent'), order_desk: modes('order-desk') },
    exit_state: [...hires].reverse().find((hire) => hire.role === 'execute')!.result.exit_state,
    steps, refusals: record.refusals,
  };
}

/** The mark of a secret that the final text holds, or null. The text is the file as it will be written. */
export function secretMarkIn(finalText: string): string | null {
  return MARKS.find(([, pattern]) => pattern.test(finalText))?.[0] ?? null;
}

// ---- the run ----

/** Reads and checks everything (items 1 to 10 of the rules above) and gives the document, or the reason to wait. */
async function assemble(session: TaskSession<Extra>): Promise<{ kind: 'wait'; message: string; untilMs: number | null } | { kind: 'ready'; document: Obj }> {
  const problems = new Problems();
  const loaded = loadRun(session, problems);
  problems.stop();
  const { record } = loaded;
  const facts = session.facts.read();
  if (loaded.carried === null) problems.add('hires', 'no hire of execute carried an order to the Order Desk: the result of none holds a handoff');
  const txs = transactionsOf(session, loaded, facts, problems);
  await confirmAll(session, txs, problems);
  const times = new Map<string, number>();
  for (const hire of record.hires) {
    for (const hash of [hire.post_tx, hire.accept_tx, hire.reclaim_tx]) {
      if (hash === null || times.has(hash)) continue;
      try { times.set(hash, await txTimeOf(session.fetchImpl, session.settings.urls.koios, hash)); } catch (err) { problems.add(`hires[${record.hires.indexOf(hire)}]`, `the block time of a transaction cannot be read (${shown(err)})`); }
    }
  }
  const lineages = await checkHires(session, loaded, facts, problems);
  const reads = await checkLedger(session, loaded, facts, times, problems);
  const mock = await readMock(session, loaded, facts, problems);
  checkFaults(session, loaded, times, problems);
  let caseRead: CaseRead | null = null;
  if (record.kind === 'failure' && loaded.carried !== null) {
    try { caseRead = await readCase(session, loaded, facts, session.clock.now()); } catch (err) {
      if (err instanceof PreconditionError) problems.add('case', err.message); else throw err;
    }
  }
  const last = [...loaded.hires].reverse().find((hire) => hire.role === 'execute');
  if (last === undefined || typeof last.result.exit_state !== 'string' || !EXIT_STATES.includes(last.result.exit_state)) problems.add('exit_state', `the result of the last hire of execute has no exit_state of ${EXIT_STATES.join(', ')}`);
  const assembly: Assembly = { use: session.use, loaded, facts, reads, mock, lineages, caseRead };
  const steps = stepsOf(assembly, problems);
  problems.stop();
  if (caseRead !== null && caseRead.verdict === null) return { kind: 'wait', message: caseRead.waiting!, untilMs: null };
  return { kind: 'ready', document: documentOf(session, assembly, steps) };
}

/** The number of a public run, from `--number`, or null for a private file. A flag problem is exit 2 before any read. */
function numberOf(session: TaskSession<Extra>): string | null {
  const number = session.flags.value('number');
  if (session.extra.priv) {
    if (number !== undefined) throw new FlagError('--number goes with the public file: a private file is named by the label of the run');
    return null;
  }
  if (number === undefined || !NUMBER.test(number)) throw new FlagError('--number <n> is required for the public file: the number of the run, 1 to 99 (or give --private)');
  return number;
}

async function produce(session: TaskSession<Extra>): Promise<StepOutcome> {
  const number = numberOf(session);
  const first = await assemble(session);
  if (first.kind === 'wait') return first;
  const document = session.extra.priv ? { ...first.document, audience: 'private' } : first.document;
  const content = `${JSON.stringify(document, null, 2)}\n`;
  const mark = secretMarkIn(content);
  if (mark !== null || holdsSecret(document)) throw new PreconditionError(`the evidence file is not written: its text holds the mark of a secret (${mark ?? 'a member with the name of a secret'})`);
  // A real run is named by its date and number, and a private run by its label. The state folder holds both folders, with mode 700.
  const relative = number === null ? join('evidence', 'private', `${session.extra.label}.json`) : join('evidence', `${String(document.date)}-reorder-agent-run-${number}.json`);
  const path = join(session.settings.stateDir, relative);
  const digest = sha256(content);
  const bytes = Buffer.byteLength(content, 'utf8');
  session.extra.result = { file: relative, bytes, sha256: digest, audience: number === null ? 'private' : 'public' };
  if (existsSync(path)) {
    if (readFileSync(path, 'utf8') !== content) throw new PreconditionError(`the file ${relative} exists with other content: remove it first, because the task never replaces an evidence file`);
    return { kind: 'done', message: `the file ${relative} exists with this content already (${bytes} bytes, SHA-256 ${digest})` };
  }
  writeFileAtomically(path, content);
  return { kind: 'done', message: `the evidence file is written to ${relative} in the state folder (${bytes} bytes, SHA-256 ${digest})` };
}

// ---- status ----

async function showStatus(session: TaskSession<Extra>): Promise<void> {
  const out = (line: string): void => session.out.out(line);
  const problems = new Problems();
  const loaded = loadRun(session, problems);
  problems.stop();
  const facts = session.facts.read();
  const { record } = loaded;
  out(`evidence of the run ${record.label}, kind ${record.kind}`);
  for (const agent of session.use.agents) {
    const claim = facts.claims[record.label]?.[agent.id];
    out(claim === undefined ? `claim of ${agent.id}: the facts hold none` : `claim of ${agent.id}: ${claim.claimRef}, staked at ${claim.stakedAt}, the window ends ${claim.withdrawableFrom}`);
  }
  if (record.kind === 'clean') {
    out('a clean run has no challenge and no case');
    return;
  }
  const challenge = challengeOf(loaded);
  out(challenge === null ? 'challenge: no hire of execute holds a challenge' : `challenge: claim ${challenge.claim}, evidence ${challenge.evidence}, challenge ${challenge.challenge}`);
  if (challenge === null) throw new PreconditionError('the failure run has no challenge to follow');
  const found = await readCase(session, loaded, facts, session.clock.now());
  const c = found.listed;
  out(c === null ? 'case: the hosted tool lists no live case of the challenge' : `case ${c.case_token}: phase ${c.phase}, state ${c.state}, tally ClaimerWins ${c.tally.claimer}, AuditorWins ${c.tally.auditor}, Inconclusive ${c.tally.inconclusive}, outcome ${c.outcome}`);
  const h = found.hold;
  out(h === null ? 'hold of the Order Desk: none with the reason 64' : `hold of the Order Desk: reason ${h.reason} from ${iso(h.since)} until ${iso(h.until)}, on the record output ${h.record_output}`);
  if (found.verdict === null) {
    out(`verdict: none yet. ${found.waiting}`);
    throw new Error('the case has no verdict yet: run the task again later');
  }
  out(`verdict: ${found.verdict}`);
  if (found.verdict !== 'AuditorWins') out('the Order Desk got no hold: the run needs a new claim and a new challenge, so ask for a new go');
}

const task: TaskDefinition<Extra> = {
  name: 'evidence',
  title: 'Write the evidence file of a run, and wait for the jury case of the failure run',
  flags: ['private'],
  valued: ['number'],
  needs: { keys: () => [], chain: true, hosted: ['vector_get_jury_cases', 'vector_resolve_did'], approval: 'never' },
  steps: () => ['run'],
  parse(_env, _settings, _use, flags) {
    const label = flags.value('run');
    if (label === undefined) throw new FlagError('--run <label> is required: the evidence is the evidence of a run');
    return { label, priv: flags.has('private'), result: null };
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

export default task;
