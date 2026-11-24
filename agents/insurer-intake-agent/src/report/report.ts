// agents/insurer-intake-agent/src/report/report.ts
// The report of the attestations of the sender. The Insurer Intake Agent reads three attestations about the sender and reports what it found. It never refuses a job for one of them, never changes the decision of
// the model and never puts one in a prompt. The result goes into `attestations` of the intake record, and the log says only the word and the number of rows of each kind.
//
//   provenance         type 1, issued by the Provider of the sender (the Provider party of the record of the sender that is in force at the time of the check, by the hash of its key)
//   software           type 2, issued by the Provider of the sender
//   principal_binding  type 4, issued by the ROOT DELEGATOR of the delegation of the request, and by nobody else: a key principal by the hash of its key, an agent root by the id of its record, never both
//
// The kinds are read one after the other, in this order. For each kind:
//   1. The expected issuer. For the two Provider kinds it is the key of the Provider party of the sender that is in force at the time of the check, read once for both. A record with no such party that
//      names a key gives `absent` for both, and no list is read. A Provider that has ended or has not started does not count, and a Provider that a script or the controller set signs for does not hide
//      a Provider that a key signs for.
//      For the binding it is the root delegator of the delegation. A delegation with no live chain gives `unreadable`: the hook found a live chain, so the ledger changed or cannot be read.
//   2. The list of the attestations about the sender of the type of the kind. Only the rows of the expected issuer count, and none gives `absent`. A row of another issuer never counts: a stranger cannot make
//      a kind `valid` or `invalid`. A key principal matches a row by the key hash only, and an agent root matches by the id of its record only. A row that another key of the record of a member issued is
//      not a binding by the key principal of that member.
//   3. The two newest rows of the expected issuer (the issue time, then the id) are checked one after the other. `valid` when a check says true, and the older row is then not asked. `invalid` when rows of the
//      expected issuer exist and no check says true. An older valid attestation after a newer invalid one is `valid`. The third row is never asked. A row whose issue time is after the time of the check still
//      counts: a relying party does not require that the time is after the issue time, and the check holds the rule of the time.
//   4. A source that cannot be read is `unreadable` for the kind, and never `absent`, `invalid` or `valid`: a read that throws, a read that does not answer in READ_BUDGET_MS, and an answer of the wrong type
//      (a list that is no list, a row with a member of the wrong type, a check that is no boolean, a key hash that is no key hash, a root of neither form). When REPORT_BUDGET_MS is spent, each kind that is not
//      done is `unreadable`, and no read starts after that.
//
// The digest of an attestation is not checked. A type 4 attestation holds a salted commitment: the document and the salt stay off the ledger with the hirer, so this agent cannot recompute it.
//
// Every time is on the clock of the dependencies, so a test moves it by hand. A time of the check that is no whole number of milliseconds gives `unreadable` for every kind, with no read: a time that is not a
// number would read as a time that is always in force. The function never throws, it gives only the four words of the intake record, and the log never holds a value of an attestation, an id, a key or the text
// of an error.
import { ATT_TYPES } from '@vsa/buyer-core';
import { within } from '@vsa/usecase-kit/access';
import type { Clock } from '@vsa/usecase-kit/access';
import type { AttestationState } from '@vsa/usecase-kit/priorauth';
import { didOfAgentId, isKeyHash, isPlainObject } from '@vsa/usecase-kit/protocol';
import type { Did } from '@vsa/usecase-kit/protocol';
import type { ReportDeps, ReportExpectation, ReportInput, ReportRow } from './ports.ts';

/** The time of the whole report: 45 seconds. A kind that is not done when it ends is `unreadable`. */
export const REPORT_BUDGET_MS = 45_000;

/** The time of one read (a list, a check, the Provider of the sender, the root delegator): 15 seconds. A read that does not answer in this time is a source that cannot be read. */
export const READ_BUDGET_MS = 15_000;

/** How many of the newest rows of the expected issuer a kind checks. */
const CHECKED_ROWS = 2;

/** The id of a record: 64 lower-case hex characters. */
const RECORD_ID = /^[0-9a-f]{64}$/;

/** What the agent found about the sender, one of the four words of the intake record for each kind. */
export interface AttestationReport {
  readonly provenance: AttestationState;
  readonly software: AttestationState;
  readonly principal_binding: AttestationState;
}

type Kind = keyof AttestationReport;

interface KindSpec {
  readonly name: Kind;
  /** The type of the attestation of this kind. */
  readonly attType: number;
  /** Who issues it: the Provider of the sender, or the root delegator of the delegation. */
  readonly issuer: 'provider' | 'root';
}

const KINDS: readonly KindSpec[] = [
  { name: 'provenance', attType: ATT_TYPES.provenance, issuer: 'provider' },
  { name: 'software', attType: ATT_TYPES.software, issuer: 'provider' },
  { name: 'principal_binding', attType: ATT_TYPES.principal_binding, issuer: 'root' },
];

/** The issuer that a kind expects: the hash of a key, or the id of a record. Never both. */
type Expected = { readonly by: 'key_hash'; readonly hash: string } | { readonly by: 'record'; readonly id: string };

/** Why a kind is `unreadable`. It goes to the log as this fixed word, and never to the record. */
type Why = 'bad_answer' | 'bad_input' | 'no_root' | 'read_failed' | 'read_timeout' | 'report_budget';

/** The outcome of one read: its value, or the reason why there is none. */
type Found<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly why: Why };

/** The word of a kind, the number of rows that it looked at, and the reason when the word is `unreadable`. */
interface Verdict {
  readonly state: AttestationState;
  readonly rows: number;
  readonly why?: Why;
}

const unreadable = (why: Why, rows = 0): Verdict => ({ state: 'unreadable', rows, why });

/** What one report holds while it runs. */
interface Run {
  readonly deps: ReportDeps;
  readonly input: ReportInput;
  /** The time at which the report ends, on the clock of the dependencies. It is no number when the clock gave no time, and then no read starts. */
  readonly deadline: number;
  /** The one read of the Provider of the sender, started by the first kind that needs it and used by the second. */
  provider: Promise<Found<Expected | null>> | undefined;
}

function deadlineOf(clock: Clock): number {
  try {
    return clock.now() + REPORT_BUDGET_MS;
  } catch {
    return Number.NaN;
  }
}

/**
 * One read of a port, bounded by the clock: it ends in READ_BUDGET_MS, or when the budget of the report ends, whichever is first. It never throws. A read that throws, in this function or in the port, is
 * `read_failed`. A read that has no time left to start is not started.
 */
async function read<T>(run: Run, work: () => Promise<T>): Promise<Found<T>> {
  try {
    const left = Math.min(READ_BUDGET_MS, run.deadline - run.deps.clock.now());
    // `left` is no number when a clock gave none: `!(left > 0)` is true for it, so no read starts.
    if (!(left > 0)) return { ok: false, why: 'report_budget' };
    const bounded = await within(run.deps.clock, left, work);
    if (bounded.timedOut) return { ok: false, why: left < READ_BUDGET_MS ? 'report_budget' : 'read_timeout' };
    return { ok: true, value: bounded.value };
  } catch {
    return { ok: false, why: 'read_failed' };
  }
}

/** The root as an expected issuer: a key principal by its key hash, an agent by its record id. Any other shape, and a shape with a member of the other form, is null. */
function expectedOfRoot(root: unknown): Expected | null {
  if (!isPlainObject(root)) return null;
  const members = Object.keys(root).sort().join(',');
  if (root.type === 'key' && members === 'hash,type' && isKeyHash(root.hash)) return { by: 'key_hash', hash: root.hash };
  if (root.type === 'agent' && members === 'id,type' && typeof root.id === 'string' && RECORD_ID.test(root.id)) return { by: 'record', id: root.id };
  return null;
}

/** The rows of a list, as copies, or null when the answer is no list or when one row has a member of the wrong type. One wrong row makes the whole list unusable: it could have been the row that decides. */
function rowsOf(answer: unknown): ReportRow[] | null {
  if (!Array.isArray(answer)) return null;
  const rows: ReportRow[] = [];
  for (const entry of answer as unknown[]) {
    if (!isPlainObject(entry)) return null;
    const { id, issuer_key_hash: keyHash, issuer_id: recordId, issued_at: issuedAt } = entry;
    if (typeof id !== 'string' || id === '' || typeof keyHash !== 'string') return null;
    if (recordId !== null && typeof recordId !== 'string') return null;
    if (typeof issuedAt !== 'number' || !Number.isSafeInteger(issuedAt)) return null;
    rows.push({ id, issuer_key_hash: keyHash, issuer_id: recordId, issued_at: issuedAt });
  }
  return rows;
}

/** Is the row of the expected issuer? A key hash is compared with the key hash of the row, and a record id with the record id of the row. A row is never matched by the other member. */
function issuedBy(row: ReportRow, expected: Expected): boolean {
  return expected.by === 'key_hash' ? row.issuer_key_hash === expected.hash : row.issuer_id === expected.id;
}

/** The rows newest first: the issue time, then the id (the order of the lists of the registry), with one row for each attestation. */
function newestFirst(rows: readonly ReportRow[]): ReportRow[] {
  const seen = new Set<string>();
  const ordered: ReportRow[] = [];
  for (const row of [...rows].sort((a, b) => b.issued_at - a.issued_at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    ordered.push(row);
  }
  return ordered;
}

/** What a check is asked, as a new object for each call. The issuer is a key hash or a DID, and never both. */
function expectationOf(sender: Did, attType: number, expected: Expected): ReportExpectation {
  return { attType, subject: sender, issuer: expected.by === 'key_hash' ? { key_hash: expected.hash } : { did: didOfAgentId(expected.id) } };
}

/** The attestations of one type about the sender: only those of the expected issuer count, and the two newest are checked. */
async function judge(run: Run, attType: number, expected: Expected): Promise<Verdict> {
  const listed = await read(run, () => run.deps.list(run.input.sender, attType));
  if (!listed.ok) return unreadable(listed.why);
  const rows = rowsOf(listed.value);
  if (rows === null) return unreadable('bad_answer');
  const kept = newestFirst(rows.filter((row) => issuedBy(row, expected))).slice(0, CHECKED_ROWS);
  if (kept.length === 0) return { state: 'absent', rows: rows.length };
  for (const row of kept) {
    const checked = await read(run, () => run.deps.check(row.id, run.input.atMs, expectationOf(run.input.sender, attType, expected)));
    if (!checked.ok) return unreadable(checked.why, rows.length);
    // Only the boolean true is a pass. A word, a number or an object that a port gives is a port that is wrong, and it is never read as true or as false.
    if (typeof checked.value !== 'boolean') return unreadable('bad_answer', rows.length);
    if (checked.value) return { state: 'valid', rows: rows.length };
  }
  return { state: 'invalid', rows: rows.length };
}

async function readProvider(run: Run): Promise<Found<Expected | null>> {
  const answer = await read(run, () => run.deps.providerKeyHashOf(run.input.sender, run.input.atMs));
  if (!answer.ok) return answer;
  if (answer.value === null) return { ok: true, value: null };
  return isKeyHash(answer.value) ? { ok: true, value: { by: 'key_hash', hash: answer.value } } : { ok: false, why: 'bad_answer' };
}

async function readRoot(run: Run): Promise<Found<Expected | null>> {
  const answer = await read(run, () => run.deps.rootDelegatorOf(run.input.delegation));
  if (!answer.ok) return answer;
  if (answer.value === null) return { ok: false, why: 'no_root' };
  const expected = expectedOfRoot(answer.value);
  return expected === null ? { ok: false, why: 'bad_answer' } : { ok: true, value: expected };
}

async function judgeKind(run: Run, kind: KindSpec): Promise<Verdict> {
  let issuer: Found<Expected | null>;
  if (kind.issuer === 'root') issuer = await readRoot(run);
  else {
    const started = (run.provider ??= readProvider(run));
    issuer = await started;
  }
  if (!issuer.ok) return unreadable(issuer.why);
  // No Provider party that names a key: no attestation of the Provider can exist, and nothing is read.
  if (issuer.value === null) return { state: 'absent', rows: 0 };
  return judge(run, kind.attType, issuer.value);
}

/** One line of the log. A log that throws changes nothing in the report. */
function say(deps: ReportDeps, kind: Kind, verdict: Verdict): void {
  const why = verdict.why === undefined ? '' : ` why=${verdict.why}`;
  try {
    deps.log(`attestation report: ${kind} ${verdict.state} rows=${verdict.rows}${why}`);
  } catch {
    // The log is for the operator. It is not part of the report.
  }
}

/**
 * Reports the provenance, the software and the principal-binding attestation of the sender. It reads through `deps` only, never refuses and never throws. Each kind that cannot be read, or that the budget cuts
 * off, is `unreadable`.
 */
export async function reportAttestations(deps: ReportDeps, input: ReportInput): Promise<AttestationReport> {
  const report: { -readonly [K in Kind]: AttestationState } = { provenance: 'unreadable', software: 'unreadable', principal_binding: 'unreadable' };
  try {
    const atMs: unknown = typeof input === 'object' && input !== null ? input.atMs : undefined;
    const timeIsWhole = typeof atMs === 'number' && Number.isSafeInteger(atMs) && atMs >= 0;
    const run: Run = { deps, input, deadline: deadlineOf(deps.clock), provider: undefined };
    for (const kind of KINDS) {
      const verdict = timeIsWhole ? await judgeKind(run, kind) : unreadable('bad_input');
      report[kind.name] = verdict.state;
      say(deps, kind.name, verdict);
    }
  } catch {
    // A fault that no read guards leaves each kind that is not done `unreadable`.
  }
  return report;
}
