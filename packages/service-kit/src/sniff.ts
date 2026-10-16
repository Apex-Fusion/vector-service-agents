// packages/service-kit/src/sniff.ts
// The type of a file, read from its first bytes and never from a header or a declaration. A module with no imports.

/**
 * A type and the bytes that name it: `magic` at offset `at` (0 by default), each byte of the file compared under its `mask` (0xff by default; a mask of 0 ignores
 * the byte). The mask is applied to the file's byte and not to the magic, which is compared as it is given: give the magic masked (no bit outside its mask), or
 * that byte never matches.
 */
export interface Signature { type: string; at?: number; magic: readonly number[]; mask?: readonly number[] }

/** The type of the first signature the bytes match, in the order given, or null when they match none. */
export function sniffBy(bytes: Uint8Array, signatures: readonly Signature[]): string | null {
  for (const { type, at = 0, magic, mask } of signatures) {
    if (bytes.length < at + magic.length) continue;
    if (magic.every((byte, i) => (bytes[at + i] & (mask?.[i] ?? 0xff)) === byte)) return type;
  }
  return null;
}

/** The bytes of an ASCII text, for a signature written as letters (RIFF, ftyp). */
export const ascii = (text: string): number[] => [...text].map((c) => c.charCodeAt(0));
