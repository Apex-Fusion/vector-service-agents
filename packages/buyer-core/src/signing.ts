import { CML } from '@lucid-evolution/lucid';
/** A raw 64-hex Ed25519 key (the form gen-keypair prints and the env file holds) as the bech32 the signer takes. */
export function rawHexToBech32(privateKeyHex: string): string {
  if (!/^[0-9a-f]{64}$/.test(privateKeyHex)) throw new Error('private key must be 64 lowercase hex characters');
  return CML.PrivateKey.from_normal_bytes(Buffer.from(privateKeyHex, 'hex')).to_bech32();
}
