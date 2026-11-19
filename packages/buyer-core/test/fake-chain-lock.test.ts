// packages/buyer-core/test/fake-chain-lock.test.ts
// The lock option of FakeChain: every Post locks FakeChain.LOCK_LOVELACE unless the chain is made with another amount, and an advert whose price and bonds ask for more than the
// lock is refused. A test of a service that hires an advert with large bonds uses it.
import { describe, it, expect } from 'vitest';
import type { IdentityAdvertDatum } from '@vsa/vector-read';
import { FakeChain } from '../src/index.ts';

const T0 = 1_790_000_000_000;
const ADVERT_REF = `${'a1'.repeat(32)}#0`;
const PROMPT_HASH = 'ee'.repeat(32);
const AGENT = 'ae'.repeat(32);
/** An advert that asks for 2 + 1 + 1 units: more than the default lock of a Post. */
const ADVERT: IdentityAdvertDatum = {
  supplier_pkh: 'cd'.repeat(28), capability_id: 'supplychain.order.accept.v1', model: 'order-desk-small', max_output_tokens: 256, max_processing_ms: 60_000,
  price_lovelace: 2_000_000n, supplier_bond_lovelace: 1_000_000n, buyer_bond_lovelace: 1_000_000n, endpoint_url: 'https://203.0.113.41', detail_uri: '',
  detail_hash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', advertised_at: T0 - 86_400_000, status: 'Active', agent_id: AGENT,
};

describe('FakeChain lockLovelace', () => {
  it('locks the amount it is given on every Post, takes it and the fee out of the float, and gives the escrow that lock', async () => {
    const chain = new FakeChain({ adverts: { [ADVERT_REF]: ADVERT }, clock: () => T0, lockLovelace: 5_000_000n, floatLovelace: 20_000_000n });
    const posted = await chain.postEscrow({ advertRef: ADVERT_REF, promptHash: PROMPT_HASH });
    expect([posted.lockLovelace, posted.feeLovelace]).toStrictEqual([5_000_000n, FakeChain.FEE_LOVELACE]);
    expect((await chain.wallet()).floatLovelace).toBe(20_000_000n - 5_000_000n - FakeChain.FEE_LOVELACE);
    expect(await chain.escrowState(posted.escrowRef)).toBe('Open');
  });

  it('refuses an advert that asks for more than the default lock, and takes one that the lock covers; the default lock is the constant', async () => {
    const refused = new FakeChain({ adverts: { [ADVERT_REF]: ADVERT }, clock: () => T0 });
    await expect(refused.postEscrow({ advertRef: ADVERT_REF, promptHash: PROMPT_HASH })).rejects.toThrow(`FakeChain locks ${FakeChain.LOCK_LOVELACE} lovelace on every Post`);
    const covered = new FakeChain({ adverts: { [ADVERT_REF]: ADVERT }, clock: () => T0, lockLovelace: 4_000_000n });
    expect((await covered.postEscrow({ advertRef: ADVERT_REF, promptHash: PROMPT_HASH })).lockLovelace).toBe(4_000_000n);
    // The same lock that is too small for the advert refuses it, with the amount that the chain locks in the message.
    const small = new FakeChain({ adverts: { [ADVERT_REF]: ADVERT }, clock: () => T0, lockLovelace: 3_999_999n });
    await expect(small.postEscrow({ advertRef: ADVERT_REF, promptHash: PROMPT_HASH })).rejects.toThrow('FakeChain locks 3999999 lovelace on every Post');
  });
});
