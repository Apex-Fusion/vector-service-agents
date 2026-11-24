// agents/sourcing-agent/test/execute/failures.test.ts: every end of the job `execute` that is `failed`, in one table. Each row runs the job in a world with one fault, and holds the code, the exit state, the footprint
// (the reads, the token requests and the calls that the job made) and the log. The last test holds the codes that the rows write equal to `EXECUTE_FAILURES`, in both directions. The reason of a refusal by the
// sourcing record is a class, and it is not in the list. Each fault has its twin: the same world with no fault is the golden run.
import { describe, expect, it } from 'vitest';
import type { ExecuteResult } from '@vsa/usecase-kit/protocol';
import { EXECUTE_DEADLINE_MS, EXECUTE_FAILURES } from '../../src/execute/index.ts';
import { APPROVAL } from './fixtures.ts';
import type { Footprint, World } from './world.ts';
import { DELEGATION, ONE_CALL, READ_ONLY, UNTOUCHED, footprint, jsonResponse, words, world } from './world.ts';

interface Row {
  readonly name: string;
  readonly code: string;
  readonly footprint: Footprint;
  readonly run: (w: World) => Promise<ExecuteResult>;
}

/** Read the delegation, ask for the token, and make no call. */
const TOKEN_ONLY: Footprint = { reads: 1, vaults: 0, tokens: 1, calls: 0 };

/** A document that is no ranking: it has the form of a purchase order. */
const NO_RANKING = { schema: 'vector.usecase.po.v1', po_number: 'run1-1', tenant: 'run1', sku: 'SKU-100', lot: 'lot-medium', quantity: 50, needed_by: '2026-12-01' };

const ROWS: readonly Row[] = [
  { name: 'a document that is no ranking', code: 'bad_document', footprint: UNTOUCHED, run: (w) => w.run(w.request(NO_RANKING)) },
  { name: 'a ranking with a member that the kit does not list', code: 'bad_document', footprint: UNTOUCHED, run: (w) => w.run(w.request(w.document({ note: 'a member of the sender' }))) },
  { name: 'a ranking with no ranked entry', code: 'bad_document', footprint: UNTOUCHED, run: (w) => w.run(w.request(w.document({ ranked: [] }))) },
  { name: 'a ranking for another tenant than the request', code: 'ranking_not_for_tenant', footprint: UNTOUCHED, run: (w) => w.run(w.request(w.document({ tenant: 'run2' }))) },
  { name: 'a request for another tenant than the ranking', code: 'ranking_not_for_tenant', footprint: UNTOUCHED, run: (w) => w.run(w.request(w.document(), APPROVAL, 'run2')) },
  {
    name: 'a ledger that cannot be read for the delegation', code: 'ledger_unavailable', footprint: READ_ONLY,
    run: (w) => {
      w.reads.failDelegation = new Error('the ledger is down');
      return w.run();
    },
  },
  {
    name: 'a ledger that cannot be read for the delegate key', code: 'ledger_unavailable', footprint: READ_ONLY,
    run: (w) => {
      w.delegateKey.failure = new Error('the ledger is down');
      return w.run();
    },
  },
  {
    name: 'a delegation that the ledger does not show', code: 'delegation_not_found', footprint: READ_ONLY,
    run: (w) => {
      w.reads.delegations.set(DELEGATION, null);
      w.delegateKey.hash = null;
      return w.run();
    },
  },
  {
    name: 'a delegation key that this agent does not hold', code: 'delegation_key_unknown', footprint: READ_ONLY,
    run: (w) => {
      w.delegateKey.hash = '77'.repeat(28);
      return w.run();
    },
  },
  {
    name: 'a caller that hung up before the token', code: 'aborted', footprint: READ_ONLY,
    run: (w) => {
      const hangUp = new AbortController();
      hangUp.abort();
      return w.run(w.request(), w.arrived, w.deps, hangUp.signal);
    },
  },
  {
    name: 'a caller that hung up while the gateway made the token', code: 'aborted', footprint: TOKEN_ONLY,
    run: (w) => {
      const hangUp = new AbortController();
      w.hooks.afterAnswer = () => { hangUp.abort(); };
      return w.run(w.request(), w.arrived, w.deps, hangUp.signal);
    },
  },
  { name: 'a job that arrives with no time left', code: 'deadline', footprint: UNTOUCHED, run: (w) => w.run(w.request(), w.arrived - EXECUTE_DEADLINE_MS) },
  {
    name: 'a gateway that does not give the token in time', code: 'deadline', footprint: TOKEN_ONLY,
    run: async (w) => {
      w.hooks.hang = true;
      const started = new Promise<void>((resolve) => { w.hooks.onAsk = resolve; });
      const pending = w.run();
      await started;
      w.clock.advance(EXECUTE_DEADLINE_MS);
      return pending;
    },
  },
  {
    // The clock of the job shows the end of the window as soon as the gateway has answered, so no wait is open when the time runs out: the job finds it before the call.
    name: 'a token that comes with no time left for the call', code: 'deadline', footprint: TOKEN_ONLY,
    run: (w) => w.run(w.request(), w.arrived, { ...w.deps, clock: () => (w.tokens.length === 0 ? w.gateway.now() : w.arrived + EXECUTE_DEADLINE_MS) }),
  },
  {
    name: 'a gateway that refuses the token', code: 'token_failed', footprint: TOKEN_ONLY,
    run: (w) => {
      w.gateway.endDelegation(w.delegation);
      return w.run();
    },
  },
  {
    name: 'a record that answers with an error', code: 'mock_system_failed', footprint: ONE_CALL,
    run: (w) => {
      w.record.answer = () => jsonResponse(500, { error: 'internal', message: 'words of the record' });
      return w.run();
    },
  },
];

describe('each failure of the job', () => {
  for (const row of ROWS) {
    it(`is failed with ${row.code}, and sends only what its footprint says: ${row.name}`, async () => {
      const w = world();
      const result = await row.run(w);
      expect(words(result)).toBe(`failed ${row.code} Failed`);
      expect(result).toMatchObject({ schema: 'vector.usecase.result.v1', use_case: 'bid-evaluation', handoff: null, writes: [], decisions: [], challenge: null, fault_mode: '' });
      expect(footprint(w)).toStrictEqual(row.footprint);
      // The ranking is written by no failure of the job itself, and no failure reads a vault.
      expect(w.record.calls.length).toBeLessThanOrEqual(1);
      expect(w.reads.calls.liveVaults).toBe(0);
      // Each end has a line with its code, and the words of the record are not in it.
      expect(w.log.join('\n')).toContain(row.code);
      expect(w.log.join('\n')).not.toContain('words of the record');
    });
  }

  it('twin: the world of the rows, with no fault, writes the ranking', async () => {
    const w = world();
    expect(words(await w.run())).toBe('completed none Completed');
    expect(footprint(w)).toStrictEqual(ONE_CALL);
  });

  it('twin: a request and a ranking of one tenant that is not the tenant of the tests are written all the same', async () => {
    const w = world({ tenant: 'run2' });
    const result = await w.run();
    expect(words(result)).toBe('completed none Completed');
    expect(w.record.calls[0]?.url).toBe('https://mock.example/t/run2/sourcing/rankings');
  });
});

describe('the closed list of the codes of a failed result', () => {
  it('holds the codes that the rows write, and the rows write the codes of the list: the two sets are equal, in both directions', async () => {
    const seen = new Set<string>();
    for (const row of ROWS) {
      const result = await row.run(world());
      if (result.outcome === 'failed') seen.add(result.reason);
    }
    expect([...seen].sort()).toStrictEqual([...EXECUTE_FAILURES].sort());
  });

  it('is a frozen list of codes, each once, each with the form of a code', () => {
    expect(Object.isFrozen(EXECUTE_FAILURES)).toBe(true);
    expect(new Set(EXECUTE_FAILURES).size).toBe(EXECUTE_FAILURES.length);
    for (const code of EXECUTE_FAILURES) expect(code).toMatch(/^[a-z0-9_]{1,64}$/);
  });

  it('does not hold the codes of the sourcing record: they are a class, and the reason of a refusal is not in the list', () => {
    const OF_THE_RECORD = [
      'approval_not_found', 'approval_wrong_type', 'approval_wrong_subject', 'approval_wrong_issuer', 'approval_revoked', 'approval_expired', 'approval_issuer_invalid', 'approval_digest_mismatch',
      'delegation_ended', 'supplier_not_active', 'not_covered', 'chain_too_deep', 'token_invalid', 'refusal_without_code',
    ];
    for (const code of OF_THE_RECORD) expect(EXECUTE_FAILURES).not.toContain(code);
  });
});
