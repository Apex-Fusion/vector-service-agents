// packages/service-kit/test/context.test.ts
// The six context headers of the runtime: their names, their forms, and the typed object they become.
import { describe, test, expect } from 'vitest';
import { CONTEXT_HEADERS, ContextError, parseContext, requireContext } from '../src/context.ts';
import type { JobContext } from '../src/context.ts';

type Headers = Record<string, string | string[] | undefined>;

const HASH_A = 'a1'.repeat(32);
const HASH_B = 'b2'.repeat(32);
const KEY_HASH = 'c3'.repeat(28);
const GOOD: Record<string, string> = {
  'x-vector-escrow-ref': `${HASH_A}#0`,
  'x-vector-advert-ref': `${HASH_B}#1`,
  'x-vector-advert-model': 'test-model-v1',
  'x-vector-buyer-pkh': KEY_HASH,
  'x-vector-payment-lovelace': '5500000',
  'x-vector-deliver-by-ms': '1763600000000',
};
const GOOD_CONTEXT: JobContext = {
  escrowRef: `${HASH_A}#0`, advertRef: `${HASH_B}#1`, advertModel: 'test-model-v1', buyerPkh: KEY_HASH, paymentLovelace: 5_500_000n, deliverByMs: 1_763_600_000_000,
};

/** The refusal that `parseContext` throws for these headers; the test fails when it accepts them. */
function refused(headers: Headers): ContextError {
  try { parseContext(headers); } catch (e) {
    if (e instanceof ContextError) return e;
    throw e;
  }
  throw new Error(`the headers were accepted: ${JSON.stringify(headers, (_k, v: unknown) => (typeof v === 'bigint' ? String(v) : v))}`);
}
const withHeader = (name: string, value: string | string[] | undefined): Headers => ({ ...GOOD, [name]: value });

describe('the context headers', () => {
  test('the six names are the ones the runtime sends, one for each field of the context', () => {
    expect(CONTEXT_HEADERS).toStrictEqual({
      escrowRef: 'x-vector-escrow-ref',
      advertRef: 'x-vector-advert-ref',
      advertModel: 'x-vector-advert-model',
      buyerPkh: 'x-vector-buyer-pkh',
      paymentLovelace: 'x-vector-payment-lovelace',
      deliverByMs: 'x-vector-deliver-by-ms',
    });
  });

  test('six headers in the right form are one typed context: hex in lower case, the payment as a bigint, the deadline as a number', () => {
    const context = parseContext(GOOD);
    expect(context).toStrictEqual(GOOD_CONTEXT);
    expect(typeof context?.paymentLovelace).toBe('bigint');
    expect(typeof context?.deliverByMs).toBe('number');
    // The twin of the lower-case form: the same call with the hex in upper case is the same context.
    const upper = { ...GOOD, 'x-vector-escrow-ref': `${HASH_A.toUpperCase()}#0`, 'x-vector-advert-ref': `${HASH_B.toUpperCase()}#1`, 'x-vector-buyer-pkh': KEY_HASH.toUpperCase() };
    expect(parseContext(upper)).toStrictEqual(GOOD_CONTEXT);
  });

  test('other headers of the call are no matter, and the names are read whatever else is there', () => {
    expect(parseContext({ ...GOOD, authorization: 'Bearer x', 'content-type': 'application/json', 'x-vector-other': 'y' })).toStrictEqual(GOOD_CONTEXT);
  });

  test('none of the six is no context and no error; requireContext refuses it and lists the six', () => {
    expect(parseContext({})).toBeUndefined();
    expect(parseContext({ authorization: 'Bearer x', 'content-type': 'application/json' })).toBeUndefined();
    const error = ((): ContextError => { try { requireContext({}); } catch (e) { return e as ContextError; } throw new Error('accepted'); })();
    expect(error).toBeInstanceOf(ContextError);
    expect([error.code, error.status]).toStrictEqual(['bad_context', 400]);
    for (const name of Object.values(CONTEXT_HEADERS)) expect(error.message).toContain(name);
    // The twin: with the six, requireContext gives the same object as parseContext.
    expect(requireContext(GOOD)).toStrictEqual(GOOD_CONTEXT);
  });

  test('some of the six, but not all, is a refusal that names the header that is missing; the six together are the twin', () => {
    for (const name of Object.values(CONTEXT_HEADERS)) {
      const headers: Headers = { ...GOOD };
      delete headers[name];
      const error = refused(headers);
      expect([error.code, error.status], name).toStrictEqual(['bad_context', 400]);
      expect(error.message, name).toBe(`the context headers come all together, and ${name} is missing`);
    }
    expect(parseContext(GOOD)).toStrictEqual(GOOD_CONTEXT);
    // A header that is there and empty is there: its form is what is wrong.
    expect(refused(withHeader('x-vector-buyer-pkh', '')).message).toContain('x-vector-buyer-pkh must be');
  });

  test('a reference is 64 hex characters, "#" and an output index with no sign and no leading zero; each header that holds one is held to it', () => {
    const FORM = 'a transaction hash of 64 hex characters, "#" and an output index';
    const BAD = [
      '', HASH_A, `${HASH_A}#`, `#0`, `${HASH_A}0`, `${HASH_A}#-1`, `${HASH_A}#+1`, `${HASH_A}#01`, `${HASH_A}#1.5`, `${HASH_A}#1e3`, `${HASH_A}#0x1`, `${HASH_A}#12345678901`,
      `${HASH_A.slice(1)}#0`, `${HASH_A}a#0`, `${'g'.repeat(64)}#0`, ` ${HASH_A}#0`, `${HASH_A}#0 `, `${HASH_A}#0, ${HASH_B}#0`, `${HASH_A}##0`, `${HASH_A}#0#0`,
    ];
    for (const name of ['x-vector-escrow-ref', 'x-vector-advert-ref']) {
      for (const bad of BAD) {
        const error = refused(withHeader(name, bad));
        expect([error.code, error.status], `${name}: ${bad}`).toStrictEqual(['bad_context', 400]);
        expect(error.message, `${name}: ${bad}`).toContain(`the header ${name} must be ${FORM}`);
      }
      // The twins at the edge of the form.
      for (const [good, canonical] of [[`${HASH_B}#0`, `${HASH_B}#0`], [`${HASH_B}#7`, `${HASH_B}#7`], [`${HASH_B}#9999999999`, `${HASH_B}#9999999999`], [`${HASH_B.toUpperCase()}#12`, `${HASH_B}#12`]]) {
        const context = parseContext(withHeader(name, good));
        expect(name === 'x-vector-escrow-ref' ? context?.escrowRef : context?.advertRef, `${name}: ${good}`).toBe(canonical);
      }
    }
  });

  test('a key hash is 56 hex characters, and a transaction hash of 64 is not one', () => {
    for (const bad of ['', KEY_HASH.slice(1), `${KEY_HASH}a`, HASH_A, 'zz'.repeat(28), ` ${KEY_HASH}`]) {
      const error = refused(withHeader('x-vector-buyer-pkh', bad));
      expect(error.message, bad).toContain('the header x-vector-buyer-pkh must be a key hash of 56 hex characters');
      expect(error.message, 'the value is never in the message').not.toContain(bad.trim() === '' ? '\u0000' : bad.trim());
    }
    expect(parseContext(withHeader('x-vector-buyer-pkh', KEY_HASH.toUpperCase()))?.buyerPkh).toBe(KEY_HASH);
  });

  test('the payment is a whole number of at most 19 digits with no sign, no point, no exponent and no leading zero', () => {
    for (const bad of ['', '-1', '+1', '1.5', '1e6', '0x10', '01', '00', ' 5', '5 ', '5,5', '10000000000000000000', 'ten']) {
      expect(refused(withHeader('x-vector-payment-lovelace', bad)).message, JSON.stringify(bad)).toContain('the header x-vector-payment-lovelace must be a whole number of lovelace');
    }
    for (const [good, value] of [['0', 0n], ['1', 1n], ['5500000', 5_500_000n], ['9007199254740993', 9_007_199_254_740_993n], ['9999999999999999999', 9_999_999_999_999_999_999n]] as const) {
      expect(parseContext(withHeader('x-vector-payment-lovelace', good))?.paymentLovelace, good).toBe(value);
    }
  });

  test('the deadline is a whole number of milliseconds that a number holds exactly', () => {
    for (const bad of ['', '-1', '+1', '1.5', '1e12', '0x1', '01', ' 1', '1 ', '9007199254740992', '12345678901234567', 'soon']) {
      expect(refused(withHeader('x-vector-deliver-by-ms', bad)).message, JSON.stringify(bad)).toContain('the header x-vector-deliver-by-ms must be a whole number of milliseconds');
    }
    for (const [good, value] of [['0', 0], ['1763600000000', 1_763_600_000_000], ['9007199254740991', Number.MAX_SAFE_INTEGER]] as const) {
      expect(parseContext(withHeader('x-vector-deliver-by-ms', good))?.deliverByMs, good).toBe(value);
    }
  });

  test('the model comes written as encodeURIComponent writes it, for the text on the chain is free text and a header takes visible ASCII only; the kit decodes it once', () => {
    const FORM = 'the header x-vector-advert-model must be a model text of 1 to 256 characters with no control character, written as encodeURIComponent writes it';
    const GOOD_MODELS: Array<[sent: string, model: string]> = [
      ['a', 'a'], ['audio-snippets-v1', 'audio-snippets-v1'], ['qwen2.5%3A0.5b', 'qwen2.5:0.5b'], ['meta%2Fllama%203.1%208b', 'meta/llama 3.1 8b'],
      ['meta/llama 3.1 8b', 'meta/llama 3.1 8b'], // a plain text that needs no escape is read as it is
      ['Qw%C3%A9n', 'Qw\u00e9n'], ['%F0%9F%98%80', '\u{1F600}'], ['100%25', '100%'], ['%2525', '%25'], // a text is decoded once, never twice
      ['x'.repeat(256), 'x'.repeat(256)], ['%41'.repeat(256), 'A'.repeat(256)],
    ];
    for (const [sent, model] of GOOD_MODELS) expect(parseContext(withHeader('x-vector-advert-model', sent))?.advertModel, sent).toBe(model);
    const BAD = [
      '', 'x'.repeat(257), '%41'.repeat(257), // length: 1 to 256 characters once decoded
      'caf\u00e9', 'tab\there', 'line\nbreak', '\u007f', 'carriage\rreturn', '\u0000', // a character that is not visible ASCII, sent as it is
      '%', 'abc%', '%zz', '%4', '%E9', '%C3', '%C3%28', // an escape that is not one
      '%00', '%0A', '%0D', '%1B', '%7F', '%C2%80', '%C2%9F', // a control character, escaped
    ];
    for (const bad of BAD) expect(refused(withHeader('x-vector-advert-model', bad)).message, JSON.stringify(bad)).toBe(FORM);
  });

  test('a header that came more than once is no one text and is refused with its name', () => {
    for (const name of Object.values(CONTEXT_HEADERS)) {
      const error = refused(withHeader(name, [GOOD[name], GOOD[name]]));
      expect(error.message, name).toContain(`the header ${name} must be`);
    }
  });

  test('the message names the header and the form and never the value', () => {
    const secretLooking = 'ab'.repeat(27);
    const error = refused(withHeader('x-vector-buyer-pkh', secretLooking));
    expect(error.message).toBe('the header x-vector-buyer-pkh must be a key hash of 56 hex characters');
    expect(error.message).not.toContain(secretLooking);
    expect(error.name).toBe('ContextError');
  });

  test('the headers are checked in the order of the table, so the first one with a bad form is the one named', () => {
    const headers = { ...GOOD, 'x-vector-payment-lovelace': 'many', 'x-vector-advert-ref': 'nothing' };
    expect(refused(headers).message).toContain('x-vector-advert-ref');
  });
});
