// packages/id-kit/test/layers.test.ts: the client, the verifier, the shared code and the copied files never use the test helpers. A service that imports the package gets no stub gateway
// and no test key. The test reads the module specifiers of each source file of those layers, in every form that loads a module.
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = fileURLToPath(new URL('../src/', import.meta.url));
const LAYERS = ['client', 'verify', 'common', 'vendored'];

/** Every module specifier of a source text: static imports and exports, side effect imports, dynamic imports and require calls. A dynamic import of a value that is no literal gives null. */
function specifiers(text: string): Array<string | null> {
  const found: Array<string | null> = [];
  for (const m of text.matchAll(/\b(?:import|export)\b[^'"`;]*?\bfrom\s*(['"])([^'"]+)\1/g)) found.push(m[2]!);
  for (const m of text.matchAll(/\bimport\s*(['"])([^'"]+)\1/g)) found.push(m[2]!);
  for (const m of text.matchAll(/\b(?:import|require)\s*\(\s*(['"`])([^'"`]+)\1\s*\)/g)) found.push(m[2]!);
  for (const m of text.matchAll(/\b(?:import|require)\s*\(\s*(?!['"`])/g)) found.push(null);
  return found;
}

/** True when a specifier of `file` names the testing folder, or is a dynamic import that the test cannot read. */
function reachesTesting(file: string, specifier: string | null): boolean {
  if (specifier === null) return true;
  const segments = specifier[0] === '.' ? relative(SRC, resolve(dirname(file), specifier)).split(sep) : specifier.split('/');
  return specifier[0] === '.' ? segments[0] === 'testing' : segments.includes('testing');
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? sourceFiles(join(directory, entry.name)) : entry.name.endsWith('.ts') ? [join(directory, entry.name)] : []));
}

describe('the layers of the package', () => {
  it('the finder reads each form that loads a module, and the check names the testing folder in each of them', () => {
    const text = [
      "import { a } from '../testing/keys.ts';",
      "import type { B } from './b.ts';",
      "export { c } from '../common/c.ts';",
      "import '../testing/index.ts';",
      "const d = await import('../testing/gateway.ts');",
      "const e = require('./e.ts');",
      'const f = await import(name);',
      "import {\n  g,\n} from '@vsa/id-kit/testing';",
    ].join('\n');
    const found = specifiers(text);
    expect(found).toStrictEqual(["../testing/keys.ts", './b.ts', '../common/c.ts', '@vsa/id-kit/testing', '../testing/index.ts', '../testing/gateway.ts', './e.ts', null]);
    const file = join(SRC, 'client', 'x.ts');
    expect(found.map((s) => reachesTesting(file, s))).toStrictEqual([true, false, false, true, true, true, false, true]);
    expect(reachesTesting(join(SRC, 'verify', 'x.ts'), '../client/index.ts')).toBe(false);
  });

  it('no file of the client, the verifier, the shared code or the copied files, and not the root module, names the testing folder', () => {
    const files = [...LAYERS.flatMap((layer) => sourceFiles(join(SRC, layer))), join(SRC, 'index.ts')];
    expect(files.length).toBeGreaterThan(20);
    const all = files.map((file) => ({ file, found: specifiers(readFileSync(file, 'utf8')) }));
    // The scan is not empty: a verifier file loads the client.
    expect(all.some(({ file, found }) => relative(SRC, file) === join('verify', 'index.ts') && found.includes('../client/index.ts'))).toBe(true);
    const violations = all.flatMap(({ file, found }) => found.filter((s) => reachesTesting(file, s)).map((s) => `${relative(SRC, file)}: ${s}`));
    expect(violations).toStrictEqual([]);
  });
});
