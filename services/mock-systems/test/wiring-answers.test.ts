// The answers of the wiring (src/wiring.ts) for each answer of the use-case kit. The check of the kit is replaced by a function that answers as the test says, so that these tests can make
// answers that the real kit does not give. The question: does the wiring turn an answer into a pass that the kit did not give, and does it turn an exception of the kit into an answer?
// The real check on a fixture ledger is in test/wiring.test.ts.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CheckUnavailableError } from '@vsa/usecase-kit/checks';
import type * as Checks from '@vsa/usecase-kit/checks';
import { decideApproval } from '../src/approval.ts';
import type { ApprovalInput } from '../src/approval.ts';
import { APPROVAL_CODES } from '../src/errors.ts';
import { wireApprovalCheck } from '../src/wiring.ts';
import { World } from './support/world.ts';

/** What the replaced check was asked, what it answers, and what it throws. */
const kit = vi.hoisted(() => ({ asked: [] as unknown[], answer: undefined as unknown, failure: null as unknown }));
vi.mock('@vsa/usecase-kit/checks', async (importOriginal) => ({
  ...(await importOriginal<typeof Checks>()),
  approvalCheckOf: () => async (input: unknown) => {
    kit.asked.push(input);
    if (kit.failure !== null) throw kit.failure;
    return kit.answer;
  },
}));

const DOCUMENT = { schema: 'vector.usecase.ranking.v1', ranked: [{ rank: 1 }] };
const INPUT: ApprovalInput = {
  sender: `did:vector:${'a1'.repeat(32)}`, delegation: 'd1'.repeat(32), attestation: '07'.repeat(32), issuerDid: `did:vector:${'b2'.repeat(32)}`, document: DOCUMENT, salt: 'f6'.repeat(32), atMs: 1_234_567,
};
const PASS = { ok: true, attestation: INPUT.attestation, issuer_did: INPUT.issuerDid, issuer_key_hash: 'c3'.repeat(28), valid_until: 2_000_000 };
const check = () => {
  const world = new World();
  return wireApprovalCheck({ ledger: world.approvalLedgerEnv(), gateway: world.client, now: () => 7 });
};

beforeEach(() => {
  kit.asked.length = 0;
  kit.answer = undefined;
  kit.failure = null;
});

describe('the input that the wiring gives to the kit', () => {
  it('is the input of the protocol: the reference with the two members, the sender, the delegation, the ranking as it is, the salt and the time of the call', async () => {
    kit.answer = PASS;
    await check()(INPUT);
    expect(kit.asked).toStrictEqual([{
      approval: { attestation: INPUT.attestation, issuer_did: INPUT.issuerDid }, sender_did: INPUT.sender, delegation: INPUT.delegation, document: DOCUMENT, salt: INPUT.salt, now_ms: INPUT.atMs,
    }]);
    expect((kit.asked[0] as { document: unknown }).document, 'the ranking that the kit hashes is the ranking that the call sent').toBe(DOCUMENT);
  });
});

describe('the answer that the wiring gives for an answer of the kit', () => {
  it('is { ok: true } and no more for a pass, whatever facts the pass has', async () => {
    kit.answer = PASS;
    expect(await check()(INPUT)).toStrictEqual({ ok: true });
  });

  it.each(APPROVAL_CODES)('is the refusal %s with the same code and the same sentence, and with no other member', async (code) => {
    kit.answer = { ok: false, code, detail: `the kit found: ${code}`, ...(code === 'approval_digest_mismatch' ? { expected_digest: 'e1'.repeat(32), observed_digest: 'e2'.repeat(32) } : {}) };
    expect(await check()(INPUT)).toStrictEqual({ ok: false, code, detail: `the kit found: ${code}` });
  });

  it.each([
    ['ok as a text', { ok: 'true' }],
    ['ok as the number 1', { ok: 1 }],
    ['ok as an object', { ok: {} }],
    ['no ok', {}],
    ['a pass that has no members', { attestation: INPUT.attestation }],
    ['true', true],
    ['a text', 'ok'],
    ['undefined', undefined],
    ['null', null],
    ['a refusal with no code and no sentence', { ok: false }],
    ['a refusal with no sentence', { ok: false, code: 'approval_expired' }],
    ['a refusal with a code that the service does not have', { ok: false, code: 'approval_great', detail: 'x' }],
    ['a refusal with the code of the shared checks', { ok: false, code: 'delegation_invalid', detail: 'x' }],
    ['a refusal with the code of an unreadable source', { ok: false, code: 'check_unavailable', detail: 'x' }],
    ['ok as a text, with the code and the sentence of a rule', { ok: 'true', code: 'approval_revoked', detail: 'x' }],
    ['ok as the number 1, with the code and the sentence of a rule', { ok: 1, code: 'approval_expired', detail: 'x' }],
    ['ok null, with the code and the sentence of a rule', { ok: null, code: 'approval_revoked', detail: 'x' }],
    ['no ok, with the code and the sentence of a rule', { code: 'approval_revoked', detail: 'x' }],
  ])('is never a pass for an answer of another shape: %s is 503 approval_unavailable', async (_name, answer) => {
    kit.answer = answer;
    const decided = await decideApproval(check(), INPUT);
    expect(decided.ok).toBe(false);
    if (!decided.ok) expect([decided.refusal.status, decided.refusal.code]).toEqual([503, 'approval_unavailable']);
  });
});

describe('an exception of the kit', () => {
  it('stays an exception: the wiring does not turn it into an answer, and the decision of the service is 503 approval_unavailable with the rule approval.failed', async () => {
    const failure = new CheckUnavailableError('attestation');
    kit.failure = failure;
    await expect(check()(INPUT)).rejects.toBe(failure);
    const decided = await decideApproval(check(), INPUT);
    expect(decided.ok).toBe(false);
    if (!decided.ok) expect([decided.refusal.status, decided.refusal.code, decided.refusal.rule]).toEqual([503, 'approval_unavailable', 'approval.failed']);
  });

  it.each([
    ['an error of the input', new TypeError('the input of the approval check is wrong: salt must be 64 lower-case hex characters')],
    ['an error of another kind', new Error('the node did not answer')],
    ['a value that is no error', 'broken'],
  ])('is 503 approval_unavailable for %s, and never a pass', async (_name, failure) => {
    kit.failure = failure;
    kit.answer = PASS;
    const decided = await decideApproval(check(), INPUT);
    expect(decided.ok).toBe(false);
    if (!decided.ok) expect([decided.refusal.status, decided.refusal.code, decided.refusal.rule]).toEqual([503, 'approval_unavailable', 'approval.failed']);
  });
});
