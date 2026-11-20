// packages/usecase-kit/test/protocol/approval.test.ts: the approval reference, its constants, and the types of the approval check that the counterparty checks and the mock systems share.
// The function that checks an approval is not here: this file holds only its input, its result and its type. The typecheck is part of the test.
import { ATT_TYPES } from '@vsa/buyer-core';
import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  APPROVAL_ATT_TYPE, APPROVAL_DEPOSIT_LOVELACE, APPROVAL_REFUSALS, APPROVAL_VALIDITY_DEFAULT_MS, APPROVAL_VALIDITY_MAX_MS, parseApprovalRef,
} from '@vsa/usecase-kit/protocol';
import type {
  ApprovalAccepted, ApprovalCheck, ApprovalDigestMismatch, ApprovalInput, ApprovalRef, ApprovalRefusal, ApprovalRefused, ApprovalRefusedByCheck, ApprovalResult, RefusalCode,
} from '@vsa/usecase-kit/protocol';
import { APPROVAL, ATTESTATION, BAD_MARKER, DID_A, DOCUMENT, ID_A, SALT } from './support.ts';

describe('the constants of an approval', () => {
  it('has the attestation type 5, the one that the attestation builder calls approval', () => {
    expect(APPROVAL_ATT_TYPE).toBe(5);
    expect(APPROVAL_ATT_TYPE).toBe(ATT_TYPES.approval);
  });

  it('has a validity of 4 hours by default and at most 24 hours', () => {
    expect(APPROVAL_VALIDITY_DEFAULT_MS).toBe(4 * 60 * 60 * 1000);
    expect(APPROVAL_VALIDITY_MAX_MS).toBe(24 * 60 * 60 * 1000);
    expect(APPROVAL_VALIDITY_DEFAULT_MS).toBeLessThan(APPROVAL_VALIDITY_MAX_MS);
  });

  it('has the deposit of an attestation, 5,000,000 lovelace, as a bigint', () => {
    expect(APPROVAL_DEPOSIT_LOVELACE).toBe(5_000_000n);
    expect(typeof APPROVAL_DEPOSIT_LOVELACE).toBe('bigint');
  });
});

describe('parseApprovalRef', () => {
  it('takes the attestation and the DID of the issuer, and returns an object with these two members only', () => {
    const result = parseApprovalRef({ ...APPROVAL });
    expect(result).toStrictEqual({ ok: true, value: { attestation: ATTESTATION, issuer_did: DID_A } });
  });

  it('returns a new object, so that a caller holds no reference to the input', () => {
    const input = { ...APPROVAL };
    const result = parseApprovalRef(input);
    expect(result.ok && result.value).not.toBe(input);
  });

  it.each([
    ['null', null],
    ['an array', [ATTESTATION, DID_A]],
    ['a string', ATTESTATION],
    ['undefined', undefined],
    ['a number', 7],
    ['an object of a class', new Map()],
  ])('refuses %s, and says that it must be an object', (_name, value) => {
    const result = parseApprovalRef(value);
    expect(result).toMatchObject({ ok: false, code: 'bad_shape' });
    expect(!result.ok && result.detail).toContain('approval must be a JSON object');
  });

  it.each([
    ['no attestation', { issuer_did: DID_A }, 'approval has no member "attestation"'],
    ['no issuer', { attestation: ATTESTATION }, 'approval has no member "issuer_did"'],
    ['a third member', { ...APPROVAL, valid_until: 5 }, 'approval has the member "valid_until", which is not allowed'],
    ['an attestation in upper case', { ...APPROVAL, attestation: 'AB'.repeat(32) }, 'approval.attestation must be 64 lower-case hex characters'],
    ['a short attestation', { ...APPROVAL, attestation: '22'.repeat(31) }, 'approval.attestation must be'],
    ['an attestation that is a number', { ...APPROVAL, attestation: 22 }, 'approval.attestation must be'],
    ['an issuer that is a key hash', { ...APPROVAL, issuer_did: 'ab'.repeat(28) }, 'approval.issuer_did must be'],
    ['an issuer with no prefix', { ...APPROVAL, issuer_did: ID_A }, 'approval.issuer_did must be'],
    ['an issuer that is null', { ...APPROVAL, issuer_did: null }, 'approval.issuer_did must be'],
  ])('refuses %s, and names the member', (_name, value, expected) => {
    const result = parseApprovalRef(value);
    expect(result).toMatchObject({ ok: false, code: 'bad_shape' });
    expect(!result.ok && result.detail).toContain(expected);
  });

  it('names the field that it was given and never repeats the value', () => {
    const result = parseApprovalRef({ ...APPROVAL, attestation: BAD_MARKER }, 'request.approval');
    expect(result).toMatchObject({ ok: false });
    expect(!result.ok && result.detail).toContain('request.approval.attestation');
    expect(!result.ok && result.detail).not.toContain(BAD_MARKER);
  });
});

describe('ApprovalRefusal', () => {
  it('is the eight codes of the checks of an approval, in the order of the checks', () => {
    expect([...APPROVAL_REFUSALS]).toStrictEqual([
      'approval_not_found', 'approval_wrong_type', 'approval_wrong_subject', 'approval_wrong_issuer', 'approval_revoked', 'approval_expired', 'approval_issuer_invalid', 'approval_digest_mismatch',
    ]);
    expectTypeOf<ApprovalRefusal>().toEqualTypeOf<(typeof APPROVAL_REFUSALS)[number]>();
    expectTypeOf<ApprovalRefusal>().toExtend<RefusalCode>();
  });
});

describe('the types of the approval check', () => {
  const input: ApprovalInput = { approval: { ...APPROVAL }, sender_did: DID_A, delegation: '11'.repeat(32), document: DOCUMENT, salt: SALT, now_ms: 1_780_000_000_000 };

  /** A check that follows the type: it refuses a missing approval and takes any other. */
  const check: ApprovalCheck = async (given) =>
    given.approval === null
      ? { ok: false, code: 'approval_not_found', detail: 'the handoff has no approval' }
      : { ok: true, attestation: given.approval.attestation, issuer_did: given.approval.issuer_did, issuer_key_hash: 'cd'.repeat(28), valid_until: given.now_ms + APPROVAL_VALIDITY_DEFAULT_MS };

  it('take an input with the reference, the sender, the delegation, the document, the salt and the time', async () => {
    const result = await check(input);
    expect(result).toStrictEqual({ ok: true, attestation: ATTESTATION, issuer_did: DID_A, issuer_key_hash: 'cd'.repeat(28), valid_until: 1_780_000_000_000 + APPROVAL_VALIDITY_DEFAULT_MS });
  });

  it('take an input with no approval, as the check of an execute with a null approval does', async () => {
    const result = await check({ ...input, approval: null });
    expect(result).toStrictEqual({ ok: false, code: 'approval_not_found', detail: 'the handoff has no approval' });
  });

  it('give a result that says by `ok` what happened, and by `code` which check failed', async () => {
    const result: ApprovalResult = await check({ ...input, approval: null });
    if (result.ok) {
      expectTypeOf(result).toEqualTypeOf<ApprovalAccepted>();
      expect.unreachable('the approval was null');
    } else {
      expectTypeOf(result).toEqualTypeOf<ApprovalRefused>();
      expectTypeOf(result.code).toEqualTypeOf<ApprovalRefusal>();
      expect(result.code).toBe('approval_not_found');
    }
  });

  it('make a digest mismatch carry the two digests, and no other refusal needs them', () => {
    const digestsOf = (result: ApprovalResult): readonly [string, string] | null =>
      !result.ok && result.code === 'approval_digest_mismatch' ? [result.expected_digest, result.observed_digest] : null;
    const mismatch: ApprovalResult = { ok: false, code: 'approval_digest_mismatch', detail: 'the digest differs', expected_digest: '55'.repeat(32), observed_digest: '66'.repeat(32) };
    const revoked: ApprovalResult = { ok: false, code: 'approval_revoked', detail: 'the attestation was revoked' };
    expect(digestsOf(mismatch)).toStrictEqual(['55'.repeat(32), '66'.repeat(32)]);
    expect(digestsOf(revoked)).toBeNull();
    expectTypeOf<ApprovalDigestMismatch['code']>().toEqualTypeOf<'approval_digest_mismatch'>();
    expectTypeOf<ApprovalRefusedByCheck['code']>().toEqualTypeOf<Exclude<ApprovalRefusal, 'approval_digest_mismatch'>>();
  });

  it('refuse a result that is not in the protocol', () => {
    // @ts-expect-error a code that is not a code of an approval
    const wrongCode: ApprovalResult = { ok: false, code: 'sender_not_active', detail: 'x' };
    // @ts-expect-error a refusal has a detail
    const noDetail: ApprovalResult = { ok: false, code: 'approval_expired' };
    // @ts-expect-error an accepted approval names the attestation that passed
    const noAttestation: ApprovalResult = { ok: true, issuer_did: DID_A, issuer_key_hash: 'cd'.repeat(28), valid_until: null };
    // @ts-expect-error a check that gives back text is not a check
    const text: ApprovalCheck = async () => 'ok';
    // @ts-expect-error the time is a number of milliseconds
    const wrongTime: ApprovalInput = { ...input, now_ms: '1780000000000' };
    // @ts-expect-error the approval is a reference or null, and it is not left out
    const noApproval: ApprovalInput = { sender_did: DID_A, delegation: '11'.repeat(32), document: DOCUMENT, salt: SALT, now_ms: 1 };
    // @ts-expect-error a digest mismatch carries the two digests
    const noDigests: ApprovalResult = { ok: false, code: 'approval_digest_mismatch', detail: 'x' };
    // @ts-expect-error a digest mismatch carries the observed digest too
    const oneDigest: ApprovalResult = { ok: false, code: 'approval_digest_mismatch', detail: 'x', expected_digest: '55'.repeat(32) };
    // @ts-expect-error only a digest mismatch carries the digests
    const wrongDigests: ApprovalResult = { ok: false, code: 'approval_revoked', detail: 'x', expected_digest: '55'.repeat(32), observed_digest: '66'.repeat(32) };
    expect([wrongCode, noDetail, noAttestation, text, wrongTime, noApproval, noDigests, oneDigest, wrongDigests]).toHaveLength(9);
  });

  it('have an input that holds an approval reference as the protocol gives it', () => {
    expectTypeOf<ApprovalInput['approval']>().toEqualTypeOf<ApprovalRef | null>();
    expectTypeOf<ApprovalCheck>().toEqualTypeOf<(input: ApprovalInput) => Promise<ApprovalResult>>();
  });
});
