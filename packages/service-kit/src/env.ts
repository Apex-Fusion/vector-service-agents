// packages/service-kit/src/env.ts
// Reading the settings of a service without printing a secret. A key or a token put in the wrong line of an env file must not be printed because a check on
// that line found fault with it: a value a message shows is short and plain, or only its length. The names a service reads stay in the service's own code
// (its README test lists them from there); these helpers take the name and the value. Moved from agents/document-pipeline (src/server.ts, src/start.ts),
// with their messages word for word.

/** A value as a message may show it: short and plain, or only its length. */
export function shown(value: string): string {
  return value.length <= 24 && !/[0-9a-fA-F]{20}/.test(value) ? JSON.stringify(value) : `${value.length} characters`;
}

/** A number from the environment: absent or empty means the default (an empty string must not become 0); anything else must be a non-negative integer, and the error names the variable. */
export function envInt(name: string, v: string | undefined, fallback: number): number {
  if (v === undefined || v === '') return fallback;
  if (!/^\d+$/.test(v) || !Number.isSafeInteger(Number(v))) throw new Error(`environment variable ${name} must be a non-negative integer, got ${shown(v)}`);
  return Number(v);
}

/**
 * A setting the service cannot start without. Absent, empty and blank all mean it was not given, and the error names the variable and says what it is for. A
 * value that is published in the manifest has no default: a default would be published by every deployment that forgot to set it.
 */
export function requiredEnv(name: string, v: string | undefined, what: string): string {
  if (v === undefined || v.trim() === '') throw new Error(`environment variable ${name} is required (${what}) and is not set`);
  return v.trim();
}

/** The three status words, as the pages write them. */
export const STATUS_CHIPS = ['LIVE', 'DEPLOYED', 'PROPOSED'] as const;
export type StatusChip = 'live' | 'deployed' | 'proposed';

/** The word of AGENT_STATUS_CHIP: one of the three in any case, carried in lower case; absent or empty means `fallback`, the agent's word of today. */
export function statusChip(v: string | undefined, fallback: StatusChip): StatusChip {
  if (v === undefined || v === '') return fallback;
  if (!(STATUS_CHIPS as readonly string[]).includes(v.toUpperCase())) throw new Error(`environment variable AGENT_STATUS_CHIP must be one of ${STATUS_CHIPS.join(', ')}, got ${shown(v)}`);
  return v.toLowerCase() as StatusChip;
}

/** The date of AGENT_STATUS_SINCE, as YYYY-MM-DD; absent or blank means `fallback`. */
export function statusSince(v: string | undefined, fallback: string): string {
  if (v === undefined || v.trim() === '') return fallback;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v.trim())) throw new Error(`environment variable AGENT_STATUS_SINCE must be a date as YYYY-MM-DD, got ${shown(v)}`);
  return v.trim();
}

/** A setting as the operator wrote it: without the space or line break a file leaves around it; absent and empty are the same. */
export const given = (value: string | undefined): string => (value ?? '').trim();

/**
 * `value` as lower-case hex of `bytes` bytes. One that is not that is refused with its length and never with itself: a hex-shaped value in the wrong line may be a
 * secret, and this message would print it.
 */
export function hexOf(name: string, value: string, bytes: number): string {
  if (!new RegExp(`^[0-9a-fA-F]{${bytes * 2}}$`).test(value)) {
    const what = /^[0-9a-fA-F]*$/.test(value) ? `it has ${value.length} characters` : `some of its ${value.length} characters are not hex`;
    throw new Error(`environment variable ${name} must be ${bytes * 2} hex characters, and ${what}`);
  }
  return value.toLowerCase();
}

/**
 * Throws `refusal(name)`, which names the variable and not the secret, when one of `forms` (lower case) is in any of `settings` but `own`, the secret's own
 * line: in any case, inside a longer value too.
 */
export function refuseSecretIn(env: NodeJS.ProcessEnv, settings: readonly string[], forms: readonly string[], own: string, refusal: (name: string) => string): void {
  for (const name of settings) {
    if (name === own) continue;
    const value = (env[name] ?? '').toLowerCase();
    if (forms.some((form) => value.includes(form))) throw new Error(refusal(name));
  }
}

/** A token or credential shorter than this is no secret worth a search: it would be found in any text by chance. */
export const TOKEN_SEARCH_MIN = 16;

/** The forms of the service token that are looked for, in lower case: the token whole and its credential, the part after the last space, each when long enough. */
export function tokenForms(token: string): string[] {
  const credential = token.slice(token.lastIndexOf(' ') + 1);
  return [token, credential].filter((secret) => secret.length >= TOKEN_SEARCH_MIN).map((secret) => secret.toLowerCase());
}

/**
 * Throws, naming the variable and not printing the token, when the service token (SERVICE_AUTH_HEADER) is in any of `settings`, whole or by its credential, in
 * any case, inside a longer value too: a setting is published (the manifest), logged, or said in an answer.
 */
export function refuseTokenIn(env: NodeJS.ProcessEnv, settings: readonly string[], token: string): void {
  refuseSecretIn(env, settings, tokenForms(token), 'SERVICE_AUTH_HEADER', (name) =>
    `environment variable ${name} holds the service token, which belongs in SERVICE_AUTH_HEADER alone: it would be printed or published. Take it out of ${name}`);
}

/** Throws, without printing it, when `text` (the manifest about to be published) holds the service token whole or its credential, in any case. */
export function assertNoTokenIn(text: string, token: string): void {
  const lower = text.toLowerCase();
  if (tokenForms(token).some((form) => lower.includes(form))) {
    throw new Error('the manifest would publish the service token: a value that goes into it holds the token of SERVICE_AUTH_HEADER, and the service does not start with it');
  }
}

/** A value sent as an HTTP header is printable ASCII, a space to a tilde. One that is not is refused with its length only: it is a secret. */
export function assertHeaderValue(name: string, value: string): void {
  if (!/^[ -~]+$/.test(value)) throw new Error(`environment variable ${name} must be printable ASCII (it is sent as an HTTP header), and it has ${value.length} characters`);
}

// The environment of a program a service starts (childEnv) is in src/child-env.ts, a module with no imports that @vsa/service-kit/env exports alone.
