// agents/sourcing-agent/src/scoring/index.ts
// The scorers of the Sourcing Agent (use case 3, supplier bid evaluation): one scorer for each accepted quote, with a sub-delegation of `vendor.read` from the live delegation key of the agent, the read of the vendor
// master, and the decision `score` through a port. The fault `invert_scores` reverses the score of the first scorer. Every source of data comes in through a port: this folder reads no environment variable and
// no key, and it does not import the folders of the other jobs (`model`, `quotes`, `bidders`, `propose`, `execute` and `serve`).
//
//   scoring   `runScoring`, the time rule of a scorer and the codes of a failed scoring (src/scoring.ts)
//   ports     `ScoringDeps`, the input and the result, and the plain shape of the file of a bidder (src/ports.ts)
//   vendors   the strict parser of the vendor list, and the entry of a bidder (src/vendors.ts)
//   fault     the fault `invert_scores`: the first scorer returns its scores as 100 minus each, reversed on the decimal text (src/fault.ts, used by the scoring only)
export { END_TIMEOUT_MS, MIN_CONFIRMATION_WAIT_MS, SCORER_JOB_TIMEOUT_MS, SCORER_NEED_MS, SCORERS_NEED_MS, SCORING_FAILURES, SUB_DELEGATION_VALID_MS, runScoring } from './scoring.ts';
export type {
  BidderFile, BidderLineage, BidderStatus, ComplianceFact, FactState, InFlight, LeftEntry, LeftSink, ScoreAnswer, ScoreChoice, ScoreRequest, ScoreSubject, ScoredQuote, Scorer, ScoringDeps, ScoringInput,
  ScoringResult,
} from './ports.ts';
export { parseVendors, vendorFor } from './vendors.ts';
export type { VendorEntry } from './vendors.ts';
