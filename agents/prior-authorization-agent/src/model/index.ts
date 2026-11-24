// agents/prior-authorization-agent/src/model/index.ts
// What the Prior Authorization Agent knows of its request and of the two model decisions. Every source of data comes in through a parameter: this folder reads no file, no environment variable and no key,
// and it does not import the folders of the flows (`evidence`, `propose`, `execute`, `insurer`, `counter` and `serve`).
//
//   intake     the two fields of a `propose` request
//   decisions  the decision `accept_delivery`: the fixed text, the input and the parser of the choice
export { parseProposeFields } from './intake.ts';
export type { ProposeFields } from './intake.ts';
export { ACCEPT_DECISION, acceptInput } from './decisions.ts';
export type { AcceptChoice } from './decisions.ts';
