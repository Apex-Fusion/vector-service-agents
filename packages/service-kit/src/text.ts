// packages/service-kit/src/text.ts
// Text from the far end (a caller, a server a source is fetched from, a tool, an error) goes into a message cut short, and into a log line with no control
// character in it. A module with no imports, exported alone as @vsa/service-kit/text, so that a module that must not load the fetch of a source can use it.

/** `s` cut to its first `max` characters, with "..." after a cut. */
export const clip = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max)}...` : s);

/** The control characters: U+0000 to U+001F and U+007F. */
const CONTROL = /[\u0000-\u001f\u007f]/g;

/**
 * Text fit for a log line or the body of an answer: every control character becomes a space, so that a line break cannot forge a log line nor an escape steer a
 * terminal, and the text is cut at `max` characters. The rule of flatText in packages/buyer-core, which keeps its own copy.
 */
export function flatText(text: string, max: number): string {
  const flat = text.replace(CONTROL, ' ');
  return flat.length > max ? flat.slice(0, max) : flat;
}

/** The message of an error, flat and cut short, for a message a person reads and for a log line. */
export function errorText(err: unknown, max = 300): string {
  const text = err instanceof Error ? err.message : String(err);
  return clip(flatText(text, text.length), max);
}
