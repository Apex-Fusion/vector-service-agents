// agents/prior-authorization-agent/src/counter/index.ts
// The counter of request numbers of the Prior Authorization Agent (use case 2, prior authorization): one counter for each tenant, in memory for a test and in a file for the service. The file form is the only
// code of this folder that touches the file system, and it takes its path as an argument: this folder reads no environment variable and no key, and it does not import the folders of the other parts of the agent.
//
//   counter  the counter of request numbers, in memory and in a file (src/counter.ts)
export { FileRequestCounter, MemoryRequestCounter } from './counter.ts';
export type { CounterFs, FileRequestCounterOptions, RequestCounter } from './counter.ts';
