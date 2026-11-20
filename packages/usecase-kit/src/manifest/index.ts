// packages/usecase-kit/src/manifest/index.ts
// What the agents add under `behaviour` of the manifest `vector.agent-manifest.v2`, and the rules for its bytes. Import it as `@vsa/usecase-kit/manifest`.
//
//   build      `buildBehaviour(kind, parts)` makes the additions of a kind. The kind gives `operations`, `cosign` and `fault_modes`. The caller gives the claim, the models, the routes and the files.
//   gaps       `withFaultGap(kind, gaps)` adds the one sentence about the fault switch to the gaps of an agent whose kind has a fault value.
//   render     `renderManifest(kind, build)` renders the manifest for every fault setting of the kind, and gives the bytes and the hash when they are all the same.
//
// A manifest is rendered from a template: the template has a placeholder for each value that the operator gives, and the service renders the real manifest when it starts. The hash of an advert is
// the hash of the served bytes, so the bytes must not change between two renders, and they must not change with the fault setting. The builders take the KIND of the agent and never the setting. The
// active fault value is in each result and in the evidence file, and it is never in the manifest.
export {
  ADDITION_MEMBERS, FAULT_EFFECTS, MANIFEST_SCHEMA, buildBehaviour, buildCosign, buildFaultModes, faultGap, parseBehaviourAdditions, withFaultGap,
} from './behaviour.ts';
// The route and the rule of the co-signature are held by the protocol. The cosign folder states the same rule.
export { COSIGN_ROUTE, COSIGN_RULE } from '../protocol/index.ts';
export type { BehaviourParts, ManifestOptions } from './behaviour.ts';
export { MAX_STATEMENT_CHARS, MAX_URI_CHARS, buildClaim, parseClaim, parseFileRef, parseModel, parseRelyingOn } from './fields.ts';
export type { FieldOptions } from './fields.ts';
export { renderManifest } from './render.ts';
export type { ManifestRefusal, RenderedManifest } from './render.ts';
