// packages/usecase-kit/test/cosign/delegator.test.ts
// The agent signs a body only after the delegator signed it, and it is never the delegator of its own delegation. Without this, a stranger who knows the key hash of a principal on the allowlist (the hashes
// are public in the datums on the chain) could make the agent hold each of its delegation keys for a body that the principal never sent. Each refusal here has its twin, and each refusal comes before the
// register is asked and before the ledger is read.
import { CML } from '@lucid-evolution/lucid';
import { blake2b } from '@noble/hashes/blake2b';
import { describe, expect, it } from 'vitest';
import { Allowlist, COSIGN_STATUS, KeyReservations, createCosignRoute } from '@vsa/usecase-kit/cosign';
import {
  DELEG_A, DELEG_B, PRINCIPAL, SERVICE, STRANGER, SUPPLIER, bodyHashOf, bodyHexOf, build, changed, configOf, harness, hostedToolTakes, ledgerOf, plainRequestOf, requestOf, signedBy, withRequiredSigners,
  witnessesOf, world,
} from './support.ts';
import type { Setup, TestKey } from './support.ts';

const SIGN_FIRST = 'sign the transaction with the key of the delegator first, and then ask again';

/** The route with a register and a ledger that record each call, so that a test sees what the route asked before it answered. */
function watched(over: Partial<Setup> = {}) {
  const calls: string[] = [];
  const registry = new KeyReservations();
  const inner = ledgerOf(world());
  const h = harness({
    ...over,
    register: {
      take: (claim, now) => {
        calls.push('take');
        return registry.take(claim, now);
      },
      commit: (claim, now) => {
        calls.push('commit');
        return registry.commit(claim, now);
      },
      release: (claim) => {
        calls.push('release');
        return registry.release(claim);
      },
    },
    ledger: {
      outputs: (refs) => {
        calls.push('outputs');
        return inner.outputs(refs);
      },
      delegateKeysInUse: () => {
        calls.push('delegations');
        return inner.delegateKeysInUse();
      },
    },
  });
  return { h, calls, registry };
}

/** The transaction with one vkey witness more at the end of its list: the key and the signature in hex. */
function withWitness(hex: string, publicKey: string, signature: string): string {
  return changed(hex, (p) => {
    const list = p.witnesses.vkeywitnesses() ?? CML.VkeywitnessList.new();
    list.add(CML.Vkeywitness.new(CML.PublicKey.from_bytes(Buffer.from(publicKey, 'hex')), CML.Ed25519Signature.from_hex(signature)));
    p.witnesses.set_vkeywitnesses(list);
  });
}

/** The witness of `key` over the body of `hex`: the key and the signature in hex. */
function witnessOver(hex: string, key: TestKey): { publicKey: string; signature: string } {
  const [, publicKey, signature] = witnessesOf(signedBy(hex, key)).find(([hash]) => hash === key.keyHash)!;
  return { publicKey: publicKey!, signature: signature! };
}

/** The agent refuses the request as it is, with `principal_not_allowed` and the message that tells the member to sign first. Nothing outside the route was asked, and no key signed. */
async function refusedForSignature(text: string, over: Partial<Setup> = {}): Promise<void> {
  const { h, calls, registry } = watched(over);
  const result = await h.route.cosign(plainRequestOf(text));
  expect(result).toMatchObject({ ok: false, code: 'principal_not_allowed', detail: SIGN_FIRST });
  expect(h.signed).toEqual([]);
  expect(calls).toEqual([]);
  expect(registry.size).toBe(0);
}

describe('the agent signs only a body that the delegator signed first', () => {
  it('refuses a request with no witness of the delegator with 403 `principal_not_allowed`, and says what to do; the same transaction signed by the delegator is signed', async () => {
    const { hex } = await build();
    await refusedForSignature(hex);
    expect(COSIGN_STATUS.principal_not_allowed).toBe(403);
    const twin = watched();
    const result = await twin.h.route.cosign(plainRequestOf(signedBy(hex, PRINCIPAL)));
    expect(result.ok).toBe(true);
    expect(twin.h.signed).toHaveLength(1);
  });

  it('gives the member the 403 with the code and the message at the handler', async () => {
    const { hex } = await build();
    const response = await harness().route.handle({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: (async function* () {
        yield plainRequestOf(hex);
      })(),
    });
    expect(response.status).toBe(403);
    expect(JSON.parse(response.body)).toEqual({ error: 'principal_not_allowed', message: SIGN_FIRST });
  });

  it('refuses a witness of another key: a stranger, a key of the agent, and the key of a stranger with the signature of the delegator', async () => {
    const { hex } = await build();
    await refusedForSignature(signedBy(hex, STRANGER));
    await refusedForSignature(signedBy(hex, SUPPLIER));
    await refusedForSignature(signedBy(signedBy(hex, STRANGER), DELEG_B));
    // The key of the stranger and the signature of the delegator: the witness is the witness of the stranger, and it does not verify.
    const delegator = witnessOver(hex, PRINCIPAL);
    await refusedForSignature(withWitness(hex, witnessOver(hex, STRANGER).publicKey, delegator.signature));
  });

  it('refuses a witness of the delegator over another body, and a witness that was made before the body changed', async () => {
    const { hex } = await build();
    const other = await build({ resources: [`script:${'be'.repeat(28)}`] });
    expect(bodyHashOf(other.hex)).not.toBe(bodyHashOf(hex));
    const taken = witnessOver(other.hex, PRINCIPAL);
    await refusedForSignature(withWitness(hex, taken.publicKey, taken.signature));
    // The delegator signed this transaction, and then the body changed: the witness stays and does not cover the new body.
    const stale = changed(signedBy(hex, PRINCIPAL), (p) => p.body.set_ttl(p.body.ttl()! + 1n));
    expect(bodyHashOf(stale)).not.toBe(bodyHashOf(hex));
    await refusedForSignature(stale);
  });

  it('refuses a signature of the delegator key that does not verify: bytes that are made up, one bit changed, and zeros', async () => {
    const { hex } = await build();
    const good = witnessOver(hex, PRINCIPAL);
    const flipped = Buffer.from(good.signature, 'hex');
    flipped[10] = flipped[10]! ^ 1;
    for (const signature of ['07'.repeat(64), flipped.toString('hex'), '00'.repeat(64)]) await refusedForSignature(withWitness(hex, good.publicKey, signature));
    // The twin: the witness as it is.
    const twin = watched();
    expect((await twin.h.route.cosign(plainRequestOf(withWitness(hex, good.publicKey, good.signature)))).ok).toBe(true);
  });

  it('refuses two witnesses of the delegator key: the same witness twice, a good one and a bad one, in each order', async () => {
    const { hex } = await build();
    const good = witnessOver(hex, PRINCIPAL);
    const bad = '07'.repeat(64);
    const twice = withWitness(signedBy(hex, PRINCIPAL), good.publicKey, good.signature);
    expect(witnessesOf(twice)).toHaveLength(2);
    await refusedForSignature(twice);
    await refusedForSignature(withWitness(signedBy(hex, PRINCIPAL), good.publicKey, bad));
    await refusedForSignature(withWitness(withWitness(hex, good.publicKey, bad), good.publicKey, good.signature));
  });

  it('refuses the witness of a key of small order whose hash is on the list: the library alone takes its signatures over every body, and the node does not', async () => {
    const identity = `01${'00'.repeat(31)}`;
    const hash = Buffer.from(blake2b(Buffer.from(identity, 'hex'), { dkLen: 28 })).toString('hex');
    const { hex } = await build({ delegator: { type: 'PrincipalKey', hash } });
    // R = the identity point and S = 0; R = the base point and S = 1.
    for (const signature of [`${identity}${'00'.repeat(32)}`, `58${'66'.repeat(31)}01${'00'.repeat(31)}`]) {
      await refusedForSignature(withWitness(hex, identity, signature), { allowed: [PRINCIPAL.keyHash, hash] });
    }
  });

  it('signs a request that the delegator signed: the answer has the witness of the delegator, then the one of the agent, and the bytes of the body of the input', async () => {
    const { hex } = await build();
    const sealed = signedBy(hex, PRINCIPAL);
    const h = harness();
    const result = await h.route.cosign(plainRequestOf(sealed));
    if (!result.ok) throw new Error(result.detail);
    const answer = result.value.transaction;
    expect(witnessesOf(answer).map(([hash]) => hash)).toEqual([PRINCIPAL.keyHash, DELEG_A.keyHash]);
    expect(witnessesOf(answer)[0]).toEqual(witnessesOf(sealed)[0]);
    const bodyEnd = 2 + bodyHexOf(sealed).length;
    expect(answer.slice(0, bodyEnd)).toBe(sealed.slice(0, bodyEnd));
    expect(h.signed.map((call) => Buffer.from(call.message).toString('hex'))).toEqual([bodyHashOf(hex)]);
    expect(hostedToolTakes(sealed, answer, DELEG_A.keyHash)).toMatchObject({ ok: true });
  });

  it('signs a request that has the witnesses of other keys before and after the witness of the delegator, and keeps them', async () => {
    const { hex } = await build();
    const before = signedBy(signedBy(hex, STRANGER), PRINCIPAL);
    const after = signedBy(signedBy(hex, PRINCIPAL), STRANGER);
    for (const [request, expected] of [[before, [STRANGER, PRINCIPAL]], [after, [PRINCIPAL, STRANGER]]] as const) {
      const result = await harness().route.cosign(plainRequestOf(request));
      if (!result.ok) throw new Error(result.detail);
      expect(witnessesOf(result.value.transaction).map(([hash]) => hash)).toEqual([...expected.map((key) => key.keyHash), DELEG_A.keyHash]);
    }
  });

  it('does not hold the key for a request with no witness of the delegator: the next body for the key signs', async () => {
    const first = await build();
    const second = await build({ resources: [`script:${'be'.repeat(28)}`] });
    const { h, registry } = watched();
    expect(await h.route.cosign(plainRequestOf(first.hex))).toMatchObject({ ok: false, code: 'principal_not_allowed' });
    expect(registry.size).toBe(0);
    expect((await h.route.cosign(requestOf(second.hex))).ok).toBe(true);
    // The delegator signed the second body, so the key is held for it. The first body with no witness is still refused for its witness, and the answer does not say that the key is held.
    expect(await h.route.cosign(plainRequestOf(first.hex))).toMatchObject({ ok: false, code: 'principal_not_allowed', detail: SIGN_FIRST });
    expect(await h.route.cosign(requestOf(first.hex))).toMatchObject({ ok: false, code: 'key_in_use' });
  });

  it('tells a caller who has no witness of the delegator nothing about the list or about the other rules: the answer is the same for each key and each fault of the transaction', async () => {
    const listed = (await build()).hex;
    const unlisted = (await build({ delegator: { type: 'PrincipalKey', hash: STRANGER.keyHash } })).hex;
    const answers: unknown[] = [];
    for (const hex of [listed, unlisted, withRequiredSigners(listed, [DELEG_A.keyHash]), withRequiredSigners(unlisted, [DELEG_A.keyHash]), signedBy(listed, DELEG_A)]) {
      answers.push(await harness().route.cosign(plainRequestOf(hex)));
    }
    // The last one has a witness of the delegation key and no witness of the delegator: it is refused for the missing witness too.
    expect(new Set(answers.map((answer) => JSON.stringify(answer))).size).toBe(1);
    expect(answers[0]).toMatchObject({ ok: false, code: 'principal_not_allowed', detail: SIGN_FIRST });
    // The twin: the delegator of the unlisted key signs, and then the list is what refuses, with another text.
    const refused = await harness().route.cosign(requestOf(unlisted, STRANGER));
    expect(refused).toMatchObject({ ok: false, code: 'principal_not_allowed' });
    expect(refused.ok ? '' : refused.detail).not.toBe(SIGN_FIRST);
  });
});

describe('a key of the agent is never the delegator of its own delegation', () => {
  it.each([
    ['a delegation key', [DELEG_A.keyHash]],
    ['the other delegation key', [PRINCIPAL.keyHash, DELEG_B.keyHash]],
    ['the service key', [SERVICE.keyHash]],
    ['the supplier key', [PRINCIPAL.keyHash, SUPPLIER.keyHash]],
  ])('refuses an allowlist that holds %s with `bad_setting`, and makes no route', (_name, allowed) => {
    const made = createCosignRoute(configOf({ allowed }).config);
    expect(made).toMatchObject({ ok: false, code: 'bad_setting' });
    const text = JSON.stringify(made);
    for (const key of [DELEG_A, DELEG_B, SERVICE, SUPPLIER]) expect(text).not.toContain(key.keyHash);
  });

  it('makes the route for an allowlist that holds the principal and no key of the agent', () => {
    expect(createCosignRoute(configOf({ allowed: [PRINCIPAL.keyHash, STRANGER.keyHash] }).config)).toMatchObject({ ok: true });
  });

  /** An allowlist that says yes to each key of the agent after the route is made: the route must not rely on the list alone. */
  class Opening extends Allowlist {
    open = false;

    override has(keyHash: unknown): boolean {
      return this.open || super.has(keyHash);
    }
  }

  function routeWithOpeningList() {
    const { config, signed } = configOf();
    const list = new Opening(new Set([PRINCIPAL.keyHash]));
    const made = createCosignRoute({ ...config, settings: { ...config.settings, allowlist: list } });
    if (!made.ok) throw new Error(made.detail);
    return { route: made.value, list, signed };
  }

  it.each([
    ['its own delegation key, which is also the delegate key', DELEG_A],
    ['its service key, with a delegation key as the delegate key', SERVICE],
    ['its supplier key, with a delegation key as the delegate key', SUPPLIER],
  ])('refuses %s as the delegator, also when the allowlist says yes and the agent signed first', async (_name, key) => {
    const { hex } = await build({ delegator: { type: 'PrincipalKey', hash: key.keyHash } });
    const { route, list, signed } = routeWithOpeningList();
    list.open = true;
    const result = await route.cosign(requestOf(hex, key));
    expect(result).toMatchObject({ ok: false, code: 'principal_not_allowed' });
    // The signature of the delegator was good, so it is the key of the agent that refuses, and not the missing witness.
    expect(result.ok ? '' : result.detail).not.toBe(SIGN_FIRST);
    expect(signed).toEqual([]);
    // The twin: the same route, with the list that is not open, signs for the principal.
    list.open = false;
    const good = await route.cosign(requestOf((await build()).hex));
    expect(good.ok).toBe(true);
  });
});
