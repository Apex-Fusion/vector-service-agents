// agents/order-desk/src/serve/manifest.ts
// The manifest of the Order Desk (`vector.agent-manifest.v2`), and its template. The service renders the manifest once when it starts and serves those bytes at `GET /agent.json`. The three adverts hold the
// SHA-256 of the same bytes, so the manifest is one file for the three runtimes and its hash is one value.
//
// The three tiers. The Order Desk has one advert for each lot: the `model` of the advert is the lot name. `terms.tiers` holds one entry for each of them: the price, both bonds, the window, the supplier key hash
// and public key of the runtime of that tier, and its endpoint. `identity.supplier_key` is the key of the first (small) runtime, as the record of the agent lists it. The lock of an advert is its price and both
// bonds: 4, 7 and 12 million lovelace.
//
// The fault switch never reaches the manifest. The builder takes the settings of the operator and never FAULT_MODE, `renderManifest` of the kit renders it for every setting of the fault switch and refuses a
// manifest whose bytes change, and the kit gives the one gap sentence that names the possible values. The active value is in each result only.
import { given, requiredEnv, shown, statusChip, statusSince } from '@vsa/service-kit';
import type { StatusChip } from '@vsa/service-kit';
import { parseMaxPrice, parseModelAllowlist } from '@vsa/usecase-kit/decision';
import { CONFIRMATION_CHECKS, INVENTORY_CAPABILITIES, LOT_NAMES, ORDER_DESK_CLAIM } from '@vsa/usecase-kit/inventory';
import type { LotName } from '@vsa/usecase-kit/inventory';
import { buildBehaviour, renderManifest } from '@vsa/usecase-kit/manifest';
import { MAX_REQUEST_BYTES } from '@vsa/usecase-kit/protocol';
import type { BehaviourAdditions } from '@vsa/usecase-kit/protocol';
import { identityRegistryOf, manifestDid, manifestIdentity } from '@vsa/vector-read';
import { loadLots } from '../checks/index.ts';
import type { LoadedLots } from '../checks/index.ts';
import { GAPS } from './gaps.ts';
import { LOTS_FILE, LOTS_ROUTE, endpointsOf, processingWindowOf } from './settings.ts';

const SPEC_URL = 'https://github.com/Apex-Fusion/vector-service-agents/blob/main/specs/order-desk.md';
const SOURCE_URL = 'https://github.com/Apex-Fusion/vector-service-agents/tree/main/agents/order-desk';

/** The price of each lot in lovelace. It stands for the size of the order on the ledger, and it is not the value of the goods. */
export const LOT_PRICE_LOVELACE = { 'lot-small': 2_000_000, 'lot-medium': 5_000_000, 'lot-large': 10_000_000 } as const satisfies Record<LotName, number>;
/** The supplier bond and the buyer bond of each advert, in lovelace. */
export const BOND_LOVELACE = 1_000_000;

const DESCRIPTION =
  "For a supplier: takes a purchase order for one lot from a buyer's agent, checks who sent it and that the buyer approved exactly this order, and, if the lot can be supplied, places it in the supplier's system and confirms it.";

const DATA_HANDLING =
  'The purchase order, the approval reference and the catalogue entry are held in memory while a job runs, and none of them is kept after the job. '
  + 'The service writes to its state directory the bookkeeping of the escrows that it posts for its model call, the order book (the tenant, the purchase order number and the order id of each order that it placed) '
  + 'and the journal of its challenges. On a digest mismatch it publishes an evidence document and a challenge on the ledger. '
  + 'The log carries job outcomes, counts and codes, never a request, a catalogue entry or a key.';

const THIRD_PARTIES = [
  'the identity gateway (the resolution of the DID of the sender, and the request for the X.509-SVID)',
  'the ledger, read only (the delegation, the escrow paid from a vault, the approval attestation)',
  'the supplier portal of the mock service (the catalogue read and the order, with the X.509-SVID)',
  'a model supplier on the Vector marketplace, hired through a bonded escrow, and the model provider behind it (the prompt of the decision: the purchase order and the catalogue entry)',
  'the ledger, written only after a digest mismatch (the evidence document and the challenge)',
];

const NOTES = [
  'The request is the handoff of use case 1 (inventory reorder): its use case is inventory-reorder, and its document is a purchase order. A handoff for another use case, and a document that is not a purchase order, are refused with bad_shape (400).',
  `Before the runtime claims the escrow, the service makes ${CONFIRMATION_CHECKS.length} checks: the sender, the delegation, the payment from a vault, the approval, and then the supplier, the lot, the quantity and the number of the purchase order. `
  + 'A check that fails is a refusal with its code (403), and the escrow stays open. A source that cannot be read is 503 check_unavailable.',
  'The advert that the escrow was posted on gives the lot: its model is lot-small, lot-medium or lot-large. The quantity of the order must be the size of that lot for the SKU in the lots file.',
  'The lots file is served at /lots.json, and its SHA-256 is in behaviour.lots. One manifest serves the three adverts, so the three adverts hold one manifest hash.',
  'After the Claim, the model decides whether the lot can be supplied. A decision of no is a refusal with the code cannot_supply (403), and no order is placed.',
];

/** A value that stands for itself in the template: the whole text is a name in angle brackets. */
const PLACEHOLDER = /^<[A-Z][A-Z0-9_]*>$/;

/**
 * The identity block of the manifest, which vector-read builds the same way for every agent of this repository: the DID in its canonical form, the address of the identity registry of IDENTITY_POLICY_ID and
 * IDENTITY_ADDRESS, and the listed supplier key `<DID>#<key hash>`, which is the key of the small runtime. A value that breaks a rule throws, and the message never repeats a value that is hex-shaped or long.
 */
function identityFromEnv(env: NodeJS.ProcessEnv) {
  const values = [env.AGENT_DID, env.IDENTITY_POLICY_ID, env.IDENTITY_ADDRESS].map(given);
  try {
    return manifestIdentity(manifestDid(env.AGENT_DID), given(env.SMALL_SUPPLIER_PKH), identityRegistryOf(env.IDENTITY_POLICY_ID, env.IDENTITY_ADDRESS));
  } catch (error) {
    let text = (error as Error).message;
    for (const value of values) if (value !== '' && shown(value) !== JSON.stringify(value)) text = text.replaceAll(`"${value}"`, shown(value)).replaceAll(value, `(${shown(value)})`);
    throw new Error(text.startsWith('environment variable ') ? text : `environment variable ${text}`);
  }
}

/** The endpoint of each tier and the address of the lots file: derived from LOTS_PUBLIC_ORIGIN, or, in the template, named by placeholders. */
function hostsFromEnv(env: NodeJS.ProcessEnv): { readonly endpoints: Readonly<Record<LotName, string>>; readonly lotsUri: string } {
  const origin = requiredEnv('LOTS_PUBLIC_ORIGIN', env.LOTS_PUBLIC_ORIGIN, 'the https origin of the host of the first (small) runtime, which serves the lots file');
  if (PLACEHOLDER.test(origin)) {
    return { endpoints: Object.fromEntries(LOT_NAMES.map((lot) => [lot, `<${lot.slice('lot-'.length).toUpperCase()}_ENDPOINT>`])) as Record<LotName, string>, lotsUri: '<LOTS_URI>' };
  }
  const endpoints = endpointsOf(origin);
  return { endpoints, lotsUri: `${endpoints['lot-small']}${LOTS_ROUTE}` };
}

/** One tier of `terms`: the advert of one lot. */
export interface ManifestTier {
  readonly model: LotName;
  readonly price_lovelace: number;
  readonly supplier_bond_lovelace: number;
  readonly buyer_bond_lovelace: number;
  readonly max_processing_ms: number;
  readonly supplier_pkh: string;
  readonly pub_key_hex: string;
  readonly endpoint: string;
}

/** The manifest of the Order Desk: the members of the manifest v2 that this agent writes, and under `behaviour` the additions of the kit. */
export interface OrderDeskManifest {
  readonly schema: 'vector.agent-manifest.v2';
  readonly name: 'Order Desk';
  readonly capability_id: string;
  readonly version: string;
  readonly description: string;
  readonly operator: { readonly name: string; readonly contact: string };
  readonly identity: { readonly did: string; readonly registry_address: string; readonly supplier_key: string };
  /** The key hash of the service key. The keys of the runtimes are in `terms.tiers`. */
  readonly keys: { readonly service_pkh: string };
  readonly interface: {
    readonly request_schema: { readonly $ref: string };
    readonly response_schema: { readonly $ref: string };
    readonly routes: Readonly<Record<string, string>>;
    readonly notes: readonly string[];
  };
  readonly terms: { readonly tiers: readonly ManifestTier[]; readonly input_limits: { readonly request_bytes: number } };
  readonly behaviour: { readonly data_handling: string; readonly third_parties: readonly string[] } & BehaviourAdditions<'order-desk'>;
  readonly status: { readonly chip: StatusChip; readonly since: string };
  readonly gaps: readonly string[];
  readonly links: { readonly spec: string; readonly source: string; readonly explorer_advert: string };
}

/**
 * The manifest from the settings of the operator. It reads the public settings only: the contact, the DID, the identity registry, the keys of the three runtimes, the key hash of the service key, the origin
 * of the first runtime, the window, the model limits, the version, the status and the link to the advert. `lots` is the lots file as the service reads it: its hash is the hash that the manifest holds. A value
 * that is a name in angle brackets stands for itself, so the same function makes the template (TEMPLATE_ENV); `renderManifest` refuses a served manifest that has one.
 */
export function manifestFromEnv(env: NodeJS.ProcessEnv = process.env, lots: Pick<LoadedLots, 'sha256'> = loadLots(LOTS_FILE)): OrderDeskManifest {
  const hosts = hostsFromEnv(env);
  const template = PLACEHOLDER.test(given(env.LOTS_PUBLIC_ORIGIN));
  const window = processingWindowOf(env);
  const allowlist = parseModelAllowlist(requiredEnv('LLM_MODEL_ALLOWLIST', env.LLM_MODEL_ALLOWLIST, 'the models that the service may hire for its decision'));
  if (!allowlist.ok) throw new Error(`environment variable ${allowlist.detail}`);
  const price = parseMaxPrice(requiredEnv('LLM_MAX_PRICE_LOVELACE', env.LLM_MAX_PRICE_LOVELACE, 'the most that a model hire may be priced at, in lovelace'));
  if (!price.ok) throw new Error(`environment variable ${price.detail}`);
  const keys = {
    'lot-small': { supplier_pkh: given(env.SMALL_SUPPLIER_PKH), pub_key_hex: given(env.SMALL_SUPPLIER_PUB_KEY_HEX) },
    'lot-medium': { supplier_pkh: given(env.MEDIUM_SUPPLIER_PKH), pub_key_hex: given(env.MEDIUM_SUPPLIER_PUB_KEY_HEX) },
    'lot-large': { supplier_pkh: given(env.LARGE_SUPPLIER_PKH), pub_key_hex: given(env.LARGE_SUPPLIER_PUB_KEY_HEX) },
  } as const satisfies Record<LotName, { supplier_pkh: string; pub_key_hex: string }>;
  const [first, second, third] = ORDER_DESK_CLAIM.statements;
  const additions = buildBehaviour('order-desk', {
    claim: [first.text, second.text, third.text],
    model: { allowlist: allowlist.value, max_price_lovelace: Number(price.value) },
    relying_on: {
      mock_systems: ['GET /t/{tenant}/supplier/catalogue/{sku}', 'POST /t/{tenant}/supplier/orders'],
      gateway_routes: ['POST /spiffe/nonce', 'POST /spiffe/x509-svid', 'GET /1.0/identifiers/{did}'],
    },
    lots: { uri: hosts.lotsUri, sha256: lots.sha256 },
  }, { template });
  if (!additions.ok) throw new Error(`the behaviour of the manifest is refused: ${additions.detail}`);
  return {
    schema: 'vector.agent-manifest.v2',
    name: 'Order Desk',
    capability_id: INVENTORY_CAPABILITIES.order,
    version: given(env.AGENT_VERSION) || '0.1.0',
    description: DESCRIPTION,
    operator: { name: 'Apex Fusion Foundation', contact: requiredEnv('OPERATOR_CONTACT', env.OPERATOR_CONTACT, "the operator's contact address, published in the manifest") },
    identity: identityFromEnv(env),
    keys: { service_pkh: given(env.ORDER_DESK_SERVICE_PKH) },
    interface: {
      request_schema: { $ref: `${SPEC_URL}#request` },
      response_schema: { $ref: `${SPEC_URL}#response` },
      routes: { job: '/v1/job', status: '/status', capability: '/capability', lots: LOTS_ROUTE },
      notes: [...NOTES],
    },
    terms: {
      tiers: LOT_NAMES.map((lot) => ({
        model: lot,
        price_lovelace: LOT_PRICE_LOVELACE[lot],
        supplier_bond_lovelace: BOND_LOVELACE,
        buyer_bond_lovelace: BOND_LOVELACE,
        max_processing_ms: window,
        supplier_pkh: keys[lot].supplier_pkh,
        pub_key_hex: keys[lot].pub_key_hex,
        endpoint: hosts.endpoints[lot],
      })),
      input_limits: { request_bytes: MAX_REQUEST_BYTES },
    },
    behaviour: { data_handling: DATA_HANDLING, third_parties: [...THIRD_PARTIES], ...additions.value },
    // Absent or empty is `proposed` since the day the service was built. The operator sets a word above it, by AGENT_STATUS_CHIP, once it is true.
    status: { chip: statusChip(env.AGENT_STATUS_CHIP, 'proposed'), since: statusSince(env.AGENT_STATUS_SINCE, '2026-11-23') },
    gaps: [...GAPS],
    links: { spec: SPEC_URL, source: SOURCE_URL, explorer_advert: given(env.ADVERT_EXPLORER_URL) },
  };
}

/**
 * The settings that stand as placeholders in the template: the values that the operator gives. The endpoints of the three tiers and the address of the lots file are derived from LOTS_PUBLIC_ORIGIN, so the
 * template names them `<SMALL_ENDPOINT>`, `<MEDIUM_ENDPOINT>`, `<LARGE_ENDPOINT>` and `<LOTS_URI>`. The two model settings have the values of the example environment, because the template has no placeholder for
 * a model name.
 */
export const TEMPLATE_ENV = {
  OPERATOR_CONTACT: '<OPERATOR_CONTACT>',
  AGENT_DID: '<AGENT_DID>',
  SMALL_SUPPLIER_PKH: '<SMALL_SUPPLIER_PKH>',
  SMALL_SUPPLIER_PUB_KEY_HEX: '<SMALL_SUPPLIER_PUB_KEY_HEX>',
  MEDIUM_SUPPLIER_PKH: '<MEDIUM_SUPPLIER_PKH>',
  MEDIUM_SUPPLIER_PUB_KEY_HEX: '<MEDIUM_SUPPLIER_PUB_KEY_HEX>',
  LARGE_SUPPLIER_PKH: '<LARGE_SUPPLIER_PKH>',
  LARGE_SUPPLIER_PUB_KEY_HEX: '<LARGE_SUPPLIER_PUB_KEY_HEX>',
  ORDER_DESK_SERVICE_PKH: '<ORDER_DESK_SERVICE_PKH>',
  LOTS_PUBLIC_ORIGIN: '<LOTS_PUBLIC_ORIGIN>',
  LLM_MODEL_ALLOWLIST: 'deepseek/deepseek-v4-flash',
  LLM_MAX_PRICE_LOVELACE: '1000000',
} as const;

/** The text of agent.json.template: the manifest with the placeholders, indented, with a line break at the end. `pnpm --filter @vsa/order-desk template` writes it. It is never served. */
export function renderTemplate(): string {
  const lots = loadLots(LOTS_FILE);
  const rendered = renderManifest('order-desk', () => manifestFromEnv(TEMPLATE_ENV, lots), { template: true });
  if (!rendered.ok) throw new Error(`the template is refused (${rendered.code}): ${rendered.detail}`);
  return rendered.value.text;
}
