import { createHash } from 'node:crypto';
import {
  module1FromManifest, readManifest,
  decodeChallengeDatum, decodeClaimDatum, readAttestation, readDocument, documentUri, txHashOfUri,
} from '../../../../packages/buyer-core/src/index.ts';
import type { LedgerEnv } from '../../../../packages/buyer-core/src/index.ts';
import { findConfigRecord } from '../../../../packages/buyer-core/src/vendored/mcp/identity-deployment.ts';
import { hasRight, RIGHT } from '../../../../packages/buyer-core/src/vendored/mcp/identity-rules.ts';
import type { KoiosUtxo } from '../../../../packages/buyer-core/src/vendored/mcp/marketplace-indexer.ts';
import { BID_DESK_CLAIM, QUOTE_SCHEMA, parseQuote, parseRanking, receiptSha256 } from '../../../../packages/usecase-kit/src/bids/index.ts';
import type { Quote, Ranking } from '../../../../packages/usecase-kit/src/bids/index.ts';
import { EVIDENCE_STATEMENTS, evidenceReferences, readClaimDocument } from '../../../../packages/usecase-kit/src/dispute/index.ts';
import { parseProposal, PROPOSAL_SCHEMA, RECEIPT_CHECKS, RESULT_SCHEMA } from '../../../../packages/usecase-kit/src/protocol/index.ts';
import { decodeAttestationDatum, decodeDelegationDatum, decodeIdentityDatum, decodeVaultDatum, utf8Hex } from '../../../../packages/vector-read/src/identity-codec.ts';
import type { DelegationDatum, IdentityDatum } from '../../../../packages/vector-read/src/identity-codec.ts';
import { PreconditionError } from '../../../checks/lib/session.ts';
import { readLimited } from '../build-record.ts';
import { CLAIM_STAKE_LOVELACE, CLAIM_WINDOW_MS, RUN_APPROVAL_VALIDITY_MS } from '../claim-constants.ts';
import type { AgentSpec, UseCase } from '../contract.ts';
import { canonicalSha256, findRecord, formatOutRef, keyHashOf, koiosUtxoInfo, readAdvert } from '../platform.ts';
import { scriptTxInfoOf, txInfoOf } from '../run-record.ts';
import type { RunKind, ScriptTxInfo, TxInfo } from '../run-record.ts';
import data from '../../usecases/bid-evaluation.ts';
import { isObject, lastHire, ref, txOf } from './types.ts';
import type {
  ApprovalRead, Assembly, Challenge, EvidenceModule, EvidenceReadSession, HistoricalHoldCandidate, Obj, PublicResultProjection, PublicRouteEvidence, Ref, ReportedHire, Shown, TerminalSpend,
} from './types.ts';

export const BID_REPORT_SCHEMAS = { propose: PROPOSAL_SCHEMA, execute: RESULT_SCHEMA, quote: QUOTE_SCHEMA } as const;
const HIRE_ROLES = ['propose', 'execute', 'quote'] as const;
const LIST = 'vector_marketplace_list_suppliers';
const RESOLVE = 'vector_resolve_did';
const READ_VENDORS = 'GET /vendors';
const WRITE_RANKING = 'POST /sourcing/rankings';
const JURY_REASON = 64;
const SEVEN_DAYS_MS = 604_800_000;
const QUOTE_FAULT = 'quote_off_price_list';
const RANK_FAULT = 'invert_scores';
const HASH = /^[0-9a-f]{64}$/;
const POLICY = /^[0-9a-f]{56}$/;
const REF = /^[0-9a-f]{64}#(?:0|[1-9][0-9]{0,5})$/;
const CHALLENGE_TOKEN = /^63686c5f[0-9a-f]{56}$/;
const BIDDER_STATUSES = ['active', 'suspended', 'revoked', 'retired', 'not_found', 'unreadable'];
const FACT_STATES = ['valid', 'invalid', 'absent', 'unreadable'];
const PHASES = { clean: ['propose'], failure: ['propose-a', 'propose-b', 'propose-c', 'propose-d'] } as const;

type Proof<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly why: string };
const proved = <T>(value: T): Proof<T> => ({ ok: true, value });
const missing = (why: string): Proof<never> => ({ ok: false, why });
function need(pass: unknown, message: string): asserts pass { if (!pass) throw new BidProofError(message); }
/** A failed read is not an assertion of absence. Do not copy a remote error into evidence. */
async function proof<T>(source: string, read: () => Promise<T>): Promise<Proof<T>> {
  try { return proved(await read()); }
  catch (err) { return missing(err instanceof BidProofError ? err.message : `${source}: read_failed`); }
}

interface Candidate {
  readonly agent: AgentSpec;
  readonly did: string;
  readonly advert: string;
  readonly status: string;
  readonly inCatalog: boolean | null;
  readonly compliance: Obj;
  readonly sha256: string;
}
interface Proposal {
  readonly hire: ReportedHire;
  readonly ranking: Ranking;
  readonly digest: string;
  readonly bidders: readonly Candidate[];
  readonly invites: readonly string[];
  readonly shortlist: string | null;
}
interface CheckedQuote {
  readonly hire: ReportedHire;
  readonly desk: Candidate;
  readonly result: Quote;
  readonly receiptHash: string;
  readonly quoteDecision: string;
  readonly acceptDecision: string;
  readonly accept: TerminalSpend | null;
  readonly vault: string;
  readonly challenge: Challenge | null;
}
interface Authority {
  readonly delegation: Assembly['reads']['delegations'][number];
  readonly vault: Assembly['reads']['vaults'][number];
  readonly vaultRoot: string;
  readonly principal: DelegationDatum['delegator'];
  readonly sourcing: string;
}
interface ComplianceRead {
  readonly attestation: string; readonly issue_tx: string; readonly revoke_tx: string; readonly contest_tx: string;
  readonly reason: number; readonly reply_sha256: string; readonly revoked_at: number; readonly contested_at: number;
}
interface RevocationRead {
  readonly tx: string; readonly record_output: string; readonly spent_output: string; readonly reason: number; readonly author: string;
  readonly invalid_from: number; readonly at: number;
}
interface BidReads {
  readonly proposals: ReadonlyMap<string, Proof<Proposal>>;
  readonly orderedRfqs: boolean;
  readonly authority: Proof<Authority>;
  readonly quotes: ReadonlyMap<string, Proof<readonly CheckedQuote[]>>;
  readonly scores: ReadonlyMap<string, Proof<readonly Ref[]>>;
  readonly challenge: Proof<CheckedQuote>;
  readonly release: Proof<TerminalSpend>;
  readonly hold: Proof<HistoricalHoldCandidate | null>;
  readonly bidderEvidence: Proof<readonly Ref[]>;
  readonly compliance: Proof<ComplianceRead>;
  readonly listing: Proof<true>;
  readonly revocation: Proof<RevocationRead>;
}


class BidProofError extends Error {}
const get = (a: Assembly): BidReads => a.extra.bids as BidReads;
const desks = (use: UseCase): readonly AgentSpec[] => use.agents.filter(({ kind }) => kind === 'bid-desk');
const sourcing = (use: UseCase): AgentSpec | undefined => use.agents.find(({ kind }) => kind === 'sourcing-agent');
const quoteAt = (step: string, n: number): string => `quote${step.slice('propose'.length) || '-'}${n + 1}`;
const envOf = ({ chain }: EvidenceReadSession): LedgerEnv => chain;
const txInfo = (s: EvidenceReadSession, tx: string): Promise<TxInfo> => txInfoOf(s.chain.fetchImpl, s.chain.koiosUrl, tx);
const scripts = (s: EvidenceReadSession, tx: string): Promise<ScriptTxInfo> => scriptTxInfoOf(s.chain.fetchImpl, s.chain.koiosUrl, tx);
const outputRef = (row: KoiosUtxo): string => `${row.tx_hash}#${row.tx_index}`;

function named(a: Assembly, step: string): ReportedHire | undefined {
  return a.loaded.hires.find((hire): hire is ReportedHire => hire.entry.step === step && hire.report !== null);
}
function didOf(a: Assembly, agent: string): string | undefined {
  const f = a.facts.records[agent];
  return f && HASH.test(f.id) && f.did === `did:vector:${f.id}` ? f.did : undefined;
}
function hireRefs(h: ReportedHire): Ref[] {
  return [ref('transaction', h.entry.post_tx), ref('escrow', h.entry.escrow_ref),
    ...(h.entry.accept_tx === null ? [] : [ref('transaction', h.entry.accept_tx)])];
}
function single<T>(list: readonly T[], predicate: (item: T) => boolean): T | undefined {
  const matches = list.filter(predicate);
  return matches.length === 1 ? matches[0] : undefined;
}
function same(a: unknown, b: unknown): boolean {
  const x = canonicalSha256(a); const y = canonicalSha256(b);
  return x.ok && y.ok && x.value === y.value;
}
function verified(row: unknown): boolean {
  return isObject(row) && RECEIPT_CHECKS.every((name) => row[name] === true);
}
function modelRef(decision: Obj | undefined): string | null {
  const inference = decision?.inference;
  const job = isObject(inference) ? inference.sub_job : null;
  return isObject(inference) && inference.path === 'marketplace' && (inference.accepted === 'confirmed' || inference.accepted === 'pending')
    && isObject(job) && verified(job.verification) && typeof job.escrow_ref === 'string' && REF.test(job.escrow_ref) ? job.escrow_ref : null;
}
function at(a: Assembly, tx: string): number | undefined { return a.times.get(tx); }

async function confirmed(s: EvidenceReadSession, hash: string, member: string): Promise<void> {
  need(HASH.test(hash) && ((await s.node.txStatus(hash)).confirmations ?? 0) >= 1, `${member}: the transaction is not confirmed`);
}

async function rowsOf(s: EvidenceReadSession, refs: string[]): Promise<KoiosUtxo[]> {
  return refs.length === 0 ? [] : koiosUtxoInfo(s.chain.koiosUrl, refs, s.chain.fetchImpl, 512 * 1024);
}
async function rowOf(s: EvidenceReadSession, reference: string): Promise<KoiosUtxo> {
  need(REF.test(reference), 'the archived output reference is invalid');
  const rows = await rowsOf(s, [reference]);
  need(rows.length === 1 && outputRef(rows[0]!) === reference, 'the archive does not show the exact output');
  return rows[0]!;
}
function tokenAt(row: KoiosUtxo, site: { address: string; hash: string }, token: string): boolean {
  const policy = row.asset_list?.filter((asset) => isObject(asset) && asset.policy_id === site.hash);
  return row.address === site.address && row.payment_cred === site.hash && policy?.length === 1
    && isObject(policy[0]) && policy[0].asset_name === token && (policy[0].quantity === '1' || policy[0].quantity === 1);
}
function hasSpend(info: ScriptTxInfo, hash: string, input: string, action: number, fields: readonly unknown[]): boolean {
  return info.inputs.filter((one) => one.ref === input && one.credential === hash).length === 1
    && single(info.spends, (one) => one.script === hash && one.input === input && one.valid && one.action === action && same(one.fields, fields)) !== undefined;
}

/** Use the original mint output, including after an undelegation burned its token. */
async function mintedDelegation(s: EvidenceReadSession, tx: string, id: string): Promise<DelegationDatum> {
  const site = s.chain.deployment.delegation;
  const info = await scripts(s, tx);
  need(info.minted.some((one) => one.policy === site.hash && one.name === id && one.quantity === 1n), 'the delegation transaction did not mint the expected token');
  const refs = info.outputs.filter((one) => one.credential === site.hash).map((one) => one.ref);
  const found = single(await rowsOf(s, refs), (row) => refs.includes(outputRef(row)) && tokenAt(row, site, id));
  need(found && typeof found.inline_datum?.bytes === 'string', 'the original delegation output and datum are not proven');
  return decodeDelegationDatum(found.inline_datum.bytes);
}

async function readAuthority(s: EvidenceReadSession, a: Assembly): Promise<Authority> {
  const [delegation, ...otherDelegations] = a.reads.delegations;
  const [vault, ...otherVaults] = a.reads.vaults;
  const buyer = sourcing(a.use);
  const did = buyer === undefined ? undefined : didOf(a, buyer.id);
  need(did && delegation && vault && otherDelegations.length === 0 && otherVaults.length === 0, 'the run needs one Sourcing Agent, one root delegation and one vault');
  let vaultRoot = vault.ref;
  for (let i = 0; txOf(vaultRoot) !== vault.open_tx && i < 32; i += 1) {
    const parent = single((await txInfo(s, txOf(vaultRoot))).inputs, (input) => input.credential === s.chain.deployment.vault.hash);
    need(parent && REF.test(parent.ref), 'the original run vault reference is not proven');
    vaultRoot = parent.ref;
  }
  need(txOf(vaultRoot) === vault.open_tx, 'the original run vault reference is not proven');
  const [root, origin] = await Promise.all([mintedDelegation(s, delegation.tx, delegation.id), rowOf(s, vaultRoot)]);
  need(root.delegate === did.slice(11) && root.parent === null && root.depth === 1 && root.actions.includes(utf8Hex('vendor.read'))
    && root.actions.includes(utf8Hex('sourcing.award.write')) && root.actions.includes(utf8Hex('marketplace.hire.v1')), 'the delegation does not authorize this Sourcing Agent and its required actions');
  const held = decodeVaultDatum(origin.inline_datum?.bytes ?? '');
  need(origin.address === s.chain.deployment.vault.address && held.type === 'Live' && held.delegation === delegation.id && same(held.owner, root.delegator), 'the run vault has a different owner or delegation');
  return { delegation, vault, vaultRoot, principal: root.delegator, sourcing: did };
}

function candidateOf(a: Assembly, row: unknown): Candidate {
  need(isObject(row) && typeof row.did === 'string', 'bidders: a signed bidder file has no DID');
  const agent = desks(a.use).find(({ id }) => didOf(a, id) === row.did);
  need(agent && typeof row.advert_ref === 'string' && agent.adverts.some(({ model }) => a.facts.adverts[agent.id]?.[model]?.ref === row.advert_ref), 'bidders: the DID and advert do not name the same desk in the facts');
  need(typeof row.status === 'string' && BIDDER_STATUSES.includes(row.status) && (row.in_catalog === null || typeof row.in_catalog === 'boolean')
    && isObject(row.compliance) && typeof row.compliance.state === 'string' && FACT_STATES.includes(row.compliance.state), 'bidders: the status, catalog or compliance observation is invalid');
  const digest = canonicalSha256(row);
  need(digest.ok, 'bidders: the signed file has no canonical hash');
  return { agent, did: row.did, advert: row.advert_ref, status: row.status, inCatalog: row.in_catalog, compliance: row.compliance, sha256: digest.value };
}

function proposalOf(a: Assembly, hire: ReportedHire): Proposal {
  const result = hire.result;
  const p = parseProposal({ document: result.document, salt: result.salt, proposal_digest: result.proposal_digest });
  const ranking = parseRanking(result.document);
  need(p.ok && ranking.ok && ranking.value.tenant === a.loaded.record.tenant && result.outcome === 'proposed'
    && result.use_case === a.use.name, 'document: the signed proposal is not the ranking and digest of this run');
  need(Array.isArray(result.bidders) && result.bidders.length > 0 && result.bidders.length <= desks(a.use).length, 'bidders: the result has no complete bidder files');
  const bidders = result.bidders.map((row: unknown) => candidateOf(a, row));
  const known = new Set(bidders.map(({ did }) => did));
  const ranked = [...ranking.value.ranked, ...ranking.value.excluded];
  need(known.size === bidders.length && ranked.length === known.size && ranked.every(({ desk_did }) => known.has(desk_did)), 'bidders: the ranking does not cover these desks once each');
  const decision = single(hire.decisions, (one) => one.name === 'shortlist');
  const choice = decision?.choice;
  need(isObject(choice) && Array.isArray(choice.invite) && Array.isArray(choice.not_invited), 'shortlist: the signed shortlist decision is missing');
  const invites: unknown[] = choice.invite;
  need(invites.every((did): did is string => typeof did === 'string' && known.has(did)) && new Set(invites).size === invites.length,
    'shortlist: the decision does not invite distinct known desks');
  const omitted = choice.not_invited.map((row: unknown) => isObject(row) ? row.did : null);
  need(omitted.length + invites.length === known.size && new Set([...invites, ...omitted]).size === known.size
    && omitted.every((did: unknown) => typeof did === 'string' && known.has(did)), 'shortlist: the decision does not account for each desk');
  return { hire, ranking: ranking.value, digest: p.value.proposal_digest, bidders, invites, shortlist: modelRef(decision) };
}

/** Anchor the Pay input to this run's original vault, not to any vault of the same delegation. */
async function fromRunVault(s: EvidenceReadSession, a: Assembly, hire: ReportedHire, authority: Authority, cache: Map<string, Promise<TxInfo>>): Promise<string> {
  const payment = await a.paidFromVault(hire.entry);
  need(payment.paid && payment.delegation === authority.delegation.id && REF.test(payment.vault_ref), 'quotes: the ledger proves no Pay from the run delegation');
  let current = payment.vault_ref;
  const seen = new Set<string>();
  for (let i = 0; i < 32; i += 1) {
    if (current === authority.vaultRoot) return payment.vault_ref;
    if (seen.has(current)) break;
    seen.add(current);
    const hash = txOf(current);
    const read = cache.get(hash) ?? txInfo(s, hash);
    cache.set(hash, read);
    const parents = (await read).inputs.filter((one) => one.credential === s.chain.deployment.vault.hash);
    if (parents.length !== 1 || !REF.test(parents[0]!.ref)) break;
    current = parents[0]!.ref;
  }
  throw new BidProofError('quotes: the paid vault is not in the lineage of this run vault');
}

function quoteChallenge(value: unknown, agent: string): Challenge | null {
  if (!isObject(value) || typeof value.claim !== 'string' || !REF.test(value.claim) || typeof value.evidence !== 'string' || !HASH.test(value.evidence)
    || typeof value.challenge !== 'string' || !REF.test(value.challenge)) return null;
  return { agent, claim: value.claim, evidence: value.evidence, challenge: value.challenge };
}

async function readQuotes(s: EvidenceReadSession, a: Assembly, p: Proposal, authority: Authority, cache: Map<string, Promise<TxInfo>>): Promise<readonly CheckedQuote[]> {
  const { result } = p.hire;
  const phase = p.hire.entry.step;
  const jobs: unknown[] = Array.isArray(result.sub_jobs) ? result.sub_jobs : [];
  const rows: unknown[] = Array.isArray(result.quotes) ? result.quotes : [];
  const decisions = p.hire.decisions.filter((one) => one.name === 'accept_quote');
  need(rows.length === p.invites.length && rows.length === decisions.length && rows.length > 0 && p.shortlist !== null, 'quotes: each invitation must have its own quote and accept_quote decision');
  const parentPost = at(a, p.hire.entry.post_tx);
  const parentEnd = p.hire.entry.accept_tx === null ? undefined : at(a, p.hire.entry.accept_tx);
  let lastAt = parentPost;
  const quotes: CheckedQuote[] = [];
  for (const [i, row] of rows.entries()) {
    const hire = named(a, quoteAt(phase, i));
    const desk = p.bidders.find(({ did }) => did === p.invites[i]);
    need(hire && desk && hire.role === 'quote' && hire.entry.agent === desk.agent.id && hire.entry.advert_ref === desk.advert
      && isObject(row) && row.desk_did === desk.did && row.advert_ref === desk.advert && row.escrow_ref === hire.entry.escrow_ref
      && row.paid_from_vault === true && verified(row.verification), 'quotes: a quote report is not linked to its invited desk and escrow');
    const posted = at(a, hire.entry.post_tx);
    need(posted !== undefined && lastAt !== undefined && posted > lastAt && parentEnd !== undefined && posted < parentEnd, 'quotes: the post order within the proposal is not proven');
    const parsed = parseQuote(hire.result);
    const signed = receiptSha256(hire.report.receipt, hire.report.receipt_signature);
    const nested = receiptSha256(row.receipt, row.receipt_signature);
    const fault = phase === 'propose-a' && desk.agent.id === a.loaded.record.challenged ? QUOTE_FAULT : '';
    need(parsed.ok && signed.ok && nested.ok && signed.value === nested.value && same(row.result, hire.result) && parsed.value.rfq_id === p.ranking.rfq_id
      && parsed.value.rfq_sha256 === p.ranking.rfq_sha256 && parsed.value.desk_did === desk.did && parsed.value.sender.did === authority.sourcing
      && parsed.value.fault_mode === fault, 'quotes: the signed result, receipt, sender, request or fault does not match the proposal');
    const choice = decisions[i]?.choice;
    const judge = modelRef(decisions[i]);
    const writer = modelRef(single(hire.decisions, (one) => one.name === 'quote'));
    const challenge = quoteChallenge(row.challenge, desk.agent.id);
    const accepted = a.terminals.get(hire.entry.escrow_ref) ?? null;
    const rank = p.ranking.ranked.find(({ desk_did }) => desk_did === desk.did);
    const excluded = p.ranking.excluded.find(({ desk_did }) => desk_did === desk.did);
    need(judge && writer && isObject(choice) && Array.isArray(choice.mismatch), 'quotes: the quote or accept_quote model decision is unproven');
    if (rank) {
      const sub = single(jobs, (one): boolean => isObject(one) && one.escrow_ref === hire.entry.escrow_ref);
      const subHash = isObject(sub) ? receiptSha256(sub.receipt, sub.receipt_signature) : null;
      need(accepted?.action === 'Accept' && accepted.tx === hire.entry.accept_tx && accepted.at >= posted && accepted.at <= parentEnd
        && (row.accepted === 'confirmed' || row.accepted === 'pending') && row.challenge === null && choice.accept === true && choice.mismatch.length === 0
        && rank.quote.escrow_ref === hire.entry.escrow_ref && rank.quote.receipt_sha256 === signed.value && rank.quote.total === parsed.value.total
        && rank.quote.lead_time_days === parsed.value.lead_time_days && isObject(sub) && sub.advert_ref === desk.advert && sub.capability_id === desk.agent.capability
        && sub.supplier_pkh === hire.report.receipt.supplier_pkh && verified(sub.verification) && subHash?.ok && subHash.value === signed.value,
      'quotes: the ranking is not the accepted signed quote of this desk');
      lastAt = accepted.at;
    } else {
      need(fault === QUOTE_FAULT && excluded?.reason === 'disputed' && excluded.code === null && challenge && row.accepted === 'no' && accepted === null
        && choice.accept === false && choice.mismatch.length > 0 && choice.mismatch.every((sku) => parsed.value.lines.some((line) => line.sku === sku)),
      'quotes: the excluded quote does not show a model refusal and a challenge of this desk');
      lastAt = posted;
    }
    const vault = await fromRunVault(s, a, hire, authority, cache);
    quotes.push({ hire, desk, result: parsed.value, receiptHash: signed.value, quoteDecision: writer, acceptDecision: judge, accept: accepted, vault, challenge });
  }
  need(jobs.length === p.ranking.ranked.length, 'quotes: sub_jobs do not match the ranked quotes');
  return quotes;
}

function logActor(line: Obj, authority: Authority, actors: readonly string[], delegation: string): boolean {
  const principal = authority.principal;
  const { act, sub } = line;
  const subject = principal.type === 'Agent' ? sub === `did:vector:${principal.id}`
    : typeof sub === 'string' && sub.endsWith(`/principals/key/${principal.hash}`);
  return subject && line.credential === 'token' && line.delegation === delegation && Array.isArray(act)
    && act.length === actors.length && actors.every((actor, i) => act[i] === actor);
}

function logAt(line: Obj, start: number, end: number): boolean {
  const time = typeof line.at === 'string' ? Date.parse(line.at) : Number.NaN;
  return time >= start && time <= end + 999; // Koios block time is in seconds.
}

async function readScores(s: EvidenceReadSession, a: Assembly, p: Proposal, quotes: readonly CheckedQuote[], auth: Authority): Promise<readonly Ref[]> {
  const answers = quotes.filter((q) => q.accept !== null);
  const scorers = a.use.subagents.filter(({ parent }) => parent === p.hire.entry.agent).slice(0, answers.length);
  const children = a.reads.subDelegations.filter(({ hire }) => hire === p.hire.entry.step);
  const decisions = p.hire.decisions.filter((one) => one.name === 'score');
  const start = at(a, p.hire.entry.post_tx);
  const end = p.hire.entry.accept_tx === null ? undefined : at(a, p.hire.entry.accept_tx);
  const ranked = single(p.hire.decisions, (one) => one.name === 'ranking');
  const rankRef = modelRef(ranked);
  const rankChoice = ranked?.choice;
  need(start !== undefined && end !== undefined && answers.length === scorers.length && children.length === scorers.length
    && decisions.length === scorers.length && ranked && rankRef && isObject(rankChoice) && same(rankChoice.order, p.ranking.ranked.map((one) => one.desk_did)),
  'scores: the proposal needs one checked score and sub-delegation per accepted quote and its ranking decision');
  const out: Ref[] = [ref('escrow', rankRef)];
  for (const [i, scorer] of scorers.entries()) {
    const child = single(children, ({ subagent }) => subagent === scorer.id);
    const scorerDid = didOf(a, scorer.id);
    const score = decisions[i];
    const scoreRef = modelRef(score);
    const rankedBid = p.ranking.ranked.find((one) => one.desk_did === answers[i]!.desk.did);
    const inverted = p.hire.result.fault_mode === RANK_FAULT && i === 0;
    need(child && scorerDid && scoreRef && isObject(score?.choice) && rankedBid
      && (inverted || (score.choice.score === rankedBid.score && same(score.choice.components, rankedBid.components))),
    'scores: a scorer, quote, model decision or sub-delegation does not match the ranking');
    const [datum, delegated, ended, made] = await Promise.all([
      mintedDelegation(s, child.delegate_tx, child.id), txInfo(s, child.delegate_tx), txInfo(s, child.undelegate_tx), txInfo(s, txOf(scoreRef)),
    ]);
    const log = (a.mock?.lines ?? []).some((line) => line.route === READ_VENDORS && line.decision === 'allowed' && line.status === 200
      && logActor(line, auth, [scorerDid, auth.sourcing], child.id)
      && logAt(line, Math.max(delegated.timeMs, datum.notBefore, answers[i]!.accept!.at, start), Math.min(ended.timeMs, datum.notAfter, made.timeMs, end)));
    need(datum.delegate === scorerDid.slice(11) && datum.parent === auth.delegation.id && datum.delegator.type === 'Agent'
      && datum.delegator.id === auth.sourcing.slice(11) && datum.depth === 2 && datum.actions.length === 1 && datum.actions[0] === utf8Hex('vendor.read')
      && delegated.timeMs >= start && made.timeMs <= ended.timeMs && ended.timeMs <= end && log, 'scores: the ledger and log do not show the scorer reading vendors under its own two-link delegation');
    out.push(ref('delegation', child.id), ref('transaction', child.delegate_tx), ref('transaction', child.undelegate_tx), ref('escrow', scoreRef));
  }
  return out;
}

async function checkedChallenge(s: EvidenceReadSession, a: Assembly, quote: CheckedQuote): Promise<CheckedQuote> {
  const c = quote.challenge;
  need(c !== null, 'challenge: the signed quote record has no challenge');
  const record = a.facts.records[c.agent];
  const claim = a.facts.claims[a.loaded.record.label]?.[c.agent];
  const buyer = sourcing(a.use);
  const auditor = buyer && a.facts.records[buyer.id];
  need(record && auditor && claim && c.claim === claim.claimRef && txOf(c.claim) === claim.claimTx, 'challenge: the claim does not belong to this desk and run');
  const commit = s.settings.module1Commit;
  need(commit !== null, 'challenge: the Module-1 deployment is not pinned');
  const uri = `https://raw.githubusercontent.com/Apex-Fusion/vector-agent-modules/${commit}/${s.use.moduleManifestPath}`;
  const module1 = module1FromManifest(await readManifest(uri, 'The Module-1 manifest', s.fetchImpl), uri);
  need(module1.identityHash === s.chain.deployment.identity.hash, 'challenge: the deployment is not for this identity registry');
  const [before, opened, info, document, evidence] = await Promise.all([
    rowOf(s, c.claim), rowOf(s, c.challenge), scripts(s, txOf(c.challenge)),
    readDocument(documentUri(claim.documentTx), { koiosUrl: s.chain.koiosUrl, fetchImpl: s.chain.fetchImpl }),
    readDocument(documentUri(c.evidence), { koiosUrl: s.chain.koiosUrl, fetchImpl: s.chain.fetchImpl }),
  ]);
  const datum = decodeClaimDatum(before.inline_datum?.bytes ?? '');
  const challenge = decodeChallengeDatum(opened.inline_datum?.bytes ?? '');
  const kind = typeof before.payment_cred === 'string' ? before.payment_cred : '';
  const policy = typeof opened.payment_cred === 'string' ? opened.payment_cred : '';
  const token = single(info.minted, (one) => one.policy === policy && CHALLENGE_TOKEN.test(one.name) && one.quantity === 1n);
  const text = readClaimDocument(document.bytes);
  const refs = evidenceReferences(evidence.bytes);
  const lines = Buffer.from(evidence.bytes).toString('utf8').split('\n');
  const linked = info.outputs.some((item) => item.ref === c.challenge && item.credential === policy);
  need(kind === module1.claim.hash && before.address === module1.claim.address && policy === module1.challenge.hash && opened.address === module1.challenge.address
    && token && before.is_spent === true && linked && hasSpend(info, kind, c.claim, 2, [])
    && before.asset_list?.some((one) => isObject(one) && one.policy_id === kind && one.asset_name === claim.claimToken && (one.quantity === '1' || one.quantity === 1))
    && opened.asset_list?.some((one) => isObject(one) && one.policy_id === policy && one.asset_name === token.name && (one.quantity === '1' || one.quantity === 1)),
  'challenge: the ledger does not show the claim spend and the exact challenge token');
  need(datum.state === 'Open' && datum.claimerDid === record.id && datum.stakeAmount === CLAIM_STAKE_LOVELACE && datum.challengeWindow === CLAIM_WINDOW_MS
    && datum.claimType === utf8Hex(quote.desk.agent.capability) && txHashOfUri(Buffer.from(datum.storageUri, 'hex').toString('utf8')) === claim.documentTx
    && document.type === 'claim' && document.hash === datum.claimHash && text.ok && text.value.agent_did === record.did
    && text.value.capability_id === quote.desk.agent.capability && same(text.value.claim, BID_DESK_CLAIM),
  'challenge: the staked claim and the committed claim document do not match the desk');
  need(formatOutRef(challenge.claimRef.txHash, challenge.claimRef.outputIndex) === c.claim && challenge.claimToken === claim.claimToken
    && challenge.auditorDid === auditor.id && txHashOfUri(Buffer.from(challenge.evidenceUri, 'hex').toString('utf8')) === c.evidence
    && evidence.type === 'evidence' && evidence.hash === challenge.evidenceHash && refs.ok && refs.value.claim === c.claim && refs.value.claim_token === claim.claimToken
    && refs.value.by_did === auditor.did && refs.value.against_did === record.did && refs.value.escrow_ref === quote.hire.entry.escrow_ref
    && lines[0] === `Evidence about statement ${EVIDENCE_STATEMENTS.quote_price} of a claim on the Vector marketplace.`
    && lines.includes(`SHA-256 of the published price list: ${quote.result.price_list_sha256}`) && lines.includes(`SHA-256 of the quote: ${quote.hire.sha256}`),
  'challenge: the committed evidence does not link this claim, quote escrow and challenger');
  return quote;
}

interface RecordHistory { readonly data: IdentityDatum; readonly tx: ScriptTxInfo; readonly before: string; readonly output: string }
async function readRevokedOutput(s: EvidenceReadSession, a: Assembly, agent: string): Promise<RecordHistory | null> {
  const f = a.facts.revocations[agent];
  const identity = s.chain.deployment.identity;
  const owner = a.facts.records[agent];
  if (!f || !owner) return null;
  const tx = await scripts(s, f.tx);
  const before = single(tx.inputs, (one) => one.credential === identity.hash);
  const output = single(tx.outputs, (one) => one.credential === identity.hash);
  need(before && output, 'revocation: no exact spent and replacement identity outputs');
  const [row, old] = await Promise.all([rowOf(s, output.ref), rowOf(s, before.ref)]);
  need(old.is_spent === true && tokenAt(old, identity, owner.id) && tokenAt(row, identity, owner.id), 'revocation: the identity token does not link the old and new records');
  return { before: before.ref, output: output.ref, tx, data: decodeIdentityDatum(row.inline_datum?.bytes ?? '') };
}

/** Only locate a candidate here. The core checks the case token, Finalize, resolution document and exact verdict application. */
async function locateHold(s: EvidenceReadSession, a: Assembly, agent: string, revoked: Proof<RecordHistory | null>): Promise<HistoricalHoldCandidate | null> {
  const record = a.facts.records[agent];
  if (record === undefined) return null;
  if (!revoked.ok) throw new PreconditionError(revoked.why);
  const site = s.chain.deployment.identity;
  const found = revoked.value === null ? await findRecord(s.chain.provider, s.chain.deployment, record.id) : null;
  if (found === null && revoked.value === null) return null;
  const output = revoked.value?.before ?? formatOutRef(found!.utxo.txHash, found!.utxo.outputIndex);
  const old = revoked.value === null ? found!.record : decodeIdentityDatum((await rowOf(s, output)).inline_datum?.bytes ?? '');
  if (old.status.type !== 'Suspended') return null;
  const config = await findConfigRecord(s.chain.provider, s.chain.deployment);
  need(config, 'hold: the deployment gives no configured verdict script');
  const hold = single(old.status.holds, (one) => one.by.type === 'Script' && one.by.hash === config.m1 && one.reason === JURY_REASON && one.until - one.since === SEVEN_DAYS_MS);
  if (!hold) return null;
  const apply = await scripts(s, txOf(output));
  need(apply.outputs.some((one) => one.ref === output && one.credential === site.hash), 'hold: the ledger does not show the application output');
  const consumed = single(apply.inputs, (one) => one.credential === config.m1);
  need(consumed, 'hold: the application has no exact consumed verdict output');
  return { reason: JURY_REASON, since: hold.since, until: hold.until, record_output: output, gateway_status: null, verdict_output: consumed.ref };
}

async function configuredComplianceIssuer(s: EvidenceReadSession, a: Assembly): Promise<string> {
  const proposal = named(a, 'propose-b');
  const agent = sourcing(a.use);
  const did = agent && didOf(a, agent.id);
  need(proposal && agent && did, 'compliance: the signed proposal and sourcing identity are missing');
  const advert = await readAdvert(proposal.entry.advert_ref, s.chain.fetchImpl, s.chain.koiosUrl, s.chain.deployment.advert.address);
  need(!('error' in advert) && advert.layout === 'identity' && advert.agentId === did.slice(11), 'compliance: the sourcing advert is unproven');
  const { detail_uri: uri, detail_hash: hash } = advert.advert;
  const url = new URL(uri);
  need(url.origin === new URL(agent.endpoint).origin && url.protocol === 'https:' && url.username === '' && url.password === '' && url.hash === '' && HASH.test(hash),
    'compliance: the advert does not name a bounded manifest of the sourcing service');
  const answer = await s.fetchImpl(uri, { redirect: 'error', signal: AbortSignal.timeout(10_000), headers: { accept: 'application/json' } });
  need(answer.status === 200, 'compliance: the sourcing manifest could not be read');
  const bytes = await readLimited(answer, 256 * 1024);
  need(bytes !== null && createHash('sha256').update(bytes).digest('hex') === hash, 'compliance: the sourcing manifest does not match its advert hash');
  const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  const issuer = isObject(value) && isObject(value.keys) ? value.keys.compliance_issuer_pkh : null;
  need(typeof issuer === 'string' && POLICY.test(issuer), 'compliance: the sourcing manifest gives no configured issuer');
  return issuer;
}

async function readCompliance(s: EvidenceReadSession, a: Assembly, agent: string): Promise<ComplianceRead> {
  const held = a.facts.compliance[agent];
  const subject = a.facts.records[agent];
  const spec = a.use.compliance;
  need(spec !== null && spec.subjects.includes(agent) && subject && held?.revokeTx && held.contestTx && held.replySha256 && held.replyUri,
    'compliance: the issue, revoke and reply facts are missing');
  need(new Set([held.tx, held.revokeTx, held.contestTx]).size === 3 && [held.id, held.tx, held.revokeTx, held.contestTx, held.replySha256, held.digest].every((h) => HASH.test(h)),
    'compliance: the facts do not name distinct transactions and valid hashes');
  const site = s.chain.deployment.attestation;
  const [issue, revoke, contest, current, issuer] = await Promise.all([
    scripts(s, held.tx), scripts(s, held.revokeTx), scripts(s, held.contestTx), readAttestation(envOf(s), held.id), configuredComplianceIssuer(s, a),
    ...[held.tx, held.revokeTx, held.contestTx].map((tx) => confirmed(s, tx, 'compliance')),
  ]);
  need(current && current.attestation.status.type === 'AttRevoked' && current.attestation.contested?.sha256 === held.replySha256
    && current.attestation.contested.uri === utf8Hex(held.replyUri) && current.attestation.subject === subject.id
    && current.attestation.attType === 0 && current.attestation.format === spec.format && current.attestation.issuerId === null
    && current.attestation.digest === held.digest && current.attestation.locator === utf8Hex(held.locator)
    && current.attestation.issuedAt === Date.parse(held.issuedAt) && current.attestation.validUntil === Date.parse(held.validUntil)
    && keyHashOf(current.attestation.issuer) === issuer
    && txOf(current.ref) === held.contestTx && issue.timeMs < revoke.timeMs && revoke.timeMs <= contest.timeMs,
  'compliance: the node does not show the matching revoked and contested attestation');
  const issuedInput = single(revoke.inputs, (one) => one.credential === site.hash && txOf(one.ref) === held.tx);
  const revokedInput = single(contest.inputs, (one) => one.credential === site.hash && txOf(one.ref) === held.revokeTx);
  const reason = current.attestation.status.reason;
  need(issuedInput && revokedInput && current.revokeReason === BigInt(reason)
    && issue.outputs.some((one) => one.ref === issuedInput.ref && one.credential === site.hash)
    && revoke.outputs.some((one) => one.ref === revokedInput.ref && one.credential === site.hash)
    && contest.outputs.some((one) => one.ref === current.ref && one.credential === site.hash)
    && issue.minted.some((one) => one.policy === site.hash && one.name === held.id && one.quantity === 1n)
    && hasSpend(revoke, site.hash, issuedInput.ref, 0, [{ int: reason }]) && hasSpend(contest, site.hash, revokedInput.ref, 1, []),
  'compliance: the transactions do not prove the issue, revoke and contest of the same token');
  const [first, second] = await Promise.all([rowOf(s, issuedInput.ref), rowOf(s, revokedInput.ref)]);
  need(first.is_spent === true && second.is_spent === true && tokenAt(first, site, held.id) && tokenAt(second, site, held.id), 'compliance: the historical outputs do not hold this attestation token');
  const original = decodeAttestationDatum(first.inline_datum?.bytes ?? '');
  const revoked = decodeAttestationDatum(second.inline_datum?.bytes ?? '');
  const { attestation } = current;
  need(same(revoked, { ...attestation, contested: null }) && same(original, { ...revoked, status: { type: 'AttActive' } }),
    'compliance: the issue and revoked datums do not match the attestation and its reply');
  return { attestation: held.id, issue_tx: held.tx, revoke_tx: held.revokeTx, contest_tx: held.contestTx,
    reason, reply_sha256: held.replySha256, revoked_at: revoke.timeMs, contested_at: contest.timeMs };
}

function lastList(text: string): unknown {
  need(text.length <= 512 * 1024, 'listing: the supplier list exceeds the evidence read limit');
  const block = [...text.matchAll(/```json\r?\n([\s\S]*?)\r?\n```/g)].at(-1);
  if (!block) throw new PreconditionError('listing: the hosted tool returned no list');
  return JSON.parse(block[1]!) as unknown;
}
async function readListing(s: EvidenceReadSession, a: Assembly, agent: string): Promise<true> {
  const desk = desks(a.use).find(({ id }) => id === agent);
  const did = didOf(a, agent);
  const adverts = Object.values(a.facts.adverts[agent] ?? {});
  need(desk && did && adverts.length > 0, 'listing: the challenged desk or its adverts are missing');
  const limit = 50;
  const answer = await s.hosted.call(LIST, { capability_id: desk.capability, only_free: false, limit });
  need(!answer.failed, 'listing: the supplier list could not be read');
  const rows = lastList(answer.text);
  need(Array.isArray(rows) && rows.length < limit, 'listing: the supplier list is not complete');
  const available = new Map<string, string>();
  for (const row of rows) {
    need(isObject(row) && typeof row.advert_ref === 'string' && REF.test(row.advert_ref) && row.capability_id === desk.capability
      && typeof row.did === 'string' && /^did:vector:[0-9a-f]{64}$/.test(row.did),
      'listing: the tool gave an unreadable advert');
    need(!adverts.some((entry) => entry.ref === row.advert_ref) && row.did !== did && row.agent_id !== did.slice(11), 'listing: the challenged desk still has a listed advert');
    need(!available.has(row.advert_ref), 'listing: the supplier list repeats an advert');
    available.set(row.advert_ref, row.did);
  }
  const remaining = desks(a.use).filter(({ id }) => id !== agent);
  need(remaining.every(({ id }) => Object.values(a.facts.adverts[id] ?? {}).some(({ ref: listed }) => available.get(listed) === didOf(a, id))),
    'listing: the other run adverts are not listed');
  return true;
}

async function verifyRevocation(s: EvidenceReadSession, a: Assembly, agent: string, read: RecordHistory | null): Promise<RevocationRead> {
  const fact = a.facts.revocations[agent];
  const owner = a.facts.records[agent];
  const target = desks(a.use).find(({ id }) => id === agent);
  need(fact && owner && target?.end.record === 'revoked' && read, 'revocation: the verified fact and replacement output are missing');
  const { data: { status }, tx } = read;
  const before = decodeIdentityDatum((await rowOf(s, read.before)).inline_datum?.bytes ?? '');
  const domain = a.use.organisations.find(({ id }) => target.organisation === id)?.domain;
  const key = status.type === 'Revoked' && status.by.type === 'KeyHash' ? status.by.hash : null;
  const party = before.parties.findIndex((one) => one.role === 'Accountable' && one.signer.type === 'KeyHash' && one.signer.hash === key
    && domain !== undefined && one.organisation === utf8Hex(domain) && hasRight(one.rights, RIGHT.revoke) && one.notBefore <= tx.timeMs
    && (one.notAfter === null || tx.timeMs <= one.notAfter));
  const current = await findRecord(s.chain.provider, s.chain.deployment, owner.id);
  need(status.type === 'Revoked' && key && party >= 0 && status.reason === fact.reason && status.reason !== JURY_REASON
    && status.at === Date.parse(fact.revokedAt) && status.invalidFrom !== null && fact.invalidFrom !== null && status.invalidFrom === Date.parse(fact.invalidFrom)
    && status.successor === null && current && same(current.record, read.data)
    && hasSpend(tx, s.chain.deployment.identity.hash, read.before, 4, [{ constructor: 1, fields: [{ int: party }] }]),
  'revocation: the node does not show the requested Accountable revocation of this record');
  const result = await s.hosted.call(RESOLVE, { did: owner.did });
  const meta = result.json?.didDocumentMetadata;
  const effective = isObject(meta) && isObject(meta.vectorStatus) ? meta.vectorStatus.effective : null;
  need(!result.failed && isObject(meta) && meta.deactivated === true && typeof effective === 'string' && effective.toLowerCase() === 'revoked', 'revocation: the resolver does not show the DID as revoked');
  await confirmed(s, fact.tx, 'revocation');
  return { tx: fact.tx, spent_output: read.before, record_output: read.output, reason: status.reason, author: key, invalid_from: status.invalidFrom, at: tx.timeMs };
}

async function bidderEvidence(s: EvidenceReadSession, a: Assembly, p: Proposal): Promise<readonly Ref[]> {
  need(p.shortlist && p.bidders.length === desks(a.use).length && p.invites.length === p.bidders.length, 'bidders: the clean shortlist does not cover every desk');
  const refs: Ref[] = [ref('escrow', p.shortlist)];
  for (const bidder of p.bidders) {
    need(bidder.status === 'active' && bidder.inCatalog !== null, 'bidders: the signed file does not show an active desk and a catalog read');
    const advert = await readAdvert(bidder.advert, s.chain.fetchImpl, s.chain.koiosUrl, s.chain.deployment.advert.address);
    need(!('error' in advert) && advert.layout === 'identity' && advert.agentId === bidder.did.slice(11) && advert.advert.capability_id === bidder.agent.capability
      && advert.advert.status === 'Active', 'bidders: the ledger does not show this desk advert');
    await confirmed(s, txOf(bidder.advert), 'bidders');
    refs.push(ref('advert', bidder.advert), ref('bidder', bidder.sha256));
  }
  return refs;
}

function challengeOf(a: Assembly): Challenge | null {
  const agent = a.loaded.record.challenged;
  if (a.loaded.record.kind !== 'failure' || agent === null || !desks(a.use).some(({ id, end }) => id === agent && end.record === 'revoked')) return null;
  const proposal = named(a, 'propose-a');
  if (!Array.isArray(proposal?.result.quotes)) return null;
  const challenged = single(proposal.result.quotes, (row) => isObject(row) && row.challenge != null);
  return isObject(challenged) && challenged.desk_did === didOf(a, agent) ? quoteChallenge(challenged.challenge, agent) : null;
}

const NOT_NEEDED = missing('the run does not contain this operation');

async function prepareBids(s: EvidenceReadSession, a: Assembly): Promise<Obj> {
  const agent = a.loaded.record.challenged;
  const challenge = challengeOf(a);
  const revoked = challenge === null ? proved(null) : await proof('revocation', () => readRevokedOutput(s, a, challenge.agent));
  const hold = challenge === null ? proved(null) : await proof('hold', () => locateHold(s, a, challenge.agent, revoked));
  if (a.purpose === 'status') return { bids: { hold } };
  const proposals = new Map<string, Proof<Proposal>>();
  const quotes = new Map<string, Proof<readonly CheckedQuote[]>>();
  const vaultCache = new Map<string, Promise<TxInfo>>();
  const scores = new Map<string, Proof<readonly Ref[]>>();
  const expectedQuotes = new Set<string>();
  const seen = a.loaded.hires.filter((h) => h.role === 'propose');
  const expected = a.loaded.record.kind === 'clean' ? PHASES.clean : PHASES.failure;
  let orderedRfqs = seen.length === a.loaded.record.rfq_ids.length && (a.loaded.record.kind !== 'clean' || seen.length === expected.length);
  let lastIndex = -1;
  const authority = await proof('delegation and vault', () => readAuthority(s, a));
  for (const [index, hire] of seen.entries()) {
    const slot = expected.findIndex((name) => name === hire.entry.step);
    const p = await proof<Proposal>('proposal', async () => {
      need(hire.report !== null, 'proposal: the signed report is missing');
      return proposalOf(a, hire);
    });
    proposals.set(hire.entry.step, p);
    if (slot <= lastIndex || (p.ok && p.value.ranking.rfq_id !== a.loaded.record.rfq_ids[index])) orderedRfqs = false;
    lastIndex = slot;
    if (p.ok) p.value.invites.forEach((_, i) => expectedQuotes.add(quoteAt(hire.entry.step, i)));
    const observed = !p.ok ? p : !authority.ok ? authority : await proof('quotes', () => readQuotes(s, a, p.value, authority.value, vaultCache));
    quotes.set(hire.entry.step, observed);
    scores.set(hire.entry.step, p.ok && observed.ok && authority.ok ? await proof('scores', () => readScores(s, a, p.value, observed.value, authority.value))
      : missing('scores: the quote jobs or the run authority are unproven'));
  }
  for (const hire of a.loaded.hires) {
    if (hire.role === 'quote' && !expectedQuotes.has(hire.entry.step)) orderedRfqs = false;
    if (hire.role === 'execute' && hire.entry.step !== (a.loaded.record.kind === 'clean' ? 'execute' : 'execute-d')) orderedRfqs = false;
  }
  const clean = proposals.get('propose');
  const biddersRead: Proof<readonly Ref[]> = clean?.ok ? await proof('bidders', () => bidderEvidence(s, a, clean.value)) : clean ?? NOT_NEEDED;
  const aQuotes = quotes.get('propose-a');
  const disputed = aQuotes?.ok && challenge !== null
    ? single(aQuotes.value, (q) => q.challenge?.challenge === challenge.challenge && q.desk.agent.id === challenge.agent) : undefined;
  const provedChallenge = disputed === undefined ? missing('challenge: no matching signed quote and verified vault payment') : await proof('challenge', () => checkedChallenge(s, a, disputed));
  const release = provedChallenge.ok ? await proof('release', async () => {
    const terminal = await a.readRelease(provedChallenge.value.hire.entry);
    need(terminal?.action === 'Release', 'release: no proven Release of this quote escrow at or after its accept cutoff');
    return terminal;
  }) : NOT_NEEDED;
  const compliance = agent === null ? NOT_NEEDED : await proof('compliance', () => readCompliance(s, a, agent));
  const listing = agent === null || !proposals.has('propose-c') ? NOT_NEEDED : await proof('listing', () => readListing(s, a, agent));
  const revocation = agent === null || !revoked.ok ? NOT_NEEDED : await proof('revocation', () => verifyRevocation(s, a, agent, revoked.value));
  const value: BidReads = {
    proposals, orderedRfqs, authority, quotes, scores, challenge: provedChallenge, release, hold,
    bidderEvidence: biddersRead, compliance, listing, revocation,
  };
  return { bids: value };
}

function approvalOf(a: Assembly): ApprovalRead | null {
  const { record } = a.loaded;
  const approval = a.approvalStates[0];
  const execute = named(a, 'execute');
  const proposal = get(a).proposals.get('propose');
  if (record.kind !== 'clean' || record.approvals.length !== 1 || approval?.state !== 'active' || approval.type !== 5 || approval.link !== 'request'
    || approval.hire !== execute?.entry.step || !proposal?.ok || proposal.value.digest !== approval.digest) return null;
  return approval;
}

function rankingRows(state: Readonly<Obj>): readonly Obj[] | null {
  const area = state.sourcing;
  const list = isObject(area) ? area.rankings : null;
  if (!Array.isArray(list) || !list.every((row) => isObject(row) && typeof row.rfq_id === 'string')) return null;
  return new Set(list.map((row) => row.rfq_id)).size === list.length ? list : null;
}

function execution(a: Assembly, phase: 'propose' | 'propose-d', step: 'execute' | 'execute-d'): Shown {
  const p = get(a).proposals.get(phase);
  const auth = get(a).authority;
  const h = named(a, step);
  const answered = get(a).quotes.get(phase);
  if (!p?.ok || !auth.ok || !h || !answered?.ok || !get(a).scores.get(phase)?.ok) return 'execute: the matching proposal, quote jobs, scorers or run delegation are unproven';
  const request = a.committedExecutes.get(step);
  if (!request || request.escrow_ref !== h.entry.escrow_ref || request.digest !== p.value.digest || h.result.proposal_digest !== request.digest
    || h.result.use_case !== a.use.name || h.result.handoff !== null || h.result.challenge !== null) return 'execute: the exact committed request does not answer the signed proposal';
  const started = at(a, h.entry.post_tx);
  const endTx = h.entry.accept_tx;
  const ended = endTx === null ? undefined : at(a, endTx);
  const proposalEnd = p.value.hire.entry.accept_tx === null ? undefined : at(a, p.value.hire.entry.accept_tx);
  const final = a.terminals.get(h.entry.escrow_ref);
  if (started === undefined || ended === undefined || proposalEnd === undefined || proposalEnd > started || final?.tx !== endTx || final.action !== 'Accept'
    || a.mock === null) return 'execute: the ordered jobs, accepted result and tenant reads are unproven';
  const { rfq_id: rfq, ranked } = p.value.ranking;
  const rows = rankingRows(a.mock.state);
  const calls = a.mock.lines.filter((line) => line.route === WRITE_RANKING && logAt(line, started, ended)
    && logActor(line, auth.value, [auth.value.sourcing], auth.value.delegation.id));
  const writes = h.result.writes;
  if (!rows || !Array.isArray(writes)) return 'execute: the ranking state or signed write list is unreadable';
  if (step === 'execute-d') {
    if (request.approval !== null || a.loaded.record.approvals.length !== 0 || p.value.hire.result.fault_mode !== RANK_FAULT
      || h.result.outcome !== 'refused_by_system' || h.result.reason !== 'approval_not_found' || h.result.exit_state !== 'Rejected'
      || writes.length !== 0 || rows.some((row) => row.rfq_id === rfq) || calls.length !== 1
      || !calls.some((line) => line.decision === 'refused' && line.code === 'approval_not_found' && line.status === 403)) {
      return 'execute: the null approval, approval_not_found log, Rejected result and absence of a ranking are not all proven';
    }
    return hireRefs(h);
  }
  const approval = approvalOf(a);
  const saved = single(rows, (row) => row.rfq_id === rfq);
  const write: unknown = writes[0];
  const first = ranked[0]!;
  if (!approval || request.approval?.attestation !== approval.entry.attestation || h.result.outcome !== 'completed' || h.result.exit_state !== 'Completed' || h.result.reason !== null
    || writes.length !== 1 || !isObject(write) || write.system !== 'sourcing-record' || write.status !== 201 || write.route !== WRITE_RANKING
    || typeof write.ref !== 'string' || !/^RK-[a-z0-9-]+-[0-9]{4,}$/.test(write.ref)
    || !saved || saved.ranking_id !== write.ref || !isObject(saved.top) || saved.top.rank !== 1 || saved.top.desk_did !== first.desk_did
    || saved.top.organisation !== (first.organisation ?? null) || !same(saved.ranking, p.value.ranking) || !same(saved.approval, request.approval)
    || !isObject(saved.by) || saved.by.kind !== 'token' || !logActor({ ...saved.by, credential: saved.by.kind }, auth.value, [auth.value.sourcing], auth.value.delegation.id)
    || !logAt({ at: saved.recorded_at }, started, ended) || calls.length !== 1
    || !calls.some((line) => line.decision === 'allowed' && line.status === 201)) return 'execute: the approved write, its actor and the stored rank are not proven';
  return [...hireRefs(h), ref('ranking', write.ref)];
}

function proofRefs<T>(evidence: Proof<T> | undefined, convert: (value: T) => readonly Ref[]): Shown {
  if (evidence === undefined) return 'the run does not contain this hire';
  return evidence.ok ? convert(evidence.value) : evidence.why;
}

const RULES: EvidenceModule['rules'] = {
  'r1-01': (a) => proofRefs(get(a).authority, (x) => [ref('delegation', x.delegation.id), ref('transaction', x.delegation.tx), ref('vault', x.vaultRoot), ref('transaction', x.vault.open_tx)]),
  'r1-02': (a) => proofRefs(get(a).proposals.get('propose'), (p) => hireRefs(p.hire)),
  'r1-03': (a) => proofRefs(get(a).bidderEvidence, (refs) => refs),
  'r1-04': (a) => proofRefs(get(a).quotes.get('propose'), (quotes) => quotes.flatMap((q) => [
    ...hireRefs(q.hire), ref('escrow', q.quoteDecision), ref('escrow', q.acceptDecision),
  ])),
  'r1-05': (a) => proofRefs(get(a).scores.get('propose'), (refs) => refs),
  'r1-06': (a) => {
    const approval = approvalOf(a);
    return approval === null ? 'the committed request does not use one active approval for this proposal' : [ref('attestation', approval.entry.attestation), ref('transaction', approval.entry.tx)];
  },
  'r1-07': (a) => execution(a, 'propose', 'execute'),
  'r1-08': (a) => {
    const auth = get(a).authority;
    if (!auth.ok) return auth.why;
    const v = auth.value.vault;
    const d = auth.value.delegation;
    return v.state !== 'closed' || v.close_tx === null || d.state !== 'ended' || d.ended_tx === null
      ? 'the run vault is not closed, or the run delegation is not ended' : [ref('transaction', v.close_tx), ref('transaction', d.ended_tx)];
  },
  'r2-a': (a) => proofRefs(get(a).challenge, (q) => [
    ...hireRefs(q.hire), ref('claim', q.challenge!.claim), ref('transaction', q.challenge!.evidence), ref('challenge', q.challenge!.challenge),
  ]),
  'r2-a-release': (a) => {
    const { challenge, release } = get(a);
    return !challenge.ok ? challenge.why : proofRefs(release, (r) => [ref('escrow', challenge.value.hire.entry.escrow_ref), ref('transaction', r.tx)]);
  },
  'r2-a-hold': (a) => {
    const c = a.caseRead;
    if (!get(a).challenge.ok) return 'the quote challenge is unproven';
    if (c?.verdict == null) return 'the case has no proven verdict';
    if (c.verdict !== 'AuditorWins') return 'the jury did not decide AuditorWins; the run needs a new claim and a new challenge';
    if (c.hold === null || c.indexed?.finalized_tx == null) return 'no verified application of this case verdict';
    return [ref('case', c.indexed.case_token), ref('transaction', c.indexed.finalized_tx), ref('hold', c.hold.record_output)];
  },
  'r2-b': (a) => {
    const read = get(a).compliance;
    const p = get(a).proposals.get('propose-b');
    const hold = a.caseRead?.hold;
    const file = p?.ok ? p.value.bidders.find(({ agent }) => agent.id === a.loaded.record.challenged)?.compliance : undefined;
    const posted = p?.ok ? at(a, p.value.hire.entry.post_tx) : undefined;
    if (!read.ok) return read.why;
    if (!p?.ok || !file || !hold || posted === undefined || read.value.contested_at > posted || posted >= hold.since
      || read.value.revoked_at >= hold.since || read.value.contested_at >= hold.since || file.state !== 'invalid' || file.attestation_state !== 'revoked'
      || file.attestation !== read.value.attestation || file.revoke_reason !== String(read.value.reason) || !isObject(file.contested) || file.contested.sha256 !== read.value.reply_sha256) {
      return 'compliance: the signed bidder file does not show this pre-hold revocation and reply';
    }
    return [...hireRefs(p.value.hire), ref('attestation', read.value.attestation), ref('transaction', read.value.issue_tx), ref('transaction', read.value.revoke_tx), ref('transaction', read.value.contest_tx)];
  },
  'r2-c': (a) => {
    const p = get(a).proposals.get('propose-c');
    const q = get(a).quotes.get('propose-c');
    const listed = get(a).listing;
    const hold = a.caseRead?.hold;
    if (!listed.ok) return listed.why;
    if (!p?.ok || !q?.ok || hold == null) return 'listing: the held RFQ, its quote jobs or the exact hold are unproven';
    if (!get(a).scores.get('propose-c')?.ok) return 'listing: the ranked quote scores are unproven';
    const post = at(a, p.value.hire.entry.post_tx);
    const submitted = a.receiptAttributions.get(p.value.hire.entry.escrow_ref)?.submitted_at_ms;
    if (post === undefined || submitted === undefined || post < hold.since || post >= hold.until || submitted >= hold.until
      || p.value.ranking.ranked.length !== desks(a.use).length - 1
      || p.value.bidders.length !== p.value.ranking.ranked.length || p.value.bidders.some(({ agent }) => agent.id === a.loaded.record.challenged)) {
      return 'listing: the proposal does not show the other desks only during the hold';
    }
    return [...hireRefs(p.value.hire), ref('hold', hold.record_output)];
  },
  'r2-d': (a) => execution(a, 'propose-d', 'execute-d'),
  'r2-e': (a) => {
    const { revocation, challenge } = get(a);
    if (!revocation.ok) return revocation.why;
    const hold = a.caseRead?.hold;
    const posted = challenge.ok ? at(a, challenge.value.hire.entry.post_tx) : undefined;
    if (!hold || hold.record_output !== revocation.value.spent_output || revocation.value.at <= hold.since || posted === undefined
      || revocation.value.invalid_from > posted) return 'revocation: the tombstone does not follow this hold or its invalid_from does not cover the faulty quote post';
    return [ref('transaction', revocation.value.tx), ref('record', revocation.value.record_output)];
  },
};

function faultProblems(a: Assembly): Array<{ member: string; detail: string }> {
  const issues: Array<{ member: string; detail: string }> = [];
  if (!get(a).orderedRfqs) issues.push({ member: 'rfq_ids', detail: 'the ids are not in the order of the corresponding signed proposals' });
  if (a.loaded.record.kind !== 'failure') return issues;
  const supplier = a.loaded.record.challenged;
  const quoteStart = named(a, 'quote-a1');
  const target = a.use.agents.find(({ id }) => id === supplier);
  const buyer = sourcing(a.use);
  const faults = [
    { entry: quoteStart, agent: target, mode: QUOTE_FAULT },
    { entry: named(a, 'propose-d'), agent: buyer, mode: RANK_FAULT },
  ];
  for (const { entry, agent, mode } of faults) {
    if (!entry || !agent) continue; // A failure file can describe a phase that did not run.
    const post = at(a, entry.entry.post_tx);
    const check = post === undefined ? undefined : a.faults.filter((f) => f.atMs <= post).sort((x, y) => y.atMs - x.atMs)[0];
    if (!check?.ok || check.check !== mode || check.agent !== agent.id
      || !check.services.some((service) => service.service === agent.serviceContainer && service.value === mode)) {
      issues.push({ member: 'fault_check', detail: `no passing ${mode} entry before the related hire` });
    }
  }
  for (const h of a.loaded.hires) {
    if (h.report === null || h.role === 'execute') continue;
    const expected = h.entry.step === 'propose-d' ? RANK_FAULT : h.role === 'quote' && h.entry.agent === supplier && /^quote-a[1-9]$/.test(h.entry.step) ? QUOTE_FAULT : '';
    if (h.result.fault_mode !== expected) issues.push({ member: `hires[${h.index}].report_file`, detail: 'the fault_mode does not match this phase and agent' });
  }
  return issues;
}

function moduleDocument(a: Assembly): Readonly<Obj> & { readonly run: string } {
  const read = get(a);
  const proposals = [...read.proposals.values()].flatMap((p) => p.ok ? [p.value] : []);
  const quoteGroups = [...read.quotes.entries()].filter(([, group]) => group.ok);
  const approval = approvalOf(a);
  const challenged = a.loaded.record.challenged;
  const claims = a.facts.claims[a.loaded.record.label] ?? {};
  const fault = proposals.find(({ hire }) => hire.entry.step === 'propose-d')?.hire.result.fault_mode;
  const issuer = a.committedExecutes.get('execute')?.approval?.issuer_did;
  const routeEvidence: readonly PublicRouteEvidence[] = [
    { step: 'r1-05', route: READ_VENDORS, credential: 'token', decision: 'allowed', act_links: 2, count: a.use.subagents.filter(({ parent }) => parent === sourcing(a.use)?.id).length },
    { step: 'r1-07', route: WRITE_RANKING, credential: 'token', decision: 'allowed', act_links: 1, count: 1 },
    { step: 'r2-d', route: WRITE_RANKING, credential: 'token', decision: 'refused', act_links: 1, count: 1 },
  ];
  return {
    run: `use-case-3-${a.loaded.record.kind}`,
    claims: Object.fromEntries(a.use.agents.flatMap(({ id }) => {
      const c = claims[id];
      return c === undefined ? [] : [[id, { claim_ref: c.claimRef, document_tx: c.documentTx, claim_tx: c.claimTx, claim_token: c.claimToken,
        stake_lovelace: c.stakeLovelace, window_ms: c.windowMs, staked_at: c.stakedAt, withdrawable_from: c.withdrawableFrom, withdraw_tx: c.withdrawTx }]];
    })),
    fault_mode: Object.fromEntries(a.use.agents.map(({ id, kind }) => [id, kind === 'sourcing-agent' && fault === RANK_FAULT ? RANK_FAULT : challenged === id && read.challenge.ok ? QUOTE_FAULT : ''])),
    rfq_ids: proposals.map((p) => p.ranking.rfq_id),
    bidders: proposals.map((p) => ({ step: p.hire.entry.step, files: p.bidders.map((b) => ({
      did: b.did, advert_ref: b.advert, status: b.status, in_catalog: b.inCatalog, compliance_state: b.compliance.state, file_sha256: b.sha256,
    })) })),
    quotes: quoteGroups.flatMap(([step, checked]) => checked.ok ? checked.value.map((q) => ({
      step: q.hire.entry.step, propose: step, desk_did: q.desk.did, escrow_ref: q.hire.entry.escrow_ref, vault_ref: q.vault,
      accepted: q.accept !== null, reason: q.challenge === null ? null : 'disputed',
      challenge: read.challenge.ok && read.challenge.value.hire.entry.escrow_ref === q.hire.entry.escrow_ref ? q.challenge : null,
      receipt_sha256: q.receiptHash, quote_sha256: q.hire.sha256, total: q.result.total, lead_time_days: q.result.lead_time_days,
    })) : []),
    rankings: proposals.filter((p) => read.quotes.get(p.hire.entry.step)?.ok).map((p) => ({
      step: p.hire.entry.step, rfq_id: p.ranking.rfq_id, rfq_sha256: p.ranking.rfq_sha256, proposal_digest: p.digest,
      ranked: p.ranking.ranked.map(({ rank, desk_did, quote }) => ({ rank, desk_did, ...quote })),
      excluded: p.ranking.excluded,
    })),
    approvals: approval && issuer ? [{ attestation: approval.entry.attestation, tx: approval.entry.tx, issuer_did: issuer, subject: approval.subject,
      digest: approval.digest, issued_at: approval.issued_at, valid_until: approval.valid_until, checked_at: approval.checked_at, hire: approval.hire }] : [],
    outcomes: a.loaded.hires.flatMap((h) => h.role === 'execute' && h.report !== null ? [{ step: h.entry.step, escrow_ref: h.entry.escrow_ref, ...projectPublicResult(h).fields }] : []),
    compliance: Array.isArray(RULES['r2-b']!(a)) && read.compliance.ok ? read.compliance.value : null,
    revocation: Array.isArray(RULES['r2-e']!(a)) && read.revocation.ok ? read.revocation.value : null,
    resolutions: read.revocation.ok && challenged !== null ? [{ did: didOf(a, challenged), status: 'revoked', deactivated: true }] : [],
    release: read.release.ok && read.challenge.ok ? { action: 'Release', escrow_ref: read.challenge.value.hire.entry.escrow_ref,
      tx: read.release.value.tx, spent_output: read.release.value.spent_output, at: read.release.value.at } : null,
    route_evidence: routeEvidence.filter(({ step }) => (a.loaded.record.kind === 'clean' ? step.startsWith('r1-') : step.startsWith('r2-')) && Array.isArray(RULES[step]!(a))),
  };
}

function projectPublicResult(h: ReportedHire): PublicResultProjection {
  const fields: Record<string, PublicResultProjection['fields'][string]> = {};
  if (h.role === 'execute') {
    if (h.result.outcome === 'completed' || h.result.outcome === 'refused_by_system' || h.result.outcome === 'failed') fields.outcome = h.result.outcome;
    if (h.result.reason === 'approval_not_found' || h.result.reason === null) fields.reason = h.result.reason;
    if (h.result.exit_state === 'Completed' || h.result.exit_state === 'Rejected' || h.result.exit_state === 'Failed') fields.exit_state = h.result.exit_state;
    if (typeof h.result.proposal_digest === 'string' && HASH.test(h.result.proposal_digest)) fields.proposal_digest = h.result.proposal_digest;
    return { fields, decisionNames: [] };
  }
  return { fields, decisionNames: h.role === 'quote' ? ['quote'] : ['shortlist', 'accept_quote', 'score', 'ranking'] };
}

/** A separate part can add the lifecycle rules without changing the other runs. */
export interface BidEvidencePart {
  readonly runKinds: readonly RunKind[];
  readonly rules: EvidenceModule['rules'];
  readonly lifecycleFacts?: EvidenceModule['lifecycleFacts'];
  readonly hosted: readonly string[];
  prepare: EvidenceModule['prepare'];
  moduleDocument: EvidenceModule['moduleDocument'];
}

const RUNS: BidEvidencePart = { runKinds: ['clean', 'failure'], rules: RULES, hosted: [LIST, RESOLVE], prepare: prepareBids, moduleDocument };
const PARTS: readonly BidEvidencePart[] = [RUNS];
function partFor(a: Assembly): BidEvidencePart {
  const part = single(PARTS, (candidate) => candidate.runKinds.includes(a.loaded.record.kind));
  need(part, 'the evidence module has no unique part for this run');
  return part;
}

export const bidEvaluation: EvidenceModule = {
  runKinds: [...new Set(PARTS.flatMap((part) => part.runKinds))],
  rules: Object.assign({}, ...PARTS.map((part) => part.rules)),
  lifecycleFacts: Object.assign({}, ...PARTS.map((part) => part.lifecycleFacts ?? {})),
  hireRoles: HIRE_ROLES,
  agentOf: (role) => role === 'quote' ? desks(data).map(({ id }) => id) : role === 'propose' || role === 'execute' ? data.agents.filter(({ kind }) => kind === 'sourcing-agent').map(({ id }) => id) : [],
  allowRfqs: true,
  reportOptional: [],
  reportSchemas: BID_REPORT_SCHEMAS,
  carriedOf: (hires) => lastHire(hires, 'execute')?.entry ?? null,
  challengeOf,
  holdOf(a, source) {
    if (source.indexed?.finalized_result !== 'AuditorWins') return null;
    const hold = get(a).hold;
    if (!hold.ok) throw new PreconditionError(hold.why);
    return hold.value;
  },
  hireOfApproval(a, index) {
    const entry = a.loaded.record.approvals[index];
    if (entry === undefined || entry.role !== 'approval' || a.loaded.record.kind !== 'clean' || a.loaded.record.approvals.length !== 1) return null;
    const execute = named(a, 'execute');
    const request = a.committedExecutes.get('execute');
    return execute && request?.escrow_ref === execute.entry.escrow_ref && request?.approval?.attestation === entry.attestation ? execute.entry.step : null;
  },
  approvalExpectations(a) {
    const auth = get(a).authority;
    const p = get(a).proposals.get('propose');
    need(auth.ok && p?.ok, 'the signed proposal and root delegation are unproven');
    const owner = auth.value.principal;
    return { digest: p.value.digest, maxValidityMs: RUN_APPROVAL_VALIDITY_MS,
      issuer: owner.type === 'PrincipalKey' ? { type: 'key_hash', hash: owner.hash } : { type: 'did', id: owner.id } };
  },
  claimAgents: (a) => a.use.agents.map(({ id }) => id),
  faultProblems,
  hosted: [...new Set(PARTS.flatMap((part) => part.hosted))],
  prepare: (s, a) => partFor(a).prepare(s, a),
  mockRoutes: [READ_VENDORS, WRITE_RANKING],
  counts(state) {
    const rows = rankingRows(state);
    return rows === null ? null : { rankings: rows.length };
  },
  moduleDocument: (a) => partFor(a).moduleDocument(a),
  projectPublicResult,
};
