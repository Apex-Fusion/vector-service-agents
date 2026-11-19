// packages/id-kit/src/testing/multikey.ts
// `publicKeyMultibase` of a DID document: base58btc, prefix z, of the multicodec header and the key bytes (identity-gateway/src/codec/keys.ts).

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function base58btc(bytes: Uint8Array): string {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  // Base-58 digits, least significant first.
  const digits: number[] = [];
  for (let i = zeros; i < bytes.length; i++) {
    let carry = bytes[i]!;
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j]! << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let out = '1'.repeat(zeros);
  for (let i = digits.length - 1; i >= 0; i--) out += BASE58_ALPHABET[digits[i]!];
  return out;
}

/** Multicodec headers: ed25519-pub (0xed) and p256-pub (0x1200), as unsigned varints. */
const MULTICODEC = { Ed25519: [0xed, 0x01], P256: [0x80, 0x24] } as const;

/** The `publicKeyMultibase` of a key given as a record stores it: 32 bytes for Ed25519, the 33-byte compressed point for P-256. */
export function multikey(keyType: 'Ed25519' | 'P256', publicKeyHex: string): string {
  return `z${base58btc(Uint8Array.from([...MULTICODEC[keyType], ...Buffer.from(publicKeyHex, 'hex')]))}`;
}
