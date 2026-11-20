// packages/usecase-kit/test/protocol/manifest.test.ts: the additions to the `behaviour` of an agent manifest, as types. The typecheck is the test: a line that must not compile carries a
// `@ts-expect-error`, and the typecheck fails when such a line compiles. Each wrong shape has a right twin above it.
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { AgentKind, BehaviourAdditions, ClaimStatement, ManifestClaim, ManifestCosign, ManifestFileRef, ManifestModel, ManifestRelyingOn } from '@vsa/usecase-kit/protocol';

const claim = {
  statements: [
    { id: 'S1', text: 'An order this agent places is the purchase order whose digest its hirer approved.' },
    { id: 'S2', text: 'This agent accepts only a confirmation that names the SKU and the lot of the purchase order it answers.' },
    { id: 'S3', text: 'This agent pays a supplier only from the vault of the delegation it was given.' },
  ],
} as const satisfies ManifestClaim;

const model = { allowlist: ['deepseek/deepseek-v4-flash'], max_price_lovelace: 200_000 } as const satisfies ManifestModel;
const relyingOn = { mock_systems: ['GET /erp/stock/{sku}', 'POST /po'], gateway_routes: ['POST /token'] } as const satisfies ManifestRelyingOn;
const cosign = { route: '/cosign/delegate', rule: 'The agent signs only a Delegate transaction that names it.' } as const satisfies ManifestCosign;
const file = { uri: 'https://example.invalid/lots.json', sha256: 'ab'.repeat(32) } as const satisfies ManifestFileRef;

describe('the additions to the behaviour of a manifest', () => {
  it('fit a buyer-side agent: both operations, the co-sign rule, and no fault value for an agent that has none', () => {
    const reorder = { operations: ['propose', 'execute'], claim, cosign, fault_modes: [], model, relying_on: relyingOn } as const satisfies BehaviourAdditions<'reorder-agent'>;
    const sourcing = { operations: ['propose', 'execute'], claim, cosign, fault_modes: ['invert_scores'], model, relying_on: relyingOn } as const satisfies BehaviourAdditions<'sourcing-agent'>;
    expect(reorder.operations).toStrictEqual(['propose', 'execute']);
    expect(sourcing.fault_modes).toStrictEqual(['invert_scores']);
  });

  it('fit an order desk: the lots file, and its fault value', () => {
    const orderDesk = { claim, fault_modes: ['confirm_wrong_lot'], model, relying_on: relyingOn, lots: file } as const satisfies BehaviourAdditions<'order-desk'>;
    expect(orderDesk.lots.uri).toBe(file.uri);
  });

  it('fit a bid desk: the price list, and its fault value', () => {
    const bidDesk = { claim, fault_modes: ['quote_off_price_list'], model, relying_on: relyingOn, price_list: file } as const satisfies BehaviourAdditions<'bid-desk'>;
    expect(bidDesk.price_list.sha256).toBe(file.sha256);
  });

  it('fit an insurer intake agent: nothing more than the common members', () => {
    const insurer = { claim, fault_modes: [], model, relying_on: relyingOn } as const satisfies BehaviourAdditions<'insurer-intake-agent'>;
    expect(insurer.fault_modes).toStrictEqual([]);
  });

  it('fit each kind with the type of that kind, and the type with no kind is one of them', () => {
    expectTypeOf<BehaviourAdditions<'order-desk'>>().toExtend<BehaviourAdditions>();
    expectTypeOf<BehaviourAdditions<'sourcing-agent'>>().toExtend<BehaviourAdditions<AgentKind>>();
    expectTypeOf<BehaviourAdditions<'reorder-agent'>['operations']>().toEqualTypeOf<readonly ['propose', 'execute']>();
    expectTypeOf<BehaviourAdditions<'order-desk'>['operations']>().toEqualTypeOf<undefined>();
    expectTypeOf<ClaimStatement<'S2'>['id']>().toEqualTypeOf<'S2'>();
  });

  it('refuse a shape that the manifest does not have', () => {
    // @ts-expect-error a buyer-side agent states the co-sign rule
    const noCosign: BehaviourAdditions<'reorder-agent'> = { operations: ['propose', 'execute'], claim, fault_modes: [], model, relying_on: relyingOn };
    // @ts-expect-error a buyer-side agent states both operations
    const oneOperation: BehaviourAdditions<'reorder-agent'> = { operations: ['propose'], claim, cosign, fault_modes: [], model, relying_on: relyingOn };
    // @ts-expect-error a counterparty has no operations
    const operations: BehaviourAdditions<'order-desk'> = { operations: ['propose', 'execute'], claim, fault_modes: [], model, relying_on: relyingOn, lots: file };
    // @ts-expect-error a counterparty has no co-sign rule
    const counterpartyCosign: BehaviourAdditions<'bid-desk'> = { claim, cosign, fault_modes: [], model, relying_on: relyingOn, price_list: file };
    // @ts-expect-error an order desk states its lots file
    const noLots: BehaviourAdditions<'order-desk'> = { claim, fault_modes: [], model, relying_on: relyingOn };
    // @ts-expect-error a bid desk states its price list
    const noPrices: BehaviourAdditions<'bid-desk'> = { claim, fault_modes: [], model, relying_on: relyingOn };
    // @ts-expect-error the lots file belongs to the order desk
    const wrongFile: BehaviourAdditions<'insurer-intake-agent'> = { claim, fault_modes: [], model, relying_on: relyingOn, lots: file };
    // @ts-expect-error a fault value of another kind
    const wrongFault: BehaviourAdditions<'order-desk'> = { claim, fault_modes: ['invert_scores'], model, relying_on: relyingOn, lots: file };
    // @ts-expect-error an agent with no fault value lists none
    const invented: BehaviourAdditions<'reorder-agent'> = { operations: ['propose', 'execute'], claim, cosign, fault_modes: ['anything'], model, relying_on: relyingOn };
    // @ts-expect-error the claim is part of every manifest
    const noClaim: BehaviourAdditions<'insurer-intake-agent'> = { fault_modes: [], model, relying_on: relyingOn };
    // @ts-expect-error a claim has exactly three statements
    const shortClaim: ManifestClaim = { statements: [claim.statements[0], claim.statements[1]] };
    // @ts-expect-error the statements keep the order S1, S2, S3
    const wrongOrder: ManifestClaim = { statements: [claim.statements[1], claim.statements[0], claim.statements[2]] };
    // @ts-expect-error the claim has no claim reference: the claim is made for each run
    const withReference: ManifestClaim = { statements: claim.statements, reference: 'ab#0' };
    // @ts-expect-error the ceiling is a number
    const textCeiling: ManifestModel = { allowlist: ['m'], max_price_lovelace: '200000' };
    expect([noCosign, oneOperation, operations, counterpartyCosign, noLots, noPrices, wrongFile, wrongFault, invented, noClaim, shortClaim, wrongOrder, withReference, textCeiling]).toHaveLength(14);
  });
});
