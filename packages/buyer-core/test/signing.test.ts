// packages/buyer-core/test/signing.test.ts
import { describe, it, expect } from 'vitest';
import { CML } from '@lucid-evolution/lucid';
import { blake2b224Hex } from '@vsa/vector-read';
import { buyerIdentityOf, paymentKeyHashOf, rawHexToBech32, signTransaction } from '../src/index.ts';
import { RealChain } from '../src/chain.ts';
import type { ChainProvider } from '../src/chain.ts';

const rawHexOf = (sk: CML.PrivateKey): string => Buffer.from(sk.to_raw_bytes()).toString('hex');

/** A minimal unsigned transaction built with CML alone: one input, one output to the key's own enterprise address, fee 500000, no scripts. */
function unsignedTxFor(owner: CML.PrivateKey): string {
  const inputs = CML.TransactionInputList.new();
  inputs.add(CML.TransactionInput.new(CML.TransactionHash.from_hex('ab'.repeat(32)), 0n));
  const outputs = CML.TransactionOutputList.new();
  const ownAddress = CML.EnterpriseAddress.new(1, CML.Credential.new_pub_key(owner.to_public().hash())).to_address();
  outputs.add(CML.TransactionOutput.new(ownAddress, CML.Value.from_coin(2_000_000n)));
  const body = CML.TransactionBody.new(inputs, outputs, 500_000n);
  return CML.Transaction.new(body, CML.TransactionWitnessSet.new(), true).to_cbor_hex();
}

describe('signing with a raw key', () => {
  it('rawHexToBech32 round-trips through CML and refuses anything but 64 hex', () => {
    const sk = CML.PrivateKey.generate_ed25519();
    const hex = rawHexOf(sk);
    expect(rawHexToBech32(hex)).toBe(sk.to_bech32());
    expect(() => rawHexToBech32('abc')).toThrow(/64 lowercase hex/);
    // Upper case, one character short, one too many, and a character that is not hex.
    for (const bad of [hex.toUpperCase(), hex.slice(1), `${hex}0`, `${hex.slice(1)}g`]) expect(() => rawHexToBech32(bad)).toThrow(/64 lowercase hex/);
  });

  it('signTransaction adds one vkey witness whose public key hashes to the signer and leaves the body bytes alone', () => {
    const sk = CML.PrivateKey.generate_ed25519();
    const unsignedCborHex = unsignedTxFor(sk);
    const unsigned = CML.Transaction.from_cbor_hex(unsignedCborHex);
    const bodyHex = unsigned.body().to_cbor_hex();

    const { signedCborHex, txHashHex } = signTransaction(unsignedCborHex, rawHexToBech32(rawHexOf(sk)));
    const signed = CML.Transaction.from_cbor_hex(signedCborHex);

    // The body: the same bytes, in the same place (the transaction is a 4-element array whose first element is the body).
    expect(signed.body().to_cbor_hex()).toBe(bodyHex);
    expect(signedCborHex.slice(0, 2 + bodyHex.length)).toBe(`84${bodyHex}`);
    expect(unsignedCborHex.slice(0, 2 + bodyHex.length)).toBe(`84${bodyHex}`);

    // One vkey witness added (none before), by the signer's key.
    expect(unsigned.witness_set().vkeywitnesses()?.len() ?? 0).toBe(0);
    const witnesses = signed.witness_set().vkeywitnesses();
    expect(witnesses?.len()).toBe(1);
    const witness = witnesses!.get(0);
    expect(witness.vkey().hash().to_hex()).toBe(sk.to_public().hash().to_hex());

    // The signature verifies over hash_transaction(body), and that hash is the one returned.
    const txHash = CML.hash_transaction(signed.body());
    expect(txHashHex).toBe(txHash.to_hex());
    expect(txHashHex).toBe(CML.hash_transaction(unsigned.body()).to_hex());
    expect(witness.vkey().verify(txHash.to_raw_bytes(), witness.ed25519_signature())).toBe(true);
    expect(witness.vkey().verify(new Uint8Array(32), witness.ed25519_signature())).toBe(false);
  });
});

describe('the identity of a buyer key', () => {
  /** What gen-keypair prints for a key, composed byte by byte: the hash of the public key, and the address of header 0x61 (enterprise, key credential, mainnet) over it. */
  const printed = (sk: CML.PrivateKey) => {
    const buyerPkh = blake2b224Hex(Buffer.from(sk.to_public().to_raw_bytes()).toString('hex'));
    return { buyerPkh, address: CML.Address.from_raw_bytes(Buffer.from(`61${buyerPkh}`, 'hex')).to_bech32() };
  };

  it('buyerIdentityOf gives the key hash and the mainnet enterprise address of the key, with no node asked', () => {
    for (let i = 0; i < 3; i++) {
      const sk = CML.PrivateKey.generate_ed25519();
      expect(buyerIdentityOf(rawHexOf(sk))).toStrictEqual(printed(sk));
    }
  });

  it('is what RealChain derives for the same key', () => {
    const hex = rawHexOf(CML.PrivateKey.generate_ed25519());
    const chain = new RealChain({} as ChainProvider, { privateKeyHex: hex }); // the constructor reads nothing from the node
    expect(buyerIdentityOf(hex)).toStrictEqual({ buyerPkh: chain.buyerPkh, address: chain.address });
  });

  it('gives an address that decodes to its key hash and starts as a mainnet enterprise key address does', () => {
    const { buyerPkh, address } = buyerIdentityOf(rawHexOf(CML.PrivateKey.generate_ed25519()));
    expect(address.startsWith('addr1v')).toBe(true);
    expect(paymentKeyHashOf(address)).toBe(buyerPkh);
  });

  it('refuses anything but 64 lowercase hex, and the message does not carry what it was given', () => {
    const hex = rawHexOf(CML.PrivateKey.generate_ed25519());
    for (const bad of [hex.toUpperCase(), hex.slice(1), `${hex}0`, `${hex.slice(1)}g`, `0x${hex}`, '']) {
      let message = '';
      try { buyerIdentityOf(bad); } catch (e) { message = (e as Error).message; }
      expect(message, bad).toMatch(/64 lowercase hex/);
      if (bad !== '') expect(message).not.toContain(bad);
    }
  });
});
