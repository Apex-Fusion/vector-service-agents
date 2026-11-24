// agents/prior-authorization-agent/test/evidence/subread.test.ts: the generic read of one subagent. A caller of `readThroughSubagent` gives the route, the codes and the parser, and the read gives back what the
// parser gave. The code of a failure is checked for its form: a code of the spec that is not 1 to 64 characters of lower-case letters, digits and underscores becomes `internal`, in the result and in the log, so
// that no text of a caller reaches a reason. Each refused form has its accepted twin.
import { tokenTarget } from '@vsa/usecase-kit/access';
import { accepted, refused } from '@vsa/usecase-kit/protocol';
import { describe, expect, it } from 'vitest';
import { readThroughSubagent } from '../../src/evidence/subread.ts';
import type { SubreadSpec } from '../../src/evidence/subread.ts';
import { BASES, ORDER_ID, RECORD_SET_BODY, TENANT, expectFailed, expectRecordedAndEnded, json, world } from './support.ts';
import type { World } from './support.ts';

/** A spec for the first read, with the parser and the codes of a test. */
function specOf(w: World, over: Partial<SubreadSpec<unknown>> = {}): SubreadSpec<unknown> {
  const target = tokenTarget(BASES, TENANT, 'records.order', { order_id: ORDER_ID });
  if (!target.ok) throw new Error('the target of the test must be made');
  return { name: 'record-reader', subagent: w.deps.subagents.record_reader, target: target.value, timeoutCode: 'record_read_timeout', invalidCode: 'record_set_invalid', parse: (body) => accepted(body), ...over };
}

const read = (w: World, spec: SubreadSpec<unknown>) => w.clock.run(readThroughSubagent(w.deps, w.request, w.runOf(), spec));

describe('the value of a read', () => {
  it('is the value of the parser, whatever its type, and the parser gets the body as the system gave it', async () => {
    const w = world();
    let seen: unknown = null;
    const result = await read(
      w,
      specOf(w, {
        parse: (body) => {
          seen = body;
          return accepted(42);
        },
      }),
    );
    expect(result).toStrictEqual({ ok: true, value: 42 });
    expect(seen).toStrictEqual(RECORD_SET_BODY);
    await expectRecordedAndEnded(w);
  });
});

describe('the form of a code', () => {
  const BAD = ['Not a code', '', 'a'.repeat(65), 'record-set', 'UPPER', 'a b', '\u00fcn\u00ef', 'a\n', 'order_not_found!'];
  const GOOD = ['a', 'record_set_invalid', 'a1_b2', '0', 'a'.repeat(64)];

  it.each(BAD)('turns the invalid code %j into internal, in the result and in the log, and ends the sub-delegation', async (code) => {
    const w = world();
    expectFailed(await read(w, specOf(w, { invalidCode: code, parse: () => refused('bad_shape', 'words that the parser wrote') })), 'internal');
    expect(w.logs).toStrictEqual(['evidence: record-reader: the read failed with internal']);
    await expectRecordedAndEnded(w);
  });

  it.each(GOOD)('keeps the invalid code %j: the twin', async (code) => {
    const w = world();
    expectFailed(await read(w, specOf(w, { invalidCode: code, parse: () => refused('bad_shape', 'words that the parser wrote') })), code);
    expect(w.logs).toStrictEqual([`evidence: record-reader: the read failed with ${code}`]);
    await expectRecordedAndEnded(w);
  });

  it.each(BAD)('turns the timeout code %j into internal when the job runs out of time', async (code) => {
    const w = world();
    w.script.requestToken = () => new Promise(() => undefined);
    expectFailed(await read(w, specOf(w, { timeoutCode: code })), 'internal');
    expect(w.logs).toStrictEqual(['evidence: record-reader: the read failed with internal']);
    await expectRecordedAndEnded(w);
  });

  it.each(GOOD)('keeps the timeout code %j: the twin', async (code) => {
    const w = world();
    w.script.requestToken = () => new Promise(() => undefined);
    expectFailed(await read(w, specOf(w, { timeoutCode: code })), code);
    await expectRecordedAndEnded(w);
  });

  it('names the subagent of the spec in the log line of a failure, and nothing else of the spec', async () => {
    const w = world();
    w.script.fetch = async () => json({ error: 'not_covered', message: 'words that the system wrote' }, 403);
    expectFailed(await read(w, specOf(w, { name: 'drafter', subagent: w.deps.subagents.drafter })), 'not_covered');
    expect(w.logs).toStrictEqual(['evidence: drafter: the read failed with not_covered']);
  });
});
