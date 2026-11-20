// packages/usecase-kit/test/cosign/signing.test.ts
// The good path: the Delegate that the rule allows, built by the real builder on the fixture world. The agent signs the body that it checked, with the delegation key that the datum names, and the answer
// is the input with that one witness added and no other change.
import { CML } from '@lucid-evolution/lucid';
import { describe, expect, it } from 'vitest';
import { COSIGN_PATH } from '@vsa/usecase-kit/cosign';
import { DELEG_A, DELEG_B, PRINCIPAL, bodyHashOf, bodyHexOf, build, harness, hostedToolTakes, plainRequestOf, requestOf, signedBy, witnessesOf } from './support.ts';

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

  it('is answered with the same transaction and one witness more: the answer differs from the input by that witness only, and the witness of the delegator stays', async () => {
    const { hex: built } = await build();
    const hex = signedBy(built, PRINCIPAL);
    const result = await harness().route.cosign(plainRequestOf(hex));
    if (!result.ok) throw new Error(result.detail);
    const answer = result.value.transaction;
    expect(answer).not.toBe(hex);
    // The body, the validity flag and the auxiliary data are the bytes of the input. The input has the one witness of the delegator, so the answer has it and the new one at its end.
    expect(bodyHexOf(answer)).toBe(bodyHexOf(hex));
    expect(witnessesOf(hex).map(([hash]) => hash)).toEqual([PRINCIPAL.keyHash]);
    const witnesses = witnessesOf(answer);
    expect(witnesses.map(([hash]) => hash)).toEqual([PRINCIPAL.keyHash, DELEG_A.keyHash]);
    expect(witnesses[0]).toEqual(witnessesOf(hex)[0]);
    // The answer, with its list of vkey witnesses taken out, is the input with its list taken out.
    const without = (text: string) => {
      const set = CML.Transaction.from_cbor_hex(text).witness_set();
      return JSON.stringify({ ...JSON.parse(set.to_json()), vkeywitnesses: null });
    };
    expect(without(answer)).toBe(without(hex));
    // And the bytes. Each witness is 101 bytes: 82 5820 <key> 5840 <signature>. The answer is the input with the head of the list of witnesses counted up (81 to 82), and the new witness after the old one.
    const witnessBytes = ([, publicKey, signature]: [string, string, string]): string => `825820${publicKey}5840${signature}`;
    const old = witnessBytes(witnesses[0]!);
    const added = witnessBytes(witnesses[1]!);
    expect(added).toHaveLength(2 * 101);
    const at = hex.indexOf(old);
    expect([hex.slice(at - 2, at), answer.slice(at - 2, at)]).toEqual(['81', '82']);
    expect(answer.slice(0, at - 2)).toBe(hex.slice(0, at - 2));
    expect(answer.slice(at, at + old.length + added.length)).toBe(old + added);
    expect(answer.slice(at + old.length + added.length)).toBe(hex.slice(at + old.length));
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
    const result = await harness().route.cosign(plainRequestOf(signedBy(hex, PRINCIPAL).toUpperCase()));
    if (!result.ok) throw new Error(result.detail);
    expect(result.value.transaction).toBe(result.value.transaction.toLowerCase());
    expect(hostedToolTakes(hex, result.value.transaction, DELEG_A.keyHash)).toMatchObject({ ok: true });
  });

  it('is served at the path that the hosted tool calls', () => {
    expect(harness().route.path).toBe(COSIGN_PATH);
    expect(COSIGN_PATH).toBe('/cosign/delegate');
  });
});
