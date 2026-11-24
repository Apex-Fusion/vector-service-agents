// agents/prior-authorization-agent/src/serve/manifest.ts
// The manifest the service publishes at `GET /agent.json`: `vector.agent-manifest.v2`, in the form of the other agents of this repository, with the additions that the manifest folder of the kit builds under
// `behaviour` (`buildBehaviour`: the operations, the claim, the co-sign rule, the possible fault values, the model limits and the routes that the agent calls). The service renders the manifest one time when it
// starts (`renderManifest` of the kit, which renders it more than once and refuses it when two renders differ in one byte), serves those bytes, and the advert holds their SHA-256. Nothing in the manifest depends on
// the fault switch, and nothing in it is a secret: it holds the key hash and the public key of the supplier key and the key hashes of the service key and of the two delegation keys, and no key.
//
// `manifestFromEnv` takes the environment as a parameter and reads the settings that it publishes and no other, so the template (`renderTemplate`) and the served manifest are made by the same code. It reads no
// key, no token and no setting of another part of the service. It publishes no line as the operator wrote it where the line names an identity or a key: the DID, the supplier key and each key hash are read by a
// checked reader, which refuses a value that is not what the line names, and the manifest holds the value that the reader gives. The one exception is the template, whose lines hold their own placeholder.
import { given, hexOf, requiredEnv, statusChip, statusSince } from '@vsa/service-kit';
import type { StatusChip } from '@vsa/service-kit';
import { MANIFEST_SCHEMA, MAX_URI_CHARS, buildBehaviour, renderManifest } from '@vsa/usecase-kit/manifest';
import { MAX_JUSTIFICATION_CHARS, PRIORAUTH_CAPABILITIES, PRIORAUTH_CLAIM, PRIORAUTH_MODELS } from '@vsa/usecase-kit/priorauth';
import { MAX_REQUEST_BYTES } from '@vsa/usecase-kit/protocol';
import type { BehaviourAdditions } from '@vsa/usecase-kit/protocol';
import { REGISTRY_POLICY, identityRegistryOf, manifestIdentity, scriptAddress } from '@vsa/vector-read';
import type { Registry } from '@vsa/vector-read';
import { gapsFor } from './gaps.ts';
import { BUYER_BOND_LOVELACE, SUPPLIER_BOND_LOVELACE, agentDidOf, modelOf, priceOf, processingWindowOf, supplierKeyOf } from './settings.ts';
import type { SupplierKey } from './settings.ts';

export const SPEC_URL = 'https://github.com/Apex-Fusion/vector-service-agents/blob/main/specs/prior-authorization-agent.md';
export const SOURCE_URL = 'https://github.com/Apex-Fusion/vector-service-agents/tree/main/agents/prior-authorization-agent';

/** The capability sentence of the agent: what it does for a care provider. The README repeats it. */
export const DESCRIPTION =
  "For a care provider: reads the records behind a clinical order, drafts an insurer-format authorization request with its justification, and, once the provider's reviewer has signed off, "
  + "submits exactly that request to the insurer's intake agent.";

/**
 * The date since which the status of the agent holds, when AGENT_STATUS_SINCE is not set. The page of the agent holds the same date, and the template and the README line of the status show it. It stands here and
 * nowhere else in the sources.
 */
export const STATUS_SINCE_DEFAULT = '2026-11-24';

/** The longest order id and tenant that a request takes, in characters. */
export const ORDER_ID_CHARS = 64;
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
} as const;
const TENANT_SCHEMA = {
  type: 'string',
  minLength: 1,
  maxLength: TENANT_CHARS,
  pattern: `^[a-z0-9][a-z0-9-]{0,${TENANT_CHARS - 1}}$`,
  description: `The tenant of the mock systems: 1 to ${TENANT_CHARS} characters, lower-case letters, digits and hyphens, starting with a letter or a digit`,
} as const;
const PROPOSE_SCHEMA = {
  type: 'object',
  required: ['op', 'authority', 'tenant', 'order_id', 'insurer_did'],
  additionalProperties: false,
  properties: {
    op: { const: 'propose' },
    authority: AUTHORITY_SCHEMA,
    tenant: TENANT_SCHEMA,
    order_id: {
      type: 'string',
      minLength: 1,
      maxLength: ORDER_ID_CHARS,
      pattern: `^[A-Za-z0-9][A-Za-z0-9._-]{0,${ORDER_ID_CHARS - 1}}$`,
      description: `The clinical order to draft the authorization request for: 1 to ${ORDER_ID_CHARS} characters`,
    },
    insurer_did: { type: 'string', pattern: DID_PATTERN, description: 'The DID of the Insurer Intake Agent that takes the request' },
  },
} as const;
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
        document: { type: 'object', description: 'The authorization request that propose returned' },
        salt: { type: 'string', pattern: HEX_PATTERN },
        proposal_digest: { type: 'string', pattern: HEX_PATTERN, description: 'The digest of the salt and the document, which the hirer signed off' },
      },
    },
    approval: {
      description: 'The sign-off of the hirer for the digest of the proposal, or null: the Insurer Intake Agent refuses a request with no valid sign-off',
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
} as const;
/** What the intake accepts, as a JSON Schema: a request is one of the two operations, and a member that is not listed is refused. */
export const REQUEST_SCHEMA = { oneOf: [PROPOSE_SCHEMA, EXECUTE_SCHEMA] } as const;

const NOTES = [
  'A request is one JSON object with the member op set to propose or to execute, with the members of that operation and no other member. A request that breaks a rule of the intake is refused with bad_shape (400).',
  'propose reads the order and its record set through a sub-delegation to record-reader, reads the guideline of the service through a sub-delegation to drafter, asks one model for the justification, '
  + 'and returns an authorization request with its salt and its digest. It writes nothing to the records system and pays the Insurer Intake Agent nothing.',
  'execute submits a request that the hirer signed off: it pays the advert of the Insurer Intake Agent from the vault of the delegation, checks the intake record, asks one model whether to accept it, '
  + 'accepts the escrow and writes the intake reference to the records system. An intake record that the model does not accept is challenged and not accepted.',
  'The route POST /cosign/delegate is open and takes no job: it signs only the Delegate that the rule in behaviour.cosign allows, for a principal key on the allowlist of the operator.',
  `The advert and every receipt name the model ${PRIORAUTH_MODELS.draft}.`,
];
const DATA_HANDLING =
  'The order, the record set, the guideline, the authorization request and the intake record are synthetic data, and they are held in memory while a job runs. '
  + 'On disk the service keeps the bookkeeping of the escrows that it posts, the list of sub-delegations that it has to end, the record of the challenges that it files, the register of the transactions that it co-signed, '
  + 'and the counter of request numbers. '
  + 'The log carries job outcomes, counts and codes, never a record, a justification, a request or a key.';
const THIRD_PARTIES = [
  'the identity gateway (the token requests of the agent and of its two subagents, record-reader and drafter)',
  'the mock records system and guidelines store (the three calls that behaviour.relying_on lists, with their tokens)',
  'a model supplier on the Vector marketplace, hired through a bonded escrow, and the model provider behind it (the prompt of the decision justification: the order without its patient reference and its clinician reference, '
  + 'the whole record set and the guideline; the prompt of the decision accept_delivery: the request number and the hash of the request that was sent, and the request number and the hash that the intake record names)',
  'the Insurer Intake Agent (the request, the salt, the approval reference, the DID of this agent and the delegation)',
  'the Vector ledger (the two sub-delegations, the escrows, which carry only hashes, and, on a dispute, the evidence document and the challenge)',
];
const MOCK_ROUTES = ['GET /t/{tenant}/records/orders/{order_id}', 'GET /t/{tenant}/guidelines/{code}', 'POST /t/{tenant}/records/orders/{order_id}/submission'];
const GATEWAY_ROUTES = ['POST /token'];

/** The text that the template shows in place of a value of the operator: the name of the setting in angle brackets. */
const placeholderOf = (name: string): string => `<${name}>`;
/** True when the setting holds its own placeholder. Only the template does: no other text counts, so no other text is published as it stands. */
const isPlaceholder = (env: NodeJS.ProcessEnv, name: string): boolean => given(env[name]) === placeholderOf(name);

/**
 * The DID that the manifest publishes: the DID that `agentDidOf` reads, in its canonical form, or the placeholder of the template. A value that is no DID stops the render, and the message gives its length and
 * never the value.
 */
function didOf(env: NodeJS.ProcessEnv): string {
  return isPlaceholder(env, 'AGENT_DID') ? placeholderOf('AGENT_DID') : agentDidOf(env);
}

/** The supplier key that the manifest publishes: the key hash and the public key that `supplierKeyOf` reads, which hash to each other, or the two placeholders of the template. */
function supplierOf(env: NodeJS.ProcessEnv): SupplierKey {
  if (isPlaceholder(env, 'SUPPLIER_PKH') && isPlaceholder(env, 'SUPPLIER_PUB_KEY_HEX')) return { pkh: placeholderOf('SUPPLIER_PKH'), pubKeyHex: placeholderOf('SUPPLIER_PUB_KEY_HEX') };
  return supplierKeyOf(env);
}

/** The key hashes that the manifest publishes, in the order of the settings: the service key and the two delegation keys. */
const KEY_HASH_SETTINGS = [
  ['PRIORAUTH_SERVICE_PKH', 'the key hash of the service key'],
  ['PRIORAUTH_DELEGATION_1_PKH', 'the key hash of the first delegation key'],
  ['PRIORAUTH_DELEGATION_2_PKH', 'the key hash of the second delegation key'],
] as const;

/**
 * The three key hashes that the manifest publishes, each read as a key hash (56 hex characters, given in lower case), or the placeholder of the template. A line that holds a key, or any other text, is refused
 * with its length. A key hash that is the key hash of the supplier key is refused too, because the supplier key is the key of the runtime, and so is a key hash that stands in two lines, because each key of the
 * service is a key of its own.
 */
function keyHashesOf(env: NodeJS.ProcessEnv, supplierPkh: string): readonly [string, string, string] {
  const hashes: string[] = [];
  for (const [name, what] of KEY_HASH_SETTINGS) {
    const text = requiredEnv(name, env[name], `${what}, published in the manifest`);
    if (text === placeholderOf(name)) {
      hashes.push(text);
      continue;
    }
    const hash = hexOf(name, text, 28);
    if (hash === supplierPkh) throw new Error(`environment variable ${name} names the supplier key: the supplier key is the runtime's, and this key must be a key of its own`);
    const same = KEY_HASH_SETTINGS.find((_, index) => hashes[index] === hash);
    if (same !== undefined) throw new Error(`environment variable ${name} holds the same key hash as ${same[0]}: each key of the service must be a key of its own`);
    hashes.push(hash);
  }
  return [hashes[0], hashes[1], hashes[2]];
}

/**
 * The identity registry of the deployment, from IDENTITY_POLICY_ID and IDENTITY_ADDRESS: the helper of the identity code decides what each value may be. A value that breaks a rule stops the render, and the error
 * names the setting and gives the length of the value, never the value: the helper quotes a value that it refuses, so the two checks that quote one are made here first.
 */
function registryOf(env: NodeJS.ProcessEnv): Registry | null {
  const policy = given(env.IDENTITY_POLICY_ID);
  const address = given(env.IDENTITY_ADDRESS);
  if (policy !== '' && !/^[0-9a-f]{56}$/.test(policy)) throw new Error(`environment variable IDENTITY_POLICY_ID must be 56 lowercase hex characters, got ${policy.length} characters`);
  if (policy !== '' && policy !== REGISTRY_POLICY && address !== '' && address !== scriptAddress(policy)) {
    throw new Error(`environment variable IDENTITY_ADDRESS (${address.length} characters) is not the address of IDENTITY_POLICY_ID (${scriptAddress(policy)})`);
  }
  try {
    return identityRegistryOf(policy, address);
  } catch (error) {
    // What is left is a message that holds no value of the operator: an address with no policy, and the policy of the legacy registry.
    throw new Error(`environment variable ${(error as Error).message}`);
  }
}

/** The longest contact that the manifest publishes, in characters. */
const CONTACT_CHARS = 200;

/** The contact of the operator, published in the manifest: one line of at most CONTACT_CHARS characters, with no control character. */
function contactOf(env: NodeJS.ProcessEnv): string {
  const contact = requiredEnv('OPERATOR_CONTACT', env.OPERATOR_CONTACT, "the operator's contact address, published in the manifest");
  if (contact.length > CONTACT_CHARS || /[\u0000-\u001f\u007f]/.test(contact)) {
    throw new Error(`environment variable OPERATOR_CONTACT must be one line of at most ${CONTACT_CHARS} characters with no control character, and it has ${contact.length} characters`);
  }
  return contact;
}

/**
 * The version of the agent: a short text of letters, digits, dots, hyphens and plus signs. An AGENT_VERSION that is empty or blank is not set: an empty version would be published in the manifest that the advert
 * hashes. A changed manifest needs a new advert.
 */
function versionOf(env: NodeJS.ProcessEnv): string {
  const version = given(env.AGENT_VERSION) || '0.1.0';
  if (!/^[0-9A-Za-z][0-9A-Za-z.+-]{0,31}$/.test(version)) {
    throw new Error(`environment variable AGENT_VERSION must be 1 to 32 letters, digits, dots, hyphens and plus signs, and it has ${version.length} characters`);
  }
  return version;
}

/** The link to the advert on an explorer: not set, or an https address with no user and no password. */
function explorerUrlOf(env: NodeJS.ProcessEnv): string {
  const text = given(env.ADVERT_EXPLORER_URL);
  if (text === '') return '';
  let url: URL | null = null;
  try {
    url = new URL(text);
  } catch {
    // Not an address: the message below says so, and it never shows the value.
  }
  if (url === null || url.protocol !== 'https:' || url.username !== '' || url.password !== '' || text.length > MAX_URI_CHARS) {
    throw new Error(`environment variable ADVERT_EXPLORER_URL must be an https address with no user and no password, and it has ${text.length} characters`);
  }
  return text;
}

/**
 * The status of the agent: a word, and the date since it holds. The agent is proposed until a run has settled: a word above proposed is the operator's to set, by AGENT_STATUS_CHIP, once it is true. A wrong
 * word or date stops the start by its setting, and the message gives the length of the value and never the value.
 */
function statusOf(env: NodeJS.ProcessEnv): { readonly chip: StatusChip; readonly since: string } {
  const word = given(env.AGENT_STATUS_CHIP);
  const day = given(env.AGENT_STATUS_SINCE);
  let chip: StatusChip;
  try {
    chip = statusChip(word, 'proposed');
  } catch {
    throw new Error(`environment variable AGENT_STATUS_CHIP must be one of LIVE, DEPLOYED, PROPOSED, in any case, and it has ${word.length} characters`);
  }
  let since: string;
  try {
    since = statusSince(day, STATUS_SINCE_DEFAULT);
  } catch {
    throw new Error(`environment variable AGENT_STATUS_SINCE must be a date as YYYY-MM-DD, and it has ${day.length} characters`);
  }
  const [year, month, date] = since.split('-').map(Number);
  const probe = new Date(Date.UTC(year, month - 1, date));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== date) {
    throw new Error(`environment variable AGENT_STATUS_SINCE must be a date that exists, and it has ${day.length} characters`);
  }
  return { chip, since };
}

/** The manifest of the Prior Authorization Agent: the members of the manifest v2 that this agent writes, and under `behaviour` the additions of the kit. */
export interface PriorAuthManifest {
  readonly schema: typeof MANIFEST_SCHEMA;
  readonly name: 'Prior Authorization Agent';
  readonly capability_id: typeof PRIORAUTH_CAPABILITIES.draft;
  readonly version: string;
  readonly description: string;
  readonly operator: { readonly name: string; readonly contact: string };
  readonly identity: { readonly did: string; readonly registry_address: string; readonly supplier_key: string };
  /** The public values of the supplier key of the runtime, and the key hashes of the service key and of the two delegation keys. No key is in the manifest. */
  readonly keys: { readonly supplier_pkh: string; readonly pub_key_hex: string; readonly buyer_pkh: string; readonly delegation_pkhs: readonly [string, string] };
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
    readonly input_limits: { readonly request_bytes: number; readonly order_id_chars: number; readonly tenant_chars: number; readonly justification_chars: number };
  };
  readonly behaviour: { readonly data_handling: string; readonly third_parties: readonly string[] } & BehaviourAdditions<'prior-authorization-agent'>;
  readonly status: { readonly chip: StatusChip; readonly since: string };
  readonly gaps: readonly string[];
  readonly links: { readonly spec: string; readonly source: string; readonly explorer_advert: string };
}

/**
 * The manifest of the agent. The values come from `env`: the operator contact, the DID, the identity registry, the supplier key and the key hashes of the service key and of the two delegation keys, the models and
 * the price ceiling, the price and the window of the advert, the version, the status and the link to the advert. A setting that breaks a rule throws an Error that names the setting. A value that stands for
 * itself in the template is a name in angle brackets (`TEMPLATE_ENV`); `renderManifest` refuses a served manifest that has one.
 */
export function manifestFromEnv(env: NodeJS.ProcessEnv = process.env): PriorAuthManifest {
  const model = modelOf(env);
  const supplier = supplierOf(env);
  const [servicePkh, firstPkh, secondPkh] = keyHashesOf(env, supplier.pkh);
  const did = didOf(env);
  const [first, second, third] = PRIORAUTH_CLAIM.statements;
  const additions = buildBehaviour('prior-authorization-agent', {
    claim: [first.text, second.text, third.text],
    model: { allowlist: [...model.allowlist], max_price_lovelace: Number(model.maxPriceLovelace) },
    relying_on: { mock_systems: MOCK_ROUTES, gateway_routes: GATEWAY_ROUTES },
  });
  if (!additions.ok) throw new Error(`the behaviour of the manifest is refused: ${additions.detail}`);
  return {
    schema: MANIFEST_SCHEMA,
    name: 'Prior Authorization Agent',
    capability_id: PRIORAUTH_CAPABILITIES.draft,
    version: versionOf(env),
    description: DESCRIPTION,
    operator: { name: 'Apex Fusion Foundation', contact: contactOf(env) },
    identity: manifestIdentity(did, supplier.pkh, registryOf(env)),
    keys: { supplier_pkh: supplier.pkh, pub_key_hex: supplier.pubKeyHex, buyer_pkh: servicePkh, delegation_pkhs: [firstPkh, secondPkh] },
    interface: {
      request_schema: REQUEST_SCHEMA,
      response_schema: { $ref: `${SPEC_URL}#response` },
      routes: { job: '/v1/job', status: '/status', capability: '/capability' },
      notes: [...NOTES],
    },
    terms: {
      price_lovelace: priceOf(env),
      supplier_bond_lovelace: SUPPLIER_BOND_LOVELACE,
      buyer_bond_lovelace: BUYER_BOND_LOVELACE,
      max_processing_ms: processingWindowOf(env),
      input_limits: { request_bytes: MAX_REQUEST_BYTES, order_id_chars: ORDER_ID_CHARS, tenant_chars: TENANT_CHARS, justification_chars: MAX_JUSTIFICATION_CHARS },
    },
    behaviour: { data_handling: DATA_HANDLING, third_parties: [...THIRD_PARTIES], ...additions.value },
    status: statusOf(env),
    gaps: [...gapsFor()],
    links: { spec: SPEC_URL, source: SOURCE_URL, explorer_advert: explorerUrlOf(env) },
  };
}

/**
 * The values of the operator as the placeholders that the template file shows, and the two limits of the model hire as the values that the example environment of the pack holds. The model and its ceiling are not
 * placeholders: a model name is a value that the manifest folder checks, and a placeholder is not one.
 */
export const TEMPLATE_ENV = {
  OPERATOR_CONTACT: placeholderOf('OPERATOR_CONTACT'),
  AGENT_DID: placeholderOf('AGENT_DID'),
  SUPPLIER_PKH: placeholderOf('SUPPLIER_PKH'),
  SUPPLIER_PUB_KEY_HEX: placeholderOf('SUPPLIER_PUB_KEY_HEX'),
  PRIORAUTH_SERVICE_PKH: placeholderOf('PRIORAUTH_SERVICE_PKH'),
  PRIORAUTH_DELEGATION_1_PKH: placeholderOf('PRIORAUTH_DELEGATION_1_PKH'),
  PRIORAUTH_DELEGATION_2_PKH: placeholderOf('PRIORAUTH_DELEGATION_2_PKH'),
  LLM_MODEL_ALLOWLIST: 'deepseek/deepseek-v4-flash',
  LLM_MAX_PRICE_LOVELACE: '1000000',
} as const;

/** The text of agent.json.template: the manifest with the placeholders, indented, with a line break at the end. `pnpm --filter @vsa/prior-authorization-agent template` writes it. It is never served. */
export function renderTemplate(): string {
  const rendered = renderManifest('prior-authorization-agent', (setting) => manifestFromEnv({ ...TEMPLATE_ENV, FAULT_MODE: setting }), { template: true });
  if (!rendered.ok) throw new Error(`the template is refused (${rendered.code}): ${rendered.detail}`);
  return rendered.value.text;
}
