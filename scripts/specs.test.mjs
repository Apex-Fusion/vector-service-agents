import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
// The four agent specs share one structure and one set of public-wording rules (docs/superpowers/specs/2026-10-13-vector-service-agents-design.md, section 8).
// The member guide and the E2E runbook are pinned against the same specs and the design at the end of this file.
const HEADINGS = ['Status', 'Identity', 'Capability id', 'Terms', 'Interface', 'What the receipt commits to', 'Operator and data handling', 'Known gaps', 'How to hire it', 'Changelog', 'Links'];
// The sentence under "Identity" in each spec. The three designs have no registry record. Agent History was registered on 2026-10-14 (RUNBOOK step 7) and says so.
const NO_RECORD = 'This agent has no registry record yet.';
const HAS_RECORD = 'This agent has had a registry record since 2026-10-14.';
// The status line of Agent History since the flip of 2026-10-15 (RUNBOOK step 17): the facts in one line, as every file that has a status line gives them. Audio Snippets and Advocate stay PROPOSED (not built).
const AH_STATUS = 'DEPLOYED (registered and staked 2026-10-14, advertised 2026-10-14, re-advertised 2026-10-15 at the status flip, one first-party job settled 2026-10-15). Since 2026-10-15.';
// Document Pipeline is built since 2026-10-15 and not deployed: no registry record, no advert. It is PROPOSED with the qualifier in the line, and the word has stood since 2026-10-13.
const DP_STATUS = 'PROPOSED (built, not deployed). Since 2026-10-13.';
const AGENTS = {
  'agent-history': { capability: 'identity.history.report.v1', model: 'agent-history-v1', status: AH_STATUS, record: HAS_RECORD },
  'document-pipeline': { capability: 'document.pipeline.ocr-summary.v1', model: 'document-pipeline-v1', status: DP_STATUS, record: NO_RECORD },
  'audio-snippets': { capability: 'audio.transcript.snippets.v1', model: 'audio-snippets-v1', status: 'PROPOSED (not built). Since 2026-10-13.', record: NO_RECORD },
  advocate: { capability: 'research.advocate.onesided.v1', model: 'advocate-v1', status: 'PROPOSED (not built). Since 2026-10-13.', record: NO_RECORD },
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

for (const [name, { capability, status, record }] of Object.entries(AGENTS)) {
  test(`${name}: the eleven headings in order, the capability id and the status line`, () => {
    const text = read(name);
    assert.deepEqual([...text.matchAll(/^## (.+)$/gm)].map((m) => m[1]), HEADINGS);
    assert.ok(text.startsWith('# '), 'starts with a title');
    assert.ok(text.split('\n')[2].includes(`\`${capability}\``), 'the first line after the title names the capability id');
    assert.equal(section(text, 'Capability id').split('\n')[1], `\`${capability}\``);
    assert.ok(section(text, 'Status').includes(status), `the status line is "${status}"`);
  });

  test(`${name}: LIVE and DEPLOYED are said under Status and nowhere else, as the status line and the sentence that denies LIVE; no em or en dash, no native unit name`, () => {
    const text = read(name);
    const under = section(text, 'Status');
    // Agent History is DEPLOYED since 2026-10-15 and says that nothing on its page is LIVE. The other three, the Pipeline (built, not deployed) among them, say that nothing is LIVE or DEPLOYED.
    const denial = name === 'agent-history' ? 'Nothing on this page is LIVE.' : 'Nothing on this page is LIVE or DEPLOYED.';
    assert.ok(under.includes(denial), `the Status section says "${denial}"`);
    assert.equal(text.replace(under, '').match(/\b(LIVE|DEPLOYED)\b/g), null, 'not outside the Status section');
    assert.equal(under.replace(denial, '').replace(status, '').match(/\b(LIVE|DEPLOYED)\b/g), null, 'inside it, only the status line and the denial');
    assert.equal(text.match(DASHES), null);
    assert.equal(text.match(UNIT_NAME), null);
  });

  test(`${name}: the Identity section says whether the agent has a registry record, and it does not claim the whole table is absent`, () => {
    const text = read(name);
    const identity = section(text, 'Identity');
    assert.ok(identity.includes(`\n${record}\n`), `the Identity section says "${record}"`);
    assert.equal(identity.includes(record === HAS_RECORD ? NO_RECORD : HAS_RECORD), false, 'and not the other sentence');
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

// Agent History has a registry record and a Module-3 self-stake since 2026-10-14 (RUNBOOK steps 7 and 8), and a public URL in service and an advert since the same day (steps 10 to 14), all run on the box.
// The spec, the guide and the runbooks record them and claim nothing more: one first-party job has settled (2026-10-15, RUNBOOK step 15), which is not demand, and the status word is DEPLOYED since 2026-10-15 (RUNBOOK step 17), never LIVE. The values are the ones the ledger holds for that registration and those adverts.
const AH = {
  did: 'did:vector:agent:be1a0a2912da180757ed3cd61b56bb8eab0188c19dc3c0e3912d2c01:8a98c4b74f0e49a09ca4b3502e121c96a8e6992afd2cba64ef8128042fedd440',
  registerTx: '6da5a2b4435257daf905f92f7ae281446d627aaedee25193cf55d94a547a49fa',
  stakeTx: 'eaf4d43d33da429e0d1072e2f01ae628958dedef97a385bc4d8120b3c8debba7',
  controllerPkh: '1ea22a13acac6da070959317bad9bf5e510e8f7875a6727d3a5262cd',
  // The first advert, posted and confirmed on 2026-10-14 (RUNBOOK step 12), listed Active and free by the marketplace indexer (step 14), and retired on 2026-10-15 at the status flip (step 17, item 2). The first-party run of 2026-10-15 was made against it.
  firstAdvertTx: '13446b05fd40cfac30e3df301748d0cc900b5de1a47582e40a2671107cbc747c',
  firstAdvertRef: '13446b05fd40cfac30e3df301748d0cc900b5de1a47582e40a2671107cbc747c#0',
  retireTx: 'b15761eb6b6df82f9bb29554749960b91b4896ef0081171baa1e2c5b5728cc0c',
  // The current advert, posted and confirmed on 2026-10-15 with the manifest of the status flip (step 17, item 6) and listed Active and free by the marketplace indexer. A reference is the transaction id and the output index.
  advertTx: 'b5185495e775237d795c1f09fdcf6a5787e6b354dd8a304ef2ff8b9d881fba6c',
  advertRef: 'b5185495e775237d795c1f09fdcf6a5787e6b354dd8a304ef2ff8b9d881fba6c#0',
  manifestHash: '251174d556f6f56331a5abc0c343ef9d7277e932511a965ee50f248659b61501',
};
const EXPLORER_TX = 'https://explorer.vector.mainnet.apexfusion.org/transaction/hash/';

test('specs/agent-history.md: the Status line says DEPLOYED since 2026-10-15, the Status paragraph and the Identity sentence say the registry record and the advert exist since 2026-10-14 and one first-party job has settled on 2026-10-15, nothing is LIVE, and the words of before do not come back', () => {
  const text = read('agent-history');
  assert.ok(section(text, 'Status').includes(`\n${AH_STATUS}\n`), 'the status line, alone on its line');
  assert.ok(section(text, 'Status').includes("It is deployed on the operator's host, has had a registry record since 2026-10-14 and has had an advert since 2026-10-14. One first-party job has settled, on 2026-10-15; it is not demand. No payer outside the team has hired it. Nothing on this page is LIVE."));
  assert.equal(section(text, 'Status').match(/PROPOSED|not deployed/), null, 'the words of before the flip do not come back');
  assert.equal(text.match(/no job (has )?settled/i), null, 'the spec does not say that no job settled');
  assert.equal(section(text, 'Status').match(/has no advert|not yet advertised/i), null, 'the Status paragraph and line do not say that the agent has no advert');
  assert.ok(section(text, 'Identity').includes(`\n${HAS_RECORD}\n`));
  // The words of before the registration. The lines a report adds for a subject that has no record ("No registry record found for this subject.") are about other subjects and stay.
  assert.equal(section(text, 'Status').match(/no registry record/i), null, 'the Status paragraph does not say that the agent has no record');
  assert.equal(text.match(/no registry record yet/i), null);
  assert.equal(text.match(/has no DID yet/i), null);
  assert.equal(section(text, 'Identity').match(/not registered|When registered|Registry record, planned|Reputation stake, planned/), null);
  // The Response example was recorded on 2026-10-13, the day before the registration, so its placeholder is explained by the date and not by a missing DID.
  assert.ok(text.includes('`generated_by.did` is shown as a placeholder because the run was made before this agent was registered on 2026-10-14.'));
});

test('specs/agent-history.md: the DID, the registry record and the reputation stake of 2026-10-14 are in the Identity table with their transactions, the URL is in service since 2026-10-14, and the first advert (retired on 2026-10-15) and the current advert (posted on 2026-10-15) are recorded in the Links', () => {
  const text = read('agent-history');
  const row = (label) => section(text, 'Identity').split('\n').find((l) => l.startsWith(`| ${label} |`)) ?? '';
  // The DID has the registry policy of the DID in the Request example and an asset name of 64 hex. The explorer link has the pattern the member guide gives.
  const policy = /did:vector:agent:([0-9a-f]{56}):/.exec(section(text, 'Interface'))?.[1] ?? '';
  assert.match(policy, /^[0-9a-f]{56}$/);
  assert.match(AH.did, new RegExp(`^did:vector:agent:${policy}:[0-9a-f]{64}$`));
  assert.ok(readFileSync(new URL('../docs/HIRE.md', import.meta.url), 'utf8').includes(`${EXPLORER_TX}<txid>`), 'the explorer link pattern');
  assert.equal(row('DID'), `| DID | \`${AH.did}\` |`);
  const record = row('Registry record');
  for (const part of [
    'name `Agent History`', 'description as in the manifest', 'capabilities `identity.history.report.v1`', 'framework `vector-service-agents`', "endpoint the agent's public URL",
    `controller key hash \`${AH.controllerPkh}\` (the supplier key hash)`, 'Registered on 2026-10-14 in the confirmed transaction', `[\`${AH.registerTx}\`](${EXPLORER_TX}${AH.registerTx})`,
    'The deposit is 10000000 lovelace (10.000000), refundable on deregistration',
  ]) assert.ok(record.includes(part), `the Registry record row says: ${part}`);
  const stake = row('Reputation stake');
  for (const part of ['a Module-3 self-stake of 10000000 lovelace (10.000000) on the capability', 'made on 2026-10-14 in transaction', `[\`${AH.stakeTx}\`](${EXPLORER_TX}${AH.stakeTx})`]) assert.ok(stake.includes(part), `the Reputation stake row says: ${part}`);
  assert.notEqual(AH.registerTx, AH.stakeTx, 'two transactions');
  // The URL is in service since 2026-10-14 (RUNBOOK steps 10 to 14), so the row is no longer "planned". The first advert was retired and the current one posted on 2026-10-15 (step 17): the Links keep the first as history and give the current one with its manifest hash. One first-party job settled on 2026-10-15 (step 15).
  assert.equal(row('Public URL'), '| Public URL | `https://mp-suppliers-history.hal8.ai` (in service as of 2026-10-14) |');
  assert.equal(row('Public URL, planned'), '', 'the URL is no longer planned');
  assert.equal(AH.advertRef.split('#')[0], AH.advertTx, 'the transaction id is the reference up to the #');
  assert.equal(AH.firstAdvertRef.split('#')[0], AH.firstAdvertTx);
  for (const hex of [AH.firstAdvertTx, AH.retireTx, AH.advertTx, AH.manifestHash]) assert.match(hex, /^[0-9a-f]{64}$/);
  assert.equal(new Set([AH.firstAdvertTx, AH.retireTx, AH.advertTx]).size, 3, 'three transactions: the first advert, its retirement, the current advert');
  const links = section(text, 'Links');
  assert.ok(links.includes(`- First advert \`${AH.firstAdvertRef}\`, posted on 2026-10-14 in the confirmed transaction [\`${AH.firstAdvertTx}\`](${EXPLORER_TX}${AH.firstAdvertTx}), retired on 2026-10-15 at the status flip in the confirmed transaction [\`${AH.retireTx}\`](${EXPLORER_TX}${AH.retireTx}).`));
  assert.ok(links.includes(`- Current advert \`${AH.advertRef}\`, posted on 2026-10-15 in the confirmed transaction [\`${AH.advertTx}\`](${EXPLORER_TX}${AH.advertTx}), manifest hash \`${AH.manifestHash}\`. The marketplace indexer lists it as Active and free (checked on 2026-10-15).`));
  assert.ok(links.includes("- Manifest: `GET /agent.json` on the agent's public URL, in service as of 2026-10-14."));
  assert.ok(section(text, 'How to hire it').includes('Advertised on 2026-10-14 and again on 2026-10-15, at the status flip: the marketplace indexer lists the current advert as Active and free (checked on 2026-10-15). One first-party job has settled, on 2026-10-15; it is not demand. The three ways below apply.'));
  // The words of before the advert do not come back. The three specs that have no advert keep theirs, and the runbooks quote them as instructions.
  assert.equal(text.match(/none yet|not posted|not in service|not yet advertised|once it is in service/i), null);
});

test('the three specs that have no advert say so under How to hire it; the two that are not built say that nothing is built, and the Pipeline, which is built, gives its release', () => {
  const NOT_YET = 'Not yet advertised. When live, the three ways below apply.';
  for (const name of ['document-pipeline', 'audio-snippets', 'advocate']) assert.ok(section(read(name), 'How to hire it').includes(NOT_YET), name);
  for (const name of ['audio-snippets', 'advocate']) assert.ok(section(read(name), 'Changelog').includes('Nothing is built.'), name);
  // The Pipeline was built on 2026-10-15 and waits for its deployment: its Changelog names the release and the day, and no word of the design is left.
  const pipeline = read('document-pipeline');
  assert.ok(section(pipeline, 'How to hire it').includes(`${NOT_YET} The service is built and waits for its deployment.`));
  assert.equal(section(pipeline, 'Changelog').trim(), '- 0.1.0, 2026-10-15: built');
  assert.equal(pipeline.match(/Nothing is built|None of this is built/), null);
  assert.equal(section(read('agent-history'), 'How to hire it').includes('Not yet advertised'), false, 'Agent History is advertised since 2026-10-14');
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

test('the design spec gives the registry endpoint as the public URL, the one the advert carries, not a service URL', () => {
  assert.ok(DESIGN.includes("endpoint = its public URL (the advert's `endpoint_url`)"));
  assert.equal(DESIGN.match(/endpoint = its service URL/), null);
});

test('the Pipeline states its economics and the first-party OCR hop; the Advocate states its declared bias verbatim', () => {
  const pipeline = read('document-pipeline');
  assert.match(section(pipeline, 'Terms'), /at five pages the Pipeline spends about 19 in locks and fees to earn 5/);
  assert.match(section(pipeline, 'Terms'), /subsidises this on purpose while the fee floor stands/);
  assert.match(section(pipeline, 'Operator and data handling'), /The OCR hop is first-party/);
  // The ChandraOCR registry record says HAL8-operated: the Pipeline's buyer key is the Foundation's, the OCR agent's supplier key is HAL8's.
  assert.match(section(pipeline, 'Operator and data handling'), /the Pipeline's buyer key is Foundation-operated and the OCR agent's supplier key is HAL8-operated/);
  assert.equal(pipeline.match(/both Foundation-operated/), null);
  assert.match(DESIGN, /the Pipeline's buyer key Foundation-operated, the OCR agent's supplier key HAL8-operated/);
  // The hiring rule is stated as an allowlist. No reason about what a backend is made of appears on a public surface.
  assert.ok(section(pipeline, 'Interface').includes("The Pipeline's OCR hop hires only the allowlisted first-party OCR advert."));
  assert.ok(DESIGN.includes("The Pipeline's OCR hop hires only the allowlisted first-party OCR advert."));
  for (const text of [pipeline, DESIGN]) assert.equal(text.match(/subscription|proxy/i), null);
  assert.match(section(pipeline, 'Operator and data handling'), /Direct hire of the OCR agent by outsiders is out of scope for this programme/);
  assert.equal(pipeline.match(/not offered to outsiders/), null); // the OCR advert is Active on the public indexer
  assert.ok(read('advocate').includes('"This brief argues one side only, by design, and omits counter-arguments."'));
  assert.equal(read('advocate').split('This brief argues one side only, by design, and omits counter-arguments.').length - 1, 3); // the rule, the shape and the example
});

// ---- Document Pipeline: built on 2026-10-15, not deployed ----
// The service is built and its tests replay a stub marketplace and a fake chain. It has no registry record and no advert, so the word is PROPOSED, with the qualifier in the line.
// The page says what is built and what is not, and the words of the design that it was before the build do not come back. agents/document-pipeline/test/spec.test.ts holds the rest of the
// page to the code and the manifest: the gap sentences, the numbers, the response example, the error codes.
const DP_PARAGRAPH = 'The service is built. Its tests replay a stub marketplace and a fake chain. It is not deployed, has no registry record and has no advert. Nothing on this page is LIVE or DEPLOYED.';

test('specs/document-pipeline.md: the Status line is PROPOSED (built, not deployed) since 2026-10-13, the paragraph says what is built and what is not, and the words of the design do not come back', () => {
  const text = read('document-pipeline');
  assert.equal(section(text, 'Status').trim(), `${DP_STATUS}\n\n${DP_PARAGRAPH}`);
  assert.equal(text.match(/PROPOSED \(not built\)|This page is a design|There is no code|None of this is built|Illustrative|How it buys \(design\)|No releases|The planned folder|Not built\. Everything/), null, 'the words of before the build do not come back');
  assert.ok(section(text, 'Identity').includes(`\n${NO_RECORD}\n`), 'the agent has no registry record yet');
  const links = section(text, 'Links').split('\n');
  for (const line of [
    '- Manifest: none until deployed. The service renders it from its environment when it starts and serves it at `GET /agent.json`. The template is [agents/document-pipeline/agent.json.template](../agents/document-pipeline/agent.json.template).',
    '- Source: [agents/document-pipeline](../agents/document-pipeline)',
    '- Advert on the explorer: none yet. The advert is not posted.',
  ]) assert.ok(links.includes(line), line);
  for (const path of ['agents/document-pipeline', 'agents/document-pipeline/agent.json.template']) assert.ok(existsSync(new URL(`../${path}`, import.meta.url)), `${path} exists`);
});

// The rules for the extraction schema are the code's (agents/document-pipeline/src/extract.ts): the keywords it refuses, the three bounds, the root $async and the own __proto__.
const EXTRACT_SRC = readFileSync(new URL('../agents/document-pipeline/src/extract.ts', import.meta.url), 'utf8');
const extractNumber = (name) => Number((new RegExp('export const ' + name + ' = ([0-9_]+);').exec(EXTRACT_SRC)?.[1] ?? 'NaN').replaceAll('_', ''));
const extractList = (name) => [...(EXTRACT_SRC.split('\n').find((l) => l.startsWith(`const ${name} = [`)) ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1]);

test('specs/document-pipeline.md: the extraction schema rules name the keywords the code refuses and the bounds it holds, strict draft-07, the cost that is not bounded, and what a schema_valid false result keeps', () => {
  const rules = section(read('document-pipeline'), 'Interface').split('\n### The extraction schema\n')[1]?.split('\n### ')[0] ?? '';
  assert.ok(rules.length > 1500, 'the subsection exists');
  const refused = [...extractList('REFERENCES'), ...extractList('EXPRESSIONS')];
  assert.deepEqual(refused, ['$ref', '$dynamicRef', '$recursiveRef', '$id', '$defs', 'definitions', 'pattern', 'patternProperties', 'format'], 'the keywords of the code');
  const refusedLine = rules.split('\n').find((l) => l.startsWith('- Refused anywhere in the schema:')) ?? '';
  for (const keyword of refused) assert.ok(refusedLine.includes('`' + keyword + '`'), `${keyword} is refused on the page`);
  assert.deepEqual([extractNumber('SCHEMA_MAX_BYTES'), extractNumber('SCHEMA_MAX_DEPTH'), extractNumber('COMBINATION_MAX_ENTRIES')], [16384, 32, 16]);
  for (const part of [
    'a JSON Schema of draft-07, read in strict mode: a keyword the validator does not know is refused.',
    'refused with `schema_invalid` (400), before anything is fetched or posted, so it spends nothing.',
    '- A name is not a keyword. A property called `format` or `pattern` under `properties` is fine, and so are those words inside `const`, `enum`, `default` and `examples`.',
    '- An own `__proto__` key is refused anywhere in the schema, `const`, `enum`, `default` and `examples` included.',
    '- `$async` at the root is refused, `true` or `false`.',
    '- At most 16384 bytes of JSON (the schema as parsed, written out again) and 32 levels of nesting, data included. At most 16 entries in each `anyOf`, `oneOf` and `allOf`.',
    'The cost of a check still grows with the size of the answer times the size of the schema, and `uniqueItems` compares items pairwise.',
    'An answer that is not JSON, or that does not validate against the schema, is not an error. The job succeeds and is paid for, and the result is `{ "extraction": null, "schema_valid": false, "raw_text": "<the answer as received>" }`.',
  ]) assert.ok(rules.includes(part), `the schema rules say: ${part}`);
});

test('the four specs, the guide and the README agree on what is built: Agent History DEPLOYED, Document Pipeline built and PROPOSED, Audio Snippets and Advocate PROPOSED and not built', () => {
  const byStatus = (re) => Object.entries(AGENTS).filter(([, a]) => re.test(a.status)).map(([name]) => name).sort();
  assert.deepEqual(byStatus(/^DEPLOYED \(/), ['agent-history']);
  assert.deepEqual(byStatus(/^PROPOSED \(built, not deployed\)\./), ['document-pipeline']);
  assert.deepEqual(byStatus(/^PROPOSED \(not built\)\./), ['advocate', 'audio-snippets']);
  // Each spec carries its own status line in its Status section, alone on a line, and the two that are not built keep the line they had.
  for (const [name, { status }] of Object.entries(AGENTS)) assert.ok(section(read(name), 'Status').split('\n').includes(status), `${name}: the status line, alone on its line`);
  for (const name of ['audio-snippets', 'advocate']) assert.equal(section(read(name), 'Status').split('\n').filter((l) => l.startsWith('PROPOSED')).join(''), 'PROPOSED (not built). Since 2026-10-13.', `${name} keeps its line`);
  // The guide says it in a sentence, and the root README keeps its table: DEPLOYED for Agent History, PROPOSED for the other three.
  assert.ok(hire().includes('Document Pipeline is built and waits for its deployment. Audio Snippets and Advocate are specified and not built.'));
  const tableRows = readFileSync(new URL('../README.md', import.meta.url), 'utf8').split('\n');
  for (const [name, { capability }] of Object.entries(AGENTS)) assert.ok(tableRows.some((l) => l.endsWith(`| \`${capability}\` | ${name === 'agent-history' ? 'DEPLOYED' : 'PROPOSED'} |`)), `${name}: its row of the README table`);
});

// ---- The member guide (docs/HIRE.md) and the E2E runbook (docs/E2E.md) ----
// They are read by people who act on them, so their numbers, tool names and wording are pinned here against the specs and the design.
const doc = (name) => readFileSync(new URL(`../docs/${name}`, import.meta.url), 'utf8');
const hire = () => doc('HIRE.md');
const e2eScript = () => readFileSync(new URL('./e2e-hire.mjs', import.meta.url), 'utf8');
const HIRE_SECTIONS = ['What you will end up with', 'Get a key', 'Fund it', 'Two lines of config', 'The chat script', 'Read your receipt', 'Register your own identifier (optional)', 'The terminal path', 'When it goes wrong', 'Honesty box'];
const CHAT_SCRIPT = [
  '1. "List the marketplace capabilities on Vector."',
  '2. "Show me free suppliers for identity.history.report.v1."',
  '3. "Hire the first one. Payload: {"subject":"did:vector:agent:be1a0a2912da180757ed3cd61b56bb8eab0188c19dc3c0e3912d2c01:5542837bc3a6ccd66cb75ac91a796cf5716d439f4a72594bbfc06db7231029db"}. Use my signer address as changeAddress, sign, submit and wait for confirmation."',
  '4. "Send the job with the same payload, then poll until it is done. Use my signer address as buyerAddress in both calls."',
  '5. "Verify the receipt. If every check passes, accept, sign, submit and wait."',
  '6. "Show me the receipt, the signature, the escrow reference and explorer links for the post and the accept."',
];
// The nine marketplace tools are read from the design spec, so a renamed tool fails here before it fails in a member's chat.
const MARKETPLACE_TOOLS = [...new Set(DESIGN.match(/\bvector_(?:build_)?marketplace_[a-z_]+/g))].sort();
const OTHER_TOOLS = ['vector_signer_get_address', 'vector_signer_decode_transaction', 'vector_signer_sign', 'vector_signer_get_spend_limits', 'vector_submit_transaction', 'vector_await_transaction', 'vector_build_register_agent', 'vector_build_deregister_agent', 'vector_get_utxos', 'vector_get_balance'];
const designEndpoint = (label) => new RegExp(label + ' `([^`]+)`').exec(DESIGN)?.[1];
const AGENT_SPEC = { 'Agent History': 'agent-history', 'Audio Snippets': 'audio-snippets', Advocate: 'advocate', 'Document Pipeline': 'document-pipeline' };
// What the guide, the runbooks, the script and the four specs said until 2026-10-14, when the nine tools were seen on the hosted mainnet server: a wait for a cutover,
// 24 tools, none of the nine on the server. None of it may be written again, so one pattern is held against all of them (see the last test of this file).
const WAITS_FOR_CUTOVER = /cutover|cut over|cuts it over|24 tools|none of them a marketplace tool|none of the marketplace tools|awaiting the|merged, awaiting|has them only after|still serves/i;

test('docs/HIRE.md: the ten sections of the design, numbered, in the order the member does them; the first paragraph says the guide is for anyone with a chat client and a key, written for a working-group member first', () => {
  assert.deepEqual([...hire().matchAll(/^## (\d+)\. (.+)$/gm)].map((m) => [Number(m[1]), m[2]]), HIRE_SECTIONS.map((title, i) => [i + 1, title]));
  assert.ok(hire().startsWith('# '), 'starts with a title');
  assert.ok(hire().split('\n')[2].startsWith('A guide for anyone with a chat client and a key. It was written for a working-group member first. You use a chat client that has two MCP servers connected'), 'the first paragraph');
  assert.equal(hire().match(/A guide for a working-group member/), null, 'the words of before');
});

test('docs/HIRE.md: the chat script is verbatim, six lines in one block, inside section 5', () => {
  const five = section(hire(), '5. The chat script');
  assert.ok(five.includes('```text\n' + CHAT_SCRIPT.join('\n') + '\n```'), 'the six lines, in order, in one fenced block');
});

// The guide has two request JSONs: message 3 of the chat script (Agent History's, a subject) and the one for Document Pipeline in the subsection of section 5 (a one-page PDF by URL).
test('docs/HIRE.md: says that Document Pipeline is built and waits for its deployment; section 5 gives it a second request JSON, the 30 min wait and the time to reclaim', () => {
  const guide = hire();
  assert.ok(guide.includes('Document Pipeline is built and waits for its deployment. Audio Snippets and Advocate are specified and not built. This guide hires Agent History, and section 5 shows what changes for Document Pipeline once it has an advert.'));
  assert.equal(guide.match(/Three more agents are specified and not built/), null, 'the sentence of before the build');
  const five = section(guide, '5. The chat script');
  const heading = '\n### The same script for Document Pipeline\n';
  assert.ok(five.indexOf(heading) > five.indexOf('If a check fails, do not accept.'), 'a subsection at the end of section 5');
  const sub = five.split(heading)[1] ?? '';
  const first = JSON.parse(/Payload: (\{"subject":"[^"]+"\})\./.exec(CHAT_SCRIPT[2])[1]);
  const blocks = [...sub.matchAll(/```json\n([\s\S]*?)\n```/g)].map((m) => m[1]);
  assert.equal(blocks.length, 1, 'one request JSON in the subsection');
  const second = JSON.parse(blocks[0]);
  assert.deepEqual(Object.keys(first), ['subject']);
  assert.deepEqual(second, { source: { url: 'https://example.org/letter.pdf' }, task: 'summary', language: 'en', max_pages: 1 });
  for (const part of [
    'It has no advert yet, so message 2 shows no supplier for it until the operator posts one.',
    'Ask for `document.pipeline.ocr-summary.v1` in message 2, and write this request JSON in messages 3 and 4:',
    'That URL is only an example. Use the https URL of a one-page PDF that anyone may read: its page goes to the OCR agent, and its text to the chat supplier and that supplier\'s model provider. The service fetches the URL itself, so it must be public and must not redirect.',
    'Its processing window is 30 min, so message 4 can wait that long: ask your assistant to poll again whenever a call is cut near 100 s, as in section 9.',
    'If the job fails, you reclaim after `deliver_by`, which is your Post time plus 30 min plus 180 s.',
    'The price is 5 and a job costs about 7 (the cost table in section 3).',
  ]) assert.ok(sub.includes(part), `the subsection says: ${part}`);
  // The wait is the advert's window in the spec, and the reclaim time is that window plus the 180 s of every deliver_by.
  assert.match(section(read('document-pipeline'), 'Terms'), /Processing window, advert `max_processing_ms` \| 1800000 ms \(30 min/);
  assert.ok(sub.indexOf('document.pipeline.ocr-summary.v1') > sub.indexOf('It has no advert yet'), 'the capability is asked for after the honest line');
  assert.ok(section(hire(), '3. Fund it').split('\n').some((l) => l.startsWith('| 5 (Document Pipeline) | 7 | 6 | 1 | about 1 | about 7 | 7 |')), 'the cost table row the subsection points to');
});

test('docs/HIRE.md: the ledger unit is named once, in section 3, and nowhere else in the repo', () => {
  const guide = hire();
  assert.equal(guide.match(UNIT_NAME)?.length, 1);
  assert.ok(section(guide, '3. Fund it').includes("the ledger's native unit, " + UNIT_NAME.source));
  // Every other file of the repo says "unit" or prints lovelace. The planning documents and the recorded ledger data are not part of this rule.
  const root = fileURLToPath(new URL('../', import.meta.url));
  // The run outputs of docs/E2E.md (git-ignored, repository root) are an operator's files, not the repository: skipped.
  const runOutput = (rel) => /^(evidence\.json(\.tmp)?|e2e-state[^\/]*\.json[^\/]*)$/.test(rel);
  const skip = (rel) => runOutput(rel) || /(^|[\\/])(node_modules|\.git|\.superpowers)([\\/]|$)/.test(rel) || /(^|[\\/])test[\\/]fixtures([\\/]|$)/.test(rel) || rel.startsWith(join('docs', 'superpowers')) || rel === 'pnpm-lock.yaml';
  const walk = (dir, out = []) => { for (const e of readdirSync(dir, { withFileTypes: true })) { const p = join(dir, e.name); if (skip(relative(root, p))) continue; e.isDirectory() ? walk(p, out) : out.push(relative(root, p)); } return out; };
  const hits = walk(root).filter((rel) => /\.(ts|mjs|json|md|yml|yaml|template)$/.test(rel) && rel !== join('docs', 'HIRE.md')).filter((rel) => readFileSync(join(root, rel), 'utf8').match(UNIT_NAME));
  assert.deepEqual(hits, []);
});

// Section 3 of the guide has two ways to fund the key since 2026-10-15. The Foundation's way is the text of before, kept word for word (the one sentence that names the unit is in it). The reader's own way says what a key funded by hand needs.
const FOUNDATION_WAY = "The Foundation funds working-group experiments. It sends your address two separate transfers: 5 units alone, then a float of 50. They stay separate on purpose. The Accept and the Reclaim are script spends, and each needs a pure 5-unit output as collateral. The Post keeps a pure 5-unit output aside when your wallet has one. A single lump sum lets your wallet spend it. Fees and bonds are paid in the ledger's native unit, " + UNIT_NAME.source + '. The name appears once, here. The rest of this guide calls it a unit.';

test('docs/HIRE.md section 3: two ways to fund the key, the Foundation way kept word for word, the own way says Vector mainnet, a key from keygen only and 5 alone before the float; the cost table and the check come after both', () => {
  const three = section(hire(), '3. Fund it');
  const at = (needle) => { const i = three.indexOf(needle); assert.ok(i >= 0, `section 3 says: ${needle}`); return i; };
  const order = ['There are two ways to fund your key. The cost table and the check below apply to both.', "**(a) The Foundation funds a working-group member's key, on request.**", FOUNDATION_WAY, '**(b) Or fund it yourself.**', 'What one job costs you.', '| Price (agent) |', 'Check the funding before you go on.', '(`vector_get_utxos`)'];
  const positions = order.map(at);
  assert.deepEqual(positions, [...positions].sort((a, b) => a - b), 'the intro, the Foundation way, the own way, the cost, the table and the check: in this order');
  const own = three.slice(at('**(b) Or fund it yourself.**'), at('What one job costs you.'));
  for (const part of [
    'The units must be on Vector mainnet.',
    'Units on Prime, on Nexus or in a bridged form elsewhere cannot fund your key.',
    'The Reactor bridge moves units from Prime to Vector.',
    "The signer accepts only a key made by `keygen`. It does not take a wallet's recovery phrase, so a wallet's balance has to be sent to the address `keygen` printed.",
    'Send 5 alone first, then the float of 50. That is two transfers, for the reason given in (a).',
  ]) assert.ok(own.includes(part), `the own way says: ${part}`);
  assert.equal(own.match(UNIT_NAME), null, 'the own way says units, the name is in the Foundation way');
  assert.equal(hire().match(/We fund it/), null, 'the title of before');
});

test('docs/HIRE.md and docs/E2E.md: no em or en dash; nothing says LIVE except the sentence that denies it; DEPLOYED only in the status paragraph of each and in the Agent History row of the guide', () => {
  for (const name of ['HIRE.md', 'E2E.md']) assert.equal(doc(name).match(DASHES), null, name);
  const guide = hire();
  const e2e = doc('E2E.md');
  assert.ok(guide.includes('Nothing in this guide is LIVE.'));
  assert.equal(guide.replace('Nothing in this guide is LIVE.', '').match(/\bLIVE\b/g), null);
  assert.equal(e2e.match(/\bLIVE\b/g), null);
  // DEPLOYED is said where the status of the agent is given: the status paragraph of each document and the row of the guide's table. Nowhere else, and each place gives the facts in the same words.
  const statusOf = (text) => text.split('\n').find((l) => l.startsWith('**Status: ')) ?? '';
  const row = guide.split('\n').find((l) => l.startsWith('| Agent History, capability ')) ?? '';
  assert.ok(statusOf(guide).startsWith(`**Status: DEPLOYED.** Agent History is ${AH_STATUS} Nothing in this guide is LIVE. `));
  assert.ok(statusOf(e2e).startsWith(`**Status: DEPLOYED.** Agent History is ${AH_STATUS} The path is proven first-party, which is not demand. `));
  assert.ok(row.includes(`| ${AH_STATUS} `));
  assert.equal(guide.replace(statusOf(guide), '').replace(row, '').match(/\bDEPLOYED\b/g), null);
  assert.equal(e2e.replace(statusOf(e2e), '').match(/\bDEPLOYED\b/g), null);
});

test('docs/HIRE.md: the request JSON and the wire payload are named apart, as in the specs', () => {
  const five = section(hire(), '5. The chat script');
  assert.ok(five.includes(WIRE_PAYLOAD), 'section 5 defines the wire payload');
  assert.match(five, /wrap the request JSON into the wire payload/);
  assert.equal(hire().match(/payload is the request JSON/i), null);
  assert.match(section(hire(), '8. The terminal path'), /holds the request JSON, and the buyer wraps it into the wire payload/);
});

// Only the buyer's bond comes back on Accept. The supplier receives the price and the supplier bond, and a Release hands the supplier everything that is locked.
// These phrasings say otherwise: both bonds returning, a bond "returned", the supplier getting its own bond back.
const BONDS_RETURN = /both bonds (return|come back|are returned)|bonds? (are )?returned|returned on accept|bonds back|own bond|its bond back/i;

test('docs/HIRE.md: who receives what on Accept, Release and Reclaim', () => {
  const three = section(hire(), '3. Fund it');
  assert.ok(three.includes('On Accept the supplier receives the price and the supplier bond, and your bond returns to you.'));
  // One sentence, one unit: the Accept window is 600 s, and a Release hands the supplier everything that is locked, the buyer bond included.
  assert.ok(three.includes("If you do not accept within 600 s of the supplier's Submit, the supplier may Release the escrow and keep everything that is locked: the price and both bonds, your buyer bond included."));
  assert.equal(three.match(/may Release/g)?.length, 1, 'said once');
  assert.equal(hire().match(/\b600000 ms\b/), null, 'the guide gives the window in seconds everywhere');
  assert.ok(three.includes('If the supplier never submits, you reclaim the price and both bonds after `deliver_by`.'));
});

test('the guide, the four specs and the E2E runbook never say that both bonds return or that the supplier gets a bond back', () => {
  const texts = [['docs/HIRE.md', hire()], ['docs/E2E.md', doc('E2E.md')], ...Object.keys(AGENTS).map((name) => [`specs/${name}.md`, read(name)])];
  assert.equal(texts.length, 6);
  for (const [name, text] of texts) assert.equal(text.match(BONDS_RETURN), null, name);
  // The pattern finds each wording it exists for, among them the sentence that was wrong in specs/agent-history.md.
  for (const wrong of ['On Accept the supplier is paid the price and gets its own bond back.', 'the supplier gets its bond back', 'both bonds return', 'both bonds come back', 'the bonds are returned', 'returned on Accept', 'the bonds back']) assert.match(wrong, BONDS_RETURN, wrong);
  for (const right of ["the buyer's bond returns to the buyer", 'your bond returns to you', 'your bond of 1 comes back']) assert.doesNotMatch(right, BONDS_RETURN, right);
});

test('specs/agent-history.md: on Accept the supplier receives the price and the supplier bond, and the buyer bond returns to the buyer', () => {
  const terms = section(read('agent-history'), 'Terms');
  assert.ok(terms.includes("On Accept the supplier receives the price and the supplier bond, and the buyer's bond returns to the buyer."));
  assert.ok(terms.includes('the supplier may Release the escrow and take the payment and both bonds'));
  assert.ok(terms.includes('If the supplier never submits, the buyer reclaims after `deliver_by`.'));
});

test('docs/HIRE.md: the cost table is the escrow arithmetic, with the prices of the four specs', () => {
  const rows = [...section(hire(), '3. Fund it').matchAll(/^\| (\d+) \(([^)]+)\) \| (\d+) \| (\d+) \| (\d+) \| about (\d+) \| about (\d+) \| (\d+) \|$/gm)];
  assert.deepEqual(rows.map((m) => m[2]).sort(), Object.keys(AGENT_SPEC).sort(), 'one row for each agent');
  for (const [, price, agent, lock, supplier, back, fees, pay, jobs] of rows) {
    const terms = section(read(AGENT_SPEC[agent]), 'Terms');
    const unit = (label) => Number(terms.match(new RegExp('[|] ' + label + ' [|] ([0-9]+) '))?.[1]) / 1_000_000;
    assert.equal(Number(price), unit('Price'), `${agent}: the price of the spec`);
    assert.equal(Number(lock), unit('Locked by the buyer [(]price and both bonds[)]'), `${agent}: the lock is price plus both bonds`);
    assert.equal(Number(supplier), unit('Price') + unit('Supplier bond'), `${agent}: the supplier receives the price and the supplier bond`);
    assert.equal(Number(back), unit('Buyer bond'), `${agent}: only the buyer bond comes back`);
    assert.equal(Number(fees), 1, `${agent}: fees about 1 across Post and Accept`);
    assert.equal(Number(pay), Number(lock) - Number(back) + Number(fees), `${agent}: what an accepted job costs the buyer`);
    assert.equal(Number(jobs), Math.floor(50 / Number(pay)), `${agent}: accepted jobs per float of 50`);
  }
});

test('docs/HIRE.md and the design agree on the figures a member types or reads', () => {
  const guide = hire();
  assert.ok(guide.includes(designEndpoint('MCP')), 'the hosted server URL');
  assert.ok(guide.includes(designEndpoint('Ogmios')), 'the Ogmios URL of the terminal path');
  assert.ok(guide.includes(`VECTOR_ZERO_TIME_MS=${DESIGN.match(/Zero time[^|]*[|] `(\d+)`/)[1]}`), 'the genesis time of the terminal path');
  assert.ok(guide.includes('https://explorer.vector.mainnet.apexfusion.org/transaction/hash/<txid>'), 'the explorer link pattern');
  assert.match(DESIGN, /per-transaction cap 100, daily cap 500/);
  assert.ok(guide.includes('"VECTOR_SIGNER_SPEND_LIMIT_PER_TX": "100000000"') && guide.includes('"VECTOR_SIGNER_SPEND_LIMIT_DAILY": "500000000"'), '100 and 500 units, as lovelace');
  assert.ok(guide.includes('c4c378a'), 'the pinned template commit');
  for (const flag of ['--advert-ref', '--endpoint', '--payload-file']) assert.ok(guide.includes(flag), flag);
});

test('docs/HIRE.md: says what is and is not in service, tool by tool', () => {
  const guide = hire();
  assert.equal(MARKETPLACE_TOOLS.length, 9);
  for (const tool of MARKETPLACE_TOOLS) assert.ok(guide.includes('`' + tool + '`'), tool);
  const row = (needle) => guide.split('\n').find((l) => l.startsWith('|') && l.includes(needle)) ?? '';
  // The nine tools are merged into main (2026-10-14) and are on the hosted mainnet server (33 tools, seen with an MCP handshake the same day): said for each PR, with its link.
  const onServer = 'merged into `main` on 2026-10-14, on the hosted mainnet server: ';
  assert.ok(row('vector_marketplace_list_capabilities').includes('PR 1, ' + onServer + '[Apex-Fusion/mcp-server#20](https://github.com/Apex-Fusion/mcp-server/pull/20)'));
  assert.ok(row('vector_build_marketplace_post_escrow').includes('PR 2, ' + onServer + '[Apex-Fusion/mcp-server#21](https://github.com/Apex-Fusion/mcp-server/pull/21)'));
  assert.ok(row('vector_marketplace_send_job').includes('PR 3, merged into `main` on 2026-10-14 with PR 2, on the hosted mainnet server: [Apex-Fusion/mcp-server#23](https://github.com/Apex-Fusion/mcp-server/pull/23)'));
  assert.match(row('@apexfusion/vector-mcp-signer'), /PR 4, merged into `main` on 2026-10-14: \[Apex-Fusion\/mcp-server#22\]\(https:\/\/github.com\/Apex-Fusion\/mcp-server\/pull\/22\)\. The package is not published/);
  // Agent History is DEPLOYED since 2026-10-15 (RUNBOOK step 17): the row gives the facts and the current advert reference in full, and says the URL is in service. It does not name the retired advert.
  const agentRow = row('identity.history.report.v1');
  assert.ok(agentRow.includes(`| ${AH_STATUS} The advert reference is \`${AH.advertRef}\`, listed as Active and free on 2026-10-15.`));
  assert.ok(agentRow.includes('The public URL, `https://mp-suppliers-history.hal8.ai`, is in service as of 2026-10-14.'));
  assert.equal(agentRow.includes(AH.firstAdvertTx), false, 'the retired advert is not the one the guide gives');
  assert.equal(guide.match(/<ADVERT_REF>|placeholder|not yet advertised|not in service/i), null, 'the words of before the advert');
  assert.ok(row('mcp.vector.mainnet.apexfusion.org').includes('Running, v2.0.0, 33 tools. All nine marketplace tools are on it, checked on 2026-10-14 with an MCP `initialize` and `tools/list` handshake. One first-party run of the path is recorded, made on 2026-10-15, see [docs/E2E.md](E2E.md).'));
  assert.match(row('Hosted testnet instance'), /Updates itself from `main`, so it lists the marketplace tools\. It reads the mainnet marketplace indexer with the testnet Koios/);
  assert.equal(guide.match(/Open PR 1|PR 2 open|PR 3, planned|PR 4, planned|stacked on #20/), null, 'the statuses of before the merge');
  assert.equal(guide.match(WAITS_FOR_CUTOVER), null, 'nothing in the guide waits for a cutover');
});

test('docs/HIRE.md, docs/E2E.md and scripts/e2e-hire.mjs: every tool named is in the design or on the hosted server today', () => {
  const known = new Set([...MARKETPLACE_TOOLS, ...OTHER_TOOLS]);
  for (const [name, text] of [['docs/HIRE.md', hire()], ['docs/E2E.md', doc('E2E.md')], ['scripts/e2e-hire.mjs', e2eScript()]]) {
    const unknown = [...new Set(text.match(/\bvector_[a-z_]+/g) ?? [])].filter((t) => !known.has(t));
    assert.deepEqual(unknown, [], `${name} names a tool that is not known`);
  }
  for (const tool of MARKETPLACE_TOOLS) assert.ok(e2eScript().includes(tool), `the script uses ${tool}`);
});

test('docs/E2E.md: every run is marked first-party, the commands are exact, and every setting the script reads is explained', () => {
  const e2e = doc('E2E.md');
  assert.ok(e2e.startsWith('# '), 'starts with a title');
  assert.match(e2e, /first-party/);
  assert.ok(e2e.includes('node scripts/e2e-hire.mjs --dry-run') && e2e.includes('node scripts/e2e-hire.mjs\n'));
  const table = e2e.split('\n').filter((l) => l.startsWith('|'));
  const results = table.slice(table.findIndex((l) => l.startsWith('| Date |')));
  assert.equal(results[0], '| Date | Agent | Run | Escrow reference | Post transaction | Accept transaction | Verdict |');
  for (const row of results.slice(2)) {
    assert.equal(row.split('|')[3].trim(), 'first-party', `a run row says first-party: ${row}`);
    assert.ok(Object.keys(AGENT_SPEC).includes(row.split('|')[2].trim()), `a run row names the agent that was hired: ${row}`);
  }
  const settings = [...new Set([...e2eScript().matchAll(/\benv\.([A-Z][A-Z0-9_]+)/g), ...e2eScript().matchAll(/need\('([A-Z][A-Z0-9_]+)'\)/g)].map((m) => m[1]))];
  assert.ok(settings.length >= 5, 'the script reads its settings from the environment');
  for (const name of settings) assert.ok(e2e.includes('`' + name + '`'), `docs/E2E.md explains ${name}`);
});

// The script takes the capability as a setting (ruling R49), so the first-party run of Document Pipeline uses the same script as Agent History's: docs/E2E.md says which settings change.
test('docs/E2E.md: CAPABILITY_ID is a setting with its default and the Pipeline\'s value, step 3 names it, and the Results table has an Agent column', () => {
  const e2e = doc('E2E.md');
  const script = e2eScript();
  assert.ok(script.includes("const DEFAULT_CAPABILITY = 'identity.history.report.v1';") && script.includes('const CAPABILITY = env.CAPABILITY_ID ?? DEFAULT_CAPABILITY;'), 'the default and the setting');
  assert.ok(script.includes('is not among the free suppliers for ${CAPABILITY}') && script.includes("capability_id: CAPABILITY, limit: 50"), 'the free list and the stop use it');
  const rows = e2e.split('\n').filter((l) => l.startsWith('| `'));
  const names = rows.map((l) => l.split('`')[1]);
  assert.equal(names.indexOf('CAPABILITY_ID'), names.indexOf('ADVERT_REF') + 1, 'the row follows ADVERT_REF');
  assert.equal(names.indexOf('PAYLOAD'), names.indexOf('CAPABILITY_ID') + 1, 'and the row of PAYLOAD follows it');
  const row = rows.find((l) => l.startsWith('| `CAPABILITY_ID` |')) ?? '';
  for (const part of [
    'The capability of the advert, as the marketplace lists it. Default: `identity.history.report.v1`, the capability of Agent History.',
    'stops unless `ADVERT_REF` is among them, so an advert of another agent needs its own value: `document.pipeline.ocr-summary.v1` for Document Pipeline.',
    'An empty value, or one with a space in it, stops the script with exit code 2.',
  ]) assert.ok(row.includes(part), `the CAPABILITY_ID row says: ${part}`);
  assert.ok(rows.find((l) => l.startsWith('| `ADVERT_REF` |')).includes('It must be among the free suppliers of `CAPABILITY_ID`, or the script stops.'));
  assert.ok(rows.find((l) => l.startsWith('| `PAYLOAD` |')).includes('For Document Pipeline, a request for one page of a PDF by URL, as under "Hiring Document Pipeline".'));
  assert.ok(e2e.includes('3. Reads the free suppliers of `CAPABILITY_ID` (default `identity.history.report.v1`) with `vector_marketplace_list_suppliers`, and stops unless `ADVERT_REF` is among them.'));
  assert.equal(e2e.includes('3. Reads the free suppliers of `identity.history.report.v1` with'), false, 'step 3 of before');
  assert.ok(e2e.includes('The Agent column names the agent that was hired, and the Run column says first-party in every row.'));
});

test('docs/E2E.md: the section "Hiring Document Pipeline" gives the settings of its first-party run: its capability, a request for one page of a PDF by URL, a pause of 15 s, a state file of its own, up to 10 minutes', () => {
  const e2e = doc('E2E.md');
  const sec = section(e2e, 'Hiring Document Pipeline');
  assert.ok(sec.length > 900, 'the section exists');
  assert.ok(e2e.indexOf('\n## Hiring Document Pipeline\n') > e2e.indexOf('\n## The commands\n') && e2e.indexOf('\n## Hiring Document Pipeline\n') < e2e.indexOf('\n## What the script does\n'), 'after the commands, before the steps');
  const exported = Object.fromEntries((/```bash\n([\s\S]*?)\n```/.exec(sec)?.[1] ?? '').split('\n').map((l) => /^export ([A-Z0-9_]+)=(.*)$/.exec(l)).map((m) => [m[1], m[2]]));
  assert.deepEqual(Object.keys(exported), ['CAPABILITY_ID', 'ADVERT_REF', 'PAYLOAD', 'E2E_POLL_MS', 'E2E_STATE']);
  assert.equal(exported.CAPABILITY_ID, AGENTS['document-pipeline'].capability);
  assert.equal(exported.E2E_POLL_MS, '15000');
  assert.equal(exported.E2E_STATE, './e2e-state-pipeline.json');
  assert.equal(exported.ADVERT_REF, '<txid>#<index>');
  assert.ok(exported.PAYLOAD.startsWith("'") && exported.PAYLOAD.endsWith("'"), 'the request JSON is quoted for the shell');
  assert.deepEqual(JSON.parse(exported.PAYLOAD.slice(1, -1).replace('<https URL of a one-page public PDF>', 'https://example.org/letter.pdf')), { source: { url: 'https://example.org/letter.pdf' }, task: 'summary', language: 'en', max_pages: 1 });
  for (const part of [
    'The script hires any agent whose advert is among the free suppliers of `CAPABILITY_ID`, with the same steps. Document Pipeline has no advert yet.',
    'Use a document that anyone may read: its page goes to the OCR agent, and Datalab behind it, and its text to the chat supplier and that supplier\'s model provider.',
    'a job takes minutes where Agent History\'s takes seconds, and the default pause of 5 s would ask the hosted server about 120 times in 10 minutes.',
    'a state file belongs to one run, and the script refuses one that belongs to another, so this run does not use the file of the Agent History run.',
    'Expect up to 10 minutes for one page. The script polls until `deliver_by`, which is 33 minutes after the Post (the 30 min window and 180 s). Five pages take up to 27 min.',
    'Then run the rehearsal and the run as above. With the key-file wrapper, export these settings in the shell first: it passes the environment on, and its default `ADVERT_REF` is the Agent History advert.',
    'Add the run to the Results table with Document Pipeline in the Agent column. It is first-party and it is not demand.',
  ]) assert.ok(sec.includes(part), `the section says: ${part}`);
  // The wrapper does what the section says: it exports a default for ADVERT_REF only, and the script inherits the rest of the environment.
  const wrapper = readFileSync(new URL('./run-e2e-from-keyfile.sh', import.meta.url), 'utf8');
  assert.ok(wrapper.includes('export ADVERT_REF="${ADVERT_REF:-'));
  assert.equal(/^\s*(export\s+)?CAPABILITY_ID=/m.test(wrapper), false, 'the wrapper sets no capability of its own: CAPABILITY_ID comes from the environment');
  // The pause that the section calls the default is the one the script has, read from it: 10 minutes at that pause ask the hosted server about 120 times.
  const pause = Number(/POLL_MS = env\.E2E_POLL_MS === undefined \? (\d+) :/.exec(e2eScript())?.[1]);
  assert.equal(Math.round(10 * 60 * 1000 / pause), 120);
});

test('docs/E2E.md and scripts/run-e2e-from-keyfile.sh: the runbook opens for every agent, the state file is the one E2E_STATE names, and the wrapper says so when a run stops', () => {
  const e2e = doc('E2E.md');
  const wrapper = readFileSync(new URL('./run-e2e-from-keyfile.sh', import.meta.url), 'utf8');
  assert.ok(e2e.split('\n')[2].startsWith('Before any working-group member is invited, the operator hires each of our agents itself, through the same tools a member will use. Agent History comes first, and Document Pipeline follows when it has an advert (see "Hiring Document Pipeline").'));
  assert.equal(e2e.split('\n')[2].includes('hires Agent History itself'), false, 'the opening of before the second agent');
  assert.ok(e2e.includes('A run of Agent History costs about 3 of the float, and a run of Document Pipeline about 7 (see the cost table in [HIRE.md](HIRE.md)).'));
  assert.ok(e2e.includes('and the state file is the one `E2E_STATE` names (`e2e-state.json` by default), as above.'));
  assert.equal(e2e.includes('and the state file is `e2e-state.json`, as above'), false, 'the Pipeline run names a state file of its own');
  assert.ok(wrapper.includes('echo "run stopped with exit code $rc (state kept in ${E2E_STATE:-e2e-state.json})" >&2'));
  assert.equal(wrapper.includes('(state kept in e2e-state.json)'), false);
  assert.ok(wrapper.includes('it and the state file (e2e-state.json, or the file E2E_STATE names) are git-ignored.'));
  assert.ok(wrapper.includes('CAPABILITY_ID, E2E_STATE, E2E_POLL_MS and PAYLOAD pass through from the environment'));
  // The wrapper has a default for ADVERT_REF and none for SIGNER_ENTRY: it stops when SIGNER_ENTRY is not set, and when it names no file.
  assert.ok(wrapper.includes(': "${SIGNER_ENTRY:?set SIGNER_ENTRY to the built signer,'));
  assert.ok(wrapper.includes('[ -f "$SIGNER_ENTRY" ] || { echo "signer build not found: $SIGNER_ENTRY" >&2; exit 2; }'));
  assert.ok(e2e.includes('`SIGNER_ENTRY` and `ADVERT_REF` come from the environment, as the table says. The wrapper has a default for `ADVERT_REF`, the Agent History advert, and none for `SIGNER_ENTRY`: it stops when `SIGNER_ENTRY` is not set, and with exit code 2 when it names no file.'));
  assert.equal(e2e.includes('The wrapper has a default for each'), false, 'the sentence of before, which gave SIGNER_ENTRY a default');
  // The default in the message is the script's own, and git ignores both files, the state file of the Pipeline run included.
  assert.ok(e2eScript().includes("env.E2E_STATE ?? 'e2e-state.json'"));
  const ignored = readFileSync(new URL('../.gitignore', import.meta.url), 'utf8').split('\n');
  const glob = (pattern) => new RegExp('^' + pattern.split('*').map((s) => s.replace(/[.]/g, '[.]')).join('.*') + '$');
  assert.ok(ignored.includes('evidence.json') && ignored.includes('e2e-state*.json*'));
  for (const file of ['e2e-state.json', 'e2e-state-pipeline.json']) assert.ok(glob('e2e-state*.json*').test(file), `${file} is ignored`);
});

test('docs/HIRE.md and docs/E2E.md: every place that lists what the receipt check takes lists the report text', () => {
  for (const [name, body] of [['docs/HIRE.md', hire()], ['docs/E2E.md', doc('E2E.md')]]) {
    // A line that talks about running or repeating the check and names the signature and the escrow reference lists its inputs. Without the report text the response-hash check does not run.
    const lists = body.split('\n').filter((l) => /verify_receipt|repeat it/.test(l) && /signature/.test(l) && /escrow/.test(l));
    assert.ok(lists.length >= 1, `${name} lists the inputs of the check`);
    for (const l of lists) assert.match(l, /report text|`result`/, `${name}: ${l.slice(0, 100)}`);
  }
});

test('docs/HIRE.md: the status box says what runs today and that there is no audit; the client config file is said to hold the key in plain text', () => {
  const guide = hire();
  const line = 'The hosted mainnet server is running with 33 tools as of 2026-10-14, and all nine marketplace tools are on it. No third-party audit of the marketplace contracts exists.';
  assert.equal(guide.split(line).length - 1, 1, 'once');
  assert.ok(guide.indexOf('**Status: DEPLOYED.**') < guide.indexOf(line) && guide.indexOf(line) < guide.indexOf('| Piece |'), 'inside the status box, above the table');
  const four = section(guide, '4. Two lines of config');
  assert.ok(four.includes('The client config file now holds the raw signer key in plain text.'));
  assert.match(four, /can sign with the key and spend what it holds/);
  assert.ok(four.indexOf('in plain text') > four.indexOf('```json') && four.indexOf('in plain text') < four.indexOf('The two limits'), 'after the config, before the limits');
});

test('docs/HIRE.md: the npx package is called not published before the first npx command, and the client config runs the signer with node', () => {
  const guide = hire();
  const caveat = guide.indexOf('The npx package is not published yet');
  const firstNpx = guide.search(/^npx -y /m);
  assert.ok(caveat > 0 && firstNpx > caveat, 'the caveat comes first');
  const config = JSON.parse(guide.match(/```json\n([\s\S]*?)\n```/)[1]);
  assert.equal(config.mcpServers['vector-signer'].command, 'node');
  assert.equal(config.mcpServers.vector.url, designEndpoint('MCP'));
  assert.deepEqual(Object.keys(config.mcpServers['vector-signer'].env), ['VECTOR_SIGNER_PRIVATE_KEY', 'VECTOR_SIGNER_ADDRESS', 'VECTOR_SIGNER_SPEND_LIMIT_PER_TX', 'VECTOR_SIGNER_SPEND_LIMIT_DAILY']);
  assert.ok(guide.includes('replace `command` and `args` with `"command": "npx"`'));
});

test('docs/HIRE.md: the keygen output format is not pinned; the escrow minimum is a range; the 90 s limit belongs to the PR 3 tools, not to the wait', () => {
  const guide = hire();
  assert.equal(guide.match(/VECTOR_SIGNER_PRIVATE_KEY=\.\.\./), null, 'no NAME=... line is promised from keygen');
  assert.ok(guide.includes('If keygen prints them as `NAME=value` lines, the value is what follows the `=`.'));
  assert.ok(section(guide, '3. Fund it').includes('between 2.2 and 2.3 in an escrow output of this size, depending on the length of the agent'));
  const timeouts = guide.split('\n').find((l) => l.startsWith('| A tool call times out near 100 s')) ?? '';
  assert.ok(timeouts.includes('The PR 3 tools that call a supplier (send job, poll job, verify receipt) stop at 90 s on their own'));
  assert.ok(timeouts.includes('`vector_await_transaction` waits as long as it is asked, up to 300 s'));
  assert.match(guide, /\| The check table says `response_hash` fails \|/);
});

test('docs/E2E.md and scripts/e2e-hire.mjs agree on the send step, the signer settings and the response-hash row', () => {
  const e2e = doc('E2E.md');
  const script = e2eScript();
  assert.ok(e2e.includes('## If the send step was interrupted'));
  assert.ok(script.includes('docs/E2E.md, "If the send step was interrupted"'), 'the script points at that section');
  assert.ok(script.includes('an earlier run called vector_marketplace_send_job and recorded no job id') && e2e.includes('an earlier run called vector_marketplace_send_job'), 'the message the operator sees is the one the runbook quotes');
  assert.match(e2e, /\| Exit code 1, and the message starts "an earlier run called vector_marketplace_send_job" \|/);
  assert.match(e2e, /\| The check by hand says `response_hash` fails \|/);
  // An advert that is no longer free after an earlier run posted the escrow, and a signed transaction that can never land.
  assert.match(e2e, /\| Exit code 1, "is not among the free suppliers", after an earlier run already posted the escrow \|/);
  assert.match(e2e, /\| Exit code 1, and the same transaction is reported as not confirmed on every rerun \|/);
  assert.ok(e2e.includes('every rerun submits that same transaction again') && e2e.includes('mv e2e-state.json e2e-state.old.json'));
  assert.ok(script.includes('An earlier run already posted escrow') && script.includes('is still Open'));
  assert.ok(script.includes('follow the row "is not among the free suppliers" in docs/E2E.md ("If a run stops")'), 'the note for a post that was never confirmed names the row whose way out applies, not the row that says to run the script again');
  const freeRow = e2e.split('\n').find((l) => l.startsWith('| Exit code 1, "is not among the free suppliers", after an earlier run already posted the escrow |')) ?? '';
  for (const text of ['look the post transaction up on the explorer first. If it is there, the escrow is Open and the same steps apply.', 'If it is not there, nothing was posted:', 'a reclaim after `deliver_by`', 'While the advert is not free, running the script again stops at the same check.']) assert.ok(freeRow.includes(text), `the runbook row says ${text}`);
  assert.equal(freeRow.includes('follow the next row'), false, 'the row carries its own way out');
  assert.equal(e2e.match(/never reads/), null, 'the script reads the settings it forwards; it never prints or stores them');
  assert.ok(e2e.includes('The script forwards every `VECTOR_SIGNER_` setting to the signer process it starts.') && e2e.includes('The script never prints or stores the value of a setting.'));
  assert.match(e2e, /`keygen` command \(PR 4, merged into `main` on 2026-10-14; the npx package is not published yet\)/);
  assert.ok(e2e.includes('`--dry-run` is the only argument the script takes.'));
  assert.ok(e2e.includes('asks `vector_await_transaction` to wait 90 s at a time, up to four times'));
  assert.match(script, /const AWAIT_SLICE_S = 90;/);
  assert.match(script, /const AWAIT_SLICES = 4;/);
});

test('docs/HIRE.md: PR 2 is merged and its tools are on the hosted mainnet server, with its link; the last message lists the report text, and the lost buyer bond is said in one sentence', () => {
  const guide = hire();
  const row = (needle) => guide.split('\n').find((l) => l.startsWith('|') && l.includes(needle)) ?? '';
  assert.ok(row('vector_build_marketplace_post_escrow').includes('PR 2, merged into `main` on 2026-10-14, on the hosted mainnet server: [Apex-Fusion/mcp-server#21](https://github.com/Apex-Fusion/mcp-server/pull/21)'));
  assert.match(row('| Reads back what it already has |'), /^\| 6 \| .* You hold the report text, the receipt, the signature, the escrow reference and two links\./);
  assert.ok(section(guide, '3. Fund it').includes('the supplier may Release the escrow and keep everything that is locked: the price and both bonds, your buyer bond included.'));
});

test('docs/E2E.md and scripts/e2e-hire.mjs: the recovery text reads the escrow by its reference and closes a Submitted first-party escrow in one way', () => {
  const recovery = section(doc('E2E.md'), 'If the send step was interrupted');
  const script = e2eScript();
  const fromScript = script.slice(script.indexOf('function sendInterrupted'), script.indexOf('async function main'));
  assert.ok(recovery.length > 500 && fromScript.length > 500, 'both slices were found');
  for (const [name, text] of [['docs/E2E.md', recovery], ['scripts/e2e-hire.mjs', fromScript]]) {
    assert.ok(text.includes('mp-indexer.vector.apexfusion.org/escrows/') || text.includes('${INDEXER_URL}/escrows/'), `${name}: the one-row read`);
    assert.doesNotMatch(text, /newest row/, name);
    assert.doesNotMatch(text, /accept by hand|Let the (600000 ms|accept) window pass|Do not accept what you cannot verify/i, name);
    for (const word of ['vector_build_marketplace_accept', 'vector_build_marketplace_reclaim', 'posted_at', 'Submitted']) assert.ok(text.includes(word), `${name}: ${word}`);
    assert.match(text, /a Release would hand it to the supplier/, name);
    // PR 2's refusal for an escrow that is spent or not yet indexed, quoted as the tool words it, and one retry before concluding anything.
    assert.ok(text.includes('No live continuation of escrow <escrow') && text.includes('(spent, or not yet indexed); retry or check the explorer.'), `${name}: the refusal of the accept tool`);
    assert.match(text, /ask once more, because the indexer can lag the ledger/, name);
    assert.doesNotMatch(text, /already closed/, name);
  }
  assert.ok(recovery.includes('%23'), 'the # of the reference is written as %23');
  assert.ok(fromScript.includes('encodeURIComponent(post.escrow_ref)'));
});

test('docs/HIRE.md: the receipt check is described as the merged tool answers it, message 4 names buyerAddress, and keygen is run in the member\'s own terminal', () => {
  const guide = hire();
  const six = section(guide, '6. Read your receipt');
  assert.ok(six.includes('runs five checks and one extra row, and reports each as pass, fail or skipped'));
  assert.ok(six.includes('The verdict reads VERIFIED only when every row passes. It reads FAILED when a row fails, and INCOMPLETE when nothing failed but a row was skipped'));
  assert.ok(six.includes('the `prompt_hash` in the receipt equals the `prompt_hash` in the escrow datum'), 'the extra row');
  assert.ok(six.includes('check 2 is skipped and the verdict reads INCOMPLETE, which is never a pass'));
  assert.equal(guide.match(/can still read as a pass|as pass or fail:/), null, 'the wording of before the tool had a skipped state');
  const five = section(guide, '5. The chat script');
  assert.ok(five.includes('`buyerAddress` must be the wallet that posted and funded the escrow, which is your signer address.'), 'the table of message 4 says what buyerAddress is');
  const two = section(guide, '2. Get a key');
  assert.ok(two.includes("Run `keygen` in your own terminal, never through your assistant's shell tool."));
  assert.ok(two.includes('so the only copy of the key would reach your model provider'));
  assert.ok(two.indexOf('never through your assistant') < two.indexOf('node packages/signer/build/index.js keygen'), 'said before the first command');
});

test('docs/E2E.md and scripts/e2e-hire.mjs: buyerAddress, the skipped and incomplete wording, and a failed or stalled job checked before it is reclaimed', () => {
  const e2e = doc('E2E.md');
  const script = e2eScript();
  assert.ok(e2e.includes("The send and every poll pass the signer's address as `buyerAddress`"));
  assert.equal((script.match(/buyerAddress: address/g) ?? []).length, 4, 'the send and the poll, in the calls and in the plan');
  assert.ok(e2e.includes('check 2 is skipped, and a skipped row makes the verdict `incomplete`, never a pass'));
  assert.ok(e2e.includes('stops the run before any money moves') && script.includes('if (!state.post?.signed_cbor) for (const [name, args] of stepsOf('), 'a fresh run checks its arguments first');
  const row = e2e.split('\n').find((l) => l.startsWith('| Exit code 1 | A step failed.')) ?? '';
  assert.doesNotMatch(row, /If the job failed or `deliver_by` passed, reclaim/);
  for (const word of ["the supplier's Submit may still land", 'vector_build_marketplace_accept', '`seconds_left`', '600 s', 'Open or Claimed']) assert.ok(row.includes(word), `the runbook row says ${word}`);
  const fromScript = script.slice(script.indexOf('function checkTheEscrow'), script.indexOf('function postedEscrowNote'));
  assert.ok(fromScript.length > 400, 'the check-the-escrow text was found in the script');
  for (const word of ["the supplier's Submit may still land", 'vector_build_marketplace_accept', 'seconds_left', '600 s', 'Open or Claimed', 'vector_build_marketplace_reclaim']) assert.ok(fromScript.includes(word), `the script says ${word}`);
  assert.doesNotMatch(script, /Reclaim the escrow/, 'the script never tells the operator to simply reclaim');
  // The row for a lost state file names the Submitted case too, and the funded-key paragraph says where keygen is run.
  const lost = e2e.split('\n').find((l) => l.startsWith('| Exit code 2 |')) ?? '';
  for (const text of ['find it through the indexer rows of the buyer key', 'as in the first row of this table', 'vector_build_marketplace_accept', '`seconds_left`', 'If it is Submitted, accept within 600 s of the Submit', 'If it is Open or Claimed, reclaim it with `vector_build_marketplace_reclaim` after `deliver_by`']) assert.ok(lost.includes(text), `the lost-state row says ${text}`);
  assert.equal(lost.includes('reclaim it after `deliver_by` before you start a new run'), false, 'no bare reclaim');
  assert.ok(e2e.includes("Run `keygen` in your own terminal, never through the assistant's shell tool: its output goes back into the conversation, so the only copy of the key would reach the model provider."));
});

test('the marketplace tools are said to be on the hosted mainnet server (33 tools, 2026-10-14) in the runbooks, the script and the four specs, nothing waits for a cutover, and way 1 of the Agent History spec names buyerAddress', () => {
  const e2e = doc('E2E.md');
  assert.ok(e2e.includes('The nine marketplace tools are merged into `main` of Apex-Fusion/mcp-server and are on the hosted mainnet server as of 2026-10-14: an MCP `initialize` and `tools/list` handshake that day listed 33 tools, the nine among them.'));
  // The current advert was posted on 2026-10-15 at the status flip (RUNBOOK step 17), so the check that ADVERT_REF is among the free suppliers can pass with it. The first first-party run settled on 2026-10-15 (step 15), against the first advert, and is in the Results table. The status word is DEPLOYED.
  assert.ok(e2e.includes(`The current Agent History advert was posted on 2026-10-15, reference \`${AH.advertRef}\`. The first first-party run settled on 2026-10-15 (verdict VERIFIED, see [Results](#results)); it was made against the first advert, which was retired that day at the status flip.`));
  assert.equal(e2e.includes(AH.firstAdvertTx), false, 'the retired advert is named by what it was, not by its reference');
  assert.equal(e2e.match(/has not completed a live run|first-party run has not been made/i), null, 'the words of before the run');
  assert.ok(e2e.includes('Against the hosted mainnet server the script now passes its first check, the tool list of the builder. The check that `ADVERT_REF` is among the free suppliers can pass with that reference: the marketplace indexer lists the advert as Active and free as of 2026-10-15.'));
  assert.equal(e2e.match(/advert is not posted|until the advert is posted|not yet advertised|not in service|<ADVERT_REF>/i), null, 'the words of before the advert');
  assert.equal(e2e.match(/none yet/i), null, 'the empty row of the Results table is gone: the first run is in it');
  const builderRow = e2e.split('\n').find((l) => l.startsWith('| `BUILDER_URL` |')) ?? '';
  assert.ok(builderRow.includes('Default: `https://mcp.vector.mainnet.apexfusion.org/mcp`, which has them as of 2026-10-14. The default works, so you need not set `BUILDER_URL`.'));
  assert.ok(builderRow.includes('The local build is the fallback for a builder that lacks the tools: build `main` of Apex-Fusion/mcp-server and run it locally with `PORT=3300 node packages/builder/build/index.js`'));
  assert.ok(builderRow.includes('The hosted testnet instance lists the same tools, but it reads the mainnet marketplace indexer with the testnet Koios'));
  assert.equal(e2e.match(/three PRs|PR 3 branch|PR 4 \(planned\)|none of the nine marketplace tools/), null, 'the statuses of before the merge');
  const script = e2eScript();
  assert.ok(script.includes('They are merged into main of Apex-Fusion/mcp-server and on the hosted mainnet server as of 2026-10-14, so a builder that lacks them is some other builder.'));
  assert.equal(script.match(/three PRs|PR 3 branch/), null);
  const wayOne = section(read('agent-history'), 'How to hire it').split('\n').find((l) => l.startsWith('1. **Chat client via MCP.**')) ?? '';
  assert.ok(wayOne.includes('The send and every poll also take your signer address as `buyerAddress`, the wallet that posted and funded the escrow.'));
  assert.ok(wayOne.includes('The marketplace tools are on the hosted mainnet server, which lists 33 tools as of 2026-10-14.'));
  for (const name of ['document-pipeline', 'audio-snippets', 'advocate']) {
    const how = section(read(name), 'How to hire it');
    assert.ok(how.includes('The marketplace tools are on the hosted mainnet server as of 2026-10-14.'), name);
    assert.equal(how.match(/marketplace tools are PROPOSED/), null, name);
  }
  assert.equal(read('agent-history').match(/not on the hosted server/), null);
  // No file that once said it waits for a cutover says it now.
  const waited = [['docs/HIRE.md', hire()], ['docs/E2E.md', e2e], ['deploy/apex-web/RUNBOOK.md', readFileSync(new URL('../deploy/apex-web/RUNBOOK.md', import.meta.url), 'utf8')], ['scripts/e2e-hire.mjs', script], ...Object.keys(AGENTS).map((name) => ['specs/' + name + '.md', read(name)])];
  assert.equal(waited.length, 8);
  for (const [name, text] of waited) assert.equal(text.match(WAITS_FOR_CUTOVER), null, name + ' still waits for a cutover');
});

test('docs/HIRE.md section 8: the current advert reference is given in full and the public URL is in service; the reference is the same in the spec, the guide and the E2E runbook, and the guide never gives the retired one', () => {
  const eight = section(hire(), '8. The terminal path');
  assert.ok(eight.includes(`As of 2026-10-15 the advert reference is \`${AH.advertRef}\` and the endpoint URL is \`https://mp-suppliers-history.hal8.ai\`, which is in service. Check both against what the tools show you.`));
  assert.ok(eight.includes(`--advert-ref '${AH.advertRef}' --endpoint https://mp-suppliers-history.hal8.ai --payload-file ./payload.json`));
  assert.equal(hire().match(/<ADVERT_REF>|placeholder|not yet advertised|not in service/i), null, 'the words of before the advert');
  // The reference is the one the agent serves at /capability since the status flip of 2026-10-15: a transaction id of 64 hex digits and the output index 0. It is given in full, never shortened, in every file that gives it.
  assert.match(AH.advertRef, /^[0-9a-f]{64}#0$/);
  for (const [name, text] of [['specs/agent-history.md', read('agent-history')], ['docs/HIRE.md', hire()], ['docs/E2E.md', doc('E2E.md')]]) assert.ok(text.includes(AH.advertRef), `${name} gives the advert reference in full`);
  assert.equal(hire().includes(AH.firstAdvertTx), false, 'the guide never gives the retired advert');
});

test('both READMEs: Agent History is DEPLOYED since 2026-10-15 and the other three agents stay PROPOSED, the agent README gives the facts of the status line and the defaults of the manifest, and neither says it is not yet advertised', () => {
  const agentReadme = readFileSync(new URL('../agents/agent-history/README.md', import.meta.url), 'utf8');
  const rootReadme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  assert.ok(agentReadme.includes(`Status: ${AH_STATUS} Read-only:`));
  assert.ok(agentReadme.includes('| `AGENT_STATUS_CHIP` | `status.chip`, in lower case | `deployed` |') && agentReadme.includes('| `AGENT_STATUS_SINCE` | `status.since` | `2026-10-15` |'), 'the defaults of the code');
  assert.equal(agentReadme.match(/no job (has )?settled/i), null, 'the agent README does not say that no job settled');
  assert.deepEqual(rootReadme.split('\n').filter((l) => l.startsWith('| ') && l.includes('`')), [
    '| Agent History | `identity.history.report.v1` | DEPLOYED |',
    '| Document Pipeline | `document.pipeline.ocr-summary.v1` | PROPOSED |',
    '| Audio Snippets | `audio.transcript.snippets.v1` | PROPOSED |',
    '| Advocate | `research.advocate.onesided.v1` | PROPOSED |',
  ]);
  for (const [name, text] of [['agents/agent-history/README.md', agentReadme], ['README.md', rootReadme]]) assert.equal(text.match(/not yet advertised|no advert\b|not posted|not in service|<ADVERT_REF>/i), null, name);
});

// The root README tells a newcomer how to hire Agent History in one short section (2026-10-15). Its commands, its server URL and its figures are the guide's and the design's, so they are held against both here.
test('README: the section "Hire Agent History" sits between the status table and the link list in eight to twelve short lines, with the commands, the hosted server, the 5-alone rule, the end state, the honesty line and one line that Document Pipeline is built and waits; it names no unit, no dash and no status', () => {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  const heading = '\n## Hire Agent History\n';
  assert.equal(readme.split(heading).length - 1, 1, 'one such section');
  const start = readme.indexOf(heading);
  const links = readme.indexOf('\n- Hire one: `docs/HIRE.md`\n');
  assert.ok(readme.slice(0, start).trimEnd().endsWith('| Advocate | `research.advocate.onesided.v1` | PROPOSED |'), 'right after the status table');
  assert.ok(links > start, 'before the link list');
  const body = readme.slice(start + heading.length, links);
  const lines = body.split('\n').filter((l) => l.trim() !== '');
  assert.ok(lines.length >= 8 && lines.length <= 12, `eight to twelve lines, found ${lines.length}`);
  for (const part of [
    '1. Clone https://github.com/Apex-Fusion/mcp-server. In its folder, build the signer from `main`: `npm ci && npm run build`.',
    '2. In the same folder, in your own terminal and never through an assistant, run `node packages/signer/build/index.js keygen`.',
    '3. Send units on Vector mainnet to the address `keygen` prints. Send 5 alone first, as collateral.',
    '4. Then send a float. One job costs about 3.',
    `5. Add the hosted server to your client: \`${designEndpoint('MCP')}\`.`,
    '6. Add the signer too, with the key in its environment (`docs/HIRE.md` section 4).',
    '7. Paste the six chat messages in `docs/HIRE.md` section 5, one at a time.',
    'You end with the report, an Ed25519-signed receipt, the escrow reference, two explorer links, and a check anyone can repeat with no key.',
    "The supplier is first-party and the contracts have no third-party audit. Accept within 600 s of the supplier's submit, or the supplier may keep the lock.",
    'Document Pipeline is built and waits for its deployment.',
  ]) assert.ok(lines.includes(part), `the section has the line: ${part}`);
  // The line about Document Pipeline is the last of the section, after the honesty line, and the table above keeps the Pipeline PROPOSED.
  assert.equal(lines.at(-1), 'Document Pipeline is built and waits for its deployment.');
  // What the section says is what the guide says: the two commands, the 5 alone, the cost of a job, the six messages and the 600 s.
  assert.ok(section(hire(), '2. Get a key').includes('npm ci && npm run build\nnode packages/signer/build/index.js keygen'), 'the commands of the guide');
  const three = section(hire(), '3. Fund it');
  assert.ok(three.includes('Send 5 alone first, then the float of 50.'), 'the guide sends 5 alone first');
  assert.ok(three.split('\n').some((l) => l.startsWith('| 1 (Agent History) | 3 | ') && l.endsWith(' | about 3 | 16 |')), 'one job costs about 3');
  assert.ok(three.includes("If you do not accept within 600 s of the supplier's Submit, the supplier may Release the escrow and keep everything that is locked"), 'the 600 s line');
  assert.equal(CHAT_SCRIPT.length, 6, 'the six chat messages of section 5');
  assert.equal(readme.match(UNIT_NAME), null, 'the README says units, the guide names the unit once');
  assert.equal(readme.match(DASHES), null, 'hyphens only');
  assert.equal(body.match(/\b(LIVE|DEPLOYED|PROPOSED)\b/), null, 'the section changes no status');
});

// ---- The first first-party run, 2026-10-15 (RUNBOOK step 15) ----
// docs/E2E.md records it in the Results table, and docs/evidence/ holds the object the script printed, byte for byte. Both keys were ours, so the run shows that the path works and is not demand:
// the status word was PROPOSED until step 17 was run on 2026-10-15 and is DEPLOYED since, never LIVE. The file is held against itself and against the docs here. The ledger rows of the receipt check need the chain and are repeated by hand with the tool.
const RUN1 = {
  evidence: 'docs/evidence/2026-10-15-agent-history-run-1.json',
  escrowRef: '5248c71eb5eb65f8bfa865a837f34cc85e6d18fe07b01f14cc2ca22660176765#0',
  postTx: '5248c71eb5eb65f8bfa865a837f34cc85e6d18fe07b01f14cc2ca22660176765',
  acceptTx: '902df222e6e1ab76d2d7f1085963b4dbf3a9b4b88353b82481c57a92fbc5c03c',
  responseHash: '8acccd2af71b7e301096270bc7d38aa0b471c4bbc61c2918dde275db086a0d41',
};
const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');
const runEvidence = () => JSON.parse(readFileSync(new URL(`../${RUN1.evidence}`, import.meta.url), 'utf8'));
const explorerLink = (tx) => `[\`${tx}\`](${EXPLORER_TX}${tx})`;

test('docs/evidence: the evidence of the first-party run of 2026-10-15 parses, is VERIFIED, and its report text hashes to result_sha256 and to the response_hash of the receipt', () => {
  const ev = runEvidence();
  assert.equal(ev.run, 'first-party');
  assert.equal(ev.verdict, 'VERIFIED');
  assert.equal(ev.capability_id, AGENTS['agent-history'].capability);
  assert.equal(ev.advert_ref, AH.firstAdvertRef, 'the run was made against the first advert, which was retired at the status flip');
  assert.equal(ev.escrow_ref, RUN1.escrowRef);
  assert.equal(ev.post_tx, RUN1.postTx);
  assert.equal(ev.accept_tx, RUN1.acceptTx);
  assert.equal(ev.escrow_ref, `${ev.post_tx}#0`, 'the escrow is the first output of the post transaction');
  assert.notEqual(ev.post_tx, ev.accept_tx, 'two transactions');
  assert.deepEqual(ev.explorer, { post: EXPLORER_TX + RUN1.postTx, accept: EXPLORER_TX + RUN1.acceptTx });
  // All six rows of the receipt check passed.
  assert.deepEqual(ev.checks, Object.fromEntries(['escrow_ref_matches', 'response_hash_matches', 'supplier_key_matches', 'signature_valid', 'on_chain_hash_matches', 'prompt_hash_matches'].map((row) => [row, 'pass'])));
  // The report text is the exact string the receipt covers: its sha256 is result_sha256 and the response_hash of the receipt.
  assert.equal(typeof ev.result, 'string');
  assert.equal(sha256(ev.result), ev.result_sha256);
  assert.equal(ev.result_sha256, ev.receipt.response_hash);
  assert.equal(ev.result_sha256, RUN1.responseHash);
  assert.equal(Buffer.byteLength(ev.result, 'utf8'), 7019);
  // The receipt has the eight fields of the guide, names this escrow and the supplier key of the registry record, and carries no model cost.
  assert.deepEqual(Object.keys(ev.receipt).sort(), ['completion_tokens', 'escrow_ref', 'model', 'prompt_hash', 'prompt_tokens', 'response_hash', 'supplier_pkh', 'wallclock_ms']);
  assert.equal(ev.receipt.escrow_ref, ev.escrow_ref);
  assert.equal(ev.receipt.supplier_pkh, AH.controllerPkh);
  assert.equal(ev.receipt.model, AGENTS['agent-history'].model);
  assert.equal(ev.receipt.prompt_tokens, 0);
  assert.equal(ev.receipt.completion_tokens, 0);
  assert.match(ev.receipt_signature, /^[0-9a-f]{128}$/, 'an Ed25519 signature is 64 bytes');
  // The prompt_hash is the sha256 of the wire payload of the request in the guide (message 3 of the chat script), so the receipt is for that request.
  const request = /Payload: (\{"subject":"[^"]+"\})\./.exec(CHAT_SCRIPT[2])[1];
  assert.equal(ev.receipt.prompt_hash, sha256(JSON.stringify([{ content: request, role: 'user' }])));
  // The report is the one this agent writes for that subject.
  const report = JSON.parse(ev.result);
  assert.equal(report.schema, 'vector.agent-history.report.v1');
  assert.equal(report.generated_by.did, AH.did);
  assert.equal(report.subject.did, JSON.parse(request).subject);
});

test('docs/E2E.md, specs/agent-history.md and the guide record the first-party run of 2026-10-15 with the same references, and the status word is DEPLOYED, not LIVE', () => {
  const e2e = doc('E2E.md');
  // The Results table has one row: first-party, the escrow reference, the two transactions as explorer links, VERIFIED.
  assert.deepEqual(e2e.split('\n').filter((l) => /^\| 20\d\d-/.test(l)), [`| 2026-10-15 | Agent History | first-party | \`${RUN1.escrowRef}\` | ${explorerLink(RUN1.postTx)} | ${explorerLink(RUN1.acceptTx)} | VERIFIED |`]);
  assert.ok(e2e.includes('**Status: DEPLOYED.**'), 'the status word since the flip of 2026-10-15');
  assert.ok(e2e.includes('The first first-party run settled on 2026-10-15 (verdict VERIFIED, see [Results](#results)); it was made against the first advert, which was retired that day at the status flip.'));
  assert.equal(e2e.match(/none yet|has not completed a live run|first-party run has not been made/i), null, 'the words of before the run');
  // The paragraph under the table names the evidence file and how to repeat the check, which needs no key and no funds.
  const results = section(e2e, 'Results');
  assert.ok(results.includes(`[${RUN1.evidence}](${RUN1.evidence.replace(/^docs\//, '')})`), 'a link from docs/E2E.md to the evidence file');
  const repeat = results.split('\n').find((l) => l.includes('vector_marketplace_verify_receipt')) ?? '';
  for (const part of ['`receipt`', '`receipt_signature`', '`escrow_ref`', 'the untouched `result`', 'needs no key and no funds', 'It is not demand.']) assert.ok(repeat.includes(part), `the paragraph under the table says ${part}`);
  assert.ok(existsSync(new URL(`../${RUN1.evidence}`, import.meta.url)), 'the evidence file the docs name exists');
  // The spec says it in the Status line and paragraph and in How to hire it, and its Links point at the evidence and at the two transactions.
  const spec = read('agent-history');
  assert.ok(section(spec, 'Status').includes(AH_STATUS));
  for (const heading of ['Status', 'How to hire it']) assert.ok(section(spec, heading).includes('One first-party job has settled, on 2026-10-15; it is not demand.'), heading);
  assert.ok(section(spec, 'Links').includes(`- First-party hire on 2026-10-15, verdict VERIFIED, made against the first advert: the post transaction ${explorerLink(RUN1.postTx)} and the accept transaction ${explorerLink(RUN1.acceptTx)} on the explorer, and the evidence in [${RUN1.evidence}](../${RUN1.evidence}).`));
  // Nothing that states where the agent stands says that no job settled or that no first-party run is recorded. Step 14 of the runbook is in the list too: since the flip of 2026-10-15 it names no word and no job.
  const files = ['specs/agent-history.md', 'docs/HIRE.md', 'docs/E2E.md', 'README.md', 'agents/agent-history/README.md', 'deploy/apex-web/docker-compose.agent-history.yml', 'deploy/apex-web/README.md', 'deploy/apex-web/RUNBOOK.md'];
  for (const file of files) assert.equal(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8').match(/no job (has )?settled|no first-party run of the path is recorded/i), null, file);
  // The honesty box of the guide stays true: nobody outside the team has run the path.
  assert.ok(section(hire(), '10. Honesty box').includes('- No run of this path by someone outside the team is recorded yet. The first-party runs are in [docs/E2E.md](E2E.md).'));
});

test('scripts/run-e2e-from-keyfile.sh and docs/E2E.md: the key file is sourced and never printed, the output goes through the filter, and the runbook says so without a path or an address', () => {
  const script = readFileSync(new URL('./run-e2e-from-keyfile.sh', import.meta.url), 'utf8');
  assert.ok(script.startsWith('#!/usr/bin/env bash\n'));
  assert.ok(script.includes(`export ADVERT_REF="\${ADVERT_REF:-${AH.advertRef}}"`), 'the default advert of the wrapper is the current one');
  assert.equal(script.includes(AH.firstAdvertTx), false, 'and not the retired one');
  assert.ok(script.includes('set -euo pipefail') && script.includes('usage: run-e2e-from-keyfile.sh KEYFILE [--dry-run]'));
  assert.doesNotMatch(script, /\b(echo|printf|cat)\b[^\n]*PRIVATE_KEY/, 'no line prints the key');
  assert.ok(script.includes('node scripts/e2e-hire.mjs --dry-run 2>&1 | redact') && script.includes('node scripts/e2e-hire.mjs 2> >(redact >&2) > evidence.json.tmp'), 'the dry run and the messages of a run go through the filter');
  assert.ok(script.includes('s/ed25519_sk1[0-9a-z]+/ed25519_sk1<redacted>/g'), 'the filter blanks a signer key');
  const e2e = doc('E2E.md');
  const commands = section(e2e, 'The commands');
  assert.ok(commands.indexOf('node scripts/e2e-hire.mjs --dry-run') < commands.indexOf('### Running it from a key file'), 'the section comes after the commands');
  const sub = commands.slice(commands.indexOf('### Running it from a key file'));
  for (const part of ['`scripts/run-e2e-from-keyfile.sh KEYFILE [--dry-run]`', 'the `NAME=value` lines that `keygen` prints', 'sources the file into its own environment and never prints it', 'UTF-16', 'byte-order mark', 'CRLF', 'blanks key-shaped strings', '`evidence.json`', 'keep the file and the key out of any chat']) assert.ok(sub.includes(part), `the key-file section says ${part}`);
  // It says nothing about where the key file is or what the buyer's address is.
  assert.doesNotMatch(e2e, /addr1[0-9a-z]{20,}|[A-Za-z]:[\x5c/]Users[\x5c/]|[\x5c/]home[\x5c/][A-Za-z]/, 'no address and no path into a home folder');
});

// ---- The first advert is history (RUNBOOK step 17) ----
// The status flip of 2026-10-15 retired the first advert and posted a new one with the manifest of the flip. The first reference lives in the Links of the spec, as history, and in the evidence of the run made against it.
// Everything that tells a reader which advert to hire gives the current one, so the old reference cannot come back as the current one without failing here.
test('the first advert is history: its reference is in the Links of the spec and in the evidence of the run, and nowhere else; the guide, the runbook and the spec give the current one', () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  // A path from relative() has the separator of the platform; the walk turns it into forward slashes before anything else looks at it (\x5c is the backslash).
  const slashes = (rel) => rel.split('\x5c').join('/');
  // The run outputs of docs/E2E.md (git-ignored, repository root) are an operator's files, not the repository: skipped.
  const runOutput = (rel) => /^(evidence\.json(\.tmp)?|e2e-state[^\/]*\.json[^\/]*)$/.test(rel);
  const skip = (rel) => runOutput(rel) || /(^|\/)(node_modules|\.git|\.superpowers)(\/|$)/.test(rel) || /(^|\/)test\/fixtures(\/|$)/.test(rel) || rel.startsWith('docs/superpowers') || rel === 'pnpm-lock.yaml' || /\.test\.(mjs|ts)$/.test(rel);
  const walk = (dir, out = []) => { for (const e of readdirSync(dir, { withFileTypes: true })) { const p = join(dir, e.name); if (skip(slashes(relative(root, p)))) continue; e.isDirectory() ? walk(p, out) : out.push(slashes(relative(root, p))); } return out; };
  const files = walk(root).filter((rel) => /\.(ts|js|mjs|json|md|yml|yaml|sh|snippet|example|template)$/.test(rel));
  assert.ok(files.length >= 40 && files.includes('scripts/run-e2e-from-keyfile.sh') && files.includes('docs/HIRE.md'), `the walk reaches the repository, found ${files.length} files`);
  const holders = files.filter((rel) => readFileSync(join(root, rel), 'utf8').includes(AH.firstAdvertTx));
  assert.deepEqual(holders.sort(), [RUN1.evidence, 'specs/agent-history.md'].sort());
  // In the spec it is one line of Links, the one that says the advert was retired.
  const lines = read('agent-history').split('\n').filter((l) => l.includes(AH.firstAdvertTx));
  assert.equal(lines.length, 1);
  assert.ok(lines[0].startsWith('- First advert ') && lines[0].includes('retired on 2026-10-15 at the status flip'));
  // The current advert is what a reader is told to hire.
  assert.notEqual(AH.advertRef, AH.firstAdvertRef);
  assert.equal(hire().split(AH.advertRef).length - 1, 3, 'the guide gives it in the table row, in section 8 and in the command');
  assert.equal(doc('E2E.md').split(AH.advertRef).length - 1, 1, 'the runbook gives it in the Status paragraph');
  assert.ok(read('agent-history').includes(`- Current advert \`${AH.advertRef}\``));
});
