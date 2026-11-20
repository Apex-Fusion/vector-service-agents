// packages/usecase-kit/test/protocol/results.test.ts: the results of a buyer-side agent, and the one rule for their exit state. The typecheck is part of the test: a line that must not compile carries a
// `@ts-expect-error`, and the typecheck fails when such a line compiles. The samples below are the results that the pages describe.
import { describe, expect, expectTypeOf, it } from 'vitest';
import { EXECUTE_OUTCOMES, EXIT_STATES, NO_OPEN_CLAIM, PROPOSAL_SCHEMA, RECEIPT_CHECKS, RESULT_SCHEMA, exitStateOf, refusedExit } from '@vsa/usecase-kit/protocol';
import type {
  ChallengeRecord, CompletedResult, Decision, DisputedResult, EscalatedResult, ExecuteOutcome, ExecuteResult, ExitState, ExitStateInput, FailedProposalResult, FailedResult, HandoffRecord,
  ProposalResult, ProposedResult, ReceiptVerification, RefusedResult, SubJob, UnfiledDisputeResult, VaultRefusedResult, WriteRecord,
} from '@vsa/usecase-kit/protocol';
import { DID_B, DOCUMENT, REF, SALT } from './support.ts';

const DIGEST = '88'.repeat(32);
const ESCROW = `${'55'.repeat(32)}#1`;

const verification = {
  escrow_ref_matches: true,
  response_hash_matches: true,
  supplier_key_matches: true,
  signature_valid: true,
  on_chain_hash_matches: true,
  prompt_hash_matches: true,
  model_matches: true,
  fields_match: true,
} as const satisfies ReceiptVerification;

const subJob = {
  capability_id: 'llm.text.generate.v1',
  advert_ref: REF,
  escrow_ref: ESCROW,
  supplier_pkh: 'ab'.repeat(28),
  receipt: { escrow_ref: ESCROW, model: 'deepseek/deepseek-v4-flash' },
  receipt_signature: 'cd'.repeat(64),
  verification,
} as const satisfies SubJob;

const decision = {
  name: 'reorder',
  choice: { lot: 'lot-medium', quantity: 50, needed_by: '2026-12-01' },
  reasoning: 'the stock is below the threshold',
  inference: { path: 'marketplace', sub_job: subJob, accepted: 'confirmed' },
} as const satisfies Decision;

const handoff = {
  counterparty_did: DID_B,
  advert_ref: REF,
  escrow_ref: ESCROW,
  paid_from_vault: true,
  receipt: { escrow_ref: ESCROW },
  receipt_signature: 'cd'.repeat(64),
  verification,
  result: { schema: 'vector.usecase.order-confirmation.v1', outcome: 'done' },
  accepted: 'confirmed',
} as const satisfies HandoffRecord;

const write = { system: 'po-store', route: 'POST /po', status: 201, ref: 'po-1' } as const satisfies WriteRecord;
const challenge = { claim: REF, evidence: '99'.repeat(32), challenge: ESCROW } as const satisfies ChallengeRecord;

describe('RECEIPT_CHECKS', () => {
  it('are the eight checks of a sub-receipt, in the order of the verification object', () => {
    expect([...RECEIPT_CHECKS]).toStrictEqual([
      'escrow_ref_matches', 'response_hash_matches', 'supplier_key_matches', 'signature_valid', 'on_chain_hash_matches', 'prompt_hash_matches', 'model_matches', 'fields_match',
    ]);
    expect(Object.keys(verification)).toStrictEqual([...RECEIPT_CHECKS]);
    expectTypeOf<keyof ReceiptVerification>().toEqualTypeOf<(typeof RECEIPT_CHECKS)[number]>();
  });
});

describe('the result of propose', () => {
  it('has the document, the salt and the digest, and no exit state, when the outcome is proposed', () => {
    const proposed = {
      schema: PROPOSAL_SCHEMA, use_case: 'inventory-reorder', document: DOCUMENT, salt: SALT, proposal_digest: DIGEST, decisions: [decision], sub_jobs: [subJob],
      outcome: 'proposed', reason: null, exit_state: null, fault_mode: '',
    } as const satisfies ProposalResult;
    expect(proposed.exit_state).toBeNull();
    expectTypeOf<ProposedResult['exit_state']>().toEqualTypeOf<null>();
  });

  it('has a reason and the exit state Failed when the outcome is failed, and may have no document yet', () => {
    const failed = {
      schema: PROPOSAL_SCHEMA, use_case: 'bid-evaluation', document: null, salt: null, proposal_digest: null, decisions: [], sub_jobs: [],
      outcome: 'failed', reason: 'llm_supplier_unavailable', exit_state: 'Failed', fault_mode: 'invert_scores',
    } as const satisfies ProposalResult;
    expect([failed.reason, failed.exit_state]).toStrictEqual(['llm_supplier_unavailable', 'Failed']);
    expectTypeOf<FailedProposalResult['exit_state']>().toEqualTypeOf<'Failed'>();
  });

  it('refuses a result that the protocol does not have', () => {
    // @ts-expect-error a proposal that was made has no reason
    const reason: ProposalResult = { schema: PROPOSAL_SCHEMA, use_case: 'inventory-reorder', document: DOCUMENT, salt: SALT, proposal_digest: DIGEST, decisions: [], sub_jobs: [], outcome: 'proposed', reason: 'x', exit_state: null, fault_mode: '' };
    // @ts-expect-error a proposal that was made has its document
    const noDocument: ProposalResult = { schema: PROPOSAL_SCHEMA, use_case: 'inventory-reorder', document: null, salt: SALT, proposal_digest: DIGEST, decisions: [], sub_jobs: [], outcome: 'proposed', reason: null, exit_state: null, fault_mode: '' };
    // @ts-expect-error a failed job has a reason
    const noReason: ProposalResult = { schema: PROPOSAL_SCHEMA, use_case: 'inventory-reorder', document: null, salt: null, proposal_digest: null, decisions: [], sub_jobs: [], outcome: 'failed', reason: null, exit_state: 'Failed', fault_mode: '' };
    // @ts-expect-error propose has no outcome of execute
    const wrongOutcome: ProposalResult = { schema: PROPOSAL_SCHEMA, use_case: 'inventory-reorder', document: DOCUMENT, salt: SALT, proposal_digest: DIGEST, decisions: [], sub_jobs: [], outcome: 'completed', reason: null, exit_state: null, fault_mode: '' };
    // @ts-expect-error a use case that the protocol does not have
    const wrongUseCase: ProposalResult = { schema: PROPOSAL_SCHEMA, use_case: 'billing', document: DOCUMENT, salt: SALT, proposal_digest: DIGEST, decisions: [], sub_jobs: [], outcome: 'proposed', reason: null, exit_state: null, fault_mode: '' };
    // @ts-expect-error a fault value that no kind of agent has
    const wrongFault: ProposalResult = { schema: PROPOSAL_SCHEMA, use_case: 'inventory-reorder', document: DOCUMENT, salt: SALT, proposal_digest: DIGEST, decisions: [], sub_jobs: [], outcome: 'proposed', reason: null, exit_state: null, fault_mode: 'break_things' };
    // @ts-expect-error a proposal that was made has no exit state yet
    const exitState: ProposalResult = { schema: PROPOSAL_SCHEMA, use_case: 'inventory-reorder', document: DOCUMENT, salt: SALT, proposal_digest: DIGEST, decisions: [], sub_jobs: [], outcome: 'proposed', reason: null, exit_state: 'Completed', fault_mode: '' };
    // @ts-expect-error a proposal that failed has the exit state Failed and not null
    const failedNull: ProposalResult = { schema: PROPOSAL_SCHEMA, use_case: 'inventory-reorder', document: null, salt: null, proposal_digest: null, decisions: [], sub_jobs: [], outcome: 'failed', reason: 'x', exit_state: null, fault_mode: '' };
    // @ts-expect-error a proposal that failed has the exit state Failed and no other state
    const failedCancelled: ProposalResult = { schema: PROPOSAL_SCHEMA, use_case: 'inventory-reorder', document: null, salt: null, proposal_digest: null, decisions: [], sub_jobs: [], outcome: 'failed', reason: 'x', exit_state: 'Cancelled', fault_mode: '' };
    expect([reason, noDocument, noReason, wrongOutcome, wrongUseCase, wrongFault, exitState, failedNull, failedCancelled]).toHaveLength(9);
  });
});

describe('the result of execute: one form for each outcome', () => {
  const base = { schema: RESULT_SCHEMA, use_case: 'inventory-reorder', proposal_digest: DIGEST, writes: [], decisions: [decision], fault_mode: '' } as const;

  it('has a null reason, no challenge and the state Completed when the order was carried out', () => {
    const completed = { ...base, outcome: 'completed', reason: null, exit_state: 'Completed', handoff, writes: [write], challenge: null } as const satisfies ExecuteResult;
    expect(completed.exit_state).toBe('Completed');
    expectTypeOf<CompletedResult['exit_state']>().toEqualTypeOf<'Completed'>();
  });

  it('has a challenge, a null reason and the state Escalated when the agent filed a challenge', () => {
    const escalated = { ...base, outcome: 'disputed', reason: null, exit_state: 'Escalated', handoff: { ...handoff, accepted: 'no' }, challenge } as const satisfies ExecuteResult;
    expect(escalated.challenge.claim).toBe(REF);
    expectTypeOf<EscalatedResult['challenge']>().toEqualTypeOf<ChallengeRecord>();
  });

  it('has no challenge, a reason and the state Failed when the agent filed none: no open claim, or the step that failed', () => {
    const noClaim = { ...base, outcome: 'disputed', reason: NO_OPEN_CLAIM, exit_state: 'Failed', handoff: { ...handoff, accepted: 'no' }, challenge: null } as const satisfies ExecuteResult;
    const stepFailed = { ...base, outcome: 'disputed', reason: 'evidence_not_published', exit_state: 'Failed', handoff: null, challenge: null } as const satisfies ExecuteResult;
    expect([noClaim.reason, stepFailed.exit_state]).toStrictEqual(['no_open_claim', 'Failed']);
    expectTypeOf<UnfiledDisputeResult['reason']>().toEqualTypeOf<string>();
  });

  it('has the code of the counterparty as the reason when the counterparty refused, and a handoff with no receipt, because the job was never claimed', () => {
    const refused = {
      ...base, outcome: 'refused_by_counterparty', reason: 'approval_digest_mismatch', exit_state: 'Rejected', challenge: null,
      handoff: { counterparty_did: DID_B, advert_ref: REF, escrow_ref: ESCROW, paid_from_vault: true, receipt: null, receipt_signature: null, verification: null, result: null, accepted: null },
    } as const satisfies ExecuteResult;
    const expired = { ...refused, reason: 'approval_expired', exit_state: 'Expired' } as const satisfies ExecuteResult;
    const cancelled = { ...refused, reason: 'delegation_ended', exit_state: 'Cancelled' } as const satisfies ExecuteResult;
    expect([refused.exit_state, expired.exit_state, cancelled.exit_state]).toStrictEqual(['Rejected', 'Expired', 'Cancelled']);
  });

  it('has the code of the mock system as the reason when the system refused, and no handoff in the third use case', () => {
    const system = { ...base, use_case: 'bid-evaluation', outcome: 'refused_by_system', reason: 'approval_not_found', exit_state: 'Rejected', handoff: null, challenge: null } as const satisfies ExecuteResult;
    expect(system.use_case).toBe('bid-evaluation');
  });

  it('gives a refusal the exit state that its reason has: Expired, Cancelled, or Rejected for any other reason', () => {
    const rejected: RefusedResult = { ...base, outcome: 'refused_by_counterparty', reason: 'not_covered', exit_state: 'Rejected', handoff, challenge: null };
    const expired: RefusedResult = { ...base, outcome: 'refused_by_system', reason: 'approval_expired', exit_state: 'Expired', handoff, challenge: null };
    const cancelled: RefusedResult = { ...base, outcome: 'refused_by_counterparty', reason: 'delegation_ended', exit_state: 'Cancelled', handoff, challenge: null };
    // @ts-expect-error the reason not_covered has the state Rejected, and not Expired
    const notCoveredExpired: RefusedResult = { ...base, outcome: 'refused_by_system', reason: 'not_covered', exit_state: 'Expired', handoff, challenge: null };
    // @ts-expect-error the reason delegation_ended has the state Cancelled, and not Expired
    const endedExpired: RefusedResult = { ...base, outcome: 'refused_by_counterparty', reason: 'delegation_ended', exit_state: 'Expired', handoff, challenge: null };
    // @ts-expect-error the reason approval_expired has the state Expired, and not Cancelled
    const expiredCancelled: RefusedResult = { ...base, outcome: 'refused_by_system', reason: 'approval_expired', exit_state: 'Cancelled', handoff, challenge: null };
    // @ts-expect-error the reason not_covered has the state Rejected, and not Cancelled
    const notCoveredCancelled: RefusedResult = { ...base, outcome: 'refused_by_counterparty', reason: 'not_covered', exit_state: 'Cancelled', handoff, challenge: null };
    for (const result of [rejected, expired, cancelled]) {
      expect(exitStateOf({ outcome: result.outcome, reason: result.reason, challenge_filed: false, delegation_ended: false })).toBe(result.exit_state);
    }
    expect([notCoveredExpired, endedExpired, expiredCancelled, notCoveredCancelled]).toHaveLength(4);
    expectTypeOf<Extract<RefusedResult, { reason: 'approval_expired' }>['exit_state']>().toEqualTypeOf<'Expired'>();
    expectTypeOf<Extract<RefusedResult, { reason: 'delegation_ended' }>['exit_state']>().toEqualTypeOf<'Cancelled'>();
    expectTypeOf<Extract<RefusedResult, { exit_state: 'Rejected' }>['reason']>().toEqualTypeOf<string>();
  });

  it('makes a result with no cast: exitStateOf for completed, failed and vault_refused, and refusedExit for a refused result', () => {
    // The reason and the flag are not literal types, as in a run: a step of the agent gives the reason, and the agent reads the delegation.
    const make = (reason: string, delegation_ended: boolean) => {
      const input = { challenge_filed: false, delegation_ended };
      const completed: CompletedResult = { ...base, outcome: 'completed', reason: null, challenge: null, handoff, exit_state: exitStateOf({ ...input, reason: null, outcome: 'completed' }) };
      const failed: FailedResult = { ...base, outcome: 'failed', reason, challenge: null, handoff: null, exit_state: exitStateOf({ ...input, reason, outcome: 'failed' }) };
      const vault: VaultRefusedResult = { ...base, outcome: 'vault_refused', reason, challenge: null, handoff: null, exit_state: exitStateOf({ ...input, reason, outcome: 'vault_refused' }) };
      const byCounterparty: RefusedResult = { ...base, outcome: 'refused_by_counterparty', ...refusedExit(reason), challenge: null, handoff };
      const bySystem: RefusedResult = { ...base, outcome: 'refused_by_system', ...refusedExit(reason), challenge: null, handoff: null };
      // @ts-expect-error exitStateOf of the outcome failed gives Failed, and a completed result has the state Completed
      const completedFromFailed: CompletedResult = { ...base, outcome: 'completed', reason: null, challenge: null, handoff, exit_state: exitStateOf({ ...input, reason: null, outcome: 'failed' }) };
      // @ts-expect-error the state of exitStateOf for a refused outcome is not proven to go with the reason that is a string beside it
      const refusedFromState: RefusedResult = { ...base, outcome: 'refused_by_counterparty', reason, challenge: null, handoff, exit_state: exitStateOf({ ...input, reason, outcome: 'refused_by_counterparty' }) };
      return { completed, failed, vault, byCounterparty, bySystem, completedFromFailed, refusedFromState };
    };
    const rows = [make('approval_expired', false), make('delegation_ended', true), make('not_covered', true)];
    expect(rows.map((row) => [row.completed.exit_state, row.failed.exit_state, row.vault.exit_state, row.byCounterparty.exit_state, row.bySystem.exit_state])).toStrictEqual([
      ['Completed', 'Failed', 'Failed', 'Expired', 'Expired'],
      ['Completed', 'Failed', 'Cancelled', 'Cancelled', 'Cancelled'],
      ['Completed', 'Failed', 'Cancelled', 'Rejected', 'Rejected'],
    ]);
  });

  it('has the evaluation error of the node as the reason when the vault refused, and the state Cancelled or Failed', () => {
    const failed = { ...base, outcome: 'vault_refused', reason: 'the value per transaction is over the limit', exit_state: 'Failed', handoff: null, challenge: null } as const satisfies ExecuteResult;
    const cancelled = { ...failed, exit_state: 'Cancelled' } as const satisfies ExecuteResult;
    expect([failed.exit_state, cancelled.exit_state]).toStrictEqual(['Failed', 'Cancelled']);
  });

  it('has a reason and the state Failed when the job failed', () => {
    const failed = { ...base, outcome: 'failed', reason: 'deadline', exit_state: 'Failed', handoff: null, challenge: null } as const satisfies ExecuteResult;
    expect(failed.reason).toBe('deadline');
  });

  it('refuses a pair of outcome and exit state that exitStateOf cannot give, and the other wrong members', () => {
    // @ts-expect-error a job that was carried out has no reason
    const reason: ExecuteResult = { ...base, outcome: 'completed', reason: 'x', exit_state: 'Completed', handoff, challenge: null };
    // @ts-expect-error a job that was carried out has the state Completed
    const completedFailed: ExecuteResult = { ...base, outcome: 'completed', reason: null, exit_state: 'Failed', handoff, challenge: null };
    // @ts-expect-error a job that was carried out has no challenge
    const completedChallenge: ExecuteResult = { ...base, outcome: 'completed', reason: null, exit_state: 'Completed', handoff, challenge };
    // @ts-expect-error a dispute with a challenge has the state Escalated
    const escalatedFailed: ExecuteResult = { ...base, outcome: 'disputed', reason: null, exit_state: 'Failed', handoff, challenge };
    // @ts-expect-error a dispute with a challenge has no reason
    const escalatedReason: ExecuteResult = { ...base, outcome: 'disputed', reason: 'x', exit_state: 'Escalated', handoff, challenge };
    // @ts-expect-error a dispute with no challenge has the state Failed
    const unfiledEscalated: ExecuteResult = { ...base, outcome: 'disputed', reason: NO_OPEN_CLAIM, exit_state: 'Escalated', handoff, challenge: null };
    // @ts-expect-error a dispute with no challenge has a reason
    const unfiledNoReason: ExecuteResult = { ...base, outcome: 'disputed', reason: null, exit_state: 'Failed', handoff, challenge: null };
    // @ts-expect-error a refusal of the counterparty has no state Escalated
    const counterpartyEscalated: ExecuteResult = { ...base, outcome: 'refused_by_counterparty', reason: 'x', exit_state: 'Escalated', handoff, challenge: null };
    // @ts-expect-error a refusal of the counterparty has no state Completed
    const counterpartyCompleted: ExecuteResult = { ...base, outcome: 'refused_by_counterparty', reason: 'x', exit_state: 'Completed', handoff, challenge: null };
    // @ts-expect-error a refusal of the counterparty has no state Failed
    const counterpartyFailed: ExecuteResult = { ...base, outcome: 'refused_by_counterparty', reason: 'x', exit_state: 'Failed', handoff, challenge: null };
    // @ts-expect-error a refusal of a mock system has no state Failed
    const systemFailed: ExecuteResult = { ...base, outcome: 'refused_by_system', reason: 'x', exit_state: 'Failed', handoff, challenge: null };
    // @ts-expect-error a refusal has a reason
    const refusedNoReason: ExecuteResult = { ...base, outcome: 'refused_by_counterparty', reason: null, exit_state: 'Rejected', handoff, challenge: null };
    // @ts-expect-error a refusal of the vault has no state Rejected
    const vaultRejected: ExecuteResult = { ...base, outcome: 'vault_refused', reason: 'x', exit_state: 'Rejected', handoff, challenge: null };
    // @ts-expect-error a refusal of the vault has no state Expired
    const vaultExpired: ExecuteResult = { ...base, outcome: 'vault_refused', reason: 'x', exit_state: 'Expired', handoff, challenge: null };
    // @ts-expect-error a job that failed has the state Failed
    const failedCancelled: ExecuteResult = { ...base, outcome: 'failed', reason: 'x', exit_state: 'Cancelled', handoff, challenge: null };
    // @ts-expect-error a job that failed has no challenge
    const failedChallenge: ExecuteResult = { ...base, outcome: 'failed', reason: 'x', exit_state: 'Failed', handoff, challenge };
    // @ts-expect-error execute does not end with the outcome proposed
    const proposed: ExecuteResult = { ...base, outcome: 'proposed', reason: null, exit_state: 'Completed', handoff, challenge: null };
    // @ts-expect-error a result of execute has an exit state
    const noState: ExecuteResult = { ...base, outcome: 'completed', reason: null, exit_state: null, handoff, challenge: null };
    // @ts-expect-error a verification holds all eight checks
    const shortVerification: ReceiptVerification = { escrow_ref_matches: true };
    // @ts-expect-error a check is true or false and not a word
    const wordVerification: ReceiptVerification = { ...verification, fields_match: 'pass' };
    expect([
      reason, completedFailed, completedChallenge, escalatedFailed, escalatedReason, unfiledEscalated, unfiledNoReason, counterpartyEscalated, counterpartyCompleted, counterpartyFailed, systemFailed,
      refusedNoReason, vaultRejected, vaultExpired, failedCancelled, failedChallenge, proposed, noState, shortVerification, wordVerification,
    ]).toHaveLength(20);
  });

  it('has, for each outcome, the exit states that the table of exitStateOf gives, and no others', () => {
    // RefusedResult has two outcomes in one interface, so it is picked for each of them.
    type StateOf<O extends ExecuteOutcome> = (O extends RefusedResult['outcome'] ? RefusedResult : Extract<ExecuteResult, { outcome: O }>)['exit_state'];
    expectTypeOf<StateOf<'completed'>>().toEqualTypeOf<'Completed'>();
    expectTypeOf<StateOf<'disputed'>>().toEqualTypeOf<'Escalated' | 'Failed'>();
    expectTypeOf<StateOf<'refused_by_counterparty'>>().toEqualTypeOf<'Rejected' | 'Expired' | 'Cancelled'>();
    expectTypeOf<StateOf<'refused_by_system'>>().toEqualTypeOf<'Rejected' | 'Expired' | 'Cancelled'>();
    expectTypeOf<StateOf<'vault_refused'>>().toEqualTypeOf<'Cancelled' | 'Failed'>();
    expectTypeOf<StateOf<'failed'>>().toEqualTypeOf<'Failed'>();
    expectTypeOf<ExecuteResult['exit_state']>().toEqualTypeOf<ExitState>();
    expectTypeOf<DisputedResult>().toEqualTypeOf<EscalatedResult | UnfiledDisputeResult>();
    expectTypeOf<RefusedResult['outcome']>().toEqualTypeOf<'refused_by_counterparty' | 'refused_by_system'>();
    expectTypeOf<VaultRefusedResult['outcome']>().toEqualTypeOf<'vault_refused'>();
    expectTypeOf<FailedResult['outcome']>().toEqualTypeOf<'failed'>();
    expect(EXIT_STATES).toHaveLength(6);
  });

  it('narrows by the outcome', () => {
    const reasonOf = (result: ExecuteResult): string | null => {
      if (result.outcome === 'completed') expectTypeOf(result.reason).toEqualTypeOf<null>();
      if (result.outcome === 'refused_by_counterparty') expectTypeOf(result.reason).toEqualTypeOf<string>();
      if (result.outcome === 'disputed') expectTypeOf(result.reason).toEqualTypeOf<string | null>();
      return result.reason;
    };
    expect(reasonOf({ ...base, outcome: 'completed', reason: null, exit_state: 'Completed', handoff, challenge: null })).toBeNull();
    expect(reasonOf({ ...base, outcome: 'failed', reason: 'deadline', exit_state: 'Failed', handoff: null, challenge: null })).toBe('deadline');
  });
});

describe('NO_OPEN_CLAIM', () => {
  it('is the reason of a dispute with no challenge, because the other party has no open claim', () => {
    expect(NO_OPEN_CLAIM).toBe('no_open_claim');
    expectTypeOf<typeof NO_OPEN_CLAIM>().toEqualTypeOf<'no_open_claim'>();
  });
});

describe('exitStateOf', () => {
  const given = (outcome: ExecuteOutcome, reason: string | null, challenge_filed = false, delegation_ended = false): ExitStateInput => ({ outcome, reason, challenge_filed, delegation_ended });

  const ROWS: ReadonlyArray<readonly [string, ExitStateInput, ExitState]> = [
    ['completed', given('completed', null), 'Completed'],
    ['completed, with the flags set and a reason: the flags and the reason do not count', given('completed', 'x', true, true), 'Completed'],
    ['disputed, challenge filed', given('disputed', null, true), 'Escalated'],
    ['disputed, challenge filed, delegation ended: the delegation does not count', given('disputed', null, true, true), 'Escalated'],
    ['disputed, no challenge filed, no open claim', given('disputed', NO_OPEN_CLAIM, false), 'Failed'],
    ['disputed, no challenge filed, a step that failed', given('disputed', 'evidence_not_published', false, true), 'Failed'],
    ['refused_by_counterparty, approval_expired', given('refused_by_counterparty', 'approval_expired'), 'Expired'],
    ['refused_by_counterparty, delegation_ended', given('refused_by_counterparty', 'delegation_ended'), 'Cancelled'],
    ['refused_by_counterparty, approval_revoked', given('refused_by_counterparty', 'approval_revoked'), 'Rejected'],
    ['refused_by_counterparty, a code of a rule of the sender', given('refused_by_counterparty', 'sender_not_active'), 'Rejected'],
    ['refused_by_counterparty, no reason', given('refused_by_counterparty', null), 'Rejected'],
    ['refused_by_counterparty, other reason, both flags set: the flags do not count', given('refused_by_counterparty', 'approval_revoked', true, true), 'Rejected'],
    ['refused_by_system, approval_expired', given('refused_by_system', 'approval_expired'), 'Expired'],
    ['refused_by_system, delegation_ended', given('refused_by_system', 'delegation_ended'), 'Cancelled'],
    ['refused_by_system, approval_not_found', given('refused_by_system', 'approval_not_found'), 'Rejected'],
    ['refused_by_system, a code of the system itself', given('refused_by_system', 'token_invalid'), 'Rejected'],
    ['refused_by_system, a code that the protocol does not name', given('refused_by_system', 'client_certificate_missing'), 'Rejected'],
    ['refused_by_system, no reason', given('refused_by_system', null), 'Rejected'],
    ['refused_by_system, other reason, delegation flag set: the flag does not count', given('refused_by_system', 'not_covered', false, true), 'Rejected'],
    ['vault_refused, the delegation ended', given('vault_refused', 'the evaluation failed', false, true), 'Cancelled'],
    ['vault_refused, the delegation did not end', given('vault_refused', 'the evaluation failed', false, false), 'Failed'],
    ['vault_refused, the reason says delegation_ended but the agent did not find the delegation ended', given('vault_refused', 'delegation_ended'), 'Failed'],
    ['vault_refused, a challenge flag does not count', given('vault_refused', 'x', true, false), 'Failed'],
    ['failed', given('failed', 'deadline'), 'Failed'],
    ['failed, with both flags set and the reason approval_expired: nothing counts', given('failed', 'approval_expired', true, true), 'Failed'],
  ];

  it.each(ROWS)('%s', (_name, input, expected) => {
    expect(exitStateOf(input)).toBe(expected);
  });

  it('gives, for every input, a state that the result type of that outcome allows', () => {
    const allowed: Readonly<Record<ExecuteOutcome, readonly ExitState[]>> = {
      completed: ['Completed'],
      disputed: ['Escalated', 'Failed'],
      refused_by_counterparty: ['Rejected', 'Expired', 'Cancelled'],
      refused_by_system: ['Rejected', 'Expired', 'Cancelled'],
      vault_refused: ['Cancelled', 'Failed'],
      failed: ['Failed'],
    };
    let checked = 0;
    for (const outcome of EXECUTE_OUTCOMES) {
      for (const reason of [null, '', 'approval_expired', 'delegation_ended', NO_OPEN_CLAIM, 'x']) {
        for (const challenge_filed of [false, true]) {
          for (const delegation_ended of [false, true]) {
            expect(allowed[outcome], `${outcome} ${String(reason)} ${challenge_filed} ${delegation_ended}`).toContain(exitStateOf({ outcome, reason, challenge_filed, delegation_ended }));
            checked += 1;
          }
        }
      }
    }
    expect(checked).toBe(EXECUTE_OUTCOMES.length * 6 * 4);
  });

  it('gives Completed only for the outcome completed', () => {
    for (const outcome of EXECUTE_OUTCOMES.filter((name) => name !== 'completed')) {
      for (const flag of [false, true]) expect(exitStateOf(given(outcome, null, flag, flag))).not.toBe('Completed');
    }
  });

  it('counts a flag only when it is the boolean true', () => {
    for (const wrong of ['true', 'yes', 1, {}, []]) {
      expect(exitStateOf({ ...given('disputed', null), challenge_filed: wrong as never })).toBe('Failed');
      expect(exitStateOf({ ...given('vault_refused', 'x'), delegation_ended: wrong as never })).toBe('Failed');
    }
  });

  it('gives Failed for an outcome that the protocol does not have, and never a pass', () => {
    for (const wrong of ['proposed', '', 'Completed', 'constructor', 'toString']) expect(exitStateOf({ ...given('failed', null), outcome: wrong as never })).toBe('Failed');
  });

  it('does not change its input', () => {
    const input = given('refused_by_system', 'approval_expired', true, true);
    const before = JSON.stringify(input);
    exitStateOf(input);
    expect(JSON.stringify(input)).toBe(before);
  });

  it('has the signature of the protocol: a call with any outcome takes ExitStateInput and gives ExitState, and the overloads together give the six states', () => {
    // expect-type reads all overloads for `.returns`, and it gives the union of their return types.
    expectTypeOf(exitStateOf).returns.toEqualTypeOf<ExitState>();
    expectTypeOf(exitStateOf).toBeCallableWith({} as ExitStateInput).returns.toEqualTypeOf<ExitState>();
    expectTypeOf<ExitStateInput>().toEqualTypeOf<{
      readonly outcome: ExecuteOutcome;
      readonly reason: string | null;
      readonly challenge_filed: boolean;
      readonly delegation_ended: boolean;
    }>();
  });

  it('gives, for an outcome that the compiler knows, the state type of the result for that outcome, and ExitState for an outcome that only the run knows', () => {
    const input = { reason: null, challenge_filed: false, delegation_ended: false };
    expectTypeOf(exitStateOf({ ...input, outcome: 'completed' })).toEqualTypeOf<CompletedResult['exit_state']>();
    expectTypeOf(exitStateOf({ ...input, outcome: 'failed' })).toEqualTypeOf<FailedResult['exit_state']>();
    expectTypeOf(exitStateOf({ ...input, outcome: 'vault_refused' })).toEqualTypeOf<VaultRefusedResult['exit_state']>();
    expectTypeOf(exitStateOf({ ...input, outcome: 'disputed' })).toEqualTypeOf<DisputedResult['exit_state']>();
    expectTypeOf(exitStateOf({ ...input, outcome: 'refused_by_counterparty' })).toEqualTypeOf<RefusedResult['exit_state']>();
    expectTypeOf(exitStateOf({ ...input, outcome: 'refused_by_system' })).toEqualTypeOf<RefusedResult['exit_state']>();
    // An outcome that is a variable of a union type: the two refused outcomes have one form, and all outcomes together have the general form.
    const refused = 'refused_by_system' as RefusedResult['outcome'];
    expectTypeOf(exitStateOf({ ...input, outcome: refused })).toEqualTypeOf<RefusedResult['exit_state']>();
    const known = 'completed' as ExecuteOutcome;
    expectTypeOf(exitStateOf({ ...input, outcome: known })).toEqualTypeOf<ExitState>();
    expect(exitStateOf({ ...input, outcome: known })).toBe('Completed');
  });
});

describe('refusedExit', () => {
  const REASONS = ['approval_expired', 'delegation_ended', 'approval_revoked', 'not_covered', 'sender_not_active', '', 'Approval_Expired', 'toString', '__proto__'];

  it.each(REASONS)('gives the reason as it is, and the state that exitStateOf gives for each refused outcome: %j', (reason) => {
    const pair = refusedExit(reason);
    expect(pair.reason).toBe(reason);
    for (const outcome of ['refused_by_counterparty', 'refused_by_system'] as const) {
      expect(pair.exit_state).toBe(exitStateOf({ outcome, reason, challenge_filed: false, delegation_ended: false }));
      expect(pair.exit_state).toBe(exitStateOf({ outcome, reason, challenge_filed: true, delegation_ended: true }));
    }
  });

  it('gives Expired for approval_expired, Cancelled for delegation_ended, and Rejected for any other reason', () => {
    expect(refusedExit('approval_expired')).toStrictEqual({ reason: 'approval_expired', exit_state: 'Expired' });
    expect(refusedExit('delegation_ended')).toStrictEqual({ reason: 'delegation_ended', exit_state: 'Cancelled' });
    for (const other of ['approval_revoked', 'not_covered', '', 'Approval_Expired']) expect(refusedExit(other)).toStrictEqual({ reason: other, exit_state: 'Rejected' });
  });

  it('has the pair that the type of a refused result needs', () => {
    expectTypeOf(refusedExit).parameters.toEqualTypeOf<[reason: string]>();
    expectTypeOf(refusedExit('x')).toEqualTypeOf<
      | { readonly reason: 'approval_expired'; readonly exit_state: 'Expired' }
      | { readonly reason: 'delegation_ended'; readonly exit_state: 'Cancelled' }
      | { readonly reason: string; readonly exit_state: 'Rejected' }
    >();
  });
});
