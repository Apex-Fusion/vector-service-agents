// packages/usecase-kit/src/janitor/index.ts
// The janitor of left sub-delegations: the list of the sub-delegations that a run did not see ended, and the pass that ends them with the Undelegate. Import it as `@vsa/usecase-kit/janitor`.
//   - the list, in memory and on disk (src/store.ts);
//   - one pass, and a loop of passes that never overlap (src/janitor.ts).
// The folder reads no environment variable and no key file. Every access to the ledger, the node, the keys, the queue and the clock goes through a parameter.
export { DamagedLeftEntriesError, FileLeftStore, MemoryLeftStore, nodeLeftFs, parseLeftEntry } from './store.ts';
export type { DamagedLeftEntry, LeftEntry, LeftFs, LeftStore } from './store.ts';
export { DEFAULT_END_POLL_MS, DEFAULT_ENTRY_TIMEOUT_MS, DEFAULT_STOP_WAIT_MS, DEFAULT_TTL_MARGIN_SLOTS, JANITOR_STATES, runJanitorOnce, startJanitor } from './janitor.ts';
export type { JanitorDeps, JanitorEntryReport, JanitorReport, JanitorState } from './janitor.ts';
