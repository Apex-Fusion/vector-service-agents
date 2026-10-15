// agents/document-pipeline/test/spec.test.ts
// specs/document-pipeline.md and the manifest say the same things. The page is written from what the code does, and these tests keep it that way, as
// agents/agent-history/test/spec.test.ts does for its page: the numbers of the Terms, the capability id, the opening line, the identity, the request and the
// response the manifest links to, the third parties, the links, and the gap sentences that were on the page before the service was built and still hold.
//
// What is not here yet is the other half of the gaps. The manifest also states the deadline rule and what an extraction does when its answer does not fit
// the schema (src/gaps.ts); the page still describes a design, and is brought up to the built service by its own task (the spec update), which then adds
// the pin that every sentence of the manifest's gaps is on the page word for word, as agent-history's page has it.
import { describe, test, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { REGISTRY_ADDRESS } from '@vsa/vector-read';
import { JOB_DEADLINE_MS } from '../src/budget.ts';
import { GAPS, OCR_FIRST_PARTY_GAP, PAGES_GAP, RECEIPTS_GAP, SUBSIDY_GAP, SUPPLIERS_FIRST_PARTY_GAP } from '../src/gaps.ts';
import { manifestFromEnv } from '../src/server.ts';
import { TEST_CONTACT } from './server-support.ts';

const spec = readFileSync(new URL('../../../specs/document-pipeline.md', import.meta.url), 'utf8');
const m = manifestFromEnv({ OPERATOR_CONTACT: TEST_CONTACT });
// The text of one "## heading" section, up to the next "## " heading.
const section = (heading: string): string => { const rest = spec.split(`\n## ${heading}\n`)[1]; return rest === undefined ? '' : rest.split('\n## ')[0]; };
const thousands = (n: number): string => n.toLocaleString('en-US');

describe('specs/document-pipeline.md', () => {
  test('the Terms tables carry the numbers of the manifest', () => {
    const t = m.terms;
    const printed = (n: number) => (n / 1_000_000).toFixed(6);
    const terms = section('Terms');
    expect(terms).toContain(`| Price | ${t.price_lovelace} | ${printed(t.price_lovelace)} |`);
    expect(terms).toContain(`| Supplier bond | ${t.supplier_bond_lovelace} | ${printed(t.supplier_bond_lovelace)} |`);
    expect(terms).toContain(`| Buyer bond | ${t.buyer_bond_lovelace} | ${printed(t.buyer_bond_lovelace)} |`);
    const locked = t.price_lovelace + t.supplier_bond_lovelace + t.buyer_bond_lovelace;
    expect(terms).toContain(`| Locked by the buyer (price and both bonds) | ${locked} | ${printed(locked)} |`);
    expect(terms).toContain(`| Processing window, advert \`max_processing_ms\` | ${t.max_processing_ms} ms`);
    // The runtime's service timeout is the job's own deadline plus 60 s, so that a run answers before the runtime gives up on it.
    expect(terms).toContain(`| Service timeout, \`SERVICE_TIMEOUT_MS\` | ${JOB_DEADLINE_MS + 60_000} ms |`);
    expect(terms).toContain(`| Fetched source | ${t.input_limits.source_bytes / (1024 * 1024)} MB |`);
    expect(terms).toContain(`| \`max_pages\` | ${t.input_limits.max_pages} in v1 |`);
    expect(terms).toContain('| PDF pages | rendered to PNG at 150 dpi |');
  });

  test('the Interface section gives the limits of the manifest in words', () => {
    const t = m.terms.input_limits;
    const text = section('Interface').replace(/\s+/g, ' ');
    expect(text).toContain(`The wire payload is capped at ${thousands(t.request_bytes)} bytes`);
    expect(text).toContain(`base64 under ${thousands(t.inline_media_bytes)} bytes of raw media`);
    expect(text).toContain(`and a ${t.source_bytes / (1024 * 1024)} MB cap`);
    expect(text).toContain(`POST ${m.interface.routes.job}`);
  });

  test('the capability id and the model string', () => {
    expect(section('Capability id')).toContain(`\`${m.capability_id}\``);
    expect(section('Capability id')).toContain('`document-pipeline-v1`');
  });

  test('the opening line says what the manifest description says', () => {
    expect(spec.split('\n')[2]).toContain(m.description);
  });

  test('the status word is the manifest\'s', () => {
    expect(section('Status').trimStart().startsWith(`${m.status.chip.toUpperCase()} (`)).toBe(true);
  });

  test('the identity: the registry address, and both key hashes under keys', () => {
    const identity = section('Identity');
    expect(identity).toContain(`\`${REGISTRY_ADDRESS}\``);
    expect(m.identity.registry_address).toBe(REGISTRY_ADDRESS);
    for (const key of ['supplier_pkh', 'buyer_pkh']) {
      expect(Object.keys(m.keys)).toContain(key);
      expect(identity).toContain(`\`${key}\``);
    }
  });

  test('the request: the spec shows every field of the schema the manifest publishes, with the same values', () => {
    const request = spec.split('\n### Request\n')[1].split('\n### Response\n')[0];
    const schema = m.interface.request_schema;
    for (const name of Object.keys(schema.properties)) expect(request, name).toContain(`"${name}"`);
    expect(schema.required).toStrictEqual(['source', 'task']);
    expect(request).toContain(schema.properties.task.enum.map((task) => `"${task}"`).join(' | '));
    for (const mime of ['application/pdf', 'image/png', 'image/jpeg']) {
      expect(request, mime).toContain(mime);
      expect(JSON.stringify(schema.properties.source), mime).toContain(mime);
    }
    expect(request).toContain(`"language": "${schema.properties.language.default}"`);
    expect(request).toContain(`"max_pages": ${schema.properties.max_pages.default}`);
  });

  test('the response: one Response heading, which is the anchor the manifest links to', () => {
    expect(m.interface.response_schema.$ref.endsWith('/specs/document-pipeline.md#response')).toBe(true);
    expect(spec.match(/^#{1,6} Response$/gm)).toStrictEqual(['### Response']); // one heading, so the anchor is #response
    expect(spec).toContain('`schema` is `vector.document-pipeline.result.v1`');
  });

  test('the third parties of the manifest are the ones the page lists', () => {
    const table = section('Operator and data handling');
    const [host, ocr, llm, koios, indexer] = m.behaviour.third_parties;
    for (const party of [host, ocr, llm]) expect(table, party).toContain(`| ${party}`);
    expect(table).toContain('Koios');
    expect(table).toContain('marketplace indexer');
    expect(koios).toMatch(/^Koios/);
    expect(indexer).toBe('marketplace indexer');
  });

  test('the gap sentences that were on the page before the build and still hold are on it, word for word', () => {
    const gaps = section('Known gaps');
    for (const gap of [PAGES_GAP, OCR_FIRST_PARTY_GAP, SUPPLIERS_FIRST_PARTY_GAP, RECEIPTS_GAP]) {
      expect(GAPS).toContain(gap);
      expect(gaps, gap.slice(0, 50)).toContain(`\n- ${gap}\n`);
    }
    // The subsidy is stated in the Economics lines of the Terms, which continue after a label: the sentence there begins in lower case.
    expect(GAPS).toContain(SUBSIDY_GAP);
    expect(section('Terms')).toContain(`Economics: ${SUBSIDY_GAP.replace(/^At/, 'at')}`);
  });

  test('the links of the manifest name the page and the folder of the service, which exist', () => {
    expect(m.links.spec).toBe('https://github.com/Apex-Fusion/vector-service-agents/blob/main/specs/document-pipeline.md');
    expect(m.links.source).toBe('https://github.com/Apex-Fusion/vector-service-agents/tree/main/agents/document-pipeline');
    expect(existsSync(new URL('../../../specs/document-pipeline.md', import.meta.url))).toBe(true);
    expect(existsSync(new URL('../src/index.ts', import.meta.url))).toBe(true);
  });
});
