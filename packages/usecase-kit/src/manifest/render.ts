// packages/usecase-kit/src/manifest/render.ts
// The bytes of a manifest and their hash. A service renders its manifest when it starts and serves those bytes at `/agent.json`. The advert holds the SHA-256 of the same bytes. A template is the
// same manifest with a placeholder for each value that the operator gives, and it is never served.
//
// The manifest bytes must be the same for every value of the setting FAULT_MODE, and the same on every render. `renderManifest` renders the manifest for each setting of the kind and refuses when two
// renders differ. It also checks the rules of the fault switch for the manifest: the possible values are listed, one gap sentence tells that a fault can be on, and no member names the active value.
import { createHash } from 'node:crypto';
import { AGENT_KINDS, FAULT_MODES, accepted, isPlainObject, refused } from '../protocol/index.ts';
import type { AgentKind, Digest, FaultSetting, ProtocolResult, Refused } from '../protocol/index.ts';
import { ADDITION_MEMBERS, MANIFEST_SCHEMA, faultGap, parseBehaviourAdditions } from './behaviour.ts';
import type { ManifestOptions } from './behaviour.ts';
import { isAgentKind } from './kinds.ts';

/** The bytes of a manifest, as text, and their SHA-256 as 64 lower-case hex characters. For a served manifest this is the `detail_hash` of the advert. */
export interface RenderedManifest {
  readonly text: string;
  readonly sha256: Digest;
}

export type ManifestRefusal =
  | 'bad_shape'
  | 'manifest_not_json'
  | 'manifest_not_stable'
  | 'manifest_changes_with_fault'
  | 'manifest_has_placeholder'
  | 'manifest_schema'
  | 'manifest_behaviour'
  | 'manifest_fault_gap'
  | 'manifest_names_fault';

/** A placeholder of a template, found anywhere in the text. */
const PLACEHOLDER_IN_TEXT = /<[A-Z][A-Z0-9_]*>/;

/** The text of a manifest: the compact JSON that a service serves, or the indented JSON of a template with a line break at the end. It is null for a value that is not a JSON object. */
function textOf(manifest: unknown, template: boolean): string | null {
  if (!isPlainObject(manifest)) return null;
  try {
    const text = template ? `${JSON.stringify(manifest, null, 2)}\n` : JSON.stringify(manifest);
    return typeof text === 'string' ? text : null;
  } catch {
    return null;
  }
}

/** True when an object, at any depth, has a member with this name. A text that holds the name is not a member. */
function hasMember(value: unknown, name: string, depth = 0): boolean {
  if (depth > 32 || typeof value !== 'object' || value === null) return false;
  if (Array.isArray(value)) return value.some((item) => hasMember(item, name, depth + 1));
  return Object.entries(value).some(([key, item]) => key === name || hasMember(item, name, depth + 1));
}

/** The additions that the manifest holds under `behaviour`: the members that the kit adds, and none of the agent's own. A member of the old form with a claim reference is kept, so it is refused. */
function additionsOf(behaviour: unknown): Record<string, unknown> {
  const picked: Record<string, unknown> = {};
  if (!isPlainObject(behaviour)) return picked;
  for (const name of [...ADDITION_MEMBERS, 'standing_claim']) if (Object.hasOwn(behaviour, name)) picked[name] = behaviour[name];
  return picked;
}

/** The refusal for a manifest that breaks a rule of the additions or of the fault switch, and null for a manifest that keeps them. `text` is the text that was rendered. */
function checkManifest(kind: AgentKind, text: string, options: ManifestOptions): Refused<ManifestRefusal> | null {
  const manifest = JSON.parse(text) as unknown;
  if (!isPlainObject(manifest)) return refused('manifest_not_json', 'the manifest must be a JSON object');
  if (options.template !== true && PLACEHOLDER_IN_TEXT.test(text)) return refused('manifest_has_placeholder', 'the manifest still has a placeholder of the template, and a service must not serve a template');
  if (manifest.schema !== MANIFEST_SCHEMA) return refused('manifest_schema', `the manifest schema must be ${MANIFEST_SCHEMA}`);
  if (hasMember(manifest, 'fault_mode')) return refused('manifest_names_fault', 'the manifest has a member fault_mode: the active value belongs in each result and never in the manifest');
  const additions = parseBehaviourAdditions(kind, additionsOf(manifest.behaviour), options);
  if (!additions.ok) return refused('manifest_behaviour', additions.detail);
  const gaps: readonly unknown[] = Array.isArray(manifest.gaps) ? manifest.gaps : [];
  for (const other of AGENT_KINDS) {
    const sentence = faultGap(other);
    if (sentence === null) continue;
    const found = gaps.filter((gap) => gap === sentence).length;
    if (other === kind && found !== 1) return refused('manifest_fault_gap', `gaps must hold the fault sentence of ${kind} one time, and it holds it ${found} times`);
    if (other !== kind && found !== 0) return refused('manifest_fault_gap', `gaps holds the fault sentence of ${other}, and the kind of this agent is ${kind}`);
  }
  return null;
}

/**
 * Renders the manifest that `build` makes and gives its bytes and their hash. `build` takes the fault setting and returns the manifest object. It is called for the empty setting two times, and for
 * each fault value of the kind one time. The renders must give the same bytes. A manifest that changes with the setting (`manifest_changes_with_fault`), and a manifest that changes between two renders
 * for one setting (`manifest_not_stable`), are refused. The manifest must be schema v2, must hold the additions of the kind, must list its possible fault values, must hold the one gap sentence of
 * the kind and no other, and must not name the active value. A served manifest must have no placeholder. Pass `{ template: true }` to render the template text. An error of `build` is the error of the caller.
 */
export function renderManifest<K extends AgentKind>(kind: K, build: (setting: FaultSetting<K>) => unknown, options: ManifestOptions = {}): ProtocolResult<RenderedManifest, ManifestRefusal> {
  if (!isAgentKind(kind)) return refused('bad_shape', 'the kind of agent is not a kind of agent');
  const template = options.template === true;
  // The empty setting, the empty setting again, and each fault value of the kind. The values come from the table of the protocol for this kind.
  const settings = ['', '', ...FAULT_MODES[kind]] as unknown as FaultSetting<K>[];
  let first = '';
  for (const [index, setting] of settings.entries()) {
    const text = textOf(build(setting), template);
    if (text === null) return refused('manifest_not_json', 'the manifest must be a JSON object that JSON can write');
    if (index === 0) first = text;
    else if (text !== first) {
      return index === 1
        ? refused('manifest_not_stable', 'the manifest builder gives other bytes on a second render with the same setting')
        : refused('manifest_changes_with_fault', `the manifest changes when FAULT_MODE is ${JSON.stringify(setting)}, and it must not change`);
    }
  }
  const problem = checkManifest(kind, first, options);
  if (problem !== null) return problem;
  return accepted({ text: first, sha256: createHash('sha256').update(first, 'utf8').digest('hex') });
}
