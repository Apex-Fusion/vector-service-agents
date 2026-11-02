import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { replayFetch, REGISTRY_POLICY } from '@vsa/vector-read';
import { buildReport, BLIND_SPOTS, CURRENT_STATE_GAP, IDENTITY_VIEW_GAP, LEGACY_ONLY, REPORT_BUDGET_MS, lastKnownKeysLine } from '../src/report.ts';
import { manifestFromEnv } from '../src/server.ts';
import { DEFAULT_MODULES } from '../src/config.ts';
import { TEST_ENV } from './support.ts';
// specs/agent-history.md is written from what the code emits. These tests keep it that way.
const spec = readFileSync(new URL('../../../specs/agent-history.md', import.meta.url), 'utf8');
const fx = JSON.parse(readFileSync(new URL('./fixtures/chandra.json', import.meta.url), 'utf8'));
const CHANDRA = '5542837bc3a6ccd66cb75ac91a796cf5716d439f4a72594bbfc06db7231029db';
const DID = `did:vector:agent:be1a0a2912da180757ed3cd61b56bb8eab0188c19dc3c0e3912d2c01:${CHANDRA}`;
const lookup = async () => [{ address: '8.8.8.8', family: 4 }];
// The text of one "## heading" section, up to the next "## " heading.
const section = (heading: string) => { const rest = spec.split(`\n## ${heading}\n`)[1]; return rest === undefined ? '' : rest.split('\n## ')[0]; };
// Every key path of a JSON value, with arrays collapsed to their first element.
function paths(v: unknown, at = ''): string[] {
  if (Array.isArray(v)) return v.length ? paths(v[0], `${at}[]`) : [`${at}[]`];
  if (v && typeof v === 'object') return Object.entries(v).flatMap(([k, x]) => paths(x, at ? `${at}.${k}` : k));
  return [at];
}

describe('specs/agent-history.md', () => {
  test('Known gaps lists every fixed blind-spot line, word for word', () => {
    const gaps = section('Known gaps');
    for (const line of BLIND_SPOTS) expect(gaps, line.slice(0, 50)).toContain(`\n- ${line}\n`);
    expect(BLIND_SPOTS).toHaveLength(7);
    expect(gaps).toContain('Every report carries these seven lines in `blind_spots`, word for word.');
  });
  test('the manifest gaps are blind-spot lines, so the spec lists them word for word as well', () => {
    const m = manifestFromEnv(TEST_ENV);
    expect(m.gaps).toEqual([BLIND_SPOTS[1], `${BLIND_SPOTS[2]} ${BLIND_SPOTS[3]}`, CURRENT_STATE_GAP, IDENTITY_VIEW_GAP]);
    expect(CURRENT_STATE_GAP).toBe(BLIND_SPOTS[5]);
    expect(IDENTITY_VIEW_GAP).toBe(BLIND_SPOTS[6]);
    for (const line of [BLIND_SPOTS[1], BLIND_SPOTS[2], BLIND_SPOTS[3], CURRENT_STATE_GAP, IDENTITY_VIEW_GAP]) expect(section('Known gaps')).toContain(line);
  });
  test('the opening line says what the manifest description says', () => {
    const first = manifestFromEnv(TEST_ENV).description.split(' Read-only')[0]; // the sentence before "Read-only; no model cost."
    expect(first).toContain('delivered with the runtime');
    expect(spec.split('\n')[2]).toContain(first);
  });
  test('the lines a report adds are in Known gaps', () => {
    const gaps = section('Known gaps');
    const added = [
      LEGACY_ONLY, 'No registry record found for this subject.', lastKnownKeysLine(['<key hash>']), 'module scan may be truncated at 1,000 rows',
      'marketplace was not read: the subject has no live registry record that names a marketplace key (the owner key of a legacy record, or a listed key with the transaction purpose), and the identity timeline gave no earlier one.',
    ];
    for (const line of added) expect(gaps, line.slice(0, 40)).toContain(line);
  });
  test('the Terms tables carry the numbers of the manifest', () => {
    const t = manifestFromEnv(TEST_ENV).terms;
    const printed = (n: number) => (n / 1_000_000).toFixed(6);
    const terms = section('Terms');
    expect(terms).toContain(`| Price | ${t.price_lovelace} | ${printed(t.price_lovelace)} |`);
    expect(terms).toContain(`| Supplier bond | ${t.supplier_bond_lovelace} | ${printed(t.supplier_bond_lovelace)} |`);
    expect(terms).toContain(`| Buyer bond | ${t.buyer_bond_lovelace} | ${printed(t.buyer_bond_lovelace)} |`);
    const locked = t.price_lovelace + t.supplier_bond_lovelace + t.buyer_bond_lovelace;
    expect(terms).toContain(`| Locked by the buyer (price and both bonds) | ${locked} | ${printed(locked)} |`);
    expect(terms).toContain(`| Processing window, advert \`max_processing_ms\` | ${t.max_processing_ms} ms |`);
    expect(terms).toContain(`| Wire payload, the body of \`POST /\` | ${t.input_limits.request_bytes} bytes (64 KiB), counted in bytes |`);
    expect(terms).toContain('| Service timeout, `SERVICE_TIMEOUT_MS` | 180000 ms |');
    expect(terms).toContain(`| Report time budget | ${REPORT_BUDGET_MS} ms |`);
    expect(terms).toContain('A section that has not finished by then is reported as `{ "error": "time budget exceeded" }`');
  });
  test('the capability id, the status line and the one Response heading the manifest links to', () => {
    const m = manifestFromEnv(TEST_ENV);
    expect(section('Capability id')).toContain(`\`${m.capability_id}\``);
    expect(section('Status')).toContain('DEPLOYED (registered and staked 2026-10-14, advertised 2026-10-14, re-advertised 2026-10-15 at the status flip, one first-party job settled 2026-10-15). Since 2026-10-15.');
    expect(m.status).toEqual({ chip: 'deployed', since: '2026-10-15' });
    expect(m.interface.response_schema.$ref).toBe('https://github.com/Apex-Fusion/vector-service-agents/blob/main/specs/agent-history.md#response');
    expect(spec.match(/^#{1,6} Response$/gm)).toEqual(['### Response']); // one heading, so the anchor is #response
  });
  test('the response example has exactly the key paths of a real report, and the schema and version the code gives', async () => {
    const block = spec.split('\n### Response\n')[1].split('```json\n')[1].split('\n```')[0];
    const example = JSON.parse(block);
    const real = JSON.parse(JSON.stringify(await buildReport({ subject: DID, include: ['identity', 'marketplace', 'reputation', 'dispute', 'self_improvement'] }, replayFetch(fx.store), { manifest: manifestFromEnv(TEST_ENV), lookup })));
    expect(paths(example).sort()).toEqual(paths(real).sort());
    expect(example.blind_spots).toEqual(real.blind_spots);
    expect(example.blind_spots).toEqual([LEGACY_ONLY, ...BLIND_SPOTS]);
    expect([example.schema, example.generated_by.version]).toEqual([real.schema, real.generated_by.version]);
    expect(section('Interface')).toContain(`\`schema\` is \`${real.schema}\`.`);
    expect(example.identity).toEqual(real.identity);
    expect(example.key_roles).toEqual(real.key_roles);
  });
  test('the Interface names both DID forms, with the legacy registry policy, and the rule that a DID is lowercase', () => {
    const iface = section('Interface');
    expect(iface).toContain(`\`did:vector:${CHANDRA}\``);
    expect(iface).toContain(`\`did:vector:agent:${REGISTRY_POLICY}:<identifier>\``);
    expect(iface).toContain('Every character of a DID is lowercase');
  });
  test('the module addresses the spec lists are the default ones of the code, under their labels, and it names the settings that change them', () => {
    const where = section('Interface').split('\n### Where the data comes from\n')[1] ?? '';
    const rows = [...where.matchAll(/^\| Module-\d[^|]* \| (\w+) \| `(addr1\w+)` \|$/gm)].map((m) => [m[1], m[2]]);
    const defaults = [['reputation', DEFAULT_MODULES.m3.reputation], ['endorsement', DEFAULT_MODULES.m3.endorsement], ...Object.entries(DEFAULT_MODULES.m1), ...Object.entries(DEFAULT_MODULES.m6)];
    expect(rows).toEqual(defaults);
    for (const name of ['M3_REPUTATION_ADDRESS', 'M3_ENDORSEMENT_ADDRESS', 'M1_ADDRESSES', 'M6_ADDRESSES', 'IDENTITY_POLICY_ID']) expect(where, name).toContain(`\`${name}\``);
  });
});
