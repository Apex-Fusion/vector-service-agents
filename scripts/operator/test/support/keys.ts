// Key files for the tests of the operator pack. A test names its keys, and this module makes a key folder in the temporary directory (mode 700) with one key file for each name (mode 600),
// then loads the registry over them. Each seed comes from a counter at run time, so no key is written into a source file, and no run needs a real key. `removeTestKeys` deletes the folders.
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadRegistry } from '../../lib/registry.ts';
import type { KeySpec, Registry } from '../../lib/registry.ts';

const roots: string[] = [];
let counter = 0;

/** A seed that a counter makes at run time: 64 lower-case hex characters, new on each call. */
export function counterSeed(): string {
  counter += 1;
  return createHash('sha256').update(`operator test key ${counter}`).digest('hex');
}

/** An empty key folder in the temporary directory, with mode 700 as a key folder must have. `removeTestKeys` deletes it. */
export function makeKeyRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'operator-keys-'));
  chmodSync(root, 0o700);
  roots.push(root);
  return root;
}

/** Writes one key file below `root`, in the folder `folder`: the folder is made with mode 700 when it is missing, and the file gets `mode` (600 by default). It gives the path of the file. */
export function writeSeed(root: string, folder: string, name: string, text: string, mode = 0o600): string {
  const dir = join(root, folder);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const path = join(dir, `${name}.seed`);
  writeFileSync(path, text, { mode });
  chmodSync(path, mode);
  return path;
}

export interface TestKeys {
  readonly root: string;
  readonly useCase: string;
  readonly specs: readonly KeySpec[];
  readonly registry: Registry;
  /** The seed that the file of a key holds, for a test that looks for it in a text. */
  seedOf(name: string): string;
}

/**
 * A registry of test keys. `names` are the names of the keys; the names in `options.shared` have the scope `shared` and the others the scope `use-case`. The folder holds a file for
 * each name, and the registry loads all of them.
 */
export function makeTestKeys(names: readonly string[], options: { useCase?: string; shared?: readonly string[] } = {}): TestKeys {
  const useCase = options.useCase ?? 'test-use-case';
  const shared = new Set(options.shared ?? []);
  const root = makeKeyRoot();
  const seeds = new Map<string, string>();
  const specs: KeySpec[] = names.map((name) => ({ name, scope: shared.has(name) ? 'shared' : 'use-case', about: `The test key ${name}.` }));
  for (const spec of specs) {
    const seed = counterSeed();
    seeds.set(spec.name, seed);
    writeSeed(root, spec.scope === 'shared' ? 'shared' : useCase, spec.name, `${seed}\n`);
  }
  const registry = loadRegistry({ dir: root, useCase, specs });
  return {
    root, useCase, specs, registry,
    seedOf: (name) => {
      const seed = seeds.get(name);
      if (seed === undefined) throw new Error(`the test keys hold no key named ${name}`);
      return seed;
    },
  };
}

/** Deletes every folder that this module made. Call it in `afterAll`. */
export function removeTestKeys(): void {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
}
