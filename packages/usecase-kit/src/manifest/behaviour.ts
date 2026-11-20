// packages/usecase-kit/src/manifest/behaviour.ts
// The members that the agents add under `behaviour` of the manifest `vector.agent-manifest.v2`, and the one gap sentence about the fault switch.
//
//   operations   `["propose", "execute"]` for a buyer-side agent, and absent for a counterparty.
//   claim        The three statements, with no claim reference.
//   cosign       The route and the rule of the co-signature, for a buyer-side agent.
//   fault_modes  Every fault value of the kind, from the table of the protocol. The value that is active is not in the manifest.
//   model        The models that the agent may hire, and the ceiling of one call.
//   relying_on   The routes of the mock systems and of the gateway that the agent calls.
//   lots         The lots file of an order desk.   price_list   The price list of a bid desk.
//
// The members come out in this order, so the same parts give the same bytes. The builders take the KIND of the agent and never the fault setting, so the manifest cannot depend on it.
import { FAULT_MODES, accepted, checkMembers, readMembers, refused } from '../protocol/index.ts';
import type { AgentKind, BehaviourAdditions, FaultMode, ManifestCosign, ManifestFileRef, ManifestModel, ManifestRelyingOn, ProtocolResult } from '../protocol/index.ts';
import { buildClaim, parseClaim, parseFileRef, parseModel, parseRelyingOn } from './fields.ts';
import type { FieldOptions } from './fields.ts';
import { isAgentKind, isBuyerSideKind } from './kinds.ts';

/** The schema of the manifest that these members belong to. */
export const MANIFEST_SCHEMA = 'vector.agent-manifest.v2';
/** The path of the co-sign route of a buyer-side agent. The method is POST. */
export const COSIGN_ROUTE = '/cosign/delegate';
/** The rule of the co-signature, in the words of the manifest. */
export const COSIGN_RULE =
  "The agent signs only a Delegate transaction that names this agent and one of its free delegation keys, and that spends nothing of the agent's own. It signs only for a principal key that is on an allowlist that the operator sets.";

/** The members that an agent of any kind can add under `behaviour`. */
export const ADDITION_MEMBERS = ['operations', 'claim', 'cosign', 'fault_modes', 'model', 'relying_on', 'lots', 'price_list'] as const;

/** The co-sign member of a buyer-side agent. */
export function buildCosign(): ManifestCosign {
  return { route: COSIGN_ROUTE, rule: COSIGN_RULE };
}

function assertKind(kind: unknown): asserts kind is AgentKind {
  if (!isAgentKind(kind)) throw new TypeError('the kind of agent is not a kind of agent');
}

/** Every fault value of the kind, in the order of the table of the protocol, as a new array. An agent with no fault value gets an empty list. */
export function buildFaultModes<K extends AgentKind>(kind: K): readonly FaultMode<K>[] {
  assertKind(kind);
  return [...FAULT_MODES[kind]] as unknown as readonly FaultMode<K>[];
}

/** What each fault value does, in the words of the gap sentence. */
export const FAULT_EFFECTS = {
  confirm_wrong_lot: 'the confirmation names another lot than the purchase order',
  alter_after_approval: 'one sentence of the justification changes after the approval and before the handoff',
  quote_off_price_list: 'one quote line has a unit price that is not the published price',
  invert_scores: 'one scorer returns its component scores reversed',
} as const satisfies Record<FaultMode, string>;

/**
 * The one sentence of `gaps` about the fault switch, for a kind that has a fault value: the possible values with what each does, and where the active value shows. A kind with no fault value has no
 * switch, and the sentence is null. The manifest never shows the active value, so a reader needs the sentence to know that a fault can be on.
 */
export function faultGap(kind: AgentKind): string | null {
  assertKind(kind);
  const values: readonly FaultMode[] = FAULT_MODES[kind];
  if (values.length === 0) return null;
  const named = values.map((value) => `${value} (${FAULT_EFFECTS[value]})`).join(', ');
  const which = values.length === 1 ? 'its one possible value is' : 'its possible values are';
  return `This service has a fault switch for failure runs, and ${which} ${named}; this manifest is the same for every value, so only the field fault_mode of each result shows which value is active.`;
}

/** The gaps with the fault sentence of the kind at the end, as a new list. A kind with no fault value gets the gaps as they are. */
export function withFaultGap(kind: AgentKind, gaps: readonly string[]): readonly string[] {
  const sentence = faultGap(kind);
  return sentence === null ? [...gaps] : [...gaps, sentence];
}

/** What a builder takes besides the field options. */
export type ManifestOptions = FieldOptions;

/** The members of the parts that the caller gives for a kind, and no other. The rest comes from the kind. */
export type BehaviourParts<K extends AgentKind> = {
  /** The texts of the three statements of the claim, in the order S1, S2, S3. */
  readonly claim: readonly [string, string, string];
  readonly model: ManifestModel;
  readonly relying_on: ManifestRelyingOn;
} & (K extends 'order-desk' ? { readonly lots: ManifestFileRef } : { readonly lots?: undefined }) &
  (K extends 'bid-desk' ? { readonly price_list: ManifestFileRef } : { readonly price_list?: undefined });

/** The members that an agent of the kind has, in the order of the manifest. */
function memberNames(kind: AgentKind): readonly string[] {
  const buyer = isBuyerSideKind(kind);
  return [...(buyer ? ['operations'] : []), 'claim', ...(buyer ? ['cosign'] : []), 'fault_modes', 'model', 'relying_on', ...(kind === 'order-desk' ? ['lots'] : []), ...(kind === 'bid-desk' ? ['price_list'] : [])];
}

/** An array as text, in its order, when every element is a text. */
function sameTexts(value: unknown, expected: readonly string[]): boolean {
  return Array.isArray(value) && value.length === expected.length && expected.every((text, index) => value[index] === text);
}

/**
 * Checks the additions of one kind and returns them as a new object in the order of the manifest. The object has exactly the members of the kind: a buyer-side agent has `operations` and `cosign`, an
 * order desk has `lots`, a bid desk has `price_list`, and no other member is allowed (a member `fault_mode`, or `standing_claim` with a claim reference, is refused). `operations` is both operations,
 * `cosign` is the rule of the kit, and `fault_modes` is every value of the kind and no other value. Pass `{ template: true }` for a template: the published files can have placeholders.
 */
export function parseBehaviourAdditions<K extends AgentKind>(kind: K, value: unknown, options: ManifestOptions = {}): ProtocolResult<BehaviourAdditions<K>> {
  if (!isAgentKind(kind)) return refused('bad_shape', 'the kind of agent is not a kind of agent');
  const read = readMembers(value, 'behaviour');
  if (!read.ok) return read;
  const members = checkMembers(read.value, 'behaviour', memberNames(kind));
  if (members !== null) return members;
  const out: Record<string, unknown> = {};
  if (isBuyerSideKind(kind)) {
    if (!sameTexts(read.value.operations, ['propose', 'execute'])) return refused('bad_shape', 'behaviour.operations must be ["propose","execute"]');
    out.operations = ['propose', 'execute'];
  }
  const claim = parseClaim(read.value.claim);
  if (!claim.ok) return claim;
  out.claim = claim.value;
  if (isBuyerSideKind(kind)) {
    const cosign = readMembers(read.value.cosign, 'behaviour.cosign');
    if (!cosign.ok) return cosign;
    const names = checkMembers(cosign.value, 'behaviour.cosign', ['route', 'rule']);
    if (names !== null) return names;
    if (cosign.value.route !== COSIGN_ROUTE || cosign.value.rule !== COSIGN_RULE) return refused('bad_shape', 'behaviour.cosign must be the co-sign rule of the kit');
    out.cosign = buildCosign();
  }
  if (!sameTexts(read.value.fault_modes, FAULT_MODES[kind])) return refused('bad_shape', `behaviour.fault_modes must list every fault value of ${kind}, in the order of the table, and no other value`);
  out.fault_modes = buildFaultModes(kind);
  const model = parseModel(read.value.model);
  if (!model.ok) return model;
  out.model = model.value;
  const relying = parseRelyingOn(read.value.relying_on);
  if (!relying.ok) return relying;
  out.relying_on = relying.value;
  if (kind === 'order-desk') {
    const lots = parseFileRef(read.value.lots, 'behaviour.lots', options);
    if (!lots.ok) return lots;
    out.lots = lots.value;
  }
  if (kind === 'bid-desk') {
    const prices = parseFileRef(read.value.price_list, 'behaviour.price_list', options);
    if (!prices.ok) return prices;
    out.price_list = prices.value;
  }
  return accepted(out as unknown as BehaviourAdditions<K>);
}

/**
 * Builds the additions of one kind from its parts. The kind gives `operations`, `cosign` and `fault_modes`, so no agent writes them by hand and none can leave one out. The caller gives the three
 * texts of the claim, the models, the routes, and the file of an order desk or of a bid desk. A part that the kind does not have, a claim reference, and a fault value are refused as members that are
 * not allowed. Every part is checked by `parseBehaviourAdditions`.
 */
export function buildBehaviour<K extends AgentKind>(kind: K, parts: BehaviourParts<K>, options: ManifestOptions = {}): ProtocolResult<BehaviourAdditions<K>> {
  if (!isAgentKind(kind)) return refused('bad_shape', 'the kind of agent is not a kind of agent');
  const read = readMembers(parts, 'parts');
  if (!read.ok) return read;
  const given: Record<string, unknown> = {};
  for (const [name, part] of Object.entries(read.value)) if (part !== undefined) given[name] = part;
  const members = checkMembers(given, 'parts', ['claim', 'model', 'relying_on', ...(kind === 'order-desk' ? ['lots'] : []), ...(kind === 'bid-desk' ? ['price_list'] : [])]);
  if (members !== null) return members;
  const claim = buildClaim(given.claim);
  if (!claim.ok) return claim;
  const assembled: Record<string, unknown> = {
    ...(isBuyerSideKind(kind) ? { operations: ['propose', 'execute'] } : {}),
    claim: claim.value,
    ...(isBuyerSideKind(kind) ? { cosign: buildCosign() } : {}),
    fault_modes: buildFaultModes(kind),
    model: given.model,
    relying_on: given.relying_on,
    ...(kind === 'order-desk' ? { lots: given.lots } : {}),
    ...(kind === 'bid-desk' ? { price_list: given.price_list } : {}),
  };
  return parseBehaviourAdditions(kind, assembled, options);
}
