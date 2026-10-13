import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, readFileSync, existsSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';

// scripts/e2e-hire.mjs against a fake builder (an MCP server over HTTP, here) and a fake signer (an MCP server over stdio,
// scripts/fixtures/fake-signer.mjs). Nothing here touches a network beyond 127.0.0.1, a key or a ledger. The fakes answer in the
// shapes the real tools are specified to answer in (docs/superpowers/specs, section 5).
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
const schema = (...names) => ({ type: 'object', properties: Object.fromEntries(names.map((n) => [n, { type: 'string' }])) });
const SCHEMAS = {
  vector_marketplace_list_capabilities: schema(),
  vector_marketplace_list_suppliers: schema('capability_id', 'only_free', 'limit'),
  vector_marketplace_get_supplier: schema('advert_ref'),
  vector_build_marketplace_post_escrow: schema('changeAddress', 'advert_ref', 'payload', 'deliver_by_ms'),
  vector_build_marketplace_accept: schema('changeAddress', 'escrow_ref'),
  vector_build_marketplace_reclaim: schema('changeAddress', 'escrow_ref'),
  vector_marketplace_send_job: schema('escrow_ref', 'payload', 'route'),
  vector_marketplace_get_job: schema('escrow_ref', 'job_id', 'route'),
  vector_marketplace_verify_receipt: schema('escrow_ref', 'receipt', 'receipt_signature', 'output', 'supplier_pub_key_hex'),
  vector_submit_transaction: schema('signedTxCbor'),
  vector_await_transaction: schema('txHash', 'timeoutSeconds'),
};
const NINE = Object.keys(SCHEMAS).filter((n) => /marketplace/.test(n));
const UNSIGNED = { post: 'ab'.repeat(80), accept: 'cd'.repeat(80) };
const TX = { post: sha(UNSIGNED.post), accept: sha(UNSIGNED.accept) };
const ESCROW_REF = `${TX.post}#0`;

// opts (read at call time, so a test can change them between two runs): tools, schemas, listed, pending, verified, verifyFailures, notConfirmed, submitHash, deliverBy.
const builders = [];
async function fakeBuilder(opts = {}) {
  const calls = [];
  let polls = 0, verifies = 0;
  const handlers = {
    vector_marketplace_list_capabilities: () => withJson('# Marketplace capabilities', [{ capability_id: CAPABILITY, supplier_count: 1 }]),
    vector_marketplace_list_suppliers: () => (opts.listed === false ? 'No suppliers found for identity.history.report.v1 with status free.' : withJson('# Marketplace suppliers', [{ advert_ref: ADVERT_REF, capability_id: CAPABILITY, model: 'agent-history-v1', price_lovelace: '1000000' }])),
    vector_build_marketplace_post_escrow: () => withJson(`# Unsigned Escrow Post Built (Not Submitted)\n\n**Unsigned TX CBOR:**\n\`\`\`\n${UNSIGNED.post}\n\`\`\``, { escrow_ref: ESCROW_REF, lock_lovelace: '3000000', deliver_by: opts.deliverBy ?? Date.now() + 480_000, tx_hash: TX.post, fee: '500000' }),
    vector_build_marketplace_accept: () => withJson(`# Unsigned Accept Built (Not Submitted)\n\n**Unsigned TX CBOR:**\n\`\`\`\n${UNSIGNED.accept}\n\`\`\``, { escrow_ref: ESCROW_REF, tx_hash: TX.accept, supplier_lovelace: '2000000', buyer_lovelace: '1000000', seconds_left: 540 }),
    vector_submit_transaction: ({ signedTxCbor }) => {
      const hash = opts.submitHash ?? sha(signedTxCbor.slice(2)); // submitHash: the ledger reports a transaction other than the one given
      return `# Transaction Submitted\n\nTransaction Hash: ${hash}\n\n[View on Explorer](https://explorer.example/transaction/${hash})`;
    },
    vector_await_transaction: ({ txHash }) => ((opts.notConfirmed ?? []).includes(txHash) ? `# Not Confirmed Yet\n\nTransaction ${txHash} did not appear on-chain within 180s.` : `# Transaction Confirmed\n\nTransaction Hash: ${txHash}`),
    vector_marketplace_send_job: () => withJson('# Job sent', { jobId: 'job-1', status: 'accepted', route: 'template', capabilityId: CAPABILITY }),
    vector_marketplace_get_job: () => (++polls <= (opts.pending ?? 1) ? withJson('# Job job-1: running', { state: 'pending', status: 'running' }) : withJson('# Job job-1: done', { state: 'done', result: REPORT, receipt: { ...RECEIPT, escrow_ref: ESCROW_REF }, receipt_signature: SIGNATURE, supplier_pkh: RECEIPT.supplier_pkh })),
    vector_marketplace_verify_receipt: () => {
      const ok = opts.verified !== false && ++verifies > (opts.verifyFailures ?? 0); // verifyFailures: the ledger lags, the first answers say the on-chain hash is missing
      return withJson('# Receipt verification', { verified: ok, checks: { escrow_ref_matches: true, response_hash_matches: true, pub_key_is_supplier: true, signature_valid: opts.verified !== false, on_chain_hash_matches: ok } });
    },
  };
  const toolList = () => (opts.tools ?? Object.keys(SCHEMAS)).map((name) => ({ name, description: name, inputSchema: opts.schemas?.[name] ?? SCHEMAS[name] }));
  const http = createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/mcp') { res.writeHead(405, { allow: 'POST' }).end(); return; }
    const chunks = []; for await (const c of req) chunks.push(c);
    const mcp = new Server({ name: 'fake-builder', version: '0.0.0' }, { capabilities: { tools: {} } });
    mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: toolList() }));
    mcp.setRequestHandler(CallToolRequestSchema, async (r) => {
      calls.push({ name: r.params.name, args: r.params.arguments ?? {} });
      const handler = handlers[r.params.name];
      return handler ? { content: [{ type: 'text', text: handler(r.params.arguments ?? {}) }] } : { isError: true, content: [{ type: 'text', text: `unknown tool ${r.params.name}` }] };
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { transport.close(); mcp.close(); });
    await mcp.connect(transport);
    await transport.handleRequest(req, res, JSON.parse(Buffer.concat(chunks).toString('utf8')));
  });
  await new Promise((resolve) => http.listen(0, '127.0.0.1', resolve));
  const builder = { url: `http://127.0.0.1:${http.address().port}/mcp`, calls, opts, names: () => calls.map((c) => c.name), close: () => http.close() };
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
    ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(VECTOR_|BUILDER_URL|SIGNER_ENTRY|ADVERT_REF|PAYLOAD|E2E_|EXPLORER_URL)/.test(k))),
    BUILDER_URL: builder.url, SIGNER_ENTRY: FAKE_SIGNER, ADVERT_REF, PAYLOAD, E2E_STATE: files.state, E2E_POLL_MS: '10', VECTOR_SIGNER_AUDIT_LOG_PATH: files.signerLog, ...overrides, ...extra,
  });
  return { dir, files, signerCalls, env };
}
function run(env, args = []) {
  return new Promise((resolve) => execFile(process.execPath, [SCRIPT, ...args], { env, timeout: 90_000 }, (error, stdout, stderr) => resolve({ code: error ? (error.code ?? 1) : 0, stdout, stderr })));
}
const signs = (calls) => calls.filter((c) => c.name === 'vector_signer_sign').length;

test('stops at once when the builder lacks the marketplace tools, and names all nine (the hosted server today)', async () => {
  const builder = await fakeBuilder({ tools: ['vector_submit_transaction', 'vector_await_transaction'] });
  const t = setup();
  const r = await run(t.env(builder));
  assert.equal(r.code, 3);
  for (const tool of NINE) assert.ok(r.stderr.includes(tool), `names ${tool}`);
  assert.match(r.stderr, /PR 1/); assert.match(r.stderr, /PR 2/); assert.match(r.stderr, /PR 3/);
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
  assert.equal(JSON.parse(readFileSync(t.files.state, 'utf8')).post.confirmed, undefined);
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
  assert.deepEqual(byName('vector_marketplace_send_job')[0].args, { escrow_ref: ESCROW_REF, payload: PAYLOAD });
  assert.deepEqual(byName('vector_marketplace_verify_receipt')[0].args, { escrow_ref: ESCROW_REF, receipt: { ...RECEIPT, escrow_ref: ESCROW_REF }, receipt_signature: SIGNATURE, output: REPORT });
  assert.deepEqual(byName('vector_submit_transaction').map((c) => c.args.signedTxCbor), [`ff${UNSIGNED.post}`, `ff${UNSIGNED.accept}`], 'what the signer returned is what was submitted');
  assert.deepEqual(byName('vector_await_transaction').map((c) => c.args.txHash), [TX.post, TX.accept]);
  assert.deepEqual(t.signerCalls().map((c) => c.name), ['vector_signer_get_address', 'vector_signer_sign', 'vector_signer_sign']);
  const evidence = JSON.parse(r.stdout);
  assert.equal(evidence.run, 'first-party');
  assert.equal(evidence.verdict, 'VERIFIED');
  assert.deepEqual({ escrow_ref: evidence.escrow_ref, post_tx: evidence.post_tx, accept_tx: evidence.accept_tx }, { escrow_ref: ESCROW_REF, post_tx: TX.post, accept_tx: TX.accept });
  assert.equal(evidence.explorer.post, `https://explorer.vector.mainnet.apexfusion.org/transaction/hash/${TX.post}`);
  assert.equal(evidence.explorer.accept, `https://explorer.vector.mainnet.apexfusion.org/transaction/hash/${TX.accept}`);
  assert.deepEqual(evidence.receipt, { ...RECEIPT, escrow_ref: ESCROW_REF });
  assert.equal(evidence.receipt_signature, SIGNATURE);
  assert.equal(evidence.result_sha256, sha(REPORT));
  const state = JSON.parse(readFileSync(t.files.state, 'utf8'));
  assert.equal(state.post.confirmed, true); assert.equal(state.accept.confirmed, true);
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

test('a rerun after the job was sent continues although the supplier now shows as busy with our own job', async () => {
  const builder = await fakeBuilder({ pending: 1, deliverBy: Date.now() - 1000 });
  const t = setup();
  const first = await run(t.env(builder));
  assert.equal(first.code, 1);
  assert.match(first.stderr, /did not finish before deliver_by/);
  builder.calls.length = 0;
  builder.opts.listed = false; // a busy supplier is not in the free list
  const second = await run(t.env(builder));
  assert.equal(second.code, 0, second.stderr);
  assert.deepEqual(builder.names(), ['vector_marketplace_get_job', 'vector_marketplace_verify_receipt', 'vector_build_marketplace_accept', 'vector_submit_transaction', 'vector_await_transaction']);
});

test('a rerun continues where the last run stopped: a post that was not confirmed is submitted again, not built and signed again', async () => {
  const builder = await fakeBuilder({ notConfirmed: [TX.post] });
  const t = setup();
  const first = await run(t.env(builder));
  assert.equal(first.code, 1);
  assert.match(first.stderr, /not confirmed yet/);
  assert.equal(JSON.parse(readFileSync(t.files.state, 'utf8')).post.confirmed, undefined);
  builder.calls.length = 0;
  builder.opts.notConfirmed = [];
  const second = await run(t.env(builder));
  assert.equal(second.code, 0, second.stderr);
  assert.equal(builder.names().includes('vector_build_marketplace_post_escrow'), false, 'the escrow is not built twice');
  assert.deepEqual(builder.calls.filter((c) => c.name === 'vector_submit_transaction')[0].args.signedTxCbor, `ff${UNSIGNED.post}`, 'the same signed transaction is submitted again');
  assert.equal(signs(t.signerCalls()), 2, 'the post is signed once in two runs, and the accept once');
  assert.equal(JSON.parse(second.stdout).escrow_ref, ESCROW_REF);
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

test('takes argument names from the server: the receipt text goes in "result" when the tool calls it that, and a tool without an argument fails loudly', async () => {
  const renamed = { ...SCHEMAS.vector_marketplace_verify_receipt, properties: { escrow_ref: {}, receipt: {}, receipt_signature: {}, result: {} } };
  const builder = await fakeBuilder({ schemas: { vector_marketplace_verify_receipt: renamed } });
  const ok = await run(setup().env(builder));
  assert.equal(ok.code, 0, ok.stderr);
  const verify = builder.calls.find((c) => c.name === 'vector_marketplace_verify_receipt').args;
  assert.equal(verify.result, REPORT); assert.equal('output' in verify, false);

  const strict = await fakeBuilder({ schemas: { vector_build_marketplace_post_escrow: schema('changeAddress', 'payload') } });
  const bad = await run(setup().env(strict));
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /vector_build_marketplace_post_escrow has no argument advert_ref/);
  assert.equal(strict.names().includes('vector_build_marketplace_post_escrow'), false);
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
