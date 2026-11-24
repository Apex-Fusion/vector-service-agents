// agents/bid-desk/test/spec.test.ts
// specs/bid-desk.md is the public page of the three Bid Desks, and the manifest of each links to its Response heading. These tests hold the page to the code, to the manifest of each instance, to the three price list
// files and to the deploy pack, table by table, so that they cannot part: the opening line, the status line and the changelog; the identity rows of the three instances; the terms, the times and the limits; the 7 checks
// of the hook with their refusal codes; the steps of the job; the quote; the price list tables; the errors; the claim; the gaps word for word; the data that leaves the service; and the links. No test calls an external service.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { ACCEPT_WINDOW_MS } from '@vsa/buyer-core';
import { JANITOR_GRACE_MS, STRANDED_FILE } from '@vsa/hire-kit';
import { LLM_ADVERT_REF } from '@vsa/hire-kit/testing';
import { BUSY_TEXT, CONTEXT_HEADERS, HEARTBEAT_MS, JobSlot, MAX_BODY, RESERVATION_MS, STOPPING_TEXT, operatorsText, parseWire } from '@vsa/service-kit';
import {
  BID_CAPABILITIES, BID_DESK_CLAIM, BID_DESK_MODEL, MAX_RFQ_ITEMS, QUOTE_CHECKS, checkQuoteFromList, lineChecks, parseQuote, parseRfqDocument, priceFor, quotePriceFacts, quoteTotals, rfqSha256,
} from '@vsa/usecase-kit/bids';
import type { PriceList, Quote } from '@vsa/usecase-kit/bids';
import { CheckUnavailableError, SHARED_CHECK_NAMES } from '@vsa/usecase-kit/checks';
import { HIRE_MIN_MS, INPUT_OPEN, buildPrompt } from '@vsa/usecase-kit/decision';
import { EVIDENCE_STATEMENTS } from '@vsa/usecase-kit/dispute';
import { faultGap } from '@vsa/usecase-kit/manifest';
import { COUNTERPARTY_REFUSALS, ERROR_STATUS, FAULT_MODES, MAX_REQUEST_BYTES, NO_OPEN_CLAIM, RFQ_SCHEMA, RUNTIME_BODY_LIMIT_BYTES, accepted, isPlainObject } from '@vsa/usecase-kit/protocol';
import type { FaultSetting, ProtocolResult } from '@vsa/usecase-kit/protocol';
import { blake2b224Hex } from '@vsa/vector-read';
import { CLAIM_STAKE_LOVELACE, CLAIM_WINDOW_MS } from '../../../scripts/operator/lib/claim-constants.ts';
import { USE_CASE_NAMES } from '../../../scripts/operator/usecases/names.ts';
import { MemoryRfqBook, PASSED_CHECKS_TTL_MS, PassedChecks, createPrecheck, loadPriceList, rfqChecks } from '../src/checks/index.ts';
import { QUOTE_DECISION, QUOTE_REFUSAL_STATUS, RUNTIME_MARGIN_MS, faultyPriceOf, runQuote } from '../src/job/index.ts';
import type { QuoteChoice } from '../src/job/index.ts';
import { QUOTE_TEXT } from '../src/job/refusal.ts';
import { CONTROLLER_GAP, GAPS, NOT_SHOWN_GAP, PAGE_GAPS } from '../src/serve/gaps.ts';
import { keyClashOf } from '../src/serve/keys.ts';
import { TEMPLATE_ENV, TEMPLATE_PRICE_LIST, manifestFromEnv } from '../src/serve/manifest.ts';
import type { BidDeskManifest } from '../src/serve/manifest.ts';
import { RequestRefusal, parseRfqRequest } from '../src/serve/server.ts';
import {
  BOND_LOVELACE, CALL_TIMEOUT_MS, CHECKS_READ_BUDGET_DEFAULT_MS, CHECKS_READ_BUDGET_MAX_MS, CHECKS_READ_BUDGET_MIN_MS, HOOK_READS, HOOK_READS_LIMIT_MS, INSTANCES, INSTANCE_NAMES, JOB_DEADLINE_MS,
  MIN_PROCESSING_WINDOW_MS, PRICE_LIST_ROUTE, PRICE_LOVELACE, RUNTIME_PRECHECK_WAIT_MS, STATE_DIR_DEFAULT, faultOf, organisationOf, priceListFileOf, publicOriginOf, supplierKeyOf,
} from '../src/serve/settings.ts';
import type { Instance } from '../src/serve/settings.ts';
import { JANITOR_INTERVAL_MS, SETTINGS } from '../src/serve/start.ts';
import { T as HOOK_T, makeWorld as makeHookWorld } from './checks/support.ts';
import { gatewayFailure, makeRig, refusalOf } from './job/rig.ts';
import { CHECKS, DESK_DID, RFQ_VALUE, SENDER_DID, T0, choiceOf, decisionOf, messageOf, recordFor } from './job/samples.ts';
import { PRICE_LIST_SHA256, SERVICE, envOf, priceListOf } from './serve/support.ts';
import { serve, until } from './serve/serve.ts';
import { cleanDirs, headersOf, makeWorld as makeServiceWorld, wire } from './serve/world.ts';

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

/** The settings of the service of a Bid Desk: the organisation and the public origin of its compose file, its own key hash, and the other settings of the test world. */
const settingsOf = (instance: Instance): NodeJS.ProcessEnv =>
  envOf(instance, { BID_DESK_SERVICE_PKH: SERVICE.pkh, BID_DESK_ORGANISATION: serviceEnv(instance).BID_DESK_ORGANISATION, BID_DESK_PUBLIC_ORIGIN: serviceEnv(instance).BID_DESK_PUBLIC_ORIGIN });
/** The manifest of each Bid Desk as its settings give it, with its own price list file. */
const manifests = Object.fromEntries(INSTANCES.map((instance) => [instance, manifestFromEnv(settingsOf(instance), priceListOf(instance))])) as Record<Instance, BidDeskManifest>;
/** The status that the protocol gives a code, or undefined for a code that it does not list. */
const statusOf = (code: string): number | undefined => (Object.hasOwn(ERROR_STATUS, code) ? Reflect.get(ERROR_STATUS, code) : undefined);
/** The members of an object that a test reads by name, or a failure of the test for any other value. */
function membersOf(value: unknown): Record<string, unknown> {
  if (!isPlainObject(value)) throw new Error('the value is no object');
  return value;
}

/** What the page says of each Bid Desk in the runs that the plan holds. No code backs these words: the plan of the runs does. */
const ROLES: Readonly<Record<Instance, string>> = {
  alfa: 'quotes in every run',
  bravo: 'quotes in every run, and is the agent of the lifecycle run: its record changes its controller, recovers and is retired with a successor. The successor record is not an agent: it has no advert and no stake',
  charlie: 'is the bidder of the failure run, with the fault switch set',
};

/** The SHA-256 of a text, as `node:crypto` makes it. */
const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');
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
/** The JSON block that stands first in a part of the page. */
const jsonBlock = (text: string): string => /```json\n([\s\S]*?)\n```/.exec(text)?.[1] ?? '';
/** The source files of the service, each with its text. */
const sourceDir = new URL('../src/', import.meta.url);
const sources = (readdirSync(sourceDir, { recursive: true }) as string[]).map(String).filter((file) => file.endsWith('.ts')).map((file) => [file, readFileSync(new URL(file, sourceDir), 'utf8')] as const);
/** The non-test TypeScript files below some folders of the repository, as `[path from its root, text]`. A folder that is not there gives none. */
function repoSources(folders: readonly string[]): Array<readonly [string, string]> {
  return folders
    .filter((folder) => existsSync(`${root}${folder}`))
    .flatMap((folder) => (readdirSync(`${root}${folder}`, { recursive: true }) as string[]).map((file) => `${folder}/${String(file)}`))
    .filter((file) => file.endsWith('.ts') && !file.split('/').some((part) => part === 'node_modules' || part === 'test'))
    .map((file) => [file, readFileSync(`${root}${file}`, 'utf8')] as const);
}
/** The `src` folder of each agent and of each package of the repository. */
const srcFoldersOf = (parent: string): string[] => readdirSync(`${root}${parent}`).map((name) => `${parent}/${name}/src`);

/** What the model says in the example of the page: it prices each item from the list of Bid Desk Alfa. */
const ALFA_REASONING = 'The list gives 125 for 100 gloves, 28 for 250 syringes and 60 for 40 masks, so each line takes the unit price of its break and the lead time of its SKU.';
/**
 * The quote that the real job makes for the request of the page over scripted ports: the price list file and the organisation of Bid Desk Alfa, a model that prices each item from that list, and the stand-ins
 * of the rig for the record of the hook, the book, the identity gateway and the model supplier.
 */
async function alfaQuote(mode: FaultSetting<'bid-desk'>): Promise<Quote> {
  const loaded = loadPriceList(priceListFileOf('alfa'));
  const items = must(parseRfqDocument(RFQ_VALUE)).items;
  const lines = items.map(({ sku, quantity }) => {
    const priced = priceFor(loaded.list, sku, quantity);
    if (priced === null) throw new Error(`the price list of Bid Desk Alfa has no price for ${sku}`);
    return { sku, quantity, unit_price: priced.unit_price, lead_time_days: priced.lead_time_days };
  });
  const rig = makeRig({ mode });
  rig.decision = accepted({ ...decisionOf(choiceOf({ lines })), reasoning: ALFA_REASONING });
  return runQuote({ ...rig.deps, priceList: { list: loaded.list, sha256: loaded.sha256 }, agent: { did: DESK_DID, organisation: serviceEnv('alfa').BID_DESK_ORGANISATION } }, rig.request, rig.context, T0);
}

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
      `| Claim | a Module-1 claim for each run. The service stakes none. No command of this repository stakes a claim for this agent yet. Until one does, a challenge against it ends with \`${NO_OPEN_CLAIM}\`. The design is that the operator stakes the claim with the service key before each run, once such a command exists: ${CLAIM_STAKE_LOVELACE / 1_000_000n} units, which is ${CLAIM_STAKE_LOVELACE} lovelace, with a challenge window of ${CLAIM_WINDOW_MS / 3_600_000} hours. The operator then withdraws it after the window, when nobody challenged it. See Claim statements |`,
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
    // No code of the service reads a controller: the word stands in the text of one gap and in comments only.
    const codeLines = (text: string): string[] => text.split('\n').filter((line) => !/^\s*(\/\/|\/\*|\*)/.test(line));
    expect(sources.filter(([file, text]) => file !== 'serve/gaps.ts' && codeLines(text).some((line) => /controller/i.test(line))).map(([file]) => file)).toStrictEqual([]);
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
    expect(capability).toContain('The service does the work. It holds the service key and no private supplier key. It has no API key of a model provider: it hires its model on the Vector marketplace. It runs one job at a time.');
    expect(SETTINGS.filter((name) => /API_KEY|APIKEY/i.test(name))).toStrictEqual([]);
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
    // The 300000 ms are the deadline of the model hire: the earlier of that time after the request arrives and the time that the runtime and the call for the credential need before deliver_by.
    const hireMargin = RUNTIME_MARGIN_MS + CALL_TIMEOUT_MS;
    expect(row(terms, 'Deadline of the model hire, set by the service when a request arrives')).toBe(
      `| Deadline of the model hire, set by the service when a request arrives | ${JOB_DEADLINE_MS} ms after the request arrives, or ${hireMargin} ms before \`deliver_by\`, whichever is earlier |`,
    );
    expect([MIN_PROCESSING_WINDOW_MS, timeout, JOB_DEADLINE_MS]).toStrictEqual([480_000, 360_000, 300_000]);
    // The 300000 ms hold the model hire only: the wiring of the hire is the one source, apart from the settings that name the constant, that reads it, and it reads it for the deadline of the hire alone.
    expect(sources.filter(([file, text]) => file !== 'serve/settings.ts' && text.includes('JOB_DEADLINE_MS')).map(([file]) => file)).toStrictEqual(['serve/wiring.ts']);
    expect(readFileSync(new URL('../src/serve/wiring.ts', import.meta.url), 'utf8').split('JOB_DEADLINE_MS')).toHaveLength(3);
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
    // The README gives the same times and the same limit, and the same terms for the three Bid Desks.
    expect(readme).toContain(`| Deadline of a job | ${JOB_DEADLINE_MS} ms |`);
    expect(readme).toContain(`| Timeout of the runtime for a job | ${timeout} ms |`);
    expect(readme).toContain(`| Window of the advert | ${MIN_PROCESSING_WINDOW_MS} ms to 86400000 ms |`);
    expect(readme).toContain(`| Read of the hook | ${CHECKS_READ_BUDGET_DEFAULT_MS} ms, from ${CHECKS_READ_BUDGET_MIN_MS} ms to ${CHECKS_READ_BUDGET_MAX_MS} ms |`);
    expect(readme).toContain(`| Call for the credential | ${CALL_TIMEOUT_MS} ms |`);
    expect(readme).toContain(`at or below ${MAX_REQUEST_BYTES} bytes (\`terms.input_limits.request_bytes\`)`);
    expect(readme).toContain(`The three share the terms of their adverts: price ${PRICE_LOVELACE} lovelace, supplier bond ${BOND_LOVELACE} and buyer bond ${BOND_LOVELACE}. The buyer locks ${lock}.`);
    expect(readme).toContain(`| Least time left before delivery | ${RUNTIME_MARGIN_MS} ms | the job records no quote when less than this is left before \`deliver_by\`. The runtime stops waiting for the job this long before \`deliver_by\` |`);
  });

  test('the manifest limit counts the full wire payload, and the service and runtime have separate limits', () => {
    expect(INSTANCES.every((instance) => manifests[instance].terms.input_limits.request_bytes === MAX_REQUEST_BYTES)).toBe(true);
    expect(row(terms, 'Request')).toBe(`| Request | published limit of ${MAX_REQUEST_BYTES} bytes of wire payload, and 1 to ${MAX_RFQ_ITEMS} items |`);
    expect([MAX_REQUEST_BYTES, MAX_BODY, RUNTIME_BODY_LIMIT_BYTES]).toStrictEqual([900_000, 1_000_000, 1_048_576]);
    expect(terms).toContain(`The manifest asks the buyer to keep the full wire payload at or below ${MAX_REQUEST_BYTES} UTF-8 bytes (\`terms.input_limits.request_bytes\`).`);
    expect(terms).toContain('This counts the one-message array and all escapes.');
    expect(terms).toContain(`The runtime limits the whole request body to ${RUNTIME_BODY_LIMIT_BYTES} bytes.`);
    expect(terms).toContain('Escaping the payload again can put the body above the runtime limit even if the payload fits.');
    expect(terms).toContain(`On \`POST /\` and \`POST /precheck\` the Bid Desk's HTTP reader has a separate limit of ${MAX_BODY} bytes. It refuses more with \`request_too_large\` (400).`);
  });

  test('the money: the lock of each advert, the vault Pay, Accept, Release and Reclaim', () => {
    expect(terms).toContain(`**The money.** A hire of an advert locks its price and both bonds: ${lock / 1_000_000} units at the listed terms.`);
    expect(terms).toContain('The buyer pays the lock from a vault of its delegation, and the value limit of the delegation caps that payment.');
    expect(terms).toContain('The buyer bond goes to a separate `Returned` vault output that only the vault owner can close.');
    // The runtime of each Bid Desk releases an escrow that the buyer did not accept, after the window of 600 s.
    expect(ACCEPT_WINDOW_MS).toBe(600_000);
    expect(terms).toContain(`If the buyer does not accept within ${ACCEPT_WINDOW_MS / 1000} s of the Submit, the Bid Desk may Release the escrow and take the price and both bonds.`);
    for (const instance of INSTANCES) expect(runtimeEnv(instance).RELEASE_WATCHER, instance).toBe('1');
    expect(terms).toContain('Reclaim applies only to an Open or Claimed escrow. After `deliver_by` it returns the full lock to a `Returned` output, not to the caller\'s wallet.');
    expect(terms).toContain('Neither return restores the spending allowance of the Live vault.');
    expect(terms).toContain('The service pays for its one model call from the service key.');
  });
});

describe('specs/bid-desk.md: the routes of the Interface', () => {
  afterEach(cleanDirs);
  const interfaceText = section('Interface');

  test('the Interface names the routes of the service and the token that two of them need, and the buyer reaches the service through a runtime only', async () => {
    expect(PRICE_LIST_ROUTE).toBe('/price-list.json');
    for (const instance of INSTANCES) expect(manifests[instance].interface.routes, instance).toStrictEqual({ job: '/v1/job', status: '/status', capability: '/capability', price_list: PRICE_LIST_ROUTE });
    for (const route of ['`POST /precheck`', '`POST /`', '`GET /price-list.json`', '`GET /agent.json`', '`GET /healthz`']) expect(row(interfaceText, route), route).not.toBe('');
    expect(interfaceText).toContain('`POST /` and `POST /precheck` need the token that only the runtime holds. A call without it gets 401 `{"error":"unauthorized"}`, before the body is read.');
    expect(interfaceText).toContain('`GET /price-list.json`, `GET /agent.json` and `GET /healthz` need no token. Any other route gets 404 `{"error":"not_found"}`.');
    expect(interfaceText).toContain('A buyer sends its job to the runtime of its advert, on the runtime route `/v1/job` of the manifest, and never to the service.');
    expect(ERROR_STATUS.unauthorized).toBe(401);
    expect(readme).toContain('Without it, 401 `{"error":"unauthorized"}`');
    expect(readme).toContain('| any other route | 404 `{"error":"not_found"}` |');
    // The real service over HTTP: the two calls that need the token get 401 without it, the three public routes need none, and any other route is a 404.
    await serve(makeServiceWorld(), async (api) => {
      for (const path of ['/', '/precheck']) {
        const refused = await api.request('POST', path, { body: '[]', headers: { authorization: null } });
        expect([refused.status, refused.json], path).toStrictEqual([401, { error: 'unauthorized' }]);
      }
      expect((await api.request('GET', '/healthz', { headers: { authorization: null } })).json).toStrictEqual({ ok: true });
      for (const path of ['/agent.json', '/price-list.json']) expect((await api.request('GET', path, { headers: { authorization: null } })).status, path).toBe(200);
      const missing = await api.request('GET', '/quote', { headers: { authorization: null } });
      expect([missing.status, missing.json]).toStrictEqual([404, { error: 'not_found' }]);
    });
  });

  test('both routes refuse one byte over the HTTP limit and accept a valid request at that limit', async () => {
    const world = makeServiceWorld();
    const framed = wire(world.message);
    const padding = ' '.repeat(MAX_BODY - Buffer.byteLength(framed));
    const headers = headersOf(world.context);
    await serve(world, async (api) => {
      for (const path of ['/precheck', '/']) {
        const tooLarge = await api.request('POST', path, { headers, body: `${framed}${padding} ` });
        expect([tooLarge.status, tooLarge.json?.error], path).toStrictEqual([400, 'request_too_large']);
      }
      const precheck = await api.request('POST', '/precheck', { headers, body: framed + padding });
      expect([precheck.status, precheck.json?.go]).toStrictEqual([200, true]);
      // Different framing does not change the hash of the parsed request that the hook recorded.
      const quote = await api.request('POST', '/', { headers, body: padding + framed });
      expect([quote.status, quote.json?.rfq_id]).toStrictEqual([200, world.message.rfq.rfq_id]);
    });
  });

  test('the Interface names the two things apart: the request JSON that the buyer writes, and the wire payload that the runtime posts, which the service reads as a one-message array', () => {
    expect(interfaceText).toContain("The **request JSON** is what the buyer's agent writes: the message under Request below.");
    expect(interfaceText).toContain('The **wire payload** is the request JSON written as a string inside a one-message array: `[{"content": "<request JSON as a string>", "role": "user"}]`.');
    expect(interfaceText).toContain("The buyer's agent commits to the wire payload in the escrow, and a runtime posts it to the service as the body of `POST /` and of `POST /precheck`.");
    // The service reads exactly this array and gives back the request JSON as a string. It refuses any other body.
    expect(parseWire(JSON.stringify([{ content: 'request JSON', role: 'user' }]))).toBe('request JSON');
    expect(() => parseWire(JSON.stringify({ content: 'request JSON', role: 'user' }))).toThrow(/one-element message array/);
    expect(() => parseWire(JSON.stringify([{ content: 'request JSON', role: 'assistant' }]))).toThrow(/role must be/);
  });
});

describe('specs/bid-desk.md: the request', () => {
  const request = sub('Request');

  test('the example is the message of the sample of the job, and the service takes it', () => {
    const shown = jsonBlock(request);
    expect(shown).toBe(JSON.stringify(messageOf(), null, 2));
    expect(parseRfqRequest(shown)).toStrictEqual(messageOf());
    expect(parseWire(JSON.stringify([{ content: shown, role: 'user' }]))).toBe(shown);
    expect(request).toContain('The request JSON is the request for quotation of use case 3 (supplier bid evaluation). It is one object with exactly the members of the first table.');
    expect(request).toContain('Its `rfq` is the request for quotation, and it has exactly the members of the second table. Each item of `items` has exactly the members of the third table. The order of the members does not matter.');
    expect(request).toContain('A request that breaks a rule is refused with `bad_shape` (400), before any check.');
    expect(() => parseRfqRequest('{}')).toThrow(RequestRefusal);
    expect(new RequestRefusal('bad_shape', 'x').status).toBe(400);
    expect(ERROR_STATUS.bad_shape).toBe(400);
  });

  test('the members of the message, of the request for quotation and of an item are the members of the parsers, in their order, and the page states the rules of the parsers', () => {
    const rows = request.split('\n').filter((line) => /^\| `/.test(line));
    expect(rows).toHaveLength(9);
    const names = rows.map((line) => /^\| `([a-z_]+)` \|/.exec(line)?.[1] ?? '');
    expect(names.slice(0, 4)).toStrictEqual(Object.keys(messageOf()));
    expect(names.slice(4, 7)).toStrictEqual(Object.keys(RFQ_VALUE));
    expect(names.slice(7)).toStrictEqual(Object.keys(must(parseRfqDocument(RFQ_VALUE)).items[0]));
    expect(rows).toStrictEqual([
      `| \`schema\` | \`${RFQ_SCHEMA}\` |`,
      "| `sender_did` | the DID of the buyer's agent: `did:vector:` and 64 lower-case hex characters |",
      '| `delegation` | the identifier of the delegation that names the sender as its delegate and paid for the job: 64 lower-case hex characters |',
      '| `rfq` | the request for quotation, with the members of the second table |',
      '| `rfq_id` | 1 to 64 characters: letters, digits, dots, hyphens and underscores, starting with a letter or a digit. The service counts it as written, so `RFQ-7` and `rfq-7` are two requests |',
      '| `items` | 1 to 20 items, with the members of the third table, and each SKU once |',
      '| `needed_by` | a date that exists, as `YYYY-MM-DD`, in the year 0100 or later |',
      '| `sku` | the same form as `rfq_id` |',
      '| `quantity` | a whole number from 1 to 1000000 |',
    ]);
    // The rules of the request for quotation are the rules of its parser.
    const accepts = (over: Record<string, unknown>): boolean => parseRfqDocument({ ...RFQ_VALUE, ...over }).ok;
    const item = (sku: string, quantity: number): { sku: string; quantity: number } => ({ sku, quantity });
    const itemsOf = (count: number): Array<{ sku: string; quantity: number }> => Array.from({ length: count }, (_, at) => item(`SKU-${at}`, 1));
    expect([accepts({}), accepts({ rfq_id: 'a'.repeat(64) }), accepts({ rfq_id: 'a'.repeat(65) }), accepts({ rfq_id: '-a' }), accepts({ rfq_id: 'a b' }), accepts({ rfq_id: 'a.b_c-d' })]).toStrictEqual([true, true, false, false, false, true]);
    expect(MAX_RFQ_ITEMS).toBe(20);
    expect([accepts({ items: itemsOf(1) }), accepts({ items: itemsOf(MAX_RFQ_ITEMS) }), accepts({ items: [] }), accepts({ items: itemsOf(MAX_RFQ_ITEMS + 1) }), accepts({ items: [item('A', 1), item('A', 2)] })]).toStrictEqual([true, true, false, false, false]);
    expect([accepts({ needed_by: '2026-12-31' }), accepts({ needed_by: '2026-02-30' }), accepts({ needed_by: '0100-01-01' }), accepts({ needed_by: '0099-12-31' }), accepts({ needed_by: '2026-1-1' })]).toStrictEqual([true, false, true, false, false]);
    expect([accepts({ items: [item('a'.repeat(64), 1)] }), accepts({ items: [item('a'.repeat(65), 1)] })]).toStrictEqual([true, false]);
    expect([accepts({ items: [item('A', 1)] }), accepts({ items: [item('A', 1_000_000)] }), accepts({ items: [item('A', 0)] }), accepts({ items: [item('A', 1_000_001)] }), accepts({ items: [item('A', 1.5)] })]).toStrictEqual([true, true, false, false, false]);
    expect(accepts({ extra: 1 })).toBe(false);
    expect(accepts({ items: [{ ...item('A', 1), extra: 1 }] })).toBe(false);
    // The rules of the message: the schema, the two hex forms, and no member that the table does not list. The Bid Desk takes no approval. The order of the members does not matter.
    const refused = (over: Record<string, unknown>): void => expect(() => parseRfqRequest(JSON.stringify({ ...messageOf(), ...over }))).toThrow(RequestRefusal);
    refused({ schema: 'vector.usecase.handoff.v1' });
    refused({ sender_did: `did:vector:${'A1'.repeat(32)}` });
    refused({ delegation: '5E'.repeat(32) });
    refused({ approval: null });
    expect(parseRfqRequest(JSON.stringify(Object.fromEntries(Object.entries(messageOf()).reverse())))).toStrictEqual(messageOf());
    // The service reads each text as it was written: the Kelvin sign is no letter K.
    expect(() => parseRfqRequest(JSON.stringify({ ...messageOf(), rfq: { ...RFQ_VALUE, items: [item('\u212aIT-1', 1)] } }))).toThrow(RequestRefusal);
    expect(request).toContain('The service reads each text as it was written. An identifier or a SKU that is valid only after Unicode normalisation, such as the Kelvin sign in place of the letter K, is refused with `bad_shape`.');
    expect(request).toContain('The Bid Desk takes no approval, so a member that the tables do not list, `approval` included, is refused too.');
  });
});

describe('specs/bid-desk.md: what the hook checks before the Claim', () => {
  const hook = sub('What it checks before the Claim');
  const checks = tableRows(hook, '| # | Check | Refusal code | Status | The rule |');
  /** The refusal codes of one row of the table, in the order of the row. */
  const codesOf = (cells: string[]): string[] => [...cells[2].matchAll(/`([a-z_]+)`/g)].map((hit) => hit[1]);

  test('the 7 checks are the checks of the quote in their order, with the 7 refusal codes of the kit in their order, each with its status, and the table is the table of the README', () => {
    expect(QUOTE_CHECKS).toHaveLength(7);
    expect(checks).toHaveLength(QUOTE_CHECKS.length);
    expect(checks.map((cells) => Number(cells[0]))).toStrictEqual(QUOTE_CHECKS.map((_, at) => at + 1));
    expect(checks.map((cells) => cells[1])).toStrictEqual(QUOTE_CHECKS.map((name) => `\`${name}\``));
    expect(COUNTERPARTY_REFUSALS['bid-desk']).toHaveLength(7);
    expect(checks.flatMap(codesOf)).toStrictEqual([...COUNTERPARTY_REFUSALS['bid-desk']]);
    // Every code of a row has the status of that row, and the status is the one of the protocol.
    for (const cells of checks) for (const code of codesOf(cells)) expect(cells[3], code).toBe(String(statusOf(code)));
    expect(checks.every((cells) => cells[3] === '403')).toBe(true);
    // The first 6 checks are the shared checks of the kit, and the last is the check of the Bid Desk. The README holds the same codes, statuses and checks.
    expect([...SHARED_CHECK_NAMES['bid-desk']]).toStrictEqual(QUOTE_CHECKS.slice(0, 6));
    expect(QUOTE_CHECKS[6]).toBe('not_duplicate');
    const own = tableRows(readme.split('\n## The hook\n')[1] ?? '', '| Code | Status | Check | The rule |').slice(0, 7);
    expect(own.map(([code, status, check]) => [code, status, check])).toStrictEqual(checks.map((cells) => [`\`${cells[2].replaceAll('`', '')}\``, cells[3], cells[1]]));
    expect(checks[6][4].startsWith('the rfq book holds no answer to this `rfq_id` from this sender.')).toBe(true);
    expect(own[6][3]).toBe('the rfq book holds no answer to this `rfq_id` from this sender');
    expect(hook).toContain('The hook makes 7 checks, one after the other, in the order of the table. The first 6 are the shared checks of the use-case kit: the sender, the delegation and the payment from a vault. The last is the check of the Bid Desk.');
    expect(hook).toContain('The Bid Desk takes no approval, so it has no check of one. The first check that fails ends the hook. Its answer is the refusal code of that check, with the status 403.');
    expect(hook).toContain('A refusal comes before the Claim: the escrow stays open, nothing is claimed, nothing is paid, and the buyer reclaims the escrow after `deliver_by`.');
  });

  test('the check of the Bid Desk refuses a request that the book holds, takes the identifier as it was written, and never reads a book that cannot answer as a pass', async () => {
    const world = makeHookWorld();
    const book = new MemoryRfqBook();
    const [own] = rfqChecks({ book });
    expect(own.names).toStrictEqual(['not_duplicate']);
    expect(await own.run(world.rfq, world.context)).toMatchObject({ ok: true });
    const id = must(parseRfqDocument(world.rfq.rfq)).rfq_id;
    await book.record(world.rfq.sender_did, id, 'ab'.repeat(32));
    expect(await own.run(world.rfq, world.context)).toMatchObject({ ok: false, code: 'duplicate_rfq' });
    // The identifier counts as it was written, and the sender is a part of the key.
    expect(id).not.toBe(id.toUpperCase());
    expect(await own.run({ ...world.rfq, rfq: { ...world.rfq.rfq, rfq_id: id.toUpperCase() } }, world.context)).toMatchObject({ ok: true });
    expect(await book.has(SENDER_DID, id)).toBe(false);
    // A book that cannot answer is never a pass: the check gives CheckUnavailableError, which the hook answers with 503 check_unavailable.
    const unread = (has: () => Promise<boolean>) => rfqChecks({ book: { has, record: async () => undefined } })[0].run(world.rfq, world.context);
    await expect(unread(async () => { throw new Error('the file is gone'); })).rejects.toBeInstanceOf(CheckUnavailableError);
    await expect(unread(async () => 'yes' as unknown as boolean)).rejects.toBeInstanceOf(CheckUnavailableError);
    expect(hook).toContain('The check `not_duplicate` and the job both read the book of the Bid Desk. The book holds one entry for each request that the Bid Desk answered, by the DID of the sender and the `rfq_id` as it was written.');
  });

  test('the book never drops an entry and holds at most 10000: a request that it lacks gets check_unavailable from a full book, and a request that it holds still gets duplicate_rfq', async () => {
    const book = new MemoryRfqBook();
    for (let at = 0; at < 10_000; at += 1) await book.record(SENDER_DID, `rfq-${at}`, 'ab'.repeat(32));
    await expect(book.has(SENDER_DID, 'rfq-new')).rejects.toBeInstanceOf(RangeError);
    expect(await book.has(SENDER_DID, 'rfq-0')).toBe(true);
    expect(await book.has(SENDER_DID, 'rfq-9999')).toBe(true);
    await expect(book.record(SENDER_DID, 'rfq-new', 'ab'.repeat(32))).rejects.toBeInstanceOf(RangeError);
    expect(hook).toContain('It never drops an entry, so a Bid Desk refuses a repeated `rfq_id` of the same sender for ever. It holds at most 10000 entries.');
    expect(hook).toContain('A book that is full cannot take a new entry: for a request that it lacks, the hook then answers 503 `check_unavailable` and the escrow stays open, and for a request that it holds, the hook still answers 403 `duplicate_rfq`.');
    expect(readme).toContain('It holds at most 10000 entries and never drops one');
  });

  test('a go keeps the record for 300 s and reserves the job slot for 120 s, the hook answers 503 for a source that it cannot read, and the runtime waits 10000 ms', () => {
    expect(hook).toContain(`When every check passes, the hook answers 200 \`{"go":true,"reserved_ms":${RESERVATION_MS}}\`.`);
    expect(hook).toContain(`The service keeps the record of the checks for ${PASSED_CHECKS_TTL_MS / 1000} s, and it reserves the job slot for that escrow for ${RESERVATION_MS / 1000} s.`);
    expect([RESERVATION_MS, PASSED_CHECKS_TTL_MS]).toStrictEqual([120_000, 300_000]);
    expect(hook).toContain('A source that the hook cannot read (the identity gateway, the ledger or the rfq book) is never a pass: the hook answers 503 `check_unavailable`.');
    expect(ERROR_STATUS.check_unavailable).toBe(503);
    expect(hook).toContain(`The runtime waits ${RUNTIME_PRECHECK_WAIT_MS} ms for the hook, and reads silence as a refusal.`);
    expect(readme).toContain('it waits 10000 ms for the answer');
    expect(hook).toContain('The hook makes 4 timed reads, one after the other: the identity gateway once, for the DID of the sender, and the ledger three times (the delegation, its use and the payment from a vault).');
    expect(hook).toContain('The read of the rfq book is local and has no budget. The hook reads the record of the sender and never the record of the Bid Desk itself.');
  });

  test('the six headers of the context carry the escrow and the key of the escrow, and the body never does', () => {
    const headers = Object.values(CONTEXT_HEADERS);
    expect(headers).toHaveLength(6);
    const named = `${headers.slice(0, -1).map((name) => `\`${name}\``).join(', ')} and \`${headers.at(-1)}\``;
    expect(hook).toContain(`The runtime sends six headers of context with each call: ${named}.`);
    expect(hook).toContain('The hook needs all six, and a call with none, with some, or with a bad one gets 400 `bad_context`.');
    expect(hook).toContain('The key that posted the escrow and the reference of the escrow come from these headers and never from the body: the checks `sender_key`, `delegation` and `vault_paid` read them there.');
    expect(readme).toContain('a call with none, with some, or with a bad one gets 400 `bad_context`');
    expect(new RequestRefusal('bad_context', 'x').status).toBe(400);
    // The body cannot carry the key of the escrow: a member that the message does not list is refused.
    expect(() => parseRfqRequest(JSON.stringify({ ...messageOf(), buyer_pkh: '0b'.repeat(28) }))).toThrow(RequestRefusal);
  });

  test('the Bid Desk files no challenge: no source of the service uses the dispute code or stakes a claim, and no setting names a dispute, a Module-1 manifest or a mock system', () => {
    expect(sources.length).toBeGreaterThan(10);
    expect(sources.filter(([, text]) => /@vsa\/usecase-kit\/dispute|stakeRunClaim|challengeDelivery|challengeApproval/.test(text)).map(([file]) => file)).toStrictEqual([]);
    expect(SETTINGS.filter((name) => /DISPUTE|MODULE1|MOCK_|COSIGN/.test(name))).toStrictEqual([]);
    expect(template.behaviour.relying_on.mock_systems).toStrictEqual([]);
    expect(hook).toContain('The Bid Desk files no challenge. It takes no approval, so a request has no digest that the hook could refuse, and the service has no dispute code and no dispute setting.');
    expect(hook).toContain('A refusal of the hook is the answer to the runtime and nothing more.');
  });

  test('the hook checks no SKU against the price list: a request none of whose SKUs a list carries gets a go, and the hook keeps the record of the 7 checks for the job', async () => {
    const world = makeHookWorld({ rfq: { items: [{ sku: 'NO-SUCH-SKU', quantity: 3 }] } });
    for (const instance of INSTANCES) expect(priceFor(loadPriceList(priceListFileOf(instance)).list, 'NO-SUCH-SKU', 3), instance).toBeNull();
    const passed = new PassedChecks();
    const go = createPrecheck({ ports: world.ports, book: new MemoryRfqBook(), passed, clock: () => HOOK_T, log: () => undefined });
    expect(await go(world.rfq, world.context)).toStrictEqual({ go: true });
    expect(Object.keys(passed.take(world.context.escrowRef, HOOK_T)?.record.checks ?? {})).toStrictEqual([...QUOTE_CHECKS]);
    expect(hook).toContain('The hook does not check the SKUs of the request against the price list. SKUs absent from the list do not prevent the Claim.');
    expect(hook).toContain('If the model gives no line, the job ends with `model_output_invalid` (502), because a quote needs at least one line');
    expect(hook).toContain('A line that passes the code checks can use a price that the model made up, even for a SKU that the list does not carry.');
  });
});

describe('specs/bid-desk.md: what the job does', () => {
  const does = sub('What it does');
  const steps = does.split('\n').filter((line) => /^\d\. /.test(line));
  const lines = choiceOf().lines;

  test('the job takes its eight steps in the order of the page, and the model gets the date, the items and the entries of the list for them, and nothing else of the request', async () => {
    const rig = makeRig();
    await rig.run();
    expect(rig.events).toStrictEqual(['take', 'decide', 'has', 'credential', 'record']);
    expect(rig.takes).toStrictEqual([rig.context.escrowRef]);
    const phrases = ['takes the record of the checks', 'Decision `quote`', 'checks the choice against the request', 'When the fault switch is set', 'reads the book again', 'credential of the Bid Desk', 'builds the quote', 'checks the time'];
    expect(steps).toHaveLength(phrases.length);
    phrases.forEach((phrase, at) => expect(steps[at], phrase).toContain(phrase));
    const hireMargin = RUNTIME_MARGIN_MS + CALL_TIMEOUT_MS;
    expect(does).toContain(
      `The job runs these steps in this order. A failure ends the job with an error, and no later step runs. The service sets one deadline when the request arrives, and it holds the model hire only: the earlier of ${JOB_DEADLINE_MS} ms after the request arrives and ${hireMargin} ms before \`deliver_by\`. The ${hireMargin} ms are ${RUNTIME_MARGIN_MS} ms for the runtime, which stops waiting then, and ${CALL_TIMEOUT_MS} ms for the call for the credential. The steps after the hire can end later than the ${JOB_DEADLINE_MS} ms.`,
    );
    // The input of the decision: the date of today, the items and the date of the request, and the entries of the list for the SKUs of the items. The identifier of the request, the sender and the delegation stay out.
    const input = membersOf(rig.decideInputs[0]);
    expect(Object.keys(input)).toStrictEqual(['today', 'request', 'price_list']);
    expect(Object.keys(membersOf(input.request))).toStrictEqual(['items', 'needed_by']);
    expect(Array.isArray(input.price_list) ? input.price_list.map((entry) => membersOf(entry).sku) : []).toStrictEqual(['GLV-NIT-M', 'SYR-10ML', 'MSK-N95']);
    for (const text of ['run1-rfq-1', SENDER_DID, rig.request.delegation]) expect(JSON.stringify(input), text).not.toContain(text);
    expect(steps[1]).toContain('The model gets a fixed instruction, the date of today, the items and the date of the request, and the entries of the price list for the SKUs of the items.');
    expect(steps[1]).toContain('It answers `{ "lines": [ { "sku", "quantity", "unit_price", "lead_time_days" } ], "valid_until": "<date>", "notes": "..." }`, and its reasons.');
    expect(QUOTE_DECISION.parse(choiceOf()).ok).toBe(true);
    expect(QUOTE_DECISION.parse({ ...choiceOf(), extra: 1 }).ok).toBe(false);
    // The hire ends 300000 ms after the request arrives, or 50000 ms before deliver_by when that is earlier, and it does not start with less than 60000 ms left for it.
    expect(readFileSync(new URL('../src/serve/wiring.ts', import.meta.url), 'utf8')).toContain('deadlineMs: Math.min(arrivedAt + JOB_DEADLINE_MS, context.deliverByMs - RUNTIME_MARGIN_MS - CALL_TIMEOUT_MS)');
    expect([RUNTIME_MARGIN_MS + CALL_TIMEOUT_MS, HIRE_MIN_MS]).toStrictEqual([50_000, 60_000]);
    expect(steps[1]).toContain(`The hire ends ${JOB_DEADLINE_MS} ms after the request arrives, or ${hireMargin} ms before \`deliver_by\` when that is earlier, and it does not start with less than ${HIRE_MIN_MS} ms left for it.`);
    expect(steps[0]).toContain('It compares the hash of the canonical JSON of its parsed request with the hash that the hook recorded.');
    expect(steps[0]).toContain('A job with no record, with the record of a different request, with a record that lacks one of the 7 checks, or with a fact in the record that it cannot read, fails with `precheck_missing` and makes no quote.');
  });

  test('a job with no record, with the record of another body, with a record that lacks a check, or with a fact that it cannot read, fails with precheck_missing and makes no quote', async () => {
    const none = makeRig();
    none.entry = null;
    const other = makeRig();
    other.entry = recordFor(other.request, { request_sha256: 'ab'.repeat(32) });
    const lacking = makeRig();
    lacking.entry = recordFor(lacking.request, { checks: Object.fromEntries(Object.entries(CHECKS).filter(([name]) => name !== 'vault_paid')) });
    const unreadable = makeRig();
    unreadable.entry = recordFor(unreadable.request, { facts: { organisation: 7, organisation_verified: true } });
    for (const rig of [none, other, lacking, unreadable]) {
      expect(await refusalOf(rig.run())).toMatchObject({ code: 'precheck_missing', status: 500 });
      expect(rig.events).toStrictEqual(['take']);
      expect(rig.booked).toHaveLength(0);
    }
    // A record whose organisation of the sender has more than 1024 characters holds a fact that the job cannot read, and a record with 1024 characters is read: the twin gives the quote with the whole text.
    const withOrganisation = (text: string) => {
      const rig = makeRig();
      rig.entry = recordFor(rig.request, { facts: { organisation: text, organisation_verified: true } });
      return rig;
    };
    const tooLong = withOrganisation('x'.repeat(1025));
    expect(await refusalOf(tooLong.run())).toMatchObject({ code: 'precheck_missing', status: 500 });
    expect(tooLong.events).toStrictEqual(['take']);
    expect(tooLong.booked).toHaveLength(0);
    expect((await withOrganisation('x'.repeat(1024)).run()).sender.organisation).toBe('x'.repeat(1024));
    expect(QUOTE_REFUSAL_STATUS.precheck_missing).toBe(500);
  });

  test('a choice with no line, a line that is not an item of the request, or a SKU two times ends the job with model_output_invalid, and a choice with fewer lines than items is a quote', async () => {
    const chosen = async (choice: QuoteChoice) => {
      const rig = makeRig();
      rig.decision = accepted(decisionOf(choice));
      return rig;
    };
    const bad = [
      choiceOf({ lines: [] }),
      choiceOf({ lines: [{ ...lines[0], quantity: 99 }, lines[1], lines[2]] }),
      choiceOf({ lines: [{ sku: 'XYZ-1', quantity: 1, unit_price: 50, lead_time_days: 3 }] }),
      choiceOf({ lines: [lines[0], lines[0]] }),
    ];
    for (const choice of bad) {
      const rig = await chosen(choice);
      expect(await refusalOf(rig.run())).toMatchObject({ code: 'model_output_invalid', status: 502, kind: 'job' });
      expect(rig.events).toStrictEqual(['take', 'decide']);
      expect(rig.booked).toHaveLength(0);
    }
    expect(QUOTE_REFUSAL_STATUS.model_output_invalid).toBe(502);
    // The twin: a choice with 2 of the 3 items is a quote with 2 lines. The code never adds a line, and it reads no word of the notes: these notes do not name the item that the quote leaves out.
    const fewer = await chosen(choiceOf({ lines: lines.slice(0, 2) }));
    const quote = await fewer.run();
    expect(quote.lines.map((line) => line.sku)).toStrictEqual(['GLV-NIT-M', 'SYR-10ML']);
    expect(quote.notes).not.toContain('MSK-N95');
    expect(steps[2]).toContain('The job does not check that every item has a line, and it never adds, removes or changes a line.');
    expect(steps[2]).toContain('A choice that breaks this rule ends the job with `model_output_invalid` (502). The decision is on record and no quote is made.');
  });

  test('the code checks no unit price against the price list: a line at a price that is not on the list is in the quote, and the instruction to the model says what to do with an item that the list lacks', async () => {
    const rig = makeRig();
    rig.decision = accepted(decisionOf(choiceOf({ lines: [{ ...lines[0], unit_price: 1 }, lines[1], lines[2]] })));
    const quote = await rig.run();
    expect(quote.lines[0]).toMatchObject({ sku: 'GLV-NIT-M', quantity: 100, unit_price: 1, line_total: 100 });
    expect(priceFor(rig.deps.priceList.list, 'GLV-NIT-M', 100)?.unit_price).toBe(125);
    expect(quote.fault_mode).toBe('');
    expect(does).toContain('The model sets the prices and the code does not check them. The code checks the SKU and the quantity of each line against the request, and it does not check a unit price against the price list. So a quote can hold a price that is not on the list.');
    // The buyer can check each price, because the quote names the list: a price that differs from the list is found by the rule of the kit, and the Sourcing Agent compares the prices of the quote with the list.
    expect(checkQuoteFromList(quote, rig.deps.priceList.sha256)).toStrictEqual({ ok: true, value: null });
    expect(readFileSync(new URL('../../sourcing-agent/src/model/accept.ts', import.meta.url), 'utf8')).toContain('For each line, compare its "unit_price" with its listed price.');
    expect(does).toContain('The Sourcing Agent asks its model to compare the unit price of each line of a quote with the price of the list before it accepts the quote. The one price off the list that this Bid Desk makes on purpose is the fault `quote_off_price_list`.');
    // A request none of whose SKUs the list carries: the model gets no entry, the instruction says to leave the item out, and a choice with no line is model_output_invalid after the Claim.
    expect(QUOTE_DECISION.instruction).toContain('Leave an item that the price list does not carry out of "lines", and name it in "notes".');
    const unlisted = makeRig({ rfq: { items: [{ sku: 'NO-SUCH-SKU', quantity: 3 }] } });
    unlisted.decision = accepted(decisionOf(choiceOf({ lines: [], notes: 'No SKU of the request is on the price list.' })));
    expect(await refusalOf(unlisted.run())).toMatchObject({ code: 'model_output_invalid', status: 502 });
    expect(membersOf(unlisted.decideInputs[0]).price_list).toStrictEqual([]);
    expect(unlisted.events).toStrictEqual(['take', 'decide']);
    // A line for an unlisted item still makes a quote if it passes the job's checks.
    const invented = makeRig({ rfq: { items: [{ sku: 'NO-SUCH-SKU', quantity: 3 }] } });
    invented.decision = accepted(decisionOf(choiceOf({ lines: [{ sku: 'NO-SUCH-SKU', quantity: 3, unit_price: 50, lead_time_days: 3 }] })));
    expect(priceFor(invented.deps.priceList.list, 'NO-SUCH-SKU', 3)).toBeNull();
    expect((await invented.run()).lines).toStrictEqual([{ sku: 'NO-SUCH-SKU', quantity: 3, unit_price: 50, line_total: 150, lead_time_days: 3 }]);
    expect(invented.booked).toHaveLength(1);
    expect(does).toContain('The instruction to the model says to leave an item that the list does not carry out of the lines, and to name it in the notes. When no line is left, the job ends with `model_output_invalid` (502) after the Claim, and the service has paid for the model hire.');
  });

  test('the book is read again, the credential is asked from the gateway, a draft that the parser refuses is internal, and a quote that cannot be written is store_write_failed', async () => {
    // Step 5: a request that the book holds ends the job with duplicate_rfq after the Claim, with a fixed text.
    const held = makeRig();
    await held.memory.record(SENDER_DID, 'run1-rfq-1', 'ab'.repeat(32));
    const duplicate = await refusalOf(held.run());
    expect(duplicate).toMatchObject({ code: 'duplicate_rfq', status: 403, message: QUOTE_TEXT.duplicate_rfq });
    expect(duplicate.message).not.toContain('run1-rfq-1');
    expect(held.events).toStrictEqual(['take', 'decide', 'has']);
    // Step 6: no credential, and an answer that is no compact JWS.
    const down = makeRig();
    down.issued = gatewayFailure('gateway.unavailable', 503);
    const garbled = makeRig();
    garbled.issued = { ok: true, value: 'not a compact JWS' };
    for (const rig of [down, garbled]) {
      expect(await refusalOf(rig.run())).toMatchObject({ code: 'credential_failed', status: 502 });
      expect(rig.events).toStrictEqual(['take', 'decide', 'has', 'credential']);
      expect(rig.booked).toHaveLength(0);
    }
    expect(manifests.alfa.behaviour.relying_on.gateway_routes).toStrictEqual(['GET /1.0/identifiers/{did}', 'GET /agents/{id}/credential']);
    // Step 7: a draft that the parser of the kit refuses.
    const draft = makeRig();
    const refused = await refusalOf(runQuote({ ...draft.deps, agent: { did: DESK_DID, organisation: 'Supplier Alfa' } }, draft.request, draft.context, T0));
    expect(refused).toMatchObject({ code: 'internal', status: 500 });
    expect(draft.booked).toHaveLength(0);
    // Step 8: a book that cannot be written.
    const full = makeRig();
    full.bookError = new Error('the disk is full');
    expect(await refusalOf(full.run())).toMatchObject({ code: 'store_write_failed', status: 500 });
    expect(full.events).toStrictEqual(['take', 'decide', 'has', 'credential', 'record']);
    for (const code of ['duplicate_rfq', 'credential_failed', 'internal', 'store_write_failed'] as const) expect(QUOTE_REFUSAL_STATUS[code], code).toBe(ERROR_STATUS[code]);
    expect(steps[4]).toContain('A request that the book holds ends the job with `duplicate_rfq` (403) after the Claim.');
    expect(steps[5]).toContain('A failure of the gateway, and an answer that is not a compact JWS, end the job with `credential_failed` (502).');
    expect(steps[6]).toContain('A quote that the parser refuses ends the job with `internal` (500).');
    expect(steps[7]).toContain('A book that cannot be written ends the job with `store_write_failed` (500).');
  });

  test('the limits of the job: less than 30000 ms before deliver_by gives deadline and records nothing, a caller that hangs up before the decision or the record gets deadline, and a hang-up after the record changes nothing', async () => {
    expect(RUNTIME_MARGIN_MS).toBe(30_000);
    const late = makeRig({ deliverInMs: RUNTIME_MARGIN_MS - 1 });
    expect(await refusalOf(late.run())).toMatchObject({ code: 'deadline', status: 422, message: QUOTE_TEXT.no_time });
    expect(late.booked).toHaveLength(0);
    expect(late.events).toStrictEqual(['take', 'decide', 'has', 'credential']);
    const edge = makeRig({ deliverInMs: RUNTIME_MARGIN_MS });
    expect((await edge.run()).rfq_id).toBe('run1-rfq-1');
    // The 300000 ms hold the model hire only: a hire that ends after them leaves the job as it was, and the job gives its quote when 30000 ms or more are left before deliver_by.
    const slow = makeRig({ deliverInMs: JOB_DEADLINE_MS + 120_000 });
    const decideSlowly = slow.deps.decide;
    const slowQuote = await runQuote({ ...slow.deps, decide: async (input) => { slow.now += JOB_DEADLINE_MS + 1; return decideSlowly(input); } }, slow.request, slow.context, T0);
    expect(slowQuote.rfq_id).toBe('run1-rfq-1');
    expect(slow.booked).toHaveLength(1);
    const gone = new AbortController();
    gone.abort();
    const before = makeRig();
    expect(await refusalOf(before.run({ signal: gone.signal }))).toMatchObject({ code: 'deadline', status: 422, message: QUOTE_TEXT.deadline });
    expect(before.events).toStrictEqual(['take']);
    // The caller hangs up during the record: the quote is booked, the job gives it, and the log says that the caller hung up.
    const during = new AbortController();
    const rig = makeRig();
    const book = { has: rig.deps.book.has, record: async (...args: Parameters<typeof rig.deps.book.record>) => { during.abort(); await rig.deps.book.record(...args); } };
    const quote = await runQuote({ ...rig.deps, book }, rig.request, rig.context, T0, during.signal);
    expect(rig.booked).toHaveLength(1);
    expect(quote.rfq_id).toBe('run1-rfq-1');
    expect(rig.logs.some((line) => line.includes('the caller hung up while the quote was booked'))).toBe(true);
    expect(ERROR_STATUS.deadline).toBe(422);
    expect(steps[7]).toContain('With less than 30000 ms left before `deliver_by`, the job ends with `deadline` (422) and records nothing.');
    expect(does).toContain('A job whose caller hangs up before the decision, or before the book records the quote, stops there with `deadline` (422) and records nothing. A hire that has started is not stopped.');
    expect(does).toContain('A hang-up after the record does not stop the job: the quote is booked, the job gives it, and its log says that the caller hung up. The job calls no mock system, takes no approval and files no challenge.');
  });
});

describe('specs/bid-desk.md: the response', () => {
  const response = sub('Response');

  test('the Response heading is the anchor that the manifest of each Bid Desk links to', () => {
    expect(page.match(/^### Response$/gm)).toHaveLength(1);
    for (const instance of INSTANCES) expect(manifests[instance].interface.response_schema.$ref.endsWith('/specs/bid-desk.md#response'), instance).toBe(true);
  });

  test('the example is the quote that the job gives for the price list and the organisation of Bid Desk Alfa, and the members of the table are its members in their order', async () => {
    const given = await alfaQuote('');
    const shown = jsonBlock(response);
    expect(shown).toBe(JSON.stringify(given, null, 2));
    expect(must(parseQuote(JSON.parse(shown)))).toStrictEqual(given);
    // The example answers the request of the example, and names the price list file of Bid Desk Alfa: its hash is the hash in the manifest of Bid Desk Alfa.
    expect([given.rfq_id, given.organisation]).toStrictEqual([RFQ_VALUE.rfq_id, serviceEnv('alfa').BID_DESK_ORGANISATION]);
    expect(given.rfq_sha256).toBe(must(rfqSha256(must(parseRfqDocument(RFQ_VALUE)))));
    expect(given.price_list_sha256).toBe(manifests.alfa.behaviour.price_list.sha256);
    expect(given.sender.did).toBe(messageOf().sender_did);
    const alfa = loadPriceList(priceListFileOf('alfa')).list;
    for (const line of given.lines) expect(line.unit_price, line.sku).toBe(priceFor(alfa, line.sku, line.quantity)?.unit_price);
    expect(Object.keys(given.checks)).toStrictEqual([...QUOTE_CHECKS]);
    // The table names the members in the order of the quote, and its rows say what they hold.
    const names = response.split('\n').filter((line) => /^\| `/.test(line)).map((line) => /^\| `([a-z0-9_]+)` \|/.exec(line)?.[1] ?? '');
    expect(names).toStrictEqual(Object.keys(given));
    expect(names).toHaveLength(17);
    expect(row(response, '`schema`')).toBe(`| \`schema\` | \`${given.schema}\` |`);
    expect(row(response, '`outcome`')).toBe('| `outcome` | always `done`: a refusal or a failure is an error, never a quote |');
    expect(row(response, '`checks`')).toBe(`| \`checks\` | the ${QUOTE_CHECKS.length} checks of the hook, each \`true\`, in the order of the table of the hook |`);
    expect(row(response, '`decisions`')).toBe('| `decisions` | one decision, `quote`: its choice, its reasoning, and the hire of the model supplier with the sub-receipt that the service verified (`inference`) |');
    expect(row(response, '`fault_mode`')).toBe('| `fault_mode` | the setting of the fault switch: the empty text in a clean run. It is the last member |');
    expect(row(response, '`notes`')).toBe('| `notes` | the note of the model: at most 500 characters |');
    expect(row(response, '`sender`')).toBe('| `sender` | the DID of the sender, the organisation that the covering Accountable Party names (or `null`), and whether the identity gateway verified it. The organisation is recorded, and the hook never refuses a sender for it. The job refuses an organisation of more than 1024 characters with `precheck_missing` (500) after the Claim |');
    expect(readme).toContain('| `sender` | the sender: `did`, `organisation` and `organisation_verified`. The organisation is the one that the covering Accountable Party names, or `null`. It is recorded, and the hook never refuses a sender for it. The job refuses one of more than 1024 characters with `precheck_missing` (500) after the Claim |');
    expect(Object.keys(given).at(-1)).toBe('fault_mode');
    expect(response).toContain('`schema` is `vector.usecase.quote.v1`. A job that makes the quote answers with it, as the body of the answer, serialised once, with its members in the order of the table below.');
    expect(response).toContain('The signed receipt of the job is the signed quote: the receipt commits to the text of the quote. A job that does not make a quote answers with an error (see Errors) and no quote.');
    expect(response).toContain('It is an illustration and not a recorded run. Its desk DID, sender, credential, references, hashes and signature are made up, so none of them is of a real agent, escrow or key. Only the price list hash and the prices are those of the file of Bid Desk Alfa.');
  });

  test('the three numbers are arithmetic, a quote can have fewer lines than the request has items, and the quote names the hash of the request and the hash of the list', async () => {
    const given = await alfaQuote('');
    expect(quoteTotals(given.lines.map(({ sku, quantity, unit_price: unitPrice, lead_time_days: lead }) => ({ sku, quantity, unit_price: unitPrice, lead_time_days: lead })))).toStrictEqual({ lines: given.lines, total: given.total, lead_time_days: given.lead_time_days });
    expect([given.total, given.lead_time_days]).toStrictEqual([21_900, 21]);
    expect(given.lines.map((line) => line.line_total)).toStrictEqual(given.lines.map((line) => line.quantity * line.unit_price));
    expect(parseQuote({ ...given, total: given.total + 1 }).ok).toBe(false);
    expect(response).toContain('A line total is the quantity times the unit price, the total is the sum of the line totals, and `lead_time_days` is the longest lead time of the lines.');
    expect(response).toContain('The service makes these three numbers from the lines of the model. They are arithmetic and not decisions, and the parser of the kit refuses a quote with a number that is not the arithmetic of its lines.');
    expect(response).toContain('A quote can have fewer lines than the request has items. The instruction to the model asks it to name each item that it leaves out in the notes, and the job does not check the notes.');
    expect(QUOTE_DECISION.instruction).toContain('Leave an item that the price list does not carry out of "lines", and name it in "notes".');
    // The notes and the organisation of the sender are free text with limits: 500 characters without a control or hidden character, and 1024 characters.
    const withNotes = (notes: string): boolean => parseQuote({ ...given, notes }).ok;
    expect([withNotes('a'.repeat(500)), withNotes('a'.repeat(501)), withNotes('a\u0007b'), withNotes('a\u200bb')]).toStrictEqual([true, false, false, false]);
    const withOrganisation = (organisation: string): boolean => parseQuote({ ...given, sender: { ...given.sender, organisation } }).ok;
    expect([withOrganisation('x'.repeat(1024)), withOrganisation('x'.repeat(1025)), withOrganisation('Any text, with spaces.')]).toStrictEqual([true, false, true]);
    expect(response).toContain('The `notes` and the organisation of the sender are free text. The notes hold at most 500 characters and no control or hidden character. The quote holds an organisation of the sender of at most 1024 characters, and it can be any text that the covering Accountable Party names. The hook takes an organisation of any length. The job refuses one of more than 1024 characters: it fails with `precheck_missing` (500) after the Claim and before the model hire, and it makes no quote.');
    expect(response).toContain('The quote names the hash of the request and the hash of the price list that it was priced from, so a buyer\'s agent can check each unit price against the public list.');
  });

  test('the hook takes an organisation of the sender of any length, and the job refuses one of more than 1024 characters with precheck_missing after the Claim and before the model hire', async () => {
    const organisation = 'x'.repeat(5_000);
    const world = makeHookWorld({ organisation: { domain: organisation, verified: true } });
    const passed = new PassedChecks();
    const go = createPrecheck({ ports: world.ports, book: new MemoryRfqBook(), passed, clock: () => HOOK_T, log: () => undefined });
    expect(await go(world.rfq, world.context)).toStrictEqual({ go: true });
    const kept = passed.take(world.context.escrowRef, HOOK_T);
    if (kept === null) throw new Error('the hook kept no record of the checks');
    expect(kept.record.facts).toMatchObject({ organisation, organisation_verified: true });
    // The job takes that record, as the hook kept it, and refuses it before it hires a model.
    const rig = makeRig();
    rig.entry = { record: kept.record, request_sha256: recordFor(rig.request).request_sha256 };
    expect(await refusalOf(rig.run())).toMatchObject({ code: 'precheck_missing', status: 500 });
    expect(rig.events).toStrictEqual(['take']);
    expect(rig.booked).toHaveLength(0);
    expect(response).toContain('The hook takes an organisation of any length. The job refuses one of more than 1024 characters: it fails with `precheck_missing` (500) after the Claim and before the model hire, and it makes no quote.');
  });
});

describe('specs/bid-desk.md: the price list', () => {
  const list = sub('The price list');
  const marks = INSTANCES.map((instance) => list.indexOf(`\n**${INSTANCE_NAMES[instance]}**\n`));

  test.each(INSTANCES.map((instance, at) => [instance, at] as const))('the table of %s is its file: the SKU, the lead time and the unit price at each break, and the hash of its bytes is the hash in its manifest', (instance, at) => {
    expect(marks.every((mark) => mark >= 0)).toBe(true);
    expect([...marks].sort((a, b) => a - b)).toStrictEqual(marks);
    const loaded = loadPriceList(priceListFileOf(instance));
    const minimums = loaded.list.items[0].breaks.map((step) => step.min_quantity);
    for (const entry of loaded.list.items) expect(entry.breaks.map((step) => step.min_quantity), entry.sku).toStrictEqual(minimums);
    const group = list.slice(marks[at], marks[at + 1] ?? list.length);
    const header = `| SKU | Lead time in days | ${minimums.map((minimum) => `Unit price from ${minimum}`).join(' | ')} |`;
    expect(tableRows(group, header)).toStrictEqual(loaded.list.items.map((entry) => [`\`${entry.sku}\``, String(entry.lead_time_days), ...entry.breaks.map((step) => String(step.unit_price))]));
    // The hash of the file, as `node:crypto` makes it, is the hash that the manifest of the Bid Desk holds, and the page names it.
    expect(loaded.sha256).toBe(sha256(readFileSync(priceListFileOf(instance), 'utf8')));
    expect(loaded.sha256).toBe(manifests[instance].behaviour.price_list.sha256);
    expect(loaded.sha256).toBe(priceListOf(instance).sha256);
    expect(loaded.sha256).toBe(PRICE_LIST_SHA256[instance]);
    expect(group).toContain(`\nSHA-256 of the file: \`${loaded.sha256}\`\n`);
    expect(manifests[instance].behaviour.price_list.uri).toBe(`${runtimeEnv(instance).PUBLIC_ORIGIN}${PRICE_LIST_ROUTE}`);
  });

  test('the three files differ, the unit price of a quantity is the price of the break with the greatest minimum that is not above it, and the route gives the exact bytes of the file of each Bid Desk', async () => {
    expect(new Set(INSTANCES.map((instance) => loadPriceList(priceListFileOf(instance)).sha256)).size).toBe(3);
    const alfa = loadPriceList(priceListFileOf('alfa')).list;
    expect([99, 100, 499, 500, 1_000_000].map((quantity) => priceFor(alfa, 'GLV-NIT-M', quantity)?.unit_price)).toStrictEqual([140, 125, 125, 110, 110]);
    expect(list).toContain('The unit price of a quantity is the price of the break with the greatest minimum that is not above the quantity.');
    expect(list).toContain('It needs no token and takes no job slot. The answer is the exact bytes of the file, with the header `content-type: application/json`.');
    for (const instance of INSTANCES) {
      await serve(makeServiceWorld({ instance }), async (api) => {
        const served = await api.request('GET', '/price-list.json', { headers: { authorization: null } });
        expect([served.status, served.headers.get('content-type')]).toStrictEqual([200, 'application/json']);
        expect(Buffer.from(served.text, 'utf8').equals(readFileSync(priceListFileOf(instance)))).toBe(true);
      });
    }
    cleanDirs();
  });

  test('the manifest holds the hash of the file and the advert holds the hash of the manifest, so a change of a list is a new image and a new advert, and the lists are stand-in data', () => {
    // The manifest of an instance takes the hash of the file of its own instance only.
    expect(() => manifestFromEnv(envOf('alfa', { BID_DESK_SERVICE_PKH: SERVICE.pkh }), { sha256: PRICE_LIST_SHA256.bravo })).toThrow(/price list hash/);
    expect(readme).toContain('The advert holds the SHA-256 of the bytes that `GET /agent.json` serves.');
    expect(readFileSync(new URL('../Dockerfile', import.meta.url), 'utf8')).toContain('COPY agents/bid-desk/price-lists ./agents/bid-desk/price-lists');
    expect(list).toContain('The manifest holds the address of the file, `<public origin>/price-list.json`, and the SHA-256 of its bytes in `behaviour.price_list`. The advert holds the SHA-256 of the manifest.');
    expect(list).toContain('So a change of a list changes the manifest of its Bid Desk, and it is a new image and a new advert. The three tables below are the three files.');
    expect(list).toContain('The numbers are stand-in data of a demonstration: they carry no unit of account and no commercial value.');
  });
});

describe('specs/bid-desk.md: the errors', () => {
  const errors = sub('Errors');
  const statusRows = (text: string): string[] => text.split('\n').filter((line) => /^\| \d{3}, /.test(line));
  /** The names of codes in the second cell of a row of the table, in order. A word in the explanation of a code, in brackets, is no code. */
  const codesIn = (line: string): string[] => [...(line.split('|')[2] ?? '').replace(/\([^)]*\)/g, '').matchAll(/`([^`]+)`/g)].map((hit) => hit[1]).filter((text) => /^[a-z_]+$/.test(text));
  const kitServer = readFileSync(new URL('../../../packages/service-kit/src/server.ts', import.meta.url), 'utf8');

  test('the table is the table of the README, with its 11 rows, every code has its status, and the codes are the codes of the hook, the job and the service, and no others', () => {
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
        expect(Object.hasOwn(outside, code) ? outside[code] : statusOf(code), code).toBe(status);
      }
    }
    // The 403 row before the Claim holds the 7 codes of the hook, in the order of its checks. The job gives one 403 after the Claim, and each code of the job is in the table with its status.
    expect(codesIn(onPage.find((line) => line.startsWith('| 403, the hook, before the Claim')) ?? '')).toStrictEqual([...COUNTERPARTY_REFUSALS['bid-desk']]);
    expect(codesIn(onPage.find((line) => line.startsWith('| 403, the job, after the Claim')) ?? '')).toStrictEqual(['duplicate_rfq']);
    for (const [code, status] of Object.entries(QUOTE_REFUSAL_STATUS)) expect(documented.get(code), code).toContain(status);
    const expected = [...COUNTERPARTY_REFUSALS['bid-desk'], ...Object.keys(QUOTE_REFUSAL_STATUS), 'check_unavailable', 'busy', 'shutting_down', 'unauthorized', 'not_found', 'bad_wire', 'request_too_large', 'bad_shape', 'bad_context'];
    expect([...documented.keys()].sort()).toStrictEqual([...new Set(expected)].sort());
    expect([...documented.entries()].filter(([, statuses]) => statuses.length > 1)).toStrictEqual([['duplicate_rfq', [403, 403]]]);
  });

  test('the 401, the 404, the 409 of a job and a plain 500 have no message, the 409 of the hook has one, the messages of duplicate_rfq and deadline are fixed, and the slot gives the busy answers as the page says', () => {
    expect(errors).toContain('A refusal is `{ "error": "<code>", "message": "<words>" }` with the status in the table.');
    expect(errors).toContain('- The 401, the 404, the 409 of a job and a plain 500 have the code and no message: `{"error":"unauthorized"}`, `{"error":"not_found"}`, `{"error":"busy"}` and `{"error":"internal"}`. A plain 500 is the answer to a fault that no code names, and its cause is in the log.');
    expect(kitServer).toContain("return send(401, { error: 'unauthorized' });");
    expect(kitServer).toContain("return send(404, { error: 'not_found' });");
    expect(kitServer.split("send(409, { error: 'busy' })").length - 1).toBe(2);
    expect(kitServer).toContain("return send(409, { error: 'busy', message: BUSY_TEXT });");
    expect(kitServer).toContain("return send(500, { error: 'internal' });");
    expect(errors).toContain(`- A refusal of status 500 or more gets a fixed message, \`${operatorsText('<code>')}\`, because the runtime copies the first 200 characters of a failure to the buyer, and the detail is the operator's. \`shutting_down\` has the fixed message \`${STOPPING_TEXT}\`, and the 409 \`busy\` of the hook has the fixed message \`${BUSY_TEXT}\`.`);
    expect(errors).toContain('- The messages of `duplicate_rfq` and `deadline` are fixed texts that hold no value of the request.');
    // The `deadline` row names the time before deliver_by. The runtime stops waiting 30 s before deliver_by, so the job gives its quote while 30 s or more are left before deliver_by, and "30 s before the runtime stops waiting" would be 60 s before deliver_by.
    expect(statusRows(errors).find((line) => line.startsWith('| 422, the job |'))).toBe('| 422, the job | `deadline` (the caller hung up before the model hire or before the record in the book, or less than 30 s are left before `deliver_by`) |');
    expect(errors).toContain('- A refusal of the hook leaves the funded escrow Open. A job that fails after the Claim does not Submit a quote, so the escrow stays Claimed. The lock does not return automatically.');
    expect(readme).toContain('A Reclaim after `deliver_by` returns its full lock as a separate `Returned` vault output.');
    expect(errors).toContain('- The Bid Desk calls no mock system, so a failed job can leave behind a model hire and nothing else. A job that fails after the service accepted the model hire has paid the model supplier from the service key. A hire that stays unfinished is in the stranded file of the service key, and the janitor settles it.');
    expect(readme).toContain('A job that fails after it accepted the model hire has paid the model supplier from the service key.');
    expect(STRANDED_FILE).toBe('stranded.json');
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
    expect(errors).toContain('- A Bid Desk is the hired side. The service answers 200 only when it made a quote, and the 200 answer is the quote. Every code of the table is a refusal or a failure of the job or of the request, and the runtime turns it into the answer that the buyer reads.');
    expect(readme).toContain('The reason is that the runtime\'s fetch gives up after 300 s of silence.');
  });
});

describe('specs/bid-desk.md: the receipt, the claim and the fault switch', () => {
  test('the receipt: the runtime signs it, its model is the model of each advert, the quote is the committed output, and a challenge on S1 names the hash of the quote', async () => {
    const receipt = section('What the receipt commits to');
    expect(receipt).toContain('The service signs no receipt. The runtime builds and signs the receipt, and submits its hash in the Submit transaction.');
    expect(row(receipt, '`escrow_ref`')).toBe('| `escrow_ref` | the escrow UTxO, `<txid>#<index>` |');
    expect(row(receipt, '`supplier_pkh`')).toBe('| `supplier_pkh` | the key hash of the supplier key of the runtime of the Bid Desk that took the job |');
    expect(row(receipt, '`prompt_hash`')).toBe('| `prompt_hash` | sha256 of the UTF-8 bytes of the wire payload, as the buyer committed it in the escrow datum |');
    expect(row(receipt, '`response_hash`')).toBe('| `response_hash` | sha256 of the UTF-8 bytes of the quote exactly as the service returned them |');
    // The model of a receipt is the model of its advert, and the model of each of the three adverts is bid-desk-v1.
    expect(row(receipt, '`model`')).toBe(`| \`model\` | \`${BID_DESK_MODEL}\` |`);
    const runbook = readFileSync(`${root}deploy/server/RUNBOOK-bid-desk.md`, 'utf8').split('\n');
    for (const instance of INSTANCES) expect(runbook, instance).toContain(`| \`${instance}\` | \`${BID_DESK_MODEL}\` | 1 | 1 and 1 | 3 |`);
    expect(row(receipt, '`prompt_tokens`, `completion_tokens`')).toBe('| `prompt_tokens`, `completion_tokens` | 0 and 0, the runtime counts none. The token counts of the model hire are in the sub-receipt under `decisions[0].inference.sub_job` |');
    expect(row(receipt, '`wallclock_ms`')).toBe('| `wallclock_ms` | how long the service call took |');
    expect(receipt).toContain(`who sent the request, the ${QUOTE_CHECKS.length} checks, and the pricing decision with its reasoning and the sub-receipt of the model supplier.`);
    expect(receipt).toContain('The signed receipt of the job is the signed quote, and the quote is the committed output.');
    expect(receipt).toContain('It does not hold the Bid Desk to the quote: a quote is not a binding offer (see Known gaps).');
    expect(receipt).toContain('The signature is Ed25519 over the canonical JSON of the receipt. The sha256 of the canonical JSON of `{ receipt, signature }` is the `result_receipt_hash` in the Submitted escrow datum.');
    // A challenge on S1 uses the hash of the quote text: the facts of the evidence name it next to the hash of the list and the line that differs from the list.
    const quote = await alfaQuote('quote_off_price_list');
    const [first] = lineChecks(quote, loadPriceList(priceListFileOf('alfa')).list);
    const facts = must(quotePriceFacts({ line: first, price_list_sha256: quote.price_list_sha256, quote_sha256: sha256(JSON.stringify(quote)) }));
    expect(Object.keys(facts)).toStrictEqual(['kind', 'sku', 'quantity', 'quoted_unit_price', 'listed_unit_price', 'price_list_sha256', 'quote_sha256']);
    expect(facts).toMatchObject({ kind: 'quote_price', sku: 'GLV-NIT-M', quantity: 100, quoted_unit_price: 100, listed_unit_price: 125 });
    expect(EVIDENCE_STATEMENTS.quote_price).toBe('S1');
    expect(receipt).toContain('The sha256 of the quote text is what a challenge uses. The evidence of a challenge on S1 names that hash as `quote_sha256`, with the hash of the price list (`price_list_sha256`), the SKU and the quantity of the line, the unit price that the quote gives and the unit price that the list gives.');
  });

  test('the claim statements are the constants of the kit, the three manifests hold the same three texts, and no source of the service stakes a claim', () => {
    const claim = section('Claim statements');
    const table = claim.split('\n').filter((line) => /^\| S[123] \|/.test(line));
    expect(table).toStrictEqual(BID_DESK_CLAIM.statements.map((statement) => `| ${statement.id} | ${statement.text} |`));
    for (const instance of INSTANCES) expect(manifests[instance].behaviour.claim.statements, instance).toStrictEqual(BID_DESK_CLAIM.statements);
    expect(BID_DESK_CLAIM.statements.map((statement) => statement.id)).toStrictEqual(['S1', 'S2', 'S3']);
    expect(claim).toContain(`The service stakes no claim: no code of the service calls the staking. No command of this repository stakes a claim for this agent yet. Until one does, a challenge against it ends with \`${NO_OPEN_CLAIM}\`. The design is a Module-1 claim for each Bid Desk and each run. The operator stakes it with the service key of that Bid Desk before the run, once such a command exists: ${CLAIM_STAKE_LOVELACE / 1_000_000n} units, which is ${CLAIM_STAKE_LOVELACE} lovelace, with a challenge window of ${CLAIM_WINDOW_MS / 3_600_000} hours. After the window, the operator withdraws the claim when nobody challenged it.`);
    expect(claim).toContain('The claim has three statements, and the three Bid Desks have the same three. The manifest of each holds the same three texts in `behaviour.claim`, with no reference to a claim. A challenge names the text of a statement.');
    expect(sources.filter(([, text]) => text.includes('stakeRunClaim')).map(([file]) => file)).toStrictEqual([]);
    // No command of this repository stakes a claim for a Bid Desk: the operator pack has no use case 3 data, and no file of the pack that is not a test names a Bid Desk. A command that does must change this page.
    const packDir = new URL('../../../scripts/operator/', import.meta.url);
    const pack = (readdirSync(packDir, { recursive: true }) as string[]).map(String).filter((file) => file.endsWith('.ts') && !file.startsWith('test/') && !file.includes('node_modules'));
    expect(pack.length).toBeGreaterThan(5);
    expect(pack.filter((file) => /bid[-_ ]?desk/i.test(readFileSync(new URL(file, packDir), 'utf8')))).toStrictEqual([]);
    expect(NO_OPEN_CLAIM).toBe('no_open_claim');
    expect(envExample.split('\n').filter((line) => line.startsWith('DISPUTE_'))).toStrictEqual([]);
    // S1 is the statement of the evidence of a quote challenge, and the Sourcing Agent challenges the first statement of this claim.
    expect(EVIDENCE_STATEMENTS.quote_price).toBe('S1');
    expect(readFileSync(new URL('../../sourcing-agent/src/quotes/evidence.ts', import.meta.url), 'utf8')).toContain('statement_text: BID_DESK_CLAIM.statements[0].text,');
    expect(claim).toContain('S1 is the statement that the fault `quote_off_price_list` breaks. A buyer\'s agent that finds a unit price that differs from the published list declines the quote and challenges the claim of the Bid Desk on S1. The Sourcing Agent does this. S2 is held by the member `rfq_sha256` of the quote, and S3 by the book of the Bid Desk (see What it checks before the Claim).');
  });

  test('the Fault switch names the one value of the kit, a unit price a fifth below the list on the first line that the list prices, and the field that every quote carries', async () => {
    const fault = section('Fault switch');
    expect(FAULT_MODES['bid-desk']).toStrictEqual(['quote_off_price_list']);
    for (const instance of INSTANCES) expect(manifests[instance].behaviour.fault_modes, instance).toStrictEqual(['quote_off_price_list']);
    expect(fault).toContain('`FAULT_MODE=quote_off_price_list`: the unit price of the first line that the price list prices is lowered by a fifth of the listed price, rounded up, and every check of the hook still passes. The new price is `listed - ceil(listed / 5)`, where `listed` is the price of the list for the SKU and the quantity of that line. The totals follow the changed line.');
    // The new price: the listed price less a fifth of it, rounded up. No price of the three files is below 10, so the new price is at least 1 and below the listed price.
    expect([faultyPriceOf(125), faultyPriceOf(140), faultyPriceOf(11), faultyPriceOf(2)]).toStrictEqual([100, 112, 8, 1]);
    const prices = INSTANCES.flatMap((instance) => loadPriceList(priceListFileOf(instance)).list.items.flatMap((entry) => entry.breaks.map((step) => step.unit_price)));
    expect(Math.min(...prices)).toBeGreaterThanOrEqual(10);
    expect(fault).toContain('The new price is below the listed price and at least 1, because no price of the three files is below 10.');
    // The fault run of the example: the first line has the price 100 and not the listed 125, the totals follow, and the decision on record stays what the model said.
    const clean = await alfaQuote('');
    const faulty = await alfaQuote('quote_off_price_list');
    expect(clean.lines[0].unit_price).toBe(125);
    expect(faulty.lines[0]).toMatchObject({ sku: 'GLV-NIT-M', unit_price: 100, line_total: 10_000 });
    expect([faulty.total, faulty.fault_mode, clean.fault_mode]).toStrictEqual([19_400, 'quote_off_price_list', '']);
    expect(faulty.lines.slice(1)).toStrictEqual(clean.lines.slice(1));
    expect(faulty.decisions).toStrictEqual(clean.decisions);
    expect(faulty.checks).toStrictEqual(clean.checks);
    expect(fault).toContain('For the request of the example under Request and the price list of Bid Desk Alfa, the quote of a fault run has the unit price 100 on its first line (the listed price is 125), the line total 10000 and the total 19400, and its `fault_mode` is `quote_off_price_list`. The decision on record stays what the model said.');
    // The first line that the list prices: a first line that the list does not carry keeps its price, and the second line gets the new one.
    const second = makeRig({ mode: 'quote_off_price_list', rfq: { items: [{ sku: 'NO-SUCH-SKU', quantity: 3 }, { sku: 'GLV-NIT-M', quantity: 100 }] } });
    second.decision = accepted(decisionOf(choiceOf({ lines: [{ sku: 'NO-SUCH-SKU', quantity: 3, unit_price: 50, lead_time_days: 3 }, { sku: 'GLV-NIT-M', quantity: 100, unit_price: 125, lead_time_days: 14 }] })));
    expect((await second.run()).lines.map((line) => line.unit_price)).toStrictEqual([50, 100]);
    // When no line can take the new price, the job ends internal: a run never says that a fault was on when it changed nothing.
    const none = makeRig({ mode: 'quote_off_price_list', rfq: { items: [{ sku: 'NO-SUCH-SKU', quantity: 3 }] } });
    none.decision = accepted(decisionOf(choiceOf({ lines: [{ sku: 'NO-SUCH-SKU', quantity: 3, unit_price: 50, lead_time_days: 3 }] })));
    expect(await refusalOf(none.run())).toMatchObject({ code: 'internal', status: 500 });
    expect(none.booked).toHaveLength(0);
    expect(fault).toContain('When no line can take the new price, the job ends with `internal` (500): a run never says that a fault was on when it changed nothing.');
    // The failure run is a plan. The operator pack has the data of use case 1 only, so no command runs use case 3: the data file of another use case fails this test and forces a change of the page.
    expect([...USE_CASE_NAMES]).toStrictEqual(['inventory-reorder']);
    expect(fault).toContain('The planned failure run sets the switch on one Bid Desk only, Bid Desk Charlie, to show that the Sourcing Agent catches a quote that is below the published price list. No command of this repository runs use case 3 yet. The switch of one Bid Desk never changes another: each Bid Desk reads an env file of its own.');
  });

  test('the switch is empty in a clean run, any other value stops the start, the hook does not know the switch, and the manifest is the same for every value', () => {
    const fault = section('Fault switch');
    expect(faultOf({ FAULT_MODE: '' }).mode).toBe('');
    expect(faultOf({ FAULT_MODE: 'quote_off_price_list' }).mode).toBe('quote_off_price_list');
    expect(() => faultOf({ FAULT_MODE: 'alter_after_approval' })).toThrow(/FAULT_MODE/);
    expect(envExample.split('\n')).toContain('FAULT_MODE=');
    expect(sources.filter(([file, text]) => file.startsWith('checks/') && /FAULT_MODE|readFault|quote_off_price_list|FaultSwitch/.test(text)).map(([file]) => file)).toStrictEqual([]);
    for (const instance of INSTANCES) {
      expect(JSON.stringify(manifestFromEnv({ ...settingsOf(instance), FAULT_MODE: 'quote_off_price_list' }, priceListOf(instance))), instance).toBe(JSON.stringify(manifests[instance]));
      expect(JSON.stringify(manifests[instance]).includes('"fault_mode"')).toBe(false);
    }
    expect(fault).toContain('The switch is empty in a clean run. Any other value stops the start of the service. The switch changes what the job writes and never a check: the hook does not know that it exists.');
    expect(fault).toContain('It is declared in the manifest, in `behaviour.fault_modes`, and the manifest is the same for every value. Each quote returns the active value as `fault_mode`, its last member.');
    expect(faultGap('bid-desk')).toBe(GAPS.at(-1));
  });

  test('Operator and data handling: the operator, the data sentence of the manifest, the three third parties, the two files of the state, and what the decision receives', async () => {
    const operator = section('Operator and data handling');
    for (const instance of INSTANCES) expect(manifests[instance].operator.name, instance).toBe('Apex Fusion Foundation');
    expect(operator).toContain('Operator: Apex Fusion Foundation. The contact is `operator.contact` in the manifest of each Bid Desk.');
    const parties = tableRows(operator, '| Party | What it receives |');
    expect(parties).toHaveLength(3);
    for (const instance of INSTANCES) {
      expect(parties.map(([name]) => name), instance).toStrictEqual(manifests[instance].behaviour.third_parties);
      expect(operator).toContain(manifests[instance].behaviour.data_handling);
      expect(manifests[instance].behaviour.relying_on.mock_systems).toStrictEqual([]);
    }
    expect(operator).toContain('The Bid Desk calls no mock system and no dispute service. What leaves to third parties:');
    // The state of the service: the two entries of the README, in its words.
    expect(STATE_DIR_DEFAULT).toBe('/data');
    expect(SETTINGS).toContain('BID_DESK_STATE_DIR');
    expect(STRANDED_FILE).toBe('stranded.json');
    expect(operator).toContain('The service keeps these files and folders in its state directory (`BID_DESK_STATE_DIR`, which is `/data` in the image):');
    const files = tableRows(operator, '| Path | What it holds |');
    expect(files.map(([path]) => path)).toStrictEqual(['`rfq-book.json`', '`keys/<key hash>/stranded.json`']);
    expect(files).toStrictEqual(tableRows(readme, '| Path | What it holds |'));
    // What the decision receives: the members of the input, in their order, and nothing of the request that names a party.
    expect(QUOTE_DECISION.name).toBe('quote');
    expect(row(operator, '`quote`')).toBe(
      '| `quote` | `today`, `request` (`items` and `needed_by`) and `price_list` (the entries for the SKUs of the items, each with `sku`, `lead_time_days` and `breaks`) | the identifier of the request (`rfq_id`), the sender, the delegation and every other member of the message, and the entries of the price list for other SKUs |',
    );
    const rig = makeRig();
    await rig.run();
    const input = membersOf(rig.decideInputs[0]);
    expect(Object.keys(input)).toStrictEqual(['today', 'request', 'price_list']);
    expect(Array.isArray(input.price_list) ? input.price_list.map((entry) => Object.keys(membersOf(entry))) : []).toStrictEqual([['sku', 'lead_time_days', 'breaks'], ['sku', 'lead_time_days', 'breaks'], ['sku', 'lead_time_days', 'breaks']]);
    const one = makeRig({ rfq: { items: [{ sku: 'MSK-N95', quantity: 5 }] } });
    await refusalOf(one.run());
    expect(membersOf(one.decideInputs[0]).price_list).toHaveLength(1);
    // The text of the request and of the list reaches the model inside the marked data block only, and the fixed instruction holds none of it.
    const prompt = must(buildPrompt(QUOTE_DECISION, rig.decideInputs[0]));
    const open = prompt.indexOf(INPUT_OPEN);
    expect(open).toBeGreaterThan(0);
    for (const text of ['GLV-NIT-M', 'SYR-10ML', 'MSK-N95', '2026-12-20']) {
      expect(prompt.slice(0, open), text).not.toContain(text);
      expect(prompt.slice(open), text).toContain(text);
    }
    expect(operator).toContain('The text of the request and of the price list reaches the model only inside the marked data block, and never inside an instruction.');
    // The service reads the ledger and posts its escrows through four settings, and its start makes no call of its own to a third party. The first pass of its janitor is the one thing that it does at start (the next test).
    for (const name of ['VECTOR_OGMIOS_URL', 'VECTOR_KOIOS_URL', 'VECTOR_SUBMIT_URL', 'VECTOR_MARKETPLACE_INDEXER_URL']) expect(SETTINGS, name).toContain(name);
    expect(readme).toContain('The start makes no call of its own to a third party.');
    expect(readme).toContain(`The start makes no call of its own to a third party. The janitor runs its first pass at once, and then one pass every ${JANITOR_INTERVAL_MS / 1000} s. A pass reads the ledger for each escrow of the stranded file that is due, and it can submit a Reclaim, or one more Accept.`);
    expect(operator).toContain(
      `To post and settle its escrows for the model hire, the service reads the ledger through the node (Ogmios) and the Koios indexer, submits its transactions through the submit API, and finds the model suppliers on the marketplace indexer. At start the service makes no call of its own to a third party. The janitor of the service key runs its first pass at once, and then one pass every ${JANITOR_INTERVAL_MS / 1000} s. A pass reads the ledger for each escrow of the stranded file that is due, and it can submit a Reclaim, or one more Accept, through the submit API. When the stranded file holds no escrow that is due, a pass makes no call.`,
    );
  });

  test('the first pass of the janitor runs at once when the service starts: it reads the ledger for an escrow of the stranded file that is due and submits a Reclaim, and it does not wait for the interval', async () => {
    const world = makeServiceWorld();
    // A model hire that a stopped service left behind: an Open escrow of the stub marketplace, posted from the service key, whose deliver_by has passed. The stranded file of the key names it.
    const posted = await world.m.chain.postEscrow({ advertRef: LLM_ADVERT_REF, promptHash: 'ab'.repeat(32) });
    world.m.clock.now = posted.deliverBy + JANITOR_GRACE_MS;
    const folder = join(world.stateDir, 'keys', SERVICE.pkh);
    mkdirSync(folder, { recursive: true });
    const stranded = join(folder, STRANDED_FILE);
    writeFileSync(stranded, JSON.stringify([{ escrow_ref: posted.escrowRef, deliver_by: posted.deliverBy, posted_at: posted.postedAt, kind: 'llm' }]));
    expect(await world.m.chain.escrowState(posted.escrowRef)).toBe('Open');
    // The interval of the world is one hour, so a second pass cannot come inside this test: the Reclaim is the work of the first pass.
    expect(world.options.janitorIntervalMs).toBe(3_600_000);
    expect(JANITOR_INTERVAL_MS).toBe(60_000);
    try {
      await serve(world, async () => {
        await until(() => world.logs.some((line) => line.includes('janitor: reclaimed')), 'the first pass has reclaimed the escrow');
        expect(await world.m.chain.escrowState(posted.escrowRef)).toBe('spent');
        expect(JSON.parse(readFileSync(stranded, 'utf8'))).toStrictEqual([]);
      });
    } finally {
      cleanDirs();
    }
    expect(readFileSync(new URL('../../../packages/hire-kit/src/janitor.ts', import.meta.url), 'utf8')).toContain('Runs a pass at once and then one every `intervalMs` after the last one ended');
  });

  test('Known gaps: the eight sentences of the manifest, word for word and in order, with the sentence about the keys, the run-in lead of what no run shows, and the sentence of the kit about the fault switch', () => {
    const known = section('Known gaps');
    const lines = known.split('\n').filter((line) => line.startsWith('- '));
    expect(lines).toStrictEqual(GAPS.map((gap) => `- ${gap}`));
    for (const instance of INSTANCES) expect(manifests[instance].gaps, instance).toStrictEqual([...GAPS]);
    expect(lines).toHaveLength(8);
    // The five gaps of the page, the keys of the parties, what no run shows, and the one sentence of the kit about the fault switch.
    expect(lines.slice(0, 5)).toStrictEqual(PAGE_GAPS.map((gap) => `- ${gap}`));
    expect(lines[5]).toBe(`- ${CONTROLLER_GAP}`);
    expect(lines[6]).toBe(`- ${NOT_SHOWN_GAP}`);
    expect(lines[7]).toBe(`- ${faultGap('bid-desk')}`);
    // The keys: the controller key, the Accountable key and the guardian keys are on one host of one operator.
    expect(lines[5]).toBe('- The controller key of this deployment, the Accountable key and the guardian keys are on one host of one operator, so a party is independent of the controller by key only.');
    // What no run shows: one run-in lead, and the three items, among them the reclaim of an escrow in use case 3.
    expect(page.split('What this does not show:').length - 1).toBe(1);
    expect(lines[6].startsWith('- What this does not show: ')).toBe(true);
    for (const item of ['the refund of the escrow of a revoked agent', 'the reclaim of an escrow in use case 3', 'a relying party that refuses a live token after its authority ends']) expect(lines[6], item).toContain(item);
    expect(known).toContain('The manifest states these eight, in this order, word for word. A test keeps them equal to `GAPS` in `agents/bid-desk/src/serve/gaps.ts`.');
    expect(known).toContain('The first five are the gaps of the agent. The sixth says whose keys the parties are. The seventh starts with a run-in lead and names three things that no run of use case 3 (supplier bid evaluation) covers. The eighth is the sentence of the kit about the fault switch.');
    // The fourth gap names the compliance attestation. The Sourcing Agent reads it (type 0), the Bid Desk reads none, and nothing in this repository issues it.
    expect(known).toContain('The fourth gap names the compliance attestation of a Bid Desk: an identity attestation (type 0) that the compliance registry issues about it. The Bid Desk does not read it. Only the Sourcing Agent reads it. Nothing in this repository issues it.');
    expect(readFileSync(new URL('../../sourcing-agent/src/compliance/read.ts', import.meta.url), 'utf8')).toContain('export const COMPLIANCE_ATT_TYPE = 0;');
    expect(sources.filter(([, text]) => /attestation/i.test(text)).map(([file]) => file)).toStrictEqual(['serve/gaps.ts']);
    const everySource = repoSources([...srcFoldersOf('agents'), ...srcFoldersOf('packages'), 'scripts']);
    expect(everySource.length).toBeGreaterThan(100);
    const readers = everySource.filter(([, text]) => /\bCOMPLIANCE_ATT_TYPE\b|\breadCompliance\b/.test(text)).map(([file]) => file);
    expect(readers.length).toBeGreaterThan(0);
    expect(readers.filter((file) => !file.startsWith('agents/sourcing-agent/src/'))).toStrictEqual([]);
    // The one function that builds an attestation is called by the task `attest` of the operator pack (provenance and software), by the checks (approval and principal binding), and by nothing else.
    expect(everySource.filter(([, text]) => text.includes('buildAttest(')).map(([file]) => file).sort()).toStrictEqual([
      'packages/buyer-core/src/vendored/mcp/attestation-build.ts', 'scripts/checks/lib/check-attestations.ts', 'scripts/operator/tasks/attest.ts',
    ]);
    expect(readFileSync(`${root}scripts/operator/lib/contract.ts`, 'utf8')).toContain("readonly types: readonly ('provenance' | 'software')[]");
    expect(readFileSync(`${root}scripts/checks/lib/check-attestations.ts`, 'utf8')).toContain("type: 'approval' | 'principal_binding';");
  });
});

describe('specs/bid-desk.md: the hire, the headings, the changelog and the links', () => {
  test('How to hire it sends the reader to the Sourcing Agent, says what the hook refuses, and says that each Bid Desk has an advert and a book of its own', () => {
    const how = section('How to hire it');
    expect(how).toContain('No advert exists yet, so no buyer can hire a Bid Desk today.');
    expect(how).toContain("A buyer's agent hires a Bid Desk from the vault of a delegation. A hire without a delegation of the sender, or without a payment from its vault, is refused by the hook before the Claim.");
    // Each of the two refusals is a code of the hook, and the check of the vault comes after the checks of the delegation.
    const codes: string[] = [...COUNTERPARTY_REFUSALS['bid-desk']];
    expect(['delegation_invalid', 'not_vault_paid'].map((code) => codes.indexOf(code))).toStrictEqual([3, 5]);
    // Each Bid Desk has a volume of its own, and its book is the file `rfq-book.json` of that volume, so the same request can go to the three.
    expect(INSTANCES.map((instance) => composes[instance].services.service.volumes?.[0])).toStrictEqual(INSTANCES.map((instance) => `bid-desk-${instance}-state:/data`));
    expect(sources.some(([file, text]) => file === 'serve/wiring.ts' && text.includes("new FileRfqBook(join(config.stateDir, 'rfq-book.json'))"))).toBe(true);
    expect(how).toContain("Each Bid Desk has its own advert and its own book of answered requests, so a buyer's agent can send one request, with one `rfq_id`, to each of the three Bid Desks, with one hire for each advert.");
    expect(how).toContain('To see the Bid Desks work, hire the [Sourcing Agent](sourcing-agent.md). It hires Bid Desks for quotes on one request for quotation, and it proposes a ranking of the quotes to its hirer. The steps to hire the Sourcing Agent are on its page.');
    expect(existsSync(join(root, 'specs/sourcing-agent.md'))).toBe(true);
  });

  test('the page has the thirteen headings of its profile in order, and Interface has the six sub-headings that the tests above read', () => {
    expect([...page.matchAll(/^## (.+)$/gm)].map((hit) => hit[1])).toStrictEqual([
      'Status', 'Identity', 'Capability id', 'Terms', 'Interface', 'What the receipt commits to', 'Claim statements', 'Fault switch', 'Operator and data handling', 'Known gaps', 'How to hire it', 'Changelog', 'Links',
    ]);
    expect([...page.matchAll(/^### (.+)$/gm)].map((hit) => hit[1])).toStrictEqual(['Request', 'What it checks before the Claim', 'What it does', 'Response', 'The price list', 'Errors']);
  });

  test('the Changelog is the version of the manifest, and the Links name files that exist, the three price lists, and the page of the Sourcing Agent', () => {
    expect(template.version).toBe('0.1.0');
    for (const instance of INSTANCES) expect(manifests[instance].version, instance).toBe('0.1.0');
    expect(section('Changelog').trim()).toBe(`- ${template.version}, ${PAGE_DATE}: built`);
    const links = section('Links');
    const targets = [...links.matchAll(/\]\(\.\.\/([^)]+)\)/g)].map((hit) => hit[1]);
    for (const target of targets) expect(existsSync(root + target), target).toBe(true);
    for (const [, label, target] of links.matchAll(/\[([^\]]+)\]\(\.\.\/([^)]+)\)/g)) expect(label, target).toBe(target);
    expect(targets).toStrictEqual(['agents/bid-desk/agent.json.template', ...INSTANCES.map((instance) => `agents/bid-desk/price-lists/${instance}.json`), 'agents/bid-desk', 'deploy/server/RUNBOOK-bid-desk.md']);
    expect(links).toContain('Manifest: `GET /agent.json` on the public URL of each Bid Desk, once the agent is deployed. The service renders it from its environment when it starts.');
    expect(links).toContain('Price lists: `GET /price-list.json` on the public URL of each Bid Desk, with the bytes of ');
    // The page of the buyer-side agent is the page of the agent whose folder is in the repository.
    expect(links).toContain('- Buyer-side agent: [Sourcing Agent](sourcing-agent.md)');
    for (const instance of INSTANCES) {
      expect(manifests[instance].links.source.endsWith('/agents/bid-desk'), instance).toBe(true);
      expect(manifests[instance].links.spec.endsWith('/specs/bid-desk.md'), instance).toBe(true);
    }
  });
});
