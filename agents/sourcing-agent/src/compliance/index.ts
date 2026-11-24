// agents/sourcing-agent/src/compliance/index.ts
// The compliance attestation of a bidder. The compliance registry is one key with no record. It issues one identity attestation (type 0) about each Bid Desk, with an end. `readCompliance` reads it from the ledger
// through a port and says whether it holds. Every source comes in through the deps: this folder reads no file, no environment variable and no key, and it does not import the other folders of the agent.
//
//   read  `readCompliance`: the newest attestation of the registry about the bidder decides, and a source that cannot be read is `unreadable`
export { COMPLIANCE_ATT_TYPE, FACT_READ_TIMEOUT_MS, readCompliance } from './read.ts';
export type { ComplianceClock, ComplianceDeps, ComplianceFact, FactState } from './read.ts';
