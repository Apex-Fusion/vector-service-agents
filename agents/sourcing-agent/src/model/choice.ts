// agents/sourcing-agent/src/model/choice.ts
// The two checks that the parsers of the four choices share: a text that the model wrote, and a list of values that stand each at most one time. A check reads the shape and nothing else. It never changes a
// value. A refusal names the field and the rule, and it never repeats the value: the model wrote it.
import { accepted, refused } from '@vsa/usecase-kit/protocol';
import type { ProtocolResult } from '@vsa/usecase-kit/protocol';

/**
 * The characters that a text of the model never holds: the control characters (among them the line feed and NUL), the format characters (zero width, direction, byte order mark and tag characters), the
 * line and paragraph separators, the surrogates that stand alone, and the default ignorable characters of the Unicode standard (the variation selectors, the Hangul fillers and others). A reader of the
 * record cannot see such a character, and it can change how a text reads without a change of a letter.
 */
const HIDDEN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}\p{Default_Ignorable_Code_Point}]/u;

/** A text of at most `max` characters with no hidden character. The text is checked as the model wrote it, and it is not changed: an empty text passes. */
export function parseNote(value: unknown, field: string, max: number): ProtocolResult<string> {
  if (typeof value === 'string' && value.length <= max && !HIDDEN.test(value)) return accepted(value);
  return refused('bad_shape', `${field} must be a text of at most ${max} characters with no control, format, separator, surrogate or default ignorable character`);
}

/**
 * A list of `least` to `most` entries. `parseItem` reads each entry and gives its value, and no value stands two times. The entries are checked in order, and the first one that is wrong ends the check.
 * The list is not copied: the caller keeps the value that it was given.
 */
export function parseList<T>(
  value: unknown,
  field: string,
  least: number,
  most: number,
  parseItem: (entry: unknown, at: string) => ProtocolResult<T>,
): ProtocolResult<readonly T[]> {
  if (!Array.isArray(value)) return refused('bad_shape', `${field} must be a list`);
  const entries: readonly unknown[] = value;
  if (entries.length < least || entries.length > most) return refused('bad_shape', `${field} must have ${least} to ${most} entries`);
  const values: T[] = [];
  const seen = new Set<T>();
  for (const [index, entry] of entries.entries()) {
    const at = `${field}[${index}]`;
    const parsed = parseItem(entry, at);
    if (!parsed.ok) return parsed;
    if (seen.has(parsed.value)) return refused('bad_shape', `${at} is a value that the list has already`);
    seen.add(parsed.value);
    values.push(parsed.value);
  }
  return accepted(values);
}
