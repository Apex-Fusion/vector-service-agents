// packages/usecase-kit/test/checks/approval.test.ts: the check of an approval, `checkApproval`, on the real read code of buyer-core over an offline node. Each refusal has an accepted twin: the world
// with no change. The question of these tests: is a wrong approval ever accepted?
import { describe, expect, it } from 'vitest';
import { testKey } from '../../../buyer-core/test/fixtures/identity-world.ts';
import { CheckUnavailableError, approvalCheckOf, checkApproval } from '../../src/checks/index.ts';
import { canonicalSha256, proposalDigest } from '../../src/protocol/index.ts';
import type { ApprovalInput, Document } from '../../src/protocol/index.ts';
import {
  ATTESTATION_ID, DELEGATION_ID, DOCUMENT, HOUR, ISSUER_DID, ISSUER_ID, ISSUER_KEY, MAINNET, OTHER_DID, T, attestation, attestationUtxo, delegation, delegationUtxo, failing, makeWorld, proposalOf, withLedger,
} from './support.ts';
import type { World, WorldOptions } from './support.ts';

const check = (world: World, input: ApprovalInput = world.approvalInput) => checkApproval(world.ports, input);
const OTHER_KEY = testKey(40);
/** The digest of a proposal, or an error for a document or a salt that the protocol refuses. */
function digestOf(salt: string, document: Document): string {
  const digest = proposalDigest(salt, document);
  if (!digest.ok) throw new Error(digest.detail);
  return digest.value;
}
const revoked = { type: 'AttRevoked' as const, at: T - HOUR, reason: 0 };
/** An issuer record that was invalidated at `from`. */
const invalidated = (from: number | null) => ({ status: { type: 'Revoked' as const, by: { type: 'ControllerSet' as const }, reason: 1, at: T - HOUR, invalidFrom: from, successor: null } });
/** The world in which the issuer of the approval is a record: the root delegator is that agent. */
const agentRoot = (over: WorldOptions = {}): WorldOptions => ({
  delegation: { delegator: { type: 'Agent', id: ISSUER_ID } }, issuerRecord: {}, attestation: { issuerId: ISSUER_ID }, ...over,
});
const withIssuerDid = (world: World, issuerDid: string): ApprovalInput => ({ ...world.approvalInput, approval: { attestation: ATTESTATION_ID, issuer_did: issuerDid } });

async function refusal(world: World, input: ApprovalInput = world.approvalInput) {
  const result = await check(world, input);
  if (result.ok) throw new Error('the approval was accepted');
  return result;
}

describe('an approval that is right', () => {
  it('is accepted, and the result tells what was found: the attestation, the issuer key hash and the end of its validity', async () => {
    expect(await check(makeWorld())).toEqual({ ok: true, attestation: ATTESTATION_ID, issuer_did: null, issuer_key_hash: ISSUER_KEY.keyHash, valid_until: T + 4 * HOUR });
  });

  it('is accepted when its issuer is a record: the result names the issuer DID', async () => {
    const world = makeWorld(agentRoot());
    expect(await check(world, withIssuerDid(world, ISSUER_DID))).toMatchObject({ ok: true, issuer_did: ISSUER_DID });
  });

  it('has no end of validity when the attestation sets none', async () => {
    expect(await check(makeWorld({ attestation: { validUntil: null } }))).toMatchObject({ ok: true, valid_until: null });
  });

  it('is the same through approvalCheckOf, and it takes the time from the input and not from the clock', async () => {
    const world = makeWorld();
    const bound = approvalCheckOf({ ...world.ports, clock: () => 0 });
    expect(await bound(world.approvalInput)).toEqual(await check(world));
    expect(await bound({ ...world.approvalInput, now_ms: T + 5 * HOUR })).toMatchObject({ ok: false, code: 'approval_expired' });
  });
});

describe('found and authentic: approval_not_found', () => {
  it('refuses a null approval, and reads nothing from the ledger', async () => {
    const world = makeWorld();
    const result = await refusal(world, { ...world.approvalInput, approval: null });
    expect(result.code).toBe('approval_not_found');
    expect(world.ledger.provider.scans).toEqual([]);
    expect(world.ledger.koios.calls).toEqual([]);
  });

  it('refuses an attestation that no output holds', async () => {
    expect((await refusal(makeWorld({ attestation: null }))).code).toBe('approval_not_found');
  });

  it('refuses an output that is not authentic: at another address, or with two attestation tokens', async () => {
    const good = attestationUtxo(ATTESTATION_ID, attestation({ attType: 5 }));
    const elsewhere = { ...good, address: MAINNET.vault.address };
    const two = { ...good, assets: { ...good.assets, [`${MAINNET.attestation.hash}${'aa'.repeat(32)}`]: 1n } };
    for (const extra of [elsewhere, two]) expect((await refusal(makeWorld({ attestation: null, extraUtxos: [extra] }))).code).toBe('approval_not_found');
  });

  it('refuses a reference to another attestation than the one on the ledger', async () => {
    const world = makeWorld();
    const other = { ...world.approvalInput, approval: { attestation: '99'.repeat(32), issuer_did: OTHER_DID } };
    expect((await refusal(world, other)).code).toBe('approval_not_found');
  });
});

describe('the type: approval_wrong_type', () => {
  it.each([0, 1, 4, 15])('refuses an attestation of the type %i', async (attType) => {
    expect((await refusal(makeWorld({ attestation: { attType } }))).code).toBe('approval_wrong_type');
  });
});

describe('the subject: approval_wrong_subject', () => {
  it('refuses an approval for another agent than the sender', async () => {
    const result = await refusal(makeWorld({ attestation: { subject: 'b4'.repeat(32) } }));
    expect(result.code).toBe('approval_wrong_subject');
  });

  it('refuses an approval for the sender that is checked for another sender', async () => {
    const world = makeWorld();
    expect((await refusal(world, { ...world.approvalInput, sender_did: OTHER_DID })).code).toBe('approval_wrong_subject');
  });
});

describe('the issuer is the root delegator: approval_wrong_issuer', () => {
  it('refuses an approval that another key issued than the root delegator of a key principal', async () => {
    const result = await refusal(makeWorld({ attestation: { issuer: OTHER_KEY.publicKey } }));
    expect(result.code).toBe('approval_wrong_issuer');
  });

  it('accepts the key of a key principal by its hash, and refuses a key whose hash is another', async () => {
    const world = makeWorld({ delegation: { delegator: { type: 'PrincipalKey', hash: OTHER_KEY.keyHash, organisation: null } }, attestation: { issuer: OTHER_KEY.publicKey } });
    expect(await check(world)).toMatchObject({ ok: true, issuer_key_hash: OTHER_KEY.keyHash });
    const wrong = makeWorld({ delegation: { delegator: { type: 'PrincipalKey', hash: OTHER_KEY.keyHash, organisation: null } } });
    expect((await refusal(wrong)).code).toBe('approval_wrong_issuer');
  });

  it('refuses an issuer record that is not the root delegator, when the root delegator is an agent', async () => {
    const other = 'e2'.repeat(32);
    const world = makeWorld(agentRoot({ attestation: { issuerId: other } }));
    expect((await refusal(world, withIssuerDid(world, `did:vector:${other}`))).code).toBe('approval_wrong_issuer');
  });

  it('refuses an approval with no issuer record when the root delegator is an agent, even when the key is right', async () => {
    const world = makeWorld(agentRoot({ attestation: { issuerId: null } }));
    expect((await refusal(world)).code).toBe('approval_wrong_issuer');
    const twin = makeWorld(agentRoot());
    expect(await check(twin, withIssuerDid(twin, ISSUER_DID))).toMatchObject({ ok: true });
  });

  it('compares the issuer with the ROOT of the chain, not with the delegator of the delegation that was named', async () => {
    const parent = delegationUtxo('a1'.repeat(32), delegation({ delegate: ISSUER_ID, delegateKey: ISSUER_KEY.keyHash, remaining: 2, depth: 1, delegator: { type: 'PrincipalKey', hash: ISSUER_KEY.keyHash, organisation: null } }));
    const chain: WorldOptions = {
      delegation: { parent: 'a1'.repeat(32), depth: 2, remaining: 0, delegator: { type: 'Agent', id: ISSUER_ID } }, extraUtxos: [parent],
      issuerRecord: { keys: [{ keyType: 'Ed25519', key: ISSUER_KEY.publicKey, purposes: 31, pop: null }] },
    };
    expect(await check(makeWorld(chain))).toMatchObject({ ok: true });
    // The leaf delegator is the agent ISSUER_ID. An approval of that agent, signed by another key, is not an approval of the root key.
    const leaf = makeWorld({ ...chain, attestation: { issuerId: ISSUER_ID, issuer: OTHER_KEY.publicKey } });
    expect((await refusal(leaf, withIssuerDid(leaf, ISSUER_DID))).code).toBe('approval_wrong_issuer');
  });

  it('refuses a delegation that is not live, and a chain whose parent was ended: there is no root delegator to compare with', async () => {
    expect((await refusal(makeWorld({ delegation: null }))).code).toBe('approval_wrong_issuer');
    const orphan = makeWorld({ delegation: { parent: 'a1'.repeat(32), depth: 2, remaining: 0, delegator: { type: 'Agent', id: ISSUER_ID } }, issuerRecord: {} });
    expect((await refusal(orphan)).code).toBe('approval_wrong_issuer');
  });

  it('refuses a reference that names another issuer record than the attestation does, and accepts the right name', async () => {
    const world = makeWorld({ attestation: { issuerId: ISSUER_ID }, issuerRecord: {} });
    expect((await refusal(world, withIssuerDid(world, OTHER_DID))).code).toBe('approval_wrong_issuer');
    expect(await check(world, withIssuerDid(world, ISSUER_DID))).toMatchObject({ ok: true, issuer_did: ISSUER_DID });
  });
});

describe('valid by the rule of the registry', () => {
  it('refuses a revoked approval whatever its reason, and accepts the approval before it was revoked', async () => {
    for (const reason of [0, 1, 64, 1_000_000]) expect((await refusal(makeWorld({ attestation: { status: { ...revoked, reason } } }))).code).toBe('approval_revoked');
    expect(await check(makeWorld())).toMatchObject({ ok: true });
  });

  it('refuses an approval after its end, and accepts it at the end: the bound is inside the range', async () => {
    expect((await refusal(makeWorld({ attestation: { validUntil: T - 1 } }))).code).toBe('approval_expired');
    expect(await check(makeWorld({ attestation: { validUntil: T } }))).toMatchObject({ ok: true });
  });

  it('refuses an approval that has not started, and accepts it at its start', async () => {
    expect((await refusal(makeWorld({ attestation: { validFrom: T + 1 } }))).code).toBe('approval_expired');
    expect(await check(makeWorld({ attestation: { validFrom: T } }))).toMatchObject({ ok: true });
  });

  it('does not require that the time is after the time of issue: up to an hour before it is accepted, and more than an hour before it is not', async () => {
    expect(await check(makeWorld({ attestation: { issuedAt: T + 59 * 60_000 } }))).toMatchObject({ ok: true });
    expect(await check(makeWorld({ attestation: { issuedAt: T + HOUR } }))).toMatchObject({ ok: true });
    expect((await refusal(makeWorld({ attestation: { issuedAt: T + HOUR + 1 } }))).code).toBe('approval_expired');
  });

  it('refuses an approval whose issuer record was invalid when the approval was issued, and accepts one that was invalidated later', async () => {
    const issuedAt = T - HOUR;
    const world = (from: number | null) => makeWorld({ attestation: { issuerId: ISSUER_ID, issuedAt }, issuerRecord: invalidated(from) });
    for (const from of [issuedAt - 1, issuedAt]) {
      const refused = world(from);
      expect((await refusal(refused, withIssuerDid(refused, ISSUER_DID))).code).toBe('approval_issuer_invalid');
    }
    for (const from of [issuedAt + 1, null]) {
      const accepted = world(from);
      expect(await check(accepted, withIssuerDid(accepted, ISSUER_DID))).toMatchObject({ ok: true });
    }
  });

  it('refuses an approval whose issuer record cannot be found, and an approval whose envelope signature does not verify', async () => {
    const lost = makeWorld({ attestation: { issuerId: ISSUER_ID } });
    expect((await refusal(lost, withIssuerDid(lost, ISSUER_DID))).code).toBe('approval_issuer_invalid');
    const forged = makeWorld({ attestation: { envelopeSig: '01'.repeat(64) } });
    const result = await refusal(forged);
    expect(result).toMatchObject({ code: 'approval_issuer_invalid', detail: expect.stringContaining('envelope') });
  });
});

describe('the digest: approval_digest_mismatch', () => {
  it('refuses the digest of another document, and gives both digests', async () => {
    const other = proposalOf({ ...DOCUMENT, quantity: 51 });
    const world = makeWorld({ attestation: { digest: other.proposal_digest } });
    expect(await refusal(world)).toEqual({
      ok: false, code: 'approval_digest_mismatch', detail: expect.any(String), expected_digest: other.proposal_digest, observed_digest: world.proposal.proposal_digest,
    });
  });

  it('refuses a changed salt, and a changed document, with the digest of what was received', async () => {
    const world = makeWorld();
    const salt = '5a'.repeat(32);
    const bySalt = await refusal(world, { ...world.approvalInput, salt });
    expect(bySalt).toMatchObject({ code: 'approval_digest_mismatch', expected_digest: world.proposal.proposal_digest });
    expect('observed_digest' in bySalt && bySalt.observed_digest).toBe(digestOf(salt, world.proposal.document));
    const document = { ...DOCUMENT, quantity: 500 };
    const byDocument = await refusal(world, { ...world.approvalInput, document });
    expect('observed_digest' in byDocument && byDocument.observed_digest).toBe(digestOf(world.proposal.salt, document));
  });

  it('refuses the digest of the document with no salt, and accepts the digest with the salt', async () => {
    const unsalted = canonicalSha256(DOCUMENT);
    if (!unsalted.ok) throw new Error(unsalted.detail);
    expect((await refusal(makeWorld({ attestation: { digest: unsalted.value } }))).code).toBe('approval_digest_mismatch');
    expect(await check(makeWorld())).toMatchObject({ ok: true });
  });

  it('accepts a document whose keys come in another order: the digest is the digest of the canonical form', async () => {
    const world = makeWorld();
    const reordered = Object.fromEntries(Object.entries(world.proposal.document).reverse());
    expect(await check(world, { ...world.approvalInput, document: reordered })).toMatchObject({ ok: true });
  });
});

describe('the order of the checks', () => {
  const senderId = makeWorld().sender.id;
  const otherDigest = digestOf('5a'.repeat(32), DOCUMENT);
  type Defect = 'type' | 'subject' | 'issuer' | 'revoked' | 'expired' | 'issuerInvalid' | 'digest';
  /** A world with each defect in the list, and an approval that is right in every other way. */
  function worldWith(defects: readonly Defect[]): World {
    const has = (defect: Defect): boolean => defects.includes(defect);
    return makeWorld({
      attestation: {
        issuerId: ISSUER_ID,
        ...(has('type') ? { attType: 15 } : {}), ...(has('subject') ? { subject: 'b4'.repeat(32) } : { subject: senderId }), ...(has('issuer') ? { issuer: OTHER_KEY.publicKey } : {}),
        ...(has('revoked') ? { status: revoked } : {}), ...(has('expired') ? { validUntil: T - 1 } : {}), ...(has('digest') ? { digest: otherDigest } : {}),
      },
      issuerRecord: has('issuerInvalid') ? invalidated(T - 2 * HOUR) : {},
    });
  }

  it('gives the first refusal in the order of the checks, and accepts when no defect is left', async () => {
    const order: Defect[] = ['type', 'subject', 'issuer', 'revoked', 'expired', 'issuerInvalid', 'digest'];
    const expected = ['approval_wrong_type', 'approval_wrong_subject', 'approval_wrong_issuer', 'approval_revoked', 'approval_expired', 'approval_issuer_invalid', 'approval_digest_mismatch', 'accepted'];
    const codes: string[] = [];
    for (let left = 0; left <= order.length; left += 1) {
      const world = worldWith(order.slice(left));
      const result = await check(world, withIssuerDid(world, ISSUER_DID));
      codes.push(result.ok ? 'accepted' : result.code);
    }
    expect(codes).toEqual(expected);
  });
});

describe('a source that cannot be read: never a pass, and never the code of a rule', () => {
  it('throws CheckUnavailableError when the read of the attestation fails, and tells the service the cause but not the buyer', async () => {
    const world = makeWorld();
    const ports = withLedger(world, { attestation: failing });
    const error = await checkApproval(ports, world.approvalInput).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(CheckUnavailableError);
    expect(error).toMatchObject({ code: 'check_unavailable', source: 'attestation', message: 'the attestation could not be read' });
    if (error instanceof CheckUnavailableError) expect(error.message).not.toContain('secret-token');
    // The cause goes to the hook of the service, which is the operator's log. The error that the caller sees has only a fixed text.
    expect(world.faults).toHaveLength(1);
    expect(world.faults[0][0]).toBe('attestation');
    expect(String(world.faults[0][1])).toContain('secret-token');
  });

  it('throws CheckUnavailableError when the read of the delegation fails, after the checks that need no delegation', async () => {
    const world = makeWorld();
    const error = await checkApproval(withLedger(world, { readDelegation: failing }), world.approvalInput).catch((cause: unknown) => cause);
    expect(error).toMatchObject({ code: 'check_unavailable', source: 'delegation' });
    // A wrong type is refused before the delegation is read, so a failing delegation read does not hide it.
    const wrong = makeWorld({ attestation: { attType: 15 } });
    expect(await checkApproval(withLedger(wrong, { readDelegation: failing }), wrong.approvalInput)).toMatchObject({ ok: false, code: 'approval_wrong_type' });
  });

  it('throws CheckUnavailableError when the node does not answer: the real read code fails and the approval is not accepted', async () => {
    const world = makeWorld();
    world.ledger.provider.getUtxos = failing;
    await expect(check(world)).rejects.toBeInstanceOf(CheckUnavailableError);
  });

  it('throws CheckUnavailableError for an answer that is not for this approval: another attestation, another time, a missing or unknown condition', async () => {
    const world = makeWorld();
    const real = await world.ports.ledger.attestation(ATTESTATION_ID, T);
    const answers = [
      { ...real, id: '99'.repeat(32) }, { ...real, atMs: T + 1 }, { ...real, conditions: [] }, { ...real, conditions: real.conditions.filter((line) => line.id !== 'time_window') },
      { ...real, conditions: real.conditions.map((line) => (line.id === 'active' ? { ...line, result: 'maybe' as never } : line)) },
      { ...real, attestation: real.attestation === null ? null : { ...real.attestation, id: '99'.repeat(32) } },
    ];
    for (const answer of answers) await expect(checkApproval(withLedger(world, { attestation: async () => answer }), world.approvalInput)).rejects.toBeInstanceOf(CheckUnavailableError);
    await expect(checkApproval(withLedger(world, { attestation: async () => real }), world.approvalInput)).resolves.toMatchObject({ ok: true });
  });

  it('reads a condition that does not apply as a pass only where the rule allows it', async () => {
    const world = makeWorld();
    const real = await world.ports.ledger.attestation(ATTESTATION_ID, T);
    const change = (id: string, result: 'pass' | 'fail' | 'not_applicable') => withLedger(world, { attestation: async () => ({ ...real, conditions: real.conditions.map((line) => (line.id === id ? { ...line, result } : line)) }) });
    expect(await checkApproval(change('envelope', 'not_applicable'), world.approvalInput)).toMatchObject({ ok: true });
    expect(await checkApproval(change('active', 'not_applicable'), world.approvalInput)).toMatchObject({ ok: false, code: 'approval_revoked' });
    expect(await checkApproval(change('time_window', 'not_applicable'), world.approvalInput)).toMatchObject({ ok: false, code: 'approval_expired' });
    expect(await checkApproval(change('issuer_key_listed', 'fail'), world.approvalInput)).toMatchObject({ ok: false, code: 'approval_issuer_invalid' });
  });
});

describe('an input of the wrong type is an error, never a pass', () => {
  const world = makeWorld();
  const bad: Array<[string, Partial<Record<keyof ApprovalInput, unknown>>]> = [
    ['a time that is not a number', { now_ms: 'now' }], ['a time that is NaN', { now_ms: Number.NaN }], ['a time that is not whole', { now_ms: 1.5 }], ['a time below zero', { now_ms: -1 }],
    ['a time that is infinite', { now_ms: Number.POSITIVE_INFINITY }], ['a missing time', { now_ms: undefined }], ['a sender that is not a DID', { sender_did: 'did:vector:abc' }],
    ['a delegation in capitals', { delegation: DELEGATION_ID.toUpperCase() }], ['a salt that is too short', { salt: 'ab' }], ['a document that is not JSON data', { document: { a: undefined } }],
    ['an approval with a member that is not named', { approval: { attestation: ATTESTATION_ID, issuer_did: OTHER_DID, extra: 1 } }], ['an approval that is not an object', { approval: 'abc' }],
  ];
  it.each(bad)('throws a TypeError for %s', async (_name, change) => {
    await expect(check(world, { ...world.approvalInput, ...change } as ApprovalInput)).rejects.toBeInstanceOf(TypeError);
  });

  it('accepts the same input with the members right', async () => {
    expect(await check(world)).toMatchObject({ ok: true });
  });
});

describe('what a refusal says', () => {
  it('never repeats the salt, the document or a secret of the read', async () => {
    const salty = makeWorld({ attestation: { digest: proposalOf({ ...DOCUMENT, quantity: 1 }).proposal_digest } });
    const refusals = [
      await refusal(salty), await refusal(makeWorld({ attestation: { attType: 15 } })), await refusal(makeWorld({ attestation: { validUntil: T - 1 } })), await refusal(makeWorld({ delegation: null })),
    ];
    for (const result of refusals) {
      const text = JSON.stringify(result);
      expect(text).not.toContain(salty.proposal.salt);
      expect(text).not.toContain('run1-0001');
      expect(text).not.toContain('supplier_did');
    }
  });
});
