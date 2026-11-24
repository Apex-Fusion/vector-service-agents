// agents/prior-authorization-agent/test/counter/surface.test.ts: the names that the counter folder exports, and what its sources import. The job `propose` takes the counter as a port, and the service builds the
// file form with the path of its state folder, so a name that leaves the folder, an import that comes in, or a read of the environment is a change of its contract.
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import * as counter from '../../src/counter/index.ts';

const FOLDER = new URL('../../src/counter/', import.meta.url);
const files = readdirSync(FOLDER).filter((name) => name.endsWith('.ts')).sort();
const textOf = (name: string): string => readFileSync(new URL(name, FOLDER), 'utf8');

/** The module names that a source imports, from the `from '...'` of its import and export lines. */
const importsOf = (text: string): string[] => [...text.matchAll(/^(?:import|export)\b[^;]*?\bfrom '([^']+)';/gm)].map((match) => match[1]!);

describe('the counter folder', () => {
  test('exports these values, and no other', () => {
    expect(Object.keys(counter).sort()).toStrictEqual(['FileRequestCounter', 'MemoryRequestCounter']);
  });

  test('has these source files, and no other', () => {
    expect(files).toStrictEqual(['counter.ts', 'index.ts']);
  });

  test('imports the kit folder of use case 2, the node modules of the counter file and its own file, and nothing else: no folder of another job of the agent', () => {
    const allowed = ['node:crypto', 'node:fs', 'node:fs/promises', 'node:path', '@vsa/usecase-kit/priorauth', './counter.ts'];
    for (const name of files) {
      const imports = importsOf(textOf(name));
      expect(imports.length, `${name} has imports or exports of modules`).toBeGreaterThan(0);
      for (const module of imports) expect(allowed.includes(module), `${name} imports ${module}`).toBe(true);
    }
  });

  test('reads no environment variable and makes no network call of its own, and only `counter.ts` touches the file system', () => {
    for (const name of files) {
      const text = textOf(name);
      for (const pattern of [/node:child_process/, /process\.env/, /\bfetch\(/, /\bXMLHttpRequest\b/]) expect(text, `${name} matches ${pattern}`).not.toMatch(pattern);
      if (name !== 'counter.ts') for (const pattern of [/node:fs/, /\breadFile/, /\bwriteFile/]) expect(text, `${name} matches ${pattern}`).not.toMatch(pattern);
    }
  });
});
