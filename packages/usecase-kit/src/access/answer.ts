// packages/usecase-kit/src/access/answer.ts
// What a call to a mock system gives back, and the one rule that maps an HTTP answer to it. A caller reads `ok` and `code`, and never a text.
//
//   2xx with a JSON body                        { ok: true, status, body }
//   401 or 403 with a JSON body                 refused_by_system. `reason` is the code of the system, `refusal_without_code` when the body names none.
//   any other status                            mock_system_failed. `systemCode` is the code of the body when it names one.
//   a body that is not JSON, a timeout,         mock_system_failed. `sent` says whether the request left this process.
//   a network error, an answer that is too long
//
// A refusal is never a success: a body that says `ok` with a 403 is a refusal, and a 2xx with a body that is not JSON is a failure.
import type { JsonValue } from '../protocol/index.ts';
import { safeText } from './text.ts';

/** The system answered with a 2xx status and a JSON body. The caller reads the shape of the body: this folder does not know it. */
export interface SystemAnswered {
  readonly ok: true;
  readonly status: number;
  readonly body: JsonValue;
}

/** The system refused the call (401 or 403). `reason` is the `reason` of `refused_by_system`. */
export interface SystemRefused {
  readonly ok: false;
  readonly code: 'refused_by_system';
  /** The code that the system gave, cut to the characters of a code and to 64 characters. A code that the protocol does not list is passed on as it is. */
  readonly reason: string;
  readonly status: 401 | 403;
  readonly detail: string;
}

/** The call did not give an answer that can be read. The error code of the protocol is `mock_system_failed`. A write may have taken effect when `sent` is true: read the state before another write. */
export interface SystemFailed {
  readonly ok: false;
  readonly code: 'mock_system_failed';
  /** The HTTP status, or null when no answer came. */
  readonly status: number | null;
  /** The code in the body of a status that is not a refusal, for example `duplicate_po`, or null. */
  readonly systemCode: string | null;
  /** True when the request left this process. False when this folder refused to send it. */
  readonly sent: boolean;
  readonly detail: string;
}

export type SystemResult = SystemAnswered | SystemRefused | SystemFailed;

/** The reason of a refusal whose body names no code. */
export const REFUSAL_WITHOUT_CODE = 'refusal_without_code';

/** The most characters of a code that a result keeps. */
export const MAX_CODE_CHARS = 64;

const CODE_RUN = new RegExp(`^[a-z0-9_]{1,${MAX_CODE_CHARS}}`);

/** The code in a value: its leading run of lower-case letters, digits and underscores, at most 64 characters. Null when the value is not text or does not start with such a character. */
export function codeIn(value: unknown): string | null {
  return typeof value === 'string' ? (CODE_RUN.exec(value)?.[0] ?? null) : null;
}

export function failed(status: number | null, systemCode: string | null, sent: boolean, detail: string): SystemFailed {
  return { ok: false, code: 'mock_system_failed', status, systemCode, sent, detail };
}

type Parsed = { readonly json: true; readonly value: unknown } | { readonly json: false };

function parse(text: string): Parsed {
  try {
    return { json: true, value: JSON.parse(text) as unknown };
  } catch {
    return { json: false };
  }
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The result of an answer. `secrets` are the credential values of the call: the detail never shows them. This function reads the answer and sends nothing.
 */
export function readAnswer(status: number, text: string, secrets: readonly string[] = []): SystemResult {
  const parsed = parse(text);
  if (status >= 200 && status < 300) {
    return parsed.json ? { ok: true, status, body: parsed.value as JsonValue } : failed(status, null, true, `the body of the ${status} answer is not JSON`);
  }
  const body = parsed.json && isObject(parsed.value) ? parsed.value : null;
  const systemCode = body === null ? null : codeIn(body.error);
  if (status === 401 || status === 403) {
    if (!parsed.json) return failed(status, null, true, `the system answered ${status} with a body that is not JSON`);
    const message = body !== null && typeof body.message === 'string' ? `: ${safeText(body.message, secrets)}` : '';
    const reason = systemCode ?? REFUSAL_WITHOUT_CODE;
    return { ok: false, code: 'refused_by_system', reason, status, detail: `the system refused the call with ${status} (${reason})${message}` };
  }
  return failed(status, systemCode, true, `the system answered ${status}${systemCode === null ? '' : ` (${systemCode})`}`);
}
