// packages/usecase-kit/src/dispute/text.ts
// Text from a failure that goes into a detail or a log line. It is not part of the public surface: the index of the folder does not export this file.

/**
 * The message of a failure as it may stand in a detail or in a log line: printable ASCII only, at most 300 characters, and every URL replaced, because an operator can put a key into the URL of
 * a node. The message of a value that is not an error is never read: a value can be anything.
 */
export function describeError(error: unknown): string {
  const text = error instanceof Error ? error.message : typeof error === 'string' ? error : 'an error with no message';
  return text.replace(/\bhttps?:\/\/\S+/gi, '[url]').replace(/[^\x20-\x7e]/g, '?').slice(0, 300);
}
