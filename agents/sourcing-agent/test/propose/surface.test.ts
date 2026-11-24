// agents/sourcing-agent/test/propose/surface.test.ts: the names that the propose folder exports, the codes that it gives, the constants of its time, and what its sources import. The service joins this folder with
// the other parts of the agent through its ports, so a name that leaves it, an import that comes in, or a read of the environment is a change of its contract.
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
    expect(Object.keys(propose).sort()).toStrictEqual(['PROPOSE_DEADLINE_MS', 'PROPOSE_FAILURES', 'ProposeRefusal', 'RANKING_RESERVE_MS', 'SCORING_RESERVE_MS', 'runPropose']);
  });

  test('has these source files, and no other', () => {
    expect(files).toStrictEqual(['index.ts', 'ports.ts', 'propose.ts', 'ranking.ts', 'result.ts']);
  });

  test('has the deadline of the job and the two reserves that the quote fan-out and the scoring keep', () => {
    expect(propose.PROPOSE_DEADLINE_MS).toBe(5_220_000);
    expect(propose.PROPOSE_DEADLINE_MS + 180_000).toBe(5_400_000);
    expect(propose.RANKING_RESERVE_MS).toBe(120_000);
    expect(propose.SCORING_RESERVE_MS).toBe(720_000 + propose.RANKING_RESERVE_MS);
    expect(propose.SCORING_RESERVE_MS).toBe(840_000);
    expect(propose.PROPOSE_DEADLINE_MS).toBeGreaterThan(propose.SCORING_RESERVE_MS);
  });

  test('imports the kit folders of the documents, the buyer flow and the protocol, and its own files, and nothing else: no other folder of the agent', () => {
    const allowed = ['@vsa/usecase-kit/bids', '@vsa/usecase-kit/buyer', '@vsa/usecase-kit/protocol', './ports.ts', './propose.ts', './ranking.ts', './result.ts'];
    for (const name of files) {
      const imports = importsOf(textOf(name));
      expect(imports.length, `${name} has imports or exports of modules`).toBeGreaterThan(0);
      for (const module of imports) expect(allowed.includes(module), `${name} imports ${module}`).toBe(true);
    }
  });

  test('reads no environment variable and no file, and makes no network call of its own', () => {
    for (const name of files) {
      const text = textOf(name);
      for (const pattern of [/node:/, /process\.env/, /\bfetch\(/, /\bXMLHttpRequest\b/, /\breadFile/, /\bwriteFile/]) expect(text, `${name} matches ${pattern}`).not.toMatch(pattern);
    }
  });

  test('lists the codes that it gives itself, each once, and each has the form of a code', () => {
    expect(propose.PROPOSE_FAILURES).toStrictEqual([
      'ledger_unavailable', 'delegation_not_found', 'delegation_key_unknown', 'bidders_unavailable', 'no_bidders', 'shortlist_unknown_bidder', 'nobody_invited', 'no_quotes', 'deadline', 'ranking_invalid',
      'bad_document', 'decision_mismatch', 'aborted', 'internal',
    ]);
    expect(new Set(propose.PROPOSE_FAILURES).size).toBe(propose.PROPOSE_FAILURES.length);
    for (const code of propose.PROPOSE_FAILURES) expect(code).toMatch(/^[a-z0-9_]{1,64}$/);
    expect(Object.isFrozen(propose.PROPOSE_FAILURES)).toBe(true);
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
