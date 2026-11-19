// packages/vector-read/test/fixtures/decoder-watch.ts
//
// For the tests of the CBOR check (cbor-guard.test.ts). A watch stands in for a decoder of Lucid or CML until `vi.restoreAllMocks()`. An input that nests
// no deeper than the limit goes to the real decoder. A deeper input is counted, and the watch throws a marked Error for it: the real decoder never sees it,
// and the guard that should have refused it is the failure. So a test shows a missing guard, and no deep input ever reaches a real library.
import { vi } from 'vitest';
import { CborGuardError, cborDepth } from '../../src/cbor-depth.ts';

type Decoder = (input: string | Uint8Array, ...rest: unknown[]) => unknown;

export interface DecoderWatch {
  /** How many inputs reached the watched decoder, deep or not. */
  calls: () => number;
  /** How many of them nest past the limit: each one is an input that a guard did not refuse. */
  reached: () => number;
}

/** Watches `target[method]`, which takes hex or bytes as its first argument. */
export function watchDecoder(target: object, method: string): DecoderWatch {
  const real = (target as Record<string, Decoder>)[method].bind(target);
  let calls = 0;
  let reached = 0;
  vi.spyOn(target as Record<string, Decoder>, method).mockImplementation((input, ...rest) => {
    calls += 1;
    try {
      cborDepth(typeof input === 'string' ? Buffer.from(input, 'hex') : input);
    } catch (err) {
      // cborDepth refuses the first level past the limit. Any other refusal is not CBOR: the real decoder refuses it.
      if (err instanceof CborGuardError && err.reason === 'depth') {
        reached += 1;
        throw new Error('DECODER REACHED: the guard did not refuse this input');
      }
    }
    return real(input, ...rest);
  });
  return { calls: () => calls, reached: () => reached };
}
