// agents/order-desk/test/serve/manifest.test.ts
// The manifest of the Order Desk: one file for the three adverts, with the same bytes for the empty fault setting and for the fault value and on every render; the three tiers; the lots file that it names, with
// the hash of its bytes; the gaps in the order of the page; the lock of each advert; and the template, which is the render of the same builder with placeholders. No test here starts a service.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { fleetPostTerms, planFleetPostEscrow } from '@vsa/buyer-core';
import { DELIVER_BY_BUFFER_MS } from '@vsa/buyer-core';
import { INVENTORY_CAPABILITIES, LOT_NAMES, ORDER_DESK_CLAIM, lotsFileSha256 } from '@vsa/usecase-kit/inventory';
import { faultGap, parseBehaviourAdditions, renderManifest } from '@vsa/usecase-kit/manifest';
import { identityRegistryOf } from '@vsa/vector-read';
import type { AdvertDatum } from '@vsa/vector-read';
import { loadLots } from '../../src/checks/index.ts';
import { CONTROLLER_GAP, GAPS, NOT_SHOWN_GAP, PAGE_GAPS } from '../../src/serve/gaps.ts';
import { BOND_LOVELACE, LOT_PRICE_LOVELACE, TEMPLATE_ENV, manifestFromEnv, renderTemplate } from '../../src/serve/manifest.ts';
import { LOTS_FILE, LOTS_ROUTE } from '../../src/serve/settings.ts';
import { loadConfig } from '../../src/serve/start.ts';
import type { OrderDeskManifest } from '../../src/serve/manifest.ts';
import { AGENT_DID, FULL_ENV, LARGE, MEDIUM, ORIGIN, POLICY, SERVICE, SERVICE_ADDRESS, SMALL, envWith } from './support.ts';

const sha256 = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');
const here = (file: string): URL => new URL(`../../${file}`, import.meta.url);
// The ledger unit is named once in the repository, in the guide. Spelled in two parts, so that a search for the name finds only the guide.
const UNIT_NAME = new RegExp('AP' + '3X', 'i');
const served = (over: Readonly<Record<string, string | undefined>> = {}) => loadConfig(envWith(over)).manifest;
const manifestOf = (over: Readonly<Record<string, string | undefined>> = {}): OrderDeskManifest => JSON.parse(served(over).text);

describe('the bytes of the manifest', () => {
  test('are the same for the empty fault setting and for the fault value: the text and its hash', () => {
    const clean = served({ FAULT_MODE: '' });
    const fault = served({ FAULT_MODE: 'confirm_wrong_lot' });
    expect(fault.text).toBe(clean.text);
    expect(fault.sha256).toBe(clean.sha256);
    expect(served({ FAULT_MODE: undefined })).toStrictEqual(clean);
  });

  test('are the same on every render, and the hash is the SHA-256 of the text that the service serves', () => {
    const first = loadConfig(FULL_ENV).manifest;
    const again = [loadConfig(FULL_ENV).manifest, loadConfig(FULL_ENV).manifest, loadConfig(FULL_ENV).manifest];
    for (const next of again) expect(next).toStrictEqual(first);
    expect(first.sha256).toBe(sha256(first.text));
    expect(first.sha256).toMatch(/^[0-9a-f]{64}$/);
    // The kit renders the builder for the empty setting twice and for the one fault value, and gives the same bytes only when all three agree.
    const lots = loadLots(LOTS_FILE);
    const rendered = renderManifest('order-desk', () => manifestFromEnv({ ...FULL_ENV, ORDER_DESK_SERVICE_PKH: SERVICE.pkh }, lots));
    expect(rendered.ok).toBe(true);
  });

  test('the builder never reads the fault setting: a builder that does is refused by the kit, with the place where the value stands', () => {
    const lots = loadLots(LOTS_FILE);
    const env = { ...FULL_ENV, ORDER_DESK_SERVICE_PKH: SERVICE.pkh };
    expect(manifestFromEnv({ ...env, FAULT_MODE: 'confirm_wrong_lot' }, lots)).toStrictEqual(manifestFromEnv({ ...env, FAULT_MODE: '' }, lots));
    const leaking = renderManifest('order-desk', (setting) => ({ ...manifestFromEnv(env, lots), description: `fault ${setting}` }));
    expect(leaking.ok).toBe(false);
    if (!leaking.ok) expect(leaking.code).toBe('manifest_changes_with_fault');
    const named = renderManifest('order-desk', () => ({ ...manifestFromEnv(env, lots), description: 'the fault is confirm_wrong_lot' }));
    expect(named.ok).toBe(false);
    if (!named.ok) expect(named.code).toBe('manifest_names_fault');
  });

  test('name the fault value in its two places only: the list of possible values and the one gap sentence, and no member says which value is active', () => {
    const { text } = served({ FAULT_MODE: 'confirm_wrong_lot' });
    expect(text.split('confirm_wrong_lot')).toHaveLength(3);
    expect(text).not.toMatch(/"fault_mode"\s*:/);
    const manifest = manifestOf({ FAULT_MODE: 'confirm_wrong_lot' });
    expect(manifest.behaviour.fault_modes).toStrictEqual(['confirm_wrong_lot']);
    expect(manifest.gaps.filter((gap) => gap.includes('confirm_wrong_lot'))).toStrictEqual([faultGap('order-desk')]);
  });
});

describe('the three tiers', () => {
  test('one for each lot: the lot name as the model, the price, both bonds, the window, the key hash and the public key of that runtime, and its endpoint', () => {
    const { terms } = manifestOf();
    expect(terms.tiers).toStrictEqual([
      {
        model: 'lot-small', price_lovelace: 2_000_000, supplier_bond_lovelace: 1_000_000, buyer_bond_lovelace: 1_000_000, max_processing_ms: 480_000, supplier_pkh: SMALL.pkh, pub_key_hex: SMALL.pubKeyHex,
        endpoint: 'https://orders-small.example.test',
      },
      {
        model: 'lot-medium', price_lovelace: 5_000_000, supplier_bond_lovelace: 1_000_000, buyer_bond_lovelace: 1_000_000, max_processing_ms: 480_000, supplier_pkh: MEDIUM.pkh,
        pub_key_hex: MEDIUM.pubKeyHex, endpoint: 'https://orders-medium.example.test',
      },
      {
        model: 'lot-large', price_lovelace: 10_000_000, supplier_bond_lovelace: 1_000_000, buyer_bond_lovelace: 1_000_000, max_processing_ms: 480_000, supplier_pkh: LARGE.pkh, pub_key_hex: LARGE.pubKeyHex,
        endpoint: 'https://orders-large.example.test',
      },
    ]);
    expect(terms.tiers.map((tier) => tier.model)).toStrictEqual([...LOT_NAMES]);
    expect([LOT_PRICE_LOVELACE, BOND_LOVELACE]).toStrictEqual([{ 'lot-small': 2_000_000, 'lot-medium': 5_000_000, 'lot-large': 10_000_000 }, 1_000_000]);
    // The three tiers have three keys, three public keys and three hosts.
    expect(new Set(terms.tiers.map((tier) => tier.supplier_pkh)).size).toBe(3);
    expect(new Set(terms.tiers.map((tier) => tier.pub_key_hex)).size).toBe(3);
    expect(new Set(terms.tiers.map((tier) => tier.endpoint)).size).toBe(3);
  });

  test('the window of each tier is the window of the operator, and a window of 600000 reaches the three of them', () => {
    expect(manifestOf({ ADVERT_MAX_PROCESSING_MS: '600000' }).terms.tiers.map((tier) => tier.max_processing_ms)).toStrictEqual([600_000, 600_000, 600_000]);
  });

  test('the endpoints follow the host of the small runtime, and its port when it has one', () => {
    const { terms } = manifestOf({ LOTS_PUBLIC_ORIGIN: 'https://mp-orders-small.vector.example.org:8443' });
    expect(terms.tiers.map((tier) => tier.endpoint)).toStrictEqual([
      'https://mp-orders-small.vector.example.org:8443', 'https://mp-orders-medium.vector.example.org:8443', 'https://mp-orders-large.vector.example.org:8443',
    ]);
  });

  test('the key of the first (small) runtime is the listed supplier key of the identity block, and the service key hash is in `keys`', () => {
    const manifest = manifestOf();
    expect(manifest.identity).toStrictEqual({ did: AGENT_DID, registry_address: identityRegistryOf(POLICY, undefined)?.address, supplier_key: `${AGENT_DID}#${SMALL.pkh}` });
    expect(manifest.identity.registry_address).toMatch(/^addr1/);
    expect(manifest.keys).toStrictEqual({ service_pkh: SERVICE.pkh });
    // No private key of the service or of a runtime is in the bytes, in the hex form that a key file holds.
    const { text } = served();
    for (const key of [SERVICE, SMALL, MEDIUM, LARGE]) expect(text).not.toContain(key.privateKeyHex);
  });

  test('the lock of each advert is its price and both bonds: 4, 7 and 12 million lovelace, for a Post that plans the advert of the tier', () => {
    const buyer = 'ab'.repeat(28);
    const expected = { 'lot-small': 4_000_000n, 'lot-medium': 7_000_000n, 'lot-large': 12_000_000n };
    for (const tier of manifestOf().terms.tiers) {
      const advert: AdvertDatum & { agent_id: string } = {
        supplier_pkh: tier.supplier_pkh, capability_id: INVENTORY_CAPABILITIES.order, model: tier.model, max_output_tokens: 0, max_processing_ms: tier.max_processing_ms,
        price_lovelace: BigInt(tier.price_lovelace), supplier_bond_lovelace: BigInt(tier.supplier_bond_lovelace), buyer_bond_lovelace: BigInt(tier.buyer_bond_lovelace),
        endpoint_url: tier.endpoint, detail_uri: `${tier.endpoint}/agent.json`, detail_hash: served().sha256, advertised_at: 1_790_000_000_000, status: 'Active', agent_id: AGENT_DID.slice('did:vector:'.length),
      };
      const identity = fleetPostTerms(advert, SERVICE_ADDRESS);
      const plan = planFleetPostEscrow(advert, `${'cd'.repeat(32)}#1`, buyer, 'ef'.repeat(32), 1_790_000_000_000, identity);
      expect(plan.lockLovelace, tier.model).toBe(expected[tier.model]);
      expect(plan.lockLovelace, tier.model).toBe(BigInt(tier.price_lovelace + tier.supplier_bond_lovelace + tier.buyer_bond_lovelace));
      expect(plan.deliverBy, tier.model).toBe(1_790_000_000_000 + tier.max_processing_ms + DELIVER_BY_BUFFER_MS);
    }
  });
});

describe('the lots file', () => {
  test('the manifest names it at the origin of the first runtime, with the SHA-256 of its bytes', () => {
    const bytes = readFileSync(here('lots.json'));
    const { lots } = manifestOf().behaviour;
    expect(lots).toStrictEqual({ uri: `${ORIGIN}${LOTS_ROUTE}`, sha256: sha256(bytes) });
    expect(LOTS_ROUTE).toBe('/lots.json');
    expect(lots.sha256).toBe(lotsFileSha256(bytes.toString('utf8')));
    expect(loadLots(LOTS_FILE).sha256).toBe(lots.sha256);
    expect(LOTS_FILE).toBe(new URL('../../lots.json', import.meta.url).pathname);
  });

  test('the address is on the host of the small runtime, and it follows the origin of the operator', () => {
    expect(manifestOf({ LOTS_PUBLIC_ORIGIN: 'https://orders-small.example.org' }).behaviour.lots.uri).toBe('https://orders-small.example.org/lots.json');
  });
});

describe('the members of the manifest', () => {
  test('are those of the Order Desk: the name, the capability, the claim, the model, the routes it relies on, the status, the operator and the links', () => {
    const manifest = manifestOf();
    expect([manifest.schema, manifest.name, manifest.capability_id, manifest.version]).toStrictEqual(['vector.agent-manifest.v2', 'Order Desk', INVENTORY_CAPABILITIES.order, '0.1.0']);
    expect(manifest.capability_id).toBe('supplychain.order.accept.v1');
    expect(manifest.operator).toStrictEqual({ name: 'Apex Fusion Foundation', contact: 'ops@example.test' });
    expect(manifest.behaviour.claim.statements.map((statement) => statement.text)).toStrictEqual(ORDER_DESK_CLAIM.statements.map((statement) => statement.text));
    expect(manifest.behaviour.model).toStrictEqual({ allowlist: ['deepseek/deepseek-v4-flash'], max_price_lovelace: 1_000_000 });
    expect(manifest.behaviour.relying_on).toStrictEqual({
      mock_systems: ['GET /t/{tenant}/supplier/catalogue/{sku}', 'POST /t/{tenant}/supplier/orders'],
      gateway_routes: ['POST /spiffe/nonce', 'POST /spiffe/x509-svid', 'GET /1.0/identifiers/{did}'],
    });
    expect(manifest.status).toStrictEqual({ chip: 'proposed', since: '2026-11-23' });
    expect(manifest.links.explorer_advert).toBe('');
    expect(manifest.links.spec).toMatch(/^https:\/\/github\.com\/.*\/specs\/order-desk\.md$/);
    // The additions are the additions of an order desk: the kit parses them as such, and an order desk has no operations and no co-sign rule.
    expect(parseBehaviourAdditions('order-desk', { claim: manifest.behaviour.claim, fault_modes: manifest.behaviour.fault_modes, model: manifest.behaviour.model, relying_on: manifest.behaviour.relying_on, lots: manifest.behaviour.lots }).ok).toBe(true);
    expect(Object.keys(manifest.behaviour)).not.toContain('operations');
    expect(Object.keys(manifest.behaviour)).not.toContain('cosign');
  });

  test('take the version, the status and the link of the advert from the operator, and the models and the ceiling of the allowlist', () => {
    const manifest = manifestOf({
      AGENT_VERSION: '0.2.1', AGENT_STATUS_CHIP: 'Deployed', AGENT_STATUS_SINCE: '2026-12-01', ADVERT_EXPLORER_URL: 'https://explorer.example.test/advert/1',
      LLM_MODEL_ALLOWLIST: 'a/one, b/two', LLM_MAX_PRICE_LOVELACE: '250000',
    });
    expect([manifest.version, manifest.status, manifest.links.explorer_advert]).toStrictEqual(['0.2.1', { chip: 'deployed', since: '2026-12-01' }, 'https://explorer.example.test/advert/1']);
    expect(manifest.behaviour.model).toStrictEqual({ allowlist: ['a/one', 'b/two'], max_price_lovelace: 250_000 });
    expect(() => loadConfig(envWith({ AGENT_STATUS_CHIP: 'bogus' }))).toThrow(/^environment variable AGENT_STATUS_CHIP must be one of /);
    expect(() => loadConfig(envWith({ AGENT_STATUS_SINCE: 'yesterday' }))).toThrow(/^environment variable AGENT_STATUS_SINCE must be a date as YYYY-MM-DD/);
  });

  test('say in words that one manifest serves the three adverts, that the checks come before the Claim, and what the lot of an order is', () => {
    const { notes } = manifestOf().interface;
    expect(notes).toHaveLength(5);
    expect(notes.join(' ')).toContain('16 checks');
    expect(notes.join(' ')).toContain('the three adverts hold one manifest hash');
    expect(manifestOf().interface.routes).toStrictEqual({ job: '/v1/job', status: '/status', capability: '/capability', lots: '/lots.json' });
  });

  test('hold no dash of the long kind and no name of the ledger unit', () => {
    const { text } = served();
    expect(text).not.toMatch(/[\u{2013}\u{2014}]/u);
    expect(text).not.toMatch(UNIT_NAME);
  });
});

describe('the gaps', () => {
  test('are the six of the page in its order, the sentence about the keys of the parties, the sentence about what no run shows, and then the one sentence of the kit about the fault switch', () => {
    expect(PAGE_GAPS).toHaveLength(6);
    expect(GAPS).toStrictEqual([...PAGE_GAPS, CONTROLLER_GAP, NOT_SHOWN_GAP, faultGap('order-desk')]);
    expect(manifestOf().gaps).toStrictEqual([...GAPS]);
    expect(GAPS).toHaveLength(9);
    expect(PAGE_GAPS[0]).toBe('The model decides whether the lot can be supplied. Nothing in this agent overrides it.');
    expect(PAGE_GAPS[5]).toBe('The price of a lot is a stand-in for its size.');
  });

  test('say the three things that the rulings of the pages ask for: the keys of the parties are on one host, and three items are in no run, the reclaim in use case 1 among them', () => {
    expect(CONTROLLER_GAP).toContain('are on one host of one operator, so a party is independent of the controller by key only');
    expect(CONTROLLER_GAP).toContain('The controller key of this deployment');
    expect(NOT_SHOWN_GAP.startsWith('What this does not show:')).toBe(true);
    for (const item of ['the refund of the escrow of a revoked agent', 'the reclaim of an escrow in use case 1', 'a relying party that refuses a live token after its authority ends']) expect(NOT_SHOWN_GAP).toContain(item);
  });

  test('are one line each, with no long dash and no name of the ledger unit', () => {
    for (const gap of GAPS) {
      expect(gap, gap).not.toMatch(/[\n\u{2013}\u{2014}]/u);
      expect(gap, gap).not.toMatch(UNIT_NAME);
    }
  });
});

describe('the template', () => {
  test('is the render of the builder with placeholders, and agent.json.template equals it', () => {
    const template = renderTemplate();
    expect(readFileSync(here('agent.json.template'), 'utf8')).toBe(template);
    expect(template.endsWith('}\n')).toBe(true);
    expect(JSON.parse(template).name).toBe('Order Desk');
    expect(renderTemplate()).toBe(template);
  });

  test('names a placeholder for each value that the operator gives, and for the values that the service derives from the origin of the first runtime', () => {
    const template = renderTemplate();
    const found = [...new Set(template.match(/<[A-Z][A-Z0-9_]*>/g) ?? [])].sort();
    expect(found).toStrictEqual([
      '<AGENT_DID>', '<LARGE_ENDPOINT>', '<LARGE_SUPPLIER_PKH>', '<LARGE_SUPPLIER_PUB_KEY_HEX>', '<LOTS_URI>', '<MEDIUM_ENDPOINT>', '<MEDIUM_SUPPLIER_PKH>', '<MEDIUM_SUPPLIER_PUB_KEY_HEX>',
      '<OPERATOR_CONTACT>', '<ORDER_DESK_SERVICE_PKH>', '<SMALL_ENDPOINT>', '<SMALL_SUPPLIER_PKH>', '<SMALL_SUPPLIER_PUB_KEY_HEX>',
    ]);
    // The origin is not in the template: the endpoints and the address of the lots file, which the service derives from it, are.
    for (const [name, value] of Object.entries(TEMPLATE_ENV)) if (value.startsWith('<') && name !== 'LOTS_PUBLIC_ORIGIN') expect(found, name).toContain(value);
    const manifest = JSON.parse(template) as OrderDeskManifest;
    expect(manifest.identity.supplier_key).toBe('<AGENT_DID>#<SMALL_SUPPLIER_PKH>');
    expect(manifest.terms.tiers.map((tier) => tier.endpoint)).toStrictEqual(['<SMALL_ENDPOINT>', '<MEDIUM_ENDPOINT>', '<LARGE_ENDPOINT>']);
  });

  test('holds the real hash of the lots file, the three prices and the gaps of the manifest, and is never the manifest that the service serves', () => {
    const template = JSON.parse(renderTemplate()) as OrderDeskManifest;
    expect(template.behaviour.lots.sha256).toBe(sha256(readFileSync(here('lots.json'))));
    expect(template.terms.tiers.map((tier) => tier.price_lovelace)).toStrictEqual([2_000_000, 5_000_000, 10_000_000]);
    expect(template.gaps).toStrictEqual([...GAPS]);
    expect(renderTemplate()).not.toBe(served().text);
    expect(served().text).not.toMatch(/<[A-Z][A-Z0-9_]*>/);
  });

  test('the kit refuses a served manifest that has a placeholder, and a template that has none is a template with no placeholder for the operator', () => {
    const lots = loadLots(LOTS_FILE);
    const refused = renderManifest('order-desk', () => manifestFromEnv(TEMPLATE_ENV, lots));
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.code).toBe('manifest_has_placeholder');
    expect(renderManifest('order-desk', () => manifestFromEnv(TEMPLATE_ENV, lots), { template: true }).ok).toBe(true);
  });
});
