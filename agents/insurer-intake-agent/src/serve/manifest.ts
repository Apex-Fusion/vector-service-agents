// agents/insurer-intake-agent/src/serve/manifest.ts
// The manifest the service publishes at `GET /agent.json`: `vector.agent-manifest.v2`, in the form of the other agents of this repository, with the additions that the manifest folder of the kit builds under
// `behaviour` (`buildBehaviour`: the claim, the possible fault values, the model limits and the routes that the agent calls). The service renders the manifest one time when it starts (`renderManifest` of the kit,
// which renders it more than once and refuses it when two renders differ in one byte), serves those bytes, and the advert holds their SHA-256. Nothing in the manifest depends on the fault switch (the agent has no
// fault value), and nothing in it is a secret: it holds the key hash and the public key of the supplier key and the key hash of the service key, and no key.
//
// `manifestFromEnv` takes the environment as a parameter and reads the settings that it publishes and no other, so the template (`renderTemplate`) and the served manifest are made by the same code. It reads no
// key, no token and no setting of another part of the service.
import { given, hexOf, requiredEnv, statusChip, statusSince } from '@vsa/service-kit';
import type { StatusChip } from '@vsa/service-kit';
import { MANIFEST_SCHEMA, MAX_URI_CHARS, buildBehaviour, renderManifest } from '@vsa/usecase-kit/manifest';
import { INTAKE_CLAIM, MAX_JUSTIFICATION_CHARS, PRIORAUTH_CAPABILITIES, PRIORAUTH_MODELS, PRIORAUTH_REQUEST_SCHEMA } from '@vsa/usecase-kit/priorauth';
import { HANDOFF_SCHEMA, MAX_REQUEST_BYTES } from '@vsa/usecase-kit/protocol';
import type { BehaviourAdditions } from '@vsa/usecase-kit/protocol';
import { identityRegistryOf, manifestIdentity } from '@vsa/vector-read';
import { gapsFor } from './gaps.ts';
import { keyClashOf } from './keys.ts';
import { BUYER_BOND_LOVELACE, SUPPLIER_BOND_LOVELACE, agentDidOf, modelOf, priceOf, processingWindowOf, supplierKeyOf } from './settings.ts';
import type { SupplierKey } from './settings.ts';

export const SPEC_URL = 'https://github.com/Apex-Fusion/vector-service-agents/blob/main/specs/insurer-intake-agent.md';
export const SOURCE_URL = 'https://github.com/Apex-Fusion/vector-service-agents/tree/main/agents/insurer-intake-agent';

/** The capability sentence of the agent: what it does for an insurer. The README repeats it. */
export const DESCRIPTION =
  "For an insurer: takes an authorization request from the agent of a care provider, checks who sent it and that the provider's reviewer signed off exactly this request, "
  + "decides whether it is complete, files it in the insurer's system and returns an intake record; it makes an intake decision and no coverage decision.";

/**
 * The date since which the status of the agent holds, when AGENT_STATUS_SINCE is not set. The page of the agent holds the same date, and the template and the README line of the status show it. It stands here and
 * nowhere else in the sources.
 */
export const STATUS_SINCE_DEFAULT = '2026-11-24';

const DID_PATTERN = '^did:vector:[0-9a-f]{64}$';
const HEX_PATTERN = '^[0-9a-f]{64}$';
const ID_PATTERN = '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$';
const TENANT_PATTERN = '^[a-z0-9][a-z0-9-]{0,47}$';
const REF_PATTERN = '^[0-9a-f]{64}#[0-9]{1,10}$';

const idOf = (description: string) => ({ type: 'string', pattern: ID_PATTERN, description }) as const;

/** The authorization request, as a JSON Schema. It is the document of the handoff. A member that is not listed is refused. */
const AUTHORIZATION_REQUEST_SCHEMA = {
  type: 'object',
  required: [
    'schema', 'request_number', 'tenant', 'order_id', 'patient_ref', 'ordering_clinician_ref', 'service_code', 'diagnosis_codes', 'justification', 'guideline_refs', 'record_refs', 'record_set_sha256',
    'insurer_did', 'advert_ref',
  ],
  additionalProperties: false,
  properties: {
    schema: { const: PRIORAUTH_REQUEST_SCHEMA },
    request_number: idOf('The number of the request: the tenant, a hyphen and a counter. The insurer portal files one entry for each number, without regard to case'),
    tenant: { type: 'string', pattern: TENANT_PATTERN, description: 'The tenant of the mock systems: 1 to 48 characters, lower-case letters, digits and hyphens, starting with a letter or a digit' },
    order_id: idOf('The identifier of the clinical order'),
    patient_ref: idOf('A synthetic reference. No patient exists behind it'),
    ordering_clinician_ref: idOf('The reference of the ordering clinician, from the order'),
    service_code: idOf('The code of the service that the order asks for'),
    diagnosis_codes: {
      type: 'array', minItems: 1, maxItems: 8, items: { type: 'string', minLength: 1, maxLength: 16 },
      description: 'The diagnosis codes of the order: 1 to 8 codes of 1 to 16 UTF-16 code units each, with no control, format or separator character',
    },
    justification: {
      type: 'string', minLength: 1, maxLength: MAX_JUSTIFICATION_CHARS,
      description: `The reasons for the service: 1 to ${MAX_JUSTIFICATION_CHARS} characters, with no control or hidden character but the line feed`,
    },
    guideline_refs: { type: 'array', maxItems: 20, uniqueItems: true, items: idOf('The identifier of a criterion of the guideline that the justification cites'), description: 'The criteria that the justification cites, none twice' },
    record_refs: { type: 'array', maxItems: 50, uniqueItems: true, items: idOf('The identifier of a record that the justification cites'), description: 'The records that the justification cites, none twice' },
    record_set_sha256: { type: 'string', pattern: HEX_PATTERN, description: 'The SHA-256 of the record set that the request draws on' },
    insurer_did: { type: 'string', pattern: DID_PATTERN, description: 'The DID of the insurer that the request is for: this agent' },
    advert_ref: { type: 'string', pattern: REF_PATTERN, description: 'The reference of the advert of this agent that the escrow of the request was posted on' },
  },
} as const;

/** What the agent takes, as a JSON Schema: the handoff of use case 2 (prior authorization), with an authorization request as its document. A member that is not listed is refused. */
export const REQUEST_SCHEMA = {
  type: 'object',
  required: ['schema', 'use_case', 'sender_did', 'delegation', 'document', 'salt', 'approval'],
  additionalProperties: false,
  properties: {
    schema: { const: HANDOFF_SCHEMA },
    use_case: { const: 'prior-authorization' },
    sender_did: { type: 'string', pattern: DID_PATTERN, description: 'The DID of the sender: the agent of the care provider that hires this agent' },
    delegation: { type: 'string', pattern: HEX_PATTERN, description: 'The identifier of the delegation that names the sender as its delegate, and whose vault paid for the job' },
    document: AUTHORIZATION_REQUEST_SCHEMA,
    salt: { type: 'string', pattern: HEX_PATTERN, description: 'The salt of the proposal that the provider signed off' },
    approval: {
      description: "The sign-off of the provider's reviewer for the digest of the salt and the document, or null: this agent refuses a request with no valid sign-off",
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

const DATA_HANDLING =
  'The authorization request, the sign-off reference and the requirements are synthetic data. They are held in memory while a job runs, and none of them is kept after the job. '
  + "The filed request lives in the insurer portal of the mock service. On disk the service keeps the bookkeeping of the escrows that it posts for its model call, the book of the request numbers that it filed "
  + '(the tenant, the request number and the intake id of each request), and the journal of its challenges. '
  + 'On a digest mismatch it publishes an evidence document and a challenge on the ledger. '
  + 'The log carries job outcomes, counts and codes, never a request, a requirement or a key.';

const THIRD_PARTIES = [
  'the identity gateway (the resolution of the DID of the sender, and the request for the JWT-SVID)',
  'the ledger, read only (the delegation, the escrow paid from a vault, the sign-off and the other attestations of the sender)',
  'the insurer portal of the mock service (the read of the requirements and the filing of the request, with the JWT-SVID)',
  'a model supplier on the Vector marketplace, hired through a bonded escrow, and the model provider behind it (the prompt of the decision: the members ordering_clinician_ref, diagnosis_codes, justification, '
  + 'guideline_refs, record_refs and record_set_sha256 of the request, and the requirements, and no other member of the request)',
  'the Vector ledger (the escrow of each model hire, which carries only hashes, and, after a digest mismatch, the evidence document and the challenge)',
];

const NOTES = [
  'The request is the handoff of use case 2 (prior authorization): its use case is prior-authorization, and its document is an authorization request. '
  + 'A handoff for another use case, and a document that is not an authorization request, are refused with bad_shape (400).',
  'Before the runtime claims the escrow, the service checks the sender, the delegation, the payment from a vault and the sign-off of the provider, '
  + 'and then that the request is for this insurer, that it names the advert that the escrow was posted on, and that its request number is new. '
  + 'A check that fails is a refusal with its code (403), and the escrow stays open. A source that cannot be read is 503 check_unavailable.',
  'After the Claim, the service reads the requirements of the insurer portal and reports the provenance, software and principal-binding attestations of the sender, without refusing on them. '
  + 'The model decides whether the request is complete. The service files the request in the insurer portal, complete or not, and returns an intake record.',
  `The advert and every receipt name the model ${PRIORAUTH_MODELS.intake}. The receipt commits to the SHA-256 of the intake record as the service returns it.`,
  'The intake record is an intake decision. It is not a coverage decision.',
];

const MOCK_ROUTES = ['GET /t/{tenant}/insurer/requirements/{service_code}', 'POST /t/{tenant}/insurer/requests'];
const GATEWAY_ROUTES = ['POST /spiffe/jwt-svid', 'GET /1.0/identifiers/{did}'];

/**
 * `text` with each of `values` taken out of it: a quoted value is given by its length, and so is a value of 8 characters or more wherever it stands. A helper of the identity code quotes the value that it refuses,
 * and a value can be a key or a token in the wrong line of a file.
 */
function hidden(text: string, values: readonly string[]): string {
  let out = text;
  for (const value of values) {
    if (value === '') continue;
    out = out.replaceAll(`"${value}"`, `${value.length} characters`);
    if (value.length >= 8) out = out.replaceAll(value, `(${value.length} characters)`);
  }
  return out;
}

/** A value that stands for itself in the template: the whole text is a name in angle brackets. A key is never one: it has no angle bracket. */
const PLACEHOLDER = /^<[A-Z][A-Z0-9_]*>$/;
const stands = (value: string | undefined): boolean => PLACEHOLDER.test(given(value));

/**
 * The DID, the supplier key and the key hash of the service key, as the manifest publishes them. A value that stands for itself in the template is kept as it is. Any other value must be of the form that its reader
 * takes: `agentDidOf` for the DID, `supplierKeyOf` for the supplier key (the public key must hash to the key hash), and 56 hex characters for the key hash of the service. So a key in the wrong line of the
 * environment is refused here and never published, whoever calls this function. The key hash of the service is not the key hash of the supplier: the supplier key is the key of the runtime.
 */
function publishedKeysOf(env: NodeJS.ProcessEnv): { readonly did: string; readonly supplier: SupplierKey; readonly servicePkh: string } {
  const did = stands(env.AGENT_DID) ? given(env.AGENT_DID) : agentDidOf(env);
  const supplier = stands(env.SUPPLIER_PKH) && stands(env.SUPPLIER_PUB_KEY_HEX)
    ? { pkh: given(env.SUPPLIER_PKH), pubKeyHex: given(env.SUPPLIER_PUB_KEY_HEX) }
    : supplierKeyOf(env);
  const servicePkh = stands(env.INTAKE_SERVICE_PKH)
    ? given(env.INTAKE_SERVICE_PKH)
    : hexOf('INTAKE_SERVICE_PKH', requiredEnv('INTAKE_SERVICE_PKH', env.INTAKE_SERVICE_PKH, 'the key hash of the service key, published in the manifest'), 28);
  if (keyClashOf({ service: { pkh: servicePkh } }, supplier.pkh) !== null) {
    throw new Error("environment variable INTAKE_SERVICE_PKH names the supplier key: the supplier key is the runtime's, and the service key must be a key of its own");
  }
  return { did, supplier, servicePkh };
}

/**
 * The identity block of the manifest, which vector-read builds the same way for every agent of this repository: the DID, the address of the identity registry of IDENTITY_POLICY_ID and IDENTITY_ADDRESS, and the
 * listed supplier key, `<DID>#<key hash>`. A value that breaks a rule stops the start, and the error names the setting and never repeats the value.
 */
function identityFromEnv(env: NodeJS.ProcessEnv, did: string, supplierPkh: string): { readonly did: string; readonly registry_address: string; readonly supplier_key: string } {
  const values = [given(env.IDENTITY_POLICY_ID), given(env.IDENTITY_ADDRESS)];
  try {
    return manifestIdentity(did, supplierPkh, identityRegistryOf(env.IDENTITY_POLICY_ID, env.IDENTITY_ADDRESS));
  } catch (error) {
    const text = hidden((error as Error).message, values);
    throw new Error(text.startsWith('environment variable ') ? text : `environment variable ${text}`);
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

/** The manifest of the Insurer Intake Agent: the members of the manifest v2 that this agent writes, and under `behaviour` the additions of the kit. */
export interface IntakeManifest {
  readonly schema: typeof MANIFEST_SCHEMA;
  readonly name: 'Insurer Intake Agent';
  readonly capability_id: typeof PRIORAUTH_CAPABILITIES.intake;
  readonly version: string;
  readonly description: string;
  readonly operator: { readonly name: string; readonly contact: string };
  readonly identity: { readonly did: string; readonly registry_address: string; readonly supplier_key: string };
  /** The public values of the supplier key of the runtime, and the key hash of the service key. No key is in the manifest. */
  readonly keys: { readonly supplier_pkh: string; readonly pub_key_hex: string; readonly buyer_pkh: string };
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
  readonly behaviour: { readonly data_handling: string; readonly third_parties: readonly string[] } & BehaviourAdditions<'insurer-intake-agent'>;
  readonly status: { readonly chip: StatusChip; readonly since: string };
  readonly gaps: readonly string[];
  readonly links: { readonly spec: string; readonly source: string; readonly explorer_advert: string };
}

/**
 * The manifest of the agent. The values come from `env`: the operator contact, the DID, the identity registry, the supplier key and the key hash of the service key, the models and the price ceiling, the price
 * and the window of the advert, the version, the status and the link to the advert. A setting that breaks a rule throws an Error that names the setting. A value that stands for itself in the template is a name
 * in angle brackets (`TEMPLATE_ENV`); `renderManifest` refuses a served manifest that has one. The DID and the keys are checked here, as `publishedKeysOf` says, so a key never reaches a published line.
 */
export function manifestFromEnv(env: NodeJS.ProcessEnv = process.env): IntakeManifest {
  const model = modelOf(env);
  const { did, supplier, servicePkh } = publishedKeysOf(env);
  const [first, second, third] = INTAKE_CLAIM.statements;
  const additions = buildBehaviour('insurer-intake-agent', {
    claim: [first.text, second.text, third.text],
    model: { allowlist: [...model.allowlist], max_price_lovelace: Number(model.maxPriceLovelace) },
    relying_on: { mock_systems: MOCK_ROUTES, gateway_routes: GATEWAY_ROUTES },
  });
  if (!additions.ok) throw new Error(`the behaviour of the manifest is refused: ${additions.detail}`);
  return {
    schema: MANIFEST_SCHEMA,
    name: 'Insurer Intake Agent',
    capability_id: PRIORAUTH_CAPABILITIES.intake,
    version: versionOf(env),
    description: DESCRIPTION,
    operator: { name: 'Apex Fusion Foundation', contact: contactOf(env) },
    identity: identityFromEnv(env, did, supplier.pkh),
    keys: { supplier_pkh: supplier.pkh, pub_key_hex: supplier.pubKeyHex, buyer_pkh: servicePkh },
    interface: {
      request_schema: REQUEST_SCHEMA,
      response_schema: { $ref: `${SPEC_URL}#response` },
      routes: { job: '/v1/job', status: '/status', capability: '/capability' },
      notes: [...NOTES],
    },
    terms: {
      price_lovelace: priceOf(env), supplier_bond_lovelace: SUPPLIER_BOND_LOVELACE, buyer_bond_lovelace: BUYER_BOND_LOVELACE, max_processing_ms: processingWindowOf(env),
      input_limits: { request_bytes: MAX_REQUEST_BYTES },
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
  OPERATOR_CONTACT: '<OPERATOR_CONTACT>', AGENT_DID: '<AGENT_DID>', SUPPLIER_PKH: '<SUPPLIER_PKH>', SUPPLIER_PUB_KEY_HEX: '<SUPPLIER_PUB_KEY_HEX>', INTAKE_SERVICE_PKH: '<INTAKE_SERVICE_PKH>',
  LLM_MODEL_ALLOWLIST: 'deepseek/deepseek-v4-flash', LLM_MAX_PRICE_LOVELACE: '1000000',
} as const;

/** The text of agent.json.template: the manifest with the placeholders, indented, with a line break at the end. `pnpm --filter @vsa/insurer-intake-agent template` writes it. It is never served. */
export function renderTemplate(): string {
  const rendered = renderManifest('insurer-intake-agent', (setting) => manifestFromEnv({ ...TEMPLATE_ENV, FAULT_MODE: setting }), { template: true });
  if (!rendered.ok) throw new Error(`the template is refused (${rendered.code}): ${rendered.detail}`);
  return rendered.value.text;
}
