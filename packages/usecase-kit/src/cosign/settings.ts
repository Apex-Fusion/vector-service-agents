// packages/usecase-kit/src/cosign/settings.ts
// The settings of the route that a service reads, and the check of their values. The service reads the text of each setting (and the text of the allowlist file, when the allowlist is a file) and gives
// the texts to `parseCosignSettings`. This code reads no environment variable and no file. A value of the wrong type or outside its range is a refusal and never "no limit". A missing limit takes its
// default. A missing allowlist is a refusal: a route with no allowlist signs for nobody, so the service must say so on purpose with an empty text.
import { accepted, refused, type ProtocolResult } from '../protocol/index.ts';
import { Allowlist, parseAllowlist } from './allowlist.ts';
import { MAX_WINDOW_MS } from './codes.ts';

/** The names of the settings. */
export const COSIGN_SETTINGS = {
  /** The text of the allowlist: the principal keys that a delegation may come from (see allowlist.ts). The service reads it from a file or from this setting. */
  allowlist: 'COSIGN_ALLOWLIST',
  /** The most requests that the route works on at one time. A request over the limit is answered with `busy` at once. */
  maxConcurrent: 'COSIGN_MAX_CONCURRENT',
  /** How far ahead the end of the validity window of a transaction may be, in milliseconds. */
  maxFutureMs: 'COSIGN_MAX_FUTURE_MS',
  /** How long the route waits for one read of the ledger, in milliseconds. A read that takes longer is `check_unavailable`. */
  ledgerTimeoutMs: 'COSIGN_LEDGER_TIMEOUT_MS',
} as const;

export interface CosignLimits {
  readonly maxConcurrent: number;
  readonly maxFutureMs: number;
  readonly ledgerTimeoutMs: number;
}

export interface CosignSettings extends CosignLimits {
  readonly allowlist: Allowlist;
}

/** The value of a limit that the service does not set. */
export const DEFAULT_LIMITS: CosignLimits = { maxConcurrent: 4, maxFutureMs: MAX_WINDOW_MS, ledgerTimeoutMs: 5_000 };

/** The range of each limit, as the check takes it. A Delegate has a window of one hour at most, so a larger `maxFutureMs` has no use. */
const RANGES: Readonly<Record<keyof CosignLimits, readonly [number, number]>> = {
  maxConcurrent: [1, 64],
  maxFutureMs: [60_000, MAX_WINDOW_MS],
  ledgerTimeoutMs: [50, 30_000],
};
const NAMES: Readonly<Record<keyof CosignLimits, string>> = { maxConcurrent: COSIGN_SETTINGS.maxConcurrent, maxFutureMs: COSIGN_SETTINGS.maxFutureMs, ledgerTimeoutMs: COSIGN_SETTINGS.ledgerTimeoutMs };

function limitProblem(name: keyof CosignLimits, value: unknown): string | null {
  const [min, max] = RANGES[name];
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max ? null : `${NAMES[name]} must be a whole number from ${min} to ${max}`;
}

/** The check of settings that are values already: the allowlist is an `Allowlist`, and each limit is a whole number in its range. */
export function checkCosignSettings(settings: unknown): ProtocolResult<CosignSettings, 'bad_setting'> {
  if (typeof settings !== 'object' || settings === null) return refused('bad_setting', 'the settings must be an object');
  const given = settings as Record<string, unknown>;
  if (!(given.allowlist instanceof Allowlist)) return refused('bad_setting', `${COSIGN_SETTINGS.allowlist} must be an allowlist that parseAllowlist made`);
  for (const name of Object.keys(RANGES) as (keyof CosignLimits)[]) {
    const problem = limitProblem(name, given[name]);
    if (problem !== null) return refused('bad_setting', problem);
  }
  return accepted({ allowlist: given.allowlist, maxConcurrent: given.maxConcurrent as number, maxFutureMs: given.maxFutureMs as number, ledgerTimeoutMs: given.ledgerTimeoutMs as number });
}

/**
 * The settings from the texts that the service read. `values` has the names of COSIGN_SETTINGS as its keys. A limit is whole decimal digits. A limit that is missing takes its default. A value that is not
 * text, a limit that is not a whole number in its range, and an allowlist that is missing or that has an entry that is not a key hash are refusals. The detail names the setting and never repeats the value.
 */
export function parseCosignSettings(values: Readonly<Record<string, string | undefined>>): ProtocolResult<CosignSettings, 'bad_setting'> {
  const allowlist = values[COSIGN_SETTINGS.allowlist];
  if (allowlist === undefined) return refused('bad_setting', `${COSIGN_SETTINGS.allowlist} is not set`);
  const list = parseAllowlist(allowlist);
  if (!list.ok) return list;
  const limits: Record<string, number> = {};
  for (const name of Object.keys(RANGES) as (keyof CosignLimits)[]) {
    const text = values[NAMES[name]];
    if (text === undefined) {
      limits[name] = DEFAULT_LIMITS[name];
    } else if (typeof text !== 'string' || !/^[0-9]{1,15}$/.test(text)) {
      return refused('bad_setting', `${NAMES[name]} must be whole decimal digits`);
    } else {
      limits[name] = Number(text);
    }
  }
  return checkCosignSettings({ allowlist: list.value, ...limits });
}
