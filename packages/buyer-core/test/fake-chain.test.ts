// packages/buyer-core/test/fake-chain.test.ts
// FakeChain, the in-memory Chain the service tests run against: the escrow state machine (Post, the supplier's Claim and Submit as test
// hooks, Accept, Reclaim), deterministic refs, the lock and fee constants, and the wallet float those transactions move.
import { describe, it, expect } from 'vitest';
import { decodeAdvertDatum, sha256Utf8Hex } from '@vsa/vector-read';
import { FakeChain, DELIVER_BY_BUFFER_MS } from '../src/index.ts';
import type { Chain, FakeChainOptions, PostResult } from '../src/index.ts';
import { ADVERT_REF, ADVERT_DATUM_HEX, ADVERT_EXPECTED } from './fixtures/marketplace.fixture.ts';

const advert = decodeAdvertDatum(ADVERT_DATUM_HEX);
const PROMPT = 'ab'.repeat(32);
const RECEIPT_HASH = 'cd'.repeat(32);
const T0 = 1_790_000_000_000;
const LOCK = 2_261_030n;
const FEE = 500_000n;
/** The vendored planReclaim's opening: the first whole second strictly after deliver_by (marketplace-build.ts). */
const reclaimOpens = (deliverBy: number): number => Math.ceil((deliverBy + 1) / 1000) * 1000;

/** A FakeChain over the live ChandraOCR advert with a clock the test moves. */
function setup(opts: Pick<FakeChainOptions, 'floatLovelace' | 'collateralLovelace'> & { start?: number } = {}) {
  const { start = T0, ...rest } = opts;
  const clock = { now: start };
  const chain = new FakeChain({ adverts: { [ADVERT_REF]: advert }, clock: () => clock.now, prefix: 'pipeline-test/', ...rest });
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
      collateralKept: true,
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

  it('reclaim only Open or Claimed, and only from the first whole second strictly after deliver_by, as the vendored planReclaim opens it', async () => {
    const { chain, clock, post } = setup();
    const open = await post();
    const claimed = await post();
    const submitted = await post();
    chain.markClaimed(claimed.escrowRef);
    chain.markClaimed(submitted.escrowRef);
    chain.markSubmitted(submitted.escrowRef, RECEIPT_HASH);
    // deliver_by falls on a whole second here, so the Reclaim opens one second after it, not at it.
    expect(open.deliverBy).toBe(T0 + 480_000);
    expect(reclaimOpens(open.deliverBy)).toBe(T0 + 481_000);
    for (const now of [open.deliverBy - 1, open.deliverBy, reclaimOpens(open.deliverBy) - 1]) {
      clock.now = now;
      await expect(chain.reclaim(open.escrowRef), String(now)).rejects.toThrow(`opens at ${T0 + 481_000}, the first whole second after deliver_by ${T0 + 480_000}`);
      await expect(chain.reclaim(claimed.escrowRef), String(now)).rejects.toThrow(/the first whole second after deliver_by/);
    }
    clock.now = reclaimOpens(open.deliverBy);
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
    clock.now = reclaimOpens(deliverBy);
    await chain.reclaim(escrowRef);
    expect((await chain.wallet()).floatLovelace).toBe(LOCK - FEE);
  });

  it('a deliver_by off the whole second opens the Reclaim at the next whole second', async () => {
    const { chain, clock, post } = setup({ start: T0 + 123 });
    const { escrowRef, deliverBy } = await post();
    expect(deliverBy).toBe(T0 + 480_123);
    clock.now = T0 + 480_999;
    await expect(chain.reclaim(escrowRef)).rejects.toThrow(`opens at ${T0 + 481_000}`);
    clock.now = T0 + 481_000;
    expect(await chain.reclaim(escrowRef)).toMatchObject({ feeLovelace: FEE });
  });

  it('refuses a Post against an advert whose price and bonds exceed the constant lock, and moves neither the float nor the ref counter', async () => {
    const dear = { ...advert, price_lovelace: 5_000_000n };
    const dearRef = `${'0a'.repeat(32)}#0`;
    const clock = { now: T0 };
    const chain = new FakeChain({ adverts: { [ADVERT_REF]: advert, [dearRef]: dear }, clock: () => clock.now, prefix: 'pipeline-test/' });
    await expect(chain.postEscrow({ advertRef: dearRef, promptHash: PROMPT })).rejects.toThrow(`FakeChain locks ${LOCK} lovelace on every Post, less than the 7000000 advert ${dearRef} asks for.`);
    expect((await chain.wallet()).floatLovelace).toBe(50_000_000n);
    expect((await chain.postEscrow({ advertRef: ADVERT_REF, promptHash: PROMPT })).escrowRef).toBe(`${sha256Utf8Hex('pipeline-test/1')}#0`);
  });

  it('says collateralKept false on a wallet without a collateral output, which it never spends either way', async () => {
    const { chain, post } = setup({ collateralLovelace: null });
    expect((await post()).collateralKept).toBe(false);
    expect((await chain.wallet()).collateralLovelace).toBeNull();
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
