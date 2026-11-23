// agents/reorder-agent/src/model/supplier.ts
// The reader of the supplier. `readSupplier` takes the DID of an Order Desk and a SKU, and gives what the agent needs to propose an order: the advert of each of the three lots, the three lot sizes of
// the SKU, and the first statement of the claim of the Order Desk. It reads four sources, in this order, and each step has its own failure code:
//
//   1. The indexer lists the adverts of the Order Desk capability. The adverts of this supplier must be Active, and each of the three lots must have exactly one.   `supplier_not_listed`
//   2. The chain shows each of these adverts: unspent, Active, with the capability and the model that the row names, and the supplier as its agent.                 `supplier_not_listed`
//   3. The three adverts hold one manifest hash. The manifest at the address of the advert has that hash. Its capability is the Order Desk, its behaviour parses as the behaviour of an Order Desk,
//      and the first statement of its claim is the one of the Order Desk of the kit.                                                                              `supplier_manifest_invalid`
//   4. The lots file at the address of the manifest has the hash that the manifest holds, and it parses. It lists the SKU.                                       `supplier_lots_invalid`, `sku_not_in_lots`
//   5. A source that cannot be read, or that gives an answer of the wrong shape, is `supplier_unavailable`. It is never a pass, and it is never `supplier_not_listed`.
//
// The hash of a body is checked before the body is parsed: a body whose hash is wrong is never parsed. The limits of a fetch come from this file and go to the port with each call. A supplier cannot widen
// them: not by an address, not by a size, not by a host. The address goes to the port as the advert or the manifest wrote it, and the port decides whether the host is allowed.
//
// What the supplier says reaches the result only as a reference of an advert (which the indexer lists and the chain confirms), as a lot size (a whole number that the lots file holds), and as the first statement
// of the claim (which is equal to the text of the kit). No text of the manifest, of the lots file or of an advert goes anywhere else. A detail names the source and the rule that failed. It never repeats a
// word of a manifest, of a lots file, of an answer or of an error, and it never repeats an address.
//
// The ports are functions. The folder reads no file and no environment variable, and it makes no network call by itself. The whole reading has a budget of time: the clock is read before each call of a
// port, and a clock that gives no time is `supplier_unavailable`, because an unknown time is never enough time.
import { createHash } from 'node:crypto';
import { rowAgentId } from '@vsa/buyer-core';
import { INVENTORY_CAPABILITIES, LOT_NAMES, ORDER_DESK_CLAIM, isLotName, lotSizeOf, lotsFileSha256, parseLotsFile } from '@vsa/usecase-kit/inventory';
import type { LotName, LotsFile } from '@vsa/usecase-kit/inventory';
import { ADDITION_MEMBERS, parseBehaviourAdditions, parseFileRef } from '@vsa/usecase-kit/manifest';
import { accepted, agentIdOf, isPlainObject, parseDid, parseDocument, parseJsonText, parseOutputRef, refused } from '@vsa/usecase-kit/protocol';
import type { Did, ManifestFileRef, OutputRef, ProtocolResult, Refused } from '@vsa/usecase-kit/protocol';

/** The codes of a failed reading, in the order of the steps above. */
export const SUPPLIER_FAILURES = ['supplier_not_listed', 'supplier_manifest_invalid', 'supplier_lots_invalid', 'sku_not_in_lots', 'supplier_unavailable'] as const;
export type SupplierFailureCode = (typeof SUPPLIER_FAILURES)[number];

/** The most bytes that the reader takes of the manifest and of the lots file. */
export const SUPPLIER_FILE_MAX_BYTES = 262_144;
/** The most time that one fetch has, in milliseconds. */
export const SUPPLIER_FETCH_TIMEOUT_MS = 10_000;
/** The time that the whole reading has, from its start, in milliseconds. */
export const SUPPLIER_READ_BUDGET_MS = 60_000;

/**
 * The members of a row of the indexer that the reader uses. `fetchSuppliers` of buyer-core gives rows with more members, and each of them fits. The indexer is not trusted: the reader checks each member that
 * it uses, and the chain confirms the advert.
 */
export interface SupplierRow {
  /** The reference of the advert, as `<transaction hash>#<index>`. */
  readonly utxo_ref: string;
  readonly capability_id: string;
  /** The model of an advert of the Order Desk is the name of its lot. */
  readonly model: string;
  /** `Active` or `Retired`. */
  readonly advert_status: string;
  /** The id of the agent that the advert names: 64 lower-case hex characters, or null for an advert of the legacy layout. */
  readonly agent_id?: string | null;
}

/**
 * What the chain shows of one advert, in the members that the reader uses. `readAdvert` of buyer-core gives this and more: either `{ error }` for a reference that is not an advert, or the advert with its
 * agent. `spent` is true for an advert that was spent, and a retired advert has the status `Retired`.
 */
export type AdvertRead =
  | { readonly error: string }
  | {
      readonly spent: boolean;
      readonly agentId: string | null;
      readonly advert: {
        readonly status: string;
        readonly capability_id: string;
        readonly model: string;
        readonly detail_uri: string;
        readonly detail_hash: string;
      };
    };

/** The limits that the reader gives to a fetch, with each call. The port enforces both. */
export interface FetchLimits {
  readonly maxBytes: number;
  readonly timeoutMs: number;
}

/** The answer of a fetch: the HTTP status, and the body as bytes. */
export interface FetchedBytes {
  readonly status: number;
  readonly bytes: Uint8Array;
}

/** What the reader needs, as functions. A function that throws, or that gives a wrong shape, is `supplier_unavailable`. */
export interface SupplierDeps {
  /** The adverts that the indexer lists for a capability: `fetchSuppliers` of buyer-core with `capability_id`. */
  readonly listAdverts: (capabilityId: string) => Promise<readonly SupplierRow[]>;
  /** One advert, read on the chain: `readAdvert` of buyer-core. */
  readonly readAdvert: (ref: OutputRef) => Promise<AdvertRead>;
  /** A file of the supplier. The real port is `safeFetch` of `@vsa/vector-read`, which refuses an address that is not https or that names a private host, and gives the body as text: the adapter makes the bytes. */
  readonly fetchBytes: (url: string, limits: FetchLimits) => Promise<FetchedBytes>;
  /** The time, in milliseconds. */
  readonly clock: () => number;
}

/** What the agent learns of the supplier. `lots` holds the three sizes of the SKU of the request. */
export interface SupplierView {
  /** The advert of each lot: the reference of the advert that a purchase order for that lot names. */
  readonly adverts: Readonly<Record<LotName, { readonly advert_ref: OutputRef }>>;
  readonly lots: Readonly<Record<LotName, number>>;
  /** The first statement of the claim of the Order Desk, as the manifest of the supplier holds it: it is the text of the kit. */
  readonly order_desk_claim_s1: string;
}

type Failure = Refused<SupplierFailureCode>;
const fail = (code: SupplierFailureCode, detail: string): Failure => refused(code, detail);

// --- The time of the reading -----------------------------------------------------------------------------------------------------------------------

interface Budget {
  /** The milliseconds that the budget still has, or null when the clock gives no time. */
  readonly left: () => number | null;
}

/** The time that the clock gives, or null when it throws or gives a value that is not a finite number. */
function timeOf(deps: SupplierDeps): number | null {
  try {
    const now: unknown = deps.clock();
    return typeof now === 'number' && Number.isFinite(now) ? now : null;
  } catch {
    return null;
  }
}

/**
 * One call of a port, inside the budget. A budget that is spent, a clock that gives no time, and a port that throws are `supplier_unavailable`. The detail names the source and never repeats the error
 * of the port: the words of an error can come from the supplier.
 */
async function viaPort<T>(budget: Budget, source: string, call: (leftMs: number) => Promise<T>): Promise<ProtocolResult<T, 'supplier_unavailable'>> {
  const left = budget.left();
  if (left === null) return refused('supplier_unavailable', `the clock gives no time, so the reading of ${source} does not start`);
  if (left <= 0) return refused('supplier_unavailable', `the time for the reading of the supplier is spent before the reading of ${source}`);
  try {
    return accepted(await call(left));
  } catch {
    return refused('supplier_unavailable', `${source} could not be read`);
  }
}

// --- Step 1: the indexer ---------------------------------------------------------------------------------------------------------------------------

/**
 * The reference of the one Active advert of each lot that the indexer lists for the agent. A row of another agent, of another capability, of another model than a lot name, and a row that is not Active
 * is not counted. A lot with no advert and a lot with two adverts are `supplier_not_listed`: the reader never picks one of two. An advert that the indexer lists two times is one advert. A row of this
 * agent with a reference that cannot be read is a row that the indexer gave wrongly, so it is `supplier_unavailable`.
 */
function refsOf(rows: readonly unknown[], agent: string): ProtocolResult<Record<LotName, OutputRef>, SupplierFailureCode> {
  const found: Record<LotName, Set<OutputRef>> = { 'lot-small': new Set(), 'lot-medium': new Set(), 'lot-large': new Set() };
  for (const row of rows) {
    if (!isPlainObject(row)) continue;
    const { model, capability_id: capability, advert_status: status, utxo_ref: ref } = row;
    // `rowAgentId` takes the id only when it has the shape of one: 64 lower-case hex characters.
    if (rowAgentId({ agent_id: typeof row.agent_id === 'string' ? row.agent_id : null }) !== agent) continue;
    if (capability !== INVENTORY_CAPABILITIES.order || status !== 'Active' || !isLotName(model)) continue;
    const reference = typeof ref === 'string' ? parseOutputRef(ref.toLowerCase(), 'utxo_ref') : null;
    if (reference === null || !reference.ok) return fail('supplier_unavailable', 'the indexer lists an advert of this supplier with a reference that cannot be read');
    found[model].add(reference.value);
  }
  const missing = LOT_NAMES.filter((lot) => found[lot].size === 0);
  if (missing.length > 0) return fail('supplier_not_listed', `the indexer lists no Active advert of this supplier for ${missing.join(', ')}`);
  const many = LOT_NAMES.filter((lot) => found[lot].size > 1);
  if (many.length > 0) return fail('supplier_not_listed', `the indexer lists more than one Active advert of this supplier for ${many.join(', ')}`);
  const only = (lot: LotName): OutputRef => [...found[lot]][0]!;
  return accepted({ 'lot-small': only('lot-small'), 'lot-medium': only('lot-medium'), 'lot-large': only('lot-large') });
}

// --- Step 2: the chain -----------------------------------------------------------------------------------------------------------------------------

/** What the reader keeps of an advert that the chain confirmed: where its manifest is and the hash of it. */
interface AdvertDetail {
  readonly detail_uri: string;
  readonly detail_hash: string;
}

/**
 * The detail of an advert, when the chain shows it as an unspent, Active advert of this agent with the capability of the Order Desk and the model of its lot. A reference that is not an advert, an advert
 * that is spent or retired, and an advert that names another capability, another model or another agent are `supplier_not_listed`. A reading of the wrong shape is `supplier_unavailable`.
 */
function checkAdvert(read: unknown, lot: LotName, agent: string): ProtocolResult<AdvertDetail, SupplierFailureCode> {
  const wrong = fail('supplier_unavailable', `the chain gave a reading of the wrong shape for the advert of ${lot}`);
  if (!isPlainObject(read)) return wrong;
  if (typeof read.error === 'string') return fail('supplier_not_listed', `the chain shows no advert at the reference of ${lot}`);
  const { spent, agentId, advert } = read;
  if (typeof spent !== 'boolean' || !(agentId === null || typeof agentId === 'string') || !isPlainObject(advert)) return wrong;
  const { status, capability_id: capability, model, detail_uri: uri, detail_hash: hash } = advert;
  if (typeof status !== 'string' || typeof capability !== 'string' || typeof model !== 'string' || typeof uri !== 'string' || typeof hash !== 'string') return wrong;
  if (spent) return fail('supplier_not_listed', `the advert of ${lot} is spent on the chain`);
  if (status !== 'Active') return fail('supplier_not_listed', `the advert of ${lot} is not Active on the chain`);
  if (capability !== INVENTORY_CAPABILITIES.order) return fail('supplier_not_listed', `the advert of ${lot} has another capability on the chain than the indexer lists`);
  if (model !== lot) return fail('supplier_not_listed', `the advert of ${lot} names another model on the chain than the indexer lists`);
  if (agentId !== agent) return fail('supplier_not_listed', `the advert of ${lot} names another agent on the chain than the supplier`);
  return accepted({ detail_uri: uri, detail_hash: hash });
}

// --- Steps 3 and 4: the two files ------------------------------------------------------------------------------------------------------------------

/**
 * The bytes of a file of the supplier. The port gets the address as it is written, and the limits of this reader. An answer with a status other than 200, and a port that throws, are
 * `supplier_unavailable`. A body above the byte limit is refused with `tooBig`, also when the port did not refuse it.
 */
async function fetchFile(
  deps: SupplierDeps, budget: Budget, url: string, what: 'manifest' | 'lots file', tooBig: 'supplier_manifest_invalid' | 'supplier_lots_invalid',
): Promise<ProtocolResult<Uint8Array, SupplierFailureCode>> {
  const fetched = await viaPort(budget, `the ${what} of the supplier`, (left) => deps.fetchBytes(url, { maxBytes: SUPPLIER_FILE_MAX_BYTES, timeoutMs: Math.min(SUPPLIER_FETCH_TIMEOUT_MS, Math.ceil(left)) }));
  if (!fetched.ok) return fetched;
  const answer: unknown = fetched.value;
  if (!isPlainObject(answer) || typeof answer.status !== 'number' || !(answer.bytes instanceof Uint8Array)) return fail('supplier_unavailable', `the fetch of the ${what} gave an answer of the wrong shape`);
  if (answer.status !== 200) return fail('supplier_unavailable', `the host of the ${what} did not answer with the status 200`);
  if (answer.bytes.length > SUPPLIER_FILE_MAX_BYTES) return fail(tooBig, `the ${what} has more than ${SUPPLIER_FILE_MAX_BYTES} bytes`);
  return accepted(answer.bytes);
}

/** The text of bytes in UTF-8, or null for bytes that are not valid UTF-8. A byte order mark stays in the text, so that the text has the same bytes as the file and the hash of the text is the hash of the file. */
function textOf(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return null;
  }
}

/** The members that the kit adds under `behaviour`, and none of the agent's own: the same pick as the check of a rendered manifest. A member of the old form with a claim reference is kept, so it is refused. */
function additionsOf(behaviour: unknown): Record<string, unknown> {
  const picked: Record<string, unknown> = {};
  if (!isPlainObject(behaviour)) return picked;
  for (const name of [...ADDITION_MEMBERS, 'standing_claim']) if (Object.hasOwn(behaviour, name)) picked[name] = behaviour[name];
  return picked;
}

/** The lots file that the manifest names: fetched, hashed, then parsed. The hash is checked first, so a body whose hash is wrong is never parsed. */
async function readLots(deps: SupplierDeps, budget: Budget, lots: ManifestFileRef): Promise<ProtocolResult<LotsFile, SupplierFailureCode>> {
  const file = await fetchFile(deps, budget, lots.uri, 'lots file', 'supplier_lots_invalid');
  if (!file.ok) return file;
  const text = textOf(file.value);
  if (text === null) return fail('supplier_lots_invalid', 'the lots file is not text in UTF-8');
  if (lotsFileSha256(text) !== lots.sha256) return fail('supplier_lots_invalid', 'the lots file does not have the hash that the manifest holds');
  const json = parseJsonText(text, 'lots file');
  if (!json.ok) return fail('supplier_lots_invalid', 'the lots file is not JSON');
  const parsed = parseLotsFile(json.value);
  if (!parsed.ok) return fail('supplier_lots_invalid', 'the lots file is not a lots file: a member or a number of it breaks a rule');
  return accepted(parsed.value);
}

// --- The reading -----------------------------------------------------------------------------------------------------------------------------------

/**
 * Reads the supplier `supplier` for the SKU `sku` (see the head of this file). It always gives a typed result and never throws: a source that cannot be read is `supplier_unavailable`, and a value that is
 * not what a step needs is the code of that step. A supplier that is not a DID is `supplier_not_listed`: no advert names it.
 */
export async function readSupplier(deps: SupplierDeps, supplier: Did, sku: string): Promise<ProtocolResult<SupplierView, SupplierFailureCode>> {
  const did = parseDid(supplier, 'supplier');
  if (!did.ok) return fail('supplier_not_listed', 'the supplier is not a DID, so no advert names it');
  const agent = agentIdOf(did.value);

  const startedAt = timeOf(deps);
  if (startedAt === null) return fail('supplier_unavailable', 'the clock gives no time, so the reading of the supplier does not start');
  const budget: Budget = {
    left: () => {
      const now = timeOf(deps);
      return now === null ? null : SUPPLIER_READ_BUDGET_MS - (now - startedAt);
    },
  };

  // Step 1: the indexer.
  const listed = await viaPort(budget, 'the indexer', () => deps.listAdverts(INVENTORY_CAPABILITIES.order));
  if (!listed.ok) return listed;
  const rows: unknown = listed.value;
  if (!Array.isArray(rows)) return fail('supplier_unavailable', 'the indexer gave a list of the wrong shape');
  const refs = refsOf(rows, agent);
  if (!refs.ok) return refs;

  // Step 2: the chain. The three adverts are read one after the other, from the smallest lot to the largest.
  const details: AdvertDetail[] = [];
  for (const lot of LOT_NAMES) {
    const reading = await viaPort(budget, `the advert of ${lot} on the chain`, () => deps.readAdvert(refs.value[lot]));
    if (!reading.ok) return reading;
    const detail = checkAdvert(reading.value, lot, agent);
    if (!detail.ok) return detail;
    details.push(detail.value);
  }

  // Step 3: the manifest. One hash for the three adverts, and its address must be an https address.
  const [first] = details;
  if (first === undefined || new Set(details.map((detail) => detail.detail_hash)).size !== 1) return fail('supplier_manifest_invalid', 'the adverts of the supplier hold more than one manifest hash');
  const manifestRef = parseFileRef({ uri: first.detail_uri, sha256: first.detail_hash }, 'advert');
  if (!manifestRef.ok) return fail('supplier_manifest_invalid', 'the manifest address of the adverts is not an https address with no user and no password, or the manifest hash is not a SHA-256');
  const manifestFile = await fetchFile(deps, budget, manifestRef.value.uri, 'manifest', 'supplier_manifest_invalid');
  if (!manifestFile.ok) return manifestFile;
  // The hash comes before the parse: a body whose hash is wrong is never parsed.
  if (createHash('sha256').update(manifestFile.value).digest('hex') !== manifestRef.value.sha256) return fail('supplier_manifest_invalid', 'the manifest does not have the hash that the adverts hold');
  const manifestText = textOf(manifestFile.value);
  if (manifestText === null) return fail('supplier_manifest_invalid', 'the manifest is not text in UTF-8');
  const manifestJson = parseJsonText(manifestText, 'manifest');
  if (!manifestJson.ok) return fail('supplier_manifest_invalid', 'the manifest is not JSON');
  const manifest = parseDocument(manifestJson.value, 'manifest');
  if (!manifest.ok) return fail('supplier_manifest_invalid', 'the manifest is not a JSON object that the protocol takes');
  if (!Object.hasOwn(manifest.value, 'capability_id') || manifest.value.capability_id !== INVENTORY_CAPABILITIES.order) return fail('supplier_manifest_invalid', 'the manifest names another capability than the Order Desk');
  const behaviour = parseBehaviourAdditions('order-desk', additionsOf(manifest.value.behaviour));
  if (!behaviour.ok) return fail('supplier_manifest_invalid', 'the behaviour of the manifest is not the behaviour of an Order Desk');
  const claimS1 = behaviour.value.claim.statements[0].text;
  if (claimS1 !== ORDER_DESK_CLAIM.statements[0].text) return fail('supplier_manifest_invalid', 'the first statement of the claim of the manifest is not the one of the Order Desk of the kit');

  // Step 4: the lots file, and the three sizes of the SKU.
  const lotsFile = await readLots(deps, budget, behaviour.value.lots);
  if (!lotsFile.ok) return lotsFile;
  const small = lotSizeOf(lotsFile.value, sku, 'lot-small');
  const medium = lotSizeOf(lotsFile.value, sku, 'lot-medium');
  const large = lotSizeOf(lotsFile.value, sku, 'lot-large');
  if (small === null || medium === null || large === null) return fail('sku_not_in_lots', 'the lots file does not list the SKU of the request');

  return accepted({
    adverts: {
      'lot-small': { advert_ref: refs.value['lot-small'] },
      'lot-medium': { advert_ref: refs.value['lot-medium'] },
      'lot-large': { advert_ref: refs.value['lot-large'] },
    },
    lots: { 'lot-small': small, 'lot-medium': medium, 'lot-large': large },
    order_desk_claim_s1: claimS1,
  });
}
