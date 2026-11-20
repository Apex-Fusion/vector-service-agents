// packages/usecase-kit/src/manifest/fields.ts
// The members that the agents add under `behaviour`, one validator for each. A validator takes any value and never throws. It returns `{ ok: true, value }` with a NEW plain value in the form of the
// protocol type, or `{ ok: false, code: 'bad_shape', detail }`. The detail names the field and never repeats the value. The inputs come from code and from settings, so a wrong type is a refusal.
import { accepted, checkMembers, parseDigest, readMembers, refused } from '../protocol/index.ts';
import type { ManifestClaim, ManifestFileRef, ManifestModel, ManifestRelyingOn, ProtocolResult } from '../protocol/index.ts';

/** The longest statement of a claim, in characters. */
export const MAX_STATEMENT_CHARS = 500;
/** The longest address of a published file, in characters. */
export const MAX_URI_CHARS = 2048;
/** The longest route of a mock system or of the gateway, in characters. */
const MAX_ROUTE_CHARS = 200;

const MODEL_NAME = /^[A-Za-z0-9._:/-]+$/;
const ROUTE = /^(?:GET|POST|PUT|PATCH|DELETE|HEAD) \/[\x21-\x7e]*$/;
/** An address in printable characters with no space, that starts with `https://` and a host: `https:///x` is read as a host `x`, so it is refused here. */
const URI = /^https:\/\/[\x21-\x2e\x30-\x7e][\x21-\x7e]*$/;
const CONTROL = /[\x00-\x1f\x7f]/;
/** The text that stands for a value of the operator in a template: `<NAME>`. */
export const PLACEHOLDER = /^<[A-Z][A-Z0-9_]*>$/;

/** What a field takes beyond the plain form. */
export interface FieldOptions {
  /** A template has a placeholder in place of each value that the operator gives. A manifest that a service publishes has none. */
  readonly template?: boolean;
}

/** The elements of an array, read one time each as data. A hole, an accessor and an array of another kind are refused. */
function readList(value: unknown, field: string): ProtocolResult<readonly unknown[]> {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return refused('bad_shape', `${field} must be an array`);
    const items: unknown[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Reflect.getOwnPropertyDescriptor(value, index);
      if (descriptor === undefined || !('value' in descriptor)) return refused('bad_shape', `${field}[${index}] must be a plain member`);
      items.push(descriptor.value);
    }
    return accepted(items);
  } catch {
    return refused('bad_shape', `${field} cannot be read`);
  }
}

/** A list of texts that each pass `form`, with no text twice. `what` says what an entry is, for the detail. */
function readTexts(value: unknown, field: string, what: string, form: (text: string) => boolean): ProtocolResult<readonly string[]> {
  const list = readList(value, field);
  if (!list.ok) return list;
  const texts: string[] = [];
  for (const [index, item] of list.value.entries()) {
    if (typeof item !== 'string' || !form(item)) return refused('bad_shape', `${field}[${index}] must be ${what}`);
    if (texts.includes(item)) return refused('bad_shape', `${field}[${index}] is in the list twice`);
    texts.push(item);
  }
  return accepted(texts);
}

function statementText(value: unknown, field: string): ProtocolResult<string> {
  if (typeof value !== 'string') return refused('bad_shape', `${field} must be a text`);
  if (value.length === 0 || value.length > MAX_STATEMENT_CHARS) return refused('bad_shape', `${field} must have 1 to ${MAX_STATEMENT_CHARS} characters`);
  if (value !== value.trim()) return refused('bad_shape', `${field} must have no space at its start and at its end`);
  if (CONTROL.test(value)) return refused('bad_shape', `${field} must be one line of plain text`);
  return accepted(value);
}

/**
 * The claim of an agent: exactly three statements, with the ids S1, S2 and S3 in this order, and nothing else. The claim has no reference to a claim, because a claim is staked for each run, and a
 * member that is not `statements` is refused. The three texts differ.
 */
export function parseClaim(value: unknown, field = 'behaviour.claim'): ProtocolResult<ManifestClaim> {
  const read = readMembers(value, field);
  if (!read.ok) return read;
  const members = checkMembers(read.value, field, ['statements']);
  if (members !== null) return members;
  const list = readList(read.value.statements, `${field}.statements`);
  if (!list.ok) return list;
  if (list.value.length !== 3) return refused('bad_shape', `${field}.statements must hold exactly three statements`);
  const texts: string[] = [];
  for (const [index, item] of list.value.entries()) {
    const where = `${field}.statements[${index}]`;
    const statement = readMembers(item, where);
    if (!statement.ok) return statement;
    const names = checkMembers(statement.value, where, ['id', 'text']);
    if (names !== null) return names;
    if (statement.value.id !== `S${index + 1}`) return refused('bad_shape', `${where}.id must be "S${index + 1}"`);
    const text = statementText(statement.value.text, `${where}.text`);
    if (!text.ok) return text;
    if (texts.includes(text.value)) return refused('bad_shape', `${where}.text is the same as an earlier statement`);
    texts.push(text.value);
  }
  const [s1, s2, s3] = texts;
  return accepted({ statements: [{ id: 'S1', text: s1 }, { id: 'S2', text: s2 }, { id: 'S3', text: s3 }] } as ManifestClaim);
}

/** Makes the claim from the three texts of the statements, in the order S1, S2, S3. There is no place for a claim reference. */
export function buildClaim(texts: unknown): ProtocolResult<ManifestClaim> {
  const list = readList(texts, 'behaviour.claim');
  if (!list.ok) return list;
  if (list.value.length !== 3) return refused('bad_shape', 'behaviour.claim must be the three texts of the statements');
  return parseClaim({ statements: list.value.map((text, index) => ({ id: `S${index + 1}`, text })) });
}

/**
 * The models that the agent may hire and the most that it pays for one call. The list has at least one model. A model name has letters, digits, dots, underscores, colons, slashes and hyphens. The
 * ceiling is a whole number of lovelace, 1 or more: a text, a fraction, a negative number and zero are refused, and nothing is read as "no limit".
 */
export function parseModel(value: unknown, field = 'behaviour.model'): ProtocolResult<ManifestModel> {
  const read = readMembers(value, field);
  if (!read.ok) return read;
  const members = checkMembers(read.value, field, ['allowlist', 'max_price_lovelace']);
  if (members !== null) return members;
  const allowlist = readTexts(read.value.allowlist, `${field}.allowlist`, 'a model name of letters, digits, dots, underscores, colons, slashes and hyphens', (text) => MODEL_NAME.test(text));
  if (!allowlist.ok) return allowlist;
  if (allowlist.value.length === 0) return refused('bad_shape', `${field}.allowlist must name at least one model`);
  const ceiling = read.value.max_price_lovelace;
  if (typeof ceiling !== 'number' || !Number.isSafeInteger(ceiling) || ceiling < 1) return refused('bad_shape', `${field}.max_price_lovelace must be a whole number of lovelace, 1 or more`);
  return accepted({ allowlist: [...allowlist.value], max_price_lovelace: ceiling });
}

const isRoute = (text: string): boolean => text.length <= MAX_ROUTE_CHARS && ROUTE.test(text);

/** The routes that the agent calls, each as `METHOD /path`. A list can be empty. */
export function parseRelyingOn(value: unknown, field = 'behaviour.relying_on'): ProtocolResult<ManifestRelyingOn> {
  const read = readMembers(value, field);
  if (!read.ok) return read;
  const members = checkMembers(read.value, field, ['mock_systems', 'gateway_routes']);
  if (members !== null) return members;
  const mock = readTexts(read.value.mock_systems, `${field}.mock_systems`, 'a route as METHOD /path', isRoute);
  if (!mock.ok) return mock;
  const gateway = readTexts(read.value.gateway_routes, `${field}.gateway_routes`, 'a route as METHOD /path', isRoute);
  if (!gateway.ok) return gateway;
  return accepted({ mock_systems: [...mock.value], gateway_routes: [...gateway.value] });
}

/** True for an https address with no user and no password in it, in printable characters with no space. */
function isHttpsAddress(text: string): boolean {
  if (text.length > MAX_URI_CHARS || !URI.test(text)) return false;
  try {
    const url = new URL(text);
    return url.protocol === 'https:' && url.hostname !== '' && url.username === '' && url.password === '';
  } catch {
    return false;
  }
}

/**
 * A published file and its hash: the address is an https address with no user and no password, and the hash is 64 lower-case hex characters. In a template (`options.template`), each of the two can be a
 * placeholder such as `<LOTS_SHA256>`.
 */
export function parseFileRef(value: unknown, field: string, options: FieldOptions = {}): ProtocolResult<ManifestFileRef> {
  const read = readMembers(value, field);
  if (!read.ok) return read;
  const members = checkMembers(read.value, field, ['uri', 'sha256']);
  if (members !== null) return members;
  const template = options.template === true;
  const { uri, sha256 } = read.value;
  const placeholder = (item: unknown): item is string => template && typeof item === 'string' && PLACEHOLDER.test(item);
  if (!placeholder(uri) && (typeof uri !== 'string' || !isHttpsAddress(uri))) return refused('bad_shape', `${field}.uri must be an https address with no user and no password`);
  if (placeholder(sha256)) return accepted({ uri, sha256 });
  const digest = parseDigest(sha256, `${field}.sha256`);
  if (!digest.ok) return digest;
  return accepted({ uri, sha256: digest.value });
}
