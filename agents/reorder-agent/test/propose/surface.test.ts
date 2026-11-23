// agents/reorder-agent/test/propose/surface.test.ts: the names that the propose folder exports, the codes that it gives, and what its sources import. The service joins this folder with the other jobs of the agent
// through its ports, so a name that leaves it, an import that comes in, or a read of the environment is a change of its contract.
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { GATEWAY_FAILURES, SUB_DELEGATION_FAILURES } from '@vsa/usecase-kit/access';
import { ERROR_STATUS } from '@vsa/usecase-kit/protocol';
import * as propose from '../../src/propose/index.ts';

const FOLDER = new URL('../../src/propose/', import.meta.url);
const files = readdirSync(FOLDER).filter((name) => name.endsWith('.ts')).sort();
const textOf = (name: string): string => readFileSync(new URL(name, FOLDER), 'utf8');

/** The module names that a source imports, from the `from '...'` of its import and export lines. */
const importsOf = (text: string): string[] => [...text.matchAll(/^(?:import|export)\b[^;]*?\bfrom '([^']+)';/gm)].map((match) => match[1]!);

describe('the propose folder', () => {
  test('exports these values, and no other', () => {
    expect(Object.keys(propose).sort()).toStrictEqual(['FilePoCounter', 'MemoryPoCounter', 'PROPOSE_DEADLINE_MS', 'PROPOSE_FAILURES', 'ProposeRefusal', 'runPropose']);
  });

  test('has these source files, and no other', () => {
    expect(files).toStrictEqual(['counter.ts', 'index.ts', 'ports.ts', 'propose.ts']);
  });

  test('imports the kit folders of the protocol, the inventory, the access and the buyer flow, the client of the gateway, the node modules of its counter, and its own files, and nothing else', () => {
    const allowed = [
      'node:crypto', 'node:fs', 'node:fs/promises', 'node:path', '@vsa/id-kit/client', '@vsa/usecase-kit/access', '@vsa/usecase-kit/buyer', '@vsa/usecase-kit/inventory', '@vsa/usecase-kit/protocol',
      './counter.ts', './ports.ts', './propose.ts',
    ];
    for (const name of files) {
      const imports = importsOf(textOf(name));
      expect(imports.length, `${name} has imports or exports of modules`).toBeGreaterThan(0);
      for (const module of imports) expect(allowed.includes(module), `${name} imports ${module}`).toBe(true);
    }
  });

  test('reads no environment variable and makes no network call of its own, and only the counter touches the file system', () => {
    for (const name of files) {
      const text = textOf(name);
      for (const pattern of [/node:child_process/, /process\.env/, /\bfetch\(/, /\bXMLHttpRequest\b/]) expect(text, `${name} matches ${pattern}`).not.toMatch(pattern);
      if (name !== 'counter.ts') for (const pattern of [/node:fs/, /\breadFile/, /\bwriteFile/]) expect(text, `${name} matches ${pattern}`).not.toMatch(pattern);
    }
  });

  test('lists the codes that it gives itself, and each has the form of a code', () => {
    const own = [
      'ledger_unavailable', 'delegation_not_found', 'delegation_key_unknown', 'stock_read_timeout', 'stock_reading_invalid', 'stock_reading_mismatch', 'mock_system_failed', 'bad_document', 'store_write_failed',
      'deadline', 'aborted', 'internal',
    ];
    expect(propose.PROPOSE_FAILURES).toStrictEqual([...own, ...SUB_DELEGATION_FAILURES.map((code) => `sub_delegation_${code}`), ...GATEWAY_FAILURES.map((code) => `token_${code}`)]);
    expect(propose.PROPOSE_FAILURES).toContain('sub_delegation_confirmation_timeout');
    expect(propose.PROPOSE_FAILURES).toContain('token_delegation_too_young');
    expect(new Set(propose.PROPOSE_FAILURES).size).toBe(propose.PROPOSE_FAILURES.length);
    for (const code of propose.PROPOSE_FAILURES) expect(code).toMatch(/^[a-z0-9_]{1,64}$/);
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
