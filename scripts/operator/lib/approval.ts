// scripts/operator/lib/approval.ts - the approval file of a session, the cap that it sets, and the net outflow that counts against the cap.
// `GO.json` is the approval of one session: the tasks that may run, the wallet that pays, the cap on what the keys of the pack move out in the session, the steps that cannot be undone, and the
// end of the approval. The cap is cumulative. `Exposure` keeps one file for the session: the landing reserves the net outflow of a transaction in it before the transaction is submitted, and a
// transaction that cannot land any more gives its reserve back. A message of this file names a task, a tag or a field. It never shows a value of the approval file.
import { closeSync, lstatSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import type { Stats } from 'node:fs';
import { dirname } from 'node:path';
import { keyCredentialOf } from '../../checks/lib/addresses.ts';
import { writeFileAtomically } from '../../checks/lib/files.ts';
import type { WriteIo } from '../../checks/lib/files.ts';
import { units } from '../../checks/lib/format.ts';
import type { RingView } from '../../checks/lib/guards.ts';
import type { TxFacts } from '../../checks/lib/txfacts.ts';
import { codeOf } from './registry.ts';

/** The steps that cannot be undone: a record, a stake, an attestation (its deposit stays locked), the end of the subagents of a record, the revoke of an attestation, the revoke of a record, a change of the controller, the completion of a recovery, a retire and a successor. A session names the ones that it may take. */
export type IrreversibleTag = 'record' | 'stake' | 'attestation' | 'end-subagents' | 'attestation-revoke' | 'record-revoke' | 'controller-change' | 'recovery-complete' | 'retire' | 'successor';

export interface GoFile {
  approvedBy: string;
  at: string;
  session: string;
  /** The address of the run key, or the text `unset` before that key exists. */
  runWallet: string;
  /** The cap on the net outflow of the registry in the session, in units: 0 to 1000, at most 6 decimals. 0 is valid: a session of tasks that make no transaction. */
  capUnits: number;
  tasks: readonly string[];
  irreversible: readonly IrreversibleTag[];
  expiresAt: string;
  /** The only addresses outside the registry that may get funds, with the amount of each. */
  external?: readonly { label: string; address: string; units: number }[];
}

export class ApprovalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApprovalError';
  }
}

const TAGS: readonly string[] = [
  'record', 'stake', 'attestation', 'end-subagents', 'attestation-revoke', 'record-revoke', 'controller-change', 'recovery-complete', 'retire', 'successor',
] satisfies readonly IrreversibleTag[];
const GO_MEMBERS = ['approvedBy', 'at', 'session', 'runWallet', 'capUnits', 'tasks', 'irreversible', 'expiresAt', 'external'];
const EXTERNAL_MEMBERS = ['label', 'address', 'units'];
const EXPOSURE_MEMBERS = ['format', 'session', 'entries'];
const ENTRY_MEMBERS = ['step', 'tx_hash', 'net_lovelace', 'at'];
const MAX_UNITS = 1000;
const MAX_LIST = 64;
const MAX_STEP = 200;
const FILE_MODE = 0o600;
const CHECK_MODES = process.platform !== 'win32';
const SESSION = /^[a-z0-9][a-z0-9-]{0,47}$/;
const TASK = /^[a-z][a-z0-9-]{0,31}$/;
const LABEL = /^[a-z0-9][a-z0-9-]{0,31}$/;
const ADDRESS = /^addr1[0-9a-z]{1,200}$/;
const TX_HASH = /^[0-9a-f]{64}$/;
const LOVELACE_TEXT = /^(?:0|[1-9][0-9]{0,29})$/;
const ISO_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/;

/** The lovelace of an amount of units, or null when the value is not a number from 0 to 1000 that is a whole number of lovelace (at most 6 decimals). The text of the number does the sum, so no rounding error enters. */
function unitsToLovelace(value: unknown): bigint | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > MAX_UNITS) return null;
  const text = value.toFixed(6);
  return Number(text) === value ? BigInt(text.replace('.', '')) : null;
}

/** The lovelace of an amount of units: a number from 0 to 1000 with at most 6 decimals. Any other value is an error. */
export function lovelaceOfUnits(value: number): bigint {
  const lovelace = unitsToLovelace(value);
  if (lovelace === null) throw new ApprovalError(`an amount is a number from 0 to ${MAX_UNITS} units with at most 6 decimals`);
  return lovelace;
}

/** The POSIX milliseconds of an ISO 8601 time with a zone (`Z` or an offset), or null when the value is no such time or names a moment that does not exist (the 30th of February, hour 24). */
function parseIso(value: unknown): number | null {
  const parts = typeof value === 'string' ? ISO_TIME.exec(value) : null;
  if (parts === null) return null;
  const [year, month, day, hour, minute, second] = parts.slice(1, 7).map(Number);
  const utc = Date.UTC(year, month - 1, day, hour, minute, second, parts[7] === undefined ? 0 : Number(parts[7].padEnd(3, '0')));
  const moment = new Date(utc);
  const exists = moment.getUTCFullYear() === year && moment.getUTCMonth() === month - 1 && moment.getUTCDate() === day
    && moment.getUTCHours() === hour && moment.getUTCMinutes() === minute && moment.getUTCSeconds() === second;
  if (!exists) return null;
  const zone = parts[8]!;
  if (zone === 'Z') return utc;
  const [offsetHours, offsetMinutes] = [Number(zone.slice(1, 3)), Number(zone.slice(4, 6))];
  if (offsetHours > 23 || offsetMinutes > 59) return null;
  const offset = (offsetHours * 60 + offsetMinutes) * 60_000;
  return zone.startsWith('+') ? utc - offset : utc + offset;
}

/** The object that a parsed JSON value is, or null when it is a list, a text, a number or null. */
const asObject = (value: unknown): Record<string, unknown> | null => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null);

/** True when an object has exactly the members in the list, no more and no fewer. */
const hasMembers = (value: Record<string, unknown>, members: readonly string[]): boolean => Object.keys(value).length === members.length && members.every((member) => Object.hasOwn(value, member));

/** A member name for a message: the name when it looks like a name, else a phrase that holds nothing of it. */
const named = (member: string): string => (/^[A-Za-z0-9_]{1,32}$/.test(member) ? member : 'a name that is no member name');

/**
 * The name of the first member that an object of the JSON text holds twice, or null. `JSON.parse` keeps the last of two equal members and says nothing, and an approval must not be read two
 * ways. The text must be valid JSON already: the scan follows strings and brackets only.
 */
function repeatedMember(json: string): string | null {
  const open: (Set<string> | null)[] = [];
  for (let i = 0; i < json.length; i++) {
    const char = json[i];
    if (char === '{') open.push(new Set());
    else if (char === '[') open.push(null);
    else if (char === '}' || char === ']') open.pop();
    else if (char === '"') {
      let end = i + 1;
      while (end < json.length && json[end] !== '"') end += json[end] === '\\' ? 2 : 1;
      let next = end + 1;
      while (next < json.length && ' \t\n\r'.includes(json[next]!)) next++;
      const members = open[open.length - 1];
      if (members !== undefined && members !== null && json[next] === ':') {
        const name = JSON.parse(json.slice(i, end + 1)) as string;
        if (members.has(name)) return name;
        members.add(name);
      }
      i = end;
    }
  }
  return null;
}

/** What `loadGo` needs from the file system. */
export interface GoIo {
  stat(path: string): { isFile: boolean; mode: number } | null;
  read(path: string): string;
}

const realGoIo: GoIo = {
  stat: (path) => {
    const stats = statSync(path, { throwIfNoEntry: false });
    return stats === undefined ? null : { isFile: stats.isFile(), mode: stats.mode & 0o777 };
  },
  read: (path) => readFileSync(path, 'utf8'),
};

const TIME_RULE = 'is an ISO 8601 time with a zone, for example 2026-12-01T10:00:00Z';

const bad = (field: string, rule: string): ApprovalError => new ApprovalError(`the approval file: ${field} ${rule}`);

/**
 * Reads the approval file. The file must have mode 600, hold strict JSON (no member twice, no member that the approval does not take) and give every member a value that its rule allows. The
 * end of the approval must be after `nowMs`. A refusal names the field and never shows a value.
 */
export function loadGo(path: string, nowMs: number, io: Partial<GoIo> = {}): GoFile {
  if (!Number.isFinite(nowMs)) throw new ApprovalError('the clock gave no valid time, so the approval cannot be checked');
  const files: GoIo = { ...realGoIo, ...io };
  const attempt = <T>(run: () => T): T => {
    try { return run(); } catch (err) { throw new ApprovalError(`the approval file could not be read (${codeOf(err)})`); }
  };
  const found = attempt(() => files.stat(path));
  if (found === null) throw new ApprovalError('the approval file does not exist');
  if (!found.isFile) throw new ApprovalError('the approval file is not a file');
  if (CHECK_MODES && found.mode !== FILE_MODE) throw new ApprovalError(`the approval file has mode ${found.mode.toString(8)}: set mode 600 on it`);
  const text = attempt(() => files.read(path));
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new ApprovalError('the approval file is not JSON'); }
  const file = asObject(parsed);
  if (file === null) throw new ApprovalError('the approval file is not a JSON object');
  const repeated = repeatedMember(text);
  if (repeated !== null) throw new ApprovalError(`the approval file has the member ${named(repeated)} twice`);
  const extra = Object.keys(file).find((member) => !GO_MEMBERS.includes(member));
  if (extra !== undefined) throw new ApprovalError(`the approval file has a member that it does not take: ${named(extra)}`);

  const { approvedBy, at, session, runWallet, capUnits, tasks, irreversible, expiresAt, external } = file;
  if (typeof approvedBy !== 'string' || approvedBy.trim() === '') throw bad('approvedBy', 'is text that is not empty');
  if (typeof at !== 'string' || parseIso(at) === null) throw bad('at', TIME_RULE);
  const end = typeof expiresAt === 'string' ? parseIso(expiresAt) : null;
  if (typeof expiresAt !== 'string' || end === null) throw bad('expiresAt', TIME_RULE);
  if (typeof session !== 'string' || !SESSION.test(session)) throw bad('session', 'is 1 to 48 lower-case letters, digits and hyphens, and starts with a letter or a digit');
  if (typeof runWallet !== 'string' || (runWallet !== 'unset' && !ADDRESS.test(runWallet))) throw bad('runWallet', 'is an address that starts with addr1, or the text unset');
  if (typeof capUnits !== 'number' || unitsToLovelace(capUnits) === null) throw bad('capUnits', `is a number from 0 to ${MAX_UNITS} with at most 6 decimals`);
  if (!Array.isArray(tasks) || tasks.length < 1 || tasks.length > MAX_LIST || !tasks.every((task) => typeof task === 'string' && TASK.test(task))) {
    throw bad('tasks', `is a list of 1 to ${MAX_LIST} task names`);
  }
  if (!Array.isArray(irreversible) || irreversible.length > MAX_LIST || !irreversible.every((tag) => typeof tag === 'string' && TAGS.includes(tag))) {
    throw bad('irreversible', `is a list of tags from ${TAGS.join(', ')}`);
  }
  if (!(end > nowMs)) throw new ApprovalError('the approval file has expired: its expiresAt is not after the time now');
  // The approval is authority: no code can widen it after it is read.
  return Object.freeze({
    approvedBy, at, session, runWallet, capUnits, tasks: Object.freeze([...tasks]), irreversible: Object.freeze([...irreversible]), expiresAt,
    ...(external === undefined ? {} : { external: externalOf(external) }),
  });
}

/** The list of external addresses of an approval file, each entry checked. The list and its entries are frozen. */
function externalOf(value: unknown): readonly { label: string; address: string; units: number }[] {
  if (!Array.isArray(value) || value.length > MAX_LIST) throw bad('external', `is a list of at most ${MAX_LIST} entries`);
  const labels = new Set<string>();
  return Object.freeze(value.map((item: unknown) => {
    const entry = asObject(item);
    if (entry === null || !hasMembers(entry, EXTERNAL_MEMBERS)) throw bad('external', 'has an entry that does not have exactly the members label, address and units');
    const { label, address, units: amount } = entry;
    if (typeof label !== 'string' || !LABEL.test(label)) throw bad('external', 'has a label of 1 to 32 lower-case letters, digits and hyphens, and it starts with a letter or a digit');
    if (typeof address !== 'string' || !ADDRESS.test(address)) throw bad('external', 'has an address that starts with addr1');
    const lovelace = unitsToLovelace(amount);
    if (typeof amount !== 'number' || lovelace === null || lovelace === 0n) throw bad('external', `has an amount that is a number above 0 and up to ${MAX_UNITS} with at most 6 decimals`);
    if (labels.has(label)) throw bad('external', 'has two entries with one label');
    labels.add(label);
    return Object.freeze({ label, address, units: amount });
  }));
}

/** What a run needs from the approval: the task, the run wallet (null before the run key exists), the time now, and the irreversible tags of the step (an empty list when the step has none). */
export interface GoNeed { task: string; runWallet: string | null; nowMs: number; irreversible: readonly IrreversibleTag[] }

/**
 * Gives the approval back when it allows this run, and refuses when it does not: no approval, an approval that has expired, another run wallet, a task that it does not list, or a tag of an
 * irreversible step that it does not list. Before the run key exists (`runWallet` is null) only the task `keys` may run, with an approval that says `unset` and lists that task. When the key
 * exists, an approval that says `unset` is refused. A message names the task, the tag or the field, and never a value of the file.
 */
export function requireGo(go: GoFile | null, need: GoNeed): GoFile {
  if (go === null) throw new ApprovalError(`the task ${need.task} needs an approval file, and none is loaded`);
  if (!Array.isArray(need.irreversible)) throw new ApprovalError(`the run of the task ${need.task} did not say which irreversible tags its step carries: it gives an empty list when the step has none`);
  const end = parseIso(go.expiresAt);
  if (end === null) throw bad('expiresAt', 'is not an ISO 8601 time with a zone');
  if (!Number.isFinite(need.nowMs)) throw new ApprovalError('the clock gave no valid time, so the approval cannot be checked');
  if (!(end > need.nowMs)) throw new ApprovalError('the approval has expired');
  if (need.runWallet === null) {
    if (need.task !== 'keys' || go.runWallet !== 'unset' || !go.tasks.includes('keys')) {
      throw new ApprovalError(`no run key exists yet, so the task ${need.task} cannot run: only the task keys may run, with an approval that says unset for runWallet and lists the task keys`);
    }
  } else if (go.runWallet === 'unset') {
    throw new ApprovalError('the approval says unset for runWallet, and the run key exists: it must name the run wallet');
  } else if (go.runWallet !== need.runWallet) {
    throw new ApprovalError('the approval names another run wallet than the run key');
  }
  if (!go.tasks.includes(need.task)) throw new ApprovalError(`the approval does not list the task ${need.task} in tasks`);
  for (const tag of need.irreversible) {
    if (!go.irreversible.some((held) => held === tag)) throw new ApprovalError(`the approval does not list the irreversible tag ${tag} in irreversible`);
  }
  return go;
}

/** One reserve in the exposure file: the net outflow of the registry that one transaction adds, in lovelace. */
export interface ExposureEntry { step: string; txHash: string; netLovelace: bigint; at: string }

/** The amount of a call: a whole number of lovelace, not below 0. */
function checkAmount(netLovelace: bigint): void {
  if (typeof netLovelace !== 'bigint' || netLovelace < 0n) throw new ApprovalError('an amount of lovelace is a bigint that is not below 0');
}

const damaged = (rule: string): ApprovalError => new ApprovalError(`the exposure file is damaged: ${rule}`);

/**
 * The cumulative net outflow of the registry in one session. It keeps `exposure.<session>.json` in the state folder (format 1, mode 600, written whole): one entry for each transaction that the
 * session reserved. Every call reads the file again, so two instances over one file see each other. A file that is damaged is an error and never zero; a file that is not there holds no entry.
 * The cap is `capUnits` of the approval in lovelace. With no approval (`go` null) the cap is unknown, and every check refuses.
 */
export class Exposure {
  readonly #path: string;
  readonly #session: string;
  readonly #cap: bigint | null;
  readonly #io: Partial<WriteIo>;

  constructor(path: string, go: GoFile | null, io: Partial<WriteIo> = {}) {
    this.#path = path;
    this.#io = io;
    this.#session = go === null ? 'none' : go.session;
    const cap = go === null ? null : unitsToLovelace(go.capUnits);
    if (go !== null && cap === null) throw bad('capUnits', `is a number from 0 to ${MAX_UNITS} with at most 6 decimals`);
    this.#cap = cap;
  }

  /** The cap in lovelace, or null when no approval is loaded. */
  cap(): bigint | null {
    return this.#cap;
  }

  /** What the session has reserved so far. */
  total(): bigint {
    return this.#read().reduce((sum, entry) => sum + entry.netLovelace, 0n);
  }

  /** What the session would have reserved after one more transaction with this net outflow. It checks nothing against the cap and writes nothing. */
  projected(netLovelace: bigint): bigint {
    checkAmount(netLovelace);
    return this.total() + netLovelace;
  }

  /** Refuses when the reserves and this net outflow together are above the cap. A cap of 0 refuses every amount above 0. */
  refuseOver(netLovelace: bigint): void {
    checkAmount(netLovelace);
    this.#refuse(this.#read(), netLovelace);
  }

  /**
   * Checks the cap and appends the entry in one write. The landing calls it when it writes `in_flight`, before the submit, so a transaction that confirms after the run has ended is counted
   * already. A transaction that is reserved already with the same amount is the same entry (nothing changes); with another amount it is refused. The read, the check and the write happen
   * under the lock file, so two runs of one session cannot both pass the cap with the same room.
   */
  reserve(entry: ExposureEntry): void {
    const { step, txHash, netLovelace, at } = entry;
    checkAmount(netLovelace);
    if (typeof step !== 'string' || step === '' || step.length > MAX_STEP) throw new ApprovalError('an exposure entry needs a step of 1 to 200 characters');
    if (typeof txHash !== 'string' || !TX_HASH.test(txHash)) throw new ApprovalError('an exposure entry needs the hash of its transaction: 64 lower-case hex characters');
    if (parseIso(at) === null) throw new ApprovalError('an exposure entry needs the time as an ISO 8601 time with a zone');
    this.#locked(() => {
      const entries = this.#read();
      const same = entries.find((held) => held.txHash === txHash);
      if (same !== undefined) {
        if (same.netLovelace !== netLovelace) throw new ApprovalError('this transaction is reserved already with another amount');
        return;
      }
      this.#refuse(entries, netLovelace);
      this.#write([...entries, { step, txHash, netLovelace, at }]);
    });
  }

  /** Removes the entry of this transaction and says whether it was there. The runner calls it for a transaction that cannot land any more, and for no other. It holds the lock file as `reserve` does. */
  release(txHash: string): boolean {
    return this.#locked(() => {
      const entries = this.#read();
      if (!entries.some((held) => held.txHash === txHash)) return false;
      this.#write(entries.filter((held) => held.txHash !== txHash));
      return true;
    });
  }

  /**
   * Runs a read, a check and a write of the file while this call holds the lock file next to it (made with the flag `wx`, removed when the call ends, also by an error). A lock that exists is
   * another run, or a run that stopped and left it: the call refuses and names the file, and the operator removes it when no run is active.
   */
  #locked<T>(run: () => T): T {
    const lock = `${this.#path}.lock`;
    try {
      mkdirSync(dirname(this.#path), { recursive: true, mode: 0o700 });
      closeSync(openSync(lock, 'wx', FILE_MODE));
    } catch (err) {
      throw new ApprovalError(codeOf(err) === 'EEXIST'
        ? `the lock file ${lock} exists: another run holds it, or a run stopped and left it. Wait for the run, or remove the file when no run is active`
        : `the lock file ${lock} could not be made (${codeOf(err)})`);
    }
    try {
      return run();
    } finally {
      try { unlinkSync(lock); } catch { /* the file is gone already: the next run finds no lock, or it names the file that stays */ }
    }
  }

  #refuse(entries: readonly ExposureEntry[], netLovelace: bigint): void {
    if (this.#cap === null) throw new ApprovalError('no approval file is loaded, so no transaction may move funds');
    const total = entries.reduce((sum, held) => sum + held.netLovelace, 0n) + netLovelace;
    if (total > this.#cap) {
      throw new ApprovalError(`this net outflow of ${units(netLovelace)} and the ${units(total - netLovelace)} that the session reserved together are over the cap of ${units(this.#cap)}`);
    }
  }

  #read(): ExposureEntry[] {
    let found: Stats | undefined;
    try { found = lstatSync(this.#path, { throwIfNoEntry: false }); } catch (err) { throw new ApprovalError(`the exposure file could not be read (${codeOf(err)})`); }
    if (found === undefined) return [];
    if (found.isSymbolicLink()) throw damaged('it is a link, and the exposure file is a file');
    if (!found.isFile()) throw damaged('it is not a file');
    const mode = found.mode & 0o777;
    if (CHECK_MODES && mode !== FILE_MODE) throw new ApprovalError(`the exposure file has mode ${mode.toString(8)}: set mode 600 on it`);
    let parsed: unknown;
    try { parsed = JSON.parse(readFileSync(this.#path, 'utf8')); } catch (err) {
      throw err instanceof SyntaxError ? damaged('it is not JSON') : new ApprovalError(`the exposure file could not be read (${codeOf(err)})`);
    }
    const file = asObject(parsed);
    if (file === null || !hasMembers(file, EXPOSURE_MEMBERS)) throw damaged('it does not have exactly the members format, session and entries');
    if (file.format !== 1) throw damaged('its format is not 1');
    if (file.session !== this.#session) throw damaged('it belongs to another session');
    if (!Array.isArray(file.entries)) throw damaged('entries is not a list');
    const hashes = new Set<string>();
    return file.entries.map((item: unknown): ExposureEntry => {
      const entry = asObject(item);
      if (entry === null || !hasMembers(entry, ENTRY_MEMBERS)) throw damaged('an entry does not have exactly the members step, tx_hash, net_lovelace and at');
      const { step, tx_hash: txHash, net_lovelace: net, at } = entry;
      if (typeof step !== 'string' || step === '' || step.length > MAX_STEP) throw damaged('an entry has no step');
      if (typeof txHash !== 'string' || !TX_HASH.test(txHash)) throw damaged('an entry has no valid transaction hash');
      if (hashes.has(txHash)) throw damaged('two entries have one transaction hash');
      hashes.add(txHash);
      if (typeof net !== 'string' || !LOVELACE_TEXT.test(net)) throw damaged('an entry has an amount that is not whole lovelace as text');
      if (typeof at !== 'string' || parseIso(at) === null) throw damaged('an entry has no valid time');
      return { step, txHash, netLovelace: BigInt(net), at };
    });
  }

  #write(entries: readonly ExposureEntry[]): void {
    const body = entries.map((held) => ({ step: held.step, tx_hash: held.txHash, net_lovelace: held.netLovelace.toString(), at: held.at }));
    writeFileAtomically(this.#path, `${JSON.stringify({ format: 1, session: this.#session, entries: body }, null, 2)}\n`, this.#io);
  }
}

/**
 * The net outflow of the registry that one transaction adds, in lovelace: the lovelace of the inputs whose payment credential is a key of the ring, minus the lovelace of the outputs at the
 * wallets of the ring. A transfer between two wallets of the ring is only its fee, and a transfer to any other address counts in full. The result is not below 0 (a withdrawal of rewards
 * brings in more than the inputs hold). `inputs` holds the outputs that the transaction spends, by reference `<hash>#<index>`, as the node gives them. An input that is missing from it is an
 * error and never a zero. An input at a script address is no input of the registry. Reference inputs are not spent, so they do not count.
 * A transaction that runs scripts can also fail in phase 2: then it spends its collateral and nothing else. So the result is the largest of three numbers: the net outflow, `totalCollateral` of
 * the body, and the lovelace of the collateral inputs of the ring less the collateral return to a wallet of the ring (a return to another address is lost). The collateral inputs must be in
 * `inputs`: one that is missing is an error, also when the body states `totalCollateral`.
 */
export function netRegistryOutflow(facts: TxFacts, inputs: ReadonlyMap<string, { address: string; lovelace: bigint }>, ring: RingView): bigint {
  const keyHashes = ring.keyHashes();
  const wallets = new Set(ring.wallets().values());
  let leaving = 0n;
  for (const reference of facts.inputs) {
    const spent = inputs.get(reference);
    if (spent === undefined) throw new ApprovalError(`the net outflow cannot be counted: the input ${reference} is not among the outputs that the node gave`);
    const credential = keyCredentialOf(spent.address);
    if (credential !== null && keyHashes.has(credential)) leaving += spent.lovelace;
  }
  let returning = 0n;
  for (const output of facts.outputs) if (wallets.has(output.address)) returning += output.lovelace;
  const net = leaving > returning ? leaving - returning : 0n;
  if (!facts.runsScripts) return net;
  let pledged = 0n;
  for (const reference of facts.collateralInputs) {
    const held = inputs.get(reference);
    if (held === undefined) throw new ApprovalError(`the collateral cannot be counted: the input ${reference} is not among the outputs that the node gave`);
    const credential = keyCredentialOf(held.address);
    if (credential !== null && keyHashes.has(credential)) pledged += held.lovelace;
  }
  const back = facts.collateralReturn !== null && wallets.has(facts.collateralReturn.address) ? facts.collateralReturn.lovelace : 0n;
  const taken = pledged > back ? pledged - back : 0n;
  const stated = facts.totalCollateral ?? 0n;
  const worst = taken > stated ? taken : stated;
  return worst > net ? worst : net;
}
