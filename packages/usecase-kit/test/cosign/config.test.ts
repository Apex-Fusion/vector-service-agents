// packages/usecase-kit/test/cosign/config.test.ts
// The config of the route is checked once, when the service starts. A config that is wrong gives a refusal and no route, so a service that gets a refusal does not start. The refusal names the setting
// and never repeats a value.
import { describe, expect, it } from 'vitest';
import { KeyReservations, createCosignRoute } from '@vsa/usecase-kit/cosign';
import type { ClaimResult, CosignConfig, DelegationKey, KeyRegister } from '@vsa/usecase-kit/cosign';
import { DELEG_A, DEPLOYMENT, STRANGER, SUPPLIER, configOf, keyOf, signerOf } from './support.ts';

const MARKER = 'zq9-marker-7f3';
const held = async (): Promise<ClaimResult> => 'held';
const released = async (): Promise<void> => undefined;

/** The config of the tests with one member changed: `over` may hold a value of any type. */
function changedConfig(over: Record<string, unknown>): CosignConfig {
  return { ...configOf().config, ...over } as unknown as CosignConfig;
}

describe('createCosignRoute', () => {
  it('makes a route from a good config, with one key and with eight keys', () => {
    expect(createCosignRoute(configOf().config)).toMatchObject({ ok: true });
    expect(createCosignRoute(changedConfig({ delegationKeys: [signerOf(DELEG_A)] }))).toMatchObject({ ok: true });
    const eight = Array.from({ length: 8 }, (_, i) => signerOf(keyOf(40 + i)));
    expect(createCosignRoute(changedConfig({ delegationKeys: eight }))).toMatchObject({ ok: true });
  });

  it('makes a route from a good config with the register of the service, and with no register: the route has one in memory', () => {
    const mine: KeyRegister = new KeyReservations();
    expect(createCosignRoute(changedConfig({ register: mine }))).toMatchObject({ ok: true });
    expect(createCosignRoute(changedConfig({ register: undefined }))).toMatchObject({ ok: true });
  });

  it.each([
    ['an agent DID with the wrong form', { agentDid: 'did:vector:abc' }],
    ['an agent DID in upper case', { agentDid: `did:vector:${'AB'.repeat(32)}` }],
    ['no agent DID', { agentDid: undefined }],
    ['an agent identifier with no prefix', { agentDid: 'ab'.repeat(32) }],
    ['a deployment with no delegation script', { deployment: {} }],
    ['a delegation hash of the wrong length', { deployment: { delegation: { hash: 'ab'.repeat(27), address: DEPLOYMENT.delegation.address } } }],
    ['a delegation hash in upper case', { deployment: { delegation: { hash: DEPLOYMENT.delegation.hash.toUpperCase(), address: DEPLOYMENT.delegation.address } } }],
    ['a delegation address that is empty', { deployment: { delegation: { hash: DEPLOYMENT.delegation.hash, address: '' } } }],
    ['no delegation key', { delegationKeys: [] }],
    ['nine delegation keys', { delegationKeys: Array.from({ length: 9 }, (_, i) => signerOf(keyOf(40 + i))) }],
    ['delegation keys that are not a list', { delegationKeys: signerOf(DELEG_A) }],
    ['a delegation key with a public key of 63 characters', { delegationKeys: [{ publicKey: DELEG_A.publicKey.slice(1), sign: signerOf(DELEG_A).sign }] }],
    ['a delegation key with a public key in upper case', { delegationKeys: [{ publicKey: DELEG_A.publicKey.toUpperCase(), sign: signerOf(DELEG_A).sign }] }],
    ['a delegation key with no sign function', { delegationKeys: [{ publicKey: DELEG_A.publicKey }] }],
    ['a delegation key with a sign function that is text', { delegationKeys: [{ publicKey: DELEG_A.publicKey, sign: 'sign' }] }],
    ['the same delegation key twice', { delegationKeys: [signerOf(DELEG_A), signerOf(DELEG_A)] }],
    ['other keys that are not a list', { otherKeyHashes: SUPPLIER.keyHash }],
    ['an other key that is not a key hash', { otherKeyHashes: [SUPPLIER.keyHash, 'not a hash'] }],
    ['an other key in upper case', { otherKeyHashes: [SUPPLIER.keyHash.toUpperCase()] }],
    ['65 other keys', { otherKeyHashes: Array.from({ length: 65 }, (_, i) => i.toString(16).padStart(56, '0')) }],
    ['settings that are not settings', { settings: { allowlist: [STRANGER.keyHash], maxConcurrent: 4, maxFutureMs: 600_000, ledgerTimeoutMs: 2_000 } }],
    ['settings with a limit of the wrong type', { settings: { ...configOf().config.settings, maxConcurrent: '4' } }],
    ['no ledger', { ledger: undefined }],
    ['a ledger with no function for the delegations', { ledger: { outputs: async () => [] } }],
    ['a register that is text', { register: 'register' }],
    ['a register that is null', { register: null }],
    ['a register with no take function', { register: { commit: held, release: released } }],
    ['a register with no commit function', { register: { take: held, release: released } }],
    ['a register with no release function', { register: { take: held, commit: held } }],
    ['a register with a take that is not a function', { register: { take: 'held', commit: held, release: released } }],
    ['a start of the chain that is zero', { systemStartMs: 0 }],
    ['a start of the chain that is not a whole number', { systemStartMs: 1_756_485_600_000.5 }],
    ['a start of the chain that is text', { systemStartMs: '1756485600000' }],
    ['a start of the chain that is not a number', { systemStartMs: Number.NaN }],
    ['a clock that is not a function', { now: 1_763_000_000_000 }],
  ])('refuses %s with `bad_setting`, and makes no route', (_name, over) => {
    const result = createCosignRoute(changedConfig(over));
    expect(result).toMatchObject({ ok: false, code: 'bad_setting' });
  });

  it('refuses a config that is not an object', () => {
    for (const value of [undefined, null, 5, 'config']) expect(createCosignRoute(value as unknown as CosignConfig)).toMatchObject({ ok: false, code: 'bad_setting' });
  });

  it('does not repeat a value of the config in its refusal', () => {
    const sign: DelegationKey['sign'] = signerOf(DELEG_A).sign;
    const results = [
      createCosignRoute(changedConfig({ agentDid: MARKER })),
      createCosignRoute(changedConfig({ delegationKeys: [{ publicKey: MARKER, sign }] })),
      createCosignRoute(changedConfig({ otherKeyHashes: [MARKER] })),
      createCosignRoute(changedConfig({ deployment: { delegation: { hash: MARKER, address: MARKER } } })),
      createCosignRoute(changedConfig({ systemStartMs: MARKER })),
    ];
    for (const result of results) {
      expect(result.ok).toBe(false);
      expect(JSON.stringify(result)).not.toContain(MARKER);
    }
  });
});
