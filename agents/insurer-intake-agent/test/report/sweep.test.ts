// agents/insurer-intake-agent/test/report/sweep.test.ts: every combination of what the four ports do, against the rules. Each port answers well, answers an empty or null value that is an answer, fails (it rejects),
// never answers, or gives a value of the wrong type. An oracle that is written from the rules of the report, and shares no code with it, says the word of each kind for each combination. The question: is a
// source that cannot be read ever reported as absent, invalid or valid, and does any combination give a word that the rules do not give?
import { describe, expect, it } from 'vitest';
import { REPORT_BUDGET_MS } from '../../src/report/index.ts';
import type { ReportRow } from '../../src/report/index.ts';
import { AGENT_ROOT, FAILURES, KEY_ROOT, KIND_NAMES, MEMBER_ID, PROVIDER_HASH, ROOT_HASH, go, idOf, rig, row, spent } from './support.ts';
import type { Kind, Script } from './support.ts';

const PROVIDER = ['key', 'null', 'throws', 'hangs', 'wrong'] as const;
const ROOT = ['key', 'agent', 'null', 'throws', 'hangs', 'wrong'] as const;
const LIST = ['row', 'empty', 'strangers', 'throws', 'hangs', 'wrong'] as const;
const CHECK = ['true', 'false', 'throws', 'hangs', 'wrong'] as const;

interface Combo {
  readonly provider: (typeof PROVIDER)[number];
  readonly root: (typeof ROOT)[number];
  readonly list: (typeof LIST)[number];
  readonly check: (typeof CHECK)[number];
}

/** A source that fails: it rejects, or it never answers. */
const failure = (how: 'hangs' | 'throws'): Promise<never> => (how === 'throws' ? FAILURES['rejects with an error']() : FAILURES['never answers']());

/**
 * The list of one type that holds a row of the right issuer. For the binding it holds a row of a key principal and a row of an agent root, so that the right row is the one that the root names, and the
 * other is a row of a stranger.
 */
function rightRows(attType: number): readonly ReportRow[] {
  if (attType === 4) return [row(idOf(0x104), { issuer_key_hash: ROOT_HASH }), row(idOf(0x105), { issuer_id: MEMBER_ID })];
  return [row(idOf(0x100 + attType), { issuer_key_hash: PROVIDER_HASH })];
}

/** The four ports for a combination. A port that gives a value of the wrong type is a cast: the compiler does not allow the value, and the report must. */
function portsOf(c: Combo): NonNullable<Script['ports']> {
  const provider = (): Promise<unknown> => (c.provider === 'key' ? Promise.resolve(PROVIDER_HASH) : c.provider === 'null' ? Promise.resolve(null) : c.provider === 'wrong' ? Promise.resolve(42) : failure(c.provider));
  const root = (): Promise<unknown> => {
    if (c.root === 'key') return Promise.resolve(KEY_ROOT);
    if (c.root === 'agent') return Promise.resolve(AGENT_ROOT);
    if (c.root === 'null') return Promise.resolve(null);
    return c.root === 'wrong' ? Promise.resolve('root') : failure(c.root);
  };
  const list = (_subject: string, attType: number): Promise<unknown> => {
    if (c.list === 'row') return Promise.resolve(rightRows(attType));
    if (c.list === 'empty') return Promise.resolve([]);
    if (c.list === 'strangers') return Promise.resolve([row(idOf(0x2001)), row(idOf(0x2002), { issuer_id: idOf(0x2003) })]);
    return c.list === 'wrong' ? Promise.resolve('rows') : failure(c.list);
  };
  const check = (): Promise<unknown> => (c.check === 'true' ? Promise.resolve(true) : c.check === 'false' ? Promise.resolve(false) : c.check === 'wrong' ? Promise.resolve('true') : failure(c.check));
  return { providerKeyHashOf: provider, rootDelegatorOf: root, list, check } as unknown as NonNullable<Script['ports']>;
}

const FAILED: readonly string[] = ['throws', 'hangs', 'wrong'];

/** The word of a kind that the rules give, written out step by step: the issuer, the list, the check. */
function oracle(kind: Kind, c: Combo): string {
  if (kind === 'principal_binding') {
    // A root that cannot be read, and a root that is null (no live chain), give unreadable.
    if (FAILED.includes(c.root) || c.root === 'null') return 'unreadable';
  } else {
    if (FAILED.includes(c.provider)) return 'unreadable';
    // No Provider party that names a key: absent, and no list is read.
    if (c.provider === 'null') return 'absent';
  }
  if (FAILED.includes(c.list)) return 'unreadable';
  // A list with no row of the expected issuer is absent. A stranger makes no word.
  if (c.list === 'empty' || c.list === 'strangers') return 'absent';
  // One row of the expected issuer exists, so the check decides.
  if (FAILED.includes(c.check)) return 'unreadable';
  return c.check === 'true' ? 'valid' : 'invalid';
}

describe('every combination of what the four ports do', () => {
  it('gives the word that the rules give for each kind, and never absent, invalid or valid for a source that cannot be read', async () => {
    const mismatches: string[] = [];
    let runs = 0;
    for (const provider of PROVIDER) {
      for (const root of ROOT) {
        for (const list of LIST) {
          for (const check of CHECK) {
            runs += 1;
            const combo: Combo = { provider, root, list, check };
            const report = await go(rig({ ports: portsOf(combo) }));
            const wanted = Object.fromEntries(KIND_NAMES.map((kind) => [kind, oracle(kind, combo)]));
            if (JSON.stringify(report) !== JSON.stringify(wanted)) mismatches.push(`${JSON.stringify(combo)} gave ${JSON.stringify(report)} and the rules give ${JSON.stringify(wanted)}`);
          }
        }
      }
    }
    expect(runs).toBe(PROVIDER.length * ROOT.length * LIST.length * CHECK.length);
    expect(mismatches.slice(0, 5)).toEqual([]);
  });

  it('spends at most the budget of the report when every port never answers, and when every list or check never answers', async () => {
    for (const combo of [{ provider: 'hangs', root: 'hangs', list: 'hangs', check: 'hangs' }, { provider: 'key', root: 'key', list: 'hangs', check: 'hangs' }, { provider: 'key', root: 'key', list: 'row', check: 'hangs' }] as const) {
      const r = rig({ ports: portsOf(combo) });
      await go(r);
      expect(spent(r), JSON.stringify(combo)).toBeLessThanOrEqual(REPORT_BUDGET_MS);
    }
  });
});
