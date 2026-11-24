// agents/sourcing-agent/test/execute/authority.test.ts: what the job `execute` checks before it asks for the token: the settings, the authority of the delegation, and the delegation key. The DPoP key of the token is the
// delegate key of the delegation, so nothing is sent without that key. A job that stops here sends nothing. Each refusal has an accepted twin.
import { describe, expect, it } from 'vitest';
import type { Did } from '@vsa/usecase-kit/protocol';
import { ExecuteRefusal } from '../../src/execute/index.ts';
import type { ExecuteDeps } from '../../src/execute/index.ts';
import { APPROVAL, SALT } from './fixtures.ts';
import { DELEGATION, ONE_CALL, READ_ONLY, UNTOUCHED, footprint, words, world } from './world.ts';

const COMPLETED = 'completed none Completed';
const OTHER_AGENT = 'c3'.repeat(32);

describe('a delegation that names another agent', () => {
  it('is refused for the server with delegation_not_mine and the status 400: nothing is asked after it, and nothing is sent', async () => {
    const w = world();
    w.reads.delegations.set(DELEGATION, { delegate: OTHER_AGENT, chain_whole: true });
    let keysAsked = 0;
    const deps: ExecuteDeps = { ...w.deps, delegateKeyOf: async () => { keysAsked += 1; return w.delegateKey.hash; } };
    const refused = w.run(w.request(), w.arrived, deps);
    await expect(refused).rejects.toBeInstanceOf(ExecuteRefusal);
    await expect(refused).rejects.toMatchObject({ name: 'ExecuteRefusal', code: 'delegation_not_mine', status: 400 });
    expect(footprint(w)).toStrictEqual(READ_ONLY);
    expect(keysAsked).toBe(0);
  });

  it('gives a message that repeats no value of the request', async () => {
    const w = world();
    w.reads.delegations.set(DELEGATION, { delegate: OTHER_AGENT, chain_whole: true });
    const error: unknown = await w.run().then(() => null, (thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(ExecuteRefusal);
    const message = (error as ExecuteRefusal).message;
    for (const value of [DELEGATION, SALT, APPROVAL.attestation, OTHER_AGENT]) expect(message).not.toContain(value);
  });

  it('twin: a delegation that names this agent goes on', async () => {
    const w = world();
    expect(words(await w.run())).toBe(COMPLETED);
  });
});

describe('a delegation that the ledger does not show', () => {
  it('has no delegate key, so it ends with delegation_not_found: no token is asked for and nothing is sent', async () => {
    const w = world();
    w.reads.delegations.set(DELEGATION, null);
    w.delegateKey.hash = null;
    const result = await w.run();
    expect(words(result)).toBe('failed delegation_not_found Failed');
    expect(footprint(w)).toStrictEqual(READ_ONLY);
  });

  it('goes on when the check shows no delegation and the read of the key shows a key: the gateway decides, and it knows the delegation', async () => {
    const w = world();
    w.reads.delegations.set(DELEGATION, null);
    expect(words(await w.run())).toBe(COMPLETED);
    expect(footprint(w)).toStrictEqual(ONE_CALL);
  });

  it('never reads the first key: a job that stops at the delegation key and a job that is completed both leave it alone', async () => {
    const w = world();
    let reads = 0;
    const deps: ExecuteDeps = {
      ...w.deps,
      delegationKeys: { find: (hash) => w.deps.delegationKeys.find(hash), get first() { reads += 1; return w.a.entry; } },
    };
    w.delegateKey.hash = null;
    expect(words(await w.run(w.request(), w.arrived, deps))).toBe('failed delegation_not_found Failed');
    w.delegateKey.hash = w.a.testKey.keyHash;
    expect(words(await w.run(w.request(), w.arrived, deps))).toBe(COMPLETED);
    expect(reads).toBe(0);
  });
});

describe('a ledger that cannot be read', () => {
  it('is failed with ledger_unavailable when the delegation cannot be read: nothing is sent, and the error of the ledger is not in the result or the log', async () => {
    const w = world();
    w.reads.failDelegation = new Error('koios answered 502 for the key k9-secret');
    const result = await w.run();
    expect(words(result)).toBe('failed ledger_unavailable Failed');
    expect(footprint(w)).toStrictEqual(READ_ONLY);
    expect(`${JSON.stringify(result)}${w.log.join('\n')}`).not.toContain('k9-secret');
    w.reads.failDelegation = null;
    expect(words(await w.run())).toBe(COMPLETED);
  });

  it('is failed with ledger_unavailable when the delegate key cannot be read: nothing is sent, and the error of the ledger is not in the result or the log', async () => {
    const w = world();
    w.delegateKey.failure = new Error('the ledger is down for the key k9-secret');
    const result = await w.run();
    expect(words(result)).toBe('failed ledger_unavailable Failed');
    expect(footprint(w)).toStrictEqual(READ_ONLY);
    expect(`${JSON.stringify(result)}${w.log.join('\n')}`).not.toContain('k9-secret');
    w.delegateKey.failure = null;
    expect(words(await w.run())).toBe(COMPLETED);
  });

  it('is failed with ledger_unavailable when the reading of the delegation is not a reading: a ledger that gives a wrong shape is not a pass', async () => {
    const w = world();
    w.reads.delegations.set(DELEGATION, { delegate: 'not an agent id', chain_whole: true });
    expect(words(await w.run())).toBe('failed ledger_unavailable Failed');
    expect(footprint(w)).toStrictEqual(READ_ONLY);
  });
});

describe('the delegation key', () => {
  it('is failed with delegation_key_unknown when the delegation names a key that this agent does not hold: nothing is sent', async () => {
    const w = world();
    w.delegateKey.hash = '77'.repeat(28);
    expect(words(await w.run())).toBe('failed delegation_key_unknown Failed');
    expect(footprint(w)).toStrictEqual(READ_ONLY);
  });

  it('is looked up by the hash that the ledger gave, and by no other', async () => {
    const w = world({ delegate: 'b' });
    const asked: string[] = [];
    const deps: ExecuteDeps = { ...w.deps, delegationKeys: { find: (hash) => { asked.push(hash); return w.deps.delegationKeys.find(hash); }, first: w.deps.delegationKeys.first } };
    expect(words(await w.run(w.request(), w.arrived, deps))).toBe(COMPLETED);
    expect(asked).toStrictEqual([w.b.testKey.keyHash]);
  });

  it('is the DPoP key of the token: the key that the delegation names asks for it, the second key as well as the first', async () => {
    const second = world({ delegate: 'b' });
    expect(words(await second.run())).toBe(COMPLETED);
    expect(second.tokens[0]?.answer.ok).toBe(true);
    const first = world({ delegate: 'a' });
    expect(words(await first.run())).toBe(COMPLETED);
    expect(first.tokens[0]?.answer.ok).toBe(true);
  });

  it('gets no token from a key that is not the delegate key on the gateway: the gateway binds the token to the key, and the job says token_failed without a call', async () => {
    const w = world({ delegate: 'b' });
    // The ledger names the first key, and the gateway knows the second key as the delegate key.
    w.delegateKey.hash = w.a.testKey.keyHash;
    const result = await w.run();
    expect(words(result)).toBe('failed token_failed Failed');
    expect(w.tokens[0]?.answer.ok).toBe(false);
    expect(footprint(w)).toStrictEqual({ reads: 1, vaults: 0, tokens: 1, calls: 0 });
  });
});

describe('the settings of the service', () => {
  it('refuses a DID of the agent that is not a DID, for the server, with internal and the status 500: before any read', async () => {
    const w = world();
    const deps: ExecuteDeps = { ...w.deps, agent: { ...w.deps.agent, did: 'not a did' as Did } };
    const refused = w.run(w.request(), w.arrived, deps);
    await expect(refused).rejects.toBeInstanceOf(ExecuteRefusal);
    await expect(refused).rejects.toMatchObject({ name: 'ExecuteRefusal', code: 'internal', status: 500 });
    expect(footprint(w)).toStrictEqual(UNTOUCHED);
  });

  it('refuses bases that give no target, for the server, with internal and the status 500: before any read', async () => {
    const w = world();
    const deps: ExecuteDeps = { ...w.deps, calls: { ...w.deps.calls, bases: { publicBase: 'https://mock.example', mtlsBase: 'https://mock.example' } } };
    const refused = w.run(w.request(), w.arrived, deps);
    await expect(refused).rejects.toMatchObject({ name: 'ExecuteRefusal', code: 'internal', status: 500 });
    expect(footprint(w)).toStrictEqual(UNTOUCHED);
  });

  it('twin: the settings of the tests are accepted', async () => {
    const w = world();
    expect(words(await w.run())).toBe(COMPLETED);
  });
});

describe('a request that the parser of the protocol would have refused', () => {
  it('is refused for the server with bad_shape and the status 400 when its delegation is no identifier: nothing is sent', async () => {
    const w = world();
    const request = w.request();
    const forged = { ...request, authority: { ...request.authority, delegation: 'not an identifier' } };
    const refused = w.run(forged);
    await expect(refused).rejects.toBeInstanceOf(ExecuteRefusal);
    await expect(refused).rejects.toMatchObject({ name: 'ExecuteRefusal', code: 'bad_shape', status: 400 });
    expect(footprint(w)).toStrictEqual(UNTOUCHED);
  });
});

describe('ExecuteRefusal', () => {
  it('is an error with a code, a status of that code and a message', () => {
    const refusal = new ExecuteRefusal('delegation_not_mine', 'authority.delegation names another agent as its delegate');
    expect(refusal).toBeInstanceOf(Error);
    expect([refusal.name, refusal.code, refusal.status, refusal.message]).toStrictEqual(['ExecuteRefusal', 'delegation_not_mine', 400, 'authority.delegation names another agent as its delegate']);
    expect(new ExecuteRefusal('bad_shape', 'x').status).toBe(400);
    expect(new ExecuteRefusal('internal', 'x').status).toBe(500);
  });
});
