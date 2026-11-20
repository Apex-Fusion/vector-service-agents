// packages/usecase-kit/test/protocol/behaviour-union.test.ts: `BehaviourAdditions` with no kind is the additions of ONE of the six kinds, a union over the kinds, and never a mix. The typecheck is the
// test: a line that must not compile carries a `@ts-expect-error`, and the typecheck fails when such a line compiles. Each wrong object has right twins above it.
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { BehaviourAdditions, ManifestClaim, ManifestCosign, ManifestFileRef, ManifestModel, ManifestRelyingOn } from '@vsa/usecase-kit/protocol';

const claim = {
  statements: [{ id: 'S1', text: 'The first statement.' }, { id: 'S2', text: 'The second statement.' }, { id: 'S3', text: 'The third statement.' }],
} as const satisfies ManifestClaim;
const model = { allowlist: ['deepseek/deepseek-v4-flash'], max_price_lovelace: 200_000 } as const satisfies ManifestModel;
const relying_on = { mock_systems: ['GET /erp/stock/{sku}'], gateway_routes: ['POST /token'] } as const satisfies ManifestRelyingOn;
const cosign = { route: '/cosign/delegate', rule: 'The agent signs only a Delegate transaction that names it.' } as const satisfies ManifestCosign;
const file = { uri: 'https://example.invalid/file.json', sha256: 'ab'.repeat(32) } as const satisfies ManifestFileRef;
const operations = ['propose', 'execute'] as const;

describe('BehaviourAdditions with no kind', () => {
  it('takes the additions of each one of the six kinds', () => {
    const reorder: BehaviourAdditions = { operations, claim, cosign, fault_modes: [], model, relying_on };
    const prior: BehaviourAdditions = { operations, claim, cosign, fault_modes: ['alter_after_approval'], model, relying_on };
    const sourcing: BehaviourAdditions = { operations, claim, cosign, fault_modes: ['invert_scores'], model, relying_on };
    const orderDesk: BehaviourAdditions = { claim, fault_modes: ['confirm_wrong_lot'], model, relying_on, lots: file };
    const insurer: BehaviourAdditions = { claim, fault_modes: [], model, relying_on };
    const bidDesk: BehaviourAdditions = { claim, fault_modes: ['quote_off_price_list'], model, relying_on, price_list: file };
    expect([reorder, prior, sourcing, orderDesk, insurer, bidDesk]).toHaveLength(6);
  });

  it('refuses one object that mixes the members or the fault values of two kinds', () => {
    // @ts-expect-error operations belong to a buyer-side agent and lots belong to the order desk
    const operationsAndLots: BehaviourAdditions = { operations, claim, cosign, fault_modes: [], model, relying_on, lots: file };
    // @ts-expect-error lots belong to the order desk and the price list belongs to the bid desk
    const lotsAndPrices: BehaviourAdditions = { claim, fault_modes: [], model, relying_on, lots: file, price_list: file };
    // @ts-expect-error the fault values of the order desk and of the bid desk
    const twoFaults: BehaviourAdditions = { claim, fault_modes: ['confirm_wrong_lot', 'quote_off_price_list'], model, relying_on, lots: file };
    // @ts-expect-error the insurer intake agent has no fault value, and confirm_wrong_lot is a value of the order desk that needs its lots file
    const faultWithoutLots: BehaviourAdditions = { claim, fault_modes: ['confirm_wrong_lot'], model, relying_on };
    // @ts-expect-error a buyer-side agent with the fault value of a counterparty
    const buyerWithCounterpartyFault: BehaviourAdditions = { operations, claim, cosign, fault_modes: ['confirm_wrong_lot'], model, relying_on };
    // @ts-expect-error a buyer-side agent with the fault values of two buyer-side agents
    const twoBuyerFaults: BehaviourAdditions = { operations, claim, cosign, fault_modes: ['alter_after_approval', 'invert_scores'], model, relying_on };
    // @ts-expect-error every member of every kind in one object
    const everything: BehaviourAdditions = { operations, claim, cosign, fault_modes: ['alter_after_approval', 'invert_scores', 'confirm_wrong_lot', 'quote_off_price_list'], model, relying_on, lots: file, price_list: file };
    // @ts-expect-error a counterparty with the co-sign rule of a buyer-side agent
    const counterpartyCosign: BehaviourAdditions = { claim, cosign, fault_modes: [], model, relying_on };
    expect([operationsAndLots, lotsAndPrices, twoFaults, faultWithoutLots, buyerWithCounterpartyFault, twoBuyerFaults, everything, counterpartyCosign]).toHaveLength(8);
  });

  it('is the union of the six kinds, and each kind is one member of it', () => {
    type Six =
      | BehaviourAdditions<'reorder-agent'>
      | BehaviourAdditions<'prior-authorization-agent'>
      | BehaviourAdditions<'sourcing-agent'>
      | BehaviourAdditions<'order-desk'>
      | BehaviourAdditions<'insurer-intake-agent'>
      | BehaviourAdditions<'bid-desk'>;
    expectTypeOf<BehaviourAdditions>().toEqualTypeOf<Six>();
    expectTypeOf<BehaviourAdditions<'order-desk'>>().toExtend<BehaviourAdditions>();
    expectTypeOf<BehaviourAdditions<'bid-desk'>['price_list']>().toEqualTypeOf<ManifestFileRef>();
    expectTypeOf<BehaviourAdditions<'insurer-intake-agent'>['fault_modes']>().toEqualTypeOf<readonly never[]>();
  });
});
