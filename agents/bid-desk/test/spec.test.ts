// agents/bid-desk/test/spec.test.ts
// specs/bid-desk.md is the public page of the three Bid Desks, and the manifest of each links to its Response heading. These tests hold the page to the code, to the manifest of each instance, to the three price list
// files and to the deploy pack, table by table, so that they cannot part: the opening line, the status line and the changelog; the identity rows of the three instances; the terms, the times and the limits; the 7 checks
// of the hook with their refusal codes; the steps of the job; the quote; the price list tables; the errors; the claim; the gaps word for word; the data that leaves the service; and the links. No test here uses the network.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { ACCEPT_WINDOW_MS } from '@vsa/buyer-core';
import { BID_CAPABILITIES, BID_DESK_MODEL } from '@vsa/usecase-kit/bids';
import { MAX_BODY, RESERVATION_MS } from '@vsa/service-kit';
import { MAX_REQUEST_BYTES, RUNTIME_BODY_LIMIT_BYTES } from '@vsa/usecase-kit/protocol';
import { blake2b224Hex } from '@vsa/vector-read';
import { CLAIM_STAKE_LOVELACE, CLAIM_WINDOW_MS } from '../../../scripts/operator/lib/claim-constants.ts';
import { QUOTE_DECISION } from '../src/job/index.ts';
import { TEMPLATE_ENV, TEMPLATE_PRICE_LIST, manifestFromEnv } from '../src/serve/manifest.ts';
import type { BidDeskManifest } from '../src/serve/manifest.ts';
import { keyClashOf } from '../src/serve/keys.ts';
import {
  BOND_LOVELACE, CHECKS_READ_BUDGET_DEFAULT_MS, CHECKS_READ_BUDGET_MAX_MS, CHECKS_READ_BUDGET_MIN_MS, HOOK_READS, HOOK_READS_LIMIT_MS, INSTANCES, INSTANCE_NAMES, JOB_DEADLINE_MS, MIN_PROCESSING_WINDOW_MS,
  PRICE_LIST_ROUTE, PRICE_LOVELACE, RUNTIME_PRECHECK_WAIT_MS, CALL_TIMEOUT_MS, organisationOf, priceListFileOf, publicOriginOf, supplierKeyOf,
} from '../src/serve/settings.ts';
import type { Instance } from '../src/serve/settings.ts';
import { SETTINGS } from '../src/serve/start.ts';
import { SERVICE, envOf, priceListOf } from './serve/support.ts';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const page = readFileSync(new URL('../../../specs/bid-desk.md', import.meta.url), 'utf8');
const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
const section = (heading: string): string => (page.split(`\n## ${heading}\n`)[1] ?? '').split('\n## ')[0];
/** The part of the page that starts at the heading `### heading` and ends at the next heading. */
const sub = (heading: string): string => (page.split(`\n### ${heading}\n`)[1] ?? '').split(/\n##+ /)[0];
/** The first row of a table whose first cell is `label`, or the empty text. */
const row = (text: string, label: string): string => text.split('\n').find((line) => line.startsWith(`| ${label} |`)) ?? '';
const printed = (lovelace: number): string => (lovelace / 1_000_000).toFixed(6);
/** Every member name of a value, at any depth. A list has no member names, and a text is no member name. */
function memberNames(value: unknown): string[] {
  if (typeof value !== 'object' || value === null) return [];
  return Object.entries(value).flatMap(([key, member]) => (Array.isArray(value) ? [] : [key]).concat(memberNames(member)));
}

/** The day of the page. The status line of the page holds it, and it is the default date of the status in the manifest. */
const PAGE_DATE = '2026-11-24';
const STATUS_LINE = `PROPOSED (built, not deployed). Since ${PAGE_DATE}.`;

/** The manifest of the template, and the manifest of each instance as its settings give it. */
const template = manifestFromEnv(TEMPLATE_ENV, TEMPLATE_PRICE_LIST);
const manifests = Object.fromEntries(INSTANCES.map((instance) => [instance, manifestFromEnv(envOf(instance, { BID_DESK_SERVICE_PKH: SERVICE.pkh }), priceListOf(instance))])) as Record<Instance, BidDeskManifest>;

/** The compose file of each Bid Desk: one runtime in front of one service, in a project of its own. */
interface ComposeService {
  readonly image?: string;
  readonly container_name?: string;
  readonly environment?: Readonly<Record<string, string>>;
  readonly volumes?: readonly string[];
  readonly ports?: readonly string[];
}
interface Compose {
  readonly name: string;
  readonly services: Readonly<Record<string, ComposeService>>;
}
const composes = Object.fromEntries(INSTANCES.map((instance) => [instance, parseYaml(readFileSync(`${root}deploy/server/docker-compose.bid-desk-${instance}.yml`, 'utf8')) as Compose])) as Record<Instance, Compose>;
const runtimeEnv = (instance: Instance): Readonly<Record<string, string>> => composes[instance].services.runtime.environment ?? {};
const serviceEnv = (instance: Instance): Readonly<Record<string, string>> => composes[instance].services.service.environment ?? {};
const envExample = readFileSync(`${root}deploy/server/.env.bid-desk.example`, 'utf8');

/** What the page says of each Bid Desk in the runs that the plan holds. No code backs these words: the plan of the runs does. */
const ROLES: Readonly<Record<Instance, string>> = {
  alfa: 'quotes in every run',
  bravo: 'quotes in every run, and is the agent of the lifecycle run: its record changes its controller, recovers and is retired with a successor. The successor record is not an agent: it has no advert and no stake',
  charlie: 'is the bidder of the failure run, with the fault switch set',
};

describe('specs/bid-desk.md: the frame, the identity and the capability', () => {
  test("the opening line, the capability, the model string and the status line are the manifest's, and the page says that the agent has no record", () => {
    expect(page.split('\n')[0]).toBe('# Bid Desk');
    expect(INSTANCES.map((instance) => INSTANCE_NAMES[instance])).toStrictEqual(['Bid Desk Alfa', 'Bid Desk Bravo', 'Bid Desk Charlie']);
    expect(page.split('\n')[2]).toBe(`Capability \`${template.capability_id}\`. ${template.description}`);
    expect(template.capability_id).toBe(BID_CAPABILITIES.quote);
    expect(section('Capability id').split('\n')[1]).toBe(`\`${template.capability_id}\``);
    expect(page.split('\n')[4]).toBe('One code base serves three Bid Desks: Bid Desk Alfa, Bid Desk Bravo and Bid Desk Charlie. Each has its own record, keys, advert, organisation and price list. This page covers all three.');
    expect(BID_DESK_MODEL).toBe('bid-desk-v1');
    expect(section('Capability id')).toContain('All three Bid Desks list this capability. The `model` string of each advert and of every receipt that it gives is `bid-desk-v1`. Each Bid Desk has its own advert.');
    // The status line of the page opens with the word that the manifest carries and ends with its date. The three manifests and the example environment carry the same word and the same date.
    expect(template.status).toStrictEqual({ chip: 'proposed', since: PAGE_DATE });
    for (const instance of INSTANCES) expect(manifests[instance].status, instance).toStrictEqual({ chip: 'proposed', since: PAGE_DATE });
    expect(STATUS_LINE).toBe(`${template.status.chip.toUpperCase()} (built, not deployed). Since ${template.status.since}.`);
    expect(envExample.split('\n')).toContain('AGENT_STATUS_CHIP=proposed');
    expect(envExample.split('\n')).toContain('AGENT_STATUS_SINCE=');
    const status = section('Status');
    expect(status.split('\n')).toContain(STATUS_LINE);
    expect(status).toContain('\nNothing on this page is LIVE or DEPLOYED.\n');
    expect(status).toContain('The three Bid Desks have no registry record, no advert and no job yet.');
    expect(status).toContain('Each is the supplier side of use case 3 (supplier bid evaluation). Their counterparty is the Sourcing Agent.');
    expect(section('Identity')).toContain('\nThis agent has no registry record yet.\n');
  });

  test('the Identity rows say what the manifest and the settings say of the keys: one supplier key that only the runtime holds, one service key, no delegation key and no subagent, for each Bid Desk', () => {
    const identity = section('Identity');
    expect(identity).toContain('The table gives the design of the record. A value that the registration fixes reads "assigned at registration".');
    expect(identity).toContain('Each of the three Bid Desks has a record of its own, and the first table gives the design that the three share. The second table gives what differs.');
    expect(row(identity, 'DID')).toBe('| DID | assigned at registration, one for each Bid Desk. The service reads it from `AGENT_DID`, and the manifest gives it as `identity.did` |');
    expect(SETTINGS).toContain('AGENT_DID');
    expect(row(identity, 'Controller')).toBe('| Controller | a controller key of this deployment. The Known gaps section says who holds the keys of the parties |');
    // The service holds one private key, the service key. It holds the key hash and the public key of the supplier key, and the manifest publishes both with the key hash of the service key.
    expect(SETTINGS.filter((name) => name.endsWith('_PRIV_KEY_HEX'))).toStrictEqual(['BID_DESK_SERVICE_PRIV_KEY_HEX']);
    expect(Object.keys(template.keys)).toStrictEqual(['supplier_pkh', 'pub_key_hex', 'service_pkh']);
    expect(template.identity.supplier_key).toBe('<AGENT_DID>#<SUPPLIER_PKH>');
    for (const instance of INSTANCES) {
      expect(Object.keys(manifests[instance].keys), instance).toStrictEqual(['supplier_pkh', 'pub_key_hex', 'service_pkh']);
      // The compose file blanks the service key for the runtime and the supplier key for the service, so that neither container holds the key of the other.
      expect(runtimeEnv(instance).BID_DESK_SERVICE_PRIV_KEY_HEX, instance).toBe('');
      expect(serviceEnv(instance).SUPPLIER_PRIV_KEY_HEX, instance).toBe('');
    }
    // The public key must hash to the key hash, and the service key must not be the supplier key.
    const publicKey = 'cd'.repeat(32);
    expect(supplierKeyOf({ SUPPLIER_PKH: blake2b224Hex(publicKey), SUPPLIER_PUB_KEY_HEX: publicKey })).toStrictEqual({ pkh: blake2b224Hex(publicKey), pubKeyHex: publicKey });
    expect(() => supplierKeyOf({ SUPPLIER_PKH: 'ab'.repeat(28), SUPPLIER_PUB_KEY_HEX: publicKey })).toThrow(/SUPPLIER_PUB_KEY_HEX/);
    expect(keyClashOf({ pkh: 'ab'.repeat(28) }, { pkh: 'ab'.repeat(28), pubKeyHex: publicKey })).toBe(true);
    expect(keyClashOf({ pkh: 'cd'.repeat(28) }, { pkh: 'ab'.repeat(28), pubKeyHex: publicKey })).toBe(false);
    const supplier = row(identity, 'Supplier key');
    expect(supplier).toContain('one key for each Bid Desk: the key of its runtime, listed in the record for the authentication and transaction purposes.');
    expect(supplier).toContain('The runtime signs its receipts, and the Claim and Submit transactions of its escrows, with it. The service never holds it.');
    expect(supplier).toContain('The service holds its key hash and its public key, and the manifest publishes them as `keys.supplier_pkh` and `keys.pub_key_hex`.');
    expect(supplier).toContain('`identity.supplier_key` names it as a key of the DID (`<DID>#<key hash>`).');
    expect(supplier).toContain('The service does not start unless the public key hashes to the key hash');
    const service = row(identity, 'Service key');
    expect(service).toContain('one key for each Bid Desk, a key of its own, listed in the record for the authentication and transaction purposes. The service holds it and the runtime does not.');
    expect(service).toContain('It pays for the model hire of each quote and signs the transactions of the janitor, which settles the escrows that a hire leaves behind.');
    expect(service).toContain('The manifest publishes its key hash as `keys.service_pkh`.');
    expect(service).toContain('The service does not start when this key is the supplier key');
    // No delegation key, no co-sign route and no subagent: no setting, no manifest member and no route names one.
    expect(row(identity, 'Delegation keys')).toBe('| Delegation keys | none. The manifest lists no delegation key, and the service has no co-sign route |');
    expect(SETTINGS.filter((name) => /DELEGATION|COSIGN/.test(name))).toStrictEqual([]);
    expect('cosign' in template.behaviour).toBe(false);
    expect(row(identity, 'Subagents')).toBe('| Subagents | none. The record names no subagent, and no setting names one |');
    expect(SETTINGS.filter((name) => name.endsWith('_DID'))).toStrictEqual(['AGENT_DID']);
    expect(Object.keys(template)).not.toContain('subagents');
    expect(row(identity, 'Parties')).toBe('| Parties | Accountable: the Accountable key of the organisation, with its domain. Responsible: Module-1. Provider: the Provider key. Guardians: the guardian key of the organisation and a controller key of this deployment, with threshold 2 |');
    expect(row(identity, 'Reputation stake')).toBe('| Reputation stake | a Module-3 self-stake on the capability, owned by the service key |');
    // The claim: the numbers are the constants of the operator pack. The service stakes none.
    expect(CLAIM_STAKE_LOVELACE).toBe(50_000_000n);
    expect(CLAIM_WINDOW_MS).toBe(86_400_000);
    expect(row(identity, 'Claim')).toBe(
      `| Claim | a Module-1 claim for each run. The service stakes none. Before a run, an operator command stakes the claim with the service key: ${CLAIM_STAKE_LOVELACE / 1_000_000n} units, which is ${CLAIM_STAKE_LOVELACE} lovelace, with a challenge window of ${CLAIM_WINDOW_MS / 3_600_000} hours. The command withdraws it after the window, when nobody challenged it. See Claim statements |`,
    );
  });

  test('the second table of Identity gives, for each Bid Desk, its instance word, its name, its organisation and its public origin from its compose file, and the manifest names no controller', () => {
    const identity = section('Identity');
    expect(row(identity, 'Organisation')).toBe('| Organisation | the domain of the Bid Desk, from the second table, with the description "Demonstration organisation run by the Apex Fusion Foundation". The identity gateway verifies the domain with a DNS TXT record |');
    expect(row(identity, 'Public URL')).toBe('| Public URL | planned: one origin for each Bid Desk, the origin of its runtime in its pack (second table). The manifest names the price list at `/price-list.json` on that origin. No Bid Desk has an advert yet |');
    const shown = identity.split('\n').filter((line) => /^\| `(alfa|bravo|charlie)` \|/.test(line));
    const wanted = INSTANCES.map((instance) => `| \`${instance}\` | ${INSTANCE_NAMES[instance]} | \`${serviceEnv(instance).BID_DESK_ORGANISATION}\` | \`${runtimeEnv(instance).PUBLIC_ORIGIN}\` | ${ROLES[instance]} |`);
    expect(shown).toStrictEqual(wanted);
    expect(identity).toContain('| Instance | Name | Organisation | Public URL (planned) | Role in the planned runs |');
    for (const instance of INSTANCES) {
      // The service reads the instance, the organisation and the origin from the compose file of its Bid Desk, and the three values are the ones that the settings accept.
      expect(serviceEnv(instance).BID_DESK_INSTANCE, instance).toBe(instance);
      expect(serviceEnv(instance).BID_DESK_ORGANISATION, instance).toBe(`${instance}.vector.apexfusion.org`);
      expect(organisationOf({ BID_DESK_ORGANISATION: serviceEnv(instance).BID_DESK_ORGANISATION })).toBe(`${instance}.vector.apexfusion.org`);
      expect(serviceEnv(instance).BID_DESK_PUBLIC_ORIGIN, instance).toBe(runtimeEnv(instance).PUBLIC_ORIGIN);
      expect(publicOriginOf({ BID_DESK_PUBLIC_ORIGIN: runtimeEnv(instance).PUBLIC_ORIGIN })).toBe(runtimeEnv(instance).PUBLIC_ORIGIN);
      expect(runtimeEnv(instance).PUBLIC_ORIGIN.startsWith('https://')).toBe(true);
    }
    expect(new Set(INSTANCES.map((instance) => runtimeEnv(instance).PUBLIC_ORIGIN)).size).toBe(3);
    // The manifest of a Bid Desk names no controller, so a change of the controller of its record changes neither the manifest nor the hash that its advert holds.
    for (const manifest of [template, ...INSTANCES.map((instance) => manifests[instance])]) expect(memberNames(manifest).filter((name) => /controller/i.test(name))).toStrictEqual([]);
    expect(identity).toContain('The Bid Desk reads no controller of its own record, and its manifest names none. So a change of the controller of a record changes neither the manifest nor the checks of the hook.');
  });

  test('the Capability id section describes one runtime in front of one service for each Bid Desk, three packs that share no container, key, volume or job slot, and one image', () => {
    const capability = section('Capability id');
    const projects = INSTANCES.map((instance) => composes[instance]);
    for (const instance of INSTANCES) {
      const compose = composes[instance];
      expect(Object.keys(compose.services), instance).toStrictEqual(['runtime', 'service']);
      expect(compose.name).toBe(`bid-desk-${instance}`);
      expect(runtimeEnv(instance).CAPABILITY_KIND).toBe('custom');
      expect(runtimeEnv(instance).SERVICE_URL).toBe(`http://bids-${instance}-service:9106/`);
      expect(runtimeEnv(instance).SERVICE_PRECHECK_URL).toBe(`${runtimeEnv(instance).SERVICE_URL}precheck`);
    }
    // The three packs share no container name, no volume and no port of the host, and each reads an env file of its own: so no key, no token and no job slot is shared.
    const unique = (values: readonly string[]): boolean => new Set(values).size === values.length;
    expect(unique(projects.flatMap((compose) => [compose.services.runtime.container_name ?? '', compose.services.service.container_name ?? '']))).toBe(true);
    expect(unique(projects.flatMap((compose) => compose.services.service.volumes ?? []))).toBe(true);
    expect(unique(projects.flatMap((compose) => [...(compose.services.runtime.ports ?? []), ...(compose.services.service.ports ?? [])]))).toBe(true);
    for (const instance of INSTANCES) expect(readFileSync(`${root}deploy/server/docker-compose.bid-desk-${instance}.yml`, 'utf8')).toContain(`.env.bid-desk-${instance}`);
    expect(capability).toContain('Each Bid Desk is one runtime in front of one service, in a pack of its own. The runtime is the template runtime (`vector-agent-template`, `CAPABILITY_KIND=custom`).');
    expect(capability).toContain('It holds the supplier key of its Bid Desk and has its advert. It asks the service before it claims an escrow, claims the escrow, posts the job to the service, signs the receipt and submits the receipt hash.');
    expect(capability).toContain('The service does the work. It holds the service key and no private supplier key. It runs one job at a time.');
    expect(readme).toContain('One job runs at a time.');
    // One image serves the three: the instance selects the name and the price list file, and the organisation and the origin are settings of the deployment.
    const images = INSTANCES.map((instance) => String(composes[instance].services.service.image ?? ''));
    expect(capability).toContain('The three services run one image and one code base. `BID_DESK_INSTANCE` selects the name and the price list file, `BID_DESK_ORGANISATION` gives the organisation, and `BID_DESK_PUBLIC_ORIGIN` gives the origin that serves the price list.');
    expect(new Set(images).size).toBe(1);
    for (const instance of INSTANCES) {
      expect(manifests[instance].name).toBe(INSTANCE_NAMES[instance]);
      expect(priceListFileOf(instance).endsWith(`/price-lists/${instance}.json`)).toBe(true);
    }
    expect(capability).toContain('The three Bid Desks share the code, the checks, the job and the terms of the advert. They differ in the name, the organisation and the price list. A Bid Desk shares no container, key, volume or job slot with another.');
    // The three manifests differ in the name and in the price list, and in nothing else, when the organisation and the origin are the same.
    const same = INSTANCES.map((instance) => {
      const built = manifestFromEnv(envOf(instance, { BID_DESK_SERVICE_PKH: SERVICE.pkh, BID_DESK_PUBLIC_ORIGIN: 'https://bids.example.test', BID_DESK_ORGANISATION: 'bids.example.test' }), priceListOf(instance));
      return JSON.stringify({ ...built, name: '', behaviour: { ...built.behaviour, price_list: { ...built.behaviour.price_list, sha256: '' } } });
    });
    expect(new Set(same).size).toBe(1);
    expect(new Set(INSTANCES.map((instance) => manifests[instance].behaviour.price_list.sha256)).size).toBe(3);
  });
});

describe('specs/bid-desk.md: the Terms', () => {
  const terms = section('Terms');
  const lock = PRICE_LOVELACE + 2 * BOND_LOVELACE;

  test('three groups, one for each Bid Desk, each with its price, both bonds and lock from its manifest, and nine rows in all of price and bonds in the order Price, Supplier bond, Buyer bond', () => {
    // The nine rows that the rule of the page profile counts, as they stand on the page.
    const shown = [...terms.matchAll(/^\| (Price|Supplier bond|Buyer bond) \| (\d+) \| (\d+\.\d{6}) \|$/gm)].map((hit) => hit[0]);
    const wanted = INSTANCES.flatMap((instance) => {
      const { price_lovelace: price, supplier_bond_lovelace: supplierBond, buyer_bond_lovelace: buyerBond } = manifests[instance].terms;
      return [['Price', price], ['Supplier bond', supplierBond], ['Buyer bond', buyerBond]].map(([label, lovelace]) => `| ${label} | ${lovelace} | ${printed(Number(lovelace))} |`);
    });
    expect(shown).toHaveLength(9);
    expect(shown).toStrictEqual(wanted);
    // Each group stands under the bold line of its Bid Desk, and holds its own three rows and its lock.
    const marks = INSTANCES.map((instance) => terms.indexOf(`\n**${INSTANCE_NAMES[instance]}, advert model \`${BID_DESK_MODEL}\`**\n`));
    expect(marks.every((at) => at >= 0)).toBe(true);
    expect([...marks].sort((a, b) => a - b)).toStrictEqual(marks);
    INSTANCES.forEach((instance, at) => {
      const group = terms.slice(marks[at], marks[at + 1] ?? terms.length);
      expect(group.split('\n').filter((line) => /^\| (Price|Supplier bond|Buyer bond) \|/.test(line)), instance).toStrictEqual(wanted.slice(3 * at, 3 * at + 3));
      expect(row(group, 'Locked by the buyer (price and both bonds)'), instance).toBe(`| Locked by the buyer (price and both bonds) | ${lock} | ${printed(lock)} |`);
    });
    // The price and the bonds are constants of the code, so the three groups are equal.
    expect([PRICE_LOVELACE, BOND_LOVELACE, lock]).toStrictEqual([1_000_000, 1_000_000, 3_000_000]);
    expect(new Set(wanted).size).toBe(3);
    expect(terms).toContain('Amounts are `lovelace` fields. The last column is the same amount divided by 1,000,000, with six decimals.');
    expect(terms).toContain('The Bid Desk has three adverts, one for each Bid Desk, so its terms have three groups. The three groups are equal: the price and the two bonds are constants of the code.');
  });

  test('the window, the timeout of the runtimes and the deadline of the job are the constants, the manifests, the example environment and the three compose files', () => {
    expect(INSTANCES.every((instance) => manifests[instance].terms.max_processing_ms === MIN_PROCESSING_WINDOW_MS)).toBe(true);
    expect(envExample.split('\n')).toContain(`ADVERT_MAX_PROCESSING_MS=${MIN_PROCESSING_WINDOW_MS}`);
    const timeout = JOB_DEADLINE_MS + 60_000;
    for (const instance of INSTANCES) {
      expect(runtimeEnv(instance).ADVERT_MAX_PROCESSING_MS, instance).toBe(String(MIN_PROCESSING_WINDOW_MS));
      expect(runtimeEnv(instance).SERVICE_TIMEOUT_MS, instance).toBe(String(timeout));
    }
    expect(row(terms, 'Processing window, advert `max_processing_ms`')).toBe(`| Processing window, advert \`max_processing_ms\` | ${MIN_PROCESSING_WINDOW_MS} ms, for each of the three adverts |`);
    expect(row(terms, 'Service timeout, `SERVICE_TIMEOUT_MS` of each runtime')).toBe(`| Service timeout, \`SERVICE_TIMEOUT_MS\` of each runtime | ${timeout} ms |`);
    expect(row(terms, 'Job deadline, set by the service when a request arrives')).toBe(`| Job deadline, set by the service when a request arrives | ${JOB_DEADLINE_MS} ms |`);
    expect([MIN_PROCESSING_WINDOW_MS, timeout, JOB_DEADLINE_MS]).toStrictEqual([480_000, 360_000, 300_000]);
    // The one model call of a job is the decision quote. A job at a time, and the slot that a go reserves.
    expect(QUOTE_DECISION.name).toBe('quote');
    expect(row(terms, 'Model calls')).toBe('| Model calls | one for each job: the decision `quote` |');
    expect(row(terms, 'Jobs at a time')).toBe('| Jobs at a time | one for each Bid Desk: a second job gets 409 `busy` |');
    expect(row(terms, 'Reservation')).toBe(`| Reservation | a go from \`POST /precheck\` reserves the job slot for ${RESERVATION_MS / 1000} s |`);
    // The hook makes 4 timed reads, each inside the budget, and the 4 reads of the widest budget stay under 9000 ms, so that the answer comes inside the wait of the runtime.
    expect([HOOK_READS, HOOK_READS_LIMIT_MS, RUNTIME_PRECHECK_WAIT_MS]).toStrictEqual([4, 9_000, 10_000]);
    expect([CHECKS_READ_BUDGET_DEFAULT_MS, CHECKS_READ_BUDGET_MIN_MS, CHECKS_READ_BUDGET_MAX_MS]).toStrictEqual([1_200, 500, 2_249]);
    expect(HOOK_READS * CHECKS_READ_BUDGET_MAX_MS).toBeLessThan(HOOK_READS_LIMIT_MS);
    expect(row(terms, 'Budget of one read of the hook, `CHECKS_READ_BUDGET_MS`')).toBe(
      `| Budget of one read of the hook, \`CHECKS_READ_BUDGET_MS\` | ${CHECKS_READ_BUDGET_DEFAULT_MS} ms by default, from ${CHECKS_READ_BUDGET_MIN_MS} to ${CHECKS_READ_BUDGET_MAX_MS} ms. The hook makes ${HOOK_READS} timed reads, and ${HOOK_READS} reads of the widest budget stay under ${HOOK_READS_LIMIT_MS} ms |`,
    );
    expect(row(terms, 'Call for the credential')).toBe(`| Call for the credential | ${CALL_TIMEOUT_MS} ms at most |`);
    expect(CALL_TIMEOUT_MS).toBe(20_000);
    expect(envExample.split('\n')).toContain('CHECKS_READ_BUDGET_MS=');
  });

  test('the request limit is 900000 bytes of wire payload and 20 items, and the page says that it is safe only below the limit of the runtime on the escaped body', () => {
    expect(INSTANCES.every((instance) => manifests[instance].terms.input_limits.request_bytes === MAX_REQUEST_BYTES)).toBe(true);
    expect(row(terms, 'Request')).toBe(`| Request | at most ${MAX_REQUEST_BYTES} bytes of wire payload, and 1 to 20 items |`);
    expect(MAX_REQUEST_BYTES).toBeLessThan(MAX_BODY);
    expect(MAX_BODY).toBeLessThan(RUNTIME_BODY_LIMIT_BYTES);
    expect(RUNTIME_BODY_LIMIT_BYTES).toBe(1_048_576);
    expect(terms).toContain('**The request limit.** The limit on a request counts the wire payload: the request JSON written as a string inside a one-message array. The manifest publishes it in `terms.input_limits.request_bytes`.');
    expect(terms).toContain('The limit does not count the body of the call that a buyer makes to a runtime. The buyer puts the wire payload inside a second JSON object, and each quote mark and each backslash of the wire payload then gets one more byte.');
    expect(terms).toContain(`The runtime refuses a body above ${RUNTIME_BODY_LIMIT_BYTES} bytes (1 MiB).`);
    expect(terms).toContain(`So the limit of ${MAX_REQUEST_BYTES} bytes is safe only below the limit of the runtime, on the escaped body, and a buyer must keep the body of its call at or below ${RUNTIME_BODY_LIMIT_BYTES} bytes.`);
    expect(terms).toContain(`The service reads at most ${MAX_BODY} bytes of wire payload and refuses more with \`request_too_large\` (400).`);
  });

  test('the money: the lock of each advert, the payment from a vault, Accept, Release and Reclaim, and a job that fails is not paid', () => {
    expect(terms).toContain(`**The money.** A hire of an advert locks its price and both bonds: ${lock / 1_000_000} units.`);
    expect(terms).toContain('The buyer pays the lock from a vault of its delegation, and the value limit of the delegation caps that payment.');
    expect(terms).toContain("On Accept the Bid Desk receives the price and the supplier bond, and the buyer's bond returns to the buyer.");
    // The runtime of each Bid Desk releases an escrow that the buyer did not accept, after the window of 600 s.
    expect(ACCEPT_WINDOW_MS).toBe(600_000);
    expect(terms).toContain(`If the buyer does not accept within ${ACCEPT_WINDOW_MS / 1000} s of the Submit, the Bid Desk may Release the escrow and take the price and both bonds.`);
    for (const instance of INSTANCES) expect(runtimeEnv(instance).RELEASE_WATCHER, instance).toBe('1');
    expect(terms).toContain('If the Bid Desk never submits, the buyer reclaims after `deliver_by`. A request that the hook refuses, and a job that fails after the Claim, end that way: neither is paid.');
    expect(terms).toContain('The service pays for its one model call from the service key.');
  });
});
