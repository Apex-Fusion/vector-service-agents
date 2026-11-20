// packages/usecase-kit/test/access/answer.test.ts: the one rule that maps an HTTP answer of a mock system to a typed result. A refusal is never a success, and no code reads success from a text.
import { describe, expect, it } from 'vitest';
import { SYSTEM_REFUSALS, SYSTEM_REFUSAL_STATUS } from '../../src/protocol/index.ts';
import { MAX_CODE_CHARS, REFUSAL_WITHOUT_CODE, codeIn, readAnswer } from '../../src/access/index.ts';

const refusal = (error: unknown, message = 'words for a person'): string => JSON.stringify({ error, message });

describe('each refusal of a mock system that the protocol names', () => {
  it.each(SYSTEM_REFUSALS.map((code) => [code, SYSTEM_REFUSAL_STATUS[code]] as const))('%s with %i is refused_by_system with its own code', (code, status) => {
    const result = readAnswer(status, refusal(code));
    expect(result).toMatchObject({ ok: false, code: 'refused_by_system', reason: code, status });
  });

  it.each(SYSTEM_REFUSALS)('%s is the same refusal at the other refusal status, and a failure at any other status', (code) => {
    const status = SYSTEM_REFUSAL_STATUS[code];
    expect(readAnswer(status === 401 ? 403 : 401, refusal(code))).toMatchObject({ ok: false, code: 'refused_by_system', reason: code });
    for (const other of [200, 400, 404, 409, 500, 503]) {
      const result = readAnswer(other, refusal(code));
      expect(result.ok === true || result.code === 'refused_by_system', `${code} at ${other}`).toBe(other === 200);
    }
  });
});

describe('a 401 or a 403', () => {
  it('is a refusal even when the body says ok', () => {
    expect(readAnswer(403, JSON.stringify({ ok: true }))).toMatchObject({ ok: false, code: 'refused_by_system', reason: REFUSAL_WITHOUT_CODE, status: 403 });
    expect(readAnswer(401, JSON.stringify({ ok: true, error: 'token_invalid' }))).toMatchObject({ ok: false, code: 'refused_by_system', reason: 'token_invalid' });
    expect(readAnswer(403, JSON.stringify({ ok: true, allowed: true, status: 200 }))).toMatchObject({ ok: false, code: 'refused_by_system' });
  });

  it('passes a code that the protocol does not list on as it is', () => {
    expect(readAnswer(403, refusal('organisation_mismatch'))).toMatchObject({ reason: 'organisation_mismatch' });
    expect(readAnswer(401, refusal('svid_missing'))).toMatchObject({ reason: 'svid_missing' });
  });

  it('cuts a code to the characters of a code and to 64 characters', () => {
    expect(readAnswer(403, refusal('x'.repeat(100)))).toMatchObject({ reason: 'x'.repeat(MAX_CODE_CHARS) });
    expect(readAnswer(403, refusal('x'.repeat(64)))).toMatchObject({ reason: 'x'.repeat(64) });
    expect(readAnswer(403, refusal('not_covered: the delegation of the token does not cover the route'))).toMatchObject({ reason: 'not_covered' });
    expect(readAnswer(403, refusal('not_covered\nfake line'))).toMatchObject({ reason: 'not_covered' });
  });

  it.each([['Not_Covered'], [' not_covered'], ['!'], [''], [42], [null], [['not_covered']], [{ code: 'x' }]])('names no code for the error %j', (error) => {
    expect(readAnswer(403, refusal(error))).toMatchObject({ ok: false, code: 'refused_by_system', reason: REFUSAL_WITHOUT_CODE });
  });

  it('names no code when the body is JSON and not an object, and it is still a refusal', () => {
    for (const body of ['null', '[]', '"forbidden"', '7', 'true']) expect(readAnswer(403, body), body).toMatchObject({ ok: false, code: 'refused_by_system', reason: REFUSAL_WITHOUT_CODE });
  });

  it('is a failure, and not a refusal, when the body is not JSON: a proxy can answer 403 and not the system', () => {
    for (const status of [401, 403]) {
      for (const body of ['', '<html>Forbidden</html>', 'not_covered']) expect(readAnswer(status, body), `${status} ${body}`).toMatchObject({ ok: false, code: 'mock_system_failed', status, sent: true });
    }
  });

  it('shows the message of the system as a detail that is printable, cut, and free of the credential', () => {
    const credential = 'DPoP eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJ4In0.signaturesignature';
    const result = readAnswer(403, refusal('not_covered', `the call ${credential}\u0000\u001b[31m ${'y'.repeat(400)}`), [credential]);
    expect(result.ok === false && result.detail).toBeTypeOf('string');
    const detail = result.ok === false ? result.detail : '';
    expect(detail).not.toContain('eyJhbGciOiJFUzI1NiJ9');
    expect(detail).not.toContain('\u0000');
    expect(detail.length).toBeLessThan(300);
  });
});

describe('a 2xx', () => {
  it('gives the JSON body, whatever its shape: the caller reads the shape', () => {
    expect(readAnswer(200, '{"sku":"GLV-NIT-M","on_hand":12}')).toStrictEqual({ ok: true, status: 200, body: { sku: 'GLV-NIT-M', on_hand: 12 } });
    expect(readAnswer(201, '{"record_id":"r1"}')).toMatchObject({ ok: true, status: 201 });
    expect(readAnswer(200, '[1,2]')).toMatchObject({ ok: true, body: [1, 2] });
  });

  it('is a failure when the body is not JSON, or empty', () => {
    for (const body of ['', 'OK', '<html></html>', '{"sku":', 'undefined']) expect(readAnswer(200, body), body).toMatchObject({ ok: false, code: 'mock_system_failed', status: 200, sent: true });
    expect(readAnswer(204, '')).toMatchObject({ ok: false, code: 'mock_system_failed' });
  });
});

describe('every other status', () => {
  it.each([301, 302, 307, 400, 404, 405, 409, 413, 415, 421, 422, 429, 500, 502, 503, 504])('%i is mock_system_failed', (status) => {
    expect(readAnswer(status, '{}')).toMatchObject({ ok: false, code: 'mock_system_failed', status, systemCode: null, sent: true });
  });

  it('keeps the code of the body, so that a caller can tell a duplicate order from a missing item', () => {
    expect(readAnswer(409, refusal('duplicate_po'))).toMatchObject({ code: 'mock_system_failed', status: 409, systemCode: 'duplicate_po' });
    expect(readAnswer(404, refusal('sku_not_found'))).toMatchObject({ code: 'mock_system_failed', systemCode: 'sku_not_found' });
    expect(readAnswer(503, refusal('gateway_unavailable'))).toMatchObject({ code: 'mock_system_failed', systemCode: 'gateway_unavailable' });
    expect(readAnswer(421, 'not json')).toMatchObject({ code: 'mock_system_failed', systemCode: null });
  });

  it('is a failure at a status that no mock system uses, even with a refusal code in the body', () => {
    expect(readAnswer(402, refusal('not_covered'))).toMatchObject({ ok: false, code: 'mock_system_failed' });
    expect(readAnswer(400, refusal('not_covered'))).toMatchObject({ ok: false, code: 'mock_system_failed', systemCode: 'not_covered' });
  });
});

describe('codeIn', () => {
  it('takes the leading run of a code and nothing else', () => {
    expect(codeIn('not_covered')).toBe('not_covered');
    expect(codeIn('a1_b2 extra')).toBe('a1_b2');
    expect(codeIn('Not')).toBeNull();
    expect(codeIn(undefined)).toBeNull();
  });
});
