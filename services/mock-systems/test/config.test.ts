// The settings of the service. Every setting is checked at the start: a wrong value stops the start and the error names the variable. The operator token is never in a message.
// Each refusal has its twin: the environment that is right.
import { describe, expect, it } from 'vitest';
import { GATEWAY_DEFAULT, HOST_DEFAULT, KOIOS_DEFAULT, OGMIOS_DEFAULT, PORT_DEFAULT, SETTINGS, loadConfig } from '../src/config.ts';

const TOKEN = 'T0ken-of-the-tests_0123456789.abcdef';
// The published values of the identity registry deployment of Vector mainnet: public chain data.
const ROOT = 'e4b6b17ce4a8f83aa17d3181ea140d2bd76c0cfa8a7c44ad69543800b4a0df01';
const SEED = '6c9856c70b1101f1a4e9ceb373188608013416eff48c51f5bb62706a65d41a2a#0';
const POLICY = 'd958b823faaa76977d0a07bd9622e87d8e2c85f6692f7f8e8db77762';

const good = (): NodeJS.ProcessEnv => ({
  MOCK_PUBLIC_BASE: 'https://mock.example.test', MOCK_MTLS_BASE: 'https://mock-mtls.example.test', MOCK_OPERATOR_TOKEN: TOKEN,
  VECTOR_IDENTITY_LEGACY_ROOT: ROOT, VECTOR_IDENTITY_CONFIG_SEED: SEED, VECTOR_IDENTITY_POLICY_ID: POLICY,
});

const refusal = (env: NodeJS.ProcessEnv): string => {
  try {
    loadConfig(env);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error('the environment was accepted');
};

describe('loadConfig', () => {
  it('reads a good environment, with the defaults of the code', () => {
    const config = loadConfig(good());
    expect(config).toMatchObject({
      publicBase: 'https://mock.example.test', publicHost: 'mock.example.test', mtlsBase: 'https://mock-mtls.example.test', mtlsHost: 'mock-mtls.example.test', operatorToken: TOKEN,
      gatewayUrl: GATEWAY_DEFAULT, ogmiosUrl: OGMIOS_DEFAULT, koiosUrl: KOIOS_DEFAULT, host: HOST_DEFAULT, port: PORT_DEFAULT,
    });
    expect(config.deployment.identity.hash).toBe(POLICY);
  });
  it('names each setting that it reads, once', () => {
    expect(new Set(SETTINGS).size).toBe(SETTINGS.length);
    expect([...SETTINGS].sort()).toEqual([
      'HOST', 'IDENTITY_GATEWAY_URL', 'MOCK_MTLS_BASE', 'MOCK_OPERATOR_TOKEN', 'MOCK_PUBLIC_BASE', 'PORT', 'VECTOR_IDENTITY_CONFIG_SEED', 'VECTOR_IDENTITY_LEGACY_ROOT', 'VECTOR_IDENTITY_POLICY_ID',
      'VECTOR_KOIOS_URL', 'VECTOR_OGMIOS_URL',
    ]);
  });
  it('takes the settings that are given, and lower-cases the host names', () => {
    const config = loadConfig({
      ...good(), MOCK_PUBLIC_BASE: 'https://Mock.Example.test', IDENTITY_GATEWAY_URL: 'https://id.other.test', VECTOR_OGMIOS_URL: 'https://ogmios.other.test', VECTOR_KOIOS_URL: 'https://koios.other.test/',
      PORT: '9200', HOST: '0.0.0.0',
    });
    expect(config).toMatchObject({ publicHost: 'mock.example.test', gatewayUrl: 'https://id.other.test', ogmiosUrl: 'https://ogmios.other.test', koiosUrl: 'https://koios.other.test', port: 9200, host: '0.0.0.0' });
  });
  it('keeps the port of a host that has one, so that the Host header is compared with it', () => {
    expect(loadConfig({ ...good(), MOCK_PUBLIC_BASE: 'https://mock.example.test:8443' })).toMatchObject({ publicBase: 'https://mock.example.test:8443', publicHost: 'mock.example.test:8443' });
  });

  it.each(['MOCK_PUBLIC_BASE', 'MOCK_MTLS_BASE', 'MOCK_OPERATOR_TOKEN', 'VECTOR_IDENTITY_LEGACY_ROOT', 'VECTOR_IDENTITY_CONFIG_SEED', 'VECTOR_IDENTITY_POLICY_ID'])('stops at the start without %s, and names it', (name) => {
    for (const missing of [undefined, '', '   ']) expect(refusal({ ...good(), [name]: missing })).toMatch(new RegExp(`^environment variable ${name} is required`));
  });
  it.each([
    ['MOCK_PUBLIC_BASE', 'http://mock.example.test'],
    ['MOCK_PUBLIC_BASE', 'mock.example.test'],
    ['MOCK_PUBLIC_BASE', 'https://mock.example.test/path'],
    ['MOCK_PUBLIC_BASE', 'https://mock.example.test/?q=1'],
    ['MOCK_PUBLIC_BASE', 'https://user:pass@mock.example.test'],
    ['MOCK_PUBLIC_BASE', 'https://mock.example.test#frag'],
    ['MOCK_MTLS_BASE', 'ftp://mock-mtls.example.test'],
    ['MOCK_MTLS_BASE', 'https://'],
    ['IDENTITY_GATEWAY_URL', 'http://id.example.test'],
    ['IDENTITY_GATEWAY_URL', 'https://id.example.test/token'],
    ['VECTOR_OGMIOS_URL', 'ogmios.example.test'],
    ['VECTOR_KOIOS_URL', 'http://koios.example.test'],
  ])('stops at the start for %s=%s, and names the variable', (name, value) => {
    expect(refusal({ ...good(), [name]: value })).toMatch(new RegExp(`^environment variable ${name} must be an https origin`));
  });
  it('stops at the start when the two hosts are one host: the service tells them apart by the Host header', () => {
    expect(refusal({ ...good(), MOCK_MTLS_BASE: 'https://mock.example.test' })).toMatch(/^environment variable MOCK_MTLS_BASE must name another host/);
    expect(refusal({ ...good(), MOCK_MTLS_BASE: 'https://MOCK.example.test:443' })).toMatch(/^environment variable MOCK_MTLS_BASE must name another host/);
    expect(() => loadConfig({ ...good(), MOCK_MTLS_BASE: 'https://mock.example.test:8443' })).not.toThrow();
  });
  it.each(['short', 'a'.repeat(31), 'a'.repeat(129), `${'a'.repeat(32)} b`, `${'a'.repeat(32)}"`, `${'a'.repeat(31)}\nb`])('stops at the start for an operator token of the wrong form (%#), and names the variable', (token) => {
    expect(refusal({ ...good(), MOCK_OPERATOR_TOKEN: token })).toMatch(/^environment variable MOCK_OPERATOR_TOKEN (must have 32 to 128 characters|is required)/);
  });
  it('accepts an operator token of 32 and of 128 characters', () => {
    expect(loadConfig({ ...good(), MOCK_OPERATOR_TOKEN: 'a'.repeat(32) }).operatorToken).toBe('a'.repeat(32));
    expect(loadConfig({ ...good(), MOCK_OPERATOR_TOKEN: 'A-_.~+/='.repeat(16) }).operatorToken).toHaveLength(128);
  });
  it('never shows the operator token, whatever setting is wrong', () => {
    const wrongs: NodeJS.ProcessEnv[] = [
      { ...good(), MOCK_OPERATOR_TOKEN: `${TOKEN} bad` },
      { ...good(), MOCK_PUBLIC_BASE: TOKEN },
      { ...good(), MOCK_MTLS_BASE: `https://x.test/${TOKEN}` },
      { ...good(), PORT: TOKEN },
      { ...good(), HOST: `${TOKEN}!` },
      { ...good(), VECTOR_IDENTITY_POLICY_ID: TOKEN },
      { ...good(), VECTOR_IDENTITY_LEGACY_ROOT: TOKEN },
    ];
    for (const env of wrongs) expect(refusal(env)).not.toContain(TOKEN);
  });
  it('stops at the start when the operator token is in another setting, and names that setting', () => {
    for (const name of ['MOCK_PUBLIC_BASE', 'HOST', 'VECTOR_OGMIOS_URL', 'IDENTITY_GATEWAY_URL']) {
      const message = refusal({ ...good(), [name]: `https://x.test/${TOKEN.toLowerCase()}` });
      expect(message, name).toBe(`environment variable ${name} holds the operator token, which belongs in MOCK_OPERATOR_TOKEN alone: it would be printed. Take it out of ${name}`);
    }
  });

  it('stops at the start for a wrong deployment value, and names the variable', () => {
    expect(refusal({ ...good(), VECTOR_IDENTITY_LEGACY_ROOT: 'abc' })).toMatch(/^environment variable VECTOR_IDENTITY_LEGACY_ROOT must be 64 hex/);
    expect(refusal({ ...good(), VECTOR_IDENTITY_CONFIG_SEED: 'not a reference' })).toMatch(/^environment variable VECTOR_IDENTITY_CONFIG_SEED must be/);
    expect(refusal({ ...good(), VECTOR_IDENTITY_POLICY_ID: 'abc' })).toMatch(/^environment variable VECTOR_IDENTITY_POLICY_ID must be 56 hex/);
  });
  it('stops at the start when the policy is not the one that the two values give: a typo in a value would make the service refuse every call', () => {
    const typo = `${ROOT.slice(0, 63)}0`;
    expect(refusal({ ...good(), VECTOR_IDENTITY_LEGACY_ROOT: typo })).toMatch(/^environment variable VECTOR_IDENTITY_POLICY_ID is d958b823.* one of the three values is wrong/);
    expect(refusal({ ...good(), VECTOR_IDENTITY_POLICY_ID: '00'.repeat(28) })).toMatch(/^environment variable VECTOR_IDENTITY_POLICY_ID is /);
  });

  it.each([['PORT', '0'], ['PORT', '65536'], ['PORT', 'abc'], ['PORT', '-1'], ['PORT', '92.5'], ['PORT', '9e3']])('stops at the start for %s=%s, and names the variable', (name, value) => {
    expect(refusal({ ...good(), [name]: value })).toMatch(/^environment variable PORT must be/);
  });
  it('accepts the least and the most that a port is', () => {
    expect(loadConfig({ ...good(), PORT: '1' }).port).toBe(1);
    expect(loadConfig({ ...good(), PORT: '65535' }).port).toBe(65_535);
  });
  it('stops at the start for a host that is no address and no name, and names the variable', () => {
    for (const host of ['a b', 'x/y', 'host;rm', 'ho\u0000st']) expect(refusal({ ...good(), HOST: host })).toMatch(/^environment variable HOST must be/);
    expect(loadConfig({ ...good(), HOST: '::1' }).host).toBe('::1');
  });
});
