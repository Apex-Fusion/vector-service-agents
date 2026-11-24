// agents/prior-authorization-agent/test/spec.test.ts
// specs/prior-authorization-agent.md is the public page of the agent, and the manifest links to its Response section. These tests hold the page to the code and to the deploy pack, table by table, so that the two
// cannot part: the status, the identity rows, the numbers of the terms and the windows, the request limit, the request fields of the schema that the manifest publishes, the example requests and the example result
// (made here with the kit), the errors with their statuses, the reasons that the two jobs write (each list is read from the code, and the page must list the whole set), the claim statements, the gap sentences
// word for word, what each model decision receives, and the files that the page links.
// The tests read the page, the manifest, the env example, the compose file of the pack and some source files, and no network.
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { parse } from 'yaml';
import { ACCEPT_WINDOW_MS } from '@vsa/buyer-core';
import { MAX_BODY, RESERVATION_MS } from '@vsa/service-kit';
import { CONFIRMATIONS_REQUIRED } from '@vsa/usecase-kit/access';
import { checkRuntimeBody, checkWirePayload } from '@vsa/usecase-kit/buyer';
import { MAX_JUSTIFICATION_CHARS, PRIORAUTH_CAPABILITIES, PRIORAUTH_MODELS, parsePriorAuthRequest, requestNumberOf } from '@vsa/usecase-kit/priorauth';
import { ERROR_STATUS, MAX_REQUEST_BYTES, RUNTIME_BODY_LIMIT_BYTES, checkRequestSize, makeProposal } from '@vsa/usecase-kit/protocol';
import { JOB_DEADLINE_MS as EXECUTE_DEADLINE_MS } from '../src/execute/index.ts';
import { ACCEPT_DECISION, justificationDecision } from '../src/model/index.ts';
import { PROPOSE_DEADLINE_MS } from '../src/propose/index.ts';
import { STATUS_SINCE_DEFAULT, TEMPLATE_ENV, manifestFromEnv } from '../src/serve/manifest.ts';
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
