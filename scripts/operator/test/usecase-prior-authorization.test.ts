import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { afterAll, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { FakeChain } from '../../../packages/buyer-core/src/index.ts';
import { REASON_DISPUTE_VERDICT } from '../../../packages/buyer-core/src/vendored/mcp/identity-rules.ts';
import { INTAKE_CLAIM, PRIORAUTH_CAPABILITIES, PRIORAUTH_CLAIM, PRIORAUTH_MODELS } from '../../../packages/usecase-kit/src/priorauth/index.ts';
import { FAULT_MODES } from '../../../packages/usecase-kit/src/protocol/faults.ts';
import { defaultSeed } from '../../../services/mock-systems/src/seed.ts';
import { CHALLENGE_RESERVE_LOVELACE, CLAIM_STAKE_LOVELACE, CLAIM_WINDOW_MS } from '../lib/claim-constants.ts';
import type { AdvertSpec, AgentSpec, KeyLine, KeyUse, UseCase } from '../lib/contract.ts';
import { MAX_CLAIM_TYPE_BYTES } from '../lib/platform.ts';
import { loadRegistry, makeMissingKeys } from '../lib/registry.ts';
import data from '../usecases/prior-authorization.ts';
import { makeKeyRoot, removeTestKeys } from './support/keys.ts';

afterAll(removeTestKeys);

const ROOT = new URL('../../../', import.meta.url);
const read = (path: string): string => readFileSync(new URL(path, ROOT), 'utf8');
const UNIT = 1_000_000n;
const DAY_MS = 86_400_000;
const SHARED_KEYS = ['controller', 'run', 'fee', 'provider', 'accountable-echo', 'guardian-echo', 'accountable-delta', 'guardian-delta'];
const SUBAGENTS = ['record-reader', 'drafter'];

const PACKS = [
  {
    id: 'prior-authorization-agent', organisation: 'echo', capability: PRIORAUTH_CAPABILITIES.draft, model: PRIORAUTH_MODELS.draft, claim: PRIORAUTH_CLAIM,
    supplier: 'priorauth-supplier', service: 'priorauth-service', delegation: ['priorauth-delegation-1', 'priorauth-delegation-2'],
    runtimePort: 8105, servicePort: 9103, lock: 5_000_000n,
    gapChallenge: 'a challenge of this agent against the Insurer Intake Agent, because that agent has no fault value',
  },
  {
    id: 'insurer-intake-agent', organisation: 'delta', capability: PRIORAUTH_CAPABILITIES.intake, model: PRIORAUTH_MODELS.intake, claim: INTAKE_CLAIM,
    supplier: 'intake-supplier', service: 'intake-service', delegation: [],
    runtimePort: 8106, servicePort: 9104, lock: 4_000_000n,
    gapChallenge: 'the challenge of the Prior Authorization Agent against this agent (this agent has no fault value)',
  },
] as const;
type Pack = (typeof PACKS)[number];

interface Template {
  name: string;
  capability_id: string;
  keys: { supplier_pkh: string; pub_key_hex: string; buyer_pkh: string; delegation_pkhs?: string[] };
  interface: { routes: { status: string }; notes: string[] };
  terms: { price_lovelace: number; supplier_bond_lovelace: number; buyer_bond_lovelace: number; max_processing_ms: number };
  behaviour: { claim: typeof PRIORAUTH_CLAIM; cosign?: { route: string }; fault_modes: string[] };
  gaps: string[];
}
interface Container {
  container_name: string;
  env_file: { path: string; required: boolean }[];
  environment: Record<string, string>;
  ports: string[];
}

function need<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`No ${what}.`);
  return value;
}

function parseExample(text: string): Map<string, string> {
  const lines = new Map<string, string>();
  for (const [, name, value] of text.matchAll(/^([A-Z][A-Z0-9_]*)=(.*)$/gm)) {
    if (lines.has(name)) throw new Error(`The example lists ${name} twice.`);
    lines.set(name, value);
  }
  return lines;
}

const rows = (text: string): string[][] => text.split('\n').filter((line) => line.startsWith('| '))
  .map((line) => line.split('|').slice(1, -1).map((cell) => cell.trim()));
const cell = (text: string, label: string): string => need(rows(text).find(([name]) => name === label)?.[1], `${label} row`);
const codes = (text: string): string[] => [...text.matchAll(/`([^`]+)`/g)].map(([, code]) => code);
const units = (lovelace: bigint): string => String(Number(lovelace) / Number(UNIT));
const lock = (advert: AdvertSpec): bigint => advert.priceLovelace + advert.supplierBondLovelace + advert.buyerBondLovelace;
const agentOf = (use: UseCase, id: string): AgentSpec => need(use.agents.find((agent) => agent.id === id), `agent ${id}`);
const subagentsOf = (use: UseCase, agent: AgentSpec) => use.subagents.filter((subagent) => subagent.parent === agent.id);
const keysOf = (use: UseCase, agent: AgentSpec): readonly KeyUse[] => [...agent.keys, ...subagentsOf(use, agent).flatMap((subagent) => subagent.keys)];
const changeAgent = (use: UseCase, id: string, delta: Partial<AgentSpec>): UseCase => ({
  ...use, agents: use.agents.map((agent) => agent.id === id ? { ...agent, ...delta } : agent),
});

function keyLineType(name: string): KeyLine['of'] | undefined {
  if (name.endsWith('_PRIV_KEY_HEX')) return 'secret';
  if (name.endsWith('_PUB_KEY_HEX')) return 'pub';
  if (name.endsWith('_PKH')) return 'pkh';
  if (name === 'SUPPLIER_ADDRESS') return 'address';
  return undefined;
}

function keyEnvProblems(use: UseCase, agent: AgentSpec, example: ReadonlyMap<string, string>, templateText: string): string[] {
  const problems: string[] = [];
  const counts = new Map<string, number>();
  const uses = keysOf(use, agent);
  const supplier = need(agent.adverts[0], `${agent.id} advert`).supplierKey;
  if (![supplier, agent.serviceKey].every((key) => uses.some((use) => use.key === key))) problems.push(`${agent.id}: the supplier or service key has no lines`);
  for (const keyUse of uses) {
    const prefix = keyUse.key.toUpperCase().replaceAll('-', '_');
    const expectedNames = keyUse.key === supplier
      ? ['SUPPLIER_PRIV_KEY_HEX', 'SUPPLIER_PUB_KEY_HEX', 'SUPPLIER_PKH', 'SUPPLIER_ADDRESS']
      : [`${prefix}_PRIV_KEY_HEX`, `${prefix}_PKH`];
    if (!isDeepStrictEqual(keyUse.lines.map(({ name }) => name).sort(), expectedNames.sort())) {
      problems.push(`${keyUse.key}: its env names do not match its role`);
    }
    for (const { file, name, of } of keyUse.lines) {
      if (file !== agent.serviceEnvFile) problems.push(`${keyUse.key}: ${name} belongs in ${agent.serviceEnvFile}`);
      else counts.set(name, (counts.get(name) ?? 0) + 1);
      if (!example.has(name)) problems.push(`${keyUse.key}: ${name} is not in the example`);
      if (keyLineType(name) !== of) problems.push(`${keyUse.key}: ${name} does not hold ${of}`);
    }
  }
  for (const [name, value] of example) {
    if (keyLineType(name) === undefined) continue;
    if (counts.get(name) !== 1) problems.push(`${agent.id}: ${name} needs exactly one line`);
    if (value !== '') problems.push(`${agent.id}: ${name} must be empty in the example`);
  }
  const placeholders = new Set([...templateText.matchAll(/<([A-Z][A-Z0-9_]*)>/g)].map(([, name]) => name));
  for (const name of placeholders) {
    if (keyLineType(name) !== undefined && counts.get(name) !== 1) problems.push(`${agent.id}: no unique line for <${name}>`);
  }
  return problems;
}

function designProblems(use: UseCase, pack: Pack, page: string): string[] {
  const problems: string[] = [];
  const agent = agentOf(use, pack.id);
  const purposes = (label: string, names: readonly string[]): void => {
    const prose = cell(page, label);
    const stated = (/listed in the record for the (authentication|assertion|transaction|delegation)(?: and (authentication|assertion|transaction|delegation))? purposes?/.exec(prose) ?? [])
      .slice(1).filter(Boolean).sort();
    if (names.length === 0 ? !prose.startsWith('none.') : stated.length === 0) problems.push(`${label}: the page does not state the required purposes`);
    for (const name of names) {
      const key = agent.keys.find(({ key }) => key === name);
      if (!isDeepStrictEqual(key === undefined ? undefined : [...key.purposes].sort(), stated)) problems.push(`${name}: the purposes differ from the page`);
    }
  };
  purposes('Supplier key', [pack.supplier]);
  purposes('Service key', [pack.service]);
  purposes('Delegation keys', pack.delegation);
  if (agent.keys.length !== 2 + pack.delegation.length) problems.push(`${agent.id}: the record has an unexpected number of keys`);

  const organisation = use.organisations.find(({ id }) => id === agent.organisation);
  const orgRow = cell(page, 'Organisation');
  if (organisation?.id !== pack.organisation || organisation.domain !== codes(orgRow)[0]) problems.push(`${agent.id}: the organisation differs from the page`);
  const description = /with the description "([^"]+)"/.exec(orgRow)?.[1];
  if (description === undefined || !agent.description.startsWith(`${description}.`)) problems.push(`${agent.id}: the description differs from the page`);
  if (!isDeepStrictEqual(codes(cell(page, 'Public URL')), agent.adverts.map((advert) => advert.origin))) problems.push(`${agent.id}: the origins differ from the page`);

  const children = subagentsOf(use, agent);
  const subagentRow = cell(page, 'Subagents');
  if (subagentRow.startsWith('none.')) {
    if (children.length !== 0) problems.push(`${agent.id}: the page names no subagents`);
  } else {
    const [names] = subagentRow.split(':');
    if (!isDeepStrictEqual(children.map(({ id }) => id), codes(names))) problems.push(`${agent.id}: the subagents differ from the page`);
    const stated = /its own (\w+) key and its own (\w+) key/.exec(subagentRow);
    for (const child of children) {
      if (!isDeepStrictEqual(child.keys.map(({ key, purposes }) => [key, purposes]), [
        [`${child.id}-auth`, [stated?.[1]]], [`${child.id}-delegation`, [stated?.[2]]],
      ])) problems.push(`${child.id}: the purposes of its keys differ from the page`);
    }
  }
  return problems;
}

const MODULE1 = JSON.parse(read('packages/buyer-core/test/fixtures/module1-mainnet-manifest.json')) as {
  protocol_params: { min_claim_stake: number; min_challenge_window: number; max_challenge_window: number };
  verdict_policy: { auditor_wins: { action: string; duration_ms: number } };
};

function fundingProblems(use: UseCase): string[] {
  const problems: string[] = [];
  const wallets = use.funding.map(({ wallet }) => wallet);
  const paying = ['fee', ...use.agents.flatMap((agent) => agent.keys.map(({ key }) => key))];
  if (!isDeepStrictEqual(wallets.sort(), paying.sort())) problems.push('Each paying wallet needs exactly one line.');
  for (const { wallet, items, collateralLovelace, floatLovelace } of use.funding) {
    if (collateralLovelace !== 5n * UNIT) problems.push(`${wallet}: collateral is not 5 units`);
    const sum = items.reduce((total, item) => total + item.lovelace, 0n);
    const step = 10n * UNIT;
    if (items.some((item) => item.lovelace <= 0n) || floatLovelace !== ((sum + step - 1n) / step) * step) {
      problems.push(`${wallet}: the float must cover the items, rounded up to 10 units`);
    }
  }
  return problems;
}

const budgetItem = (wallet: string, what: string): bigint =>
  need(data.funding.find((line) => line.wallet === wallet)?.items.find((item) => item.what === what)?.lovelace, `${what} for ${wallet}`);
const SEEDED_ORDERS = new Set(defaultSeed().records.map(({ order }) => order.order_id));

function runProblems(use: UseCase): string[] {
  const problems: string[] = [];
  const intake = need(agentOf(use, 'insurer-intake-agent').adverts[0], 'intake advert');
  const payment = lock(intake);
  const headroom = FakeChain.VAULT_MIN_LOVELACE;
  const tenth = UNIT / 10n;
  for (const run of use.runs) {
    if (run.subject !== 'ORD-1001' || !SEEDED_ORDERS.has(run.subject)) problems.push(`${run.id}: the seeded order is not ORD-1001`);
    if (run.tenantPrefix !== `priorauth-${run.id}`) problems.push(`${run.id}: the tenant prefix differs from the run`);
    const payments = run.id === 'clean' ? 1n : 4n;
    const total = payments * payment;
    if (run.perTxUnits !== Number(payment) / Number(UNIT) || run.totalUnits !== Number(total) / Number(UNIT)) {
      problems.push(`${run.id}: the limits must allow ${payments} payments of ${payment} lovelace`);
    }
    const minimum = ((total + headroom + tenth - 1n) / tenth) * tenth;
    if (run.vaultUnits !== Number(minimum) / Number(UNIT)) problems.push(`${run.id}: the vault must hold the total and the minimum output`);
  }
  return problems;
}

describe.each(PACKS)('$id deployment data', (pack) => {
  const agent = agentOf(data, pack.id);
  const advert = need(agent.adverts[0], `${agent.id} advert`);
  const templateText = read(`agents/${pack.id}/agent.json.template`);
  const template = JSON.parse(templateText) as Template;
  const exampleName = `.env.${pack.id}.example`;
  const exampleText = read(`deploy/server/${exampleName}`);
  const example = parseExample(exampleText);
  const value = (name: string): string => need(example.get(name), `${name} in ${exampleName}`);
  const compose = parseYaml(read(`deploy/server/docker-compose.${pack.id}.yml`)) as { name: string; services: { runtime: Container; service: Container } };
  const { runtime, service } = compose.services;
  const routes = read(`deploy/server/Caddyfile.${pack.id}.snippet`).split('\n').map((line) => line.trim()).filter((line) => line && !line.startsWith('#'));
  const runbook = read(`deploy/server/RUNBOOK-${pack.id}.md`);
  const page = read(`specs/${pack.id}.md`);

  it('matches the name and capability to the kit, manifest and page', () => {
    expect(agent.id).toBe(compose.name);
    expect(agent.kind).toBe(pack.id);
    expect(agent.name).toBe(template.name);
    expect(page.split('\n')[0]).toBe(`# ${agent.name}`);
    expect(agent.capability).toBe(pack.capability);
    expect(agent.capability).toBe(template.capability_id);
    expect(page).toContain(`## Capability id\n\n\`${agent.capability}\``);
  });

  it('matches the claim statements and the staked claim terms', () => {
    expect(template.behaviour.claim).toEqual(pack.claim);
    expect(rows(page).filter(([name]) => /^S[1-3]$/.test(name))).toEqual(pack.claim.statements.map(({ id, text }) => [id, text]));
    const { stakeLovelace, windowMs, claimType, challengeReserveLovelace } = agent.claim;
    const { min_claim_stake, min_challenge_window, max_challenge_window } = MODULE1.protocol_params;
    expect(stakeLovelace).toBe(CLAIM_STAKE_LOVELACE);
    expect(stakeLovelace).toBeGreaterThanOrEqual(BigInt(min_claim_stake));
    for (const { id } of PACKS) {
      const env = parseExample(read(`deploy/server/.env.${id}.example`));
      expect(stakeLovelace, id).toBeLessThanOrEqual(BigInt(need(env.get('DISPUTE_CHALLENGE_STAKE_LOVELACE'), 'challenge stake')));
    }
    expect(windowMs).toBe(CLAIM_WINDOW_MS);
    expect(windowMs).toBe(DAY_MS);
    expect(windowMs).toBeGreaterThanOrEqual(min_challenge_window);
    expect(windowMs).toBeLessThanOrEqual(max_challenge_window);
    expect(claimType).toBe(agent.capability);
    expect(Buffer.byteLength(claimType)).toBeGreaterThan(0);
    expect(Buffer.byteLength(claimType)).toBeLessThanOrEqual(MAX_CLAIM_TYPE_BYTES);
    expect(challengeReserveLovelace).toBe(CHALLENGE_RESERVE_LOVELACE);
    expect(challengeReserveLovelace).toBe(BigInt(value('DISPUTE_CHALLENGE_STAKE_LOVELACE')) + 3n * UNIT);
    expect(agent.stakeLovelace).toBe(10n * UNIT);
  });

  it('matches both deploy files and the manifest on managed settings, co-sign and fault values', () => {
    const copy = /^# Copy to (\S+) next to docker-compose\.([a-z-]+)\.yml, in \S+\/([a-z-]+) \(/.exec(exampleText);
    expect(copy?.slice(1)).toEqual([agent.serviceEnvFile, agent.id, agent.folder]);
    expect(agent.exampleEnvFile).toBeNull();
    expect(agent.exampleEnvFile ?? `${agent.serviceEnvFile}.example`).toBe(exampleName);
    expect(['MOCK_PUBLIC_BASE', 'MOCK_MTLS_BASE'].map((name) => example.has(name))).toEqual([agent.envManaged.mock, agent.envManaged.mock]);
    expect(example.has('VECTOR_MODULE1_MANIFEST')).toBe(agent.envManaged.module1);
    expect(agent.publicKeyLines).toEqual([]);
    expect(template.behaviour.cosign?.route ?? null).toBe(agent.cosign ? '/cosign/delegate' : null);
    expect(example.has('COSIGN_ALLOWLIST')).toBe(agent.cosign);
    expect(routes.includes('handle /cosign/delegate {')).toBe(agent.cosign);
    expect(value('FAULT_MODE')).toBe('');
    expect(agent.faultValues).toEqual(FAULT_MODES[pack.id]);
    expect(agent.faultValues).toEqual(template.behaviour.fault_modes);
    const fault = /^# The fault switch of the service\..*The one value of this agent is ([a-z_]+),/m.exec(exampleText)?.[1];
    expect(fault === undefined ? [] : [fault]).toEqual(agent.faultValues);
    expect(Object.hasOwn(service.environment, 'FAULT_MODE')).toBe(false);
  });

  it('matches the advert model, price, bonds, window and lock to the public terms', () => {
    expect(agent.adverts).toHaveLength(1);
    expect(advert.model).toBe(pack.model);
    expect(template.interface.notes.some((line) => line.startsWith(`The advert and every receipt name the model ${advert.model}.`))).toBe(true);
    expect(advert.priceLovelace).toBe(BigInt(template.terms.price_lovelace));
    expect(advert.priceLovelace).toBe(BigInt(value('ADVERT_PRICE_LOVELACE')));
    expect(advert.supplierBondLovelace).toBe(BigInt(template.terms.supplier_bond_lovelace));
    expect(advert.buyerBondLovelace).toBe(BigInt(template.terms.buyer_bond_lovelace));
    expect(advert.windowMs).toBe(template.terms.max_processing_ms);
    expect(String(advert.windowMs)).toBe(value('ADVERT_MAX_PROCESSING_MS'));
    expect(String(advert.windowMs)).toBe(runtime.environment.ADVERT_MAX_PROCESSING_MS);
    expect(cell(runbook, 'Window of the advert').replaceAll(',', '')).toBe(`${advert.windowMs} ms`);
    expect(cell(page, 'Processing window, advert `max_processing_ms`')).toBe(`${advert.windowMs} ms`);
    expect(lock(advert)).toBe(pack.lock);
    for (const [row, amount] of [
      ['Price', advert.priceLovelace], ['Supplier bond', advert.supplierBondLovelace], ['Buyer bond', advert.buyerBondLovelace],
      ['Locked by the buyer (price and both bonds)', pack.lock],
    ] as const) expect(cell(page, row)).toBe(String(amount));
    expect(advert.depositLovelace).toBeGreaterThanOrEqual(2_200_000n);
    expect(advert.depositLovelace).toBe(2_500_000n);
    expect(advert.maxOutputTokens).toBe(0);
  });

  it('matches the runtime and service origins, ports and containers to the deployment files', () => {
    const origin = new URL(advert.origin);
    expect(origin.protocol).toBe('https:');
    expect(origin.origin).toBe(advert.origin);
    expect(agent.endpoint).toBe(advert.origin);
    expect(runtime.environment.PUBLIC_ORIGIN).toBe(advert.origin);
    expect(agent.statusUrls).toEqual([`${advert.origin}${template.interface.routes.status}`]);
    expect(advert.runtimeContainer).toBe(runtime.container_name);
    expect(agent.serviceContainer).toBe(service.container_name);
    expect(runtime.ports).toEqual([`127.0.0.1:${pack.runtimePort}:${runtime.environment.PORT}`]);
    expect(service.ports).toEqual([`127.0.0.1:${pack.servicePort}:${service.environment.PORT}`]);
    expect(runtime.environment.PORT).toBe('8080');
    expect(service.environment.PORT).toBe(String(pack.servicePort));
    expect(runtime.env_file).toEqual([{ path: `./${advert.runtimeEnvFile}`, required: true }]);
    expect(service.env_file).toEqual([{ path: `./${agent.serviceEnvFile}`, required: true }]);
    expect(advert.runtimeEnvFile).toBe(agent.serviceEnvFile);

    const upstream = `${agent.serviceContainer}:${service.environment.PORT}`;
    expect(runtime.environment.SERVICE_URL).toBe(`http://${upstream}/`);
    expect(runtime.environment.SERVICE_PRECHECK_URL).toBe(`http://${upstream}/precheck`);
    expect(routes).toEqual([
      `${origin.host} {`, 'handle /agent.json {', `reverse_proxy ${upstream}`, '}',
      ...(agent.cosign ? ['handle /cosign/delegate {', `reverse_proxy ${upstream}`, '}'] : []),
      'handle {', `reverse_proxy ${advert.runtimeContainer}:${runtime.environment.PORT}`, '}', '}',
    ]);
    expect(rows(runbook).find((row) => row.length === 8 && row[1] === `\`${advert.runtimeContainer}\``)?.map((value) => value.replaceAll('`', ''))).toEqual([
      agent.name.replace(/ Agent$/, ''), advert.runtimeContainer, String(pack.runtimePort), origin.host, advert.model, units(advert.priceLovelace),
      `${units(advert.supplierBondLovelace)} and ${units(advert.buyerBondLovelace)}`, units(lock(advert)),
    ]);
    expect(/^The service is the container `([^`]+)`, on `127\.0\.0\.1:(\d+)`\./m.exec(runbook)?.slice(1)).toEqual([agent.serviceContainer, String(pack.servicePort)]);
  });

  it('fills each key line once and preserves the ownership and placement of each key', () => {
    expect(agent.serviceKey).toBe(pack.service);
    expect(advert.supplierKey).toBe(pack.supplier);
    expect(keyEnvProblems(data, agent, example, templateText)).toEqual([]);
    const keys = keysOf(data, agent);
    const placeholder = (key: string, of: KeyLine['of']): string => `<${need(keys.find((use) => use.key === key)?.lines.find((line) => line.of === of)?.name, `${key} ${of}`)}>`;
    expect(template.keys).toEqual({
      supplier_pkh: placeholder(pack.supplier, 'pkh'), pub_key_hex: placeholder(pack.supplier, 'pub'), buyer_pkh: placeholder(pack.service, 'pkh'),
      ...(pack.delegation.length === 0 ? {} : { delegation_pkhs: pack.delegation.map((key) => placeholder(key, 'pkh')) }),
    });
    const serviceSecrets = keys.filter(({ key }) => key !== pack.supplier)
      .flatMap(({ lines }) => lines.filter(({ of }) => of === 'secret').map(({ name }) => name));
    for (const [container, names] of [[runtime, serviceSecrets], [service, ['SUPPLIER_PRIV_KEY_HEX']]] as const) {
      const actual = Object.keys(container.environment).filter((name) => keyLineType(name) === 'secret').sort();
      expect(actual).toEqual([...names].sort());
      for (const name of actual) expect(container.environment[name] === '', name).toBe(true);
    }
    for (const name of ['AGENT_DID', 'AGENT_ID', 'ADVERT_REF', ...subagentsOf(data, agent).map(({ id }) => `${id.toUpperCase().replaceAll('-', '_')}_DID`)]) {
      expect(value(name)).toBe('');
    }
    expect(value('VECTOR_MODULE1_MANIFEST').split('<commit>/')[1]).toBe(data.moduleManifestPath);
  });

  it('refuses duplicate, missing and unknown key lines and unknown template placeholders', () => {
    const supplier = need(agent.keys.find(({ key }) => key === pack.supplier), 'supplier key use');
    const changed = (lines: readonly KeyLine[]): AgentSpec => ({ ...agent, keys: agent.keys.map((key) => key === supplier ? { ...key, lines } : key) });
    const secret = need(supplier.lines.find(({ of }) => of === 'secret'), 'supplier secret line');
    expect(keyEnvProblems(data, changed([...supplier.lines, secret]), example, templateText)).toContain(`${agent.id}: SUPPLIER_PRIV_KEY_HEX needs exactly one line`);
    expect(keyEnvProblems(data, changed(supplier.lines.filter((line) => line !== secret)), example, templateText)).toContain(`${agent.id}: SUPPLIER_PRIV_KEY_HEX needs exactly one line`);
    expect(keyEnvProblems(data, changed([...supplier.lines, { ...secret, name: 'OTHER_PRIV_KEY_HEX' }]), example, templateText)).toContain(`${pack.supplier}: OTHER_PRIV_KEY_HEX is not in the example`);
    expect(keyEnvProblems(data, agent, example, `${templateText}<OTHER_PKH>`)).toContain(`${agent.id}: no unique line for <OTHER_PKH>`);
  });

  it('refuses supplier keys that exchange their runtime env files', () => {
    const otherId = pack.id === PACKS[0].id ? PACKS[1].id : PACKS[0].id;
    const other = agentOf(data, otherId);
    let swapped = data;
    for (const [owner, destination] of [[agent, other.serviceEnvFile], [other, agent.serviceEnvFile]] as const) {
      const supplier = need(owner.adverts[0], 'runtime advert').supplierKey;
      const keys = owner.keys.map((keyUse) => keyUse.key === supplier
        ? { ...keyUse, lines: keyUse.lines.map((line) => ({ ...line, file: destination })) } : keyUse);
      swapped = changeAgent(swapped, owner.id, { keys });
    }
    expect(keyEnvProblems(swapped, agentOf(swapped, agent.id), example, templateText)).toContain(`${pack.supplier}: SUPPLIER_PRIV_KEY_HEX belongs in ${agent.serviceEnvFile}`);
  });

  it('matches the design table and refuses a wrong key purpose, organisation or public origin', () => {
    expect(designProblems(data, pack, page)).toEqual([]);
    const changedKey = changeAgent(data, agent.id, { keys: agent.keys.map((key) => key.key === pack.supplier ? { ...key, purposes: ['assertion'] } : key) });
    expect(designProblems(changedKey, pack, page)).toContain(`${pack.supplier}: the purposes differ from the page`);
    const changedDomain = { ...data, organisations: data.organisations.map((org) => org.id === agent.organisation ? { ...org, domain: 'example.org' } : org) };
    expect(designProblems(changedDomain, pack, page)).toContain(`${agent.id}: the organisation differs from the page`);
    const changedOrigin = changeAgent(data, agent.id, { adverts: [{ ...advert, origin: 'https://example.org' }] });
    expect(designProblems(changedOrigin, pack, page)).toContain(`${agent.id}: the origins differ from the page`);
  });

  it('has the parties in the design table and gives the Provider no rights', () => {
    const org = need(data.organisations.find(({ id }) => id === pack.organisation), `${pack.organisation} organisation`);
    const party = cell(page, 'Parties');
    expect(party).toContain('Accountable: the Accountable key of the organisation, with its domain.');
    expect(party).toContain('Responsible: Module-1. Provider: the Provider key.');
    expect(party).toContain('Guardians: the guardian key of the organisation and a controller key of this deployment');
    expect(String(agent.guardianThreshold)).toBe(/threshold (\d+)/.exec(party)?.[1]);
    expect(agent.parties).toEqual([
      { role: 'Accountable', signer: { kind: 'key', key: org.accountableKey }, organisation: org.domain, rights: null },
      { role: 'Responsible', signer: { kind: 'module1' }, organisation: null, rights: null },
      { role: 'Provider', signer: { kind: 'key', key: 'provider' }, organisation: null, rights: [] },
      { role: 'Guardian', signer: { kind: 'key', key: org.guardianKey }, organisation: null, rights: null },
      { role: 'Guardian', signer: { kind: 'key', key: 'controller' }, organisation: null, rights: null },
    ]);
  });

  it('funds the listed stake, two open claims, the challenge stake and the advert', () => {
    expect(budgetItem(agent.serviceKey, 'Stake')).toBe(agent.stakeLovelace);
    expect(budgetItem(agent.serviceKey, 'Two claims in flight')).toBe(2n * agent.claim.stakeLovelace);
    expect(budgetItem(agent.serviceKey, 'One challenge')).toBe(BigInt(value('DISPUTE_CHALLENGE_STAKE_LOVELACE')));
    expect(budgetItem(advert.supplierKey, 'Deposit of the advert')).toBe(advert.depositLovelace);
    expect(budgetItem(advert.supplierKey, 'Supplier bond')).toBe(advert.supplierBondLovelace);
  });

  it('matches the uncovered items to the gap in the service, template and page', () => {
    const source = read(`agents/${pack.id}/src/serve/gaps.ts`);
    const definition = need(/^export const NOT_SHOWN_GAP =([\s\S]*?);/m.exec(source)?.[1], 'NOT_SHOWN_GAP');
    const gap = [...definition.matchAll(/'([^']*)'/g)].map(([, text]) => text).join('');
    expect(template.gaps.filter((line) => line.startsWith('What this does not show:'))).toEqual([gap]);
    expect(page.split('\n').filter((line) => line.startsWith('- What this does not show:'))).toEqual([`- ${gap}`]);
    const uncovered = /^What this does not show: no run covers (.+?), (.+?), or (.+)\. Tests alone cover the last two\.$/.exec(gap);
    expect(uncovered?.[3]).toBe(pack.gapChallenge);
    const items = [need(uncovered?.[1], 'refund gap'), need(uncovered?.[2], 'token gap')].map((text) => `${text[0].toUpperCase()}${text.slice(1)}.`);
    expect(data.notCovered.items).toEqual([
      ...items,
      'A challenge of the Insurer Intake Agent by the Prior Authorization Agent.',
    ]);
  });
});

describe('use case 2 (prior authorization)', () => {
  it('uses 18 valid, distinct keys and the registry can load them all', () => {
    expect(data.keys.filter(({ scope }) => scope === 'shared').map(({ name }) => name).sort()).toEqual([...SHARED_KEYS].sort());
    const keyUses = data.agents.flatMap((agent) => keysOf(data, agent)).map(({ key }) => key);
    expect(data.keys.filter(({ scope }) => scope === 'use-case').map(({ name }) => name).sort()).toEqual(keyUses.sort());
    expect(keyUses).toHaveLength(10);
    const referenced = new Set([
      'run', 'fee', ...keyUses, ...data.funding.map(({ wallet }) => wallet),
      ...data.organisations.flatMap(({ accountableKey, guardianKey }) => [accountableKey, guardianKey]),
      ...data.agents.flatMap((agent) => [agent.serviceKey, ...agent.adverts.map(({ supplierKey }) => supplierKey),
        ...agent.parties.flatMap(({ signer }) => signer.kind === 'key' ? [signer.key] : [])]),
    ]);
    const names = data.keys.map(({ name }) => name);
    expect(names).toHaveLength(18);
    expect(new Set(names)).toEqual(referenced);
    for (const key of data.keys) {
      expect(key.name).toMatch(/^[a-z][a-z0-9-]{0,47}$/);
      expect(key.about).toMatch(/^.{1,200}$/);
    }
    const root = makeKeyRoot();
    expect(makeMissingKeys(root, data.name, data.keys).made).toHaveLength(18);
    const registry = loadRegistry({ dir: root, useCase: data.name, specs: data.keys });
    expect(registry.names()).toEqual(names);
    expect(registry.isComplete()).toBe(true);
  });

  it('uses the synthetic order and funds one clean or four failure payments plus the minimum output', () => {
    expect(data.runs.map(({ id }) => id)).toEqual(['clean', 'failure']);
    expect(data.tenantSeed).toBeNull();
    expect(data.tenantOrganisations).toEqual({
      supplier: 'alfa.vector.apexfusion.org', insurer: need(data.organisations.find(({ id }) => id === 'delta'), 'insurer organisation').domain,
    });
    expect(runProblems(data)).toEqual([]);
    expect(runProblems({ ...data, runs: data.runs.map((run) => ({ ...run, subject: 'ORD-1002' })) })).toContain('clean: the seeded order is not ORD-1001');
    expect(runProblems({ ...data, runs: data.runs.map((run) => ({ ...run, perTxUnits: 5, totalUnits: 20 })) })).toContain('failure: the limits must allow 4 payments of 4000000 lovelace');
    expect(runProblems({ ...data, runs: data.runs.map((run) => ({ ...run, vaultUnits: run.totalUnits })) })).toContain('clean: the vault must hold the total and the minimum output');
  });

  it('funds each paying wallet once, with one collateral output and a rounded float', () => {
    expect(fundingProblems(data)).toEqual([]);
    expect(data.funding.map(({ wallet, items, floatLovelace }) => [wallet, items.reduce((sum, item) => sum + item.lovelace, 0n), floatLovelace])).toEqual([
      ['fee', 63_860_000n, 70_000_000n], ['priorauth-supplier', 9_850_000n, 10_000_000n], ['intake-supplier', 7_450_000n, 10_000_000n],
      ['priorauth-delegation-1', 16_200_000n, 20_000_000n], ['priorauth-delegation-2', 16_200_000n, 20_000_000n],
      ['priorauth-service', 181_020_000n, 190_000_000n], ['intake-service', 176_620_000n, 180_000_000n],
    ]);
    expect(data.funding.reduce((sum, line) => sum + line.collateralLovelace, 0n)).toBe(35n * UNIT);
    expect(data.funding.reduce((sum, line) => sum + line.floatLovelace, 0n)).toBe(500n * UNIT);
    expect(budgetItem('fee', 'Deposits of the records')).toBe(BigInt(data.agents.length + data.subagents.length) * 10n * UNIT);
    expect(budgetItem('fee', 'Deposits of the attestations')).toBe(BigInt(data.attestations.flatMap(({ types }) => types).length) * 5n * UNIT);
    const fee = need(data.funding.find(({ wallet }) => wallet === 'fee'), 'fee wallet');
    expect(fundingProblems({ ...data, funding: [...data.funding, fee] })).toContain('Each paying wallet needs exactly one line.');
    expect(fundingProblems({ ...data, funding: data.funding.map((line) => line.wallet === 'fee' ? { ...line, floatLovelace: 60n * UNIT } : line) }))
      .toContain('fee: the float must cover the items, rounded up to 10 units');
  });

  it('uses the runtime revision verified by CI', () => {
    const ci = parseYaml(read('.github/workflows/ci.yml')) as { env?: { AGENT_RUNTIME_TEMPLATE_COMMIT?: string } };
    expect(data.runtimeCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(data.runtimeCommit).toBe(ci.env?.AGENT_RUNTIME_TEMPLATE_COMMIT);
  });

  it('defines the registered records, the attestations and the final state', () => {
    expect([data.name, data.title]).toEqual(['prior-authorization', 'Use case 2 (prior authorization)']);
    expect(data.agents.map(({ id }) => id)).toEqual(PACKS.map(({ id }) => id));
    expect(data.organisations.map(({ id }) => id)).toEqual(['echo', 'delta']);
    expect(data.subagents.map(({ id }) => id)).toEqual(SUBAGENTS);
    for (const record of [...data.agents, ...data.subagents]) {
      expect(Buffer.byteLength(record.name)).toBeGreaterThan(0);
      expect(Buffer.byteLength(record.name)).toBeLessThanOrEqual(64);
      expect(Buffer.byteLength(record.description)).toBeLessThanOrEqual(256);
      expect(record.description).toContain('use case 2 (prior authorization)');
    }
    for (const child of data.subagents) {
      expect(child.parent).toBe('prior-authorization-agent');
      expect(child.name).toBe(child.id);
      expect(child.description).toMatch(/^Demonstration organisation run by the Apex Fusion Foundation\./);
      expect(child).not.toHaveProperty('endpoint');
    }
    expect(data.attestations).toEqual(PACKS.map(({ id }) => ({ agent: id, types: ['provenance', 'software'], format: 50, validDays: 365, envelope: null })));
    expect(data.agents.map(({ end }) => end)).toEqual([
      { record: 'active', advert: 'retired', subagents: 'ended', successor: null },
      { record: 'active', advert: 'listed', subagents: 'live', successor: null },
    ]);
    expect([data.records, data.compliance, data.lifecycle]).toEqual([[], null, null]);
  });

  it('keeps the clean and failure evidence in run order and names the actors', () => {
    expect(data.evidenceSteps.map(({ id, run, actor }) => [id, run, actor])).toEqual([
      ['r1-01', 'clean', 'hirer'], ['r1-02', 'clean', 'agent'], ['r1-03', 'clean', 'hirer'], ['r1-04', 'clean', 'agent'],
      ['r1-05', 'clean', 'counterparty'], ['r1-06', 'clean', 'agent'], ['r1-07', 'clean', 'hirer'],
      ['r2-d', 'failure', 'hirer'], ['r2-e', 'failure', 'counterparty'], ['r2-a', 'failure', 'counterparty'], ['r2-b', 'failure', 'counterparty'],
      ['r2-b-hold', 'failure', 'relay'], ['r2-c', 'failure', 'hirer'], ['r2-f', 'failure', 'operator'],
    ]);
    for (const step of data.evidenceSteps) {
      expect(step.what.trim(), step.id).not.toBe('');
      expect(step.primitive, step.id).toMatch(/^\S[^\n]*$/);
    }
    const policy = MODULE1.verdict_policy.auditor_wins;
    expect(policy.action).toBe('suspend');
    const hold = need(data.evidenceSteps.find(({ id }) => id === 'r2-b-hold'), 'hold step');
    expect(hold.what).toContain(`${policy.duration_ms / DAY_MS} days, reason ${REASON_DISPUTE_VERDICT}.`);
  });

  it('counts the uncovered items and lists one sentence per item, not an evidence step', () => {
    const { lead, items } = data.notCovered;
    const count = ['two', 'three', 'four', 'five'][items.length - 2];
    expect(count).toBeDefined();
    expect(lead).toBe(`No run covers these ${count} items:`);
    expect(new Set(items).size).toBe(items.length);
    for (const item of items) {
      expect(item).toMatch(/^[A-Z][^.!?\n]{1,198}\.$/);
      expect(data.evidenceSteps.some(({ what }) => what === item)).toBe(false);
    }
  });
});
