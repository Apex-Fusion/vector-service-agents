// packages/usecase-kit/test/decision/limits.test.ts: the limits of a model hire. A model that is not on the allowlist, a price above the ceiling and a bond above its limit are never hired. A limit
// that is not given, or has a wrong type, is a refusal and never "no limit". Each refusal has an accepted twin.
import { afterEach, describe, expect, it } from 'vitest';
import { LLM_ADVERT, escrowNo } from '@vsa/hire-kit/testing';
import { LLM_MAX_PRICE_SETTING, LLM_MODEL_ALLOWLIST_SETTING, checkLimits, decide, parseMaxPrice, parseModelAllowlist } from '@vsa/usecase-kit/decision';
import type { DecisionDeps, ModelLimits } from '@vsa/usecase-kit/decision';
import { LIMITS, MEDIUM_LOT, REORDER, STOCK_INPUT, cleanup, deferred, lost, said, setup, won } from './support.ts';
import type { Run } from './support.ts';

afterEach(cleanup);

/** A text that no refusal may repeat. */
const MARKER = 'ZQ9-marker-7f3';

/** Nothing was hired: no call at all, no Post, no send and no escrow for the janitor, and the lane of the key is free. */
async function expectNothingHired(run: Run): Promise<void> {
  expect([run.m.calls, run.booked, run.m.llm.sends, run.key.stranded.list(), run.key.lane.busy]).toStrictEqual([[], [], [], [], false]);
  expect(await run.m.chain.escrowState(escrowNo(1))).toBe('unknown');
}

describe('the limits that decide checks: a hire outside them is never made', () => {
  it('does not hire a model that is not on the allowlist, and posts nothing; it hires the same model when the list names it', async () => {
    const off = await setup({}, undefined, { ...LIMITS, allowlist: ['nobody/nothing', 'another/model'] });
    const failure = lost(await decide(off.deps, REORDER, STOCK_INPUT));
    expect([failure.code, failure.reason, failure.escrow_ref, failure.stage, failure.delivery]).toStrictEqual(['inference_failed', 'llm_supplier_unavailable', null, null, null]);
    expect(off.m.llm.sends).toStrictEqual([]);
    expect([off.booked, off.key.stranded.list(), await off.m.chain.escrowState(escrowNo(1))]).toStrictEqual([[], [], 'unknown']);
    // The twin: the model of the advert is on the list.
    const on = await setup({}, undefined, { ...LIMITS, allowlist: ['nobody/nothing', LLM_ADVERT.model] });
    on.m.llm.answer = said(MEDIUM_LOT);
    expect(won(await decide(on.deps, REORDER, STOCK_INPUT)).choice).toStrictEqual(MEDIUM_LOT);
  });

  it('does not hire an advert whose price is above the ceiling by one lovelace, and hires it at the ceiling and above', async () => {
    const over = await setup({}, undefined, { ...LIMITS, maxPriceLovelace: LLM_ADVERT.price_lovelace - 1n });
    const failure = lost(await decide(over.deps, REORDER, STOCK_INPUT));
    expect([failure.code, failure.reason, failure.escrow_ref]).toStrictEqual(['inference_failed', 'llm_supplier_unavailable', null]);
    expect([over.booked, over.m.llm.sends, over.key.stranded.list()]).toStrictEqual([[], [], []]);
    for (const ceiling of [LLM_ADVERT.price_lovelace, LLM_ADVERT.price_lovelace + 1n]) {
      const run = await setup({}, undefined, { ...LIMITS, maxPriceLovelace: ceiling });
      run.m.llm.answer = said(MEDIUM_LOT);
      expect(won(await decide(run.deps, REORDER, STOCK_INPUT)).inference.accepted, String(ceiling)).toBe('confirmed');
    }
  });

  it('holds the price ceiling against the advert on the chain and not against the row of the indexer', async () => {
    // The indexer says that the model costs 100 lovelace. The advert on the chain says 200000.
    const run = await setup({}, undefined, { ...LIMITS, maxPriceLovelace: 150_000n });
    run.m.rows[0]!.price_lovelace = '100';
    expect(lost(await decide(run.deps, REORDER, STOCK_INPUT)).reason).toBe('llm_supplier_unavailable');
    expect([run.booked, run.m.llm.sends, run.key.stranded.list()]).toStrictEqual([[], [], []]);
    // The twin: a ceiling that covers the advert on the chain hires it.
    const twin = await setup({}, undefined, { ...LIMITS, maxPriceLovelace: 200_000n });
    twin.m.rows[0]!.price_lovelace = '100';
    twin.m.llm.answer = said(MEDIUM_LOT);
    expect(won(await decide(twin.deps, REORDER, STOCK_INPUT)).name).toBe('reorder');
  });

  it.each<['maxSupplierBondLovelace' | 'maxBuyerBondLovelace', bigint]>([
    ['maxSupplierBondLovelace', LLM_ADVERT.supplier_bond_lovelace],
    ['maxBuyerBondLovelace', LLM_ADVERT.buyer_bond_lovelace],
  ])('does not hire an advert whose bond is above %s by one lovelace, and hires it at the limit and with null', async (field, bond) => {
    const over = await setup({}, undefined, { ...LIMITS, [field]: bond - 1n });
    const failure = lost(await decide(over.deps, REORDER, STOCK_INPUT));
    expect([failure.code, failure.reason, failure.escrow_ref]).toStrictEqual(['inference_failed', 'llm_supplier_unavailable', null]);
    expect([over.booked, over.m.llm.sends, over.key.stranded.list()]).toStrictEqual([[], [], []]);
    for (const limit of [bond, null]) {
      const run = await setup({}, undefined, { ...LIMITS, [field]: limit });
      run.m.llm.answer = said(MEDIUM_LOT);
      expect(won(await decide(run.deps, REORDER, STOCK_INPUT)).inference.accepted, String(limit)).toBe('confirmed');
    }
  });

  it('holds 0 as a limit and not as no limit: only null means no limit, and a caller writes it on purpose', async () => {
    for (const field of ['maxSupplierBondLovelace', 'maxBuyerBondLovelace'] as const) {
      const zero = await setup({}, undefined, { ...LIMITS, [field]: 0n });
      expect(lost(await decide(zero.deps, REORDER, STOCK_INPUT)).reason, field).toBe('llm_supplier_unavailable');
      expect(zero.booked, field).toStrictEqual([]);
      const none = await setup({}, undefined, { ...LIMITS, [field]: null });
      none.m.llm.answer = said(MEDIUM_LOT);
      expect(won(await decide(none.deps, REORDER, STOCK_INPUT)).inference.accepted, field).toBe('confirmed');
    }
  });

  it('holds each bond against its own limit: an advert with a supplier bond of 3 and a buyer bond of 1 passes the limits 3 and 1, and fails when either limit is one lovelace below its own bond', async () => {
    const chain = { lockLovelace: 60_000_000n, floatLovelace: 200_000_000n, llmAdvert: { ...LLM_ADVERT, supplier_bond_lovelace: 3_000_000n, buyer_bond_lovelace: 1_000_000n } };
    const within = await setup(chain, undefined, { ...LIMITS, maxSupplierBondLovelace: 3_000_000n, maxBuyerBondLovelace: 1_000_000n });
    within.m.llm.answer = said(MEDIUM_LOT);
    expect(won(await decide(within.deps, REORDER, STOCK_INPUT)).inference.accepted).toBe('confirmed');
    const over: Array<[string, bigint, bigint]> = [['supplier bond', 2_999_999n, 1_000_000n], ['buyer bond', 3_000_000n, 999_999n]];
    for (const [name, supplierLimit, buyerLimit] of over) {
      const run = await setup(chain, undefined, { ...LIMITS, maxSupplierBondLovelace: supplierLimit, maxBuyerBondLovelace: buyerLimit });
      expect(lost(await decide(run.deps, REORDER, STOCK_INPUT)).reason, name).toBe('llm_supplier_unavailable');
      expect([run.booked, run.m.llm.sends], name).toStrictEqual([[], []]);
    }
  });
});

describe('a limit that is not given', () => {
  type Written = Record<string, unknown>;
  const kinds: Array<[string, unknown]> = [
    ['a number', 1_000_000], ['a text', `1000000 ${MARKER}`], ['a boolean', true], ['an object', { value: 1n }], ['a list', [1n]], ['a function', () => 1n], ['undefined', undefined], ['below 0', -1n],
  ];
  /** Every way to write a wrong limit: the field and a limit that the field refuses. `missing` leaves the field out. */
  const bad: Array<[string, (limits: Written) => void]> = [];
  for (const field of ['maxPriceLovelace', 'maxSupplierBondLovelace', 'maxBuyerBondLovelace']) {
    bad.push([`${field} missing`, (limits) => { delete limits[field]; }]);
    for (const [kind, value] of kinds) bad.push([`${field} as ${kind}`, (limits) => { limits[field] = value; }]);
  }
  // The price ceiling takes no null. The two bonds take null, as a caller writes it on purpose.
  bad.push(['maxPriceLovelace as null', (limits) => { limits.maxPriceLovelace = null; }]);
  bad.push(['allowlist missing', (limits) => { delete limits.allowlist; }]);
  for (const [kind, value] of [['a text', `deepseek/deepseek-v4-flash ${MARKER}`], ['a text with no space', 'deepseek/deepseek-v4-flash'], ['a number', 7], ['null', null], ['undefined', undefined], ['an object', {}], ['an empty list', []],
    ['a list with a number', ['a/b', 7]], ['a list with an empty name', ['a/b', '']], ['a list with a name that has a space', [`a/b ${MARKER}`]], ['a list with a hole', [, 'a/b']]] as Array<[string, unknown]>) {
    bad.push([`allowlist as ${kind}`, (limits) => { limits.allowlist = value; }]);
  }

  it.each(bad)('is refused with bad_limit, and nothing is hired: %s', async (_name, change) => {
    const limits: Written = { ...LIMITS };
    change(limits);
    const checked = checkLimits(limits);
    expect(checked.ok).toBe(false);
    if (checked.ok) return;
    expect(checked.code).toBe('bad_limit');
    expect(checked.detail).toMatch(/^limits\./);
    expect(checked.detail).not.toContain(MARKER);
    const run = await setup();
    run.deps = { ...run.deps, limits: limits as unknown as ModelLimits };
    const failure = lost(await decide(run.deps, REORDER, STOCK_INPUT));
    expect([failure.code, failure.reason, failure.delivery, failure.escrow_ref]).toStrictEqual(['internal', 'bad_limit', null, null]);
    expect(failure.detail).toBe(checked.detail);
    await expectNothingHired(run);
  });

  it('is refused when the limits are not an object at all', async () => {
    for (const limits of [undefined, null, 'limits', 7, [], () => LIMITS]) {
      const run = await setup();
      run.deps = { ...run.deps, limits: limits as unknown as ModelLimits };
      const failure = lost(await decide(run.deps, REORDER, STOCK_INPUT));
      expect([failure.reason, failure.detail.startsWith('limits must be an object, and it is ')], String(limits)).toStrictEqual(['bad_limit', true]);
      await expectNothingHired(run);
    }
  });

  it('accepts the limits that are given, with a bigint for the price and a bigint or null for each bond: the twin of every case above', async () => {
    expect(checkLimits(LIMITS)).toStrictEqual({ ok: true, value: LIMITS });
    for (const bond of [0n, 5n, null]) {
      const checked = checkLimits({ ...LIMITS, maxSupplierBondLovelace: bond, maxBuyerBondLovelace: bond });
      expect(checked.ok, String(bond)).toBe(true);
    }
    const run = await setup();
    run.m.llm.answer = said(MEDIUM_LOT);
    expect(won(await decide(run.deps, REORDER, STOCK_INPUT)).name).toBe('reorder');
  });

  it('reads each limit one time: a getter that gives another value at a second read cannot change what is checked', () => {
    let reads = 0;
    const limits = { ...LIMITS, get maxPriceLovelace(): unknown { reads += 1; return reads === 1 ? 5n : 'not a bigint'; } };
    const checked = checkLimits(limits);
    expect(checked).toMatchObject({ ok: true, value: { maxPriceLovelace: 5n } });
    expect(reads).toBe(1);
  });

  it('is refused, and does not throw, when the limits cannot be read', () => {
    const hostile = new Proxy({}, { get: () => { throw new Error(`no read ${MARKER}`); } });
    const throwing = { ...LIMITS, get allowlist(): never { throw new Error(`no read ${MARKER}`); } };
    for (const limits of [hostile, throwing]) {
      const checked = checkLimits(limits);
      expect(checked).toMatchObject({ ok: false, code: 'bad_limit' });
      expect(JSON.stringify(checked)).not.toContain(MARKER);
    }
  });

  it('returns a frozen copy: the list is not the list of the caller', () => {
    const allowlist = ['deepseek/deepseek-v4-flash'];
    const checked = checkLimits({ ...LIMITS, allowlist });
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    expect(checked.value.allowlist).not.toBe(allowlist);
    expect([Object.isFrozen(checked.value), Object.isFrozen(checked.value.allowlist)]).toStrictEqual([true, true]);
    allowlist.push('another/model');
    expect(checked.value.allowlist).toStrictEqual(['deepseek/deepseek-v4-flash']);
  });
});

describe('the limits of a decision are the limits at the time it starts', () => {
  it('does not let a caller change the limits of a decision that waits for its turn, and does not let it change the next one without a new check', async () => {
    const gate = deferred();
    const reached = deferred();
    let held = true;
    const run = await setup({}, (m) => ({
      accept: async (ref) => {
        if (held) { held = false; reached.resolve(); await gate.promise; }
        return m.chain.accept(ref);
      },
    }));
    run.m.llm.answer = said(MEDIUM_LOT);
    const allowlist = [LLM_ADVERT.model];
    const limits: { -readonly [K in keyof ModelLimits]: ModelLimits[K] } = { ...LIMITS, allowlist };
    const deps: DecisionDeps = { ...run.deps, limits };
    const first = decide(deps, REORDER, STOCK_INPUT);
    const second = decide(deps, REORDER, STOCK_INPUT);
    await reached.promise;
    // The first decision is in its Accept. The second waits for the lane. The caller now empties its list and sets the ceiling to 0.
    allowlist.length = 0;
    limits.maxPriceLovelace = 0n;
    gate.resolve();
    const [a, b] = await Promise.all([first, second]);
    expect([won(a).inference.sub_job.escrow_ref, won(b).inference.sub_job.escrow_ref]).toStrictEqual([escrowNo(1), escrowNo(2)]);
    // A decision that starts after the change is checked with the new limits, and it is refused.
    expect(lost(await decide(deps, REORDER, STOCK_INPUT)).reason).toBe('bad_limit');
  });

  it('checks the limits of each decision on their own: a decision that is outside its limits does not stop one that is inside, and posts nothing', async () => {
    const run = await setup();
    run.m.llm.answer = said(MEDIUM_LOT);
    const outside: DecisionDeps = { ...run.deps, limits: { ...LIMITS, allowlist: ['nobody/nothing'] } };
    const [a, b] = await Promise.all([decide(outside, REORDER, STOCK_INPUT), decide(run.deps, REORDER, STOCK_INPUT)]);
    expect(lost(a).reason).toBe('llm_supplier_unavailable');
    expect(won(b).inference.sub_job.escrow_ref).toBe(escrowNo(1));
    expect(run.booked).toHaveLength(1);
  });
});

describe('the two settings', () => {
  it('names the settings that the caller reads', () => {
    expect([LLM_MODEL_ALLOWLIST_SETTING, LLM_MAX_PRICE_SETTING]).toStrictEqual(['LLM_MODEL_ALLOWLIST', 'LLM_MAX_PRICE_LOVELACE']);
  });

  it.each<[string, unknown, readonly string[]]>([
    ['one model', 'deepseek/deepseek-v4-flash', ['deepseek/deepseek-v4-flash']],
    ['several models in the order of preference', 'deepseek/deepseek-v4-flash,moonshotai/kimi-k2.6,qwen2.5:0.5b', ['deepseek/deepseek-v4-flash', 'moonshotai/kimi-k2.6', 'qwen2.5:0.5b']],
    ['white space around the entries and an empty entry', ' a/b , ,c.d_e-f:g ,\n', ['a/b', 'c.d_e-f:g']],
  ])('reads LLM_MODEL_ALLOWLIST: %s', (_name, text, models) => {
    expect(parseModelAllowlist(text)).toStrictEqual({ ok: true, value: models });
  });

  it.each<[string, unknown]>([
    ['nothing', undefined],
    ['an empty text', ''],
    ['a text of commas and spaces', ' , ,'],
    ['a number', 7],
    ['a list', ['a/b']],
    ['an entry with a space inside', `a/b,c d ${MARKER}`],
    ['an entry with a character that a model name does not have', `a/b,c;d ${MARKER}`],
  ])('refuses LLM_MODEL_ALLOWLIST when it is %s, and never repeats it', (_name, value) => {
    const result = parseModelAllowlist(value);
    expect(result).toMatchObject({ ok: false, code: 'bad_limit' });
    expect(JSON.stringify(result)).not.toContain(MARKER);
    expect(JSON.stringify(result)).toContain(LLM_MODEL_ALLOWLIST_SETTING);
  });

  it('names the position of the entry that is wrong', () => {
    expect(parseModelAllowlist('a/b,c d,e/f')).toMatchObject({ ok: false, detail: expect.stringContaining('entry 2') });
  });

  it.each<[string, unknown, bigint]>([
    ['zero', '0', 0n],
    ['one unit', '1000000', 1_000_000n],
    ['white space around the digits', ' 200000\n', 200_000n],
    ['the most that a safe integer holds', '9007199254740991', 9_007_199_254_740_991n],
  ])('reads LLM_MAX_PRICE_LOVELACE: %s', (_name, text, price) => {
    expect(parseMaxPrice(text)).toStrictEqual({ ok: true, value: price });
  });

  it.each<[string, unknown]>([
    ['nothing', undefined],
    ['an empty text', ''],
    ['a number', 1_000_000],
    ['a bigint', 1_000_000n],
    ['a negative number', '-1'],
    ['a fraction', '1.5'],
    ['a number with an exponent', '1e6'],
    ['hexadecimal', '0x10'],
    ['digits and a word', `1000000 ${MARKER}`],
    ['more than a safe integer', '9007199254740992'],
  ])('refuses LLM_MAX_PRICE_LOVELACE when it is %s, and never repeats it', (_name, value) => {
    const result = parseMaxPrice(value);
    expect(result).toMatchObject({ ok: false, code: 'bad_limit' });
    expect(JSON.stringify(result)).not.toContain(MARKER);
    expect(JSON.stringify(result)).toContain(LLM_MAX_PRICE_SETTING);
  });
});
