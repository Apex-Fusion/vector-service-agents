import { CML } from '@lucid-evolution/lucid';
/** A raw 64-hex Ed25519 key (the form gen-keypair prints and the env file holds) as the bech32 the signer takes. */
export function rawHexToBech32(privateKeyHex: string): string {
  if (!/^[0-9a-f]{64}$/.test(privateKeyHex)) throw new Error('private key must be 64 lowercase hex characters');
  return CML.PrivateKey.from_normal_bytes(Buffer.from(privateKeyHex, 'hex')).to_bech32();
}
/**
 * The key hash and the mainnet enterprise address (header 0x61: key credential, no stake part) of a raw key, which is what RealChain derives for the key it
 * is given (chain.ts) and what gen-keypair prints. Pure: no node is asked, so a service can publish and check its buyer identity before it reaches one.
 * A key that is not 64 lowercase hex characters is refused without being echoed.
 */
export function buyerIdentityOf(privateKeyHex: string): { buyerPkh: string; address: string } {
  const keyHash = CML.PrivateKey.from_bech32(rawHexToBech32(privateKeyHex)).to_public().hash();
  return { buyerPkh: keyHash.to_hex(), address: CML.EnterpriseAddress.new(1, CML.Credential.new_pub_key(keyHash)).to_address().to_bech32() };
}
