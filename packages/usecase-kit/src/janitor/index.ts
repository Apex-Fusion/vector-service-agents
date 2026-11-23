// packages/usecase-kit/src/janitor/index.ts
// The janitor of left sub-delegations: the list of the sub-delegations that a run did not see ended, and the pass that ends them with the Undelegate. Import it as `@vsa/usecase-kit/janitor`.
//   - the list, in memory and on disk (src/store.ts).
export { DamagedLeftEntriesError, FileLeftStore, MemoryLeftStore, nodeLeftFs, parseLeftEntry } from './store.ts';
export type { DamagedLeftEntry, LeftEntry, LeftFs, LeftStore } from './store.ts';
