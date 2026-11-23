// agents/reorder-agent/test/spec.test.ts
// specs/reorder-agent.md is the public page of the agent, and the manifest links to its Response section. These tests hold the page to the code and to the deploy pack: the status, the identity rows, the
// numbers of the terms and the windows, the request limit, the request fields of the schema that the manifest publishes, the example requests and the example result (made here with the kit), the errors
// with their statuses, the claim statements, the gap sentences word for word, the third parties, and the files that the page links.
// The tests read the page, the manifest, the env example and the compose file of the pack, and no network.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { parse } from 'yaml';
import { ACCEPT_WINDOW_MS, HIRE_ACTION } from '@vsa/buyer-core';
import { MAX_BODY, RESERVATION_MS } from '@vsa/service-kit';
import { CONFIRMATIONS_REQUIRED, tokenTarget } from '@vsa/usecase-kit/access';
import { COUNTERPARTY_REFUSED, INTERRUPTION_REASONS, PAY_UNCONFIRMED, checkRuntimeBody, checkWirePayload, completedResult, disputedResult, failedResult, handoffOf, proposedResult, refusedResult, vaultRefusedResult } from '@vsa/usecase-kit/buyer';
import { COSIGN_SETTINGS, COSIGN_STATUS, parseAllowlist, parseCosignSettings } from '@vsa/usecase-kit/cosign';
import { readFaultSwitch, withFaultMode } from '@vsa/usecase-kit/fault';
import { INVENTORY_CAPABILITIES, LOT_NAMES, PO_SCHEMA, REORDER_CLAIM, parseOrderConfirmation, parsePurchaseOrder, poNumberOf } from '@vsa/usecase-kit/inventory';
import {
  AFTER_CLAIM_REFUSALS, APPROVAL_ATT_TYPE, APPROVAL_DEPOSIT_LOVELACE, APPROVAL_VALIDITY_DEFAULT_MS, APPROVAL_VALIDITY_MAX_MS, COSIGN_ROUTE, COSIGN_RULE, COUNTERPARTY_REFUSALS, ERROR_STATUS, EXECUTE_OUTCOMES,
  EXIT_STATES, FAULT_MODES, MAX_REQUEST_BYTES, PROPOSE_OUTCOMES, RECEIPT_CHECKS, RUNTIME_BODY_LIMIT_BYTES, canonicalJson, checkRequestSize, exitStateOf, makeProposal, parseProposal, parseRequest,
} from '@vsa/usecase-kit/protocol';
import type { Decision, ExecuteOutcome, ExecuteRequest, ExecuteResult, HandoffRecord, ProtocolResult, ReceiptVerification, SubJob, WriteRecord } from '@vsa/usecase-kit/protocol';
import { JOB_DEADLINE_MS as EXECUTE_DEADLINE_MS } from '../src/execute/index.ts';
import { ACCEPT_DECISION, REORDER_DECISION, SUPPLIER_FAILURES, acceptInput, parseProposeFields, reorderInput, stockReadingSha256 } from '../src/model/index.ts';
import type { StockReading } from '../src/model/index.ts';
import { PROPOSE_DEADLINE_MS, PROPOSE_FAILURES, ProposeRefusal, runPropose } from '../src/propose/index.ts';
import type { ProposeDeps, ProposeRequest } from '../src/propose/index.ts';
import { CHALLENGE_GAP, KEYS_GAP, NOT_SHOWN_GAP, gapsFor } from '../src/serve/gaps.ts';
import { REQUEST_SCHEMA, TEMPLATE_ENV, manifestFromEnv } from '../src/serve/manifest.ts';
import { RequestError, parseJob } from '../src/serve/server.ts';
import { BUYER_BOND_LOVELACE, JOB_DEADLINE_MS, MIN_PROCESSING_WINDOW_MS, PRICE_DEFAULT_LOVELACE, SUPPLIER_BOND_LOVELACE, module1SourceOf, priceOf, processingWindowOf, supplierKeyOf } from '../src/serve/settings.ts';
import { SETTINGS } from '../src/serve/start.ts';

const root = new URL('../../../', import.meta.url);
const text = (path: string): string => readFileSync(new URL(path, root), 'utf8');
const page = text('specs/reorder-agent.md');
const readme = text('agents/reorder-agent/README.md');
const runbook = text('deploy/server/RUNBOOK-reorder-agent.md');
const envExample = text('deploy/server/.env.reorder-agent.example');
const compose = parse(text('deploy/server/docker-compose.reorder-agent.yml')) as { services: { runtime: { environment: Record<string, string> } } };
const runtimeEnv = compose.services.runtime.environment;

const section = (heading: string): string => (page.split(`\n## ${heading}\n`)[1] ?? '').split('\n## ')[0];
const sub = (heading: string): string => (page.split(`\n### ${heading}\n`)[1] ?? '').split(/\n##+ /)[0];
const row = (table: string, label: string): string => table.split('\n').find((line) => line.startsWith(`| ${label} |`)) ?? '';
const envLine = (name: string): string | undefined => envExample.split('\n').find((line) => line.startsWith(`${name}=`))?.substring(name.length + 1);
const manifest = manifestFromEnv({ ...TEMPLATE_ENV });

/** The day of the page. The status line of the page and of its entry in the list of pages hold it. */
const PAGE_DATE = '2026-11-23';
const STATUS_LINE = `PROPOSED (built, not deployed). Since ${PAGE_DATE}.`;

describe('specs/reorder-agent.md', () => {
  test('the opening line, the capability, the model string and the status are the manifest and the pack', () => {
    expect(page.startsWith('# Reorder Agent\n')).toBe(true);
    expect(manifest.name).toBe('Reorder Agent');
    expect(page.split('\n')[2]).toBe(`Capability \`${manifest.capability_id}\`. ${manifest.description}`);
    expect(manifest.capability_id).toBe(INVENTORY_CAPABILITIES.reorder);
    expect(section('Capability id').split('\n')[1]).toBe(`\`${manifest.capability_id}\``);
    expect(section('Capability id')).toContain('The model string in the advert and in every receipt is `reorder-agent-v1`.');
    expect(row(runbook, 'Reorder')).toContain('| `reorder-agent-v1` |');
    expect(manifest.status.chip).toBe('proposed');
    expect(STATUS_LINE.startsWith(`${manifest.status.chip.toUpperCase()} (`)).toBe(true);
    expect(section('Status').split('\n')).toContain(STATUS_LINE);
    expect(section('Status')).toContain('\nNothing on this page is LIVE or DEPLOYED.\n');
  });

  test('the runtime and the service: one runtime in front, five keys in the service, no API key, and a check before the Claim', () => {
    const capability = section('Capability id');
    expect(runtimeEnv.CAPABILITY_KIND).toBe('custom');
    expect(capability).toContain('`CAPABILITY_KIND=custom`');
    expect(runtimeEnv.SERVICE_PRECHECK_URL.endsWith('/precheck')).toBe(true);
    expect(capability).toContain('The runtime claims the escrow, asks the service whether to take the job, calls the service, signs the receipt and submits its hash.');
    const keys = SETTINGS.filter((name) => name.endsWith('_PRIV_KEY_HEX'));
    expect(keys).toHaveLength(5);
    expect(capability).toContain('It holds five keys and no API key of any third party.');
    expect(SETTINGS.filter((name) => name.includes('API'))).toStrictEqual([]);
    expect(keys).not.toContain('SUPPLIER_PRIV_KEY_HEX');
    expect(capability).toContain('It does not hold the supplier key: it knows only its key hash and its public key.');
    expect(runtimeEnv.REORDER_SERVICE_PRIV_KEY_HEX).toBe('');
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
    expect(Object.keys(manifest.keys)).toStrictEqual(['supplier_pkh', 'pub_key_hex', 'buyer_pkh', 'delegation_pkhs']);
    const supplier = row(identity, 'Supplier key');
    for (const member of ['keys.supplier_pkh', 'keys.pub_key_hex']) expect(supplier).toContain(`\`${member}\``);
    expect(supplier).toContain('The service never holds it.');
    expect(supplier).toContain('The service does not start unless the public key hashes to the key hash');
    expect(() => supplierKeyOf({ SUPPLIER_PKH: 'aa'.repeat(28), SUPPLIER_PUB_KEY_HEX: 'bb'.repeat(32) })).toThrow('is not the public key of SUPPLIER_PKH');
    expect(row(identity, 'Service key')).toContain('The manifest publishes its key hash as `keys.buyer_pkh`');
    expect(manifest.keys.buyer_pkh).toBe(TEMPLATE_ENV.REORDER_SERVICE_PKH);
    const delegation = row(identity, 'Delegation keys');
    expect(delegation.startsWith('| Delegation keys | two keys,')).toBe(true);
    expect(delegation).toContain('`keys.delegation_pkhs`');
    expect(manifest.keys.delegation_pkhs).toHaveLength(2);
    // The subagent and its two keys are the other two of the five.
    const subagent = row(identity, 'Subagent');
    expect(subagent).toContain('which are the other two keys of the service');
    expect(subagent).toContain('`STOCK_READER_DID`');
    expect(SETTINGS).toContain('STOCK_READER_DID');
    expect(SETTINGS.filter((name) => name.startsWith('STOCK_READER_') && name.endsWith('_PRIV_KEY_HEX'))).toHaveLength(2);
    // The organisation is a domain with the description of the demonstration.
    expect(row(identity, 'Organisation')).toBe('| Organisation | the domain `echo.vector.apexfusion.org`, with the description "Demonstration organisation run by the Apex Fusion Foundation". The identity gateway verifies the domain with a DNS TXT record |');
    expect(row(identity, 'Parties')).toContain('Guardians: the guardian key of the organisation and a controller key of this deployment, with threshold 2');
    expect(row(identity, 'Reputation stake')).toBe('| Reputation stake | a Module-3 self-stake on the capability, owned by the service key |');
    expect(row(identity, 'Claim')).toBe('| Claim | a Module-1 claim for each run, staked with the service key. See Claim statements |');
  });

  test('the public URL of the identity table is the origin of the runtime in the compose file of the pack', () => {
    expect(row(section('Identity'), 'Public URL')).toBe(`| Public URL | planned: \`${runtimeEnv.PUBLIC_ORIGIN}\`, the origin of the runtime in the pack. The agent has no advert yet |`);
    expect(runtimeEnv.PUBLIC_ORIGIN.startsWith('https://')).toBe(true);
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
    // The price is the default of the setting, the bonds are constants, and the env example has the same price.
    expect(priceOf({})).toBe(PRICE_DEFAULT_LOVELACE);
    expect(envLine('ADVERT_PRICE_LOVELACE')).toBe(String(PRICE_DEFAULT_LOVELACE));
    expect(terms).toContain('The price is the default of `ADVERT_PRICE_LOVELACE`. Each bond is fixed in the code. The manifest publishes the three amounts in `terms`.');
  });

  test('the three times: the window of the advert, the timeout of the runtime and the deadline of a job are the code, the compose file and the env example', () => {
    const terms = section('Terms');
    const timeout = Number(runtimeEnv.SERVICE_TIMEOUT_MS);
    expect([MIN_PROCESSING_WINDOW_MS, timeout, JOB_DEADLINE_MS]).toStrictEqual([1_800_000, 1_680_000, 1_620_000]);
    expect(manifest.terms.max_processing_ms).toBe(MIN_PROCESSING_WINDOW_MS);
    expect(processingWindowOf({})).toBe(MIN_PROCESSING_WINDOW_MS);
    expect(Number(runtimeEnv.ADVERT_MAX_PROCESSING_MS)).toBe(MIN_PROCESSING_WINDOW_MS);
    expect(Number(envLine('ADVERT_MAX_PROCESSING_MS'))).toBe(MIN_PROCESSING_WINDOW_MS);
    expect([PROPOSE_DEADLINE_MS, EXECUTE_DEADLINE_MS]).toStrictEqual([JOB_DEADLINE_MS, JOB_DEADLINE_MS]);
    expect((MIN_PROCESSING_WINDOW_MS - timeout) / 1000).toBe(120);
    expect((timeout - JOB_DEADLINE_MS) / 1000).toBe(60);
    expect(row(terms, 'Processing window, advert `max_processing_ms`')).toBe(`| Processing window, advert \`max_processing_ms\` | ${MIN_PROCESSING_WINDOW_MS} ms |`);
    expect(row(terms, 'Service timeout, `SERVICE_TIMEOUT_MS`')).toBe(`| Service timeout, \`SERVICE_TIMEOUT_MS\` | ${timeout} ms (120 s inside the window) |`);
    expect(row(terms, 'Job deadline, set by the service when a request arrives')).toBe(`| Job deadline, set by the service when a request arrives | ${JOB_DEADLINE_MS} ms (60 s inside the service timeout) |`);
  });

  test('the other limits of the Terms table: the request, the sub-delegation, the model calls, the one job at a time and the reservation', () => {
    const terms = section('Terms');
    const limits = manifest.terms.input_limits;
    expect(limits).toStrictEqual({ request_bytes: MAX_REQUEST_BYTES, sku_chars: 64, tenant_chars: 48 });
    expect(row(terms, 'Request')).toBe(`| Request | at most ${limits.request_bytes} bytes of request JSON; \`sku\` 1 to ${limits.sku_chars} characters; \`tenant\` 1 to ${limits.tenant_chars} characters |`);
    expect(row(terms, 'Sub-delegation')).toBe(`| Sub-delegation | \`stock-reader\` gets its token after ${CONFIRMATIONS_REQUIRED} confirmations of the sub-delegation |`);
    expect(CONFIRMATIONS_REQUIRED).toBe(30);
    expect([REORDER_DECISION.name, ACCEPT_DECISION.name]).toStrictEqual(['reorder', 'accept_delivery']);
    expect(row(terms, 'Model calls')).toBe('| Model calls | at most one in `propose` (decision `reorder`) and at most one in `execute` (decision `accept_delivery`) |');
    expect(ERROR_STATUS.busy).toBe(409);
    expect(row(terms, 'Jobs at a time')).toBe('| Jobs at a time | one: a second job gets 409 `busy` |');
    expect(row(terms, 'Reservation')).toBe(`| Reservation | a go from \`POST /precheck\` reserves the job slot for ${RESERVATION_MS / 1000} s |`);
  });

  test('the request limit is 900000 bytes of request JSON, and it is safe only below the 1 MiB limit of the runtime on the escaped body', () => {
    const terms = section('Terms');
    expect([MAX_REQUEST_BYTES, RUNTIME_BODY_LIMIT_BYTES, MAX_BODY]).toStrictEqual([900_000, 1_048_576, 1_000_000]);
    for (const part of [
      'The service counts the request JSON in bytes of UTF-8, and it refuses a request JSON of more than 900000 bytes with `request_too_large` (400). It reads at most 1000000 bytes of wire payload.',
      'The wire payload carries the request JSON as a string inside a one-message array (see Interface).',
      'The limit of 900000 bytes is safe only below the 1 MiB limit of the runtime, 1048576 bytes, on the escaped body.',
      'A request JSON under 900000 bytes can give a body above 1048576 bytes, and the runtime refuses that body. A sender keeps the body of its call at or below 1048576 bytes.',
      'The two requests of this agent are a few kilobytes, so they are far below both limits.',
    ]) expect(terms, part).toContain(part);
    // The service counts the request JSON: one byte over the limit is refused as too large, and the limit itself passes the size check and fails as a request that is no JSON.
    const codeOf = (request: string): string => {
      try {
        parseJob(request);
        return 'accepted';
      } catch (error) {
        return error instanceof RequestError ? error.code : 'other';
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

  test('the economics: what the supplier receives, the window to accept, the vault and the fees', () => {
    const terms = section('Terms');
    expect(ACCEPT_WINDOW_MS).toBe(600_000);
    for (const part of [
      'A hire of either operation locks the price and both bonds, 5 units.',
      "On Accept the supplier receives the price and the supplier bond, and the buyer's bond returns to the buyer.",
      `If the buyer does not accept within ${ACCEPT_WINDOW_MS / 1000} s of the supplier's Submit, the supplier may Release the escrow and take the price and both bonds.`,
      'If the supplier never submits, the buyer reclaims after `deliver_by`.',
      'The order is paid from the vault of the hirer: the vault pays the price and both bonds of the advert of the lot, and the value limit of the delegation caps that payment.',
      'The delegation key of the agent pays the fees of that Pay and of the Accept.',
    ]) expect(terms, part).toContain(part);
  });

  test('the README of the agent gives the same limits as the page', () => {
    expect(readme).toContain('900000 bytes');
    expect(readme).toContain(`${JOB_DEADLINE_MS} ms`);
    expect(readme).toContain(`${MIN_PROCESSING_WINDOW_MS} ms`);
  });
});

// ---- The examples of the page: an order, a decision, a proposal and the results of execute, made with the kit from labels -------------------------------------------------------------------------

/** A hex text made from a label: no reference, hash or key of an example belongs to an escrow, a supplier or a key. */
const made = (label: string, algorithm = 'sha256'): string => createHash(algorithm).update(`reorder agent example: ${label}`).digest('hex');
const didOf = (label: string): string => `did:vector:${made(label)}`;

/** The value of an accepted result. A refusal stops the test, and its detail names the field. */
function must<T, C extends string>(result: ProtocolResult<T, C>): T {
  if (!result.ok) throw new Error(result.detail);
  return result.value;
}

const TENANT = 'demo';
const MODEL = 'deepseek/deepseek-v4-flash';
const READING: StockReading = { sku: 'GLV-NIT-M', on_hand: 60, threshold: 100, daily_usage: 12, lead_time_days: 7, open_orders: 0 };
const HIRER = didOf('the hirer');
const AUTHORITY = { principal_did: HIRER, delegation: made('the delegation') };
const PROPOSE_REQUEST = { op: 'propose', authority: AUTHORITY, tenant: TENANT, sku: READING.sku, supplier_did: didOf('the Order Desk') };
const ORDER = must(parsePurchaseOrder({
  schema: PO_SCHEMA, po_number: poNumberOf(TENANT, 1), tenant: TENANT, sku: READING.sku, lot: 'lot-medium', quantity: 50, needed_by: '2026-12-01', supplier_did: PROPOSE_REQUEST.supplier_did,
  advert_ref: `${made('the advert of lot-medium')}#0`, stock_reading_sha256: must(stockReadingSha256(READING)),
}));
const SALT = made('the salt');
const PROPOSAL = must(makeProposal(ORDER, SALT));
const EXECUTE_REQUEST = { op: 'execute', authority: AUTHORITY, tenant: TENANT, proposal: PROPOSAL, approval: { attestation: made('the approval'), issuer_did: HIRER } };

const MODEL_ESCROW = `${made('the escrow of the model')}#0`;
const MODEL_SUPPLIER = made('the key of the model supplier').substring(0, 56);
const SUB_JOB: SubJob = {
  capability_id: 'llm.text.generate.v1', advert_ref: `${made('the advert of the model')}#0`, escrow_ref: MODEL_ESCROW, supplier_pkh: MODEL_SUPPLIER,
  receipt: {
    escrow_ref: MODEL_ESCROW, supplier_pkh: MODEL_SUPPLIER, prompt_hash: made('the prompt'), response_hash: made('the answer'), model: MODEL, prompt_tokens: 412, completion_tokens: 58, wallclock_ms: 2140,
  },
  receipt_signature: made('the signature of the model supplier', 'sha512'),
  verification: Object.fromEntries(RECEIPT_CHECKS.map((check) => [check, true])) as ReceiptVerification,
};
const DECISION: Decision = {
  name: 'reorder',
  choice: { lot: 'lot-medium', quantity: 50, needed_by: '2026-12-01' },
  reasoning: 'The stock of 60 is below the threshold of 100, and the use is 12 a day over a lead time of 7 days. The medium lot of 50 brings the stock back above the threshold.',
  inference: { path: 'marketplace', sub_job: SUB_JOB, accepted: 'confirmed' },
};
const FAULT = readFaultSwitch('reorder-agent', '');
const PROPOSED = withFaultMode(FAULT, proposedResult(ORDER, { use_case: 'inventory-reorder', decisions: [DECISION], sub_jobs: [SUB_JOB], fault_mode: '' }, SALT));

const ORDER_ESCROW = `${made('the escrow of the order')}#0`;
const HANDOFF: HandoffRecord = {
  counterparty_did: ORDER.supplier_did, advert_ref: ORDER.advert_ref, escrow_ref: ORDER_ESCROW, paid_from_vault: true,
  receipt: { escrow_ref: ORDER_ESCROW, supplier_pkh: made('the key of the Order Desk').substring(0, 56), agent_did: ORDER.supplier_did },
  receipt_signature: made('the signature of the Order Desk', 'sha512'), verification: SUB_JOB.verification, result: { po_number: ORDER.po_number }, accepted: 'confirmed',
};
const WRITE: WriteRecord = { system: 'po-store', route: 'POST /po', status: 201, ref: 'PO-1' };
const CHALLENGE = { claim: `${made('the claim')}#0`, evidence: made('the evidence'), challenge: `${made('the challenge')}#0` };
const PIECES = { use_case: 'inventory-reorder', proposal_digest: PROPOSAL.proposal_digest, handoff: HANDOFF, writes: [WRITE], decisions: [DECISION], fault_mode: '' } as const;
/** One result of execute for each outcome. A dispute holds a hire whose Accept was not made. */
const RESULTS: Record<ExecuteOutcome, ExecuteResult> = {
  completed: completedResult(PIECES),
  vault_refused: vaultRefusedResult({ ...PIECES, handoff: null, writes: [] }, 'the node refused the Pay', false),
  refused_by_counterparty: refusedResult('counterparty', { ...PIECES, handoff: null, writes: [] }, 'lot_mismatch'),
  refused_by_system: refusedResult('system', { ...PIECES, writes: [] }, 'not_covered'),
  disputed: disputedResult({ ...PIECES, handoff: { ...HANDOFF, accepted: 'no' }, writes: [] }, { challenge: CHALLENGE }),
  failed: failedResult({ ...PIECES, writes: [] }, 'deadline'),
};

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
/** The rows of a table of statuses and codes, as "status:code" for each code in backticks of the second cell. */
const codePairs = (body: string): string[] => body.split('\n').filter((line) => /^\| \d/.test(line)).flatMap((line) => {
  const [status, cell] = line.substring(2).split(' | ');
  return [...cell.matchAll(/`([a-z][a-z0-9_]*)`/g)].map((hit) => `${status}:${hit[1]}`);
});

describe('specs/reorder-agent.md, Interface', () => {
  const request = sub('Request');
  const response = sub('Response');

  test('the request fields: each member of the schema is on the page, and the intake holds the rules of the field tables', async () => {
    const [propose, execute] = REQUEST_SCHEMA.oneOf;
    expect(Object.keys(propose.properties)).toStrictEqual(['op', 'authority', 'tenant', 'sku', 'supplier_did']);
    expect(Object.keys(execute.properties)).toStrictEqual(['op', 'authority', 'tenant', 'proposal', 'approval']);
    for (const field of ['op', 'authority', 'principal_did', 'delegation', 'tenant', 'sku', 'supplier_did', 'proposal', 'document', 'salt', 'proposal_digest', 'approval', 'attestation', 'issuer_did']) {
      expect(request, field).toContain(`\`${field}\``);
    }
    const proposeOk = (over: Record<string, unknown>): boolean => parseRequest({ ...PROPOSE_REQUEST, ...over }, parseProposeFields).ok;
    expect(proposeOk({})).toBe(true);
    expect([proposeOk({ sku: 'a'.repeat(64) }), proposeOk({ sku: 'a'.repeat(65) }), proposeOk({ sku: '' }), proposeOk({ sku: '.a' }), proposeOk({ sku: 'a b' }), proposeOk({ sku: 'A-1_2.3' })]).toStrictEqual([true, false, false, false, false, true]);
    // The tenant: the job refuses a `propose` request with a tenant outside the rule, with `bad_shape` (400), before it reads anything. The intake does not refuse it, and the job of `execute` checks it against the order.
    const tenantCheck = async (tenant: string): Promise<string> => {
      try {
        await runPropose({} as ProposeDeps, { ...PROPOSE_REQUEST, tenant } as unknown as ProposeRequest, 0);
        return 'past the check';
      } catch (error) {
        return error instanceof ProposeRefusal ? `${error.code} ${error.status}` : 'past the check';
      }
    };
    expect(await Promise.all(['a'.repeat(48), 'a'.repeat(49), 'Demo', '-a', 'a-1'].map(tenantCheck))).toStrictEqual(['past the check', 'bad_shape 400', 'bad_shape 400', 'bad_shape 400', 'past the check']);
    expect(parseRequest({ ...EXECUTE_REQUEST, tenant: 'Demo' }).ok).toBe(true);
    expect(request).toContain('One exception is the tenant of `execute`: the job checks it against its order (`po_not_for_tenant`).');
    expect([proposeOk({ supplier_did: 'nope' }), proposeOk({ extra: 1 }), proposeOk({ op: 'cancel' }), proposeOk({ authority: { principal_did: HIRER } })]).toStrictEqual([false, false, false, false]);
    const executeOk = (over: Record<string, unknown>): boolean => parseRequest({ ...EXECUTE_REQUEST, ...over }).ok;
    expect([executeOk({}), executeOk({ approval: null })]).toStrictEqual([true, true]);
    expect([executeOk({ proposal: { ...PROPOSAL, proposal_digest: made('another digest') } }), executeOk({ extra: 1 }), executeOk({ approval: { attestation: made('only the attestation') } })]).toStrictEqual([false, false, false]);
    const { approval: _left, ...withoutApproval } = EXECUTE_REQUEST;
    expect(parseRequest(withoutApproval).ok).toBe(false);
    expect(request).toContain('The authority has no vault: the agent finds the Live vault of the delegation itself.');
    expect(request).toContain('The agent does not check the approval. It passes it on, and the Order Desk refuses an order with no valid approval.');
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
    expect(must(parsePurchaseOrder(proposal.document))).toStrictEqual(ORDER);
    // The digest is the sha256 of the 32 bytes of the salt and the canonical JSON of the document.
    expect(createHash('sha256').update(Buffer.from(proposal.salt, 'hex')).update(must(canonicalJson(proposal.document)), 'utf8').digest('hex')).toBe(proposal.proposal_digest);
    expect(request).toContain('The digest is the sha256 of the 32 bytes of the salt and the canonical JSON of the document.');
    // The two requests are a few kilobytes: far below the limits of Terms.
    for (const block of [proposeBlock, executeBlock]) expect(Buffer.byteLength(block)).toBeLessThan(5_000);
  });

  test('the steps of propose and execute: the codes that they name are codes of the jobs, and the inputs of the two decisions are the ones that the steps say', () => {
    for (const code of ['delegation_not_mine', 'delegation_not_found', 'delegation_key_unknown', 'supplier_not_listed', 'supplier_manifest_invalid', 'supplier_lots_invalid', 'sku_not_in_lots', 'supplier_unavailable']) {
      expect(request, code).toContain(`\`${code}\``);
    }
    for (const code of ['bad_document', 'po_not_for_tenant', 'bad_shape', 'request_too_large', 'no_live_vault', 'several_live_vaults', 'vault_refused', 'confirmation_invalid', 'confirmation_not_for_order', 'cannot_supply']) {
      expect(request, code).toContain(`\`${code}\``);
    }
    expect(PROPOSE_FAILURES).toEqual(expect.arrayContaining(['delegation_not_found', 'delegation_key_unknown', 'stock_reading_mismatch', 'decision_mismatch']));
    expect(SUPPLIER_FAILURES).toStrictEqual(['supplier_not_listed', 'supplier_manifest_invalid', 'supplier_lots_invalid', 'sku_not_in_lots', 'supplier_unavailable']);
    expect(AFTER_CLAIM_REFUSALS).toStrictEqual(['cannot_supply']);
    expect([COUNTERPARTY_REFUSED, ERROR_STATUS.check_unavailable]).toStrictEqual(['counterparty_refused', 503]);
    expect(request).toContain('When the order fails a check, the Order Desk refuses with a 403 and a code, and the result is `refused_by_counterparty` with that code.');
    expect(request).toContain('Any other answer before the Claim is a `failed` result. Its reason is the code of the answer when the protocol lists it, such as `check_unavailable` (503), and `counterparty_refused` otherwise.');
    expect(RECEIPT_CHECKS).toHaveLength(8);
    expect(request).toContain('It runs the eight checks on the receipt of the Order Desk.');
    // The model of `reorder` reads the stock reading, the three lot sizes and the date of today. The model of `accept_delivery` reads the SKU, the lot and the quantity of each side, and nothing else.
    const input = reorderInput(READING, { 'lot-small': 10, 'lot-medium': 50, 'lot-large': 200 }, '2026-11-30') as Record<string, unknown>;
    expect(Object.keys(input)).toStrictEqual(['stock_reading', 'lots', 'today']);
    expect(LOT_NAMES).toStrictEqual(['lot-small', 'lot-medium', 'lot-large']);
    const confirmation = must(parseOrderConfirmation(JSON.parse(readFileSync(new URL('agents/reorder-agent/test/model/golden/confirmation.json', root), 'utf8'))));
    const seen = acceptInput(ORDER, confirmation) as Record<string, Record<string, unknown>>;
    expect(Object.keys(seen)).toStrictEqual(['purchase_order', 'confirmation']);
    expect([Object.keys(seen.purchase_order), Object.keys(seen.confirmation)]).toStrictEqual([['sku', 'lot', 'quantity'], ['sku', 'lot', 'quantity']]);
    expect(request).toContain('The model reads the SKU, the lot and the quantity of the order and of the confirmation, and nothing else of either.');
    // The agent accepts exactly when `mismatch` is empty: an answer that says both is no choice.
    expect([ACCEPT_DECISION.parse({ accept: true, mismatch: [] }).ok, ACCEPT_DECISION.parse({ accept: false, mismatch: ['lot'] }).ok, ACCEPT_DECISION.parse({ accept: true, mismatch: ['lot'] }).ok, ACCEPT_DECISION.parse({ accept: false, mismatch: [] }).ok]).toStrictEqual([true, true, false, false]);
    expect(text('agents/reorder-agent/src/execute/execute.ts')).toContain('statement_text: ORDER_DESK_CLAIM.statements[0].text');
  });

  test('the Response example is the result that the kit makes of the order, the decision and the sub-job, byte for byte', () => {
    expect(page.match(/^### Response$/gm)).toHaveLength(1);
    expect(manifest.interface.response_schema.$ref.endsWith('/specs/reorder-agent.md#response')).toBe(true);
    expect(jsonBlocks(response)[0]).toBe(JSON.stringify(PROPOSED, null, 2));
  });

  test('the proposal: the table names its members, the example holds them in the order of the result, and fault_mode is last and empty', () => {
    const shown = JSON.parse(jsonBlocks(response)[0]) as Record<string, unknown>;
    const keys = Object.keys(shown);
    expect(keys).toStrictEqual(['schema', 'use_case', 'decisions', 'sub_jobs', 'document', 'salt', 'proposal_digest', 'outcome', 'exit_state', 'reason', 'fault_mode']);
    expect(namesOf(firstCells(response, '| Member | Content |')).sort()).toStrictEqual([...keys].sort());
    expect(shown).toMatchObject({ schema: 'vector.usecase.proposal.v1', use_case: 'inventory-reorder', outcome: 'proposed', exit_state: null, reason: null, fault_mode: '' });
    expect(PROPOSE_OUTCOMES).toStrictEqual(['proposed', 'failed']);
    expect((shown.decisions as Decision[])[0].inference.sub_job).toStrictEqual((shown.sub_jobs as SubJob[])[0]);
    expect(Object.keys(SUB_JOB)).toStrictEqual(['capability_id', 'advert_ref', 'escrow_ref', 'supplier_pkh', 'receipt', 'receipt_signature', 'verification']);
    expect(Object.keys(SUB_JOB.verification)).toStrictEqual([...RECEIPT_CHECKS]);
    expect(MODEL).toBe(manifest.behaviour.model.allowlist[0]);
    expect(response).toContain('The example is an illustration and not a recorded run. Its references, hashes, key hash and signature are made from labels, and they belong to no escrow, no supplier and no key.');
  });

  test('the stock reading of the example hashes to the stock_reading_sha256 of the order, and the page shows its canonical text', () => {
    const canonical = must(canonicalJson(READING));
    expect(createHash('sha256').update(canonical, 'utf8').digest('hex')).toBe(ORDER.stock_reading_sha256);
    expect(response).toContain(`The stock reading of the example, in canonical form, is \`${canonical}\`. Its sha256 is the \`stock_reading_sha256\` of the order.`);
  });

  test('the purchase order: the table names its members, the number is the tenant and a counter, and the choice of the model is not held to the size of the lot or to the date of today', () => {
    expect(namesOf(firstCells(response, '| Document member | Content |')).sort()).toStrictEqual(Object.keys(ORDER).sort());
    expect(ORDER.schema).toBe(PO_SCHEMA);
    expect(ORDER.po_number).toBe(poNumberOf(TENANT, 1));
    expect(row(response, '`schema`')).toContain('| `schema` |');
    expect(row(response, '`lot`')).toBe('| `lot` | `lot-small`, `lot-medium` or `lot-large`, as the model chose |');
    expect(row(response, '`quantity`')).toBe('| `quantity` | the quantity that the model chose. The Order Desk refuses a quantity that is not the size of the lot |');
    expect(row(response, '`needed_by`')).toBe('| `needed_by` | the date that the model chose, as `YYYY-MM-DD` |');
    expect(REORDER_DECISION.parse({ lot: 'lot-medium', quantity: 7, needed_by: '2020-01-01' }).ok).toBe(true);
    expect(response).toContain('The service does not hold the choice of the model to the size of the lot or to the date of today.');
  });

  test('the result of execute: the table names the members of every outcome, and the members of the three records are on the page', () => {
    const names = namesOf(firstCells(response, '| Result member | Content |')).sort();
    for (const [outcome, result] of Object.entries(RESULTS)) {
      const stamped = withFaultMode(FAULT, result);
      expect(Object.keys(stamped).sort(), outcome).toStrictEqual(names);
      expect(Object.keys(stamped).at(-1), outcome).toBe('fault_mode');
      expect(result.outcome, outcome).toBe(outcome);
    }
    for (const [label, record] of [['handoff', HANDOFF], ['writes', WRITE], ['challenge', CHALLENGE]] as const) {
      for (const member of Object.keys(record)) expect(row(response, `\`${label}\``), `${label}.${member}`).toContain(`\`${member}\``);
    }
    expect(row(response, '`handoff`')).toContain('`accepted` (`confirmed`, `pending` or `no`)');
  });

  test('the outcomes table lists the outcomes of the kit and gives the exit states of its rule', () => {
    const outcomes = sub('Outcomes');
    expect(firstCells(outcomes, '| Outcome | Exit state | When |').map((cell) => cell.replaceAll('`', ''))).toStrictEqual([...EXECUTE_OUTCOMES]);
    const states = EXIT_STATES.map((state) => `\`${state}\``);
    const lastState = states.pop();
    expect(outcomes).toContain(`The exit state is ${states.join(', ')} or ${lastState}.`);
    const state = (outcome: ExecuteOutcome, reason: string | null, filed = false, ended = false): string => exitStateOf({ outcome, reason, challenge_filed: filed, delegation_ended: ended });
    expect(state('completed', null)).toBe('Completed');
    expect([state('vault_refused', 'words', false, true), state('vault_refused', 'words')]).toStrictEqual(['Cancelled', 'Failed']);
    expect(['approval_digest_mismatch', 'approval_expired', 'delegation_ended', 'lot_mismatch'].map((reason) => state('refused_by_counterparty', reason))).toStrictEqual(['Escalated', 'Expired', 'Cancelled', 'Rejected']);
    expect(['approval_digest_mismatch', 'approval_expired', 'delegation_ended', 'not_covered'].map((reason) => state('refused_by_system', reason))).toStrictEqual(['Rejected', 'Expired', 'Cancelled', 'Rejected']);
    expect([state('disputed', null, true), state('disputed', 'no_open_claim')]).toStrictEqual(['Escalated', 'Failed']);
    expect(state('failed', 'deadline')).toBe('Failed');
    expect(row(outcomes, '`completed`')).toContain('| `Completed` |');
    expect(row(outcomes, '`vault_refused`')).toContain('| `Cancelled` when the hirer ended the delegation, else `Failed` |');
    expect(row(outcomes, '`refused_by_counterparty`')).toContain('| `Rejected`, but `Escalated` for `approval_digest_mismatch`, `Expired` for `approval_expired` and `Cancelled` for `delegation_ended` |');
    expect(row(outcomes, '`refused_by_system`')).toContain('| `Rejected`, but `Expired` for `approval_expired` and `Cancelled` for `delegation_ended` |');
    expect(row(outcomes, '`disputed`')).toContain('| `Escalated` when the agent filed a challenge, else `Failed` |');
    expect(row(outcomes, '`failed`')).toContain('| `Failed` |');
    expect(outcomes).toContain('A `propose` job ends with `proposed` or with `failed`, and a proposal has no exit state.');
  });

  test('the Errors table gives each code the status of the kit and is the table of the README, and the reasons are codes of the sources', () => {
    const errors = sub('Errors');
    const pairs = codePairs(errors);
    const serverOwn: Record<string, number> = { bad_context: 400 };
    for (const pair of pairs) {
      const [status, code] = pair.split(':');
      expect([code, Number(status)], pair).toStrictEqual([code, (ERROR_STATUS as Record<string, number>)[code] ?? serverOwn[code]]);
    }
    expect(pairs).toStrictEqual(codePairs((readme.split('\n## Errors\n')[1] ?? '').split('The co-sign route has its own codes:')[0]));
    expect(pairs.map((pair) => pair.split(':')[1])).toStrictEqual(['bad_wire', 'request_too_large', 'bad_shape', 'bad_context', 'delegation_not_mine', 'unauthorized', 'busy', 'shutting_down', 'internal']);
    expect(errors).toContain('A job that the service runs and that does not end well is no HTTP error: it is a 200 result with the outcome `failed` and a `reason` code.');
    const reasons = namesOf(firstCells(errors, '| Reason | What it says |'));
    expect(reasons.length).toBeGreaterThan(20);
    const sources = [new URL('agents/reorder-agent/src/', root), new URL('packages/usecase-kit/src/', root)]
      .flatMap((dir) => readdirSync(dir, { recursive: true }).map(String).filter((file) => file.endsWith('.ts')).map((file) => readFileSync(new URL(file, dir), 'utf8')))
      .join('\n');
    for (const code of reasons) expect(sources.includes(`'${code}'`), code).toBe(true);
    // The reasons that the page names for the interrupted hire are the ones of the kit.
    expect([INTERRUPTION_REASONS.decision_error, INTERRUPTION_REASONS.other, PAY_UNCONFIRMED]).toStrictEqual(['decision_error', 'hire_interrupted', 'pay_unconfirmed']);
    // A failure of the sub-delegation or of the token of stock-reader is the code of the failure with a prefix.
    expect(PROPOSE_FAILURES).toEqual(expect.arrayContaining(['sub_delegation_parent_not_live', 'token_delegation_too_young']));
    expect(errors).toContain('A failure of the sub-delegation of `stock-reader` is `sub_delegation_` and the code of the failure, such as `sub_delegation_parent_not_live`. A failure of its token is `token_` and the code of the failure, such as `token_delegation_too_young`.');
  });

  test('the co-sign route: the path, the rule, the allowlist and the codes are the kit and the manifest', () => {
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
      expect(status.split(', ').map(Number), pair).toContain((COSIGN_STATUS as Record<string, number>)[code]);
    }
    expect(pairs.map((pair) => pair.split(':')[1]).sort()).toStrictEqual(Object.keys(COSIGN_STATUS).sort());
    expect(pairs).toStrictEqual(codePairs((readme.split('The co-sign route has its own codes:')[1] ?? '').split('\n## ')[0]));
  });
});

describe('specs/reorder-agent.md, the receipt, the claim and the fault switch', () => {
  test('What the receipt commits to: the fields of the table, the members of the results that it holds, and the checks of the sub-receipt', () => {
    const receipt = section('What the receipt commits to');
    expect(receipt).toContain('The service signs no receipt. The runtime builds the receipt, signs it with the supplier key and submits its hash in the Submit transaction.');
    expect(row(receipt, '`escrow_ref`')).toBe('| `escrow_ref` | the escrow UTxO, `<txid>#<index>` |');
    expect(row(receipt, '`supplier_pkh`')).toBe('| `supplier_pkh` | the key hash of the supplier key |');
    expect(row(receipt, '`prompt_hash`')).toBe('| `prompt_hash` | sha256 of the UTF-8 bytes of the wire payload, as the buyer committed it in the escrow datum |');
    expect(row(receipt, '`response_hash`')).toBe('| `response_hash` | sha256 of the UTF-8 bytes of the result exactly as the service returned them |');
    expect(row(receipt, '`model`')).toBe('| `model` | `reorder-agent-v1` |');
    expect(receipt).toContain('The receipt of a `propose` job commits the purchase order, the salt, the digest of the proposal, the hash of the stock reading, and the decision of the model with its reasoning and the sub-job that bought it.');
    expect(receipt).toContain('The receipt of an `execute` job commits the outcome, the confirmation that the Order Desk returned with its receipt, the decision on the delivery, every write to a mock system and, on `disputed`, the references of the challenge.');
    for (const path of ['document.stock_reading_sha256', 'salt', 'proposal_digest', 'decisions.0.reasoning', 'decisions.0.inference.sub_job']) expect(PROPOSED, path).toHaveProperty(path);
    for (const path of ['outcome', 'handoff.result', 'handoff.receipt', 'decisions.0.name', 'writes.0.route']) expect(RESULTS.completed, path).toHaveProperty(path);
    expect(RESULTS.disputed).toHaveProperty('challenge.claim');
    expect(RECEIPT_CHECKS).toEqual(expect.arrayContaining(['signature_valid', 'on_chain_hash_matches']));
    expect(receipt).toContain('The signature is Ed25519 over the canonical JSON of the receipt. The sha256 of the canonical JSON of `{ receipt, signature }` is the `result_receipt_hash` in the Submitted escrow datum.');
    expect(receipt).toContain('It does not commit to the stock reading being true, to the quantity being right, or to the order being fulfilled.');
  });

  test('Claim statements: the table is the claim of the kit and the manifest, and a claim has no reference to a claim', () => {
    const claim = section('Claim statements');
    expect(claim.split('\n').filter((line) => /^\| S[123] \|/.test(line))).toStrictEqual(REORDER_CLAIM.statements.map((statement) => `| ${statement.id} | ${statement.text} |`));
    expect(REORDER_CLAIM.statements.map((statement) => statement.id)).toStrictEqual(['S1', 'S2', 'S3']);
    expect(manifest.behaviour.claim).toStrictEqual(REORDER_CLAIM);
    expect(Object.keys(manifest.behaviour.claim)).toStrictEqual(['statements']);
    expect(claim).toContain('The agent stakes a claim for each run, not a standing claim. A claim has these three statements. The manifest holds them in `behaviour.claim`, with no reference to a claim. A challenge names the text of a statement.');
  });

  test('the fault switch: none, the service refuses a value, and every result has the member fault_mode, empty', () => {
    const fault = section('Fault switch');
    expect(fault).toContain('\nNone. `FAULT_MODE` must be empty.\n');
    expect(FAULT_MODES['reorder-agent']).toStrictEqual([]);
    expect(manifest.behaviour.fault_modes).toStrictEqual([]);
    expect(FAULT.mode).toBe('');
    expect(() => readFaultSwitch('reorder-agent', 'confirm_wrong_lot')).toThrow();
    expect(fault).toContain('The service stops at start when `FAULT_MODE` has a value. Every result has the member `fault_mode`, and it is the empty text. The manifest lists no fault value in `behaviour.fault_modes`.');
    expect(PROPOSED.fault_mode).toBe('');
    for (const result of Object.values(RESULTS)) expect(withFaultMode(FAULT, result).fault_mode).toBe('');
  });
});

describe('specs/reorder-agent.md, the operator, the gaps, the hire and the links', () => {
  test('Operator and data handling: the operator, the data sentences of the manifest, the five third parties, and what each decision and the handoff carry', () => {
    const operator = section('Operator and data handling');
    expect(manifest.operator.name).toBe('Apex Fusion Foundation');
    expect(operator).toContain('Operator: Apex Fusion Foundation. The contact is `operator.contact` in the manifest.');
    expect(operator).toContain(manifest.behaviour.data_handling);
    const parties = firstCells(operator, '| Party | What it receives |');
    expect(parties).toStrictEqual(manifest.behaviour.third_parties);
    expect(parties).toHaveLength(5);
    // A decision carries the SKU and five numbers of the stock reading, the three lot sizes and the date, or the SKU, the lot and the quantity of each side.
    const input = reorderInput(READING, { 'lot-small': 10, 'lot-medium': 50, 'lot-large': 200 }, '2026-11-30') as { stock_reading: Record<string, unknown> };
    expect(Object.keys(input.stock_reading)).toStrictEqual(['sku', 'on_hand', 'threshold', 'daily_usage', 'lead_time_days', 'open_orders']);
    expect(operator).toContain('The data of `reorder` is the SKU and five numbers of the stock reading, the three lot sizes and the date of today. The data of `accept_delivery` is the SKU, the lot and the quantity of the order and of the confirmation.');
    // The handoff to the Order Desk.
    const handoff = must(handoffOf({ use_case: 'inventory-reorder', agent_did: didOf('the Reorder Agent'), request: must(parseRequest(EXECUTE_REQUEST)) as ExecuteRequest }));
    expect(Object.keys(handoff)).toStrictEqual(['schema', 'use_case', 'sender_did', 'delegation', 'document', 'salt', 'approval']);
    expect(operator).toContain('The handoff holds the purchase order, the salt, the approval reference, the DID of this agent and the identifier of the delegation.');
    // The one file that the start fetches, and the services that the service calls.
    for (const name of ['VECTOR_MODULE1_MANIFEST', 'VECTOR_OGMIOS_URL', 'VECTOR_KOIOS_URL', 'VECTOR_SUBMIT_URL', 'VECTOR_MARKETPLACE_INDEXER_URL', 'IDENTITY_GATEWAY_URL']) expect(SETTINGS).toContain(name);
    expect(() => module1SourceOf({ VECTOR_MODULE1_MANIFEST: 'https://example.test/vector-agent-modules/main/manifest.json' })).toThrow('must be pinned to a commit');
    expect(module1SourceOf({ VECTOR_MODULE1_MANIFEST: `https://example.test/vector-agent-modules/${'ab'.repeat(20)}/manifest.json` })).toContain('ab'.repeat(20));
    expect(operator).toContain('At start the service fetches one file: the Module-1 deployment manifest, at an https address that a commit pins.');
    expect(operator).toContain('the node (Ogmios) and the Koios indexer');
  });

  test('Known gaps: the eight sentences of the manifest, word for word and in order, with the sentence about the keys and the lead of what no run shows', () => {
    const gaps = section('Known gaps');
    const lines = gaps.split('\n').filter((line) => line.startsWith('- '));
    expect(lines).toStrictEqual(gapsFor().map((gap) => `- ${gap}`));
    expect(manifest.gaps).toStrictEqual([...gapsFor()]);
    expect(lines).toHaveLength(8);
    expect(gaps).toContain('The manifest states these eight, in this order, word for word. A test keeps them equal to `gapsFor` in `agents/reorder-agent/src/serve/gaps.ts`.');
    expect(gaps).toContain('The Reorder Agent has no fault value, so the list has no sentence about a fault switch.');
    // The seventh says that one operator holds the keys of the parties on one host. The eighth is the lead of what no run shows, with its three things.
    expect(lines[6]).toBe(`- ${KEYS_GAP}`);
    expect(KEYS_GAP).toBe('The controller key, the Accountable key and the guardian keys of this deployment are held on one host by one operator, so a party is independent of the controller by key only.');
    expect(lines[7]).toBe(`- ${NOT_SHOWN_GAP}`);
    expect(NOT_SHOWN_GAP.startsWith('What this does not show: ')).toBe(true);
    for (const part of ['the refund of the escrow of a revoked agent', 'the reclaim of an escrow by its buyer', 'a relying party that refuses a live token after its authority ended', 'tests alone cover the last']) {
      expect(NOT_SHOWN_GAP, part).toContain(part);
    }
    expect(gaps).toContain('The seventh sentence says whose keys the parties are. The eighth starts with the lead `What this does not show:` and names three things that no run of use case 1 (inventory reorder) covers.');
    // The third gap says when a delivery that the agent refuses can still be released: the window of the Accept.
    expect(CHALLENGE_GAP).toContain(`released to the supplier ${ACCEPT_WINDOW_MS / 1000} s after its Submit`);
  });

  test('How to hire it: six steps, the tools of the hosted server, the actions and the resources of the delegation, and the codes and the limits that the steps name', () => {
    const how = section('How to hire it');
    const hosted = text('scripts/specs.test.mjs');
    const tools = [...how.matchAll(/`(vector_[a-z_]+)`/g)].map((hit) => hit[1]);
    expect(tools).toStrictEqual(['vector_build_delegation_delegate', 'vector_delegation_request_cosign', 'vector_build_vault_open', 'vector_build_attestation_attest', 'vector_build_vault_close', 'vector_build_delegation_undelegate']);
    for (const tool of tools) expect(hosted.includes(`'${tool}'`), tool).toBe(true);
    expect(how.split('\n').filter((line) => /^\d\. \*\*/.test(line))).toHaveLength(6);
    // The actions of the delegation, and the resource of each mock route.
    const bases = { publicBase: 'https://mock.example', mtlsBase: 'https://mtls.example' };
    const stock = must(tokenTarget(bases, TENANT, 'erp.stock', { sku: READING.sku }));
    const write = must(tokenTarget(bases, TENANT, 'po.write'));
    expect([HIRE_ACTION, stock.action, write.action]).toStrictEqual(['marketplace.hire.v1', 'erp.stock.read', 'po.write']);
    expect([stock.resource, write.resource]).toStrictEqual([`${bases.publicBase}/t/${TENANT}/erp`, `${bases.publicBase}/t/${TENANT}/po`]);
    expect(how).toContain('The actions are `marketplace.hire.v1`, `erp.stock.read` and `po.write`.');
    expect(how).toContain('`<mock base>/t/<tenant>/erp` and `<mock base>/t/<tenant>/po`');
    expect(manifest.keys.delegation_pkhs).toHaveLength(2);
    expect(how).toContain('a free one of its two delegation keys, which `keys.delegation_pkhs` of the manifest lists');
    // The codes that the steps name are the codes of the jobs and of the co-sign route.
    expect(PROPOSE_FAILURES).toEqual(expect.arrayContaining(['sub_delegation_parent_exhausted', 'sub_delegation_parent_not_live']));
    expect([COSIGN_STATUS.principal_not_allowed, COSIGN_STATUS.key_in_use]).toStrictEqual([403, 409]);
    expect(COUNTERPARTY_REFUSALS['order-desk']).toContain('approval_wrong_issuer');
    for (const code of ['sub_delegation_parent_exhausted', 'sub_delegation_parent_not_live', 'principal_not_allowed', 'key_in_use', 'no_live_vault', 'several_live_vaults', 'approval_wrong_issuer']) {
      expect(how, code).toContain(`\`${code}\``);
    }
    // The approval: the type, the times and the deposit of the kit.
    expect([APPROVAL_ATT_TYPE, APPROVAL_VALIDITY_DEFAULT_MS / 3_600_000, APPROVAL_VALIDITY_MAX_MS / 3_600_000, APPROVAL_DEPOSIT_LOVELACE]).toStrictEqual([5, 4, 24, 5_000_000n]);
    expect(text('packages/usecase-kit/src/protocol/approval.ts')).toContain('It returns 90 days after the attestation ends.');
    expect(how).toContain('the type is 5, the subject is this agent, and the digest is the `proposal_digest`');
    expect(how).toContain('The approval is valid for 4 hours unless you choose another time, and for 24 hours at most. The attestation holds a deposit of 5000000 lovelace, and the deposit returns 90 days after the attestation ends.');
    expect(how).toContain('The agent has no advert yet, so nobody can hire it today.');
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
    expect(manifest.links.spec.endsWith('/specs/reorder-agent.md')).toBe(true);
    expect(manifest.links.source.endsWith('/agents/reorder-agent')).toBe(true);
    expect(links).toContain('[agents/reorder-agent/agent.json.template](../agents/reorder-agent/agent.json.template)');
    expect(links).toContain('[docs/HIRE.md](../docs/HIRE.md)');
  });
});
