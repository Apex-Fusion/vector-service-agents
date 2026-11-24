// The facts of a transaction: what its bytes say, and never what its builder says.
import { describe, expect, it } from 'vitest';
import { decodeTransaction, lucidForAddress } from '../lib/platform.ts';
import { factsOf } from '../lib/txfacts.ts';
import { MEMBER_N, World, keyOf } from './support/world.ts';

const member = keyOf(MEMBER_N);
const FROM_MS = 1_760_000_000_000;
const MINUTE_MS = 60_000;

/** The bytes of a payment of the member to itself, with the validity that a test gives: a start, an end, both, or none. */
async function payment(validity: { from?: number; to?: number }): Promise<string> {
  const world = await World.create([{ n: MEMBER_N }]);
  const lucid = await lucidForAddress(world.chain, member.address);
  let builder = lucid.newTx().pay.ToAddress(member.address, { lovelace: 2_000_000n });
  if (validity.from !== undefined) builder = builder.validFrom(validity.from);
  if (validity.to !== undefined) builder = builder.validTo(validity.to);
  return (await builder.complete()).toCBOR();
}

describe('validityEndSlot', () => {
  it('is the ttl of the body as a bigint, and not the start of the validity interval', async () => {
    const cbor = await payment({ from: FROM_MS, to: FROM_MS + 20 * MINUTE_MS });
    const body = decodeTransaction(cbor).body();
    const start = body.validity_interval_start();
    const end = body.ttl();
    expect(end! - start!).toBe(1_200n);
    const { validityEndSlot } = factsOf(cbor);
    expect(typeof validityEndSlot).toBe('bigint');
    expect(validityEndSlot).toBe(end);
    expect(validityEndSlot).not.toBe(start);
  });
  it('is the ttl when the body has no start', async () => {
    const cbor = await payment({ to: FROM_MS + 20 * MINUTE_MS });
    expect(factsOf(cbor).validityEndSlot).toBe(decodeTransaction(cbor).body().ttl());
    expect(factsOf(cbor).validityEndSlot).not.toBeNull();
  });
  it('is null for a body that has no ttl, also when the body has a start', async () => {
    expect(factsOf(await payment({})).validityEndSlot).toBeNull();
    expect(factsOf(await payment({ from: FROM_MS })).validityEndSlot).toBeNull();
  });
});
