// agents/sourcing-agent/src/model/rank.ts
// The model decision `ranking` of the Sourcing Agent (use case 3, supplier bid evaluation). The model reads the weights and the scores of the bidders whose quotes were accepted, and it chooses their order. The
// rank of a bidder is its position in that order: no code sorts by score, and an order that is not in the order of the scores is an order that the model chose.
//
// The fixed text is code. It holds no text of another party and no mark of the input block. The input is JSON data in one marked block, and the decision folder writes it so that no text in it can close the
// block. What the model reads is the DID of each bidder, numbers and the weights: no free text of a bidder or of a vendor.
//
// A parser checks the SHAPE of a choice and no business rule. It returns the value that it was given, or a refusal: it never clamps, fills in or changes a value. It does not know the scored bidders, so the code that
// uses a choice checks that the order holds each of them one time, and gives its own typed code. A refusal of a parser is `model_output_invalid` in the decision folder.
import type { Components, Weights } from '@vsa/usecase-kit/bids';
import type { ChoiceParser, DecisionSpec } from '@vsa/usecase-kit/decision';
import { accepted, checkMembers, isPlainObject, parseDid, refused } from '@vsa/usecase-kit/protocol';
import type { Did, JsonValue } from '@vsa/usecase-kit/protocol';
import { parseList, parseNote } from './choice.ts';

/** The most bidders in an order: the most that a ranking document and the sourcing record take. */
const MAX_ORDER = 20;
/** The longest tie break, in characters. */
const MAX_TIE_BREAK_CHARS = 300;

/** What the model chooses for `ranking`: the DIDs of the scored bidders from the best to the worst, and how it settled equal scores (the empty text when it settled none). It is a type alias, so that it is JSON data. */
export type RankingChoice = { order: Did[]; tie_break: string };

/** One bidder whose quote was accepted and scored, as the ranking decision reads it. */
export interface ScoredBidder {
  readonly desk_did: Did;
  readonly score: number;
  readonly components: Components;
  /** The total price of its quote. */
  readonly total: number;
  /** The longest lead time of its quote, in days. */
  readonly lead_time_days: number;
}

const RANKING_INSTRUCTION = [
  'You decide the order of the bidders in a ranking.',
  'The data has two members.',
  '"weights" has four numbers that sum to 1: "price", "lead_time", "reliability" and "compliance". They say how much each part counts for the buyer.',
  '"scored" lists the scored bidders. Each entry has "desk_did" (the identifier of the bidder), "score" (the score of its quote, from 0 to 100), "components" (its four component scores, each from 0 to 100), "total" (the total price of its quote) and "lead_time_days" (the longest lead time of its quote).',
  'Put the best bidder first. A higher "score" is better. Use the other values of the entries only to settle bidders whose scores are equal or very near.',
  `"choice" is an object with exactly two members: "order" (a list of the "desk_did" of every entry in "scored", each exactly one time, from the best to the worst) and "tie_break" (a text of at most ${MAX_TIE_BREAK_CHARS} characters that says how you settled equal or near scores; the empty text when you settled none).`,
].join(' ');

const parseRankingChoice: ChoiceParser<RankingChoice> = (given) => {
  if (!isPlainObject(given)) return refused('bad_shape', 'choice must be a JSON object');
  const members = checkMembers(given, 'choice', ['order', 'tie_break']);
  if (members !== null) return members;
  const order = parseList(given.order, 'choice.order', 1, MAX_ORDER, (entry, at) => parseDid(entry, at));
  if (!order.ok) return order;
  const tieBreak = parseNote(given.tie_break, 'choice.tie_break', MAX_TIE_BREAK_CHARS);
  if (!tieBreak.ok) return tieBreak;
  // The members are checked, and the value that the model gave goes back as it is.
  return accepted(given as RankingChoice);
};

/** The decision `ranking`. */
export const RANKING_DECISION: DecisionSpec<RankingChoice> = Object.freeze({ name: 'ranking', instruction: RANKING_INSTRUCTION, parse: parseRankingChoice });

/**
 * The input of `ranking`: the four weights, and for each scored bidder its DID, its score, its four component scores, its total and its lead time, in the order that the caller gives. That is the order of the
 * quotes, and this function does not sort. The members are copied by name, so no other member of an entry reaches the prompt. The input is a copy, so a later change of an entry cannot change it.
 */
export function rankingInput(weights: Weights, scored: readonly ScoredBidder[]): JsonValue {
  return {
    weights: { price: weights.price, lead_time: weights.lead_time, reliability: weights.reliability, compliance: weights.compliance },
    scored: scored.map((entry) => ({
      desk_did: entry.desk_did,
      score: entry.score,
      components: { price: entry.components.price, lead_time: entry.components.lead_time, reliability: entry.components.reliability, compliance: entry.components.compliance },
      total: entry.total,
      lead_time_days: entry.lead_time_days,
    })),
  };
}
