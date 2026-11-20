// packages/usecase-kit/test/protocol/faults.test.ts: the kinds of agent and the values of the fault switch. A fault value is empty in a clean run. A value that an agent kind does not list is not a
// fault value of that kind.
import { describe, expect, expectTypeOf, it } from 'vitest';
import { AGENT_KINDS, BUYER_SIDE_KINDS, COUNTERPARTY_KINDS, FAULT_MODES, isAgentKind, isFaultSetting } from '@vsa/usecase-kit/protocol';
import type { AgentKind, BuyerSideKind, CounterpartyKind, FaultMode, FaultSetting } from '@vsa/usecase-kit/protocol';

describe('the kinds of agent', () => {
  it('are three buyer-side kinds and three counterparty kinds, in the order of the use cases', () => {
    expect([...BUYER_SIDE_KINDS]).toStrictEqual(['reorder-agent', 'prior-authorization-agent', 'sourcing-agent']);
    expect([...COUNTERPARTY_KINDS]).toStrictEqual(['order-desk', 'insurer-intake-agent', 'bid-desk']);
    expect([...AGENT_KINDS]).toStrictEqual([...BUYER_SIDE_KINDS, ...COUNTERPARTY_KINDS]);
  });

  it('have types that follow the lists', () => {
    expectTypeOf<BuyerSideKind>().toEqualTypeOf<'reorder-agent' | 'prior-authorization-agent' | 'sourcing-agent'>();
    expectTypeOf<CounterpartyKind>().toEqualTypeOf<'order-desk' | 'insurer-intake-agent' | 'bid-desk'>();
    expectTypeOf<AgentKind>().toEqualTypeOf<BuyerSideKind | CounterpartyKind>();
  });
});

describe('isAgentKind', () => {
  it.each(AGENT_KINDS)('takes the kind %s', (kind) => {
    expect(isAgentKind(kind)).toBe(true);
  });

  it.each([
    ['an empty text', '', 'bid-desk'],
    ['upper case', 'BID-DESK', 'bid-desk'],
    ['one capital letter', 'Bid-desk', 'bid-desk'],
    ['a prefix', 'x-bid-desk', 'bid-desk'],
    ['a suffix', 'bid-desk-2', 'bid-desk'],
    ['a part of a kind', 'bid', 'bid-desk'],
    ['white space before', ' bid-desk', 'bid-desk'],
    ['white space after', 'bid-desk ', 'bid-desk'],
    ['a line break after', 'bid-desk\n', 'bid-desk'],
    ['an underscore for the hyphen', 'bid_desk', 'bid-desk'],
    ['the name of a member of Object.prototype', 'constructor', 'order-desk'],
    ['the name of a method of an array', 'includes', 'order-desk'],
    ['the name of a use case', 'inventory-reorder', 'reorder-agent'],
    ['the name of a fault value', 'confirm_wrong_lot', 'order-desk'],
    ['a number', 1, 'bid-desk'],
    ['null', null, 'bid-desk'],
    ['undefined', undefined, 'bid-desk'],
    ['a list that holds a kind', ['bid-desk'], 'bid-desk'],
    ['an object with a toString that gives a kind', { toString: () => 'bid-desk' }, 'bid-desk'],
    ['a String object', new String('bid-desk'), 'bid-desk'],
  ])('refuses %s, and takes the kind that it stands for', (_what, value, kind) => {
    expect(isAgentKind(value)).toBe(false);
    expect(isAgentKind(kind)).toBe(true);
  });

  it('is a type guard that gives an AgentKind', () => {
    const value: unknown = 'order-desk';
    if (isAgentKind(value)) expectTypeOf(value).toEqualTypeOf<AgentKind>();
    expect(isAgentKind(value)).toBe(true);
  });
});

describe('FAULT_MODES', () => {
  it('lists the fault values of each kind: one value each for four kinds, none for the other two', () => {
    expect({ ...FAULT_MODES }).toStrictEqual({
      'reorder-agent': [],
      'prior-authorization-agent': ['alter_after_approval'],
      'sourcing-agent': ['invert_scores'],
      'order-desk': ['confirm_wrong_lot'],
      'insurer-intake-agent': [],
      'bid-desk': ['quote_off_price_list'],
    });
  });

  it('has an entry for each kind and for no other name', () => {
    expect(Object.keys(FAULT_MODES).sort()).toStrictEqual([...AGENT_KINDS].sort());
  });

  it('names no fault value twice, and none of them is the empty value of a clean run', () => {
    const all = Object.values(FAULT_MODES).flat();
    expect(new Set(all).size).toBe(all.length);
    expect(all).not.toContain('');
  });

  it('has types that follow the table: the kinds with no value have no fault mode', () => {
    expectTypeOf<FaultMode<'order-desk'>>().toEqualTypeOf<'confirm_wrong_lot'>();
    expectTypeOf<FaultMode<'reorder-agent'>>().toEqualTypeOf<never>();
    expectTypeOf<FaultMode>().toEqualTypeOf<'alter_after_approval' | 'invert_scores' | 'confirm_wrong_lot' | 'quote_off_price_list'>();
    expectTypeOf<FaultSetting<'bid-desk'>>().toEqualTypeOf<'' | 'quote_off_price_list'>();
    expectTypeOf<FaultSetting<'insurer-intake-agent'>>().toEqualTypeOf<''>();
  });
});

describe('isFaultSetting', () => {
  it('takes the empty value of a clean run for every kind', () => {
    for (const kind of AGENT_KINDS) expect(isFaultSetting(kind, ''), kind).toBe(true);
  });

  it('takes the fault value of a kind for that kind', () => {
    expect(isFaultSetting('order-desk', 'confirm_wrong_lot')).toBe(true);
    expect(isFaultSetting('prior-authorization-agent', 'alter_after_approval')).toBe(true);
    expect(isFaultSetting('bid-desk', 'quote_off_price_list')).toBe(true);
    expect(isFaultSetting('sourcing-agent', 'invert_scores')).toBe(true);
  });

  it('refuses the fault value of another kind', () => {
    expect(isFaultSetting('order-desk', 'alter_after_approval')).toBe(false);
    expect(isFaultSetting('bid-desk', 'confirm_wrong_lot')).toBe(false);
    expect(isFaultSetting('sourcing-agent', 'quote_off_price_list')).toBe(false);
    expect(isFaultSetting('prior-authorization-agent', 'invert_scores')).toBe(false);
  });

  it('refuses every value for a kind that has no fault value, except the empty one', () => {
    for (const value of ['confirm_wrong_lot', 'alter_after_approval', 'invert_scores', 'quote_off_price_list', 'none', 'off']) {
      expect(isFaultSetting('reorder-agent', value), value).toBe(false);
      expect(isFaultSetting('insurer-intake-agent', value), value).toBe(false);
    }
  });

  it.each([' ', 'CONFIRM_WRONG_LOT', 'confirm_wrong_lot ', ' confirm_wrong_lot', 'confirm-wrong-lot', 'confirm_wrong', 'constructor', '__proto__', 'toString', 0, 1, null, undefined, false, true, {}, ['confirm_wrong_lot']])(
    'refuses %j',
    (value) => {
      expect(isFaultSetting('order-desk', value)).toBe(false);
    },
  );

  it('does not throw for a kind that is not in the table, and takes only the empty value then', () => {
    for (const kind of ['constructor', '__proto__', 'toString', 'no-such-kind', '']) {
      expect(() => isFaultSetting(kind as AgentKind, 'confirm_wrong_lot')).not.toThrow();
      expect(isFaultSetting(kind as AgentKind, 'confirm_wrong_lot')).toBe(false);
    }
  });

  it('narrows a text to the settings of the kind', () => {
    const text: unknown = 'confirm_wrong_lot';
    if (isFaultSetting('order-desk', text)) expectTypeOf(text).toEqualTypeOf<FaultSetting<'order-desk'>>();
    expect(isFaultSetting('order-desk', text)).toBe(true);
  });
});
