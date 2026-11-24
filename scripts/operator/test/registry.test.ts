// The named key registry: it makes the key files, loads them, and never shows a seed. Each refusal has an accepted twin. No test uses a real key: every seed comes from a counter.
import { chmodSync, linkSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { afterAll, describe, expect, it } from 'vitest';
import { parseKeyText } from '../../checks/lib/keys.ts';
import { enterpriseAddressOf } from '../../checks/lib/platform.ts';
import { KeyStoreError, Registry, checkPublicManifest, loadRegistry, makeMissingKeys, writePublicManifest } from '../lib/registry.ts';
import type { KeySpec, KeyStoreIo } from '../lib/registry.ts';
import { counterSeed, makeKeyRoot, makeTestKeys, removeTestKeys, writeSeed } from './support/keys.ts';

afterAll(removeTestKeys);

const USE_CASE = 'test-case';
const spec = (name: string, scope: KeySpec['scope'] = 'use-case'): KeySpec => ({ name, scope, about: `The test key ${name}.` });
const THREE: readonly KeySpec[] = [spec('alpha', 'shared'), spec('bravo'), spec('charlie', 'shared')];
const modeOf = (path: string): number => statSync(path).mode & 0o777;
const seedFileOf = (root: string, key: KeySpec): string => join(root, key.scope === 'shared' ? 'shared' : USE_CASE, `${key.name}.seed`);
const fsError = (code: string, message: string): Error => Object.assign(new Error(message), { code });
const refusal = (run: () => unknown): KeyStoreError => {
  try { run(); } catch (err) { if (err instanceof KeyStoreError) return err; throw err; }
  throw new Error('the call did not refuse');
};
/** Every file below a folder, relative to it and written with a slash, sorted. */
function filesBelow(root: string, folder = ''): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(join(root, folder), { withFileTypes: true })) {
    const path = folder === '' ? entry.name : `${folder}/${entry.name}`;
    if (entry.isDirectory()) found.push(...filesBelow(root, path)); else found.push(path);
  }
  return found.sort();
}
/** The answer of the real `stat`, for a fake io that must answer for folders as the real one does. */
const realStat: KeyStoreIo['stat'] = (path) => {
  const stats = statSync(path, { throwIfNoEntry: false });
  return stats === undefined ? null : { isFile: stats.isFile(), isFolder: stats.isDirectory(), mode: stats.mode & 0o777 };
};
/** A key folder with the three keys, made by the registry itself. */
function madeRoot(): string {
  const root = makeKeyRoot();
  makeMissingKeys(root, USE_CASE, THREE);
  return root;
}

describe('makeMissingKeys', () => {
  it('makes each missing key in the folder of its scope: 64 lower-case hex characters and one newline, mode 600, in folders with mode 700', () => {
    const root = makeKeyRoot();
    expect(makeMissingKeys(root, USE_CASE, THREE)).toEqual({ made: ['alpha', 'bravo', 'charlie'], kept: [] });
    expect(filesBelow(root)).toEqual(['shared/alpha.seed', 'shared/charlie.seed', `${USE_CASE}/bravo.seed`]);
    for (const key of THREE) {
      expect(readFileSync(seedFileOf(root, key), 'utf8')).toMatch(/^[0-9a-f]{64}\n$/);
      expect(modeOf(seedFileOf(root, key))).toBe(0o600);
    }
    for (const folder of [root, join(root, 'shared'), join(root, USE_CASE)]) expect(modeOf(folder)).toBe(0o700);
    expect(new Set(THREE.map((key) => readFileSync(seedFileOf(root, key), 'utf8'))).size).toBe(3);
  });

  it('makes the key folder with mode 700 when it is not there, and the folder of a scope only when a key needs it', () => {
    const root = join(makeKeyRoot(), 'keys');
    expect(makeMissingKeys(root, USE_CASE, [spec('bravo')])).toEqual({ made: ['bravo'], kept: [] });
    expect(modeOf(root)).toBe(0o700);
    expect(modeOf(join(root, USE_CASE))).toBe(0o700);
    expect(filesBelow(root)).toEqual([`${USE_CASE}/bravo.seed`]);
  });

  it('keeps all three keys on a second call, makes nothing, and leaves each file as it was', () => {
    const root = madeRoot();
    const before = THREE.map((key) => readFileSync(seedFileOf(root, key), 'utf8'));
    expect(makeMissingKeys(root, USE_CASE, THREE)).toEqual({ made: [], kept: ['alpha', 'bravo', 'charlie'] });
    expect(THREE.map((key) => readFileSync(seedFileOf(root, key), 'utf8'))).toEqual(before);
    expect(filesBelow(root)).toHaveLength(3);
  });

  it('makes only the key whose file was deleted, and the other two stay as they were', () => {
    const root = madeRoot();
    const [alpha, bravo, charlie] = THREE.map((key) => readFileSync(seedFileOf(root, key), 'utf8'));
    rmSync(seedFileOf(root, THREE[1]!));
    expect(makeMissingKeys(root, USE_CASE, THREE)).toEqual({ made: ['bravo'], kept: ['alpha', 'charlie'] });
    expect(readFileSync(seedFileOf(root, THREE[0]!), 'utf8')).toBe(alpha);
    expect(readFileSync(seedFileOf(root, THREE[2]!), 'utf8')).toBe(charlie);
    expect(readFileSync(seedFileOf(root, THREE[1]!), 'utf8')).toMatch(/^[0-9a-f]{64}\n$/);
    expect(readFileSync(seedFileOf(root, THREE[1]!), 'utf8')).not.toBe(bravo);
  });

  it('never changes a file that exists: not its bytes and not its mode, whatever it holds', () => {
    const root = makeKeyRoot();
    const path = writeSeed(root, USE_CASE, 'bravo', 'this is not a key\n', 0o644);
    expect(makeMissingKeys(root, USE_CASE, [spec('bravo')])).toEqual({ made: [], kept: ['bravo'] });
    expect(readFileSync(path, 'utf8')).toBe('this is not a key\n');
    expect(modeOf(path)).toBe(0o644);
    expect(filesBelow(root)).toEqual([`${USE_CASE}/bravo.seed`]);
  });

  it('keeps a key whose file appears between the check and the link: the link never overwrites', () => {
    const root = makeKeyRoot();
    const seed = counterSeed();
    const path = writeSeed(root, USE_CASE, 'bravo', `${seed}\n`);
    const blind: Partial<KeyStoreIo> = { stat: (at) => (at.endsWith('bravo.seed') ? null : realStat(at)) };
    expect(makeMissingKeys(root, USE_CASE, [spec('bravo')], blind)).toEqual({ made: [], kept: ['bravo'] });
    expect(readFileSync(path, 'utf8')).toBe(`${seed}\n`);
    expect(filesBelow(root)).toEqual([`${USE_CASE}/bravo.seed`]);
  });

  it('takes the 32 bytes of each key from the random source of the io, and the keys of the real source differ', () => {
    const root = makeKeyRoot();
    const seeds = [counterSeed(), counterSeed()];
    let next = 0;
    makeMissingKeys(root, USE_CASE, [spec('alpha'), spec('bravo')], { randomSeed: () => Buffer.from(seeds[next++]!, 'hex') });
    expect(readFileSync(seedFileOf(root, spec('alpha')), 'utf8')).toBe(`${seeds[0]}\n`);
    expect(readFileSync(seedFileOf(root, spec('bravo')), 'utf8')).toBe(`${seeds[1]}\n`);
    const real = madeRoot();
    const hashes = THREE.map((key) => parseKeyText(readFileSync(seedFileOf(real, key), 'utf8').trim(), key.name).keyHash);
    expect(new Set(hashes).size).toBe(3);
  });

  it('refuses a key folder with mode 755 and makes nothing; with mode 700 it makes the keys', () => {
    const root = makeKeyRoot();
    chmodSync(root, 0o755);
    const err = refusal(() => makeMissingKeys(root, USE_CASE, THREE));
    expect(err.reason).toBe('folder');
    expect(err.message).toMatch(/mode 755.*mode 700/);
    expect(filesBelow(root)).toEqual([]);
    chmodSync(root, 0o700);
    expect(makeMissingKeys(root, USE_CASE, THREE).made).toEqual(['alpha', 'bravo', 'charlie']);
  });

  it('refuses the folder of a scope with mode 755, and a key folder that is a file', () => {
    const root = madeRoot();
    chmodSync(join(root, 'shared'), 0o755);
    const err = refusal(() => makeMissingKeys(root, USE_CASE, THREE));
    expect(err.reason).toBe('folder');
    expect(err.message).toMatch(/shared.*mode 755.*mode 700/);
    chmodSync(join(root, 'shared'), 0o700);
    expect(makeMissingKeys(root, USE_CASE, THREE).kept).toEqual(['alpha', 'bravo', 'charlie']);
    const file = join(makeKeyRoot(), 'a-file');
    writeFileSync(file, '', { mode: 0o700 });
    expect(refusal(() => makeMissingKeys(file, USE_CASE, THREE)).reason).toBe('folder');
  });

  it('leaves no key file and no temporary file when the write fails after the bytes are down, when the link fails, and when the random source fails', () => {
    const failures: [string, Partial<KeyStoreIo>][] = [
      ['the write', { writeNew: (path, bytes) => { writeFileSync(path, bytes, { flag: 'wx', mode: 0o600 }); throw fsError('ENOSPC', `the write of ${path} failed`); } }],
      ['the link', { link: (from, to) => { throw fsError('EIO', `the link of ${from} to ${to} failed`); } }],
      ['the random source', { randomSeed: () => { throw fsError('EIO', 'no random bytes'); } }],
      ['a random source that gives 31 bytes', { randomSeed: () => Buffer.alloc(31, 1) }],
    ];
    for (const [stage, io] of failures) {
      const root = makeKeyRoot();
      const err = refusal(() => makeMissingKeys(root, USE_CASE, THREE, io));
      expect(err.reason, stage).toBe('folder');
      expect(err.message, stage).toContain('alpha');
      expect(filesBelow(root), stage).toEqual([]);
    }
  });

  it('keeps the keys that it made before a failure, and a new call makes the rest', () => {
    const root = makeKeyRoot();
    const failsForBravo: Partial<KeyStoreIo> = { link: (from, to) => { if (to.endsWith('bravo.seed')) throw fsError('EIO', 'the link failed'); linkSync(from, to); } };
    expect(refusal(() => makeMissingKeys(root, USE_CASE, THREE, failsForBravo)).message).toContain('bravo');
    expect(filesBelow(root)).toEqual(['shared/alpha.seed']);
    expect(makeMissingKeys(root, USE_CASE, THREE)).toEqual({ made: ['bravo', 'charlie'], kept: ['alpha'] });
  });

  it('refuses a temporary file that it cannot remove, and says which key it is', () => {
    const root = makeKeyRoot();
    const err = refusal(() => makeMissingKeys(root, USE_CASE, [spec('bravo')], { remove: () => { throw fsError('EPERM', 'the remove failed'); } }));
    expect(err.reason).toBe('folder');
    expect(err.message).toContain('bravo');
  });
});

describe('the list of keys', () => {
  const BAD: [string, KeySpec[]][] = [
    ['a name in upper case', [spec('Alpha')]],
    ['a name that starts with a digit', [spec('1alpha')]],
    ['a name with an underscore', [spec('al_pha')]],
    ['a name with a dot', [spec('al.pha')]],
    ['a name that is a path', [spec('../alpha')]],
    ['an empty name', [spec('')]],
    ['a name of 49 characters', [spec('a'.repeat(49))]],
    ['a scope that is neither shared nor use-case', [{ name: 'alpha', scope: 'private' as KeySpec['scope'], about: 'A key.' }]],
    ['an empty about text', [{ name: 'alpha', scope: 'shared', about: '  ' }]],
    ['65 keys', Array.from({ length: 65 }, (_, i) => spec(`key-${i}`))],
  ];
  for (const [label, specs] of BAD) {
    it(`refuses ${label}, in the make call and in the load call, and makes nothing`, () => {
      const root = makeKeyRoot();
      expect(refusal(() => makeMissingKeys(root, USE_CASE, specs)).reason).toBe('shape');
      expect(refusal(() => loadRegistry({ dir: root, useCase: USE_CASE, specs })).reason).toBe('shape');
      expect(filesBelow(root)).toEqual([]);
    });
  }
  it('refuses two keys with one name, and names it', () => {
    const root = makeKeyRoot();
    const err = refusal(() => makeMissingKeys(root, USE_CASE, [spec('alpha'), spec('alpha', 'shared')]));
    expect(err.reason).toBe('duplicate');
    expect(err.message).toContain('alpha');
    expect(refusal(() => loadRegistry({ dir: root, useCase: USE_CASE, specs: [spec('alpha'), spec('alpha')] })).reason).toBe('duplicate');
  });
  it('accepts a name of 48 characters, a name with digits and hyphens, and 64 keys', () => {
    const specs = [spec('a'.repeat(48)), spec('stock-reader-2'), ...Array.from({ length: 62 }, (_, i) => spec(`key-${i}`))];
    expect(specs).toHaveLength(64);
    const root = makeKeyRoot();
    expect(makeMissingKeys(root, USE_CASE, specs).made).toHaveLength(64);
    expect(loadRegistry({ dir: root, useCase: USE_CASE, specs }).names()).toHaveLength(64);
  });
  for (const useCase of ['shared', 'Upper', '../up', 'a/b', '', 'x'.repeat(49)]) {
    it(`refuses the use case name "${useCase}", which cannot be the name of a folder of its own`, () => {
      const root = makeKeyRoot();
      expect(refusal(() => makeMissingKeys(root, useCase, THREE)).reason).toBe('shape');
      expect(refusal(() => loadRegistry({ dir: root, useCase, specs: THREE })).reason).toBe('shape');
    });
  }
  it('accepts the use case names inventory-reorder and a', () => {
    for (const useCase of ['inventory-reorder', 'a']) expect(makeMissingKeys(makeKeyRoot(), useCase, [spec('bravo')]).made).toEqual(['bravo']);
  });
});

describe('loadRegistry', () => {
  it('loads the keys that makeMissingKeys made, with the key hash, the address and the public key of each', () => {
    const root = madeRoot();
    const registry = loadRegistry({ dir: root, useCase: USE_CASE, specs: THREE });
    expect(registry).toBeInstanceOf(Registry);
    expect(registry.names()).toEqual(['alpha', 'bravo', 'charlie']);
    expect(registry.isComplete()).toBe(true);
    expect(registry.useCase).toBe(USE_CASE);
    for (const key of THREE) {
      const seed = readFileSync(seedFileOf(root, key), 'utf8').trim();
      const own = parseKeyText(seed, key.name);
      expect(registry.has(key.name)).toBe(true);
      expect(registry.hashOf(key.name)).toBe(own.keyHash);
      expect(registry.hashOf(key.name)).toMatch(/^[0-9a-f]{56}$/);
      expect(registry.addressOf(key.name)).toBe(own.address);
      expect(registry.addressOf(key.name)).toBe(enterpriseAddressOf(own.keyHash));
      expect(registry.publicKeyOf(key.name)).toBe(own.publicKeyHex);
      expect(registry.key(key.name).keyHash).toBe(own.keyHash);
      expect(registry.key(key.name).role).toBe(key.name);
      expect(registry.secretHexForEnv(key.name)).toBe(seed);
    }
  });

  it('gives the ring that holds each key by hash and by name, and names a hash', () => {
    const keys = makeTestKeys(['alpha', 'bravo'], { shared: ['alpha'] });
    const { registry } = keys;
    for (const name of ['alpha', 'bravo']) {
      const hash = registry.hashOf(name);
      expect(registry.ring.has(hash)).toBe(true);
      expect(registry.ring.get(name).keyHash).toBe(hash);
      expect(registry.ring.roleOf(hash)).toBe(name);
      expect(registry.nameOfHash(hash)).toBe(name);
      expect(registry.ring.wallets().get(hash)).toBe(registry.addressOf(name));
    }
    expect(registry.ring.has('00'.repeat(28))).toBe(false);
    expect(registry.nameOfHash('00'.repeat(28))).toBeUndefined();
    expect(registry.ring.keyHashes().size).toBe(2);
  });

  it('keeps the order of the list for names(), whatever the folder holds and whatever order need gives', () => {
    const keys = makeTestKeys(['charlie', 'alpha', 'bravo']);
    expect(keys.registry.names()).toEqual(['charlie', 'alpha', 'bravo']);
    const some = loadRegistry({ dir: keys.root, useCase: keys.useCase, specs: keys.specs, need: ['bravo', 'charlie'] });
    expect(some.names()).toEqual(['charlie', 'bravo']);
  });

  it('reads only the files that need names: the file of another key may be missing or wrong, and the registry holds no such key', () => {
    const root = makeKeyRoot();
    writeSeed(root, 'shared', 'alpha', `${counterSeed()}\n`);
    writeSeed(root, USE_CASE, 'bravo', 'not a key', 0o644);
    const registry = loadRegistry({ dir: root, useCase: USE_CASE, specs: THREE, need: ['alpha'] });
    expect(registry.names()).toEqual(['alpha']);
    expect(registry.isComplete()).toBe(false);
    expect(registry.has('bravo')).toBe(false);
    expect(refusal(() => registry.key('bravo')).reason).toBe('unknown_name');
    expect(refusal(() => registry.hashOf('bravo')).reason).toBe('unknown_name');
    expect(refusal(() => registry.secretHexForEnv('bravo')).reason).toBe('unknown_name');
    expect(refusal(() => loadRegistry({ dir: root, useCase: USE_CASE, specs: THREE, need: ['alpha', 'bravo'] })).reason).toBe('mode');
    expect(refusal(() => loadRegistry({ dir: root, useCase: USE_CASE, specs: THREE })).reason).toBe('mode');
  });

  it('loads no file and reads no folder for an empty need, even when the key folder is not there', () => {
    const root = join(makeKeyRoot(), 'not-made-yet');
    const registry = loadRegistry({ dir: root, useCase: USE_CASE, specs: THREE, need: [] });
    expect(registry.names()).toEqual([]);
    expect(registry.has('alpha')).toBe(false);
    expect(registry.ring.keyHashes().size).toBe(0);
    expect(refusal(() => loadRegistry({ dir: root, useCase: USE_CASE, specs: THREE })).reason).toBe('missing');
  });

  it('refuses a name in need that the list does not hold', () => {
    const root = madeRoot();
    const err = refusal(() => loadRegistry({ dir: root, useCase: USE_CASE, specs: THREE, need: ['alpha', 'delta'] }));
    expect(err.reason).toBe('unknown_name');
    expect(err.message).toContain('delta');
    expect(loadRegistry({ dir: root, useCase: USE_CASE, specs: THREE, need: ['alpha'] }).names()).toEqual(['alpha']);
  });

  it('refuses a missing key file and names the key', () => {
    const root = madeRoot();
    rmSync(seedFileOf(root, THREE[1]!));
    const err = refusal(() => loadRegistry({ dir: root, useCase: USE_CASE, specs: THREE }));
    expect(err.reason).toBe('missing');
    expect(err.message).toContain('bravo');
    expect(loadRegistry({ dir: root, useCase: USE_CASE, specs: THREE, need: ['alpha', 'charlie'] }).names()).toEqual(['alpha', 'charlie']);
  });

  it('refuses a key file that is not a regular file', () => {
    const root = madeRoot();
    rmSync(seedFileOf(root, THREE[1]!));
    mkdirSync(seedFileOf(root, THREE[1]!), { mode: 0o600 });
    expect(refusal(() => loadRegistry({ dir: root, useCase: USE_CASE, specs: THREE })).reason).toBe('unreadable');
  });

  for (const mode of [0o644, 0o640, 0o660, 0o666, 0o400, 0o700]) {
    it(`refuses a key file with mode ${mode.toString(8)} and names the key and the mode that it needs`, () => {
      const root = madeRoot();
      chmodSync(seedFileOf(root, THREE[1]!), mode);
      const err = refusal(() => loadRegistry({ dir: root, useCase: USE_CASE, specs: THREE }));
      expect(err.reason).toBe('mode');
      expect(err.message).toContain('bravo');
      expect(err.message).toContain(`mode ${mode.toString(8)}`);
      expect(err.message).toContain('mode 600');
      chmodSync(seedFileOf(root, THREE[1]!), 0o600);
      expect(loadRegistry({ dir: root, useCase: USE_CASE, specs: THREE }).names()).toHaveLength(3);
    });
  }

  it('refuses a key folder and a folder of a scope with mode 755, and accepts them with mode 700', () => {
    const root = madeRoot();
    for (const folder of [root, join(root, 'shared'), join(root, USE_CASE)]) {
      chmodSync(folder, 0o755);
      const err = refusal(() => loadRegistry({ dir: root, useCase: USE_CASE, specs: THREE }));
      expect(err.reason).toBe('folder');
      expect(err.message).toMatch(/mode 755.*mode 700/);
      chmodSync(folder, 0o700);
      expect(loadRegistry({ dir: root, useCase: USE_CASE, specs: THREE }).names()).toHaveLength(3);
    }
  });

  describe('the text of a key file', () => {
    const seed = counterSeed();
    const REFUSED: [string, string][] = [
      ['63 characters', seed.slice(0, 63)],
      ['65 characters', `${seed}0`],
      ['upper case', seed.toUpperCase()],
      ['one upper-case character', `${seed.slice(0, 10)}${seed.charAt(10).toUpperCase() === seed.charAt(10) ? 'A' : seed.charAt(10).toUpperCase()}${seed.slice(11)}`],
      ['a prefix', `0x${seed}`],
      ['a name and a value', `ALPHA=${seed}`],
      ['the same text twice', `${seed}\n${seed}\n`],
      ['two newlines', `${seed}\n\n`],
      ['a carriage return', `${seed}\r\n`],
      ['a space', `${seed} \n`],
      ['a space in front', ` ${seed}\n`],
      ['characters that are not hex', `${seed.slice(0, 63)}g`],
      ['no text', ''],
      ['only a newline', '\n'],
    ];
    for (const [label, text] of REFUSED) {
      it(`refuses a text of ${label}`, () => {
        const root = makeKeyRoot();
        writeSeed(root, 'shared', 'alpha', text);
        const err = refusal(() => loadRegistry({ dir: root, useCase: USE_CASE, specs: [spec('alpha', 'shared')] }));
        expect(err.reason).toBe('shape');
        expect(err.message).toContain('alpha');
        expect(err.message).toContain('64 lower-case hex');
      });
    }
    it('accepts the text with one newline and the text without a newline, and they give the same key', () => {
      const root = makeKeyRoot();
      writeSeed(root, 'shared', 'alpha', `${seed}\n`);
      writeSeed(root, USE_CASE, 'bravo', seed);
      const registry = loadRegistry({ dir: root, useCase: USE_CASE, specs: [spec('alpha', 'shared')] });
      expect(registry.secretHexForEnv('alpha')).toBe(seed);
      const same = loadRegistry({ dir: root, useCase: USE_CASE, specs: [spec('bravo')] });
      expect(same.secretHexForEnv('bravo')).toBe(seed);
      expect(same.hashOf('bravo')).toBe(registry.hashOf('alpha'));
    });
  });

  it('refuses two files that hold one key, and names both keys; two different keys load', () => {
    const root = madeRoot();
    const copy = readFileSync(seedFileOf(root, THREE[0]!), 'utf8');
    writeFileSync(seedFileOf(root, THREE[2]!), copy);
    const err = refusal(() => loadRegistry({ dir: root, useCase: USE_CASE, specs: THREE }));
    expect(err.reason).toBe('duplicate');
    expect(err.message).toContain('alpha');
    expect(err.message).toContain('charlie');
    expect(loadRegistry({ dir: root, useCase: USE_CASE, specs: THREE, need: ['alpha', 'bravo'] }).names()).toEqual(['alpha', 'bravo']);
    expect(refusal(() => loadRegistry({ dir: root, useCase: USE_CASE, specs: THREE, need: ['alpha', 'charlie'] })).reason).toBe('duplicate');
    rmSync(seedFileOf(root, THREE[2]!));
    makeMissingKeys(root, USE_CASE, THREE);
    expect(loadRegistry({ dir: root, useCase: USE_CASE, specs: THREE }).names()).toHaveLength(3);
  });

  it('ignores a file that no key names: the member copy, a text file, a leftover temporary file and a file with a wrong mode', () => {
    const root = madeRoot();
    writeSeed(root, 'shared', 'member', 'this is the member copy', 0o644);
    writeSeed(root, USE_CASE, '.bravo.0123456789ab.tmp', 'left over');
    writeFileSync(join(root, 'shared', 'README.txt'), 'notes', { mode: 0o666 });
    writeFileSync(join(root, 'keys-public.json'), '{}', { mode: 0o644 });
    expect(loadRegistry({ dir: root, useCase: USE_CASE, specs: THREE }).names()).toEqual(['alpha', 'bravo', 'charlie']);
  });

  it('keeps each seed from the load: a file that changes later does not change the registry', () => {
    const keys = makeTestKeys(['alpha']);
    const before = keys.registry.secretHexForEnv('alpha');
    writeFileSync(join(keys.root, keys.useCase, 'alpha.seed'), `${counterSeed()}\n`);
    expect(keys.registry.secretHexForEnv('alpha')).toBe(before);
    expect(before).toBe(keys.seedOf('alpha'));
  });

  it('gives a seed through secretHexForEnv only: 64 hex characters for a known name, and a refusal for an unknown name', () => {
    const keys = makeTestKeys(['alpha', 'bravo']);
    expect(keys.registry.secretHexForEnv('bravo')).toMatch(/^[0-9a-f]{64}$/);
    expect(keys.registry.secretHexForEnv('bravo')).toBe(keys.seedOf('bravo'));
    expect(keys.registry.secretHexForEnv('bravo')).not.toBe(keys.registry.secretHexForEnv('alpha'));
    for (const name of ['delta', '', '__proto__', 'constructor', 'ALPHA']) {
      const err = refusal(() => keys.registry.secretHexForEnv(name));
      expect(err.reason).toBe('unknown_name');
    }
  });
});

describe('what an error or the registry shows', () => {
  const seeds: string[] = [];
  const roots: string[] = [];
  const errors: Error[] = [];
  const marker = (): string => { const seed = counterSeed(); seeds.push(seed); return seed; };
  const root = (): string => { const made = makeKeyRoot(); roots.push(made); return made; };
  const trap = (run: () => unknown): void => { try { run(); } catch (err) { errors.push(err instanceof Error ? err : new Error(String(err))); } };

  /** The markers that appear in a text, in either case: a whole seed, its first 16 characters or its last 16 characters, and the path of a key folder. */
  function leaks(texts: readonly string[]): string[] {
    const found = texts.map((text) => text.toLowerCase());
    const needles = [...seeds.flatMap((seed) => [seed, seed.slice(0, 16), seed.slice(-16)]), ...roots];
    return needles.filter((needle) => found.some((text) => text.includes(needle.toLowerCase())));
  }

  it('is checked with a control: the search finds a seed in a text that holds one, in upper case too', () => {
    const control = counterSeed();
    seeds.push(control);
    expect(leaks([`error: ${control}`])).toContain(control);
    expect(leaks([`error: ${control.toUpperCase()}`])).toContain(control);
    expect(leaks([`error: ${control.slice(0, 16)}`])).toContain(control.slice(0, 16));
    expect(leaks(['a text with no marker'])).toEqual([]);
  });

  it('holds no seed, no file text and no path in the message, the string, the inspect text or the JSON of any refusal', () => {
    const specs = [spec('alpha', 'shared')];
    const badTexts: ((seed: string) => string)[] = [(s) => s.slice(0, 63), (s) => s.toUpperCase(), (s) => `0x${s}`, (s) => `${s}\n${s}`, (s) => `${s}00`, (s) => `ALPHA=${s}`];
    for (const bad of badTexts) {
      const dir = root();
      writeSeed(dir, 'shared', 'alpha', bad(marker()));
      trap(() => loadRegistry({ dir, useCase: USE_CASE, specs }));
    }
    const wrongMode = root();
    writeSeed(wrongMode, 'shared', 'alpha', `${marker()}\n`, 0o644);
    trap(() => loadRegistry({ dir: wrongMode, useCase: USE_CASE, specs }));
    const twins = root();
    const same = marker();
    writeSeed(twins, 'shared', 'alpha', `${same}\n`);
    writeSeed(twins, USE_CASE, 'bravo', `${same}\n`);
    trap(() => loadRegistry({ dir: twins, useCase: USE_CASE, specs: [spec('alpha', 'shared'), spec('bravo')] }));
    const wrongFolder = root();
    writeSeed(wrongFolder, 'shared', 'alpha', `${marker()}\n`);
    chmodSync(join(wrongFolder, 'shared'), 0o755);
    trap(() => loadRegistry({ dir: wrongFolder, useCase: USE_CASE, specs }));
    trap(() => loadRegistry({ dir: root(), useCase: USE_CASE, specs }));
    trap(() => loadRegistry({ dir: wrongFolder, useCase: USE_CASE, specs, need: ['delta'] }));
    const keys = makeTestKeys(['alpha']);
    seeds.push(keys.seedOf('alpha'));
    roots.push(keys.root);
    trap(() => keys.registry.secretHexForEnv('delta'));
    trap(() => keys.registry.key('delta'));
    trap(() => makeMissingKeys(root(), 'shared', specs));
    trap(() => makeMissingKeys(root(), USE_CASE, [spec('Alpha')]));
    const BREAKS: Record<keyof KeyStoreIo, (fails: () => never) => Partial<KeyStoreIo>> = {
      stat: (fails) => ({ stat: fails }), read: (fails) => ({ read: fails }), writeNew: (fails) => ({ writeNew: fails }), link: (fails) => ({ link: fails }),
      remove: (fails) => ({ remove: fails }), flushFolder: (fails) => ({ flushFolder: fails }), makeFolder: (fails) => ({ makeFolder: fails, stat: () => null }), randomSeed: (fails) => ({ randomSeed: fails }),
    };
    for (const stage of Object.keys(BREAKS) as (keyof KeyStoreIo)[]) {
      const dir = root();
      const fails = (): never => { throw fsError('EIO', `the ${stage} failed with ${marker()} at ${join(dir, 'shared', 'alpha.seed')}`); };
      trap(() => makeMissingKeys(dir, USE_CASE, specs, BREAKS[stage](fails)));
      writeSeed(dir, 'shared', 'alpha', `${marker()}\n`);
      trap(() => loadRegistry({ dir, useCase: USE_CASE, specs, io: BREAKS[stage](fails) }));
    }
    const publicFile = join(root(), 'keys-public.json');
    writePublicManifest(publicFile, keys.registry, { network: 'test-network', useCase: keys.useCase });
    writeFileSync(publicFile, `{"note": "${marker()}"`);
    trap(() => checkPublicManifest(publicFile, keys.registry));
    trap(() => checkPublicManifest(join(root(), 'missing.json'), keys.registry));
    expect(errors.length).toBeGreaterThanOrEqual(25);
    for (const err of errors) {
      expect(err).toBeInstanceOf(KeyStoreError);
      expect(leaks([err.message, String(err), inspect(err, { depth: 10, showHidden: true }), JSON.stringify(err)]), err.message).toEqual([]);
    }
  });

  it('shows no seed when the registry or a key of it is turned to a string, to JSON or to an inspect text', () => {
    const keys = makeTestKeys(['alpha', 'bravo'], { shared: ['alpha'] });
    const seedsOfKeys = ['alpha', 'bravo'].map((name) => keys.seedOf(name));
    const texts = [
      String(keys.registry), `${keys.registry}`, JSON.stringify(keys.registry), inspect(keys.registry), inspect(keys.registry, { depth: 10, showHidden: true }),
      JSON.stringify(keys.registry.ring), inspect(keys.registry.ring, { depth: 10, showHidden: true }), String(keys.registry.key('alpha')), JSON.stringify(keys.registry.key('alpha')),
      inspect(keys.registry.key('alpha'), { depth: 10, showHidden: true }), JSON.stringify(keys.registry.publicManifest('test-network')), JSON.stringify(keys.registry.names()),
    ].map((text) => text.toLowerCase());
    for (const seed of seedsOfKeys) {
      for (const needle of [seed, seed.slice(0, 16), seed.slice(-16)]) expect(texts.filter((text) => text.includes(needle))).toEqual([]);
    }
    expect(String(keys.registry)).toContain('alpha');
    expect(JSON.parse(JSON.stringify(keys.registry))).toEqual({ useCase: keys.useCase, names: ['alpha', 'bravo'] });
  });
});

describe('the public key file', () => {
  type Entry = { scope: string; about: string; public_key_hex: string; key_hash: string; address: string };
  interface Shown { note: string; network: string; use_case: string; keys: Record<string, Entry>; [extra: string]: unknown }
  const NAMES = ['alpha', 'bravo', 'charlie'] as const;
  const flip = (hex: string): string => `${hex.slice(0, -1)}${hex.endsWith('0') ? '1' : '0'}`;
  const read = (path: string): Shown => JSON.parse(readFileSync(path, 'utf8')) as Shown;
  const rewrite = (path: string, change: (shown: Shown) => void): void => { const shown = read(path); change(shown); writeFileSync(path, `${JSON.stringify(shown, null, 2)}\n`); };
  /** The entry of a key as a plain map, so that a test can add a member that the entry does not have and remove one that it has. */
  const looseEntry = (shown: Shown, name: string): Record<string, unknown> => shown.keys[name]!;

  /** Test keys, the registry over them and the public file that the registry wrote. */
  function written() {
    const keys = makeTestKeys(NAMES, { shared: ['alpha', 'charlie'] });
    const path = join(keys.root, 'keys-public.json');
    writePublicManifest(path, keys.registry, { network: 'test-network', useCase: keys.useCase });
    return { ...keys, path };
  }

  it('holds the scope, the about text, the public key, the key hash and the address of each key, as the key files give them, and no seed', () => {
    const { registry, path, seedOf, specs, useCase } = written();
    const shown = read(path);
    expect(Object.keys(shown)).toEqual(['note', 'network', 'use_case', 'keys']);
    expect(shown.network).toBe('test-network');
    expect(shown.use_case).toBe(useCase);
    expect(typeof shown.note).toBe('string');
    expect(Object.keys(shown.keys)).toEqual([...NAMES]);
    for (const key of specs) {
      const own = parseKeyText(seedOf(key.name), key.name);
      expect(shown.keys[key.name]).toEqual({ scope: key.scope, about: key.about, public_key_hex: own.publicKeyHex, key_hash: own.keyHash, address: own.address });
      expect(Object.keys(shown.keys[key.name]!)).toEqual(['scope', 'about', 'public_key_hex', 'key_hash', 'address']);
    }
    const text = readFileSync(path, 'utf8').toLowerCase();
    for (const name of NAMES) expect(text.includes(seedOf(name))).toBe(false);
    expect(text.endsWith('}\n')).toBe(true);
    expect(modeOf(path)).toBe(0o600);
    expect(registry.publicManifest('test-network')).toEqual(shown);
  });

  it('is accepted by checkPublicManifest when it equals what the files give, whatever its layout', () => {
    const { registry, path } = written();
    expect(() => checkPublicManifest(path, registry)).not.toThrow();
    writeFileSync(path, JSON.stringify(read(path)));
    expect(() => checkPublicManifest(path, registry)).not.toThrow();
  });

  const CHANGES: [string, (shown: Shown) => void][] = [
    ['a changed key hash', (shown) => { shown.keys.bravo!.key_hash = flip(shown.keys.bravo!.key_hash); }],
    ['a changed public key', (shown) => { shown.keys.bravo!.public_key_hex = flip(shown.keys.bravo!.public_key_hex); }],
    ['a changed address', (shown) => { shown.keys.bravo!.address = flip(shown.keys.bravo!.address); }],
    ['a changed scope', (shown) => { shown.keys.bravo!.scope = 'shared'; }],
    ['a changed about text', (shown) => { shown.keys.bravo!.about = 'Another text.'; }],
    ['a missing key', (shown) => { delete shown.keys.bravo; }],
    ['an added key', (shown) => { shown.keys.delta = { ...shown.keys.bravo! }; }],
    ['a member that an entry does not have', (shown) => { looseEntry(shown, 'bravo').extra = 'x'; }],
    ['a missing member of an entry', (shown) => { delete looseEntry(shown, 'bravo').about; }],
    ['a member that the file does not have', (shown) => { shown.extra = 'x'; }],
    ['another use case', (shown) => { shown.use_case = 'another-case'; }],
    ['an empty network', (shown) => { shown.network = ''; }],
    ['a note that is not text', (shown) => { shown.note = 1 as unknown as string; }],
    ['a list in place of the keys', (shown) => { shown.keys = [] as unknown as Shown['keys']; }],
  ];
  for (const [label, change] of CHANGES) {
    it(`is refused by checkPublicManifest with ${label}`, () => {
      const { registry, path } = written();
      rewrite(path, change);
      const err = refusal(() => checkPublicManifest(path, registry));
      expect(err.reason).toBe('manifest');
    });
  }
  it('is refused by checkPublicManifest when the file is not there, is not JSON, or is a list', () => {
    const { registry, path } = written();
    expect(refusal(() => checkPublicManifest(join(path, '..', 'missing.json'), registry)).reason).toBe('manifest');
    writeFileSync(path, 'not json');
    expect(refusal(() => checkPublicManifest(path, registry)).reason).toBe('manifest');
    writeFileSync(path, '[]');
    expect(refusal(() => checkPublicManifest(path, registry)).reason).toBe('manifest');
  });
  it('is refused after a key file is lost and made again: the new key has another hash, so the old file does not equal the files', () => {
    const { registry, path, root, useCase, specs } = written();
    rmSync(join(root, useCase, 'bravo.seed'));
    expect(makeMissingKeys(root, useCase, specs).made).toEqual(['bravo']);
    const again = loadRegistry({ dir: root, useCase, specs });
    expect(() => checkPublicManifest(path, registry)).not.toThrow();
    expect(refusal(() => checkPublicManifest(path, again)).reason).toBe('manifest');
    writePublicManifest(path, again, { network: 'test-network', useCase });
    expect(() => checkPublicManifest(path, again)).not.toThrow();
  });

  it('is neither written nor checked by a registry that holds only some of the keys', () => {
    const { root, useCase, specs, path } = written();
    const part = loadRegistry({ dir: root, useCase, specs, need: ['alpha'] });
    expect(refusal(() => checkPublicManifest(path, part)).reason).toBe('manifest');
    const err = refusal(() => writePublicManifest(join(root, 'other.json'), part, { network: 'test-network', useCase }));
    expect(err.reason).toBe('manifest');
    expect(filesBelow(root)).not.toContain('other.json');
  });

  it('is not written for another use case or for an empty network name', () => {
    const { registry, root, useCase } = written();
    expect(refusal(() => writePublicManifest(join(root, 'a.json'), registry, { network: 'test-network', useCase: 'another-case' })).reason).toBe('manifest');
    expect(refusal(() => writePublicManifest(join(root, 'b.json'), registry, { network: '', useCase })).reason).toBe('manifest');
    expect(filesBelow(root).filter((file) => file.endsWith('.json'))).toEqual(['keys-public.json']);
    writePublicManifest(join(root, 'c.json'), registry, { network: 'test-network', useCase });
    expect(filesBelow(root)).toContain('c.json');
  });

  it('keeps the old file when the write fails, and writes the new one whole', () => {
    const { registry, path, root, useCase } = written();
    const before = readFileSync(path, 'utf8');
    expect(() => writePublicManifest(path, registry, { network: 'another-network', useCase }, { rename: () => { throw new Error('the rename failed'); } })).toThrow('the rename failed');
    expect(readFileSync(path, 'utf8')).toBe(before);
    writePublicManifest(path, registry, { network: 'another-network', useCase });
    expect(read(path).network).toBe('another-network');
    expect(modeOf(path)).toBe(0o600);
    expect(modeOf(root)).toBe(0o700);
  });
});
