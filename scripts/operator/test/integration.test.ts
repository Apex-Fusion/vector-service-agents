// scripts/operator/test/integration.test.ts - the tests of the operator pack that read more than one place: the list of the tasks, the files of the pack, the README, the settings, the root scripts, the
// example env files and the guide. A test of one task stays in the file of the task. Each check is a function that returns its problems. One test shows that the real files have none, and other
// tests show that a copy with one fault has that problem and that a harmless change has none. No test uses the network or a clock.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CLAIM_STAKE_LOVELACE, CLAIM_WINDOW_MS, RUN_APPROVAL_VALIDITY_MS } from '../lib/claim-constants.ts';
import type { TaskDefinition } from '../lib/contract.ts';
import { loadTask } from '../lib/load.ts';
import { TASK_NAMES } from '../tasks/names.ts';
import data from '../usecases/inventory-reorder.ts';

const PACK = fileURLToPath(new URL('../', import.meta.url));
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const readPack = (path: string): string => readFileSync(join(PACK, path), 'utf8');
const readRoot = (path: string): string => readFileSync(join(ROOT, path), 'utf8');
const HOUR_MS = 3_600_000;
const UNIT = 1_000_000n;

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

/**
 * What is wrong with the table of the tasks of a README, held to the definitions of the tasks: one row for each task, in the order of the list, no row for a name that is no task, the flags of the task
 * in its row and no other flag but the global ones, and the word about the approval that the task has (a task whose `--submit` needs the approval file says so, and the others say that they need none).
 */
function taskTableProblems(readme: string, definitions: ReadonlyMap<string, Pick<TaskDefinition, 'flags' | 'valued' | 'needs'>>): string[] {
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
    for (const flag of own) if (!shown.includes(flag)) problems.push(`the row of ${row.name} lacks the flag --${flag}`);
    for (const flag of shown) if (!own.includes(flag) && !GLOBAL_FLAGS.includes(flag)) problems.push(`the row of ${row.name} names --${flag}, which is no flag of the task`);
    const submit = (row.cells[COLUMNS.submit] ?? '').toLowerCase();
    const needs = definition.needs.approval === 'submit';
    if (needs && !submit.includes('needs the approval')) problems.push(`the row of ${row.name} does not say that --submit needs the approval, and the task needs it`);
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
    expect(taskTableProblems(lines.filter((line) => !isRow(line, 'keys')).join('\n'), definitions)).toEqual(['the table has no row for the task keys']);
    const ghost = `| \`ghost\` | Does nothing. | none | Needs no approval. | Nothing. |`;
    expect(taskTableProblems(lines.flatMap((line) => (isRow(line, 'keys') ? [line, ghost] : [line])).join('\n'), definitions)).toEqual(['the row ghost is no task']);
    expect(taskTableProblems(change('fund', (line) => line.split('--member').join('')), definitions)).toEqual(['the row of fund lacks the flag --member']);
    expect(taskTableProblems(change('keys', (line) => `${line.slice(0, line.lastIndexOf('|', line.length - 2))}| --bogus |`), definitions)).toEqual(['the row of keys names --bogus, which is no flag of the task']);
    expect(taskTableProblems(change('keys', (line) => line.split('Needs the approval').join('Needs no approval')), definitions)).toEqual(['the row of keys does not say that --submit needs the approval, and the task needs it', 'the row of keys says that the task needs no approval, and it needs it']);
    expect(taskTableProblems(change('results', (line) => line.split('Needs no approval').join('Reads the files')), definitions)).toEqual(['the row of results does not say that the task needs no approval, and it needs none']);
    const swapped = lines.map((line) => (isRow(line, 'keys') ? lines.find((other) => isRow(other, 'fund'))! : isRow(line, 'fund') ? lines.find((other) => isRow(other, 'keys'))! : line));
    expect(taskTableProblems(swapped.join('\n'), definitions)).toContain('the rows are not in the order of the list of the tasks');
  });

  it('accepts a harmless change: a global flag in a row, and an extra section after the table that holds a row of its own', () => {
    const lines = README.split('\n');
    const isRow = (line: string, name: string): boolean => line.startsWith(`| \`${name}\` |`);
    expect(taskTableProblems(lines.map((line) => (isRow(line, 'keys') ? line.split('Needs the approval').join('Needs the approval, as --all does') : line)).join('\n'), definitions)).toEqual([]);
    expect(taskTableProblems(`${README}\n## An extra section\n\n| \`ghost\` | not a task |\n`, definitions)).toEqual([]);
  });

  it('gives the claim of a run the stake and the window of the constants', () => {
    const claim = rowsOf(sectionOf(README, 'The tasks')).find((row) => row.name === 'claim')!;
    const text = claim.cells.join(' ');
    expect(text).toContain(`${CLAIM_STAKE_LOVELACE / UNIT} units`);
    expect(text).toContain(`${CLAIM_WINDOW_MS / HOUR_MS} hours`);
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

  it('names each file of the pack, and the code names the same file', () => {
    const files = sectionOf(README, 'The files');
    const code = ['lib', 'tasks'].flatMap((folder) => readdirSync(join(PACK, folder)).filter((file) => file.endsWith('.ts')).map((file) => readPack(`${folder}/${file}`))).join('\n');
    for (const name of ['GO.json', 'keys-public.json', 'facts.json', 'running-images.json', 'seen-services.json', 'run.lock', 'attestation-documents', 'exposure.']) {
      expect(files, `the README names ${name}`).toContain(name);
      expect(code, `the code names ${name}`).toContain(name);
    }
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

/** The example that each env file of the data is made from. The three runtime files of the Order Desk share one example. */
const EXAMPLE_OF: Readonly<Record<string, string>> = {
  '.env.reorder-agent': '.env.reorder-agent.example',
  '.env.order-desk': '.env.order-desk.example',
  '.env.order-desk-small': '.env.order-desk-runtime.example',
  '.env.order-desk-medium': '.env.order-desk-runtime.example',
  '.env.order-desk-large': '.env.order-desk-runtime.example',
};
const exampleNames = (file: string): Set<string> => new Set(readRoot(`deploy/server/${EXAMPLE_OF[file]!}`).split('\n').flatMap((line) => {
  const name = /^([A-Z][A-Z0-9_]*)=/.exec(line)?.[1];
  return name === undefined ? [] : [name];
}));

/** The names that the source of the task env writes besides the key lines of the data: the lines of the layout of a file, and the two names that it keeps in constants. */
function fixedNamesOf(source: string): string[] {
  return [
    ...[...source.matchAll(/\{ name: '([A-Z][A-Z0-9_]*)', source:/g)].map((hit) => hit[1]!),
    ...[...source.matchAll(/^const (?:MANIFEST|ADVERT)_LINE = '([A-Z][A-Z0-9_]*)';$/gm)].map((hit) => hit[1]!),
  ];
}

describe('the env names of the task env', () => {
  const fixed = fixedNamesOf(readPack('tasks/env.ts'));
  it('reads the names that the source writes: the token, the contact, the DID, the two mock origins, the identity address, the manifest, the agent id and the advert reference', () => {
    expect([...fixed].sort()).toEqual(['ADVERT_REF', 'AGENT_DID', 'AGENT_ID', 'IDENTITY_ADDRESS', 'MOCK_MTLS_BASE', 'MOCK_PUBLIC_BASE', 'OPERATOR_CONTACT', 'SERVICE_AUTH_HEADER', 'VECTOR_MODULE1_MANIFEST']);
  });
  it('writes only lines that the example of its file holds: the lines of a service file in the example of the service, the agent id and the advert reference in the example of each runtime file', () => {
    for (const agent of data.agents) {
      const service = exampleNames(agent.serviceEnvFile);
      const own = fixed.filter((name) => name !== 'AGENT_ID' && name !== 'ADVERT_REF');
      const subagents = data.subagents.filter((sub) => sub.parent === agent.id).map((sub) => `${sub.id.toUpperCase().split('-').join('_')}_DID`);
      for (const name of [...own, ...subagents]) expect(service.has(name), `${name} is a line of the example of ${agent.serviceEnvFile}`).toBe(true);
      for (const advert of agent.adverts) for (const name of ['AGENT_ID', 'ADVERT_REF']) expect(exampleNames(advert.runtimeEnvFile).has(name), `${name} is a line of the example of ${advert.runtimeEnvFile}`).toBe(true);
    }
  });
  it('refuses a name that an example lacks', () => {
    const service = exampleNames(data.agents[0]!.serviceEnvFile);
    expect(['SERVICE_AUTH_HEADER', 'NOT_A_LINE_OF_THE_EXAMPLE'].filter((name) => !service.has(name))).toEqual(['NOT_A_LINE_OF_THE_EXAMPLE']);
  });
});

// ---- the guide ----

// The guide of use case 1 is one section of docs/HIRE.md. It is checked as soon as it is there, and until then the checks are skipped.
const GUIDE = readRoot('docs/HIRE.md');
const GUIDE_HEADING = '### Use case 1 (inventory reorder): the Reorder Agent and the Order Desk';
const guideText = sectionUnder(GUIDE, GUIDE_HEADING);

describe.skipIf(guideText === '')('the guide of use case 1 in docs/HIRE.md', () => {
  it('says four hours for the approval, as the constant says', () => {
    expect(guideText).toMatch(new RegExp(`<valid until>[^.]*\\b${RUN_APPROVAL_VALIDITY_MS / HOUR_MS} hours\\b`));
  });
  it('says units, and never the name of the ledger unit, which only section 3 of the guide holds', () => {
    expect(guideText).toMatch(/\bunits\b/);
    expect(guideText).not.toMatch(new RegExp(['AP', '3X'].join(''), 'i'));
  });
});
