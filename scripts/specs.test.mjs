import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
// The four agent specs share one structure and one set of public-wording rules (docs/superpowers/specs/2026-10-13-vector-service-agents-design.md, section 8).
// The member guide and the E2E runbook are pinned against the same specs and the design at the end of this file.
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

// ---- The member guide (docs/HIRE.md) and the E2E runbook (docs/E2E.md) ----
// They are read by people who act on them, so their numbers, tool names and wording are pinned here against the specs and the design.
const doc = (name) => readFileSync(new URL(`../docs/${name}`, import.meta.url), 'utf8');
const hire = () => doc('HIRE.md');
const e2eScript = () => readFileSync(new URL('./e2e-hire.mjs', import.meta.url), 'utf8');
const HIRE_SECTIONS = ['What you will end up with', 'Get a key', 'We fund it', 'Two lines of config', 'The chat script', 'Read your receipt', 'Register your own identifier (optional)', 'The terminal path', 'When it goes wrong', 'Honesty box'];
const CHAT_SCRIPT = [
  '1. "List the marketplace capabilities on Vector."',
  '2. "Show me free suppliers for identity.history.report.v1."',
  '3. "Hire the first one. Payload: {"subject":"did:vector:agent:be1a0a2912da180757ed3cd61b56bb8eab0188c19dc3c0e3912d2c01:5542837bc3a6ccd66cb75ac91a796cf5716d439f4a72594bbfc06db7231029db"}. Use my signer address as changeAddress, sign, submit and wait for confirmation."',
  '4. "Send the job with the same payload, then poll until it is done."',
  '5. "Verify the receipt. If every check passes, accept, sign, submit and wait."',
  '6. "Show me the receipt, the signature, the escrow reference and explorer links for the post and the accept."',
];
// The nine marketplace tools are read from the design spec, so a renamed tool fails here before it fails in a member's chat.
const MARKETPLACE_TOOLS = [...new Set(DESIGN.match(/\bvector_(?:build_)?marketplace_[a-z_]+/g))].sort();
const OTHER_TOOLS = ['vector_signer_get_address', 'vector_signer_decode_transaction', 'vector_signer_sign', 'vector_signer_get_spend_limits', 'vector_submit_transaction', 'vector_await_transaction', 'vector_build_register_agent', 'vector_build_deregister_agent', 'vector_get_utxos', 'vector_get_balance'];
const designEndpoint = (label) => new RegExp(label + ' `([^`]+)`').exec(DESIGN)?.[1];
const AGENT_SPEC = { 'Agent History': 'agent-history', 'Audio Snippets': 'audio-snippets', Advocate: 'advocate', 'Document Pipeline': 'document-pipeline' };

test('docs/HIRE.md: the ten sections of the design, numbered, in the order the member does them', () => {
  assert.deepEqual([...hire().matchAll(/^## (\d+)\. (.+)$/gm)].map((m) => [Number(m[1]), m[2]]), HIRE_SECTIONS.map((title, i) => [i + 1, title]));
  assert.ok(hire().startsWith('# '), 'starts with a title');
});

test('docs/HIRE.md: the chat script is verbatim, six lines in one block, inside section 5', () => {
  const five = section(hire(), '5. The chat script');
  assert.ok(five.includes('```text\n' + CHAT_SCRIPT.join('\n') + '\n```'), 'the six lines, in order, in one fenced block');
});

test('docs/HIRE.md: the ledger unit is named once, in section 3, and nowhere else in the repo', () => {
  const guide = hire();
  assert.equal(guide.match(UNIT_NAME)?.length, 1);
  assert.ok(section(guide, '3. We fund it').includes("the ledger's native unit, " + UNIT_NAME.source));
  // Every other file of the repo says "unit" or prints lovelace. The planning documents and the recorded ledger data are not part of this rule.
  const root = fileURLToPath(new URL('../', import.meta.url));
  const skip = (rel) => /(^|[\\/])(node_modules|\.git|\.superpowers)([\\/]|$)/.test(rel) || /(^|[\\/])test[\\/]fixtures([\\/]|$)/.test(rel) || rel.startsWith(join('docs', 'superpowers')) || rel === 'pnpm-lock.yaml';
  const walk = (dir, out = []) => { for (const e of readdirSync(dir, { withFileTypes: true })) { const p = join(dir, e.name); if (skip(relative(root, p))) continue; e.isDirectory() ? walk(p, out) : out.push(relative(root, p)); } return out; };
  const hits = walk(root).filter((rel) => /\.(ts|mjs|json|md|yml|yaml|template)$/.test(rel) && rel !== join('docs', 'HIRE.md')).filter((rel) => readFileSync(join(root, rel), 'utf8').match(UNIT_NAME));
  assert.deepEqual(hits, []);
});

test('docs/HIRE.md and docs/E2E.md: no em or en dash; nothing says LIVE or DEPLOYED except the sentence that denies it', () => {
  for (const name of ['HIRE.md', 'E2E.md']) assert.equal(doc(name).match(DASHES), null, name);
  const guide = hire();
  assert.ok(guide.includes('Nothing in this guide is LIVE or DEPLOYED.'));
  assert.equal(guide.replace('Nothing in this guide is LIVE or DEPLOYED.', '').match(/\b(LIVE|DEPLOYED)\b/g), null);
  assert.equal(doc('E2E.md').match(/\b(LIVE|DEPLOYED)\b/g), null);
});

test('docs/HIRE.md: the request JSON and the wire payload are named apart, as in the specs', () => {
  const five = section(hire(), '5. The chat script');
  assert.ok(five.includes(WIRE_PAYLOAD), 'section 5 defines the wire payload');
  assert.match(five, /wrap the request JSON into the wire payload/);
  assert.equal(hire().match(/payload is the request JSON/i), null);
  assert.match(section(hire(), '8. The terminal path'), /holds the request JSON, and the buyer wraps it into the wire payload/);
});

test('docs/HIRE.md: who receives what on Accept, Release and Reclaim; never "both bonds return"', () => {
  const three = section(hire(), '3. We fund it');
  assert.ok(three.includes('On Accept the supplier receives the price and the supplier bond, and your bond returns to you.'));
  assert.ok(three.includes("If you do not accept within 600000 ms of the supplier's Submit, the supplier may Release the escrow and take the price and both bonds."));
  assert.ok(three.includes('If the supplier never submits, you reclaim the price and both bonds after `deliver_by`.'));
  assert.equal(hire().match(/both bonds (return|come back|are returned)|bonds? (are )?returned|returned on accept|bonds back/i), null);
});

test('docs/HIRE.md: the cost table is the escrow arithmetic, with the prices of the four specs', () => {
  const rows = [...section(hire(), '3. We fund it').matchAll(/^\| (\d+) \(([^)]+)\) \| (\d+) \| (\d+) \| (\d+) \| about (\d+) \| about (\d+) \| (\d+) \|$/gm)];
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
  assert.match(row('vector_marketplace_list_capabilities'), /Open PR 1: \[Apex-Fusion\/mcp-server#20\]\(https:\/\/github.com\/Apex-Fusion\/mcp-server\/pull\/20\)/);
  assert.match(row('vector_build_marketplace_post_escrow'), /PR 2, in progress/);
  assert.match(row('vector_marketplace_send_job'), /PR 3, planned/);
  assert.match(row('@apexfusion/vector-mcp-signer'), /PR 4, planned.*not published/);
  assert.match(row('identity.history.report.v1'), /PROPOSED \(built, not yet advertised\)/);
  assert.match(row('mcp.vector.mainnet.apexfusion.org'), /v2\.0\.0, 24 tools/);
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
  assert.equal(results[0], '| Date | Run | Escrow reference | Post transaction | Accept transaction | Verdict |');
  for (const row of results.slice(2)) assert.equal(row.split('|')[2].trim(), 'first-party', `a run row says first-party: ${row}`);
  const settings = [...new Set([...e2eScript().matchAll(/\benv\.([A-Z][A-Z0-9_]+)/g), ...e2eScript().matchAll(/need\('([A-Z][A-Z0-9_]+)'\)/g)].map((m) => m[1]))];
  assert.ok(settings.length >= 5, 'the script reads its settings from the environment');
  for (const name of settings) assert.ok(e2e.includes('`' + name + '`'), `docs/E2E.md explains ${name}`);
});

test('docs/HIRE.md and docs/E2E.md: every place that lists what the receipt check takes lists the report text', () => {
  for (const [name, body] of [['docs/HIRE.md', hire()], ['docs/E2E.md', doc('E2E.md')]]) {
    // A line that talks about running or repeating the check and names the signature and the escrow reference lists its inputs. Without the report text the response-hash check does not run.
    const lists = body.split('\n').filter((l) => /verify_receipt|repeat it/.test(l) && /signature/.test(l) && /escrow/.test(l));
    assert.ok(lists.length >= 1, `${name} lists the inputs of the check`);
    for (const l of lists) assert.match(l, /report text|`result`/, `${name}: ${l.slice(0, 100)}`);
  }
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
  assert.ok(section(guide, '3. We fund it').includes('between 2.2 and 2.3 in an escrow output of this size, depending on the length of the agent'));
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
  assert.equal(e2e.match(/never reads/), null, 'the script reads the settings it forwards; it never prints or stores them');
  assert.ok(e2e.includes('The script forwards every `VECTOR_SIGNER_` setting to the signer process it starts.') && e2e.includes('The script never prints or stores the value of a setting.'));
  assert.match(e2e, /`keygen` command, which arrives with PR 4/);
  assert.ok(e2e.includes('`--dry-run` is the only argument the script takes.'));
  assert.ok(e2e.includes('asks `vector_await_transaction` to wait 90 s at a time, up to four times'));
  assert.match(script, /const AWAIT_SLICE_S = 90;/);
  assert.match(script, /const AWAIT_SLICES = 4;/);
});
