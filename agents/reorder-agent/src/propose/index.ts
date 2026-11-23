// agents/reorder-agent/src/propose/index.ts
// The job `propose` of the Reorder Agent (use case 1, inventory reorder): the stock through a sub-delegation to `stock-reader`, the supplier, the model decision `reorder`, and the purchase order. Every source
// of data comes in through a port: this folder reads no environment variable and no key, and it does not import the folders of the other jobs (`model`, `execute` and `serve`).
//
//   propose   `runPropose`, the refusal of a request that it cannot serve, the deadline, and the codes of a failed proposal (src/propose.ts)
//   ports     `ProposeDeps` and the types of its members (src/ports.ts)
//   counter   the counter of purchase order numbers, in memory and in a file (src/counter.ts)
export { PROPOSE_DEADLINE_MS, PROPOSE_FAILURES, ProposeRefusal, runPropose } from './propose.ts';
export type { DelegationKey, InFlight, LeftEntry, LeftSink, ProposeDeps, ProposeRequest, ReorderAnswer, ReorderChoice, SupplierRead } from './ports.ts';
export { FilePoCounter, MemoryPoCounter } from './counter.ts';
export type { CounterFs, FilePoCounterOptions, PoCounter } from './counter.ts';
