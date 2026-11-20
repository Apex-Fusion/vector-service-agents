// packages/usecase-kit/test/manifest/behaviour.test.ts: the additions that each kind of agent makes under `behaviour`, the co-sign rule, the fault values and the one gap sentence about the fault
// switch. The typecheck is part of the test: a line that must not compile carries a `@ts-expect-error`. Each refusal has an accepted twin.
import { createHash } from 'node:crypto';
import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  ADDITION_MEMBERS, COSIGN_ROUTE, COSIGN_RULE, FAULT_EFFECTS, buildBehaviour, buildCosign, buildFaultModes, faultGap, parseBehaviourAdditions, withFaultGap,
} from '@vsa/usecase-kit/manifest';
import { AGENT_KINDS, BUYER_SIDE_KINDS, COUNTERPARTY_KINDS, FAULT_MODES } from '@vsa/usecase-kit/protocol';
import type { AgentKind, BehaviourAdditions } from '@vsa/usecase-kit/protocol';
import { CLAIM, LOTS, MODEL, PARTS, PRICES, RELYING_ON, TEMPLATE_FILES, refusal, unwrap } from './support.ts';

const BUYER = ['operations', 'claim', 'cosign', 'fault_modes', 'model', 'relying_on'];
const MEMBERS: Record<AgentKind, string[]> = {
  'reorder-agent': BUYER,
  'prior-authorization-agent': BUYER,
  'sourcing-agent': BUYER,
  'order-desk': ['claim', 'fault_modes', 'model', 'relying_on', 'lots'],
  'insurer-intake-agent': ['claim', 'fault_modes', 'model', 'relying_on'],
  'bid-desk': ['claim', 'fault_modes', 'model', 'relying_on', 'price_list'],
};

describe('buildBehaviour: the members of each kind', () => {
  it.each(AGENT_KINDS)('gives %s exactly its members, in the order of the manifest', (kind) => {
    expect(Object.keys(unwrap(buildBehaviour(kind, PARTS[kind])))).toStrictEqual(MEMBERS[kind]);
  });

  it('gives a buyer-side agent both operations and the co-sign rule', () => {
    for (const kind of BUYER_SIDE_KINDS) {
      const additions = unwrap(buildBehaviour(kind, PARTS[kind]));
      expect(additions.operations, kind).toStrictEqual(['propose', 'execute']);
      expect(additions.cosign, kind).toStrictEqual({ route: COSIGN_ROUTE, rule: COSIGN_RULE });
    }
  });

  it('gives a counterparty no operations and no co-sign member', () => {
    for (const kind of COUNTERPARTY_KINDS) {
      const additions = unwrap(buildBehaviour(kind, PARTS[kind]));
      expect(Object.hasOwn(additions, 'operations'), kind).toBe(false);
      expect(Object.hasOwn(additions, 'cosign'), kind).toBe(false);
    }
  });

  it('gives the lots file to the order desk, the price list to the bid desk, and no file to the others', () => {
    expect(unwrap(buildBehaviour('order-desk', PARTS['order-desk'])).lots).toStrictEqual(LOTS);
    expect(unwrap(buildBehaviour('bid-desk', PARTS['bid-desk'])).price_list).toStrictEqual(PRICES);
    for (const kind of AGENT_KINDS) {
      const additions = unwrap(buildBehaviour(kind, PARTS[kind]));
      expect(Object.hasOwn(additions, 'lots'), kind).toBe(kind === 'order-desk');
      expect(Object.hasOwn(additions, 'price_list'), kind).toBe(kind === 'bid-desk');
    }
  });

  it('lists every fault value of the kind in fault_modes, from the table of the protocol, and none for a kind with no value', () => {
    for (const kind of AGENT_KINDS) expect(unwrap(buildBehaviour(kind, PARTS[kind])).fault_modes, kind).toStrictEqual([...FAULT_MODES[kind]]);
    expect(unwrap(buildBehaviour('reorder-agent', PARTS['reorder-agent'])).fault_modes).toStrictEqual([]);
    expect(unwrap(buildBehaviour('bid-desk', PARTS['bid-desk'])).fault_modes).toStrictEqual(['quote_off_price_list']);
  });

  it('has a claim of three statements with no claim reference, for every kind', () => {
    for (const kind of AGENT_KINDS) {
      const { claim } = unwrap(buildBehaviour(kind, PARTS[kind]));
      expect(claim, kind).toStrictEqual({ statements: [{ id: 'S1', text: CLAIM[0] }, { id: 'S2', text: CLAIM[1] }, { id: 'S3', text: CLAIM[2] }] });
      expect(JSON.stringify(unwrap(buildBehaviour(kind, PARTS[kind]))), kind).not.toMatch(/reference|standing_claim|fault_mode"/);
    }
  });

  it('takes the models and the routes as they are given', () => {
    const additions = unwrap(buildBehaviour('reorder-agent', PARTS['reorder-agent']));
    expect(additions.model).toStrictEqual({ allowlist: [...MODEL.allowlist], max_price_lovelace: MODEL.max_price_lovelace });
    expect(additions.relying_on).toStrictEqual({ mock_systems: [...RELYING_ON.mock_systems], gateway_routes: [...RELYING_ON.gateway_routes] });
  });
});

describe('buildBehaviour: stable bytes', () => {
  it('gives the same bytes for the same parts, on every call', () => {
    for (const kind of AGENT_KINDS) expect(JSON.stringify(unwrap(buildBehaviour(kind, PARTS[kind]))), kind).toBe(JSON.stringify(unwrap(buildBehaviour(kind, PARTS[kind]))));
  });

  it('gives the same bytes when the caller writes the members of the parts in another order', () => {
    const shuffled = { relying_on: { gateway_routes: [...RELYING_ON.gateway_routes], mock_systems: [...RELYING_ON.mock_systems] }, lots: { sha256: LOTS.sha256, uri: LOTS.uri }, model: { max_price_lovelace: 200_000, allowlist: [...MODEL.allowlist] }, claim: [...CLAIM] as [string, string, string] };
    expect(JSON.stringify(unwrap(buildBehaviour('order-desk', shuffled)))).toBe(JSON.stringify(unwrap(buildBehaviour('order-desk', PARTS['order-desk']))));
  });

  it('returns new objects: a change of one result changes neither the next result nor the parts', () => {
    const first = unwrap(buildBehaviour('reorder-agent', PARTS['reorder-agent']));
    Array.prototype.push.call(first.fault_modes, 'x');
    Array.prototype.push.call(first.operations, 'x');
    Array.prototype.push.call(first.model.allowlist, 'x');
    const second = unwrap(buildBehaviour('reorder-agent', PARTS['reorder-agent']));
    expect(second.fault_modes).toStrictEqual([]);
    expect(second.operations).toStrictEqual(['propose', 'execute']);
    expect(second.model.allowlist).toStrictEqual([...MODEL.allowlist]);
    expect(MODEL.allowlist).toStrictEqual(['deepseek/deepseek-v4-flash']);
  });

  it('is the same bytes as the golden text of one kind, so a change of a word or of the order is a deliberate change', () => {
    const text = JSON.stringify(unwrap(buildBehaviour('bid-desk', PARTS['bid-desk'])));
    expect(text).toBe(
      `{"claim":{"statements":[{"id":"S1","text":"An order that this agent places is the purchase order that its hirer approved."},{"id":"S2","text":"This agent accepts only a confirmation that names the SKU and the lot of the order."},{"id":"S3","text":"This agent pays a supplier only from the vault of its delegation."}]},"fault_modes":["quote_off_price_list"],"model":{"allowlist":["deepseek/deepseek-v4-flash"],"max_price_lovelace":200000},"relying_on":{"mock_systems":["GET /erp/stock/{sku}","POST /po"],"gateway_routes":["POST /token"]},"price_list":{"uri":"https://example.invalid/prices.json","sha256":"${'cd'.repeat(32)}"}}`,
    );
  });

  it('has a hash for each kind that changes only when the additions change on purpose', () => {
    const hashes = Object.fromEntries(AGENT_KINDS.map((kind) => [kind, createHash('sha256').update(JSON.stringify(unwrap(buildBehaviour(kind, PARTS[kind]))), 'utf8').digest('hex')]));
    expect(hashes).toStrictEqual({
      'reorder-agent': '6696b7c808d71747fb4a1fedbe999f775fc944bbc8aa4927bac4897ce4ba9d0e',
      'prior-authorization-agent': '9daed395eb64efbda1877b24d3480ec9e500f51ecff16af9ade1b73cd4367ff9',
      'sourcing-agent': 'b592eab49cd5e268eccb4e85dcf910d37476151eefd20e2b611428e25f7bdaae',
      'order-desk': '2dc3a03737610012eabe0f27e8c8858ed0d16b5d9942f6744d9246ab96c6b06e',
      'insurer-intake-agent': '2d90e2bf6909d650d1cdd30f10a79bcd2e103e99ba0d84b1e241072736893022',
      'bid-desk': '59f2b585c126238b21824d6f64513b786acedc1898e5b925bcdaaad8bc174562',
    });
  });
});

describe('buildBehaviour: a part that is wrong', () => {
  it('refuses a part that the kind needs and the caller left out', () => {
    expect(refusal(
      // @ts-expect-error an order desk needs its lots file
      buildBehaviour('order-desk', PARTS['reorder-agent']),
    ).detail).toBe('parts has no member "lots"');
    // @ts-expect-error a bid desk needs its price list
    expect(refusal(buildBehaviour('bid-desk', PARTS['reorder-agent'])).detail).toBe('parts has no member "price_list"');
    // @ts-expect-error the claim is part of every manifest
    expect(refusal(buildBehaviour('reorder-agent', { model: MODEL, relying_on: RELYING_ON })).detail).toBe('parts has no member "claim"');
    // @ts-expect-error the models are part of every manifest
    expect(refusal(buildBehaviour('reorder-agent', { claim: CLAIM, relying_on: RELYING_ON })).detail).toBe('parts has no member "model"');
    // @ts-expect-error the routes are part of every manifest
    expect(refusal(buildBehaviour('reorder-agent', { claim: CLAIM, model: MODEL })).detail).toBe('parts has no member "relying_on"');
  });

  it('refuses a part that the kind does not have', () => {
    // @ts-expect-error an insurer intake agent has no lots file
    expect(refusal(buildBehaviour('insurer-intake-agent', { ...PARTS['insurer-intake-agent'], lots: LOTS })).detail).toBe('parts has the member "lots", which is not allowed');
    // @ts-expect-error an order desk has no price list
    expect(refusal(buildBehaviour('order-desk', { ...PARTS['order-desk'], price_list: PRICES })).detail).toBe('parts has the member "price_list", which is not allowed');
    // @ts-expect-error a bid desk has no lots file
    expect(refusal(buildBehaviour('bid-desk', { ...PARTS['bid-desk'], lots: LOTS })).code).toBe('bad_shape');
  });

  it.each(['operations', 'cosign', 'fault_modes', 'fault_mode', 'reference', 'claim_reference', 'standing_claim'])('refuses the member %s: the kind gives it, or the manifest does not have it', (name) => {
    // The name is a variable, so the type system sees an index signature and no excess member. The run time refuses the member.
    expect(refusal(buildBehaviour('reorder-agent', { ...PARTS['reorder-agent'], [name]: 'x' } as never)).detail).toBe(`parts has the member "${name}", which is not allowed`);
  });

  it('refuses a claim with a claim reference inside the parts of the claim', () => {
    // @ts-expect-error the claim is three texts, and there is no place for a reference
    expect(buildBehaviour('reorder-agent', { ...PARTS['reorder-agent'], claim: { statements: [...CLAIM], reference: 'ab#0' } })).toMatchObject({ ok: false, code: 'bad_shape' });
    // @ts-expect-error the claim is exactly three texts
    expect(buildBehaviour('reorder-agent', { ...PARTS['reorder-agent'], claim: [CLAIM[0], CLAIM[1]] })).toMatchObject({ ok: false, code: 'bad_shape' });
  });

  it('refuses a part that does not pass its own rule, and names the field', () => {
    expect(refusal(buildBehaviour('reorder-agent', { ...PARTS['reorder-agent'], model: { ...MODEL, max_price_lovelace: 0 } })).detail).toBe('behaviour.model.max_price_lovelace must be a whole number of lovelace, 1 or more');
    expect(refusal(buildBehaviour('order-desk', { ...PARTS['order-desk'], lots: { ...LOTS, uri: 'http://example.invalid/lots.json' } })).detail).toBe('behaviour.lots.uri must be an https address with no user and no password');
    expect(refusal(buildBehaviour('bid-desk', { ...PARTS['bid-desk'], price_list: { ...PRICES, sha256: 'xyz' } })).detail).toBe('behaviour.price_list.sha256 must be 64 lower-case hex characters');
    expect(refusal(buildBehaviour('sourcing-agent', { ...PARTS['sourcing-agent'], relying_on: { ...RELYING_ON, mock_systems: ['po'] } })).code).toBe('bad_shape');
  });

  it('takes a part that is undefined as a part that is not there: the twin of the refusals above', () => {
    expect(buildBehaviour('insurer-intake-agent', { ...PARTS['insurer-intake-agent'], lots: undefined })).toMatchObject({ ok: true });
    // @ts-expect-error a part that the kind needs is not there when it is undefined
    expect(refusal(buildBehaviour('order-desk', { ...PARTS['order-desk'], lots: undefined })).detail).toBe('parts has no member "lots"');
  });

  it('refuses parts that are not an object, and a kind that is not a kind of agent', () => {
    for (const parts of [null, undefined, [], 'parts', 7]) expect(buildBehaviour('reorder-agent', parts as never), String(parts)).toMatchObject({ ok: false, code: 'bad_shape' });
    for (const kind of ['nobody', '', 'constructor', undefined, 7]) expect(buildBehaviour(kind as unknown as 'reorder-agent', PARTS['reorder-agent']), String(kind)).toMatchObject({ ok: false, code: 'bad_shape' });
  });

  it('refuses a file with a placeholder, and takes it for a template', () => {
    const placeholders = { ...PARTS['order-desk'], lots: TEMPLATE_FILES.lots };
    expect(buildBehaviour('order-desk', placeholders)).toMatchObject({ ok: false, code: 'bad_shape' });
    expect(buildBehaviour('order-desk', placeholders, { template: false })).toMatchObject({ ok: false, code: 'bad_shape' });
    expect(unwrap(buildBehaviour('order-desk', placeholders, { template: true })).lots).toStrictEqual(TEMPLATE_FILES.lots);
    expect(buildBehaviour('order-desk', PARTS['order-desk'], { template: true })).toMatchObject({ ok: true });
  });
});

describe('parseBehaviourAdditions', () => {
  it('takes what buildBehaviour made, and what a buyer reads from the wire: the same bytes after a round trip through JSON', () => {
    for (const kind of AGENT_KINDS) {
      const built = unwrap(buildBehaviour(kind, PARTS[kind]));
      expect(parseBehaviourAdditions(kind, built), kind).toStrictEqual({ ok: true, value: built });
      expect(parseBehaviourAdditions(kind, JSON.parse(JSON.stringify(built))), kind).toStrictEqual({ ok: true, value: built });
    }
  });

  it('refuses the additions of another kind', () => {
    for (const kind of AGENT_KINDS) {
      for (const other of AGENT_KINDS.filter((name) => name !== kind)) {
        expect(parseBehaviourAdditions(kind, unwrap(buildBehaviour(other, PARTS[other]))), `${kind} with ${other}`).toMatchObject({ ok: false, code: 'bad_shape' });
      }
    }
  });

  it('refuses operations that are not both operations in this order', () => {
    const built = unwrap(buildBehaviour('reorder-agent', PARTS['reorder-agent']));
    for (const operations of [['propose'], ['execute'], ['execute', 'propose'], ['propose', 'execute', 'propose'], [], 'propose,execute', null]) {
      expect(parseBehaviourAdditions('reorder-agent', { ...built, operations }), JSON.stringify(operations)).toMatchObject({ ok: false, code: 'bad_shape' });
    }
    expect(parseBehaviourAdditions('reorder-agent', { ...built, operations: ['propose', 'execute'] })).toMatchObject({ ok: true });
  });

  it('refuses operations on a counterparty, and a missing co-sign rule on a buyer-side agent', () => {
    const desk = unwrap(buildBehaviour('order-desk', PARTS['order-desk']));
    expect(parseBehaviourAdditions('order-desk', { operations: ['propose', 'execute'], ...desk })).toMatchObject({ ok: false });
    expect(parseBehaviourAdditions('order-desk', { cosign: buildCosign(), ...desk })).toMatchObject({ ok: false });
    const { cosign: _left, ...noCosign } = unwrap(buildBehaviour('reorder-agent', PARTS['reorder-agent']));
    expect(parseBehaviourAdditions('reorder-agent', noCosign)).toMatchObject({ ok: false });
  });

  it('refuses a co-sign rule that is not the rule of the kit: another route, another rule, and a member that is not allowed', () => {
    const built = unwrap(buildBehaviour('sourcing-agent', PARTS['sourcing-agent']));
    for (const cosign of [{ route: '/cosign', rule: COSIGN_RULE }, { route: COSIGN_ROUTE, rule: 'The agent signs everything.' }, { route: COSIGN_ROUTE }, { route: COSIGN_ROUTE, rule: COSIGN_RULE, allowlist: [] }, null, 'rule']) {
      expect(parseBehaviourAdditions('sourcing-agent', { ...built, cosign }), JSON.stringify(cosign)).toMatchObject({ ok: false, code: 'bad_shape' });
    }
  });

  it('refuses a fault_modes that is not every value of the kind: a value left out, a value of another kind, an invented value', () => {
    const desk = unwrap(buildBehaviour('order-desk', PARTS['order-desk']));
    for (const fault_modes of [[], ['invert_scores'], ['confirm_wrong_lot', 'invert_scores'], ['confirm_wrong_lot', 'confirm_wrong_lot'], ['anything'], 'confirm_wrong_lot', null]) {
      expect(parseBehaviourAdditions('order-desk', { ...desk, fault_modes }), JSON.stringify(fault_modes)).toMatchObject({ ok: false, code: 'bad_shape' });
    }
    const reorder = unwrap(buildBehaviour('reorder-agent', PARTS['reorder-agent']));
    expect(parseBehaviourAdditions('reorder-agent', { ...reorder, fault_modes: ['confirm_wrong_lot'] })).toMatchObject({ ok: false });
    expect(parseBehaviourAdditions('order-desk', { ...desk, fault_modes: ['confirm_wrong_lot'] })).toMatchObject({ ok: true });
  });

  it('refuses the member fault_mode, the member standing_claim, and a claim with a claim reference', () => {
    const built = unwrap(buildBehaviour('reorder-agent', PARTS['reorder-agent']));
    expect(parseBehaviourAdditions('reorder-agent', { ...built, fault_mode: '' })).toMatchObject({ ok: false });
    expect(parseBehaviourAdditions('reorder-agent', { ...built, standing_claim: { reference: 'ab#0', statements: built.claim.statements } })).toMatchObject({ ok: false });
    expect(parseBehaviourAdditions('reorder-agent', { ...built, claim: { ...built.claim, reference: 'ab#0' } })).toMatchObject({ ok: false });
    expect(parseBehaviourAdditions('reorder-agent', built)).toMatchObject({ ok: true });
  });

  it('refuses a value that is not an object, and a kind that is not a kind of agent', () => {
    for (const value of [null, undefined, [], 'x', 3]) expect(parseBehaviourAdditions('reorder-agent', value), String(value)).toMatchObject({ ok: false, code: 'bad_shape' });
    expect(parseBehaviourAdditions('nobody' as never, unwrap(buildBehaviour('reorder-agent', PARTS['reorder-agent'])))).toMatchObject({ ok: false, code: 'bad_shape' });
  });

  it('takes the members that the kit adds, and lists them', () => {
    expect([...ADDITION_MEMBERS].sort()).toStrictEqual(['claim', 'cosign', 'fault_modes', 'lots', 'model', 'operations', 'price_list', 'relying_on']);
  });
});

describe('the co-sign rule', () => {
  it('names the route, and states the rule in the words of the manifest', () => {
    expect(buildCosign()).toStrictEqual({ route: '/cosign/delegate', rule: COSIGN_RULE });
    expect(COSIGN_RULE).toContain('Delegate transaction');
    expect(COSIGN_RULE).toContain('free delegation keys');
    expect(COSIGN_RULE).toContain('spends nothing');
    expect(COSIGN_RULE).toContain('allowlist that the operator sets');
  });

  it('gives a new object on each call', () => {
    expect(buildCosign()).not.toBe(buildCosign());
  });
});

describe('buildFaultModes', () => {
  it('gives every value of the kind as a new array', () => {
    for (const kind of AGENT_KINDS) expect(buildFaultModes(kind), kind).toStrictEqual([...FAULT_MODES[kind]]);
    expect(buildFaultModes('order-desk')).not.toBe(buildFaultModes('order-desk'));
    Array.prototype.push.call(buildFaultModes('order-desk'), 'x');
    expect(buildFaultModes('order-desk')).toStrictEqual(['confirm_wrong_lot']);
  });

  it('throws for a kind that is not a kind of agent', () => {
    for (const kind of ['nobody', '', 'constructor', undefined]) expect(() => buildFaultModes(kind as never), String(kind)).toThrow(TypeError);
  });
});

describe('the fault sentence of the gaps', () => {
  it('is one sentence for a kind with a fault value: the value, what it does, and where the active value shows', () => {
    expect(faultGap('order-desk')).toBe(
      'This service has a fault switch for failure runs with these possible values: confirm_wrong_lot (the confirmation names another lot and quantity than the purchase order, and the order that it places has the wrong lot); this manifest is the same for every value, so only the field fault_mode of each result shows which value is active.',
    );
  });

  it('is null for a kind with no fault value, because it has no switch', () => {
    expect(faultGap('reorder-agent')).toBeNull();
    expect(faultGap('insurer-intake-agent')).toBeNull();
  });

  it('names the value of its own kind and no value of another kind, and each sentence has one full stop at its end', () => {
    const values = Object.values(FAULT_MODES).flat();
    for (const kind of AGENT_KINDS.filter((name) => FAULT_MODES[name].length > 0)) {
      const sentence = faultGap(kind) ?? '';
      for (const value of values) expect(sentence.includes(value), `${kind} ${value}`).toBe((FAULT_MODES[kind] as readonly string[]).includes(value));
      expect(sentence.endsWith('.')).toBe(true);
      expect(sentence.match(/\./g)).toHaveLength(1);
    }
  });

  it('has a different sentence for each kind that has a fault value', () => {
    const sentences = AGENT_KINDS.map((kind) => faultGap(kind)).filter((sentence) => sentence !== null);
    expect(sentences).toHaveLength(4);
    expect(new Set(sentences).size).toBe(4);
  });

  it('has the words for each fault value, and for no other name', () => {
    expect(Object.keys(FAULT_EFFECTS).sort()).toStrictEqual(Object.values(FAULT_MODES).flat().sort());
  });

  it('is put at the end of the gaps of an agent whose kind has a fault value, and the gaps stay as they are for other kinds', () => {
    const gaps = ['The first gap.', 'The second gap.'];
    expect(withFaultGap('bid-desk', gaps)).toStrictEqual([...gaps, faultGap('bid-desk')]);
    expect(withFaultGap('reorder-agent', gaps)).toStrictEqual(gaps);
    expect(withFaultGap('bid-desk', gaps)).not.toBe(gaps);
    expect(withFaultGap('reorder-agent', gaps)).not.toBe(gaps);
    expect(gaps).toStrictEqual(['The first gap.', 'The second gap.']);
  });

  it('throws for a kind that is not a kind of agent', () => {
    expect(() => faultGap('nobody' as never)).toThrow(TypeError);
    expect(() => withFaultGap('nobody' as never, [])).toThrow(TypeError);
  });
});

describe('the types', () => {
  it('give each kind the additions type of that kind', () => {
    expectTypeOf(unwrap(buildBehaviour('order-desk', PARTS['order-desk']))).toEqualTypeOf<BehaviourAdditions<'order-desk'>>();
    expectTypeOf(unwrap(buildBehaviour('reorder-agent', PARTS['reorder-agent']))).toEqualTypeOf<BehaviourAdditions<'reorder-agent'>>();
    expectTypeOf(buildFaultModes('bid-desk')).toEqualTypeOf<readonly 'quote_off_price_list'[]>();
    expectTypeOf(buildFaultModes('reorder-agent')).toEqualTypeOf<readonly never[]>();
  });
});
