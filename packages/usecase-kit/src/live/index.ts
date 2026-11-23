// packages/usecase-kit/src/live/index.ts
// The parts that a buyer-side agent needs on a real chain, and that the other folders leave to the caller. Import it as `@vsa/usecase-kit/live`.
//   - the real `DelegationChain` of the sub-delegation, over the builders and the reads of `@vsa/buyer-core` (src/chain.ts);
//   - the slot of the tip of the node, for the janitor of left sub-delegations (src/tip.ts);
//   - the key object of a raw Ed25519 key, for the token client and the DPoP proof (src/keys.ts).
// Every access to the node, to Koios and to the network goes through a parameter. The folder reads no key file and no environment variable.
export { delegationChainOf } from './chain.ts';
export type { LiveChainDeps } from './chain.ts';
export { tipSlotOf } from './tip.ts';
export { keyObjectOfRawKey } from './keys.ts';
