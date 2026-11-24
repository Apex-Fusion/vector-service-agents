// agents/prior-authorization-agent/test/insurer/surface.test.ts: the names that the insurer folder exports, and what its sources import. The job `propose` takes the reader as a port, and the service joins
// the reader with the real ports, so a name that leaves the folder, an import that comes in, or a read of a file or of the environment is a change of its contract.
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import * as insurer from '../../src/insurer/index.ts';

const FOLDER = new URL('../../src/insurer/', import.meta.url);
const files = readdirSync(FOLDER).filter((name) => name.endsWith('.ts')).sort();
const textOf = (name: string): string => readFileSync(new URL(name, FOLDER), 'utf8');

/** The module names that a source imports, from the `from '...'` of its import and export lines. */
const importsOf = (text: string): string[] => [...text.matchAll(/^(?:import|export)\b[^;]*?\bfrom '([^']+)';/gm)].map((match) => match[1]!);

describe('the insurer folder', () => {
  test('exports these values, and no other', () => {
    expect(Object.keys(insurer).sort()).toStrictEqual(['INSURER_FAILURES', 'INSURER_READ_BUDGET_MS', 'readInsurer']);
  });

  test('has these source files, and no other', () => {
    expect(files).toStrictEqual(['index.ts', 'insurer.ts']);
  });

  test('imports the kit folders of the protocol and of use case 2, buyer-core and its own file, and nothing else: no folder of another job of the agent', () => {
    const allowed = ['@vsa/buyer-core', '@vsa/usecase-kit/priorauth', '@vsa/usecase-kit/protocol', './insurer.ts'];
    for (const name of files) {
      const imports = importsOf(textOf(name));
      expect(imports.length, `${name} has imports or exports of modules`).toBeGreaterThan(0);
      for (const module of imports) expect(allowed.includes(module), `${name} imports ${module}`).toBe(true);
    }
  });

  test('reads no file and no environment variable, and makes no network call of its own', () => {
    for (const name of files) {
      const text = textOf(name);
      for (const pattern of [/node:fs/, /node:child_process/, /process\.env/, /\breadFile/, /\bfetch\(/, /\bXMLHttpRequest\b/]) expect(text, `${name} matches ${pattern}`).not.toMatch(pattern);
    }
  });
});
