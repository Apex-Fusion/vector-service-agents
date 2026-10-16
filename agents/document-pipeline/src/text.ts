// agents/document-pipeline/src/text.ts
// Text from the far end (a caller, a server a source is fetched from, a tool, an error) goes into a message cut short. Defined once, in a module with no
// imports, so that the intake, the loading of a source and the formatting of errors share it without loading one another.

/** `s` cut to its first `max` characters, with "..." after a cut. */
export const clip = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max)}...` : s);
