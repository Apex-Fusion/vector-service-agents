// agents/reorder-agent/test/spec.test.ts
// specs/reorder-agent.md is the public page of the agent, and the manifest links to its Response section. These tests hold the page to the code and to the deploy pack: the status, the identity rows, the
// numbers of the terms and the windows, the request limit, the request fields of the schema that the manifest publishes, the example requests and the example result (made here with the kit), the errors
// with their statuses, the claim statements, the gap sentences word for word, the third parties, and the files that the page links.
// The tests read the page, the manifest, the env example and the compose file of the pack, and no network.
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { parse } from 'yaml';
import { ACCEPT_WINDOW_MS } from '@vsa/buyer-core';
import { MAX_BODY, RESERVATION_MS } from '@vsa/service-kit';
import { CONFIRMATIONS_REQUIRED } from '@vsa/usecase-kit/access';
import { checkRuntimeBody, checkWirePayload } from '@vsa/usecase-kit/buyer';
import { INVENTORY_CAPABILITIES } from '@vsa/usecase-kit/inventory';
import { ERROR_STATUS, MAX_REQUEST_BYTES, RUNTIME_BODY_LIMIT_BYTES, checkRequestSize } from '@vsa/usecase-kit/protocol';
import { JOB_DEADLINE_MS as EXECUTE_DEADLINE_MS } from '../src/execute/index.ts';
import { ACCEPT_DECISION, REORDER_DECISION } from '../src/model/index.ts';
import { PROPOSE_DEADLINE_MS } from '../src/propose/index.ts';
import { TEMPLATE_ENV, manifestFromEnv } from '../src/serve/manifest.ts';
import { RequestError, parseJob } from '../src/serve/server.ts';
import { BUYER_BOND_LOVELACE, JOB_DEADLINE_MS, MIN_PROCESSING_WINDOW_MS, PRICE_DEFAULT_LOVELACE, SUPPLIER_BOND_LOVELACE, priceOf, processingWindowOf, supplierKeyOf } from '../src/serve/settings.ts';
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
const row = (table: string, label: string): string => table.split('\n').find((line) => line.startsWith(`| ${label} |`)) ?? '';
const envLine = (name: string): string | undefined => envExample.split('\n').find((line) => line.startsWith(`${name}=`))?.slice(name.length + 1);
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
