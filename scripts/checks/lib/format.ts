// scripts/checks/lib/format.ts - how the checks write amounts, times and durations, and how they make a value ready for a JSON file.

/** An amount of lovelace as units with six decimals. The ledger unit has no other name in this repository. */
export function units(lovelace: bigint): string {
  const negative = lovelace < 0n;
  const whole = negative ? -lovelace : lovelace;
  return `${negative ? '-' : ''}${whole / 1_000_000n}.${(whole % 1_000_000n).toString().padStart(6, '0')} units`;
}

/** POSIX milliseconds as a UTC time. A time that no date can show comes back as its number. */
export function iso(ms: number): string {
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? String(ms) : date.toISOString();
}

/** A length of time as days, hours, minutes and seconds, from the biggest part. A part of a second counts as a second, so that a wait is never too short. */
export function duration(ms: number): string {
  let seconds = Math.max(0, Math.ceil(ms / 1000));
  const days = Math.floor(seconds / 86_400);
  seconds -= days * 86_400;
  const hours = Math.floor(seconds / 3600);
  seconds -= hours * 3600;
  const minutes = Math.floor(seconds / 60);
  seconds -= minutes * 60;
  const parts: string[] = [];
  if (days > 0) parts.push(`${days} ${days === 1 ? 'day' : 'days'}`);
  if (hours > 0) parts.push(`${hours} h`);
  if (minutes > 0) parts.push(`${minutes} min`);
  if (seconds > 0 || parts.length === 0) parts.push(`${seconds} s`);
  return parts.join(' ');
}

/** A value as JSON can hold it: each bigint becomes its decimal text, at any depth. A member that is undefined is dropped by JSON.stringify. */
export function jsonSafe(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, member]) => [key, jsonSafe(member)]));
  return value;
}
