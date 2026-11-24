// agents/sourcing-agent/test/serve/manifest.test.ts
// The manifest of the Sourcing Agent: the same bytes on every render, the same bytes for the empty fault setting and for `invert_scores`, a template file that equals the render of the template, and a hash that is
// the SHA-256 of the bytes that a server serves. The behaviour holds the members of the kit, the gaps are the twelve sentences of the page and then the one sentence of the kit, and the terms agree with the lock
// that a Post makes for the advert: the price and both bonds, 3 + 1 + 1 = 5 units. The manifest holds no controller and no secret, and its builder reads the public settings and no other.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { fleetPostTerms, planFleetPostEscrow } from '@vsa/buyer-core';
import type { AdvertDatum } from '@vsa/vector-read';
import { BID_CAPABILITIES, MAX_ITEM_QUANTITY, MAX_RFQ_ITEMS, SOURCING_CLAIM, SOURCING_MODEL, WEIGHT_NAMES, parseRfqDocument, parseWeights } from '@vsa/usecase-kit/bids';
import { faultGap, renderManifest } from '@vsa/usecase-kit/manifest';
import { COSIGN_RULE, MAX_REQUEST_BYTES } from '@vsa/usecase-kit/protocol';
import { gapsFor } from '../../src/serve/gaps.ts';
import { keyOf } from '../../src/serve/keys.ts';
import { DESCRIPTION, SOURCE_URL, SPEC_URL, TEMPLATE_ENV, manifestFromEnv, renderTemplate } from '../../src/serve/manifest.ts';
import { AGENT_DID, ISSUER, KEY_NUMBERS, KEY_VARIABLES, PKH_VARIABLES, SCORER_DIDS, SUPPLIER, completeEnv, messageOf, rawKey, secretsOf } from './support.ts';

const templateFile = fileURLToPath(new URL('../../agent.json.template', import.meta.url));

/** The environment of the manifest: the complete environment, with the key hashes that the service derives from its keys. */
const manifestEnv = (over: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => completeEnv({
  [PKH_VARIABLES.service]: keyOf(rawKey(KEY_NUMBERS.service)).pkh,
  [PKH_VARIABLES.delegation1]: keyOf(rawKey(KEY_NUMBERS.delegation1)).pkh,
  [PKH_VARIABLES.delegation2]: keyOf(rawKey(KEY_NUMBERS.delegation2)).pkh,
  ...over,
});

const render = (env: NodeJS.ProcessEnv = manifestEnv()) => {
  const rendered = renderManifest('sourcing-agent', (setting) => manifestFromEnv({ ...env, FAULT_MODE: setting }));
  if (!rendered.ok) throw new Error(`${rendered.code}: ${rendered.detail}`);
  return rendered.value;
};

/** The manifest of the render, as the data that a hirer reads. A reader below checks each member that it takes. */
const parsed = (env: NodeJS.ProcessEnv = manifestEnv()): unknown => JSON.parse(render(env).text);

/** The member at a path of a value, or `undefined` when a step of the path is no member. A wrong path makes an expectation fail and never a throw. */
const at = (value: unknown, ...path: readonly (string | number)[]): unknown =>
  path.reduce<unknown>((current, step) => (typeof current === 'object' && current !== null ? Reflect.get(current, step) : undefined), value);

/** A list of texts, or a throw: the one place where a member is read as a list of texts. */
function textsOf(value: unknown): string[] {
  if (!Array.isArray(value) || !value.every((entry): entry is string => typeof entry === 'string')) throw new Error('a list of texts was expected');
  return value;
}

/** A whole number, or a throw. */
function numberOf(value: unknown): number {
  if (typeof value !== 'number') throw new Error('a number was expected');
  return value;
}

/** A text, or a throw. */
function textOf(value: unknown): string {
  if (typeof value !== 'string') throw new Error('a text was expected');
  return value;
}

/** The twelve sentences of the page, in their order, as the manifest states them. The page repeats them word for word. */
const PAGE_GAPS = [
  'The model chooses whom to invite, whether to accept each quote, every score and the final order. Nothing in this agent overrides it. The approver sees the signed quote behind every score.',
  'A quote is a paid job, not a binding offer. Nothing on the ledger holds a bidder to its quote.',
  'This agent does not check the approval of the hirer. The sourcing record does.',
  'Reliability and compliance are read from a mock vendor master, a stake and one attestation by a demonstration registry.',
  'A challenge can put a hold on the identity of a bidder. It does not return what the escrow of the quote locked.',
  'A model call that fails ends the job. There is no second provider.',
  'Every bidder is operated by the same foundation as this agent.',
  'This agent hires the bidders one after the other: one delegation key pays for each hire, and a key runs one hire at a time.',
  'A bidder file shows the state of the compliance attestation of one named issuer key, and it shows that the bidder replied when it did. The agent does not read the reply.',
  'Before it pays a bidder, the agent reads the status of the record again and needs a price list that it can check. A bidder that fails either is left out with a reason.',
  'The controller key, the Accountable key and the guardian keys of this deployment are held on one host by one operator, so a party is independent of the controller by key only.',
  'What this does not show: no run covers the refund of the escrow of a revoked agent, the reclaim of an escrow in use case 3, or a relying party that refuses a live token after its authority ends. Tests cover that last case only.',
] as const;

/** Every name of a member, at any depth of a JSON value. */
function memberNames(value: unknown, into: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) for (const entry of value) memberNames(entry, into);
  else if (typeof value === 'object' && value !== null) {
    for (const [name, entry] of Object.entries(value)) {
      into.add(name);
      memberNames(entry, into);
    }
  }
  return into;
}

/** An environment that records every name that is read from it, and every enumeration of it. */
function recording(env: NodeJS.ProcessEnv): { readonly env: NodeJS.ProcessEnv; readonly read: Set<string> } {
  const read = new Set<string>();
  const proxy = new Proxy(env, {
    get: (target, name) => {
      if (typeof name === 'string') read.add(name);
      return Reflect.get(target, name);
    },
    has: (target, name) => {
      if (typeof name === 'string') read.add(name);
      return Reflect.has(target, name);
    },
    ownKeys: (target) => {
      read.add('<enumerated>');
      return Reflect.ownKeys(target);
    },
  });
  return { env: proxy, read };
}

describe('the bytes of the manifest', () => {
  test('are the same on every render: three renders give one text and one hash, and the hash is the SHA-256 of the text', () => {
    const [first, second, third] = [render(), render(), render()];
    expect(second.text).toBe(first.text);
    expect(third.text).toBe(first.text);
    expect(third.sha256).toBe(first.sha256);
    expect(first.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(first.sha256).toBe(createHash('sha256').update(first.text, 'utf8').digest('hex'));
    expect(JSON.stringify(manifestFromEnv(manifestEnv()))).toBe(first.text);
  });

  test('are the same for the empty setting and for invert_scores, and for a value that no kind lists: the builder gives the same text for every FAULT_MODE', () => {
    const env = manifestEnv();
    const clean = JSON.stringify(manifestFromEnv({ ...env, FAULT_MODE: '' }));
    expect(JSON.stringify(manifestFromEnv({ ...env, FAULT_MODE: 'invert_scores' }))).toBe(clean);
    expect(JSON.stringify(manifestFromEnv({ ...env, FAULT_MODE: undefined }))).toBe(clean);
    expect(JSON.stringify(manifestFromEnv({ ...env, FAULT_MODE: 'quote_off_price_list' }))).toBe(clean);
    expect(JSON.stringify(manifestFromEnv({ ...env, FAULT_MODE: 'zq9-marker-value' }))).toBe(clean);
    expect(render(env).text).toBe(clean);
  });

  test('change with a setting of the manifest and with nothing else: another model, another DID, another price or another window gives another hash, and a setting that is not in the manifest gives the same one', () => {
    const base = render().sha256;
    expect(render(manifestEnv({ LLM_MODEL_ALLOWLIST: 'other/model' })).sha256).not.toBe(base);
    expect(render(manifestEnv({ AGENT_DID: `did:vector:${'c3'.repeat(32)}` })).sha256).not.toBe(base);
    expect(render(manifestEnv({ ADVERT_PRICE_LOVELACE: '4000000' })).sha256).not.toBe(base);
    expect(render(manifestEnv({ ADVERT_MAX_PROCESSING_MS: '4200000' })).sha256).not.toBe(base);
    expect(render(manifestEnv({ COMPLIANCE_ISSUER_PKH: SUPPLIER.keyHash })).sha256).not.toBe(base);
    const unrelated = { PORT: '9999', HOST: '127.0.0.2', MOCK_PUBLIC_BASE: 'https://other.example', SCORER_1_DID: `did:vector:${'d1'.repeat(32)}`, QUOTE_MAX_PRICE_LOVELACE: '3000000', DISPUTE_READ_TIMEOUT_MS: '30000' };
    expect(render(manifestEnv(unrelated)).sha256).toBe(base);
  });

  test('hold the fault value in the two places of the kit only: the list of the possible values and the one gap sentence, and no member fault_mode', () => {
    const manifest = parsed();
    const text = render().text;
    expect(at(manifest, 'behaviour', 'fault_modes')).toStrictEqual(['invert_scores']);
    const sentence = faultGap('sourcing-agent');
    expect(sentence).not.toBeNull();
    expect(textsOf(at(manifest, 'gaps')).at(-1)).toBe(sentence);
    // Once in `fault_modes`, and as often as the sentence of the kit names it.
    expect(text.split('invert_scores').length - 1).toBe(1 + (sentence ?? '').split('invert_scores').length - 1);
    expect(text).not.toMatch(/"fault_mode"\s*:/);
    for (const other of ['confirm_wrong_lot', 'alter_after_approval', 'quote_off_price_list']) expect(text).not.toContain(other);
  });

  test('are made by a builder that reads the public settings of the manifest and no other, and never a key, the token, a scorer or the fault switch', () => {
    const env = manifestEnv({ FAULT_MODE: 'invert_scores' });
    const spy = recording(env);
    const text = JSON.stringify(manifestFromEnv(spy.env));
    expect([...spy.read].sort()).toStrictEqual([
      'ADVERT_EXPLORER_URL', 'ADVERT_MAX_PROCESSING_MS', 'ADVERT_PRICE_LOVELACE', 'AGENT_DID', 'AGENT_STATUS_CHIP', 'AGENT_STATUS_SINCE', 'AGENT_VERSION', 'COMPLIANCE_ISSUER_PKH',
      'IDENTITY_ADDRESS', 'IDENTITY_POLICY_ID', 'LLM_MAX_PRICE_LOVELACE', 'LLM_MODEL_ALLOWLIST', 'OPERATOR_CONTACT', 'SOURCING_DELEGATION_1_PKH', 'SOURCING_DELEGATION_2_PKH',
      'SOURCING_SERVICE_PKH', 'SUPPLIER_PKH', 'SUPPLIER_PUB_KEY_HEX',
    ]);
    for (const secret of [...Object.values(KEY_VARIABLES), 'SERVICE_AUTH_HEADER', 'FAULT_MODE', 'SCORER_1_DID', 'SCORER_2_DID', 'SCORER_3_DID']) expect(spy.read.has(secret)).toBe(false);
    // The environment holds each key and the token, and the manifest holds none of them, in hex or in bech32 form, in any case.
    const lower = text.toLowerCase();
    for (const secret of secretsOf(env)) expect(lower).not.toContain(secret.toLowerCase());
    for (const did of SCORER_DIDS) expect(text).not.toContain(did);
  });
});

describe('the template', () => {
  test('is the render of the template environment, byte for byte: indented JSON with a line break at the end and placeholders for the operator values', () => {
    const file = readFileSync(templateFile, 'utf8');
    expect(file).toBe(renderTemplate());
    expect(file.endsWith('}\n')).toBe(true);
    const placeholders = [
      'OPERATOR_CONTACT', 'AGENT_DID', 'SUPPLIER_PKH', 'SUPPLIER_PUB_KEY_HEX', 'SOURCING_SERVICE_PKH', 'SOURCING_DELEGATION_1_PKH', 'SOURCING_DELEGATION_2_PKH', 'COMPLIANCE_ISSUER_PKH',
    ] as const satisfies readonly (keyof typeof TEMPLATE_ENV)[];
    for (const name of placeholders) {
      expect(file).toContain(`<${name}>`);
      expect(TEMPLATE_ENV[name]).toBe(`<${name}>`);
    }
    expect(JSON.parse(file)).toMatchObject({ name: 'Sourcing Agent', capability_id: 'supplychain.rfq.evaluate.v1', status: { chip: 'proposed', since: '2026-11-24' } });
  });

  test('has the same members as the served manifest, and the model and its ceiling are values and not placeholders', () => {
    const template: unknown = JSON.parse(readFileSync(templateFile, 'utf8'));
    expect([...memberNames(template)].sort()).toStrictEqual([...memberNames(parsed())].sort());
    expect(at(template, 'behaviour', 'model')).toStrictEqual({ allowlist: ['deepseek/deepseek-v4-flash'], max_price_lovelace: 1_000_000 });
    expect(at(template, 'gaps')).toStrictEqual(at(parsed(), 'gaps'));
  });

  test('is never served: a manifest that still has a placeholder is refused by the render of a served manifest', () => {
    const rendered = renderManifest('sourcing-agent', () => manifestFromEnv(TEMPLATE_ENV));
    expect(rendered.ok).toBe(false);
    if (!rendered.ok) expect(rendered.code).toBe('manifest_has_placeholder');
  });
});

describe('the members of the manifest', () => {
  test('name the agent, its capability, its identity, its keys, its status and its links', () => {
    const manifest = parsed();
    expect(Object.keys(Object(manifest))).toStrictEqual(['schema', 'name', 'capability_id', 'version', 'description', 'operator', 'identity', 'keys', 'interface', 'terms', 'behaviour', 'status', 'gaps', 'links']);
    expect(manifest).toMatchObject({
      schema: 'vector.agent-manifest.v2', name: 'Sourcing Agent', capability_id: BID_CAPABILITIES.evaluate, version: '0.1.0', description: DESCRIPTION,
      operator: { name: 'Apex Fusion Foundation', contact: 'ops@example.test' },
      status: { chip: 'proposed', since: '2026-11-24' },
      links: { spec: SPEC_URL, source: SOURCE_URL, explorer_advert: '' },
    });
    expect(at(manifest, 'capability_id')).toBe('supplychain.rfq.evaluate.v1');
    expect(at(manifest, 'description')).toBe(
      "For a buying organisation: finds the suppliers that quote on the marketplace, asks each for a signed quote on a request for quotation, scores the quotes against price, lead time, reliability and compliance, and returns a ranked comparison. Once the organisation has approved the ranking, it writes it to the organisation's sourcing record.",
    );
    expect(SPEC_URL.endsWith('/specs/sourcing-agent.md')).toBe(true);
    expect(SOURCE_URL.endsWith('/agents/sourcing-agent')).toBe(true);
    expect(at(manifest, 'interface', 'routes')).toStrictEqual({ job: '/v1/job', status: '/status', capability: '/capability' });
    expect(at(manifest, 'interface', 'response_schema')).toStrictEqual({ $ref: `${SPEC_URL}#response` });
  });

  test('hold the identity block of the DID, the registry address and the supplier key, and no controller anywhere', () => {
    const manifest = parsed();
    expect(Object.keys(Object(at(manifest, 'identity')))).toStrictEqual(['did', 'registry_address', 'supplier_key']);
    expect(at(manifest, 'identity', 'did')).toBe(AGENT_DID);
    expect(at(manifest, 'identity', 'supplier_key')).toBe(`${AGENT_DID}#${SUPPLIER.keyHash}`);
    expect(textOf(at(manifest, 'identity', 'registry_address'))).toMatch(/^addr1/);
    // A member of the manifest at any depth: none is named for a controller, so a change of the controller of the record changes nothing that the manifest says.
    for (const name of memberNames(manifest)) expect(name.toLowerCase()).not.toContain('controller');
  });

  test('hold the key hash and the public key of the supplier key, the key hash of the service key and of the two delegation keys, and the key hash of the issuer of the compliance attestations', () => {
    const manifest = parsed();
    expect(Object.keys(Object(at(manifest, 'keys')))).toStrictEqual(['supplier_pkh', 'pub_key_hex', 'service_pkh', 'delegation_pkhs', 'compliance_issuer_pkh']);
    expect(at(manifest, 'keys')).toStrictEqual({
      supplier_pkh: SUPPLIER.keyHash, pub_key_hex: SUPPLIER.publicKey, service_pkh: keyOf(rawKey(KEY_NUMBERS.service)).pkh,
      delegation_pkhs: [keyOf(rawKey(KEY_NUMBERS.delegation1)).pkh, keyOf(rawKey(KEY_NUMBERS.delegation2)).pkh], compliance_issuer_pkh: ISSUER.keyHash,
    });
    // The key hashes of the six keys of the scorers are not published: the records of the scorers list them.
    const text = render().text;
    for (const role of ['scorer1Authentication', 'scorer1Delegation', 'scorer2Authentication', 'scorer2Delegation', 'scorer3Authentication', 'scorer3Delegation'] as const) {
      expect(text).not.toContain(keyOf(rawKey(KEY_NUMBERS[role])).pkh);
    }
  });

  test('take the status and the version from the settings, and a wrong status stops the render by its variable', () => {
    expect(parsed(manifestEnv({ AGENT_STATUS_CHIP: 'LIVE', AGENT_STATUS_SINCE: '2026-12-01', AGENT_VERSION: '0.2.0', ADVERT_EXPLORER_URL: 'https://explorer.example/advert' }))).toMatchObject({
      status: { chip: 'live', since: '2026-12-01' }, version: '0.2.0', links: { explorer_advert: 'https://explorer.example/advert' },
    });
    expect(parsed(manifestEnv({ AGENT_STATUS_CHIP: '', AGENT_STATUS_SINCE: ' ', AGENT_VERSION: ' ' }))).toMatchObject({ status: { chip: 'proposed', since: '2026-11-24' }, version: '0.1.0' });
    expect(messageOf(() => manifestFromEnv(manifestEnv({ AGENT_STATUS_CHIP: 'done' })))).toMatch(/^environment variable AGENT_STATUS_CHIP must be one of/);
    expect(messageOf(() => manifestFromEnv(manifestEnv({ AGENT_STATUS_SINCE: 'yesterday' })))).toMatch(/^environment variable AGENT_STATUS_SINCE must be a date/);
    expect(messageOf(() => manifestFromEnv(manifestEnv({ OPERATOR_CONTACT: undefined })))).toMatch(/^environment variable OPERATOR_CONTACT is required/);
    expect(messageOf(() => manifestFromEnv(manifestEnv({ AGENT_DID: `did:vector:${'zz'.repeat(32)}` })))).toMatch(/AGENT_DID/);
    expect(messageOf(() => manifestFromEnv(manifestEnv({ LLM_MODEL_ALLOWLIST: undefined })))).toMatch(/^environment variable LLM_MODEL_ALLOWLIST is required/);
    expect(messageOf(() => manifestFromEnv(manifestEnv({ ADVERT_MAX_PROCESSING_MS: '1800000' })))).toMatch(/^environment variable ADVERT_MAX_PROCESSING_MS must be at least 3600000/);
  });

  test('have a request schema with the two operations: propose with the request for quotation and the four weights, and execute with the proposal and the approval', () => {
    const schema = at(parsed(), 'interface', 'request_schema');
    expect(Object.keys(Object(schema))).toStrictEqual(['oneOf']);
    const propose = at(schema, 'oneOf', 0);
    const execute = at(schema, 'oneOf', 1);
    expect(at(propose, 'required')).toStrictEqual(['op', 'authority', 'tenant', 'rfq', 'weights']);
    expect(at(execute, 'required')).toStrictEqual(['op', 'authority', 'tenant', 'proposal', 'approval']);
    for (const operation of [propose, execute]) {
      expect(at(operation, 'additionalProperties')).toBe(false);
      expect(Object.keys(Object(at(operation, 'properties')))).toStrictEqual(at(operation, 'required'));
    }
    expect(at(propose, 'properties', 'op')).toStrictEqual({ const: 'propose' });
    expect(at(execute, 'properties', 'op')).toStrictEqual({ const: 'execute' });
    expect(at(propose, 'properties', 'authority')).toStrictEqual(at(execute, 'properties', 'authority'));
    expect(at(propose, 'properties', 'tenant')).toStrictEqual(at(execute, 'properties', 'tenant'));
    expect(at(propose, 'properties', 'tenant')).toMatchObject({ type: 'string', minLength: 1, maxLength: 48, pattern: '^[a-z0-9][a-z0-9-]{0,47}$' });
  });

  test('describe the request for quotation with the members, the limits and the forms of its parser, and the weights with the four names of the kit', () => {
    const propose = at(parsed(), 'interface', 'request_schema', 'oneOf', 0);
    const rfq = at(propose, 'properties', 'rfq');
    const sample = parseRfqDocument({ rfq_id: 'rfq-1', items: [{ sku: 'GLV-NIT-M', quantity: 5 }], needed_by: '2026-12-31' });
    expect(sample.ok).toBe(true);
    if (!sample.ok) return;
    expect(at(rfq, 'required')).toStrictEqual(Object.keys(sample.value));
    expect(Object.keys(Object(at(rfq, 'properties')))).toStrictEqual(Object.keys(sample.value));
    expect(at(rfq, 'additionalProperties')).toBe(false);
    expect(at(rfq, 'properties', 'rfq_id')).toMatchObject({ type: 'string', minLength: 1, maxLength: 64, pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$' });
    expect(at(rfq, 'properties', 'needed_by')).toMatchObject({ type: 'string', pattern: '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' });
    expect(at(rfq, 'properties', 'items')).toMatchObject({ type: 'array', minItems: 1, maxItems: MAX_RFQ_ITEMS });
    const item = at(rfq, 'properties', 'items', 'items');
    expect(at(item, 'required')).toStrictEqual(Object.keys(sample.value.items[0]));
    expect(at(item, 'additionalProperties')).toBe(false);
    expect(at(item, 'properties', 'sku')).toMatchObject({ type: 'string', minLength: 1, maxLength: 64, pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$' });
    expect(at(item, 'properties', 'quantity')).toMatchObject({ type: 'integer', minimum: 1, maximum: MAX_ITEM_QUANTITY });
    const weights = at(propose, 'properties', 'weights');
    const sampleWeights = parseWeights({ price: 0.4, lead_time: 0.2, reliability: 0.2, compliance: 0.2 });
    expect(sampleWeights.ok).toBe(true);
    if (!sampleWeights.ok) return;
    expect(at(weights, 'required')).toStrictEqual([...WEIGHT_NAMES]);
    expect(at(weights, 'required')).toStrictEqual(Object.keys(sampleWeights.value));
    expect(Object.keys(Object(at(weights, 'properties')))).toStrictEqual([...WEIGHT_NAMES]);
    expect(at(weights, 'additionalProperties')).toBe(false);
    for (const name of WEIGHT_NAMES) expect(at(weights, 'properties', name)).toMatchObject({ type: 'number', minimum: 0, maximum: 1 });
  });

  test('describe the proposal and the approval of execute as the Reorder Agent does, and the approval is null or a reference of two members', () => {
    const execute = at(parsed(), 'interface', 'request_schema', 'oneOf', 1);
    const proposal = at(execute, 'properties', 'proposal');
    expect(at(proposal, 'required')).toStrictEqual(['document', 'salt', 'proposal_digest']);
    expect(at(proposal, 'additionalProperties')).toBe(false);
    expect(Object.keys(Object(at(proposal, 'properties')))).toStrictEqual(['document', 'salt', 'proposal_digest']);
    const approval = at(execute, 'properties', 'approval', 'oneOf');
    expect(at(approval, 0)).toStrictEqual({ type: 'null' });
    expect(at(approval, 1, 'required')).toStrictEqual(['attestation', 'issuer_did']);
    expect(at(approval, 1, 'additionalProperties')).toBe(false);
  });

  test('have notes that name the two operations and the open co-sign route', () => {
    const notes = textsOf(at(parsed(), 'interface', 'notes'));
    expect(notes).toHaveLength(4);
    expect(notes[1]).toMatch(/^propose /);
    expect(notes[2]).toMatch(/^execute /);
    expect(notes[3]).toContain('POST /cosign/delegate');
  });

  test('have a behaviour with the members of the kit: both operations, the claim of the agent word for word, the co-sign rule, the one fault value, the models and the routes that the agent calls', () => {
    const behaviour = at(parsed(), 'behaviour');
    expect(at(behaviour, 'operations')).toStrictEqual(['propose', 'execute']);
    expect(at(behaviour, 'claim')).toStrictEqual({ statements: SOURCING_CLAIM.statements.map((statement) => ({ id: statement.id, text: statement.text })) });
    expect(SOURCING_CLAIM.statements.map((statement) => statement.text)).toStrictEqual([
      'Every score in a ranking cites the signed quote it was computed from.',
      'This agent ranks only bidders whose signed quote it holds and accepted.',
      'A ranking this agent writes to a sourcing record is the document whose digest its hirer approved.',
    ]);
    expect(at(behaviour, 'cosign')).toStrictEqual({ route: '/cosign/delegate', rule: COSIGN_RULE });
    expect(at(behaviour, 'fault_modes')).toStrictEqual(['invert_scores']);
    expect(at(behaviour, 'model')).toStrictEqual({ allowlist: ['deepseek/deepseek-v4-flash'], max_price_lovelace: 1_000_000 });
    expect(at(behaviour, 'relying_on')).toStrictEqual({
      mock_systems: ['GET /t/{tenant}/vendors', 'POST /t/{tenant}/sourcing/rankings'],
      gateway_routes: ['POST /token', 'GET /1.0/identifiers/{did}', 'GET /agents/{agent}/credential', 'GET /.well-known/ard.json', 'GET /.well-known/jwks.json', 'GET /status/bsl/{n}'],
    });
    expect(Object.keys(Object(behaviour))).toStrictEqual(['data_handling', 'third_parties', 'operations', 'claim', 'cosign', 'fault_modes', 'model', 'relying_on']);
    expect(at(parsed(manifestEnv({ LLM_MODEL_ALLOWLIST: 'a/b, c/d', LLM_MAX_PRICE_LOVELACE: '250000' })), 'behaviour', 'model')).toStrictEqual({ allowlist: ['a/b', 'c/d'], max_price_lovelace: 250_000 });
  });

  test('state the data handling and the third parties of the agent in plain text, with the third parties as a list', () => {
    const behaviour = at(parsed(), 'behaviour');
    expect(textOf(at(behaviour, 'data_handling'))).not.toMatch(/[\n\r]/);
    const parties = textsOf(at(behaviour, 'third_parties'));
    expect(parties.length).toBeGreaterThanOrEqual(5);
    for (const party of parties) expect(party).not.toMatch(/[\n\r]/);
  });

  test('state the twelve gaps of the page in their order, and then the one sentence of the kit about the fault switch', () => {
    const gaps = textsOf(at(parsed(), 'gaps'));
    expect(gaps).toStrictEqual([...PAGE_GAPS, faultGap('sourcing-agent')]);
    expect(gaps).toHaveLength(13);
    expect(gapsFor()).toStrictEqual(gaps);
    for (const gap of gaps) {
      expect(gap.endsWith('.')).toBe(true);
      expect(gap).not.toMatch(/[\n\r]/);
    }
    expect(gaps[0]).toContain('The model chooses whom to invite');
    expect(gaps[10]).toContain('independent of the controller by key only');
    expect(gaps[11].startsWith('What this does not show:')).toBe(true);
    expect(new Set(gaps).size).toBe(13);
  });
});

describe('the terms', () => {
  const advert = (manifest: unknown, extra: Partial<AdvertDatum> & { agent_id?: string } = {}): AdvertDatum => ({
    supplier_pkh: SUPPLIER.keyHash, capability_id: textOf(at(manifest, 'capability_id')), model: SOURCING_MODEL, max_output_tokens: 0, max_processing_ms: numberOf(at(manifest, 'terms', 'max_processing_ms')),
    price_lovelace: BigInt(numberOf(at(manifest, 'terms', 'price_lovelace'))), supplier_bond_lovelace: BigInt(numberOf(at(manifest, 'terms', 'supplier_bond_lovelace'))),
    buyer_bond_lovelace: BigInt(numberOf(at(manifest, 'terms', 'buyer_bond_lovelace'))),
    endpoint_url: 'https://sourcing.example', detail_uri: 'https://sourcing.example/agent.json', detail_hash: 'ab'.repeat(32), advertised_at: 0, status: 'Active', ...extra,
  } as AdvertDatum);
  const NOW = 1_790_000_000_000;
  const REF = `${'cc'.repeat(32)}#0`;
  const PROMPT = 'dd'.repeat(32);
  const buyer = keyOf(rawKey(KEY_NUMBERS.delegation1));

  test('are the price 3 and both bonds 1, in a window of 3,600,000 ms, and the input limits are the limits of the intake', () => {
    expect(SOURCING_MODEL).toBe('sourcing-agent-v1');
    expect(at(parsed(), 'terms')).toStrictEqual({
      price_lovelace: 3_000_000, supplier_bond_lovelace: 1_000_000, buyer_bond_lovelace: 1_000_000, max_processing_ms: 3_600_000,
      input_limits: { request_bytes: MAX_REQUEST_BYTES, rfq_items: MAX_RFQ_ITEMS, item_quantity: MAX_ITEM_QUANTITY, tenant_chars: 48 },
    });
    expect(MAX_REQUEST_BYTES).toBe(900_000);
  });

  test('give a lock of 5,000,000 lovelace, the price and both bonds, for a Post on the advert in the legacy layout and in the identity layout', () => {
    const manifest = parsed();
    const legacy = planFleetPostEscrow(advert(manifest), REF, buyer.pkh, PROMPT, NOW);
    expect(legacy.lockLovelace).toBe(5_000_000n);
    expect(legacy.layout).toBe('legacy');
    const identityAdvert = advert(manifest, { agent_id: AGENT_DID.slice('did:vector:'.length) });
    const identity = planFleetPostEscrow(identityAdvert, REF, buyer.pkh, PROMPT, NOW, fleetPostTerms(identityAdvert, buyer.address));
    expect(identity.layout).toBe('identity');
    expect(identity.lockLovelace).toBe(5_000_000n);
    // The window of the advert is the window of the escrow: the Post leaves the supplier all of it before deliver_by.
    expect(identity.deliverBy - NOW).toBeGreaterThanOrEqual(3_600_000);
  });

  test('follow a price that the operator sets: the lock is that price and both bonds', () => {
    const manifest = parsed(manifestEnv({ ADVERT_PRICE_LOVELACE: '6000000' }));
    expect(planFleetPostEscrow(advert(manifest), REF, buyer.pkh, PROMPT, NOW).lockLovelace).toBe(8_000_000n);
  });
});
