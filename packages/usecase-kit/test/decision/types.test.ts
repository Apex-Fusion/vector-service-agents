// packages/usecase-kit/test/decision/types.test.ts: what the types of the decision folder say. A limit that is not written does not compile. The parser of a decision returns the parsed value or a
// refusal. A failure holds no decision. `pnpm typecheck` checks the lines that carry @ts-expect-error: each of them must fail to compile, so a type that lets one through fails the typecheck.
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { ModelRequest, PayingKey } from '@vsa/hire-kit';
import { ERROR_STATUS, accepted } from '@vsa/usecase-kit/protocol';
import type { Decision, ErrorCode, JsonValue, ProtocolResult, ReceiptVerification } from '@vsa/usecase-kit/protocol';
import { DECISION_FAILURE_CODES, decide } from '@vsa/usecase-kit/decision';
import type {
  ChoiceParser, DecideResult, DecisionDeps, DecisionFailure, DecisionFailureCode, DecisionSpec, ModelLimits, PaidDelivery, TypedDecision, UnrecordedDelivery,
} from '@vsa/usecase-kit/decision';
import { REORDER } from './support.ts';
import type { ReorderChoice } from './support.ts';

describe('the limits', () => {
  it('have the types that hire-kit gives them: a bigint for the price and a bigint or null for each bond', () => {
    expectTypeOf<ModelLimits['allowlist']>().toEqualTypeOf<ModelRequest['allowlist']>();
    expectTypeOf<ModelLimits['maxPriceLovelace']>().toEqualTypeOf<ModelRequest['maxPriceLovelace']>();
    expectTypeOf<ModelLimits['maxSupplierBondLovelace']>().toEqualTypeOf<ModelRequest['maxSupplierBondLovelace']>();
    expectTypeOf<ModelLimits['maxBuyerBondLovelace']>().toEqualTypeOf<ModelRequest['maxBuyerBondLovelace']>();
    expectTypeOf<ModelLimits['maxPriceLovelace']>().toEqualTypeOf<bigint>();
    expectTypeOf<ModelLimits['maxSupplierBondLovelace']>().toEqualTypeOf<bigint | null>();
  });

  it('are all required: a limit that is not written does not compile, and null is the way to say that a bond has no limit', () => {
    // @ts-expect-error: the allowlist is required
    const noList: ModelLimits = { maxPriceLovelace: 1n, maxSupplierBondLovelace: null, maxBuyerBondLovelace: null };
    // @ts-expect-error: the price ceiling is required
    const noPrice: ModelLimits = { allowlist: ['a/b'], maxSupplierBondLovelace: null, maxBuyerBondLovelace: null };
    // @ts-expect-error: the limit of the supplier bond is required
    const noSupplierBond: ModelLimits = { allowlist: ['a/b'], maxPriceLovelace: 1n, maxBuyerBondLovelace: null };
    // @ts-expect-error: the limit of the buyer bond is required
    const noBuyerBond: ModelLimits = { allowlist: ['a/b'], maxPriceLovelace: 1n, maxSupplierBondLovelace: null };
    // @ts-expect-error: the price ceiling takes no null
    const nullPrice: ModelLimits = { allowlist: ['a/b'], maxPriceLovelace: null, maxSupplierBondLovelace: null, maxBuyerBondLovelace: null };
    // @ts-expect-error: a number is not a limit
    const numberBond: ModelLimits = { allowlist: ['a/b'], maxPriceLovelace: 1n, maxSupplierBondLovelace: 5, maxBuyerBondLovelace: null };
    // @ts-expect-error: a text is not a limit
    const textPrice: ModelLimits = { allowlist: ['a/b'], maxPriceLovelace: '1', maxSupplierBondLovelace: null, maxBuyerBondLovelace: null };
    const complete: ModelLimits = { allowlist: ['a/b'], maxPriceLovelace: 1n, maxSupplierBondLovelace: null, maxBuyerBondLovelace: 5n };
    expect([noList, noPrice, noSupplierBond, noBuyerBond, nullPrice, numberBond, textPrice, complete]).toHaveLength(8);
  });

  it('are a required part of the deps of a decision', () => {
    function compileOnly(without: Omit<DecisionDeps, 'limits'>, full: DecisionDeps): void {
      // @ts-expect-error: decide needs the limits in its deps
      void decide(without, REORDER, {});
      void decide(full, REORDER, {});
    }
    expect(typeof compileOnly).toBe('function');
    expectTypeOf<DecisionDeps['key']>().toEqualTypeOf<PayingKey>();
    expectTypeOf<DecisionDeps['limits']>().toEqualTypeOf<ModelLimits>();
  });
});

describe('the parser of a decision', () => {
  it('returns the parsed value or a refusal, and nothing else', () => {
    expectTypeOf<ChoiceParser<ReorderChoice>>().toEqualTypeOf<(given: JsonValue) => ProtocolResult<ReorderChoice>>();
    // @ts-expect-error: a parser does not return a bare value
    const bare: ChoiceParser<ReorderChoice> = (given) => given as ReorderChoice;
    // @ts-expect-error: a parser that returns a value of another type does not compile
    const wrongType: ChoiceParser<ReorderChoice> = () => accepted({ lot: 'lot-small' });
    expect([bare, wrongType]).toHaveLength(2);
  });

  it('is a part of the definition of a decision, with its name and its instruction', () => {
    // @ts-expect-error: a decision needs a parser
    const noParser: DecisionSpec = { name: 'reorder', instruction: 'text' };
    // @ts-expect-error: a decision needs an instruction
    const noInstruction: DecisionSpec = { name: 'reorder', parse: (given) => accepted(given) };
    expect([noParser, noInstruction]).toHaveLength(2);
    expectTypeOf(REORDER).toEqualTypeOf<DecisionSpec<ReorderChoice>>();
  });
});

describe('the result', () => {
  it('has a decision of the protocol with the choice in the type of the parser, or a failure that holds no decision', () => {
    function compileOnly(result: DecideResult<ReorderChoice>): void {
      if (result.ok) {
        expectTypeOf(result.value).toEqualTypeOf<TypedDecision<ReorderChoice>>();
        expectTypeOf(result.value.choice).toEqualTypeOf<ReorderChoice>();
        // It is a Decision of the protocol.
        const decision: Decision = result.value;
        void decision;
      } else {
        expectTypeOf(result).toEqualTypeOf<DecisionFailure>();
        expectTypeOf(result.code).toEqualTypeOf<DecisionFailureCode>();
        expectTypeOf(result.reason).toBeString();
        // @ts-expect-error: a failure holds no decision
        void result.value;
      }
    }
    expect(typeof compileOnly).toBe('function');
  });

  it('has a delivery that is whole or partial: a sub-job that is null says that the receipt is not recorded, and the check of it gives the whole delivery', () => {
    function compileOnly(failure: DecisionFailure): void {
      const { delivery } = failure;
      if (delivery === null) return;
      if (delivery.sub_job !== null) {
        expectTypeOf(delivery).toEqualTypeOf<PaidDelivery>();
      } else {
        expectTypeOf(delivery).toEqualTypeOf<UnrecordedDelivery>();
        expectTypeOf(delivery.receipt).toEqualTypeOf<'not_recordable'>();
        expectTypeOf(delivery.escrow_ref).toEqualTypeOf<string | null>();
        expectTypeOf(delivery.verification).toEqualTypeOf<ReceiptVerification | null>();
      }
    }
    expect(typeof compileOnly).toBe('function');
  });

  it('has only codes of the protocol, so that ERROR_STATUS gives the status of each', () => {
    expectTypeOf<DecisionFailureCode>().toExtend<ErrorCode>();
    expect(DECISION_FAILURE_CODES.map((code) => ERROR_STATUS[code])).toStrictEqual([502, 500, 502, 500]);
  });
});
