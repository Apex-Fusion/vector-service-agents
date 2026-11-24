// agents/prior-authorization-agent/src/insurer/index.ts
// The reader of the insurer of the Prior Authorization Agent (use case 2, prior authorization): the one advert of the Insurer Intake Agent that a request names. Every source of data comes in through a port or a
// parameter: this folder reads no file, no environment variable and no key, and it does not import the folders of the other parts of the agent.
//
//   insurer  `readInsurer`, the view with the one advert, the two failure codes, and the ports that the reader needs (src/insurer.ts)
export { INSURER_FAILURES, INSURER_READ_BUDGET_MS, readInsurer } from './insurer.ts';
export type { AdvertRead, InsurerDeps, InsurerFailureCode, InsurerView, SupplierRow } from './insurer.ts';
