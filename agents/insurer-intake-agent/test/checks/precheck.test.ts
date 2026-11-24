// agents/insurer-intake-agent/test/checks/precheck.test.ts: the hook of the Insurer Intake Agent, as the runtime asks it before it claims an escrow. A go is the answer only when the 15 checks passed, and then the
// record of the checks waits for the job with the hash of the request. A refusal is the status and the code of the protocol, and the escrow stays open. A refusal for `approval_digest_mismatch` starts a challenge
// after the answer, and the answer never holds a reference. The question: does the hook ever give a go for a wrong sender, delegation, vault payment, approval, insurer, advert or a request number that exists?
import type { Server, ServerResponse } from 'node:http';
import { describe, expect, it } from 'vitest';
import { ed25519Key } from '@vsa/id-kit/testing';
import { createJobServer } from '@vsa/service-kit';
import type { JobContext, PrecheckAnswer, Refusal } from '@vsa/service-kit';
import { MESSAGE_LIMIT, SHARED_CHECK_NAMES } from '@vsa/usecase-kit/checks';
import type { ChecksPorts } from '@vsa/usecase-kit/checks';
import type { ApprovalChallengeInput, ChallengeResult } from '@vsa/usecase-kit/dispute';
import { PRIORAUTH_CAPABILITIES, PRIORAUTH_CLAIM } from '@vsa/usecase-kit/priorauth';
import { COUNTERPARTY_REFUSALS, ERROR_STATUS, canonicalSha256, parseHandoff, parseJsonText } from '@vsa/usecase-kit/protocol';
import type { Handoff } from '@vsa/usecase-kit/protocol';
import { createPrecheck } from '../../src/checks/index.ts';
import type { BookReader, PrecheckDeps } from '../../src/checks/index.ts';
import { OTHER_ADVERT_REF, OTHER_DID, SELF } from './samples.ts';
import { ATTESTATION_ID, HOUR, ISSUER_ID, ISSUER_KEY, PLAIN_ESCROW_REF, RecordingSink, ScriptedBook, T, failing, makeWorld, proposalOf, withLedger } from './support.ts';
import type { World, WorldOptions } from './support.ts';

const STRANGER = ed25519Key('insurer intake test: a stranger').keyHash;
/** The digest of a request that the hirer did not send: the approval that holds it does not match the request that the sender sends. */
const OTHER_DIGEST = proposalOf({ justification: 'Another synthetic text.' }).proposal_digest;
const MISMATCH_DETAIL = 'the digest of the attestation is not the digest of the document and the salt that were received';
/** The 15 checks of a request that passes, in the order that they run: the 12 shared checks, then the three of the agent. */
const CHECK_NAMES = [...SHARED_CHECK_NAMES['insurer-intake-agent'], 'for_this_insurer', 'advert', 'not_duplicate'];

type Hook = (request: Handoff, context: JobContext) => Promise<PrecheckAnswer>;

const FILED_RECORD = { claim: `${'c1'.repeat(32)}#0`, evidence: '77'.repeat(32), challenge: `${'99'.repeat(32)}#0` };
const FILED: ChallengeResult = {
  ok: true,
  value: {
    record: FILED_RECORD,
    claim_token: `636c6d5f${'0a'.repeat(28)}`, against_did: OTHER_DID, evidence_uri: 'https://evidence.example/document', evidence_hash: '55'.repeat(32), challenge_tx: '99'.repeat(32),
    challenge_token: `63686c5f${'0e'.repeat(28)}`, stake_lovelace: 50_000_000n, deadline: T + 72 * HOUR, fee_lovelace: 1_200_000n, extra_evidence: null,
  },
};

interface RigOptions {
  readonly context?: JobContext;
  readonly ports?: ChecksPorts;
  readonly book?: BookReader;
  readonly passed?: PrecheckDeps['passed'];
  readonly dispute?: PrecheckDeps['dispute'];
  readonly schedule?: PrecheckDeps['schedule'];
}

interface Rig {
  readonly world: World;
  readonly context: JobContext;
  readonly deps: PrecheckDeps;
  readonly hook: Hook;
  readonly book: ScriptedBook;
  readonly sink: RecordingSink;
  /** The tasks that the hook gave to `schedule`. A test runs them by hand. */
  readonly scheduled: Array<() => Promise<void>>;
  /** The input of each call of `challengeApproval` of the double of the dispute. */
  readonly challenges: ApprovalChallengeInput[];
  readonly logs: string[];
  /** The hook on the request and the context of the world. */
  run(): Promise<PrecheckAnswer>;
}

/** The hook over the world, with a scripted book, a recording sink, a double of the dispute that files a challenge, and a `schedule` that keeps its tasks. */
function rigOf(world: World, over: RigOptions = {}): Rig {
  const scheduled: Array<() => Promise<void>> = [];
  const challenges: ApprovalChallengeInput[] = [];
  const logs: string[] = [];
  const book = new ScriptedBook();
  const sink = new RecordingSink();
  const deps: PrecheckDeps = {
    ports: over.ports ?? world.ports, book: over.book ?? book, self: SELF, passed: over.passed ?? sink,
    dispute: over.dispute ?? { challengeApproval: async (input) => { challenges.push(input); return FILED; } },
    schedule: over.schedule ?? ((task) => { scheduled.push(task); }), log: (line) => { logs.push(line); },
  };
  const hook = createPrecheck(deps);
  const context = over.context ?? world.context;
  return { world, context, deps, hook, book, sink, scheduled, challenges, logs, run: () => hook(world.handoff, context) };
}

/** The refusal of an answer: a test that expects a refusal fails when the answer is a go. */
function refusalOf(answer: PrecheckAnswer): { status: number; error: string; message: string } {
  if (answer.go) throw new Error('the hook gave a go');
  return { status: answer.status, error: answer.error, message: answer.message };
}

const hashOf = (handoff: Handoff): string => {
  const hash = canonicalSha256(handoff);
  if (!hash.ok) throw new Error(hash.detail);
  return hash.value;
};

describe('a request that passes every check', () => {
  it('gets { go: true }, and the sink holds the 15 checks with the hash of the request', async () => {
    const rig = rigOf(makeWorld());
    expect(await rig.run()).toEqual({ go: true });
    expect(rig.sink.puts).toHaveLength(1);
    const [put] = rig.sink.puts;
    expect(put!.escrowRef).toBe(rig.context.escrowRef);
    expect(put!.nowMs).toBe(T);
    expect(put!.entry.request_sha256).toBe(hashOf(rig.world.handoff));
    expect(Object.keys(put!.entry.record.checks)).toEqual(CHECK_NAMES);
    expect(CHECK_NAMES).toHaveLength(15);
    expect(Object.values(put!.entry.record.checks).every((value) => value === true)).toBe(true);
    expect(put!.entry.record.facts).toEqual({
      organisation: 'clinic.example', organisation_verified: true, approval_attestation: ATTESTATION_ID, approval_issuer_did: null, approval_issuer_key_hash: ISSUER_KEY.keyHash,
      approval_valid_until: T + 4 * HOUR,
    });
    expect(rig.scheduled).toEqual([]);
    expect(rig.challenges).toEqual([]);
    expect(rig.logs).toEqual([]);
  });

  it('holds the hash of the request as the job parses it, so the job finds the same hash for the same body', async () => {
    const rig = rigOf(makeWorld());
    await rig.run();
    const parsed = parseHandoff(JSON.parse(JSON.stringify(rig.world.handoff)));
    if (!parsed.ok) throw new Error(parsed.detail);
    expect(rig.sink.puts[0]!.entry.request_sha256).toBe(hashOf(parsed.value));
  });

  it('holds the hash of the body that it checked: two bodies that differ in a member of the approval reference have two hashes', async () => {
    const rig = rigOf(makeWorld());
    const other: Handoff = { ...rig.world.handoff, approval: { attestation: ATTESTATION_ID, issuer_did: `did:vector:${'f3'.repeat(32)}` } };
    expect(await rig.hook(rig.world.handoff, rig.context)).toEqual({ go: true });
    expect(await rig.hook(other, rig.context)).toEqual({ go: true });
    const [first, second] = rig.sink.puts.map((put) => put.entry.request_sha256);
    expect(first).toBe(hashOf(rig.world.handoff));
    expect(second).toBe(hashOf(other));
    expect(first).not.toBe(second);
  });

  it('puts one record for each go, and the record of a refused request is none', async () => {
    const rig = rigOf(makeWorld({ organisation: null }));
    expect(refusalOf(await rig.run()).error).toBe('sender_unaccountable');
    expect(rig.sink.puts).toEqual([]);
  });

  it('is a rejection and never a go when the record cannot be put: the answer is a fault of the service', async () => {
    const rig = rigOf(makeWorld(), { passed: { put: () => { throw new Error('the store is broken'); } } });
    await expect(rig.run()).rejects.toThrow('the store is broken');
  });
});

describe('the 17 refusal codes of the hook', () => {
  const duplicate = async (): Promise<Rig> => {
    const rig = rigOf(makeWorld());
    rig.book.record('run1', 'RUN1-1');
    return rig;
  };
  const CASES: Array<[string, () => Promise<Rig>]> = [
    ['sender_not_active', async () => { const w = makeWorld(); w.gateway.setStatus(w.sender, 'suspended'); return rigOf(w); }],
    ['sender_unaccountable', async () => rigOf(makeWorld({ organisation: null }))],
    ['sender_key_mismatch', async () => { const w = makeWorld(); return rigOf(w, { context: { ...w.context, buyerPkh: STRANGER } }); }],
    ['delegation_invalid', async () => rigOf(makeWorld({ delegation: { delegate: 'b7'.repeat(32) } }))],
    ['delegation_ended', async () => rigOf(makeWorld({ delegation: { notAfter: T - 1 } }))],
    ['not_vault_paid', async () => { const w = makeWorld(); return rigOf(w, { context: { ...w.context, escrowRef: PLAIN_ESCROW_REF } }); }],
    ['approval_not_found', async () => rigOf(makeWorld({ attestation: null }))],
    ['approval_wrong_type', async () => rigOf(makeWorld({ attestation: { attType: 15 } }))],
    ['approval_wrong_subject', async () => rigOf(makeWorld({ attestation: { subject: 'b4'.repeat(32) } }))],
    ['approval_wrong_issuer', async () => rigOf(makeWorld({ attestation: { issuer: ed25519Key('insurer intake test: another issuer').publicKeyHex } }))],
    ['approval_revoked', async () => rigOf(makeWorld({ attestation: { status: { type: 'AttRevoked', at: T - HOUR, reason: 0 } } }))],
    ['approval_expired', async () => rigOf(makeWorld({ attestation: { validUntil: T - 1 } }))],
    ['approval_issuer_invalid', async () => rigOf(makeWorld({ attestation: { issuerId: ISSUER_ID } }))],
    ['approval_digest_mismatch', async () => rigOf(makeWorld({ attestation: { digest: OTHER_DIGEST } }))],
    ['not_for_this_insurer', async () => rigOf(makeWorld({ request: { insurer_did: OTHER_DID } }))],
    ['advert_mismatch', async () => rigOf(makeWorld({ request: { advert_ref: OTHER_ADVERT_REF } }))],
    ['duplicate_request', duplicate],
  ];

  it('lists the codes of the page: every code of COUNTERPARTY_REFUSALS for the Insurer Intake Agent, in the order of the page', () => {
    expect(CASES.map(([code]) => code)).toEqual([...COUNTERPARTY_REFUSALS['insurer-intake-agent']]);
    expect(CASES).toHaveLength(17);
  });

  it.each(CASES)('refuses with %s and its status, leaves no record, and the same request with no defect gets a go', async (code, refusing) => {
    const rig = await refusing();
    const refusal = refusalOf(await rig.run());
    expect(refusal.error).toBe(code);
    expect(refusal.status).toBe(ERROR_STATUS[code as keyof typeof ERROR_STATUS]);
    expect(refusal.status).toBe(403);
    expect(rig.sink.puts).toEqual([]);
    // Only a digest mismatch starts a challenge.
    expect(rig.scheduled).toHaveLength(code === 'approval_digest_mismatch' ? 1 : 0);
    expect(await rigOf(makeWorld()).run()).toEqual({ go: true });
  });

  type Defect =
    | 'status' | 'accountable' | 'key' | 'delegation' | 'ended' | 'vault' | 'notFound' | 'type' | 'subject' | 'issuer' | 'revoked' | 'expired' | 'issuerInvalid' | 'digest'
    | 'insurer' | 'advert' | 'duplicate';
  const ORDER: Defect[] = [
    'status', 'accountable', 'key', 'delegation', 'ended', 'vault', 'notFound', 'type', 'subject', 'issuer', 'revoked', 'expired', 'issuerInvalid', 'digest', 'insurer', 'advert', 'duplicate',
  ];
  const senderId = makeWorld().sender.id;

  /** A world with each defect of the list and with no other. The order of the list is the order of the page. */
  function withDefects(defects: readonly Defect[]): Rig {
    const has = (defect: Defect): boolean => defects.includes(defect);
    const attestation: WorldOptions['attestation'] = has('notFound') ? null : {
      issuerId: ISSUER_ID, subject: has('subject') ? 'b4'.repeat(32) : senderId, ...(has('type') ? { attType: 15 } : {}),
      ...(has('issuer') ? { issuer: ed25519Key('insurer intake test: an issuer').publicKeyHex } : {}),
      ...(has('revoked') ? { status: { type: 'AttRevoked' as const, at: T - HOUR, reason: 0 } } : {}), ...(has('expired') ? { validUntil: T - 1 } : {}), ...(has('digest') ? { digest: OTHER_DIGEST } : {}),
    };
    const world = makeWorld({
      organisation: has('accountable') ? null : { domain: 'clinic.example', verified: true },
      delegation: { ...(has('delegation') ? { delegate: 'b7'.repeat(32) } : {}), ...(has('ended') ? { notAfter: T - 1 } : {}) },
      attestation,
      issuerRecord: has('issuerInvalid') ? { status: { type: 'Revoked', by: { type: 'ControllerSet' }, reason: 1, at: T - HOUR, invalidFrom: T - 2 * HOUR, successor: null } } : {},
      request: { ...(has('insurer') ? { insurer_did: OTHER_DID } : {}), ...(has('advert') ? { advert_ref: OTHER_ADVERT_REF } : {}) },
    });
    if (has('status')) world.gateway.setStatus(world.sender, 'suspended');
    const rig = rigOf(world, { context: { ...world.context, ...(has('key') ? { buyerPkh: STRANGER } : {}), ...(has('vault') ? { escrowRef: PLAIN_ESCROW_REF } : {}) } });
    if (has('duplicate')) rig.book.record('run1', 'RUN1-1');
    return rig;
  }

  it('gives the codes in the order of the page, one defect fewer at a time, and then a go', async () => {
    const codes: string[] = [];
    for (let left = 0; left <= ORDER.length; left += 1) {
      const answer = await withDefects(ORDER.filter((_, index) => index >= left)).run();
      codes.push(answer.go ? 'go' : answer.error);
    }
    expect(codes.filter((_, index) => index < ORDER.length)).toEqual([...COUNTERPARTY_REFUSALS['insurer-intake-agent']]);
    expect(codes[ORDER.length]).toBe('go');
  });

  it('does not read the intake book after an earlier refusal, and it reads it for a request that passes the 14 checks before it', async () => {
    const refusing = rigOf(makeWorld({ request: { advert_ref: OTHER_ADVERT_REF } }));
    expect(refusalOf(await refusing.run()).error).toBe('advert_mismatch');
    expect(refusing.book.asked).toEqual([]);
    const passing = rigOf(makeWorld());
    expect(await passing.run()).toEqual({ go: true });
    expect(passing.book.asked).toEqual([['run1', 'run1-1']]);
  });
});

describe('a source that cannot be read', () => {
  const unavailable = (answer: PrecheckAnswer, source: string): void => {
    expect(answer).toEqual({ go: false, status: 503, error: 'check_unavailable', message: `the ${source} could not be read` });
    expect(JSON.stringify(answer)).not.toContain('secret-token');
  };

  it('is 503 check_unavailable when the identity gateway fails, and the cause goes to the service and not to the sender', async () => {
    const world = makeWorld();
    const rig = rigOf(world, { ports: { ...world.ports, gateway: { resolve: failing } } });
    unavailable(await rig.run(), 'identity gateway');
    expect(world.faults.map(([source]) => source)).toEqual(['identity gateway']);
    expect(rig.sink.puts).toEqual([]);
  });

  it('is 503 check_unavailable when the gateway answers with no result', async () => {
    const world = makeWorld();
    const rig = rigOf(world, { ports: { ...world.ports, gateway: { resolve: async () => ({ ok: false, rule: 'gateway.down', detail: 'key=secret-token-123' }) as never } } });
    unavailable(await rig.run(), 'identity gateway');
  });

  const READS: Array<[string, string, Partial<ChecksPorts['ledger']>]> = [
    ['delegation', 'delegation', { readDelegation: failing }],
    ['delegation use', 'delegation use', { delegationUse: failing }],
    ['vault payment', 'vault payment', { escrowPaid: failing }],
    ['attestation', 'attestation', { attestation: failing }],
  ];
  it.each(READS)('is 503 check_unavailable when the read of the %s fails, and the same request with the read working gets a go', async (_name, source, ledger) => {
    const world = makeWorld();
    const rig = rigOf(world, { ports: withLedger(world, ledger) });
    unavailable(await rig.run(), source);
    expect(world.faults.map(([name]) => name)).toEqual([source]);
    expect(rig.sink.puts).toEqual([]);
    expect(rig.scheduled).toEqual([]);
    expect(await rigOf(makeWorld()).run()).toEqual({ go: true });
  });

  it('is 503 check_unavailable when the intake book fails, and the cause goes to the service', async () => {
    const world = makeWorld();
    const cause = new Error('EIO: the disk of /data/requests.json failed, key=secret-token-123');
    const rig = rigOf(world, { book: { has: () => Promise.reject(cause) } });
    unavailable(await rig.run(), 'intake book');
    expect(world.faults).toEqual([['intake book', cause]]);
    expect(rig.sink.puts).toEqual([]);
    expect(rig.scheduled).toEqual([]);
  });

  it('is 503 check_unavailable when the intake book is a file that is damaged', async () => {
    const world = makeWorld();
    const rig = rigOf(world, { book: { has: () => Promise.reject(new Error('the intake book file is damaged')) } });
    unavailable(await rig.run(), 'intake book');
  });

  it('is 503 check_unavailable and never a go when the intake book is full and lacks the number: the escrow stays open', async () => {
    const world = makeWorld();
    const full = new ScriptedBook(2);
    full.record('run1', 'run1-8');
    full.record('run1', 'run1-9');
    const rig = rigOf(world, { book: full });
    unavailable(await rig.run(), 'intake book');
    expect(world.faults).toHaveLength(1);
    expect(world.faults[0]![0]).toBe('intake book');
    expect(world.faults[0]![1]).toBeInstanceOf(RangeError);
    expect(rig.sink.puts).toEqual([]);
    expect(rig.scheduled).toEqual([]);
    expect(rig.challenges).toEqual([]);
    // The twin: the same request with a book that has room for it gets a go.
    const room = new ScriptedBook(3);
    room.record('run1', 'run1-8');
    room.record('run1', 'run1-9');
    expect(await rigOf(makeWorld(), { book: room }).run()).toEqual({ go: true });
  });

  it('still refuses a number that a full intake book holds with 403 duplicate_request: only a number that it lacks is unavailable', async () => {
    const full = new ScriptedBook(2);
    full.record('run1', 'RUN1-1');
    full.record('run1', 'run1-9');
    const world = makeWorld();
    const rig = rigOf(world, { book: full });
    expect(refusalOf(await rig.run())).toMatchObject({ status: 403, error: 'duplicate_request' });
    expect(world.faults).toEqual([]);
    expect(rig.sink.puts).toEqual([]);
  });

  it('is never a refusal of a rule: a read that fails before the request is read gives 503 and not a code of the page', async () => {
    const world = makeWorld({ request: { advert_ref: OTHER_ADVERT_REF } });
    const rig = rigOf(world, { ports: withLedger(world, { escrowPaid: failing }) });
    expect(refusalOf(await rig.run()).error).toBe('check_unavailable');
  });
});

describe('a request for another use case', () => {
  it('is a rejection and never a go, also when it carries the request that the hirer approved: every shared check passes for it', async () => {
    const world = makeWorld();
    const rig = rigOf(world);
    const other: Handoff = { ...world.handoff, use_case: 'inventory-reorder' };
    await expect(rig.hook(other, rig.context)).rejects.toBeInstanceOf(TypeError);
    expect(rig.sink.puts).toEqual([]);
    expect(rig.scheduled).toEqual([]);
    // The twin: the same request for use case 2 (prior authorization) gets a go.
    expect(await rig.hook(world.handoff, rig.context)).toEqual({ go: true });
  });
});

describe('the challenge after approval_digest_mismatch', () => {
  /** A world whose approval holds the digest of another request. */
  const mismatching = (over: RigOptions = {}): Rig => rigOf(makeWorld({ attestation: { digest: OTHER_DIGEST } }), over);

  it('answers 403 first, and the challenge starts after the answer, with the evidence of the refusal', async () => {
    const rig = mismatching();
    const answer = await rig.run();
    expect(refusalOf(answer)).toMatchObject({ status: 403, error: 'approval_digest_mismatch' });
    // The answer is written and nothing is filed yet: the hook only gave a task to `schedule`.
    expect(rig.challenges).toEqual([]);
    expect(rig.scheduled).toHaveLength(1);
    await rig.scheduled[0]!();
    expect(rig.challenges).toEqual([{
      sender: rig.world.sender.did,
      escrow_ref: rig.context.escrowRef,
      capability_id: PRIORAUTH_CAPABILITIES.intake,
      claim_capability_id: PRIORAUTH_CAPABILITIES.draft,
      statement_text: PRIORAUTH_CLAIM.statements[0].text,
      buyer_pkhs: [rig.context.buyerPkh],
      evidence: {
        kind: 'approval_digest',
        use_case: 'prior-authorization',
        approval: rig.world.handoff.approval,
        mismatch: { ok: false, code: 'approval_digest_mismatch', detail: MISMATCH_DETAIL, expected_digest: OTHER_DIGEST, observed_digest: rig.world.proposal.proposal_digest },
      },
    }]);
  });

  it('gives the dispute the full result of the approval check as the mismatch, and never the bare pair of digests', async () => {
    const rig = mismatching();
    await rig.run();
    await rig.scheduled[0]!();
    const { mismatch } = rig.challenges[0]!.evidence;
    expect(Object.keys(mismatch).sort()).toEqual(['code', 'detail', 'expected_digest', 'observed_digest', 'ok']);
    expect(mismatch.ok).toBe(false);
    expect(mismatch.code).toBe('approval_digest_mismatch');
    expect(mismatch.expected_digest).not.toBe(mismatch.observed_digest);
  });

  it('names the sender, the escrow and the buyer key from the request and the context of the runtime, and the statement S1 of the claim of the sender', async () => {
    const rig = mismatching();
    await rig.run();
    await rig.scheduled[0]!();
    const input = rig.challenges[0]!;
    expect(input.sender).toBe(rig.world.handoff.sender_did);
    expect(input.escrow_ref).toBe(rig.world.context.escrowRef);
    expect(input.buyer_pkhs).toEqual([rig.world.context.buyerPkh]);
    expect(input.statement_text).toBe('A request this agent submits is byte-identical to the document whose digest its hirer approved.');
    expect([input.capability_id, input.claim_capability_id]).toEqual(['health.priorauth.intake.v1', 'health.priorauth.draft.v1']);
  });

  it('holds no text of the request in the input of the challenge: the evidence is the approval and the two digests', async () => {
    const rig = mismatching();
    await rig.run();
    await rig.scheduled[0]!();
    const text = JSON.stringify(rig.challenges[0]);
    const { document, salt } = rig.world.handoff;
    for (const member of ['justification', 'patient_ref', 'ordering_clinician_ref', 'order_id', 'service_code', 'request_number']) {
      expect(text, member).not.toContain(String(document[member]));
    }
    expect(text).not.toContain(salt);
  });

  it('puts no reference in the message of the refusal: the message is the sentence of the check', async () => {
    const rig = mismatching();
    const refusal = refusalOf(await rig.run());
    expect(refusal.message).toBe(MISMATCH_DETAIL);
    expect(refusal.message).not.toMatch(/[0-9a-f]{16}/);
    expect(refusal.message).not.toContain('#');
    expect(refusal.message.length).toBeLessThanOrEqual(MESSAGE_LIMIT);
  });

  it('does not wait for the challenge: the answer comes while a challenge that never ends is running', async () => {
    const started: string[] = [];
    const never = new Promise<ChallengeResult>(() => undefined);
    const rig = mismatching({ dispute: { challengeApproval: () => { started.push('challenge'); return never; } }, schedule: (task) => { void task(); } });
    const answer = await rig.run();
    expect(refusalOf(answer).error).toBe('approval_digest_mismatch');
    expect(started).toEqual(['challenge']);
  });

  it('starts no challenge for any other refusal, and none for a go', async () => {
    for (const world of [makeWorld({ attestation: { validUntil: T - 1 } }), makeWorld({ attestation: { attType: 15 } }), makeWorld({ request: { advert_ref: OTHER_ADVERT_REF } }), makeWorld({ organisation: null }), makeWorld()]) {
      const rig = rigOf(world);
      await rig.run();
      expect(rig.scheduled).toEqual([]);
    }
  });

  it('starts one task for each mismatch, also for the same escrow: the journal of the dispute makes the one challenge', async () => {
    const rig = mismatching();
    await rig.run();
    await rig.run();
    expect(rig.scheduled).toHaveLength(2);
    expect(rig.challenges).toEqual([]);
  });

  it('catches an error of the challenge and logs its kind and the escrow, and not its message', async () => {
    const rig = mismatching({ dispute: { challengeApproval: () => Promise.reject(new TypeError('the node said no: https://node.example/submit?key=secret-token-123')) } });
    const answer = await rig.run();
    expect(refusalOf(answer).error).toBe('approval_digest_mismatch');
    await expect(rig.scheduled[0]!()).resolves.toBeUndefined();
    expect(rig.logs).toHaveLength(1);
    expect(rig.logs[0]).toContain(rig.context.escrowRef);
    expect(rig.logs[0]).toContain('TypeError');
    expect(rig.logs.join('\n')).not.toContain('secret-token');
  });

  it('catches an error that is not an Error, and an error of the log function itself', async () => {
    const world = makeWorld({ attestation: { digest: OTHER_DIGEST } });
    const throwing = rigOf(world, { dispute: { challengeApproval: () => Promise.reject('secret-token-123') } });
    await throwing.run();
    await expect(throwing.scheduled[0]!()).resolves.toBeUndefined();
    expect(throwing.logs.join('\n')).not.toContain('secret-token');
    const deaf = rigOf(world);
    const deafDeps: PrecheckDeps = { ...deaf.deps, log: () => { throw new Error('the log is closed'); } };
    const tasks: Array<() => Promise<void>> = [];
    await createPrecheck({ ...deafDeps, schedule: (task) => { tasks.push(task); } })(world.handoff, world.context);
    await expect(tasks[0]!()).resolves.toBeUndefined();
  });

  it('logs the references of a challenge that is filed', async () => {
    const rig = mismatching();
    await rig.run();
    await rig.scheduled[0]!();
    expect(rig.logs).toHaveLength(1);
    expect(rig.logs[0]).toContain(rig.context.escrowRef);
    for (const reference of [FILED_RECORD.claim, FILED_RECORD.evidence, FILED_RECORD.challenge]) expect(rig.logs[0], reference).toContain(reference);
  });

  it('logs the code and the references of a challenge that is not filed, and never its detail', async () => {
    const notFiled: ChallengeResult = { ok: false, code: 'no_open_claim', detail: 'the sender has no open claim: key=secret-token-123', evidence: null, sent: null, challenge: null, wrong_document: null };
    const rig = mismatching({ dispute: { challengeApproval: async () => notFiled } });
    await rig.run();
    await rig.scheduled[0]!();
    expect(rig.logs).toHaveLength(1);
    expect(rig.logs[0]).toContain('no_open_claim');
    expect(rig.logs[0]).toContain(rig.context.escrowRef);
    expect(rig.logs[0]).not.toContain('secret-token');
    const landed: ChallengeResult = {
      ok: false, code: 'challenge_not_confirmed', detail: 'the node refused key=secret-token-123',
      evidence: { tx_hash: '77'.repeat(32), uri: 'https://evidence.example/document', document_hash: '55'.repeat(32) },
      sent: { tx_hash: '88'.repeat(32), valid_to: T + HOUR, may_land: true }, challenge: null, wrong_document: null,
    };
    const second = mismatching({ dispute: { challengeApproval: async () => landed } });
    await second.run();
    await second.scheduled[0]!();
    expect(second.logs[0]).toContain('challenge_not_confirmed');
    expect(second.logs[0]).toContain('77'.repeat(32));
    expect(second.logs[0]).toContain('88'.repeat(32));
    expect(second.logs[0]).not.toContain('secret-token');
  });

  it('answers the refusal when `schedule` throws, and tells the service', async () => {
    const world = makeWorld({ attestation: { digest: OTHER_DIGEST } });
    const rig = rigOf(world, { schedule: () => { throw new Error('the queue is closed: key=secret-token-123'); } });
    const refusal = refusalOf(await rig.run());
    expect(refusal).toMatchObject({ status: 403, error: 'approval_digest_mismatch', message: MISMATCH_DETAIL });
    expect(world.faults.map(([source]) => source)).toEqual(['refusal hook']);
  });
});

describe('the time of the hook', () => {
  /**
   * What one read costs in this test: the default of the setting `CHECKS_READ_BUDGET_MS`, the most that one timed read of the hook may take. The hook reads the gateway one time and the ledger five times, one
   * after the other, and each read ends inside the budget that the caller gives it. The runtime waits 10 seconds, and the hook keeps 1 second of margin, so the six reads must stay under 9,000 ms: 1,499 ms for each read at most.
   */
  const CHECKS_READ_BUDGET_MS = 1_200;

  it('reads the gateway one time and the ledger five times, one after the other, then the intake book: with a ledger that answers in the budget of a read, it ends in 7,200 ms', async () => {
    const world = makeWorld();
    const clock = { now: 0 };
    const reads: string[] = [];
    const timed = <R>(name: string, read: () => Promise<R>): Promise<R> => {
      reads.push(name);
      clock.now += CHECKS_READ_BUDGET_MS;
      return read();
    };
    const real = world.ports;
    const ports: ChecksPorts = {
      ...real,
      gateway: { resolve: (did) => timed('gateway', () => real.gateway.resolve(did)) },
      ledger: {
        hireResource: real.ledger.hireResource,
        readDelegation: (id) => timed('delegation', () => real.ledger.readDelegation(id)),
        delegationUse: (id, at) => timed('delegation use', () => real.ledger.delegationUse(id, at)),
        attestation: (id, at) => timed('attestation', () => real.ledger.attestation(id, at)),
        escrowPaid: (ref, id) => timed('vault payment', () => real.ledger.escrowPaid(ref, id)),
      },
    };
    const inner = new ScriptedBook();
    const book: BookReader = { has: (tenant, number) => { reads.push('book'); return inner.has(tenant, number); } };
    const started = clock.now;
    expect(await rigOf(world, { ports, book }).run()).toEqual({ go: true });
    expect(reads).toEqual(['gateway', 'delegation', 'delegation use', 'vault payment', 'attestation', 'delegation', 'book']);
    const timedReads = reads.filter((name) => name !== 'book');
    expect(timedReads).toHaveLength(6);
    expect(clock.now - started).toBe(timedReads.length * CHECKS_READ_BUDGET_MS);
    expect(clock.now - started).toBeLessThan(9_000);
    // The largest budget for a read is the one whose six reads stay under 9,000 ms.
    expect(Math.floor((9_000 - 1) / timedReads.length)).toBe(1_499);
  });
});

describe('the input of the hook', () => {
  it('is a TypeError when it is wrong, and it is checked before any request', () => {
    const { deps } = rigOf(makeWorld());
    expect(() => createPrecheck(deps)).not.toThrow();
    const wrong: Array<Record<string, unknown>> = [
      { ...deps, ports: null }, { ...deps, ports: {} }, { ...deps, book: {} }, { ...deps, book: null }, { ...deps, self: 'did:vector:abc' }, { ...deps, passed: {} }, { ...deps, passed: null },
      { ...deps, dispute: {} }, { ...deps, dispute: null }, { ...deps, schedule: 'now' }, { ...deps, schedule: undefined }, { ...deps, log: null },
    ];
    for (const [index, bad] of wrong.entries()) expect(() => createPrecheck(bad as unknown as PrecheckDeps), String(index)).toThrow(TypeError);
    expect(() => createPrecheck(null as unknown as PrecheckDeps)).toThrow(TypeError);
  });
});

describe('inside createJobServer, as the runtime calls it', () => {
  const TOKEN = `Bearer ${'ab'.repeat(16)}`;

  class Bad extends Error {
    constructor(readonly refusal: Refusal) {
      super(refusal.message);
    }
  }
  const wire = (request: unknown): string => JSON.stringify([{ content: JSON.stringify(request), role: 'user' }]);
  const headers = (context: JobContext): Record<string, string> => ({
    authorization: TOKEN, 'x-vector-escrow-ref': context.escrowRef, 'x-vector-advert-ref': context.advertRef, 'x-vector-advert-model': context.advertModel, 'x-vector-buyer-pkh': context.buyerPkh,
    'x-vector-payment-lovelace': String(context.paymentLovelace), 'x-vector-deliver-by-ms': String(context.deliverByMs),
  });

  /** What a test changes in the call of the runtime: the body that it sends, and a look at each response before the handler of the server runs. */
  interface Call {
    readonly body?: Handoff;
    readonly watch?: (response: ServerResponse) => void;
  }

  /** The `schedule` of the service: the task starts on the next turn of the event loop, after the server wrote the answer. */
  const nextTurn: PrecheckDeps['schedule'] = (task) => { setImmediate(() => { void task(); }); };
  /** A `schedule` that is not for the service: the task starts before the server writes the answer. */
  const sameTurn: PrecheckDeps['schedule'] = (task) => { queueMicrotask(() => { void task(); }); };

  async function precheck(rig: Rig, call: Call = {}): Promise<{ status: number; body: unknown }> {
    const server: Server = createJobServer<Handoff, { done: true }>({
      manifestText: '{}', authHeader: TOKEN, clock: () => T, log: () => undefined,
      parse: (json) => {
        const text = parseJsonText(json);
        const handoff = text.ok ? parseHandoff(text.value) : text;
        if (!handoff.ok) throw new Bad({ code: handoff.code, status: ERROR_STATUS[handoff.code], message: handoff.detail, kind: 'request' });
        return handoff.value;
      },
      run: async () => ({ done: true }), refusalOf: (error) => (error instanceof Bad ? error.refusal : null),
      precheck: rig.hook,
    });
    const watch = call.watch;
    if (watch !== undefined) server.prependListener('request', (_request, response) => { watch(response); });
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
    try {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      const reply = await fetch(`http://127.0.0.1:${port}/precheck`, { method: 'POST', body: wire(call.body ?? rig.world.handoff), headers: headers(rig.context) });
      return { status: reply.status, body: await reply.json() };
    } finally {
      server.close();
      server.closeAllConnections();
    }
  }

  it('answers 200 with go for a request that passes, and the record waits for the job', async () => {
    const rig = rigOf(makeWorld());
    expect(await precheck(rig)).toEqual({ status: 200, body: { go: true, reserved_ms: 120000 } });
    expect(rig.sink.puts).toHaveLength(1);
    expect(rig.sink.puts[0]!.entry.request_sha256).toBe(hashOf(rig.world.handoff));
  });

  it('answers 403 with the code and the sentence of the check for a refusal of a rule, and no go', async () => {
    const rig = rigOf(makeWorld({ request: { advert_ref: OTHER_ADVERT_REF } }));
    expect(await precheck(rig)).toEqual({ status: 403, body: { error: 'advert_mismatch', message: 'the request is not for the advert that the escrow was posted on' } });
    expect(rig.sink.puts).toEqual([]);
  });

  it('answers 403 for a digest mismatch while the challenge is still running, and the answer holds no reference', async () => {
    const release: Array<(result: ChallengeResult) => void> = [];
    const calls: ApprovalChallengeInput[] = [];
    const challenge = (input: ApprovalChallengeInput): Promise<ChallengeResult> => new Promise((resolve) => { calls.push(input); release.push(resolve); });
    const rig = rigOf(makeWorld({ attestation: { digest: OTHER_DIGEST } }), { dispute: { challengeApproval: challenge }, schedule: nextTurn });
    const reply = await precheck(rig);
    expect(reply).toEqual({ status: 403, body: { error: 'approval_digest_mismatch', message: MISMATCH_DETAIL } });
    // The challenge started and it is not done, and the sender has its answer.
    await new Promise((resolve) => { setImmediate(resolve); });
    expect(calls).toHaveLength(1);
    expect(rig.logs).toEqual([]);
    release[0]!(FILED);
    await new Promise((resolve) => { setImmediate(resolve); });
    expect(rig.logs).toHaveLength(1);
    expect(rig.logs[0]).toContain(rig.context.escrowRef);
  });

  it('writes the 403 before the task starts when the service schedules it with setImmediate, and the task starts first with queueMicrotask', async () => {
    const eventsOf = async (schedule: PrecheckDeps['schedule']): Promise<string[]> => {
      const events: string[] = [];
      const challengeApproval = async (): Promise<ChallengeResult> => {
        events.push('task');
        return FILED;
      };
      const rig = rigOf(makeWorld({ attestation: { digest: OTHER_DIGEST } }), { dispute: { challengeApproval }, schedule });
      const reply = await precheck(rig, {
        watch: (response) => {
          const original = response.end;
          // The first call of `end` on the response is the moment that the server writes the answer.
          Object.defineProperty(response, 'end', {
            configurable: true,
            value(this: ServerResponse, ...args: unknown[]): unknown {
              if (!events.includes('answer')) events.push('answer');
              return Reflect.apply(original, this, args);
            },
          });
        },
      });
      expect(reply).toEqual({ status: 403, body: { error: 'approval_digest_mismatch', message: MISMATCH_DETAIL } });
      await new Promise((resolve) => { setImmediate(resolve); });
      return events;
    };
    expect(await eventsOf(nextTurn)).toEqual(['answer', 'task']);
    // The contrast: with queueMicrotask the task starts first, so a part of the challenge that does not wait holds the answer back.
    expect(await eventsOf(sameTurn)).toEqual(['task', 'answer']);
  });

  it('answers 500 and never a go when the document is not an authorization request: a fault of the service', async () => {
    const rig = rigOf(makeWorld({ request: { justification: '' } }));
    expect(await precheck(rig)).toEqual({ status: 500, body: { error: 'internal' } });
    expect(rig.sink.puts).toEqual([]);
    expect(rig.scheduled).toEqual([]);
  });

  it('answers 500 and never a go for a handoff of use case 1 (inventory reorder) that carries the request that the hirer approved', async () => {
    const rig = rigOf(makeWorld());
    expect(await precheck(rig, { body: { ...rig.world.handoff, use_case: 'inventory-reorder' } })).toEqual({ status: 500, body: { error: 'internal' } });
    expect(rig.sink.puts).toEqual([]);
    // The twin: the same body for use case 2 (prior authorization) gets a go.
    expect(await precheck(rigOf(makeWorld()))).toEqual({ status: 200, body: { go: true, reserved_ms: 120000 } });
  });

  it('answers 503 for a read that failed, and never a go', async () => {
    const world = makeWorld();
    const reply = await precheck(rigOf(world, { ports: withLedger(world, { readDelegation: failing }) }));
    expect(reply.status).toBe(503);
    expect(reply.body).toMatchObject({ error: 'check_unavailable' });
    expect(JSON.stringify(reply.body)).not.toContain('secret-token');
  });

  it('answers 503 for an intake book that is full and lacks the number, and never a go', async () => {
    const full = new ScriptedBook(1);
    full.record('run1', 'run1-9');
    const rig = rigOf(makeWorld(), { book: full });
    const reply = await precheck(rig);
    expect(reply.status).toBe(503);
    expect(reply.body).toMatchObject({ error: 'check_unavailable' });
    expect(rig.sink.puts).toEqual([]);
  });
});
