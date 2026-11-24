// agents/prior-authorization-agent/test/execute/surface.test.ts: the surface of the folder `execute` and the codes of its results. The service and the page of the agent read these names, so a change to them is a change
// of a contract. `EXECUTE_REASONS` lists every code that the job writes itself as the reason of a result, and each code in it is a code that a job in these tests ends with.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DECISION_WINDOW_MS } from '@vsa/hire-kit';
import { ERROR_STATUS } from '@vsa/usecase-kit/protocol';
import * as execute from '../../src/execute/index.ts';
import { EXECUTE_REASONS, ExecuteRefusal, JOB_DEADLINE_MS } from '../../src/execute/index.ts';
import { requestDocument } from './fixtures.ts';
import type { World } from './world.ts';
import { T0, cleanWorlds, jsonResponse, world } from './world.ts';

afterEach(() => {
  vi.useRealTimers();
  cleanWorlds();
});

const OTHER_HASH = '00'.repeat(32);

describe('the surface of the folder', () => {
  it('exports the job, its refusal, its deadline, its reasons and the change of the justification, and no other value', () => {
    expect(Object.keys(execute).sort()).toStrictEqual(['EXECUTE_REASONS', 'ExecuteRefusal', 'JOB_DEADLINE_MS', 'alterJustification', 'runExecute']);
    expect(typeof execute.runExecute).toBe('function');
    expect(typeof execute.alterJustification).toBe('function');
  });

  it('has the deadline of 27 minutes', () => {
    expect(JOB_DEADLINE_MS).toBe(27 * 60 * 1_000);
  });

  it('has a refusal that carries the code and the status of the protocol', () => {
    const refusal = new ExecuteRefusal('delegation_not_mine', 'the delegation names another agent');
    expect(refusal).toBeInstanceOf(Error);
    expect([refusal.name, refusal.code, refusal.status]).toStrictEqual(['ExecuteRefusal', 'delegation_not_mine', ERROR_STATUS.delegation_not_mine]);
    expect(new ExecuteRefusal('internal', 'a setting is wrong').status).toBe(500);
  });
});

describe('the reasons of the results', () => {
  it('are the codes that the job writes itself, each one a code with the form of a code, and none twice', () => {
    expect(new Set(EXECUTE_REASONS).size).toBe(EXECUTE_REASONS.length);
    for (const reason of EXECUTE_REASONS) expect(reason).toMatch(/^[a-z0-9_]{1,64}$/);
    expect([...EXECUTE_REASONS].sort()).toStrictEqual([
      'aborted', 'bad_document', 'decision_failed', 'decision_timeout', 'delegation_key_unknown', 'delivery_not_recordable', 'inconsistent_outcome', 'intake_not_for_request', 'intake_record_invalid',
      'ledger_unavailable', 'mock_system_failed', 'port_error', 'request_not_for_tenant', 'token_failed',
    ]);
  });

  /**
   * One job for each reason that a world can make. The reason `inconsistent_outcome` needs a hire kit that ends in a way that the decision did not make, and `inconsistent.test.ts` makes it. A reason that is in
   * the list and that no job reaches would stay in the page after the code stopped writing it, so the list and these jobs must agree.
   */
  const SCENARIOS: Array<[string, (w: World) => Promise<{ reason: string | null }>, { fake?: boolean }]> = [
    ['aborted', (w) => w.run(w.request(), T0, w.deps, AbortSignal.abort()), {}],
    ['bad_document', (w) => w.run(w.request({ ...requestDocument(), note: 'extra' })), {}],
    ['request_not_for_tenant', (w) => w.run(w.request(w.document({ tenant: 'run2' }))), {}],
    ['delegation_key_unknown', (w) => { w.delegateKey.hash = '77'.repeat(28); return w.run(); }, {}],
    ['ledger_unavailable', (w) => { w.reads.failDelegation = new Error('down'); return w.run(); }, {}],
    ['delivery_not_recordable', (w) => { w.receipt.depth = 40; return w.run(); }, {}],
    ['decision_timeout', (w) => {
      w.accept.answer = () => {
        vi.advanceTimersByTime(DECISION_WINDOW_MS);
        return new Promise<never>(() => undefined);
      };
      return w.run();
    }, { fake: true }],
    ['token_failed', (w) => { w.gateway.endDelegation(w.delegation); return w.run(); }, {}],
    ['mock_system_failed', (w) => { w.store.answer = () => jsonResponse(500, { error: 'internal' }); return w.run(); }, {}],
    ['intake_record_invalid', (w) => { w.answer('the request is filed'); return w.run(); }, {}],
    ['intake_not_for_request', (w) => { w.answer({ request_number: 'run1-2' }); return w.run(); }, {}],
    ['decision_failed', (w) => { w.accept.answer = () => ({ ok: false, code: 'model_output_invalid' }); return w.run(); }, {}],
    ['port_error', (w) => { w.answer({ request_sha256: OTHER_HASH }); w.dispute.failWith = new Error('the node fell over'); return w.run(); }, {}],
  ];
  for (const [reason, scenario, how] of SCENARIOS) {
    it(`reaches ${reason}`, async () => {
      if (how.fake === true) vi.useFakeTimers();
      const w = await world();
      expect((await scenario(w)).reason).toBe(reason);
    });
  }

  it('lists every reason that these jobs reach, and the one that the inconsistent hire reaches, and no other', () => {
    const reached = [...SCENARIOS.map(([reason]) => reason), 'inconsistent_outcome'];
    expect(reached.sort()).toStrictEqual([...EXECUTE_REASONS].sort());
  });
});
