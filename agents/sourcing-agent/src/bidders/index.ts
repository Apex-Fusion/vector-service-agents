// agents/sourcing-agent/src/bidders/index.ts
// What the Sourcing Agent of use case 3 (supplier bid evaluation) knows of its bidders. A bidder is a Bid Desk that quotes on the marketplace. Every source of data comes in through a port: this folder reads
// no file, no environment variable and no key, and it does not import the folders of the flows (`facts`, `compliance`, `model`, `quotes`, `scoring`, `propose`, `execute` and `serve`).
//
//   types      the file that the model reads for each bidder, the view that the code keeps, the ports of the reader and its bounds
//   discover   the Bid Desks that the indexer lists and the chain shows, and the manifest and the price list of each one, each file checked against its hash
//   lineage    the status, the lineage and the Accountable Party that a DID resolution gives, for each of its three kinds
//   catalog    the DIDs of the catalog of the gateway
//   file       `readBidders`: the discovery, the catalog and the facts of each bidder, at most four bidders at one time
export { readBidders } from './file.ts';
export type { BiddersResult } from './file.ts';
export { parseArdCatalog } from './catalog.ts';
export { BIDDER_FETCH_TIMEOUT_MS, BIDDER_FILE_MAX_BYTES, BIDDER_READ_BUDGET_MS, FACT_READ_TIMEOUT_MS, MAX_CANDIDATES, MAX_PARALLEL_READS } from './types.ts';
export type {
  AdvertRead, BidderFile, BidderLineage, BidderRow, BidderStatus, BidderView, BiddersDeps, BiddersOptions, CasesAnswer, ComplianceFact, FactState, FetchLimits, FetchedBytes, StakeAnswer,
} from './types.ts';
