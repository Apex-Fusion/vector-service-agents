// packages/usecase-kit/src/checks/precheck.ts
// The checks of a counterparty as the `precheck` option of service-kit. The runtime asks it before it claims the escrow, so a refusal leaves the escrow open and nothing is paid.
//
//   every check passed   { go: true }
//   a refusal            { go: false, status, error: <code>, message }    the status is the status of the code in ERROR_STATUS: 403 for the code of a rule, 503 for `check_unavailable`
//   a fault of the code  the answer is a rejection, and service-kit answers 500 and never a go
//
// The checks of the kind come after the shared ones. A check of the kind refuses with a code of its own page, and the code must come before the Claim.
// That is a code that COUNTERPARTY_REFUSALS lists for the kind, that the shared checks do not own, and that AFTER_CLAIM_REFUSALS does not list. Any other code is a fault of the check.
import type { JobContext, PrecheckAnswer } from '@vsa/service-kit';
import {
  AFTER_CLAIM_REFUSALS, APPROVAL_REFUSALS, COUNTERPARTY_KINDS, COUNTERPARTY_REFUSALS, DELEGATION_REFUSALS, ERROR_STATUS, SENDER_REFUSALS, VAULT_REFUSALS, isPlainObject,
} from '../protocol/index.ts';
import type { CounterpartyKind } from '../protocol/index.ts';
import { reportFault } from './ports.ts';
import type { ChecksPorts } from './ports.ts';
import { runChecks } from './run.ts';
import type { CheckStep, ChecksRecord, ChecksRefused, StepResult } from './run.ts';
import { SHARED_CHECK_NAMES, sharedChecks } from './shared.ts';
import type { RequestOf, SharedInput } from './shared.ts';

/** A check of one kind of counterparty, such as the checks of the purchase order of an Order Desk. It runs after the shared checks. */
export interface ExtraCheck<R> {
  /** The name that a pass records. It is not a name of a shared check, and it is unique in the list. */
  readonly names: readonly [string, ...string[]];
  readonly run: (request: R, context: JobContext) => Promise<StepResult>;
}

export interface PrecheckOptions<K extends CounterpartyKind> {
  readonly kind: K;
  readonly ports: ChecksPorts;
  /** The checks of the kind, in order. */
  readonly extra?: readonly ExtraCheck<RequestOf<K>>[];
  /** Called when every check passed, before the answer is a go. It gets the record of the checks. A hook that throws makes the answer a fault, and never a go. */
  readonly onPass?: (record: ChecksRecord, request: RequestOf<K>, context: JobContext) => void | Promise<void>;
  /**
   * Called with a refusal before the answer is written. It can act on the refusal, for example file a challenge when the digest of the approval does not match.
   * It can give a text that goes after the message. THE TEXT GOES TO THE BUYER, so it must hold no secret. The use is a reference to a challenge.
   * The whole message is cut to MESSAGE_LIMIT characters, so a long text loses its end.
   * A hook that throws changes nothing: the refusal is still the answer, and the service is told through `onFault` of the ports.
   */
  readonly onRefused?: (refusal: ChecksRefused, request: RequestOf<K>, context: JobContext) => string | void | Promise<string | void>;
}

/** The most characters that the message of a refusal has. The message goes to the buyer, so its length has a limit. */
export const MESSAGE_LIMIT = 300;

/** The text cut to `max` characters. A surrogate pair is not split: a half of it is not a character. */
function cut(text: string, max: number): string {
  if (text.length <= max) return text;
  const last = text.charCodeAt(max - 1);
  return text.substring(0, last >= 0xd800 && last <= 0xdbff ? max - 1 : max);
}

const SHARED_CODES: readonly string[] = [...SENDER_REFUSALS, ...DELEGATION_REFUSALS, ...VAULT_REFUSALS, ...APPROVAL_REFUSALS];

/** The refusal codes that a check of the kind may answer: the codes of its own page that come before the Claim. */
function ownCodes(kind: CounterpartyKind): ReadonlySet<string> {
  const after: readonly string[] = AFTER_CLAIM_REFUSALS;
  return new Set(COUNTERPARTY_REFUSALS[kind].filter((code) => !SHARED_CODES.includes(code) && !after.includes(code)));
}

function assertOptions<K extends CounterpartyKind>(options: PrecheckOptions<K>): void {
  if (!isPlainObject(options) || !(COUNTERPARTY_KINDS as readonly unknown[]).includes(options.kind)) throw new TypeError(`kind must be one of ${COUNTERPARTY_KINDS.join(', ')}`);
  if (!isPlainObject(options.ports)) throw new TypeError('ports must be an object');
  for (const hook of [options.onPass, options.onRefused]) if (hook !== undefined && typeof hook !== 'function') throw new TypeError('a hook must be a function');
  const taken = new Set<string>(SHARED_CHECK_NAMES[options.kind]);
  for (const extra of options.extra ?? []) {
    if (!isPlainObject(extra) || typeof extra.run !== 'function' || !Array.isArray(extra.names) || extra.names.length === 0) throw new TypeError('a check of the kind has names and a run function');
    for (const name of extra.names) {
      if (typeof name !== 'string' || name === '' || taken.has(name)) throw new TypeError(`the name of a check of the kind must be a text that no other check has (${String(name)})`);
      taken.add(name);
    }
  }
}

/** The check of the kind as a step. A refusal with a code that the kind may not give before the Claim is a fault. The run reads the rest of the answer strictly. */
function stepOf<K extends CounterpartyKind>(extra: ExtraCheck<RequestOf<K>>, allowed: ReadonlySet<string>, request: RequestOf<K>, context: JobContext): CheckStep {
  return {
    names: extra.names,
    run: async () => {
      const result = await extra.run(request, context);
      if (isPlainObject(result) && result.ok === false && result.code !== 'check_unavailable' && !(typeof result.code === 'string' && allowed.has(result.code))) {
        throw new TypeError(`the check ${extra.names[0]} refused with a code that this kind does not give before the Claim`);
      }
      return result;
    },
  };
}

/**
 * The `precheck` option of service-kit for a counterparty of this kind: the shared checks, then the checks of the kind, in order. It answers `{ go: true }` only when every check passed.
 * A refusal is the status and the code of the protocol with a message. It throws a TypeError for options of the wrong form.
 */
export function precheckOf<K extends CounterpartyKind>(options: PrecheckOptions<K>): (request: RequestOf<K>, context: JobContext) => Promise<PrecheckAnswer> {
  assertOptions(options);
  const { kind, ports, onPass, onRefused } = options;
  const extras = options.extra ?? [];
  const allowed = ownCodes(kind);
  return async (request, context) => {
    const shared = sharedChecks(ports, { kind, request, context } as SharedInput);
    const outcome = await runChecks([...shared, ...extras.map((extra) => stepOf(extra, allowed, request, context))]);
    if (outcome.ok) {
      await onPass?.(outcome.record, request, context);
      return { go: true };
    }
    let message = outcome.detail;
    if (onRefused !== undefined) {
      try {
        const note = await onRefused(outcome, request, context);
        if (typeof note === 'string' && note !== '') message = `${message} ${note}`;
      } catch (cause) {
        reportFault(ports, 'refusal hook', cause);
      }
    }
    return { go: false, status: ERROR_STATUS[outcome.code], error: outcome.code, message: cut(message, MESSAGE_LIMIT) };
  };
}
