// agents/insurer-intake-agent/test/spec.test.ts
// specs/insurer-intake-agent.md is the public page of the Insurer Intake Agent, and the manifest links to its Response heading. These tests hold the page to the code, to the manifest and to the deploy pack, table by
// table, so that they cannot part: the opening line, the status line and the changelog; the identity rows; the terms, the times and the limits; the 15 checks of the hook with their refusal codes; the steps of the job;
// the report of the attestations; the intake record; the errors; the claim; the gaps word for word; what the model receives; and the links. No test here uses the network.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { ACCEPT_WINDOW_MS } from '@vsa/buyer-core';
import { MAX_BODY, RESERVATION_MS } from '@vsa/service-kit';
import { PRIORAUTH_CAPABILITIES, PRIORAUTH_MODELS } from '@vsa/usecase-kit/priorauth';
import { ERROR_STATUS, MAX_REQUEST_BYTES, RUNTIME_BODY_LIMIT_BYTES } from '@vsa/usecase-kit/protocol';
import { blake2b224Hex } from '@vsa/vector-read';
import { CLAIM_STAKE_LOVELACE, CLAIM_WINDOW_MS } from '../../../scripts/operator/lib/claim-constants.ts';
import { COMPLETENESS_NAME } from '../src/job/index.ts';
import { READ_BUDGET_MS, REPORT_BUDGET_MS } from '../src/report/index.ts';
import { KEY_ROLES, keyClashOf } from '../src/serve/keys.ts';
import { STATUS_SINCE_DEFAULT, TEMPLATE_ENV, manifestFromEnv } from '../src/serve/manifest.ts';
import {
  BUYER_BOND_LOVELACE, CHECKS_READ_BUDGET_DEFAULT_MS, CHECKS_READ_BUDGET_MAX_MS, CHECKS_READ_BUDGET_MIN_MS, HOOK_READS, HOOK_READS_LIMIT_MS, JOB_DEADLINE_MS, MIN_PROCESSING_WINDOW_MS, PORT_DEFAULT,
  PRICE_DEFAULT_LOVELACE, RUNTIME_PRECHECK_WAIT_MS, SUPPLIER_BOND_LOVELACE, checksReadBudgetOf, priceOf, supplierKeyOf,
} from '../src/serve/settings.ts';
import { SETTINGS } from '../src/serve/start.ts';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const page = readFileSync(new URL('../../../specs/insurer-intake-agent.md', import.meta.url), 'utf8');
const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
const section = (heading: string): string => (page.split(`\n## ${heading}\n`)[1] ?? '').split('\n## ')[0];
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
