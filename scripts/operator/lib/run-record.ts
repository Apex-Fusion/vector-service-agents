// scripts/operator/lib/run-record.ts - the run record of a run, the report file of a hire, and the readers of the files and of the block times that the task `evidence` needs.
// The operator writes `<state>/runs/<label>.json` from what the session of the hirer showed, and one report file for each hire in the folder `<state>/runs/<label>/`. Both are strict: an unknown member,
// a member of a wrong shape, a hash or a reference that is not in its canonical form, a refusal without its facts and any text with a mark of a secret are refused, and the message names the member and
// never shows a value. The record and the reports are inputs: the task `evidence` checks each reference in them against a read of the chain before a file is written.
import { lstatSync, readFileSync } from 'node:fs';
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

export type RunKind = 'clean' | 'failure';
/** The operation of a hire: the first word of its step. `propose` and `execute` hire the Reorder Agent, and `order-desk` is the hire of the Order Desk that the agent makes. */
export type HireRole = 'propose' | 'execute' | 'order-desk';

export interface DelegationEntry { readonly id: string; readonly tx: string; readonly ended_tx: string | null }
export interface VaultEntry { readonly ref: string; readonly open_tx: string; readonly close_tx: string | null }
export interface SubDelegationEntry { readonly id: string; readonly delegate_tx: string; readonly undelegate_tx: string }
export interface HireEntry {
  readonly step: string; readonly agent: string; readonly advert_ref: string; readonly escrow_ref: string; readonly post_tx: string;
  readonly accept_tx: string | null; readonly reclaim_tx: string | null; readonly report_file: string;
}
export type Refusal =
  | { readonly step: string; readonly kind: 'ledger'; readonly evaluation_error: string; readonly transaction_body: string }
  | { readonly step: string; readonly kind: 'tool'; readonly message: string };
export interface RunRecord {
  readonly format: 1; readonly label: string; readonly kind: RunKind; readonly date: string; readonly tenant: string;
  readonly delegations: readonly DelegationEntry[]; readonly vaults: readonly VaultEntry[]; readonly approval: { readonly attestation: string; readonly tx: string };
  readonly sub_delegations: readonly SubDelegationEntry[]; readonly hires: readonly HireEntry[]; readonly refusals: readonly Refusal[];
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
/** The step of a hire: its operation, and an optional suffix for the second hire of an operation in one run. */
export const HIRE_STEP = /^(propose|execute|order-desk)(?:-[a-z0-9]{1,8})?$/;
const AGENT_OF: Readonly<Record<HireRole, string>> = { propose: 'reorder-agent', execute: 'reorder-agent', 'order-desk': 'order-desk' };

const MOST_EVALUATION_CHARS = 20_000;
const MOST_BODY_CHARS = 200_000;
const MOST_MESSAGE_CHARS = 4_000;
const MOST_RESULT_CHARS = 1_000_000;

/** The role of a hire step, or null when the step is no step of a hire. */
export function hireRoleOf(step: string): HireRole | null {
  const found = HIRE_STEP.exec(step);
  return found === null ? null : (found[1] as HireRole);
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

function hireOf(reader: Reader, value: unknown, index: number, steps: Set<string>, escrows: Set<string>, files: Set<string>): HireEntry {
  const at = `hires[${index}]`;
  const hire = reader.exact(value, at, ['step', 'agent', 'advert_ref', 'escrow_ref', 'post_tx', 'accept_tx', 'reclaim_tx', 'report_file']);
  const step = reader.named(hire.step, `${at}.step`, HIRE_STEP, 'the step of a hire: propose, execute or order-desk, and an optional suffix');
  const role = hireRoleOf(step)!;
  if (hire.agent !== AGENT_OF[role]) reader.fail(`${at}.agent`, `is not ${AGENT_OF[role]}, the agent of the step ${role}`);
  reader.unique(steps, step, `${at}.step`);
  const advert = reader.ref(hire.advert_ref, `${at}.advert_ref`);
  const escrow = reader.ref(hire.escrow_ref, `${at}.escrow_ref`);
  reader.unique(escrows, escrow, `${at}.escrow_ref`);
  const post = reader.hash(hire.post_tx, `${at}.post_tx`);
  const accept = reader.hashOrNull(hire.accept_tx, `${at}.accept_tx`);
  const reclaim = reader.hashOrNull(hire.reclaim_tx, `${at}.reclaim_tx`);
  if (accept !== null && reclaim !== null) reader.fail(`${at}.reclaim_tx`, 'is set beside accept_tx: an escrow ends once');
  const file = reader.named(hire.report_file, `${at}.report_file`, REPORT_FILE, 'the name of a json file in the run folder');
  if (file.includes('..')) reader.fail(`${at}.report_file`, 'is not the name of a json file in the run folder');
  reader.unique(files, file, `${at}.report_file`);
  return { step, agent: AGENT_OF[role], advert_ref: advert, escrow_ref: escrow, post_tx: post, accept_tx: accept, reclaim_tx: reclaim, report_file: file };
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

/**
 * Checks a run record. It is strict: each member of each object is named and each one must be there, and no other is allowed. Hashes are 64 lower-case hex characters and references have an index of at
 * most 6 digits. A hire has a step (an operation and an optional suffix), the agent of that operation, and at most one of accept_tx and reclaim_tx. A refusal of the ledger holds its evaluation error and
 * the hex body of its transaction, and a refusal of a tool holds its message. No text holds a mark of a secret. It throws a `RunRecordError` that names the member, and never a value.
 */
export function parseRunRecord(value: unknown): RunRecord {
  const reader: Reader = new Reader();
  const top = reader.exact(value, 'the record', ['format', 'label', 'kind', 'date', 'tenant', 'delegations', 'vaults', 'approval', 'sub_delegations', 'hires', 'refusals']);
  if (top.format !== 1) reader.fail('format', 'is not 1');
  const label = reader.named(top.label, 'label', LABEL, 'a label of 1 to 32 lower-case letters, digits and hyphens');
  if (top.kind !== 'clean' && top.kind !== 'failure') reader.fail('kind', 'is neither clean nor failure');
  const kind: RunKind = top.kind;
  const date = dateOf(reader, top.date);
  const tenant = reader.named(top.tenant, 'tenant', TENANT, 'a tenant name of 1 to 48 lower-case letters, digits and hyphens');
  const delegationIds = new Set<string>();
  const delegations = reader.list(top.delegations, 'delegations', 1, 8).map((item, i): DelegationEntry => {
    const at = `delegations[${i}]`;
    const entry = reader.exact(item, at, ['id', 'tx', 'ended_tx']);
    const id = reader.hash(entry.id, `${at}.id`);
    reader.unique(delegationIds, id, `${at}.id`);
    return { id, tx: reader.hash(entry.tx, `${at}.tx`), ended_tx: reader.hashOrNull(entry.ended_tx, `${at}.ended_tx`) };
  });
  const vaultRefs = new Set<string>();
  const vaults = reader.list(top.vaults, 'vaults', 1, 8).map((item, i): VaultEntry => {
    const at = `vaults[${i}]`;
    const entry = reader.exact(item, at, ['ref', 'open_tx', 'close_tx']);
    const ref = reader.ref(entry.ref, `${at}.ref`);
    reader.unique(vaultRefs, ref, `${at}.ref`);
    return { ref, open_tx: reader.hash(entry.open_tx, `${at}.open_tx`), close_tx: reader.hashOrNull(entry.close_tx, `${at}.close_tx`) };
  });
  const approval = reader.exact(top.approval, 'approval', ['attestation', 'tx']);
  const subIds = new Set<string>();
  const subDelegations = reader.list(top.sub_delegations, 'sub_delegations', 0, 16).map((item, i): SubDelegationEntry => {
    const at = `sub_delegations[${i}]`;
    const entry = reader.exact(item, at, ['id', 'delegate_tx', 'undelegate_tx']);
    const id = reader.hash(entry.id, `${at}.id`);
    reader.unique(subIds, id, `${at}.id`);
    return { id, delegate_tx: reader.hash(entry.delegate_tx, `${at}.delegate_tx`), undelegate_tx: reader.hash(entry.undelegate_tx, `${at}.undelegate_tx`) };
  });
  const steps = new Set<string>();
  const escrows = new Set<string>();
  const files = new Set<string>();
  const hires = reader.list(top.hires, 'hires', 1, 32).map((item, i) => hireOf(reader, item, i, steps, escrows, files));
  const refusals = reader.list(top.refusals, 'refusals', 0, 16).map((item, i) => refusalOf(reader, item, i));
  return {
    format: 1, label, kind, date, tenant, delegations, vaults, approval: { attestation: reader.hash(approval.attestation, 'approval.attestation'), tx: reader.hash(approval.tx, 'approval.tx') },
    sub_delegations: subDelegations, hires, refusals,
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

// ---- Koios: the block time and the inputs of a transaction ----

/** What Koios says of a transaction: when its block was made (POSIX milliseconds), and its inputs by reference, with the payment credential of each (null for an address with none). */
export interface TxInfo { readonly timeMs: number; readonly inputs: readonly { readonly ref: string; readonly credential: string | null }[] }

const KOIOS_TIMEOUT_MS = 15_000;
const MOST_KOIOS_CHARS = 4 * 1024 * 1024;

/** The short code of a failed call (ECONNREFUSED): the message of a network error can name an address. */
function networkCode(err: unknown): string {
  const cause = typeof err === 'object' && err !== null && 'cause' in err ? err.cause : err;
  const code = typeof cause === 'object' && cause !== null && 'code' in cause ? cause.code : undefined;
  return typeof code === 'string' && /^[A-Z0-9_]{2,24}$/.test(code) ? code : 'ERROR';
}

/**
 * Reads one transaction from Koios `tx_info`, with its inputs. The error messages name the route and the status only: no address, no body. A transaction that Koios does not list is an error,
 * and so is a row with no whole block time or with an input that is no output.
 */
export async function txInfoOf(fetchImpl: typeof fetch, koiosUrl: string, txHash: string): Promise<TxInfo> {
  let response: Response;
  try {
    response = await fetchImpl(`${koiosUrl.replace(/\/+$/, '')}/api/v1/tx_info`, {
      method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json' }, body: JSON.stringify({ _tx_hashes: [txHash], _inputs: true }),
      redirect: 'error', signal: AbortSignal.timeout(KOIOS_TIMEOUT_MS),
    });
  } catch (err) { throw new Error(`Koios tx_info could not be reached (${networkCode(err)})`); }
  if (!response.ok) throw new Error(`Koios tx_info answered ${response.status}`);
  let body: unknown;
  try { body = JSON.parse((await response.text()).slice(0, MOST_KOIOS_CHARS)) as unknown; } catch { throw new Error('Koios tx_info answered with a body that is no JSON'); }
  const row = Array.isArray(body) ? body.find((one: unknown) => isObject(one) && String(one.tx_hash).toLowerCase() === txHash) as Record<string, unknown> | undefined : undefined;
  if (row === undefined) throw new Error('Koios does not know the transaction');
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
  return { timeMs: stamp * 1000, inputs };
}

/** The block time of a transaction in POSIX milliseconds, read from Koios `tx_info` (the node gives the confirmations only). */
export async function txTimeOf(fetchImpl: typeof fetch, koiosUrl: string, txHash: string): Promise<number> {
  return (await txInfoOf(fetchImpl, koiosUrl, txHash)).timeMs;
}
