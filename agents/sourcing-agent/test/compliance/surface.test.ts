// agents/sourcing-agent/test/compliance/surface.test.ts
// The names that the compliance folder exports, and what its sources import. The wiring of the agent takes `readCompliance` and its types from this folder, and the folder does not import the other folders of the
// agent. So a name that leaves it, an import that comes in, or a read of a file, of the environment or of the network is a change of its contract.
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import * as compliance from '../../src/compliance/index.ts';

const FOLDER = new URL('../../src/compliance/', import.meta.url);
const files = readdirSync(FOLDER).filter((name) => name.endsWith('.ts')).sort();
const textOf = (name: string): string => readFileSync(new URL(name, FOLDER), 'utf8');

/** The module names that a source imports, from the `from '...'` of its import and export lines. */
const importsOf = (text: string): string[] => [...text.matchAll(/^(?:import|export)\b[^;]*?\bfrom '([^']+)';/gm)].map((match) => match[1]!);

describe('the compliance folder', () => {
  test('exports these values, and no other', () => {
    expect(Object.keys(compliance).sort()).toStrictEqual(['COMPLIANCE_ATT_TYPE', 'FACT_READ_TIMEOUT_MS', 'readCompliance']);
  });

  test('has the type of an identity attestation and a bound of 20 seconds for one read of the list', () => {
    expect(compliance.COMPLIANCE_ATT_TYPE).toBe(0);
    expect(compliance.FACT_READ_TIMEOUT_MS).toBe(20_000);
  });

  test('has these source files, and no other', () => {
    expect(files).toStrictEqual(['index.ts', 'read.ts']);
  });

  test('imports buyer-core, the protocol folder of the kit and its own files, and nothing else', () => {
    const allowed = ['@vsa/buyer-core', '@vsa/usecase-kit/protocol', './read.ts'];
    for (const name of files) {
      const imports = importsOf(textOf(name));
      expect(imports.length, `${name} has imports or exports of modules`).toBeGreaterThan(0);
      for (const module of imports) expect(allowed.includes(module), `${name} imports ${module}`).toBe(true);
    }
  });

  test('reads no file and no environment variable, and makes no network call of its own', () => {
    for (const name of files) {
      const text = textOf(name);
      for (const pattern of [/node:fs/, /node:child_process/, /process\.env/, /\breadFile/, /\bfetch\(/, /\bXMLHttpRequest\b/, /\bsetTimeout\b/]) expect(text, `${name} matches ${pattern}`).not.toMatch(pattern);
    }
  });
});
