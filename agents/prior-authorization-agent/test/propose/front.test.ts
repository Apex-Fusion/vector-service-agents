// agents/prior-authorization-agent/test/propose/front.test.ts: the steps of `propose` that come before the evidence: the request, the authority, the paying key and the insurer. Each refusal and each failure
// has an accepted twin, and after each of them nothing was read for the evidence, decided or counted: the counter is never asked while an earlier step can still fail.
import { describe, expect, it } from 'vitest';
import { accepted, ERROR_STATUS } from '@vsa/usecase-kit/protocol';
import { PROPOSE_FAILURES, ProposeRefusal } from '../../src/propose/index.ts';
import { ADVERT_REF, DELEGATION, INSURER_DID, KEY, KEY_HASH, ORDER_ID, PORTS, TENANT, calledPorts, expectFailed, expectNothingPaid, proposed, refusal, world } from './support.ts';

/** What a run throws, or null when it returns. */
const thrownBy = (run: Promise<unknown>): Promise<unknown> =>
  run.then(
    () => null,
    (error: unknown) => error,
  );

describe('the request', () => {
  it.each(['Run1', 'run_1', 'run.1', 'run 1', '-run', 'x'.repeat(49)])('refuses the tenant %s, which a request number cannot hold, as bad_shape and before it does anything', async (tenant) => {
    const w = world();
    const refused = await thrownBy(w.run({ request: { tenant } }));
    expect(refused).toBeInstanceOf(ProposeRefusal);
    expect(refused).toMatchObject({ name: 'ProposeRefusal', code: 'bad_shape', status: ERROR_STATUS.bad_shape });
    expect((refused as ProposeRefusal).message).not.toContain(tenant);
    expect(calledPorts(w)).toStrictEqual([]);
    expectNothingPaid(w);
  });

  it('refuses an empty tenant as bad_shape, before it does anything', async () => {
    const w = world();
    expect(await thrownBy(w.run({ request: { tenant: '' } }))).toMatchObject({ name: 'ProposeRefusal', code: 'bad_shape' });
    expect(calledPorts(w)).toStrictEqual([]);
  });

  it('takes the longest tenant that a request number can hold: the twin', async () => {
    const tenant = 'x'.repeat(48);
    const result = proposed(await world().run({ request: { tenant } }));
    expect(result.document).toMatchObject({ tenant, request_number: `${tenant}-1` });
  });

  it('takes a tenant with digits and hyphens, and a tenant that starts with a digit: the twin', async () => {
    for (const tenant of ['0run-1', 'a', '9']) expect(proposed(await world().run({ request: { tenant } })).document).toMatchObject({ tenant, request_number: `${tenant}-1` });
  });
});

describe('the authority', () => {
  it('refuses a delegation that names another agent as its delegate, with the status of its code, before it reads or sends anything else', async () => {
    const w = world();
    const other = 'ff'.repeat(32);
    w.script.delegation = async () => ({ delegate: other, chain_whole: true });
    const refused = await thrownBy(w.run());
    expect(refused).toBeInstanceOf(ProposeRefusal);
    expect(refused).toMatchObject({ name: 'ProposeRefusal', code: 'delegation_not_mine', status: ERROR_STATUS.delegation_not_mine });
    expect(ERROR_STATUS.delegation_not_mine).toBe(400);
    const message = (refused as ProposeRefusal).message;
    expect(message).toMatch(/names another agent/);
    for (const value of [other, DELEGATION, TENANT, ORDER_ID, INSURER_DID]) expect(message).not.toContain(value);
    expect(calledPorts(w)).toStrictEqual(['delegation']);
    expectNothingPaid(w);
  });

  it('goes on for a delegation that names this agent: the twin', async () => {
    const w = world();
    proposed(await w.run());
    expect(calledPorts(w)).toStrictEqual([...PORTS]);
  });

  it('fails with ledger_unavailable when the delegation cannot be read, or the reading is not a reading, and goes no further', async () => {
    for (const read of [
      async () => {
        throw new Error('the ledger is down');
      },
      async () => ({}) as never,
      async () => 'a text' as never,
    ]) {
      const w = world();
      w.script.delegation = read;
      expectFailed(await w.run(), 'ledger_unavailable');
      expect(calledPorts(w)).toStrictEqual(['delegation']);
      expect(w.insurerCalls).toStrictEqual([]);
      expectNothingPaid(w);
    }
    expect(PROPOSE_FAILURES).toContain('ledger_unavailable');
  });

  it('goes on for a delegation that the first read does not show, because the read of the key decides: the key is found, and the run proposes', async () => {
    const w = world();
    w.script.delegation = async () => null;
    proposed(await w.run());
  });

  it('fails with delegation_not_found when the ledger shows no delegation and no key, and goes no further', async () => {
    const w = world();
    w.script.delegation = async () => null;
    w.script.delegateKeyOf = async () => null;
    expectFailed(await w.run(), 'delegation_not_found');
    expect(calledPorts(w)).toStrictEqual(['delegation', 'key']);
    expect(w.insurerCalls).toStrictEqual([]);
    expectNothingPaid(w);
    expect(PROPOSE_FAILURES).toContain('delegation_not_found');
  });
});

describe('the paying key', () => {
  it('reads the key of the delegation of the request, once', async () => {
    const w = world();
    const asked: string[] = [];
    w.script.delegateKeyOf = async (id) => {
      asked.push(id);
      return KEY_HASH;
    };
    proposed(await w.run());
    expect(asked).toStrictEqual([DELEGATION]);
  });

  it('fails with ledger_unavailable when the key of the delegation cannot be read, and the insurer is never read: a failed read gives no key', async () => {
    const w = world();
    w.script.delegateKeyOf = async () => {
      throw new Error('the ledger is down');
    };
    expectFailed(await w.run(), 'ledger_unavailable');
    expect(calledPorts(w)).toStrictEqual(['delegation', 'key']);
    expect(w.insurerCalls).toStrictEqual([]);
    expectNothingPaid(w);
  });

  it('fails with delegation_key_unknown for a key that this agent does not hold, and for a value that is no key hash, and goes no further', async () => {
    for (const value of ['ee'.repeat(28), 42 as never, '' as never]) {
      const w = world();
      w.script.delegateKeyOf = async () => value;
      expectFailed(await w.run(), 'delegation_key_unknown');
      expect(calledPorts(w)).toStrictEqual(['delegation', 'key']);
      expect(w.insurerCalls).toStrictEqual([]);
      expectNothingPaid(w);
    }
    expect(PROPOSE_FAILURES).toContain('delegation_key_unknown');
  });

  it('fails with internal when the table of the keys throws, and goes on when it holds the key: the twin', async () => {
    const w = world();
    w.script.findKey = () => {
      throw new Error('the table is broken');
    };
    expectFailed(await w.run(), 'internal');
    expect(w.insurerCalls).toStrictEqual([]);
    expectNothingPaid(w);
    proposed(await world().run());
  });

  it('gives the key that the table holds to the evidence, and no other object', async () => {
    const w = world();
    proposed(await w.run());
    expect(w.evidenceCalls).toHaveLength(1);
    expect(w.evidenceCalls[0]!.request.key).toBe(KEY);
  });
});

describe('the insurer', () => {
  it('is read before the evidence, for the insurer of the request, once: the evidence is the first port that can send something to the chain', async () => {
    const w = world();
    proposed(await w.run());
    expect(calledPorts(w).indexOf('insurer')).toBeLessThan(calledPorts(w).indexOf('evidence'));
    expect(w.insurerCalls).toStrictEqual([INSURER_DID]);
  });

  it.each(['insurer_not_listed', 'insurer_unavailable'])('fails with %s, the code of the reader, and calls no port after the reader, and its words are not in the result', async (code) => {
    const w = world();
    w.script.readInsurer = async () => refusal(code);
    const result = await w.run();
    expectFailed(result, code);
    expect(JSON.stringify(result)).not.toContain('words that the port wrote');
    expect(calledPorts(w)).toStrictEqual(['delegation', 'key', 'insurer']);
    expectNothingPaid(w);
    expect(PROPOSE_FAILURES).toContain(code);
  });

  it('passes on any code of the reader that has the form of a code', async () => {
    const w = world();
    w.script.readInsurer = async () => refusal('insurer_on_hold_7');
    expectFailed(await w.run(), 'insurer_on_hold_7');
    expectNothingPaid(w);
  });

  it.each(['Not listed, sorry', 'INSURER_NOT_LISTED', 'insurer-not-listed', '', 'x'.repeat(65), 42 as never])(
    'does not take a text that is not a code as a reason: %s is internal',
    async (code) => {
      const w = world();
      w.script.readInsurer = async () => refusal(code as string);
      expectFailed(await w.run(), 'internal');
      expectNothingPaid(w);
    },
  );

  it('takes a code of 64 characters: the twin of the code of 65', async () => {
    const w = world();
    w.script.readInsurer = async () => refusal('x'.repeat(64));
    expectFailed(await w.run(), 'x'.repeat(64));
  });

  it('fails with internal when the reader gives no result at all, and calls no port after it', async () => {
    for (const value of [undefined, null, 'a text']) {
      const w = world();
      w.script.readInsurer = async () => value as never;
      expectFailed(await w.run(), 'internal');
      expect(calledPorts(w)).toStrictEqual(['delegation', 'key', 'insurer']);
      expectNothingPaid(w);
    }
  });

  it('fails with internal when the reader throws, and calls no port after it', async () => {
    const w = world();
    w.script.readInsurer = async () => {
      throw new Error('the reader broke');
    };
    expectFailed(await w.run(), 'internal');
    expect(calledPorts(w)).toStrictEqual(['delegation', 'key', 'insurer']);
    expectNothingPaid(w);
  });

  const WRONG: [string, unknown][] = [
    ['no value', undefined],
    ['null', null],
    ['no reference of an advert', {}],
    ['a reference that is a number', { advert_ref: 5 }],
    ['a reference that is a list', { advert_ref: [ADVERT_REF] }],
    ['a text that is no reference of an output', { advert_ref: 'one' }],
    ['a hash with no index', { advert_ref: 'c3'.repeat(32) }],
    ['an index that is no number', { advert_ref: `${'c3'.repeat(32)}#x` }],
    ['a hash of 63 characters', { advert_ref: `${'c3'.repeat(31)}c#1` }],
    ['a hash with a capital letter', { advert_ref: `${'C3'.repeat(32)}#1` }],
    ['an index of 11 digits', { advert_ref: `${'c3'.repeat(32)}#12345678901` }],
    ['an index with a leading zero', { advert_ref: `${'c3'.repeat(32)}#01` }],
    ['a reference with a space after it', { advert_ref: `${'c3'.repeat(32)}#1 ` }],
  ];
  it.each(WRONG)('fails with internal when the reader gives %s as a success, before the evidence: nothing is read for an insurer that has no advert', async (_name, value) => {
    const w = world();
    w.script.readInsurer = async () => accepted(value as never);
    expectFailed(await w.run(), 'internal');
    expect(calledPorts(w)).toStrictEqual(['delegation', 'key', 'insurer']);
    expectNothingPaid(w);
  });

  it.each([['a text', 'true'], ['a number', 1], ['nothing', undefined]])('does not read success from %s: an answer whose ok is not the boolean true is internal, and no port is called after the reader', async (_name, ok) => {
    const w = world();
    w.script.readInsurer = async () => ({ ok, value: { advert_ref: ADVERT_REF } }) as never;
    expectFailed(await w.run(), 'internal');
    expect(calledPorts(w)).toStrictEqual(['delegation', 'key', 'insurer']);
    expectNothingPaid(w);
  });

  it.each(['0', '7', '9999999999'])('puts the advert of the reader into the request, for the index %s: the twin of every failure above', async (index) => {
    const w = world();
    const advertRef = `${'9d'.repeat(32)}#${index}`;
    w.script.readInsurer = async () => accepted({ advert_ref: advertRef });
    expect(proposed(await w.run()).document).toMatchObject({ insurer_did: INSURER_DID, advert_ref: advertRef });
  });
});

describe('the log of a stop', () => {
  it('writes one line for a refusal and one for a failure, with the step and the code, and no value of the request', async () => {
    const refused = world();
    refused.script.delegation = async () => ({ delegate: 'ff'.repeat(32), chain_whole: true });
    await thrownBy(refused.run());
    expect(refused.logs).toStrictEqual(['propose refused at authority: delegation_not_mine']);
    const failed = world();
    failed.script.readInsurer = async () => refusal('insurer_not_listed');
    await failed.run();
    expect(failed.logs).toStrictEqual(['propose stopped at insurer: insurer_not_listed']);
    for (const line of [...refused.logs, ...failed.logs]) for (const value of [INSURER_DID, DELEGATION, TENANT, ORDER_ID, KEY_HASH, 'words that the port wrote']) expect(line).not.toContain(value);
  });

  it('writes no line for a proposal: the twin', async () => {
    const w = world();
    proposed(await w.run());
    expect(w.logs).toStrictEqual([]);
  });

  it('changes no result when the log throws', async () => {
    const throwing = world();
    throwing.script.readInsurer = async () => refusal('insurer_not_listed');
    const log = () => {
      throw new Error('the log is closed');
    };
    expectFailed(await throwing.run({ deps: { log } }), 'insurer_not_listed');
    proposed(await world().run({ deps: { log } }));
  });
});
