// agents/sourcing-agent/test/quotes/surface.test.ts: the names that the quotes folder exports, and what its sources import. The job `propose` and the wiring of the service take their ports from this folder, so a name that
// leaves it, an import that comes in, a read of a file, of the environment or of the time of day, or a timer is a change of its contract.
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import * as quotes from '../../src/quotes/index.ts';

const FOLDER = new URL('../../src/quotes/', import.meta.url);
const files = readdirSync(FOLDER).filter((name) => name.endsWith('.ts')).sort();
const textOf = (name: string): string => readFileSync(new URL(name, FOLDER), 'utf8');

interface Import {
  /** True for `import type` and `export type`. */
  readonly typeOnly: boolean;
  readonly module: string;
}

/** The imports and the re-exports of a source: whether each is type-only, and the module that it names. */
const importsOf = (text: string): Import[] => [...text.matchAll(/^(?:import|export)( type)?\b[^;]*?\bfrom '([^']+)';/gm)].map((match) => ({ typeOnly: match[1] !== undefined, module: match[2]! }));

/** The module that only a type may come from: the hire kit. No code of it runs here. */
const TYPE_ONLY = ['@vsa/hire-kit'];

describe('the quotes folder', () => {
  test('exports these values, and no other', () => {
    expect(Object.keys(quotes).sort()).toStrictEqual(['QUOTE_CODES', 'QUOTE_HIRE_RESERVE_MS', 'runQuotes']);
  });

  test('has these source files, and no other', () => {
    expect(files).toStrictEqual(['decide.ts', 'evidence.ts', 'index.ts', 'ports.ts', 'quotes.ts']);
  });

  test('imports the kit, the text helper of the service kit, the codec of vector-read and its own files, and nothing else', () => {
    const allowed = [
      '@vsa/hire-kit', '@vsa/usecase-kit/bids', '@vsa/usecase-kit/buyer', '@vsa/usecase-kit/dispute', '@vsa/usecase-kit/protocol', '@vsa/service-kit/text', '@vsa/vector-read',
      './decide.ts', './evidence.ts', './ports.ts', './quotes.ts',
    ];
    for (const name of files) {
      for (const { module } of importsOf(textOf(name))) {
        expect(module.startsWith('..'), `${name} imports a file of another folder: ${module}`).toBe(false);
        expect(allowed.includes(module), `${name} imports ${module}`).toBe(true);
      }
    }
    expect(importsOf(textOf('index.ts')).length).toBeGreaterThan(0);
  });

  test('takes the hire kit as types only, so that no code of it runs here', () => {
    for (const name of files) {
      for (const { typeOnly, module } of importsOf(textOf(name))) {
        if (TYPE_ONLY.includes(module)) expect(typeOnly, `${name} imports ${module} as a value`).toBe(true);
      }
    }
  });

  test('reads no file, no environment variable and no time of day, makes no network call of its own, and sets no timer', () => {
    for (const name of files) {
      const text = textOf(name);
      for (const pattern of [/node:fs/, /node:child_process/, /process\.env/, /\breadFile/, /\bfetch\(/, /\bXMLHttpRequest\b/, /\bDate\b/, /\bsetTimeout\b/, /\bsetInterval\b/]) {
        expect(text, `${name} matches ${pattern}`).not.toMatch(pattern);
      }
    }
  });

  test('does not run the bidders at one time: no Promise.all, Promise.allSettled or Promise.race in the loop', () => {
    for (const name of files) {
      expect(textOf(name), name).not.toMatch(/\bPromise\.(all|allSettled|race|any)\b/);
    }
  });
});
