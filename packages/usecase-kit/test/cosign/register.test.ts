// packages/usecase-kit/test/cosign/register.test.ts
// The register of the signed bodies is a port, and register.ts holds its contract. Here the register in memory is held to that contract, and the route is held to its side of it: it takes the key with one
// call before it reads the ledger, it commits before the answer leaves, a failing register is `check_unavailable` and never "free", and a request that ends without a signature gives its take back.
import { setImmediate as nextTurn } from 'node:timers/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { COSIGN_SETTINGS, KeyReservations, RESERVATION_MARGIN_MS } from '@vsa/usecase-kit/cosign';
import type { ClaimResult, CosignLedger, KeyClaim, KeyRegister } from '@vsa/usecase-kit/cosign';
import { DELEG_A, NOW, agentWallet, bodyHashOf, build, deferred, harness, ledgerOf, liveDelegation, plainRequestOf, requestOf, withInput, world } from './support.ts';
import type { Setup } from './support.ts';

const claim = (body: string, over: Partial<KeyClaim> = {}): KeyClaim => ({ keyHash: 'key-1', bodyHash: body, untilMs: 1_000, ...over });

describe('the register in memory keeps the contract', () => {
  describe('take', () => {
    it('takes a free key, takes it again for the same body, and refuses another body, also while the first body is not committed', async () => {
      const register = new KeyReservations();
      expect(await register.take(claim('body-1'), 0)).toBe('held');
      expect(await register.take(claim('body-2'), 0)).toBe('in_use');
      expect(await register.take(claim('body-1'), 0)).toBe('held');
      // The twin: another key is free.
      expect(await register.take(claim('body-2', { keyHash: 'key-2' }), 0)).toBe('held');
    });

    it('checks and writes in one step: of several bodies that come at one time for one key, one is held', async () => {
      const register = new KeyReservations();
      const results = await Promise.all([register.take(claim('body-1'), 0), register.take(claim('body-2'), 0), register.take(claim('body-3'), 0), register.take(claim('body-1'), 0)]);
      expect(results).toEqual(['held', 'in_use', 'in_use', 'held']);
    });

    it('does not change an entry that the same body takes again: it stays as committed as it was', async () => {
      const register = new KeyReservations();
      await register.commit(claim('body-1'), 0);
      expect(await register.take(claim('body-1'), 0)).toBe('held');
      await register.release(claim('body-1'));
      expect(await register.take(claim('body-2'), 0)).toBe('in_use');
    });
  });

  describe('commit', () => {
    it('makes the entry committed: another body is refused, and a release does not remove it', async () => {
      const register = new KeyReservations();
      await register.take(claim('body-1'), 0);
      expect(await register.commit(claim('body-1'), 0)).toBe('held');
      await register.release(claim('body-1'));
      expect(await register.take(claim('body-2'), 1)).toBe('in_use');
      expect(register.size).toBe(1);
    });

    it('is the same compare-and-set: it makes the entry for a free key, it takes the same body again, and it refuses another body without a change', async () => {
      const register = new KeyReservations();
      expect(await register.commit(claim('body-1'), 0)).toBe('held');
      expect(await register.commit(claim('body-1'), 1)).toBe('held');
      expect(await register.commit(claim('body-2'), 1)).toBe('in_use');
      expect(await register.take(claim('body-1'), 1)).toBe('held');
      expect(await register.take(claim('body-2'), 1)).toBe('in_use');
    });

    it('makes the entry again when another request for the same body released it, and never takes the key from another body', async () => {
      const register = new KeyReservations();
      // Two requests for one body. The first one fails and releases, and the second one commits.
      await register.take(claim('body-1'), 0);
      await register.take(claim('body-1'), 0);
      await register.release(claim('body-1'));
      expect(register.size).toBe(0);
      expect(await register.commit(claim('body-1'), 0)).toBe('held');
      expect(await register.take(claim('body-2'), 0)).toBe('in_use');
      // The release came, then another body took the key, and then the second request commits: it does not get the key.
      const other = new KeyReservations();
      await other.take(claim('body-1'), 0);
      await other.release(claim('body-1'));
      expect(await other.take(claim('body-2'), 0)).toBe('held');
      expect(await other.commit(claim('body-1'), 0)).toBe('in_use');
      expect(await other.commit(claim('body-2'), 0)).toBe('held');
    });
  });

  describe('the time of the hold', () => {
    it('lasts until `untilMs` and not after it, for an entry that is not committed and for one that is committed', async () => {
      for (const committed of [false, true]) {
        const register = new KeyReservations();
        await (committed ? register.commit(claim('body-1'), 0) : register.take(claim('body-1'), 0));
        expect(await register.take(claim('body-2'), 999), `committed ${committed}`).toBe('in_use');
        expect(await register.take(claim('body-2'), 1_000), `committed ${committed}`).toBe('held');
      }
    });

    it('is not shortened by a take of the same body at a later time', async () => {
      const register = new KeyReservations();
      await register.take(claim('body-1'), 0);
      await register.take(claim('body-1', { untilMs: 500 }), 400);
      expect(await register.take(claim('body-2'), 999)).toBe('in_use');
    });

    it('rejects a time that is not a number, and makes no entry, also for a key that is free', async () => {
      const register = new KeyReservations();
      for (const [untilMs, now] of [[Number.NaN, 0], [1_000, Number.NaN], [Infinity, 0]] as const) {
        await expect(register.take(claim('body-1', { untilMs }), now)).rejects.toThrow(RangeError);
        await expect(register.commit(claim('body-1', { untilMs }), now)).rejects.toThrow(RangeError);
      }
      expect(register.size).toBe(0);
      await register.commit(claim('body-1'), 0);
      await expect(register.take(claim('body-2'), Number.NaN)).rejects.toThrow(RangeError);
      expect(await register.take(claim('body-2'), 1)).toBe('in_use');
    });
  });

  describe('release', () => {
    it('removes the entry of its own body that is not committed', async () => {
      const register = new KeyReservations();
      await register.take(claim('body-1'), 0);
      await register.release(claim('body-1'));
      expect(register.size).toBe(0);
      expect(await register.take(claim('body-2'), 0)).toBe('held');
    });

    it('does not remove the entry of another body, and does not remove a committed entry', async () => {
      const register = new KeyReservations();
      await register.take(claim('body-1'), 0);
      await register.release(claim('body-2'));
      expect(await register.take(claim('body-3'), 0)).toBe('in_use');
      await register.commit(claim('body-1'), 0);
      await register.release(claim('body-1'));
      expect(await register.take(claim('body-3'), 0)).toBe('in_use');
      expect(register.size).toBe(1);
    });

    it('does not let an old release drop the entry of a newer body', async () => {
      const register = new KeyReservations();
      await register.take(claim('body-1'), 0);
      expect(await register.take(claim('body-2', { untilMs: 5_000 }), 2_000)).toBe('held');
      await register.release(claim('body-1'));
      expect(await register.take(claim('body-3', { untilMs: 5_000 }), 2_001)).toBe('in_use');
    });

    it('is no error for a key that has no entry, and a second call does no harm', async () => {
      const register = new KeyReservations();
      await expect(register.release(claim('body-1'))).resolves.toBeUndefined();
      await register.take(claim('body-1'), 0);
      await register.release(claim('body-1'));
      await expect(register.release(claim('body-1'))).resolves.toBeUndefined();
      expect(register.size).toBe(0);
    });
  });
});

// ─── The route and its register ─────────────────────────────────────────────────────────────────────────────────────────────

interface Trace {
  call: 'take' | 'commit' | 'release';
  claim: Pick<KeyClaim, 'keyHash' | 'bodyHash'>;
  now?: number;
}

/** A register that records each call, and answers as `inner` does unless a test changes the answer to a call. `order` gets one word for each call. */
function traced(over: Partial<KeyRegister> = {}, order: string[] = [], inner: KeyReservations = new KeyReservations()) {
  const calls: Trace[] = [];
  const register: KeyRegister = {
    take: (given, now) => {
      calls.push({ call: 'take', claim: given, now });
      order.push('take');
      return (over.take ?? inner.take.bind(inner))(given, now);
    },
    commit: (given, now) => {
      calls.push({ call: 'commit', claim: given, now });
      order.push('commit');
      return (over.commit ?? inner.commit.bind(inner))(given, now);
    },
    release: (given) => {
      calls.push({ call: 'release', claim: given });
      order.push('release');
      return (over.release ?? inner.release.bind(inner))(given);
    },
  };
  return { register, calls, inner };
}

/** The ledger of the fixture world, with a word in `order` for each read. `over` changes one answer. */
function recording(order: string[], over: Partial<CosignLedger> = {}, inner: CosignLedger = ledgerOf(world())): CosignLedger {
  return {
    outputs: (refs) => {
      order.push('outputs');
      return (over.outputs ?? inner.outputs.bind(inner))(refs);
    },
    delegateKeysInUse: () => {
      order.push('delegations');
      return (over.delegateKeysInUse ?? inner.delegateKeysInUse.bind(inner))();
    },
  };
}

const quick = { [COSIGN_SETTINGS.ledgerTimeoutMs]: '50' };
const signing = (order: string[]): Setup['sign'] => (_key, good) => (hash) => {
  order.push('sign');
  return good(hash);
};

describe('the route takes the key, signs, commits and answers, in this order', () => {
  it('takes the key with one call before it reads the ledger, and commits after the signature and before the answer', async () => {
    const { hex, hi } = await build();
    const order: string[] = [];
    const { register, calls, inner } = traced({}, order);
    const h = harness({ register, ledger: recording(order), sign: signing(order) });
    const result = await h.route.cosign(requestOf(hex));
    order.push('answer');
    expect(result.ok).toBe(true);
    expect(order).toEqual(['take', 'outputs', 'delegations', 'sign', 'commit', 'answer']);
    // The take and the commit say the same: the key, the body, and the end of the window and the margin. The time is the time of the clock.
    const expected: KeyClaim = { keyHash: DELEG_A.keyHash, bodyHash: bodyHashOf(hex), untilMs: hi + RESERVATION_MARGIN_MS };
    expect(calls).toEqual([{ call: 'take', claim: expected, now: NOW }, { call: 'commit', claim: expected, now: NOW }]);
    // The entry is committed: a release does not remove it.
    await register.release(expected);
    expect(inner.size).toBe(1);
  });

  it('asks the register for no request that a rule without a network refuses', async () => {
    const { hex, hi } = await build();
    const { register, calls } = traced();
    const h = harness({ register, now: hi });
    expect(await h.route.cosign(requestOf(hex))).toMatchObject({ ok: false, code: 'expired' });
    expect(await h.route.cosign(plainRequestOf(hex))).toMatchObject({ ok: false, code: 'expired' });
    expect(calls).toEqual([]);
  });

  it('answers only after the commit has settled: a commit that is not done yet holds the answer, and a commit that is done lets it go', async () => {
    const { hex } = await build();
    const gate = deferred<ClaimResult>();
    let entered = false;
    const inner = new KeyReservations();
    const { register } = traced({
      commit: async (given, now) => {
        entered = true;
        await gate.promise;
        return inner.commit(given, now);
      },
    }, [], inner);
    const h = harness({ register });
    let settled = false;
    const pending = h.route.cosign(requestOf(hex)).finally(() => {
      settled = true;
    });
    await vi.waitFor(() => expect(entered).toBe(true));
    await nextTurn();
    // The key has signed. The answer waits for the commit.
    expect(h.signed).toHaveLength(1);
    expect(settled).toBe(false);
    gate.resolve('held');
    expect((await pending).ok).toBe(true);
  });
});

describe('a take or a commit that does not end with a signature gives the key back', () => {
  const cases: [string, () => Promise<{ hex: string; over: (order: string[]) => Partial<Setup> }>, string[]][] = [
    ['a refusal of the outputs', async () => ({ hex: withInput((await build()).hex, agentWallet(DELEG_A, 1)), over: (order) => ({ ledger: recording(order) }) }), ['take', 'outputs', 'release']],
    [
      'a refusal of the delegations',
      async () => ({ hex: (await build()).hex, over: (order) => ({ ledger: recording(order, {}, ledgerOf(world([liveDelegation(DELEG_A.keyHash)]))) }) }),
      ['take', 'outputs', 'delegations', 'release'],
    ],
    [
      'a ledger that cannot be read',
      async () => ({ hex: (await build()).hex, over: (order) => ({ ledger: recording(order, { outputs: () => Promise.reject(new Error('down')) }), limits: quick }) }),
      ['take', 'outputs', 'release'],
    ],
    [
      'a key that signs a wrong value',
      async () => ({ hex: (await build()).hex, over: (order) => ({ ledger: recording(order), sign: () => () => { order.push('sign'); return new Uint8Array(64); } }) }),
      ['take', 'outputs', 'delegations', 'sign', 'release'],
    ],
  ];

  it.each(cases)('after %s', async (_name, make, expected) => {
    const { hex, over } = await make();
    const order: string[] = [];
    const { register, inner } = traced({}, order);
    const h = harness({ ...over(order), register });
    const result = await h.route.cosign(requestOf(hex));
    expect(result.ok).toBe(false);
    expect(order).toEqual(expected);
    expect(inner.size).toBe(0);
    // The key is free: another body for it signs.
    const another = await build({ resources: [`script:${'be'.repeat(28)}`] });
    expect((await harness({ register }).route.cosign(requestOf(another.hex))).ok).toBe(true);
  });

  it('after a commit that fails: the take is given back, and no answer with a signature leaves', async () => {
    const { hex } = await build();
    const order: string[] = [];
    const { register, inner } = traced({ commit: () => Promise.reject(new Error('disk full at /var/lib/register')) }, order);
    const h = harness({ register, ledger: recording(order), sign: signing(order) });
    const result = await h.route.cosign(requestOf(hex));
    expect(result).toMatchObject({ ok: false, code: 'check_unavailable' });
    expect(JSON.stringify(result)).not.toMatch(/transaction|var\/lib|disk/);
    expect(order).toEqual(['take', 'outputs', 'delegations', 'sign', 'commit', 'release']);
    expect(inner.size).toBe(0);
  });
});

describe('the register is a port that a service gives', () => {
  it('shares the entries between two routes that get the same register: a second process, or a restart with a durable register', async () => {
    const first = await build();
    const second = await build({ resources: [`script:${'be'.repeat(28)}`] });
    const shared = new KeyReservations();
    expect((await harness({ register: shared }).route.cosign(requestOf(first.hex))).ok).toBe(true);
    const other = harness({ register: shared });
    expect(await other.route.cosign(requestOf(second.hex))).toMatchObject({ ok: false, code: 'key_in_use' });
    expect(other.signed).toEqual([]);
    // The same body gets the same answer again, from the second route.
    expect((await other.route.cosign(requestOf(first.hex))).ok).toBe(true);
  });

  it('has a register in memory for each route when the service gives none: a second route does not see the first', async () => {
    const first = await build();
    const second = await build({ resources: [`script:${'be'.repeat(28)}`] });
    expect((await harness().route.cosign(requestOf(first.hex))).ok).toBe(true);
    expect((await harness().route.cosign(requestOf(second.hex))).ok).toBe(true);
  });

  it('refuses a second body for a key while the first body is taken and not committed yet, also from another route', async () => {
    const first = await build();
    const second = await build({ resources: [`script:${'be'.repeat(28)}`] });
    const shared = new KeyReservations();
    const gate = deferred();
    const inner = ledgerOf(world());
    const ledger: CosignLedger = { outputs: async (refs) => { await gate.promise; return inner.outputs(refs); }, delegateKeysInUse: () => inner.delegateKeysInUse() };
    const waiting = harness({ register: shared, ledger }).route.cosign(requestOf(first.hex));
    const other = harness({ register: shared });
    expect(await other.route.cosign(requestOf(second.hex))).toMatchObject({ ok: false, code: 'key_in_use' });
    gate.resolve();
    expect((await waiting).ok).toBe(true);
    expect(other.signed).toEqual([]);
  });
});

describe('a register that cannot be used is never "free"', () => {
  const boom = (): never => {
    throw new Error('connection refused to postgres://register.example:5432 with the password 0123');
  };
  const faults: [string, Partial<KeyRegister>][] = [
    ['throws', { take: boom }],
    ['rejects', { take: () => Promise.reject(new Error('the database is down')) }],
    ['answers true', { take: (async () => true) as unknown as KeyRegister['take'] }],
    ['answers nothing', { take: (async () => undefined) as unknown as KeyRegister['take'] }],
    ['answers a text that is not an answer', { take: (async () => 'free') as unknown as KeyRegister['take'] }],
    ['answers an answer in upper case', { take: (async () => 'HELD') as unknown as KeyRegister['take'] }],
    ['answers an object', { take: (async () => ({ held: true })) as unknown as KeyRegister['take'] }],
  ];

  it.each(faults)('is `check_unavailable` when the take %s: no read of the ledger, no signature', async (_name, over) => {
    const { hex } = await build();
    const order: string[] = [];
    const { register } = traced(over, order);
    const h = harness({ register, ledger: recording(order), limits: quick });
    const result = await h.route.cosign(requestOf(hex));
    expect(result).toMatchObject({ ok: false, code: 'check_unavailable' });
    expect(JSON.stringify(result)).not.toMatch(/postgres|register\.example|0123|database/);
    expect(h.signed).toEqual([]);
    expect(order).toEqual(['take']);
    // The twin: a register that answers.
    expect((await harness().route.cosign(requestOf(hex))).ok).toBe(true);
  });

  const commitFaults: [string, Partial<KeyRegister>][] = [
    ['throws', { commit: boom }],
    ['rejects', { commit: () => Promise.reject(new Error('the database is down')) }],
    ['answers true', { commit: (async () => true) as unknown as KeyRegister['commit'] }],
    ['answers nothing', { commit: (async () => undefined) as unknown as KeyRegister['commit'] }],
    ['answers a text that is not an answer', { commit: (async () => 'done') as unknown as KeyRegister['commit'] }],
  ];

  it.each(commitFaults)('is `check_unavailable` when the commit %s: the key signed, and the signature does not leave', async (_name, over) => {
    const { hex } = await build();
    const { register } = traced(over);
    const h = harness({ register, limits: quick });
    const response = await h.route.handle({ method: 'POST', headers: { 'content-type': 'application/json' }, body: (async function* () { yield requestOf(hex); })() });
    expect(response.status).toBe(503);
    expect(JSON.parse(response.body)).toMatchObject({ error: 'check_unavailable' });
    expect(response.body).not.toMatch(/transaction|postgres|register\.example|0123|database/);
    expect(h.signed).toHaveLength(1);
    expect((await harness({ register: traced().register }).route.cosign(requestOf(hex))).ok).toBe(true);
  });

  it('is `key_in_use` when the commit says that another body holds the key: the signature does not leave', async () => {
    const { hex } = await build();
    const { register } = traced({ commit: async () => 'in_use' });
    const h = harness({ register });
    const result = await h.route.cosign(requestOf(hex));
    expect(result).toMatchObject({ ok: false, code: 'key_in_use' });
    expect(JSON.stringify(result)).not.toContain('transaction');
    expect(h.signed).toHaveLength(1);
  });

  it('does not change the answer when the release fails: the refusal stays the refusal', async () => {
    const { hex } = await build();
    const order: string[] = [];
    const { register } = traced({ release: () => Promise.reject(new Error('the database is down')) }, order);
    const h = harness({ register, ledger: recording(order, { outputs: () => Promise.reject(new Error('down')) }), limits: quick });
    expect(await h.route.cosign(requestOf(hex))).toMatchObject({ ok: false, code: 'check_unavailable' });
    expect(order).toEqual(['take', 'outputs', 'release']);
  });

  describe('the time limit of one call', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it.each([['take'], ['commit']] as const)('is `check_unavailable` at the limit when the %s does not answer', async (method) => {
      const { hex } = await build();
      vi.useFakeTimers();
      const order: string[] = [];
      const { register } = traced({ [method]: () => deferred<ClaimResult>().promise }, order);
      const h = harness({ register, ledger: recording(order), limits: quick });
      let settled = false;
      const pending = h.route.cosign(requestOf(hex)).finally(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(49);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      if (method === 'commit') await vi.advanceTimersByTimeAsync(50);
      expect(await pending).toMatchObject({ ok: false, code: 'check_unavailable' });
      expect(order).toEqual(method === 'take' ? ['take'] : ['take', 'outputs', 'delegations', 'commit', 'release']);
    });

    it('answers a refusal after the limit when the release does not answer', async () => {
      const { hex } = await build();
      vi.useFakeTimers();
      const order: string[] = [];
      const { register } = traced({ release: () => deferred<void>().promise }, order);
      const h = harness({ register, ledger: recording(order, { outputs: () => Promise.reject(new Error('down')) }), limits: quick });
      const pending = h.route.cosign(requestOf(hex));
      await vi.advanceTimersByTimeAsync(50);
      expect(await pending).toMatchObject({ ok: false, code: 'check_unavailable' });
    });
  });
});
