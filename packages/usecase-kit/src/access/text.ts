// packages/usecase-kit/src/access/text.ts
// Text from outside that a result shows. It is not part of the public surface: the index of the folder does not export this file.
// A detail is for a log. It never holds a credential, so every text goes through `safeText` with the secrets that the caller holds.

const NOT_PRINTABLE = /[^\x20-\x7e]/g;

/** The most characters that a detail shows. */
export const MAX_DETAIL_CHARS = 200;

/** A secret shorter than this is not removed from a text: it would also remove words that are not secret. A token, a proof and a key are far longer. */
const MIN_SECRET_CHARS = 8;

/** The pieces of a secret that a text must not show: the whole value, and each part of 12 characters or more between dots (the three parts of a JWT). */
export function piecesOf(secret: string): string[] {
  return [secret, ...secret.split('.').filter((part) => part.length >= 12)];
}

/** `text` as a detail may show it: each secret taken out first, then printable ASCII only, cut to MAX_DETAIL_CHARS. The secrets go first, so a cut can never leave a part of one. */
export function safeText(text: string, secrets: readonly string[] = []): string {
  let shown = text;
  for (const secret of secrets) if (secret.length >= MIN_SECRET_CHARS) shown = shown.split(secret).join('[removed]');
  return shown.replace(NOT_PRINTABLE, '?').slice(0, MAX_DETAIL_CHARS);
}

/** What a thrown value says: the name and the message of an error, as `safeText` shows them. A value that is not an error says nothing about itself. */
export function errorText(error: unknown, secrets: readonly string[] = []): string {
  return error instanceof Error ? safeText(`${error.name}: ${error.message}`, secrets) : 'a value that is not an error was thrown';
}
