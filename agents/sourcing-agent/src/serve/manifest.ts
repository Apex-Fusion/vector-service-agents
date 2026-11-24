// agents/sourcing-agent/src/serve/manifest.ts
// The manifest the service publishes at `GET /agent.json`: `vector.agent-manifest.v2`, in the form of the other agents of this repository, with the additions that the manifest folder of the kit builds under
// `behaviour` (`buildBehaviour`: the operations, the claim, the co-sign rule, the one fault value, the model limits and the routes the agent calls). The service renders the manifest one time when it starts
// (`renderManifest` of the kit, which renders it more than once and refuses it when two renders differ in one byte), serves those bytes, and the advert holds their SHA-256. Nothing in the manifest depends on the
// fault switch, and nothing in it is a secret: it holds the key hash and the public key of the supplier key, the key hashes of the service key and of the two delegation keys, the key hash of the issuer of the
// compliance attestations that the agent counts, and no key. It holds no controller: the agent reads and keeps no controller of its own record, so a change of the controller changes nothing in it.
// `manifestFromEnv` takes the environment as a parameter and reads the public settings below and no other, so the template (`renderTemplate`) and the served manifest are made by the same code, and the six
// keys of the scorers, the nine key variables, the token and the fault switch never reach it.
import { given, requiredEnv, shown, statusChip, statusSince } from '@vsa/service-kit';
import { BID_CAPABILITIES, MAX_ITEM_QUANTITY, MAX_RFQ_ITEMS, SOURCING_CLAIM, WEIGHT_NAMES } from '@vsa/usecase-kit/bids';
import { buildBehaviour, MANIFEST_SCHEMA, renderManifest } from '@vsa/usecase-kit/manifest';
import { MAX_REQUEST_BYTES } from '@vsa/usecase-kit/protocol';
import { identityRegistryOf, manifestDid, manifestIdentity } from '@vsa/vector-read';
import { gapsFor } from './gaps.ts';
import { BUYER_BOND_LOVELACE, SUPPLIER_BOND_LOVELACE, modelOf, priceOf, processingWindowOf } from './settings.ts';

export const SPEC_URL = 'https://github.com/Apex-Fusion/vector-service-agents/blob/main/specs/sourcing-agent.md';
export const SOURCE_URL = 'https://github.com/Apex-Fusion/vector-service-agents/tree/main/agents/sourcing-agent';

/** The capability sentence of the agent: what it does for a buying organisation. The README repeats it. */
export const DESCRIPTION = "For a buying organisation: finds the suppliers that quote on the marketplace, asks each for a signed quote on a request for quotation, scores the quotes against price, lead time, reliability and compliance, and returns a ranked comparison. Once the organisation has approved the ranking, it writes it to the organisation's sourcing record.";

/** The longest SKU and request identifier that a request takes, and the longest tenant, in characters. */
export const ID_CHARS = 64;
export const TENANT_CHARS = 48;

const DID_PATTERN = '^did:vector:[0-9a-f]{64}$';
const HEX_PATTERN = '^[0-9a-f]{64}$';
const ID_PATTERN = `^[A-Za-z0-9][A-Za-z0-9._-]{0,${ID_CHARS - 1}}$`;
const AUTHORITY_SCHEMA = {
  type: 'object',
  required: ['principal_did', 'delegation'],
  additionalProperties: false,
  properties: {
    principal_did: { type: 'string', pattern: DID_PATTERN, description: 'The DID of the principal who gave the delegation' },
    delegation: { type: 'string', pattern: HEX_PATTERN, description: 'The identifier of the delegation that names this agent as its delegate' },
  },
};
const TENANT_SCHEMA = {
  type: 'string', minLength: 1, maxLength: TENANT_CHARS, pattern: `^[a-z0-9][a-z0-9-]{0,${TENANT_CHARS - 1}}$`,
  description: `The tenant of the mock systems: 1 to ${TENANT_CHARS} characters, lower-case letters, digits and hyphens, starting with a letter or a digit`,
};
const RFQ_SCHEMA = {
  type: 'object',
  required: ['rfq_id', 'items', 'needed_by'],
  additionalProperties: false,
  properties: {
    rfq_id: {
      type: 'string', minLength: 1, maxLength: ID_CHARS, pattern: ID_PATTERN,
      description: `The identifier of the request for quotation: 1 to ${ID_CHARS} characters. A bidder quotes an identifier one time for one sender, so each propose needs a new one`,
    },
    items: {
      type: 'array', minItems: 1, maxItems: MAX_RFQ_ITEMS, description: `The items to quote: 1 to ${MAX_RFQ_ITEMS} items, and each SKU one time`,
      items: {
        type: 'object',
        required: ['sku', 'quantity'],
        additionalProperties: false,
        properties: {
          sku: { type: 'string', minLength: 1, maxLength: ID_CHARS, pattern: ID_PATTERN, description: `The SKU: 1 to ${ID_CHARS} characters` },
          quantity: { type: 'integer', minimum: 1, maximum: MAX_ITEM_QUANTITY, description: `The quantity: a whole number from 1 to ${MAX_ITEM_QUANTITY}` },
        },
      },
    },
    needed_by: { type: 'string', pattern: '^[0-9]{4}-[0-9]{2}-[0-9]{2}$', description: 'The date by which the goods are needed, as YYYY-MM-DD, a date that exists' },
  },
};
const WEIGHT_SCHEMA = { type: 'number', minimum: 0, maximum: 1, description: 'A number from 0 to 1 with at most 4 decimal places' };
const WEIGHTS_SCHEMA = {
  type: 'object',
  required: [...WEIGHT_NAMES],
  additionalProperties: false,
  properties: Object.fromEntries(WEIGHT_NAMES.map((name) => [name, WEIGHT_SCHEMA])),
  description: 'The weights of the four parts of a score. They sum to 1. The agent does not send them to the bidders',
};
const PROPOSE_SCHEMA = {
  type: 'object',
  required: ['op', 'authority', 'tenant', 'rfq', 'weights'],
  additionalProperties: false,
  properties: {
    op: { const: 'propose' },
    authority: AUTHORITY_SCHEMA,
    tenant: TENANT_SCHEMA,
    rfq: RFQ_SCHEMA,
    weights: WEIGHTS_SCHEMA,
  },
};
const EXECUTE_SCHEMA = {
  type: 'object',
  required: ['op', 'authority', 'tenant', 'proposal', 'approval'],
  additionalProperties: false,
  properties: {
    op: { const: 'execute' },
    authority: AUTHORITY_SCHEMA,
    tenant: TENANT_SCHEMA,
    proposal: {
      type: 'object',
      required: ['document', 'salt', 'proposal_digest'],
      additionalProperties: false,
      properties: {
        document: { type: 'object', description: 'The ranking that propose returned' },
        salt: { type: 'string', pattern: HEX_PATTERN },
        proposal_digest: { type: 'string', pattern: HEX_PATTERN, description: 'The digest of the salt and the document, which the hirer approved' },
      },
    },
    approval: {
      description: 'The approval of the hirer for the digest of the proposal, or null: the sourcing record refuses a ranking with no valid approval',
      oneOf: [
        { type: 'null' },
        {
          type: 'object',
          required: ['attestation', 'issuer_did'],
          additionalProperties: false,
          properties: { attestation: { type: 'string', pattern: HEX_PATTERN }, issuer_did: { type: 'string', pattern: DID_PATTERN } },
        },
      ],
    },
  },
};
/** What the intake accepts, as a JSON Schema: a request is one of the two operations, and a member that is not listed is refused. */
export const REQUEST_SCHEMA = { oneOf: [PROPOSE_SCHEMA, EXECUTE_SCHEMA] };

const NOTES = [
  'A request is one JSON object with the member op set to propose or to execute, with the members of that operation and no other member. A request that breaks a rule of the intake is refused with bad_shape (400).',
  'propose lists the bidders that quote on the marketplace and makes a file of facts for each. The model chooses up to 3 bidders to invite. The agent hires each invited bidder for a signed quote, one after the other, and pays each quote from the vault of the delegation. The model decides whether to accept each quote. For each accepted quote, a scorer reads the vendor master through a sub-delegation, and the model scores the quote. The model gives the order. propose returns the ranking with its salt and its digest. It writes nothing to the sourcing record.',
  'execute writes the ranking that the hirer approved to the sourcing record of the tenant. It makes no model call and no payment. The sourcing record checks the approval, and its refusal is the result of the job.',
  'The route POST /cosign/delegate is open and takes no job: it signs only the Delegate that the rule in behaviour.cosign allows, for a principal key on the allowlist of the operator.',
];
const DATA_HANDLING = 'The request for quotation, the weights, the quotes, the files of the bidders and the entries of the vendor master are synthetic data, and they are held in memory while a job runs. '
  + 'On disk the service keeps the bookkeeping of the escrows it posts, the list of sub-delegations that it has to end, the record of the challenges it files and the register of the transactions it co-signed. '
  + 'The log carries job outcomes, counts and codes, never a request, a quote, a price list, a vendor entry or a key.';
const THIRD_PARTIES = [
  'the identity gateway (the token requests of the agent and of its scorers, the DID resolutions, the catalog and the credentials of the bidders)',
  'the marketplace indexer (the list of the adverts of the bidders)',
  'the mock vendor master and the sourcing record (the calls above, with their tokens)',
  'each invited Bid Desk (the request for quotation, the DID of this agent and the delegation, and not the weights)',
  'a model supplier on the Vector marketplace, hired through a bonded escrow, and the model provider behind it (the prompt of each decision: the files of the bidders, a quote with its price list, a quote with its vendor entry and the weights, and the scores)',
  'the Vector ledger (reads of stakes, cases and attestations, the sub-delegations and, on a refused quote, the evidence document and the challenge)',
];
const MOCK_ROUTES = ['GET /t/{tenant}/vendors', 'POST /t/{tenant}/sourcing/rankings'];
/** The routes of the identity gateway that the agent calls: the token exchange, the DID resolution, the credential, the catalog, and the key set and the status list that the verifier of the credential reads. */
const GATEWAY_ROUTES = [
  'POST /token', 'GET /1.0/identifiers/{did}', 'GET /agents/{agent}/credential', 'GET /.well-known/ard.json', 'GET /.well-known/jwks.json', 'GET /status/bsl/{n}',
];

/**
 * The identity block of the manifest, which vector-read builds the same way for every agent of this repository: the DID of AGENT_DID in its canonical form, the address of the identity registry of
 * IDENTITY_POLICY_ID and IDENTITY_ADDRESS, and the listed supplier key, `<DID>#<key hash>`. A value that breaks a rule stops the start, and the error names the variable. The helpers quote the value they refuse;
 * here a value that is hex-shaped or long is given by its length (shown), as in every other message of the service.
 */
function identityFromEnv(env: NodeJS.ProcessEnv): { did: string; registry_address: string; supplier_key: string } {
  const values = [env.AGENT_DID, env.IDENTITY_POLICY_ID, env.IDENTITY_ADDRESS].map(given);
  try {
    return manifestIdentity(manifestDid(env.AGENT_DID), given(env.SUPPLIER_PKH), identityRegistryOf(env.IDENTITY_POLICY_ID, env.IDENTITY_ADDRESS));
  } catch (e) {
    let text = e instanceof Error ? e.message : String(e);
    for (const value of values) if (value !== '' && shown(value) !== JSON.stringify(value)) text = text.replaceAll(`"${value}"`, shown(value)).replaceAll(value, `(${shown(value)})`);
    throw new Error(text.startsWith('environment variable ') ? text : `environment variable ${text}`);
  }
}

/**
 * The manifest of the agent. The values come from `env`: the operator contact, the DID, the identity registry, the supplier key, the three key hashes of the service and the key hash of the issuer of the
 * compliance attestations, the models and the price ceiling, the price and the window of the advert, the status and the links. A setting that breaks a rule throws an Error that names the variable.
 */
export function manifestFromEnv(env: NodeJS.ProcessEnv = process.env) {
  const model = modelOf(env);
  const [first, second, third] = SOURCING_CLAIM.statements;
  const additions = buildBehaviour('sourcing-agent', {
    claim: [first.text, second.text, third.text],
    model: { allowlist: [...model.allowlist], max_price_lovelace: Number(model.maxPriceLovelace) },
    relying_on: { mock_systems: MOCK_ROUTES, gateway_routes: GATEWAY_ROUTES },
  });
  if (!additions.ok) throw new Error(`the behaviour of the manifest is refused: ${additions.detail}`);
  return {
    schema: MANIFEST_SCHEMA,
    name: 'Sourcing Agent',
    capability_id: BID_CAPABILITIES.evaluate,
    // An AGENT_VERSION that is empty or blank is not set (given): an empty version would be published in the manifest that the advert hashes. A changed manifest needs a new advert.
    version: given(env.AGENT_VERSION) || '0.1.0',
    description: DESCRIPTION,
    operator: { name: 'Apex Fusion Foundation', contact: requiredEnv('OPERATOR_CONTACT', env.OPERATOR_CONTACT, "the operator's contact address, published in the manifest") },
    identity: identityFromEnv(env),
    keys: {
      supplier_pkh: given(env.SUPPLIER_PKH), pub_key_hex: given(env.SUPPLIER_PUB_KEY_HEX), service_pkh: given(env.SOURCING_SERVICE_PKH),
      delegation_pkhs: [given(env.SOURCING_DELEGATION_1_PKH), given(env.SOURCING_DELEGATION_2_PKH)],
      // Whose attestations the agent counts: an attestation of another issuer is not counted.
      compliance_issuer_pkh: given(env.COMPLIANCE_ISSUER_PKH),
    },
    interface: {
      request_schema: REQUEST_SCHEMA,
      response_schema: { $ref: `${SPEC_URL}#response` },
      routes: { job: '/v1/job', status: '/status', capability: '/capability' },
      notes: [...NOTES],
    },
    terms: {
      price_lovelace: priceOf(env), supplier_bond_lovelace: SUPPLIER_BOND_LOVELACE, buyer_bond_lovelace: BUYER_BOND_LOVELACE, max_processing_ms: processingWindowOf(env),
      input_limits: { request_bytes: MAX_REQUEST_BYTES, rfq_items: MAX_RFQ_ITEMS, item_quantity: MAX_ITEM_QUANTITY, tenant_chars: TENANT_CHARS },
    },
    behaviour: { data_handling: DATA_HANDLING, third_parties: [...THIRD_PARTIES], ...additions.value },
    // The agent is proposed until a run has settled: a word above proposed is the operator's to set, by AGENT_STATUS_CHIP, once it is true.
    status: { chip: statusChip(env.AGENT_STATUS_CHIP, 'proposed'), since: statusSince(env.AGENT_STATUS_SINCE, '2026-11-24') },
    gaps: [...gapsFor()],
    links: { spec: SPEC_URL, source: SOURCE_URL, explorer_advert: given(env.ADVERT_EXPLORER_URL) },
  };
}

/**
 * The values of the operator as the placeholders that the template file shows, and the two limits of the model hire as the values that the example env file of the pack holds. The model and its ceiling are
 * not placeholders: a model name is a value that the manifest folder checks, and a placeholder is not one.
 */
export const TEMPLATE_ENV = {
  OPERATOR_CONTACT: '<OPERATOR_CONTACT>', AGENT_DID: '<AGENT_DID>', SUPPLIER_PKH: '<SUPPLIER_PKH>', SUPPLIER_PUB_KEY_HEX: '<SUPPLIER_PUB_KEY_HEX>',
  SOURCING_SERVICE_PKH: '<SOURCING_SERVICE_PKH>', SOURCING_DELEGATION_1_PKH: '<SOURCING_DELEGATION_1_PKH>', SOURCING_DELEGATION_2_PKH: '<SOURCING_DELEGATION_2_PKH>',
  COMPLIANCE_ISSUER_PKH: '<COMPLIANCE_ISSUER_PKH>',
  LLM_MODEL_ALLOWLIST: 'deepseek/deepseek-v4-flash', LLM_MAX_PRICE_LOVELACE: '1000000',
} as const;

/** The text of agent.json.template: the manifest with the placeholders, indented, with a line break at the end. `pnpm --filter @vsa/sourcing-agent template` writes it. */
export function renderTemplate(): string {
  const rendered = renderManifest('sourcing-agent', (setting) => manifestFromEnv({ ...TEMPLATE_ENV, FAULT_MODE: setting }), { template: true });
  if (!rendered.ok) throw new Error(`the template is refused (${rendered.code}): ${rendered.detail}`);
  return rendered.value.text;
}
