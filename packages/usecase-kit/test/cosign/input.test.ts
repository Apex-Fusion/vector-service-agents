// packages/usecase-kit/test/cosign/input.test.ts
// Input from outside. The size is checked before any parse. The request frame has one member and the transaction is hex. A transaction that is cut, that has bytes after it, that nests too deep, or that
// is not CBOR is refused with a typed code, and it never makes the route throw or hang. After each of them the route still signs a good transaction.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_COSIGN_REQUEST_BYTES, MAX_TRANSACTION_HEX } from '@vsa/usecase-kit/cosign';
import { DELEG_A, bodyHexOf, build, harness, hostedToolTakes, requestOf } from './support.ts';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the size is checked before any parse', () => {
  it('refuses a body over the limit with `request_too_large`, and does not call JSON.parse', async () => {
    const parse = vi.spyOn(JSON, 'parse');
    const text = '['.repeat(MAX_COSIGN_REQUEST_BYTES + 1);
    expect(await harness().route.cosign(text)).toMatchObject({ ok: false, code: 'request_too_large' });
    expect(await harness().route.cosign(Buffer.from(text))).toMatchObject({ ok: false, code: 'request_too_large' });
    expect(parse).not.toHaveBeenCalled();
  });

  it('counts bytes of UTF-8 and not characters, and takes a body of exactly the limit to the parse', async () => {
    const parse = vi.spyOn(JSON, 'parse');
    expect(await harness().route.cosign('é'.repeat(MAX_COSIGN_REQUEST_BYTES / 2 + 1))).toMatchObject({ ok: false, code: 'request_too_large' });
    expect(parse).not.toHaveBeenCalled();
    expect(await harness().route.cosign(' '.repeat(MAX_COSIGN_REQUEST_BYTES))).toMatchObject({ ok: false, code: 'bad_shape' });
    expect(parse).toHaveBeenCalledTimes(1);
  });

  it('has a limit for the transaction that is the most that the ledger takes: 16,384 bytes', () => {
    expect(MAX_TRANSACTION_HEX).toBe(2 * 16_384);
    expect(MAX_COSIGN_REQUEST_BYTES).toBeGreaterThan(MAX_TRANSACTION_HEX + '{"transaction":""}'.length);
  });
});

describe('the frame of the request', () => {
  it('takes the request as text and as bytes, and the transaction in lower case and in upper case', async () => {
    const { hex } = await build();
    const results = [requestOf(hex), Buffer.from(requestOf(hex)), requestOf(hex.toUpperCase()), `  ${requestOf(hex)}\n`];
    for (const body of results) expect((await harness().route.cosign(body)).ok).toBe(true);
  });

  it.each([[5], [null], [undefined], [{}], [['a']], [true]])('refuses a body that is not text or bytes: %s', async (body) => {
    expect(await harness().route.cosign(body as unknown as string)).toMatchObject({ ok: false, code: 'bad_shape' });
  });

  it('refuses bytes that are not UTF-8', async () => {
    expect(await harness().route.cosign(Uint8Array.from([0x7b, 0xff, 0xfe, 0x7d]))).toMatchObject({ ok: false, code: 'bad_shape' });
  });

  it.each([
    ['nothing', ''], ['text that is not JSON', 'transaction'], ['JSON that is cut', '{"transaction":'], ['null', 'null'], ['an array', '[]'], ['a string', '"00"'], ['a number', '5'],
    ['an object with no member', '{}'], ['a member with another name', '{"tx":"00"}'], ['a member that is in another case', '{"Transaction":"00"}'],
  ])('refuses %s', async (_name, body) => {
    expect(await harness().route.cosign(body)).toMatchObject({ ok: false, code: 'bad_shape' });
  });

  it('refuses a member that the request does not have, with the transaction right: the request has one member', async () => {
    const { hex } = await build();
    expect(await harness().route.cosign(JSON.stringify({ transaction: hex, agent: 'did:vector:x' }))).toMatchObject({ ok: false, code: 'bad_shape' });
    expect(await harness().route.cosign(`{"__proto__":{},"transaction":"${hex}"}`)).toMatchObject({ ok: false, code: 'bad_shape' });
    expect((await harness().route.cosign(requestOf(hex))).ok).toBe(true);
  });

  it.each([
    ['a number', 5], ['null', null], ['a list', ['00']], ['an object', { hex: '00' }], ['true', true], ['an empty text', ''], ['text of an odd length', 'abc'], ['text that is not hex', 'zz'],
    ['hex with a prefix', '0x84'], ['hex with a space', '84 a0'], ['hex with a new line', '84a0\n'], ['hex in the form of base64', 'hKCg9vY='],
  ])('refuses a transaction that is %s', async (_name, transaction) => {
    expect(await harness().route.cosign(JSON.stringify({ transaction }))).toMatchObject({ ok: false, code: 'bad_shape' });
  });

  it('refuses a transaction of more hex characters than the limit, also when the body is under its limit', async () => {
    const body = JSON.stringify({ transaction: 'a'.repeat(MAX_TRANSACTION_HEX + 2) });
    expect(Buffer.byteLength(body)).toBeLessThanOrEqual(MAX_COSIGN_REQUEST_BYTES);
    expect(await harness().route.cosign(body)).toMatchObject({ ok: false, code: 'bad_shape' });
  });

  it('refuses a JSON of deep nesting and a JSON that is balanced and deep, and does not throw', async () => {
    const deep = '['.repeat(16_000) + ']'.repeat(16_000);
    expect(await harness().route.cosign(deep)).toMatchObject({ ok: false, code: 'bad_shape' });
    expect(await harness().route.cosign('['.repeat(30_000))).toMatchObject({ ok: false, code: 'bad_shape' });
    expect(await harness().route.cosign(`{"transaction":"00","x":${deep}}`)).toMatchObject({ ok: false, code: 'bad_shape' });
  });
});

describe('a transaction that is not a transaction', () => {
  it.each([
    ['the CBOR integer 0', '00'], ['an empty array', '80'], ['an array of four integers', '8400000000'], ['an empty map', 'a0'], ['a break', 'ff'], ['a text string', '6161'],
    ['an array of four items with a body that is not a map', '84 80 a0 f5 f6'], ['the frame with an empty body', '84 a0 a0 f5 f6'],
  ])('is refused with `not_a_delegation`: %s', async (_name, hex) => {
    expect(await harness().route.cosign(requestOf(hex.replace(/\s/g, '')))).toMatchObject({ ok: false, code: 'not_a_delegation' });
  });

  it('refuses a transaction that is cut, and a transaction that has bytes after it: the decoder reads a prefix, and the route does not', async () => {
    const { hex } = await build();
    for (const cut of [2, 10, hex.length / 2, hex.length - 4, hex.length - 2]) {
      expect(await harness().route.cosign(requestOf(hex.slice(0, Math.floor(cut / 2) * 2))), `cut at ${cut}`).toMatchObject({ ok: false, code: 'not_a_delegation' });
    }
    for (const tail of ['00', 'f6', 'deadbeef', hex.slice(-8)]) {
      expect(await harness().route.cosign(requestOf(hex + tail)), tail).toMatchObject({ ok: false, code: 'not_a_delegation' });
    }
    expect((await harness().route.cosign(requestOf(hex))).ok).toBe(true);
  });

  /** The transaction with `data` as the data of its one redeemer, for the mint at the index 0, and the body of the build: `84 <body> a1 05 81 84 01 00 <data> 82 01 01 f5 f6`. */
  const withRedeemerData = (hex: string, data: string): string => `84${bodyHexOf(hex)}a10581840100${data}820101f5f6`;

  it('refuses CBOR that is nested deeper than 64 levels before it is decoded, and the route signs the next good transaction', async () => {
    const { hex } = await build();
    const h = harness();
    for (const levels of [65, 200, 5_000]) {
      const deep = `${'81'.repeat(levels)}00`;
      expect(await h.route.cosign(requestOf(withRedeemerData(hex, deep))), `${levels} levels`).toMatchObject({ ok: false, code: 'not_a_delegation' });
    }
    // The twin: the same transaction with nesting inside the limit is read, and then it is the same Delegate with a redeemer that has some data.
    const inside = await h.route.cosign(requestOf(withRedeemerData(hex, `${'81'.repeat(10)}00`)));
    expect(inside.ok).toBe(true);
    const good = await h.route.cosign(requestOf(hex));
    if (!good.ok) throw new Error(good.detail);
    expect(hostedToolTakes(hex, good.value.transaction, DELEG_A.keyHash)).toMatchObject({ ok: true });
  });

  it('refuses a length that the bytes cannot hold, in a place that the decoder library would allocate for', async () => {
    const { hex } = await build();
    for (const data of ['5bffffffffffffffff', '9bffffffffffffffff', '5a7fffffff00', 'bb0000000100000000']) {
      expect(await harness().route.cosign(requestOf(withRedeemerData(hex, data))), data).toMatchObject({ ok: false, code: 'not_a_delegation' });
    }
  });

  it('gives a typed result for a build with one byte changed, and what it signs is read by the hosted tool', async () => {
    const { hex } = await build();
    let seed = 0x9e3779b9;
    const next = (): number => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
    };
    let signed = 0;
    for (let i = 0; i < 80; i++) {
      const at = 2 * Math.floor(next() * (hex.length / 2));
      const byte = (parseInt(hex.slice(at, at + 2), 16) ^ (1 << Math.floor(next() * 8))).toString(16).padStart(2, '0');
      const changed = hex.slice(0, at) + byte + hex.slice(at + 2);
      const result = await harness().route.cosign(requestOf(changed));
      if (result.ok) {
        signed += 1;
        // A change that leaves a Delegate (the fee, a signature, a hash) is signed over its own body, and the tool takes the answer.
        expect(hostedToolTakes(changed, result.value.transaction, DELEG_A.keyHash), `byte ${at / 2}`).toMatchObject({ ok: true });
      } else {
        expect(['not_a_delegation', 'not_for_this_agent', 'principal_not_allowed', 'expired', 'spends_agent_funds', 'key_in_use', 'bad_shape']).toContain(result.code);
      }
    }
    expect(signed).toBeLessThan(80);
  });
});
