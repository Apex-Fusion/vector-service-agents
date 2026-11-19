// The settings of the checks: every value has a name, a check on its shape, and a message that names the setting and never shows a secret.
import { describe, expect, it } from 'vitest';
import { EnvReader, SettingsError, VECTOR_MAINNET, deploymentFor, parseCommonSettings } from '../lib/settings.ts';

const RECORD = `did:vector:${'ab'.repeat(32)}`;
const base = { CHECKS_NETWORK: 'vector-mainnet', CHECKS_RECORD: RECORD, CHECKS_MEMBER_KEY_FILE: '/keys/member', CHECKS_AGENT_KEY_FILE: '/keys/agent', CHECKS_CONTROLLER_KEY_FILE: '/keys/controller' };
const problemsOf = (run: () => unknown): string[] => {
  try { run(); } catch (err) { if (err instanceof SettingsError) return [...err.problems]; throw err; }
  throw new Error('the call did not refuse');
};
const all = { keys: ['controller', 'agent', 'member'] } as const;

describe('the network', () => {
  it('knows Vector mainnet by its magic and its start', () => {
    expect(VECTOR_MAINNET).toEqual({ name: 'vector-mainnet', magic: 764824073, systemStartMs: 1_756_485_600_000 });
    expect(parseCommonSettings(base, all).network).toEqual(VECTOR_MAINNET);
  });
  it('refuses a run that names no network, and a magic for mainnet that is another one', () => {
    expect(problemsOf(() => parseCommonSettings({ ...base, CHECKS_NETWORK: undefined }, all))).toEqual([expect.stringContaining('CHECKS_NETWORK')]);
    expect(problemsOf(() => parseCommonSettings({ ...base, CHECKS_NETWORK_MAGIC: '3311' }, all))).toEqual([expect.stringContaining('CHECKS_NETWORK_MAGIC')]);
    expect(parseCommonSettings({ ...base, CHECKS_NETWORK_MAGIC: '764824073' }, all).network.magic).toBe(764824073);
  });
  it('takes a named test network with its magic, and refuses one without a magic', () => {
    const test = parseCommonSettings({ ...base, CHECKS_NETWORK: 'vector-test', CHECKS_NETWORK_MAGIC: '42', CHECKS_NETWORK_SYSTEM_START_MS: '1700000000000' }, all);
    expect(test.network).toEqual({ name: 'vector-test', magic: 42, systemStartMs: 1_700_000_000_000 });
    expect(parseCommonSettings({ ...base, CHECKS_NETWORK: 'vector-test', CHECKS_NETWORK_MAGIC: '42' }, all).network.systemStartMs).toBeNull();
    expect(problemsOf(() => parseCommonSettings({ ...base, CHECKS_NETWORK: 'vector-test' }, all))).toEqual([expect.stringContaining('CHECKS_NETWORK_MAGIC')]);
    expect(problemsOf(() => parseCommonSettings({ ...base, CHECKS_NETWORK: 'Not A Name', CHECKS_NETWORK_MAGIC: '42' }, all))).toEqual([expect.stringContaining('CHECKS_NETWORK')]);
    expect(problemsOf(() => parseCommonSettings({ ...base, CHECKS_NETWORK: 'vector-test', CHECKS_NETWORK_MAGIC: '4.2' }, all))).toEqual([expect.stringContaining('CHECKS_NETWORK_MAGIC')]);
  });
});

describe('the record', () => {
  it('takes a DID or its 64 hex characters, and gives both forms in lower case', () => {
    for (const value of [RECORD, 'ab'.repeat(32), RECORD.toUpperCase().replace('DID:VECTOR:', 'did:vector:')]) {
      const settings = parseCommonSettings({ ...base, CHECKS_RECORD: value }, all);
      expect(settings.recordId).toBe('ab'.repeat(32));
      expect(settings.recordDid).toBe(RECORD);
    }
  });
  it('refuses a missing record and a text that is no identifier', () => {
    expect(problemsOf(() => parseCommonSettings({ ...base, CHECKS_RECORD: undefined }, all))).toEqual([expect.stringContaining('CHECKS_RECORD')]);
    for (const bad of ['did:vector:agent:abc:def', 'ab'.repeat(31), 'did:vector:xyz', 'not a record']) {
      expect(problemsOf(() => parseCommonSettings({ ...base, CHECKS_RECORD: bad }, all)), bad).toEqual([expect.stringContaining('CHECKS_RECORD')]);
    }
  });
});

describe('the key files', () => {
  it('needs the files that a check names, and one message names all that are missing', () => {
    const problems = problemsOf(() => parseCommonSettings({ ...base, CHECKS_MEMBER_KEY_FILE: undefined, CHECKS_AGENT_KEY_FILE: ' ' }, all));
    expect(problems.join('\n')).toContain('CHECKS_MEMBER_KEY_FILE');
    expect(problems.join('\n')).toContain('CHECKS_AGENT_KEY_FILE');
    expect(problems.join('\n')).not.toContain('CHECKS_CONTROLLER_KEY_FILE');
  });
  it('does not need a file that the check does not name, and keeps one that it is given', () => {
    const settings = parseCommonSettings({ ...base, CHECKS_CONTROLLER_KEY_FILE: undefined, CHECKS_MEMBER_KEY_FILE: undefined }, { keys: ['agent'] });
    expect(settings.keyFiles).toEqual({ agent: '/keys/agent' });
    expect(parseCommonSettings({ ...base, CHECKS_AUTH_KEY_FILE: '/keys/auth' }, { keys: ['agent'] }).keyFiles.authentication).toBe('/keys/auth');
  });
});

describe('the limits and the addresses', () => {
  it('has a limit on the fee and on the collateral that a failed script takes, and takes another one from the settings', () => {
    const defaults = parseCommonSettings(base, all);
    expect(defaults.maxFeeLovelace).toBe(2_000_000n);
    expect(defaults.maxCollateralLossLovelace).toBe(5_000_000n);
    const set = parseCommonSettings({ ...base, CHECKS_MAX_FEE_LOVELACE: '900000', CHECKS_MAX_COLLATERAL_LOSS_LOVELACE: '3000000' }, all);
    expect([set.maxFeeLovelace, set.maxCollateralLossLovelace]).toEqual([900_000n, 3_000_000n]);
    for (const bad of ['0', '-1', '1.5', '1e6', 'many', '9999999999999999999']) {
      expect(problemsOf(() => parseCommonSettings({ ...base, CHECKS_MAX_FEE_LOVELACE: bad }, all)), bad).toEqual([expect.stringContaining('CHECKS_MAX_FEE_LOVELACE')]);
    }
  });
  it('uses the endpoints of mainnet unless the settings name others, and wants https', () => {
    const defaults = parseCommonSettings(base, all);
    expect(defaults.urls.gateway).toBe('https://id.vector.apexfusion.org');
    expect(defaults.urls.hosted).toBe('https://mcp.vector.mainnet.apexfusion.org/mcp');
    expect(defaults.urls.ogmios).toMatch(/^https:\/\//);
    const set = parseCommonSettings({ ...base, VECTOR_OGMIOS_URL: 'https://ogmios.example', CHECKS_GATEWAY_URL: 'http://127.0.0.1:9000/' }, all);
    expect(set.urls.ogmios).toBe('https://ogmios.example');
    expect(set.urls.gateway).toBe('http://127.0.0.1:9000');
    for (const bad of ['http://remote.example', 'ftp://x.example', 'https://user:hunter2xyz@x.example', 'not a url']) {
      const problems = problemsOf(() => parseCommonSettings({ ...base, CHECKS_GATEWAY_URL: bad }, all));
      expect(problems, bad).toEqual([expect.stringContaining('CHECKS_GATEWAY_URL')]);
      expect(problems.join(' ')).not.toContain('hunter2xyz');
    }
  });
  it('puts the state in the folder that CHECKS_STATE_DIR names, and in ./checks-state without it', () => {
    expect(parseCommonSettings({ ...base, CHECKS_STATE_DIR: '/tmp/state' }, all).stateDir).toBe('/tmp/state');
    expect(parseCommonSettings(base, all).stateDir).toMatch(/checks-state$/);
  });
});

describe('the identity deployment', () => {
  it('is the published one on mainnet: each script has the hash that the deployment published', () => {
    const d = deploymentFor(VECTOR_MAINNET, {});
    expect(d.identity.hash).toBe('d958b823faaa76977d0a07bd9622e87d8e2c85f6692f7f8e8db77762');
    expect(d.attestation.hash).toBe('f07c644e042ead094cc501f443e03a8955dc1f4d0dcd5b387863e042');
    expect(d.delegation.hash).toBe('bdc16990b844a8860f28c51bb0e6a469c84bebcd57db699ce204785a');
    expect(d.escrow.hash).toBe('bdd86d9ac1e6f2ef6bcf81c14522f86ada1b438ca7ae0c90c8459deb');
    expect(d.vault.hash).toBe('bd45078144effb5011f161d8bb433f2ee360da458644fca9b818097a');
    expect(d.advert.hash).toBe('f36e366e06d4480651aa0e1064578f0bfe275af96dfcaaabe5efe26c');
    expect(d.identity.address).toBe('addr1w8v43wprl248d9mapgrmm93zap7cuty97e5j7luw3kmhwcs8vm9vk');
    for (const name of ['attestation', 'delegation', 'vault', 'escrow'] as const) expect(d.refs[name], name).toBeDefined();
  });
  it('is the one that the VECTOR_IDENTITY settings name when they are set, and a test network has none by default', () => {
    expect(() => deploymentFor({ name: 'vector-test', magic: 42, systemStartMs: null }, {})).toThrow(SettingsError);
    const main = deploymentFor(VECTOR_MAINNET, {});
    const env = { VECTOR_IDENTITY_LEGACY_ROOT: main.legacyRoot, VECTOR_IDENTITY_CONFIG_SEED: `${main.configSeed.txHash}#${main.configSeed.outputIndex}` };
    const test = deploymentFor({ name: 'vector-test', magic: 42, systemStartMs: null }, env);
    expect(test.identity.hash).toBe(main.identity.hash);
    expect(test.refs).toEqual({});
  });
  it('refuses a mainnet run that names a root without a seed, in the words of the reader', () => {
    expect(problemsOf(() => deploymentFor(VECTOR_MAINNET, { VECTOR_IDENTITY_LEGACY_ROOT: 'ab'.repeat(32) }))[0]).toContain('VECTOR_IDENTITY_CONFIG_SEED');
  });
});

describe('EnvReader', () => {
  it('collects the problems of all the settings and throws them together', () => {
    const reader = new EnvReader({ A: 'x', B: '12', C: '0' });
    expect(reader.text('A', true)).toBe('x');
    expect(reader.text('MISSING', true)).toBeUndefined();
    expect(reader.whole('B', 1n, 100n, 5n)).toBe(12n);
    expect(reader.whole('C', 1n, 100n, 5n)).toBe(5n);
    expect(problemsOf(() => reader.done())).toHaveLength(2);
  });
  it('treats an empty value as not set', () => {
    const reader = new EnvReader({ A: '  ' });
    expect(reader.text('A', false)).toBeUndefined();
    expect(() => reader.done()).not.toThrow();
  });
});
