// The hosted build and the landing of a built transaction, over a world with the real builders. Each refusal has an accepted twin. No test uses a real key, a real clock or the network.
import { describe, expect, it } from 'vitest';
import { HostedError } from '../../checks/lib/hosted.ts';
import { PACK_CAPTURE, PACK_SCHEMAS, PackHosted, liveBuildAnswer } from './support/pack-hosted.ts';

const PACK_TOOLS = [
  'vector_build_identity_register', 'vector_build_identity_update', 'vector_build_reputation_stake_open', 'vector_build_reputation_stake', 'vector_get_reputation_stake',
  'vector_build_marketplace_advert_post', 'vector_build_marketplace_advert_retire', 'vector_build_identity_suspend', 'vector_build_identity_unsuspend', 'vector_resolve_did',
  'vector_marketplace_list_suppliers', 'vector_get_attestation', 'vector_check_attestation', 'vector_get_delegation', 'vector_get_vault', 'vector_get_jury_cases',
];

describe('the captured schemas and PackHosted', () => {
  it('hold the 16 tools that the pack calls, and the date and the server of the capture', () => {
    expect(Object.keys(PACK_SCHEMAS).sort()).toEqual([...PACK_TOOLS].sort());
    expect(PACK_CAPTURE.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(PACK_CAPTURE.server.trim()).not.toBe('');
    expect(PACK_CAPTURE.tools_listed).toBeGreaterThanOrEqual(PACK_TOOLS.length);
    expect(Object.keys(PACK_SCHEMAS)).not.toContain('vector_build_transaction');
  });
  const REGISTER = { changeAddress: 'addr1test', controller: 'ab'.repeat(32), name: 'a test agent', parties: [{ role: 'Accountable', signer: 'controller' }] };
  const fake = () => new PackHosted({ vector_build_identity_register: () => ({ ok: true }) });
  it('refuses a stray argument before the handler runs, and takes the call without it', async () => {
    const hosted = fake();
    const err = await hosted.call('vector_build_identity_register', { ...REGISTER, extra: 1 }).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(HostedError);
    expect((err as HostedError).kind).toBe('bad_arguments');
    expect((err as HostedError).message).toContain('has no argument extra');
    expect(hosted.calls).toEqual([]);
    expect((await hosted.call('vector_build_identity_register', REGISTER)).json).toEqual({ ok: true });
    expect(hosted.calls).toHaveLength(1);
  });
  it('refuses a missing argument before the handler runs, and takes the call with it', async () => {
    const hosted = fake();
    const { name: _name, ...without } = REGISTER;
    const err = await hosted.call('vector_build_identity_register', without).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(HostedError);
    expect((err as HostedError).message).toContain('requires name');
    expect(hosted.calls).toEqual([]);
    await hosted.call('vector_build_identity_register', REGISTER);
    expect(hosted.calls).toHaveLength(1);
  });
  it('refuses a value that breaks the schema, and a tool that the capture does not hold', async () => {
    const hosted = fake();
    const tooLong = await hosted.call('vector_build_identity_register', { ...REGISTER, valid_minutes: 60 }).then(() => null, (e: unknown) => e);
    expect((tooLong as HostedError).message).toContain('valid_minutes must be at most 59');
    await expect(hosted.call('vector_build_identity_register', { ...REGISTER, valid_minutes: 59 })).resolves.toBeDefined();
    await expect(hosted.call('vector_build_transaction', { changeAddress: 'addr1test', outputs: [] })).rejects.toMatchObject({ kind: 'bad_arguments' });
    await expect(hosted.call('vector_get_vault', {})).rejects.toMatchObject({ kind: 'unreachable' });
  });
  it('writes a build answer in the live format: the CBOR follows its marker, and the last JSON block holds the hash, the fee, the end of the validity and the signers', async () => {
    const build = { txCbor: 'aa'.repeat(10), txHash: 'bb'.repeat(32), fee: '450000', validFrom: 1_000, validTo: 61_000, requiredSigners: [{ keyHash: 'cc'.repeat(28), roles: ['wallet', 'controller'] }] };
    const hosted = new PackHosted({ vector_build_identity_register: () => liveBuildAnswer('Identity registration', build, { did: 'did:vector:test' }) });
    const answer = await hosted.call('vector_build_identity_register', REGISTER);
    expect(answer.failed).toBe(false);
    expect(answer.text).toContain(`**Unsigned TX CBOR:**\n\`\`\`\n${build.txCbor}\n\`\`\``);
    expect(answer.json).toEqual({
      did: 'did:vector:test', tx_hash: build.txHash, fee: '450000', valid_from: 1_000, valid_to: 61_000, required_signers: [{ key_hash: 'cc'.repeat(28), roles: ['wallet', 'controller'] }],
    });
  });
});
