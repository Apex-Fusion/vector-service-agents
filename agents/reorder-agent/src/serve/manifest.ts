// agents/reorder-agent/src/serve/manifest.ts
// The manifest the service publishes at `GET /agent.json`: `vector.agent-manifest.v2`, in the form of the other agents of this repository, with the additions that the manifest folder of the kit builds under
// `behaviour` (`buildBehaviour`: the operations, the claim, the co-sign rule, the model limits and the routes the agent calls). The service renders the manifest one time when it starts (`renderManifest` of the
// kit, which renders it more than once and refuses it when two renders differ in one byte), serves those bytes, and the advert holds their SHA-256. Nothing in the manifest depends on the fault switch, and
// nothing in it is a secret: it holds the key hash and the public key of the supplier key, the key hashes of the service key and of the two delegation keys, and no key.
// `manifestFromEnv` takes the environment as a parameter and reads no other source, so the template (`renderTemplate`) and the served manifest are made by the same code.
import { INVENTORY_CAPABILITIES, REORDER_CLAIM } from '@vsa/usecase-kit/inventory';
import { buildBehaviour, MANIFEST_SCHEMA, renderManifest } from '@vsa/usecase-kit/manifest';
import { MAX_REQUEST_BYTES } from '@vsa/usecase-kit/protocol';
import { given, requiredEnv, shown, statusChip, statusSince } from '@vsa/service-kit';
import { identityRegistryOf, manifestDid, manifestIdentity } from '@vsa/vector-read';
import { gapsFor } from './gaps.ts';
import { BUYER_BOND_LOVELACE, SUPPLIER_BOND_LOVELACE, modelOf, priceOf, processingWindowOf } from './settings.ts';

export const SPEC_URL = 'https://github.com/Apex-Fusion/vector-service-agents/blob/main/specs/reorder-agent.md';
export const SOURCE_URL = 'https://github.com/Apex-Fusion/vector-service-agents/tree/main/agents/reorder-agent';

/** The capability sentence of the agent: what it does for a buying organisation. The README repeats it. */
export const DESCRIPTION = 'For a buying organisation: reads the stock of one SKU, proposes a purchase order for one lot from a named supplier, and, once the organisation has approved the order, places it from the vault of the organisation and records it.';

/** The longest SKU and tenant that a request takes, in characters. */
export const SKU_CHARS = 64;
export const TENANT_CHARS = 48;

const DID_PATTERN = '^did:vector:[0-9a-f]{64}$';
const HEX_PATTERN = '^[0-9a-f]{64}$';
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
const PROPOSE_SCHEMA = {
  type: 'object',
  required: ['op', 'authority', 'tenant', 'sku', 'supplier_did'],
  additionalProperties: false,
  properties: {
    op: { const: 'propose' },
    authority: AUTHORITY_SCHEMA,
    tenant: TENANT_SCHEMA,
    sku: { type: 'string', minLength: 1, maxLength: SKU_CHARS, pattern: `^[A-Za-z0-9][A-Za-z0-9._-]{0,${SKU_CHARS - 1}}$`, description: `The SKU to reorder: 1 to ${SKU_CHARS} characters` },
    supplier_did: { type: 'string', pattern: DID_PATTERN, description: 'The DID of the Order Desk that takes the order' },
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
        document: { type: 'object', description: 'The purchase order that propose returned' },
        salt: { type: 'string', pattern: HEX_PATTERN },
        proposal_digest: { type: 'string', pattern: HEX_PATTERN, description: 'The digest of the salt and the document, which the hirer approved' },
      },
    },
    approval: {
      description: 'The approval of the hirer for the digest of the proposal, or null: the Order Desk refuses an order with no valid approval',
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
  'propose reads the stock of one SKU through a sub-delegation to stock-reader, reads the Order Desk of the supplier, asks one model for the lot, and returns a purchase order with its salt and its digest. It pays nothing and writes nothing to the PO store.',
  'execute places an order that the hirer approved: it pays the advert of the Order Desk from the vault of the delegation, checks the confirmation, asks one model whether to accept it, accepts the escrow and writes the order to the PO store. A confirmation that the model does not accept is challenged and not accepted.',
  'The route POST /cosign/delegate is open and takes no job: it signs only the Delegate that the rule in behaviour.cosign allows, for a principal key on the allowlist of the operator.',
];
const DATA_HANDLING = 'The stock reading, the purchase order and the confirmation are synthetic data, and they are held in memory while a job runs. '
  + 'On disk the service keeps the bookkeeping of the escrows it posts, the list of sub-delegations that it has to end, the record of the challenges it files, the register of the transactions it co-signed, and the counter of purchase order numbers. '
  + 'The log carries job outcomes, counts and codes, never a request, a stock reading, an order or a key.';
const THIRD_PARTIES = [
  'the identity gateway (the token requests of the agent and of stock-reader)',
  'the mock ERP and the PO store (the calls above, with their tokens)',
  'a model supplier on the Vector marketplace, hired through a bonded escrow, and the model provider behind it (the prompt of each decision: the stock reading and the lots, or the purchase order and the confirmation)',
  'the Order Desk (the purchase order, the salt, the approval reference, the DID of this agent and the delegation)',
  'the Vector ledger (the sub-delegation and, on a dispute, the evidence document and the challenge)',
];
const MOCK_ROUTES = ['GET /t/{tenant}/erp/stock/{sku}', 'POST /t/{tenant}/po'];
const GATEWAY_ROUTES = ['POST /token'];

/**
 * The identity block of the manifest, which vector-read builds the same way for every agent of this repository: the DID of AGENT_DID in its canonical form, the address of the identity registry of
 * IDENTITY_POLICY_ID and IDENTITY_ADDRESS, and the listed supplier key, `<DID>#<key hash>`. A value that breaks a rule stops the start, and the error names the variable. The helpers quote the value they refuse;
 * here a value that is hex-shaped or long is given by its length (shown), as in every other message of the service.
 */
function identityFromEnv(env: NodeJS.ProcessEnv): { did: string; registry_address: string; supplier_key: string } {
  const values = [env.AGENT_DID, env.IDENTITY_POLICY_ID, env.IDENTITY_ADDRESS].map(given);
  try {
    return manifestIdentity(manifestDid(env.AGENT_DID), env.SUPPLIER_PKH ?? '', identityRegistryOf(env.IDENTITY_POLICY_ID, env.IDENTITY_ADDRESS));
  } catch (e) {
    let text = (e as Error).message;
    for (const value of values) if (value !== '' && shown(value) !== JSON.stringify(value)) text = text.replaceAll(`"${value}"`, shown(value)).replaceAll(value, `(${shown(value)})`);
    throw new Error(text.startsWith('environment variable ') ? text : `environment variable ${text}`);
  }
}

/**
 * The manifest of the agent. The values come from `env`: the operator contact, the DID, the identity registry, the supplier key and the three key hashes of the service, the models and the price ceiling, the
 * price and the window of the advert, the status and the links. A setting that breaks a rule throws an Error that names the variable.
 */
export function manifestFromEnv(env: NodeJS.ProcessEnv = process.env) {
  const model = modelOf(env);
  const [first, second, third] = REORDER_CLAIM.statements;
  const additions = buildBehaviour('reorder-agent', {
    claim: [first.text, second.text, third.text],
    model: { allowlist: [...model.allowlist], max_price_lovelace: Number(model.maxPriceLovelace) },
    relying_on: { mock_systems: MOCK_ROUTES, gateway_routes: GATEWAY_ROUTES },
  });
  if (!additions.ok) throw new Error(`the behaviour of the manifest is refused: ${additions.detail}`);
  return {
    schema: MANIFEST_SCHEMA,
    name: 'Reorder Agent',
    capability_id: INVENTORY_CAPABILITIES.reorder,
    // An AGENT_VERSION that is empty or blank is not set (given): an empty version would be published in the manifest that the advert hashes. A changed manifest needs a new advert.
    version: given(env.AGENT_VERSION) || '0.1.0',
    description: DESCRIPTION,
    operator: { name: 'Apex Fusion Foundation', contact: requiredEnv('OPERATOR_CONTACT', env.OPERATOR_CONTACT, "the operator's contact address, published in the manifest") },
    identity: identityFromEnv(env),
    keys: {
      supplier_pkh: env.SUPPLIER_PKH ?? '', pub_key_hex: env.SUPPLIER_PUB_KEY_HEX ?? '', buyer_pkh: env.REORDER_SERVICE_PKH ?? '',
      delegation_pkhs: [env.REORDER_DELEGATION_1_PKH ?? '', env.REORDER_DELEGATION_2_PKH ?? ''],
    },
    interface: {
      request_schema: REQUEST_SCHEMA,
      response_schema: { $ref: `${SPEC_URL}#response` },
      routes: { job: '/v1/job', status: '/status', capability: '/capability' },
      notes: [...NOTES],
    },
    terms: {
      price_lovelace: priceOf(env), supplier_bond_lovelace: SUPPLIER_BOND_LOVELACE, buyer_bond_lovelace: BUYER_BOND_LOVELACE, max_processing_ms: processingWindowOf(env),
      input_limits: { request_bytes: MAX_REQUEST_BYTES, sku_chars: SKU_CHARS, tenant_chars: TENANT_CHARS },
    },
    behaviour: { data_handling: DATA_HANDLING, third_parties: [...THIRD_PARTIES], ...additions.value },
    // The agent is proposed until a run has settled: a word above proposed is the operator's to set, by AGENT_STATUS_CHIP, once it is true.
    status: { chip: statusChip(env.AGENT_STATUS_CHIP, 'proposed'), since: statusSince(env.AGENT_STATUS_SINCE, '2026-11-16') },
    gaps: [...gapsFor()],
    links: { spec: SPEC_URL, source: SOURCE_URL, explorer_advert: env.ADVERT_EXPLORER_URL ?? '' },
  };
}

/**
 * The values of the operator as the placeholders that the template file shows, and the two limits of the model hire as the values that the example env file of the pack holds. The model and its ceiling are
 * not placeholders: a model name is a value that the manifest folder checks, and a placeholder is not one.
 */
export const TEMPLATE_ENV = {
  OPERATOR_CONTACT: '<OPERATOR_CONTACT>', AGENT_DID: '<AGENT_DID>', SUPPLIER_PKH: '<SUPPLIER_PKH>', SUPPLIER_PUB_KEY_HEX: '<SUPPLIER_PUB_KEY_HEX>',
  REORDER_SERVICE_PKH: '<REORDER_SERVICE_PKH>', REORDER_DELEGATION_1_PKH: '<REORDER_DELEGATION_1_PKH>', REORDER_DELEGATION_2_PKH: '<REORDER_DELEGATION_2_PKH>',
  LLM_MODEL_ALLOWLIST: 'deepseek/deepseek-v4-flash', LLM_MAX_PRICE_LOVELACE: '1000000',
} as const;

/** The text of agent.json.template: the manifest with the placeholders, indented, with a line break at the end. `pnpm --filter @vsa/reorder-agent template` writes it. */
export function renderTemplate(): string {
  const rendered = renderManifest('reorder-agent', () => manifestFromEnv(TEMPLATE_ENV), { template: true });
  if (!rendered.ok) throw new Error(`the template is refused (${rendered.code}): ${rendered.detail}`);
  return rendered.value.text;
}
