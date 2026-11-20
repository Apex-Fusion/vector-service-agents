// packages/usecase-kit/src/manifest/render.ts
// The bytes of a manifest and their hash. A service renders its manifest when it starts and serves those bytes at `/agent.json`. The advert holds the SHA-256 of the same bytes. A template is the
// same manifest with a placeholder for each value that the operator gives, and it is never served.
//
// The manifest bytes must be the same for every value of the setting FAULT_MODE, and the same on every render. `renderManifest` renders the manifest for each setting of the kind and refuses when two
// renders differ. That check works only when the builder takes the setting from its argument. A builder that reads the environment by itself gives the same bytes in one process, and a fault process
// and a clean process then serve other bytes. So `renderManifest` also checks the TEXT that is served: a fault value of ANY kind may stand only in the places that the kit makes, the members of
// `behaviour.fault_modes` and the one gap sentence, and a key `fault_mode` may stand nowhere. No walk with a depth limit decides this: the text is searched, and a text that cannot be written or
// read back is refused.
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

/** A key `fault_mode` in the text that `JSON.stringify` wrote. A text value cannot match: inside a text, a quote mark is written as `\"`, and a key is always followed by a colon. */
const FAULT_KEY_IN_TEXT = /"fault_mode"\s*:/;

/** Every fault value of every kind. */
const FAULT_VALUES: readonly string[] = AGENT_KINDS.flatMap((kind) => [...FAULT_MODES[kind]]);

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

/** How many times `part` stands in `text`, with no overlap. */
function occurrences(text: string, part: string): number {
  let count = 0;
  for (let at = text.indexOf(part); at !== -1; at = text.indexOf(part, at + part.length)) count += 1;
  return count;
}

type Step = string | number;
/** A place in a manifest, as a chain from its member to the top, so that no list is copied while the walk goes down. */
interface Place {
  readonly parent: Place | null;
  readonly step: Step;
}

const PLAIN_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_PLACE_CHARS = 80;

/** A place as a person reads it: `description`, `behaviour.own[0].text`. A key that is not a plain name is shown in brackets. The text is cut, and it has printable characters only. */
function placeText(place: Place): string {
  const steps: Step[] = [];
  for (let at: Place | null = place; at !== null; at = at.parent) steps.push(at.step);
  const text = steps.reverse().reduce<string>((built, step) => {
    if (typeof step === 'number') return `${built}[${step}]`;
    if (!PLAIN_NAME.test(step)) return `${built}[${JSON.stringify(step)}]`;
    return built === '' ? step : `${built}.${step}`;
  }, '');
  const printable = text.replace(/[^\x20-\x7e]/g, '?');
  return printable.length <= MAX_PLACE_CHARS ? printable : `${printable.slice(0, MAX_PLACE_CHARS)}...`;
}

/** True for the two places where the kit names a fault value: a member of `behaviour.fault_modes`, and the gap sentence at its place in `gaps`. */
function isKitPlace(place: Place | null, text: string, sentence: string | null): boolean {
  if (place === null || typeof place.step !== 'number' || place.parent === null) return false;
  const list = place.parent;
  if (list.step === 'gaps' && list.parent === null) return sentence !== null && text === sentence;
  return list.step === 'fault_modes' && list.parent !== null && list.parent.step === 'behaviour' && list.parent.parent === null && FAULT_VALUES.includes(text);
}

type Seen = { readonly kind: 'key'; readonly text: string; readonly place: Place } | { readonly kind: 'value'; readonly value: unknown; readonly place: Place | null };

/**
 * The first place, in the order of the document, where a key or a text value is `wanted`. It only tells WHERE, for a message: the decision is made on the text. The walk keeps a list of work
 * and calls itself never, so no depth stops it. It returns null when it finds no place.
 */
function firstPlace(root: unknown, wanted: (text: string, place: Place | null, isKey: boolean) => boolean): string | null {
  const work: Seen[] = [{ kind: 'value', value: root, place: null }];
  for (let item = work.pop(); item !== undefined; item = work.pop()) {
    if (item.kind === 'key') {
      if (wanted(item.text, item.place, true)) return placeText(item.place);
      continue;
    }
    const { value, place } = item;
    if (typeof value === 'string') {
      if (wanted(value, place, false) && place !== null) return placeText(place);
    } else if (Array.isArray(value)) {
      for (let index = value.length - 1; index >= 0; index -= 1) work.push({ kind: 'value', value: value[index], place: { parent: place, step: index } });
    } else if (typeof value === 'object' && value !== null) {
      const entries = Object.entries(value);
      for (let index = entries.length - 1; index >= 0; index -= 1) {
        const member: Place = { parent: place, step: entries[index][0] };
        work.push({ kind: 'value', value: entries[index][1], place: member }, { kind: 'key', text: entries[index][0], place: member });
      }
    }
  }
  return null;
}

/** The additions that the manifest holds under `behaviour`: the members that the kit adds, and none of the agent's own. A member of the old form with a claim reference is kept, so it is refused. */
function additionsOf(behaviour: unknown): Record<string, unknown> {
  const picked: Record<string, unknown> = {};
  if (!isPlainObject(behaviour)) return picked;
  for (const name of [...ADDITION_MEMBERS, 'standing_claim']) if (Object.hasOwn(behaviour, name)) picked[name] = behaviour[name];
  return picked;
}

/** The place of a search, for a message. The search never changes the answer: it can fail, and the refusal stands. */
function whereText(root: unknown, wanted: (text: string, place: Place | null, isKey: boolean) => boolean): string {
  try {
    const place = firstPlace(root, wanted);
    return place === null ? 'somewhere in the manifest' : `at ${place}`;
  } catch {
    return 'somewhere in the manifest';
  }
}

/**
 * The refusal for a manifest that breaks a rule of the additions or of the fault switch, and null for a manifest that keeps them. `text` is the text that was rendered. The fault values are
 * counted in this text: each fault value of the kind stands once in `behaviour.fault_modes` and as often as the gap sentence names it, and a fault value of another kind stands nowhere.
 */
function checkManifest(kind: AgentKind, text: string, options: ManifestOptions): Refused<ManifestRefusal> | null {
  let manifest: unknown;
  try {
    manifest = JSON.parse(text);
  } catch {
    return refused('manifest_not_json', 'the text of the manifest cannot be read back as JSON');
  }
  if (!isPlainObject(manifest)) return refused('manifest_not_json', 'the manifest must be a JSON object');
  if (options.template !== true && PLACEHOLDER_IN_TEXT.test(text)) return refused('manifest_has_placeholder', 'the manifest still has a placeholder of the template, and a service must not serve a template');
  if (manifest.schema !== MANIFEST_SCHEMA) return refused('manifest_schema', `the manifest schema must be ${MANIFEST_SCHEMA}`);
  if (FAULT_KEY_IN_TEXT.test(text)) {
    const where = whereText(manifest, (found, _place, isKey) => isKey && found === 'fault_mode');
    return refused('manifest_names_fault', `the manifest has a member fault_mode ${where}: the active value belongs in each result and never in the manifest`);
  }
  const additions = parseBehaviourAdditions(kind, additionsOf(manifest.behaviour), options);
  if (!additions.ok) return refused('manifest_behaviour', additions.detail);
  const sentence = faultGap(kind);
  const gaps: readonly unknown[] = Array.isArray(manifest.gaps) ? manifest.gaps : [];
  for (const other of AGENT_KINDS) {
    const otherSentence = faultGap(other);
    if (otherSentence === null) continue;
    const found = gaps.filter((gap) => gap === otherSentence).length;
    if (other === kind && found !== 1) return refused('manifest_fault_gap', `gaps must hold the fault sentence of ${kind} one time, and it holds it ${found} times`);
    if (other !== kind && found !== 0) return refused('manifest_fault_gap', `gaps holds the fault sentence of ${other}, and the kind of this agent is ${kind}`);
  }
  const own: readonly string[] = FAULT_MODES[kind];
  for (const value of FAULT_VALUES) {
    const allowed = own.includes(value) ? 1 + (sentence === null ? 0 : occurrences(sentence, value)) : 0;
    const found = occurrences(text, value);
    if (found === allowed) continue;
    const where = whereText(manifest, (part, place, isKey) => part.includes(value) && (isKey || !isKitPlace(place, part, sentence)));
    const rule = 'only the members of behaviour.fault_modes and the one gap sentence may name a fault value';
    return refused('manifest_names_fault', `the fault value ${JSON.stringify(value)} stands in the manifest ${where === 'somewhere in the manifest' ? `${found} times, and the kit makes it ${allowed} times` : where}: ${rule}`);
  }
  return null;
}

/**
 * Renders the manifest that `build` makes and gives its bytes and their hash. `build` takes the fault setting and returns the manifest object. It is called for the empty setting two times, and for
 * each fault value of the kind one time. The renders must give the same bytes. A manifest that changes with the setting (`manifest_changes_with_fault`), and a manifest that changes between two renders
 * for one setting (`manifest_not_stable`), are refused. The manifest must be schema v2, must hold the additions of the kind, must list its possible fault values, and must hold the one gap sentence of
 * the kind and no other. A fault value of any kind stands only in the members of `behaviour.fault_modes` and in that sentence, and a member `fault_mode` stands nowhere: a builder that reads the
 * environment by itself and puts the active value in the manifest is refused as `manifest_names_fault`, and the message says where. A served manifest must have no placeholder. Pass
 * `{ template: true }` to render the template text. An error of `build` is the error of the caller.
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
