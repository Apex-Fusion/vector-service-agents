// packages/usecase-kit/test/checks/answers.test.ts: an answer of a port that has the wrong shape, or that is for another question, is `check_unavailable` through the whole run. It is never a pass, it
// is never a TypeError, and it is never the code of a rule. Each table has its twin: the answer as the real read gave it passes. The last test is the budget of the reads of `ledgerPortOf`.
import { describe, expect, it } from 'vitest';
import { BudgetSpent } from '@vsa/buyer-core';
import { endsWithin } from '../../../buyer-core/test/fixtures/ledger-read-world.ts';
import { ledgerPortOf, runChecks, sharedChecks } from '../../src/checks/index.ts';
import type { ChecksPorts } from '../../src/checks/index.ts';
import { DELEGATION_ID, ESCROW_REF, PLAIN_ESCROW_REF, T, makeWorld, withLedger } from './support.ts';
import type { World } from './support.ts';

const run = (world: World, ports: ChecksPorts) => runChecks(sharedChecks(ports, { kind: 'order-desk', request: world.handoff, context: world.context }));
const SENDER = ['sender_active', 'sender_accountable', 'sender_key'];
const BEFORE_VAULT = [...SENDER, 'delegation', 'delegation_usable'];

/** Each answer must end the run at the check after `passed`, with check_unavailable. */
async function expectUnavailable(world: World, ports: (answer: unknown) => ChecksPorts, answers: readonly unknown[], passed: readonly string[]): Promise<void> {
  for (const [index, answer] of answers.entries()) {
    const outcome = await run(world, ports(answer));
    expect(outcome, `answer ${index}`).toMatchObject({ ok: false, code: 'check_unavailable' });
    expect(Object.keys(outcome.record.checks), `answer ${index}`).toEqual(passed);
  }
}

describe('the answer of the resolver', () => {
  it('is check_unavailable when it is null, has no value, has a kind that is not known, or has a member of the wrong type', async () => {
    const world = makeWorld();
    const real = await world.ports.gateway.resolve(world.sender.did);
    if (!real.ok) throw new Error('the sender resolves');
    const value = real.value;
    const key = { keyHash: world.delegateKey.keyHash, type: 'Ed25519' };
    const answers: unknown[] = [
      null, undefined, {}, { ok: true }, { ok: true, value: null }, { ok: 'true', value }, { ok: true, value: { ...value, kind: 'resolved_pending' } }, { ok: true, value: { ...value, metadata: null } },
      { ok: true, value: { ...value, metadata: undefined } }, { ok: true, value: { ...value, keys: 'x' } }, { ok: true, value: { ...value, keys: [{ ...key, purposes: 'delegation' }] } },
      { ok: true, value: { ...value, keys: [{ ...key, purposes: [1] }] } }, { ok: true, value: { ...value, did: value.did.toUpperCase() } },
    ];
    await expectUnavailable(world, (answer) => ({ ...world.ports, gateway: { resolve: async () => answer as never } }), answers, []);
    expect((await run(world, world.ports)).ok).toBe(true);
  });
});

describe('the answer of readDelegation', () => {
  it('is check_unavailable when it is null, has no chain, has a chain of the wrong shape, or is for another delegation', async () => {
    const world = makeWorld();
    const view = await world.ports.ledger.readDelegation(DELEGATION_ID);
    const link = view.chain[0];
    const answers: unknown[] = [
      null, undefined, {}, { id: DELEGATION_ID }, { ...view, chain: 'x' }, { ...view, chain: [{}] }, { ...view, chain: [{ ...link, delegation: null }] }, { ...view, id: '9e'.repeat(32) },
      { ...view, chain: [{ ...link, id: '9e'.repeat(32) }] }, { ...view, missingParent: 7 },
    ];
    await expectUnavailable(world, (answer) => withLedger(world, { readDelegation: async () => answer as never }), answers, SENDER);
    // A chain with no link is the answer for a delegation that is not live: it is a rule.
    expect(await run(world, withLedger(world, { readDelegation: async () => ({ ...view, chain: [] }) }))).toMatchObject({ ok: false, code: 'delegation_invalid' });
  });
});

describe('the answer of delegationUse', () => {
  it('is check_unavailable when it is for another delegation, time, action or resource, or has a member of the wrong type', async () => {
    const world = makeWorld();
    const use = await world.ports.ledger.delegationUse(DELEGATION_ID, T);
    const answers: unknown[] = [
      null, undefined, {}, { ...use, resource: `script:${'00'.repeat(28)}` }, { ...use, atMs: T + 1 }, { ...use, action: 'other.v1' }, { ...use, view: { ...use.view, id: '9e'.repeat(32) } },
      { ...use, usable: 'yes' }, { ...use, usable: undefined }, { ...use, problems: {} }, { ...use, problems: undefined }, { ...use, problems: [1] }, { ...use, usable: false, problems: [] },
    ];
    await expectUnavailable(world, (answer) => withLedger(world, { delegationUse: async () => answer as never }), answers, [...SENDER, 'delegation']);
    expect(await run(world, withLedger(world, { delegationUse: async () => ({ ...use, usable: false, problems: ['the period is over'] }) }))).toMatchObject({ ok: false, code: 'delegation_ended' });
  });
});

describe('the answer of escrowPaid', () => {
  it('is check_unavailable when it is null, is not true or false, or is for another escrow or delegation', async () => {
    const world = makeWorld();
    const paid = await world.ports.ledger.escrowPaid(ESCROW_REF, DELEGATION_ID);
    const answers: unknown[] = [
      null, undefined, {}, { paid: 'yes' }, { paid: 1 }, { paid: false }, { paid: false, reason: 'no_vault_input' }, { paid: false, reason: 7, detail: 'x' }, { ...paid, escrowRef: PLAIN_ESCROW_REF },
      { ...paid, delegation: '9e'.repeat(32) }, { ...paid, vaultRef: undefined },
    ];
    await expectUnavailable(world, (answer) => withLedger(world, { escrowPaid: async () => answer as never }), answers, BEFORE_VAULT);
  });
});

describe('the reads of ledgerPortOf end inside the budget of the env', () => {
  it('ends the vault read, as it ends the other three reads, when the node and Koios never answer', async () => {
    const world = makeWorld();
    const hang = (): Promise<never> => new Promise<never>(() => undefined);
    Object.assign(world.ledger.provider, { getUtxos: hang, getUtxoByUnit: hang, getUtxosByOutRef: hang });
    const port = ledgerPortOf({ ...world.ledger.env, budgetMs: 50, fetchImpl: hang as unknown as typeof fetch });
    const reads: Array<Promise<unknown>> = [
      port.escrowPaid(ESCROW_REF, DELEGATION_ID), port.readDelegation(DELEGATION_ID), port.delegationUse(DELEGATION_ID, T), port.attestation(world.handoff.approval?.attestation ?? '', T),
    ];
    for (const read of reads) await expect(endsWithin(3000, read)).rejects.toBeInstanceOf(BudgetSpent);
  });
});
