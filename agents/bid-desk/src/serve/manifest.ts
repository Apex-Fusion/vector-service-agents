// agents/bid-desk/src/serve/manifest.ts
// The manifest of a Bid Desk (`vector.agent-manifest.v2`), and its template. The service renders the manifest once when it starts and serves those bytes at `GET /agent.json`. The advert holds the SHA-256 of
// the same bytes.
//
// One manifest for each instance. The three Bid Desks run one code base, and each has its own record, its own advert and its own manifest: the name of the instance, the address of its price list and the SHA-256
// of the file of its instance. So the three manifests have three hashes. The price list is served at `<origin>/price-list.json`, and the manifest names that address and holds the hash of the bytes. The builder
// checks that the hash is the hash of the file of the instance that the settings name, so that the manifest of one instance never holds the hash of the list of another.
//
// The fault switch never reaches the manifest. The builder takes the settings of the operator and never FAULT_MODE, `renderManifest` of the kit renders it for every setting of the fault switch and refuses a
// manifest whose bytes change, and the kit gives the one gap sentence that names the possible values. The active value is in each result only.
//
// No controller. A Bid Desk reads, stores and checks no controller of its own record. The manifest holds its DID, the address of the identity registry and the supplier key, and no member names a controller, so the
// manifest and the advert that holds its hash stay the same when the controller of the record changes.
import { readFileSync } from 'node:fs';
import { given, hexOf, requiredEnv, shown, statusChip, statusSince } from '@vsa/service-kit';
import type { StatusChip } from '@vsa/service-kit';
import { BID_CAPABILITIES, BID_DESK_CLAIM, MAX_ITEM_QUANTITY, MAX_RFQ_ITEMS, priceListSha256 } from '@vsa/usecase-kit/bids';
import { parseMaxPrice, parseModelAllowlist } from '@vsa/usecase-kit/decision';
import { buildBehaviour, renderManifest } from '@vsa/usecase-kit/manifest';
import { MAX_REQUEST_BYTES, RFQ_SCHEMA } from '@vsa/usecase-kit/protocol';
import type { BehaviourAdditions } from '@vsa/usecase-kit/protocol';
import { identityRegistryOf, manifestIdentity } from '@vsa/vector-read';
import { GAPS } from './gaps.ts';
import { keyClashOf } from './keys.ts';
import { BOND_LOVELACE, INSTANCE_NAMES, PRICE_LIST_ROUTE, PRICE_LOVELACE, agentDidOf, instanceOf, priceListFileOf, processingWindowOf, publicOriginOf, supplierKeyOf } from './settings.ts';
import type { Instance } from './settings.ts';

export const SPEC_URL = 'https://github.com/Apex-Fusion/vector-service-agents/blob/main/specs/bid-desk.md';
export const SOURCE_URL = 'https://github.com/Apex-Fusion/vector-service-agents/tree/main/agents/bid-desk';

const DESCRIPTION =
  "For a supplier: takes a request for quotation from a buyer's agent, checks who sent it, prices it from the supplier's published price list and returns a quote. The signed receipt of the job is the signed quote.";

const DATA_HANDLING =
  'The request for quotation and the price list are synthetic data, and they are held in memory while a job runs. '
  + 'The service writes to its state directory the bookkeeping of the escrows that it posts for its model call and the book of the requests that it answered (the sender, the request identifier and the hash of the quote of each). '
  + 'The log carries job outcomes, counts and codes, never a request, a quote, a credential or a key.';

const THIRD_PARTIES = [
  'the identity gateway (the resolution of the DID of the sender, and the request for the credential of this agent)',
  'the ledger, read only (the delegation and the escrow paid from a vault)',
  'a model supplier on the Vector marketplace, hired through a bonded escrow, and the model provider behind it (the prompt of the decision: the request for quotation and the price list)',
];

/** The routes of the identity gateway that the service calls: the resolution of the DID of the sender, and the credential of the desk. It calls no mock system. */
const GATEWAY_ROUTES = ['GET /1.0/identifiers/{did}', 'GET /agents/{id}/credential'];

const NOTES = [
  `The request is the message of use case 3 (supplier bid evaluation): its schema is ${RFQ_SCHEMA}, and it holds the DID of the sender, the delegation and a request for quotation of 1 to ${MAX_RFQ_ITEMS} items. `
  + 'A request that breaks a rule of the intake is refused with bad_shape (400).',
  'Before the runtime claims the escrow, the service checks the sender, the delegation, the payment from a vault, and that it quoted no request with this identifier for this sender. '
  + 'A check that fails is a refusal with its code (403), and the escrow stays open. A source that cannot be read is 503 check_unavailable. The service takes no approval.',
  'After the Claim, one model call prices the request from the price list. The service checks that each line is an item of the request, and it makes the line totals, the total and the longest lead time.',
  `The price list is served at ${PRICE_LIST_ROUTE}, and its SHA-256 is in behaviour.price_list. Each Bid Desk has its own price list, so each has its own manifest hash.`,
  'The quote names the hash of the request and the hash of the price list, and it holds the credential of the desk. The signed receipt of the job is the signed quote.',
];

const DID_PATTERN = '^did:vector:[0-9a-f]{64}$';
const HEX_PATTERN = '^[0-9a-f]{64}$';
const ID_PATTERN = '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$';
const DATE_PATTERN = '^[0-9]{4}-[0-9]{2}-[0-9]{2}$';
const ITEM_SCHEMA = {
  type: 'object',
  required: ['sku', 'quantity'],
  additionalProperties: false,
  properties: {
    sku: { type: 'string', pattern: ID_PATTERN, description: 'The SKU: 1 to 64 characters, letters, digits, dots, hyphens and underscores, starting with a letter or a digit' },
    quantity: { type: 'integer', minimum: 1, maximum: MAX_ITEM_QUANTITY, description: `The quantity that the buyer wants: a whole number from 1 to ${MAX_ITEM_QUANTITY}` },
  },
} as const;

/** What the intake accepts, as a JSON Schema: the message of the kit and its request for quotation, with no member that is not listed. */
export const REQUEST_SCHEMA = {
  type: 'object',
  required: ['schema', 'sender_did', 'delegation', 'rfq'],
  additionalProperties: false,
  properties: {
    schema: { const: RFQ_SCHEMA },
    sender_did: { type: 'string', pattern: DID_PATTERN, description: "The DID of the buyer's agent that sends the request" },
    delegation: { type: 'string', pattern: HEX_PATTERN, description: 'The identifier of the delegation that names the sender as its delegate and paid for the job' },
    rfq: {
      type: 'object',
      required: ['rfq_id', 'items', 'needed_by'],
      additionalProperties: false,
      properties: {
        rfq_id: { type: 'string', pattern: ID_PATTERN, description: 'The identifier of the request: 1 to 64 characters, letters, digits, dots, hyphens and underscores, starting with a letter or a digit' },
        items: { type: 'array', minItems: 1, maxItems: MAX_RFQ_ITEMS, items: ITEM_SCHEMA, description: `The items to quote: 1 to ${MAX_RFQ_ITEMS}, and each SKU once` },
        needed_by: { type: 'string', pattern: DATE_PATTERN, description: 'The date by which the goods are needed, as YYYY-MM-DD, a date that exists' },
      },
    },
  },
} as const;

/** A value that stands for itself in the template: the whole text is a name in angle brackets. */
const PLACEHOLDER = /^<[A-Z][A-Z0-9_]*>$/;
const stands = (value: string | undefined): boolean => PLACEHOLDER.test(given(value));

/**
 * The identity registry of IDENTITY_POLICY_ID and IDENTITY_ADDRESS, which vector-read builds the same way for every agent of this repository: the address of the registry that holds the records. A value that breaks
 * a rule throws, and the message never repeats a value that is hex-shaped or long.
 */
function registryOf(env: NodeJS.ProcessEnv) {
  const values = [env.IDENTITY_POLICY_ID, env.IDENTITY_ADDRESS].map(given);
  try {
    return identityRegistryOf(env.IDENTITY_POLICY_ID, env.IDENTITY_ADDRESS);
  } catch (error) {
    let text = (error as Error).message;
    for (const value of values) if (value !== '' && shown(value) !== JSON.stringify(value)) text = text.replaceAll(`"${value}"`, shown(value)).replaceAll(value, `(${shown(value)})`);
    throw new Error(text.startsWith('environment variable ') ? text : `environment variable ${text}`);
  }
}

/** What the manifest takes of the price list that the service serves: the SHA-256 of its bytes, which is the hash of the file of the instance. */
export interface ServedPriceList {
  readonly sha256: string;
}

/** The manifest of a Bid Desk: the members of the manifest v2 that this agent writes, and under `behaviour` the additions of the kit. */
export interface BidDeskManifest {
  readonly schema: 'vector.agent-manifest.v2';
  readonly name: string;
  readonly capability_id: string;
  readonly version: string;
  readonly description: string;
  readonly operator: { readonly name: string; readonly contact: string };
  readonly identity: { readonly did: string; readonly registry_address: string; readonly supplier_key: string };
  /** The key hash and the public key of the supplier key, and the key hash of the service key. */
  readonly keys: { readonly supplier_pkh: string; readonly pub_key_hex: string; readonly service_pkh: string };
  readonly interface: {
    readonly request_schema: typeof REQUEST_SCHEMA;
    readonly response_schema: { readonly $ref: string };
    readonly routes: Readonly<Record<string, string>>;
    readonly notes: readonly string[];
  };
  readonly terms: {
    readonly price_lovelace: number;
    readonly supplier_bond_lovelace: number;
    readonly buyer_bond_lovelace: number;
    readonly max_processing_ms: number;
    readonly input_limits: { readonly request_bytes: number };
  };
  readonly behaviour: { readonly data_handling: string; readonly third_parties: readonly string[] } & BehaviourAdditions<'bid-desk'>;
  readonly status: { readonly chip: StatusChip; readonly since: string };
  readonly gaps: readonly string[];
  readonly links: { readonly spec: string; readonly source: string; readonly explorer_advert: string };
}

/** The SHA-256 of the price list file of an instance: the hash of the bytes that the service serves for it. */
function hashOfFile(instance: Instance): string {
  return priceListSha256(readFileSync(priceListFileOf(instance), 'utf8'));
}

/**
 * The manifest from the settings of the operator and the price list that the service serves. It reads the public settings only: the contact, the DID, the identity registry, the supplier key, the key hash of the
 * service key, the instance, the origin of the host, the window, the model limits, the version, the status and the link to the advert. `priceList` holds the hash that the manifest names, and a served manifest
 * takes only the hash of the file of its own instance. A value that is a name in angle brackets stands for itself, so the same function makes the template (TEMPLATE_ENV); `renderManifest` refuses a served
 * manifest that has one. Any other value of the DID, of the supplier key and of the key hash of the service key must be of the form that its reader takes, so that a key in the wrong line of the environment is
 * refused here and never published. The key hash of the service is not the key hash of the supplier.
 */
export function manifestFromEnv(env: NodeJS.ProcessEnv, priceList: ServedPriceList): BidDeskManifest {
  const template = stands(env.BID_DESK_PUBLIC_ORIGIN);
  // The template names the instance by a placeholder. A served manifest names one of the three instances, and any other value stops here.
  const instance = template && stands(env.BID_DESK_INSTANCE) ? null : instanceOf(env);
  const name = instance === null ? '<BID_DESK_NAME>' : INSTANCE_NAMES[instance];
  const window = processingWindowOf(env);
  const allowlist = parseModelAllowlist(requiredEnv('LLM_MODEL_ALLOWLIST', env.LLM_MODEL_ALLOWLIST, 'the models that the service may hire for its decision'));
  if (!allowlist.ok) throw new Error(`environment variable ${allowlist.detail}`);
  const price = parseMaxPrice(requiredEnv('LLM_MAX_PRICE_LOVELACE', env.LLM_MAX_PRICE_LOVELACE, 'the most that a model hire may be priced at, in lovelace'));
  if (!price.ok) throw new Error(`environment variable ${price.detail}`);
  const did = stands(env.AGENT_DID) ? given(env.AGENT_DID) : agentDidOf(env);
  const supplier = stands(env.SUPPLIER_PKH) && stands(env.SUPPLIER_PUB_KEY_HEX) ? { pkh: given(env.SUPPLIER_PKH), pubKeyHex: given(env.SUPPLIER_PUB_KEY_HEX) } : supplierKeyOf(env);
  const servicePkh = stands(env.BID_DESK_SERVICE_PKH)
    ? given(env.BID_DESK_SERVICE_PKH)
    : hexOf('BID_DESK_SERVICE_PKH', requiredEnv('BID_DESK_SERVICE_PKH', env.BID_DESK_SERVICE_PKH, 'the key hash of the service key, published in the manifest'), 28);
  if (keyClashOf({ pkh: servicePkh }, supplier)) {
    throw new Error("environment variable BID_DESK_SERVICE_PKH names the supplier key: the supplier key is the runtime's, and the service key must be a key of its own");
  }
  const [first, second, third] = BID_DESK_CLAIM.statements;
  const additions = buildBehaviour('bid-desk', {
    claim: [first.text, second.text, third.text],
    model: { allowlist: allowlist.value, max_price_lovelace: Number(price.value) },
    relying_on: { mock_systems: [], gateway_routes: [...GATEWAY_ROUTES] },
    price_list: { uri: template ? '<PRICE_LIST_URI>' : `${publicOriginOf(env)}${PRICE_LIST_ROUTE}`, sha256: priceList.sha256 },
  }, { template });
  if (!additions.ok) throw new Error(`the behaviour of the manifest is refused: ${additions.detail}`);
  // A served manifest names the price list file of its own instance. The hash of the list of another instance would put the prices of one desk in the record of another.
  if (!template && instance !== null && priceList.sha256 !== hashOfFile(instance)) {
    throw new Error(`the price list hash is not the hash of the file of the instance ${instance}: the manifest of an instance names the price list file of that instance`);
  }
  return {
    schema: 'vector.agent-manifest.v2',
    name,
    capability_id: BID_CAPABILITIES.quote,
    version: given(env.AGENT_VERSION) || '0.1.0',
    description: DESCRIPTION,
    operator: { name: 'Apex Fusion Foundation', contact: requiredEnv('OPERATOR_CONTACT', env.OPERATOR_CONTACT, "the operator's contact address, published in the manifest") },
    identity: manifestIdentity(did, supplier.pkh, registryOf(env)),
    keys: { supplier_pkh: supplier.pkh, pub_key_hex: supplier.pubKeyHex, service_pkh: servicePkh },
    interface: {
      request_schema: REQUEST_SCHEMA,
      response_schema: { $ref: `${SPEC_URL}#response` },
      routes: { job: '/v1/job', status: '/status', capability: '/capability', price_list: PRICE_LIST_ROUTE },
      notes: [...NOTES],
    },
    terms: {
      price_lovelace: PRICE_LOVELACE,
      supplier_bond_lovelace: BOND_LOVELACE,
      buyer_bond_lovelace: BOND_LOVELACE,
      max_processing_ms: window,
      input_limits: { request_bytes: MAX_REQUEST_BYTES },
    },
    behaviour: { data_handling: DATA_HANDLING, third_parties: [...THIRD_PARTIES], ...additions.value },
    // Absent or empty is `proposed` since the day the service was built. The operator sets a word above it, by AGENT_STATUS_CHIP, once it is true.
    status: { chip: statusChip(env.AGENT_STATUS_CHIP, 'proposed'), since: statusSince(env.AGENT_STATUS_SINCE, '2026-11-24') },
    gaps: [...GAPS],
    links: { spec: SPEC_URL, source: SOURCE_URL, explorer_advert: given(env.ADVERT_EXPLORER_URL) },
  };
}

/**
 * The settings that stand as placeholders in the template: the values that the operator gives. The name, the address of the price list and its hash come from the instance, so the template names them
 * `<BID_DESK_NAME>`, `<PRICE_LIST_URI>` and `<PRICE_LIST_SHA256>`. The two model settings have the values of the example environment, because the template has no placeholder for a model name.
 */
export const TEMPLATE_ENV = {
  OPERATOR_CONTACT: '<OPERATOR_CONTACT>',
  AGENT_DID: '<AGENT_DID>',
  SUPPLIER_PKH: '<SUPPLIER_PKH>',
  SUPPLIER_PUB_KEY_HEX: '<SUPPLIER_PUB_KEY_HEX>',
  BID_DESK_SERVICE_PKH: '<BID_DESK_SERVICE_PKH>',
  BID_DESK_INSTANCE: '<BID_DESK_INSTANCE>',
  BID_DESK_PUBLIC_ORIGIN: '<BID_DESK_PUBLIC_ORIGIN>',
  LLM_MODEL_ALLOWLIST: 'deepseek/deepseek-v4-flash',
  LLM_MAX_PRICE_LOVELACE: '1000000',
} as const;

/** The price list of the template: no file, and so a placeholder in place of its hash. */
export const TEMPLATE_PRICE_LIST: ServedPriceList = { sha256: '<PRICE_LIST_SHA256>' };

/** The text of agent.json.template: the manifest with the placeholders, indented, with a line break at the end. `pnpm --filter @vsa/bid-desk template` writes it. It is never served. */
export function renderTemplate(): string {
  const rendered = renderManifest('bid-desk', (setting) => manifestFromEnv({ ...TEMPLATE_ENV, FAULT_MODE: setting }, TEMPLATE_PRICE_LIST), { template: true });
  if (!rendered.ok) throw new Error(`the template is refused (${rendered.code}): ${rendered.detail}`);
  return rendered.value.text;
}
