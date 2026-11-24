// agents/sourcing-agent/src/facts/index.ts
// The facts that the Sourcing Agent reads for the file of a bidder, apart from its adverts and its attestations: the Module-3 stake, the Module-1 cases against it and its identity credential. Each fact is data
// for the model and never a filter in code. A source that cannot be read is its own answer (`{ ok: false }` or `unreadable`): it is never a number and never `valid`. Every source comes in through a port, and
// every call of a port has a bound of time and is never repeated. This folder reads no file, no environment variable and no key, and it makes no network call by itself. It imports no other folder of the agent.
//
//   bound       the clock port, and the one way that a reader calls a port: one call, a bound of time, no retry
//   stake       the sum of the Module-3 stakes of an agent, over the outputs that hold its stake token
//   cases       the open challenges against the claims of a bidder, over the live claims and challenges of Module-1
//   credential  the identity credential of an agent, checked against the status list by the verifier
export { FACT_READ_TIMEOUT_MS } from './bound.ts';
export type { FactClock } from './bound.ts';
export { readStake } from './stake.ts';
export type { StakeDeps, StakeFact } from './stake.ts';
export { casesAgainst, casesAgainstAll } from './cases.ts';
export type { CasesDeps, CasesFact } from './cases.ts';
export { readCredential } from './credential.ts';
export type { CredentialDeps, FactState } from './credential.ts';
