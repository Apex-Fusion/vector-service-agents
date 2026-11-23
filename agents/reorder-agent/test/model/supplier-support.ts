// agents/reorder-agent/test/model/supplier-support.ts
// The stub ports of the reader of the supplier, and the world that they serve: the rows of the indexer, the adverts on the chain, and the two files of the Order Desk. The golden world is a supplier
// that passes every step. A test changes one thing in a copy of it, so each refusal has the golden world as its accepted twin. The hashes are made here, from the bytes that the stub serves.
import { createHash } from 'node:crypto';
import { INVENTORY_CAPABILITIES, LOT_NAMES, ORDER_DESK_CLAIM, lotsFileSha256 } from '@vsa/usecase-kit/inventory';
import type { LotName } from '@vsa/usecase-kit/inventory';
import { buildBehaviour } from '@vsa/usecase-kit/manifest';
import type { AdvertRead, FetchLimits, FetchedBytes, SupplierDeps, SupplierRow } from '../../src/model/index.ts';
import { goldenText, must } from './support.ts';

export const AGENT_ID = 'a1'.repeat(32);
export const SUPPLIER = `did:vector:${AGENT_ID}`;
export const STRANGER_ID = 'b2'.repeat(32);
export const CAPABILITY = INVENTORY_CAPABILITIES.order;
export const SKU = 'GLV-NIT-M';
export const REFS: Readonly<Record<LotName, string>> = {
  'lot-small': `${'11'.repeat(32)}#0`,
  'lot-medium': `${'22'.repeat(32)}#1`,
  'lot-large': `${'33'.repeat(32)}#2`,
};
export const MANIFEST_URL = 'https://order-desk.example/agent.json';
export const LOTS_URL = 'https://order-desk.example/lots.json';
export const S1 = ORDER_DESK_CLAIM.statements[0].text;

/** The most bytes that the reader takes of a file, and the time that it gives to one fetch. */
export const LIMITS: FetchLimits = { maxBytes: 262_144, timeoutMs: 10_000 };

export const sha256 = (data: Uint8Array | string): string => createHash('sha256').update(data).digest('hex');
export const bytesOf = (text: string): Uint8Array => new TextEncoder().encode(text);
/** A fetch that answered 200 with this body. */
export const ok = (body: string | Uint8Array): FetchedBytes => ({ status: 200, bytes: typeof body === 'string' ? bytesOf(body) : body });

/** The lots file of the Order Desk as its golden file holds it, and its hash. The file is served as these bytes. */
export const LOTS_TEXT = goldenText('lots.json');
export const LOTS_SHA = lotsFileSha256(LOTS_TEXT);

export type Manifest = Record<string, unknown>;

/** The manifest of the Order Desk of the kit: the members of the agent, and under `behaviour` the additions that the manifest folder builds. */
export function manifestOf(lots: { uri: string; sha256: string } = { uri: LOTS_URL, sha256: LOTS_SHA }): Manifest {
  const [first, second, third] = ORDER_DESK_CLAIM.statements;
  const additions = must(buildBehaviour('order-desk', {
    claim: [first.text, second.text, third.text],
    model: { allowlist: ['deepseek/deepseek-v4-flash'], max_price_lovelace: 200_000 },
    relying_on: { mock_systems: ['GET /portal/catalogue/{sku}', 'POST /portal/orders'], gateway_routes: ['POST /token'] },
    lots,
  }));
  return {
    schema: 'vector.agent-manifest.v2',
    name: 'Order Desk',
    capability_id: CAPABILITY,
    version: '0.1.0',
    operator: { name: 'Sample operator', contact: 'ops@example.invalid' },
    behaviour: { data_handling: 'The request is held in memory while a job runs.', ...additions },
    gaps: ['The model decides.'],
    links: { spec: 'https://example.invalid/spec' },
  };
}

/** What the world serves and answers. A test changes a member of a copy of the golden world. */
export interface World {
  rows: SupplierRow[];
  /** The chain reading of each advert, by the reference that the row names. */
  reads: Record<string, AdvertRead>;
  /** The answer of the fetch for each address, or the error that it throws. */
  files: Record<string, FetchedBytes | Error>;
}

export function rowOf(lot: LotName, over: Partial<SupplierRow> = {}): SupplierRow {
  return { utxo_ref: REFS[lot], capability_id: CAPABILITY, model: lot, advert_status: 'Active', agent_id: AGENT_ID, ...over };
}

/** The reading of an advert that the chain shows, and not the `{ error }` of a reference that is no advert. */
export type ShownAdvert = Exclude<AdvertRead, { readonly error: string }>;

export interface AdvertOptions {
  spent?: boolean;
  agentId?: string | null;
  status?: string;
  capability_id?: string;
  model?: string;
  detail_uri?: string;
  detail_hash?: string;
}

/** The chain reading of an identity advert of the Order Desk for `lot`, with the manifest hash `hash` unless the options say another. */
export function advertOf(lot: LotName, hash: string, over: AdvertOptions = {}): ShownAdvert {
  return {
    spent: over.spent ?? false,
    agentId: over.agentId === undefined ? AGENT_ID : over.agentId,
    advert: {
      status: over.status ?? 'Active',
      capability_id: over.capability_id ?? CAPABILITY,
      model: over.model ?? lot,
      detail_uri: over.detail_uri ?? MANIFEST_URL,
      detail_hash: over.detail_hash ?? hash,
    },
  };
}

/** A supplier that passes every step: three Active adverts that hold one manifest hash, the manifest, and the lots file. */
export function goldenWorld(): World {
  const manifest = JSON.stringify(manifestOf());
  const hash = sha256(manifest);
  return {
    rows: LOT_NAMES.map((lot) => rowOf(lot)),
    reads: Object.fromEntries(LOT_NAMES.map((lot) => [REFS[lot], advertOf(lot, hash)])),
    files: { [MANIFEST_URL]: ok(manifest), [LOTS_URL]: ok(LOTS_TEXT) },
  };
}

/** Serves `body` as the manifest, and gives each of the three adverts the hash `hash` (the hash of the body unless a test gives another). Call it before a change of one advert. */
export function serveManifest(world: World, body: string | Uint8Array, hash: string = sha256(body)): void {
  world.files[MANIFEST_URL] = ok(body);
  for (const lot of LOT_NAMES) world.reads[REFS[lot]] = advertOf(lot, hash);
}

/** Serves a manifest that `change` edited, with the right hash. `change` gets a new copy of the manifest of the golden world. */
export function changeManifest(world: World, change: (manifest: Manifest) => void): void {
  const manifest = manifestOf();
  change(manifest);
  serveManifest(world, JSON.stringify(manifest));
}

/** Serves `body` as the lots file, and serves a manifest that holds its hash (the hash of the body unless a test gives another). */
export function serveLots(world: World, body: string | Uint8Array, hash: string = typeof body === 'string' ? lotsFileSha256(body) : sha256(body)): void {
  world.files[LOTS_URL] = ok(body);
  serveManifest(world, JSON.stringify(manifestOf({ uri: LOTS_URL, sha256: hash })));
}

export interface Calls {
  readonly list: string[];
  readonly read: string[];
  readonly fetch: { readonly url: string; readonly limits: FetchLimits }[];
}

export interface Stub {
  readonly deps: SupplierDeps;
  readonly calls: Calls;
  /** The clock of the reader. A test moves it. */
  readonly clock: { now: number };
}

/** The ports of the reader over `world`, with a record of each call. `over` replaces a port. */
export function stubOf(world: World, over: Partial<SupplierDeps> = {}): Stub {
  const calls: Calls = { list: [], read: [], fetch: [] };
  const clock = { now: 1_800_000_000_000 };
  const deps: SupplierDeps = {
    listAdverts: async (capabilityId) => {
      calls.list.push(capabilityId);
      return world.rows;
    },
    readAdvert: async (ref) => {
      calls.read.push(ref);
      const read = world.reads[ref];
      if (read === undefined) throw new Error('the chain has no advert at this reference');
      return read;
    },
    fetchBytes: async (url, limits) => {
      calls.fetch.push({ url, limits });
      const file = world.files[url];
      if (file === undefined) throw new Error('the host has no file at this address');
      if (file instanceof Error) throw file;
      return file;
    },
    clock: () => clock.now,
    ...over,
  };
  return { deps, calls, clock };
}
