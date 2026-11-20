// packages/usecase-kit/src/protocol/manifest.ts
// What an agent manifest (`vector.agent-manifest.v2`) adds under `behaviour` for these agents, as types, and the one route and the one rule of the co-signature. The manifest has other members that each
// agent writes. These are the members that the agents share, and the members that only some kinds have.
//
//   claim        The three statements of the claim of the agent, with no reference to a claim: a claim is staked for each run.
//   cosign       The route and the rule by which a buyer-side agent co-signs a delegation. Only a buyer-side agent has it. COSIGN_ROUTE and COSIGN_RULE hold both.
//   operations   `["propose", "execute"]` for a buyer-side agent. A counterparty has no operations, and the member is absent.
//   fault_modes  The fault values that the agent kind lists. The value that is active is not in the manifest.
//   model        The models that the agent may hire for its decisions, and the most that it pays for a call.
//   relying_on   The mock systems and the routes of the identity gateway that the agent calls.
//   price_list   Only a bid desk: the file with its prices.
//   lots         Only an order desk: the file with its lot sizes.
import type { FaultMode } from './faults.ts';
import type { Digest } from './identifiers.ts';
import type { AgentKind, BuyerSideKind } from './kinds.ts';

export interface ClaimStatement<Id extends string = string> {
  readonly id: Id;
  readonly text: string;
}

/** The statements of a claim: exactly three, with the ids S1, S2 and S3 in this order. */
export interface ManifestClaim {
  readonly statements: readonly [ClaimStatement<'S1'>, ClaimStatement<'S2'>, ClaimStatement<'S3'>];
}

/** The rule of the co-signature of a buyer-side agent: the path of its route, and the rule in words. */
export interface ManifestCosign {
  readonly route: string;
  readonly rule: string;
}

/** The path of the co-sign route of a buyer-side agent, on the origin of its endpoint. The method is POST. */
export const COSIGN_ROUTE = '/cosign/delegate';

/**
 * The rule of the co-signature in words: what the route of a buyer-side agent checks before it signs. The cosign folder states this rule, and the manifest of a buyer-side agent holds it, so a reader of the
 * manifest reads the rule that the route applies. A change of a rule of the route changes this text, and so it changes the bytes of the manifest and the hash of the advert.
 */
export const COSIGN_RULE =
  'The agent signs one kind of transaction: a Delegate transaction of the delegation contract that names this agent as the delegate and one of its own delegation keys as the delegate key. ' +
  'The delegator must have signed the transaction first, and the delegator must be a principal key on the allowlist of the operator. ' +
  'The delegation key must have no live delegation and no other signed transaction whose window is open. ' +
  'The transaction must spend nothing of the agent, and it must have no certificate, no withdrawal and no other mint. ' +
  'Its validity window must end in the future, and not too far ahead, and the period of the delegation must not be over. ' +
  'The agent adds one witness of the delegation key and changes nothing else.';

/** The models that an agent may hire (the setting `LLM_MODEL_ALLOWLIST`) and the most that it pays for one call, in lovelace (`LLM_MAX_PRICE_LOVELACE`). */
export interface ManifestModel {
  readonly allowlist: readonly string[];
  readonly max_price_lovelace: number;
}

/** What the agent calls: the routes of the mock systems and the routes of the identity gateway, each as `METHOD /path`. */
export interface ManifestRelyingOn {
  readonly mock_systems: readonly string[];
  readonly gateway_routes: readonly string[];
}

/** A published file and its hash: the lots file of an order desk, and the price list of a bid desk. */
export interface ManifestFileRef {
  readonly uri: string;
  readonly sha256: Digest;
}

type ForKind<K extends AgentKind> = {
  readonly claim: ManifestClaim;
  readonly fault_modes: readonly FaultMode<K>[];
  readonly model: ManifestModel;
  readonly relying_on: ManifestRelyingOn;
} & (K extends BuyerSideKind
  ? { readonly operations: readonly ['propose', 'execute']; readonly cosign: ManifestCosign }
  : { readonly operations?: undefined; readonly cosign?: undefined }) &
  (K extends 'order-desk' ? { readonly lots: ManifestFileRef } : { readonly lots?: undefined }) &
  (K extends 'bid-desk' ? { readonly price_list: ManifestFileRef } : { readonly price_list?: undefined });

/**
 * The members that these agents add under `behaviour`, for one kind of agent. With no kind, the type is the union of the six: an object is the additions of exactly one kind, and never a mix of the
 * members or the fault values of two kinds.
 */
export type BehaviourAdditions<K extends AgentKind = AgentKind> = K extends AgentKind ? ForKind<K> : never;
