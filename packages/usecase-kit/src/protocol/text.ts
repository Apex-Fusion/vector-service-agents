// packages/usecase-kit/src/protocol/text.ts
// Text from outside that a refusal names. It is not part of the public surface: the index of the protocol does not export this file.

const NOT_PRINTABLE = /[^\x20-\x7e]/g;

/** A name from outside as it may stand in the detail of a refusal: at most 40 characters, and only printable ASCII, so that a hostile name cannot fill or split a log line. */
export function shown(name: string): string {
  return name.slice(0, 40).replace(NOT_PRINTABLE, '?');
}
