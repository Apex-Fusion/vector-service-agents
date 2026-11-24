// agents/prior-authorization-agent/test/execute/authority.test.ts: what the job `execute` checks before it pays: the settings, the request document, the tenant, the authority of the delegation, the delegation key
// that pays, the advert, and the time. A job that stops here pays nothing, sends nothing and asks no model. A delegation that the ledger does not show does not stop the job, and the ledger refuses the Pay.
// Each refusal has an accepted twin.
import { afterEach, describe, expect, it } from 'vitest';
import { ExecuteRefusal, JOB_DEADLINE_MS } from '../../src/execute/index.ts';
import type { ExecuteDeps } from '../../src/execute/index.ts';
import { requestDocument } from './fixtures.ts';
import type { World } from './world.ts';
import { DELEGATION, LIMITS, NOTHING, T0, cleanWorlds, footprint, hireOf, words, world } from './world.ts';

afterEach(() => { cleanWorlds(); });

const COMPLETED = 'completed none Completed';
const OTHER_AGENT = 'c3'.repeat(32);

describe('a delegation that names another agent', () => {
  it('is refused for the server with delegation_not_mine and the status 400: nothing is read after it, paid, sent or asked', async () => {
    const w = await world();
    w.reads.delegations.set(DELEGATION, { delegate: OTHER_AGENT, chain_whole: true });
    let keysAsked = 0;
    const deps: ExecuteDeps = { ...w.deps, delegateKeyOf: async () => { keysAsked += 1; return w.delegateKey.hash; } };
    const refused = w.run(w.request(), T0, deps);
    await expect(refused).rejects.toBeInstanceOf(ExecuteRefusal);
    await expect(refused).rejects.toMatchObject({ name: 'ExecuteRefusal', code: 'delegation_not_mine', status: 400 });
    expect(footprint(w)).toStrictEqual(NOTHING);
    expect(keysAsked).toBe(0);
    expect(w.reads.calls.liveVaults).toBe(0);
  });

  it('twin: a delegation that names this agent goes on', async () => {
    const w = await world();
    expect(words(await w.run())).toBe(COMPLETED);
  });
});

describe('a delegation that the ledger does not show', () => {
  it('goes on with the first key, and the ledger decides the Pay: a chain that holds the vault pays', async () => {
    const w = await world();
    w.reads.delegations.set(DELEGATION, null);
    w.delegateKey.hash = null;
    expect(words(await w.run())).toBe(COMPLETED);
    expect([w.a.pays.length, w.b.pays.length]).toStrictEqual([1, 0]);
  });

  it('ends with no_live_vault when no vault stands under it: nothing is paid, and the first key was the one that looked', async () => {
    const w = await world({ vault: false });
    w.reads.delegations.set(DELEGATION, null);
    w.delegateKey.hash = null;
    const result = await w.run();
    expect(words(result)).toBe('failed no_live_vault Failed');
    expect(result.handoff).toBeNull();
    expect(footprint(w)).toStrictEqual(NOTHING);
    expect(w.reads.calls.liveVaults).toBe(1);
  });

  it('is Cancelled when the ledger refuses the Pay and the delegation is gone', async () => {
    const w = await world();
    w.endDelegation();
    w.delegateKey.hash = null;
    expect(words(await w.run())).toBe('vault_refused no_delegation Cancelled');
  });
});

describe('a ledger that cannot be read', () => {
  it('is failed with ledger_unavailable when the delegation cannot be read: nothing is paid, and the error of the ledger is not in the result or the log', async () => {
    const w = await world();
    w.reads.failDelegation = new Error('koios answered 502 for the key k9-secret');
    const result = await w.run();
    expect(words(result)).toBe('failed ledger_unavailable Failed');
    expect(footprint(w)).toStrictEqual(NOTHING);
    expect(`${JSON.stringify(result)}${w.log.join('\n')}`).not.toContain('k9-secret');
    w.reads.failDelegation = null;
    expect(words(await w.run())).toBe(COMPLETED);
  });

  it('is failed with ledger_unavailable when the delegate key cannot be read: nothing is paid', async () => {
    const w = await world();
    w.delegateKey.failure = new Error('the ledger is down');
    const result = await w.run();
    expect(words(result)).toBe('failed ledger_unavailable Failed');
    expect(footprint(w)).toStrictEqual(NOTHING);
    w.delegateKey.failure = null;
    expect(words(await w.run())).toBe(COMPLETED);
  });
});

describe('the delegation key that pays', () => {
  it('is failed with delegation_key_unknown when the delegation names a key that this agent does not hold: nothing is paid', async () => {
    const w = await world();
    w.delegateKey.hash = '77'.repeat(28);
    const result = await w.run();
    expect(words(result)).toBe('failed delegation_key_unknown Failed');
    expect(footprint(w)).toStrictEqual(NOTHING);
    expect([w.a.pays.length, w.b.pays.length]).toStrictEqual([0, 0]);
  });

  it('looks the key up by the hash that the ledger gave, and by no other', async () => {
    const w = await world({ delegate: 'b' });
    const asked: string[] = [];
    const deps: ExecuteDeps = { ...w.deps, delegationKeys: { find: (hash) => { asked.push(hash); return w.deps.delegationKeys.find(hash); }, first: w.deps.delegationKeys.first } };
    expect(words(await w.run(w.request(), T0, deps))).toBe(COMPLETED);
    expect(asked).toStrictEqual([w.b.testKey.keyHash]);
  });

  it('pays from the key that the delegation names, and asks for the token of the records system with the same key', async () => {
    const second = await world({ delegate: 'b' });
    expect(words(await second.run())).toBe(COMPLETED);
    expect([second.a.pays.length, second.b.pays.length]).toStrictEqual([0, 1]);
    expect(second.tokens[0]!.answer.ok).toBe(true);
    // The twin: the first key, when the delegation names it.
    const first = await world({ delegate: 'a' });
    expect(words(await first.run())).toBe(COMPLETED);
    expect([first.a.pays.length, first.b.pays.length]).toStrictEqual([1, 0]);
  });

  it('gets no token for the records system from a key that is not the delegate key on the gateway: the gateway binds the token to the key, and the job says token_failed', async () => {
    const w = await world({ delegate: 'b' });
    // The ledger names the first key, and the gateway knows the second key as the delegate key.
    w.delegateKey.hash = w.a.testKey.keyHash;
    const result = await w.run();
    expect(words(result)).toBe('failed token_failed Failed');
    expect(hireOf(result)).toMatchObject({ accepted: 'confirmed' });
    expect(w.store.calls).toHaveLength(0);
  });

  it('is refused for the server with internal when the chain of the key cannot pay from a vault: a fault of the settings, and nothing is paid', async () => {
    const w = await world();
    w.delegateKey.hash = null;
    const deps: ExecuteDeps = { ...w.deps, delegationKeys: { find: () => null, first: await w.plainKey() } };
    const refused = w.run(w.request(), T0, deps);
    await expect(refused).rejects.toMatchObject({ name: 'ExecuteRefusal', code: 'internal', status: 500 });
    expect(footprint(w)).toStrictEqual(NOTHING);
  });
});

describe('a request document that is not an authorization request', () => {
  const BAD: Array<[string, () => Record<string, unknown>]> = [
    ['a member that is not listed', () => ({ ...requestDocument(), note: 'extra' })],
    ['the schema of another document', () => requestDocument({ schema: 'vector.usecase.po.v1' })],
    ['no order id', () => { const { order_id: _order, ...rest } = requestDocument(); return rest; }],
    ['a request number that is not an identifier', () => requestDocument({ request_number: 'run 1' })],
    ['a justification of more than 4,000 characters', () => requestDocument({ justification: 'x'.repeat(4_001) })],
    ['a justification with a zero width space', () => requestDocument({ justification: 'Pain persists.\u200b' })],
    ['an insurer that is not a DID', () => requestDocument({ insurer_did: 'insurer' })],
    ['a hash of the record set in upper case', () => requestDocument({ record_set_sha256: 'AB'.repeat(32) })],
  ];
  for (const [name, make] of BAD) {
    it(`is failed with bad_document before any read of the ledger: ${name}`, async () => {
      const w = await world();
      const result = await w.run(w.request(make()));
      expect(words(result)).toBe('failed bad_document Failed');
      expect(result.handoff).toBeNull();
      expect(footprint(w)).toStrictEqual(NOTHING);
      expect(w.reads.calls).toStrictEqual({ delegation: 0, liveVaults: 0 });
    });
  }

  it('twin: an authorization request is taken', async () => {
    const w = await world();
    expect(words(await w.run(w.request(w.document())))).toBe(COMPLETED);
  });
});

describe('a request of another tenant than the job', () => {
  // The records system takes a submission for the tenant of its URL, and for no other. A request of another tenant would be refused after the Pay and the Accept, so the job stops before it reads the ledger.
  const OTHER: Array<[string, Record<string, unknown>, string | undefined]> = [
    ['a request that names another tenant', { tenant: 'run2' }, undefined],
    ['a request that names the tenant of the job in another case', {}, 'Run1'],
  ];
  for (const [name, over, tenant] of OTHER) {
    it(`is failed with request_not_for_tenant before any read of the ledger: nothing is read, paid, sent, written or asked, and the vault is untouched: ${name}`, async () => {
      const w = await world();
      const result = await w.run(w.request(w.document(over), undefined, tenant));
      expect(words(result)).toBe('failed request_not_for_tenant Failed');
      expect(result.handoff).toBeNull();
      expect(footprint(w)).toStrictEqual(NOTHING);
      expect(w.reads.calls).toStrictEqual({ delegation: 0, liveVaults: 0 });
      expect(w.m.chain.vault(w.vault)).toMatchObject({ kind: 'Live', consumed: false });
      expect(w.tokens).toHaveLength(0);
    });
  }

  it('twin: a request that names the tenant of the job is carried out, and the records system gets the submission at the URL of that tenant and that order', async () => {
    const w = await world();
    expect(words(await w.run(w.request(w.document({ tenant: 'run1' }), undefined, 'run1')))).toBe(COMPLETED);
    expect(w.store.calls[0]?.url).toBe('https://mock.example/t/run1/records/orders/ORD-1001/submission');
  });
});

describe('an advert that is not the one the request names', () => {
  it('is failed with advert_not_counterparty when the agent of the advert is not the insurer of the request: nothing is paid', async () => {
    const w = await world();
    const result = await w.run(w.request(w.document({ insurer_did: `did:vector:${'99'.repeat(32)}` })));
    expect(words(result)).toBe('failed advert_not_counterparty Failed');
    expect(footprint(w)).toStrictEqual(NOTHING);
  });

  it('is failed with advert_unavailable when the advert has another model than insurer-intake-agent-v1: the hire pins the model, and nothing is paid', async () => {
    const w = await world({ advert: { model: 'insurer-intake-agent-v2' } });
    expect(words(await w.run())).toBe('failed advert_unavailable Failed');
    expect(footprint(w)).toStrictEqual(NOTHING);
  });

  it('is failed with advert_unavailable when the advert has another capability than the intake capability: the hire pins it, and nothing is paid', async () => {
    const w = await world({ advert: { capability_id: 'health.priorauth.draft.v1' } });
    expect(words(await w.run())).toBe('failed advert_unavailable Failed');
    expect(footprint(w)).toStrictEqual(NOTHING);
  });
});

describe('the settings of the job', () => {
  const SETTINGS: Array<[string, (w: World) => ExecuteDeps]> = [
    ['a limit that is missing', (w) => ({ ...w.deps, limits: { maxPriceLovelace: 2_000_000n, maxSupplierBondLovelace: 2_000_000n } as never })],
    ['a limit that is a number', (w) => ({ ...w.deps, limits: { ...LIMITS, maxPriceLovelace: 2_000_000 as never } })],
    ['limits that are not an object', (w) => ({ ...w.deps, limits: undefined as never })],
    ['a DID of the agent that is not a DID', (w) => ({ ...w.deps, agent: { ...w.deps.agent, did: 'prior-authorization-agent' } })],
    ['a base of the mock service that is not https', (w) => ({ ...w.deps, calls: { ...w.deps.calls, bases: { publicBase: 'http://mock.example', mtlsBase: 'https://mock-mtls.example' } } })],
    ['the two bases of the mock service on one host', (w) => ({ ...w.deps, calls: { ...w.deps.calls, bases: { publicBase: 'https://mock.example', mtlsBase: 'https://mock.example' } } })],
  ];
  for (const [name, make] of SETTINGS) {
    it(`is refused for the server with internal and the status 500, before any read and any Pay: ${name}`, async () => {
      const w = await world();
      await expect(w.run(w.request(), T0, make(w))).rejects.toMatchObject({ name: 'ExecuteRefusal', code: 'internal', status: 500 });
      expect(footprint(w)).toStrictEqual(NOTHING);
      expect(w.reads.calls).toStrictEqual({ delegation: 0, liveVaults: 0 });
    });
  }

  it('twin: limits that are null are the choice of no limit, and the job goes on', async () => {
    const w = await world();
    const deps: ExecuteDeps = { ...w.deps, limits: { maxPriceLovelace: null, maxSupplierBondLovelace: null, maxBuyerBondLovelace: null } };
    expect(words(await w.run(w.request(), T0, deps))).toBe(COMPLETED);
  });

  it('refuses a price above the limit of the hire: the advert is above the ceiling, and nothing is paid', async () => {
    const w = await world();
    const deps: ExecuteDeps = { ...w.deps, limits: { ...LIMITS, maxPriceLovelace: 1_999_999n } };
    expect(words(await w.run(w.request(), T0, deps))).toBe('failed advert_unavailable Failed');
    expect(footprint(w)).toStrictEqual(NOTHING);
    const atLimit: ExecuteDeps = { ...w.deps, limits: { ...LIMITS, maxPriceLovelace: 2_000_000n } };
    expect(words(await w.run(w.request(), T0, atLimit))).toBe(COMPLETED);
  });
});

describe('the time of the job', () => {
  it('ends 1,620,000 ms after the request arrived: a request with no time left for the first poll pays nothing', async () => {
    expect(JOB_DEADLINE_MS).toBe(1_620_000);
    const w = await world();
    const result = await w.run(w.request(), T0 - JOB_DEADLINE_MS + 1_000);
    expect(words(result)).toBe('failed deadline Failed');
    expect(footprint(w)).toStrictEqual(NOTHING);
    // The twin: the same request, arrived now, is carried out.
    expect(words(await w.run(w.request(), T0))).toBe(COMPLETED);
  });

  it('stops a job whose caller hung up before the hire starts: failed with aborted, and nothing is paid', async () => {
    const w = await world();
    const result = await w.run(w.request(), T0, w.deps, AbortSignal.abort());
    expect(words(result)).toBe('failed aborted Failed');
    expect(footprint(w)).toStrictEqual(NOTHING);
    const live = new AbortController();
    expect(words(await w.run(w.request(), T0, w.deps, live.signal))).toBe(COMPLETED);
  });

  it('reads the signal one time, and a caller that hangs up while the hire reads the ledger does not stop the Pay: the signal never goes into the hire', async () => {
    const w = await world();
    const caller = new AbortController();
    let reads = 0;
    const watched = { get aborted(): boolean { reads += 1; return caller.signal.aborted; } } as unknown as AbortSignal;
    const liveVaults = w.reads.liveVaults.bind(w.reads);
    w.reads.liveVaults = async (id, atMs) => {
      caller.abort();
      return liveVaults(id, atMs);
    };
    expect(words(await w.run(w.request(), T0, w.deps, watched))).toBe(COMPLETED);
    expect(reads).toBe(1);
    expect(caller.signal.aborted).toBe(true);
    expect(footprint(w)).toStrictEqual({ paid: 1, sends: 1, writes: 1, challenges: 0, asked: 1 });
  });

  it('does not stop a job whose caller hangs up after the Pay: a hire that was paid for is carried to its result, and the submission is written', async () => {
    const w = await world();
    const caller = new AbortController();
    const model = w.accept.answer;
    w.accept.answer = (sent, received) => {
      caller.abort();
      return model(sent, received);
    };
    expect(words(await w.run(w.request(), T0, w.deps, caller.signal))).toBe(COMPLETED);
    expect(footprint(w)).toStrictEqual({ paid: 1, sends: 1, writes: 1, challenges: 0, asked: 1 });
  });
});
