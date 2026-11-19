// scripts/checks/lib/addresses.ts - bech32 text and the payment credential of an address. The guards need to know whose key an input belongs to, and the key files need to read a key.

const ALPHABET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const GENERATORS = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

function polymod(values: readonly number[]): number {
  let check = 1;
  for (const value of values) {
    const top = check >>> 25;
    check = ((check & 0x1ffffff) << 5) ^ value;
    for (let i = 0; i < 5; i++) if (((top >>> i) & 1) === 1) check ^= GENERATORS[i]!;
  }
  return check >>> 0;
}

/** Reads a bech32 text (BIP 173, lower case only, no limit on the length): its prefix and its bytes, or null when the text is not one or its checksum is wrong. */
export function bech32Decode(text: string): { hrp: string; bytes: Uint8Array } | null {
  if (text !== text.toLowerCase()) return null;
  const separator = text.lastIndexOf('1');
  if (separator < 1 || separator + 7 > text.length) return null;
  const hrp = text.slice(0, separator);
  const data: number[] = [];
  for (const char of text.slice(separator + 1)) {
    const value = ALPHABET.indexOf(char);
    if (value < 0) return null;
    data.push(value);
  }
  const expanded = [...[...hrp].map((c) => c.charCodeAt(0) >>> 5), 0, ...[...hrp].map((c) => c.charCodeAt(0) & 31)];
  if (polymod([...expanded, ...data]) !== 1) return null;
  // The five-bit groups, without the six checksum groups, are regrouped to bytes. A rest of padding bits must be zero and shorter than a group.
  let accumulator = 0;
  let bits = 0;
  const bytes: number[] = [];
  for (const value of data.slice(0, -6)) {
    accumulator = (accumulator << 5) | value;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((accumulator >>> bits) & 0xff);
      accumulator &= (1 << bits) - 1;
    }
  }
  if (bits >= 5 || accumulator !== 0) return null;
  return { hrp, bytes: Uint8Array.from(bytes) };
}

/**
 * The key hash (56 hex characters) that the payment part of a Shelley address names, or null when the address is not one, or its payment part is a script. Base, enterprise and
 * pointer addresses have a payment part; a reward address and a Byron address have none that this reads.
 */
export function keyCredentialOf(address: string): string | null {
  const decoded = bech32Decode(address);
  if (decoded === null || decoded.bytes.length < 29) return null;
  const type = decoded.bytes[0]! >>> 4;
  const hasPayment = type <= 7;
  const script = (type & 1) === 1;
  return hasPayment && !script ? Buffer.from(decoded.bytes.subarray(1, 29)).toString('hex') : null;
}
