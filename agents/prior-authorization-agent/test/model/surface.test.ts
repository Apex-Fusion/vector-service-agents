// agents/prior-authorization-agent/test/model/surface.test.ts
// The names that the model folder exports, and what its sources import. The flows of the agent (`evidence`, `propose`, `execute` and `serve`) take their ports and their decisions from this folder, so a
// name that leaves it, an import that comes in, or a read of a file or of the environment is a change of its contract.
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
    expect(Object.keys(model).sort()).toStrictEqual(['ACCEPT_DECISION', 'acceptInput', 'justificationDecision', 'justificationInput', 'parseProposeFields']);
  });

  test('has these source files, and no other', () => {
    expect(files).toStrictEqual(['decisions.ts', 'index.ts', 'intake.ts']);
  });

  test('imports the kit folders of the protocol, the documents of use case 2 and the decision, and its own files, and nothing else: no folder of a flow', () => {
    const allowed = ['@vsa/usecase-kit/protocol', '@vsa/usecase-kit/priorauth', '@vsa/usecase-kit/decision', './intake.ts', './decisions.ts'];
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
