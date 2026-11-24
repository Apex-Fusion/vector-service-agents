// agents/insurer-intake-agent/test/serve/manifest.test.ts
// The manifest of the Insurer Intake Agent: the same bytes on every render, and the same bytes whatever the fault setting is (the agent has none); a manifest that reads the settings that it names and no other, and that
// holds no key and no token; the members, the claim, the gaps in their order, and the schema of the handoff held to the parsers of the kit; a template file that equals the render of the template; and the terms, which
// agree with the lock that a Post makes for the advert: the price and both bonds, 2 + 1 + 1 = 4 units. No test here starts a service.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { DELIVER_BY_BUFFER_MS, fleetPostTerms, planFleetPostEscrow, rawHexToBech32 } from '@vsa/buyer-core';
import { ROUTES } from '@vsa/usecase-kit/access';
import { faultGap, parseBehaviourAdditions, renderManifest } from '@vsa/usecase-kit/manifest';
import { AGENT_KINDS, FAULT_MODES, HANDOFF_SCHEMA, MAX_REQUEST_BYTES, parseHandoff } from '@vsa/usecase-kit/protocol';
import { INTAKE_CLAIM, MAX_JUSTIFICATION_CHARS, PRIORAUTH_CAPABILITIES, PRIORAUTH_MODELS, PRIORAUTH_REQUEST_SCHEMA, parsePriorAuthRequest } from '@vsa/usecase-kit/priorauth';
import { identityRegistryOf } from '@vsa/vector-read';
import type { AdvertDatum } from '@vsa/vector-read';
import {
  BINDING_GAP, COMPLETENESS_GAP, COVERAGE_GAP, KEYS_GAP, LEDGER_GAP, NOT_SHOWN_GAP, REFUSED_GAP, REPORTED_GAP, SYNTHETIC_GAP, UNREADABLE_GAP, gapsFor,
} from '../../src/serve/gaps.ts';
import { keyOf } from '../../src/serve/keys.ts';
import { DESCRIPTION, REQUEST_SCHEMA, SOURCE_URL, SPEC_URL, STATUS_SINCE_DEFAULT, TEMPLATE_ENV, manifestFromEnv, renderTemplate } from '../../src/serve/manifest.ts';
import type { IntakeManifest } from '../../src/serve/manifest.ts';
import { MAX_PRICE_LOVELACE, MAX_PROCESSING_WINDOW_MS } from '../../src/serve/settings.ts';
import { AGENT_DID, FULL_ENV, FakeClock, OTHER, POLICY, SERVICE, SERVICE_ADDRESS, SUPPLIER, TOKEN, envWith, message, shows } from './support.ts';

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');
const templateFile = fileURLToPath(new URL('../../agent.json.template', import.meta.url));

/** The manifest as the service renders it: the kit renders the builder for each fault setting of the kind, and gives the bytes when the renders agree. */
const render = (env: NodeJS.ProcessEnv = FULL_ENV) => {
  const rendered = renderManifest('insurer-intake-agent', (setting) => manifestFromEnv({ ...env, FAULT_MODE: setting }));
  if (!rendered.ok) throw new Error(`${rendered.code}: ${rendered.detail}`);
  return rendered.value;
};
const manifestOf = (over: Readonly<Record<string, string | undefined>> = {}): IntakeManifest => JSON.parse(render(envWith(over)).text) as IntakeManifest;

/** The settings that the manifest reads, and no others: the ones that it publishes. */
const MANIFEST_SETTINGS = [
  'ADVERT_EXPLORER_URL', 'ADVERT_MAX_PROCESSING_MS', 'ADVERT_PRICE_LOVELACE', 'AGENT_DID', 'AGENT_STATUS_CHIP', 'AGENT_STATUS_SINCE', 'AGENT_VERSION', 'IDENTITY_ADDRESS', 'IDENTITY_POLICY_ID', 'INTAKE_SERVICE_PKH',
  'LLM_MAX_PRICE_LOVELACE', 'LLM_MODEL_ALLOWLIST', 'OPERATOR_CONTACT', 'SUPPLIER_PKH', 'SUPPLIER_PUB_KEY_HEX',
];

describe('the bytes of the manifest', () => {
  test('are the same on every render: three renders give one text and one hash, and the hash is the SHA-256 of the text', () => {
    const [first, second, third] = [render(), render(), render()];
    expect(second).toStrictEqual(first);
    expect(third).toStrictEqual(first);
    expect(first.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(first.sha256).toBe(sha256(first.text));
    expect(JSON.stringify(manifestFromEnv(FULL_ENV))).toBe(first.text);
    expect(first.text).not.toContain('\n');
  });

  test('change with a setting that the manifest publishes and with nothing else: another contact, DID, key, model, price or window gives another hash, and a setting that is not in it gives the same one', () => {
    const base = render().sha256;
    for (const over of [
      { OPERATOR_CONTACT: 'other@example.test' }, { AGENT_DID: `did:vector:${'ab'.repeat(32)}` }, { SUPPLIER_PKH: OTHER.pkh, SUPPLIER_PUB_KEY_HEX: OTHER.pubKeyHex }, { INTAKE_SERVICE_PKH: OTHER.pkh },
      { IDENTITY_POLICY_ID: 'ab'.repeat(28) }, { LLM_MODEL_ALLOWLIST: 'other/model' }, { LLM_MAX_PRICE_LOVELACE: '250000' }, { ADVERT_PRICE_LOVELACE: '4000000' }, { ADVERT_MAX_PROCESSING_MS: '600000' },
      { AGENT_VERSION: '0.2.0' }, { AGENT_STATUS_CHIP: 'live' }, { AGENT_STATUS_SINCE: '2026-12-01' }, { ADVERT_EXPLORER_URL: 'https://explorer.example.test/advert' },
    ]) {
      expect(render(envWith(over)).sha256, JSON.stringify(Object.keys(over))).not.toBe(base);
    }
    for (const over of [
      { PORT: '9999', HOST: '127.0.0.2', MOCK_PUBLIC_BASE: 'https://other.example.test', LLM_MAX_SUPPLIER_BOND_LOVELACE: '3000000', DISPUTE_CHALLENGE_STAKE_LOVELACE: '1', CHECKS_READ_BUDGET_MS: '900', FAULT_MODE: 'anything' },
      { VECTOR_MODULE1_MANIFEST: undefined, SERVICE_AUTH_HEADER: undefined },
    ]) {
      expect(render(envWith(over)).sha256, JSON.stringify(Object.keys(over))).toBe(base);
    }
  });

  test('read the settings that the manifest publishes and no other: a probe sees each read of the environment, and none is a secret or a setting of another part of the service', () => {
    const seen = new Set<string>();
    let listed = false;
    const env = new Proxy<NodeJS.ProcessEnv>({ ...FULL_ENV }, {
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
  });

  test('hold no key and no token: no form of a stand-in key or of the token is in the text, and a secret in every setting that the manifest does not read changes no byte', () => {
    const { text } = render();
    const secrets = [SERVICE, SUPPLIER, OTHER].flatMap((key) => [key.privateKeyHex, rawHexToBech32(key.privateKeyHex)]).concat([TOKEN, TOKEN.slice('Bearer '.length)]);
    for (const secret of secrets) expect(text.toLowerCase(), secret.slice(0, 8)).not.toContain(secret.toLowerCase());
    const others = Object.keys(FULL_ENV).filter((name) => !MANIFEST_SETTINGS.includes(name));
    expect(others.length).toBeGreaterThan(0);
    const full = { ...FULL_ENV, ...Object.fromEntries(others.map((name, index) => [name, secrets[index % secrets.length]])), SERVICE_AUTH_HEADER: TOKEN };
    expect(render(full)).toStrictEqual(render());
  });

  test('hold no fault value and no member fault_mode: the agent has no fault value, the list of possible values is empty, no gap speaks of a switch, and a stray setting changes nothing', () => {
    const { text } = render();
    for (const value of AGENT_KINDS.flatMap((kind) => [...FAULT_MODES[kind]])) expect(text, value).not.toContain(value);
    expect(text).not.toMatch(/"fault_mode"\s*:/);
    expect(manifestOf().behaviour.fault_modes).toStrictEqual([]);
    expect(faultGap('insurer-intake-agent')).toBeNull();
    expect(gapsFor().some((gap) => gap.includes('fault switch'))).toBe(false);
    expect(manifestFromEnv({ ...FULL_ENV, FAULT_MODE: 'anything' })).toStrictEqual(manifestFromEnv(FULL_ENV));
  });
});

describe('the template', () => {
  test('is the render of the template environment, byte for byte: indented JSON with a line break at the end, and the file equals it', () => {
    const file = readFileSync(templateFile, 'utf8');
    expect(file).toBe(renderTemplate());
    expect(renderTemplate()).toBe(renderTemplate());
    expect(file.endsWith('}\n')).toBe(true);
    expect(file.startsWith('{\n  "schema": "vector.agent-manifest.v2",\n')).toBe(true);
    expect(JSON.parse(file)).toMatchObject({ name: 'Insurer Intake Agent', capability_id: 'health.priorauth.intake.v1', status: { chip: 'proposed', since: STATUS_SINCE_DEFAULT } });
  });

  test('names a placeholder for each value of the operator that the manifest publishes, and no other', () => {
    const file = readFileSync(templateFile, 'utf8');
    const found = [...new Set(file.match(/<[A-Z][A-Z0-9_]*>/g) ?? [])].sort();
    expect(found).toStrictEqual(['<AGENT_DID>', '<INTAKE_SERVICE_PKH>', '<OPERATOR_CONTACT>', '<SUPPLIER_PKH>', '<SUPPLIER_PUB_KEY_HEX>']);
    for (const [name, value] of Object.entries(TEMPLATE_ENV)) if (value.startsWith('<')) expect(value).toBe(`<${name}>`);
    expect(TEMPLATE_ENV.LLM_MODEL_ALLOWLIST).toBe(FULL_ENV.LLM_MODEL_ALLOWLIST);
    expect(TEMPLATE_ENV.LLM_MAX_PRICE_LOVELACE).toBe(FULL_ENV.LLM_MAX_PRICE_LOVELACE);
    const template = JSON.parse(file) as IntakeManifest;
    expect(template.identity.supplier_key).toBe('<AGENT_DID>#<SUPPLIER_PKH>');
    expect(template.keys).toStrictEqual({ supplier_pkh: '<SUPPLIER_PKH>', pub_key_hex: '<SUPPLIER_PUB_KEY_HEX>', buyer_pkh: '<INTAKE_SERVICE_PKH>' });
  });

  test('holds the constants of the manifest and is never the manifest that the service serves: the price, the gaps and the claim are the same, and a served manifest with a placeholder is refused', () => {
    const template = JSON.parse(renderTemplate()) as IntakeManifest;
    const served = manifestOf();
    expect([template.terms, template.gaps, template.behaviour, template.interface]).toStrictEqual([served.terms, served.gaps, served.behaviour, served.interface]);
    expect(renderTemplate()).not.toBe(render().text);
    expect(render().text).not.toMatch(/<[A-Z][A-Z0-9_]*>/);
    const refused = renderManifest('insurer-intake-agent', () => manifestFromEnv(TEMPLATE_ENV));
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.code).toBe('manifest_has_placeholder');
    expect(renderManifest('insurer-intake-agent', () => manifestFromEnv(TEMPLATE_ENV), { template: true }).ok).toBe(true);
  });
});

describe('the members of the manifest', () => {
  test('name the agent, its capability, its identity, its keys, its status and its links', () => {
    const manifest = manifestOf();
    expect([manifest.schema, manifest.name, manifest.capability_id, manifest.version]).toStrictEqual(['vector.agent-manifest.v2', 'Insurer Intake Agent', 'health.priorauth.intake.v1', '0.1.0']);
    expect(manifest.capability_id).toBe(PRIORAUTH_CAPABILITIES.intake);
    expect(manifest.description).toBe(DESCRIPTION);
    expect(manifest.operator).toStrictEqual({ name: 'Apex Fusion Foundation', contact: 'ops@example.test' });
    expect(manifest.identity).toStrictEqual({ did: AGENT_DID, registry_address: identityRegistryOf(POLICY, undefined)?.address, supplier_key: `${AGENT_DID}#${SUPPLIER.pkh}` });
    expect(manifest.identity.registry_address).toMatch(/^addr1/);
    // The keys are the supplier key of the runtime (its public values) and the service key (its hash). The agent has no delegation key and no subagent.
    expect(manifest.keys).toStrictEqual({ supplier_pkh: SUPPLIER.pkh, pub_key_hex: SUPPLIER.pubKeyHex, buyer_pkh: keyOf(SERVICE.privateKeyHex).pkh });
    expect(manifest.keys.buyer_pkh).toBe(SERVICE.pkh);
    expect(manifest.status).toStrictEqual({ chip: 'proposed', since: STATUS_SINCE_DEFAULT });
    expect(manifest.links).toStrictEqual({ spec: SPEC_URL, source: SOURCE_URL, explorer_advert: '' });
    expect(SPEC_URL.endsWith('/specs/insurer-intake-agent.md')).toBe(true);
    expect(SOURCE_URL.endsWith('/agents/insurer-intake-agent')).toBe(true);
    expect(PRIORAUTH_MODELS.intake).toBe('insurer-intake-agent-v1');
  });

  test('the description says what the agent does for an insurer, and that it makes an intake decision and no coverage decision', () => {
    expect(DESCRIPTION.startsWith('For an insurer: takes an authorization request from the agent of a care provider')).toBe(true);
    expect(DESCRIPTION).toContain("checks who sent it and that the provider's reviewer signed off exactly this request");
    expect(DESCRIPTION).toContain("decides whether it is complete, files it in the insurer's system and returns an intake record");
    expect(DESCRIPTION.endsWith('it makes an intake decision and no coverage decision.')).toBe(true);
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

  test('the interface is the handoff that the agent takes, with the routes of the runtime, a link to the response, and notes', () => {
    const { interface: surface } = manifestOf();
    expect(surface.request_schema).toStrictEqual(JSON.parse(JSON.stringify(REQUEST_SCHEMA)));
    expect(surface.response_schema).toStrictEqual({ $ref: `${SPEC_URL}#response` });
    expect(surface.routes).toStrictEqual({ job: '/v1/job', status: '/status', capability: '/capability' });
    expect(surface.notes).toHaveLength(5);
    const notes = surface.notes.join(' ');
    // The model of the advert and of every receipt, and the hash that a receipt commits to.
    expect(notes).toContain(`name the model ${PRIORAUTH_MODELS.intake}`);
    expect(notes).toContain('bad_shape (400)');
    expect(notes).toContain('check_unavailable');
    expect(notes).toContain('It is not a coverage decision.');
  });
});

describe('every refusal of a setting that the manifest publishes, with its accepted twin', () => {
  /** A value that no setting takes. A message must name the setting and never repeat it. */
  const MARKER = 'zq9-marker-value-7f3';
  const ANOTHER_DID = `did:vector:${'ab'.repeat(32)}`;
  const required = (name: string): RegExp => new RegExp(`^environment variable ${name} is required \\(.+\\) and is not set$`);
  const CONTACT_RULE = /^environment variable OPERATOR_CONTACT must be one line of at most 200 characters with no control character, and it has \d+ characters$/;
  const DID_RULE = /^environment variable AGENT_DID must be did:vector:<64 lowercase hex> or its legacy form under the registry policy [0-9a-f]{56}, got \d+ characters$/;
  const VERSION_RULE = /^environment variable AGENT_VERSION must be 1 to 32 letters, digits, dots, hyphens and plus signs, and it has \d+ characters$/;
  const SINCE_FORM = /^environment variable AGENT_STATUS_SINCE must be a date as YYYY-MM-DD, and it has \d+ characters$/;
  const SINCE_DAY = /^environment variable AGENT_STATUS_SINCE must be a date that exists, and it has \d+ characters$/;
  const LINK_RULE = /^environment variable ADVERT_EXPLORER_URL must be an https address with no user and no password, and it has \d+ characters$/;
  const DERIVED = identityRegistryOf(POLICY, undefined)?.address ?? '';

  /** The setting, the value that is refused (undefined: not set), the start of the message, the same setting with a value that is accepted (the twin), and a value that breaks the same rule and that no message could repeat by chance. */
  type Row = readonly [setting: string, bad: string | undefined, refusal: RegExp, good: string | undefined, probe?: string];
  const ROWS: readonly Row[] = [
    ['OPERATOR_CONTACT', undefined, required('OPERATOR_CONTACT'), 'ops@example.test'],
    ['OPERATOR_CONTACT', 'line one\nline two', CONTACT_RULE, 'ops@example.test', `${MARKER}\u0001x`],
    ['OPERATOR_CONTACT', `${'a'.repeat(188)}@example.test`, CONTACT_RULE, `${'a'.repeat(187)}@example.test`, `${MARKER} ${'b'.repeat(201)}`],
    ['AGENT_DID', undefined, required('AGENT_DID'), ANOTHER_DID],
    ['AGENT_DID', 'did:vector:abc', DID_RULE, ANOTHER_DID, `did:vector:${MARKER}`],
    ['AGENT_DID', `did:vector:${'zz'.repeat(32)}`, DID_RULE, ANOTHER_DID, `did:vector:${MARKER}`],
    ['IDENTITY_POLICY_ID', 'abc', /^environment variable IDENTITY_POLICY_ID must be 56 lowercase hex characters, got 3 characters$/, POLICY],
    ['IDENTITY_POLICY_ID', 'zz'.repeat(28), /^environment variable IDENTITY_POLICY_ID must be 56 lowercase hex characters, got 56 characters$/, POLICY],
    ['IDENTITY_ADDRESS', 'addr1xyzxyzxyzxyz', /^environment variable IDENTITY_ADDRESS \(17 characters\) is not the address of IDENTITY_POLICY_ID \(addr1[0-9a-z]+\)$/, DERIVED],
    ['SUPPLIER_PKH', undefined, required('SUPPLIER_PKH'), OTHER.pkh],
    ['SUPPLIER_PUB_KEY_HEX', undefined, required('SUPPLIER_PUB_KEY_HEX'), OTHER.pubKeyHex],
    ['INTAKE_SERVICE_PKH', undefined, required('INTAKE_SERVICE_PKH'), OTHER.pkh],
    ['LLM_MODEL_ALLOWLIST', undefined, required('LLM_MODEL_ALLOWLIST'), 'a/one'],
    ['LLM_MAX_PRICE_LOVELACE', undefined, required('LLM_MAX_PRICE_LOVELACE'), '250000'],
    ['LLM_MAX_PRICE_LOVELACE', '0', /^environment variable LLM_MAX_PRICE_LOVELACE must be a whole number of lovelace of more than 0$/, '1'],
    ['AGENT_VERSION', '0.1.0 beta', VERSION_RULE, '1.2.3-rc.1+build'],
    ['AGENT_VERSION', 'v'.repeat(33), VERSION_RULE, 'v'.repeat(32)],
    ['AGENT_VERSION', '-1', VERSION_RULE, '1'],
    ['AGENT_STATUS_CHIP', 'done', /^environment variable AGENT_STATUS_CHIP must be one of LIVE, DEPLOYED, PROPOSED, in any case, and it has 4 characters$/, 'LIVE'],
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
    const text = message(() => manifestFromEnv(envWith({ [setting]: bad })));
    expect(text).toMatch(refusal);
    expect(text).toContain(setting);
    if (bad !== undefined) expect(shows(text, bad), 'the message repeats the value').toBe(false);
    expect(() => manifestFromEnv(envWith({ [setting]: good })), `${setting} = ${String(good)}`).not.toThrow();
    if (bad === undefined) return;
    // The same rule with a value that no message could repeat by chance.
    const odd = probe ?? `${MARKER} !`;
    const probed = message(() => manifestFromEnv(envWith({ [setting]: odd })));
    expect(probed).toContain(setting);
    expect(shows(probed, odd), `the message repeats ${odd}`).toBe(false);
  });

  test('a setting that is published and not set stops the render by its name, whether it is missing, empty or blank: there is no default for a contact, a DID or a key', () => {
    for (const name of ['OPERATOR_CONTACT', 'AGENT_DID', 'SUPPLIER_PKH', 'SUPPLIER_PUB_KEY_HEX', 'INTAKE_SERVICE_PKH', 'LLM_MODEL_ALLOWLIST', 'LLM_MAX_PRICE_LOVELACE']) {
      for (const empty of [undefined, '', '  ']) expect(message(() => manifestFromEnv(envWith({ [name]: empty }))), `${name} = ${JSON.stringify(empty)}`).toMatch(required(name));
    }
  });
});

describe('the behaviour', () => {
  test('holds the members of the kit: the claim word for word, no operations and no co-sign rule, no fault value, the models, and the routes that the agent calls', () => {
    const { behaviour } = manifestOf();
    expect(behaviour.claim).toStrictEqual({ statements: INTAKE_CLAIM.statements.map(({ id, text }) => ({ id, text })) });
    expect(behaviour.claim.statements.map((statement) => statement.id)).toStrictEqual(['S1', 'S2', 'S3']);
    expect(behaviour.fault_modes).toStrictEqual([]);
    expect(behaviour.model).toStrictEqual({ allowlist: ['deepseek/deepseek-v4-flash'], max_price_lovelace: 1_000_000 });
    // The two routes of the insurer portal are the routes of the kit, on the tenant of the request.
    const portal = (['insurer.requirements', 'insurer.requests'] as const).map((route) => `${ROUTES[route].method} /t/{tenant}${ROUTES[route].template}`);
    expect(portal).toStrictEqual(['GET /t/{tenant}/insurer/requirements/{service_code}', 'POST /t/{tenant}/insurer/requests']);
    expect(behaviour.relying_on).toStrictEqual({ mock_systems: portal, gateway_routes: ['POST /spiffe/jwt-svid', 'GET /1.0/identifiers/{did}'] });
    expect(Object.keys(behaviour)).toStrictEqual(['data_handling', 'third_parties', 'claim', 'fault_modes', 'model', 'relying_on']);
    expect(parseBehaviourAdditions('insurer-intake-agent', { claim: behaviour.claim, fault_modes: behaviour.fault_modes, model: behaviour.model, relying_on: behaviour.relying_on }).ok).toBe(true);
    expect(behaviour.data_handling).toContain('synthetic');
    expect(behaviour.third_parties).toHaveLength(5);
  });

  test('the models and the ceiling come from the settings: a list of models and a ceiling of 250,000 lovelace reach the manifest', () => {
    expect(manifestOf({ LLM_MODEL_ALLOWLIST: 'a/one, b/two', LLM_MAX_PRICE_LOVELACE: '250000' }).behaviour.model).toStrictEqual({ allowlist: ['a/one', 'b/two'], max_price_lovelace: 250_000 });
  });
});

describe('the gaps', () => {
  test('are the six of the page of the agent in its order, the two that this agent adds, the sentence about the keys of the parties, and the run-in lead, in that order', () => {
    expect(manifestOf().gaps).toStrictEqual([COVERAGE_GAP, COMPLETENESS_GAP, LEDGER_GAP, REPORTED_GAP, REFUSED_GAP, SYNTHETIC_GAP, BINDING_GAP, UNREADABLE_GAP, KEYS_GAP, NOT_SHOWN_GAP]);
    expect(manifestOf().gaps).toStrictEqual([...gapsFor()]);
    expect(gapsFor()).toHaveLength(10);
    expect(new Set(gapsFor()).size).toBe(10);
  });

  test('say what the page says, word for word', () => {
    expect([COVERAGE_GAP, COMPLETENESS_GAP, LEDGER_GAP, REPORTED_GAP, REFUSED_GAP, SYNTHETIC_GAP]).toStrictEqual([
      'An intake record is not a coverage decision.',
      'The model decides completeness. Nothing in this agent overrides it.',
      'The checks read the ledger and the gateway as they are at that moment.',
      "The sender's organisation and its provenance, software and principal-binding attestations are reported, not required.",
      'A request refused is not paid, and leaves no signed record of the refusal except, on a digest mismatch, the evidence of the challenge.',
      'Every request is synthetic.',
    ]);
  });

  test('say the two things that this agent adds: the digest of the principal-binding attestation is not checked, and a source that cannot be read is unreadable and never absent', () => {
    expect(BINDING_GAP).toBe('The report does not check the digest of the principal-binding attestation, because the salt and the document stay with the hirer.');
    expect(UNREADABLE_GAP).toBe('A source that cannot be read is reported as unreadable and never as absent.');
  });

  test('say who holds the keys of the parties, and end with the run-in lead and its three items, the challenge of the Prior Authorization Agent among them', () => {
    expect(KEYS_GAP).toContain('The controller key, the Accountable key and the guardian keys of this deployment are on one host of one operator');
    expect(KEYS_GAP).toContain('so a party is independent of the controller by key only');
    expect(gapsFor().at(-1)).toBe(NOT_SHOWN_GAP);
    expect(NOT_SHOWN_GAP.startsWith('What this does not show:')).toBe(true);
    for (const item of [
      'the refund of the escrow of a revoked agent', 'a relying party that refuses a live token after its authority ended', 'the challenge of the Prior Authorization Agent against this agent, because this agent has no fault value',
    ]) expect(NOT_SHOWN_GAP).toContain(item);
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
  const buyer = keyOf(SERVICE.privateKeyHex);
  const advert = (manifest: IntakeManifest, extra: Partial<AdvertDatum> & { agent_id?: string } = {}): AdvertDatum => ({
    supplier_pkh: SUPPLIER.pkh, capability_id: manifest.capability_id, model: PRIORAUTH_MODELS.intake, max_output_tokens: 0, max_processing_ms: manifest.terms.max_processing_ms,
    price_lovelace: BigInt(manifest.terms.price_lovelace), supplier_bond_lovelace: BigInt(manifest.terms.supplier_bond_lovelace), buyer_bond_lovelace: BigInt(manifest.terms.buyer_bond_lovelace),
    endpoint_url: 'https://intake.example.test', detail_uri: 'https://intake.example.test/agent.json', detail_hash: render().sha256, advertised_at: NOW.now(), status: 'Active', ...extra,
  }) as AdvertDatum;

  test('are the price 2 and both bonds 1, in a window of 480,000 ms, and the request is at most 900,000 bytes of wire payload', () => {
    expect(manifestOf().terms).toStrictEqual({
      price_lovelace: 2_000_000, supplier_bond_lovelace: 1_000_000, buyer_bond_lovelace: 1_000_000, max_processing_ms: 480_000, input_limits: { request_bytes: 900_000 },
    });
    expect(MAX_REQUEST_BYTES).toBe(900_000);
  });

  test('give a lock of 4,000,000 lovelace, the price and both bonds, for a Post on the advert in the legacy layout and in the identity layout', () => {
    const manifest = manifestOf();
    const legacy = planFleetPostEscrow(advert(manifest), REF, buyer.pkh, PROMPT, NOW.now());
    expect(legacy.layout).toBe('legacy');
    expect(legacy.lockLovelace).toBe(4_000_000n);
    const identityAdvert = advert(manifest, { agent_id: AGENT_DID.slice('did:vector:'.length) });
    const identity = planFleetPostEscrow(identityAdvert, REF, buyer.pkh, PROMPT, NOW.now(), fleetPostTerms(identityAdvert, SERVICE_ADDRESS));
    expect(identity.layout).toBe('identity');
    expect(identity.lockLovelace).toBe(4_000_000n);
    expect(identity.lockLovelace).toBe(BigInt(manifest.terms.price_lovelace + manifest.terms.supplier_bond_lovelace + manifest.terms.buyer_bond_lovelace));
    // The window of the advert is the window of the escrow: the Post leaves the supplier all of it before deliver_by.
    expect(identity.deliverBy).toBe(NOW.now() + manifest.terms.max_processing_ms + DELIVER_BY_BUFFER_MS);
  });

  test('follow a price that the operator sets: the lock is that price and both bonds', () => {
    const manifest = manifestOf({ ADVERT_PRICE_LOVELACE: '6000000', ADVERT_MAX_PROCESSING_MS: '600000' });
    expect([manifest.terms.price_lovelace, manifest.terms.max_processing_ms]).toStrictEqual([6_000_000, 600_000]);
    expect(planFleetPostEscrow(advert(manifest), REF, buyer.pkh, PROMPT, NOW.now()).lockLovelace).toBe(8_000_000n);
  });

  test('the longest window and the highest price that the settings take are the longest window and the highest price that a Post plans, and one step more is refused by buyer-core as the settings refuse it', () => {
    expect([MAX_PROCESSING_WINDOW_MS, MAX_PRICE_LOVELACE]).toStrictEqual([86_400_000, 9_998_000_000]);
    const longest = manifestOf({ ADVERT_MAX_PROCESSING_MS: String(MAX_PROCESSING_WINDOW_MS) });
    expect(longest.terms.max_processing_ms).toBe(MAX_PROCESSING_WINDOW_MS);
    expect(() => planFleetPostEscrow(advert(longest), REF, buyer.pkh, PROMPT, NOW.now())).not.toThrow();
    expect(() => planFleetPostEscrow(advert(longest, { max_processing_ms: MAX_PROCESSING_WINDOW_MS + 1 }), REF, buyer.pkh, PROMPT, NOW.now())).toThrow(/longer than the 86400000 ms/);
    expect(message(() => manifestFromEnv(envWith({ ADVERT_MAX_PROCESSING_MS: String(MAX_PROCESSING_WINDOW_MS + 1) })))).toContain('must be at most 86400000');
    const dearest = manifestOf({ ADVERT_PRICE_LOVELACE: String(MAX_PRICE_LOVELACE) });
    expect(dearest.terms.price_lovelace).toBe(MAX_PRICE_LOVELACE);
    expect(planFleetPostEscrow(advert(dearest), REF, buyer.pkh, PROMPT, NOW.now()).lockLovelace).toBe(10_000_000_000n);
    expect(() => planFleetPostEscrow(advert(dearest, { price_lovelace: BigInt(MAX_PRICE_LOVELACE) + 1n }), REF, buyer.pkh, PROMPT, NOW.now())).toThrow(/value cap/);
    expect(message(() => manifestFromEnv(envWith({ ADVERT_PRICE_LOVELACE: String(MAX_PRICE_LOVELACE + 1) })))).toContain('must be at most 9998000000');
  });

  test('the deadline of a Post follows the clock of the tests, which moves by hand and never by itself', async () => {
    const clock = new FakeClock();
    const manifest = manifestOf();
    const deadline = (): number => planFleetPostEscrow(advert(manifest), REF, buyer.pkh, PROMPT, clock.now()).deliverBy;
    const first = deadline();
    expect(deadline()).toBe(first);
    await clock.sleep(5_000);
    expect(deadline() - first).toBe(5_000);
    clock.advance(0);
    expect(deadline() - first).toBe(5_000);
    for (const wrong of [-1, 1.5, Number.NaN]) expect(() => clock.advance(wrong), String(wrong)).toThrow(RangeError);
  });
});

/** The keywords of the JSON Schema that the manifest uses. A reader of a schema that meets another keyword throws, so the schema cannot gain a rule that this test skips. */
const KEYWORDS = ['type', 'const', 'oneOf', 'required', 'additionalProperties', 'properties', 'pattern', 'minLength', 'maxLength', 'minItems', 'maxItems', 'uniqueItems', 'items', 'description'];
type Schema = { readonly [keyword: string]: unknown };
const within = (count: number, least: unknown, most: unknown): boolean => (least === undefined || count >= Number(least)) && (most === undefined || count <= Number(most));

/** Does `value` pass `schema`? Lengths are counted in code points, as JSON Schema counts them. */
function accepts(schema: Schema, value: unknown): boolean {
  for (const keyword of Object.keys(schema)) if (!KEYWORDS.includes(keyword)) throw new Error(`this test does not read the keyword ${keyword}`);
  if (Array.isArray(schema.oneOf)) return (schema.oneOf as Schema[]).filter((option) => accepts(option, value)).length === 1;
  if ('const' in schema) return value === schema.const;
  switch (schema.type) {
    case 'null':
      return value === null;
    case 'string':
      return typeof value === 'string' && within([...value].length, schema.minLength, schema.maxLength) && (schema.pattern === undefined || new RegExp(String(schema.pattern), 'u').test(value));
    case 'array': {
      if (!Array.isArray(value) || !within(value.length, schema.minItems, schema.maxItems)) return false;
      if (schema.uniqueItems === true && new Set(value).size !== value.length) return false;
      return value.every((item) => accepts(schema.items as Schema, item));
    }
    case 'object': {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
      const members = value as Record<string, unknown>;
      const properties = (schema.properties ?? {}) as Record<string, Schema>;
      if (!((schema.required ?? []) as string[]).every((name) => name in members)) return false;
      return Object.entries(members).every(([name, member]) => (name in properties ? accepts(properties[name], member) : schema.additionalProperties !== false));
    }
    default:
      throw new Error(`this test does not read the type ${String(schema.type)}`);
  }
}

describe('the schema of the handoff', () => {
  const REQUEST = {
    schema: PRIORAUTH_REQUEST_SCHEMA, request_number: 'run1-1', tenant: 'run1', order_id: 'ord-1', patient_ref: 'pat-1', ordering_clinician_ref: 'clin-1', service_code: 'svc-1', diagnosis_codes: ['Z00.0'],
    justification: 'The service is ordered for a synthetic reason.', guideline_refs: ['crit-1'], record_refs: ['rec-1'], record_set_sha256: '0a'.repeat(32), insurer_did: `did:vector:${'4e'.repeat(32)}`,
    advert_ref: `${'1b'.repeat(32)}#0`,
  };
  const APPROVAL = { attestation: '2c'.repeat(32), issuer_did: `did:vector:${'3d'.repeat(32)}` };
  const HANDOFF = { schema: HANDOFF_SCHEMA, use_case: 'prior-authorization', sender_did: `did:vector:${'ef'.repeat(32)}`, delegation: 'ab'.repeat(32), document: REQUEST, salt: 'cd'.repeat(32), approval: APPROVAL };
  const handoff = (over: Record<string, unknown>): Record<string, unknown> => ({ ...HANDOFF, ...over });
  const document = (over: Record<string, unknown>): Record<string, unknown> => handoff({ document: { ...REQUEST, ...over } });
  const without = (name: string): Record<string, unknown> => Object.fromEntries(Object.entries(HANDOFF).filter(([key]) => key !== name));
  const documentWithout = (name: string): Record<string, unknown> => handoff({ document: Object.fromEntries(Object.entries(REQUEST).filter(([key]) => key !== name)) });
  const ids = (count: number): string[] => Array.from({ length: count }, (_, index) => `id-${index}`);

  /** What the service takes: a handoff of the kit, for use case 2, whose document is an authorization request. */
  function serviceAccepts(value: unknown): boolean {
    const parsed = parseHandoff(value);
    return parsed.ok && parsed.value.use_case === 'prior-authorization' && parsePriorAuthRequest(parsed.value.document).ok;
  }

  const CASES: readonly (readonly [what: string, value: unknown, expected: boolean])[] = [
    ['the sample', HANDOFF, true],
    ['no approval (null)', handoff({ approval: null }), true],
    ['an approval with a member too many', handoff({ approval: { ...APPROVAL, extra: 'x' } }), false],
    ['an approval with no issuer', handoff({ approval: { attestation: APPROVAL.attestation } }), false],
    ['an approval that is a text', handoff({ approval: 'yes' }), false],
    ['the use case of use case 1', handoff({ use_case: 'inventory-reorder' }), false],
    ['another schema of the handoff', handoff({ schema: 'vector.usecase.handoff.v2' }), false],
    ['a member too many', handoff({ extra: 1 }), false],
    ['no salt', without('salt'), false],
    ['a salt of 63 characters', handoff({ salt: HANDOFF.salt.slice(1) }), false],
    ['a delegation in capitals', handoff({ delegation: HANDOFF.delegation.toUpperCase() }), false],
    ['a sender that is no DID', handoff({ sender_did: 'someone' }), false],
    ['a sender in capitals', handoff({ sender_did: HANDOFF.sender_did.toUpperCase() }), false],
    ['no document', without('document'), false],
    ['a document that is a text', handoff({ document: 'a request' }), false],
    ['a document of another schema', document({ schema: 'vector.usecase.po.v1' }), false],
    ['a document with a member too many', document({ extra: 1 }), false],
    ['a document with no justification', documentWithout('justification'), false],
    ['a justification of 4000 characters', document({ justification: 'a'.repeat(MAX_JUSTIFICATION_CHARS) }), true],
    ['a justification of 4001 characters', document({ justification: 'a'.repeat(MAX_JUSTIFICATION_CHARS + 1) }), false],
    ['an empty justification', document({ justification: '' }), false],
    ['8 diagnosis codes', document({ diagnosis_codes: ids(8) }), true],
    ['9 diagnosis codes', document({ diagnosis_codes: ids(9) }), false],
    ['no diagnosis code', document({ diagnosis_codes: [] }), false],
    ['a diagnosis code of 16 characters', document({ diagnosis_codes: ['a'.repeat(16)] }), true],
    ['a diagnosis code of 17 characters', document({ diagnosis_codes: ['a'.repeat(17)] }), false],
    ['an empty diagnosis code', document({ diagnosis_codes: [''] }), false],
    ['20 guideline references', document({ guideline_refs: ids(20) }), true],
    ['21 guideline references', document({ guideline_refs: ids(21) }), false],
    ['no guideline reference', document({ guideline_refs: [] }), true],
    ['a guideline reference twice', document({ guideline_refs: ['crit-1', 'crit-1'] }), false],
    ['50 record references', document({ record_refs: ids(50) }), true],
    ['51 record references', document({ record_refs: ids(51) }), false],
    ['no record reference', document({ record_refs: [] }), true],
    ['a record reference twice', document({ record_refs: ['rec-1', 'rec-1'] }), false],
    ['a request number of 64 characters', document({ request_number: 'a'.repeat(64) }), true],
    ['a request number of 65 characters', document({ request_number: 'a'.repeat(65) }), false],
    ['a request number that starts with a hyphen', document({ request_number: '-run1' }), false],
    ['an order id with a space', document({ order_id: 'ord 1' }), false],
    ['a patient reference of 65 characters', document({ patient_ref: 'a'.repeat(65) }), false],
    ['a clinician reference that is empty', document({ ordering_clinician_ref: '' }), false],
    ['a service code with a slash', document({ service_code: 'svc/1' }), false],
    ['a tenant of 48 characters', document({ tenant: 'a'.repeat(48) }), true],
    ['a tenant of 49 characters', document({ tenant: 'a'.repeat(49) }), false],
    ['a tenant in capitals', document({ tenant: 'RUN1' }), false],
    ['a record set hash of 63 characters', document({ record_set_sha256: REQUEST.record_set_sha256.slice(1) }), false],
    ['a record set hash in capitals', document({ record_set_sha256: REQUEST.record_set_sha256.toUpperCase() }), false],
    ['an insurer that is no DID', document({ insurer_did: 'insurer' }), false],
    ['an advert reference with an index of 10 digits', document({ advert_ref: `${'1b'.repeat(32)}#${'1'.repeat(10)}` }), true],
    ['an advert reference with an index of 11 digits', document({ advert_ref: `${'1b'.repeat(32)}#${'1'.repeat(11)}` }), false],
    ['an advert reference with no index', document({ advert_ref: '1b'.repeat(32) }), false],
  ];

  test('is a JSON Schema of the handoff, with the authorization request as its document, and it names the members of the sample and no other', () => {
    expect(REQUEST_SCHEMA.type).toBe('object');
    expect(REQUEST_SCHEMA.additionalProperties).toBe(false);
    expect([...REQUEST_SCHEMA.required].sort()).toStrictEqual(Object.keys(HANDOFF).sort());
    expect(Object.keys(REQUEST_SCHEMA.properties).sort()).toStrictEqual(Object.keys(HANDOFF).sort());
    const documentSchema = REQUEST_SCHEMA.properties.document;
    expect([...documentSchema.required].sort()).toStrictEqual(Object.keys(REQUEST).sort());
    expect(Object.keys(documentSchema.properties).sort()).toStrictEqual(Object.keys(REQUEST).sort());
    expect(documentSchema.properties.schema.const).toBe(PRIORAUTH_REQUEST_SCHEMA);
    expect(REQUEST_SCHEMA.properties.schema.const).toBe(HANDOFF_SCHEMA);
    expect(REQUEST_SCHEMA.properties.use_case.const).toBe('prior-authorization');
    expect(documentSchema.properties.justification.maxLength).toBe(MAX_JUSTIFICATION_CHARS);
  });

  test.each(CASES)('holds the same rule as the parsers of the kit for %s', (_what, value, expected) => {
    expect(serviceAccepts(value), 'the parsers of the kit').toBe(expected);
    expect(accepts(REQUEST_SCHEMA as Schema, value), 'the schema of the manifest').toBe(expected);
  });
});
