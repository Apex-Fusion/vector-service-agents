// agents/prior-authorization-agent/test/spec.test.ts
// specs/prior-authorization-agent.md is the public page of the agent, and the manifest links to its Response section. These tests hold the page to the code and to the deploy pack, table by table, so that the two
// cannot part: the status, the identity rows, the numbers of the terms and the windows, the request limit, the request fields of the schema that the manifest publishes, the example requests and the example result
// (made here with the kit), the errors with their statuses, the reasons that the two jobs write (each list is read from the code, and the page must list the whole set), the claim statements, the gap sentences
// word for word, what each model decision receives, and the files that the page links.
// The tests read the page, the manifest, the env example, the compose file of the pack and some source files, and no network.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { parse } from 'yaml';
import { ACCEPT_WINDOW_MS } from '@vsa/buyer-core';
import { isRuntimeRefusal } from '@vsa/hire-kit';
import { MAX_BODY, RESERVATION_MS } from '@vsa/service-kit';
import { CONFIRMATIONS_REQUIRED, GATEWAY_FAILURES, SUB_DELEGATION_FAILURES, tokenTarget } from '@vsa/usecase-kit/access';
import {
  BAD_DOCUMENT, COUNTERPARTY_REFUSED, EARLIER_PAY_MAY_LAND, INCONSISTENT_OUTCOME, INTERRUPTION_REASONS, PAY_UNCONFIRMED, VAULT_REASON_MISSING, checkAuthority, checkRuntimeBody, checkWirePayload, completedResult,
  disputedResult, failedResult, findLiveVault, proposedResult, refusedResult, vaultRefusedResult,
} from '@vsa/usecase-kit/buyer';
import type { LedgerReads } from '@vsa/usecase-kit/buyer';
import { COSIGN_SETTINGS, COSIGN_STATUS, parseAllowlist, parseCosignSettings } from '@vsa/usecase-kit/cosign';
import { HIRE_MIN_MS } from '@vsa/usecase-kit/decision';
import { readFaultSwitch, withFaultMode } from '@vsa/usecase-kit/fault';
import {
  ATTESTATION_STATES, INTAKE_CHECKS, INTAKE_CLAIM, MAX_JUSTIFICATION_CHARS, PRIORAUTH_CAPABILITIES, PRIORAUTH_MODELS, PRIORAUTH_REQUEST_SCHEMA, parseGuideline, parseIntakeRecord, parsePriorAuthRequest,
  parseRecordSet, recordSetSha256, requestNumberOf,
} from '@vsa/usecase-kit/priorauth';
import {
  COSIGN_ROUTE, COSIGN_RULE, COUNTERPARTY_REFUSALS, ERROR_STATUS, EXECUTE_OUTCOMES, EXIT_STATES, MAX_REQUEST_BYTES, PROPOSE_OUTCOMES, RECEIPT_CHECKS, RUNTIME_BODY_LIMIT_BYTES, canonicalJson, checkRequestSize,
  exitStateOf, makeProposal, parseProposal, parseRequest,
} from '@vsa/usecase-kit/protocol';
import type { Decision, ExecuteOutcome, ExecuteResult, HandoffRecord, JsonObject, ProtocolResult, ReceiptVerification, SubJob, WriteRecord } from '@vsa/usecase-kit/protocol';
import { EVIDENCE_FAILURES } from '../src/evidence/index.ts';
import { MOCK_CODES } from '../src/evidence/subread.ts';
import { NOT_ACCEPTED } from '../src/execute/decision.ts';
import { EXECUTE_REASONS, JOB_DEADLINE_MS as EXECUTE_DEADLINE_MS } from '../src/execute/index.ts';
import { INSURER_FAILURES, readInsurer } from '../src/insurer/index.ts';
import type { SupplierRow } from '../src/insurer/index.ts';
import { ACCEPT_DECISION, justificationDecision, parseProposeFields } from '../src/model/index.ts';
import { ID_RULE } from '../src/model/intake.ts';
import { PROPOSE_DEADLINE_MS, PROPOSE_FAILURES } from '../src/propose/index.ts';
import { REQUEST_SCHEMA, STATUS_SINCE_DEFAULT, TEMPLATE_ENV, manifestFromEnv } from '../src/serve/manifest.ts';
import { RequestError, parseJob } from '../src/serve/server.ts';
import {
  BUYER_BOND_LOVELACE, JOB_DEADLINE_MS, MIN_PROCESSING_WINDOW_MS, PRICE_DEFAULT_LOVELACE, SUPPLIER_BOND_LOVELACE, priceOf, processingWindowOf, supplierKeyOf,
} from '../src/serve/settings.ts';
import { SETTINGS } from '../src/serve/start.ts';

const root = new URL('../../../', import.meta.url);
const text = (path: string): string => readFileSync(new URL(path, root), 'utf8');
const page = text('specs/prior-authorization-agent.md');
const readme = text('agents/prior-authorization-agent/README.md');
const runbook = text('deploy/server/RUNBOOK-prior-authorization-agent.md');
const envExample = text('deploy/server/.env.prior-authorization-agent.example');
const compose = parse(text('deploy/server/docker-compose.prior-authorization-agent.yml')) as { services: { runtime: { environment: Record<string, string> } } };
const runtimeEnv = compose.services.runtime.environment;

const section = (heading: string): string => (page.split(`\n## ${heading}\n`)[1] ?? '').split('\n## ')[0];
const row = (table: string, label: string): string => table.split('\n').find((line) => line.startsWith(`| ${label} |`)) ?? '';
const envLine = (name: string): string | undefined => envExample.split('\n').find((line) => line.startsWith(`${name}=`))?.substring(name.length + 1);
const manifest = manifestFromEnv({ ...TEMPLATE_ENV });

/** The text of a source from the end of `head` to the next `end`. */
function declared(path: string, head: string, end: string): string {
  const source = text(path);
  const start = source.indexOf(head);
  if (start < 0) throw new Error(`${path} has no ${head}`);
  return source.substring(start + head.length, source.indexOf(end, start + head.length));
}
/** A whole number that the settings of the Insurer Intake Agent export under `name`, written in digits with underscores. */
const intakeNumber = (name: string): number => Number(declared('agents/insurer-intake-agent/src/serve/settings.ts', `export const ${name} = `, ';').replaceAll('_', ''));

/** The day of the page. The status line of the page and of its entry in the list of pages hold it, and it is the default date of the status in the manifest. */
const PAGE_DATE = '2026-11-24';
const STATUS_LINE = `PROPOSED (built, not deployed). Since ${PAGE_DATE}.`;

describe('specs/prior-authorization-agent.md: the frame, the identity and the terms', () => {
  test('the opening line, the capability, the model string and the status are the manifest and the pack', () => {
    expect(page.startsWith('# Prior Authorization Agent\n')).toBe(true);
    expect(manifest.name).toBe('Prior Authorization Agent');
    expect(page.split('\n')[2]).toBe(`Capability \`${manifest.capability_id}\`. ${manifest.description}`);
    expect(manifest.capability_id).toBe(PRIORAUTH_CAPABILITIES.draft);
    expect(section('Capability id').split('\n')[1]).toBe(`\`${manifest.capability_id}\``);
    expect(PRIORAUTH_MODELS.draft).toBe('prior-authorization-agent-v1');
    expect(section('Capability id')).toContain(`The model string in the advert and in every receipt is \`${PRIORAUTH_MODELS.draft}\`.`);
    expect(row(runbook, 'Prior Authorization')).toContain(`| \`${PRIORAUTH_MODELS.draft}\` |`);
    // One constant pins the date of the page and the default date of the manifest.
    expect(STATUS_SINCE_DEFAULT).toBe(PAGE_DATE);
    expect(manifest.status).toStrictEqual({ chip: 'proposed', since: PAGE_DATE });
    expect(STATUS_LINE.startsWith(`${manifest.status.chip.toUpperCase()} (`)).toBe(true);
    expect(section('Status').split('\n')).toContain(STATUS_LINE);
    expect(section('Status')).toContain('\nNothing on this page is LIVE or DEPLOYED.\n');
    expect(section('Status')).toContain('The agent has no registry record, no advert and no job yet.');
    expect(section('Status')).toContain('It is the buyer-side agent of use case 2 (prior authorization).');
  });

  test('the runtime and the service: one runtime in front, seven keys in the service, no API key, and a check before the Claim', () => {
    const capability = section('Capability id');
    expect(runtimeEnv.CAPABILITY_KIND).toBe('custom');
    expect(capability).toContain('`CAPABILITY_KIND=custom`');
    expect(runtimeEnv.SERVICE_PRECHECK_URL.endsWith('/precheck')).toBe(true);
    expect(capability).toContain('The runtime claims the escrow, asks the service whether to take the job, calls the service, signs the receipt and submits its hash.');
    const keys = SETTINGS.filter((name) => name.endsWith('_PRIV_KEY_HEX'));
    expect(keys).toHaveLength(7);
    expect(capability).toContain('It holds seven keys and no API key of any third party.');
    expect(SETTINGS.filter((name) => name.includes('API'))).toStrictEqual([]);
    expect(keys).not.toContain('SUPPLIER_PRIV_KEY_HEX');
    expect(capability).toContain('It does not hold the supplier key: it knows only its key hash and its public key.');
    // The compose file blanks each of the seven keys for the runtime, so that the runtime never holds one.
    for (const name of keys) expect(runtimeEnv[name], name).toBe('');
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
    expect(manifest.keys.buyer_pkh).toBe(TEMPLATE_ENV.PRIORAUTH_SERVICE_PKH);
    const delegation = row(identity, 'Delegation keys');
    expect(delegation.startsWith('| Delegation keys | two keys,')).toBe(true);
    expect(delegation).toContain('`keys.delegation_pkhs`');
    expect(manifest.keys.delegation_pkhs).toHaveLength(2);
    // The two subagents and their four keys are the other four of the seven.
    const subagents = row(identity, 'Subagents');
    expect(subagents).toContain('which are the other four keys of the service');
    for (const name of ['RECORD_READER_DID', 'DRAFTER_DID']) {
      expect(subagents).toContain(`\`${name}\``);
      expect(SETTINGS).toContain(name);
    }
    expect(SETTINGS.filter((name) => /^(RECORD_READER|DRAFTER)_/.test(name) && name.endsWith('_PRIV_KEY_HEX'))).toHaveLength(4);
    // The organisation is a domain with the description of the demonstration.
    expect(row(identity, 'Organisation')).toBe('| Organisation | the domain `echo.vector.apexfusion.org`, with the description "Demonstration organisation run by the Apex Fusion Foundation". The identity gateway verifies the domain with a DNS TXT record |');
    expect(row(identity, 'Parties')).toContain('Guardians: the guardian key of the organisation and a controller key of this deployment, with threshold 2');
    expect(row(identity, 'Reputation stake')).toBe('| Reputation stake | a Module-3 self-stake on the capability, owned by the service key |');
    expect(row(identity, 'Claim')).toBe('| Claim | a Module-1 claim that an operator command stakes with the service key before a run. The service stakes none. See Claim statements |');
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

  test('the other limits of the Terms table: the request, the justification, the sub-delegations, the model calls, the one job at a time and the reservation', () => {
    const terms = section('Terms');
    const limits = manifest.terms.input_limits;
    expect(limits).toStrictEqual({ request_bytes: MAX_REQUEST_BYTES, order_id_chars: 64, tenant_chars: 48, justification_chars: MAX_JUSTIFICATION_CHARS });
    expect(row(terms, 'Request')).toBe(`| Request | at most ${limits.request_bytes} bytes of request JSON; \`order_id\` 1 to ${limits.order_id_chars} characters; \`tenant\` 1 to ${limits.tenant_chars} characters |`);
    expect(MAX_JUSTIFICATION_CHARS).toBe(4_000);
    expect(row(terms, 'Justification')).toBe(`| Justification | at most ${MAX_JUSTIFICATION_CHARS} characters |`);
    expect(CONFIRMATIONS_REQUIRED).toBe(30);
    expect(row(terms, 'Sub-delegations')).toBe(`| Sub-delegations | each of the two subagents gets its token after ${CONFIRMATIONS_REQUIRED} confirmations of its sub-delegation |`);
    expect([justificationDecision({ record_ids: [], criterion_ids: [] }).name, ACCEPT_DECISION.name]).toStrictEqual(['justification', 'accept_delivery']);
    expect(row(terms, 'Model calls')).toBe('| Model calls | at most one in `propose` (decision `justification`) and at most one in `execute` (decision `accept_delivery`) |');
    expect(ERROR_STATUS.busy).toBe(409);
    expect(row(terms, 'Jobs at a time')).toBe('| Jobs at a time | one: a second job gets 409 `busy` |');
    expect(row(terms, 'Reservation')).toBe(`| Reservation | a go from \`POST /precheck\` reserves the job slot for ${RESERVATION_MS / 1000} s |`);
  });

  test('the request limit is 900000 bytes of request JSON, it is safe only below the 1 MiB limit of the runtime on the escaped body, and the largest request of the agent is far below it', () => {
    const terms = section('Terms');
    expect([MAX_REQUEST_BYTES, RUNTIME_BODY_LIMIT_BYTES, MAX_BODY]).toStrictEqual([900_000, 1_048_576, 1_000_000]);
    for (const part of [
      'The service counts the request JSON in bytes of UTF-8, and it refuses a request JSON of more than 900000 bytes with `request_too_large` (400). It reads at most 1000000 bytes of wire payload.',
      'The wire payload carries the request JSON as a string inside a one-message array (see Interface).',
      'The limit of 900000 bytes is safe only below the 1 MiB limit of the runtime, 1048576 bytes, on the escaped body.',
      'A request JSON under 900000 bytes can give a body above 1048576 bytes, and the runtime refuses that body. A sender keeps the body of its call at or below 1048576 bytes.',
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
    // The largest request of the agent is an `execute` request with every member of its authorization request at its limit: 4000 code points of four bytes each, 50 and 20 references of 64 characters, 8 diagnosis codes of 16.
    const ids = (count: number, tag: string): string[] => Array.from({ length: count }, (_, index) => `${tag}${String(index).padStart(2, '0')}${'r'.repeat(61)}`);
    const parsed = parsePriorAuthRequest({
      schema: 'vector.usecase.priorauth-request.v1', request_number: requestNumberOf('t'.repeat(48), 999_999_999_999_999), tenant: 't'.repeat(48), order_id: 'o'.repeat(64), patient_ref: 'p'.repeat(64),
      ordering_clinician_ref: 'c'.repeat(64), service_code: 's'.repeat(64), diagnosis_codes: Array.from({ length: 8 }, () => 'd'.repeat(16)), justification: '\u{1D49C}'.repeat(MAX_JUSTIFICATION_CHARS),
      guideline_refs: ids(20, 'g'), record_refs: ids(50, 'r'), record_set_sha256: 'a'.repeat(64), insurer_did: `did:vector:${'b'.repeat(64)}`, advert_ref: `${'c'.repeat(64)}#9999`,
    });
    if (!parsed.ok) throw new Error(parsed.detail);
    const proposal = makeProposal(parsed.value, 'd'.repeat(64));
    if (!proposal.ok) throw new Error(proposal.detail);
    const largest = JSON.stringify({
      op: 'execute', authority: { principal_did: `did:vector:${'e'.repeat(64)}`, delegation: 'f'.repeat(64) }, tenant: 't'.repeat(48), proposal: proposal.value,
      approval: { attestation: '1'.repeat(64), issuer_did: `did:vector:${'e'.repeat(64)}` },
    });
    expect(codeOf(largest)).toBe('accepted');
    expect(Buffer.byteLength(largest)).toBeGreaterThan(20_000);
    expect(Buffer.byteLength(largest)).toBeLessThan(30_000);
    expect(terms).toContain('The largest request of this agent is an `execute` request with every member of its authorization request at its limit, and it has under 30000 bytes. So a request of this agent stays far below both limits.');
  });

  test('the economics: what the supplier receives, the window to accept, the vault of the hirer, the Insurer Intake Agent and the fees', () => {
    const terms = section('Terms');
    expect(ACCEPT_WINDOW_MS).toBe(600_000);
    // The vault pays the advert of the Insurer Intake Agent: its price and both of its bonds are 4 units.
    const intake = [intakeNumber('PRICE_DEFAULT_LOVELACE'), intakeNumber('SUPPLIER_BOND_LOVELACE'), intakeNumber('BUYER_BOND_LOVELACE')];
    expect(intake).toStrictEqual([2_000_000, 1_000_000, 1_000_000]);
    expect(intake[0] + intake[1] + intake[2]).toBe(4_000_000);
    for (const part of [
      'A hire of either operation locks the price and both bonds, 5 units.',
      "On Accept the supplier receives the price and the supplier bond, and the buyer's bond returns to the buyer.",
      `If the buyer does not accept within ${ACCEPT_WINDOW_MS / 1000} s of the supplier's Submit, the supplier may Release the escrow and take the price and both bonds.`,
      'If the supplier never submits, the buyer reclaims after `deliver_by`.',
      'The job `execute` also pays the Insurer Intake Agent from the vault of the hirer: the vault pays the price and both bonds of the advert of the Insurer Intake Agent, 4 units, and the value limit of the delegation caps that payment.',
      'The delegation key of the agent pays the fees of that Pay and of the Accept.',
    ]) expect(terms, part).toContain(part);
  });

  test('the README of the agent gives the same limits as the page', () => {
    expect(readme).toContain('900000 bytes');
    expect(readme).toContain(`${JOB_DEADLINE_MS} ms`);
    expect(readme).toContain(`${MIN_PROCESSING_WINDOW_MS} ms`);
  });
});

// ---- The examples of the page: a request, a decision, a proposal and the results of execute, made with the kit from labels -----------------------------------------------------------------------------

/** A hex text made from a label: no reference, hash or key of an example belongs to an escrow, a supplier or a key. */
const made = (label: string, algorithm = 'sha256'): string => createHash(algorithm).update(`prior authorization agent example: ${label}`).digest('hex');
const didOf = (label: string): string => `did:vector:${made(label)}`;

/** The value of an accepted result. A refusal stops the test, and its detail names the field. */
function must<T, C extends string>(result: ProtocolResult<T, C>): T {
  if (!result.ok) throw new Error(result.detail);
  return result.value;
}

const TENANT = 'demo';
const MODEL = 'deepseek/deepseek-v4-flash';
const GOLDEN = 'packages/usecase-kit/test/priorauth/golden/';
const SET_JSON = JSON.parse(text(`${GOLDEN}record-set.json`)) as JsonObject;
const RECORD_SET = must(parseRecordSet(SET_JSON));
const GUIDELINE = must(parseGuideline(JSON.parse(text(`${GOLDEN}guideline.json`))));
const INTAKE_JSON = JSON.parse(text(`${GOLDEN}intake-record.json`)) as JsonObject;
const { order } = RECORD_SET;
const HIRER = didOf('the hirer');
const INSURER = didOf('the Insurer Intake Agent');
const AUTHORITY = { principal_did: HIRER, delegation: made('the delegation') };
const PROPOSE_REQUEST = { op: 'propose', authority: AUTHORITY, tenant: TENANT, order_id: order.order_id, insurer_did: INSURER };
/** What the model chooses for the order of the golden record set: the justification, and the criteria and the records that it cites. */
const CHOICE = {
  justification: [
    'Criterion C1 is met. The progress notes REC-0002 and REC-0005 record low back pain with pain in the left leg, and the pain continues at 7 weeks.',
    'Criterion C2 is met. The records REC-0003 and REC-0004 document naproxen for 4 weeks and 6 sessions of physical therapy, with little change.',
    'Criterion C3 is met. The progress note REC-0005 documents new numbness in the left foot and weakness of ankle dorsiflexion.',
    'Criterion C4 is met. The imaging record REC-0001 lists a plain X-ray of the lumbar spine.',
  ].join('\n'),
  guideline_refs: ['C1', 'C2', 'C3', 'C4'],
  record_refs: ['REC-0001', 'REC-0002', 'REC-0003', 'REC-0004', 'REC-0005'],
};
const DOCUMENT = must(parsePriorAuthRequest({
  schema: PRIORAUTH_REQUEST_SCHEMA, request_number: requestNumberOf(TENANT, 1), tenant: TENANT, order_id: order.order_id, patient_ref: order.patient_ref, ordering_clinician_ref: order.ordering_clinician_ref,
  service_code: order.service_code, diagnosis_codes: [...order.diagnosis_codes], justification: CHOICE.justification, guideline_refs: CHOICE.guideline_refs, record_refs: CHOICE.record_refs,
  record_set_sha256: recordSetSha256(RECORD_SET), insurer_did: INSURER, advert_ref: `${made('the advert of the Insurer Intake Agent')}#0`,
}));
const SALT = made('the salt');
const PROPOSAL = must(makeProposal(DOCUMENT, SALT));
const EXECUTE_REQUEST = { op: 'execute', authority: AUTHORITY, tenant: TENANT, proposal: PROPOSAL, approval: { attestation: made('the approval'), issuer_did: HIRER } };

const MODEL_ESCROW = `${made('the escrow of the model')}#0`;
const MODEL_SUPPLIER = made('the key of the model supplier').substring(0, 56);
const SUB_JOB: SubJob = {
  capability_id: 'llm.text.generate.v1', advert_ref: `${made('the advert of the model')}#0`, escrow_ref: MODEL_ESCROW, supplier_pkh: MODEL_SUPPLIER,
  receipt: {
    escrow_ref: MODEL_ESCROW, supplier_pkh: MODEL_SUPPLIER, prompt_hash: made('the prompt'), response_hash: made('the answer'), model: MODEL, prompt_tokens: 1180, completion_tokens: 64, wallclock_ms: 2310,
  },
  receipt_signature: made('the signature of the model supplier', 'sha512'),
  verification: Object.fromEntries(RECEIPT_CHECKS.map((check) => [check, true])) as ReceiptVerification,
};
const DECISION: Decision = {
  name: 'justification',
  choice: CHOICE,
  reasoning: 'Each of the four criteria of the guideline is met by a record of the set, so the request cites the four criteria and the five records.',
  inference: { path: 'marketplace', sub_job: SUB_JOB, accepted: 'confirmed' },
};
const FAULT = readFaultSwitch('prior-authorization-agent', '');
const PROPOSED = withFaultMode(FAULT, proposedResult(DOCUMENT, { use_case: 'prior-authorization', decisions: [DECISION], sub_jobs: [SUB_JOB], fault_mode: '' }, SALT));

const ACCEPT: Decision = {
  name: 'accept_delivery',
  choice: { accept: true, mismatch: [] },
  reasoning: 'The hash in the intake record is the hash of the request that was sent.',
  inference: { path: 'marketplace', sub_job: SUB_JOB, accepted: 'confirmed' },
};
const INTAKE_ESCROW = `${made('the escrow of the intake')}#0`;
const HANDOFF: HandoffRecord = {
  counterparty_did: INSURER, advert_ref: DOCUMENT.advert_ref, escrow_ref: INTAKE_ESCROW, paid_from_vault: true,
  receipt: { escrow_ref: INTAKE_ESCROW, supplier_pkh: made('the key of the Insurer Intake Agent').substring(0, 56), agent_did: INSURER },
  receipt_signature: made('the signature of the Insurer Intake Agent', 'sha512'), verification: SUB_JOB.verification, result: INTAKE_JSON, accepted: 'confirmed',
};
const WRITE: WriteRecord = { system: 'records', route: 'POST /records/orders/{order_id}/submission', status: 201, ref: 'SUB-0001' };
const CHALLENGE = { claim: `${made('the claim')}#0`, evidence: made('the evidence'), challenge: `${made('the challenge')}#0` };
const PIECES = { use_case: 'prior-authorization', proposal_digest: PROPOSAL.proposal_digest, handoff: HANDOFF, writes: [WRITE], decisions: [ACCEPT], fault_mode: '' } as const;
/** One result of execute for each outcome. A dispute holds a hire whose Accept was not made. */
const RESULTS: Record<ExecuteOutcome, ExecuteResult> = {
  completed: completedResult(PIECES),
  vault_refused: vaultRefusedResult({ ...PIECES, handoff: null, writes: [] }, 'the node refused the Pay', false),
  refused_by_counterparty: refusedResult('counterparty', { ...PIECES, handoff: null, writes: [] }, 'not_for_this_insurer'),
  refused_by_system: refusedResult('system', { ...PIECES, writes: [] }, 'duplicate_submission'),
  disputed: disputedResult({ ...PIECES, handoff: { ...HANDOFF, accepted: 'no' }, writes: [] }, { challenge: CHALLENGE }),
  failed: failedResult({ ...PIECES, writes: [] }, 'deadline'),
};

const sub = (heading: string): string => (page.split(`\n### ${heading}\n`)[1] ?? '').split(/\n##+ /)[0];
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
/** The cells of each row of the table that starts with `header`. */
function rowsOf(body: string, header: string): string[][] {
  const lines = body.split('\n');
  const at = lines.indexOf(header);
  if (at < 0) throw new Error(`no table has the header ${header}`);
  const rows: string[][] = [];
  for (let index = at + 2; index < lines.length && lines[index].startsWith('| '); index += 1) rows.push(lines[index].substring(2, lines[index].length - 2).split(' | '));
  return rows;
}
/** The names in single quotes of a piece of source text. */
const quoted = (piece: string): string[] => [...piece.matchAll(/'([a-z][a-z_]*)'/g)].map((hit) => hit[1]);
/** The members of the type `export type <name> = 'a' | 'b';` of a source. */
const unionOf = (path: string, name: string): string[] => quoted(declared(path, `export type ${name} = `, ';'));
/** The first group of each match of `pattern` in a source. */
const callsIn = (path: string, pattern: RegExp): string[] => [...text(path).matchAll(pattern)].map((hit) => hit[1]);

/**
 * The reasons that each job writes for a result that is not a proposal or a recorded submission, read from the code. `propose` writes the codes of its own list, the codes of the evidence (its own codes, the
 * seven codes of a mock system that it passes on, and the two prefixed lists), and the reasons of the model decision of the kit. `execute` writes the codes of its own list `EXECUTE_REASONS`, the constants of the
 * buyer flow, the codes of the checks before the Pay, and the codes of the hire kit. The codes of the sub-delegation and of the token are two lists of the access folder, written with a prefix: the page names them as
 * two prefixes, and the list of the job holds them apart from its own codes.
 */
function reasonsOfJobs(): { readonly propose: ReadonlySet<string>; readonly execute: ReadonlySet<string> } {
  const kit = 'packages/usecase-kit/src/';
  const prefixed = [...SUB_DELEGATION_FAILURES.map((code) => `sub_delegation_${code}`), ...GATEWAY_FAILURES.map((code) => `token_${code}`)];
  const hireKit = unionOf('packages/hire-kit/src/hire.ts', 'HireFailure');
  const decision = [
    ...hireKit.map((code) => `llm_${code}`),
    ...unionOf(`${kit}decision/answer.ts`, 'AnswerFault'),
    ...['decide', 'limits', 'prompt', 'spec'].flatMap((file) => callsIn(`${kit}decision/${file}.ts`, /refused\('(bad_[a-z]+)'/g)),
    ...callsIn(`${kit}decision/decide.ts`, /failure\('[a-z_]+', '([a-z_]+)'/g),
    ...callsIn(`${kit}decision/decide.ts`, /new HireEnded\('([a-z_]+)'/g),
  ];
  if (!prefixed.every((code) => EVIDENCE_FAILURES.includes(code))) throw new Error('the codes of the evidence do not hold the two prefixed lists');
  if (!INSURER_FAILURES.every((code) => PROPOSE_FAILURES.includes(code))) throw new Error('the codes of propose do not hold the codes of the reader of the insurer');
  const own = [...PROPOSE_FAILURES, ...EVIDENCE_FAILURES].filter((code) => !prefixed.includes(code));
  const execute = [
    ...EXECUTE_REASONS, COUNTERPARTY_REFUSED, EARLIER_PAY_MAY_LAND, PAY_UNCONFIRMED, ...Object.values(INTERRUPTION_REASONS),
    ...unionOf(`${kit}buyer/vault.ts`, 'VaultRefusal'), ...unionOf(`${kit}buyer/advert.ts`, 'AdvertRefusal'), ...callsIn(`${kit}buyer/hire.ts`, /failure\('([a-z_]+)'/g),
    ...hireKit,
  ];
  return { propose: new Set([...own, ...decision]), execute: new Set(execute) };
}

describe('specs/prior-authorization-agent.md, Interface', () => {
  const request = sub('Request');
  const response = sub('Response');

  test('the request fields: each member of the schema is on the page, and the intake holds the rules of the field tables', () => {
    const [propose, execute] = REQUEST_SCHEMA.oneOf;
    expect(Object.keys(propose.properties)).toStrictEqual(['op', 'authority', 'tenant', 'order_id', 'insurer_did']);
    expect(Object.keys(execute.properties)).toStrictEqual(['op', 'authority', 'tenant', 'proposal', 'approval']);
    for (const field of ['op', 'authority', 'principal_did', 'delegation', 'tenant', 'order_id', 'insurer_did', 'proposal', 'document', 'salt', 'proposal_digest', 'approval', 'attestation', 'issuer_did']) {
      expect(request, field).toContain(`\`${field}\``);
    }
    // The intake of the service: a request is taken, or it is refused with `bad_shape` (400) before any job runs.
    const takes = (body: unknown): boolean => {
      try {
        parseJob(JSON.stringify(body));
        return true;
      } catch (error) {
        if (error instanceof RequestError && error.code === 'bad_shape' && error.status === 400) return false;
        throw error;
      }
    };
    const proposeOk = (over: Record<string, unknown>): boolean => takes({ ...PROPOSE_REQUEST, ...over });
    const executeOk = (over: Record<string, unknown>): boolean => takes({ ...EXECUTE_REQUEST, ...over });
    expect(proposeOk({})).toBe(true);
    expect(request).toContain(ID_RULE);
    expect([proposeOk({ order_id: 'a'.repeat(64) }), proposeOk({ order_id: 'a'.repeat(65) }), proposeOk({ order_id: '' }), proposeOk({ order_id: '.a' }), proposeOk({ order_id: 'a b' }), proposeOk({ order_id: 'A-1_2.3' })])
      .toStrictEqual([true, false, false, false, false, true]);
    // The tenant has one rule in both operations. The kit takes a longer tenant with upper-case letters, and the intake of the service refuses it.
    expect(['a'.repeat(48), 'a'.repeat(49), 'Demo', '-a', 'a-1'].map((tenant) => [proposeOk({ tenant }), executeOk({ tenant })])).toStrictEqual([[true, true], [false, false], [false, false], [false, false], [true, true]]);
    expect(parseRequest({ ...EXECUTE_REQUEST, tenant: 'Demo' }).ok).toBe(true);
    expect(request).toContain('The rule of the tenant holds for both operations: a tenant outside it is refused with `bad_shape` (400). `execute` also checks the tenant against its authorization request (`request_not_for_tenant`).');
    expect([proposeOk({ insurer_did: 'nope' }), proposeOk({ extra: 1 }), proposeOk({ op: 'cancel' }), proposeOk({ authority: { principal_did: HIRER } })]).toStrictEqual([false, false, false, false]);
    expect([executeOk({}), executeOk({ approval: null })]).toStrictEqual([true, true]);
    expect([executeOk({ proposal: { ...PROPOSAL, proposal_digest: made('another digest') } }), executeOk({ extra: 1 }), executeOk({ approval: { attestation: made('only the attestation') } })]).toStrictEqual([false, false, false]);
    const { approval: _left, ...withoutApproval } = EXECUTE_REQUEST;
    expect(takes(withoutApproval)).toBe(false);
    expect(request).toContain('The authority has no vault: the agent finds the Live vault of the delegation itself.');
    expect(request).toContain('The agent does not check the approval. It passes it on, and the Insurer Intake Agent refuses a request with no valid approval.');
    expect(request).toContain(`The agent must have exactly one Active advert for \`${PRIORAUTH_CAPABILITIES.intake}\`.`);
    // Hex is lower case: a hex text in upper case is refused.
    expect(request).toContain('A hex text is lower case: a hex text in upper case breaks a rule.');
    const upper = (hex: string): string => hex.toUpperCase();
    expect([
      proposeOk({ authority: { ...AUTHORITY, delegation: upper(AUTHORITY.delegation) } }),
      proposeOk({ authority: { ...AUTHORITY, principal_did: `did:vector:${upper(made('the hirer'))}` } }),
      proposeOk({ insurer_did: `did:vector:${upper(made('the Insurer Intake Agent'))}` }),
      executeOk({ proposal: { ...PROPOSAL, salt: upper(SALT) } }),
      executeOk({ approval: { attestation: upper(made('the approval')), issuer_did: HIRER } }),
    ]).toStrictEqual([false, false, false, false, false]);
    expect(request).toContain('`delegation`: the identifier of the delegation that names this agent as its delegate, 64 lower-case hex characters.');
    expect(request).toContain('`salt` (64 lower-case hex characters) and `proposal_digest` (64 lower-case hex characters)');
    expect(request).toContain('`attestation`, the identifier of the approval (64 lower-case hex characters), and `issuer_did`, the DID of its issuer (`did:vector:` and 64 lower-case hex characters)');
  });

  test('the examples of the requests are what the kit makes, the kit parses them, and the intake of the service takes them', () => {
    expect(jsonBlocks(request)).toHaveLength(2);
    const [proposeBlock, executeBlock] = jsonBlocks(request);
    expect(proposeBlock).toBe(JSON.stringify(PROPOSE_REQUEST, null, 2));
    expect(executeBlock).toBe(JSON.stringify(EXECUTE_REQUEST, null, 2));
    expect(must(parseRequest(JSON.parse(proposeBlock), parseProposeFields))).toStrictEqual(PROPOSE_REQUEST);
    expect(must(parseRequest(JSON.parse(executeBlock)))).toStrictEqual(EXECUTE_REQUEST);
    expect(parseJob(proposeBlock).op).toBe('propose');
    expect(parseJob(executeBlock).op).toBe('execute');
    const { proposal } = JSON.parse(executeBlock) as typeof EXECUTE_REQUEST;
    expect(must(parseProposal(proposal))).toStrictEqual(PROPOSAL);
    expect(must(parsePriorAuthRequest(proposal.document))).toStrictEqual(DOCUMENT);
    // The digest is the sha256 of the 32 bytes of the salt and the canonical JSON of the document.
    expect(createHash('sha256').update(Buffer.from(proposal.salt, 'hex')).update(must(canonicalJson(proposal.document)), 'utf8').digest('hex')).toBe(proposal.proposal_digest);
    expect(request).toContain('The digest is the sha256 of the 32 bytes of the salt and the canonical JSON of the document.');
    // The two requests are a few kilobytes: far below the limits of Terms.
    for (const block of [proposeBlock, executeBlock]) expect(Buffer.byteLength(block)).toBeLessThan(6_000);
  });

  test('the steps of propose and execute: the codes that they name are codes of the jobs, and each source that a step reads is the one that the step says', async () => {
    const { propose, execute } = reasonsOfJobs();
    const named = (code: string): void => expect(request, code).toContain(`\`${code}\``);
    for (const code of [
      'ledger_unavailable', 'delegation_not_found', 'delegation_key_unknown', 'insurer_not_listed', 'insurer_unavailable', 'sub_delegation_not_ended', 'record_set_mismatch', 'guideline_mismatch',
      'bad_document', 'model_output_invalid', 'decision_mismatch',
    ]) {
      named(code);
      expect(propose.has(code), `propose writes ${code}`).toBe(true);
    }
    for (const code of [
      'request_not_for_tenant', 'bad_document', 'no_live_vault', 'several_live_vaults', 'advert_not_counterparty', 'advert_unavailable', 'intake_record_invalid', 'intake_not_for_request', 'decision_failed', 'token_failed',
      'mock_system_failed', 'counterparty_refused', 'send_lost', 'ledger_unavailable', 'delegation_key_unknown',
    ]) {
      named(code);
      expect(execute.has(code), `execute writes ${code}`).toBe(true);
    }
    // A refusal of the service and the outcome of a refused Pay are no reason of a result: the Errors table and the Outcomes table hold them.
    for (const code of ['delegation_not_mine', 'bad_shape', 'request_too_large', 'vault_refused']) {
      named(code);
      expect([propose.has(code), execute.has(code)], code).toStrictEqual([false, false]);
    }
    expect([ERROR_STATUS.delegation_not_mine, ERROR_STATUS.bad_shape, ERROR_STATUS.request_too_large]).toStrictEqual([400, 400, 400]);
    // Step 3 of `propose`: the reader of the insurer. It gives one advert, or `insurer_not_listed`, or `insurer_unavailable`.
    expect(INSURER_FAILURES).toStrictEqual(['insurer_not_listed', 'insurer_unavailable']);
    expect([PRIORAUTH_CAPABILITIES.intake, PRIORAUTH_MODELS.intake]).toStrictEqual(['health.priorauth.intake.v1', 'insurer-intake-agent-v1']);
    expect(request).toContain('The indexer lists exactly one Active advert of that agent for the capability `health.priorauth.intake.v1`, and the chain shows that advert unspent and Active, with that capability, the model `insurer-intake-agent-v1` and the insurer as its agent.');
    const insurerId = INSURER.slice('did:vector:'.length);
    const listed = (number: number): SupplierRow => ({ utxo_ref: `${made(`advert ${number}`)}#0`, capability_id: PRIORAUTH_CAPABILITIES.intake, advert_status: 'Active', agent_id: insurerId });
    interface OnChain { spent: boolean; agentId: string; advert: { status: string; capability_id: string; model: string } }
    const onChain: OnChain = { spent: false, agentId: insurerId, advert: { status: 'Active', capability_id: PRIORAUTH_CAPABILITIES.intake, model: PRIORAUTH_MODELS.intake } };
    const reading = async (rows: readonly SupplierRow[], read: () => Promise<OnChain>): Promise<string> => {
      const answer = await readInsurer({ listAdverts: async () => rows, readAdvert: read, clock: () => 0 }, INSURER);
      return answer.ok ? 'ok' : answer.code;
    };
    expect(await Promise.all([
      reading([listed(1)], async () => onChain), reading([], async () => onChain), reading([listed(1), listed(2)], async () => onChain), reading([listed(1)], async () => ({ ...onChain, spent: true })),
      reading([listed(1)], async () => ({ ...onChain, advert: { ...onChain.advert, status: 'Retired' } })), reading([listed(1)], async () => ({ ...onChain, advert: { ...onChain.advert, model: 'another-model' } })),
      reading([listed(1)], async () => ({ ...onChain, agentId: made('another agent') })), reading([listed(1)], async () => { throw new Error('the chain is down'); }),
    ])).toStrictEqual(['ok', 'insurer_not_listed', 'insurer_not_listed', 'insurer_not_listed', 'insurer_not_listed', 'insurer_not_listed', 'insurer_not_listed', 'insurer_unavailable']);
    expect(request).toContain("No advert, two adverts, and an advert that is spent, retired or another agent's end the job with `insurer_not_listed`. A source that cannot be read ends it with `insurer_unavailable`.");
    // Step 4 of `propose`: the two reads, their routes, their actions and their resources.
    const bases = { publicBase: 'https://mock.example', mtlsBase: 'https://mtls.example' };
    const records = must(tokenTarget(bases, TENANT, 'records.order', { order_id: order.order_id }));
    const guidelines = must(tokenTarget(bases, TENANT, 'guidelines.read', { code: order.service_code }));
    const submission = must(tokenTarget(bases, TENANT, 'records.submission', { order_id: order.order_id }));
    expect([records.action, guidelines.action, submission.action]).toStrictEqual(['record.read', 'guideline.read', 'priorauth.submit']);
    expect([records.method, guidelines.method, submission.method]).toStrictEqual(['GET', 'GET', 'POST']);
    expect([records.callers, guidelines.callers, submission.callers]).toStrictEqual(['agent-or-subagent', 'agent-or-subagent', 'agent']);
    expect([records.url, guidelines.url, submission.url]).toStrictEqual([
      `${bases.publicBase}/t/${TENANT}/records/orders/${order.order_id}`, `${bases.publicBase}/t/${TENANT}/guidelines/${order.service_code}`, `${bases.publicBase}/t/${TENANT}/records/orders/${order.order_id}/submission`,
    ]);
    for (const route of ['GET /t/<tenant>/records/orders/<order_id>', 'GET /t/<tenant>/guidelines/<service_code>', 'POST /t/<tenant>/records/orders/<order_id>/submission']) expect(request, route).toContain(`\`${route}\``);
    expect(CONFIRMATIONS_REQUIRED).toBe(30);
    expect(request).toContain('It waits for 30 confirmations.');
    const evidence = text('agents/prior-authorization-agent/src/evidence/read.ts');
    expect(evidence.indexOf('await readRecords(')).toBeGreaterThan(-1);
    expect(evidence.indexOf('await readRecords(')).toBeLessThan(evidence.indexOf('await readGuideline('));
    expect(evidence).toContain("if (records.end === 'not_ended') return failedRead(deps, 'record-reader', 'sub_delegation_not_ended');");
    expect(evidence).toContain('const guideline = await readGuideline(deps, request, run, serviceCode);');
    const proposing = text('agents/prior-authorization-agent/src/propose/propose.ts');
    expect(proposing).toContain("if (checked.code === 'ledger_unavailable') return failed('authority', 'ledger_unavailable');");
    expect(proposing).toContain("if (keyHash.value === null) return failed('paying_key', 'delegation_not_found');");
    expect(proposing).toContain("if (order.order_id !== orderId) return failed('evidence', 'record_set_mismatch');");
    expect(proposing).toContain("if (guideline.value.code !== order.service_code) return failed('evidence', 'guideline_mismatch');");
    // Step 6 of `propose`: the parser of the decision checks the shape and the two closed sets of references, and it does not check the text.
    const justification = justificationDecision({ record_ids: RECORD_SET.records.map((record) => record.record_id), criterion_ids: GUIDELINE.criteria.map((criterion) => criterion.id) });
    expect(justification.parse(CHOICE).ok).toBe(true);
    expect([
      justification.parse({ ...CHOICE, record_refs: ['REC-9999'] }).ok, justification.parse({ ...CHOICE, guideline_refs: ['C9'] }).ok, justification.parse({ ...CHOICE, record_refs: ['REC-0001', 'REC-0001'] }).ok,
      justification.parse({ ...CHOICE, justification: 'x'.repeat(MAX_JUSTIFICATION_CHARS + 1) }).ok, justification.parse({ ...CHOICE, justification: ' ' }).ok, justification.parse({ ...CHOICE, extra: 1 }).ok,
    ]).toStrictEqual([false, false, false, false, false, false]);
    expect(justification.parse({ justification: 'Every criterion is met.', guideline_refs: [], record_refs: [] }).ok).toBe(true);
    expect(request).toContain('The service checks the shape of the answer and that each reference names a criterion or a record that the agent read, each at most one time (`model_output_invalid` otherwise). It does not check that the text is true, or that it cites the references.');
    // Step 2 of `execute`: a delegation that the ledger does not show does not stop the job. The authority check lets it pass, the job goes on with the first delegation key, and the search for the Live vault ends with `no_live_vault`.
    const unseen: LedgerReads = { delegation: async () => null, liveVaults: async () => ({ refs: [], complete: true }) };
    expect(await checkAuthority(unseen, didOf('the Prior Authorization Agent'), made('the delegation'))).toStrictEqual({ ok: true, delegation: 'not_found' });
    expect(await findLiveVault(unseen, made('the delegation'), 0)).toMatchObject({ ok: false, code: 'no_live_vault' });
    const executing = text('agents/prior-authorization-agent/src/execute/execute.ts');
    expect(executing).toContain('if (hash === null) return { ok: true, entry: deps.delegationKeys.first };');
    expect(request).toContain('A delegation that the ledger does not show does not stop the job. The job goes on with the first delegation key of the agent, and it ends with `no_live_vault` in step 4.');
    // Step 5 of `execute`: the refusals of the Insurer Intake Agent are 403 codes, and a refusal that no rule makes is the code when the protocol lists it, and `counterparty_refused` otherwise.
    for (const code of COUNTERPARTY_REFUSALS['insurer-intake-agent']) expect([code, (ERROR_STATUS as Record<string, number>)[code]], code).toStrictEqual([code, 403]);
    expect([COUNTERPARTY_REFUSED, ERROR_STATUS.bad_shape, ERROR_STATUS.busy]).toStrictEqual(['counterparty_refused', 400, 409]);
    expect(Object.hasOwn(ERROR_STATUS, 'precheck_timeout')).toBe(false);
    expect([[500, 'internal'], [502, 'bad_gateway'], [503, 'check_unavailable']].map(([status, code]) => isRuntimeRefusal({ status: Number(status), code: String(code) }))).toStrictEqual([false, false, false]);
    expect(['precheck_unreachable', 'precheck_timeout', 'precheck_failed'].map((code) => isRuntimeRefusal({ status: 503, code }))).toStrictEqual([true, true, true]);
    expect([isRuntimeRefusal({ status: 400, code: 'bad_shape' }), isRuntimeRefusal({ status: 409, code: 'busy' })]).toStrictEqual([true, true]);
    expect(request).toContain('When the request fails a check, the Insurer Intake Agent refuses with a 403 and a code, and the result is `refused_by_counterparty` with that code.');
    expect(request).toContain('Any other refusal before the Claim is a `failed` result. Its reason is the code of the answer when the protocol lists it, such as `bad_shape` (400) or `busy` (409), and `counterparty_refused` otherwise. A send that does not end in a clear refusal is `failed` with `send_lost`, because the Insurer Intake Agent may hold the escrow. A status of 500 or more is such an end. The exception is a 503 answer with `precheck_unreachable`, `precheck_timeout` or `precheck_failed`: the runtime says that it could not ask its service, and the reason is `counterparty_refused`.');
    // Step 6 of `execute`: eight checks on the receipt, and two checks in code that the model never sees.
    expect(RECEIPT_CHECKS).toHaveLength(8);
    expect(request).toContain('It runs the eight checks on the receipt of the Insurer Intake Agent.');
    expect([NOT_ACCEPTED.invalid, NOT_ACCEPTED.notForRequest, NOT_ACCEPTED.declined, NOT_ACCEPTED.failed]).toStrictEqual(['intake_record_invalid', 'intake_not_for_request', 'declined_by_model', 'decision_failed']);
    // Step 7: the model compares two hashes, and the agent accepts exactly when `mismatch` is empty. A model that accepts against the hashes is a failed decision, and the decision never reads the status of the record.
    expect([
      ACCEPT_DECISION.parse({ accept: true, mismatch: [] }).ok, ACCEPT_DECISION.parse({ accept: false, mismatch: ['request_sha256'] }).ok, ACCEPT_DECISION.parse({ accept: true, mismatch: ['request_sha256'] }).ok,
      ACCEPT_DECISION.parse({ accept: false, mismatch: [] }).ok,
    ]).toStrictEqual([true, true, false, false]);
    const judging = text('agents/prior-authorization-agent/src/execute/decision.ts');
    expect(judging).toContain('if (read.accept && record.request_sha256 !== sent.request_sha256) return failed(CHOICE_AGAINST_HASHES);');
    expect(judging).not.toContain('record.status');
    expect(request).toContain('A model that accepts while the two hashes differ gives `decision_failed`, and the agent accepts nothing.');
    // Step 8: the Accept comes before the write of the submission, with the three members of the intake record that the write names.
    expect(executing).toContain("case 'completed': return completed(job, step);");
    expect(executing).toContain('const body = { request_number: record.request_number, intake_id: record.intake_id, status: record.status };');
    expect(request).toContain('The Accept comes before the write, so no end of the write undoes it. Two ends are `failed`: `token_failed` when the agent gets no token for the write, and `mock_system_failed` when the call ends in any other way.');
    // Step 9: the challenge is against the second statement of the claim of the Insurer Intake Agent.
    expect(INTAKE_CLAIM.statements[1].text).toBe('An intake record names the hash of the request this agent received.');
    expect(text('agents/prior-authorization-agent/src/execute/dispute.ts')).toContain('statement_text: INTAKE_CLAIM.statements[1].text');
  });

  test('the Response example is the result that the kit makes of the request, the decision and the sub-job, byte for byte', () => {
    expect(page.match(/^### Response$/gm)).toHaveLength(1);
    expect(manifest.interface.response_schema.$ref.endsWith('/specs/prior-authorization-agent.md#response')).toBe(true);
    expect(jsonBlocks(response)[0]).toBe(JSON.stringify(PROPOSED, null, 2));
  });

  test('the proposal: the table names its members in the order of the result, the example holds them, and fault_mode is last and empty', () => {
    const shown = JSON.parse(jsonBlocks(response)[0]) as Record<string, unknown>;
    const keys = Object.keys(shown);
    // The proposal that the example result holds is a proposal for the kit: its digest is the digest of its document and its salt, and its document is an authorization request.
    const { document, salt, proposal_digest: digest } = shown as { document: unknown; salt: unknown; proposal_digest: unknown };
    expect(must(parseProposal({ document, salt, proposal_digest: digest }))).toStrictEqual(PROPOSAL);
    expect(must(parsePriorAuthRequest(document))).toStrictEqual(DOCUMENT);
    expect(keys).toStrictEqual(['schema', 'use_case', 'decisions', 'sub_jobs', 'document', 'salt', 'proposal_digest', 'outcome', 'exit_state', 'reason', 'fault_mode']);
    expect(namesOf(firstCells(response, '| Member | Content |'))).toStrictEqual(keys);
    expect(keys.at(-1)).toBe('fault_mode');
    expect(shown).toMatchObject({ schema: 'vector.usecase.proposal.v1', use_case: 'prior-authorization', outcome: 'proposed', exit_state: null, reason: null, fault_mode: '' });
    expect(PROPOSE_OUTCOMES).toStrictEqual(['proposed', 'failed']);
    expect((shown.decisions as Decision[])[0].inference.sub_job).toStrictEqual((shown.sub_jobs as SubJob[])[0]);
    expect(Object.keys(SUB_JOB)).toStrictEqual(['capability_id', 'advert_ref', 'escrow_ref', 'supplier_pkh', 'receipt', 'receipt_signature', 'verification']);
    expect(Object.keys(SUB_JOB.verification)).toStrictEqual([...RECEIPT_CHECKS]);
    expect(MODEL).toBe(manifest.behaviour.model.allowlist[0]);
    expect(response).toContain('The example is an illustration and not a recorded run. Its references, hashes, key hash and signature are made from labels, and they belong to no escrow, no supplier and no key.');
  });

  test('the record set of the example hashes to the record_set_sha256 of the request, and the request copies the order from the set', () => {
    const canonical = must(canonicalJson(SET_JSON));
    expect(createHash('sha256').update(canonical, 'utf8').digest('hex')).toBe(DOCUMENT.record_set_sha256);
    expect(recordSetSha256(RECORD_SET)).toBe(DOCUMENT.record_set_sha256);
    expect([DOCUMENT.order_id, DOCUMENT.patient_ref, DOCUMENT.ordering_clinician_ref, DOCUMENT.service_code, DOCUMENT.diagnosis_codes]).toStrictEqual([
      order.order_id, order.patient_ref, order.ordering_clinician_ref, order.service_code, order.diagnosis_codes,
    ]);
    expect(DOCUMENT.request_number).toBe(requestNumberOf(TENANT, 1));
    expect(RECORD_SET.records).toHaveLength(5);
    expect(response).toContain('The record set of the example is the synthetic order `ORD-1001` with its five records. The `record_set_sha256` of the request is the sha256 of the canonical JSON of that set.');
  });

  test('the authorization request: the table names its members in order, the limits of its lists are the kit, and the number is the tenant and a counter', () => {
    const members = Object.keys(DOCUMENT);
    expect(members).toStrictEqual([
      'schema', 'request_number', 'tenant', 'order_id', 'patient_ref', 'ordering_clinician_ref', 'service_code', 'diagnosis_codes', 'justification', 'guideline_refs', 'record_refs', 'record_set_sha256', 'insurer_did',
      'advert_ref',
    ]);
    expect(namesOf(firstCells(response, '| Document member | Content |'))).toStrictEqual(members);
    expect(DOCUMENT.schema).toBe(PRIORAUTH_REQUEST_SCHEMA);
    // The first row `schema` of the section is the one of the proposal table, so the row of the document is read from its own table.
    expect(rowsOf(response, '| Document member | Content |').find((cells) => cells[0] === '`schema`')?.[1]).toBe('`vector.usecase.priorauth-request.v1`');
    expect(row(response, '`request_number`')).toBe('| `request_number` | the tenant, a hyphen and a counter that the service keeps for each tenant |');
    const taken = (over: Record<string, unknown>): boolean => parsePriorAuthRequest({ ...DOCUMENT, ...over }).ok;
    const ids = (count: number): string[] => Array.from({ length: count }, (_, index) => `ID-${index}`);
    expect([taken({ guideline_refs: ids(20) }), taken({ guideline_refs: ids(21) }), taken({ record_refs: ids(50) }), taken({ record_refs: ids(51) }), taken({ guideline_refs: ['C1', 'C1'] }), taken({ record_refs: [] })])
      .toStrictEqual([true, false, true, false, false, true]);
    expect([taken({ diagnosis_codes: Array(8).fill('M54.16') }), taken({ diagnosis_codes: Array(9).fill('M54.16') }), taken({ diagnosis_codes: [] }), taken({ diagnosis_codes: ['x'.repeat(16)] }), taken({ diagnosis_codes: ['x'.repeat(17)] })])
      .toStrictEqual([true, false, false, true, false]);
    expect([taken({ justification: 'x'.repeat(MAX_JUSTIFICATION_CHARS) }), taken({ justification: 'x'.repeat(MAX_JUSTIFICATION_CHARS + 1) }), taken({ justification: '' })]).toStrictEqual([true, false, false]);
    expect(row(response, '`patient_ref`, `ordering_clinician_ref`')).toBe('| `patient_ref`, `ordering_clinician_ref` | the synthetic references of the order. The service copies them from the order, and the model never writes them |');
    expect(row(response, '`service_code`, `diagnosis_codes`')).toBe('| `service_code`, `diagnosis_codes` | those of the order. `diagnosis_codes` has 1 to 8 codes of 1 to 16 characters |');
    expect(row(response, '`justification`')).toBe('| `justification` | the text that the model wrote, 1 to 4000 characters |');
    expect(row(response, '`guideline_refs`')).toBe('| `guideline_refs` | the ids of the criteria of the guideline that the justification cites: at most 20, none twice. Each id is a criterion that the agent read |');
    expect(row(response, '`record_refs`')).toBe('| `record_refs` | the ids of the records that the justification cites: at most 50, none twice. Each id is a record that the agent read |');
    expect(row(response, '`record_set_sha256`')).toBe('| `record_set_sha256` | the sha256 of the canonical JSON of the record set that `record-reader` read: the order and its records |');
    expect(response).toContain('The service checks the shape of the justification and the references. It does not check that the text is true: the model writes it, and the hirer reads it before the approval.');
  });

  test('the result of execute: the table names the members of every outcome, and the members of the three records are on the page', () => {
    const names = namesOf(firstCells(response, '| Result member | Content |')).sort();
    for (const [outcome, result] of Object.entries(RESULTS)) {
      const stamped = withFaultMode(FAULT, result);
      expect(Object.keys(stamped).sort(), outcome).toStrictEqual(names);
      expect(Object.keys(stamped).at(-1), outcome).toBe('fault_mode');
      expect(result.outcome, outcome).toBe(outcome);
      expect(result.use_case, outcome).toBe('prior-authorization');
    }
    for (const [label, record] of [['handoff', HANDOFF], ['writes', WRITE], ['challenge', CHALLENGE]] as const) {
      for (const member of Object.keys(record)) expect(row(response, `\`${label}\``), `${label}.${member}`).toContain(`\`${member}\``);
    }
    // `accepted` has four values. The compiler checks that the list is the whole type.
    const ACCEPTED = ['confirmed', 'pending', 'no', null] as const satisfies readonly HandoffRecord['accepted'][];
    const ACCEPTED_ARE_LISTED: [Exclude<HandoffRecord['accepted'], (typeof ACCEPTED)[number]>] extends [never] ? true : never = true;
    expect(ACCEPTED_ARE_LISTED).toBe(true);
    expect(row(response, '`handoff`')).toContain('`accepted` (`confirmed`, `pending`, `no` or `null`)');
    // The one write of a clean run is the submission to the records system, with the system and the route that the job writes.
    const executing = text('agents/prior-authorization-agent/src/execute/execute.ts');
    expect(executing).toContain("const RECORDS_SYSTEM = 'records';");
    expect(executing).toContain("const SUBMISSION_ROUTE = 'POST /records/orders/{order_id}/submission';");
    expect(executing).toContain('const SUBMISSION_RECORDED = 201;');
    expect(row(response, '`writes`')).toBe('| `writes` | each call that changed the records system, with `system`, `route`, `status` and `ref`. The one write of a clean run is the submission |');
  });

  test('the intake record under handoff.result: the table names its members in order, the 15 checks and the four words are the kit, and the status is not judged', () => {
    const record = must(parseIntakeRecord(INTAKE_JSON));
    const members = Object.keys(INTAKE_JSON);
    expect(members).toStrictEqual(['schema', 'outcome', 'request_number', 'request_sha256', 'status', 'missing', 'intake_id', 'sender', 'approval', 'attestations', 'checks', 'decisions', 'fault_mode']);
    expect(Object.keys(record)).toStrictEqual(members);
    expect(namesOf(firstCells(response, '| Intake record member | Content |'))).toStrictEqual(members);
    expect(INTAKE_CHECKS).toHaveLength(15);
    expect(Object.keys(record.checks)).toStrictEqual([...INTAKE_CHECKS]);
    expect(row(response, '`checks`')).toBe('| `checks` | the 15 checks of the Insurer Intake Agent, each one `true`: a record exists only for a request that passed all of them |');
    expect([...ATTESTATION_STATES]).toStrictEqual(['valid', 'invalid', 'absent', 'unreadable']);
    expect(Object.keys(record.attestations)).toStrictEqual(['provenance', 'software', 'principal_binding']);
    expect(row(response, '`attestations`')).toBe('| `attestations` | what the Insurer Intake Agent found about the sender: `provenance`, `software` and `principal_binding`, each one `valid`, `invalid`, `absent` or `unreadable`. It reports them and never refuses a job for them |');
    expect(row(response, '`status`, `missing`')).toContain('`complete` with no missing requirement, or `incomplete` with the ids of 1 to 20 requirements');
    expect(row(response, '`request_sha256`')).toContain('the sha256 of the canonical JSON of the request that it received, with no salt');
    expect(row(response, '`outcome`')).toContain('| `outcome` | `done`.');
    expect(record.fault_mode).toBe('');
    expect(response).toContain('The agent does not judge `status`: it accepts a record whose hash is right, `complete` or `incomplete`, and it writes the status to the records system.');
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
    expect(['approval_digest_mismatch', 'approval_expired', 'delegation_ended', 'not_for_this_insurer'].map((reason) => state('refused_by_counterparty', reason))).toStrictEqual(['Escalated', 'Expired', 'Cancelled', 'Rejected']);
    expect(['approval_digest_mismatch', 'approval_expired', 'delegation_ended', 'duplicate_submission'].map((reason) => state('refused_by_system', reason))).toStrictEqual(['Rejected', 'Expired', 'Cancelled', 'Rejected']);
    expect([state('disputed', null, true), state('disputed', 'no_open_claim')]).toStrictEqual(['Escalated', 'Failed']);
    expect(state('failed', 'deadline')).toBe('Failed');
    expect(row(outcomes, '`completed`')).toContain('| `Completed` |');
    expect(row(outcomes, '`vault_refused`')).toContain('| `Cancelled` when the hirer ended the delegation, else `Failed` |');
    expect(VAULT_REASON_MISSING).toBe('vault_reason_missing');
    expect(row(outcomes, '`vault_refused`')).toContain('The `reason` is the text that the node or the builder gave, cut short, or `vault_reason_missing` when it gave none |');
    expect(row(outcomes, '`refused_by_counterparty`')).toContain('| `Rejected`, but `Escalated` for `approval_digest_mismatch`, `Expired` for `approval_expired` and `Cancelled` for `delegation_ended` |');
    expect(row(outcomes, '`refused_by_system`')).toContain('| `Rejected`, but `Expired` for `approval_expired` and `Cancelled` for `delegation_ended` |');
    expect(row(outcomes, '`disputed`')).toContain('| `Escalated` when the agent filed a challenge, else `Failed` |');
    expect(row(outcomes, '`failed`')).toContain('| `Failed` |');
    expect(outcomes).toContain('A `propose` job ends with `proposed` or with `failed`, and a proposal has no exit state.');
  });

  test('the Errors table gives each code the status of the kit and is the table of the README, the answers with no message are the ones of the service kit, and the README holds no reason code', () => {
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
    expect(pairs.map((pair) => pair.split(':')[1])).toStrictEqual(['bad_wire', 'request_too_large', 'bad_shape', 'bad_context', 'delegation_not_mine', 'unauthorized', 'not_found', 'busy', 'shutting_down', 'internal']);
    expect(errors).toContain('A call that the service refuses has the body `{ "error": "<code>", "message": "<words>" }`, with the status of the first table. Four answers carry the code only, with no `message`: the 401, the 404, the 409 of a job, and a 500 for an error that the service does not name. The 409 of `POST /precheck` has a `message`. A refusal with a status of 500 or more gets fixed words, and the whole message is in the log. A job that the service runs and that does not end well is no HTTP error: it is a 200 result with the outcome `failed` and a `reason` code.');
    // The service kit writes the four answers with the code only, and the 409 of the hook and a refusal of 500 or more with a message.
    const server = text('packages/service-kit/src/server.ts');
    for (const answer of [
      "return send(401, { error: 'unauthorized' });", "return send(404, { error: 'not_found' });", "if (taken === 'busy') return send(409, { error: 'busy' });", "return send(500, { error: 'internal' });",
      "return send(409, { error: 'busy', message: BUSY_TEXT });", 'return send(refusal.status, { error: refusal.code, message: operatorsText(refusal.code) });',
    ]) expect(server, answer).toContain(answer);
    // The README says that a job failure is a 200 result and it lists no reason: the reasons of the jobs, but the codes of the two HTTP tables, stand in no backticks of the README.
    const { propose, execute } = reasonsOfJobs();
    const http = new Set([...pairs, ...codePairs(sub('The co-sign route'))].map((pair) => pair.split(':')[1]));
    const reasons = [...new Set([...propose, ...execute])].filter((code) => !http.has(code));
    const ticked = [...readme.matchAll(/`([^`]+)`/g)].map((hit) => hit[1]);
    expect(reasons.length).toBeGreaterThan(50);
    for (const code of reasons) expect(ticked, `the reason ${code} in the README`).not.toContain(code);
  });

  test('the reasons table lists each code that a job writes and the job that writes it: the set is the set that the code gives, and the prefixes and the class are the ones of the code', () => {
    const errors = sub('Errors');
    const { propose, execute } = reasonsOfJobs();
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
    expect(expected.size).toBeGreaterThan(60);
    expect([...written].sort()).toStrictEqual([...expected].sort());
    expect(errors).toContain('The next table lists each code that a job writes as the `reason` of a result that is not a proposal and not a recorded submission. The column Job says which job writes it: `propose`, `execute` or both. The other outcomes have their own reasons: see Outcomes. One row stands for a class of codes and not for one code: a code of the protocol, which the use case kit lists.');
    expect([...new Set(written.values())].sort()).toStrictEqual(['both', 'execute', 'propose']);
    // `inference_failed` is the error code of a failed decision of the kit. No job writes it as a reason: the reason is the code of the hire kit with a prefix, or another code of the decision.
    expect(written.has('inference_failed')).toBe(false);
    // The two prefixes: the codes after them are the two lists of the access folder, and the job writes each of them with its prefix.
    const cell = (first: string): string[] => rows.find((cells) => cells[0] === first) ?? [];
    expect(namesOf([cell('`sub_delegation_<code>`')[2]])).toStrictEqual([...SUB_DELEGATION_FAILURES]);
    expect(namesOf([cell('`token_<code>`')[2]])).toStrictEqual([...GATEWAY_FAILURES]);
    expect(EVIDENCE_FAILURES).toEqual(expect.arrayContaining([...SUB_DELEGATION_FAILURES.map((code) => `sub_delegation_${code}`), ...GATEWAY_FAILURES.map((code) => `token_${code}`)]));
    expect([cell('`sub_delegation_<code>`')[1], cell('`token_<code>`')[1]]).toStrictEqual(['`propose`', '`propose`']);
    // The seven codes of a mock system that a read passes on stand in two rows, and every other code of a mock system is `mock_system_failed`.
    const passed = rows.flatMap((cells) => namesOf([cells[0]]).filter((code) => (MOCK_CODES as readonly string[]).includes(code)));
    expect(passed.sort()).toStrictEqual([...MOCK_CODES].sort());
    expect(MOCK_CODES).toHaveLength(7);
    expect(cell('`mock_system_failed`')[2]).toContain('one of the seven codes that pass through');
    // The class of a code of the protocol: the Insurer Intake Agent refused before its Claim with no rule, and the code is in the list of the kit.
    expect(cell('a code of the protocol')[1]).toBe('`execute`');
    expect(cell('a code of the protocol')[2]).toContain('such as `bad_shape` (400) or `busy` (409)');
    expect(cell('`counterparty_refused`')[2]).toContain('the protocol does not list the code of its answer');
    // The 60 seconds of `llm_out_of_time`, and the log that holds the code of a decision on the delivery that fails.
    expect(HIRE_MIN_MS).toBe(60_000);
    expect(cell('`llm_out_of_time`, `hire_threw`')[2]).toContain(`less than ${HIRE_MIN_MS / 1000} s were left`);
    expect(text('agents/prior-authorization-agent/src/execute/decision.ts')).toContain('deps.note(`execute: the decision accept_delivery failed (${code})`);');
    // The interrupted hire, the unconfirmed Pay and the challenge that stops with an error.
    expect([INTERRUPTION_REASONS.decision_error, INTERRUPTION_REASONS.other, PAY_UNCONFIRMED, BAD_DOCUMENT, INCONSISTENT_OUTCOME]).toStrictEqual(['decision_error', 'hire_interrupted', 'pay_unconfirmed', 'bad_document', 'inconsistent_outcome']);
    expect(EXECUTE_REASONS).toContain('port_error');
    expect(text('agents/prior-authorization-agent/src/execute/execute.ts')).toContain('return disputedResult(pieces, { reason: PORT_ERROR });');
    expect(cell('`port_error`')[2]).toContain('It is the `reason` of a `disputed` result that holds no challenge');
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
      expect(Number(status), pair).toBe((COSIGN_STATUS as Record<string, number>)[code]);
    }
    // The handler of the kit answers 405 to a method that is not POST. The service registers the route for POST only, so any other method gets the 404 of the service, and the page lists no 405.
    expect(COSIGN_STATUS.method_not_allowed).toBe(405);
    expect(pairs.map((pair) => pair.split(':')[1]).sort()).toStrictEqual(Object.keys(COSIGN_STATUS).filter((code) => code !== 'method_not_allowed').sort());
    expect(text('agents/prior-authorization-agent/src/serve/server.ts')).toContain("methods: ['POST']");
    expect(text('packages/service-kit/src/routes.ts')).toContain("if (method === 'POST') return route.post && query === -1 ? route : undefined;");
    expect(cosign).toContain('The route takes `POST` only. Any other method gets the 404 `not_found` of the service, as an unknown path does.');
    // The README has the same co-sign table, row for row.
    expect(pairs).toStrictEqual(codePairs((readme.split('The co-sign route has its own codes:')[1] ?? '').split('\n## ')[0]));
  });
});
