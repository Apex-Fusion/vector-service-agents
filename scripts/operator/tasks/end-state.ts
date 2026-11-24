// scripts/operator/tasks/end-state.ts - the task `end-state`: a read-only check of the end state that the build of the use case wants after the last run.
//
//   run      reads the end state, prints each check, and ends with the exit code of the whole: 0 when every check is ok, 4 when no check fails and some wait, 1 when a check fails
//   status   reads the same and prints the same lines. The runner ends `status` with exit 0 whatever the lines say, so the exit code of the check comes from `run`
//
// The agents that work stay listed and funded. No claim is open, no delegation of a hirer is live, no hold of this pack is on, each record is Active, each organisation is verified, and the
// deposits that return have their dates. Each check has a name, a result (`ok`, `wait` or `fail`) and a line that says in words what is still to do. A source that cannot be read is a `fail` with
// its own line: it is never a pass. The check never says done while a claim is open, a delegation is live, a hold is on, a record is not Active or an organisation is not verified. The task signs
// nothing: the claims are read through the read methods of a chain port whose signature throws.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { collateralAdvice, isCollateralOutput } from '../../checks/lib/collateral.ts';
import { duration, iso, units } from '../../checks/lib/format.ts';
import type { Facts, StepOutcome, TaskDefinition, TaskSession } from '../lib/contract.ts';
import type { AgentSpec } from '../lib/contract.ts';
import { readRunning, runtimesOf } from '../lib/free.ts';
import { Dispute, createModule1Port, effectiveStatus, findRecord, liveDelegations, module1FromManifest, readManifest, withdrawableFrom } from '../lib/platform.ts';
import type { RecordUtxo } from '../lib/platform.ts';
import { codeOf } from '../lib/registry.ts';
import { holdsSecret } from '../lib/secrets.ts';
// `lib/platform.ts` does not give these names, and this task is their only caller in the pack: the queue of a wallet, the provider type of the chain port, and the Module-1 deployment type.
import type { Module1Deployment } from '../../../packages/buyer-core/src/index.ts';
import { createSerialQueue } from '../../../packages/usecase-kit/src/access/index.ts';
import type { Module1Provider } from '../../../packages/usecase-kit/src/dispute/index.ts';

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
const KEYS_PUBLIC = 'keys-public.json';
const RUNNING_IMAGES = 'running-images.json';
/** A deposit of an attestation returns this long after the end of its validity. */
const DEPOSIT_DELAY_MS = 90 * 86_400_000;
/** The reason code of a hold that Module-1 puts on an agent after a verdict. */
const JURY_HOLD_REASON = 64;
const STATUS_LIMIT_MS = 10_000;
const STATUS_BODY_BYTES = 65_536;
const MIN_WINDOW_LEFT_MS = 600_000;
const READ_TIMEOUT_MS = 20_000;
const MOST_ADVERTS = 50;

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

interface RecordRead { readonly did: string; readonly status: 'Active' | 'Suspended' | 'Revoked' | 'Retired'; readonly holds: readonly Hold[] }
type RecordResult = { readonly kind: 'read'; readonly read: RecordRead } | { readonly kind: 'problem'; readonly line: string };
type Resolution = { readonly kind: 'read'; readonly metadata: Record<string, unknown> } | { readonly kind: 'problem'; readonly line: string };

/** What the checks share in one read: the facts, the time, and the reads that more than one check needs, each made once. */
interface Context {
  readonly session: TaskSession<EndStateExtra>;
  readonly now: number;
  readonly facts: Readonly<Facts>;
  record(agent: AgentSpec): Promise<RecordResult>;
  resolution(agent: AgentSpec): Promise<Resolution>;
  module1(): Promise<Module1Deployment>;
  addresses(): ReadonlyMap<string, string>;
}

/** The record of an agent as the node shows it now: its status, and the holds that are in force. */
async function readRecord(session: TaskSession<EndStateExtra>, facts: Readonly<Facts>, now: number, agent: AgentSpec): Promise<RecordResult> {
  const fact = facts.records[agent.id];
  if (fact === undefined) return { kind: 'problem', line: `the facts hold no record of the agent ${agent.id}: run the task register first` };
  const found = await findRecord(session.chain.provider, session.chain.deployment, fact.id);
  if (found === null) return { kind: 'problem', line: `the record ${fact.did} is not in the identity registry` };
  const status = effectiveStatus(found.record, new Map(), now, now);
  const holds = found.record.status.type === 'Suspended' ? found.record.status.holds.filter((hold) => hold.until > now) : [];
  return { kind: 'read', read: { did: fact.did, status, holds } };
}

/** The DID resolution of an agent at the gateway, through the hosted tool. The metadata decides: the text of the answer is never read for success. */
async function readResolution(session: TaskSession<EndStateExtra>, facts: Readonly<Facts>, agent: AgentSpec): Promise<Resolution> {
  const fact = facts.records[agent.id];
  if (fact === undefined) return { kind: 'problem', line: `the facts hold no record of the agent ${agent.id}: run the task register first` };
  const answer = await session.hosted.call('vector_resolve_did', { did: fact.did });
  if (answer.failed) return { kind: 'problem', line: `the hosted tool vector_resolve_did failed: ${shown(answer.message)}` };
  const metadata = answer.json?.didDocumentMetadata;
  if (!isObject(metadata)) return { kind: 'problem', line: 'the answer of vector_resolve_did holds no DID document metadata' };
  return { kind: 'read', metadata };
}

/** The addresses of the wallets, from the public key file that the task keys wrote. The file holds no secret. */
function readAddresses(session: TaskSession<EndStateExtra>): ReadonlyMap<string, string> {
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(join(session.settings.keysDir, KEYS_PUBLIC), 'utf8')); } catch (err) {
    throw new Error(`the public key file ${KEYS_PUBLIC} cannot be read (${err instanceof SyntaxError ? 'it is not JSON' : codeOf(err)}): the task keys writes it`);
  }
  if (!isObject(parsed) || !isObject(parsed.keys)) throw new Error(`the public key file ${KEYS_PUBLIC} has no keys`);
  if (parsed.use_case !== session.use.name || parsed.network !== session.settings.network.name) throw new Error(`the public key file ${KEYS_PUBLIC} is for another use case or another network`);
  const addresses = new Map<string, string>();
  for (const [name, entry] of Object.entries(parsed.keys)) if (isObject(entry) && typeof entry.address === 'string' && entry.address.startsWith('addr')) addresses.set(name, entry.address);
  return addresses;
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

function makeContext(session: TaskSession<EndStateExtra>): Context {
  const now = session.clock.now();
  const facts = session.facts.read();
  const records = new Map<string, Promise<RecordResult>>();
  const resolutions = new Map<string, Promise<Resolution>>();
  let module1: Promise<Module1Deployment> | null = null;
  let addresses: ReadonlyMap<string, string> | null = null;
  return {
    session, now, facts,
    record: (agent) => records.get(agent.id) ?? records.set(agent.id, readRecord(session, facts, now, agent)).get(agent.id)!,
    resolution: (agent) => resolutions.get(agent.id) ?? resolutions.set(agent.id, readResolution(session, facts, agent)).get(agent.id)!,
    module1: () => (module1 ??= readModule1(session)),
    addresses: () => (addresses ??= readAddresses(session)),
  };
}

// ---- 1. the record is Active ----

/** The end of the hold of the jury, when the record is held by the jury and by nobody else. */
function juryHoldEnd(read: RecordRead): number | null {
  return read.status === 'Suspended' && read.holds.length > 0 && read.holds.every(isJuryHold) ? Math.max(...read.holds.map((hold) => hold.until)) : null;
}

async function recordActive(ctx: Context, agent: AgentSpec): Promise<Check> {
  const name = `record_active:${agent.id}`;
  const result = await ctx.record(agent);
  if (result.kind === 'problem') return failed(name, result.line);
  const { did, status } = result.read;
  if (status === 'Active') return passed(name, `the record ${did} is Active`);
  const until = juryHoldEnd(result.read);
  if (until !== null) return waiting(name, `the record ${did} is on hold from the jury (reason ${JURY_HOLD_REASON}) until ${iso(until)}, in ${duration(until - ctx.now)}: wait for the end of the hold`, until);
  return failed(name, status === 'Suspended'
    ? `the record ${did} is Suspended, and the hold is not a hold of the jury (or the record has no Accountable party in force): it must be Active`
    : `the record ${did} is ${status}: it must be Active`);
}

// ---- 2. the organisation is verified ----

async function organisation(ctx: Context, agent: AgentSpec): Promise<Check> {
  const name = `organisation:${agent.id}`;
  const domain = ctx.session.use.organisations.find((candidate) => candidate.id === agent.organisation)?.domain;
  if (domain === undefined) return failed(name, `the data names no organisation ${agent.organisation} for the agent ${agent.id}`);
  const resolved = await ctx.resolution(agent);
  if (resolved.kind === 'problem') return failed(name, resolved.line);
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

/** The references of the adverts that the indexer lists for a capability, listed or not free. */
async function listedRefs(session: TaskSession<EndStateExtra>, capability: string): Promise<string[]> {
  const answer = await session.hosted.call('vector_marketplace_list_suppliers', { capability_id: capability, only_free: false, limit: MOST_ADVERTS });
  if (answer.failed) throw new Error(`the hosted tool vector_marketplace_list_suppliers failed: ${shown(answer.message)}`);
  const rows = lastJsonValue(answer.text);
  if (!Array.isArray(rows)) throw new Error('the answer of vector_marketplace_list_suppliers holds no list of adverts');
  return rows.flatMap((row: unknown) => {
    if (!isObject(row) || typeof row.advert_ref !== 'string' || typeof row.capability_id !== 'string') throw new Error('a row of the answer of vector_marketplace_list_suppliers is no advert');
    return row.capability_id === capability ? [row.advert_ref] : [];
  });
}

async function adverts(ctx: Context): Promise<Check> {
  const name = 'adverts';
  const problems: string[] = [];
  const waits: string[] = [];
  const counts: string[] = [];
  let until = 0;
  for (const agent of ctx.session.use.agents) {
    const expected = new Map<string, string>();
    for (const advert of agent.adverts) {
      const fact = ctx.facts.adverts[agent.id]?.[advert.model];
      if (fact === undefined) problems.push(`the facts hold no reference for the advert ${agent.id}/${advert.model}: run the task advert first`);
      else expected.set(fact.ref, advert.model);
    }
    const listed = await listedRefs(ctx.session, agent.capability);
    const record = await ctx.record(agent);
    const held = record.kind === 'read' ? juryHoldEnd(record.read) : null;
    let complete = true;
    for (const [ref, model] of expected) {
      if (listed.includes(ref)) continue;
      complete = false;
      if (held !== null) {
        waits.push(`the advert ${agent.id}/${model} is not listed while the record is on hold until ${iso(held)}`);
        until = Math.max(until, held);
      } else {
        problems.push(`the indexer does not list the advert ${agent.id}/${model} (${ref})`);
      }
    }
    for (const ref of listed) {
      if (expected.has(ref)) continue;
      complete = false;
      problems.push(`the indexer lists an advert of the capability ${agent.capability} that the facts do not hold (${ref})`);
    }
    if (complete && expected.size === agent.adverts.length) counts.push(`${agent.id} ${expected.size}`);
  }
  if (problems.length > 0) return failed(name, `${[...problems, ...waits].join('; ')}: the indexer must list exactly the adverts of the data`);
  if (waits.length > 0) return waiting(name, `${waits.join('; ')}: the adverts return when the hold ends`, until);
  return passed(name, `the indexer lists exactly the adverts of the data (${counts.join(', ')}), each with its reference in the facts`);
}

// ---- 4. the claims ----

/** A wait that never holds the process open: the kit bounds each read with it, and the timer is not cancelled when the read ends first. (`Promise.withResolvers` is not in the types of the target of the pack.) */
const boundedSleep = (ms: number): Promise<void> => new Promise<void>((resolve) => { setTimeout(resolve, ms).unref(); });

function refuseSigning(): never {
  throw new Error('the end-state check signs nothing');
}

/** The dispute code of the kit over the chain port of the service wallet of an agent. The port has a signature that throws: the task reads claims only. */
function disputeOf(ctx: Context, agent: AgentSpec, id: string, module1: Module1Deployment): Dispute {
  const address = ctx.addresses().get(agent.serviceKey);
  if (address === undefined) throw new Error(`the public key file lists no wallet for the key ${agent.serviceKey}`);
  // The real provider is an OgmiosProvider and gives the start time of the chain. A provider that does not is no node of Vector.
  const candidate = ctx.session.chain.provider as Partial<Module1Provider>;
  if (typeof candidate.getSystemStartMs !== 'function') throw new Error('the provider of the chain gives no start time of the chain, and the chain port needs it');
  const provider = ctx.session.chain.provider as Module1Provider;
  const clock = (): number => ctx.session.clock.now();
  const port = createModule1Port({
    provider, module1, address, agent_id: id, sign: refuseSigning, clock, sleep: boundedSleep, koios_url: ctx.session.chain.koiosUrl, fetch: ctx.session.chain.fetchImpl,
    identity_deployment: null, valid_minutes: 30,
  });
  return new Dispute({
    port, queue: createSerialQueue(), clock, sleep: boundedSleep,
    settings: { challenge_stake_lovelace: agent.claim.stakeLovelace, min_window_left_ms: MIN_WINDOW_LEFT_MS, read_timeout_ms: READ_TIMEOUT_MS },
  });
}

async function claims(ctx: Context, agent: AgentSpec): Promise<Check> {
  const name = `claims:${agent.id}`;
  const fact = ctx.facts.records[agent.id];
  if (fact === undefined) return failed(name, `the facts hold no record of the agent ${agent.id}: run the task register first`);
  const listed = await disputeOf(ctx, agent, fact.id, await ctx.module1()).listOpenClaims(fact.did);
  if (!listed.ok) return failed(name, `the open claims cannot be read (${listed.code}): ${shown(listed.detail)}`);
  const known = Object.entries(ctx.facts.claims).flatMap(([run, byAgent]) => {
    const claim = byAgent[agent.id];
    return claim === undefined ? [] : [{ run, claim }];
  });
  const problems: string[] = [];
  const waits: string[] = [];
  const dates: number[] = [];
  for (const view of listed.value) {
    const run = known.find((entry) => entry.claim.claimToken === view.token)?.run;
    const from = withdrawableFrom(view);
    const where = `the claim ${view.ref}${run === undefined ? ' (the facts do not hold it)' : ` of the run ${run}`}`;
    if (from > ctx.now) {
      waits.push(`${where} is open, and its window ends in ${duration(from - ctx.now)} (at ${iso(from)}): withdraw it after that with the task claim, cleanup${run === undefined ? '' : ` --run ${run}`}`);
      dates.push(from);
    } else {
      problems.push(`${where} is open and its window has ended: withdraw it with the task claim, cleanup${run === undefined ? '' : ` --run ${run}`} --submit`);
    }
  }
  const open = new Set(listed.value.map((view) => view.token));
  for (const { run, claim } of known) {
    if (open.has(claim.claimToken) || claim.withdrawTx !== null) continue;
    waits.push(`the claim of the run ${run} is not open, and the facts do not say so: run the task claim, cleanup --run ${run} --submit to record it`);
  }
  if (problems.length > 0) return failed(name, [...problems, ...waits].join('; '));
  if (waits.length > 0) return waiting(name, waits.join('; '), dates.length === waits.length ? Math.max(...dates) : null);
  return passed(name, `the agent ${agent.id} has no open claim${known.length === 0 ? '' : `; the ${known.length} claim(s) of the facts are withdrawn or not open`}`);
}

// ---- 5. the delegations ----

async function delegations(ctx: Context): Promise<Check> {
  const name = 'delegations';
  const delegates = new Map<string, string>();
  for (const agent of [...ctx.session.use.agents, ...ctx.session.use.subagents]) {
    const fact = ctx.facts.records[agent.id];
    if (fact !== undefined) delegates.set(fact.id.toLowerCase(), agent.id);
  }
  if (delegates.size === 0) return failed(name, 'the facts hold no record of an agent, so no delegate is known: run the task register first');
  const live = (await liveDelegations(ctx.session.chain.provider, ctx.session.chain.deployment)).filter((entry) => delegates.has(entry.delegation.delegate.toLowerCase()));
  if (live.length === 0) return passed(name, `no live delegation has one of the agents as its delegate (${[...delegates.values()].join(', ')})`);
  const lines = live.map((entry) => {
    const delegator = entry.delegation.delegator;
    const who = delegator.type === 'PrincipalKey' ? `delegator key hash ${delegator.hash}` : `delegator agent ${delegator.id}`;
    return `the delegation ${entry.id} to ${delegates.get(entry.delegation.delegate.toLowerCase())} is live, ${who}`;
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
    const record = await ctx.record(agent);
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
  const addresses = ctx.addresses();
  const missing: string[] = [];
  const low: string[] = [];
  for (const line of ctx.session.use.funding) {
    const address = addresses.get(line.wallet);
    if (address === undefined) {
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
  if (/^\d{12,}$/.test(text)) return Number(text);
  const parsed = /^\d{4}-\d{2}-\d{2}T/.test(text) ? Date.parse(text) : Number.NaN;
  return Number.isNaN(parsed) ? null : parsed;
}

/** The identifiers of the attestations that the gateway lists in `vectorProvenance`. */
function provenanceIds(metadata: Record<string, unknown>): ReadonlySet<string> {
  const provenance = metadata.vectorProvenance;
  const listed: unknown[] = isObject(provenance) && Array.isArray(provenance.attestations) ? provenance.attestations : [];
  return new Set(listed.flatMap((entry) => (isObject(entry) && typeof entry.id === 'string' ? [entry.id] : [])));
}

async function attestations(ctx: Context): Promise<Check> {
  const name = 'attestations';
  const lines: string[] = [];
  const problems: string[] = [];
  for (const agent of ctx.session.use.agents) {
    const byType = ctx.facts.attestations[agent.id];
    if (byType === undefined) continue;
    const resolved = await ctx.resolution(agent);
    if (resolved.kind === 'problem') {
      problems.push(`${agent.id}: ${resolved.line}`);
      continue;
    }
    const listed = provenanceIds(resolved.metadata);
    for (const [type, fact] of Object.entries(byType)) {
      const until = timeOf(fact.validUntil);
      if (until === null) {
        problems.push(`the facts hold a validUntil of ${agent.id}/${type} that is no time`);
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

// ---- 9. the runtimes ----

type Status = { readonly kind: 'free' } | { readonly kind: 'working' } | { readonly kind: 'unknown'; readonly why: string };

/** The body of an answer as text, or null when it is longer than `max` bytes. The read stops as soon as the body passes `max`. */
async function boundedText(response: Response, max: number): Promise<string | null> {
  if (response.body === null) return '';
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
  return new TextDecoder().decode(Buffer.concat(chunks, total));
}

/** What a runtime says at its status address: `free`, `working`, or that nothing can be told. It never throws. Only the member `status` of the body counts. */
async function askStatus(fetchImpl: typeof fetch, url: string): Promise<Status> {
  try {
    const response = await fetchImpl(url, { method: 'GET', headers: { accept: 'application/json' }, redirect: 'manual', signal: AbortSignal.timeout(STATUS_LIMIT_MS) });
    if (response.status !== 200) {
      void response.body?.cancel().catch(() => undefined);
      return { kind: 'unknown', why: `the answer has the status ${response.status}` };
    }
    const text = await boundedText(response, STATUS_BODY_BYTES);
    if (text === null) return { kind: 'unknown', why: `the answer is longer than ${STATUS_BODY_BYTES} bytes` };
    const body: unknown = JSON.parse(text);
    const status = isObject(body) ? body.status : undefined;
    if (status === 'free') return { kind: 'free' };
    if (status === 'working') return { kind: 'working' };
    return { kind: 'unknown', why: 'the answer has no status that is free or working' };
  } catch {
    return { kind: 'unknown', why: 'the request failed or the answer is not JSON' };
  }
}

async function runtimes(ctx: Context): Promise<Check> {
  const name = 'runtimes';
  let running: ReadonlySet<string>;
  try { running = readRunning(join(ctx.session.settings.stateDir, RUNNING_IMAGES), ctx.now); } catch (err) { return failed(name, `cannot tell: ${shown(err)}`); }
  const refs = ctx.session.use.agents.flatMap(runtimesOf);
  const answers = await Promise.all(refs.map(async (ref) => (running.has(ref.container) ? askStatus(ctx.session.fetchImpl, ref.statusUrl) : null)));
  const problems: string[] = [];
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
  return passed(name, `the ${refs.length} runtimes run and say free (${good.join(', ')})`);
}

// ---- the read and the report ----

/** Reads the end state: the checks in their order. A failed network guard stops the reads: the answers of a node of another network cannot be trusted. */
async function readEndState(session: TaskSession<EndStateExtra>): Promise<Check[]> {
  const gate = session.networkResult();
  if (gate === null || !gate.ok) return [failed('network', gate === null ? 'the network guard did not run, so the reads of the node cannot be trusted' : `the network guard failed (${shown(gate.message)}), so the reads of the node cannot be trusted`)];
  const ctx = makeContext(session);
  const checks: Check[] = [];
  const agents = session.use.agents;
  for (const agent of agents) checks.push(await attempt(`record_active:${agent.id}`, () => recordActive(ctx, agent)));
  for (const agent of agents) checks.push(await attempt(`organisation:${agent.id}`, () => organisation(ctx, agent)));
  checks.push(await attempt('adverts', () => adverts(ctx)));
  for (const agent of agents) checks.push(await attempt(`claims:${agent.id}`, () => claims(ctx, agent)));
  checks.push(await attempt('delegations', () => delegations(ctx)));
  checks.push(await attempt('holds', () => holds(ctx)));
  checks.push(await attempt('wallets', () => wallets(ctx)));
  checks.push(await attempt('attestations', () => attestations(ctx)));
  checks.push(await attempt('runtimes', () => runtimes(ctx)));
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

async function run(session: TaskSession<EndStateExtra>): Promise<StepOutcome> {
  const checks = await readEndState(session);
  session.extra.checks = checks;
  for (const line of reportLines(checks)) session.out.out(line);
  const verdict = verdictOf(checks);
  if (verdict === 'fail') throw new EndStateError(`the end state is not reached: ${checks.filter((check) => check.result === 'fail').length} check(s) fail (${namesOf(checks, 'fail')}). The lines above say what is still to do`);
  if (verdict === 'wait') {
    const waits = checks.filter((check) => check.result === 'wait');
    const ends = waits.map((check) => check.untilMs);
    return {
      kind: 'wait', message: `the end state is not reached yet: ${waits.length} check(s) wait (${namesOf(checks, 'wait')}). The lines above say what is still to do`,
      untilMs: ends.every((end): end is number => end !== null) ? Math.max(...ends) : null,
    };
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
    return reportLines(checks);
  },
  result: (session) => (session.extra.checks === null ? {} : { verdict: verdictOf(session.extra.checks), checks: session.extra.checks.map(({ name, result, line }) => ({ name, result, line })) }),
};

export default endState;
