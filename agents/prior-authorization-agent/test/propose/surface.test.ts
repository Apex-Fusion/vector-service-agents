// agents/prior-authorization-agent/test/propose/surface.test.ts: the names that the propose folder exports, the codes that it gives, and what its sources import. The service joins this folder with the other parts of
// the agent through its ports, so a name that leaves it, an import that comes in, or a read of the environment is a change of its contract.
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { ERROR_STATUS } from '@vsa/usecase-kit/protocol';
import * as propose from '../../src/propose/index.ts';

const FOLDER = new URL('../../src/propose/', import.meta.url);
const files = readdirSync(FOLDER).filter((name) => name.endsWith('.ts')).sort();
const textOf = (name: string): string => readFileSync(new URL(name, FOLDER), 'utf8');

/** The module names that a source imports, from the `from '...'` of its import and export lines. */
const importsOf = (text: string): string[] => [...text.matchAll(/^(?:import|export)\b[^;]*?\bfrom '([^']+)';/gm)].map((match) => match[1]!);

describe('the propose folder', () => {
  test('exports these values, and no other', () => {
    expect(Object.keys(propose).sort()).toStrictEqual(['DECISION_RESERVE_MS', 'PROPOSE_DEADLINE_MS', 'PROPOSE_FAILURES', 'ProposeRefusal', 'runPropose']);
  });

  test('has these source files, and no other', () => {
    expect(files).toStrictEqual(['index.ts', 'ports.ts', 'propose.ts']);
  });

  test('imports the kit folders of the protocol, the buyer flow, the access types and the clock bound, and the documents of use case 2, and its own files, and nothing else', () => {
    const allowed = ['@vsa/usecase-kit/access', '@vsa/usecase-kit/buyer', '@vsa/usecase-kit/priorauth', '@vsa/usecase-kit/protocol', './ports.ts', './propose.ts'];
    for (const name of files) {
      const imports = importsOf(textOf(name));
      expect(imports.length, `${name} has imports or exports of modules`).toBeGreaterThan(0);
      for (const module of imports) expect(allowed.includes(module), `${name} imports ${module}`).toBe(true);
    }
  });

  test('does not import the other folders of the agent: they meet this folder in the ports that the service builds', () => {
    for (const name of files) for (const other of ['model', 'evidence', 'insurer', 'counter', 'execute', 'serve']) expect(textOf(name), `${name} imports ../${other}`).not.toContain(`'../${other}`);
  });

  test('reads no environment variable, no file and no key, and makes no network call of its own', () => {
    for (const name of files) {
      const text = textOf(name);
      for (const pattern of [/node:child_process/, /process\.env/, /\bfetch\(/, /\bXMLHttpRequest\b/, /node:fs/, /\breadFile/, /\bwriteFile/, /node:net/, /node:http/]) expect(text, `${name} matches ${pattern}`).not.toMatch(pattern);
    }
  });

  test('lists the codes that it gives itself, and each has the form of a code', () => {
    expect(propose.PROPOSE_FAILURES).toStrictEqual([
      'ledger_unavailable', 'delegation_not_found', 'delegation_key_unknown', 'insurer_not_listed', 'insurer_unavailable', 'record_set_mismatch', 'guideline_mismatch', 'decision_mismatch', 'bad_document',
      'store_write_failed', 'deadline', 'aborted', 'internal',
    ]);
    expect(new Set(propose.PROPOSE_FAILURES).size).toBe(propose.PROPOSE_FAILURES.length);
    for (const code of propose.PROPOSE_FAILURES) expect(code).toMatch(/^[a-z0-9_]{1,64}$/);
  });

  test('has the deadline of the job and the reserve of the decision, and the reserve is inside the deadline', () => {
    expect(propose.PROPOSE_DEADLINE_MS).toBe(1_620_000);
    expect(propose.DECISION_RESERVE_MS).toBe(300_000);
    expect(propose.DECISION_RESERVE_MS).toBeLessThan(propose.PROPOSE_DEADLINE_MS);
  });

  test('refuses with the status of the code in the table of the protocol', () => {
    for (const code of ['delegation_not_mine', 'bad_shape'] as const) {
      const refusal = new propose.ProposeRefusal(code, 'a sentence');
      expect(refusal).toBeInstanceOf(Error);
      expect(refusal).toMatchObject({ name: 'ProposeRefusal', code, status: ERROR_STATUS[code], message: 'a sentence' });
      expect(refusal.status).toBe(400);
    }
  });
});
