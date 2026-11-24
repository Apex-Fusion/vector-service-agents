// agents/sourcing-agent/test/bidders/support.ts
// The stub ports of the bidder reader, and the world that they serve: the rows of the indexer, the adverts on the chain, the manifest and the price list of each Bid Desk, and the facts of each one (its DID
// resolution, its stake, its cases, its compliance attestation, its credential and the catalog). The golden world is a marketplace with three Bid Desks that pass every step. A test changes one thing in a copy
// of it, so each refusal has the golden world as its accepted twin. The hashes are made here, from the bytes that the stub serves.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect } from 'vitest';
import type { Resolution } from '@vsa/id-kit/client';
import { BID_CAPABILITIES, BID_DESK_CLAIM, BID_DESK_MODEL, PRICE_LIST_SCHEMA, priceListSha256 } from '@vsa/usecase-kit/bids';
import { buildBehaviour } from '@vsa/usecase-kit/manifest';
import type { ProtocolResult } from '@vsa/usecase-kit/protocol';
import { BIDDER_FETCH_TIMEOUT_MS, BIDDER_FILE_MAX_BYTES, BIDDER_READ_BUDGET_MS, FACT_READ_TIMEOUT_MS } from '../../src/bidders/types.ts';
import type { AdvertRead, BidderRow, BiddersDeps, CasesAnswer, ComplianceFact, FactState, FetchLimits, FetchedBytes, StakeAnswer } from '../../src/bidders/types.ts';
import { startBudget } from '../../src/bidders/discover.ts';
import type { Budget } from '../../src/bidders/discover.ts';

/** A text that no identifier, date, digest or address takes: it has a space, a slash, a hash sign and a line break. A detail must never repeat it. */
export const MARKER = 'zq9 marker/value#7f3\n';

/** The exact text of a golden file. */
export const goldenText = (name: string): string => readFileSync(new URL(`./golden/${name}`, import.meta.url), 'utf8');
/** A fresh value of a golden JSON file, so that a test can change a member without changing the sample. */
export const golden = (name: string): Record<string, unknown> => JSON.parse(goldenText(name)) as Record<string, unknown>;

/** The value of a result that must have passed. */
export function must<T, C extends string>(result: ProtocolResult<T, C>): T {
  if (!result.ok) throw new Error(`the sample must pass, and it was refused with ${result.code}: ${result.detail}`);
  return result.value;
}

/** The code and the detail of a result that must have failed. */
export function refusal<C extends string>(result: ProtocolResult<unknown, C>): { code: C; detail: string } {
  if (result.ok) throw new Error('the result passed, and the test expected a refusal');
  return { code: result.code, detail: result.detail };
}

export const sha256 = (data: Uint8Array | string): string => createHash('sha256').update(data).digest('hex');
export const bytesOf = (text: string): Uint8Array => new TextEncoder().encode(text);
/** A fetch that answered 200 with this body. */
export const ok = (body: string | Uint8Array): FetchedBytes => ({ status: 200, bytes: typeof body === 'string' ? bytesOf(body) : body });

/** The limits that the reader gives to the fetch of a file. */
export const LIMITS: FetchLimits = { maxBytes: BIDDER_FILE_MAX_BYTES, timeoutMs: BIDDER_FETCH_TIMEOUT_MS };

/** The time of the clock of the stub at the start: 2027-01-15T08:00:00Z. */
export const NOW_MS = 1_800_000_000_000;

export const DESKS = ['alfa', 'bravo', 'charlie'] as const;
export type DeskName = (typeof DESKS)[number];

/** One Bid Desk of the golden world. */
export interface Desk {
  readonly name: DeskName;
  readonly agent: string;
  readonly did: string;
  readonly ref: string;
  readonly pkh: string;
  readonly manifestUrl: string;
  readonly listUrl: string;
}

const AGENTS: Readonly<Record<DeskName, string>> = { alfa: 'a1'.repeat(32), bravo: 'b2'.repeat(32), charlie: 'c3'.repeat(32) };
const REFS: Readonly<Record<DeskName, string>> = { alfa: `${'11'.repeat(32)}#0`, bravo: `${'22'.repeat(32)}#1`, charlie: `${'33'.repeat(32)}#0` };
const PKHS: Readonly<Record<DeskName, string>> = { alfa: 'd4'.repeat(28), bravo: 'e5'.repeat(28), charlie: 'f6'.repeat(28) };
export const STRANGER_ID = '99'.repeat(32);

export const deskOf = (name: DeskName): Desk => ({
  name,
  agent: AGENTS[name],
  did: `did:vector:${AGENTS[name]}`,
  ref: REFS[name],
  pkh: PKHS[name],
  manifestUrl: `https://${name}.example.org/agent.json`,
  listUrl: `https://${name}.example.org/price-list.json`,
});

/** A desk with the index `index`: an agent, a reference, a key hash and hosts of its own, ordered by the index. */
export function extraDesk(index: number): Desk {
  const byte = index.toString(16).padStart(2, '0');
  return {
    ...deskOf('alfa'),
    agent: byte.repeat(32),
    did: `did:vector:${byte.repeat(32)}`,
    ref: `${byte.repeat(32)}#0`,
    pkh: byte.repeat(28),
    manifestUrl: `https://desk-${index}.example.org/agent.json`,
    listUrl: `https://desk-${index}.example.org/price-list.json`,
  };
}

/** The price list of a Bid Desk as its host serves it, with its white space: the hash is the hash of these bytes. Each desk has other prices, so each list has its own hash. */
export function priceListText(name: DeskName): string {
  const shift = DESKS.indexOf(name) * 2;
  const list = {
    schema: PRICE_LIST_SCHEMA,
    items: [
      { sku: 'GLV-NIT-M', lead_time_days: 14 - shift, breaks: [{ min_quantity: 1, unit_price: 140 + shift }, { min_quantity: 100, unit_price: 125 + shift }] },
      { sku: 'MSK-N95', lead_time_days: 21 - shift, breaks: [{ min_quantity: 1, unit_price: 65 + shift }, { min_quantity: 25, unit_price: 60 + shift }, { min_quantity: 1000, unit_price: 47 + shift }] },
    ],
  };
  return `${JSON.stringify(list, null, 2)}\n`;
}

export type Manifest = Record<string, unknown>;

/** The manifest of a Bid Desk of the kit: the members of an agent, and under `behaviour` the additions that the manifest folder builds, with the price list that the argument names. */
export function manifestOf(desk: Desk, priceList: { uri: string; sha256: string } = { uri: desk.listUrl, sha256: priceListSha256(priceListText(desk.name)) }): Manifest {
  const [first, second, third] = BID_DESK_CLAIM.statements;
  const additions = must(buildBehaviour('bid-desk', {
    claim: [first.text, second.text, third.text],
    model: { allowlist: ['deepseek/deepseek-v4-flash'], max_price_lovelace: 200_000 },
    relying_on: { mock_systems: [], gateway_routes: ['POST /token'] },
    price_list: priceList,
  }));
  return {
    schema: 'vector.agent-manifest.v2',
    name: `Bid Desk ${desk.name}`,
    capability_id: BID_CAPABILITIES.quote,
    version: '0.1.0',
    operator: { name: 'Sample operator', contact: 'ops@example.invalid' },
    behaviour: { data_handling: 'The request is held in memory while a job runs.', ...additions },
    gaps: ['The model decides.'],
    links: { spec: 'https://example.invalid/spec' },
  };
}

// --- The facts of a Bid Desk -------------------------------------------------------------------------------------------------------------------------

/** The key hash of the Accountable Party of each desk, and the start of its time of cover. */
export const ACCOUNTABLE: Readonly<Record<DeskName, string>> = { alfa: '1a'.repeat(28), bravo: '2b'.repeat(28), charlie: '3c'.repeat(28) };
export const PARTY_SINCE = '2026-11-01T00:00:00Z';
/** The DID that a retired record names as its successor. */
export const SUCCESSOR = `did:vector:${'5e'.repeat(32)}`;
const STAKES: Readonly<Record<DeskName, bigint>> = { alfa: 5_000_000_000n, bravo: 7_500_000_000n, charlie: 1_000_000n };
const CASES: Readonly<Record<DeskName, number>> = { alfa: 0, bravo: 1, charlie: 3 };
const ATTESTATIONS: Readonly<Record<DeskName, string>> = { alfa: 'c0'.repeat(32), bravo: 'c1'.repeat(32), charlie: 'c2'.repeat(32) };

/** The metadata of the record of an Active Bid Desk: its status and one Accountable Party with a verified organisation. */
export function metadataOf(desk: Desk): Record<string, unknown> {
  return {
    vectorStatus: { status: 'active', effective: 'active' },
    vectorParties: [{ role: 'accountable', signer: ACCOUNTABLE[desk.name], organisation: `${desk.name}.example.org`, organisationVerified: true, rights: ['suspend', 'revoke'], notBefore: PARTY_SINCE }],
  };
}

/** The resolution of a record that exists: the kind `resolved`. */
export function resolvedOf(desk: Desk, metadata: Record<string, unknown> = metadataOf(desk), over: { effectiveStatus?: string; effectiveReason?: string | null } = {}): Resolution {
  return {
    kind: 'resolved',
    did: desk.did,
    effectiveStatus: (over.effectiveStatus ?? 'active') as 'active',
    effectiveReason: over.effectiveReason === undefined ? null : over.effectiveReason,
    keys: [],
    document: {},
    metadata,
  };
}

/** The resolution of a record that ended: the kind `deactivated`. `vectorStatus` holds the members that the gateway adds for the end, and `extra` the other members of the metadata. */
export function deactivatedOf(desk: Desk, status: 'revoked' | 'retired', vectorStatus: Record<string, unknown>, extra: Record<string, unknown> = {}): Resolution {
  return { kind: 'deactivated', did: desk.did, effectiveStatus: status, effectiveReason: null, metadata: { deactivated: true, vectorStatus: { status, effective: status, ...vectorStatus }, ...extra } };
}

/** A record that was retired with a successor. */
export const retiredOf = (desk: Desk): Resolution => deactivatedOf(desk, 'retired', { at: '2027-01-10T09:00:00Z', successor: SUCCESSOR });
/** A record that was revoked, with the time from which its signatures are invalid. */
export const revokedOf = (desk: Desk): Resolution => deactivatedOf(desk, 'revoked', { by: ACCOUNTABLE[desk.name], reason: 'keyCompromise', at: '2027-01-12T10:30:00Z', invalidFrom: '2027-01-11T18:00:00Z' });
/** A record that does not exist at the gateway. */
export const notFoundOf = (desk: Desk): Resolution => ({ kind: 'not_found', did: desk.did });

/** The compliance attestation of a desk when it holds: the newest attestation of the issuer is active. */
export function validCompliance(desk: Desk): ComplianceFact {
  return { state: 'valid', attestation: ATTESTATIONS[desk.name], attestation_state: 'active', issued_at: '2026-11-20T10:00:00Z', valid_until: '2027-05-20T10:00:00Z', revoked_at: null, revoke_reason: null, contested: null };
}

/** The compliance attestation of a desk after the issuer revoked it and the desk replied. */
export function revokedCompliance(desk: Desk): ComplianceFact {
  return { ...validCompliance(desk), state: 'invalid', attestation_state: 'revoked', revoked_at: '2027-01-12T10:00:00Z', revoke_reason: '1', contested: { sha256: 'd0'.repeat(32) } };
}

/** What the world serves and answers. A test changes a member of a copy of the golden world. */
export interface World {
  rows: BidderRow[];
  /** The chain reading of each advert, by the reference that the row names. */
  reads: Record<string, AdvertRead>;
  /** The answer of the fetch for each address, or the error that it throws. */
  files: Record<string, FetchedBytes | Error>;
  /** The DID resolution of each desk, by DID, or the error that the gateway client throws. */
  resolutions: Record<string, Resolution | Error>;
  /** The stake of each desk by agent id, the cases by DID, the compliance fact by DID and the credential state by DID. */
  stakes: Record<string, StakeAnswer | Error>;
  cases: Record<string, CasesAnswer | Error>;
  compliance: Record<string, ComplianceFact | Error>;
  credentials: Record<string, FactState | Error>;
  /** The DIDs of the catalog, or null for a catalog that cannot be read, or the error that its port throws. */
  catalog: ReadonlySet<string> | null | Error;
}

export function rowOf(desk: Desk, over: Partial<BidderRow> = {}): BidderRow {
  return { utxo_ref: desk.ref, capability_id: BID_CAPABILITIES.quote, model: BID_DESK_MODEL, advert_status: 'Active', agent_id: desk.agent, ...over };
}

/** The reading of an advert that the chain shows, and not the `{ error }` of a reference that is no advert. */
export type ShownAdvert = Exclude<AdvertRead, { readonly error: string }>;

export interface AdvertOptions {
  spent?: boolean;
  agentId?: string | null;
  supplier_pkh?: string;
  status?: string;
  capability_id?: string;
  model?: string;
  detail_uri?: string;
  detail_hash?: string;
}

/** The chain reading of the advert of a Bid Desk, with the manifest hash `hash` unless the options say another. */
export function advertOf(desk: Desk, hash: string, over: AdvertOptions = {}): ShownAdvert {
  return {
    spent: over.spent ?? false,
    agentId: over.agentId === undefined ? desk.agent : over.agentId,
    advert: {
      supplier_pkh: over.supplier_pkh ?? desk.pkh,
      status: over.status ?? 'Active',
      capability_id: over.capability_id ?? BID_CAPABILITIES.quote,
      model: over.model ?? BID_DESK_MODEL,
      detail_uri: over.detail_uri ?? desk.manifestUrl,
      detail_hash: over.detail_hash ?? hash,
    },
  };
}

/** The manifest text of a Bid Desk of the golden world. */
export const manifestText = (desk: Desk): string => JSON.stringify(manifestOf(desk));

/** Adds a Bid Desk that passes every step: its row, its advert on the chain, its manifest, its price list and its facts. */
export function addDesk(world: World, desk: Desk, priceList: string = priceListText(desk.name)): void {
  const manifest = JSON.stringify(manifestOf(desk, { uri: desk.listUrl, sha256: priceListSha256(priceList) }));
  world.rows.push(rowOf(desk));
  world.reads[desk.ref] = advertOf(desk, sha256(manifest));
  world.files[desk.manifestUrl] = ok(manifest);
  world.files[desk.listUrl] = ok(priceList);
  world.resolutions[desk.did] = resolvedOf(desk);
  world.stakes[desk.agent] = { ok: true, stake_lovelace: STAKES[desk.name] };
  world.cases[desk.did] = { ok: true, cases: CASES[desk.name] };
  world.compliance[desk.did] = validCompliance(desk);
  world.credentials[desk.did] = 'valid';
}

/** A world with no Bid Desk and a catalog that lists nobody. */
export function emptyWorld(): World {
  return { rows: [], reads: {}, files: {}, resolutions: {}, stakes: {}, cases: {}, compliance: {}, credentials: {}, catalog: new Set<string>() };
}

/** A marketplace with three Bid Desks that pass every step, and a catalog that lists all three. */
export function goldenWorld(): World {
  const world: World = { ...emptyWorld(), catalog: new Set(DESKS.map((name) => deskOf(name).did)) };
  for (const name of DESKS) addDesk(world, deskOf(name));
  return world;
}

/** Serves `body` as the manifest of `desk`, and gives its advert the hash `hash` (the hash of the body unless a test gives another). */
export function serveManifest(world: World, desk: Desk, body: string | Uint8Array, hash: string = sha256(body)): void {
  world.files[desk.manifestUrl] = ok(body);
  world.reads[desk.ref] = advertOf(desk, hash);
}

/** Serves a manifest that `change` edited, with the right hash. `change` gets a new copy of the manifest of the golden world. */
export function changeManifest(world: World, desk: Desk, change: (manifest: Manifest) => void): void {
  const manifest = manifestOf(desk);
  change(manifest);
  serveManifest(world, desk, JSON.stringify(manifest));
}

/** Serves `body` as the price list of `desk`, and serves a manifest that holds its hash (the hash of the body unless a test gives another). */
export function serveList(world: World, desk: Desk, body: string | Uint8Array, hash: string = sha256(body)): void {
  world.files[desk.listUrl] = ok(body);
  serveManifest(world, desk, JSON.stringify(manifestOf(desk, { uri: desk.listUrl, sha256: hash })));
}

/** The text of the price list of `desk` with white space at its end, so that the text has exactly `size` bytes. */
export function paddedList(desk: Desk, size: number): string {
  const trimmed = priceListText(desk.name).trimEnd();
  return `${trimmed}${' '.repeat(size - Buffer.byteLength(trimmed, 'utf8'))}`;
}

/** The text of the manifest of `desk` with a `padding` member in `links`, so that the text has exactly `size` bytes. */
export function paddedManifest(desk: Desk, size: number): string {
  const base = manifestOf(desk);
  base.links = { spec: 'https://example.invalid/spec', padding: '' };
  const empty = Buffer.byteLength(JSON.stringify(base), 'utf8');
  base.links = { spec: 'https://example.invalid/spec', padding: 'p'.repeat(size - empty) };
  return JSON.stringify(base);
}

export interface Calls {
  readonly list: string[];
  readonly read: string[];
  readonly fetch: { readonly url: string; readonly limits: FetchLimits }[];
  readonly catalog: string[];
  readonly resolve: string[];
  readonly stake: string[];
  readonly cases: string[];
  readonly compliance: { readonly did: string; readonly nowMs: number }[];
  readonly credential: string[];
}

/** The ports that the discovery and the price list reader use. */
export type DiscoveryPorts = Pick<BiddersDeps, 'listAdverts' | 'readAdvert' | 'fetchBytes' | 'clock'>;

export interface Stub {
  readonly deps: BiddersDeps;
  readonly calls: Calls;
  /** The clock of the reader. A test moves it. */
  readonly clock: { now: number };
}

/** The answer of a stub for a key, or the error that it throws. A key that the world does not hold is a source that cannot be read. */
function answerOf<T>(table: Record<string, T | Error>, key: string): T {
  const answer = table[key];
  if (answer === undefined) throw new Error('the source has no answer for this key');
  if (answer instanceof Error) throw answer;
  return answer;
}

/** The ports of the reader over `world`, with a record of each call. `over` replaces a port. */
export function stubOf(world: World, over: Partial<BiddersDeps> = {}): Stub {
  const calls: Calls = { list: [], read: [], fetch: [], catalog: [], resolve: [], stake: [], cases: [], compliance: [], credential: [] };
  const clock = { now: NOW_MS };
  const deps: BiddersDeps = {
    listAdverts: async (capabilityId) => {
      calls.list.push(capabilityId);
      return world.rows;
    },
    readAdvert: async (ref) => {
      calls.read.push(ref);
      return answerOf(world.reads, ref);
    },
    fetchBytes: async (url, limits) => {
      calls.fetch.push({ url, limits });
      return answerOf(world.files, url);
    },
    resolve: async (did) => {
      calls.resolve.push(did);
      return answerOf(world.resolutions, did);
    },
    catalog: async () => {
      calls.catalog.push('catalog');
      if (world.catalog instanceof Error) throw world.catalog;
      return world.catalog;
    },
    stake: async (agentId) => {
      calls.stake.push(agentId);
      return answerOf(world.stakes, agentId);
    },
    cases: async (did) => {
      calls.cases.push(did);
      return answerOf(world.cases, did);
    },
    compliance: async (did, nowMs) => {
      calls.compliance.push({ did, nowMs });
      return answerOf(world.compliance, did);
    },
    credential: async (did) => {
      calls.credential.push(did);
      return answerOf(world.credentials, did);
    },
    clock: () => clock.now,
    ...over,
  };
  return { deps, calls, clock };
}

/** The budget of one read, as `readBidders` starts it. */
export function budgetOf(stub: Stub): Budget {
  const budget = startBudget(stub.deps.clock, BIDDER_READ_BUDGET_MS, FACT_READ_TIMEOUT_MS);
  if (budget === null) throw new Error('the clock of the stub gives a time');
  return budget;
}

/** A detail that names `where` and holds no part of the marker, no address and no reference. */
export function expectNames(detail: string, where: string): void {
  expect(detail).toContain(where);
  for (const text of ['zq9', 'marker', 'https://', 'http://', '.example.org', '1111111111', '2222222222']) expect(detail).not.toContain(text);
}
