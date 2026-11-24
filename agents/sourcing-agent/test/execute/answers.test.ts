// agents/sourcing-agent/test/execute/answers.test.ts: the answers of the sourcing record that are no refusal. Only the status 201 is a ranking that the record wrote, and the job reads it from the status, never from
// a text. Any other end may have written the ranking or not, so it is `failed` with `mock_system_failed`, and the call is made one time and never again. The reference of the record is kept only when it is an
// identifier. Each form has its twin.
import { describe, expect, it } from 'vitest';
import { ONE_CALL, footprint, jsonResponse, pageResponse, words, world } from './world.ts';

const WORDS = 'words of the record';

describe('a call that ends in no refusal and no written ranking', () => {
  const FAILURES: Array<[string, () => Response | Promise<Response>]> = [
    ['an error of the record', () => jsonResponse(500, { error: 'internal', message: WORDS })],
    ['a record that cannot read its ledger', () => jsonResponse(503, { error: 'ledger_unavailable', message: WORDS })],
    ['a record whose approval check does not answer', () => jsonResponse(503, { error: 'approval_unavailable', message: WORDS })],
    ['a page of a proxy', () => pageResponse(502, '<html><body><h1>502 Bad Gateway</h1></body></html>')],
    ['a refusal that is not JSON', () => pageResponse(403, 'forbidden')],
    ['an error below 500 with no code', () => jsonResponse(404, { message: WORDS })],
    ['a redirect', () => new Response(null, { status: 301, headers: { location: 'https://mock.example/elsewhere' } })],
    ['an answer of 200, which is not a written ranking, with a body like that of a written ranking', () => jsonResponse(200, { ranking_id: 'RK-run1-0001', status: 'recorded' })],
    ['an answer of 202', () => jsonResponse(202, { ranking_id: 'RK-run1-0001' })],
    ['an answer of 201 that is not JSON', () => pageResponse(201, 'recorded')],
    ['a network that fails', () => { throw new TypeError('fetch failed'); }],
  ];
  for (const [name, answer] of FAILURES) {
    it(`is failed with mock_system_failed, because the ranking may or may not be written: ${name}`, async () => {
      const w = world();
      w.record.answer = answer;
      const result = await w.run();
      expect(words(result)).toBe('failed mock_system_failed Failed');
      expect(result).toMatchObject({ handoff: null, writes: [], decisions: [], challenge: null, fault_mode: '' });
      // The call is made one time and never again: one token, one call.
      expect(footprint(w)).toStrictEqual(ONE_CALL);
      expect(w.log.join('\n')).toContain('the ranking may be written');
      expect(w.log.join('\n')).toContain('not made again');
      expect(JSON.stringify(result)).not.toContain(WORDS);
      expect(w.log.join('\n')).not.toContain(WORDS);
    });
  }

  it('says that nothing was sent when the call is refused before it leaves: it is failed all the same, and the record is not called', async () => {
    const w = world();
    const result = await w.run(w.request(), w.arrived, { ...w.deps, calls: { ...w.deps.calls, timeoutMs: 0 } });
    expect(words(result)).toBe('failed mock_system_failed Failed');
    expect(w.record.calls).toHaveLength(0);
    expect(w.asked.count).toBe(1);
    expect(w.log.join('\n')).toContain('nothing was sent');
    expect(w.log.join('\n')).not.toContain('the ranking may be written');
  });

  it('twin: the same record that answers 201 gives completed', async () => {
    const w = world();
    expect(words(await w.run())).toBe('completed none Completed');
  });
});

describe('the status 201', () => {
  it('is the one end that is completed, and the status decides: a 201 whose body is no record of a ranking is completed with no reference', async () => {
    for (const body of [{}, { error: 'words' }, ['not an object'], 'text', null, 7]) {
      const w = world();
      w.record.answer = () => jsonResponse(201, body);
      const result = await w.run();
      expect(words(result)).toBe('completed none Completed');
      expect(result.writes).toStrictEqual([{ system: 'sourcing-record', route: 'POST /sourcing/rankings', status: 201, ref: null }]);
    }
  });

  it('keeps a reference only when it is a text of 1 to 64 characters of letters, digits, dot, hyphen and underscore, and a reference that is not kept is null', async () => {
    const refs: Array<[unknown, string | null]> = [
      ['RK-run1-0007', 'RK-run1-0007'],
      ['a.b_c-d', 'a.b_c-d'],
      ['a'.repeat(64), 'a'.repeat(64)],
      ['_-.', '_-.'],
      ['a'.repeat(65), null],
      ['', null],
      ['has a space', null],
      ['RK/1', null],
      ['RK-run1-0001\n', null],
      [7, null],
      [null, null],
      [['RK-run1-0001'], null],
    ];
    for (const [ranking, kept] of refs) {
      const w = world();
      w.record.answer = () => jsonResponse(201, { ranking_id: ranking });
      const result = await w.run();
      expect(words(result)).toBe('completed none Completed');
      expect(result.writes).toStrictEqual([{ system: 'sourcing-record', route: 'POST /sourcing/rankings', status: 201, ref: kept }]);
    }
  });

  it('is written with the one write that names the record, the route and the status, and with the golden form of the first ranking of a tenant', async () => {
    const w = world();
    const result = await w.run();
    expect(result.writes).toStrictEqual([{ system: 'sourcing-record', route: 'POST /sourcing/rankings', status: 201, ref: 'RK-run1-0001' }]);
  });
});
