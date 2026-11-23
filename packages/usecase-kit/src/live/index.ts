// packages/usecase-kit/src/live/index.ts
// The parts that a buyer-side agent needs on a real chain, and that the other folders leave to the caller. Import it as `@vsa/usecase-kit/live`.
//   - the key object of a raw Ed25519 key, for the token client and the DPoP proof (src/keys.ts).
// Every access to the node, to Koios and to the network goes through a parameter. The folder reads no key file and no environment variable.
export { keyObjectOfRawKey } from './keys.ts';
