// agents/sourcing-agent/test/facts/credential.test.ts: the identity credential of an agent, as a fact for the file of a bidder. The gateway issues the credential only while the agent is Active, and the verifier
// checks it and reads the status list. The tests use the stub gateway of the identity kit and the real verifier. The question: is a source that cannot be read ever `valid`? Does a failure of the gateway or
// of the verifier give the wrong word? Each refusal has its accepted twin: the credential of an Active agent, which is `valid`.
import { describe, expect, it } from 'vitest';
import { CREDENTIAL_CALL_RULES, CREDENTIAL_RULES, KEY_SET_RULES } from '@vsa/id-kit';
import type { Check, GatewayResult, GatewayRule } from '@vsa/id-kit/client';
import { LISTS_UNAVAILABLE } from '@vsa/id-kit/testing';
import type { Fault } from '@vsa/id-kit/testing';
import { FACT_READ_TIMEOUT_MS, readCredential } from '../../src/facts/index.ts';
import type { CredentialDeps, FactState } from '../../src/facts/index.ts';
import { ManualClock, credentialOf, credentialPath, credentialWorld, failure, never, refusal, settle, tamper } from './support.ts';
import type { CredentialWorld } from './support.ts';

const DAY_MS = 86_400_000;
const UNKNOWN_DID = `did:vector:${'ab'.repeat(32)}`;
const ACCEPTED: Check<unknown, string> = { ok: true, value: {} };

/** The ports of a world with a counter on each. */
function counted(base: CredentialDeps): { readonly deps: CredentialDeps; readonly calls: { fetch: number; verify: number } } {
  const calls = { fetch: 0, verify: 0 };
  const deps: CredentialDeps = {
    clock: base.clock,
    fetchCredential: (did) => { calls.fetch += 1; return base.fetchCredential(did); },
    verify: (jwt, policy) => { calls.verify += 1; return base.verify(jwt, policy); },
  };
  return { deps, calls };
}

/** The ports of a test with no gateway: each gives what the test says, and counts its calls. */
function handmade(fetchCredential: () => Promise<GatewayResult<string>>, verify: () => Promise<Check<unknown, string>>): { readonly deps: CredentialDeps; readonly clock: ManualClock; readonly calls: { fetch: number; verify: number } } {
  const calls = { fetch: 0, verify: 0 };
  const clock = new ManualClock();
  return { deps: { clock, fetchCredential: () => { calls.fetch += 1; return fetchCredential(); }, verify: () => { calls.verify += 1; return verify(); } }, clock, calls };
}

/** The ports with a record of what the verifier said to the reader: `accepted`, or the rule of its refusal. */
function recorded(base: CredentialDeps): { readonly deps: CredentialDeps; readonly said: string[] } {
  const said: string[] = [];
  const deps: CredentialDeps = {
    ...base,
    verify: async (jwt, policy) => {
      const check = await base.verify(jwt, policy);
      said.push(check.ok ? 'accepted' : check.rule);
      return check;
    },
  };
  return { deps, said };
}

/** What the reader gives for the agent of a fresh world after `change`, and what the verifier said to it. */
async function readAfter(change: (w: CredentialWorld) => void): Promise<{ readonly word: FactState; readonly said: string[] }> {
  const w = credentialWorld();
  change(w);
  const { deps, said } = recorded(w.deps());
  return { word: await readCredential(deps, w.agent.did), said };
}

/** A fault that makes the stub gateway answer 200 with this JSON text for the key set. */
const keySetOf = (body: string): Fault => ({ status: 200, body, headers: { 'content-type': 'application/json' } });

describe('a credential that the gateway issues and the verifier accepts', () => {
  it('is valid, and the verifier is asked for the credential that the gateway gave, with the agent as the subject', async () => {
    const w = credentialWorld();
    const base = w.deps();
    const fetched: string[] = [];
    const asked: Array<{ jwt: string; policy: { subject: string } }> = [];
    const deps = w.deps({
      fetchCredential: async (did) => {
        const result = await base.fetchCredential(did);
        if (result.ok) fetched.push(result.value);
        return result;
      },
      verify: (jwt, policy) => { asked.push({ jwt, policy }); return base.verify(jwt, policy); },
    });
    expect(await readCredential(deps, w.agent.did)).toBe('valid');
    expect(fetched).toHaveLength(1);
    expect(asked).toStrictEqual([{ jwt: fetched[0], policy: { subject: w.agent.did } }]);
  });

  it('reads the status list at the gateway, and gives each of the two calls the time of the fact reads', async () => {
    const w = credentialWorld();
    expect(await readCredential(w.deps(), w.agent.did)).toBe('valid');
    const paths = w.gateway.requests.map((request) => request.path);
    expect(paths).toContain(credentialPath(w.agent));
    expect(paths).toContain('/.well-known/jwks.json');
    expect(paths.some((path) => path.startsWith('/status/bsl/'))).toBe(true);
    expect(FACT_READ_TIMEOUT_MS).toBe(20_000);
    expect(w.clock.asked).toStrictEqual([FACT_READ_TIMEOUT_MS, FACT_READ_TIMEOUT_MS]);
    expect(w.clock.open).toBe(0);
  });

  it('is valid for each of two agents, and the answer for one does not depend on the other', async () => {
    const w = credentialWorld();
    const second = w.gateway.createAgent({ label: 'second' });
    expect(await readCredential(w.deps(), w.agent.did)).toBe('valid');
    expect(await readCredential(w.deps(), second.did)).toBe('valid');
  });
});

describe('no credential: the gateway issues none', () => {
  it('is absent for an agent that the gateway does not know (404), and valid for an agent that it knows', async () => {
    const w = credentialWorld();
    expect(await readCredential(w.deps(), w.agent.did)).toBe('valid');
    expect(await readCredential(w.deps(), UNKNOWN_DID)).toBe('absent');
  });

  it('is absent for an agent that is suspended (409), and valid again when the agent is Active again', async () => {
    const w = credentialWorld();
    w.gateway.setStatus(w.agent, 'suspended', 'hold');
    expect(await readCredential(w.deps(), w.agent.did)).toBe('absent');
    w.gateway.setStatus(w.agent, 'active');
    expect(await readCredential(w.deps(), w.agent.did)).toBe('valid');
  });

  it.each(['revoked', 'retired'] as const)('is absent for an agent that is %s (410), and valid for an agent that is Active', async (status) => {
    const w = credentialWorld();
    const active = w.gateway.createAgent({ label: 'active' });
    w.gateway.setStatus(w.agent, status);
    expect(await readCredential(w.deps(), w.agent.did)).toBe('absent');
    expect(await readCredential(w.deps(), active.did)).toBe('valid');
  });

  // The status of the failure of the gateway decides. The gateway answers 404, 409 or 410 when it issues no credential, and every other failure says that the gateway did not answer.
  const FAILURES: Array<[status: number, rule: GatewayRule, word: FactState]> = [
    [404, 'gateway.refused', 'absent'],
    [409, 'gateway.refused', 'absent'],
    [410, 'gateway.refused', 'absent'],
    [400, 'gateway.refused', 'unreadable'],
    [401, 'gateway.refused', 'unreadable'],
    [403, 'gateway.refused', 'unreadable'],
    [429, 'gateway.unavailable', 'unreadable'],
    [500, 'gateway.unavailable', 'unreadable'],
    [502, 'gateway.unavailable', 'unreadable'],
    [503, 'gateway.unavailable', 'unreadable'],
    [0, 'gateway.unreachable', 'unreadable'],
    [200, 'gateway.bad_response', 'unreadable'],
  ];

  it.each(FAILURES)('is the word of the failure with the status %s and the rule %s: %s, and the verifier is not asked', async (status, rule, word) => {
    const w = credentialWorld();
    expect(await readCredential(w.deps(), w.agent.did)).toBe('valid');
    const { deps, calls } = counted(w.deps({ fetchCredential: () => Promise.resolve(failure(status, rule)) }));
    expect(await readCredential(deps, w.agent.did)).toBe(word);
    expect(calls).toStrictEqual({ fetch: 1, verify: 0 });
  });
});

describe('a source that cannot be read is unreadable and never valid', () => {
  it('is unreadable while the gateway builds its status lists (503 on the credential), and valid when it has built them', async () => {
    const w = credentialWorld();
    w.gateway.fault(credentialPath(w.agent), LISTS_UNAVAILABLE);
    expect(await readCredential(w.deps(), w.agent.did)).toBe('unreadable');
    w.gateway.fault(credentialPath(w.agent), null);
    expect(await readCredential(w.deps(), w.agent.did)).toBe('valid');
  });

  it('is unreadable when the network fails, and valid when it works', async () => {
    const w = credentialWorld();
    w.gateway.fault(credentialPath(w.agent), 'network');
    expect(await readCredential(w.deps(), w.agent.did)).toBe('unreadable');
    w.gateway.fault(credentialPath(w.agent), null);
    expect(await readCredential(w.deps(), w.agent.did)).toBe('valid');
  });

  it('is unreadable when the status list cannot be read or cannot be used, because the verifier cannot check the credential against the list', async () => {
    const list = (fault: Fault) => (w: CredentialWorld): void => w.gateway.fault('/status/bsl/0', fault);
    expect(await readAfter(() => undefined)).toStrictEqual({ word: 'valid', said: ['accepted'] });
    expect(await readAfter(list(LISTS_UNAVAILABLE))).toStrictEqual({ word: 'unreadable', said: ['credential.status_unknown'] });
    expect(await readAfter(list('network'))).toStrictEqual({ word: 'unreadable', said: ['credential.status_unknown'] });
    // The list is read and it is no list of the gateway. The verifier says credential.status_list. That is a failure of the source, and no verdict on the credential.
    expect(await readAfter(list({ status: 200, body: 'this is no status list', headers: { 'content-type': 'application/vc+jwt' } }))).toStrictEqual({ word: 'unreadable', said: ['credential.status_list'] });
  });

  it('is unreadable when the key set of the gateway cannot be read or cannot be used, and valid when it can', async () => {
    const keys = (fault: Fault) => (w: CredentialWorld): void => w.gateway.fault('/.well-known/jwks.json', fault);
    expect(await readAfter(() => undefined)).toStrictEqual({ word: 'valid', said: ['accepted'] });
    expect(await readAfter(keys(LISTS_UNAVAILABLE))).toStrictEqual({ word: 'unreadable', said: ['keys.unavailable'] });
    expect(await readAfter(keys('network'))).toStrictEqual({ word: 'unreadable', said: ['keys.unavailable'] });
    expect(await readAfter(keys(keySetOf('{"keys":"none"}')))).toStrictEqual({ word: 'unreadable', said: ['jwks.malformed'] });
    expect(await readAfter(keys(keySetOf('{"keys":[]}')))).toStrictEqual({ word: 'unreadable', said: ['jwks.no_usable_key'] });
  });

  // Each rule that the verifier gives for a credential has a word. A rule that says that a source was not read, or was read and cannot be used, is unreadable. A rule of the credential itself is invalid.
  const UNREADABLE_RULES = ['credential.status_unknown', 'credential.status_list', 'keys.unavailable', ...KEY_SET_RULES];
  const INVALID_RULES = [...CREDENTIAL_RULES, ...CREDENTIAL_CALL_RULES].filter((rule) => !UNREADABLE_RULES.includes(rule));

  it.each(UNREADABLE_RULES)('is unreadable for the refusal %s, and valid for a credential that the verifier accepts', async (rule) => {
    const credential = (): Promise<GatewayResult<string>> => Promise.resolve(credentialOf('a.b.c'));
    expect(await readCredential(handmade(credential, () => Promise.resolve(ACCEPTED)).deps, UNKNOWN_DID)).toBe('valid');
    expect(await readCredential(handmade(credential, () => Promise.resolve(refusal(rule))).deps, UNKNOWN_DID)).toBe('unreadable');
  });

  it.each(INVALID_RULES)('is invalid for the refusal %s, and valid for a credential that the verifier accepts', async (rule) => {
    const credential = (): Promise<GatewayResult<string>> => Promise.resolve(credentialOf('a.b.c'));
    expect(await readCredential(handmade(credential, () => Promise.resolve(ACCEPTED)).deps, UNKNOWN_DID)).toBe('valid');
    expect(await readCredential(handmade(credential, () => Promise.resolve(refusal(rule))).deps, UNKNOWN_DID)).toBe('invalid');
  });

  it('rests on the form of the rules of the verifier: each rule of a credential starts with credential. and each rule of a key set starts with jwks.', () => {
    expect([...CREDENTIAL_RULES, ...CREDENTIAL_CALL_RULES].every((rule) => rule.startsWith('credential.'))).toBe(true);
    expect(KEY_SET_RULES.every((rule) => rule.startsWith('jwks.'))).toBe(true);
    expect(CREDENTIAL_CALL_RULES).toContain('credential.status_unknown');
    expect(CREDENTIAL_CALL_RULES).toContain('credential.status_list');
  });

  const ODD_ANSWERS: Array<[what: string, answer: () => Promise<Check<unknown, string>>]> = [
    ['a refusal with a rule that no rule of the verifier names', () => Promise.resolve(refusal('status.list'))],
    ['a refusal with an empty rule', () => Promise.resolve(refusal(''))],
    ['a refusal with a rule that is no text', () => Promise.resolve({ ok: false, rule: 7, detail: 'words' } as unknown as Check<unknown, string>)],
    ['an answer that has no ok member', () => Promise.resolve({ value: {} } as unknown as Check<unknown, string>)],
    ['an answer with ok as a text', () => Promise.resolve({ ok: 'true', value: {} } as unknown as Check<unknown, string>)],
    ['an answer that is nothing', () => Promise.resolve(undefined as unknown as Check<unknown, string>)],
    ['an answer that is null', () => Promise.resolve(null as unknown as Check<unknown, string>)],
    ['an answer that is a text', () => Promise.resolve('valid' as unknown as Check<unknown, string>)],
  ];

  it.each(ODD_ANSWERS)('is unreadable for %s', async (_what, answer) => {
    const credential = (): Promise<GatewayResult<string>> => Promise.resolve(credentialOf('a.b.c'));
    expect(await readCredential(handmade(credential, () => Promise.resolve(ACCEPTED)).deps, UNKNOWN_DID)).toBe('valid');
    expect(await readCredential(handmade(credential, answer).deps, UNKNOWN_DID)).toBe('unreadable');
  });

  const ODD_CREDENTIALS: Array<[what: string, answer: () => Promise<GatewayResult<string>>]> = [
    ['a credential that is no text', () => Promise.resolve({ ok: true, value: 5 } as unknown as GatewayResult<string>)],
    ['a credential that is an empty text', () => Promise.resolve(credentialOf(''))],
    ['an answer of the gateway that is nothing', () => Promise.resolve(undefined as unknown as GatewayResult<string>)],
    ['an answer of the gateway that has no ok member', () => Promise.resolve({ value: 'a.b.c' } as unknown as GatewayResult<string>)],
    ['a failure with no status', () => Promise.resolve({ ok: false, rule: 'gateway.refused', detail: 'words' } as unknown as GatewayResult<string>)],
    ['a failure with a status that is a text', () => Promise.resolve({ ...failure(404), status: '404' } as unknown as GatewayResult<string>)],
  ];

  it.each(ODD_CREDENTIALS)('is unreadable for %s, and the verifier is not asked', async (_what, answer) => {
    const { deps, calls } = handmade(answer, () => Promise.resolve(ACCEPTED));
    expect(await readCredential(deps, UNKNOWN_DID)).toBe('unreadable');
    expect(calls.verify).toBe(0);
  });

  const THROWS: Array<[what: string, port: 'fetch' | 'verify', fail: () => Promise<never>]> = [
    ['a gateway client that throws', 'fetch', () => Promise.reject(new Error('the gateway is down: secret words of the source'))],
    ['a gateway client that throws a text', 'fetch', () => Promise.reject('secret words of the source')],
    ['a gateway client that throws before it returns a promise', 'fetch', () => { throw new Error('the client is broken: secret words of the source'); }],
    ['a verifier that throws', 'verify', () => Promise.reject(new Error('the verifier is broken: secret words of the source'))],
    ['a verifier that throws a text', 'verify', () => Promise.reject('secret words of the source')],
    ['a verifier that throws before it returns a promise', 'verify', () => { throw new Error('the verifier is broken: secret words of the source'); }],
  ];

  it.each(THROWS)('is unreadable for %s, and it is never retried', async (_what, port, fail) => {
    const good = (): Promise<GatewayResult<string>> => Promise.resolve(credentialOf('a.b.c'));
    const ports = port === 'fetch' ? handmade(fail, () => Promise.resolve(ACCEPTED)) : handmade(good, fail);
    expect(await readCredential(ports.deps, UNKNOWN_DID)).toBe('unreadable');
    expect(ports.calls).toStrictEqual(port === 'fetch' ? { fetch: 1, verify: 0 } : { fetch: 1, verify: 1 });
    expect(ports.clock.open).toBe(0);
  });

  it('is unreadable when the clock ends the wait before the gateway answers, and the verifier is not asked', async () => {
    const ports = handmade(() => never(), () => Promise.resolve(ACCEPTED));
    const result = readCredential(ports.deps, UNKNOWN_DID);
    await settle();
    expect(ports.clock.open).toBe(1);
    ports.clock.fire();
    expect(await result).toBe('unreadable');
    expect(ports.calls).toStrictEqual({ fetch: 1, verify: 0 });
    expect(ports.clock.asked).toStrictEqual([FACT_READ_TIMEOUT_MS]);
  });

  it('is unreadable when the clock ends the wait before the verifier answers', async () => {
    const ports = handmade(() => Promise.resolve(credentialOf('a.b.c')), () => never());
    const result = readCredential(ports.deps, UNKNOWN_DID);
    await settle();
    expect(ports.clock.open).toBe(1);
    ports.clock.fire();
    expect(await result).toBe('unreadable');
    expect(ports.calls).toStrictEqual({ fetch: 1, verify: 1 });
    expect(ports.clock.asked).toStrictEqual([FACT_READ_TIMEOUT_MS, FACT_READ_TIMEOUT_MS]);
  });

  it('drops the answer of a port that comes after the timeout: the call that timed out is still unreadable, and nothing is raised later', async () => {
    let answer: (value: Check<unknown, string>) => void = () => undefined;
    let fail: (reason: Error) => void = () => undefined;
    const late = handmade(() => Promise.resolve(credentialOf('a.b.c')), () => new Promise<Check<unknown, string>>((resolve) => { answer = resolve; }));
    const first = readCredential(late.deps, UNKNOWN_DID);
    await settle();
    late.clock.fire();
    expect(await first).toBe('unreadable');
    answer(ACCEPTED);
    const broken = handmade(() => new Promise<GatewayResult<string>>((_resolve, reject) => { fail = reject; }), () => Promise.resolve(ACCEPTED));
    const second = readCredential(broken.deps, UNKNOWN_DID);
    await settle();
    broken.clock.fire();
    expect(await second).toBe('unreadable');
    fail(new Error('late failure'));
    await settle();
  });
});

/** The credential that the gateway issues to the agent now, as ports that give that credential again later. The verifier has read no status list yet. */
async function heldBy(w: CredentialWorld): Promise<CredentialDeps> {
  const issued = await w.deps().fetchCredential(w.agent.did);
  if (!issued.ok) throw new Error('the stub gateway gave no credential');
  return w.deps({ fetchCredential: () => Promise.resolve(credentialOf(issued.value)) });
}

describe('a credential that is not valid', () => {
  it('is invalid when one byte of the payload is changed, and valid when it is not', async () => {
    const w = credentialWorld();
    const base = w.deps();
    expect(await readCredential(base, w.agent.did)).toBe('valid');
    const { deps, said } = recorded(w.deps({
      fetchCredential: async (did) => {
        const result = await base.fetchCredential(did);
        return result.ok ? credentialOf(tamper(result.value)) : result;
      },
    }));
    expect(await readCredential(deps, w.agent.did)).toBe('invalid');
    expect(said).toStrictEqual(['credential.signature']);
  });

  it('is invalid when the gateway gives the credential of another agent, and valid for the agent that it names', async () => {
    const w = credentialWorld();
    const other = w.gateway.createAgent({ label: 'other' });
    const base = w.deps();
    const { deps, said } = recorded(w.deps({ fetchCredential: () => base.fetchCredential(other.did) }));
    expect(await readCredential(base, w.agent.did)).toBe('valid');
    expect(await readCredential(deps, w.agent.did)).toBe('invalid');
    expect(said).toStrictEqual(['credential.subject']);
    expect(await readCredential(deps, other.did)).toBe('valid');
    expect(said).toStrictEqual(['credential.subject', 'accepted']);
  });

  it('is invalid when the credential is over, and valid before that', async () => {
    const w = credentialWorld();
    const { deps, said } = recorded(await heldBy(w));
    expect(await readCredential(deps, w.agent.did)).toBe('valid');
    w.gateway.advance(2 * DAY_MS);
    expect(await readCredential(deps, w.agent.did)).toBe('invalid');
    expect(said).toStrictEqual(['accepted', 'credential.expired']);
  });

  it.each([['revoked', 'credential.revoked'], ['suspended', 'credential.suspended']] as const)('is invalid when the status list says %s after the credential was issued, and valid when it does not', async (status, rule) => {
    const twin = credentialWorld();
    expect(await readCredential(await heldBy(twin), twin.agent.did)).toBe('valid');
    const w = credentialWorld();
    const { deps, said } = recorded(await heldBy(w));
    w.gateway.setStatus(w.agent, status);
    expect(await readCredential(deps, w.agent.did)).toBe('invalid');
    expect(said).toStrictEqual([rule]);
  });
});
