// agents/prior-authorization-agent/test/propose/limits.test.ts: the time and the hang-up. Every wait of the job is bounded by the deadline, which comes 1,620,000 ms after the arrival of the job. A call of a port
// that would start after the deadline is not made, and a caller that hangs up stops the job before its next step: no port is called after that. A decision that was paid for stays in the result. Each limit has its
// twin: the same job one millisecond inside it.
import { describe, expect, it } from 'vitest';
import { DECISION_RESERVE_MS, PROPOSE_DEADLINE_MS } from '../../src/propose/index.ts';
import { DECISION, GUIDELINE, NOW, PORTS, RECORD_SET, SUB_JOB, TENANT, calledPorts, expectFailed, expectNothingPaid, proposed, world } from './support.ts';
import type { World } from './support.ts';

describe('the deadline', () => {
  it('is 1,620,000 ms after the arrival of the job, and the decision keeps 300,000 ms of it', () => {
    expect(PROPOSE_DEADLINE_MS).toBe(1_620_000);
    expect(DECISION_RESERVE_MS).toBe(300_000);
  });

  it('fails with deadline before it does anything when the deadline is past or the time of the arrival is no number, and goes on for a job that has one millisecond: the twin', async () => {
    for (const arrivedAt of [NOW - PROPOSE_DEADLINE_MS, NOW - PROPOSE_DEADLINE_MS - 5_000, Number.NaN, Number.NEGATIVE_INFINITY]) {
      const w = world();
      expectFailed(await w.run({ arrivedAt }), 'deadline');
      expect(calledPorts(w)).toStrictEqual([]);
      expectNothingPaid(w);
      expect(w.logs).toStrictEqual(['propose stopped at authority: deadline']);
    }
    const twin = world();
    proposed(await twin.run({ arrivedAt: NOW - PROPOSE_DEADLINE_MS + 1 }));
    expect(calledPorts(twin)).toStrictEqual([...PORTS]);
  });

  it('takes the time from the clock of the deps: a clock past the deadline is the deadline, also when the arrival is in the future', async () => {
    const w = world();
    w.clock.jump(NOW + PROPOSE_DEADLINE_MS);
    expectFailed(await w.run({ arrivedAt: NOW }), 'deadline');
    expect(calledPorts(w)).toStrictEqual([]);
  });

  it('bounds the waits of all the steps by one deadline: a slow port leaves less time to the next port', async () => {
    const w = world();
    w.script.evidence = async () => {
      await w.clock.sleep(1_000_000);
      return { ok: true, record_set: RECORD_SET, guideline: GUIDELINE };
    };
    w.script.justify = () => new Promise(() => undefined);
    expectFailed(await w.run(), 'deadline');
    expect(w.clock.now() - NOW).toBe(PROPOSE_DEADLINE_MS);
    expect(calledPorts(w)).toStrictEqual(PORTS.slice(0, 5));
  });
});

/** Makes a port call `fire` after it did its work, as a port does when the caller hangs up, or the time runs out, while the port works. */
type Hook = (w: World, fire: () => void) => void;
const HOOKS: readonly (readonly [string, Hook])[] = [
  [
    'the authority',
    (w, fire) => {
      const read = w.script.delegation;
      w.script.delegation = async () => {
        const answer = await read();
        fire();
        return answer;
      };
    },
  ],
  [
    'the paying key',
    (w, fire) => {
      const read = w.script.delegateKeyOf;
      w.script.delegateKeyOf = async (id) => {
        const answer = await read(id);
        fire();
        return answer;
      };
    },
  ],
  [
    'the insurer',
    (w, fire) => {
      const read = w.script.readInsurer;
      w.script.readInsurer = async (insurer) => {
        const answer = await read(insurer);
        fire();
        return answer;
      };
    },
  ],
  [
    'the evidence',
    (w, fire) => {
      const read = w.script.evidence;
      w.script.evidence = async (request, run) => {
        const answer = await read(request, run);
        fire();
        return answer;
      };
    },
  ],
  [
    'the decision',
    (w, fire) => {
      const decide = w.script.justify;
      w.script.justify = async (set, guideline) => {
        const answer = await decide(set, guideline);
        fire();
        return answer;
      };
    },
  ],
  [
    'the counter',
    (w, fire) => {
      const count = w.script.next;
      w.script.next = async (tenant) => {
        const answer = await count(tenant);
        fire();
        return answer;
      };
    },
  ],
];

/** The hooks of the five ports that have a step after them, with the place of each port in the order of the ports. The counter is the last port: nothing starts after it. */
const BEFORE_THE_COUNTER = HOOKS.slice(0, 5).map(([name, hook], index) => ({ name, hook, index }));

describe('a caller that hangs up', () => {
  it('stops the job before its first step, and a signal that did not abort is the twin', async () => {
    const hungUp = world();
    const controller = new AbortController();
    controller.abort();
    expectFailed(await hungUp.run({ signal: controller.signal }), 'aborted');
    expect(calledPorts(hungUp)).toStrictEqual([]);
    expectNothingPaid(hungUp);
    expect(hungUp.logs).toStrictEqual(['propose stopped at authority: aborted']);
    const twin = world();
    proposed(await twin.run({ signal: new AbortController().signal }));
    expect(calledPorts(twin)).toStrictEqual([...PORTS]);
  });

  it.each(BEFORE_THE_COUNTER)('stops the job before the step after $name, and no port is called after that', async ({ hook, index }) => {
    const w = world();
    const controller = new AbortController();
    hook(w, () => controller.abort());
    const result = await w.run({ signal: controller.signal });
    expectFailed(result, 'aborted');
    expect(calledPorts(w)).toStrictEqual(PORTS.slice(0, index + 1));
    // The decision is paid for when the caller hangs up during it: it stays in the result, and the job takes no number.
    expect(result.decisions).toStrictEqual(index === 4 ? [DECISION] : []);
    expect(result.sub_jobs).toStrictEqual(index === 4 ? [SUB_JOB] : []);
    expect(w.counterCalls).toStrictEqual([]);
    expect(w.numbers.size).toBe(0);
  });

  it('keeps the proposal when the caller hangs up during the counter: the number is taken, and no port starts after it', async () => {
    const w = world();
    const controller = new AbortController();
    HOOKS[5]![1](w, () => controller.abort());
    const result = proposed(await w.run({ signal: controller.signal }));
    expect(result.document.request_number).toBe('run1-1');
    expect(calledPorts(w)).toStrictEqual([...PORTS]);
  });
});

describe('a clock past the deadline', () => {
  it.each(BEFORE_THE_COUNTER)('stops the job before the step after $name with deadline, and no port is called after that', async ({ hook, index }) => {
    const w = world();
    hook(w, () => w.clock.jump(NOW + PROPOSE_DEADLINE_MS));
    const result = await w.run();
    expectFailed(result, 'deadline');
    expect(calledPorts(w)).toStrictEqual(PORTS.slice(0, index + 1));
    expect(result.decisions).toStrictEqual(index === 4 ? [DECISION] : []);
    expect(w.counterCalls).toStrictEqual([]);
    expect(w.numbers.size).toBe(0);
  });

  it('is the deadline when the clock is one millisecond before it: the twin goes on', async () => {
    const w = world();
    HOOKS[3]![1](w, () => w.clock.jump(NOW + PROPOSE_DEADLINE_MS - 1));
    proposed(await w.run());
    expect(calledPorts(w)).toStrictEqual([...PORTS]);
  });

  it('is the deadline when the clock gives no number after a port', async () => {
    const w = world();
    HOOKS[2]![1](w, () => w.clock.jump(Number.NaN));
    expectFailed(await w.run(), 'deadline');
    expect(calledPorts(w)).toStrictEqual(PORTS.slice(0, 3));
  });
});

describe('a port that gives no answer', () => {
  const HANGS: readonly (readonly [string, (w: World) => void])[] = [
    [
      'the authority',
      (w) => {
        w.script.delegation = () => new Promise(() => undefined);
      },
    ],
    [
      'the paying key',
      (w) => {
        w.script.delegateKeyOf = () => new Promise(() => undefined);
      },
    ],
    [
      'the insurer',
      (w) => {
        w.script.readInsurer = () => new Promise(() => undefined);
      },
    ],
    [
      'the evidence',
      (w) => {
        w.script.evidence = () => new Promise(() => undefined);
      },
    ],
    [
      'the decision',
      (w) => {
        w.script.justify = () => new Promise(() => undefined);
      },
    ],
    [
      'the counter',
      (w) => {
        w.script.next = () => new Promise(() => undefined);
      },
    ],
  ];
  it.each(HANGS.map((hang, index) => [hang[0], index] as const))('fails with deadline at the deadline of the job when %s gives no answer, and no port is called after it', async (_name, index) => {
    const w = world();
    HANGS[index]![1](w);
    const result = await w.run();
    expectFailed(result, 'deadline');
    expect(w.clock.now() - NOW).toBe(PROPOSE_DEADLINE_MS);
    expect(calledPorts(w)).toStrictEqual(PORTS.slice(0, index + 1));
    // The decision stays in the result when the counter does not answer: it was paid for.
    expect(result.decisions).toStrictEqual(index === 5 ? [DECISION] : []);
    expect(w.counterCalls).toStrictEqual(index === 5 ? [TENANT] : []);
  });

  it('bounds the evidence by the deadline of the job and not by the earlier deadline that the evidence gets: the evidence is on its own for the reserve', async () => {
    const w = world();
    HANGS[3]![1](w);
    expectFailed(await w.run(), 'deadline');
    expect(w.evidenceCalls[0]!.run.deadline).toBe(NOW + PROPOSE_DEADLINE_MS - DECISION_RESERVE_MS);
    expect(w.clock.now() - NOW).toBe(PROPOSE_DEADLINE_MS);
  });

  it('goes on when a slow port still ends inside the deadline, and the steps after it have the time that is left: the twin of the hang', async () => {
    const w = world();
    w.script.evidence = async () => {
      await w.clock.sleep(PROPOSE_DEADLINE_MS - 1_000);
      return { ok: true, record_set: RECORD_SET, guideline: GUIDELINE };
    };
    proposed(await w.run());
    expect(calledPorts(w)).toStrictEqual([...PORTS]);
    expect(w.clock.now() - NOW).toBe(PROPOSE_DEADLINE_MS - 1_000);
  });
});
