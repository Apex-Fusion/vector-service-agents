import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, existsSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';

// scripts/e2e-hire.mjs against a fake builder (an MCP server over HTTP, here) and a fake signer (an MCP server over stdio,
// scripts/fixtures/fake-signer.mjs). Nothing here touches a network beyond 127.0.0.1, a key or a ledger.
// The fakes answer in the shapes the merged tools answer in. The nine marketplace tools, their argument names and the arguments each of them
// requires are those of packages/builder/test/smoke/tool-schemas.snapshot.json of Apex-Fusion/mcp-server (33 tools, main at 2cf99e1), among
// them buyerAddress, which the send and the poll require. The field names inside the JSON answers of the post and accept tools (escrow_ref,
// tx_hash, deliver_by, lock_lovelace, seconds_left) are those of PR 2 (https://github.com/Apex-Fusion/mcp-server/pull/21, merged). The answers
// of the job tools (job_id, state, receipt_signature, and from the check a verdict, verified, and a state of pass, fail or skipped for each of
// the five checks and the extra prompt_hash row) are those of PR 3, also merged (marketplace-transport-tools.ts). advert_ref in the supplier
// list is read from a real tool (PR 1). A fake server refuses a call that lacks an argument its schema requires, as the merged server does.
const SCRIPT = fileURLToPath(new URL('./e2e-hire.mjs', import.meta.url));
const FAKE_SIGNER = fileURLToPath(new URL('./fixtures/fake-signer.mjs', import.meta.url));
const CAPABILITY = 'identity.history.report.v1';
const ADVERT_REF = `${'aa'.repeat(32)}#0`;
const PAYLOAD = '{"subject":"did:vector:agent:be1a0a2912da180757ed3cd61b56bb8eab0188c19dc3c0e3912d2c01:5542837bc3a6ccd66cb75ac91a796cf5716d439f4a72594bbfc06db7231029db"}';
const ADDRESS = 'addr1vfakesigneraddressfortestsonly0000000000000000000000';
const REPORT = '{"schema":"vector.agent-history.report.v1"}';
const RECEIPT = { escrow_ref: 'set below', supplier_pkh: 'cd'.repeat(28), prompt_hash: 'ef'.repeat(32), response_hash: 'ab'.repeat(32), model: 'agent-history-v1', prompt_tokens: 0, completion_tokens: 0, wallclock_ms: 1234 };
const SIGNATURE = 'c1'.repeat(64);
const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
const withJson = (md, data) => `${md}\n\n\`\`\`json\n${JSON.stringify(data)}\n\`\`\``;
// A tool's input schema as the server lists it: the arguments it requires, then the ones it takes besides.
const schema = (required = [], optional = []) => ({ type: 'object', properties: Object.fromEntries([...required, ...optional].map((n) => [n, { type: 'string' }])), required });
const SCHEMAS = {
  vector_marketplace_list_capabilities: schema(),
  vector_marketplace_list_suppliers: schema([], ['capability_id', 'only_free', 'limit']),
  vector_marketplace_get_supplier: schema(['advert_ref']),
  vector_build_marketplace_post_escrow: schema(['changeAddress', 'advert_ref', 'payload'], ['deliver_by_ms']),
  vector_build_marketplace_accept: schema(['changeAddress', 'escrow_ref']),
  vector_build_marketplace_reclaim: schema(['changeAddress', 'escrow_ref']),
  vector_marketplace_send_job: schema(['escrow_ref', 'payload', 'buyerAddress']),
  vector_marketplace_get_job: schema(['escrow_ref', 'job_id', 'buyerAddress']),
  vector_marketplace_verify_receipt: schema(['escrow_ref', 'receipt', 'receipt_signature'], ['result', 'supplier_pub_key_hex', 'submitted_ref']),
  vector_submit_transaction: schema(['signedTxCbor']),
  vector_await_transaction: schema(['txHash'], ['timeoutSeconds']),
};
const NINE = Object.keys(SCHEMAS).filter((n) => /marketplace/.test(n));
const UNSIGNED = { post: 'ab'.repeat(80), accept: 'cd'.repeat(80) };
const TX = { post: sha(UNSIGNED.post), accept: sha(UNSIGNED.accept) };
const ESCROW_REF = `${TX.post}#0`;

// opts (read at call time, so a test can change them between two runs): tools, schemas, listed, capability, pending, verified, verifyFailures,
// notConfirmed, slowConfirm, submitHash, deliverBy, sendFails, sendAnswer, hangSend, dropSend, onSend, jobFailed.
const builders = [];
async function fakeBuilder(opts = {}) {
  const calls = [];
  let polls = 0, verifies = 0, sends = 0;
  let inFlight; // the response of the request being served, so that a handler can drop the connection
  const asked = {};
  const handlers = {
    vector_marketplace_list_capabilities: () => withJson('# Marketplace capabilities', [{ capability_id: CAPABILITY, supplier_count: 1 }]),
    // The list the marketplace gives for the capability asked for: the advert is listed under opts.capability (Agent History's by default) and under no other.
    vector_marketplace_list_suppliers: (args) => {
      const served = opts.capability ?? CAPABILITY;
      return opts.listed === false || args.capability_id !== served
        ? `No suppliers found for ${args.capability_id} with status free.`
        : withJson('# Marketplace suppliers', [{ advert_ref: ADVERT_REF, capability_id: served, model: 'agent-history-v1', price_lovelace: '1000000' }]);
    },
    vector_build_marketplace_post_escrow: () => withJson(`# Unsigned Escrow Post Built (Not Submitted)\n\n**Unsigned TX CBOR:**\n\`\`\`\n${UNSIGNED.post}\n\`\`\``, { escrow_ref: ESCROW_REF, lock_lovelace: '3000000', deliver_by: opts.deliverBy ?? Date.now() + 480_000, tx_hash: TX.post, fee: '500000' }),
    vector_build_marketplace_accept: () => withJson(`# Unsigned Accept Built (Not Submitted)\n\n**Unsigned TX CBOR:**\n\`\`\`\n${UNSIGNED.accept}\n\`\`\``, { escrow_ref: ESCROW_REF, tx_hash: TX.accept, supplier_lovelace: '2000000', buyer_lovelace: '1000000', seconds_left: 540 }),
    vector_submit_transaction: ({ signedTxCbor }) => {
      const hash = opts.submitHash ?? sha(signedTxCbor.slice(2)); // submitHash: the ledger reports a transaction other than the one given
      return `# Transaction Submitted\n\nTransaction Hash: ${hash}\n\n[View on Explorer](https://explorer.example/transaction/${hash})`;
    },
    vector_await_transaction: ({ txHash }) => {
      asked[txHash] = (asked[txHash] ?? 0) + 1;
      const pending = (opts.notConfirmed ?? []).includes(txHash) || asked[txHash] <= (opts.slowConfirm ?? 0); // slowConfirm: that many answers of "not yet" for each transaction
      return pending ? `# Not Confirmed Yet\n\nTransaction ${txHash} did not appear on-chain within 90s.` : `# Transaction Confirmed\n\nTransaction Hash: ${txHash}`;
    },
    vector_marketplace_send_job: () => {
      opts.onSend?.();
      if (opts.hangSend) return new Promise(() => {}); // no answer at all: the test ends the script while it waits
      if (opts.dropSend) { inFlight.destroy(); return new Promise(() => {}); } // the connection breaks before an answer
      if (++sends <= (opts.sendFails ?? 0)) return 'Failed to send job: supplier is already working another job (409 supplier_busy)\n\n**Troubleshooting Tips:**\n1. Pick another advert';
      return opts.sendAnswer ?? withJson('# Job sent', { job_id: 'job-1', status: 'accepted', escrow_ref: ESCROW_REF, capability_id: CAPABILITY });
    },
    vector_marketplace_get_job: () => {
      const ids = { job_id: 'job-1', escrow_ref: ESCROW_REF };
      if (opts.jobFailed) return withJson('# Job job-1: failed', { state: 'failed', ...ids, reason: 'service_error', message: 'the service answered 500' });
      return ++polls <= (opts.pending ?? 1) ? withJson('# Job job-1: pending', { state: 'pending', ...ids, status: 'running' }) : withJson('# Job job-1: done', { state: 'done', ...ids, result: REPORT, receipt: { ...RECEIPT, escrow_ref: ESCROW_REF }, receipt_signature: SIGNATURE, submitted_ref: null, supplier_pkh: RECEIPT.supplier_pkh });
    },
    vector_marketplace_verify_receipt: (args) => {
      // A verdict, the boolean verified, and a state for each of the five checks and the extra row. A check that was not run is skipped, and a verdict
      // with a skipped row is incomplete, never verified. Check 2 is skipped without the report text; check 5 is skipped for the first verifyFailures
      // answers (the ledger lags the supplier's Submit, so the Submitted output is not found yet); verified: false makes the signature check fail.
      const lagging = ++verifies <= (opts.verifyFailures ?? 0);
      const checks = {
        escrow_ref_matches: 'pass',
        response_hash_matches: (args.result ?? args.output) === undefined ? 'skipped' : 'pass',
        supplier_key_matches: 'pass',
        signature_valid: opts.verified === false ? 'fail' : 'pass',
        on_chain_hash_matches: lagging ? 'skipped' : 'pass',
        prompt_hash_matches: 'pass',
      };
      const states = Object.values(checks);
      const verdict = states.includes('fail') ? 'failed' : states.includes('skipped') ? 'incomplete' : 'verified';
      return withJson(`# Receipt check: ${verdict.toUpperCase()}`, { verdict, verified: verdict === 'verified', escrow_ref: args.escrow_ref, checks });
    },
  };
  const toolList = () => (opts.tools ?? Object.keys(SCHEMAS)).map((name) => ({ name, description: name, inputSchema: opts.schemas?.[name] ?? SCHEMAS[name] }));
  const http = createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/mcp') { res.writeHead(405, { allow: 'POST' }).end(); return; }
    const chunks = []; for await (const c of req) chunks.push(c);
    inFlight = res;
    const mcp = new Server({ name: 'fake-builder', version: '0.0.0' }, { capabilities: { tools: {} } });
    mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: toolList() }));
    mcp.setRequestHandler(CallToolRequestSchema, async (r) => {
      calls.push({ name: r.params.name, args: r.params.arguments ?? {} });
      const handler = handlers[r.params.name];
      const lacking = (toolList().find((t) => t.name === r.params.name)?.inputSchema.required ?? []).filter((k) => r.params.arguments?.[k] === undefined);
      if (lacking.length) return { isError: true, content: [{ type: 'text', text: `Invalid arguments for tool ${r.params.name}: ${lacking.join(', ')} is required` }] };
      return handler ? { content: [{ type: 'text', text: await handler(r.params.arguments ?? {}) }] } : { isError: true, content: [{ type: 'text', text: `unknown tool ${r.params.name}` }] };
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { transport.close(); mcp.close(); });
    await mcp.connect(transport);
    await transport.handleRequest(req, res, JSON.parse(Buffer.concat(chunks).toString('utf8')));
  });
  await new Promise((resolve) => http.listen(0, '127.0.0.1', resolve));
  const builder = { url: `http://127.0.0.1:${http.address().port}/mcp`, calls, opts, names: () => calls.map((c) => c.name), close: () => { http.closeAllConnections?.(); http.close(); } };
  builders.push(builder);
  return builder;
}
after(() => { for (const b of builders) b.close(); });

const dirs = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
// The settings of a run come from the test only: nothing of the real shell's settings reaches the script.
function setup(overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'e2e-hire-'));
  dirs.push(dir);
  const files = { state: join(dir, 'state.json'), signerLog: join(dir, 'signer.log') };
  const signerCalls = () => (existsSync(files.signerLog) ? readFileSync(files.signerLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  const env = (builder, extra = {}) => ({
    ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(VECTOR_|BUILDER_URL|SIGNER_ENTRY|ADVERT_REF|CAPABILITY_ID|PAYLOAD|E2E_|EXPLORER_URL)/.test(k))),
    BUILDER_URL: builder.url, SIGNER_ENTRY: FAKE_SIGNER, ADVERT_REF, PAYLOAD, E2E_STATE: files.state, E2E_POLL_MS: '10', VECTOR_SIGNER_AUDIT_LOG_PATH: files.signerLog, ...overrides, ...extra,
  });
  return { dir, files, signerCalls, env, state: () => JSON.parse(readFileSync(files.state, 'utf8')) };
}
function run(env, args = []) {
  return new Promise((resolve) => execFile(process.execPath, [SCRIPT, ...args], { env, timeout: 90_000 }, (error, stdout, stderr) => resolve({ code: error ? (error.code ?? 1) : 0, stdout, stderr })));
}
const signs = (calls) => calls.filter((c) => c.name === 'vector_signer_sign').length;
// What a failed job and a stalled job both say. The job tool does not know where the escrow stands and the supplier's Submit may still land, so the
// escrow is checked before anything is reclaimed: a Submitted one has a clock and cannot be reclaimed, the accept tool builds only for a Submitted
// one (so asking it is the check), and only an Open or Claimed one is reclaimed, after deliver_by.
function assertChecksTheEscrow(stderr) {
  for (const word of [`does not know where escrow ${ESCROW_REF} stands`, "supplier's Submit may still land", 'Submitted', 'vector_build_marketplace_accept', 'seconds_left', '600 s', 'Open or Claimed', 'vector_build_marketplace_reclaim', 'deliver_by']) assert.ok(stderr.includes(word), `says ${word}`);
  assert.ok(stderr.indexOf('vector_build_marketplace_accept') < stderr.indexOf('vector_build_marketplace_reclaim'), 'the check comes before the reclaim');
  assert.doesNotMatch(stderr, /Reclaim the escrow/, 'no bare reclaim');
}
const USAGE = 'usage: node scripts/e2e-hire.mjs [--dry-run]';

test('stops at once when the builder lacks the marketplace tools, and names all nine (a builder other than the hosted mainnet server)', async () => {
  const builder = await fakeBuilder({ tools: ['vector_submit_transaction', 'vector_await_transaction'] });
  const t = setup();
  const r = await run(t.env(builder));
  assert.equal(r.code, 3);
  for (const tool of NINE) assert.ok(r.stderr.includes(tool), `names ${tool}`);
  assert.match(r.stderr, /PR 1/); assert.match(r.stderr, /PR 2/); assert.match(r.stderr, /PR 3/);
  assert.ok(r.stderr.includes('They are merged into main of Apex-Fusion/mcp-server and on the hosted mainnet server as of 2026-10-14, so a builder that lacks them is some other builder.'), 'says where the tools are');
  assert.doesNotMatch(r.stderr, /cutover|cuts it over/i, 'no wait for a cutover');
  assert.ok(r.stderr.includes('for example a local build of main: PORT=3300'), 'a local build of main');
  assert.doesNotMatch(r.stderr, /three PRs|PR 3 branch/, 'the statuses of before the merge');
  assert.deepEqual(builder.calls, [], 'no tool was called');
  assert.deepEqual(t.signerCalls(), [], 'the signer was not even started');
  assert.equal(existsSync(t.files.state), false);
});

test('names only the tools that are missing', async () => {
  const builder = await fakeBuilder({ tools: ['vector_marketplace_list_capabilities', 'vector_marketplace_list_suppliers', 'vector_marketplace_get_supplier', 'vector_submit_transaction', 'vector_await_transaction'] });
  const r = await run(setup().env(builder));
  assert.equal(r.code, 3);
  for (const tool of NINE.slice(3)) assert.ok(r.stderr.includes(tool), `names ${tool}`);
  assert.equal(r.stderr.includes('vector_marketplace_get_supplier'), false);
  assert.equal(r.stderr.includes('PR 1'), false);
});

test('stops when the signer lacks a tool', async () => {
  const builder = await fakeBuilder();
  const r = await run(setup().env(builder, { VECTOR_SIGNER_FAKE_HIDE: 'vector_signer_sign' }));
  assert.equal(r.code, 3);
  assert.match(r.stderr, /signer.*vector_signer_sign/s);
  assert.deepEqual(builder.calls, []);
});

test('stops when the signer signed a different transaction than the one the builder built', async () => {
  const builder = await fakeBuilder();
  const r = await run(setup().env(builder, { VECTOR_SIGNER_FAKE_WRONG_HASH: '1' }));
  assert.equal(r.code, 1);
  assert.match(r.stderr, /the signer signed e{64}, not the [0-9a-f]{64} that the builder built/);
  assert.equal(builder.names().includes('vector_submit_transaction'), false);
});

test('stops when the ledger took a different transaction than the one that was signed', async () => {
  const builder = await fakeBuilder({ submitHash: 'f'.repeat(64) });
  const t = setup();
  const r = await run(t.env(builder));
  assert.equal(r.code, 1);
  assert.match(r.stderr, new RegExp(`post: the ledger took f{64}, not ${TX.post}`));
  assert.equal(builder.names().includes('vector_await_transaction'), false);
  assert.equal(t.state().post.confirmed, undefined);
});

test('exits 2 and names the settings that are missing', async () => {
  const builder = await fakeBuilder();
  const env = setup().env(builder);
  delete env.ADVERT_REF; delete env.SIGNER_ENTRY;
  const r = await run(env);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /ADVERT_REF/); assert.match(r.stderr, /SIGNER_ENTRY/);
  assert.deepEqual(builder.calls, []);
});

test('exits 2 for an advert reference or a request JSON that is malformed, before anything is connected', async () => {
  const builder = await fakeBuilder();
  const t = setup();
  const advert = await run(t.env(builder, { ADVERT_REF: 'not-a-reference' }));
  assert.equal(advert.code, 2);
  assert.match(advert.stderr, /ADVERT_REF must be <txid>#<index>, got "not-a-reference"/);
  const payload = await run(t.env(builder, { PAYLOAD: '{"subject":' }));
  assert.equal(payload.code, 2);
  assert.match(payload.stderr, /PAYLOAD must be the request JSON/);
  assert.deepEqual(builder.calls, []);
  assert.deepEqual(t.signerCalls(), []);
});

test('rejects an unknown flag or argument with exit 2 and the usage line, before anything is connected', async () => {
  const builder = await fakeBuilder();
  const t = setup();
  for (const args of [['--dryrun'], ['--dry-run', 'extra'], ['--help']]) {
    const r = await run(t.env(builder), args);
    assert.equal(r.code, 2, args.join(' '));
    assert.ok(r.stderr.includes(`unknown argument ${args.filter((a) => a !== '--dry-run').join(' ')}`), args.join(' '));
    assert.ok(r.stderr.includes(USAGE), 'the usage line');
  }
  assert.deepEqual(builder.calls, []);
  assert.deepEqual(t.signerCalls(), []);
});

test('E2E_POLL_MS must be a positive whole number of milliseconds, and anything else exits 2', async () => {
  const builder = await fakeBuilder();
  const t = setup();
  for (const bad of ['0', '-5', '1.5', 'fast', '10ms', '1e3']) {
    const r = await run(t.env(builder, { E2E_POLL_MS: bad }));
    assert.equal(r.code, 2, bad);
    assert.ok(r.stderr.includes(`E2E_POLL_MS must be a positive whole number of milliseconds, got "${bad}"`), bad);
  }
  assert.deepEqual(builder.calls, []);
});

test('a state file that is not a JSON object exits 2, names the file and leaves it as it was', async () => {
  const builder = await fakeBuilder();
  const t = setup();
  for (const content of ['{"run": ', 'not json at all', '[]', 'null', '"text"']) {
    writeFileSync(t.files.state, content);
    const r = await run(t.env(builder));
    assert.equal(r.code, 2, content);
    assert.ok(r.stderr.includes(t.files.state), `names the file for ${content}`);
    assert.match(r.stderr, /not valid JSON|does not hold a JSON object/);
    assert.equal(readFileSync(t.files.state, 'utf8'), content, 'the file is untouched');
  }
  assert.deepEqual(builder.calls, []);
});

test('--dry-run reads, prints every call it would make, and signs, submits and sends nothing', async () => {
  const builder = await fakeBuilder();
  const t = setup();
  const r = await run(t.env(builder), ['--dry-run']);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(builder.names(), ['vector_marketplace_list_suppliers']);
  assert.deepEqual(t.signerCalls().map((c) => c.name), ['vector_signer_get_address']);
  const planned = ['vector_build_marketplace_post_escrow', 'vector_signer_sign', 'vector_submit_transaction', 'vector_await_transaction', 'vector_marketplace_send_job', 'vector_marketplace_get_job', 'vector_marketplace_verify_receipt', 'vector_build_marketplace_accept'];
  let at = -1;
  for (const tool of planned) { const i = r.stdout.indexOf(tool, at + 1); assert.ok(i > at, `${tool} is planned, in order`); at = i; }
  assert.ok(r.stdout.includes(ADVERT_REF) && r.stdout.includes(ADDRESS), 'the plan carries the real arguments');
  assert.equal((r.stdout.match(/"buyerAddress":"addr1v/g) ?? []).length, 2, 'the send and the poll name the buyer');
  assert.equal((r.stdout.match(/done in an earlier run/g) ?? []).length, 0, 'nothing is done yet');
  assert.equal(existsSync(t.files.state), false, 'a dry run writes no state');
});

test('a full run: post, send, poll, verify, accept, each transaction signed, submitted and awaited; the evidence is printed', async () => {
  const builder = await fakeBuilder();
  const t = setup();
  const r = await run(t.env(builder));
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(builder.names(), [
    'vector_marketplace_list_suppliers',
    'vector_build_marketplace_post_escrow', 'vector_submit_transaction', 'vector_await_transaction',
    'vector_marketplace_send_job', 'vector_marketplace_get_job', 'vector_marketplace_get_job',
    'vector_marketplace_verify_receipt',
    'vector_build_marketplace_accept', 'vector_submit_transaction', 'vector_await_transaction',
  ]);
  const byName = (n) => builder.calls.filter((c) => c.name === n);
  assert.deepEqual(byName('vector_build_marketplace_post_escrow')[0].args, { changeAddress: ADDRESS, advert_ref: ADVERT_REF, payload: PAYLOAD });
  assert.deepEqual(byName('vector_marketplace_send_job')[0].args, { escrow_ref: ESCROW_REF, payload: PAYLOAD, buyerAddress: ADDRESS }, 'the buyer is the wallet that posted the escrow and locked its value: the signer address');
  const poll = { escrow_ref: ESCROW_REF, job_id: 'job-1', buyerAddress: ADDRESS };
  assert.deepEqual(byName('vector_marketplace_get_job').map((c) => c.args), [poll, poll], 'every poll names the buyer, like the send');
  assert.deepEqual(byName('vector_marketplace_verify_receipt')[0].args, { escrow_ref: ESCROW_REF, receipt: { ...RECEIPT, escrow_ref: ESCROW_REF }, receipt_signature: SIGNATURE, result: REPORT });
  assert.deepEqual(byName('vector_submit_transaction').map((c) => c.args.signedTxCbor), [`ff${UNSIGNED.post}`, `ff${UNSIGNED.accept}`], 'what the signer returned is what was submitted');
  assert.deepEqual(byName('vector_await_transaction').map((c) => c.args), [{ txHash: TX.post, timeoutSeconds: 90 }, { txHash: TX.accept, timeoutSeconds: 90 }], 'a wait is asked for in slices of 90 s, under the proxy cut near 100 s');
  assert.deepEqual(t.signerCalls().map((c) => c.name), ['vector_signer_get_address', 'vector_signer_sign', 'vector_signer_sign']);
  const evidence = JSON.parse(r.stdout);
  assert.equal(evidence.run, 'first-party');
  assert.equal(evidence.verdict, 'VERIFIED');
  assert.equal(evidence.capability_id, CAPABILITY, "without CAPABILITY_ID the evidence names Agent History's capability");
  assert.deepEqual({ escrow_ref: evidence.escrow_ref, post_tx: evidence.post_tx, accept_tx: evidence.accept_tx }, { escrow_ref: ESCROW_REF, post_tx: TX.post, accept_tx: TX.accept });
  assert.equal(evidence.explorer.post, `https://explorer.vector.mainnet.apexfusion.org/transaction/hash/${TX.post}`);
  assert.equal(evidence.explorer.accept, `https://explorer.vector.mainnet.apexfusion.org/transaction/hash/${TX.accept}`);
  assert.deepEqual(evidence.receipt, { ...RECEIPT, escrow_ref: ESCROW_REF });
  assert.equal(evidence.receipt_signature, SIGNATURE);
  assert.equal(evidence.result, REPORT, 'the report text is in the evidence, so the receipt can be checked again from the evidence alone');
  assert.equal(evidence.result_sha256, sha(REPORT));
  const state = t.state();
  assert.equal(state.post.confirmed, true); assert.equal(state.accept.confirmed, true);
  assert.deepEqual(readdirSync(t.dir).sort(), ['signer.log', 'state.json'], 'the state is written through a temporary file that is renamed, and none is left');
});

test('does not accept a receipt that fails verification', async () => {
  const builder = await fakeBuilder({ verified: false });
  const t = setup();
  const r = await run(t.env(builder));
  assert.equal(r.code, 1);
  assert.match(r.stderr, /NOT accepting/);
  assert.match(r.stderr, /signature_valid/);
  assert.equal(builder.names().includes('vector_build_marketplace_accept'), false);
  assert.equal(signs(t.signerCalls()), 1, 'only the post was signed');
  assert.equal(r.stdout, '', 'no evidence is printed for a run that did not settle');
});

test('verification is tried again while the ledger lags the supplier, and the run accepts once it passes', async () => {
  const builder = await fakeBuilder({ verifyFailures: 2 });
  const r = await run(setup().env(builder));
  assert.equal(r.code, 0, r.stderr);
  assert.equal(builder.names().filter((n) => n === 'vector_marketplace_verify_receipt').length, 3);
  assert.equal(builder.names().filter((n) => n === 'vector_build_marketplace_accept').length, 1);
});

test('a wait for confirmation is asked for in slices of 90 s and repeated until the transaction is confirmed', async () => {
  const builder = await fakeBuilder({ slowConfirm: 2 });
  const r = await run(setup().env(builder));
  assert.equal(r.code, 0, r.stderr);
  const waits = builder.calls.filter((c) => c.name === 'vector_await_transaction');
  assert.deepEqual(waits.map((c) => c.args.txHash), [TX.post, TX.post, TX.post, TX.accept, TX.accept, TX.accept]);
  assert.deepEqual([...new Set(waits.map((c) => c.args.timeoutSeconds))], [90]);
});

test('a job that the supplier reports as failed stops the run with the reason and the check of the escrow, not a bare reclaim; nothing is verified or accepted', async () => {
  const builder = await fakeBuilder({ jobFailed: true });
  const t = setup();
  const r = await run(t.env(builder));
  assert.equal(r.code, 1);
  assert.match(r.stderr, /the job failed: service_error the service answered 500/);
  assertChecksTheEscrow(r.stderr);
  assert.equal(builder.names().includes('vector_marketplace_verify_receipt'), false);
  assert.equal(builder.names().includes('vector_build_marketplace_accept'), false);
  assert.equal(signs(t.signerCalls()), 1, 'only the post was signed');
  assert.equal(r.stdout, '');
  const job = t.state().job;
  assert.equal(job.job_id, 'job-1', 'the job id is kept');
  assert.equal('result' in job, false);
});

test('the state says "sending" before the send call, and drops it once the job id is written down', async () => {
  const t = setup();
  let during;
  const builder = await fakeBuilder({ onSend: () => { during = t.state().job; } });
  const r = await run(t.env(builder));
  assert.equal(r.code, 0, r.stderr);
  assert.equal(typeof during.sending, 'string', 'the marker was in the state file while the call was running');
  assert.equal('job_id' in during, false);
  const job = t.state().job;
  assert.equal(job.job_id, 'job-1');
  assert.equal('sending' in job, false);
});

test('a run killed during the send leaves "sending"; the next run stops with the recovery steps and sends nothing; with the job id written in, it goes on', async () => {
  const t = setup();
  let started;
  const sendStarted = new Promise((resolve) => { started = resolve; });
  const builder = await fakeBuilder({ hangSend: true, onSend: () => started() });
  const child = spawn(process.execPath, [SCRIPT], { env: t.env(builder), stdio: 'ignore' });
  const exited = once(child, 'exit');
  const giveUp = new Promise((_, reject) => setTimeout(() => reject(new Error('the script never reached the send')), 30_000).unref());
  await Promise.race([sendStarted, giveUp, exited.then(() => { throw new Error('the script ended before it sent the job'); })]);
  child.kill();
  await exited;
  for (const c of t.signerCalls()) { try { process.kill(c.pid); } catch { /* it has gone with its parent */ } } // the signer child of the killed script
  const afterKill = t.state();
  assert.equal(typeof afterKill.job.sending, 'string');
  assert.equal('job_id' in afterKill.job, false);

  builder.calls.length = 0;
  builder.opts.hangSend = false;
  const stopped = await run(t.env(builder));
  assert.equal(stopped.code, 1);
  assert.match(stopped.stderr, /recorded no job id/);
  assert.ok(stopped.stderr.includes(ESCROW_REF), 'names the escrow');
  for (const word of ['"job_id"', 'vector_marketplace_get_supplier', 'vector_build_marketplace_reclaim', 'deliver_by', 'Submitted']) assert.ok(stopped.stderr.includes(word), `the recovery steps mention ${word}`);
  assert.ok(stopped.stderr.includes(`/escrows/${encodeURIComponent(ESCROW_REF)}`), 'the one-row read of the escrow, with the # written as %23');
  assert.ok(stopped.stderr.includes('vector_build_marketplace_accept'), 'a Submitted escrow has one way to close');
  assert.ok(stopped.stderr.includes('"No live continuation of escrow <escrow_ref> found (spent, or not yet indexed); retry or check the explorer."'), 'the refusal of the accept tool, as PR 2 words it');
  assert.match(stopped.stderr, /ask once more, because the indexer can lag the ledger\. If it refuses again, the escrow is spent and the supplier has most likely released it/, 'one retry before concluding that the supplier released it');
  assert.doesNotMatch(stopped.stderr, /already closed/);
  assert.doesNotMatch(stopped.stderr, /newest row|accept by hand/);
  assert.deepEqual(builder.names(), [], 'the builder is asked nothing, the send least of all');

  // The operator found the id in the log of the first run and wrote it in.
  writeFileSync(t.files.state, JSON.stringify({ ...afterKill, job: { job_id: 'job-1' } }));
  const resumed = await run(t.env(builder));
  assert.equal(resumed.code, 0, resumed.stderr);
  assert.equal(builder.names().includes('vector_marketplace_send_job'), false);
  assert.equal(builder.names().includes('vector_marketplace_list_suppliers'), false, 'the job was sent, so the free list is not asked');
  assert.equal(JSON.parse(resumed.stdout).escrow_ref, ESCROW_REF);
});

test('a send that the tool reports as failed leaves no marker; the free list is asked again before the send is tried again', async () => {
  const builder = await fakeBuilder({ sendFails: 1 });
  const t = setup();
  const first = await run(t.env(builder));
  assert.equal(first.code, 1);
  assert.match(first.stderr, /vector_marketplace_send_job failed: Failed to send job/);
  assert.equal(t.state().post.confirmed, true, 'the post is done');
  assert.equal('sending' in t.state().job, false, 'a failure the tool reported is a known outcome, not a maybe');

  builder.calls.length = 0;
  builder.opts.listed = false; // the post is signed, but the job is not sent: the supplier must still be free
  const refused = await run(t.env(builder));
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /is not among the free suppliers/);
  assert.ok(refused.stderr.includes(`An earlier run already posted escrow ${ESCROW_REF}`), 'the escrow that is already posted');
  for (const word of ['still Open', 'vector_build_marketplace_reclaim', 'deliver_by', 'move', 'start a new run']) assert.ok(refused.stderr.includes(word), `the stop says ${word}`);
  assert.doesNotMatch(refused.stderr, /never recorded/, 'the post was confirmed, so there is nothing to doubt');
  assert.deepEqual(builder.names(), ['vector_marketplace_list_suppliers']);

  builder.calls.length = 0;
  builder.opts.listed = true;
  const second = await run(t.env(builder));
  assert.equal(second.code, 0, second.stderr);
  assert.deepEqual(builder.names().slice(0, 3), ['vector_marketplace_list_suppliers', 'vector_marketplace_send_job', 'vector_marketplace_get_job']);
  assert.equal(builder.names().includes('vector_build_marketplace_post_escrow'), false);
});

test('a post whose confirmation was never recorded is not called Open: the stop says what to do if the transaction is on the explorer and points to the "is not among the free suppliers" row of docs/E2E.md', async () => {
  const builder = await fakeBuilder({ notConfirmed: [TX.post] });
  const t = setup();
  const first = await run(t.env(builder));
  assert.equal(first.code, 1);
  assert.match(first.stderr, /not confirmed yet/);
  assert.equal(t.state().post.confirmed, undefined, 'the confirmation was never recorded');

  builder.calls.length = 0;
  builder.opts.listed = false; // the advert is no longer free, and the post of the first run is signed but not known to be on the ledger
  const refused = await run(t.env(builder));
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /is not among the free suppliers/);
  assert.ok(refused.stderr.includes(`An earlier run signed escrow ${ESCROW_REF} in transaction ${TX.post} and never recorded that it was confirmed`), 'names the escrow and its transaction');
  assert.ok(refused.stderr.includes('so that escrow may not be on the ledger, and nothing was sent to the supplier'));
  assert.doesNotMatch(refused.stderr, /still Open|already posted/, 'an escrow that may not exist is not called Open');
  const when = new Date(Number(t.state().post.deliver_by)).toISOString();
  assert.ok(refused.stderr.includes(`Look the transaction up on the explorer. If it is there, the escrow is Open: reclaim it with vector_build_marketplace_reclaim after deliver_by (${when}), then move ${t.files.state} away and start a new run.`), 'the way out when the transaction is on the explorer');
  assert.ok(refused.stderr.includes('If it is not there, follow the row "is not among the free suppliers" in docs/E2E.md ("If a run stops").'), 'the row whose way out applies');
  assert.ok(refused.stderr.includes('While the advert is not free, running the script again stops at the same check.'));
  assert.doesNotMatch(refused.stderr, /not confirmed on every rerun/, 'not the row that says to run the script again');
  assert.deepEqual(builder.names(), ['vector_marketplace_list_suppliers']);
});

test('a send answered without a job id keeps the marker, because the supplier may have claimed; the next run stops', async () => {
  const builder = await fakeBuilder({ sendAnswer: '# Job sent\n\nno data block in this answer' });
  const t = setup();
  const first = await run(t.env(builder));
  assert.equal(first.code, 1);
  assert.match(first.stderr, /answered without a job id/);
  assert.equal(typeof t.state().job.sending, 'string');
  builder.calls.length = 0;
  const second = await run(t.env(builder));
  assert.equal(second.code, 1);
  assert.match(second.stderr, /recorded no job id/);
  assert.deepEqual(builder.names(), []);
});

test('a send whose connection breaks before any answer keeps the marker, because the supplier may have claimed; the next run stops', async () => {
  const builder = await fakeBuilder({ dropSend: true });
  const t = setup();
  const first = await run(t.env(builder));
  assert.equal(first.code, 1);
  assert.match(first.stderr, /vector_marketplace_send_job gave no answer/);
  assert.equal(typeof t.state().job.sending, 'string');
  builder.calls.length = 0;
  builder.opts.dropSend = false;
  const second = await run(t.env(builder));
  assert.equal(second.code, 1);
  assert.match(second.stderr, /recorded no job id/);
  assert.deepEqual(builder.names(), []);
});

test('the state is written through a temporary file: when that file cannot be written, the state file is left exactly as it was', async () => {
  const builder = await fakeBuilder({ pending: 1, deliverBy: Date.now() - 1000 });
  const t = setup();
  const first = await run(t.env(builder));
  assert.equal(first.code, 1); // stopped after the send, with a state worth keeping
  const before = readFileSync(t.files.state, 'utf8');
  mkdirSync(`${t.files.state}.tmp`); // a directory where the temporary file would go
  builder.calls.length = 0;
  const second = await run(t.env(builder));
  assert.equal(second.code, 1);
  assert.match(second.stderr, /unexpected error/);
  assert.equal(readFileSync(t.files.state, 'utf8'), before, 'the state file was not touched');
});

test('a rerun continues where the last run stopped: a post that was not confirmed is submitted again, not built and signed again', async () => {
  const builder = await fakeBuilder({ notConfirmed: [TX.post] });
  const t = setup();
  const first = await run(t.env(builder));
  assert.equal(first.code, 1);
  assert.match(first.stderr, /not confirmed yet/);
  assert.equal(builder.names().filter((n) => n === 'vector_await_transaction').length, 4, 'four slices of 90 s before it gives up');
  assert.equal(t.state().post.confirmed, undefined);
  builder.calls.length = 0;
  builder.opts.notConfirmed = [];
  const second = await run(t.env(builder));
  assert.equal(second.code, 0, second.stderr);
  assert.equal(builder.names().includes('vector_build_marketplace_post_escrow'), false, 'the escrow is not built twice');
  assert.deepEqual(builder.calls.filter((c) => c.name === 'vector_submit_transaction')[0].args.signedTxCbor, `ff${UNSIGNED.post}`, 'the same signed transaction is submitted again');
  assert.equal(signs(t.signerCalls()), 2, 'the post is signed once in two runs, and the accept once');
  assert.equal(JSON.parse(second.stdout).escrow_ref, ESCROW_REF);
});

test('a rerun after the job was sent continues although the supplier now shows as busy with our own job', async () => {
  const builder = await fakeBuilder({ pending: 1, deliverBy: Date.now() - 1000 });
  const t = setup();
  const first = await run(t.env(builder));
  assert.equal(first.code, 1);
  assert.match(first.stderr, /did not finish before deliver_by/);
  assertChecksTheEscrow(first.stderr); // a stalled job is not known to be unsubmitted either

  // A dry run over this state shows what is done: the post (four calls) and the send, not the poll.
  const dry = await run(t.env(builder), ['--dry-run']);
  assert.equal(dry.code, 0, dry.stderr);
  const lines = dry.stdout.split('\n').filter((l) => /^ ?\d+\. /.test(l));
  assert.equal(lines.length, 11);
  assert.deepEqual(lines.map((l) => l.includes('done in an earlier run, skipped')), [true, true, true, true, true, false, false, false, false, false, false]);
  assert.match(lines[5], /repeated until done or deliver_by/);

  builder.calls.length = 0;
  builder.opts.listed = false; // a busy supplier is not in the free list
  const second = await run(t.env(builder));
  assert.equal(second.code, 0, second.stderr);
  assert.deepEqual(builder.names(), ['vector_marketplace_get_job', 'vector_marketplace_verify_receipt', 'vector_build_marketplace_accept', 'vector_submit_transaction', 'vector_await_transaction']);
});

test('a finished run is not repeated: a rerun prints the same evidence and builds, signs and sends nothing', async () => {
  const builder = await fakeBuilder();
  const t = setup();
  const first = await run(t.env(builder));
  assert.equal(first.code, 0, first.stderr);
  builder.calls.length = 0;
  const signed = signs(t.signerCalls());
  const again = await run(t.env(builder));
  assert.equal(again.code, 0, again.stderr);
  assert.deepEqual(JSON.parse(again.stdout), JSON.parse(first.stdout));
  assert.deepEqual(builder.names(), [], 'the builder is not asked anything');
  assert.equal(signs(t.signerCalls()), signed);
});

test('--dry-run over a finished state marks every step as done, calls nothing and leaves the state as it was', async () => {
  const builder = await fakeBuilder();
  const t = setup();
  const first = await run(t.env(builder));
  assert.equal(first.code, 0, first.stderr);
  builder.calls.length = 0;
  const before = readFileSync(t.files.state, 'utf8');
  const dry = await run(t.env(builder), ['--dry-run']);
  assert.equal(dry.code, 0, dry.stderr);
  assert.equal((dry.stdout.match(/done in an earlier run, skipped/g) ?? []).length, 11, 'all eleven calls are marked as done');
  assert.match(dry.stderr, /this run finished earlier/);
  assert.deepEqual(builder.names(), []);
  assert.equal(readFileSync(t.files.state, 'utf8'), before);
});

test('a signer refusal stops the run before anything is submitted', async () => {
  const builder = await fakeBuilder();
  const t = setup();
  const r = await run(t.env(builder, { VECTOR_SIGNER_SPEND_LIMIT_PER_TX: '1000000' })); // the fake moves 3.5 units per transaction
  assert.equal(r.code, 1);
  assert.match(r.stderr, /REFUSED/);
  assert.equal(builder.names().includes('vector_submit_transaction'), false);
  assert.equal(r.stdout, '');
});

test('refuses an advert that is not among the free suppliers, before anything is built', async () => {
  const builder = await fakeBuilder({ listed: false });
  const r = await run(setup().env(builder));
  assert.equal(r.code, 1);
  assert.match(r.stderr, new RegExp(ADVERT_REF));
  assert.doesNotMatch(r.stderr, /already posted/, 'no escrow was posted by an earlier run, so none is mentioned');
  assert.deepEqual(builder.names(), ['vector_marketplace_list_suppliers']);
});

test('refuses a state file that belongs to another run', async () => {
  const builder = await fakeBuilder();
  const t = setup();
  writeFileSync(t.files.state, JSON.stringify({ run: { advert_ref: `${'bb'.repeat(32)}#0`, payload: PAYLOAD, address: ADDRESS } }));
  const r = await run(t.env(builder));
  assert.equal(r.code, 1);
  assert.match(r.stderr, /another run/);
  assert.equal(builder.names().includes('vector_build_marketplace_post_escrow'), false);
});

test('takes argument names from the server: the report text goes in "output" when the tool calls it that (the merged tool says "result"), and a tool without an argument fails loudly', async () => {
  const renamed = { ...SCHEMAS.vector_marketplace_verify_receipt, properties: { escrow_ref: {}, receipt: {}, receipt_signature: {}, output: {} } };
  const builder = await fakeBuilder({ schemas: { vector_marketplace_verify_receipt: renamed } });
  const ok = await run(setup().env(builder));
  assert.equal(ok.code, 0, ok.stderr);
  const verify = builder.calls.find((c) => c.name === 'vector_marketplace_verify_receipt').args;
  assert.equal(verify.output, REPORT); assert.equal('result' in verify, false);

  const strict = await fakeBuilder({ schemas: { vector_build_marketplace_post_escrow: schema(['changeAddress', 'payload']) } });
  const bad = await run(setup().env(strict));
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /vector_build_marketplace_post_escrow has no argument advert_ref/);
  assert.equal(strict.names().includes('vector_build_marketplace_post_escrow'), false);
});

test('a tool that requires an argument the script does not send stops a fresh run before any transaction is built, and the dry run says so too', async () => {
  // The merged send requires buyerAddress. Here it requires one more, which nothing in the script knows about.
  const builder = await fakeBuilder({ schemas: { vector_marketplace_send_job: schema(['escrow_ref', 'payload', 'buyerAddress', 'route']) } });
  const t = setup();
  for (const args of [[], ['--dry-run']]) {
    const r = await run(t.env(builder), args);
    assert.equal(r.code, 1, args.join(' ') || 'a real run');
    assert.match(r.stderr, /vector_marketplace_send_job requires route, which the call lacks/);
    assert.equal(r.stdout, '', 'neither a plan nor evidence');
  }
  assert.deepEqual(builder.calls, [], 'the builder was asked nothing: no supplier list, no escrow built');
  assert.deepEqual(t.signerCalls().map((c) => c.name), ['vector_signer_get_address', 'vector_signer_get_address'], 'the signer was asked for its address and for nothing else');
  assert.equal('post' in t.state(), false, 'no transaction was built or signed');
});

test('a rerun past the post still refuses a call that lacks a required argument, before the tool is called', async () => {
  const builder = await fakeBuilder({ pending: 1, deliverBy: Date.now() - 1000 });
  const t = setup();
  const first = await run(t.env(builder));
  assert.equal(first.code, 1);
  assert.match(first.stderr, /did not finish before deliver_by/);
  builder.calls.length = 0;
  builder.opts.schemas = { vector_marketplace_get_job: schema(['escrow_ref', 'job_id', 'buyerAddress', 'route']) }; // the poll now requires one more
  const second = await run(t.env(builder));
  assert.equal(second.code, 1);
  assert.match(second.stderr, /vector_marketplace_get_job requires route, which the call lacks/);
  assert.deepEqual(builder.names(), [], 'the poll was not called');
});

test('a receipt check that stays incomplete is not a pass: the run does not accept, and the skipped row is in its message', async () => {
  const builder = await fakeBuilder({ verifyFailures: 99 }); // the ledger never shows the supplier's Submit, so check 5 stays skipped
  const t = setup();
  const r = await run(t.env(builder));
  assert.equal(r.code, 1);
  assert.match(r.stderr, /NOT accepting/);
  assert.match(r.stderr, /"on_chain_hash_matches":"skipped"/);
  assert.equal(builder.names().filter((n) => n === 'vector_marketplace_verify_receipt').length, 6, 'six tries');
  assert.equal(builder.names().includes('vector_build_marketplace_accept'), false);
  assert.equal(signs(t.signerCalls()), 1, 'only the post was signed');
  assert.equal(r.stdout, '');
});

// ---- CAPABILITY_ID (ruling R49): one audited hire path for every agent ----
// The script looked the advert up under Agent History's capability only, so it stopped before it posted anything for the advert of another agent, the Pipeline's included.
const PIPELINE_CAPABILITY = 'document.pipeline.ocr-summary.v1';
// The settings of docs/E2E.md for Document Pipeline: a request JSON for one page of a PDF by URL (and a pause of 15 s, which nothing here waits for).
const PIPELINE_PAYLOAD = '{"source":{"url":"https://example.org/letter.pdf"},"task":"summary","language":"en","max_pages":1}';

test("CAPABILITY_ID is the capability the free list is asked for and the stop names, and its default is Agent History's", async () => {
  const builder = await fakeBuilder({ listed: false });
  const byDefault = await run(setup().env(builder));
  assert.equal(byDefault.code, 1);
  assert.deepEqual(builder.calls.map((c) => [c.name, c.args]), [['vector_marketplace_list_suppliers', { capability_id: 'identity.history.report.v1', limit: 50 }]]);
  assert.ok(byDefault.stderr.includes(`${ADVERT_REF} is not among the free suppliers for identity.history.report.v1.`));

  builder.calls.length = 0;
  const named = await run(setup().env(builder, { CAPABILITY_ID: PIPELINE_CAPABILITY }));
  assert.equal(named.code, 1);
  assert.deepEqual(builder.calls.map((c) => [c.name, c.args]), [['vector_marketplace_list_suppliers', { capability_id: PIPELINE_CAPABILITY, limit: 50 }]]);
  assert.ok(named.stderr.includes(`${ADVERT_REF} is not among the free suppliers for ${PIPELINE_CAPABILITY}.`));
  assert.equal(named.stderr.includes('identity.history.report.v1'), false, 'the stop names the capability that was asked for, and no other');
});

test("the Pipeline's settings hire an advert of its capability and the evidence names that capability; without CAPABILITY_ID the same run stops before anything is built", async () => {
  const builder = await fakeBuilder({ capability: PIPELINE_CAPABILITY, pending: 0 });
  const stopped = await run(setup().env(builder, { PAYLOAD: PIPELINE_PAYLOAD }));
  assert.equal(stopped.code, 1);
  assert.match(stopped.stderr, /is not among the free suppliers for identity[.]history[.]report[.]v1/);
  assert.deepEqual(builder.names(), ['vector_marketplace_list_suppliers'], 'nothing was built');

  builder.calls.length = 0;
  const r = await run(setup().env(builder, { CAPABILITY_ID: PIPELINE_CAPABILITY, PAYLOAD: PIPELINE_PAYLOAD, E2E_POLL_MS: '15000' }));
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(builder.calls[0], { name: 'vector_marketplace_list_suppliers', args: { capability_id: PIPELINE_CAPABILITY, limit: 50 } });
  assert.deepEqual(builder.calls.find((c) => c.name === 'vector_build_marketplace_post_escrow').args, { changeAddress: ADDRESS, advert_ref: ADVERT_REF, payload: PIPELINE_PAYLOAD });
  assert.deepEqual(builder.calls.find((c) => c.name === 'vector_marketplace_send_job').args, { escrow_ref: ESCROW_REF, payload: PIPELINE_PAYLOAD, buyerAddress: ADDRESS });
  const evidence = JSON.parse(r.stdout);
  assert.equal(evidence.capability_id, PIPELINE_CAPABILITY);
  assert.equal(evidence.run, 'first-party');
  assert.equal(evidence.verdict, 'VERIFIED');
});

test('a CAPABILITY_ID that is empty or has a space in it exits 2, before anything is connected', async () => {
  const builder = await fakeBuilder();
  const t = setup();
  for (const bad of ['', ' ', 'two words', `${PIPELINE_CAPABILITY} `]) {
    const r = await run(t.env(builder, { CAPABILITY_ID: bad }));
    assert.equal(r.code, 2, JSON.stringify(bad));
    assert.ok(r.stderr.includes(`CAPABILITY_ID must be a capability id such as identity.history.report.v1, got "${bad}"`), JSON.stringify(bad));
  }
  assert.deepEqual(builder.calls, []);
  assert.deepEqual(t.signerCalls(), []);
});

test('key material: the signer gets the VECTOR_SIGNER_ settings and nothing else of this shell, and no setting value is printed or stored', async () => {
  const canary = ['canary', 'secret'].join('-').repeat(6);
  const builder = await fakeBuilder();
  const t = setup();
  const r = await run(t.env(builder, { VECTOR_SIGNER_PRIVATE_KEY: canary, VECTOR_SIGNER_ADDRESS: ADDRESS, VECTOR_SIGNER_SPEND_LIMIT_PER_TX: '100000000' }));
  assert.equal(r.code, 0, r.stderr);
  for (const text of [r.stdout, r.stderr, readFileSync(t.files.state, 'utf8')]) assert.equal(text.includes(canary), false);
  const seen = t.signerCalls()[0];
  assert.deepEqual(seen.vectorSettings, ['VECTOR_SIGNER_ADDRESS', 'VECTOR_SIGNER_AUDIT_LOG_PATH', 'VECTOR_SIGNER_PRIVATE_KEY', 'VECTOR_SIGNER_SPEND_LIMIT_PER_TX']);
  assert.deepEqual(seen.scriptSettings, [], 'ADVERT_REF, PAYLOAD, E2E_STATE and the other settings of the script stay with the script');
});
