// packages/usecase-kit/test/cosign/ledger.test.ts
// The route reads the ledger after every check that needs no network, the outputs of the transaction first and the live delegations second. A read that fails, takes too long, or gives a value of
// the wrong form is `check_unavailable`: the agent never signs on a source that it could not read, and the key is not held after the failure.
import { CML } from '@lucid-evolution/lucid';
import type { Provider, UTxO } from '@lucid-evolution/lucid';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { COSIGN_SETTINGS, COSIGN_STATUS, providerLedger } from '@vsa/usecase-kit/cosign';
import type { CosignLedger, LedgerOutput } from '@vsa/usecase-kit/cosign';
import {
  AGENT_ID, DEPLOYMENT, DELEG_A, DELEG_B, OTHER_AGENT_ID, OTHER_AGENT_KEY, OWN_ADDRESS, STRANGER, agentWallet, build, deferred, harness, ledgerOf, liveDelegation, requestOf, signedBy, withInput, world,
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

describe('the answer of the ledger for the outputs is checked in full', () => {
  const refOf = (output: { txHash: string; outputIndex: number }): string => `${output.txHash}#${output.outputIndex}`;
  type Found = readonly LedgerOutput[];
  /** A ledger that answers for the outputs as the fixture world does, and then `change` makes the answer that the route gets. */
  const answering = (change: (found: Found) => unknown): CosignLedger => {
    const inner = ledgerOf(world());
    return { outputs: (async (refs: Refs) => change(await inner.outputs(refs))) as unknown as CosignLedger['outputs'], delegateKeysInUse: () => inner.delegateKeysInUse() };
  };

  const wallet = agentWallet(DELEG_A, 1);
  /** The transaction that spends an output of the agent: the ledger says that the output is at the address of the agent, and the route refuses with `spends_agent_funds`. */
  const spending = async () => withInput((await build()).hex, wallet);

  it('refuses a reference that comes two times, in either order: an input of the agent cannot hide behind a second entry', async () => {
    const hex = await spending();
    // The twin: one entry for each reference gives the refusal of the rule.
    expect(await harness({ ledger: answering((found) => found) }).route.cosign(requestOf(hex))).toMatchObject({ ok: false, code: 'spends_agent_funds' });
    for (const agentLast of [false, true]) {
      const doubled = answering((found) => found.flatMap((output) => {
        if (refOf(output) !== refOf(wallet)) return [output];
        const member = { ...output, address: OWN_ADDRESS };
        return agentLast ? [member, output] : [output, member];
      }));
      const h = harness({ ledger: doubled, limits: quick });
      expect(await h.route.cosign(requestOf(hex)), `agent last: ${agentLast}`).toMatchObject({ ok: false, code: 'check_unavailable' });
      expect(h.signed).toEqual([]);
    }
  });

  it('refuses a reference that comes two times with the same address', async () => {
    const { hex } = await build();
    const h = harness({ ledger: answering((found) => [...found, found[0]!]), limits: quick });
    expect(await h.route.cosign(requestOf(hex))).toMatchObject({ ok: false, code: 'check_unavailable' });
    expect(h.signed).toEqual([]);
  });

  const faults: [string, (found: Found) => unknown][] = [
    ['an output that was not asked for', (found) => [...found, { txHash: 'ee'.repeat(32), outputIndex: 0, address: OWN_ADDRESS }]],
    ['an output of the right hash and an index that was not asked for', (found) => [...found, { ...found[0]!, outputIndex: found[0]!.outputIndex + 7 }]],
    ['a hash in upper case', (found) => found.map((output) => ({ ...output, txHash: output.txHash.toUpperCase() }))],
    ['an entry that is null', (found) => [...found, null]],
    ['an entry that is a number', (found) => [...found, 5]],
    ['an entry that is a list', (found) => [...found, []]],
    ['a hash that is not text', (found) => found.map((output) => ({ ...output, txHash: 5 }))],
    ['an index that is text', (found) => found.map((output) => ({ ...output, outputIndex: String(output.outputIndex) }))],
    ['an index that is not a whole number', (found) => found.map((output) => ({ ...output, outputIndex: output.outputIndex + 0.5 }))],
    ['an index that is below zero', (found) => found.map((output) => ({ ...output, outputIndex: -1 }))],
    ['an address that is not text', (found) => found.map((output) => ({ ...output, address: 5 }))],
    ['an answer that is a set', (found) => new Set(found)],
    ['an answer that is an object with a length', (found) => Object.assign({ length: found.length }, found)],
  ];
  it.each(faults)('is `check_unavailable` when the answer has %s', async (_name, change) => {
    const { hex } = await build();
    const h = harness({ ledger: answering(change), limits: quick });
    expect(await h.route.cosign(requestOf(hex))).toMatchObject({ ok: false, code: 'check_unavailable' });
    expect(h.signed).toEqual([]);
  });

  it('takes the entries in any order, and takes an answer that leaves out an output that is not on the ledger', async () => {
    const { hex } = await build();
    expect((await harness({ ledger: answering((found) => [...found].reverse()) }).route.cosign(requestOf(hex))).ok).toBe(true);
    // An output that the ledger does not have is not in the answer: the transaction spends an output that is not there, and the rule refuses it as it did before.
    expect(await harness({ ledger: answering(() => []) }).route.cosign(requestOf(hex))).toMatchObject({ ok: false, code: 'not_a_delegation' });
  });
});

describe('the answer of the ledger for the delegation keys in use is checked in full', () => {
  const inUse = (value: () => unknown): CosignLedger => ({ outputs: ledgerOf(world()).outputs, delegateKeysInUse: (async () => value()) as unknown as CosignLedger['delegateKeysInUse'] });
  const other = DELEG_B.keyHash;

  class Lying extends Set<string> {
    override has(): boolean {
      return false;
    }
  }

  const forms: [string, () => unknown][] = [
    ['a set of key hashes in upper case', () => new Set([DELEG_A.keyHash.toUpperCase()])],
    ['a set of delegation identifiers of 64 characters', () => new Set(['77'.repeat(32)])],
    ['a set of objects', () => new Set([{ delegateKey: DELEG_A.keyHash }])],
    ['a set with a number', () => new Set([5])],
    ['a set with a hash of 55 characters', () => new Set([DELEG_A.keyHash.slice(1)])],
    ['a set with a hash of 57 characters', () => new Set([`0${DELEG_A.keyHash}`])],
    ['a set with the key and an entry of the wrong form', () => new Set([DELEG_A.keyHash, 'not a hash'])],
    ['a map by key', () => new Map([[DELEG_A.keyHash, 1]])],
    ['a list', () => [DELEG_A.keyHash]],
    ['an object with a `has` function', () => ({ has: () => false })],
    ['a text', () => DELEG_A.keyHash],
    ['a proxy of a set', () => new Proxy(new Set([DELEG_A.keyHash]), {})],
    ['nothing', () => undefined],
  ];
  it.each(forms)('is `check_unavailable` when the answer is %s', async (_name, value) => {
    const { hex } = await build();
    const h = harness({ ledger: inUse(value), limits: quick });
    expect(await h.route.cosign(requestOf(hex))).toMatchObject({ ok: false, code: 'check_unavailable' });
    expect(h.signed).toEqual([]);
  });

  it('takes a set of key hashes of 56 lower-case characters: the key that it names is in use, and a key that it does not name is free', async () => {
    const { hex } = await build();
    expect(await harness({ ledger: inUse(() => new Set([DELEG_A.keyHash])) }).route.cosign(requestOf(hex))).toMatchObject({ ok: false, code: 'key_in_use' });
    expect((await harness({ ledger: inUse(() => new Set([other])) }).route.cosign(requestOf(hex))).ok).toBe(true);
    expect((await harness({ ledger: inUse(() => new Set()) }).route.cosign(requestOf(hex))).ok).toBe(true);
  });

  it('reads a set as the built-in set holds it: a set with a `has` that always says no still has its members', async () => {
    const { hex } = await build();
    expect(await harness({ ledger: inUse(() => new Lying([DELEG_A.keyHash])) }).route.cosign(requestOf(hex))).toMatchObject({ ok: false, code: 'key_in_use' });
  });
});

describe('a damaged delegation output is a fault of the source and not a free key', () => {
  const policy = DEPLOYMENT.delegation.hash;
  const live = liveDelegation(DELEG_A.keyHash);
  const unit = `${policy}${'77'.repeat(32)}`;
  const damaged: [string, UTxO][] = [
    ['has no datum', { ...live, datum: undefined }],
    ['has a datum hash and no inline datum', { ...live, datum: undefined, datumHash: '11'.repeat(32) }],
    ['has a datum that is not a delegation', { ...live, datum: 'd87980' }],
    ['has a datum that is not CBOR', { ...live, datum: 'zz' }],
    ['holds two tokens of the policy', { ...live, assets: { ...live.assets, [`${policy}${'78'.repeat(32)}`]: 1n } }],
    ['holds its token in the quantity 2', { ...live, assets: { lovelace: 2_000_000n, [unit]: 2n } }],
    ['holds its token in the quantity 0', { ...live, assets: { lovelace: 2_000_000n, [unit]: 0n } }],
  ];

  it.each(damaged)('is `check_unavailable` when an output at the delegation script %s', async (_name, utxo) => {
    const { hex } = await build();
    await expect(providerLedger(world([utxo]), DEPLOYMENT).delegateKeysInUse()).rejects.toThrow();
    const h = harness({ ledger: ledgerOf(world([utxo])), limits: quick });
    expect(await h.route.cosign(requestOf(hex))).toMatchObject({ ok: false, code: 'check_unavailable' });
    expect(h.signed).toEqual([]);
    // The output may name any key, and the agent cannot tell which: a request for the other key is refused too.
    const other = harness({ ledger: ledgerOf(world([utxo])), limits: quick });
    expect(await other.route.cosign(requestOf((await build({ delegateKey: DELEG_B.keyHash })).hex))).toMatchObject({ ok: false, code: 'check_unavailable' });
  });

  it('takes the outputs that are good: a live delegation of another key leaves the key free, a live delegation of the key is `key_in_use`', async () => {
    const { hex } = await build();
    expect((await harness({ ledger: ledgerOf(world([liveDelegation(DELEG_B.keyHash)])) }).route.cosign(requestOf(hex))).ok).toBe(true);
    expect(await harness({ ledger: ledgerOf(world([live])) }).route.cosign(requestOf(hex))).toMatchObject({ ok: false, code: 'key_in_use' });
  });

  it('leaves out an output at the delegation script that has no token of the policy: it is no delegation', async () => {
    const { hex } = await build();
    const plain: UTxO = { txHash: 'cc'.repeat(32), outputIndex: 0, address: DEPLOYMENT.delegation.address, assets: { lovelace: 2_000_000n } };
    const withDatumHash: UTxO = { ...plain, txHash: 'cd'.repeat(32), datumHash: '11'.repeat(32) };
    const withOtherToken: UTxO = { ...plain, txHash: 'ce'.repeat(32), assets: { lovelace: 2_000_000n, [`${'ab'.repeat(28)}${'77'.repeat(32)}`]: 1n } };
    const ledger = providerLedger(world([plain, withDatumHash, withOtherToken]), DEPLOYMENT);
    expect([...(await ledger.delegateKeysInUse())]).toEqual([]);
    expect((await harness({ ledger: ledgerOf(world([plain, withDatumHash, withOtherToken])) }).route.cosign(requestOf(hex))).ok).toBe(true);
  });

  it('refuses an output with a token of the policy that the node gives for the delegation address and that is at another address', async () => {
    const node = { getUtxos: async () => [{ ...live, address: OWN_ADDRESS }] } as unknown as Provider;
    await expect(providerLedger(node, DEPLOYMENT).delegateKeysInUse()).rejects.toThrow();
  });

  it('reads the node one time, and gives the reader of buyer-core the outputs that it checked', async () => {
    const base = world([live, liveDelegation(DELEG_B.keyHash, '88'.repeat(32))]);
    let reads = 0;
    const counted = { getUtxos: async (address: string) => { reads += 1; return base.getUtxos(address); } } as unknown as Provider;
    expect([...(await providerLedger(counted, DEPLOYMENT).delegateKeysInUse())].sort()).toEqual([DELEG_A.keyHash, DELEG_B.keyHash].sort());
    expect(reads).toBe(1);
  });
});
