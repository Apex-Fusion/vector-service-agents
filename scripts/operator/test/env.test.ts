// The task env, run through the real runner over the real examples of the env files (read from deploy/server at test time), a registry of test keys for the 18 keys of use case 1 (inventory
// reorder), the facts of the two records, and the world of the pack tests. The tests look for each seed and each token in every file and every stream that the task must not write them to.
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { iso } from '../../checks/lib/format.ts';
import type { AgentSpec, UseCase } from '../lib/contract.ts';
import { EnvFile } from '../lib/envfile.ts';
import { FactsFile } from '../lib/facts.ts';
import { MOCK_MTLS_BASE, MOCK_PUBLIC_BASE } from '../lib/mock-hosts.ts';
import task, { checkEnvFiles } from '../tasks/env.ts';
import USE from '../usecases/inventory-reorder.ts';
import { NOW, USE_CASE, hashOf, taskWorld } from './support/task-world.ts';
import type { TaskWorld } from './support/task-world.ts';

const SERVER = fileURLToPath(new URL('../../../deploy/server/', import.meta.url));
const NAMES = USE.keys.map((key) => key.name);
const SHARED = USE.keys.filter((key) => key.scope === 'shared').map((key) => key.name);
const CONTACT = 'role@example.org';
const COMMIT = 'ab'.repeat(20);
const REORDER = 'reorder-agent/.env.reorder-agent';
const SERVICE = 'order-desk/.env.order-desk';
const RUNTIMES = ['order-desk/.env.order-desk-small', 'order-desk/.env.order-desk-medium', 'order-desk/.env.order-desk-large'];
const ALL = [REORDER, SERVICE, ...RUNTIMES];
const EXAMPLE_OF = (file: string): string => (file === REORDER ? '.env.reorder-agent.example' : file === SERVICE ? '.env.order-desk.example' : '.env.order-desk-runtime.example');
const reorder = USE.agents.find((agent) => agent.id === 'reorder-agent')!;
const desk = USE.agents.find((agent) => agent.id === 'order-desk')!;

/** The seed of each key, and the one line of the one file that holds it. Written by hand, so that a change of the data does not move the expectation with it. */
const SECRET_LINES: ReadonlyArray<readonly [key: string, file: string, line: string]> = [
  ['reorder-supplier', REORDER, 'SUPPLIER_PRIV_KEY_HEX'], ['reorder-service', REORDER, 'REORDER_SERVICE_PRIV_KEY_HEX'],
  ['reorder-delegation-1', REORDER, 'REORDER_DELEGATION_1_PRIV_KEY_HEX'], ['reorder-delegation-2', REORDER, 'REORDER_DELEGATION_2_PRIV_KEY_HEX'],
  ['stock-reader-auth', REORDER, 'STOCK_READER_AUTH_PRIV_KEY_HEX'], ['stock-reader-delegation', REORDER, 'STOCK_READER_DELEGATION_PRIV_KEY_HEX'],
  ['order-small-supplier', RUNTIMES[0]!, 'SUPPLIER_PRIV_KEY_HEX'], ['order-medium-supplier', RUNTIMES[1]!, 'SUPPLIER_PRIV_KEY_HEX'], ['order-large-supplier', RUNTIMES[2]!, 'SUPPLIER_PRIV_KEY_HEX'],
  ['order-desk-service', SERVICE, 'ORDER_DESK_SERVICE_PRIV_KEY_HEX'],
];

const KEY_PUBLIC = ['SUPPLIER_PUB_KEY_HEX', 'SUPPLIER_PKH', 'SUPPLIER_ADDRESS'];
const RUNTIME_NAMES = ['SUPPLIER_PRIV_KEY_HEX', ...KEY_PUBLIC, 'AGENT_ID'];
/** The lines that a first run sets in each file, by hand: the other lines stay as the example has them. */
const SET_BY_FIRST_RUN: Readonly<Record<string, readonly string[]>> = {
  [REORDER]: [
    'SUPPLIER_PRIV_KEY_HEX', ...KEY_PUBLIC, 'REORDER_SERVICE_PRIV_KEY_HEX', 'REORDER_SERVICE_PKH', 'REORDER_DELEGATION_1_PRIV_KEY_HEX', 'REORDER_DELEGATION_1_PKH',
    'REORDER_DELEGATION_2_PRIV_KEY_HEX', 'REORDER_DELEGATION_2_PKH', 'STOCK_READER_AUTH_PRIV_KEY_HEX', 'STOCK_READER_AUTH_PKH', 'STOCK_READER_DELEGATION_PRIV_KEY_HEX', 'STOCK_READER_DELEGATION_PKH',
    'SERVICE_AUTH_HEADER', 'IDENTITY_ADDRESS', 'AGENT_ID', 'VECTOR_MODULE1_MANIFEST', 'MOCK_PUBLIC_BASE', 'MOCK_MTLS_BASE', 'OPERATOR_CONTACT', 'AGENT_DID', 'STOCK_READER_DID',
  ],
  [SERVICE]: [
    'ORDER_DESK_SERVICE_PRIV_KEY_HEX', 'ORDER_DESK_SERVICE_PKH', 'SERVICE_AUTH_HEADER', 'IDENTITY_ADDRESS', 'VECTOR_MODULE1_MANIFEST', 'MOCK_PUBLIC_BASE', 'MOCK_MTLS_BASE',
    'SMALL_SUPPLIER_PKH', 'SMALL_SUPPLIER_PUB_KEY_HEX', 'MEDIUM_SUPPLIER_PKH', 'MEDIUM_SUPPLIER_PUB_KEY_HEX', 'LARGE_SUPPLIER_PKH', 'LARGE_SUPPLIER_PUB_KEY_HEX', 'OPERATOR_CONTACT', 'AGENT_DID',
  ],
  [RUNTIMES[0]!]: RUNTIME_NAMES, [RUNTIMES[1]!]: RUNTIME_NAMES, [RUNTIMES[2]!]: RUNTIME_NAMES,
};
const FIRST_RUN_LINES = 53;

const roots: string[] = [];
afterAll(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

interface EnvWorld { readonly w: TaskWorld; readonly agents: string; path(file: string): string; text(file: string): string; value(file: string, name: string): string | undefined }

const recordOf = (id: string) => {
  const hex = hashOf(`record ${id}`);
  return { did: `did:vector:${hex}`, id: hex, tx: hashOf(`record tx ${id}`), recordRef: `${hashOf(`record tx ${id}`)}#0`, depositLovelace: '10000000', registeredAt: iso(NOW) };
};
const advertOf = (agent: string, model: string, salt = '') => {
  const tx = hashOf(`advert ${agent} ${model} ${salt}`);
  return { ref: `${tx}#0`, tx, detailUri: `https://example.org/${agent}/agent.json`, detailHash: hashOf(`detail ${agent}`), endpoint: `https://example.org/${agent}`, postedAt: iso(NOW) };
};
const ADVERTS: ReadonlyArray<readonly [agent: string, model: string, file: string]> = [
  ['reorder-agent', 'reorder-agent-v1', REORDER], ['order-desk', 'lot-small', RUNTIMES[0]!], ['order-desk', 'lot-medium', RUNTIMES[1]!], ['order-desk', 'lot-large', RUNTIMES[2]!],
];

function factsOf(w: TaskWorld): FactsFile {
  return FactsFile.open(join(w.stateDir, 'facts.json'), { useCase: USE_CASE, network: 'vector-mainnet' });
}
function putRecords(w: TaskWorld, ids: readonly string[] = ['reorder-agent', 'stock-reader', 'order-desk']): void {
  for (const id of ids) factsOf(w).put('records', [id], recordOf(id));
}
function putAdverts(w: TaskWorld, salt = '', replace = false): void {
  for (const [agent, model] of ADVERTS) factsOf(w).put('adverts', [agent, model], advertOf(agent, model, salt), { replace });
}

interface WorldOptions { env?: Record<string, string | undefined>; use?: Partial<UseCase>; records?: boolean; go?: boolean; examples?: boolean }

async function envWorld(options: WorldOptions = {}): Promise<EnvWorld> {
  const agents = mkdtempSync(join(tmpdir(), 'operator-agents-'));
  roots.push(agents);
  for (const [folder, names] of Object.entries({ 'reorder-agent': ['.env.reorder-agent.example'], 'order-desk': ['.env.order-desk.example', '.env.order-desk-runtime.example'] })) {
    mkdirSync(join(agents, folder), { mode: 0o750 });
    if (options.examples !== false) for (const name of names) copyFileSync(join(SERVER, name), join(agents, folder, name));
  }
  const w = await taskWorld({ keys: NAMES, shared: SHARED, use: { ...USE, ...options.use }, env: { OPERATOR_AGENTS_DIR: agents, OPERATOR_CONTACT: CONTACT, OPERATOR_MODULE1_COMMIT: COMMIT, ...options.env } });
  if (options.records !== false) putRecords(w);
  if (options.go !== false) w.writeGo({ tasks: ['env'] });
  return { w, agents, path: (file) => join(agents, file), text: (file) => readFileSync(join(agents, file), 'utf8'), value: (file, name) => EnvFile.open(join(agents, file)).get(name) };
}

/** The managed lines of a service file whose example holds a placeholder. A file that an operator copied and filled holds a value or nothing in them, so a file made here starts with them empty. */
const HOLES = ['OPERATOR_CONTACT', 'MOCK_PUBLIC_BASE', 'MOCK_MTLS_BASE', 'VECTOR_MODULE1_MANIFEST'];

/** Makes a file that exists already: the example with its placeholder lines emptied and the lines of `edits` set, and the mode. */
function seedFile(e: EnvWorld, file: string, edits: Record<string, string> = {}, mode = 0o600): void {
  const env = EnvFile.fromExample(readFileSync(join(SERVER, EXAMPLE_OF(file)), 'utf8'));
  for (const name of HOLES) if (env.has(name)) env.set(name, '');
  for (const [name, value] of Object.entries(edits)) env.set(name, value);
  env.write(e.path(file));
  chmodSync(e.path(file), mode);
}

const mode = (path: string): number => statSync(path).mode & 0o777;
const count = (text: string, needle: string): number => text.split(needle).length - 1;
const submit = (e: EnvWorld, ...argv: string[]): Promise<number> => e.w.run(task, '--submit', ...argv);
const dry = (e: EnvWorld, ...argv: string[]): Promise<number> => e.w.run(task, ...argv);
const other = (label: string, length: number): string => hashOf(label).repeat(2).slice(0, length);

/** Every seed that the test registry holds, as text that a stream or a file must not show. */
const seedsOf = (e: EnvWorld): string[] => NAMES.map((name) => e.w.keys.seedOf(name));
const tokensOf = (e: EnvWorld): string[] => [REORDER, SERVICE].map((file) => e.value(file, 'SERVICE_AUTH_HEADER')!);

describe('the files that the task makes from the examples', () => {
  it('makes the Reorder file and the four Order Desk files, each with mode 600, and says so in the machine line', async () => {
    const e = await envWorld();
    expect(await submit(e)).toBe(0);
    for (const file of ALL) {
      expect(existsSync(e.path(file)), file).toBe(true);
      expect(mode(e.path(file)), file).toBe(0o600);
    }
    const line = e.w.machine();
    expect(line).toMatchObject({ task: 'env', command: 'run', mode: 'submit', outcome: 'done', exit: 0 });
    expect(line.result).toEqual({ files: ALL, made: ALL, linesSet: FIRST_RUN_LINES });
  });

  it('puts each seed into its one line of its one file, and in no other place of any file', async () => {
    const e = await envWorld();
    expect(await submit(e)).toBe(0);
    const everything = ALL.map((file) => e.text(file)).join('\n');
    for (const [key, file, line] of SECRET_LINES) {
      const seed = e.w.keys.seedOf(key);
      expect(e.value(file, line), `${key} in ${file}`).toBe(seed);
      expect(count(everything, seed), `the seed of ${key}`).toBe(1);
    }
  });

  it('keeps the supplier seeds out of the service file, the service seed out of the runtime files, and each runtime seed out of the other runtime files', async () => {
    const e = await envWorld();
    expect(await submit(e)).toBe(0);
    const supplier = ['order-small-supplier', 'order-medium-supplier', 'order-large-supplier'];
    for (const key of supplier) expect(e.text(SERVICE)).not.toContain(e.w.keys.seedOf(key));
    expect(e.text(SERVICE)).toContain(e.w.keys.seedOf('order-desk-service'));
    RUNTIMES.forEach((file, index) => {
      expect(e.text(file)).not.toContain(e.w.keys.seedOf('order-desk-service'));
      supplier.forEach((key, at) => { if (at !== index) expect(e.text(file)).not.toContain(e.w.keys.seedOf(key)); });
      expect(e.text(file)).toContain(e.w.keys.seedOf(supplier[index]!));
    });
    for (const key of ['reorder-supplier', 'reorder-service', 'reorder-delegation-1', 'reorder-delegation-2', 'stock-reader-auth', 'stock-reader-delegation']) {
      expect(e.text(REORDER)).toContain(e.w.keys.seedOf(key));
    }
    for (const file of [SERVICE, ...RUNTIMES]) for (const key of ['reorder-supplier', 'reorder-service', 'stock-reader-auth']) expect(e.text(file)).not.toContain(e.w.keys.seedOf(key));
  });

  it('fills the public lines from the registry, the facts, the settings and the deployment, and makes the DID and the id agree', async () => {
    const e = await envWorld();
    expect(await submit(e)).toBe(0);
    const registry = e.w.keys.registry;
    expect(e.value(REORDER, 'SUPPLIER_PKH')).toBe(registry.hashOf('reorder-supplier'));
    expect(e.value(REORDER, 'SUPPLIER_PUB_KEY_HEX')).toBe(registry.publicKeyOf('reorder-supplier'));
    expect(e.value(REORDER, 'SUPPLIER_ADDRESS')).toBe(registry.addressOf('reorder-supplier'));
    expect(e.value(REORDER, 'STOCK_READER_AUTH_PKH')).toBe(registry.hashOf('stock-reader-auth'));
    expect(e.value(SERVICE, 'ORDER_DESK_SERVICE_PKH')).toBe(registry.hashOf('order-desk-service'));
    const sizes = ['SMALL', 'MEDIUM', 'LARGE'];
    RUNTIMES.forEach((file, index) => {
      const key = ['order-small-supplier', 'order-medium-supplier', 'order-large-supplier'][index]!;
      expect(e.value(file, 'SUPPLIER_PKH')).toBe(registry.hashOf(key));
      expect(e.value(SERVICE, `${sizes[index]}_SUPPLIER_PKH`)).toBe(registry.hashOf(key));
      expect(e.value(SERVICE, `${sizes[index]}_SUPPLIER_PUB_KEY_HEX`)).toBe(registry.publicKeyOf(key));
      expect(e.value(file, 'SUPPLIER_ADDRESS')).toBe(registry.addressOf(key));
      expect(e.value(file, 'AGENT_ID')).toBe(recordOf('order-desk').id);
    });
    expect(e.value(REORDER, 'AGENT_ID')).toBe(recordOf('reorder-agent').id);
    expect(e.value(REORDER, 'AGENT_DID')).toBe(recordOf('reorder-agent').did);
    expect(e.value(REORDER, 'STOCK_READER_DID')).toBe(recordOf('stock-reader').did);
    expect(e.value(SERVICE, 'AGENT_DID')).toBe(recordOf('order-desk').did);
    for (const file of [REORDER, SERVICE]) {
      expect(e.value(file, 'OPERATOR_CONTACT')).toBe(CONTACT);
      expect(e.value(file, 'MOCK_PUBLIC_BASE')).toBe(MOCK_PUBLIC_BASE);
      expect(e.value(file, 'MOCK_MTLS_BASE')).toBe(MOCK_MTLS_BASE);
      expect(e.value(file, 'IDENTITY_ADDRESS')).toBe(e.w.chain.deployment.identity.address);
      expect(e.value(file, 'VECTOR_MODULE1_MANIFEST')).toBe(`https://raw.githubusercontent.com/Apex-Fusion/vector-agent-modules/${COMMIT}/Module-1/deploy/identity/mainnet/manifest.json`);
    }
  });

  it('changes the lines of the plan and no other line: the lines of each file that differ from its example are the lines of the plan, and the other lines keep their place', async () => {
    const e = await envWorld();
    expect(await submit(e)).toBe(0);
    for (const file of ALL) {
      const before = readFileSync(join(SERVER, EXAMPLE_OF(file)), 'utf8').split('\n');
      const after = e.text(file).split('\n');
      expect(after.length, file).toBe(before.length);
      const changed = after.flatMap((line, index) => (line === before[index] ? [] : [line.slice(0, line.indexOf('='))]));
      expect([...changed].sort(), file).toEqual([...SET_BY_FIRST_RUN[file]!].sort());
    }
    expect(e.value(REORDER, 'ADVERT_REF')).toBe('');
    for (const file of RUNTIMES) expect(e.value(file, 'ADVERT_REF')).toBe('');
    expect(e.value(SERVICE, 'FAULT_MODE')).toBe('');
    expect(e.value(REORDER, 'COSIGN_ALLOWLIST')).toBe('');
    expect(e.value(SERVICE, 'LOTS_PUBLIC_ORIGIN')).toBe('https://mp-suppliers-orders-small.vector.apexfusion.org');
  });

  it('makes the token once for each service file, and keeps it when the task runs again', async () => {
    const e = await envWorld();
    expect(await submit(e)).toBe(0);
    const [first, second] = tokensOf(e);
    expect(first).toMatch(/^Bearer [0-9a-f]{64}$/);
    expect(second).toMatch(/^Bearer [0-9a-f]{64}$/);
    expect(first).not.toBe(second);
    for (const file of RUNTIMES) expect(e.value(file, 'SERVICE_AUTH_HEADER')).toBeUndefined();
    const before = ALL.map((file) => e.text(file));
    e.w.screen.lines.length = 0;
    expect(await submit(e)).toBe(0);
    expect(tokensOf(e)).toEqual([first, second]);
    expect(ALL.map((file) => e.text(file))).toEqual(before);
    expect(e.w.machine().result).toEqual({ files: ALL, made: [], linesSet: 0 });
  });

  it('sets an ADVERT_REF only when the facts hold its advert, and replaces one only with --replace-advert', async () => {
    const e = await envWorld();
    expect(await submit(e)).toBe(0);
    for (const [, , file] of ADVERTS) expect(e.value(file, 'ADVERT_REF'), file).toBe('');
    putAdverts(e.w);
    expect(await submit(e)).toBe(0);
    for (const [agent, model, file] of ADVERTS) expect(e.value(file, 'ADVERT_REF'), file).toBe(advertOf(agent, model).ref);
    expect(e.w.machine().result).toMatchObject({ made: [], linesSet: 4 });
    expect(await submit(e)).toBe(0);
    expect(e.w.machine().result).toMatchObject({ linesSet: 0 });
    // A new advert (the old one was retired): the line holds the old reference, so the run stops and the file stays.
    putAdverts(e.w, 'second', true);
    const before = ALL.map((file) => e.text(file));
    e.w.screen.errors.length = 0;
    expect(await submit(e)).toBe(2);
    expect(e.w.screen.errorText).toContain(REORDER);
    expect(e.w.screen.errorText).toContain('ADVERT_REF');
    expect(e.w.screen.errorText).toContain('--replace-advert');
    expect(ALL.map((file) => e.text(file))).toEqual(before);
    expect(await submit(e, '--replace-advert')).toBe(0);
    for (const [agent, model, file] of ADVERTS) expect(e.value(file, 'ADVERT_REF'), file).toBe(advertOf(agent, model, 'second').ref);
    expect(e.w.machine().result).toMatchObject({ linesSet: 4 });
  });

  it('lets --replace-advert replace the reference of an advert and no other line', async () => {
    const e = await envWorld();
    seedFile(e, REORDER, { REORDER_SERVICE_PKH: other('pkh', 56) });
    const before = e.text(REORDER);
    expect(await submit(e, '--replace-advert')).toBe(2);
    expect(e.w.screen.errorText).toContain('REORDER_SERVICE_PKH');
    expect(e.text(REORDER)).toBe(before);
  });
});

describe('a file that exists', () => {
  it('sets an empty managed line, keeps a line that holds the value that the task would set, and keeps the lines that the task does not manage', async () => {
    const e = await envWorld();
    const key = hashOf('allowed').slice(0, 56);
    seedFile(e, REORDER, { SUPPLIER_PKH: e.w.keys.registry.hashOf('reorder-supplier'), OPERATOR_CONTACT: CONTACT, COSIGN_ALLOWLIST: key, AGENT_STATUS_CHIP: 'live' });
    expect(await submit(e)).toBe(0);
    expect(e.w.machine().result).toEqual({ files: ALL, made: ALL.slice(1), linesSet: FIRST_RUN_LINES - 2 });
    expect(e.value(REORDER, 'COSIGN_ALLOWLIST')).toBe(key);
    expect(e.value(REORDER, 'AGENT_STATUS_CHIP')).toBe('live');
    expect(e.value(REORDER, 'SUPPLIER_PKH')).toBe(e.w.keys.registry.hashOf('reorder-supplier'));
    expect(e.value(REORDER, 'REORDER_SERVICE_PRIV_KEY_HEX')).toBe(e.w.keys.seedOf('reorder-service'));
    expect(mode(e.path(REORDER))).toBe(0o600);
    expect(e.value(REORDER, 'SERVICE_AUTH_HEADER')).toMatch(/^Bearer [0-9a-f]{64}$/);
  });

  it('keeps a token that the file holds, whatever its form', async () => {
    const e = await envWorld();
    seedFile(e, SERVICE, { SERVICE_AUTH_HEADER: 'Bearer chosen by the operator' });
    expect(await submit(e)).toBe(0);
    expect(e.value(SERVICE, 'SERVICE_AUTH_HEADER')).toBe('Bearer chosen by the operator');
    expect(e.value(REORDER, 'SERVICE_AUTH_HEADER')).toMatch(/^Bearer [0-9a-f]{64}$/);
  });

  const CASES: ReadonlyArray<readonly [label: string, file: string, name: string, value: string]> = [
    ['a secret line', REORDER, 'SUPPLIER_PRIV_KEY_HEX', other('secret', 64)],
    ['a key hash line', REORDER, 'REORDER_SERVICE_PKH', other('pkh', 56)],
    ['a public key line', RUNTIMES[0]!, 'SUPPLIER_PUB_KEY_HEX', other('pub', 64)],
    ['the service key of the Order Desk', SERVICE, 'ORDER_DESK_SERVICE_PRIV_KEY_HEX', other('service', 64)],
    ['a line with the key hash of a runtime in the service file', SERVICE, 'SMALL_SUPPLIER_PKH', other('small', 56)],
    ['the contact', REORDER, 'OPERATOR_CONTACT', 'someone-else@example.org'],
    ['the manifest', SERVICE, 'VECTOR_MODULE1_MANIFEST', 'https://raw.githubusercontent.com/Apex-Fusion/vector-agent-modules/0000000000000000000000000000000000000000/Module-1/deploy/identity/mainnet/manifest.json'],
    ['a mock origin', REORDER, 'MOCK_PUBLIC_BASE', 'https://mock.example.org'],
    ['the DID', SERVICE, 'AGENT_DID', `did:vector:${other('did', 64)}`],
    ['the id of the agent', RUNTIMES[2]!, 'AGENT_ID', other('id', 64)],
    ['the address of the identity script', REORDER, 'IDENTITY_ADDRESS', 'addr1qother'],
  ];
  for (const [label, file, name, value] of CASES) {
    it(`stops at ${label} that holds another value: it names the file and the line, shows no value, and writes no file`, async () => {
      const e = await envWorld();
      seedFile(e, file, { [name]: value });
      const before = e.text(file);
      expect(await submit(e)).toBe(2);
      const errors = e.w.screen.errorText;
      expect(errors).toContain(file);
      expect(errors).toContain(name);
      expect(errors).toContain('never overwrites');
      expect(`${errors}\n${e.w.allText()}`).not.toContain(value);
      expect(e.text(file)).toBe(before);
      for (const made of ALL.filter((one) => one !== file)) expect(existsSync(e.path(made)), made).toBe(false);
      expect(readdirSync(e.path('order-desk')).sort()).toEqual([...(file.startsWith('order-desk') ? [file.split('/')[1]!] : []), '.env.order-desk-runtime.example', '.env.order-desk.example'].sort());
    });
  }

  it('refuses a placeholder that the example holds, in a file that was copied by hand: it counts as another value, and every such line is named', async () => {
    const e = await envWorld();
    copyFileSync(join(SERVER, EXAMPLE_OF(REORDER)), e.path(REORDER));
    chmodSync(e.path(REORDER), 0o600);
    expect(await submit(e)).toBe(2);
    for (const name of ['OPERATOR_CONTACT', 'MOCK_PUBLIC_BASE', 'MOCK_MTLS_BASE', 'VECTOR_MODULE1_MANIFEST']) expect(e.w.screen.errorText, name).toContain(name);
    expect(existsSync(e.path(SERVICE))).toBe(false);
  });

  it('refuses a file with another mode than 600 and a path that is no file, and a file that has no line that the task manages', async () => {
    const e = await envWorld();
    seedFile(e, SERVICE, {}, 0o640);
    expect(await submit(e)).toBe(2);
    expect(e.w.screen.errorText).toContain(SERVICE);
    expect(e.w.screen.errorText).toContain('mode 640');
    chmodSync(e.path(SERVICE), 0o600);
    mkdirSync(e.path(RUNTIMES[0]!));
    e.w.screen.errors.length = 0;
    expect(await submit(e)).toBe(2);
    expect(e.w.screen.errorText).toContain(RUNTIMES[0]);
    expect(e.w.screen.errorText).toContain('not a regular file');
    rmSync(e.path(RUNTIMES[0]!), { recursive: true });
    const lines = readFileSync(join(SERVER, EXAMPLE_OF(REORDER)), 'utf8').split('\n').filter((line) => !line.startsWith('STOCK_READER_DID='));
    writeFileSync(e.path(REORDER), lines.join('\n'), { mode: 0o600 });
    e.w.screen.errors.length = 0;
    expect(await submit(e)).toBe(2);
    expect(e.w.screen.errorText).toContain('has no line STOCK_READER_DID');
    // The same file with its line: the run goes on.
    seedFile(e, REORDER);
    expect(await submit(e)).toBe(0);
  });

  it('stops for two equal keys: the registry refuses them, and no file is made', async () => {
    const e = await envWorld();
    writeFileSync(join(e.w.keys.root, USE_CASE, 'reorder-delegation-2.seed'), `${e.w.keys.seedOf('reorder-delegation-1')}\n`, { mode: 0o600 });
    expect(await submit(e)).toBe(2);
    expect(e.w.screen.errorText).toContain('reorder-delegation');
    for (const file of ALL) expect(existsSync(e.path(file)), file).toBe(false);
  });
});

describe('the preconditions', () => {
  it('stops with exit 2 and names a missing example, a missing folder, a missing record, no contact and no commit, and it writes no file', async () => {
    const cases: ReadonlyArray<readonly [string, WorldOptions, string]> = [
      ['an example that is missing', { examples: false }, '.env.reorder-agent.example'],
      ['a record that is missing', { records: false }, 'records.reorder-agent'],
      ['no contact', { env: { OPERATOR_CONTACT: undefined } }, 'OPERATOR_CONTACT'],
      ['no commit', { env: { OPERATOR_MODULE1_COMMIT: undefined } }, 'OPERATOR_MODULE1_COMMIT'],
    ];
    for (const [label, options, name] of cases) {
      const e = await envWorld(options);
      expect(await submit(e), label).toBe(2);
      expect(e.w.screen.errorText, label).toContain(name);
      for (const file of ALL) expect(existsSync(e.path(file)), `${label}: ${file}`).toBe(false);
    }
    const e = await envWorld();
    rmSync(e.path('order-desk'), { recursive: true });
    expect(await submit(e)).toBe(2);
    expect(e.w.screen.errorText).toContain('order-desk: the folder of the agent does not exist');
    expect(existsSync(e.path(REORDER))).toBe(false);
  });

  it('refuses one missing record of three before any file is written, and names it', async () => {
    const e = await envWorld({ records: false });
    putRecords(e.w, ['reorder-agent', 'stock-reader']);
    expect(await submit(e)).toBe(2);
    expect(e.w.screen.errorText).toContain('records.order-desk');
    expect(e.w.screen.errorText).not.toContain('records.stock-reader');
    for (const file of ALL) expect(existsSync(e.path(file)), file).toBe(false);
  });

  it('refuses a contact that cannot be written into an env file, and names the line and not the contact', async () => {
    const bad = 'role"quote@example.org';
    const e = await envWorld({ env: { OPERATOR_CONTACT: bad } });
    expect(await submit(e)).toBe(2);
    expect(e.w.screen.errorText).toContain('OPERATOR_CONTACT');
    expect(`${e.w.screen.errorText}${e.w.allText()}`).not.toContain(bad);
    for (const file of ALL) expect(existsSync(e.path(file)), file).toBe(false);
  });

  it('refuses a placeholder in a value that the task would write, before any write: the check after the plan', async () => {
    const e = await envWorld({ env: { OPERATOR_CONTACT: '<role address of the operator>' } });
    expect(await submit(e)).toBe(2);
    expect(e.w.screen.errorText).toContain('OPERATOR_CONTACT');
    expect(e.w.screen.errorText).toContain('placeholder');
    for (const file of ALL) expect(existsSync(e.path(file)), file).toBe(false);
  });

  it('writes no file without the approval of the session, and writes the files with it', async () => {
    const e = await envWorld({ go: false });
    expect(await submit(e)).toBe(2);
    for (const file of ALL) expect(existsSync(e.path(file)), file).toBe(false);
    e.w.writeGo({ tasks: ['env'] });
    expect(await submit(e)).toBe(0);
    for (const file of ALL) expect(existsSync(e.path(file)), file).toBe(true);
    e.w.writeGo({ tasks: ['fund'] });
    seedFile(e, SERVICE, { OPERATOR_CONTACT: 'someone-else@example.org' });
    expect(await submit(e)).toBe(2);
  });
});

describe('a dry run', () => {
  it('writes nothing, shows the files that it would make and the names and the lengths of the lines that it would set, and shows no value', async () => {
    const e = await envWorld({ go: false });
    expect(await dry(e)).toBe(0);
    expect(e.w.machine()).toMatchObject({ task: 'env', mode: 'dry', outcome: 'dry', exit: 0 });
    for (const file of ALL) expect(existsSync(e.path(file)), file).toBe(false);
    expect(readdirSync(e.path('reorder-agent'))).toEqual(['.env.reorder-agent.example']);
    const lines = e.w.screen.lines;
    for (const file of ALL) expect(lines).toContain(`${file}: would be made from the example`);
    const address = e.w.keys.registry.addressOf('reorder-supplier').length;
    expect(lines).toContain('  would set SUPPLIER_PRIV_KEY_HEX (64 characters)');
    expect(lines).toContain('  would set SUPPLIER_PKH (56 characters)');
    expect(lines).toContain(`  would set SUPPLIER_ADDRESS (${address} characters)`);
    expect(lines).toContain('  would set SERVICE_AUTH_HEADER (71 characters)');
    expect(lines).toContain(`  would set OPERATOR_CONTACT (${CONTACT.length} characters)`);
    expect(lines.filter((line) => line.includes('would set')).length).toBe(FIRST_RUN_LINES);
    expect(lines.some((line) => line.includes('ADVERT_REF'))).toBe(false);
    for (const secret of seedsOf(e)) expect(e.w.allText()).not.toContain(secret);
    expect(e.w.machine().result).toEqual({ files: ALL, made: ALL, linesSet: FIRST_RUN_LINES });
  });

  it('shows what it would set in a file that exists, and leaves the file as it is', async () => {
    const e = await envWorld({ go: false });
    seedFile(e, SERVICE, { OPERATOR_CONTACT: CONTACT });
    const before = e.text(SERVICE);
    expect(await dry(e)).toBe(0);
    const lines = e.w.screen.lines;
    expect(lines).toContain(`${SERVICE}: reconciled`);
    // The service file holds its contact already, so only the Reorder file (a new file) would get it. The service file has no DID yet, so both files would get one.
    expect(lines.filter((line) => line === '  would set OPERATOR_CONTACT (16 characters)')).toHaveLength(1);
    expect(lines.filter((line) => line === '  would set AGENT_DID (75 characters)')).toHaveLength(2);
    expect(e.text(SERVICE)).toBe(before);
  });

  it('reports every precondition that fails, in one run, and exits 2', async () => {
    const e = await envWorld({ go: false, records: false, env: { OPERATOR_CONTACT: undefined, OPERATOR_MODULE1_COMMIT: undefined } });
    rmSync(e.path('order-desk/.env.order-desk-runtime.example'));
    seedFile(e, REORDER, { REORDER_SERVICE_PKH: other('pkh', 56) });
    expect(await dry(e)).toBe(2);
    const errors = e.w.screen.errorText;
    for (const name of ['OPERATOR_CONTACT', 'OPERATOR_MODULE1_COMMIT', 'records.reorder-agent', 'records.order-desk', 'records.stock-reader', '.env.order-desk-runtime.example', 'REORDER_SERVICE_PKH']) {
      expect(errors, name).toContain(name);
    }
    for (const file of [SERVICE, ...RUNTIMES]) expect(existsSync(e.path(file)), file).toBe(false);
  });
});

describe('the checks of the files', () => {
  const filesOf = (e: EnvWorld, agent: AgentSpec, names: readonly string[]): Map<string, EnvFile> => new Map(names.map((name) => [name, EnvFile.open(e.path(`${agent.folder}/${name}`))]));
  const deskFiles = ['.env.order-desk', '.env.order-desk-small', '.env.order-desk-medium', '.env.order-desk-large'];
  const registryOf = (e: EnvWorld) => e.w.keys.registry;

  it('passes the files that the task wrote', async () => {
    const e = await envWorld();
    expect(await submit(e)).toBe(0);
    putAdverts(e.w);
    expect(await submit(e)).toBe(0);
    expect(checkEnvFiles(USE, reorder, filesOf(e, reorder, ['.env.reorder-agent']), registryOf(e))).toEqual([]);
    expect(checkEnvFiles(USE, desk, filesOf(e, desk, deskFiles), registryOf(e))).toEqual([]);
  });

  it('refuses a placeholder, a key hash or a public key or an address that is not the one of the secret in the file, a line of the wrong form, and an id that is not the id of the DID', async () => {
    const e = await envWorld();
    expect(await submit(e)).toBe(0);
    const mutate = (agent: AgentSpec, names: readonly string[], file: string, edits: Record<string, string>): string[] => {
      const files = filesOf(e, agent, names);
      for (const [name, value] of Object.entries(edits)) files.get(file)!.set(name, value);
      return checkEnvFiles(USE, agent, files, registryOf(e));
    };
    const reorderNames = ['.env.reorder-agent'];
    const table: ReadonlyArray<readonly [string, string[], string]> = [
      ['a placeholder', mutate(reorder, reorderNames, '.env.reorder-agent', { AGENT_STATUS_SINCE: '<date>' }), 'AGENT_STATUS_SINCE'],
      ['a key hash that is not the hash of its key', mutate(reorder, reorderNames, '.env.reorder-agent', { REORDER_SERVICE_PKH: other('hash', 56) }), 'REORDER_SERVICE_PKH'],
      ['a public key that is not the key', mutate(reorder, reorderNames, '.env.reorder-agent', { SUPPLIER_PUB_KEY_HEX: other('pub', 64) }), 'SUPPLIER_PUB_KEY_HEX'],
      ['an address that is not the address of the key', mutate(reorder, reorderNames, '.env.reorder-agent', { SUPPLIER_ADDRESS: 'addr1notmine' }), 'SUPPLIER_ADDRESS'],
      ['a key hash of 55 characters', mutate(reorder, reorderNames, '.env.reorder-agent', { SUPPLIER_PKH: other('hash', 55) }), 'SUPPLIER_PKH'],
      ['a secret of 63 characters', mutate(desk, deskFiles, '.env.order-desk', { ORDER_DESK_SERVICE_PRIV_KEY_HEX: other('secret', 63) }), 'ORDER_DESK_SERVICE_PRIV_KEY_HEX'],
      ['a secret in upper case', mutate(desk, deskFiles, '.env.order-desk-small', { SUPPLIER_PRIV_KEY_HEX: e.w.keys.seedOf('order-small-supplier').toUpperCase() }), 'SUPPLIER_PRIV_KEY_HEX'],
      ['an empty key line', mutate(desk, deskFiles, '.env.order-desk-large', { SUPPLIER_PKH: '' }), 'SUPPLIER_PKH'],
      ['an id that is not the id of the DID', mutate(desk, deskFiles, '.env.order-desk-medium', { AGENT_ID: other('id', 64) }), 'AGENT_ID'],
      ['a DID of the wrong form', mutate(desk, deskFiles, '.env.order-desk', { AGENT_DID: 'did:vector:short' }), 'AGENT_DID'],
      ['a reference of an advert of the wrong form', mutate(desk, deskFiles, '.env.order-desk-small', { ADVERT_REF: 'not-a-reference' }), 'ADVERT_REF'],
    ];
    for (const [label, problems, name] of table) {
      expect(problems.length, label).toBeGreaterThan(0);
      expect(problems.join('\n'), label).toContain(name);
      for (const secret of seedsOf(e)) expect(problems.join('\n'), label).not.toContain(secret);
    }
  });

  it('refuses two keys that are one key, and a secret that stands in another line or in another file, and names the key and not the secret', async () => {
    const e = await envWorld();
    expect(await submit(e)).toBe(0);
    const run = (agent: AgentSpec, names: readonly string[], change: (files: Map<string, EnvFile>) => void): string => {
      const files = filesOf(e, agent, names);
      change(files);
      const problems = checkEnvFiles(USE, agent, files, registryOf(e)).join('\n');
      for (const secret of seedsOf(e)) expect(problems).not.toContain(secret);
      return problems;
    };
    const reorderNames = ['.env.reorder-agent'];
    expect(run(reorder, reorderNames, (files) => { files.get('.env.reorder-agent')!.set('REORDER_DELEGATION_2_PRIV_KEY_HEX', e.w.keys.seedOf('reorder-delegation-1')); })).toContain('hold one key');
    expect(run(desk, deskFiles, (files) => { files.get('.env.order-desk-small')!.set('SUPPLIER_PKH', e.w.keys.registry.hashOf('order-medium-supplier')); })).toContain('have one key hash');
    // A supplier secret in the service file, in a line that is no key line, and in a public line of the key.
    expect(run(desk, deskFiles, (files) => { files.get('.env.order-desk')!.set('LLM_MODEL_ALLOWLIST', e.w.keys.seedOf('order-small-supplier')); })).toContain('the secret of the key order-small-supplier stands in the line LLM_MODEL_ALLOWLIST');
    expect(run(desk, deskFiles, (files) => { files.get('.env.order-desk')!.set('SMALL_SUPPLIER_PUB_KEY_HEX', e.w.keys.seedOf('order-small-supplier')); })).toContain('the secret of the key order-small-supplier stands in the line SMALL_SUPPLIER_PUB_KEY_HEX');
    // The service secret in a runtime file, and the secret of the run key in any line.
    expect(run(desk, deskFiles, (files) => { files.get('.env.order-desk-large')!.set('AGENT_ID', e.w.keys.seedOf('order-desk-service')); })).toContain('the secret of the key order-desk-service stands in the line AGENT_ID');
    expect(run(reorder, reorderNames, (files) => { files.get('.env.reorder-agent')!.set('LLM_MODEL_ALLOWLIST', e.w.keys.seedOf('run')); })).toContain('the secret of the key run stands in the line LLM_MODEL_ALLOWLIST');
    // A secret of one agent in a file of another agent.
    expect(run(desk, deskFiles, (files) => { files.get('.env.order-desk')!.set('LLM_MODEL_ALLOWLIST', e.w.keys.seedOf('reorder-service')); })).toContain('the secret of the key reorder-service stands in the line LLM_MODEL_ALLOWLIST');
    expect(run(reorder, reorderNames, () => undefined)).toBe('');
  });

  it('refuses a data file that puts the supplier key into a file that only a service reads, and a service key into a file that only a runtime reads', async () => {
    const moved = (key: string, line: string, file: string): Partial<UseCase> => ({
      agents: USE.agents.map((agent) => (agent.id !== 'order-desk' ? agent : {
        ...agent, keys: agent.keys.map((entry) => (entry.key !== key ? entry : { ...entry, lines: entry.lines.map((one) => (one.name === line && one.of === 'secret' ? { ...one, file } : one)) })),
      })),
    });
    const supplier = await envWorld({ use: moved('order-small-supplier', 'SUPPLIER_PRIV_KEY_HEX', '.env.order-desk') });
    expect(await submit(supplier)).toBe(2);
    expect(supplier.w.screen.errorText).toContain('the supplier key goes into the file of a runtime');
    const service = await envWorld({ use: moved('order-desk-service', 'ORDER_DESK_SERVICE_PRIV_KEY_HEX', '.env.order-desk-small') });
    expect(await submit(service)).toBe(2);
    expect(service.w.screen.errorText).toContain('a key of the service goes into the service file');
    for (const file of ALL) {
      expect(existsSync(supplier.path(file)), file).toBe(false);
      expect(existsSync(service.path(file)), file).toBe(false);
    }
  });
});

describe('what the task shows', () => {
  it('prints no seed, no token and no value of a line: no stream and no file of the state holds one, and each set line has its name and its length', async () => {
    const e = await envWorld();
    expect(await dry(e)).toBe(0);
    expect(await submit(e)).toBe(0);
    putAdverts(e.w);
    expect(await submit(e)).toBe(0);
    const screen = [...e.w.screen.lines, ...e.w.screen.errors].join('\n');
    for (const file of ALL) {
      for (const name of EnvFile.open(e.path(file)).names()) {
        const value = e.value(file, name)!;
        if (value.length >= 16) expect(screen, `${file}: ${name}`).not.toContain(value);
      }
    }
    expect(screen).not.toContain(CONTACT);
    expect(e.w.screen.lines).toContain('  set SERVICE_AUTH_HEADER (71 characters)');
    expect(e.w.screen.lines).toContain('  set ADVERT_REF (66 characters)');
    // The status of the runner shows the key hash of each wallet, which is public. It never shows a seed or a token.
    expect(await e.w.run(task, 'status')).toBe(0);
    for (const secret of [...seedsOf(e), ...tokensOf(e)]) expect(e.w.allText()).not.toContain(secret);
    expect(e.w.allText()).not.toContain(CONTACT);
  });

  it('shows in status the mode of each file and the names of the managed lines that are empty, and no value', async () => {
    const e = await envWorld({ go: false });
    expect(await e.w.run(task, 'status')).toBe(0);
    for (const file of ALL) expect(e.w.screen.lines).toContain(`env file ${file}: does not exist`);
    e.w.writeGo({ tasks: ['env'] });
    expect(await submit(e)).toBe(0);
    e.w.screen.lines.length = 0;
    expect(await e.w.run(task, 'status')).toBe(0);
    expect(e.w.screen.lines).toContain(`env file ${REORDER}: mode 600, 23 of 24 managed lines set; empty: ADVERT_REF`);
    expect(e.w.screen.lines).toContain(`env file ${SERVICE}: mode 600, 15 of 15 managed lines set`);
    expect(e.w.screen.lines).toContain(`env file ${RUNTIMES[0]}: mode 600, 5 of 6 managed lines set; empty: ADVERT_REF`);
    putAdverts(e.w);
    expect(await submit(e)).toBe(0);
    e.w.screen.lines.length = 0;
    expect(await e.w.run(task, 'status')).toBe(0);
    expect(e.w.screen.lines).toContain(`env file ${REORDER}: mode 600, 24 of 24 managed lines set`);
    for (const secret of seedsOf(e)) expect(e.w.allText()).not.toContain(secret);
  });
});

describe('the definition of the task', () => {
  const flags = { has: () => false, value: () => undefined };

  it('names the keys that have env lines, the flag --replace-advert, the two steps, the chain for the identity address and the approval of a submit run', () => {
    expect(task.name).toBe('env');
    expect([...task.needs.keys(USE, flags)].sort()).toEqual([
      'order-desk-service', 'order-large-supplier', 'order-medium-supplier', 'order-small-supplier', 'reorder-delegation-1', 'reorder-delegation-2', 'reorder-service', 'reorder-supplier',
      'stock-reader-auth', 'stock-reader-delegation',
    ]);
    expect(task.needs).toMatchObject({ chain: true, hosted: [], approval: 'submit' });
    expect(task.flags).toEqual(['replace-advert']);
    expect(task.valued).toEqual([]);
    expect(task.steps(USE, flags)).toEqual(['reorder-agent', 'order-desk']);
  });

  it('has nothing to take back', async () => {
    const e = await envWorld();
    expect(await e.w.run(task, 'cleanup')).toBe(0);
    expect(e.w.machine()).toMatchObject({ command: 'cleanup', outcome: 'done', exit: 0 });
    for (const file of ALL) expect(existsSync(e.path(file)), file).toBe(false);
  });
});
