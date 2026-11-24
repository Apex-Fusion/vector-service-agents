// agents/prior-authorization-agent/test/evidence/read.test.ts: one read through one subagent, for each read of the evidence (the order with its record set, then the guideline of its service). The review
// questions: can the agent read a record or a guideline with its own token, and is a refused or failed call ever read as a success? Every call of a read has the token of its subagent, under its own
// sub-delegation, for the one action and the one resource of its route. A token that the gateway refuses, a call that the system refuses or fails, a body that its parser refuses, a job that runs out of
// time, a job that throws, and a caller that hangs up are each a failed read with a code, and each ends the sub-delegation and removes its entry. Each failure has an accepted twin.
import { resolveKey } from '@vsa/id-kit/client';
import type { GatewayRefused, KeyInput } from '@vsa/id-kit/client';
import { agentIdOf } from '@vsa/usecase-kit/protocol';
import { describe, expect, it } from 'vitest';
import { EVIDENCE_FAILURES } from '../../src/evidence/subread.ts';
import {
  AGENT_KEY, LEAST_MS, NOW, PARENT_ID, READS, expectFailed, expectNoSecrets, expectRecordedAndEnded, expectUntouched, failureLine, gatewayDown, gatewayRefused, hex, issued, json, markSigner, parentDatum, tooYoung,
  world,
} from './support.ts';
import type { ReadCase, RunOptions, World } from './support.ts';

const keyHashOf = (key: KeyInput): string => resolveKey(key, 'a key').keyHash;

/**
 * The read ended with this code after the Delegate was sent: the sub-delegation is ended with its entry removed, the log has the one line of the failure, and the result and the log show no key, no token and
 * no part of a record. `listed` is true for a code that the table of the folder lists.
 */
async function expectReadFailure(w: World, read: ReadCase, result: unknown, code: string, listed = true): Promise<void> {
  expectFailed(result, code);
  if (listed) expect(EVIDENCE_FAILURES).toContain(code);
  await expectRecordedAndEnded(w);
  expect(w.logs).toStrictEqual([failureLine(read, code)]);
  expectNoSecrets(w, result);
}

describe.each(READS)('the $name read', (read) => {
  const agent = (w: World) => w.agents[read.name];

  describe('a read that works', () => {
    it('gives the checked copy of the body from one call, ends its sub-delegation, and writes nothing to the log', async () => {
      const w = world();
      expect(await read.run(w)).toStrictEqual({ ok: true, value: read.expected });
      expect(w.fetched).toStrictEqual([{ url: read.url, method: 'GET', authorization: expect.stringMatching(/^DPoP /), dpop: expect.any(String) }]);
      await expectRecordedAndEnded(w);
      expect(w.logs).toStrictEqual([]);
    });

    it('asks the gateway once, for the one action and the one resource of the route, under its own sub-delegation, as its subagent and never as the agent', async () => {
      const w = world();
      await read.run(w);
      expect(w.tokenRequests).toHaveLength(1);
      const asked = w.tokenRequests[0]!;
      expect(asked.delegation).toStrictEqual({ identifier: w.chain.subId, actions: [read.action], locations: [read.resource] });
      expect(asked.resource).toBe(read.resource);
      expect(asked.delegation!.identifier).not.toBe(PARENT_ID);
      expect(asked.subject.did).toBe(agent(w).did);
      expect(keyHashOf(asked.subject.key)).toBe(agent(w).keys.authentication.keyHash);
      expect(keyHashOf(asked.dpopKey)).toBe(agent(w).keys.delegation.keyHash);
    });

    it('makes a sub-delegation of the one action on the one resource, with no further hop and no value, one hop below the delegation of the hirer, for its subagent, and ends it with the key of the agent', async () => {
      const w = world();
      await read.run(w);
      expect(w.chain.params).toHaveLength(1);
      expect(w.chain.params[0]).toMatchObject({
        parent: PARENT_ID, delegate: agentIdOf(agent(w).did), delegateKey: agent(w).signer.keyHash, actions: [read.action], resources: [read.resource], remaining: 0, value: { perTx: 0n, total: 0n },
      });
      expect(w.chain.builtDelegates[0]!.delegation).toMatchObject({ parent: PARENT_ID, remaining: 0, actions: [hex(read.action)], resources: [hex(read.resource)], value: { perTx: 0n, total: 0n } });
      const [delegate, undelegate] = w.chain.submitted;
      expect(delegate!.cbor.split('+').slice(1)).toStrictEqual([AGENT_KEY.slice(0, 4), agent(w).signer.keyHash.slice(0, 4)]);
      expect(undelegate!.cbor.split('+').slice(1)).toStrictEqual([AGENT_KEY.slice(0, 4)]);
    });
  });

  describe('the token', () => {
    const FAILURES: [string, () => GatewayRefused, string][] = [
      ['the gateway refuses', () => gatewayRefused(403, 'access_denied', 'words that the gateway wrote'), 'token_gateway_refused'],
      ['the gateway is not available', () => gatewayDown('gateway.unavailable', 503), 'token_gateway_unavailable'],
      ['the gateway cannot be reached', () => gatewayDown('gateway.unreachable', 0), 'token_gateway_unreachable'],
      ['the gateway gives an answer that is not a token answer', () => gatewayDown('gateway.bad_response', 200), 'token_gateway_bad_response'],
    ];
    it.each(FAILURES)('fails when %s, asks only once, and calls nothing', async (_name, answer, code) => {
      const w = world();
      w.script.requestToken = async () => answer();
      await expectReadFailure(w, read, await read.run(w), code);
      expect(w.tokenRequests).toHaveLength(1);
      expect(w.fetched).toStrictEqual([]);
    });

    it('fails with token_bad_request when the client of the gateway refuses its arguments, and calls nothing', async () => {
      const w = world();
      w.script.requestToken = async () => {
        throw new TypeError('words that the client wrote');
      };
      await expectReadFailure(w, read, await read.run(w), 'token_bad_request');
      expect(w.tokenRequests).toHaveLength(1);
      expect(w.fetched).toStrictEqual([]);
    });

    it('does not use a token that grants more than the one route that was asked for', async () => {
      const w = world();
      w.script.requestToken = async (request) => {
        const answer = issued(request, w.clock.now());
        return answer.ok ? { ok: true, value: { ...answer.value, authorizationDetails: [] } } : answer;
      };
      await expectReadFailure(w, read, await read.run(w), 'token_gateway_bad_response');
      expect(w.fetched).toStrictEqual([]);
    });

    it('asks again while the gateway says that the delegation is too young, for two minutes, and then fails with that code', async () => {
      const w = world();
      w.script.requestToken = async () => tooYoung();
      await expectReadFailure(w, read, await read.run(w), 'token_delegation_too_young');
      expect(w.tokenTimes.at(-1)! - w.tokenTimes[0]!).toBe(120_000);
      expect(w.tokenTimes.length).toBeGreaterThan(20);
      expect(w.fetched).toStrictEqual([]);
    });

    it('goes on when the gateway sees the 30 confirmations a little later: the twin', async () => {
      const w = world();
      w.script.requestToken = async (request, attempt) => (attempt < 3 ? tooYoung() : issued(request, w.clock.now()));
      expect(await read.run(w)).toStrictEqual({ ok: true, value: read.expected });
      expect(w.tokenRequests).toHaveLength(3);
      expect(w.tokenTimes[1]! - w.tokenTimes[0]!).toBe(5_000);
      expect(w.fetched).toHaveLength(1);
    });
  });

  describe('the call', () => {
    const REFUSED: [string, () => Response, string][] = [
      ['a 403 with a code', () => json({ error: 'not_covered', message: 'words that the system wrote' }, 403), 'not_covered'],
      ['a 401 with a code', () => json({ error: 'token_invalid', message: 'words that the system wrote' }, 401), 'token_invalid'],
      ['a 403 with no code', () => json({ message: 'words that the system wrote' }, 403), 'refusal_without_code'],
      ['a 403 with a body that says ok', () => json({ ok: true, error: 'not_covered', body: read.body }, 403), 'not_covered'],
      ['a 403 whose body is the golden body', () => json(read.body, 403), 'refusal_without_code'],
    ];
    it.each(REFUSED)('is a failed read with the code of the system for %s, and never a value', async (_name, answer, code) => {
      const w = world();
      w.script.fetch = async () => answer();
      await expectReadFailure(w, read, await read.run(w), code, false);
      expect(w.fetched).toHaveLength(1);
    });

    const FAILED: [string, () => Response, string][] = [
      ['a 404 with the code of an id that the system does not know', () => json({ error: read.notFound, message: 'words that the system wrote' }, 404), read.notFound],
      ['a 500 with no code', () => json({}, 500), 'mock_system_failed'],
      ['a 500 with a body that is not JSON', () => new Response('words that the system wrote', { status: 500 }), 'mock_system_failed'],
      ['a 200 with a body that is not JSON', () => new Response('<p>words that the system wrote</p>', { status: 200 }), 'mock_system_failed'],
      ['a redirect', () => new Response(null, { status: 302, headers: { location: 'https://elsewhere.example/' } }), 'mock_system_failed'],
      ['a 500 whose body is the golden body', () => json(read.body, 500), 'mock_system_failed'],
    ];
    it.each(FAILED)('is a failed read for %s, with one call and no second try', async (_name, answer, code) => {
      const w = world();
      w.script.fetch = async () => answer();
      await expectReadFailure(w, read, await read.run(w), code);
      expect(w.fetched).toHaveLength(1);
    });

    it('is a failed read when the request gets no answer, with one call', async () => {
      const w = world();
      w.script.fetch = async () => {
        throw new TypeError('words that the network wrote');
      };
      await expectReadFailure(w, read, await read.run(w), 'mock_system_failed');
      expect(w.fetched).toHaveLength(1);
    });

    it('reads the body when the system answers 200 with it: the twin', async () => {
      const w = world();
      w.script.fetch = async () => json(read.body, 200);
      expect(await read.run(w)).toStrictEqual({ ok: true, value: read.expected });
      expect(w.fetched).toHaveLength(1);
    });
  });

  describe('the body', () => {
    it(`is a failed read with the code of its parser when the body is not what the parser takes, and the parser gets the body as the system gave it`, async () => {
      const w = world();
      let seen: unknown = null;
      const real = read.parser(w.script);
      w.script.fetch = async () => json(read.wrong);
      read.setParser(w.script, (body) => {
        seen = body;
        return real(body);
      });
      await expectReadFailure(w, read, await read.run(w), read.invalidCode);
      expect(seen).toStrictEqual(read.wrong);
    });

    it('is an internal failure when the parser throws, and the sub-delegation is ended', async () => {
      const w = world();
      read.setParser(w.script, () => {
        throw new Error('words that the parser wrote');
      });
      await expectReadFailure(w, read, await read.run(w), 'internal');
    });

    it('gives what the parser gives, and the parser gets the golden body as the system gave it: the twin', async () => {
      const w = world();
      let seen: unknown = null;
      const real = read.parser(w.script);
      read.setParser(w.script, (body) => {
        seen = body;
        return real(body);
      });
      expect(await read.run(w)).toStrictEqual({ ok: true, value: read.expected });
      expect(seen).toStrictEqual(read.body);
    });
  });

  describe('the time of the job', () => {
    it('is a failed read with its timeout code when the gateway gives no answer for the 240 seconds of the job, and the sub-delegation is ended', async () => {
      const w = world();
      w.script.requestToken = () => new Promise(() => undefined);
      await expectReadFailure(w, read, await read.run(w), read.timeoutCode);
      expect(w.clock.now() - w.tokenTimes[0]!).toBeGreaterThanOrEqual(240_000);
      expect(w.fetched).toStrictEqual([]);
    });

    it('calls nothing after the time of the job: a token that comes late is not used', async () => {
      const w = world();
      const late: { answer: () => void } = { answer: () => undefined };
      w.script.requestToken = (request) =>
        new Promise((resolve) => {
          late.answer = () => resolve(issued(request, w.clock.now()));
        });
      await expectReadFailure(w, read, await read.run(w), read.timeoutCode);
      late.answer();
      await w.clock.advance(1_000);
      expect(w.fetched).toStrictEqual([]);
    });
  });

  describe('a sub-delegation that fails', () => {
    interface Case {
      readonly name: string;
      readonly setup: (w: World) => void;
      readonly over?: (w: World) => RunOptions;
      readonly code: string;
      readonly sent: boolean;
    }
    const FAILURES: Case[] = [
      { name: 'the parent delegation is not live', setup: (w) => void (w.chain.parent = null), code: 'sub_delegation_parent_not_live', sent: false },
      { name: 'the parent delegation allows no further hop', setup: (w) => void (w.chain.parent = parentDatum({ remaining: 0 })), code: 'sub_delegation_parent_exhausted', sent: false },
      { name: 'the Delegate cannot be built', setup: (w) => void (w.chain.faults.buildDelegateThrows = true), code: 'sub_delegation_build_refused', sent: false },
      {
        name: 'the address of the wallet is not an address',
        setup: () => undefined,
        over: (w) => ({ request: { key: { signer: markSigner(AGENT_KEY), walletAddress: 'not an address', queue: w.queue } } }),
        code: 'sub_delegation_bad_request',
        sent: false,
      },
      { name: 'the 30 confirmations do not come in time', setup: (w) => void (w.chain.faults.neverConfirm = true), code: 'sub_delegation_confirmation_timeout', sent: true },
      { name: 'the chain is not usable for the subagent', setup: (w) => void (w.chain.faults.unusable = true), code: 'sub_delegation_sub_delegation_unusable', sent: true },
      {
        name: 'the node refuses the Delegate and the Delegate lands',
        setup: (w) => {
          w.chain.faults.submitDelegateThrows = true;
          w.chain.faults.delegateLandsAnyway = true;
        },
        code: 'sub_delegation_submit_failed',
        sent: true,
      },
    ];
    it.each(FAILURES)('is a failed read for a sub-delegation that fails because $name, with no job run', async ({ setup, over, code, sent }) => {
      const w = world();
      setup(w);
      const result = await read.run(w, over?.(w));
      expectFailed(result, code);
      expect(EVIDENCE_FAILURES).toContain(code);
      expect(w.tokenRequests).toStrictEqual([]);
      expect(w.fetched).toStrictEqual([]);
      expect(w.logs).toStrictEqual([failureLine(read, code)]);
      if (sent) await expectRecordedAndEnded(w);
      else {
        expect(w.chain.submitted).toStrictEqual([]);
        expect(w.steps).toStrictEqual([]);
      }
    });
  });

  describe('the time that the caller leaves', () => {
    it('is 540,000 ms at least: with less the read is deadline and sends nothing, and with exactly that it runs: the twin', async () => {
      const short = world();
      expectFailed(await read.run(short, { deadline: NOW + LEAST_MS - 1 }), 'deadline');
      expectUntouched(short);
      expect(short.logs).toStrictEqual([failureLine(read, 'deadline')]);
      const exact = world();
      expect(await read.run(exact, { deadline: NOW + LEAST_MS })).toStrictEqual({ ok: true, value: read.expected });
      await expectRecordedAndEnded(exact);
      expect(exact.clock.now()).toBeLessThanOrEqual(NOW + LEAST_MS);
    });

    it('is deadline for a deadline that is now or past, and for a deadline that is no number, and nothing is sent', async () => {
      for (const deadline of [NOW, NOW - 1, Number.NaN, Number.NEGATIVE_INFINITY]) {
        const w = world();
        expectFailed(await read.run(w, { deadline }), 'deadline');
        expectUntouched(w);
      }
      const w = world();
      expect(await read.run(w, { deadline: Number.POSITIVE_INFINITY })).toStrictEqual({ ok: true, value: read.expected });
    });

    it('trims the wait for the confirmations so that the end step is inside the deadline, and gives the full wait to a read that has the time: the twin', async () => {
      const trimmed = world();
      trimmed.chain.faults.neverConfirm = true;
      const deadline = NOW + 620_000;
      expectFailed(await read.run(trimmed, { deadline }), 'sub_delegation_confirmation_timeout');
      await expectRecordedAndEnded(trimmed);
      expect(trimmed.clock.now()).toBeGreaterThanOrEqual(NOW + 260_000);
      expect(trimmed.clock.now()).toBeLessThan(NOW + 300_000);
      expect(trimmed.clock.now()).toBeLessThanOrEqual(deadline);
      const full = world();
      full.chain.faults.neverConfirm = true;
      expectFailed(await read.run(full), 'sub_delegation_confirmation_timeout');
      await expectRecordedAndEnded(full);
      expect(full.clock.now()).toBeGreaterThanOrEqual(NOW + 360_000);
      expect(full.clock.now()).toBeLessThan(NOW + 400_000);
    });
  });

  describe('a caller that hangs up', () => {
    it('stops the read before its first step, and a signal that did not abort is the twin', async () => {
      const hungUp = world();
      const controller = new AbortController();
      controller.abort();
      expectFailed(await read.run(hungUp, { signal: controller.signal }), 'aborted');
      expectUntouched(hungUp);
      expect(hungUp.logs).toStrictEqual([failureLine(read, 'aborted')]);
      expect(await read.run(world(), { signal: new AbortController().signal })).toStrictEqual({ ok: true, value: read.expected });
    });

    it('still ends the sub-delegation when the caller hangs up during the token request, and then never calls the system', async () => {
      const w = world();
      const controller = new AbortController();
      w.script.requestToken = async (request) => {
        controller.abort();
        return issued(request, w.clock.now());
      };
      const result = await read.run(w, { signal: controller.signal });
      expect(w.tokenRequests).toHaveLength(1);
      expect(w.fetched).toStrictEqual([]);
      await expectReadFailure(w, read, result, 'aborted');
    });

    it('makes no token request when the caller hangs up during the wait for the confirmations, and ends the sub-delegation', async () => {
      const w = world();
      const controller = new AbortController();
      const readiness = w.chain.readiness.bind(w.chain);
      w.chain.readiness = async (id) => {
        controller.abort();
        return readiness(id);
      };
      const result = await read.run(w, { signal: controller.signal });
      expect(w.tokenRequests).toStrictEqual([]);
      expect(w.fetched).toStrictEqual([]);
      await expectReadFailure(w, read, result, 'aborted');
    });

    it('asks the gateway no more when the caller hangs up while the delegation is too young, and calls nothing', async () => {
      const w = world();
      const controller = new AbortController();
      w.script.requestToken = async (_request, attempt) => {
        if (attempt === 2) controller.abort();
        return tooYoung();
      };
      const result = await read.run(w, { signal: controller.signal });
      expect(w.tokenRequests).toHaveLength(2);
      expect(w.fetched).toStrictEqual([]);
      await expectReadFailure(w, read, result, 'aborted');
    });

    it('keeps the value when the caller hangs up during the call: the call was made, and the sub-delegation is ended', async () => {
      const w = world();
      const controller = new AbortController();
      w.script.fetch = async () => {
        controller.abort();
        return json(read.body);
      };
      expect(await read.run(w, { signal: controller.signal })).toStrictEqual({ ok: true, value: read.expected });
      expect(w.fetched).toHaveLength(1);
      await expectRecordedAndEnded(w);
    });
  });
});
