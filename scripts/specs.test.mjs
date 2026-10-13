import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
// The four agent specs share one structure and one set of public-wording rules (docs/superpowers/specs/2026-10-13-vector-service-agents-design.md, section 8).
const HEADINGS = ['Status', 'Identity', 'Capability id', 'Terms', 'Interface', 'What the receipt commits to', 'Operator and data handling', 'Known gaps', 'How to hire it', 'Changelog', 'Links'];
const AGENTS = {
  'agent-history': { capability: 'identity.history.report.v1', model: 'agent-history-v1', status: 'PROPOSED (built, not yet advertised). Since 2026-10-13.' },
  'document-pipeline': { capability: 'document.pipeline.ocr-summary.v1', model: 'document-pipeline-v1', status: 'PROPOSED (not built). Since 2026-10-13.' },
  'audio-snippets': { capability: 'audio.transcript.snippets.v1', model: 'audio-snippets-v1', status: 'PROPOSED (not built). Since 2026-10-13.' },
  advocate: { capability: 'research.advocate.onesided.v1', model: 'advocate-v1', status: 'PROPOSED (not built). Since 2026-10-13.' },
};
// The ledger's native unit is named once, in docs/HIRE.md. Spelled in two parts, so a search for the name finds only the guide.
const UNIT_NAME = new RegExp('AP' + '3X', 'gi');
// En and em dash, built from their code points so that this file holds neither.
const DASHES = new RegExp('[' + String.fromCharCode(0x2013, 0x2014) + ']', 'g');
// The two names every spec uses apart: the request JSON (what the member writes) and the wire payload (what is hashed and posted).
const WIRE_PAYLOAD = 'canonicalize([{ content: <request JSON as a string>, role: "user" }])';
const read = (name) => readFileSync(new URL(`../specs/${name}.md`, import.meta.url), 'utf8');
const section = (text, heading) => { const rest = text.split(`\n## ${heading}\n`)[1] ?? ''; return rest.split('\n## ')[0]; };
const DESIGN = readFileSync(new URL('../docs/superpowers/specs/2026-10-13-vector-service-agents-design.md', import.meta.url), 'utf8');

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
    assert.equal(text.match(DASHES), null);
    assert.equal(text.match(UNIT_NAME), null);
  });

  test(`${name}: the Identity section says the agent has no registry record, and it does not claim the whole table is absent`, () => {
    const text = read(name);
    assert.ok(section(text, 'Identity').includes('This agent has no registry record yet.'));
    assert.equal(text.match(/Nothing in this table/), null); // the registry address row does exist
  });

  test(`${name}: the request JSON and the wire payload are named apart, and the raw routes say who wraps`, () => {
    const text = read(name);
    assert.equal(text.match(/payload is the request JSON/i), null);
    assert.ok(section(text, 'Interface').includes(WIRE_PAYLOAD), 'Interface defines the wire payload');
    assert.ok(section(text, 'Interface').includes('wrap the request JSON into the wire payload for you'), 'the tools and the buyer wrap it');
    assert.match(section(text, 'How to hire it'), /3[.] [*][*]Developers, the raw routes[.][*][*][^\n]*wire payload/);
    assert.match(section(text, 'What the receipt commits to'), /prompt_hash[^\n]*wire payload/);
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

test('the terms of each spec are the terms in the design spec, read from its Terms paragraphs', () => {
  const found = new Map();
  const paragraph = /[*][*]Terms[.][*][*] Price (\d+); bonds (\d+) and (\d+); `ADVERT_MAX_PROCESSING_MS` ([\d ]+?)(?: [(][^)]*[)])?; `SERVICE_TIMEOUT_MS` ([\d ]+)[.] (?:In-memory[^.]*[.] )?Model string (?:in the advert and receipt: )?`([a-z0-9-]+)`/g;
  for (const m of DESIGN.matchAll(paragraph)) {
    const n = (s) => Number(s.replace(/ /g, '')); // the design groups thousands with a space
    found.set(m[6], { price: n(m[1]) * 1_000_000, supplierBond: n(m[2]) * 1_000_000, buyerBond: n(m[3]) * 1_000_000, window: n(m[4]), timeout: n(m[5]) });
  }
  assert.deepEqual([...found.keys()].sort(), Object.values(AGENTS).map((a) => a.model).sort(), 'the design has one Terms paragraph for each agent');
  for (const [name, { model }] of Object.entries(AGENTS)) {
    const design = found.get(model);
    const terms = section(read(name), 'Terms');
    const row = (label) => Number(terms.match(new RegExp('[|] ' + label + ' [|] ([0-9]+) '))?.[1]);
    assert.deepEqual({ price: row('Price'), supplierBond: row('Supplier bond'), buyerBond: row('Buyer bond') }, { price: design.price, supplierBond: design.supplierBond, buyerBond: design.buyerBond }, `${name}: price and bonds`);
    const windows = terms.match(/advert `max_processing_ms` \| (\d+) ms.*\n\| Service timeout, `SERVICE_TIMEOUT_MS` \| (\d+) ms/);
    assert.deepEqual([Number(windows?.[1]), Number(windows?.[2])], [design.window, design.timeout], `${name}: processing window and service timeout`);
    assert.ok(section(read(name), 'Capability id').includes(`\`${model}\``), `${name}: the model string is ${model}`);
  }
});

test('the Pipeline states its economics and the first-party OCR hop; the Advocate states its declared bias verbatim', () => {
  const pipeline = read('document-pipeline');
  assert.match(section(pipeline, 'Terms'), /at five pages the Pipeline spends about 19 in locks and fees to earn 5/);
  assert.match(section(pipeline, 'Terms'), /subsidises this on purpose while the fee floor stands/);
  assert.match(section(pipeline, 'Operator and data handling'), /The OCR hop is first-party/);
  assert.match(section(pipeline, 'Operator and data handling'), /Direct hire of the OCR agent by outsiders is out of scope for this programme/);
  assert.equal(pipeline.match(/not offered to outsiders/), null); // the OCR advert is Active on the public indexer
  assert.ok(read('advocate').includes('"This brief argues one side only, by design, and omits counter-arguments."'));
  assert.equal(read('advocate').split('This brief argues one side only, by design, and omits counter-arguments.').length - 1, 3); // the rule, the shape and the example
});
