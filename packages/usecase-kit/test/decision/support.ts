// packages/usecase-kit/test/decision/support.ts
// What the tests of the decision folder share. The marketplace is the in-memory one of hire-kit: a FakeChain, an indexer and a model supplier behind one fetch, and a clock that the tests move
// with the sleep of the hire. A test never waits for real time and never uses the network. The decisions at the end are examples. Their prompts and their shapes follow the pages of the agents, and
// each parser checks the shape only: it returns the value that it was given.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PayingKeys } from '@vsa/hire-kit';
import type { HireLedger, PayingKey } from '@vsa/hire-kit';
import { ALLOWLIST, INDEXER, LLM_ADVERT, T0, chainWith, marketplace } from '@vsa/hire-kit/testing';
import type { Marketplace } from '@vsa/hire-kit/testing';
import { accepted, checkMembers, isPlainObject, refused } from '@vsa/usecase-kit/protocol';
import type { JsonValue } from '@vsa/usecase-kit/protocol';
import { buildPrompt } from '@vsa/usecase-kit/decision';
import type { ChoiceParser, DecideResult, DecisionDeps, DecisionFailure, DecisionSpec, ModelLimits, TypedDecision } from '@vsa/usecase-kit/decision';

/** The limits that fit the model advert of the stub marketplace exactly: each is AT the value of the advert, so the advert passes, and one lovelace less would refuse it. */
export const LIMITS: ModelLimits = {
  allowlist: ALLOWLIST,
  maxPriceLovelace: LLM_ADVERT.price_lovelace,
  maxSupplierBondLovelace: LLM_ADVERT.supplier_bond_lovelace,
  maxBuyerBondLovelace: LLM_ADVERT.buyer_bond_lovelace,
};

const dirs: string[] = [];
/** Removes the state directories of the paying keys. Each test file calls it in `afterEach`. */
export function cleanup(): void {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}

/** A promise that the test settles by hand. (Promise.withResolvers is not in the types of the target of this package.) */
export function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

export interface Run {
  m: Marketplace;
  key: PayingKey;
  deps: DecisionDeps;
  /** The lock and the fee of each Post that the ledger booked. */
  booked: Array<{ lockLovelace: bigint; feeLovelace: bigint }>;
}

/** A marketplace and the paying key of its chain (the chain `wrap` replaces methods of, when a test needs to see or to hold its calls), and the deps of a decision. */
export async function setup(opts: Parameters<typeof marketplace>[0] = {}, wrap?: (m: Marketplace) => Parameters<typeof chainWith>[1], limits: ModelLimits = LIMITS): Promise<Run> {
  const m = marketplace(opts);
  const dir = mkdtempSync(join(tmpdir(), 'usecase-kit-decision-'));
  dirs.push(dir);
  const key = await new PayingKeys(dir).add(wrap === undefined ? m.chain : chainWith(m, wrap(m)));
  const booked: Run['booked'] = [];
  const ledger: HireLedger = { posted: (post) => { booked.push({ lockLovelace: post.lockLovelace, feeLovelace: post.feeLovelace }); }, accepted: () => undefined };
  const deps: DecisionDeps = { key, limits, clock: () => m.clock.now, sleep: async (ms) => { m.clock.now += ms; }, deadlineMs: T0 + 1_000_000, fetchImpl: m.fetchImpl, indexerUrl: INDEXER, ledger };
  return { m, key, deps, booked };
}

/** The text that a model gives: one JSON object with the reasoning and the choice. */
export const said = (choice: unknown, reasoning = 'The data supports this choice.'): string => JSON.stringify({ reasoning, choice });

/** The decision of a result that was recorded. The test fails, and says why, when the result is a failure. */
export function won<C extends JsonValue>(result: DecideResult<C>): TypedDecision<C> {
  if (!result.ok) throw new Error(`the decision failed with ${result.code} (${result.reason}): ${result.detail}`);
  return result.value;
}

/** The failure of a result that was not recorded. The test fails when a decision was recorded. */
export function lost<C extends JsonValue>(result: DecideResult<C>): DecisionFailure {
  if (result.ok) throw new Error('a decision was recorded, and it must not be');
  return result;
}

/** The prompt that `decide` sends for a decision and its input. */
export function promptOf(spec: DecisionSpec<JsonValue>, input: JsonValue): string {
  const prompt = buildPrompt(spec, input);
  if (!prompt.ok) throw new Error(prompt.detail);
  return prompt.value;
}

/** The prompts that the model supplier received, in order. A hire sends `{ input }` and nothing else. */
export function promptsSent(run: Run): string[] {
  return run.m.llm.sends.map((send) => {
    const body: { input: string } = JSON.parse(send.body);
    return body.input;
  });
}

// --- The example decisions --------------------------------------------------------------------------------------------------------

type Members = Record<string, unknown>;
const refuse = (detail: string) => refused('bad_shape', detail);
const isDate = (value: unknown): boolean => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);

/** Use case 1 (inventory reorder), decision `reorder`: the model is given the stock reading and the lots, and chooses a lot. */
export type ReorderChoice = { lot: 'lot-small' | 'lot-medium' | 'lot-large'; quantity: number; needed_by: string };
export const parseReorder: ChoiceParser<ReorderChoice> = (given) => {
  if (!isPlainObject(given)) return refuse('choice must be a JSON object');
  const members = checkMembers(given, 'choice', ['lot', 'quantity', 'needed_by']);
  if (members !== null) return members;
  const { lot, quantity, needed_by: neededBy } = given;
  if (lot !== 'lot-small' && lot !== 'lot-medium' && lot !== 'lot-large') return refuse('choice.lot must name one of the three lots');
  // The shape asks for a whole number of at least 0. It does not ask for the size of the lot: that is not a question of shape.
  if (typeof quantity !== 'number' || !Number.isSafeInteger(quantity) || quantity < 0) return refuse('choice.quantity must be a whole number of at least 0');
  if (!isDate(neededBy)) return refuse('choice.needed_by must be a date, YYYY-MM-DD');
  return accepted(given as ReorderChoice);
};
export const REORDER: DecisionSpec<ReorderChoice> = {
  name: 'reorder',
  instruction: 'You decide how much stock to reorder. The data gives the stock reading of one SKU and the lots that the supplier sells. Choose one lot. '
    + '"choice" has the members "lot" (the name of the lot), "quantity" (a whole number: the size of that lot) and "needed_by" (a date, YYYY-MM-DD).',
  parse: parseReorder,
};
export const STOCK_INPUT = {
  stock: { sku: 'SKU-100', on_hand: 12, threshold: 20, daily_usage: 4, lead_time_days: 7, open_orders: 0 },
  lots: [{ lot: 'lot-small', size: 10 }, { lot: 'lot-medium', size: 50 }, { lot: 'lot-large', size: 200 }],
};
export const MEDIUM_LOT: ReorderChoice = { lot: 'lot-medium', quantity: 50, needed_by: '2026-12-01' };

/** Use case 1 and use case 2, decision `accept_delivery`: the model is given the request and the delivery, and says whether to accept. */
export type AcceptChoice = { accept: boolean; mismatch: string[] };
export const parseAccept: ChoiceParser<AcceptChoice> = (given) => {
  if (!isPlainObject(given)) return refuse('choice must be a JSON object');
  const members = checkMembers(given, 'choice', ['accept', 'mismatch']);
  if (members !== null) return members;
  if (typeof given.accept !== 'boolean') return refuse('choice.accept must be true or false');
  if (!Array.isArray(given.mismatch) || given.mismatch.some((field: unknown) => typeof field !== 'string')) return refuse('choice.mismatch must be a list of texts');
  return accepted(given as AcceptChoice);
};
export const ACCEPT_DELIVERY: DecisionSpec<AcceptChoice> = {
  name: 'accept_delivery',
  instruction: 'You decide whether to accept a delivery. The data gives the purchase order and the confirmation of the supplier. '
    + 'Compare them. "choice" has the members "accept" (true or false) and "mismatch" (the names of the fields that differ).',
  parse: parseAccept,
};
export const DELIVERY_INPUT = {
  purchase_order: { po_number: 'run1-0001', sku: 'SKU-100', lot: 'lot-medium', quantity: 50 },
  confirmation: { po_number: 'run1-0001', sku: 'SKU-100', lot: 'lot-medium', quantity: 50, ship_by: '2026-11-28' },
};

/** Use case 3 (supplier bid evaluation), decision `score`: the model scores one quote. The prompt asks for each number from 0 to 100, and this shape asks only for a finite number. */
export type ScoreChoice = { components: { price: number; lead_time: number; reliability: number; compliance: number }; score: number };
const COMPONENTS = ['price', 'lead_time', 'reliability', 'compliance'] as const;
function scoreParser(range: { min: number; max: number } | null): ChoiceParser<ScoreChoice> {
  const fits = (value: unknown): boolean => typeof value === 'number' && Number.isFinite(value) && (range === null || (value >= range.min && value <= range.max));
  return (given) => {
    if (!isPlainObject(given)) return refuse('choice must be a JSON object');
    const members = checkMembers(given, 'choice', ['components', 'score']);
    if (members !== null) return members;
    if (!isPlainObject(given.components)) return refuse('choice.components must be a JSON object');
    const parts = checkMembers(given.components as Members, 'choice.components', [...COMPONENTS]);
    if (parts !== null) return parts;
    for (const name of COMPONENTS) if (!fits((given.components as Members)[name])) return refuse(`choice.components.${name} is not a number that the shape takes`);
    if (!fits(given.score)) return refuse('choice.score is not a number that the shape takes');
    return accepted(given as ScoreChoice);
  };
}
const SCORE_INSTRUCTION = 'You score one quote. The data gives the quote, the vendor entry, the file of the bidder and the weights. '
  + '"choice" has the members "components" (price, lead_time, reliability and compliance, each a number from 0 to 100) and "score" (a number from 0 to 100).';
/** The shape asks for finite numbers and names no range. */
export const SCORE: DecisionSpec<ScoreChoice> = { name: 'score', instruction: SCORE_INSTRUCTION, parse: scoreParser(null) };
/** The shape names the range 0 to 100. */
export const SCORE_IN_RANGE: DecisionSpec<ScoreChoice> = { name: 'score', instruction: SCORE_INSTRUCTION, parse: scoreParser({ min: 0, max: 100 }) };
export const SCORE_INPUT = {
  quote: { bidder: 'bidder-a', total: 4200, lead_time_days: 14 },
  vendor: { name: 'Vendor A', on_time: 0.97 },
  weights: { price: 0.4, lead_time: 0.2, reliability: 0.2, compliance: 0.2 },
};
export const GOOD_SCORE: ScoreChoice = { components: { price: 80, lead_time: 70, reliability: 90, compliance: 100 }, score: 84 };

/** A counterparty decision, `availability` of the Order Desk: the model is given the purchase order and the catalogue entry, and confirms the order or not. */
export type AvailabilityChoice = { confirm: boolean; ship_by: string; note: string };
export const AVAILABILITY: DecisionSpec<AvailabilityChoice> = {
  name: 'availability',
  instruction: 'You decide whether a lot can be supplied. The data gives the purchase order and the catalogue entry. '
    + '"choice" has the members "confirm" (true or false), "ship_by" (a date, YYYY-MM-DD) and "note" (a text).',
  parse: (given) => {
    if (!isPlainObject(given)) return refuse('choice must be a JSON object');
    const members = checkMembers(given, 'choice', ['confirm', 'ship_by', 'note']);
    if (members !== null) return members;
    if (typeof given.confirm !== 'boolean') return refuse('choice.confirm must be true or false');
    if (!isDate(given.ship_by)) return refuse('choice.ship_by must be a date, YYYY-MM-DD');
    if (typeof given.note !== 'string') return refuse('choice.note must be a text');
    return accepted(given as AvailabilityChoice);
  },
};
export const CATALOGUE_INPUT = { purchase_order: { po_number: 'run1-0001', sku: 'SKU-100', lot: 'lot-medium', quantity: 50 }, catalogue: { sku: 'SKU-100', lots: { 'lot-medium': 50 } } };
