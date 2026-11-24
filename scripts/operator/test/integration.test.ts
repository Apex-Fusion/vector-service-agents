// scripts/operator/test/integration.test.ts - the tests of the operator pack that read more than one place: the list of the tasks, the files of the pack, the README, the settings, the root scripts, the
// example env files and the guide. A test of one task stays in the file of the task. Each check is a function that returns its problems. One test shows that the real files have none, and other
// tests show that a copy with one fault has that problem and that a harmless change has none. No test uses the network or a clock.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { iso } from '../../checks/lib/format.ts';
import { CLAIM_STAKE_LOVELACE, CLAIM_WINDOW_MS, RUN_APPROVAL_VALIDITY_MS } from '../lib/claim-constants.ts';
import type { AgentSpec, TaskDefinition, UseCase } from '../lib/contract.ts';
import { FactsFile } from '../lib/facts.ts';
import { loadTask } from '../lib/load.ts';
import { publicManifestFile } from '../lib/registry.ts';
import { TASK_NAMES } from '../tasks/names.ts';
import bids from '../usecases/bid-evaluation.ts';
import data from '../usecases/inventory-reorder.ts';
import { USE_CASE_NAMES } from '../usecases/names.ts';
import prior from '../usecases/prior-authorization.ts';
import { hashOf, NOW, taskWorld } from './support/task-world.ts';

const PACK = fileURLToPath(new URL('../', import.meta.url));
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const readPack = (path: string): string => readFileSync(join(PACK, path), 'utf8');
const readRoot = (path: string): string => readFileSync(join(ROOT, path), 'utf8');
const HOUR_MS = 3_600_000;
const UNIT = 1_000_000n;
const CASES = [data, prior, bids] as const;

/** The flags that every task has: the runner reads them, and a task never lists them. */
const GLOBAL_FLAGS: readonly string[] = ['submit', 'all', 'run', 'use-case', 'release'];

// ---- the README ----

const README = readPack('README.md');

/** The text under a heading of a markdown text, as the whole heading line is written (`## The tasks`): up to the next heading of the same level or above. Empty when the heading is not there. */
function sectionUnder(text: string, heading: string): string {
  const level = /^#+/.exec(heading)![0].length;
  const lines = text.split('\n');
  const start = lines.indexOf(heading);
  if (start < 0) return '';
  const end = lines.findIndex((line, index) => index > start && new RegExp(`^#{1,${level}} `).test(line));
  return lines.slice(start + 1, end < 0 ? undefined : end).join('\n');
}
const sectionOf = (text: string, name: string): string => sectionUnder(text, `## ${name}`);

/** The rows of a table of a section whose first cell is a name in back quotes: the cells of each row, by name, in the order of the rows. A name that stands in two rows is kept twice. */
function rowsOf(section: string): { name: string; cells: string[] }[] {
  return section.split('\n').flatMap((line) => {
    const cells = line.split('|').slice(1, -1).map((cell) => cell.trim());
    const name = /^`([^`]+)`$/.exec(cells[0] ?? '')?.[1];
    return line.startsWith('|') && name !== undefined ? [{ name, cells }] : [];
  });
}

/** The columns of the table of the tasks. */
const COLUMNS = { what: 1, flags: 2, submit: 3, writes: 4 } as const;
const flagsIn = (text: string): string[] => [...new Set([...text.matchAll(/--[a-z][a-z0-9-]*/g)].map((hit) => hit[0].slice(2)))];

/** The members of a task definition that the table of the README is held to. */
type TableDefinition = Pick<TaskDefinition, 'flags' | 'valued' | 'needs'>;

/**
 * What is wrong with the table of the tasks of a README, held to the definitions of the tasks: one row for each task, in the order of the list, no row for a name that is no task, the flags of the task
 * in its row (a flag that takes a value as `--x <what it takes>` and a flag that takes none as `--x`, both in the column of the flags) and no other flag but the global ones, and the word about the approval that
 * the task has (a task whose `--submit` needs the approval file says so, and the others say that they need none).
 */
function taskTableProblems(readme: string, definitions: ReadonlyMap<string, TableDefinition>): string[] {
  const problems: string[] = [];
  const rows = rowsOf(sectionOf(readme, 'The tasks'));
  const names = rows.map((row) => row.name);
  for (const name of TASK_NAMES) {
    const count = names.filter((found) => found === name).length;
    if (count === 0) problems.push(`the table has no row for the task ${name}`);
    if (count > 1) problems.push(`the table has ${count} rows for the task ${name}`);
  }
  for (const name of names) if (!TASK_NAMES.some((known) => known === name)) problems.push(`the row ${name} is no task`);
  if (names.every((name) => TASK_NAMES.some((known) => known === name)) && names.join(',') !== TASK_NAMES.filter((name) => names.includes(name)).join(',')) problems.push('the rows are not in the order of the list of the tasks');
  for (const row of rows) {
    const definition = definitions.get(row.name);
    if (definition === undefined) continue;
    const own = [...definition.flags, ...definition.valued];
    const shown = flagsIn(row.cells.join(' '));
    const listed = row.cells[COLUMNS.flags] ?? '';
    for (const flag of own) if (!shown.includes(flag)) problems.push(`the row of ${row.name} lacks the flag --${flag}`);
    for (const flag of shown) if (!own.includes(flag) && !GLOBAL_FLAGS.includes(flag)) problems.push(`the row of ${row.name} names --${flag}, which is no flag of the task`);
    for (const flag of definition.valued) if (shown.includes(flag) && !listed.includes(`--${flag} <`)) problems.push(`the row of ${row.name} does not show --${flag} with a value in the column of the flags, and the flag takes a value`);
    for (const flag of definition.flags) if (listed.includes(`--${flag} <`)) problems.push(`the row of ${row.name} shows --${flag} with a value in the column of the flags, and the flag takes none`);
    const submit = (row.cells[COLUMNS.submit] ?? '').toLowerCase();
    const needs = definition.needs.approval === 'submit';
    if (needs && !/\bneeds (?:the )?approval\b/.test(submit)) problems.push(`the row of ${row.name} does not say that --submit needs the approval, and the task needs it`);
    if (!needs && !submit.includes('needs no approval')) problems.push(`the row of ${row.name} does not say that the task needs no approval, and it needs none`);
    if (needs && submit.includes('needs no approval')) problems.push(`the row of ${row.name} says that the task needs no approval, and it needs it`);
  }
  return problems;
}

const definitions = new Map<string, TaskDefinition>();
for (const name of TASK_NAMES) definitions.set(name, await loadTask(name));

describe('the tasks, their files and their tests', () => {
  const taskFiles = readdirSync(join(PACK, 'tasks')).filter((file) => file.endsWith('.ts') && file !== 'names.ts').map((file) => file.slice(0, -3));
  const testFiles = readdirSync(join(PACK, 'test'));

  it('has for each name of TASK_NAMES a file tasks/<name>.ts with a default export of the shape of a task, the same name in the definition, and a test file', () => {
    expect(TASK_NAMES.length).toBe(new Set(TASK_NAMES).size);
    for (const name of TASK_NAMES) {
      expect(existsSync(join(PACK, 'tasks', `${name}.ts`)), `tasks/${name}.ts`).toBe(true);
      expect(definitions.get(name)?.name, `the name in tasks/${name}.ts`).toBe(name);
      expect(testFiles, `a test file of ${name}`).toContain(`${name}.test.ts`);
    }
  });

  /** The files of `tasks/` that no name of the list covers. */
  const outside = (files: readonly string[], names: readonly string[]): string[] => files.filter((file) => !names.includes(file));
  it('has no file in tasks/ that is not in TASK_NAMES, and a file that is not there is refused', () => {
    expect(outside(taskFiles, TASK_NAMES)).toEqual([]);
    expect(outside([...taskFiles, 'ghost'], TASK_NAMES)).toEqual(['ghost']);
    expect(outside([...taskFiles].reverse(), TASK_NAMES)).toEqual([]);
  });
});

describe('the README of the pack', () => {
  it('has its sections in order', () => {
    expect([...README.matchAll(/^## (.+)$/gm)].map((hit) => hit[1])).toEqual(['The command', 'The tasks', 'The order of the work', 'The files', 'The settings', 'What it never does']);
  });

  it('has one row for each task, with its flags and the word about the approval, and no row or flag that the code lacks', () => {
    expect(taskTableProblems(README, definitions)).toEqual([]);
  });

  it('refuses a table with a task left out, a task that is not there, a flag left out, a flag that the task does not have, a wrong word about the approval, and rows in another order', () => {
    const lines = README.split('\n');
    const isRow = (line: string, name: string): boolean => line.startsWith(`| \`${name}\` |`);
    const change = (name: string, edit: (line: string) => string): string => lines.map((line) => (isRow(line, name) ? edit(line) : line)).join('\n');
    expect(taskTableProblems(lines.filter((line) => !isRow(line, 'lifecycle')).join('\n'), definitions)).toEqual(['the table has no row for the task lifecycle']);
    const ghost = `| \`ghost\` | Does nothing. | none | Needs no approval. | Nothing. |`;
    expect(taskTableProblems(lines.flatMap((line) => (isRow(line, 'keys') ? [line, ghost] : [line])).join('\n'), definitions)).toEqual(['the row ghost is no task']);
    expect(taskTableProblems(change('fund', (line) => line.split('--member').join('')), definitions)).toEqual(['the row of fund lacks the flag --member']);
    expect(taskTableProblems(change('keys', (line) => `${line.slice(0, line.lastIndexOf('|', line.length - 2))}| --bogus |`), definitions)).toEqual(['the row of keys names --bogus, which is no flag of the task']);
    expect(taskTableProblems(change('keys', (line) => line.split('Needs the approval').join('Needs no approval')), definitions)).toEqual(['the row of keys does not say that --submit needs the approval, and the task needs it', 'the row of keys says that the task needs no approval, and it needs it']);
    expect(taskTableProblems(change('results', (line) => line.split('Needs no approval').join('Reads the files')), definitions)).toEqual(['the row of results does not say that the task needs no approval, and it needs none']);
    const swapped = lines.map((line) => (isRow(line, 'keys') ? lines.find((other) => isRow(other, 'fund'))! : isRow(line, 'fund') ? lines.find((other) => isRow(other, 'keys'))! : line));
    expect(taskTableProblems(swapped.join('\n'), definitions)).toContain('the rows are not in the order of the list of the tasks');
    // The kind of a flag: a flag that takes a value must show its value in the column of the flags, and a flag that takes none must not.
    const hold = definitions.get('hold')!;
    const claim = definitions.get('claim')!;
    expect(taskTableProblems(README, new Map<string, TableDefinition>([...definitions, ['hold', { ...hold, flags: [...hold.flags, 'days'], valued: hold.valued.filter((flag) => flag !== 'days') }]]))).toEqual(['the row of hold shows --days with a value in the column of the flags, and the flag takes none']);
    expect(taskTableProblems(README, new Map<string, TableDefinition>([...definitions, ['claim', { ...claim, flags: claim.flags.filter((flag) => flag !== 'trial'), valued: [...claim.valued, 'trial'] }]]))).toEqual(['the row of claim does not show --trial with a value in the column of the flags, and the flag takes a value']);
  });

  it('accepts a harmless change: a global flag in a row, and an extra section after the table that holds a row of its own', () => {
    const lines = README.split('\n');
    const isRow = (line: string, name: string): boolean => line.startsWith(`| \`${name}\` |`);
    expect(taskTableProblems(lines.map((line) => (isRow(line, 'keys') ? line.split('Needs the approval').join('Needs the approval, as --all does') : line)).join('\n'), definitions)).toEqual([]);
    expect(taskTableProblems(lines.map((line) => (isRow(line, 'hold') ? line.split('--days <n>').join('--days <number of days>') : line)).join('\n'), definitions)).toEqual([]);
    expect(taskTableProblems(`${README}\n## An extra section\n\n| \`ghost\` | not a task |\n`, definitions)).toEqual([]);
  });

  it('gives the claim of a run the stake and the window of the constants', () => {
    const claim = rowsOf(sectionOf(README, 'The tasks')).find((row) => row.name === 'claim')!;
    const text = claim.cells.join(' ');
    expect(text).toContain(`${CLAIM_STAKE_LOVELACE / UNIT} units`);
    expect(text).toContain(`${CLAIM_WINDOW_MS / HOUR_MS} hours`);
  });

  it('says that the pack never signs a transaction without an approval, and that the probe signs one request with two keys, also in a dry run', () => {
    expect(definitions.get('probe')!.needs.approval).toBe('never');
    expect(sectionOf(README, 'What it never does')).toContain('It never signs a transaction without an approval.');
    const probe = rowsOf(sectionOf(README, 'The tasks')).find((row) => row.name === 'probe')!;
    expect(probe.cells[COLUMNS.what]).toContain('in a dry run too');
    expect(probe.cells[COLUMNS.what]).toContain('it signs the request with two keys, the subject token with the service key of the agent and the proof with the delegate key. It signs no transaction.');
  });

  it('says what the machine line holds: its prefix, its seven members and its six outcomes, as the code writes them', () => {
    const output = readPack('lib/output.ts');
    const prefix = /const PREFIX = '([^']+)';/.exec(output)?.[1];
    expect(prefix).toBe('operator-result: ');
    const members = /export interface OperatorResultFields \{([^}]*)\}/.exec(output)?.[1].match(/readonly (\w+):/g)?.map((hit) => hit.slice(9, -1));
    expect(members).toEqual(['task', 'command', 'mode', 'outcome', 'exit', 'step', 'result']);
    const outcomes = /export type ResultOutcome = ([^;]+);/.exec(output)?.[1].match(/'(\w+)'/g)?.map((hit) => hit.slice(1, -1));
    expect(outcomes).toEqual(['dry', 'done', 'finished', 'wait', 'failed', 'stopped']);
    const command = sectionOf(README, 'The command');
    expect(command).toContain(prefix!.trim());
    for (const word of [...members!, ...outcomes!]) expect(command, word).toContain(`\`${word}\``);
  });

  it('names the exit codes 0 to 4 in the section of the command, one row each', () => {
    const rows = sectionOf(README, 'The command').split('\n').filter((line) => /^\| [0-4] \|/.test(line));
    expect(rows.map((row) => row.split('|')[1]!.trim())).toEqual(['0', '1', '2', '3', '4']);
  });

  it('names each task in the order of the work, and no name that is not a task or a flag', () => {
    const order = sectionOf(README, 'The order of the work');
    for (const name of TASK_NAMES) expect(order, name).toContain(`\`${name}\``);
    const named = [...order.matchAll(/`([a-z][a-z-]*)`/g)].map((hit) => hit[1]!).filter((word) => !TASK_NAMES.some((known) => known === word));
    for (const word of named) expect(['submit', 'all', 'run', 'cleanup', 'status', 'clean', 'failure'], word).toContain(word);
  });

  it('lists the case data, irreversible tags and sections of a fresh facts file', () => {
    const cases = rowsOf(README.split('\n## The command\n', 1)[0]!);
    const names = cases.map(({ name }) => name);
    expect(names).toEqual(CASES.map(({ name }) => name));
    expect(USE_CASE_NAMES.filter((name) => !names.includes(name))).toEqual([]);
    for (const { name, cells } of cases) {
      const file = `usecases/${name}.ts`;
      expect(cells[2]).toBe(`[\`${file}\`](${file})`);
      expect(existsSync(join(PACK, file))).toBe(true);
    }

    const files = sectionOf(README, 'The files').split('\n');
    const words = (text: string, quote: string): string[] => text.split(quote).filter((_, index) => index % 2 !== 0);
    const tags = /const TAGS:[^=]+=\s*\[([\s\S]*?)\]/.exec(readPack('lib/approval.ts'))?.[1];
    const tagRow = files.find((line) => line.startsWith('- Irreversible tags:'));
    expect(words(tags ?? '', "'").length).toBeGreaterThan(0);
    expect(words(tagRow ?? '', '`').sort()).toEqual(words(tags ?? '', "'").sort());
    const name = 'facts.json';
    const sections = files.find((line) => line.startsWith(`- \`${name}\` keeps`));
    const fields = Object.keys(FactsFile.open(join(PACK, 'test', name), { useCase: data.name, network: 'vector-mainnet' }).read());
    expect(words(sections ?? '', '`').slice(1).sort()).toEqual(fields.sort());
  });

  it('names each file of the pack, and the code names the same file', () => {
    const files = sectionOf(README, 'The files');
    const code = ['lib', 'tasks'].flatMap((folder) => readdirSync(join(PACK, folder)).filter((file) => file.endsWith('.ts')).map((file) => readPack(`${folder}/${file}`))).join('\n');
    for (const name of ['GO.json', 'facts.json', 'running-images.json', 'seen-services.json', 'run.lock', 'attestation-documents', 'exposure.']) {
      expect(files, `the README names ${name}`).toContain(name);
      expect(code, `the code names ${name}`).toContain(name);
    }
    const template = 'keys-public.<use case>.json';
    expect(files).toContain(`\`<keys>/${template}\``);
    for (const { name } of CASES) expect(publicManifestFile(name)).toBe(template.replace('<use case>', name));
    for (const part of ['.state.json', '.evidence.json']) {
      expect(files, part).toContain(part);
      expect(code, part).toContain(part);
    }
  });

  it('lists the settings that the code reads, and no other', () => {
    const settings = rowsOf(sectionOf(README, 'The settings')).map((row) => row.name);
    const names = (text: string, pattern: RegExp): string[] => [...text.matchAll(pattern)].map((hit) => hit[1]!);
    const read = new Set([
      ...names(readPack('lib/settings.ts'), /'((?:OPERATOR|VECTOR)_[A-Z0-9_]+)'/g),
      ...readdirSync(join(PACK, 'tasks')).flatMap((file) => names(readPack(`tasks/${file}`), /reader\.(?:url|text|whole)\(\s*'((?:OPERATOR|VECTOR)_[A-Z0-9_]+)'/g)),
    ]);
    expect(read.size).toBeGreaterThanOrEqual(18);
    expect([...new Set(settings)].sort()).toEqual([...read].sort());
    expect(settings.length).toBe(new Set(settings).size);
  });
});

// ---- the root scripts ----

/** The scripts of a package.json text. */
function scriptsOf(text: string): Record<string, string> {
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== 'object' || parsed === null || !('scripts' in parsed) || typeof parsed.scripts !== 'object' || parsed.scripts === null) throw new Error('package.json has no scripts');
  return Object.fromEntries(Object.entries(parsed.scripts).filter((pair): pair is [string, string] => typeof pair[1] === 'string'));
}

/** What is wrong with the root scripts: the test script must run the tests of the pack, and the typecheck script must check its types. */
function rootScriptProblems(scripts: Readonly<Record<string, string>>): string[] {
  const problems: string[] = [];
  if (!(scripts.test ?? '').includes('vitest run --config scripts/operator/vitest.config.ts')) problems.push('the root test script does not run the tests of the pack');
  if (!(scripts.typecheck ?? '').includes('tsc --noEmit -p scripts/operator/tsconfig.json')) problems.push('the root typecheck script does not check the types of the pack');
  return problems;
}

describe('the root scripts', () => {
  const scripts = scriptsOf(readRoot('package.json'));
  it('run the tests of the pack and check its types, with the files that they name', () => {
    expect(rootScriptProblems(scripts)).toEqual([]);
    expect(existsSync(join(PACK, 'vitest.config.ts'))).toBe(true);
    expect(existsSync(join(PACK, 'tsconfig.json'))).toBe(true);
  });
  it('refuse a root test script without the pack, a root typecheck without the pack, and accept the scripts with both', () => {
    expect(rootScriptProblems({ ...scripts, test: scripts.test!.split(' && vitest run --config scripts/operator/vitest.config.ts').join('') })).toEqual(['the root test script does not run the tests of the pack']);
    expect(rootScriptProblems({ ...scripts, typecheck: scripts.typecheck!.split(' && tsc --noEmit -p scripts/operator/tsconfig.json').join('') })).toEqual(['the root typecheck script does not check the types of the pack']);
    expect(rootScriptProblems({ test: 'vitest run --config scripts/operator/vitest.config.ts', typecheck: 'tsc --noEmit -p scripts/operator/tsconfig.json' })).toEqual([]);
  });
});

// ---- the env names of the task env ----

/** Use the real dry-run writer and the examples that the case deploys. */
async function previewEnv(use: UseCase, editExample: (text: string, agent: AgentSpec, service: boolean) => string = (text) => text) {
  const dir = mkdtempSync(join(tmpdir(), 'pack-env-preview-'));
  try {
    const labels = use.agents.flatMap((agent) => {
      const folder = join(dir, agent.folder);
      mkdirSync(folder);
      const service = agent.serviceEnvFile;
      const runtimes = [...new Set(agent.adverts.map((advert) => advert.runtimeEnvFile).filter((file) => file !== service))];
      const names = [agent.exampleEnvFile ?? `${service}.example`, ...(runtimes.length > 0 ? [`${service}-runtime.example`] : [])];
      for (const [index, name] of names.entries()) {
        writeFileSync(join(folder, name), editExample(readRoot(`deploy/server/${name}`), agent, index === 0));
      }
      return [service, ...runtimes].map((file) => `${agent.folder}/${file}`);
    });
    const w = await taskWorld({ use, keys: use.keys.map(({ name }) => name), shared: use.keys.filter(({ scope }) => scope === 'shared').map(({ name }) => name),
      env: { OPERATOR_USE_CASE: data.name, OPERATOR_AGENTS_DIR: dir, OPERATOR_CONTACT: 'fixture contact', OPERATOR_MODULE1_COMMIT: hashOf('manifest').slice(0, 40) } });
    mkdirSync(w.stateDir, { mode: 0o700 });
    const facts = FactsFile.open(join(w.stateDir, 'facts.json'), { useCase: use.name, network: 'vector-mainnet' });
    for (const { id } of [...use.agents, ...use.subagents]) {
      const hash = hashOf(id), tx = hashOf(`${id} registration`);
      facts.put('records', [id], { did: `did:vector:${hash}`, id: hash, tx, recordRef: `${tx}#0`, depositLovelace: '10000000', registeredAt: iso(NOW) });
    }
    for (const agent of use.agents) for (const { model, origin } of agent.adverts) {
      const tx = hashOf(`${agent.id} ${model} advert`);
      facts.put('adverts', [agent.id, model], { ref: `${tx}#0`, tx, detailUri: `${origin}/agent.json`, detailHash: hashOf(`${agent.id} ${model} manifest`), endpoint: origin, postedAt: iso(NOW) });
    }
    const exit = await w.run(definitions.get('env')!, 'run');
    for (const label of labels) expect(existsSync(join(dir, label))).toBe(false);
    return { exit, labels, result: w.machine().result, text: w.screen.text, errors: w.screen.errorText };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('the env examples', () => {
  it.each(CASES)('hold all managed lines for $name', async (use) => {
    // Extra lines can exist in an example without being managed by the task.
    const result = await previewEnv(use, (text, agent, service) => {
      if (!service) return text;
      const unmanaged = [...(agent.envManaged.mock ? [] : ['MOCK_PUBLIC_BASE', 'MOCK_MTLS_BASE']),
        ...(agent.envManaged.module1 ? [] : ['VECTOR_MODULE1_MANIFEST'])];
      const sentinel = unmanaged.filter((name) => !text.split('\n').some((line) => line.startsWith(`${name}=`)));
      return `${text.trimEnd()}\n${sentinel.map((name) => `${name}=`).join('\n')}\n`;
    });
    expect(result.exit, result.errors).toBe(0);
    expect(result.result).toMatchObject({ files: result.labels, made: result.labels });
    for (const agent of use.agents) {
      const label = `${agent.folder}/${agent.serviceEnvFile}: would be made from the example\n`;
      const start = result.text.indexOf(label);
      expect(start, label).toBeGreaterThanOrEqual(0);
      const lines = result.text.slice(start + label.length).split('\n');
      const end = lines.findIndex((line) => !line.startsWith('  would set '));
      const names = new Set(lines.slice(0, end < 0 ? undefined : end).flatMap((line) => /^  would set ([A-Z0-9_]+)/.exec(line)?.[1] ?? []));
      expect(names.has('MOCK_PUBLIC_BASE')).toBe(agent.envManaged.mock);
      expect(names.has('MOCK_MTLS_BASE')).toBe(agent.envManaged.mock);
      expect(names.has('VECTOR_MODULE1_MANIFEST')).toBe(agent.envManaged.module1);
    }
  });

  it('refuses an example that lacks a managed public key line', async () => {
    const agent = bids.agents.find(({ publicKeyLines }) => publicKeyLines.length > 0)!;
    const name = agent.publicKeyLines[0]!.lines[0]!.name;
    const result = await previewEnv(bids, (text) => text.split('\n').filter((line) => !line.startsWith(`${name}=`)).join('\n'));
    expect(result.exit).toBe(2);
    expect(result.errors).toContain(`has no line ${name}`);
  });
});

// ---- the guide ----

const GUIDE = readRoot('docs/HIRE.md');
const guides = [
  ['### Use case 1 (inventory reorder): the Reorder Agent and the Order Desk', 'valid until'],
  ['### Use case 2 (prior authorization): the Prior Authorization Agent and the Insurer Intake Agent', 'approval end'],
  ['### Use case 3 (supplier bid evaluation): the Sourcing Agent and the Bid Desks', 'valid until'],
] as const;

for (const [heading, deadline] of guides) {
  const guideText = sectionUnder(GUIDE, heading);
  describe.skipIf(guideText === '')(heading, () => {
    it('holds the approval window to the run constant', () => {
      const hours = RUN_APPROVAL_VALIDITY_MS / HOUR_MS;
      expect(guideText).toMatch(new RegExp(`<${deadline}>[^\\n]*\\b${hours}\\s+(?:hours\\b|\\*\\s*${HOUR_MS}\\b)`));
    });
    it('uses units outside its main key funding section', () => {
      expect(guideText).toMatch(/\bunits\b/);
      expect(guideText).not.toMatch(new RegExp(['AP', '3X'].join(''), 'i'));
    });
  });
}
