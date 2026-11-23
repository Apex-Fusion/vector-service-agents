// agents/reorder-agent/test/serve/manifest.test.ts
// The manifest of the Reorder Agent: the same bytes on every render, the same bytes for the empty fault setting (the only one that the agent has), a template file that equals the render of the template, and a
// hash that the script of the repository prints for the bytes that a server serves. The behaviour holds the members of the kit, the gaps are the eight sentences in their order, and the terms agree with the
// lock that a Post makes for the advert: the price and both bonds, 3 + 1 + 1 = 5 units.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { fleetPostTerms, planFleetPostEscrow } from '@vsa/buyer-core';
import type { AdvertDatum } from '@vsa/vector-read';
import { COSIGN_RULE } from '@vsa/usecase-kit/protocol';
import { INVENTORY_CAPABILITIES, REORDER_CLAIM } from '@vsa/usecase-kit/inventory';
import { renderManifest } from '@vsa/usecase-kit/manifest';
import { APPROVAL_GAP, CHALLENGE_GAP, KEYS_GAP, LOT_GAP, MODEL_GAP, NOT_SHOWN_GAP, STOCK_GAP, SUPPLIER_GAP, gapsFor } from '../../src/serve/gaps.ts';
import { keyOf } from '../../src/serve/keys.ts';
import { DESCRIPTION, SOURCE_URL, SPEC_URL, TEMPLATE_ENV, manifestFromEnv, renderTemplate } from '../../src/serve/manifest.ts';
import { AGENT_DID, KEY_NUMBERS, SUPPLIER, completeEnv, messageOf, rawKey } from './support.ts';

const templateFile = fileURLToPath(new URL('../../agent.json.template', import.meta.url));

/** The environment of the manifest: the complete environment, with the key hashes that the service derives from its keys. */
const manifestEnv = (over: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => completeEnv({
  REORDER_SERVICE_PKH: keyOf(rawKey(KEY_NUMBERS.service)).pkh, REORDER_DELEGATION_1_PKH: keyOf(rawKey(KEY_NUMBERS.delegation1)).pkh, REORDER_DELEGATION_2_PKH: keyOf(rawKey(KEY_NUMBERS.delegation2)).pkh, ...over,
});

const render = (env: NodeJS.ProcessEnv = manifestEnv()) => {
  const rendered = renderManifest('reorder-agent', () => manifestFromEnv(env));
  if (!rendered.ok) throw new Error(`${rendered.code}: ${rendered.detail}`);
  return rendered.value;
};

type Json = Record<string, unknown>;
const parsed = (env: NodeJS.ProcessEnv = manifestEnv()): Json => JSON.parse(render(env).text) as Json;

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

  test('change with a setting of the manifest and with nothing else: another model, another DID or another price gives another hash, and a setting that is not in the manifest gives the same one', () => {
    const base = render().sha256;
    expect(render(manifestEnv({ LLM_MODEL_ALLOWLIST: 'other/model' })).sha256).not.toBe(base);
    expect(render(manifestEnv({ AGENT_DID: `did:vector:${'c3'.repeat(32)}` })).sha256).not.toBe(base);
    expect(render(manifestEnv({ ADVERT_PRICE_LOVELACE: '4000000' })).sha256).not.toBe(base);
    expect(render(manifestEnv({ PORT: '9999', HOST: '127.0.0.2', MOCK_PUBLIC_BASE: 'https://other.example' })).sha256).toBe(base);
  });

  test('hold no fault value and no member fault_mode, so the manifest of a clean run and of a run with a stray setting are one file', () => {
    const text = render().text;
    for (const value of ['confirm_wrong_lot', 'alter_after_approval', 'quote_off_price_list', 'invert_scores']) expect(text).not.toContain(value);
    // The list of the possible values is `fault_modes`, and it is empty. A member `fault_mode` is the active value, and it stands in no manifest.
    expect(text).not.toMatch(/"fault_mode"\s*:/);
    expect(parsed().behaviour).toMatchObject({ fault_modes: [] });
    expect(gapsFor().filter((gap) => gap.includes('fault switch'))).toStrictEqual([]);
  });
});

describe('the template', () => {
  test('is the render of the template environment, byte for byte: indented JSON with a line break at the end and placeholders for the operator values', () => {
    const file = readFileSync(templateFile, 'utf8');
    expect(file).toBe(renderTemplate());
    expect(file.endsWith('}\n')).toBe(true);
    for (const name of ['OPERATOR_CONTACT', 'AGENT_DID', 'SUPPLIER_PKH', 'SUPPLIER_PUB_KEY_HEX', 'REORDER_SERVICE_PKH', 'REORDER_DELEGATION_1_PKH', 'REORDER_DELEGATION_2_PKH']) {
      expect(file).toContain(`<${name}>`);
      expect(TEMPLATE_ENV[name as keyof typeof TEMPLATE_ENV]).toBe(`<${name}>`);
    }
    expect(JSON.parse(file)).toMatchObject({ name: 'Reorder Agent', capability_id: 'supplychain.reorder.po.v1', status: { chip: 'proposed' } });
  });

  test('is never served: a manifest that still has a placeholder is refused by the render of a served manifest', () => {
    const rendered = renderManifest('reorder-agent', () => manifestFromEnv(TEMPLATE_ENV));
    expect(rendered.ok).toBe(false);
    if (!rendered.ok) expect(rendered.code).toBe('manifest_has_placeholder');
  });
});

describe('the members of the manifest', () => {
  test('name the agent, its capability, its identity, its keys, its status and its links', () => {
    const manifest = parsed();
    expect(manifest).toMatchObject({
      schema: 'vector.agent-manifest.v2', name: 'Reorder Agent', capability_id: INVENTORY_CAPABILITIES.reorder, version: '0.1.0', description: DESCRIPTION,
      operator: { name: 'Apex Fusion Foundation', contact: 'ops@example.test' },
      status: { chip: 'proposed', since: '2026-11-16' },
      links: { spec: SPEC_URL, source: SOURCE_URL, explorer_advert: '' },
    });
    expect(manifest.capability_id).toBe('supplychain.reorder.po.v1');
    expect((manifest.identity as Json).did).toBe(AGENT_DID);
    expect((manifest.identity as Json).supplier_key).toBe(`${AGENT_DID}#${SUPPLIER.keyHash}`);
    expect(manifest.keys).toStrictEqual({
      supplier_pkh: SUPPLIER.keyHash, pub_key_hex: SUPPLIER.publicKey, buyer_pkh: keyOf(rawKey(KEY_NUMBERS.service)).pkh,
      delegation_pkhs: [keyOf(rawKey(KEY_NUMBERS.delegation1)).pkh, keyOf(rawKey(KEY_NUMBERS.delegation2)).pkh],
    });
    expect((manifest.interface as Json).routes).toStrictEqual({ job: '/v1/job', status: '/status', capability: '/capability' });
  });

  test('the status and the version come from the settings, and a wrong status stops the render by its variable', () => {
    expect(parsed(manifestEnv({ AGENT_STATUS_CHIP: 'LIVE', AGENT_STATUS_SINCE: '2026-12-01', AGENT_VERSION: '0.2.0', ADVERT_EXPLORER_URL: 'https://explorer.example/advert' }))).toMatchObject({
      status: { chip: 'live', since: '2026-12-01' }, version: '0.2.0', links: { explorer_advert: 'https://explorer.example/advert' },
    });
    expect(messageOf(() => manifestFromEnv(manifestEnv({ AGENT_STATUS_CHIP: 'done' })))).toMatch(/^environment variable AGENT_STATUS_CHIP must be one of/);
    expect(messageOf(() => manifestFromEnv(manifestEnv({ AGENT_STATUS_SINCE: 'yesterday' })))).toMatch(/^environment variable AGENT_STATUS_SINCE must be a date/);
    expect(messageOf(() => manifestFromEnv(manifestEnv({ OPERATOR_CONTACT: undefined })))).toMatch(/^environment variable OPERATOR_CONTACT is required/);
    expect(messageOf(() => manifestFromEnv(manifestEnv({ AGENT_DID: `did:vector:${'zz'.repeat(32)}` })))).toMatch(/AGENT_DID/);
  });

  test('the behaviour holds the members of the kit: both operations, the claim of the agent word for word, the co-sign rule, no fault value, the models and the routes that the agent calls', () => {
    const behaviour = parsed().behaviour as Json;
    expect(behaviour.operations).toStrictEqual(['propose', 'execute']);
    expect(behaviour.claim).toStrictEqual({ statements: REORDER_CLAIM.statements.map((statement) => ({ id: statement.id, text: statement.text })) });
    expect(behaviour.cosign).toStrictEqual({ route: '/cosign/delegate', rule: COSIGN_RULE });
    expect(behaviour.fault_modes).toStrictEqual([]);
    expect(behaviour.model).toStrictEqual({ allowlist: ['deepseek/deepseek-v4-flash'], max_price_lovelace: 1_000_000 });
    expect(behaviour.relying_on).toStrictEqual({ mock_systems: ['GET /t/{tenant}/erp/stock/{sku}', 'POST /t/{tenant}/po'], gateway_routes: ['POST /token'] });
    expect(Object.keys(behaviour)).toStrictEqual(['data_handling', 'third_parties', 'operations', 'claim', 'cosign', 'fault_modes', 'model', 'relying_on']);
    expect(parsed(manifestEnv({ LLM_MODEL_ALLOWLIST: 'a/b, c/d', LLM_MAX_PRICE_LOVELACE: '250000' })).behaviour).toMatchObject({ model: { allowlist: ['a/b', 'c/d'], max_price_lovelace: 250_000 } });
  });

  test('the gaps are the eight sentences, in the order of the page, and no sentence changes between two renders', () => {
    const gaps = parsed().gaps;
    expect(gaps).toStrictEqual([LOT_GAP, APPROVAL_GAP, CHALLENGE_GAP, STOCK_GAP, MODEL_GAP, SUPPLIER_GAP, KEYS_GAP, NOT_SHOWN_GAP]);
    expect(gaps).toStrictEqual([...gapsFor()]);
    for (const gap of gaps as string[]) {
      expect(gap.endsWith('.')).toBe(true);
      expect(gap).not.toMatch(/[\n\r]/);
    }
    expect(CHALLENGE_GAP).toContain('600 s after its Submit');
    expect(KEYS_GAP).toContain('independent of the controller by key only');
    expect(NOT_SHOWN_GAP.startsWith('What this does not show:')).toBe(true);
  });
});

describe('the terms', () => {
  const advert = (manifest: Json, extra: Partial<AdvertDatum> & { agent_id?: string } = {}): AdvertDatum => {
    const terms = manifest.terms as Json;
    return {
      supplier_pkh: SUPPLIER.keyHash, capability_id: manifest.capability_id as string, model: 'reorder-agent-v1', max_output_tokens: 0, max_processing_ms: terms.max_processing_ms as number,
      price_lovelace: BigInt(terms.price_lovelace as number), supplier_bond_lovelace: BigInt(terms.supplier_bond_lovelace as number), buyer_bond_lovelace: BigInt(terms.buyer_bond_lovelace as number),
      endpoint_url: 'https://reorder.example', detail_uri: 'https://reorder.example/agent.json', detail_hash: 'ab'.repeat(32), advertised_at: 0, status: 'Active', ...extra,
    } as AdvertDatum;
  };
  const NOW = 1_790_000_000_000;
  const REF = `${'cc'.repeat(32)}#0`;
  const PROMPT = 'dd'.repeat(32);
  const buyer = keyOf(rawKey(KEY_NUMBERS.delegation1));

  test('are the price 3 and both bonds 1, in a window of 1,800,000 ms, and the input limits are the limits of the intake', () => {
    expect(parsed().terms).toStrictEqual({
      price_lovelace: 3_000_000, supplier_bond_lovelace: 1_000_000, buyer_bond_lovelace: 1_000_000, max_processing_ms: 1_800_000,
      input_limits: { request_bytes: 900_000, sku_chars: 64, tenant_chars: 48 },
    });
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
    expect(identity.deliverBy - NOW).toBeGreaterThanOrEqual(1_800_000);
  });

  test('follow a price that the operator sets: the lock is that price and both bonds', () => {
    const manifest = parsed(manifestEnv({ ADVERT_PRICE_LOVELACE: '6000000' }));
    expect(planFleetPostEscrow(advert(manifest), REF, buyer.pkh, PROMPT, NOW).lockLovelace).toBe(8_000_000n);
  });
});
