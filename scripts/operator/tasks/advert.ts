// The task posts the use case's adverts with the hash of each service's manifest.
// The hosted builder returns unsigned bytes. The plan checks those bytes and the supplier key signs.
// Before a step builds, three things are checked:
//   the record     it is in the facts file, on the node and Active, and it lists the supplier key with the transaction purpose and the capability of the agent, byte for byte;
//   the runtimes   the supplier wallet is also the wallet of a running runtime, so no runtime of the agent that runs may work (`running-images.json` decides which runtimes run: a runtime that is
//                  not in it does not run, and its host is not asked);
//   the manifest   `<origin>/agent.json` is read twice, 5 seconds apart on the clock of the run (status 200, JSON, at most 262,144 bytes), the two bodies must be equal byte for byte, and the
//                  SHA-256 of the bytes is the detail hash (the value of `scripts/manifest-hash.mjs`). The manifest must agree with the advert: the capability, the DID of the record, the price, both
//                  bonds and the window, and the key hash of the supplier. A difference stops the run with the names of the members, and nothing is built.
// The plan checks that the advert output holds the terms, manifest hash and agent in its datum, plus the deposit. It refuses any mint.
// The adverts of one agent share a manifest hash.
// Cleanup retires only recorded adverts that match the agent on the node. The --agent flag limits the retirement to that agent.
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { collateralAdvice, isCollateralOutput } from '../../checks/lib/collateral.ts';
import { iso, units } from '../../checks/lib/format.ts';
import { GuardRefusal } from '../../checks/lib/land.ts';
import { eventually } from '../../checks/lib/retry.ts';
import { PreconditionError } from '../../checks/lib/session.ts';
import type { StepOutcome } from '../../checks/lib/session.ts';
import { StateFile } from '../../checks/lib/state.ts';
import type { StepRecord } from '../../checks/lib/state.ts';
import type { OutputFacts, TxFacts } from '../../checks/lib/txfacts.ts';
import { VERIFY_WINDOW, VerificationError } from '../../checks/lib/verify.ts';
// The pack's platform file gives no name of the advert codec, so this file takes it from the entry of vector-read.
import { decodeIdentityAdvertDatum } from '../../../packages/vector-read/src/index.ts';
import type { IdentityAdvertDatum } from '../../../packages/vector-read/src/index.ts';
import type { AdvertSpec, AgentSpec, HostedBuild, HostedLandSpec, TaskDefinition, TaskSession } from '../lib/contract.ts';
import { readRunning, requireRuntimesFree, runtimesOf } from '../lib/free.ts';
import { landHosted } from '../lib/land-hosted.ts';
import { planOf } from '../lib/plan.ts';
import { PURPOSE, effectiveStatus, findRecord, keyHashOf, parseOutRef } from '../lib/platform.ts';
import { FlagError, runSteps } from '../lib/runner.ts';
import type { StepHandler } from '../lib/runner.ts';

const TOOL_POST = 'vector_build_marketplace_advert_post';
const TOOL_RETIRE = 'vector_build_marketplace_advert_retire';
const TOOL_LIST = 'vector_marketplace_list_suppliers';
const MAX_MANIFEST_BYTES = 262_144;
/** The two reads of the manifest are this far apart on the clock of the run. */
const READ_GAP_MS = 5_000;
const READ_LIMIT_MS = 10_000;
const MAX_SHOWN = 120;

interface Extra { result: Record<string, unknown> | null; readonly cleanupAgent: AgentSpec | null }
type Session = TaskSession<Extra>;
interface Ready { did: string; id: string }
/** The manifest that the service served: the address, the bytes (as a count and as the SHA-256 of them), the time of the reads and the JSON object. */
interface Manifest { uri: string; bytes: number; sha256: string; readAt: string; json: Record<string, unknown> }

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const shown = (value: unknown): string => (typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint' ? JSON.stringify(String(value).slice(0, MAX_SHOWN)) : 'not a text or a number');
const hexOf = (text: string): string => Buffer.from(text, 'utf8').toString('hex');
const originOf = (advert: AdvertSpec): string => advert.origin.replace(/\/+$/, '');
const stepName = (agent: AgentSpec, advert: AdvertSpec): string => `${agent.id}:${advert.model}`;
const retireName = (agent: AgentSpec, advert: AdvertSpec): string => `retire:${agent.id}:${advert.model}`;
const refuse = (step: string, message: string): GuardRefusal => new GuardRefusal(step, [{ guard: 'destinations', ok: false, message }]);
/** A number of lovelace for a tool that takes a whole number: the data holds a bigint, and a value that a number cannot hold exactly is a mistake of the data. */
function wholeOf(lovelace: bigint): number {
  if (lovelace < 0n || lovelace > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`the data holds ${lovelace} lovelace, and a tool takes a whole number from 0 to ${Number.MAX_SAFE_INTEGER}`);
  return Number(lovelace);
}

// ---- the preconditions of a step ----

/**
 * The record of the agent: in the facts file, on the node, a root record and Active, and it lists the supplier key with the transaction purpose and the capability of the agent, byte for byte.
 * A refusal stops the step before anything is built.
 */
async function requireRecord(session: Session, agent: AgentSpec, supplierKey: string): Promise<Ready> {
  const held = session.facts.read().records[agent.id];
  if (held === undefined) throw new PreconditionError(`the facts file holds no record of ${agent.id}: register it first, and keep the facts file of the session`);
  const found = await findRecord(session.chain.provider, session.chain.deployment, held.id);
  if (found === null) throw new PreconditionError(`the record ${held.did} of ${agent.id} is not on the node: wait until its registration is confirmed there`);
  if (found.record.lineage.type !== 'Root') throw new PreconditionError(`the record ${held.did} of ${agent.id} is a subagent: the agents of this task are root records`);
  const now = session.clock.now();
  const status = effectiveStatus(found.record, new Map(), now, now);
  if (status !== 'Active') throw new PreconditionError(`the record ${held.did} of ${agent.id} is ${status}: it must be Active`);
  const supplierHash = session.registry.hashOf(supplierKey);
  const listed = found.record.keys.some((key) => key.keyType === 'Ed25519' && keyHashOf(key.key).toLowerCase() === supplierHash && (key.purposes & PURPOSE.transaction) !== 0);
  if (!listed) throw new PreconditionError(`the record ${held.did} does not list the supplier key ${supplierKey} with the transaction purpose: the advert names that key`);
  if (!found.record.capabilities.some((capability) => capability.toLowerCase() === hexOf(agent.capability))) {
    throw new PreconditionError(`the record ${held.did} does not list the capability ${agent.capability}, byte for byte: the advert offers that capability`);
  }
  return { did: held.did, id: held.id };
}

/** The supplier wallet holds a pure output of 5 units or more: the wallet of an advert is the wallet of its runtime, and a retirement runs a script that needs it as collateral. */
async function requireCollateralOutput(session: Session, supplierKey: string): Promise<void> {
  const address = session.registry.addressOf(supplierKey);
  if (!(await session.chain.provider.getUtxos(address)).some(isCollateralOutput)) {
    throw new PreconditionError(`The supplier wallet ${address} of the key ${supplierKey} has no pure output of 5 units or more. ${collateralAdvice(address)}.`);
  }
}

/** Checks every running runtime of the agent during a post, or of the use case during cleanup. */
async function requireFree(session: Session, agent?: AgentSpec): Promise<void> {
  const running = readRunning(join(session.settings.stateDir, 'running-images.json'), session.clock.now());
  const runtimes = agent === undefined ? session.use.agents.flatMap(runtimesOf) : runtimesOf(agent);
  await requireRuntimesFree({ fetchImpl: session.fetchImpl, runtimes, running, out: session.out });
}

const requireNoFlight = (session: Session): void => {
  if (session.state.snapshot().in_flight !== null) throw new PreconditionError('a transaction is in flight: settle it before an advert step is built');
};

/** Reads a recorded reference on the node. A missing output is spent or not yet visible. An unreadable reference is not a missing output. */
async function outputAt(session: Session, ref: string) {
  let parsed: { txHash: string; outputIndex: number };
  try { parsed = parseOutRef(ref); } catch { throw new PreconditionError('the facts file holds a reference of an advert that is not of the form <hash>#<index>'); }
  const [output] = await session.chain.provider.getUtxosByOutRef([parsed]);
  return output;
}

const isLive = async (session: Session, ref: string): Promise<boolean> => (await outputAt(session, ref)) !== undefined;

/** The models of the adverts of the agent that the facts file holds and that are on the node now. */
async function liveModels(session: Session, agent: AgentSpec): Promise<string[]> {
  const held = Object.entries(session.facts.read().adverts[agent.id] ?? {});
  const live: string[] = [];
  for (const [model, fact] of held) if (await isLive(session, fact.ref)) live.push(model);
  return live;
}

/** The reference of an Active advert at the advert address that names this agent and this model, or null. The facts file may not hold it: this reads the node, and it skips an output that is no identity advert. */
async function activeAdvertOf(session: Session, agentId: string, model: string): Promise<string | null> {
  for (const utxo of await session.chain.provider.getUtxos(session.chain.deployment.advert.address)) {
    if (typeof utxo.datum !== 'string') continue;
    let datum: IdentityAdvertDatum;
    try { datum = decodeIdentityAdvertDatum(utxo.datum); } catch { continue; }
    if (datum.agent_id === agentId && datum.model === model && datum.status === 'Active') return `${utxo.txHash}#${utxo.outputIndex}`;
  }
  return null;
}

// ---- the manifest ----

async function bodyBytes(response: Response, max: number): Promise<Buffer | null> {
  if (response.body === null) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, total);
}

/** One read of `<origin>/agent.json`: status 200, at most 262,144 bytes, JSON that is an object. The request and its body have 10 seconds. Any other result stops the step, and a message never shows the body. */
async function readOnce(session: Session, uri: string): Promise<{ bytes: Buffer; json: Record<string, unknown> }> {
  let response: Response;
  try {
    response = await session.fetchImpl(uri, { method: 'GET', headers: { accept: 'application/json' }, redirect: 'manual', signal: AbortSignal.timeout(READ_LIMIT_MS) });
  } catch {
    throw new PreconditionError(`the service does not answer at ${uri}: the request failed or took more than ${READ_LIMIT_MS / 1000} s`);
  }
  if (response.status !== 200) {
    void response.body?.cancel().catch(() => undefined);
    throw new PreconditionError(`the service answers with the status ${response.status} at ${uri}, and the manifest needs the status 200`);
  }
  let bytes: Buffer | null;
  try { bytes = await bodyBytes(response, MAX_MANIFEST_BYTES); } catch { throw new PreconditionError(`the answer of ${uri} could not be read`); }
  if (bytes === null) throw new PreconditionError(`the manifest at ${uri} is longer than ${MAX_MANIFEST_BYTES} bytes`);
  let json: unknown;
  try { json = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { throw new PreconditionError(`the manifest at ${uri} is not JSON`); }
  if (!isObject(json)) throw new PreconditionError(`the manifest at ${uri} is not a JSON object`);
  return { bytes, json };
}

/** The manifest, read twice with 5 seconds between the reads on the clock of the run. The two bodies must be equal byte for byte. */
async function readTwice(session: Session, uri: string): Promise<Manifest> {
  const first = await readOnce(session, uri);
  await session.clock.sleep(READ_GAP_MS);
  const second = await readOnce(session, uri);
  const hashOf = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
  if (!first.bytes.equals(second.bytes)) {
    throw new PreconditionError(`two reads of ${uri}, ${READ_GAP_MS / 1000} s apart, gave different bytes (the SHA-256 values are ${hashOf(first.bytes)} and ${hashOf(second.bytes)}): an advert carries one hash, so the service must serve one manifest`);
  }
  return { uri, bytes: first.bytes.length, sha256: hashOf(first.bytes), readAt: iso(session.clock.now()), json: first.json };
}

/**
 * Checks the capability, DID, price, bonds, window and supplier key of the advert.
 * A list of tiers must name the model exactly once. Without tiers, read the direct terms and supplier key.
 */
function manifestProblems(agent: AgentSpec, advert: AdvertSpec, did: string, supplierHash: string, json: Record<string, unknown>): string[] {
  const problems: string[] = [];
  const same = (name: string, found: unknown, want: string | number): void => {
    if (found !== want) problems.push(`${name} is ${shown(found)}, and the advert has ${shown(want)}`);
  };
  same('capability_id', json.capability_id, agent.capability);
  same('identity.did', isObject(json.identity) ? json.identity.did : undefined, did);
  const terms = isObject(json.terms) ? json.terms : {};
  let sheet: Record<string, unknown> = terms;
  let place = 'terms';
  let supplier: unknown = isObject(json.keys) ? json.keys.supplier_pkh : undefined;
  let supplierName = 'keys.supplier_pkh';
  if (Array.isArray(terms.tiers)) {
    const matching = terms.tiers.filter((tier): tier is Record<string, unknown> => isObject(tier) && tier.model === advert.model);
    place = `terms.tiers[${advert.model}]`;
    if (matching.length !== 1) return [...problems, `terms.tiers holds ${matching.length} tier(s) for the model ${advert.model}, and the advert needs exactly one`];
    sheet = matching[0]!;
    supplier = sheet.supplier_pkh;
    supplierName = `${place}.supplier_pkh`;
  }
  same(`${place}.price_lovelace`, sheet.price_lovelace, wholeOf(advert.priceLovelace));
  same(`${place}.supplier_bond_lovelace`, sheet.supplier_bond_lovelace, wholeOf(advert.supplierBondLovelace));
  same(`${place}.buyer_bond_lovelace`, sheet.buyer_bond_lovelace, wholeOf(advert.buyerBondLovelace));
  same(`${place}.max_processing_ms`, sheet.max_processing_ms, advert.windowMs);
  if (typeof supplier !== 'string' || supplier.toLowerCase() !== supplierHash) problems.push(`${supplierName} is ${shown(supplier)}, and the supplier key of the advert has the key hash ${supplierHash}`);
  return problems;
}

// ---- what the bytes must say ----

interface Want {
  supplier: string; capability: string; model: string; tokens: number; windowMs: number; price: bigint; supplierBond: bigint; buyerBond: bigint; endpoint: string; detailUri: string; detailHash: string;
  agentId: string; deposit: bigint;
}

/** The advert output of the bytes: the only output at the advert address, with the deposit of the data and a datum that holds the terms of the data, the hash that was read and the agent. */
function advertOutput(step: string, address: string, want: Want, facts: TxFacts): OutputFacts {
  const found = facts.outputs.filter((output) => output.address === address);
  if (found.length !== 1) throw refuse(step, `the transaction has ${found.length} output(s) at the advert address, and an advert has exactly one`);
  const output = found[0]!;
  if (output.inlineDatum === null) throw refuse(step, 'the advert output has no inline datum');
  let datum: IdentityAdvertDatum;
  try { datum = decodeIdentityAdvertDatum(output.inlineDatum); } catch { throw refuse(step, 'the datum of the advert output is no advert of the identity layout'); }
  const problems: string[] = [];
  const same = (name: string, found_: unknown, want_: unknown): void => {
    if (found_ !== want_) problems.push(`${name} is ${shown(found_)}, and the data has ${shown(want_)}`);
  };
  if (output.lovelace !== want.deposit) problems.push(`the advert output holds ${units(output.lovelace)}, and the deposit of the data is ${units(want.deposit)}`);
  same('supplier_pkh', datum.supplier_pkh, want.supplier);
  same('capability_id', datum.capability_id, want.capability);
  same('model', datum.model, want.model);
  same('max_output_tokens', datum.max_output_tokens, want.tokens);
  same('max_processing_ms', datum.max_processing_ms, want.windowMs);
  same('price_lovelace', datum.price_lovelace, want.price);
  same('supplier_bond_lovelace', datum.supplier_bond_lovelace, want.supplierBond);
  same('buyer_bond_lovelace', datum.buyer_bond_lovelace, want.buyerBond);
  same('endpoint_url', datum.endpoint_url, want.endpoint);
  same('detail_uri', datum.detail_uri, want.detailUri);
  same('detail_hash', datum.detail_hash.toLowerCase(), want.detailHash);
  same('status', datum.status, 'Active');
  same('agent_id', datum.agent_id, want.agentId);
  if (problems.length > 0) throw refuse(step, `the advert output is not the advert of the data: ${problems.join('; ')}`);
  return output;
}

// ---- the landing of an advert ----

function wantOf(agent: AgentSpec, advert: AdvertSpec, supplierHash: string, ready: Ready, manifest: Manifest): Want {
  return {
    supplier: supplierHash, capability: agent.capability, model: advert.model, tokens: advert.maxOutputTokens, windowMs: advert.windowMs, price: advert.priceLovelace, supplierBond: advert.supplierBondLovelace,
    buyerBond: advert.buyerBondLovelace, endpoint: originOf(advert), detailUri: manifest.uri, detailHash: manifest.sha256, agentId: ready.id, deposit: advert.depositLovelace,
  };
}

function postSpec(session: Session, agent: AgentSpec, advert: AdvertSpec, ready: Ready, manifest: Manifest): HostedLandSpec {
  const step = stepName(agent, advert);
  const supplierHash = session.registry.hashOf(advert.supplierKey);
  const address = session.chain.deployment.advert.address;
  const want = wantOf(agent, advert, supplierHash, ready, manifest);
  return {
    step, tool: TOOL_POST, expectSigners: [advert.supplierKey],
    args: {
      changeAddress: session.registry.addressOf(advert.supplierKey), did: ready.did, supplier_key_hash: supplierHash, capability_id: agent.capability, model: advert.model, max_output_tokens: advert.maxOutputTokens,
      max_processing_ms: advert.windowMs, price_lovelace: wholeOf(advert.priceLovelace), supplier_bond_lovelace: wholeOf(advert.supplierBondLovelace), buyer_bond_lovelace: wholeOf(advert.buyerBondLovelace),
      endpoint_url: want.endpoint, detail_uri: manifest.uri, detail_hash: manifest.sha256, deposit_lovelace: wholeOf(advert.depositLovelace),
    },
    plan: (_build: HostedBuild, facts: TxFacts) => {
      advertOutput(step, address, want, facts);
      return planOf(session, { outflow: { [advert.supplierKey]: advert.depositLovelace + session.settings.maxFeeLovelace }, destinations: [address], mint: {}, labels: { [address]: 'the identity advert address' } });
    },
    refs: (_build: HostedBuild, facts: TxFacts) => ({
      ref: `${facts.txHash}#${advertOutput(step, address, want, facts).index}`, detailUri: manifest.uri, detailHash: manifest.sha256, endpoint: want.endpoint, manifestUri: manifest.uri,
      manifestBytes: String(manifest.bytes), manifestReadAt: manifest.readAt,
    }),
  };
}

/**
 * The facts of an advert that landed: the advert, and the manifest of the agent when the facts file holds none or holds another hash. A fact is replaced only when the advert that it names is no
 * longer on the node. A step of an old state file can come after a newer advert: its facts then stop the run and change nothing, so the facts file never loses an advert that is on the node.
 * A second advert of an agent finds the manifest fact and leaves it. Another manifest hash is taken only when no other advert of the agent that the facts file holds is on the node.
 */
async function writeFacts(session: Session, agent: AgentSpec, advert: AdvertSpec, record: StepRecord): Promise<void> {
  const { ref, detailUri, detailHash, endpoint, manifestUri, manifestBytes, manifestReadAt } = record.refs;
  if (record.tx_hash === null || ref === undefined || detailUri === undefined || detailHash === undefined || endpoint === undefined || manifestUri === undefined || manifestBytes === undefined || manifestReadAt === undefined) {
    throw new Error(`the state file holds the step ${stepName(agent, advert)} without the reference, the hash or the manifest of its advert: its facts cannot be written`);
  }
  const held = session.facts.read();
  const old = held.adverts[agent.id]?.[advert.model];
  let replaceAdvert = false;
  if (old !== undefined && old.ref !== ref) {
    if (await isLive(session, old.ref)) {
      throw new PreconditionError(
        `the state file holds the step ${stepName(agent, advert)} with the advert ${ref}, and the facts file holds the advert ${old.ref} for ${advert.model} of ${agent.id}, which is on the node: `
        + 'the facts of this step are not written. Use another --run label for a new advert',
      );
    }
    replaceAdvert = true;
  }
  const known = held.manifests[agent.id];
  const newManifest = known === undefined || known.sha256 !== detailHash;
  if (known !== undefined && newManifest) {
    const others = (await liveModels(session, agent)).filter((model) => model !== advert.model);
    if (others.length > 0) {
      throw new PreconditionError(`the advert ${ref} of ${agent.id} holds the manifest hash ${detailHash}, and the advert(s) ${others.join(', ')} on the node hold ${known.sha256}: the facts of this step are not written`);
    }
  }
  session.facts.put('adverts', [agent.id, advert.model], { ref, tx: record.tx_hash, detailUri, detailHash, endpoint, postedAt: record.confirmed_at }, { replace: replaceAdvert });
  if (newManifest) session.facts.put('manifests', [agent.id], { uri: manifestUri, sha256: detailHash, bytes: Number(manifestBytes), readAt: manifestReadAt }, { replace: known !== undefined });
}

// ---- the verification of an advert ----

/** The rows of the list that the tool writes in the last block of its text. The block is a list, so the answer of the hosted client has no JSON object: this reads the block itself. */
function rowsOf(text: string): unknown[] | null {
  const block = [...text.matchAll(/```json\n([\s\S]*?)\n```/g)].at(-1);
  if (block === undefined) return null;
  try {
    const parsed: unknown = JSON.parse(block[1]!);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** What the list shows for the advert: a row with its reference, its agent, its supplier key, its capability and its model. */
function listProblems(rows: unknown[], want: { ref: string; did: string; supplier: string; capability: string; model: string }): string[] {
  const row = rows.find((one): one is Record<string, unknown> => isObject(one) && typeof one.advert_ref === 'string' && one.advert_ref.toLowerCase() === want.ref);
  if (row === undefined) return [`the list of ${want.capability} does not show the advert ${want.ref}`];
  const problems: string[] = [];
  if (row.did !== want.did) problems.push(`the list shows the agent ${shown(row.did)} for the advert, and the record is ${want.did}`);
  if (row.supplier_pkh !== want.supplier) problems.push('the list shows another supplier key for the advert');
  if (row.capability_id !== want.capability) problems.push(`the list shows the capability ${shown(row.capability_id)} for the advert`);
  if (row.model !== want.model) problems.push(`the list shows the model ${shown(row.model)} for the advert`);
  return problems;
}

/** Asks the list again for a short time (the indexer is a few seconds behind a block) until it shows the advert, and writes the answer to the evidence either way. */
async function verifyListed(session: Session, step: string, agent: AgentSpec, advert: AdvertSpec, did: string, ref: string): Promise<void> {
  const args = { capability_id: agent.capability, only_free: false, limit: 50 };
  const want = { ref: ref.toLowerCase(), did, supplier: session.registry.hashOf(advert.supplierKey), capability: agent.capability, model: advert.model };
  const outcome = await eventually(session.clock, VERIFY_WINDOW, async () => {
    const answer = await session.hosted.call(TOOL_LIST, args);
    const rows = answer.failed ? null : rowsOf(answer.text);
    const problems = answer.failed ? [`${TOOL_LIST} failed: ${answer.message}`] : rows === null ? [`${TOOL_LIST} gave no JSON list`] : listProblems(rows, want);
    return { done: problems.length === 0, value: { answer, rows, problems } };
  });
  const { answer, rows, problems } = outcome.value;
  const read = { tool: TOOL_LIST, arguments: args, ok: !answer.failed, ...(answer.failed ? { message: answer.message } : {}), ...(rows === null ? {} : { result: rows }) };
  if (outcome.done) {
    session.evidence.add({ step, status: 'verified', hosted: [read], shows: { advert_ref: ref, agent: agent.id, model: advert.model, did } });
    return;
  }
  if (answer.failed) session.evidence.add({ step, status: 'tool_refused', expected: false, tool: TOOL_LIST, message: answer.message === '' ? 'the tool failed' : answer.message });
  session.evidence.add({ step, status: 'info', shows: { verification: 'failed', problems, hosted: [read] } });
  throw new VerificationError(`the hosted tools do not show the step ${step} as it was made: ${problems.join('; ')}`);
}

// ---- the steps ----

function showDry(session: Session, agent: AgentSpec, advert: AdvertSpec, manifest: Manifest, build: HostedBuild): void {
  const lines = [
    `advert ${advert.model} of ${agent.id} (${agent.name})`,
    `manifest: ${manifest.uri}, ${manifest.bytes} bytes, SHA-256 ${manifest.sha256}, read twice ${READ_GAP_MS / 1000} s apart with equal bytes`,
    `terms: price ${units(advert.priceLovelace)}, supplier bond ${units(advert.supplierBondLovelace)}, buyer bond ${units(advert.buyerBondLovelace)}, window ${advert.windowMs} ms`,
    `supplier key: ${advert.supplierKey} ${session.registry.hashOf(advert.supplierKey)}`, `deposit: ${units(advert.depositLovelace)}`, `valid until: ${iso(build.validTo)}`, `fee: ${units(build.feeLovelace)}`,
  ];
  for (const line of lines) session.out.out(line);
}

function postStep(agent: AgentSpec, advert: AdvertSpec): StepHandler<Extra> {
  const name = stepName(agent, advert);
  const uri = `${originOf(advert)}/agent.json`;
  return {
    name,
    async run(session) {
      session.extra.result = null;
      requireNoFlight(session);
      const ready = await requireRecord(session, agent, advert.supplierKey);
      await requireCollateralOutput(session, advert.supplierKey);
      await requireFree(session, agent);
      const old = session.facts.read().adverts[agent.id]?.[advert.model];
      if (old !== undefined && (await isLive(session, old.ref))) {
        throw new PreconditionError(`the facts file holds the advert ${old.ref} for ${advert.model} of ${agent.id}, and it is on the node: retire it with the cleanup before a new advert is posted`);
      }
      const active = await activeAdvertOf(session, ready.id, advert.model);
      if (active !== null) {
        throw new PreconditionError(`an Active advert of ${agent.id} for the model ${advert.model} is on the node (${active}): retire it, or put its reference into the facts file, before a new advert is posted`);
      }
      const manifest = await readTwice(session, uri);
      const problems = manifestProblems(agent, advert, ready.did, session.registry.hashOf(advert.supplierKey), manifest.json);
      if (problems.length > 0) throw new PreconditionError(`the manifest at ${uri} does not agree with the advert ${advert.model}: ${problems.join('; ')}. Nothing was built`);
      const known = session.facts.read().manifests[agent.id];
      if (known !== undefined && known.sha256 !== manifest.sha256) {
        const live = await liveModels(session, agent);
        if (live.length > 0) {
          throw new PreconditionError(
            `the service serves the manifest with the SHA-256 ${manifest.sha256}, and the advert(s) ${live.join(', ')} of ${agent.id} on the node hold ${known.sha256}: the adverts of one agent share one manifest hash. `
            + 'Retire them with the cleanup, or restore the service that they name',
          );
        }
      }
      const landed = await landHosted(session, postSpec(session, agent, advert, ready, manifest));
      if (landed.build === null) throw new Error(`the landing of the step ${name} gave no answer of the tool`);
      if (landed.kind === 'dry') {
        showDry(session, agent, advert, manifest, landed.build);
        session.extra.result = { agent: agent.id, model: advert.model, did: ready.did, manifest: { uri, sha256: manifest.sha256, bytes: manifest.bytes } };
        return { kind: 'dry' };
      }
      const record = recordOfStep(session, name);
      if (record === undefined) throw new Error(`the transaction ${landed.txHash} of the step ${name} landed, and the state file does not hold the step`);
      await writeFacts(session, agent, advert, record);
      session.extra.result = { agent: agent.id, model: advert.model, did: ready.did, ref: record.refs.ref, tx: landed.txHash, manifest: { uri, sha256: manifest.sha256, bytes: manifest.bytes } };
      return { kind: 'done', message: `the advert ${advert.model} of ${agent.id} is confirmed: ${String(record.refs.ref)}` };
    },
    async verify(session, record) {
      await writeFacts(session, agent, advert, record);
      const ready = session.facts.read().records[agent.id];
      if (ready === undefined || record.refs.ref === undefined) throw new Error(`the facts file lacks the record of ${agent.id}, or the state file lacks the reference of the advert of the step ${name}`);
      await verifyListed(session, name, agent, advert, ready.did, record.refs.ref);
    },
  };
}

/** The record of a step that landed: a step with a colon in its name is kept as the note `part.<name>`. */
function recordOfStep(session: Session, name: string): StepRecord | undefined {
  const note = session.state.note<unknown>(`part.${name}`);
  if (!isObject(note) || typeof note.confirmed_at !== 'string') return undefined;
  const refs = isObject(note.refs) ? Object.fromEntries(Object.entries(note.refs).filter((pair): pair is [string, string] => typeof pair[1] === 'string')) : {};
  return { confirmed_at: note.confirmed_at, tx_hash: typeof note.tx_hash === 'string' ? note.tx_hash : null, refs, facts: isObject(note.facts) ? note.facts : {}, verified_at: null };
}

// ---- the cleanup ----

/** The next recorded advert in the selected order, with its DID, model and supplier confirmed on the node. */
async function nextLive(session: Session): Promise<{ agent: AgentSpec; advert: AdvertSpec; ref: string } | null> {
  const held = session.facts.read();
  const selected = session.extra.cleanupAgent;
  const agents = selected === null ? session.use.agents : [selected];
  for (const agent of agents) {
    for (const advert of agent.adverts) {
      const fact = held.adverts[agent.id]?.[advert.model];
      if (fact === undefined) continue;
      const output = await outputAt(session, fact.ref);
      if (output === undefined) continue;
      const record = held.records[agent.id];
      const mismatch = () => new PreconditionError(`the recorded output of ${advert.model} of ${agent.id} does not match its advert on the node: nothing is retired`);
      if (record === undefined || record.did !== `did:vector:${record.id}` || output.address !== session.chain.deployment.advert.address || typeof output.datum !== 'string') throw mismatch();
      let datum: IdentityAdvertDatum;
      try { datum = decodeIdentityAdvertDatum(output.datum); } catch { throw mismatch(); }
      if (datum.status !== 'Active' || datum.agent_id !== record.id || datum.model !== advert.model || datum.capability_id !== agent.capability
        || datum.supplier_pkh !== session.registry.hashOf(advert.supplierKey)) throw mismatch();
      return { agent, advert, ref: fact.ref };
    }
  }
  return null;
}

/** Retires one advert: the same checks as a post except the manifest, then the tool, the guards with the advert output as the one explained input, and the landing. */
async function retireOne(session: Session, agent: AgentSpec, advert: AdvertSpec, ref: string): Promise<StepOutcome> {
  const step = retireName(agent, advert);
  requireNoFlight(session);
  await requireFree(session);
  await requireCollateralOutput(session, advert.supplierKey);
  const spec: HostedLandSpec = {
    step, tool: TOOL_RETIRE, args: { changeAddress: session.registry.addressOf(advert.supplierKey), advert_ref: ref }, expectSigners: [advert.supplierKey],
    plan: (_build: HostedBuild, facts: TxFacts) => {
      if (!facts.inputs.includes(ref)) throw new GuardRefusal(step, [{ guard: 'inputs', ok: false, message: `the transaction does not spend the advert output ${ref}` }]);
      return planOf(session, { outflow: { [advert.supplierKey]: session.settings.maxFeeLovelace }, explained: [ref], mint: {} });
    },
    refs: () => ({ retiredRef: ref }),
  };
  const landed = await landHosted(session, spec);
  if (landed.kind === 'dry') {
    session.out.out(`retire the advert ${advert.model} of ${agent.id}: the advert output ${ref} is spent, and its deposit returns to the supplier wallet`);
    session.extra.result = { agent: agent.id, model: advert.model, retire: ref };
    return { kind: 'dry' };
  }
  session.extra.result = { agent: agent.id, model: advert.model, retire: ref, tx: landed.txHash };
  return { kind: 'done', message: `the advert ${advert.model} of ${agent.id} is retired in the transaction ${landed.txHash}` };
}

async function cleanup(session: Session): Promise<StepOutcome> {
  session.extra.result = null;
  let retired = 0;
  for (;;) {
    const next = await nextLive(session);
    if (next === null) {
      const selected = session.extra.cleanupAgent;
      const scope = selected === null ? 'that the facts file holds' : `of ${selected.id} that the facts file holds`;
      return { kind: 'finished', message: retired === 0 ? `no advert ${scope} is on the node: there is nothing to retire` : `${retired} advert(s) are retired, and no advert ${scope} is left on the node` };
    }
    const outcome = await retireOne(session, next.agent, next.advert, next.ref);
    if (outcome.kind !== 'done') return outcome;
    retired += 1;
    if (!session.all) return outcome;
  }
}

const advert: TaskDefinition<Extra> = {
  name: 'advert',
  title: 'Post the adverts of the use case with the hash of the manifest that each service serves',
  flags: [],
  valued: ['agent'],
  needs: {
    keys: (use) => [...new Set(use.agents.flatMap((agent) => agent.adverts.map((one) => one.supplierKey)))],
    chain: true,
    hosted: [TOOL_POST, TOOL_RETIRE, TOOL_LIST],
    approval: 'submit',
  },
  steps: (use) => use.agents.flatMap((agent) => agent.adverts.map((one) => stepName(agent, one))),
  parse(_env, settings, use, flags) {
    const name = flags.value('agent');
    const cleanupAgent = name === undefined ? null : use.agents.find((agent) => agent.id === name);
    if (cleanupAgent === undefined) throw new FlagError(`--agent is one of ${use.agents.map(({ id }) => id).join(', ')}`);
    if (cleanupAgent !== null && flags.has('submit')) {
      // The runner can resend an in-flight transaction before it calls cleanup. Do not let it resume one outside this filter.
      const run = flags.value('run');
      const path = join(settings.stateDir, run === undefined ? 'advert.state.json' : `advert.${run}.state.json`);
      const flight = StateFile.peek(path)?.in_flight;
      if (flight != null && !cleanupAgent.adverts.some((one) => retireName(cleanupAgent, one) === flight.step)) {
        throw new PreconditionError('the run has a transaction in flight outside --agent. Resume it without this filter before you retire the selected adverts');
      }
    }
    return { result: null, cleanupAgent };
  },
  next: (session) => {
    if (session.extra.cleanupAgent !== null) throw new FlagError('--agent goes with advert cleanup');
    return runSteps(session, session.use.agents.flatMap((agent) => agent.adverts.map((one) => postStep(agent, one))));
  },
  cleanup,
  result: (session) => session.extra.result ?? {},
};

export default advert;
