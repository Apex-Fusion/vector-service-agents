// packages/usecase-kit/test/protocol/results.test.ts: the results of a buyer-side agent, as types. The typecheck is the test: a line that must not compile carries a `@ts-expect-error`, and the
// typecheck fails when such a line compiles. The samples below are the results that the pages describe.
import { describe, expect, expectTypeOf, it } from 'vitest';
import { PROPOSAL_SCHEMA, RECEIPT_CHECKS, RESULT_SCHEMA } from '@vsa/usecase-kit/protocol';
import type { ChallengeRecord, Decision, ExecuteResult, HandoffRecord, ProposalResult, ReceiptVerification, SubJob, WriteRecord } from '@vsa/usecase-kit/protocol';
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
  it('has the document, the salt and the digest when the outcome is proposed', () => {
    const proposed = {
      schema: PROPOSAL_SCHEMA, use_case: 'inventory-reorder', document: DOCUMENT, salt: SALT, proposal_digest: DIGEST, decisions: [decision], sub_jobs: [subJob],
      outcome: 'proposed', reason: null, exit_state: null, fault_mode: '',
    } as const satisfies ProposalResult;
    expect(proposed.outcome).toBe('proposed');
  });

  it('has a reason when the outcome is failed, and may have no document yet', () => {
    const failed = {
      schema: PROPOSAL_SCHEMA, use_case: 'bid-evaluation', document: null, salt: null, proposal_digest: null, decisions: [], sub_jobs: [],
      outcome: 'failed', reason: 'llm_supplier_unavailable', exit_state: 'Failed', fault_mode: 'invert_scores',
    } as const satisfies ProposalResult;
    expect(failed.reason).toBe('llm_supplier_unavailable');
  });

  it('refuses a result that the protocol does not have', () => {
    // @ts-expect-error a proposal that was made has no reason
    const reason: ProposalResult = { schema: PROPOSAL_SCHEMA, use_case: 'inventory-reorder', document: DOCUMENT, salt: SALT, proposal_digest: DIGEST, decisions: [], sub_jobs: [], outcome: 'proposed', reason: 'x', exit_state: null, fault_mode: '' };
    // @ts-expect-error a proposal that was made has its document
    const noDocument: ProposalResult = { schema: PROPOSAL_SCHEMA, use_case: 'inventory-reorder', document: null, salt: SALT, proposal_digest: DIGEST, decisions: [], sub_jobs: [], outcome: 'proposed', reason: null, exit_state: null, fault_mode: '' };
    // @ts-expect-error a failed job has a reason
    const noReason: ProposalResult = { schema: PROPOSAL_SCHEMA, use_case: 'inventory-reorder', document: null, salt: null, proposal_digest: null, decisions: [], sub_jobs: [], outcome: 'failed', reason: null, exit_state: null, fault_mode: '' };
    // @ts-expect-error propose has no outcome of execute
    const wrongOutcome: ProposalResult = { schema: PROPOSAL_SCHEMA, use_case: 'inventory-reorder', document: DOCUMENT, salt: SALT, proposal_digest: DIGEST, decisions: [], sub_jobs: [], outcome: 'completed', reason: null, exit_state: null, fault_mode: '' };
    // @ts-expect-error a use case that the protocol does not have
    const wrongUseCase: ProposalResult = { schema: PROPOSAL_SCHEMA, use_case: 'billing', document: DOCUMENT, salt: SALT, proposal_digest: DIGEST, decisions: [], sub_jobs: [], outcome: 'proposed', reason: null, exit_state: null, fault_mode: '' };
    // @ts-expect-error a fault value that no kind of agent has
    const wrongFault: ProposalResult = { schema: PROPOSAL_SCHEMA, use_case: 'inventory-reorder', document: DOCUMENT, salt: SALT, proposal_digest: DIGEST, decisions: [], sub_jobs: [], outcome: 'proposed', reason: null, exit_state: null, fault_mode: 'break_things' };
    // @ts-expect-error a proposal that was made has no exit state yet
    const exitState: ProposalResult = { schema: PROPOSAL_SCHEMA, use_case: 'inventory-reorder', document: DOCUMENT, salt: SALT, proposal_digest: DIGEST, decisions: [], sub_jobs: [], outcome: 'proposed', reason: null, exit_state: 'Completed', fault_mode: '' };
    expect([reason, noDocument, noReason, wrongOutcome, wrongUseCase, wrongFault, exitState]).toHaveLength(7);
  });
});

describe('the result of execute', () => {
  const base = { schema: RESULT_SCHEMA, use_case: 'inventory-reorder', proposal_digest: DIGEST, writes: [], decisions: [decision], fault_mode: '' } as const;

  it('has a null reason and no challenge when the order was carried out', () => {
    const completed = { ...base, outcome: 'completed', reason: null, exit_state: 'Completed', handoff, writes: [write], challenge: null } as const satisfies ExecuteResult;
    expect(completed.writes).toHaveLength(1);
  });

  it('has the code of the counterparty as the reason when the counterparty refused, and a handoff with no receipt, because the job was never claimed', () => {
    const refused = {
      ...base, outcome: 'refused_by_counterparty', reason: 'approval_digest_mismatch', exit_state: 'Rejected', challenge: null,
      handoff: { counterparty_did: DID_B, advert_ref: REF, escrow_ref: ESCROW, paid_from_vault: true, receipt: null, receipt_signature: null, verification: null, result: null, accepted: null },
    } as const satisfies ExecuteResult;
    expect(refused.reason).toBe('approval_digest_mismatch');
  });

  it('has the evaluation error of the node as the reason when the vault refused, and no handoff', () => {
    const vault = { ...base, outcome: 'vault_refused', reason: 'the value per transaction is over the limit', exit_state: 'Failed', handoff: null, challenge: null } as const satisfies ExecuteResult;
    expect(vault.handoff).toBeNull();
  });

  it('has a challenge when the agent disputed, and may have none when the other party had no open claim', () => {
    const disputed = { ...base, outcome: 'disputed', reason: null, exit_state: 'Escalated', handoff: { ...handoff, accepted: 'no' }, challenge } as const satisfies ExecuteResult;
    const none = { ...base, outcome: 'disputed', reason: 'no_open_claim', exit_state: 'Escalated', handoff: { ...handoff, accepted: 'no' }, challenge: null } as const satisfies ExecuteResult;
    expect([disputed.challenge.claim, none.reason]).toStrictEqual([REF, 'no_open_claim']);
  });

  it('has the code of the mock system as the reason when the system refused, and no handoff in the third use case', () => {
    const system = { ...base, use_case: 'bid-evaluation', outcome: 'refused_by_system', reason: 'approval_not_found', exit_state: 'Rejected', handoff: null, challenge: null } as const satisfies ExecuteResult;
    expect(system.use_case).toBe('bid-evaluation');
  });

  it('refuses a result that the protocol does not have', () => {
    // @ts-expect-error a job that was carried out has no reason
    const reason: ExecuteResult = { ...base, outcome: 'completed', reason: 'x', exit_state: 'Completed', handoff, challenge: null };
    // @ts-expect-error a job that was refused has a reason
    const noReason: ExecuteResult = { ...base, outcome: 'refused_by_counterparty', reason: null, exit_state: 'Rejected', handoff, challenge: null };
    // @ts-expect-error a challenge is only on a job that was disputed
    const wrongChallenge: ExecuteResult = { ...base, outcome: 'completed', reason: null, exit_state: 'Completed', handoff, challenge };
    // @ts-expect-error execute does not end with the outcome proposed
    const proposed: ExecuteResult = { ...base, outcome: 'proposed', reason: null, exit_state: 'Completed', handoff, challenge: null };
    // @ts-expect-error an exit state that the protocol does not have
    const wrongState: ExecuteResult = { ...base, outcome: 'completed', reason: null, exit_state: 'Done', handoff, challenge: null };
    // @ts-expect-error a result of execute has an exit state
    const noState: ExecuteResult = { ...base, outcome: 'completed', reason: null, exit_state: null, handoff, challenge: null };
    // @ts-expect-error a verification holds all eight checks
    const shortVerification: ReceiptVerification = { escrow_ref_matches: true };
    // @ts-expect-error a check is true or false and not a word
    const wordVerification: ReceiptVerification = { ...verification, fields_match: 'pass' };
    expect([reason, noReason, wrongChallenge, proposed, wrongState, noState, shortVerification, wordVerification]).toHaveLength(8);
  });

  it('narrow by the outcome', () => {
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
