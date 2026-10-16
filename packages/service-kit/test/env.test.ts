// packages/service-kit/test/env.test.ts
import { describe, test, expect } from 'vitest';
import {
  STATUS_CHIPS, assertHeaderValue, assertNoTokenIn, envInt, given, hexOf, refuseSecretIn, refuseTokenIn, requiredEnv, shown, statusChip, statusSince, tokenForms,
} from '../src/env.ts';

const TOKEN = `Bearer ${'ab'.repeat(32)}`;

describe('settings that never print a secret', () => {
  test('shown: a short plain value as JSON, a long or hex-shaped one as its length', () => {
    expect(shown('ninety')).toBe('"ninety"');
    expect(shown('x'.repeat(25))).toBe('25 characters');
    expect(shown('ab'.repeat(10))).toBe('20 characters');
  });
  test('envInt: absent or empty is the default, a whole number is used, anything else names the variable and never shows a long value', () => {
    expect(envInt('PORT', undefined, 9093)).toBe(9093);
    expect(envInt('PORT', '', 9093)).toBe(9093);
    expect(envInt('PORT', '8080', 9093)).toBe(8080);
    for (const bad of ['-1', '1.5', 'ninety', ' 1', '9007199254740993']) expect(() => envInt('PORT', bad, 1), bad).toThrow(/^environment variable PORT must be a non-negative integer, got /);
    expect(() => envInt('PORT', 'ab'.repeat(32), 1)).toThrow(/got 64 characters$/);
  });
  test('requiredEnv: unset, empty and blank are refused with the variable and what it is for; a value is trimmed', () => {
    for (const v of [undefined, '', ' ', '\t\n']) expect(() => requiredEnv('OPERATOR_CONTACT', v, 'the contact'), JSON.stringify(v)).toThrow('environment variable OPERATOR_CONTACT is required (the contact) and is not set');
    expect(requiredEnv('OPERATOR_CONTACT', ' ops@example.test\n', 'the contact')).toBe('ops@example.test');
  });
  test('statusChip and statusSince: the fallback when absent, the three words in any case, a date as YYYY-MM-DD', () => {
    expect(STATUS_CHIPS).toStrictEqual(['LIVE', 'DEPLOYED', 'PROPOSED']);
    expect(statusChip(undefined, 'proposed')).toBe('proposed');
    expect(statusChip('', 'deployed')).toBe('deployed');
    expect(statusChip('Deployed', 'proposed')).toBe('deployed');
    expect(() => statusChip('launched', 'proposed')).toThrow('environment variable AGENT_STATUS_CHIP must be one of LIVE, DEPLOYED, PROPOSED, got "launched"');
    expect(statusSince(undefined, '2026-10-13')).toBe('2026-10-13');
    expect(statusSince(' 2026-10-14 ', '2026-10-13')).toBe('2026-10-14');
    expect(() => statusSince('2026-10-1', '2026-10-13')).toThrow(/^environment variable AGENT_STATUS_SINCE must be a date as YYYY-MM-DD/);
  });
  test('given trims; hexOf lowers the case and refuses with the length, never the value', () => {
    expect(given(undefined)).toBe('');
    expect(given(' x ')).toBe('x');
    expect(hexOf('SUPPLIER_PKH', 'AB'.repeat(28), 28)).toBe('ab'.repeat(28));
    expect(() => hexOf('SUPPLIER_PKH', 'ab', 28)).toThrow('environment variable SUPPLIER_PKH must be 56 hex characters, and it has 2 characters');
    expect(() => hexOf('SUPPLIER_PKH', 'zz'.repeat(28), 28)).toThrow('environment variable SUPPLIER_PKH must be 56 hex characters, and some of its 56 characters are not hex');
  });
  test('refuseSecretIn looks in every setting it is given but the own line, in any case, inside a longer value too', () => {
    const settings = ['AGENT_DID', 'OPERATOR_CONTACT', 'SERVICE_AUTH_HEADER'];
    const refusal = (name: string) => `found in ${name}`;
    expect(() => refuseSecretIn({ AGENT_DID: `did:${'AB'.repeat(32)}` }, settings, ['ab'.repeat(32)], 'SERVICE_AUTH_HEADER', refusal)).toThrow('found in AGENT_DID');
    expect(() => refuseSecretIn({ SERVICE_AUTH_HEADER: 'ab'.repeat(32) }, settings, ['ab'.repeat(32)], 'SERVICE_AUTH_HEADER', refusal)).not.toThrow();
    expect(() => refuseSecretIn({ OTHER: 'ab'.repeat(32) }, settings, ['ab'.repeat(32)], 'SERVICE_AUTH_HEADER', refusal)).not.toThrow();
  });
  test('the token is looked for whole and by its credential, each when 16 characters or more, and found it is refused, unprinted', () => {
    expect(tokenForms(TOKEN)).toStrictEqual([TOKEN.toLowerCase(), 'ab'.repeat(32)]);
    expect(tokenForms('Bearer short')).toStrictEqual([]);
    expect(() => refuseTokenIn({ AGENT_DID: `x${'AB'.repeat(32)}` }, ['AGENT_DID'], TOKEN)).toThrow('environment variable AGENT_DID holds the service token, which belongs in SERVICE_AUTH_HEADER alone: it would be printed or published. Take it out of AGENT_DID');
    expect(() => assertNoTokenIn(`{"did":"${'ab'.repeat(32)}"}`, TOKEN)).toThrow('the manifest would publish the service token: a value that goes into it holds the token of SERVICE_AUTH_HEADER, and the service does not start with it');
    expect(() => assertNoTokenIn('{"did":""}', TOKEN)).not.toThrow();
  });
  test('assertHeaderValue: printable ASCII passes; anything else is refused with the length only', () => {
    expect(() => assertHeaderValue('SERVICE_AUTH_HEADER', TOKEN)).not.toThrow();
    expect(() => assertHeaderValue('SERVICE_AUTH_HEADER', 'Bearer a\nb')).toThrow('environment variable SERVICE_AUTH_HEADER must be printable ASCII (it is sent as an HTTP header), and it has 10 characters');
  });
});
