// scripts/operator/test/usecase-inventory-reorder.test.ts - holds the data of use case 1 (inventory reorder) to the public files of the two agents.
// Each test reads public files of the repository and fails when a name or a number of the data differs from them: the manifest templates, the env examples, the compose files, the Caddy snippets,
// the lots file, the runbooks, the specs, the kit constants and the CI file. The tests use no network.
// Each check is a function that gives the list of its problems. One test shows that the real data has none. Other tests show that a broken copy of the data, made with a spread, has the problem
// that the test names.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { afterAll, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { MAX_CLAIM_TYPE_BYTES } from '../../../packages/usecase-kit/src/dispute/index.ts';
import { INVENTORY_CAPABILITIES, ORDER_DESK_CLAIM, REORDER_CLAIM } from '../../../packages/usecase-kit/src/inventory/index.ts';
import { BID_CAPABILITIES, BID_DESK_CLAIM, SOURCING_CLAIM } from '../../../packages/usecase-kit/src/bids/index.ts';
import { INTAKE_CLAIM, PRIORAUTH_CAPABILITIES, PRIORAUTH_CLAIM } from '../../../packages/usecase-kit/src/priorauth/index.ts';
import type { AdvertSpec, AgentSpec, KeyLine, KeyUse, PartySpec, UseCase } from '../lib/contract.ts';
import { loadRegistry, makeMissingKeys } from '../lib/registry.ts';
import data from '../usecases/inventory-reorder.ts';
import { makeKeyRoot, removeTestKeys } from './support/keys.ts';

afterAll(removeTestKeys);

// ---- the public files ----

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const read = (path: string): string => readFileSync(`${ROOT}${path}`, 'utf8');
const need = <T>(value: T | undefined, what: string): T => {
  if (value === undefined) throw new Error(`a public file lacks ${what}`);
  return value;
};

const EXAMPLE_FILES = ['.env.reorder-agent.example', '.env.order-desk.example', '.env.order-desk-runtime.example'] as const;
type ExampleFile = (typeof EXAMPLE_FILES)[number];

/** The variable lines of an env example: each line that starts with a name and an equals sign. A comment line is no variable line. */
function parseExample(text: string): ReadonlyMap<string, string> {
  const lines = new Map<string, string>();
  for (const row of text.split('\n')) {
    const found = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(row);
    if (found !== null) lines.set(found[1], found[2]);
  }
  return lines;
}

const EXAMPLE_TEXTS = Object.fromEntries(EXAMPLE_FILES.map((file) => [file, read(`deploy/server/${file}`)])) as Record<ExampleFile, string>;
const EXAMPLES = Object.fromEntries(EXAMPLE_FILES.map((file) => [file, parseExample(EXAMPLE_TEXTS[file])])) as Record<ExampleFile, ReadonlyMap<string, string>>;
const valueOf = (file: ExampleFile, name: string): string => need(EXAMPLES[file].get(name), `the line ${name} of ${file}`);

/** The example that each env file of the data is made from. The three runtime files of the Order Desk share one example. */
const EXAMPLE_OF: Readonly<Record<string, ExampleFile>> = {
  '.env.reorder-agent': '.env.reorder-agent.example',
  '.env.order-desk': '.env.order-desk.example',
  '.env.order-desk-small': '.env.order-desk-runtime.example',
  '.env.order-desk-medium': '.env.order-desk-runtime.example',
  '.env.order-desk-large': '.env.order-desk-runtime.example',
};

interface Template {
  name: string;
  capability_id: string;
  interface: { routes: { status: string } };
  terms: {
    price_lovelace?: number; supplier_bond_lovelace?: number; buyer_bond_lovelace?: number; max_processing_ms?: number;
    tiers?: { model: string; price_lovelace: number; supplier_bond_lovelace: number; buyer_bond_lovelace: number; max_processing_ms: number }[];
  };
  behaviour: { claim: { statements: { id: string; text: string }[] }; fault_modes: string[] };
}

interface ComposeService { container: string; env: Readonly<Record<string, string>>; ports: readonly string[]; envFiles: readonly string[] }

/** The services of a compose file: the container name, the environment, the published ports and the paths of the env files. */
function parseCompose(text: string): ComposeService[] {
  const document = parseYaml(text) as {
    services: Record<string, { container_name: string; environment?: Record<string, unknown>; ports?: string[]; env_file?: (string | { path: string })[] }>;
  };
  return Object.values(document.services).map((service) => ({
    container: service.container_name,
    env: Object.fromEntries(Object.entries(service.environment ?? {}).map(([name, value]) => [name, String(value)])),
    ports: service.ports ?? [],
    envFiles: (service.env_file ?? []).map((entry) => (typeof entry === 'string' ? entry : entry.path)),
  }));
}

interface CaddyHandle { path: string | null; upstream: string }
interface CaddyBlock { host: string; handles: CaddyHandle[] }

/** The host blocks of a Caddy snippet. A handle that has no path is the default handle. A line that the test cannot read is an error, so that a new form of line does not pass unseen. */
function parseCaddy(text: string): CaddyBlock[] {
  const blocks: CaddyBlock[] = [];
  let handle: CaddyHandle | undefined;
  for (const row of text.split('\n')) {
    if (row.trim() === '' || row.startsWith('#')) continue;
    const site = /^(\S+) \{$/.exec(row);
    const open = /^\s+handle(?: (\S+))? \{$/.exec(row);
    const proxy = /^\s+reverse_proxy (\S+)$/.exec(row);
    const block = blocks.at(-1);
    if (site !== null) {
      blocks.push({ host: site[1], handles: [] });
    } else if (open !== null && block !== undefined) {
      handle = { path: open[1] ?? null, upstream: '' };
      block.handles.push(handle);
    } else if (proxy !== null && handle !== undefined) {
      handle.upstream = proxy[1];
    } else if (row.trim() !== '}') {
      throw new Error(`the test cannot read this line of a Caddy snippet: ${row}`);
    }
  }
  return blocks;
}

/** The cells of the rows of the table of a runbook that lists the runtimes (eight columns), by container name, without the backticks. */
function runbookRows(text: string): Map<string, string[]> {
  const rows = new Map<string, string[]>();
  for (const row of text.split('\n')) {
    if (!row.startsWith('| ')) continue;
    const cells = row.split('|').slice(1, -1).map((cell) => cell.trim().replaceAll('`', ''));
    if (cells.length === 8 && cells[0] !== 'Runtime') rows.set(cells[1], cells);
  }
  return rows;
}

/** The text of the second cell of the row of a spec table whose first cell is `first`. */
function specRow(spec: string, first: string): string | undefined {
  for (const row of spec.split('\n')) {
    const cells = row.split('|').map((cell) => cell.trim());
    if (cells[1] === first) return cells[2];
  }
  return undefined;
}

interface AgentFiles {
  template: Template; templateText: string; example: ReadonlyMap<string, string>; exampleText: string; compose: readonly ComposeService[]; caddy: readonly CaddyBlock[]; spec: string; runbook: string;
}

function agentFiles(id: string, example: ExampleFile): AgentFiles {
  const templateText = read(`agents/${id}/agent.json.template`);
  return {
    template: JSON.parse(templateText) as Template,
    templateText,
    example: EXAMPLES[example],
    exampleText: EXAMPLE_TEXTS[example],
    compose: parseCompose(read(`deploy/server/docker-compose.${id}.yml`)),
    caddy: parseCaddy(read(`deploy/server/Caddyfile.${id}.snippet`)),
    spec: read(`specs/${id}.md`),
    runbook: read(`deploy/server/RUNBOOK-${id}.md`),
  };
}

const AGENT_FILES: Readonly<Record<string, AgentFiles | undefined>> = {
  'reorder-agent': agentFiles('reorder-agent', '.env.reorder-agent.example'),
  'order-desk': agentFiles('order-desk', '.env.order-desk.example'),
};

/** The files of an agent of the data. An agent that has no files is a problem, and the caller skips it. A test gives a table with a broken copy of a file. */
function filesOf(agent: AgentSpec, problems: string[], table = AGENT_FILES): AgentFiles | undefined {
  const files = table[agent.id];
  if (files === undefined) problems.push(`${agent.id}: the repository has no public files for this agent`);
  return files;
}

const LOTS = JSON.parse(read('agents/order-desk/lots.json')) as { items: { sku: string; lots: Record<string, number> }[] };
const CI = parseYaml(read('.github/workflows/ci.yml')) as { jobs: Record<string, { steps?: { with?: { repository?: string; ref?: string } }[] }> };
const TEMPLATE_REPOSITORY = 'Apex-Fusion/vector-agent-template';
const TEMPLATE_CHECKOUT_REFS: readonly string[] = Object.values(CI.jobs)
  .flatMap((job) => job.steps ?? [])
  .filter((step) => step.with?.repository === TEMPLATE_REPOSITORY)
  .map((step) => String(step.with?.ref));

// ---- what the deployment fixes (the host ports of the containers, the locks, the least stake, the totals of the funding) ----

/** The host port of each container of use case 1 (inventory reorder): the four runtimes publish 8101 to 8104, and the two services publish 9101 and 9102. */
const EXPECTED_PORTS: Readonly<Record<string, number>> = {
  'reorder-runtime': 8101, 'orders-small-runtime': 8102, 'orders-medium-runtime': 8103, 'orders-large-runtime': 8104, 'reorder-service': 9101, 'orders-service': 9102,
};
const SERVICE_CONTAINER: Readonly<Record<string, string>> = { 'reorder-agent': 'reorder-service', 'order-desk': 'orders-service' };
/** The lock of an advert (the price and both bonds), in units. */
const LOCK_UNITS: Readonly<Record<string, bigint>> = { 'reorder-agent-v1': 5n, 'lot-small': 4n, 'lot-medium': 7n, 'lot-large': 12n };
const UNIT = 1_000_000n;
/**
 * The least deposit of an advert, in lovelace. An advert output holds a datum of about 300 bytes. The ledger asks 4310 lovelace for each byte of an output, so the output holds at least about
 * 2.2 units, and the hosted builder refuses a deposit below the minimum of its output.
 */
const LEAST_ADVERT_DEPOSIT = 2_200_000n;
interface Module1Manifest { protocol_params: { min_claim_stake: number; min_challenge_window: number; max_challenge_window: number } }
/** The published manifest of the Module-1 deployment holds the parameters that limit a claim, the least stake and the window. The fixtures of buyer-core keep a copy of it. */
const MODULE1 = JSON.parse(read('packages/buyer-core/test/fixtures/module1-mainnet-manifest.json')) as Module1Manifest;
const LEAST_CLAIM_STAKE = BigInt(MODULE1.protocol_params.min_claim_stake);
const LEAST_CLAIM_WINDOW_MS = MODULE1.protocol_params.min_challenge_window;
const MOST_CLAIM_WINDOW_MS = MODULE1.protocol_params.max_challenge_window;
const COLLATERAL = 5_000_000n;
/** A float is the sum of the items of its wallet, rounded up to a multiple of this step, 10 units. */
const FLOAT_STEP = 10_000_000n;
const TOTAL_COLLATERAL = 45n * UNIT;
const TOTAL_FLOATS = 460n * UNIT;
const TOTAL_LINES = 505n * UNIT;
const SHARED_KEYS = ['controller', 'run', 'fee', 'provider', 'accountable-echo', 'guardian-echo', 'accountable-alfa', 'guardian-alfa'];
const USE_CASE_KEYS = [
  'reorder-supplier', 'reorder-service', 'reorder-delegation-1', 'reorder-delegation-2', 'stock-reader-auth', 'stock-reader-delegation',
  'order-small-supplier', 'order-medium-supplier', 'order-large-supplier', 'order-desk-service',
];
const KEY_NAME = /^[a-z][a-z0-9-]{0,47}$/;

const unitsText = (lovelace: bigint): string => (Number(lovelace) / Number(UNIT)).toString();
/** The URL that a text holds, or null when the text is no URL: a bad value of the data is a problem and no exception. */
const parseUrl = (text: string): URL | null => {
  try {
    return new URL(text);
  } catch {
    return null;
  }
};
/** The host of an https origin (no path, no query), or null when the text is anything else. */
const hostOf = (origin: string): string | null => {
  const url = parseUrl(origin);
  return url !== null && url.protocol === 'https:' && url.origin === origin ? url.host : null;
};

// ---- builders of broken copies ----

const mapAgent = (use: UseCase, id: string, change: (agent: AgentSpec) => AgentSpec): UseCase => ({ ...use, agents: use.agents.map((agent) => (agent.id === id ? change(agent) : agent)) });
const mapAdvert = (use: UseCase, id: string, model: string, change: Partial<AdvertSpec>): UseCase =>
  mapAgent(use, id, (agent) => ({ ...agent, adverts: agent.adverts.map((advert) => (advert.model === model ? { ...advert, ...change } : advert)) }));
const mapKeyUse = (use: UseCase, key: string, change: (keyUse: KeyUse) => KeyUse): UseCase => ({
  ...use,
  agents: use.agents.map((agent) => ({ ...agent, keys: agent.keys.map((keyUse) => (keyUse.key === key ? change(keyUse) : keyUse)) })),
  subagents: use.subagents.map((subagent) => ({ ...subagent, keys: subagent.keys.map((keyUse) => (keyUse.key === key ? change(keyUse) : keyUse)) })),
});
const mapLine = (use: UseCase, key: string, name: string, change: Partial<KeyLine>): UseCase =>
  mapKeyUse(use, key, (keyUse) => ({ ...keyUse, lines: keyUse.lines.map((line) => (line.name === name ? { ...line, ...change } : line)) }));
const mapParties = (use: UseCase, id: string, change: (parties: readonly PartySpec[]) => readonly PartySpec[]): UseCase => mapAgent(use, id, (agent) => ({ ...agent, parties: change(agent.parties) }));
const mapFunding = (use: UseCase, wallet: string, change: Partial<UseCase['funding'][number]>): UseCase => ({
  ...use, funding: use.funding.map((line) => (line.wallet === wallet ? { ...line, ...change } : line)),
});
/** A table of the public files with the files of one agent changed: a test uses it to show that a check refuses a broken copy of a public file. */
const withFiles = (id: string, change: (files: AgentFiles) => AgentFiles): Readonly<Record<string, AgentFiles | undefined>> => ({ ...AGENT_FILES, [id]: change(need(AGENT_FILES[id], `the files of ${id}`)) });
const mapService = (files: AgentFiles, container: string, change: (service: ComposeService) => ComposeService): AgentFiles => ({
  ...files, compose: files.compose.map((service) => (service.container === container ? change(service) : service)),
});
const mapHandle = (files: AgentFiles, path: string | null, change: (handle: CaddyHandle) => CaddyHandle): AgentFiles => ({
  ...files, caddy: files.caddy.map((block) => ({ ...block, handles: block.handles.map((handle) => (handle.path === path ? change(handle) : handle)) })),
});

// ---- the capabilities and the claim statements ----

const KIT_OF_KIND: Readonly<Record<AgentSpec['kind'], { capability: string; claim: typeof REORDER_CLAIM }>> = {
  'reorder-agent': { capability: INVENTORY_CAPABILITIES.reorder, claim: REORDER_CLAIM },
  'order-desk': { capability: INVENTORY_CAPABILITIES.order, claim: ORDER_DESK_CLAIM },
  'prior-authorization-agent': { capability: PRIORAUTH_CAPABILITIES.draft, claim: PRIORAUTH_CLAIM },
  'insurer-intake-agent': { capability: PRIORAUTH_CAPABILITIES.intake, claim: INTAKE_CLAIM },
  'sourcing-agent': { capability: BID_CAPABILITIES.evaluate, claim: SOURCING_CLAIM },
  'bid-desk': { capability: BID_CAPABILITIES.quote, claim: BID_DESK_CLAIM },
};

/** The capability of each agent is the capability that the kit gives to its kind, the template names it, and the claim of the template is the claim that the kit holds for that capability. */
function capabilityProblems(use: UseCase, kit = KIT_OF_KIND): string[] {
  const problems: string[] = [];
  for (const agent of use.agents) {
    const files = filesOf(agent, problems);
    if (files === undefined) continue;
    if (agent.capability !== kit[agent.kind].capability) problems.push(`${agent.id}: the capability is ${agent.capability} and the kit gives ${kit[agent.kind].capability} to its kind`);
    if (files.template.capability_id !== agent.capability) problems.push(`${agent.id}: the template names the capability ${files.template.capability_id} and the data has ${agent.capability}`);
    const claim = Object.values(kit).find((entry) => entry.capability === agent.capability)?.claim;
    if (claim === undefined) problems.push(`${agent.id}: no claim of the kit has the capability ${agent.capability}`);
    else if (!isDeepStrictEqual(files.template.behaviour.claim.statements, claim.statements)) problems.push(`${agent.id}: the claim statements of the template differ from the claim of the kit for ${agent.capability}`);
  }
  return problems;
}

/** The first line of an example says which file to make from it and in which folder of the host: "Copy to <file> next to <compose file>, in <path>/<folder> (". */
const COPY_LINE = /^# Copy to (\S+) next to \S+, in \S*\/([a-z-]+) \(/;

/** The name, the env file and the folder, the co-sign flag and the fault values of each agent are those of its template, its example, its Caddy snippet and its compose file. */
function agentProblems(use: UseCase): string[] {
  const problems: string[] = [];
  for (const agent of use.agents) {
    const files = filesOf(agent, problems);
    if (files === undefined) continue;
    if (agent.name !== files.template.name) problems.push(`${agent.id}: the name is ${agent.name} and the template says ${files.template.name}`);
    const copy = COPY_LINE.exec(files.exampleText.split('\n')[0]);
    if (copy === null) problems.push(`${agent.id}: the first line of the example does not say where to copy it`);
    else {
      if (copy[1] !== agent.serviceEnvFile) problems.push(`${agent.id}: the example is copied to ${copy[1]} and the data has the env file ${agent.serviceEnvFile}`);
      if (copy[2] !== agent.folder) problems.push(`${agent.id}: the example is copied to the folder ${copy[2]} and the data has the folder ${agent.folder}`);
    }
    const fromExample = files.example.has('COSIGN_ALLOWLIST');
    const fromCaddy = files.caddy.every((block) => block.handles.some((handle) => handle.path === '/cosign/delegate'));
    if (agent.cosign !== fromExample) problems.push(`${agent.id}: cosign is ${agent.cosign} and the example ${fromExample ? 'has' : 'has no'} line COSIGN_ALLOWLIST`);
    if (agent.cosign !== fromCaddy) problems.push(`${agent.id}: cosign is ${agent.cosign} and the Caddy blocks ${fromCaddy ? 'all route' : 'do not all route'} /cosign/delegate`);
    if (!isDeepStrictEqual(agent.faultValues, files.template.behaviour.fault_modes)) {
      problems.push(`${agent.id}: the fault values are ${JSON.stringify(agent.faultValues)} and the template says ${JSON.stringify(files.template.behaviour.fault_modes)}`);
    }
  }
  return problems;
}

// ---- the claim ----

function claimProblems(use: UseCase): string[] {
  const problems: string[] = [];
  const ceilings = (['.env.reorder-agent.example', '.env.order-desk.example'] as const).map((file) => ({ file, stake: BigInt(valueOf(file, 'DISPUTE_CHALLENGE_STAKE_LOVELACE')) }));
  for (const agent of use.agents) {
    const { stakeLovelace, windowMs, claimType } = agent.claim;
    if (stakeLovelace < LEAST_CLAIM_STAKE) problems.push(`${agent.id}: the claim stake ${stakeLovelace} is below the least stake of the Module-1 deployment, ${LEAST_CLAIM_STAKE}`);
    for (const ceiling of ceilings) {
      if (stakeLovelace > ceiling.stake) problems.push(`${agent.id}: the claim stake ${stakeLovelace} is above DISPUTE_CHALLENGE_STAKE_LOVELACE ${ceiling.stake} of ${ceiling.file}, so a challenge cannot target the claim`);
    }
    if (windowMs < LEAST_CLAIM_WINDOW_MS || windowMs > MOST_CLAIM_WINDOW_MS) problems.push(`${agent.id}: the claim window ${windowMs} ms is outside ${LEAST_CLAIM_WINDOW_MS} to ${MOST_CLAIM_WINDOW_MS} ms`);
    if (claimType !== agent.capability) problems.push(`${agent.id}: the claim type ${claimType} is not the capability ${agent.capability}`);
    if (claimType === '' || Buffer.byteLength(claimType, 'utf8') > MAX_CLAIM_TYPE_BYTES) problems.push(`${agent.id}: the claim type has no bytes or more than ${MAX_CLAIM_TYPE_BYTES} bytes`);
  }
  return problems;
}

// ---- the terms of the adverts ----

interface Terms { model: string | null; price: bigint; supplierBond: bigint; buyerBond: bigint; windowMs: number }

/** The terms of a template: one set for each tier, or one set with no model for an agent that has a single advert. */
function termsOf(template: Template): Terms[] {
  const { terms } = template;
  if (terms.tiers !== undefined) {
    return terms.tiers.map((tier) => ({
      model: tier.model, price: BigInt(tier.price_lovelace), supplierBond: BigInt(tier.supplier_bond_lovelace), buyerBond: BigInt(tier.buyer_bond_lovelace), windowMs: tier.max_processing_ms,
    }));
  }
  return [{
    model: null, price: BigInt(need(terms.price_lovelace, 'terms.price_lovelace')), supplierBond: BigInt(need(terms.supplier_bond_lovelace, 'terms.supplier_bond_lovelace')),
    buyerBond: BigInt(need(terms.buyer_bond_lovelace, 'terms.buyer_bond_lovelace')), windowMs: need(terms.max_processing_ms, 'terms.max_processing_ms'),
  }];
}

function termProblems(use: UseCase): string[] {
  const problems: string[] = [];
  for (const agent of use.agents) {
    const files = filesOf(agent, problems);
    if (files === undefined) continue;
    const terms = termsOf(files.template);
    const single = terms.length === 1 && terms[0].model === null;
    const advertWindow = Number(need(files.example.get('ADVERT_MAX_PROCESSING_MS'), `ADVERT_MAX_PROCESSING_MS of the example of ${agent.id}`));
    if (single && agent.adverts.length !== 1) problems.push(`${agent.id}: the template has one set of terms and the data has ${agent.adverts.length} adverts`);
    for (const advert of agent.adverts) {
      const where = `${agent.id} ${advert.model}`;
      const term = single ? terms[0] : terms.find((candidate) => candidate.model === advert.model);
      if (term === undefined) problems.push(`${where}: the template has no tier for this model`);
      else {
        if (advert.priceLovelace !== term.price) problems.push(`${where}: the price is ${advert.priceLovelace} and the template says ${term.price}`);
        if (advert.supplierBondLovelace !== term.supplierBond) problems.push(`${where}: the supplier bond is ${advert.supplierBondLovelace} and the template says ${term.supplierBond}`);
        if (advert.buyerBondLovelace !== term.buyerBond) problems.push(`${where}: the buyer bond is ${advert.buyerBondLovelace} and the template says ${term.buyerBond}`);
        if (advert.windowMs !== term.windowMs) problems.push(`${where}: the window is ${advert.windowMs} ms and the template says ${term.windowMs} ms`);
      }
      if (advert.windowMs !== advertWindow) problems.push(`${where}: the window is ${advert.windowMs} ms and ADVERT_MAX_PROCESSING_MS of the example is ${advertWindow} ms`);
      const lock = advert.priceLovelace + advert.supplierBondLovelace + advert.buyerBondLovelace;
      const expected = LOCK_UNITS[advert.model];
      if (expected === undefined) problems.push(`${where}: no lock is known for this model`);
      else if (lock !== expected * UNIT) problems.push(`${where}: the lock is ${lock} lovelace and it must be ${expected} units`);
      if (advert.depositLovelace < LEAST_ADVERT_DEPOSIT) problems.push(`${where}: the deposit ${advert.depositLovelace} is below the least that an advert output holds, ${LEAST_ADVERT_DEPOSIT}`);
    }
    for (const term of terms) {
      if (term.model !== null && !agent.adverts.some((advert) => advert.model === term.model)) problems.push(`${agent.id}: the template has the tier ${term.model} and the data has no advert for it`);
    }
  }
  return problems;
}

/** The first table of each runbook gives the container, the host port, the host name, the model, the price, the bonds and the lock of each runtime. */
const RUNBOOK_COLUMNS = ['the host port', 'the host name', 'the model', 'the price', 'the bonds', 'the lock'];
function runbookProblems(use: UseCase): string[] {
  const problems: string[] = [];
  for (const agent of use.agents) {
    const files = filesOf(agent, problems);
    if (files === undefined) continue;
    const rows = runbookRows(files.runbook);
    for (const advert of agent.adverts) {
      const where = `${agent.id} ${advert.model}`;
      const cells = rows.get(advert.runtimeContainer);
      if (cells === undefined) {
        problems.push(`${where}: the table of the runbook has no row for the container ${advert.runtimeContainer}`);
        continue;
      }
      const lock = advert.priceLovelace + advert.supplierBondLovelace + advert.buyerBondLovelace;
      const expected = [
        String(EXPECTED_PORTS[advert.runtimeContainer]), hostOf(advert.origin) ?? 'no host', advert.model, unitsText(advert.priceLovelace),
        `${unitsText(advert.supplierBondLovelace)} and ${unitsText(advert.buyerBondLovelace)}`, unitsText(lock),
      ];
      expected.forEach((value, index) => {
        if (cells[index + 2] !== value) problems.push(`${where}: the runbook gives ${RUNBOOK_COLUMNS[index]} ${cells[index + 2]} and the data has ${value}`);
      });
    }
    for (const container of rows.keys()) {
      if (!agent.adverts.some((advert) => advert.runtimeContainer === container)) problems.push(`${agent.id}: the table of the runbook has a row for ${container} and the data has no advert for it`);
    }
  }
  return problems;
}

// ---- the keys: the env lines, the purposes and the use of each key ----

const isKeyLine = (name: string): boolean => /_(?:PRIV_KEY_HEX|PUB_KEY_HEX|PKH)$/.test(name) || name === 'SUPPLIER_ADDRESS';
const NAME_FITS: Readonly<Record<KeyLine['of'], (name: string) => boolean>> = {
  secret: (name) => name.endsWith('_PRIV_KEY_HEX'),
  pub: (name) => name.endsWith('_PUB_KEY_HEX'),
  pkh: (name) => name.endsWith('_PKH'),
  address: (name) => name === 'SUPPLIER_ADDRESS',
};

/** Each key use of the data with the agent whose env files it names: a subagent uses the files of its parent. */
function keyUsesOf(use: UseCase): { agent: AgentSpec; keyUse: KeyUse }[] {
  const uses = use.agents.flatMap((agent) => agent.keys.map((keyUse) => ({ agent, keyUse })));
  for (const subagent of use.subagents) {
    const parent = use.agents.find((agent) => agent.id === subagent.parent);
    if (parent !== undefined) uses.push(...subagent.keys.map((keyUse) => ({ agent: parent, keyUse })));
  }
  return uses;
}

/** Every env name of a key line is a line of the example of its file, the file is a file of the agent, and the name fits the kind of the line. */
function envProblems(use: UseCase): string[] {
  const problems: string[] = [];
  for (const { agent, keyUse } of keyUsesOf(use)) {
    const files = new Set([agent.serviceEnvFile, ...agent.adverts.map((advert) => advert.runtimeEnvFile)]);
    for (const line of keyUse.lines) {
      const example = EXAMPLE_OF[line.file];
      if (example === undefined) problems.push(`${keyUse.key}: the line ${line.name} names the env file ${line.file}, which has no example`);
      else if (!EXAMPLES[example].has(line.name)) problems.push(`${keyUse.key}: ${line.name} is no line of ${example}`);
      if (!files.has(line.file)) problems.push(`${keyUse.key}: the line ${line.name} names the env file ${line.file}, which is no env file of ${agent.id}`);
      if (!NAME_FITS[line.of](line.name)) problems.push(`${keyUse.key}: the name ${line.name} does not fit the kind ${line.of}`);
    }
  }
  return problems;
}

/** Every key line that an example holds (a secret, a public key, a key hash or the address of a supplier) is covered by exactly one line of the data for that file. */
function coverageProblems(use: UseCase): string[] {
  const problems: string[] = [];
  const lines = keyUsesOf(use).flatMap(({ keyUse }) => keyUse.lines);
  for (const [file, example] of Object.entries(EXAMPLE_OF)) {
    for (const name of [...EXAMPLES[example].keys()].filter(isKeyLine)) {
      const count = lines.filter((line) => line.file === file && line.name === name).length;
      if (count === 0) problems.push(`${file}: ${example} holds ${name} and the data has no line for it`);
      if (count > 1) problems.push(`${file}: the data covers ${name} ${count} times`);
    }
  }
  return problems;
}

/** The template of each agent has placeholders that the service fills from its env file. Every placeholder that is a key line has a line of the data. */
function placeholderProblems(use: UseCase): string[] {
  const problems: string[] = [];
  for (const agent of use.agents) {
    const files = filesOf(agent, problems);
    if (files === undefined) continue;
    const named = new Set(keyUsesOf(use).filter((entry) => entry.agent.id === agent.id).flatMap(({ keyUse }) => keyUse.lines.map((line) => line.name)));
    const placeholders = new Set([...files.templateText.matchAll(/<([A-Z][A-Z0-9_]*)>/g)].map((found) => found[1]));
    for (const name of [...placeholders].filter(isKeyLine)) {
      if (!named.has(name)) problems.push(`${agent.id}: the template has the placeholder <${name}> and no line of the data fills it`);
    }
  }
  return problems;
}

const lineText = (file: string, name: string, of: KeyLine['of']): string => `${file} ${name} ${of}`;

/**
 * The lines that a key has, by the names of the examples. A supplier key fills the four SUPPLIER lines of the env file of its runtime, and, when that file is not the file of the service, the
 * two public lines of its lot in the file of the service. Every other key fills its secret line and its key hash line in the file of the service, with the key name in capital letters as prefix.
 */
function expectedLines(agent: AgentSpec, keyUse: KeyUse): string[] {
  const advert = agent.adverts.find((candidate) => candidate.supplierKey === keyUse.key);
  if (advert === undefined) {
    const prefix = keyUse.key.toUpperCase().replaceAll('-', '_');
    return [lineText(agent.serviceEnvFile, `${prefix}_PRIV_KEY_HEX`, 'secret'), lineText(agent.serviceEnvFile, `${prefix}_PKH`, 'pkh')];
  }
  const own = advert.runtimeEnvFile;
  const lines = [lineText(own, 'SUPPLIER_PRIV_KEY_HEX', 'secret'), lineText(own, 'SUPPLIER_PUB_KEY_HEX', 'pub'), lineText(own, 'SUPPLIER_PKH', 'pkh'), lineText(own, 'SUPPLIER_ADDRESS', 'address')];
  if (own !== agent.serviceEnvFile) {
    const lot = advert.model.replace('lot-', '').toUpperCase();
    lines.push(lineText(agent.serviceEnvFile, `${lot}_SUPPLIER_PKH`, 'pkh'), lineText(agent.serviceEnvFile, `${lot}_SUPPLIER_PUB_KEY_HEX`, 'pub'));
  }
  return lines;
}

/** Each key has the lines that the names of the examples give it: a swap of two keys is a problem, though each file keeps one secret line. */
function lineRuleProblems(use: UseCase): string[] {
  const problems: string[] = [];
  for (const agent of use.agents) {
    for (const key of [agent.serviceKey, ...agent.adverts.map((advert) => advert.supplierKey)]) {
      if (!agent.keys.some((keyUse) => keyUse.key === key)) problems.push(`${agent.id}: the key ${key} has no list of lines`);
    }
  }
  for (const { agent, keyUse } of keyUsesOf(use)) {
    const actual = keyUse.lines.map((line) => lineText(line.file, line.name, line.of));
    const expected = expectedLines(agent, keyUse);
    for (const text of expected) if (!actual.includes(text)) problems.push(`${keyUse.key}: the line "${text}" is missing`);
    for (const text of actual) if (!expected.includes(text)) problems.push(`${keyUse.key}: the line "${text}" is not a line of this key`);
  }
  return problems;
}

const PURPOSE_ROWS: Readonly<Record<string, { supplier: string; service: string; other: string | undefined }>> = {
  'reorder-agent': { supplier: 'Supplier key', service: 'Service key', other: 'Delegation keys' },
  'order-desk': { supplier: 'Supplier keys', service: 'Service key', other: undefined },
};
const purposesOfRow = (text: string | undefined): string[] | undefined => {
  const found = text === undefined ? null : /listed in the record for the (authentication|assertion|transaction|delegation)(?: and (authentication|assertion|transaction|delegation))? purposes?/.exec(text);
  return found === null ? undefined : found.slice(1).filter((word) => word !== undefined);
};
const sorted = (words: readonly string[]): string[] => [...words].sort();

/** The design table of each spec says which purposes each key has in the record, and which domain and description the organisation has. */
function specProblems(use: UseCase): string[] {
  const problems: string[] = [];
  for (const agent of use.agents) {
    const files = filesOf(agent, problems);
    const rows = PURPOSE_ROWS[agent.id];
    if (files === undefined || rows === undefined) continue;
    for (const keyUse of agent.keys) {
      const name = agent.adverts.some((advert) => advert.supplierKey === keyUse.key) ? rows.supplier : keyUse.key === agent.serviceKey ? rows.service : rows.other;
      const stated = name === undefined ? undefined : purposesOfRow(specRow(files.spec, name));
      if (stated === undefined) problems.push(`${agent.id}: the spec has no row that gives the purposes of ${keyUse.key}`);
      else if (!isDeepStrictEqual(sorted(keyUse.purposes), sorted(stated))) problems.push(`${agent.id}: the purposes of ${keyUse.key} are ${keyUse.purposes.join(' and ')} and the spec says ${stated.join(' and ')}`);
    }
    const organisation = use.organisations.find((candidate) => candidate.id === agent.organisation);
    const row = specRow(files.spec, 'Organisation') ?? '';
    const domain = /the domain `([^`]+)`/.exec(row)?.[1];
    const description = /with the description "([^"]+)"/.exec(row)?.[1];
    if (organisation === undefined) problems.push(`${agent.id}: the organisation ${agent.organisation} is not in the list`);
    else if (domain !== organisation.domain) problems.push(`${agent.id}: the spec gives the domain ${domain} and the data has ${organisation.domain}`);
    if (description === undefined || !agent.description.startsWith(`${description}.`)) problems.push(`${agent.id}: the description of the data does not start with the description of the spec`);
    const urls = [...(specRow(files.spec, 'Public URL') ?? '').matchAll(/`(https:\/\/[^`]+)`/g)].map((found) => found[1]);
    if (!isDeepStrictEqual(urls, agent.adverts.map((advert) => advert.origin))) problems.push(`${agent.id}: the Public URL row of the spec gives ${urls.join(', ')} and the adverts have ${agent.adverts.map((advert) => advert.origin).join(', ')}`);
  }
  for (const subagent of use.subagents) {
    const parent = use.agents.find((agent) => agent.id === subagent.parent);
    const files = parent === undefined ? undefined : AGENT_FILES[parent.id];
    const row = specRow(files?.spec ?? '', 'Subagent') ?? '';
    const found = /its own (authentication|assertion|transaction|delegation) key and its own (authentication|assertion|transaction|delegation) key/.exec(row);
    if (found === null) problems.push(`${subagent.id}: the spec of the parent has no row that gives the keys of the subagent`);
    else if (!isDeepStrictEqual(subagent.keys.map((keyUse) => [keyUse.key, keyUse.purposes]), [[`${subagent.id}-auth`, [found[1]]], [`${subagent.id}-delegation`, [found[2]]]])) {
      problems.push(`${subagent.id}: the keys of the subagent are not ${subagent.id}-auth with the purpose ${found[1]} and ${subagent.id}-delegation with the purpose ${found[2]}, as the spec says`);
    }
    const named = /^`([^`]+)`/.exec(row)?.[1];
    if (named !== subagent.name) problems.push(`${subagent.id}: the spec of the parent names the subagent ${named} and the data has ${subagent.name}`);
    const variable = `${subagent.id.toUpperCase().replaceAll('-', '_')}_DID`;
    if (files?.example.has(variable) !== true) problems.push(`${subagent.id}: the example of the parent has no line ${variable}`);
  }
  return problems;
}

/** The names of the keys are valid and unique, the scopes are those of the deployment, every name that the data uses is a key, and every key is used. */
function keyProblems(use: UseCase): string[] {
  const problems: string[] = [];
  const names = use.keys.map((key) => key.name);
  for (const name of names) if (!KEY_NAME.test(name)) problems.push(`the key name ${name} is not valid`);
  for (const name of new Set(names)) if (names.filter((other) => other === name).length > 1) problems.push(`the key ${name} is in the list twice`);
  const scoped = (scope: string): string[] => use.keys.filter((key) => key.scope === scope).map((key) => key.name);
  if (!isDeepStrictEqual(sorted(scoped('shared')), sorted(SHARED_KEYS))) problems.push(`the shared keys are ${scoped('shared').join(', ')} and they must be ${SHARED_KEYS.join(', ')}`);
  if (!isDeepStrictEqual(sorted(scoped('use-case')), sorted(USE_CASE_KEYS))) problems.push(`the keys of the use case are ${scoped('use-case').join(', ')} and they must be ${USE_CASE_KEYS.join(', ')}`);
  const references: { key: string; where: string }[] = [];
  for (const agent of use.agents) {
    references.push({ key: agent.serviceKey, where: `${agent.id} serviceKey` });
    for (const keyUse of agent.keys) references.push({ key: keyUse.key, where: `${agent.id} keys` });
    for (const advert of agent.adverts) references.push({ key: advert.supplierKey, where: `${agent.id} ${advert.model} supplierKey` });
    for (const party of agent.parties) if (party.signer.kind === 'key') references.push({ key: party.signer.key, where: `${agent.id} party ${party.role}` });
  }
  for (const subagent of use.subagents) for (const keyUse of subagent.keys) references.push({ key: keyUse.key, where: `${subagent.id} keys` });
  for (const organisation of use.organisations) {
    references.push({ key: organisation.accountableKey, where: `organisation ${organisation.id} accountableKey` }, { key: organisation.guardianKey, where: `organisation ${organisation.id} guardianKey` });
  }
  for (const reference of references) if (!names.includes(reference.key)) problems.push(`${reference.where} names the key ${reference.key}, which is no key of the use case`);
  const used = new Set([...references.map((reference) => reference.key), 'run', 'fee']);
  for (const name of names) if (!used.has(name)) problems.push(`the key ${name} is used by no agent, subagent, party or organisation`);
  return problems;
}

// ---- the hosts ----

/**
 * Each advert origin and each status URL has a host block in the Caddy snippet and a PUBLIC_ORIGIN in the compose file. Each container has the port that the deployment gives it, each runtime
 * calls its service on that port, and every path that Caddy sends to the service goes to that port. `table` holds the public files, and a test gives it a broken copy of one of them.
 */
function hostProblems(use: UseCase, table = AGENT_FILES): string[] {
  const problems: string[] = [];
  for (const agent of use.agents) {
    const files = filesOf(agent, problems, table);
    if (files === undefined) continue;
    const origins = agent.adverts.map((advert) => advert.origin);
    if (agent.endpoint !== origins[0]) problems.push(`${agent.id}: the endpoint is not the origin of the first advert`);
    const status = files.template.interface.routes.status;
    if (!isDeepStrictEqual(agent.statusUrls, origins.map((origin) => `${origin}${status}`))) problems.push(`${agent.id}: statusUrls is not the list of the ${status} of its adverts`);
    const caddyHosts = new Set(files.caddy.map((block) => block.host));
    const composeHosts = new Set(files.compose.map((service) => hostOf(service.env.PUBLIC_ORIGIN ?? '')));
    for (const url of [...origins, ...agent.statusUrls]) {
      const parsed = parseUrl(url);
      const host = parsed === null ? null : hostOf(parsed.origin);
      if (host === null || !caddyHosts.has(host)) problems.push(`${agent.id}: the host of ${url} has no block in the Caddy snippet`);
      if (host === null || !composeHosts.has(host)) problems.push(`${agent.id}: the host of ${url} is the PUBLIC_ORIGIN of no container of the compose file`);
    }
    for (const url of agent.statusUrls) if (parseUrl(url)?.pathname !== status) problems.push(`${agent.id}: the status URL ${url} does not end in ${status}`);
    const serviceName = SERVICE_CONTAINER[agent.id];
    if (!files.compose.some((candidate) => candidate.container === agent.serviceContainer)) problems.push(`${agent.id}: the compose file has no container ${agent.serviceContainer}, the service container of the data`);
    if (agent.adverts.some((advert) => advert.runtimeContainer === agent.serviceContainer)) problems.push(`${agent.id}: the service container ${agent.serviceContainer} of the data is the container of an advert`);
    const servicePort = EXPECTED_PORTS[serviceName];
    const serviceUrl = `http://${serviceName}:${servicePort}`;
    const containers = new Set<string>();
    for (const advert of agent.adverts) {
      const where = `${agent.id} ${advert.model}`;
      const host = hostOf(advert.origin);
      if (host === null) problems.push(`${where}: the origin ${advert.origin} is not an https origin with no path`);
      if (containers.has(advert.runtimeContainer)) problems.push(`${where}: the container ${advert.runtimeContainer} serves two adverts`);
      containers.add(advert.runtimeContainer);
      const runtime = files.compose.find((service) => service.container === advert.runtimeContainer);
      const port = EXPECTED_PORTS[advert.runtimeContainer];
      if (runtime === undefined) {
        problems.push(`${where}: the compose file has no container ${advert.runtimeContainer}`);
        continue;
      }
      if (port === undefined) problems.push(`${where}: no port is known for the container ${advert.runtimeContainer}`);
      else if (!isDeepStrictEqual(runtime.ports, [`127.0.0.1:${port}:${runtime.env.PORT}`])) problems.push(`${where}: the compose file publishes ${runtime.ports.join(', ')} for ${advert.runtimeContainer} and it must be 127.0.0.1:${port}:${runtime.env.PORT}`);
      if (runtime.env.PUBLIC_ORIGIN !== advert.origin) problems.push(`${where}: PUBLIC_ORIGIN of ${advert.runtimeContainer} is ${runtime.env.PUBLIC_ORIGIN} and the origin is ${advert.origin}`);
      if (runtime.env.ADVERT_MAX_PROCESSING_MS !== String(advert.windowMs)) problems.push(`${where}: ADVERT_MAX_PROCESSING_MS of ${advert.runtimeContainer} is ${runtime.env.ADVERT_MAX_PROCESSING_MS} and the window is ${advert.windowMs}`);
      if (runtime.env.SERVICE_URL !== `${serviceUrl}/`) problems.push(`${where}: SERVICE_URL of ${advert.runtimeContainer} is ${runtime.env.SERVICE_URL} and it must be ${serviceUrl}/`);
      if (runtime.env.SERVICE_PRECHECK_URL !== `${serviceUrl}/precheck`) problems.push(`${where}: SERVICE_PRECHECK_URL of ${advert.runtimeContainer} is ${runtime.env.SERVICE_PRECHECK_URL} and it must be ${serviceUrl}/precheck`);
      const envFiles = [...new Set([agent.serviceEnvFile, advert.runtimeEnvFile])].map((file) => `./${file}`);
      if (!isDeepStrictEqual(runtime.envFiles, envFiles)) problems.push(`${where}: the env files of ${advert.runtimeContainer} are ${runtime.envFiles.join(', ')} and the data has ${envFiles.join(', ')}`);
      const fallback = files.caddy.find((block) => block.host === host)?.handles.find((handle) => handle.path === null);
      if (fallback?.upstream !== `${advert.runtimeContainer}:${runtime.env.PORT}`) problems.push(`${where}: the default handle of the Caddy block of ${host} is ${fallback?.upstream} and it must be ${advert.runtimeContainer}:${runtime.env.PORT}`);
    }
    const service = files.compose.find((candidate) => candidate.container === serviceName);
    if (service === undefined) problems.push(`${agent.id}: the compose file has no container ${serviceName}`);
    else {
      if (!isDeepStrictEqual(service.ports, [`127.0.0.1:${servicePort}:${servicePort}`])) problems.push(`${agent.id}: the compose file publishes ${service.ports.join(', ')} for ${serviceName} and it must be 127.0.0.1:${servicePort}:${servicePort}`);
      if (service.env.PORT !== String(servicePort)) problems.push(`${agent.id}: PORT of ${serviceName} is ${service.env.PORT} and it must be ${servicePort}`);
      if (!isDeepStrictEqual(service.envFiles, [`./${agent.serviceEnvFile}`])) problems.push(`${agent.id}: the env files of ${serviceName} are ${service.envFiles.join(', ')} and the data has ./${agent.serviceEnvFile}`);
    }
    for (const block of files.caddy) {
      const routed = block.handles.filter((handle) => handle.path !== null);
      if (!routed.some((handle) => handle.path === '/agent.json')) problems.push(`${agent.id}: the Caddy block of ${block.host} has no /agent.json handle`);
      for (const handle of routed) {
        if (handle.upstream !== `${serviceName}:${servicePort}`) problems.push(`${agent.id}: the ${handle.path} handle of the Caddy block of ${block.host} is ${handle.upstream} and it must be ${serviceName}:${servicePort}`);
      }
      if (!agent.adverts.some((advert) => hostOf(advert.origin) === block.host)) problems.push(`${agent.id}: the Caddy snippet has a block for ${block.host} and no advert has that host`);
    }
    for (const container of files.compose.map((candidate) => candidate.container)) {
      if (container !== serviceName && !containers.has(container)) problems.push(`${agent.id}: the compose file has the container ${container} and no advert uses it`);
    }
  }
  return problems;
}

/** The example env file of an agent is the file that the data names, or the service env file with `.example`. It holds the lines of the mock origins and the line of the Module-1 manifest exactly when the data says so. */
function managedProblems(use: UseCase): string[] {
  const problems: string[] = [];
  for (const agent of use.agents) {
    const name = agent.exampleEnvFile ?? `${agent.serviceEnvFile}.example`;
    const lines = (EXAMPLES as Partial<Record<string, ReadonlyMap<string, string>>>)[name];
    if (lines === undefined) {
      problems.push(`${agent.id}: the example env file ${name} is not one of the examples that this test reads`);
      continue;
    }
    const mock = lines.has('MOCK_PUBLIC_BASE') && lines.has('MOCK_MTLS_BASE');
    if (mock !== agent.envManaged.mock) problems.push(`${agent.id}: the data says mock ${String(agent.envManaged.mock)} and the example ${name} ${mock ? 'has' : 'lacks'} the lines of the mock origins`);
    const manifest = lines.has('VECTOR_MODULE1_MANIFEST');
    if (manifest !== agent.envManaged.module1) problems.push(`${agent.id}: the data says module1 ${String(agent.envManaged.module1)} and the example ${name} ${manifest ? 'has' : 'lacks'} the line of the Module-1 manifest`);
  }
  return problems;
}

/** The section "Not covered" of the data is the section of the golden results page of use case 1, word for word. */
function notCoveredProblems(use: UseCase, page: string): string[] {
  const section = `## Not covered\n\n${use.notCovered.lead}\n\n${use.notCovered.items.map((item) => `- ${item}`).join('\n')}\n`;
  return page.includes(section) ? [] : ['the golden results page does not hold the section "Not covered" of the data'];
}

// ---- the lots and the runs ----

function lotProblems(use: UseCase): string[] {
  const problems: string[] = [];
  const models = use.agents.find((agent) => agent.id === 'order-desk')?.adverts.map((advert) => advert.model) ?? [];
  for (const run of use.runs) {
    const item = LOTS.items.find((candidate) => candidate.sku === run.subject);
    if (item === undefined) problems.push(`run ${run.id}: the SKU ${run.subject} is not in the lots file`);
    else for (const model of models) if (item.lots[model] === undefined) problems.push(`run ${run.id}: the SKU ${run.subject} has no size for the lot ${model}`);
  }
  if (!isDeepStrictEqual(use.runs.map((run) => run.id), ['clean', 'failure'])) problems.push('the runs are not clean and failure, in this order');
  if (new Set(use.runs.map((run) => run.subject)).size !== use.runs.length) problems.push('two runs have the same SKU');
  return problems;
}

/** The vault of a run pays the lock of the lot that the agent orders. The limits let one order of the medium lot through, refuse the large lot, and refuse a second order of the medium lot. */
function runProblems(use: UseCase): string[] {
  const problems: string[] = [];
  const medium = Number(LOCK_UNITS['lot-medium']);
  const large = Number(LOCK_UNITS['lot-large']);
  for (const run of use.runs) {
    if (run.perTxUnits < medium) problems.push(`run ${run.id}: the limit of one payment, ${run.perTxUnits} units, is below the lock of the medium lot, ${medium} units`);
    if (run.perTxUnits >= large) problems.push(`run ${run.id}: the limit of one payment, ${run.perTxUnits} units, does not refuse the large lot, which locks ${large} units`);
    if (run.totalUnits < medium || run.totalUnits >= 2 * medium) problems.push(`run ${run.id}: the total, ${run.totalUnits} units, must be at least one lock of the medium lot, ${medium} units, and below two`);
    if (run.vaultUnits < run.totalUnits) problems.push(`run ${run.id}: the vault holds ${run.vaultUnits} units and the total is ${run.totalUnits} units`);
  }
  return problems;
}

// ---- the funding ----

function fundingProblems(use: UseCase): string[] {
  const problems: string[] = [];
  const names = new Set(use.keys.map((key) => key.name));
  const wallets = use.funding.map((line) => line.wallet);
  for (const line of use.funding) {
    if (!names.has(line.wallet)) problems.push(`funding: the wallet ${line.wallet} is no key name`);
    if (wallets.filter((wallet) => wallet === line.wallet).length > 1) problems.push(`funding: the wallet ${line.wallet} has more than one line`);
    if (line.collateralLovelace !== COLLATERAL) problems.push(`funding ${line.wallet}: the collateral is ${line.collateralLovelace} and it must be ${COLLATERAL}`);
    const sum = line.items.reduce((total, item) => total + item.lovelace, 0n);
    const rounded = ((sum + FLOAT_STEP - 1n) / FLOAT_STEP) * FLOAT_STEP;
    if (line.floatLovelace < sum) problems.push(`funding ${line.wallet}: the float ${line.floatLovelace} is below the sum of its items, ${sum}`);
    else if (line.floatLovelace !== rounded) problems.push(`funding ${line.wallet}: the float ${line.floatLovelace} is not the sum of its items, ${sum}, rounded up to 10 units, ${rounded}`);
  }
  const paying = [...use.agents.flatMap((agent) => agent.keys.map((keyUse) => keyUse.key)), 'fee'];
  for (const wallet of paying) if (!wallets.includes(wallet)) problems.push(`funding: the paying wallet ${wallet} has no line`);
  for (const wallet of wallets) if (!paying.includes(wallet)) problems.push(`funding: the wallet ${wallet} is the wallet of no agent key and it is not the fee wallet`);
  const collateral = use.funding.reduce((total, line) => total + line.collateralLovelace, 0n);
  const floats = use.funding.reduce((total, line) => total + line.floatLovelace, 0n);
  if (collateral !== TOTAL_COLLATERAL) problems.push(`funding: the collateral adds to ${collateral} and it must add to ${TOTAL_COLLATERAL}`);
  if (floats !== TOTAL_FLOATS) problems.push(`funding: the floats add to ${floats} and they must add to ${TOTAL_FLOATS}`);
  if (collateral + floats !== TOTAL_LINES) problems.push(`funding: the lines add to ${collateral + floats} and they must add to ${TOTAL_LINES}`);
  return problems;
}

/** The items of a wallet follow the numbers of the data: the stake, two claims in flight, the challenge stake of the Reorder Agent, and the supplier bond and the deposit of each advert. */
function fundingTieProblems(use: UseCase): string[] {
  const problems: string[] = [];
  const needs = (wallet: string, lovelace: bigint, what: string): void => {
    if (use.funding.find((line) => line.wallet === wallet)?.items.some((item) => item.lovelace === lovelace) !== true) problems.push(`funding ${wallet}: no item is ${what}, ${lovelace}`);
  };
  for (const agent of use.agents) {
    needs(agent.serviceKey, agent.stakeLovelace, 'the stake');
    needs(agent.serviceKey, 2n * agent.claim.stakeLovelace, 'two claims in flight');
    for (const advert of agent.adverts) {
      needs(advert.supplierKey, advert.supplierBondLovelace, 'the supplier bond');
      needs(advert.supplierKey, advert.depositLovelace, 'the advert deposit');
    }
  }
  needs('reorder-service', BigInt(valueOf('.env.reorder-agent.example', 'DISPUTE_CHALLENGE_STAKE_LOVELACE')), 'one challenge stake');
  return problems;
}

// ---- the runtime commit and the manifest path ----

function commitProblems(use: UseCase): string[] {
  const problems: string[] = [];
  if (!/^[0-9a-f]{40}$/.test(use.runtimeCommit)) problems.push(`the runtime commit ${use.runtimeCommit} is not 40 lower-case hex characters`);
  if (TEMPLATE_CHECKOUT_REFS.length === 0) problems.push('the CI file has no checkout of the agent template');
  for (const ref of TEMPLATE_CHECKOUT_REFS) {
    if (ref !== use.runtimeCommit) problems.push(`the runtime commit is ${use.runtimeCommit} and a template checkout of the CI file has the ref ${ref}`);
  }
  for (const file of ['.env.reorder-agent.example', '.env.order-desk.example'] as const) {
    const path = valueOf(file, 'VECTOR_MODULE1_MANIFEST').split('<commit>/')[1];
    if (path !== use.moduleManifestPath) problems.push(`the manifest path is ${use.moduleManifestPath} and ${file} gives ${path}`);
  }
  return problems;
}

// ---- the parties ----

function partyProblems(use: UseCase): string[] {
  const problems: string[] = [];
  for (const organisation of use.organisations) {
    if (organisation.accountableKey !== `accountable-${organisation.id}`) problems.push(`organisation ${organisation.id}: the Accountable key is ${organisation.accountableKey} and it must be accountable-${organisation.id}`);
    if (organisation.guardianKey !== `guardian-${organisation.id}`) problems.push(`organisation ${organisation.id}: the guardian key is ${organisation.guardianKey} and it must be guardian-${organisation.id}`);
  }
  for (const agent of use.agents) {
    const organisation = use.organisations.find((candidate) => candidate.id === agent.organisation);
    if (organisation === undefined) {
      problems.push(`${agent.id}: the organisation ${agent.organisation} is not in the list`);
      continue;
    }
    const keyOf = (party: PartySpec): string => (party.signer.kind === 'key' ? party.signer.key : `the signer kind ${party.signer.kind}`);
    const ofRole = (role: PartySpec['role']): PartySpec[] => agent.parties.filter((party) => party.role === role);
    const guardians = ofRole('Guardian');
    if (guardians.length !== 2 || agent.guardianThreshold !== 2) problems.push(`${agent.id}: it needs two Guardians and the threshold 2, and it has ${guardians.length} Guardians and the threshold ${agent.guardianThreshold}`);
    if (!guardians.some((party) => keyOf(party) === organisation.guardianKey)) problems.push(`${agent.id}: no Guardian has the guardian key ${organisation.guardianKey} of its organisation`);
    if (!guardians.some((party) => keyOf(party) === 'controller')) problems.push(`${agent.id}: no Guardian has the key controller`);
    for (const party of [...guardians, ...ofRole('Provider')]) {
      if (party.signer.kind === 'controller') problems.push(`${agent.id}: the ${party.role} has the signer kind controller, which the register tool refuses for this role`);
    }
    const providers = ofRole('Provider');
    if (providers.length !== 1 || keyOf(providers[0]) !== 'provider' || !isDeepStrictEqual(providers[0].rights, [])) problems.push(`${agent.id}: it needs one Provider with the key provider and rights []`);
    const accountables = ofRole('Accountable');
    if (accountables.length !== 1 || keyOf(accountables[0]) !== organisation.accountableKey || accountables[0].organisation !== organisation.domain) {
      problems.push(`${agent.id}: it needs one Accountable with the key ${organisation.accountableKey} and the organisation ${organisation.domain}`);
    }
    const responsibles = ofRole('Responsible');
    if (responsibles.length !== 1 || responsibles[0].signer.kind !== 'module1') problems.push(`${agent.id}: it needs one Responsible with the signer kind module1`);
    if (agent.parties.length !== guardians.length + providers.length + accountables.length + responsibles.length) problems.push(`${agent.id}: a party has a role that is none of the four roles`);
  }
  return problems;
}

// ---- the shape of the rest ----

const DEMONSTRATION = 'Demonstration organisation run by the Apex Fusion Foundation.';
const ACTORS = ['hirer', 'agent', 'counterparty', 'operator', 'relay'];

function shapeProblems(use: UseCase): string[] {
  const problems: string[] = [];
  if (use.name !== 'inventory-reorder') problems.push(`the use case is named ${use.name}`);
  const records = [...use.agents.map((agent) => ({ id: agent.id, name: agent.name, description: agent.description })), ...use.subagents.map((subagent) => ({ id: subagent.id, name: subagent.name, description: subagent.description }))];
  for (const record of records) {
    if (Buffer.byteLength(record.name, 'utf8') > 64) problems.push(`${record.id}: the name has more than 64 bytes`);
    if (Buffer.byteLength(record.description, 'utf8') > 256) problems.push(`${record.id}: the description has more than 256 bytes`);
    if (!record.description.startsWith(DEMONSTRATION)) problems.push(`${record.id}: the description does not start with the sentence that names the demonstration`);
  }
  for (const subagent of use.subagents) {
    if (!use.agents.some((agent) => agent.id === subagent.parent)) problems.push(`${subagent.id}: its parent ${subagent.parent} is no agent`);
    if (subagent.keys.length !== 2) problems.push(`${subagent.id}: it needs two keys`);
  }
  for (const agent of use.agents) {
    const attestation = use.attestations.filter((candidate) => candidate.agent === agent.id);
    if (attestation.length !== 1) problems.push(`${agent.id}: it needs one attestation entry and it has ${attestation.length}`);
    else if (!isDeepStrictEqual(attestation[0].types, ['provenance', 'software'])) problems.push(`${agent.id}: the attestation types are not provenance and software`);
  }
  for (const attestation of use.attestations) {
    if (attestation.format !== 50) problems.push(`${attestation.agent}: the attestation format is ${attestation.format} and it must be 50`);
    if (!Number.isInteger(attestation.validDays) || attestation.validDays < 1 || attestation.validDays > 366) problems.push(`${attestation.agent}: the attestation validity is ${attestation.validDays} days and it must be 1 to 366`);
  }
  const envelopes = use.attestations.filter((attestation) => attestation.envelope !== null).map((attestation) => `${attestation.agent} ${attestation.envelope?.type}`);
  if (!isDeepStrictEqual(envelopes, ['reorder-agent software'])) problems.push(`the envelope is on ${envelopes.join(', ')} and it must be on the software attestation of reorder-agent only`);
  const ids = use.evidenceSteps.map((step) => step.id);
  for (const id of new Set(ids)) if (ids.filter((other) => other === id).length > 1) problems.push(`the evidence step ${id} is in the list twice`);
  for (const step of use.evidenceSteps) {
    if (step.run !== 'both' && !use.runs.some((run) => run.id === step.run)) problems.push(`the evidence step ${step.id} names the run ${step.run}, which is no run`);
    if (!ACTORS.includes(step.actor)) problems.push(`the evidence step ${step.id} has the actor ${step.actor}`);
    if (step.what.trim() === '' || step.primitive.trim() === '') problems.push(`the evidence step ${step.id} has no text`);
  }
  for (const run of use.runs) if (!use.evidenceSteps.some((step) => step.run === run.id)) problems.push(`the run ${run.id} has no evidence step`);
  return problems;
}

// ---- the tests ----

describe('the data of use case 1 (inventory reorder)', () => {
  describe('the capabilities and the claim statements', () => {
    it('hold the capability of each agent to the kit constants, and its claim statements to the template', () => {
      expect(capabilityProblems(data)).toEqual([]);
      expect(data.agents.map((agent) => agent.capability)).toEqual([INVENTORY_CAPABILITIES.reorder, INVENTORY_CAPABILITIES.order]);
    });
    it('refuse a capability that is not the capability of the kind of the agent', () => {
      const broken = mapAgent(data, 'order-desk', (agent) => ({ ...agent, capability: INVENTORY_CAPABILITIES.reorder }));
      expect(capabilityProblems(broken)).toEqual([
        `order-desk: the capability is ${INVENTORY_CAPABILITIES.reorder} and the kit gives ${INVENTORY_CAPABILITIES.order} to its kind`,
        `order-desk: the template names the capability ${INVENTORY_CAPABILITIES.order} and the data has ${INVENTORY_CAPABILITIES.reorder}`,
        `order-desk: the claim statements of the template differ from the claim of the kit for ${INVENTORY_CAPABILITIES.reorder}`,
      ]);
    });
    it('refuse a claim of the kit that has another text than the template', () => {
      const [first, second, third] = REORDER_CLAIM.statements;
      const changed: typeof REORDER_CLAIM = { statements: [{ ...first, text: `${first.text} More.` }, second, third] };
      expect(capabilityProblems(data, { ...KIT_OF_KIND, 'reorder-agent': { ...KIT_OF_KIND['reorder-agent'], claim: changed } })).toEqual([
        `reorder-agent: the claim statements of the template differ from the claim of the kit for ${INVENTORY_CAPABILITIES.reorder}`,
      ]);
    });
    it('refuse a capability that no claim of the kit has', () => {
      const broken = mapAgent(data, 'reorder-agent', (agent) => ({ ...agent, capability: 'supplychain.other.v1' }));
      expect(capabilityProblems(broken)).toContain('reorder-agent: no claim of the kit has the capability supplychain.other.v1');
    });
  });

  describe('the name, the folder, the co-sign flag and the fault values of each agent', () => {
    it('are those of the template, the example, the Caddy blocks and the compose file of the agent', () => {
      expect(agentProblems(data)).toEqual([]);
      expect(data.agents.map((agent) => agent.cosign)).toEqual([true, false]);
      expect(data.agents.map((agent) => agent.faultValues)).toEqual([[], ['confirm_wrong_lot']]);
    });
    it.each<[string, UseCase, string]>([
      ['a name that the template does not give', mapAgent(data, 'order-desk', (agent) => ({ ...agent, name: 'Order Office' })), 'order-desk: the name is Order Office and the template says Order Desk'],
      ['an env file that the example is not copied to', mapAgent(data, 'reorder-agent', (agent) => ({ ...agent, serviceEnvFile: '.env.reorder' })), 'reorder-agent: the example is copied to .env.reorder-agent and the data has the env file .env.reorder'],
      ['a folder that the example is not copied to', mapAgent(data, 'order-desk', (agent) => ({ ...agent, folder: 'orders' })), 'order-desk: the example is copied to the folder order-desk and the data has the folder orders'],
      ['a co-sign flag on the Order Desk', mapAgent(data, 'order-desk', (agent) => ({ ...agent, cosign: true })), 'order-desk: cosign is true and the example has no line COSIGN_ALLOWLIST'],
      ['no co-sign flag on the Reorder Agent', mapAgent(data, 'reorder-agent', (agent) => ({ ...agent, cosign: false })), 'reorder-agent: cosign is false and the Caddy blocks all route /cosign/delegate'],
      ['a fault value that the template does not give', mapAgent(data, 'reorder-agent', (agent) => ({ ...agent, faultValues: ['confirm_wrong_lot'] })), 'reorder-agent: the fault values are ["confirm_wrong_lot"] and the template says []'],
      ['a missing fault value', mapAgent(data, 'order-desk', (agent) => ({ ...agent, faultValues: [] })), 'order-desk: the fault values are [] and the template says ["confirm_wrong_lot"]'],
    ])('refuse %s', (_name, broken, problem) => {
      expect(agentProblems(broken)).toContain(problem);
    });
  });

  describe('the claim', () => {
    it('has a stake from the least stake of the Module-1 deployment up to the challenge stake of both examples, a window of 24 hours, the capability as claim type, and the Module-3 stake of 10,000,000', () => {
      expect(claimProblems(data)).toEqual([]);
      expect(data.agents.map((agent) => agent.claim.stakeLovelace)).toEqual([50_000_000n, 50_000_000n]);
      expect(data.agents.map((agent) => [agent.stakeLovelace, agent.claim.windowMs])).toEqual([[10_000_000n, 86_400_000], [10_000_000n, 86_400_000]]);
    });
    it.each<[string, UseCase, string]>([
      ['a stake below the least stake', mapAgent(data, 'reorder-agent', (agent) => ({ ...agent, claim: { ...agent.claim, stakeLovelace: 49_999_999n } })), 'reorder-agent: the claim stake 49999999 is below the least stake of the Module-1 deployment, 50000000'],
      ['a stake above the challenge stake', mapAgent(data, 'order-desk', (agent) => ({ ...agent, claim: { ...agent.claim, stakeLovelace: 50_000_001n } })), 'order-desk: the claim stake 50000001 is above DISPUTE_CHALLENGE_STAKE_LOVELACE 50000000 of .env.order-desk.example, so a challenge cannot target the claim'],
      ['a window below 30 minutes', mapAgent(data, 'reorder-agent', (agent) => ({ ...agent, claim: { ...agent.claim, windowMs: 1_799_999 } })), 'reorder-agent: the claim window 1799999 ms is outside 1800000 to 86400000 ms'],
      ['a window above 24 hours', mapAgent(data, 'order-desk', (agent) => ({ ...agent, claim: { ...agent.claim, windowMs: 86_400_001 } })), 'order-desk: the claim window 86400001 ms is outside 1800000 to 86400000 ms'],
      ['a claim type that is not the capability', mapAgent(data, 'order-desk', (agent) => ({ ...agent, claim: { ...agent.claim, claimType: INVENTORY_CAPABILITIES.reorder } })), `order-desk: the claim type ${INVENTORY_CAPABILITIES.reorder} is not the capability ${INVENTORY_CAPABILITIES.order}`],
    ])('refuses %s', (_name, broken, problem) => {
      expect(claimProblems(broken)).toContain(problem);
    });
    it('refuses a claim type of more than the bytes that the kit takes', () => {
      const long = 'x'.repeat(MAX_CLAIM_TYPE_BYTES + 1);
      const broken = mapAgent(data, 'reorder-agent', (agent) => ({ ...agent, capability: long, claim: { ...agent.claim, claimType: long } }));
      expect(claimProblems(broken)).toEqual([`reorder-agent: the claim type has no bytes or more than ${MAX_CLAIM_TYPE_BYTES} bytes`]);
      expect(MAX_CLAIM_TYPE_BYTES).toBe(64);
    });
  });

  describe('the terms of the adverts', () => {
    it('equal the template of each agent, the window of its example and the lock of 5, 4, 7 and 12 units', () => {
      expect(termProblems(data)).toEqual([]);
      expect(data.agents.flatMap((agent) => agent.adverts).map((advert) => (advert.priceLovelace + advert.supplierBondLovelace + advert.buyerBondLovelace) / UNIT)).toEqual([5n, 4n, 7n, 12n]);
    });
    it.each<[string, UseCase, string]>([
      ['a price', mapAdvert(data, 'order-desk', 'lot-medium', { priceLovelace: 5_000_001n }), 'order-desk lot-medium: the price is 5000001 and the template says 5000000'],
      ['a supplier bond', mapAdvert(data, 'order-desk', 'lot-small', { supplierBondLovelace: 1_000_001n }), 'order-desk lot-small: the supplier bond is 1000001 and the template says 1000000'],
      ['a buyer bond', mapAdvert(data, 'reorder-agent', 'reorder-agent-v1', { buyerBondLovelace: 999_999n }), 'reorder-agent reorder-agent-v1: the buyer bond is 999999 and the template says 1000000'],
      ['a window', mapAdvert(data, 'reorder-agent', 'reorder-agent-v1', { windowMs: 1_800_001 }), 'reorder-agent reorder-agent-v1: the window is 1800001 ms and ADVERT_MAX_PROCESSING_MS of the example is 1800000 ms'],
      ['a window of one tier', mapAdvert(data, 'order-desk', 'lot-large', { windowMs: 480_001 }), 'order-desk lot-large: the window is 480001 ms and ADVERT_MAX_PROCESSING_MS of the example is 480000 ms'],
      ['a model that the template has no tier for', mapAdvert(data, 'order-desk', 'lot-large', { model: 'lot-huge' }), 'order-desk lot-huge: the template has no tier for this model'],
      ['a lock that is not the lock of the lot', mapAdvert(data, 'order-desk', 'lot-large', { priceLovelace: 11_000_000n }), 'order-desk lot-large: the lock is 13000000 lovelace and it must be 12 units'],
    ])('refuse %s that differs', (_name, broken, problem) => {
      expect(termProblems(broken)).toContain(problem);
    });
    it('refuse a deposit below the least that an advert output holds', () => {
      const broken = mapAdvert(data, 'order-desk', 'lot-small', { depositLovelace: 2_000_000n });
      expect(termProblems(broken)).toEqual(['order-desk lot-small: the deposit 2000000 is below the least that an advert output holds, 2200000']);
    });
    it('refuse a tier of the template that has no advert', () => {
      const broken = mapAgent(data, 'order-desk', (agent) => ({ ...agent, adverts: agent.adverts.filter((advert) => advert.model !== 'lot-medium') }));
      expect(termProblems(broken)).toEqual(['order-desk: the template has the tier lot-medium and the data has no advert for it']);
    });
    it('agree with the table of each runbook: container, host port, host name, model, price, bonds and lock', () => {
      expect(runbookProblems(data)).toEqual([]);
    });
    it.each<[string, UseCase, string]>([
      ['a model', mapAdvert(data, 'reorder-agent', 'reorder-agent-v1', { model: 'reorder-agent-v2' }), 'reorder-agent reorder-agent-v2: the runbook gives the model reorder-agent-v1 and the data has reorder-agent-v2'],
      ['a container', mapAdvert(data, 'order-desk', 'lot-small', { runtimeContainer: 'orders-tiny-runtime' }), 'order-desk lot-small: the table of the runbook has no row for the container orders-tiny-runtime'],
      ['a price', mapAdvert(data, 'order-desk', 'lot-medium', { priceLovelace: 6_000_000n }), 'order-desk lot-medium: the runbook gives the price 5 and the data has 6'],
    ])('refuse %s that the runbook does not give', (_name, broken, problem) => {
      expect(runbookProblems(broken)).toContain(problem);
    });
  });

  describe('the env lines of the keys', () => {
    it('are lines of the example of their file, and fit the kind of the line', () => {
      expect(envProblems(data)).toEqual([]);
    });
    it('cover every key line that an example holds, exactly once for each file', () => {
      expect(coverageProblems(data)).toEqual([]);
      const secrets = keyUsesOf(data).flatMap(({ keyUse }) => keyUse.lines).filter((line) => line.of === 'secret');
      const held = Object.entries(EXAMPLE_OF).flatMap(([file, example]) => [...EXAMPLES[example].keys()].filter((name) => name.endsWith('_PRIV_KEY_HEX')).map((name) => `${file} ${name}`));
      expect(secrets.map((line) => `${line.file} ${line.name}`).sort()).toEqual(held.sort());
      expect(secrets).toHaveLength(10);
    });
    it('give each key the lines that the names of the examples give it', () => {
      expect(lineRuleProblems(data)).toEqual([]);
    });
    it.each<[string, UseCase, string]>([
      ['an env name that the example does not hold', mapLine(data, 'reorder-delegation-1', 'REORDER_DELEGATION_1_PKH', { name: 'REORDER_DELEGATION_1_PKX' }), 'reorder-delegation-1: REORDER_DELEGATION_1_PKX is no line of .env.reorder-agent.example'],
      ['an env file that has no example', mapLine(data, 'order-desk-service', 'ORDER_DESK_SERVICE_PKH', { file: '.env.order-desk-other' }), 'order-desk-service: the line ORDER_DESK_SERVICE_PKH names the env file .env.order-desk-other, which has no example'],
      ['an env file of another agent', mapLine(data, 'reorder-service', 'REORDER_SERVICE_PKH', { file: '.env.order-desk' }), 'reorder-service: the line REORDER_SERVICE_PKH names the env file .env.order-desk, which is no env file of reorder-agent'],
      ['a kind that does not fit the name', mapLine(data, 'reorder-supplier', 'SUPPLIER_PKH', { of: 'secret' }), 'reorder-supplier: the name SUPPLIER_PKH does not fit the kind secret'],
    ])('refuse %s', (_name, broken, problem) => {
      expect(envProblems(broken)).toContain(problem);
    });
    it('refuse a key that an example holds and the data does not cover', () => {
      const broken = mapKeyUse(data, 'stock-reader-auth', (keyUse) => ({ ...keyUse, lines: [] }));
      expect(coverageProblems(broken)).toEqual([
        '.env.reorder-agent: .env.reorder-agent.example holds STOCK_READER_AUTH_PRIV_KEY_HEX and the data has no line for it',
        '.env.reorder-agent: .env.reorder-agent.example holds STOCK_READER_AUTH_PKH and the data has no line for it',
      ]);
    });
    it('refuse a secret that two lines cover', () => {
      const broken = mapKeyUse(data, 'order-large-supplier', (keyUse) => ({ ...keyUse, lines: [...keyUse.lines, { file: '.env.order-desk-small', name: 'SUPPLIER_PRIV_KEY_HEX', of: 'secret' }] }));
      expect(coverageProblems(broken)).toEqual(['.env.order-desk-small: the data covers SUPPLIER_PRIV_KEY_HEX 2 times']);
    });
    it('refuse a key that the examples do not name', () => {
      const broken = mapKeyUse(data, 'reorder-service', (keyUse) => ({ ...keyUse, lines: [...keyUse.lines, { file: '.env.reorder-agent', name: 'REORDER_SPARE_PRIV_KEY_HEX', of: 'secret' }] }));
      expect(envProblems(broken)).toEqual(['reorder-service: REORDER_SPARE_PRIV_KEY_HEX is no line of .env.reorder-agent.example']);
      expect(lineRuleProblems(broken)).toEqual(['reorder-service: the line ".env.reorder-agent REORDER_SPARE_PRIV_KEY_HEX secret" is not a line of this key']);
    });
    it('refuse two supplier keys that swap their runtime files, though each file keeps one secret line', () => {
      const swap = (use: UseCase, key: string, file: string): UseCase =>
        mapKeyUse(use, key, (keyUse) => ({ ...keyUse, lines: keyUse.lines.map((line) => (line.file.startsWith('.env.order-desk-') ? { ...line, file } : line)) }));
      const broken = swap(swap(data, 'order-small-supplier', '.env.order-desk-medium'), 'order-medium-supplier', '.env.order-desk-small');
      expect(coverageProblems(broken)).toEqual([]);
      expect(lineRuleProblems(broken)).toContain('order-small-supplier: the line ".env.order-desk-small SUPPLIER_PRIV_KEY_HEX secret" is missing');
      expect(lineRuleProblems(broken)).toContain('order-medium-supplier: the line ".env.order-desk-medium SUPPLIER_PRIV_KEY_HEX secret" is missing');
    });
    it('refuse two delegation keys that swap their variables', () => {
      const broken = mapKeyUse(mapKeyUse(data, 'reorder-delegation-1', (keyUse) => ({ ...keyUse, lines: keyUse.lines.map((line) => ({ ...line, name: line.name.replace('_1_', '_2_') })) })),
        'reorder-delegation-2', (keyUse) => ({ ...keyUse, lines: keyUse.lines.map((line) => ({ ...line, name: line.name.replace('_2_', '_1_') })) }));
      expect(coverageProblems(broken)).toEqual([]);
      expect(lineRuleProblems(broken)).toContain('reorder-delegation-1: the line ".env.reorder-agent REORDER_DELEGATION_1_PRIV_KEY_HEX secret" is missing');
    });
    it('refuse an advert whose supplier key has no list of lines in its agent', () => {
      const broken = mapAdvert(data, 'order-desk', 'lot-large', { supplierKey: 'reorder-supplier' });
      expect(lineRuleProblems(broken)).toContain('order-desk: the key reorder-supplier has no list of lines');
    });
    it('fill every placeholder of the template that is a key line', () => {
      expect(placeholderProblems(data)).toEqual([]);
    });
    it('refuse a placeholder of the template that no line of the data fills', () => {
      const broken = mapKeyUse(data, 'order-medium-supplier', (keyUse) => ({ ...keyUse, lines: keyUse.lines.filter((line) => line.name !== 'MEDIUM_SUPPLIER_PKH') }));
      expect(placeholderProblems(broken)).toEqual(['order-desk: the template has the placeholder <MEDIUM_SUPPLIER_PKH> and no line of the data fills it']);
    });
  });

  describe('the purposes of the keys and the design table of each spec', () => {
    it('equal the purposes in the table of the spec, and the organisation and the origins equal its rows', () => {
      expect(specProblems(data)).toEqual([]);
    });
    it.each<[string, UseCase, string]>([
      ['a supplier key that loses the transaction purpose', mapKeyUse(data, 'reorder-supplier', (keyUse) => ({ ...keyUse, purposes: ['authentication'] })), 'reorder-agent: the purposes of reorder-supplier are authentication and the spec says authentication and transaction'],
      ['a delegation key that gains a purpose', mapKeyUse(data, 'reorder-delegation-2', (keyUse) => ({ ...keyUse, purposes: ['delegation', 'transaction'] })), 'reorder-agent: the purposes of reorder-delegation-2 are delegation and transaction and the spec says delegation'],
      ['a service key with another purpose', mapKeyUse(data, 'order-desk-service', (keyUse) => ({ ...keyUse, purposes: ['assertion', 'transaction'] })), 'order-desk: the purposes of order-desk-service are assertion and transaction and the spec says authentication and transaction'],
      ['a subagent key with another purpose', mapKeyUse(data, 'stock-reader-delegation', (keyUse) => ({ ...keyUse, purposes: ['transaction'] })), 'stock-reader: the keys of the subagent are not stock-reader-auth with the purpose authentication and stock-reader-delegation with the purpose delegation, as the spec says'],
      ['a subagent whose keys swap their purposes and their places', { ...data, subagents: data.subagents.map((subagent) => ({ ...subagent, keys: [{ ...subagent.keys[1], purposes: ['authentication' as const] }, { ...subagent.keys[0], purposes: ['delegation' as const] }] })) }, 'stock-reader: the keys of the subagent are not stock-reader-auth with the purpose authentication and stock-reader-delegation with the purpose delegation, as the spec says'],
      ['a subagent with another name than the spec gives', { ...data, subagents: data.subagents.map((subagent) => ({ ...subagent, name: 'stock-checker' })) }, 'stock-reader: the spec of the parent names the subagent stock-reader and the data has stock-checker'],
      ['a subagent that the example of its parent has no DID line for', { ...data, subagents: data.subagents.map((subagent) => ({ ...subagent, id: 'stock-checker' })) }, 'stock-checker: the example of the parent has no line STOCK_CHECKER_DID'],
    ])('refuse %s', (_name, broken, problem) => {
      expect(specProblems(broken)).toContain(problem);
    });
    it('refuse an organisation with another domain, and an origin that the spec does not give', () => {
      const wrongDomain = { ...data, organisations: data.organisations.map((organisation) => (organisation.id === 'echo' ? { ...organisation, domain: 'echo.example.org' } : organisation)) };
      expect(specProblems(wrongDomain)).toContain('reorder-agent: the spec gives the domain echo.vector.apexfusion.org and the data has echo.example.org');
      const wrongOrigin = mapAdvert(data, 'order-desk', 'lot-large', { origin: 'https://orders-large.example.org' });
      expect(specProblems(wrongOrigin).filter((problem) => problem.includes('Public URL'))).toHaveLength(1);
    });
  });

  describe('the key names and their use', () => {
    it('are valid and unique, 8 shared and 10 of the use case, every name that the data uses is a key, and every key is used', () => {
      expect(keyProblems(data)).toEqual([]);
      expect(data.keys.filter((key) => key.scope === 'shared')).toHaveLength(8);
      expect(data.keys.filter((key) => key.scope === 'use-case')).toHaveLength(10);
    });
    it.each<[string, UseCase, string]>([
      ['a name that is not valid', { ...data, keys: data.keys.map((key) => (key.name === 'fee' ? { ...key, name: 'Fee_Wallet' } : key)) }, 'the key name Fee_Wallet is not valid'],
      ['a name that stands twice', { ...data, keys: [...data.keys, { name: 'provider', scope: 'shared', about: 'A second provider key.' }] }, 'the key provider is in the list twice'],
      ['a key that nothing uses', { ...data, keys: [...data.keys, { name: 'spare', scope: 'use-case', about: 'A key that nothing uses.' }] }, 'the key spare is used by no agent, subagent, party or organisation'],
      ['a service key that is no key', mapAgent(data, 'order-desk', (agent) => ({ ...agent, serviceKey: 'order-desk-missing' })), 'order-desk serviceKey names the key order-desk-missing, which is no key of the use case'],
      ['a missing run wallet', { ...data, keys: data.keys.filter((key) => key.name !== 'run') }, 'the shared keys are controller, fee, provider, accountable-echo, guardian-echo, accountable-alfa, guardian-alfa and they must be controller, run, fee, provider, accountable-echo, guardian-echo, accountable-alfa, guardian-alfa'],
    ])('refuse %s', (_name, broken, problem) => {
      expect(keyProblems(broken)).toContain(problem);
    });
    it('are taken by the registry of the pack: it makes a file for each key and loads them all', () => {
      const root = makeKeyRoot();
      expect(makeMissingKeys(root, data.name, data.keys).made).toHaveLength(18);
      const registry = loadRegistry({ dir: root, useCase: data.name, specs: data.keys });
      expect(registry.names()).toEqual(data.keys.map((key) => key.name));
      expect(registry.isComplete()).toBe(true);
    });
    it('are refused by the registry when the about text of a key is too long', () => {
      const broken = { ...data, keys: data.keys.map((key, index) => (index === 0 ? { ...key, about: 'x'.repeat(201) } : key)) };
      expect(() => makeMissingKeys(makeKeyRoot(), broken.name, broken.keys)).toThrow('an about text of 1 to 200 characters');
    });
  });

  describe('the members that more than one use case has', () => {
    const PAGE = readFileSync(new URL('./golden/results-page.md', import.meta.url), 'utf8');
    it('hold the values of use case 1: the service containers, no example file of its own, the managed lines, no line of a key that the record lacks, the end of each agent, and no record, compliance, lifecycle or seed', () => {
      expect(data.agents.map((agent) => [agent.id, agent.serviceContainer, agent.exampleEnvFile, agent.envManaged, agent.publicKeyLines, agent.end])).toEqual([
        ['reorder-agent', 'reorder-service', null, { mock: true, module1: true }, [], { record: 'active', advert: 'listed', subagents: 'live', successor: null }],
        ['order-desk', 'orders-service', null, { mock: true, module1: true }, [], { record: 'active', advert: 'listed', subagents: 'live', successor: null }],
      ]);
      expect([data.records, data.compliance, data.lifecycle, data.tenantSeed]).toEqual([[], null, null, null]);
    });
    it('hold the example env file of each agent to the managed lines that the data names', () => {
      expect(managedProblems(data)).toEqual([]);
    });
    it.each<[string, UseCase, string]>([
      ['mock origins that the example has and the data does not manage', mapAgent(data, 'reorder-agent', (agent) => ({ ...agent, envManaged: { mock: false, module1: true } })), 'reorder-agent: the data says mock false and the example .env.reorder-agent.example has the lines of the mock origins'],
      ['a manifest line that the example has and the data does not manage', mapAgent(data, 'order-desk', (agent) => ({ ...agent, envManaged: { mock: true, module1: false } })), 'order-desk: the data says module1 false and the example .env.order-desk.example has the line of the Module-1 manifest'],
      ['an example file that the test does not read', mapAgent(data, 'order-desk', (agent) => ({ ...agent, exampleEnvFile: '.env.nothing.example' })), 'order-desk: the example env file .env.nothing.example is not one of the examples that this test reads'],
    ])('refuse %s', (_name, broken, problem) => {
      expect(managedProblems(broken)).toContain(problem);
    });
    it('copy the section "Not covered" of the golden results page, and refuse a copy that differs by one word', () => {
      expect(notCoveredProblems(data, PAGE)).toEqual([]);
      const changed = { ...data, notCovered: { ...data.notCovered, items: data.notCovered.items.map((item, index) => (index === 1 ? `${item.slice(0, -1)} again.` : item)) } };
      expect(notCoveredProblems(changed, PAGE)).toEqual(['the golden results page does not hold the section "Not covered" of the data']);
    });
  });

  describe('the hosts, the ports and the containers', () => {
    it('are the hosts of the Caddy snippet and the compose file of each agent, with the ports 8101 to 8104, 9101 and 9102', () => {
      expect(hostProblems(data)).toEqual([]);
      expect(data.agents.flatMap((agent) => agent.adverts).map((advert) => EXPECTED_PORTS[advert.runtimeContainer])).toEqual([8101, 8102, 8103, 8104]);
    });
    it.each<[string, UseCase, string]>([
      ['an origin with another host', mapAdvert(data, 'order-desk', 'lot-medium', { origin: 'https://mp-suppliers-orders-medium.example.org' }), 'order-desk lot-medium: PUBLIC_ORIGIN of orders-medium-runtime is https://mp-suppliers-orders-medium.vector.apexfusion.org and the origin is https://mp-suppliers-orders-medium.example.org'],
      ['a container that the compose file does not have', mapAdvert(data, 'order-desk', 'lot-small', { runtimeContainer: 'orders-tiny-runtime' }), 'order-desk lot-small: the compose file has no container orders-tiny-runtime'],
      ['a container of another lot', mapAdvert(data, 'order-desk', 'lot-large', { runtimeContainer: 'orders-medium-runtime' }), 'order-desk lot-large: the container orders-medium-runtime serves two adverts'],
      ['an endpoint that is not the first origin', mapAgent(data, 'reorder-agent', (agent) => ({ ...agent, endpoint: 'https://mp-suppliers-orders-small.vector.apexfusion.org' })), 'reorder-agent: the endpoint is not the origin of the first advert'],
      ['a status list that misses a host', mapAgent(data, 'order-desk', (agent) => ({ ...agent, statusUrls: agent.statusUrls.slice(0, 2) })), 'order-desk: statusUrls is not the list of the /status of its adverts'],
      ['a status URL with another path', mapAgent(data, 'reorder-agent', (agent) => ({ ...agent, statusUrls: ['https://mp-suppliers-reorder.vector.apexfusion.org/health'] })), 'reorder-agent: the status URL https://mp-suppliers-reorder.vector.apexfusion.org/health does not end in /status'],
      ['an env file of the runtime that the compose file does not read', mapAdvert(data, 'order-desk', 'lot-small', { runtimeEnvFile: '.env.order-desk-medium' }), 'order-desk lot-small: the env files of orders-small-runtime are ./.env.order-desk, ./.env.order-desk-small and the data has ./.env.order-desk, ./.env.order-desk-medium'],
      ['a service container that the compose file does not have', mapAgent(data, 'order-desk', (agent) => ({ ...agent, serviceContainer: 'orders-tiny-service' })), 'order-desk: the compose file has no container orders-tiny-service, the service container of the data'],
      ['a service container that is the container of an advert', mapAgent(data, 'reorder-agent', (agent) => ({ ...agent, serviceContainer: 'reorder-runtime' })), 'reorder-agent: the service container reorder-runtime of the data is the container of an advert'],
    ])('refuse %s', (_name, broken, problem) => {
      expect(hostProblems(broken)).toContain(problem);
    });
    it('refuse an advert that is gone while its block and its container stay', () => {
      const broken = mapAgent(data, 'order-desk', (agent) => ({ ...agent, adverts: agent.adverts.slice(0, 2), statusUrls: agent.statusUrls.slice(0, 2) }));
      expect(hostProblems(broken)).toEqual([
        'order-desk: the Caddy snippet has a block for mp-suppliers-orders-large.vector.apexfusion.org and no advert has that host',
        'order-desk: the compose file has the container orders-large-runtime and no advert uses it',
      ]);
    });
    it.each<[string, Readonly<Record<string, AgentFiles | undefined>>, string]>([
      ['a port of a runtime in the compose file', withFiles('order-desk', (files) => mapService(files, 'orders-medium-runtime', (service) => ({ ...service, ports: ['127.0.0.1:8113:8080'] }))), 'order-desk lot-medium: the compose file publishes 127.0.0.1:8113:8080 for orders-medium-runtime and it must be 127.0.0.1:8103:8080'],
      ['a port of a service in the compose file', withFiles('reorder-agent', (files) => mapService(files, 'reorder-service', (service) => ({ ...service, ports: ['127.0.0.1:9111:9101'] }))), 'reorder-agent: the compose file publishes 127.0.0.1:9111:9101 for reorder-service and it must be 127.0.0.1:9101:9101'],
      ['a window of a runtime in the compose file', withFiles('reorder-agent', (files) => mapService(files, 'reorder-runtime', (service) => ({ ...service, env: { ...service.env, ADVERT_MAX_PROCESSING_MS: '1800001' } }))), 'reorder-agent reorder-agent-v1: ADVERT_MAX_PROCESSING_MS of reorder-runtime is 1800001 and the window is 1800000'],
      ['a port in the service address of a runtime', withFiles('order-desk', (files) => mapService(files, 'orders-large-runtime', (service) => ({ ...service, env: { ...service.env, SERVICE_URL: 'http://orders-service:9112/' } }))), 'order-desk lot-large: SERVICE_URL of orders-large-runtime is http://orders-service:9112/ and it must be http://orders-service:9102/'],
      ['a port in the check address of a runtime', withFiles('reorder-agent', (files) => mapService(files, 'reorder-runtime', (service) => ({ ...service, env: { ...service.env, SERVICE_PRECHECK_URL: 'http://reorder-service:9111/precheck' } }))), 'reorder-agent reorder-agent-v1: SERVICE_PRECHECK_URL of reorder-runtime is http://reorder-service:9111/precheck and it must be http://reorder-service:9101/precheck'],
      ['a port of the lots path in a Caddy block', withFiles('order-desk', (files) => mapHandle(files, '/lots.json', (handle) => ({ ...handle, upstream: 'orders-service:9112' }))), 'order-desk: the /lots.json handle of the Caddy block of mp-suppliers-orders-small.vector.apexfusion.org is orders-service:9112 and it must be orders-service:9102'],
      ['a port of the runtime in a Caddy block', withFiles('reorder-agent', (files) => mapHandle(files, null, (handle) => ({ ...handle, upstream: 'reorder-runtime:8180' }))), 'reorder-agent reorder-agent-v1: the default handle of the Caddy block of mp-suppliers-reorder.vector.apexfusion.org is reorder-runtime:8180 and it must be reorder-runtime:8080'],
    ])('refuse a broken copy of a public file: %s', (_name, table, problem) => {
      expect(hostProblems(data, table)).toContain(problem);
    });
  });

  describe('the lots', () => {
    it('hold the SKU of each run, with a size for each lot of the Order Desk', () => {
      expect(lotProblems(data)).toEqual([]);
      expect(data.runs.map((run) => run.subject)).toEqual(['GLV-NIT-M', 'MSK-N95']);
    });
    it.each<[string, UseCase, string]>([
      ['a SKU that the lots file does not hold', { ...data, runs: data.runs.map((run) => (run.id === 'failure' ? { ...run, subject: 'MSK-N99' } : run)) }, 'run failure: the SKU MSK-N99 is not in the lots file'],
      ['a lot that the SKU has no size for', mapAdvert(data, 'order-desk', 'lot-large', { model: 'lot-jumbo' }), 'run clean: the SKU GLV-NIT-M has no size for the lot lot-jumbo'],
      ['two runs with one SKU', { ...data, runs: data.runs.map((run) => ({ ...run, subject: 'GLV-NIT-M' })) }, 'two runs have the same SKU'],
    ])('refuse %s', (_name, broken, problem) => {
      expect(lotProblems(broken)).toContain(problem);
    });
  });

  describe('the limits of the vault of each run', () => {
    it('let one order of the medium lot through, refuse the large lot, and refuse a second order of the medium lot', () => {
      expect(runProblems(data)).toEqual([]);
    });
    it.each<[string, UseCase, string]>([
      ['a limit of one payment below the medium lot', { ...data, runs: data.runs.map((run) => ({ ...run, perTxUnits: 6 })) }, 'run clean: the limit of one payment, 6 units, is below the lock of the medium lot, 7 units'],
      ['a limit of one payment that lets the large lot through', { ...data, runs: data.runs.map((run) => ({ ...run, perTxUnits: 12 })) }, 'run clean: the limit of one payment, 12 units, does not refuse the large lot, which locks 12 units'],
      ['a total that lets a second order through', { ...data, runs: data.runs.map((run) => ({ ...run, totalUnits: 14 })) }, 'run clean: the total, 14 units, must be at least one lock of the medium lot, 7 units, and below two'],
      ['a vault that holds less than the total', { ...data, runs: data.runs.map((run) => ({ ...run, vaultUnits: 6.9 })) }, 'run clean: the vault holds 6.9 units and the total is 7 units'],
    ])('refuse %s', (_name, broken, problem) => {
      expect(runProblems(broken)).toContain(problem);
    });
  });

  describe('the funding', () => {
    it('is one line for each paying wallet, with a collateral of 5,000,000 and a float that covers its items, adding to 45, 460 and 505 units', () => {
      expect(fundingProblems(data)).toEqual([]);
      expect(data.funding).toHaveLength(9);
    });
    it.each<[string, UseCase, string[]]>([
      ['a wallet that is missing', { ...data, funding: data.funding.filter((line) => line.wallet !== 'reorder-delegation-2') }, [
        'funding: the paying wallet reorder-delegation-2 has no line',
        'funding: the collateral adds to 40000000 and it must add to 45000000',
        'funding: the floats add to 440000000 and they must add to 460000000',
        'funding: the lines add to 480000000 and they must add to 505000000',
      ]],
      ['a wallet that is no key name', mapFunding(data, 'fee', { wallet: 'fee-wallet' }), [
        'funding: the wallet fee-wallet is no key name',
        'funding: the paying wallet fee has no line',
        'funding: the wallet fee-wallet is the wallet of no agent key and it is not the fee wallet',
      ]],
      ['a wallet of a subagent key', mapFunding(data, 'fee', { wallet: 'stock-reader-auth' }), [
        'funding: the paying wallet fee has no line',
        'funding: the wallet stock-reader-auth is the wallet of no agent key and it is not the fee wallet',
      ]],
      ['a collateral that is not 5,000,000', mapFunding(data, 'reorder-service', { collateralLovelace: 6_000_000n }), [
        'funding reorder-service: the collateral is 6000000 and it must be 5000000',
        'funding: the collateral adds to 46000000 and it must add to 45000000',
        'funding: the lines add to 506000000 and they must add to 505000000',
      ]],
      ['a float below the sum of its items', mapFunding(data, 'reorder-service', { floatLovelace: 189_000_000n }), [
        'funding reorder-service: the float 189000000 is below the sum of its items, 189820000',
        'funding: the floats add to 459000000 and they must add to 460000000',
        'funding: the lines add to 504000000 and they must add to 505000000',
      ]],
      ['a float above the rounded sum of its items', mapFunding(data, 'fee', { floatLovelace: 63_660_001n }), [
        'funding fee: the float 63660001 is not the sum of its items, 53660000, rounded up to 10 units, 60000000',
        'funding: the floats add to 463660001 and they must add to 460000000',
        'funding: the lines add to 508660001 and they must add to 505000000',
      ]],
      ['a float within 10 units of the sum that is not the rounded sum', mapFunding(data, 'order-desk-service', { floatLovelace: 128_000_000n }), [
        'funding order-desk-service: the float 128000000 is not the sum of its items, 125620000, rounded up to 10 units, 130000000',
        'funding: the floats add to 458000000 and they must add to 460000000',
        'funding: the lines add to 503000000 and they must add to 505000000',
      ]],
      ['two floats that move 2 units from one wallet to another', mapFunding(mapFunding(data, 'order-desk-service', { floatLovelace: 128_000_000n }), 'order-medium-supplier', { floatLovelace: 12_000_000n }), [
        'funding order-medium-supplier: the float 12000000 is not the sum of its items, 7450000, rounded up to 10 units, 10000000',
        'funding order-desk-service: the float 128000000 is not the sum of its items, 125620000, rounded up to 10 units, 130000000',
      ]],
    ])('refuses %s', (_name, broken, problems) => {
      expect(fundingProblems(broken)).toEqual(problems);
    });
    it('refuses a wallet that has two lines', () => {
      const broken = { ...data, funding: [...data.funding, data.funding[0]] };
      expect(fundingProblems(broken)).toContain('funding: the wallet fee has more than one line');
    });
    it('follows the stake, the two claims in flight, the challenge stake, and the supplier bond and the deposit of each advert', () => {
      expect(fundingTieProblems(data)).toEqual([]);
    });
    it.each<[string, UseCase, string]>([
      ['a stake that no item holds', mapAgent(data, 'order-desk', (agent) => ({ ...agent, stakeLovelace: 11_000_000n })), 'funding order-desk-service: no item is the stake, 11000000'],
      ['a claim stake that two claims in flight do not follow', mapAgent(data, 'reorder-agent', (agent) => ({ ...agent, claim: { ...agent.claim, stakeLovelace: 40_000_000n } })), 'funding reorder-service: no item is two claims in flight, 80000000'],
      ['a supplier bond that no item holds', mapAdvert(data, 'order-desk', 'lot-large', { supplierBondLovelace: 2_000_000n }), 'funding order-large-supplier: no item is the supplier bond, 2000000'],
      ['a challenge stake that no item holds', mapFunding(data, 'reorder-service', { items: data.funding.find((line) => line.wallet === 'reorder-service')?.items.filter((item) => item.what !== 'One challenge') ?? [] }), 'funding reorder-service: no item is one challenge stake, 50000000'],
      ['an advert deposit that no item holds', mapAdvert(data, 'order-desk', 'lot-medium', { depositLovelace: 2_600_000n }), 'funding order-medium-supplier: no item is the advert deposit, 2600000'],
    ])('refuses %s', (_name, broken, problem) => {
      expect(fundingTieProblems(broken)).toContain(problem);
    });
  });

  describe('the runtime commit and the manifest path', () => {
    it('equal the ref of each checkout of the agent template in the CI file, and the path in both examples', () => {
      expect(commitProblems(data)).toEqual([]);
      expect(TEMPLATE_CHECKOUT_REFS.length).toBeGreaterThan(0);
    });
    it.each<[string, UseCase, string]>([
      ['a commit that the CI file does not check out', { ...data, runtimeCommit: `${data.runtimeCommit.slice(0, 39)}0` }, `the runtime commit is ${data.runtimeCommit.slice(0, 39)}0 and a template checkout of the CI file has the ref ${data.runtimeCommit}`],
      ['a commit that is no hash', { ...data, runtimeCommit: 'main' }, 'the runtime commit main is not 40 lower-case hex characters'],
      ['a manifest path that the examples do not give', { ...data, moduleManifestPath: 'Module-1/deploy/identity/testnet/manifest.json' }, 'the manifest path is Module-1/deploy/identity/testnet/manifest.json and .env.reorder-agent.example gives Module-1/deploy/identity/mainnet/manifest.json'],
    ])('refuse %s', (_name, broken, problem) => {
      expect(commitProblems(broken)).toContain(problem);
    });
  });

  describe('the parties', () => {
    it('have both Guardians, a Provider with no rights, and no Guardian with the signer kind controller', () => {
      expect(partyProblems(data)).toEqual([]);
      for (const agent of data.agents) {
        expect(agent.parties.filter((party) => party.role === 'Guardian')).toHaveLength(2);
        expect(agent.parties.find((party) => party.role === 'Provider')?.rights).toEqual([]);
      }
    });
    it.each<[string, UseCase, string]>([
      ['a Guardian with the signer kind controller', mapParties(data, 'reorder-agent', (parties) => parties.map((party) => (party.role === 'Guardian' && party.signer.kind === 'key' && party.signer.key === 'controller' ? { ...party, signer: { kind: 'controller' as const } } : party))), 'reorder-agent: the Guardian has the signer kind controller, which the register tool refuses for this role'],
      ['a missing Guardian', mapParties(data, 'order-desk', (parties) => parties.filter((party) => !(party.role === 'Guardian' && party.signer.kind === 'key' && party.signer.key === 'guardian-alfa'))), 'order-desk: it needs two Guardians and the threshold 2, and it has 1 Guardians and the threshold 2'],
      ['a Provider with the default rights', mapParties(data, 'order-desk', (parties) => parties.map((party) => (party.role === 'Provider' ? { ...party, rights: null } : party))), 'order-desk: it needs one Provider with the key provider and rights []'],
      ['an Accountable of another organisation', mapParties(data, 'reorder-agent', (parties) => parties.map((party) => (party.role === 'Accountable' ? { ...party, signer: { kind: 'key' as const, key: 'accountable-alfa' } } : party))), 'reorder-agent: it needs one Accountable with the key accountable-echo and the organisation echo.vector.apexfusion.org'],
      ['a Responsible with a key signer', mapParties(data, 'order-desk', (parties) => parties.map((party) => (party.role === 'Responsible' ? { ...party, signer: { kind: 'key' as const, key: 'controller' } } : party))), 'order-desk: it needs one Responsible with the signer kind module1'],
      ['organisations that swap their Accountable keys', { ...data, organisations: data.organisations.map((organisation) => ({ ...organisation, accountableKey: organisation.id === 'echo' ? 'accountable-alfa' : 'accountable-echo' })) }, 'organisation echo: the Accountable key is accountable-alfa and it must be accountable-echo'],
    ])('refuse %s', (_name, broken, problem) => {
      expect(partyProblems(broken)).toContain(problem);
    });
  });

  describe('the rest of the data', () => {
    it('has a name and a description that the register tool takes, a subagent with two keys, the attestations and the steps of the evidence', () => {
      expect(shapeProblems(data)).toEqual([]);
      expect(data.evidenceSteps.map((step) => step.id)).toEqual([
        'r1-01', 'r1-02', 'r1-03', 'r1-04', 'r1-05', 'r1-06', 'r1-07', 'r1-08', 'r1-09', 'r1-10', 'r1-11', 'r2-a', 'r2-b', 'r2-c', 'r2-d', 'r2-e', 'r2-f', 'r2-g', 'r2-h',
      ]);
    });
    it.each<[string, UseCase, string]>([
      ['a description of more than 256 bytes', mapAgent(data, 'reorder-agent', (agent) => ({ ...agent, description: `${DEMONSTRATION} ${'x'.repeat(256)}` })), 'reorder-agent: the description has more than 256 bytes'],
      ['a description that does not name the demonstration', mapAgent(data, 'order-desk', (agent) => ({ ...agent, description: 'Order desk of a supplier.' })), 'order-desk: the description does not start with the sentence that names the demonstration'],
      ['a name of more than 64 bytes', mapAgent(data, 'order-desk', (agent) => ({ ...agent, name: 'x'.repeat(65) })), 'order-desk: the name has more than 64 bytes'],
      ['a subagent with an unknown parent', { ...data, subagents: data.subagents.map((subagent) => ({ ...subagent, parent: 'nobody' })) }, 'stock-reader: its parent nobody is no agent'],
      ['an envelope on both agents', { ...data, attestations: data.attestations.map((attestation) => ({ ...attestation, envelope: { type: 'software' as const } })) }, 'the envelope is on reorder-agent software, order-desk software and it must be on the software attestation of reorder-agent only'],
      ['a format other than 50', { ...data, attestations: data.attestations.map((attestation) => ({ ...attestation, format: 49 })) }, 'reorder-agent: the attestation format is 49 and it must be 50'],
      ['a validity of more than 366 days', { ...data, attestations: data.attestations.map((attestation) => ({ ...attestation, validDays: 367 })) }, 'order-desk: the attestation validity is 367 days and it must be 1 to 366'],
      ['a step id that stands twice', { ...data, evidenceSteps: [...data.evidenceSteps, data.evidenceSteps[0]] }, 'the evidence step r1-01 is in the list twice'],
      ['a step with an unknown actor', { ...data, evidenceSteps: data.evidenceSteps.map((step) => (step.id === 'r2-d' ? { ...step, actor: 'jury' as unknown as 'relay' } : step)) }, 'the evidence step r2-d has the actor jury'],
      ['a step of a run that does not exist', { ...data, evidenceSteps: data.evidenceSteps.map((step) => (step.id === 'r2-a' ? { ...step, run: 'dry' as unknown as 'failure' } : step)) }, 'the evidence step r2-a names the run dry, which is no run'],
    ])('refuses %s', (_name, broken, problem) => {
      expect(shapeProblems(broken)).toContain(problem);
    });
  });
});
