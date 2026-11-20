// packages/usecase-kit/test/cosign/keys.test.ts
// A delegation key has one live delegation at a time, and the contract does not enforce it. The agent remembers each body that it signed: while the window of that body is open it refuses another body for
// the same key with `key_in_use`, and it answers the same body again. A request that does not end with a signature does not hold the key. A key that signs a wrong value never makes an answer.
import { describe, expect, it } from 'vitest';
import { RESERVATION_MARGIN_MS } from '@vsa/usecase-kit/cosign';
import type { CosignLedger, DelegationKey } from '@vsa/usecase-kit/cosign';
import { KeyReservations } from '../../src/cosign/register.ts';
import {
  DELEG_A, DELEG_B, NOW, STRANGER, SUPPLIER, agentWallet, bodyHashOf, build, deferred, harness, hostedToolTakes, ledgerOf, liveDelegation, privateKeyOf, requestOf, withInput, world,
} from './support.ts';

/** Another Delegate for the same key: its terms differ, so its body differs. */
const another = (nowMs?: number) => build({ resources: [`script:${'be'.repeat(28)}`], ...(nowMs === undefined ? {} : { nowMs }) });

describe('the register of signed bodies', () => {
  it('refuses another body for a key whose signed body has an open window, and signs it for the other key', async () => {
    const first = await build();
    const second = await another();
    expect(bodyHashOf(first.hex)).not.toBe(bodyHashOf(second.hex));
    const h = harness();
    expect((await h.route.cosign(requestOf(first.hex))).ok).toBe(true);
    expect(await h.route.cosign(requestOf(second.hex))).toMatchObject({ ok: false, code: 'key_in_use' });
    expect(h.signed).toHaveLength(1);
    // The twin: the same terms for the other key are another key, and it is free.
    const other = await build({ delegateKey: DELEG_B.keyHash, resources: [`script:${'be'.repeat(28)}`] });
    expect((await h.route.cosign(requestOf(other.hex))).ok).toBe(true);
  });

  it('answers the same body again with the same transaction, while the window is open', async () => {
    const { hex } = await build();
    const h = harness();
    const first = await h.route.cosign(requestOf(hex));
    h.clock.now = NOW + 20 * 60_000;
    const again = await h.route.cosign(requestOf(hex));
    if (!first.ok || !again.ok) throw new Error('refused');
    expect(again.value.transaction).toBe(first.value.transaction);
  });

  it('holds the key until the end of the window and a margin of one minute, and then frees it', async () => {
    const first = await build();
    const held = first.hi + RESERVATION_MARGIN_MS;
    const h = harness();
    expect((await h.route.cosign(requestOf(first.hex))).ok).toBe(true);
    // One millisecond before the end of the margin the key is held: the second body is valid then, and it is refused for the key only.
    const early = await another(held - 1_000);
    h.clock.now = held - 1;
    expect(await h.route.cosign(requestOf(early.hex))).toMatchObject({ ok: false, code: 'key_in_use' });
    h.clock.now = held;
    expect((await h.route.cosign(requestOf((await another(held)).hex))).ok).toBe(true);
  });

  it('holds the key after the first answer even when the member never submits: no live delegation is needed', async () => {
    const first = await build();
    const second = await another();
    const h = harness({ ledger: ledgerOf(world()) });
    await h.route.cosign(requestOf(first.hex));
    expect(await h.route.cosign(requestOf(second.hex))).toMatchObject({ ok: false, code: 'key_in_use' });
  });

  it('does not hold the key for a request that was refused: a refusal of a local rule, of the outputs, of the delegations', async () => {
    const good = await build();
    const refusals: [string, () => Promise<unknown>][] = [
      ['principal_not_allowed', async () => harness({ allowed: [STRANGER.keyHash] }).route.cosign(requestOf(good.hex))],
      ['spends_agent_funds', async () => harness().route.cosign(requestOf(withInput(good.hex, agentWallet(DELEG_A, 1))))],
      ['key_in_use', async () => harness({ ledger: ledgerOf(world([liveDelegation(DELEG_A.keyHash)])) }).route.cosign(requestOf(good.hex))],
    ];
    for (const [code, run] of refusals) expect(await run(), code).toMatchObject({ ok: false, code });
    // A route that refused the first request and gets the second: the key was never held.
    const shared = harness({ ledger: ledgerOf(world([agentWallet(STRANGER, 1)])) });
    expect(await shared.route.cosign(requestOf(withInput(good.hex, agentWallet(DELEG_A, 1))))).toMatchObject({ ok: false, code: 'spends_agent_funds' });
    expect((await shared.route.cosign(requestOf((await another()).hex))).ok).toBe(true);
  });

  it('does not let two bodies for one key both pass while one of them waits for the ledger', async () => {
    const first = await build();
    const second = await another();
    const gate = deferred();
    const inner = ledgerOf(world());
    const ledger: CosignLedger = { outputs: async (refs) => { await gate.promise; return inner.outputs(refs); }, delegateKeysInUse: () => inner.delegateKeysInUse() };
    const h = harness({ ledger });
    const waiting = h.route.cosign(requestOf(first.hex));
    // The second request comes while the first waits for the ledger. It is refused at once, and it does not wait for the gate.
    expect(await h.route.cosign(requestOf(second.hex))).toMatchObject({ ok: false, code: 'key_in_use' });
    gate.resolve();
    expect((await waiting).ok).toBe(true);
    expect(h.signed).toHaveLength(1);
  });

  it('lets two requests for the same body run together, and signs for both', async () => {
    const { hex } = await build();
    const gate = deferred();
    const inner = ledgerOf(world());
    const ledger: CosignLedger = { outputs: async (refs) => { await gate.promise; return inner.outputs(refs); }, delegateKeysInUse: () => inner.delegateKeysInUse() };
    const h = harness({ ledger });
    const both = Promise.all([h.route.cosign(requestOf(hex)), h.route.cosign(requestOf(hex))]);
    gate.resolve();
    const [a, b] = await both;
    expect(a.ok && b.ok).toBe(true);
    expect(a.ok && b.ok && a.value.transaction === b.value.transaction).toBe(true);
  });

  it('keeps the key after one of two requests for the same body failed and the other signed', async () => {
    const first = await build();
    const second = await another();
    const gate = deferred();
    const inner = ledgerOf(world());
    let calls = 0;
    const ledger: CosignLedger = {
      outputs: async (refs) => { calls += 1; if (calls === 1) { await gate.promise; throw new Error('node is down'); } return inner.outputs(refs); },
      delegateKeysInUse: () => inner.delegateKeysInUse(),
    };
    const h = harness({ ledger });
    const failing = h.route.cosign(requestOf(first.hex));
    const signing = h.route.cosign(requestOf(first.hex));
    gate.resolve();
    expect(await failing).toMatchObject({ ok: false, code: 'check_unavailable' });
    expect((await signing).ok).toBe(true);
    expect(await h.route.cosign(requestOf(second.hex))).toMatchObject({ ok: false, code: 'key_in_use' });
  });
});

describe('the unit of the register', () => {
  it('takes a free key, refuses another body, and takes the same body', () => {
    const register = new KeyReservations();
    const hold = register.take('k', 'body-1', 1_000, 0);
    expect(hold).toBeDefined();
    expect(register.take('k', 'body-2', 1_000, 0)).toBeUndefined();
    expect(register.take('k', 'body-1', 1_000, 0)).toBeDefined();
    expect(register.take('other', 'body-2', 1_000, 0)).toBeDefined();
  });

  it('drops an entry that was not committed when its last request is over, and keeps a committed one until its time', () => {
    const register = new KeyReservations();
    const lost = register.take('k', 'body-1', 1_000, 0)!;
    lost.release();
    expect(register.size).toBe(0);
    expect(register.take('k', 'body-2', 1_000, 0)).toBeDefined();

    const register2 = new KeyReservations();
    const kept = register2.take('k', 'body-1', 1_000, 0)!;
    kept.commit();
    kept.release();
    expect(register2.take('k', 'body-2', 1_000, 999)).toBeUndefined();
    expect(register2.take('k', 'body-2', 1_000, 1_000)).toBeDefined();
  });

  it('keeps an entry that another request for the same body still uses, and releases each hold one time', () => {
    const register = new KeyReservations();
    const one = register.take('k', 'body-1', 1_000, 0)!;
    const two = register.take('k', 'body-1', 1_000, 0)!;
    one.release();
    one.release();
    expect(register.take('k', 'body-2', 1_000, 0)).toBeUndefined();
    two.release();
    expect(register.take('k', 'body-2', 1_000, 0)).toBeDefined();
  });

  it('does not let a stale hold drop the entry of a newer body', () => {
    const register = new KeyReservations();
    const stale = register.take('k', 'body-1', 1_000, 0)!;
    const fresh = register.take('k', 'body-2', 5_000, 2_000)!;
    stale.release();
    expect(register.take('k', 'body-3', 5_000, 2_001)).toBeUndefined();
    fresh.release();
  });

  it('takes no key when a time is not a number, also for a key that is free', () => {
    const register = new KeyReservations();
    expect(register.take('k', 'body-1', Number.NaN, 0)).toBeUndefined();
    expect(register.take('k', 'body-1', 1_000, Number.NaN)).toBeUndefined();
    expect(register.take('k', 'body-1', Infinity, 0)).toBeUndefined();
    const held = new KeyReservations();
    held.take('k', 'body-1', 1_000, 0)!.commit();
    expect(held.take('k', 'body-2', 1_000, Number.NaN)).toBeUndefined();
  });
});

describe('a key that signs a wrong value never makes an answer', () => {
  type Good = DelegationKey['sign'];
  const flipped = (signature: Uint8Array): Uint8Array => Uint8Array.from(signature, (byte, i) => (i === 10 ? byte ^ 1 : byte));
  const faults: [string, (good: Good) => Good][] = [
    ['throws', () => () => { throw new Error('the secret 0123 is in the file /keys/a'); }],
    ['rejects', () => async () => { throw new Error('the secret 0123 is in the file /keys/a'); }],
    ['gives 63 bytes', (good) => async (hash) => (await good(hash)).slice(0, 63)],
    ['gives 65 bytes', (good) => async (hash) => Uint8Array.from([...(await good(hash)), 0])],
    ['gives nothing', () => async () => new Uint8Array(0)],
    ['gives text', () => (async () => 'ab'.repeat(32)) as unknown as Good],
    ['gives zeros', () => async () => new Uint8Array(64)],
    ['signs another message', (good) => async (hash) => good(Uint8Array.from(hash).reverse())],
    ['signs with another key', () => async (hash) => privateKeyOf(SUPPLIER).sign(hash).to_raw_bytes()],
    ['changes one bit of a good signature', (good) => async (hash) => flipped(await good(hash))],
  ];

  it.each(faults)('is `internal` when the sign function %s, and the refusal does not repeat what it said', async (_name, fault) => {
    const { hex } = await build();
    const h = harness({ sign: (_key, good) => fault(good) });
    const result = await h.route.cosign(requestOf(hex));
    expect(result).toMatchObject({ ok: false, code: 'internal' });
    expect(JSON.stringify(result)).not.toMatch(/0123|keys|secret/);
    // The twin: the sign function that signs well gives the answer for the same transaction.
    expect((await harness().route.cosign(requestOf(hex))).ok).toBe(true);
  });

  it('does not hold the key after such a failure: another body for the key signs, and then that body holds it', async () => {
    const first = await build();
    const second = await another();
    let broken = true;
    const h = harness({ sign: (_key, good) => (hash) => (broken ? new Uint8Array(64) : good(hash)) });
    expect(await h.route.cosign(requestOf(first.hex))).toMatchObject({ ok: false, code: 'internal' });
    broken = false;
    expect((await h.route.cosign(requestOf(second.hex))).ok).toBe(true);
    expect(await h.route.cosign(requestOf(first.hex))).toMatchObject({ ok: false, code: 'key_in_use' });
  });

  it('gives the sign function a copy of the hash: a function that changes its argument cannot change what the route checks', async () => {
    const { hex } = await build();
    const h = harness({ sign: (_key, good) => (hash) => { const copy = Uint8Array.from(hash); hash.fill(0); return good(copy); } });
    const result = await h.route.cosign(requestOf(hex));
    if (!result.ok) throw new Error(result.detail);
    expect(hostedToolTakes(hex, result.value.transaction, DELEG_A.keyHash)).toMatchObject({ ok: true });
  });

  it('signs only with the key that the datum names: the other key is never called', async () => {
    const { hex } = await build({ delegateKey: DELEG_B.keyHash });
    const h = harness();
    await h.route.cosign(requestOf(hex));
    expect(h.signed.map((call) => call.keyHash)).toEqual([DELEG_B.keyHash]);
  });
});
