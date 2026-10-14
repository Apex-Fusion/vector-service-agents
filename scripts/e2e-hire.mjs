// scripts/e2e-hire.mjs - our own first-party hire of Agent History through the MCP tools. See docs/E2E.md.
//
// It drives two MCP servers with the official SDK. The builder (the hosted server, or a local build of main of Apex-Fusion/mcp-server) reads
// the ledger and builds unsigned transactions. The signer holds the key and signs. This script holds no key and prints none: it forwards
// the VECTOR_SIGNER_ settings of this shell to the signer it starts (the SDK adds its short list of default variables, such as PATH)
// and nothing else, and it reads the signer's address from the signer's own tool.
//
// Settings, from the environment:
//   BUILDER_URL   the builder's MCP endpoint (default: the hosted server)
//   SIGNER_ENTRY  path of the signer's build/index.js (required)
//   ADVERT_REF    the advert to hire, <txid>#<index> (required)
//   PAYLOAD       the request JSON (default: the ChandraOCR subject of the guide)
//   E2E_STATE     the state file (default ./e2e-state.json). A rerun continues where the last run stopped
//   E2E_POLL_MS   pause between two polls of the job, a positive whole number of milliseconds (default 5000)
//   EXPLORER_URL  base of the explorer links in the evidence (default: the mainnet explorer)
// Flag: --dry-run reads and prints. It signs, submits, posts and sends nothing, and writes no state. No other argument is accepted.
// Output: the steps go to stderr. The evidence of a finished run is one JSON object on stdout.
// Exit: 0 done, 1 a step failed, 2 a setting, a flag or the state file is wrong, 3 the builder or the signer lacks tools.
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const env = process.env;
const log = (s) => console.error(s);
const USAGE = 'usage: node scripts/e2e-hire.mjs [--dry-run]\nSIGNER_ENTRY and ADVERT_REF are required settings; the others have defaults. See docs/E2E.md.';
const refuse = (message) => { log(`e2e-hire: ${message}`); process.exit(2); };
const argv = process.argv.slice(2);
const strayArgs = argv.filter((a) => a !== '--dry-run');
if (strayArgs.length) { log(`e2e-hire: unknown argument ${strayArgs.join(' ')}\n${USAGE}`); process.exit(2); }
const DRY = argv.includes('--dry-run');
const CAPABILITY = 'identity.history.report.v1';
const DEFAULT_PAYLOAD = '{"subject":"did:vector:agent:be1a0a2912da180757ed3cd61b56bb8eab0188c19dc3c0e3912d2c01:5542837bc3a6ccd66cb75ac91a796cf5716d439f4a72594bbfc06db7231029db"}';
// The nine marketplace tools and the PR of Apex-Fusion/mcp-server that brought each (all merged into main on 2026-10-14). All nine are
// required: a hire without the reclaim tool can strand funds, so a builder that lacks it is not ready for an outside member either.
const PR_OF = {
  vector_marketplace_list_capabilities: 'PR 1 (read tools)', vector_marketplace_list_suppliers: 'PR 1 (read tools)', vector_marketplace_get_supplier: 'PR 1 (read tools)',
  vector_build_marketplace_post_escrow: 'PR 2 (build tools)', vector_build_marketplace_accept: 'PR 2 (build tools)', vector_build_marketplace_reclaim: 'PR 2 (build tools)',
  vector_marketplace_send_job: 'PR 3 (job transport)', vector_marketplace_get_job: 'PR 3 (job transport)', vector_marketplace_verify_receipt: 'PR 3 (job transport)',
};
const BUILDER_TOOLS = [...Object.keys(PR_OF), 'vector_submit_transaction', 'vector_await_transaction'];
const SIGNER_TOOLS = ['vector_signer_get_address', 'vector_signer_sign'];
const VERIFY_TRIES = 6;
// The hosted server sits behind a proxy that cuts a call near 100 s, so a wait is asked for in slices of 90 s and repeated.
const AWAIT_SLICE_S = 90;
const AWAIT_SLICES = 4;
class Fail extends Error { constructor(message, code = 1) { super(message); this.code = code; } }

// ---- settings ----
const missing = [];
const need = (k) => { if (!env[k]) missing.push(k); return env[k]; };
const BUILDER_URL = env.BUILDER_URL ?? 'https://mcp.vector.mainnet.apexfusion.org/mcp';
const SIGNER_ENTRY = need('SIGNER_ENTRY');
const ADVERT_REF = need('ADVERT_REF');
const PAYLOAD = env.PAYLOAD ?? DEFAULT_PAYLOAD;
const STATE_PATH = env.E2E_STATE ?? 'e2e-state.json';
const POLL_MS = env.E2E_POLL_MS === undefined ? 5000 : /^[1-9]\d*$/.test(env.E2E_POLL_MS) ? Number(env.E2E_POLL_MS) : Number.NaN;
const EXPLORER_URL = (env.EXPLORER_URL ?? 'https://explorer.vector.mainnet.apexfusion.org').replace(/\/+$/, '');
const INDEXER_URL = 'https://mp-indexer.vector.apexfusion.org'; // for the recovery text only
if (missing.length) refuse(`set ${missing.join(' and ')} (see docs/E2E.md)`);
if (!/^[0-9a-f]{64}#\d+$/i.test(ADVERT_REF)) refuse(`ADVERT_REF must be <txid>#<index>, got "${ADVERT_REF}"`);
try { JSON.parse(PAYLOAD); } catch { refuse('PAYLOAD must be the request JSON, a JSON document'); }
if (Number.isNaN(POLL_MS)) refuse(`E2E_POLL_MS must be a positive whole number of milliseconds, got "${env.E2E_POLL_MS}"`);

// ---- state: a rerun continues where the last run stopped ----
function loadState() {
  if (!existsSync(STATE_PATH)) return {};
  let parsed;
  try { parsed = JSON.parse(readFileSync(STATE_PATH, 'utf8')); } catch (e) { refuse(`${STATE_PATH} is not valid JSON (${e.message}). Repair it, or move it away to start a new run`); }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) refuse(`${STATE_PATH} does not hold a JSON object. Repair it, or move it away to start a new run`);
  return parsed;
}
const state = loadState();
// Written to a temporary file and renamed over the state file, so a kill in the middle of a write never leaves half a file.
const save = () => {
  if (DRY) return;
  writeFileSync(`${STATE_PATH}.tmp`, JSON.stringify(state, null, 2) + '\n');
  renameSync(`${STATE_PATH}.tmp`, STATE_PATH);
};

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
// The arguments of a call held against the schema the server publishes for the tool, in both directions. A server drops an argument it does not
// know without a word, and a silently dropped argument is how a hash check ends up skipped. And a call that lacks an argument the schema requires
// is refused by the server only when it is made, which for the send is after the escrow was posted. So a stray and a missing one are refused here.
function checkArgs(side, name, args) {
  const schema = side.tools.get(name)?.inputSchema;
  const known = Object.keys(schema?.properties ?? {});
  const stray = Object.keys(args).filter((k) => !known.includes(k));
  if (stray.length) throw new Fail(`${name} has no argument ${stray.join(', ')}; it takes ${known.join(', ') || 'none'}`);
  const absent = (schema?.required ?? []).filter((k) => args[k] === undefined);
  if (absent.length) throw new Fail(`${name} requires ${absent.join(', ')}, which the call lacks; it takes ${known.join(', ')}`);
}
// A call by name, after its arguments passed that check.
async function call(side, name, args = {}, { timeoutMs = 120_000, allowFail = false } = {}) {
  checkArgs(side, name, args);
  const r = await side.client.callTool({ name, arguments: args }, undefined, { timeout: timeoutMs });
  const text = textOf(r);
  log(`\n== ${name}\n${shorten(text)}`);
  const failed = Boolean(r.isError) || FAILED.test(text);
  if (failed && !allowFail) throw new Fail(`${name} failed: ${firstLine(text)}`);
  return { text, json: lastJson(text), failed };
}

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
    // A failed submit can mean "already in the ledger" on a rerun, so the wait decides; it is one short slice when the submit failed.
    const slices = sub.failed ? 1 : AWAIT_SLICES, seconds = sub.failed ? 20 : AWAIT_SLICE_S;
    let confirmed = false;
    for (let i = 1; i <= slices && !confirmed; i++) {
      const wait = await call(builder, 'vector_await_transaction', { txHash: rec.tx_hash, timeoutSeconds: seconds }, { timeoutMs: (seconds + 30) * 1000 });
      confirmed = /Transaction Confirmed/.test(wait.text);
      if (!confirmed && i < slices) log(`${key}: ${rec.tx_hash} is not confirmed after ${i * seconds} s; asking again`);
    }
    if (!confirmed) {
      throw new Fail(sub.failed ? `${key}: the submit failed and ${rec.tx_hash} is not on the ledger: ${firstLine(sub.text)}` : `${key}: ${rec.tx_hash} is not confirmed yet. Run the script again to keep waiting`);
    }
    rec.confirmed = true;
    save();
  }
  return rec;
}

const deliverByOf = (post) => (post.deliver_by ? new Date(Number(post.deliver_by)).toISOString() : 'deliver_by');

// What a failed or a stalled job leaves open. The job tool does not know where the escrow stands, and the supplier's Submit may still land after the
// job was reported as failed or the wait ran out. So reclaiming is the answer only for an Open or Claimed escrow, and a Submitted one has a clock.
function checkTheEscrow(post) {
  return [
    `The job tool does not know where escrow ${post.escrow_ref} stands, and the supplier's Submit may still land. Check the escrow before you reclaim anything (docs/E2E.md, "If a run stops"):`,
    "  Submitted: accept within 600 s of the supplier's Submit, or the supplier may Release and keep everything that is locked, your bond included. vector_build_marketplace_accept builds only for a Submitted escrow and prints seconds_left, so asking it is the check. A Submitted escrow cannot be reclaimed.",
    `  Open or Claimed: reclaim it with vector_build_marketplace_reclaim after deliver_by (${deliverByOf(post)}).`,
  ].join('\n');
}

// What an earlier run leaves behind when the advert stops being free after the escrow was posted. Only a post whose confirmation was recorded is
// known to be on the ledger: that escrow is Open, because nothing was sent. A post that was signed and never confirmed may not exist at all.
function postedEscrowNote() {
  const post = state.post;
  if (!post?.escrow_ref) return '';
  if (!post.confirmed) {
    return ` An earlier run signed escrow ${post.escrow_ref} in transaction ${post.tx_hash} and never recorded that it was confirmed, so that escrow may not be on the ledger, and nothing was sent to the supplier. Look the transaction up on the explorer. If it is there, the escrow is Open: reclaim it with vector_build_marketplace_reclaim after deliver_by (${deliverByOf(post)}), then move ${STATE_PATH} away and start a new run. If it is not there, follow the row "is not among the free suppliers" in docs/E2E.md ("If a run stops"). While the advert is not free, running the script again stops at the same check.`;
  }
  return ` An earlier run already posted escrow ${post.escrow_ref} and sent nothing to the supplier, so that escrow is still Open. Reclaim it with vector_build_marketplace_reclaim after deliver_by (${deliverByOf(post)}), then move ${STATE_PATH} away and start a new run (docs/E2E.md, "If a run stops").`;
}

// The one step that cannot simply be repeated: a second send for an escrow the supplier has already claimed is refused (409), and the job id
// exists only in the answer to the first send. So the state says "sending" before the call and drops it when the id is written down.
function sendInterrupted(post) {
  const when = post.deliver_by ? new Date(Number(post.deliver_by)).toISOString() : 'deliver_by';
  return new Fail([
    `an earlier run called vector_marketplace_send_job and recorded no job id (job.sending in ${STATE_PATH}).`,
    `The supplier may have claimed escrow ${post.escrow_ref}, and sending again would be refused with 409. Nothing was sent now. To go on (docs/E2E.md, "If the send step was interrupted"):`,
    '  1. If you have the output of that run, find the job id under "== vector_marketplace_send_job". Add it to the job section of the state file as "job_id", delete "sending", and run the script again.',
    `  2. Otherwise look at the escrow: vector_marketplace_get_supplier for ${ADVERT_REF} (status busy means a job is running). The indexer keeps one row for each version of the escrow, and the versions of one job share posted_at.`,
    `     The escrow you posted, one row: ${INDEXER_URL}/escrows/${encodeURIComponent(post.escrow_ref)} (its posted_at names the job). Then ${INDEXER_URL}/escrows?buyer=<buyer key hash> lists the versions: among the rows with that posted_at, the furthest state (Submitted, then Claimed, then Open) is where the escrow stands.`,
    `     Open or Claimed: wait for deliver_by (${when}), reclaim the escrow with vector_build_marketplace_reclaim, move the state file away and start a new run.`,
    '     Submitted: the report cannot be read without the job id, so this run is not evidence. The escrow is first-party, so close it with vector_build_marketplace_accept while the accept window is open: your bond of 1 comes back, and a Release would hand it to the supplier. If the accept tool refuses with "No live continuation of escrow <escrow_ref> found (spent, or not yet indexed); retry or check the explorer.", wait a minute and ask once more, because the indexer can lag the ledger. If it refuses again, the escrow is spent and the supplier has most likely released it: look at the escrow on the explorer. Then move the state file away and start a new run.',
  ].join('\n'));
}

async function main(builder, signer) {
  // The signer's own tool says who the buyer is. The address is never taken from a setting.
  const address = /Signer address: (addr1[0-9a-z]+)/.exec((await call(signer, 'vector_signer_get_address')).text)?.[1];
  if (!address) throw new Fail('the signer did not return an address');
  const run = { advert_ref: ADVERT_REF, payload: PAYLOAD, address };
  if (state.run && JSON.stringify(state.run) !== JSON.stringify(run)) throw new Fail(`${STATE_PATH} belongs to another run (advert, payload or signer address differ). Move it away to start again`);
  state.run = run; save();
  const job = (state.job ??= {});
  const resultKey = ['output', 'result'].find((k) => k in (builder.tools.get('vector_marketplace_verify_receipt').inputSchema?.properties ?? {}));
  if (!resultKey) throw new Fail('vector_marketplace_verify_receipt takes neither "output" nor "result" for the report text');

  if (state.accept?.confirmed) {
    if (DRY) { printPlan(address, resultKey); log('this run finished earlier; a real run would print its evidence from the state file and call nothing'); return null; }
    log('this run finished earlier; its evidence follows');
    return evidenceOf();
  }
  if (job.sending && !job.job_id) throw sendInterrupted(state.post ?? {});

  // A fresh run holds every call it is going to make against the schemas the servers publish, before the first transaction is built. A tool whose
  // arguments changed since this script was written would otherwise show only at its own call, and for the send that is after the escrow was posted.
  if (!state.post?.signed_cbor) for (const [name, args] of stepsOf(address, resultKey)) checkArgs(SIGNER_TOOLS.includes(name) ? signer : builder, name, args);

  // Read-only: before the job is sent, the advert must be among the free suppliers of the capability. Once it is sent the supplier is
  // working for us and shows as busy, so a rerun must not ask again.
  if (!job.job_id) {
    const listed = (await call(builder, 'vector_marketplace_list_suppliers', { capability_id: CAPABILITY, limit: 50 })).json ?? [];
    if (!listed.some((s) => s.advert_ref?.toLowerCase() === ADVERT_REF.toLowerCase())) throw new Fail(`${ADVERT_REF} is not among the free suppliers for ${CAPABILITY}. It may be busy, retired or not advertised.${postedEscrowNote()}`);
  }

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
  if (!job.job_id) {
    job.sending = new Date().toISOString(); save(); // before the call: if this process dies or times out, the next run knows the send may have happened
    let sent;
    try {
      sent = await call(builder, 'vector_marketplace_send_job', { escrow_ref: post.escrow_ref, payload: PAYLOAD, buyerAddress: address }, { timeoutMs: 150_000 });
    } catch (e) {
      // An answer that says the send failed (or an argument that was refused before the call) leaves the escrow Open, and the send can be tried again.
      // No answer at all (a timeout, a dropped connection) leaves the marker: the supplier may have claimed.
      if (e instanceof Fail) { delete job.sending; save(); throw e; }
      throw new Fail(`vector_marketplace_send_job gave no answer (${e.message}). The supplier may have claimed the escrow. The state file now says job.sending, and the next run will stop and tell you how to go on`);
    }
    const id = sent.json?.jobId ?? sent.json?.job_id;
    // No id in the answer: the supplier may still have claimed, so the marker stays and the next run explains how to go on.
    if (!id) throw new Fail('vector_marketplace_send_job answered without a job id, so the supplier may have claimed the escrow. Do not send again: run the script again for the steps to go on');
    job.job_id = id; delete job.sending; save();
  }
  if (!job.result) {
    const until = Number(post.deliver_by) || Date.now() + 10 * 60_000;
    for (;;) {
      const polled = await call(builder, 'vector_marketplace_get_job', { escrow_ref: post.escrow_ref, job_id: job.job_id, buyerAddress: address });
      const j = polled.json ?? {};
      if (j.state === 'done') { Object.assign(job, { result: j.result, receipt: j.receipt, receipt_signature: j.receipt_signature }); save(); break; }
      if (j.state === 'failed') throw new Fail(`the job failed: ${j.reason ?? ''} ${j.message ?? ''}`.trim() + `.\n${checkTheEscrow(post)}`);
      if (Date.now() > until) throw new Fail(`the job did not finish before deliver_by.\n${checkTheEscrow(post)}`);
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
  await landTx('accept', async () => {
    const r = await call(builder, 'vector_build_marketplace_accept', { changeAddress: address, escrow_ref: post.escrow_ref });
    const unsigned = hexBlock(r.text);
    if (!unsigned || !r.json?.tx_hash) throw new Fail('the accept tool returned no unsigned transaction and tx_hash');
    if (r.json.seconds_left < 120) log(`warning: only ${r.json.seconds_left} s are left in the accept window`);
    return { unsigned, tx_hash: r.json.tx_hash, extra: {} };
  }, builder, signer);

  return evidenceOf();
}

// What a finished run proves, read from the state: the escrow, the two transactions, the verdict, the receipt and the report text it covers.
// The report text is in the evidence because the receipt check needs the exact string, and a copy that was re-serialised or cut fails it.
function evidenceOf() {
  const { post, accept, job, verify } = state;
  return {
    run: 'first-party', capability_id: CAPABILITY, builder: BUILDER_URL, advert_ref: ADVERT_REF,
    escrow_ref: post.escrow_ref, post_tx: post.tx_hash, accept_tx: accept.tx_hash,
    explorer: { post: `${EXPLORER_URL}/transaction/hash/${post.tx_hash}`, accept: `${EXPLORER_URL}/transaction/hash/${accept.tx_hash}` },
    verdict: 'VERIFIED', checks: verify.checks, receipt: job.receipt, receipt_signature: job.receipt_signature, result_sha256: sha256(job.result), result: job.result,
  };
}

// What a real run would do, in order, with the arguments it already knows, and which steps an earlier run has already done. --dry-run prints it,
// and a fresh run checks the arguments of every step against the schemas before it builds anything.
function stepsOf(address, resultKey) {
  const post = state.post ?? {}, job = state.job ?? {}, accept = state.accept ?? {};
  const done = (yes) => (yes ? ' (done in an earlier run, skipped)' : '');
  return [
    ['vector_build_marketplace_post_escrow', { changeAddress: address, advert_ref: ADVERT_REF, payload: PAYLOAD }, done(post.signed_cbor)],
    ['vector_signer_sign', { txCbor: '<unsigned post>' }, done(post.signed_cbor)],
    ['vector_submit_transaction', { signedTxCbor: '<signed post>' }, done(post.confirmed)],
    ['vector_await_transaction', { txHash: '<post tx>', timeoutSeconds: AWAIT_SLICE_S }, done(post.confirmed)],
    ['vector_marketplace_send_job', { escrow_ref: '<escrow_ref>', payload: PAYLOAD, buyerAddress: address }, done(job.job_id)],
    ['vector_marketplace_get_job', { escrow_ref: '<escrow_ref>', job_id: '<job_id>', buyerAddress: address }, job.result ? done(true) : ' (repeated until done or deliver_by)'],
    ['vector_marketplace_verify_receipt', { escrow_ref: '<escrow_ref>', receipt: '<receipt>', receipt_signature: '<signature>', [resultKey]: '<report text>' }, done(accept.confirmed)],
    ['vector_build_marketplace_accept', { changeAddress: address, escrow_ref: '<escrow_ref>' }, done(accept.signed_cbor)],
    ['vector_signer_sign', { txCbor: '<unsigned accept>' }, done(accept.signed_cbor)],
    ['vector_submit_transaction', { signedTxCbor: '<signed accept>' }, done(accept.confirmed)],
    ['vector_await_transaction', { txHash: '<accept tx>', timeoutSeconds: AWAIT_SLICE_S }, done(accept.confirmed)],
  ];
}
function printPlan(address, resultKey) {
  const steps = stepsOf(address, resultKey);
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
      'This run needs all nine marketplace tools. They are merged into main of Apex-Fusion/mcp-server and on the hosted mainnet server as of 2026-10-14, so a builder that lacks them is some other builder. Point BUILDER_URL at a builder that has them,',
      'for example a local build of main: PORT=3300 node packages/builder/build/index.js, then BUILDER_URL=http://localhost:3300/mcp'].join('\n'), 3);
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
