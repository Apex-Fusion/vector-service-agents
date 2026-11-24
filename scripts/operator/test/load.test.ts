// The loaders of the pack: each loads the file of a task or of a use case by a name from a closed list. Each refusal has an accepted twin. The tests give the loaders a temporary folder as their base,
// so that they need no real task and no real data file.
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { LoadError, PACK_URL, loadTask, loadUseCase } from '../lib/load.ts';
import type { LoadReason } from '../lib/load.ts';
import { TASK_NAMES } from '../tasks/names.ts';
import { USE_CASE_NAMES } from '../usecases/names.ts';

const folders: string[] = [];
afterAll(() => { for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true }); });

/** The URL of a new base folder in the temporary directory, with the files that a test names (path below the base to text). */
function baseWith(files: Readonly<Record<string, string>>): URL {
  const root = mkdtempSync(join(tmpdir(), 'operator-load-'));
  folders.push(root);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return pathToFileURL(`${root}/`);
}

type Members = Readonly<Record<string, string | null>>;
/** The source of a module whose default export is an object with these members (the text of each member). A member that is null is left out. */
const moduleOf = (members: Members): string => `export default {\n${Object.entries(members).filter(([, value]) => value !== null).map(([key, value]) => `  ${key}: ${value},`).join('\n')}\n};\n`;

const FINISHED = "async () => ({ kind: 'finished', message: 'done' })";
const taskMembers = (name: string, change: Members = {}): Members => ({
  name: JSON.stringify(name), title: "'A test task'", flags: '[]', valued: '[]', needs: "{ keys: () => [], chain: false, hosted: [], approval: 'never' }",
  steps: '() => []', parse: '() => ({})', next: FINISHED, cleanup: FINISHED, ...change,
});
const taskFile = (name: string, change: Members = {}): string => moduleOf(taskMembers(name, change));
const useCaseMembers = (name: string, change: Members = {}): Members => ({
  name: JSON.stringify(name), title: "'A test use case'", keys: '[]', organisations: '[]', agents: '[]', subagents: '[]', funding: '[]', attestations: '[]', runs: '[]', evidenceSteps: '[]',
  moduleManifestPath: "'Module-1/deploy/manifest.json'", runtimeCommit: "'main'", ...change,
});
const useCaseFile = (name: string, change: Members = {}): string => moduleOf(useCaseMembers(name, change));

/** The refusal of a call that must give a LoadError, with its reason. */
async function refusal(call: () => Promise<unknown>): Promise<LoadError> {
  try { await call(); } catch (err) { if (err instanceof LoadError) return err; throw err; }
  throw new Error('the call did not refuse');
}
const reasonOf = async (call: () => Promise<unknown>): Promise<LoadReason> => (await refusal(call)).reason;

const TASKS = ['keys', 'fund', 'register', 'stake', 'advert', 'attest', 'claim', 'allowlist', 'env', 'tenant', 'fault', 'probe', 'hold', 'delegations', 'evidence', 'results', 'end-state'];

describe('the closed lists', () => {
  it('list the 17 tasks and the use case of use case 1 (inventory reorder), each name once', () => {
    expect([...TASK_NAMES]).toEqual(TASKS);
    expect(new Set(TASK_NAMES).size).toBe(TASK_NAMES.length);
    expect([...USE_CASE_NAMES]).toEqual(['inventory-reorder']);
  });
  it('hold names that are the names of files: lower-case letters, digits and hyphens', () => {
    for (const name of [...TASK_NAMES, ...USE_CASE_NAMES]) expect(name).toMatch(/^[a-z][a-z0-9-]{0,47}$/);
  });
  it('make the base of the loaders the folder of the pack, which holds both lists', () => {
    for (const file of ['lib/load.ts', 'tasks/names.ts', 'usecases/names.ts']) expect(existsSync(fileURLToPath(new URL(file, PACK_URL))), file).toBe(true);
  });
});

describe('loadTask', () => {
  it('loads the file of each task of the list, and gives its definition', async () => {
    const base = baseWith(Object.fromEntries(TASK_NAMES.map((name) => [`tasks/${name}.ts`, taskFile(name)])));
    for (const name of TASK_NAMES) {
      const task = await loadTask(name, base);
      expect(task.name).toBe(name);
      expect(task.needs.approval).toBe('never');
      expect(task.needs.keys({} as never, {} as never)).toEqual([]);
    }
  });
  it('takes a base folder given as a URL with no slash at its end', async () => {
    const base = baseWith({ 'tasks/keys.ts': taskFile('keys') });
    expect((await loadTask('keys', new URL(base.href.slice(0, -1)))).name).toBe('keys');
  });
  it('accepts a definition with status and result, and one with neither', async () => {
    const base = baseWith({ 'tasks/keys.ts': taskFile('keys', { status: 'async () => []', result: '() => ({})' }), 'tasks/fund.ts': taskFile('fund') });
    expect(typeof (await loadTask('keys', base)).status).toBe('function');
    expect((await loadTask('fund', base)).status).toBeUndefined();
  });
  it('refuses a name outside the list, even when a file of that name is there', async () => {
    const base = baseWith({
      'tasks/unlisted.ts': taskFile('unlisted'), 'tasks/names.ts': taskFile('names'), 'tasks/Keys.ts': taskFile('Keys'), 'tasks/keys.ts.ts': taskFile('keys.ts'), 'lib/escape.ts': taskFile('escape'),
      'tasks/keys.ts': taskFile('keys'),
    });
    for (const bad of ['unlisted', 'names', 'Keys', 'keys.ts', '../lib/escape', 'keys/../keys', ' keys', 'keys ', '', 'end_state', 'key']) {
      expect((await refusal(() => loadTask(bad, base))).reason, bad).toBe('name');
    }
    expect((await loadTask('keys', base)).name).toBe('keys');
  });
  it('lists the names of the tasks in the refusal, and never shows the name that it refused', async () => {
    const err = await refusal(() => loadTask('distinctive-task', baseWith({ 'tasks/distinctive-task.ts': taskFile('distinctive-task') })));
    expect(err.message).toContain(TASK_NAMES.join(', '));
    expect(err.message).not.toContain('distinctive');
  });
  it('refuses a value that is no text', async () => {
    const base = baseWith({ 'tasks/keys.ts': taskFile('keys') });
    for (const bad of [undefined, null, 5, {}, ['keys'], { toString: () => 'keys' }]) {
      expect(await reasonOf(() => loadTask(bad as unknown as string, base))).toBe('name');
    }
  });
  it('refuses a name of the list whose file is not there, and names no path', async () => {
    const err = await refusal(() => loadTask('keys', baseWith({ 'tasks/fund.ts': taskFile('fund') })));
    expect(err.reason).toBe('missing');
    expect(err.message).toContain('keys');
    expect(err.message).not.toContain(tmpdir());
  });
  it('refuses a file that cannot be loaded: a syntax error, an error while it runs, a folder in its place', async () => {
    const base = baseWith({ 'tasks/keys.ts': 'export default {', 'tasks/fund.ts': "throw new Error('this failed while loading');\nexport default {};\n" });
    mkdirSync(join(fileURLToPath(base), 'tasks', 'register.ts'));
    const broken = await refusal(() => loadTask('keys', base));
    expect(broken.reason).toBe('import');
    expect(broken.message).toContain('keys');
    const thrown = await refusal(() => loadTask('fund', base));
    expect(thrown.reason).toBe('import');
    expect(thrown.message).toContain('this failed while loading');
    expect(await reasonOf(() => loadTask('register', base))).toBe('import');
  });
  describe('a default export of the wrong shape', () => {
    const WRONG: [string, string][] = [
      ['no default export', 'export const task = {};\n'],
      ['a text', "export default 'keys';\n"],
      ['null', 'export default null;\n'],
      ['a number', 'export default 5;\n'],
      ['a list', "export default [{ name: 'keys' }];\n"],
      ['a function', "export default () => ({ name: 'keys' });\n"],
      ['an empty object', 'export default {};\n'],
      ...['name', 'title', 'flags', 'valued', 'needs', 'steps', 'parse', 'next', 'cleanup'].map((member): [string, string] => [`no ${member}`, taskFile('keys', { [member]: null })]),
      ['a name that is no text', taskFile('keys', { name: '5' })],
      ['a title that is no text', taskFile('keys', { title: '5' })],
      ['flags that are no list', taskFile('keys', { flags: "'submit'" })],
      ['flags with a member that is no text', taskFile('keys', { flags: "['--record', 5]" })],
      ['valued that is no list', taskFile('keys', { valued: '{}' })],
      ['needs that is no object', taskFile('keys', { needs: "'none'" })],
      ['needs with keys that is a list', taskFile('keys', { needs: "{ keys: [], chain: false, hosted: [], approval: 'never' }" })],
      ['needs without keys', taskFile('keys', { needs: "{ chain: false, hosted: [], approval: 'never' }" })],
      ['needs with a chain that is no boolean', taskFile('keys', { needs: "{ keys: () => [], chain: 'no', hosted: [], approval: 'never' }" })],
      ['needs with hosted that is no list of texts', taskFile('keys', { needs: "{ keys: () => [], chain: false, hosted: [1], approval: 'never' }" })],
      ['needs with an approval that is neither submit nor never', taskFile('keys', { needs: "{ keys: () => [], chain: false, hosted: [], approval: 'always' }" })],
      ['needs with no approval', taskFile('keys', { needs: '{ keys: () => [], chain: false, hosted: [] }' })],
      ['steps that is no function', taskFile('keys', { steps: '[]' })],
      ['parse that is no function', taskFile('keys', { parse: '{}' })],
      ['next that is no function', taskFile('keys', { next: "'next'" })],
      ['cleanup that is no function', taskFile('keys', { cleanup: 'null' })],
      ['a status that is no function', taskFile('keys', { status: '[]' })],
      ['a result that is no function', taskFile('keys', { result: '{}' })],
    ];
    for (const [label, source] of WRONG) {
      it(`refuses ${label}`, async () => {
        const err = await refusal(() => loadTask('keys', baseWith({ 'tasks/keys.ts': source })));
        expect(err.reason).toBe('shape');
        expect(err.message).toContain('keys');
      });
    }
    it('accepts the right shape, with the approval submit and with both functions of status and result', async () => {
      const source = taskFile('keys', { needs: "{ keys: () => ['run'], chain: true, hosted: ['vector_resolve_did'], approval: 'submit' }", flags: "['--record']", valued: "['--key']", status: 'async () => []', result: '() => ({})' });
      const task = await loadTask('keys', baseWith({ 'tasks/keys.ts': source }));
      expect(task.needs).toMatchObject({ chain: true, hosted: ['vector_resolve_did'], approval: 'submit' });
      expect([task.flags, task.valued]).toEqual([['--record'], ['--key']]);
    });
  });
  it('refuses a task whose name is not the name of its file, and the same name in another case', async () => {
    const base = baseWith({ 'tasks/keys.ts': taskFile('fund'), 'tasks/fund.ts': taskFile('Fund'), 'tasks/stake.ts': taskFile('stake') });
    expect(await reasonOf(() => loadTask('keys', base))).toBe('mismatch');
    expect(await reasonOf(() => loadTask('fund', base))).toBe('mismatch');
    expect((await loadTask('stake', base)).name).toBe('stake');
  });
});

describe('loadUseCase', () => {
  it('loads the file of the use case of the list, and gives its data', async () => {
    const base = baseWith({ 'usecases/inventory-reorder.ts': useCaseFile('inventory-reorder') });
    const use = await loadUseCase('inventory-reorder', base);
    expect(use.name).toBe('inventory-reorder');
    expect(use.title).toBe('A test use case');
    expect([use.keys, use.agents, use.runs]).toEqual([[], [], []]);
    expect(use.moduleManifestPath).toBe('Module-1/deploy/manifest.json');
  });
  it('refuses a name outside the list, even when a file of that name is there', async () => {
    const base = baseWith({
      'usecases/unlisted.ts': useCaseFile('unlisted'), 'usecases/names.ts': useCaseFile('names'), 'usecases/Inventory-Reorder.ts': useCaseFile('Inventory-Reorder'), 'lib/escape.ts': useCaseFile('escape'),
      'usecases/inventory-reorder.ts': useCaseFile('inventory-reorder'),
    });
    for (const bad of ['unlisted', 'names', 'Inventory-Reorder', '../lib/escape', 'inventory-reorder/../inventory-reorder', ' inventory-reorder', '', 'inventory_reorder']) {
      expect((await refusal(() => loadUseCase(bad, base))).reason, bad).toBe('name');
    }
    expect(await reasonOf(() => loadUseCase(5 as unknown as string, base))).toBe('name');
    expect((await loadUseCase('inventory-reorder', base)).name).toBe('inventory-reorder');
  });
  it('lists the names of the use cases in the refusal, and never shows the name that it refused', async () => {
    const err = await refusal(() => loadUseCase('distinctive-case', baseWith({ 'usecases/distinctive-case.ts': useCaseFile('distinctive-case') })));
    expect(err.message).toContain(USE_CASE_NAMES.join(', '));
    expect(err.message).not.toContain('distinctive');
  });
  it('refuses a name of the list whose file is not there, and names no path', async () => {
    const err = await refusal(() => loadUseCase('inventory-reorder', baseWith({ 'usecases/other.ts': useCaseFile('other') })));
    expect(err.reason).toBe('missing');
    expect(err.message).not.toContain(tmpdir());
  });
  it('refuses a file that cannot be loaded', async () => {
    expect(await reasonOf(() => loadUseCase('inventory-reorder', baseWith({ 'usecases/inventory-reorder.ts': 'export default {' })))).toBe('import');
    const err = await refusal(() => loadUseCase('inventory-reorder', baseWith({ 'usecases/inventory-reorder.ts': "throw new Error('this failed while loading');\n" })));
    expect(err.reason).toBe('import');
    expect(err.message).toContain('this failed while loading');
  });
  describe('a default export of the wrong shape', () => {
    const LISTS = ['keys', 'organisations', 'agents', 'subagents', 'funding', 'attestations', 'runs', 'evidenceSteps'];
    const WRONG: [string, string][] = [
      ['no default export', 'export const use = {};\n'],
      ['a text', "export default 'inventory-reorder';\n"],
      ['null', 'export default null;\n'],
      ['a list', "export default [{ name: 'inventory-reorder' }];\n"],
      ['an empty object', 'export default {};\n'],
      ['no name', useCaseFile('inventory-reorder', { name: null })],
      ['a name that is no text', useCaseFile('inventory-reorder', { name: '5' })],
      ['no title', useCaseFile('inventory-reorder', { title: null })],
      ['a title that is no text', useCaseFile('inventory-reorder', { title: '[]' })],
      ...LISTS.flatMap((member): [string, string][] => [[`no ${member}`, useCaseFile('inventory-reorder', { [member]: null })], [`${member} that is no list`, useCaseFile('inventory-reorder', { [member]: '{}' })]]),
      ['no manifest path', useCaseFile('inventory-reorder', { moduleManifestPath: null })],
      ['a manifest path that is no text', useCaseFile('inventory-reorder', { moduleManifestPath: '5' })],
      ['no runtime commit', useCaseFile('inventory-reorder', { runtimeCommit: null })],
      ['a runtime commit that is no text', useCaseFile('inventory-reorder', { runtimeCommit: '5' })],
    ];
    for (const [label, source] of WRONG) {
      it(`refuses ${label}`, async () => {
        const err = await refusal(() => loadUseCase('inventory-reorder', baseWith({ 'usecases/inventory-reorder.ts': source })));
        expect(err.reason).toBe('shape');
        expect(err.message).toContain('inventory-reorder');
      });
    }
  });
  it('refuses a data file whose name is not the name of its file, and accepts the file with the same name', async () => {
    for (const name of ['other-use-case', 'Inventory-Reorder', 'inventory-reorder ', '']) {
      const base = baseWith({ 'usecases/inventory-reorder.ts': useCaseFile('inventory-reorder', { name: JSON.stringify(name) }) });
      expect(await reasonOf(() => loadUseCase('inventory-reorder', base)), JSON.stringify(name)).toBe('mismatch');
    }
    expect((await loadUseCase('inventory-reorder', baseWith({ 'usecases/inventory-reorder.ts': useCaseFile('inventory-reorder') }))).name).toBe('inventory-reorder');
  });
});
