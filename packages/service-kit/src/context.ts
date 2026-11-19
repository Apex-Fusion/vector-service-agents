// packages/service-kit/src/context.ts
// The context of a call. The runtime tells the service what it knows of the escrow of a pre-check or of a job, in six headers (the names are in
// CONTEXT_HEADERS). The server reads them once, checks the form of each, and gives them to the service's code as one typed object, a JobContext.
//
//   - A call with none of the six has no context. That is no error: a runtime that sends no context header works as it always did.
//   - A call with some of the six, but not all, is refused: the six come together.
//   - A call with a header in a form that is not the right one is refused too. The message names the header and the form, and never the value.
//
// The server answers each refusal with 400 {error: "bad_context", message}, and reads the headers only after the call has shown the token of the runtime.
import type { IncomingHttpHeaders } from 'node:http';

/** What the runtime says about the escrow of a call. Each field comes from one header, and its form is checked before the object is made. */
export interface JobContext {
  /** The escrow output that the call is about: `<64 hex characters>#<output index>`, with the hex in lower case. */
  readonly escrowRef: string;
  /** The advert output that the escrow was posted against, in the same form. */
  readonly advertRef: string;
  /** The model text of the advert: 1 to 256 printable ASCII characters. */
  readonly advertModel: string;
  /** The key hash of the buyer: 56 hex characters, in lower case. */
  readonly buyerPkh: string;
  /** The payment of the escrow in lovelace, as the runtime states it. */
  readonly paymentLovelace: bigint;
  /** The time by which the job must be delivered, in milliseconds since 1970. */
  readonly deliverByMs: number;
}

/** The header that holds each field of the context. */
export const CONTEXT_HEADERS = {
  escrowRef: 'x-vector-escrow-ref',
  advertRef: 'x-vector-advert-ref',
  advertModel: 'x-vector-advert-model',
  buyerPkh: 'x-vector-buyer-pkh',
  paymentLovelace: 'x-vector-payment-lovelace',
  deliverByMs: 'x-vector-deliver-by-ms',
} as const satisfies Record<keyof JobContext, string>;

/** A call whose context headers are not as they must be. The server answers it with `status`, and with `code` and the message as the body. */
export class ContextError extends Error {
  readonly code = 'bad_context';
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = 'ContextError';
  }
}

// An output index has at most 10 digits (it is far under 2^32), a payment at most 19 (more than all the lovelace there is), a time at most 16 (and then a
// number must hold it exactly). A leading zero, a sign, a point and an exponent are not part of a whole number here.
const REFERENCE = /^([0-9a-fA-F]{64})#(0|[1-9][0-9]{0,9})$/;
const KEY_HASH = /^[0-9a-fA-F]{56}$/;
const LOVELACE = /^(?:0|[1-9][0-9]{0,18})$/;
const MILLISECONDS = /^(?:0|[1-9][0-9]{0,15})$/;
const MODEL = /^[ -~]{1,256}$/;

const REFERENCE_FORM = 'a transaction hash of 64 hex characters, "#" and an output index';

/** `<hash>#<index>` with the hash in lower case, or undefined when the text is not a reference. */
function reference(text: string): string | undefined {
  const match = REFERENCE.exec(text);
  return match === null ? undefined : `${match[1].toLowerCase()}#${match[2]}`;
}

/** The value of one field: what `parse` makes of its header, or a refusal that names the header and the form. */
function read<T>(headers: IncomingHttpHeaders, field: keyof JobContext, form: string, parse: (text: string) => T | undefined): T {
  const value = headers[CONTEXT_HEADERS[field]];
  // A header that came more than once is a list, and a list is no one text.
  const parsed = typeof value === 'string' ? parse(value) : undefined;
  if (parsed === undefined) throw new ContextError(`the header ${CONTEXT_HEADERS[field]} must be ${form}`);
  return parsed;
}

/**
 * The context of a call, from its headers: undefined when none of the six is there, a JobContext when all six are there in their form, and a ContextError
 * for anything between. The headers are checked in the order of CONTEXT_HEADERS, and the first that is wrong is the one named.
 */
export function parseContext(headers: IncomingHttpHeaders): JobContext | undefined {
  const fields = Object.keys(CONTEXT_HEADERS) as Array<keyof JobContext>;
  if (fields.every((field) => headers[CONTEXT_HEADERS[field]] === undefined)) return undefined;
  const missing = fields.find((field) => headers[CONTEXT_HEADERS[field]] === undefined);
  if (missing !== undefined) throw new ContextError(`the context headers come all together, and ${CONTEXT_HEADERS[missing]} is missing`);
  return {
    escrowRef: read(headers, 'escrowRef', REFERENCE_FORM, reference),
    advertRef: read(headers, 'advertRef', REFERENCE_FORM, reference),
    advertModel: read(headers, 'advertModel', 'text of 1 to 256 printable ASCII characters', (text) => (MODEL.test(text) ? text : undefined)),
    buyerPkh: read(headers, 'buyerPkh', 'a key hash of 56 hex characters', (text) => (KEY_HASH.test(text) ? text.toLowerCase() : undefined)),
    paymentLovelace: read(
      headers, 'paymentLovelace', 'a whole number of lovelace, with no sign and no leading zero, of at most 19 digits',
      (text) => (LOVELACE.test(text) ? BigInt(text) : undefined),
    ),
    deliverByMs: read(headers, 'deliverByMs', 'a whole number of milliseconds since 1970, with no sign and no leading zero, that a number holds exactly', (text) => {
      if (!MILLISECONDS.test(text)) return undefined;
      const ms = Number(text);
      return Number.isSafeInteger(ms) ? ms : undefined;
    }),
  };
}

/** The context of a call that cannot do without one, such as a pre-check: the same as parseContext, and a ContextError when no header is there. */
export function requireContext(headers: IncomingHttpHeaders): JobContext {
  const context = parseContext(headers);
  if (context === undefined) throw new ContextError(`the pre-check needs the context headers: ${Object.values(CONTEXT_HEADERS).join(', ')}`);
  return context;
}
