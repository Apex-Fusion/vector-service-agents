// scripts/e2e-hire.mjs - our own first-party hire of Agent History through the MCP tools. See docs/E2E.md.
//
// It drives two MCP servers with the official SDK. The builder (the hosted server, or a local build of the marketplace PRs) reads the
// ledger and builds unsigned transactions. The signer holds the key and signs. This script holds no key and prints none: it starts
// the signer with the VECTOR_SIGNER_ settings of this shell and nothing else, and reads the signer's address from the signer's own tool.
//
// Settings, from the environment:
//   BUILDER_URL   the builder's MCP endpoint (default: the hosted server)
//   SIGNER_ENTRY  path of the signer's build/index.js (required)
//   ADVERT_REF    the advert to hire, <txid>#<index> (required)
//   PAYLOAD       the request JSON (default: the ChandraOCR subject of the guide)
//   E2E_STATE     the state file (default ./e2e-state.json). A rerun continues where the last run stopped
//   E2E_POLL_MS   pause between two polls of the job (default 5000)
//   EXPLORER_URL  base of the explorer links in the evidence (default: the mainnet explorer)
// Flag: --dry-run reads and prints. It signs, submits, posts and sends nothing, and writes no state.
// Output: the steps go to stderr. The evidence of a finished run is one JSON object on stdout.
// Exit: 0 done, 1 a step failed, 2 a setting is missing, 3 the builder or the signer lacks tools.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const env = process.env;
const DRY = process.argv.includes('--dry-run');
const CAPABILITY = 'identity.history.report.v1';
const DEFAULT_PAYLOAD = '{"subject":"did:vector:agent:be1a0a2912da180757ed3cd61b56bb8eab0188c19dc3c0e3912d2c01:5542837bc3a6ccd66cb75ac91a796cf5716d439f4a72594bbfc06db7231029db"}';
// The nine marketplace tools and the PR of Apex-Fusion/mcp-server that brings each. All nine are required: a hire without the
// reclaim tool can strand funds, so a builder that lacks it is not ready for an outside member either.
const PR_OF = {
  vector_marketplace_list_capabilities: 'PR 1 (read tools)', vector_marketplace_list_suppliers: 'PR 1 (read tools)', vector_marketplace_get_supplier: 'PR 1 (read tools)',
  vector_build_marketplace_post_escrow: 'PR 2 (build tools)', vector_build_marketplace_accept: 'PR 2 (build tools)', vector_build_marketplace_reclaim: 'PR 2 (build tools)',
  vector_marketplace_send_job: 'PR 3 (job transport)', vector_marketplace_get_job: 'PR 3 (job transport)', vector_marketplace_verify_receipt: 'PR 3 (job transport)',
};
const BUILDER_TOOLS = [...Object.keys(PR_OF), 'vector_submit_transaction', 'vector_await_transaction'];
const SIGNER_TOOLS = ['vector_signer_get_address', 'vector_signer_sign'];
const VERIFY_TRIES = 6;
const log = (s) => console.error(s);
class Fail extends Error { constructor(message, code = 1) { super(message); this.code = code; } }

// ---- settings ----
const missing = [];
const need = (k) => { if (!env[k]) missing.push(k); return env[k]; };
const BUILDER_URL = env.BUILDER_URL ?? 'https://mcp.vector.mainnet.apexfusion.org/mcp';
const SIGNER_ENTRY = need('SIGNER_ENTRY');
const ADVERT_REF = need('ADVERT_REF');
const PAYLOAD = env.PAYLOAD ?? DEFAULT_PAYLOAD;
const STATE_PATH = env.E2E_STATE ?? 'e2e-state.json';
const POLL_MS = Number(env.E2E_POLL_MS ?? 5000);
const EXPLORER_URL = (env.EXPLORER_URL ?? 'https://explorer.vector.mainnet.apexfusion.org').replace(/\/+$/, '');
if (missing.length) { log(`e2e-hire: set ${missing.join(' and ')} (see docs/E2E.md)`); process.exit(2); }
if (!/^[0-9a-f]{64}#\d+$/i.test(ADVERT_REF)) { log(`e2e-hire: ADVERT_REF must be <txid>#<index>, got "${ADVERT_REF}"`); process.exit(2); }
try { JSON.parse(PAYLOAD); } catch { log('e2e-hire: PAYLOAD must be the request JSON, a JSON document'); process.exit(2); }

// ---- reading what the tools answer ----
const textOf = (r) => (r.content ?? []).map((x) => x.text ?? '').join('\n');
const lastJson = (t) => { const m = [...t.matchAll(/```json\n([\s\S]*?)\n```/g)].at(-1); return m ? JSON.parse(m[1]) : null; };
const hexBlock = (t) => /```\n([0-9a-f]{100,})\n```/i.exec(t)?.[1] ?? null; // an unsigned or signed transaction: a fenced block of hex
const FAILED = /^(Failed\b|REFUSED\b|Could not\b|Rate limit exceeded)/m;
const firstLine = (t) => t.trim().split('\n')[0].slice(0, 300);
const shorten = (t) => t.replace(/[0-9a-f]{80,}/gi, (m) => `${m.slice(0, 24)}...(${m.length / 2} bytes)`).slice(0, 1500);
const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function toolsOf(client) {
  const out = []; let cursor;
  do { const r = await client.listTools(cursor ? { cursor } : undefined); out.push(...r.tools); cursor = r.nextCursor; } while (cursor);
  return new Map(out.map((t) => [t.name, t]));
}
// A call by name. The arguments are checked against the server's own schema first: a server drops an argument it does not know without a
// word, and a silently dropped argument is how a hash check ends up skipped.
async function call(side, name, args = {}, { timeoutMs = 120_000, allowFail = false } = {}) {
  const known = Object.keys(side.tools.get(name)?.inputSchema?.properties ?? {});
  const stray = Object.keys(args).filter((k) => !known.includes(k));
  if (stray.length) throw new Fail(`${name} has no argument ${stray.join(', ')}; it takes ${known.join(', ') || 'none'}`);
  const r = await side.client.callTool({ name, arguments: args }, undefined, { timeout: timeoutMs });
  const text = textOf(r);
  log(`\n== ${name}\n${shorten(text)}`);
  const failed = Boolean(r.isError) || FAILED.test(text);
  if (failed && !allowFail) throw new Fail(`${name} failed: ${firstLine(text)}`);
  return { text, json: lastJson(text), failed };
}

// ---- state: a rerun continues where the last run stopped ----
const state = existsSync(STATE_PATH) ? JSON.parse(readFileSync(STATE_PATH, 'utf8')) : {};
const save = () => { if (!DRY) writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + '\n'); };

// One transaction, in two recorded phases. Phase 1 builds and signs it once, and writes the signed bytes down before anything is submitted.
// Phase 2 submits and waits. A rerun therefore never builds or signs a second copy of the same step: it submits the first one again
// (the ledger takes a transaction once, so a repeat is harmless) and waits for it.
async function landTx(key, build, builder, signer) {
  const rec = (state[key] ??= {});
  if (!rec.signed_cbor) {
    const built = await build();
    const signed = await call(signer, 'vector_signer_sign', { txCbor: built.unsigned });
    const cbor = hexBlock(signed.text);
    if (!cbor) throw new Fail(`the signer returned no signed transaction for ${key}`);
    const signedHash = /^Hash: ([0-9a-f]{64})/m.exec(signed.text)?.[1];
    if (signedHash && signedHash !== built.tx_hash) throw new Fail(`the signer signed ${signedHash}, not the ${built.tx_hash} that the builder built`);
    Object.assign(rec, { tx_hash: built.tx_hash, signed_cbor: cbor, ...built.extra });
    save();
  }
  if (!rec.confirmed) {
    const sub = await call(builder, 'vector_submit_transaction', { signedTxCbor: rec.signed_cbor }, { allowFail: true });
    const submitted = /Transaction Hash: ([0-9a-f]{64})/.exec(sub.text)?.[1];
    if (!sub.failed && submitted !== rec.tx_hash) throw new Fail(`${key}: the ledger took ${submitted}, not ${rec.tx_hash}`);
    // A failed submit can mean "already in the ledger" on a rerun, so the wait decides; it is short when the submit failed.
    const wait = await call(builder, 'vector_await_transaction', { txHash: rec.tx_hash, timeoutSeconds: sub.failed ? 20 : 180 }, { timeoutMs: 230_000 });
    if (!/Transaction Confirmed/.test(wait.text)) {
      throw new Fail(sub.failed ? `${key}: the submit failed and ${rec.tx_hash} is not on the ledger: ${firstLine(sub.text)}` : `${key}: ${rec.tx_hash} is not confirmed yet. Run the script again to keep waiting`);
    }
    rec.confirmed = true;
    save();
  }
  return rec;
}

async function main(builder, signer) {
  // The signer's own tool says who the buyer is. The address is never taken from a setting.
  const address = /Signer address: (addr1[0-9a-z]+)/.exec((await call(signer, 'vector_signer_get_address')).text)?.[1];
  if (!address) throw new Fail('the signer did not return an address');
  const run = { advert_ref: ADVERT_REF, payload: PAYLOAD, address };
  if (state.run && JSON.stringify(state.run) !== JSON.stringify(run)) throw new Fail(`${STATE_PATH} belongs to another run (advert, payload or signer address differ). Move it away to start again`);
  state.run = run; save();
  if (state.accept?.confirmed) { log('this run finished earlier; its evidence follows'); return evidenceOf(); }

  // Read-only: before an escrow exists, the advert must be among the free suppliers of the capability. After that the supplier is
  // working for us and shows as busy, so a rerun must not ask again.
  if (!state.post?.signed_cbor) {
    const listed = (await call(builder, 'vector_marketplace_list_suppliers', { capability_id: CAPABILITY, limit: 50 })).json ?? [];
    if (!listed.some((s) => s.advert_ref?.toLowerCase() === ADVERT_REF.toLowerCase())) throw new Fail(`${ADVERT_REF} is not among the free suppliers for ${CAPABILITY}. It may be busy, retired or not advertised`);
  }

  const resultKey = ['output', 'result'].find((k) => k in (builder.tools.get('vector_marketplace_verify_receipt').inputSchema?.properties ?? {}));
  if (!resultKey) throw new Fail('vector_marketplace_verify_receipt takes neither "output" nor "result" for the report text');

  if (DRY) { printPlan(address, resultKey); return null; }

  // 1. Post the escrow: build, sign, submit, wait.
  const post = await landTx('post', async () => {
    const r = await call(builder, 'vector_build_marketplace_post_escrow', { changeAddress: address, advert_ref: ADVERT_REF, payload: PAYLOAD });
    const unsigned = hexBlock(r.text);
    if (!unsigned || !r.json?.escrow_ref || !r.json?.tx_hash) throw new Fail('the post tool returned no unsigned transaction, escrow_ref and tx_hash');
    return { unsigned, tx_hash: r.json.tx_hash, extra: { escrow_ref: r.json.escrow_ref, deliver_by: r.json.deliver_by, lock_lovelace: r.json.lock_lovelace } };
  }, builder, signer);
  log(`\nposted ${post.escrow_ref} in ${post.tx_hash}`);

  // 2. Send the job and poll it. The supplier claims the escrow on chain first, which takes up to 60 s.
  const job = (state.job ??= {});
  if (!job.job_id) {
    const sent = await call(builder, 'vector_marketplace_send_job', { escrow_ref: post.escrow_ref, payload: PAYLOAD }, { timeoutMs: 150_000 });
    job.job_id = sent.json?.jobId ?? sent.json?.job_id;
    if (!job.job_id) throw new Fail('the send tool returned no job id');
    save();
  }
  if (!job.result) {
    const until = Number(post.deliver_by) || Date.now() + 10 * 60_000;
    for (;;) {
      const polled = await call(builder, 'vector_marketplace_get_job', { escrow_ref: post.escrow_ref, job_id: job.job_id });
      const j = polled.json ?? {};
      if (j.state === 'done') { Object.assign(job, { result: j.result, receipt: j.receipt, receipt_signature: j.receipt_signature }); save(); break; }
      if (j.state === 'failed') throw new Fail(`the job failed: ${j.reason ?? ''} ${j.message ?? ''}`.trim() + `. Reclaim the escrow after deliver_by with vector_build_marketplace_reclaim`);
      if (Date.now() > until) throw new Fail('the job did not finish before deliver_by. Reclaim the escrow with vector_build_marketplace_reclaim');
      await sleep(POLL_MS);
    }
  }

  // 3. Verify, and accept only a receipt that passes. Declining does not refund: once the supplier has submitted, Release can follow.
  // The job can be done a moment before the ledger shows the supplier's Submit, and the last check reads the ledger: try a few times.
  let ver;
  for (let tries = 1; tries <= VERIFY_TRIES; tries++) {
    ver = await call(builder, 'vector_marketplace_verify_receipt', { escrow_ref: post.escrow_ref, receipt: job.receipt, receipt_signature: job.receipt_signature, [resultKey]: job.result });
    if (ver.json?.verified === true) break;
    if (tries < VERIFY_TRIES) { log(`not verified (try ${tries} of ${VERIFY_TRIES}); the ledger may lag the supplier's Submit`); await sleep(POLL_MS); }
  }
  if (ver.json?.verified !== true) throw new Fail(`NOT accepting: the receipt did not verify (${JSON.stringify(ver.json?.checks ?? firstLine(ver.text))}). The funds stay in the escrow; the supplier may Release after 600000 ms`);
  state.verify = { verified: true, checks: ver.json.checks }; save();

  // 4. Accept: build, sign, submit, wait.
  const accept = await landTx('accept', async () => {
    const r = await call(builder, 'vector_build_marketplace_accept', { changeAddress: address, escrow_ref: post.escrow_ref });
    const unsigned = hexBlock(r.text);
    if (!unsigned || !r.json?.tx_hash) throw new Fail('the accept tool returned no unsigned transaction and tx_hash');
    if (r.json.seconds_left < 120) log(`warning: only ${r.json.seconds_left} s are left in the accept window`);
    return { unsigned, tx_hash: r.json.tx_hash, extra: {} };
  }, builder, signer);

  return evidenceOf();
}

// What a finished run proves, read from the state: the escrow, the two transactions, the verdict and the receipt.
function evidenceOf() {
  const { post, accept, job, verify } = state;
  return {
    run: 'first-party', capability_id: CAPABILITY, builder: BUILDER_URL, advert_ref: ADVERT_REF,
    escrow_ref: post.escrow_ref, post_tx: post.tx_hash, accept_tx: accept.tx_hash,
    explorer: { post: `${EXPLORER_URL}/transaction/hash/${post.tx_hash}`, accept: `${EXPLORER_URL}/transaction/hash/${accept.tx_hash}` },
    verdict: 'VERIFIED', checks: verify.checks, receipt: job.receipt, receipt_signature: job.receipt_signature, result_sha256: sha256(job.result),
  };
}

// What a real run would do, in order, with the arguments it already knows. Printed by --dry-run.
function printPlan(address, resultKey) {
  const done = (k) => (state[k]?.confirmed ? ' (done in an earlier run, skipped)' : '');
  const steps = [
    ['vector_build_marketplace_post_escrow', { changeAddress: address, advert_ref: ADVERT_REF, payload: PAYLOAD }, done('post')],
    ['vector_signer_sign', { txCbor: '<unsigned post>' }, ''],
    ['vector_submit_transaction', { signedTxCbor: '<signed post>' }, ''],
    ['vector_await_transaction', { txHash: '<post tx>', timeoutSeconds: 180 }, ''],
    ['vector_marketplace_send_job', { escrow_ref: '<escrow_ref>', payload: PAYLOAD }, state.job?.job_id ? ' (sent in an earlier run, skipped)' : ''],
    ['vector_marketplace_get_job', { escrow_ref: '<escrow_ref>', job_id: '<job_id>' }, ' (repeated until done or deliver_by)'],
    ['vector_marketplace_verify_receipt', { escrow_ref: '<escrow_ref>', receipt: '<receipt>', receipt_signature: '<signature>', [resultKey]: '<report text>' }, ''],
    ['vector_build_marketplace_accept', { changeAddress: address, escrow_ref: '<escrow_ref>' }, done('accept')],
    ['vector_signer_sign', { txCbor: '<unsigned accept>' }, ''],
    ['vector_submit_transaction', { signedTxCbor: '<signed accept>' }, ''],
    ['vector_await_transaction', { txHash: '<accept tx>', timeoutSeconds: 180 }, ''],
  ];
  console.log(`dry run: ${steps.length} calls follow. Nothing is signed, submitted or sent.`);
  steps.forEach(([name, args, note], i) => console.log(`${String(i + 1).padStart(2)}. ${name} ${JSON.stringify(args)}${note}`));
}

// ---- connect, check the tools, run ----
let builder, signer, code = 0;
try {
  builder = { client: new Client({ name: 'e2e-hire', version: '0.1.0' }) };
  try { await builder.client.connect(new StreamableHTTPClientTransport(new URL(BUILDER_URL))); } catch (e) { throw new Fail(`cannot reach the builder at ${BUILDER_URL}: ${e.message}`); }
  builder.tools = await toolsOf(builder.client);
  const lacking = BUILDER_TOOLS.filter((t) => !builder.tools.has(t));
  if (lacking.length) {
    const byPr = Object.entries(Object.groupBy(lacking.filter((t) => PR_OF[t]), (t) => PR_OF[t])).map(([pr, names]) => `  ${pr}: ${names.join(', ')}`);
    const other = lacking.filter((t) => !PR_OF[t]);
    throw new Fail([`the builder at ${BUILDER_URL} lists ${builder.tools.size} tools and lacks these:`, ...byPr, ...(other.length ? [`  other: ${other.join(', ')}`] : []),
      'This run needs all nine marketplace tools. They arrive in three PRs to Apex-Fusion/mcp-server. Point BUILDER_URL at a builder that has them,',
      'for example a local build of the PR 3 branch: PORT=3300 node packages/builder/build/index.js, then BUILDER_URL=http://localhost:3300/mcp'].join('\n'), 3);
  }
  // Only the VECTOR_SIGNER_ settings go to the signer. Nothing else of this shell does.
  const signerEnv = Object.fromEntries(Object.entries(env).filter(([k, v]) => k.startsWith('VECTOR_SIGNER_') && v !== undefined));
  signer = { client: new Client({ name: 'e2e-signer', version: '0.1.0' }) };
  await signer.client.connect(new StdioClientTransport({ command: process.execPath, args: [SIGNER_ENTRY], env: signerEnv }));
  signer.tools = await toolsOf(signer.client);
  const noSigner = SIGNER_TOOLS.filter((t) => !signer.tools.has(t));
  if (noSigner.length) throw new Fail(`the signer at ${SIGNER_ENTRY} lacks these tools: ${noSigner.join(', ')}`, 3);
  const evidence = await main(builder, signer);
  if (evidence) console.log(JSON.stringify(evidence, null, 2));
} catch (e) {
  log(`\ne2e-hire: ${e instanceof Fail ? e.message : `unexpected error: ${e?.message ?? e}`}`);
  code = e instanceof Fail ? e.code : 1;
} finally {
  await Promise.allSettled([builder?.client.close(), signer?.client.close()]);
}
// exitCode, not exit(): exit() can cut a pending write to stdout, and the evidence is on stdout. The timer is the way out if a handle lingers.
process.exitCode = code;
setTimeout(() => process.exit(code), 3000).unref();
