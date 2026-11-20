// packages/usecase-kit/src/protocol/result.ts
// The typed result of a validator. A caller never reads success from a text: a result has `ok`, and a refusal names the rule that failed with `code`.

/** A value that passed. `value` is the value in the form that the protocol names. */
export interface Accepted<T> {
  readonly ok: true;
  readonly value: T;
}

/** A value that did not pass. `code` names the rule that failed. `detail` is one sentence for a log. It names the field and the form, and it never repeats the value that failed. */
export interface Refused<C extends string = 'bad_shape'> {
  readonly ok: false;
  readonly code: C;
  readonly detail: string;
}

/** What a validator returns. The code of a form that is wrong is `bad_shape`. */
export type ProtocolResult<T, C extends string = 'bad_shape'> = Accepted<T> | Refused<C>;

export const accepted = <T>(value: T): Accepted<T> => ({ ok: true, value });
export const refused = <C extends string>(code: C, detail: string): Refused<C> => ({ ok: false, code, detail });
