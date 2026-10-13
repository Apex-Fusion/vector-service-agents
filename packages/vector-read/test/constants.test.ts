import { describe, test, expect } from 'vitest';
import { getAddressDetails } from '@lucid-evolution/lucid';
import { REGISTRY_POLICY, REGISTRY_ADDRESS, ADVERT_ADDRESS, ESCROW_ADDRESS, ESCROW_SCRIPT_HASH, M3_REPUTATION_ADDRESS, M3_ENDORSEMENT_ADDRESS, M1_ADDRESSES, M6_ADDRESSES } from '../src/index.ts';
// Every address constant is a Vector mainnet script address with no stake part: network 1, enterprise, script credential.
// The script hashes are those of the design spec (section 6). The design gives the Module-1 v15-sim set by the first
// eight hex digits only; the full hashes below are from the Module-1 mainnet deployments record (id mainnet-v15-sim-2026-04-22).
const SCRIPT_HASH: Record<string, [address: string, hash: string | null]> = {
  registry: [REGISTRY_ADDRESS, REGISTRY_POLICY],
  advert: [ADVERT_ADDRESS, '9929fa4eed8b66b30b8608e601ed2a4b7b413a2413dd13ab275594da'],
  escrow: [ESCROW_ADDRESS, ESCROW_SCRIPT_HASH],
  m3_reputation: [M3_REPUTATION_ADDRESS, '5168e1871cfdb1e55c18ee173acbcdce092044a48bc2e23f3ba35093'],
  m3_endorsement: [M3_ENDORSEMENT_ADDRESS, '77196bed7fb8457610800cc7241cf4496e00d7901de9079fb0323ebf'],
  m1_claim: [M1_ADDRESSES.claim, 'a9d22e8b01d282be8007b8d9e3e8af548aaa56f1c3e433c0eddd8760'],
  m1_challenge: [M1_ADDRESSES.challenge, '12700f4aabdd63caab38adfb50455da54a4e4bc0402a4b1d5a90d1fb'],
  m1_jury_pool: [M1_ADDRESSES.jury_pool, '2b01c6b3164237757fc82e64780c63ecfc1d5a733ce919a3e2e75f28'],
  m1_claim_v15_sim: [M1_ADDRESSES.claim_v15_sim, '6c7a075fca29e78be189c37a8d0d4fefc2bc9aac4db9c6a5e9f3ed81'],
  m1_challenge_v15_sim: [M1_ADDRESSES.challenge_v15_sim, 'a28a2a36c71e537b6c409d62fea8f8fb62332ab69a5c728fb23923f7'],
  m1_jury_pool_v15_sim: [M1_ADDRESSES.jury_pool_v15_sim, '7135ee94d59b3b17956d648393041cdb29f9b47037ac8a8f5aecc1e5'],
  // The design spec gives the Module-6 spend addresses, not their script hashes.
  m6_proposal: [M6_ADDRESSES.proposal, null],
  m6_critique: [M6_ADDRESSES.critique, null],
  m6_endorsement: [M6_ADDRESSES.endorsement, null],
};

describe('address constants', () => {
  test.each(Object.entries(SCRIPT_HASH))('%s decodes to a mainnet enterprise script address, and to its script hash', (_name, [address, hash]) => {
    const d = getAddressDetails(address);
    expect(d.networkId).toBe(1);
    expect(d.type).toBe('Enterprise');
    expect(d.paymentCredential?.type).toBe('Script');
    expect(d.stakeCredential).toBeUndefined();
    if (hash !== null) expect(d.paymentCredential?.hash).toBe(hash);
  });
  test('the Module-1 labels are the six sections of the dispute report: the v14 set, then the v15-sim set', () => {
    expect(Object.keys(M1_ADDRESSES)).toEqual(['claim', 'challenge', 'jury_pool', 'claim_v15_sim', 'challenge_v15_sim', 'jury_pool_v15_sim']);
  });
  test('no address is listed twice', () => {
    const all = Object.values(SCRIPT_HASH).map(([address]) => address);
    expect(new Set(all).size).toBe(all.length);
  });
});
