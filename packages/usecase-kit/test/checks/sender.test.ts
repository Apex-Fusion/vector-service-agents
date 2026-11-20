// packages/usecase-kit/test/checks/sender.test.ts: the three checks of the sender, on DID resolutions of the stub gateway of id-kit. Each refusal has an accepted twin.
import { describe, expect, it } from 'vitest';
import type { Resolution } from '@vsa/id-kit/client';
import { ed25519Key, p256Key } from '@vsa/id-kit/testing';
import { checkSenderAccountable, checkSenderActive, checkSenderKey } from '../../src/checks/index.ts';
import type { ResolvedSender } from '../../src/checks/index.ts';
import { makeWorld, T } from './support.ts';
import type { World } from './support.ts';

const resolve = async (world: World, did = world.sender.did): Promise<Resolution> => {
  const result = await world.ports.gateway.resolve(did);
  if (!result.ok) throw new Error(result.detail);
  return result.value;
};
const resolvedOf = async (world: World): Promise<ResolvedSender> => {
  const resolution = await resolve(world);
  if (resolution.kind !== 'resolved') throw new Error('the sender must resolve');
  return resolution;
};
/** The resolution with parts of its metadata replaced: what a gateway could send. */
const withMetadata = (resolution: ResolvedSender, metadata: Record<string, unknown>): ResolvedSender => ({ ...resolution, metadata: { ...resolution.metadata, ...metadata } });
const party = (over: Record<string, unknown> = {}): Record<string, unknown> => ({ role: 'accountable', signer: 'controller', notBefore: '2026-01-01T00:00:00Z', rights: ['suspend', 'revoke'], ...over });

describe('the sender resolves and is Active', () => {
  it('accepts an Active sender, and gives the resolution back', async () => {
    const world = makeWorld();
    const result = checkSenderActive(await resolve(world));
    expect(result).toMatchObject({ ok: true, value: { kind: 'resolved', effectiveStatus: 'active' } });
  });

  it.each(['suspended', 'revoked', 'retired'] as const)('refuses a sender that is %s with sender_not_active', async (status) => {
    const world = makeWorld();
    world.gateway.setStatus(world.sender, status);
    const result = checkSenderActive(await resolve(world));
    expect(result).toMatchObject({ ok: false, code: 'sender_not_active' });
  });

  it('refuses a DID that the gateway does not know with sender_not_active', async () => {
    const world = makeWorld();
    const result = checkSenderActive(await resolve(world, `did:vector:${'12'.repeat(32)}`));
    expect(result).toMatchObject({ ok: false, code: 'sender_not_active' });
  });

  it('refuses a subagent whose parent is suspended: its effective status is not Active', async () => {
    const world = makeWorld();
    const child = world.gateway.createAgent({ label: 'child of the sender', parent: world.sender, organisation: { domain: 'buyer.example' } });
    expect(checkSenderActive(await resolve(world, child.did))).toMatchObject({ ok: true });
    world.gateway.setStatus(world.sender, 'suspended');
    expect(checkSenderActive(await resolve(world, child.did))).toMatchObject({ ok: false, code: 'sender_not_active' });
  });

  it('gives the code of the second check when the gateway says that the sender is suspended because no Accountable Party covers it', async () => {
    const resolved = await resolvedOf(makeWorld());
    expect(checkSenderActive({ ...resolved, effectiveStatus: 'suspended', effectiveReason: 'unaccountable' })).toMatchObject({ ok: false, code: 'sender_unaccountable' });
    // The same suspension for any other reason keeps the code of the first check, and so does a status that is not suspended.
    expect(checkSenderActive({ ...resolved, effectiveStatus: 'suspended', effectiveReason: 'parentSuspended' })).toMatchObject({ ok: false, code: 'sender_not_active' });
    expect(checkSenderActive({ ...resolved, effectiveStatus: 'suspended', effectiveReason: null })).toMatchObject({ ok: false, code: 'sender_not_active' });
    expect(checkSenderActive({ ...resolved, effectiveStatus: 'revoked', effectiveReason: 'unaccountable' })).toMatchObject({ ok: false, code: 'sender_not_active' });
  });
});

describe('an Accountable Party covers the record now', () => {
  it('accepts a sender with a covering Accountable Party, and records its organisation as verified', async () => {
    const resolved = await resolvedOf(makeWorld());
    expect(checkSenderAccountable(resolved, T)).toEqual({ ok: true, value: { organisation: 'buyer.example', organisationVerified: true } });
  });

  it('records an organisation that the gateway did not verify, and does not refuse for it', async () => {
    const resolved = await resolvedOf(makeWorld({ organisation: { domain: 'unverified.example', verified: false } }));
    expect(checkSenderAccountable(resolved, T)).toEqual({ ok: true, value: { organisation: 'unverified.example', organisationVerified: false } });
  });

  it('refuses a record with no party with sender_unaccountable', async () => {
    const resolved = await resolvedOf(makeWorld({ organisation: null }));
    expect(resolved.metadata.vectorParties).toBeUndefined();
    expect(checkSenderAccountable(resolved, T)).toMatchObject({ ok: false, code: 'sender_unaccountable' });
  });

  it('refuses a party that has not started and a party that has ended, and accepts a party that covers the time', async () => {
    const resolved = withMetadata(await resolvedOf(makeWorld()), { vectorParties: [party({ notBefore: '2026-11-18T12:00:00Z', notAfter: '2026-11-18T13:00:00Z' })] });
    const start = Date.parse('2026-11-18T12:00:00Z');
    const end = Date.parse('2026-11-18T13:00:00Z');
    expect(checkSenderAccountable(resolved, start - 1)).toMatchObject({ ok: false, code: 'sender_unaccountable' });
    expect(checkSenderAccountable(resolved, end + 1)).toMatchObject({ ok: false, code: 'sender_unaccountable' });
    expect(checkSenderAccountable(resolved, start)).toMatchObject({ ok: true });
    expect(checkSenderAccountable(resolved, end)).toMatchObject({ ok: true });
  });

  it('refuses a covering party that is not an Accountable Party, and uses the covering Accountable Party when it is the second', async () => {
    const base = await resolvedOf(makeWorld());
    const responsible = party({ role: 'responsible', organisation: 'other.example' });
    expect(checkSenderAccountable(withMetadata(base, { vectorParties: [responsible] }), T)).toMatchObject({ ok: false, code: 'sender_unaccountable' });
    const ended = party({ notAfter: '2026-01-02T00:00:00Z', organisation: 'ended.example' });
    const covering = party({ organisation: 'covering.example', organisationVerified: true });
    expect(checkSenderAccountable(withMetadata(base, { vectorParties: [responsible, ended, covering] }), T)).toEqual({ ok: true, value: { organisation: 'covering.example', organisationVerified: true } });
  });

  it('reads the organisation as not verified unless the gateway says true', async () => {
    const base = await resolvedOf(makeWorld());
    for (const verified of ['true', 1, 'yes', {}, null]) {
      const resolved = withMetadata(base, { vectorParties: [party({ organisation: 'x.example', organisationVerified: verified })] });
      expect(checkSenderAccountable(resolved, T)).toEqual({ ok: true, value: { organisation: 'x.example', organisationVerified: false } });
    }
    const none = withMetadata(base, { vectorParties: [party({ organisation: 42 })] });
    expect(checkSenderAccountable(none, T)).toEqual({ ok: true, value: { organisation: null, organisationVerified: false } });
  });

  it('answers check_unavailable, and never a pass, for parties that cannot be read', async () => {
    const base = await resolvedOf(makeWorld());
    const bad = ['no list', { role: 'accountable' }, [null], ['accountable'], [party({ notBefore: 'yesterday' })], [party({ notBefore: 1763000000000 })], [party({ notAfter: 'tomorrow' })], [party({ notAfter: null })]];
    for (const vectorParties of bad) expect(checkSenderAccountable(withMetadata(base, { vectorParties }), T), JSON.stringify(vectorParties)).toMatchObject({ ok: false, code: 'check_unavailable' });
    expect(checkSenderAccountable(withMetadata(base, { vectorParties: [party()] }), T)).toMatchObject({ ok: true });
  });

  it('reads the gateway time with its seconds: a party that starts at 12:00:00 covers 12:00:00 and not the second before', async () => {
    const resolved = withMetadata(await resolvedOf(makeWorld()), { vectorParties: [party({ notBefore: '2026-11-18T12:00:00Z' })] });
    const noon = Date.parse('2026-11-18T12:00:00Z');
    expect(checkSenderAccountable(resolved, noon - 1000)).toMatchObject({ ok: false, code: 'sender_unaccountable' });
    expect(checkSenderAccountable(resolved, noon)).toMatchObject({ ok: true });
  });
});

describe('the key of the escrow is listed with the delegation purpose', () => {
  it('accepts the delegation key of the sender', async () => {
    const world = makeWorld();
    expect(checkSenderKey(await resolvedOf(world), world.delegateKey.keyHash)).toEqual({ ok: true, value: null });
  });

  it('refuses a key that the record does not list, and a key with another purpose only, and a key that was taken out', async () => {
    const world = makeWorld();
    const stranger = ed25519Key('checks test: a key that is not listed');
    expect(checkSenderKey(await resolvedOf(world), stranger.keyHash)).toMatchObject({ ok: false, code: 'sender_key_mismatch' });
    // The authentication key is listed, with the authentication purpose only.
    expect(checkSenderKey(await resolvedOf(world), world.sender.authentication.keyHash)).toMatchObject({ ok: false, code: 'sender_key_mismatch' });
    world.gateway.setPurposes(world.sender, world.delegateKey, 1);
    expect(checkSenderKey(await resolvedOf(world), world.delegateKey.keyHash)).toMatchObject({ ok: false, code: 'sender_key_mismatch' });
    world.gateway.setPurposes(world.sender, world.delegateKey, 16);
    expect(checkSenderKey(await resolvedOf(world), world.delegateKey.keyHash)).toMatchObject({ ok: true });
    world.gateway.removeKey(world.sender, world.delegateKey);
    expect(checkSenderKey(await resolvedOf(world), world.delegateKey.keyHash)).toMatchObject({ ok: false, code: 'sender_key_mismatch' });
  });

  it('refuses a key of another kind than Ed25519, even with the delegation purpose', async () => {
    const world = makeWorld();
    const p256 = p256Key('checks test: a P-256 key');
    const sender = world.gateway.createAgent({ label: 'p256 sender', organisation: { domain: 'p.example' }, keys: [{ key: p256, purposes: 16 }] });
    const resolution = await resolve(world, sender.did);
    expect(resolution.kind).toBe('resolved');
    if (resolution.kind === 'resolved') expect(checkSenderKey(resolution, p256.keyHash)).toMatchObject({ ok: false, code: 'sender_key_mismatch' });
  });

  it('refuses the key of another agent: the record of the sender is the one that counts', async () => {
    const world = makeWorld();
    const other = world.gateway.createAgent({ label: 'another agent', organisation: { domain: 'o.example' } });
    expect(checkSenderKey(await resolvedOf(world), other.delegation.keyHash)).toMatchObject({ ok: false, code: 'sender_key_mismatch' });
    const resolvedOther = await resolve(world, other.did);
    if (resolvedOther.kind === 'resolved') expect(checkSenderKey(resolvedOther, other.delegation.keyHash)).toMatchObject({ ok: true });
  });
});
