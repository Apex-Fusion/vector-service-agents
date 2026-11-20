// packages/usecase-kit/test/checks/shared.test.ts: the shared list of checks for each kind of counterparty, run on the world of the support file. Every code of the shared checks has a refusal and an
// accepted twin, the order of the codes is the order of COUNTERPARTY_REFUSALS, and a read that fails is `check_unavailable`. The question: is a wrong sender, a wrong delegation or a wrong approval
// ever accepted?
import { describe, expect, it } from 'vitest';
import { ed25519Key } from '@vsa/id-kit/testing';
import { SHARED_CHECK_NAMES, runChecks, sharedChecks } from '../../src/checks/index.ts';
import type { ChecksOutcome, ChecksPorts, SharedInput } from '../../src/checks/index.ts';
import { COUNTERPARTY_KINDS, COUNTERPARTY_REFUSALS } from '../../src/protocol/index.ts';
import type { CounterpartyKind } from '../../src/protocol/index.ts';
import { ATTESTATION_ID, DOCUMENT, HOUR, ISSUER_KEY, PLAIN_ESCROW_REF, T, failing, first, from, makeWorld, proposalOf, withLedger } from './support.ts';
import type { World, WorldOptions } from './support.ts';

const HANDOFF_KINDS = ['order-desk', 'insurer-intake-agent'] as const;
const STRANGER = ed25519Key('checks test: a stranger').keyHash;

function inputOf(world: World, kind: CounterpartyKind, context = world.context): SharedInput {
  return kind === 'bid-desk' ? { kind, request: world.rfq, context } : { kind, request: world.handoff, context };
}
const run = (world: World, kind: CounterpartyKind = 'order-desk', context = world.context, ports: ChecksPorts = world.ports): Promise<ChecksOutcome> => runChecks(sharedChecks(ports, inputOf(world, kind, context)));
const codeOf = (outcome: ChecksOutcome): string => (outcome.ok ? 'accepted' : outcome.code);

/** The ledger port that writes the name of each read to `calls`. */
function spied(world: World, calls: string[]): ChecksPorts {
  const real = world.ports.ledger;
  return {
    ...world.ports,
    ledger: {
      readDelegation: (id) => { calls.push('readDelegation'); return real.readDelegation(id); },
      delegationUse: (id, at) => { calls.push('delegationUse'); return real.delegationUse(id, at); },
      attestation: (id, at) => { calls.push('attestation'); return real.attestation(id, at); },
      escrowPaid: (ref, id) => { calls.push('escrowPaid'); return real.escrowPaid(ref, id); },
    },
  };
}

describe('a world in which every check passes', () => {
  it.each(HANDOFF_KINDS)('passes for the %s, with the checks and the facts of the shared list', async (kind) => {
    const outcome = await run(makeWorld(), kind);
    expect(outcome.ok).toBe(true);
    expect(Object.keys(outcome.record.checks)).toEqual([...SHARED_CHECK_NAMES[kind]]);
    expect(outcome.record.facts).toEqual({
      organisation: 'buyer.example', organisation_verified: true, approval_attestation: ATTESTATION_ID, approval_issuer_did: null, approval_issuer_key_hash: ISSUER_KEY.keyHash, approval_valid_until: T + 4 * HOUR,
    });
  });

  it('passes for a bid desk, whose list ends after the vault payment and holds no approval', async () => {
    const outcome = await run(makeWorld({ attestation: null }), 'bid-desk');
    expect(outcome.ok).toBe(true);
    expect(Object.keys(outcome.record.checks)).toEqual(['sender_active', 'sender_accountable', 'sender_key', 'delegation', 'delegation_usable', 'vault_paid']);
    expect(outcome.record.facts).toEqual({ organisation: 'buyer.example', organisation_verified: true });
  });

  it('records an organisation that the gateway did not verify, and still passes', async () => {
    const outcome = await run(makeWorld({ organisation: { domain: 'unverified.example', verified: false } }));
    expect(outcome.ok).toBe(true);
    expect(outcome.record.facts).toMatchObject({ organisation: 'unverified.example', organisation_verified: false });
  });
});

describe('the code of each shared check', () => {
  const stranger = (world: World) => ({ ...world.context, buyerPkh: STRANGER });
  const cases: Array<[string, () => Promise<ChecksOutcome>]> = [
    ['sender_not_active', async () => { const w = makeWorld(); w.gateway.setStatus(w.sender, 'suspended'); return run(w); }],
    ['sender_unaccountable', () => run(makeWorld({ organisation: null }))],
    ['sender_key_mismatch', async () => { const w = makeWorld(); return run(w, 'order-desk', stranger(w)); }],
    ['delegation_invalid', () => run(makeWorld({ delegation: { delegate: 'b7'.repeat(32) } }))],
    ['delegation_ended', () => run(makeWorld({ delegation: { notAfter: T - 1 } }))],
    ['not_vault_paid', async () => { const w = makeWorld(); return run(w, 'order-desk', { ...w.context, escrowRef: PLAIN_ESCROW_REF }); }],
    ['approval_not_found', () => run(makeWorld({ attestation: null }))],
    ['approval_wrong_type', () => run(makeWorld({ attestation: { attType: 15 } }))],
    ['approval_wrong_subject', () => run(makeWorld({ attestation: { subject: 'b4'.repeat(32) } }))],
    ['approval_wrong_issuer', () => run(makeWorld({ attestation: { issuer: ed25519Key('checks test: another issuer').publicKeyHex } }))],
    ['approval_revoked', () => run(makeWorld({ attestation: { status: { type: 'AttRevoked', at: T - HOUR, reason: 0 } } }))],
    ['approval_expired', () => run(makeWorld({ attestation: { validUntil: T - 1 } }))],
    ['approval_digest_mismatch', () => run(makeWorld({ attestation: { digest: proposalOf({ ...DOCUMENT, quantity: 3 }).proposal_digest } }))],
  ];
  it.each(cases)('refuses with %s, and the same world with no defect passes', async (code, refusing) => {
    const outcome = await refusing();
    expect(codeOf(outcome)).toBe(code);
    expect(outcome.ok).toBe(false);
    expect((await run(makeWorld())).ok).toBe(true);
  });

  it('refuses an approval that is null with approval_not_found, and a bid desk needs none', async () => {
    const world = makeWorld();
    const none = { ...world.handoff, approval: null };
    expect(codeOf(await runChecks(sharedChecks(world.ports, { kind: 'order-desk', request: none, context: world.context })))).toBe('approval_not_found');
    expect((await run(world, 'bid-desk')).ok).toBe(true);
  });

  it('has an approval refusal for the order desk and the insurer, and none for the bid desk with the same defect', async () => {
    const defect: WorldOptions = { attestation: { attType: 15 } };
    for (const kind of HANDOFF_KINDS) expect(codeOf(await run(makeWorld(defect), kind))).toBe('approval_wrong_type');
    expect((await run(makeWorld(defect), 'bid-desk')).ok).toBe(true);
  });
});

describe('the order of the checks', () => {
  type Defect =
    | 'status' | 'accountable' | 'key' | 'delegation' | 'ended' | 'vault' | 'notFound' | 'type' | 'subject' | 'issuer' | 'revoked' | 'expired' | 'issuerInvalid' | 'digest';
  const ORDER: Defect[] = ['status', 'accountable', 'key', 'delegation', 'ended', 'vault', 'notFound', 'type', 'subject', 'issuer', 'revoked', 'expired', 'issuerInvalid', 'digest'];
  const senderId = makeWorld().sender.id;
  const otherDigest = proposalOf({ ...DOCUMENT, quantity: 3 }).proposal_digest;

  /** A world with each defect of the list and with no other: the order of the list is the order of the protocol. */
  function worldWith(defects: readonly Defect[]): { world: World; context: World['context'] } {
    const has = (defect: Defect): boolean => defects.includes(defect);
    const attestation: WorldOptions['attestation'] = has('notFound') ? null : {
      issuerId: 'e1'.repeat(32), subject: has('subject') ? 'b4'.repeat(32) : senderId, ...(has('type') ? { attType: 15 } : {}), ...(has('issuer') ? { issuer: ed25519Key('checks test: an issuer').publicKeyHex } : {}),
      ...(has('revoked') ? { status: { type: 'AttRevoked' as const, at: T - HOUR, reason: 0 } } : {}), ...(has('expired') ? { validUntil: T - 1 } : {}), ...(has('digest') ? { digest: otherDigest } : {}),
    };
    const world = makeWorld({
      organisation: has('accountable') ? null : { domain: 'buyer.example', verified: true },
      delegation: { ...(has('delegation') ? { delegate: 'b7'.repeat(32) } : {}), ...(has('ended') ? { notAfter: T - 1 } : {}) },
      attestation,
      issuerRecord: has('issuerInvalid') ? { status: { type: 'Revoked', by: { type: 'ControllerSet' }, reason: 1, at: T - HOUR, invalidFrom: T - 2 * HOUR, successor: null } } : {},
    });
    if (has('status')) world.gateway.setStatus(world.sender, 'suspended');
    const context = { ...world.context, ...(has('key') ? { buyerPkh: STRANGER } : {}), ...(has('vault') ? { escrowRef: PLAIN_ESCROW_REF } : {}) };
    return { world, context };
  }
  /** The approval reference names the issuer record that the attestation names. */
  const issuerHandoff = (world: World) => ({ ...world.handoff, approval: world.handoff.approval === null ? null : { ...world.handoff.approval, issuer_did: `did:vector:${'e1'.repeat(32)}` } });

  it.each(HANDOFF_KINDS)('gives the codes of COUNTERPARTY_REFUSALS in their order for the %s, one defect fewer at a time, and then passes', async (kind) => {
    const codes: string[] = [];
    for (let left = 0; left <= ORDER.length; left += 1) {
      const { world, context } = worldWith(from(ORDER, left));
      codes.push(codeOf(await runChecks(sharedChecks(world.ports, { kind, request: issuerHandoff(world), context }))));
    }
    expect(first(codes, ORDER.length)).toEqual(first(COUNTERPARTY_REFUSALS[kind], ORDER.length));
    expect(codes[ORDER.length]).toBe('accepted');
  });

  it('gives the codes of the bid desk in their order: its list is the shared list up to the vault payment', async () => {
    const codes: string[] = [];
    for (let left = 0; left <= 6; left += 1) {
      const { world, context } = worldWith(from(ORDER, left));
      codes.push(codeOf(await run(world, 'bid-desk', context)));
    }
    expect(first(codes, 6)).toEqual(first(COUNTERPARTY_REFUSALS['bid-desk'], 6));
    expect(codes[6]).toBe('accepted');
  });

  it('keeps the shared names in the order of the codes, and one name for each check', () => {
    for (const kind of COUNTERPARTY_KINDS) {
      expect(new Set(SHARED_CHECK_NAMES[kind]).size).toBe(SHARED_CHECK_NAMES[kind].length);
      expect(first(SHARED_CHECK_NAMES[kind], 6)).toEqual(['sender_active', 'sender_accountable', 'sender_key', 'delegation', 'delegation_usable', 'vault_paid']);
    }
  });
});

describe('what each check reads, and when', () => {
  it('reads the delegation, its use, the vault payment, the attestation and the delegation again, in this order, and the sender once', async () => {
    const world = makeWorld();
    const calls: string[] = [];
    expect((await run(world, 'order-desk', world.context, spied(world, calls))).ok).toBe(true);
    expect(calls).toEqual(['readDelegation', 'delegationUse', 'escrowPaid', 'attestation', 'readDelegation']);
    expect(world.gateway.requests.filter((request) => request.path.startsWith('/1.0/identifiers/'))).toHaveLength(1);
  });

  it('reads no approval for a bid desk', async () => {
    const world = makeWorld({ attestation: null });
    const calls: string[] = [];
    expect((await run(world, 'bid-desk', world.context, spied(world, calls))).ok).toBe(true);
    expect(calls).toEqual(['readDelegation', 'delegationUse', 'escrowPaid']);
  });

  it('reads nothing from the ledger after a refusal of the sender, and nothing after the first refusal', async () => {
    const suspended = makeWorld();
    suspended.gateway.setStatus(suspended.sender, 'suspended');
    const calls: string[] = [];
    expect(codeOf(await run(suspended, 'order-desk', suspended.context, spied(suspended, calls)))).toBe('sender_not_active');
    expect(calls).toEqual([]);
    const world = makeWorld({ delegation: { notAfter: T - 1 } });
    const later: string[] = [];
    expect(codeOf(await run(world, 'order-desk', world.context, spied(world, later)))).toBe('delegation_ended');
    expect(later).toEqual(['readDelegation', 'delegationUse']);
  });

  it('reads the clock once for the whole list, and gives every check the same time', async () => {
    const world = makeWorld();
    const times: number[] = [];
    let reads = 0;
    const ports: ChecksPorts = {
      ...world.ports, clock: () => { reads += 1; return T + reads; },
      ledger: {
        ...world.ports.ledger,
        delegationUse: (id, at) => { times.push(at); return world.ports.ledger.delegationUse(id, at); },
        attestation: (id, at) => { times.push(at); return world.ports.ledger.attestation(id, at); },
      },
    };
    expect((await run(world, 'order-desk', world.context, ports)).ok).toBe(true);
    expect(reads).toBe(1);
    expect(times).toEqual([T + 1, T + 1]);
  });
});

describe('the buyer key comes from the job context and never from the body', () => {
  it('refuses when the context names a key that the record does not list, even when the body names one that it lists', async () => {
    const world = makeWorld();
    const body = { ...world.handoff, buyer_pkh: world.delegateKey.keyHash };
    const outcome = await runChecks(sharedChecks(world.ports, { kind: 'order-desk', request: body, context: { ...world.context, buyerPkh: STRANGER } }));
    expect(codeOf(outcome)).toBe('sender_key_mismatch');
  });

  it('accepts when the context names the key, whatever the body says', async () => {
    const world = makeWorld();
    for (const buyer of [STRANGER, 'not a key', null, 7]) {
      const body = { ...world.handoff, buyer_pkh: buyer };
      expect((await runChecks(sharedChecks(world.ports, { kind: 'order-desk', request: body, context: world.context }))).ok).toBe(true);
    }
  });

  it('refuses a delegation whose delegate key is the key of the body and not the key of the context', async () => {
    const world = makeWorld({ delegation: { delegateKey: STRANGER } });
    const body = { ...world.handoff, buyer_pkh: STRANGER };
    expect(codeOf(await runChecks(sharedChecks(world.ports, { kind: 'order-desk', request: body, context: world.context })))).toBe('delegation_invalid');
  });
});

describe('a source that cannot be read', () => {
  it.each([
    ['a gateway that answers 503', { status: 503, body: '{}' }], ['a gateway that answers 500', { status: 500, body: '{}' }], ['a gateway that answers 429', { status: 429, body: '{}' }],
    ['a gateway that answers 400', { status: 400, body: '{}' }], ['a network that fails', 'network' as const], ['an answer that is not a resolution', { status: 200, body: 'not json' }],
  ])('ends with check_unavailable for %s, and never with sender_not_active', async (_what, fault) => {
    const world = makeWorld();
    world.gateway.fault(`/1.0/identifiers/${world.sender.did}`, fault);
    const outcome = await run(world);
    expect(outcome).toMatchObject({ ok: false, code: 'check_unavailable', detail: 'the identity gateway could not be read', record: { checks: {} } });
    expect(world.faults).toHaveLength(1);
    world.gateway.fault(`/1.0/identifiers/${world.sender.did}`, null);
    expect((await run(world)).ok).toBe(true);
  });

  it('ends with check_unavailable when the gateway port throws, and when it answers for another DID', async () => {
    const world = makeWorld();
    const throwing: ChecksPorts = { ...world.ports, gateway: { resolve: failing } };
    expect(codeOf(await run(world, 'order-desk', world.context, throwing))).toBe('check_unavailable');
    const other = makeWorld().ports.gateway.resolve;
    const misrouted: ChecksPorts = { ...world.ports, gateway: { resolve: async () => other(`did:vector:${'12'.repeat(32)}`) } };
    expect(codeOf(await run(world, 'order-desk', world.context, misrouted))).toBe('check_unavailable');
    // The same agent under another name does not make a sender: the resolution must be the resolution of the DID of the request.
    const other2 = world.gateway.createAgent({ label: 'someone else', organisation: { domain: 'x.example' } });
    const swapped: ChecksPorts = { ...world.ports, gateway: { resolve: async () => world.ports.gateway.resolve(other2.did) } };
    expect(codeOf(await run(world, 'order-desk', world.context, swapped))).toBe('check_unavailable');
  });

  const SENDER_PASSED = ['sender_active', 'sender_accountable', 'sender_key'];
  const failures: Array<[string, (world: World) => ChecksPorts, string, string[]]> = [
    ['readDelegation', (w) => withLedger(w, { readDelegation: failing }), 'delegation', SENDER_PASSED],
    ['delegationUse', (w) => withLedger(w, { delegationUse: failing }), 'delegation use', [...SENDER_PASSED, 'delegation']],
    ['escrowPaid', (w) => withLedger(w, { escrowPaid: failing }), 'vault payment', [...SENDER_PASSED, 'delegation', 'delegation_usable']],
  ];
  it.each(failures)('ends with check_unavailable when the read %s fails, with the checks before it recorded', async (_method, ports, source, passed) => {
    const world = makeWorld();
    const outcome = await run(world, 'order-desk', world.context, ports(world));
    expect(outcome).toMatchObject({ ok: false, code: 'check_unavailable', detail: `the ${source} could not be read` });
    expect(Object.keys(outcome.record.checks)).toEqual(passed);
    expect(JSON.stringify(outcome)).not.toContain('secret-token');
  });

  it('ends with check_unavailable when the read of the attestation fails, and when the second read of the delegation fails', async () => {
    const world = makeWorld();
    const attestation = await run(world, 'order-desk', world.context, withLedger(world, { attestation: failing }));
    expect(attestation).toMatchObject({ ok: false, code: 'check_unavailable', detail: 'the attestation could not be read' });
    expect(Object.keys(attestation.record.checks)).toHaveLength(6);
    let reads = 0;
    const second = withLedger(world, { readDelegation: (id) => { reads += 1; return reads === 1 ? world.ports.ledger.readDelegation(id) : failing(); } });
    expect(await run(world, 'order-desk', world.context, second)).toMatchObject({ ok: false, code: 'check_unavailable', detail: 'the delegation could not be read' });
  });

  it('ends with check_unavailable, and not with a rule, for the answer of a read that is not for this check', async () => {
    const world = makeWorld();
    const use = await world.ports.ledger.delegationUse(world.handoff.delegation, T);
    const stale = withLedger(world, { delegationUse: async () => ({ ...use, atMs: T - 1 }) });
    expect(codeOf(await run(world, 'order-desk', world.context, stale))).toBe('check_unavailable');
    const paid = await world.ports.ledger.escrowPaid(world.context.escrowRef, world.handoff.delegation);
    const other = withLedger(world, { escrowPaid: async () => ({ ...paid, escrowRef: PLAIN_ESCROW_REF }) });
    expect(codeOf(await run(world, 'order-desk', world.context, other))).toBe('check_unavailable');
  });

  it('ends with check_unavailable for a transaction that the source does not know, and for a Koios that fails', async () => {
    const world = makeWorld();
    expect(codeOf(await run(world, 'order-desk', { ...world.context, escrowRef: `${'ee'.repeat(32)}#0` }))).toBe('check_unavailable');
    const down = makeWorld({ koios: { status: { tx_info: 500 } } });
    expect(codeOf(await run(down))).toBe('check_unavailable');
  });
});

describe('an input of the wrong form is an error, never a pass', () => {
  it('throws a TypeError for a kind that is not a counterparty kind, and for a request of the other kind', () => {
    const world = makeWorld();
    expect(() => sharedChecks(world.ports, { kind: 'reorder-agent', request: world.handoff, context: world.context } as unknown as SharedInput)).toThrow(TypeError);
    expect(() => sharedChecks(world.ports, { kind: 'bid-desk', request: world.handoff, context: world.context } as unknown as SharedInput)).toThrow(TypeError);
    expect(() => sharedChecks(world.ports, { kind: 'order-desk', request: world.rfq, context: world.context } as unknown as SharedInput)).toThrow(TypeError);
    expect(() => sharedChecks(world.ports, inputOf(world, 'order-desk'))).not.toThrow();
  });

  it.each([
    ['a sender that is not a DID', (w: World) => ({ request: { ...w.handoff, sender_did: 'did:vector:abc' } })], ['a delegation in capitals', (w: World) => ({ request: { ...w.handoff, delegation: w.handoff.delegation.toUpperCase() } })],
    ['a buyer key in capitals', (w: World) => ({ context: { ...w.context, buyerPkh: w.context.buyerPkh.toUpperCase() } })], ['a buyer key that is too short', (w: World) => ({ context: { ...w.context, buyerPkh: 'ab' } })],
    ['an escrow reference with no index', (w: World) => ({ context: { ...w.context, escrowRef: 'ab'.repeat(32) } })],
  ])('throws a TypeError for %s', (_what, change) => {
    const world = makeWorld();
    expect(() => sharedChecks(world.ports, { ...inputOf(world, 'order-desk'), ...change(world) } as SharedInput)).toThrow(TypeError);
  });

  it.each([Number.NaN, -1, 1.5, Number.POSITIVE_INFINITY, undefined, '1700000000000'])('throws a TypeError for a clock that gives %s', (time) => {
    const world = makeWorld();
    expect(() => sharedChecks({ ...world.ports, clock: () => time as number }, inputOf(world, 'order-desk'))).toThrow(TypeError);
  });
});

describe('what a refusal says', () => {
  it('carries the two digests of a digest mismatch, and no digests for another code', async () => {
    const other = proposalOf({ ...DOCUMENT, quantity: 3 });
    const world = makeWorld({ attestation: { digest: other.proposal_digest } });
    const outcome = await run(world);
    expect(outcome).toMatchObject({ ok: false, code: 'approval_digest_mismatch', digests: { expected_digest: other.proposal_digest, observed_digest: world.proposal.proposal_digest } });
    expect(await run(makeWorld({ attestation: { attType: 15 } }))).toMatchObject({ ok: false, digests: null });
  });

  it('never repeats the salt, the document, the escrow reference or a secret of a read', async () => {
    const world = makeWorld({ attestation: { digest: proposalOf({ ...DOCUMENT, quantity: 3 }).proposal_digest } });
    const outcomes = [await run(world), await run(makeWorld({ delegation: null })), await run(makeWorld({ delegation: { notAfter: T - 1 } })), await run(makeWorld(), 'order-desk', world.context, withLedger(world, { escrowPaid: failing }))];
    for (const outcome of outcomes) {
      const text = JSON.stringify(outcome);
      for (const secret of [world.proposal.salt, 'run1-0001', world.context.escrowRef, 'secret-token', world.delegateKey.keyHash]) expect(text).not.toContain(secret);
    }
  });
});
