// scripts/operator/lib/facts.ts - the facts file of the operator pack.
// `<state>/facts.json` keeps what one task found out and a later task needs: the records, the organisations, the stakes, the adverts and the rest (the sections of `Facts`). It holds public values
// only: a text that carries a mark of a secret (a key, a key variable that is set, a bearer token, a token in a URL) and a member that is named seed, secret, token, authorization or private are refused (`lib/secrets.ts`). A fact is set once. The same value again
// changes nothing, and another value is a FactsConflict unless the call says `replace`. A later step sets one field of a fact that an earlier step wrote (a stake reference, the time at which an
// organisation was verified, the transaction that lifts a hold or withdraws a claim): the fact must exist, the field is null until it is set, and it is set once in the same way. Every call reads
// the file again, so that two instances over one file see each other, and a `put` holds a lock file next to the facts file from the read to the rename, so that two runs cannot lose a fact of each
// other. A file that is damaged, and a link, are an error and never an empty store. A message names a section and a path, and never a value.
import { closeSync, lstatSync, mkdirSync, openSync, readFileSync, unlinkSync } from 'node:fs';
import type { Stats } from 'node:fs';
import { dirname } from 'node:path';
import { writeFileAtomically } from '../../checks/lib/files.ts';
import type { WriteIo } from '../../checks/lib/files.ts';
import { jsonSafe } from '../../checks/lib/format.ts';
import type {
  AdvertFact, AttestationFact, ClaimFact, DeployFact, Facts, FactsStore, HoldFact, ManifestFact, OrganisationFact, RecordFact, StakeFact, TenantFact,
} from './contract.ts';
import { codeOf } from './registry.ts';
import { holdsSecret, isSecretName } from './secrets.ts';

export type FactsReason = 'section' | 'path' | 'field' | 'missing_fact' | 'value' | 'secret' | 'conflict' | 'locked' | 'unreadable' | 'unwritable' | 'damaged' | 'mismatch' | 'mode';

export class FactsError extends Error {
  readonly reason: FactsReason;
  constructor(reason: FactsReason, message: string) {
    super(message);
    this.name = 'FactsError';
    this.reason = reason;
  }
}

/** A second value for a fact or a field that holds a value already, with no `replace` in the call. */
export class FactsConflict extends FactsError {
  constructor(message: string) {
    super('conflict', message);
    this.name = 'FactsConflict';
  }
}

/** The use case and the network that a facts file belongs to. A file of another use case or another network is refused at open. */
export interface FactsIdentity { readonly useCase: string; readonly network: string }

export const FACTS_FORMAT = 1;
const FILE_MODE = 0o600;
const CHECK_MODES = process.platform !== 'win32';
const ENVELOPE = ['format', 'useCase', 'network', 'facts'];
/** A name that is a key of the file: a name of a path, or a name of a container. It cannot be `__proto__`, and it has no space, no slash and no control character. */
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const LOVELACE = /^(?:0|[1-9][0-9]{0,29})$/;

type Check = (value: unknown) => boolean;
/** One check for each member of a fact: a member that the type gains and the table lacks is a type error. */
type Shape<T> = { readonly [K in keyof T]-?: Check };

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isNameList = (value: unknown): value is string[] => Array.isArray(value) && value.every((name) => typeof name === 'string' && SEGMENT.test(name));

const text: Check = (value) => typeof value === 'string' && value !== '';
const textOrNull: Check = (value) => value === null || text(value);
const lovelace: Check = (value) => typeof value === 'string' && LOVELACE.test(value);
const whole: Check = (value) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const flag: Check = (value) => typeof value === 'boolean';
const oneOf = (...allowed: string[]): Check => (value) => typeof value === 'string' && allowed.includes(value);
const textMap: Check = (value) => isObject(value) && Object.entries(value).every(([name, member]) => SEGMENT.test(name) && text(member));

const RECORD: Shape<RecordFact> = { did: text, id: text, tx: text, recordRef: text, depositLovelace: lovelace, registeredAt: text };
const ORGANISATION: Shape<OrganisationFact> = { txtName: text, txtValue: text, verifiedAt: textOrNull };
const STAKE: Shape<StakeFact> = { openingRef: text, stakeRef: textOrNull, tokenUnit: textOrNull, amountLovelace: lovelace };
const ADVERT: Shape<AdvertFact> = { ref: text, tx: text, detailUri: text, detailHash: text, endpoint: text, postedAt: text };
const MANIFEST: Shape<ManifestFact> = { uri: text, sha256: text, bytes: whole, readAt: text };
const ATTESTATION: Shape<AttestationFact> = { id: text, tx: text, digest: text, locator: text, validUntil: text, issuedAt: text, envelope: flag };
const CLAIM: Shape<ClaimFact> = {
  claimRef: text, documentTx: text, claimTx: text, claimToken: text, stakeLovelace: lovelace, windowMs: whole, stakedAt: text, withdrawableFrom: text, withdrawTx: textOrNull,
};
const TENANT: Shape<TenantFact> = { name: text, createdAt: text, seedKind: oneOf('default', 'custom') };
const HOLD: Shape<HoldFact> = { suspendTx: textOrNull, liftTx: textOrNull };
const DEPLOY: Shape<DeployFact> = { commit: text, images: textMap };

/** What a section is: the number of names in the path of one fact, the fields that a later step sets, and the checks of the members of a fact. */
interface SectionSpec { readonly depth: number; readonly fields: readonly string[]; readonly shape: Readonly<Record<string, Check>> }

const SECTIONS: { readonly [S in keyof Facts]: SectionSpec } = {
  records: { depth: 1, fields: [], shape: RECORD },
  organisations: { depth: 1, fields: ['verifiedAt'] satisfies readonly (keyof OrganisationFact)[], shape: ORGANISATION },
  stakes: { depth: 1, fields: ['stakeRef', 'tokenUnit'] satisfies readonly (keyof StakeFact)[], shape: STAKE },
  adverts: { depth: 2, fields: [], shape: ADVERT },
  manifests: { depth: 1, fields: [], shape: MANIFEST },
  attestations: { depth: 2, fields: [], shape: ATTESTATION },
  claims: { depth: 2, fields: ['withdrawTx'] satisfies readonly (keyof ClaimFact)[], shape: CLAIM },
  tenants: { depth: 1, fields: [], shape: TENANT },
  holds: { depth: 1, fields: ['suspendTx', 'liftTx'] satisfies readonly (keyof HoldFact)[], shape: HOLD },
  deploy: { depth: 0, fields: [], shape: DEPLOY },
};
const SECTION_NAMES = Object.keys(SECTIONS) as (keyof Facts)[];

const emptyFacts = (): Facts => ({ records: {}, organisations: {}, stakes: {}, adverts: {}, manifests: {}, attestations: {}, claims: {}, tenants: {}, holds: {}, deploy: null });

/** True when an object has exactly the members of the shape, and each member passes its check. */
function isFact(shape: Readonly<Record<string, Check>>, value: unknown): boolean {
  if (!isObject(value)) return false;
  const members = Object.keys(shape);
  return Object.keys(value).length === members.length && members.every((member) => Object.hasOwn(value, member) && shape[member](value[member]));
}

/** True when two values of JSON are the same value: the order of the members of an object does not count. */
function same(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((item, index) => same(item, b[index]));
  if (isObject(a) && isObject(b)) {
    const names = Object.keys(a);
    return names.length === Object.keys(b).length && names.every((name) => Object.hasOwn(b, name) && same(a[name], b[name]));
  }
  return a === b;
}

/** The value as the file will hold it: a bigint is its text, and a value that JSON cannot hold (undefined, a function, a symbol, a cycle) is refused. The result is a new value. */
function normalise(value: unknown): unknown {
  let json: string | undefined;
  try { json = JSON.stringify(jsonSafe(value)); } catch { json = undefined; }
  if (json === undefined) throw new FactsError('value', 'the value cannot be written as JSON');
  return JSON.parse(json);
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    for (const member of Object.values(value)) deepFreeze(member);
    Object.freeze(value);
  }
  return value;
}

const damaged = (rule: string): FactsError => new FactsError('damaged', `the facts file is damaged: ${rule}. It is left as it is: repair it, or restore a copy`);

/** Checks the tree of one section of a file: maps of names down to the facts, each fact with exactly its members. */
function checkTree(section: string, node: unknown, depth: number, shape: Readonly<Record<string, Check>>): void {
  if (depth === 0) {
    if (!isFact(shape, node)) throw damaged(`a fact of ${section} is not a valid fact`);
    return;
  }
  if (!isObject(node)) throw damaged(`${section} is not an object`);
  for (const [name, child] of Object.entries(node)) {
    if (!SEGMENT.test(name)) throw damaged(`${section} has a name that is no key`);
    checkTree(section, child, depth - 1, shape);
  }
}

/** The facts that a file holds, when each of its ten sections is valid. */
function factsOf(value: unknown): Facts {
  if (!isObject(value)) throw damaged('facts is not an object');
  if (Object.keys(value).length !== SECTION_NAMES.length || !SECTION_NAMES.every((name) => Object.hasOwn(value, name))) throw damaged('facts does not have exactly the sections of the contract');
  for (const name of SECTION_NAMES) {
    const spec = SECTIONS[name];
    if (name === 'deploy' && value[name] === null) continue;
    checkTree(name, value[name], spec.depth, spec.shape);
  }
  // Every section has the tree and the members that its type names: the checks above passed.
  return value as unknown as Facts;
}

/** Where a call writes: the names of the path of the fact, and the field when the path ends with one. */
interface Route { readonly names: readonly string[]; readonly field: string | null }

/** Reads the path of a call: the names of the fact, or the names of the fact and one field name that the section lists. A message names the section and never a name of the path. */
function routeOf(section: keyof Facts, path: unknown): Route {
  const spec = SECTIONS[section];
  if (!isNameList(path)) throw new FactsError('path', `the path for ${section} is a list of names: letters, digits and . _ : - only, at most 128 characters, and each name starts with a letter or a digit`);
  if (path.length === spec.depth) return { names: path, field: null };
  if (path.length === spec.depth + 1) {
    if (spec.fields.length === 0) throw new FactsError('path', `${section} takes no field path: the path of a fact of ${section} has ${spec.depth} name(s)`);
    const field = path[spec.depth];
    if (!spec.fields.includes(field)) throw new FactsError('field', `${section} has no field with this name: its fields are ${spec.fields.join(' and ')}`);
    return { names: path.slice(0, spec.depth), field };
  }
  throw new FactsError('path', `the path of a fact of ${section} has ${spec.depth} name(s)${spec.fields.length > 0 ? `, and one more for a field (${spec.fields.join(' or ')})` : ''}`);
}

/** The map that holds the fact at `names`: the section, or the map below it. A map that is missing is made when `create` is true, and gives undefined otherwise. */
function holderOf(facts: Facts, section: Exclude<keyof Facts, 'deploy'>, names: readonly string[], create: boolean): Record<string, unknown> | undefined {
  let holder: Record<string, unknown> = facts[section];
  for (const name of names.slice(0, -1)) {
    const next = Object.hasOwn(holder, name) ? holder[name] : undefined;
    if (isObject(next)) {
      holder = next;
    } else if (next === undefined && create) {
      const made: Record<string, unknown> = {};
      holder[name] = made;
      holder = made;
    } else {
      return undefined;
    }
  }
  return holder;
}

/** The fact at a path, or undefined when none is there. */
function getFact(facts: Facts, section: keyof Facts, names: readonly string[]): unknown {
  if (section === 'deploy') return facts.deploy ?? undefined;
  const holder = holderOf(facts, section, names, false);
  const last = names[names.length - 1];
  return holder !== undefined && Object.hasOwn(holder, last) ? holder[last] : undefined;
}

function setFact(facts: Facts, section: keyof Facts, names: readonly string[], value: unknown): void {
  if (section === 'deploy') {
    // The shape of the value was checked before the call.
    facts.deploy = value as DeployFact;
    return;
  }
  const holder = holderOf(facts, section, names, true);
  if (holder !== undefined) holder[names[names.length - 1]] = value;
}

/**
 * The facts file. Open it with `FactsFile.open`: a file that is there is checked at once (its mode, its JSON, its identity and each fact), and a file that is not there is made by the first
 * `put`. `read` and `put` read the file again at every call.
 */
export class FactsFile implements FactsStore {
  readonly path: string;
  readonly #identity: FactsIdentity;
  readonly #io: Partial<WriteIo>;

  private constructor(path: string, identity: FactsIdentity, io: Partial<WriteIo>) {
    this.path = path;
    this.#identity = identity;
    this.#io = io;
  }

  /** Opens the facts file of a use case on a network. A file of another use case or network, a file that other users can read, and a file that is damaged are refused, and left as they are. */
  static open(path: string, identity: FactsIdentity, io: Partial<WriteIo> = {}): FactsFile {
    const file = new FactsFile(path, { useCase: identity.useCase, network: identity.network }, io);
    file.#load();
    return file;
  }

  /** The facts that the file holds now, deeply frozen: the empty facts when the file is not there. */
  read(): Readonly<Facts> {
    return deepFreeze(this.#load());
  }

  /**
   * Sets the fact at `path` below `section`, or one field of a fact when the path ends with a field name that the section lists. The same value again is a no-op. Another value is a
   * FactsConflict unless `options.replace` is true. A field of a fact needs the fact; a field that holds null is not set, so its first value goes in without `replace`. A value that holds a
   * secret, and a value that is no fact of its section, are refused, and nothing is written.
   */
  put<S extends keyof Facts>(section: S, path: readonly string[], value: unknown, options: { replace?: boolean } = {}): void {
    if (typeof section !== 'string' || !Object.hasOwn(SECTIONS, section)) throw new FactsError('section', `the section is one of ${SECTION_NAMES.join(', ')}`);
    const route = routeOf(section, path);
    const stored = normalise(value);
    if (path.some(isSecretName) || holdsSecret(stored)) throw new FactsError('secret', `a path or a value for ${section} looks like a secret: the facts file holds public values only`);
    if (route.field === null ? !isFact(SECTIONS[section].shape, stored) : !text(stored)) {
      throw new FactsError('value', route.field === null ? `the value is not a fact of ${section}: it has exactly the members of its type, each of the right kind` : `the value of a field of ${section} is a text that is not empty`);
    }
    const where = [section, ...route.names].join('.');
    const replace = options.replace === true;
    this.#locked(() => {
      const facts = this.#load();
      if (route.field === null) {
        const held = getFact(facts, section, route.names);
        if (held !== undefined && same(held, stored)) return;
        if (held !== undefined && !replace) throw new FactsConflict(`the fact ${where} holds another value: set it again with replace to change it`);
        setFact(facts, section, route.names, stored);
      } else {
        const fact = getFact(facts, section, route.names);
        if (!isObject(fact)) throw new FactsError('missing_fact', `the fact ${where} does not exist: write the whole fact before one of its fields`);
        const held = fact[route.field];
        if (held !== null && held !== undefined && held === stored) return;
        if (held !== null && held !== undefined && !replace) throw new FactsConflict(`the field ${route.field} of the fact ${where} holds another value: set it again with replace to change it`);
        fact[route.field] = stored;
      }
      this.#write(facts);
    });
  }

  /**
   * Runs a read, a check and a write of the file while this call holds the lock file next to it (made with the flag `wx`, removed when the call ends, also by an error). A lock that exists is
   * another run, or a run that stopped and left it: the call refuses and names the file, and the operator removes it when no run is active. So two runs cannot lose a fact of each other, and
   * they cannot share the temporary file of the write. A read needs no lock: the write replaces the file whole.
   */
  #locked(run: () => void): void {
    const lock = `${this.path}.lock`;
    try { mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 }); } catch (err) { throw new FactsError('unwritable', `the facts file could not be written (${codeOf(err)})`); }
    try { closeSync(openSync(lock, 'wx', FILE_MODE)); } catch (err) {
      throw codeOf(err) === 'EEXIST'
        ? new FactsError('locked', `the lock file ${lock} exists: another run holds it, or a run stopped and left it. Wait for the run, or remove the file when no run is active`)
        : new FactsError('unwritable', `the lock file ${lock} could not be made (${codeOf(err)})`);
    }
    try {
      run();
    } finally {
      try { unlinkSync(lock); } catch { /* the file is gone already: the next run finds no lock, or it names the file that stays */ }
    }
  }

  /** Reads the file and checks it: the facts, or the empty facts when the file is not there. */
  #load(): Facts {
    let found: Stats | undefined;
    try { found = lstatSync(this.path, { throwIfNoEntry: false }); } catch (err) { throw new FactsError('unreadable', `the facts file could not be read (${codeOf(err)})`); }
    if (found === undefined) return emptyFacts();
    if (found.isSymbolicLink()) throw damaged('it is a link, and the facts file is a file');
    if (!found.isFile()) throw damaged('it is not a file');
    const mode = found.mode & 0o777;
    if (CHECK_MODES && mode !== FILE_MODE) throw new FactsError('mode', `the facts file has mode ${mode.toString(8)}: set mode 600 on it`);
    let parsed: unknown;
    try { parsed = JSON.parse(readFileSync(this.path, 'utf8')); } catch (err) {
      throw err instanceof SyntaxError ? damaged('it is not JSON') : new FactsError('unreadable', `the facts file could not be read (${codeOf(err)})`);
    }
    if (!isObject(parsed) || Object.keys(parsed).length !== ENVELOPE.length || !ENVELOPE.every((member) => Object.hasOwn(parsed, member))) {
      throw damaged('it does not have exactly the members format, useCase, network and facts');
    }
    if (parsed.format !== FACTS_FORMAT) throw damaged(`its format is not ${FACTS_FORMAT}`);
    if (typeof parsed.useCase !== 'string' || typeof parsed.network !== 'string') throw damaged('useCase and network are not texts');
    if (parsed.useCase !== this.#identity.useCase) throw new FactsError('mismatch', 'the facts file is the file of another use case than this run: use another state folder');
    if (parsed.network !== this.#identity.network) throw new FactsError('mismatch', 'the facts file is the file of another network than this run: use another state folder');
    return factsOf(parsed.facts);
  }

  #write(facts: Facts): void {
    const ordered = Object.fromEntries(SECTION_NAMES.map((name) => [name, facts[name]]));
    const body = `${JSON.stringify({ format: FACTS_FORMAT, useCase: this.#identity.useCase, network: this.#identity.network, facts: ordered }, null, 2)}\n`;
    try { writeFileAtomically(this.path, body, this.#io); } catch (err) { throw new FactsError('unwritable', `the facts file could not be written (${codeOf(err)})`); }
  }
}
