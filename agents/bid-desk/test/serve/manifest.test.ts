// agents/bid-desk/test/serve/manifest.test.ts
// The manifest of a Bid Desk: for each of the three instances the same bytes for the empty fault setting and for the fault value and on every render; the price list that it names, with the hash of the bytes of
// the file of its instance; the three manifests that differ; the terms and the lock of the advert; the claim, the gaps and the members, with no controller and no secret; the request schema; and the template,
// which is the render of the same builder with placeholders. No test here starts a service.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { DELIVER_BY_BUFFER_MS, fleetPostTerms, planFleetPostEscrow, rawHexToBech32 } from '@vsa/buyer-core';
import { BID_CAPABILITIES, BID_DESK_CLAIM, BID_DESK_MODEL, MAX_ITEM_QUANTITY, MAX_RFQ_ITEMS, parseRfqId, parseSku } from '@vsa/usecase-kit/bids';
import { faultGap, parseBehaviourAdditions, renderManifest } from '@vsa/usecase-kit/manifest';
import { MAX_REQUEST_BYTES, RFQ_SCHEMA, parseDelegationId, parseDid, parseRfq } from '@vsa/usecase-kit/protocol';
import { identityRegistryOf } from '@vsa/vector-read';
import type { AdvertDatum } from '@vsa/vector-read';
import { CONTROLLER_GAP, GAPS, NOT_SHOWN_GAP, PAGE_GAPS } from '../../src/serve/gaps.ts';
import { REQUEST_SCHEMA, SPEC_URL, TEMPLATE_ENV, TEMPLATE_PRICE_LIST, manifestFromEnv, renderTemplate } from '../../src/serve/manifest.ts';
import type { BidDeskManifest } from '../../src/serve/manifest.ts';
import { BOND_LOVELACE, INSTANCES, INSTANCE_NAMES, PRICE_LIST_ROUTE, PRICE_LOVELACE } from '../../src/serve/settings.ts';
import type { Instance } from '../../src/serve/settings.ts';
import { AGENT_DID, CONTACT, ORIGIN, POLICY, PRICE_LIST_SHA256, SERVICE, SERVICE_ADDRESS, SUPPLIER, TOKEN, envOf, message, priceListOf, priceListUrl, shows } from './support.ts';

type Over = Readonly<Record<string, string | undefined>>;

const sha256 = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');
const here = (file: string): URL => new URL(`../../${file}`, import.meta.url);
/** The settings of one instance, with the key hash of the service that the start puts in, so that the builder reads it as it reads the other public settings. */
const settings = (instance: Instance, over: Over = {}): NodeJS.ProcessEnv => envOf(instance, { BID_DESK_SERVICE_PKH: SERVICE.pkh, ...over });
const build = (instance: Instance, over: Over = {}): BidDeskManifest => manifestFromEnv(settings(instance, over), priceListOf(instance));
const served = (instance: Instance, over: Over = {}) => {
  const rendered = renderManifest('bid-desk', (setting) => manifestFromEnv({ ...settings(instance, over), FAULT_MODE: setting }, priceListOf(instance)));
  if (!rendered.ok) throw new Error(`${rendered.code}: ${rendered.detail}`);
  return rendered.value;
};
const manifestOf = (instance: Instance, over: Over = {}): BidDeskManifest => JSON.parse(served(instance, over).text);

/** Every leaf of a value, by its path, as JSON text. */
function leaves(value: unknown, path = ''): Map<string, string> {
  const found = new Map<string, string>();
  if (typeof value === 'object' && value !== null) {
    for (const [key, member] of Object.entries(value)) for (const [at, text] of leaves(member, path === '' ? key : `${path}.${key}`)) found.set(at, text);
  } else {
    found.set(path, JSON.stringify(value));
  }
  return found;
}
/** The paths at which two values differ. */
function differing(one: unknown, other: unknown): string[] {
  const [left, right] = [leaves(one), leaves(other)];
  return [...new Set([...left.keys(), ...right.keys()])].filter((path) => left.get(path) !== right.get(path)).sort();
}
/** Every member name of a value, at any depth. A list has no member names. */
function memberNames(value: unknown): string[] {
  if (typeof value !== 'object' || value === null) return [];
  return Object.entries(value).flatMap(([key, member]) => (Array.isArray(value) ? [] : [key]).concat(memberNames(member)));
}

describe.each(INSTANCES)('the bytes of the manifest of %s', (instance) => {
  test('are the same for the empty fault setting and for the fault value: the kit renders both and gives one text and one hash', () => {
    const rendered = renderManifest('bid-desk', (setting) => manifestFromEnv({ ...settings(instance), FAULT_MODE: setting }, priceListOf(instance)));
    expect(rendered.ok).toBe(true);
    const settingsSeen: string[] = [];
    renderManifest('bid-desk', (setting) => { settingsSeen.push(setting); return manifestFromEnv({ ...settings(instance), FAULT_MODE: setting }, priceListOf(instance)); });
    expect(settingsSeen).toStrictEqual(['', '', 'quote_off_price_list']);
    const base = settings(instance);
    const list = priceListOf(instance);
    expect(JSON.stringify(manifestFromEnv({ ...base, FAULT_MODE: 'quote_off_price_list' }, list))).toBe(JSON.stringify(manifestFromEnv({ ...base, FAULT_MODE: '' }, list)));
    expect(JSON.stringify(manifestFromEnv(base, list))).toBe(JSON.stringify(manifestFromEnv({ ...base, FAULT_MODE: 'quote_off_price_list' }, list)));
  });

  test('are the same on every render, and the hash is the SHA-256 of the text that the service serves', () => {
    const first = served(instance);
    for (const next of [served(instance), served(instance), served(instance)]) expect(next).toStrictEqual(first);
    expect(first.sha256).toBe(sha256(first.text));
    expect(first.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  test('the builder never reads the fault setting: a builder that does is refused by the kit, with the place where the value stands', () => {
    const base = settings(instance);
    const list = priceListOf(instance);
    const leaking = renderManifest('bid-desk', (setting) => ({ ...manifestFromEnv(base, list), description: `fault ${setting}` }));
    expect(leaking.ok).toBe(false);
    if (!leaking.ok) expect(leaking.code).toBe('manifest_changes_with_fault');
    const named = renderManifest('bid-desk', () => ({ ...manifestFromEnv(base, list), description: 'the fault is quote_off_price_list' }));
    expect(named.ok).toBe(false);
    if (!named.ok) expect(named.code).toBe('manifest_names_fault');
  });

  test('name the fault value in its two places only: the list of possible values and the one gap sentence, and no member says which value is active', () => {
    const { text } = served(instance);
    expect(text.split('quote_off_price_list')).toHaveLength(3);
    expect(text).not.toMatch(/"fault_mode"\s*:/);
    const manifest = manifestOf(instance);
    expect(manifest.behaviour.fault_modes).toStrictEqual(['quote_off_price_list']);
    expect(manifest.gaps.filter((gap) => gap.includes('quote_off_price_list'))).toStrictEqual([faultGap('bid-desk')]);
  });

  test('name the price list at the origin of the instance, with the SHA-256 of the bytes of the file of that instance', () => {
    const manifest = manifestOf(instance);
    expect(manifest.behaviour.price_list).toStrictEqual({ uri: `https://bids-${instance}.example.test/price-list.json`, sha256: sha256(readFileSync(priceListUrl(instance))) });
    expect(manifest.behaviour.price_list.sha256).toBe(PRICE_LIST_SHA256[instance]);
    expect(PRICE_LIST_ROUTE).toBe('/price-list.json');
    expect(manifest.interface.routes.price_list).toBe(PRICE_LIST_ROUTE);
  });
});

describe('the three manifests', () => {
  test('differ: three texts and three hashes, and each holds the price list hash of its own file and not the hash of another', () => {
    const all = INSTANCES.map((instance) => served(instance));
    expect(new Set(all.map((one) => one.text)).size).toBe(3);
    expect(new Set(all.map((one) => one.sha256)).size).toBe(3);
    for (const [index, instance] of INSTANCES.entries()) {
      const manifest = JSON.parse(all[index].text) as BidDeskManifest;
      expect(manifest.behaviour.price_list.sha256, instance).toBe(PRICE_LIST_SHA256[instance]);
      for (const other of INSTANCES.filter((name) => name !== instance)) expect(manifest.behaviour.price_list.sha256, `${instance} is not ${other}`).not.toBe(PRICE_LIST_SHA256[other]);
    }
  });

  test('carry the name of their instance, and with the same settings in all three they differ in the name and the price list hash alone', () => {
    expect(INSTANCES.map((instance) => manifestOf(instance).name)).toStrictEqual(['Bid Desk Alfa', 'Bid Desk Bravo', 'Bid Desk Charlie']);
    for (const instance of INSTANCES) expect(manifestOf(instance).name).toBe(INSTANCE_NAMES[instance]);
    const same = { BID_DESK_PUBLIC_ORIGIN: ORIGIN };
    const [alfa, bravo, charlie] = INSTANCES.map((instance) => build(instance, same));
    for (const [one, other] of [[alfa, bravo], [alfa, charlie], [bravo, charlie]]) expect(differing(one, other)).toStrictEqual(['behaviour.price_list.sha256', 'name']);
  });

  test('differ in the address of the price list too when each instance has its own origin, and not in the organisation, which the manifest does not publish', () => {
    const [alfa, bravo] = INSTANCES.map((instance) => build(instance));
    expect(differing(alfa, bravo)).toStrictEqual(['behaviour.price_list.sha256', 'behaviour.price_list.uri', 'name']);
    expect([...leaves(alfa).values()]).not.toContain(JSON.stringify('alfa.example.test'));
  });
});

describe('the terms', () => {
  test('are the price and both bonds of 1 million lovelace, the window of the operator, and the limit of the request', () => {
    expect(manifestOf('alfa').terms).toStrictEqual({
      price_lovelace: 1_000_000, supplier_bond_lovelace: 1_000_000, buyer_bond_lovelace: 1_000_000, max_processing_ms: 480_000, input_limits: { request_bytes: 900_000 },
    });
    expect([PRICE_LOVELACE, BOND_LOVELACE, MAX_REQUEST_BYTES]).toStrictEqual([1_000_000, 1_000_000, 900_000]);
    expect(manifestOf('alfa', { ADVERT_MAX_PROCESSING_MS: '600000' }).terms.max_processing_ms).toBe(600_000);
  });

  test.each(INSTANCES)('the lock of the advert of %s is the price plus both bonds, 3 million lovelace, for a Post that plans the advert', (instance) => {
    const manifest = manifestOf(instance);
    const { terms } = manifest;
    const endpoint = `https://bids-${instance}.example.test`;
    const advert: AdvertDatum & { agent_id: string } = {
      supplier_pkh: manifest.keys.supplier_pkh, capability_id: manifest.capability_id, model: BID_DESK_MODEL, max_output_tokens: 0, max_processing_ms: terms.max_processing_ms,
      price_lovelace: BigInt(terms.price_lovelace), supplier_bond_lovelace: BigInt(terms.supplier_bond_lovelace), buyer_bond_lovelace: BigInt(terms.buyer_bond_lovelace),
      endpoint_url: endpoint, detail_uri: `${endpoint}/agent.json`, detail_hash: served(instance).sha256, advertised_at: 1_790_000_000_000, status: 'Active', agent_id: AGENT_DID.slice('did:vector:'.length),
    };
    const identity = fleetPostTerms(advert, SERVICE_ADDRESS);
    const plan = planFleetPostEscrow(advert, `${'cd'.repeat(32)}#1`, 'ab'.repeat(28), 'ef'.repeat(32), 1_790_000_000_000, identity);
    expect(plan.lockLovelace).toBe(3_000_000n);
    expect(plan.lockLovelace).toBe(BigInt(terms.price_lovelace + terms.supplier_bond_lovelace + terms.buyer_bond_lovelace));
    expect(plan.deliverBy).toBe(1_790_000_000_000 + terms.max_processing_ms + DELIVER_BY_BUFFER_MS);
    expect(BID_DESK_MODEL).toBe('bid-desk-v1');
  });
});

describe('the members of the manifest', () => {
  test('are those of the Bid Desk: the name, the capability, the description, the claim, the model, the routes it relies on, the status, the operator and the links', () => {
    const manifest = manifestOf('bravo');
    expect([manifest.schema, manifest.name, manifest.capability_id, manifest.version]).toStrictEqual(['vector.agent-manifest.v2', 'Bid Desk Bravo', BID_CAPABILITIES.quote, '0.1.0']);
    expect(manifest.capability_id).toBe('supplychain.rfq.quote.v1');
    expect(manifest.description).toBe(
      "For a supplier: takes a request for quotation from a buyer's agent, checks who sent it, prices it from the supplier's published price list and returns a quote. The signed receipt of the job is the signed quote.",
    );
    expect(manifest.operator).toStrictEqual({ name: 'Apex Fusion Foundation', contact: CONTACT });
    expect(manifest.behaviour.claim.statements.map((statement) => statement.id)).toStrictEqual(['S1', 'S2', 'S3']);
    expect(manifest.behaviour.claim.statements.map((statement) => statement.text)).toStrictEqual(BID_DESK_CLAIM.statements.map((statement) => statement.text));
    expect(manifest.behaviour.model).toStrictEqual({ allowlist: ['deepseek/deepseek-v4-flash'], max_price_lovelace: 1_000_000 });
    expect(manifest.behaviour.relying_on).toStrictEqual({ mock_systems: [], gateway_routes: ['GET /1.0/identifiers/{did}', 'GET /agents/{id}/credential'] });
    expect(manifest.status).toStrictEqual({ chip: 'proposed', since: '2026-11-24' });
    expect(manifest.links.explorer_advert).toBe('');
    expect(manifest.links.spec).toBe(SPEC_URL);
    expect(manifest.links.spec).toMatch(/^https:\/\/github\.com\/.*\/specs\/bid-desk\.md$/);
    expect(manifest.links.source).toMatch(/^https:\/\/github\.com\/.*\/agents\/bid-desk$/);
    // The additions are those of a bid desk: the kit parses them as such, and a bid desk has no operations, no co-sign rule and no lots file.
    const { claim, fault_modes, model, relying_on, price_list } = manifest.behaviour;
    expect(parseBehaviourAdditions('bid-desk', { claim, fault_modes, model, relying_on, price_list }).ok).toBe(true);
    for (const name of ['operations', 'cosign', 'lots']) expect(Object.keys(manifest.behaviour), name).not.toContain(name);
  });

  test('the identity block names the DID, the identity registry and the supplier key as <DID>#<key hash>, and `keys` holds the supplier key hash, its public key and the key hash of the service key', () => {
    const manifest = manifestOf('alfa');
    expect(manifest.identity).toStrictEqual({ did: AGENT_DID, registry_address: identityRegistryOf(POLICY, undefined)?.address, supplier_key: `${AGENT_DID}#${SUPPLIER.pkh}` });
    expect(manifest.identity.registry_address).toMatch(/^addr1/);
    expect(manifest.keys).toStrictEqual({ supplier_pkh: SUPPLIER.pkh, pub_key_hex: SUPPLIER.pubKeyHex, service_pkh: SERVICE.pkh });
    expect(build('alfa', { IDENTITY_POLICY_ID: undefined }).identity.registry_address).toBe('');
  });

  test('the interface names the routes, the request schema and the response schema, and says in five notes how the request is taken', () => {
    const { interface: api } = manifestOf('alfa');
    expect(api.routes).toStrictEqual({ job: '/v1/job', status: '/status', capability: '/capability', price_list: '/price-list.json' });
    expect(api.request_schema).toStrictEqual(JSON.parse(JSON.stringify(REQUEST_SCHEMA)));
    expect(api.response_schema).toStrictEqual({ $ref: `${SPEC_URL}#response` });
    expect(api.notes).toHaveLength(5);
    expect(api.notes[0]).toContain(`its schema is ${RFQ_SCHEMA}`);
    expect(api.notes[0]).toContain(`1 to ${MAX_RFQ_ITEMS} items`);
    expect(api.notes.join(' ')).toContain('The service takes no approval.');
  });

  test('take the version, the status and the link of the advert from the operator, and the models and the ceiling of the allowlist', () => {
    const manifest = manifestOf('charlie', {
      AGENT_VERSION: '0.2.1', AGENT_STATUS_CHIP: 'Deployed', AGENT_STATUS_SINCE: '2026-12-01', ADVERT_EXPLORER_URL: 'https://explorer.example.test/advert/1',
      LLM_MODEL_ALLOWLIST: 'a/one, b/two', LLM_MAX_PRICE_LOVELACE: '250000',
    });
    expect([manifest.version, manifest.status, manifest.links.explorer_advert]).toStrictEqual(['0.2.1', { chip: 'deployed', since: '2026-12-01' }, 'https://explorer.example.test/advert/1']);
    expect(manifest.behaviour.model).toStrictEqual({ allowlist: ['a/one', 'b/two'], max_price_lovelace: 250_000 });
    expect(manifestOf('charlie', { AGENT_VERSION: ' ', AGENT_STATUS_CHIP: '', AGENT_STATUS_SINCE: ' ' }).version).toBe('0.1.0');
    expect(() => build('alfa', { AGENT_STATUS_CHIP: 'bogus' })).toThrow(/^environment variable AGENT_STATUS_CHIP must be one of /);
    expect(() => build('alfa', { AGENT_STATUS_SINCE: 'yesterday' })).toThrow(/^environment variable AGENT_STATUS_SINCE must be a date as YYYY-MM-DD/);
  });
});

/** One refusal of the builder: the setting, the value that is refused (undefined: not set), the start of the message, and a value of the same setting that is accepted (the twin). */
type Row = readonly [setting: string, bad: string | undefined, refusal: string, good: string | undefined];
const REFUSALS: readonly Row[] = [
  ['OPERATOR_CONTACT', undefined, 'environment variable OPERATOR_CONTACT is required (', 'ops@example.test'],
  ['OPERATOR_CONTACT', '  ', 'environment variable OPERATOR_CONTACT is required (', 'ops@example.test'],
  ['BID_DESK_INSTANCE', undefined, 'environment variable BID_DESK_INSTANCE is required (', 'bravo'],
  ['BID_DESK_INSTANCE', 'delta', 'environment variable BID_DESK_INSTANCE must be alfa, bravo or charlie, and it has 5 characters', 'charlie'],
  ['BID_DESK_PUBLIC_ORIGIN', undefined, 'environment variable BID_DESK_PUBLIC_ORIGIN is required (', ORIGIN],
  ['BID_DESK_PUBLIC_ORIGIN', 'http://bids-alfa.example.test', 'environment variable BID_DESK_PUBLIC_ORIGIN must be an https origin with no user, path, query or fragment', ORIGIN],
  ['BID_DESK_PUBLIC_ORIGIN', 'https://bids-alfa.example.test/x', 'environment variable BID_DESK_PUBLIC_ORIGIN must be an https origin with no user, path, query or fragment', ORIGIN],
  ['ADVERT_MAX_PROCESSING_MS', '479999', 'environment variable ADVERT_MAX_PROCESSING_MS must be at least 480000', '480000'],
  ['LLM_MODEL_ALLOWLIST', undefined, 'environment variable LLM_MODEL_ALLOWLIST is required (', 'a/one'],
  ['LLM_MODEL_ALLOWLIST', 'a b', 'environment variable LLM_MODEL_ALLOWLIST entry 1 must be a model name', 'a/b'],
  ['LLM_MAX_PRICE_LOVELACE', undefined, 'environment variable LLM_MAX_PRICE_LOVELACE is required (', '250000'],
  ['LLM_MAX_PRICE_LOVELACE', '1.5', 'environment variable LLM_MAX_PRICE_LOVELACE must be a whole number of lovelace', '250000'],
  ['AGENT_DID', undefined, 'environment variable AGENT_DID is required (', AGENT_DID],
  ['AGENT_DID', 'did:vector:xyz', 'environment variable AGENT_DID must be did:vector:', AGENT_DID],
  ['SUPPLIER_PKH', undefined, 'environment variable SUPPLIER_PKH is required (', SUPPLIER.pkh],
  ['SUPPLIER_PKH', 'ab', 'environment variable SUPPLIER_PKH must be 56 hex characters', SUPPLIER.pkh],
  ['SUPPLIER_PUB_KEY_HEX', SUPPLIER.privateKeyHex, 'environment variable SUPPLIER_PUB_KEY_HEX is not the public key of SUPPLIER_PKH', SUPPLIER.pubKeyHex],
  ['BID_DESK_SERVICE_PKH', undefined, 'environment variable BID_DESK_SERVICE_PKH is required (', SERVICE.pkh],
  ['BID_DESK_SERVICE_PKH', 'ab', 'environment variable BID_DESK_SERVICE_PKH must be 56 hex characters', SERVICE.pkh],
  ['IDENTITY_POLICY_ID', 'zz', 'environment variable IDENTITY_POLICY_ID must be 56 lowercase hex characters', POLICY],
  ['IDENTITY_ADDRESS', 'addr1abc', 'environment variable IDENTITY_ADDRESS addr1abc is not the address of IDENTITY_POLICY_ID', undefined],
];

describe('every refusal of the builder, with its accepted twin', () => {
  test.each(REFUSALS)('%s = %j is refused, and the same setting with %j is accepted', (setting, bad, refusal, good) => {
    const text = message(() => build('alfa', { [setting]: bad }));
    expect(text.startsWith(refusal), text).toBe(true);
    expect(() => build('alfa', { [setting]: good }), `${setting} = ${String(good)}`).not.toThrow();
  });

  test('a key or a long value in the line of a published value is never shown by the message, and a key in the line of the DID, the supplier key or the key hash of the service never reaches the manifest', () => {
    const key = SERVICE.privateKeyHex;
    const upper = `did:vector:${key.toUpperCase()}`;
    for (const [setting, value] of [
      ['AGENT_DID', key], ['AGENT_DID', upper], ['SUPPLIER_PKH', key], ['SUPPLIER_PUB_KEY_HEX', key], ['BID_DESK_SERVICE_PKH', key], ['IDENTITY_POLICY_ID', key], ['IDENTITY_POLICY_ID', upper], ['IDENTITY_ADDRESS', key],
    ] as const) {
      const text = message(() => build('alfa', { [setting]: value }));
      expect(text.startsWith(`environment variable ${setting}`), text).toBe(true);
      expect(shows(text, key), `${setting} = ${value.slice(0, 14)}`).toBe(false);
    }
  });

  test('a price list hash that is not a hash is refused, and so is the placeholder of the template in a served manifest: no manifest names a list that it cannot name', () => {
    for (const bad of ['', 'abc', 'A'.repeat(64), '<PRICE_LIST_SHA256>', 'g'.repeat(64)]) {
      expect(() => manifestFromEnv(settings('alfa'), { sha256: bad }), bad).toThrow(/^the behaviour of the manifest is refused: /);
    }
    expect(() => manifestFromEnv(settings('alfa'), { sha256: PRICE_LIST_SHA256.alfa })).not.toThrow();
  });
});

describe('no controller', () => {
  const MEMBERS = ['schema', 'name', 'capability_id', 'version', 'description', 'operator', 'identity', 'keys', 'interface', 'terms', 'behaviour', 'status', 'gaps', 'links'];

  test('the manifest has the members of a Bid Desk and no member that names a controller, at any depth', () => {
    for (const instance of INSTANCES) {
      const manifest = manifestOf(instance);
      expect(Object.keys(manifest), instance).toStrictEqual(MEMBERS);
      expect(Object.keys(manifest.identity), instance).toStrictEqual(['did', 'registry_address', 'supplier_key']);
      expect(Object.keys(manifest.keys), instance).toStrictEqual(['supplier_pkh', 'pub_key_hex', 'service_pkh']);
      expect(memberNames(manifest).filter((name) => /control/i.test(name)), instance).toStrictEqual([]);
    }
    // The walk finds a member at any depth, so that the search above can fail.
    expect(memberNames({ a: { b: [{ controller: 1 }] } })).toStrictEqual(['a', 'b', 'controller']);
  });

  test('the builder reads no setting about a controller: settings that name one, and others that it does not read, change no byte of the manifest and appear in none', () => {
    const extra = { CONTROLLER_PKH: 'ab'.repeat(28), BID_DESK_CONTROLLER_PKH: 'cd'.repeat(28), CONTROLLER_KEY_HASH: 'ef'.repeat(28), UNRELATED_SETTING: 'a-value-that-no-reader-takes' };
    for (const instance of INSTANCES) {
      const text = served(instance, extra).text;
      expect(text, instance).toBe(served(instance).text);
      for (const value of Object.values(extra)) expect(text, value).not.toContain(value);
    }
  });

  test('the gap about the keys of the parties says it in words, and it is a text of the gaps and not a member', () => {
    expect(CONTROLLER_GAP).toBe('The controller key of this deployment, the Accountable key and the guardian keys are on one host of one operator, so a party is independent of the controller by key only.');
    expect(manifestOf('bravo').gaps).toContain(CONTROLLER_GAP);
  });
});

describe('no secret', () => {
  test('the manifest holds no key and no token that the environment holds: not a key in hex or in bech32, and not the token of the runtime', () => {
    for (const instance of INSTANCES) {
      const { text } = served(instance, { SERVICE_AUTH_HEADER: TOKEN });
      expect(Object.keys(settings(instance))).toContain('BID_DESK_SERVICE_PRIV_KEY_HEX');
      for (const key of [SERVICE, SUPPLIER]) {
        expect(text.toLowerCase(), instance).not.toContain(key.privateKeyHex);
        expect(text.toLowerCase(), instance).not.toContain(rawHexToBech32(key.privateKeyHex));
      }
      expect(text, instance).not.toContain(TOKEN.slice('Bearer '.length));
    }
  });
});

describe('the gaps', () => {
  test('are the five of the page in its order, the sentence about the keys of the parties, the sentence about what no run shows, and then the one sentence of the kit about the fault switch', () => {
    expect(PAGE_GAPS).toStrictEqual([
      'A quote is the result of a paid job. It is not a binding offer.',
      "The model prices the request. Nothing in this agent checks its lines against the price list: the buyer's agent can, because the price list and its hash are public.",
      'The three Bid Desks are one code base under three records, run by one foundation. They do not compete.',
      'The compliance attestation is issued by a demonstration registry with no record of its own.',
      'The numbers of the price list are synthetic.',
    ]);
    expect(GAPS).toStrictEqual([...PAGE_GAPS, CONTROLLER_GAP, NOT_SHOWN_GAP, faultGap('bid-desk')]);
    expect(GAPS).toHaveLength(8);
    for (const instance of INSTANCES) expect(manifestOf(instance).gaps, instance).toStrictEqual([...GAPS]);
  });

  test('say what no run shows: the refund of the escrow of a revoked agent, the reclaim of an escrow in use case 3, and a relying party that refuses a live token after its authority ends', () => {
    expect(NOT_SHOWN_GAP).toBe(
      'What this does not show: no run covers the refund of the escrow of a revoked agent, the reclaim of an escrow in use case 3, or a relying party that refuses a live token after its authority ends. Tests cover that last case only.',
    );
  });
});

describe('the request schema', () => {
  const { properties } = REQUEST_SCHEMA;
  const request = properties.rfq.properties;

  test('lists the four members of the message of the kit and the three members of the request, with the limits of the kit', () => {
    expect(REQUEST_SCHEMA.required).toStrictEqual(['schema', 'sender_did', 'delegation', 'rfq']);
    expect(Object.keys(properties)).toStrictEqual(['schema', 'sender_did', 'delegation', 'rfq']);
    expect(properties.schema).toStrictEqual({ const: RFQ_SCHEMA });
    expect(properties.rfq.required).toStrictEqual(['rfq_id', 'items', 'needed_by']);
    expect(Object.keys(request)).toStrictEqual(['rfq_id', 'items', 'needed_by']);
    expect([request.items.minItems, request.items.maxItems]).toStrictEqual([1, MAX_RFQ_ITEMS]);
    expect(request.items.items.required).toStrictEqual(['sku', 'quantity']);
    expect([request.items.items.properties.quantity.minimum, request.items.items.properties.quantity.maximum]).toStrictEqual([1, MAX_ITEM_QUANTITY]);
    for (const schema of [REQUEST_SCHEMA, properties.rfq, request.items.items]) expect(schema.additionalProperties).toBe(false);
  });

  test('holds a pattern for each text that takes what the parser of the kit takes: the request identifier, the SKU, the DID and the delegation', () => {
    const rules: readonly [pattern: string, parse: (value: unknown) => { ok: boolean }, accepted: readonly string[], refused: readonly string[]][] = [
      [request.rfq_id.pattern, (value) => parseRfqId(value, 'rfq_id'), ['RFQ-2026-0042', 'a', '9', 'a.b_c-d', 'x'.repeat(64)], ['', '_x', '-x', '.x', 'a b', 'x'.repeat(65), '\u212aRFQ', 'abc\n']],
      [request.items.items.properties.sku.pattern, (value) => parseSku(value, 'sku'), ['GLV-NIT-M', 'SYR-10ML', 'MSK-N95', '0', 'x'.repeat(64)], ['', '_x', 'GLV NIT', 'x'.repeat(65), '\u212aSKU']],
      [properties.sender_did.pattern, (value) => parseDid(value, 'sender_did'), [AGENT_DID], ['', 'did:vector:xyz', `did:vector:${'AB'.repeat(32)}`, `${AGENT_DID}0`, AGENT_DID.slice(1)]],
      [properties.delegation.pattern, (value) => parseDelegationId(value, 'delegation'), ['ab'.repeat(32)], ['', 'ab'.repeat(31), 'AB'.repeat(32), `${'ab'.repeat(32)}0`]],
    ];
    for (const [pattern, parse, accepted, refused] of rules) {
      const form = new RegExp(pattern);
      for (const text of accepted) expect([form.test(text), parse(text).ok], `${pattern} ${text}`).toStrictEqual([true, true]);
      for (const text of refused) expect([form.test(text), parse(text).ok], `${pattern} ${JSON.stringify(text)}`).toStrictEqual([false, false]);
    }
  });

  test('a message with the members of the schema is a message that the parser of the kit takes', () => {
    const golden = { schema: RFQ_SCHEMA, sender_did: AGENT_DID, delegation: 'cd'.repeat(32), rfq: { rfq_id: 'RFQ-2026-0042', items: [{ sku: 'GLV-NIT-M', quantity: 100 }], needed_by: '2026-12-15' } };
    expect(parseRfq(golden).ok).toBe(true);
    expect(Object.keys(golden)).toStrictEqual(REQUEST_SCHEMA.required);
    expect(Object.keys(golden.rfq)).toStrictEqual(properties.rfq.required);
    expect(parseRfq({ ...golden, extra: 1 }).ok).toBe(false);
    expect(new RegExp(request.needed_by.pattern).test(golden.rfq.needed_by)).toBe(true);
  });
});

describe('the template', () => {
  test('is the render of the builder with placeholders, and agent.json.template equals it', () => {
    const template = renderTemplate();
    expect(readFileSync(here('agent.json.template'), 'utf8')).toBe(template);
    expect(template.endsWith('}\n')).toBe(true);
    expect(renderTemplate()).toBe(template);
  });

  test('names a placeholder for each value that the operator gives, and for the three values that each instance gives: its name, the address of its price list and its hash', () => {
    const template = renderTemplate();
    const found = [...new Set(template.match(/<[A-Z][A-Z0-9_]*>/g) ?? [])].sort();
    expect(found).toStrictEqual([
      '<AGENT_DID>', '<BID_DESK_NAME>', '<BID_DESK_SERVICE_PKH>', '<OPERATOR_CONTACT>', '<PRICE_LIST_SHA256>', '<PRICE_LIST_URI>', '<SUPPLIER_PKH>', '<SUPPLIER_PUB_KEY_HEX>',
    ]);
    // The instance and the origin are not in the template: the name, the address of the price list and its hash, which the instance gives, are.
    for (const [name, value] of Object.entries(TEMPLATE_ENV)) if (value.startsWith('<') && name !== 'BID_DESK_INSTANCE' && name !== 'BID_DESK_PUBLIC_ORIGIN') expect(found, name).toContain(value);
    expect(TEMPLATE_PRICE_LIST).toStrictEqual({ sha256: '<PRICE_LIST_SHA256>' });
    const manifest = JSON.parse(template) as BidDeskManifest;
    expect(manifest.name).toBe('<BID_DESK_NAME>');
    expect(manifest.identity.supplier_key).toBe('<AGENT_DID>#<SUPPLIER_PKH>');
    expect(manifest.keys).toStrictEqual({ supplier_pkh: '<SUPPLIER_PKH>', pub_key_hex: '<SUPPLIER_PUB_KEY_HEX>', service_pkh: '<BID_DESK_SERVICE_PKH>' });
    expect(manifest.behaviour.price_list).toStrictEqual({ uri: '<PRICE_LIST_URI>', sha256: '<PRICE_LIST_SHA256>' });
  });

  test('holds the real terms, the claim and the gaps of the manifest, and is never the manifest that a service serves', () => {
    const template = JSON.parse(renderTemplate()) as BidDeskManifest;
    expect(template.terms).toStrictEqual(manifestOf('alfa').terms);
    expect(template.behaviour.claim.statements.map((statement) => statement.text)).toStrictEqual(BID_DESK_CLAIM.statements.map((statement) => statement.text));
    expect(template.behaviour.fault_modes).toStrictEqual(['quote_off_price_list']);
    expect(template.gaps).toStrictEqual([...GAPS]);
    expect(renderTemplate()).not.toBe(served('alfa').text);
    for (const instance of INSTANCES) expect(served(instance).text).not.toMatch(/<[A-Z][A-Z0-9_]*>/);
  });

  test('the kit refuses a served manifest that has a placeholder, and renders the same builder as a template', () => {
    const refused = renderManifest('bid-desk', () => manifestFromEnv(TEMPLATE_ENV, TEMPLATE_PRICE_LIST));
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.code).toBe('manifest_has_placeholder');
    expect(renderManifest('bid-desk', () => manifestFromEnv(TEMPLATE_ENV, TEMPLATE_PRICE_LIST), { template: true }).ok).toBe(true);
    // A served manifest with a real origin and the placeholder instance, or a placeholder in any other value, is refused as well.
    const named = renderManifest('bid-desk', () => manifestFromEnv({ ...settings('alfa'), BID_DESK_INSTANCE: '<BID_DESK_INSTANCE>' }, priceListOf('alfa')));
    expect(named.ok).toBe(false);
    if (!named.ok) expect(named.code).toBe('manifest_has_placeholder');
  });
});
