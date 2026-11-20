// packages/usecase-kit/test/checks/delegation.test.ts: the delegation checks and the vault payment check. The reads are the real read code of buyer-core on an offline node and a fake Koios, through
// the ledger port. Each refusal has an accepted twin.
import { describe, expect, it } from 'vitest';
import type { EscrowVaultReason, EscrowVaultResult } from '@vsa/buyer-core';
import { utf8Hex } from '@vsa/vector-read/identity-codec';
import { checkDelegationNamesSender, checkDelegationUsable, checkVaultPaid } from '../../src/checks/index.ts';
import {
  DELEGATION_ID, ESCROW_REF, HOUR, ISSUER_ID, ISSUER_KEY, MAINNET, PLAIN_ESCROW_REF, T, callsTo, delegation, delegationUtxo, makeWorld,
} from './support.ts';
import type { World, WorldOptions } from './support.ts';

const named = async (world: World, buyerPkh = world.context.buyerPkh, sender = world.sender.did) =>
  checkDelegationNamesSender(await world.ports.ledger.readDelegation(DELEGATION_ID), DELEGATION_ID, sender, buyerPkh);
const usable = async (world: World, at = T) => checkDelegationUsable(await world.ports.ledger.delegationUse(DELEGATION_ID, at), DELEGATION_ID, at);
const paid = async (world: World, escrowRef = ESCROW_REF, id = DELEGATION_ID) => checkVaultPaid(await world.ports.ledger.escrowPaid(escrowRef, id), escrowRef, id);

describe('the delegation exists, is authentic, and names the sender and the key of the escrow', () => {
  it('accepts a live delegation whose delegate is the sender and whose delegate key is the key of the escrow', async () => {
    expect(await named(makeWorld())).toEqual({ ok: true, value: null });
  });

  it('refuses a delegation that does not exist, and a delegation that was ended (no output holds its token)', async () => {
    expect(await named(makeWorld({ delegation: null }))).toMatchObject({ ok: false, code: 'delegation_invalid' });
  });

  it('refuses an output that is not authentic: at another address, or with two delegation tokens', async () => {
    const good = delegationUtxo(DELEGATION_ID, delegation({ delegate: 'a0'.repeat(32) }));
    const elsewhere = { ...good, address: MAINNET.vault.address };
    const two = { ...good, assets: { ...good.assets, [`${MAINNET.delegation.hash}${'aa'.repeat(32)}`]: 1n } };
    for (const extra of [elsewhere, two]) {
      const world = makeWorld({ delegation: null, extraUtxos: [extra] });
      expect(await named(world)).toMatchObject({ ok: false, code: 'delegation_invalid' });
    }
  });

  it('refuses a delegation of another delegate, even when the key is the key of the escrow', async () => {
    const world = makeWorld({ delegation: { delegate: 'b7'.repeat(32) } });
    expect(await named(world)).toMatchObject({ ok: false, code: 'delegation_invalid', detail: expect.stringContaining('delegate of the delegation is not the sender') });
    expect(await named(makeWorld())).toMatchObject({ ok: true });
  });

  it('refuses a delegate key that is not the key of the escrow of the job context', async () => {
    const world = makeWorld({ delegation: { delegateKey: '1f'.repeat(28) } });
    expect(await named(world)).toMatchObject({ ok: false, code: 'delegation_invalid', detail: expect.stringContaining('delegate key') });
    // The delegation is right, and the escrow was posted by another key: the context key is the one that is compared.
    const right = makeWorld();
    expect(await named(right, '1f'.repeat(28))).toMatchObject({ ok: false, code: 'delegation_invalid' });
    expect(await named(right)).toMatchObject({ ok: true });
  });

  it('refuses a sender that is not the delegate, with the delegation and the key right', async () => {
    const world = makeWorld();
    expect(await named(world, world.context.buyerPkh, `did:vector:${'c9'.repeat(32)}`)).toMatchObject({ ok: false, code: 'delegation_invalid' });
  });

  it('refuses a view whose first link is another delegation than the one that was asked for', async () => {
    const world = makeWorld();
    const view = await world.ports.ledger.readDelegation(DELEGATION_ID);
    const other = '9e'.repeat(32);
    expect(checkDelegationNamesSender(view, other, world.sender.did, world.context.buyerPkh)).toMatchObject({ ok: false, code: 'delegation_invalid' });
    expect(checkDelegationNamesSender({ ...view, chain: [] }, DELEGATION_ID, world.sender.did, world.context.buyerPkh)).toMatchObject({ ok: false, code: 'delegation_invalid' });
  });
});

describe('the delegation and every ancestor are usable now', () => {
  const PARENT = 'a1'.repeat(32);
  const parent = delegationUtxo(PARENT, delegation({ delegate: ISSUER_ID, delegateKey: ISSUER_KEY.keyHash, remaining: 2, depth: 1 }));
  const issuerKeys = { keys: [{ keyType: 'Ed25519' as const, key: ISSUER_KEY.publicKey, purposes: 31, pop: null }] };
  const child = { parent: PARENT, depth: 2, remaining: 0, delegator: { type: 'Agent' as const, id: ISSUER_ID } };
  const hold = { type: 'Suspended' as const, holds: [{ by: { type: 'ControllerSet' as const }, reason: 6, since: T - HOUR, until: T + HOUR }] };
  const refusedFor = async (over: WorldOptions, text: string) => {
    const result = await usable(makeWorld(over));
    expect(result).toMatchObject({ ok: false, code: 'delegation_ended' });
    if (!result.ok) expect(result.detail).toContain(text);
  };

  it('accepts a delegation that is in its period, with a delegate that is Active and lists its key', async () => {
    expect(await usable(makeWorld())).toEqual({ ok: true, value: null });
  });

  it('asks for no confirmations: a delegation that has just been made is usable, and the node tip is not read', async () => {
    const world = makeWorld();
    expect(await usable(world)).toMatchObject({ ok: true });
    expect(callsTo(world.ledger.koios, 'tip')).toHaveLength(0);
  });

  it('refuses a delegation whose period is over, and one that has not started, and accepts the time on the edge of the period', async () => {
    await refusedFor({ delegation: { notAfter: T - 1 } }, 'ends at');
    await refusedFor({ delegation: { notBefore: T + 1 } }, 'starts at');
    expect(await usable(makeWorld({ delegation: { notAfter: T } }))).toMatchObject({ ok: true });
    expect(await usable(makeWorld({ delegation: { notBefore: T } }))).toMatchObject({ ok: true });
  });

  it('uses the time of the call: the same delegation is usable at one time and ended at a later one', async () => {
    const world = makeWorld({ delegation: { notAfter: T + HOUR } });
    expect(await usable(world, T)).toMatchObject({ ok: true });
    expect(await usable(world, T + HOUR + 1)).toMatchObject({ ok: false, code: 'delegation_ended' });
  });

  it('refuses a delegate that no longer lists the delegate key, and a delegate that is suspended', async () => {
    await refusedFor({ delegateRecord: { keys: [] } }, 'no longer lists the delegate key');
    await refusedFor({ delegateRecord: { status: hold } }, 'Suspended');
  });

  it('refuses a delegation whose patterns do not cover the hire action or the escrow script', async () => {
    await refusedFor({ delegation: { actions: [utf8Hex('other.action.v1')] } }, 'action pattern');
    await refusedFor({ delegation: { resources: [utf8Hex(`script:${'00'.repeat(28)}`)] } }, 'resource pattern');
    expect(await usable(makeWorld({ delegation: { actions: [utf8Hex('marketplace.*')] } }))).toMatchObject({ ok: true });
  });

  it('refuses a delegation whose parent was ended, and accepts the same delegation while the parent is live', async () => {
    await refusedFor({ delegation: child, issuerRecord: issuerKeys }, 'is missing');
    expect(await usable(makeWorld({ delegation: child, issuerRecord: issuerKeys, extraUtxos: [parent] }))).toMatchObject({ ok: true });
  });

  it('refuses a root delegator that is an agent and is not Active, and accepts it while it is Active', async () => {
    const root = { delegator: { type: 'Agent' as const, id: ISSUER_ID } };
    await refusedFor({ delegation: root, issuerRecord: { status: hold } }, 'root delegator');
    expect(await usable(makeWorld({ delegation: root, issuerRecord: {} }))).toMatchObject({ ok: true });
  });

  it('throws when a record of the chain cannot be read: a read that failed, and not a rule', async () => {
    const world = makeWorld({ delegateRecord: null });
    await expect(world.ports.ledger.delegationUse(DELEGATION_ID, T)).rejects.toThrow();
  });

  it('does not take an answer for another delegation, another time or another action: check_unavailable', async () => {
    const world = makeWorld();
    const use = await world.ports.ledger.delegationUse(DELEGATION_ID, T);
    expect(checkDelegationUsable(use, DELEGATION_ID, T)).toMatchObject({ ok: true });
    expect(checkDelegationUsable(use, '5c'.repeat(32), T)).toMatchObject({ ok: false, code: 'check_unavailable' });
    expect(checkDelegationUsable(use, DELEGATION_ID, T + 1)).toMatchObject({ ok: false, code: 'check_unavailable' });
    expect(checkDelegationUsable({ ...use, action: 'other.action.v1' }, DELEGATION_ID, T)).toMatchObject({ ok: false, code: 'check_unavailable' });
  });

  it('does not read usable as true when the flag is not exactly true, or when a problem is listed', async () => {
    const use = await makeWorld().ports.ledger.delegationUse(DELEGATION_ID, T);
    for (const flag of [undefined, 'true', 1, null]) {
      expect(checkDelegationUsable({ ...use, usable: flag as unknown as boolean }, DELEGATION_ID, T)).toMatchObject({ ok: false, code: 'delegation_ended' });
    }
    expect(checkDelegationUsable({ ...use, usable: true, problems: ['a problem'] }, DELEGATION_ID, T)).toMatchObject({ ok: false, code: 'delegation_ended' });
    expect(checkDelegationUsable({ ...use, usable: false, problems: [] }, DELEGATION_ID, T)).toMatchObject({ ok: false, code: 'delegation_ended' });
  });

  it('puts one short printable line in the detail, whatever the text of the first problem is, and only the first problem', async () => {
    const use = await makeWorld().ports.ledger.delegationUse(DELEGATION_ID, T);
    const long = `the delegate did:vector:${'ab'.repeat(32)} is bad\nsecond line\u0000\u0007 ${'x'.repeat(400)}`;
    const result = checkDelegationUsable({ ...use, usable: false, problems: [long, 'the other problem'] }, DELEGATION_ID, T);
    expect(result).toMatchObject({ ok: false, code: 'delegation_ended' });
    if (result.ok) return;
    expect(result.detail).toMatch(/^[\x20-\x7e]+$/);
    expect(result.detail.length).toBeLessThanOrEqual(200);
    expect(result.detail).toContain('did:vector:abababab..');
    expect(result.detail).not.toContain('abababababab');
    expect(result.detail).not.toContain('the other problem');
    const short = checkDelegationUsable({ ...use, usable: false, problems: ['the delegation ends at 2026-11-18T12:00:00Z'] }, DELEGATION_ID, T);
    expect(short).toMatchObject({ ok: false, detail: 'the delegation cannot be used now: the delegation ends at 2026-11-18T12:00:00Z' });
  });
});

describe('the escrow was paid from a vault of the delegation', () => {
  it('accepts the escrow that a vault of the delegation paid (a payment captured from mainnet)', async () => {
    expect(await paid(makeWorld())).toEqual({ ok: true, value: null });
  });

  it('refuses an escrow that a wallet paid: no vault input', async () => {
    const result = await paid(makeWorld(), PLAIN_ESCROW_REF);
    expect(result).toMatchObject({ ok: false, code: 'not_vault_paid', detail: expect.stringContaining('no_vault_input') });
  });

  it('refuses an escrow that a vault of another delegation paid', async () => {
    const result = await paid(makeWorld(), ESCROW_REF, '6d'.repeat(32));
    expect(result).toMatchObject({ ok: false, code: 'not_vault_paid', detail: expect.stringContaining('other_delegation') });
  });

  it('refuses an output index that is not an escrow output of the transaction', async () => {
    const world = makeWorld();
    const txid = ESCROW_REF.split('#')[0];
    expect(await paid(world, `${txid}#7`)).toMatchObject({ ok: false, code: 'not_vault_paid' });
  });

  it('answers check_unavailable for a transaction that the source does not know, and never not_vault_paid', async () => {
    const result = await paid(makeWorld(), `${'ee'.repeat(32)}#0`);
    expect(result).toMatchObject({ ok: false, code: 'check_unavailable', detail: expect.stringContaining('transaction_not_found') });
  });

  it('gives every reason of the read a code, and only these two reasons are check_unavailable', () => {
    const reasons: EscrowVaultReason[] = [
      'transaction_not_found', 'contract_failed', 'not_an_escrow_output', 'continuation', 'no_vault_input', 'not_a_payment', 'unreadable_vault_datum', 'other_delegation',
    ];
    const codes = reasons.map((reason) => {
      const result = checkVaultPaid({ paid: false, reason, detail: 'x' }, ESCROW_REF, DELEGATION_ID);
      return [reason, result.ok ? 'pass' : result.code];
    });
    expect(codes).toEqual([
      ['transaction_not_found', 'check_unavailable'], ['contract_failed', 'not_vault_paid'], ['not_an_escrow_output', 'not_vault_paid'], ['continuation', 'not_vault_paid'],
      ['no_vault_input', 'not_vault_paid'], ['not_a_payment', 'not_vault_paid'], ['unreadable_vault_datum', 'check_unavailable'], ['other_delegation', 'not_vault_paid'],
    ]);
  });

  it('does not read a reason that it does not know as a pass, and does not take a payment of another escrow or another delegation', () => {
    const unknown = { paid: false, reason: 'constructor', detail: 'x' } as unknown as EscrowVaultResult;
    expect(checkVaultPaid(unknown, ESCROW_REF, DELEGATION_ID)).toMatchObject({ ok: false, code: 'check_unavailable' });
    const yes: EscrowVaultResult = { paid: true, vaultRef: `${'ab'.repeat(32)}#1`, escrowRef: ESCROW_REF, delegation: DELEGATION_ID, payTx: ESCROW_REF.split('#')[0] };
    expect(checkVaultPaid(yes, ESCROW_REF, DELEGATION_ID)).toMatchObject({ ok: true });
    expect(checkVaultPaid(yes, PLAIN_ESCROW_REF, DELEGATION_ID)).toMatchObject({ ok: false, code: 'check_unavailable' });
    expect(checkVaultPaid(yes, ESCROW_REF, '6d'.repeat(32))).toMatchObject({ ok: false, code: 'check_unavailable' });
  });
});
