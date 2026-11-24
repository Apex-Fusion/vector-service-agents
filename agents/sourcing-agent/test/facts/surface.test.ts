// agents/sourcing-agent/test/facts/surface.test.ts: the names that the facts folder exports, and what its sources import. The file of a bidder and the wiring of the service take their ports from this folder, so a name
// that leaves it, an import that comes in, a read of a file, of the environment or of the time of day, or a timer that is not the clock port is a change of its contract.
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import * as facts from '../../src/facts/index.ts';

const FOLDER = new URL('../../src/facts/', import.meta.url);
const files = readdirSync(FOLDER).filter((name) => name.endsWith('.ts')).sort();
const textOf = (name: string): string => readFileSync(new URL(name, FOLDER), 'utf8');

interface Import {
  /** True for `import type` and `export type`. */
  readonly typeOnly: boolean;
  readonly module: string;
}

/** The imports and the re-exports of a source: whether each is type-only, and the module that it names. */
const importsOf = (text: string): Import[] => [...text.matchAll(/^(?:import|export)( type)?\b[^;]*?\bfrom '([^']+)';/gm)].map((match) => ({ typeOnly: match[1] !== undefined, module: match[2]! }));

/** The modules that only a type may come from: the kit of the dispute, and the client of the identity gateway. */
const TYPE_ONLY = ['@vsa/usecase-kit/dispute', '@vsa/id-kit/client'];

describe('the facts folder', () => {
  test('exports these values, and no other', () => {
    expect(Object.keys(facts).sort()).toStrictEqual(['FACT_READ_TIMEOUT_MS', 'casesAgainst', 'casesAgainstAll', 'readCredential', 'readStake']);
  });

  test('has these source files, and no other', () => {
    expect(files).toStrictEqual(['bound.ts', 'cases.ts', 'credential.ts', 'index.ts', 'stake.ts']);
  });

  test('imports the codec of vector-read, the types of the dispute kit and of the identity client, and its own files, and nothing else', () => {
    const allowed = ['@vsa/vector-read', ...TYPE_ONLY, './bound.ts', './stake.ts', './cases.ts', './credential.ts'];
    for (const name of files) {
      for (const { module } of importsOf(textOf(name))) {
        expect(module.startsWith('..'), `${name} imports a file of another folder: ${module}`).toBe(false);
        expect(allowed.includes(module), `${name} imports ${module}`).toBe(true);
      }
    }
    expect(importsOf(textOf('index.ts')).length).toBeGreaterThan(0);
  });

  test('takes the dispute kit and the identity client as types only, so that no code of them runs here', () => {
    for (const name of files) {
      for (const { typeOnly, module } of importsOf(textOf(name))) {
        if (TYPE_ONLY.includes(module)) expect(typeOnly, `${name} imports ${module} as a value`).toBe(true);
      }
    }
  });

  test('reads no file, no environment variable and no time of day, makes no network call of its own, and waits only through the clock port', () => {
    for (const name of files) {
      const text = textOf(name);
      for (const pattern of [/node:fs/, /node:child_process/, /process\.env/, /\breadFile/, /\bfetch\(/, /\bXMLHttpRequest\b/, /\bDate\b/, /\bsetTimeout\b/, /\bsetInterval\b/]) {
        expect(text, `${name} matches ${pattern}`).not.toMatch(pattern);
      }
    }
  });
});
