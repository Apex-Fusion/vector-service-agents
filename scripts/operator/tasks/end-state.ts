// scripts/operator/tasks/end-state.ts - the task `end-state`: a read-only check of the end state that the build of the use case wants after the last run.
//
//   run      reads the end state, prints each check, and ends with the exit code of the whole: 0 when every check is ok, 4 when no check fails and some wait, 1 when a check fails
//   status   reads the same and prints the same lines. It ends with exit 0 when every check is ok. The runner cannot end `status` with exit 4, so a status that is not done ends with exit 1, a wait
//            included. It never ends with exit 0 and the outcome done for a state that is not done
//
// The data names which records and adverts stay live and which end. No claim, delegation or hold can be left open. Each check gives its result (`ok`, `wait` or `fail`) and a line that says
// what is still to do. A source that cannot be read is a `fail`: it is never a pass. The task signs
// nothing: the claims are read through the read methods of a chain port whose signature throws.
import { readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
// The identity advert codec is at the entry of vector-read, as in the task advert.
import { advertTextFieldsRoundTrip, decodeIdentityAdvertDatum, decodePlutusDataHex, encodePlutusDataHex } from '../../../packages/vector-read/src/index.ts';
import type { IdentityAdvertDatum, PlutusData } from '../../../packages/vector-read/src/index.ts';
import { decodeAttestationDatum, decodeIdentityDatum, encodeAttestationDatum, encodeIdentityDatum, encodeIdentitySpend } from '../../../packages/vector-read/src/identity-codec.ts';
import { collateralAdvice, isCollateralOutput } from '../../checks/lib/collateral.ts';
import { duration, iso, units } from '../../checks/lib/format.ts';
import { StateFile } from '../../checks/lib/state.ts';
import { proveAdvertRetirement, readConfirmedSpend } from '../lib/confirmed-spend.ts';
import type { RecordSpendScript, RecordSpendValueFlow, RecordSpendValueRow } from '../lib/confirmed-spend.ts';
import type { AdvertFact, AdvertSpec, AgentSpec, AttestationFact, Facts, LifecycleSpec, StepOutcome, SubagentSpec, TaskDefinition, TaskSession } from '../lib/contract.ts';
import { readRunning, readRuntimeStatus, runtimesOf } from '../lib/free.ts';
import {
  ATT_TYPES, PURPOSE, attestationState, blake2b256Hex, calculateMinLovelaceFromUTxO, createModule1Port, effectiveStatus, findRecord, formatOutRef, keyHashOf, koiosUtxoInfo, liveDelegations,
  module1FromManifest, parseOutRef, readAttestation, readManifest, withdrawableFrom,
} from '../lib/platform.ts';
import type { AttestationView, RecordUtxo } from '../lib/platform.ts';
import { codeOf, findPublicManifest } from '../lib/registry.ts';
import { holdsSecret } from '../lib/secrets.ts';
// `lib/platform.ts` does not give these names, and this task is their only caller in the pack: the types of the chain port of the kit and the Module-1 deployment type.
import type { Module1Deployment } from '../../../packages/buyer-core/src/index.ts';
import type { ClaimView, Module1Port, Module1Provider } from '../../../packages/usecase-kit/src/dispute/index.ts';

type Result = 'ok' | 'wait' | 'fail';

/** One check: its name, its result, the line that says what is so or what is still to do, and, for a wait that has an end, the time of the end. */
export interface Check { readonly name: string; readonly result: Result; readonly line: string; readonly untilMs: number | null }

/** The end state is not reached because a check fails. The runner turns it into exit 1. */
export class EndStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EndStateError';
  }
}

interface EndStateExtra {
  /** What the last read found, for the machine line. */
  checks: readonly Check[] | null;
}

const MANIFEST_BASE = 'https://raw.githubusercontent.com/Apex-Fusion/vector-agent-modules';
const RUNNING_IMAGES = 'running-images.json';
/** A deposit of an attestation returns this long after the end of its validity. */
const DEPOSIT_DELAY_MS = 90 * 86_400_000;
/** The reason code of a hold that Module-1 puts on an agent after a verdict. */
const JURY_HOLD_REASON = 64;
const READ_TIMEOUT_MS = 20_000;
const MOST_ADVERTS = 50;
const ID = /^[0-9a-f]{64}$/;
const LIFECYCLE_STEPS = ['change-controller', 'recovery-start', 'recovery-wait', 'recovery-complete', 'retire', 'set-successor', 'reclaim'] as const;

const passed = (name: string, line: string): Check => ({ name, result: 'ok', line, untilMs: null });
const waiting = (name: string, line: string, untilMs: number | null = null): Check => ({ name, result: 'wait', line, untilMs });
const failed = (name: string, line: string): Check => ({ name, result: 'fail', line, untilMs: null });

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** An error as a short line: one line, at most 300 characters, and never a text that holds a mark of a secret. */
function shown(err: unknown): string {
  const text = (err instanceof Error ? err.message : String(err)).replace(/\s+/g, ' ').trim().slice(0, 300);
  return holdsSecret(text) ? 'a message that holds a mark of a secret is not shown' : text;
}

/** Runs one check. A read that fails is a `fail` that says that nothing can be told, and never a pass. */
async function attempt(name: string, work: () => Promise<Check>): Promise<Check> {
  try { return await work(); } catch (err) { return failed(name, `cannot tell: ${shown(err)}`); }
}

type Hold = Extract<RecordUtxo['record']['status'], { type: 'Suspended' }>['holds'][number];
const isJuryHold = (hold: Hold): boolean => hold.reason === JURY_HOLD_REASON && hold.by.type === 'Script';

interface RecordRead {
  readonly did: string; readonly status: 'Active' | 'Suspended' | 'Revoked' | 'Retired'; readonly holds: readonly Hold[]; readonly output: RecordUtxo;
}
type RecordResult = { readonly kind: 'read'; readonly read: RecordRead } | { readonly kind: 'problem'; readonly line: string };
type Resolution = { readonly kind: 'read'; readonly metadata: Record<string, unknown> } | { readonly kind: 'problem'; readonly line: string };
interface PublicKey { readonly address: string | null; readonly publicKey: string | null }

/** What the checks share in one read: the facts, the time, and the reads that more than one check needs, each made once. */
interface Context {
  readonly session: TaskSession<EndStateExtra>;
  readonly now: number;
  readonly facts: Readonly<Facts>;
  record(id: string): Promise<RecordResult>;
  resolution(id: string): Promise<Resolution>;
  module1(): Promise<Module1Deployment>;
  publicKeys(): ReadonlyMap<string, PublicKey>;
  reclaimable(read: RecordRead): Promise<bigint>;
}

/** The record of an agent as the node shows it now: its status, and the holds that are in force. */
async function readRecord(session: TaskSession<EndStateExtra>, facts: Readonly<Facts>, now: number, id: string): Promise<RecordResult> {
  const fact = facts.records[id];
  if (fact === undefined) return { kind: 'problem', line: `the facts hold no record of ${id}: run the task register first` };
  if (!ID.test(fact.id) || fact.did !== `did:vector:${fact.id}`) return { kind: 'problem', line: `the record fact of ${id} does not hold a matching DID and identifier` };
  const found = await findRecord(session.chain.provider, session.chain.deployment, fact.id);
  if (found === null) return { kind: 'problem', line: `the record ${fact.did} is not in the identity registry` };
  const status = effectiveStatus(found.record, new Map(), now, now);
  const holds = found.record.status.type === 'Suspended' ? found.record.status.holds.filter((hold) => hold.until > now) : [];
  return { kind: 'read', read: { did: fact.did, status, holds, output: found } };
}

/** The DID resolution of an agent at the gateway, through the hosted tool. The metadata decides: the text of the answer is never read for success. */
async function readResolution(session: TaskSession<EndStateExtra>, facts: Readonly<Facts>, id: string): Promise<Resolution> {
  const fact = facts.records[id];
  if (fact === undefined) return { kind: 'problem', line: `the facts hold no record of ${id}: run the task register first` };
  if (!ID.test(fact.id) || fact.did !== `did:vector:${fact.id}`) return { kind: 'problem', line: `the record fact of ${id} does not hold a matching DID and identifier` };
  const answer = await session.hosted.call('vector_resolve_did', { did: fact.did });
  if (answer.failed) return { kind: 'problem', line: `the hosted tool vector_resolve_did failed: ${shown(answer.message)}` };
  const metadata = answer.json?.didDocumentMetadata;
  if (!isObject(metadata)) return { kind: 'problem', line: 'the answer of vector_resolve_did holds no DID document metadata' };
  const resolution = answer.json?.didResolutionMetadata;
  if (isObject(resolution) && resolution.error != null) return { kind: 'problem', line: 'the gateway returned a DID resolution error' };
  const doc = answer.json?.didDocument;
  const resolvedDid = isObject(doc) ? doc.id : doc === null && metadata.deactivated === true ? metadata.canonicalId : null;
  if (resolvedDid !== fact.did || (metadata.canonicalId !== undefined && metadata.canonicalId !== fact.did)) {
    return { kind: 'problem', line: `the gateway did not resolve the DID of ${id}` };
  }
  return { kind: 'read', metadata };
}

/** The public keys and wallet addresses that the task keys wrote, with the legacy file name supported. */
function readPublicKeys(session: TaskSession<EndStateExtra>): ReadonlyMap<string, PublicKey> {
  const path = findPublicManifest(session.settings.keysDir, session.use.name);
  const file = basename(path);
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(path, 'utf8')); } catch (err) {
    throw new Error(`the public key file ${file} cannot be read (${err instanceof SyntaxError ? 'it is not JSON' : codeOf(err)}): the task keys writes it`);
  }
  if (!isObject(parsed) || !isObject(parsed.keys)) throw new Error(`the public key file ${file} has no keys`);
  if (parsed.use_case !== session.use.name || parsed.network !== session.settings.network.name) throw new Error(`the public key file ${file} is for another use case or another network`);
  const keys = new Map<string, PublicKey>();
  for (const [name, entry] of Object.entries(parsed.keys)) {
    if (isObject(entry)) keys.set(name, {
      address: typeof entry.address === 'string' && entry.address.startsWith('addr') ? entry.address : null,
      publicKey: typeof entry.public_key_hex === 'string' && ID.test(entry.public_key_hex) ? entry.public_key_hex : null,
    });
  }
  return keys;
}

/** The Module-1 deployment, read from the manifest at the pinned commit. It must name the identity registry of the chain of this run. */
async function readModule1(session: TaskSession<EndStateExtra>): Promise<Module1Deployment> {
  const commit = session.settings.module1Commit;
  if (commit === null) throw new Error('OPERATOR_MODULE1_COMMIT is not set: it is the 40 hex digits of the commit of the Module-1 manifest that the deployment uses');
  const source = `${MANIFEST_BASE}/${commit}/${session.use.moduleManifestPath}`;
  const module1 = module1FromManifest(await readManifest(source, 'The Module-1 manifest', session.fetchImpl), source);
  if (module1.identityHash !== session.chain.deployment.identity.hash) throw new Error('the Module-1 manifest names another identity registry than the chain of this run: the commit of the manifest is wrong');
  return module1;
}

/** Read the coefficient without the provider's default. A missing or inconsistent result cannot prove a reclaim. */
async function readCoinsPerByte(session: TaskSession<EndStateExtra>): Promise<bigint> {
  const id = 'end-state';
  const response = await session.fetchImpl(session.settings.urls.ogmios, {
    method: 'POST', headers: { 'content-type': 'application/json' }, redirect: 'manual', signal: AbortSignal.timeout(READ_TIMEOUT_MS),
    body: JSON.stringify({ jsonrpc: '2.0', method: 'queryLedgerState/protocolParameters', params: {}, id }),
  });
  if (!response.ok) throw new Error(`the node did not give the protocol parameters (HTTP ${response.status})`);
  const answer: unknown = await response.json().catch(() => { throw new Error('the node did not give JSON for the protocol parameters'); });
  if (!isObject(answer) || answer.jsonrpc !== '2.0' || answer.id !== id || 'error' in answer || !isObject(answer.result)) {
    throw new Error('the node did not give a protocol parameter result');
  }
  const { minUtxoDepositCoefficient: coefficient, coinsPerUtxoByte: other } = answer.result;
  const coins = coefficient ?? other;
  if (typeof coins !== 'number' || !Number.isSafeInteger(coins) || coins <= 0
      || (coefficient !== undefined && coefficient !== coins) || (other !== undefined && other !== coins)) {
    throw new Error('the node did not give one positive integer for the coins per UTxO byte');
  }
  return BigInt(coins);
}

function makeContext(session: TaskSession<EndStateExtra>): Context {
  const now = session.clock.now();
  const facts = session.facts.read();
  const records = new Map<string, Promise<RecordResult>>();
  const resolutions = new Map<string, Promise<Resolution>>();
  let module1: Promise<Module1Deployment> | null = null;
  let keys: ReadonlyMap<string, PublicKey> | null = null;
  const deposits = new Map<string, Promise<bigint>>();
  let coinsPerByte: Promise<bigint> | null = null;
  const readReclaimable = async ({ output }: RecordRead): Promise<bigint> => {
    const { id, utxo } = output;
    const identity = session.chain.deployment.identity;
    const unit = `${identity.hash}${id}`;
    if (utxo.address !== identity.address || utxo.assets[unit] !== 1n || Object.keys(utxo.assets).length !== 2
        || utxo.datum === undefined || utxo.datum === '' || utxo.scriptRef != null || typeof utxo.assets.lovelace !== 'bigint' || utxo.assets.lovelace <= 0n) {
      throw new Error('the tombstone must hold just its identity token, lovelace and an inline datum at the identity address');
    }
    const minimum = calculateMinLovelaceFromUTxO(await (coinsPerByte ??= readCoinsPerByte(session)), { ...utxo, assets: { lovelace: 0n, [unit]: 1n } });
    if (utxo.assets.lovelace < minimum) throw new Error('the tombstone holds less lovelace than the ledger minimum');
    return utxo.assets.lovelace - minimum;
  };
  return {
    session, now, facts,
    record: (id) => records.get(id) ?? records.set(id, readRecord(session, facts, now, id)).get(id)!,
    resolution: (id) => resolutions.get(id) ?? resolutions.set(id, readResolution(session, facts, id)).get(id)!,
    module1: () => (module1 ??= readModule1(session)),
    publicKeys: () => (keys ??= readPublicKeys(session)),
    reclaimable: (read) => deposits.get(read.did) ?? deposits.set(read.did, readReclaimable(read)).get(read.did)!,
  };
}

// ---- 1. the records ----

/** The end of the hold of the jury, when the record is held by the jury and by nobody else. */
function juryHoldEnd(read: RecordRead): number | null {
  return read.status === 'Suspended' && read.holds.length > 0 && read.holds.every(isJuryHold) ? Math.max(...read.holds.map((hold) => hold.until)) : null;
}

async function recordActive(ctx: Context, name: string, id: string): Promise<Check> {
  const result = await ctx.record(id);
  if (result.kind === 'problem') return failed(name, result.line);
  const { did, status } = result.read;
  if (status === 'Active') return passed(name, `the record ${did} is Active`);
  const until = juryHoldEnd(result.read);
  if (until !== null) return waiting(name, `the record ${did} is on hold from the jury (reason ${JURY_HOLD_REASON}) until ${iso(until)}, in ${duration(until - ctx.now)}: wait for the end of the hold`, until);
  return failed(name, status === 'Suspended'
    ? `the record ${did} is Suspended, and the hold is not a hold of the jury (or the record has no Accountable party in force): it must be Active`
    : `the record ${did} is ${status}: it must be Active`);
}

// Keep the existing label for an Active agent. Terminal agents and extra records use the general label.
const recordCheckOf = (agent: AgentSpec): string => `${agent.end.record === 'active' ? 'record_active' : 'record'}:${agent.id}`;

async function agentRecord(ctx: Context, agent: AgentSpec): Promise<Check> {
  const name = recordCheckOf(agent);
  if (agent.end.record === 'active') return recordActive(ctx, name, agent.id);
  const result = await ctx.record(agent.id);
  if (result.kind === 'problem') return failed(name, result.line);
  const { did, output } = result.read;
  const status = output.record.status;
  const expected = agent.end.record === 'revoked' ? 'Revoked' : 'Retired';
  if (status.type !== expected) return failed(name, `the record ${did} is ${result.read.status}: it must be ${expected}`);
  if (output.record.keys.length !== 0 || output.record.parties.length !== 0 || output.record.pendingRecovery !== null) {
    return failed(name, `the ${expected} record ${did} is not a tombstone`);
  }
  if (status.type === 'Revoked') {
    const fact = ctx.facts.revocations[agent.id];
    if (fact === undefined) return failed(name, `the facts hold no revocation of ${agent.id}`);
    const organisation = ctx.session.use.organisations.find(({ id }) => id === agent.organisation);
    const authority = organisation === undefined ? null : ctx.publicKeys().get(organisation.accountableKey)?.publicKey;
    if (authority == null || status.by.type !== 'KeyHash' || status.by.hash !== keyHashOf(authority)) {
      return failed(name, `the revocation of ${did} is not from the Accountable key of its organisation`);
    }
    const invalidFrom = fact.invalidFrom === null ? null : timeOf(fact.invalidFrom);
    if (invalidFrom === null || status.invalidFrom === null) return failed(name, `the revocation of ${did} has no usable invalidation time`);
    if (!ID.test(fact.tx) || fact.reason !== status.reason || timeOf(fact.revokedAt) !== status.at || invalidFrom !== status.invalidFrom) {
      return failed(name, `the revocation of ${did} on the node does not match the facts`);
    }
  }
  const successor = agent.end.successor;
  let next = '';
  if (successor === null) {
    if (status.successor !== null) return failed(name, `the ${expected} record ${did} names an unexpected successor`);
  } else {
    const use = ctx.session.use;
    if (!use.records.some((record) => record.id === successor) && !use.agents.some((record) => record.id === successor)) {
      return failed(name, `the data names no successor record ${successor} for ${agent.id}`);
    }
    const target = await ctx.record(successor);
    if (target.kind === 'problem') return failed(name, target.line);
    if (status.successor !== target.read.output.id) return failed(name, `the ${expected} record ${did} does not name the expected successor ${target.read.did}`);
    if (target.read.status !== 'Active' || target.read.output.record.lineage.type !== 'Root') {
      return failed(name, `the successor ${target.read.did} is not an Active root record`);
    }
    next = ` and names the successor ${target.read.did}`;
  }
  if (status.type === 'Revoked') return passed(name, `the record ${did} is Revoked${next} and matches the facts`);
  const excess = await ctx.reclaimable(result.read);
  return passed(name, `the record ${did} is Retired${next}; ${excess > 0n ? `the controller can still reclaim ${units(excess)}` : 'there is no deposit above the ledger minimum to reclaim'}`);
}

// ---- 2. the organisation is verified ----

async function organisation(ctx: Context, id: string, organisationId: string): Promise<Check> {
  const name = `organisation:${id}`;
  const domain = ctx.session.use.organisations.find((candidate) => candidate.id === organisationId)?.domain;
  if (domain === undefined) return failed(name, `the data names no organisation ${organisationId} for ${id}`);
  const resolved = await ctx.resolution(id);
  if (resolved.kind === 'problem') return failed(name, resolved.line);
  if (resolved.metadata.deactivated === true) return failed(name, `the gateway shows the record of ${id} as deactivated`);
  const parties: unknown[] = Array.isArray(resolved.metadata.vectorParties) ? resolved.metadata.vectorParties : [];
  const party = parties.find((candidate) => isObject(candidate) && candidate.role === 'accountable' && candidate.organisation === domain);
  if (!isObject(party)) return failed(name, `the gateway shows no Accountable party that names the organisation ${domain}`);
  if (party.organisationVerified === true) return passed(name, `the gateway shows the organisation ${domain} as verified for the Accountable party`);
  return failed(name, `the gateway does not show the organisation ${domain} as verified for the Accountable party: check the TXT value of _did.${domain}. The gateway scans every 10 minutes, and it checks a record that did not change again after 24 hours`);
}

// ---- 3. the adverts ----

/** The last fenced JSON block of a text, as a value of any kind. The hosted answer reader of the checks keeps objects only, and the list of suppliers is a list. */
function lastJsonValue(text: string): unknown {
  const block = [...text.matchAll(/```json\n([\s\S]*?)\n```/g)].at(-1);
  if (block === undefined) return undefined;
  try { return JSON.parse(block[1]!); } catch { return undefined; }
}

const KEY_HASH = /^[0-9a-f]{56}$/;
interface ListedAdvert { readonly agent: string | null; readonly model: string; readonly supplier: string }

/** All references of one capability, whether free or working. A truncated listing cannot prove the expected set. */
async function listedRefs(session: TaskSession<EndStateExtra>, capability: string): Promise<Map<string, ListedAdvert>> {
  const answer = await session.hosted.call('vector_marketplace_list_suppliers', { capability_id: capability, only_free: false, limit: MOST_ADVERTS });
  if (answer.failed) throw new Error(`the hosted tool vector_marketplace_list_suppliers failed: ${shown(answer.message)}`);
  const rows = lastJsonValue(answer.text);
  if (!Array.isArray(rows)) throw new Error('the answer of vector_marketplace_list_suppliers holds no list of adverts');
  if (rows.length >= MOST_ADVERTS) throw new Error('the advert listing reached its row limit, so its complete set is unknown');
  const listed = new Map<string, ListedAdvert>();
  for (const row of rows as unknown[]) {
    if (!isObject(row) || typeof row.advert_ref !== 'string' || row.capability_id !== capability || typeof row.model !== 'string'
        || typeof row.supplier_pkh !== 'string' || !KEY_HASH.test(row.supplier_pkh)
        || (row.agent_id === null ? row.did !== null : typeof row.agent_id !== 'string' || !ID.test(row.agent_id) || row.did !== `did:vector:${row.agent_id}`)) {
      throw new Error('a row of the answer of vector_marketplace_list_suppliers is no advert of the requested capability');
    }
    const ref = advertRef(row.advert_ref);
    if (listed.has(ref)) throw new Error('the advert listing gives the same reference twice');
    listed.set(ref, { agent: row.agent_id as string | null, model: row.model, supplier: row.supplier_pkh });
  }
  return listed;
}

function advertRef(ref: string): string {
  const parsed = parseOutRef(ref);
  if (!Number.isSafeInteger(parsed.outputIndex)) throw new Error('an advert reference has an invalid output index');
  return formatOutRef(parsed.txHash, parsed.outputIndex);
}

interface ExpectedAdvert {
  readonly retireStep: string;
  readonly agent: AgentSpec; readonly spec: AdvertSpec; readonly fact: AdvertFact; readonly didId: string; readonly supplier: string;
}

/** The immutable terms of the advert that the fact names. The advert has no token; its output holds the exact deposit in lovelace only. */
function matchesAdvert(datum: IdentityAdvertDatum, { agent, spec, fact, didId, supplier }: ExpectedAdvert): boolean {
  return datum.status === 'Active' && datum.agent_id === didId && datum.supplier_pkh === supplier
    && datum.capability_id === agent.capability && datum.model === spec.model && datum.max_output_tokens === spec.maxOutputTokens
    && datum.max_processing_ms === spec.windowMs && datum.price_lovelace === spec.priceLovelace
    && datum.supplier_bond_lovelace === spec.supplierBondLovelace && datum.buyer_bond_lovelace === spec.buyerBondLovelace
    && datum.endpoint_url === fact.endpoint && datum.detail_uri === fact.detailUri && datum.detail_hash === fact.detailHash;
}

function advertDatum(bytes: string | null | undefined): IdentityAdvertDatum | null {
  if (!bytes) return null;
  try { return decodeIdentityAdvertDatum(bytes); } catch { return null; }
}

interface RetireReceipt { readonly tx: string; readonly ref: string }
const ADVERT_JOURNAL = /^advert(?:\.([a-z0-9][a-z0-9-]{0,31}))?\.state\.json$/;

/** The note names a candidate spend. The chain, not the note, proves which advert that spend retired. */
function retireReceipts(ctx: Context, steps: ReadonlySet<string>): ReadonlyMap<string, ReadonlyMap<string, RetireReceipt>> {
  const { settings, use } = ctx.session;
  const receipts = new Map<string, Map<string, RetireReceipt>>();
  for (const name of readdirSync(settings.stateDir)) {
    const label = ADVERT_JOURNAL.exec(name);
    if (label === null) continue;
    const journal = StateFile.peek(join(settings.stateDir, name));
    if (journal === null || journal.check !== 'advert' || journal.network !== settings.network.name
        || journal.record !== (label[1] === undefined ? use.name : `${use.name}:${label[1]}`)) {
      throw new Error('an advert journal does not match its task, run, use case or network');
    }
    for (const step of steps) {
      const note = journal.notes[step];
      if (note === undefined) continue;
      if (!isObject(note) || !isObject(note.refs) || typeof note.refs.retiredRef !== 'string' || typeof note.tx_hash !== 'string' || !ID.test(note.tx_hash)
          || typeof note.confirmed_at !== 'string' || timeOf(note.confirmed_at) === null) {
        throw new Error(`an advert journal holds no usable confirmed receipt for ${step}`);
      }
      const ref = advertRef(note.refs.retiredRef);
      const tx = note.tx_hash;
      let copies = receipts.get(step);
      if (copies === undefined) {
        copies = new Map();
        receipts.set(step, copies);
      }
      copies.set(`${tx}:${ref}`, { tx, ref });
    }
  }
  return receipts;
}

async function adverts(ctx: Context): Promise<Check> {
  const name = 'adverts';
  const problems: string[] = [];
  const waits: string[] = [];
  const retired: string[] = [];
  const groups = new Map<string, Map<string, ExpectedAdvert>>();
  const known = new Map<string, ExpectedAdvert>();
  const owners = new Set<string>();
  const lookup = ctx.publicKeys();
  for (const agent of ctx.session.use.agents) {
    const group = groups.get(agent.capability) ?? new Map<string, ExpectedAdvert>();
    groups.set(agent.capability, group);
    const record = ctx.facts.records[agent.id];
    if (record === undefined || !ID.test(record.id) || record.did !== `did:vector:${record.id}`) {
      problems.push(`the facts hold no usable record of ${agent.id}, so its adverts cannot be checked`);
      continue;
    }
    if (owners.has(record.id)) throw new Error('two agents have the same record identifier in the facts');
    owners.add(record.id);
    const held = ctx.facts.adverts[agent.id] ?? {};
    for (const spec of agent.adverts) {
      const { model } = spec;
      const key = lookup.get(spec.supplierKey)?.publicKey;
      if (key == null) {
        problems.push(`the public key file lists no supplier key for ${agent.id}/${model}`);
        continue;
      }
      const supplier = keyHashOf(key);
      const fact = held[model];
      if (fact === undefined) {
        problems.push(`the facts hold no reference for the advert ${agent.id}/${model}: run the task advert first`);
        continue;
      }
      const ref = advertRef(fact.ref);
      if (known.has(ref)) {
        problems.push(`more than one advert fact names ${ref}`);
        continue;
      }
      const origin = spec.origin.replace(/\/+$/, '');
      if (parseOutRef(ref).txHash !== fact.tx || !ID.test(fact.detailHash) || fact.endpoint !== origin || fact.detailUri !== `${origin}/agent.json`) {
        problems.push(`the advert fact of ${agent.id}/${model} does not name its post transaction and manifest`);
        continue;
      }
      const entry = { agent, spec, fact, didId: record.id, supplier, retireStep: `part.retire:${agent.id}:${model}` };
      known.set(ref, entry);
      group.set(ref, entry);
    }
    for (const model of Object.keys(held)) {
      if (!agent.adverts.some((spec) => spec.model === model)) problems.push(`the facts hold an advert ${agent.id}/${model} that the data do not name`);
    }
  }
  const { provider, deployment } = ctx.session.chain;
  const address = deployment.advert.address;
  // Read the node directly. Only a known reference or a traced spend can attribute an output to these adverts.
  const unspent = await provider.getUtxos(address);
  const live = new Set<string>();
  for (const output of unspent) {
    if (output.address !== address) throw new Error('the node returned an output at another address in the advert scan');
    const ref = advertRef(formatOutRef(output.txHash, output.outputIndex));
    if (live.has(ref)) throw new Error('the node returned the same advert output twice');
    live.add(ref);
    // A datum can name any DID. Do not credit or reject an advert that has no link to a fact.
    const expected = known.get(ref);
    if (expected === undefined) continue;
    if (expected.agent.end.advert === 'retired') {
      problems.push(`the node still holds an unspent output for a retired advert (${ref})`);
      continue;
    }
    const datum = advertDatum(output.datum);
    if (datum === null || !advertTextFieldsRoundTrip(output.datum!) || !matchesAdvert(datum, expected)
        || output.assets.lovelace !== expected.spec.depositLovelace || Object.keys(output.assets).length !== 1 || output.scriptRef != null) {
      problems.push(`the node output ${ref} does not match the advert of ${expected.agent.id}/${expected.spec.model}`);
    }
  }

  const toVerify = new Map<string, ExpectedAdvert>();
  for (const [ref, want] of known) if (want.agent.end.advert === 'retired' && !live.has(ref)) toVerify.set(ref, want);
  const receipts = toVerify.size === 0 ? null : retireReceipts(ctx, new Set([...toVerify.values()].map(({ retireStep }) => retireStep)));
  const returned = new Set<string>();
  for (const [ref, want] of toVerify) {
    const tag = `${want.agent.id}/${want.spec.model} (${ref})`;
    const wallet = lookup.get(want.spec.supplierKey)?.address;
    const candidates = receipts?.get(want.retireStep);
    if (wallet == null || candidates === undefined) {
      problems.push(`the advert journals hold no confirmed retire of ${tag}`);
      continue;
    }
    let matches = 0;
    let why = 'no receipt matches the recorded advert';
    for (const { ref: final, tx } of candidates.values()) {
      try {
        const problem = await verifyAdvertRetire(ctx, want, ref, final, tx, wallet, live);
        if (problem === null) matches += 1;
        else why = problem;
      } catch (err) {
        why = shown(err);
      }
      if (matches > 1) break;
    }
    if (matches === 1) returned.add(ref);
    else problems.push(`the retire of ${tag}: ${matches > 1 ? 'more than one confirmed receipt matches the recorded advert' : why}`);
  }
  let until = 0;
  const counts = new Map<string, number>();
  for (const [capability, expected] of groups) {
    const listed = await listedRefs(ctx.session, capability);
    for (const [ref, want] of expected) {
      const { agent, spec: { model }, didId, supplier } = want;
      const listing = listed.get(ref);
      if (agent.end.advert === 'retired') {
        if (listing !== undefined) problems.push(`the indexer still lists the retired advert ${agent.id}/${model} (${ref})`);
        if (live.has(ref)) continue;
        if (returned.has(ref)) retired.push(`${agent.id}/${model} (${ref})`);
        continue;
      }
      if (!live.has(ref)) {
        problems.push(`the node does not hold the listed advert ${agent.id}/${model} (${ref})`);
        continue;
      }
      const record = await ctx.record(agent.id);
      if (record.kind !== 'read') {
        problems.push(record.line);
        continue;
      }
      const current = record.read.output.record;
      if (current.status.type !== 'Revoked' && current.status.type !== 'Retired'
          && (!current.keys.some((key) => key.keyType === 'Ed25519' && keyHashOf(key.key) === supplier && (key.purposes & PURPOSE.transaction) !== 0)
            || !current.capabilities.includes(Buffer.from(capability, 'utf8').toString('hex')))) {
        problems.push(`the record of ${agent.id} does not authorize the supplier and capability of ${model}`);
      }
      if (listing !== undefined) {
        if (listing.agent !== didId || listing.model !== model) problems.push(`the indexer lists ${ref} for another record or model, not ${agent.id}/${model}`);
        else if (listing.supplier !== supplier) problems.push(`the indexer lists ${ref} for another supplier, not ${agent.id}/${model}`);
        else counts.set(agent.id, (counts.get(agent.id) ?? 0) + 1);
        continue;
      }
      const held = juryHoldEnd(record.read);
      if (held === null) problems.push(`the indexer does not list the advert ${agent.id}/${model} (${ref})`);
      else {
        waits.push(`the advert ${agent.id}/${model} is not listed while the record is on hold until ${iso(held)}`);
        until = Math.max(until, held);
      }
    }
    for (const ref of listed.keys()) {
      if (!expected.has(ref)) problems.push(`the indexer lists an advert of the capability ${capability} that the facts do not hold (${ref})`);
    }
  }
  if (problems.length > 0) return failed(name, `${[...problems, ...waits].join('; ')}: the node and indexer must show exactly the adverts of the data`);
  if (waits.length > 0) return waiting(name, `${waits.join('; ')}: the adverts return when the hold ends`, until);
  const active = [...counts].map(([agent, count]) => `${agent} ${count}`).join(', ');
  return passed(name, `the indexer lists exactly the adverts of the data (${active}), with matching node outputs`
    + (retired.length === 0 ? '' : `; confirmed retires return each traced deposit less its transaction fee, with no traced output left unspent (${retired.join(', ')})`));
}

// ---- 4. the claims ----

/** A wait that never holds the process open: the kit bounds each read with it, and the timer is not cancelled when the read ends first. (`Promise.withResolvers` is not in the types of the target of the pack.) */
const boundedSleep = (ms: number): Promise<void> => new Promise<void>((resolve) => { setTimeout(resolve, ms).unref(); });

function refuseSigning(): never {
  throw new Error('the end-state check signs nothing');
}

/** The chain port of the kit for the service wallet of an agent. Its signature throws: the task reads claims only. */
function portOf(ctx: Context, agent: AgentSpec, id: string, module1: Module1Deployment): Module1Port {
  const address = ctx.publicKeys().get(agent.serviceKey)?.address;
  if (address == null) throw new Error(`the public key file lists no wallet for the key ${agent.serviceKey}`);
  // The real provider is an OgmiosProvider and gives the start time of the chain. A provider that does not is no node of Vector.
  const candidate = ctx.session.chain.provider as Partial<Module1Provider>;
  if (typeof candidate.getSystemStartMs !== 'function') throw new Error('the provider of the chain gives no start time of the chain, and the chain port needs it');
  const provider = ctx.session.chain.provider as Module1Provider;
  const clock = (): number => ctx.session.clock.now();
  return createModule1Port({
    provider, module1, address, agent_id: id, sign: refuseSigning, clock, sleep: boundedSleep, koios_url: ctx.session.chain.koiosUrl, fetch: ctx.session.chain.fetchImpl,
    identity_deployment: null, valid_minutes: 30,
  });
}

/** Every live claim output of Module-1, in every state, read within the time of one read. A read that fails or takes too long is an error, and never a list that leaves a claim out. */
async function readClaims(port: Module1Port): Promise<readonly ClaimView[]> {
  const late = boundedSleep(READ_TIMEOUT_MS).then((): never => { throw new Error(`the claims were not read within ${READ_TIMEOUT_MS / 1000} s`); });
  return Promise.race([port.readClaims(), late]);
}

async function claims(ctx: Context, agent: AgentSpec): Promise<Check> {
  const name = `claims:${agent.id}`;
  const fact = ctx.facts.records[agent.id];
  if (fact === undefined) return failed(name, `the facts hold no record of the agent ${agent.id}: run the task register first`);
  const views = await readClaims(portOf(ctx, agent, fact.id, await ctx.module1()));
  const known = Object.entries(ctx.facts.claims).flatMap(([run, byAgent]) => {
    const claim = byAgent[agent.id];
    return claim === undefined ? [] : [{ run, claim }];
  });
  // The claims of the agent in every state, and each output that holds the token of a claim of the facts: a claim that is challenged keeps its token in a new output.
  const tokens = new Set(known.map((entry) => entry.claim.claimToken));
  const live = views.filter((view) => view.claimer === fact.did || tokens.has(view.token));
  const problems: string[] = [];
  const waits: string[] = [];
  const dates: number[] = [];
  for (const view of live) {
    const run = known.find((entry) => entry.claim.claimToken === view.token)?.run;
    const where = `the claim ${view.ref}${run === undefined ? ' (the facts do not hold it)' : ` of the run ${run}`}`;
    const cleanup = `the task claim, cleanup${run === undefined ? '' : ` --run ${run}`}`;
    if (view.state !== 'Open') {
      waits.push(`${where} is ${view.state}, so it is not closed: wait for the verdict of the jury and for the end of the claim output, then run ${cleanup} --submit`);
      continue;
    }
    const from = withdrawableFrom(view);
    if (from > ctx.now) {
      waits.push(`${where} is open, and its window ends in ${duration(from - ctx.now)} (at ${iso(from)}): withdraw it after that with ${cleanup}`);
      dates.push(from);
    } else {
      problems.push(`${where} is open and its window has ended: withdraw it with ${cleanup} --submit`);
    }
  }
  // A claim of the facts is closed when no live output holds its token. The facts may say `not open` only then: a challenged claim keeps its token.
  const held = new Set(live.map((view) => view.token));
  for (const { run, claim } of known) {
    if (held.has(claim.claimToken) || claim.withdrawTx !== null) continue;
    waits.push(`the claim of the run ${run} is not open, and the facts do not say so: run the task claim, cleanup --run ${run} --submit to record it`);
  }
  if (problems.length > 0) return failed(name, [...problems, ...waits].join('; '));
  if (waits.length > 0) return waiting(name, waits.join('; '), dates.length === waits.length ? Math.max(...dates) : null);
  return passed(name, `the agent ${agent.id} has no live claim in any state${known.length === 0 ? '' : `; the ${known.length} claim(s) of the facts are withdrawn or not open`}`);
}

// ---- 5. the delegations ----

async function delegations(ctx: Context): Promise<Check> {
  const name = 'delegations';
  const delegates = new Map<string, string>();
  for (const agent of [...ctx.session.use.agents, ...ctx.session.use.subagents, ...ctx.session.use.records]) {
    const fact = ctx.facts.records[agent.id];
    if (fact === undefined || !ID.test(fact.id) || fact.did !== `did:vector:${fact.id}`) {
      return failed(name, `the facts hold no usable record of ${agent.id}, so its delegations cannot be checked`);
    }
    if (delegates.has(fact.id)) return failed(name, 'two record facts have the same identifier, so their delegations cannot be checked');
    delegates.set(fact.id, agent.id);
  }
  if (delegates.size === 0) return failed(name, 'the facts hold no record of an agent, so no delegate is known: run the task register first');
  const live = (await liveDelegations(ctx.session.chain.provider, ctx.session.chain.deployment)).filter(({ delegation }) =>
    delegates.has(delegation.delegate) || (delegation.delegator.type === 'Agent' && delegates.has(delegation.delegator.id)));
  if (live.length === 0) return passed(name, `no live delegation has one of the agents as its delegate (${[...delegates.values()].join(', ')})`);
  const lines = live.map((entry) => {
    const delegator = entry.delegation.delegator;
    const who = delegator.type === 'PrincipalKey' ? `delegator key hash ${delegator.hash}` : `delegator agent ${delegator.id}`;
    return `the delegation ${entry.id} to ${delegates.get(entry.delegation.delegate) ?? entry.delegation.delegate} is live, ${who}`;
  });
  const hirer = live.some((entry) => entry.delegation.delegator.type === 'PrincipalKey');
  return failed(name, `${lines.join('; ')}. ${hirer ? 'The operator cannot end the delegation of a hirer: ask the hirer to end it.' : ''}${live.some((entry) => entry.delegation.delegator.type === 'Agent') ? ' An agent ends its own sub-delegation: check its service.' : ''}`.trimEnd());
}

// ---- 6. the holds ----

const authorText = (by: Hold['by']): string => (by.type === 'KeyHash' ? `the key hash ${by.hash}` : by.type === 'ControllerSet' ? 'the controller' : `the script ${by.hash}`);

async function holds(ctx: Context): Promise<Check> {
  const name = 'holds';
  const on: string[] = [];
  const unread: string[] = [];
  for (const agent of ctx.session.use.agents) {
    const record = await ctx.record(agent.id);
    if (record.kind === 'problem') {
      unread.push(agent.id);
      continue;
    }
    for (const hold of record.read.holds) {
      if (hold.by.type !== 'Script') on.push(`the record ${record.read.did} of ${agent.id} has a hold of ${authorText(hold.by)} until ${iso(hold.until)}`);
    }
  }
  const open = Object.entries(ctx.facts.holds).filter(([, hold]) => hold.suspendTx !== null && hold.liftTx === null).map(([run]) => run);
  if (on.length > 0) return failed(name, `${on.join('; ')}: lift it with the task hold, cleanup${open.length === 0 ? '' : ` --run ${open.join(' or --run ')}`} --submit`);
  if (unread.length > 0) return failed(name, `cannot tell: the record of ${unread.join(', ')} could not be read`);
  return passed(name, `no hold of this pack is on${open.length === 0 ? '' : `; the facts show no lift for the run(s) ${open.join(', ')}, and the node shows no hold, so the hold ended`}`);
}

// ---- 7. the wallets ----

async function wallets(ctx: Context): Promise<Check> {
  const name = 'wallets';
  const keys = ctx.publicKeys();
  const missing: string[] = [];
  const low: string[] = [];
  for (const line of ctx.session.use.funding) {
    const address = keys.get(line.wallet)?.address;
    if (address == null) {
      missing.push(line.wallet);
      continue;
    }
    const outputs = await ctx.session.chain.provider.getUtxos(address);
    const held = outputs.reduce((sum, output) => sum + (output.assets.lovelace ?? 0n), 0n);
    const needed = line.collateralLovelace + line.floatLovelace / 2n;
    if (held < needed) low.push(`${line.wallet} holds ${units(held)} and needs ${units(needed)} (half of its float ${units(line.floatLovelace)} and its collateral ${units(line.collateralLovelace)})`);
    if (line.collateralLovelace > 0n && !outputs.some(isCollateralOutput)) low.push(`${line.wallet} has no pure output of 5 units or more as collateral. ${collateralAdvice(address)}`);
  }
  if (missing.length > 0) return failed(name, `the public key file lists no wallet for ${missing.join(', ')}`);
  if (low.length > 0) return waiting(name, `${low.join('; ')}: top the wallet up by hand`);
  return passed(name, `each of the ${ctx.session.use.funding.length} wallets of the funding table holds at least half of its float and its collateral output`);
}

// ---- 8. the attestations ----

/** A time of the facts: a time with a date, a `T` and a zone, or POSIX milliseconds in digits. Null for any other text. */
function timeOf(text: string): number | null {
  const parsed = /^\d{12,}$/.test(text) ? Number(text)
    : /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(text) ? Date.parse(text) : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed <= 8_640_000_000_000_000 - DEPOSIT_DELAY_MS ? parsed : null;
}

/** The identifiers of the attestations that the gateway lists in `vectorProvenance`. */
function provenanceIds(metadata: Record<string, unknown>): ReadonlySet<string> {
  const provenance = metadata.vectorProvenance;
  const ids = new Set<string>();
  if (provenance === undefined) return ids;
  if (!isObject(provenance) || !Array.isArray(provenance.attestations)) throw new Error('the gateway gave no readable vectorProvenance list');
  for (const entry of provenance.attestations as unknown[]) {
    if (!isObject(entry) || typeof entry.id !== 'string' || !ID.test(entry.id)) throw new Error('the gateway gave no usable attestation identifier in vectorProvenance');
    ids.add(entry.id);
  }
  return ids;
}

/** Match the authentic output to the recorded attestation. Neither a gateway entry nor a matching digest alone supplies that proof. */
function attestationMatches(
  view: AttestationView | null, fact: Pick<AttestationFact, 'digest' | 'locator' | 'issuedAt' | 'validUntil'>,
  subject: string, issuer: string, type: number, format: number, solicited: boolean,
): view is AttestationView {
  if (view === null) return false;
  const datum = view.attestation;
  return datum.subject === subject && datum.issuer === issuer && datum.issuerId === null && datum.attType === type && datum.format === format
    && datum.solicited === solicited && datum.digest === fact.digest && datum.locator === Buffer.from(fact.locator, 'utf8').toString('hex')
    && datum.issuedAt === timeOf(fact.issuedAt) && datum.validUntil === timeOf(fact.validUntil) && datum.validUntil !== null;
}

function depositDate(view: AttestationView): string {
  return view.withdrawableFrom === null ? 'no deposit date' : `deposit due ${iso(view.withdrawableFrom)}`;
}

async function attestations(ctx: Context): Promise<Check> {
  const name = 'attestations';
  const problems: string[] = [];
  const lines: string[] = [];
  const use = ctx.session.use;
  for (const spec of use.attestations) {
    const agent = use.agents.find(({ id }) => id === spec.agent);
    const record = ctx.facts.records[spec.agent];
    if (agent === undefined || record === undefined) {
      problems.push(`the record of ${spec.agent} is unknown, so its attestations cannot be checked`);
      continue;
    }
    const byType = ctx.facts.attestations[agent.id];
    const types = spec.types.filter((type) => {
      if (byType?.[type] !== undefined) return true;
      problems.push(`the facts hold no attestation of the type ${type} for the agent ${agent.id}: run the task attest first`);
      return false;
    });
    if (types.length === 0) continue;
    if (agent.end.record !== 'active') {
      const signer = agent.parties.find(({ role }) => role === 'Provider')?.signer;
      const issuer = signer?.kind === 'key' ? ctx.publicKeys().get(signer.key)?.publicKey : null;
      if (issuer == null) {
        problems.push(`the public key file lists no Provider key for ${agent.id}`);
        continue;
      }
      for (const type of types) {
        const fact = byType![type]!;
        const view = await readAttestation(ctx.session.chain, fact.id);
        if (!attestationMatches(view, fact, record.id, issuer, ATT_TYPES[type], spec.format, true) || view.attestation.status.type !== 'AttActive'
            || (view.attestation.envelopeSig !== null) !== fact.envelope) {
          problems.push(`the attestation ${agent.id}/${type} does not match the facts on the node`);
          continue;
        }
        lines.push(`${agent.id}/${type} ${fact.id} is on the node, valid until ${iso(view.attestation.validUntil!)}, ${depositDate(view)}`);
      }
      continue;
    }
    const resolved = await ctx.resolution(agent.id);
    if (resolved.kind === 'problem') {
      problems.push(`${agent.id}: ${resolved.line}`);
      continue;
    }
    const listed = provenanceIds(resolved.metadata);
    for (const type of types) {
      const fact = byType![type]!;
      const until = timeOf(fact.validUntil);
      if (until === null || !ID.test(fact.id)) {
        problems.push(`the facts hold no usable identifier or validity time for ${agent.id}/${type}`);
        continue;
      }
      const expired = until <= ctx.now;
      const isListed = listed.has(fact.id);
      if (!isListed && !expired) problems.push(`the attestation ${agent.id}/${type} ${fact.id} is not listed in vectorProvenance`);
      lines.push(`${agent.id}/${type} ${fact.id} is ${isListed ? 'listed in vectorProvenance' : expired ? 'expired and not listed' : 'NOT listed in vectorProvenance'}, valid until ${iso(until)}, deposit due ${iso(until + DEPOSIT_DELAY_MS)}`);
    }
  }
  if (problems.length > 0) return failed(name, [...problems, ...lines].join('; '));
  return passed(name, lines.length === 0 ? 'the facts hold no attestation' : lines.join('; '));
}

function lovelaceOf(value: unknown): bigint | null {
  if (typeof value === 'string' && /^[0-9]{1,20}$/.test(value)) return BigInt(value);
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : null;
}

/** Convert the bounded JSON representation without rounding integers or guessing which variant the object denotes. */
function plutusOfKoios(value: unknown, depth = 0): PlutusData {
  if (depth >= 32 || !isObject(value)) throw new Error('the transaction history has no usable Plutus datum');
  const keys = Object.keys(value);
  const nest = (child: unknown): PlutusData => plutusOfKoios(child, depth + 1);
  if (keys.length === 1) {
    if ((typeof value.int === 'number' && Number.isSafeInteger(value.int)) || (typeof value.int === 'string' && /^-?\d{1,40}$/.test(value.int))) {
      return { kind: 'int', value: BigInt(value.int) };
    }
    if (typeof value.bytes === 'string' && /^(?:[0-9a-f]{2})*$/i.test(value.bytes)) return { kind: 'bytes', hex: value.bytes.toLowerCase() };
    if (Array.isArray(value.list)) return { kind: 'list', items: value.list.map(nest) };
    if (Array.isArray(value.map)) return { kind: 'map', entries: value.map.map((entry: unknown) => {
      if (!isObject(entry) || Object.keys(entry).length !== 2) throw new Error('the transaction history has no usable Plutus datum');
      return [nest(entry.k), nest(entry.v)];
    }) };
  }
  if (keys.length === 2 && typeof value.constructor === 'number' && Number.isSafeInteger(value.constructor)
      && value.constructor >= 0 && Array.isArray(value.fields)) {
    return { kind: 'constr', index: BigInt(value.constructor), fields: value.fields.map(nest) };
  }
  throw new Error('the transaction history has no usable Plutus datum');
}

/** The structured value needs the original bytes before its hash can be verified. */
interface DatumHashCheck { readonly canonical: string; readonly hash: string }

/** Compare data in one canonical encoding and check the hash against the original bytes when available. */
function historyDatum(inline: unknown, hash: unknown, equivalent?: string): string | DatumHashCheck | null {
  if (inline != null && !isObject(inline)) throw new Error('the transaction history has an invalid datum member');
  const bytes = isObject(inline) ? inline.bytes : null;
  const value = isObject(inline) ? inline.value : null;
  if (bytes != null && (typeof bytes !== 'string' || !/^(?:[0-9a-f]{2})+$/i.test(bytes))) throw new Error('the transaction history has invalid datum bytes');
  if (hash != null && (typeof hash !== 'string' || !ID.test(hash))) throw new Error('the transaction history has an invalid datum hash');
  const normalized = typeof bytes === 'string' ? encodePlutusDataHex(decodePlutusDataHex(bytes)) : null;
  const fromValue = value == null ? null : encodePlutusDataHex(plutusOfKoios(value));
  if (normalized !== null && fromValue !== null && normalized !== fromValue) throw new Error('the transaction history datum bytes and value disagree');
  const canonical = normalized ?? fromValue;
  if (hash == null) return canonical;
  const exactBytes = typeof bytes === 'string' ? bytes : canonical ?? equivalent;
  if (exactBytes === undefined) return null;
  if (blake2b256Hex(Buffer.from(exactBytes, 'hex')) === hash) return canonical ?? encodePlutusDataHex(decodePlutusDataHex(exactBytes));
  if (typeof bytes !== 'string' && equivalent !== undefined && blake2b256Hex(Buffer.from(equivalent, 'hex')) === hash) {
    const tied = encodePlutusDataHex(decodePlutusDataHex(equivalent));
    if (canonical === tied) return tied;
  }
  if (typeof bytes !== 'string' && canonical !== null) return { canonical, hash };
  throw new Error('the transaction history datum does not match its hash');
}

async function archivedDatum(ctx: Context, row: RecordSpendValueRow, equivalent?: string): Promise<string | null> {
  const declaredHash = row.datum_hash ?? row.inline_datum?.hash;
  const found = historyDatum(row.inline_datum, declaredHash, equivalent);
  if (typeof found === 'string') return found;
  const hash = found?.hash ?? declaredHash;
  const { koiosUrl, fetchImpl } = ctx.session.chain;
  const [output, ...extra] = await koiosUtxoInfo(koiosUrl, [row.ref], fetchImpl, 512 * 1024);
  if (output === undefined || extra.length !== 0 || formatOutRef(output.tx_hash, output.tx_index) !== row.ref
      || output.address !== row.address || lovelaceOf(output.value) !== row.lovelace
      || (hash != null && output.datum_hash != null && output.datum_hash !== hash)) {
    if (found !== null) throw new Error('the transaction history datum does not match its hash');
    return null;
  }
  if (found !== null && typeof output.inline_datum?.bytes !== 'string') throw new Error('the transaction history datum does not match its hash');
  const checked = historyDatum(output.inline_datum, hash ?? output.datum_hash, equivalent);
  if (found !== null && checked !== found.canonical) throw new Error('the transaction history datum bytes and value disagree');
  return typeof checked === 'string' ? checked : null;
}

function tokenOutput(outputs: readonly RecordSpendValueRow[], script: { address: string; hash: string }, id: string): RecordSpendValueRow | null {
  let found: RecordSpendValueRow | null = null;
  for (const row of outputs) {
    if (row.address !== script.address) continue;
    const assets = row.asset_list;
    if (assets == null) return null;
    const matching = assets.find((asset) => asset.policy_id === script.hash && asset.asset_name === id);
    if (matching === undefined) continue;
    if (found !== null || assets.length !== 1 || matching.quantity !== '1') return null;
    found = row;
  }
  return found;
}

function witnessMatches(witness: RecordSpendScript, expected: string): boolean {
  return historyDatum(witness.redeemer, witness.redeemer.hash, expected) === expected;
}

// The identity advert validator uses this empty constructor for UpdateAdvert.
const ADVERT_UPDATE = 'd87a80';

/** Follow recorded updates back to the declared advert. Only a confirmed Retire with actual supplier credit ends this lineage. */
async function verifyAdvertRetire(
  ctx: Context, want: ExpectedAdvert, original: string, final: string, txHash: string, wallet: string, live: ReadonlySet<string>,
): Promise<string | null> {
  const script = ctx.session.chain.deployment.advert;
  const spend = await readConfirmedSpend(ctx.session, txHash, { withDetails: true });
  let input = spend.inputs.find(({ ref }) => ref === final);
  if (input === undefined) return 'the transaction did not spend the recorded advert input';
  proveAdvertRetirement(spend, {
    advertRef: final, advertAddress: script.address, advertScriptHash: script.hash, supplierAddress: wallet, depositLovelace: input.lovelace,
  });
  for (let depth = 0; depth < 16; depth += 1) {
    if (live.has(input.ref)) return `the node still holds the traced advert output ${input.ref}`;
    const bytes = await archivedDatum(ctx, input);
    const datum = advertDatum(bytes);
    if (input.address !== script.address || input.asset_list?.length !== 0
        || datum === null || datum.agent_id !== want.didId || datum.supplier_pkh !== want.supplier) return 'an advert in the lineage does not match the expected record and supplier';
    if (input.ref === original) {
      return input.lovelace === want.spec.depositLovelace && advertTextFieldsRoundTrip(bytes!) && matchesAdvert(datum, want)
        ? null : 'the original advert does not match its recorded terms or deposit';
    }
    const update = await readConfirmedSpend(ctx.session, parseOutRef(input.ref).txHash, { withDetails: true });
    const previous = update.spends?.filter(({ scriptHash }) => scriptHash === script.hash) ?? [];
    const inputRef = input.ref;
    const made = update.outputs.find(({ ref }) => ref === inputRef);
    if (previous.length !== 1 || !witnessMatches(previous[0]!, ADVERT_UPDATE) || made === undefined || made.address !== input.address
        || made.lovelace !== input.lovelace || made.asset_list?.length !== 0
        || (await archivedDatum(ctx, made, bytes!)) !== bytes) {
      return 'the retirement cannot be traced back through the advert updates';
    }
    const predecessor = update.inputs.find(({ ref }) => ref === previous[0]!.inputRef);
    if (predecessor === undefined) return 'the advert update does not show its spent input';
    if (predecessor.lovelace > input.lovelace && (update.inputs.some(({ ref, address }) => ref !== predecessor.ref && address !== wallet)
        || update.outputs.some(({ ref, address }) => ref !== inputRef && address !== wallet)
        || walletCredit(wallet, update) !== predecessor.lovelace - input.lovelace - update.fee)) {
      return 'an advert update reduced the deposit without a matching supplier credit';
    }
    input = predecessor;
  }
  return 'the advert lineage reaches its read limit';
}

function walletCredit(address: string, { inputs, outputs }: RecordSpendValueFlow): bigint {
  let net = 0n;
  for (const output of outputs) if (output.address === address) net += output.lovelace;
  for (const input of inputs) if (input.address === address) net -= input.lovelace;
  return net;
}

/** The issue output became revoked in the named spend. The contest spends that revoked output and leaves the current one. */
async function complianceLineage(ctx: Context, fact: Facts['compliance'][string], view: AttestationView, revokeTx: string, contestTx: string): Promise<boolean> {
  const script = ctx.session.chain.deployment.attestation;
  const [revoke, contest] = await Promise.all([
    readConfirmedSpend(ctx.session, revokeTx, { withDetails: true }), readConfirmedSpend(ctx.session, contestTx, { withDetails: true }),
  ]);
  const issued = tokenOutput(revoke.inputs, script, view.id);
  const revoked = tokenOutput(revoke.outputs, script, view.id);
  const contested = tokenOutput(contest.inputs, script, view.id);
  const current = tokenOutput(contest.outputs, script, view.id);
  const chainBytes = view.utxo.datum;
  if (issued === null || revoked === null || contested === null || current === null || !chainBytes || contested.ref !== revoked.ref
      || parseOutRef(issued.ref).txHash !== fact.tx || current.ref !== formatOutRef(view.utxo.txHash, view.utxo.outputIndex)
      || current.lovelace !== view.utxo.assets.lovelace || revoked.lovelace < issued.lovelace || contested.lovelace !== revoked.lovelace
      || current.lovelace < contested.lovelace) return false;
  const [before, presented, result] = await Promise.all([
    archivedDatum(ctx, issued), archivedDatum(ctx, contested), archivedDatum(ctx, current, chainBytes),
  ]);
  if (before === null || presented === null || result !== encodePlutusDataHex(decodePlutusDataHex(chainBytes))) return false;
  const afterBytes = await archivedDatum(ctx, revoked, presented);
  if (afterBytes !== presented) return false;
  const initial = decodeAttestationDatum(before);
  const after = decodeAttestationDatum(presented);
  const latest = view.attestation;
  return initial.status.type === 'AttActive' && initial.contested === null && after.status.type === 'AttRevoked' && after.contested === null
    && latest.status.type === 'AttRevoked' && encodeAttestationDatum({ ...initial, status: after.status }) === encodeAttestationDatum(after)
    && encodeAttestationDatum({ ...after, contested: latest.contested }) === encodeAttestationDatum(latest);
}

async function compliance(ctx: Context, spec: NonNullable<TaskSession['use']['compliance']>): Promise<Check> {
  const name = 'compliance';
  const issuer = ctx.publicKeys().get(spec.issuerKey)?.publicKey;
  if (issuer == null) return failed(name, `the public key file lists no key for the compliance issuer ${spec.issuerKey}`);
  const problems: string[] = [];
  const lines: string[] = [];
  for (const subject of spec.subjects) {
    const fact = ctx.facts.compliance[subject];
    const agent = ctx.session.use.agents.find(({ id }) => id === subject);
    const record = ctx.facts.records[subject];
    if (fact === undefined || agent === undefined || record === undefined) {
      problems.push(`the compliance fact or subject record of ${subject} is missing`);
      continue;
    }
    const view = await readAttestation(ctx.session.chain, fact.id);
    if (!attestationMatches(view, fact, record.id, issuer, ATT_TYPES.identity, spec.format, false)) {
      problems.push(`the compliance attestation of ${subject} does not match the facts on the node`);
      continue;
    }
    const state = attestationState(view.attestation, ctx.now);
    const expected = agent.end.record === 'revoked' ? 'revoked' : 'active';
    if (state !== expected) {
      problems.push(`the compliance attestation of ${subject} is ${state}: it must be ${expected}`);
      continue;
    }
    if (expected === 'revoked') {
      if (fact.revokeTx === null || fact.contestTx === null || !ID.test(fact.revokeTx) || !ID.test(fact.contestTx)
          || fact.replySha256 === null || fact.replyUri === null) {
        problems.push(`the facts hold no complete revoke and contest of the compliance attestation of ${subject}`);
        continue;
      }
      const reply = view.attestation.contested;
      if (view.utxo.txHash !== fact.contestTx || reply === null || reply.sha256 !== fact.replySha256 || reply.uri !== Buffer.from(fact.replyUri, 'utf8').toString('hex')) {
        problems.push(`the reply to the compliance attestation of ${subject} does not match the facts on the node`);
        continue;
      }
      if (!(await complianceLineage(ctx, fact, view, fact.revokeTx, fact.contestTx))) {
        problems.push(`the recorded revoke and contest do not spend the expected attestation of ${subject}`);
        continue;
      }
      lines.push(`${subject} ${fact.id} is revoked with reply ${fact.replySha256}, ${depositDate(view)}`);
    } else {
      if (fact.revokeTx !== null || fact.contestTx !== null || fact.replySha256 !== null || fact.replyUri !== null || view.attestation.contested !== null) {
        problems.push(`the compliance attestation of ${subject} is active but has a revoke or contest in the facts or on the node`);
        continue;
      }
      lines.push(`${subject} ${fact.id} is active, ${depositDate(view)}`);
    }
  }
  return problems.length > 0 ? failed(name, [...problems, ...lines].join('; ')) : passed(name, lines.join('; '));
}

// ---- 9. the runtimes ----

async function runtimes(ctx: Context): Promise<Check> {
  const name = 'runtimes';
  let running: ReadonlySet<string>;
  try { running = readRunning(join(ctx.session.settings.stateDir, RUNNING_IMAGES), ctx.now); } catch (err) { return failed(name, `cannot tell: ${shown(err)}`); }
  const refs = ctx.session.use.agents.filter(({ end }) => end.advert === 'listed').flatMap(runtimesOf);
  const answers = await Promise.all(refs.map(async (ref) => (running.has(ref.container) ? readRuntimeStatus(ctx.session.fetchImpl, ref.statusUrl) : null)));
  const stopped = ctx.session.use.agents.filter(({ end }) => end.advert === 'retired').flatMap(runtimesOf);
  const problems: string[] = stopped.filter(({ container }) => running.has(container)).map(({ container }) => `the retired runtime ${container} is still running`);
  const working: string[] = [];
  const good: string[] = [];
  refs.forEach((ref, index) => {
    const answer = answers[index];
    if (answer === null || answer === undefined) problems.push(`the runtime ${ref.container} is not running: at the end state the ${refs.length} runtimes run`);
    else if (answer.kind === 'free') good.push(ref.container);
    else if (answer.kind === 'working') working.push(`the runtime ${ref.container} says working: a job runs, so wait until it ends`);
    else problems.push(`cannot tell whether the runtime ${ref.container} works: ${answer.why}`);
  });
  if (problems.length > 0) return failed(name, [...problems, ...working].join('; '));
  if (working.length > 0) return waiting(name, working.join('; '));
  return passed(name, `the ${refs.length} runtimes run and say free (${good.join(', ')})`
    + (stopped.length === 0 ? '' : `; the retired runtimes are stopped (${stopped.map(({ container }) => container).join(', ')})`));
}

async function subagents(ctx: Context, agent: AgentSpec, children: readonly SubagentSpec[]): Promise<Check> {
  const name = `subagents:${agent.id}`;
  const ended = agent.end.subagents === 'ended';
  const parent = await ctx.record(agent.id);
  if (parent.kind === 'problem') return failed(name, parent.line);
  const parentEpoch = parent.read.output.record.subagentEpoch;
  let expectedEpoch = parentEpoch;
  const holdEnd = ended ? null : juryHoldEnd(parent.read);
  if (ended) {
    const fact = ctx.facts.subagentEnds[agent.id];
    if (fact === undefined) return failed(name, `the facts hold no end of the subagents of ${agent.id}`);
    if (!ID.test(fact.tx) || timeOf(fact.at) === null || !Number.isSafeInteger(fact.epochBefore) || fact.epochBefore < 0
        || !Number.isSafeInteger(fact.epochAfter) || fact.epochAfter !== fact.epochBefore + 1 || parentEpoch < fact.epochAfter) {
      return failed(name, `the epoch of ${agent.id} on the node does not support the end of its subagents in the facts`);
    }
    const bump = await readConfirmedSpend(ctx.session, fact.tx, { withDetails: true });
    const { id, utxo } = parent.read.output;
    const identity = ctx.session.chain.deployment.identity;
    const before = tokenOutput(bump.inputs, identity, id);
    const after = tokenOutput(bump.outputs, identity, id);
    const redeemer = before === null ? undefined : bump.spends?.find(({ scriptHash, inputRef }) => scriptHash === identity.hash && inputRef === before.ref);
    if (before === null || after === null || redeemer === undefined || !witnessMatches(redeemer, encodeIdentitySpend({ type: 'BumpEpoch' }))) {
      return failed(name, `the recorded transaction of ${agent.id} did not spend that parent record with BumpEpoch`);
    }
    const equivalent = after.ref === formatOutRef(utxo.txHash, utxo.outputIndex) ? utxo.datum ?? undefined : undefined;
    const [input, output] = await Promise.all([archivedDatum(ctx, before), archivedDatum(ctx, after, equivalent)]);
    if (input === null || output === null) return failed(name, `the BumpEpoch transaction of ${agent.id} has no usable parent datums`);
    const prior = decodeIdentityDatum(input);
    const next = decodeIdentityDatum(output);
    if (prior.subagentEpoch !== fact.epochBefore || next.subagentEpoch !== fact.epochAfter
        || (equivalent !== undefined && output !== encodePlutusDataHex(decodePlutusDataHex(equivalent)))
        || encodeIdentityDatum({ ...prior, subagentEpoch: fact.epochAfter }) !== encodeIdentityDatum(next)) {
      return failed(name, `the recorded BumpEpoch did not make exactly the epoch change of ${agent.id}`);
    }
    expectedEpoch = fact.epochBefore;
  }
  const problems: string[] = [];
  const inherited: string[] = [];
  for (const child of children) {
    const resolved = await ctx.resolution(child.id);
    if (resolved.kind !== 'read') {
      problems.push(`${child.id}: ${resolved.line}`);
      continue;
    }
    const status = resolved.metadata.vectorStatus;
    const lineage = resolved.metadata.vectorParent;
    if (!isObject(lineage) || lineage.parent !== parent.read.did || lineage.depth !== 1 || lineage.parentEpoch !== expectedEpoch) {
      problems.push(`the gateway does not show ${child.id} as a direct child of the expected parent at epoch ${expectedEpoch}`);
      continue;
    }
    const deactivated = resolved.metadata.deactivated === true;
    const noOwnHold = isObject(status) && (status.status === 'active'
        || (status.status === 'suspended' && Array.isArray(status.holds) && status.holds.length !== 0 && status.holds.every((hold: unknown) => {
          const until = isObject(hold) && typeof hold.until === 'string' ? timeOf(hold.until) : null;
          return until !== null && until <= ctx.now;
        })));
    if (!ended && holdEnd !== null && noOwnHold && isObject(status) && status.effective === 'suspended'
        && status.effectiveReason === 'parentSuspended' && !deactivated) {
      inherited.push(child.id);
    } else if (!isObject(status) || (ended
      ? status.effective !== 'revoked' || status.effectiveReason !== 'parentRevoked' || !deactivated
      : status.effective !== 'active' || deactivated)) {
      problems.push(`the gateway does not show ${child.id} as ${ended ? 'revoked by the end of its parent authority' : 'Active'}`);
    }
  }
  if (problems.length > 0) return failed(name, problems.join('; '));
  if (inherited.length !== 0 && holdEnd !== null) return waiting(name, `the subagents ${inherited.join(', ')} inherit the jury hold until ${iso(holdEnd)}`, holdEnd);
  return passed(name, `the gateway shows each subagent as ${ended ? 'revoked' : 'Active'} (${children.map(({ id }) => id).join(', ')})`);
}

async function lifecycle(ctx: Context, spec: LifecycleSpec): Promise<Check> {
  const name = 'lifecycle';
  const facts = ctx.facts.lifecycle;
  const missing = LIFECYCLE_STEPS.filter((step) => facts[step] === undefined || !ID.test(facts[step].tx) || timeOf(facts[step].at) === null);
  if (missing.length !== 0) return failed(name, `the facts hold no usable lifecycle step(s): ${missing.join(', ')}`);
  if (facts['recovery-wait']!.tx !== facts['recovery-start']!.tx) return failed(name, 'the lifecycle wait does not name the recovery start');
  const record = await ctx.record(spec.agent);
  if (record.kind === 'problem') return failed(name, record.line);
  const status = record.read.output.record.status;
  const successor = ctx.facts.records[spec.successor];
  if (status.type !== 'Retired' || successor === undefined || status.successor !== successor.id) {
    return failed(name, `the lifecycle record ${record.read.did} is not Retired with the expected successor`);
  }
  const { output } = record.read;
  const keys = ctx.publicKeys();
  const controller = keys.get(spec.controllers[1])?.publicKey;
  if (controller == null || output.record.controller !== controller) return failed(name, 'the lifecycle tombstone does not retain the recovered controller');
  const excess = await ctx.reclaimable(record.read);
  if (excess > 0n) return failed(name, `the deposit above the ledger minimum was not reclaimed: ${units(excess)} remain`);
  const reclaimTx = facts.reclaim!.tx;
  if (output.utxo.txHash !== reclaimTx) return failed(name, 'the tombstone output does not match the reclaim transaction in the facts');
  const feeWallet = keys.get('fee')?.address;
  if (feeWallet == null) return failed(name, 'the public key file lists no fee wallet');
  const reclaim = await readConfirmedSpend(ctx.session, reclaimTx, { withDetails: true });
  const identity = ctx.session.chain.deployment.identity;
  const before = tokenOutput(reclaim.inputs, identity, output.id);
  const after = tokenOutput(reclaim.outputs, identity, output.id);
  const bytes = output.utxo.datum;
  if (before === null || after === null || !bytes || parseOutRef(before.ref).txHash !== facts['set-successor']!.tx
      || after.ref !== formatOutRef(reclaimTx, output.utxo.outputIndex) || after.lovelace !== output.utxo.assets.lovelace) {
    return failed(name, 'the reclaim transaction does not spend the recorded predecessor and leave the tombstone that the node holds');
  }
  const action = reclaim.spends?.find(({ scriptHash, inputRef }) => scriptHash === identity.hash && inputRef === before.ref);
  if (action === undefined || !witnessMatches(action, encodeIdentitySpend({ type: 'Reclaim' }))) {
    return failed(name, 'the recorded reclaim transaction did not spend the predecessor with Reclaim');
  }
  const canonical = encodePlutusDataHex(decodePlutusDataHex(bytes));
  const [beforeDatum, afterDatum] = await Promise.all([archivedDatum(ctx, before, bytes), archivedDatum(ctx, after, bytes)]);
  if (beforeDatum !== canonical || afterDatum !== canonical) return failed(name, 'the reclaim transaction does not preserve the tombstone datum that the node holds');
  const incoming = reclaim.inputs.filter(({ ref }) => ref !== before.ref);
  const outgoing = reclaim.outputs.filter(({ ref }) => ref !== after.ref);
  if (outgoing.length === 0 || [...incoming, ...outgoing].some(({ address }) => address !== feeWallet)) {
    return failed(name, 'the reclaim transaction has an input or payment outside the fee wallet and identity output');
  }
  const received = walletCredit(feeWallet, reclaim);
  const release = before.lovelace - after.lovelace;
  if (received <= 0n || received !== release - reclaim.fee) return failed(name, 'the fee wallet did not receive the reclaimed deposit less the transaction fee');
  return passed(name, `all lifecycle steps are recorded; ${record.read.did} is Retired and names ${successor.did}; the deposit above the ledger minimum was reclaimed, and the fee wallet received ${units(received)}`);
}

// ---- the read and the report ----

/** Reads the end state: the checks in their order. A failed network guard stops the reads: the answers of a node of another network cannot be trusted. */
async function readEndState(session: TaskSession<EndStateExtra>): Promise<Check[]> {
  const gate = session.networkResult();
  if (gate === null || !gate.ok) return [failed('network', gate === null ? 'the network guard did not run, so the reads of the node cannot be trusted' : `the network guard failed (${shown(gate.message)}), so the reads of the node cannot be trusted`)];
  const ctx = makeContext(session);
  const checks: Check[] = [];
  const { agents, records, compliance: complianceSpec, lifecycle: lifecycleSpec } = session.use;
  for (const agent of agents) checks.push(await attempt(recordCheckOf(agent), () => agentRecord(ctx, agent)));
  for (const record of records) {
    const name = `record:${record.id}`;
    checks.push(await attempt(name, () => recordActive(ctx, name, record.id)));
  }
  for (const record of [...agents.filter(({ end }) => end.record === 'active'), ...records]) {
    const id = record.organisation;
    if (id !== null) checks.push(await attempt(`organisation:${record.id}`, () => organisation(ctx, record.id, id)));
  }
  checks.push(await attempt('adverts', () => adverts(ctx)));
  for (const agent of agents) checks.push(await attempt(`claims:${agent.id}`, () => claims(ctx, agent)));
  checks.push(await attempt('delegations', () => delegations(ctx)));
  checks.push(await attempt('holds', () => holds(ctx)));
  checks.push(await attempt('wallets', () => wallets(ctx)));
  checks.push(await attempt('attestations', () => attestations(ctx)));
  checks.push(await attempt('runtimes', () => runtimes(ctx)));
  for (const agent of agents) {
    const children = session.use.subagents.filter(({ parent }) => parent === agent.id);
    if (children.length !== 0) checks.push(await attempt(`subagents:${agent.id}`, () => subagents(ctx, agent, children)));
  }
  if (complianceSpec !== null) checks.push(await attempt('compliance', () => compliance(ctx, complianceSpec)));
  if (lifecycleSpec !== null) checks.push(await attempt('lifecycle', () => lifecycle(ctx, lifecycleSpec)));
  return checks;
}

/** `done` when every check is ok, `fail` when one fails, else `wait`. */
function verdictOf(checks: readonly Check[]): 'done' | 'wait' | 'fail' {
  if (checks.some((check) => check.result === 'fail')) return 'fail';
  return checks.some((check) => check.result === 'wait') ? 'wait' : 'done';
}

const namesOf = (checks: readonly Check[], result: Result): string => checks.filter((check) => check.result === result).map((check) => check.name).join(', ');

/** The lines of the report: one for each check, and the line of the whole. */
function reportLines(checks: readonly Check[]): string[] {
  const verdict = verdictOf(checks);
  const failing = checks.filter((check) => check.result === 'fail').length;
  const waits = checks.filter((check) => check.result === 'wait').length;
  const last = verdict === 'done'
    ? 'end state: DONE: every check is ok'
    : `end state: NOT DONE: ${failing} check(s) fail (${namesOf(checks, 'fail') || 'none'}) and ${waits} check(s) wait (${namesOf(checks, 'wait') || 'none'})`;
  return [...checks.map((check) => `${check.result.toUpperCase().padEnd(4)} ${check.name}: ${check.line}`), last];
}

/** The message that ends a run or a status that did not reach the end state. */
function notReached(checks: readonly Check[], verdict: 'wait' | 'fail'): string {
  const count = checks.filter((check) => check.result === verdict).length;
  return verdict === 'fail'
    ? `the end state is not reached: ${count} check(s) fail (${namesOf(checks, 'fail')}). The lines above say what is still to do`
    : `the end state is not reached yet: ${count} check(s) wait (${namesOf(checks, 'wait')}). The lines above say what is still to do`;
}

async function run(session: TaskSession<EndStateExtra>): Promise<StepOutcome> {
  const checks = await readEndState(session);
  session.extra.checks = checks;
  for (const line of reportLines(checks)) session.out.out(line);
  const verdict = verdictOf(checks);
  if (verdict === 'fail') throw new EndStateError(notReached(checks, verdict));
  if (verdict === 'wait') {
    const ends = checks.filter((check) => check.result === 'wait').map((check) => check.untilMs);
    return { kind: 'wait', message: notReached(checks, verdict), untilMs: ends.every((end): end is number => end !== null) ? Math.max(...ends) : null };
  }
  return { kind: 'finished', message: 'the end state is reached: every check is ok' };
}

const endState: TaskDefinition<EndStateExtra> = {
  name: 'end-state',
  title: 'Checks, with reads only, the end state that the build of the use case wants after the last run.',
  flags: [],
  valued: [],
  needs: { keys: () => [], chain: true, hosted: ['vector_resolve_did', 'vector_marketplace_list_suppliers'], approval: 'never' },
  steps: () => [],
  parse: () => ({ checks: null }),
  next: run,
  cleanup: async () => ({ kind: 'done', message: 'the task end-state reads the end state and takes nothing back' }),
  async status(session) {
    const checks = await readEndState(session);
    session.extra.checks = checks;
    const lines = reportLines(checks);
    const verdict = verdictOf(checks);
    if (verdict === 'done') return lines;
    // The runner ends `status` with exit 0 and the outcome done whatever a task shows. A state that is not done must not look done: the lines go out first, and the error ends the command with exit 1.
    for (const line of lines) session.out.out(line);
    throw new EndStateError(notReached(checks, verdict));
  },
  result: (session) => (session.extra.checks === null ? {} : { verdict: verdictOf(session.extra.checks), checks: session.extra.checks.map(({ name, result, line }) => ({ name, result, line })) }),
};

export default endState;
