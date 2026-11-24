// scripts/operator/tasks/results.ts - the task `results`: the private page of a use case, made from the evidence files of its runs.
//
//   run --header-file <path> [--runs <label>,<label>]   prints the page (no --submit) or writes <state>/results/<use case>.md (--submit)
//   status                                              lists the evidence files and says whether the page exists
//
// The page has one table for each run: a row for each step of the data of the use case for the kind of the run, with the primitive that the step used, the reference that the evidence file holds
// for it, and what the step shows and does not show. The two sentences come from one table of this file, for each primitive of the data. A step counts as shown only when the evidence file holds a
// reference for it: a step with no reference and a step that did not run say so, and give no reference. The page starts with the text of the header file of the operator, verbatim. That text names
// the group that the results go to, and the name is in no file of the repository. The page ends with the section "Not covered".
// A label is the name of an evidence file without `.json`: the file `<state>/evidence/private/<label>.json`, or the file `<state>/evidence/<label>.json` (a public file has the date and the number
// of the run in its name). Without `--runs` the page takes the public labels only: a private file goes into the page when `--runs` names its label. The header file must lie outside the key folder,
// and it must hold no run of 40 or more hex characters. The task reads no key and no chain, signs nothing, and records no step in the state file, so it can run again when a later run adds a file.
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import type { Dirent, Stats } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { writeFileAtomically } from '../../checks/lib/files.ts';
import { PreconditionError } from '../../checks/lib/session.ts';
import type { StepOutcome, TaskDefinition, TaskSession, UseCase } from '../lib/contract.ts';
import { codeOf } from '../lib/registry.ts';
import { FlagError, runSteps } from '../lib/runner.ts';
import { holdsSecret } from '../lib/secrets.ts';

/** A transaction on the explorer of the network: this text and the hash. */
export const EXPLORER_TX = 'https://explorer.vector.mainnet.apexfusion.org/transaction/hash/';
/** The header file is refused above this size: it is a name and a few lines, and never a document. */
export const HEADER_LIMIT_BYTES = 8192;

const EVIDENCE_LIMIT_BYTES = 4 * 1024 * 1024;
const MOST_RUNS = 16;
const MOST_REFS = 32;
const MOST_NOTE_CHARS = 2000;
const LABEL = /^[a-z0-9][a-z0-9-]{0,31}$/;
const STEP_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const HASH = /^[0-9a-f]{64}$/;
const REF_VALUE = /^[A-Za-z0-9._:#/-]{1,200}$/;
const REF_KIND = /^[a-z][a-z0-9_-]{0,31}$/;

// ---- what each primitive shows and does not show ----

export interface Sentences { readonly shows: string; readonly doesNotShow: string }

/**
 * One entry for each primitive that the data of the use case names (a test holds the keys to the data). `shows` says what a step with a reference proves. `doesNotShow` says what it leaves open. The
 * sentences are short, and they say no more than the reference can prove.
 */
export const SHOWS: Readonly<Record<string, Sentences>> = {
  'Delegation with a co-signature': {
    shows: 'The ledger holds a delegation from the hirer to the agent. The agent co-signed it.',
    doesNotShow: 'That the agent keeps to the limits of the delegation. The steps with a value limit test that.',
  },
  'Vault': {
    shows: 'The ledger holds a vault under the delegation. The vault holds funds of the hirer.',
    doesNotShow: 'That the vault refuses a payment above the limit. The steps with a value limit test that.',
  },
  'Escrow: post, claim, submit, accept': {
    shows: 'The hire settled through the escrow. The ledger holds the post, the claim, the submit and the accept.',
    doesNotShow: 'That the answer of the agent is right. The hirer checks the signed work record.',
  },
  'Sub-delegation, token exchange with the delegation chain': {
    shows: 'The agent gave its subagent one narrow right. The gateway issued a token for a chain of two delegations.',
    doesNotShow: 'That a token stops working after a delegation ends. Tests alone cover that case.',
  },
  'Model call from the marketplace, signed work record': {
    shows: 'A model from the marketplace made the decision. Its signed work record is on the ledger.',
    doesNotShow: 'That the decision is right. The model result is a sample, and another run can differ.',
  },
  'Attestation: approval': {
    shows: 'An approval attestation of the hirer is on the ledger. It names the digest of the proposal.',
    doesNotShow: 'That the hirer read the proposal. The attestation covers the digest only.',
  },
  'Escrow': {
    shows: 'The hire settled through the escrow. The ledger holds each transaction of the escrow.',
    doesNotShow: 'That the order is right. The steps of the Order Desk show the order.',
  },
  'Vault payment, agent hires agent': {
    shows: 'The agent paid the advert of the Order Desk from the vault of the hirer. The payment is inside the limit.',
    doesNotShow: 'That a payment above the limit fails. The failure run tests that.',
  },
  'Pre-claim check, X.509 SVID, model call': {
    shows: 'The Order Desk checked the handoff before it claimed the escrow. It proved its identity with an X.509 certificate. A model decided the availability.',
    doesNotShow: 'That the supplier portal is a real system. The portal is a mock service.',
  },
  'Receipt checks, accept, token for a route': {
    shows: 'The agent ran the receipt checks and accepted the work. It wrote the purchase order with a token for that route.',
    doesNotShow: 'That the store of purchase orders is a real system. It is a mock service.',
  },
  'Vault close, undelegate': {
    shows: 'The ledger holds the close of the vault and the end of the delegation.',
    doesNotShow: 'That a system refuses a live token after the end. Tests alone cover that case.',
  },
  'Value limit of a vault': {
    shows: 'The vault script refused a payment above the limit when the node evaluated the transaction.',
    doesNotShow: 'That the limit suits the hirer. It shows only that the script holds the limit.',
  },
  'Module-1 challenge': {
    shows: 'The agent challenged the claim of the Order Desk. The evidence is on the ledger.',
    doesNotShow: 'That the challenge is right. The jury decides that.',
  },
  'Module-1 verdict and hold': {
    shows: 'The jury decided. The Order Desk got a hold of 7 days with the reason 64.',
    doesNotShow: 'That another jury decides the same way. The jury result is a sample.',
  },
  'Escrow: release': {
    shows: 'The release watcher released the escrow after the wait. The supplier got paid.',
    doesNotShow: 'That a verdict moves escrow funds. A verdict never moves them.',
  },
  'Hold removes the agent from the listing': {
    shows: 'During the hold the marketplace listed no advert of the Order Desk. A new proposal found none.',
    doesNotShow: 'That the listing returns after the hold. The end-state check reads that.',
  },
  'Hold and lift by a party': {
    shows: 'The Accountable key of the organisation put a hold on the Order Desk and lifted it.',
    doesNotShow: 'That another party can hold. It shows the Accountable party only.',
  },
  'End of a delegation, token refusal': {
    shows: 'After the hirer ended the delegation, the payment failed. The gateway refused a token request under that delegation.',
    doesNotShow: 'That a system that holds a live token refuses it after the end. Tests alone cover that case.',
  },
};

/** The fixed texts of the page. A test strips these, the table above, the data and the evidence from a page, and finds nothing left. */
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
  wholeStep: 'The whole step.',
  notCovered: 'Not covered',
  notCoveredLead: 'No run covers these three items:',
  notCoveredItems: [
    'The refund of the escrow of a revoked agent.',
    'The reclaim of an escrow by its buyer.',
    'A relying party that refuses a live token after its authority ended. Tests alone cover this item.',
  ],
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
export interface EvidenceStep { readonly id: string; readonly status: 'shown' | 'not_run'; readonly refs: readonly Ref[]; readonly note: string }
export interface PageRun { readonly label: string; readonly kind: string; readonly date: string; readonly steps: ReadonlyMap<string, EvidenceStep> }

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** One reference from the evidence file, or null when it has no valid form. */
function refOf(raw: unknown): Ref | null {
  if (typeof raw === 'string') return REF_VALUE.test(raw) ? { kind: null, value: raw } : null;
  if (!isObject(raw) || Object.keys(raw).length !== 2) return null;
  const { kind, value } = raw;
  if (typeof kind !== 'string' || typeof value !== 'string' || !REF_KIND.test(kind) || !REF_VALUE.test(value)) return null;
  return kind === 'transaction' && !HASH.test(value) ? null : { kind, value };
}

/** The run of an evidence file. A file that is not the evidence of a run of this use case is a PreconditionError that names the file by its label and the rule that it breaks, never a value. */
export function parseEvidence(value: unknown, label: string, use: Pick<UseCase, 'runs' | 'evidenceSteps'>): PageRun {
  const bad = (rule: string): Error => new PreconditionError(`the evidence file ${label} is not usable: ${rule}`);
  if (!isObject(value)) throw bad('it is not a JSON object');
  const { kind, date, steps } = value;
  if (typeof kind !== 'string' || !use.runs.some((run) => run.id === kind)) throw bad('kind is not the id of a run of the use case');
  if (typeof date !== 'string' || !DATE.test(date) || Number.isNaN(Date.parse(date))) throw bad('date is not a date of the form YYYY-MM-DD');
  if (!Array.isArray(steps)) throw bad('steps is not a list');
  const allowed = new Set(use.evidenceSteps.filter((step) => step.run === kind || step.run === 'both').map((step) => step.id));
  const parsed = new Map<string, EvidenceStep>();
  steps.forEach((raw: unknown, index) => {
    const where = `steps[${index}]`;
    if (!isObject(raw)) throw bad(`${where} is not an object`);
    const { id, status, refs, note } = raw;
    if (typeof id !== 'string' || !STEP_ID.test(id)) throw bad(`${where}.id is not a step id`);
    if (!allowed.has(id)) throw bad(`${where}.id is not a step of a run of this kind`);
    if (parsed.has(id)) throw bad(`${where}.id repeats a step`);
    if (status !== 'shown' && status !== 'not_run') throw bad(`${where}.status is neither shown nor not_run`);
    if (!Array.isArray(refs) || refs.length > MOST_REFS) throw bad(`${where}.refs is not a list of at most ${MOST_REFS} references`);
    const list = refs.map(refOf);
    if (list.some((ref) => ref === null)) throw bad(`${where}.refs holds a value that is no reference`);
    if (note !== undefined && note !== null && (typeof note !== 'string' || note.length > MOST_NOTE_CHARS)) throw bad(`${where}.note is not a text of at most ${MOST_NOTE_CHARS} characters`);
    const text = typeof note === 'string' ? note : '';
    if (holdsSecret(id) || holdsSecret(text) || list.some((ref) => ref !== null && (holdsSecret(ref.value) || holdsSecret(ref.kind)))) throw bad(`${where} holds a mark of a secret`);
    parsed.set(id, { id, status, refs: list.filter((ref): ref is Ref => ref !== null), note: text });
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

/** The six cells of the row of a step. A step is shown only when the evidence file holds a reference for it. */
function rowOf(step: UseCase['evidenceSteps'][number], found: EvidenceStep | undefined): string[] {
  const text = SHOWS[step.primitive];
  if (text === undefined) throw new PreconditionError(`the table of shows and does not show has no entry for the primitive of the step ${step.id}`);
  const head = [step.id, cell(step.what), cell(step.primitive)];
  if (found === undefined) return [...head, PAGE_TEXT.none, `${PAGE_TEXT.notRun} ${PAGE_TEXT.noEntry}`, PAGE_TEXT.wholeStep];
  if (found.status === 'not_run') {
    return [...head, PAGE_TEXT.none, `${PAGE_TEXT.notRun} ${found.note === '' ? PAGE_TEXT.noReason : cell(found.note)}`, PAGE_TEXT.wholeStep];
  }
  if (found.refs.length === 0) return [...head, PAGE_TEXT.none, PAGE_TEXT.noReference, PAGE_TEXT.wholeStep];
  return [...head, found.refs.map(refText).join('; '), text.shows, text.doesNotShow];
}

/** The page: the header, the title, one table for each run, and the section "Not covered". The header comes first and verbatim. */
export function renderPage(input: { header: string; use: Pick<UseCase, 'title' | 'evidenceSteps'>; runs: readonly PageRun[] }): string {
  const body: string[] = [`# ${input.use.title}: ${PAGE_TEXT.results}`, '', PAGE_TEXT.intro, ''];
  for (const run of input.runs) {
    body.push(`## ${PAGE_TEXT.run} ${run.label}: ${run.kind}, ${run.date}`, '', `| ${PAGE_TEXT.columns.join(' | ')} |`, `|${PAGE_TEXT.columns.map(() => '---').join('|')}|`);
    for (const step of input.use.evidenceSteps.filter((spec) => spec.run === run.kind || spec.run === 'both')) body.push(`| ${rowOf(step, run.steps.get(step.id)).join(' | ')} |`);
    body.push('');
  }
  body.push(`## ${PAGE_TEXT.notCovered}`, '', PAGE_TEXT.notCoveredLead, '', ...PAGE_TEXT.notCoveredItems.map((item) => `- ${item}`), '', PAGE_TEXT.limitsLead, '', ...PAGE_TEXT.limitsItems.map((item) => `- ${item}`));
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
 * read), a file above the limit, a file that is not UTF-8 text, a file with no text in it, and a text with a mark of a secret or with 40 or more hex characters in a row (the size of a key, a hash
 * or a token).
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
  return text;
}

interface Found { readonly label: string; readonly path: string; readonly folder: 'public' | 'private' }

/** The evidence files of the state folder by label: the public files of `evidence/` and the private files of `evidence/private/`. A name that is no label, a link and two files with one label are refused. */
function listEvidence(stateDir: string): Map<string, Found> {
  const found = new Map<string, Found>();
  for (const folder of ['public', 'private'] as const) {
    const dir = folder === 'public' ? join(stateDir, 'evidence') : join(stateDir, 'evidence', 'private');
    let entries: Dirent[];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch (err) {
      if (codeOf(err) === 'ENOENT') continue;
      throw new PreconditionError(`the ${folder} evidence folder cannot be read (${codeOf(err)})`);
    }
    for (const entry of [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      if (entry.name.startsWith('.') || !entry.name.endsWith('.json')) continue;
      if (!entry.isFile()) throw new PreconditionError(`a ${folder} evidence file is not a regular file: a link or a folder is refused`);
      const label = entry.name.slice(0, -'.json'.length);
      if (!LABEL.test(label)) throw new PreconditionError(`the name of a ${folder} evidence file is no label: a label has 1 to 32 lower-case letters, digits and hyphens`);
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

function loadRuns(files: ReadonlyMap<string, Found>, wanted: readonly string[] | null, use: UseCase): PageRun[] {
  const labels = wanted ?? [...files.values()].filter((file) => file.folder === 'public').map((file) => file.label);
  if (labels.length === 0) throw new PreconditionError('there is no public evidence file: run the task evidence first, or name a private label with --runs');
  const runs = labels.map((label) => {
    const file = files.get(label);
    if (file === undefined) throw new PreconditionError(`there is no evidence file for the label ${label}: the evidence folders hold ${[...files.keys()].join(', ') || 'no file'}`);
    return parseEvidence(readEvidence(file), label, use);
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
  const header = readHeader(extra.headerFile, session.settings.keysDir);
  const runs = loadRuns(listEvidence(session.settings.stateDir), extra.runs, use);
  const page = renderPage({ header, use, runs });
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
  parse(_env, _settings, _use, flags) {
    const headerFile = flags.value('header-file');
    if (headerFile === '') throw new FlagError('--header-file needs the path of a text file');
    const list = flags.value('runs');
    let labels: string[] | null = null;
    if (list !== undefined) {
      labels = list.split(',');
      if (labels.length > MOST_RUNS || labels.some((label) => !LABEL.test(label))) throw new FlagError(`--runs is a comma list of at most ${MOST_RUNS} labels: each has 1 to 32 lower-case letters, digits and hyphens`);
      if (new Set(labels).size !== labels.length) throw new FlagError('--runs names a label twice');
    }
    return { headerFile: headerFile ?? null, runs: labels, page: null };
  },
  next: (session) => runSteps(session, [{ name: 'run', run: produce }]),
  cleanup: async () => ({ kind: 'done', message: 'the task results makes a page and takes nothing back' }),
  async status(session) {
    const where = pageFile(session.use);
    let files: ReadonlyMap<string, Found>;
    try { files = listEvidence(session.settings.stateDir); } catch (err) { return [`evidence files: cannot list them (${err instanceof Error ? err.message : 'an error'})`]; }
    const labels = [...files.values()].map((file) => `${file.label} (${file.folder})`);
    let page: string;
    try { page = `${where} exists, ${lstatSync(join(session.settings.stateDir, where)).size} bytes`; } catch { page = `${where} does not exist yet`; }
    return [`evidence files: ${labels.length === 0 ? 'none' : labels.join(', ')}`, `page: ${page}`];
  },
  result: (session) => (session.extra.page === null ? {} : { ...session.extra.page, labels: [...session.extra.page.labels] }),
};

export default results;
