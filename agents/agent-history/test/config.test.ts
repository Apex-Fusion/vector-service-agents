import { describe, test, expect } from 'vitest';
import { M1_ADDRESSES, M6_ADDRESSES, M3_REPUTATION_ADDRESS, M3_ENDORSEMENT_ADDRESS, REGISTRY_ADDRESS, LEGACY_REGISTRY } from '@vsa/vector-read';
import { configFromEnv, DEFAULT_CONFIG, DEFAULT_MODULES } from '../src/config.ts';
import { TEST_IDENTITY } from './support.ts';

describe('configFromEnv: the deployment values the report reads with', () => {
  test('with no setting: the legacy registry only, and the module deployments before the identity registry', () => {
    expect(configFromEnv({})).toEqual(DEFAULT_CONFIG);
    expect(DEFAULT_CONFIG.registries).toEqual({ legacy: LEGACY_REGISTRY, identity: null });
    expect(DEFAULT_MODULES).toEqual({ m3: { reputation: M3_REPUTATION_ADDRESS, endorsement: M3_ENDORSEMENT_ADDRESS }, m1: M1_ADDRESSES, m6: M6_ADDRESSES });
    expect(configFromEnv({ IDENTITY_POLICY_ID: '', M1_ADDRESSES: ' ', M6_ADDRESSES: '', M3_REPUTATION_ADDRESS: '' })).toEqual(DEFAULT_CONFIG); // empty means the default
  });
  test('the identity registry from its policy, the address derived from it or given and equal to it', () => {
    expect(configFromEnv({ IDENTITY_POLICY_ID: TEST_IDENTITY.policy }).registries.identity).toEqual(TEST_IDENTITY);
    expect(configFromEnv({ IDENTITY_POLICY_ID: TEST_IDENTITY.policy, IDENTITY_ADDRESS: TEST_IDENTITY.address }).registries.identity).toEqual(TEST_IDENTITY);
    expect(() => configFromEnv({ IDENTITY_POLICY_ID: TEST_IDENTITY.policy, IDENTITY_ADDRESS: REGISTRY_ADDRESS })).toThrow(/^environment variable IDENTITY_ADDRESS .* is not the address of IDENTITY_POLICY_ID/);
    expect(() => configFromEnv({ IDENTITY_POLICY_ID: TEST_IDENTITY.policy.toUpperCase() })).toThrow(/^environment variable IDENTITY_POLICY_ID must be 56 lowercase hex/);
  });
  test('the module addresses replace the defaults, with the labels given, in their order', () => {
    const c = configFromEnv({
      M1_ADDRESSES: ` claim = ${M1_ADDRESSES.claim_v15_sim} ,challenge=${M1_ADDRESSES.challenge_v15_sim}`,
      M6_ADDRESSES: `proposal_v9=${M6_ADDRESSES.proposal}`,
      M3_REPUTATION_ADDRESS: ` ${M1_ADDRESSES.jury_pool} `, M3_ENDORSEMENT_ADDRESS: M6_ADDRESSES.critique,
    });
    expect(c.modules).toEqual({ m3: { reputation: M1_ADDRESSES.jury_pool, endorsement: M6_ADDRESSES.critique }, m1: { claim: M1_ADDRESSES.claim_v15_sim, challenge: M1_ADDRESSES.challenge_v15_sim }, m6: { proposal_v9: M6_ADDRESSES.proposal } });
    expect(Object.keys(c.modules.m1)).toEqual(['claim', 'challenge']);
  });
  test('a module setting that breaks a rule is refused, and the error names the variable', () => {
    const bad: Array<[Record<string, string>, RegExp]> = [
      [{ M1_ADDRESSES: 'claim' }, /^environment variable M1_ADDRESSES must be label=address pairs/],
      [{ M1_ADDRESSES: `Claim=${M1_ADDRESSES.claim}` }, /^environment variable M1_ADDRESSES: the label "Claim" must start with a lowercase letter/],
      [{ M1_ADDRESSES: `claim=${M1_ADDRESSES.claim},claim=${M1_ADDRESSES.challenge}` }, /names the label claim twice/],
      [{ M6_ADDRESSES: `a=${M6_ADDRESSES.proposal},b=${M6_ADDRESSES.proposal}` }, /^environment variable M6_ADDRESSES names the address .* twice/],
      [{ M6_ADDRESSES: 'proposal=addr1notanaddress' }, /^environment variable M6_ADDRESSES must hold Vector mainnet script addresses/],
      // A key address (payment by key hash) and an address of the test network are not module addresses.
      [{ M3_REPUTATION_ADDRESS: 'addr1v9qp4aqc5ln0kyrzwu5j3q0um64pes2mtvgja8ytmvk5djgfj3cl6' }, /^environment variable M3_REPUTATION_ADDRESS must hold Vector mainnet script addresses/],
      [{ M3_ENDORSEMENT_ADDRESS: 'addr_test1wpgk3cv8rn7mre2urrhpwwkteh8qjgzy5j9u9c3l8w34pycqdqc9l' }, /^environment variable M3_ENDORSEMENT_ADDRESS must hold Vector mainnet script addresses/],
    ];
    for (const [env, message] of bad) expect(() => configFromEnv(env), JSON.stringify(env)).toThrow(message);
  });
});
