// packages/usecase-kit/test/cosign/settings.test.ts
// The settings of the route: the names, the defaults, and the check of the values. A value of the wrong type or outside its range is a refusal, and never "no limit".
import { describe, expect, it } from 'vitest';
import { Allowlist, COSIGN_SETTINGS, DEFAULT_LIMITS, MAX_WINDOW_MS, checkCosignSettings, parseAllowlist, parseCosignSettings } from '@vsa/usecase-kit/cosign';

const K1 = 'a1'.repeat(28);
const MARKER = '77777.5-marker';
const list = (): Allowlist => {
  const result = parseAllowlist(K1);
  if (!result.ok) throw new Error(result.detail);
  return result.value;
};

describe('the names of the settings', () => {
  it('are the names that the service reads', () => {
    expect(COSIGN_SETTINGS).toEqual({
      allowlist: 'COSIGN_ALLOWLIST', maxConcurrent: 'COSIGN_MAX_CONCURRENT', maxFutureMs: 'COSIGN_MAX_FUTURE_MS', ledgerTimeoutMs: 'COSIGN_LEDGER_TIMEOUT_MS',
    });
  });
});

describe('parseCosignSettings', () => {
  it('takes the default of each limit that is missing', () => {
    const result = parseCosignSettings({ COSIGN_ALLOWLIST: K1 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect({ ...result.value, allowlist: result.value.allowlist.keys() }).toEqual({ allowlist: [K1], maxConcurrent: 4, maxFutureMs: MAX_WINDOW_MS, ledgerTimeoutMs: 5_000 });
    expect(DEFAULT_LIMITS).toEqual({ maxConcurrent: 4, maxFutureMs: 3_600_000, ledgerTimeoutMs: 5_000 });
  });

  it('reads each limit as whole decimal digits', () => {
    const result = parseCosignSettings({ COSIGN_ALLOWLIST: '', COSIGN_MAX_CONCURRENT: '9', COSIGN_MAX_FUTURE_MS: '120000', COSIGN_LEDGER_TIMEOUT_MS: '250' });
    expect(result).toMatchObject({ ok: true, value: { maxConcurrent: 9, maxFutureMs: 120_000, ledgerTimeoutMs: 250 } });
    expect(result.ok && result.value.allowlist.size).toBe(0);
  });

  it.each([
    ['COSIGN_MAX_CONCURRENT', '1', '64', '0', '65'],
    ['COSIGN_MAX_FUTURE_MS', '60000', '3600000', '59999', '3600001'],
    ['COSIGN_LEDGER_TIMEOUT_MS', '50', '30000', '49', '30001'],
  ])('takes the range of %s from %s to %s, and refuses %s and %s', (name, low, high, below, above) => {
    for (const ok of [low, high]) expect(parseCosignSettings({ COSIGN_ALLOWLIST: K1, [name]: ok })).toMatchObject({ ok: true });
    for (const bad of [below, above]) {
      const result = parseCosignSettings({ COSIGN_ALLOWLIST: K1, [name]: bad });
      expect(result).toMatchObject({ ok: false, code: 'bad_setting' });
      if (!result.ok) expect(result.detail).toContain(name);
    }
  });

  it.each(['', ' 4', '4 ', '4.5', '-1', '+4', '1e3', '0x10', 'four', '４', '9'.repeat(16), '04x'])('refuses the limit %j: it is not whole decimal digits in range', (text) => {
    for (const name of ['COSIGN_MAX_CONCURRENT', 'COSIGN_MAX_FUTURE_MS', 'COSIGN_LEDGER_TIMEOUT_MS']) {
      expect(parseCosignSettings({ COSIGN_ALLOWLIST: K1, [name]: text }), name).toMatchObject({ ok: false, code: 'bad_setting' });
    }
  });

  it('refuses a value that is not text, also for a limit', () => {
    const wrong = { COSIGN_ALLOWLIST: K1, COSIGN_MAX_CONCURRENT: 4 } as unknown as Record<string, string>;
    expect(parseCosignSettings(wrong)).toMatchObject({ ok: false, code: 'bad_setting' });
    expect(parseCosignSettings({ COSIGN_ALLOWLIST: 7 } as unknown as Record<string, string>)).toMatchObject({ ok: false });
    expect(parseCosignSettings({ COSIGN_ALLOWLIST: K1, COSIGN_MAX_CONCURRENT: null } as unknown as Record<string, string>)).toMatchObject({ ok: false });
  });

  it('refuses a missing allowlist and names it, and an allowlist with an entry that is not a key', () => {
    const missing = parseCosignSettings({});
    expect(missing).toMatchObject({ ok: false, code: 'bad_setting' });
    if (!missing.ok) expect(missing.detail).toContain('COSIGN_ALLOWLIST');
    expect(parseCosignSettings({ COSIGN_ALLOWLIST: `${K1}\nnot a key` })).toMatchObject({ ok: false, code: 'bad_setting' });
  });

  it('does not repeat the value of a setting in its refusal', () => {
    for (const name of ['COSIGN_MAX_CONCURRENT', 'COSIGN_MAX_FUTURE_MS', 'COSIGN_LEDGER_TIMEOUT_MS']) {
      const result = parseCosignSettings({ COSIGN_ALLOWLIST: K1, [name]: MARKER });
      expect(JSON.stringify(result)).not.toContain(MARKER);
    }
    expect(JSON.stringify(parseCosignSettings({ COSIGN_ALLOWLIST: MARKER }))).not.toContain(MARKER);
  });
});

describe('checkCosignSettings', () => {
  const good = () => ({ allowlist: list(), maxConcurrent: 4, maxFutureMs: 600_000, ledgerTimeoutMs: 2_000 });

  it('takes the values that are of the right type and in range, and gives only the settings', () => {
    const result = checkCosignSettings({ ...good(), extra: 'x' });
    expect(result).toMatchObject({ ok: true, value: { maxConcurrent: 4, maxFutureMs: 600_000, ledgerTimeoutMs: 2_000 } });
    expect(result.ok && Object.keys(result.value).sort()).toEqual(['allowlist', 'ledgerTimeoutMs', 'maxConcurrent', 'maxFutureMs']);
  });

  it.each([
    ['maxConcurrent', Infinity], ['maxConcurrent', Number.NaN], ['maxConcurrent', '4'], ['maxConcurrent', null], ['maxConcurrent', undefined], ['maxConcurrent', 3.5], ['maxConcurrent', 0],
    ['maxConcurrent', Number.MAX_SAFE_INTEGER], ['maxFutureMs', Infinity], ['maxFutureMs', 0], ['maxFutureMs', -1], ['maxFutureMs', 4_000_000], ['maxFutureMs', 600_000.5],
    ['ledgerTimeoutMs', Infinity], ['ledgerTimeoutMs', 0], ['ledgerTimeoutMs', true], ['ledgerTimeoutMs', 30_001],
  ])('refuses %s = %s: a wrong type or a value out of range is an error, and never "no limit"', (name, value) => {
    expect(checkCosignSettings({ ...good(), [name]: value })).toMatchObject({ ok: false, code: 'bad_setting' });
  });

  it('refuses an allowlist that is not an Allowlist: a set, a list, a text', () => {
    for (const allowlist of [new Set([K1]), [K1], K1, null, undefined]) expect(checkCosignSettings({ ...good(), allowlist })).toMatchObject({ ok: false, code: 'bad_setting' });
  });

  it('refuses settings that are not an object', () => {
    for (const value of [null, undefined, 5, 'settings']) expect(checkCosignSettings(value)).toMatchObject({ ok: false, code: 'bad_setting' });
  });
});
