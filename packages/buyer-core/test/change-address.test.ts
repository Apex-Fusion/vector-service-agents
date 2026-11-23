// packages/buyer-core/test/change-address.test.ts
// lucidForAddress (the excerpt src/vendored/mcp/build.ts) reads the change address through addressDetails of @vsa/vector-read/guarded-decode, as the
// mcp-server does at ebce68a. The empty text and a text of more than 1,024 characters are refused before Lucid reads them. The refusal of a long
// text names its length and its first 40 characters, and does not repeat the rest. No refusal reaches the node: the provider is never asked. This
// test is local: the source tests of this refusal run through the tools of the mcp-server, which this package does not copy.
import { describe, expect, it } from 'vitest';
import { FixtureProvider, FIXTURE_UTXOS, OWN_ADDRESS } from './fixtures/fixture-provider.ts';
import { lucidForAddress } from '../src/vendored/mcp/build.ts';

/** A provider that fails on the first call of the node that a build makes: an error about the address, and not about the node, shows that the address was checked first. */
function trapped(): FixtureProvider {
  const provider = new FixtureProvider(FIXTURE_UTXOS);
  const fail = () => { throw new Error('the node was asked'); };
  Object.assign(provider, { getProtocolParameters: fail, getUtxos: fail, getUtxosByOutRef: fail });
  return provider;
}

const refusal = async (address: string): Promise<string> => {
  try {
    await lucidForAddress(trapped(), address);
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  return 'no refusal';
};

describe('lucidForAddress: the change address is read through addressDetails', () => {
  it('an address of the wallet gives a Lucid instance that is bound to it (the twin of each refusal below)', async () => {
    const lucid = await lucidForAddress(new FixtureProvider(FIXTURE_UTXOS), OWN_ADDRESS);
    expect(await lucid.wallet().address()).toBe(OWN_ADDRESS);
  });

  it('text that is not an address is refused with the message of Lucid, before any call of the node', async () => {
    expect(await refusal('not an address')).toBe('Invalid change address: No address type matched for: not an address');
  });

  it('the empty text is refused with the message that Lucid gives for any text that is not an address, before any call of the node', async () => {
    expect(await refusal('')).toBe('Invalid change address: No address type matched for: ');
  });

  it('a text of more than 1,024 characters is refused with its length and its first 40 characters, and not repeated', async () => {
    const message = await refusal('a'.repeat(2_000));
    expect(message).toBe(`Invalid change address: The text has 2000 characters, and an address has at most 1024. It starts with: ${'a'.repeat(40)}`);
    expect(message).not.toContain('a'.repeat(41));
  });

  it('a text of exactly 1,024 characters is not refused for its length: Lucid reads it, as it reads any text that is not an address', async () => {
    const text = 'a'.repeat(1_024);
    expect(await refusal(text)).toBe(`Invalid change address: No address type matched for: ${text}`);
  });
});
