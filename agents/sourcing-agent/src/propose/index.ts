// agents/sourcing-agent/src/propose/index.ts
// The job `propose` of the Sourcing Agent (use case 3, supplier bid evaluation): the authority, the delegation key, the bidders, the model decision `shortlist`, the quote fan-out, the scorers, the model
// decision `ranking`, and the ranking. Every source of data comes in through a port: this folder reads no environment variable and no key, and it does not import the folders of the other parts of the agent
// (`model`, `bidders`, `quotes`, `scoring`, `execute` and `serve`).
//
//   propose   the front steps of the job, the refusal of a request that it cannot serve, the deadline and the two reserves, and the codes of a failed proposal (src/propose.ts)
//   ports     `ProposeDeps` and the shapes that two folders share (src/ports.ts)
//   result    the two forms of a result: the proposal and the failed proposal, each with `bidders` and `quotes` (src/result.ts)
export { PROPOSE_DEADLINE_MS, PROPOSE_FAILURES, ProposeRefusal, RANKING_RESERVE_MS, SCORING_RESERVE_MS, runFront } from './propose.ts';
export type { Front, Fronted } from './propose.ts';
export type {
  AcceptedQuote, BidderFile, BidderLineage, BidderStatus, BidderToHire, BidderView, ComplianceFact, DecisionAnswer, DiscoverResult, ExcludedQuote, FactState, ProposeDeps, ProposeRequest, QuoteOutcome,
  QuoteRecord, QuotesInput, QuotesResult, RankInput, RankScored, RankingChoice, ScoreSubject, ScoredQuote, ScoringInput, ScoringResult, ShortlistChoice,
} from './ports.ts';
export type { Held, SourcingFailed, SourcingMembers, SourcingProposal, SourcingResult } from './result.ts';
