// packages/buyer-core/test/select-supplier.test.ts
// Supplier discovery over the marketplace indexer, through a fake fetch: which chat supplier to hire (selectLlmSupplier: allowlist order, then price,
// then the most recently seen; the supplier itself must serve the Responses API for the advert the indexer lists, and answer at /status) and which OCR
// advert (findOcrAdvert: the one Active advert of the allowlisted key, or none), whatever the indexer says of the supplier at the moment (ruling R60).
// The indexer is read with the vendored fetchSuppliers. The suppliers are reached through safeFetch, so their endpoints are IP literals of the
// documentation range 203.0.113.0/24: public for safeFetch, and no host lookup. The budgets of the selection are at least 500 ms wherever a test needs
// a call to start inside one, so that a slow machine does not change what a test sees.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { findOcrAdvert, selectLlmSupplier } from '../src/select-supplier.ts';
import { INDEXER_URL } from '../src/vendored/mcp/marketplace-constants.ts';
import { boom, delayed, hang, json, routedFetch, text } from './fake-fetch.ts';
import type { Answer, FakeFetch } from './fake-fetch.ts';

afterEach(() => { vi.restoreAllMocks(); });

const INDEXER = 'https://indexer.test';
const DEEPSEEK = 'deepseek/deepseek-v4-flash';
const PRO = 'deepseek-v4-pro';
const KIMI = 'moonshotai/kimi-k2.6';
const QWEN = 'Qwen/Qwen3.6-35B-A3B-FP8';
const ALLOWLIST = [DEEPSEEK, PRO, KIMI, QWEN];
const LLM = 'llm.text.generate.v1';

const hex = (n: number) => n.toString(16).padStart(2, '0');
const endpointOf = (n: number) => `https://203.0.113.${n}`;
const advertOf = (n: number) => `${hex(n).repeat(32)}#0`;
const pkhOf = (n: number) => hex(n).repeat(28);
const hostOf = (url: string) => new URL(url).hostname;

/** A row of the indexer's /suppliers list, as the live indexer writes it (amounts as strings, the advert's UTxO as `utxo_ref`). */
function row(n: number, model: string, over: Record<string, unknown> = {}) {
  return {
    utxo_ref: advertOf(n), supplier_pkh: pkhOf(n), capability_id: LLM, model, max_output_tokens: 8192, max_processing_ms: 300000,
    price_lovelace: '200000', supplier_bond_lovelace: '1000000', buyer_bond_lovelace: '1000000', endpoint_url: endpointOf(n), detail_uri: '',
    detail_hash: 'e3'.repeat(32), advertised_at: 1786529315923, status: 'free', advert_status: 'Active', current_escrow_ref: null,
    last_seen_iso: '2026-10-13T11:00:00.000Z', created_slot: 30043723, ...over,
  };
}
/** What the supplier of row `n` serves at /capability: the Responses build, with the advert the indexer lists. */
function capabilityOf(n: number, model: string, over: Record<string, unknown> = {}) {
  return {
    capability_id: LLM, model, max_output_tokens: 8192, max_processing_ms: 300000, price_lovelace: '200000', advert_ref: advertOf(n),
    supplier_pkh: pkhOf(n), pub_key_hex: hex(n).repeat(32), inference_api: 'responses', upstream_api: 'responses', reasoning_disabled: false, ...over,
  };
}
const live = (status: string) => json(200, { status, last_seen: '2026-10-15T09:00:00.000Z', active_sessions: 0, max_sessions: 1 });
const down = () => json(503, { reason: 'advert_unavailable', message: 'advert UTxO not found on chain' });

interface Node { n: number; model: string; row: Record<string, unknown>; capability: Answer; status: Answer }
/**
 * A chat supplier `n` of `model`: its indexer row and its two routes. `row` overrides fields of the row, `capability` fields of its /capability body
 * (an undefined value drops the field) or the whole answer, `live` is its status word or the whole answer of /status.
 */
function llm(n: number, model: string, o: { row?: Record<string, unknown>; capability?: Record<string, unknown> | Answer; live?: string | Answer } = {}): Node {
  const capability = o.capability === undefined ? json(200, capabilityOf(n, model))
    : typeof o.capability === 'function' || o.capability instanceof Response ? o.capability : json(200, capabilityOf(n, model, o.capability));
  const status = o.live === undefined ? live('free') : typeof o.live === 'string' ? live(o.live) : o.live;
  return { n, model, row: row(n, model, o.row), capability, status };
}
/** The fake network: the indexer listing `nodes` (after `indexerDelayMs`, when given) and the two routes of each node. */
function network(nodes: Node[], opts: { indexerDelayMs?: number } = {}): FakeFetch {
  const listing = json(200, nodes.map((x) => x.row));
  const routes: Record<string, Answer> = { [`GET ${INDEXER}/suppliers`]: opts.indexerDelayMs === undefined ? listing : delayed(opts.indexerDelayMs, listing) };
  for (const x of nodes) {
    routes[`GET ${endpointOf(x.n)}/capability`] = x.capability;
    routes[`GET ${endpointOf(x.n)}/status`] = x.status;
  }
  return routedFetch(routes);
}
/** The suppliers a fake network was asked something, in the order it was asked. */
const askedOf = (f: FakeFetch, route: string) => f.calls.filter((c) => c.url.endsWith(route)).map((c) => hostOf(c.url));

describe('selectLlmSupplier', () => {
  const select = (f: FakeFetch, over: Partial<Parameters<typeof selectLlmSupplier>[0]> = {}) =>
    selectLlmSupplier({ fetchImpl: f.fetchImpl, indexerUrl: INDEXER, allowlist: ALLOWLIST, ...over });

  it('picks deepseek/deepseek-v4-flash at 0.2 over Qwen at 0.2: the allowlist order decides between equal prices, however recently the other was seen', async () => {
    const f = network([
      llm(1, QWEN, { row: { last_seen_iso: '2026-10-13T12:00:00.000Z' } }),
      llm(2, DEEPSEEK, { row: { last_seen_iso: '2026-10-13T09:00:00.000Z' } }),
    ]);
    expect(await select(f)).toStrictEqual({
      advertRef: advertOf(2), endpoint: endpointOf(2), model: DEEPSEEK, supplierPkh: pkhOf(2), priceLovelace: 200000n,
      capability: { capability_id: LLM, model: DEEPSEEK, advert_ref: advertOf(2), supplier_pkh: pkhOf(2), pub_key_hex: hex(2).repeat(32), inference_api: 'responses', max_output_tokens: 8192 },
    });
  });

  it('the allowlist order beats the price: a model earlier on the list wins at any price', async () => {
    const pro = await select(network([llm(1, PRO, { row: { price_lovelace: '900000' } }), llm(2, QWEN, { row: { price_lovelace: '100000' } })]));
    expect(pro?.model).toBe(PRO);
    const flash = await select(network([llm(1, PRO, { row: { price_lovelace: '200000' } }), llm(2, DEEPSEEK, { row: { price_lovelace: '5000000' } })]));
    expect(flash?.model).toBe(DEEPSEEK);
  });

  // Ruling R56: the adverts are read at run time and nothing else bounds what they cost, so a ceiling takes the dearer ones out before anything else.
  it('a price ceiling takes out every advert priced above it before anything else; a cheaper advert of a later model is hired only then, and the order is otherwise the same', async () => {
    const dear = () => network([llm(1, DEEPSEEK, { row: { price_lovelace: '1500000' } }), llm(2, QWEN, { row: { price_lovelace: '200000' } })]);
    // Without a ceiling the allowlist order decides, whatever the price.
    expect((await select(dear()))?.model).toBe(DEEPSEEK);
    const f = dear();
    expect((await select(f, { maxPriceLovelace: 1_000_000n }))?.model).toBe(QWEN);
    expect(askedOf(f, '/capability')).toStrictEqual([hostOf(endpointOf(2))]); // the dearer one is never contacted
    // A price at the ceiling is in.
    const atCeiling = network([llm(1, DEEPSEEK, { row: { price_lovelace: '1000000' } }), llm(2, QWEN, { row: { price_lovelace: '200000' } })]);
    expect((await select(atCeiling, { maxPriceLovelace: 1_000_000n }))?.model).toBe(DEEPSEEK);
    // Nothing at or under the ceiling: null, and no supplier is contacted.
    const none = network([llm(1, DEEPSEEK, { row: { price_lovelace: '1000001' } })]);
    expect(await select(none, { maxPriceLovelace: 1_000_000n })).toBeNull();
    expect(none.calls.map((c) => hostOf(c.url))).toStrictEqual(['indexer.test']);
  });

  it('the adverts the ceiling takes out take no place among the six that are asked', async () => {
    const f = network([...[1, 2, 3, 4, 5, 6].map((n) => llm(n, DEEPSEEK, { row: { price_lovelace: '5000000' } })), llm(7, QWEN, { row: { price_lovelace: '200000' } })]);
    expect((await select(f, { maxPriceLovelace: 1_000_000n }))?.advertRef).toBe(advertOf(7));
    expect(askedOf(f, '/capability')).toStrictEqual([hostOf(endpointOf(7))]);
  });

  it('tries the candidates in order: allowlist index, then price ascending, then the most recently seen, a supplier never seen last', async () => {
    const seen = (hour: string) => ({ last_seen_iso: `2026-10-13T${hour}:00:00.000Z` });
    const f = network([
      llm(1, QWEN, { row: { price_lovelace: '100000', ...seen('12') }, capability: down }),
      llm(2, DEEPSEEK, { row: { price_lovelace: '300000', ...seen('10') }, capability: down }),
      llm(3, DEEPSEEK, { row: { price_lovelace: '200000', ...seen('09') }, capability: down }),
      llm(4, DEEPSEEK, { row: { price_lovelace: '200000', ...seen('11') }, capability: down }),
      llm(5, PRO, { row: { price_lovelace: '100000', ...seen('12') }, capability: down }),
      llm(6, KIMI, { row: { price_lovelace: '50000', ...seen('12') }, capability: down }),
      llm(7, DEEPSEEK, { row: { price_lovelace: '200000', last_seen_iso: null }, capability: down }),
    ]);
    // All seven are asked, so the default limit of six candidates is lifted here.
    expect(await select(f, { maxCandidates: 7 })).toBeNull();
    expect(askedOf(f, '/capability')).toStrictEqual([4, 3, 7, 2, 5, 6, 1].map((n) => hostOf(endpointOf(n))));
  });

  it('a supplier last seen at a time that is no date sorts after the ones that have a date, at an equal price: not by the text, as the indexer sorts', async () => {
    const seen = (iso: string | null) => ({ last_seen_iso: iso });
    const f = network([
      llm(1, DEEPSEEK, { row: seen('sometime last week'), capability: down }),
      llm(2, DEEPSEEK, { row: seen('2026-10-13T09:00:00.000Z'), capability: down }),
      llm(3, DEEPSEEK, { row: seen(''), capability: down }),
      llm(4, DEEPSEEK, { row: seen('2026-10-13T11:00:00.000Z'), capability: down }),
      llm(5, DEEPSEEK, { row: seen(null), capability: down }),
    ]);
    expect(await select(f)).toBeNull();
    // As text, "sometime last week" is greater than every date, so a descending sort of strings, which is how the vendored list is ordered, would put it
    // first. Here it is last, with the others that have no date.
    expect(askedOf(f, '/capability')).toStrictEqual([4, 2, 1, 3, 5].map((n) => hostOf(endpointOf(n))));
  });

  it('within one model and price, falls to the next supplier when the first cannot serve', async () => {
    const cheap = (n: number, hour: string, over: Parameters<typeof llm>[2] = {}) => llm(n, DEEPSEEK, { ...over, row: { price_lovelace: '200000', last_seen_iso: `2026-10-13T${hour}:00:00.000Z` } });
    expect((await select(network([cheap(1, '09'), cheap(2, '11'), cheap(3, '10')])))?.advertRef).toBe(advertOf(2));
    expect((await select(network([cheap(1, '09'), cheap(2, '11', { capability: down }), cheap(3, '10')])))?.advertRef).toBe(advertOf(3));
    expect((await select(network([cheap(1, '09'), cheap(2, '11', { capability: down }), cheap(3, '10', { capability: down })])))?.advertRef).toBe(advertOf(1));
  });

  it('ignores a model outside the allowlist, another capability and an advert that is not Active, and never contacts them', async () => {
    const f = network([
      llm(1, 'kimi-k3', { row: { price_lovelace: '100000' } }),
      llm(2, DEEPSEEK, { row: { capability_id: 'llm.chat.v1', price_lovelace: '100000' } }),
      llm(3, DEEPSEEK, { row: { advert_status: 'Retired', price_lovelace: '100000' } }),
      llm(5, QWEN, { row: { price_lovelace: '900000' } }),
    ]);
    expect((await select(f))?.advertRef).toBe(advertOf(5));
    expect([...new Set(f.calls.map((c) => hostOf(c.url)))].sort()).toStrictEqual(['203.0.113.5', 'indexer.test']);
  });

  // Ruling R60: the indexer's word on whether a supplier is busy is a moment's, and must not fail a job before it spends; the send loop waits for a
  // supplier that is busy. An Active advert is a candidate whatever the indexer says of its supplier, in the same order as ever.
  it('takes an Active advert whatever the indexer says of its supplier: one listed as working or offline is a candidate in its place in the order', async () => {
    const f = network([
      llm(3, DEEPSEEK, { row: { status: 'working', price_lovelace: '100000' } }),
      llm(4, DEEPSEEK, { row: { status: 'offline', price_lovelace: '150000' } }),
      llm(5, QWEN, { row: { price_lovelace: '900000' } }),
    ]);
    expect((await select(f))?.advertRef).toBe(advertOf(3));
    const second = network([llm(3, DEEPSEEK, { row: { status: 'working', price_lovelace: '100000' }, capability: down }), llm(4, DEEPSEEK, { row: { status: 'offline', price_lovelace: '150000' } })]);
    expect((await select(second))?.advertRef).toBe(advertOf(4));
    expect(askedOf(second, '/capability')).toStrictEqual([3, 4].map((n) => hostOf(endpointOf(n))));
  });

  it('skips a supplier whose /capability does not carry inference_api "responses": a build that does not serve /v1/responses cannot take the job', async () => {
    const f = network([
      llm(1, DEEPSEEK, { row: { price_lovelace: '100000' }, capability: { inference_api: undefined } }),
      llm(2, DEEPSEEK, { row: { price_lovelace: '150000' }, capability: { inference_api: 'chat-completions' } }),
      llm(3, DEEPSEEK, { row: { price_lovelace: '200000' } }),
    ]);
    expect((await select(f))?.advertRef).toBe(advertOf(3));
    expect(askedOf(f, '/capability')).toStrictEqual(['203.0.113.1', '203.0.113.2', '203.0.113.3']);
  });

  it('skips a supplier whose /capability names another advert than the indexer lists for it; the refs are compared in canonical form', async () => {
    const other = advertOf(99);
    const wrong = network([llm(1, DEEPSEEK, { row: { price_lovelace: '100000' }, capability: { advert_ref: other } }), llm(2, DEEPSEEK)]);
    expect((await select(wrong))?.advertRef).toBe(advertOf(2));
    const shouted = network([llm(1, DEEPSEEK, { capability: { advert_ref: advertOf(1).toUpperCase() } })]);
    expect((await select(shouted))?.advertRef).toBe(advertOf(1));
    const lost = network([llm(1, DEEPSEEK, { capability: { advert_ref: 'not a ref' } })]);
    expect(await select(lost)).toBeNull();
  });

  it('skips a supplier whose /capability cannot be read: an error status, a page, a network error, a body without its key', async () => {
    const unreadable: Array<[string, Record<string, unknown> | Answer]> = [
      ['an error status', down], ['a page', text(200, '<html>login</html>', 'text/html')], ['a network error', boom], ['no public key', { pub_key_hex: undefined }], ['a supplier key hash that is not a string', { supplier_pkh: 4 }],
    ];
    for (const [name, bad] of unreadable) {
      const f = network([llm(1, DEEPSEEK, { row: { price_lovelace: '100000' }, capability: bad }), llm(2, DEEPSEEK)]);
      expect((await select(f))?.advertRef, name).toBe(advertOf(2));
    }
  });

  // Ruling R60, refined: free and working keep a candidate (the send waits for one at work); offline, any other word, and a /status that cannot be read
  // pass it over for the next.
  it('with probe true a supplier whose /status says offline, or cannot be read, is passed over for the next; one that answers working or free stays a candidate (ruling R60)', async () => {
    const passedOver: Array<[string, Answer]> = [
      ['offline', live('offline')], ['a status word of nobody', live('busy')], ['an error status', down], ['a network error', boom], ['a page', text(200, '<html>status</html>', 'text/html')],
    ];
    for (const [name, status] of passedOver) {
      const f = network([llm(1, DEEPSEEK, { row: { price_lovelace: '100000' }, live: status }), llm(2, DEEPSEEK, { live: 'free' })]);
      expect((await select(f, { probe: true }))?.advertRef, name).toBe(advertOf(2));
      expect(askedOf(f, '/status'), name).toStrictEqual([1, 2].map((n) => hostOf(endpointOf(n))));
    }
    for (const word of ['working', 'free']) {
      const f = network([llm(1, DEEPSEEK, { row: { price_lovelace: '100000' }, live: word }), llm(2, DEEPSEEK, { live: 'free' })]);
      expect((await select(f, { probe: true }))?.advertRef, word).toBe(advertOf(1));
    }
    expect((await select(network([llm(1, DEEPSEEK, { live: 'working' })]), { probe: true }))?.advertRef).toBe(advertOf(1));
    expect(await select(network([llm(1, DEEPSEEK, { live: 'offline' })]), { probe: true })).toBeNull();
    expect(await select(network([llm(1, DEEPSEEK, { live: boom })]), { probe: true })).toBeNull();
  });

  it('asks /capability before /status, and /status only of a supplier whose /capability passed', async () => {
    const f = network([
      llm(1, DEEPSEEK, { row: { price_lovelace: '100000' }, capability: down }),
      llm(2, DEEPSEEK, { row: { price_lovelace: '150000' }, capability: { inference_api: undefined } }),
      llm(3, DEEPSEEK, { row: { price_lovelace: '200000' }, live: down }),
      llm(4, DEEPSEEK, { row: { price_lovelace: '250000' } }),
    ]);
    expect((await select(f, { probe: true }))?.advertRef).toBe(advertOf(4));
    expect(f.calls.slice(1).map((c) => `${hostOf(c.url)}${new URL(c.url).pathname}`)).toStrictEqual([
      '203.0.113.1/capability', '203.0.113.2/capability', '203.0.113.3/capability', '203.0.113.3/status', '203.0.113.4/capability', '203.0.113.4/status',
    ]);
  });

  it('without probe it never asks /status: what the indexer lists is enough', async () => {
    for (const over of [{}, { probe: false }]) {
      const f = network([llm(1, DEEPSEEK, { live: 'working' })]);
      expect((await select(f, over))?.advertRef).toBe(advertOf(1));
      expect(askedOf(f, '/status')).toStrictEqual([]);
    }
  });

  it('stops at the first supplier that passes: the ones after it are not contacted', async () => {
    const f = network([llm(1, DEEPSEEK, { row: { price_lovelace: '100000' } }), llm(2, DEEPSEEK, { row: { price_lovelace: '200000' } })]);
    expect((await select(f, { probe: true }))?.advertRef).toBe(advertOf(1));
    expect(f.calls.map((c) => hostOf(c.url))).toStrictEqual(['indexer.test', '203.0.113.1', '203.0.113.1']);
  });

  describe('its limits', () => {
    // Nine adverts: one of a model off the allowlist, six of one model that cannot serve (the cheapest first), and two that can.
    const crowd = () => network([
      llm(9, 'kimi-k3', { row: { price_lovelace: '1' } }),
      ...[1, 2, 3, 4, 5, 6].map((n) => llm(n, DEEPSEEK, { row: { price_lovelace: String(100_000 + n) }, capability: down })),
      llm(7, DEEPSEEK, { row: { price_lovelace: '100007' } }),
      llm(8, DEEPSEEK, { row: { price_lovelace: '100008' } }),
    ]);

    it('asks at most six suppliers by default: the seventh is not reached, however well it would serve, and a model off the allowlist is not one of the six', async () => {
      const f = crowd();
      expect(await select(f)).toBeNull();
      expect(askedOf(f, '/capability')).toStrictEqual([1, 2, 3, 4, 5, 6].map((n) => hostOf(endpointOf(n))));
    });

    it('asks as many as maxCandidates says: seven reach the seventh, two stop at the second, none asks no one, Infinity lifts the limit', async () => {
      expect((await select(crowd(), { maxCandidates: 7 }))?.advertRef).toBe(advertOf(7));
      const two = crowd();
      expect(await select(two, { maxCandidates: 2 })).toBeNull();
      expect(askedOf(two, '/capability')).toStrictEqual([1, 2].map((n) => hostOf(endpointOf(n))));
      const none = crowd();
      expect(await select(none, { maxCandidates: 0 })).toBeNull();
      expect(none.calls.map((c) => hostOf(c.url))).toStrictEqual(['indexer.test']);
      expect((await select(crowd(), { maxCandidates: Number.POSITIVE_INFINITY }))?.advertRef).toBe(advertOf(7));
    });

    it('stops when the budget runs out: a supplier that does not answer is cancelled, and the ones after it are not asked', async () => {
      const f = network([llm(1, DEEPSEEK, { row: { price_lovelace: '100000' }, capability: hang }), llm(2, DEEPSEEK, { row: { price_lovelace: '200000' } })]);
      const started = performance.now();
      expect(await select(f, { budgetMs: 500 })).toBeNull();
      // The budget ended the call, not the 20 s that /capability may take.
      expect(performance.now() - started).toBeGreaterThanOrEqual(490);
      expect(performance.now() - started).toBeLessThan(5000);
      expect(askedOf(f, '/capability')).toStrictEqual([hostOf(endpointOf(1))]);
      expect(f.calls.find((c) => c.url === `${endpointOf(1)}/capability`)?.signal?.aborted).toBe(true);
    });

    it('the budget also cancels a /status call that is in flight', async () => {
      const f = network([llm(1, DEEPSEEK, { live: hang })]);
      expect(await select(f, { probe: true, budgetMs: 500 })).toBeNull();
      expect(f.calls.find((c) => c.url === `${endpointOf(1)}/status`)?.signal?.aborted).toBe(true);
    });

    it('the limit of a call to a supplier stays in force inside the selection: one that does not answer in time is skipped, and the next is asked', async () => {
      // A /capability call may take 20 s. The limit is shortened to 30 ms so that the test does not wait for it.
      const real = AbortSignal.timeout.bind(AbortSignal);
      vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => real(ms === 20_000 ? 30 : ms));
      const f = network([llm(1, DEEPSEEK, { row: { price_lovelace: '100000' }, capability: hang }), llm(2, DEEPSEEK, { row: { price_lovelace: '200000' } })]);
      expect((await select(f))?.advertRef).toBe(advertOf(2));
    });

    it('a supplier that would answer after the budget is not used: the selection has given up before it can', async () => {
      let release: () => void = () => {};
      const late: Answer = async () => {
        await new Promise<void>((resolve) => { release = resolve; });
        return json(200, capabilityOf(1, DEEPSEEK));
      };
      const f = network([llm(1, DEEPSEEK, { capability: late })]);
      // Nothing releases the supplier until the selection has returned, so only the budget can have ended the call, and the supplier was asked.
      expect(await select(f, { budgetMs: 500 })).toBeNull();
      expect(askedOf(f, '/capability')).toStrictEqual([hostOf(endpointOf(1))]);
      release();
    });

    it('the budget runs from the call, the read of the indexer included: a slow indexer leaves nothing for the suppliers', async () => {
      const f = network([llm(1, DEEPSEEK)], { indexerDelayMs: 600 });
      expect(await select(f, { budgetMs: 500 })).toBeNull();
      expect(f.calls.map((c) => hostOf(c.url))).toStrictEqual(['indexer.test']);
    });

    it('a budget of no time asks no supplier', async () => {
      const f = network([llm(1, DEEPSEEK)]);
      expect(await select(f, { budgetMs: 0 })).toBeNull();
      expect(f.calls.map((c) => hostOf(c.url))).toStrictEqual(['indexer.test']);
    });

    it('a supplier that answers within the budget is used', async () => {
      const f = network([llm(1, DEEPSEEK, { capability: delayed(30, json(200, capabilityOf(1, DEEPSEEK))) })]);
      expect((await select(f, { budgetMs: 5000 }))?.advertRef).toBe(advertOf(1));
    });

    it('a budget of Infinity lifts the limit: the timer of the selection is the longest Node keeps, not one that Node would cut to a millisecond', async () => {
      const spy = vi.spyOn(AbortSignal, 'timeout');
      const f = network([llm(1, DEEPSEEK, { capability: delayed(30, json(200, capabilityOf(1, DEEPSEEK))) })]);
      expect((await select(f, { budgetMs: Number.POSITIVE_INFINITY }))?.advertRef).toBe(advertOf(1));
      expect(spy.mock.calls.map(([ms]) => ms)).toContain(2_147_483_647);
      expect(spy.mock.calls.every(([ms]) => ms <= 2_147_483_647)).toBe(true);
    });

    it('the budget is 120 s by default, from the call', async () => {
      const spy = vi.spyOn(AbortSignal, 'timeout');
      await select(network([llm(1, DEEPSEEK)]));
      expect(spy.mock.calls.some(([ms]) => ms > 119_000 && ms <= 120_000)).toBe(true);
      spy.mockClear();
      await select(network([llm(1, DEEPSEEK)]), { budgetMs: 5000 });
      expect(spy.mock.calls.some(([ms]) => ms > 4000 && ms <= 5000)).toBe(true);
    });

    it('a limit that is not a number is refused, and one below zero is none', async () => {
      await expect(select(network([llm(1, DEEPSEEK)]), { budgetMs: Number.NaN })).rejects.toThrow(TypeError);
      await expect(select(network([llm(1, DEEPSEEK)]), { maxCandidates: Number.NaN })).rejects.toThrow(TypeError);
      const f = crowd();
      expect(await select(f, { maxCandidates: -3 })).toBeNull();
      expect(askedOf(f, '/capability')).toStrictEqual([]);
    });
  });

  it('returns null when no supplier passes: nothing listed, nothing on the allowlist, an empty allowlist, every candidate failing', async () => {
    expect(await select(network([]))).toBeNull();
    expect(await select(network([llm(1, 'kimi-k3')]))).toBeNull();
    expect(await select(network([llm(1, DEEPSEEK)]), { allowlist: [] })).toBeNull();
    expect(await select(network([llm(1, DEEPSEEK, { capability: down }), llm(2, QWEN, { capability: { inference_api: undefined } })]))).toBeNull();
  });

  it('returns the endpoint as listed, a path included, and reaches the supplier there; the price is a bigint', async () => {
    const endpoint = `${endpointOf(1)}/p2a/tools/one`;
    const f = routedFetch({
      [`GET ${INDEXER}/suppliers`]: json(200, [row(1, DEEPSEEK, { endpoint_url: `${endpoint}/`, price_lovelace: '23000000' })]),
      [`GET ${endpoint}/capability`]: json(200, capabilityOf(1, DEEPSEEK)),
    });
    expect(await select(f)).toMatchObject({ endpoint: `${endpoint}/`, priceLovelace: 23_000_000n });
  });

  it('reads the indexer at indexerUrl (trailing slashes tolerated), or at the vendored base when none is given', async () => {
    const at = (base: string) => routedFetch({ [`GET ${base}/suppliers`]: json(200, [row(1, DEEPSEEK)]), [`GET ${endpointOf(1)}/capability`]: json(200, capabilityOf(1, DEEPSEEK)) });
    const named = at('https://other-indexer.test/api');
    expect((await selectLlmSupplier({ fetchImpl: named.fetchImpl, indexerUrl: 'https://other-indexer.test/api//', allowlist: ALLOWLIST }))?.advertRef).toBe(advertOf(1));
    expect(named.calls[0].url).toBe('https://other-indexer.test/api/suppliers');
    const vendored = at(INDEXER_URL);
    expect((await selectLlmSupplier({ fetchImpl: vendored.fetchImpl, allowlist: ALLOWLIST }))?.advertRef).toBe(advertOf(1));
    expect(vendored.calls[0].url).toBe(`${INDEXER_URL}/suppliers`);
    for (const same of [INDEXER_URL, `${INDEXER_URL}/`, '']) {
      const again = at(INDEXER_URL);
      expect((await selectLlmSupplier({ fetchImpl: again.fetchImpl, indexerUrl: same, allowlist: ALLOWLIST }))?.advertRef, same).toBe(advertOf(1));
      expect(again.calls[0].url).toBe(`${INDEXER_URL}/suppliers`);
    }
  });

  it('rejects when the indexer cannot be read: that is not "no supplier"', async () => {
    const fail = (answer: Answer) => select(routedFetch({ [`GET ${INDEXER}/suppliers`]: answer }));
    await expect(fail(json(503, { error: 'down' }))).rejects.toThrow(/list suppliers: indexer answered 503/);
    await expect(fail(json(200, { suppliers: [] }))).rejects.toThrow(/non-list/);
  });
});

// --- The OCR advert ---------------------------------------------------------------------------------------------------------------
const OCR_PKH = '401af418a7e6fb106277292881fcdeaa1cc15b5b112e9c8bdb2d46c9';
const OCR = 'ocr.page.extract.chandra-ocr-2.v1';
// The live ChandraOCR advert (the indexer's row, recorded 2026-10-13).
const CHANDRA = {
  utxo_ref: '87c46c30026b438ef0aaedcf3c656743b32dd68ce69e36d11f1e2d2b91659e5d#0', supplier_pkh: OCR_PKH, capability_id: OCR, model: 'historical-records-ocr-v1',
  max_output_tokens: 8192, max_processing_ms: 300000, price_lovelace: '200000', supplier_bond_lovelace: '1000000', buyer_bond_lovelace: '1000000',
  endpoint_url: 'https://mp-suppliers-chandra.hal8.ai', detail_uri: '', detail_hash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  advertised_at: 1786529315923, status: 'free', advert_status: 'Active', current_escrow_ref: null, last_seen_iso: '2026-10-13T12:03:23.302Z', created_slot: 30043723,
};

describe('findOcrAdvert', () => {
  const indexerOf = (rows: unknown[]) => routedFetch({ [`GET ${INDEXER}/suppliers`]: json(200, rows) });
  const find = (f: FakeFetch, supplierPkh = OCR_PKH) => findOcrAdvert({ fetchImpl: f.fetchImpl, indexerUrl: INDEXER, supplierPkh });

  it('returns the live advert of the allowlisted key: its ref, endpoint, price and processing window', async () => {
    const f = indexerOf([CHANDRA]);
    expect(await find(f)).toStrictEqual({
      advertRef: '87c46c30026b438ef0aaedcf3c656743b32dd68ce69e36d11f1e2d2b91659e5d#0', endpoint: 'https://mp-suppliers-chandra.hal8.ai', priceLovelace: 200000n, maxProcessingMs: 300000,
    });
    expect(f.calls.map((c) => c.url)).toStrictEqual([`${INDEXER}/suppliers`]);
  });

  it('returns the allowlisted supplier only: another key advertising the same capability, cheaper, is never the answer', async () => {
    const impostor = { ...CHANDRA, utxo_ref: advertOf(7), supplier_pkh: pkhOf(7), price_lovelace: '1', endpoint_url: endpointOf(7) };
    expect((await find(indexerOf([impostor, CHANDRA])))?.advertRef).toBe(CHANDRA.utxo_ref);
    expect(await find(indexerOf([impostor]))).toBeNull();
  });

  it('ignores the other capabilities of the allowlisted key', async () => {
    const chat = row(7, DEEPSEEK, { utxo_ref: advertOf(7), supplier_pkh: OCR_PKH });
    expect((await find(indexerOf([chat, CHANDRA])))?.advertRef).toBe(CHANDRA.utxo_ref);
    expect(await find(indexerOf([chat]))).toBeNull();
  });

  it('is null when the advert is missing from the indexer', async () => {
    expect(await find(indexerOf([]))).toBeNull();
  });

  // Ruling R60: the indexer's word on whether the supplier is busy is a moment's; the advert is hired whatever it says, and the send loop waits.
  it.each(['working', 'offline'])('is the advert when the indexer lists its supplier as %s', async (status) => {
    expect((await find(indexerOf([{ ...CHANDRA, status }])))?.advertRef).toBe(CHANDRA.utxo_ref);
  });

  it('is null when the key has more than one Active OCR advert, whatever the indexer says of each: exactly one is expected, and the choice is not made here', async () => {
    const second = { ...CHANDRA, utxo_ref: advertOf(8), endpoint_url: endpointOf(8) };
    expect(await find(indexerOf([CHANDRA, second]))).toBeNull();
    expect(await find(indexerOf([{ ...second, status: 'working' }, CHANDRA]))).toBeNull();
  });

  it('is the Active advert when the key has a second one that is retired', async () => {
    const retired = { ...CHANDRA, utxo_ref: advertOf(8), endpoint_url: endpointOf(8), advert_status: 'Retired' };
    expect((await find(indexerOf([retired, CHANDRA])))?.advertRef).toBe(CHANDRA.utxo_ref);
    expect(await find(indexerOf([retired]))).toBeNull();
  });

  it('compares the key without regard to case', async () => {
    expect((await find(indexerOf([CHANDRA]), OCR_PKH.toUpperCase()))?.advertRef).toBe(CHANDRA.utxo_ref);
  });

  it('is null when the advert is priced above maxPriceLovelace, and the advert when it is priced at it or under it (ruling R56)', async () => {
    const at = (maxPriceLovelace: bigint) => findOcrAdvert({ fetchImpl: indexerOf([CHANDRA]).fetchImpl, indexerUrl: INDEXER, supplierPkh: OCR_PKH, maxPriceLovelace });
    expect(await at(199_999n)).toBeNull();
    expect((await at(200_000n))?.advertRef).toBe(CHANDRA.utxo_ref);
    expect((await at(1_000_000n))?.priceLovelace).toBe(200_000n);
  });

  it('reads the indexer at indexerUrl, or at the vendored base when none is given, and contacts no supplier', async () => {
    const named = routedFetch({ [`GET https://other-indexer.test/suppliers`]: json(200, [CHANDRA]) });
    expect((await findOcrAdvert({ fetchImpl: named.fetchImpl, indexerUrl: 'https://other-indexer.test/', supplierPkh: OCR_PKH }))?.advertRef).toBe(CHANDRA.utxo_ref);
    const vendored = routedFetch({ [`GET ${INDEXER_URL}/suppliers`]: json(200, [CHANDRA]) });
    expect((await findOcrAdvert({ fetchImpl: vendored.fetchImpl, supplierPkh: OCR_PKH }))?.advertRef).toBe(CHANDRA.utxo_ref);
    expect(vendored.calls).toHaveLength(1);
  });

  it('rejects when the indexer cannot be read: that is not "no advert"', async () => {
    await expect(find(routedFetch({ [`GET ${INDEXER}/suppliers`]: json(502, {}) }))).rejects.toThrow(/list suppliers: indexer answered 502/);
  });
});
