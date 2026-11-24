// agents/sourcing-agent/test/model/surface.test.ts
// The names that the model folder exports, and what its sources import. The wiring of the service takes the four decisions, their inputs and the fields of a request from this folder, so a name that leaves it,
// an import that comes in, or a read of a file, of the environment or of the clock is a change of its contract.
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import * as model from '../../src/model/index.ts';

const FOLDER = new URL('../../src/model/', import.meta.url);
const files = readdirSync(FOLDER).filter((name) => name.endsWith('.ts')).sort();
const textOf = (name: string): string => readFileSync(new URL(name, FOLDER), 'utf8');

/** The module names that a source imports, from the `from '...'` of its import lines. */
const importsOf = (text: string): string[] => [...text.matchAll(/^(?:import|export)\b[^;]*?\bfrom '([^']+)';/gm)].map((match) => match[1]!);

describe('the model folder', () => {
  test('exports these values, and no other', () => {
    expect(Object.keys(model).sort()).toStrictEqual([
      'ACCEPT_QUOTE_DECISION', 'MAX_INVITED', 'SCORE_DECISION', 'SHORTLIST_DECISION', 'acceptQuoteInput', 'parseProposeFields', 'scoreInput', 'shortlistInput',
    ]);
  });

  test('has these source files, and no other', () => {
    expect(files).toStrictEqual(['accept.ts', 'bidder.ts', 'choice.ts', 'index.ts', 'intake.ts', 'score.ts', 'shortlist.ts']);
  });

  test('imports the kit folders of the protocol, the decision and the bids and its own files, and nothing else', () => {
    const allowed = [
      '@vsa/usecase-kit/protocol', '@vsa/usecase-kit/decision', '@vsa/usecase-kit/bids', './intake.ts', './bidder.ts', './choice.ts', './shortlist.ts', './accept.ts', './score.ts',
    ];
    for (const name of files) {
      const imports = importsOf(textOf(name));
      expect(imports.length, `${name} has imports or exports of modules`).toBeGreaterThan(0);
      for (const module of imports) {
        expect(module.startsWith('..'), `${name} imports a file of another folder: ${module}`).toBe(false);
        expect(allowed.includes(module), `${name} imports ${module}`).toBe(true);
      }
    }
  });

  test('reads no file, no environment variable and no clock, and makes no network call of its own', () => {
    for (const name of files) {
      const text = textOf(name);
      for (const pattern of [/node:fs/, /node:child_process/, /process\.env/, /\breadFile/, /\bfetch\(/, /\bXMLHttpRequest\b/, /Date\.now/, /new Date\(\)/]) {
        expect(text, `${name} matches ${pattern}`).not.toMatch(pattern);
      }
    }
  });
});
