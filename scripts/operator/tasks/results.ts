// scripts/operator/tasks/results.ts - the task `results`: the private page of a use case, made from the evidence files of its runs.
//
//   run --header-file <path> [--runs <label>,<label>]   prints the page (no --submit) or writes <state>/results/<use case>.md (--submit)
//   status                                              lists the evidence files and says whether the page exists
//
// The page has one table for each run: a row for each step of the data of the use case for the kind of the run, with the primitive that the step used, the reference that the evidence file holds
// for it, and what the step shows and does not show. The use case gives the sentences and the proof for each step. A step counts as shown only when the evidence file satisfies that proof.
// A step with no reference and a step that did not run say so, and give no reference. The page starts with the text of the header file of the operator, verbatim. That text names
// the group that the results go to, and the name is in no file of the repository. The page ends with the section "Not covered".
// A label is the name of an evidence file without `.json`: the file `<state>/evidence/private/<label>.json`, or the file `<state>/evidence/<label>.json` (a public file has the date and the number
// of the run in its name). Without `--runs` the page takes the public labels only: a private file goes into the page when `--runs` names its label. The header file must lie outside the key folder,
// and it must hold no run of 40 or more hex characters and no line of the form NAME=value, which is a line of an env file: the value of such a line can be a token that is no hex. The task reads no key and
// no chain, signs nothing, and records no step in the state file, so it can run again when a later run adds a file.
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import type { Dirent, Stats } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { writeFileAtomically } from '../../checks/lib/files.ts';
import { PreconditionError } from '../../checks/lib/session.ts';
import type { ProjectedResultRoute, ResultProof, ResultRefusal, ResultsSpec, StepOutcome, TaskDefinition, TaskSession, UseCase } from '../lib/contract.ts';
import { codeOf } from '../lib/registry.ts';
import { MOST_RESULT_REFS, RESULT_STEP_ID, indexResultPolicy, resultRefShape } from '../lib/result-policy.ts';
import type { ResultStepIndex } from '../lib/result-policy.ts';
import { FlagError, runSteps } from '../lib/runner.ts';
import { holdsSecret } from '../lib/secrets.ts';

/** A transaction on the explorer of the network: this text and the hash. */
export const EXPLORER_TX = 'https://explorer.vector.mainnet.apexfusion.org/transaction/hash/';
/** The header file is refused above this size: it is a name and a few lines, and never a document. */
export const HEADER_LIMIT_BYTES = 8192;

const EVIDENCE_LIMIT_BYTES = 4 * 1024 * 1024;
const MOST_RUNS = 16;
const MOST_NOTE_CHARS = 2000;
const LABEL = /^[a-z0-9][a-z0-9-]{0,31}$/;
const PUBLIC_LABEL = /^(\d{4}-\d{2}-\d{2})-([a-z][a-z0-9-]{0,62})-run-[1-9][0-9]?$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const HASH = /^[0-9a-f]{64}$/;
const OUTPUT_REF = /^[0-9a-f]{64}#(?:0|[1-9]\d{0,5})$/;
const DID = /^did:vector:[0-9a-f]{64}$/;
const REF_VALUE = /^[A-Za-z0-9._:#/-]{1,200}$/;
const REF_KIND = /^[a-z][a-z0-9_-]{0,31}$/;
/** A line of an env file: a name and an equals sign at the start of a line. A header names a group in plain words, so it holds no such line. */
const ENV_LINE = /^[A-Za-z_][A-Za-z0-9_]*=/m;

/** The fixed texts of the page. A test strips these, the use case data and the evidence from a page, and finds nothing left. */
export const PAGE_TEXT = {
  results: 'results',
  intro: 'This page lists the steps of each run. A row names the primitive that the step used and the reference that the evidence file holds for it. A step counts as shown only when the evidence file holds a reference for it. A step that did not run says so and gives its reason.',
  run: 'Run',
  columns: ['id', 'what', 'primitive', 'reference', 'shows', 'does not show'],
  none: 'none',
  notRun: 'Not run.',
  noReason: 'The evidence file gives no reason.',
  noEntry: 'The evidence file has no entry for this step.',
  noReference: 'Not shown. The evidence file holds no reference for this step.',
  partialReference: 'Not shown in full. The evidence file does not support every part of this step.',
  wholeStep: 'The whole step.',
  notCovered: 'Not covered',
  limitsLead: 'The runs have these limits:',
  limitsItems: [
    'The model decisions are a sample. Another run can decide another way.',
    'The jury result is a sample. Another jury can decide another way.',
    'One operator holds the keys of the agents, and they sit on one host.',
  ],
} as const;

// ---- the evidence of a run, as the page reads it ----

/** A reference of a step: a plain text (a transaction hash when it is 64 hex characters) or a labelled value (`kind` and `value`). */
export interface Ref { readonly kind: string | null; readonly value: string }
export interface EvidenceStep { readonly id: string; readonly status: 'shown' | 'not_run'; readonly refs: readonly Ref[]; readonly note: string; readonly complete: boolean }
export interface PageRun { readonly label: string; readonly kind: string; readonly date: string; readonly steps: ReadonlyMap<string, EvidenceStep> }

type ResultPolicyData = Pick<UseCase, 'results' | 'runs' | 'evidenceSteps'>;
type EvidenceCase = ResultPolicyData & Pick<UseCase, 'name' | 'agents'>;
type EvidenceIndex = ResultStepIndex<UseCase['evidenceSteps'][number]>;

function requireResultPolicy(use: ResultPolicyData): EvidenceIndex {
  const policy = indexResultPolicy(use.results, use.runs, use.evidenceSteps);
  if (typeof policy === 'string') throw new PreconditionError(`the results policy is not usable: ${policy}`);
  return policy;
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** One reference from the evidence file, or null when it has no valid form. */
function refOf(raw: unknown): Ref | null {
  if (typeof raw === 'string') return REF_VALUE.test(raw) ? { kind: null, value: raw } : null;
  if (!isObject(raw) || Object.keys(raw).length !== 2) return null;
  const { kind, value } = raw;
  if (typeof kind !== 'string' || typeof value !== 'string' || !REF_KIND.test(kind) || !REF_VALUE.test(value)) return null;
  return kind === 'transaction' && !HASH.test(value) ? null : { kind, value };
}

/** The run record accepts a role followed by one short alphanumeric suffix. */
function hasHireRole(step: unknown, role: string): boolean {
  return typeof step === 'string' && (step === role || (step.startsWith(role) && /^-[a-z0-9]{1,8}$/.test(step.slice(role.length))));
}

/** An escrow must identify one hire. Two entries for one escrow cannot confirm the same action. */
function hireFor(hires: readonly unknown[], escrow: string): Record<string, unknown> | null {
  let found: Record<string, unknown> | null = null;
  for (const hire of hires) {
    if (!isObject(hire) || hire.escrow_ref !== escrow) continue;
    if (found !== null) return null;
    found = hire;
  }
  return found;
}

/** A publishable spend needs the assembler's terminal proof, not an empty Accept or Reclaim field. */
function releaseOf(refs: readonly Ref[], hires: readonly unknown[], proof: unknown, hireRole: string): boolean {
  if (!isObject(proof) || Object.keys(proof).length !== 5 || proof.action !== 'Release') return false;
  const { escrow_ref: escrow, tx, spent_output: spent, at } = proof;
  if (typeof escrow !== 'string' || !OUTPUT_REF.test(escrow) || typeof tx !== 'string' || !HASH.test(tx)
      || typeof spent !== 'string' || !OUTPUT_REF.test(spent) || spent === escrow || spent.startsWith(`${tx}#`)
      || typeof at !== 'number' || !Number.isSafeInteger(at) || at <= 0) return false;
  if (refs.length !== 2 || !refs.some(({ kind, value }) => kind === 'escrow' && value === escrow)
      || !refs.some(({ kind, value }) => kind === 'transaction' && value === tx)) return false;
  const hire = hireFor(hires, escrow);
  return hire !== null && hasHireRole(hire.step, hireRole) && hire.post_tx === escrow.slice(0, 64)
    && hire.verdict === 'VERIFIED' && hire.accept_tx === null && hire.reclaim_tx === null;
}

/** The public assembler proof binds the signed handoff to the independently confirmed Accept without publishing the signed contents. */
function intakeHandoffOf(refs: readonly Ref[], hires: readonly unknown[], doc: Record<string, unknown>, executeRole: string, intakeRole: string): boolean {
  const proof = doc.handoff_evidence;
  if (!isObject(proof) || Object.keys(proof).length !== 7) return false;
  const { execute_step: executeStep, execute_escrow: executeEscrow, execute_result_sha256: digest,
    intake_step: intakeStep, intake_escrow: intakeEscrow, signed_acceptance: signed, confirmed_accept_tx: accept } = proof;
  if (!hasHireRole(executeStep, executeRole) || !hasHireRole(intakeStep, intakeRole) || typeof executeEscrow !== 'string' || !OUTPUT_REF.test(executeEscrow)
      || typeof intakeEscrow !== 'string' || !OUTPUT_REF.test(intakeEscrow) || intakeEscrow === executeEscrow
      || typeof digest !== 'string' || !HASH.test(digest) || typeof accept !== 'string' || !HASH.test(accept)
      || (signed !== 'confirmed' && signed !== 'pending')) return false;
  if (doc.escrow_ref !== executeEscrow || doc.result_sha256 !== digest || doc.verdict !== 'VERIFIED' || !isObject(doc.result_projection)
      || doc.result_projection.operation !== executeRole || doc.result_projection.outcome !== 'completed' || doc.result_projection.exit_state !== 'Completed') return false;
  const execute = hireFor(hires, executeEscrow);
  const intake = hireFor(hires, intakeEscrow);
  return execute !== null && execute.step === executeStep && execute.result_sha256 === digest && execute.verdict === 'VERIFIED'
    && intake !== null && intake.step === intakeStep && intake.verdict === 'VERIFIED' && intake.reclaim_tx === null
    && typeof intake.result_sha256 === 'string' && HASH.test(intake.result_sha256) && intake.accept_tx === accept
    && refs.some(({ kind, value }) => kind === 'transaction' && value === accept);
}

/** The assembler's public links, receipt and check results must agree before a row claims an accepted, completed hire. */
function settlementOf(settlement: NonNullable<ResultProof['settlement']>, refs: readonly Ref[], doc: Record<string, unknown>): boolean {
  const hires: unknown[] = Array.isArray(doc.hires) ? doc.hires : [];
  if (settlement.type === 'release') return releaseOf(refs, hires, doc.release, settlement.hireRole);
  if (settlement.type === 'intake-handoff') return intakeHandoffOf(refs, hires, doc, settlement.executeRole, settlement.intakeRole);
  if (settlement.type === 'none-recorded') {
    const matching = hires.filter((hire) => isObject(hire) && refs.some(({ kind, value }) => kind === 'escrow' && value === hire.escrow_ref));
    return matching.length === 1 && isObject(matching[0]) && matching[0].accept_tx === null && matching[0].reclaim_tx === null;
  }
  if (settlement.type !== 'receipt') return false;
  const { accept_tx: accept, escrow_ref: escrow, result_sha256: digest, result, receipt, receipt_signature: signature, checks } = doc;
  if (typeof accept !== 'string' || !HASH.test(accept) || typeof escrow !== 'string' || !OUTPUT_REF.test(escrow)
      || typeof digest !== 'string' || typeof result !== 'string' || createHash('sha256').update(result).digest('hex') !== digest
      || !isObject(receipt) || receipt.escrow_ref !== escrow || receipt.response_hash !== digest
      || typeof signature !== 'string' || !/^[0-9a-f]{128}$/.test(signature) || !isObject(checks)
      || checks.signature_valid !== 'pass' || checks.response_hash_matches !== 'pass' || checks.escrow_ref_matches !== 'pass' || checks.supplier_key_matches !== 'pass') return false;
  let body: unknown;
  try { body = JSON.parse(result); } catch { return false; }
  if (!isObject(body) || body.outcome !== 'completed' || !isObject(body.handoff)) return false;
  const { accepted, escrow_ref: handoff } = body.handoff;
  if (accepted !== 'confirmed' && accepted !== 'pending') return false;
  if (typeof handoff !== 'string' || !OUTPUT_REF.test(handoff) || handoff === escrow) return false;
  const carried = hireFor(hires, escrow);
  const received = hireFor(hires, handoff);
  if (carried === null || received === null || carried.accept_tx !== accept || carried.reclaim_tx !== null || carried.result_sha256 !== digest) return false;
  const { step, accept_tx: intakeAccept, reclaim_tx: intakeReclaim, result_sha256: intakeDigest, verdict } = received;
  if (!hasHireRole(step, settlement.handoffRole)) return false;
  // The assembler confirms the Accept for this escrow independently of when the result was signed.
  return verdict === 'VERIFIED' && intakeReclaim === null && typeof intakeDigest === 'string' && HASH.test(intakeDigest)
    && typeof intakeAccept === 'string' && HASH.test(intakeAccept) && refs.some(({ kind, value }) => kind === 'transaction' && value === intakeAccept);
}

/** Attribution stays in the assembler. The reader checks its exact step proof against the sanitized events. */
function projectedRoutesOf(id: string, required: readonly ProjectedResultRoute[], doc: Record<string, unknown>): boolean {
  if (!Array.isArray(doc.route_evidence) || !isObject(doc.mock) || !Array.isArray(doc.mock.log)) return false;
  const proofs = (doc.route_evidence as unknown[]).filter((row): row is Record<string, unknown> => isObject(row) && row.step === id);
  if (proofs.length !== required.length) return false;
  const log: unknown[] = doc.mock.log;
  for (const [route, credential, decision, links, count, status] of required) {
    if (proofs.filter((row) => Object.keys(row).length === 6 && row.route === route && row.credential === credential
        && row.decision === decision && row.act_links === links && row.count === count).length !== 1) return false;
    let matched = 0;
    for (const row of log) {
      if (isObject(row) && Object.keys(row).length === 5 && row.route === route && row.credential === credential
          && row.decision === decision && row.status === status && typeof row.at === 'string'
          && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(row.at) && Number.isFinite(Date.parse(row.at))) matched += 1;
    }
    // Distinct verified calls can have identical public timestamps.
    if (matched < count) return false;
  }
  return true;
}

function refusalMatches(value: unknown, id: string, rule: ResultRefusal, privateSource: boolean): boolean {
  if (!isObject(value) || value.step !== id) return false;
  if (rule === 'ledger') {
    return value.kind === 'ledger' && typeof value.evaluation_error === 'string' && value.evaluation_error.trim() !== ''
      && typeof value.transaction_body === 'string' && value.transaction_body !== '';
  }
  if (value.kind !== 'tool') return false;
  if (rule === 'tool') return typeof value.message === 'string' && value.message.trim() !== '';
  const projected = typeof value.message_sha256 === 'string' && HASH.test(value.message_sha256);
  if (rule === 'projected-tool') return projected;
  return Object.keys(value).length === 3 && (projected
    || (privateSource && typeof value.message === 'string' && value.message.trim() !== ''));
}

function proofOf(proof: ResultProof, id: string, refs: readonly Ref[], doc: Record<string, unknown>, privateSource: boolean): boolean {
  for (const [kind, count] of Object.entries(proof.refs)) {
    const shape = resultRefShape(kind);
    if (shape === undefined) return false;
    const values = new Set<string>();
    for (const ref of refs) {
      if (ref.kind !== kind) continue;
      const valid = (shape === 'hash' ? HASH : shape === 'did' ? DID : shape === 'text' ? REF_VALUE : OUTPUT_REF).test(ref.value);
      if (valid) values.add(ref.value);
    }
    if (values.size < count) return false;
  }
  if (proof.settlement !== undefined && !settlementOf(proof.settlement, refs, doc)) return false;
  if (proof.projectedRoutes !== undefined && !projectedRoutesOf(id, proof.projectedRoutes, doc)) return false;
  if (proof.recordFromTransaction && !refs.some(({ kind, value }) => kind === proof.recordFromTransaction && OUTPUT_REF.test(value)
      && refs.some((one) => one.kind === 'transaction' && one.value === value.slice(0, 64)))) return false;
  if (proof.refusals !== undefined) {
    const refusals: unknown[] = Array.isArray(doc.refusals) ? doc.refusals : [];
    for (const rule of proof.refusals) {
      if (!refusals.some((value) => refusalMatches(value, id, rule, privateSource))) return false;
    }
  }
  if (proof.routes !== undefined) {
    const log: unknown[] = isObject(doc.mock) && Array.isArray(doc.mock.log) ? doc.mock.log : [];
    for (const [route, credential, links, count = 1, decision = 'allowed'] of proof.routes) {
      const rows = new Set<string>();
      for (const row of log) {
        if (!isObject(row) || row.route !== route || row.credential !== credential || row.decision !== decision
            || (links !== null && (!Array.isArray(row.act) || row.act.length !== links))) continue;
        rows.add(JSON.stringify([row.at, row.sub, row.delegation, row.act]));
      }
      if (rows.size < count) return false;
    }
  }
  return true;
}

/** The run of an evidence file. A file that is not the evidence of a run of this use case is a PreconditionError that names the file by its label and the rule that it breaks, never a value. */
export function parseEvidence(value: unknown, label: string, use: EvidenceCase): PageRun {
  return parseRun(value, label, use, requireResultPolicy(use), false);
}

function parseRun(value: unknown, label: string, use: EvidenceCase, policy: EvidenceIndex, privateSource: boolean): PageRun {
  const bad = (rule: string): Error => new PreconditionError(`the evidence file ${label} is not usable: ${rule}`);
  if (!isObject(value)) throw bad('it is not a JSON object');
  const { kind, date, steps } = value;
  const allowed = typeof kind === 'string' ? policy.get(kind) : undefined;
  if (typeof kind !== 'string' || allowed === undefined) throw bad('kind is not the id of a run of the use case');
  if (value.run !== `${use.results.runPrefix}-${kind}` || (value.use_case !== undefined && value.use_case !== use.name)) {
    throw bad('run does not name this use case and run kind');
  }
  if (typeof value.capability_id !== 'string' || !use.agents.some(({ capability }) => capability === value.capability_id)) {
    throw bad('its capability is not a capability of this use case');
  }
  if (typeof date !== 'string' || !DATE.test(date) || Number.isNaN(Date.parse(date))) throw bad('date is not a date of the form YYYY-MM-DD');
  if (!Array.isArray(steps)) throw bad('steps is not a list');
  const parsed = new Map<string, EvidenceStep>();
  steps.forEach((raw: unknown, index) => {
    const where = `steps[${index}]`;
    if (!isObject(raw)) throw bad(`${where} is not an object`);
    const { id, status, refs, note } = raw;
    if (typeof id !== 'string' || !RESULT_STEP_ID.test(id)) throw bad(`${where}.id is not a step id`);
    const step = allowed.get(id);
    if (step === undefined) throw bad(`${where}.id is not a step of a run of this kind`);
    if (parsed.has(id)) throw bad(`${where}.id repeats a step`);
    if (status !== 'shown' && status !== 'not_run') throw bad(`${where}.status is neither shown nor not_run`);
    if (!Array.isArray(refs) || refs.length > MOST_RESULT_REFS) throw bad(`${where}.refs is not a list of at most ${MOST_RESULT_REFS} references`);
    const list = refs.map(refOf);
    if (list.some((ref) => ref === null)) throw bad(`${where}.refs holds a value that is no reference`);
    if (note !== undefined && note !== null && (typeof note !== 'string' || note.length > MOST_NOTE_CHARS)) throw bad(`${where}.note is not a text of at most ${MOST_NOTE_CHARS} characters`);
    const text = typeof note === 'string' ? note : '';
    if (holdsSecret(id) || holdsSecret(text) || list.some((ref) => ref !== null && (holdsSecret(ref.value) || holdsSecret(ref.kind)))) throw bad(`${where} holds a mark of a secret`);
    const refs_ = list.filter((ref): ref is Ref => ref !== null);
    const complete = status === 'shown' && proofOf(step.proof, id, refs_, value, privateSource);
    parsed.set(id, { id, status, refs: refs_, note: text, complete });
  });
  if (holdsSecret(label) || holdsSecret(kind) || holdsSecret(date)) throw bad('it holds a mark of a secret');
  return { label, kind, date, steps: parsed };
}

// ---- the page ----

const cell = (text: string): string => text.replace(/\s+/g, ' ').trim().replace(/[\\|]/g, '\\$&');

function refText(ref: Ref): string {
  const link = (hash: string): string => `[\`${hash}\`](${EXPLORER_TX}${hash})`;
  if (ref.kind === null) return HASH.test(ref.value) ? link(ref.value) : `\`${ref.value}\``;
  return ref.kind === 'transaction' ? link(ref.value) : `${ref.kind} \`${ref.value}\``;
}

/** The six cells of the row of a step. Do not apply the step's full summary to partial evidence. */
function rowOf(step: UseCase['evidenceSteps'][number], found: EvidenceStep | undefined, wording: ResultsSpec['wording']): string[] {
  const text = wording[step.primitive]!;
  const head = [step.id, cell(step.what), cell(step.primitive)];
  if (found === undefined) return [...head, PAGE_TEXT.none, `${PAGE_TEXT.notRun} ${PAGE_TEXT.noEntry}`, PAGE_TEXT.wholeStep];
  if (found.status === 'not_run') {
    return [...head, PAGE_TEXT.none, `${PAGE_TEXT.notRun} ${found.note === '' ? PAGE_TEXT.noReason : cell(found.note)}`, PAGE_TEXT.wholeStep];
  }
  if (found.refs.length === 0) return [...head, PAGE_TEXT.none, PAGE_TEXT.noReference, PAGE_TEXT.wholeStep];
  const references = found.refs.map(refText).join('; ');
  if (!found.complete) return [...head, references, PAGE_TEXT.partialReference, PAGE_TEXT.wholeStep];
  return [...head, references, text.shows, text.doesNotShow];
}

interface ResultsPageInput {
  readonly header: string;
  readonly use: ResultPolicyData & Pick<UseCase, 'title' | 'notCovered'>;
  readonly runs: readonly PageRun[];
}

/** The page: the header, the title, one table for each run, and the section "Not covered". The header comes first and verbatim. */
export function renderPage(input: ResultsPageInput): string {
  return renderRuns(input, requireResultPolicy(input.use));
}

function renderRuns(input: ResultsPageInput, policy: EvidenceIndex): string {
  const { lead, items } = input.use.notCovered;
  const body: string[] = [`# ${input.use.title}: ${PAGE_TEXT.results}`, '', PAGE_TEXT.intro, ''];
  for (const run of input.runs) {
    const rows = policy.get(run.kind);
    if (rows === undefined) throw new PreconditionError('the results run has no declared policy');
    body.push(`## ${PAGE_TEXT.run} ${run.label}: ${run.kind}, ${run.date}`, '', `| ${PAGE_TEXT.columns.join(' | ')} |`, `|${PAGE_TEXT.columns.map(() => '---').join('|')}|`);
    for (const step of rows.values()) {
      body.push(`| ${rowOf(step, run.steps.get(step.id), input.use.results.wording).join(' | ')} |`);
    }
    body.push('');
  }
  body.push(`## ${PAGE_TEXT.notCovered}`, '', lead, '', ...items.map((item) => `- ${item}`), '', PAGE_TEXT.limitsLead, '', ...PAGE_TEXT.limitsItems.map((item) => `- ${item}`));
  return `${input.header}${input.header.endsWith('\n') ? '' : '\n'}\n${body.join('\n')}\n`;
}

// ---- the files ----

/** True when `path` is `base` or lies below it. Both are real paths. */
function isInside(path: string, base: string): boolean {
  const way = relative(base, path);
  return way === '' || !(way === '..' || way.startsWith(`..${sep}`) || isAbsolute(way));
}

/**
 * The text of the header file, verbatim. These are refused: a link, a folder, a device, a file of the key folder (by its real path, so that a link to the folder does not hide it, and before the file is
 * read), a file above the limit, a file that is not UTF-8 text, a file with no text in it, a text with a mark of a secret or with 40 or more hex characters in a row (the size of a key, a hash or a token),
 * and a text with a line of the form NAME=value (a line of an env file, whose value can be a token that is no hex). A refusal never shows the text.
 */
function readHeader(path: string, keysDir: string): string {
  let found: Stats;
  try { found = lstatSync(path); } catch (err) { throw new PreconditionError(`the header file cannot be read (${codeOf(err)})`); }
  if (!found.isFile()) throw new PreconditionError('the header file is not a regular file: a link, a folder or a device is refused');
  let real: string;
  try { real = realpathSync(path); } catch (err) { throw new PreconditionError(`the header file cannot be read (${codeOf(err)})`); }
  let keys: string | null = null;
  try { keys = realpathSync(keysDir); } catch (err) {
    if (codeOf(err) !== 'ENOENT') throw new PreconditionError(`the key folder cannot be checked (${codeOf(err)})`);
  }
  if (keys !== null && isInside(real, keys)) throw new PreconditionError('the header file is inside the key folder: a file of that folder is no header, and the page shows the header');
  if (found.size > HEADER_LIMIT_BYTES) throw new PreconditionError(`the header file is larger than ${HEADER_LIMIT_BYTES} bytes: it holds a name and a few lines, and no document`);
  let bytes: Buffer;
  try { bytes = readFileSync(path); } catch (err) { throw new PreconditionError(`the header file cannot be read (${codeOf(err)})`); }
  if (bytes.length > HEADER_LIMIT_BYTES) throw new PreconditionError(`the header file is larger than ${HEADER_LIMIT_BYTES} bytes: it holds a name and a few lines, and no document`);
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw new PreconditionError('the header file is not UTF-8 text'); }
  if (text.includes('\0')) throw new PreconditionError('the header file is not text: it holds a NUL character');
  if (text.trim() === '') throw new PreconditionError('the header file holds no text: it names the group that the results go to');
  if (/[0-9a-fA-F]{40,}/.test(text)) throw new PreconditionError('the header file holds 40 or more hex characters in a row: that is the size of a key, a hash or a token, and the header names a group');
  if (holdsSecret(text)) throw new PreconditionError('the header file holds a mark of a secret: the page holds no key and no token');
  if (ENV_LINE.test(text)) throw new PreconditionError('the header file holds a line of the form NAME=value: that is a line of an env file, and the header names a group in plain words');
  return text;
}

interface Found { readonly label: string; readonly path: string; readonly folder: 'public' | 'private' }

/** The evidence writer uses longer names for public files of some agents. Private labels keep their own limit. */
function publicLabel(label: string, use: Pick<UseCase, 'agents'>): boolean {
  const match = PUBLIC_LABEL.exec(label);
  if (match === null || !use.agents.some(({ id }) => id === match[2])) return false;
  const day = Date.parse(match[1]!);
  return Number.isFinite(day) && new Date(day).toISOString().slice(0, 10) === match[1];
}

/** The evidence files of the state folder by label: the public files of `evidence/` and the private files of `evidence/private/`. A name that is no label, a link and two files with one label are refused. */
function listEvidence(stateDir: string, use: Pick<UseCase, 'agents'>): Map<string, Found> {
  const found = new Map<string, Found>();
  for (const folder of ['public', 'private'] as const) {
    const dir = folder === 'public' ? join(stateDir, 'evidence') : join(stateDir, 'evidence', 'private');
    let entries: Dirent[] | undefined;
    try {
      if (lstatSync(dir).isDirectory()) entries = readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      if (codeOf(err) === 'ENOENT') continue;
      throw new PreconditionError(`the ${folder} evidence folder cannot be read (${codeOf(err)})`);
    }
    if (entries === undefined) throw new PreconditionError(`the ${folder} evidence folder is not a directory: a link is refused`);
    for (const entry of [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      if (entry.name.startsWith('.') || !entry.name.endsWith('.json')) continue;
      if (!entry.isFile()) throw new PreconditionError(`a ${folder} evidence file is not a regular file: a link or a folder is refused`);
      const label = entry.name.slice(0, -'.json'.length);
      if (!LABEL.test(label) && !(folder === 'public' && publicLabel(label, use))) {
        throw new PreconditionError(`the name of a ${folder} evidence file is no label: use a short label or the standard public file name of an agent`);
      }
      if (found.has(label)) throw new PreconditionError(`two evidence files have the label ${label}: keep one`);
      found.set(label, { label, path: join(dir, entry.name), folder });
    }
  }
  return found;
}

function readEvidence(file: Found): unknown {
  let found: Stats;
  try { found = lstatSync(file.path); } catch (err) { throw new PreconditionError(`the evidence file ${file.label} cannot be read (${codeOf(err)})`); }
  if (!found.isFile() || found.size > EVIDENCE_LIMIT_BYTES) throw new PreconditionError(`the evidence file ${file.label} is not a regular file of at most ${EVIDENCE_LIMIT_BYTES} bytes`);
  try { return JSON.parse(readFileSync(file.path, 'utf8')); } catch (err) {
    throw new PreconditionError(err instanceof SyntaxError ? `the evidence file ${file.label} is not JSON` : `the evidence file ${file.label} cannot be read (${codeOf(err)})`);
  }
}

function loadRuns(files: ReadonlyMap<string, Found>, wanted: readonly string[] | null, use: EvidenceCase, policy: EvidenceIndex): PageRun[] {
  const labels = wanted ?? [...files.values()].filter((file) => file.folder === 'public').map((file) => file.label);
  if (labels.length === 0) throw new PreconditionError('there is no public evidence file: run the task evidence first, or name a private label with --runs');
  const runs = labels.map((label) => {
    const file = files.get(label);
    if (file === undefined) throw new PreconditionError(`there is no evidence file for the label ${label}: the evidence folders hold ${[...files.keys()].join(', ') || 'no file'}`);
    return parseRun(readEvidence(file), label, use, policy, file.folder === 'private');
  });
  return wanted === null ? runs.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.label < b.label ? -1 : a.label > b.label ? 1 : 0)) : runs;
}

// ---- the task ----

interface PageSummary { readonly labels: readonly string[]; readonly file: string; readonly bytes: number; readonly sha256: string; readonly written: boolean }

interface ResultsExtra {
  readonly headerFile: string | null;
  readonly runs: readonly string[] | null;
  /** What the last run made, for the machine line. */
  page: PageSummary | null;
}

const pageFile = (use: Pick<UseCase, 'name'>): string => join('results', `${use.name}.md`);

async function produce(session: TaskSession<ResultsExtra>): Promise<StepOutcome> {
  const { extra, use } = session;
  if (extra.headerFile === null) throw new FlagError('--header-file is required: the page names the group that the results go to, and that name comes from a text file of the operator');
  const policy = requireResultPolicy(use);
  const header = readHeader(extra.headerFile, session.settings.keysDir);
  const runs = loadRuns(listEvidence(session.settings.stateDir, use), extra.runs, use, policy);
  const page = renderRuns({ header, use, runs }, policy);
  if (holdsSecret(page)) throw new PreconditionError('the page holds a mark of a secret: it is not shown and not written');
  const bytes = Buffer.byteLength(page, 'utf8');
  const sha256 = createHash('sha256').update(page, 'utf8').digest('hex');
  const written = session.mode === 'submit';
  if (!written) for (const line of page.split('\n').slice(0, -1)) session.out.out(line);
  if (written) writeFileAtomically(join(session.settings.stateDir, pageFile(use)), page);
  extra.page = { labels: runs.map((run) => run.label), file: pageFile(use), bytes, sha256, written };
  return {
    kind: 'done',
    message: written
      ? `the page of ${runs.length} run(s) is written to ${pageFile(use)} in the state folder (${bytes} bytes, SHA-256 ${sha256})`
      : `dry run: the page above is not written (${bytes} bytes, SHA-256 ${sha256}). Run again with --submit to write it to ${pageFile(use)}`,
  };
}

const results: TaskDefinition<ResultsExtra> = {
  name: 'results',
  title: 'Writes the private results page of the use case from the evidence files of its runs.',
  flags: [],
  valued: ['header-file', 'runs'],
  needs: { keys: () => [], chain: false, hosted: [], approval: 'never' },
  steps: () => ['run'],
  parse(_env, _settings, use, flags) {
    const headerFile = flags.value('header-file');
    if (headerFile === '') throw new FlagError('--header-file needs the path of a text file');
    const list = flags.value('runs');
    let labels: string[] | null = null;
    if (list !== undefined) {
      labels = list.split(',');
      if (labels.length > MOST_RUNS || labels.some((label) => !LABEL.test(label) && !publicLabel(label, use))) {
        throw new FlagError(`--runs needs at most ${MOST_RUNS} comma-separated labels: short labels or public file names of agents`);
      }
      if (new Set(labels).size !== labels.length) throw new FlagError('--runs names a label twice');
    }
    return { headerFile: headerFile ?? null, runs: labels, page: null };
  },
  next: (session) => runSteps(session, [{ name: 'run', run: produce }]),
  cleanup: async () => ({ kind: 'done', message: 'the task results makes a page and takes nothing back' }),
  async status(session) {
    const where = pageFile(session.use);
    let files: ReadonlyMap<string, Found>;
    try { files = listEvidence(session.settings.stateDir, session.use); } catch (err) { return [`evidence files: cannot list them (${err instanceof Error ? err.message : 'an error'})`]; }
    const labels = [...files.values()].map((file) => `${file.label} (${file.folder})`);
    let page: string;
    try { page = `${where} exists, ${lstatSync(join(session.settings.stateDir, where)).size} bytes`; } catch { page = `${where} does not exist yet`; }
    return [`evidence files: ${labels.length === 0 ? 'none' : labels.join(', ')}`, `page: ${page}`];
  },
  result: (session) => (session.extra.page === null ? {} : { ...session.extra.page, labels: [...session.extra.page.labels] }),
};

export default results;
