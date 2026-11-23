// agents/reorder-agent/test/propose/stock.test.ts: the read of the stock under the sub-delegation. The review question: is a refused or failed call ever read as a success? A token that the gateway refuses, a call
// that the ERP refuses or fails, a body that is not a stock reading, a reading of another SKU, and a job that runs out of time are each a failed proposal with a code, and each ends the sub-delegation and removes its
// entry. The model is never asked, and no number of a purchase order is taken. Each failure has an accepted twin.
import type { GatewayRefused } from '@vsa/id-kit/client';
import { describe, expect, it } from 'vitest';
import { PROPOSE_FAILURES } from '../../src/propose/index.ts';
import { SKU, STOCK, TENANT, expectFailed, expectRecordedAndEnded, gatewayDown, gatewayRefused, issued, json, parseStock, proposed, tooYoung, world } from './support.ts';
import type { World } from './support.ts';

/**
 * Runs the job and checks the result of a failure that comes after the Delegate was sent: the reason, the sub-delegation ended with its entry removed, no question to the model, no number taken, and nothing of
 * the words of a system or of a token in the result. `listed` is true for a code that this folder gives itself.
 */
async function expectStockFailure(w: World, reason: string, listed = true): Promise<void> {
  const result = await w.run();
  expectFailed(result, reason);
  if (listed) expect(PROPOSE_FAILURES).toContain(reason);
  await expectRecordedAndEnded(w);
  expect(w.reorderCalls).toStrictEqual([]);
  expect(await w.counter.next(TENANT)).toBe(1);
  expect(JSON.stringify(result)).not.toMatch(/words that|aaaaaaaaaaaa|DPoP|the ERP/);
}

describe('the token of the subagent', () => {
  const FAILURES: [string, () => GatewayRefused, string][] = [
    ['the gateway refuses', () => gatewayRefused(403, 'access_denied', 'words that the gateway wrote'), 'token_gateway_refused'],
    ['the gateway is not available', () => gatewayDown('gateway.unavailable', 503), 'token_gateway_unavailable'],
    ['the gateway cannot be reached', () => gatewayDown('gateway.unreachable', 0), 'token_gateway_unreachable'],
    ['the gateway gives an answer that is not a token answer', () => gatewayDown('gateway.bad_response', 200), 'token_gateway_bad_response'],
  ];
  it.each(FAILURES)('fails when %s, asks only once, and calls nothing', async (_name, answer, reason) => {
    const w = world();
    w.script.requestToken = async () => answer();
    await expectStockFailure(w, reason);
    expect(w.tokenRequests).toHaveLength(1);
    expect(w.fetched).toStrictEqual([]);
  });

  it('does not use a token that grants more than the one route that was asked for', async () => {
    const w = world();
    w.script.requestToken = async (request) => {
      const answer = issued(request, w.clock.now());
      return answer.ok ? { ok: true, value: { ...answer.value, authorizationDetails: [] } } : answer;
    };
    await expectStockFailure(w, 'token_gateway_bad_response');
    expect(w.fetched).toStrictEqual([]);
  });

  it('asks again while the gateway says that the delegation is too young, for two minutes, and then fails with that code', async () => {
    const w = world();
    w.script.requestToken = async () => tooYoung();
    await expectStockFailure(w, 'token_delegation_too_young');
    expect(w.tokenTimes.at(-1)! - w.tokenTimes[0]!).toBe(120_000);
    expect(w.tokenTimes.length).toBeGreaterThan(20);
    expect(w.fetched).toStrictEqual([]);
  });

  it('goes on when the gateway sees the 30 confirmations a little later: the twin', async () => {
    const w = world();
    w.script.requestToken = async (request, attempt) => (attempt < 3 ? tooYoung() : issued(request, w.clock.now()));
    proposed(await w.run());
    expect(w.tokenRequests).toHaveLength(3);
    expect(w.tokenTimes[1]! - w.tokenTimes[0]!).toBe(5_000);
    expect(w.fetched).toHaveLength(1);
  });
});

describe('the call to the ERP', () => {
  const REFUSED: [string, () => Response, string][] = [
    ['a 403 with a code', () => json({ error: 'not_covered', message: 'words that the system wrote' }, 403), 'not_covered'],
    ['a 401 with a code', () => json({ error: 'token_invalid', message: 'words that the system wrote' }, 401), 'token_invalid'],
    ['a 403 with no code', () => json({ message: 'words that the system wrote' }, 403), 'refusal_without_code'],
    ['a 403 with a body that says ok', () => json({ ok: true, error: 'not_covered', sku: SKU }, 403), 'not_covered'],
    ['a 403 whose body is a complete stock reading', () => json(STOCK, 403), 'refusal_without_code'],
  ];
  it.each(REFUSED)('is a failed proposal with the code of the system for %s, and never a stock', async (_name, answer, reason) => {
    const w = world();
    w.script.fetch = async () => answer();
    await expectStockFailure(w, reason, false);
    expect(w.fetched).toHaveLength(1);
  });

  const FAILED: [string, () => Response, string][] = [
    ['a 404 with a code', () => json({ error: 'sku_not_found', message: 'words that the system wrote' }, 404), 'sku_not_found'],
    ['a 500 with no code', () => json({}, 500), 'mock_system_failed'],
    ['a 500 with a body that is not JSON', () => new Response('words that the system wrote', { status: 500 }), 'mock_system_failed'],
    ['a 200 with a body that is not JSON', () => new Response('<p>words that the system wrote</p>', { status: 200 }), 'mock_system_failed'],
    ['a redirect', () => new Response(null, { status: 302, headers: { location: 'https://elsewhere.example/' } }), 'mock_system_failed'],
    ['a 500 whose body is a complete stock reading', () => json(STOCK, 500), 'mock_system_failed'],
  ];
  it.each(FAILED)('is a failed proposal for %s, with one call and no second try', async (_name, answer, reason) => {
    const w = world();
    w.script.fetch = async () => answer();
    await expectStockFailure(w, reason, reason === 'mock_system_failed');
    expect(w.fetched).toHaveLength(1);
  });

  it('is a failed proposal when the request gets no answer, with one call', async () => {
    const w = world();
    w.script.fetch = async () => {
      throw new TypeError('words that the network wrote');
    };
    await expectStockFailure(w, 'mock_system_failed');
    expect(w.fetched).toHaveLength(1);
  });

  it('reads the stock when the system answers 200 with the reading: the twin', async () => {
    const w = world();
    w.script.fetch = async () => json(STOCK, 200);
    proposed(await w.run());
    expect(w.fetched).toHaveLength(1);
  });
});

describe('the stock reading', () => {
  it('is a failed proposal when the body is not a stock reading, and the parser gets the body as the ERP gave it', async () => {
    const w = world();
    let seen: unknown = null;
    w.script.fetch = async () => json({ sku: SKU, on_hand: 'many' });
    w.script.parseStock = (body) => {
      seen = body;
      return parseStock(body);
    };
    await expectStockFailure(w, 'stock_reading_invalid');
    expect(seen).toStrictEqual({ sku: SKU, on_hand: 'many' });
  });

  it('is an internal failure when the parser throws, and the sub-delegation is ended', async () => {
    const w = world();
    w.script.parseStock = () => {
      throw new Error('words that the parser wrote');
    };
    await expectStockFailure(w, 'internal');
  });

  it.each([
    ['of another SKU', { ...STOCK, sku: 'SYR-10ML' }],
    ['of the SKU in lower case', { ...STOCK, sku: SKU.toLowerCase() }],
  ])('is a failed proposal with stock_reading_mismatch when it is a reading %s, and the model is never asked', async (_name, reading) => {
    const w = world();
    w.script.fetch = async () => json(reading);
    await expectStockFailure(w, 'stock_reading_mismatch');
  });

  it('is the reading of the SKU of the request: the twin of the mismatch', async () => {
    const w = world();
    const result = proposed(await w.run());
    expect(result.document.sku).toBe(SKU);
    expect(w.reorderCalls).toHaveLength(1);
  });
});

describe('the time of the job', () => {
  it('is a failed proposal with stock_read_timeout when the gateway gives no answer for the 240 seconds of the job, and the sub-delegation is ended', async () => {
    const w = world();
    w.script.requestToken = () => new Promise(() => undefined);
    await expectStockFailure(w, 'stock_read_timeout');
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
    await expectStockFailure(w, 'stock_read_timeout');
    late.answer();
    await w.clock.advance(1_000);
    expect(w.fetched).toStrictEqual([]);
  });
});
