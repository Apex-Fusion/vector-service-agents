import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
// The four agent specs share one structure and one set of public-wording rules (docs/superpowers/specs/2026-10-13-vector-service-agents-design.md, section 8).
const HEADINGS = ['Status', 'Identity', 'Capability id', 'Terms', 'Interface', 'What the receipt commits to', 'Operator and data handling', 'Known gaps', 'How to hire it', 'Changelog', 'Links'];
const AGENTS = {
  'agent-history': { capability: 'identity.history.report.v1', status: 'PROPOSED (built, not yet advertised). Since 2026-10-13.' },
  'document-pipeline': { capability: 'document.pipeline.ocr-summary.v1', status: 'PROPOSED (not built). Since 2026-10-13.' },
  'audio-snippets': { capability: 'audio.transcript.snippets.v1', status: 'PROPOSED (not built). Since 2026-10-13.' },
  advocate: { capability: 'research.advocate.onesided.v1', status: 'PROPOSED (not built). Since 2026-10-13.' },
};
const UNIT_NAME = new RegExp('AP' + '3X', 'gi'); // the ledger's native unit is named once, in docs/HIRE.md; spelled in two parts so a search for it finds only the guide
const read = (name) => readFileSync(new URL(`../specs/${name}.md`, import.meta.url), 'utf8');
const section = (text, heading) => { const rest = text.split(`\n## ${heading}\n`)[1] ?? ''; return rest.split('\n## ')[0]; };

test('specs/ holds exactly the four agent specs', () => {
  assert.deepEqual(readdirSync(new URL('../specs/', import.meta.url)).sort(), Object.keys(AGENTS).map((n) => `${n}.md`).sort());
});

for (const [name, { capability, status }] of Object.entries(AGENTS)) {
  test(`${name}: the eleven headings in order, the capability id and the status line`, () => {
    const text = read(name);
    assert.deepEqual([...text.matchAll(/^## (.+)$/gm)].map((m) => m[1]), HEADINGS);
    assert.ok(text.startsWith('# '), 'starts with a title');
    assert.ok(text.split('\n')[2].includes(`\`${capability}\``), 'the first line after the title names the capability id');
    assert.equal(section(text, 'Capability id').split('\n')[1], `\`${capability}\``);
    assert.ok(section(text, 'Status').includes(status), `the status line is "${status}"`);
  });

  test(`${name}: nothing says LIVE or DEPLOYED, no em or en dash, no native unit name`, () => {
    const text = read(name);
    assert.equal(text.replace('Nothing on this page is LIVE or DEPLOYED.', '').match(/\b(LIVE|DEPLOYED)\b/g), null);
    assert.equal(text.match(/[–—]/g), null);
    assert.equal(text.match(UNIT_NAME), null);
  });

  test(`${name}: Terms are lovelace fields printed with six decimals`, () => {
    const rows = [...section(read(name), 'Terms').matchAll(/^\| (Price|Supplier bond|Buyer bond) \| (\d+) \| (\d+\.\d{6}) \|$/gm)];
    assert.equal(rows.length, 3);
    for (const [, , lovelace, printed] of rows) assert.equal((Number(lovelace) / 1_000_000).toFixed(6), printed);
  });
}

test('the three specs that are not built say so under How to hire it', () => {
  for (const name of ['document-pipeline', 'audio-snippets', 'advocate']) {
    assert.ok(section(read(name), 'How to hire it').includes('Not yet advertised. When live, the three ways below apply.'), name);
    assert.ok(section(read(name), 'Changelog').includes('Nothing is built.'), name);
  }
  assert.ok(section(read('agent-history'), 'How to hire it').includes('Not yet advertised. When live, the three ways below apply.'));
  assert.ok(section(read('agent-history'), 'Changelog').trim() === '- 0.1.0 first build');
});

test('the terms of the specs are the ones in the design', () => {
  const t = (name, label) => section(read(name), 'Terms').match(new RegExp(`[|] ${label} [|] ([0-9]+) `))?.[1];
  assert.equal(t('agent-history', 'Price'), '1000000');
  assert.equal(t('document-pipeline', 'Price'), '5000000');
  assert.equal(t('audio-snippets', 'Price'), '2000000');
  assert.equal(t('advocate', 'Price'), '3000000');
  const windows = (name) => section(read(name), 'Terms').match(/advert `max_processing_ms` \| (\d+) ms.*\n\| Service timeout, `SERVICE_TIMEOUT_MS` \| (\d+) ms/)?.slice(1, 3).map(Number);
  assert.deepEqual(windows('agent-history'), [300000, 180000]);
  assert.deepEqual(windows('document-pipeline'), [1800000, 1680000]);
  assert.deepEqual(windows('audio-snippets'), [1500000, 1380000]);
  assert.deepEqual(windows('advocate'), [300000, 180000]);
});

test('the Pipeline states its economics and the first-party OCR hop; the Advocate states its declared bias verbatim', () => {
  const pipeline = read('document-pipeline');
  assert.match(section(pipeline, 'Terms'), /at five pages the Pipeline spends about 19 in locks and fees to earn 5/);
  assert.match(section(pipeline, 'Terms'), /subsidises this on purpose while the fee floor stands/);
  assert.match(section(pipeline, 'Operator and data handling'), /The OCR hop is first-party/);
  assert.ok(read('advocate').includes('"This brief argues one side only, by design, and omits counter-arguments."'));
  assert.equal(read('advocate').split('This brief argues one side only, by design, and omits counter-arguments.').length - 1, 3); // the rule, the shape and the example
});
