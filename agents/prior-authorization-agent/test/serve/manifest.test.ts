// agents/prior-authorization-agent/test/serve/manifest.test.ts
// The manifest of the Prior Authorization Agent: the same bytes on every render, and the same bytes whatever the fault setting is; a manifest that reads the settings that it names and no other, and that holds no
// key and no token; the members, the claim, the gaps in their order, and the schema of the requests held to the parsers of the kit; a template file that equals the render of the template; and the terms, which agree
// with the lock that a Post makes for the advert: the price and both bonds, 3 + 1 + 1 = 5 units. No test here starts a service.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { ACCEPT_WINDOW_MS, DELIVER_BY_BUFFER_MS, MAX_ESCROW_LOVELACE, fleetPostTerms, planFleetPostEscrow, rawHexToBech32 } from '@vsa/buyer-core';
import { ROUTES } from '@vsa/usecase-kit/access';
import { faultGap, parseBehaviourAdditions, renderManifest } from '@vsa/usecase-kit/manifest';
import { MAX_JUSTIFICATION_CHARS, PRIORAUTH_CAPABILITIES, PRIORAUTH_CLAIM, PRIORAUTH_MODELS, PRIORAUTH_REQUEST_SCHEMA, parsePriorAuthRequest } from '@vsa/usecase-kit/priorauth';
import { AGENT_KINDS, COSIGN_RULE, FAULT_MODES, MAX_REQUEST_BYTES, accepted, checkMembers, makeProposal, parseRequest } from '@vsa/usecase-kit/protocol';
import { REGISTRY_POLICY, identityRegistryOf } from '@vsa/vector-read';
import type { AdvertDatum } from '@vsa/vector-read';
import { CHALLENGE_GAP, INSURER_GAP, JUSTIFICATION_GAP, KEYS_GAP, MODEL_GAP, NOT_SHOWN_GAP, RECORD_SET_GAP, SIGN_OFF_GAP, SYNTHETIC_GAP, gapsFor } from '../../src/serve/gaps.ts';
import { KEY_ROLES, keyOf } from '../../src/serve/keys.ts';
import {
  DESCRIPTION, ORDER_ID_CHARS, REQUEST_SCHEMA, SOURCE_URL, SPEC_URL, STATUS_SINCE_DEFAULT, TEMPLATE_ENV, TENANT_CHARS, manifestFromEnv, renderTemplate,
} from '../../src/serve/manifest.ts';
import type { PriorAuthManifest } from '../../src/serve/manifest.ts';
import { AGENT_DID, FakeClock, KEY_NUMBERS, PKH_VARIABLES, PRINCIPAL, SUPPLIER, TOKEN, completeEnv, messageOf, rawKey, shows } from './support.ts';

const KIND = 'prior-authorization-agent';
const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');
const templateFile = fileURLToPath(new URL('../../agent.json.template', import.meta.url));

/** The environment of the manifest: the complete environment, with the key hashes that the service derives from its seven keys. */
const manifestEnv = (over: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => completeEnv({
  ...Object.fromEntries(KEY_ROLES.map((role) => [PKH_VARIABLES[role], keyOf(rawKey(KEY_NUMBERS[role])).pkh])),
  ...over,
});

/** The manifest as the service renders it: the kit renders the builder for each fault setting of the kind, and gives the bytes when the renders agree. */
const render = (env: NodeJS.ProcessEnv = manifestEnv()) => {
  const rendered = renderManifest(KIND, (setting) => manifestFromEnv({ ...env, FAULT_MODE: setting }));
  if (!rendered.ok) throw new Error(`${rendered.code}: ${rendered.detail}`);
  return rendered.value;
};
const manifestOf = (over: NodeJS.ProcessEnv = {}): PriorAuthManifest => JSON.parse(render(manifestEnv(over)).text) as PriorAuthManifest;

/** The settings that the manifest reads, and no others: the ones that it publishes. */
const MANIFEST_SETTINGS = [
  'ADVERT_EXPLORER_URL', 'ADVERT_MAX_PROCESSING_MS', 'ADVERT_PRICE_LOVELACE', 'AGENT_DID', 'AGENT_STATUS_CHIP', 'AGENT_STATUS_SINCE', 'AGENT_VERSION', 'IDENTITY_ADDRESS', 'IDENTITY_POLICY_ID', 'LLM_MAX_PRICE_LOVELACE',
  'LLM_MODEL_ALLOWLIST', 'OPERATOR_CONTACT', 'PRIORAUTH_DELEGATION_1_PKH', 'PRIORAUTH_DELEGATION_2_PKH', 'PRIORAUTH_SERVICE_PKH', 'SUPPLIER_PKH', 'SUPPLIER_PUB_KEY_HEX',
];

describe('the bytes of the manifest', () => {
  test('are the same on every render: three renders give one text and one hash, and the hash is the SHA-256 of the text', () => {
    const [first, second, third] = [render(), render(), render()];
    expect(second).toStrictEqual(first);
    expect(third).toStrictEqual(first);
    expect(first.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(first.sha256).toBe(sha256(first.text));
    expect(JSON.stringify(manifestFromEnv(manifestEnv()))).toBe(first.text);
    expect(first.text).not.toContain('\n');
  });

  test('are the same for each fault setting: the empty setting, the one value of this agent, a stray value and no setting give one text, and the builder takes none of them from the environment', () => {
    const env = manifestEnv();
    const texts = ['', 'alter_after_approval', 'anything', undefined].map((setting) => JSON.stringify(manifestFromEnv({ ...env, FAULT_MODE: setting })));
    expect(new Set(texts).size).toBe(1);
    expect(texts[0]).toBe(render().text);
    expect(FAULT_MODES[KIND]).toStrictEqual(['alter_after_approval']);
    // The kit renders for the empty setting twice and for each value of the kind, and it refuses a builder that gives other bytes.
    const changing = renderManifest(KIND, (setting) => ({ ...manifestFromEnv(env), version: setting === '' ? '0.1.0' : '0.1.1' }));
    expect(changing.ok).toBe(false);
    if (!changing.ok) expect(changing.code).toBe('manifest_changes_with_fault');
  });

  test('change with a setting that the manifest publishes and with nothing else: another contact, DID, key, model, price or window gives another hash, and a setting that is not in it gives the same one', () => {
    const base = render().sha256;
    for (const over of [
      { OPERATOR_CONTACT: 'other@example.test' }, { AGENT_DID: `did:vector:${'ab'.repeat(32)}` }, { SUPPLIER_PKH: PRINCIPAL.keyHash, SUPPLIER_PUB_KEY_HEX: PRINCIPAL.publicKey },
      { PRIORAUTH_SERVICE_PKH: PRINCIPAL.keyHash }, { PRIORAUTH_DELEGATION_1_PKH: PRINCIPAL.keyHash }, { PRIORAUTH_DELEGATION_2_PKH: PRINCIPAL.keyHash }, { IDENTITY_POLICY_ID: 'ab'.repeat(28) },
      { LLM_MODEL_ALLOWLIST: 'other/model' }, { LLM_MAX_PRICE_LOVELACE: '250000' }, { ADVERT_PRICE_LOVELACE: '4000000' }, { ADVERT_MAX_PROCESSING_MS: '2400000' }, { AGENT_VERSION: '0.2.0' },
      { AGENT_STATUS_CHIP: 'live' }, { AGENT_STATUS_SINCE: '2026-12-01' }, { ADVERT_EXPLORER_URL: 'https://explorer.example.test/advert' },
    ]) {
      expect(render(manifestEnv(over)).sha256, JSON.stringify(Object.keys(over))).not.toBe(base);
    }
    for (const over of [
      {
        PORT: '9999', HOST: '127.0.0.2', MOCK_PUBLIC_BASE: 'https://other.example', LLM_MAX_SUPPLIER_BOND_LOVELACE: '3000000', HANDOFF_MAX_PRICE_LOVELACE: '1', DISPUTE_CHALLENGE_STAKE_LOVELACE: '1',
        COSIGN_ALLOWLIST: '', RECORD_READER_DID: AGENT_DID, FAULT_MODE: 'anything',
      },
      { VECTOR_MODULE1_MANIFEST: undefined, SERVICE_AUTH_HEADER: undefined },
      Object.fromEntries(KEY_ROLES.filter((role) => !['service', 'delegation1', 'delegation2'].includes(role)).map((role) => [PKH_VARIABLES[role], PRINCIPAL.keyHash])),
    ]) {
      expect(render(manifestEnv(over)).sha256, JSON.stringify(Object.keys(over))).toBe(base);
    }
  });

  test('read the settings that the manifest publishes and no other: a probe sees each read of the environment, and none is a secret, the fault setting or a setting of another part of the service', () => {
    const seen = new Set<string>();
    let listed = false;
    const env = new Proxy<NodeJS.ProcessEnv>({ ...manifestEnv() }, {
      get: (target, name) => {
        if (typeof name === 'string') seen.add(name);
        return typeof name === 'string' ? target[name] : undefined;
      },
      has: (target, name) => {
        if (typeof name === 'string') seen.add(name);
        return name in target;
      },
      ownKeys: (target) => {
        listed = true;
        return Reflect.ownKeys(target);
      },
    });
    manifestFromEnv(env);
    expect(listed, 'the builder lists the environment').toBe(false);
    expect([...seen].sort()).toStrictEqual([...MANIFEST_SETTINGS].sort());
    expect(seen.has('FAULT_MODE')).toBe(false);
  });

  test('hold no key and no token: no form of a stand-in key or of the token is in the text, and a secret in every setting that the manifest does not read changes no byte', () => {
    const { text } = render();
    const keys = KEY_ROLES.map((role) => rawKey(KEY_NUMBERS[role]));
    const secrets = [...keys, ...keys.map((key) => rawHexToBech32(key)), TOKEN, TOKEN.slice('Bearer '.length)];
    for (const secret of secrets) expect(text.toLowerCase(), secret.slice(0, 8)).not.toContain(secret.toLowerCase());
    const env = manifestEnv();
    const others = Object.keys(env).filter((name) => !MANIFEST_SETTINGS.includes(name));
    expect(others).toContain('SERVICE_AUTH_HEADER');
    expect(others.length).toBeGreaterThan(10);
    const planted = { ...env, ...Object.fromEntries(others.map((name, index) => [name, secrets[index % secrets.length]])), SERVICE_AUTH_HEADER: TOKEN };
    expect(render(planted)).toStrictEqual(render());
  });

  test('hold no fault value but the one of this agent, in the list of possible values and in the one gap sentence of the kit, and no member fault_mode', () => {
    const { text } = render();
    const foreign = AGENT_KINDS.filter((kind) => kind !== KIND).flatMap((kind) => [...FAULT_MODES[kind]]);
    expect(foreign.length).toBeGreaterThan(0);
    for (const value of foreign) expect(text, value).not.toContain(value);
    expect(text).not.toMatch(/"fault_mode"\s*:/);
    expect(manifestOf().behaviour.fault_modes).toStrictEqual(['alter_after_approval']);
    const sentence = faultGap(KIND);
    expect(sentence).not.toBeNull();
    expect(manifestOf().gaps.filter((gap) => gap === sentence)).toHaveLength(1);
    // The value stands in the list one time and in the sentence one time, and nowhere else.
    expect(text.split('alter_after_approval')).toHaveLength(3);
  });
});

describe('the template', () => {
  test('is the render of the template environment, byte for byte: indented JSON with a line break at the end, and the file equals it', () => {
    const file = readFileSync(templateFile, 'utf8');
    expect(file).toBe(renderTemplate());
    expect(renderTemplate()).toBe(renderTemplate());
    expect(file.endsWith('}\n')).toBe(true);
    expect(file.startsWith('{\n  "schema": "vector.agent-manifest.v2",\n')).toBe(true);
    expect(JSON.parse(file)).toMatchObject({ name: 'Prior Authorization Agent', capability_id: 'health.priorauth.draft.v1', status: { chip: 'proposed', since: STATUS_SINCE_DEFAULT } });
  });

  test('names a placeholder for each value of the operator that the manifest publishes, and no other', () => {
    const file = readFileSync(templateFile, 'utf8');
    const found = [...new Set(file.match(/<[A-Z][A-Z0-9_]*>/g) ?? [])].sort();
    expect(found).toStrictEqual([
      '<AGENT_DID>', '<OPERATOR_CONTACT>', '<PRIORAUTH_DELEGATION_1_PKH>', '<PRIORAUTH_DELEGATION_2_PKH>', '<PRIORAUTH_SERVICE_PKH>', '<SUPPLIER_PKH>', '<SUPPLIER_PUB_KEY_HEX>',
    ]);
    for (const [name, value] of Object.entries(TEMPLATE_ENV)) if (value.startsWith('<')) expect(value).toBe(`<${name}>`);
    expect(TEMPLATE_ENV.LLM_MODEL_ALLOWLIST).toBe(completeEnv().LLM_MODEL_ALLOWLIST);
    expect(TEMPLATE_ENV.LLM_MAX_PRICE_LOVELACE).toBe(completeEnv().LLM_MAX_PRICE_LOVELACE);
    const template = JSON.parse(file) as PriorAuthManifest;
    expect(template.identity.supplier_key).toBe('<AGENT_DID>#<SUPPLIER_PKH>');
    expect(template.keys).toStrictEqual({
      supplier_pkh: '<SUPPLIER_PKH>', pub_key_hex: '<SUPPLIER_PUB_KEY_HEX>', buyer_pkh: '<PRIORAUTH_SERVICE_PKH>', delegation_pkhs: ['<PRIORAUTH_DELEGATION_1_PKH>', '<PRIORAUTH_DELEGATION_2_PKH>'],
    });
  });

  test('holds the constants of the manifest and is never the manifest that the service serves: the terms, the gaps and the claim are the same, and a served manifest with a placeholder is refused', () => {
    const template = JSON.parse(renderTemplate()) as PriorAuthManifest;
    const served = manifestOf();
    expect([template.terms, template.gaps, template.behaviour, template.interface]).toStrictEqual([served.terms, served.gaps, served.behaviour, served.interface]);
    expect(renderTemplate()).not.toBe(render().text);
    expect(render().text).not.toMatch(/<[A-Z][A-Z0-9_]*>/);
    const refused = renderManifest(KIND, () => manifestFromEnv(TEMPLATE_ENV));
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.code).toBe('manifest_has_placeholder');
    expect(renderManifest(KIND, () => manifestFromEnv(TEMPLATE_ENV), { template: true }).ok).toBe(true);
  });
});

describe('the members of the manifest', () => {
  test('name the agent, its capability, its identity, its keys, its status and its links', () => {
    const manifest = manifestOf();
    expect([manifest.schema, manifest.name, manifest.capability_id, manifest.version]).toStrictEqual(['vector.agent-manifest.v2', 'Prior Authorization Agent', 'health.priorauth.draft.v1', '0.1.0']);
    expect(manifest.capability_id).toBe(PRIORAUTH_CAPABILITIES.draft);
    expect(manifest.description).toBe(DESCRIPTION);
    expect(manifest.operator).toStrictEqual({ name: 'Apex Fusion Foundation', contact: 'ops@example.test' });
    expect(manifest.identity).toStrictEqual({ did: AGENT_DID, registry_address: identityRegistryOf(completeEnv().IDENTITY_POLICY_ID, undefined)?.address, supplier_key: `${AGENT_DID}#${SUPPLIER.keyHash}` });
    expect(manifest.identity.registry_address).toMatch(/^addr1/);
    expect(manifest.status).toStrictEqual({ chip: 'proposed', since: STATUS_SINCE_DEFAULT });
    expect(manifest.links).toStrictEqual({ spec: SPEC_URL, source: SOURCE_URL, explorer_advert: '' });
    expect(SPEC_URL.endsWith('/specs/prior-authorization-agent.md')).toBe(true);
    expect(SOURCE_URL.endsWith('/agents/prior-authorization-agent')).toBe(true);
    // The model string of the advert and of every receipt is the one of the kit.
    expect(PRIORAUTH_MODELS.draft).toBe('prior-authorization-agent-v1');
  });

  test('the keys are the supplier key of the runtime (its public values) and the key hashes of the service key and of the two delegation keys, and none of the four keys of the subagents', () => {
    const manifest = manifestOf();
    const [service, first, second] = (['service', 'delegation1', 'delegation2'] as const).map((role) => keyOf(rawKey(KEY_NUMBERS[role])).pkh);
    expect(manifest.keys).toStrictEqual({ supplier_pkh: SUPPLIER.keyHash, pub_key_hex: SUPPLIER.publicKey, buyer_pkh: service, delegation_pkhs: [first, second] });
    const { text } = render();
    for (const role of KEY_ROLES.filter((name) => !['service', 'delegation1', 'delegation2'].includes(name))) {
      expect(text.includes(keyOf(rawKey(KEY_NUMBERS[role])).pkh), role).toBe(false);
    }
  });

  test('the description says what the agent does for a care provider, in one sentence', () => {
    expect(DESCRIPTION.startsWith('For a care provider: reads the records behind a clinical order')).toBe(true);
    expect(DESCRIPTION).toContain('drafts an insurer-format authorization request with its justification');
    expect(DESCRIPTION).toContain("once the provider's reviewer has signed off, submits exactly that request to the insurer's intake agent");
    expect(DESCRIPTION.endsWith('.')).toBe(true);
    expect(DESCRIPTION.match(/\./g)).toHaveLength(1);
  });

  test('the status, the version, the contact and the link of the advert come from the settings, and each has its default when it is not set', () => {
    expect(manifestOf({
      AGENT_STATUS_CHIP: 'LIVE', AGENT_STATUS_SINCE: '2026-12-01', AGENT_VERSION: '0.2.0', ADVERT_EXPLORER_URL: 'https://explorer.example.test/advert', OPERATOR_CONTACT: 'other@example.test',
    })).toMatchObject({
      status: { chip: 'live', since: '2026-12-01' }, version: '0.2.0', operator: { contact: 'other@example.test' }, links: { explorer_advert: 'https://explorer.example.test/advert' },
    });
    expect(manifestOf({ AGENT_STATUS_CHIP: ' ', AGENT_STATUS_SINCE: ' ', AGENT_VERSION: ' ', ADVERT_EXPLORER_URL: ' ' }))
      .toMatchObject({ status: { chip: 'proposed', since: STATUS_SINCE_DEFAULT }, version: '0.1.0', links: { explorer_advert: '' } });
    expect(manifestOf({ AGENT_STATUS_CHIP: ' Deployed\n', AGENT_STATUS_SINCE: ' 2026-12-01\n', AGENT_VERSION: ' 0.3.0\n' })).toMatchObject({ status: { chip: 'deployed', since: '2026-12-01' }, version: '0.3.0' });
    expect(STATUS_SINCE_DEFAULT).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(new Date(`${STATUS_SINCE_DEFAULT}T00:00:00Z`).toISOString().startsWith(STATUS_SINCE_DEFAULT)).toBe(true);
  });

  test('the interface is the two requests of the agent, with the routes of the runtime, a link to the response, and notes', () => {
    const { interface: surface } = manifestOf();
    expect(surface.request_schema).toStrictEqual(JSON.parse(JSON.stringify(REQUEST_SCHEMA)));
    expect(surface.response_schema).toStrictEqual({ $ref: `${SPEC_URL}#response` });
    expect(surface.routes).toStrictEqual({ job: '/v1/job', status: '/status', capability: '/capability' });
    expect(surface.notes).toHaveLength(4);
    const notes = surface.notes.join(' ');
    expect(notes).toContain('bad_shape (400)');
    expect(notes).toContain('POST /cosign/delegate');
    expect(notes).toContain('record-reader');
    expect(notes).toContain('drafter');
  });

  test('the terms carry the limits of the intake: an order id of 64 characters, a tenant of 48, a justification of 4,000 characters, and a request of 900,000 bytes of wire payload', () => {
    expect(manifestOf().terms.input_limits).toStrictEqual({ request_bytes: 900_000, order_id_chars: 64, tenant_chars: 48, justification_chars: 4_000 });
    expect([MAX_REQUEST_BYTES, ORDER_ID_CHARS, TENANT_CHARS, MAX_JUSTIFICATION_CHARS]).toStrictEqual([900_000, 64, 48, 4_000]);
  });
});

describe('every refusal of a setting that the manifest publishes, with its accepted twin', () => {
  /** A value that no setting takes. A message must name the setting and never show it. */
  const MARKER = 'zq9-marker-value-7f3';
  const ANOTHER_DID = `did:vector:${'ab'.repeat(32)}`;
  const POLICY = String(completeEnv().IDENTITY_POLICY_ID);
  const DERIVED = identityRegistryOf(POLICY, undefined)?.address ?? '';
  const required = (name: string): RegExp => new RegExp(`^environment variable ${name} is required \\(.+\\) and is not set$`);
  const CONTACT_RULE = /^environment variable OPERATOR_CONTACT must be one line of at most 200 characters with no control character, and it has \d+ characters$/;
  const DID_RULE = /^environment variable AGENT_DID must be did:vector: and 64 lowercase hex characters, and it has \d+ characters$/;
  const keyHashRule = (name: string): RegExp => new RegExp(`^environment variable ${name} must be 56 hex characters, and (it has \\d+ characters|some of its \\d+ characters are not hex)$`);
  const supplierRule = (name: string): RegExp => new RegExp(`^environment variable ${name} holds the key hash of SUPPLIER_PKH: the supplier key is the key of the runtime, and this key must be a key of its own$`);
  const sameRule = (name: string, other: string): RegExp => new RegExp(`^environment variable ${name} holds the same key hash as ${other}: each key of the service must be a key of its own$`);
  const NOT_THE_KEY = /^environment variable SUPPLIER_PUB_KEY_HEX is not the public key of SUPPLIER_PKH: the key hash of the one is not the other\. Both are published, so they must come from the same key pair, and the public key line must not hold a private key$/;
  const [SERVICE_PKH, DELEGATION_1_PKH] = (['service', 'delegation1'] as const).map((role) => keyOf(rawKey(KEY_NUMBERS[role])).pkh);
  const POLICY_RULE = /^environment variable IDENTITY_POLICY_ID must be 56 lowercase hex characters, got \d+ characters$/;
  const MODEL_RULE = /^environment variable LLM_MODEL_ALLOWLIST entry 1 must be a model name \(letters, digits, dots, underscores, colons, slashes and hyphens\)$/;
  const LEGACY_POLICY = /^environment variable IDENTITY_POLICY_ID is the policy of the legacy registry, not of the identity registry$/;
  const addressRule = (length: number): RegExp => new RegExp(`^environment variable IDENTITY_ADDRESS \\(${length} characters\\) is not the address of IDENTITY_POLICY_ID \\(addr1[0-9a-z]+\\)$`);
  const VERSION_RULE = /^environment variable AGENT_VERSION must be 1 to 32 letters, digits, dots, hyphens and plus signs, and it has \d+ characters$/;
  const CHIP_RULE = /^environment variable AGENT_STATUS_CHIP must be one of LIVE, DEPLOYED, PROPOSED, in any case, and it has \d+ characters$/;
  const SINCE_FORM = /^environment variable AGENT_STATUS_SINCE must be a date as YYYY-MM-DD, and it has \d+ characters$/;
  const SINCE_DAY = /^environment variable AGENT_STATUS_SINCE must be a date that exists, and it has \d+ characters$/;
  const LINK_RULE = /^environment variable ADVERT_EXPLORER_URL must be an https address with no user and no password, and it has \d+ characters$/;

  /** The setting, the value that is refused (undefined: not set), the start of the message, the same setting with a value that is accepted (the twin), and a value that breaks the same rule and that no message could show by chance. */
  type Row = readonly [setting: string, bad: string | undefined, refusal: RegExp, good: string | undefined, probe?: string];
  const ROWS: readonly Row[] = [
    ['OPERATOR_CONTACT', undefined, required('OPERATOR_CONTACT'), 'ops@example.test'],
    ['OPERATOR_CONTACT', 'line one\nline two', CONTACT_RULE, 'ops@example.test', `${MARKER}\u0001x`],
    ['OPERATOR_CONTACT', `${'a'.repeat(188)}@example.test`, CONTACT_RULE, `${'a'.repeat(187)}@example.test`, `${MARKER} ${'b'.repeat(201)}`],
    ['AGENT_DID', undefined, required('AGENT_DID'), ANOTHER_DID],
    ['AGENT_DID', 'did:vector:abc', DID_RULE, ANOTHER_DID, `did:vector:${MARKER}`],
    ['AGENT_DID', `did:vector:${'zz'.repeat(32)}`, DID_RULE, ANOTHER_DID, `did:vector:${MARKER}`],
    ['IDENTITY_POLICY_ID', 'abc', POLICY_RULE, POLICY],
    ['IDENTITY_POLICY_ID', 'zz'.repeat(28), POLICY_RULE, POLICY],
    ['IDENTITY_POLICY_ID', POLICY.toUpperCase(), POLICY_RULE, POLICY],
    ['IDENTITY_POLICY_ID', REGISTRY_POLICY, LEGACY_POLICY, POLICY],
    ['IDENTITY_ADDRESS', 'addr1xyzxyzxyzxyz', addressRule(17), DERIVED],
    ['IDENTITY_ADDRESS', 'abc', addressRule(3), DERIVED],
    ['SUPPLIER_PKH', undefined, required('SUPPLIER_PKH'), SUPPLIER.keyHash],
    ['SUPPLIER_PUB_KEY_HEX', undefined, required('SUPPLIER_PUB_KEY_HEX'), SUPPLIER.publicKey],
    ['PRIORAUTH_SERVICE_PKH', undefined, required('PRIORAUTH_SERVICE_PKH'), PRINCIPAL.keyHash],
    ['PRIORAUTH_DELEGATION_1_PKH', undefined, required('PRIORAUTH_DELEGATION_1_PKH'), PRINCIPAL.keyHash],
    ['PRIORAUTH_DELEGATION_2_PKH', '   ', required('PRIORAUTH_DELEGATION_2_PKH'), PRINCIPAL.keyHash],
    ['SUPPLIER_PKH', 'ab', /^environment variable SUPPLIER_PKH must be 56 hex characters, and it has 2 characters$/, SUPPLIER.keyHash],
    ['SUPPLIER_PKH', 'zz'.repeat(28), /^environment variable SUPPLIER_PKH must be 56 hex characters, and some of its 56 characters are not hex$/, SUPPLIER.keyHash],
    ['SUPPLIER_PKH', 'ab'.repeat(28), NOT_THE_KEY, SUPPLIER.keyHash],
    ['SUPPLIER_PKH', '<SUPPLIER_PUB_KEY_HEX>', keyHashRule('SUPPLIER_PKH'), SUPPLIER.keyHash],
    ['SUPPLIER_PUB_KEY_HEX', 'ab', /^environment variable SUPPLIER_PUB_KEY_HEX must be 64 hex characters, and it has 2 characters$/, SUPPLIER.publicKey],
    ['SUPPLIER_PUB_KEY_HEX', PRINCIPAL.publicKey, NOT_THE_KEY, SUPPLIER.publicKey],
    ['PRIORAUTH_SERVICE_PKH', 'ab', keyHashRule('PRIORAUTH_SERVICE_PKH'), PRINCIPAL.keyHash],
    ['PRIORAUTH_SERVICE_PKH', 'zz'.repeat(28), keyHashRule('PRIORAUTH_SERVICE_PKH'), PRINCIPAL.keyHash],
    ['PRIORAUTH_SERVICE_PKH', SUPPLIER.keyHash, supplierRule('PRIORAUTH_SERVICE_PKH'), PRINCIPAL.keyHash],
    ['PRIORAUTH_SERVICE_PKH', '<ABCDEF>', keyHashRule('PRIORAUTH_SERVICE_PKH'), PRINCIPAL.keyHash],
    ['PRIORAUTH_DELEGATION_1_PKH', 'ab'.repeat(27), keyHashRule('PRIORAUTH_DELEGATION_1_PKH'), PRINCIPAL.keyHash],
    ['PRIORAUTH_DELEGATION_1_PKH', SUPPLIER.keyHash, supplierRule('PRIORAUTH_DELEGATION_1_PKH'), PRINCIPAL.keyHash],
    ['PRIORAUTH_DELEGATION_1_PKH', SERVICE_PKH.toUpperCase(), sameRule('PRIORAUTH_DELEGATION_1_PKH', 'PRIORAUTH_SERVICE_PKH'), PRINCIPAL.keyHash],
    ['PRIORAUTH_DELEGATION_2_PKH', 'zz'.repeat(28), keyHashRule('PRIORAUTH_DELEGATION_2_PKH'), PRINCIPAL.keyHash],
    ['PRIORAUTH_DELEGATION_2_PKH', SUPPLIER.keyHash, supplierRule('PRIORAUTH_DELEGATION_2_PKH'), PRINCIPAL.keyHash],
    ['PRIORAUTH_DELEGATION_2_PKH', SERVICE_PKH, sameRule('PRIORAUTH_DELEGATION_2_PKH', 'PRIORAUTH_SERVICE_PKH'), PRINCIPAL.keyHash],
    ['PRIORAUTH_DELEGATION_2_PKH', DELEGATION_1_PKH, sameRule('PRIORAUTH_DELEGATION_2_PKH', 'PRIORAUTH_DELEGATION_1_PKH'), PRINCIPAL.keyHash],
    ['LLM_MODEL_ALLOWLIST', undefined, required('LLM_MODEL_ALLOWLIST'), 'a/one'],
    ['LLM_MAX_PRICE_LOVELACE', undefined, required('LLM_MAX_PRICE_LOVELACE'), '250000'],
    ['LLM_MAX_PRICE_LOVELACE', '0', /^environment variable LLM_MAX_PRICE_LOVELACE must be a whole number of lovelace of more than 0$/, '1'],
    ['LLM_MODEL_ALLOWLIST', 'deepseek/deepseek-v4-flash free', MODEL_RULE, 'a/one'],
    ['LLM_MAX_PRICE_LOVELACE', '1.5', /^environment variable LLM_MAX_PRICE_LOVELACE must be a whole number of lovelace of at least 0, written in digits$/, '250000'],
    ['ADVERT_PRICE_LOVELACE', '0', /^environment variable ADVERT_PRICE_LOVELACE must be a whole number of lovelace of more than 0, written in digits, and it has 1 characters$/, '1'],
    ['ADVERT_MAX_PROCESSING_MS', '1799999', /^environment variable ADVERT_MAX_PROCESSING_MS must be at least 1800000 /, '1800000', '1799731'],
    ['ADVERT_MAX_PROCESSING_MS', '86400001', /^environment variable ADVERT_MAX_PROCESSING_MS must be at most 86400000 /, '86400000', '86400731'],
    ['ADVERT_PRICE_LOVELACE', '9998000001', /^environment variable ADVERT_PRICE_LOVELACE must be at most 9998000000 /, '9998000000', '9998000731'],
    ['AGENT_VERSION', '0.1.0 beta', VERSION_RULE, '1.2.3-rc.1+build'],
    ['AGENT_VERSION', 'v'.repeat(33), VERSION_RULE, 'v'.repeat(32)],
    ['AGENT_VERSION', '-1', VERSION_RULE, '1'],
    ['AGENT_STATUS_CHIP', 'done', /^environment variable AGENT_STATUS_CHIP must be one of LIVE, DEPLOYED, PROPOSED, in any case, and it has 4 characters$/, 'LIVE'],
    ['AGENT_STATUS_CHIP', 'proposed!', CHIP_RULE, 'Proposed'],
    ['AGENT_STATUS_SINCE', 'yesterday', SINCE_FORM, '2026-12-01'],
    ['AGENT_STATUS_SINCE', '2026-12-1', SINCE_FORM, '2026-12-01'],
    ['AGENT_STATUS_SINCE', '2026-02-30', SINCE_DAY, '2028-02-29'],
    ['AGENT_STATUS_SINCE', '2026-13-45', SINCE_DAY, '2026-12-31'],
    ['ADVERT_EXPLORER_URL', 'http://explorer.example.test/advert', LINK_RULE, 'https://explorer.example.test/advert'],
    ['ADVERT_EXPLORER_URL', 'explorer.example.test', LINK_RULE, ''],
    ['ADVERT_EXPLORER_URL', 'https://user:password@explorer.example.test', LINK_RULE, 'https://explorer.example.test/advert?page=1'],
  ];
  const TABLE = ROWS.map(([setting, bad, refusal, good, probe]) => ({ setting, bad, refusal, good, probe }));

  test.each(TABLE)('$setting = $bad is refused by its name, the message shows no value, and $good is accepted', ({ setting, bad, refusal, good, probe }) => {
    const text = messageOf(() => manifestFromEnv(manifestEnv({ [setting]: bad })));
    expect(text).toMatch(refusal);
    expect(text).toContain(setting);
    if (bad !== undefined) expect(shows(text, bad), 'the message shows the value').toBe(false);
    expect(() => manifestFromEnv(manifestEnv({ [setting]: good })), `${setting} = ${String(good)}`).not.toThrow();
    if (bad === undefined) return;
    // The same rule with a value that no message could show by chance.
    const odd = probe ?? `${MARKER} !`;
    const probed = messageOf(() => manifestFromEnv(manifestEnv({ [setting]: odd })));
    expect(probed).toContain(setting);
    expect(shows(probed, odd), `the message shows ${odd}`).toBe(false);
  });

  test('each setting that the manifest reads has a row for a value that breaks its rule, and each setting that it requires has a row for the missing value', () => {
    for (const name of MANIFEST_SETTINGS) {
      expect(ROWS.some(([setting, bad]) => setting === name && bad !== undefined && bad.trim() !== ''), `${name} has no row for a wrong value`).toBe(true);
    }
    for (const name of [
      'OPERATOR_CONTACT', 'AGENT_DID', 'SUPPLIER_PKH', 'SUPPLIER_PUB_KEY_HEX', 'PRIORAUTH_SERVICE_PKH', 'PRIORAUTH_DELEGATION_1_PKH', 'PRIORAUTH_DELEGATION_2_PKH', 'LLM_MODEL_ALLOWLIST', 'LLM_MAX_PRICE_LOVELACE',
    ]) {
      expect(ROWS.some(([setting, bad]) => setting === name && (bad === undefined || bad.trim() === '')), `${name} has no row for the missing value`).toBe(true);
    }
  });

  test('a setting that is published and not set stops the render by its name, whether it is missing, empty or blank: there is no default for a contact, a DID, a key hash or a model', () => {
    for (const name of [
      'OPERATOR_CONTACT', 'AGENT_DID', 'SUPPLIER_PKH', 'SUPPLIER_PUB_KEY_HEX', 'PRIORAUTH_SERVICE_PKH', 'PRIORAUTH_DELEGATION_1_PKH', 'PRIORAUTH_DELEGATION_2_PKH', 'LLM_MODEL_ALLOWLIST', 'LLM_MAX_PRICE_LOVELACE',
    ]) {
      for (const empty of [undefined, '', '  ']) expect(messageOf(() => manifestFromEnv(manifestEnv({ [name]: empty }))), `${name} = ${JSON.stringify(empty)}`).toMatch(required(name));
    }
  });

  test('a private key in a published line never reaches the manifest: each line that names an identity or a key refuses the key in hex and in bech32, alone and after a valid value, by its name, and the message shows no part of it', () => {
    const base = manifestEnv();
    const lines = ['AGENT_DID', 'SUPPLIER_PKH', 'SUPPLIER_PUB_KEY_HEX', 'PRIORAUTH_SERVICE_PKH', 'PRIORAUTH_DELEGATION_1_PKH', 'PRIORAUTH_DELEGATION_2_PKH'];
    for (const line of lines) {
      for (const role of KEY_ROLES) {
        const key = rawKey(KEY_NUMBERS[role]);
        for (const form of [key, rawHexToBech32(key), `${String(base[line])} ${key}`, `${String(base[line])} ${rawHexToBech32(key)}`]) {
          const text = messageOf(() => manifestFromEnv({ ...base, [line]: form }));
          expect(text, `${line} holds the ${role} key`).toContain(line);
          expect(shows(text, form), `${line}: the message shows the ${role} key`).toBe(false);
          expect(shows(text, key), `${line}: the message shows a part of the ${role} key`).toBe(false);
        }
      }
      // The twin: the line with its own valid value is taken, and it is the value that the manifest holds.
      expect(() => manifestFromEnv(base), line).not.toThrow();
    }
    expect(JSON.stringify(manifestFromEnv(base)).toLowerCase()).not.toContain(rawKey(KEY_NUMBERS.service));
  });

  test('a placeholder is taken from the template only: the placeholder of another line and a name in angle brackets are refused like any other text, and the template takes its own', () => {
    for (const [line, value] of [
      ['SUPPLIER_PKH', '<SUPPLIER_PUB_KEY_HEX>'], ['SUPPLIER_PUB_KEY_HEX', '<SUPPLIER_PKH>'], ['AGENT_DID', '<SUPPLIER_PKH>'], ['PRIORAUTH_SERVICE_PKH', '<ABCDEF>'], ['PRIORAUTH_DELEGATION_1_PKH', '<PRIORAUTH_SERVICE_PKH>'],
    ] as const) {
      expect(messageOf(() => manifestFromEnv(manifestEnv({ [line]: value }))), `${line} = ${value}`).toContain(line);
    }
    expect(() => manifestFromEnv(TEMPLATE_ENV)).not.toThrow();
    expect(manifestFromEnv(TEMPLATE_ENV).identity.did).toBe('<AGENT_DID>');
  });

  test('a value that the manifest takes is the value that its reader gives, in its canonical form: a DID in its legacy form and a key hash in capitals are published as the canonical DID and the lower-case key hash', () => {
    const legacy = `did:vector:agent:${REGISTRY_POLICY}:${AGENT_DID.slice('did:vector:'.length)}`;
    const manifest = manifestFromEnv(manifestEnv({ AGENT_DID: legacy, SUPPLIER_PKH: SUPPLIER.keyHash.toUpperCase(), SUPPLIER_PUB_KEY_HEX: SUPPLIER.publicKey.toUpperCase(), PRIORAUTH_SERVICE_PKH: PRINCIPAL.keyHash.toUpperCase() }));
    expect(manifest.identity).toMatchObject({ did: AGENT_DID, supplier_key: `${AGENT_DID}#${SUPPLIER.keyHash}` });
    expect(manifest.keys).toMatchObject({ supplier_pkh: SUPPLIER.keyHash, pub_key_hex: SUPPLIER.publicKey, buyer_pkh: PRINCIPAL.keyHash });
  });

  test('an address of the registry with no policy is refused by name, and the identity registry is the address of the policy', () => {
    expect(messageOf(() => manifestFromEnv(manifestEnv({ IDENTITY_POLICY_ID: undefined, IDENTITY_ADDRESS: DERIVED })))).toBe('environment variable IDENTITY_ADDRESS is set but IDENTITY_POLICY_ID is not');
    expect(manifestFromEnv(manifestEnv({ IDENTITY_ADDRESS: DERIVED })).identity.registry_address).toBe(DERIVED);
    expect(manifestFromEnv(manifestEnv({ IDENTITY_POLICY_ID: undefined })).identity.registry_address).toBe('');
  });
});

describe('the behaviour', () => {
  test('holds the members of the kit: both operations, the claim word for word, the co-sign rule, the one fault value, the models, and the routes that the agent and its subagents call', () => {
    const { behaviour } = manifestOf();
    expect(behaviour.operations).toStrictEqual(['propose', 'execute']);
    expect(behaviour.claim).toStrictEqual({ statements: PRIORAUTH_CLAIM.statements.map(({ id, text }) => ({ id, text })) });
    expect(behaviour.claim.statements.map((statement) => statement.id)).toStrictEqual(['S1', 'S2', 'S3']);
    expect(behaviour.cosign).toStrictEqual({ route: '/cosign/delegate', rule: COSIGN_RULE });
    expect(behaviour.fault_modes).toStrictEqual(['alter_after_approval']);
    expect(behaviour.model).toStrictEqual({ allowlist: ['deepseek/deepseek-v4-flash'], max_price_lovelace: 1_000_000 });
    // The three routes of the records system and the guideline store are the routes of the kit, on the tenant of the request.
    const routes = (['records.order', 'guidelines.read', 'records.submission'] as const).map((route) => `${ROUTES[route].method} /t/{tenant}${ROUTES[route].template}`);
    expect(routes).toStrictEqual(['GET /t/{tenant}/records/orders/{order_id}', 'GET /t/{tenant}/guidelines/{code}', 'POST /t/{tenant}/records/orders/{order_id}/submission']);
    expect(behaviour.relying_on).toStrictEqual({ mock_systems: routes, gateway_routes: ['POST /token'] });
    expect(Object.keys(behaviour)).toStrictEqual(['data_handling', 'third_parties', 'operations', 'claim', 'cosign', 'fault_modes', 'model', 'relying_on']);
    expect(parseBehaviourAdditions(KIND, {
      operations: behaviour.operations, claim: behaviour.claim, cosign: behaviour.cosign, fault_modes: behaviour.fault_modes, model: behaviour.model, relying_on: behaviour.relying_on,
    }).ok).toBe(true);
  });

  test('the claim is the claim of the kit: the three texts of the statements, and no reference to a claim', () => {
    const { claim } = manifestOf().behaviour;
    expect(Object.keys(claim)).toStrictEqual(['statements']);
    expect(claim.statements.map((statement) => statement.text)).toStrictEqual([
      'A request this agent submits is byte-identical to the document whose digest its hirer approved.',
      'The record set hash in a request is the hash of the set its drafter was given.',
      'This agent reads records and guidelines only through its subagents, each with its own token under its own sub-delegation.',
    ]);
  });

  test('the models and the ceiling come from the settings: a list of models and a ceiling of 250,000 lovelace reach the manifest', () => {
    expect(manifestOf({ LLM_MODEL_ALLOWLIST: 'a/one, b/two', LLM_MAX_PRICE_LOVELACE: '250000' }).behaviour.model).toStrictEqual({ allowlist: ['a/one', 'b/two'], max_price_lovelace: 250_000 });
  });

  test('the data that the agent holds and the five parties that receive it are named, with the prompt of each decision and what it leaves out', () => {
    const { behaviour } = manifestOf();
    expect(behaviour.data_handling).toContain('synthetic');
    expect(behaviour.third_parties).toHaveLength(5);
    const model = behaviour.third_parties.find((party) => party.startsWith('a model supplier'));
    expect(model).toContain('without its patient reference and its clinician reference');
    expect(model).toContain('the whole record set and the guideline');
  });
});

describe('the gaps', () => {
  test('are the seven of the page of the agent in its order, the sentence about the keys of the parties, the run-in lead, and the sentence of the kit about the fault switch, in that order', () => {
    expect(manifestOf().gaps).toStrictEqual([SYNTHETIC_GAP, JUSTIFICATION_GAP, SIGN_OFF_GAP, RECORD_SET_GAP, CHALLENGE_GAP, MODEL_GAP, INSURER_GAP, KEYS_GAP, NOT_SHOWN_GAP, faultGap(KIND)]);
    expect(manifestOf().gaps).toStrictEqual([...gapsFor()]);
    expect(gapsFor()).toHaveLength(10);
    expect(new Set(gapsFor()).size).toBe(10);
    // The last two are the run-in lead and the fault gap.
    expect(gapsFor().slice(-2)).toStrictEqual([NOT_SHOWN_GAP, faultGap(KIND)]);
    expect(NOT_SHOWN_GAP.startsWith('What this does not show:')).toBe(true);
  });

  test('say what the page says, word for word', () => {
    expect([SYNTHETIC_GAP, JUSTIFICATION_GAP, SIGN_OFF_GAP, RECORD_SET_GAP, MODEL_GAP, INSURER_GAP]).toStrictEqual([
      'Every record is synthetic. Nothing here has been run against a real records system or a real insurer.',
      'The model writes the justification. Nothing in this agent checks it against the guideline.',
      'This agent does not check the sign-off of the hirer. The Insurer Intake Agent does.',
      'The subagent drafter is given the whole record set, but nothing forces the model to use all of it. The request carries the hash of the set so that a reviewer can compare.',
      'A model call that fails ends the job. There is no second provider.',
      'The insurer side is operated by the same foundation as this agent.',
    ]);
  });

  test('the challenge gap takes its number of seconds from the accept window of the escrow, and no gap holds a number that the code does not hold', () => {
    expect(Number.isInteger(ACCEPT_WINDOW_MS / 1000)).toBe(true);
    expect(CHALLENGE_GAP).toBe(
      'A challenge puts a hold on the identity of the Insurer Intake Agent if the jury finds for this agent. '
      + `It does not return what the escrow locked: a delivery that this agent refuses can still be released to the Insurer Intake Agent ${ACCEPT_WINDOW_MS / 1000} s after its Submit.`,
    );
    const held = new Set([String(ACCEPT_WINDOW_MS / 1000)]);
    for (const gap of gapsFor()) for (const number of gap.match(/\d+/g) ?? []) expect(held.has(number), `${number} in: ${gap}`).toBe(true);
  });

  test('say who holds the keys of the parties, and end with the run-in lead and its three items, the challenge of this agent against the Insurer Intake Agent among them', () => {
    expect(KEYS_GAP).toBe('The controller key, the Accountable key and the guardian keys of this deployment are held on one host by one operator, so a party is independent of the controller by key only.');
    for (const item of [
      'the refund of the escrow of a revoked agent', 'a relying party that refuses a live token after its authority ended', 'a challenge of this agent against the Insurer Intake Agent, because that agent has no fault value',
    ]) expect(NOT_SHOWN_GAP).toContain(item);
    expect(NOT_SHOWN_GAP.endsWith('Tests alone cover the last two.')).toBe(true);
  });

  test('are one line each that ends with a full stop', () => {
    for (const gap of gapsFor()) {
      expect(gap.endsWith('.'), gap).toBe(true);
      expect(gap, gap).not.toMatch(/[\n\r]/);
      expect(gap, gap).toBe(gap.trim());
    }
  });
});

describe('the terms', () => {
  const NOW = new FakeClock();
  const REF = `${'cc'.repeat(32)}#0`;
  const PROMPT = 'dd'.repeat(32);
  const buyer = keyOf(rawKey(KEY_NUMBERS.delegation1));
  const advert = (manifest: PriorAuthManifest, extra: Partial<AdvertDatum> & { agent_id?: string } = {}): AdvertDatum => ({
    supplier_pkh: SUPPLIER.keyHash, capability_id: manifest.capability_id, model: PRIORAUTH_MODELS.draft, max_output_tokens: 0, max_processing_ms: manifest.terms.max_processing_ms,
    price_lovelace: BigInt(manifest.terms.price_lovelace), supplier_bond_lovelace: BigInt(manifest.terms.supplier_bond_lovelace), buyer_bond_lovelace: BigInt(manifest.terms.buyer_bond_lovelace),
    endpoint_url: 'https://priorauth.example.test', detail_uri: 'https://priorauth.example.test/agent.json', detail_hash: render().sha256, advertised_at: NOW.now(), status: 'Active', ...extra,
  }) as AdvertDatum;

  test('are the price 3 and both bonds 1, in a window of 1,800,000 ms', () => {
    const { terms } = manifestOf();
    expect([terms.price_lovelace, terms.supplier_bond_lovelace, terms.buyer_bond_lovelace, terms.max_processing_ms]).toStrictEqual([3_000_000, 1_000_000, 1_000_000, 1_800_000]);
  });

  test('give a lock of 5,000,000 lovelace, the price and both bonds, for a Post on the advert in the legacy layout and in the identity layout', () => {
    const manifest = manifestOf();
    const legacy = planFleetPostEscrow(advert(manifest), REF, buyer.pkh, PROMPT, NOW.now());
    expect(legacy.layout).toBe('legacy');
    expect(legacy.lockLovelace).toBe(5_000_000n);
    const identityAdvert = advert(manifest, { agent_id: AGENT_DID.slice('did:vector:'.length) });
    const identity = planFleetPostEscrow(identityAdvert, REF, buyer.pkh, PROMPT, NOW.now(), fleetPostTerms(identityAdvert, buyer.address));
    expect(identity.layout).toBe('identity');
    expect(identity.lockLovelace).toBe(5_000_000n);
    expect(identity.lockLovelace).toBe(BigInt(manifest.terms.price_lovelace + manifest.terms.supplier_bond_lovelace + manifest.terms.buyer_bond_lovelace));
    // The window of the advert is the window of the escrow: the Post leaves the supplier all of it before deliver_by.
    expect(identity.deliverBy).toBe(NOW.now() + manifest.terms.max_processing_ms + DELIVER_BY_BUFFER_MS);
  });

  test('follow a price that the operator sets: the lock is that price and both bonds', () => {
    const manifest = manifestOf({ ADVERT_PRICE_LOVELACE: '6000000', ADVERT_MAX_PROCESSING_MS: '2400000' });
    expect([manifest.terms.price_lovelace, manifest.terms.max_processing_ms]).toStrictEqual([6_000_000, 2_400_000]);
    expect(planFleetPostEscrow(advert(manifest), REF, buyer.pkh, PROMPT, NOW.now()).lockLovelace).toBe(8_000_000n);
  });

  test('the window and the price that the settings take are the ones that a Post takes: the largest of each is posted, and one more is refused by the Post and by the settings', () => {
    const widest = manifestOf({ ADVERT_MAX_PROCESSING_MS: '86400000' });
    expect(planFleetPostEscrow(advert(widest), REF, buyer.pkh, PROMPT, NOW.now()).deliverBy).toBe(NOW.now() + 86_400_000 + DELIVER_BY_BUFFER_MS);
    expect(() => planFleetPostEscrow(advert(widest, { max_processing_ms: 86_400_001 }), REF, buyer.pkh, PROMPT, NOW.now())).toThrow(/longer than the 86400000 ms/);
    expect(() => manifestOf({ ADVERT_MAX_PROCESSING_MS: '86400001' })).toThrow(/^environment variable ADVERT_MAX_PROCESSING_MS must be at most 86400000/);
    const dearest = manifestOf({ ADVERT_PRICE_LOVELACE: String(MAX_ESCROW_LOVELACE - 2_000_000n) });
    expect(planFleetPostEscrow(advert(dearest), REF, buyer.pkh, PROMPT, NOW.now()).lockLovelace).toBeGreaterThanOrEqual(MAX_ESCROW_LOVELACE);
    expect(() => planFleetPostEscrow(advert(dearest, { price_lovelace: BigInt(dearest.terms.price_lovelace) + 1n }), REF, buyer.pkh, PROMPT, NOW.now())).toThrow(/value cap of an escrow/);
    expect(() => manifestOf({ ADVERT_PRICE_LOVELACE: String(MAX_ESCROW_LOVELACE - 2_000_000n + 1n) })).toThrow(/^environment variable ADVERT_PRICE_LOVELACE must be at most 9998000000/);
  });

  test('the deadline of a Post follows the clock of the tests, which moves by hand and never by itself', () => {
    const clock = new FakeClock();
    const manifest = manifestOf();
    const deadline = (): number => planFleetPostEscrow(advert(manifest), REF, buyer.pkh, PROMPT, clock.now()).deliverBy;
    const first = deadline();
    expect(deadline()).toBe(first);
    clock.advance(5_000);
    expect(deadline() - first).toBe(5_000);
    clock.advance(0);
    expect(deadline() - first).toBe(5_000);
    for (const wrong of [-1, 1.5, Number.NaN]) expect(() => clock.advance(wrong), String(wrong)).toThrow(RangeError);
  });
});

/** The keywords of the JSON Schema that the manifest uses. A reader of a schema that meets another keyword throws, so the schema cannot gain a rule that this test skips. */
const KEYWORDS = ['type', 'const', 'oneOf', 'required', 'additionalProperties', 'properties', 'pattern', 'minLength', 'maxLength', 'description'];
type Schema = { readonly [keyword: string]: unknown };
const within = (count: number, least: unknown, most: unknown): boolean => (least === undefined || count >= Number(least)) && (most === undefined || count <= Number(most));

/** Does `value` pass `schema`? Lengths are counted in code points, as JSON Schema counts them. */
function passes(schema: Schema, value: unknown): boolean {
  for (const keyword of Object.keys(schema)) if (!KEYWORDS.includes(keyword)) throw new Error(`this test does not read the keyword ${keyword}`);
  if (Array.isArray(schema.oneOf)) return (schema.oneOf as Schema[]).filter((option) => passes(option, value)).length === 1;
  if ('const' in schema) return value === schema.const;
  switch (schema.type) {
    case 'null':
      return value === null;
    case 'string':
      return typeof value === 'string' && within([...value].length, schema.minLength, schema.maxLength) && (schema.pattern === undefined || new RegExp(String(schema.pattern), 'u').test(value));
    case 'object': {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
      const members = value as Record<string, unknown>;
      const properties = (schema.properties ?? {}) as Record<string, Schema>;
      if (!((schema.required ?? []) as string[]).every((name) => name in members)) return false;
      return Object.entries(members).every(([name, member]) => (name in properties ? passes(properties[name], member) : schema.additionalProperties !== false));
    }
    default:
      throw new Error(`this test does not read the type ${String(schema.type)}`);
  }
}

describe('the schema of the requests', () => {
  const DOCUMENT = {
    schema: PRIORAUTH_REQUEST_SCHEMA, request_number: 'run1-1', tenant: 'run1', order_id: 'ord-1', patient_ref: 'pat-1', ordering_clinician_ref: 'clin-1', service_code: 'svc-1', diagnosis_codes: ['Z00.0'],
    justification: 'The service is ordered for a synthetic reason.', guideline_refs: ['crit-1'], record_refs: ['rec-1'], record_set_sha256: '0a'.repeat(32), insurer_did: `did:vector:${'4e'.repeat(32)}`,
    advert_ref: `${'1b'.repeat(32)}#0`,
  };
  const AUTHORITY = { principal_did: `did:vector:${'ef'.repeat(32)}`, delegation: 'ab'.repeat(32) };
  const PROPOSE = { op: 'propose', authority: AUTHORITY, tenant: 'run1', order_id: 'ord-1', insurer_did: `did:vector:${'4e'.repeat(32)}` };
  const made = makeProposal(DOCUMENT, 'cd'.repeat(32));
  if (!made.ok) throw new Error(made.detail);
  const PROPOSAL = made.value;
  const APPROVAL = { attestation: '2c'.repeat(32), issuer_did: `did:vector:${'3d'.repeat(32)}` };
  const EXECUTE = { op: 'execute', authority: AUTHORITY, tenant: 'run1', proposal: PROPOSAL, approval: APPROVAL };
  const propose = (over: Record<string, unknown>): Record<string, unknown> => ({ ...PROPOSE, ...over });
  const execute = (over: Record<string, unknown>): Record<string, unknown> => ({ ...EXECUTE, ...over });
  const without = (value: Record<string, unknown>, name: string): Record<string, unknown> => Object.fromEntries(Object.entries(value).filter(([key]) => key !== name));

  /**
   * What the service takes of a request: the parser of the protocol, with the two fields of `propose` read by the rules of the authorization request (the order id and the insurer are the members of the request
   * document with the same names), and a tenant that the authorization request takes too, which is 48 characters of lower-case letters, digits and hyphens where the protocol takes 64.
   */
  function serviceAccepts(value: unknown): boolean {
    const parsed = parseRequest(value, (fields) => {
      const members = checkMembers(fields, 'request', ['order_id', 'insurer_did']);
      if (members !== null) return members;
      const document = parsePriorAuthRequest({ ...DOCUMENT, order_id: fields.order_id, insurer_did: fields.insurer_did });
      return document.ok ? accepted({ order_id: fields.order_id, insurer_did: fields.insurer_did }) : document;
    });
    return parsed.ok && parsePriorAuthRequest({ ...DOCUMENT, tenant: parsed.value.tenant }).ok;
  }

  const CASES: readonly (readonly [what: string, value: unknown, expected: boolean])[] = [
    ['the sample of propose', PROPOSE, true],
    ['the sample of execute', EXECUTE, true],
    ['an operation that is neither', propose({ op: 'cancel' }), false],
    ['no operation', without(PROPOSE, 'op'), false],
    ['a propose with a member too many', propose({ extra: 1 }), false],
    ['a propose with a proposal', propose({ proposal: PROPOSAL }), false],
    ['a propose with no order id', without(PROPOSE, 'order_id'), false],
    ['a propose with no insurer', without(PROPOSE, 'insurer_did'), false],
    ['an order id of 64 characters', propose({ order_id: 'a'.repeat(ORDER_ID_CHARS) }), true],
    ['an order id of 65 characters', propose({ order_id: 'a'.repeat(ORDER_ID_CHARS + 1) }), false],
    ['an empty order id', propose({ order_id: '' }), false],
    ['an order id with a space', propose({ order_id: 'ord 1' }), false],
    ['an order id that starts with a hyphen', propose({ order_id: '-ord' }), false],
    ['an order id with a letter that is not ASCII', propose({ order_id: 'ord\u00e9' }), false],
    ['an order id with a dot, a hyphen and an underscore', propose({ order_id: 'a.b-c_d' }), true],
    ['an insurer that is no DID', propose({ insurer_did: 'insurer' }), false],
    ['an insurer DID in capitals', propose({ insurer_did: `did:vector:${'4E'.repeat(32)}` }), false],
    ['a tenant of 48 characters', propose({ tenant: 'a'.repeat(TENANT_CHARS) }), true],
    ['a tenant of 49 characters', propose({ tenant: 'a'.repeat(TENANT_CHARS + 1) }), false],
    ['an empty tenant', propose({ tenant: '' }), false],
    ['a tenant in capitals', propose({ tenant: 'RUN1' }), false],
    ['a tenant with an underscore', propose({ tenant: 'run_1' }), false],
    ['a tenant that starts with a hyphen', propose({ tenant: '-run1' }), false],
    ['no authority', without(PROPOSE, 'authority'), false],
    ['an authority with a vault', propose({ authority: { ...AUTHORITY, vault: `${'ee'.repeat(32)}#0` } }), false],
    ['an authority with no delegation', propose({ authority: { principal_did: AUTHORITY.principal_did } }), false],
    ['a principal that is no DID', propose({ authority: { ...AUTHORITY, principal_did: 'someone' } }), false],
    ['a delegation of 63 characters', propose({ authority: { ...AUTHORITY, delegation: AUTHORITY.delegation.slice(1) } }), false],
    ['a delegation in capitals', propose({ authority: { ...AUTHORITY, delegation: AUTHORITY.delegation.toUpperCase() } }), false],
    ['an execute with approval null', execute({ approval: null }), true],
    ['an execute with no approval member', without(EXECUTE, 'approval'), false],
    ['an execute with an approval that is a text', execute({ approval: 'yes' }), false],
    ['an execute with an approval with a member too many', execute({ approval: { ...APPROVAL, extra: 'x' } }), false],
    ['an execute with an approval with no issuer', execute({ approval: { attestation: APPROVAL.attestation } }), false],
    ['an execute with an attestation in capitals', execute({ approval: { ...APPROVAL, attestation: APPROVAL.attestation.toUpperCase() } }), false],
    ['an execute with no proposal', without(EXECUTE, 'proposal'), false],
    ['an execute with a proposal with no salt', execute({ proposal: without(PROPOSAL as unknown as Record<string, unknown>, 'salt') }), false],
    ['an execute with a salt of 63 characters', execute({ proposal: { ...PROPOSAL, salt: PROPOSAL.salt.slice(1) } }), false],
    ['an execute with a digest in capitals', execute({ proposal: { ...PROPOSAL, proposal_digest: PROPOSAL.proposal_digest.toUpperCase() } }), false],
    ['an execute with a proposal that has a member too many', execute({ proposal: { ...PROPOSAL, extra: 1 } }), false],
    ['an execute with a document that is a list', execute({ proposal: { ...PROPOSAL, document: [] } }), false],
    ['an execute with an order id', execute({ order_id: 'ord-1' }), false],
  ];

  test('is one schema of the two requests, and it names the members of each sample and no other', () => {
    const [proposeSchema, executeSchema] = REQUEST_SCHEMA.oneOf;
    expect(Object.keys(REQUEST_SCHEMA)).toStrictEqual(['oneOf']);
    for (const [schema, sample] of [[proposeSchema, PROPOSE], [executeSchema, EXECUTE]] as const) {
      expect(schema.type).toBe('object');
      expect(schema.additionalProperties).toBe(false);
      expect([...schema.required].sort()).toStrictEqual(Object.keys(sample).sort());
      expect(Object.keys(schema.properties).sort()).toStrictEqual(Object.keys(sample).sort());
    }
    expect(proposeSchema.properties.op.const).toBe('propose');
    expect(executeSchema.properties.op.const).toBe('execute');
    expect(proposeSchema.properties.order_id.maxLength).toBe(ORDER_ID_CHARS);
    expect(proposeSchema.properties.tenant.maxLength).toBe(TENANT_CHARS);
    expect(Object.keys(proposeSchema.properties.authority.properties)).toStrictEqual(['principal_did', 'delegation']);
  });

  test.each(CASES)('holds the same rule as the parsers of the kit for %s', (_what, value, expected) => {
    expect(serviceAccepts(value), 'the parsers of the kit').toBe(expected);
    expect(passes(REQUEST_SCHEMA as Schema, value), 'the schema of the manifest').toBe(expected);
  });
});
