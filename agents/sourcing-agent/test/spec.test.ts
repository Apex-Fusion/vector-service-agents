// agents/sourcing-agent/test/spec.test.ts
// specs/sourcing-agent.md is the public page of the agent, and the manifest links to its Response section. These tests hold the page to the code and to the deploy pack: the status, the identity rows, the
// numbers of the terms and the windows, the request limit, the request fields of the schema that the manifest publishes, the example requests and the example proposal (made here with the real `runPropose` over
// scripted ports), the steps of the two jobs and the codes that they name, the file of a bidder (made with the real reader), and the ranking. The tests read the page, the manifest, the env example, the compose
// file of the pack and some source files, and no network. The test of the headings holds the thirteen headings of the page and the seven sub-headings of Interface.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { parse } from 'yaml';
import { ACCEPT_WINDOW_MS, HIRE_ACTION, narrowingProblems } from '@vsa/buyer-core';
import { DECISION_WINDOW_MS } from '@vsa/hire-kit';
import { MAX_BODY, RESERVATION_MS, parseWire } from '@vsa/service-kit';
import { CONFIRMATIONS_REQUIRED, GATEWAY_FAILURES, MIN_SUB_DELEGATION_MS, SUB_DELEGATION_FAILURES, tokenTarget } from '@vsa/usecase-kit/access';
import {
  BID_CAPABILITIES, BID_DESK_CLAIM, BID_DESK_MODEL, EXCLUDED_REASONS, MAX_ITEM_QUANTITY, MAX_RFQ_ITEMS, QUOTE_SCHEMA, SCORE_COMPONENTS, SOURCING_CLAIM, SOURCING_MODEL, WEIGHT_NAMES, buildRanking, parsePriceList, parseQuote,
  parseRanking, priceFor,
  priceListSha256, quoteTotals, receiptSha256, rfqSha256,
} from '@vsa/usecase-kit/bids';
import type { ExcludedEntry, PriceList, Quote, RankedEntry } from '@vsa/usecase-kit/bids';
import { COUNTERPARTY_REFUSED, EARLIER_PAY_MAY_LAND, INCONSISTENT_OUTCOME, INTERRUPTION_REASONS, PAY_UNCONFIRMED, checkRuntimeBody, checkWirePayload } from '@vsa/usecase-kit/buyer';
import type { VerifiedDelivery } from '@vsa/usecase-kit/buyer';
import { readAnswer } from '../../../packages/usecase-kit/src/decision/answer.ts';
import { COSIGN_SETTINGS, COSIGN_STATUS, parseAllowlist, parseCosignSettings } from '@vsa/usecase-kit/cosign';
import { HIRE_MIN_MS } from '@vsa/usecase-kit/decision';
import { readFaultSwitch, withFaultMode } from '@vsa/usecase-kit/fault';
import {
  APPROVAL_ATT_TYPE, APPROVAL_DEPOSIT_LOVELACE, COSIGN_ROUTE, COSIGN_RULE, COUNTERPARTY_REFUSALS, ERROR_STATUS, EXECUTE_OUTCOMES, EXIT_STATES, FAULT_MODES, MAX_REQUEST_BYTES, PROPOSE_OUTCOMES, RECEIPT_CHECKS,
  RUNTIME_BODY_LIMIT_BYTES, agentIdOf, canonicalJson, exitStateOf, parseProposal, parseRequest, proposalDigest,
} from '@vsa/usecase-kit/protocol';
import type { Decision, Did, ExecuteOutcome, JsonObject, JsonValue, ProtocolResult, ReceiptVerification, SubJob } from '@vsa/usecase-kit/protocol';
import { wirePayloadFor } from '@vsa/vector-read';
import { CLAIM_STAKE_LOVELACE, CLAIM_WINDOW_MS, RUN_APPROVAL_VALIDITY_MS } from '../../../scripts/operator/lib/claim-constants.ts';
import { USE_CASE_NAMES } from '../../../scripts/operator/usecases/names.ts';
import { MAX_CANDIDATES, readBidders } from '../src/bidders/index.ts';
import type { BidderFile, BidderView } from '../src/bidders/index.ts';
import { EXECUTE_DEADLINE_MS, EXECUTE_FAILURES } from '../src/execute/index.ts';
import { ACCEPT_QUOTE_DECISION, MAX_INVITED, RANKING_DECISION, SCORE_DECISION, SHORTLIST_DECISION, acceptQuoteInput, parseProposeFields, rankingInput, scoreInput, shortlistInput } from '../src/model/index.ts';
import { bidderFacts } from '../src/model/bidder.ts';
import { EFFECTIVE_REASONS } from '../src/bidders/lineage.ts';
import { PROPOSE_DEADLINE_MS, PROPOSE_FAILURES, ProposeRefusal, RANKING_RESERVE_MS, SCORING_RESERVE_MS, runPropose } from '../src/propose/index.ts';
import type { ProposeDeps, ProposeRequest, QuoteRecord } from '../src/propose/index.ts';
import { rankingOf } from '../src/propose/ranking.ts';
import { BID_DESK_REFUSALS, CHALLENGE_CODES, CODE, NOT_ACTIVE_STATUSES } from '../src/quotes/ports.ts';
import { judgeQuote } from '../src/quotes/decide.ts';
import { QUOTE_CODES, QUOTE_HIRE_RESERVE_MS } from '../src/quotes/index.ts';
import { SCORER_JOB_TIMEOUT_MS, SCORER_NEED_MS, SCORERS_NEED_MS, SCORING_FAILURES, SUB_DELEGATION_VALID_MS } from '../src/scoring/index.ts';
import { reversedOf, scoreFaultOf } from '../src/scoring/fault.ts';
import { ADVERT_GAP, CANDIDATES_GAP, CHALLENGE_GAP, KEYS_GAP, NOT_SHOWN_GAP, QUOTE_TEXT_GAP, gapsFor } from '../src/serve/gaps.ts';
import { DESCRIPTION, ID_CHARS, REQUEST_SCHEMA, TEMPLATE_ENV, manifestFromEnv } from '../src/serve/manifest.ts';
import { RequestRefusal, parseJob } from '../src/serve/server.ts';
import {
  BUYER_BOND_LOVELACE, JOB_DEADLINE_MS, MIN_PROCESSING_WINDOW_MS, PRICE_DEFAULT_LOVELACE, SUPPLIER_BOND_LOVELACE, module1SourceOf, priceOf, processingWindowOf, scorerDidsOf, supplierKeyOf,
} from '../src/serve/settings.ts';
import { SETTINGS } from '../src/serve/start.ts';
import { STATE_FILES } from '../src/serve/wiring.ts';
import { ACCOUNTABLE, DESKS, PARTY_SINCE, addDesk, advertOf, deskOf, extraDesk, goldenWorld, manifestText, metadataOf, ok, priceListText, resolvedOf, revokedCompliance, revokedOf, rowOf, stubOf } from './bidders/support.ts';
import type { Desk } from './bidders/support.ts';
import { ALFA as GOLDEN_ALFA, BRAVO as GOLDEN_BRAVO, CHARLIE as GOLDEN_CHARLIE, NOW as PROPOSE_NOW, acceptedOf, excludedOf, fanOf, fileOf as goldenFileOf, proposed, rankAnswer, shortlistAnswer, viewOf as goldenViewOf, world } from './propose/support.ts';
import * as quoteSupport from './quotes/support.ts';
import * as quoteWorld from './quotes/world.ts';
import { NOW as SCORING_NOW } from './scoring/support.ts';
import { UNTOUCHED, footprint as executeFootprint, words as executeWords, world as executeWorld } from './execute/world.ts';
import { janitorOnce, world as scoringWorld } from './scoring/world.ts';

const root = new URL('../../../', import.meta.url);
const text = (path: string): string => readFileSync(new URL(path, root), 'utf8');
const page = text('specs/sourcing-agent.md');
const readme = text('agents/sourcing-agent/README.md');
const runbook = text('deploy/server/RUNBOOK-sourcing-agent.md');
const envExample = text('deploy/server/.env.sourcing-agent.example');
const compose = parse(text('deploy/server/docker-compose.sourcing-agent.yml')) as { services: { runtime: { environment: Record<string, string> } } };
const runtimeEnv = compose.services.runtime.environment;

const section = (heading: string): string => (page.split(`\n## ${heading}\n`)[1] ?? '').split('\n## ')[0];
const sub = (heading: string): string => (page.split(`\n### ${heading}\n`)[1] ?? '').split(/\n##+ /)[0];
const row = (table: string, label: string): string => table.split('\n').find((line) => line.startsWith(`| ${label} |`)) ?? '';
const envLine = (name: string): string | undefined => envExample.split('\n').find((line) => line.startsWith(`${name}=`))?.substring(name.length + 1);
const manifest = manifestFromEnv({ ...TEMPLATE_ENV });

/** The day of the page. The status line of the page and of its entry in the list of pages hold it, and it is the default status date of the manifest. */
const PAGE_DATE = '2026-11-24';
const STATUS_LINE = `PROPOSED (built, not deployed). Since ${PAGE_DATE}.`;

describe('specs/sourcing-agent.md', () => {
  test('the page has the thirteen headings of its profile in order, and Interface has the seven sub-headings that the tests below read', () => {
    expect([...page.matchAll(/^## (.+)$/gm)].map((hit) => hit[1])).toStrictEqual([
      'Status', 'Identity', 'Capability id', 'Terms', 'Interface', 'What the receipt commits to', 'Claim statements', 'Fault switch', 'Operator and data handling', 'Known gaps', 'How to hire it', 'Changelog', 'Links',
    ]);
    expect([...page.matchAll(/^### (.+)$/gm)].map((hit) => hit[1])).toStrictEqual(['Request', 'Response', 'The bidder file', 'The ranking', 'Outcomes', 'Errors', 'The co-sign route']);
  });

  test('the opening line, the capability, the model string and the status are the manifest and the pack', () => {
    expect(page.startsWith('# Sourcing Agent\n')).toBe(true);
    expect(manifest.name).toBe('Sourcing Agent');
    expect(page.split('\n')[2]).toBe(`Capability \`${manifest.capability_id}\`. ${manifest.description}`);
    expect(manifest.description).toBe(DESCRIPTION);
    expect(manifest.capability_id).toBe(BID_CAPABILITIES.evaluate);
    expect(section('Capability id').split('\n')[1]).toBe(`\`${manifest.capability_id}\``);
    expect(SOURCING_MODEL).toBe('sourcing-agent-v1');
    expect(section('Capability id')).toContain('The model string in the advert and in every receipt is `sourcing-agent-v1`.');
    expect(row(runbook, 'Sourcing')).toContain('| `sourcing-agent-v1` |');
    expect(manifest.status).toStrictEqual({ chip: 'proposed', since: PAGE_DATE });
    expect(STATUS_LINE.startsWith(`${manifest.status.chip.toUpperCase()} (`)).toBe(true);
    expect(section('Status').split('\n')).toContain(STATUS_LINE);
    expect(section('Status')).toContain('\nNothing on this page is LIVE or DEPLOYED.\n');
  });

  test('the runtime and the service: one runtime in front, nine keys in the service, no API key, and a check before the Claim', () => {
    const capability = section('Capability id');
    expect(runtimeEnv.CAPABILITY_KIND).toBe('custom');
    expect(capability).toContain('`CAPABILITY_KIND=custom`');
    expect(runtimeEnv.SERVICE_PRECHECK_URL.endsWith('/precheck')).toBe(true);
    expect(capability).toContain('The runtime asks the service whether to take the job, claims the escrow, calls the service, signs the receipt and submits its hash.');
    // The runtime asks the service before it claims the escrow: the shared server describes `POST /precheck` as the question that the runtime asks before it claims an escrow, and the compose file calls its URL the check before the Claim.
    expect(text('packages/service-kit/src/server.ts')).toContain('the question the runtime asks before it claims an escrow');
    expect(text('deploy/server/docker-compose.sourcing-agent.yml')).toContain('SERVICE_PRECHECK_URL is the check before the Claim.');
    const keys = SETTINGS.filter((name) => name.endsWith('_PRIV_KEY_HEX'));
    expect(keys).toHaveLength(9);
    expect(capability).toContain('It holds nine keys and no API key of any third party.');
    expect(SETTINGS.filter((name) => name.includes('API'))).toStrictEqual([]);
    expect(keys).not.toContain('SUPPLIER_PRIV_KEY_HEX');
    expect(capability).toContain('It does not hold the supplier key: it knows only its key hash and its public key.');
    for (const name of keys) expect(runtimeEnv[name], name).toBe('');
    expect(capability).toContain('The agent is a buyer. It hires a model supplier on the Vector marketplace for each decision, and it hires the Bid Desks that the model invites for their quotes.');
  });

  test('the Identity section says that the agent has no record, and its rows are the keys and the settings of the service', () => {
    const identity = section('Identity');
    expect(identity).toContain('\nThis agent has no registry record yet.\n');
    expect(identity).toContain('A value that the registration fixes reads "assigned at registration".');
    expect(row(identity, 'DID')).toBe('| DID | assigned at registration. The service reads it from `AGENT_DID`, and the manifest gives it as `identity.did` |');
    expect(SETTINGS).toContain('AGENT_DID');
    expect(Object.keys(manifest.identity)).toStrictEqual(['did', 'registry_address', 'supplier_key']);
    expect(row(identity, 'Controller').startsWith('| Controller | a controller key of this deployment.')).toBe(true);
    // The keys: the supplier key is the runtime's and only its two public values reach the service, which stops when they are not a pair.
    expect(Object.keys(manifest.keys)).toStrictEqual(['supplier_pkh', 'pub_key_hex', 'service_pkh', 'delegation_pkhs', 'compliance_issuer_pkh']);
    const supplier = row(identity, 'Supplier key');
    for (const member of ['keys.supplier_pkh', 'keys.pub_key_hex']) expect(supplier).toContain(`\`${member}\``);
    expect(supplier).toContain('The service never holds it.');
    expect(supplier).toContain('The service does not start unless the public key hashes to the key hash');
    expect(() => supplierKeyOf({ SUPPLIER_PKH: 'aa'.repeat(28), SUPPLIER_PUB_KEY_HEX: 'bb'.repeat(32) })).toThrow('is not the public key of SUPPLIER_PKH');
    expect(row(identity, 'Service key')).toContain('The manifest publishes its key hash as `keys.service_pkh`');
    expect(manifest.keys.service_pkh).toBe(TEMPLATE_ENV.SOURCING_SERVICE_PKH);
    const delegation = row(identity, 'Delegation keys');
    expect(delegation.startsWith('| Delegation keys | two keys,')).toBe(true);
    expect(delegation).toContain('`keys.delegation_pkhs`');
    expect(manifest.keys.delegation_pkhs).toHaveLength(2);
    // The delegation key pays and accepts each quote hire, and the service key pays the model hires: each key has one lane.
    const wiring = text('agents/sourcing-agent/src/serve/wiring.ts');
    expect(delegation).toContain('pays each quote hire from the vault of the delegation, accepts each accepted quote');
    expect(wiring).toContain('its lane runs the vault Pay and the Accept of each quote hire');
    expect(wiring).toContain('so its lane runs the model hires');
    expect(delegation).toContain('Each key has a wallet of its own, and a key runs one hire at a time');
    // The three scorers are subagents with two keys each: the other six of the nine.
    const subagents = row(identity, 'Subagents');
    expect(subagents).toContain('`scorer-1`, `scorer-2` and `scorer-3`');
    expect(subagents).toContain('which are the other six keys of the service');
    expect(SETTINGS.filter((name) => /^SCORER_[123]_(AUTH|DELEGATION)_PRIV_KEY_HEX$/.test(name))).toHaveLength(6);
    for (const name of ['SCORER_1_DID', 'SCORER_2_DID', 'SCORER_3_DID']) {
      expect(SETTINGS).toContain(name);
      expect(subagents).toContain(`\`${name}\``);
    }
    const dids = { AGENT_DID: `did:vector:${'a1'.repeat(32)}`, SCORER_1_DID: `did:vector:${'b1'.repeat(32)}`, SCORER_2_DID: `did:vector:${'b2'.repeat(32)}`, SCORER_3_DID: `did:vector:${'b3'.repeat(32)}` };
    expect(scorerDidsOf(dids)).toHaveLength(3);
    expect(() => scorerDidsOf({ ...dids, SCORER_2_DID: dids.AGENT_DID })).toThrow('a scorer is an agent of its own');
    expect(() => scorerDidsOf({ ...dids, SCORER_3_DID: dids.SCORER_1_DID })).toThrow('each scorer is an agent of its own');
    expect(subagents).toContain('The service does not start when a scorer is this agent or when two scorers are one agent');
    // The organisation is a domain with the description of the demonstration.
    expect(row(identity, 'Organisation')).toBe('| Organisation | the domain `echo.vector.apexfusion.org`, with the description "Demonstration organisation run by the Apex Fusion Foundation". The identity gateway verifies the domain with a DNS TXT record |');
    expect(row(identity, 'Parties')).toContain('Guardians: the guardian key of the organisation and a controller key of this deployment, with threshold 2');
    expect(row(identity, 'Reputation stake')).toBe('| Reputation stake | a Module-3 self-stake on the capability, owned by the service key |');
  });

  test('the Claim row says that no command stakes a claim for this agent: no source of the service stakes one, and no file of the operator pack names the agent', () => {
    expect([CLAIM_STAKE_LOVELACE, CLAIM_WINDOW_MS]).toStrictEqual([50_000_000n, 86_400_000]);
    expect(row(section('Identity'), 'Claim')).toBe(
      `| Claim | a Module-1 claim for each run. The service stakes none. No command of this repository stakes a claim for this agent yet. Until one does, a challenge against it ends with \`no_open_claim\`. The design is that the operator stakes the claim with the service key before each run, once such a command exists: ${CLAIM_STAKE_LOVELACE / 1_000_000n} units, which is ${CLAIM_STAKE_LOVELACE} lovelace, with a challenge window of ${CLAIM_WINDOW_MS / 3_600_000} hours. The operator then withdraws it after the window, when nobody challenged it. See Claim statements |`,
    );
    // No code of the service calls the staking of a claim: the kit has the call, and the sources of the agent do not.
    expect(text('packages/usecase-kit/src/dispute/dispute.ts')).toContain('async stakeRunClaim(input: RunClaimInput)');
    const sourceDir = new URL('agents/sourcing-agent/src/', root);
    const sources = (readdirSync(sourceDir, { recursive: true }) as string[]).map(String).filter((file) => file.endsWith('.ts'));
    expect(sources.length).toBeGreaterThan(30);
    expect(sources.filter((file) => readFileSync(new URL(file, sourceDir), 'utf8').includes('stakeRunClaim'))).toStrictEqual([]);
    // No command of this repository stakes a claim for this agent: the operator pack loads the use case `inventory-reorder` only, and no file of the pack that is not a test names this agent, its capability, its claim or its use case.
    // A command that does must change this page.
    expect(USE_CASE_NAMES).toStrictEqual(['inventory-reorder']);
    const packDir = new URL('scripts/operator/', root);
    const pack = (readdirSync(packDir, { recursive: true }) as string[]).map(String).filter((file) => file.endsWith('.ts') && !file.startsWith('test/') && !file.includes('node_modules'));
    expect(pack.length).toBeGreaterThan(5);
    expect(pack.filter((file) => /sourcing|supplychain\.rfq|bid-evaluation/i.test(readFileSync(new URL(file, packDir), 'utf8')))).toStrictEqual([]);
  });

  test('the public URL of the identity table is the origin of the runtime in the compose file of the pack', () => {
    expect(row(section('Identity'), 'Public URL')).toBe(`| Public URL | planned: \`${runtimeEnv.PUBLIC_ORIGIN}\`, the origin of the runtime in the pack. The agent has no advert yet |`);
    expect(new URL(runtimeEnv.PUBLIC_ORIGIN).protocol).toBe('https:');
  });

  test('the Terms tables carry the numbers of the manifest, of the code and of the pack', () => {
    const terms = section('Terms');
    const t = manifest.terms;
    expect([t.price_lovelace, t.supplier_bond_lovelace, t.buyer_bond_lovelace]).toStrictEqual([PRICE_DEFAULT_LOVELACE, SUPPLIER_BOND_LOVELACE, BUYER_BOND_LOVELACE]);
    expect(row(terms, 'Price')).toBe(`| Price | ${t.price_lovelace} | 3.000000 |`);
    expect(row(terms, 'Supplier bond')).toBe(`| Supplier bond | ${t.supplier_bond_lovelace} | 1.000000 |`);
    expect(row(terms, 'Buyer bond')).toBe(`| Buyer bond | ${t.buyer_bond_lovelace} | 1.000000 |`);
    const locked = t.price_lovelace + t.supplier_bond_lovelace + t.buyer_bond_lovelace;
    expect(locked).toBe(5_000_000);
    expect(row(terms, 'Locked by the buyer (price and both bonds)')).toBe(`| Locked by the buyer (price and both bonds) | ${locked} | 5.000000 |`);
    expect(terms).toContain('Amounts are `lovelace` fields. The last column is the same amount divided by 1,000,000, with six decimals.');
    // The price is the default of the setting, the bonds are constants, and the env example has the same price. The runbook lists the same price, bonds and lock in units.
    expect(priceOf({})).toBe(PRICE_DEFAULT_LOVELACE);
    expect(envLine('ADVERT_PRICE_LOVELACE')).toBe(String(PRICE_DEFAULT_LOVELACE));
    expect(row(runbook, 'Sourcing')).toContain('| 3 | 1 and 1 | 5 |');
    expect(terms).toContain('The price is the default of `ADVERT_PRICE_LOVELACE`. Each bond is fixed in the code. The manifest publishes the three amounts in `terms`.');
  });

  test('the three times: the window of the advert, the timeout of the runtime and the deadline of a job are the code, the compose file and the env example', () => {
    const terms = section('Terms');
    const timeout = Number(runtimeEnv.SERVICE_TIMEOUT_MS);
    expect([MIN_PROCESSING_WINDOW_MS, timeout, JOB_DEADLINE_MS, EXECUTE_DEADLINE_MS]).toStrictEqual([5_400_000, 5_280_000, 5_220_000, 120_000]);
    expect(manifest.terms.max_processing_ms).toBe(MIN_PROCESSING_WINDOW_MS);
    expect(processingWindowOf({})).toBe(MIN_PROCESSING_WINDOW_MS);
    expect(Number(runtimeEnv.ADVERT_MAX_PROCESSING_MS)).toBe(MIN_PROCESSING_WINDOW_MS);
    expect(Number(envLine('ADVERT_MAX_PROCESSING_MS'))).toBe(MIN_PROCESSING_WINDOW_MS);
    expect(PROPOSE_DEADLINE_MS).toBe(JOB_DEADLINE_MS);
    expect((MIN_PROCESSING_WINDOW_MS - timeout) / 1000).toBe(120);
    expect((timeout - JOB_DEADLINE_MS) / 1000).toBe(60);
    // A window below the least stops the start: the deadline of a job assumes the window of 90 minutes.
    expect(() => processingWindowOf({ ADVERT_MAX_PROCESSING_MS: String(MIN_PROCESSING_WINDOW_MS - 1) })).toThrow('must be at least 5400000');
    expect(row(terms, 'Processing window, advert `max_processing_ms`')).toBe(`| Processing window, advert \`max_processing_ms\` | ${MIN_PROCESSING_WINDOW_MS} ms (${MIN_PROCESSING_WINDOW_MS / 60_000} minutes) |`);
    expect(row(terms, 'Service timeout, `SERVICE_TIMEOUT_MS`')).toBe(`| Service timeout, \`SERVICE_TIMEOUT_MS\` | ${timeout} ms (120 s inside the window) |`);
    expect(row(terms, 'Job deadline of `propose`, set by the service when a request arrives')).toBe(`| Job deadline of \`propose\`, set by the service when a request arrives | ${JOB_DEADLINE_MS} ms (60 s inside the service timeout). It bounds every wait of the job |`);
    expect(row(terms, 'Job deadline of `execute`, set by the service when a request arrives')).toBe(`| Job deadline of \`execute\`, set by the service when a request arrives | ${EXECUTE_DEADLINE_MS} ms |`);
    // The runbook lists the same three times.
    for (const [label, value] of [['Window of the advert', MIN_PROCESSING_WINDOW_MS], ['Timeout of the runtime for the service', timeout], ['Deadline of a job in the service', JOB_DEADLINE_MS]] as const) {
      expect(row(runbook, label), label).toContain(`| ${value.toLocaleString('en-US')} ms |`);
    }
  });

  test('the other limits of the Terms table: the request, the bidders, the reserves, the scorers, the model calls, the hire limits, the one job at a time and the reservation', () => {
    const terms = section('Terms');
    const limits = manifest.terms.input_limits;
    expect(limits).toStrictEqual({ request_bytes: MAX_REQUEST_BYTES, rfq_items: MAX_RFQ_ITEMS, item_quantity: MAX_ITEM_QUANTITY, tenant_chars: 48 });
    expect(ID_CHARS).toBe(64);
    expect(row(terms, 'Request')).toBe(
      `| Request | at most ${limits.request_bytes} bytes of wire payload; \`tenant\` 1 to ${limits.tenant_chars} characters; \`rfq_id\` and \`sku\` 1 to ${ID_CHARS} characters; 1 to ${limits.rfq_items} items; \`quantity\` 1 to ${limits.item_quantity} |`,
    );
    expect([MAX_CANDIDATES, MAX_INVITED]).toStrictEqual([8, 3]);
    expect(row(terms, 'Bidders')).toBe(`| Bidders | at most ${MAX_CANDIDATES} candidates are read, and at most ${MAX_INVITED} are invited |`);
    // The reserves: a hire starts only when both reserves are left, so it starts in the first part of the job. The hires keep the reserve of the scoring for the scorers.
    expect([QUOTE_HIRE_RESERVE_MS, SCORING_RESERVE_MS, SCORERS_NEED_MS, RANKING_RESERVE_MS]).toStrictEqual([1_830_000, 1_080_000, 960_000, 120_000]);
    expect(SCORING_RESERVE_MS).toBe(SCORERS_NEED_MS + RANKING_RESERVE_MS);
    const gate = QUOTE_HIRE_RESERVE_MS + SCORING_RESERVE_MS;
    expect(gate).toBe(2_910_000);
    expect(PROPOSE_DEADLINE_MS - gate).toBe(2_310_000);
    expect(row(terms, 'Quote hires')).toBe(`| Quote hires | one after the other. A hire starts only when ${gate} ms or more are left before the job deadline |`);
    expect(row(terms, 'Reserve of a quote hire')).toBe(`| Reserve of a quote hire | ${QUOTE_HIRE_RESERVE_MS} ms: the time that one hire can take, from the Pay to its end, with the challenge after a late no |`);
    expect(row(terms, 'Reserve of the scoring')).toBe(
      `| Reserve of the scoring | ${SCORING_RESERVE_MS} ms: the need of the three scorers (${SCORERS_NEED_MS} ms) and the reserve of the ranking decision (${RANKING_RESERVE_MS} ms). The hires keep it for the scoring |`,
    );
    expect([SCORER_NEED_MS, SCORER_JOB_TIMEOUT_MS, SUB_DELEGATION_VALID_MS, CONFIRMATIONS_REQUIRED]).toStrictEqual([720_000, 420_000, 1_800_000, 30]);
    expect(row(terms, 'Job of a scorer')).toBe(`| Job of a scorer | at most ${SCORER_JOB_TIMEOUT_MS} ms: the token, the read of the vendor master and the decision |`);
    expect(row(terms, 'Sub-delegation')).toBe(
      `| Sub-delegation | each scorer gets its token after ${CONFIRMATIONS_REQUIRED} confirmations of its sub-delegation, and the sub-delegation is valid for ${SUB_DELEGATION_VALID_MS} ms at most |`,
    );
    // The model calls: one shortlist, one acceptance for each quote, one score for each accepted quote and one ranking. With three bidders that is eight.
    expect([SHORTLIST_DECISION.name, ACCEPT_QUOTE_DECISION.name, SCORE_DECISION.name, RANKING_DECISION.name]).toStrictEqual(['shortlist', 'accept_quote', 'score', 'ranking']);
    expect(1 + MAX_INVITED + MAX_INVITED + 1).toBe(8);
    expect(row(terms, 'Model calls')).toBe(
      '| Model calls | in `propose`, one `shortlist`, one `accept_quote` for each quote, one `score` for each accepted quote and one `ranking`: at most 8 with three bidders. None in `execute` |',
    );
    // The hire limits are required settings with no default, and the env example of the pack gives them.
    expect([envLine('LLM_MAX_PRICE_LOVELACE'), envLine('LLM_MAX_SUPPLIER_BOND_LOVELACE'), envLine('LLM_MAX_BUYER_BOND_LOVELACE'), envLine('LLM_MODEL_ALLOWLIST')]).toStrictEqual(['1000000', '2000000', '2000000', 'deepseek/deepseek-v4-flash']);
    expect([envLine('QUOTE_MAX_PRICE_LOVELACE'), envLine('QUOTE_MAX_SUPPLIER_BOND_LOVELACE'), envLine('QUOTE_MAX_BUYER_BOND_LOVELACE')]).toStrictEqual(['2000000', '2000000', '2000000']);
    expect(row(terms, 'Model hire limits')).toBe(
      '| Model hire limits | the models of `LLM_MODEL_ALLOWLIST`, a price of at most 1000000 lovelace and each bond of at most 2000000 lovelace. The pack sets these values. No setting has a default |',
    );
    expect(row(terms, 'Quote hire limits')).toBe(
      '| Quote hire limits | a price of at most 2000000 lovelace and each bond of at most 2000000 lovelace, for the advert of a Bid Desk. The pack sets these values. No setting has a default |',
    );
    expect(readme).toContain('The limits of the model hire and of the quote hire have no default');
    expect(ERROR_STATUS.busy).toBe(409);
    expect(row(terms, 'Jobs at a time')).toBe('| Jobs at a time | one: a second job gets 409 `busy` |');
    expect(row(terms, 'Reservation')).toBe(`| Reservation | a go from \`POST /precheck\` reserves the job slot for ${RESERVATION_MS / 1000} s |`);
  });

  test('the time of a job: the paragraph says what the reserves, the deadline and the later bidders do', () => {
    const terms = section('Terms');
    for (const part of [
      'The job deadline of `propose` bounds every wait of the job: a call that would start after it is not made.',
      'A quote hire starts only when the reserve of a quote hire and the reserve of the scoring are left together, which is 2910000 ms. So a hire starts in the first 2310000 ms of the job at the latest.',
      'A bidder that the hires reach later is left out, as `failed` with the code `deadline`.',
      'With slow Bid Desks the job proposes from fewer quotes, and a job with no accepted quote ends `failed` with `no_quotes`.',
      'The scoring starts only when 1080000 ms are left, and the ranking decision only when 120000 ms are left. The job ends `failed` with `deadline` when they are not.',
      'A typical job is expected to end in about 20 minutes. No run has measured that yet, and the window is the longest time and not the usual time.',
      'The escrow can stay locked after the job ends. It holds funds until a settlement transaction lands.',
    ]) expect(terms, part).toContain(part);
    // The README holds the same rule.
    expect(readme).toContain('A quote hire starts only when the deadline of the job is at least 2910000 ms away, so it starts in the first 2310000 ms of the job.');
    expect(readme).toContain('A bidder that the fan-out reaches later is left out with the reason `deadline`, and a job with no accepted quote ends `failed` with `no_quotes`.');
    expect(PROPOSE_FAILURES).toEqual(expect.arrayContaining(['no_quotes', 'deadline']));
    expect(QUOTE_CODES).toContain('deadline');
  });

  test('the wire payload, the runtime body and the hosted send body have separate size limits', () => {
    const terms = section('Terms');
    expect([MAX_REQUEST_BYTES, RUNTIME_BODY_LIMIT_BYTES, MAX_BODY]).toStrictEqual([900_000, 1_048_576, 1_000_000]);
    expect(terms).toContain('`POST /` and `POST /precheck` count the UTF-8 bytes of the full wire payload, including the one-message array and all escapes.');
    expect(terms).toContain(`A valid wire message above ${MAX_REQUEST_BYTES} bytes gets \`request_too_large\` (400).`);
    expect(terms).toContain(`The shared HTTP reader stops at ${MAX_BODY} bytes.`);
    expect(terms).toContain(`The runtime has a separate limit of ${RUNTIME_BODY_LIMIT_BYTES} bytes for its whole request body.`);
    expect(terms).toContain('Escaping the payload again can make that body too large even if the payload fits.');
    // The hosted send counts the UTF-8 bytes of the same envelope as the runtime, with its own decimal cap.
    const hostedSendLimit = 1_000_000;
    expect(terms).toContain(`\`vector_marketplace_send_job\` limits the entire JSON body it sends to \`/v1/job\` to ${hostedSendLimit} UTF-8 bytes, not the \`payload\` field alone.`);
    expect(terms).toContain('To check the limit, count the bytes of `JSON.stringify({ escrow_ref, payload: wirePayload })`.');
    expect(terms).toContain('Check the size before you sign and submit the Post.');
    expect(section('Interface')).toContain('The wire payload carries the entire request, including `proposal.document` for `execute`.');

    // Count the document, the message framing and the escapes. The request text alone is below the limit in both cases.
    const request = JSON.stringify(EXECUTE_REQUEST);
    const atLimit = request + ' '.repeat(MAX_REQUEST_BYTES - Buffer.byteLength(wirePayloadFor(request)));
    const tooLarge = `${atLimit} `;
    expect(Buffer.byteLength(tooLarge)).toBeLessThan(MAX_REQUEST_BYTES);
    expect(checkWirePayload(atLimit)).toStrictEqual({ ok: true, value: MAX_REQUEST_BYTES });
    expect(checkWirePayload(tooLarge)).toMatchObject({ ok: false, code: 'request_too_large' });

    // Whitespace in the request can fit as escaped wire payload but not in the runtime's outer envelope.
    const tabs = request + '\t'.repeat(440_000);
    expect(checkWirePayload(tabs).ok).toBe(true);
    expect(checkRuntimeBody(tabs)).toMatchObject({ ok: false, code: 'request_too_large' });
    const fitsRuntime = request + '\t'.repeat(340_000);
    expect(must(checkWirePayload(fitsRuntime))).toBeLessThan(MAX_REQUEST_BYTES);
    expect(must(checkRuntimeBody(fitsRuntime))).toBeGreaterThan(hostedSendLimit);
  });

  test('the economics: what the supplier receives, the window to accept, the vault, the quotes of the Bid Desks and the fees', () => {
    const terms = section('Terms');
    expect(ACCEPT_WINDOW_MS).toBe(600_000);
    // A Bid Desk advert locks the price and both bonds: 3 units, from the template of the manifest of the Bid Desk.
    const desk = (JSON.parse(text('agents/bid-desk/agent.json.template')) as { terms: Record<string, number> }).terms;
    expect((desk.price_lovelace + desk.supplier_bond_lovelace + desk.buyer_bond_lovelace) / 1_000_000).toBe(3);
    for (const part of [
      'A hire of either operation locks the price and both bonds, 5 units at the listed terms.',
      "On Accept the supplier receives the price and the supplier bond. The buyer's bond goes to the refund address in the escrow.",
      `If the buyer does not accept within ${ACCEPT_WINDOW_MS / 1000} s of the supplier's Submit, the supplier may Release the escrow and take the price and both bonds.`,
      'The Release builder counts from `submitted_at` and opens at the first whole second after the window.',
      'Reclaim does not apply to a Submitted escrow. A `failed` job result does not itself refund the hire.',
      'If the escrow is still Open or Claimed, anyone can submit a Reclaim after `deliver_by`.',
      'Reclaim sends everything the escrow holds to its refund address, not to the caller.',
      "It applies to an Open or Claimed escrow if the supplier's record is Revoked or Retired. For a Submitted escrow it applies only if the record is Revoked and `invalid_from` is at or before `submitted_at`.",
      'Each Pay charges the full lock against `per_tx` and adds it to the spending of the current period for `total`. Allow for amounts already paid in that period.',
      'A Pay must leave the ledger minimum in the Live vault.',
      "The delegation key's wallet pays the Pay and Accept fees. The service key's wallet pays for the model hires.",
      'On Accept of a quote the buyer bond goes to a separate `Returned` vault output. A full refund of a quote goes to the same type of output.',
      'Only the vault owner can close it. It cannot fund another Pay and does not restore the spending allowance of the Live vault.',
      'The challenge itself does not refund the escrow (see Known gaps).',
    ]) expect(terms, part).toContain(part);
  });

  test('the README of the agent gives the same numbers as the page', () => {
    expect(readme).toContain(`${MAX_REQUEST_BYTES} bytes`);
    expect(readme).toContain(`${JOB_DEADLINE_MS} ms`);
    expect(readme).toContain(`${MIN_PROCESSING_WINDOW_MS} ms`);
    for (const number of [QUOTE_HIRE_RESERVE_MS, SCORING_RESERVE_MS, SCORERS_NEED_MS, SCORER_NEED_MS, SCORER_JOB_TIMEOUT_MS, SUB_DELEGATION_VALID_MS, RANKING_RESERVE_MS, EXECUTE_DEADLINE_MS]) expect(readme).toContain(`${number} ms`);
    expect(readme).toContain(`${QUOTE_HIRE_RESERVE_MS + SCORING_RESERVE_MS} ms`);
  });
});

// ---- The examples of the page: the requests, the proposal, the file of a bidder and the ranking, made with the real code from labels -----------------------------------------------------------------

/** A hex text made from a label: no reference, hash or key of an example belongs to an escrow, a Bid Desk or a key. */
const made = (label: string, algorithm = 'sha256'): string => createHash(algorithm).update(`sourcing agent example: ${label}`).digest('hex');
const didOf = (label: string): Did => `did:vector:${made(label)}`;
const refOf = (label: string): `${string}#0` => `${made(label)}#0`;
const keyHashOf = (label: string): string => made(label).substring(0, 56);

/** The value of an accepted result. A refusal stops the test, and its detail names the field. */
function must<T, C extends string>(result: ProtocolResult<T, C>): T {
  if (!result.ok) throw new Error(result.detail);
  return result.value;
}

const TENANT = 'demo';
const MODEL = 'deepseek/deepseek-v4-flash';
const HIRER = didOf('the hirer');
const AGENT = didOf('the Sourcing Agent');
const ALFA = didOf('Bid Desk Alfa');
const BRAVO = didOf('Bid Desk Bravo');
const AUTHORITY = { principal_did: HIRER, delegation: made('the delegation') };
const RFQ = { rfq_id: 'rfq-2026-12-a', items: [{ sku: 'GLV-NIT-M', quantity: 100 }, { sku: 'SYR-10ML', quantity: 250 }], needed_by: '2026-12-20' };
const WEIGHTS = { price: 0.4, lead_time: 0.2, reliability: 0.2, compliance: 0.2 };
const PROPOSE_REQUEST: ProposeRequest = { op: 'propose', authority: AUTHORITY, tenant: TENANT, rfq: RFQ, weights: WEIGHTS };
const FAULT = readFaultSwitch('sourcing-agent', '');
const VERIFICATION = Object.fromEntries(RECEIPT_CHECKS.map((check) => [check, true])) as ReceiptVerification;

/** The price list of Bid Desk Alfa, as the file of the repository holds it, with its hash. */
const ALFA_LIST_TEXT = text('agents/bid-desk/price-lists/alfa.json');
const ALFA_LIST: PriceList = must(parsePriceList(JSON.parse(ALFA_LIST_TEXT)));
const ALFA_LIST_SHA = priceListSha256(ALFA_LIST_TEXT);

/** The job of a model supplier that gave a decision: a sub-job with a signed receipt of its own. */
function modelJob(label: string, tokens: readonly [number, number, number]): SubJob {
  const escrow = refOf(`the escrow of the model, ${label}`);
  const supplier = keyHashOf('the key of the model supplier');
  return {
    capability_id: 'llm.text.generate.v1', advert_ref: refOf('the advert of the model'), escrow_ref: escrow, supplier_pkh: supplier,
    receipt: {
      escrow_ref: escrow, supplier_pkh: supplier, prompt_hash: made(`the prompt, ${label}`), response_hash: made(`the answer, ${label}`), model: MODEL, prompt_tokens: tokens[0], completion_tokens: tokens[1], wallclock_ms: tokens[2],
    },
    receipt_signature: made(`the signature of the model supplier, ${label}`, 'sha512'),
    verification: VERIFICATION,
  };
}
function decisionOf(name: string, choice: JsonValue, reasoning: string, tokens: readonly [number, number, number]): Decision {
  return { name, choice, reasoning, inference: { path: 'marketplace', sub_job: modelJob(name, tokens), accepted: 'confirmed' } };
}

/** The file of a bidder that the real reader would give for an Active Bid Desk, with the facts of the example. */
function fileOf(did: Did, name: string, over: Partial<BidderFile> = {}): BidderFile {
  return {
    did, advert_ref: refOf(`the advert of Bid Desk ${name}`), status: 'active', status_reason: null,
    lineage: { hold_until: null, ended_at: null, invalid_from: null, successor: null, recovery_pending: false },
    accountable: keyHashOf(`the Accountable key of Bid Desk ${name}`), organisation: `${name.toLowerCase()}.vector.apexfusion.org`, organisation_verified: true, in_catalog: true,
    stake_lovelace: '10000000', cases_against: 0, price_list: 'valid',
    compliance: { state: 'valid', attestation: made(`the attestation of Bid Desk ${name}`), attestation_state: 'active', issued_at: '2026-11-20T10:00:00Z', valid_until: '2027-05-20T10:00:00Z', revoked_at: null, revoke_reason: null, contested: null },
    credential: 'valid', ...over,
  };
}
const ALFA_FILE = fileOf(ALFA, 'Alfa');
const BRAVO_FILE = fileOf(BRAVO, 'Bravo', {
  price_list: 'invalid',
  compliance: { state: 'absent', attestation: null, attestation_state: null, issued_at: null, valid_until: null, revoked_at: null, revoke_reason: null, contested: null },
});
const ALFA_VIEW: BidderView = { file: ALFA_FILE, supplier_pkh: keyHashOf('the supplier key of Bid Desk Alfa'), price_list: { list: ALFA_LIST, sha256: ALFA_LIST_SHA } };
const BRAVO_VIEW: BidderView = { file: BRAVO_FILE, supplier_pkh: keyHashOf('the supplier key of Bid Desk Bravo'), price_list: null };

/** The quote of Bid Desk Alfa for the request: the lines are the listed prices of its list, and the totals are the arithmetic of the kit. */
const LINES = RFQ.items.map((item) => {
  const listed = priceFor(ALFA_LIST, item.sku, item.quantity);
  if (listed === null) throw new Error(`the list has no price for ${item.sku}`);
  return { sku: item.sku, quantity: item.quantity, unit_price: listed.unit_price, lead_time_days: listed.lead_time_days };
});
const TOTALS = quoteTotals(LINES);
if (TOTALS === null) throw new Error('the lines of the example make no totals');
const QUOTE_NOTES = 'Prices are from the published list. The quote holds for the quantities of the request.';
const QUOTE: Quote = {
  schema: QUOTE_SCHEMA, outcome: 'done', rfq_id: RFQ.rfq_id, rfq_sha256: must(rfqSha256(RFQ)), desk_did: ALFA, organisation: ALFA_FILE.organisation as string,
  lines: TOTALS.lines, total: TOTALS.total, lead_time_days: TOTALS.lead_time_days, valid_until: '2026-12-31', notes: QUOTE_NOTES, price_list_sha256: ALFA_LIST_SHA, credential: 'aGVhZGVy.cGF5bG9hZA.c2lnbmF0dXJl',
  sender: { did: AGENT, organisation: 'echo.vector.apexfusion.org', organisation_verified: true },
  checks: { sender_active: true, sender_accountable: true, sender_key: true, delegation: true, delegation_usable: true, vault_paid: true, not_duplicate: true },
  decisions: [decisionOf('quote', { lines: LINES, valid_until: '2026-12-31', notes: QUOTE_NOTES }, 'Each line takes the listed price for its SKU and its quantity. The lead time of the quote is the longest of the lines.', [455, 112, 2860])],
  fault_mode: '',
};

/** The quote job: the escrow that the Pay made, the signed receipt of the Bid Desk, and the quote as its result. */
const QUOTE_JOB: SubJob = {
  capability_id: BID_CAPABILITIES.quote, advert_ref: ALFA_FILE.advert_ref, escrow_ref: refOf('the escrow of the quote'), supplier_pkh: ALFA_VIEW.supplier_pkh,
  receipt: {
    escrow_ref: refOf('the escrow of the quote'), supplier_pkh: ALFA_VIEW.supplier_pkh, prompt_hash: made('the request for quotation'), response_hash: made('the quote text'), model: BID_DESK_MODEL, prompt_tokens: 0, completion_tokens: 0, wallclock_ms: 41250,
  },
  receipt_signature: made('the signature of Bid Desk Alfa', 'sha512'),
  verification: VERIFICATION,
};
const QUOTE_RECORD: QuoteRecord = {
  desk_did: ALFA, advert_ref: QUOTE_JOB.advert_ref, escrow_ref: QUOTE_JOB.escrow_ref, paid_from_vault: true, receipt: QUOTE_JOB.receipt, receipt_signature: QUOTE_JOB.receipt_signature, verification: VERIFICATION,
  result: JSON.parse(JSON.stringify(QUOTE)) as JsonObject, accepted: 'confirmed', challenge: null,
};

const SHORTLIST = { invite: [ALFA], not_invited: [{ did: BRAVO, reason: 'The price list of this bidder is not valid, so its quote cannot be checked.' }] };
const SHORTLIST_DECISION_RECORD = decisionOf('shortlist', SHORTLIST, 'Bid Desk Alfa has an active record, a valid price list, a valid attestation and a stake. Bid Desk Bravo publishes a price list that is not valid.', [1310, 96, 3120]);
const ACCEPT_DECISION_RECORD = decisionOf('accept_quote', { accept: true, mismatch: [] }, 'The unit price of each line is the listed price: 125 for 100 units of GLV-NIT-M, and 28 for 250 units of SYR-10ML.', [702, 44, 2410]);
const SCORE = { components: { price: 80, lead_time: 90, reliability: 85, compliance: 100 }, score: 87 };
const SCORE_DECISION_RECORD = decisionOf('score', SCORE, 'The total is fair for the quantities. The lead time of 14 days meets the date of the request. The bidder is active, has a stake, no open case and a valid attestation.', [1480, 118, 3560]);
const RANKING = { order: [ALFA], tie_break: '' };
const RANKING_DECISION_RECORD = decisionOf('ranking', RANKING, 'One bidder is scored, so the order has one entry.', [388, 31, 1930]);

/** The real job over scripted ports: the discovery gives two candidates, the model invites one, its quote is accepted and scored, and the model orders it. */
async function exampleRun() {
  const w = world();
  w.script.delegation = async () => ({ delegate: agentIdOf(AGENT), chain_whole: true });
  w.script.discover = async () => ({ ok: true, value: { bidders: [ALFA_VIEW, BRAVO_VIEW] } });
  w.script.shortlist = async () => ({ ok: true, decision: SHORTLIST_DECISION_RECORD, choice: SHORTLIST });
  w.script.quotes = async (input) => {
    if (input.invited.length !== 1 || input.invited[0].did !== ALFA) throw new Error('the job must invite Bid Desk Alfa only');
    return { outcomes: [{ kind: 'accepted', did: ALFA, quote: QUOTE, record: QUOTE_RECORD, sub_job: QUOTE_JOB, decision: ACCEPT_DECISION_RECORD }], stopped: null };
  };
  w.script.scoring = async () => ({ ok: true, scores: [{ did: ALFA, decision: SCORE_DECISION_RECORD, choice: SCORE }] });
  w.script.rank = async () => ({ ok: true, decision: RANKING_DECISION_RECORD, choice: RANKING });
  const result = proposed(await w.run({ request: PROPOSE_REQUEST, deps: { agent: { did: AGENT } } }));
  return { w, result };
}
const RUN = await exampleRun();
/** The salt of a real job is random, so the example takes a salt that is made from a label, with the digest of that salt and the real document. */
const SALT = made('the salt');
const PROPOSED = { ...withFaultMode(FAULT, RUN.result), salt: SALT, proposal_digest: must(proposalDigest(SALT, RUN.result.document)) };
const PROPOSAL = must(parseProposal({ document: PROPOSED.document, salt: PROPOSED.salt, proposal_digest: PROPOSED.proposal_digest }));
const EXECUTE_REQUEST = { op: 'execute', authority: AUTHORITY, tenant: TENANT, proposal: PROPOSAL, approval: { attestation: made('the approval'), issuer_did: HIRER } };

const jsonBlocks = (body: string): string[] => [...body.matchAll(/```json\n([\s\S]*?)\n```/g)].map((hit) => hit[1]);
/** The first cells of the rows of the table that starts with `header`. */
function firstCells(body: string, header: string): string[] {
  const lines = body.split('\n');
  const at = lines.indexOf(header);
  if (at < 0) throw new Error(`no table has the header ${header}`);
  const cells: string[] = [];
  for (let index = at + 2; index < lines.length && lines[index].startsWith('| '); index += 1) cells.push(lines[index].substring(2).split(' | ')[0]);
  return cells;
}
/** The names in backticks of some cells: the cell "`a`, `b`" gives a and b. */
const namesOf = (cells: readonly string[]): string[] => cells.flatMap((cell) => [...cell.matchAll(/`([a-z][a-z0-9_]*)`/g)].map((hit) => hit[1]));

describe('specs/sourcing-agent.md, Interface, Request', () => {
  const request = sub('Request');

  test('the request fields: each member of the schema is on the page, and the intake holds the rules of the field tables', async () => {
    const [propose, execute] = REQUEST_SCHEMA.oneOf;
    expect(Object.keys(propose.properties)).toStrictEqual(['op', 'authority', 'tenant', 'rfq', 'weights']);
    expect(Object.keys(execute.properties)).toStrictEqual(['op', 'authority', 'tenant', 'proposal', 'approval']);
    for (const field of ['op', 'authority', 'principal_did', 'delegation', 'tenant', 'rfq', 'rfq_id', 'items', 'needed_by', 'sku', 'quantity', 'weights', 'proposal', 'document', 'salt', 'proposal_digest', 'approval', 'attestation', 'issuer_did']) {
      expect(request, field).toContain(`\`${field}\``);
    }
    for (const name of WEIGHT_NAMES) expect(request, name).toContain(`\`${name}\``);
    expect(WEIGHT_NAMES).toStrictEqual(['price', 'lead_time', 'reliability', 'compliance']);
    const proposeOk = (over: Record<string, unknown>): boolean => parseRequest({ ...PROPOSE_REQUEST, ...over }, parseProposeFields).ok;
    const itemOk = (item: Record<string, unknown>): boolean => proposeOk({ rfq: { ...RFQ, items: [item] } });
    const rfqOk = (over: Record<string, unknown>): boolean => proposeOk({ rfq: { ...RFQ, ...over } });
    const weightsOk = (over: Record<string, unknown>): boolean => proposeOk({ weights: { ...WEIGHTS, ...over } });
    expect(proposeOk({})).toBe(true);
    expect([rfqOk({ rfq_id: 'a'.repeat(64) }), rfqOk({ rfq_id: 'a'.repeat(65) }), rfqOk({ rfq_id: '' }), rfqOk({ rfq_id: '.a' }), rfqOk({ rfq_id: 'a b' }), rfqOk({ rfq_id: 'A-1_2.3' })]).toStrictEqual([true, false, false, false, false, true]);
    expect([itemOk({ sku: 'a'.repeat(64), quantity: 1 }), itemOk({ sku: 'a'.repeat(65), quantity: 1 }), itemOk({ sku: '.a', quantity: 1 }), itemOk({ sku: 'A-1_2.3', quantity: 1 })]).toStrictEqual([true, false, false, true]);
    expect([itemOk({ sku: 'A', quantity: 1 }), itemOk({ sku: 'A', quantity: 1_000_000 }), itemOk({ sku: 'A', quantity: 0 }), itemOk({ sku: 'A', quantity: 1_000_001 }), itemOk({ sku: 'A', quantity: 1.5 })]).toStrictEqual([true, true, false, false, false]);
    const items = (count: number): Array<{ sku: string; quantity: number }> => Array.from({ length: count }, (_, index) => ({ sku: `S${index}`, quantity: 1 }));
    expect([rfqOk({ items: items(20) }), rfqOk({ items: items(21) }), rfqOk({ items: [] }), rfqOk({ items: [{ sku: 'A', quantity: 1 }, { sku: 'A', quantity: 2 }] }), rfqOk({ items: [{ sku: 'A', quantity: 1, extra: 1 }] })]).toStrictEqual([true, false, false, false, false]);
    expect([rfqOk({ needed_by: '2026-12-20' }), rfqOk({ needed_by: '2026-02-30' }), rfqOk({ needed_by: '0099-01-01' }), rfqOk({ needed_by: '0100-01-01' }), rfqOk({ needed_by: '20 Dec 2026' })]).toStrictEqual([true, false, false, true, false]);
    expect([rfqOk({ extra: 1 }), proposeOk({ extra: 1 }), proposeOk({ op: 'cancel' }), proposeOk({ authority: { ...AUTHORITY, vault: made('a vault') } }), proposeOk({ authority: { principal_did: HIRER } })]).toStrictEqual([false, false, false, false, false]);
    expect([weightsOk({}), weightsOk({ price: 0.5 }), weightsOk({ price: 0.4001, reliability: 0.1999 }), weightsOk({ price: 0.12345, lead_time: 0.47655 }), weightsOk({ price: -0.1, lead_time: 0.7 }), weightsOk({ price: 1.2, compliance: -0.2 }), weightsOk({ extra: 0 })]).toStrictEqual([true, false, true, false, false, false, false]);
    expect(proposeOk({ weights: { price: 0.4, lead_time: 0.2, reliability: 0.4 } })).toBe(false);
    // The tenant: the intake refuses a tenant outside the form of the schema for both operations, and the job of `propose` refuses it too, with `bad_shape` (400), before it reads anything.
    const tenantCheck = async (tenant: string): Promise<string> => {
      try {
        await runPropose({} as ProposeDeps<unknown>, { ...PROPOSE_REQUEST, tenant }, 0);
        return 'past the check';
      } catch (error) {
        return error instanceof ProposeRefusal ? `${error.code} ${error.status}` : 'past the check';
      }
    };
    expect(await Promise.all(['a'.repeat(48), 'a'.repeat(49), 'Demo', '-a', 'a-1'].map(tenantCheck))).toStrictEqual(['past the check', 'bad_shape 400', 'bad_shape 400', 'bad_shape 400', 'past the check']);
    const intake = (value: unknown): string => {
      try {
        parseJob(JSON.stringify(value));
        return 'accepted';
      } catch (error) {
        return error instanceof RequestRefusal ? `${error.code} ${error.status}` : 'other';
      }
    };
    expect([intake(PROPOSE_REQUEST), intake({ ...PROPOSE_REQUEST, tenant: 'Demo' }), intake(EXECUTE_REQUEST), intake({ ...EXECUTE_REQUEST, tenant: 'Demo' })]).toStrictEqual(['accepted', 'bad_shape 400', 'accepted', 'bad_shape 400']);
    expect(request).toContain('The tenant of `execute` has one more rule: the job checks it against the ranking (`ranking_not_for_tenant`).');
    expect(request).toContain('The authority has no vault: the agent finds the Live vault of the delegation itself.');
    const executeOk = (over: Record<string, unknown>): boolean => parseRequest({ ...EXECUTE_REQUEST, ...over }).ok;
    expect([executeOk({}), executeOk({ approval: null })]).toStrictEqual([true, true]);
    expect([executeOk({ proposal: { ...EXECUTE_REQUEST.proposal, proposal_digest: made('another digest') } }), executeOk({ extra: 1 }), executeOk({ approval: { attestation: made('only the attestation') } })]).toStrictEqual([false, false, false]);
    const { approval: _left, ...withoutApproval } = EXECUTE_REQUEST;
    expect(parseRequest(withoutApproval).ok).toBe(false);
    expect(request).toContain('The agent does not check the approval. It passes it on, and the sourcing record refuses a ranking with no valid approval.');
    // Hex is lower case: a hex text in upper case is refused, and the refusal is not a refusal of the digest.
    expect(request).toContain('A hex text is lower case: a hex text in upper case breaks a rule.');
    const upper = (hex: string): string => hex.toUpperCase();
    expect([
      proposeOk({ authority: { ...AUTHORITY, delegation: upper(AUTHORITY.delegation) } }),
      proposeOk({ authority: { ...AUTHORITY, principal_did: `did:vector:${upper(made('the hirer'))}` } }),
      executeOk({ proposal: { ...EXECUTE_REQUEST.proposal, salt: upper(SALT) } }),
      executeOk({ approval: { attestation: upper(made('the approval')), issuer_did: HIRER } }),
    ]).toStrictEqual([false, false, false, false]);
    expect(request).toContain('`delegation`: the identifier of the delegation that names this agent as its delegate, 64 lower-case hex characters.');
    expect(request).toContain('`salt` (64 lower-case hex characters) and `proposal_digest` (64 lower-case hex characters)');
    expect(request).toContain('`attestation`, the identifier of the approval (64 lower-case hex characters), and `issuer_did`, the DID of its issuer (`did:vector:` and 64 lower-case hex characters)');
    // A document that is not a ranking passes the intake, and the job ends with `bad_document`.
    expect(request).toContain('A document that is not a ranking ends the job with `bad_document`.');
  });

  test('a repeated rfq_id: a Bid Desk keeps a book that never drops an entry, and the refusal duplicate_rfq leaves the bidder out as refused', () => {
    expect(request).toContain('Use a new `rfq_id` for each `propose`. A Bid Desk keeps a book of the requests that it answered, with the sender and the `rfq_id` of each, and it never drops an entry.');
    expect(request).toContain('A request that repeats an `rfq_id` of the same sender gets the refusal `duplicate_rfq` from a Bid Desk that answered it, and the agent leaves that bidder out as `refused`. When every invited bidder refuses, the job ends `failed` with `no_quotes`.');
    expect(text('agents/bid-desk/src/checks/book.ts')).toContain('It never drops an entry to make room');
    expect(COUNTERPARTY_REFUSALS['bid-desk']).toContain('duplicate_rfq');
    expect(QUOTE_CODES).toContain('duplicate_rfq');
    expect(EXCLUDED_REASONS).toContain('refused');
    // The sender of every request for quotation is this agent, whoever the hirer is, and the book keys an entry by its sender and its identifier.
    expect(RUN.w.calls.quotes[0]?.input.sender).toBe(AGENT);
    expect(RUN.w.calls.quotes[0]?.input.sender).not.toBe(HIRER);
    expect(text('agents/bid-desk/src/checks/book.ts')).toContain('The sender is a part of the key: the same identifier from another sender is a new request.');
    expect(request).toContain('The sender of a request for quotation is this agent for every hirer, so an `rfq_id` must be new across all hirers of the agent, and not only across your own requests.');
  });

  test('the examples of the requests are what the kit makes, the kit parses them, and the intake of the service takes them', () => {
    const [proposeBlock, executeBlock] = jsonBlocks(request);
    expect(proposeBlock).toBe(JSON.stringify(PROPOSE_REQUEST, null, 2));
    expect(executeBlock).toBe(JSON.stringify(EXECUTE_REQUEST, null, 2));
    expect(must(parseRequest(JSON.parse(proposeBlock), parseProposeFields))).toStrictEqual(PROPOSE_REQUEST);
    expect(must(parseRequest(JSON.parse(executeBlock)))).toStrictEqual(EXECUTE_REQUEST);
    const { proposal } = JSON.parse(executeBlock) as typeof EXECUTE_REQUEST;
    expect(must(parseProposal(proposal))).toStrictEqual(PROPOSAL);
    expect(must(parseRanking(proposal.document)).rfq_id).toBe(RFQ.rfq_id);
    // The digest is the sha256 of the 32 bytes of the salt and the canonical JSON of the document.
    expect(createHash('sha256').update(Buffer.from(proposal.salt, 'hex')).update(must(canonicalJson(proposal.document)), 'utf8').digest('hex')).toBe(proposal.proposal_digest);
    expect(request).toContain('The digest is the sha256 of the 32 bytes of the salt and the canonical JSON of the document.');
    // The two requests are a few kilobytes: far below the limits of Terms.
    for (const [block, op] of [[proposeBlock, 'propose'], [executeBlock, 'execute']] as const) {
      const wire = wirePayloadFor(block);
      expect(parseJob(parseWire(wire), wire).op).toBe(op);
      expect(must(checkWirePayload(block))).toBeLessThan(12_000);
      expect(must(checkRuntimeBody(block))).toBeLessThan(12_000);
    }
    // The `propose` example uses the items and the weights of the Response example, and the SKUs are SKUs of the price list of Bid Desk Alfa.
    expect(RFQ.items.map((item) => item.sku).every((sku) => priceFor(ALFA_LIST, sku, 1) !== null)).toBe(true);
  });

  test('the steps of propose and execute: the codes that they name are codes of the jobs, and the inputs of the four decisions are the ones that the steps say', () => {
    const known = new Set<string>([...PROPOSE_FAILURES, ...QUOTE_CODES, ...SCORING_FAILURES, ...EXECUTE_FAILURES, ...Object.keys(ERROR_STATUS)]);
    const named = [
      'delegation_not_mine', 'bad_shape', 'delegation_not_found', 'delegation_key_unknown', 'ledger_unavailable', 'bidders_unavailable', 'no_bidders', 'shortlist_unknown_bidder', 'nobody_invited', 'aborted', 'deadline',
      'no_price_list', 'status_unreadable', 'quote_invalid', 'quote_not_from_bidder', 'quote_not_for_rfq', 'quote_not_from_list', 'no_open_claim', 'no_evidence', 'no_quotes', 'ranking_invalid', 'bad_document',
      'ranking_not_for_tenant', 'token_failed', 'mock_system_failed', 'duplicate_rfq', 'suspended', 'revoked', 'retired', 'not_found', 'not_active', 'refused', 'disputed', 'failed',
    ];
    for (const code of named) {
      expect(request, code).toContain(`\`${code}\``);
      expect(known.has(code), code).toBe(true);
    }
    expect(ERROR_STATUS.delegation_not_mine).toBe(400);
    expect(ERROR_STATUS.bad_shape).toBe(400);
    // The own codes of the job: each step that the list names writes its code.
    expect(PROPOSE_FAILURES).toEqual(expect.arrayContaining(['delegation_not_found', 'delegation_key_unknown', 'ledger_unavailable', 'bidders_unavailable', 'no_bidders', 'shortlist_unknown_bidder', 'nobody_invited', 'no_quotes', 'ranking_invalid', 'bad_document']));
    expect(EXECUTE_FAILURES).toEqual(expect.arrayContaining(['bad_document', 'ranking_not_for_tenant', 'ledger_unavailable', 'delegation_not_found', 'delegation_key_unknown', 'aborted', 'deadline', 'token_failed', 'mock_system_failed']));
    // The sourcing record: a null approval is refused with `approval_not_found`, and it checks that the supplier of rank 1 is Active.
    const record = text('services/mock-systems/src/routes.ts');
    expect(record).toContain("if (request.approval === null) return refuse('approval_not_found'");
    expect(record).toContain('4. the supplier of rank 1 resolves and is Active now;');
    expect(text('agents/sourcing-agent/src/execute/execute.ts')).toContain("tenant: 'ranking_not_for_tenant'");
    for (const part of [
      'The sourcing record checks the approval, and that the supplier of rank 1 resolves and is Active now. A `null` approval is refused with `approval_not_found`.',
      'The agent never builds, replaces or defaults an approval. It makes the call one time and never again, also after a failure, because a failed call can have written the ranking.',
      'The sourcing record does not reject a duplicate ranking.',
      'Read `GET <mock base>/t/<tenant>/state` and check `sourcing.rankings` for the same `rfq_id`, ranking document and `approval.attestation`. This read needs no token.',
      'If you cannot confirm that the previous job ended without writing the ranking, do not retry.',
    ]) expect(request, part).toContain(part);
    // The facts that the steps give about the model: the decision `shortlist` reads the items and the date of the request and the facts of each file, at most 3 DIDs, a reason of at most 200 characters.
    const shortlist = shortlistInput(RFQ, [ALFA_FILE, BRAVO_FILE]) as { request: Record<string, unknown>; bidders: Array<Record<string, unknown>> };
    expect(Object.keys(shortlist)).toStrictEqual(['request', 'bidders']);
    expect(Object.keys(shortlist.request)).toStrictEqual(['items', 'needed_by']);
    expect(shortlist.bidders.map((facts) => facts.did)).toStrictEqual([ALFA, BRAVO]);
    expect(SHORTLIST_DECISION.parse({ invite: [], not_invited: [] }).ok).toBe(true);
    expect([ALFA, BRAVO, didOf('c'), didOf('d')].map((_, count) => SHORTLIST_DECISION.parse({ invite: [ALFA, BRAVO, didOf('c'), didOf('d')].slice(0, count), not_invited: [] }).ok)).toStrictEqual([true, true, true, true]);
    expect(SHORTLIST_DECISION.parse({ invite: [ALFA, BRAVO, didOf('c'), didOf('d')], not_invited: [] }).ok).toBe(false);
    expect([SHORTLIST_DECISION.parse({ invite: [], not_invited: [{ did: ALFA, reason: 'x'.repeat(200) }] }).ok, SHORTLIST_DECISION.parse({ invite: [], not_invited: [{ did: ALFA, reason: 'x'.repeat(201) }] }).ok]).toStrictEqual([true, false]);
    // `accept_quote` reads the items, the lines of the quote and the entries of the price list for the SKUs of the lines, and compares the unit price only: it accepts exactly when `mismatch` is empty.
    const acceptInput = acceptQuoteInput(RFQ, QUOTE, ALFA_LIST) as { request: Record<string, unknown>; quote: { lines: Array<Record<string, unknown>> }; price_list: Array<{ sku: string }> };
    expect(Object.keys(acceptInput)).toStrictEqual(['request', 'quote', 'price_list']);
    expect(Object.keys(acceptInput.quote.lines[0])).toStrictEqual(['sku', 'quantity', 'unit_price', 'lead_time_days']);
    expect(acceptInput.price_list.map((entry) => entry.sku)).toStrictEqual(RFQ.items.map((item) => item.sku));
    expect([ACCEPT_QUOTE_DECISION.parse({ accept: true, mismatch: [] }).ok, ACCEPT_QUOTE_DECISION.parse({ accept: false, mismatch: ['GLV-NIT-M'] }).ok, ACCEPT_QUOTE_DECISION.parse({ accept: true, mismatch: ['GLV-NIT-M'] }).ok, ACCEPT_QUOTE_DECISION.parse({ accept: false, mismatch: [] }).ok]).toStrictEqual([true, true, false, false]);
    expect(text('agents/sourcing-agent/src/quotes/evidence.ts')).toContain('statement_text: BID_DESK_CLAIM.statements[0].text,');
    // The scorers are used in the order of the quotes: subject `k` goes to scorer `k + 1`, so with fewer than three quotes the later scorers get none.
    expect(text('agents/sourcing-agent/src/propose/ports.ts')).toContain('Subject `k` goes to the scorer `k + 1`.');
    expect(request).toContain('With fewer than three accepted quotes, the later scorers do not start.');
    // `score` reads the date of today, the weights, the request, the lines and totals of the quote, the file of the bidder and the vendor entry, and `ranking` the weights and the numbers of each scored bidder.
    const scored = scoreInput({ today: '2026-11-24', weights: WEIGHTS, rfq: RFQ, quote: QUOTE, file: ALFA_FILE, vendor: null }) as Record<string, unknown>;
    expect(Object.keys(scored)).toStrictEqual(['today', 'weights', 'request', 'quote', 'lines_quoted', 'items_requested', 'bidder', 'vendor']);
    expect(scored.vendor).toBeNull();
    expect(SCORE_COMPONENTS).toStrictEqual(WEIGHT_NAMES);
    expect([SCORE_DECISION.parse(SCORE).ok, SCORE_DECISION.parse({ ...SCORE, score: 101 }).ok, SCORE_DECISION.parse({ ...SCORE, score: -1 }).ok, SCORE_DECISION.parse({ ...SCORE, components: { ...SCORE.components, price: 100.5 } }).ok]).toStrictEqual([true, false, false, false]);
    const ranked = rankingInput(WEIGHTS, [{ desk_did: ALFA, score: 87, components: SCORE.components, total: QUOTE.total, lead_time_days: QUOTE.lead_time_days }]) as { weights: unknown; scored: Array<Record<string, unknown>> };
    expect(Object.keys(ranked)).toStrictEqual(['weights', 'scored']);
    expect(Object.keys(ranked.scored[0])).toStrictEqual(['desk_did', 'score', 'components', 'total', 'lead_time_days']);
    expect([RANKING_DECISION.parse({ order: [ALFA], tie_break: '' }).ok, RANKING_DECISION.parse({ order: [], tie_break: '' }).ok, RANKING_DECISION.parse({ order: [ALFA], tie_break: 'x'.repeat(301) }).ok]).toStrictEqual([true, false, false]);
  });

  test('each name in backticks in the two lists of steps is a code that a job writes, a word of the protocol, or a name that the test lists as no code', () => {
    const { propose, execute, protocol } = reasonsOfJobs();
    const codes = new Set<string>([...propose, ...execute, ...protocol, ...SCORING_FAILURES, ...QUOTE_CODES, ...EXCLUDED_REASONS, ...EXECUTE_OUTCOMES, ...Object.keys(ERROR_STATUS)]);
    // The names of the steps that are no code: the decisions, the members of the requests and results, and the name of the second job.
    const noCode = new Set<string>([SHORTLIST_DECISION.name, ACCEPT_QUOTE_DECISION.name, SCORE_DECISION.name, RANKING_DECISION.name, 'document', 'mismatch', 'null', 'reason', 'execute', 'rfq_id']);
    const steps = request.split('What `propose` does, in this order, under its deadline:')[1] ?? '';
    const names = [...new Set([...steps.matchAll(/`([a-z][a-z0-9_]*)`/g)].map((hit) => hit[1]))];
    expect(names).toEqual(expect.arrayContaining(['delegation_not_mine', 'delivery_not_recordable', 'decision_failed', 'model_output_invalid', 'ranking_not_for_tenant', 'approval_not_found', 'refused_by_system', 'mock_system_failed']));
    expect(names.filter((name) => !noCode.has(name) && !codes.has(name))).toStrictEqual([]);
    expect(names.filter((name) => noCode.has(name))).toHaveLength(noCode.size);
  });
});

describe('specs/sourcing-agent.md, the delegation of the hirer and a decision that fails', () => {
  const request = sub('Request');
  const how = section('How to hire it');
  const SUB_CODES = ['sub_delegation_parent_exhausted', 'sub_delegation_parent_expiring', 'sub_delegation_build_refused'];

  afterEach(() => {
    quoteWorld.cleanWorlds();
  });

  test('the parent must cover the scorer and its resource, and the child minimum is not the job budget', async () => {
    expect(MIN_SUB_DELEGATION_MS).toBe(300_000);
    expect(MIN_SUB_DELEGATION_MS).toBeLessThan(SCORER_NEED_MS);
    for (const code of SUB_CODES) {
      expect(SCORING_FAILURES, code).toContain(code);
      expect(request, code).toContain(`\`${code}\``);
    }
    for (const part of [
      'the parent must have `remaining` of at least 1. This number limits the depth, not the number of scorers.',
      `Keep the delegation valid for the full \`propose\` window (${MIN_PROCESSING_WINDOW_MS} ms).`,
      'Keep the delegation valid through `execute`.',
      'A token does not extend the authority of the delegation.',
      `Its expiry is the earlier of ${SUB_DELEGATION_VALID_MS} ms after the start of its build and the end of the parent.`,
      `The build requires at least ${MIN_SUB_DELEGATION_MS} ms of child validity (\`MIN_SUB_DELEGATION_MS\`). This is a refusal threshold`,
      "The builder refuses a child that exceeds the parent's actions or resources.",
      "The agent must still list the parent's delegate key for the delegation purpose.",
      'The scorer must list its own delegate key for the delegation purpose, and no other delegation on the ledger may use that key.',
    ]) expect(request, part).toContain(part);

    // The access kit refuses exhausted and short-lived parents before it asks the builder.
    const exhausted = scoringWorld();
    exhausted.chain.parent = { ...exhausted.chain.parent!, remaining: 0 };
    expect(await exhausted.run()).toMatchObject({ ok: false, code: 'sub_delegation_parent_exhausted' });
    const expiring = scoringWorld();
    expiring.chain.parent = { ...expiring.chain.parent!, notAfter: SCORING_NOW + MIN_SUB_DELEGATION_MS - 1 };
    expect(await expiring.run()).toMatchObject({ ok: false, code: 'sub_delegation_parent_expiring' });

    // At the minimum the kit can build. The child's validity cannot exceed the parent's. Use the same narrowing check as the vendored builder.
    const atMinimum = scoringWorld();
    const parent = { ...atMinimum.chain.parent!, notAfter: SCORING_NOW + MIN_SUB_DELEGATION_MS };
    atMinimum.chain.parent = parent;
    await atMinimum.run({ input: { subjects: atMinimum.input.subjects.slice(0, 1) } });
    const [built] = atMinimum.chain.builtDelegates;
    expect(built?.delegation.notAfter).toBe(parent.notAfter);
    const child = built!.delegation;
    expect(narrowingProblems(child, parent)).toStrictEqual([]);
    expect(narrowingProblems(child, { ...parent, actions: [Buffer.from(HIRE_ACTION).toString('hex')] })).toStrictEqual([expect.stringContaining('no action pattern')]);
    expect(narrowingProblems(child, { ...parent, resources: [] })).toStrictEqual([expect.stringContaining('no resource pattern')]);

    const refused = scoringWorld();
    refused.script.build = () => { throw new Error('the builder refuses the child'); };
    expect(await refused.run()).toMatchObject({ ok: false, code: 'sub_delegation_build_refused' });
  });

  test('a vault check blocks one Pay, but it does not undo an earlier Pay', async () => {
    expect(QUOTE_CODES).toEqual(expect.arrayContaining(['no_live_vault', 'several_live_vaults']));
    const none = await quoteWorld.world();
    const unpaid = await none.run(none.input(), { ...none.deps, reads: { delegation: (id) => none.reads.delegation(id), liveVaults: async () => ({ refs: [], complete: true }) } });
    expect(unpaid.outcomes.map(quoteWorld.words)).toStrictEqual(['excluded failed no_live_vault', 'excluded failed no_live_vault', 'excluded failed no_live_vault']);
    expect(quoteWorld.footprint(none).paid).toBe(0);

    const changed = await quoteWorld.world();
    const several = { refs: [refOf('first live vault'), refOf('second live vault')], complete: true };
    const result = await changed.run(changed.input(), { ...changed.deps, reads: {
      delegation: (id) => changed.reads.delegation(id),
      liveVaults: async (id, at) => changed.booked.posted === 0 ? changed.reads.liveVaults(id, at) : several,
    } });
    expect(result.outcomes.map(quoteWorld.words)).toStrictEqual(['accepted', 'excluded failed several_live_vaults', 'excluded failed several_live_vaults']);
    expect(changed.booked).toStrictEqual({ posted: 1, accepted: 1 });
    expect(request).toContain('`no_live_vault` or `several_live_vaults` prevents that Pay. Neither code undoes earlier quote hires.');
    expect(request).toContain('The agent can have already paid for the shortlist even if it paid for no quote.');
  });

  test('the job pays the quotes first: when the sub-delegation of a scorer fails, the quotes stay paid and the job ends with no ranking and the code of the sub-delegation', async () => {
    for (const code of SUB_CODES) {
      const w = world();
      w.script.shortlist = async () => shortlistAnswer([GOLDEN_ALFA]);
      w.script.scoring = async () => ({ ok: false, code, decisions: [] });
      const result = await w.run();
      // Before the quotes the job reads the delegate of the delegation and its key, and nothing else of the delegation.
      expect(w.trace, code).toStrictEqual(['delegation', 'delegateKeyOf', 'discover', 'shortlist', 'quotes', 'scoring']);
      expect(result, code).toMatchObject({ outcome: 'failed', exit_state: 'Failed', reason: code, document: null, salt: null, proposal_digest: null });
      if (result.outcome !== 'failed') throw new Error('the job must fail');
      expect([result.sub_jobs.length, result.quotes.map((record) => record.accepted)], code).toStrictEqual([1, ['confirmed']]);
    }
    expect(request).toContain('The agent makes the sub-delegations after the quote hires.');
    expect(request).toContain('If scoring fails, the job returns no ranking. The job does not undo earlier quote payments or model hires.');
  });

  test('the buyer bond returns separately, so an accepted quote still charges the full lock to the period limit', async () => {
    const q = await quoteWorld.world({ limit: { ...quoteWorld.LIMIT, perTx: 3_000_000n, total: 3_000_000n } });
    const result = await q.run();
    expect(result.outcomes.map(quoteWorld.words)).toStrictEqual(['accepted', 'excluded failed vault_refused', 'excluded failed vault_refused']);
    expect(q.booked).toStrictEqual({ posted: 1, accepted: 1 });
    const [first] = result.outcomes;
    if (first?.kind !== 'accepted') throw new Error('the first quote must be accepted');
    const escrow = q.chain.escrowDatum(first.record.escrow_ref)!;
    const original = q.chain.vault(q.vault)!;
    const fullLock = escrow.payment_lovelace + escrow.supplier_bond_lovelace + escrow.buyer_bond_lovelace;
    const live = q.chain.vaults().filter((vault) => !vault.consumed);
    expect(live).toMatchObject([
      { kind: 'Live', spent: fullLock, lovelace: original.lovelace - fullLock },
      { kind: 'Returned', owner: original.owner, lovelace: escrow.buyer_bond_lovelace },
    ]);
  });

  test('a decision that fails ends the whole job with the code of the decision: the quote that the agent accepted before it stays paid and gets no ranking', async () => {
    // The fan-out: the first bidder is accepted, the decision on the second fails, the third bidder is not paid, and the loop reports the code of the decision.
    const q = await quoteWorld.world();
    q.accept.answer = (given) => (given.quote.desk_did === quoteSupport.BRAVO.did ? { ok: false, code: 'model_output_invalid' } : quoteSupport.rightAnswer(given));
    const fan = await q.run();
    expect(fan.outcomes.map(quoteWorld.words)).toStrictEqual(['accepted', 'excluded failed decision_failed', 'excluded failed not_attempted']);
    expect(fan.stopped).toStrictEqual({ code: 'model_output_invalid' });
    expect(q.booked.accepted).toBe(1);
    expect(quoteWorld.hired(fan.outcomes, 1).record.accepted).toBe('no');
    expect(quoteWorld.footprint(q)).toMatchObject({ paid: 2, asked: 2, challenges: 0 });
    // The job: it stops with the code of the decision, it holds the accepted quote, and it makes no ranking.
    const w = world();
    w.script.quotes = async () => fanOf([acceptedOf(GOLDEN_ALFA, 1, 'alfa'), excludedOf(GOLDEN_BRAVO, 'failed', 'decision_failed'), excludedOf(GOLDEN_CHARLIE, 'failed', 'not_attempted')], { code: 'model_output_invalid' });
    const result = await w.run();
    expect(w.trace).toStrictEqual(['delegation', 'delegateKeyOf', 'discover', 'shortlist', 'quotes']);
    expect(result).toMatchObject({ outcome: 'failed', exit_state: 'Failed', reason: 'model_output_invalid', document: null, salt: null, proposal_digest: null });
    if (result.outcome !== 'failed') throw new Error('the job must fail');
    expect([result.sub_jobs.length, result.quotes.map((record) => [record.desk_did, record.accepted])]).toStrictEqual([1, [[GOLDEN_ALFA, 'confirmed']]]);
    expect(request).toContain('If the decision fails, the quote step marks this bidder `failed` with `decision_failed` and does not pay any later bidder.');
    expect(request).toContain("The job ends `failed` with the decision's code as its `reason`, for example `model_output_invalid`. There is no ranking. Quotes accepted earlier stay paid.");
    expect(row(sub('Errors'), '`decision_failed`')).toContain("bidder code from the quote step when `accept_quote` fails. The quote hires stop. The job's `reason` is the decision's code");
  });
});

describe('specs/sourcing-agent.md, the checks in code, the order of the ranking, the keys and the deadlines', () => {
  const request = sub('Request');

  afterEach(() => {
    vi.useRealTimers();
    quoteWorld.cleanWorlds();
  });

  test('five checks in code come before the model, each with its own code, and a quote that passes all five goes to the model', async () => {
    const quote = QUOTE as unknown as Record<string, unknown>;
    const delivered = (given: unknown, supplier: string = keyHashOf('the supplier of a check')): VerifiedDelivery => {
      const body = typeof given === 'string' ? given : JSON.stringify(given);
      const escrow = refOf('the escrow of a check');
      return {
        escrow_ref: escrow, advert_ref: ALFA_FILE.advert_ref, text: body, result: typeof given === 'string' ? null : (given as JsonObject),
        receipt: { escrow_ref: escrow, supplier_pkh: supplier, response_hash: made('the answer of a check'), agent_did: ALFA }, receipt_signature: made('the signature of a check', 'sha512'), verification: VERIFICATION,
      };
    };
    const judged = async (delivery: VerifiedDelivery): Promise<{ answer: unknown; learned: unknown; asked: number }> => {
      let asked = 0;
      const judge = judgeQuote(
        {
          acceptQuote: async () => {
            asked += 1;
            return { ok: true, decision: ACCEPT_DECISION_RECORD, choice: { accept: true, mismatch: [] } };
          },
          note: () => undefined,
        },
        RFQ, { did: ALFA, organisation: ALFA_FILE.organisation }, { list: ALFA_LIST, sha256: ALFA_LIST_SHA },
      );
      const answer = await judge.decide(delivery);
      return { answer, learned: judge.learned(), asked };
    };
    const cases: ReadonlyArray<readonly [string, VerifiedDelivery, string]> = [
      ['an answer that is no quote', delivered('this is not a quote'), 'quote_invalid'],
      ['a quote of another bidder', delivered({ ...quote, desk_did: BRAVO }), 'quote_not_from_bidder'],
      ['a quote for another request', delivered({ ...quote, rfq_id: 'rfq-other' }), 'quote_not_for_rfq'],
      ['a quote from another price list', delivered({ ...quote, price_list_sha256: made('another price list') }), 'quote_not_from_list'],
      ['a receipt that names no key hash of the supplier', delivered(quote, 'no key hash'), 'delivery_not_recordable'],
    ];
    for (const [what, delivery, code] of cases) expect(await judged(delivery), what).toStrictEqual({ answer: { accept: false, reason: code }, learned: { said: code }, asked: 0 });
    expect(await judged(delivered(quote))).toMatchObject({ answer: { accept: true }, asked: 1 });
    const offList = quoteTotals(LINES.map((line, i) => ({ ...line, unit_price: line.unit_price + (i === 0 ? 1 : 0) })));
    if (offList === null) throw new Error('The off-list quote has no totals.');
    expect(await judged(delivered({ ...QUOTE, ...offList }))).toMatchObject({ answer: { accept: true }, asked: 1 });
    expect(request).toContain(
      'Then five checks in code come before the model: the answer must be a quote (`quote_invalid`), it must come from this bidder (`quote_not_from_bidder`), it must answer this request (`quote_not_for_rfq`), it must name the price list that the agent read (`quote_not_from_list`), and the receipt must name the key hash of the supplier, so that the agent can record the delivery (`delivery_not_recordable`). The list check compares hashes, not unit prices. A check that fails files no challenge.',
    );
    expect(request).toContain('An off-list price can pass this decision and enter the ranking.');
    expect(sub('Errors')).toContain('so the delivery cannot be recorded (the fifth check in code, step 4 of `propose`)');
  });

  test('an invitation with a repeated DID is model_output_invalid', () => {
    const ask = (invite: readonly Did[]) => readAnswer({ text: JSON.stringify({ reasoning: 'The invitation of the test.', choice: { invite, not_invited: [] } }), status: 'completed' }, SHORTLIST_DECISION.parse);
    expect(ask([ALFA, ALFA])).toMatchObject({ ok: false, code: 'model_output_invalid' });
    expect(ask([ALFA, BRAVO])).toMatchObject({ ok: true });
    expect(request).toContain('An invitation that holds a DID two times is no choice: the hire ends with `model_output_invalid`.');
  });

  test('an order that repeats a DID is no choice (model_output_invalid), and an order that leaves out a scored bidder or names another DID ends the job with ranking_invalid', async () => {
    const ask = (order: readonly Did[]) => readAnswer({ text: JSON.stringify({ reasoning: 'The order of the test.', choice: { order, tie_break: '' } }), status: 'completed' }, RANKING_DECISION.parse);
    expect(ask([ALFA, ALFA])).toMatchObject({ ok: false, code: 'model_output_invalid' });
    expect(ask([ALFA, BRAVO])).toMatchObject({ ok: true });
    const jobWith = async (order: readonly Did[]) => {
      const w = world();
      w.script.shortlist = async () => shortlistAnswer([GOLDEN_ALFA, GOLDEN_BRAVO]);
      w.script.rank = async () => rankAnswer(order);
      return w.run();
    };
    for (const order of [[GOLDEN_ALFA], [GOLDEN_ALFA, GOLDEN_CHARLIE], [GOLDEN_ALFA, GOLDEN_BRAVO, GOLDEN_CHARLIE]]) {
      const result = await jobWith(order);
      expect(result, order.join()).toMatchObject({ outcome: 'failed', reason: 'ranking_invalid', document: null });
      if (result.outcome !== 'failed') throw new Error('the job must fail');
      expect(result.decisions.map((decision) => decision.name).at(-1)).toBe('ranking');
    }
    expect(proposed(await jobWith([GOLDEN_BRAVO, GOLDEN_ALFA])).document).not.toBeNull();
    expect(request).toContain('An order that repeats a DID is no choice: the hire ends with `model_output_invalid`. An order that leaves out a scored bidder, or names a DID that is not scored, ends the job with `ranking_invalid`.');
    expect(sub('Errors')).toContain('or the order of the model leaves out a scored bidder or names a DID that is not scored |');
  });

  test('an unaccepted delivery stays Submitted and cannot be reclaimed; only a no of the model can start a challenge', async () => {
    const delivered = async (arrange: (q: quoteWorld.World) => void): Promise<{ word: string; escrow: string; challenges: number; accepted: number }> => {
      const q = await quoteWorld.world();
      arrange(q);
      const result = await q.run(q.input({ invited: [quoteSupport.bidderOf(quoteSupport.BRAVO)] }));
      const outcome = quoteWorld.hired(result.outcomes, 0);
      await expect(q.chain.reclaim(outcome.record.escrow_ref)).rejects.toThrow('Reclaim needs Open or Claimed');
      return { word: quoteWorld.words(outcome), escrow: await q.chain.escrowState(outcome.record.escrow_ref), challenges: quoteWorld.footprint(q).challenges, accepted: q.booked.accepted };
    };
    const kept = (word: string, challenges = 0): { word: string; escrow: string; challenges: number; accepted: number } => ({ word, escrow: 'Submitted', challenges, accepted: 0 });
    expect(await delivered((q) => void (q.desks.bravo.answer = () => 'this is not a quote'))).toStrictEqual(kept('excluded failed quote_invalid'));
    expect(await delivered((q) => void (q.accept.answer = () => ({ ok: false, code: 'model_output_invalid' })))).toStrictEqual(kept('excluded failed decision_failed'));
    expect(await delivered((q) => void (q.desks.bravo.answer = () => quoteSupport.quoteText(quoteSupport.BRAVO, quoteSupport.priced('SYR-10ML', 30))))).toStrictEqual(kept('excluded disputed none', 1));
    vi.useFakeTimers();
    expect(
      await delivered((q) => {
        q.accept.answer = () => {
          vi.advanceTimersByTime(DECISION_WINDOW_MS);
          return new Promise<never>(() => undefined);
        };
      }),
    ).toStrictEqual(kept('excluded failed decision_timeout'));
    vi.useRealTimers();
    expect(ACCEPT_WINDOW_MS).toBe(600_000);
    expect(section('Terms')).toContain('This can follow a failed check, a failed or late decision, or a no from the model. The Bid Desk may then Release the escrow after the same 600 s window.');
  });

  test('the key of the live delegation signs the proof of the token of execute only, and each scorer signs the proof of its own token with its own delegation key', () => {
    const sourceDir = new URL('agents/sourcing-agent/src/', root);
    const files = (readdirSync(sourceDir, { recursive: true }) as string[]).map(String).filter((file) => file.endsWith('.ts'));
    const using = (call: string): string[] => files.filter((file) => readFileSync(new URL(file, sourceDir), 'utf8').includes(call)).sort();
    expect(using('requestRouteToken(')).toStrictEqual(['execute/execute.ts']);
    expect(using('requestSubagentToken(')).toStrictEqual(['scoring/scoring.ts']);
    expect(text('agents/sourcing-agent/src/execute/execute.ts')).toContain('dpopKey: entry.dpopKey');
    expect(text('packages/usecase-kit/src/access/token.ts')).toContain('dpopKey: request.subagent.delegationKey,');
    const access = text('packages/usecase-kit/src/access/subdelegation.ts');
    expect(access).toContain('signAll(built.txCbor, built.requiredSigners, [plan.agentSigner, plan.subagentSigner])');
    expect(access).toContain('signAll(built.txCbor, built.requiredSigners, [plan.agentSigner])');
    const identity = section('Identity');
    expect(row(identity, 'Delegation keys')).toContain('and signs the proof of the token of `execute`. It also signs the Delegate and the Undelegate of each sub-delegation. It signs no other token proof: each scorer signs the proof of its own token request with its own delegation key.');
    expect(row(identity, 'Subagents')).toContain('The delegation key of a scorer signs the proof of its token request. It also signs the Delegate of its sub-delegation, together with the live delegation key of the agent.');
  });

  test('a scorer counts its 720000 ms to the scoring deadline, which is the job deadline less 120000 ms, and an Undelegate that fails goes to the janitor', async () => {
    expect([SCORER_NEED_MS, RANKING_RESERVE_MS]).toStrictEqual([720_000, 120_000]);
    expect(RUN.w.calls.scoring[0]?.input.deadline_ms).toBe(PROPOSE_NOW + JOB_DEADLINE_MS - RANKING_RESERVE_MS);
    const w = scoringWorld();
    w.chain.faults.submitUndelegateThrows = true;
    expect((await w.run()).ok).toBe(true);
    expect(w.sink.entries.size).toBe(3);
    w.chain.faults.submitUndelegateThrows = false;
    expect((await janitorOnce(w)).entries.map((entry) => entry.state)).toStrictEqual(['ended', 'ended', 'ended']);
    expect(w.sink.entries.size).toBe(0);
    expect(request).toContain('A scorer needs 720000 ms left when its Delegate is sent. The count runs to the scoring deadline, which is the job deadline less 120000 ms. With less, it sends nothing and the job ends `failed` with `deadline`.');
    expect(request).toContain('An Undelegate that fails changes no result: the sub-delegation goes to the janitor of the service, which ends it later.');
    expect(section('Operator and data handling')).toContain('| `left/` | the sub-delegations that a job left behind, which their janitor ends |');
  });

  test('execute ends failed with deadline when a step cannot start before its deadline of 120000 ms, and a call that was sent and gets no answer in time is mock_system_failed', async () => {
    expect(EXECUTE_FAILURES).toEqual(expect.arrayContaining(['deadline', 'mock_system_failed']));
    const x = executeWorld();
    expect(executeWords(await x.run(x.request(), x.arrived - EXECUTE_DEADLINE_MS))).toBe('failed deadline Failed');
    expect(executeFootprint(x)).toStrictEqual(UNTOUCHED);
    expect(text('packages/usecase-kit/src/access/call.ts')).toContain('if (bounded.timedOut) return failed(null, null, true, `the system did not answer within');
    expect(text('agents/sourcing-agent/src/execute/execute.ts')).toContain("return { kind: 'failed', status: sent.status, sent: sent.sent };");
    expect(request).toContain(
      'The job deadline of 120000 ms bounds every step. A step that cannot start before the deadline ends the job `failed` with `deadline`: this holds for the two reads of the ledger, the token request and the call. A read or a token request that is still open at the deadline ends the job in the same way. A call that was sent and does not end in time ends the job `failed` with `mock_system_failed`, and it can have written the ranking.',
    );
  });
});

describe('specs/sourcing-agent.md, Interface, Response', () => {
  const response = sub('Response');

  test('the Response example is the proposal that the real job makes over scripted ports, byte for byte, with a label salt and the digest of that salt', () => {
    expect(page.match(/^### Response$/gm)).toHaveLength(1);
    expect(manifest.interface.response_schema.$ref.endsWith('/specs/sourcing-agent.md#response')).toBe(true);
    expect(jsonBlocks(response)[0]).toBe(JSON.stringify(PROPOSED, null, 2));
    // The real job made a digest of its own salt, and the example swaps the salt and the digest for a salt of a label and its digest, which is the digest of that salt and the same document.
    expect(must(proposalDigest(RUN.result.salt, RUN.result.document))).toBe(RUN.result.proposal_digest);
    expect(RUN.result.salt).not.toBe(SALT);
    expect(must(proposalDigest(PROPOSED.salt, PROPOSED.document))).toBe(PROPOSED.proposal_digest);
    expect(response).toContain('The salt of a real job is random: the example shows a salt that is made from a label, with the digest of that salt and the document.');
    expect(response).toContain('The example is an illustration and not a recorded run. Its references, hashes, key hashes and signatures are made from labels, and they belong to no escrow, no Bid Desk and no key.');
    // The prices are those of the published list of Bid Desk Alfa, and the hash of the price list is the hash of that file.
    expect(PROPOSED.quotes[0].result).toMatchObject({ price_list_sha256: priceListSha256(ALFA_LIST_TEXT), total: 19500, lead_time_days: 14 });
    expect(response).toContain('The prices are those of the published price list of Bid Desk Alfa for the items, and the hash of the price list is the hash of that file.');
    // The job called each port once, in order, and the example has two candidates, one invitation, one record, one quote job and four decisions.
    expect(RUN.w.trace).toStrictEqual(['delegation', 'delegateKeyOf', 'discover', 'shortlist', 'quotes', 'scoring', 'rank']);
    expect([PROPOSED.bidders.length, PROPOSED.quotes.length, PROPOSED.sub_jobs.length, PROPOSED.decisions.length]).toStrictEqual([2, 1, 1, 4]);
    expect(PROPOSED.decisions.map((decision) => decision.name)).toStrictEqual(['shortlist', 'accept_quote', 'score', 'ranking']);
    expect(response).toContain('The example has two candidates: the model invites one, so `bidders` has two files, `quotes` has one record, and the ranking lists the other candidate as excluded.');
  });

  test('the proposal: the table names its members, the example holds them in the order of the result, and fault_mode is last and empty', () => {
    const shown = JSON.parse(jsonBlocks(response)[0]) as Record<string, unknown>;
    const keys = Object.keys(shown);
    // The proposal that the example result holds is a proposal for the kit: its digest is the digest of its document and its salt, and its document is a ranking.
    const { document, salt, proposal_digest: digest } = shown as { document: unknown; salt: unknown; proposal_digest: unknown };
    expect(must(parseProposal({ document, salt, proposal_digest: digest }))).toStrictEqual(PROPOSAL);
    expect(must(parseRanking(document)).ranked).toHaveLength(1);
    expect(keys).toStrictEqual(['schema', 'use_case', 'decisions', 'sub_jobs', 'document', 'salt', 'proposal_digest', 'outcome', 'exit_state', 'reason', 'bidders', 'quotes', 'fault_mode']);
    expect(namesOf(firstCells(response, '| Member | Content |')).sort()).toStrictEqual([...keys].sort());
    expect(shown).toMatchObject({ schema: 'vector.usecase.proposal.v1', use_case: 'bid-evaluation', outcome: 'proposed', exit_state: null, reason: null, fault_mode: '' });
    expect(PROPOSE_OUTCOMES).toStrictEqual(['proposed', 'failed']);
    // Each decision holds the sub-job that bought it, and the sub-jobs of the result are the quote jobs: no decision job is among them.
    for (const decision of shown.decisions as Decision[]) expect(Object.keys(decision.inference.sub_job)).toStrictEqual(['capability_id', 'advert_ref', 'escrow_ref', 'supplier_pkh', 'receipt', 'receipt_signature', 'verification']);
    expect((shown.sub_jobs as SubJob[]).map((job) => job.capability_id)).toStrictEqual([BID_CAPABILITIES.quote]);
    expect((shown.decisions as Decision[]).every((decision) => decision.inference.sub_job.capability_id === 'llm.text.generate.v1')).toBe(true);
    expect(MODEL).toBe(manifest.behaviour.model.allowlist[0]);
  });

  test('the member of the record of a quote are the ones that the table names, and the fault mode and the failed result are the ones that the page says', async () => {
    expect(Object.keys(PROPOSED.quotes[0])).toStrictEqual(['desk_did', 'advert_ref', 'escrow_ref', 'paid_from_vault', 'receipt', 'receipt_signature', 'verification', 'result', 'accepted', 'challenge']);
    for (const member of Object.keys(PROPOSED.quotes[0])) expect(row(response, '`quotes`'), member).toContain(`\`${member}\``);
    // A failed `propose` keeps what the job paid for and read, and its document, salt and digest are null.
    const failing = world();
    failing.script.delegation = async () => ({ delegate: agentIdOf(AGENT), chain_whole: true });
    failing.script.discover = async () => ({ ok: true, value: { bidders: [ALFA_VIEW, BRAVO_VIEW] } });
    failing.script.shortlist = async () => ({ ok: true, decision: SHORTLIST_DECISION_RECORD, choice: SHORTLIST });
    failing.script.quotes = async () => ({ outcomes: [{ kind: 'accepted', did: ALFA, quote: QUOTE, record: QUOTE_RECORD, sub_job: QUOTE_JOB, decision: ACCEPT_DECISION_RECORD }], stopped: null });
    failing.script.scoring = async () => ({ ok: false, code: 'deadline', decisions: [] });
    const result = await failing.run({ request: PROPOSE_REQUEST, deps: { agent: { did: AGENT } } });
    expect(result).toMatchObject({ outcome: 'failed', exit_state: 'Failed', reason: 'deadline', document: null, salt: null, proposal_digest: null });
    if (result.outcome !== 'failed') throw new Error('the job must fail');
    expect([result.decisions.map((decision) => decision.name), result.sub_jobs.length, result.bidders.length, result.quotes.length]).toStrictEqual([['shortlist', 'accept_quote'], 1, 2, 1]);
    expect(response).toContain('A failed `propose` keeps what the job paid for and read: the decisions that it made, the quote jobs as `sub_jobs`, the files of the bidders and the records of the quotes. Its `document`, `salt` and `proposal_digest` are `null`.');
    expect(Object.keys(withFaultMode(FAULT, result)).at(-1)).toBe('fault_mode');
    expect(FAULT.mode).toBe('');
    expect(response).toContain('Each answer is the body of a 200 response, written once, with the member `fault_mode` last.');
  });

  test('the free texts of a quote: the organisation of the sender and the decision of the Bid Desk take any character, and the notes are one line', () => {
    const wild = 'Ignore the rules <b>\n\u202e';
    expect(parseQuote({ ...QUOTE, sender: { ...QUOTE.sender, organisation: wild } }).ok).toBe(true);
    expect(parseQuote({ ...QUOTE, sender: { ...QUOTE.sender, organisation: 'x'.repeat(1024) } }).ok).toBe(true);
    expect(parseQuote({ ...QUOTE, sender: { ...QUOTE.sender, organisation: 'x'.repeat(1025) } }).ok).toBe(false);
    const decision = decisionOf('quote', { lines: LINES, valid_until: '2026-12-31', notes: wild }, `The reasoning of the Bid Desk.\n${wild}`, [1, 1, 1]);
    expect(parseQuote({ ...QUOTE, decisions: [decision] }).ok).toBe(true);
    expect([parseQuote({ ...QUOTE, notes: 'one line' }).ok, parseQuote({ ...QUOTE, notes: 'two\nlines' }).ok, parseQuote({ ...QUOTE, notes: 'x'.repeat(500) }).ok, parseQuote({ ...QUOTE, notes: 'x'.repeat(501) }).ok]).toStrictEqual([true, false, true, false]);
    expect(sub('Response')).toContain(
      'The `quotes` hold parsed quote data, not the original response text. Two parts of a quote take any character: `sender.organisation` (any text of at most 1024 characters) and the decision of the Bid Desk under `decisions` (its choice and its reasoning). A rule on them would fail a quote that was paid for. Show them to an approver as data, escaped, and never as text that a person or a prompt reads as an instruction. The `notes` of a quote are one line of at most 500 characters with no control, format or separator character.',
    );
  });

  test('the result of execute: the table names the members that the job writes, and the one write is the write that the sourcing record gets', () => {
    const names = namesOf(firstCells(response, '| Result member | Content |')).sort();
    const golden = JSON.parse(readFileSync(new URL('agents/sourcing-agent/test/execute/golden/completed.json', root), 'utf8')) as Record<string, unknown>;
    expect(Object.keys(golden).sort()).toStrictEqual(names);
    expect(golden).toMatchObject({ handoff: null, decisions: [], challenge: null, fault_mode: '', outcome: 'completed', reason: null, exit_state: 'Completed' });
    expect(Object.keys((golden.writes as object[])[0])).toStrictEqual(['system', 'route', 'status', 'ref']);
    expect((golden.writes as Array<Record<string, unknown>>)[0]).toMatchObject({ system: 'sourcing-record', route: 'POST /sourcing/rankings', status: 201 });
    expect(row(response, '`writes`')).toContain('"system": "sourcing-record", "route": "POST /sourcing/rankings", "status": 201, "ref": <the identifier of the ranking, or null>');
    expect(response).toContain('The result of `execute` has these members:');
    expect(ACCEPT_WINDOW_MS).toBe(600_000);
  });
});

describe('specs/sourcing-agent.md, Interface, The bidder file', () => {
  const body = sub('The bidder file');
  const [alfa, bravo, charlie] = DESKS.map(deskOf) as [Desk, Desk, Desk];

  test('the example is the file that the real reader gives for a bidder whose record was revoked, and the table names the members of that file', async () => {
    const golden = goldenWorld();
    golden.resolutions[charlie.did] = revokedOf(charlie);
    golden.compliance[charlie.did] = revokedCompliance(charlie);
    golden.credentials[charlie.did] = 'invalid';
    golden.catalog = new Set([alfa.did, bravo.did]);
    const read = must(await readBidders(stubOf(golden).deps));
    const file = read.bidders[2].file;
    expect(jsonBlocks(body)[0]).toBe(JSON.stringify(file, null, 2));
    expect(file).toStrictEqual(JSON.parse(readFileSync(new URL('agents/sourcing-agent/test/bidders/golden/file-revoked.json', root), 'utf8')));
    expect(namesOf(firstCells(body, '| File member | What it holds |'))).toStrictEqual(Object.keys(file));
    expect(namesOf(firstCells(body, '| Member of `lineage` | What it holds |'))).toStrictEqual(Object.keys(file.lineage));
    expect(namesOf(firstCells(body, '| Member of `compliance` | What it holds |')).sort()).toStrictEqual(Object.keys(file.compliance).sort());
    expect(body).toContain('The example is the file of a bidder whose record was revoked.');
  });

  test('the candidates: at most 8, in the plain text order of their advert references, and a DID with two Active adverts is no candidate', async () => {
    const many = goldenWorld();
    for (const index of [0x05, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99]) addDesk(many, extraDesk(index));
    const refs = many.rows.map((rowOfIndexer) => rowOfIndexer.utxo_ref).sort();
    expect(refs).toHaveLength(10);
    const read = must(await readBidders(stubOf(many).deps));
    expect(MAX_CANDIDATES).toBe(8);
    expect(read.bidders.map((view) => view.file.advert_ref)).toStrictEqual(refs.slice(0, MAX_CANDIDATES));
    const twice = goldenWorld();
    const second = `${'0a'.repeat(32)}#0`;
    twice.rows.push(rowOf(alfa, { utxo_ref: second }));
    twice.reads[second] = twice.reads[alfa.ref];
    expect(must(await readBidders(stubOf(twice).deps)).bidders.map((view) => view.file.did)).toStrictEqual([bravo.did, charlie.did]);
    for (const part of [
      'A Bid Desk is a candidate when four things hold.',
      'The marketplace indexer lists an Active advert of it with the capability `supplychain.rfq.quote.v1` and the model `bid-desk-v1`.',
      'The chain shows that advert unspent and Active, with the same capability, the same model and the DID of the bidder as its agent.',
      'The record of the DID lists the supplier key of the advert as an Ed25519 key with the transaction purpose.',
      'And the DID has one such advert: a DID with two Active adverts is no candidate, because the agent never picks one of two.',
      'A bidder whose record ended, whose DID has no record, or whose record cannot be read stays a candidate, and its file shows the status.',
      'The candidates are in the order of their advert references, compared as plain text, and the first 8 stay.',
    ]) expect(body, part).toContain(part);
    expect([BID_CAPABILITIES.quote, BID_DESK_MODEL]).toStrictEqual(['supplychain.rfq.quote.v1', 'bid-desk-v1']);
  });

  test('a source that cannot be read is `unreadable` or null and never absent, valid or a number, and a price list has three states', async () => {
    const golden = goldenWorld();
    const base = stubOf(golden).deps;
    const down = async (): Promise<never> => {
      throw new Error('no answer');
    };
    const broken = stubOf(golden, { stake: down, cases: down, catalog: down, credential: down, compliance: down, fetchBytes: async (url, limits) => (url === bravo.listUrl ? down() : base.fetchBytes(url, limits)) });
    golden.files[charlie.listUrl] = ok(`${priceListText('charlie')} `);
    const files = must(await readBidders(broken.deps)).bidders.map((view) => view.file);
    for (const file of files) {
      expect([file.stake_lovelace, file.cases_against, file.in_catalog, file.credential]).toStrictEqual([null, null, null, 'unreadable']);
      expect(file.compliance).toStrictEqual({ state: 'unreadable', attestation: null, attestation_state: null, issued_at: null, valid_until: null, revoked_at: null, revoke_reason: null, contested: null });
    }
    expect(files.map((file) => file.price_list)).toStrictEqual(['valid', 'unreadable', 'invalid']);
    const states = (name: string): string[] => [...(text(`agents/sourcing-agent/src/bidders/types.ts`).split(`export type ${name} = `)[1] ?? '').split(';')[0].matchAll(/'([a-z_]+)'/g)].map((hit) => hit[1]);
    expect(states('FactState')).toStrictEqual(['valid', 'invalid', 'absent', 'unreadable']);
    expect(states('BidderStatus')).toStrictEqual(['active', 'suspended', 'revoked', 'retired', 'not_found', 'unreadable']);
    for (const word of EFFECTIVE_REASONS) expect(row(body, '`status_reason`'), word).toContain(`\`${word}\``);
    expect(EFFECTIVE_REASONS).toHaveLength(7);
    for (const part of [
      'The states of a fact are `valid`, `invalid`, `absent` and `unreadable`. `unreadable` means that the source gave no answer in time or gave an answer that the agent cannot read. It is never `absent`, never `valid` and never a number: a stake that cannot be read is `null` and never `"0"`, and a catalog that cannot be read is `null` and never "not in the catalog".',
      'Only an attestation of the issuer `keys.compliance_issuer_pkh` of the manifest counts. An attestation of another issuer is not counted and not shown.',
    ]) expect(body, part).toContain(part);
    expect(Object.keys(manifest.keys)).toContain('compliance_issuer_pkh');
  });

  test('a file that the model reads holds less than the file of the proposal: three members stand as booleans, and the other six are left out', async () => {
    const golden = goldenWorld();
    golden.resolutions[charlie.did] = revokedOf(charlie);
    golden.compliance[charlie.did] = revokedCompliance(charlie);
    const file = must(await readBidders(stubOf(golden).deps)).bidders[2].file;
    const facts = bidderFacts(file) as { accountable: unknown; lineage: Record<string, unknown>; compliance: Record<string, unknown> };
    const shown = JSON.stringify(facts);
    expect([typeof facts.accountable, typeof facts.lineage.has_successor, typeof facts.compliance.replied]).toStrictEqual(['boolean', 'boolean', 'boolean']);
    for (const name of ['advert_ref', 'organisation']) expect(Object.keys(facts), name).not.toContain(name);
    for (const left of [file.advert_ref, file.compliance.attestation, file.compliance.issued_at, file.compliance.revoke_reason, file.compliance.contested?.sha256, file.lineage.successor]) {
      if (typeof left === 'string' && left.length > 1) expect(shown, left).not.toContain(left);
    }
    for (const name of ['attestation', 'issued_at', 'revoke_reason', 'contested']) expect(Object.keys(facts.compliance), name).not.toContain(name);
    expect(body).toContain('A file that the model reads holds less: it has no advert reference, no organisation, no identifier of an attestation, no reason of a revoke, no time of issue, and no hash of a reply. It shows three of these as booleans: whether an Accountable Party covers the record, whether the record names a successor, and whether the bidder replied.');
    expect(body).toContain('No free text of a bidder reaches a file. A member is a word of a closed list, a number, a boolean, a hash, a domain, a DID or a time. A time is written as `YYYY-MM-DDTHH:MM:SSZ`.');
    expect(body).toContain('A fact is data and never a filter in code. The file holds no verdict.');
  });

  test('the words of the status and of the reason of a file are the words of the code, in both directions', () => {
    const cellOf = (line: string): string => line.split(' | ')[1] ?? '';
    expect(namesOf([cellOf(row(body, '`status`'))])).toStrictEqual(unionOf('agents/sourcing-agent/src/bidders/types.ts', 'BidderStatus'));
    const reasons = [...cellOf(row(body, '`status_reason`')).matchAll(/`([A-Za-z]+)`/g)].map((hit) => hit[1]).filter((word) => word !== 'active' && word !== 'null');
    expect([...reasons].sort()).toStrictEqual([...EFFECTIVE_REASONS].sort());
    expect(EFFECTIVE_REASONS).toHaveLength(7);
  });
});

describe('specs/sourcing-agent.md, Interface, The ranking', () => {
  const ranking = sub('The ranking');
  const document = PROPOSED.document as unknown;

  test('the tables name the members of the ranking, of an entry, of its quote and of an excluded entry, and the example ranking is one that the kit takes', () => {
    const parsed = must(parseRanking(document));
    expect(namesOf(firstCells(ranking, '| Member | Content |'))).toStrictEqual(Object.keys(parsed));
    expect(namesOf(firstCells(ranking, '| Member of an entry of `ranked` | Content |'))).toStrictEqual(Object.keys(parsed.ranked[0]));
    expect(namesOf(firstCells(ranking, '| Member of `quote` | Content |'))).toStrictEqual(Object.keys(parsed.ranked[0].quote));
    expect(namesOf(firstCells(ranking, '| Member of an entry of `excluded` | Content |'))).toStrictEqual(Object.keys(parsed.excluded[0]));
    const reasons = row(ranking, '`reason`');
    for (const reason of EXCLUDED_REASONS) expect(reasons, reason).toContain(`\`${reason}\``);
    expect(EXCLUDED_REASONS).toStrictEqual(['not_invited', 'not_active', 'refused', 'failed', 'disputed']);
    expect(parsed.excluded).toStrictEqual([{ desk_did: BRAVO, reason: 'not_invited', code: null }]);
    expect(parsed.ranked.map((entry) => [entry.rank, entry.desk_did, entry.organisation])).toStrictEqual([[1, ALFA, 'alfa.vector.apexfusion.org']]);
    expect(row(ranking, '`schema`')).toBe('| `schema` | `vector.usecase.ranking.v1` |');
    expect(parsed.schema).toBe('vector.usecase.ranking.v1');
    expect(parsed.rfq_sha256).toBe(must(rfqSha256(RFQ)));
    // The hash of the request is the sha256 of the canonical JSON of the request for quotation, and each quote names the same hash.
    expect(createHash('sha256').update(must(canonicalJson(RFQ)), 'utf8').digest('hex')).toBe(parsed.rfq_sha256);
    expect(PROPOSED.quotes.map((record) => (record.result as { rfq_sha256: string }).rfq_sha256)).toStrictEqual([parsed.rfq_sha256]);
    expect(ranking).toContain('`rfq_sha256` | the sha256 of the canonical JSON of the request for quotation (`rfq_id`, `items` and `needed_by`). Every quote of the ranking names the same hash, so the approver and every Bid Desk talk about one request');
  });

  test('the receipt_sha256 of an entry is the sha256 of the canonical JSON of { receipt, signature }, and the entry takes the escrow, the total and the lead time of the record and the quote that the agent holds', () => {
    const parsed = must(parseRanking(document));
    for (const entry of parsed.ranked) {
      const record = PROPOSED.quotes.find((candidate) => candidate.escrow_ref === entry.quote.escrow_ref);
      if (record === undefined) throw new Error('no record holds the escrow of the entry');
      const receipt = record.receipt as JsonObject;
      const signature = record.receipt_signature as string;
      const signed = must(canonicalJson({ receipt, signature }));
      expect(createHash('sha256').update(signed, 'utf8').digest('hex')).toBe(entry.quote.receipt_sha256);
      expect(must(receiptSha256(receipt, signature))).toBe(entry.quote.receipt_sha256);
      expect(entry.quote).toStrictEqual({ escrow_ref: record.escrow_ref, receipt_sha256: entry.quote.receipt_sha256, total: QUOTE.total, lead_time_days: QUOTE.lead_time_days });
      expect([entry.score, entry.components]).toStrictEqual([SCORE.score, SCORE.components]);
    }
    for (const part of [
      '| `receipt_sha256` | the sha256 of the canonical JSON of `{ receipt, signature }`: the signed receipt of the quote job. The record of the quote under `quotes` has the receipt and its signature |',
      'Compare that hash with `receipt_sha256`. A change to `quotes[].result` does not change this hash.',
      'To verify the quote independently, obtain the exact original quote response bytes. Check their SHA-256 against `receipt.response_hash`. Verify the Ed25519 signature over the canonical receipt with the Bid Desk supplier key.',
      'If you cannot obtain them, you can review the parsed quote, but you cannot verify the Bid Desk\'s quote from the proposal alone.',
      'The job builds it from the quote that the agent holds and accepted: the escrow of its record, the hash of its signed receipt, and the total and the lead time of the parsed quote.',
    ]) expect(ranking, part).toContain(part);
    expect(ranking).toContain('The model never writes the `quote` member.');
  });

  test('the rank is the position, no code sorts by score, a score is a number from 0 to 100, and the organisation is a member only when it is verified', () => {
    // The builder gives the ranks by position: an order that puts the lower score first stays as it is.
    const entry = (did: Did, score: number, organisation?: string) => ({
      desk_did: did, ...(organisation === undefined ? {} : { organisation }), score, components: { price: score, lead_time: score, reliability: score, compliance: score }, quote: { escrow_ref: refOf(`the escrow of ${did}`), receipt_sha256: made(`the receipt of ${did}`), total: 1, lead_time_days: 1 },
    });
    const built = must(buildRanking({ rfq: RFQ, tenant: TENANT, weights: WEIGHTS, entries: [entry(BRAVO, 40.5, 'bravo.vector.apexfusion.org'), entry(ALFA, 90)], excluded: [] }));
    expect(built.ranked.map((item) => [item.rank, item.desk_did, item.score])).toStrictEqual([[1, BRAVO, 40.5], [2, ALFA, 90]]);
    expect(Object.hasOwn(built.ranked[1], 'organisation')).toBe(false);
    expect(parseRanking({ ...built, ranked: [{ ...built.ranked[0], organisation: null }] }).ok).toBe(false);
    expect(parseRanking({ ...built, ranked: [{ ...built.ranked[0], rank: 2 }] }).ok).toBe(false);
    expect([entry(ALFA, 100), entry(ALFA, 0), entry(ALFA, 100.1), entry(ALFA, -0.1)].map((item) => buildRanking({ rfq: RFQ, tenant: TENANT, weights: WEIGHTS, entries: [item], excluded: [] }).ok)).toStrictEqual([true, true, false, false]);
    expect(text('agents/sourcing-agent/src/propose/ranking.ts')).toContain('it gives the ranks by position, never sorts, never changes a score');
    expect(text('agents/sourcing-agent/src/model/rank.ts')).toContain('no code sorts by score');
    expect(text('agents/sourcing-agent/src/model/score.ts')).toContain('No code\n// checks that the score follows from the four parts and the weights: the model decides the numbers.');
    for (const part of [
      'The model gives the order and nothing else. No code sorts by score: an order that does not follow the scores is an order that the model chose.',
      'The decision refuses an order that holds a DID two times (`model_output_invalid`). The job accepts the order only when it holds each scored bidder and no other DID (`ranking_invalid` otherwise).',
      'The score is not worked out again from the components and the weights: the model decides the numbers, and the job holds only that each number is from 0 to 100.',
      'It is a member only when the gateway verified the organisation: the sourcing record refuses the value `null`, so the member is left out when there is none |',
    ]) expect(ranking, part).toContain(part);
  });
});

describe('specs/sourcing-agent.md, the limits of the ranking, the order of the model and an organisation that is not verified', () => {
  const ranking = sub('The ranking');
  const entry = (did: Did, over: { score?: number; total?: number; organisation?: string } = {}): Omit<RankedEntry, 'rank'> => {
    const score = over.score ?? 50;
    return {
      desk_did: did, ...(over.organisation === undefined ? {} : { organisation: over.organisation }), score, components: { price: score, lead_time: score, reliability: score, compliance: score },
      quote: { escrow_ref: refOf(`the escrow of ${did}`), receipt_sha256: made(`the receipt of ${did}`), total: over.total ?? 1, lead_time_days: 1 },
    };
  };
  const built = (entries: readonly Omit<RankedEntry, 'rank'>[], excluded: readonly ExcludedEntry[] = []): boolean => buildRanking({ rfq: RFQ, tenant: TENANT, weights: WEIGHTS, entries, excluded }).ok;

  test('the ranked list and the excluded list have the limits that the kit takes, and the page gives those limits', () => {
    const some = (count: number, label: string): Did[] => Array.from({ length: count }, (_, index) => didOf(`${label} ${index}`));
    const rankedOk = (count: number): boolean => built(some(count, 'ranked').map((did) => entry(did)));
    const excludedOk = (count: number): boolean => built([entry(ALFA)], some(count, 'left out').map((did) => ({ desk_did: did, reason: 'not_invited' as const, code: null })));
    // The kit does not export its limits, so the most that it takes is found by trying.
    const most = (ok: (count: number) => boolean, from: number): number => {
      let count = from;
      while (count < 100 && ok(count + 1)) count += 1;
      return count;
    };
    expect([rankedOk(0), rankedOk(1), excludedOk(0), excludedOk(1)]).toStrictEqual([false, true, true, true]);
    const [mostRanked, mostExcluded] = [most(rankedOk, 1), most(excludedOk, 0)];
    expect([mostRanked, mostExcluded]).toStrictEqual([20, 20]);
    expect(row(ranking, '`ranked`')).toBe(`| \`ranked\` | the ranked bidders, 1 to ${mostRanked} entries, in the order that the model gave |`);
    expect(row(ranking, '`excluded`')).toBe(`| \`excluded\` | every candidate that is not ranked, with the reason: 0 to ${mostExcluded} entries |`);
  });

  test('the domain of an organisation, the score, the components and the total have the limits that the kit takes, and the page gives them', () => {
    const domain = (length: number): string => `${'a'.repeat(30)}.${'b'.repeat(length - 31)}`;
    const organisationOk = (organisation: string): boolean => built([entry(ALFA, { organisation })]);
    expect([organisationOk(domain(64)), organisationOk(domain(65)), organisationOk('a.b'), organisationOk('one-label'), organisationOk('Upper.example')]).toStrictEqual([true, false, true, false, false]);
    expect(row(ranking, '`organisation`')).toContain('as a lower-case domain of at least two labels and at most 64 characters.');
    const scoreOk = (score: number): boolean => built([entry(ALFA, { score })]);
    expect([scoreOk(0), scoreOk(100), scoreOk(40.5), scoreOk(-0.1), scoreOk(100.1)]).toStrictEqual([true, true, true, false, false]);
    expect(row(ranking, '`score`')).toBe('| `score` | the score of the quote, a number from 0 to 100 |');
    expect(row(ranking, '`components`')).toBe('| `components` | the four component scores `price`, `lead_time`, `reliability` and `compliance`, each a number from 0 to 100 |');
    const totalOk = (total: number): boolean => built([entry(ALFA, { total })]);
    expect([totalOk(0), totalOk(19_500), totalOk(1.5), totalOk(-1)]).toStrictEqual([true, true, false, false]);
    expect(row(ranking, '`total`')).toBe('| `total` | the total of the quote: a whole number |');
  });

  test('the agent builds the ranking in the order of the model: two bidders whose order is not the order of their scores keep that order, and the ranks are the positions', async () => {
    const bidder = (did: Did, score: number) => ({
      did, organisation: null, score, components: { price: score, lead_time: score, reliability: score, compliance: score },
      quote: { escrow_ref: refOf(`the escrow of ${did}`), receipt_sha256: made(`the receipt of ${did}`), total: 1, lead_time_days: 1 },
    });
    const byAgent = must(rankingOf({ rfq: RFQ, tenant: TENANT, weights: WEIGHTS, bidders: [bidder(BRAVO, 40), bidder(ALFA, 90)], excluded: [] }));
    expect(byAgent.ranked.map((item) => [item.rank, item.desk_did, item.score])).toStrictEqual([[1, BRAVO, 40], [2, ALFA, 90]]);
    // The whole job: the golden scores are 90 for Alfa and 70 for Bravo, and the model puts Bravo first.
    const w = world();
    w.script.shortlist = async () => shortlistAnswer([GOLDEN_ALFA, GOLDEN_BRAVO]);
    w.script.rank = async () => rankAnswer([GOLDEN_BRAVO, GOLDEN_ALFA]);
    const ranked = must(parseRanking(proposed(await w.run()).document)).ranked;
    expect(ranked.map((item) => [item.rank, item.desk_did, item.score])).toStrictEqual([[1, GOLDEN_BRAVO, 70], [2, GOLDEN_ALFA, 90]]);
    expect(ranked[0]!.score).toBeLessThan(ranked[1]!.score);
  });

  test('an organisation that the gateway did not verify is not shown: the file has none, the job passes none on, and the ranking has no organisation member for that bidder', async () => {
    // The reader: the Accountable Party of Bid Desk Bravo has an organisation that the gateway did not verify.
    const golden = goldenWorld();
    const bravo = deskOf('bravo');
    const party = { role: 'accountable', signer: ACCOUNTABLE.bravo, organisation: 'bravo.example.org', organisationVerified: false, rights: ['suspend', 'revoke'], notBefore: PARTY_SINCE };
    golden.resolutions[bravo.did] = resolvedOf(bravo, { ...metadataOf(bravo), vectorParties: [party] });
    const files = must(await readBidders(stubOf(golden).deps)).bidders.map((view) => view.file);
    expect(files.map((file) => [file.organisation, file.organisation_verified])).toStrictEqual([['alfa.example.org', true], [null, false], ['charlie.example.org', true]]);
    // The job: a file with an organisation and no verification gives no organisation to the hire, to the scorer or to the ranking.
    const w = world();
    const alfaFile = goldenFileOf(GOLDEN_ALFA, 1, 'alfa');
    const bravoFile = goldenFileOf(GOLDEN_BRAVO, 2, 'bravo', { organisation: 'bravo.example', organisation_verified: false });
    w.script.discover = async () => ({ ok: true, value: { bidders: [goldenViewOf(alfaFile, 1), goldenViewOf(bravoFile, 2)] } });
    w.script.shortlist = async () => shortlistAnswer([GOLDEN_ALFA, GOLDEN_BRAVO]);
    const proposal = proposed(await w.run());
    expect(w.calls.quotes[0]?.input.invited.map((invited) => invited.organisation)).toStrictEqual(['alfa.example', null]);
    expect(w.calls.scoring[0]?.input.subjects.map((subject) => subject.organisation)).toStrictEqual(['alfa.example', null]);
    const ranked = must(parseRanking(proposal.document)).ranked;
    expect(ranked.map((item) => item.desk_did)).toStrictEqual([GOLDEN_ALFA, GOLDEN_BRAVO]);
    expect([ranked[0]!.organisation, Object.hasOwn(ranked[1]!, 'organisation')]).toStrictEqual(['alfa.example', false]);
    const files2 = sub('The bidder file');
    expect(row(files2, '`organisation`')).toContain('It is shown only when the gateway verified it, because the bidder chooses its text');
    expect(row(files2, '`organisation_verified`')).toContain('`true` exactly when `organisation` is shown. It is never inferred');
    expect(ranking).toContain('It is a member only when the gateway verified the organisation');
  });
});

// ---- Outcomes, Errors and the co-sign route ---------------------------------------------------------------------------------------------------------------------------------------------------------------

/** The rows of a table of statuses and codes, as "status:code" for each code in backticks of the second cell. */
const codePairs = (body: string): string[] => body.split('\n').filter((line) => /^\| \d/.test(line)).flatMap((line) => {
  const [status, cell] = line.substring(2).split(' | ');
  return [...cell.matchAll(/`([a-z][a-z0-9_]*)`/g)].map((hit) => `${status}:${hit[1]}`);
});
/** The cells of each row of the table that starts with `header`. */
function rowsOf(body: string, header: string): string[][] {
  const lines = body.split('\n');
  const at = lines.indexOf(header);
  if (at < 0) throw new Error(`no table has the header ${header}`);
  const rows: string[][] = [];
  for (let index = at + 2; index < lines.length && lines[index].startsWith('| '); index += 1) rows.push(lines[index].substring(2, lines[index].length - 2).split(' | '));
  return rows;
}
/** The text of a source from the end of `head` to the next `end`. */
function declared(path: string, head: string, end: string): string {
  const source = text(path);
  const start = source.indexOf(head);
  if (start < 0) throw new Error(`${path} has no ${head}`);
  return source.substring(start + head.length, source.indexOf(end, start + head.length));
}
/** The names in single quotes of a piece of source text. */
const quoted = (piece: string): string[] => [...piece.matchAll(/'([a-z][a-z_]*)'/g)].map((hit) => hit[1]);
/** The members of the type `export type <name> = 'a' | 'b';` of a source. */
const unionOf = (path: string, name: string): string[] => quoted(declared(path, `export type ${name} = `, ';'));
/** The first group of each match of `pattern` in a source. */
const callsIn = (path: string, pattern: RegExp): string[] => [...text(path).matchAll(pattern)].map((hit) => hit[1]);

/**
 * The codes that the jobs write, read from the code. `propose` writes the codes of its own list, the codes of the scorers (with the prefixed codes of the sub-delegation set apart), the codes of the quote fan-out
 * (its closed list is the own codes of the folder and every code of the protocol), and the codes of the model decisions of the kit. `execute` writes the codes of its own list. A code of the protocol that no list
 * above names stands in the class of the protocol: a Bid Desk can answer with it before its Claim.
 */
function reasonsOfJobs(): { readonly propose: ReadonlySet<string>; readonly execute: ReadonlySet<string>; readonly protocol: ReadonlySet<string> } {
  const kit = 'packages/usecase-kit/src/';
  const ports = 'agents/sourcing-agent/src/quotes/ports.ts';
  const prefixed = SUB_DELEGATION_FAILURES.map((code) => `sub_delegation_${code}`);
  const scoring = SCORING_FAILURES.filter((code) => !prefixed.includes(code));
  if (scoring.length + prefixed.length !== SCORING_FAILURES.length) throw new Error('the list of the codes of the scorers does not hold the prefixed list of the sub-delegation');
  const hireKit = unionOf('packages/hire-kit/src/hire.ts', 'HireFailure');
  const decision = [
    ...hireKit.map((code) => `llm_${code}`),
    ...unionOf(`${kit}decision/answer.ts`, 'AnswerFault'),
    ...['decide', 'limits', 'prompt', 'spec'].flatMap((file) => callsIn(`${kit}decision/${file}.ts`, /refused\('(bad_[a-z]+)'/g)),
    ...callsIn(`${kit}decision/decide.ts`, /failure\('[a-z_]+', '([a-z_]+)'/g),
    ...callsIn(`${kit}decision/decide.ts`, /new HireEnded\('([a-z_]+)'/g),
  ];
  const listed = (head: string): string[] => quoted(declared(ports, head, ']'));
  const quote = [
    ...Object.values(CODE), ...NOT_ACTIVE_STATUSES, ...CHALLENGE_CODES, ...BID_DESK_REFUSALS, ...Object.values(INTERRUPTION_REASONS),
    ...listed('const EXCLUDED_WORDS = ['), ...listed('const ANSWER_CODES = ['), ...listed('const REFUSED_CODES = ['), ...listed('const HIRE_KIT_FAILURES = ['), ...listed('const HIRE_FLOW_FAILURES = ['),
    EARLIER_PAY_MAY_LAND, COUNTERPARTY_REFUSED, INCONSISTENT_OUTCOME, PAY_UNCONFIRMED,
  ];
  const propose = new Set<string>([...PROPOSE_FAILURES, ...scoring, ...decision, ...quote]);
  const execute = new Set<string>(EXECUTE_FAILURES);
  const protocol = new Set<string>(Object.keys(ERROR_STATUS).filter((code) => !propose.has(code) && !execute.has(code)));
  return { propose, execute, protocol };
}

describe('specs/sourcing-agent.md, Interface, Outcomes, Errors and the co-sign route', () => {
  test('the outcomes table lists the three outcomes that execute writes, with the exit states of the kit', () => {
    const outcomes = sub('Outcomes');
    expect(firstCells(outcomes, '| Outcome | Exit state | When |').map((cell) => cell.replaceAll('`', ''))).toStrictEqual(['completed', 'refused_by_system', 'failed']);
    expect(EXECUTE_OUTCOMES).toEqual(expect.arrayContaining(['completed', 'refused_by_system', 'failed']));
    const states = EXIT_STATES.map((state) => `\`${state}\``);
    const lastState = states.pop();
    expect(outcomes).toContain(`The exit state is ${states.join(', ')} or ${lastState}.`);
    const state = (outcome: ExecuteOutcome, reason: string | null): string => exitStateOf({ outcome, reason, challenge_filed: false, delegation_ended: false });
    expect(state('completed', null)).toBe('Completed');
    expect(['approval_expired', 'delegation_ended', 'approval_not_found', 'approval_digest_mismatch'].map((reason) => state('refused_by_system', reason))).toStrictEqual(['Expired', 'Cancelled', 'Rejected', 'Rejected']);
    expect(state('failed', 'token_failed')).toBe('Failed');
    expect(row(outcomes, '`completed`')).toBe('| `completed` | `Completed` | the sourcing record wrote the ranking |');
    expect(row(outcomes, '`refused_by_system`')).toContain('| `Rejected`, but `Expired` for `approval_expired` and `Cancelled` for `delegation_ended` |');
    expect(row(outcomes, '`failed`')).toContain('| `Failed` |');
    // `execute` builds these three results and no other: it hires nobody and files no challenge.
    const execute = text('agents/sourcing-agent/src/execute/execute.ts');
    for (const used of ['completedResult(', "refusedResult('system'", 'failedResult(']) expect(execute, used).toContain(used);
    for (const unused of ['vaultRefusedResult', 'disputedResult', "refusedResult('counterparty'", 'hireCounterparty', 'challengeDelivery']) expect(execute, unused).not.toContain(unused);
    // An ended delegation gives no token, so the job says `token_failed`. `Cancelled` comes from a refusal of the record itself.
    expect(text('agents/sourcing-agent/test/execute/token.test.ts')).toContain('is token_failed when the hirer ended the delegation');
    expect(text('agents/sourcing-agent/test/execute/refusals.test.ts')).toContain("[403, 'delegation_ended', 'Cancelled']");
    expect(outcomes).toContain(
      '`execute` writes these three outcomes and no other. It hires nobody, so it has no `vault_refused` and no `refused_by_counterparty`. It files no challenge, so it has no `disputed`. A delegation that the hirer ended gives no token, and the job ends `failed` with `token_failed`: the exit state `Cancelled` comes only when the sourcing record itself refuses with `delegation_ended`. A `propose` job ends with `proposed` or with `failed`, and a proposal has no exit state.',
    );
  });

  test('the Errors table gives each code the status of the kit and is the table of the README, and the answers with no message are the ones of the service kit', () => {
    const errors = sub('Errors');
    const pairs = codePairs(errors);
    const serverOwn: Record<string, number> = { bad_context: 400, not_found: 404 };
    for (const pair of pairs) {
      const [status, code] = pair.split(':');
      expect([code, Number(status)], pair).toStrictEqual([code, (ERROR_STATUS as Record<string, number>)[code] ?? serverOwn[code]]);
    }
    // The README has the same table, row for row, and its own test holds it to the code.
    expect(pairs).toStrictEqual(codePairs((readme.split('\n## Errors\n')[1] ?? '').split('The co-sign route has its own codes:')[0]));
    expect(readme).toContain('| any other route | 404 `{"error":"not_found"}` |');
    expect(pairs.map((pair) => pair.split(':')[1])).toStrictEqual(['bad_wire', 'request_too_large', 'bad_shape', 'bad_context', 'delegation_not_mine', 'unauthorized', 'not_found', 'busy', 'internal', 'shutting_down']);
    expect(errors).toContain(
      'A call that the service refuses has the body `{ "error": "<code>", "message": "<words>" }`, with the status of the first table. Four answers carry the code only, with no `message`: the 401, the 404, the 409 of a job, and a 500 for an error that the service does not name. The 409 of `POST /precheck` has a `message`. A refusal with a status of 500 or more gets fixed words, and the whole message is in the log. A job that the service runs and that does not end well is no HTTP error: it is a 200 result with the outcome `failed` and a `reason` code.',
    );
    // The service kit writes the four answers with the code only, and the 409 of the hook and a refusal of 500 or more with a message.
    const server = text('packages/service-kit/src/server.ts');
    for (const answer of [
      "return send(401, { error: 'unauthorized' });", "return send(404, { error: 'not_found' });", "if (taken === 'busy') return send(409, { error: 'busy' });", "return send(500, { error: 'internal' });",
      "return send(409, { error: 'busy', message: BUSY_TEXT });", 'return send(refusal.status, { error: refusal.code, message: operatorsText(refusal.code) });',
    ]) expect(server, answer).toContain(answer);
  });

  test('the reasons table covers job codes and quote step codes, including the prefix and the protocol group', () => {
    const errors = sub('Errors');
    const { propose, execute, protocol } = reasonsOfJobs();
    // One row holds each code, with the job that writes it: both jobs, or one of them.
    const rows = rowsOf(errors, '| Reason | Job | What it says |');
    const written = new Map<string, string>();
    for (const [codes, job] of rows) {
      for (const code of namesOf([codes])) {
        expect(written.has(code), `${code} stands in one row`).toBe(false);
        written.set(code, job.replaceAll('`', ''));
      }
    }
    const expected = new Map([...new Set([...propose, ...execute])].map((code): [string, string] => [code, propose.has(code) ? (execute.has(code) ? 'both' : 'propose') : 'execute']));
    expect(expected.size).toBeGreaterThan(100);
    expect([...written].sort()).toStrictEqual([...expected].sort());
    expect([...new Set(written.values())].sort()).toStrictEqual(['both', 'execute', 'propose']);
    // The class of the protocol: the closed list of the quote fan-out holds every code of the protocol, and the codes of the class are the ones that no row names.
    expect(Object.keys(ERROR_STATUS).every((code) => QUOTE_CODES.includes(code))).toBe(true);
    expect(QUOTE_CODES.every((code) => propose.has(code) || execute.has(code) || protocol.has(code))).toBe(true);
    expect(protocol.size).toBeGreaterThan(10);
    expect(protocol.has('bad_wire')).toBe(true);
    expect([...protocol].some((code) => written.has(code))).toBe(false);
    // `token_failed` and `mock_system_failed` are codes of the protocol that only `execute` writes as its own: `propose` writes them only as codes of the class.
    expect([written.get('token_failed'), written.get('mock_system_failed')]).toStrictEqual(['execute', 'execute']);
    expect(['token_failed', 'mock_system_failed'].every((code) => !PROPOSE_FAILURES.includes(code) && !SCORING_FAILURES.includes(code))).toBe(true);
    expect(errors).toContain('A bidder code describes that bidder, not the result of the whole job. If the job returns a ranking, its `excluded` entries can hold bidder codes. If a quote decision stops `propose`, the job\'s `reason` comes from that decision.');
    // The prefix: the codes after it are the list of the access folder, and the scoring writes each of them with its prefix.
    const cell = (first: string): string[] => rows.find((cells) => cells[0] === first) ?? [];
    expect(namesOf([cell('`sub_delegation_<code>`')[2]])).toStrictEqual([...SUB_DELEGATION_FAILURES]);
    expect(SCORING_FAILURES).toEqual(expect.arrayContaining(SUB_DELEGATION_FAILURES.map((code) => `sub_delegation_${code}`)));
    expect(cell('`sub_delegation_<code>`')[1]).toBe('`propose`');
    expect(GATEWAY_FAILURES).toContain('gateway_refused');
    expect(SCORING_FAILURES.some((code) => code.startsWith('token_'))).toBe(false);
    // The class of the protocol: a Bid Desk answers an error before its Claim with a code of the kit, and the reason is that code.
    expect(cell('a code of the protocol')[1]).toBe('`propose`');
    expect(cell('a code of the protocol')[2]).toContain('such as `bad_wire` (400)');
    expect(cell('`counterparty_refused`')[2]).toContain('the protocol does not list the code of its answer');
    // The seven refusal codes of a Bid Desk are the row of its refusals, and the bidder is left out as refused.
    expect(namesOf([cell('`sender_not_active`, `sender_unaccountable`, `sender_key_mismatch`, `delegation_invalid`, `delegation_ended`, `not_vault_paid`, `duplicate_rfq`')[0] ?? '']).sort()).toStrictEqual([...BID_DESK_REFUSALS].sort());
    expect([...BID_DESK_REFUSALS].sort()).toStrictEqual(['delegation_ended', 'delegation_invalid', 'duplicate_rfq', 'not_vault_paid', 'sender_key_mismatch', 'sender_not_active', 'sender_unaccountable']);
    expect(BID_DESK_REFUSALS.size).toBe(7);
    expect(COUNTERPARTY_REFUSALS['bid-desk']).toHaveLength(7);
    // The 60 seconds of `llm_out_of_time`.
    expect(HIRE_MIN_MS).toBe(60_000);
    expect(cell('`llm_out_of_time`, `hire_threw`')[2]).toContain(`less than ${HIRE_MIN_MS / 1000} s were left`);
    // `bad_document` in `propose` has two causes: a choice that cannot be read as data or a ranking that the kit refuses.
    expect(text('agents/sourcing-agent/src/propose/propose.ts')).toContain("return { ok: false, code: 'bad_document' };");
    expect(cell('`bad_document`')[2]).toContain('a choice of the model that the job cannot read as data, or a ranking that the kit refuses as the document of a proposal');
    // The window of the reasons of a failed hire: the interrupted hire and the unconfirmed Pay.
    expect([INTERRUPTION_REASONS.decision_error, INTERRUPTION_REASONS.other, PAY_UNCONFIRMED]).toStrictEqual(['decision_error', 'hire_interrupted', 'pay_unconfirmed']);
  });

  test('the co-sign route: the path, the rule, the allowlist and the codes are the kit and the manifest, and the table is the table of the README', () => {
    const cosign = sub('The co-sign route');
    expect(COSIGN_ROUTE).toBe('/cosign/delegate');
    expect(manifest.behaviour.cosign).toMatchObject({ route: COSIGN_ROUTE, rule: COSIGN_RULE });
    expect(cosign).toContain(`\`POST ${COSIGN_ROUTE}\` is an open route of the service: it needs no token, and it takes no job slot.`);
    expect(cosign).toContain(`\n> ${COSIGN_RULE}\n`);
    expect(COSIGN_SETTINGS.allowlist).toBe('COSIGN_ALLOWLIST');
    expect(SETTINGS).toContain('COSIGN_ALLOWLIST');
    expect(must(parseAllowlist('')).size).toBe(0);
    expect(parseCosignSettings({}).ok).toBe(false);
    expect(cosign).toContain('The route signs only for a principal key on the allowlist that the operator sets with `COSIGN_ALLOWLIST`. The empty allowlist holds nobody, and a service with no such setting does not start.');
    const pairs = codePairs(cosign);
    for (const pair of pairs) {
      const [status, code] = pair.split(':');
      expect(Number(status), pair).toBe((COSIGN_STATUS as Record<string, number>)[code]);
    }
    // The handler of the kit answers 405 to a method that is not POST. The service registers the route for POST only, so any other method gets the 404 of the service, and the page lists no 405.
    expect(COSIGN_STATUS.method_not_allowed).toBe(405);
    expect(pairs.map((pair) => pair.split(':')[1]).sort()).toStrictEqual(Object.keys(COSIGN_STATUS).filter((code) => code !== 'method_not_allowed').sort());
    expect(text('agents/sourcing-agent/src/serve/server.ts')).toContain("methods: ['POST']");
    expect(text('packages/service-kit/src/routes.ts')).toContain("if (method === 'POST') return route.post && query === -1 ? route : undefined;");
    expect(cosign).toContain('The route takes `POST` only. Any other method gets the 404 `not_found` of the service, as an unknown path does.');
    // The README has the same co-sign table, row for row.
    expect(pairs).toStrictEqual(codePairs((readme.split('The co-sign route has its own codes:')[1] ?? '').split('\n## ')[0]));
    expect(cosign).toContain('The code `key_in_use` means that the delegation key is in use: the agent signed another body for it whose window is open, or a live delegation on the ledger names it.');
  });
});

describe('specs/sourcing-agent.md, the receipt, the claim and the fault switch', () => {
  test('What the receipt commits to: the fields of the table, the members of the results that it holds, and the checks of the sub-receipt', () => {
    const receipt = section('What the receipt commits to');
    expect(receipt).toContain('The service signs no receipt. The runtime builds the receipt, signs it with the supplier key and submits its hash in the Submit transaction.');
    expect(row(receipt, '`escrow_ref`')).toBe('| `escrow_ref` | the escrow UTxO, `<txid>#<index>`: 64 lower-case hex characters, a hash sign, and an output index with no leading zero |');
    expect(row(receipt, '`supplier_pkh`')).toBe('| `supplier_pkh` | the key hash of the supplier key |');
    expect(row(receipt, '`prompt_hash`')).toBe('| `prompt_hash` | sha256 of the UTF-8 bytes of the wire payload, as the buyer committed it in the escrow datum |');
    expect(row(receipt, '`response_hash`')).toBe('| `response_hash` | sha256 of the UTF-8 bytes of the result exactly as the service returned them |');
    expect(row(receipt, '`model`')).toBe('| `model` | `sourcing-agent-v1` |');
    expect(receipt).toContain(
      'The receipt of a `propose` job commits the ranking, its salt and its digest, the file of every candidate as the agent read it, the parsed quotes with the signed receipts of their Bid Desks, every model decision with its reasoning and the sub-job that bought it, and any challenge that the agent filed.',
    );
    expect(receipt).toContain('The receipt of an `execute` job commits the outcome and the one write to the sourcing record, with its reference when it has one.');
    expect(receipt).toContain('It does not commit to the ranking being right, to the prices of the Bid Desks being fair, or to any order being placed. The use case ends at the approved ranking.');
    expect(receipt).toContain('The signature is Ed25519 over the canonical JSON of the receipt. The sha256 of the canonical JSON of `{ receipt, signature }` is the `result_receipt_hash` in the Submitted escrow datum.');
    // What a `propose` result holds, and what an `execute` result holds.
    for (const path of ['document.rfq_sha256', 'salt', 'proposal_digest', 'bidders.0.compliance', 'quotes.0.receipt', 'quotes.0.receipt_signature', 'quotes.0.challenge', 'decisions.0.reasoning', 'decisions.0.inference.sub_job']) expect(PROPOSED, path).toHaveProperty(path);
    const completed = JSON.parse(readFileSync(new URL('agents/sourcing-agent/test/execute/golden/completed.json', root), 'utf8')) as Record<string, unknown>;
    for (const path of ['outcome', 'writes.0.route', 'writes.0.ref']) expect(completed, path).toHaveProperty(path);
    expect(RECEIPT_CHECKS).toEqual(expect.arrayContaining(['signature_valid', 'on_chain_hash_matches']));
    expect(RUN.result.quotes[0].challenge).toBeNull();
    expect(row(runbook, 'Sourcing')).toContain('`sourcing-agent-v1`');
  });

  test('Claim statements: the table is the claim of the kit and the manifest, and a claim has no reference to a claim', () => {
    const claim = section('Claim statements');
    expect(claim.split('\n').filter((line) => /^\| S[123] \|/.test(line))).toStrictEqual(SOURCING_CLAIM.statements.map((statement) => `| ${statement.id} | ${statement.text} |`));
    expect(SOURCING_CLAIM.statements.map((statement) => statement.id)).toStrictEqual(['S1', 'S2', 'S3']);
    expect(manifest.behaviour.claim).toStrictEqual(SOURCING_CLAIM);
    expect(Object.keys(manifest.behaviour.claim)).toStrictEqual(['statements']);
    expect(claim).toContain(
      `The service stakes no claim, and no code of the service calls the staking of one. No command of this repository stakes a claim for this agent yet. Until one does, a challenge against it ends with \`no_open_claim\`. The design is that, before each run, the operator stakes one claim with the service key of the agent: ${CLAIM_STAKE_LOVELACE / 1_000_000n} units, which is ${CLAIM_STAKE_LOVELACE} lovelace, with a challenge window of ${CLAIM_WINDOW_MS / 3_600_000} hours. After the window, the operator withdraws the claim when nobody challenged it. A claim has these three statements. The manifest holds them in \`behaviour.claim\`, with no reference to a claim. A challenge names the text of a statement.`,
    );
    // The `quote` member of an entry is built from the held quote (S1 and S2), and `execute` writes the document as the hirer holds it (S3).
    expect(text('agents/sourcing-agent/src/propose/ranking.ts')).toContain('The model writes the order and nothing more. A word of the model never reaches the `quote` member of an entry');
    expect(text('agents/sourcing-agent/src/execute/execute.ts')).toContain('ranking: request.proposal.document, salt: request.proposal.salt');
    // The agent challenges the first statement of the claim of a Bid Desk, and the page quotes it.
    expect(text('agents/sourcing-agent/src/quotes/evidence.ts')).toContain('statement_text: BID_DESK_CLAIM.statements[0].text,');
    expect(claim).toContain(
      'The job builds the `quote` member of each ranked entry from the quote that it holds and accepted, and the model never writes it: that holds S1 and S2. `execute` writes the document as the hirer holds it: that holds S3 together with the approval check of the sourcing record. The agent challenges the claim of a Bid Desk and never its own claim. It uses the first statement of the claim of the Bid Desk: "The unit price of every line in a quote is the price its published price list gives for that SKU and quantity."',
    );
    expect(BID_DESK_CLAIM.statements[0].text).toBe('The unit price of every line in a quote is the price its published price list gives for that SKU and quantity.');
  });

  test('the fault switch: invert_scores reverses the scorer of the first quote on the decimal text, the decision of the model stays, and any other value stops the start', () => {
    const fault = section('Fault switch');
    expect(FAULT_MODES['sourcing-agent']).toStrictEqual(['invert_scores']);
    expect(manifest.behaviour.fault_modes).toStrictEqual(['invert_scores']);
    expect([reversedOf(80.2), reversedOf(0), reversedOf(100)]).toStrictEqual([19.8, 100, 0]);
    const inverting = scoreFaultOf(readFaultSwitch('sourcing-agent', 'invert_scores'));
    const choice = { components: { price: 80.2, lead_time: 10, reliability: 50, compliance: 100 }, score: 66.5 };
    expect(inverting(0, choice)).toStrictEqual({ components: { price: 19.8, lead_time: 90, reliability: 50, compliance: 0 }, score: 33.5 });
    expect(inverting(1, choice)).toBe(choice);
    expect(inverting(2, choice)).toBe(choice);
    expect(scoreFaultOf(readFaultSwitch('sourcing-agent', ''))(0, choice)).toBe(choice);
    expect(choice.components.price).toBe(80.2);
    expect(() => readFaultSwitch('sourcing-agent', 'confirm_wrong_lot')).toThrow();
    expect(withFaultMode(readFaultSwitch('sourcing-agent', 'invert_scores'), RUN.result).fault_mode).toBe('invert_scores');
    expect(withFaultMode(FAULT, RUN.result).fault_mode).toBe('');
    expect(readme).toContain('The subtraction is made on the decimal text of the number, so 80.2 gives 19.8.');
    for (const part of [
      '`FAULT_MODE=invert_scores`: the scorer of the first accepted quote returns each of its four component scores and its score as 100 minus the value. The subtraction is made on the decimal text of the number, so 80.2 gives 19.8. The other scorers are not changed.',
      'The decision that the model made stays on record as the model gave it: the reversal is made on the answer of the scorer, after the job checked that answer.',
      'The planned failure run sets the switch on this agent to show that an approver can find a wrong score from the quote that it cites. No command of this repository runs use case 3 yet. The switch changes what the job writes and never a check.',
      'The switch is empty in a clean run. Any other value than `invert_scores` stops the start of the service. The service reads the switch one time, at start. It is declared in the manifest, in `behaviour.fault_modes`, and the manifest is the same for every value. Each result returns the active value as `fault_mode`, its last member.',
    ]) expect(fault, part).toContain(part);
    // No command of this repository runs use case 3: the operator pack names no use case 3 data.
    expect(USE_CASE_NAMES).toStrictEqual(['inventory-reorder']);
  });
});

describe('specs/sourcing-agent.md, the operator, the gaps, the hire and the links', () => {
  test('Operator and data handling: the operator, the data sentences of the manifest, the six third parties, what each decision carries, and the state files', () => {
    const operator = section('Operator and data handling');
    expect(manifest.operator.name).toBe('Apex Fusion Foundation');
    expect(operator).toContain('Operator: Apex Fusion Foundation. The contact is `operator.contact` in the manifest.');
    expect(operator).toContain(manifest.behaviour.data_handling);
    const parties = firstCells(operator, '| Party | What it receives |');
    expect(parties).toStrictEqual(manifest.behaviour.third_parties);
    expect(parties).toHaveLength(6);
    expect(operator).toContain('Anyone who knows the tenant name can read `GET <mock base>/t/<tenant>/state` without a token.');
    expect(operator).toContain('The `sourcing.rankings` list shows the full ranking, including scores and quote totals, and the approval reference.');
    // What each decision carries: the members of the data block of each of the four decisions.
    const vendor = { vendor_id: 'v-1', organisation: 'alfa.vector.apexfusion.org', name: 'Alfa Supplies', on_time_delivery_rate: 0.9, defect_rate: 0.01, years_as_vendor: 4, payment_terms_days: 30, certifications: ['ISO 9001'], last_audit: '2026-05-01' };
    const shortlist = shortlistInput(RFQ, [ALFA_FILE]) as Record<string, unknown>;
    const accept = acceptQuoteInput(RFQ, QUOTE, ALFA_LIST) as { request: Record<string, unknown>; quote: Record<string, unknown> };
    const score = scoreInput({ today: '2026-11-24', weights: WEIGHTS, rfq: RFQ, quote: QUOTE, file: ALFA_FILE, vendor }) as { quote: Record<string, unknown>; vendor: Record<string, unknown> };
    const ranked = rankingInput(WEIGHTS, [{ desk_did: ALFA, score: 87, components: SCORE.components, total: 1, lead_time_days: 1 }]) as Record<string, unknown>;
    expect(firstCells(operator, '| Decision | Data block | Left out |')).toStrictEqual(['`shortlist`', '`accept_quote`', '`score`', '`ranking`']);
    expect([Object.keys(shortlist), Object.keys(accept), Object.keys(accept.request), Object.keys(accept.quote)]).toStrictEqual([['request', 'bidders'], ['request', 'quote', 'price_list'], ['items'], ['lines']]);
    expect(Object.keys(score)).toStrictEqual(['today', 'weights', 'request', 'quote', 'lines_quoted', 'items_requested', 'bidder', 'vendor']);
    expect(Object.keys(score.quote)).toStrictEqual(['lines', 'total', 'lead_time_days', 'valid_until']);
    expect(Object.keys(ranked)).toStrictEqual(['weights', 'scored']);
    expect(row(operator, '`shortlist`')).toContain('| `request` (`items` and `needed_by`) and `bidders` (the facts of each file) |');
    expect(row(operator, '`accept_quote`')).toContain('| `request` (`items`), `quote` (`lines`, each with `sku`, `quantity`, `unit_price` and `lead_time_days`) and `price_list` (the entries for the SKUs of the lines) |');
    expect(row(operator, '`score`')).toContain('| `today`, `weights`, `request`, `quote` (`lines`, `total`, `lead_time_days` and `valid_until`), `lines_quoted`, `items_requested`, `bidder` (the facts of the file) and `vendor` (the entry of the vendor master, or `null`) |');
    expect(row(operator, '`ranking`')).toContain('| `weights` and, for each scored bidder, `desk_did`, `score`, `components`, `total` and `lead_time_days` |');
    // The notes, the credential and the organisation of a quote never reach a decision, and the vendor entry holds the two free texts of the vendor master.
    for (const left of [QUOTE.notes, QUOTE.credential, QUOTE.sender.organisation as string]) {
      expect(JSON.stringify(accept), left).not.toContain(left);
      expect(JSON.stringify(score.quote), left).not.toContain(left);
    }
    expect(Object.keys(score.vendor)).toStrictEqual(['vendor_id', 'organisation', 'name', 'on_time_delivery_rate', 'defect_rate', 'years_as_vendor', 'payment_terms_days', 'certifications', 'last_audit']);
    expect(operator).toContain(
      'No free text of a bidder reaches a decision: a file holds closed lists, numbers, booleans, hashes, a domain, DIDs and times, and a quote reaches the decisions as lines, prices and dates. The one free text that a decision reads is in the entry of the vendor master, which holds a name and a list of certifications. Those two reach the model inside the data block of `score`, and never inside an instruction. The data of every decision reaches the model only inside one marked data block.',
    );
    // The one file that the start fetches, and the services that the service calls.
    for (const name of ['VECTOR_MODULE1_MANIFEST', 'VECTOR_OGMIOS_URL', 'VECTOR_KOIOS_URL', 'VECTOR_SUBMIT_URL', 'VECTOR_MARKETPLACE_INDEXER_URL', 'IDENTITY_GATEWAY_URL']) expect(SETTINGS).toContain(name);
    expect(() => module1SourceOf({ VECTOR_MODULE1_MANIFEST: 'https://example.test/vector-agent-modules/main/manifest.json' })).toThrow('must be pinned to a commit');
    expect(module1SourceOf({ VECTOR_MODULE1_MANIFEST: `https://example.test/vector-agent-modules/${'ab'.repeat(20)}/manifest.json` })).toContain('ab'.repeat(20));
    expect(operator).toContain('At start the service fetches one file: the Module-1 deployment manifest, at an https address that a commit pins. It sends no data of a job there.');
    expect(operator).toContain('the node (Ogmios) and the Koios indexer');
    // The state files: the folder of the service, the three folders and files of its stores, and the one stranded file of each paying key.
    expect(STATE_FILES).toStrictEqual({ dispute: 'dispute', left: 'left', register: 'cosign-register.json' });
    expect(firstCells(operator, '| Path | What it holds |')).toStrictEqual(['`keys/<key hash>/stranded.json`', '`dispute/`', '`left/`', '`cosign-register.json`']);
    for (const path of ['keys/<key hash>/stranded.json', 'dispute/', 'left/', 'cosign-register.json']) expect(readme, path).toContain(`| \`${path}\` |`);
    expect(operator).toContain('There is one folder for each of the three paying keys');
    expect(text('agents/sourcing-agent/src/serve/settings.ts')).toContain("export const STATE_DIR_DEFAULT = '/data';");
  });

  test('Known gaps: the sixteen sentences of the manifest, word for word and in order, and the three about the candidates, the adverts and the text of a quote are held to the code', async () => {
    const gaps = section('Known gaps');
    const lines = gaps.split('\n').filter((line) => line.startsWith('- '));
    expect(lines).toStrictEqual(gapsFor().map((gap) => `- ${gap}`));
    expect(manifest.gaps).toStrictEqual([...gapsFor()]);
    expect(lines).toHaveLength(16);
    expect(gaps).toContain('The manifest states these sixteen, in this order, word for word. A test keeps them equal to `gapsFor` in `agents/sourcing-agent/src/serve/gaps.ts`.');
    // The eleventh to the thirteenth name the candidates, the adverts and the text of a quote. The fourteenth says that one operator holds the keys of the parties on one host. The fifteenth is the lead of what no run shows, with its three things. The sixteenth is the sentence of the kit about the fault switch.
    expect(lines[10]).toBe(`- ${CANDIDATES_GAP}`);
    expect(lines[11]).toBe(`- ${ADVERT_GAP}`);
    expect(lines[12]).toBe(`- ${QUOTE_TEXT_GAP}`);
    expect(lines[13]).toBe(`- ${KEYS_GAP}`);
    expect(lines[14]).toBe(`- ${NOT_SHOWN_GAP}`);
    expect(NOT_SHOWN_GAP.startsWith('What this does not show: ')).toBe(true);
    for (const part of ['the refund of the escrow of a revoked agent', 'the reclaim of an escrow in use case 3', 'a relying party that refuses a live token after its authority ends', 'Tests cover that last case only']) {
      expect(NOT_SHOWN_GAP, part).toContain(part);
    }
    expect(lines[15]).toContain('invert_scores');
    expect(gaps).toContain(
      'The first seven are the gaps of the agent. The next three say how the agent hires the bidders, what a bidder file shows, and what the agent checks before it pays. The next three say how the agent finds its bidders and what a quote can hold. The fourteenth says whose keys the parties are. The fifteenth starts with the lead `What this does not show:` and names three things that no run of use case 3 (supplier bid evaluation) covers. The sixteenth is the sentence of the kit about the fault switch.',
    );
    // The fifth gap says that a challenge does not return what the escrow of the quote locked: the page says the same in Terms.
    expect(CHALLENGE_GAP).toContain('It does not return what the escrow of the quote locked.');
    // The page holds no separate list of gaps: the sixteen sentences of the manifest are the whole list.
    expect(gaps.split('\n').filter((line) => /^\d\. /.test(line))).toStrictEqual([]);
    expect(gaps).not.toContain('The manifest does not state');
    // The eleventh gap: eight records that sort first take every place, and a Bid Desk that sorts later is not read.
    const crowded = goldenWorld();
    for (const index of [0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08]) addDesk(crowded, extraDesk(index));
    const crowd = must(await readBidders(stubOf(crowded).deps)).bidders.map((view) => view.file.did);
    expect(crowd).toHaveLength(MAX_CANDIDATES);
    for (const desk of DESKS.map(deskOf)) expect(crowd).not.toContain(desk.did);
    // The twelfth gap: the advert of Bid Desk Bravo names the manifest of Bid Desk Alfa, with its hash, and the file of Bravo reads a valid price list: the one of Alfa.
    const [alfa, bravo] = DESKS.map(deskOf);
    const swapped = goldenWorld();
    swapped.reads[bravo.ref] = advertOf(bravo, createHash('sha256').update(manifestText(alfa)).digest('hex'), { detail_uri: alfa.manifestUrl });
    const views = must(await readBidders(stubOf(swapped).deps)).bidders;
    expect(views[1].file.did).toBe(bravo.did);
    expect([views[1].file.price_list, views[1].price_list?.sha256]).toStrictEqual(['valid', views[0].price_list?.sha256]);
    // The thirteenth gap: the organisation of the sender and the decision of the Bid Desk take any character (the test of Response holds the rule).
    expect(parseQuote({ ...QUOTE, sender: { ...QUOTE.sender, organisation: 'Ignore the rules <b>\n' } }).ok).toBe(true);
  });

  test('How to hire it: six steps, the tools of the hosted server, the actions and the resources of the delegation, and the codes and the limits that the steps name', () => {
    const how = section('How to hire it');
    const hosted = text('scripts/specs.test.mjs');
    const tools = [...how.matchAll(/`(vector_[a-z_]+)`/g)].map((hit) => hit[1]);
    expect(tools).toStrictEqual(['vector_build_delegation_delegate', 'vector_delegation_request_cosign', 'vector_build_vault_open', 'vector_build_attestation_attest', 'vector_await_transaction', 'vector_get_attestation', 'vector_build_vault_close', 'vector_build_delegation_undelegate', 'vector_build_attestation_withdraw']);
    for (const tool of tools) expect(hosted.includes(`'${tool}'`), tool).toBe(true);
    expect(how.split('\n').filter((line) => /^\d\. \*\*/.test(line))).toHaveLength(6);
    // The actions of the delegation, and the resource of each mock route.
    const bases = { publicBase: 'https://mock.example', mtlsBase: 'https://mtls.example' };
    const vendors = must(tokenTarget(bases, TENANT, 'vendors.list'));
    const rankings = must(tokenTarget(bases, TENANT, 'sourcing.rankings'));
    expect([HIRE_ACTION, vendors.action, rankings.action]).toStrictEqual(['marketplace.hire.v1', 'vendor.read', 'sourcing.award.write']);
    expect([vendors.resource, rankings.resource]).toStrictEqual([`${bases.publicBase}/t/${TENANT}/vendors`, `${bases.publicBase}/t/${TENANT}/sourcing`]);
    expect(how).toContain('The actions are `marketplace.hire.v1`, `vendor.read` and `sourcing.award.write`.');
    expect(how).toContain('`<mock base>/t/<tenant>/vendors` and `<mock base>/t/<tenant>/sourcing`');
    expect(how).toContain('with a delegation that covers `sourcing.award.write` and `vendor.read` for the tenant');
    expect(manifest.keys.delegation_pkhs).toHaveLength(2);
    expect(how).toContain('a free one of its two delegation keys, which `keys.delegation_pkhs` of the manifest lists');
    // The codes that the steps name are the codes of the jobs and of the co-sign route.
    expect(how).toContain('Keep the delegation valid for the full 90-minute `propose` window, the review of the ranking and the `execute` call. Do not use the 300000 ms minimum of a sub-delegation as the job budget.');
    expect(PROPOSE_FAILURES).toContain('delegation_not_found');
    expect([COSIGN_STATUS.principal_not_allowed, COSIGN_STATUS.key_in_use]).toStrictEqual([403, 409]);
    expect(QUOTE_CODES).toEqual(expect.arrayContaining(['no_live_vault', 'several_live_vaults']));
    expect(PROPOSE_FAILURES).toContain('no_quotes');
    expect(text('services/mock-systems/src/errors.ts')).toContain("'approval_wrong_issuer'");
    for (const code of ['delegation_not_found', 'principal_not_allowed', 'key_in_use', 'no_live_vault', 'several_live_vaults', 'no_quotes', 'approval_wrong_issuer']) {
      expect(how, code).toContain(`\`${code}\``);
    }
    // Three locks of 3 units need 9 units at the listed terms, plus the minimum of the continuing vault.
    const desk = (JSON.parse(text('agents/bid-desk/agent.json.template')) as { terms: Record<string, number> }).terms;
    expect(((desk.price_lovelace + desk.supplier_bond_lovelace + desk.buyer_bond_lovelace) * MAX_INVITED) / 1_000_000).toBe(9);
    expect(how).toContain('9 units for three Bid Desks');
    expect(how).toContain('Set `total` to cover the planned locks and any spending already recorded for the same period');
    expect(how).toContain('Add the ledger minimum that must stay in the Live vault.');
    expect(how).toContain('close the Live vault and collect any `Returned` outputs.');
    // The hosted tool uses the approval name, not the numeric ledger type.
    expect([APPROVAL_ATT_TYPE, APPROVAL_DEPOSIT_LOVELACE, RUN_APPROVAL_VALIDITY_MS / 3_600_000]).toStrictEqual([5, 5_000_000n, 4]);
    expect(how).toContain('Pass your allowlisted assertion public key as `principal_key`. Do not set `delegator` or `parent`');
    expect(how).toContain('Set `att_type: "approval"` and set `subject` to this agent\'s DID. Set `digest` to the digest you recomputed.');
    expect(how).toContain('Set `issuer_did` to your registered DID and `issuer` to the same public key you used as `principal_key`.');
    expect(how).toContain('Compute SHA-256 over those bytes followed by the UTF-8 bytes of the canonical JSON of that document.');
    expect(how).toContain('Compare the result with `proposal_digest`. If they differ, stop. Do not sign an approval or hire `execute`.');
    expect(how).toContain('Set `valid_until` in POSIX milliseconds. The tool sets no end by default. The planned runs use 4 hours.');
    expect(how).toContain('Submit it and wait for confirmation with `vector_await_transaction`. Then call `vector_get_attestation` with the `attestation` identifier.');
    expect(how).toContain('Require `found: true`, `state: "active"` and `att_type: "approval"`. Check that `subject_did` names this agent and that `issuer_did` and `issuer_key` match the registered DID and public key you used.');
    expect(how).toContain('Check that `digest` matches the digest you recomputed. If you cannot verify any of these values, stop. Do not pay for `execute`.');
    expect(how).toContain('In `approval`, use the `attestation` identifier and the registered `issuer_did` you verified in step 4.');
    expect(how).toContain('If the ledger does not show the approval, the sourcing record returns `approval_not_found`.');
    expect(how).toContain('The default and minimum deposit is 5 units (5000000 lovelace).');
    expect(how).toContain('The deposit does not return automatically. Withdrawal becomes eligible 90 days after `valid_until` or, if revoked, 90 days after revocation, whichever date comes first.');
    expect(how).toContain('Submit the withdrawal and wait for confirmation. The transaction burns the attestation token and returns the deposit to the wallet less the fee.');
    // Step 1: a delegation that the ledger does not show ends `propose` with `delegation_not_found`, and the sub-delegation of a scorer needs 30 confirmations on every link of its chain.
    expect(how).toContain('Wait until the ledger shows the delegation: a `propose` job on a delegation that the ledger does not show ends with `delegation_not_found`. Then wait for 30 confirmations of the delegation.');
    expect(text('packages/usecase-kit/src/live/chain.ts')).toContain('Every link of the chain must have 30 confirmations or more for `ready`.');
    expect(how).toContain('The agent has no advert yet, so nobody can hire it today.');
    expect(how).toContain('Use a new `rfq_id` each time.');
    expect(how).toContain('The job can take most of the window of 90 minutes. Each lock remains in place until settlement (see Terms).');
    expect(MIN_PROCESSING_WINDOW_MS / 60_000).toBe(90);
  });

  test('the Changelog is the version of the manifest, and the links name files that exist', () => {
    expect(manifest.version).toBe('0.1.0');
    expect(section('Changelog').trim()).toBe(`- ${manifest.version}, ${PAGE_DATE}: built`);
    const links = section('Links');
    const targets = [...links.matchAll(/\[([^\]]+)\]\(\.\.\/([^)]+)\)/g)].map((hit) => ({ label: hit[1], target: hit[2] }));
    expect(targets.length).toBeGreaterThanOrEqual(4);
    for (const { label, target } of targets) {
      expect(existsSync(new URL(target, root)), target).toBe(true);
      expect(label, target).toBe(target);
    }
    expect(manifest.links.spec.endsWith('/specs/sourcing-agent.md')).toBe(true);
    expect(manifest.links.source.endsWith('/agents/sourcing-agent')).toBe(true);
    expect(links).toContain('[agents/sourcing-agent/agent.json.template](../agents/sourcing-agent/agent.json.template)');
    expect(links).toContain('[docs/HIRE.md](../docs/HIRE.md)');
    expect(links).toContain('[Bid Desk](bid-desk.md)');
    expect(existsSync(new URL('specs/bid-desk.md', root))).toBe(true);
  });
});
