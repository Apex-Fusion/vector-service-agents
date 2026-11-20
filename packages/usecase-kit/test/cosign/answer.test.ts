// packages/usecase-kit/test/cosign/answer.test.ts
// The route checks its own answer before it sends it: the body, the validity flag, the auxiliary data and each other entry of the witness set are the bytes of the input, the decoder reads the answer as it
// is written, and the list of vkey witnesses is the old list and the one witness of the delegation key. A fault in the writer of the answer is `internal`, and the answer is not sent. Here the writer is
// replaced by one that makes each fault, and the twin is the writer as it is.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as Layout from '../../src/cosign/layout.ts';
import { DELEG_A, PRINCIPAL, build, harness, hostedToolTakes, requestOf, signedBy } from './support.ts';

type Tamper = (answer: Uint8Array, input: Uint8Array) => Uint8Array | undefined;
const control = vi.hoisted(() => ({ tamper: null as Tamper | null, layout: null as typeof Layout | null }));

vi.mock('../../src/cosign/layout.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof Layout>();
  control.layout = actual;
  return {
    ...actual,
    addVkeyWitness: (...args: Parameters<typeof Layout.addVkeyWitness>) => {
      const answer = actual.addVkeyWitness(...args);
      return control.tamper === null || answer === undefined ? answer : control.tamper(answer, args[0]);
    },
  };
});

afterEach(() => {
  control.tamper = null;
});

const flip = (bytes: Uint8Array, at: number): Uint8Array => Uint8Array.from(bytes, (byte, i) => (i === at ? byte ^ 0x01 : byte));
const positionOf = (bytes: Uint8Array, part: string): number => Buffer.from(bytes).indexOf(Buffer.from(part, 'hex'));

/** The route answers `hex` with its writer changed by `tamper`. */
async function answered(tamper: Tamper | null, hex?: string) {
  const input = hex ?? (await build()).hex;
  control.tamper = tamper;
  const result = await harness().route.cosign(requestOf(input));
  return { result, input };
}

/** The answer with a second vkey witness of the same key added, by the real writer. */
function twice(answer: Uint8Array): Uint8Array {
  const layout = control.layout!;
  return layout.addVkeyWitness(answer, layout.readFrame(answer)!, Buffer.from(DELEG_A.publicKey, 'hex'), new Uint8Array(64))!;
}

describe('the answer is checked before it is sent', () => {
  it('is sent when the writer is right, and the hosted tool takes it', async () => {
    const { result, input } = await answered(null);
    if (!result.ok) throw new Error(result.detail);
    expect(hostedToolTakes(input, result.value.transaction, DELEG_A.keyHash)).toMatchObject({ ok: true });
  });

  it('is sent when the writer returns what it made and the check agrees: the twin of the faults below', async () => {
    const { result } = await answered((answer) => answer);
    expect(result.ok).toBe(true);
  });

  const faults: [string, Tamper][] = [
    ['a byte of the body is changed', (answer) => flip(answer, 40)],
    ['the validity flag is changed', (answer) => Uint8Array.from([...answer.subarray(0, answer.length - 2), 0xf4, 0xf6])],
    ['the auxiliary data is changed', (answer) => Uint8Array.from([...answer.subarray(0, answer.length - 1), 0xa0])],
    ['a byte of another entry of the witness set is changed', (answer) => flip(answer, answer.length - 5)],
    ['a byte is added after the transaction', (answer) => Uint8Array.from([...answer, 0])],
    ['the signature is changed', (answer) => flip(answer, positionOf(answer, DELEG_A.publicKey) + 32 + 2 + 7)],
    ['the key of the witness is changed', (answer) => flip(answer, positionOf(answer, DELEG_A.publicKey) + 3)],
    ['the answer is cut', (answer) => answer.subarray(0, answer.length - 3)],
    ['the answer is the input, with no witness', (_answer, input) => input],
    ['the answer has two witnesses of the key', twice],
    ['the answer is empty', () => new Uint8Array(0)],
    ['the writer gives nothing', () => undefined],
  ];

  it.each(faults)('is `internal` and not sent when %s', async (_name, tamper) => {
    const { result } = await answered(tamper);
    expect(result).toMatchObject({ ok: false, code: 'internal' });
    expect(JSON.stringify(result)).not.toMatch(/[0-9a-f]{40}/);
  });

  it('keeps the witnesses that the request had, and refuses a writer that drops one', async () => {
    const signed = signedBy((await build()).hex, PRINCIPAL);
    expect((await answered(null, signed)).result.ok).toBe(true);
    expect((await answered((_answer, input) => input, signed)).result).toMatchObject({ ok: false, code: 'internal' });
  });
});
