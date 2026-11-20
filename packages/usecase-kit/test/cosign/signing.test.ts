// packages/usecase-kit/test/cosign/signing.test.ts
// The good path: the Delegate that the rule allows, built by the real builder on the fixture world. The agent signs the body that it checked, with the delegation key that the datum names, and the answer
// is the input with that one witness added and no other change.
import { CML } from '@lucid-evolution/lucid';
import { describe, expect, it } from 'vitest';
import { COSIGN_PATH } from '@vsa/usecase-kit/cosign';
import { DELEG_A, DELEG_B, PRINCIPAL, bodyHashOf, bodyHexOf, build, harness, hostedToolTakes, requestOf, signedBy, witnessesOf } from './support.ts';

describe('the Delegate that the rule allows', () => {
  it('is signed with the delegation key that the datum names, over the hash of the body', async () => {
    const { hex } = await build();
    const h = harness();
    const result = await h.route.cosign(requestOf(hex));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.keyHash).toBe(DELEG_A.keyHash);
    expect(result.value.bodyHash).toBe(bodyHashOf(hex));
    // The key signed the 32 bytes of the hash of the body, and nothing else, one time.
    expect(h.signed).toHaveLength(1);
    expect(h.signed[0]!.keyHash).toBe(DELEG_A.keyHash);
    expect(Buffer.from(h.signed[0]!.message).toString('hex')).toBe(bodyHashOf(hex));
    expect(h.logs).toEqual([`cosign signed key ${DELEG_A.keyHash.slice(0, 8)} body ${bodyHashOf(hex).slice(0, 12)}`]);
  });

  it('is answered with the same transaction and one witness more: the answer differs from the input by that witness only', async () => {
    const { hex } = await build();
    const result = await harness().route.cosign(requestOf(hex));
    if (!result.ok) throw new Error(result.detail);
    const answer = result.value.transaction;
    expect(answer).not.toBe(hex);
    // The body, the validity flag and the auxiliary data are the bytes of the input. The input has no witness, so the answer has exactly the one.
    expect(bodyHexOf(answer)).toBe(bodyHexOf(hex));
    expect(witnessesOf(hex)).toEqual([]);
    const witnesses = witnessesOf(answer);
    expect(witnesses.map(([hash]) => hash)).toEqual([DELEG_A.keyHash]);
    // The answer, with its list of vkey witnesses taken out, is the input with its list taken out.
    const without = (text: string) => {
      const set = CML.Transaction.from_cbor_hex(text).witness_set();
      return JSON.stringify({ ...JSON.parse(set.to_json()), vkeywitnesses: null });
    };
    expect(without(answer)).toBe(without(hex));
    // And the bytes. The answer is the array head and the body of the input, the head of the witness set with one entry more, the new entry (key 0, the tag 258 and an array of one item, then the witness of
    // 101 bytes), and then every byte that the input has after the head of its witness set: its redeemers, the validity flag and the auxiliary data.
    const bodyEnd = 2 + bodyHexOf(hex).length;
    expect(answer.slice(0, bodyEnd)).toBe(hex.slice(0, bodyEnd));
    expect([hex.slice(bodyEnd, bodyEnd + 2), answer.slice(bodyEnd, bodyEnd + 2)]).toEqual(['a1', 'a2']);
    const entryLength = 2 + 8 + 2 * 101;
    expect(answer.slice(bodyEnd + 2, bodyEnd + 2 + entryLength)).toMatch(/^00d9010281825820/);
    expect(answer.slice(bodyEnd + 2 + entryLength)).toBe(hex.slice(bodyEnd + 2));
  });

  it('is taken by the hosted tool: one witness of the delegate key whose signature verifies over the body that the tool sent', async () => {
    const { hex } = await build();
    const result = await harness().route.cosign(requestOf(hex));
    if (!result.ok) throw new Error(result.detail);
    expect(hostedToolTakes(hex, result.value.transaction, DELEG_A.keyHash)).toMatchObject({ ok: true });
  });

  it('keeps the witnesses that the request carried, and adds its own at the end', async () => {
    const { hex } = await build();
    const signed = signedBy(hex, PRINCIPAL);
    const result = await harness().route.cosign(requestOf(signed));
    if (!result.ok) throw new Error(result.detail);
    const witnesses = witnessesOf(result.value.transaction);
    expect(witnesses.map(([hash]) => hash)).toEqual([PRINCIPAL.keyHash, DELEG_A.keyHash]);
    expect(witnesses[0]).toEqual(witnessesOf(signed)[0]);
    expect(bodyHexOf(result.value.transaction)).toBe(bodyHexOf(signed));
    expect(hostedToolTakes(signed, result.value.transaction, DELEG_A.keyHash)).toMatchObject({ ok: true });
  });

  it('is signed with the other delegation key when the datum names it', async () => {
    const { hex } = await build({ delegateKey: DELEG_B.keyHash });
    const h = harness();
    const result = await h.route.cosign(requestOf(hex));
    if (!result.ok) throw new Error(result.detail);
    expect(result.value.keyHash).toBe(DELEG_B.keyHash);
    expect(h.signed.map((call) => call.keyHash)).toEqual([DELEG_B.keyHash]);
    expect(hostedToolTakes(hex, result.value.transaction, DELEG_B.keyHash)).toMatchObject({ ok: true });
  });

  it('is answered again with the same transaction when the same body comes again, and the key signs the same hash', async () => {
    const { hex } = await build();
    const h = harness();
    const first = await h.route.cosign(requestOf(hex));
    const second = await h.route.cosign(requestOf(hex));
    if (!first.ok || !second.ok) throw new Error('refused');
    expect(second.value.transaction).toBe(first.value.transaction);
    expect(h.signed.map((call) => Buffer.from(call.message).toString('hex'))).toEqual([bodyHashOf(hex), bodyHashOf(hex)]);
  });

  it('is accepted with the hex in upper case, and the answer is in lower case', async () => {
    const { hex } = await build();
    const result = await harness().route.cosign(requestOf(hex.toUpperCase()));
    if (!result.ok) throw new Error(result.detail);
    expect(result.value.transaction).toBe(result.value.transaction.toLowerCase());
    expect(hostedToolTakes(hex, result.value.transaction, DELEG_A.keyHash)).toMatchObject({ ok: true });
  });

  it('is served at the path that the hosted tool calls', () => {
    expect(harness().route.path).toBe(COSIGN_PATH);
    expect(COSIGN_PATH).toBe('/cosign/delegate');
  });
});
