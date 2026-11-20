// packages/usecase-kit/test/cosign/ledger.test.ts
// The route reads the ledger after every check that needs no network, the outputs of the transaction first and the live delegations second. A read that fails, takes too long, or gives a value of
// the wrong form is `check_unavailable`: the agent never signs on a source that it could not read, and the key is not held after the failure.
import { CML } from '@lucid-evolution/lucid';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { COSIGN_SETTINGS, COSIGN_STATUS, providerLedger } from '@vsa/usecase-kit/cosign';
import type { CosignLedger } from '@vsa/usecase-kit/cosign';
import {
  AGENT_ID, DEPLOYMENT, DELEG_A, DELEG_B, OTHER_AGENT_ID, OTHER_AGENT_KEY, STRANGER, agentWallet, build, deferred, harness, ledgerOf, liveDelegation, requestOf, signedBy, withInput, world,
} from './support.ts';
import type { Setup } from './support.ts';

type Refs = Parameters<CosignLedger['outputs']>[0];

/** A ledger that records its calls, and answers as `inner` does unless a test changes an answer. */
function spy(inner: CosignLedger = ledgerOf(world()), over: Partial<CosignLedger> = {}) {
  const calls: string[] = [];
  const refs: string[][] = [];
  const ledger: CosignLedger = {
    async outputs(list) {
      calls.push('outputs');
      refs.push(list.map((ref) => `${ref.txHash}#${ref.outputIndex}`));
      return (over.outputs ?? inner.outputs.bind(inner))(list);
    },
    async delegateKeysInUse() {
      calls.push('delegations');
      return (over.delegateKeysInUse ?? inner.delegateKeysInUse.bind(inner))();
    },
  };
  return { ledger, calls, refs };
}

const quick = { [COSIGN_SETTINGS.ledgerTimeoutMs]: '50' };

describe('the ledger is read after every check that needs no network', () => {
  it('is read twice for a good request: the outputs, then the delegations', async () => {
    const { hex } = await build();
    const { ledger, calls } = spy();
    const result = await harness({ ledger }).route.cosign(requestOf(hex));
    expect(result.ok).toBe(true);
    expect(calls).toEqual(['outputs', 'delegations']);
  });

  it('is asked for the inputs and the collateral inputs of the transaction, each one once', async () => {
    const { hex } = await build();
    const { ledger, refs } = spy();
    await harness({ ledger }).route.cosign(requestOf(hex));
    const body = CML.Transaction.from_cbor_hex(hex).body();
    const expected = new Set<string>();
    for (const list of [body.inputs(), body.collateral_inputs()]) {
      for (let i = 0; list !== undefined && i < list.len(); i++) expected.add(`${list.get(i).transaction_id().to_hex()}#${list.get(i).index()}`);
    }
    expect(refs).toHaveLength(1);
    expect(new Set(refs[0])).toEqual(expected);
    expect(refs[0]).toHaveLength(expected.size);
  });

  it('is not read for a transaction that a check without a network refuses', async () => {
    const good = await build();
    const cases: [string, string, Partial<Setup>][] = [
      ['not_a_delegation', signedBy(good.hex, DELEG_A), {}],
      ['not_for_this_agent', (await build({ delegate: OTHER_AGENT_ID, delegateKey: OTHER_AGENT_KEY.keyHash })).hex, {}],
      ['principal_not_allowed', good.hex, { allowed: [STRANGER.keyHash] }],
      ['expired', good.hex, { now: good.hi }],
      ['not_a_delegation', good.hex, { limits: { [COSIGN_SETTINGS.maxFutureMs]: '60000' } }],
    ];
    for (const [code, hex, over] of cases) {
      const { ledger, calls } = spy();
      const result = await harness({ ...over, ledger }).route.cosign(requestOf(hex));
      expect(result).toMatchObject({ ok: false, code });
      expect(calls).toEqual([]);
    }
  });

  it('is not read for a key that another signed body holds', async () => {
    const first = await build();
    const second = await build({ resources: [`script:${'be'.repeat(28)}`] });
    const { ledger, calls } = spy();
    const h = harness({ ledger });
    expect((await h.route.cosign(requestOf(first.hex))).ok).toBe(true);
    calls.length = 0;
    expect(await h.route.cosign(requestOf(second.hex))).toMatchObject({ ok: false, code: 'key_in_use' });
    expect(calls).toEqual([]);
  });

  it('is read for the outputs only when an output of the agent is spent: the delegations are not read after it', async () => {
    const { hex } = await build();
    const { ledger, calls } = spy();
    const result = await harness({ ledger }).route.cosign(requestOf(withInput(hex, agentWallet(DELEG_A, 1))));
    expect(result).toMatchObject({ ok: false, code: 'spends_agent_funds' });
    expect(calls).toEqual(['outputs']);
  });
});

describe('a ledger that cannot be read is never a pass', () => {
  const boom = (): never => {
    throw new Error('connection refused to http://node.example:1337 with the key 0123');
  };
  const hang = (): Promise<never> => deferred<never>().promise;

  const outputFaults: [string, Partial<CosignLedger>][] = [
    ['throws', { outputs: boom }],
    ['rejects', { outputs: () => Promise.reject(new Error('node is down')) }],
    ['answers with no list', { outputs: (async () => null) as unknown as CosignLedger['outputs'] }],
    ['answers with an object', { outputs: (async () => ({})) as unknown as CosignLedger['outputs'] }],
    ['answers with an output that has no address', { outputs: (async (refs: Refs) => refs.map((ref) => ({ txHash: ref.txHash, outputIndex: ref.outputIndex }))) as unknown as CosignLedger['outputs'] }],
    ['answers with an address that is not an address', { outputs: async (refs) => refs.map((ref) => ({ txHash: ref.txHash, outputIndex: ref.outputIndex, address: 'not an address' })) }],
  ];
  it.each(outputFaults)('is `check_unavailable` when the read of the outputs %s', async (_name, over) => {
    const { hex } = await build();
    const { ledger, calls } = spy(undefined, over);
    const h = harness({ ledger, limits: quick });
    const result = await h.route.cosign(requestOf(hex));
    expect(result).toMatchObject({ ok: false, code: 'check_unavailable' });
    expect(COSIGN_STATUS.check_unavailable).toBe(503);
    expect(h.signed).toEqual([]);
    expect(calls).toEqual(['outputs']);
    // The twin: the same request on a ledger that answers.
    const twin = harness();
    expect((await twin.route.cosign(requestOf(hex))).ok).toBe(true);
  });

  const delegationFaults: [string, Partial<CosignLedger>][] = [
    ['throws', { delegateKeysInUse: boom }],
    ['rejects', { delegateKeysInUse: () => Promise.reject(new Error('node is down')) }],
    ['answers with no set', { delegateKeysInUse: (async () => null) as unknown as CosignLedger['delegateKeysInUse'] }],
    ['answers with a list', { delegateKeysInUse: (async () => [DELEG_B.keyHash]) as unknown as CosignLedger['delegateKeysInUse'] }],
  ];
  it.each(delegationFaults)('is `check_unavailable` when the read of the delegations %s', async (_name, over) => {
    const { hex } = await build();
    const { ledger, calls } = spy(undefined, over);
    const h = harness({ ledger, limits: quick });
    const result = await h.route.cosign(requestOf(hex));
    expect(result).toMatchObject({ ok: false, code: 'check_unavailable' });
    expect(h.signed).toEqual([]);
    expect(calls).toEqual(['outputs', 'delegations']);
  });

  it('does not repeat the text of the failure of the node in its refusal', async () => {
    const { hex } = await build();
    const { ledger } = spy(undefined, { outputs: boom });
    const result = await harness({ ledger }).route.cosign(requestOf(hex));
    expect(JSON.stringify(result)).not.toMatch(/node\.example|1337|0123|connection/);
  });

  it('does not hold the key after a read that failed: the same transaction signs on the next request', async () => {
    const { hex } = await build();
    let broken = true;
    const { ledger } = spy(undefined, { outputs: async (refs) => (broken ? boom() : ledgerOf(world()).outputs(refs)) });
    const h = harness({ ledger });
    expect(await h.route.cosign(requestOf(hex))).toMatchObject({ ok: false, code: 'check_unavailable' });
    broken = false;
    expect((await h.route.cosign(requestOf(hex))).ok).toBe(true);
    // And another body for the same key was never blocked by the failed request.
    expect(h.signed).toHaveLength(1);
  });

  describe('the time limit of one read', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('takes the answer of a ledger that is slow but inside the limit, and refuses at the limit', async () => {
      const { hex } = await build();
      vi.useFakeTimers();
      const slow = deferred();
      const late = deferred();
      const wait = (gate: Promise<void>): Partial<CosignLedger> => ({ outputs: async (refs) => { await gate; return ledgerOf(world()).outputs(refs); } });
      const inTime = harness({ ledger: spy(undefined, wait(slow.promise)).ledger, limits: quick }).route.cosign(requestOf(hex));
      await vi.advanceTimersByTimeAsync(49);
      slow.resolve();
      expect((await inTime).ok).toBe(true);

      let settled = false;
      const tooLate = harness({ ledger: spy(undefined, wait(late.promise)).ledger, limits: quick }).route.cosign(requestOf(hex)).finally(() => { settled = true; });
      await vi.advanceTimersByTimeAsync(49);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(await tooLate).toMatchObject({ ok: false, code: 'check_unavailable' });
      late.resolve();
    });

    it.each([['outputs', 'outputs'], ['delegations', 'delegateKeysInUse']] as const)('is `check_unavailable` at the limit when the read of the %s does not answer', async (_name, method) => {
      const { hex } = await build();
      vi.useFakeTimers();
      const { ledger, calls } = spy(undefined, { [method]: hang });
      const h = harness({ ledger, limits: quick });
      const pending = h.route.cosign(requestOf(hex));
      await vi.advanceTimersByTimeAsync(50);
      expect(await pending).toMatchObject({ ok: false, code: 'check_unavailable' });
      expect(h.signed).toEqual([]);
      expect(calls).toEqual(method === 'outputs' ? ['outputs'] : ['outputs', 'delegations']);
    });
  });
});

describe('providerLedger reads the node of the fixture world', () => {
  it('gives the address of each output that is on the node, and leaves out an output that is not', async () => {
    const wallet = agentWallet(DELEG_A, 1);
    const ledger = providerLedger(world(), DEPLOYMENT);
    const found = await ledger.outputs([{ txHash: wallet.txHash, outputIndex: wallet.outputIndex }, { txHash: 'ee'.repeat(32), outputIndex: 0 }]);
    expect(found).toEqual([{ txHash: wallet.txHash, outputIndex: wallet.outputIndex, address: wallet.address }]);
  });

  it('gives the delegate keys of the live delegations at the delegation address, and no other output', async () => {
    const stray = { ...liveDelegation(DELEG_B.keyHash, '88'.repeat(32)), address: agentWallet(DELEG_A, 1).address };
    const ledger = providerLedger(world([liveDelegation(DELEG_A.keyHash), stray]), DEPLOYMENT);
    expect([...(await ledger.delegateKeysInUse())]).toEqual([DELEG_A.keyHash]);
    expect([...(await providerLedger(world(), DEPLOYMENT).delegateKeysInUse())]).toEqual([]);
    expect(AGENT_ID).toHaveLength(64);
  });
});
