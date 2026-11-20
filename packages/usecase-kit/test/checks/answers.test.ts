// packages/usecase-kit/test/checks/answers.test.ts: an answer of a port that has the wrong shape, or that is for another question, is `check_unavailable` through the whole run. It is never a pass, it
// is never a TypeError, and it is never the code of a rule. Each table has its twin: the answer as the real read gave it passes. A hex member that is not in the form of its kind is such an answer too.
// The last test is the budget of the reads of `ledgerPortOf`.
import { describe, expect, it } from 'vitest';
import { BudgetSpent } from '@vsa/buyer-core';
import { endsWithin } from '../../../buyer-core/test/fixtures/ledger-read-world.ts';
import { checkDelegationNamesSender, ledgerPortOf, runChecks, sharedChecks } from '../../src/checks/index.ts';
import type { ChecksPorts } from '../../src/checks/index.ts';
import { ATTESTATION_ID, DELEGATION_ID, ESCROW_REF, ISSUER_DID, ISSUER_ID, PLAIN_ESCROW_REF, T, leavingForm, makeWorld, valueAt, withLedger, withMember } from './support.ts';
import type { World, WorldOptions } from './support.ts';

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
      { ...use, usable: false, problems: [1] },
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
      { paid: 'yes', reason: 'no_vault_input', detail: 'x' },
      { ...paid, delegation: '9e'.repeat(32) }, { ...paid, vaultRef: undefined },
    ];
    await expectUnavailable(world, (answer) => withLedger(world, { escrowPaid: async () => answer as never }), answers, BEFORE_VAULT);
  });
});

// A hex member of an answer has the form of its kind: lower-case hex characters, and the exact length. A member in another form is an answer that cannot be judged, so the whole run ends with
// check_unavailable at the check that reads the answer. It never passes, and it never ends with the code of a rule, also when the member is the right key or the right identifier in capitals.
const BEFORE_APPROVAL = [...BEFORE_VAULT, 'vault_paid'];
const PARENT = 'a1'.repeat(32);
const agentRoot: WorldOptions = { delegation: { delegator: { type: 'Agent', id: ISSUER_ID } }, issuerRecord: {}, attestation: { issuerId: ISSUER_ID } };
/** The world in which an agent is the root delegator and the issuer of the approval. The handoff names the record of that agent, as the reference of the approval must. */
const agentWorld = (): World => {
  const world = makeWorld(agentRoot);
  return { ...world, handoff: { ...world.handoff, approval: { attestation: ATTESTATION_ID, issuer_did: ISSUER_DID } } };
};

/**
 * The whole run with the member at `path` of `real` changed in each way that leaves its form: the run ends with check_unavailable at the check after `passed`. The twin is `real` as the read
 * gave it: the whole run passes.
 */
async function expectFormKept(
  world: World, port: (answer: unknown) => ChecksPorts, real: unknown, path: string, passed: readonly string[], variants = leavingForm(valueAt(real, path) as string),
): Promise<void> {
  for (const variant of variants) {
    const outcome = await run(world, port(withMember(real, path, variant)));
    const what = `${path} is ${JSON.stringify(variant.length > 16 ? `${variant.substring(0, 16)}...` : variant)}`;
    expect(outcome, what).toMatchObject({ ok: false, code: 'check_unavailable' });
    expect(Object.keys(outcome.record.checks), what).toEqual(passed);
  }
  expect(await run(world, port(real)), `${path} as the read gave it`).toMatchObject({ ok: true });
}

describe('a hex member of the answer of the resolver', () => {
  it('is check_unavailable when a key hash is not 56 lower-case hex characters, also the key hash of the escrow in capitals', async () => {
    const world = makeWorld();
    const real = await world.ports.gateway.resolve(world.sender.did);
    if (!real.ok || real.value.kind !== 'resolved') throw new Error('the sender resolves');
    expect(real.value.keys.some((key) => key.keyHash === world.delegateKey.keyHash)).toBe(true);
    for (const [index] of real.value.keys.entries()) {
      await expectFormKept(world, (answer) => ({ ...world.ports, gateway: { resolve: async () => answer as never } }), real, `value.keys.${index}.keyHash`, []);
    }
  });
});

describe('a hex member of the answer of readDelegation', () => {
  const port = (world: World) => (answer: unknown) => withLedger(world, { readDelegation: async () => answer as never });

  it('is check_unavailable when an identifier is not 64 lower-case hex characters or a key hash is not 56, in each link of the chain', async () => {
    const world = makeWorld();
    const view = await world.ports.ledger.readDelegation(DELEGATION_ID);
    const leaf = view.chain[0];
    // A chain of two links: the leaf names its parent, and the parent is the root.
    const chain = { ...view, chain: [{ ...leaf, delegation: { ...leaf.delegation, parent: PARENT } }, { ...leaf, id: PARENT, delegation: { ...leaf.delegation, parent: null } }] };
    const paths = [
      'chain.0.id', 'chain.0.delegation.delegate', 'chain.0.delegation.delegateKey', 'chain.0.delegation.parent', 'chain.0.delegation.delegator.hash',
      'chain.1.id', 'chain.1.delegation.delegate', 'chain.1.delegation.delegateKey', 'chain.1.delegation.delegator.hash',
    ];
    for (const path of paths) await expectFormKept(world, port(world), chain, path, SENDER);
  });

  it('is check_unavailable when the identifier of the root delegator, an agent, is not 64 lower-case hex characters', async () => {
    const world = agentWorld();
    const view = await world.ports.ledger.readDelegation(DELEGATION_ID);
    await expectFormKept(world, port(world), view, 'chain.0.delegation.delegator.id', SENDER);
  });

  it('is check_unavailable when the missing parent is not an identifier of 64 lower-case hex characters, and the same answer with an identifier is read', async () => {
    // The parent of the delegation was ended: the read gives the delegation, and names the parent that is missing.
    const world = makeWorld({ delegation: { parent: PARENT, depth: 2, remaining: 0 } });
    const view = await world.ports.ledger.readDelegation(DELEGATION_ID);
    expect(view.missingParent).toBe(PARENT);
    const named = (answer: unknown) => checkDelegationNamesSender(answer as never, DELEGATION_ID, world.sender.did, world.context.buyerPkh);
    for (const variant of leavingForm(PARENT)) expect(named({ ...view, missingParent: variant }), variant).toMatchObject({ ok: false, code: 'check_unavailable' });
    expect(named(view)).toEqual({ ok: true, value: null });
  });
});

describe('a hex member of the answer of escrowPaid', () => {
  const port = (world: World) => (answer: unknown) => withLedger(world, { escrowPaid: async () => answer as never });

  it('is check_unavailable when the transaction is not a hash of 64 lower-case hex characters, or the vault output is not an output reference', async () => {
    const world = makeWorld();
    const paid = await world.ports.ledger.escrowPaid(ESCROW_REF, DELEGATION_ID);
    if (!paid.paid) throw new Error('the escrow was paid from a vault');
    await expectFormKept(world, port(world), paid, 'payTx', BEFORE_VAULT);
    const [hash, index] = paid.vaultRef.split('#');
    expect(hash.toUpperCase()).not.toBe(hash);
    const refs = [`${hash.toUpperCase()}#${index}`, `${hash}zz#${index}`, `${hash.substring(0, hash.length - 2)}#${index}`, `${hash}${index}`, `${hash}#`, `${hash}#${index}x`, `${hash}#0${index}`, ''];
    await expectFormKept(world, port(world), paid, 'vaultRef', BEFORE_VAULT, refs);
  });
});

describe('a hex member of the answer of the attestation read', () => {
  const port = (world: World) => (answer: unknown) => withLedger(world, { attestation: async () => answer as never });

  it('is check_unavailable when the subject, the issuer key or the digest is not in its form: a key with more characters after it is not the key', async () => {
    const world = makeWorld();
    const real = await world.ports.ledger.attestation(ATTESTATION_ID, T);
    for (const member of ['subject', 'issuer', 'digest']) await expectFormKept(world, port(world), real, `attestation.attestation.${member}`, BEFORE_APPROVAL);
  });

  it('is check_unavailable when the issuer record is not 64 lower-case hex characters', async () => {
    const world = agentWorld();
    const real = await world.ports.ledger.attestation(ATTESTATION_ID, T);
    await expectFormKept(world, port(world), real, 'attestation.attestation.issuerId', BEFORE_APPROVAL);
  });
});

describe('a wrong answer is told to the service', () => {
  it('calls onFault with the source of the answer that was not usable, and the check still ends with check_unavailable', async () => {
    const world = makeWorld();
    const outcome = await run(world, withLedger(world, { delegationUse: async () => null as never }));
    expect(outcome).toMatchObject({ ok: false, code: 'check_unavailable' });
    expect(world.faults.map(([source]) => source)).toEqual(['delegation use']);
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
