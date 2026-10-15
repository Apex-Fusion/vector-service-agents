// packages/buyer-core/test/fake-chain.test.ts
// FakeChain, the in-memory Chain the service tests run against: the escrow state machine (Post, the supplier's Claim and Submit as test
// hooks, Accept, Reclaim), deterministic refs, the lock and fee constants, and the wallet float those transactions move.
import { describe, it, expect } from 'vitest';
import { decodeAdvertDatum, sha256Utf8Hex } from '@vsa/vector-read';
import { FakeChain, DELIVER_BY_BUFFER_MS } from '../src/index.ts';
import type { Chain, PostResult } from '../src/index.ts';
import { ADVERT_REF, ADVERT_DATUM_HEX, ADVERT_EXPECTED } from './fixtures/marketplace.fixture.ts';

const advert = decodeAdvertDatum(ADVERT_DATUM_HEX);
const PROMPT = 'ab'.repeat(32);
const RECEIPT_HASH = 'cd'.repeat(32);
const T0 = 1_790_000_000_000;
const LOCK = 2_261_030n;
const FEE = 500_000n;

/** A FakeChain over the live ChandraOCR advert with a clock the test moves. */
function setup(opts: { floatLovelace?: bigint } = {}) {
  const clock = { now: T0 };
  const chain = new FakeChain({ adverts: { [ADVERT_REF]: advert }, clock: () => clock.now, prefix: 'pipeline-test/', ...opts });
  const post = (promptHash = PROMPT): Promise<PostResult> => chain.postEscrow({ advertRef: ADVERT_REF, promptHash });
  return { chain, clock, post };
}

describe('FakeChain', () => {
  it('is a Chain whose lock and fee are the constants of the live ChandraOCR Post', () => {
    const chain: Chain = new FakeChain();
    expect(chain).toBeInstanceOf(FakeChain);
    expect([FakeChain.LOCK_LOVELACE, FakeChain.FEE_LOVELACE]).toStrictEqual([LOCK, FEE]);
  });

  it('post opens an escrow under the deterministic ref sha256(prefix + n)#0, with deliver_by = posted_at + the window + the buffer', async () => {
    const { chain, post } = setup();
    const first = await post();
    expect(first).toStrictEqual({
      escrowRef: `${sha256Utf8Hex('pipeline-test/1')}#0`, txHash: sha256Utf8Hex('pipeline-test/1'),
      lockLovelace: LOCK, feeLovelace: FEE,
      deliverBy: T0 + ADVERT_EXPECTED.max_processing_ms + DELIVER_BY_BUFFER_MS, postedAt: T0, supplierPkh: ADVERT_EXPECTED.supplier_pkh,
    });
    expect(await chain.escrowState(first.escrowRef)).toBe('Open');
    expect(await chain.onChainReceiptHash(first.escrowRef)).toBeNull();
    expect((await post()).escrowRef).toBe(`${sha256Utf8Hex('pipeline-test/2')}#0`);
    // The same calls on a new chain give the same refs.
    expect((await setup().post()).escrowRef).toBe(first.escrowRef);
  });

  it('markClaimed makes it Claimed, markSubmitted makes it Submitted with the receipt hash readable on chain', async () => {
    const { chain, post } = setup();
    const { escrowRef } = await post();
    chain.markClaimed(escrowRef);
    expect(await chain.escrowState(escrowRef)).toBe('Claimed');
    expect(await chain.onChainReceiptHash(escrowRef)).toBeNull();
    chain.markSubmitted(escrowRef, RECEIPT_HASH);
    expect(await chain.escrowState(escrowRef)).toBe('Submitted');
    expect(await chain.onChainReceiptHash(escrowRef)).toBe(RECEIPT_HASH);
  });

  it('the supplier hooks take the states in order and a receipt hash of 64 lowercase hex characters only', async () => {
    const { chain, post } = setup();
    const { escrowRef } = await post();
    expect(() => chain.markSubmitted(escrowRef, RECEIPT_HASH)).toThrow(/Open; a Submit needs Claimed/);
    chain.markClaimed(escrowRef);
    expect(() => chain.markClaimed(escrowRef)).toThrow(/Claimed; a Claim needs Open/);
    expect(() => chain.markSubmitted(escrowRef, RECEIPT_HASH.toUpperCase())).toThrow(/64 lowercase hex/);
    expect(await chain.escrowState(escrowRef)).toBe('Claimed');
  });

  it('accept only from Submitted, and then the escrow is spent', async () => {
    const { chain, post } = setup();
    const { escrowRef } = await post();
    await expect(chain.accept(escrowRef)).rejects.toThrow(/Open; Accept needs Submitted/);
    chain.markClaimed(escrowRef);
    await expect(chain.accept(escrowRef)).rejects.toThrow(/Claimed; Accept needs Submitted/);
    chain.markSubmitted(escrowRef, RECEIPT_HASH);
    const accepted = await chain.accept(escrowRef);
    expect(accepted).toStrictEqual({ txHash: sha256Utf8Hex(`pipeline-test/accept/${escrowRef}`), feeLovelace: FEE });
    expect(await chain.escrowState(escrowRef)).toBe('spent');
    // The Submitted output is gone, and with it the receipt hash on chain.
    expect(await chain.onChainReceiptHash(escrowRef)).toBeNull();
    await expect(chain.accept(escrowRef)).rejects.toThrow(/spent; Accept needs Submitted/);
  });

  it('reclaim only Open or Claimed, and only from deliver_by on', async () => {
    const { chain, clock, post } = setup();
    const open = await post();
    const claimed = await post();
    const submitted = await post();
    chain.markClaimed(claimed.escrowRef);
    chain.markClaimed(submitted.escrowRef);
    chain.markSubmitted(submitted.escrowRef, RECEIPT_HASH);
    clock.now = open.deliverBy - 1;
    await expect(chain.reclaim(open.escrowRef)).rejects.toThrow(/opens at deliver_by/);
    await expect(chain.reclaim(claimed.escrowRef)).rejects.toThrow(/opens at deliver_by/);
    clock.now = open.deliverBy;
    expect(await chain.reclaim(open.escrowRef)).toStrictEqual({ txHash: sha256Utf8Hex(`pipeline-test/reclaim/${open.escrowRef}`), feeLovelace: FEE });
    expect(await chain.reclaim(claimed.escrowRef)).toMatchObject({ feeLovelace: FEE });
    expect([await chain.escrowState(open.escrowRef), await chain.escrowState(claimed.escrowRef)]).toStrictEqual(['spent', 'spent']);
    // A Submitted escrow is the supplier's to Release or the buyer's to Accept, never to Reclaim; a spent one is gone.
    await expect(chain.reclaim(submitted.escrowRef)).rejects.toThrow(/Submitted; Reclaim needs Open or Claimed/);
    await expect(chain.reclaim(open.escrowRef)).rejects.toThrow(/spent; Reclaim needs Open or Claimed/);
  });

  it('a ref it never posted is unknown, and nothing can be done to it', async () => {
    const { chain } = setup();
    const stranger = `${'ee'.repeat(32)}#0`;
    expect(await chain.escrowState(stranger)).toBe('unknown');
    expect(await chain.onChainReceiptHash(stranger)).toBeNull();
    await expect(chain.accept(stranger)).rejects.toThrow(/no escrow at/);
    await expect(chain.reclaim(stranger)).rejects.toThrow(/no escrow at/);
    expect(() => chain.markClaimed(stranger)).toThrow(/no escrow at/);
  });

  it('the wallet float decreases by lock + fee on post, and on accept increases by the returned buyer bond and the lock-floor excess, less the Accept\'s own fee', async () => {
    const { chain, post } = setup({ floatLovelace: 50_000_000n });
    const start = await chain.wallet();
    expect(start).toMatchObject({ buyerPkh: expect.stringMatching(/^[0-9a-f]{56}$/), address: expect.stringMatching(/^addr1v/), collateralLovelace: 5_000_000n, floatLovelace: 50_000_000n });

    const { escrowRef } = await post();
    const afterPost = (await chain.wallet()).floatLovelace;
    expect(afterPost).toBe(50_000_000n - (LOCK + FEE));

    chain.markClaimed(escrowRef);
    chain.markSubmitted(escrowRef, RECEIPT_HASH);
    await chain.accept(escrowRef);
    // The lock was the price, both bonds and the floor excess; Accept pays the supplier the price and its bond, returns the buyer bond and
    // the excess, and pays its fee out of the wallet like every transaction (500000 each).
    const BUYER_BOND = ADVERT_EXPECTED.buyer_bond_lovelace;
    const EXCESS = LOCK - (ADVERT_EXPECTED.price_lovelace + ADVERT_EXPECTED.buyer_bond_lovelace + ADVERT_EXPECTED.supplier_bond_lovelace);
    expect(EXCESS).toBe(61_030n);
    const afterAccept = await chain.wallet();
    expect(afterAccept.floatLovelace).toBe(afterPost + BUYER_BOND + EXCESS - FEE);
    expect(afterAccept.collateralLovelace).toBe(5_000_000n);
  });

  it('a Reclaim returns the whole lock less its fee, and a Post the float cannot pay is refused and moves nothing', async () => {
    const { chain, clock, post } = setup({ floatLovelace: 2n * (LOCK + FEE) });
    const { escrowRef, deliverBy } = await post();
    await post();
    expect((await chain.wallet()).floatLovelace).toBe(0n);
    await expect(post()).rejects.toThrow(/cannot pay the lock and the fee/);
    expect((await chain.wallet()).floatLovelace).toBe(0n);
    clock.now = deliverBy;
    await chain.reclaim(escrowRef);
    expect((await chain.wallet()).floatLovelace).toBe(LOCK - FEE);
  });

  it('posts only against an advert it knows, under the checks of the real Post (prompt hash shape, the buyer as supplier)', async () => {
    const { chain, post } = setup();
    expect(await chain.readAdvert(ADVERT_REF)).toStrictEqual(advert);
    const unknownAdvert = `${'aa'.repeat(32)}#0`;
    await expect(chain.readAdvert(unknownAdvert)).rejects.toThrow(/no advert at/);
    await expect(chain.postEscrow({ advertRef: unknownAdvert, promptHash: PROMPT })).rejects.toThrow(/no advert at/);
    await expect(post('not a hash')).rejects.toThrow(/prompt hash must be 64 lowercase hex characters/);
    const selfHire = new FakeChain({ adverts: { [ADVERT_REF]: advert }, buyerPkh: ADVERT_EXPECTED.supplier_pkh });
    await expect(selfHire.postEscrow({ advertRef: ADVERT_REF, promptHash: PROMPT })).rejects.toThrow('The buyer cannot be the supplier of the same advert.');
  });
});
