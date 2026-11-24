// scripts/operator/lib/run-record.ts - the run record of a run, the report file of a hire, and the readers of the files and of the block times that the task `evidence` needs.
// The operator writes `<state>/runs/<label>.json` from what the session of the hirer showed, and one report file for each hire in the folder `<state>/runs/<label>/`. Both are strict: an unknown member,
// a member of a wrong shape, a hash or a reference that is not in its canonical form, a refusal without its facts and any text with a mark of a secret are refused, and the message names the member and
// never shows a value. The record and the reports are inputs: the task `evidence` checks each reference in them against a read of the chain before a file is written.
import { lstatSync, readFileSync } from 'node:fs';
import type { UseCase } from './contract.ts';
import { holdsSecret } from './secrets.ts';

/** A record or a report that breaks a rule. `member` is the path of the member, for example `hires[1].post_tx`. */
export class RunRecordError extends Error {
  readonly member: string;
  constructor(member: string, rule: string, scope = '') {
    super(`${scope}${member}: ${rule}`);
    this.name = 'RunRecordError';
    this.member = member;
  }
}

export type RunKind = 'clean' | 'failure' | 'lifecycle';
export type ApprovalRole = 'approval' | 'binding';
export interface ApprovalEntry {
  readonly role: ApprovalRole; readonly attestation: string; readonly tx: string; readonly valid_until: number | null;
  readonly revoked_tx: string | null; readonly supersedes: string | null;
}
export interface RunRecordPolicy {
  readonly hireRoles: readonly string[];
  agentOf(role: string): readonly string[];
  readonly reportOptional: readonly string[];
  readonly readLegacy?: boolean;
  readonly allowRfqs?: boolean;
}

export interface DelegationEntry { readonly id: string; readonly tx: string; readonly ended_tx: string | null }
export interface VaultEntry { readonly ref: string; readonly open_tx: string; readonly close_tx: string | null }
/** Old records do not name the subagent or the hire. The reader leaves these unknown. */
export interface SubDelegationEntry {
  readonly id: string; readonly delegate_tx: string; readonly undelegate_tx: string; readonly subagent: string | null; readonly hire: string | null;
}
export interface HireEntry {
  readonly step: string; readonly agent: string; readonly advert_ref: string; readonly escrow_ref: string; readonly post_tx: string;
  readonly accept_tx: string | null; readonly reclaim_tx: string | null; readonly report_file: string | null;
}
export type Refusal =
  | { readonly step: string; readonly kind: 'ledger'; readonly evaluation_error: string; readonly transaction_body: string }
  | { readonly step: string; readonly kind: 'tool'; readonly message: string };
export interface RunRecord {
  readonly format: 1; readonly label: string; readonly use_case: string; readonly kind: RunKind; readonly date: string; readonly tenant: string | null;
  readonly delegations: readonly DelegationEntry[]; readonly vaults: readonly VaultEntry[]; readonly approvals: readonly ApprovalEntry[];
  readonly challenged: string | null; readonly rfq_ids: readonly string[]; readonly lifecycle: readonly string[];
  readonly sub_delegations: readonly SubDelegationEntry[]; readonly hires: readonly HireEntry[]; readonly refusals: readonly Refusal[];
  /** Reader metadata. It is never a member of the file. */
  readonly legacy: boolean;
}
/** What the hirer got for one hire: the verdict of the receipt check, the table of checks, the receipt and its signature, and the text of the result. */
export interface Report {
  readonly verdict: 'VERIFIED'; readonly checks: Readonly<Record<string, 'pass'>>; readonly receipt: Readonly<Record<string, unknown>>; readonly receipt_signature: string; readonly result: string;
}

const HASH = /^[0-9a-f]{64}$/;
const REF = /^[0-9a-f]{64}#(?:0|[1-9][0-9]{0,5})$/;
const KEY_HASH = /^[0-9a-f]{56}$/;
const LABEL = /^[a-z0-9][a-z0-9-]{0,31}$/;
const TENANT = /^[a-z0-9][a-z0-9-]{0,47}$/;
const STEP_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const REPORT_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}\.json$/;
const SIGNATURE = /^[0-9a-f]{128}$/;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const CHECK_NAME = /^[a-z][a-z0-9_]{0,63}$/;
const HEX_BODY = /^(?:[0-9a-fA-F]{2})+$/;
const HIRE_SUFFIX = /^-[a-z0-9]{1,8}$/;
const RFQ_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const MOST_EVALUATION_CHARS = 20_000;
const MOST_BODY_CHARS = 200_000;
const MOST_MESSAGE_CHARS = 4_000;
const MOST_RESULT_CHARS = 1_000_000;

/** Use the most specific role when one role is also the prefix of another. */
export function hireRoleOf(step: string, roles: readonly string[]): string | null {
  let match: string | null = null;
  for (const role of roles) {
    if (step === role) return role;
    if (step.startsWith(role) && HIRE_SUFFIX.test(step.slice(role.length)) && (match === null || role.length > match.length)) match = role;
  }
  return match;
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const SAFE_NAME = /^[A-Za-z0-9_-]{1,32}$/;

/** The rules of one reader: where it reports (a scope before the member) and the path of the member that it reads. */
class Reader {
  readonly #scope: string;
  constructor(scope = '') { this.#scope = scope; }

  fail(member: string, rule: string): never { throw new RunRecordError(member, rule, this.#scope); }

  /** The members of an object that has exactly the members `names`: a missing one and an unknown one are refused. */
  exact(value: unknown, member: string, names: readonly string[]): Record<string, unknown> {
    if (!isObject(value)) return this.fail(member, 'is not an object');
    const at = (name: string): string => (member === 'the record' || member === 'the report' ? name : `${member}.${name}`);
    for (const name of names) if (!Object.hasOwn(value, name)) this.fail(at(name), 'is missing');
    for (const name of Object.keys(value)) if (!names.includes(name)) this.fail(SAFE_NAME.test(name) ? at(name) : `${member}.(a member with an odd name)`, 'is not a member of this shape');
    return value;
  }

  list(value: unknown, member: string, least: number, most: number): unknown[] {
    if (!Array.isArray(value)) return this.fail(member, 'is not a list');
    if (value.length < least || value.length > most) this.fail(member, `holds ${value.length} entries, and it must hold ${least} to ${most}`);
    return value;
  }

  hash(value: unknown, member: string): string {
    if (typeof value !== 'string' || !HASH.test(value)) this.fail(member, 'is not a hash: 64 lower-case hex characters');
    return value;
  }

  hashOrNull(value: unknown, member: string): string | null {
    return value === null ? null : this.hash(value, member);
  }

  ref(value: unknown, member: string): string {
    if (typeof value !== 'string' || !REF.test(value)) this.fail(member, 'is not a reference: 64 lower-case hex characters, a #, and an index of at most 6 digits');
    return value;
  }

  /** A text that matches `pattern`. A text with a mark of a secret is refused first, because a pattern can accept a key. */
  named(value: unknown, member: string, pattern: RegExp, what: string): string {
    if (typeof value !== 'string') return this.fail(member, `is not ${what}`);
    if (holdsSecret(value)) this.fail(member, 'holds a mark of a secret');
    if (!pattern.test(value)) this.fail(member, `is not ${what}`);
    return value;
  }

  /** A free text of at most `most` characters that is not empty and holds no mark of a secret. */
  text(value: unknown, member: string, most: number): string {
    if (typeof value !== 'string' || value.trim() === '') return this.fail(member, 'is not a text that has characters in it');
    if (value.length > most) this.fail(member, `is longer than ${most} characters`);
    if (holdsSecret(value)) this.fail(member, 'holds a mark of a secret');
    return value;
  }

  unique(seen: Set<string>, value: string, member: string): void {
    if (seen.has(value)) this.fail(member, 'repeats an earlier entry');
    seen.add(value);
  }
}

function dateOf(reader: Reader, value: unknown): string {
  if (typeof value !== 'string' || !DATE.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`)) || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) {
    return reader.fail('date', 'is not a date of the form YYYY-MM-DD');
  }
  return value;
}

function hireOf(reader: Reader, value: unknown, index: number, use: Pick<UseCase, 'agents'>, policy: RunRecordPolicy, steps: Set<string>, escrows: Set<string>, files: Set<string>): HireEntry {
  const at = `hires[${index}]`;
  const hire = reader.exact(value, at, ['step', 'agent', 'advert_ref', 'escrow_ref', 'post_tx', 'accept_tx', 'reclaim_tx', 'report_file']);
  const step = reader.named(hire.step, `${at}.step`, STEP_ID, 'the step of a hire');
  const role = hireRoleOf(step, policy.hireRoles);
  if (role === null) return reader.fail(`${at}.step`, 'does not name a hire role of the use case');
  const agent = reader.named(hire.agent, `${at}.agent`, STEP_ID, 'an agent id of the use case');
  if (!policy.agentOf(role).includes(agent) || !use.agents.some((one) => one.id === agent)) reader.fail(`${at}.agent`, `is not an agent of the hire role ${role}`);
  reader.unique(steps, step, `${at}.step`);
  const advert = reader.ref(hire.advert_ref, `${at}.advert_ref`);
  const escrow = reader.ref(hire.escrow_ref, `${at}.escrow_ref`);
  reader.unique(escrows, escrow, `${at}.escrow_ref`);
  const post = reader.hash(hire.post_tx, `${at}.post_tx`);
  const accept = reader.hashOrNull(hire.accept_tx, `${at}.accept_tx`);
  const reclaim = reader.hashOrNull(hire.reclaim_tx, `${at}.reclaim_tx`);
  if (accept !== null && reclaim !== null) reader.fail(`${at}.reclaim_tx`, 'is set beside accept_tx: an escrow ends once');
  if (hire.report_file === null) {
    if (!policy.reportOptional.includes(role)) reader.fail(`${at}.report_file`, 'is required for this hire role');
    if (reclaim === null) reader.fail(`${at}.reclaim_tx`, 'is required when the hire has no report');
    return { step, agent, advert_ref: advert, escrow_ref: escrow, post_tx: post, accept_tx: accept, reclaim_tx: reclaim, report_file: null };
  }
  const file = reader.named(hire.report_file, `${at}.report_file`, REPORT_FILE, 'the name of a json file in the run folder');
  if (file.includes('..')) reader.fail(`${at}.report_file`, 'is not the name of a json file in the run folder');
  reader.unique(files, file, `${at}.report_file`);
  return { step, agent, advert_ref: advert, escrow_ref: escrow, post_tx: post, accept_tx: accept, reclaim_tx: reclaim, report_file: file };
}

function refusalOf(reader: Reader, value: unknown, index: number): Refusal {
  const at = `refusals[${index}]`;
  if (!isObject(value)) return reader.fail(at, 'is not an object');
  const { kind } = value;
  if (kind !== 'ledger' && kind !== 'tool') return reader.fail(`${at}.kind`, 'is neither ledger nor tool');
  const entry = reader.exact(value, at, kind === 'ledger' ? ['step', 'kind', 'evaluation_error', 'transaction_body'] : ['step', 'kind', 'message']);
  const step = reader.named(entry.step, `${at}.step`, STEP_ID, 'a step id of 1 to 32 lower-case letters, digits and hyphens');
  if (kind === 'tool') return { step, kind, message: reader.text(entry.message, `${at}.message`, MOST_MESSAGE_CHARS) };
  const body = entry.transaction_body;
  const evaluation = reader.text(entry.evaluation_error, `${at}.evaluation_error`, MOST_EVALUATION_CHARS);
  if (typeof body !== 'string' || !HEX_BODY.test(body) || body.length > MOST_BODY_CHARS) reader.fail(`${at}.transaction_body`, `is not the body of a transaction in hex (an even number of hex characters, at most ${MOST_BODY_CHARS})`);
  return { step, kind, evaluation_error: evaluation, transaction_body: body };
}

/** Reads either strict input shape. Only a module that wrote the old shape may accept it. */
export function parseRunRecord(value: unknown, use: Pick<UseCase, 'name' | 'agents' | 'subagents'>, policy: RunRecordPolicy): RunRecord {
  const reader = new Reader();
  const legacy = policy.readLegacy === true && isObject(value) && Object.hasOwn(value, 'approval');
  const lifecycle = !legacy && isObject(value) && value.kind === 'lifecycle';
  const common = ['format', 'label', 'kind', 'date', 'tenant', 'delegations', 'vaults', 'sub_delegations', 'hires', 'refusals'];
  const top = reader.exact(value, 'the record', [
    ...common, ...(legacy ? ['approval'] : ['use_case', 'approvals', 'challenged', 'rfq_ids']), ...(lifecycle ? ['lifecycle'] : []),
  ]);
  if (top.format !== 1) reader.fail('format', 'is not 1');
  if (!legacy && top.use_case !== use.name) reader.fail('use_case', 'does not name the current use case');
  const label = reader.named(top.label, 'label', LABEL, 'a label of 1 to 32 lower-case letters, digits and hyphens');
  if (top.kind !== 'clean' && top.kind !== 'failure' && !lifecycle) reader.fail('kind', 'is not clean, failure or lifecycle');
  const kind = top.kind as RunKind;
  const date = dateOf(reader, top.date);
  if (lifecycle && top.tenant !== null) reader.fail('tenant', 'must be null in a lifecycle run');
  const tenant = lifecycle ? null : reader.named(top.tenant, 'tenant', TENANT, 'a tenant name of 1 to 48 lower-case letters, digits and hyphens');
  const candidate = legacy ? null : top.challenged;
  const challenged = candidate === null ? null : reader.named(candidate, 'challenged', STEP_ID, 'an agent id or null');
  if (challenged !== null && (kind !== 'failure' || !use.agents.some((agent) => agent.id === challenged))) {
    reader.fail('challenged', 'must name an agent of the use case in a failure run');
  }
  const rfqSeen = new Set<string>();
  const rfqIds = legacy ? [] : reader.list(top.rfq_ids, 'rfq_ids', 0, !lifecycle && policy.allowRfqs === true ? 8 : 0).map((value, i) => {
    const member = `rfq_ids[${i}]`;
    const id = reader.named(value, member, RFQ_ID, 'a request identifier');
    reader.unique(rfqSeen, id, member);
    return id;
  });
  const lifecycleSeen = new Set<string>();
  const lifecycleSteps = !lifecycle ? [] : reader.list(top.lifecycle, 'lifecycle', 1, 32).map((value, i) => {
    const member = `lifecycle[${i}]`;
    const id = reader.named(value, member, STEP_ID, 'the name of a lifecycle fact');
    reader.unique(lifecycleSeen, id, member);
    return id;
  });
  const delegationIds = new Set<string>();
  const delegations = reader.list(top.delegations, 'delegations', lifecycle ? 0 : 1, lifecycle ? 0 : 8).map((item, i): DelegationEntry => {
    const at = `delegations[${i}]`;
    const entry = reader.exact(item, at, ['id', 'tx', 'ended_tx']);
    const id = reader.hash(entry.id, `${at}.id`);
    reader.unique(delegationIds, id, `${at}.id`);
    return { id, tx: reader.hash(entry.tx, `${at}.tx`), ended_tx: reader.hashOrNull(entry.ended_tx, `${at}.ended_tx`) };
  });
  const vaultRefs = new Set<string>();
  const vaults = reader.list(top.vaults, 'vaults', lifecycle ? 0 : 1, lifecycle ? 0 : 8).map((item, i): VaultEntry => {
    const at = `vaults[${i}]`;
    const entry = reader.exact(item, at, ['ref', 'open_tx', 'close_tx']);
    const ref = reader.ref(entry.ref, `${at}.ref`);
    reader.unique(vaultRefs, ref, `${at}.ref`);
    return { ref, open_tx: reader.hash(entry.open_tx, `${at}.open_tx`), close_tx: reader.hashOrNull(entry.close_tx, `${at}.close_tx`) };
  });
  const approvalIds = new Set<string>();
  const approvals = legacy ? [legacyApproval(reader, top.approval)] : reader.list(top.approvals, 'approvals', 0, lifecycle ? 0 : 4).map((item, i): ApprovalEntry => {
    const at = `approvals[${i}]`;
    const entry = reader.exact(item, at, ['role', 'attestation', 'tx', 'valid_until', 'revoked_tx', 'supersedes']);
    if (entry.role !== 'approval' && entry.role !== 'binding') return reader.fail(`${at}.role`, 'is neither approval nor binding');
    const attestation = reader.hash(entry.attestation, `${at}.attestation`);
    const end = entry.valid_until;
    if (typeof end !== 'number' || !Number.isSafeInteger(end) || end < 1 || end > 8_640_000_000_000_000) {
      return reader.fail(`${at}.valid_until`, 'is not a positive POSIX time in milliseconds');
    }
    const supersedes = reader.hashOrNull(entry.supersedes, `${at}.supersedes`);
    if (supersedes === attestation) reader.fail(`${at}.supersedes`, 'names the attestation itself');
    reader.unique(approvalIds, attestation, `${at}.attestation`);
    return { role: entry.role, attestation, tx: reader.hash(entry.tx, `${at}.tx`), valid_until: end, revoked_tx: reader.hashOrNull(entry.revoked_tx, `${at}.revoked_tx`), supersedes };
  });
  const steps = new Set<string>();
  const escrows = new Set<string>();
  const files = new Set<string>();
  const hires = reader.list(top.hires, 'hires', lifecycle ? 0 : 1, lifecycle ? 0 : 32).map((item, i) => hireOf(reader, item, i, use, policy, steps, escrows, files));
  const subIds = new Set<string>();
  const subDelegations = reader.list(top.sub_delegations, 'sub_delegations', 0, lifecycle ? 0 : 16).map((item, i): SubDelegationEntry => {
    const at = `sub_delegations[${i}]`;
    const fields = ['id', 'delegate_tx', 'undelegate_tx'];
    const entry = reader.exact(item, at, legacy ? fields : [...fields, 'subagent', 'hire']);
    const id = reader.hash(entry.id, `${at}.id`);
    reader.unique(subIds, id, `${at}.id`);
    const subagent = legacy ? null : reader.named(entry.subagent, `${at}.subagent`, STEP_ID, 'a subagent id');
    const hire = legacy ? null : reader.named(entry.hire, `${at}.hire`, STEP_ID, 'a propose hire step');
    if (subagent !== null && hire !== null) {
      const child = use.subagents.find((one) => one.id === subagent);
      if (child === undefined) return reader.fail(`${at}.subagent`, 'does not name a subagent of the use case');
      const parent = hires.find((one) => one.step === hire);
      if (parent === undefined || parent.agent !== child.parent || hireRoleOf(hire, policy.hireRoles) !== 'propose') {
        reader.fail(`${at}.hire`, 'does not name a propose hire of the parent agent');
      }
    }
    return { id, delegate_tx: reader.hash(entry.delegate_tx, `${at}.delegate_tx`), undelegate_tx: reader.hash(entry.undelegate_tx, `${at}.undelegate_tx`), subagent, hire };
  });
  const refusals = reader.list(top.refusals, 'refusals', 0, 16).map((item, i) => refusalOf(reader, item, i));
  return {
    format: 1, label, use_case: use.name, kind, date, tenant, delegations, vaults, approvals, challenged, rfq_ids: rfqIds, lifecycle: lifecycleSteps,
    sub_delegations: subDelegations, hires, refusals, legacy,
  };
}

function legacyApproval(reader: Reader, value: unknown): ApprovalEntry {
  const old = reader.exact(value, 'approval', ['attestation', 'tx']);
  return {
    role: 'approval', attestation: reader.hash(old.attestation, 'approval.attestation'), tx: reader.hash(old.tx, 'approval.tx'),
    valid_until: null, revoked_tx: null, supersedes: null,
  };
}

/**
 * Checks the report file of a hire: the verdict VERIFIED, a table of checks that all say `pass`, a receipt with its escrow reference, response hash, model, supplier key hash and prompt hash, the
 * signature of the receipt (128 hex characters), and the text of the result. `where` starts each message, so that a message names the file. The hash of the text is not checked here.
 */
export function parseReport(value: unknown, where: string): Report {
  const reader: Reader = new Reader(`${where}: `);
  const top = reader.exact(value, 'the report', ['verdict', 'checks', 'receipt', 'receipt_signature', 'result']);
  if (top.verdict !== 'VERIFIED') reader.fail('verdict', 'is not VERIFIED');
  if (!isObject(top.checks) || Object.keys(top.checks).length === 0) reader.fail('checks', 'has no check');
  const checks: Record<string, 'pass'> = {};
  for (const [name, state] of Object.entries(top.checks as Record<string, unknown>)) {
    if (!CHECK_NAME.test(name)) reader.fail('checks', 'has a check with an odd name');
    if (state !== 'pass') reader.fail(`checks.${name}`, 'did not pass');
    checks[name] = 'pass';
  }
  if (!isObject(top.receipt)) reader.fail('receipt', 'is not an object');
  const receipt = top.receipt;
  reader.ref(receipt.escrow_ref, 'receipt.escrow_ref');
  reader.hash(receipt.response_hash, 'receipt.response_hash');
  reader.hash(receipt.prompt_hash, 'receipt.prompt_hash');
  reader.named(receipt.model, 'receipt.model', MODEL, 'the name of a model');
  if (holdsSecret(receipt)) reader.fail('receipt', 'holds a mark of a secret');
  if (typeof receipt.supplier_pkh !== 'string' || !KEY_HASH.test(receipt.supplier_pkh)) reader.fail('receipt.supplier_pkh', 'is not a key hash: 56 lower-case hex characters');
  if (typeof top.receipt_signature !== 'string' || !SIGNATURE.test(top.receipt_signature)) reader.fail('receipt_signature', 'is not a signature: 128 lower-case hex characters');
  if (typeof top.result !== 'string' || top.result === '') reader.fail('result', 'is not a text that has characters in it');
  if (top.result.length > MOST_RESULT_CHARS) reader.fail('result', `is longer than ${MOST_RESULT_CHARS} characters`);
  if (holdsSecret(top.result)) reader.fail('result', 'holds a mark of a secret');
  return { verdict: 'VERIFIED', checks, receipt: structuredClone(receipt), receipt_signature: top.receipt_signature, result: top.result };
}

/** The JSON of a file of the state folder. A link, a folder, a file above the limit and a file that is no JSON are refused. The message names `what` and never a path or a value. */
export function readJsonFile(path: string, what: string, limitBytes = 4 * 1024 * 1024): unknown {
  let found;
  try { found = lstatSync(path); } catch (err) {
    throw new Error(`${what} cannot be read (${(err as NodeJS.ErrnoException).code ?? 'an error'})`);
  }
  if (!found.isFile()) throw new Error(`${what} is not a regular file: a link or a folder is refused`);
  if (found.size > limitBytes) throw new Error(`${what} is larger than ${limitBytes} bytes`);
  try { return JSON.parse(readFileSync(path, 'utf8')) as unknown; } catch (err) {
    throw new Error(err instanceof SyntaxError ? `${what} is not JSON` : `${what} cannot be read (${(err as NodeJS.ErrnoException).code ?? 'an error'})`);
  }
}

// ---- Koios: the block time, the inputs and the minted tokens of a transaction ----

/**
 * What Koios says of a transaction: when its block was made (POSIX milliseconds), its inputs by reference with the payment credential of each (null for an address with none), the payment credential of each of its
 * outputs, and the tokens that it minted (a positive quantity) or burned (a negative one), each with its policy and its name in hex.
 */
export interface TxInfo {
  readonly timeMs: number; readonly inputs: readonly { readonly ref: string; readonly credential: string | null }[];
  readonly outputs: readonly { readonly credential: string | null }[];
  readonly minted: readonly { readonly policy: string; readonly name: string; readonly quantity: bigint }[];
}

const POLICY_ID = /^[0-9a-f]{56}$/;
const KOIOS_TIMEOUT_MS = 15_000;
const MOST_KOIOS_CHARS = 4 * 1024 * 1024;

/** The short code of a failed call (ECONNREFUSED): the message of a network error can name an address. */
function networkCode(err: unknown): string {
  const cause = typeof err === 'object' && err !== null && 'cause' in err ? err.cause : err;
  const code = typeof cause === 'object' && cause !== null && 'code' in cause ? cause.code : undefined;
  return typeof code === 'string' && /^[A-Z0-9_]{2,24}$/.test(code) ? code : 'ERROR';
}

export class UnknownTransactionError extends Error {
  constructor() { super('Koios does not know the transaction'); }
}

/** Read the block time, inputs and mint. An empty result is not the same as a failed read. */
export async function txInfoOf(fetchImpl: typeof fetch, koiosUrl: string, txHash: string): Promise<TxInfo> {
  let response: Response;
  try {
    response = await fetchImpl(`${koiosUrl.replace(/\/+$/, '')}/api/v1/tx_info`, {
      method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json' }, body: JSON.stringify({ _tx_hashes: [txHash], _inputs: true, _assets: true }),
      redirect: 'error', signal: AbortSignal.timeout(KOIOS_TIMEOUT_MS),
    });
  } catch (err) { throw new Error(`Koios tx_info could not be reached (${networkCode(err)})`); }
  if (!response.ok) throw new Error(`Koios tx_info answered ${response.status}`);
  let body: unknown;
  try { body = JSON.parse((await response.text()).slice(0, MOST_KOIOS_CHARS)) as unknown; } catch { throw new Error('Koios tx_info answered with a body that is no JSON'); }
  if (Array.isArray(body) && body.length === 0) throw new UnknownTransactionError();
  const row: unknown = Array.isArray(body) && body.length === 1 ? body[0] : undefined;
  if (!isObject(row) || typeof row.tx_hash !== 'string' || row.tx_hash.toLowerCase() !== txHash) {
    throw new Error('Koios tx_info did not return one row of the requested transaction');
  }
  const stamp = row.tx_timestamp;
  if (typeof stamp !== 'number' || !Number.isSafeInteger(stamp) || stamp <= 0) throw new Error('Koios gives no block time for the transaction');
  if (!Array.isArray(row.inputs)) throw new Error('Koios gives no list of inputs for the transaction');
  const inputs = row.inputs.map((input: unknown) => {
    if (!isObject(input) || typeof input.tx_hash !== 'string' || !HASH.test(input.tx_hash.toLowerCase()) || typeof input.tx_index !== 'number' || !Number.isSafeInteger(input.tx_index) || input.tx_index < 0) {
      throw new Error('Koios gives an input that is no output');
    }
    const address = input.payment_addr;
    const credential = isObject(address) && typeof address.cred === 'string' ? address.cred.toLowerCase() : null;
    return { ref: `${input.tx_hash.toLowerCase()}#${input.tx_index}`, credential };
  });
  const listed = row.assets_minted === null || row.assets_minted === undefined ? [] : row.assets_minted;
  if (!Array.isArray(listed)) throw new Error('Koios gives a list of minted tokens that is no list');
  const minted = listed.map((one: unknown) => {
    const whole = isObject(one) && (typeof one.quantity === 'number' ? Number.isSafeInteger(one.quantity) : typeof one.quantity === 'string' && /^-?[0-9]{1,30}$/.test(one.quantity));
    if (!isObject(one) || typeof one.policy_id !== 'string' || !POLICY_ID.test(one.policy_id.toLowerCase()) || typeof one.asset_name !== 'string' || !/^(?:[0-9a-f]{2}){0,32}$/i.test(one.asset_name) || !whole) {
      throw new Error('Koios gives a minted token of a wrong shape');
    }
    return { policy: one.policy_id.toLowerCase(), name: one.asset_name.toLowerCase(), quantity: BigInt(one.quantity as number | string) };
  });
  if (!Array.isArray(row.outputs)) throw new Error('Koios gives no list of outputs for the transaction');
  const outputs = row.outputs.map((output: unknown) => {
    if (!isObject(output)) throw new Error('Koios gives an output that is no object');
    const address = output.payment_addr;
    return { credential: isObject(address) && typeof address.cred === 'string' ? address.cred.toLowerCase() : null };
  });
  return { timeMs: stamp * 1000, inputs, outputs, minted };
}

/** The block time of a transaction in POSIX milliseconds, read from Koios `tx_info` (the node gives the confirmations only). */
export async function txTimeOf(fetchImpl: typeof fetch, koiosUrl: string, txHash: string): Promise<number> {
  return (await txInfoOf(fetchImpl, koiosUrl, txHash)).timeMs;
}
