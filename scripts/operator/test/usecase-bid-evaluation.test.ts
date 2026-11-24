// Hold the supplier bid evaluation data to the kit, the public specs and deployment files, and the mock service. These tests start no service.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { NOT_SHOWN_GAP as BID_DESK_GAP } from '../../../agents/bid-desk/src/serve/gaps.ts';
import { manifestFromEnv as bidDeskManifest } from '../../../agents/bid-desk/src/serve/manifest.ts';
import * as bidDeskSettings from '../../../agents/bid-desk/src/serve/settings.ts';
import { SETTINGS as BID_DESK_SETTINGS } from '../../../agents/bid-desk/src/serve/start.ts';
import { PRICE_LIST_SHA256, priceListOf } from '../../../agents/bid-desk/test/serve/support.ts';
import { NOT_SHOWN_GAP as SOURCING_GAP } from '../../../agents/sourcing-agent/src/serve/gaps.ts';
import { KEY_ROLES as SOURCING_KEY_ROLES } from '../../../agents/sourcing-agent/src/serve/keys.ts';
import * as sourcingSettings from '../../../agents/sourcing-agent/src/serve/settings.ts';
import { SETTINGS as SOURCING_SETTINGS } from '../../../agents/sourcing-agent/src/serve/start.ts';
import { FakeChain } from '../../../packages/buyer-core/src/index.ts';
import { DAYS_7_MS, MIN_RECORD_LOVELACE, REASON_DISPUTE_VERDICT } from '../../../packages/buyer-core/src/vendored/mcp/identity-rules.ts';
import { BID_DESK_MODEL, SOURCING_MODEL } from '../../../packages/usecase-kit/src/bids/index.ts';
import { MAX_CLAIM_TYPE_BYTES } from '../../../packages/usecase-kit/src/dispute/index.ts';
import { renderManifest } from '../../../packages/usecase-kit/src/manifest/index.ts';
import { FAULT_MODES } from '../../../packages/usecase-kit/src/protocol/faults.ts';
import { defaultSeed, parseSeed } from '../../../services/mock-systems/src/seed.ts';
import { CHALLENGE_RESERVE_LOVELACE, CLAIM_STAKE_LOVELACE, CLAIM_WINDOW_MS } from '../lib/claim-constants.ts';
import type { AdvertSpec, AgentSpec, KeyLine, KeyUse, UseCase } from '../lib/contract.ts';
import { BID_CAPABILITIES, BID_DESK_CLAIM, SOURCING_CLAIM } from '../lib/platform.ts';
import { loadRegistry, makeMissingKeys } from '../lib/registry.ts';
import data from '../usecases/bid-evaluation.ts';
import { ALFA, BRAVO, CHARLIE, DELTA, DEMONSTRATION_SENTENCE, ECHO, partiesOf } from '../usecases/shared.ts';
import { makeKeyRoot, makeTestKeys, removeTestKeys } from './support/keys.ts';

afterAll(removeTestKeys);

const DESKS = [
  { instance: 'alfa', runtimePort: 8108, servicePort: 9106 },
  { instance: 'bravo', runtimePort: 8109, servicePort: 9107 },
  { instance: 'charlie', runtimePort: 8110, servicePort: 9108 },
] as const;
const DESK_IDS = DESKS.map(({ instance }) => `bid-desk-${instance}`);
const SOURCING_ID = 'sourcing-agent';
const AGENT_IDS = [SOURCING_ID, ...DESK_IDS];
const SCORERS = ['scorer-1', 'scorer-2', 'scorer-3'];
const UNIT = 1_000_000n;

const read = (path: string): string => readFileSync(new URL(`../../../${path}`, import.meta.url), 'utf8');
const json = <T>(path: string): T => JSON.parse(read(path)) as T;
const sorted = (values: readonly string[]): string[] => [...values].sort();
const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');
function need<T>(value: T | undefined | null, what: string): T {
  if (value === undefined || value === null) throw new Error(`Missing ${what}`);
  return value;
}

const PAGES = {
  'bid-desk': read('specs/bid-desk.md'),
  'sourcing-agent': read('specs/sourcing-agent.md'),
};

const agentOf = (id: string): AgentSpec => need(data.agents.find((agent) => agent.id === id), id);
function advertOf(agent: AgentSpec): AdvertSpec {
  expect(agent.adverts, agent.id).toHaveLength(1);
  return need(agent.adverts[0], `${agent.id} advert`);
}
const lockOf = (advert: AdvertSpec): bigint => advert.priceLovelace + advert.supplierBondLovelace + advert.buyerBondLovelace;

interface ComposeService {
  container_name: string;
  environment: Record<string, string>;
  ports: string[];
  env_file: { path: string; required: boolean }[];
}
interface Compose {
  name: string;
  services: { runtime: ComposeService; service: ComposeService };
}
interface Template {
  name: string;
  capability_id: string;
  keys: Record<string, string | string[]>;
  interface: { routes: Record<string, string> };
  terms: { price_lovelace: number; supplier_bond_lovelace: number; buyer_bond_lovelace: number; max_processing_ms: number };
  behaviour: { claim: typeof BID_DESK_CLAIM; fault_modes: string[]; cosign?: { route: string }; price_list?: { uri: string; sha256: string } };
  gaps: string[];
}
interface DeploymentPack {
  exampleFile: string;
  exampleText: string;
  example: Record<string, string>;
  compose: Compose;
  template: Template;
  caddy: string;
  runbook: string;
}

function exampleOf(text: string): Record<string, string> {
  const entries = Array.from(text.matchAll(/^([A-Z][A-Z0-9_]*)=(.*)$/gm), ([, name, value]) => [name, value] as const);
  expect(new Set(entries.map(([name]) => name)).size, 'duplicate env lines').toBe(entries.length);
  return Object.fromEntries(entries);
}
function tableRows(text: string): string[][] {
  return text.split('\n').filter((row) => row.startsWith('| ')).map((row) => row.split('|').slice(1, -1).map((cell) => cell.trim().replaceAll('`', '')));
}

function sectionOf(page: string, title: string): string {
  return need(page.split(`\n## ${title}\n`)[1], `${title} section`).split('\n## ', 1)[0];
}

const fieldOf = (rows: readonly string[][], label: string): string => need(rows.find(([name]) => name === label)?.[1], `${label} row`);

function purposesOf(row: string): string[] {
  const clause = need(/\bin the record for (?:the )?([a-z, ]+?) purposes?\b/i.exec(row)?.[1], 'record key purpose list');
  return sorted(clause.toLowerCase().split(/,\s*(?:and\s+)?|\s+and\s+/).map((purpose) => purpose.trim()));
}

function expectSigningPurposes(agent: AgentSpec, rows: readonly string[][]): void {
  for (const [role, name] of [['Supplier key', advertOf(agent).supplierKey], ['Service key', agent.serviceKey]]) {
    const key = need(agent.keys.find(({ key }) => key === name), `${agent.id} ${role}`);
    expect(sorted(key.purposes), `${agent.id} ${role}`).toEqual(purposesOf(fieldOf(rows, role)));
  }
}

const domainOf = (agent: AgentSpec): string => need(data.organisations.find(({ id }) => id === agent.organisation), `${agent.id} organisation`).domain;

function readPack(project: string, kind: 'bid-desk' | 'sourcing-agent'): DeploymentPack {
  const exampleFile = `.env.${kind}.example`;
  const exampleText = read(`deploy/server/${exampleFile}`);
  return {
    exampleFile, exampleText, example: exampleOf(exampleText),
    compose: parseYaml(read(`deploy/server/docker-compose.${project}.yml`)) as Compose,
    template: json<Template>(`agents/${kind}/agent.json.template`),
    caddy: read(`deploy/server/Caddyfile.${kind}.snippet`),
    runbook: read(`deploy/server/RUNBOOK-${kind}.md`),
  };
}

function expectHost(agent: AgentSpec, compose: Compose, runtimePort: number, servicePort: number, insidePort: number): void {
  const advert = advertOf(agent);
  const { runtime, service } = compose.services;
  expect(compose.name).toBe(agent.id);
  expect(agent.folder).toBe(compose.name);
  expect(Object.keys(compose.services).sort()).toEqual(['runtime', 'service']);
  expect(runtime.container_name).toBe(advert.runtimeContainer);
  expect(service.container_name).toBe(agent.serviceContainer);
  expect(runtime.ports).toEqual([`127.0.0.1:${runtimePort}:8080`]);
  expect(service.ports).toEqual([`127.0.0.1:${servicePort}:${insidePort}`]);
  expect(runtime.environment).toMatchObject({
    PORT: '8080', PUBLIC_ORIGIN: agent.endpoint, CAPABILITY_KIND: 'custom', RELEASE_WATCHER: '1',
    SERVICE_URL: `http://${agent.serviceContainer}:${insidePort}/`, SERVICE_PRECHECK_URL: `http://${agent.serviceContainer}:${insidePort}/precheck`,
  });
  expect(service.environment.HOST).toBe('0.0.0.0');
  expect(advert.origin).toBe(agent.endpoint);
  expect(new URL(agent.endpoint).origin).toBe(agent.endpoint);
  expect(new URL(agent.endpoint).protocol).toBe('https:');
}

function expectCaddy(agent: AgentSpec, caddy: string, port: number, serviceRoutes: readonly string[]): void {
  const lines = caddy.split('\n').map((row) => row.trim()).filter(Boolean);
  const begin = `# ${agent.id} vhosts (BEGIN)`;
  const end = `# ${agent.id} vhosts (END)`;
  expect(lines.filter((line) => line === begin || line === end)).toEqual([begin, end]);
  expect(lines.slice(lines.indexOf(begin) + 1, lines.indexOf(end))).toEqual([
    `${new URL(agent.endpoint).host} {`,
    ...serviceRoutes.flatMap((route) => [`handle ${route} {`, `reverse_proxy ${agent.serviceContainer}:${port}`, '}']),
    'handle {', `reverse_proxy ${advertOf(agent).runtimeContainer}:8080`, '}', '}',
  ]);
}

interface Module1Manifest {
  protocol_params: { min_claim_stake: number; min_challenge_window: number; max_challenge_window: number };
  verdict_policy: { auditor_wins: { duration_ms: number } };
}
const MODULE1 = json<Module1Manifest>('packages/buyer-core/test/fixtures/module1-mainnet-manifest.json');

function expectTerms(agent: AgentSpec, pack: DeploymentPack, claim: typeof BID_DESK_CLAIM, lockUnits: number, deadlineMs: number): void {
  const advert = advertOf(agent);
  const { compose, example, exampleText, runbook, template } = pack;
  expect(template.capability_id).toBe(agent.capability);
  expect(template.behaviour.claim).toEqual(claim);
  expect(agent.claim).toMatchObject({ claimType: agent.capability, stakeLovelace: CLAIM_STAKE_LOVELACE, windowMs: CLAIM_WINDOW_MS });
  expect(Buffer.byteLength(agent.claim.claimType)).toBeLessThanOrEqual(MAX_CLAIM_TYPE_BYTES);
  expect(agent.claim.stakeLovelace).toBe(BigInt(MODULE1.protocol_params.min_claim_stake));
  expect(agent.claim.windowMs).toBeGreaterThanOrEqual(MODULE1.protocol_params.min_challenge_window);
  expect(agent.claim.windowMs).toBe(MODULE1.protocol_params.max_challenge_window);
  expect(template.terms).toMatchObject({
    price_lovelace: Number(advert.priceLovelace), supplier_bond_lovelace: Number(advert.supplierBondLovelace),
    buyer_bond_lovelace: Number(advert.buyerBondLovelace), max_processing_ms: advert.windowMs,
  });
  expect(lockOf(advert)).toBe(BigInt(lockUnits) * UNIT);
  expect(advert.depositLovelace).toBe(2_500_000n);
  expect(advert.maxOutputTokens).toBe(0);
  const runtime = compose.services.runtime.environment;
  expect(Number(example.ADVERT_MAX_PROCESSING_MS)).toBe(advert.windowMs);
  expect(Number(runtime.ADVERT_MAX_PROCESSING_MS)).toBe(advert.windowMs);
  expect(Number(runtime.SERVICE_TIMEOUT_MS)).toBe(deadlineMs + 60_000);
  expect(advert.windowMs - Number(runtime.SERVICE_TIMEOUT_MS)).toBe(120_000);
  const times = tableRows(runbook).filter(([label]) => /^(Window of an advert|Window of the advert|Timeout of a runtime for its service|Timeout of the runtime for the service|Deadline of a job in a service|Deadline of a job in the service)$/.test(label));
  expect(times.map(([, value]) => Number(value.replaceAll(',', '').replace(/ ms$/, '')))).toEqual([advert.windowMs, Number(runtime.SERVICE_TIMEOUT_MS), deadlineMs]);
  expect(agent.statusUrls).toEqual([`${agent.endpoint}${template.interface.routes.status}`]);
  expect(agent.faultValues).toEqual(FAULT_MODES[agent.kind]);
  expect(agent.faultValues).toEqual(template.behaviour.fault_modes);
  expect(example.FAULT_MODE).toBe('');
  for (const fault of agent.faultValues) expect(exampleText).toContain(fault);
  expect(agent.cosign).toBe(template.behaviour.cosign !== undefined);
  expect(agent.cosign).toBe(Object.hasOwn(example, 'COSIGN_ALLOWLIST'));
}

const isKey = (name: string): boolean => /_(?:PRIV_KEY_HEX|PUB_KEY_HEX|PKH)$/.test(name) || name === 'SUPPLIER_ADDRESS';
const supplierFields = [['SUPPLIER_PRIV_KEY_HEX', 'secret'], ['SUPPLIER_PUB_KEY_HEX', 'pub'], ['SUPPLIER_PKH', 'pkh'], ['SUPPLIER_ADDRESS', 'address']] as const;
const pairFields = (prefix: string) => [[`${prefix}_PRIV_KEY_HEX`, 'secret'], [`${prefix}_PKH`, 'pkh']] as const;
function useKey(key: string, purposes: KeyUse['purposes'], file: string, fields: readonly (readonly [string, KeyLine['of']])[]): KeyUse {
  return { key, purposes, lines: fields.map(([name, of]) => ({ file, name, of })) };
}

function expectEnv(agent: AgentSpec, pack: DeploymentPack, settings: readonly string[]): void {
  const advert = advertOf(agent);
  const { example, compose, template } = pack;
  expect(agent.exampleEnvFile ?? `${agent.serviceEnvFile}.example`).toBe(pack.exampleFile);
  const envFile = [{ path: `./${agent.serviceEnvFile}`, required: true }];
  expect(compose.services.service.env_file).toEqual(envFile);
  expect(compose.services.runtime.env_file).toEqual(envFile);
  expect(advert.runtimeEnvFile).toBe(agent.serviceEnvFile);
  const own = agent.keys.flatMap((key) => key.lines);
  const children = data.subagents.filter((child) => child.parent === agent.id).flatMap((child) => child.keys.flatMap((key) => key.lines));
  const publicLines = agent.publicKeyLines.flatMap((entry) => entry.lines);
  const lines = [...own, ...children, ...publicLines];
  for (const entry of lines) {
    expect(entry.file, entry.name).toBe(agent.serviceEnvFile);
    if (entry.of === 'secret') expect(example[entry.name], entry.name).toBe('');
  }
  expect(sorted(lines.map((line) => line.name))).toEqual(sorted(Object.keys(example).filter(isKey)));
  expect(sorted(lines.filter((line) => !['SUPPLIER_PRIV_KEY_HEX', 'SUPPLIER_ADDRESS'].includes(line.name)).map((line) => line.name))).toEqual(sorted(settings.filter(isKey)));
  expect(sorted(Object.values(template.keys).flat())).toEqual(sorted([...own, ...publicLines]
    .filter((entry) => entry.of === 'pub' || entry.of === 'pkh').map((entry) => `<${entry.name}>`)));
  const runtimeEnv = compose.services.runtime.environment;
  const serviceEnv = compose.services.service.environment;
  const secretNames = lines.filter((entry) => entry.of === 'secret').map((entry) => entry.name);
  expect(sorted(Object.keys(runtimeEnv).filter((name) => name.endsWith('_PRIV_KEY_HEX')))).toEqual(sorted(secretNames.filter((name) => name !== 'SUPPLIER_PRIV_KEY_HEX')));
  for (const name of secretNames.filter((name) => name !== 'SUPPLIER_PRIV_KEY_HEX')) expect(runtimeEnv[name], name).toBe('');
  expect(Object.keys(serviceEnv).filter((name) => name.endsWith('_PRIV_KEY_HEX'))).toEqual(['SUPPLIER_PRIV_KEY_HEX']);
  expect(serviceEnv.SUPPLIER_PRIV_KEY_HEX).toBe('');
  for (const name of ['MOCK_PUBLIC_BASE', 'MOCK_MTLS_BASE']) expect(Object.hasOwn(example, name), name).toBe(agent.envManaged.mock);
  expect(Object.hasOwn(example, 'VECTOR_MODULE1_MANIFEST')).toBe(agent.envManaged.module1);
  for (const name of ['AGENT_DID', 'AGENT_ID', 'ADVERT_REF']) expect(example[name], name).toBe('');
}

const advertCells = (advert: AdvertSpec) => [
  advert.model, String(advert.priceLovelace / UNIT), `${advert.supplierBondLovelace / UNIT} and ${advert.buyerBondLovelace / UNIT}`, String(lockOf(advert) / UNIT),
];

describe('the Bid Desks', () => {
  it.each(DESKS)('holds $instance to its own deployment and the shared claim and terms', ({ instance, runtimePort, servicePort }) => {
    const id = `bid-desk-${instance}`;
    const agent = agentOf(id);
    const advert = advertOf(agent);
    const pack = readPack(id, 'bid-desk');
    const { compose, example, runbook, template } = pack;
    expect(agent).toMatchObject({ kind: 'bid-desk', organisation: instance, name: bidDeskSettings.INSTANCE_NAMES[instance], capability: BID_CAPABILITIES.quote });
    expect(template.name).toBe('<BID_DESK_NAME>');
    expect(template.behaviour.price_list).toEqual({ uri: '<PRICE_LIST_URI>', sha256: '<PRICE_LIST_SHA256>' });
    expect(bidDeskSettings.PORT_DEFAULT).toBe(9106);
    expect(read('agents/bid-desk/Dockerfile')).toMatch(/^ENV [^\n]*\bPORT=9106\b/m);
    expect(compose.services.service.environment).not.toHaveProperty('PORT');
    const organisation = need(data.organisations.find((org) => org.id === instance), `${instance} organisation`);
    const instanceSettings = { BID_DESK_INSTANCE: instance, BID_DESK_ORGANISATION: organisation.domain, BID_DESK_PUBLIC_ORIGIN: agent.endpoint };
    expect(compose.services.service.environment).toMatchObject(instanceSettings);
    for (const name of Object.keys(instanceSettings)) expect(example).not.toHaveProperty(name);
    expectHost(agent, compose, runtimePort, servicePort, bidDeskSettings.PORT_DEFAULT);
    expect(template.interface.routes.price_list).toBe(bidDeskSettings.PRICE_LIST_ROUTE);
    expectCaddy(agent, pack.caddy, bidDeskSettings.PORT_DEFAULT, ['/agent.json', template.interface.routes.price_list]);
    expectTerms(agent, pack, BID_DESK_CLAIM, 3, bidDeskSettings.JOB_DEADLINE_MS);
    expect(advert.model).toBe(BID_DESK_MODEL);
    expect(advert.windowMs).toBe(bidDeskSettings.MIN_PROCESSING_WINDOW_MS);
    expect(agent.claim.challengeReserveLovelace).toBeNull();
    const rows = tableRows(runbook).filter(([name]) => name === instance);
    expect(rows).toEqual([
      [instance, advert.runtimeContainer, agent.serviceContainer, String(runtimePort), String(servicePort), new URL(agent.endpoint).host, `/srv/agents/${agent.folder}`, `${id}-state`, organisation.domain],
      [instance, ...advertCells(advert)],
    ]);
  });

  it.each(DESKS)('maps the supplier and service keys of $instance to its own env file', ({ instance }) => {
    const agent = agentOf(`bid-desk-${instance}`);
    const pack = readPack(agent.id, 'bid-desk');
    const file = `.env.bid-desk-${instance}`;
    expect(agent.exampleEnvFile).toBe('.env.bid-desk.example');
    expect(agent.serviceEnvFile).toBe(file);
    expect(pack.exampleText.split('\n')[0].match(/\.env\.bid-desk-(?:alfa|bravo|charlie)\b/g)).toContain(file);
    expect(agent.publicKeyLines).toEqual([]);
    expect(agent.envManaged).toEqual({ mock: false, module1: false });
    expect(advertOf(agent).supplierKey).toBe(`bid-${instance}-supplier`);
    expect(agent.serviceKey).toBe(`bid-${instance}-service`);
    expect(agent.keys).toEqual([
      useKey(`bid-${instance}-supplier`, ['authentication', 'transaction'], file, supplierFields),
      useKey(`bid-${instance}-service`, ['authentication', 'transaction'], file, pairFields('BID_DESK_SERVICE')),
    ]);
    expectEnv(agent, pack, BID_DESK_SETTINGS);
  });

  it('serves three different manifest hashes with the right price list under each origin', () => {
    const { registry } = makeTestKeys(['fixture-supplier', 'fixture-service']);
    const hashes = new Set<string>();
    const listHashes = new Set<string>();
    const origins = new Set<string>();
    const containers: string[] = [];
    for (const { instance } of DESKS) {
      const agent = agentOf(`bid-desk-${instance}`);
      const advert = advertOf(agent);
      const { compose, example, template } = readPack(agent.id, 'bid-desk');
      const list = priceListOf(instance);
      expect(list.sha256).toBe(PRICE_LIST_SHA256[instance]);
      const { items } = JSON.parse(list.text) as { items: { sku: string }[] };
      for (const run of data.runs.filter((run) => run.id !== 'lifecycle')) {
        expect(items.some((item) => item.sku === run.subject), `${instance} price list has ${run.subject}`).toBe(true);
      }
      const env = {
        ...example, ...compose.services.service.environment, OPERATOR_CONTACT: 'ops@example.test', AGENT_DID: `did:vector:${sha256('bid evaluation fixture')}`,
        SUPPLIER_PKH: registry.hashOf('fixture-supplier'), SUPPLIER_PUB_KEY_HEX: registry.publicKeyOf('fixture-supplier'), BID_DESK_SERVICE_PKH: registry.hashOf('fixture-service'),
      };
      const rendered = renderManifest('bid-desk', (setting) => bidDeskManifest({ ...env, FAULT_MODE: setting }, list));
      if (!rendered.ok) throw new Error(`${instance}: ${rendered.code}: ${rendered.detail}`);
      const manifest = JSON.parse(rendered.value.text) as Template;
      expect(manifest.name).toBe(agent.name);
      expect(manifest.terms).toEqual(template.terms);
      expect(manifest.behaviour.price_list).toEqual({ uri: `${agent.endpoint}/price-list.json`, sha256: list.sha256 });
      expect(rendered.value.sha256).toBe(sha256(rendered.value.text));
      const other = instance === 'alfa' ? 'bravo' : 'alfa';
      expect(() => bidDeskManifest(env, priceListOf(other))).toThrow('the price list hash is not the hash of the file of the instance');
      hashes.add(rendered.value.sha256);
      listHashes.add(list.sha256);
      origins.add(advert.origin);
      containers.push(advert.runtimeContainer, agent.serviceContainer);
    }
    expect([hashes.size, listHashes.size, origins.size, new Set(containers).size]).toEqual([3, 3, 3, 6]);
    const markers = read('deploy/server/Caddyfile.bid-desk.snippet').match(/^# \S+ vhosts \((?:BEGIN|END)\)$/gm);
    expect(markers).toEqual(DESK_IDS.flatMap((id) => [`# ${id} vhosts (BEGIN)`, `# ${id} vhosts (END)`]));
  });
});

describe('the Sourcing Agent', () => {
  const pack = readPack(SOURCING_ID, 'sourcing-agent');

  it('holds the deployment, claim and advert to the merged pack', () => {
    const agent = agentOf(SOURCING_ID);
    const advert = advertOf(agent);
    const { compose, example, runbook, template } = pack;
    expect(agent).toMatchObject({ kind: 'sourcing-agent', name: template.name, organisation: ECHO.id, capability: BID_CAPABILITIES.evaluate });
    expect(agent.exampleEnvFile).toBeNull();
    expect(pack.exampleText.split('\n')[0]).toMatch(/^# Copy to \.env\.sourcing-agent next to docker-compose\.sourcing-agent\.yml, in \/srv\/agents\/sourcing-agent /);
    expectHost(agent, compose, 8107, 9105, sourcingSettings.PORT_DEFAULT);
    expect(Number(compose.services.service.environment.PORT)).toBe(sourcingSettings.portOf({}));
    expect(template.behaviour.cosign?.route).toBe('/cosign/delegate');
    expectCaddy(agent, pack.caddy, sourcingSettings.PORT_DEFAULT, ['/agent.json', '/cosign/delegate']);
    expectTerms(agent, pack, SOURCING_CLAIM, 5, sourcingSettings.JOB_DEADLINE_MS);
    expect(sourcingSettings.JOB_DEADLINE_MS).toBe(5_220_000);
    expect(advert.windowMs).toBe(5_400_000);
    expect(advert.windowMs).toBe(sourcingSettings.processingWindowOf(example));
    expect(advert.priceLovelace).toBe(BigInt(sourcingSettings.priceOf(example)));
    expect(advert.priceLovelace).toBe(BigInt(sourcingSettings.PRICE_DEFAULT_LOVELACE));
    expect(advert.supplierBondLovelace).toBe(BigInt(sourcingSettings.SUPPLIER_BOND_LOVELACE));
    expect(advert.buyerBondLovelace).toBe(BigInt(sourcingSettings.BUYER_BOND_LOVELACE));
    expect(advert.model).toBe(SOURCING_MODEL);
    expect(agent.claim.challengeReserveLovelace).toBe(CHALLENGE_RESERVE_LOVELACE);
    expect(agent.claim.challengeReserveLovelace).toBe(53_000_000n);
    expect(tableRows(runbook).filter(([label]) => label === 'Sourcing')).toEqual([
      ['Sourcing', advert.runtimeContainer, '8107', new URL(agent.endpoint).host, ...advertCells(advert)],
    ]);
    expect(runbook).toContain(`The service is the container \`${agent.serviceContainer}\`, on \`127.0.0.1:9105\`.`);
  });

  it('maps exactly the key and scorer lines that the service and runtime read', () => {
    const agent = agentOf(SOURCING_ID);
    const file = '.env.sourcing-agent';
    expect(agent.serviceEnvFile).toBe(file);
    expect(agent.envManaged).toEqual({ mock: true, module1: true });
    expect(agent.serviceKey).toBe('sourcing-service');
    expect(advertOf(agent).supplierKey).toBe('sourcing-supplier');
    expect(agent.keys).toEqual([
      useKey('sourcing-supplier', ['authentication', 'transaction'], file, supplierFields),
      useKey('sourcing-service', ['authentication', 'transaction'], file, pairFields('SOURCING_SERVICE')),
      useKey('sourcing-delegation-1', ['delegation'], file, pairFields('SOURCING_DELEGATION_1')),
      useKey('sourcing-delegation-2', ['delegation'], file, pairFields('SOURCING_DELEGATION_2')),
    ]);
    expect(data.subagents.map(({ id, parent, name, keys }) => ({ id, parent, name, keys }))).toEqual(SCORERS.map((id, index) => ({
      id, parent: SOURCING_ID, name: id, keys: [
        useKey(`${id}-auth`, ['authentication'], file, pairFields(`SCORER_${index + 1}_AUTH`)),
        useKey(`${id}-delegation`, ['delegation'], file, pairFields(`SCORER_${index + 1}_DELEGATION`)),
      ],
    })));
    expect(agent.publicKeyLines).toEqual([{ key: 'registry-foxtrot', lines: [{ file, name: 'COMPLIANCE_ISSUER_PKH', of: 'pkh' }] }]);
    expectEnv(agent, pack, SOURCING_SETTINGS);
    expect(SOURCING_KEY_ROLES).toEqual(['service', 'delegation1', 'delegation2', ...SCORERS.flatMap((_, i) => [`scorer${i + 1}Authentication`, `scorer${i + 1}Delegation`])]);
    const didLines = SCORERS.map((id) => `${id.toUpperCase().replaceAll('-', '_')}_DID`);
    expect(sorted(Object.keys(pack.example).filter((name) => /^SCORER_\d+_DID$/.test(name)))).toEqual(didLines);
    expect(SOURCING_SETTINGS.filter((name) => /^SCORER_\d+_DID$/.test(name))).toEqual(didLines);
    const dids = SCORERS.map((id) => `did:vector:${sha256(id)}`);
    expect(sourcingSettings.scorerDidsOf({ AGENT_DID: `did:vector:${sha256(SOURCING_ID)}`, ...Object.fromEntries(didLines.map((line, i) => [line, dids[i]])) })).toEqual(dids);
  });

  it('keeps the example limits within the bounds that the quote and dispute settings need', () => {
    const limits = sourcingSettings.quoteLimitsOf(pack.example);
    expect(limits).toEqual({ maxPriceLovelace: 2n * UNIT, maxSupplierBondLovelace: 2n * UNIT, maxBuyerBondLovelace: 2n * UNIT });
    for (const id of DESK_IDS) {
      const advert = advertOf(agentOf(id));
      expect(advert.priceLovelace).toBeLessThanOrEqual(need(limits.maxPriceLovelace, 'quote price limit'));
      expect(advert.supplierBondLovelace).toBeLessThanOrEqual(need(limits.maxSupplierBondLovelace, 'quote supplier bond limit'));
      expect(advert.buyerBondLovelace).toBeLessThanOrEqual(need(limits.maxBuyerBondLovelace, 'quote buyer bond limit'));
    }
    const dispute = sourcingSettings.disputeOf(pack.example);
    expect(dispute).toEqual({ challenge_stake_lovelace: CLAIM_STAKE_LOVELACE, min_window_left_ms: 600_000, read_timeout_ms: 20_000 });
    expect(dispute.challenge_stake_lovelace).toBeLessThan(need(agentOf(SOURCING_ID).claim.challengeReserveLovelace, 'challenge reserve'));
  });
});

describe('the public identity pages', () => {
  it('matches the Sourcing Agent key purposes, organisation and planned origin', () => {
    const agent = agentOf(SOURCING_ID);
    const rows = tableRows(sectionOf(PAGES['sourcing-agent'], 'Identity'));
    expectSigningPurposes(agent, rows);
    const delegation = fieldOf(rows, 'Delegation keys');
    expect(delegation).toMatch(/\b(?:two|2) keys\b/i);
    const supplier = advertOf(agent).supplierKey;
    const keys = agent.keys.filter(({ key }) => key !== supplier && key !== agent.serviceKey);
    expect(keys).toHaveLength(2);
    for (const key of keys) expect(sorted(key.purposes), key.key).toEqual(purposesOf(delegation));
    expect(fieldOf(rows, 'Organisation').match(/\b(?:[a-z0-9-]+\.)+[a-z]+\b/i)?.[0]).toBe(domainOf(agent));
    expect(fieldOf(rows, 'Public URL').match(/https:\/\/[^\s,;]+/g)).toEqual([agent.endpoint]);
  });

  it('matches the published scorer lineage and key purposes', () => {
    const rows = tableRows(sectionOf(PAGES['sourcing-agent'], 'Identity'));
    const row = fieldOf(rows, 'Subagents');
    expect(row).toMatch(/\bown record\b/i);
    expect(row).toMatch(/\bthis agent as its parent\b/i);
    const names = row.split(':', 1)[0].match(/\bscorer-\d+\b/g) ?? [];
    const children = data.subagents.filter(({ parent }) => parent === SOURCING_ID);
    expect(sorted(children.map(({ id }) => id))).toEqual(sorted(names));
    expect(sorted(row.match(/\bSCORER_\d+_DID\b/g) ?? [])).toEqual(sorted(children.map(({ id }) => `${id.toUpperCase().replaceAll('-', '_')}_DID`)));
    const stated = sorted(Array.from(row.matchAll(/\b(?:its own|one) ([a-z]+) key\b/gi), ([, purpose]) => purpose.toLowerCase()));
    expect(stated).toHaveLength(2);
    for (const child of children) {
      expect(child.keys.map(({ purposes }) => purposes.length), child.id).toEqual([1, 1]);
      expect(sorted(child.keys.flatMap(({ purposes }) => purposes)), child.id).toEqual(stated);
    }
  });

  it('matches the three Bid Desk identities without assigning delegation keys or subagents', () => {
    const rows = tableRows(sectionOf(PAGES['bid-desk'], 'Identity'));
    const start = rows.findIndex(([label]) => label === 'Instance');
    expect(rows[start]?.slice(0, 4)).toEqual(['Instance', 'Name', 'Organisation', 'Public URL (planned)']);
    const instances = rows.slice(start + 1);
    expect(sorted(instances.map(([instance]) => instance))).toEqual(sorted(DESKS.map(({ instance }) => instance)));
    for (const label of ['Delegation keys', 'Subagents']) expect(fieldOf(rows, label)).toMatch(/^none\b/i);
    for (const { instance } of DESKS) {
      const agent = agentOf(`bid-desk-${instance}`);
      expect(instances.find(([id]) => id === instance)?.slice(1, 4), instance).toEqual([agent.name, domainOf(agent), agent.endpoint]);
      expectSigningPurposes(agent, rows);
      expect(agent.keys.some(({ purposes }) => purposes.includes('delegation')), instance).toBe(false);
      expect(agent.cosign, instance).toBe(false);
      expect(data.subagents.some(({ parent }) => parent === agent.id), instance).toBe(false);
    }
  });
});

describe('the records and end states', () => {
  it('keeps the four organisations, agent parties and end states distinct', () => {
    expect(data.name).toBe('bid-evaluation');
    expect(data.title).toBe('Use case 3 (supplier bid evaluation)');
    expect(data.organisations).toEqual([ECHO, ALFA, BRAVO, CHARLIE]);
    expect(data.agents.map((agent) => agent.id)).toEqual(AGENT_IDS);
    for (const agent of data.agents) {
      const organisation = need(data.organisations.find((org) => org.id === agent.organisation), `${agent.id} organisation`);
      expect(agent.parties).toEqual(partiesOf(organisation));
      expect(agent.guardianThreshold).toBe(2);
      expect(agent.stakeLovelace).toBe(10n * UNIT);
    }
    expect(data.agents.map((agent) => agent.end)).toEqual([
      { record: 'active', advert: 'listed', subagents: 'live', successor: null },
      { record: 'active', advert: 'listed', subagents: 'live', successor: null },
      { record: 'retired', advert: 'retired', subagents: 'live', successor: 'bravo-successor' },
      { record: 'revoked', advert: 'retired', subagents: 'live', successor: null },
    ]);
  });

  it('uses the two guardians of Bravo and a separate root record as its successor', () => {
    const lifecycle = need(data.lifecycle, 'lifecycle');
    expect(lifecycle).toEqual({
      agent: 'bid-desk-bravo', controllers: ['l1-controller-1', 'l1-controller-2'], guardians: ['guardian-bravo', 'controller'], successor: 'bravo-successor', waitMs: DAYS_7_MS,
    });
    const bravo = agentOf(lifecycle.agent);
    expect(bravo.parties.filter((party) => party.role === 'Guardian').map((party) => party.signer)).toEqual(lifecycle.guardians.map((key) => ({ kind: 'key', key })));
    expect(bravo.end.successor).toBe(lifecycle.successor);
    expect(data.records).toHaveLength(1);
    const successor = data.records[0];
    expect(successor).toEqual({
      id: lifecycle.successor, name: 'Bravo Successor', description: successor.description, organisation: bravo.organisation, guardianThreshold: 0,
      keys: [{ key: 'bravo-successor-auth', purposes: ['authentication'], lines: [] }],
      parties: [{ role: 'Accountable', signer: { kind: 'key', key: 'accountable-bravo' }, organisation: BRAVO.domain, rights: null }],
    });
    expect([...data.agents, ...data.subagents].map((record) => record.id)).not.toContain(successor.id);
    for (const record of [...data.agents, ...data.subagents, successor]) {
      expect(record.description.startsWith(DEMONSTRATION_SENTENCE), record.id).toBe(true);
      expect(Buffer.byteLength(record.description), record.id).toBeLessThanOrEqual(256);
      expect(Buffer.byteLength(record.name), record.id).toBeLessThanOrEqual(64);
    }
  });

  it('uses a public issuer hash without listing the issuer on a record', () => {
    const compliance = need(data.compliance, 'compliance');
    expect(compliance).toMatchObject({ issuerKey: 'registry-foxtrot', subjects: DESK_IDS, format: 50, validDays: 365 });
    expect(compliance.statement.trim()).not.toBe('');
    expect(compliance.reply.text.trim()).not.toBe('');
    const keys = [...data.agents, ...data.subagents, ...data.records].flatMap((record) => record.keys.map((key) => key.key));
    expect(keys).not.toContain(compliance.issuerKey);
    const line = agentOf(SOURCING_ID).publicKeyLines;
    expect(line.map((entry) => entry.key)).toEqual([compliance.issuerKey]);
    expect(data.attestations).toEqual(AGENT_IDS.map((agent) => ({ agent, types: ['provenance', 'software'], format: 50, validDays: 365, envelope: null })));
  });

  it('uses exactly 32 valid keys and loads all of them in the registry', () => {
    const scopes = (scope: 'shared' | 'use-case') => sorted(data.keys.filter((key) => key.scope === scope).map((key) => key.name));
    expect(scopes('shared')).toEqual(sorted(['controller', 'run', 'fee', 'provider', ...data.organisations.flatMap((org) => [org.accountableKey, org.guardianKey])]));
    expect(scopes('use-case')).toEqual(sorted([
      'sourcing-supplier', 'sourcing-service', 'sourcing-delegation-1', 'sourcing-delegation-2',
      ...SCORERS.flatMap((id) => [`${id}-auth`, `${id}-delegation`]),
      ...DESKS.flatMap(({ instance }) => [`bid-${instance}-supplier`, `bid-${instance}-service`]),
      'registry-foxtrot', 'l1-controller-1', 'l1-controller-2', 'bravo-successor-auth',
    ]));
    const names = data.keys.map((key) => key.name);
    expect(names).toHaveLength(32);
    expect(new Set(names).size).toBe(32);
    for (const key of names) expect(key).toMatch(/^[a-z][a-z0-9-]{0,47}$/);
    const records = [...data.agents, ...data.subagents, ...data.records];
    const lifecycle = need(data.lifecycle, 'lifecycle');
    const used = new Set([
      'run', 'fee', ...records.flatMap((record) => record.keys.map((key) => key.key)),
      ...[...data.agents, ...data.records].flatMap((record) => record.parties.flatMap((party) => party.signer.kind === 'key' ? [party.signer.key] : [])),
      ...data.agents.flatMap((agent) => [agent.serviceKey, ...agent.adverts.map((advert) => advert.supplierKey), ...agent.publicKeyLines.map((entry) => entry.key)]),
      ...data.funding.map((entry) => entry.wallet), ...lifecycle.controllers, ...lifecycle.guardians, need(data.compliance, 'compliance').issuerKey,
    ]);
    expect(sorted([...used])).toEqual(sorted(names));
    const dir = makeKeyRoot();
    expect(makeMissingKeys(dir, data.name, data.keys)).toEqual({ made: names, kept: [] });
    const registry = loadRegistry({ dir, useCase: data.name, specs: data.keys });
    expect(registry.names()).toEqual(names);
    expect(registry.isComplete()).toBe(true);
  });
});

describe('the tenant, vaults and funding', () => {
  it('keeps all three default vendor rows and resolves their organisations to the desk domains', () => {
    const seed = defaultSeed();
    const vendors = need(data.tenantSeed, 'tenantSeed').vendors;
    expect(vendors).toStrictEqual(seed.vendors.map((vendor, i) => ({ ...vendor, organisation: DESKS[i].instance })));
    const forTenant = vendors.map((vendor) => ({ ...vendor, organisation: need(data.organisations.find((org) => org.id === vendor.organisation), 'vendor organisation').domain }));
    expect(parseSeed('seed', { vendors: forTenant }).vendors).toStrictEqual(forTenant);
    expect(data.tenantOrganisations).toEqual({ supplier: ALFA.domain, insurer: DELTA.domain });
    for (const run of data.runs.filter((run) => run.id !== 'lifecycle')) expect(seed.catalogue.map((item) => item.sku)).toContain(run.subject);
  });

  it('funds three quote payments for clean and ten for failure, with no vault for lifecycle', () => {
    const quoteLock = lockOf(advertOf(agentOf(DESK_IDS[0])));
    expect(data.runs).toHaveLength(3);
    expect(data.runs.map((run) => run.id)).toEqual(['clean', 'failure', 'lifecycle']);
    for (const [id, payments] of [['clean', 3n], ['failure', 10n]] as const) {
      const run = need(data.runs.find((entry) => entry.id === id), `${id} run`);
      const total = payments * quoteLock;
      const tenth = UNIT / 10n;
      const vault = (total + FakeChain.VAULT_MIN_LOVELACE + tenth - 1n) / tenth * tenth;
      expect(run).toEqual({
        id, subject: 'GLV-NIT-M', tenantPrefix: `bids-${id}`, vaultUnits: Number(vault) / Number(UNIT), perTxUnits: Number(quoteLock / UNIT), totalUnits: Number(total / UNIT),
      });
    }
    expect(data.runs[2]).toEqual({ id: 'lifecycle', subject: need(data.lifecycle, 'lifecycle').agent, tenantPrefix: 'bids-lifecycle', vaultUnits: 0, perTxUnits: 0, totalUnits: 0 });
  });

  it('sets all eleven funding targets and covers the cost of their items', () => {
    const funding = new Map(data.funding.map((line) => [line.wallet, line]));
    const itemAmounts = (line: UseCase['funding'][number]) => line.items.map(({ lovelace }) => lovelace);
    expect(data.funding).toHaveLength(11);
    expect(funding.size).toBe(11);
    expect(sorted([...funding.keys()])).toEqual(sorted(['fee', ...data.agents.flatMap((agent) => agent.keys.map((key) => key.key))]));
    expect(itemAmounts(need(funding.get('fee'), 'fee funding'))).toEqual([
      BigInt(data.agents.length + data.subagents.length + data.records.length) * MIN_RECORD_LOVELACE,
      4_000_000n, BigInt(data.attestations.flatMap((entry) => entry.types).length) * 5_000_000n, 2_720_000n,
      BigInt(need(data.compliance, 'compliance').subjects.length) * 5_000_000n, 1_820_000n, 500_000n, 3_000_000n,
    ]);
    for (const agent of data.agents) {
      const advert = advertOf(agent);
      const sourcing = agent.kind === SOURCING_ID;
      expect(itemAmounts(need(funding.get(advert.supplierKey), advert.supplierKey))).toEqual([
        advert.depositLovelace, 350_000n, advert.supplierBondLovelace, sourcing ? 6_000_000n : 3_600_000n,
      ]);
      expect(itemAmounts(need(funding.get(agent.serviceKey), agent.serviceKey))).toEqual([
        agent.stakeLovelace, 2_000_000n, 820_000n, 2n * agent.claim.stakeLovelace, 4_000_000n,
        ...(sourcing ? [CLAIM_STAKE_LOVELACE, 1_000_000n, 74_800_000n] : [11_000_000n]),
      ]);
    }
    for (const key of ['sourcing-delegation-1', 'sourcing-delegation-2']) {
      expect(itemAmounts(need(funding.get(key), key))).toEqual([10_400_000n, 6_600_000n, 13_000_000n, 1_000_000n]);
    }
    const step = 10n * UNIT;
    for (const line of funding.values()) {
      expect(line.collateralLovelace, line.wallet).toBe(5n * UNIT);
      const total = itemAmounts(line).reduce((sum, amount) => sum + amount, 0n);
      expect(line.floatLovelace, line.wallet).toBe((total + step - 1n) / step * step);
    }
    expect(data.funding.reduce((sum, line) => sum + line.collateralLovelace, 0n)).toBe(55n * UNIT);
    expect(data.funding.reduce((sum, line) => sum + line.floatLovelace, 0n)).toBe(910n * UNIT);
  });

  it('uses the CI checkout of the runtime and the Module-1 path of the Sourcing Agent example', () => {
    const ci = parseYaml(read('.github/workflows/ci.yml')) as { jobs: Record<string, { steps?: { with?: { repository?: string; ref?: string } }[] }> };
    const refs = Object.values(ci.jobs).flatMap((job) => job.steps ?? []).filter((step) => step.with?.repository === 'Apex-Fusion/vector-agent-template').map((step) => step.with?.ref);
    expect(refs.length).toBeGreaterThan(0);
    expect(data.runtimeCommit).toMatch(/^[0-9a-f]{40}$/);
    for (const ref of refs) expect(ref).toBe(data.runtimeCommit);
    expect(exampleOf(read('deploy/server/.env.sourcing-agent.example')).VECTOR_MODULE1_MANIFEST.split('<commit>/')[1]).toBe(data.moduleManifestPath);
  });
});

describe('the evidence and its limits', () => {
  it('keeps each step in order with its run, primitive and actor', () => {
    expect(data.evidenceSteps.map(({ id, run, primitive, actor }) => [id, run, primitive, actor])).toEqual([
      ['r1-01', 'clean', 'Delegation with a co-signature, vault', 'hirer'],
      ['r1-02', 'clean', 'Escrow', 'hirer'],
      ['r1-03', 'clean', 'Marketplace list, catalog and status list reads, model call from the marketplace', 'agent'],
      ['r1-04', 'clean', 'Vault payment, pre-claim check, model call, accept', 'counterparty'],
      ['r1-05', 'clean', 'Three sub-delegations, token exchange with the delegation chain, model call', 'agent'],
      ['r1-06', 'clean', 'Attestation: approval', 'hirer'],
      ['r1-07', 'clean', 'Escrow, token for a route', 'agent'],
      ['r1-08', 'clean', 'Vault close, undelegate', 'hirer'],
      ['r2-a', 'failure', 'Module-1 challenge', 'agent'],
      ['r2-a-release', 'failure', 'Escrow: release', 'counterparty'],
      ['r2-a-hold', 'failure', 'Module-1 verdict and hold', 'relay'],
      ['r2-b', 'failure', 'Attestation: revoke and reply', 'operator'],
      ['r2-c', 'failure', 'Hold removes the agent from the listing', 'agent'],
      ['r2-d', 'failure', 'Refusal by a system with no approval', 'agent'],
      ['r2-e', 'failure', 'Revoke of a record by a party', 'operator'],
      ['l1-01', 'lifecycle', 'Change of the controller', 'operator'],
      ['l1-02', 'lifecycle', 'Recovery start', 'operator'],
      ['l1-03', 'lifecycle', 'Waiting time of a recovery', 'operator'],
      ['l1-04', 'lifecycle', 'Recovery completion', 'operator'],
      ['l1-05', 'lifecycle', 'Retire of a record', 'operator'],
      ['l1-06', 'lifecycle', 'Successor of an ended record', 'operator'],
      ['l1-07', 'lifecycle', 'Reclaim of an ended record', 'operator'],
    ]);
    for (const step of data.evidenceSteps) expect(step.what.trim(), step.id).not.toBe('');
    const textOf = (id: string) => need(data.evidenceSteps.find((step) => step.id === id), id).what;
    expect(textOf('r2-a')).toContain(agentOf('bid-desk-charlie').faultValues[0]);
    expect(textOf('r2-d')).toContain(agentOf(SOURCING_ID).faultValues[0]);
    expect(textOf('r2-a-hold')).toContain(`${MODULE1.verdict_policy.auditor_wins.duration_ms / 86_400_000} days, reason ${REASON_DISPUTE_VERDICT}`);
    expect(textOf('l1-03')).toContain(`${need(data.lifecycle, 'lifecycle').waitMs / 86_400_000} days`);
  });

  it('lists the limits from both manifests and public pages without repeating an evidence step', () => {
    const { lead, items } = data.notCovered;
    expect(lead).toBe(`No run covers these ${items.length} items:`);
    expect(items).toHaveLength(4);
    expect(new Set(items).size).toBe(items.length);
    for (const item of items) {
      expect(item).toMatch(/^[^.!?\n]{1,199}\.$/);
      expect(data.evidenceSteps.map((step) => step.what)).not.toContain(item);
    }
    expect(items).toEqual([
      'No run covers the refund of the escrow of a revoked agent.',
      'No run covers the reclaim of an escrow in use case 3.',
      'No run shows a relying party that refuses a live token after its authority ends.',
      'No run challenges a claim of the Sourcing Agent.',
    ]);
    const fragments = items.slice(0, 3).map((item) => item.replace(/^No run (?:covers|shows) /, '').slice(0, -1));
    for (const [kind, gap] of [['bid-desk', BID_DESK_GAP], ['sourcing-agent', SOURCING_GAP]] as const) {
      expect(json<Template>(`agents/${kind}/agent.json.template`).gaps).toContain(gap);
      for (const fragment of fragments) expect(gap).toContain(fragment);
      const page = sectionOf(PAGES[kind], 'Known gaps');
      const stated = need(/^-\s+What this does not show:\s+no run (?:covers|shows)\s+([^\n.]+)\./im.exec(page)?.[1], `${kind} run limits`);
      expect(sorted(stated.split(/,\s*(?:or\s+)?|\s+or\s+/i)), kind).toEqual(sorted(fragments));
    }
    expect(read('deploy/server/RUNBOOK-bid-desk.md')).toContain('The service has no claim code and no dispute code, and it never challenges.');
  });
});
