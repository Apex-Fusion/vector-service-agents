// agents/prior-authorization-agent/test/evidence/surface.test.ts: the names that the evidence folder exports, the codes that it gives, the budgets of a read, and what its sources import. The service joins this
// folder with the other jobs of the agent through its ports, so a name that leaves it, an import that comes in, or a read of the environment is a change of its contract.
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { STATUS_OF } from '../../../../services/mock-systems/src/errors.ts';
import { DEFAULT_CONFIRMATION_WAIT_MS, DEFAULT_END_TIMEOUT_MS, DEFAULT_STEP_TIMEOUT_MS, GATEWAY_FAILURES, SUB_DELEGATION_FAILURES } from '@vsa/usecase-kit/access';
import { MemoryLeftStore } from '@vsa/usecase-kit/janitor';
import * as evidence from '../../src/evidence/index.ts';
import type { InFlight, LeftSink } from '../../src/evidence/index.ts';
import { BOOKKEEPING_TIMEOUT_MS, LIST_TIMEOUT_MS } from '../../src/evidence/bookkeeping.ts';
import { CONFIRMATION_WAIT_MS, END_TIMEOUT_MS, JOB_TIMEOUT_MS, LEAST_READ_MS, MIN_CONFIRMATION_WAIT_MS, MOCK_CODES, TOKEN_PATIENCE_MS, VALIDITY_SLACK_MS } from '../../src/evidence/subread.ts';

const FOLDER = new URL('../../src/evidence/', import.meta.url);
const files = readdirSync(FOLDER).filter((name) => name.endsWith('.ts')).sort();
const textOf = (name: string): string => readFileSync(new URL(name, FOLDER), 'utf8');

/** The module names that a source imports, from the `from '...'` of its import and export lines. */
const importsOf = (text: string): string[] => [...text.matchAll(/^(?:import|export)\b[^;]*?\bfrom '([^']+)';/gm)].map((match) => match[1]!);

describe('the evidence folder', () => {
  test('exports these values, and no other', () => {
    expect(Object.keys(evidence).sort()).toStrictEqual(['EVIDENCE_FAILURES', 'readEvidence']);
  });

  test('has these source files, and no other', () => {
    expect(files).toStrictEqual(['bookkeeping.ts', 'guideline.ts', 'index.ts', 'ports.ts', 'read.ts', 'records.ts', 'subread.ts']);
  });

  test('imports the kit folders of the protocol, the access, the janitor and the documents of use case 2, the client of the gateway, and its own files, and nothing else', () => {
    const allowed = [
      '@vsa/id-kit/client', '@vsa/usecase-kit/access', '@vsa/usecase-kit/janitor', '@vsa/usecase-kit/priorauth', '@vsa/usecase-kit/protocol', './bookkeeping.ts', './guideline.ts', './ports.ts', './read.ts',
      './records.ts', './subread.ts',
    ];
    for (const name of files) {
      const imports = importsOf(textOf(name));
      expect(imports.length, `${name} has imports or exports of modules`).toBeGreaterThan(0);
      for (const module of imports) expect(allowed.includes(module), `${name} imports ${module}`).toBe(true);
    }
  });

  test('reads no environment variable, makes no network call of its own, and touches no file', () => {
    for (const name of files) {
      const text = textOf(name);
      for (const pattern of [/node:child_process/, /node:fs/, /process\.env/, /\bfetch\(/, /\bXMLHttpRequest\b/, /\breadFile/, /\bwriteFile/]) expect(text, `${name} matches ${pattern}`).not.toMatch(pattern);
    }
  });

  test('has no request for a token as the agent: only the token of a subagent is asked for', () => {
    for (const name of files) {
      const text = textOf(name);
      expect(text, name).not.toMatch(/\brequestRouteToken\b/);
      expect(text, name).not.toMatch(/holder:\s*'agent'/);
    }
    expect(textOf('subread.ts').match(/\brequestSubagentToken\(/g)).toHaveLength(1);
    expect(textOf('subread.ts').match(/\bcallWithToken\(/g)).toHaveLength(1);
  });

  test('lists the codes that it gives, and each has the form of a code', () => {
    const own = ['record_read_timeout', 'guideline_read_timeout', 'record_set_invalid', 'guideline_invalid', 'mock_system_failed', 'sub_delegation_not_ended', 'deadline', 'aborted', 'internal'];
    const mock = ['order_not_found', 'guideline_not_found', 'token_invalid', 'not_covered', 'delegation_ended', 'chain_too_deep', 'actor_not_active'];
    expect(evidence.EVIDENCE_FAILURES).toStrictEqual([...own, ...mock, ...SUB_DELEGATION_FAILURES.map((code) => `sub_delegation_${code}`), ...GATEWAY_FAILURES.map((code) => `token_${code}`)]);
    expect(evidence.EVIDENCE_FAILURES).toContain('sub_delegation_confirmation_timeout');
    expect(evidence.EVIDENCE_FAILURES).toContain('token_delegation_too_young');
    expect(new Set(evidence.EVIDENCE_FAILURES).size).toBe(evidence.EVIDENCE_FAILURES.length);
    for (const code of evidence.EVIDENCE_FAILURES) expect(code).toMatch(/^[a-z0-9_]{1,64}$/);
    expect(Object.isFrozen(evidence.EVIDENCE_FAILURES)).toBe(true);
    expect([...MOCK_CODES]).toStrictEqual(mock);
  });

  test('passes on the codes that the mock gives for an id that it does not know and for the credential of a token route, each with the status that the mock gives it', () => {
    expect(MOCK_CODES.map((code) => STATUS_OF[code])).toStrictEqual([404, 404, 401, 403, 403, 403, 403]);
  });

  test('has the budgets of a read: 360,000 ms for the confirmations, at least 180,000, 120,000 of patience for the token, 240,000 for the job, 120,000 for the end, 300,000 of validity after the job', () => {
    expect([CONFIRMATION_WAIT_MS, MIN_CONFIRMATION_WAIT_MS, TOKEN_PATIENCE_MS, JOB_TIMEOUT_MS, END_TIMEOUT_MS, VALIDITY_SLACK_MS]).toStrictEqual([360_000, 180_000, 120_000, 240_000, 120_000, 300_000]);
    expect(CONFIRMATION_WAIT_MS).toBe(DEFAULT_CONFIRMATION_WAIT_MS);
    expect(END_TIMEOUT_MS).toBe(DEFAULT_END_TIMEOUT_MS);
    expect(LEAST_READ_MS).toBe(540_000);
  });

  test('bounds the update of the list at the step bound of the access folder, and the read of the list at a third of it, so that a late answer never finds a read that ended', () => {
    expect(BOOKKEEPING_TIMEOUT_MS).toBe(DEFAULT_STEP_TIMEOUT_MS);
    expect(LIST_TIMEOUT_MS).toBe(20_000);
    expect(LIST_TIMEOUT_MS).toBeLessThan(DEFAULT_STEP_TIMEOUT_MS);
  });

  test('has a sink that the list of the kit fits and a set that a Set fits, so that the service gives one list and one set to the reads and to the janitor', async () => {
    const sink: LeftSink = new MemoryLeftStore();
    expect(await sink.list()).toStrictEqual([]);
    const live = new Set<string>();
    const inFlight: InFlight = live;
    inFlight.add('a');
    expect(live.has('a')).toBe(true);
    inFlight.delete('a');
    expect(live.size).toBe(0);
  });
});
