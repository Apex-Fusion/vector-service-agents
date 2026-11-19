// packages/id-kit/src/common/json.ts
// The reading of JSON values that come from outside: every member is `unknown` until a check says what it is.

/** True for a JSON object: not null, not an array. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** True for a finite number. */
export const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/** True for a list of strings. */
export const isStringList = (value: unknown): value is string[] => Array.isArray(value) && value.every((v) => typeof v === 'string');
