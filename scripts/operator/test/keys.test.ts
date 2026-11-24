// The task keys, through the real runner: what a dry run shows and writes, the approval, the keys that a submit run makes (modes, public file, table, result), a second run, a key file that is lost,
// replaced or damaged, a key file that has the wrong mode, the status, the cleanup, and the rule that no seed reaches any stream. Each refusal has an accepted twin.
// The keys of these tests are made at run time by the task itself. No test writes a key into a source file, and none uses a network.
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { KeySpec } from '../lib/registry.ts';
import { LEGACY_PUBLIC_MANIFEST, checkPublicManifest, loadRegistry, publicManifestFile } from '../lib/registry.ts';
import { FactsFile } from '../lib/facts.ts';
import { loadTask } from '../lib/load.ts';
import { parseArguments } from '../lib/runner.ts';
import keysTask from '../tasks/keys.ts';
import realUseCase from '../usecases/inventory-reorder.ts';
import { makeKeyRoot, writeSeed } from './support/keys.ts';
import { KEY_TEXT } from './support/secrets.ts';
import { counterSeed } from './support/keys.ts';
import { USE_CASE, taskWorld } from './support/task-world.ts';
import type { TaskWorld } from './support/task-world.ts';

const SPECS: readonly KeySpec[] = [
  { name: 'run', scope: 'shared', about: 'The run wallet of a test.' },
  { name: 'fee', scope: 'shared', about: 'The fee wallet of a test.' },
  { name: 'alpha', scope: 'use-case', about: 'A key of the use case of a test.' },
  { name: 'beta', scope: 'use-case', about: 'Another key of the use case of a test.' },
];
const NAMES = SPECS.map((spec) => spec.name);
const MANIFEST = publicManifestFile(USE_CASE);

/** A world whose key folder is empty (it exists, with mode 700, as the settings need). The use case has the keys of SPECS unless a test says others. */
async function emptyWorld(keys: readonly KeySpec[] = SPECS): Promise<{ w: TaskWorld; root: string }> {
  const root = makeKeyRoot();
  const w = await taskWorld({ env: { OPERATOR_KEYS_DIR: root }, use: { keys } });
  return { w, root };
}

const reset = (w: TaskWorld): void => {
  w.screen.lines.length = 0;
  w.screen.errors.length = 0;
};
/** The run wallet that an approval names: `unset` while the file of the run key is missing, and the address of that key once the file exists, because the runner loads the run key for the approval. */
const runWalletOf = (w: TaskWorld): string => {
  const root = w.env.OPERATOR_KEYS_DIR!;
  return existsSync(join(root, 'shared', 'run.seed')) ? loadRegistry({ dir: root, useCase: USE_CASE, specs: SPECS, need: ['run'] }).addressOf('run') : 'unset';
};
const approve = (w: TaskWorld, over: Parameters<TaskWorld['writeGo']>[0] = {}): void => { w.writeGo({ runWallet: runWalletOf(w), tasks: ['keys'], ...over }); };
/** A submit run with the approval that fits the key files now. */
const submit = (w: TaskWorld): Promise<number> => { approve(w); return w.run(keysTask, '--submit'); };
/** A submit run with the approval file as it is: none, or the one that the test wrote. */
const submitAsIs = (w: TaskWorld): Promise<number> => w.run(keysTask, '--submit');
const folderOf = (spec: KeySpec): string => (spec.scope === 'shared' ? 'shared' : USE_CASE);
const fileOf = (root: string, spec: KeySpec): string => join(root, folderOf(spec), `${spec.name}.seed`);
const modeOf = (path: string): number => statSync(path).mode & 0o777;
const seedsOf = (root: string, keys: readonly KeySpec[] = SPECS): Record<string, string> => Object.fromEntries(keys.map((spec) => [spec.name, readFileSync(fileOf(root, spec), 'utf8')]));
const registryOf = (root: string, keys: readonly KeySpec[] = SPECS) => loadRegistry({ dir: root, useCase: USE_CASE, specs: keys });
const manifestOf = (root: string): string => readFileSync(join(root, MANIFEST), 'utf8');
/** Everything that a person or a program can read after a run, besides the key files: the screen, its errors, the state folder, and the public key file. */
const readable = (w: TaskWorld, root: string): string => [w.allText(), existsSync(join(root, MANIFEST)) ? manifestOf(root) : ''].join('\n');
const nothingMade = (root: string): void => { expect(readdirSync(root)).toEqual([]); };
const RUN_LINE = (address: string): string => `the run wallet address is ${address}: send the funds to it`;

describe('the definition', () => {
  it('is a task of the closed list that names no key, reads the chain for the status, calls no hosted tool and needs the approval of a submit run', async () => {
    const { w } = await emptyWorld();
    const loaded = await loadTask('keys');
    expect(loaded.name).toBe('keys');
    expect(loaded.needs.keys(w.use, parseArguments(loaded, []).flags)).toEqual([]);
    expect(loaded.needs).toMatchObject({ chain: true, hosted: [], approval: 'submit' });
    expect(loaded.flags).toEqual([]);
    expect(loaded.valued).toEqual([]);
    expect(loaded.steps(w.use, parseArguments(loaded, []).flags)).toEqual([]);
  });
  it('stops with exit 2 when the use case lists no run key, and makes nothing, and takes the use case that lists one', async () => {
    const { w, root } = await emptyWorld(SPECS.filter((spec) => spec.name !== 'run'));
    approve(w);
    expect(await submit(w)).toBe(2);
    expect(w.screen.errorText).toContain('no key named run');
    nothingMade(root);
    const twin = await emptyWorld();
    approve(twin.w);
    expect(await submit(twin.w)).toBe(0);
  });
});

describe('a dry run', () => {
  it('lists the keys that it would make, each with its folder, writes nothing (no folder, no file), reads no approval, and prints no table', async () => {
    const { w, root } = await emptyWorld();
    approve(w);
    writeFileSync(w.goPath, 'this is not JSON', { mode: 0o600 });
    expect(await w.run(keysTask)).toBe(0);
    nothingMade(root);
    expect(w.screen.lines).toContain('would make 4 keys:');
    expect(w.screen.lines).toContain('would keep 0 keys:');
    for (const spec of SPECS) expect(w.screen.lines).toContain(`  ${spec.name}: folder ${folderOf(spec)}`);
    expect(w.screen.text).not.toContain('the run wallet address is');
    expect(w.machine()).toEqual({ task: 'keys', command: 'run', mode: 'dry', outcome: 'dry', exit: 0, step: null, result: { would_make: NAMES, would_keep: [] } });
  });
  it('lists a key that exists as kept, and the dry list is the list that the next submit run makes', async () => {
    const { w, root } = await emptyWorld();
    approve(w);
    expect(await submit(w)).toBe(0);
    rmSync(fileOf(root, SPECS[2]!));
    reset(w);
    expect(await w.run(keysTask)).toBe(0);
    expect(w.machine().result).toEqual({ would_make: ['alpha'], would_keep: ['run', 'fee', 'beta'] });
    expect(existsSync(fileOf(root, SPECS[2]!))).toBe(false);
    reset(w);
    expect(await submit(w)).toBe(0);
    expect(w.machine().result).toMatchObject({ made: ['alpha'], kept: ['run', 'fee', 'beta'] });
  });
  it('stops with exit 2 for a key file with the wrong mode, in a dry run too, and takes the file with mode 600', async () => {
    const { w, root } = await emptyWorld();
    approve(w);
    expect(await submit(w)).toBe(0);
    chmodSync(fileOf(root, SPECS[3]!), 0o644);
    reset(w);
    expect(await w.run(keysTask)).toBe(2);
    expect(w.screen.errorText).toContain('the key beta has mode 644: set mode 600 on its key file');
    chmodSync(fileOf(root, SPECS[3]!), 0o600);
    reset(w);
    expect(await w.run(keysTask)).toBe(0);
  });
});

describe('the approval', () => {
  it('stops a submit run with exit 2 and makes nothing when there is no approval file', async () => {
    const { w, root } = await emptyWorld();
    expect(await submitAsIs(w)).toBe(2);
    expect(w.screen.errorText).toContain('the approval file does not exist');
    nothingMade(root);
    expect(w.machine()).toMatchObject({ task: 'keys', mode: 'submit', outcome: 'stopped', exit: 2 });
  });
  it('stops a submit run with exit 2 and makes nothing when the approval lists another task, or names a run wallet, and takes the approval that says unset and lists the task keys', async () => {
    const { w, root } = await emptyWorld();
    approve(w, { tasks: ['fund'] });
    expect(await submitAsIs(w)).toBe(2);
    expect(w.screen.errorText).toContain('only the task keys may run');
    approve(w, { runWallet: w.keys.registry.addressOf('run') });
    reset(w);
    expect(await submitAsIs(w)).toBe(2);
    expect(w.screen.errorText).toContain('no run key exists yet');
    nothingMade(root);
    approve(w);
    reset(w);
    expect(await submit(w)).toBe(0);
    expect(readdirSync(root).sort()).toEqual([USE_CASE, MANIFEST, 'shared']);
  });
  it('refuses the approval that says unset once the run key file exists, makes nothing, and takes the approval that names the run wallet', async () => {
    const { w, root } = await emptyWorld();
    expect(await submit(w)).toBe(0);
    rmSync(fileOf(root, SPECS[2]!));
    approve(w, { runWallet: 'unset' });
    reset(w);
    expect(await submitAsIs(w)).toBe(2);
    expect(w.screen.errorText).toContain('the approval says unset for runWallet, and the run key exists: it must name the run wallet');
    expect(existsSync(fileOf(root, SPECS[2]!))).toBe(false);
    approve(w, { runWallet: registryOf(root, SPECS.filter((spec) => spec.name !== 'alpha')).addressOf('run') });
    reset(w);
    expect(await submitAsIs(w)).toBe(0);
    expect(w.machine().result).toMatchObject({ made: ['alpha'] });
  });
});

describe('a submit run that makes the keys', () => {
  it('makes each key with mode 600 in a folder with mode 700, writes the public file, prints the table and the run wallet line last, and gives the result', async () => {
    const { w, root } = await emptyWorld();
    approve(w);
    expect(await submit(w)).toBe(0);
    for (const folder of [root, join(root, 'shared'), join(root, USE_CASE)]) expect(modeOf(folder)).toBe(0o700);
    const seeds = seedsOf(root);
    for (const spec of SPECS) {
      expect(modeOf(fileOf(root, spec))).toBe(0o600);
      expect(seeds[spec.name]).toMatch(/^[0-9a-f]{64}\n$/);
    }
    expect(new Set(Object.values(seeds)).size).toBe(SPECS.length);
    expect(modeOf(join(root, MANIFEST))).toBe(0o600);
    const registry = registryOf(root);
    checkPublicManifest(join(root, MANIFEST), registry);
    for (const spec of SPECS) {
      const row = w.screen.lines.find((line) => line.startsWith(spec.name) && line.includes(registry.hashOf(spec.name)));
      expect(row, spec.name).toBeDefined();
      expect(row).toContain(spec.scope);
      expect(row).toContain(registry.addressOf(spec.name));
    }
    const lines = w.screen.lines;
    expect(lines.at(-2)).toBe(RUN_LINE(registry.addressOf('run')));
    expect(w.machine()).toEqual({ task: 'keys', command: 'run', mode: 'submit', outcome: 'done', exit: 0, step: null, result: { made: NAMES, kept: [], run_wallet: registry.addressOf('run') } });
    expect(w.state('keys').steps).toEqual({});
  });
  it('makes the 18 keys of the real data of use case 1: 8 in the shared folder and 10 in the folder of the use case, all different', async () => {
    const root = makeKeyRoot();
    const w = await taskWorld({ env: { OPERATOR_KEYS_DIR: root }, use: realUseCase });
    approve(w);
    expect(await submit(w)).toBe(0);
    const names = realUseCase.keys.map((spec) => spec.name);
    expect(names).toHaveLength(18);
    expect(w.machine().result).toMatchObject({ made: names, kept: [] });
    expect(readdirSync(join(root, 'shared')).sort()).toEqual(realUseCase.keys.filter((spec) => spec.scope === 'shared').map((spec) => `${spec.name}.seed`).sort());
    expect(readdirSync(join(root, USE_CASE)).sort()).toEqual(realUseCase.keys.filter((spec) => spec.scope === 'use-case').map((spec) => `${spec.name}.seed`).sort());
    expect(readdirSync(join(root, 'shared'))).toHaveLength(8);
    expect(readdirSync(join(root, USE_CASE))).toHaveLength(10);
    const registry = loadRegistry({ dir: root, useCase: USE_CASE, specs: realUseCase.keys });
    expect(new Set(names.map((name) => registry.hashOf(name))).size).toBe(18);
    checkPublicManifest(join(root, MANIFEST), registry);
    expect(Object.keys(JSON.parse(manifestOf(root)).keys)).toEqual(names);
  });
  it('makes different keys in two folders: the key is random', async () => {
    const first = await emptyWorld();
    const second = await emptyWorld();
    approve(first.w);
    approve(second.w);
    await submit(first.w);
    await submit(second.w);
    expect(seedsOf(first.root).run).not.toBe(seedsOf(second.root).run);
  });
  it('prints no seed on the screen, in the errors, in the state folder, in the evidence, in the machine line or in the public file, and the public file holds each public key', async () => {
    const { w, root } = await emptyWorld();
    approve(w);
    expect(await submit(w)).toBe(0);
    const text = readable(w, root);
    for (const seed of Object.values(seedsOf(root))) expect(text).not.toContain(seed.trim());
    expect(manifestOf(root)).toContain(registryOf(root).publicKeyOf('run'));
  });
  it('never prints the text of a key file that it keeps, whatever the text is, and a marker seed that it keeps stays off every stream', async () => {
    const { w, root } = await emptyWorld();
    approve(w);
    const marker = counterSeed();
    writeSeed(root, 'shared', 'run', `${marker}\n`);
    expect(await submit(w)).toBe(0);
    expect(w.machine().result).toMatchObject({ made: ['fee', 'alpha', 'beta'], kept: ['run'] });
    expect(readFileSync(fileOf(root, SPECS[0]!), 'utf8')).toBe(`${marker}\n`);
    expect(readable(w, root)).not.toContain(marker);
    reset(w);
    expect(await w.run(keysTask, 'status')).toBe(0);
    expect(readable(w, root)).not.toContain(marker);
  });
});

describe('a second run', () => {
  it('makes nothing, says so, leaves each file and the public file as they are (bytes and times), and prints the table and the run wallet line again', async () => {
    const { w, root } = await emptyWorld();
    approve(w);
    expect(await submit(w)).toBe(0);
    const files = [...SPECS.map((spec) => fileOf(root, spec)), join(root, MANIFEST)];
    const before = files.map((file) => [readFileSync(file, 'utf8'), statSync(file).mtimeMs]);
    reset(w);
    expect(await submit(w)).toBe(0);
    expect(files.map((file) => [readFileSync(file, 'utf8'), statSync(file).mtimeMs])).toEqual(before);
    expect(w.screen.lines).toContain('every key exists: nothing was made, and the public key file is unchanged');
    expect(w.screen.lines.at(-2)).toBe(RUN_LINE(registryOf(root).addressOf('run')));
    expect(w.machine()).toMatchObject({ outcome: 'finished', exit: 0, result: { made: [], kept: NAMES, run_wallet: registryOf(root).addressOf('run') } });
  });
  it('writes the public file when the first run made the keys and stopped before it', async () => {
    const { w, root } = await emptyWorld();
    approve(w);
    expect(await submit(w)).toBe(0);
    rmSync(join(root, MANIFEST));
    reset(w);
    expect(await submit(w)).toBe(0);
    checkPublicManifest(join(root, MANIFEST), registryOf(root));
    expect(w.screen.text).toContain('the public key file is new');
    expect(w.machine()).toMatchObject({ outcome: 'done', result: { made: [], kept: NAMES } });
  });
});

describe('a key file that is lost', () => {
  it('makes only that file again, keeps the others byte for byte, says that the public file changed and why, and shows the old and the new address', async () => {
    const { w, root } = await emptyWorld();
    approve(w);
    expect(await submit(w)).toBe(0);
    const before = seedsOf(root);
    const oldAddress = registryOf(root).addressOf('alpha');
    rmSync(fileOf(root, SPECS[2]!));
    reset(w);
    expect(await submit(w)).toBe(0);
    const after = seedsOf(root);
    for (const name of ['run', 'fee', 'beta']) expect(after[name]).toBe(before[name]);
    expect(after.alpha).not.toBe(before.alpha);
    expect(modeOf(fileOf(root, SPECS[2]!))).toBe(0o600);
    expect(w.machine()).toMatchObject({ outcome: 'done', result: { made: ['alpha'], kept: ['run', 'fee', 'beta'] } });
    const newAddress = registryOf(root).addressOf('alpha');
    expect(newAddress).not.toBe(oldAddress);
    expect(w.screen.text).toContain('the public key file changed');
    expect(w.screen.text).toContain(`the address of the key alpha changed from ${oldAddress} to ${newAddress}`);
    checkPublicManifest(join(root, MANIFEST), registryOf(root));
  });
  it('stops with exit 2 and makes nothing, not even another key that is lost, when the run key is lost and the public file shows its wallet, in a dry run too', async () => {
    const { w, root } = await emptyWorld();
    approve(w);
    expect(await submit(w)).toBe(0);
    const runAddress = registryOf(root).addressOf('run');
    rmSync(fileOf(root, SPECS[0]!));
    rmSync(fileOf(root, SPECS[2]!));
    for (const argv of [['--submit'], []]) {
      reset(w);
      expect(await w.run(keysTask, ...argv)).toBe(2);
      expect(w.screen.errorText).toContain(`the run key file is missing, and the public key file shows the run wallet ${runAddress}: funds may be there`);
      expect(existsSync(fileOf(root, SPECS[0]!))).toBe(false);
      expect(existsSync(fileOf(root, SPECS[2]!))).toBe(false);
      expect(w.machine()).toMatchObject({ outcome: 'stopped', exit: 2 });
    }
  });
  it('makes the run key when there is no public file, and when the public file shows no run wallet', async () => {
    const { w, root } = await emptyWorld();
    approve(w);
    expect(await submit(w)).toBe(0);
    rmSync(fileOf(root, SPECS[0]!));
    rmSync(join(root, MANIFEST));
    reset(w);
    expect(await submit(w)).toBe(0);
    expect(w.machine().result).toMatchObject({ made: ['run'] });
    rmSync(fileOf(root, SPECS[0]!));
    const document = JSON.parse(manifestOf(root));
    delete document.keys.run;
    writeFileSync(join(root, MANIFEST), JSON.stringify(document), { mode: 0o600 });
    reset(w);
    expect(await submit(w)).toBe(0);
    expect(w.machine().result).toMatchObject({ made: ['run'] });
  });
  it('stops with exit 2 when the run key is lost and the public file cannot be read, and rewrites a public file that cannot be read when the run key is there', async () => {
    const { w, root } = await emptyWorld();
    approve(w);
    expect(await submit(w)).toBe(0);
    writeFileSync(join(root, MANIFEST), 'this is not JSON', { mode: 0o600 });
    reset(w);
    expect(await submit(w)).toBe(0);
    expect(w.screen.text).toContain('the public key file was damaged and is written again');
    checkPublicManifest(join(root, MANIFEST), registryOf(root));
    writeFileSync(join(root, MANIFEST), 'this is not JSON', { mode: 0o600 });
    rmSync(fileOf(root, SPECS[0]!));
    reset(w);
    expect(await submit(w)).toBe(2);
    expect(w.screen.errorText).toContain('the public key file cannot be read, so it is not known whether the run wallet holds funds');
    expect(existsSync(fileOf(root, SPECS[0]!))).toBe(false);
  });
  it('stops with exit 2 when the run key file holds another key than the public file shows, and takes the file that holds the same key again', async () => {
    const { w, root } = await emptyWorld();
    approve(w);
    expect(await submit(w)).toBe(0);
    const original = readFileSync(fileOf(root, SPECS[0]!), 'utf8');
    writeSeed(root, 'shared', 'run', `${counterSeed()}\n`);
    reset(w);
    expect(await submit(w)).toBe(2);
    expect(w.screen.errorText).toContain('the run key file gives another wallet than the public key file shows');
    writeSeed(root, 'shared', 'run', original);
    reset(w);
    expect(await submit(w)).toBe(0);
    expect(w.machine()).toMatchObject({ outcome: 'finished' });
  });
  it('does not show an invalid manifest address and refuses to make a run key when the file cannot be read as a manifest', async () => {
    const { w, root } = await emptyWorld();
    expect(await submit(w)).toBe(0);
    const document = JSON.parse(manifestOf(root));
    document.keys.run.address = KEY_TEXT;
    writeFileSync(join(root, MANIFEST), JSON.stringify(document), { mode: 0o600 });
    rmSync(fileOf(root, SPECS[0]!));
    reset(w);
    expect(await submit(w)).toBe(2);
    expect(w.screen.errorText).toContain('the public key file cannot be read');
    expect(w.allText()).not.toContain(KEY_TEXT);
    expect(existsSync(fileOf(root, SPECS[0]!))).toBe(false);
  });
});

describe('a key file that is not as the pack made it', () => {
  it('is never replaced: a file with the wrong mode stops the run before any other key is made, and the file with mode 600 lets the run go on', async () => {
    const { w, root } = await emptyWorld();
    approve(w);
    expect(await submit(w)).toBe(0);
    const before = seedsOf(root);
    rmSync(fileOf(root, SPECS[3]!));
    chmodSync(fileOf(root, SPECS[2]!), 0o640);
    reset(w);
    expect(await submit(w)).toBe(2);
    expect(w.screen.errorText).toContain('the key alpha has mode 640: set mode 600 on its key file');
    expect(existsSync(fileOf(root, SPECS[3]!))).toBe(false);
    expect(readFileSync(fileOf(root, SPECS[2]!), 'utf8')).toBe(before.alpha);
    chmodSync(fileOf(root, SPECS[2]!), 0o600);
    reset(w);
    expect(await submit(w)).toBe(0);
    expect(w.machine().result).toMatchObject({ made: ['beta'] });
  });
  it('is refused when it is a symbolic link, which is never followed, and when its text is no key, and the refusal shows no text of the file', async () => {
    const { w, root } = await emptyWorld();
    approve(w);
    expect(await submit(w)).toBe(0);
    const target = join(root, 'elsewhere');
    writeFileSync(target, `${counterSeed()}\n`, { mode: 0o600 });
    rmSync(fileOf(root, SPECS[2]!));
    symlinkSync(target, fileOf(root, SPECS[2]!));
    reset(w);
    expect(await submit(w)).toBe(2);
    expect(w.screen.errorText).toContain('the key alpha is a symbolic link');
    rmSync(fileOf(root, SPECS[2]!));
    writeSeed(root, USE_CASE, 'alpha', `${KEY_TEXT}\n`);
    reset(w);
    expect(await submit(w)).toBe(2);
    expect(w.screen.errorText).toContain('the key alpha is not 64 lower-case hex characters');
    expect(readable(w, root)).not.toContain(KEY_TEXT);
    expect(readFileSync(fileOf(root, SPECS[2]!), 'utf8')).toBe(`${KEY_TEXT}\n`);
    rmSync(fileOf(root, SPECS[2]!));
    reset(w);
    expect(await submit(w)).toBe(0);
  });
  it('stops with exit 2 when the key folder has another mode than 700, and makes nothing, and goes on when the mode is 700', async () => {
    const { w, root } = await emptyWorld();
    approve(w);
    mkdirSync(join(root, 'shared'), { mode: 0o755 });
    chmodSync(join(root, 'shared'), 0o755);
    expect(await submit(w)).toBe(2);
    expect(w.screen.errorText).toContain('the shared key folder has mode 755: set mode 700 on it');
    expect(readdirSync(join(root, 'shared'))).toEqual([]);
    expect(existsSync(join(root, USE_CASE))).toBe(false);
    chmodSync(join(root, 'shared'), 0o700);
    reset(w);
    expect(await submit(w)).toBe(0);
  });
});

describe('the status', () => {
  it('shows the table of the keys, the balance and the pure outputs of each wallet, and the state of the public file, and changes nothing', async () => {
    const w = await taskWorld({ keys: ['run', 'fee', 'service'], wallets: { run: [2_000_000_000n, 5_000_000n], fee: [], service: [7_500_000n] } });
    const root = w.keys.root;
    expect(await w.run(keysTask, 'status')).toBe(0);
    const text = w.screen.text;
    for (const name of w.keys.registry.names()) {
      const row = w.screen.lines.find((line) => line.startsWith(name) && line.includes(w.keys.registry.hashOf(name)));
      expect(row, name).toContain(w.keys.registry.addressOf(name));
    }
    expect(text).toContain('wallet run: 2005.000000 units in 2 output(s); pure outputs 2000.000000 units, 5.000000 units');
    expect(text).toContain('wallet fee: 0.000000 units in 0 output(s)');
    expect(text).toContain('wallet service: 7.500000 units in 1 output(s); pure outputs 7.500000 units');
    expect(text).toContain('the public key file does not exist');
    expect(existsSync(join(root, MANIFEST))).toBe(false);
    expect(readdirSync(root).sort()).toEqual([USE_CASE, 'shared']);
    expect(w.machine()).toMatchObject({ command: 'status', outcome: 'done', exit: 0 });
  });
  it('names the keys that are missing and still shows the keys that exist, and checks the public file when every key exists', async () => {
    const { w, root } = await emptyWorld();
    approve(w);
    expect(await w.run(keysTask, 'status')).toBe(0);
    expect(w.screen.text).toContain('4 of 4 key files are missing: run, fee, alpha, beta');
    expect(existsSync(join(root, 'shared'))).toBe(false);
    expect(await submit(w)).toBe(0);
    rmSync(fileOf(root, SPECS[3]!));
    reset(w);
    expect(await w.run(keysTask, 'status')).toBe(0);
    expect(w.screen.text).toContain('1 of 4 key files are missing: beta');
    expect(w.screen.text).toContain('the public key file is not checked: a key file is missing');
    reset(w);
    expect(await submit(w)).toBe(0);
    reset(w);
    expect(await w.run(keysTask, 'status')).toBe(0);
    expect(w.screen.text).toContain('the public key file equals the key files');
    writeFileSync(join(root, MANIFEST), `${manifestOf(root).replace('"use_case"', '"use_case_changed"')}`, { mode: 0o600 });
    reset(w);
    expect(await w.run(keysTask, 'status')).toBe(0);
    expect(w.screen.text).toContain('the public key file does not equal what the key files give');
  });
});

describe('the cleanup', () => {
  it('says that nothing can be taken back, because a key is never deleted, exits 0 and changes nothing', async () => {
    const { w, root } = await emptyWorld();
    approve(w);
    expect(await submit(w)).toBe(0);
    const before = [...SPECS.map((spec) => readFileSync(fileOf(root, spec), 'utf8')), manifestOf(root)];
    reset(w);
    expect(await w.run(keysTask, 'cleanup')).toBe(0);
    expect(w.screen.lines).toContain('nothing can be taken back: the pack never deletes a key file');
    expect([...SPECS.map((spec) => readFileSync(fileOf(root, spec), 'utf8')), manifestOf(root)]).toEqual(before);
    expect(w.machine()).toMatchObject({ command: 'cleanup', outcome: 'done', exit: 0, result: {} });
  });
});

describe('two use cases in one key folder', () => {
  const SECOND = 'second-case';
  const SECOND_SPECS: readonly KeySpec[] = [
    { name: 'run', scope: 'shared', about: 'The run wallet of a test.' },
    { name: 'fee', scope: 'shared', about: 'The fee wallet of a test.' },
    { name: 'new-shared', scope: 'shared', about: 'A shared key that the first use case does not need.' },
    { name: 'gamma', scope: 'use-case', about: 'A key of the second use case of a test.' },
  ];
  /** Two worlds over one key folder: the first has the use case of the tests, the second has another name. */
  async function twoWorlds(): Promise<{ first: TaskWorld; second: TaskWorld; root: string }> {
    const root = makeKeyRoot();
    const first = await taskWorld({ env: { OPERATOR_KEYS_DIR: root }, use: { keys: SPECS } });
    // The closed list of use case names holds one name, so a run of the second world takes the setting of the first. Its use case is the name of its data all the same.
    const second = await taskWorld({ env: { OPERATOR_KEYS_DIR: root, OPERATOR_USE_CASE: USE_CASE }, use: { name: SECOND, keys: SECOND_SPECS } });
    return { first, second, root };
  }
  it('gives each use case a public key file of its own: the run of the second does not change the file of the first, and the status of the first still says that its file equals the key files', async () => {
    const { first, second, root } = await twoWorlds();
    expect(await submit(first), first.screen.errorText).toBe(0);
    const firstFile = join(root, publicManifestFile(USE_CASE));
    const before = [readFileSync(firstFile, 'utf8'), statSync(firstFile).mtimeMs];
    approve(second);
    expect(await submitAsIs(second)).toBe(0);
    expect(readdirSync(root).sort()).toEqual([USE_CASE, publicManifestFile(USE_CASE), publicManifestFile(SECOND), 'shared', SECOND].sort());
    expect([readFileSync(firstFile, 'utf8'), statSync(firstFile).mtimeMs]).toEqual(before);
    expect(JSON.parse(readFileSync(join(root, publicManifestFile(SECOND)), 'utf8')).use_case).toBe(SECOND);
    expect(Object.keys(JSON.parse(readFileSync(firstFile, 'utf8')).keys)).toEqual(NAMES);
    reset(first);
    expect(await first.run(keysTask, 'status')).toBe(0);
    expect(first.screen.text).toContain('the public key file equals the key files');
    reset(second);
    expect(await second.run(keysTask, 'status')).toBe(0);
    expect(second.screen.text).toContain('the public key file equals the key files');
  });
  it.each([false, true])('guards the shared run wallet that another use case recorded (legacy file: %s)', async (legacy) => {
    const { first, second, root } = await twoWorlds();
    expect(await submit(first)).toBe(0);
    const firstPath = join(root, legacy ? LEGACY_PUBLIC_MANIFEST : MANIFEST);
    if (legacy) renameSync(join(root, MANIFEST), firstPath);
    const before = readFileSync(firstPath, 'utf8');
    const runPath = fileOf(root, SPECS[0]!);
    const original = readFileSync(runPath, 'utf8');
    const runAddress = registryOf(root).addressOf('run');
    rmSync(runPath);
    for (const argv of [[], ['--submit']]) {
      reset(second);
      approve(second);
      expect(await second.run(keysTask, ...argv)).toBe(2);
      expect(second.screen.errorText).toContain('the shared key run is missing');
      expect(existsSync(runPath)).toBe(false);
      expect(existsSync(join(root, 'shared', 'new-shared.seed'))).toBe(false);
      expect(existsSync(join(root, SECOND))).toBe(false);
      expect(existsSync(join(root, publicManifestFile(SECOND)))).toBe(false);
    }
    writeSeed(root, 'shared', 'run', original);
    reset(second);
    expect(await submit(second)).toBe(0);
    expect(second.machine().result).toMatchObject({ made: ['new-shared', 'gamma'], kept: ['run', 'fee'], run_wallet: runAddress });
    expect(readFileSync(firstPath, 'utf8')).toBe(before);
  });
  it('refuses a shared fee key that is missing or has another address before making keys for the second use case', async () => {
    const { first, second, root } = await twoWorlds();
    expect(await submit(first)).toBe(0);
    const feePath = fileOf(root, SPECS[1]!);
    const original = readFileSync(feePath, 'utf8');
    rmSync(feePath);
    expect(await submit(second)).toBe(2);
    expect(second.screen.errorText).toContain('the shared key fee is missing');
    expect(existsSync(feePath)).toBe(false);
    expect(existsSync(join(root, SECOND))).toBe(false);
    writeSeed(root, 'shared', 'fee', `${counterSeed()}\n`);
    reset(second);
    expect(await submit(second)).toBe(2);
    expect(second.screen.errorText).toContain('the shared key fee gives another wallet');
    expect(existsSync(join(root, SECOND))).toBe(false);
    writeSeed(root, 'shared', 'fee', original);
    reset(second);
    expect(await submit(second)).toBe(0);
    expect(second.machine().result).toMatchObject({ made: ['new-shared', 'gamma'], kept: ['run', 'fee'] });
  });
  it('lets a world take its use case from its data: the setting, the folder of its test keys and the reader of its facts', async () => {
    const first = await taskWorld({ use: { keys: SPECS } });
    const second = await taskWorld({ use: { name: SECOND, keys: SECOND_SPECS } });
    expect([first.use.name, first.env.OPERATOR_USE_CASE]).toEqual([USE_CASE, USE_CASE]);
    expect([second.use.name, second.env.OPERATOR_USE_CASE]).toEqual([SECOND, SECOND]);
    expect(readdirSync(first.keys.root).sort()).toEqual([USE_CASE, 'shared']);
    expect(readdirSync(second.keys.root).sort()).toEqual([SECOND, 'shared']);
    FactsFile.open(join(second.stateDir, 'facts.json'), { useCase: SECOND, network: 'vector-mainnet' }).put('holds', ['clean'], { suspendTx: null, liftTx: null });
    expect(second.facts().holds).toEqual({ clean: { suspendTx: null, liftTx: null } });
    expect(first.facts().holds).toEqual({});
  });
});

describe('a public key file of the earlier name', () => {
  /** A key folder with the keys made and the public key file under the earlier name only, as an earlier run of the pack left it. */
  async function earlierWorld(): Promise<{ w: TaskWorld; root: string; earlier: string }> {
    const { w, root } = await emptyWorld();
    expect(await submit(w)).toBe(0);
    const earlier = join(root, LEGACY_PUBLIC_MANIFEST);
    const text = manifestOf(root);
    rmSync(join(root, MANIFEST));
    writeFileSync(earlier, text, { mode: 0o600 });
    reset(w);
    return { w, root, earlier };
  }
  it('is read by the status, which says that it equals the key files and which file a submit run writes', async () => {
    const { w, root } = await earlierWorld();
    expect(await w.run(keysTask, 'status')).toBe(0);
    expect(w.screen.text).toContain(`the public key file equals the key files (it is the file ${LEGACY_PUBLIC_MANIFEST} of the earlier name: a run with --submit writes ${MANIFEST})`);
    expect(existsSync(join(root, MANIFEST))).toBe(false);
  });
  it('is read by a submit run, which writes the file of the use case with the same content, keeps the earlier file as it is, and finds nothing to change at the next run', async () => {
    const { w, root, earlier } = await earlierWorld();
    const text = readFileSync(earlier, 'utf8');
    expect(await submit(w)).toBe(0);
    expect(manifestOf(root)).toBe(text);
    expect(readFileSync(earlier, 'utf8')).toBe(text);
    expect(w.screen.text).toContain(`the public key file is written under the name ${MANIFEST}`);
    expect(w.machine()).toMatchObject({ outcome: 'done', result: { made: [], kept: NAMES } });
    reset(w);
    expect(await submit(w)).toBe(0);
    expect(w.machine()).toMatchObject({ outcome: 'finished' });
  });
  it('still guards the run wallet: a lost run key stops the run, in a dry run too, while only the earlier file shows its address', async () => {
    const { w, root } = await earlierWorld();
    const runAddress = registryOf(root).addressOf('run');
    rmSync(fileOf(root, SPECS[0]!));
    for (const argv of [['--submit'], []]) {
      reset(w);
      expect(await w.run(keysTask, ...argv)).toBe(2);
      expect(w.screen.errorText).toContain(`the run key file is missing, and the public key file shows the run wallet ${runAddress}: funds may be there`);
      expect(existsSync(fileOf(root, SPECS[0]!))).toBe(false);
    }
  });
  it('does not make another use-case key in place of one that the earlier file records', async () => {
    const { w, root, earlier } = await earlierWorld();
    const before = readFileSync(earlier, 'utf8');
    const keyPath = fileOf(root, SPECS[2]!);
    const original = readFileSync(keyPath, 'utf8');
    rmSync(keyPath);
    expect(await submit(w)).toBe(2);
    expect(w.screen.errorText).toContain('the key alpha is missing');
    expect(existsSync(keyPath)).toBe(false);
    expect(existsSync(join(root, MANIFEST))).toBe(false);
    writeSeed(root, USE_CASE, 'alpha', original);
    reset(w);
    expect(await submit(w)).toBe(0);
    expect(manifestOf(root)).toBe(before);
    expect(readFileSync(earlier, 'utf8')).toBe(before);
  });
  it('is no public key file of a use case that it does not name', async () => {
    const { w, earlier } = await earlierWorld();
    writeFileSync(earlier, readFileSync(earlier, 'utf8').split(`"use_case": "${USE_CASE}"`).join('"use_case": "another-case"'), { mode: 0o600 });
    expect(await w.run(keysTask, 'status')).toBe(0);
    expect(w.screen.text).toContain('the public key file does not exist');
  });
});
