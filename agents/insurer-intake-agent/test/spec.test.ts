// agents/insurer-intake-agent/test/spec.test.ts
// specs/insurer-intake-agent.md is the public page of the Insurer Intake Agent, and the manifest links to its Response heading. These tests hold the page to the code, to the manifest and to the deploy pack, table by
// table, so that they cannot part: the opening line, the status line and the changelog; the identity rows; the terms, the times and the limits; the 15 checks of the hook with their refusal codes; the steps of the job;
// the report of the attestations; the intake record; the errors; the claim; the gaps word for word; what the model receives; and the links. No test here uses the network.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { ACCEPT_WINDOW_MS, ATT_TYPES } from '@vsa/buyer-core';
import { STRANDED_FILE } from '@vsa/hire-kit';
import { BUSY_TEXT, CONTEXT_HEADERS, HEARTBEAT_MS, JobSlot, MAX_BODY, RESERVATION_MS, STOPPING_TEXT, operatorsText, parseWire } from '@vsa/service-kit';
import { systemClock } from '@vsa/usecase-kit/access';
import { CheckUnavailableError, SHARED_CHECK_NAMES } from '@vsa/usecase-kit/checks';
import { INPUT_OPEN, buildPrompt } from '@vsa/usecase-kit/decision';
import { EVIDENCE_STATEMENTS, evidenceDocument } from '@vsa/usecase-kit/dispute';
import { faultGap } from '@vsa/usecase-kit/manifest';
import {
  ATTESTATION_STATES, INTAKE_CHECKS, INTAKE_CLAIM, INTAKE_RECORD_SCHEMA, INTAKE_STATUSES, PRIORAUTH_CAPABILITIES, PRIORAUTH_CLAIM, PRIORAUTH_MODELS, PRIORAUTH_REQUEST_SCHEMA, parseIntakeRecord, parsePriorAuthRequest,
  parseRequirementSet,
} from '@vsa/usecase-kit/priorauth';
import {
  COUNTERPARTY_REFUSALS, ERROR_STATUS, FAULT_MODES, HANDOFF_SCHEMA, MAX_REQUEST_BYTES, NO_OPEN_CLAIM, RUNTIME_BODY_LIMIT_BYTES, accepted, canonicalJson, parseHandoff, proposalDigest,
} from '@vsa/usecase-kit/protocol';
import type { ProtocolResult } from '@vsa/usecase-kit/protocol';
import { blake2b224Hex } from '@vsa/vector-read';
import { CLAIM_STAKE_LOVELACE, CLAIM_WINDOW_MS } from '../../../scripts/operator/lib/claim-constants.ts';
import { intakeChecks } from '../src/checks/index.ts';
import { COMPLETENESS_NAME, INTAKE_REFUSAL_STATUS, RUNTIME_MARGIN_MS, completenessDecision, completenessInput } from '../src/job/index.ts';
import { READ_BUDGET_MS, REPORT_BUDGET_MS, reportAttestations } from '../src/report/index.ts';
import type { ReportDeps, ReportExpectation } from '../src/report/index.ts';
import { BINDING_GAP, KEYS_GAP, NOT_SHOWN_GAP, gapsFor } from '../src/serve/gaps.ts';
import { KEY_ROLES, keyClashOf } from '../src/serve/keys.ts';
import { STATUS_SINCE_DEFAULT, TEMPLATE_ENV, manifestFromEnv } from '../src/serve/manifest.ts';
import { RequestRefusal, parseIntakeRequest } from '../src/serve/server.ts';
import {
  BUYER_BOND_LOVELACE, CALL_TIMEOUT_MS, CHECKS_READ_BUDGET_DEFAULT_MS, CHECKS_READ_BUDGET_MAX_MS, CHECKS_READ_BUDGET_MIN_MS, HOOK_READS, HOOK_READS_LIMIT_MS, JOB_DEADLINE_MS, MIN_PROCESSING_WINDOW_MS,
  PORT_DEFAULT, PRICE_DEFAULT_LOVELACE, RUNTIME_PRECHECK_WAIT_MS, STATE_DIR_DEFAULT, SUPPLIER_BOND_LOVELACE, checksReadBudgetOf, faultOf, module1SourceOf, priceOf, supplierKeyOf,
} from '../src/serve/settings.ts';
import { JANITOR_INTERVAL_MS, SETTINGS } from '../src/serve/start.ts';
import { INTAKE_BOOK_LIMIT, MemoryIntakeBook, PASSED_CHECKS_TTL_MS } from '../src/store/index.ts';
import { makeRig, refusalOf } from './job/rig.ts';
import type { Rig } from './job/rig.ts';
import {
  ATTESTATION_ID, BASES, DELEGATION_ID, ESCROW_REF, INSURER_DID, ISSUER_DID, PRIOR_REQUEST, PRIOR_REQUEST_SHA256, REQUIREMENTS, SALT, SENDER_DID, decisionOf, handoffOf, hashOf, priorRequest, recordFor,
} from './job/samples.ts';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const page = readFileSync(new URL('../../../specs/insurer-intake-agent.md', import.meta.url), 'utf8');
const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
const section = (heading: string): string => (page.split(`\n## ${heading}\n`)[1] ?? '').split('\n## ')[0];
/** The part of the page that starts at the heading `### heading` and ends at the next heading. */
const sub = (heading: string): string => (page.split(`\n### ${heading}\n`)[1] ?? '').split(/\n##+ /)[0];
/** The first row of a table whose first cell is `label`, or the empty text. */
const row = (text: string, label: string): string => text.split('\n').find((line) => line.startsWith(`| ${label} |`)) ?? '';
const printed = (lovelace: number): string => (lovelace / 1_000_000).toFixed(6);
const manifest = manifestFromEnv(TEMPLATE_ENV);

/** The day of the page. The status line of the page holds it, and it is the default date of the status in the manifest. */
const PAGE_DATE = '2026-11-24';
const STATUS_LINE = `PROPOSED (built, not deployed). Since ${PAGE_DATE}.`;

/** The compose file of the pack: one runtime in front of one service. */
interface ComposeService {
  readonly environment?: Readonly<Record<string, string>>;
}
const compose = parseYaml(readFileSync(`${root}deploy/server/docker-compose.insurer-intake-agent.yml`, 'utf8')) as { readonly services: Readonly<Record<string, ComposeService>> };
const envExample = readFileSync(`${root}deploy/server/.env.insurer-intake-agent.example`, 'utf8');
const runbook = readFileSync(`${root}deploy/server/RUNBOOK-insurer-intake-agent.md`, 'utf8');
const runtimeEnv = compose.services.runtime.environment ?? {};
const serviceEnv = compose.services.service.environment ?? {};

/** The value of a result that the kit gave, or the error that says why there is none. */
function must<T, C extends string>(result: ProtocolResult<T, C>): T {
  if (!result.ok) throw new Error(result.detail);
  return result.value;
}
/** The rows of the table whose header line is `header`, each as its cells. The header and its rule line are not in the result. */
function tableRows(text: string, header: string): string[][] {
  const lines = text.split('\n');
  const start = lines.indexOf(header);
  if (start < 0) return [];
  const rows: string[][] = [];
  for (const line of lines.slice(start + 2)) {
    if (!line.startsWith('| ')) break;
    rows.push(line.slice(2, -2).split(' | '));
  }
  return rows;
}
const golden = (name: string): string => readFileSync(new URL(`./job/golden/${name}`, import.meta.url), 'utf8');
const posts = (rig: Rig) => rig.portal.calls.filter((call) => call.method === 'POST');
/** The first `count` identifiers of the form C1, C2 and so on. */
const ids = (count: number): string[] => Array.from({ length: count }, (_, at) => `C${at + 1}`);
/** The JSON block that stands first in a part of the page. */
const jsonBlock = (text: string): string => /```json\n([\s\S]*?)\n```/.exec(text)?.[1] ?? '';

describe('specs/insurer-intake-agent.md: the frame, the identity and the capability', () => {
  test("the opening line, the capability, the model string and the status line are the manifest's and the pack's, and the page says that the agent has no record", () => {
    expect(manifest.name).toBe('Insurer Intake Agent');
    expect(page.split('\n')[0]).toBe(`# ${manifest.name}`);
    expect(page.split('\n')[2]).toBe(`Capability \`${manifest.capability_id}\`. ${manifest.description}`);
    expect(manifest.capability_id).toBe(PRIORAUTH_CAPABILITIES.intake);
    expect(section('Capability id').split('\n')[1]).toBe(`\`${manifest.capability_id}\``);
    expect(PRIORAUTH_MODELS.intake).toBe('insurer-intake-agent-v1');
    expect(section('Capability id')).toContain(`The model string in the advert and in every receipt is \`${PRIORAUTH_MODELS.intake}\`.`);
    expect(row(runbook, 'Insurer Intake')).toContain(`| \`${PRIORAUTH_MODELS.intake}\` |`);
    // One constant pins the date of the page and the default date of the manifest. The example environment keeps the default date and the word of the manifest.
    expect(STATUS_SINCE_DEFAULT).toBe(PAGE_DATE);
    expect(manifest.status).toStrictEqual({ chip: 'proposed', since: PAGE_DATE });
    expect(STATUS_LINE).toBe(`${manifest.status.chip.toUpperCase()} (built, not deployed). Since ${manifest.status.since}.`);
    expect(envExample.split('\n')).toContain('AGENT_STATUS_CHIP=proposed');
    expect(envExample.split('\n')).toContain('AGENT_STATUS_SINCE=');
    const status = section('Status');
    expect(status.split('\n')).toContain(STATUS_LINE);
    expect(status).toContain('\nNothing on this page is LIVE or DEPLOYED.\n');
    expect(status).toContain('The agent has no registry record, no advert and no job yet.');
    expect(status).toContain('It is the insurer side of use case 2 (prior authorization). Its counterparty is the [Prior Authorization Agent](prior-authorization-agent.md).');
    expect(section('Identity')).toContain('\nThis agent has no registry record yet.\n');
  });

  test('the Identity rows say what the manifest and the settings say of the keys: one supplier key that only the runtime holds, one service key, no delegation key and no subagent', () => {
    const identity = section('Identity');
    expect(identity).toContain('The table gives the design of the record. A value that the registration fixes reads "assigned at registration".');
    expect(row(identity, 'DID')).toBe('| DID | assigned at registration. The service reads it from `AGENT_DID`, and the manifest gives it as `identity.did` |');
    expect(SETTINGS).toContain('AGENT_DID');
    expect(Object.keys(manifest.identity)).toContain('did');
    expect(row(identity, 'Controller')).toBe('| Controller | a controller key of this deployment. The Known gaps section says who holds the keys of the parties |');
    // The service holds one private key, the service key. It holds the key hash and the public key of the supplier key, and the manifest publishes both with the key hash of the service key.
    expect(SETTINGS.filter((name) => name.endsWith('_PRIV_KEY_HEX'))).toStrictEqual(['INTAKE_SERVICE_PRIV_KEY_HEX']);
    expect(KEY_ROLES).toStrictEqual(['service']);
    expect(Object.keys(manifest.keys)).toStrictEqual(['supplier_pkh', 'pub_key_hex', 'buyer_pkh']);
    expect(manifest.identity.supplier_key).toBe('<AGENT_DID>#<SUPPLIER_PKH>');
    // The compose file blanks the service key for the runtime and the supplier key for the service, so that neither container holds the key of the other.
    expect(runtimeEnv.INTAKE_SERVICE_PRIV_KEY_HEX).toBe('');
    expect(serviceEnv.SUPPLIER_PRIV_KEY_HEX).toBe('');
    // The public key must hash to the key hash, and the service key must not be the supplier key.
    const publicKey = 'cd'.repeat(32);
    expect(supplierKeyOf({ SUPPLIER_PKH: blake2b224Hex(publicKey), SUPPLIER_PUB_KEY_HEX: publicKey })).toStrictEqual({ pkh: blake2b224Hex(publicKey), pubKeyHex: publicKey });
    expect(() => supplierKeyOf({ SUPPLIER_PKH: 'ab'.repeat(28), SUPPLIER_PUB_KEY_HEX: publicKey })).toThrow(/SUPPLIER_PUB_KEY_HEX/);
    expect(keyClashOf({ service: { pkh: 'ab'.repeat(28) } }, 'ab'.repeat(28))).toStrictEqual({ kind: 'supplier', role: 'service' });
    expect(keyClashOf({ service: { pkh: 'cd'.repeat(28) } }, 'ab'.repeat(28))).toBeNull();
    const supplier = row(identity, 'Supplier key');
    expect(supplier).toContain('the key of the runtime, listed in the record for the authentication and transaction purposes.');
    expect(supplier).toContain('The runtime signs its receipts, and the Claim and Submit transactions of its escrows, with it. The service never holds it.');
    expect(supplier).toContain('The service holds its key hash and its public key, and the manifest publishes them as `keys.supplier_pkh` and `keys.pub_key_hex`.');
    expect(supplier).toContain('`identity.supplier_key` names it as a key of the DID (`<DID>#<key hash>`).');
    expect(supplier).toContain('The service does not start unless the public key hashes to the key hash');
    const service = row(identity, 'Service key');
    expect(service).toContain('a key of its own, listed in the record for the authentication and transaction purposes. The service holds it and the runtime does not.');
    expect(service).toContain('It pays for the model hire of the decision, signs the transactions of the challenges that the service files, and signs the request for the JWT-SVID.');
    expect(service).toContain('The manifest publishes its key hash as `keys.buyer_pkh`.');
    expect(service).toContain('The service does not start when this key is the supplier key');
    // No delegation key, no co-sign route and no subagent: no setting, no manifest member and no route names one.
    expect(row(identity, 'Delegation keys')).toBe('| Delegation keys | none. The manifest lists no delegation key, and the service has no co-sign route |');
    expect(SETTINGS.filter((name) => /DELEGATION|COSIGN/.test(name))).toStrictEqual([]);
    expect(Object.keys(manifest.keys)).not.toContain('delegation_pkhs');
    expect('cosign' in manifest.behaviour).toBe(false);
    expect(row(identity, 'Subagents')).toBe('| Subagents | none. The record names no subagent, and no setting names one |');
    expect(SETTINGS.filter((name) => name.endsWith('_DID'))).toStrictEqual(['AGENT_DID']);
    expect(Object.keys(manifest)).not.toContain('subagents');
    expect(row(identity, 'Parties')).toBe('| Parties | Accountable: the Accountable key of the organisation, with its domain. Responsible: Module-1. Provider: the Provider key. Guardians: the guardian key of the organisation and a controller key of this deployment, with threshold 2 |');
    expect(row(identity, 'Organisation')).toBe('| Organisation | the domain `delta.vector.apexfusion.org`, with the description "Demonstration organisation run by the Apex Fusion Foundation". The identity gateway verifies the domain with a DNS TXT record |');
    expect(row(identity, 'Reputation stake')).toBe('| Reputation stake | a Module-3 self-stake on the capability, owned by the service key |');
    // The claim: the numbers are the constants of the operator pack. The service stakes none.
    expect(CLAIM_STAKE_LOVELACE).toBe(50_000_000n);
    expect(CLAIM_WINDOW_MS).toBe(86_400_000);
    expect(row(identity, 'Claim')).toBe(
      `| Claim | a Module-1 claim for each run. The service stakes none. Before a run, an operator command stakes the claim with the service key: ${CLAIM_STAKE_LOVELACE / 1_000_000n} units, which is ${CLAIM_STAKE_LOVELACE} lovelace, with a challenge window of ${CLAIM_WINDOW_MS / 3_600_000} hours. The command withdraws it after the window, when nobody challenged it. See Claim statements |`,
    );
    // The public URL is the origin of the runtime in the compose file.
    const origin = String(runtimeEnv.PUBLIC_ORIGIN);
    expect(origin.startsWith('https://')).toBe(true);
    expect(row(identity, 'Public URL')).toBe(`| Public URL | planned: \`${origin}\`, the origin of the runtime in the pack. The agent has no advert yet |`);
  });

  test('the Capability id section describes one runtime in front of one service, and the pack runs those two containers', () => {
    const capability = section('Capability id');
    expect(Object.keys(compose.services)).toStrictEqual(['runtime', 'service']);
    expect(runtimeEnv.CAPABILITY_KIND).toBe('custom');
    expect(serviceEnv.PORT).toBe(String(PORT_DEFAULT));
    expect(runtimeEnv.SERVICE_URL).toBe(`http://intake-service:${PORT_DEFAULT}/`);
    expect(runtimeEnv.SERVICE_PRECHECK_URL).toBe(`${runtimeEnv.SERVICE_URL}precheck`);
    expect(capability).toContain('The agent is one runtime in front of one service. The runtime is the template runtime (`vector-agent-template`, `CAPABILITY_KIND=custom`).');
    expect(capability).toContain('It holds the supplier key and has the advert. It asks the service before it claims an escrow, claims the escrow, posts the job to the service, signs the receipt and submits the receipt hash.');
    expect(capability).toContain('The service does the work. It holds the service key and no private supplier key. It runs one job at a time.');
    expect(readme).toContain('One job runs at a time.');
  });
});

describe('specs/insurer-intake-agent.md: the Terms', () => {
  const terms = section('Terms');
  const { price_lovelace: price, supplier_bond_lovelace: supplier, buyer_bond_lovelace: buyer } = manifest.terms;
  const lock = price + supplier + buyer;

  test('one group of price, supplier bond and buyer bond, from the manifest, the constants and the example environment, and a lock of 4 units', () => {
    // The three rows that the rule of the page profile counts, as they stand on the page.
    const shown = [...terms.matchAll(/^\| (Price|Supplier bond|Buyer bond) \| (\d+) \| (\d+\.\d{6}) \|$/gm)].map((hit) => hit[0]);
    expect(shown).toHaveLength(3);
    expect(shown).toStrictEqual([['Price', price], ['Supplier bond', supplier], ['Buyer bond', buyer]].map(([label, lovelace]) => `| ${label} | ${lovelace} | ${printed(Number(lovelace))} |`));
    expect([price, supplier, buyer]).toStrictEqual([PRICE_DEFAULT_LOVELACE, SUPPLIER_BOND_LOVELACE, BUYER_BOND_LOVELACE]);
    expect([price, supplier, buyer]).toStrictEqual([2_000_000, 1_000_000, 1_000_000]);
    expect(row(terms, 'Locked by the buyer (price and both bonds)')).toBe(`| Locked by the buyer (price and both bonds) | ${lock} | ${printed(lock)} |`);
    expect(lock).toBe(4_000_000);
    expect(terms).toContain('Amounts are `lovelace` fields. The last column is the same amount divided by 1,000,000, with six decimals. The Insurer Intake Agent has one advert, so its terms have one group.');
    // The price is the setting ADVERT_PRICE_LOVELACE with the default of the table, and the two bonds are constants.
    expect(envExample.split('\n')).toContain(`ADVERT_PRICE_LOVELACE=${PRICE_DEFAULT_LOVELACE}`);
    expect(priceOf({})).toBe(PRICE_DEFAULT_LOVELACE);
    expect(priceOf({ ADVERT_PRICE_LOVELACE: '3000000' })).toBe(3_000_000);
    expect(terms).toContain('The price is the default of the setting `ADVERT_PRICE_LOVELACE`. The two bonds are fixed in the code.');
    // The runbook of the pack holds the same terms in units.
    expect(row(runbook, 'Insurer Intake')).toContain(`| ${price / 1_000_000} | ${supplier / 1_000_000} and ${buyer / 1_000_000} | ${lock / 1_000_000} |`);
  });

  test('the window, the timeout of the runtime and the deadline of a job are the constants, the manifest, the example environment and the compose file', () => {
    const timeout = JOB_DEADLINE_MS + 60_000;
    expect(manifest.terms.max_processing_ms).toBe(MIN_PROCESSING_WINDOW_MS);
    expect(envExample.split('\n')).toContain(`ADVERT_MAX_PROCESSING_MS=${MIN_PROCESSING_WINDOW_MS}`);
    expect(runtimeEnv.ADVERT_MAX_PROCESSING_MS).toBe(String(MIN_PROCESSING_WINDOW_MS));
    expect(runtimeEnv.SERVICE_TIMEOUT_MS).toBe(String(timeout));
    expect([MIN_PROCESSING_WINDOW_MS, timeout, JOB_DEADLINE_MS]).toStrictEqual([480_000, 360_000, 300_000]);
    expect(row(terms, 'Processing window, advert `max_processing_ms`')).toBe(`| Processing window, advert \`max_processing_ms\` | ${MIN_PROCESSING_WINDOW_MS} ms |`);
    expect(row(terms, 'Service timeout, `SERVICE_TIMEOUT_MS` of the runtime')).toBe(`| Service timeout, \`SERVICE_TIMEOUT_MS\` of the runtime | ${timeout} ms |`);
    expect(row(terms, 'Job deadline, set by the service when a request arrives')).toBe(`| Job deadline, set by the service when a request arrives | ${JOB_DEADLINE_MS} ms |`);
  });

  test('the other limits: the one model call, one job at a time, the reservation, the budget of a read of the hook and the budget of the report', () => {
    expect(COMPLETENESS_NAME).toBe('completeness');
    expect(row(terms, 'Model calls')).toBe('| Model calls | one for each job: the decision `completeness` |');
    expect(row(terms, 'Jobs at a time')).toBe('| Jobs at a time | one: a second job gets 409 `busy` |');
    expect(ERROR_STATUS.busy).toBe(409);
    expect(row(terms, 'Reservation')).toBe(`| Reservation | a go from \`POST /precheck\` reserves the job slot for ${RESERVATION_MS / 1000} s |`);
    // The budget of one read of the hook: six timed reads of the widest budget end before the runtime stops waiting for the hook.
    expect(envExample.split('\n')).toContain(`CHECKS_READ_BUDGET_MS=${CHECKS_READ_BUDGET_DEFAULT_MS}`);
    expect(checksReadBudgetOf({})).toBe(CHECKS_READ_BUDGET_DEFAULT_MS);
    expect(checksReadBudgetOf({ CHECKS_READ_BUDGET_MS: String(CHECKS_READ_BUDGET_MIN_MS) })).toBe(CHECKS_READ_BUDGET_MIN_MS);
    expect(checksReadBudgetOf({ CHECKS_READ_BUDGET_MS: String(CHECKS_READ_BUDGET_MAX_MS) })).toBe(CHECKS_READ_BUDGET_MAX_MS);
    expect(() => checksReadBudgetOf({ CHECKS_READ_BUDGET_MS: String(CHECKS_READ_BUDGET_MIN_MS - 1) })).toThrow(/CHECKS_READ_BUDGET_MS/);
    expect(() => checksReadBudgetOf({ CHECKS_READ_BUDGET_MS: String(CHECKS_READ_BUDGET_MAX_MS + 1) })).toThrow(/CHECKS_READ_BUDGET_MS/);
    expect([CHECKS_READ_BUDGET_DEFAULT_MS, CHECKS_READ_BUDGET_MIN_MS, CHECKS_READ_BUDGET_MAX_MS, HOOK_READS, HOOK_READS_LIMIT_MS]).toStrictEqual([1200, 500, 1499, 6, 9000]);
    expect(CHECKS_READ_BUDGET_MAX_MS * HOOK_READS).toBeLessThan(HOOK_READS_LIMIT_MS);
    expect(HOOK_READS_LIMIT_MS).toBeLessThan(RUNTIME_PRECHECK_WAIT_MS);
    expect(row(terms, 'Budget of one read of the hook, `CHECKS_READ_BUDGET_MS`')).toBe(
      `| Budget of one read of the hook, \`CHECKS_READ_BUDGET_MS\` | ${CHECKS_READ_BUDGET_DEFAULT_MS} ms by default, from ${CHECKS_READ_BUDGET_MIN_MS} to ${CHECKS_READ_BUDGET_MAX_MS} ms. The hook makes ${HOOK_READS} timed reads, and ${HOOK_READS} reads of the widest budget stay under ${HOOK_READS_LIMIT_MS} ms |`,
    );
    // The report has its own budget: 45000 ms for the whole report and 15000 ms for one read.
    expect([REPORT_BUDGET_MS, READ_BUDGET_MS]).toStrictEqual([45_000, 15_000]);
    expect(row(terms, 'Report of the attestations')).toBe(`| Report of the attestations | at most ${REPORT_BUDGET_MS} ms for the whole report, and ${READ_BUDGET_MS} ms for one read |`);
  });

  test('the request limit is 900000 bytes of wire payload, and the page says that it is safe only below the limit of the runtime on the escaped body', () => {
    expect(manifest.terms.input_limits.request_bytes).toBe(MAX_REQUEST_BYTES);
    expect(row(terms, 'Request')).toBe(`| Request | at most ${MAX_REQUEST_BYTES} bytes of wire payload |`);
    expect(MAX_REQUEST_BYTES).toBeLessThan(MAX_BODY);
    expect(MAX_BODY).toBeLessThan(RUNTIME_BODY_LIMIT_BYTES);
    expect([MAX_REQUEST_BYTES, MAX_BODY, RUNTIME_BODY_LIMIT_BYTES]).toStrictEqual([900_000, 1_000_000, 1_048_576]);
    expect(ERROR_STATUS.request_too_large).toBe(400);
    expect(terms).toContain('**The request limit.** The limit on a request counts the wire payload: the request JSON written as a string inside a one-message array. The manifest publishes it in `terms.input_limits.request_bytes`.');
    expect(terms).toContain('The limit does not count the body of the call that a buyer makes to the runtime. The buyer puts the wire payload inside a second JSON object, and each quote mark and each backslash of the wire payload then gets one more byte.');
    expect(terms).toContain(`The runtime refuses a body above ${RUNTIME_BODY_LIMIT_BYTES} bytes (1 MiB).`);
    expect(terms).toContain(`So the limit of ${MAX_REQUEST_BYTES} bytes is safe only below the limit of the runtime, on the escaped body, and a buyer must keep the body of its call at or below ${RUNTIME_BODY_LIMIT_BYTES} bytes.`);
    expect(terms).toContain(`The service reads at most ${MAX_BODY} bytes of wire payload and refuses more with \`request_too_large\` (400).`);
  });

  test('the money: the lock, the payment from a vault, Accept, Release and Reclaim, and a request that is refused is not paid', () => {
    expect(terms).toContain(`**The money.** A hire of the advert locks its price and both bonds: ${lock / 1_000_000} units.`);
    expect(terms).toContain('The buyer pays the lock from a vault of its delegation, and the value limit of the delegation caps that payment.');
    expect(terms).toContain("On Accept the agent receives the price and the supplier bond, and the buyer's bond returns to the buyer.");
    // The runtime releases an escrow that the buyer did not accept, after the window of the Accept.
    expect(ACCEPT_WINDOW_MS).toBe(600_000);
    expect(runtimeEnv.RELEASE_WATCHER).toBe('1');
    expect(terms).toContain(`If the buyer does not accept within ${ACCEPT_WINDOW_MS / 1000} s of the Submit, the agent may Release the escrow and take the price and both bonds.`);
    expect(terms).toContain('If the agent never submits, the buyer reclaims after `deliver_by`. A request that the hook refuses, and a job that fails after the Claim, end that way: neither is paid.');
    expect(terms).toContain('The service pays for its one model call from the service key.');
  });
});

describe('specs/insurer-intake-agent.md: the routes and the request', () => {
  const interfaceText = section('Interface');
  const request = sub('Request');
  const rows = request.split('\n').filter((line) => /^\| `/.test(line));

  test('the Interface names the routes of the service and the token that two of them need, and the buyer reaches the service through the runtime only', () => {
    expect(manifest.interface.routes).toStrictEqual({ job: '/v1/job', status: '/status', capability: '/capability' });
    expect(interfaceText.split('\n').filter((line) => /^\| `(GET|POST) /.test(line))).toHaveLength(4);
    expect(row(interfaceText, '`POST /precheck`')).toBe(`| \`POST /precheck\` | the runtime, before the Claim | the hook: 200 \`{"go":true,"reserved_ms":${RESERVATION_MS}}\`, or a refusal with its code |`);
    expect(row(interfaceText, '`POST /`')).toBe('| `POST /` | the runtime, after the Claim | the job: the intake record, or an error |');
    expect(row(interfaceText, '`GET /agent.json`')).toBe('| `GET /agent.json` | anyone | the manifest |');
    expect(row(interfaceText, '`GET /healthz`')).toBe('| `GET /healthz` | anyone | `{"ok":true}` while the service runs |');
    expect(interfaceText).toContain('`POST /` and `POST /precheck` need the token that only the runtime holds. A call without it gets 401 `{"error":"unauthorized"}`, before the body is read.');
    expect(interfaceText).toContain('`GET /agent.json` and `GET /healthz` need no token. Any other route gets 404 `{"error":"not_found"}`. The service has no other route.');
    expect(interfaceText).toContain('A buyer sends its job to the runtime of the advert, on the runtime route `/v1/job` of the manifest, and never to the service.');
    expect(ERROR_STATUS.unauthorized).toBe(401);
    expect(readme).toContain('Without it, 401 `{"error":"unauthorized"}`');
    expect(readme).toContain('| any other route | 404 `{"error":"not_found"}` |');
    expect(readme).toContain('The service has no other route.');
  });

  test('the wire payload and the request JSON are the two names of the wire message that the service reads', () => {
    expect(interfaceText).toContain("The **request JSON** is what the buyer's agent writes: the handoff under Request below.");
    expect(interfaceText).toContain('The **wire payload** is the request JSON written as a string inside a one-message array: `[{"content": "<request JSON as a string>", "role": "user"}]`.');
    expect(interfaceText).toContain("The buyer's agent commits to the wire payload in the escrow, and the runtime posts it to the service as the body of `POST /` and of `POST /precheck`.");
    // The service reads exactly this array and gives back the request JSON as a string. It refuses any other body.
    expect(parseWire(JSON.stringify([{ content: 'request JSON', role: 'user' }]))).toBe('request JSON');
    expect(() => parseWire(JSON.stringify({ content: 'request JSON', role: 'user' }))).toThrow(/one-element message array/);
    expect(() => parseWire(JSON.stringify([{ content: 'request JSON', role: 'assistant' }]))).toThrow(/role must be/);
  });

  test('the example is the handoff of the sample of the job, and the service takes it', () => {
    const shown = jsonBlock(request);
    expect(shown).toBe(JSON.stringify(handoffOf(), null, 2));
    expect(parseIntakeRequest(shown)).toStrictEqual(handoffOf());
    expect(parseWire(JSON.stringify([{ content: shown, role: 'user' }]))).toBe(shown);
    expect(request).toContain('The request JSON is the handoff of use case 2 (prior authorization). It has exactly the members of the first table.');
    expect(request).toContain('Its `document` is an authorization request, which has exactly the members of the second table. The order of the members does not matter.');
    expect(request).toContain('A request that breaks a rule is refused with `bad_shape` (400), before any check.');
    expect(() => parseIntakeRequest('{}')).toThrow(RequestRefusal);
    expect(new RequestRefusal('bad_shape', 'x').status).toBe(400);
    expect(ERROR_STATUS.bad_shape).toBe(400);
  });

  test('the members of the handoff and of the authorization request are the members of the schema of the manifest and of the parsers of the kit, in their order, and the page states the rules of the parsers', () => {
    expect(rows).toHaveLength(21);
    const names = rows.map((line) => /^\| `([a-z0-9_]+)` \|/.exec(line)?.[1] ?? '');
    const { properties } = manifest.interface.request_schema;
    expect(names.slice(0, 7)).toStrictEqual(Object.keys(properties));
    expect(names.slice(7)).toStrictEqual(Object.keys(properties.document.properties));
    expect(names.slice(0, 7)).toStrictEqual(Object.keys(handoffOf()));
    expect(names.slice(7)).toStrictEqual(Object.keys(must(parsePriorAuthRequest(PRIOR_REQUEST))));
    expect(rows.slice(0, 7)).toStrictEqual([
      `| \`schema\` | \`${HANDOFF_SCHEMA}\` |`,
      '| `use_case` | `prior-authorization`. The Insurer Intake Agent takes the handoff of use case 2 (prior authorization) only |',
      '| `sender_did` | the DID of the agent of the care provider: `did:vector:` and 64 lower-case hex characters |',
      '| `delegation` | the identifier of the delegation that paid for the request: 64 lower-case hex characters |',
      '| `document` | the authorization request, with the members of the second table |',
      "| `salt` | 64 lower-case hex characters, which are 32 bytes. The digest that the provider's reviewer signed off is the SHA-256 of these 32 bytes followed by the canonical text of the authorization request |",
      '| `approval` | `{ "attestation": "<64 lower-case hex characters>", "issuer_did": "did:vector:<64 lower-case hex characters>" }`: the sign-off of the reviewer of the care provider for this exact authorization request. It can be `null`, and the hook then refuses with `approval_not_found` |',
    ]);
    expect(rows.slice(7)).toStrictEqual([
      `| \`schema\` | \`${PRIORAUTH_REQUEST_SCHEMA}\` |`,
      '| `request_number` | 1 to 64 characters: letters, digits, dots, hyphens and underscores, starting with a letter or a digit. It is the tenant, a hyphen and a counter. A number counts without regard to case |',
      '| `tenant` | 1 to 48 characters: lower-case letters, digits and hyphens, starting with a letter or a digit |',
      '| `order_id` | the identifier of the clinical order: 1 to 64 characters: letters, digits, dots, hyphens and underscores, starting with a letter or a digit |',
      '| `patient_ref` | a synthetic reference, with the form of `order_id`. No patient exists behind it |',
      '| `ordering_clinician_ref` | the reference of the ordering clinician, with the form of `order_id` |',
      '| `service_code` | the code of the service that the order asks for, with the form of `order_id` |',
      '| `diagnosis_codes` | 1 to 8 codes of 1 to 16 characters each, with no control, format or separator character |',
      '| `justification` | 1 to 4000 characters, with no control or hidden character but the line feed |',
      '| `guideline_refs` | 0 to 20 identifiers of the criteria that the justification cites, each with the form of `order_id`, none twice |',
      '| `record_refs` | 0 to 50 identifiers of the records that the justification cites, each with the form of `order_id`, none twice |',
      '| `record_set_sha256` | 64 lower-case hex characters: the digest of the record set that the request draws on |',
      '| `insurer_did` | the DID of the insurer: `did:vector:` and 64 lower-case hex characters. The check `for_this_insurer` needs the DID of this agent (`AGENT_DID`) here |',
      '| `advert_ref` | `<transaction hash>#<output index>`: 64 lower-case hex characters, `#`, and an index of at most 10 digits with no leading zero. The check `advert` needs the advert that the escrow was posted on here |',
    ]);
    // The rules of the handoff are the rules of its parser. The service takes the handoff of use case 2 only, the approval can be null, and the digest of the sign-off starts with the 32 bytes of the salt.
    expect(() => parseIntakeRequest(JSON.stringify({ ...handoffOf(), use_case: 'inventory-reorder' }))).toThrow(RequestRefusal);
    expect(parseHandoff(JSON.parse(JSON.stringify({ ...handoffOf(), approval: null }))).ok).toBe(true);
    for (const over of [{ sender_did: `did:vector:${'EC'.repeat(32)}` }, { delegation: '5E'.repeat(32) }, { salt: '9A'.repeat(32) }]) {
      expect(parseHandoff(JSON.parse(JSON.stringify({ ...handoffOf(), ...over }))).ok, Object.keys(over)[0]).toBe(false);
    }
    const canonical = canonicalJson(handoffOf().document);
    const digest = createHash('sha256').update(Buffer.from('9a'.repeat(32), 'hex')).update(canonical.ok ? canonical.value : '', 'utf8').digest('hex');
    expect(proposalDigest('9a'.repeat(32), handoffOf().document)).toStrictEqual({ ok: true, value: digest });
    // The rules of the authorization request are the rules of its parser.
    const accepts = (over: Record<string, unknown>): boolean => parsePriorAuthRequest({ ...PRIOR_REQUEST, ...over }).ok;
    expect([accepts({}), accepts({ schema: 'vector.usecase.po.v1' })]).toStrictEqual([true, false]);
    for (const member of ['request_number', 'order_id', 'patient_ref', 'ordering_clinician_ref', 'service_code']) {
      expect([accepts({ [member]: 'a'.repeat(64) }), accepts({ [member]: 'a'.repeat(65) }), accepts({ [member]: '.a' }), accepts({ [member]: 'a b' }), accepts({ [member]: 'A_b.c-d' })], member).toStrictEqual([true, false, false, false, true]);
    }
    expect([accepts({ tenant: 'a'.repeat(48) }), accepts({ tenant: 'a'.repeat(49) }), accepts({ tenant: 'Run1' })]).toStrictEqual([true, false, false]);
    expect([accepts({ diagnosis_codes: ['M54.16'] }), accepts({ diagnosis_codes: [] }), accepts({ diagnosis_codes: ids(8) }), accepts({ diagnosis_codes: ids(9) })]).toStrictEqual([true, false, true, false]);
    expect([accepts({ diagnosis_codes: ['a'.repeat(16)] }), accepts({ diagnosis_codes: ['a'.repeat(17)] }), accepts({ diagnosis_codes: ['M54\u200b'] }), accepts({ diagnosis_codes: ['M54\u2028'] })]).toStrictEqual([true, false, false, false]);
    expect([accepts({ justification: 'a'.repeat(4000) }), accepts({ justification: 'a'.repeat(4001) }), accepts({ justification: '' }), accepts({ justification: 'one\ntwo' })]).toStrictEqual([true, false, false, true]);
    expect([accepts({ justification: 'a\u0007b' }), accepts({ justification: 'a\u200bb' })]).toStrictEqual([false, false]);
    expect([accepts({ guideline_refs: [] }), accepts({ guideline_refs: ids(20) }), accepts({ guideline_refs: ids(21) }), accepts({ guideline_refs: ['C1', 'C1'] })]).toStrictEqual([true, true, false, false]);
    expect([accepts({ record_refs: [] }), accepts({ record_refs: ids(50) }), accepts({ record_refs: ids(51) }), accepts({ record_refs: ['R1', 'R1'] })]).toStrictEqual([true, true, false, false]);
    expect([accepts({ record_set_sha256: 'AB'.repeat(32) }), accepts({ insurer_did: `did:vector:${'A1'.repeat(32)}` })]).toStrictEqual([false, false]);
    const hash = 'd4'.repeat(32);
    expect([accepts({ advert_ref: `${hash}#0` }), accepts({ advert_ref: `${hash}#01` }), accepts({ advert_ref: `${hash}#1234567890` }), accepts({ advert_ref: `${hash}#12345678901` }), accepts({ advert_ref: `${'D4'.repeat(32)}#1` })]).toStrictEqual([true, false, true, false, false]);
    // The parser checks which members are there and never their order. A member that no rule lists is refused: the body never carries the escrow, the advert or the buyer key.
    expect(accepts({ extra: 1 })).toBe(false);
    expect(parsePriorAuthRequest(Object.fromEntries(Object.entries(PRIOR_REQUEST).reverse())).ok).toBe(true);
    expect(parseIntakeRequest(JSON.stringify(Object.fromEntries(Object.entries(handoffOf()).reverse())))).toStrictEqual(handoffOf());
    for (const member of ['buyer_pkh', 'escrow_ref', 'advert_model']) {
      expect(() => parseIntakeRequest(JSON.stringify({ ...handoffOf(), [member]: '0b'.repeat(28) })), member).toThrow(RequestRefusal);
    }
  });
});

describe('specs/insurer-intake-agent.md: what the hook checks before the Claim', () => {
  const hook = sub('What it checks before the Claim');
  const checks = hook.split('\n').filter((line) => /^\| \d+ \|/.test(line)).map((line) => line.slice(2, -2).split(' | '));
  /** The refusal codes of one row of the table, in the order of the row. */
  const codesOf = (cells: string[]): string[] => [...cells[2].matchAll(/`([a-z_]+)`/g)].map((hit) => hit[1]);

  test('the 15 checks are INTAKE_CHECKS in their order, with the 17 refusal codes of the kit in their order, each with its status', () => {
    expect(INTAKE_CHECKS).toHaveLength(15);
    expect(checks).toHaveLength(INTAKE_CHECKS.length);
    expect(checks.map((cells) => Number(cells[0]))).toStrictEqual(INTAKE_CHECKS.map((_, at) => at + 1));
    expect(checks.map((cells) => cells[1])).toStrictEqual(INTAKE_CHECKS.map((name) => `\`${name}\``));
    expect(COUNTERPARTY_REFUSALS['insurer-intake-agent']).toHaveLength(17);
    expect(checks.flatMap(codesOf)).toStrictEqual([...COUNTERPARTY_REFUSALS['insurer-intake-agent']]);
    // Every code of a row has the status of that row, and the status is the one of the protocol.
    for (const cells of checks) for (const code of codesOf(cells)) expect(cells[3], code).toBe(String(ERROR_STATUS[code as keyof typeof ERROR_STATUS]));
    expect(checks.every((cells) => cells[3] === '403')).toBe(true);
    // The first 12 checks are the shared checks of the kit, and the last three are the checks of this agent, in the words of its README.
    expect(INTAKE_CHECKS.slice(0, 12)).toStrictEqual([...SHARED_CHECK_NAMES['insurer-intake-agent']]);
    expect(INTAKE_CHECKS.slice(12)).toStrictEqual(['for_this_insurer', 'advert', 'not_duplicate']);
    const own = readme.split('\n').filter((line) => /^\| `(for_this_insurer|advert|not_duplicate)` \|/.test(line)).map((line) => line.slice(2, -2).split(' | '));
    expect(own).toHaveLength(3);
    expect(checks.slice(-3).map((cells) => [cells[1], cells[2], cells[4]])).toStrictEqual(own);
    // The rules of the checks approval_issuer and approval_valid, as the check of the approval gives them.
    const approvalSource = readFileSync(new URL('../../../packages/usecase-kit/src/checks/approval.ts', import.meta.url), 'utf8');
    expect(approvalSource).toContain("return refusedBy('approval_wrong_issuer', 'the issuer record that the reference names is not the issuer record of the attestation');");
    expect(approvalSource).toContain("{ id: 'time_window', code: 'approval_expired', text: 'the time of the check is not inside the validity range of the approval'");
    expect(approvalSource).toContain("{ id: 'envelope', code: 'approval_issuer_invalid', text: 'the envelope signature of the approval does not verify with the issuer key'");
    expect(approvalSource).toContain("{ id: 'issuer_not_invalidated', code: 'approval_issuer_invalid', text: 'the issuer of the approval was invalid when it issued the approval'");
    expect(approvalSource).toContain("{ id: 'issuer_key_listed', code: 'approval_issuer_invalid', text: 'the issuer key was not listed for assertion when the approval was issued'");
    expect(checks[9][4]).toBe('the issuer of the approval is the root delegator of the delegation, and, when the attestation names an issuer record, `issuer_did` of the approval is that record');
    expect(checks[10][4]).toBe('the approval is valid now by the rule of the registry. It is not revoked (`approval_revoked`). The time is inside its validity range: a window that is over, and a window that has not started, both give `approval_expired`. The issuer was valid, and its key was listed for assertion, when it issued the approval. The envelope signature, when there is one, verifies. A failure of one of these last three gives `approval_issuer_invalid`');
    expect(checks[11][4]).toBe('the digest of the approval is the digest of the authorization request and the salt that the Insurer Intake Agent received');
    expect(hook).toContain("The hook makes 15 checks, one after the other, in the order of the table. The first 12 are the shared checks of use case 2: the sender, the delegation, the payment from a vault, and the sign-off of the provider's reviewer. The last three are the checks of this agent.");
    expect(hook).toContain('The first check that fails ends the hook. Its answer is the refusal code of that check, with the status 403.');
    expect(hook).toContain('A refusal comes before the Claim: the escrow stays open, nothing is claimed, nothing is paid, and the buyer reclaims the escrow after `deliver_by`.');
  });

  test('the three checks of this agent refuse with their codes and have an accepted twin: the insurer, the advert of the escrow, and a request number that the intake book does not hold', async () => {
    const rig = makeRig();
    const book = new MemoryIntakeBook();
    const insurer = String(PRIOR_REQUEST.insurer_did);
    const [forThisInsurer, advert, notDuplicate] = intakeChecks({ book, self: insurer });
    expect([forThisInsurer.names, advert.names, notDuplicate.names]).toStrictEqual([['for_this_insurer'], ['advert'], ['not_duplicate']]);
    const handoff = handoffOf();
    // The request names this agent as its insurer.
    expect(await forThisInsurer.run(handoff, rig.context)).toMatchObject({ ok: true });
    expect(await intakeChecks({ book, self: `did:vector:${'b2'.repeat(32)}` })[0].run(handoff, rig.context)).toMatchObject({ ok: false, code: 'not_for_this_insurer' });
    // The advert of the request is the advert of the escrow, and the advert of the escrow comes from the context and never from the body.
    expect(await advert.run(handoff, rig.context)).toMatchObject({ ok: true });
    expect(await advert.run(handoff, { ...rig.context, advertRef: `${'d5'.repeat(32)}#1` })).toMatchObject({ ok: false, code: 'advert_mismatch' });
    // The book holds no entry for the tenant and the number, and a number counts without regard to case.
    expect(await notDuplicate.run(handoff, rig.context)).toMatchObject({ ok: true });
    await book.record('run1', 'RUN1-1', 'IN-run1-0001');
    expect(await notDuplicate.run(handoff, rig.context)).toMatchObject({ ok: false, code: 'duplicate_request' });
    expect(await notDuplicate.run(handoffOf(priorRequest({ tenant: 'run2' })), rig.context)).toMatchObject({ ok: true });
    // A book that cannot answer is never a pass: the check gives CheckUnavailableError, which the hook answers with 503 check_unavailable.
    const unread = (has: () => Promise<boolean>) => intakeChecks({ book: { has }, self: insurer })[2].run(handoff, rig.context);
    await expect(unread(async () => { throw new Error('the file is gone'); })).rejects.toBeInstanceOf(CheckUnavailableError);
    await expect(unread(async () => 'yes' as unknown as boolean)).rejects.toBeInstanceOf(CheckUnavailableError);
  });

  test('a go keeps the record for 300 s and reserves the job slot for 120 s, the hook answers 503 for a source that it cannot read, and the runtime waits 10000 ms', () => {
    expect(hook).toContain(`When every check passes, the hook answers 200 \`{"go":true,"reserved_ms":${RESERVATION_MS}}\`.`);
    expect(hook).toContain(`The service keeps the record of the checks for ${PASSED_CHECKS_TTL_MS / 1000} s, and it reserves the job slot for that escrow for ${RESERVATION_MS / 1000} s.`);
    expect([RESERVATION_MS, PASSED_CHECKS_TTL_MS]).toStrictEqual([120_000, 300_000]);
    expect(hook).toContain('A source that the hook cannot read (the identity gateway, the ledger or the intake book) is never a pass: the hook answers 503 `check_unavailable`.');
    expect(ERROR_STATUS.check_unavailable).toBe(503);
    expect(hook).toContain(`The runtime waits ${RUNTIME_PRECHECK_WAIT_MS} ms for the hook, and reads silence as a refusal.`);
    expect(readme).toContain('the hook keeps the record of the checks for 300 s and reserves the job slot for that escrow for 120 s');
    expect(readme).toContain('The runtime waits 10000 ms for the hook, and reads silence as a refusal.');
  });

  test('the six headers of the context carry the escrow, the advert and the key of the escrow, and the body never does', () => {
    const headers = Object.values(CONTEXT_HEADERS);
    expect(headers).toHaveLength(6);
    const named = `${headers.slice(0, -1).map((name) => `\`${name}\``).join(', ')} and \`${headers.at(-1)}\``;
    expect(hook).toContain(`The runtime sends six headers of context with each call: ${named}.`);
    expect(hook).toContain('The hook needs all six, and a call with none, with some, or with a bad one gets 400 `bad_context`.');
    expect(hook).toContain('The escrow, the advert and the key that posted the escrow come from these headers and never from the body: the checks `sender_key`, `delegation`, `vault_paid` and `advert` read them there.');
    // The shared checks read the key and the escrow from the context, and the body has no member for them.
    const sharedSource = readFileSync(new URL('../../../packages/usecase-kit/src/checks/shared.ts', import.meta.url), 'utf8');
    expect(sharedSource).toContain('checkSenderKey(senderRecord(), context.buyerPkh)');
    expect(sharedSource).toContain('checkDelegationNamesSender(view, delegation, sender, context.buyerPkh)');
    expect(sharedSource).toContain('ports.ledger.escrowPaid(context.escrowRef, delegation)');
    expect(readme).toContain('a call with none, with some, or with a bad one gets 400 `bad_context`');
    expect(new RequestRefusal('bad_context', 'x').status).toBe(400);
  });

  test('a refusal for approval_digest_mismatch is answered first, and the service then files a challenge that names S1 of the claim of the Prior Authorization Agent, with no reference in the message', () => {
    const precheck = readFileSync(new URL('../src/checks/precheck.ts', import.meta.url), 'utf8');
    expect(precheck).toContain("if (refusal.code !== 'approval_digest_mismatch') return;");
    expect(precheck).toContain('capability_id: PRIORAUTH_CAPABILITIES.intake,');
    expect(precheck).toContain('claim_capability_id: PRIORAUTH_CAPABILITIES.draft,');
    expect(precheck).toContain('statement_text: PRIORAUTH_CLAIM.statements[0].text,');
    expect(PRIORAUTH_CAPABILITIES.draft).toBe('health.priorauth.draft.v1');
    expect(PRIORAUTH_CLAIM.statements[0].id).toBe('S1');
    expect(EVIDENCE_STATEMENTS.approval_digest).toBe('S1');
    expect(NO_OPEN_CLAIM).toBe('no_open_claim');
    expect(hook).toContain('When the check `approval_digest` fails, the approval is for another authorization request than the one in the handoff. The hook refuses first, with `approval_digest_mismatch`.');
    expect(hook).toContain('Then the service starts a challenge in the background, against the open claim of the sender: it publishes an evidence document and opens the challenge on the ledger.');
    expect(hook).toContain(`The challenge names the statement S1 of the claim of the Prior Authorization Agent: "${PRIORAUTH_CLAIM.statements[0].text}"`);
    expect(hook).toContain(`The answer of the hook never waits for the challenge and never holds a reference to it, because a challenge takes two transactions and the runtime waits only ${RUNTIME_PRECHECK_WAIT_MS} ms.`);
    expect(hook).toContain('The reference of the challenge goes to the log of the service and to the journal of its dispute code, never to the message of the refusal.');
    expect(hook).toContain('A challenge needs an open claim of the sender: when there is none, the service files nothing, and its log names the code `no_open_claim`.');
    expect(readme).toContain('The answer to the runtime never waits for the challenge and never holds a reference to it.');
  });
});

describe('specs/insurer-intake-agent.md: what the job does', () => {
  const does = sub('What it does');
  const steps = does.split('\n').filter((line) => /^\d\. /.test(line));

  test('the job takes its seven steps in the order of the page, with the calls to the portal that the manifest names, and it files one entry', async () => {
    const rig = makeRig();
    await rig.run();
    expect(rig.events).toStrictEqual(['take', 'svid', 'requirements', 'report', 'decide', 'filing', 'book']);
    const phrases = ['takes the record of the checks', 'JWT-SVID', 'requirements/{service_code}', 'reports the attestations', 'Decision `completeness`', 'insurer/requests', 'writes the intake book'];
    expect(steps).toHaveLength(phrases.length);
    phrases.forEach((phrase, at) => expect(steps[at], phrase).toContain(phrase));
    const [read, file] = manifest.behaviour.relying_on.mock_systems;
    expect(steps[2]).toContain(`\`${read}\``);
    expect(steps[5]).toContain(`\`${file}\``);
    expect(rig.portal.calls.map((call) => `${call.method} ${new URL(call.url).pathname}`)).toStrictEqual(['GET /t/run1/insurer/requirements/SYN-MRI-LS', 'POST /t/run1/insurer/requests']);
    expect(Object.keys(JSON.parse(posts(rig)[0]?.body ?? 'null'))).toStrictEqual(['request', 'status', 'missing']);
    expect(steps[5]).toContain('The body holds the authorization request, the `status` and the ids in `missing` that the choice of the model gives.');
    // The JWT-SVID has one audience: the insurer system of the tenant of the request.
    const asked = rig.gateway.requests.filter((call) => call.path === '/spiffe/jwt-svid');
    expect(asked).toHaveLength(1);
    expect(JSON.parse(asked[0].body)).toMatchObject({ audience: `${BASES.publicBase}/t/run1/insurer` });
    expect(steps[1]).toContain('The audience of the JWT-SVID is the insurer system of the tenant of the request.');
    expect(steps[2]).toContain('The answer is the requirement set for that service code: a title and a list of requirements, each with an id and a text.');
    expect(steps[3]).toContain('The report never refuses the job, and its result never reaches the model.');
    expect(steps[4]).toContain('The model gets a fixed instruction, six members of the request and the requirement set. It answers with a choice, `{ "complete": true | false, "missing": ["<requirement id>"] }`, and its reasons.');
    expect(steps[6]).toContain('It writes the intake book, after the portal took the entry, and it answers with the intake record.');
    expect(does).toContain(`The job has a deadline of ${JOB_DEADLINE_MS} ms after its request arrives, and it runs these steps in this order. A failure ends the job with an error, and no later step runs.`);
  });

  test('a job with no record of passed checks for its body fails with precheck_missing and files nothing, and the first step reads the sender, the approval and the 15 checks from the record', async () => {
    const none = makeRig();
    none.kept.clear();
    expect(await refusalOf(() => none.run())).toMatchObject({ code: 'precheck_missing', status: 500 });
    expect(none.events).toStrictEqual(['take']);
    const other = makeRig();
    other.kept.set(other.context.escrowRef, recordFor(other.request, { request_sha256: hashOf({ another: 'body' }) }));
    expect(await refusalOf(() => other.run())).toMatchObject({ code: 'precheck_missing', status: 500 });
    expect(other.events).toStrictEqual(['take']);
    expect(INTAKE_REFUSAL_STATUS.precheck_missing).toBe(500);
    expect(steps[0]).toContain('A job with no record, or with the record of another body, fails with `precheck_missing` and files nothing.');
    expect(steps[0]).toContain('It reads the sender, the approval and the 15 checks of the intake record from that record.');
    const sender = makeRig();
    expect(await sender.run()).toMatchObject({ sender: { did: SENDER_DID }, checks: Object.fromEntries(INTAKE_CHECKS.map((name) => [name, true])) });
  });

  test('the choice of the model must agree with itself, and an incomplete request is still filed with the ids that the model named', async () => {
    const { parse } = completenessDecision(['R1', 'R2']);
    expect([parse({ complete: true, missing: [] }).ok, parse({ complete: false, missing: ['R1'] }).ok, parse({ complete: false, missing: ['R2', 'R1'] }).ok]).toStrictEqual([true, true, true]);
    expect([parse({ complete: true, missing: ['R1'] }).ok, parse({ complete: false, missing: [] }).ok, parse({ complete: false, missing: ['R9'] }).ok]).toStrictEqual([false, false, false]);
    expect([parse({ complete: false, missing: ['R1', 'R1'] }).ok, parse({ complete: 'yes', missing: [] }).ok]).toStrictEqual([false, false]);
    const broken = makeRig();
    broken.decision = accepted(decisionOf({ complete: true, missing: ['R3'] }));
    expect(await refusalOf(() => broken.run())).toMatchObject({ code: 'model_output_invalid', status: 502 });
    expect(broken.portal.filed.size).toBe(0);
    const incomplete = makeRig();
    incomplete.decision = accepted(decisionOf({ complete: false, missing: ['R3'] }));
    expect(await incomplete.run()).toMatchObject({ status: 'incomplete', missing: ['R3'] });
    expect(JSON.parse(posts(incomplete)[0]?.body ?? 'null')).toMatchObject({ status: 'incomplete', missing: ['R3'] });
    expect(incomplete.portal.filed.size).toBe(1);
    expect(does).toContain('The choice must agree with itself: `complete` is `true` exactly when `missing` is empty, each id in `missing` is the id of a requirement of the set, and no id stands two times. A choice that breaks this rule fails the job with `model_output_invalid`, and nothing is filed.');
    expect(does).toContain('When the model finds the request incomplete, the job does not refuse. It files the request with the status `incomplete` and the ids that the model named, and it answers with the intake record.');
  });

  test('a new JWT-SVID is asked for before the filing when the first one is about to end, and not before', async () => {
    const issued = async (advanceMs: number): Promise<number> => {
      const rig = makeRig({ deliverInMs: 900_000 });
      await rig.run({ deps: { decide: async (input, requirementIds) => { rig.gateway.advance(advanceMs); return rig.deps.decide(input, requirementIds); } } });
      expect(rig.portal.filed.size).toBe(1);
      return rig.issued.length;
    };
    expect(await issued(0)).toBe(1);
    expect(await issued(300_000)).toBe(2);
    expect(steps[5]).toContain('The job asks the identity gateway for a new JWT-SVID first when the one that it holds would end less than one call before the filing could end.');
  });

  test('the limits of the job: one filing and no retry, a caller that hangs up, the 30 s before deliver_by, and the 20 s of a call to the portal', async () => {
    // One filing, and no retry: a filing call that fails is not made again.
    const failing = makeRig();
    failing.portal.filing = { throws: new Error('socket hang up') };
    expect(await refusalOf(() => failing.run())).toMatchObject({ code: 'mock_system_failed', status: 502 });
    expect(posts(failing)).toHaveLength(1);
    // A caller that hangs up before the decision stops the job there: no model is hired and no entry is filed.
    const gone = new AbortController();
    gone.abort();
    const early = makeRig();
    expect(await refusalOf(() => early.run({ signal: gone.signal }))).toMatchObject({ code: 'deadline', status: 422 });
    expect(early.events).toStrictEqual(['take', 'svid', 'requirements', 'report']);
    expect(early.portal.filed.size).toBe(0);
    // The filing starts only when its call can end 30 s before deliver_by, and one call takes 20 s at most.
    expect([RUNTIME_MARGIN_MS, CALL_TIMEOUT_MS]).toStrictEqual([30_000, 20_000]);
    const tight = makeRig({ deliverInMs: CALL_TIMEOUT_MS + RUNTIME_MARGIN_MS - 1 });
    expect(await refusalOf(() => tight.run())).toMatchObject({ code: 'deadline', status: 422 });
    expect(tight.portal.filed.size).toBe(0);
    const enough = makeRig({ deliverInMs: CALL_TIMEOUT_MS + RUNTIME_MARGIN_MS });
    expect(await enough.run()).toMatchObject({ status: 'complete' });
    expect(enough.portal.filed.size).toBe(1);
    expect(readFileSync(new URL('../src/serve/wiring.ts', import.meta.url), 'utf8')).toContain('timeoutMs: CALL_TIMEOUT_MS');
    // A caller that hangs up during the filing call, or after it, does not stop the job: it books the entry, and its log says that the caller hung up.
    const during = new AbortController();
    const hung = makeRig();
    const fetch: typeof globalThis.fetch = async (url, init) => {
      if (init?.method === 'POST') during.abort();
      if (init?.signal?.aborted === true) throw new Error('the call was aborted');
      return hung.portal.fetch(url, init);
    };
    await hung.run({ signal: during.signal, deps: { calls: { ...hung.deps.calls, fetch } } });
    expect(hung.booked).toHaveLength(1);
    expect(hung.logs.some((line) => line.includes('hung up while the request was filed'))).toBe(true);
    // A failure after the filing call can leave an entry at the portal with no entry in the intake book.
    const unbooked = makeRig();
    unbooked.bookError = new Error('the disk is full');
    expect(await refusalOf(() => unbooked.run())).toMatchObject({ code: 'store_write_failed', status: 500 });
    expect([unbooked.portal.filed.size, unbooked.booked.length]).toStrictEqual([1, 0]);
    expect(unbooked.logs.some((line) => line.includes('the portal holds the entry'))).toBe(true);
    expect(failing.booked).toHaveLength(0);
    expect(failing.logs.some((line) => line.includes('may exist'))).toBe(true);
    // When the portal holds the entry, a later job for the same request number passes the check of the hook, and the portal refuses its entry: duplicate_request after the Claim.
    const later = makeRig();
    later.portal.prefile('run1-1');
    expect(await refusalOf(() => later.run())).toMatchObject({ code: 'duplicate_request', status: 403 });
    expect(INTAKE_REFUSAL_STATUS.duplicate_request).toBe(403);
    expect(does).toContain('The job files at most one entry, and nothing retries the filing call. The portal refuses a second entry for the same request number, and the service answers `duplicate_request` (403).');
    expect(does).toContain('A job whose caller hangs up before the decision, or before the filing call, stops there with `deadline` (422), because the service never hires a model or files an entry that nobody reads.');
    expect(does).toContain('A hang-up during the filing call, or after it, does not stop the job: it books the entry, and its log says that the caller hung up.');
    expect(does).toContain('A job can fail after the filing call and leave an entry at the portal with no entry in the intake book (see Errors).');
    expect(does).toContain(`The job files nothing when the filing call could end less than ${RUNTIME_MARGIN_MS / 1000} s before \`deliver_by\`, because the runtime stops waiting then. One call to the insurer portal takes ${CALL_TIMEOUT_MS} ms at most.`);
  });
});

describe('specs/insurer-intake-agent.md: the report of the attestations', () => {
  const report = sub('The report of the attestations');
  const PROVIDER = '3c'.repeat(28);
  const ROOT = '4d'.repeat(28);
  const input = { sender: SENDER_DID, delegation: DELEGATION_ID, atMs: 1_790_000_000_000 };
  const everyWord = (word: string) => ({ provenance: word, software: word, principal_binding: word });
  /** A world in which each attestation of the right issuer is valid. `over` replaces a port, and `asked` keeps what each check was asked. */
  function world(over: Partial<ReportDeps> = {}) {
    const asked: ReportExpectation[] = [];
    const deps: ReportDeps = {
      list: async (_subject, attType) => [{ id: `${attType}`.repeat(64), issuer_key_hash: attType === ATT_TYPES.principal_binding ? ROOT : PROVIDER, issuer_id: null, issued_at: 1_000 }],
      check: async (_id, _atMs, expectation) => { asked.push(expectation); return true; },
      providerKeyHashOf: async () => PROVIDER,
      rootDelegatorOf: async () => ({ type: 'key', hash: ROOT }),
      clock: systemClock,
      log: () => undefined,
      ...over,
    };
    return { deps, asked };
  }

  test('the three kinds have the types of the registry and the issuers that the page names, and each check names a type, a subject and an issuer, and no digest', async () => {
    const kinds = tableRows(report, '| Kind | Attestation type | Who must have issued it |');
    expect(kinds.map((cells) => cells[0])).toStrictEqual(['`provenance`', '`software`', '`principal_binding`']);
    expect(kinds.map((cells) => Number(cells[1]))).toStrictEqual([ATT_TYPES.provenance, ATT_TYPES.software, ATT_TYPES.principal_binding]);
    expect([ATT_TYPES.provenance, ATT_TYPES.software, ATT_TYPES.principal_binding]).toStrictEqual([1, 2, 4]);
    expect(kinds.map((cells) => cells[2])).toStrictEqual([
      'the Provider of the sender: the Provider party of the record of the sender that is in force, by the hash of its key',
      'the Provider of the sender, as for `provenance`',
      'the root delegator of the delegation of the request: for a key principal, the hash of its key, and for an agent root, the id of its record. An attestation of another issuer never counts',
    ]);
    const { deps, asked } = world();
    expect(await reportAttestations(deps, input)).toStrictEqual(everyWord('valid'));
    expect(asked).toStrictEqual([
      { attType: 1, subject: SENDER_DID, issuer: { key_hash: PROVIDER } },
      { attType: 2, subject: SENDER_DID, issuer: { key_hash: PROVIDER } },
      { attType: 4, subject: SENDER_DID, issuer: { key_hash: ROOT } },
    ]);
    // An agent root is known by the id of its record, and a row of that id is the binding.
    const agent = world({
      rootDelegatorOf: async () => ({ type: 'agent', id: 'e1'.repeat(32) }),
      list: async (_subject, attType) => [{ id: `${attType}`.repeat(64), issuer_key_hash: attType === ATT_TYPES.principal_binding ? 'ff'.repeat(28) : PROVIDER, issuer_id: attType === ATT_TYPES.principal_binding ? 'e1'.repeat(32) : null, issued_at: 1 }],
    });
    expect(await reportAttestations(agent.deps, input)).toStrictEqual(everyWord('valid'));
    expect(agent.asked[2]).toStrictEqual({ attType: 4, subject: SENDER_DID, issuer: { did: `did:vector:${'e1'.repeat(32)}` } });
    expect(report).toContain('For each kind the report lists the attestations about the sender of that type, keeps those of the right issuer, and checks the two newest. Each kind gets one of four words:');
    expect(report).toContain('After the read of the requirements, the job reads three attestations about the sender and reports what it found. The report stands in the intake record, under `attestations`.');
  });

  test('the four words are ATTESTATION_STATES, and each word means what the page says', async () => {
    expect(tableRows(report, '| Word | Meaning |').map((cells) => cells[0])).toStrictEqual(ATTESTATION_STATES.map((word) => `\`${word}\``));
    expect([...ATTESTATION_STATES]).toStrictEqual(['valid', 'invalid', 'absent', 'unreadable']);
    const states = async (over: Partial<ReportDeps>) => reportAttestations(world(over).deps, input);
    expect(await states({})).toStrictEqual(everyWord('valid'));
    expect(await states({ check: async () => false })).toStrictEqual(everyWord('invalid'));
    expect(await states({ list: async () => [] })).toStrictEqual(everyWord('absent'));
    // A row of another issuer never counts, and a sender with no Provider party that names a key has no provenance and no software attestation.
    expect(await states({ list: async (_subject, attType) => [{ id: `${attType}`.repeat(64), issuer_key_hash: 'ff'.repeat(28), issuer_id: null, issued_at: 1 }] })).toStrictEqual(everyWord('absent'));
    expect(await states({ providerKeyHashOf: async () => null })).toStrictEqual({ provenance: 'absent', software: 'absent', principal_binding: 'valid' });
    // A source that cannot be read is unreadable, and never absent.
    expect(await states({ list: async () => { throw new Error('the ledger is down'); } })).toStrictEqual(everyWord('unreadable'));
    expect(await states({ rootDelegatorOf: async () => null })).toStrictEqual({ provenance: 'valid', software: 'valid', principal_binding: 'unreadable' });
    expect(await states({ check: async () => { throw new Error('the ledger is down'); } })).toStrictEqual(everyWord('unreadable'));
    // The two newest rows of the right issuer are checked, and the third is never asked.
    const checked: string[] = [];
    const three = world({
      list: async (_subject, attType) => [1, 2, 3].map((at) => ({ id: `${at}`.repeat(64), issuer_key_hash: attType === ATT_TYPES.principal_binding ? ROOT : PROVIDER, issuer_id: null, issued_at: at })),
      check: async (id) => { checked.push(id[0]); return false; },
    });
    expect(await reportAttestations(three.deps, input)).toStrictEqual(everyWord('invalid'));
    expect(checked).toStrictEqual(['3', '2', '3', '2', '3', '2']);
    expect(tableRows(report, '| Word | Meaning |').map((cells) => cells[1])).toStrictEqual([
      'an attestation of the right issuer passes the check of the registry',
      'attestations of the right issuer exist, and none passes',
      'no attestation of the right issuer exists, or the sender has no Provider party that names a key',
      'a source could not be read, or the budget of the report ended. The word is never a pass, and it is never `absent`',
    ]);
  });

  test('the report never refuses the job and never reaches the model, it does not check the digest of the principal-binding attestation, and its budget is the budget of the page', async () => {
    const failing = makeRig();
    const record = await failing.run({ deps: { report: async () => { throw new Error('the ledger is down'); } } });
    expect(record.attestations).toStrictEqual(everyWord('unreadable'));
    expect(failing.portal.filed.size).toBe(1);
    const rig = makeRig();
    rig.attestations = { provenance: 'invalid', software: 'absent', principal_binding: 'unreadable' };
    const mixed = await rig.run();
    expect(mixed.attestations).toStrictEqual(rig.attestations);
    expect(mixed.status).toBe('complete');
    expect(rig.events.indexOf('report')).toBeLessThan(rig.events.indexOf('decide'));
    expect(Object.keys(rig.decideCalls[0].input as object)).toStrictEqual(['request', 'requirements']);
    expect(report).toContain('The agent reports these attestations and does not require them: the report never refuses the job, never changes the decision of the model, and never reaches the model.');
    // The digest of a binding attestation is not checked. The salt and the document stay with the hirer, so the agent cannot work the digest out again.
    expect(report).toContain(BINDING_GAP);
    expect(report).toContain('A principal-binding attestation holds a salted commitment, and the agent cannot work it out again.');
    expect(report).toContain(`The report has ${REPORT_BUDGET_MS} ms for the whole report and ${READ_BUDGET_MS} ms for one read. A kind that the budget cuts off is \`unreadable\`.`);
    expect([REPORT_BUDGET_MS, READ_BUDGET_MS]).toStrictEqual([45_000, 15_000]);
  });
});

describe('specs/insurer-intake-agent.md: the response', () => {
  const response = sub('Response');

  test('the Response heading is the anchor that the manifest links to', () => {
    expect(page.match(/^### Response$/gm)).toHaveLength(1);
    expect(manifest.interface.response_schema.$ref.endsWith('/specs/insurer-intake-agent.md#response')).toBe(true);
    expect(manifest.links.spec.endsWith('/specs/insurer-intake-agent.md')).toBe(true);
    expect(manifest.links.source.endsWith('/agents/insurer-intake-agent')).toBe(true);
  });

  test('the example is the intake record that the job gives in the golden run, and the members of the table are its members in their order', async () => {
    const shown = jsonBlock(response);
    expect(shown).toBe(golden('intake-record-complete.json').trimEnd());
    const given = await makeRig().run();
    expect(JSON.parse(shown)).toStrictEqual(given);
    expect(shown).toBe(JSON.stringify(given, null, 2));
    expect(parseIntakeRecord(JSON.parse(shown))).toStrictEqual({ ok: true, value: given });
    // The example answers the request of the example: the same request number, the hash of the same request, the same sender and the same approval.
    const handoff = handoffOf();
    expect(given.request_number).toBe(PRIOR_REQUEST.request_number);
    expect(given.request_sha256).toBe(PRIOR_REQUEST_SHA256);
    expect(given.request_sha256).toBe(hashOf(handoff.document));
    expect(given.sender.did).toBe(handoff.sender_did);
    expect(given.approval.attestation).toBe(handoff.approval?.attestation);
    expect(given.approval.issuer_did).toBe(handoff.approval?.issuer_did);
    expect(Object.keys(given.checks)).toStrictEqual([...INTAKE_CHECKS]);
    // The table names the members in the order of the intake record, one for each row, and its rows say what they hold.
    const names = response.split('\n').filter((line) => /^\| `/.test(line)).flatMap((line) => [...(line.split(' | ')[0] ?? '').matchAll(/`([a-z0-9_]+)`/g)].map((hit) => hit[1]));
    expect(names).toStrictEqual(Object.keys(given));
    expect(row(response, '`schema`')).toBe(`| \`schema\` | \`${INTAKE_RECORD_SCHEMA}\` |`);
    expect(given.schema).toBe(INTAKE_RECORD_SCHEMA);
    expect(row(response, '`outcome`')).toBe('| `outcome` | always `done`: a refusal or a failure is an error, never an intake record |');
    expect(row(response, '`request_sha256`')).toBe('| `request_sha256` | the SHA-256 of the canonical text of the authorization request that the Insurer Intake Agent received, with no salt |');
    expect(row(response, '`status`')).toBe(`| \`status\` | \`${INTAKE_STATUSES[0]}\` when the model finds that the request meets every requirement, and \`${INTAKE_STATUSES[1]}\` when it does not |`);
    expect(row(response, '`missing`')).toBe('| `missing` | the ids of the requirements that the request does not meet: none for `complete`, and 1 to 20 for `incomplete`, none twice |');
    expect(row(response, '`attestations`')).toBe(`| \`attestations\` | what the report found about the sender: \`provenance\`, \`software\` and \`principal_binding\`, each one of ${ATTESTATION_STATES.map((word) => `\`${word}\``).join(', ')} |`);
    expect(row(response, '`checks`')).toBe(`| \`checks\` | the ${INTAKE_CHECKS.length} checks, each \`true\`, in the order of the table of the hook |`);
    expect(row(response, '`decisions`')).toBe('| `decisions` | one decision, `completeness`: its choice, its reasoning, and the hire of the model supplier with the sub-receipt that the service verified (`inference`) |');
    expect(row(response, '`fault_mode`')).toBe('| `fault_mode` | the empty text: the agent has no fault value |');
    expect(response).toContain(`\`schema\` is \`${INTAKE_RECORD_SCHEMA}\`.`);
    expect(response).toContain('It is an illustration and not a recorded run: its references, hashes, key hash and signature are of no escrow, no insurer and no key.');
    expect(response).toContain('A job that does not file it answers with an error (see Errors) and no intake record.');
  });

  test('an incomplete request is still filed and answered, and the status and the list of missing ids go together', async () => {
    const incomplete = makeRig();
    incomplete.decision = accepted({ ...decisionOf({ complete: false, missing: ['R3'] }), reasoning: 'The justification does not cite the criteria of the guideline, so requirement R3 is not met.' });
    incomplete.attestations = { provenance: 'valid', software: 'absent', principal_binding: 'unreadable' };
    const record = await incomplete.run();
    expect(JSON.stringify(record, null, 2)).toBe(golden('intake-record-incomplete.json').trimEnd());
    expect(record).toMatchObject({ status: 'incomplete', missing: ['R3'], fault_mode: '' });
    expect(incomplete.portal.filed.size).toBe(1);
    expect(incomplete.booked).toHaveLength(1);
    // The parser of the kit takes 1 to 20 ids for an incomplete record, none twice, and no id for a complete one.
    const recordWith = (status: string, missing: string[]) => {
      const given = JSON.parse(JSON.stringify(record));
      given.status = status;
      given.missing = missing;
      given.decisions[0].choice = { complete: status === 'complete', missing };
      return parseIntakeRecord(given).ok;
    };
    const many = (count: number) => Array.from({ length: count }, (_, at) => `R${at + 1}`);
    expect([recordWith('incomplete', many(1)), recordWith('incomplete', many(20)), recordWith('incomplete', many(21)), recordWith('incomplete', ['R1', 'R1'])]).toStrictEqual([true, true, false, false]);
    expect([recordWith('complete', []), recordWith('complete', ['R1']), recordWith('incomplete', [])]).toStrictEqual([true, false, false]);
    expect(response).toContain('A request that the model finds incomplete is still filed and answered: its record has the status `incomplete`, and `missing` lists the ids of the requirements that it does not meet.');
  });
});

describe('specs/insurer-intake-agent.md: the errors', () => {
  const errors = sub('Errors');
  const statusRows = (text: string): string[] => text.split('\n').filter((line) => /^\| \d{3}, /.test(line));
  /** The names of codes in the second cell of a row of the table, in order. */
  const codesIn = (line: string): string[] => [...(line.split('|')[2] ?? '').matchAll(/`([^`]+)`/g)].map((hit) => hit[1]).filter((text) => /^[a-z_]+$/.test(text));
  const kitServer = readFileSync(new URL('../../../packages/service-kit/src/server.ts', import.meta.url), 'utf8');

  test('the table is the table of the README, with its 11 rows, and every code has its status', () => {
    const onPage = statusRows(errors);
    expect(onPage).toHaveLength(11);
    expect(onPage).toStrictEqual(statusRows(readme.split('\n## Errors\n')[1] ?? ''));
    // A code that the protocol does not list has its status elsewhere: the request refusal of the service, and the kit of the service.
    const outside: Record<string, number> = { bad_context: new RequestRefusal('bad_context', 'x').status, not_found: 404 };
    const documented = new Map<string, number[]>();
    for (const line of onPage) {
      const status = Number(/^\| (\d{3}), /.exec(line)?.[1]);
      for (const code of codesIn(line)) {
        documented.set(code, [...(documented.get(code) ?? []), status]);
        expect(Object.hasOwn(outside, code) ? outside[code] : ERROR_STATUS[code as keyof typeof ERROR_STATUS], code).toBe(status);
      }
    }
    // The 403 row before the Claim holds the 17 codes of the hook, in the order of its checks, and the codes of the job are the codes that the job gives.
    expect(codesIn(onPage.find((line) => line.startsWith('| 403, the hook, before the Claim')) ?? '')).toStrictEqual([...COUNTERPARTY_REFUSALS['insurer-intake-agent']]);
    expect(codesIn(onPage.find((line) => line.startsWith('| 403, the job, after the Claim')) ?? '')).toStrictEqual(['duplicate_request']);
    for (const [code, status] of Object.entries(INTAKE_REFUSAL_STATUS)) expect(documented.get(code), code).toContain(status);
    for (const code of [...COUNTERPARTY_REFUSALS['insurer-intake-agent'], 'check_unavailable', 'busy', 'shutting_down', 'unauthorized', 'not_found', 'bad_wire', 'request_too_large', 'bad_shape', 'bad_context', 'internal']) {
      expect(documented.has(code), code).toBe(true);
    }
    expect([...documented.entries()].filter(([, statuses]) => statuses.length > 1)).toStrictEqual([['duplicate_request', [403, 403]]]);
  });

  test('the 401, the 404, the 409 of a job and a plain 500 have no message, the 409 of the hook has one, and the slot gives the busy answers as the page says', () => {
    expect(errors).toContain('A refusal is `{ "error": "<code>", "message": "<words>" }` with the status in the table.');
    expect(errors).toContain('- The 401, the 404, the 409 of a job and a plain 500 have the code and no message: `{"error":"unauthorized"}`, `{"error":"not_found"}`, `{"error":"busy"}` and `{"error":"internal"}`. A plain 500 is the answer to a fault that no code names, and its cause is in the log.');
    expect(kitServer).toContain("return send(401, { error: 'unauthorized' });");
    expect(kitServer).toContain("return send(404, { error: 'not_found' });");
    expect(kitServer.split("send(409, { error: 'busy' })").length - 1).toBe(2);
    expect(kitServer).toContain("return send(409, { error: 'busy', message: BUSY_TEXT });");
    expect(kitServer).toContain("return send(500, { error: 'internal' });");
    expect(errors).toContain(`- A refusal of status 500 or more gets a fixed message, \`${operatorsText('<code>')}\`, because the runtime copies the first 200 characters of a failure to the buyer, and the detail is the operator's. \`shutting_down\` has the fixed message \`${STOPPING_TEXT}\`, and the 409 \`busy\` of the hook has the fixed message \`${BUSY_TEXT}\`.`);
    expect(errors).toContain('- A refusal of the hook leaves the escrow open, and nothing is paid. A job that fails after the Claim leaves the escrow Claimed: the buyer reclaims it after `deliver_by`, and nothing is paid for work that was not done. A job that fails before the filing call files no entry.');
    expect(errors).toContain('- A job that fails after the filing call can leave an entry at the portal with no entry in the intake book. That happens with `mock_system_failed` after a call that was sent, and with `store_write_failed` of the intake book. The log says so. When the portal holds the entry, a later job for the same request number passes the check `not_duplicate`, and the portal then refuses its entry: that job ends with `duplicate_request` (403) after the Claim.');
    expect(readme).toContain('A job that fails after the Claim leaves the escrow claimed. The sender reclaims it after the deadline, and nothing is paid for work that was not done.');
    expect(errors).toContain('- One job runs at a time. A job that arrives while a job runs, or while the slot is reserved for another escrow, gets 409 `{"error":"busy"}`, and nothing starts. A call of the hook gets 409 `busy` with a message while a job runs, whatever its escrow, and while the slot is reserved for another escrow. A new go of the hook for the escrow that holds the reservation reserves the slot again; a refusal of the hook reserves nothing.');
    // The slot: a job that runs holds it against every call, the escrow of a reservation gets it again, and another escrow is held off.
    const slot = new JobSlot();
    expect(slot.take('escrow-a', 1_000)).toBe('taken');
    expect([slot.canTake('escrow-a', 1_000), slot.canTake('escrow-b', 1_000)]).toStrictEqual(['busy', 'busy']);
    slot.release();
    expect(slot.reserve('escrow-a', 1_000)).toBe('reserved');
    expect([slot.canTake('escrow-a', 2_000), slot.canTake('escrow-b', 2_000)]).toStrictEqual(['free', 'held']);
    expect(slot.reserve('escrow-a', 2_000)).toBe('reserved');
    expect(slot.take('escrow-b', 2_000)).toBe('held');
    expect(HEARTBEAT_MS).toBe(60_000);
    expect(errors).toContain('- While a job runs, the service writes an interim `102 Processing` line every 60 s, ahead of the answer, because the fetch of the runtime gives up after 300 s of silence.');
    expect(readme).toContain('gives up after 300 s of silence');
    // The service answers 200 only for a job that did its work, and the buyer-side agent that hires it turns each refusal and failure into a reason of its own result.
    expect(errors).toContain('- The service answers 200 only when it did the work, and the 200 answer is the intake record. Every code of the table is a refusal or a failure. The Prior Authorization Agent, which hires this service, turns a refusal or a failure into its own `reason`, and answers its hirer with a 200 result.');
    expect(readme).toContain('Every code of the table is a refusal or a failure. The Prior Authorization Agent, which hires this service, turns a refusal or a failure into its own `reason`, and answers its hirer with a 200 result.');
  });
});

describe('specs/insurer-intake-agent.md: the receipt, the claim and the fault switch', () => {
  test('the receipt: the runtime signs it, its model is the model of the advert, and the intake record is the committed output', () => {
    const receipt = section('What the receipt commits to');
    expect(receipt).toContain('The service signs no receipt. The runtime builds and signs the receipt, and submits its hash in the Submit transaction.');
    expect(row(receipt, '`escrow_ref`')).toBe('| `escrow_ref` | the escrow UTxO, `<txid>#<index>` |');
    expect(row(receipt, '`supplier_pkh`')).toBe('| `supplier_pkh` | the key hash of the supplier key of the runtime |');
    expect(row(receipt, '`prompt_hash`')).toBe('| `prompt_hash` | sha256 of the UTF-8 bytes of the wire payload, as the buyer committed it in the escrow datum |');
    expect(row(receipt, '`response_hash`')).toBe('| `response_hash` | sha256 of the UTF-8 bytes of the intake record exactly as the service returned them |');
    // The model of a receipt is the model of its advert, and the manifest says so.
    expect(row(receipt, '`model`')).toBe(`| \`model\` | \`${PRIORAUTH_MODELS.intake}\` |`);
    expect(manifest.interface.notes.join('\n')).toContain(`The advert and every receipt name the model ${PRIORAUTH_MODELS.intake}. The receipt commits to the SHA-256 of the intake record as the service returns it.`);
    expect(row(receipt, '`prompt_tokens`, `completion_tokens`')).toBe('| `prompt_tokens`, `completion_tokens` | 0 and 0, the runtime counts none. The token counts of the model hire are in the sub-receipt under `decisions[0].inference.sub_job` |');
    expect(row(receipt, '`wallclock_ms`')).toBe('| `wallclock_ms` | how long the service call took |');
    expect(receipt).toContain(`the ${INTAKE_CHECKS.length} checks, and the completeness decision with its reasoning and the sub-receipt of the model supplier.`);
    expect(receipt).toContain('It does not commit to any coverage decision: the intake record is not one.');
    expect(receipt).toContain('The signature is Ed25519 over the canonical JSON of the receipt. The sha256 of the canonical JSON of `{ receipt, signature }` is the `result_receipt_hash` in the Submitted escrow datum.');
    // The answer is the intake record as JSON text, so `response_hash` is the hash of those bytes.
    expect(readFileSync(new URL('../src/serve/server.ts', import.meta.url), 'utf8')).toContain('serialize: (result) => JSON.stringify(result),');
  });

  test('the claim statements are the constants of the kit, the manifest holds the same three texts, and no source of the service stakes a claim', () => {
    const claim = section('Claim statements');
    expect(claim.split('\n').filter((line) => /^\| S[123] \|/.test(line))).toStrictEqual(INTAKE_CLAIM.statements.map((statement) => `| ${statement.id} | ${statement.text} |`));
    expect(manifest.behaviour.claim.statements).toStrictEqual(INTAKE_CLAIM.statements);
    expect(INTAKE_CLAIM.statements.map((statement) => statement.id)).toStrictEqual(['S1', 'S2', 'S3']);
    expect(claim).toContain(`The service stakes no claim: no code of the service calls the staking. Before a run, an operator command stakes a Module-1 claim for the agent with the service key: ${CLAIM_STAKE_LOVELACE / 1_000_000n} units, which is ${CLAIM_STAKE_LOVELACE} lovelace, with a challenge window of ${CLAIM_WINDOW_MS / 3_600_000} hours. After the window, the same command withdraws the claim when nobody challenged it.`);
    expect(claim).toContain('The claim has three statements. The manifest holds the same three texts in `behaviour.claim`, with no reference to a claim. A challenge names the text of a statement.');
    // No source of the service calls the staking of a run claim.
    const sourceDir = new URL('../src/', import.meta.url);
    const sources = readdirSync(sourceDir, { recursive: true, encoding: 'utf8' }).filter((file) => file.endsWith('.ts'));
    expect(sources.length).toBeGreaterThan(10);
    expect(sources.filter((file) => readFileSync(new URL(file, sourceDir), 'utf8').includes('stakeRunClaim'))).toStrictEqual([]);
    // The example environment sets the stake of a challenge, and it sets it once. A challenge targets a claim whose stake is not above that number, so a claim of 50 units is a target.
    expect(envExample.split('\n').filter((line) => line.startsWith('DISPUTE_CHALLENGE_STAKE_LOVELACE='))).toStrictEqual([`DISPUTE_CHALLENGE_STAKE_LOVELACE=${CLAIM_STAKE_LOVELACE}`]);
    // S2 is the statement that a wrong intake record breaks: the evidence of an intake record is about S2.
    expect(EVIDENCE_STATEMENTS.intake_record).toBe('S2');
    expect(INTAKE_CLAIM.statements[1].text).toBe('An intake record names the hash of the request this agent received.');
    expect(NOT_SHOWN_GAP).toContain('the challenge of the Prior Authorization Agent against this agent (this agent has no fault value)');
    expect(claim).toContain('S2 is the statement that a wrong intake record breaks. When the intake record names another hash than the hash of the request that the Prior Authorization Agent sent, that agent declines the delivery and challenges the claim of this agent on S2. No run covers that challenge, because this agent has no fault value (see Known gaps).');
  });

  test('the Fault switch says that the agent has none, the service stops at start for any value, and every intake record carries the empty text', async () => {
    const fault = section('Fault switch');
    expect(fault.split('\n')[1]).toBe('None. FAULT_MODE must be empty.');
    expect(FAULT_MODES['insurer-intake-agent']).toStrictEqual([]);
    expect(manifest.behaviour.fault_modes).toStrictEqual([]);
    expect(faultGap('insurer-intake-agent')).toBeNull();
    expect(faultOf({}).mode).toBe('');
    expect(faultOf({ FAULT_MODE: '' }).mode).toBe('');
    for (const value of ['alter_after_approval', 'anything']) expect(() => faultOf({ FAULT_MODE: value }), value).toThrow(/FAULT_MODE/);
    expect(envExample.split('\n')).toContain('FAULT_MODE=');
    // The value that the Prior Authorization Agent has makes it send a request that its hirer did not sign off, and the hook of this agent refuses that request with the code of the check of the digest.
    expect(FAULT_MODES['prior-authorization-agent']).toStrictEqual(['alter_after_approval']);
    expect(INTAKE_CHECKS[11]).toBe('approval_digest');
    expect(COUNTERPARTY_REFUSALS['insurer-intake-agent']).toContain('approval_digest_mismatch');
    // Every intake record carries the member `fault_mode` as its last member, and it is the empty text: the parser of the kit takes no other text.
    const record = await makeRig().run();
    expect(Object.keys(record).at(-1)).toBe('fault_mode');
    expect(record.fault_mode).toBe('');
    expect(parseIntakeRecord({ ...record, fault_mode: 'alter_after_approval' }).ok).toBe(false);
    expect(fault).toContain('The Insurer Intake Agent has no fault value. The service stops at start when `FAULT_MODE` has any value. The manifest lists no value in `behaviour.fault_modes`.');
    expect(fault).toContain('Each intake record carries the member `fault_mode`, and it is the empty text.');
    expect(fault).toContain('The Prior Authorization Agent has the fault value `alter_after_approval`, which makes it send a request that its hirer did not sign off. The Insurer Intake Agent refuses that request before its Claim (see What it checks before the Claim).');
  });
});

describe('specs/insurer-intake-agent.md: the operator, the data and the gaps', () => {
  const operator = section('Operator and data handling');

  test('Operator and data handling: the operator, the data sentences of the manifest, the five third parties, and the state of the service', () => {
    expect(manifest.operator.name).toBe('Apex Fusion Foundation');
    expect(operator).toContain('Operator: Apex Fusion Foundation. The contact is `operator.contact` in the manifest.');
    expect(operator).toContain(manifest.behaviour.data_handling);
    expect(operator).toContain('Every request is synthetic, and no patient exists behind any of it. Do not send a record of a real person to this agent while it is a demonstration.');
    const parties = tableRows(operator, '| Party | What it receives |');
    expect(parties.map((cells) => cells[0])).toStrictEqual(manifest.behaviour.third_parties);
    expect(parties).toHaveLength(5);
    // The state: the three entries of the state directory are the entries of the README, and the wiring makes them.
    const state = tableRows(operator, '| Path | What it holds |');
    expect(state).toStrictEqual(tableRows(readme.split('\n## State\n')[1] ?? '', '| Path | What it holds |'));
    expect(state.map((cells) => cells[0])).toStrictEqual([`\`keys/<key hash>/${STRANDED_FILE}\``, '`dispute/`', '`requests.json`']);
    const wiring = readFileSync(new URL('../src/serve/wiring.ts', import.meta.url), 'utf8');
    expect(wiring).toContain("join(config.stateDir, 'requests.json')");
    expect(wiring).toContain("join(config.stateDir, 'dispute')");
    expect(wiring).toContain("join(config.stateDir, 'keys', service.pkh)");
    expect(operator).toContain(`(\`INTAKE_STATE_DIR\`, which is \`${STATE_DIR_DEFAULT}\` in the image)`);
    expect(state[0][1]).toContain(`every ${JANITOR_INTERVAL_MS / 1000} s`);
    expect(state[2][1]).toContain(`It holds at most ${INTAKE_BOOK_LIMIT} entries and never drops one`);
    // The one file that the start fetches, and the services that the service calls.
    for (const name of ['VECTOR_MODULE1_MANIFEST', 'VECTOR_OGMIOS_URL', 'VECTOR_KOIOS_URL', 'VECTOR_SUBMIT_URL', 'VECTOR_MARKETPLACE_INDEXER_URL', 'IDENTITY_GATEWAY_URL']) expect(SETTINGS).toContain(name);
    expect(() => module1SourceOf({ VECTOR_MODULE1_MANIFEST: 'https://example.test/vector-agent-modules/main/manifest.json' })).toThrow('must be pinned to a commit');
    expect(module1SourceOf({ VECTOR_MODULE1_MANIFEST: `https://example.test/vector-agent-modules/${'ab'.repeat(20)}/manifest.json` })).toContain('ab'.repeat(20));
    expect(operator).toContain('At start the service fetches one file: the Module-1 deployment manifest, at an https address that a commit pins. It sends no data of a job there.');
    expect(operator).toContain('the node (Ogmios) and the Koios indexer');
  });

  test('what leaves the service: the request for the JWT-SVID, the two calls to the portal with the bearer credential, and the evidence of a challenge', async () => {
    const parties = tableRows(operator, '| Party | What it receives |').map((cells) => cells[1]);
    const rig = makeRig();
    await rig.run();
    // The gateway gets the DID of the sender in the hook, and in the job it gets a request for the JWT-SVID: a subject token and the audience of the tenant.
    expect(readFileSync(new URL('../../../packages/usecase-kit/src/checks/shared.ts', import.meta.url), 'utf8')).toContain('ports.gateway.resolve(sender)');
    const asked = rig.gateway.requests.filter((call) => call.path === '/spiffe/jwt-svid');
    expect(asked).toHaveLength(1);
    expect(Object.keys(JSON.parse(asked[0].body)).sort()).toStrictEqual(['audience', 'subject_token']);
    expect(parties[0]).toContain('the DID of the sender, in the hook. In the job, the request for the JWT-SVID: the DID of this agent, a subject token that the service key signs, and the audience, which is the insurer system of the tenant of the request.');
    expect(parties[0]).toContain('The job asks again when the first JWT-SVID is about to end');
    // The portal gets the service code in the read, and the whole authorization request with the status and the missing ids in the filing, and each call carries the JWT-SVID as the bearer credential.
    expect(rig.portal.calls.map((call) => call.headers.authorization)).toStrictEqual([`Bearer ${rig.issued[0]}`, `Bearer ${rig.issued[0]}`]);
    expect(rig.portal.calls[0]?.url.endsWith('/insurer/requirements/SYN-MRI-LS')).toBe(true);
    const filing = JSON.parse(posts(rig)[0]?.body ?? 'null');
    expect(Object.keys(filing)).toStrictEqual(['request', 'status', 'missing']);
    expect(filing.request).toStrictEqual(must(parsePriorAuthRequest(PRIOR_REQUEST)));
    expect(Object.keys(filing.request)).toHaveLength(14);
    expect(parties[2]).toContain('the service code, for the read of the requirements. For the filing: the whole authorization request, without the salt and without the approval, with the status and the ids of the missing requirements.');
    expect(parties[2]).toContain('Both calls present the JWT-SVID as the bearer credential');
    // The reads of the ledger name identifiers, key hashes and DIDs.
    expect(parties[1]).toContain('Each read names identifiers, key hashes and DIDs, and never a text of the request');
    // The model supplier gets the one input of the decision, and the evidence document of a challenge has the two digests and the references, and no text of the request and no salt.
    expect(parties[3]).toContain('one job: the instruction of the decision, six members of the request and the requirement set, and the reference of the escrow');
    const evidence = must(evidenceDocument({
      claim: `${'a5'.repeat(32)}#0`, claim_token: `636c6d5f${'b6'.repeat(28)}`, against_did: SENDER_DID, by_did: INSURER_DID, escrow_ref: ESCROW_REF, statement_text: PRIORAUTH_CLAIM.statements[0].text,
      kind: 'approval_digest', use_case: 'prior-authorization', approval: { attestation: ATTESTATION_ID, issuer_did: ISSUER_DID },
      mismatch: { ok: false, code: 'approval_digest_mismatch', detail: 'the digests differ', expected_digest: 'aa'.repeat(32), observed_digest: 'bb'.repeat(32) },
    }));
    expect(evidence.text).toContain(`Statement S1 of the claim reads: ${JSON.stringify(PRIORAUTH_CLAIM.statements[0].text)}`);
    expect(evidence.text).toContain(`The approval holds the digest ${'aa'.repeat(32)}.`);
    expect(evidence.text).toContain(`The request that the claimer sent holds the digest ${'bb'.repeat(32)}.`);
    expect(evidence.text).toContain('This evidence has no text of the request and no salt.');
    for (const reference of [`${'a5'.repeat(32)}#0`, `636c6d5f${'b6'.repeat(28)}`, SENDER_DID, INSURER_DID, ESCROW_REF, ATTESTATION_ID, ISSUER_DID]) expect(evidence.text, reference).toContain(reference);
    expect(evidence.text).not.toContain(String(PRIOR_REQUEST.justification));
    expect(evidence.text).not.toContain(SALT);
    expect(parties[4]).toContain('the evidence document (the statement S1 of the claim of the sender, the digest that the approval holds, the digest of the request that was sent, and the references of the claim, the two agents, the escrow and the approval; no text of the request and no salt) and the challenge');
  });

  test('What each decision receives: the names of the data block are the members of the input of the decision, the request leaves out its identifiers, and no text of a party reaches an instruction', async () => {
    const header = '| Decision | Data block | Left out |';
    const rows = tableRows(operator, header);
    expect(rows).toHaveLength(1);
    const [completeness] = rows;
    expect(completeness[0]).toBe('`completeness`');
    expect(COMPLETENESS_NAME).toBe('completeness');
    const namesOf = (cell: string): string[] => [...cell.matchAll(/`([a-z0-9_]+)`/g)].map((hit) => hit[1]);
    /** The names of the members of a JSON value, at every depth. */
    const memberNames = (value: unknown): Set<string> => {
      const names = new Set<string>();
      const walk = (node: unknown): void => {
        if (Array.isArray(node)) node.forEach(walk);
        else if (typeof node === 'object' && node !== null) for (const [name, member] of Object.entries(node)) { names.add(name); walk(member); }
      };
      walk(value);
      return names;
    };
    const request = must(parsePriorAuthRequest(PRIOR_REQUEST));
    const set = must(parseRequirementSet(REQUIREMENTS['SYN-MRI-LS']));
    const input = completenessInput(request, set) as { request: Record<string, unknown>; requirements: { service_code: string } };
    // The data block: the names of the page are the names of the input, as a set.
    expect(memberNames(input)).toStrictEqual(new Set(namesOf(completeness[1])));
    expect(memberNames(input).size).toBe(12);
    expect(Object.keys(input)).toStrictEqual(['request', 'requirements']);
    expect(Object.keys(input.request)).toStrictEqual(['ordering_clinician_ref', 'diagnosis_codes', 'justification', 'guideline_refs', 'record_refs', 'record_set_sha256']);
    expect(input.requirements.service_code).toBe(request.service_code);
    // The members that the input leaves out are the members that the page lists, but for the schema and the service code, which stands in the requirement set. The sender is a member of the handoff.
    const leftOut = namesOf(completeness[2]);
    const omitted = Object.keys(request).filter((name) => !(name in input.request));
    expect(omitted.filter((name) => !leftOut.includes(name))).toStrictEqual(['schema', 'service_code']);
    expect(leftOut.filter((name) => !omitted.includes(name))).toStrictEqual(['sender_did']);
    // The job gives the model this input and nothing else: the sender, the approval, the report and the checks stay out.
    const plain = makeRig();
    await plain.run();
    expect(plain.decideCalls[0]?.input).toStrictEqual(input);
    // A request with a marker in each member that the page leaves out: no marker reaches the prompt, and the six members of the data block do.
    const markers = {
      sender_did: `did:vector:${'c7'.repeat(32)}`, insurer_did: `did:vector:${'e9'.repeat(32)}`, advert_ref: `${'f8'.repeat(32)}#7`, patient_ref: 'MARKER-PATIENT-77', tenant: 'marker-tenant', order_id: 'MARKER-ORDER-77',
      request_number: 'MARKER-NUMBER-77',
    };
    const { sender_did: senderMarker, ...inRequest } = markers;
    const marked = handoffOf(priorRequest(inRequest), { sender_did: senderMarker });
    expect(Object.keys(markers).sort()).toStrictEqual([...leftOut].sort());
    const rig = makeRig();
    rig.kept.set(rig.context.escrowRef, recordFor(marked));
    await rig.run({ request: marked });
    const ids = set.requirements.map((requirement) => requirement.id);
    const prompt = must(buildPrompt(completenessDecision(ids), rig.decideCalls[0]?.input ?? null));
    for (const marker of Object.values(markers)) expect(prompt, marker).not.toContain(marker);
    const [instruction] = prompt.split(INPUT_OPEN);
    const block = prompt.slice(prompt.indexOf(INPUT_OPEN));
    for (const text of [request.justification, request.ordering_clinician_ref, request.record_set_sha256, ...request.diagnosis_codes, ...request.guideline_refs, ...request.record_refs, set.title, ...set.requirements.map((requirement) => requirement.text)]) {
      expect(block, text).toContain(text);
    }
    // The text of the justification and of the requirements stands in the marked data block, and in no other part of the prompt.
    for (const text of [request.justification, ...set.requirements.map((requirement) => requirement.text)]) expect(instruction, text).not.toContain(text);
    expect(operator).toContain('The text of the justification and of the requirements reaches the model only inside the marked data block, and never inside an instruction. The report of the attestations, the sender data and the 15 checks never reach the model.');
  });

  test('Known gaps: the ten sentences of the manifest, word for word and in order, with the sentence about the keys, the run-in lead of what no run shows, and no sentence about a fault switch', () => {
    const gaps = section('Known gaps');
    const lines = gaps.split('\n').filter((line) => line.startsWith('- '));
    expect(lines).toStrictEqual(gapsFor().map((gap) => `- ${gap}`));
    expect(manifest.gaps).toStrictEqual([...gapsFor()]);
    expect(lines).toHaveLength(10);
    expect(gaps).toContain('The manifest states these ten, in this order, word for word. A test keeps them equal to `gapsFor` in `agents/insurer-intake-agent/src/serve/gaps.ts`.');
    expect(gaps).toContain('The first eight are the gaps of the agent. The ninth says whose keys the parties are. The tenth starts with a run-in lead and names three things that no run of use case 2 (prior authorization) covers. The agent has no fault value, so the kit adds no sentence about a fault switch.');
    expect(faultGap('insurer-intake-agent')).toBeNull();
    // The ninth says that one operator holds the keys of the parties on one host.
    expect(lines[8]).toBe(`- ${KEYS_GAP}`);
    expect(KEYS_GAP).toBe('The controller key, the Accountable key and the guardian keys of this deployment are on one host of one operator, so a party is independent of the controller by key only.');
    // The tenth is the run-in lead of what no run shows, with its three things, and the page has the lead one time.
    expect(lines[9]).toBe(`- ${NOT_SHOWN_GAP}`);
    expect(NOT_SHOWN_GAP.startsWith('What this does not show: ')).toBe(true);
    expect(page.split('What this does not show:').length - 1).toBe(1);
    for (const item of ['the refund of the escrow of a revoked agent', 'a relying party that refuses a live token after its authority ended', 'the challenge of the Prior Authorization Agent against this agent']) expect(lines[9], item).toContain(item);
    expect(lines[9]).toContain('Tests alone cover the last two.');
    // The seventh says what the report does not check, and the sixth says that every request is synthetic.
    expect(lines[6]).toBe(`- ${BINDING_GAP}`);
    expect(lines[5]).toBe('- Every request is synthetic.');
  });
});
