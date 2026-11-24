// agents/sourcing-agent/test/spec.test.ts
// specs/sourcing-agent.md is the public page of the agent, and the manifest links to its Response section. These tests hold the page to the code and to the deploy pack: the status, the identity rows, the
// numbers of the terms and the windows, the request limit, the request fields of the schema that the manifest publishes, the example requests and the example proposal (made here with the real `runPropose` over
// scripted ports), the steps of the two jobs and the codes that they name, the file of a bidder (made with the real reader), and the ranking. The tests read the page, the manifest, the env example, the compose
// file of the pack and some source files, and no network. The test of the headings holds the headings that the page has.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { parse } from 'yaml';
import { ACCEPT_WINDOW_MS } from '@vsa/buyer-core';
import { MAX_BODY, RESERVATION_MS } from '@vsa/service-kit';
import { CONFIRMATIONS_REQUIRED } from '@vsa/usecase-kit/access';
import {
  BID_CAPABILITIES, BID_DESK_MODEL, EXCLUDED_REASONS, MAX_ITEM_QUANTITY, MAX_RFQ_ITEMS, QUOTE_SCHEMA, SCORE_COMPONENTS, SOURCING_MODEL, WEIGHT_NAMES, buildRanking, parsePriceList, parseQuote, parseRanking, priceFor,
  priceListSha256, quoteTotals, receiptSha256, rfqSha256,
} from '@vsa/usecase-kit/bids';
import type { PriceList, Quote } from '@vsa/usecase-kit/bids';
import { checkRuntimeBody, checkWirePayload } from '@vsa/usecase-kit/buyer';
import { readFaultSwitch, withFaultMode } from '@vsa/usecase-kit/fault';
import {
  COUNTERPARTY_REFUSALS, ERROR_STATUS, MAX_REQUEST_BYTES, PROPOSE_OUTCOMES, RECEIPT_CHECKS, RUNTIME_BODY_LIMIT_BYTES, agentIdOf, canonicalJson, checkRequestSize, parseProposal, parseRequest, proposalDigest,
} from '@vsa/usecase-kit/protocol';
import type { Decision, Did, JsonObject, JsonValue, ProtocolResult, ReceiptVerification, SubJob } from '@vsa/usecase-kit/protocol';
import { CLAIM_STAKE_LOVELACE, CLAIM_WINDOW_MS } from '../../../scripts/operator/lib/claim-constants.ts';
import { USE_CASE_NAMES } from '../../../scripts/operator/usecases/names.ts';
import { MAX_CANDIDATES, readBidders } from '../src/bidders/index.ts';
import type { BidderFile, BidderView } from '../src/bidders/index.ts';
import { EXECUTE_DEADLINE_MS, EXECUTE_FAILURES } from '../src/execute/index.ts';
import { ACCEPT_QUOTE_DECISION, MAX_INVITED, RANKING_DECISION, SCORE_DECISION, SHORTLIST_DECISION, acceptQuoteInput, parseProposeFields, rankingInput, scoreInput, shortlistInput } from '../src/model/index.ts';
import { bidderFacts } from '../src/model/bidder.ts';
import { PROPOSE_DEADLINE_MS, PROPOSE_FAILURES, ProposeRefusal, RANKING_RESERVE_MS, SCORING_RESERVE_MS, runPropose } from '../src/propose/index.ts';
import type { ProposeDeps, ProposeRequest, QuoteRecord } from '../src/propose/index.ts';
import { QUOTE_CODES, QUOTE_HIRE_RESERVE_MS } from '../src/quotes/index.ts';
import { SCORER_JOB_TIMEOUT_MS, SCORER_NEED_MS, SCORERS_NEED_MS, SCORING_FAILURES, SUB_DELEGATION_VALID_MS } from '../src/scoring/index.ts';
import { DESCRIPTION, ID_CHARS, REQUEST_SCHEMA, TEMPLATE_ENV, manifestFromEnv } from '../src/serve/manifest.ts';
import { RequestRefusal, parseJob } from '../src/serve/server.ts';
import {
  BUYER_BOND_LOVELACE, JOB_DEADLINE_MS, MIN_PROCESSING_WINDOW_MS, PRICE_DEFAULT_LOVELACE, SUPPLIER_BOND_LOVELACE, priceOf, processingWindowOf, scorerDidsOf, supplierKeyOf,
} from '../src/serve/settings.ts';
import { SETTINGS } from '../src/serve/start.ts';
import { DESKS, addDesk, deskOf, extraDesk, goldenWorld, ok, priceListText, revokedCompliance, revokedOf, rowOf, stubOf } from './bidders/support.ts';
import type { Desk } from './bidders/support.ts';
import { proposed, world } from './propose/support.ts';

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
  test('the page has the headings that it has so far in order, and Interface has the four sub-headings that the tests below read', () => {
    expect([...page.matchAll(/^## (.+)$/gm)].map((hit) => hit[1])).toStrictEqual(['Status', 'Identity', 'Capability id', 'Terms', 'Interface']);
    expect([...page.matchAll(/^### (.+)$/gm)].map((hit) => hit[1])).toStrictEqual(['Request', 'Response', 'The bidder file', 'The ranking']);
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
      `| Request | at most ${limits.request_bytes} bytes of request JSON; \`tenant\` 1 to ${limits.tenant_chars} characters; \`rfq_id\` and \`sku\` 1 to ${ID_CHARS} characters; 1 to ${limits.rfq_items} items; \`quantity\` 1 to ${limits.item_quantity} |`,
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
    ]) expect(terms, part).toContain(part);
    // The README holds the same rule.
    expect(readme).toContain('A quote hire starts only when the deadline of the job is at least 2910000 ms away, so it starts in the first 2310000 ms of the job.');
    expect(readme).toContain('A bidder that the fan-out reaches later is left out with the reason `deadline`, and a job with no accepted quote ends `failed` with `no_quotes`.');
    expect(PROPOSE_FAILURES).toEqual(expect.arrayContaining(['no_quotes', 'deadline']));
    expect(QUOTE_CODES).toContain('deadline');
  });

  test('the request limit is 900000 bytes of request JSON, and it is safe only below the 1 MiB limit of the runtime on the escaped body', () => {
    const terms = section('Terms');
    expect([MAX_REQUEST_BYTES, RUNTIME_BODY_LIMIT_BYTES, MAX_BODY]).toStrictEqual([900_000, 1_048_576, 1_000_000]);
    for (const part of [
      'The service counts the request JSON in bytes of UTF-8, and it refuses a request JSON of more than 900000 bytes with `request_too_large` (400). It reads at most 1000000 bytes of wire payload.',
      'The wire payload carries the request JSON as a string inside a one-message array (see Interface).',
      'The limit of 900000 bytes is safe only below the 1 MiB limit of the runtime, 1048576 bytes, on the escaped body.',
      'A request JSON under 900000 bytes can give a body above 1048576 bytes, and the runtime refuses that body. A sender keeps the body of its call at or below 1048576 bytes.',
      'The two requests of the examples under Request are a few kilobytes, so they are far below both limits.',
    ]) expect(terms, part).toContain(part);
    // The service counts the request JSON: one byte over the limit is refused as too large, and the limit itself passes the size check and fails as a request that is no JSON.
    const codeOf = (request: string): string => {
      try {
        parseJob(request);
        return 'accepted';
      } catch (error) {
        return error instanceof RequestRefusal ? error.code : 'other';
      }
    };
    expect(codeOf('x'.repeat(MAX_REQUEST_BYTES + 1))).toBe('request_too_large');
    expect(codeOf('x'.repeat(MAX_REQUEST_BYTES))).toBe('bad_shape');
    expect(checkRequestSize('x'.repeat(MAX_REQUEST_BYTES)).ok).toBe(true);
    // A request JSON of quote marks is 440000 bytes. Its wire payload is under the limit of 900000 bytes, and the body of the call to the runtime, which escapes it a second time, is over 1048576 bytes.
    const quotes = '"'.repeat(440_000);
    expect(quotes.length).toBeLessThan(MAX_REQUEST_BYTES);
    expect(checkWirePayload(quotes).ok).toBe(true);
    expect(checkRuntimeBody(quotes)).toMatchObject({ ok: false, code: 'request_too_large' });
  });

  test('the economics: what the supplier receives, the window to accept, the vault, the quotes of the Bid Desks and the fees', () => {
    const terms = section('Terms');
    expect(ACCEPT_WINDOW_MS).toBe(600_000);
    // A Bid Desk advert locks the price and both bonds: 3 units, from the template of the manifest of the Bid Desk.
    const desk = (JSON.parse(text('agents/bid-desk/agent.json.template')) as { terms: Record<string, number> }).terms;
    expect((desk.price_lovelace + desk.supplier_bond_lovelace + desk.buyer_bond_lovelace) / 1_000_000).toBe(3);
    for (const part of [
      'A hire of either operation locks the price and both bonds, 5 units.',
      "On Accept the supplier receives the price and the supplier bond, and the buyer's bond returns to the buyer.",
      `If the buyer does not accept within ${ACCEPT_WINDOW_MS / 1000} s of the supplier's Submit, the supplier may Release the escrow and take the price and both bonds.`,
      'If the supplier never submits, the buyer reclaims after `deliver_by`.',
      'The quotes are paid from the vault of the hirer. Each quote hire locks the price and both bonds of the advert of a Bid Desk: 3 units for the adverts of the Bid Desks of this repository. The value limit of the delegation caps the sum of these payments.',
      'The delegation key of the agent pays the fees of each Pay and of each Accept.',
      `When the model does not accept a quote, the agent does not accept the escrow of that quote. The Bid Desk may then Release it ${ACCEPT_WINDOW_MS / 1000} s after its Submit and take the price and both bonds. A challenge does not return that money (see Known gaps).`,
      'The service pays each model hire from the service key.',
    ]) expect(terms, part).toContain(part);
  });

  test('the README of the agent gives the same limits as the page', () => {
    expect(readme).toContain('900000 bytes');
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
  });

  test('the examples of the requests are what the kit makes, the kit parses them, and the intake of the service takes them', () => {
    const [proposeBlock, executeBlock] = jsonBlocks(request);
    expect(proposeBlock).toBe(JSON.stringify(PROPOSE_REQUEST, null, 2));
    expect(executeBlock).toBe(JSON.stringify(EXECUTE_REQUEST, null, 2));
    expect(must(parseRequest(JSON.parse(proposeBlock), parseProposeFields))).toStrictEqual(PROPOSE_REQUEST);
    expect(must(parseRequest(JSON.parse(executeBlock)))).toStrictEqual(EXECUTE_REQUEST);
    expect(parseJob(proposeBlock).op).toBe('propose');
    expect(parseJob(executeBlock).op).toBe('execute');
    const { proposal } = JSON.parse(executeBlock) as typeof EXECUTE_REQUEST;
    expect(must(parseProposal(proposal))).toStrictEqual(PROPOSAL);
    expect(must(parseRanking(proposal.document)).rfq_id).toBe(RFQ.rfq_id);
    // The digest is the sha256 of the 32 bytes of the salt and the canonical JSON of the document.
    expect(createHash('sha256').update(Buffer.from(proposal.salt, 'hex')).update(must(canonicalJson(proposal.document)), 'utf8').digest('hex')).toBe(proposal.proposal_digest);
    expect(request).toContain('The digest is the sha256 of the 32 bytes of the salt and the canonical JSON of the document.');
    // The two requests are a few kilobytes: far below the limits of Terms.
    for (const block of [proposeBlock, executeBlock]) expect(Buffer.byteLength(block)).toBeLessThan(12_000);
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
      'The sourcing record has no rule of one ranking for each request, so a hirer who sends `execute` again after a `failed` result can write a second ranking. Read the sourcing record before you send `execute` again.',
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
      'The `quotes` hold each quote as the Bid Desk returned it. Two parts of a quote take any character: `sender.organisation` (any text of at most 1024 characters) and the decision of the Bid Desk under `decisions` (its choice and its reasoning). A rule on them would fail a quote that was paid for. Show them to an approver as data, escaped, and never as text that a person or a prompt reads as an instruction. The `notes` of a quote are one line of at most 500 characters with no control, format or separator character.',
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
    expect(response).toContain('The result of `execute` has these members, in this order:');
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
      'To check a score, find the record of the quote under `quotes` by its `escrow_ref`, hash `{ receipt, signature }`, and compare the hash with `receipt_sha256`.',
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
      'The job accepts the order only when it is a list of DIDs that holds each scored bidder once (`ranking_invalid` otherwise).',
      'The score is not worked out again from the components and the weights: the model decides the numbers, and the job holds only that each number is from 0 to 100.',
      'It is a member only when the gateway verified the organisation: the sourcing record refuses the value `null`, so the member is left out when there is none |',
    ]) expect(ranking, part).toContain(part);
  });
});
