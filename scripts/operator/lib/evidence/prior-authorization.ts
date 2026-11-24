import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { PreconditionError } from '../../../checks/lib/session.ts';
import { EXECUTE_OUTCOMES, EXIT_STATES, HANDOFF_SCHEMA, PROPOSAL_SCHEMA, RESULT_SCHEMA, canonicalSha256, isErrorCode, makeProposal, parseApprovalRef, parseHandoff, parseProposal } from '../../../../packages/usecase-kit/src/protocol/index.ts';
import { INTAKE_CHECKS, INTAKE_RECORD_SCHEMA, alterJustification, parseIntakeRecord, parsePriorAuthRequest } from '../../../../packages/usecase-kit/src/priorauth/index.ts';
import type { IntakeRecord, PriorAuthRequest } from '../../../../packages/usecase-kit/src/priorauth/index.ts';
import { requestText } from '../../../../packages/usecase-kit/src/buyer/message.ts';
import { evidenceDocument, evidenceReferences } from '../../../../packages/usecase-kit/src/dispute/index.ts';
import type { EvidenceReferences } from '../../../../packages/usecase-kit/src/dispute/index.ts';
import { canonicalize, decodeIdentityEscrowDatum, promptHashForPayload } from '../../../../packages/vector-read/src/index.ts';
import { bytesOf, constrFields, decodeDelegationDatum, decodeIdentityDatum, encodeIdentityDatum, intOf } from '../../../../packages/vector-read/src/identity-codec.ts';
import { decodePlutusData } from '../../../../packages/vector-read/src/guarded-decode.ts';
import { decodeChallengeDatum, decodeClaimDatum, documentUri, readDocument, txHashOfUri } from '../../../../packages/buyer-core/src/index.ts';
import { decodeJuryDatum } from '../../../../packages/buyer-core/src/vendored/mcp/jury-codec.ts';
import { findConfigRecord } from '../../../../packages/buyer-core/src/vendored/mcp/identity-deployment.ts';
import type { KoiosUtxo } from '../../../../packages/buyer-core/src/vendored/mcp/marketplace-indexer.ts';
import { send as fetchBounded } from '../../../../packages/id-kit/src/common/http.ts';
import data from '../../usecases/prior-authorization.ts';
import { RUN_APPROVAL_VALIDITY_MS } from '../claim-constants.ts';
import { MOCK_PUBLIC_BASE } from '../mock-hosts.ts';
import type { RecordFact, UseCase } from '../contract.ts';
import { PURPOSE, effectiveStatus, findRecord, keyHashOf, koiosUtxoInfo, module1FromManifest, readManifest } from '../platform.ts';
import { readJsonFile, scriptTxInfoOf } from '../run-record.ts';
import type { ScriptTxInfo } from '../run-record.ts';
import { isObject, lastHire, ref, txOf } from './types.ts';
import type { ApprovalRead, Assembly, Challenge, CommittedExecute, EvidenceModule, EvidenceReadSession, HireView, HistoricalHoldCandidate, IndexedCase, Obj, PublicHandoffEvidence, PublicRouteEvidence, Ref, ReportedHire, TerminalSpend, VaultPayment } from './types.ts';

const HASH = /^[0-9a-f]{64}$/;
const SCRIPT = /^[0-9a-f]{56}$/;
const REF = /^[0-9a-f]{64}#(?:0|[1-9][0-9]{0,5})$/;
const CHALLENGE_TOKEN = /^63686c5f[0-9a-f]{56}$/;
const DID = /^did:vector:[0-9a-f]{64}$/;
const DISPUTE_HOLD = 64;
const HOLD_DURATION_MS = 7 * 86_400_000;
const READ_BYTES = 2 * 1024 * 1024;
const FAULT = 'alter_after_approval';
const ORDER_READ = 'GET /records/orders/{order_id}';
const GUIDELINE_READ = 'GET /guidelines/{code}';
const FILING = 'POST /insurer/requests';
const SUBMISSION = 'POST /records/orders/{order_id}/submission';
const HIRE_ROLES = ['propose', 'execute', 'intake'] as const;
const REPORT_SCHEMAS = { propose: PROPOSAL_SCHEMA, execute: RESULT_SCHEMA, intake: INTAKE_RECORD_SCHEMA };
const REFUSALS = {
  revoked: { reason: 'approval_revoked', exit: 'Rejected' },
  expired: { reason: 'approval_expired', exit: 'Expired' },
  altered: { reason: 'approval_digest_mismatch', exit: 'Escalated' },
} as const;
const MANIFEST_BASE = 'https://raw.githubusercontent.com/Apex-Fusion/vector-agent-modules';

function actors(use: UseCase) {
  const drafter = use.agents.filter(({ kind }) => kind === 'prior-authorization-agent');
  const intake = use.agents.filter(({ kind }) => kind === 'insurer-intake-agent');
  if (drafter.length !== 1 || intake.length !== 1) throw new PreconditionError('the data must name one drafting agent and one intake agent');
  return { drafter: drafter[0]!, intake: intake[0]!, children: use.subagents.filter(({ parent }) => parent === drafter[0]!.id) };
}
const AGENTS = actors(data);

const textOf = (value: unknown): string | null => typeof value === 'string' ? value : null;
const hashOf = (value: unknown): string | null => typeof value === 'string' && HASH.test(value) ? value : null;
const digestOf = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');
const outRef = (row: KoiosUtxo): string => `${row.tx_hash}#${row.tx_index}`;
const recordRef = (row: { txHash: string; outputIndex: number }): string => `${row.txHash}#${row.outputIndex}`;
const timeOf = (value: unknown): number => typeof value === 'string' ? Date.parse(value) : NaN;
const canonicalTime = (value: unknown): number => {
  const at = timeOf(value);
  return Number.isFinite(at) && new Date(at).toISOString() === value ? at : NaN;
};
const named = (a: Assembly, step: string): HireView | undefined => a.loaded.hires.find((hire) => hire.entry.step === step);
const reported = (hire: HireView | undefined): ReportedHire | null => hire?.report == null ? null : hire;

function recordOf(a: Assembly, agent: string): RecordFact | null {
  const fact = a.facts.records[agent];
  return fact !== undefined && HASH.test(fact.id) && fact.did === `did:vector:${fact.id}` ? fact : null;
}

function requestOf(a: Assembly, hire: ReportedHire): CommittedExecute | null {
  const proof = a.committedExecutes.get(hire.entry.step);
  return proof !== undefined && proof.escrow_ref === hire.entry.escrow_ref && proof.digest === hire.result.proposal_digest ? proof : null;
}

function approvalHire(a: Assembly, index: number): ReportedHire | null {
  const entry = a.loaded.record.approvals[index];
  if (entry === undefined) return null;
  if (entry.role === 'binding') {
    if (a.loaded.record.kind !== 'clean') return null;
    const execute = reported(named(a, 'execute'));
    return execute !== null && requestOf(a, execute)?.approval != null ? execute : null;
  }
  const matches = a.loaded.hires.filter((hire): hire is ReportedHire => hire.role === 'execute' && hire.report !== null
    && requestOf(a, hire)?.approval?.attestation === entry.attestation);
  return matches.length === 1 ? matches[0]! : null;
}

function approvalOf(a: Assembly, step: string): ApprovalRead | null {
  return a.approvalStates.find((entry) => entry?.hire === step && entry.entry.role === 'approval' && entry.link === 'request') ?? null;
}

function proposalOf(a: Assembly, step: string): { hire: ReportedHire; document: PriorAuthRequest; digest: string; salt: string; documentHash: string } | null {
  const hire = reported(named(a, step));
  if (hire?.role !== 'propose' || hire.result.outcome !== 'proposed' || hire.result.use_case !== data.name) return null;
  const proposal = parseProposal({ document: hire.result.document, salt: hire.result.salt, proposal_digest: hire.result.proposal_digest });
  if (!proposal.ok) return null;
  const document = parsePriorAuthRequest(proposal.value.document);
  const hash = canonicalSha256(proposal.value.document);
  if (!document.ok || !hash.ok || document.value.tenant !== a.loaded.record.tenant) return null;
  return { hire, document: document.value, digest: proposal.value.proposal_digest, salt: proposal.value.salt, documentHash: hash.value };
}

interface Handoff { readonly execute: ReportedHire; readonly intake: HireView; readonly acceptance: 'confirmed' | 'pending' | null }
function signedHandoff(a: Assembly, executeStep: string, intakeStep: string): Handoff | null {
  const execute = reported(named(a, executeStep));
  const intake = named(a, intakeStep);
  const fact = intake === undefined ? null : recordOf(a, intake.entry.agent);
  const wire = execute?.result.handoff;
  if (execute?.role !== 'execute' || execute.result.use_case !== data.name || intake?.role !== 'intake' || fact === null || !isObject(wire)
    || wire.counterparty_did !== fact.did || wire.advert_ref !== intake.entry.advert_ref || wire.escrow_ref !== intake.entry.escrow_ref
    || wire.paid_from_vault !== true) return null;
  if (intake.report === null) {
    if (wire.receipt !== null || wire.receipt_signature !== null || wire.result !== null || wire.verification !== null || wire.accepted !== null) return null;
    return { execute, intake, acceptance: null };
  }
  const terminal = a.terminals.get(intake.entry.escrow_ref);
  if (wire.receipt_signature !== intake.report.receipt_signature || !isObject(wire.receipt) || !isObject(wire.result)
      || canonicalize(wire.receipt) !== canonicalize(intake.report.receipt) || canonicalize(wire.result) !== canonicalize(intake.result)
      || (wire.accepted !== 'confirmed' && wire.accepted !== 'pending') || intake.entry.accept_tx === null
      || terminal?.action !== 'Accept' || terminal.tx !== intake.entry.accept_tx) return null;
  return { execute, intake, acceptance: wire.accepted };
}

function matchesRefusal(result: Obj, kind: keyof typeof REFUSALS): boolean {
  const { reason, exit } = REFUSALS[kind];
  return result.outcome === 'refused_by_counterparty' && result.reason === reason && result.exit_state === exit;
}

interface RefusedIntake { readonly handoff: Handoff; readonly reclaim: TerminalSpend; readonly approval: ApprovalRead }
function refusalOf(a: Assembly, id: string, kind: keyof typeof REFUSALS): RefusedIntake | null {
  const handoff = signedHandoff(a, `execute-${id}`, `intake-${id}`);
  const approval = approvalOf(a, `execute-${id}`);
  const state = kind === 'altered' ? 'active' : kind;
  if (handoff === null || approval?.state !== state || handoff.intake.report !== null || !matchesRefusal(handoff.execute.result, kind)) return null;
  if (handoff.execute.result.fault_mode !== (kind === 'altered' ? FAULT : '')) return null;
  const reclaim = a.terminals.get(handoff.intake.entry.escrow_ref);
  if (reclaim?.action !== 'Reclaim' || reclaim.tx !== handoff.intake.entry.reclaim_tx || reclaim.spent_output !== handoff.intake.entry.escrow_ref
    || reclaim.refund_outputs.length < 1 || reclaim.refund_outputs.length > 12) return null;
  return { handoff, reclaim, approval };
}

/** Project the proved pair. Do not rewrite a signed pending state to confirmed. */
function projectHandoff(handoff: Handoff): PublicHandoffEvidence | null {
  const { execute, intake, acceptance } = handoff;
  return acceptance === null || intake.entry.accept_tx === null ? null : {
    execute_step: execute.entry.step, execute_escrow: execute.entry.escrow_ref, execute_result_sha256: execute.sha256,
    intake_step: intake.entry.step, intake_escrow: intake.entry.escrow_ref, signed_acceptance: acceptance, confirmed_accept_tx: intake.entry.accept_tx,
  };
}

function intakeRefs(handoff: Handoff): Ref[] {
  return [ref('transaction', handoff.intake.entry.post_tx), ref('escrow', handoff.intake.entry.escrow_ref)];
}
function hireRefs(hire: ReportedHire): Ref[] {
  return [ref('transaction', hire.entry.post_tx), ref('escrow', hire.entry.escrow_ref),
    ...(hire.entry.accept_tx === null ? [] : [ref('transaction', hire.entry.accept_tx)])];
}
function approvalRefs(approval: ApprovalRead): Ref[] {
  return [ref('attestation', approval.entry.attestation), ref('transaction', approval.entry.tx),
    ...(approval.entry.revoked_tx === null ? [] : [ref('transaction', approval.entry.revoked_tx)])];
}
function refusedRefs(failure: RefusedIntake): Ref[] {
  return [...hireRefs(failure.handoff.execute), ...intakeRefs(failure.handoff), ref('transaction', failure.reclaim.tx),
    ...failure.reclaim.refund_outputs.map((value) => ref('vault', value))];
}
function decisionOf(hire: ReportedHire, name: string): string | null {
  const matching = hire.decisions.filter((entry) => entry.name === name);
  const inference = matching[0]?.inference;
  const job = isObject(inference) ? inference.sub_job : null;
  return matching.length === 1 && isObject(job) && typeof job.escrow_ref === 'string' && REF.test(job.escrow_ref) ? job.escrow_ref : null;
}

function sectionRows(state: Readonly<Obj>, section: string, key: string): readonly Obj[] | null {
  const part = state[section];
  const list = isObject(part) ? part[key] : null;
  return Array.isArray(list) && list.every(isObject) ? list : null;
}

function svid(value: unknown, id: string): boolean {
  return typeof value === 'string' && /^spiffe:\/\/[^/]+\/agent\/[0-9a-f]{64}$/.test(value) && value.endsWith(`/agent/${id}`);
}
function exactAct(value: unknown, expected: readonly string[]): boolean {
  return Array.isArray(value) && value.length === expected.length && expected.every((id, i) => value[i] === id);
}
function allowed(a: Assembly, route: string, status: number, matches: (line: Obj) => boolean, recordedAt: number | null = null): boolean {
  return (a.mock?.lines ?? []).some((line) => {
    const at = timeOf(line.at);
    return line.tenant === a.loaded.record.tenant && line.route === route && line.decision === 'allowed' && line.status === status
      && (recordedAt === null || (at >= recordedAt && at <= recordedAt + 30_000)) && matches(line);
  });
}

interface Completed {
  readonly handoff: Handoff; readonly intake: IntakeRecord; readonly filed: Obj | null; readonly submission: Obj | null;
  readonly completeDecision: string | null; readonly acceptDecision: string | null;
}
function completedOf(a: Assembly): Completed | null {
  const clean = a.loaded.record.kind === 'clean';
  const executeStep = clean ? 'execute' : 'execute-d2';
  const handoff = signedHandoff(a, executeStep, clean ? 'intake' : 'intake-d2');
  const draft = proposalOf(a, clean ? 'propose' : 'propose-d');
  const approval = approvalOf(a, executeStep);
  if (handoff === null || draft === null || approval?.state !== 'active' || draft.digest !== approval.digest
    || handoff.execute.result.outcome !== 'completed' || handoff.execute.result.exit_state !== 'Completed' || handoff.execute.result.reason !== null
    || handoff.execute.result.fault_mode !== '' || handoff.intake.report === null) return null;
  const parsed = parseIntakeRecord(handoff.intake.result);
  const request = requestOf(a, handoff.execute);
  const draftRecord = recordOf(a, handoff.execute.entry.agent);
  const intakeRecord = recordOf(a, handoff.intake.entry.agent);
  if (!parsed.ok || request?.approval == null || draftRecord === null || intakeRecord === null) return null;
  const intake = parsed.value;
  if (intake.approval.attestation !== approval.entry.attestation || intake.approval.issuer_did !== request.approval.issuer_did
    || timeOf(intake.approval.valid_until) !== approval.valid_until || intake.request_number !== draft.document.request_number || intake.request_sha256 !== draft.documentHash
    || intake.sender.did !== draftRecord.did || draft.document.insurer_did !== intakeRecord.did || draft.document.advert_ref !== handoff.intake.entry.advert_ref) return null;
  const state = a.mock?.state ?? {};
  const requests = sectionRows(state, 'insurer', 'requests');
  const submissions = sectionRows(state, 'records', 'submissions');
  const filing = requests?.length === 1 ? requests[0] : null;
  const submission = submissions?.length === 1 ? submissions[0] : null;
  const filedHash = filing == null ? null : canonicalSha256(filing.request);
  const filed = filing != null && filedHash?.ok === true && filedHash.value === intake.request_sha256 && filing.request_number === intake.request_number
    && filing.intake_id === intake.intake_id && filing.service_code === draft.document.service_code && filing.status === intake.status
    && exactAct(filing.missing, intake.missing) && isObject(filing.by) && filing.by.kind === 'jwt-svid' && filing.by.did === intakeRecord.did
    && svid(filing.by.spiffe_id, intakeRecord.id) && allowed(a, FILING, 201, (line) => line.credential === 'jwt-svid' && line.sub === (isObject(filing.by) ? filing.by.spiffe_id : null), timeOf(filing.recorded_at)) ? filing : null;
  const write = Array.isArray(handoff.execute.result.writes) && handoff.execute.result.writes.length === 1 ? handoff.execute.result.writes[0] : null;
  const submitted = filed !== null && submission != null && submission.request_number === intake.request_number && submission.intake_id === intake.intake_id
    && submission.order_id === draft.document.order_id && submission.status === intake.status && isObject(submission.by) && submission.by.kind === 'token'
    && exactAct(submission.by.act, [draftRecord.did]) && isObject(write) && write.route === SUBMISSION && write.status === 201
    && write.system === 'records' && typeof submission.submission_id === 'string' && write.ref === submission.submission_id
    && timeOf(filed.recorded_at) <= timeOf(submission.recorded_at)
    && allowed(a, SUBMISSION, 201, (line) => line.credential === 'token' && exactAct(line.act, [draftRecord.did])
      && isObject(submission.by) && line.sub === submission.by.sub && line.delegation === submission.by.delegation, timeOf(submission.recorded_at)) ? submission : null;
  return { handoff, intake, filed, submission: submitted, completeDecision: decisionOf(handoff.intake, 'completeness'), acceptDecision: decisionOf(handoff.execute, 'accept_delivery') };
}

async function readSource<T>(member: string, read: () => Promise<T>): Promise<T> {
  try { return await read(); } catch (err) {
    if (err instanceof PreconditionError) throw err;
    throw new PreconditionError(`${member}.read_failed: the source could not be read`);
  }
}
async function outputsFor(session: EvidenceReadSession, refs: readonly string[]): Promise<KoiosUtxo[]> {
  if (refs.length === 0) return [];
  return koiosUtxoInfo(session.settings.urls.koios, [...refs], session.fetchImpl, READ_BYTES);
}
const assetMatches = (value: unknown, policy: string): boolean => isObject(value) && value.policy_id === policy;
function holds(row: KoiosUtxo, policy: string, token: string): boolean {
  const listed = row.asset_list?.filter((entry) => assetMatches(entry, policy));
  const asset = listed?.[0];
  return listed?.length === 1 && isObject(asset) && asset.asset_name === token && (asset.quantity === '1' || asset.quantity === 1);
}
async function tokenOutput(session: EvidenceReadSession, refs: readonly string[], policy: string, token: string, address?: string): Promise<KoiosUtxo | null> {
  const rows = (await outputsFor(session, refs)).filter((row) => refs.includes(outRef(row)) && row.payment_cred === policy
    && (address === undefined || row.address === address) && holds(row, policy, token) && typeof row.inline_datum?.bytes === 'string');
  return rows.length === 1 ? rows[0]! : null;
}
const tx = (session: EvidenceReadSession, hash: string): Promise<ScriptTxInfo> => scriptTxInfoOf(session.fetchImpl, session.settings.urls.koios, hash);
function spend(info: ScriptTxInfo, script: string, ref: string, constructor: number): boolean {
  const matching = info.inputs.filter((entry) => entry.credential === script);
  const redeemers = info.spends.filter((entry) => entry.script === script);
  return matching.length === 1 && matching[0]!.ref === ref && redeemers.length === 1 && redeemers[0]!.valid
    && (redeemers[0]!.input === null || redeemers[0]!.input === ref) && redeemers[0]!.action === constructor && redeemers[0]!.fields.length === 0;
}
async function confirmed(session: EvidenceReadSession, hash: string): Promise<boolean> {
  return ((await session.node.txStatus(hash)).confirmations ?? 0) > 0;
}

interface DelegationWindow { readonly id: string; readonly start: number; readonly end: number }
interface DelegationProof { readonly root: string | null; readonly children: ReadonlyMap<string, DelegationWindow> }
async function readDelegations(session: EvidenceReadSession, a: Assembly, drafter: RecordFact): Promise<DelegationProof> {
  const { delegation } = session.chain.deployment;
  const roots = new Set<string>();
  const datumOf = async (hash: string, id: string) => {
    const info = await tx(session, hash);
    const row = await tokenOutput(session, info.outputs.filter((entry) => entry.credential === delegation.hash).map((entry) => entry.ref), delegation.hash, id, delegation.address);
    return row === null ? null : { timeMs: info.timeMs, datum: decodeDelegationDatum(row.inline_datum!.bytes) };
  };
  for (const entry of a.reads.delegations) {
    const root = await datumOf(entry.tx, entry.id);
    if (root?.datum.parent === null && root.datum.delegate === drafter.id) roots.add(entry.id);
  }
  const root = roots.size === 1 ? [...roots][0]! : null;
  const children = new Map<string, DelegationWindow>();
  const proposal = named(a, 'propose');
  if (root === null || proposal === undefined) return { root, children };
  const receipt = a.receiptAttributions.get(proposal.entry.escrow_ref);
  if (receipt === undefined) return { root, children };
  // The proposal cannot read before its Claim or after its confirmed Submit.
  const submit = await tx(session, txOf(receipt.submitted_ref));
  const escrow = session.chain.deployment.escrow.hash;
  const claimed = submit.inputs.filter((entry) => entry.credential === escrow);
  if (claimed.length !== 1) return { root, children };
  const claim = await tx(session, txOf(claimed[0]!.ref));
  if (!spend(claim, escrow, proposal.entry.escrow_ref, 0)) return { root, children };
  for (const spec of actors(a.use).children) {
    const matches = a.reads.subDelegations.filter((entry) => entry.subagent === spec.id && entry.hire === proposal.entry.step);
    const child = recordOf(a, spec.id);
    if (matches.length !== 1 || child === null) continue;
    const entry = matches[0]!;
    const issued = await datumOf(entry.delegate_tx, entry.id);
    if (issued?.datum.parent !== root || issued.datum.delegate !== child.id) continue;
    const ended = await tx(session, entry.undelegate_tx);
    const start = Math.max(claim.timeMs, issued.timeMs, issued.datum.notBefore);
    const end = Math.min(submit.timeMs, ended.timeMs, issued.datum.notAfter);
    if (start < end) children.set(spec.id, { id: entry.id, start, end });
  }
  return { root, children };
}

async function boundedList(session: EvidenceReadSession, path: string): Promise<readonly Obj[]> {
  const response = await fetchBounded({ fetch: session.fetchImpl, timeoutMs: 30_000, maxBytes: READ_BYTES }, `${session.extra.indexer}${path}`,
    { method: 'GET', headers: { accept: 'application/json' } });
  if (!response.reached || response.reply.status !== 200) throw new Error('the dispute indexer did not answer within its limits');
  const body: unknown = JSON.parse(response.reply.body);
  if (!isObject(body) || !Array.isArray(body.cases) || !body.cases.every(isObject)) throw new Error('the dispute answer is not a case list');
  return body.cases;
}

interface CaseIdentity { readonly jury: string; readonly caseToken: string; readonly opened: string }
interface DisputeProof {
  readonly challenge: Challenge;
  readonly canonical: CaseIdentity | null;
  readonly policy: string;
  readonly application: HistoricalHoldCandidate | null;
}

/** Use the indexer only to find the verdict and the transaction that spent it. The core verifies both. */
async function readAppliedHold(session: EvidenceReadSession, subject: string, policy: string, located: unknown, challengeAt: number): Promise<HistoricalHoldCandidate | null> {
  if (located == null || (isObject(located) && located.applied_tx === null)) return null;
  const verdict = isObject(located) ? textOf(located.ref) : null;
  const applyTx = isObject(located) ? hashOf(located.applied_tx) : null;
  if (!isObject(located) || located.action !== 'suspend' || verdict === null || !REF.test(verdict) || applyTx === null) {
    throw new PreconditionError('hold: the dispute does not name an exact suspend verdict and application');
  }
  const applied = await tx(session, applyTx);
  const { identity } = session.chain.deployment;
  const inputs = applied.inputs.filter(({ credential }) => credential === identity.hash);
  const record = await tokenOutput(session, applied.outputs.filter(({ credential }) => credential === identity.hash).map(({ ref }) => ref),
    identity.hash, subject, identity.address);
  if (inputs.length !== 1 || record === null || !applied.inputs.some(({ ref, credential }) => ref === verdict && credential === policy)) {
    throw new PreconditionError('hold: the application does not spend this verdict and create the subject record');
  }
  const rows = await outputsFor(session, [verdict]);
  const output = rows.length === 1 ? rows[0] : undefined;
  if (output === undefined || outRef(output) !== verdict || output.payment_cred !== policy || output.is_spent !== true) {
    throw new PreconditionError('hold: the spent Module-1 verdict output is unproven');
  }
  const [agent, action, duration] = constrFields(decodePlutusData(output.inline_datum?.bytes ?? ''), 'verdict', 0, 6);
  constrFields(action!, 'verdict.action', 0, 0);
  if (bytesOf(agent!, 'verdict.subject', 32) !== subject || intOf(duration!, 'verdict.duration') !== HOLD_DURATION_MS) {
    throw new PreconditionError('hold: the ledger verdict does not prescribe seven days for this subject');
  }
  const status = decodeIdentityDatum(record.inline_datum!.bytes).status;
  const hold = status.type === 'Suspended' ? status.holds.find((entry) => entry.by.type === 'Script' && entry.by.hash === policy && entry.reason === DISPUTE_HOLD
    && challengeAt <= entry.since && entry.since <= applied.timeMs && entry.since < entry.until) : undefined;
  if (hold === undefined) throw new PreconditionError('hold: the application output does not show the Module-1 hold of this dispute');
  const prior = await tokenOutput(session, [inputs[0]!.ref], identity.hash, subject, identity.address);
  if (prior?.is_spent !== true) throw new PreconditionError('hold: the preceding identity output is unproven');
  const before = decodeIdentityDatum(prior.inline_datum!.bytes).status;
  // The validated Suspend uses the exact lower validity bound as `since`, not the block time.
  // Module-1 ignores interval inclusivity and keeps a longer hold already in force.
  const sevenDayEnd = hold.since + HOLD_DURATION_MS;
  const keptUntil = before.type === 'Suspended' ? before.holds.find(({ by, until }) => by.type === 'Script' && by.hash === policy && until > hold.since)?.until : undefined;
  const expectedEnd = Math.max(sevenDayEnd, keptUntil ?? sevenDayEnd);
  if (!Number.isSafeInteger(sevenDayEnd) || hold.until !== expectedEnd || expectedEnd !== sevenDayEnd) {
    throw new PreconditionError('hold: the actual Module-1 hold is not exactly seven days from its lower validity bound');
  }
  return { verdict_output: verdict, record_output: outRef(record), reason: hold.reason, since: hold.since, until: hold.until, gateway_status: null };
}

type IdentityVersion = Awaited<ReturnType<typeof findRecord>>;
function observeHold(record: IdentityVersion, policy: string, now: number): { ref: string; since: number; until: number } | null {
  const status = record?.record.status;
  const hold = status?.type === 'Suspended' ? status.holds.find((entry) => entry.by.type === 'Script' && entry.by.hash === policy && entry.reason === DISPUTE_HOLD
    && entry.since <= now && now < entry.until) : undefined;
  return record === null || hold === undefined ? null : { ref: recordRef(record.utxo), since: hold.since, until: hold.until };
}

/** Reproduce the pinned fault on the signed proposal, and check the exact wire commitment at the intake Post. */
async function faultEvidenceMatches(session: EvidenceReadSession, a: Assembly, refs: EvidenceReferences, bytes: Uint8Array): Promise<boolean> {
  const proposal = proposalOf(a, 'propose-a');
  const handoff = signedHandoff(a, 'execute-a', 'intake-a');
  if (proposal === null || handoff === null || handoff.intake.report !== null || handoff.execute.result.proposal_digest !== proposal.digest
    || handoff.execute.result.fault_mode !== FAULT || !matchesRefusal(handoff.execute.result, 'altered')) return false;
  const request = requestOf(a, handoff.execute);
  const identity = request?.approval;
  if (identity == null || request?.digest !== proposal.digest
    || !a.loaded.record.approvals.some((entry) => entry.role === 'approval' && entry.attestation === identity.attestation)) return false;
  const approval = parseApprovalRef(identity);
  const payment = await a.paidFromVault(handoff.intake.entry);
  if (!approval.ok || !payment.paid) return false;

  const altered = makeProposal(alterJustification(proposal.document), proposal.salt);
  if (!altered.ok || altered.value.proposal_digest === proposal.digest) return false;
  const sent = parseHandoff({ schema: HANDOFF_SCHEMA, use_case: data.name, sender_did: refs.against_did, delegation: payment.delegation,
    document: altered.value.document, salt: altered.value.salt, approval: approval.value });
  if (!sent.ok) return false;
  const escrow = session.chain.deployment.escrow;
  const rows = await outputsFor(session, [refs.escrow_ref]);
  const posted = rows.length === 1 ? rows[0] : undefined;
  if (posted === undefined || outRef(posted) !== refs.escrow_ref || posted.address !== escrow.address || posted.payment_cred !== escrow.hash) return false;
  const datum = decodeIdentityEscrowDatum(posted.inline_datum?.bytes ?? '');
  if (datum.state !== 'Open' || datum.prompt_hash !== promptHashForPayload(requestText(sent.value))) return false;
  const expected = evidenceDocument({ ...refs, kind: 'approval_digest', use_case: 'prior-authorization', statement_text: 'The claim statement.',
    approval: approval.value, mismatch: { ok: false, code: 'approval_digest_mismatch', detail: 'The digests differ.',
      expected_digest: proposal.digest, observed_digest: altered.value.proposal_digest } });
  if (!expected.ok) return false;
  const expectedRows = expected.value.text.split('\n');
  const rowsOfEvidence = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes).split('\n');
  // The statement text comes from the filed claim, not from the proposal. Its row and all other rows must have the producer's shape.
  const statementPrefix = 'Statement S1 of the claim reads: ';
  return rowsOfEvidence.length === expectedRows.length && rowsOfEvidence.every((row, i) => i === 1
    ? row.startsWith(statementPrefix) && row.length > statementPrefix.length : row === expectedRows[i]);
}

async function readDispute(session: EvidenceReadSession, a: Assembly, drafter: RecordFact, intake: RecordFact): Promise<DisputeProof> {
  const claim = a.facts.claims[a.loaded.record.label]?.[actors(a.use).drafter.id];
  const commit = session.settings.module1Commit;
  if (claim === undefined || a.loaded.record.challenged !== actors(a.use).drafter.id || commit === null) {
    throw new PreconditionError('challenge: the run needs the drafting agent claim and the pinned Module-1 manifest');
  }
  const pin = `${MANIFEST_BASE}/${commit}/${a.use.moduleManifestPath}`;
  const module1 = module1FromManifest(await readManifest(pin, 'the pinned Module-1 manifest', session.fetchImpl), pin);
  if (module1.identityHash !== session.chain.deployment.identity.hash || module1.network !== 'mainnet' || session.settings.network.name !== 'vector-mainnet') {
    throw new PreconditionError('challenge: the manifest names another deployment');
  }
  const rows = (await boundedList(session, `/disputes?agent_id=${drafter.id}`)).filter((row) => row.claim_ref === claim.claimRef && row.claimer_agent_id === drafter.id);
  const selected = rows.length === 1 ? rows[0] : null;
  const indexed = selected?.challenge;
  const challengeTx = isObject(indexed) && indexed.genuine === true && indexed.auditor_agent_id === intake.id ? hashOf(indexed.tx) : null;
  if (challengeTx === null) throw new PreconditionError('challenge: no unique genuine challenge of this claim was identified');
  const config = await findConfigRecord(session.chain.provider, session.chain.deployment);
  if (config === null) throw new PreconditionError('challenge: the Module-1 policy cannot be read from the configuration record');
  const info = await tx(session, challengeTx);
  const minted = info.minted.filter((asset) => asset.policy === module1.challenge.hash && asset.quantity === 1n && CHALLENGE_TOKEN.test(asset.name));
  if (minted.length !== 1 || !spend(info, module1.claim.hash, claim.claimRef, 2)) throw new PreconditionError('challenge: the transaction does not mark this claim and mint one challenge');
  const token = minted[0]!.name;
  const original = await tokenOutput(session, [claim.claimRef], module1.claim.hash, claim.claimToken, module1.claim.address);
  const row = await tokenOutput(session, info.outputs.filter((entry) => entry.credential === module1.challenge.hash).map((entry) => entry.ref), module1.challenge.hash, token, module1.challenge.address);
  if (original === null || original.is_spent !== true || row === null) throw new PreconditionError('challenge: the exact claim and challenge outputs cannot be read');
  const claimer = decodeClaimDatum(original.inline_datum!.bytes);
  const challenge = decodeChallengeDatum(row.inline_datum!.bytes);
  const auditor = await findRecord(session.chain.provider, session.chain.deployment, intake.id);
  const keys = auditor?.record.keys.filter((key) => key.keyType === 'Ed25519' && (key.purposes & PURPOSE.transaction) !== 0) ?? [];
  if (claimer.claimerDid !== drafter.id || claimer.state !== 'Open' || challenge.auditorDid !== intake.id || challenge.auditorCredential.type !== 'VerificationKey'
    || !keys.some(({ key }) => keyHashOf(key) === challenge.auditorCredential.hash) || challenge.claimToken !== claim.claimToken
    || `${challenge.claimRef.txHash}#${challenge.claimRef.outputIndex}` !== claim.claimRef) throw new PreconditionError('challenge: the ledger parties, transaction key or claim do not match');
  const evidenceTx = txHashOfUri(Buffer.from(challenge.evidenceUri, 'hex').toString('utf8'));
  if (evidenceTx === null) throw new PreconditionError('challenge.evidence: the on-chain evidence transaction is unproven');
  const doc = await readDocument(documentUri(evidenceTx), { koiosUrl: session.settings.urls.koios, fetchImpl: session.fetchImpl });
  const refs = evidenceReferences(doc.bytes);
  const failed = named(a, 'intake-a');
  if (doc.type !== 'evidence' || doc.hash !== challenge.evidenceHash || !refs.ok || refs.value.claim !== claim.claimRef || refs.value.claim_token !== claim.claimToken
    || refs.value.against_did !== drafter.did || refs.value.by_did !== intake.did || failed?.role !== 'intake' || refs.value.escrow_ref !== failed.entry.escrow_ref
    || (a.purpose === 'run' && !await faultEvidenceMatches(session, a, refs.value, doc.bytes))) {
    throw new PreconditionError('challenge.evidence: the evidence document does not bind the fault hire, exact approval, digests and both parties');
  }

  const canonical = selected?.jury;
  let caseIdentity: CaseIdentity | null = null;
  if (canonical !== null && canonical !== undefined) {
    const jury = isObject(canonical) ? textOf(canonical.script_hash) : null;
    const caseToken = isObject(canonical) ? hashOf(canonical.case) : null;
    const openedTx = isObject(canonical) && isObject(canonical.opened) ? hashOf(canonical.opened.tx) : null;
    if (jury === null || !SCRIPT.test(jury) || caseToken === null || openedTx === null || !isObject(canonical) || canonical.canonical !== true
      || canonical.claim !== claim.claimToken || canonical.challenge !== token || canonical.challenge_out !== outRef(row)) throw new PreconditionError('case: the indexer names a different claim, challenge or jury identity');
    const opening = await tx(session, openedTx);
    const caseRow = await tokenOutput(session, opening.outputs.filter((item) => item.credential === jury).map((item) => item.ref), jury, caseToken);
    const datum = caseRow === null ? null : decodeJuryDatum(caseRow.inline_datum!.bytes);
    const opened = datum?.type === 'Case' && datum.case.claimer === drafter.id && datum.case.auditor === intake.id && datum.case.claim === claim.claimToken
      && datum.case.challenge === token && `${datum.case.challengeOut.txHash}#${datum.case.challengeOut.outputIndex}` === outRef(row)
      && opening.minted.some((asset) => asset.policy === jury && asset.name === caseToken && asset.quantity === 1n) && await confirmed(session, openedTx);
    if (!opened) throw new PreconditionError('case: the ledger does not show the canonical case of these parties');
    caseIdentity = { jury, caseToken, opened: openedTx };
  }
  const application = isObject(canonical) && isObject(canonical.finalized) && canonical.finalized.result === 'AuditorWins'
    ? await readSource('hold', () => readAppliedHold(session, drafter.id, config.m1, selected?.verdict, info.timeMs)) : null;
  return { challenge: { agent: actors(a.use).drafter.id, claim: claim.claimRef, evidence: evidenceTx, challenge: outRef(row) },
    canonical: caseIdentity, policy: config.m1, application };
}

async function readListing(session: EvidenceReadSession, a: Assembly, draft: RecordFact): Promise<boolean> {
  const { drafter } = actors(a.use);
  const answer = await session.hosted.call('vector_marketplace_list_suppliers', { capability_id: drafter.capability, only_free: false, limit: 50 });
  const fenced = [...answer.text.matchAll(/```json\n([\s\S]*?)\n```/g)].at(-1);
  if (answer.failed || fenced === undefined || fenced[1]!.length > READ_BYTES) throw new Error('the listing cannot be read');
  const rows: unknown = JSON.parse(fenced[1]!);
  if (!Array.isArray(rows) || rows.length >= 50 || !rows.every((row) => isObject(row) && row.capability_id === drafter.capability
      && typeof row.advert_ref === 'string' && REF.test(row.advert_ref) && (row.did === null || typeof row.did === 'string' && DID.test(row.did))
      && (row.agent_id === null ? row.did === null : hashOf(row.agent_id) !== null && row.did === `did:vector:${row.agent_id}`))) throw new Error('the complete listing cannot be read');
  const refs = Object.values(a.facts.adverts[drafter.id] ?? {}).map((entry) => entry.ref);
  return refs.length > 0 && !rows.some((row) => row.did === draft.did || refs.includes(row.advert_ref));
}

interface ProbeProof {
  readonly control: { readonly at: string; readonly did: string; readonly status: null; readonly code: null; readonly token_type: 'DPoP'; readonly expires_at: string };
  readonly refusal: { readonly at: string; readonly did: string; readonly status: 400 | 401; readonly code: string };
}
interface EpochChange { readonly tx: string; readonly at: number; readonly input: string; readonly output: string; readonly epochBefore: number; readonly epochAfter: number }
interface EndProof extends EpochChange { readonly children: readonly { did: string; effective: 'Revoked' }[]; readonly probe: ProbeProof | null }

function probeProof(session: EvidenceReadSession, a: Assembly, at: number, ended: readonly { did: string }[]): ProbeProof | null {
  const file = join(session.settings.stateDir, `probe.${a.loaded.record.label}.evidence.json`);
  let json: unknown;
  try { json = readJsonFile(file, 'the run probe evidence'); }
  catch (err) { if (err instanceof Error && err.message.endsWith('(ENOENT)')) return null; throw err; }
  if (!isObject(json) || json.format !== 1 || json.check !== 'probe' || json.network !== session.settings.network.name
    || json.record !== `${a.use.name}:${a.loaded.record.label}` || !Array.isArray(json.entries)) throw new Error('the probe journal has another identity');
  const child = actors(a.use).children.find(({ id }) => id === 'record-reader');
  const childFact = child === undefined ? null : recordOf(a, child.id);
  if (child === undefined || childFact === null || !ended.some(({ did }) => did === childFact.did)) return null;
  const resource = `${MOCK_PUBLIC_BASE}/t/${a.loaded.record.tenant}/records`;
  const now = session.clock.now();
  let control: ProbeProof['control'] | undefined;
  let refusal: ProbeProof['refusal'] | undefined;
  for (const entry of json.entries) {
    if (!isObject(entry) || entry.step !== 'run' || entry.status !== 'info' || !isObject(entry.shows) || typeof entry.at !== 'string') continue;
    const { probe, record, observation, verdict } = entry.shows;
    if (!isObject(probe) || !isObject(record) || !isObject(observation) || !isObject(verdict) || verdict.ok !== true || Object.hasOwn(probe, 'delegation')
      || probe.subagent !== child.id || record.did !== childFact.did || probe.resource !== resource || probe.action !== 'record.read'
      || !child.keys.some((key) => key.key === probe.subjectKey && key.purposes.includes('authentication'))
      || !child.keys.some((key) => key.key === probe.dpopKey && key.purposes.includes('delegation')) || probe.subjectKey === probe.dpopKey) continue;
    const t = canonicalTime(entry.at);
    if (!Number.isFinite(t) || t > now || verdict.expected !== probe.expect || verdict.observed !== probe.expect || observation.kind !== probe.expect) continue;
    if (probe.expect === 'granted' && record.effectiveStatus === 'active' && t < at && observation.tokenType === 'DPoP'
      && typeof observation.expiresAt === 'string' && canonicalTime(observation.expiresAt) > t) {
      control ??= { at: entry.at, did: childFact.did, status: null, code: null, token_type: 'DPoP', expires_at: observation.expiresAt };
    }
    const { status, error, text } = observation;
    if (probe.expect === 'refused' && record.effectiveStatus === 'revoked' && t > at && (status === 400 || status === 401)
      && (error === 'invalid_request' || error === 'agent_not_active' || error === 'invalid_token')
      && typeof text === 'string' && /^subject_token: the agent's effective status is revoked(?:$|[ .,:;])/.test(text)) {
      refusal ??= { at: entry.at, did: childFact.did, status, code: error };
    }
  }
  return control !== undefined && refusal !== undefined ? { control, refusal } : null;
}

async function readEpochChange(session: EvidenceReadSession, a: Assembly, parent: RecordFact): Promise<EpochChange | null> {
  const fact = a.facts.subagentEnds[actors(a.use).drafter.id];
  if (fact === undefined || !HASH.test(fact.tx) || fact.epochAfter !== fact.epochBefore + 1 || !await confirmed(session, fact.tx)) return null;
  const { identity } = session.chain.deployment;
  const info = await tx(session, fact.tx);
  const inputs = info.inputs.filter((entry) => entry.credential === identity.hash).map((entry) => entry.ref);
  const outputs = info.outputs.filter((entry) => entry.credential === identity.hash).map((entry) => entry.ref);
  // The identity decoder's BumpEpoch redeemer is constructor 8 and has no fields.
  if (inputs.length !== 1 || outputs.length !== 1 || !spend(info, identity.hash, inputs[0]!, 8) || info.minted.length !== 0) return null;
  const before = await tokenOutput(session, inputs, identity.hash, parent.id, identity.address);
  const after = await tokenOutput(session, outputs, identity.hash, parent.id, identity.address);
  if (before === null || after === null || before.is_spent !== true || before.value !== after.value) return null;
  const prior = decodeIdentityDatum(before.inline_datum!.bytes);
  if (prior.subagentEpoch !== fact.epochBefore || encodeIdentityDatum({ ...prior, subagentEpoch: fact.epochAfter }) !== encodeIdentityDatum(decodeIdentityDatum(after.inline_datum!.bytes))) return null;
  return { tx: fact.tx, at: info.timeMs, input: outRef(before), output: outRef(after), epochBefore: fact.epochBefore, epochAfter: fact.epochAfter };
}

async function readEnd(session: EvidenceReadSession, a: Assembly, parent: RecordFact, current: IdentityVersion, change: EpochChange): Promise<EndProof | null> {
  const { children: roster } = actors(a.use);
  if (current === null || current.record.subagentEpoch !== change.epochAfter || roster.length !== 2) return null;
  const children: Array<{ did: string; effective: 'Revoked' }> = [];
  for (const child of roster) {
    const known = recordOf(a, child.id);
    if (known === null) return null;
    const record = await findRecord(session.chain.provider, session.chain.deployment, known.id);
    const lineage = record?.record.lineage;
    if (record === null || lineage?.type !== 'Subagent' || lineage.parent !== parent.id || lineage.parentEpoch !== change.epochBefore || lineage.depth !== 1
      || record.record.status.type !== 'Active' || effectiveStatus(record.record, new Map([[parent.id, current.record]]), session.clock.now(), session.clock.now()) !== 'Revoked') return null;
    const answer = await session.hosted.call('vector_resolve_did', { did: known.did });
    if (answer.failed) throw new Error('the subagent resolver could not be read');
    const metadata = answer.json?.didDocumentMetadata;
    const state = isObject(metadata) ? metadata.vectorStatus : null;
    if (!isObject(state) || typeof state.effective !== 'string' || state.effective.toLowerCase() !== 'revoked') return null;
    children.push({ did: known.did, effective: 'Revoked' });
  }
  return { ...change, children, probe: probeProof(session, a, change.at, children) };
}

class Sources {
  constructor(readonly delegation: DelegationProof | null, readonly payment: VaultPayment | null, readonly dispute: DisputeProof | null,
    readonly unlisted: boolean, readonly end: EndProof | null, readonly activeHoldObserved: boolean, readonly currentHold: string | null) {}
}
function prepared(a: Assembly): Sources {
  const value = a.extra.prior;
  if (!(value instanceof Sources)) throw new PreconditionError('the evidence sources were not read');
  return value;
}

const faultOf = (a: Assembly) => {
  const { drafter } = actors(a.use);
  const hire = named(a, 'execute-a');
  const at = hire === undefined ? undefined : a.times.get(hire.entry.post_tx);
  return at === undefined ? undefined : a.faults.filter((entry) => entry.ok && entry.agent === drafter.id && entry.check === FAULT && entry.atMs <= at
    && entry.services.every((service) => service.value === (service.service === drafter.serviceContainer ? FAULT : ''))
    && entry.services.some((service) => service.service === drafter.serviceContainer))
    .sort((l, r) => r.atMs - l.atMs)[0];
};

function proposalReadRefs(a: Assembly): Ref[] | string {
  const p = proposalOf(a, 'propose');
  const roster = actors(a.use);
  const draft = recordOf(a, roster.drafter.id);
  const reads = prepared(a).delegation;
  if (p === null || draft === null || reads === null || roster.children.length !== 2 || reads.children.size !== 2) return 'the proposal or the two child delegations are unproven';
  const on = (route: string, id: string): boolean => {
    const child = recordOf(a, id);
    const window = reads.children.get(id);
    return child !== null && window !== undefined && allowed(a, route, 200, (line) => {
      const at = canonicalTime(line.at);
      return window.start <= at && at < window.end && line.credential === 'token' && exactAct(line.act, [child.did, draft.did]) && line.delegation === window.id;
    });
  };
  const escrow = decisionOf(p.hire, 'justification');
  if (escrow === null || !on(ORDER_READ, 'record-reader') || !on(GUIDELINE_READ, 'drafter')) return 'both attributed reads and the justification decision are not shown';
  const sub = a.reads.subDelegations.filter((one) => one.subagent !== null && reads.children.get(one.subagent)?.id === one.id);
  return [...hireRefs(p.hire), ...sub.flatMap((one) => [ref('delegation', one.id), ref('transaction', one.delegate_tx), ref('transaction', one.undelegate_tx)]), ref('escrow', escrow)];
}

const RULES: EvidenceModule['rules'] = {
  'r1-01': (a) => {
    const root = prepared(a).delegation?.root;
    const delegation = a.reads.delegations.find((one) => one.id === root);
    const binding = a.approvalStates.find((one) => one?.entry.role === 'binding' && one.state === 'active' && one.type === 4);
    const vault = a.reads.vaults.length === 1 ? a.reads.vaults[0] : undefined;
    return delegation !== undefined && binding != null && vault !== undefined && a.loaded.record.approvals.filter((one) => one.role === 'binding').length === 1
      ? [ref('delegation', delegation.id), ref('transaction', delegation.tx), ...approvalRefs(binding), ref('vault', vault.ref), ref('transaction', vault.open_tx)]
      : 'the correct delegation, principal binding and vault are not all proved';
  },
  'r1-02': proposalReadRefs,
  'r1-03': (a) => {
    const p = proposalOf(a, 'propose');
    const approval = approvalOf(a, 'execute');
    return p !== null && approval?.state === 'active' && approval.digest === p.digest ? approvalRefs(approval) : 'the execute request does not prove the approval of this proposal';
  },
  'r1-04': (a) => {
    const handoff = signedHandoff(a, 'execute', 'intake');
    const payment = prepared(a).payment;
    const vault = a.reads.vaults.length === 1 ? a.reads.vaults[0] : undefined;
    return handoff !== null && payment?.paid === true && payment.delegation === prepared(a).delegation?.root
      && vault?.state === 'closed' && vault.lineage.delegation === payment.delegation && vault.lineage.path.includes(payment.vault_ref)
      ? [...hireRefs(handoff.execute), ...intakeRefs(handoff), ref('vault', payment.vault_ref)] : 'the signed handoff or the payment from the run vault is unproven';
  },
  'r1-05': (a) => {
    const done = completedOf(a);
    return done?.filed != null && done.completeDecision !== null ? [...intakeRefs(done.handoff), ref('escrow', done.completeDecision)]
      : 'the signed intake, its fifteen checks or the attributed JWT-SVID filing is unproven';
  },
  'r1-06': (a) => {
    const done = completedOf(a);
    const accept = done?.handoff.intake.entry.accept_tx;
    return done?.submission != null && done.acceptDecision !== null && accept != null ? [ref('transaction', accept), ref('escrow', done.acceptDecision)]
      : 'the accepted intake and the matching records submission are not both shown';
  },
  'r1-07': (a) => {
    const delegation = a.reads.delegations.find((one) => one.id === prepared(a).delegation?.root);
    const vault = a.reads.vaults[0];
    return delegation?.ended_tx != null && vault?.close_tx != null ? [ref('transaction', vault.close_tx), ref('transaction', delegation.ended_tx)] : 'the run vault and delegation did not both end';
  },
  'r2-d': (a) => {
    const first = refusalOf(a, 'd1', 'revoked');
    const second = approvalOf(a, 'execute-d2');
    const done = completedOf(a);
    return first !== null && second?.state === 'active' && first.approval.entry.revoked_tx !== null && second.entry.supersedes === first.approval.entry.attestation
      && second.entry.attestation !== first.approval.entry.attestation && second.digest === first.approval.digest && done?.submission != null && prepared(a).payment?.paid === true
      ? [...approvalRefs(first.approval), ...approvalRefs(second), ...refusedRefs(first), ...hireRefs(done.handoff.execute), ...intakeRefs(done.handoff)]
      : 'the two exact approval uses, supersedes link, refund and completed retry are not all proved';
  },
  'r2-e': (a) => {
    const failure = refusalOf(a, 'e', 'expired');
    const p = proposalOf(a, 'propose-e');
    return failure !== null && p?.digest === failure.approval.digest ? [...approvalRefs(failure.approval), ...refusedRefs(failure)]
      : 'the expired approval and its exact, fully reclaimed intake are not shown';
  },
  'r2-a': (a) => {
    const failure = refusalOf(a, 'a', 'altered');
    const p = proposalOf(a, 'propose-a');
    const guard = faultOf(a);
    const requests = sectionRows(a.mock?.state ?? {}, 'insurer', 'requests');
    return failure !== null && p?.digest === failure.approval.digest && guard !== undefined && requests !== null
      && requests.every((request) => typeof request.request_number === 'string' && request.request_number.toLowerCase() !== p.document.request_number.toLowerCase())
      ? [...approvalRefs(failure.approval), ...refusedRefs(failure), ref('fault_check', new Date(guard.atMs).toISOString())]
      : 'the faulty handoff, prior guard, full refund or absence of a matching filing is unproven';
  },
  'r2-b': (a) => {
    const proof = prepared(a).dispute;
    return proof?.canonical != null && caseMatches(a, proof.canonical) ? [ref('claim', proof.challenge.claim), ref('transaction', proof.challenge.evidence), ref('challenge', proof.challenge.challenge)]
      : 'the ledger does not show the canonical case of the challenge';
  },
  'r2-b-hold': (a) => {
    const c = a.caseRead;
    const proof = prepared(a).dispute;
    return proof?.canonical != null && caseMatches(a, proof.canonical) && c?.verdict === 'AuditorWins' && c.indexed?.finalized_tx != null
      && proof.application != null && c.hold?.record_output === proof.application.record_output
      ? [ref('case', c.indexed.case_token), ref('transaction', c.indexed.finalized_tx), ref('verdict', proof.application.verdict_output), ref('hold', c.hold.record_output)]
      : 'the case did not prove application of its AuditorWins verdict; a different verdict needs a new claim and challenge';
  },
  'r2-c': (a) => {
    const c = a.caseRead;
    const { dispute, currentHold, unlisted } = prepared(a);
    const refs = Object.values(a.facts.adverts[actors(a.use).drafter.id] ?? {}).map((entry) => entry.ref);
    const refused = a.loaded.record.refusals.some((entry) => entry.kind === 'tool' && entry.step === 'r2-c'
      && refs.some((ref) => entry.message.includes(`Advert ${ref} is not listed by the marketplace indexer`)));
    return dispute?.canonical != null && caseMatches(a, dispute.canonical) && c?.verdict === 'AuditorWins' && dispute.application !== null
      && c.hold?.record_output === dispute.application.record_output && currentHold !== null && unlisted && refused
      ? [ref('hold', currentHold), ref('transaction', txOf(currentHold))] : 'the current hold, absent listing and refusal of the exact advert are not all shown';
  },
  'r2-f': (a) => {
    const end = prepared(a).end;
    return end?.probe != null ? [ref('transaction', end.tx), ...end.children.map(({ did }) => ref('did', did)), ref('probe', end.probe.control.at), ref('probe', end.probe.refusal.at)]
      : 'the parent BumpEpoch, both revoked resolutions and the paired probe are not all shown';
  },
};

function caseMatches(a: Assembly, expected: CaseIdentity): boolean {
  const current = a.caseRead;
  if (current?.indexed != null) return indexedCaseMatches(current.indexed, expected);
  return current?.listed != null && current.listed.jury === expected.jury && current.listed.case_token === expected.caseToken;
}

const indexedCaseMatches = (actual: IndexedCase, expected: CaseIdentity): boolean =>
  actual.jury === expected.jury && actual.case_token === expected.caseToken && actual.opened_tx === expected.opened;

function approvalDocument(approval: ApprovalRead): Obj {
  return { attestation: approval.entry.attestation, tx: approval.entry.tx, hire: approval.hire, digest: approval.digest,
    issued_at: approval.issued_at, issued_block_at: approval.issued_block_at, valid_until: approval.valid_until, checked_at: approval.checked_at,
    state_at_hire: approval.state, link: approval.link, revoked_tx: approval.entry.revoked_tx, supersedes: approval.entry.supersedes };
}
const enumOf = (value: unknown, allowed: readonly string[]): string | null => typeof value === 'string' && allowed.includes(value) ? value : null;
function operationFields(hire: ReportedHire): Record<string, string | boolean | number | null> {
  const outcome = hire.role === 'propose' ? enumOf(hire.result.outcome, ['proposed', 'failed']) : hire.role === 'intake' ? enumOf(hire.result.outcome, ['done']) : enumOf(hire.result.outcome, EXECUTE_OUTCOMES);
  return { operation: hire.role, outcome, reason: isErrorCode(hire.result.reason) ? hire.result.reason : null,
    exit_state: enumOf(hire.result.exit_state, EXIT_STATES), proposal_digest: hashOf(hire.result.proposal_digest) };
}

export const priorAuthorization: EvidenceModule = {
  rules: RULES,
  runKinds: ['clean', 'failure'], hireRoles: HIRE_ROLES, reportOptional: ['intake'], reportSchemas: REPORT_SCHEMAS,
  agentOf: (role) => role === 'intake' ? [AGENTS.intake.id] : role === 'propose' || role === 'execute' ? [AGENTS.drafter.id] : [],
  carriedOf: (hires) => lastHire(hires, 'execute')?.entry ?? null,
  claimAgents: (a) => { const { drafter, intake } = actors(a.use); return [drafter.id, intake.id]; },
  hireOfApproval: (a, i) => approvalHire(a, i)?.entry.step ?? null,
  approvalExpectations(a, i) {
    const entry = a.loaded.record.approvals[i];
    const hire = approvalHire(a, i);
    const identity = hire === null ? null : requestOf(a, hire)?.approval;
    if (entry === undefined || identity == null) throw new PreconditionError('the exact execute approval is unproven');
    const issuer = { type: 'did' as const, id: identity.issuer_did.slice('did:vector:'.length) };
    return entry.role === 'binding' ? { issuer } : { issuer, maxValidityMs: RUN_APPROVAL_VALIDITY_MS, clockSlackMs: 60_000 };
  },
  challengeOf: (a) => prepared(a).dispute?.challenge ?? null,
  holdOf(a, source) {
    const { dispute, activeHoldObserved } = prepared(a);
    const indexed = source.indexed;
    if (indexed?.finalized_result !== 'AuditorWins') {
      if (activeHoldObserved && source.listed?.state === 'Settling' && source.listed.outcome === 'AuditorWins') {
        throw new PreconditionError('the current hold does not prove a verdict application without the exact Finalize transaction');
      }
      return null;
    }
    if (dispute?.canonical == null || !indexedCaseMatches(indexed, dispute.canonical)) throw new PreconditionError('the dispute and Finalize readers name different jury cases');
    if (dispute.application === null && activeHoldObserved) {
      throw new PreconditionError('the exact verdict application is unproven; the current hold alone does not prove it');
    }
    return dispute.application;
  },
  hosted: ['vector_marketplace_list_suppliers'],
  async prepare(session, a) {
    const { drafter, intake } = actors(a.use);
    const draft = recordOf(a, drafter.id);
    const counterparty = recordOf(a, intake.id);
    if (draft === null || counterparty === null) throw new PreconditionError('records: the two agent records are missing');
    const clean = a.loaded.record.kind === 'clean';
    const run = a.purpose === 'run';
    const handoff = run ? signedHandoff(a, clean ? 'execute' : 'execute-d2', clean ? 'intake' : 'intake-d2') : null;
    const delegation = run && clean ? await readSource('delegations', () => readDelegations(session, a, draft)) : null;
    const payment = handoff === null ? null : await a.paidFromVault(handoff.intake.entry);
    const dispute = a.loaded.record.challenged === null ? null : await readSource('challenge', () => readDispute(session, a, draft, counterparty));
    const current = dispute === null ? null : await readSource('hold', () => findRecord(session.chain.provider, session.chain.deployment, draft.id));
    const observed = dispute === null ? null : observeHold(current, dispute.policy, session.clock.now());
    const epoch = run && !clean ? await readSource('subagent_ends', () => readEpochChange(session, a, draft)) : null;
    const application = dispute?.application;
    // BumpEpoch changes only the epoch. A different current hold or record is not evidence of the listing refusal.
    const currentHold = application != null && observed !== null && observed.since === application.since && observed.until === application.until
      && (observed.ref === application.record_output || (epoch?.input === application.record_output && epoch.output === observed.ref)) ? observed.ref : null;
    const unlisted = run && !clean && currentHold !== null ? await readSource('listing', () => readListing(session, a, draft)) : false;
    const end = epoch === null ? null : await readSource('subagent_ends', () => readEnd(session, a, draft, current, epoch));
    return { prior: new Sources(delegation, payment, dispute, unlisted, end, observed !== null, currentHold) };
  },
  mockRoutes: [ORDER_READ, GUIDELINE_READ, SUBMISSION, FILING],
  counts(state) {
    const requests = sectionRows(state, 'insurer', 'requests');
    const submissions = sectionRows(state, 'records', 'submissions');
    return requests === null || submissions === null ? null : { insurer_requests: requests.length, record_submissions: submissions.length };
  },
  projectPublicResult(hire) {
    return { fields: operationFields(hire), decisionNames: hire.role === 'propose' ? ['justification'] : hire.role === 'intake' ? ['completeness'] : ['accept_delivery'] };
  },
  moduleDocument(a) {
    const { drafter, intake } = actors(a.use);
    const { kind, label } = a.loaded.record;
    const done = completedOf(a);
    const end = prepared(a).end;
    const binding = a.approvalStates.find((entry) => entry?.entry.role === 'binding' && entry.type === 4 && entry.state === 'active');
    const routeEvidence: PublicRouteEvidence[] = [];
    if (kind === 'clean') {
      if (typeof proposalReadRefs(a) !== 'string') routeEvidence.push(...[ORDER_READ, GUIDELINE_READ].map((route): PublicRouteEvidence =>
        ({ step: 'r1-02', route, credential: 'token', decision: 'allowed', act_links: 2, count: 1 })));
      if (done?.filed != null && done.completeDecision !== null) routeEvidence.push({ step: 'r1-05', route: FILING, credential: 'jwt-svid', decision: 'allowed', act_links: 0, count: 1 });
      if (done?.submission != null && done.acceptDecision !== null) routeEvidence.push({ step: 'r1-06', route: SUBMISSION, credential: 'token', decision: 'allowed', act_links: 1, count: 1 });
    }
    return {
      run: `use-case-2-${kind}`,
      claims: { [drafter.id]: a.facts.claims[label]?.[drafter.id]?.claimRef ?? null, [intake.id]: a.facts.claims[label]?.[intake.id]?.claimRef ?? null },
      fault_mode: { [drafter.id]: a.loaded.carried?.result.fault_mode === FAULT ? FAULT : '', [intake.id]: '' },
      approvals: a.approvalStates.flatMap((entry) => entry?.entry.role === 'approval' && entry.link === 'request' ? [approvalDocument(entry)] : []),
      binding: binding == null ? null : approvalDocument(binding),
      outcomes: a.loaded.hires.flatMap((hire) => hire.role === 'execute' && hire.report !== null ? [{ step: hire.entry.step, ...operationFields(hire) }] : []),
      route_evidence: routeEvidence, handoff_evidence: done === null ? null : projectHandoff(done.handoff),
      intake: done?.filed == null ? null : { status: done.intake.status, missing_count: done.intake.missing.length,
        attestations: done.intake.attestations, checks: INTAKE_CHECKS.length },
      submission: done?.submission == null ? null : { intake_id_sha256: digestOf(done.intake.intake_id), request_number_sha256: digestOf(done.intake.request_number) },
      subagent_ends: end === null ? null : { tx: end.tx, at: end.at, epoch_before: end.epochBefore, epoch_after: end.epochAfter },
      subagent_resolutions: end?.children ?? [], probe: end?.probe ?? null,
    };
  },
};
