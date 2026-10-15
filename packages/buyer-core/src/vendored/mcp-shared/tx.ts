// Pure transaction helpers. No network access - this module is safe to import
// from the signer, which must have no network capability.

export function lovelaceToAda(lovelace: string | number | bigint): string {
  if (lovelace === undefined || lovelace === null) return '0.000000';
  try {
    return (Number(BigInt(String(lovelace))) / 1_000_000).toFixed(6);
  } catch {
    return '0.000000';
  }
}
