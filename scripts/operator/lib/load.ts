// scripts/operator/lib/load.ts - loads the file of a task or of a use case by its name.
// Both lists of names are closed (`tasks/names.ts`, `usecases/names.ts`). A name that is not in its list is refused before any path is made, and the path is made of the entry of the list and never of
// the text that the caller gave, so a name from the command line or the environment cannot reach another file. The file is imported when it is asked for (a dynamic import), so this module needs no
// task file and no data file at load time: a file that is not there is a LoadError and not a crash. Each refusal names the task or the use case, and never a path or a value.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { TASK_NAMES } from '../tasks/names.ts';
import { USE_CASE_NAMES } from '../usecases/names.ts';
import type { TaskDefinition, UseCase } from './contract.ts';
import { indexResultPolicy } from './result-policy.ts';

/** The folder of the pack: the folders `tasks` and `usecases` are below it. The loaders take another folder when a test gives one. */
export const PACK_URL: URL = new URL('../', import.meta.url);

export type LoadReason = 'name' | 'missing' | 'import' | 'shape' | 'mismatch';

/** A task or a use case that cannot be loaded. The run stops before it signs anything (exit 2). */
export class LoadError extends Error {
  readonly reason: LoadReason;
  constructor(reason: LoadReason, message: string) {
    super(message);
    this.name = 'LoadError';
    this.reason = reason;
  }
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isTextList = (value: unknown): boolean => Array.isArray(value) && value.every((item) => typeof item === 'string');
const isFunction = (value: unknown): boolean => typeof value === 'function';

/** The first rule that a value breaks as a task definition (the members of `TaskDefinition`), or null. A rule names a member and never a value. */
function taskProblem(value: unknown): string | null {
  if (!isObject(value)) return 'the default export is not an object';
  if (typeof value.name !== 'string') return 'name is not a text';
  if (typeof value.title !== 'string') return 'title is not a text';
  if (!isTextList(value.flags)) return 'flags is not a list of texts';
  if (!isTextList(value.valued)) return 'valued is not a list of texts';
  const needs = value.needs;
  if (!isObject(needs)) return 'needs is not an object';
  if (!isFunction(needs.keys)) return 'needs.keys is not a function';
  if (typeof needs.chain !== 'boolean') return 'needs.chain is not a boolean';
  if (!isTextList(needs.hosted)) return 'needs.hosted is not a list of texts';
  if (needs.approval !== 'submit' && needs.approval !== 'never') return 'needs.approval is neither submit nor never';
  for (const member of ['steps', 'parse', 'next', 'cleanup']) if (!isFunction(value[member])) return `${member} is not a function`;
  for (const member of ['status', 'result']) if (value[member] !== undefined && !isFunction(value[member])) return `${member} is neither missing nor a function`;
  return null;
}

const USE_CASE_LISTS = ['keys', 'organisations', 'agents', 'subagents', 'funding', 'attestations', 'runs', 'evidenceSteps', 'records'] as const satisfies readonly (keyof UseCase)[];
const USE_CASE_TEXTS = ['moduleManifestPath', 'runtimeCommit'] as const satisfies readonly (keyof UseCase)[];
const USE_CASE_OBJECTS_OR_NULL = ['compliance', 'lifecycle', 'tenantSeed'] as const satisfies readonly (keyof UseCase)[];
const USE_CASE_OBJECTS = ['tenantOrganisations'] as const satisfies readonly (keyof UseCase)[];
const MAX_SENTENCE = 200;
const MAX_NOT_COVERED_ITEMS = 8;

const isSentence = (value: unknown): boolean => typeof value === 'string' && value.length >= 1 && value.length <= MAX_SENTENCE;

/** The first rule that a value breaks as the section "Not covered" of a use case, or null: an object with a lead and 1 to 8 items, each a text of 1 to 200 characters. A rule names a member and never a value. */
function notCoveredProblem(value: unknown): string | null {
  if (!isObject(value)) return 'notCovered is not an object';
  if (!isSentence(value.lead)) return `notCovered has no lead of 1 to ${MAX_SENTENCE} characters`;
  const items = value.items;
  if (!Array.isArray(items) || items.length < 1 || items.length > MAX_NOT_COVERED_ITEMS) return `notCovered has no list of 1 to ${MAX_NOT_COVERED_ITEMS} items`;
  if (!items.every(isSentence)) return `an item of notCovered is not a text of 1 to ${MAX_SENTENCE} characters`;
  return null;
}

/** The first rule that a value breaks as the data of a use case (the members of `UseCase`), or null. A rule names a member and never a value. */
function useCaseProblem(value: unknown): string | null {
  if (!isObject(value)) return 'the default export is not an object';
  if (typeof value.name !== 'string') return 'name is not a text';
  if (typeof value.title !== 'string') return 'title is not a text';
  if (value.legacyOrganisationWriter !== undefined && value.legacyOrganisationWriter !== value.name) return 'legacyOrganisationWriter does not identify this use case';
  for (const member of USE_CASE_LISTS) if (!Array.isArray(value[member])) return `${member} is not a list`;
  for (const member of USE_CASE_TEXTS) if (typeof value[member] !== 'string') return `${member} is not a text`;
  const notCovered = notCoveredProblem(value.notCovered);
  if (notCovered !== null) return notCovered;
  for (const member of USE_CASE_OBJECTS_OR_NULL) if (value[member] !== null && !isObject(value[member])) return `${member} is neither an object nor null`;
  for (const member of USE_CASE_OBJECTS) if (!isObject(value[member])) return `${member} is not an object`;
  const policy = indexResultPolicy(value.results, value.runs, value.evidenceSteps as readonly unknown[]);
  return typeof policy === 'string' ? policy : null;
}

/** The entry of a closed list that equals `name`. A name that is not in the list is refused, and the refusal shows the list and not the name. */
function listed(kind: string, names: readonly string[], name: unknown): string {
  const entry = names.find((known) => known === name);
  if (entry === undefined) throw new LoadError('name', `the name is not the name of a ${kind}: the ${kind}s are ${names.join(', ')}`);
  return entry;
}

/** Imports the file `<folder>/<name>.ts` below `base` and gives its default export. A file that is not there, one that cannot be imported and one with no default export are refusals. */
async function importDefault(kind: string, folder: string, name: string, base: URL): Promise<unknown> {
  const folderUrl = new URL(base.href.endsWith('/') ? base.href : `${base.href}/`);
  const url = new URL(`${folder}/${name}.ts`, folderUrl);
  if (!existsSync(fileURLToPath(url))) throw new LoadError('missing', `the file of the ${kind} ${name} does not exist`);
  let loaded: unknown;
  // A dynamic import: the name of the file is chosen at run time from a closed list, and the files of the tasks and of the data need not exist when this module is built or tested.
  try { loaded = await import(/* @vite-ignore */ url.href); } catch (err) {
    // The message of an import error can name a path or hold a line of the file, so only the name of the error goes into the refusal.
    throw new LoadError('import', `the file of the ${kind} ${name} could not be loaded (${err instanceof Error ? err.name : 'an error'})`);
  }
  if (!isObject(loaded) || !('default' in loaded)) throw new LoadError('shape', `the file of the ${kind} ${name} has no default export`);
  return loaded.default;
}

/**
 * Loads the task of this name. The name must be in `TASK_NAMES`, the file `tasks/<name>.ts` must exist, its default export must have the shape of a `TaskDefinition`, and the `name` of the
 * definition must be the name of the file.
 */
export async function loadTask(name: string, base: URL = PACK_URL): Promise<TaskDefinition> {
  const task = listed('task', TASK_NAMES, name);
  const value = await importDefault('task', 'tasks', task, base);
  const problem = taskProblem(value);
  if (problem !== null) throw new LoadError('shape', `the default export of the file of the task ${task} is not a task definition: ${problem}`);
  const definition = value as TaskDefinition;
  if (definition.name !== task) throw new LoadError('mismatch', `the file of the task ${task} defines another task: its name must be the name of its file`);
  return definition;
}

/**
 * Loads the data of the use case of this name. The name must be in `USE_CASE_NAMES`, the file `usecases/<name>.ts` must exist, its default export must have the shape of a `UseCase`, and the
 * `name` of the data must be the name of the file.
 */
export async function loadUseCase(name: string, base: URL = PACK_URL): Promise<UseCase> {
  const useCase = listed('use case', USE_CASE_NAMES, name);
  const value = await importDefault('use case', 'usecases', useCase, base);
  const problem = useCaseProblem(value);
  if (problem !== null) throw new LoadError('shape', `the default export of the file of the use case ${useCase} is not the data of a use case: ${problem}`);
  const data = value as UseCase;
  if (data.name !== useCase) throw new LoadError('mismatch', `the data file of the use case ${useCase} names another use case: its name must be the name of its file`);
  return data;
}
