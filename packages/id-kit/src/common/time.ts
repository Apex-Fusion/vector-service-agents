// packages/id-kit/src/common/time.ts
// The time format of the gateway in its credentials: `YYYY-MM-DDThh:mm:ssZ`, with no fraction and no offset.

const ZULU = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

/** POSIX milliseconds of a time in the form `YYYY-MM-DDThh:mm:ssZ`; null for any other text and for a date that does not exist. */
export function parseZuluTime(text: unknown): number | null {
  if (typeof text !== 'string' || !ZULU.test(text)) return null;
  const ms = Date.parse(text);
  return Number.isNaN(ms) || new Date(ms).toISOString().replace('.000Z', 'Z') !== text ? null : ms;
}
